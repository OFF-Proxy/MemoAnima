//! V212 (M-1c・要件 docs/REQ_mobile_m1_base.md §6-3・D-M1-3): **Android で大きいバイト列を渡す道**（分けて送る・分けて受け取る）。
//!
//! - Android の invoke はいつも postMessage（Tauri 2.12.5 の `ipc-protocol.js`）で、`Uint8Array` の引数は JSON の数の配列になり、
//!   Rust には `InvokeBody::Json` で届く＝生のボディを受ける書く命令（`mobile_save_new`・`mobile_save_overwrite`・`mobile_autosave_write`）は
//!   Android では断る。読む命令の戻り（`tauri::ipc::Response`）は 1 回分を丸ごと Java の `byte[]` に写す（wry の `android/binding.rs`）
//! - ★書く: JS が生のボディの封筒（`packRawBody`）を 1 回 4MiB 以下に分け、base64 の文字列で順に送る → Rust が**専用の置き場**
//!   （`app_config_dir/mobile-chunks/<起動の印>/`。Android ではライブラリが設定の置き場の中にあるので、ライブラリのフォルダの中には置かない）
//!   に足していく → **全部そろってから**、封筒を今の 1 段（`body_save_new`・`body_save_overwrite`・`body_autosave_write`）へ渡す。
//!   そろったあとは今の封筒の検査・空きの決まり（`ensure_room`）・原子的な置き方をそのまま通る（既存のファイルは途中で 1 バイトも変えない）
//! - ★読む: 今の 1 段（`args_read_work`・`args_autosave_read`＝512MiB の門番・置き場の切り替えをそのまま通る）で作った封筒を Rust のメモリに
//!   持ち、1 回 4MiB 以下の切れ端で返す（Java の `byte[]` も 4MiB 以下）。置き場のファイルを指す道（GET）は作らない
//! - 決まり: 塊は順番どおり・決まった大きさ（最後の 1 つの他は 4MiB ちょうど）・決まった数だけ。欠ける・順番が違う・多すぎる・大きすぎる・
//!   種類が違う（保存とオートセーブ・新しく保存と上書き）・オートセーブの番号と世代が始めたときと違う → 書かずに断る（`bad-request`）。
//!   大きさの上限は読む前の門番と同じ 512MiB（`too-large`）。保存とオートセーブは別の組で、同じ組の新しい始まりは前の途中の分を捨てる
//!   （保存・オートセーブ・破棄は 1 つの列で順に行う＝§4-4 の 7。同じ組が 2 つ同時に要ることは無い）
//! - 途中で止まった塊（アプリが止められた）は、次に起動したとき（Android の setup）と、次に始めるときに片付ける（起動の印が違うフォルダを消す）
//! - 中身は cfg(android) に閉じない（`cargo test --lib` で組み立てて単体テストを回す）。命令の登録だけが Android（`mobile_app.rs`）
//! - W-10: ログ・断りの値に作品名・パス・中身を入れない

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use super::ops::{ensure_room, READ_MAX_BYTES};
use super::{code, io_refusal, Dirs, Refusal};

/// 1 回に送る・受け取る大きさの上限（4MiB）
pub const CHUNK_MAX: usize = 4 * 1024 * 1024;
/// 塊の置き場（app_config_dir の下。ライブラリ・オートセーブ・退避先とは別のフォルダ）
pub const CHUNK_DIR: &str = "mobile-chunks";

/// 送るものの種類（保存とオートセーブは別の組）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    SaveNew,
    SaveOverwrite,
    Autosave,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "saveNew" => Some(Kind::SaveNew),
            "saveOverwrite" => Some(Kind::SaveOverwrite),
            "autosave" => Some(Kind::Autosave),
            _ => None,
        }
    }
    /// 組（保存＝0・オートセーブ＝1）
    fn group(self) -> u8 {
        match self {
            Kind::SaveNew | Kind::SaveOverwrite => 0,
            Kind::Autosave => 1,
        }
    }
}

struct Upload {
    /// 始めたときの置き場（canonicalize した塊の置き場。試験用のライブラリへ切り替えたら合わない＝断る）
    root: PathBuf,
    file: PathBuf,
    kind: Kind,
    total: u64,
    count: u32,
    next: u32,
    received: u64,
    session: Option<String>,
    gen: Option<u64>,
    broken: bool,
}

struct Download {
    group: u8,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct State {
    uploads: HashMap<String, Upload>,
    downloads: HashMap<String, Download>,
}

fn state() -> std::sync::MutexGuard<'static, State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// 乱数の hex（std の RandomState の種＋時刻＋数え。外から当てる必要の無い、置き場の中だけの名前）
fn random_hex(n64: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let mut s = String::new();
    for _ in 0..n64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(CTR.fetch_add(1, Ordering::SeqCst));
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u32(std::process::id());
        s.push_str(&format!("{:016x}", h.finish()));
    }
    s
}

/// この起動の印（プロセスの中で 1 つ。WebView だけ読み込み直してもプロセスが生きていれば同じ）
fn boot_id() -> &'static str {
    static B: OnceLock<String> = OnceLock::new();
    B.get_or_init(|| random_hex(1))
}

/// 送る・受け取るの番号の形か（小文字の hex 32 字。作るのは Rust だけ）
pub fn is_handle(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// 塊の置き場
pub fn chunks_root(d: &Dirs) -> PathBuf {
    d.config.join(CHUNK_DIR)
}

/// ★置き場そのもの（mobile-chunks）を確かめる（V212 独立レビュー 高）。リンク（Windows のジャンクションを含む）・フォルダでないもの・設定の置き場の
/// すぐ下でないものは断る（たどらない＝片付けがリンクの先の作品を消さない）。無ければ None
fn checked_root(d: &Dirs) -> Result<Option<PathBuf>, Refusal> {
    let root = chunks_root(d);
    let m = match fs::symlink_metadata(&root) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_refusal(&e)),
    };
    if m.file_type().is_symlink() || !m.is_dir() {
        return Err(Refusal(code::OUTSIDE));
    }
    let root_c = root.canonicalize().map_err(|e| io_refusal(&e))?;
    let cfg_c = d.config.canonicalize().map_err(|e| io_refusal(&e))?;
    if root_c.parent() != Some(cfg_c.as_path()) {
        return Err(Refusal(code::OUTSIDE));
    }
    Ok(Some(root_c))
}

/// ★前の起動の塊を片付ける（この起動のフォルダは残す）。置き場そのものがリンクなら何もしない。中のリンクはたどらず、リンク自体を消す。消した数を返す
pub fn sweep(d: &Dirs) -> usize {
    let root = match checked_root(d) {
        Ok(Some(r)) => r,
        Ok(None) => return 0,
        Err(_) => {
            super::log_line(d, "[V212] chunk folder is not a plain folder under the config folder; not swept");
            return 0;
        }
    };
    let Ok(rd) = fs::read_dir(&root) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        if e.file_name().to_str() == Some(boot_id()) {
            continue;
        }
        let p = e.path();
        let gone = match fs::symlink_metadata(&p) {
            // リンク（ジャンクション）は先をたどらずにリンクだけを消す（Windows のフォルダのリンクは remove_dir で消える）
            Ok(m) if m.file_type().is_symlink() => fs::remove_file(&p).is_ok() || fs::remove_dir(&p).is_ok(),
            Ok(m) if m.is_dir() => fs::remove_dir_all(&p).is_ok(),
            Ok(_) => fs::remove_file(&p).is_ok(),
            Err(_) => false,
        };
        if gone {
            n += 1;
        }
    }
    if n > 0 {
        super::log_line(d, &format!("[V212] swept {n} stale chunk folder(s) from an earlier launch"));
    }
    n
}

/// この起動の置き場（作って canonicalize）。置き場そのものとこの起動のフォルダが、リンクでない・置き場の外を指していないことを確かめる
/// （`/data/user/0` は `/data/data` へのリンクなので、比べは canonicalize してから）
fn boot_dir(d: &Dirs) -> Result<PathBuf, Refusal> {
    let root_c = match checked_root(d)? {
        Some(r) => r,
        None => {
            fs::create_dir_all(chunks_root(d)).map_err(|e| io_refusal(&e))?;
            checked_root(d)?.ok_or(Refusal(code::IO))?
        }
    };
    let dir = root_c.join(boot_id());
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => return Err(Refusal(code::OUTSIDE)),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&dir).map_err(|e| io_refusal(&e))?,
        Err(e) => return Err(io_refusal(&e)),
    }
    let dir_c = dir.canonicalize().map_err(|e| io_refusal(&e))?;
    if dir_c.parent() != Some(root_c.as_path()) {
        return Err(Refusal(code::OUTSIDE));
    }
    Ok(dir_c)
}

fn drop_upload(u: &Upload) {
    let _ = fs::remove_file(&u.file);
}

/// 塊の数（最後の 1 つの他は CHUNK_MAX ちょうど）
pub fn chunk_count(total: u64) -> u32 {
    total.div_ceil(CHUNK_MAX as u64) as u32
}

fn expected_len(total: u64, count: u32, index: u32) -> u64 {
    if index + 1 < count {
        CHUNK_MAX as u64
    } else {
        total - CHUNK_MAX as u64 * (count as u64 - 1)
    }
}

/// ★送るのを始める。`total` は生のボディの封筒の全部の大きさ。オートセーブは番号と世代を、保存は無しを渡す。番号（32 字）を返す
pub fn begin(d: &Dirs, kind: Kind, total: u64, session: Option<&str>, gen: Option<u64>) -> Result<String, Refusal> {
    if total == 0 {
        return Err(Refusal(code::BAD_REQUEST));
    }
    if total > READ_MAX_BYTES {
        return Err(Refusal(code::TOO_LARGE));
    }
    match kind {
        Kind::Autosave => {
            if !session.map(super::sessions::is_session_id).unwrap_or(false) || gen.is_none() {
                return Err(Refusal(code::BAD_REQUEST));
            }
        }
        _ => {
            if session.is_some() || gen.is_some() {
                return Err(Refusal(code::BAD_REQUEST));
            }
        }
    }
    // 置き場を確かめてから（リンクなら断る）前の起動の塊を片付ける
    let dir = boot_dir(d)?;
    sweep(d);
    // 書き始める前に空きを見る（置き場に集める分。封筒を渡す 1 段でも、作品を書く前にもう 1 回見る）
    ensure_room(d, total)?;
    let root_c = checked_root(d)?.ok_or(Refusal(code::IO))?;
    let mut st = state();
    // 同じ組の途中の分は捨てる（列で順に行うので、新しく始めたら前のは使われない＝WebView の読み込み直しで残ったもの）
    let stale: Vec<String> = st.uploads.iter().filter(|(_, u)| u.kind.group() == kind.group()).map(|(k, _)| k.clone()).collect();
    for k in stale {
        if let Some(u) = st.uploads.remove(&k) {
            drop_upload(&u);
        }
    }
    let id = loop {
        let id = random_hex(2);
        if !st.uploads.contains_key(&id) && !st.downloads.contains_key(&id) {
            break id;
        }
    };
    let file = dir.join(format!("{id}.part"));
    fs::OpenOptions::new().write(true).create_new(true).open(&file).map_err(|e| io_refusal(&e))?;
    st.uploads.insert(
        id.clone(),
        Upload { root: root_c, file, kind, total, count: chunk_count(total), next: 0, received: 0, session: session.map(String::from), gen, broken: false },
    );
    Ok(id)
}

/// ★塊を 1 つ足す（base64 の文字列）。順番どおり・決まった大きさだけ。外れたら、その送りを壊れた扱いにして断る（あとで受け取っても書かない）
pub fn put(d: &Dirs, upload: &str, index: u32, b64: &str) -> Result<(), Refusal> {
    if !is_handle(upload) || b64.len() > CHUNK_MAX.div_ceil(3) * 4 {
        return bad(upload);
    }
    let root_c = checked_root(d).ok().flatten();
    let mut st = state();
    let Some(u) = st.uploads.get_mut(upload) else { return Err(Refusal(code::BAD_REQUEST)) };
    if u.broken || Some(&u.root) != root_c.as_ref() {
        return Err(spoil(u, Refusal(code::BAD_REQUEST)));
    }
    let Some(data) = b64_decode(b64) else { return Err(spoil(u, Refusal(code::BAD_REQUEST))) };
    if index != u.next || index >= u.count || data.len() as u64 != expected_len(u.total, u.count, index) {
        return Err(spoil(u, Refusal(code::BAD_REQUEST)));
    }
    let r = fs::OpenOptions::new().append(true).open(&u.file).and_then(|mut f| f.write_all(&data));
    if let Err(e) = r {
        return Err(spoil(u, io_refusal(&e)));
    }
    u.next += 1;
    u.received += data.len() as u64;
    Ok(())
}

/// 送りを壊れた扱いにする（受け取っても書かない）。集めた塊はその場で消す（置き場に残さない）
fn spoil(u: &mut Upload, r: Refusal) -> Refusal {
    u.broken = true;
    drop_upload(u);
    r
}

fn bad(upload: &str) -> Result<(), Refusal> {
    if let Some(u) = state().uploads.get_mut(upload) {
        spoil(u, Refusal(code::BAD_REQUEST));
    }
    Err(Refusal(code::BAD_REQUEST))
}

/// 受け取りきった封筒（オートセーブは始めたときの番号と世代も）
pub struct Taken {
    pub body: Vec<u8>,
    pub session: Option<String>,
    pub gen: Option<u64>,
}

/// ★送り終えた封筒を取り出す（1 回だけ。成否にかかわらず置き場から消す）。種類が違う・欠けている・壊れている → 断る（書かない）
pub fn take(d: &Dirs, upload: &str, kind: Kind) -> Result<Taken, Refusal> {
    if !is_handle(upload) {
        return Err(Refusal(code::BAD_REQUEST));
    }
    let root_c = checked_root(d).ok().flatten();
    let Some(u) = state().uploads.remove(upload) else { return Err(Refusal(code::BAD_REQUEST)) };
    let ok = !u.broken && u.kind == kind && Some(&u.root) == root_c.as_ref() && u.next == u.count && u.received == u.total;
    if !ok {
        drop_upload(&u);
        return Err(Refusal(code::BAD_REQUEST));
    }
    let body = fs::read(&u.file);
    drop_upload(&u);
    let body = body.map_err(|e| io_refusal(&e))?;
    if body.len() as u64 != u.total {
        return Err(Refusal(code::BAD_REQUEST));
    }
    // 分けて送る道を通ったことの記録（種類と塊の数と大きさだけ＝W-10）
    super::log_line(d, &format!("[V212] chunked upload complete: kind={:?} chunks={} bytes={}", u.kind, u.count, u.total));
    Ok(Taken { body, session: u.session, gen: u.gen })
}

/// 送るのをやめる（置き場から消す）。無ければ何もしない
pub fn abort(upload: &str) {
    if let Some(u) = state().uploads.remove(upload) {
        drop_upload(&u);
    }
}

/// 受け取る組（作品＝0・オートセーブ＝1）
pub const READ_WORK: u8 = 0;
pub const READ_AUTOSAVE: u8 = 1;

/// 受け取りの番号と全部の大きさ
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadHandle {
    pub download: String,
    pub size: u64,
}

/// ★受け取るのを始める（今の 1 段で作った封筒を持つ）。同じ組の前の分は捨てる
pub fn read_begin(group: u8, bytes: Vec<u8>) -> ReadHandle {
    let mut st = state();
    st.downloads.retain(|_, x| x.group != group);
    let id = loop {
        let id = random_hex(2);
        if !st.uploads.contains_key(&id) && !st.downloads.contains_key(&id) {
            break id;
        }
    };
    let size = bytes.len() as u64;
    st.downloads.insert(id.clone(), Download { group, bytes });
    ReadHandle { download: id, size }
}

/// ★切れ端（4MiB 以下・範囲の外は断る）
pub fn read_slice(download: &str, offset: u64, len: u64) -> Result<Vec<u8>, Refusal> {
    let st = state();
    let Some(x) = st.downloads.get(download) else { return Err(Refusal(code::BAD_REQUEST)) };
    let end = offset.checked_add(len).ok_or(Refusal(code::BAD_REQUEST))?;
    if len == 0 || len > CHUNK_MAX as u64 || end > x.bytes.len() as u64 {
        return Err(Refusal(code::BAD_REQUEST));
    }
    Ok(x.bytes[offset as usize..end as usize].to_vec())
}

/// 受け取りを終える（メモリを放す）
pub fn read_end(download: &str) {
    state().downloads.remove(download);
}

/// 検査だけ: 開いている送り・受け取りの数
#[cfg(test)]
pub fn open_counts() -> (usize, usize) {
    let st = state();
    (st.uploads.len(), st.downloads.len())
}

/// 検査だけ: この起動の印（前の起動のフォルダを作るため）
#[cfg(test)]
pub fn boot_for_test() -> &'static str {
    boot_id()
}

/// base64（標準の字・`=` の詰め）を読む。形が崩れていれば None（依存を足さない）
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    }
    let b = s.as_bytes();
    if b.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    for (i, q) in b.chunks(4).enumerate() {
        let last = i + 1 == b.len() / 4;
        let pad = q.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut n = 0u32;
        for (j, &c) in q.iter().enumerate() {
            let v = if j >= 4 - pad { 0 } else { val(c)? };
            n = (n << 6) | v;
        }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..3 - pad]);
    }
    Some(out)
}

/// 検査だけ: base64 に（JS の口と同じ形）
#[cfg(test)]
pub fn b64_encode(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= c.len() {
                s.push(T[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

