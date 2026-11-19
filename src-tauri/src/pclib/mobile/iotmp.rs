//! V229 (M-4・要件 docs/REQ_mobile_m4_io.md §3-3〜§3-9): **出し入れの一時の場所と、ライブラリへ写す道**。
//!
//! ★一時の場所はアプリのキャッシュ（iOS は Caches・Android は cache）の下の `memoanima-io/`。ライブラリのフォルダには置かない
//!  （iOS ではファイル App に見える）。`out/<名札>/` に書き出したもの、`in/<名札>/` に選んだ・受け取ったもの。
//!  名札は 16 桁の 16 進（作品名・パスを含まない）。JS が渡すのは名札とライブラリの作品の名前だけ（パスを受けない＝IO25）。
//! ★書き出し: `out/<名札>/data.part` へ位置を指定して書く → 終える（同期して閉じる）と `out/<名札>/<作品名>.<拡張子>` に名前を変える。
//!  やめる・失敗は `out/<名札>/` ごと消す。終えたものは共有のあと受け手が読むので、24 時間より古くなってから消す（起動・次の出し入れ）。
//!  プロセスごと止められたら、次の起動で書きかけ（data.part だけのもの）を消す（自動で続きからはやらない）。
//! ★取り込み: ネイティブ（Android は Kotlin）が選ばれた・受け取ったファイルを `in/<名札>/data` に写し、`meta.json`（表示名・大きさ）を置く。
//!  受け取り（共有・このアプリで開く）は印 `recv` も置く。Rust は中身で見分けて（[`sniff`]）、作品・.kwz・.ppm・zip だけをライブラリへ写す。
//!  名前と拡張子は助けにだけ使う（Android の content:// は名前が来ないことがある）。
//! ★ライブラリへ写すのは原子的（アルバムの中の一時ファイル → 同期 → 置き換えない置き方で名前を決める）。名前がぶつかったら「名前 (2)」。
//!  元のファイル（ほかのアプリの物）には書かない（一時の場所の写しから読む）。索引（.kwz・.ppm）は PC と同じ関数で、ライブラリの鍵の中で。
//! ★W-10: ログに作品名・パス・URI・中身を書かない（種類・大きさ・理由の値だけ）。通信はしない（IO17）。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::names::{self, fold_key, nfc};
use super::place::{free_space, place_noreplace};
use super::{code, io_refusal, locate_album, log_line, Dirs, Refusal};
use crate::pclib::{load_index, lock_lib, save_index, LibraryItem, PROJECT_EXT, PROJECT_EXT_LEGACY};

/// 一時の場所のフォルダの名前（アプリのキャッシュの下）
pub const IO_DIR: &str = "memoanima-io";
/// 書き出しを置いておく長さ（共有のあと受け手が読み終えるまで）
pub const KEEP: Duration = Duration::from_secs(24 * 60 * 60);
/// 大きさの門番（PC と同じ）: 作品 512MiB・画像と音 64MiB
pub const WORK_MAX: u64 = 512 * 1024 * 1024;
pub const MEDIA_MAX: u64 = 64 * 1024 * 1024;
/// 書き出したファイルの大きさの上限（×8 の長い MP4 でも届かない大きさ・壊れた位置の書き込みを止める）
pub const OUT_MAX: u64 = 16 * 1024 * 1024 * 1024;
/// 1 回の書き込み・読み出しの上限（Android の base64 の塊と同じ 4MiB）
pub const PIECE_MAX: usize = 4 * 1024 * 1024;
/// 書き出しの拡張子（決まったものだけ）
pub const OUT_EXTS: &[&str] = &["mp4", "gif", "png", "zip", "jpg", "memoanima", "animemo"];

/// 一時の場所
#[derive(Clone, Debug)]
pub struct IoDirs {
    pub root: PathBuf,
}
impl IoDirs {
    /// `cache` はアプリのキャッシュ（検査は %TEMP% の下のフォルダ）
    pub fn under(cache: &Path) -> IoDirs {
        IoDirs { root: cache.join(IO_DIR) }
    }
    pub fn out(&self) -> PathBuf {
        self.root.join("out")
    }
    pub fn inbox(&self) -> PathBuf {
        self.root.join("in")
    }
}

// ---------------- 名札 ----------------

static TAG_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 新しい名札（16 桁の 16 進。時刻・数・プロセスの番号から作る。名前やパスを含まない）
pub fn new_tag() -> String {
    let n = TAG_COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut h = Sha256::new();
    h.update(t.to_le_bytes());
    h.update(n.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    let x = h.finalize();
    hex::encode(&x[..8])
}

/// 名札の形（16 桁の 16 進の小文字）。違えば bad-request（パスを組む前に止める）
pub fn check_tag(tag: &str) -> Result<(), Refusal> {
    if tag.len() == 16 && tag.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err(Refusal(code::BAD_REQUEST))
    }
}

fn refuse_link(p: &Path) -> Result<(), Refusal> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => Err(Refusal(code::OUTSIDE)),
        Ok(_) => Ok(()),
        Err(e) => Err(io_refusal(&e)),
    }
}

/// ★V229（独立レビューの指摘・止める）: 一時の場所の土台（memoanima-io・out・in）がリンク（シンボリックリンク・ジャンクション）なら断る。
/// 名札のフォルダだけを見ていると、親がリンクのときにリンクの先（ライブラリやほかのフォルダ）の名札の形のフォルダを消していた。
/// まだ無いものはよい（作るときに作る）
pub fn safe_base(base: &Path) -> Result<(), Refusal> {
    for p in [base.parent(), Some(base)].into_iter().flatten() {
        if let Ok(m) = fs::symlink_metadata(p) {
            if m.file_type().is_symlink() || !m.is_dir() {
                return Err(Refusal(code::OUTSIDE));
            }
        }
    }
    Ok(())
}

/// 名札のフォルダ（リンクなら断る・土台がリンクでも断る）
fn tag_dir(base: &Path, tag: &str) -> Result<PathBuf, Refusal> {
    check_tag(tag)?;
    safe_base(base)?;
    let p = base.join(tag);
    refuse_link(&p)?;
    if !p.is_dir() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    Ok(p)
}

// ---------------- 書き出し（out） ----------------

/// 書き出しを始める: `out/<名札>/data.part` を作る。始める前に古いものを片付ける
pub fn out_begin(io: &IoDirs, ext: &str) -> Result<String, Refusal> {
    if !OUT_EXTS.contains(&ext) {
        return Err(Refusal(code::BAD_REQUEST));
    }
    let _ = cleanup(io, false, SystemTime::now());
    let dir = io.out();
    safe_base(&dir)?;
    fs::create_dir_all(&dir).map_err(|e| io_refusal(&e))?;
    safe_base(&dir)?;
    let tag = new_tag();
    let td = dir.join(&tag);
    fs::create_dir(&td).map_err(|e| io_refusal(&e))?;
    File::create(td.join("data.part")).map_err(|e| io_refusal(&e))?;
    fs::write(td.join("ext"), ext).map_err(|e| io_refusal(&e))?;
    Ok(tag)
}

/// 位置を指定して書く（4MiB まで）
pub fn out_write(io: &IoDirs, tag: &str, position: u64, bytes: &[u8]) -> Result<(), Refusal> {
    if bytes.len() > PIECE_MAX || position.saturating_add(bytes.len() as u64) > OUT_MAX {
        return Err(Refusal(code::TOO_LARGE));
    }
    let td = tag_dir(&io.out(), tag)?;
    let part = td.join("data.part");
    refuse_link(&part)?;
    if !part.is_file() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    let mut f = OpenOptions::new().write(true).open(&part).map_err(|e| io_refusal(&e))?;
    f.seek(SeekFrom::Start(position)).map_err(|e| io_refusal(&e))?;
    f.write_all(bytes).map_err(|e| io_refusal(&e))?;
    Ok(())
}

/// 書き出しの名前（作品名を保存と同じ置き換えにかけ、拡張子を付ける）。空なら "MemoAnima"
pub fn out_file_name(name: &str, ext: &str) -> String {
    let base = names::new_work_base(name).unwrap_or_default();
    let base = if base.trim().is_empty() { "MemoAnima".to_string() } else { base };
    let base = names::shrink(&base, 200).to_string();
    format!("{base}.{ext}")
}

/// 終える: 同期して閉じ、`<作品名>.<拡張子>` に名前を変える。大きさを返す
pub fn out_finish(io: &IoDirs, tag: &str, name: &str) -> Result<u64, Refusal> {
    let td = tag_dir(&io.out(), tag)?;
    let ext = fs::read_to_string(td.join("ext")).map_err(|e| io_refusal(&e))?;
    if !OUT_EXTS.contains(&ext.as_str()) {
        return Err(Refusal(code::BAD_REQUEST));
    }
    let part = td.join("data.part");
    refuse_link(&part)?;
    let f = OpenOptions::new().write(true).open(&part).map_err(|e| io_refusal(&e))?;
    f.sync_all().map_err(|e| io_refusal(&e))?;
    let size = f.metadata().map_err(|e| io_refusal(&e))?.len();
    drop(f);
    let to = td.join(out_file_name(name, &ext));
    place_noreplace(&part, &to).map_err(|e| io_refusal(&e))?;
    Ok(size)
}

/// やめる（`out/<名札>/` ごと消す。無ければ何もしない）
pub fn out_abort(io: &IoDirs, tag: &str) -> Result<(), Refusal> {
    check_tag(tag)?;
    safe_base(&io.out())?;
    let td = io.out().join(tag);
    if fs::symlink_metadata(&td).is_err() {
        return Ok(());
    }
    refuse_link(&td)?;
    fs::remove_dir_all(&td).map_err(|e| io_refusal(&e))
}

/// 終えたファイル（渡すもの）。書きかけ・無ければ target-missing。名前と種類も返す
pub fn out_finished(io: &IoDirs, tag: &str) -> Result<(PathBuf, String), Refusal> {
    let td = tag_dir(&io.out(), tag)?;
    for e in fs::read_dir(&td).map_err(|e| io_refusal(&e))?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n == "data.part" || n == "ext" {
            continue;
        }
        let p = e.path();
        refuse_link(&p)?;
        if p.is_file() {
            return Ok((p, n));
        }
    }
    Err(Refusal(code::TARGET_MISSING))
}

/// 種類（MIME）。.memoanima は application/octet-stream（application/gzip にすると受け手が .gz を足しやすい）
pub fn mime_of(ext: &str) -> &'static str {
    match ext {
        "mp4" => "video/mp4",
        "gif" => "image/gif",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// ★ライブラリの作品を一時の場所へ写す（作品のファイルを直に渡さない）。名札を返す
pub fn out_copy_work(d: &Dirs, io: &IoDirs, album: &str, name: &str) -> Result<String, Refusal> {
    super::check_work_file_name(name, true)?;
    let (_, dir) = locate_album(d, album)?;
    refuse_link(&dir)?;
    let real = names::resolve_body(&dir, name).map_err(|e| io_refusal(&e))?.ok_or(Refusal(code::TARGET_MISSING))?;
    let body = dir.join(&real);
    refuse_link(&body)?;
    let lib_c = d.lib.canonicalize().map_err(|e| io_refusal(&e))?;
    if !body.canonicalize().map_err(|e| io_refusal(&e))?.starts_with(&lib_c) {
        return Err(Refusal(code::OUTSIDE));
    }
    let ext = names::work_ext(&real).unwrap_or(PROJECT_EXT);
    let size = fs::metadata(&body).map_err(|e| io_refusal(&e))?.len();
    need_space(&io.root, size)?;
    let tag = out_begin(io, ext)?;
    let res = (|| -> Result<(), Refusal> {
        let td = io.out().join(&tag);
        let mut src = File::open(&body).map_err(|e| io_refusal(&e))?;
        let mut dst = OpenOptions::new().write(true).truncate(true).open(td.join("data.part")).map_err(|e| io_refusal(&e))?;
        io::copy(&mut src, &mut dst).map_err(|e| io_refusal(&e))?;
        drop(dst);
        let base = &real[..real.len() - ext.len() - 1];
        out_finish(io, &tag, base)?;
        Ok(())
    })();
    if let Err(r) = res {
        let _ = out_abort(io, &tag);
        return Err(r);
    }
    Ok(tag)
}

/// 空き容量（足りなければ no-space。余裕は 1 割か 64MiB の大きい方）
pub fn need_space(at: &Path, bytes: u64) -> Result<(), Refusal> {
    // まだ無い置き場は、在る親で測る
    let mut probe = at.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => break,
        }
    }
    let (avail, _) = free_space(&probe).map_err(|e| io_refusal(&e))?;
    let margin = std::cmp::max(bytes / 10, 64 * 1024 * 1024);
    if avail < bytes.saturating_add(margin) {
        return Err(Refusal(code::NO_SPACE));
    }
    Ok(())
}

// ---------------- 片付け ----------------

/// 片付けた数
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleaned {
    pub removed: u32,
}

fn newest_mtime(p: &Path) -> Option<SystemTime> {
    let mut t = fs::symlink_metadata(p).ok()?.modified().ok()?;
    if let Ok(rd) = fs::read_dir(p) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if let Ok(mt) = m.modified() {
                    if mt > t {
                        t = mt;
                    }
                }
            }
        }
    }
    Some(t)
}

/// ★片付け: `out/`・`in/` の名札のフォルダで 24 時間より古いものを消す。`startup` なら、書きかけ（data.part が残っている書き出し・
/// 取り込みの途中の物）も消す（プロセスごと止められたあと＝自動で続きからはやらない）。名札の形でないもの・リンクは触らない
pub fn cleanup(io: &IoDirs, startup: bool, now: SystemTime) -> Result<Cleaned, Refusal> {
    let mut c = Cleaned::default();
    for base in [io.out(), io.inbox()] {
        // ★土台がリンクなら、その中は見ない（リンクの先を消さない）
        if safe_base(&base).is_err() {
            continue;
        }
        let Ok(rd) = fs::read_dir(&base) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if check_tag(&n).is_err() {
                continue;
            }
            let p = e.path();
            match fs::symlink_metadata(&p) {
                Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
                _ => continue,
            }
            let old = newest_mtime(&p).map(|t| now.duration_since(t).map(|d| d >= KEEP).unwrap_or(false)).unwrap_or(true);
            let unfinished = p.join("data.part").exists() || p.join("data.tmp").exists();
            if old || (startup && unfinished) {
                if fs::remove_dir_all(&p).is_ok() {
                    c.removed += 1;
                }
            }
        }
    }
    Ok(c)
}

// ---------------- 取り込み（in） ----------------

/// 選んだ・受け取ったファイル 1 つ（表示名は来なければ空・大きさは来なければ実の大きさ）
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InItem {
    pub tag: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub size: u64,
}

/// 一時の場所の中身（`in/<名札>/data`）
fn in_data(io: &IoDirs, tag: &str) -> Result<PathBuf, Refusal> {
    let td = tag_dir(&io.inbox(), tag)?;
    let p = td.join("data");
    refuse_link(&p)?;
    if !p.is_file() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    Ok(p)
}

fn in_meta(io: &IoDirs, tag: &str) -> InItem {
    let td = io.inbox().join(tag);
    let mut it: InItem = fs::read(td.join("meta.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(InItem { tag: tag.to_string(), name: String::new(), size: 0 });
    it.tag = tag.to_string();
    if let Ok(m) = fs::metadata(td.join("data")) {
        it.size = m.len();
    }
    it
}

/// 検査と確かめ画面のために: バイト列を `in/<名札>/data` に置く（ネイティブの写しと同じ形）。`recv` なら受け取りの印も
pub fn in_put(io: &IoDirs, name: &str, bytes: &[u8], recv: bool) -> Result<String, Refusal> {
    let base = io.inbox();
    safe_base(&base)?;
    fs::create_dir_all(&base).map_err(|e| io_refusal(&e))?;
    safe_base(&base)?;
    let tag = new_tag();
    let td = base.join(&tag);
    fs::create_dir(&td).map_err(|e| io_refusal(&e))?;
    fs::write(td.join("data"), bytes).map_err(|e| io_refusal(&e))?;
    let meta = InItem { tag: tag.clone(), name: name.to_string(), size: bytes.len() as u64 };
    fs::write(td.join("meta.json"), serde_json::to_vec(&meta).unwrap_or_default()).map_err(|e| io_refusal(&e))?;
    if recv {
        fs::write(td.join("recv"), b"").map_err(|e| io_refusal(&e))?;
    }
    Ok(tag)
}

/// ★受け取った物（印 `recv` のあるもの）を取り出す。印を `taken` へ名前を変えたものだけを返す＝1 回の受け取りは 1 回だけ
/// （Activity の作り直し・開き直しで 2 回にならない）
pub fn in_take_received(io: &IoDirs) -> Result<Vec<InItem>, Refusal> {
    let mut out = Vec::new();
    safe_base(&io.inbox())?;
    let Ok(rd) = fs::read_dir(io.inbox()) else { return Ok(out) };
    let mut tags: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| check_tag(n).is_ok()).collect();
    tags.sort();
    for t in tags {
        let td = io.inbox().join(&t);
        if refuse_link(&td).is_err() || !td.join("data").is_file() {
            continue;
        }
        // 置き換えない置き方で印を移す（2 つ目の呼び出しは AlreadyExists か NotFound で外れる）
        if place_noreplace(&td.join("recv"), &td.join("taken")).is_ok() {
            out.push(in_meta(io, &t));
        }
    }
    Ok(out)
}

/// 名札の物の表示名と大きさ
pub fn in_item(io: &IoDirs, tag: &str) -> Result<InItem, Refusal> {
    in_data(io, tag)?;
    Ok(in_meta(io, tag))
}

/// 捨てる（取り込み終わったもの・やめたもの）
pub fn in_discard(io: &IoDirs, tag: &str) -> Result<(), Refusal> {
    check_tag(tag)?;
    safe_base(&io.inbox())?;
    let td = io.inbox().join(tag);
    if fs::symlink_metadata(&td).is_err() {
        return Ok(());
    }
    refuse_link(&td)?;
    fs::remove_dir_all(&td).map_err(|e| io_refusal(&e))
}

/// 画面（JS）が中身を読む（画像・音・作品をすぐ開く）。4MiB まで・門番は種類で
pub fn in_read(io: &IoDirs, tag: &str, offset: u64, len: usize) -> Result<Vec<u8>, Refusal> {
    if len > PIECE_MAX {
        return Err(Refusal(code::TOO_LARGE));
    }
    let p = in_data(io, tag)?;
    let mut f = File::open(&p).map_err(|e| io_refusal(&e))?;
    let size = f.metadata().map_err(|e| io_refusal(&e))?.len();
    if offset > size {
        return Err(Refusal(code::BAD_REQUEST));
    }
    f.seek(SeekFrom::Start(offset)).map_err(|e| io_refusal(&e))?;
    let mut b = vec![0u8; std::cmp::min(len as u64, size - offset) as usize];
    f.read_exact(&mut b).map_err(|e| io_refusal(&e))?;
    Ok(b)
}

// ---------------- 中身で見分ける ----------------

/// 見分けた種類（contract.json の types.Sniffed.kind と同じ字）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// PV6（器の終わりの印 AMPV6END）
    WorkPv6,
    /// PV5 以前（gzip の中の印。旧 .animemo も同じ）
    WorkPv5,
    Kwz,
    Ppm,
    Zip,
    Png,
    Jpeg,
    Heic,
    Mp3,
    Wav,
    Ogg,
    /// ISO の箱（m4a・mp4・mov）
    Isom,
    /// Matroska（webm・mkv）
    Matroska,
    Unknown,
}
impl Kind {
    pub fn is_work(self) -> bool {
        matches!(self, Kind::WorkPv6 | Kind::WorkPv5)
    }
    pub fn is_note(self) -> bool {
        matches!(self, Kind::Kwz | Kind::Ppm)
    }
    pub fn is_media(self) -> bool {
        matches!(self, Kind::Png | Kind::Jpeg | Kind::Heic | Kind::Mp3 | Kind::Wav | Kind::Ogg | Kind::Isom | Kind::Matroska)
    }
    /// 読む前の門番（作品・.kwz・.ppm・zip は 512MiB・画像と音は 64MiB）
    pub fn gate(self) -> u64 {
        if self.is_media() {
            MEDIA_MAX
        } else {
            WORK_MAX
        }
    }
}

/// ★頭と終わりの数バイト（と PV5 は gzip の頭の 64 バイトを開いて）で見分ける。名前は使わない
pub fn sniff_reader<R: Read + Seek>(f: &mut R, size: u64) -> Kind {
    let mut head = [0u8; 32];
    let n = {
        let _ = f.seek(SeekFrom::Start(0));
        let mut got = 0;
        while got < head.len() {
            match f.read(&mut head[got..]) {
                Ok(0) => break,
                Ok(k) => got += k,
                Err(_) => break,
            }
        }
        got
    };
    let h = &head[..n];
    if size >= 16 {
        let mut tail = [0u8; 16];
        if f.seek(SeekFrom::End(-16)).is_ok() && f.read_exact(&mut tail).is_ok() && &tail[..8] == b"AMPV6END" {
            let hl = u32::from_le_bytes([tail[8], tail[9], tail[10], tail[11]]) as u64;
            let bl = u32::from_le_bytes([tail[12], tail[13], tail[14], tail[15]]) as u64;
            if hl + bl + 16 == size && h.starts_with(&[0x1f, 0x8b]) {
                return Kind::WorkPv6;
            }
        }
    }
    if h.starts_with(&[0x1f, 0x8b]) {
        let _ = f.seek(SeekFrom::Start(0));
        let mut dec = flate2::read::GzDecoder::new(f.take(1 << 20));
        let mut b = [0u8; 64];
        let mut got = 0;
        while got < b.len() {
            match dec.read(&mut b[got..]) {
                Ok(0) => break,
                Ok(k) => got += k,
                Err(_) => break,
            }
        }
        if b[..got].starts_with(br#"{"magic":"ANIMEMO","version":"#) {
            return Kind::WorkPv5;
        }
        return Kind::Unknown;
    }
    if h.starts_with(b"KFH\x14") {
        return Kind::Kwz;
    }
    if h.starts_with(b"PARA") {
        return Kind::Ppm;
    }
    if h.starts_with(b"PK\x03\x04") || h.starts_with(b"PK\x05\x06") || h.starts_with(b"PK\x06\x06") {
        return Kind::Zip;
    }
    if h.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Kind::Png;
    }
    if h.starts_with(&[0xff, 0xd8, 0xff]) {
        return Kind::Jpeg;
    }
    if h.len() >= 12 && &h[4..8] == b"ftyp" {
        let brand = &h[8..12];
        if [b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"].iter().any(|b| brand == *b) {
            return Kind::Heic;
        }
        return Kind::Isom;
    }
    if h.starts_with(b"RIFF") && h.len() >= 12 && &h[8..12] == b"WAVE" {
        return Kind::Wav;
    }
    if h.starts_with(b"OggS") {
        return Kind::Ogg;
    }
    if h.starts_with(b"ID3") || (h.len() >= 2 && h[0] == 0xff && (h[1] & 0xe0) == 0xe0) {
        return Kind::Mp3;
    }
    if h.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Kind::Matroska;
    }
    Kind::Unknown
}

/// ファイルを見分ける（読む前に大きさの門番: 作品として最大の 512MiB を超えれば too-large）
pub fn sniff_path(p: &Path) -> Result<(Kind, u64), Refusal> {
    let mut f = File::open(p).map_err(|e| io_refusal(&e))?;
    let size = f.metadata().map_err(|e| io_refusal(&e))?.len();
    let k = sniff_reader(&mut f, size);
    if size > k.gate() {
        return Err(Refusal(code::TOO_LARGE));
    }
    Ok((k, size))
}

/// 見分けた結果（types.Sniffed）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sniffed {
    pub tag: String,
    pub kind: Kind,
    pub size: u64,
    pub name: String,
}

pub fn in_sniff(io: &IoDirs, tag: &str) -> Result<Sniffed, Refusal> {
    let p = in_data(io, tag)?;
    let (kind, size) = sniff_path(&p)?;
    Ok(Sniffed { tag: tag.to_string(), kind, size, name: in_meta(io, tag).name })
}

// ---------------- ライブラリへ写す ----------------

/// 表示名から作品の名前の土台（拡張子を外す）。`.memoanima.gz` は `.memoanima` に直す。拡張子が `.animemo` なら旧拡張子のまま
pub fn work_name_from(display: &str, fallback: &str) -> (String, &'static str) {
    let mut n = display.trim().to_string();
    let lower = n.to_ascii_lowercase();
    if lower.ends_with(".gz") {
        n.truncate(n.len() - 3);
    }
    let lower = n.to_ascii_lowercase();
    let mut ext = PROJECT_EXT;
    if lower.ends_with(&format!(".{PROJECT_EXT}")) {
        n.truncate(n.len() - PROJECT_EXT.len() - 1);
    } else if lower.ends_with(&format!(".{PROJECT_EXT_LEGACY}")) {
        n.truncate(n.len() - PROJECT_EXT_LEGACY.len() - 1);
        ext = PROJECT_EXT_LEGACY;
    } else if let Some(dot) = n.rfind('.') {
        // 違う拡張子（.bin・.zip の中の名前など）は外して .memoanima にする（開くときは中身で見分ける）
        if dot > 0 && n.len() - dot <= 10 {
            n.truncate(dot);
        }
    }
    let base = if n.trim().is_empty() { String::new() } else { names::new_work_base(&n).unwrap_or_default() };
    let base = if base.trim().is_empty() { names::new_work_base(fallback).unwrap_or_else(|_| "MemoAnima".into()) } else { base };
    (base, ext)
}

/// .kwz・.ppm の名前（拡張子は中身から）
pub fn note_name_from(display: &str, fallback: &str, kind: Kind) -> (String, &'static str) {
    let ext = if kind == Kind::Ppm { "ppm" } else { "kwz" };
    let mut n = display.trim().to_string();
    if let Some(dot) = n.rfind('.') {
        if dot > 0 && n.len() - dot <= 10 {
            n.truncate(dot);
        }
    }
    let s = if n.trim().is_empty() { String::new() } else { names::avoid_reserved(&crate::pclib::sanitize_component(&nfc(&n))) };
    let s = if s.trim().is_empty() || s.starts_with('.') { names::avoid_reserved(&crate::pclib::sanitize_component(&nfc(fallback))) } else { s };
    (names::shrink(&s, 200).to_string(), ext)
}

/// ★空いている名前（保存と同じ決まり: 「名前」→「名前 (2)」→「名前 (3)」…。大小と NFC を無視・本体か控えがあれば使われている）
pub fn free_name_paren(dir: &Path, base: &str, ext: &str) -> io::Result<String> {
    for i in 1..100_000u32 {
        let cand = if i == 1 { base.to_string() } else { format!("{base} ({i})") };
        let file = format!("{cand}.{ext}");
        // 作品は本体か控え、.kwz・.ppm は同じ名前のファイル
        let used = if ext == PROJECT_EXT || ext == PROJECT_EXT_LEGACY {
            names::taken_by(dir, &fold_key(&cand), &[])?.is_some()
        } else {
            let key = fold_key(&file);
            fs::read_dir(dir)?.flatten().any(|e| fold_key(&e.file_name().to_string_lossy()) == key)
        };
        if !used {
            return Ok(file);
        }
    }
    Err(io::Error::other("no free name"))
}

/// ★V229: アルバムの中の使われている名前（zip の取り込みで、1 件ごとにフォルダを読み直さない＝件数の 2 乗にしない）。
/// 鍵は保存と同じ決まり（大小と NFC を無視）。作品は本体か控えの土台（`w:`）・.kwz と .ppm はファイルの名前そのもの
#[derive(Default)]
pub struct NameCache {
    keys: std::collections::HashSet<String>,
}
impl NameCache {
    pub fn load(dir: &Path) -> io::Result<NameCache> {
        let mut c = NameCache::default();
        for e in fs::read_dir(dir)?.flatten() {
            c.add(&e.file_name().to_string_lossy());
        }
        Ok(c)
    }
    pub fn add(&mut self, file: &str) {
        self.keys.insert(fold_key(file));
        if let Some(b) = names::work_owner_base(file) {
            self.keys.insert(format!("w:{}", fold_key(b)));
        }
    }
    fn used(&self, cand: &str, ext: &str) -> bool {
        if ext == PROJECT_EXT || ext == PROJECT_EXT_LEGACY {
            self.keys.contains(&format!("w:{}", fold_key(cand)))
        } else {
            self.keys.contains(&fold_key(&format!("{cand}.{ext}")))
        }
    }
    /// 空いている名前（free_name_paren と同じ並び）
    pub fn free_name(&self, base: &str, ext: &str) -> io::Result<String> {
        for i in 1..1_000_000u32 {
            let cand = if i == 1 { base.to_string() } else { format!("{base} ({i})") };
            if !self.used(&cand, ext) {
                return Ok(format!("{cand}.{ext}"));
            }
        }
        Err(io::Error::other("no free name"))
    }
}

/// ライブラリに写したもの（戻すための記録）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    pub album: String,
    pub name: String,
    pub kind: Kind,
}

/// ★1 つのファイルをアルバムへ写す（原子的）。作品・.kwz・.ppm だけ。.kwz・.ppm は索引に載せる（ライブラリの鍵の中）。
/// `src` は一時の場所の写し（元のファイルではない）。`hook` は検査の口（写したあと・名前を決める前に失敗させる）
pub fn place_into_album(d: &Dirs, album_dir: &Path, album: &str, src: &Path, kind: Kind, display: &str, fallback: &str) -> Result<Placed, Refusal> {
    let mut pending: Vec<LibraryItem> = Vec::new();
    let placed = place_file(d, album_dir, album, src, kind, display, fallback, Some(&mut pending), None)?;
    if !pending.is_empty() {
        let _guard = lock_lib();
        let saved = load_index(&d.lib).ok().and_then(|mut index| {
            index.items.extend(pending);
            save_index(&d.lib, &index).ok()
        });
        if saved.is_none() {
            let _ = fs::remove_file(album_dir.join(&placed.name));
            return Err(Refusal(code::IO));
        }
    }
    Ok(placed)
}

/// ★V229: 写すだけ（.kwz・.ppm の索引の行は `notes` に足す＝呼ぶ側がまとめて 1 回で索引に書く。zip の取り込みは件数ぶん索引を書き直さない）。
/// `notes` が None なら索引の行を作らない（作品だけのとき）
#[allow(clippy::too_many_arguments)]
pub fn place_file(d: &Dirs, album_dir: &Path, album: &str, src: &Path, kind: Kind, display: &str, fallback: &str, notes: Option<&mut Vec<LibraryItem>>, mut cache: Option<&mut NameCache>) -> Result<Placed, Refusal> {
    let _ = d;
    if !(kind.is_work() || kind.is_note()) {
        return Err(Refusal(code::BAD_REQUEST));
    }
    refuse_link(album_dir)?;
    let (base, ext) = if kind.is_work() { work_name_from(display, fallback) } else { note_name_from(display, fallback, kind) };
    let tmp = album_dir.join(format!(".{}.import.tmp", new_tag()));
    let res = (|| -> Result<Placed, Refusal> {
        {
            let mut s = File::open(src).map_err(|e| io_refusal(&e))?;
            let mut t = OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| io_refusal(&e))?;
            io::copy(&mut s, &mut t).map_err(|e| io_refusal(&e))?;
            t.sync_all().map_err(|e| io_refusal(&e))?;
        }
        for _ in 0..32 {
            let file = match cache.as_deref() {
                Some(c) => c.free_name(&base, ext),
                None => free_name_paren(album_dir, &base, ext),
            }
            .map_err(|e| io_refusal(&e))?;
            match place_noreplace(&tmp, &album_dir.join(&file)) {
                Ok(()) => {
                    if let Some(c) = cache.as_deref_mut() {
                        c.add(&file);
                    }
                    if kind.is_note() {
                        let bytes = match fs::read(album_dir.join(&file)) {
                            Ok(b) => b,
                            Err(e) => {
                                let _ = fs::remove_file(album_dir.join(&file));
                                return Err(io_refusal(&e));
                            }
                        };
                        let Some(notes) = notes else {
                            let _ = fs::remove_file(album_dir.join(&file));
                            return Err(Refusal(code::BAD_REQUEST));
                        };
                        notes.push(LibraryItem {
                            hash: hex::encode(Sha256::digest(&bytes)),
                            album: album.to_string(),
                            name: file.clone(),
                            ext: ext.to_string(),
                            size: bytes.len() as u64,
                            rel_path: format!("{album}/{file}"),
                            imported_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|x| x.as_secs()).unwrap_or(0),
                            order: 0,
                        });
                    }
                    return Ok(Placed { album: album.to_string(), name: file, kind });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    // 外で同じ名前が先に置かれた（覚えに足して次の名前へ）
                    if let Some(c) = cache.as_deref_mut() {
                        c.add(&file);
                    }
                    continue;
                }
                Err(e) => return Err(io_refusal(&e)),
            }
        }
        Err(Refusal(code::NAME_TAKEN))
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

/// ★写したものを戻す（zip の途中の失敗・検査）。作品は消す・.kwz・.ppm は索引からも外す。
/// ★V229（独立レビューの指摘・直す）: 消せなかった・索引を書けなかったときは 1 回やり直し、それでも残った数を返す（呼ぶ側がログに数だけ）
pub fn unplace(d: &Dirs, placed: &[Placed]) -> usize {
    let _guard = lock_lib();
    let mut notes: Vec<String> = Vec::new();
    let mut left = 0usize;
    for p in placed {
        if let Ok((_, dir)) = locate_album(d, &p.album) {
            let f = dir.join(&p.name);
            if f.exists() && fs::remove_file(&f).is_err() && fs::remove_file(&f).is_err() {
                left += 1;
            }
        }
        if p.kind.is_note() {
            notes.push(format!("{}/{}", p.album, p.name));
        }
    }
    if !notes.is_empty() {
        let mut ok = false;
        for _ in 0..2 {
            if let Ok(mut index) = load_index(&d.lib) {
                index.items.retain(|it| !notes.contains(&it.rel_path));
                if save_index(&d.lib, &index).is_ok() {
                    ok = true;
                    break;
                }
            }
        }
        if !ok {
            left += notes.len();
        }
    }
    left
}

/// 取り込みの結果（types.ImportResult）
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub placed: Vec<Placed>,
    /// zip の中で作品でないので飛ばした数（入れ子の zip を含む）
    pub skipped: u32,
    /// 作ったアルバム
    pub albums_created: Vec<String>,
}

/// ★名札の物をライブラリへ（作品・.kwz・.ppm は 1 つ・zip は中の作品を全部か何も入れない）。終わったら一時の場所から消す
pub fn in_import(d: &Dirs, io: &IoDirs, tag: &str, album: &str, fallback: &str) -> Result<ImportOutcome, Refusal> {
    let p = in_data(io, tag)?;
    let (kind, size) = sniff_path(&p)?;
    let meta = in_meta(io, tag);
    let out = if kind == Kind::Zip {
        need_space(&d.lib, 0)?;
        super::zipio::import_zip(d, &p, album, fallback, &io.inbox().join(tag))?
    } else if kind.is_work() || kind.is_note() {
        need_space(&d.lib, size)?;
        let (album_real, dir) = locate_album(d, album)?;
        let placed = place_into_album(d, &dir, &album_real, &p, kind, &meta.name, fallback)?;
        ImportOutcome { placed: vec![placed], skipped: 0, albums_created: Vec::new() }
    } else {
        log_line(d, &format!("[io] import refused kind={kind:?} size={size}"));
        return Err(Refusal(UNSUPPORTED_KIND));
    };
    log_line(d, &format!("[io] import ok kind={kind:?} size={size} placed={} skipped={}", out.placed.len(), out.skipped));
    let _ = in_discard(io, tag);
    Ok(out)
}

/// 取り込めない形式（作品でも .kwz・.ppm・zip でもない）。contract.json の refusals に足した値
pub const UNSUPPORTED_KIND: &str = code::UNSUPPORTED_KIND;

// ---------------- D-18: 索引が無いときの拾い直し ----------------

/// ★索引が無く、作り終えた印があれば、アルバムのフォルダの .kwz・.ppm を索引に戻す（PC の `rebuild_index_from_disk` と同じ）。
/// 印の無いライブラリでは拾わない（決-2）。拾い直したら true
pub fn heal_missing_index(d: &Dirs) -> Result<bool, Refusal> {
    if !d.lib.is_dir() || !super::init::is_ready(d) {
        return Ok(false);
    }
    let _guard = lock_lib();
    if d.lib.join(crate::pclib::INDEX_FILE).exists() {
        return Ok(false);
    }
    let idx = crate::pclib::rebuild_index_from_disk(&d.lib);
    save_index(&d.lib, &idx).map_err(|_| Refusal(code::IO))?;
    log_line(d, &format!("[io] index rebuilt notes={}", idx.items.len()));
    Ok(true)
}

/// .kwz・.ppm の一覧の 1 件（types.LibraryNote）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNote {
    pub album: String,
    pub name: String,
    pub size: u64,
    pub sorted_at: u64,
}

/// ★.kwz・.ppm の一覧（索引から・ライブラリの中のアルバムだけ）。開く前に D-18 の拾い直しをする
pub fn library_notes(d: &Dirs) -> Result<Vec<LibraryNote>, Refusal> {
    if !d.lib.is_dir() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    heal_missing_index(d)?;
    let index = load_index(&d.lib).map_err(|_| Refusal(code::IO))?;
    Ok(index
        .items
        .into_iter()
        .filter(|it| d.lib.join(&it.rel_path).is_file())
        .map(|it| LibraryNote { album: it.album, name: it.name, size: it.size, sorted_at: it.imported_at })
        .collect())
}
