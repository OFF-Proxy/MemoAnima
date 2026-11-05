//! V212 (M-1c・D-M1-3): Android の分けて送る・受け取る道（`chunks.rs`）の単体テスト（%TEMP% の下の本物のファイル）。
//! 要件 §6-3（全部そろわないと書き始めない・保存とオートセーブの塊を混ぜない・途中で止まった塊は次の起動で片付く・512MiB の上限）。
//! `scripts/v212_smoke.ts` [T] が回す。★塊の状態はプロセスに 1 つ（アプリと同じ）なので、このファイルの試しは鍵で 1 本ずつ走らせる

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use super::chunks::{self, b64_decode, b64_encode, Kind, CHUNK_DIR, CHUNK_MAX};
use super::commands::{self, ChunkBeginArgs, ChunkPutArgs, DownloadArgs, ReadBeginArgs, ReadSliceArgs, UploadArgs, WorkArgs};
use super::fingerprint::Fingerprint;
use super::save::NoHooks;
use super::{code, port_body_for_test, Dirs, Refusal};

static N: AtomicU64 = AtomicU64::new(0);
static ONE: Mutex<()> = Mutex::new(());

struct T {
    base: PathBuf,
    d: Dirs,
}
impl T {
    fn new(tag: &str) -> T {
        let base = std::env::temp_dir().join(format!("v212-chunks-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&base);
        let lib = base.join("lib");
        fs::create_dir_all(lib.join("A")).unwrap();
        let d = Dirs::under(lib, &base.join("config"));
        fs::create_dir_all(&d.config).unwrap();
        T { base, d }
    }
}
impl Drop for T {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    ONE.lock().unwrap_or_else(|e| e.into_inner())
}

/// 見本の作品（大きさを決めて・中身は決まった乱れ）
fn work(n: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.wrapping_mul(2654435761).wrapping_add(1);
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

fn files_under(p: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(p) {
        for e in rd.flatten() {
            let q = e.path();
            if q.is_dir() {
                out.extend(files_under(&q));
            } else {
                out.push(q);
            }
        }
    }
    out
}

/// JS の口と同じ形で送る（4MiB の塊・base64）。index の並びを変えて送る試しのため、送る順を渡せる
fn send(d: &Dirs, kind: &str, body: &[u8], session: Option<&str>, gen: Option<u64>) -> Result<String, Refusal> {
    let up = commands::args_chunk_begin(d, &ChunkBeginArgs { kind: kind.into(), total: body.len() as u64, session: session.map(String::from), gen })?;
    for (i, c) in body.chunks(CHUNK_MAX).enumerate() {
        commands::args_chunk_put(d, &ChunkPutArgs { upload: up.clone(), index: i as u32, data: b64_encode(c) })?;
    }
    Ok(up)
}

fn new_body(name: &str, data: &[u8], thumb: &[u8]) -> Vec<u8> {
    port_body_for_test(&serde_json::json!({ "album": "A", "name": name, "selfName": null }), &[data, thumb])
}

fn ow_body(name: &str, src: &[u8], data: &[u8]) -> Vec<u8> {
    let f = Fingerprint::of_bytes(src);
    port_body_for_test(&serde_json::json!({ "album": "A", "name": name, "sourceFingerprint": { "sha256": f.sha256, "size": f.size } }), &[data, b"PNG"])
}

fn up(u: &str) -> UploadArgs {
    UploadArgs { upload: u.into() }
}

#[test]
fn base64_roundtrip_and_refusals() {
    for n in 0..40usize {
        let b = work(n, n as u32);
        assert_eq!(b64_decode(&b64_encode(&b)).unwrap(), b, "{n}");
    }
    let big = work(CHUNK_MAX, 9);
    assert_eq!(b64_decode(&b64_encode(&big)).unwrap(), big);
    for bad in ["A", "AB=", "A===", "AB=C", "AA==AAAA", "AA\u{3042}A", "AA-_", "AA A"] {
        assert!(b64_decode(bad).is_none(), "{bad}");
    }
}

/// ★分けて送った新しい保存は、生のボディの道（今の 1 段）と同じバイト列を書く・塊の置き場はライブラリの外で、終わると何も残らない
#[test]
fn chunked_save_new_equals_raw_and_cleans_up() {
    let _g = lock();
    let t = T::new("new");
    let r = T::new("raw");
    let data = work(CHUNK_MAX * 2 + 12345, 1);
    let body = new_body("作品", &data, b"THUMB");
    let u = send(&t.d, "saveNew", &body, None, None).unwrap();
    // 送っている間の置き場は app_config_dir/mobile-chunks の下（ライブラリの中ではない）
    let staged = files_under(&t.d.config.join(CHUNK_DIR));
    assert_eq!(staged.len(), 1);
    assert!(!staged[0].starts_with(&t.d.lib));
    assert_eq!(fs::metadata(&staged[0]).unwrap().len(), body.len() as u64);
    let res = commands::args_chunk_save_new(&t.d, &up(&u), &mut NoHooks).unwrap();
    let raw = commands::body_save_new(&r.d, &body, &mut NoHooks).unwrap();
    assert_eq!(res.fingerprint, raw.fingerprint);
    assert_eq!(fs::read(t.d.lib.join("A").join("作品.memoanima")).unwrap(), data);
    assert_eq!(fs::read(t.d.lib.join("A").join("作品.memoanima")).unwrap(), fs::read(r.d.lib.join("A").join("作品.memoanima")).unwrap());
    assert_eq!(fs::read(t.d.lib.join("A").join("作品.memoanima.png")).unwrap(), b"THUMB");
    assert!(files_under(&t.d.config.join(CHUNK_DIR)).is_empty(), "置き場に塊が残った");
    assert_eq!(chunks::open_counts().0, 0);
    // 同じ番号でもう 1 回は受け取らない（1 回だけ）
    assert_eq!(commands::args_chunk_save_new(&t.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
}

/// ★欠ける・順番が違う・多すぎる・大きすぎる・種類が違う → 書かずに断り、既存の作品は 1 バイトも変わらない
#[test]
fn chunked_refusals_never_touch_existing_work() {
    let _g = lock();
    let t = T::new("refuse");
    let a = t.d.lib.join("A");
    let v1 = work(1000, 2);
    fs::write(a.join("w.memoanima"), &v1).unwrap();
    let before = files_under(&t.d.lib).len();
    let data = work(CHUNK_MAX * 2 + 7, 3);
    let body = ow_body("w.memoanima", &v1, &data);
    let parts: Vec<&[u8]> = body.chunks(CHUNK_MAX).collect();
    assert_eq!(parts.len(), 3);
    let begin = |kind: &str| commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: kind.into(), total: body.len() as u64, session: None, gen: None }).unwrap();
    let put = |u: &str, i: u32, c: &[u8]| commands::args_chunk_put(&t.d, &ChunkPutArgs { upload: u.into(), index: i, data: b64_encode(c) });
    let unchanged = |why: &str| {
        assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), v1, "{why}");
        assert_eq!(files_under(&t.d.lib).len(), before, "{why}");
        assert!(files_under(&t.d.config.join(CHUNK_DIR)).is_empty(), "{why}: 置き場に塊が残った");
    };
    // 欠ける（2 つだけで受け取る）
    let u = begin("saveOverwrite");
    put(&u, 0, parts[0]).unwrap();
    put(&u, 1, parts[1]).unwrap();
    assert_eq!(commands::args_chunk_save_overwrite(&t.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    unchanged("欠ける");
    // 順番が違う（1 から送る）→ そのあと正しく送り直しても、その送りは受け取らない
    let u = begin("saveOverwrite");
    assert!(put(&u, 1, parts[1]).is_err());
    put(&u, 0, parts[0]).unwrap_err();
    assert_eq!(commands::args_chunk_save_overwrite(&t.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    unchanged("順番が違う");
    // 同じ番号を 2 回（入れ替わり）
    let u = begin("saveOverwrite");
    put(&u, 0, parts[0]).unwrap();
    assert!(put(&u, 0, parts[0]).is_err());
    assert_eq!(commands::args_chunk_save_overwrite(&t.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    unchanged("同じ番号を 2 回");
    // 多すぎる（4 つ目）
    let u = begin("saveOverwrite");
    for (i, c) in parts.iter().enumerate() {
        put(&u, i as u32, c).unwrap();
    }
    assert!(put(&u, 3, b"x").is_err());
    assert_eq!(commands::args_chunk_save_overwrite(&t.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    unchanged("多すぎる");
    // 大きすぎる塊（4MiB＋1）・大きさの違う塊
    let u = begin("saveOverwrite");
    let mut fat = parts[0].to_vec();
    fat.push(0);
    assert!(put(&u, 0, &fat).is_err());
    assert_eq!(commands::args_chunk_save_overwrite(&t.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    let u = begin("saveOverwrite");
    assert!(put(&u, 0, &parts[0][..CHUNK_MAX - 1]).is_err());
    unchanged("大きすぎる・大きさが違う");
    // 全部の大きさが 512MiB を超える・0
    assert_eq!(commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "saveNew".into(), total: 512 * 1024 * 1024 + 1, session: None, gen: None }).unwrap_err(), Refusal(code::TOO_LARGE));
    assert_eq!(commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "saveNew".into(), total: 0, session: None, gen: None }).unwrap_err(), Refusal(code::BAD_REQUEST));
    assert_eq!(commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "other".into(), total: 9, session: None, gen: None }).unwrap_err(), Refusal(code::BAD_REQUEST));
    // 種類が違う（上書きで始めて、新しく保存として受け取る）
    let u = begin("saveOverwrite");
    for (i, c) in parts.iter().enumerate() {
        put(&u, i as u32, c).unwrap();
    }
    assert_eq!(commands::args_chunk_save_new(&t.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    unchanged("種類が違う");
    // 壊れた base64
    let u = begin("saveOverwrite");
    assert!(commands::args_chunk_put(&t.d, &ChunkPutArgs { upload: u.clone(), index: 0, data: "!!!!".into() }).is_err());
    assert_eq!(commands::args_chunk_save_overwrite(&t.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    unchanged("壊れた base64");
    // 番号の形が違う・知らない番号
    assert!(put("../../x", 0, b"a").is_err());
    assert!(put("0123456789abcdef0123456789abcdef", 0, b"a").is_err());
    // 正しく送れば書ける（対照）
    let u = send(&t.d, "saveOverwrite", &body, None, None).unwrap();
    commands::args_chunk_save_overwrite(&t.d, &up(&u), &mut NoHooks).unwrap();
    assert_eq!(fs::read(a.join("w.memoanima")).unwrap(), data);
    assert_eq!(fs::read(a.join("w.memoanima.bak")).unwrap(), v1);
}

/// ★保存とオートセーブの塊は別の組（混ざらない）。オートセーブは始めたときの番号と世代が封筒の印と同じときだけ書く
#[test]
fn chunked_save_and_autosave_do_not_mix() {
    let _g = lock();
    let t = T::new("mix");
    let sid = "0123456789abcdef0123456789abcdef";
    let other = "fedcba9876543210fedcba9876543210";
    let am = |s: &str, g: u64, data: &[u8]| port_body_for_test(&serde_json::json!({ "session": s, "gen": g, "meta": { "title": "見本" } }), &[data]);
    let data = work(CHUNK_MAX + 99, 4);
    let save = new_body("作品", &work(5000, 5), b"");
    // 保存とオートセーブを並べて送る（どちらも生きている）
    let us = send(&t.d, "saveNew", &save, None, None).unwrap();
    let ua = send(&t.d, "autosave", &am(sid, 3, &data), Some(sid), Some(3)).unwrap();
    assert_eq!(chunks::open_counts().0, 2);
    // 取り違え: オートセーブの番号で保存を受け取る・保存の番号でオートセーブを受け取る → どちらも断って捨てる
    assert_eq!(commands::args_chunk_save_new(&t.d, &up(&ua), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    assert_eq!(commands::args_chunk_autosave_write(&t.d, &up(&us)).unwrap_err(), Refusal(code::BAD_REQUEST));
    assert!(files_under(&t.d.sessions).is_empty());
    assert!(files_under(&t.d.lib.join("A")).is_empty());
    // 違うセッションの印の封筒（始めたときと違う）→ 書かない
    let u = send(&t.d, "autosave", &am(other, 3, &data), Some(sid), Some(3)).unwrap();
    assert_eq!(commands::args_chunk_autosave_write(&t.d, &up(&u)).unwrap_err(), Refusal(code::BAD_REQUEST));
    // 違う世代
    let u = send(&t.d, "autosave", &am(sid, 4, &data), Some(sid), Some(3)).unwrap();
    assert_eq!(commands::args_chunk_autosave_write(&t.d, &up(&u)).unwrap_err(), Refusal(code::BAD_REQUEST));
    assert!(files_under(&t.d.sessions).is_empty(), "混ざった塊でオートセーブを書いた");
    // オートセーブは番号と世代が要る・保存は要らない
    assert!(commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "autosave".into(), total: 9, session: None, gen: Some(1) }).is_err());
    assert!(commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "saveNew".into(), total: 9, session: Some(sid.into()), gen: Some(1) }).is_err());
    // 同じ組の新しい始まりは、前の途中の分を捨てる（列で順に行う）。別の組は捨てない
    let s1 = commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "saveNew".into(), total: 9, session: None, gen: None }).unwrap();
    let a1 = commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "autosave".into(), total: 9, session: Some(sid.into()), gen: Some(5) }).unwrap();
    let _s2 = commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "saveOverwrite".into(), total: 9, session: None, gen: None }).unwrap();
    assert!(commands::args_chunk_put(&t.d, &ChunkPutArgs { upload: s1, index: 0, data: b64_encode(b"123456789") }).is_err());
    commands::args_chunk_put(&t.d, &ChunkPutArgs { upload: a1.clone(), index: 0, data: b64_encode(b"123456789") }).unwrap();
    commands::args_chunk_abort(&up(&a1)).unwrap();
    // 正しい組み合わせは書ける（対照）。オートセーブの中身は送ったとおり
    let u = send(&t.d, "autosave", &am(sid, 6, &data), Some(sid), Some(6)).unwrap();
    commands::args_chunk_autosave_write(&t.d, &up(&u)).unwrap();
    let read = super::sessions::read(&t.d, sid).unwrap();
    assert!(read.ends_with(&data));
    // 後片付け
    for x in [us] {
        chunks::abort(&x);
    }
    chunks::abort(&_s2);
}

/// ★途中で止まった塊（前の起動のフォルダ）は、次に始めるとき・起動のときの片付けで消える。この起動の分は残す。リンクはたどらない
#[test]
fn stale_chunks_are_swept() {
    let _g = lock();
    let t = T::new("sweep");
    let root = t.d.config.join(CHUNK_DIR);
    let old = root.join("00000000deadbeef");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("a.part"), b"half").unwrap();
    fs::write(root.join("stray.part"), b"x").unwrap();
    // 外の大事なフォルダ（片付けが中へ入ってはいけない）
    let keep = t.base.join("keep");
    fs::create_dir_all(&keep).unwrap();
    fs::write(keep.join("precious"), b"P").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&keep, root.join("link")).unwrap();
    let u = commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "saveNew".into(), total: 9, session: None, gen: None }).unwrap();
    assert!(!old.exists() && !root.join("stray.part").exists());
    assert!(root.join(chunks::boot_for_test()).exists(), "この起動の置き場が消えた");
    assert_eq!(fs::read(keep.join("precious")).unwrap(), b"P");
    // もう 1 回片付けても、この起動の途中の分は残る（WebView だけ読み込み直したとき）
    chunks::sweep(&t.d);
    commands::args_chunk_put(&t.d, &ChunkPutArgs { upload: u.clone(), index: 0, data: b64_encode(b"123456789") }).unwrap();
    chunks::abort(&u);
    assert!(files_under(&root).is_empty());
}

/// ★試験用のライブラリへ切り替えた（置き場が変わった）あとは、前の置き場で始めた塊を受け取らない
#[test]
fn chunks_follow_the_library_switch() {
    let _g = lock();
    let real = T::new("real");
    let test = T::new("test");
    let body = new_body("作品", &work(100, 6), b"");
    let u = send(&real.d, "saveNew", &body, None, None).unwrap();
    assert_eq!(commands::args_chunk_save_new(&test.d, &up(&u), &mut NoHooks).unwrap_err(), Refusal(code::BAD_REQUEST));
    assert!(files_under(&test.d.lib.join("A")).is_empty());
    assert!(files_under(&real.d.lib.join("A")).is_empty());
    let u = commands::args_chunk_begin(&real.d, &ChunkBeginArgs { kind: "saveNew".into(), total: body.len() as u64, session: None, gen: None }).unwrap();
    assert!(commands::args_chunk_put(&test.d, &ChunkPutArgs { upload: u.clone(), index: 0, data: b64_encode(&body) }).is_err());
    chunks::abort(&u);
}

/// ★分けて受け取る: 今の 1 段（args_read_work）と同じ封筒を 4MiB 以下の切れ端で返す。範囲の外・大きすぎる切れ端は断る
#[test]
fn chunked_read_equals_whole_read() {
    let _g = lock();
    let t = T::new("read");
    let data = work(CHUNK_MAX * 2 + 3, 7);
    fs::write(t.d.lib.join("A").join("w.memoanima"), &data).unwrap();
    let whole = commands::args_read_work(&t.d, &WorkArgs { album: "A".into(), name: "w.memoanima".into() }).unwrap();
    let h = commands::args_read_begin(&t.d, &ReadBeginArgs { kind: "work".into(), album: Some("A".into()), name: Some("w.memoanima".into()), session: None }).unwrap();
    assert_eq!(h.size, whole.len() as u64);
    let mut got = Vec::new();
    let mut off = 0u64;
    while off < h.size {
        let len = (h.size - off).min(CHUNK_MAX as u64);
        got.extend(commands::args_read_slice(&ReadSliceArgs { download: h.download.clone(), offset: off, len }).unwrap());
        off += len;
    }
    assert_eq!(got, whole);
    assert!(commands::args_read_slice(&ReadSliceArgs { download: h.download.clone(), offset: 0, len: CHUNK_MAX as u64 + 1 }).is_err());
    assert!(commands::args_read_slice(&ReadSliceArgs { download: h.download.clone(), offset: h.size - 1, len: 2 }).is_err());
    assert!(commands::args_read_slice(&ReadSliceArgs { download: h.download.clone(), offset: u64::MAX, len: 2 }).is_err());
    commands::args_read_end(&DownloadArgs { download: h.download.clone() }).unwrap();
    assert!(commands::args_read_slice(&ReadSliceArgs { download: h.download, offset: 0, len: 1 }).is_err());
    // 読む道の決まりはそのまま（ライブラリの外・形の違う引数は断る）
    assert!(commands::args_read_begin(&t.d, &ReadBeginArgs { kind: "work".into(), album: Some("..".into()), name: Some("w.memoanima".into()), session: None }).is_err());
    assert!(commands::args_read_begin(&t.d, &ReadBeginArgs { kind: "work".into(), album: Some("A".into()), name: Some("../w.memoanima".into()), session: None }).is_err());
    assert!(commands::args_read_begin(&t.d, &ReadBeginArgs { kind: "autosave".into(), album: Some("A".into()), name: None, session: Some("0123456789abcdef0123456789abcdef".into()) }).is_err());
    assert!(commands::args_read_begin(&t.d, &ReadBeginArgs { kind: "autosave".into(), album: None, name: None, session: Some("../x".into()) }).is_err());
    // 置き場に絶対パスを書いていない（決-4）: 設定の置き場の中のファイルに、ライブラリのパスの字が無い
    for f in files_under(&t.d.config) {
        let b = fs::read(&f).unwrap();
        let s = String::from_utf8_lossy(&b);
        assert!(!s.contains(&*t.d.lib.to_string_lossy()), "{}", f.display());
    }
    let _ = Kind::SaveNew;
}

/// ★Android だけの命令の名前と引数の見本が、約束の表（contract.json の androidCommands）と同じ・Android の登録の表（mobile_app.rs）と同じ並び。
/// iOS の表（commands）には入っていない
#[test]
fn android_commands_match_contract_and_registration() {
    let c: serde_json::Value = serde_json::from_str(super::contract::CONTRACT_JSON).unwrap();
    let list = c["androidCommands"].as_array().unwrap();
    let names: Vec<&str> = list.iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(names, commands::ANDROID_COMMANDS);
    let ios: Vec<&str> = c["commands"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
    for n in &names {
        assert!(!ios.contains(n), "{n} が iOS の表にある");
    }
    for x in list {
        let a = x["args"].clone();
        let ok = match x["argsType"].as_str().unwrap() {
            "ChunkBeginArgs" => serde_json::from_value::<ChunkBeginArgs>(a).is_ok(),
            "ChunkPutArgs" => serde_json::from_value::<ChunkPutArgs>(a).is_ok(),
            "UploadArgs" => serde_json::from_value::<UploadArgs>(a).is_ok(),
            "ReadBeginArgs" => serde_json::from_value::<ReadBeginArgs>(a).is_ok(),
            "ReadSliceArgs" => serde_json::from_value::<ReadSliceArgs>(a).is_ok(),
            "DownloadArgs" => serde_json::from_value::<DownloadArgs>(a).is_ok(),
            other => panic!("知らない型 {other}"),
        };
        assert!(ok, "{}", x["name"]);
    }
    // Android の登録の表: #[cfg(target_os = "android")] の付いた命令の並び
    let app = include_str!("../../mobile_app.rs");
    let reg: Vec<&str> = app.split("#[cfg(target_os = \"android\")]\n").skip(1).map(|s| s.trim_start().split(',').next().unwrap().trim()).filter(|s| s.starts_with("mobile_")).collect();
    assert_eq!(reg, commands::ANDROID_COMMANDS);
}

/// 置き場（mobile-chunks）の場所へ、外のフォルダを指すリンクを作る（Unix はシンボリックリンク・Windows はシンボリックリンク〔作れなければ飛ばす〕）
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        // ジャンクションは std で作れない（Windows のジャンクションの場合は scripts/v212_smoke.ts [P] が本物の Rust で見る）
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }
}

/// ★（V212 独立レビュー 高）置き場そのもの（mobile-chunks）が外のフォルダ（ライブラリ）を指すリンクでも、片付けも始めることもリンクの先を消さない・
/// 断る（outside）。この起動のフォルダがリンクでも断る
#[test]
fn chunk_root_link_is_refused_and_never_followed() {
    let _g = lock();
    let t = T::new("rootlink");
    let precious = t.d.lib.join("A").join("w.memoanima");
    fs::write(&precious, b"PRECIOUS").unwrap();
    fs::create_dir_all(t.d.lib.join("A").join("sub")).unwrap();
    fs::write(t.d.lib.join("A").join("sub").join("x.memoanima"), b"X").unwrap();
    let root = t.d.config.join(CHUNK_DIR);
    if !link_dir(&t.d.lib, &root) {
        eprintln!("リンクを作れない環境（飛ばす）");
        return;
    }
    assert_eq!(chunks::sweep(&t.d), 0);
    let r = commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "saveNew".into(), total: 9, session: None, gen: None });
    assert_eq!(r.unwrap_err(), Refusal(code::OUTSIDE));
    assert_eq!(fs::read(&precious).unwrap(), b"PRECIOUS");
    assert_eq!(fs::read(t.d.lib.join("A").join("sub").join("x.memoanima")).unwrap(), b"X");
    assert!(!t.d.lib.join(chunks::boot_for_test()).exists(), "リンクの先に起動のフォルダを作った");
    // リンクを外して、この起動のフォルダだけをリンクにしても断る
    #[cfg(windows)]
    let _ = fs::remove_dir(&root);
    #[cfg(unix)]
    let _ = fs::remove_file(&root);
    fs::create_dir_all(&root).unwrap();
    if link_dir(&t.d.lib, &root.join(chunks::boot_for_test())) {
        let r = commands::args_chunk_begin(&t.d, &ChunkBeginArgs { kind: "saveNew".into(), total: 9, session: None, gen: None });
        assert_eq!(r.unwrap_err(), Refusal(code::OUTSIDE));
        assert_eq!(fs::read(&precious).unwrap(), b"PRECIOUS");
    }
}

/// ★（V212 独立レビュー 検査の穴）種類の照合は take そのものが断る（後段の封筒の形に頼らない）
#[test]
fn take_refuses_other_kind_by_itself() {
    let _g = lock();
    let t = T::new("kind");
    for (began, asked) in [(Kind::SaveNew, Kind::SaveOverwrite), (Kind::SaveOverwrite, Kind::SaveNew), (Kind::SaveNew, Kind::Autosave)] {
        let u = chunks::begin(&t.d, began, 3, None, None).unwrap();
        chunks::put(&t.d, &u, 0, &b64_encode(b"abc")).unwrap();
        assert_eq!(chunks::take(&t.d, &u, asked).err(), Some(Refusal(code::BAD_REQUEST)), "{began:?} → {asked:?}");
    }
    let u = chunks::begin(&t.d, Kind::SaveNew, 3, None, None).unwrap();
    chunks::put(&t.d, &u, 0, &b64_encode(b"abc")).unwrap();
    assert_eq!(chunks::take(&t.d, &u, Kind::SaveNew).unwrap().body, b"abc");
}

/// ★（V212 わざと壊す試し）欠けた送りは take そのものが断る（封筒の長さの確かめ〔lib.rs の parse_save_envelope〕に頼らない）
#[test]
fn take_refuses_incomplete_by_itself() {
    let _g = lock();
    let t = T::new("incomplete");
    let total = (CHUNK_MAX + 5) as u64;
    let u = chunks::begin(&t.d, Kind::SaveNew, total, None, None).unwrap();
    chunks::put(&t.d, &u, 0, &b64_encode(&work(CHUNK_MAX, 11))).unwrap();
    assert_eq!(chunks::take(&t.d, &u, Kind::SaveNew).err(), Some(Refusal(code::BAD_REQUEST)));
    assert!(files_under(&t.d.config.join(CHUNK_DIR)).is_empty());
}
