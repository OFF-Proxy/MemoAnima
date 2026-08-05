//! M3.4 L-1 delete_item のスモークテスト（GUIなし・Codexレビュー反映版）
//! 使い方: cargo run --example delete_smoke -- <取り込み元(小さめ)> <一時ライブラリフォルダ>
//! 検証: 索引ベースの対象解決・封じ込め・索引先行削除・再取り込み復活・不正引数の拒否

fn main() {
    let src = std::env::args().nth(1).expect("引数1: 取り込み元");
    let lib = std::env::args().nth(2).expect("引数2: 一時ライブラリ");
    let _ = std::fs::remove_dir_all(&lib);
    std::fs::create_dir_all(&lib).expect("lib作成");

    let r1 = animemo_lib::pclib::import(&src, &lib, |_| {}).expect("import");
    println!("imported={} skipped={}", r1.imported, r1.skipped);
    let items = animemo_lib::pclib::scan_library(&lib).expect("scan");
    let n0 = items.len();
    let victim = items[0].hash.clone();
    let victim_path = items[0].path.clone();

    // ガード1: lib_root にファイル（取り込み元の実ファイル）を渡す → Err
    let src_file = std::fs::read_dir(&src)
        .unwrap()
        .flatten()
        .find(|e| e.path().is_file())
        .expect("srcにファイルがない");
    let res = animemo_lib::pclib::delete_item(
        src_file.path().to_str().unwrap(), // lib_root がファイル
        &victim,
        "",
        "",
    );
    assert!(res.is_err(), "lib_root=ファイル が通ってしまう!");
    assert!(src_file.path().exists(), "取り込み元が消えた!");
    println!("guard lib_root=file: OK ({})", res.unwrap_err());

    // ガード2: 存在しない hash → Err（何も消えない）
    let res = animemo_lib::pclib::delete_item(&lib, &"0".repeat(64), "", "");
    assert!(res.is_err(), "未知hashが通ってしまう!");
    println!("guard unknown-hash: OK");

    // ガード3: プロジェクト指定でトラバーサル album/name → Err か無害化（.animemo必須で拒否）
    let res = animemo_lib::pclib::delete_item(&lib, "", "..", "..\\..\\evil.txt");
    assert!(res.is_err(), "トラバーサルが通ってしまう!");
    println!("guard traversal: OK ({})", res.unwrap_err());

    // ガード4: プロジェクト指定で .animemo 以外 → Err（索引ファイル等を消せない）
    let res = animemo_lib::pclib::delete_item(&lib, "", "x", "animemo-library.json");
    assert!(res.is_err(), ".animemo以外が通ってしまう!");
    println!("guard non-project: OK ({})", res.unwrap_err());

    // 正規の削除（索引から rel_path を解決）
    animemo_lib::pclib::delete_item(&lib, &victim, "", "").expect("delete_item");
    assert!(!std::path::Path::new(&victim_path).exists(), "ファイルが残っている");
    let items2 = animemo_lib::pclib::scan_library(&lib).expect("scan2");
    assert_eq!(items2.len(), n0 - 1, "索引から消えていない");
    assert!(!items2.iter().any(|i| i.hash == victim), "索引に残骸がある");
    println!("delete: OK ({} -> {})", n0, items2.len());

    // 削除済みハッシュへの save_thumb は拒否（残骸サムネの復活防止）
    let res = animemo_lib::pclib::save_thumb(&lib, &victim, &[0u8; 8]);
    assert!(res.is_err(), "削除済みhashのサムネが書けてしまう!");
    println!("guard thumb-after-delete: OK");

    // 再取り込みで復活（=元データ非接触の裏取り）
    let r2 = animemo_lib::pclib::import(&src, &lib, |_| {}).expect("re-import");
    assert_eq!(r2.imported, 1, "再取り込みで1件だけ復活するはず");
    let items3 = animemo_lib::pclib::scan_library(&lib).expect("scan3");
    assert_eq!(items3.len(), n0, "復活後の件数が一致しない");
    println!("re-import: OK (imported={} total={})", r2.imported, items3.len());
    println!("delete_smoke: ALL OK");
}
