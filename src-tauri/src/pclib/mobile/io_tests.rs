//! V229 (M-4): 出し入れ（io.rs・zipio.rs）の単体テスト。置き場は %TEMP% の下（作者のライブラリ・設定に届かない＝P-0）。
//! どの試しも、わざと壊した形で赤になる側（断る・戻す）を同じ試しの中で見る。
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use super::iotmp::{self as mio, IoDirs, Kind};
use super::zipio::{self, ExportAllJob, ZipWriter};
use super::{code, Dirs};
use crate::pclib::load_index;

static N: AtomicU64 = AtomicU64::new(0);

struct T {
    base: PathBuf,
    d: Dirs,
    io: IoDirs,
}
impl T {
    fn new(tag: &str) -> T {
        let base = std::env::temp_dir().join(format!("v229-io-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&base);
        let lib = base.join("lib");
        fs::create_dir_all(&lib).unwrap();
        let d = Dirs::under(lib, &base.join("config"));
        let io = IoDirs::under(&base.join("cache"));
        T { base, d, io }
    }
    fn album(&self, a: &str) -> PathBuf {
        let p = self.d.lib.join(a);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn ready(&self) {
        fs::create_dir_all(&self.d.config).unwrap();
        fs::write(self.d.config.join("settings.json"), r#"{"mobileLibraryReady":true}"#).unwrap();
    }
}
impl Drop for T {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}
fn gz(b: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(b).unwrap();
    e.finish().unwrap()
}
/// PV6 の形（gzip の頭・塊・トレーラ）
fn pv6(id: &str) -> Vec<u8> {
    let h = gz(format!(r#"{{"magic":"ANIMEMO","version":6,"id":"{id}"}}"#).as_bytes());
    let blobs = b"BLOBDATA".to_vec();
    let mut v = h.clone();
    v.extend_from_slice(&blobs);
    v.extend_from_slice(b"AMPV6END");
    v.extend_from_slice(&(h.len() as u32).to_le_bytes());
    v.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    v
}
fn pv5() -> Vec<u8> {
    gz(br#"{"magic":"ANIMEMO","version":5,"frames":[]}"#)
}
const KWZ: &[u8] = b"KFH\x14kwz-body-0123456789";
const PPM: &[u8] = b"PARAppm-body";

/// 小さな zip の書き手（試しの zip を作る。`deflate` なら圧縮・`flags` で暗号の印など・`attr` で外部属性）
fn zip_of(entries: &[(&str, &[u8], bool, u16, u32)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut cd = Vec::new();
    for (name, data, deflate, flags, attr) in entries {
        let body = if *deflate {
            let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(data).unwrap();
            e.finish().unwrap()
        } else {
            data.to_vec()
        };
        let crc = zipio::crc32_update(0, data);
        let off = out.len() as u32;
        let method: u16 = if *deflate { 8 } else { 0 };
        let mut lh = Vec::new();
        lh.extend_from_slice(b"PK\x03\x04");
        lh.extend_from_slice(&20u16.to_le_bytes());
        lh.extend_from_slice(&flags.to_le_bytes());
        lh.extend_from_slice(&method.to_le_bytes());
        lh.extend_from_slice(&[0, 0, 0x21, 0]);
        lh.extend_from_slice(&crc.to_le_bytes());
        lh.extend_from_slice(&(body.len() as u32).to_le_bytes());
        lh.extend_from_slice(&(data.len() as u32).to_le_bytes());
        lh.extend_from_slice(&(name.len() as u16).to_le_bytes());
        lh.extend_from_slice(&0u16.to_le_bytes());
        lh.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&lh);
        out.extend_from_slice(&body);
        cd.extend_from_slice(b"PK\x01\x02");
        cd.extend_from_slice(&((3u16 << 8) | 20).to_le_bytes());
        cd.extend_from_slice(&20u16.to_le_bytes());
        cd.extend_from_slice(&flags.to_le_bytes());
        cd.extend_from_slice(&method.to_le_bytes());
        cd.extend_from_slice(&[0, 0, 0x21, 0]);
        cd.extend_from_slice(&crc.to_le_bytes());
        cd.extend_from_slice(&(body.len() as u32).to_le_bytes());
        cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
        cd.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
        cd.extend_from_slice(&attr.to_le_bytes());
        cd.extend_from_slice(&off.to_le_bytes());
        cd.extend_from_slice(name.as_bytes());
    }
    let cd_off = out.len() as u32;
    out.extend_from_slice(&cd);
    out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}
fn plain(entries: &[(&str, &[u8])]) -> Vec<u8> {
    zip_of(&entries.iter().map(|(n, d)| (*n, *d, false, 0x0800u16, 0o100644u32 << 16)).collect::<Vec<_>>())
}

fn files_in(root: &Path) -> Vec<String> {
    fn walk(root: &Path, p: &Path, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(p) else { return };
        for e in rd.flatten() {
            let q = e.path();
            if q.is_dir() {
                walk(root, &q, out);
            } else {
                out.push(q.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut v = Vec::new();
    walk(root, root, &mut v);
    v.sort();
    v
}

// ---------------- 書き出しの一時ファイル ----------------

#[test]
fn out_file_begin_write_finish_abort() {
    let t = T::new("out");
    let tag = mio::out_begin(&t.io, "mp4").unwrap();
    mio::check_tag(&tag).unwrap();
    mio::out_write(&t.io, &tag, 4, b"WXYZ").unwrap();
    mio::out_write(&t.io, &tag, 0, b"ABCD").unwrap();
    // 終える前は渡せない
    assert_eq!(mio::out_finished(&t.io, &tag).unwrap_err().0, code::TARGET_MISSING);
    assert_eq!(mio::out_finish(&t.io, &tag, "あいう/作品").unwrap(), 8);
    let (p, n) = mio::out_finished(&t.io, &tag).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"ABCDWXYZ");
    assert_eq!(n, "あいう_作品.mp4");
    // 名札の形でない・知らない拡張子・4MiB を超える塊は断る（パスを組む前）
    assert_eq!(mio::out_write(&t.io, "../../x", 0, b"a").unwrap_err().0, code::BAD_REQUEST);
    assert_eq!(mio::out_write(&t.io, "0123456789ABCDEF", 0, b"a").unwrap_err().0, code::BAD_REQUEST);
    assert_eq!(mio::out_begin(&t.io, "exe").unwrap_err().0, code::BAD_REQUEST);
    assert_eq!(mio::out_write(&t.io, &tag, 0, &vec![0u8; mio::PIECE_MAX + 1]).unwrap_err().0, code::TOO_LARGE);
    // やめると名札のフォルダごと消える
    let t2 = mio::out_begin(&t.io, "gif").unwrap();
    mio::out_write(&t.io, &t2, 0, b"GIF89a").unwrap();
    mio::out_abort(&t.io, &t2).unwrap();
    assert!(!t.io.out().join(&t2).exists());
    mio::out_abort(&t.io, &t2).unwrap(); // 2 回目は何もしない
}

#[test]
fn cleanup_removes_unfinished_at_startup_and_old_ones() {
    let t = T::new("clean");
    let done = mio::out_begin(&t.io, "mp4").unwrap();
    mio::out_finish(&t.io, &done, "a").unwrap();
    let part = mio::out_begin(&t.io, "mp4").unwrap();
    let recv = mio::in_put(&t.io, "x.memoanima", &pv6("i"), true).unwrap();
    // 起動でないとき: 新しいものは残す
    assert_eq!(mio::cleanup(&t.io, false, SystemTime::now()).unwrap().removed, 0);
    // 起動: 書きかけ（data.part）だけ消える。終えたもの・受け取ったものは残る
    assert_eq!(mio::cleanup(&t.io, true, SystemTime::now()).unwrap().removed, 1);
    assert!(!t.io.out().join(&part).exists() && t.io.out().join(&done).exists() && t.io.inbox().join(&recv).exists());
    // 24 時間より古いものは消える
    let later = SystemTime::now() + Duration::from_secs(25 * 3600);
    assert_eq!(mio::cleanup(&t.io, false, later).unwrap().removed, 2);
    // 名札の形でないフォルダには触らない
    fs::create_dir_all(t.io.out().join("keep-me")).unwrap();
    mio::cleanup(&t.io, true, later).unwrap();
    assert!(t.io.out().join("keep-me").exists());
}

#[test]
fn out_copy_work_copies_bytes_and_keeps_library() {
    let t = T::new("copy");
    let a = t.album("A");
    let body = pv6("w1");
    fs::write(a.join("作品.memoanima"), &body).unwrap();
    let tag = mio::out_copy_work(&t.d, &t.io, "A", "作品.memoanima").unwrap();
    let (p, n) = mio::out_finished(&t.io, &tag).unwrap();
    assert_eq!((fs::read(&p).unwrap(), n.as_str()), (body.clone(), "作品.memoanima"));
    assert_eq!(fs::read(a.join("作品.memoanima")).unwrap(), body);
    assert_eq!(mio::out_copy_work(&t.d, &t.io, "A", "../x.memoanima").unwrap_err().0, code::BAD_NAME);
    assert_eq!(mio::mime_of("memoanima"), "application/octet-stream");
}

// ---------------- 中身で見分ける ----------------

#[test]
fn sniff_by_content_not_name() {
    let cases: Vec<(Vec<u8>, Kind)> = vec![
        (pv6("a"), Kind::WorkPv6),
        (pv5(), Kind::WorkPv5),
        (KWZ.to_vec(), Kind::Kwz),
        (PPM.to_vec(), Kind::Ppm),
        (plain(&[("a.kwz", KWZ)]), Kind::Zip),
        (b"\x89PNG\r\n\x1a\n0000".to_vec(), Kind::Png),
        (vec![0xff, 0xd8, 0xff, 0xe1, 0, 0], Kind::Jpeg),
        (b"\0\0\0\x18ftypheic\0\0\0\0mif1".to_vec(), Kind::Heic),
        (b"\0\0\0\x18ftypM4A \0\0\0\0isom".to_vec(), Kind::Isom),
        (b"RIFF\0\0\0\0WAVEfmt ".to_vec(), Kind::Wav),
        (b"OggS\0\x02".to_vec(), Kind::Ogg),
        (b"ID3\x04\0\0".to_vec(), Kind::Mp3),
        (vec![0x1a, 0x45, 0xdf, 0xa3, 1], Kind::Matroska),
        (gz(b"{\"other\":1}"), Kind::Unknown),
        (b"%PDF-1.7".to_vec(), Kind::Unknown),
        // 反証: 終わりの印だけ合っても長さが合わない PV6 は作品ではない
        ({
            let mut v = pv6("b");
            v.insert(20, 0);
            v
        }, Kind::Unknown),
    ];
    for (b, want) in cases {
        let got = mio::sniff_reader(&mut Cursor::new(&b), b.len() as u64);
        assert_eq!(got, want, "{:?}", &b[..std::cmp::min(8, b.len())]);
    }
}

#[test]
fn sniff_gate_refuses_before_reading_media() {
    let t = T::new("gate");
    let p = t.base.join("big.png");
    let f = fs::File::create(&p).unwrap();
    f.set_len(mio::MEDIA_MAX + 1).unwrap();
    drop(f);
    // 頭が無い（0 で埋めた）＝見分けられない物は作品の門番（512MiB）で見る。PNG の頭を付けると 64MiB で断る
    assert!(mio::sniff_path(&p).is_ok());
    let mut f = fs::OpenOptions::new().write(true).open(&p).unwrap();
    f.write_all(b"\x89PNG\r\n\x1a\n").unwrap();
    drop(f);
    assert_eq!(mio::sniff_path(&p).unwrap_err().0, code::TOO_LARGE);
}

// ---------------- ライブラリへ写す ----------------

#[test]
fn import_work_keeps_bytes_names_and_collisions() {
    let t = T::new("imp");
    t.album("A");
    let body = pv6("same-id");
    // .memoanima.gz は .memoanima に・ぶつかったら「名前 (2)」・IDも中身も同じ
    let a = mio::in_put(&t.io, "絵.memoanima.gz", &body, false).unwrap();
    let r = mio::in_import(&t.d, &t.io, &a, "A", "取り込んだ作品").unwrap();
    assert_eq!(r.placed[0].name, "絵.memoanima");
    let b = mio::in_put(&t.io, "絵.memoanima", &body, false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &b, "A", "取り込んだ作品").unwrap().placed[0].name, "絵 (2).memoanima");
    assert_eq!(sha(&fs::read(t.d.lib.join("A/絵 (2).memoanima")).unwrap()), sha(&body));
    // 名前の無い受け取り・違う拡張子・旧拡張子
    let c = mio::in_put(&t.io, "", &pv5(), false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &c, "A", "取り込んだ作品").unwrap().placed[0].name, "取り込んだ作品.memoanima");
    let d2 = mio::in_put(&t.io, "古い.animemo", &pv5(), false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &d2, "A", "x").unwrap().placed[0].name, "古い.animemo");
    let e = mio::in_put(&t.io, "download.bin", &pv6("x"), false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &e, "A", "x").unwrap().placed[0].name, "download.memoanima");
    // 取り込み終わったものは一時の場所から消える
    assert!(!t.io.inbox().join(&a).exists());
    // 作品でない物は何も書かずに断る
    let before = files_in(&t.d.lib);
    let p = mio::in_put(&t.io, "x.pdf", b"%PDF-1.7 hello", false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &p, "A", "x").unwrap_err().0, mio::UNSUPPORTED_KIND);
    let png = mio::in_put(&t.io, "x.png", b"\x89PNG\r\n\x1a\n0000", false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &png, "A", "x").unwrap_err().0, mio::UNSUPPORTED_KIND);
    assert_eq!(files_in(&t.d.lib), before);
    // 一時ファイル（.import.tmp）が残らない
    assert!(files_in(&t.d.lib).iter().all(|f| !f.contains(".import.tmp")));
}

#[test]
fn import_kwz_goes_into_index_and_unplace_removes() {
    let t = T::new("kwz");
    t.album("A");
    let k = mio::in_put(&t.io, "", KWZ, false).unwrap();
    let r = mio::in_import(&t.d, &t.io, &k, "A", "note").unwrap();
    assert_eq!(r.placed[0].name, "note.kwz");
    let idx = load_index(&t.d.lib).unwrap();
    assert_eq!(idx.items.len(), 1);
    assert_eq!((idx.items[0].rel_path.as_str(), idx.items[0].hash.as_str()), ("A/note.kwz", sha(KWZ).as_str()));
    let p = mio::in_put(&t.io, "abc.ppm", PPM, false).unwrap();
    let r2 = mio::in_import(&t.d, &t.io, &p, "A", "note").unwrap();
    assert_eq!(r2.placed[0].name, "abc.ppm");
    mio::unplace(&t.d, &r2.placed);
    assert_eq!(load_index(&t.d.lib).unwrap().items.len(), 1);
    assert!(!t.d.lib.join("A/abc.ppm").exists());
}

#[test]
fn received_items_are_taken_once() {
    let t = T::new("recv");
    let a = mio::in_put(&t.io, "a.kwz", KWZ, true).unwrap();
    let _picked = mio::in_put(&t.io, "b.kwz", KWZ, false).unwrap();
    let first = mio::in_take_received(&t.io).unwrap();
    assert_eq!(first.iter().map(|x| x.tag.clone()).collect::<Vec<_>>(), vec![a.clone()]);
    assert_eq!(first[0].name, "a.kwz");
    // 2 回目（Activity の作り直し・開き直し）は空
    assert!(mio::in_take_received(&t.io).unwrap().is_empty());
}

// ---------------- zip の取り込み ----------------

#[test]
fn zip_import_albums_and_skips() {
    let t = T::new("zip");
    t.album("選んだ");
    let z = zip_of(&[
        ("旅/一.memoanima", &pv6("1"), true, 0x0800, 0),
        ("旅/深い/二.memoanima", &pv6("2"), false, 0x0800, 0),
        ("直.kwz", KWZ, false, 0x0800, 0),
        ("旅/中.zip", &plain(&[("x.kwz", KWZ)]), false, 0x0800, 0),
        ("旅/絵.png", b"\x89PNG\r\n\x1a\n0", false, 0x0800, 0),
        ("旅/", b"", false, 0x0800, 0),
    ]);
    let tag = mio::in_put(&t.io, "all.zip", &z, false).unwrap();
    let r = mio::in_import(&t.d, &t.io, &tag, "選んだ", "取り込んだ作品").unwrap();
    assert_eq!(zipio::placed_names(&r.placed), vec!["旅/一.memoanima", "旅/二.memoanima", "選んだ/直.kwz"]);
    assert_eq!(r.skipped, 2);
    assert_eq!(r.albums_created, vec!["旅"]);
    assert_eq!(sha(&fs::read(t.d.lib.join("旅/一.memoanima")).unwrap()), sha(&pv6("1")));
}

#[test]
fn zip_import_refuses_unsafe_and_leaves_nothing() {
    let bad: Vec<(&str, Vec<u8>)> = vec![
        ("dotdot", zip_of(&[("ok.kwz", KWZ, false, 0x0800, 0), ("../x.kwz", KWZ, false, 0x0800, 0)])),
        ("absolute", zip_of(&[("/x.kwz", KWZ, false, 0x0800, 0)])),
        ("drive", zip_of(&[("C:x.kwz", KWZ, false, 0x0800, 0)])),
        ("backslash", zip_of(&[("a\\..\\x.kwz", KWZ, false, 0x0800, 0)])),
        ("link", zip_of(&[("a.kwz", KWZ, false, 0x0800, 0o120777u32 << 16)])),
        ("encrypted", zip_of(&[("a.kwz", KWZ, false, 0x0801, 0)])),
    ];
    for (why, z) in bad {
        let t = T::new("unsafe");
        t.album("A");
        let tag = mio::in_put(&t.io, "z.zip", &z, false).unwrap();
        let before = files_in(&t.d.lib);
        assert_eq!(mio::in_import(&t.d, &t.io, &tag, "A", "x").unwrap_err().0, zipio::ZIP_UNSAFE, "{why}");
        assert_eq!(files_in(&t.d.lib), before, "{why}");
    }
}

#[test]
fn zip_import_rolls_back_everything_on_failure() {
    let t = T::new("rollback");
    t.album("A");
    let z = zip_of(&[("新/一.memoanima", &pv6("1"), false, 0x0800, 0), ("新/二.kwz", KWZ, false, 0x0800, 0), ("新/三.memoanima", &pv6("3"), false, 0x0800, 0)]);
    let tag = mio::in_put(&t.io, "z.zip", &z, false).unwrap();
    let before = files_in(&t.d.lib);
    let zp = t.io.inbox().join(&tag).join("data");
    let r = zipio::import_zip_with(&t.d, &zp, "A", "x", &t.io.inbox().join(&tag), Some(2));
    assert!(r.is_err());
    // 写した 2 件・作ったアルバム「新」・索引の行が全部戻る
    assert_eq!(files_in(&t.d.lib).into_iter().filter(|f| !f.ends_with("animemo-library.json")).collect::<Vec<_>>(), before);
    assert!(!t.d.lib.join("新").exists());
    assert!(load_index(&t.d.lib).unwrap().items.is_empty());
    // 対照: 失敗させなければ 3 件入る
    let ok = zipio::import_zip(&t.d, &zp, "A", "x", &t.io.inbox().join(&tag)).unwrap();
    assert_eq!(ok.placed.len(), 3);
}

#[test]
fn zip_import_refuses_too_many_entries() {
    let t = T::new("many");
    t.album("A");
    // 100,001 件（中身は空の .txt）
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let c = AtomicBool::new(false);
    let p = AtomicU64::new(0);
    for i in 0..100_001u32 {
        w.add_file(&format!("f{i}.txt"), &mut Cursor::new(Vec::<u8>::new()), 0, 0, &c, &p).unwrap();
    }
    let z = w.finish().unwrap().into_inner();
    let tag = mio::in_put(&t.io, "z.zip", &z, false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &tag, "A", "x").unwrap_err().0, zipio::ZIP_UNSAFE);
}

#[test]
fn zip_reads_utf8_and_non_utf8_names() {
    // 印の無い Shift_JIS の名前（読めない）は fallback ＋番号
    let mut z = zip_of(&[("XX.kwz", KWZ, false, 0, 0)]);
    let pos = z.windows(6).position(|w| w == b"XX.kwz").unwrap();
    z[pos] = 0x82;
    z[pos + 1] = 0xa0; // 「あ」の Shift_JIS（UTF-8 として読めない）
    let pos2 = z.windows(6).rposition(|w| w == b"XX.kwz").unwrap();
    z[pos2] = 0x82;
    z[pos2 + 1] = 0xa0;
    let t = T::new("names");
    t.album("A");
    let tag = mio::in_put(&t.io, "z.zip", &z, false).unwrap();
    let r = mio::in_import(&t.d, &t.io, &tag, "A", "取り込んだ作品").unwrap();
    assert_eq!(r.placed[0].name, "取り込んだ作品 1.kwz");
}

// ---------------- 全部書き出す ----------------

fn job() -> Arc<ExportAllJob> {
    Arc::new(ExportAllJob::default())
}

#[test]
fn export_all_round_trip_only_albums_and_works() {
    let t = T::new("all");
    let a = t.album("アルバム");
    let b = t.album("空");
    let _ = b;
    fs::write(a.join("が.memoanima"), pv6("1")).unwrap(); // 濁点（NFC で入る）
    fs::write(a.join("が.memoanima.png"), b"thumb").unwrap();
    fs::write(a.join("が.memoanima.bak"), b"bak").unwrap();
    fs::write(a.join("n.kwz"), KWZ).unwrap();
    fs::write(a.join("旧.animemo"), pv5()).unwrap();
    fs::write(t.d.lib.join("animemo-library.json"), b"{}").unwrap();
    fs::create_dir_all(t.d.lib.join(".animemo/thumbs")).unwrap();
    fs::write(t.d.lib.join(".animemo/thumbs/x.png"), b"t").unwrap();
    let j = job();
    let tag = zipio::export_all(&t.d, &t.io, "全作品", &j).unwrap();
    let (p, n) = mio::out_finished(&t.io, &tag).unwrap();
    assert_eq!(n, "全作品.zip");
    let mut f = fs::File::open(&p).unwrap();
    let es = zipio::read_directory(&mut f).unwrap();
    let names: Vec<String> = es.iter().map(|e| zipio::entry_name(e).unwrap()).collect();
    assert_eq!(names, vec!["アルバム/", "空/", "アルバム/n.kwz", "アルバム/が.memoanima", "アルバム/旧.animemo"]);
    assert!(es.iter().all(|e| e.utf8_flag && e.method == 0));
    // 取り出すとライブラリのものと SHA-256 で同じ（zip の取り込みで戻す）
    let t2 = T::new("all2");
    t2.album("選んだ");
    let tag2 = mio::in_put(&t2.io, "z.zip", &fs::read(&p).unwrap(), false).unwrap();
    let r = mio::in_import(&t2.d, &t2.io, &tag2, "選んだ", "x").unwrap();
    assert_eq!(r.placed.len(), 3);
    for name in ["アルバム/が.memoanima", "アルバム/n.kwz", "アルバム/旧.animemo"] {
        assert_eq!(sha(&fs::read(t2.d.lib.join(name)).unwrap()), sha(&fs::read(t.d.lib.join(name)).unwrap()), "{name}");
    }
    assert_eq!(j.done.load(Ordering::SeqCst), 3);
}

#[test]
fn export_all_cancel_leaves_nothing() {
    let t = T::new("cancel");
    let a = t.album("A");
    fs::write(a.join("x.memoanima"), pv6("1")).unwrap();
    let j = job();
    j.cancel.store(true, Ordering::SeqCst);
    assert_eq!(zipio::export_all(&t.d, &t.io, "z", &j).unwrap_err().0, zipio::CANCELLED);
    assert!(files_in(&t.io.out()).is_empty());
}

#[test]
fn zip64_when_many_entries() {
    // 70,000 件（REQ IO20）。ZIP64 の終わりの記録が付き、こちらの読み手で全部読める（Python の zipfile は v229_smoke [D] が見る）
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let c = AtomicBool::new(false);
    let p = AtomicU64::new(0);
    for i in 0..70_000u32 {
        let body = format!("{i}");
        w.add_file(&format!("a/{i}.kwz"), &mut Cursor::new(body.into_bytes()), 5, 0, &c, &p).unwrap();
    }
    let z = w.finish().unwrap().into_inner();
    assert!(z.windows(4).any(|x| x == b"PK\x06\x06") && z.windows(4).any(|x| x == b"PK\x06\x07"));
    let es = zipio::read_directory(&mut Cursor::new(&z)).unwrap();
    assert_eq!(es.len(), 70_000);
    assert_eq!(zipio::entry_name(&es[69_999]).unwrap(), "a/69999.kwz");
    // 少ない件数では付けない
    let mut w2 = ZipWriter::new(Cursor::new(Vec::new()));
    w2.add_file("a.kwz", &mut Cursor::new(b"x".to_vec()), 1, 0, &c, &p).unwrap();
    let z2 = w2.finish().unwrap().into_inner();
    assert!(!z2.windows(4).any(|x| x == b"PK\x06\x06"));
}

#[test]
fn dos_time_known_values() {
    // 2026-11-17 12:34:56（UTC）
    let (t, d) = zipio::dos_time(1_794_918_896);
    assert_eq!((d >> 9) + 1980, 2026);
    assert_eq!(((d >> 5) & 0xf, d & 0x1f), (11, 17));
    assert_eq!((t >> 11, (t >> 5) & 0x3f, (t & 0x1f) * 2), (12, 34, 56));
    assert_eq!(zipio::dos_time(0), (0, (1 << 5) | 1));
}

// ---------------- D-18 ----------------

#[test]
fn heal_index_only_when_ready() {
    let t = T::new("heal");
    let a = t.album("A");
    fs::write(a.join("n.kwz"), KWZ).unwrap();
    // 印が無い＝拾わない
    assert!(!mio::heal_missing_index(&t.d).unwrap());
    assert!(!t.d.lib.join("animemo-library.json").exists());
    t.ready();
    assert!(mio::heal_missing_index(&t.d).unwrap());
    let notes = mio::library_notes(&t.d).unwrap();
    assert_eq!(notes.iter().map(|n| format!("{}/{}", n.album, n.name)).collect::<Vec<_>>(), vec!["A/n.kwz"]);
    // 索引があればもう拾わない
    assert!(!mio::heal_missing_index(&t.d).unwrap());
}

// ---------------- D-2: 外の読み手（Python の zipfile・Windows の展開）に渡す見本を書く（v229_smoke [D] が呼ぶ） ----------------

/// ★`V229_ZIP_OUT` に置き場を渡したときだけ動く（ふだんの cargo test では何もしない）。全部書き出すの zip を 2 つ書く:
/// `all_ja.zip`（日本語・濁点・NFD で置いた名前のアルバムと作品＝取り出すと NFC）と `many70k.zip`（70,000 件＝ZIP64）。
/// 取り出したときに比べる SHA-256 の表（`expect.tsv`＝zip の中の名前 → SHA-256）も書く。zip の取り込み（往復）もここで回す
#[test]
fn write_zip_samples_for_outside_readers() {
    let Ok(out) = std::env::var("V229_ZIP_OUT") else { return };
    let out = PathBuf::from(out);
    fs::create_dir_all(&out).unwrap();
    // 1) 日本語の名前（アルバム 2・作品 4。濁点の入った名前は NFD で置く＝zip の中は NFC になる）
    let t = T::new("ja");
    let a = t.album("旅の絵");
    let b = t.album("ｶﾀｶﾅとＡＢＣ");
    let nfd_ga = "\u{304B}\u{3099}"; // か＋濁点（NFD の「が」）
    let files: Vec<(PathBuf, String, Vec<u8>)> = vec![
        (a.join(format!("{nfd_ga}っこう.memoanima")), "旅の絵/がっこう.memoanima".into(), pv6("ja1")),
        (a.join("夜 と 朝 (2).memoanima"), "旅の絵/夜 と 朝 (2).memoanima".into(), pv6("ja2")),
        (b.join("ノート.kwz"), "ｶﾀｶﾅとＡＢＣ/ノート.kwz".into(), KWZ.to_vec()),
        (b.join("古い作品.animemo"), "ｶﾀｶﾅとＡＢＣ/古い作品.animemo".into(), pv5()),
    ];
    let mut expect = String::new();
    for (p, zname, bytes) in &files {
        fs::write(p, bytes).unwrap();
        expect.push_str(&format!("{zname}\t{}\n", sha(bytes)));
    }
    let tag = zipio::export_all(&t.d, &t.io, "メモアニマ_全作品_2026-11-17", &job()).unwrap();
    let (p, _) = mio::out_finished(&t.io, &tag).unwrap();
    fs::copy(&p, out.join("all_ja.zip")).unwrap();
    fs::write(out.join("expect.tsv"), expect).unwrap();
    // 2) 70,000 件（書き出しの書き手で・ZIP64）。取り込みでも全部読める（作品でない .txt は読まずに飛ばす＝飛ばした数が 70,000）
    let t2 = T::new("70k");
    let big = t2.album("多い");
    for i in 0..70_000u32 {
        fs::write(big.join(format!("{i:05}.kwz")), format!("KFH\x14{i}")).unwrap();
    }
    let tag2 = zipio::export_all(&t2.d, &t2.io, "many", &job()).unwrap();
    let (p2, _) = mio::out_finished(&t2.io, &tag2).unwrap();
    fs::copy(&p2, out.join("many70k.zip")).unwrap();
    let es = zipio::read_directory(&mut fs::File::open(&p2).unwrap()).unwrap();
    assert_eq!(es.len(), 70_001); // フォルダ 1 ＋ 作品 70,000
    // 取り込み（往復）: 空のライブラリへ。70,000 件が「多い」アルバムに入る
    let t3 = T::new("70k-in");
    t3.album("選んだ");
    let tag3 = mio::in_put(&t3.io, "many.zip", &fs::read(&p2).unwrap(), false).unwrap();
    let r = mio::in_import(&t3.d, &t3.io, &tag3, "選んだ", "x").unwrap();
    assert_eq!(r.placed.len(), 70_000);
    assert_eq!(fs::read_dir(t3.d.lib.join("多い")).unwrap().count(), 70_000);
    fs::write(out.join("import70k.txt"), format!("placed={} skipped={}\n", r.placed.len(), r.skipped)).unwrap();
}

#[test]
fn zip_import_same_names_get_paren_numbers_with_cache() {
    // 名前の覚え（NameCache）でも、保存と同じ決まり（「名前 (2)」・大小と NFC を無視・控えがあれば使われている）
    let t = T::new("zipnames");
    let a = t.album("旅");
    fs::write(a.join("一.memoanima.bak"), b"bak").unwrap(); // 控えだけがある名前も使われている
    let z = zip_of(&[("旅/一.memoanima", &pv6("1"), false, 0x0800, 0), ("旅/一.memoanima", &pv6("2"), false, 0x0800, 0), ("旅/N.kwz", KWZ, false, 0x0800, 0), ("旅/n.KWZ", KWZ, false, 0x0800, 0)]);
    let tag = mio::in_put(&t.io, "z.zip", &z, false).unwrap();
    let r = mio::in_import(&t.d, &t.io, &tag, "旅", "x").unwrap();
    assert_eq!(zipio::placed_names(&r.placed), vec!["旅/一 (2).memoanima", "旅/一 (3).memoanima", "旅/N.kwz", "旅/n (2).kwz"]);
}

/// リンク（Windows はジャンクション・ほかはシンボリックリンク）を作る。作れなければ false
fn make_link(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        // ジャンクション（シンボリックリンクは開発者モードが無いと作れない。ジャンクションは要らない）
        let ps = format!("New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null", link.display(), target.display());
        std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &ps]).stdin(std::process::Stdio::null()).output().map(|o| o.status.success()).unwrap_or(false) && link.exists()
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[test]
fn parent_link_is_refused_and_never_followed() {
    // ★独立レビューの指摘（止める）: memoanima-io・out・in がリンクのとき、リンクの先の名札の形のフォルダを消さない・書かない
    let t = T::new("plink");
    let outside = t.base.join("outside");
    let victim = outside.join("0123456789abcdef");
    fs::create_dir_all(&victim).unwrap();
    fs::write(victim.join("data.part"), b"keep me").unwrap();
    fs::create_dir_all(&t.io.root).unwrap();
    if !make_link(&outside, &t.io.out()) {
        eprintln!("リンクを作れない環境（飛ばす）");
        return;
    }
    // 片付け（起動）・やめる・書く・始める・終える、どれもリンクの先に触らない
    mio::cleanup(&t.io, true, SystemTime::now() + Duration::from_secs(48 * 3600)).unwrap();
    assert_eq!(mio::out_abort(&t.io, "0123456789abcdef").unwrap_err().0, code::OUTSIDE);
    assert_eq!(mio::out_write(&t.io, "0123456789abcdef", 0, b"x").unwrap_err().0, code::OUTSIDE);
    assert_eq!(mio::out_begin(&t.io, "mp4").unwrap_err().0, code::OUTSIDE);
    assert_eq!(fs::read(victim.join("data.part")).unwrap(), b"keep me");
    // in がリンクでも同じ
    let t2 = T::new("plink2");
    let outside2 = t2.base.join("outside");
    let v2 = outside2.join("0123456789abcdef");
    fs::create_dir_all(&v2).unwrap();
    fs::write(v2.join("data"), b"keep").unwrap();
    fs::write(v2.join("recv"), b"").unwrap();
    fs::create_dir_all(&t2.io.root).unwrap();
    assert!(make_link(&outside2, &t2.io.inbox()));
    mio::cleanup(&t2.io, true, SystemTime::now() + Duration::from_secs(48 * 3600)).unwrap();
    assert_eq!(mio::in_discard(&t2.io, "0123456789abcdef").unwrap_err().0, code::OUTSIDE);
    assert_eq!(mio::in_take_received(&t2.io).unwrap_err().0, code::OUTSIDE);
    assert!(v2.join("data").exists() && v2.join("recv").exists());
}

// ---------------- 独立レビュー（V229 部F）で緑だった書き換えを捕まえる試し ----------------

/// 目録の大きさだけを決めた zip（中身は deflate か無圧縮。`csize`・`usize` を目録とローカルの頭に書く値で上書きできる）
fn zip_with_sizes(name: &str, data: &[u8], deflate: bool, usize_override: Option<u32>, zip64: bool) -> Vec<u8> {
    let body = if deflate {
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    } else {
        data.to_vec()
    };
    let crc = zipio::crc32_update(0, data);
    let us = usize_override.unwrap_or(data.len() as u32);
    let method: u16 = if deflate { 8 } else { 0 };
    let mut out = Vec::new();
    out.extend_from_slice(b"PK\x03\x04");
    out.extend_from_slice(&45u16.to_le_bytes());
    out.extend_from_slice(&0x0800u16.to_le_bytes());
    out.extend_from_slice(&method.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0x21, 0]);
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&us.to_le_bytes());
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&body);
    let cd_off = out.len() as u32;
    let mut cd = Vec::new();
    cd.extend_from_slice(b"PK\x01\x02");
    cd.extend_from_slice(&((3u16 << 8) | 45).to_le_bytes());
    cd.extend_from_slice(&45u16.to_le_bytes());
    cd.extend_from_slice(&0x0800u16.to_le_bytes());
    cd.extend_from_slice(&method.to_le_bytes());
    cd.extend_from_slice(&[0, 0, 0x21, 0]);
    cd.extend_from_slice(&crc.to_le_bytes());
    let extra: Vec<u8> = if zip64 {
        // ZIP64 の欄は「展開の大きさ・圧縮の大きさ」の順（APPNOTE 4.5.3）
        let mut x = Vec::new();
        x.extend_from_slice(&1u16.to_le_bytes());
        x.extend_from_slice(&16u16.to_le_bytes());
        x.extend_from_slice(&(us as u64).to_le_bytes());
        x.extend_from_slice(&(body.len() as u64).to_le_bytes());
        x
    } else {
        Vec::new()
    };
    cd.extend_from_slice(&(if zip64 { 0xFFFF_FFFFu32 } else { body.len() as u32 }).to_le_bytes());
    cd.extend_from_slice(&(if zip64 { 0xFFFF_FFFFu32 } else { us }).to_le_bytes());
    cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
    cd.extend_from_slice(&(extra.len() as u16).to_le_bytes());
    cd.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    cd.extend_from_slice(&0u32.to_le_bytes());
    cd.extend_from_slice(name.as_bytes());
    cd.extend_from_slice(&extra);
    out.extend_from_slice(&cd);
    out.extend_from_slice(b"PK\x05\x06\0\0\0\0\x01\0\x01\0");
    out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[test]
fn zip_entry_inflating_past_declared_size_is_refused() {
    // M2: 目録が小さく申告した中身（爆弾の形）は、申告を超えた所で止めて何も入れない
    let t = T::new("bomb");
    t.album("A");
    let big = vec![b'K'; 200_000];
    let mut data = KWZ.to_vec();
    data.extend_from_slice(&big);
    let z = zip_with_sizes("A/x.kwz", &data, true, Some(10), false);
    let before = files_in(&t.d.lib);
    let tag = mio::in_put(&t.io, "z.zip", &z, false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &tag, "A", "x").unwrap_err().0, zipio::ZIP_UNSAFE);
    assert_eq!(files_in(&t.d.lib), before);
    // 一時の展開のファイルも残らない
    assert!(files_in(&t.io.inbox()).iter().all(|f| !f.contains("/x/")));
}

#[test]
fn zip_import_checks_free_space_before_reading() {
    // M3: 中身の合計（申告）が空きを超える zip は、読む前に no-space（展開して書き始めない）
    let t = T::new("space");
    t.album("A");
    // 1 件 500MiB の申告を 99,999 件（約 48PB）。中身は無い（読む前に断るので要らない）
    let mut cd = Vec::new();
    let n = 99_999u32;
    for i in 0..n {
        let name = format!("A/{i}.kwz");
        cd.extend_from_slice(b"PK\x01\x02");
        cd.extend_from_slice(&((3u16 << 8) | 20).to_le_bytes());
        cd.extend_from_slice(&20u16.to_le_bytes());
        cd.extend_from_slice(&0x0800u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&[0, 0, 0x21, 0]);
        cd.extend_from_slice(&0u32.to_le_bytes());
        cd.extend_from_slice(&(500u32 << 20).to_le_bytes());
        cd.extend_from_slice(&(500u32 << 20).to_le_bytes());
        cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
        cd.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        cd.extend_from_slice(name.as_bytes());
    }
    let mut z = cd.clone();
    z.extend_from_slice(b"PK\x05\x06\0\0\0\0");
    z.extend_from_slice(&(n as u16).to_le_bytes());
    z.extend_from_slice(&(n as u16).to_le_bytes());
    z.extend_from_slice(&(cd.len() as u32).to_le_bytes());
    z.extend_from_slice(&0u32.to_le_bytes());
    z.extend_from_slice(&0u16.to_le_bytes());
    // 件数は 16 ビットに収まらないので ZIP64 の終わりの記録で渡す
    let z64 = {
        // 頭にローカルの頭の形の 30 バイトを置く（中身で zip と見分けられるように）。目録はその後ろ
        let mut w = b"PK\x03\x04".to_vec();
        w.extend_from_slice(&[0u8; 26]);
        let cd_size = cd.len() as u64;
        w.extend_from_slice(&cd);
        let rec_off = w.len() as u64;
        w.extend_from_slice(b"PK\x06\x06");
        w.extend_from_slice(&44u64.to_le_bytes());
        w.extend_from_slice(&45u16.to_le_bytes());
        w.extend_from_slice(&45u16.to_le_bytes());
        w.extend_from_slice(&0u32.to_le_bytes());
        w.extend_from_slice(&0u32.to_le_bytes());
        w.extend_from_slice(&(n as u64).to_le_bytes());
        w.extend_from_slice(&(n as u64).to_le_bytes());
        w.extend_from_slice(&cd_size.to_le_bytes());
        w.extend_from_slice(&30u64.to_le_bytes());
        w.extend_from_slice(b"PK\x06\x07\0\0\0\0");
        w.extend_from_slice(&rec_off.to_le_bytes());
        w.extend_from_slice(&1u32.to_le_bytes());
        w.extend_from_slice(b"PK\x05\x06\0\0\0\0\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\0\0");
        w
    };
    let _ = z;
    let before = files_in(&t.d.lib);
    let tag = mio::in_put(&t.io, "z.zip", &z64, false).unwrap();
    assert_eq!(mio::in_import(&t.d, &t.io, &tag, "A", "x").unwrap_err().0, code::NO_SPACE);
    assert_eq!(files_in(&t.d.lib), before);
}

#[test]
fn zip64_extra_fields_are_read_in_order() {
    // M4: ZIP64 の追加欄は「展開の大きさ → 圧縮の大きさ」。deflate で 2 つが違う件を正しく読む
    let t = T::new("z64x");
    t.album("A");
    let mut data = KWZ.to_vec();
    data.extend_from_slice(&vec![b'z'; 5000]);
    let z = zip_with_sizes("A/y.kwz", &data, true, None, true);
    let es = zipio::read_directory(&mut Cursor::new(&z)).unwrap();
    assert_eq!(es[0].usize, data.len() as u64);
    assert!(es[0].csize < es[0].usize);
    let tag = mio::in_put(&t.io, "z.zip", &z, false).unwrap();
    let r = mio::in_import(&t.d, &t.io, &tag, "A", "x").unwrap();
    assert_eq!(sha(&fs::read(t.d.lib.join("A/y.kwz")).unwrap()), sha(&data));
    assert_eq!(r.placed.len(), 1);
}

#[test]
fn stale_name_cache_never_overwrites_existing_file() {
    // M6: 名前の覚えが古くても（外で同じ名前が置かれた）、置き換えない置き方で断られ、次の名前へ。既にある作品は 1 バイトも変わらない
    let t = T::new("stale");
    let a = t.album("A");
    let cache = mio::NameCache::load(&a).unwrap();
    fs::write(a.join("同じ.memoanima"), b"ORIGINAL").unwrap(); // 覚えたあとに外で置かれた
    let src = t.base.join("src.bin");
    fs::write(&src, pv6("new")).unwrap();
    let mut c = cache;
    let p = mio::place_file(&t.d, &a, "A", &src, Kind::WorkPv6, "同じ.memoanima", "x", Some(&mut Vec::new()), Some(&mut c)).unwrap();
    assert_eq!(p.name, "同じ (2).memoanima");
    assert_eq!(fs::read(a.join("同じ.memoanima")).unwrap(), b"ORIGINAL");
}
