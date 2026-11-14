//! V224 (M-2c・要件 docs/REQ_mobile_m2_editor.md §6・V211b の F2): **ライブラリの命令**（一覧・外の変化の印・サムネ・ヘッダだけを読む・
//! 作品を消す・アルバムを消す・復元の候補・控えから戻す）。
//!
//! ★場所は全部 Rust が決める（命令の皮が `dirs_from_app` で取った [`Dirs`]。試験用のライブラリを開いている間は試験用の側）。
//!  JS からは場所（パス・`libRoot`）を受けない。返すのはアルバムと名前だけで、絶対パスを返さない（決-4）。
//! ★PC の関数（`list_albums`・`scan_library`・`library_stamp`・`scan_recoverable`・`save_project_thumb`・`delete_album`）は、
//!  見える範囲を広げずに子のモジュールから呼ぶ（中身は 1 行も変えない）。PC の `delete_item`・`recover_project` は自分で鍵を取る・
//!  JS の名前をそのまま使う・見てから置くまでに間があるので呼ばず、同じ順をここに書く（L-3・L-5）。
//! ★断りは決まった値（[`code`]）。PC の関数の文（パスや作品名が入る）はそのまま返さない（W-10）。
//! ★作品を消す・アルバムを消す・控えから戻すは、最初に、それを指す退避の記録の保全を続ける（片付かなければ何も消さずに `pending-record`）。
//!  オートセーブ（開いた作品ごと）は消さない（M-1 §4-4 の 6）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::find::is_work_id;
use super::names::{self, fold_key};
use super::place::place_noreplace;
use super::save::{Hooks, NoHooks};
use super::{check_work_file_name, code, evac, io_refusal, locate_album, log_line, Dirs, Refusal};
use crate::pclib::{
    delete_album, is_app_sidecar, is_work_file, library_stamp, list_albums, load_index, lock_lib, save_index, save_project_thumb,
    scan_library, scan_recoverable, tmp_base_name, PROJECT_EXT,
};

/// サムネを読む大きさの上限（4MiB・今の確かめ画面の `read_file_raw` の maxBytes と同じ）
pub const THUMB_READ_MAX: u64 = 4 * 1024 * 1024;
/// サムネを書く大きさの上限（復号して 1MiB）
pub const THUMB_WRITE_MAX: usize = 1024 * 1024;
/// ヘッダの JSON を開く上限（find.rs と同じ）
const PEEK_HEADER_MAX: u64 = 64 << 20;
/// PNG の頭
const PNG_MAGIC: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

// ---------------- 引数と戻り（contract.json の commands[].args・types） ----------------

/// アルバムだけ（mobile_delete_album）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlbumArgs {
    pub album: String,
}

/// サムネを書く（PNG は base64）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThumbWriteArgs {
    pub album: String,
    pub name: String,
    pub png: String,
}

/// 一覧の作品 1 件（types.LibraryWork）。`name` は拡張子つき・`sorted_at` は秒・`thumb` はサムネがあるか
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryWork {
    pub album: String,
    pub name: String,
    pub size: u64,
    pub sorted_at: u64,
    pub order: u32,
    pub thumb: bool,
}

/// 一覧（types.LibraryList）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryList {
    pub albums: Vec<String>,
    pub works: Vec<LibraryWork>,
}

/// ヘッダだけを読んだ値（types.WorkPeek）。安く読めないものは null
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPeek {
    pub work_id: Option<String>,
    pub frames: Option<u64>,
    pub speed_index: Option<i64>,
}

/// 復元の候補（types.RecoverableItem）。一時ファイルは数だけ（絶対パスを返さない）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableItem {
    pub album: String,
    pub name: String,
    pub bak_size: u64,
    pub bak_at: u64,
    pub tmp_count: u32,
}

// ---------------- 共通の手 ----------------

/// ライブラリの場所を PC の関数へ渡す文字（UTF-8 でなければ io）
fn lib_str(d: &Dirs) -> Result<&str, Refusal> {
    d.lib.to_str().ok_or(Refusal(code::IO))
}

/// ライブラリが無ければ target-missing（PC の関数の文を返さない）
fn need_lib(d: &Dirs) -> Result<(), Refusal> {
    if d.lib.is_dir() {
        Ok(())
    } else {
        Err(Refusal(code::TARGET_MISSING))
    }
}

/// ライブラリの中に収まるアルバム（リンクで外を指すものは数えない＝locate_album・find.rs と同じ作法）
fn contained_albums(d: &Dirs, albums: Vec<String>) -> Vec<String> {
    let Ok(lib_c) = d.lib.canonicalize() else { return Vec::new() };
    albums
        .into_iter()
        .filter(|a| matches!(d.lib.join(a).canonicalize(), Ok(c) if c.starts_with(&lib_c) && c != lib_c))
        .collect()
}

/// ★V224（独立レビューの指摘 高①②）: リンク（シンボリックリンク・ジャンクション）なら断る（outside）。リンクの先を消す・動かす・書くと、
/// ライブラリの中の別の作品を消していた（canonicalize は先を返すので、先がライブラリの中なら封じ込めを通っていた）
fn refuse_link(p: &Path) -> Result<(), Refusal> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => Err(Refusal(code::OUTSIDE)),
        Ok(_) => Ok(()),
        Err(e) => Err(io_refusal(&e)),
    }
}

/// アルバムの中の作品の本体を、受けた名前から実の名前で見つけ、ライブラリの中に収まるかを確かめる。
/// ★V224: アルバムのフォルダと本体がリンクなら断る。返す本体の置き場はリンクを解かない形（`dir.join(実の名前)`）
fn locate_body(d: &Dirs, album: &str, name: &str) -> Result<(String, PathBuf, String, PathBuf), Refusal> {
    check_work_file_name(name, true)?;
    let (album_real, dir) = locate_album(d, album)?;
    refuse_link(&dir)?;
    let real = names::resolve_body(&dir, name).map_err(|e| io_refusal(&e))?.ok_or(Refusal(code::TARGET_MISSING))?;
    let body = dir.join(&real);
    refuse_link(&body)?;
    let lib_c = d.lib.canonicalize().map_err(|e| io_refusal(&e))?;
    let body_c = body.canonicalize().map_err(|e| io_refusal(&e))?;
    if !body_c.starts_with(&lib_c) {
        return Err(Refusal(code::OUTSIDE));
    }
    if !body.is_file() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    Ok((album_real, dir, real, body))
}

// ---------------- 一覧・外の変化の印 ----------------

/// ★アルバムと作品の一覧（PC の `list_albums` と `scan_library`＝索引の直しも今のまま）。作品は .memoanima・.animemo だけ（L-2）
pub fn library_list(d: &Dirs) -> Result<LibraryList, Refusal> {
    need_lib(d)?;
    let lib = lib_str(d)?;
    let albums = contained_albums(d, list_albums(lib).map_err(|_| Refusal(code::IO))?);
    let rows = scan_library(lib).map_err(|_| Refusal(code::IO))?;
    let works = rows
        .into_iter()
        .filter(|r| r.kind == "project" && albums.iter().any(|a| *a == r.album))
        .map(|r| LibraryWork { album: r.album, name: r.name, size: r.size, sorted_at: r.sorted_at, order: r.order, thumb: r.thumb_path.is_some() })
        .collect();
    Ok(LibraryList { albums, works })
}

/// ★外（ファイル App など）で変わったかを見る印（PC の `library_stamp`）
pub fn library_stamp_of(d: &Dirs) -> Result<String, Refusal> {
    need_lib(d)?;
    library_stamp(lib_str(d)?).map_err(|_| Refusal(code::IO))
}

// ---------------- サムネ ----------------

/// ★作品の隣のサムネ（`<作品のファイル名>.png`）を読む。無ければ target-missing・4MiB を超えれば too-large（読む前に弾く）
pub fn thumb_read(d: &Dirs, album: &str, name: &str) -> Result<Vec<u8>, Refusal> {
    let (_, dir, real, _) = locate_body(d, album, name)?;
    let p = dir.join(format!("{real}.png"));
    if !p.is_file() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    refuse_link(&p)?;
    let lib_c = d.lib.canonicalize().map_err(|e| io_refusal(&e))?;
    let p_c = p.canonicalize().map_err(|e| io_refusal(&e))?;
    if !p_c.starts_with(&lib_c) {
        return Err(Refusal(code::OUTSIDE));
    }
    let md = fs::metadata(&p_c).map_err(|e| io_refusal(&e))?;
    if md.len() > THUMB_READ_MAX {
        return Err(Refusal(code::TOO_LARGE));
    }
    fs::read(&p_c).map_err(|e| io_refusal(&e))
}

/// ★サムネを書く（PC の `save_project_thumb` と同じ決まり＝作品があるときだけ・空は断る。足して PNG の頭を確かめる・復号して 1MiB まで）
pub fn thumb_write(d: &Dirs, album: &str, name: &str, png_b64: &str) -> Result<(), Refusal> {
    // 復号の前に大きさを見る（base64 は 4 字で 3 バイト）
    if png_b64.len() > (THUMB_WRITE_MAX + 2) / 3 * 4 {
        return Err(Refusal(code::TOO_LARGE));
    }
    let png = super::chunks::b64_decode(png_b64).ok_or(Refusal(code::BAD_REQUEST))?;
    if png.len() > THUMB_WRITE_MAX {
        return Err(Refusal(code::TOO_LARGE));
    }
    if png.is_empty() || png.len() < PNG_MAGIC.len() || &png[..PNG_MAGIC.len()] != PNG_MAGIC {
        return Err(Refusal(code::BAD_REQUEST));
    }
    let (_, dir, real, body_p) = locate_body(d, album, name)?;
    let png_p = dir.join(format!("{real}.png"));
    if fs::symlink_metadata(&png_p).is_ok() {
        refuse_link(&png_p)?;
    }
    let body = body_p.to_str().ok_or(Refusal(code::IO))?;
    // PC の関数が鍵を取り、ライブラリの中・作品の拡張子・空でないことを確かめ直してから書く
    save_project_thumb(lib_str(d)?, body, &png).map_err(|_| Refusal(code::IO))
}

// ---------------- ヘッダだけを読む ----------------

/// PV6 の先頭の gzip（ヘッダ）だけを開いて JSON にする（find.rs の `header_work_id_with` と同じ読み方）。PV6 でなければ None
fn pv6_header(p: &Path, max: u64) -> Option<serde_json::Value> {
    let mut f = fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    if len < 16 {
        return None;
    }
    let mut tail = [0u8; 16];
    f.seek(SeekFrom::End(-16)).ok()?;
    f.read_exact(&mut tail).ok()?;
    if &tail[..8] != b"AMPV6END" {
        return None;
    }
    let hl = u32::from_le_bytes(tail[8..12].try_into().ok()?) as u64;
    let bl = u32::from_le_bytes(tail[12..16].try_into().ok()?) as u64;
    if hl + bl + 16 != len || hl == 0 || hl > max {
        return None;
    }
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut gz = vec![0u8; hl as usize];
    f.read_exact(&mut gz).ok()?;
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(&gz[..]).take(max).read_to_end(&mut json).ok()?;
    serde_json::from_slice(&json).ok()
}

/// ★作品の ID・コマの数・速さを、PV6 のヘッダだけを開いて読む。PV5 以前（.animemo を含む）は丸ごと開かず全部 null
pub fn work_peek(d: &Dirs, album: &str, name: &str) -> Result<WorkPeek, Refusal> {
    let (_, _, real, body_c) = locate_body(d, album, name)?;
    let none = WorkPeek { work_id: None, frames: None, speed_index: None };
    if names::work_ext(&real) != Some(PROJECT_EXT) {
        return Ok(none);
    }
    let Some(h) = pv6_header(&body_c, PEEK_HEADER_MAX) else { return Ok(none) };
    Ok(WorkPeek {
        work_id: h.get("meta").and_then(|m| m.get("workId")).and_then(|v| v.as_str()).filter(|s| is_work_id(s)).map(String::from),
        frames: h.get("frames").and_then(|v| v.as_array()).map(|a| a.len() as u64),
        speed_index: h.get("speedIndex").and_then(|v| v.as_i64()),
    })
}

// ---------------- 作品を消す（L-3） ----------------

/// ★作品を消す。鍵を持ったまま: 退避の記録の保全 → 作品を見つける → PC の `delete_item` と同じ順（索引の表示順のキー → 本体 →
/// サムネ → 控えと一時ファイル。本体が消せなければ索引を戻す）。オートセーブは消さない
pub fn delete_work(d: &Dirs, album: &str, name: &str) -> Result<(), Refusal> {
    delete_work_with(d, album, name, &mut NoHooks)
}

/// 検査の口: `h` は保全の続き（`evac::resume_for_target`）に渡す（製品は [`NoHooks`]）
pub fn delete_work_with(d: &Dirs, album: &str, name: &str, h: &mut dyn Hooks) -> Result<(), Refusal> {
    check_work_file_name(name, true)?;
    let _guard = lock_lib();
    let (album_real, _) = locate_album(d, album)?;
    // ★最初に保全を続ける（先に「無い」を見ると、退避先の前の版があとで戻り、消したはずの作品が帰ってくる）
    evac::resume_for_target(d, &album_real, name, h)?;
    // ★V224: tgt はリンクを解かない置き場（本体はリンクでないことを locate_body が確かめた）。サムネ・控えがリンクなら、リンクそのものだけを消す
    let (album_real, _dir, real, tgt_c) = locate_body(d, &album_real, name)?;
    // 1) 索引の表示順のキーを先に外して書く（読めなければ何も消さない＝PC と同じ）
    let mut index = load_index(&d.lib).map_err(|_| Refusal(code::IO))?;
    let key = format!("{album_real}/{real}");
    let removed = index.project_order.remove(&key);
    save_index(&d.lib, &index).map_err(|_| Refusal(code::IO))?;
    // 2) 本体（消せなければ索引を戻す）
    if let Err(e) = fs::remove_file(&tgt_c) {
        if let Some(v) = removed {
            index.project_order.insert(key, v);
        }
        let _ = save_index(&d.lib, &index);
        log_line(d, "[V224] delete_work: body not removed");
        return Err(io_refusal(&e));
    }
    // 3) サムネ（無くても失敗にしない）
    let mut side = tgt_c.clone().into_os_string();
    side.push(".png");
    let _ = fs::remove_file(PathBuf::from(side));
    // 4) 控えと一時ファイル（PC の delete_item の 4 と同じ）
    let mut bak = tgt_c.clone().into_os_string();
    bak.push(".bak");
    let _ = fs::remove_file(PathBuf::from(bak));
    if let (Some(parent), Some(fname)) = (tgt_c.parent(), tgt_c.file_name().and_then(|n| n.to_str())) {
        if let Ok(entries) = fs::read_dir(parent) {
            for ent in entries.flatten() {
                let p = ent.path();
                let Some(n) = p.file_name().and_then(|x| x.to_str()) else { continue };
                if tmp_base_name(n).as_deref() == Some(fname) {
                    let _ = fs::remove_file(&p);
                }
            }
        }
    }
    Ok(())
}

// ---------------- アルバムを消す（L-4） ----------------

/// アルバムの中を数えた結果
#[derive(Debug, PartialEq, Eq)]
pub enum AlbumContents {
    /// 作品が 1 つでもある
    Works,
    /// 作品は無いが、アプリの付属物でないファイルかフォルダがある
    OtherFiles,
    /// 空か、アプリの付属物だけ
    Removable,
}

/// PC の `delete_album` と同じ述語（`is_work_file`・`is_app_sidecar`）で数える
pub fn album_contents(dir: &Path) -> io::Result<AlbumContents> {
    let mut works = 0usize;
    let mut others = 0usize;
    for ent in fs::read_dir(dir)?.flatten() {
        let fname = ent.file_name().to_string_lossy().to_string();
        let ftype = ent.file_type()?;
        if ftype.is_dir() {
            others += 1;
        } else if is_work_file(&fname) {
            works += 1;
        } else if ftype.is_file() && is_app_sidecar(&fname) {
            // 一緒に消してよい
        } else {
            others += 1;
        }
    }
    Ok(if works > 0 {
        AlbumContents::Works
    } else if others > 0 {
        AlbumContents::OtherFiles
    } else {
        AlbumContents::Removable
    })
}

/// ★アルバムを消す。鍵を持って: 名前を確かめる → そのアルバムを指す退避の記録の保全 → 数える（作品 → album-not-empty・
/// ほかのファイルかフォルダ → album-has-files）。どちらでもなければ鍵を放して PC の `delete_album`（PC が鍵を取り直して確かめ直す＝
/// 数えてから鍵を取るまでの間に作品が置かれても、PC の側が断るので消えない）
pub fn delete_album_work(d: &Dirs, album: &str) -> Result<(), Refusal> {
    delete_album_with(d, album, &mut NoHooks)
}

/// 検査の口: `h` は保全の続き（`evac::resume_for_album`）に渡す
pub fn delete_album_with(d: &Dirs, album: &str, h: &mut dyn Hooks) -> Result<(), Refusal> {
    let real = {
        let _guard = lock_lib();
        let (real, dir) = locate_album(d, album)?;
        evac::resume_for_album(d, &real, h)?;
        match album_contents(&dir).map_err(|e| io_refusal(&e))? {
            AlbumContents::Works => return Err(Refusal(code::ALBUM_NOT_EMPTY)),
            AlbumContents::OtherFiles => return Err(Refusal(code::ALBUM_HAS_FILES)),
            AlbumContents::Removable => real,
        }
    };
    delete_album(lib_str(d)?, &real).map_err(|_| {
        log_line(d, "[V224] delete_album: refused by the PC check");
        Refusal(code::IO)
    })
}

// ---------------- 復元の候補・控えから戻す（L-5） ----------------

/// ★復元の候補（PC の `scan_recoverable`＝読むだけ）。一時ファイルは数だけ
pub fn recoverable_list(d: &Dirs) -> Result<Vec<RecoverableItem>, Refusal> {
    need_lib(d)?;
    let lib = lib_str(d)?;
    let albums = contained_albums(d, list_albums(lib).map_err(|_| Refusal(code::IO))?);
    let rows = scan_recoverable(lib).map_err(|_| Refusal(code::IO))?;
    Ok(rows
        .into_iter()
        .filter(|r| albums.iter().any(|a| *a == r.album))
        .map(|r| RecoverableItem { album: r.album, name: r.name, bak_size: r.bak_size, bak_at: r.bak_at, tmp_count: r.tmp_files.len() as u32 })
        .collect())
}

/// ★控えから戻す（`recover_project` の代わり）。退避の記録の保全 → 本体（大小と NFC を寄せた名前）があれば name-taken（控えは残す）→
/// 既にあるファイルを置き換えない置き方で置く（見てから置くまでの間に外で置かれても置き換えない）
pub fn recover(d: &Dirs, album: &str, name: &str) -> Result<super::ops::WorkPlace, Refusal> {
    recover_with(d, album, name, &mut NoHooks, &mut || {})
}

/// 検査の口: `h` は保全の続きに渡す・`before_place` は確かめたあと・置く直前に呼ぶ（外で同じ名前が置かれた場合をまねる）
pub fn recover_with(d: &Dirs, album: &str, name: &str, h: &mut dyn Hooks, before_place: &mut dyn FnMut()) -> Result<super::ops::WorkPlace, Refusal> {
    check_work_file_name(name, true)?;
    let _guard = lock_lib();
    let (album_real, _) = locate_album(d, album)?;
    evac::resume_for_target(d, &album_real, name, h)?;
    let (album_real, dir) = locate_album(d, &album_real)?;
    refuse_link(&dir)?;
    let bak_name = format!("{name}.bak");
    let bak = dir.join(&bak_name);
    if !bak.is_file() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    // ★V224（独立レビューの指摘 高②）: 控えがリンクなら断る（リンクの先＝別の作品の本体を動かしていた）
    refuse_link(&bak)?;
    let lib_c = d.lib.canonicalize().map_err(|e| io_refusal(&e))?;
    let bak_c = bak.canonicalize().map_err(|e| io_refusal(&e))?;
    if !bak_c.starts_with(&lib_c) {
        return Err(Refusal(code::OUTSIDE));
    }
    let base = names::work_owner_base(name).ok_or(Refusal(code::BAD_NAME))?;
    if names::taken_by(&dir, &fold_key(base), &[bak_name]).map_err(|e| io_refusal(&e))?.is_some() {
        return Err(Refusal(code::NAME_TAKEN));
    }
    before_place();
    match place_noreplace(&bak, &dir.join(name)) {
        Ok(()) => Ok(super::ops::WorkPlace { album: album_real, name: name.to_string() }),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(Refusal(code::NAME_TAKEN)),
        Err(e) => Err(io_refusal(&e)),
    }
}
