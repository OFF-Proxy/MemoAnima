//! M2 取り込みパイプラインのスモークテスト（GUIなし）
//! 使い方: cargo run --example import_smoke -- <取り込み元> <ライブラリフォルダ>
//! 2回実行して冪等性（2回目は新規0件）も確認する。
//! M10-18: 索引の自己修復（幽霊行掃除・重複行防止・SD再取り込み復旧）のケースを追加。
//! **取り込み元（src）は read-only。手動操作の再現はすべて lib（検証用スクラッチ）側のみ。**

use std::path::Path;

fn main() {
    let src = std::env::args().nth(1).expect("引数1: 取り込み元");
    let lib = std::env::args().nth(2).expect("引数2: ライブラリフォルダ");
    std::fs::create_dir_all(&lib).expect("ライブラリフォルダ作成");

    let r1 = animemo_lib::pclib::import(&src, &lib, |_| {}).expect("import 1回目");
    println!(
        "run1: total={} imported={} skipped={} failed={}",
        r1.total, r1.imported, r1.skipped, r1.failed
    );
    for e in r1.errors.iter().take(10) {
        println!("  error: {e}");
    }

    let r2 = animemo_lib::pclib::import(&src, &lib, |_| {}).expect("import 2回目");
    println!(
        "run2: total={} imported={} skipped={} failed={}",
        r2.total, r2.imported, r2.skipped, r2.failed
    );

    let items = animemo_lib::pclib::scan_library(&lib).expect("scan_library");
    let albums: std::collections::BTreeSet<_> = items.iter().map(|i| i.album.clone()).collect();
    println!("library: {} items / {} albums", items.len(), albums.len());

    // ---------------- M10-18: 索引の自己修復 ----------------
    let mut pass = 0u32;
    let mut fail = 0u32;
    let mut check = |name: &str, ok: bool| {
        if ok {
            pass += 1;
            println!("ok - {name}");
        } else {
            fail += 1;
            println!("NG - {name}");
        }
    };
    let index_path = Path::new(&lib).join("animemo-library.json");
    let read_index = || std::fs::read(&index_path).expect("索引の読み込み");
    let index_json =
        |bytes: &[u8]| -> serde_json::Value { serde_json::from_slice(bytes).expect("索引JSON") };
    let rows_for = |bytes: &[u8], hash: &str| -> usize {
        index_json(bytes)["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["hash"] == hash)
            .count()
    };
    let total_rows =
        |bytes: &[u8]| -> usize { index_json(bytes)["items"].as_array().unwrap().len() };

    let notes: Vec<_> = items.iter().filter(|i| i.kind == "note").collect();
    assert!(notes.len() >= 7, "検証には note が7件以上必要");

    // P-3-5: 手動操作をしていないライブラリでは scan 前後で索引がバイト不変
    {
        let before = read_index();
        animemo_lib::pclib::scan_library(&lib).expect("scan");
        let after = read_index();
        check("P-3-5 手動操作なし: scan 前後で索引バイト不変", before == after);
    }

    // P-3-1: 友人の再現手順 — 取り込み済み kwz を手でライブラリ外へ移動 → 同ファイルを取り込み
    //        → 同ハッシュの行が1行だけ（幽霊行を消してから push）
    let out_dir = std::env::temp_dir().join("m18_smoke_out");
    std::fs::create_dir_all(&out_dir).expect("退避フォルダ");
    let x = notes[0];
    {
        let moved = out_dir.join(&x.name);
        std::fs::rename(&x.path, &moved).expect("手動移動の再現");
        let (newp, hash) = animemo_lib::pclib::import_single_file(
            &lib,
            moved.to_str().unwrap(),
            "受け取り",
        )
        .expect("import_single_file");
        check("P-3-1 同ハッシュの行が1行だけ", rows_for(&read_index(), &hash) == 1);
        check("P-3-1 作品がライブラリに戻る", Path::new(&newp).is_file());
        check("P-3-1 ハッシュ不変", hash == x.hash);
    }

    // P-3-2: エクスプローラーの Ctrl+Z 相当で元の場所にもファイルを復活（両方実在）
    //        → 行は1行のまま（新しい方）・古い実ファイルはアプリが消さない・表示も1件
    {
        let moved = out_dir.join(&x.name);
        std::fs::copy(&moved, &x.path).expect("Ctrl+Z の再現");
        let view = animemo_lib::pclib::scan_library(&lib).expect("scan");
        check("P-3-2 両方実在でも行は1行のまま", rows_for(&read_index(), &x.hash) == 1);
        check("P-3-2 実ファイルを勝手に消さない", Path::new(&x.path).is_file());
        check(
            "P-3-2 二重サムネにならない（note表示1件）",
            view.iter().filter(|i| i.kind == "note" && i.hash == x.hash).count() == 1,
        );
    }

    // P-3-3: 復旧経路 — 手動削除 → SD（src）から再取り込み → skipped ではなく imported
    let y = notes[1];
    {
        std::fs::remove_file(&y.path).expect("手動削除の再現");
        let r3 = animemo_lib::pclib::import(&src, &lib, |_| {}).expect("import 3回目");
        println!(
            "run3(復旧): total={} imported={} skipped={} failed={}",
            r3.total, r3.imported, r3.skipped, r3.failed
        );
        check("P-3-3 手動削除→SD再取り込みで imported になる", r3.imported >= 1);
        check("P-3-3 作品の行が索引に復活", rows_for(&read_index(), &y.hash) == 1);
    }

    // P-3-4: 幽霊行が複数（手で3件削除）→ scan で索引からちょうど3行消える
    {
        let g: Vec<_> = notes[2..5].to_vec();
        for it in &g {
            std::fs::remove_file(&it.path).expect("手動削除の再現");
        }
        let before_rows = total_rows(&read_index());
        animemo_lib::pclib::scan_library(&lib).expect("scan");
        let after = read_index();
        check("P-3-4 scan で幽霊行がちょうど3行消える", total_rows(&after) == before_rows - 3);
        check(
            "P-3-4 消えたのは該当ハッシュ",
            g.iter().all(|it| rows_for(&after, &it.hash) == 0),
        );
    }

    // P-3-6a: 既に重複行がある壊れた索引（友人の状態）— 幽霊側だけ消える
    let z = notes[5];
    {
        let mut v = index_json(&read_index());
        let arr = v["items"].as_array_mut().unwrap();
        let mut ghost = arr
            .iter()
            .find(|i| i["hash"] == z.hash.as_str())
            .cloned()
            .expect("z の行");
        ghost["rel_path"] = serde_json::Value::String("受け取り/__m18_ghost__.kwz".into());
        arr.push(ghost);
        std::fs::write(&index_path, serde_json::to_string_pretty(&v).unwrap())
            .expect("壊れた索引の再現");
        let view = animemo_lib::pclib::scan_library(&lib).expect("scan");
        check("P-3-6a 重複行は幽霊側だけ消える", rows_for(&read_index(), &z.hash) == 1);
        check(
            "P-3-6a 生きている側は表示される",
            view.iter().any(|i| i.kind == "note" && i.hash == z.hash),
        );
    }

    // P-3-6b: 同ハッシュで両方実在 — どちらも消さない（行2・表示2・ファイル2）
    let w = notes[6];
    {
        // 実ファイルを複製し、索引にも実在する行として複製（手動コピーの再現）
        let dup_rel = "受け取り/__m18_dup__.kwz";
        let dup_abs = Path::new(&lib).join(dup_rel);
        std::fs::create_dir_all(dup_abs.parent().unwrap()).expect("フォルダ");
        std::fs::copy(&w.path, &dup_abs).expect("複製");
        let mut v = index_json(&read_index());
        let arr = v["items"].as_array_mut().unwrap();
        let mut dup = arr
            .iter()
            .find(|i| i["hash"] == w.hash.as_str())
            .cloned()
            .expect("w の行");
        dup["rel_path"] = serde_json::Value::String(dup_rel.into());
        dup["name"] = serde_json::Value::String("__m18_dup__.kwz".into());
        dup["album"] = serde_json::Value::String("受け取り".into());
        arr.push(dup);
        std::fs::write(&index_path, serde_json::to_string_pretty(&v).unwrap())
            .expect("重複索引の再現");
        let view = animemo_lib::pclib::scan_library(&lib).expect("scan");
        check("P-3-6b 両方実在の重複は行2のまま", rows_for(&read_index(), &w.hash) == 2);
        check(
            "P-3-6b 両方表示・ファイルも両方残る",
            view.iter().filter(|i| i.kind == "note" && i.hash == w.hash).count() == 2
                && Path::new(&w.path).is_file()
                && dup_abs.is_file(),
        );
    }

    let _ = std::fs::remove_dir_all(&out_dir);
    println!("\nM10-18 self-heal: pass={pass} fail={fail}");
    if fail > 0 {
        std::process::exit(1);
    }
}
