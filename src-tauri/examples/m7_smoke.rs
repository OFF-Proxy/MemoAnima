//! M7-1 R-A スモーク: ライブラリ索引の破損回復（退避＋ディスク再構築）
//! M7-2c N-3 スモーク: プロジェクト拡張子の両対応（.memoanima 新規保存・.animemo 恒久読込）
//! 実行: cargo run --example m7_smoke

use animemo_lib::pclib;

fn main() {
    let tmp = std::env::temp_dir().join(format!("animemo_m7_{}", std::process::id()));
    let album = tmp.join("テストアルバム");
    std::fs::create_dir_all(&album).unwrap();
    std::fs::write(album.join("a.kwz"), b"dummy-kwz-bytes-1").unwrap();
    std::fs::write(album.join("b.ppm"), b"dummy-ppm-bytes-22").unwrap();
    std::fs::write(album.join("ignore.txt"), b"not a note").unwrap();
    // 破損した索引
    std::fs::write(tmp.join("animemo-library.json"), b"{ broken json !!!").unwrap();

    // (1) heal_index: 破損検知 → true・.broken 退避・再構築保存
    let recovered = pclib::heal_index(tmp.to_str().unwrap()).unwrap();
    assert!(recovered, "破損索引で recovered=true になるべき");
    assert!(
        tmp.join("animemo-library.json.broken").is_file(),
        ".broken へ退避されるべき"
    );
    assert!(
        tmp.join("animemo-library.json").is_file(),
        "再構築された索引が保存されるべき"
    );

    // (2) 再構築内容: .kwz/.ppm の2件が再登録され一覧に出る（.txt は無視）
    let views = pclib::scan_library(tmp.to_str().unwrap()).unwrap();
    let notes: Vec<_> = views.iter().filter(|v| v.kind == "note").collect();
    assert_eq!(notes.len(), 2, "kwz/ppm が再登録されるべき: {views:?}");
    assert!(notes.iter().all(|n| n.album == "テストアルバム" && !n.hash.is_empty()));

    // (3) 正常索引では false（何もしない・.broken も増えない）
    let again = pclib::heal_index(tmp.to_str().unwrap()).unwrap();
    assert!(!again, "正常時は recovered=false");

    // (4) 索引が無いだけ（新規）のフォルダ → false（回復扱いしない）
    let fresh = tmp.join("fresh");
    std::fs::create_dir_all(&fresh).unwrap();
    assert!(!pclib::heal_index(fresh.to_str().unwrap()).unwrap());

    // (5) scan_library 側の自己修復: もう一度壊しても Err にならず一覧が返る
    std::fs::write(tmp.join("animemo-library.json"), b"broken again").unwrap();
    let views2 = pclib::scan_library(tmp.to_str().unwrap()).unwrap();
    assert_eq!(
        views2.iter().filter(|v| v.kind == "note").count(),
        2,
        "load_index 経由でも自己修復して一覧が返るべき"
    );

    // ---------------- M7-2c N-3: 拡張子両対応 ----------------

    // (6) 両拡張子スキャン: .animemo（旧）と .memoanima（新）が両方 project として列挙され、
    //     ext は実ファイルの拡張子を反映する
    std::fs::write(album.join("old.animemo"), b"legacy-project-bytes").unwrap();
    std::fs::write(album.join("new.memoanima"), b"new-project-bytes").unwrap();
    let views3 = pclib::scan_library(tmp.to_str().unwrap()).unwrap();
    let projects: Vec<_> = views3.iter().filter(|v| v.kind == "project").collect();
    assert_eq!(projects.len(), 2, "両拡張子が列挙されるべき: {projects:?}");
    let old = projects.iter().find(|p| p.name == "old.animemo").unwrap();
    let new = projects.iter().find(|p| p.name == "new.memoanima").unwrap();
    assert_eq!(old.ext, "animemo", "ext は実ファイルの拡張子");
    assert_eq!(new.ext, "memoanima", "ext は実ファイルの拡張子");

    // (7) 新規保存は .memoanima: 拡張子なしの名前 → .memoanima が付く
    let saved = pclib::save_project(
        tmp.to_str().unwrap(),
        "テストアルバム",
        "作品X",
        b"project-data-x",
        b"",
    )
    .unwrap();
    assert!(
        saved.ends_with("作品X.memoanima"),
        "新規保存は .memoanima になるべき: {saved}"
    );

    // (8) 旧拡張子ロード→保存の経路: 旧名 "old.animemo" のまま保存しても
    //     同一 basename の .memoanima に書かれ、旧ファイルは残る（削除しない）
    let saved2 = pclib::save_project(
        tmp.to_str().unwrap(),
        "テストアルバム",
        "old.animemo",
        b"resaved-from-legacy",
        b"",
    )
    .unwrap();
    assert!(
        saved2.ends_with("old.memoanima"),
        "旧拡張子名は .memoanima に付け替えて保存: {saved2}"
    );
    assert!(album.join("old.animemo").is_file(), "旧ファイルは残す");
    assert_eq!(
        std::fs::read(album.join("old.memoanima")).unwrap(),
        b"resaved-from-legacy",
        "新拡張子で再ロードした内容が保存時と一致するべき"
    );

    // (9) 削除は両拡張子とも可（プロジェクト経路・hash 空）
    pclib::delete_item(tmp.to_str().unwrap(), "", "テストアルバム", "old.animemo").unwrap();
    assert!(!album.join("old.animemo").exists(), "旧拡張子も削除できるべき");
    pclib::delete_item(tmp.to_str().unwrap(), "", "テストアルバム", "new.memoanima").unwrap();
    assert!(!album.join("new.memoanima").exists(), "新拡張子も削除できるべき");

    std::fs::remove_dir_all(&tmp).ok();
    println!("m7 smoke: pass (索引破損回復 5チェック + 拡張子両対応 4チェック)");
}
