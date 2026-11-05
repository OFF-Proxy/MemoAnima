//! V202: モバイルの保存の仕組みの単体テスト（%TEMP% の下の本物のファイル。作者の設定・ライブラリ・オートセーブには届かない）。
//! 要件 §10 の A4（Rust の分）・A5 の⑥（検査の口で止める・外の操作をまねる）・A6・A7。`scripts/v202_smoke.ts` [R-1] が回す

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::evac::{self, Record};
use super::find;
use super::fingerprint::Fingerprint;
use super::names::{self, fold_key};
use super::ops;
use super::place::{place_noreplace, same_volume};
use super::save::{self, Hooks, NewMeta, NoHooks, OverwriteMeta, Stage, StageCtx, Step};
use super::sessions;
use super::{code, Dirs, Refusal, STOPPED};

static N: AtomicU64 = AtomicU64::new(0);

/// 使い捨ての場所（%TEMP% の下。落ちても消すのはこのフォルダ 1 つ）
struct T {
    base: PathBuf,
    d: Dirs,
}
impl T {
    fn new(tag: &str) -> T {
        let base = std::env::temp_dir().join(format!("v202-mobile-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&base);
        let lib = base.join("lib");
        fs::create_dir_all(&lib).unwrap();
        let d = Dirs::under(lib, &base.join("config"));
        T { base, d }
    }
    fn album(&self, a: &str) -> PathBuf {
        let p = self.d.lib.join(a);
        fs::create_dir_all(&p).unwrap();
        p
    }
}
impl Drop for T {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort();
    v
}
fn fp(b: &[u8]) -> Fingerprint {
    Fingerprint::of_bytes(b)
}
fn new_meta(album: &str, name: &str) -> NewMeta {
    NewMeta { album: album.into(), name: name.into(), self_name: None }
}
fn ow(album: &str, name: &str, src: &[u8]) -> OverwriteMeta {
    OverwriteMeta { album: album.into(), name: name.into(), source_fingerprint: fp(src) }
}
/// 退避先に残っている記録とファイル
fn evac_left(d: &Dirs) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(p: &Path, root: &Path, out: &mut Vec<String>) {
        if let Ok(rd) = fs::read_dir(p) {
            for e in rd.flatten() {
                let q = e.path();
                if q.is_dir() {
                    walk(&q, root, out);
                } else {
                    out.push(q.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    walk(&d.evac, &d.evac, &mut out);
    out.sort();
    out
}

/// 止める所と外の操作を差し込む口（単体テストだけ）
struct H<F: FnMut(Stage, &StageCtx) -> Step> {
    f: F,
    fail_write: bool,
    /// 同じ長さで違うバイト列を書く（読み戻しの照合が長さだけになっていないか）
    corrupt: bool,
    /// 新しい中身を置く手が失敗する（宛先が在る以外の失敗）
    fail_place: bool,
}
impl<F: FnMut(Stage, &StageCtx) -> Step> Hooks for H<F> {
    fn at(&mut self, s: Stage, c: &StageCtx) -> Step {
        (self.f)(s, c)
    }
    fn write_tmp(&mut self, p: &Path, data: &[u8]) -> io::Result<()> {
        if self.fail_write {
            fs::write(p, &data[..data.len() / 2])?;
            return Err(io::Error::new(io::ErrorKind::StorageFull, "disk full"));
        }
        if self.corrupt {
            let mut bad = data.to_vec();
            bad[0] ^= 0xff;
            return save::write_new(p, &bad);
        }
        save::write_new(p, data)
    }
    fn place(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        if self.fail_place {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"));
        }
        place_noreplace(from, to)
    }
}
fn at<F: FnMut(Stage, &StageCtx) -> Step>(f: F) -> H<F> {
    H { f, fail_write: false, corrupt: false, fail_place: false }
}
fn go() -> H<impl FnMut(Stage, &StageCtx) -> Step> {
    at(|_: Stage, _: &StageCtx| Step::Go)
}

// =====================================================================
// 名前の決まり（A6）
// =====================================================================

/// ★比べ方: 大小と NFC を無視（純粋な関数で見る＝Windows・Mac のディスクには大小だけ違う名前を 2 つ置けない）
#[test]
fn fold_ignores_case_and_normalization() {
    assert_eq!(fold_key("Sakuhin"), fold_key("SAKUHIN"));
    assert_eq!(fold_key("\u{304c}"), fold_key("\u{304b}\u{3099}"), "NFC と NFD");
    assert_eq!(fold_key("\u{00c5}NGSTRÖM"), fold_key("a\u{030a}ngstro\u{0308}m"));
    assert_ne!(fold_key("a"), fold_key("b"));
    assert_ne!(fold_key("作品"), fold_key("作品 "));
    // 拡張子と控えの印
    assert_eq!(names::work_owner_base("X.memoanima"), Some("X"));
    assert_eq!(names::work_owner_base("X.MEMOANIMA.BAK"), Some("X"));
    assert_eq!(names::work_owner_base("x.v2.animemo.bak"), Some("x.v2"));
    assert_eq!(names::work_owner_base("X.memoanima.png"), None, "サムネは使われている名前に数えない");
    assert_eq!(names::work_owner_base("X.memoanima.1-2.tmp"), None);
    assert_eq!(names::work_owner_base("X.kwz"), None);
}

/// ★使われている名前（本体か控え・大小と NFC を無視）。サムネだけなら空いている
#[test]
fn taken_names() {
    let t = T::new("taken");
    let a = t.album("A");
    fs::write(a.join("Saku.memoanima"), b"1").unwrap();
    fs::write(a.join("only.memoanima.bak"), b"2").unwrap();
    fs::write(a.join("thumb.memoanima.png"), b"3").unwrap();
    fs::write(a.join("old.animemo"), b"4").unwrap();
    fs::write(a.join("\u{304b}\u{3099}.memoanima"), b"5").unwrap(); // NFD の名前（Mac から来た）
    let k = |s: &str| fold_key(s);
    assert_eq!(names::taken_by(&a, &k("SAKU"), &[]).unwrap().as_deref(), Some("Saku.memoanima"));
    assert_eq!(names::taken_by(&a, &k("Only"), &[]).unwrap().as_deref(), Some("only.memoanima.bak"), "控えだけでも使われている");
    assert!(names::taken_by(&a, &k("thumb"), &[]).unwrap().is_none(), "サムネだけは空いている");
    assert_eq!(names::taken_by(&a, &k("OLD"), &[]).unwrap().as_deref(), Some("old.animemo"), "旧拡張子も使われている");
    assert_eq!(names::taken_by(&a, &k("\u{304c}"), &[]).unwrap().as_deref(), Some("\u{304b}\u{3099}.memoanima"), "NFD の名前を NFC で見つける");
    assert!(names::taken_by(&a, &k("new"), &[]).unwrap().is_none());
    // 在るファイルは実の名前のまま（NFD を NFC へ直さない）
    assert_eq!(names::resolve_body(&a, "\u{304c}.memoanima").unwrap().as_deref(), Some("\u{304b}\u{3099}.memoanima"));
    assert_eq!(names::resolve_body(&a, "saku.MEMOANIMA").unwrap().as_deref(), Some("Saku.memoanima"));
    assert!(names::resolve_body(&a, "only.memoanima").unwrap().is_none(), "控えは本体ではない");
}

/// ★予約名・長さ・NFC にそろえるのは新しい名前だけ
#[test]
fn new_names_reserved_and_length() {
    assert_eq!(names::new_work_base("CON").unwrap(), "CON_");
    assert_eq!(names::new_work_base("nul").unwrap(), "nul_");
    assert_eq!(names::new_work_base("con.v2").unwrap(), "con_.v2");
    assert_eq!(names::new_work_base("Com9").unwrap(), "Com9_");
    assert_eq!(names::new_work_base("CONSOLE").unwrap(), "CONSOLE");
    assert_eq!(names::new_work_base("\u{304b}\u{3099}").unwrap(), "\u{304c}", "新しい名前は NFC");
    assert_eq!(names::new_album_name("AUX").unwrap(), "AUX_");
    assert!(names::new_album_name(".hidden").is_err());
    // 日本語 69 字（207 バイト）は通る・70 字（210 バイト）は断る（.memoanima.png・.bak・一時ファイルの印を足して 255 を超える）
    let j69 = "あ".repeat(69);
    let j70 = "あ".repeat(70);
    assert!(names::new_work_base(&j69).is_ok());
    assert_eq!(names::new_work_base(&j70).unwrap_err(), Refusal(code::NAME_TOO_LONG));
    let a209 = "a".repeat(209);
    assert!(names::new_work_base(&a209).is_ok());
    assert_eq!(names::new_work_base(&"a".repeat(210)).unwrap_err(), Refusal(code::NAME_TOO_LONG));
    // 上限の名前で、本体・サムネ・控え・一時ファイルを実際に置ける（UTF-8 で 255 以下）
    let t = T::new("len");
    let a = t.album("A");
    let file = format!("{j69}.memoanima");
    for n in [file.clone(), format!("{file}.png"), format!("{file}.bak"), save::tmp_path(&a, &file).file_name().unwrap().to_string_lossy().into_owned()] {
        assert!(n.len() <= 255, "{} バイト", n.len());
        fs::write(a.join(&n), b"x").unwrap();
    }
    // こちらで選ぶ名前は縮める（名前-1 が収まるように）
    let picked = names::free_file_name(&a, &j69, "memoanima", true, &[]).unwrap();
    assert!(picked.len() <= names::FILE_MAX_BYTES && picked.ends_with("-1.memoanima"), "{}", picked.len());
}

// =====================================================================
// 置き換えない置き方（A7）
// =====================================================================

/// ★宛先が在れば断り、何も動かさない（ファイルもフォルダも）
#[test]
fn place_refuses_existing() {
    let t = T::new("place");
    let a = t.album("A");
    fs::write(a.join("src"), b"SRC").unwrap();
    fs::write(a.join("dst"), b"DST").unwrap();
    let e = place_noreplace(&a.join("src"), &a.join("dst")).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(a.join("src")).unwrap(), b"SRC");
    assert_eq!(fs::read(a.join("dst")).unwrap(), b"DST");
    place_noreplace(&a.join("src"), &a.join("new")).unwrap();
    assert_eq!(names_in(&a), vec!["dst", "new"]);
    assert_eq!(place_noreplace(&a.join("gone"), &a.join("x")).unwrap_err().kind(), io::ErrorKind::NotFound);
    // フォルダ
    fs::create_dir_all(t.d.lib.join("B")).unwrap();
    assert_eq!(place_noreplace(&a, &t.d.lib.join("B")).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
    place_noreplace(&a, &t.d.lib.join("C")).unwrap();
    assert!(t.d.lib.join("C").join("dst").is_file());
    // 長いパス（260 字を超える）でも
    let deep = t.d.lib.join("d".repeat(120)).join("e".repeat(120));
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("f".repeat(60)), b"L").unwrap();
    place_noreplace(&deep.join("f".repeat(60)), &deep.join("g".repeat(60))).unwrap();
    assert!(deep.join("g".repeat(60)).is_file());
    assert!(same_volume(&t.d.lib, &t.base).unwrap());
}

// =====================================================================
// 新しく保存（A6・A7）
// =====================================================================

/// ★渡されたバイト列を 1 バイトも変えずに書く・サムネ・指紋・一時ファイルを残さない
#[test]
fn save_new_writes_exact_bytes() {
    let t = T::new("new");
    let a = t.album("A");
    let data: Vec<u8> = (0..5000u32).map(|i| (i * 7 % 251) as u8).collect();
    let r = save::save_new(&t.d, &new_meta("A", "作品"), &data, b"PNG", &mut NoHooks).unwrap();
    assert_eq!(r.name, "作品.memoanima");
    assert_eq!(r.album, "A");
    assert_eq!(r.fingerprint, fp(&data));
    assert!(!r.ours_moved && r.kept_copies.is_empty() && !r.record_left);
    assert_eq!(fs::read(a.join("作品.memoanima")).unwrap(), data);
    assert_eq!(fs::read(a.join("作品.memoanima.png")).unwrap(), b"PNG");
    assert_eq!(names_in(&a), vec!["作品.memoanima", "作品.memoanima.png"]);
}

/// ★使われている名前（大小・NFC・旧拡張子・控えだけ）を断る。サムネだけは通る。在るファイルは 1 バイトも変えない
#[test]
fn save_new_refuses_taken() {
    let t = T::new("newtaken");
    let a = t.album("A");
    fs::write(a.join("Saku.memoanima"), b"S").unwrap();
    fs::write(a.join("\u{304b}\u{3099}.memoanima"), b"G").unwrap();
    fs::write(a.join("legacy.animemo"), b"L").unwrap();
    fs::write(a.join("bakonly.memoanima.bak"), b"B").unwrap();
    fs::write(a.join("pngonly.memoanima.png"), b"OLD").unwrap();
    for n in ["SAKU", "saku", "\u{304c}", "LEGACY", "BakOnly"] {
        assert_eq!(save::save_new(&t.d, &new_meta("A", n), b"NEW", b"", &mut NoHooks).unwrap_err(), Refusal(code::NAME_TAKEN), "{n}");
    }
    let r = save::save_new(&t.d, &new_meta("A", "pngonly"), b"NEW", b"PNG2", &mut NoHooks).unwrap();
    assert_eq!(r.name, "pngonly.memoanima");
    assert_eq!(fs::read(a.join("pngonly.memoanima.png")).unwrap(), b"PNG2", "サムネだけの名前は新しいサムネで置き換わる");
    assert_eq!(fs::read(a.join("Saku.memoanima")).unwrap(), b"S");
    assert!(names_in(&a).iter().all(|n| !n.ends_with(".tmp")), "{:?}", names_in(&a));
    // 予約名は _ を付けて書く
    let r = save::save_new(&t.d, &new_meta("A", "CON"), b"C", b"", &mut NoHooks).unwrap();
    assert_eq!(r.name, "CON_.memoanima");
    // 長すぎる名前は断る
    assert_eq!(save::save_new(&t.d, &new_meta("A", &"あ".repeat(70)), b"x", b"", &mut NoHooks).unwrap_err(), Refusal(code::NAME_TOO_LONG));
    // アルバムが無ければ作らずに断る
    assert_eq!(save::save_new(&t.d, &new_meta("Z", "x"), b"x", b"", &mut NoHooks).unwrap_err(), Refusal(code::ALBUM_MISSING));
    assert!(!t.d.lib.join("Z").exists());
}

/// ★旧拡張子の作品（X.animemo）を開いて保存: 隣の X.memoanima を新しく作る（X.animemo は自分なので数えない）。
/// X.memoanima か X.memoanima.bak があれば断る。X.animemo はそのまま
#[test]
fn save_new_legacy_self() {
    let t = T::new("legacy");
    let a = t.album("A");
    fs::write(a.join("X.animemo"), b"OLD").unwrap();
    fs::write(a.join("X.animemo.bak"), b"OLDBAK").unwrap();
    let mut m = new_meta("A", "X");
    m.self_name = Some("X.animemo".into());
    let r = save::save_new(&t.d, &m, b"NEW", b"", &mut NoHooks).unwrap();
    assert_eq!(r.name, "X.memoanima");
    assert_eq!(fs::read(a.join("X.animemo")).unwrap(), b"OLD", "旧拡張子のファイルはそのまま");
    // もう一度は断る（X.memoanima がある）
    assert_eq!(save::save_new(&t.d, &m, b"NEW2", b"", &mut NoHooks).unwrap_err(), Refusal(code::NAME_TAKEN));
    // X.memoanima.bak だけでも断る
    let b = t.album("B");
    fs::write(b.join("Y.animemo"), b"OLD").unwrap();
    fs::write(b.join("Y.memoanima.bak"), b"BK").unwrap();
    let mut m = new_meta("B", "Y");
    m.self_name = Some("Y.animemo".into());
    assert_eq!(save::save_new(&t.d, &m, b"NEW", b"", &mut NoHooks).unwrap_err(), Refusal(code::NAME_TAKEN));
    // 自分でない名前を selfName にしても数えないことにはならない
    let mut m = new_meta("A", "X2");
    fs::write(a.join("X2.animemo"), b"O").unwrap();
    m.self_name = Some("X.animemo".into());
    assert_eq!(save::save_new(&t.d, &m, b"N", b"", &mut NoHooks).unwrap_err(), Refusal(code::NAME_TAKEN));
}

/// ★P-4 と同じ: 書いている途中で失敗したら書きかけを消す（空きが無い＝no-space）。置く直前に外で同じ名前が置かれたら断る（置き換えない）
#[test]
fn save_new_write_failure_and_race() {
    let t = T::new("newrace");
    let a = t.album("A");
    let mut h = go();
    h.fail_write = true;
    assert_eq!(save::save_new(&t.d, &new_meta("A", "x"), b"DATA-DATA", b"P", &mut h).unwrap_err(), Refusal(code::NO_SPACE));
    assert!(names_in(&a).is_empty(), "{:?}", names_in(&a));
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::BeforePlaceNew {
            fs::write(c.dest, b"THEIRS").unwrap();
        }
        Step::Go
    });
    assert_eq!(save::save_new(&t.d, &new_meta("A", "y"), b"OURS", b"P", &mut h).unwrap_err(), Refusal(code::NAME_TAKEN));
    assert_eq!(fs::read(a.join("y.memoanima")).unwrap(), b"THEIRS", "外のファイルを置き換えた");
    assert_eq!(names_in(&a), vec!["y.memoanima"], "書きかけ・サムネが残った");
}

// =====================================================================
// 指紋で確かめる上書き（A5・A7）
// =====================================================================

fn setup_work(t: &T, body: &[u8]) -> PathBuf {
    let a = t.album("A");
    fs::write(a.join("w.memoanima"), body).unwrap();
    fs::write(a.join("w.memoanima.bak"), b"OLDER").unwrap();
    a
}

/// ★指紋が同じなら書く。前のファイルは普通の控え（前の控えは消える＝1 世代）・記録も退避も残らない・書いた中身の指紋を返す
#[test]
fn overwrite_matching() {
    let t = T::new("ow");
    let a = setup_work(&t, b"V1");
    let r = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"V2-NEW", b"PNG", &mut NoHooks).unwrap();
    assert_eq!(r.fingerprint, fp(b"V2-NEW"));
    assert_eq!((r.name.as_str(), r.ours_moved, r.kept_copies.len(), r.record_left), ("w.memoanima", false, 0, false));
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"V2-NEW");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"V1");
    assert_eq!(names_in(&a), vec!["w.memoanima", "w.memoanima.bak", "w.memoanima.png"]);
    assert!(evac_left(&t.d).is_empty(), "{:?}", evac_left(&t.d));
    assert_eq!(evac::pending_count(&t.d), 0);
}

/// ★指紋が違えば書かずに断る（版が同じでも＝版では確かめない）。保存先が無ければ target-missing。どちらも何も変えない
#[test]
fn overwrite_refusals() {
    let t = T::new("owref");
    let a = setup_work(&t, b"V1");
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"OTHER"), b"V2", b"", &mut NoHooks).unwrap_err(), Refusal(code::FINGERPRINT_MISMATCH));
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"V1");
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "gone.memoanima", b"V1"), b"V2", b"", &mut NoHooks).unwrap_err(), Refusal(code::TARGET_MISSING));
    assert_eq!(save::save_overwrite(&t.d, &ow("Z", "w.memoanima", b"V1"), b"V2", b"", &mut NoHooks).unwrap_err(), Refusal(code::ALBUM_MISSING));
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.animemo", b"V1"), b"V2", b"", &mut NoHooks).unwrap_err(), Refusal(code::BAD_NAME), "旧拡張子へは上書きしない");
    assert_eq!(names_in(&a), vec!["w.memoanima", "w.memoanima.bak"], "書きかけ・サムネが残った");
    assert!(evac_left(&t.d).is_empty());
    // 大小・NFD の違う名前で受けても、実の名前のまま書く
    fs::write(a.join("\u{304b}\u{3099}.memoanima"), b"G1").unwrap();
    let r = save::save_overwrite(&t.d, &ow("A", "\u{304c}.memoanima", b"G1"), b"G2", b"", &mut NoHooks).unwrap();
    assert_eq!(r.name, "\u{304b}\u{3099}.memoanima");
    assert_eq!(fs::read(a.join("\u{304b}\u{3099}.memoanima")).unwrap(), b"G2");
    // V211 (§15): Mac の APFS は NFC と NFD を同じ名前として引くので、exists() では見分けられない＝read_dir の実の名前で見る
    assert!(!names_in(&a).contains(&"\u{304c}.memoanima".to_string()), "NFC の別のファイルを作った");
    assert!(names_in(&a).contains(&"\u{304b}\u{3099}.memoanima".to_string()), "実の名前（NFD）が無い");
}

/// ★⑥ 照合のあとで外で置き換えられた（退避したファイルの指紋が違う）→ 自分の分は元の名前、外の中身は別の名前の作品として残す
#[test]
fn overwrite_external_replace_between_check_and_write() {
    let t = T::new("owrep");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::Checked {
            fs::write(c.dest, b"THEIRS").unwrap();
        }
        Step::Go
    });
    let r = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap();
    assert_eq!(r.name, "w.memoanima");
    assert_eq!(r.kept_copies, vec!["w-1.memoanima".to_string()]);
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"OURS");
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"THEIRS", "外の中身が消えた");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"OLDER", "控えを外の中身で置き換えた（指紋を見ていない）");
    assert!(evac_left(&t.d).is_empty());
}

/// ★別の名前の作品として残すとき、その名前にサムネだけが残っていたら消す（前の作品の絵を出さない・移すときと同じ）
#[test]
fn kept_copy_drops_orphan_thumbnail() {
    let t = T::new("orphanpng");
    let a = setup_work(&t, b"V1");
    fs::write(a.join("w-1.memoanima.png"), b"OLD-PNG").unwrap();
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::Checked {
            fs::write(c.dest, b"THEIRS").unwrap();
        }
        Step::Go
    });
    let r = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap();
    assert_eq!(r.kept_copies, vec!["w-1.memoanima".to_string()]);
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"THEIRS");
    assert!(!a.join("w-1.memoanima.png").exists(), "前の作品のサムネが残った");
}

/// ★⑥ 照合のあとで保存先が消された → 書かずに断る（記録も退避も残さない・書きかけも）
#[test]
fn overwrite_external_delete() {
    let t = T::new("owdel");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::Checked {
            fs::remove_file(c.dest).unwrap();
        }
        Step::Go
    });
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap_err(), Refusal(code::TARGET_MISSING));
    assert_eq!(names_in(&a), vec!["w.memoanima.bak"]);
    assert!(evac_left(&t.d).is_empty(), "{:?}", evac_left(&t.d));
}

/// ★⑥ 置く直前に外で同じ名前が置かれた → 外のファイルはそのまま、自分の分を別の名前で（知らせ）。前のファイルは**自分の分の**控え
/// （外の作品の控えにすると、外の作品の次の保存の控えの入れ替えで消える＝第三者レビュー D-M2 の b）
#[test]
fn overwrite_external_place_same_name() {
    let t = T::new("owplace");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::BeforePlace {
            fs::write(c.dest, b"THEIRS").unwrap();
        }
        Step::Go
    });
    let r = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"PNG", &mut h).unwrap();
    assert!(r.ours_moved);
    assert_eq!(r.name, "w-1.memoanima");
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"THEIRS", "外のファイルを置き換えた");
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"OURS");
    assert_eq!(fs::read(a.join("w-1.memoanima.png")).unwrap(), b"PNG");
    assert_eq!(fs::read(a.join("w-1.memoanima.bak")).unwrap(), b"V1", "前の版が自分の分の控えになっていない");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"OLDER", "前の版を外の作品の控えにした");
    assert!(evac_left(&t.d).is_empty());
    // 外の作品を次に保存しても、前の版（V1）は消えない
    save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"THEIRS"), b"THEIRS2", b"", &mut NoHooks).unwrap();
    assert_eq!(fs::read(a.join("w-1.memoanima.bak")).unwrap(), b"V1");
}

/// ★⑥ 置いたあと・保全の前に外で本体が替えられた → 前の版は外の中身の控えにせず、別の名前の作品として残す
/// （外の作品の次の保存の控えの入れ替えで消えない＝再開と同じ決まり。独立レビュー F1）
#[test]
fn overwrite_external_replace_after_place_keeps_previous() {
    let t = T::new("owafter");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::Preserving {
            fs::write(c.dest, b"THEIRS").unwrap();
        }
        Step::Go
    });
    let r = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap();
    assert_eq!(r.kept_copies, vec!["w-1.memoanima".to_string()]);
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"V1", "前の版が作品として残っていない");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"OLDER", "前の版を外の中身の控えにした");
    assert!(!r.record_left);
    // 外の作品を次に保存しても前の版は残る
    save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"THEIRS"), b"THEIRS2", b"", &mut NoHooks).unwrap();
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"V1");
    assert!(evac_left(&t.d).is_empty());
}

/// ★⑥ 置いたあと・保全の前に外で本体が消された（指紋が取れない）→ 前の版は控え（本体の無い控え）にせず、別の名前の作品として残す
/// （置いた本体が自分の分だと確かめられないときは「違う」の側。独立レビュー 2 回目の緑の書き換え 1）
#[test]
fn overwrite_body_gone_after_place_keeps_previous_as_copy() {
    let t = T::new("owgone");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::Preserving {
            fs::remove_file(c.dest).unwrap();
        }
        Step::Go
    });
    let r = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap();
    assert_eq!(r.kept_copies, vec!["w-1.memoanima".to_string()]);
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"V1", "前の版が作品として残っていない");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"OLDER", "前の版を本体の無い控えにした");
    assert!(!r.record_left);
    assert!(evac_left(&t.d).is_empty());
}

/// ★⑥ 退避の直後で止まる → 再開で本体へ戻す（保存の前の姿）→ 同じ作品を保存し直せる（控えは前の版）
#[test]
fn overwrite_stop_after_evacuation_then_resume() {
    let t = T::new("owstop1");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, _: &StageCtx| if s == Stage::Evacuated { Step::Stop } else { Step::Go });
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap_err(), Refusal(STOPPED));
    assert!(!a.join("w.memoanima").exists(), "退避したはず");
    assert_eq!(evac::pending_count(&t.d), 1);
    // 再起動して同じ作品を保存し直す（保存の前に再開が走る）
    let r = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut NoHooks).unwrap();
    assert_eq!(r.name, "w.memoanima");
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"OURS");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"V1");
    assert!(evac_left(&t.d).is_empty(), "{:?}", evac_left(&t.d));
}

/// ★⑥ 外で置き換えられた中身を退避したあと、保全の途中で止まる → 再開で別の名前の作品として残す（次の保存の控えの入れ替えで消えない）
#[test]
fn overwrite_stop_during_preserve_keeps_theirs() {
    let t = T::new("owstop2");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, c: &StageCtx| match s {
        Stage::Checked => {
            fs::write(c.dest, b"THEIRS").unwrap();
            Step::Go
        }
        Stage::Preserving => Step::Stop,
        _ => Step::Go,
    });
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap_err(), Refusal(STOPPED));
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"OURS");
    // 再起動 → 保存の前の再開（同じ保存先）→ 外の中身は別の名前の作品。自分の分の保存は指紋が違う（自分の保存は終わっていない）ので断る
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS2", b"", &mut NoHooks).unwrap_err(), Refusal(code::FINGERPRINT_MISMATCH));
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"THEIRS", "外の中身が作品として残っていない");
    // 次の保存（今の中身の指紋で）でも、外の中身は消えない
    save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"OURS"), b"OURS3", b"", &mut NoHooks).unwrap();
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"THEIRS");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"OURS");
    assert!(evac_left(&t.d).is_empty());
}

/// ★⑥ 保全の途中で止まる（指紋は同じ）→ 再開で普通の控えにする
#[test]
fn overwrite_stop_during_preserve_matching_becomes_backup() {
    let t = T::new("owstop3");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, _: &StageCtx| if s == Stage::Preserving { Step::Stop } else { Step::Go });
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap_err(), Refusal(STOPPED));
    let _g = crate::pclib::lock_lib();
    let out = evac::resume_all(&t.d, &mut NoHooks).unwrap();
    drop(_g);
    assert_eq!(out.iter().map(|i| i.outcome.as_str()).collect::<Vec<_>>(), vec!["backup"]);
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"V1");
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"OURS");
    assert!(evac_left(&t.d).is_empty());
}

/// ★再開: 本体へ戻す直前に外で同じ名前が置かれた → 置き換えない（外のファイルはそのまま）。退避したファイル（前の版）は、外の中身の
/// 控えにはせず別の名前の作品として残す（第三者レビュー D-M2）
#[test]
fn resume_restore_race_does_not_replace() {
    let t = T::new("resrace");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, _: &StageCtx| if s == Stage::Evacuated { Step::Stop } else { Step::Go });
    let _ = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h);
    let mut h2 = at(|s: Stage, c: &StageCtx| {
        if s == Stage::ResumeBeforeRestore {
            fs::write(c.dest, b"THEIRS").unwrap();
        }
        Step::Go
    });
    let _g = crate::pclib::lock_lib();
    let out = evac::resume_all(&t.d, &mut h2).unwrap();
    drop(_g);
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"THEIRS", "外のファイルを置き換えた");
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"V1", "前の版が作品として残っていない");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"OLDER", "前の版を外の作品の控えにした");
    assert_eq!((out[0].outcome.as_str(), out[0].name.as_str()), ("copy", "w-1.memoanima"));
    assert!(evac_left(&t.d).is_empty());
}

/// ★D-M2 の a: 退避の直後で止まり、止まっている間に外で同じ名前に別の中身が置かれた → 再開で前の版は別の名前の作品
/// （外の作品の控えにすると、外の作品の次の保存で消える）。外の作品はそのまま
#[test]
fn resume_with_foreign_body_keeps_previous_as_copy() {
    let t = T::new("resforeign");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, _: &StageCtx| if s == Stage::Evacuated { Step::Stop } else { Step::Go });
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap_err(), Refusal(STOPPED));
    fs::write(a.join("w.memoanima"), b"THEIRS").unwrap();
    let _g = crate::pclib::lock_lib();
    let out = evac::resume_all(&t.d, &mut NoHooks).unwrap();
    drop(_g);
    assert_eq!(out.iter().map(|i| (i.outcome.as_str(), i.name.as_str())).collect::<Vec<_>>(), vec![("copy", "w-1.memoanima")]);
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"THEIRS");
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"V1");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"OLDER");
    // 外の作品を保存しても V1 は残る
    save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"THEIRS"), b"THEIRS2", b"", &mut NoHooks).unwrap();
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"V1");
    assert!(evac_left(&t.d).is_empty());
}

/// ★記録の形の版（v）が 1 でなければ読めない記録として扱う（本体へ戻さず、別の名前の作品として残す）
#[test]
fn record_of_other_version_is_unreadable() {
    let t = T::new("recver");
    let a = setup_work(&t, b"V1");
    let mut h = at(|s: Stage, _: &StageCtx| if s == Stage::Evacuated { Step::Stop } else { Step::Go });
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h).unwrap_err(), Refusal(STOPPED));
    let rec = fs::read_dir(&t.d.evac).unwrap().flatten().next().unwrap().path().join("record.json");
    let mut v: serde_json::Value = serde_json::from_slice(&fs::read(&rec).unwrap()).unwrap();
    v["v"] = serde_json::json!(2);
    fs::write(&rec, serde_json::to_vec(&v).unwrap()).unwrap();
    let _g = crate::pclib::lock_lib();
    let out = evac::resume_all(&t.d, &mut NoHooks).unwrap();
    drop(_g);
    assert_eq!(out.iter().map(|i| (i.outcome.as_str(), i.name.as_str())).collect::<Vec<_>>(), vec![("copy", "w-1.memoanima")], "知らない版の記録を信じた");
    assert!(!a.join("w.memoanima").exists());
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"V1");
}

/// ★記録に新しい中身の指紋がある（壊れた・無い記録は読めないものとして別の名前の作品）
#[test]
fn record_carries_new_fingerprint() {
    let t = T::new("recnew");
    let _a = setup_work(&t, b"V1");
    let mut seen = None;
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::Evacuated {
            let rec = c.evac.unwrap().parent().unwrap().parent().unwrap().parent().unwrap().join("record.json");
            seen = Some(fs::read(rec).unwrap());
            return Step::Stop;
        }
        Step::Go
    });
    let _ = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h);
    let r: serde_json::Value = serde_json::from_slice(&seen.unwrap()).unwrap();
    assert_eq!(serde_json::from_value::<Fingerprint>(r["newFingerprint"].clone()).unwrap(), fp(b"OURS"));
    assert_eq!(serde_json::from_value::<Fingerprint>(r["sourceFingerprint"].clone()).unwrap(), fp(b"V1"));
}

/// ★再開: 記録だけ（退避したファイルが無い）→ 記録を消す。記録が読めない → 別の名前の作品。アルバムが無い → 作らずに待ち（その保存先への保存は断る・他の保存先は止めない）
#[test]
fn resume_cases() {
    let t = T::new("res");
    let a = setup_work(&t, b"V1");
    // 記録だけ
    let r = Record::begin(&t.d, "A", "w.memoanima", &fp(b"V1"), &fp(b"V2")).unwrap();
    assert!(r.dir.join("record.json").is_file());
    // 記録が読めない退避ファイル
    let r2 = Record::begin(&t.d, "A", "lost.memoanima", &fp(b"?"), &fp(b"?2")).unwrap();
    r2.make_work_dir().unwrap();
    fs::write(r2.work_file(), b"LOST").unwrap();
    fs::write(r2.dir.join("record.json"), b"{broken").unwrap();
    // アルバムが無い
    let r3 = Record::begin(&t.d, "Gone", "g.memoanima", &fp(b"G"), &fp(b"G-NEW")).unwrap();
    r3.make_work_dir().unwrap();
    fs::write(r3.work_file(), b"G").unwrap();
    let _g = crate::pclib::lock_lib();
    let out = evac::resume_all(&t.d, &mut NoHooks).unwrap();
    drop(_g);
    let mut oc: Vec<(String, String)> = out.iter().map(|i| (i.name.clone(), i.outcome.clone())).collect();
    oc.sort();
    assert_eq!(oc, vec![("g.memoanima".into(), "waiting".into()), ("lost-1.memoanima".into(), "copy".into()), ("w.memoanima".into(), "dropped".into())]);
    assert_eq!(fs::read(a.join("lost-1.memoanima")).unwrap(), b"LOST");
    assert!(!t.d.lib.join("Gone").exists(), "無いアルバムを作り直した");
    assert_eq!(evac::pending_count(&t.d), 1, "待ちの記録は残す");
    // 待ちの保存先へは書かない（アルバムを作っても、再開してから。片付けば書ける）
    let g = t.album("Gone");
    fs::write(g.join("g.memoanima"), b"G").unwrap();
    let r = save::save_overwrite(&t.d, &ow("Gone", "g.memoanima", b"G"), b"G2", b"", &mut NoHooks).unwrap();
    assert_eq!(fs::read(g.join("g.memoanima")).unwrap(), b"G2");
    assert_eq!(fs::read(g.join("g.memoanima.bak")).unwrap(), b"G", "待ちだった退避ファイル（同じ指紋）は控えに");
    assert!(!r.record_left);
    assert_eq!(evac::pending_count(&t.d), 0);
}

/// ★片付かない記録があれば、その保存先への保存は断る（pending-record・大小と NFC を無視して同じ保存先）。他の保存先への保存は止めない
#[test]
fn pending_record_blocks_only_its_target() {
    let t = T::new("pend");
    let a = setup_work(&t, b"V1");
    fs::write(a.join("other.memoanima"), b"O1").unwrap();
    // アルバムが無い保存先を指す記録（作り直さない＝片付かない）
    let r = Record::begin(&t.d, "Lost", "w.memoanima", &fp(b"L"), &fp(b"L2")).unwrap();
    r.make_work_dir().unwrap();
    fs::write(r.work_file(), b"L").unwrap();
    {
        let _g = crate::pclib::lock_lib();
        assert_eq!(evac::resume_for_target(&t.d, "LOST", "W.memoanima", &mut NoHooks).unwrap_err(), Refusal(code::PENDING_RECORD));
        assert!(evac::resume_for_target(&t.d, "A", "w.memoanima", &mut NoHooks).is_ok(), "他の保存先を止めた");
    }
    // 他の保存先への保存は通る（同じ名前でも別のアルバム）
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "other.memoanima", b"O1"), b"O2", b"", &mut NoHooks).unwrap().name, "other.memoanima");
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"V2", b"", &mut NoHooks).unwrap().name, "w.memoanima");
    assert_eq!(evac::pending_count(&t.d), 1);
    // アルバムができると、その保存先への保存の前に片付く（指紋は記録と同じ・本体が無い → 本体へ戻す）→ 名前が使われているので新しく保存は断る
    t.album("Lost");
    assert_eq!(save::save_new(&t.d, &new_meta("Lost", "w"), b"N", b"", &mut NoHooks).unwrap_err(), Refusal(code::NAME_TAKEN));
    assert_eq!(fs::read(t.d.lib.join("Lost").join("w.memoanima")).unwrap(), b"L", "退避ファイルを本体へ戻していない");
    assert_eq!(evac::pending_count(&t.d), 0);
}

/// ★退避は同じボリュームの中だけ・記録は退避より前に書く（退避の直後に止まっても記録がある）
#[test]
fn record_precedes_evacuation() {
    let t = T::new("order");
    let _a = setup_work(&t, b"V1");
    let mut seen = Vec::new();
    let mut h = at(|s: Stage, c: &StageCtx| {
        if s == Stage::Evacuated {
            let ev = c.evac.unwrap();
            let rec = ev.parent().unwrap().parent().unwrap().parent().unwrap().join("record.json");
            seen.push((rec.is_file(), ev.is_file()));
            return Step::Stop;
        }
        Step::Go
    });
    let _ = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"OURS", b"", &mut h);
    assert_eq!(seen, vec![(true, true)], "退避の直後に記録が無い");
    // 退避先は app_config_dir の下（ライブラリの外）
    let left = evac_left(&t.d);
    assert!(left.iter().any(|p| p.ends_with("/record.json")) && left.iter().any(|p| p.ends_with("/work/A/w.memoanima")), "{left:?}");
    assert!(!t.d.evac.starts_with(&t.d.lib));
}

/// ★書いている途中で失敗（空きが無い）→ 元のファイルはそのまま・書きかけを残さない・記録も作らない
#[test]
fn overwrite_write_failure_keeps_original() {
    let t = T::new("owfull");
    let a = setup_work(&t, b"V1");
    let mut h = go();
    h.fail_write = true;
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"V2-DATA", b"", &mut h).unwrap_err(), Refusal(code::NO_SPACE));
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"V1");
    assert_eq!(names_in(&a), vec!["w.memoanima", "w.memoanima.bak"]);
    assert!(evac_left(&t.d).is_empty());
}

/// ★書いたものの読み戻しはバイトで照合する（長さが同じでも中身が違えば verify-failed・書きかけを残さない・元のファイルはそのまま）
#[test]
fn verify_compares_bytes_not_length() {
    let t = T::new("owverify");
    let a = setup_work(&t, b"V1");
    let mut h = go();
    h.corrupt = true;
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"V2-DATA", b"", &mut h).unwrap_err(), Refusal(code::VERIFY_FAILED));
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"V1");
    assert_eq!(names_in(&a), vec!["w.memoanima", "w.memoanima.bak"]);
    let mut h = go();
    h.corrupt = true;
    assert_eq!(save::save_new(&t.d, &new_meta("A", "n"), b"NEWDATA", b"", &mut h).unwrap_err(), Refusal(code::VERIFY_FAILED));
    assert_eq!(names_in(&a), vec!["w.memoanima", "w.memoanima.bak"]);
    assert!(evac_left(&t.d).is_empty());
}

/// ★新しい中身を置けなかった（宛先が在る以外の失敗）→ 退避したファイルを本体へ戻して断る（作品が消えたままにならない・記録も残さない）
#[test]
fn overwrite_place_failure_restores_original() {
    let t = T::new("owplacefail");
    let a = setup_work(&t, b"V1");
    let mut h = go();
    h.fail_place = true;
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"V2", b"", &mut h).unwrap_err(), Refusal(code::IO));
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"V1", "退避したファイルを戻していない");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"OLDER");
    assert_eq!(names_in(&a), vec!["w.memoanima", "w.memoanima.bak"], "書きかけが残った");
    assert!(evac_left(&t.d).is_empty(), "{:?}", evac_left(&t.d));
    assert_eq!(evac::pending_count(&t.d), 0);
}

/// ★控えの名前を置けない（フォルダが在る）→ 前の版は別の名前の作品として残す（記録を残して片付かなくしない）
#[test]
fn backup_blocked_falls_back_to_copy() {
    let t = T::new("bakblock");
    let a = t.album("A");
    fs::write(a.join("w.memoanima"), b"V1").unwrap();
    fs::create_dir(a.join("w.memoanima.bak")).unwrap();
    let r = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"V2", b"", &mut NoHooks).unwrap();
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"V2");
    assert_eq!(r.kept_copies, vec!["w-1.memoanima".to_string()]);
    assert_eq!(fs::read(a.join("w-1.memoanima")).unwrap(), b"V1");
    assert!(!r.record_left);
    assert!(evac_left(&t.d).is_empty());
}

/// ★保存先がフォルダ（普通のファイルでない）→ 書かずに断る（退避もしない）
#[test]
fn overwrite_refuses_directory_target() {
    let t = T::new("owdir");
    let a = t.album("A");
    fs::create_dir(a.join("w.memoanima")).unwrap();
    let e = save::save_overwrite(&t.d, &ow("A", "w.memoanima", b"V1"), b"V2", b"", &mut NoHooks).unwrap_err();
    assert_eq!(e, Refusal(code::OUTSIDE));
    assert!(a.join("w.memoanima").is_dir());
    assert!(evac_left(&t.d).is_empty());
}

/// ★記録を消すのは、退避したファイルがもう無いときだけ（残っていれば記録もファイルも消さない）
#[test]
fn record_finish_keeps_live_evacuated_file() {
    let t = T::new("finish");
    let r = Record::begin(&t.d, "A", "w.memoanima", &fp(b"V1"), &fp(b"V2")).unwrap();
    r.make_work_dir().unwrap();
    fs::write(r.work_file(), b"V1").unwrap();
    assert!(!r.finish(), "退避したファイルが残っているのに片付けた");
    assert_eq!(fs::read(r.work_file()).unwrap(), b"V1");
    assert!(r.dir.join("record.json").is_file());
    fs::remove_file(r.work_file()).unwrap();
    assert!(r.finish());
    assert!(!r.dir.exists());
}

/// ★名前が大小・NFC だけ違う作品が 2 つ → どちらとも決めない（上書きしない・名前を変えない）
#[test]
fn ambiguous_names_are_not_resolved() {
    let t = T::new("ambig");
    let a = t.album("A");
    fs::write(a.join("\u{c1}.memoanima"), b"X1").unwrap();
    fs::write(a.join("a\u{301}.memoanima"), b"X2").unwrap();
    if names_in(&a).len() != 2 {
        return; // 2 つ置けないディスク（NFC にそろえる・大小を区別しない）では試せない
    }
    assert_eq!(names::resolve_body(&a, "A\u{301}.memoanima").unwrap(), None);
    assert_eq!(names::resolve_body(&a, "\u{c1}.memoanima").unwrap().as_deref(), Some("\u{c1}.memoanima"), "同じ字は決める");
    assert_eq!(save::save_overwrite(&t.d, &ow("A", "A\u{301}.memoanima", b"X1"), b"Y", b"", &mut NoHooks).unwrap_err(), Refusal(code::TARGET_MISSING));
    assert_eq!(ops::rename_work(&t.d, "A", "A\u{301}.memoanima", "z").unwrap_err(), Refusal(code::TARGET_MISSING));
    assert_eq!((fs::read(a.join("\u{c1}.memoanima")).unwrap(), fs::read(a.join("a\u{301}.memoanima")).unwrap()), (b"X1".to_vec(), b"X2".to_vec()));
}

// =====================================================================
// 開いた作品ごとのオートセーブ・世代・鍵（A4 の Rust の分）
// =====================================================================

fn sid(n: u8) -> String {
    // 小文字の hex 32 字（テストごとに違う番号＝プロセスの中の鍵と床を分ける）
    format!("{:08x}{:08x}{:016x}", std::process::id(), n, N.fetch_add(1, Ordering::SeqCst))
}
fn meta(title: &str, album: &str, name: &str) -> serde_json::Value {
    serde_json::json!({ "title": title, "album": album, "name": name, "workId": null, "baseRev": 0, "sourceFingerprint": null, "unsaved": false, "savedAt": "t" })
}

/// ★A を書く → B を書く → A が残る。控えだけの番号も一覧に出て読める。消すと本体・控え・一時ファイル全部。読めないものは出さず消さない
#[test]
fn sessions_per_work() {
    let t = T::new("sess");
    let (a, b) = (sid(1), sid(2));
    sessions::write(&t.d, &a, sessions::next_gen(), &meta("A", "al", "a.memoanima"), b"DATA-A").unwrap();
    sessions::write(&t.d, &b, sessions::next_gen(), &meta("B", "al", "b.memoanima"), b"DATA-B").unwrap();
    let l = sessions::list(&t.d);
    assert_eq!(l.iter().map(|e| e.session.clone()).collect::<Vec<_>>(), { let mut v = vec![a.clone(), b.clone()]; v.sort(); v });
    // 封筒（P-3 と同じ）: path の欄は番号・作品はそのまま
    let env = sessions::read(&t.d, &a).unwrap();
    let hl = u32::from_le_bytes(env[0..4].try_into().unwrap()) as usize;
    let head: serde_json::Value = serde_json::from_slice(&env[4..4 + hl]).unwrap();
    assert_eq!(head["path"], serde_json::Value::String(a.clone()));
    assert_eq!(head["meta"]["title"], "A");
    assert_eq!(&env[4 + hl..], b"DATA-A");
    assert_eq!((4 + hl) % 8, 0);
    // 控えだけの番号（本体が無い）
    let c = sid(3);
    fs::write(t.d.sessions.join(format!("{c}.asv.bak")), [b"AMAS1\n".as_ref(), br#"{"title":"C"}"#, b"\nDATA-C"].concat()).unwrap();
    let l = sessions::list(&t.d);
    let ec = l.iter().find(|e| e.session == c).expect("控えだけの番号が一覧に無い");
    assert_eq!(ec.from, "bak");
    let env = sessions::read(&t.d, &c).unwrap();
    assert!(env.ends_with(b"DATA-C"));
    // 読めないもの
    let bad = sid(4);
    fs::write(t.d.sessions.join(format!("{bad}.asv")), b"AMAS1\n{not json\nx").unwrap();
    assert!(!sessions::list(&t.d).iter().any(|e| e.session == bad), "読めないものを一覧に出した");
    assert!(t.d.sessions.join(format!("{bad}.asv")).is_file(), "読めないものを消した");
    // 消す（本体・控え・一時ファイル）
    fs::write(t.d.sessions.join(format!("{a}.asv.bak")), b"x").unwrap();
    fs::write(t.d.sessions.join(format!("{a}.asv.12.tmp")), b"x").unwrap();
    sessions::delete(&t.d, &a, sessions::next_gen()).unwrap();
    assert!(names_in(&t.d.sessions).iter().all(|n| !n.starts_with(&a)), "{:?}", names_in(&t.d.sessions));
    assert!(t.d.sessions.join(format!("{b}.asv")).is_file(), "他のセッションを消した");
    // 番号の形のほかは断る（フォルダの外を指せない）
    for s in ["../../settings", "ABCDEF0123456789ABCDEF0123456789", "x", ""] {
        assert_eq!(sessions::write(&t.d, s, sessions::next_gen(), &meta("x", "a", "b"), b"x").unwrap_err(), Refusal(code::BAD_SESSION), "{s}");
        assert_eq!(sessions::read(&t.d, s).unwrap_err(), Refusal(code::BAD_SESSION));
        assert_eq!(sessions::delete(&t.d, s, sessions::next_gen()).unwrap_err(), Refusal(code::BAD_SESSION));
    }
}

/// ★世代: 床（受けた最後の世代と消した世代の大きいほう）以下の書き込みも消すことも断る。
/// 読み込み直しのあとに古い書き込み・消すことが遅れて届いても、新しい書き込みを上書きしない・消さない・消したものを戻さない。
/// 復元したセッションの新しい書き込みは受ける
#[test]
fn generations() {
    let t = T::new("gen");
    let s = sid(9);
    let g1 = sessions::next_gen();
    let g2 = sessions::next_gen();
    let g3 = sessions::next_gen();
    let g4 = sessions::next_gen();
    let g5 = sessions::next_gen();
    let g6 = sessions::next_gen();
    let g7 = sessions::next_gen();
    assert!(g1 < g2 && g2 < g3 && g3 < g4 && g4 < g5 && g5 < g6 && g6 < g7, "増える一方");
    sessions::write(&t.d, &s, g2, &meta("new", "a", "b"), b"NEW").unwrap();
    // 前の便（g1）の書き込みが遅れて届く → 断る（新しい方を古い方で上書きしない）
    assert_eq!(sessions::write(&t.d, &s, g1, &meta("old", "a", "b"), b"OLD").unwrap_err(), Refusal(code::STALE_GENERATION));
    assert!(sessions::read(&t.d, &s).unwrap().ends_with(b"NEW"));
    // 消す（g4）→ その前に始まっていた便（g3＝最後に受けた書き込みより新しく、消すより古い）の書き込みが遅れて届く → 断る
    //  （消した世代で床を上げていないと、ここで書けてしまい消したものが戻る＝わざと壊す試し M10c）
    sessions::delete(&t.d, &s, g4).unwrap();
    assert_eq!(sessions::write(&t.d, &s, g3, &meta("late", "a", "b"), b"LATE").unwrap_err(), Refusal(code::STALE_GENERATION));
    assert_eq!(sessions::write(&t.d, &s, g2, &meta("late2", "a", "b"), b"LATE").unwrap_err(), Refusal(code::STALE_GENERATION));
    assert!(sessions::read(&t.d, &s).unwrap().is_empty(), "消したものが戻った");
    // 復元したセッションの新しい書き込み（g6）は受ける → その前に始まっていた消すこと（g5・g4 の再送）が遅れて届いても消さない
    sessions::write(&t.d, &s, g6, &meta("restored", "a", "b"), b"RESTORED").unwrap();
    assert_eq!(sessions::delete(&t.d, &s, g5).unwrap_err(), Refusal(code::STALE_GENERATION));
    assert_eq!(sessions::delete(&t.d, &s, g4).unwrap_err(), Refusal(code::STALE_GENERATION));
    assert!(sessions::read(&t.d, &s).unwrap().ends_with(b"RESTORED"), "新しい書き込みを消した");
    // 同じ世代は 2 度受けない・新しい世代は受ける
    assert_eq!(sessions::write(&t.d, &s, g6, &meta("again", "a", "b"), b"AGAIN").unwrap_err(), Refusal(code::STALE_GENERATION));
    sessions::write(&t.d, &s, g7, &meta("next", "a", "b"), b"NEXT").unwrap();
    assert!(sessions::read(&t.d, &s).unwrap().ends_with(b"NEXT"));
}

/// ★床と同じ世代は、書き込みも消すことも断る（同じ便が 2 度届いても 2 度目は受けない）
#[test]
fn same_generation_is_refused_for_write_and_delete() {
    let t = T::new("gensame");
    let s = sid(25);
    let g = sessions::next_gen();
    sessions::write(&t.d, &s, g, &meta("x", "a", "b"), b"KEEP").unwrap();
    assert_eq!(sessions::delete(&t.d, &s, g).unwrap_err(), Refusal(code::STALE_GENERATION), "床と同じ世代の消すことを受けた");
    assert!(sessions::read(&t.d, &s).unwrap().ends_with(b"KEEP"));
    let g2 = sessions::next_gen();
    sessions::delete(&t.d, &s, g2).unwrap();
    assert_eq!(sessions::delete(&t.d, &s, g2).unwrap_err(), Refusal(code::STALE_GENERATION));
    assert_eq!(sessions::write(&t.d, &s, g2, &meta("y", "a", "b"), b"BACK").unwrap_err(), Refusal(code::STALE_GENERATION));
    assert!(sessions::read(&t.d, &s).unwrap().is_empty());
}

/// ★書けなかった書き込み（世代の確かめは通った）も床を上げる: そのあとに届いた、それより古い世代の書き込みは断る
#[test]
fn generation_floor_rises_on_failed_write() {
    let t = T::new("genfail");
    let s = sid(21);
    let (g1, g2) = (sessions::next_gen(), sessions::next_gen());
    // 置き場のフォルダの名前にファイル（作れない＝書けない）
    fs::create_dir_all(t.d.sessions.parent().unwrap()).unwrap();
    fs::write(&t.d.sessions, b"not a dir").unwrap();
    let e = sessions::write(&t.d, &s, g2, &meta("x", "a", "b"), b"NEW").unwrap_err();
    assert_ne!(e, Refusal(code::STALE_GENERATION), "書けないこと自体を古い世代と取り違えた");
    fs::remove_file(&t.d.sessions).unwrap();
    assert_eq!(sessions::write(&t.d, &s, g1, &meta("old", "a", "b"), b"OLD").unwrap_err(), Refusal(code::STALE_GENERATION));
    assert!(sessions::read(&t.d, &s).unwrap().is_empty());
}

/// ★床を取る（復元したセッションが最初に）: ファイルには触らず、それより古い世代の書き込みも消すことも断る。同じ世代は 2 度取れない
#[test]
fn claim_raises_floor_without_touching_files() {
    let t = T::new("claim");
    let s = sid(22);
    let (g1, g2, g3, g4) = (sessions::next_gen(), sessions::next_gen(), sessions::next_gen(), sessions::next_gen());
    sessions::write(&t.d, &s, g1, &meta("restored", "a", "b"), b"KEEP").unwrap();
    let before = fs::read(t.d.sessions.join(format!("{s}.asv"))).unwrap();
    sessions::claim(&s, g3).unwrap();
    assert_eq!(fs::read(t.d.sessions.join(format!("{s}.asv"))).unwrap(), before, "床を取ってファイルを変えた");
    // 読み込み直しの前の部品の遅れた消すこと・書き込み（g2）は断る
    assert_eq!(sessions::delete(&t.d, &s, g2).unwrap_err(), Refusal(code::STALE_GENERATION));
    assert_eq!(sessions::write(&t.d, &s, g2, &meta("late", "a", "b"), b"LATE").unwrap_err(), Refusal(code::STALE_GENERATION));
    assert!(sessions::read(&t.d, &s).unwrap().ends_with(b"KEEP"), "復元したオートセーブが消えた");
    assert_eq!(sessions::claim(&s, g3).unwrap_err(), Refusal(code::STALE_GENERATION));
    assert_eq!(sessions::claim("../x", g4).unwrap_err(), Refusal(code::BAD_SESSION));
    sessions::write(&t.d, &s, g4, &meta("next", "a", "b"), b"NEXT").unwrap();
    assert!(sessions::read(&t.d, &s).unwrap().ends_with(b"NEXT"));
}

/// ★印が JSON の物でない（null・配列・数）本体は読めないものとして控えへ進む（一覧にも読むにも出さない・消さない）
#[test]
fn non_object_meta_is_unreadable() {
    let t = T::new("metanull");
    fs::create_dir_all(&t.d.sessions).unwrap();
    let a = sid(26);
    fs::write(t.d.sessions.join(format!("{a}.asv")), b"AMAS1\nnull\nBODY").unwrap();
    fs::write(t.d.sessions.join(format!("{a}.asv.bak")), b"AMAS1\n{\"title\":\"B\"}\nBAK").unwrap();
    let l = sessions::list(&t.d);
    let e = l.iter().find(|e| e.session == a).expect("控えが一覧に無い");
    assert_eq!((e.from.as_str(), e.meta["title"].clone()), ("bak", serde_json::json!("B")));
    assert!(sessions::read(&t.d, &a).unwrap().ends_with(b"BAK"));
    for (n, body) in [(27u8, b"AMAS1\n[1,2]\nX".as_ref()), (28, b"AMAS1\n7\nX".as_ref()), (29, b"AMAS1\nnull\nX".as_ref())] {
        let s = sid(n);
        fs::write(t.d.sessions.join(format!("{s}.asv")), body).unwrap();
        assert!(!sessions::list(&t.d).iter().any(|e| e.session == s), "物でない印を一覧に出した");
        assert!(sessions::read(&t.d, &s).unwrap().is_empty());
        assert!(t.d.sessions.join(format!("{s}.asv")).is_file(), "読めないものを消した");
    }
}

/// ★一覧は印の行だけを読む（作品の部分が壊れていても・大きくても出る）。印が長すぎるものは出さず消さない
#[test]
fn list_reads_only_the_meta_line() {
    let t = T::new("listhead");
    fs::create_dir_all(&t.d.sessions).unwrap();
    let s = sid(23);
    let mut body = b"AMAS1\n{\"title\":\"H\"}\n".to_vec();
    body.extend(vec![0xA5u8; 3 << 20]);
    fs::write(t.d.sessions.join(format!("{s}.asv")), &body).unwrap();
    let l = sessions::list(&t.d);
    assert_eq!(l.iter().find(|e| e.session == s).map(|e| e.meta["title"].clone()), Some(serde_json::json!("H")));
    let long = sid(24);
    let mut lb = b"AMAS1\n{\"t\":\"".to_vec();
    lb.extend(vec![b'x'; 2 << 20]);
    lb.extend_from_slice(b"\"}\nD");
    fs::write(t.d.sessions.join(format!("{long}.asv")), &lb).unwrap();
    assert!(!sessions::list(&t.d).iter().any(|e| e.session == long));
    assert!(t.d.sessions.join(format!("{long}.asv")).is_file());
}

/// ★鍵: 同じ番号への書き込みと消すことを同時に走らせても、世代の確かめと書く・消すは鍵の中で続けて（世代の大きいほうが最後に残る）
#[test]
fn generation_check_and_write_are_atomic() {
    let t = T::new("genlock");
    let s = sid(7);
    let d = t.d.clone();
    let mut hs = Vec::new();
    let gens: Vec<u64> = (0..40).map(|_| sessions::next_gen()).collect();
    for (i, g) in gens.iter().copied().enumerate() {
        let d = d.clone();
        let s = s.clone();
        hs.push(std::thread::spawn(move || {
            if i % 3 == 2 {
                let _ = sessions::delete(&d, &s, g);
            } else {
                let _ = sessions::write(&d, &s, g, &meta(&format!("{g}"), "a", "b"), format!("G{g}").as_bytes());
            }
            (i, g)
        }));
    }
    for h in hs {
        h.join().unwrap();
    }
    // 最後に残るのは、受けた最大の世代の書き込み（それより大きい世代の消すことが無ければ）
    let last = *gens.last().unwrap();
    let env = sessions::read(&t.d, &s).unwrap();
    let last_is_delete = (gens.len() - 1) % 3 == 2;
    if last_is_delete {
        assert!(env.is_empty());
    } else {
        assert!(env.ends_with(format!("G{last}").as_bytes()), "最後の世代の書き込みが残っていない");
    }
}

/// ★印を直す（作品の名前を変える・移す・アルバムの名前を変える）。今あるファイルだけ（消した番号を作り直さない）
#[test]
fn retarget_sessions() {
    let t = T::new("retarget");
    let a = t.album("A");
    t.album("B");
    fs::write(a.join("w.memoanima"), b"W").unwrap();
    fs::write(a.join("w.memoanima.png"), b"P").unwrap();
    fs::write(a.join("w.memoanima.bak"), b"K").unwrap();
    let s1 = sid(11);
    let s2 = sid(12);
    let s3 = sid(13);
    sessions::write(&t.d, &s1, sessions::next_gen(), &meta("w", "A", "w.memoanima"), b"1").unwrap();
    sessions::write(&t.d, &s2, sessions::next_gen(), &meta("other", "A", "x.memoanima"), b"2").unwrap();
    sessions::write(&t.d, &s3, sessions::next_gen(), &meta("w", "A", "w.memoanima"), b"3").unwrap();
    sessions::delete(&t.d, &s3, sessions::next_gen()).unwrap();
    // 名前を変える
    let p = ops::rename_work(&t.d, "A", "w.memoanima", "新しい").unwrap();
    assert_eq!(p.name, "新しい.memoanima");
    assert_eq!(names_in(&a), vec!["新しい.memoanima", "新しい.memoanima.bak", "新しい.memoanima.png"]);
    let m = |s: &str| sessions::list(&t.d).into_iter().find(|e| e.session == s).map(|e| e.meta);
    assert_eq!(m(&s1).unwrap()["name"], "新しい.memoanima");
    assert_eq!(m(&s2).unwrap()["name"], "x.memoanima", "他の作品の印を直した");
    assert!(m(&s3).is_none(), "消した番号を作り直した");
    // 移す
    let p = ops::move_work(&t.d, "A", "新しい.memoanima", "B").unwrap();
    assert_eq!((p.album.as_str(), p.name.as_str()), ("B", "新しい.memoanima"));
    assert_eq!(m(&s1).unwrap()["album"], "B");
    assert_eq!(names_in(&t.d.lib.join("B")), vec!["新しい.memoanima", "新しい.memoanima.bak", "新しい.memoanima.png"]);
    assert!(names_in(&a).is_empty());
    // アルバムの名前を変える
    let p = ops::rename_album(&t.d, "B", "ビー").unwrap();
    assert_eq!(p.album, "ビー");
    assert_eq!(m(&s1).unwrap()["album"], "ビー");
    assert_eq!(m(&s1).unwrap()["name"], "新しい.memoanima");
    assert_eq!(m(&s2).unwrap()["album"], "A");
}

// =====================================================================
// 名前を変える・移す・アルバム（A6・A7）
// =====================================================================

/// ★動かす途中で失敗したら、動かした分を戻す（本体・サムネ・控えがばらばらのアルバム・名前に分かれない）
#[test]
fn move_failure_rolls_back() {
    let t = T::new("moveroll");
    let a = t.album("A");
    let b = t.album("B");
    for (n, c) in [("w.memoanima", "W"), ("w.memoanima.png", "P"), ("w.memoanima.bak", "K")] {
        fs::write(a.join(n), c).unwrap();
    }
    // 名前を変える先のサムネの名前にフォルダ（消せない・置けない）
    fs::create_dir(a.join("x.memoanima.png")).unwrap();
    assert!(ops::rename_work(&t.d, "A", "w.memoanima", "x").is_err());
    assert_eq!(names_in(&a), vec!["w.memoanima", "w.memoanima.bak", "w.memoanima.png", "x.memoanima.png"], "戻していない");
    // 移す先のサムネの名前にフォルダ
    fs::create_dir(b.join("w.memoanima.png")).unwrap();
    assert!(ops::move_work(&t.d, "A", "w.memoanima", "B").is_err());
    assert_eq!(names_in(&a), vec!["w.memoanima", "w.memoanima.bak", "w.memoanima.png", "x.memoanima.png"], "戻していない");
    assert_eq!(names_in(&b), vec!["w.memoanima.png"]);
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"W");
}

/// ★名前を変える: 使われている名前は断る・自分自身の大小だけの変更は通る（2 手）・表示順のキーも・旧拡張子は拡張子のまま
#[test]
fn rename_work_rules() {
    let t = T::new("rename");
    let a = t.album("A");
    fs::write(a.join("w.memoanima"), b"W").unwrap();
    fs::write(a.join("w.memoanima.png"), b"P").unwrap();
    fs::write(a.join("Other.memoanima.bak"), b"O").unwrap();
    fs::write(a.join("old.animemo"), b"L").unwrap();
    // 表示順のキー
    let mut idx = crate::pclib::LibraryIndex { version: 1, ..Default::default() };
    idx.project_order.insert("A/w.memoanima".into(), 5);
    crate::pclib::save_index(&t.d.lib, &idx).unwrap();
    assert_eq!(ops::rename_work(&t.d, "A", "w.memoanima", "OTHER").unwrap_err(), Refusal(code::NAME_TAKEN), "控えだけの名前も使われている");
    assert_eq!(ops::rename_work(&t.d, "A", "w.memoanima", "OLD").unwrap_err(), Refusal(code::NAME_TAKEN));
    let p = ops::rename_work(&t.d, "A", "w.memoanima", "W").unwrap();
    assert_eq!(p.name, "W.memoanima", "大小だけの変更");
    assert_eq!(names_in(&a), vec!["Other.memoanima.bak", "W.memoanima", "W.memoanima.png", "old.animemo"]);
    let idx = crate::pclib::load_index(&t.d.lib).unwrap();
    assert_eq!(idx.project_order.get("A/W.memoanima"), Some(&5));
    assert!(!idx.project_order.contains_key("A/w.memoanima"));
    let p = ops::rename_work(&t.d, "A", "old.animemo", "旧").unwrap();
    assert_eq!(p.name, "旧.animemo", "旧拡張子は拡張子のまま");
    assert_eq!(ops::rename_work(&t.d, "A", "none.memoanima", "x").unwrap_err(), Refusal(code::TARGET_MISSING));
    assert_eq!(ops::rename_work(&t.d, "A", "W.memoanima", &"あ".repeat(70)).unwrap_err(), Refusal(code::NAME_TOO_LONG));
    // NFD の名前を NFC の同じ名前へ（自分自身）
    fs::write(a.join("\u{304b}\u{3099}.memoanima"), b"G").unwrap();
    let p = ops::rename_work(&t.d, "A", "\u{304b}\u{3099}.memoanima", "\u{304c}").unwrap();
    assert_eq!(p.name, "\u{304c}.memoanima");
    assert_eq!(fs::read(a.join("\u{304c}.memoanima")).unwrap(), b"G");
    // V211 (§15): APFS は NFC と NFD を同じ名前として引く＝exists() でなく read_dir の実の名前で見る
    assert!(!names_in(&a).contains(&"\u{304b}\u{3099}.memoanima".to_string()), "NFD の名前が残った");
    assert!(names_in(&a).contains(&"\u{304c}.memoanima".to_string()), "NFC の名前になっていない");
}

/// ★移す: 移した先に使われている名前（大小・NFC・控えだけ）があれば PC と同じ付け方で空いている名前（断らない）。本体・サムネ・控え・表示順
#[test]
fn move_work_rules() {
    let t = T::new("move");
    let a = t.album("A");
    let b = t.album("B");
    fs::write(a.join("w.memoanima"), b"W").unwrap();
    fs::write(a.join("w.memoanima.bak"), b"K").unwrap();
    fs::write(a.join("w.memoanima.png"), b"P").unwrap();
    fs::write(b.join("W.MEMOANIMA.bak"), b"THEIRS").unwrap();
    fs::write(b.join("w-1.memoanima.png"), b"ORPHAN").unwrap();
    let p = ops::move_work(&t.d, "A", "w.memoanima", "B").unwrap();
    assert_eq!(p.name, "w-1.memoanima", "控えだけの名前（大小違い）を避ける");
    assert_eq!(names_in(&b), vec!["W.MEMOANIMA.bak", "w-1.memoanima", "w-1.memoanima.bak", "w-1.memoanima.png"]);
    assert_eq!(fs::read(b.join("W.MEMOANIMA.bak")).unwrap(), b"THEIRS", "移した先の控えを置き換えた");
    assert_eq!(fs::read(b.join("w-1.memoanima.png")).unwrap(), b"P", "サムネだけの名前は新しいサムネに");
    assert!(names_in(&a).is_empty());
    assert_eq!(ops::move_work(&t.d, "B", "w-1.memoanima", "Z").unwrap_err(), Refusal(code::ALBUM_MISSING));
    assert!(!t.d.lib.join("Z").exists(), "移した先のアルバムを作った");
}

/// ★アルバム: 作る（大小・NFC で同じ名前は断る・予約名に _）・名前を変える（索引の行と表示順・大小だけの変更は 2 手）
#[test]
fn album_rules() {
    let t = T::new("album");
    t.album("Photos");
    assert_eq!(ops::create_album(&t.d, "PHOTOS").unwrap_err(), Refusal(code::NAME_TAKEN));
    assert_eq!(ops::create_album(&t.d, "CON").unwrap().album, "CON_");
    assert_eq!(ops::create_album(&t.d, "\u{304b}\u{3099}").unwrap().album, "\u{304c}", "新しい名前は NFC");
    assert_eq!(ops::create_album(&t.d, "\u{304c}").unwrap_err(), Refusal(code::NAME_TAKEN));
    let p = t.d.lib.join("Photos");
    fs::write(p.join("x.memoanima"), b"X").unwrap();
    fs::write(p.join("n.kwz"), b"K").unwrap();
    let mut idx = crate::pclib::LibraryIndex { version: 1, ..Default::default() };
    idx.items.push(crate::pclib::LibraryItem { hash: "h".into(), album: "Photos".into(), name: "n.kwz".into(), ext: "kwz".into(), size: 1, rel_path: "Photos/n.kwz".into(), imported_at: 0, order: 0 });
    idx.project_order.insert("Photos/x.memoanima".into(), 3);
    crate::pclib::save_index(&t.d.lib, &idx).unwrap();
    assert_eq!(ops::rename_album(&t.d, "Photos", "CON_").unwrap_err(), Refusal(code::NAME_TAKEN));
    let r = ops::rename_album(&t.d, "Photos", "photos").unwrap();
    assert_eq!(r.album, "photos", "大小だけの変更");
    let idx = crate::pclib::load_index(&t.d.lib).unwrap();
    assert_eq!(idx.items[0].rel_path, "photos/n.kwz");
    assert_eq!(idx.project_order.get("photos/x.memoanima"), Some(&3));
    assert!(t.d.lib.join("photos").join("x.memoanima").is_file());
    let names: Vec<String> = names_in(&t.d.lib).into_iter().filter(|n| !n.ends_with(".json")).collect();
    assert_eq!(names, vec!["CON_", "photos", "\u{304c}"]);
}

// =====================================================================
// 探す・読む（A5 の③・A8）
// =====================================================================

/// PV6 の器だけを持つ見本（gzip のヘッダ JSON ＋ 塊 ＋ トレーラ）
fn pv6_like(work_id: &str, blob: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let head = serde_json::to_vec(&serde_json::json!({ "magic": "ANIMEMO", "version": 6, "meta": { "title": "t", "workId": work_id } })).unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&head).unwrap();
    let hg = gz.finish().unwrap();
    let mut out = hg.clone();
    out.extend_from_slice(blob);
    out.extend_from_slice(b"AMPV6END");
    out.extend_from_slice(&(hg.len() as u32).to_le_bytes());
    out.extend_from_slice(&(blob.len() as u32).to_le_bytes());
    out
}

/// ★ID はヘッダだけを読む（PV6）・崩れた ID（大文字など）は無いものとして扱う・PV5 と .animemo は指紋だけ・指紋は大きさが同じものだけ
#[test]
fn find_by_id_and_fingerprint() {
    let t = T::new("find");
    let a = t.album("A");
    let b = t.album("B");
    let id = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
    let w1 = pv6_like(id, b"BLOB-1");
    fs::write(a.join("one.memoanima"), &w1).unwrap();
    fs::write(b.join("moved.memoanima"), &w1).unwrap();
    fs::write(b.join("upper.memoanima"), pv6_like(&id.to_uppercase(), b"B2")).unwrap();
    fs::write(b.join("other.memoanima"), pv6_like("00000000-0000-4000-8000-000000000001", b"B3")).unwrap();
    fs::write(b.join("legacy.animemo"), &w1).unwrap();
    fs::write(b.join("one.memoanima.bak"), &w1).unwrap();
    assert_eq!(find::header_work_id(&a.join("one.memoanima")).as_deref(), Some(id));
    assert_eq!(find::header_work_id(&b.join("upper.memoanima")), None, "大文字の ID は無いものとして扱う");
    let r = find::find_works(&t.d, Some(id), None).unwrap();
    assert_eq!(r.iter().map(|f| format!("{}/{}", f.album, f.name)).collect::<Vec<_>>(), vec!["A/one.memoanima", "B/moved.memoanima"], "ID で（.animemo と控えは ID では探さない）");
    assert!(r.iter().all(|f| f.id_match && !f.fingerprint_match));
    let r = find::find_works(&t.d, Some(id), Some(&fp(&w1))).unwrap();
    assert_eq!(r.iter().map(|f| (f.name.clone(), f.id_match, f.fingerprint_match)).collect::<Vec<_>>(), vec![
        ("one.memoanima".to_string(), true, true),
        ("legacy.animemo".to_string(), false, true),
        ("moved.memoanima".to_string(), true, true),
    ]);
    // 崩れた ID で探しても何も見つけない
    assert!(find::find_works(&t.d, Some(&id.to_uppercase()), None).unwrap().is_empty());
}

/// リンク（シンボリックリンク）を作る。検査だけ
#[cfg(unix)]
fn make_dir_link(link: &Path, target: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// ★封じ込め: リンクでライブラリの外を指すアルバムは、探さない（D-L6）・読まない・書かない（locate_album と read_work の確かめ）。
/// Unix だけ（Windows では、署名の無い検査の実行ファイルからはジャンクションを作れない＝30 秒ほど待って「アクセスが拒否されました」。
/// Windows は v202_smoke [L-1] が Node でジャンクションを作り、本物の Rust〔検査の実行ファイル〕に同じことを通させる）
#[cfg(unix)]
#[test]
fn albums_linked_outside_library_are_not_used() {
    let t = T::new("linkout");
    t.album("A");
    let outside = t.base.join("outside");
    fs::create_dir_all(&outside).unwrap();
    let id = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9d";
    let body = pv6_like(id, b"OUT");
    fs::write(outside.join("o.memoanima"), &body).unwrap();
    let link = t.d.lib.join("Link");
    make_dir_link(&link, &outside).expect("リンクを作れない（検査が黙る）");
    assert!(link.join("o.memoanima").is_file(), "リンクの先が見えない（検査が黙る）");
    assert!(find::find_works(&t.d, Some(id), None).unwrap().is_empty(), "ライブラリの外の作品を探した");
    assert!(find::find_works(&t.d, None, Some(&fp(&body))).unwrap().is_empty(), "ライブラリの外の作品を指紋で探した");
    assert_eq!(ops::read_work(&t.d, "Link", "o.memoanima").unwrap_err(), Refusal(code::OUTSIDE), "ライブラリの外を読んだ");
    assert_eq!(save::save_new(&t.d, &new_meta("Link", "n"), b"N", b"", &mut NoHooks).unwrap_err(), Refusal(code::OUTSIDE));
    assert_eq!(save::save_overwrite(&t.d, &ow("Link", "o.memoanima", &body), b"N", b"", &mut NoHooks).unwrap_err(), Refusal(code::OUTSIDE));
    assert_eq!(names_in(&outside), vec!["o.memoanima"], "ライブラリの外に書いた");
    // ライブラリの中のアルバムは探せる（検査が黙っていない）
    fs::write(t.d.lib.join("A").join("in.memoanima"), &body).unwrap();
    assert_eq!(find::find_works(&t.d, Some(id), None).unwrap().iter().map(|f| f.album.clone()).collect::<Vec<_>>(), vec!["A".to_string()]);
    let _ = fs::remove_file(&link);
}

/// ★V211 (V202 §12 の 17・M17): **作品のファイルそのもの**がライブラリの外を指すシンボリックリンクのとき、`read_work` の 2 段目の
/// 封じ込め（canonicalize してライブラリの配下か）で断る。アルバムは本物のライブラリの中＝1 段目（locate_album）は通る形。Unix だけ
#[cfg(unix)]
#[test]
fn work_file_linked_outside_library_is_not_read() {
    let t = T::new("filelinkout");
    let a = t.album("A");
    let outside = t.base.join("outside-file");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.memoanima"), b"OUTSIDE").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.memoanima"), a.join("l.memoanima")).expect("リンクを作れない（検査が黙る）");
    assert_eq!(fs::read(a.join("l.memoanima")).unwrap(), b"OUTSIDE", "リンクの先が読めない（検査が黙る）");
    assert_eq!(ops::read_work(&t.d, "A", "l.memoanima").unwrap_err(), Refusal(code::OUTSIDE), "ライブラリの外のファイルを読んだ");
    // 対照: ライブラリの中を指すリンクは読める（2 段目が何でも断っているのではない）
    fs::write(a.join("in.memoanima"), b"INSIDE").unwrap();
    std::os::unix::fs::symlink(a.join("in.memoanima"), a.join("l2.memoanima")).unwrap();
    assert!(ops::read_work(&t.d, "A", "l2.memoanima").is_ok(), "ライブラリの中を指すリンクまで断った（検査が黙る）");
    let _ = fs::remove_file(a.join("l.memoanima"));
    let _ = fs::remove_file(a.join("l2.memoanima"));
}

/// ★ヘッダを開く上限: 開いたヘッダが上限を超えるものは読まない（細工したファイルで大きく膨らませない）。上限の内なら読む
#[test]
fn header_over_limit_is_not_read() {
    use std::io::Write;
    let t = T::new("headmax");
    let a = t.album("A");
    let id = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9e";
    let head = serde_json::to_vec(&serde_json::json!({ "magic": "ANIMEMO", "version": 6, "meta": { "workId": id }, "pad": "x".repeat(5000) })).unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&head).unwrap();
    let hg = gz.finish().unwrap();
    assert!(hg.len() < 1000, "見本のヘッダが縮んでいない（検査が黙る）");
    let mut body = hg.clone();
    body.extend_from_slice(b"BLOB");
    body.extend_from_slice(b"AMPV6END");
    body.extend_from_slice(&(hg.len() as u32).to_le_bytes());
    body.extend_from_slice(&4u32.to_le_bytes());
    let p = a.join("big-head.memoanima");
    fs::write(&p, &body).unwrap();
    assert_eq!(find::header_work_id_with(&p, 1000).as_deref(), None, "上限を超えて開いたヘッダを読んだ");
    assert_eq!(find::header_work_id_with(&p, 8192).as_deref(), Some(id), "上限の内のヘッダが読めない（検査が黙る）");
    assert_eq!(find::header_work_id(&p).as_deref(), Some(id));
}

/// ★読む: 生のバイト列と指紋（P-3 と同じ封筒）・実の名前・大きさの門番（読む前に弾く）・ライブラリの外は読まない
#[test]
fn read_work_envelope_and_gate() {
    let t = T::new("read");
    let a = t.album("A");
    let data: Vec<u8> = (0..3001u32).map(|i| (i % 256) as u8).collect();
    fs::write(a.join("\u{304b}\u{3099}.memoanima"), &data).unwrap();
    let env = ops::read_work(&t.d, "A", "\u{304c}.memoanima").unwrap();
    let hl = u32::from_le_bytes(env[0..4].try_into().unwrap()) as usize;
    let head: serde_json::Value = serde_json::from_slice(&env[4..4 + hl]).unwrap();
    assert_eq!(head["path"], "\u{304b}\u{3099}.memoanima", "実の名前");
    assert_eq!(head["meta"]["album"], "A");
    assert_eq!(serde_json::from_value::<Fingerprint>(head["meta"]["fingerprint"].clone()).unwrap(), fp(&data));
    assert_eq!(&env[4 + hl..], &data[..]);
    assert_eq!((4 + hl) % 8, 0);
    // 大きさの門番（読む前）: 512MiB を 1 バイト超える
    let big = a.join("big.memoanima");
    fs::File::create(&big).unwrap().set_len(ops::READ_MAX_BYTES + 1).unwrap();
    assert_eq!(ops::read_work(&t.d, "A", "big.memoanima").unwrap_err(), Refusal(code::TOO_LARGE));
    fs::remove_file(&big).unwrap();
    // 外へ出る名前は断る
    fs::write(t.base.join("x.memoanima"), b"OUT").unwrap();
    assert!(ops::read_work(&t.d, "A", "../x.memoanima").is_err());
    assert!(ops::read_work(&t.d, "..", "x.memoanima").is_err());
    assert_eq!(ops::read_work(&t.d, "A", "none.memoanima").unwrap_err(), Refusal(code::TARGET_MISSING));
}

/// 空き容量（ライブラリのボリューム）
#[test]
fn free_space_reports() {
    let t = T::new("free");
    let f = ops::free_space(&t.d).unwrap();
    assert!(f.total > 0 && f.available <= f.total);
}

// =====================================================================
// 検査の口と同じ道を、命令の 1 段（commands.rs）から
// =====================================================================

/// ★命令の 1 段: 生のボディの封筒・args の欄で呼べる（検査用の実行ファイルと同じ dispatch）
#[test]
fn dispatch_same_path() {
    use super::commands::{dispatch, Reply};
    let t = T::new("dispatch");
    t.album("A");
    let pack = |meta: serde_json::Value, parts: &[&[u8]]| {
        let m = serde_json::to_vec(&meta).unwrap();
        let mut b = (m.len() as u32).to_le_bytes().to_vec();
        b.extend_from_slice(&m);
        for p in parts {
            b.extend_from_slice(&(p.len() as u32).to_le_bytes());
            b.extend_from_slice(p);
        }
        b
    };
    let body = pack(serde_json::json!({ "album": "A", "name": "作品", "selfName": null }), &[b"DATA", b"PNG"]);
    let r = match dispatch(&t.d, "mobile_save_new", &serde_json::Value::Null, &body, &mut NoHooks).unwrap() {
        Reply::Json(v) => v,
        Reply::Raw(_) => panic!(),
    };
    assert_eq!(r["name"], "作品.memoanima");
    assert_eq!(r["fingerprint"]["size"], 4);
    let env = match dispatch(&t.d, "mobile_read_work", &serde_json::json!({ "args": { "album": "A", "name": "作品.memoanima" } }), &[], &mut NoHooks).unwrap() {
        Reply::Raw(b) => b,
        Reply::Json(_) => panic!(),
    };
    assert!(env.ends_with(b"DATA"));
    // 欄の名前を snake_case にした（JS から見た名前でない）引数は断る
    assert_eq!(
        dispatch(&t.d, "mobile_move_work", &serde_json::json!({ "args": { "album": "A", "name": "作品.memoanima", "dest_album": "B" } }), &[], &mut NoHooks).err(),
        Some(code::BAD_REQUEST.to_string())
    );
    assert_eq!(dispatch(&t.d, "nope", &serde_json::Value::Null, &[], &mut NoHooks).err(), Some("unknown-command".to_string()));
    // 封筒の形が違う
    assert_eq!(dispatch(&t.d, "mobile_save_new", &serde_json::Value::Null, b"xx", &mut NoHooks).err(), Some(code::BAD_REQUEST.to_string()));
}

/// 断りの値と、ログにパス・作品名を入れない（W-10）
#[test]
fn refusals_carry_no_paths() {
    let t = T::new("w10");
    t.album("A");
    let e = save::save_overwrite(&t.d, &ow("A", "秘密の作品.memoanima", b"x"), b"y", b"", &mut NoHooks).unwrap_err();
    assert!(code::ALL.contains(&e.0));
    let _ = sessions::list(&t.d);
    let r = Record::begin(&t.d, "Gone", "秘密の作品.memoanima", &fp(b"x"), &fp(b"y")).unwrap();
    r.make_work_dir().unwrap();
    fs::write(r.work_file(), b"x").unwrap();
    let _g = crate::pclib::lock_lib();
    let _ = evac::resume_all(&t.d, &mut NoHooks);
    drop(_g);
    let log = fs::read_to_string(t.d.logs.join("memoanima.log")).unwrap_or_default();
    assert!(!log.contains("秘密") && !log.contains(&t.base.to_string_lossy().to_string()), "{log}");
    assert!(log.contains("[V202]"), "ログの行が無い（検査が黙る）");
}
