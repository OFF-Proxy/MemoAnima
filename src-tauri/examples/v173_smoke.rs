//! V173（クラウド経由の改名 `.gz` からの復帰）の Rust 側スモーク。**GUI なし・事故そのものを再現する**。
//!
//! 使い方: `cargo run --example v173_smoke -- <作業用の親フォルダ>`
//!         （引数を省くと OS の一時フォルダを親にする）
//!
//! ★引数は**親フォルダ**です（独立レビューの指摘・優先度 高）。この下に `memoanima-v173-smoke-<pid>` を
//!  新しく作り、**自分が作ったそれだけ**を最後に消します。**渡したフォルダ自体は絶対に消しません**
//!  ——引数をそのままライブラリとして `remove_dir_all` する作りだと、実ライブラリを渡した瞬間に消えます。
//!
//! 何を確かめるか（受け入れ基準の番号は `docs/REQ_import_failures_and_gz.md` §5）:
//!   1. 事故の再現 — `.memoanima` が `.memoanima.gz` になると **`scan_library` から消える**
//!      （＝アルバムが 0 件に見える。`.kwz` は索引の行から出るので無事、という食い違いも見る）
//!   2. R-10 — その状態で**アルバムを削除しようとすると拒否される**（`others` 扱い＝データは失われない）
//!   3. R-5  — `scan_renamed_projects` が 1 件見つける
//!   4. R-6  — `fix_renamed_projects` で開けるようになり、**中身は 1 バイトも変わらない**（SHA-256 一致）
//!   5. R-9  — 同じ名前の作品が既にあるときは**飛ばす**（上書きしない・`.gz` はそのまま残る・本体は無傷）
//!   6. 対象外 — `.png.gz`（サイドカー）／ふつうの `.tar.gz`／中身が gzip でない `.memoanima.gz`
//!   7. `probe_project_file` は先頭 2B と末尾 16B だけで gzip / PV6 を見分ける
//!
//! **作者の実ライブラリには触らない。**引数で渡された（か一時フォルダに作った）場所だけを使う。

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

fn ok(msg: &str) {
    println!("  OK  {msg}");
}

/// PV6 の器に見えるバイト列（先頭 `1f 8b`＝gzip の magic ＋ 末尾 16B のトレーラ `AMPV6END`+u32×2）。
/// 中身は読まれないので、実体はダミーでよい（V173 が読むのは先頭 2B と末尾 16B だけ）。
fn pv6_body(tag: &str) -> Vec<u8> {
    let mut v: Vec<u8> = vec![0x1f, 0x8b, 0x08, 0x00];
    v.extend_from_slice(format!("V173-SMOKE:{tag}:").as_bytes());
    v.resize(v.len() + 64, b'#');
    v.extend_from_slice(b"AMPV6END");
    v.extend_from_slice(&[0u8; 8]);
    v
}

fn sha(p: &Path) -> String {
    let mut h = Sha256::new();
    h.update(fs::read(p).expect("read for sha"));
    format!("{:x}", h.finalize())
}

fn works_in(lib: &str, album: &str) -> usize {
    animemo_lib::pclib::scan_library(lib)
        .expect("scan_library")
        .iter()
        .filter(|v| v.album == album)
        .count()
}

fn main() {
    // ★引数は**親フォルダ**。この下に自分専用のフォルダを作り、消すのもそれだけ
    let parent: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let lib = parent.join(format!("memoanima-v173-smoke-{}", std::process::id()));
    let lib_s = lib.to_string_lossy().to_string();
    // 既にあったら**消さずに止める**（同名の何かを踏まないため）
    assert!(
        !lib.exists(),
        "作業フォルダが既にあります。中身を確認してから消してください: {lib_s}"
    );
    fs::create_dir_all(&lib).expect("作業フォルダの作成");
    println!("lib = {lib_s}  ← このフォルダだけを使い、最後に消します");

    let album = "V173検証";
    let dir = lib.join(album);
    fs::create_dir_all(&dir).expect("アルバム作成");

    // ---------------------------------------------------------------- 1) 事故の再現
    // クラウド経由で `.gz` が付いた状態のファイルを置く（中身は PV6 の器のまま）
    let gz = dir.join("作品A.memoanima.gz");
    let fixed = dir.join("作品A.memoanima");
    fs::write(&gz, pv6_body("A")).expect("write gz");
    let sha_before = sha(&gz);
    // サイドカーのサムネは Finder には見えている（＝「PNG はあるのに 0 件」の状態）
    fs::write(dir.join("作品A.memoanima.png"), [0u8; 8]).expect("write png");

    assert_eq!(works_in(&lib_s, album), 0, "改名されたままだと一覧に出ない（事故の再現）");
    ok("1) `.memoanima.gz` は scan_library から消える（アルバムが 0 件に見える）");

    // ---------------------------------------------------------------- 2) R-10 削除は拒否される
    let del = animemo_lib::pclib::delete_album(&lib_s, album);
    assert!(del.is_err(), "作品 0 件に見えてもアルバムは削除できない");
    assert!(gz.is_file(), "拒否されたのでファイルは残っている");
    ok("2) R-10: `.gz` だけのアルバムの削除は拒否される（データは失われない）");

    // ---------------------------------------------------------------- 3) R-5 見つける
    let found = animemo_lib::pclib::scan_renamed_projects(&lib_s).expect("scan_renamed");
    assert_eq!(found.len(), 1, "1 件見つかる: {found:?}");
    ok("3) R-5: scan_renamed_projects が 1 件見つける（.png.gz は数えない）");

    // ---------------------------------------------------------------- 4) R-6 直す＋中身は不変
    let r = animemo_lib::pclib::fix_renamed_projects(&lib_s).expect("fix");
    assert_eq!((r.renamed, r.skipped, r.errors.len()), (1, 0, 0), "1 件だけ改名");
    assert!(!gz.exists() && fixed.is_file(), "`.gz` が外れている");
    assert_eq!(sha(&fixed), sha_before, "★中身が 1 バイトも変わっていない");
    assert_eq!(works_in(&lib_s, album), 1, "一覧に戻る");
    ok("4) R-6: 直すと一覧に戻り、SHA-256 が改名前と一致（中身は 1 バイトも変わらない）");

    // ---------------------------------------------------------------- 5) R-9 上書きしない
    // 本体が在るところへ、同じ名前の `.gz` が来た状態
    fs::write(&gz, pv6_body("B")).expect("write gz again");
    let sha_fixed = sha(&fixed);
    let found2 = animemo_lib::pclib::scan_renamed_projects(&lib_s).expect("scan_renamed 2");
    assert!(found2.is_empty(), "対の実体があるので候補にしない: {found2:?}");
    let r2 = animemo_lib::pclib::fix_renamed_projects(&lib_s).expect("fix 2");
    assert_eq!((r2.renamed, r2.errors.len()), (0, 0), "1 件も改名しない");
    assert!(gz.is_file(), "`.gz` はそのまま残る");
    assert_eq!(sha(&fixed), sha_fixed, "★本体は無傷（上書きされていない）");
    ok("5) R-9: 同じ名前があるときは触らない（`.gz` は残る・本体は無傷）");
    fs::remove_file(&gz).expect("cleanup gz");

    // ---------------------------------------------------------------- 6) 対象外のもの
    fs::write(dir.join("サムネ.memoanima.png.gz"), pv6_body("P")).expect("write png.gz");
    fs::write(dir.join("something.tar.gz"), pv6_body("T")).expect("write tar.gz");
    fs::write(dir.join("中身が違う.memoanima.gz"), b"not gzip at all").expect("write fake");
    let found3 = animemo_lib::pclib::scan_renamed_projects(&lib_s).expect("scan_renamed 3");
    assert!(found3.is_empty(), "どれも候補にしない: {found3:?}");
    let r3 = animemo_lib::pclib::fix_renamed_projects(&lib_s).expect("fix 3");
    assert_eq!((r3.renamed, r3.skipped, r3.errors.len()), (0, 0, 0), "1 件も動かさない");
    assert!(dir.join("中身が違う.memoanima.gz").is_file(), "gzip でないものは触らない");
    ok("6) 対象外: `.png.gz` / ふつうの `.tar.gz` / 中身が gzip でないものは動かさない");

    // ---------------------------------------------------------------- 7) probe_project_file
    let p1 = animemo_lib::pclib::probe_project_file(&fixed.to_string_lossy()).expect("probe pv6");
    assert!(p1.gzip && p1.pv6 && p1.size > 16, "PV6 は gzip かつ pv6");
    let plain = dir.join("ただのテキスト.txt");
    fs::write(&plain, b"hello").expect("write txt");
    let p2 = animemo_lib::pclib::probe_project_file(&plain.to_string_lossy()).expect("probe txt");
    assert!(!p2.gzip && !p2.pv6 && p2.size == 5, "ふつうのファイルはどちらも false");
    let p3 = animemo_lib::pclib::probe_project_file(&dir.join("something.tar.gz").to_string_lossy())
        .expect("probe tar.gz");
    assert!(p3.gzip, "gzip の magic は拾う（通すかどうかは名前で決める＝フロント側）");
    assert!(
        animemo_lib::pclib::probe_project_file(&dir.join("居ない.memoanima").to_string_lossy())
            .is_err(),
        "無いファイルはエラー"
    );
    ok("7) probe_project_file: 先頭 2B と末尾 16B だけで gzip / PV6 を見分ける");

    // 自分が作ったフォルダ（名前で確かめてから）だけを消す
    if lib
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("memoanima-v173-smoke-"))
    {
        let _ = fs::remove_dir_all(&lib);
    }
    println!("\nv173 rust smoke: すべて OK（7 項目）");
}
