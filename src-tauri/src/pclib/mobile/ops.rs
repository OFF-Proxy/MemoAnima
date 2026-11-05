//! V202 (§4-3・§4-5・A6・A7・A8): 作品を読む（指紋と一緒に）・名前を変える・移す・アルバムを作る・アルバムの名前を変える・空き容量。
//!
//! - 名前の確かめと書き込み（名前の変更）は、`lock_lib` を持ったまま続けて（確かめてから書くまでの間に、アプリの他の操作が割り込まない）
//! - 動かすのは全部**置き換えない置き方**（宛先が在れば断る）。本体・サムネ・控えを一緒に動かし、どれかで失敗したら動かした分を戻す
//! - 表示順のキー（索引の `project_order`）と、その作品を指すオートセーブの印（`sessions::retarget`）も一緒に直す
//! - 自分自身の大文字と小文字だけの変更（NFC と NFD だけの違いも）は通す。置き換えない置き方では 1 手で動かせないファイルシステムが
//!   あるので、一時の名前を経る 2 手で（一時の名前は拡張子を保つ＝途中で止まっても一覧から消えない）
//! - 作品を移す（決めたこと）: 移した先に使われている名前があれば、PC の移動と同じ付け方で空いている名前を選ぶ（断らない。比べるのは
//!   この決まり）
//! - 読む: 生のバイト列（V169）。大きさの門番は PC が JS から渡している 512MiB（library.ts の IMPORT_MAX_BYTES）と同じ値を Rust の定数で
//!   持つ（JS から受けない）

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use super::evac;
use super::fingerprint::Fingerprint;
use super::names::{self, fold_key};
use super::place::{self, place_noreplace};
use super::save::NoHooks;
use super::{check_work_file_name, code, io_refusal, locate_album, log_line, sessions, Dirs, Refusal};
use crate::pclib::{load_index, lock_lib, save_index, TMP_COUNTER};

/// ★読む前の大きさの門番（PC の `IMPORT_MAX_BYTES`＝512MiB と同じ値。contract.json の limits.readMaxBytes）
pub const READ_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// 作品の置き場（contract.json の types.WorkPlace）
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPlace {
    pub album: String,
    pub name: String,
}

/// アルバム（contract.json の types.AlbumPlace）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPlace {
    pub album: String,
}

/// 空き容量（contract.json の types.FreeSpace）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeSpace {
    pub available: u64,
    pub total: u64,
}

// ---------------- 読む ----------------

/// ★作品を読み、指紋と一緒に返す（開いたときの保存元の指紋）。封筒は P-3 と同じ `pack_autosave_payload`
/// （頭は `{meta: {fingerprint, album}, path: <実のファイル名>}`・作品は 8 の倍数の位置から＝JS は写さずに読める）
pub fn read_work(d: &Dirs, album: &str, name: &str) -> Result<Vec<u8>, Refusal> {
    check_work_file_name(name, true)?;
    let (album_real, dir) = locate_album(d, album)?;
    let real = names::resolve_body(&dir, name).map_err(|e| io_refusal(&e))?.ok_or(Refusal(code::TARGET_MISSING))?;
    let p = dir.join(&real);
    let lib_c = d.lib.canonicalize().map_err(|e| io_refusal(&e))?;
    let p_c = p.canonicalize().map_err(|e| io_refusal(&e))?;
    if !p_c.starts_with(&lib_c) {
        return Err(Refusal(code::OUTSIDE));
    }
    let md = fs::metadata(&p_c).map_err(|e| io_refusal(&e))?;
    if !md.is_file() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    // 読む前に弾く（読んでから捨てない＝V169・read_file_raw の maxBytes と同じ）
    if md.len() > READ_MAX_BYTES {
        return Err(Refusal(code::TOO_LARGE));
    }
    let data = fs::read(&p_c).map_err(|e| io_refusal(&e))?;
    let fp = Fingerprint::of_bytes(&data);
    let head = serde_json::json!({ "fingerprint": fp, "album": album_real });
    Ok(crate::pack_autosave_payload(&head, Path::new(&real), &data))
}

// ---------------- 動かす手 ----------------

/// 本体・サムネ・控えの (元, 先)。本体のほかは在るものだけ
fn sidecar_pairs(from_dir: &Path, from: &str, to_dir: &Path, to: &str) -> Vec<(PathBuf, PathBuf)> {
    let mut v = vec![(from_dir.join(from), to_dir.join(to))];
    for sfx in [".png", ".bak"] {
        let a = from_dir.join(format!("{from}{sfx}"));
        if a.is_file() {
            v.push((a, to_dir.join(format!("{to}{sfx}"))));
        }
    }
    v
}

/// 順に置き換えない置き方で動かす。どれかで失敗したら動かした分を戻して、その失敗を返す
fn move_all(pairs: &[(PathBuf, PathBuf)]) -> io::Result<()> {
    for (i, (a, b)) in pairs.iter().enumerate() {
        if let Err(e) = place_noreplace(a, b) {
            for (x, y) in pairs[..i].iter().rev() {
                let _ = place_noreplace(y, x);
            }
            return Err(e);
        }
    }
    Ok(())
}

/// 移した先の名前にサムネだけが残っていたら消す（サムネだけの名前は使ってよい＝新しいサムネで置き換わる。前の作品の絵を出さない）
fn drop_orphan_png(dir: &Path, file: &str) {
    let p = dir.join(format!("{file}.png"));
    if p.is_file() {
        let _ = fs::remove_file(p);
    }
}

/// 一時の名前（拡張子を保つ＝途中で止まっても一覧から消えない）
fn temp_name(dir: &Path, base: &str, ext: &str) -> io::Result<String> {
    for _ in 0..50 {
        let tail = format!("~{}.{ext}", TMP_COUNTER.fetch_add(1, Ordering::SeqCst));
        let b = names::shrink(base, names::FILE_MAX_BYTES.saturating_sub(tail.len()));
        let n = format!("{b}{tail}");
        if names::taken_by(dir, &fold_key(names::work_owner_base(&n).unwrap_or(&n)), &[])?.is_none() && !dir.join(&n).exists() {
            return Ok(n);
        }
    }
    Err(io::Error::other("no temp name"))
}

/// 表示順のキーを付け替える（`move_project_with` の 3) と同じ remove → insert。変わったときだけ書く）
fn rekey_order(lib: &Path, a1: &str, n1: &str, a2: &str, n2: &str) {
    let Ok(mut index) = load_index(lib) else { return };
    let old_key = format!("{a1}/{n1}");
    let new_key = format!("{a2}/{n2}");
    let old = index.project_order.remove(&old_key);
    let had_stale = index.project_order.remove(&new_key).is_some();
    if let Some(v) = old {
        index.project_order.insert(new_key, v);
    }
    if old.is_some() || had_stale {
        let _ = save_index(lib, &index);
    }
}

// ---------------- 名前を変える ----------------

/// ★作品の名前を変える（本体・サムネ・控え・表示順のキーと、オートセーブの印を一緒に）。使われている名前なら断る。
/// 自分自身の大小・NFC だけの変更は 2 手で通す。`new_name` は利用者が入れた名前（拡張子なし。長すぎれば断る）。拡張子は元のまま
pub fn rename_work(d: &Dirs, album: &str, name: &str, new_name: &str) -> Result<WorkPlace, Refusal> {
    check_work_file_name(name, true)?;
    let new_base = names::new_work_base(new_name)?;
    let _guard = lock_lib();
    // 退避の記録が古い名前を指していたら、先に片付ける（できる分だけ）
    let _ = evac::resume_all(d, &mut NoHooks);
    let (album_real, dir) = locate_album(d, album)?;
    let real = names::resolve_body(&dir, name).map_err(|e| io_refusal(&e))?.ok_or(Refusal(code::TARGET_MISSING))?;
    let ext = names::work_ext(&real).ok_or(Refusal(code::BAD_NAME))?;
    let new_file = format!("{new_base}.{ext}");
    if new_file == real {
        return Ok(WorkPlace { album: album_real, name: real });
    }
    let own = vec![real.clone(), format!("{real}.bak")];
    if names::taken_by(&dir, &fold_key(&new_base), &own).map_err(|e| io_refusal(&e))?.is_some() {
        return Err(Refusal(code::NAME_TAKEN));
    }
    let self_only = names::work_owner_base(&real).map(fold_key) == Some(fold_key(&new_base));
    if !self_only {
        drop_orphan_png(&dir, &new_file);
    }
    let r = if self_only {
        // 大小・NFC だけの変更: 一時の名前を経る 2 手
        let t = temp_name(&dir, &new_base, ext).map_err(|e| io_refusal(&e))?;
        let first = sidecar_pairs(&dir, &real, &dir, &t);
        move_all(&first).and_then(|_| {
            let second = sidecar_pairs(&dir, &t, &dir, &new_file);
            move_all(&second).inspect_err(|_| {
                let _ = move_all(&sidecar_pairs(&dir, &t, &dir, &real));
            })
        })
    } else {
        move_all(&sidecar_pairs(&dir, &real, &dir, &new_file))
    };
    if let Err(e) = r {
        return Err(if e.kind() == io::ErrorKind::AlreadyExists { Refusal(code::NAME_TAKEN) } else { io_refusal(&e) });
    }
    rekey_order(&d.lib, &album_real, &real, &album_real, &new_file);
    sessions::retarget(d, &album_real, Some(&real), &album_real, Some(&new_file));
    Ok(WorkPlace { album: album_real, name: new_file })
}

// ---------------- 移す ----------------

/// ★作品を別のアルバムへ移す（本体・サムネ・控え・表示順のキー・オートセーブの印）。移した先に使われている名前があれば、PC の移動と
/// 同じ付け方（名前-1・名前-2 …）で空いている名前を選ぶ（比べるのはこの決まり）。移した先のアルバムは作らない
pub fn move_work(d: &Dirs, album: &str, name: &str, dest_album: &str) -> Result<WorkPlace, Refusal> {
    check_work_file_name(name, true)?;
    let _guard = lock_lib();
    let _ = evac::resume_all(d, &mut NoHooks);
    let (src_album, src_dir) = locate_album(d, album)?;
    let real = names::resolve_body(&src_dir, name).map_err(|e| io_refusal(&e))?.ok_or(Refusal(code::TARGET_MISSING))?;
    let (dst_album, dst_dir) = locate_album(d, dest_album)?;
    if src_album == dst_album {
        return Ok(WorkPlace { album: src_album, name: real });
    }
    let base = names::work_owner_base(&real).ok_or(Refusal(code::BAD_NAME))?;
    let ext = names::work_ext(&real).ok_or(Refusal(code::BAD_NAME))?;
    for _ in 0..50 {
        let new_file = names::free_file_name(&dst_dir, base, ext, false, &[]).map_err(|e| io_refusal(&e))?;
        drop_orphan_png(&dst_dir, &new_file);
        match move_all(&sidecar_pairs(&src_dir, &real, &dst_dir, &new_file)) {
            Ok(()) => {
                rekey_order(&d.lib, &src_album, &real, &dst_album, &new_file);
                sessions::retarget(d, &src_album, Some(&real), &dst_album, Some(&new_file));
                return Ok(WorkPlace { album: dst_album, name: new_file });
            }
            // 選んだあとに外で同じ名前が置かれた → 次の名前で
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_refusal(&e)),
        }
    }
    Err(Refusal(code::NAME_TAKEN))
}

// ---------------- アルバム ----------------

/// ★アルバムを作る（使われている名前＝大小・NFC を無視して同じ名前のものがあれば断る・予約名に `_`・長すぎれば断る）
pub fn create_album(d: &Dirs, name: &str) -> Result<AlbumPlace, Refusal> {
    let a = names::new_album_name(name)?;
    let _guard = lock_lib();
    if !d.lib.is_dir() {
        return Err(Refusal(code::TARGET_MISSING));
    }
    if names::album_taken(&d.lib, &fold_key(&a), None).map_err(|e| io_refusal(&e))? {
        return Err(Refusal(code::NAME_TAKEN));
    }
    match fs::create_dir(d.lib.join(&a)) {
        Ok(()) => Ok(AlbumPlace { album: a }),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(Refusal(code::NAME_TAKEN)),
        Err(e) => Err(io_refusal(&e)),
    }
}

/// ★アルバムの名前を変える（中の作品を指す表示順のキーと索引の行・オートセーブの印も直す）。自分自身の大小・NFC だけの変更は 2 手で
pub fn rename_album(d: &Dirs, album: &str, new_name: &str) -> Result<AlbumPlace, Refusal> {
    let new_a = names::new_album_name(new_name)?;
    let _guard = lock_lib();
    let _ = evac::resume_all(d, &mut NoHooks);
    let (old_real, old_dir) = locate_album(d, album)?;
    if new_a == old_real {
        return Ok(AlbumPlace { album: old_real });
    }
    if names::album_taken(&d.lib, &fold_key(&new_a), Some(&old_real)).map_err(|e| io_refusal(&e))? {
        return Err(Refusal(code::NAME_TAKEN));
    }
    let new_dir = d.lib.join(&new_a);
    let r = if fold_key(&new_a) == fold_key(&old_real) {
        let mut tmp = None;
        for _ in 0..50 {
            let t = d.lib.join(format!("{}~{}", names::shrink(&new_a, names::NAME_MAX_BYTES - 21), TMP_COUNTER.fetch_add(1, Ordering::SeqCst)));
            if !t.exists() {
                tmp = Some(t);
                break;
            }
        }
        let Some(t) = tmp else { return Err(Refusal(code::IO)) };
        place_noreplace(&old_dir, &t).and_then(|_| {
            place_noreplace(&t, &new_dir).inspect_err(|_| {
                let _ = place_noreplace(&t, &old_dir);
            })
        })
    } else {
        place_noreplace(&old_dir, &new_dir)
    };
    if let Err(e) = r {
        return Err(if e.kind() == io::ErrorKind::AlreadyExists { Refusal(code::NAME_TAKEN) } else { io_refusal(&e) });
    }
    // 索引の行と表示順のキー（PC の rename_album と同じ付け替え）
    if let Ok(mut index) = load_index(&d.lib) {
        let prefix = format!("{old_real}/");
        let mut changed = false;
        for item in index.items.iter_mut() {
            if item.album == old_real || item.rel_path.starts_with(&prefix) {
                item.album = new_a.clone();
                if let Some(rest) = item.rel_path.clone().strip_prefix(&prefix) {
                    item.rel_path = format!("{new_a}/{rest}");
                }
                changed = true;
            }
        }
        let moved: Vec<(String, u32)> = index.project_order.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(k, v)| (k.clone(), *v)).collect();
        for (k, v) in moved {
            index.project_order.remove(&k);
            index.project_order.insert(format!("{new_a}/{}", &k[prefix.len()..]), v);
            changed = true;
        }
        if changed && save_index(&d.lib, &index).is_err() {
            log_line(d, "[V202] rename_album: index not saved");
        }
    }
    sessions::retarget(d, &old_real, None, &new_a, None);
    Ok(AlbumPlace { album: new_a })
}

// ---------------- 空き容量 ----------------

/// ★空き容量（ライブラリのあるボリューム）
pub fn free_space(d: &Dirs) -> Result<FreeSpace, Refusal> {
    let (available, total) = place::free_space(&d.lib).map_err(|e| io_refusal(&e))?;
    // V211: 確かめ画面の「空きが無いふり」（試験用のライブラリの置き場のときだけ・ビルドの印の中だけ）
    #[cfg(any(feature = "mobile-devcheck", test))]
    if super::devcheck::fake_no_space(d) {
        return Ok(FreeSpace { available: 0, total });
    }
    Ok(FreeSpace { available, total })
}

/// V211 (§6-3・V202 §12 の 4): 保存の前に見る空きの余白（オートセーブを続けて書く分も入れた値）
pub const ROOM_MARGIN: u64 = 16 * 1024 * 1024;

/// ★保存に要る空き＝書く大きさ（作品とサムネ）の 2 倍＋16MiB（一時ファイルと、同じ大きさのオートセーブをもう 1 つ書ける分＋余白）
pub fn room_needed(write_bytes: u64) -> u64 {
    write_bytes.saturating_mul(2).saturating_add(ROOM_MARGIN)
}

/// ★書き始める前に空きを見て、足りなければ断る（no-space・既存のファイルは 1 バイトも変えない）。空きが測れなかったときは書いてみる
///  （書いている途中で尽きれば、書きかけを消して no-space＝V202 のまま）
pub fn ensure_room(d: &Dirs, write_bytes: u64) -> Result<(), Refusal> {
    match free_space(d) {
        Ok(fs) if fs.available < room_needed(write_bytes) => {
            log_line(d, "[V211] save refused before writing: not enough free space");
            Err(Refusal(code::NO_SPACE))
        }
        Ok(_) => Ok(()),
        Err(_) => {
            log_line(d, "[V211] free space unknown; writing anyway");
            Ok(())
        }
    }
}
