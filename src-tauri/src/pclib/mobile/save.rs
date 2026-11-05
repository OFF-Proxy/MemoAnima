//! V202 (§4-4 の 9・10・§4-5・A5・A7): モバイルの**新しく保存**と**指紋で確かめる上書き保存**。
//!
//! どちらも PC の保存と同じものは落とさない: Rust で書いた中身を読み戻して照合する（**置く前に**）・書いている途中で失敗したら書きかけを
//! 消す（V201 の P-4 と同じ）・サムネ（`<名前>.memoanima.png`）も書く。最後に置く手順は**置き換えない置き方**（[`place_noreplace`]）。
//!
//! ★上書き保存の手順（指示 §4・決めたこと）: 一時ファイルを書いて読み戻して照合 → `lock_lib` → 今のファイルの指紋を照合 →
//!  記録を書く（何を退避するか＝保存先と照合した指紋。記録も一時ファイル → 置く）→ 前のファイルを退避先へ（置き換えない置き方）→
//!  退避したファイルの指紋 → 新しい中身を置き換えない置き方で置く → 退避したファイルを普通の控えにするか、別の名前の作品として残す →
//!  記録を消す。一時ファイルを書き終えて照合してから退避するので、空きが尽きても元のファイルはそのまま。
//! ★失敗したとき: 新しい中身を置く**前**の失敗は、退避したファイルを本体へ戻して（置き換えない置き方で）断る。置いた**あと**の失敗
//!  （控えにする・別の名前で残す・記録を消す）は戻さず、保存は成功として返し、記録を残して再開（`evac.rs`）に任せる。
//! ★保証するのは、どちらの中身も消えないこと（どちらを元の名前に残すかは保証しない）。
//! ★検査の口（照合と書き込みの間・退避の直後・置く前・保全の途中）は [`Hooks`] の引数で受ける（`create_project_with`・
//!  `move_project_with` と同じ _with の形）。止める・外の操作をまねる中身は、単体テストと examples/v202_mobile_harness.rs にだけ置く。
//!  製品の命令は本物の手だけ（[`NoHooks`]）を渡す。実行時の印で止める道は作らない。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use super::evac::{self, Record};
use super::fingerprint::Fingerprint;
use super::names::{self, fold_key};
use super::place::{self, place_noreplace};
use super::{check_work_file_name, code, io_refusal, locate_album, write_thumb, Dirs, Refusal, STOPPED};
use crate::pclib::{lock_lib, now_unix, remove_tmp, PROJECT_EXT, PROJECT_EXT_LEGACY, TMP_COUNTER};

// ---------------- 検査の口 ----------------

/// 止めて外の操作をまねる所（検査だけが使う。製品の [`NoHooks`] は何もしない）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// 上書き: 今のファイルの指紋を照合したあと・記録を書く前（照合と書き込みの間）
    Checked,
    /// 上書き: 前のファイルを退避先へ移した直後
    Evacuated,
    /// 上書き: 新しい中身を置く直前
    BeforePlace,
    /// 上書き: 新しい中身を置いたあと・退避したファイルを控えにする（別の名前で残す）前（保全の途中）
    Preserving,
    /// 新しく保存: 名前を確かめたあと・置く直前
    BeforePlaceNew,
    /// 再開: 退避したファイルを本体へ戻す直前
    ResumeBeforeRestore,
    /// 再開: 退避したファイルを控えにする・別の名前で残す直前（保全の途中）
    ResumePreserving,
}

impl Stage {
    pub const ALL: &'static [Stage] = &[
        Stage::Checked,
        Stage::Evacuated,
        Stage::BeforePlace,
        Stage::Preserving,
        Stage::BeforePlaceNew,
        Stage::ResumeBeforeRestore,
        Stage::ResumePreserving,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Stage::Checked => "checked",
            Stage::Evacuated => "evacuated",
            Stage::BeforePlace => "before-place",
            Stage::Preserving => "preserving",
            Stage::BeforePlaceNew => "before-place-new",
            Stage::ResumeBeforeRestore => "resume-before-restore",
            Stage::ResumePreserving => "resume-preserving",
        }
    }
}

/// 止めた所で検査に見せるもの（ライブラリの中の保存先・退避したファイル）
pub struct StageCtx<'a> {
    pub dir: &'a Path,
    pub dest: &'a Path,
    pub evac: Option<&'a Path>,
}

pub enum Step {
    /// 続ける
    Go,
    /// ここで止める（アプリが止められたのをまねる。後片付けをせずに `STOPPED` で抜ける）
    Stop,
}

/// 検査の口。既定の中身が本物の手
pub trait Hooks {
    fn at(&mut self, _stage: Stage, _ctx: &StageCtx) -> Step {
        Step::Go
    }
    /// 一時ファイルを書く 1 手（本物は [`write_new`]。検査は「書いている途中で失敗する」を差し込む）
    fn write_tmp(&mut self, p: &Path, data: &[u8]) -> io::Result<()> {
        write_new(p, data)
    }
    /// 新しい中身を置く 1 手（本物は [`place_noreplace`]。検査は「置けない」〔宛先が在る以外の失敗〕を差し込む）
    fn place(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        place_noreplace(from, to)
    }
}

/// 製品の命令が渡す本物の手（止めない・外の操作をまねない）
pub struct NoHooks;
impl Hooks for NoHooks {}

pub(crate) fn hook(h: &mut dyn Hooks, s: Stage, c: &StageCtx) -> Result<(), Refusal> {
    match h.at(s, c) {
        Step::Go => Ok(()),
        Step::Stop => Err(Refusal(STOPPED)),
    }
}

/// 新しいファイルとして書く（在れば断る）
pub fn write_new(p: &Path, data: &[u8]) -> io::Result<()> {
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(p)?;
    f.write_all(data)
}

// ---------------- 形 ----------------

/// 新しく保存の封筒の印（contract.json の mobile_save_new.meta）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewMeta {
    pub album: String,
    /// 利用者が入れた名前（拡張子なし）
    pub name: String,
    /// 旧拡張子の作品（X.animemo）を開いて保存するときの自分の実の名前（同じアルバムの X.animemo と X.animemo.bak は数えない）
    pub self_name: Option<String>,
}

/// 上書き保存の封筒の印（contract.json の mobile_save_overwrite.meta）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverwriteMeta {
    pub album: String,
    /// 保存先の実のファイル名（`.memoanima`）
    pub name: String,
    pub source_fingerprint: Fingerprint,
}

/// 保存の結果（contract.json の types.SaveResult）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// 書いた中身の指紋
    pub fingerprint: Fingerprint,
    /// 自分の分を置いたアルバム（実の名前）
    pub album: String,
    /// 自分の分を置いたファイル名（`ours_moved` なら別の名前）
    pub name: String,
    /// 置く間に外で同じ名前が置かれたので、自分の分を別の名前の作品として置いた（外のファイルはそのまま）
    pub ours_moved: bool,
    /// 外の中身を別の名前の作品として残した名前（照合のあとで外で置き換えられていた）
    pub kept_copies: Vec<String>,
    /// 保全が途中で終わり、退避の記録を残した（次の再開が続ける）
    pub record_left: bool,
}

// ---------------- 共通の手 ----------------

/// 一時ファイルの名前（PC の保存と同じ形 `<file>.<秒>-<連番>.tmp`＝`scan_recoverable`・`delete_item` が同じ形で見る）
pub fn tmp_path(dir: &Path, file: &str) -> PathBuf {
    dir.join(format!("{file}.{}-{}.tmp", now_unix(), TMP_COUNTER.fetch_add(1, Ordering::SeqCst)))
}

/// 一時ファイルに書いて読み戻して照合する。どの失敗でも書きかけを消す（V201 P-4）
pub fn write_and_verify(tmp: &Path, data: &[u8], h: &mut dyn Hooks) -> Result<(), Refusal> {
    if let Err(e) = h.write_tmp(tmp, data) {
        remove_tmp(tmp);
        return Err(io_refusal(&e));
    }
    match fs::read(tmp) {
        Ok(got) if got.len() == data.len() && got == data => Ok(()),
        Ok(_) => {
            remove_tmp(tmp);
            Err(Refusal(code::VERIFY_FAILED))
        }
        Err(e) => {
            remove_tmp(tmp);
            Err(io_refusal(&e))
        }
    }
}

/// `from` を、`real`（作品の実のファイル名）をもとにした空いている名前（`名前-1`・`名前-2` …）へ置き換えない置き方で置く。
/// 選んだあとに外で同じ名前が置かれたら次の名前で（何度か）
pub fn place_as_copy(dir: &Path, from: &Path, real: &str) -> io::Result<String> {
    let base = names::work_owner_base(real).unwrap_or(real);
    let ext = names::work_ext(real).unwrap_or(PROJECT_EXT);
    for _ in 0..50 {
        let n = names::free_file_name(dir, base, ext, true, &[])?;
        match place_noreplace(from, &dir.join(&n)) {
            Ok(()) => {
                // その名前にサムネだけが残っていたら消す（前の作品の絵を出さない＝移すときと同じ。第三者レビュー D-L9）
                let png = dir.join(format!("{n}.png"));
                if png.is_file() {
                    let _ = fs::remove_file(png);
                }
                return Ok(n);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("no free name"))
}

/// ★退避したファイルの保全: 指紋が照合した指紋と同じなら `backup_of`（作品の実のファイル名）の普通の控え（前の控えを消してから
/// 置き換えない置き方で・控えは 1 世代）、置けない・違う・分からないなら `copy_base` をもとにした別の名前の作品として残す
pub fn preserve(
    dir: &Path,
    backup_of: &str,
    copy_base: &str,
    evac_file: &Path,
    evac_fp: Option<&Fingerprint>,
    src_fp: Option<&Fingerprint>,
    kept: &mut Vec<String>,
) -> io::Result<&'static str> {
    let matched = matches!((evac_fp, src_fp), (Some(a), Some(b)) if a == b);
    if matched {
        let bak = dir.join(format!("{backup_of}.bak"));
        let _ = fs::remove_file(&bak);
        if place_noreplace(evac_file, &bak).is_ok() {
            return Ok("backup");
        }
    }
    let n = place_as_copy(dir, evac_file, copy_base)?;
    kept.push(n);
    Ok("copy")
}

/// 旧拡張子の作品を開いて保存するときの「自分」（X.animemo と X.animemo.bak）。X.memoanima・X.memoanima.bak は自分ではない
fn legacy_self(self_name: Option<&str>, base: &str) -> Vec<String> {
    match self_name {
        Some(s) if names::work_ext(s) == Some(PROJECT_EXT_LEGACY)
            && check_work_file_name(s, true).is_ok()
            && names::work_owner_base(s).map(fold_key) == Some(fold_key(base)) =>
        {
            vec![s.to_string(), format!("{s}.bak")]
        }
        _ => Vec::new(),
    }
}

// ---------------- 新しく保存 ----------------

/// ★新しく保存する。使われている名前（大小・NFC を無視・本体か控え）なら書かずに断る。最後は置き換えない置き方で置く
/// （置く間に同じ名前が置かれたら断る）。アルバムが無ければ作らずに断る
pub fn save_new(d: &Dirs, m: &NewMeta, data: &[u8], thumb: &[u8], h: &mut dyn Hooks) -> Result<SaveResult, Refusal> {
    let base = names::new_work_base(&m.name)?;
    let file = format!("{base}.{PROJECT_EXT}");
    let (album, dir) = locate_album(d, &m.album)?;
    let tmp = tmp_path(&dir, &file);
    write_and_verify(&tmp, data, h)?;
    let _guard = lock_lib();
    let r = save_new_locked(d, &album, &dir, &base, &file, m.self_name.as_deref(), &tmp, data, thumb, h);
    if matches!(&r, Err(e) if e.0 != STOPPED) {
        remove_tmp(&tmp);
    }
    r
}

#[allow(clippy::too_many_arguments)]
fn save_new_locked(
    d: &Dirs,
    album: &str,
    dir: &Path,
    base: &str,
    file: &str,
    self_name: Option<&str>,
    tmp: &Path,
    data: &[u8],
    thumb: &[u8],
    h: &mut dyn Hooks,
) -> Result<SaveResult, Refusal> {
    // 同じ保存先に片付かない記録があれば、再開してから（片付かなければ断る）
    evac::resume_for_target(d, album, file, h)?;
    let exclude = legacy_self(self_name, base);
    if names::taken_by(dir, &fold_key(base), &exclude).map_err(|e| io_refusal(&e))?.is_some() {
        return Err(Refusal(code::NAME_TAKEN));
    }
    let dest = dir.join(file);
    hook(h, Stage::BeforePlaceNew, &StageCtx { dir, dest: &dest, evac: None })?;
    match h.place(tmp, &dest) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(Refusal(code::NAME_TAKEN)),
        Err(e) => return Err(io_refusal(&e)),
    }
    write_thumb(dir, file, thumb);
    Ok(SaveResult {
        fingerprint: Fingerprint::of_bytes(data),
        album: album.to_string(),
        name: file.to_string(),
        ours_moved: false,
        kept_copies: Vec::new(),
        record_left: false,
    })
}

// ---------------- 上書き保存 ----------------

/// ★指紋で確かめる上書き保存。今のファイルの指紋が保存元の指紋と同じときだけ書く（違えば書かずに断る）。手順は冒頭の説明
pub fn save_overwrite(d: &Dirs, m: &OverwriteMeta, data: &[u8], thumb: &[u8], h: &mut dyn Hooks) -> Result<SaveResult, Refusal> {
    check_work_file_name(&m.name, false)?;
    if !m.source_fingerprint.well_formed() {
        return Err(Refusal(code::BAD_REQUEST));
    }
    let (album, dir) = locate_album(d, &m.album)?;
    let tmp = tmp_path(&dir, &m.name);
    write_and_verify(&tmp, data, h)?;
    let _guard = lock_lib();
    let r = overwrite_locked(d, &album, &dir, &m.name, &m.source_fingerprint, &tmp, data, thumb, h);
    if matches!(&r, Err(e) if e.0 != STOPPED) {
        remove_tmp(&tmp);
    }
    r
}

#[allow(clippy::too_many_arguments)]
fn overwrite_locked(
    d: &Dirs,
    album: &str,
    dir: &Path,
    name: &str,
    src_fp: &Fingerprint,
    tmp: &Path,
    data: &[u8],
    thumb: &[u8],
    h: &mut dyn Hooks,
) -> Result<SaveResult, Refusal> {
    // 同じ保存先に片付かない記録があれば、再開してから（片付かなければ断る）
    evac::resume_for_target(d, album, name, h)?;
    let real = names::resolve_body(dir, name)
        .map_err(|e| io_refusal(&e))?
        .ok_or(Refusal(code::TARGET_MISSING))?;
    let dest = dir.join(&real);
    // 普通のファイルだけ（リンク・フォルダは保存先として扱わない）
    match fs::symlink_metadata(&dest) {
        Ok(md) if md.file_type().is_file() => {}
        Ok(_) => return Err(Refusal(code::OUTSIDE)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(Refusal(code::TARGET_MISSING)),
        Err(e) => return Err(io_refusal(&e)),
    }
    let cur = Fingerprint::of_file(&dest).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            Refusal(code::TARGET_MISSING)
        } else {
            io_refusal(&e)
        }
    })?;
    if &cur != src_fp {
        return Err(Refusal(code::FINGERPRINT_MISMATCH));
    }
    hook(h, Stage::Checked, &StageCtx { dir, dest: &dest, evac: None })?;
    // 退避は同じボリュームの中だけ（別なら何も動かす前に断る。写して消すことはしない）
    fs::create_dir_all(&d.evac).map_err(|e| io_refusal(&e))?;
    if !place::same_volume(&d.evac, dir).map_err(|e| io_refusal(&e))? {
        return Err(Refusal(code::CROSS_VOLUME));
    }
    // ★記録を書いてから退避する（記録が先＝退避の直後に止まっても、何を退避したかが分かる）。
    //  新しい中身の指紋も書く（再開で「本体があれば控え」にしてよいのは、本体がこの中身のときだけ）
    let new_fp = Fingerprint::of_bytes(data);
    let rec = Record::begin(d, album, &real, src_fp, &new_fp)?;
    let evac_file = rec.work_file();
    if let Err(e) = rec.make_work_dir() {
        rec.finish();
        return Err(io_refusal(&e));
    }
    if let Err(e) = place_noreplace(&dest, &evac_file) {
        rec.finish();
        return Err(if e.kind() == io::ErrorKind::NotFound {
            // 照合のあとで保存先が無くなった（外で移された・消された）＝書かずに断る
            Refusal(code::TARGET_MISSING)
        } else {
            io_refusal(&e)
        });
    }
    hook(h, Stage::Evacuated, &StageCtx { dir, dest: &dest, evac: Some(&evac_file) })?;
    let evac_fp = Fingerprint::of_file(&evac_file).ok();
    hook(h, Stage::BeforePlace, &StageCtx { dir, dest: &dest, evac: Some(&evac_file) })?;
    let mut ours = real.clone();
    let mut ours_moved = false;
    match h.place(tmp, &dest) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            // その間に外で置かれた: 外のファイルはそのまま、自分の分を別の名前の作品として置く
            match place_as_copy(dir, tmp, &real) {
                Ok(n) => {
                    ours = n;
                    ours_moved = true;
                }
                Err(e2) => {
                    // 自分の分を置けなかった＝置く前の失敗。退避したファイルは本体へ戻せない（外のファイルが在る）ので、
                    // 記録と一緒に残して再開に任せる（控えにするか別の名前で残す）
                    return Err(io_refusal(&e2));
                }
            }
        }
        Err(e) => {
            // ★置く前の失敗: 退避したファイルを本体へ戻して（置き換えない置き方で）断る。戻せなければ記録が残り、再開が続ける
            if place_noreplace(&evac_file, &dest).is_ok() {
                rec.finish();
            }
            return Err(io_refusal(&e));
        }
    }
    // ---- ここから先の失敗は戻さない（保存は成功として返し、記録を残して再開に任せる） ----
    write_thumb(dir, &ours, thumb);
    hook(h, Stage::Preserving, &StageCtx { dir, dest: &dest, evac: Some(&evac_file) })?;
    let mut kept = Vec::new();
    // 退避したファイル（照合した版）は、自分の分の控えにする。自分の分を別の名前で置いたときは、その名前の控え
    // （元の名前は外の作品＝その控えにすると外の作品の次の保存で消える。第三者レビュー D-M2）。
    // ★置いたあとで外で本体が替えられていたら（自分の分でない）、控えにせず別の名前の作品として残す（再開と同じ決まり・独立レビュー F1）
    let ours_intact = Fingerprint::of_file(&dir.join(&ours)).map(|b| b == new_fp).unwrap_or(false);
    let backup_src = if ours_intact { Some(src_fp) } else { None };
    let record_left = match preserve(dir, &ours, &real, &evac_file, evac_fp.as_ref(), backup_src, &mut kept) {
        Ok(_) => !rec.finish(),
        Err(_) => true,
    };
    if record_left {
        super::log_line(d, "[V202] save: preservation left for resume");
    }
    Ok(SaveResult {
        fingerprint: new_fp,
        album: album.to_string(),
        name: ours,
        ours_moved,
        kept_copies: kept,
        record_left,
    })
}
