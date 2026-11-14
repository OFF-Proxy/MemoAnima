//! V224 (M-2c): ライブラリの命令の単体テスト（%TEMP% の下の本物のファイル。作者の設定・ライブラリ・オートセーブには届かない）。
//! 指示書 ■7 の 1 つ目: 命令ごとの通る道と断る道・L-3 の PC との比べ・退避の記録が残っているときの断り・L-4 の 2 つの断り・
//! L-5 の置き換えない置き方（見たあとに外で置かれた場合を検査の口でまねる）・サムネの大きさと PNG の頭・PV5 で丸ごと開かない・
//! 試験用のライブラリを開いている間に本物へ届かない。`scripts/v224_smoke.ts` が `cargo test --lib` で回す

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::evac::Record;
use super::fingerprint::Fingerprint;
use super::library::{self, AlbumContents};
use super::save::{Hooks, NoHooks, Stage, StageCtx, Step};
use super::{code, commands, Dirs, Refusal};
use crate::pclib::{load_index, save_index, LibraryIndex};

static N: AtomicU64 = AtomicU64::new(0);

struct T {
    base: PathBuf,
    d: Dirs,
}
impl T {
    fn new(tag: &str) -> T {
        let base = std::env::temp_dir().join(format!("v224-lib-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
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

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nIHDRxxxx";

fn b64(b: &[u8]) -> String {
    super::chunks::b64_encode(b)
}

/// フォルダの中を全部（相対パス → 中身）。フォルダは中身 None
fn tree(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    fn walk(root: &Path, p: &Path, out: &mut BTreeMap<String, Option<Vec<u8>>>) {
        let Ok(rd) = fs::read_dir(p) else { return };
        for e in rd.flatten() {
            let path = e.path();
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                out.insert(rel, None);
                walk(root, &path, out);
            } else {
                out.insert(rel, Some(fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn set_order(lib: &Path, pairs: &[(&str, u32)]) {
    let mut idx = load_index(lib).unwrap_or_default();
    for (k, v) in pairs {
        idx.project_order.insert(k.to_string(), *v);
    }
    save_index(lib, &idx).unwrap();
}

fn index_json(lib: &Path) -> serde_json::Value {
    let idx: LibraryIndex = load_index(lib).unwrap();
    serde_json::to_value(&idx).unwrap()
}

/// PV6 の器だけ（ヘッダの gzip ＋塊 ＋トレーラ）を作る
fn pv6_bytes(header: &serde_json::Value, blobs: &[u8]) -> Vec<u8> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(serde_json::to_vec(header).unwrap().as_slice()).unwrap();
    let hgz = gz.finish().unwrap();
    let mut out = hgz.clone();
    out.extend_from_slice(blobs);
    out.extend_from_slice(b"AMPV6END");
    out.extend_from_slice(&(hgz.len() as u32).to_le_bytes());
    out.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    out
}

/// 再開の途中（本体へ戻す直前）でアルバムをよそへ動かす＝戻せずに「待ち」が残る（記録が片付かない形をまねる）
struct MoveAlbumAway {
    to: Option<(PathBuf, PathBuf)>,
}
impl Hooks for MoveAlbumAway {
    fn at(&mut self, s: Stage, c: &StageCtx) -> Step {
        if s == Stage::ResumeBeforeRestore && self.to.is_none() {
            let away = c.dir.with_file_name("away");
            fs::rename(c.dir, &away).unwrap();
            self.to = Some((away, c.dir.to_path_buf()));
        }
        Step::Go
    }
}
impl MoveAlbumAway {
    fn put_back(&mut self) {
        if let Some((a, b)) = self.to.take() {
            fs::rename(a, b).unwrap();
        }
    }
}

/// 退避先に、本体の前の版が残っている記録（本体が無い＝再開すると本体へ戻す形）
fn evac_record(t: &T, album: &str, name: &str, content: &[u8]) -> Record {
    let r = Record::begin(&t.d, album, name, &Fingerprint::of_bytes(content), &Fingerprint::of_bytes(b"NEW")).unwrap();
    r.make_work_dir().unwrap();
    fs::write(r.work_file(), content).unwrap();
    r
}

// ---------------- 一覧・印 ----------------

#[test]
fn list_returns_works_only_without_paths() {
    let t = T::new("list");
    let a = t.album("A");
    t.album("B");
    fs::write(a.join("w.memoanima"), b"W").unwrap();
    fs::write(a.join("w.memoanima.png"), PNG).unwrap();
    fs::write(a.join("old.animemo"), b"O").unwrap();
    fs::write(a.join("n.kwz"), b"K").unwrap();
    fs::write(a.join("x.memoanima.bak"), b"B").unwrap();
    set_order(&t.d.lib, &[("A/w.memoanima", 4)]);
    let l = commands::none_library_list(&t.d).unwrap();
    assert_eq!(l.albums, vec!["A".to_string(), "B".to_string()]);
    let mut names: Vec<(String, u32, bool)> = l.works.iter().map(|w| (w.name.clone(), w.order, w.thumb)).collect();
    names.sort();
    assert_eq!(names, vec![("old.animemo".into(), 0, false), ("w.memoanima".into(), 4, true)]);
    assert!(l.works.iter().all(|w| w.album == "A" && w.sorted_at > 0));
    let js = serde_json::to_string(&l).unwrap();
    let lib_s = t.d.lib.to_string_lossy().replace('\\', "\\\\");
    assert!(!js.contains(&lib_s) && !js.contains("path"), "絶対パスを返した: {js}");
    // ライブラリが無い
    let gone = Dirs::under(t.base.join("nolib"), &t.base.join("config"));
    assert_eq!(commands::none_library_list(&gone).unwrap_err(), Refusal(code::TARGET_MISSING));
    assert_eq!(commands::none_library_stamp(&gone).unwrap_err(), Refusal(code::TARGET_MISSING));
}

#[test]
fn stamp_is_pc_stamp_and_moves() {
    let t = T::new("stamp");
    let a = t.album("A");
    fs::write(a.join("w.memoanima"), b"W").unwrap();
    let s1 = commands::none_library_stamp(&t.d).unwrap();
    assert_eq!(s1, crate::pclib::library_stamp(t.d.lib.to_str().unwrap()).unwrap());
    fs::write(a.join("w.memoanima.png"), PNG).unwrap();
    assert_eq!(commands::none_library_stamp(&t.d).unwrap(), s1, "サムネで印が動いた");
    fs::write(a.join("v.memoanima"), b"V").unwrap();
    assert_ne!(commands::none_library_stamp(&t.d).unwrap(), s1);
}

// ---------------- サムネ ----------------

#[test]
fn thumb_read_and_write() {
    let t = T::new("thumb");
    let a = t.album("A");
    fs::write(a.join("w.memoanima"), b"W").unwrap();
    let wa = |n: &str| commands::WorkArgs { album: "A".into(), name: n.into() };
    assert_eq!(commands::args_thumb_read(&t.d, &wa("w.memoanima")).unwrap_err(), Refusal(code::TARGET_MISSING));
    // 書く
    let tw = |n: &str, png: &str| super::library::ThumbWriteArgs { album: "A".into(), name: n.into(), png: png.into() };
    commands::args_thumb_write(&t.d, &tw("w.memoanima", &b64(PNG))).unwrap();
    assert_eq!(fs::read(a.join("w.memoanima.png")).unwrap(), PNG);
    assert_eq!(commands::args_thumb_read(&t.d, &wa("w.memoanima")).unwrap(), PNG);
    // 大小だけ違う名前でも実の名前の隣を読む
    assert_eq!(commands::args_thumb_read(&t.d, &wa("W.MEMOANIMA")).unwrap(), PNG);
    // 断る: PNG でない・空・壊れた base64・1MiB を超える・作品が無い・名前が違う
    assert_eq!(commands::args_thumb_write(&t.d, &tw("w.memoanima", &b64(b"GIF89a....."))).unwrap_err(), Refusal(code::BAD_REQUEST));
    assert_eq!(commands::args_thumb_write(&t.d, &tw("w.memoanima", "")).unwrap_err(), Refusal(code::BAD_REQUEST));
    assert_eq!(commands::args_thumb_write(&t.d, &tw("w.memoanima", "@@@=")).unwrap_err(), Refusal(code::BAD_REQUEST));
    let mut big = PNG.to_vec();
    big.resize(library::THUMB_WRITE_MAX + 1, 0);
    assert_eq!(commands::args_thumb_write(&t.d, &tw("w.memoanima", &b64(&big))).unwrap_err(), Refusal(code::TOO_LARGE));
    let mut edge = PNG.to_vec();
    edge.resize(library::THUMB_WRITE_MAX, 0);
    commands::args_thumb_write(&t.d, &tw("w.memoanima", &b64(&edge))).unwrap();
    assert_eq!(commands::args_thumb_write(&t.d, &tw("nope.memoanima", &b64(PNG))).unwrap_err(), Refusal(code::TARGET_MISSING));
    assert!(!a.join("nope.memoanima.png").exists(), "作品が無いのにサムネを書いた");
    assert_eq!(commands::args_thumb_write(&t.d, &tw("../x.memoanima", &b64(PNG))).unwrap_err(), Refusal(code::BAD_NAME));
    assert_eq!(commands::args_thumb_write(&t.d, &tw("w.png", &b64(PNG))).unwrap_err(), Refusal(code::BAD_NAME));
    // 読む: 4MiB を超えるサムネは読まない
    fs::write(a.join("w.memoanima.png"), vec![0u8; (library::THUMB_READ_MAX + 1) as usize]).unwrap();
    assert_eq!(commands::args_thumb_read(&t.d, &wa("w.memoanima")).unwrap_err(), Refusal(code::TOO_LARGE));
    // 作品が無いサムネだけは読まない
    fs::write(a.join("orphan.memoanima.png"), PNG).unwrap();
    assert_eq!(commands::args_thumb_read(&t.d, &wa("orphan.memoanima")).unwrap_err(), Refusal(code::TARGET_MISSING));
}

// ---------------- ヘッダだけを読む ----------------

#[test]
fn peek_reads_pv6_header_only() {
    let t = T::new("peek");
    let a = t.album("A");
    let id = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
    let head = serde_json::json!({ "magic": "ANIMEMO", "version": 6, "speedIndex": 5, "meta": { "workId": id }, "frames": [{}, {}, {}], "blobs": [] });
    fs::write(a.join("w.memoanima"), pv6_bytes(&head, b"BLOBS")).unwrap();
    let wa = |n: &str| commands::WorkArgs { album: "A".into(), name: n.into() };
    let p = commands::args_work_peek(&t.d, &wa("w.memoanima")).unwrap();
    assert_eq!((p.work_id.as_deref(), p.frames, p.speed_index), (Some(id), Some(3), Some(5)));
    // 崩れた ID は null（ほかは読む）
    let bad = serde_json::json!({ "speedIndex": 2, "meta": { "workId": "NOT-AN-ID" }, "frames": [{}] });
    fs::write(a.join("b.memoanima"), pv6_bytes(&bad, b"")).unwrap();
    let p = commands::args_work_peek(&t.d, &wa("b.memoanima")).unwrap();
    assert_eq!((p.work_id, p.frames, p.speed_index), (None, Some(1), Some(2)));
    // PV5（gzip の JSON）・旧拡張子・壊れたファイル: 丸ごと開かず全部 null（断らない）
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(br#"{"magic":"ANIMEMO","version":5,"speedIndex":4,"meta":{"workId":"3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c"},"frames":[{}]}"#).unwrap();
    let pv5 = gz.finish().unwrap();
    fs::write(a.join("v5.memoanima"), &pv5).unwrap();
    fs::write(a.join("old.animemo"), pv6_bytes(&head, b"")).unwrap();
    fs::write(a.join("junk.memoanima"), b"not a work at all").unwrap();
    for n in ["v5.memoanima", "old.animemo", "junk.memoanima"] {
        let p = commands::args_work_peek(&t.d, &wa(n)).unwrap();
        assert_eq!((p.work_id, p.frames, p.speed_index), (None, None, None), "{n}");
    }
    assert_eq!(commands::args_work_peek(&t.d, &wa("none.memoanima")).unwrap_err(), Refusal(code::TARGET_MISSING));
}

// ---------------- 作品を消す（L-3） ----------------

/// 同じ置き場を 2 つ作る（本体・サムネ・控え・PC の形の一時ファイル・ほかの作品・表示順のキー）
fn seed_for_delete(lib: &Path) {
    let a = lib.join("A");
    fs::create_dir_all(&a).unwrap();
    fs::write(a.join("w.memoanima"), b"W").unwrap();
    fs::write(a.join("w.memoanima.png"), PNG).unwrap();
    fs::write(a.join("w.memoanima.bak"), b"W0").unwrap();
    fs::write(a.join("w.memoanima.1700000000-3.tmp"), b"T").unwrap();
    fs::write(a.join("w.memoanima.7.tmp"), b"T2").unwrap();
    fs::write(a.join("w.memoanima.note.tmp"), b"keep").unwrap();
    fs::write(a.join("other.memoanima"), b"O").unwrap();
    fs::write(a.join("other.memoanima.bak"), b"O0").unwrap();
    set_order(lib, &[("A/w.memoanima", 3), ("A/other.memoanima", 1)]);
}

#[test]
fn delete_work_matches_pc_delete_item() {
    let pc = T::new("del-pc");
    let mb = T::new("del-mb");
    seed_for_delete(&pc.d.lib);
    seed_for_delete(&mb.d.lib);
    crate::pclib::delete_item(pc.d.lib.to_str().unwrap(), "", "A", "w.memoanima").unwrap();
    commands::args_delete_work(&mb.d, &commands::WorkArgs { album: "A".into(), name: "w.memoanima".into() }).unwrap();
    assert_eq!(tree(&mb.d.lib), tree(&pc.d.lib), "残ったファイル");
    assert_eq!(index_json(&mb.d.lib), index_json(&pc.d.lib), "索引");
    let left: Vec<String> = tree(&mb.d.lib).keys().cloned().collect();
    assert!(left.contains(&"A/w.memoanima.note.tmp".to_string()) && left.contains(&"A/other.memoanima.bak".to_string()));
    // もう無い → target-missing
    assert_eq!(commands::args_delete_work(&mb.d, &commands::WorkArgs { album: "A".into(), name: "w.memoanima".into() }).unwrap_err(), Refusal(code::TARGET_MISSING));
}

#[test]
fn delete_work_uses_real_name_and_keeps_autosave() {
    let t = T::new("del-real");
    seed_for_delete(&t.d.lib);
    // 開いた作品ごとのオートセーブ（消さない）
    fs::create_dir_all(&t.d.sessions).unwrap();
    fs::write(t.d.sessions.join("0123456789abcdef0123456789abcdef.asv"), b"AMAS1").unwrap();
    let before_sessions = tree(&t.d.sessions);
    // 大小だけ違う名前で消す → 実の名前のキーと控えも消える
    commands::args_delete_work(&t.d, &commands::WorkArgs { album: "a".into(), name: "W.MEMOANIMA".into() }).unwrap();
    let a = t.d.lib.join("A");
    for f in ["w.memoanima", "w.memoanima.png", "w.memoanima.bak"] {
        assert!(!a.join(f).exists(), "{f} が残った");
    }
    assert!(!load_index(&t.d.lib).unwrap().project_order.contains_key("A/w.memoanima"), "表示順のキーが残った");
    assert_eq!(tree(&t.d.sessions), before_sessions, "オートセーブを消した");
    // 断る: アルバムが無い・名前が違う
    assert_eq!(commands::args_delete_work(&t.d, &commands::WorkArgs { album: "Z".into(), name: "other.memoanima".into() }).unwrap_err(), Refusal(code::ALBUM_MISSING));
    assert_eq!(commands::args_delete_work(&t.d, &commands::WorkArgs { album: "A".into(), name: "other.memoanima.bak".into() }).unwrap_err(), Refusal(code::BAD_NAME));
    assert_eq!(commands::args_delete_work(&t.d, &commands::WorkArgs { album: "A".into(), name: "../A/other.memoanima".into() }).unwrap_err(), Refusal(code::BAD_NAME));
    assert!(a.join("other.memoanima").is_file());
}

/// ★退避の記録が先: 本体が退避先にある（上書きの途中で止まった）作品を消すと、先に本体へ戻してから消す（あとで戻って帰ってこない）
#[test]
fn delete_work_resumes_record_first() {
    let t = T::new("del-evac");
    let a = t.album("A");
    let r = evac_record(&t, "A", "w.memoanima", b"PREV");
    // 本体は無い（退避先にある）→ 保全で戻してから消す（target-missing にしない）
    commands::args_delete_work(&t.d, &commands::WorkArgs { album: "A".into(), name: "w.memoanima".into() }).unwrap();
    assert!(!a.join("w.memoanima").exists());
    assert!(!r.dir.exists(), "記録が残った");
    assert_eq!(super::evac::pending_count(&t.d), 0);
}

/// ★記録が片付かなければ何も消さずに pending-record
#[test]
fn delete_work_refuses_when_record_pending() {
    let t = T::new("del-pend");
    let a = t.album("A");
    fs::write(a.join("keep.memoanima"), b"K").unwrap();
    let r = evac_record(&t, "A", "w.memoanima", b"PREV");
    let before = tree(&t.d.lib);
    let mut h = MoveAlbumAway { to: None };
    let e = library::delete_work_with(&t.d, "A", "w.memoanima", &mut h).unwrap_err();
    h.put_back();
    assert_eq!(e, Refusal(code::PENDING_RECORD));
    assert_eq!(tree(&t.d.lib), before, "断ったのに何か変えた");
    assert!(r.work_file().is_file(), "退避したファイルが消えた");
}

/// ライブラリの外を指すアルバム（リンク）の作品は消さない・一覧に出さない。
/// Windows はジャンクションをテストの中で作れない（V216）ので、v224_smoke が外で作って `V224_JUNC` で渡す（無ければ「見ていない」と出す）。
/// Unix はここでシンボリックリンクを作る
#[test]
fn delete_work_refuses_outside() {
    let t = T::new("del-out");
    let Some((lib, outside)) = outside_link(&t) else {
        println!("V224-JUNC not-checked (V224_JUNC が無い)");
        return;
    };
    let d = Dirs::under(lib.clone(), &t.base.join("config-j"));
    fs::write(outside.join("w.memoanima"), b"OUT").unwrap();
    fs::write(outside.join("w.memoanima.bak"), b"OUT0").unwrap();
    let wa = || commands::WorkArgs { album: "J".into(), name: "w.memoanima".into() };
    assert_eq!(commands::args_delete_work(&d, &wa()).unwrap_err(), Refusal(code::OUTSIDE));
    assert_eq!(commands::args_delete_album(&d, &library::AlbumArgs { album: "J".into() }).unwrap_err(), Refusal(code::OUTSIDE));
    assert_eq!(commands::args_recover(&d, &wa()).unwrap_err(), Refusal(code::OUTSIDE));
    assert_eq!(commands::args_thumb_write(&d, &library::ThumbWriteArgs { album: "J".into(), name: "w.memoanima".into(), png: b64(PNG) }).unwrap_err(), Refusal(code::OUTSIDE));
    assert_eq!(fs::read(outside.join("w.memoanima")).unwrap(), b"OUT");
    assert_eq!(fs::read(outside.join("w.memoanima.bak")).unwrap(), b"OUT0");
    assert!(!outside.join("w.memoanima.png").exists());
    let l = commands::none_library_list(&d).unwrap();
    assert!(!l.albums.contains(&"J".to_string()) && l.works.is_empty(), "外を指すアルバムを一覧に出した");
    assert!(commands::none_recoverable_list(&d).unwrap().is_empty());
    println!("V224-JUNC checked");
}

/// (ライブラリ, 外のフォルダ)。ライブラリの直下の J が外のフォルダを指す
#[cfg(windows)]
fn outside_link(_t: &T) -> Option<(PathBuf, PathBuf)> {
    let base = PathBuf::from(std::env::var("V224_JUNC").ok()?);
    let lib = base.join("library");
    let is_link = fs::symlink_metadata(lib.join("J")).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    assert!(is_link, "J がリンクではない（ジャンクションを作れていない）");
    Some((lib, base.join("outside")))
}
#[cfg(unix)]
fn outside_link(t: &T) -> Option<(PathBuf, PathBuf)> {
    let outside = t.base.join("outside");
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, t.d.lib.join("J")).ok()?;
    Some((t.d.lib.clone(), outside))
}

// ---------------- アルバムを消す（L-4） ----------------

#[test]
fn delete_album_cases() {
    let t = T::new("dela");
    let aa = |a: &str| library::AlbumArgs { album: a.into() };
    // 作品がある
    let w = t.album("W");
    fs::write(w.join("x.kwz"), b"K").unwrap();
    assert_eq!(commands::args_delete_album(&t.d, &aa("W")).unwrap_err(), Refusal(code::ALBUM_NOT_EMPTY));
    // 作品は無いがほかのファイル・フォルダ
    let f = t.album("F");
    fs::write(f.join("readme.txt"), b"R").unwrap();
    assert_eq!(commands::args_delete_album(&t.d, &aa("F")).unwrap_err(), Refusal(code::ALBUM_HAS_FILES));
    let s = t.album("S");
    fs::create_dir_all(s.join("sub")).unwrap();
    assert_eq!(commands::args_delete_album(&t.d, &aa("S")).unwrap_err(), Refusal(code::ALBUM_HAS_FILES));
    let b = t.album("B");
    fs::write(b.join("x.memoanima.bak"), b"B").unwrap();
    assert_eq!(commands::args_delete_album(&t.d, &aa("B")).unwrap_err(), Refusal(code::ALBUM_HAS_FILES), "控えだけのアルバムを消した");
    for d in [&w, &f, &s, &b] {
        assert!(d.is_dir());
    }
    // 付属物だけ → 消える（大小だけ違う名前で頼んでも実の名前）
    let e = t.album("Empty");
    fs::write(e.join("gone.memoanima.png"), PNG).unwrap();
    fs::write(e.join("Thumbs.db"), b"T").unwrap();
    commands::args_delete_album(&t.d, &aa("EMPTY")).unwrap();
    assert!(!e.exists());
    // 無い・名前が違う
    assert_eq!(commands::args_delete_album(&t.d, &aa("Nope")).unwrap_err(), Refusal(code::ALBUM_MISSING));
    assert_eq!(commands::args_delete_album(&t.d, &aa("..")).unwrap_err(), Refusal(code::BAD_NAME));
    // 数え方（PC と同じ述語）
    assert_eq!(library::album_contents(&w).unwrap(), AlbumContents::Works);
    assert_eq!(library::album_contents(&f).unwrap(), AlbumContents::OtherFiles);
}

/// ★そのアルバムを指す退避の記録が片付かなければ、何も消さずに pending-record。片付く記録は先に片付けてから数える
#[test]
fn delete_album_resumes_records() {
    let t = T::new("dela-evac");
    let a = t.album("A");
    let r = evac_record(&t, "A", "w.memoanima", b"PREV");
    let mut h = MoveAlbumAway { to: None };
    let e = library::delete_album_with(&t.d, "A", &mut h).unwrap_err();
    h.put_back();
    assert_eq!(e, Refusal(code::PENDING_RECORD));
    assert!(a.is_dir() && r.work_file().is_file());
    // 片付くと本体が戻る → 作品があるので消さない（取り残さない）
    assert_eq!(commands::args_delete_album(&t.d, &library::AlbumArgs { album: "A".into() }).unwrap_err(), Refusal(code::ALBUM_NOT_EMPTY));
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), b"PREV");
}

// ---------------- 復元の候補・控えから戻す（L-5） ----------------

#[test]
fn recoverable_and_recover() {
    let t = T::new("rec");
    let a = t.album("A");
    fs::write(a.join("lost.memoanima.bak"), b"L").unwrap();
    fs::write(a.join("lost.memoanima.1700000000-1.tmp"), b"T").unwrap();
    fs::write(a.join("ok.memoanima"), b"O").unwrap();
    fs::write(a.join("ok.memoanima.bak"), b"O0").unwrap();
    let list = commands::none_recoverable_list(&t.d).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].album.as_str(), list[0].name.as_str(), list[0].bak_size, list[0].tmp_count), ("A", "lost.memoanima", 1, 1));
    let js = serde_json::to_string(&list).unwrap();
    assert!(!js.contains("tmp\"") && !js.contains(&*t.d.lib.to_string_lossy().replace('\\', "\\\\")), "パスを返した: {js}");
    let wa = |n: &str| commands::WorkArgs { album: "A".into(), name: n.into() };
    let p = commands::args_recover(&t.d, &wa("lost.memoanima")).unwrap();
    assert_eq!((p.album.as_str(), p.name.as_str()), ("A", "lost.memoanima"));
    assert_eq!(fs::read(a.join("lost.memoanima")).unwrap(), b"L");
    assert!(!a.join("lost.memoanima.bak").exists());
    // 本体がある（大小だけ違う名前も）→ name-taken（控えは残す）
    assert_eq!(commands::args_recover(&t.d, &wa("ok.memoanima")).unwrap_err(), Refusal(code::NAME_TAKEN));
    assert_eq!(fs::read(a.join("ok.memoanima.bak")).unwrap(), b"O0");
    fs::write(a.join("Case.memoanima"), b"C").unwrap();
    fs::write(a.join("case.memoanima.bak"), b"C0").unwrap();
    assert_eq!(commands::args_recover(&t.d, &wa("case.memoanima")).unwrap_err(), Refusal(code::NAME_TAKEN));
    assert_eq!(fs::read(a.join("case.memoanima.bak")).unwrap(), b"C0");
    // 控えが無い
    assert_eq!(commands::args_recover(&t.d, &wa("none.memoanima")).unwrap_err(), Refusal(code::TARGET_MISSING));
}

/// ★見たあとに外で同じ名前が置かれても、置き換えない（外のファイルも控えもそのまま）
#[test]
fn recover_does_not_replace_when_placed_meanwhile() {
    let t = T::new("rec-race");
    let a = t.album("A");
    fs::write(a.join("w.memoanima.bak"), b"MINE").unwrap();
    let dest = a.join("w.memoanima");
    let e = library::recover_with(&t.d, "A", "w.memoanima", &mut NoHooks, &mut || fs::write(&dest, b"THEIRS").unwrap()).unwrap_err();
    assert_eq!(e, Refusal(code::NAME_TAKEN));
    assert_eq!(fs::read(&dest).unwrap(), b"THEIRS", "外で置いたものを置き換えた");
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"MINE", "控えを失った");
}

#[test]
fn recover_refuses_when_record_pending() {
    let t = T::new("rec-pend");
    let a = t.album("A");
    fs::write(a.join("w.memoanima.bak"), b"B").unwrap();
    let r = evac_record(&t, "A", "w.memoanima", b"PREV");
    let mut h = MoveAlbumAway { to: None };
    let e = library::recover_with(&t.d, "A", "w.memoanima", &mut h, &mut || {}).unwrap_err();
    h.put_back();
    assert_eq!(e, Refusal(code::PENDING_RECORD));
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), b"B");
    assert!(!a.join("w.memoanima").exists() && r.work_file().is_file());
}

// ---------------- 試験用のライブラリ ----------------

/// ★試験用のライブラリを開いている間は、どの命令も本物の側（ライブラリ・設定の置き場）に 1 バイトも書かない・本物の作品を見せない
#[test]
fn test_library_never_reaches_real_side() {
    use super::devcheck;
    let _g = devcheck::SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let t = T::new("devsw");
    let real_config = t.base.join("real-config");
    fs::create_dir_all(&real_config).unwrap();
    seed_for_delete(&t.d.lib);
    fs::write(t.d.lib.join("A").join("lost.memoanima.bak"), b"L").unwrap();
    t.album("Empty");
    let real_before = tree(&t.d.lib);
    devcheck::open(&real_config).unwrap();
    let d = devcheck::switched(t.d.lib.clone(), &real_config);
    assert!(!d.lib.starts_with(&t.d.lib));
    fs::create_dir_all(&d.lib).unwrap();
    // 本物と同じ名前で全部の命令を呼ぶ（試験用の側には無い）
    let wa = commands::WorkArgs { album: "A".into(), name: "w.memoanima".into() };
    let l = commands::none_library_list(&d).unwrap();
    assert!(l.works.is_empty() && l.albums.is_empty(), "本物の作品を見せた");
    assert!(commands::none_recoverable_list(&d).unwrap().is_empty());
    let _ = commands::none_library_stamp(&d);
    assert!(commands::args_thumb_read(&d, &wa).is_err());
    assert!(commands::args_thumb_write(&d, &library::ThumbWriteArgs { album: "A".into(), name: "w.memoanima".into(), png: b64(PNG) }).is_err());
    assert!(commands::args_work_peek(&d, &wa).is_err());
    assert!(commands::args_delete_work(&d, &wa).is_err());
    assert!(commands::args_delete_album(&d, &library::AlbumArgs { album: "Empty".into() }).is_err());
    assert!(commands::args_recover(&d, &commands::WorkArgs { album: "A".into(), name: "lost.memoanima".into() }).is_err());
    devcheck::close();
    assert_eq!(tree(&t.d.lib), real_before, "試験用のライブラリの間に本物を変えた");
    // 閉じると本物に届く（対照）
    let d = devcheck::switched(t.d.lib.clone(), &real_config);
    assert_eq!(commands::none_library_list(&d).unwrap().works.len(), 2);
}

// ---------------- 独立レビューの指摘（V224）: ライブラリの中の別の作品を指すファイルのリンク ----------------

/// リンクの置き場を用意する: (ライブラリ, A, B)。A/alias.memoanima → B/other.memoanima・A/restore.memoanima.bak → B/other2.memoanima。
/// Windows はテストの中でファイルのリンクを作れない（権限）ので、v224_smoke が PowerShell で作って `V224_FILELINK` で渡す
/// （`<V224_FILELINK>/<tag>/library/…`。無ければ「見ていない」）。Unix はここで作る
fn flink(t: &T, tag: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
    #[cfg(windows)]
    {
        let base = PathBuf::from(std::env::var("V224_FILELINK").ok()?).join(tag).join("library");
        let is_link = |p: &Path| fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false);
        assert!(is_link(&base.join("A").join("alias.memoanima")) && is_link(&base.join("A").join("restore.memoanima.bak")), "V224_FILELINK のリンクが無い");
        let _ = t;
        Some((base.clone(), base.join("A"), base.join("B")))
    }
    #[cfg(unix)]
    {
        let a = t.album("A");
        let b = t.album("B");
        fs::write(b.join("other.memoanima"), b"OTHER").unwrap();
        fs::write(b.join("other.memoanima.bak"), b"OTHER0").unwrap();
        fs::write(b.join("other.memoanima.png"), PNG).unwrap();
        fs::write(b.join("other2.memoanima"), b"OTHER2").unwrap();
        let _ = tag;
        std::os::unix::fs::symlink(b.join("other.memoanima"), a.join("alias.memoanima")).ok()?;
        std::os::unix::fs::symlink(b.join("other2.memoanima"), a.join("restore.memoanima.bak")).ok()?;
        Some((t.d.lib.clone(), a, b))
    }
}

/// ★独立レビュー 高①: 作品の本体がライブラリの中の別の作品を指すリンクなら、消さない・サムネを書かない（リンクの先の本体・控え・サムネを消していた）
#[test]
fn delete_work_refuses_file_link_to_other_work() {
    let t = T::new("del-flink");
    let Some((lib, a, b)) = flink(&t, "del") else {
        println!("V224-FILELINK not-checked (V224_FILELINK が無い)");
        return;
    };
    let d = Dirs::under(lib, &t.base.join("config-fl"));
    let before = tree(&b);
    let e = commands::args_delete_work(&d, &commands::WorkArgs { album: "A".into(), name: "alias.memoanima".into() });
    assert_eq!(e.unwrap_err(), Refusal(code::OUTSIDE));
    assert_eq!(tree(&b), before, "リンクの先の作品を消した");
    assert!(fs::symlink_metadata(a.join("alias.memoanima")).is_ok(), "リンクそのものを消した");
    assert!(commands::args_thumb_write(&d, &library::ThumbWriteArgs { album: "A".into(), name: "alias.memoanima".into(), png: b64(PNG) }).is_err());
    assert_eq!(tree(&b), before, "リンクの先にサムネを書いた");
    println!("V224-FILELINK checked");
}

/// ★独立レビュー 高②: 控えがライブラリの中の別の作品を指すリンクなら、戻さない（リンクの先の本体を動かしていた）
#[test]
fn recover_refuses_bak_link_to_other_work() {
    let t = T::new("rec-flink");
    let Some((lib, a, b)) = flink(&t, "rec") else {
        println!("V224-FILELINK not-checked (V224_FILELINK が無い)");
        return;
    };
    let d = Dirs::under(lib, &t.base.join("config-fl"));
    let before = tree(&b);
    assert!(commands::args_recover(&d, &commands::WorkArgs { album: "A".into(), name: "restore.memoanima".into() }).is_err());
    assert_eq!(tree(&b), before, "リンクの先の作品を動かした");
    assert!(fs::symlink_metadata(a.join("restore.memoanima")).is_err(), "戻した");
    println!("V224-FILELINK checked");
}
