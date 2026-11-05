//! V202 (§4-4 の 10・A5 の⑥): 上書き保存の**退避の記録**と**再開**（記録を見て、止まっていた保全を続ける）。
//!
//! ★退避先の形（決めたこと）: app_config_dir/save-evac の下に**記録ごとのフォルダ**:
//!  `save-evac/<記録の番号>/record.json`（何を退避したか＝アルバム・名前・照合した指紋）と
//!  `save-evac/<記録の番号>/work/<アルバム>/<名前>`（退避したファイル）。記録が読めなくても、退避したファイルの置き場から元のアルバムと
//!  名前が分かる（絶対パスは持たない＝決-4）。ライブラリの外なので、控えの入れ替え・一時ファイルの掃除・作品の削除の対象にならない。
//! ★記録の番号は Rust だけが作る（小文字の hex 16 字）。決まった形のほかのフォルダは触らない。
//! ★ここでは**何も消さない**: 消すのは記録（record.json）と、空になったフォルダだけ（`remove_dir` は中身があれば失敗する）。
//!  退避したファイルは、本体へ戻す・普通の控えにする・別の名前の作品として残す、のどれかでだけ動かす（置き換えない置き方）。
//! ★再開（決めたこと）: 記録だけが残って退避したファイルが無い → 記録を消す。退避したファイルの指紋が照合した指紋と同じ → 本体が
//!  まだ無ければ本体へ戻し（保存の前の姿に戻る。新しい分はオートセーブにある）、本体があれば普通の控えにする。違う → 別の名前の作品として
//!  残す。記録が読めない・照合した指紋が分からない退避ファイル → 別の名前の作品として残す。元のアルバムが無ければ作り直さず、退避先に
//!  残して「待ち」を返す（次にまた続ける）。
//! ★「本体があれば普通の控えにする」は、**その本体が、この保存で置こうとした新しい中身か、照合した版そのもの（同じ中身）のときだけ**
//!  （記録に新しい中身の指紋も書く）。止まっている間・置く間に外で別の中身が置かれていたら、退避したファイル（自分の前の版）をその
//!  控えにすると、外の作品の次の保存で控えの入れ替えに消される。そのときは別の名前の作品として残す（第三者レビュー D-M2）。
//! ★呼ぶのは `lock_lib` を持った所（保存の前・起動したとき・ライブラリを開いたとき）。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::fingerprint::Fingerprint;
use super::names::{self, fold_key};
use super::place::place_noreplace;
use super::save::{self, hook, write_new, Hooks, Stage, StageCtx};
use super::{check_work_file_name, code, io_refusal, locate_album, log_line, Dirs, Refusal};

/// 記録のファイル（contract.json の types.EvacRecord）
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordFile {
    pub v: u32,
    pub album: String,
    pub name: String,
    pub source_fingerprint: Fingerprint,
    /// この保存で置こうとした新しい中身の指紋（再開で「本体があれば控え」にしてよいのは、本体がこれのときだけ）
    pub new_fingerprint: Fingerprint,
}

/// 再開の結果の 1 件（contract.json の types.ResumeItem）。`outcome` は restored・backup・copy・dropped・waiting
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeItem {
    pub album: String,
    /// 本体へ戻した・控えにした作品の名前／別の名前で残した名前／待ちの元の名前
    pub name: String,
    pub outcome: String,
}

pub const OUTCOMES: &[&str] = &["restored", "backup", "copy", "dropped", "waiting"];

static REC_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 記録の番号（小文字の hex 16 字。時刻・プロセス・連番の SHA-256 の頭）
fn new_recno() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h = Sha256::new();
    h.update(nanos.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    h.update(REC_COUNTER.fetch_add(1, Ordering::SeqCst).to_le_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

/// 記録の番号の形か（小文字の hex 16 字）
pub fn is_recno(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// 1 つの退避の記録
pub struct Record {
    pub dir: PathBuf,
    pub album: String,
    pub name: String,
}

impl Record {
    /// 記録を書く（一時ファイル → 置き換えない置き方で置く）。退避はまだ何もしていない。
    /// `fp` は照合した指紋（退避するファイル）、`new_fp` はこの保存で置く新しい中身の指紋
    pub fn begin(d: &Dirs, album: &str, name: &str, fp: &Fingerprint, new_fp: &Fingerprint) -> Result<Record, Refusal> {
        fs::create_dir_all(&d.evac).map_err(|e| io_refusal(&e))?;
        let mut dir = None;
        for _ in 0..20 {
            let p = d.evac.join(new_recno());
            match fs::create_dir(&p) {
                Ok(()) => {
                    dir = Some(p);
                    break;
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(io_refusal(&e)),
            }
        }
        let dir = dir.ok_or(Refusal(code::IO))?;
        let body = serde_json::to_vec(&RecordFile {
            v: 1,
            album: album.to_string(),
            name: name.to_string(),
            source_fingerprint: fp.clone(),
            new_fingerprint: new_fp.clone(),
        })
        .map_err(|_| Refusal(code::IO))?;
        let tmp = dir.join("record.json.tmp");
        let placed = write_new(&tmp, &body).and_then(|_| place_noreplace(&tmp, &dir.join("record.json")));
        if let Err(e) = placed {
            let _ = fs::remove_file(&tmp);
            let _ = fs::remove_dir(&dir);
            return Err(io_refusal(&e));
        }
        Ok(Record { dir, album: album.to_string(), name: name.to_string() })
    }

    /// 退避したファイルの置き場（`<記録>/work/<アルバム>/<名前>`）
    pub fn work_file(&self) -> PathBuf {
        self.dir.join("work").join(&self.album).join(&self.name)
    }

    pub fn make_work_dir(&self) -> io::Result<()> {
        fs::create_dir_all(self.dir.join("work").join(&self.album))
    }

    /// ★記録を消す（退避したファイルがもう無いときだけ）。消せたら true。中身のあるフォルダは消さない
    pub fn finish(&self) -> bool {
        finish_dir(&self.dir)
    }
}

/// 記録のフォルダを片付ける: `work` の下にファイルが 1 つでも残っていれば何もしない（false）。無ければ record.json と空のフォルダを消す
fn finish_dir(rdir: &Path) -> bool {
    if !work_files(rdir).is_empty() {
        return false;
    }
    let _ = fs::remove_file(rdir.join("record.json"));
    let _ = fs::remove_file(rdir.join("record.json.tmp"));
    if let Ok(rd) = fs::read_dir(rdir.join("work")) {
        for ent in rd.flatten() {
            let _ = fs::remove_dir(ent.path());
        }
    }
    let _ = fs::remove_dir(rdir.join("work"));
    fs::remove_dir(rdir).is_ok() || !rdir.exists()
}

/// 記録のフォルダの中の退避したファイル（アルバム・名前・置き場）
fn work_files(rdir: &Path) -> Vec<(String, String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(albums) = fs::read_dir(rdir.join("work")) else { return out };
    for a in albums.flatten() {
        let ap = a.path();
        if !ap.is_dir() {
            continue;
        }
        let album = a.file_name().to_string_lossy().into_owned();
        let Ok(files) = fs::read_dir(&ap) else { continue };
        for f in files.flatten() {
            if f.path().is_file() {
                out.push((album.clone(), f.file_name().to_string_lossy().into_owned(), f.path()));
            }
        }
    }
    out.sort();
    out
}

fn read_record(rdir: &Path) -> Option<RecordFile> {
    let b = fs::read(rdir.join("record.json")).ok()?;
    let r: RecordFile = serde_json::from_slice(&b).ok()?;
    if r.v == 1 && r.source_fingerprint.well_formed() && r.new_fingerprint.well_formed() {
        Some(r)
    } else {
        None
    }
}

/// 退避先の記録のフォルダ（決まった形の番号だけ・並びは番号順）
fn record_dirs(d: &Dirs) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let Ok(rd) = fs::read_dir(&d.evac) else { return out };
    for ent in rd.flatten() {
        let n = ent.file_name().to_string_lossy().into_owned();
        if is_recno(&n) && ent.path().is_dir() {
            out.push(ent.path());
        }
    }
    out.sort();
    out
}

/// 記録の保存先（記録が読めればそれ・読めなければ退避したファイルの置き場から）
fn targets_of(rdir: &Path) -> Vec<(String, String)> {
    if let Some(r) = read_record(rdir) {
        return vec![(r.album, r.name)];
    }
    work_files(rdir).into_iter().map(|(a, n, _)| (a, n)).collect()
}

/// ★記録 1 つの保全を続ける。片付いたら true（記録を消した）。片付かなかった分は「待ち」として out に積む
fn process(d: &Dirs, rdir: &Path, h: &mut dyn Hooks, out: &mut Vec<ResumeItem>) -> Result<bool, Refusal> {
    let rec = read_record(rdir);
    let files = work_files(rdir);
    if files.is_empty() {
        // 記録だけが残って退避したファイルが無い → 記録を消す
        if let Some(r) = &rec {
            out.push(ResumeItem { album: r.album.clone(), name: r.name.clone(), outcome: "dropped".into() });
        }
        return Ok(finish_dir(rdir));
    }
    let mut all_done = true;
    for (f_album, f_name, path) in files {
        let (t_album, t_name) = match &rec {
            Some(r) => (r.album.clone(), r.name.clone()),
            None => (f_album.clone(), f_name.clone()),
        };
        let waiting = |out: &mut Vec<ResumeItem>| out.push(ResumeItem { album: t_album.clone(), name: t_name.clone(), outcome: "waiting".into() });
        // 名前を確かめる（記録やフォルダが崩れていても、ライブラリの外へは出さない）
        if check_work_file_name(&t_name, true).is_err() {
            log_line(d, "[V202] resume: evacuated file with an unusable name is kept");
            all_done = false;
            waiting(out);
            continue;
        }
        // 元のアルバムが無ければ作り直さない（退避先に残して待ち）
        let (real_album, dir) = match locate_album(d, &t_album) {
            Ok(x) => x,
            Err(_) => {
                all_done = false;
                waiting(out);
                continue;
            }
        };
        let fp = Fingerprint::of_file(&path).ok();
        let known = matches!((&rec, &fp), (Some(r), Some(f)) if *f == r.source_fingerprint);
        if known {
            let body = names::resolve_body(&dir, &t_name).ok().flatten();
            if body.is_none() {
                // 本体がまだ無い → 本体へ戻す（保存の前の姿。置き換えない置き方＝その間に外で置かれたら控えの道へ）
                let dest = dir.join(&t_name);
                hook(h, Stage::ResumeBeforeRestore, &StageCtx { dir: &dir, dest: &dest, evac: Some(&path) })?;
                match place_noreplace(&path, &dest) {
                    Ok(()) => {
                        out.push(ResumeItem { album: real_album.clone(), name: t_name.clone(), outcome: "restored".into() });
                        continue;
                    }
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(_) => {
                        all_done = false;
                        waiting(out);
                        continue;
                    }
                }
            }
        }
        let real = names::resolve_body(&dir, &t_name).ok().flatten().unwrap_or_else(|| t_name.clone());
        let dest = dir.join(&real);
        hook(h, Stage::ResumePreserving, &StageCtx { dir: &dir, dest: &dest, evac: Some(&path) })?;
        let mut kept = Vec::new();
        // 普通の控えにしてよいのは、照合した指紋と同じで、しかも今の本体がこの保存で置こうとした新しい中身か、照合した版そのもの
        // （同じ中身）のときだけ（本体が外で置かれた別の中身なら、その控えにすると外の作品の次の保存で消える＝別の名前の作品として
        // 残す）。それ以外は別の名前の作品（save と同じ 1 つの手）
        let body_is_ours = match &rec {
            Some(r) => Fingerprint::of_file(&dest).map(|b| b == r.new_fingerprint || b == r.source_fingerprint).unwrap_or(false),
            None => false,
        };
        let src = rec.as_ref().map(|r| &r.source_fingerprint).filter(|_| known && body_is_ours);
        match save::preserve(&dir, &real, &real, &path, fp.as_ref(), src, &mut kept) {
            Ok(kind) => {
                let name = if kind == "copy" { kept.pop().unwrap_or_default() } else { real.clone() };
                out.push(ResumeItem { album: real_album.clone(), name, outcome: kind.into() });
            }
            Err(_) => {
                all_done = false;
                waiting(out);
            }
        }
    }
    if all_done {
        Ok(finish_dir(rdir))
    } else {
        log_line(d, "[V202] resume: a record is waiting");
        Ok(false)
    }
}

/// ★すべての記録の保全を続ける（起動したとき・ライブラリを開いたとき）。`lock_lib` を持って呼ぶ
pub fn resume_all(d: &Dirs, h: &mut dyn Hooks) -> Result<Vec<ResumeItem>, Refusal> {
    let mut out = Vec::new();
    for rdir in record_dirs(d) {
        process(d, &rdir, h, &mut out)?;
    }
    Ok(out)
}

/// ★その保存先（大小・NFC を無視）の記録だけ続ける（保存の前）。片付かない記録が残れば PENDING_RECORD（他の保存先への保存は止めない）
pub fn resume_for_target(d: &Dirs, album: &str, name: &str, h: &mut dyn Hooks) -> Result<(), Refusal> {
    let (ka, kn) = (fold_key(album), fold_key(name));
    let mut pending = false;
    for rdir in record_dirs(d) {
        if !targets_of(&rdir).iter().any(|(a, n)| fold_key(a) == ka && fold_key(n) == kn) {
            continue;
        }
        let mut out = Vec::new();
        if !process(d, &rdir, h, &mut out)? {
            pending = true;
        }
    }
    if pending {
        Err(Refusal(code::PENDING_RECORD))
    } else {
        Ok(())
    }
}

/// 片付いていない記録の数（検査とログ用）
pub fn pending_count(d: &Dirs) -> usize {
    record_dirs(d).len()
}
