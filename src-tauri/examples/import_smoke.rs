//! M2 取り込みパイプラインのスモークテスト（GUIなし）
//! 使い方: cargo run --example import_smoke -- <取り込み元> <ライブラリフォルダ>
//! 2回実行して冪等性（2回目は新規0件）も確認する。
//! M10-18: 索引の自己修復（幽霊行掃除・重複行防止・SD再取り込み復旧）のケースを追加。
//! **取り込み元（src）は read-only。手動操作の再現はすべて lib（検証用スクラッチ）側のみ。**

use std::path::Path;

/// M11-4: scan をやり直すと参照が無効になるため、必要な値だけ控える小さな型
struct NoteRef {
    hash: String,
    name: String,
    path: String,
}

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

    // ---------------- M11-1: アルバム削除（作品数で判定・付属物は消してよい） ----------------
    // 作者報告: 作品を全部消しても `<作品名>.memoanima.png` が残っていてアルバムを削除できない。
    // 「アプリ自身が作った付属物」を理由に利用者の操作を拒まない／
    // 「利用者が置いた未知のファイル」は黙って消さない、の両立を検証する。
    let libp = Path::new(&lib);
    let mkdir = |name: &str| {
        let d = libp.join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("アルバム作成");
        d
    };
    let put = |dir: &Path, name: &str, body: &[u8]| {
        std::fs::write(dir.join(name), body).expect("ファイル作成");
    };

    // P-3-7: 作品2件＋サイドカー2枚 → 作品を消せばアルバムを削除できる（PNGごと消える）
    {
        let album = "__m11_ok";
        let dir = mkdir(album);
        for n in ["さくひんA", "さくひんB"] {
            animemo_lib::pclib::save_project(&lib, album, n, b"dummy-project", b"dummy-png")
                .expect("save_project");
        }
        let works = |d: &Path| {
            std::fs::read_dir(d)
                .unwrap()
                .flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_lowercase();
                    n.ends_with(".memoanima")
                })
                .count()
        };
        let pngs = |d: &Path| {
            std::fs::read_dir(d)
                .unwrap()
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .ends_with(".memoanima.png")
                })
                .count()
        };
        check(
            "P-3-7 前提: 作品2件＋サイドカー2枚ができる",
            works(&dir) == 2 && pngs(&dir) == 2,
        );
        let e = animemo_lib::pclib::delete_album(&lib, album).unwrap_err();
        check(
            "P-3-8 作品が残っていれば拒否・メッセージが「2 件の作品」",
            e.contains("2 件の作品") && !e.contains("個のファイル"),
        );
        // 作品だけを消してサイドカーが残った状態を再現（作者の実機状態）
        for n in ["さくひんA.memoanima", "さくひんB.memoanima"] {
            std::fs::remove_file(dir.join(n)).expect("作品の削除");
        }
        check("P-3-7 前提: サイドカーだけが残る", works(&dir) == 0 && pngs(&dir) == 2);
        let r = animemo_lib::pclib::delete_album(&lib, album);
        check("P-3-7 サイドカーだけならアルバムを削除できる", r.is_ok());
        check("P-3-7 フォルダごと消える（PNGも残らない）", !dir.exists());
    }

    // P-3-9: 利用者が置いた無関係なファイルがあれば拒否（黙って消さない）
    {
        let album = "__m11_user";
        let dir = mkdir(album);
        put(&dir, "メモ.txt", b"user note");
        put(&dir, "\u{3055}\u{304F}\u{3072}\u{3093}C.memoanima.png", b"png");
        let e = animemo_lib::pclib::delete_album(&lib, album).unwrap_err();
        check(
            "P-3-9 利用者のファイルがあれば拒否・内容が分かる",
            e.contains("作品以外") && e.contains("メモ.txt"),
        );
        check(
            "P-3-9 拒否時は1バイトも消さない（利用者ファイル・サイドカーとも残る）",
            dir.join("メモ.txt").is_file()
                && dir.join("\u{3055}\u{304F}\u{3072}\u{3093}C.memoanima.png").is_file()
                && std::fs::read(dir.join("メモ.txt")).unwrap() == b"user note",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 付属物の網羅: 旧拡張子サイドカー・OS由来・大文字小文字ゆらぎ
    {
        let album = "__m11_sidecars";
        let dir = mkdir(album);
        put(&dir, "きゅう.animemo.png", b"png");
        put(&dir, "OO.MEMOANIMA.PNG", b"png");
        put(&dir, "Thumbs.db", b"db");
        put(&dir, "desktop.ini", b"ini");
        put(&dir, ".DS_Store", b"ds");
        let r = animemo_lib::pclib::delete_album(&lib, album);
        check("M11-1 旧サイドカー・OS由来・大小ゆらぎは消してよい", r.is_ok());
        check("M11-1 フォルダごと消える", !dir.exists());
    }

    // 作品扱いの網羅: .animemo / .kwz / .ppm / 大文字も「作品」として守る
    {
        for (i, name) in ["きゅう.animemo", "note.KWZ", "note.ppm"].iter().enumerate() {
            let album = format!("__m11_work{i}");
            let dir = mkdir(&album);
            put(&dir, name, b"work");
            put(&dir, "thumb.memoanima.png", b"png");
            let e = animemo_lib::pclib::delete_album(&lib, &album).unwrap_err();
            check(
                &format!("M11-1 {name} は作品として守られる"),
                e.contains("1 件の作品") && dir.join(name).is_file(),
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    // サブフォルダは従来どおり拒否（中身も消さない）
    {
        let album = "__m11_subdir";
        let dir = mkdir(album);
        std::fs::create_dir_all(dir.join("なかみ")).expect("サブフォルダ");
        put(&dir, "x.memoanima.png", b"png");
        let e = animemo_lib::pclib::delete_album(&lib, album).unwrap_err();
        check(
            "M11-1 サブフォルダがあれば拒否・中身は残る",
            e.contains("フォルダ") && dir.join("なかみ").is_dir() && dir.join("x.memoanima.png").is_file(),
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M11-1 レビュー検出: アルバム自体がジャンクションなら「リンク先の中身」を消さない
    {
        let real = mkdir("__m11_link_target");
        put(&real, "たいせつ.memoanima.png", b"png");
        // 既にジャンクションが用意されていればそれを使う（環境によっては子プロセスから
        // mklink できないため、外部で作ったものを流用できるようにしておく）
        let link = libp.join("__m11_link");
        let is_link = |p: &Path| {
            std::fs::symlink_metadata(p)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
        };
        let made = if is_link(&link) {
            true
        } else {
            let st = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J", link.to_str().unwrap(), real.to_str().unwrap()])
                .output();
            match &st {
                Ok(o) if o.status.success() => true,
                Ok(o) => {
                    println!(
                        "  mklink 失敗: {}{}",
                        String::from_utf8_lossy(&o.stdout).trim(),
                        String::from_utf8_lossy(&o.stderr).trim()
                    );
                    false
                }
                Err(e) => {
                    println!("  mklink 実行不可: {e}");
                    false
                }
            }
        };
        if made {
            let e = animemo_lib::pclib::delete_album(&lib, "__m11_link").unwrap_err();
            check(
                "M11-1 リンクのアルバムは拒否・リンク先を消さない",
                e.contains("リンク") && real.join("たいせつ.memoanima.png").is_file() && real.is_dir(),
            );
            let _ = std::fs::remove_dir(&link); // ジャンクション自体を外す（中身は消えない）
        } else {
            println!("skip - ジャンクションを作れないためリンク検証をスキップ");
        }
        let _ = std::fs::remove_dir_all(&real);
    }

    // 空フォルダは従来どおり削除できる（回帰）
    {
        let album = "__m11_empty";
        let dir = mkdir(album);
        check(
            "M11-1 空アルバムは従来どおり削除できる",
            animemo_lib::pclib::delete_album(&lib, album).is_ok() && !dir.exists(),
        );
    }

    // P-3-10: 削除後も索引が壊れない（幽霊行は scan で掃除され、JSONとして妥当）
    {
        let album = "__m11_index";
        let dir = mkdir(album);
        put(&dir, "ghost.memoanima.png", b"png");
        let mut v = index_json(&read_index());
        let arr = v["items"].as_array_mut().unwrap();
        let mut ghost = arr.first().cloned().expect("既存行");
        ghost["hash"] = serde_json::Value::String("f".repeat(64));
        ghost["rel_path"] = serde_json::Value::String(format!("{album}/ghost.kwz"));
        ghost["album"] = serde_json::Value::String(album.into());
        arr.push(ghost);
        std::fs::write(&index_path, serde_json::to_string_pretty(&v).unwrap()).expect("索引書き");
        check(
            "P-3-10 アルバム削除が成功する",
            animemo_lib::pclib::delete_album(&lib, album).is_ok() && !dir.exists(),
        );
        let view = animemo_lib::pclib::scan_library(&lib).expect("scan");
        let after = read_index();
        check(
            "P-3-10 削除後: 索引はJSONとして妥当・幽霊行が掃除される",
            serde_json::from_slice::<serde_json::Value>(&after).is_ok()
                && rows_for(&after, &"f".repeat(64)) == 0,
        );
        check(
            "P-3-10 削除したアルバムが一覧から消える",
            !view.iter().any(|i| i.album == album),
        );
    }

    // ---------------- M11-3: move_project（本体＋サイドカーPNG＋表示順キー） ----------------
    {
        let a = "__m11_mv_src";
        let b = "__m11_mv_dst";
        let da = mkdir(a);
        let db = mkdir(b);
        animemo_lib::pclib::save_project(&lib, a, "うごき", b"proj-A", b"png-A")
            .expect("save_project A");
        check(
            "M11-3 前提: 本体＋サイドカーができる",
            da.join("うごき.memoanima").is_file() && da.join("うごき.memoanima.png").is_file(),
        );
        // 表示順キーを付けておく（付け替えの検証用）
        animemo_lib::pclib::set_note_order(&lib, &[format!("p:{a}/うごき.memoanima")])
            .expect("set_note_order");
        let moved = animemo_lib::pclib::move_project(&lib, a, "うごき.memoanima", b)
            .expect("move_project");
        check(
            "M11-3 本体が移動先へ",
            std::path::Path::new(&moved).is_file() && db.join("うごき.memoanima").is_file(),
        );
        // 戻り値は scan_library の path と**同じ形式**（`\\?\` 付きだとフロントが作品を見失う）
        let listed = animemo_lib::pclib::scan_library(&lib)
            .expect("scan")
            .into_iter()
            .find(|i| i.name == "うごき.memoanima")
            .map(|i| i.path);
        check(
            "M11-3 戻り値の形式が scan_library の path と一致する",
            listed.as_deref() == Some(moved.as_str()),
            );
        check(
            "M11-3 サイドカーPNGも一緒に移動（移動元に孤児が残らない）",
            db.join("うごき.memoanima.png").is_file()
                && !da.join("うごき.memoanima.png").exists()
                && !da.join("うごき.memoanima").exists(),
        );
        check(
            "M11-3 中身が壊れていない",
            std::fs::read(db.join("うごき.memoanima")).unwrap() == b"proj-A"
                && std::fs::read(db.join("うごき.memoanima.png")).unwrap() == b"png-A",
        );
        let idx = index_json(&read_index());
        check(
            "M11-3 表示順キーが新アルバムへ付け替わる",
            idx["project_order"].get(format!("{a}/うごき.memoanima")).is_none()
                && idx["project_order"].get(format!("{b}/うごき.memoanima")).is_some(),
        );
        // P-4-9: 移動後、空になった移動元アルバムを削除できる（M11-1 の判定と組み合わせ）
        check(
            "M11-3 移動後に移動元アルバムを削除できる",
            animemo_lib::pclib::move_project(&lib, b, "うごき.memoanima", a).is_ok()
                && animemo_lib::pclib::move_project(&lib, a, "うごき.memoanima", b).is_ok()
                && animemo_lib::pclib::delete_album(&lib, a).is_ok()
                && !da.exists(),
        );

        // 同名衝突 → 別名で共存し、PNG名も本体に合う
        let da2 = mkdir(a);
        animemo_lib::pclib::save_project(&lib, a, "うごき", b"proj-B", b"png-B")
            .expect("save_project B");
        let moved2 = animemo_lib::pclib::move_project(&lib, a, "うごき.memoanima", b)
            .expect("move_project 衝突");
        let p2 = std::path::Path::new(&moved2);
        let n2 = p2.file_name().unwrap().to_string_lossy().to_string();
        check(
            "M11-3 同名衝突は別名で共存（元の作品も残る）",
            n2 != "うごき.memoanima" && db.join("うごき.memoanima").is_file() && p2.is_file(),
        );
        check(
            &format!("M11-3 PNGの名前も本体に合う（{n2}.png）"),
            db.join(format!("{n2}.png")).is_file() && !da2.join("うごき.memoanima.png").exists(),
        );
        check(
            "M11-3 衝突後も中身が入れ替わっていない",
            std::fs::read(db.join("うごき.memoanima")).unwrap() == b"proj-A"
                && std::fs::read(p2).unwrap() == b"proj-B",
        );

        // 拒否されるべき入力
        check(
            "M11-3 プロジェクト以外は移動しない",
            animemo_lib::pclib::move_project(&lib, b, "note.kwz", a).is_err(),
        );
        check(
            "M11-3 存在しない作品はエラー",
            animemo_lib::pclib::move_project(&lib, b, "ないよ.memoanima", a).is_err(),
        );
        check(
            "M11-3 パス区切りを含む名前でライブラリ外へ出られない",
            animemo_lib::pclib::move_project(&lib, b, "../../そと.memoanima", a).is_err(),
        );
        // 同じアルバムへの移動は何もせず成功（UI側の早期returnの保険）
        check(
            "M11-3 同じアルバムへの移動は無害",
            animemo_lib::pclib::move_project(&lib, b, "うごき.memoanima", b).is_ok()
                && db.join("うごき.memoanima").is_file(),
        );
        let _ = std::fs::remove_dir_all(&da2);
        let _ = std::fs::remove_dir_all(&db);
    }

    // ---------------- M11-4: 外部移動（エクスプローラー）への追随 ----------------
    // 索引を持つ .kwz を「アプリを通さずに」別アルバムへ移すと、従来は幽霊行として
    // 索引から消えていた。ハッシュ照合で新しい位置を見つけて rel_path を書き換える。
    {
        // 検証用に**内容が一意な**メモを1件だけ作って取り込む。
        // 「一覧の先頭の note」を使うと、前のケースが残した複製（同ハッシュの実ファイル・
        // 重複行）を拾ってしまい、アルバム名の並び順で結果が変わる＝テストが嘘をつく
        let uniq_src = out_dir.join("__m11_4_uniq__.kwz");
        std::fs::write(&uniq_src, b"M11-4 unique note body \x01\x02\x03").expect("検証用メモ作成");
        let (uniq_path, uniq_hash) = animemo_lib::pclib::import_single_file(
            &lib,
            uniq_src.to_str().unwrap(),
            "__m11_4_src",
        )
        .expect("import_single_file");
        // 後で scan をやり直すので、必要な値だけ控えておく（LibraryView は Clone ではない）
        let note = NoteRef {
            hash: uniq_hash,
            name: Path::new(&uniq_path)
                .file_name()
                .and_then(|n| n.to_str())
                .expect("取り込み名")
                .to_string(),
            path: uniq_path.clone(),
        };
        check(
            "M11-4 前提: 検証用メモの行はちょうど1行（並び順に依存しない）",
            rows_for(&read_index(), &note.hash) == 1 && Path::new(&note.path).is_file(),
        );
        let dest_album = "__m11_moved";
        let dst_dir = mkdir(dest_album);
        let dst = dst_dir.join(&note.name);
        // エクスプローラーでの移動を再現（アプリのコマンドを通さない）
        std::fs::rename(&note.path, &dst).expect("外部移動の再現");
        let view = animemo_lib::pclib::scan_library(&lib).expect("scan after external move");
        let found = view.iter().find(|i| i.hash == note.hash);
        check(
            &format!(
                "M11-4 外部移動した .kwz が索引から消えず新しいアルバムで見つかる（{}）",
                found.map(|i| format!("{}/{}", i.album, i.name)).unwrap_or("消えた".into())
            ),
            found.map(|i| i.album.as_str()) == Some(dest_album),
        );
        let idx = index_json(&read_index());
        let row = idx["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["hash"] == note.hash.as_str())
            .cloned();
        check(
            &format!(
                "M11-4 索引の rel_path が新しい位置へ書き換わる（{}）",
                row.as_ref().and_then(|r| r["rel_path"].as_str()).unwrap_or("行が無い")
            ),
            row.as_ref().and_then(|r| r["rel_path"].as_str())
                == Some(format!("{dest_album}/{}", note.name).as_str()),
        );
        check(
            "M11-4 ハッシュは不変（サムネキャッシュがそのまま効く）",
            row.as_ref().and_then(|r| r["hash"].as_str()) == Some(note.hash.as_str()),
        );
        // 幽霊行が0件の通常状態では探索が走らない（＝索引はバイト不変・行数も不変）
        let before = read_index();
        animemo_lib::pclib::scan_library(&lib).expect("scan");
        check("M11-4 幽霊行0件なら索引はバイト不変（探索が走らない）", before == read_index());

        // ライブラリの外へ出したら従来どおり索引から消える（M10-18 の挙動維持）
        let outside = out_dir.join(&note.name);
        std::fs::create_dir_all(&out_dir).ok();
        std::fs::rename(&dst, &outside).expect("ライブラリ外へ移動");
        let view2 = animemo_lib::pclib::scan_library(&lib).expect("scan after outside move");
        check(
            "M11-4 ライブラリ外へ出した作品は従来どおり索引から消える",
            !view2.iter().any(|i| i.hash == note.hash)
                && rows_for(&read_index(), &note.hash) == 0,
        );
        // 後片付け（次のケースに影響させない）
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_file(&uniq_src);
        let _ = std::fs::remove_dir_all(&dst_dir);
        let _ = std::fs::remove_dir_all(libp.join("__m11_4_src"));
    }

    // M11-4b: 同じ内容の作品が2件あるとき、両方を外部移動しても**2行とも**復旧する
    // （1実体=1行で割り当てる。片方が幽霊行のまま消えると、ディスク上のファイルが
    //   アプリから永久に見えなくなる）
    {
        let (a1, a2, dest) = ("__m11_dupA", "__m11_dupB", "__m11_dupMoved");
        let (d1, d2, dd) = (mkdir(a1), mkdir(a2), mkdir(dest));
        let body = b"M11-4b duplicated note body \x09\x08\x07";
        let seed = out_dir.join("__m11_4_dup__.kwz");
        std::fs::create_dir_all(&out_dir).ok();
        std::fs::write(&seed, body).expect("複製元");
        let (p1, hash) =
            animemo_lib::pclib::import_single_file(&lib, seed.to_str().unwrap(), a1)
                .expect("import_single_file");
        // 2行目は手で足す（同内容の2件目は通常の取り込みでは作れない＝索引再構築後の状態）
        std::fs::write(d2.join("dup2.kwz"), body).expect("2件目の実体");
        let mut v = index_json(&read_index());
        let arr = v["items"].as_array_mut().unwrap();
        let mut dup = arr
            .iter()
            .find(|i| i["hash"] == hash.as_str())
            .cloned()
            .expect("1行目");
        dup["album"] = serde_json::Value::String(a2.into());
        dup["name"] = serde_json::Value::String("dup2.kwz".into());
        dup["rel_path"] = serde_json::Value::String(format!("{a2}/dup2.kwz"));
        arr.push(dup);
        std::fs::write(&index_path, serde_json::to_string_pretty(&v).unwrap()).expect("索引");
        check("M11-4b 前提: 同ハッシュの生存行が2行", rows_for(&read_index(), &hash) == 2);
        // エクスプローラーで2件とも別アルバムへ
        let n1 = Path::new(&p1).file_name().unwrap().to_string_lossy().to_string();
        std::fs::rename(&p1, dd.join(&n1)).expect("外部移動1");
        std::fs::rename(d2.join("dup2.kwz"), dd.join("dup2.kwz")).expect("外部移動2");
        let view = animemo_lib::pclib::scan_library(&lib).expect("scan");
        let idx = index_json(&read_index());
        let rels: std::collections::BTreeSet<String> = idx["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["hash"] == hash.as_str())
            .filter_map(|i| i["rel_path"].as_str().map(|s| s.to_string()))
            .collect();
        check(
            &format!("M11-4b 同ハッシュ2行が両方とも復旧する（{rels:?}）"),
            rels.len() == 2 && rels.iter().all(|r| r.starts_with(dest)),
        );
        check(
            "M11-4b 表示も2件（ディスク上のファイルが見えなくならない）",
            view.iter().filter(|i| i.kind == "note" && i.hash == hash).count() == 2,
        );
        // 後片付け（アルバムごと消して、残った行は従来どおり掃除されることも確認）
        let _ = std::fs::remove_file(&seed);
        let _ = std::fs::remove_dir_all(&dd);
        let _ = std::fs::remove_dir_all(&d1);
        let _ = std::fs::remove_dir_all(&d2);
        animemo_lib::pclib::scan_library(&lib).expect("scan");
        check("M11-4b 後片付け後は索引に残骸が残らない", rows_for(&read_index(), &hash) == 0);
    }

    // M11-4d: 同じ実体を指す行が2行できていたら1行にする（重複行を作らない規約の保険）
    {
        let album = "__m11_dupRel";
        let dir = mkdir(album);
        let seed = out_dir.join("__m11_4_rel__.kwz");
        std::fs::create_dir_all(&out_dir).ok();
        std::fs::write(&seed, b"M11-4d same rel_path twice \x11\x12").expect("種ファイル");
        let (_p, hash) = animemo_lib::pclib::import_single_file(&lib, seed.to_str().unwrap(), album)
            .expect("import_single_file");
        let mut v = index_json(&read_index());
        let arr = v["items"].as_array_mut().unwrap();
        let dup = arr.iter().find(|i| i["hash"] == hash.as_str()).cloned().expect("行");
        arr.push(dup); // 同じ rel_path の行をもう1行（異常状態）
        std::fs::write(&index_path, serde_json::to_string_pretty(&v).unwrap()).expect("索引");
        // 幽霊行がないと自己修復は走らないので、別の行を1つ幽霊にしておく
        let ghost_src = index_json(&read_index())["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["hash"] != hash.as_str())
            .and_then(|i| i["rel_path"].as_str().map(|s| s.to_string()));
        let mut restored: Option<(std::path::PathBuf, Vec<u8>)> = None;
        if let Some(rel) = ghost_src {
            let p = libp.join(&rel);
            if let Ok(b) = std::fs::read(&p) {
                let _ = std::fs::remove_file(&p);
                restored = Some((p, b));
            }
        }
        animemo_lib::pclib::scan_library(&lib).expect("scan");
        check(
            "M11-4d 同じ実体を指す重複行は1行に整理される",
            rows_for(&read_index(), &hash) == 1,
        );
        if let Some((p, b)) = restored {
            std::fs::write(&p, b).ok(); // 実ファイルは戻す（アプリは消していない）
        }
        let _ = std::fs::remove_file(&seed);
        let _ = std::fs::remove_dir_all(&dir);
        animemo_lib::pclib::scan_library(&lib).expect("scan");
    }

    // M11-4c: 変化検知の指紋（library_stamp）。フォーカス復帰のたびに走るので、
    // **アプリ自身の書き込みで動かない**ことと、**外部の変更を取りこぼさない**ことの両立が要る
    {
        let album = "__m11_stamp";
        let dir = mkdir(album);
        animemo_lib::pclib::save_project(&lib, album, "すたんぷ", b"dummy-project", b"dummy-png")
            .expect("save_project");
        let proj = dir.join("すたんぷ.memoanima");
        let stamp = || animemo_lib::pclib::library_stamp(&lib).expect("library_stamp");
        let s0 = stamp();
        check("M11-4c 指紋: 何もしなければ同じ値", s0 == stamp());
        animemo_lib::pclib::save_project_thumb(&lib, proj.to_str().unwrap(), b"png-bytes-2")
            .expect("save_project_thumb");
        check(
            "M11-4c 指紋: サイドカーサムネを書いても変わらない（空振り再スキャンなし）",
            stamp() == s0,
        );
        std::fs::rename(&proj, dir.join("すたんぷ2.memoanima")).expect("外部リネーム");
        let s1 = stamp();
        check("M11-4c 指紋: 外部でのリネームで変わる", s1 != s0);
        std::fs::write(dir.join("すたんぷ2.memoanima"), b"dummy-project-longer").expect("上書き");
        let s2 = stamp();
        check("M11-4c 指紋: 中身の差し替え（サイズ変化）で変わる", s2 != s1);
        let _ = std::fs::remove_dir_all(&dir);
        check("M11-4c 指紋: アルバムの削除で変わる", stamp() != s2);
    }

    let _ = std::fs::remove_dir_all(&out_dir);
    println!("\nM10-18 + M11-1 + M11-3 + M11-4: pass={pass} fail={fail}");
    if fail > 0 {
        std::process::exit(1);
    }
}
