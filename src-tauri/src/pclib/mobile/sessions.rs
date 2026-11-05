//! V202 (§4-4 の 1〜8・11・A4): **開いた作品ごとのオートセーブ**（セッションの番号ごとに 1 つ・形は AMAS1）。
//! PC のオートセーブ（app_config_dir/autosave/current.asv・`save_autosave_raw`・`load_autosave`・`clear_autosave`）は変えない。
//!
//! - 置き場は app_config_dir/autosave/sessions/`<番号>.asv`。番号は決まった形（小文字の hex 32 字）だけを受け、フォルダの外を指せない
//! - 書く道は PC と同じ 1 か所（lib.rs の `atomic_replace_with`＝一時ファイル → `pclib::commit_replace` → 読み戻しの確かめ
//!   `verify_or_rollback`）。止められた瞬間によっては、本体の代わりに控え（`.bak`）だけが残る
//! - 一覧は「本体か控えのどちらかがある番号」を 1 件。読むのは本体 → 控え。消すのは本体・控え・一時ファイル全部。
//!   読めないものは一覧に出さず、消さない（ログに 1 行・作品名なし）
//! - ★世代（決めたこと）: 世代は Rust が配る（プロセスの中で増える一方・時計を使わない）。部品は便を始めるとき（写す前）に世代を
//!   受け取り、書き込みと消すことの両方に付ける。Rust は番号ごとに「受けた最後の世代」と「消した世代」の大きいほう（床）を覚えて
//!   （メモリでよい＝アプリが止まれば遅れた便も無い）、床以下の世代の**書き込みも消すことも**断る。世代の確かめと、書く・消すは、
//!   番号ごとの鍵の中で続けて行う
//! - ★鍵（決めたこと）: 番号ごとの鍵を、書き込み・消すこと・印を直すことが持つ。印を直すのは今あるファイルだけ（消した番号を作り直さない）。
//!   鍵の順は `lock_lib` → この鍵。書き込みは `lock_lib` を取らない（裏に回ったときの書き込みを、ライブラリの長い操作で待たせない）

use serde::Serialize;
use std::cell::Cell;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use super::names::fold_key;
use super::{code, io_refusal, log_line, Dirs, Refusal};

/// 一覧の 1 件（contract.json の types.SessionEntry）
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub session: String,
    /// AMAS1 の中の印（部品が書いたもの・形の決まりの無い JSON）
    pub meta: serde_json::Value,
    /// 読めたのが本体か控えか（"body"・"bak"）
    pub from: String,
}

static GEN: AtomicU64 = AtomicU64::new(0);

/// ★世代を配る（プロセスの中で増える一方。1 から）
pub fn next_gen() -> u64 {
    GEN.fetch_add(1, Ordering::SeqCst) + 1
}

fn floors() -> &'static Mutex<HashMap<String, Arc<Mutex<u64>>>> {
    static F: OnceLock<Mutex<HashMap<String, Arc<Mutex<u64>>>>> = OnceLock::new();
    F.get_or_init(Default::default)
}

/// 番号ごとの鍵（中身は床＝受けた最後の世代と消した世代の大きいほう）
fn session_lock(sid: &str) -> Arc<Mutex<u64>> {
    floors().lock().unwrap_or_else(|e| e.into_inner()).entry(sid.to_string()).or_default().clone()
}

/// セッションの番号の形か（小文字の hex 32 字。作るのは JS の部品だけ）
pub fn is_session_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn body_path(d: &Dirs, sid: &str) -> PathBuf {
    d.sessions.join(format!("{sid}.asv"))
}
fn bak_path(d: &Dirs, sid: &str) -> PathBuf {
    d.sessions.join(format!("{sid}.asv.bak"))
}

/// AMAS1（`AMAS1\n<印の JSON 1 行>\n<作品>`＝PC の `save_autosave_impl` と同じ並び）
fn amas1(meta: &serde_json::Value, data: &[u8]) -> Result<Vec<u8>, Refusal> {
    if !meta.is_object() {
        return Err(Refusal(code::BAD_REQUEST));
    }
    let m = serde_json::to_string(meta).map_err(|_| Refusal(code::BAD_REQUEST))?;
    let mut buf = Vec::with_capacity(crate::AUTOSAVE_MAGIC.len() + m.len() + 1 + data.len());
    buf.extend_from_slice(crate::AUTOSAVE_MAGIC);
    buf.extend_from_slice(m.as_bytes());
    buf.push(b'\n');
    buf.extend_from_slice(data);
    Ok(buf)
}

/// PC と同じ 1 か所（`atomic_replace_with`）で書く。空きが無いときは no-space
fn write_replace(dir: &Path, dest: &Path, buf: &[u8]) -> Result<(), Refusal> {
    let kind: Cell<Option<io::ErrorKind>> = Cell::new(None);
    crate::atomic_replace_with(dir, dest, buf, |p, b| {
        let r = fs::write(p, b);
        if let Err(e) = &r {
            kind.set(Some(e.kind()));
        }
        r
    })
    .map_err(|_| match kind.get() {
        Some(io::ErrorKind::StorageFull) => Refusal(code::NO_SPACE),
        _ => Refusal(code::IO),
    })
}

/// 読める AMAS1（本体 → 控え）。(印, ファイルのバイト列, 作品の始まりの位置, どちらから)。作品を写し直さない（第三者レビュー D-L2）
fn read_current(d: &Dirs, sid: &str) -> Option<(serde_json::Value, Vec<u8>, usize, &'static str)> {
    for (p, from) in [(body_path(d, sid), "body"), (bak_path(d, sid), "bak")] {
        if !p.is_file() {
            continue;
        }
        if let Ok(bytes) = fs::read(&p) {
            if let Some((meta, data)) = crate::parse_autosave(&bytes) {
                // 印は JSON の物だけ（null・配列・数は読めないものとして控えへ進む＝部品の印の読み手が落ちない。独立レビュー F4）
                if meta.is_object() {
                    let at = bytes.len() - data.len();
                    return Some((meta, bytes, at, from));
                }
            }
        }
    }
    None
}

/// 印の上限（印は 1 行の小さい JSON。これより長ければ読めないものとして扱う）
const META_MAX: usize = 1 << 20;

/// AMAS1 の印だけを読む（作品は読まない＝一覧で大きいオートセーブを丸ごと読まない。第三者レビュー D-L2）。形が違えば None
fn read_meta_only(p: &Path) -> Option<serde_json::Value> {
    use std::io::Read;
    let f = fs::File::open(p).ok()?;
    let mut head = Vec::new();
    f.take((crate::AUTOSAVE_MAGIC.len() + META_MAX + 1) as u64).read_to_end(&mut head).ok()?;
    let rest = head.strip_prefix(crate::AUTOSAVE_MAGIC)?;
    let nl = rest.iter().position(|&b| b == b'\n')?;
    serde_json::from_slice::<serde_json::Value>(&rest[..nl]).ok().filter(|m| m.is_object())
}

/// 一覧の 1 件の印（本体 → 控え）
fn current_meta(d: &Dirs, sid: &str) -> Option<(serde_json::Value, &'static str)> {
    for (p, from) in [(body_path(d, sid), "body"), (bak_path(d, sid), "bak")] {
        if p.is_file() {
            if let Some(m) = read_meta_only(&p) {
                return Some((m, from));
            }
        }
    }
    None
}

/// ★書く。床以下の世代は断る（stale-generation）。世代の確かめと書き込みは番号ごとの鍵の中で続けて
pub fn write(d: &Dirs, sid: &str, gen: u64, meta: &serde_json::Value, data: &[u8]) -> Result<(), Refusal> {
    if !is_session_id(sid) {
        return Err(Refusal(code::BAD_SESSION));
    }
    let buf = amas1(meta, data)?;
    let lk = session_lock(sid);
    let mut floor = lk.lock().unwrap_or_else(|e| e.into_inner());
    if gen <= *floor {
        return Err(Refusal(code::STALE_GENERATION));
    }
    *floor = gen;
    fs::create_dir_all(&d.sessions).map_err(|e| io_refusal(&e))?;
    write_replace(&d.sessions, &body_path(d, sid), &buf)
}

/// ★消す（本体・控え・一時ファイル全部）。床以下の世代は断る。消したら床をその世代へ（遅れて届いた古い書き込みで戻らない）
pub fn delete(d: &Dirs, sid: &str, gen: u64) -> Result<(), Refusal> {
    if !is_session_id(sid) {
        return Err(Refusal(code::BAD_SESSION));
    }
    let lk = session_lock(sid);
    let mut floor = lk.lock().unwrap_or_else(|e| e.into_inner());
    if gen <= *floor {
        return Err(Refusal(code::STALE_GENERATION));
    }
    *floor = gen;
    let mut first_err: Option<io::Error> = None;
    let mut rm = |p: PathBuf| {
        if let Err(e) = fs::remove_file(&p) {
            if e.kind() != io::ErrorKind::NotFound && first_err.is_none() {
                first_err = Some(e);
            }
        }
    };
    rm(body_path(d, sid));
    rm(bak_path(d, sid));
    if let Ok(rd) = fs::read_dir(&d.sessions) {
        let head = format!("{sid}.asv.");
        for ent in rd.flatten() {
            let n = ent.file_name().to_string_lossy().into_owned();
            if n.starts_with(&head) && n.ends_with(".tmp") {
                rm(ent.path());
            }
        }
    }
    match first_err {
        Some(e) => Err(io_refusal(&e)),
        None => Ok(()),
    }
}

/// ★世代の床を上げるだけ（ファイルには触らない）。復元した部品が最初に呼ぶ: 読み込み直しの前の部品の遅れた書き込み・消すことを、
/// 復元した部品がまだ書いていなくても断れるように（第三者レビュー D-L1）。床以下の世代は断る
pub fn claim(sid: &str, gen: u64) -> Result<(), Refusal> {
    if !is_session_id(sid) {
        return Err(Refusal(code::BAD_SESSION));
    }
    let lk = session_lock(sid);
    let mut floor = lk.lock().unwrap_or_else(|e| e.into_inner());
    if gen <= *floor {
        return Err(Refusal(code::STALE_GENERATION));
    }
    *floor = gen;
    Ok(())
}

/// 置き場にある番号（本体か控えがあるもの）
fn session_ids(d: &Dirs) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Ok(rd) = fs::read_dir(&d.sessions) else { return out };
    for ent in rd.flatten() {
        let n = ent.file_name().to_string_lossy().into_owned();
        let sid = n.strip_suffix(".asv.bak").or_else(|| n.strip_suffix(".asv"));
        if let Some(s) = sid {
            if is_session_id(s) && !out.iter().any(|x| x == s) {
                out.push(s.to_string());
            }
        }
    }
    out.sort();
    out
}

/// ★一覧（本体か控えのどちらかがある番号を 1 件・読めないものは出さず消さない）。並びは番号順（新しい順は部品が並べる）
pub fn list(d: &Dirs) -> Vec<SessionEntry> {
    let mut out = Vec::new();
    for sid in session_ids(d) {
        let lk = session_lock(&sid);
        let _g = lk.lock().unwrap_or_else(|e| e.into_inner());
        match current_meta(d, &sid) {
            Some((meta, from)) => out.push(SessionEntry { session: sid, meta, from: from.into() }),
            // 読めないものは提案に出さず、消さずに残す（記録に 1 行。作品名は書かない）
            None => log_line(d, "[V202] autosave session unreadable (kept)"),
        }
    }
    out
}

/// ★読む（本体 → 控え）。JS へは P-3 の封筒（`pack_autosave_payload`）で、path の欄は番号。無ければ空の本体
pub fn read(d: &Dirs, sid: &str) -> Result<Vec<u8>, Refusal> {
    if !is_session_id(sid) {
        return Err(Refusal(code::BAD_SESSION));
    }
    let lk = session_lock(sid);
    let _g = lk.lock().unwrap_or_else(|e| e.into_inner());
    Ok(match read_current(d, sid) {
        Some((meta, bytes, at, _)) => crate::pack_autosave_payload(&meta, Path::new(sid), &bytes[at..]),
        None => Vec::new(),
    })
}

/// ★印の保存先を直す（作品の名前を変える・移す・アルバムの名前を変えるとき。`lock_lib` を持って呼ぶ）。
/// `from_name` が None ならアルバムだけを見て直す。比べ方は名前の決まり（大小・NFC を無視）。**今あるファイルだけ**を直し、
/// 世代の床は動かさない（部品の書き込みではない）。直した数を返す
pub fn retarget(d: &Dirs, from_album: &str, from_name: Option<&str>, to_album: &str, to_name: Option<&str>) -> usize {
    let (ka, kn) = (fold_key(from_album), from_name.map(fold_key));
    let mut n = 0;
    for sid in session_ids(d) {
        let lk = session_lock(&sid);
        let _g = lk.lock().unwrap_or_else(|e| e.into_inner());
        let Some((mut meta, bytes, at, _)) = read_current(d, &sid) else { continue };
        let data = &bytes[at..];
        let a = meta.get("album").and_then(|v| v.as_str()).map(fold_key);
        let nm = meta.get("name").and_then(|v| v.as_str()).map(fold_key);
        let hit = a.as_deref() == Some(ka.as_str()) && kn.as_ref().is_none_or(|k| nm.as_deref() == Some(k.as_str()));
        if !hit {
            continue;
        }
        meta["album"] = serde_json::Value::String(to_album.to_string());
        if let Some(t) = to_name {
            meta["name"] = serde_json::Value::String(t.to_string());
        }
        let Ok(buf) = amas1(&meta, data) else { continue };
        if write_replace(&d.sessions, &body_path(d, &sid), &buf).is_ok() {
            n += 1;
        } else {
            log_line(d, "[V202] autosave session retarget failed");
        }
    }
    n
}
