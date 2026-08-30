//! V154 データ保護のスモークテスト（GUI なし・**事故そのものを再現する**）
//!
//! 使い方: `cargo run --example v154_smoke -- <一時ライブラリフォルダ>`
//!         （引数を省くと OS の一時フォルダに作って最後に消す）
//!
//! 何を確かめるか:
//!   1. 事故の再現 — 保存の窓（`dest → .bak` と `tmp → dest` のあいだ）で死ぬと、
//!      **作品が一覧から消える**（Culoe さんの報告と同じ状態）
//!   2. W-1  — 保存が成功しても `.bak` が**残る**（消えなくなった＝窓で死んでも中身が在る）
//!   3. W-1  — `scan_recoverable` が孤児 `.bak` を拾い、`recover_project` で**戻せる**
//!   4. W-1b — 索引の行に `.bak` があるとき `heal_index_rows` が**行を落とさない**
//!      （`.bak` が無ければ従来どおり落とす＝自己修復は殺さない）
//!   5. 穴⑤ — 作品を削除すると `.bak` と `.tmp` も消える（復元プロンプトが誤爆しない）
//!   6. 穴① — オートセーブの経路でも同じヘルパーを通る（控えが残る）
//!   7. W-6  — 書いたものを読み戻して確かめ、違っていたら**前の版へ戻す**
//!   8. W-10 — ログの伏せ字（利用者名を書かない）と上限（1MB・2世代）
//!            （壊れたほうは `.broken` として残す＝消さない）
//!   9. HK1 (A-22) — settings.json の書き込みが atomic_replace 流儀になり、
//!      **書き込み途中で死んでも設定が壊れない**（各クラッシュ窓を実際に作って読ませる）
//!
//! **作者の実ライブラリには触らない。**引数で渡された（か一時フォルダに作った）場所だけを使う。

use std::fs;
use std::path::{Path, PathBuf};

fn ok(msg: &str) {
    println!("  OK  {msg}");
}

/// `.memoanima` の中身の代わり（保存経路はバイト列を素通しするので中身は何でもよい）
fn body(tag: &str, n: usize) -> Vec<u8> {
    let mut v = format!("MEMOANIMA-V154-SMOKE:{tag}:").into_bytes();
    v.resize(v.len() + n, b'#');
    v
}

fn main() {
    let arg = std::env::args().nth(1);
    let temp = arg.is_none();
    let lib: PathBuf = match arg {
        Some(p) => PathBuf::from(p),
        None => std::env::temp_dir().join(format!("memoanima-v154-smoke-{}", std::process::id())),
    };
    let lib_s = lib.to_string_lossy().to_string();
    let _ = fs::remove_dir_all(&lib);
    fs::create_dir_all(&lib).expect("一時ライブラリの作成");
    println!("lib = {lib_s}");

    let album = "V154検証";
    let name = "大型作品.memoanima";
    let dir = lib.join(album);
    let dest = dir.join(name);
    let bak = dir.join(format!("{name}.bak"));

    // ---------------------------------------------------------------- 1) 準備と W-1
    println!("\n[1] 保存すると .bak が残る（W-1）");
    animemo_lib::pclib::save_project(&lib_s, album, name, &body("gen1", 4096), &[]).expect("1回目の保存");
    assert!(dest.is_file(), "1回目の保存で本体ができていない");
    assert!(!bak.exists(), "新規保存で .bak ができるのはおかしい");
    ok("新規保存: 本体だけができる（.bak なし）");

    animemo_lib::pclib::save_project(&lib_s, album, name, &body("gen2", 8192), &[]).expect("2回目の保存");
    assert!(dest.is_file(), "2回目の保存で本体が無い");
    assert!(bak.is_file(), "**上書き保存なのに .bak が残っていない**（W-1 が効いていない）");
    let bak_bytes = fs::read(&bak).expect("控えの読み出し");
    assert_eq!(bak_bytes, body("gen1", 4096), "控えの中身が1世代前ではない");
    ok("上書き保存: .bak が残り、中身は**1世代前**");

    animemo_lib::pclib::save_project(&lib_s, album, name, &body("gen3", 8192), &[]).expect("3回目の保存");
    let generations = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".bak"))
        .count();
    assert_eq!(generations, 1, "控えが2世代以上たまっている（1世代のはず）");
    assert_eq!(fs::read(&bak).unwrap(), body("gen2", 8192), "控えが最新の1世代前ではない");
    ok("控えは**常に1世代**（増えていかない）");

    // ---------------------------------------------------------------- 2) 事故の再現
    println!("\n[2] 事故の再現 — 保存の窓でプロセスが死んだ状態を作る");
    // `commit_replace` の手順①だけを実行して、②の前に「死ぬ」
    let _ = fs::remove_file(&bak);
    fs::rename(&dest, &bak).expect("手順①: 本体 → .bak");
    assert!(!dest.exists(), "本体が消えていない（再現できていない）");
    assert!(bak.is_file(), "控えが無い（再現できていない）");
    ok("窓の状態を作った: 本体なし・`.bak` あり（＝報告と同じ形）");

    let view = animemo_lib::pclib::scan_library(&lib_s).expect("scan_library");
    let visible = view.iter().any(|v| v.name == name);
    assert!(!visible, "本体が無いのに一覧に出ている（前提が違う）");
    ok("この状態では**一覧に出てこない**（利用者から見て「消えた」）");

    // ---------------------------------------------------------------- 3) 復元
    println!("\n[3] 復元できる（W-1 の後半）");
    let rec = animemo_lib::pclib::scan_recoverable(&lib_s).expect("scan_recoverable");
    assert_eq!(rec.len(), 1, "復元候補が1件ではない: {}", rec.len());
    assert_eq!(rec[0].rel_path, format!("{album}/{name}"), "rel_path が違う");
    assert!(rec[0].bak_size > 0, "控えの大きさが 0");
    ok(&format!(
        "`scan_recoverable` が拾った: {} ({} バイト)",
        rec[0].rel_path, rec[0].bak_size
    ));

    let restored = animemo_lib::pclib::recover_project(&lib_s, &rec[0].rel_path).expect("recover_project");
    assert!(Path::new(&restored).is_file(), "復元先が無い");
    assert!(!bak.exists(), "復元後も .bak が残っている（rename ではなくコピーになっている）");
    assert_eq!(fs::read(&dest).unwrap(), body("gen3", 8192), "復元した中身が違う");
    ok("`recover_project` で本体が戻り、中身は**窓で失われるはずだった世代**");

    let view2 = animemo_lib::pclib::scan_library(&lib_s).expect("scan_library 2");
    assert!(view2.iter().any(|v| v.name == name), "復元したのに一覧に出ない");
    ok("一覧に戻った");

    // 本体が在るときは復元しない（上書き厳禁）
    fs::write(&bak, body("stale", 16)).expect("控えを置く");
    let res = animemo_lib::pclib::recover_project(&lib_s, &format!("{album}/{name}"));
    assert!(res.is_err(), "本体が在るのに復元が通ってしまう（上書きの危険）");
    assert_eq!(fs::read(&dest).unwrap(), body("gen3", 8192), "本体が書き換わった");
    ok("本体が在るときは復元しない（上書きしない）");

    // 中身が空の控えは候補に出さない（復元しても開けないものを勧めない）
    let empty_name = "からっぽ.memoanima";
    fs::write(dir.join(format!("{empty_name}.bak")), b"").expect("空の控え");
    let rec_e = animemo_lib::pclib::scan_recoverable(&lib_s).expect("scan_recoverable 空");
    assert!(
        !rec_e.iter().any(|r| r.name == empty_name),
        "0バイトの控えが復元候補に出ている"
    );
    assert!(
        dir.join(format!("{empty_name}.bak")).is_file(),
        "候補に出さないだけで、ファイルは消さないこと"
    );
    ok("0バイトの控えは候補に出さない（ファイルは消さない）");
    let _ = fs::remove_file(dir.join(format!("{empty_name}.bak")));

    // ---------------------------------------------------------------- 4) W-1b
    println!("\n[4] 索引の自己修復が `.bak` のある行を落とさない（W-1b）");
    let kwz_name = "とりこみ.kwz";
    let kwz_rel = format!("{album}/{kwz_name}");
    let kwz_path = dir.join(kwz_name);
    let index_path = lib.join("animemo-library.json");
    let write_index = |rel: &str| {
        let json = format!(
            r#"{{"version":1,"items":[{{"hash":"{h}","album":"{a}","name":"{n}","ext":"kwz","size":8,"rel_path":"{rel}","imported_at":1,"order":0}}],"project_order":{{}}}}"#,
            h = "a".repeat(64),
            a = album,
            n = kwz_name,
        );
        fs::write(&index_path, json).expect("索引の書き出し");
    };
    let row_alive = |lib_s: &str| -> bool {
        let s = fs::read_to_string(Path::new(lib_s).join("animemo-library.json")).unwrap_or_default();
        s.contains(kwz_name)
    };

    // (a) 実体も控えも無い → 従来どおり行を落とす（自己修復は殺さない）
    write_index(&kwz_rel);
    let _ = fs::remove_file(&kwz_path);
    let _ = animemo_lib::pclib::scan_library(&lib_s).expect("scan（実体も控えも無い）");
    assert!(!row_alive(&lib_s), "実体も控えも無い行が残っている（自己修復が効いていない）");
    ok("実体も控えも無い行: **従来どおり落とす**");

    // (b) 実体は無いが控えがある → **落とさない**（再起動がとどめを刺さない）
    write_index(&kwz_rel);
    fs::write(dir.join(format!("{kwz_name}.bak")), b"kwzbytes").expect("控えを置く");
    let _ = animemo_lib::pclib::scan_library(&lib_s).expect("scan（控えあり）");
    assert!(
        row_alive(&lib_s),
        "**控えがあるのに索引の行が落ちた**（W-1b が効いていない＝再起動がとどめを刺す）"
    );
    ok("控えがある行: **落とさない**（何度スキャンしても残る）");
    let _ = animemo_lib::pclib::scan_library(&lib_s).expect("scan（2回目）");
    let _ = animemo_lib::pclib::scan_library(&lib_s).expect("scan（3回目）");
    assert!(row_alive(&lib_s), "スキャンを繰り返すと落ちてしまう");
    ok("スキャン3回でも残る（起動のたびに走っても消えない）");

    // ---------------------------------------------------------------- 5) 穴⑤
    println!("\n[5] 削除すると控えと残骸も消える（穴⑤）");
    let tmp_a = dir.join(format!("{name}.1755-3.tmp"));
    let tmp_b = dir.join(format!("{name}.7.tmp"));
    fs::write(&tmp_a, b"tmp1").expect("tmp1");
    fs::write(&tmp_b, b"tmp2").expect("tmp2");
    fs::write(&bak, body("gen3", 8192)).expect("控え");
    let other = dir.join("まったく別のファイル.tmp"); // 利用者の物を誤って消さないこと
    fs::write(&other, b"user").expect("other");
    animemo_lib::pclib::delete_item(&lib_s, "", album, name).expect("delete_item");
    assert!(!dest.exists(), "本体が消えていない");
    assert!(!bak.exists(), "**控えが残っている**（復元プロンプトが誤爆する）");
    assert!(!tmp_a.exists() && !tmp_b.exists(), "保存途中の残骸が残っている");
    assert!(other.exists(), "**関係ないファイルまで消した**（誤爆）");
    ok("本体・控え・`.tmp` が消え、関係ないファイルは残る");

    let rec2 = animemo_lib::pclib::scan_recoverable(&lib_s).expect("scan_recoverable 2");
    assert!(
        !rec2.iter().any(|r| r.name == name),
        "削除した作品が復元候補に出ている"
    );
    ok("削除した作品は復元候補に出ない");

    // ---------------------------------------------------------------- 6) 穴①（オートセーブ）
    println!("
[6] オートセーブの経路も同じヘルパーを通る（穴①）");
    // `lib.rs::atomic_replace` は `commit_replace` を呼ぶだけなので、ここでは同じ関数を
    // オートセーブのファイル名（`current.asv`）で叩いて、**控えが残ること**を確かめる
    let asdir = lib.join("autosave-sim");
    fs::create_dir_all(&asdir).expect("擬似オートセーブフォルダ");
    let asv = asdir.join("current.asv");
    let write_asv = |gen: &str, n: usize| {
        let tmp = asdir.join(format!("current.asv.{}.tmp", n));
        fs::write(&tmp, body(gen, 128)).expect("tmp 書き出し");
        animemo_lib::pclib::commit_replace(&asdir, &asv, &tmp).expect("確定");
    };
    write_asv("as1", 1);
    assert!(asv.is_file() && !asdir.join("current.asv.bak").exists(), "初回で控えができるのはおかしい");
    write_asv("as2", 2);
    let asbak = asdir.join("current.asv.bak");
    assert!(asbak.is_file(), "**オートセーブの上書きで控えが残っていない**（穴①が塞がっていない）");
    assert_eq!(fs::read(&asbak).unwrap(), body("as1", 128), "控えが1世代前ではない");
    ok("オートセーブの上書きでも `.bak` が残る（load_autosave が拾える形）");
    // 窓で死んだ形にすると、本体が無く控えだけが残る＝`load_autosave` の .bak フォールバックが効く前提
    let _ = fs::remove_file(&asbak);
    fs::rename(&asv, &asbak).expect("窓の再現");
    assert!(!asv.exists() && asbak.is_file());
    ok("窓で死んでも `current.asv.bak` に中身が在る");
    // ライブラリの復元候補には**出さない**（プロジェクトの拡張子ではない）
    let rec3 = animemo_lib::pclib::scan_recoverable(&lib_s).expect("scan_recoverable 3");
    assert!(
        !rec3.iter().any(|r| r.name.contains("current.asv")),
        "オートセーブの控えが作品の復元候補に混ざっている"
    );
    ok("オートセーブの控えは作品の復元候補に混ざらない");

    // ---------------------------------------------------------------- 7) W-6
    println!("\n[7] 書いたものを読み戻して確かめる（W-6）");
    let w6 = "W6検証.memoanima";
    let w6_dest = dir.join(w6);
    let w6_bak = dir.join(format!("{w6}.bak"));
    // 1世代目・2世代目（2回目で控えができる）
    animemo_lib::pclib::save_project(&lib_s, album, w6, &body("w6-gen1", 512), &[]).expect("w6 1回目");
    animemo_lib::pclib::save_project(&lib_s, album, w6, &body("w6-gen2", 512), &[]).expect("w6 2回目");
    assert_eq!(fs::read(&w6_dest).unwrap(), body("w6-gen2", 512));
    assert!(w6_bak.is_file(), "控えが無い");
    ok("正常な保存は通る（読み戻して一致）");

    // 書いたあとに**別のものへ化けた**状況を作る: 保存した直後にファイルを書き換え、
    // `verify_or_rollback` を直接呼ぶ（本番では save_project の中で走る）
    fs::write(&w6_dest, body("こわれた", 3)).expect("化けさせる");
    let e = animemo_lib::pclib::verify_or_rollback(&dir, &w6_dest, &body("w6-gen2", 512))
        .expect_err("違うのに Ok が返った");
    ok(&format!("違いを見つけて Err にした: {e}"));
    assert!(!w6_bak.exists(), "控えが残ったまま＝戻していない");
    // 戻る先は「**この保存の前にディスクにあった版**」＝控え（gen1）。
    // 直前に書いた gen2 は壊れていたのだから、そこへは戻さない
    assert_eq!(
        fs::read(&w6_dest).unwrap(),
        body("w6-gen1", 512),
        "**保存前の版に戻っていない**"
    );
    ok("保存前の版（控え）に戻した");
    let broken = dir.join(format!("{w6}.broken"));
    assert!(broken.is_file(), "壊れたほうを消してしまった（証拠が残らない）");
    assert_eq!(fs::read(&broken).unwrap(), body("こわれた", 3), "`.broken` の中身が違う");
    ok("壊れたほうは `.broken` として残した（消さない）");

    // 控えが無いときは戻さない（何も消さない・Err だけ返す）
    let solo = "控えなし.memoanima";
    let solo_dest = dir.join(solo);
    animemo_lib::pclib::save_project(&lib_s, album, solo, &body("solo", 64), &[]).expect("solo 保存");
    assert!(!dir.join(format!("{solo}.bak")).exists(), "新規保存で控えができている");
    fs::write(&solo_dest, b"broken").expect("化けさせる");
    let e2 = animemo_lib::pclib::verify_or_rollback(&dir, &solo_dest, &body("solo", 64))
        .expect_err("違うのに Ok が返った");
    assert!(solo_dest.is_file(), "**戻せないのにファイルを消した**");
    assert_eq!(fs::read(&solo_dest).unwrap(), b"broken", "書いたものを勝手に消した");
    ok(&format!("控えが無いときは戻さず、何も消さない: {e2}"));

    // 長さが同じでも中身が違えば見つける（長さ比較だけで済ませていない）
    let same_len = "同じ長さ.memoanima";
    let sl_dest = dir.join(same_len);
    animemo_lib::pclib::save_project(&lib_s, album, same_len, &body("aaaa", 32), &[]).expect("保存");
    animemo_lib::pclib::save_project(&lib_s, album, same_len, &body("bbbb", 32), &[]).expect("保存2");
    let mut tampered = body("bbbb", 32);
    let last = tampered.len() - 1;
    tampered[last] ^= 0xff; // 1バイトだけ変える（長さは同じ）
    fs::write(&sl_dest, &tampered).expect("化けさせる");
    let e3 = animemo_lib::pclib::verify_or_rollback(&dir, &sl_dest, &body("bbbb", 32))
        .expect_err("1バイト違いを見逃した");
    assert!(e3.contains("中身が違います"), "長さの話にすり替わっている: {e3}");
    assert_eq!(fs::read(&sl_dest).unwrap(), body("aaaa", 32), "保存前の版に戻っていない");
    ok("長さが同じでも1バイトの違いを見つけて戻す");

    // ---------------------------------------------------------------- 8) W-10
    println!("\n[8] ログ（W-10）");
    // (a) 利用者名を含むパスは伏せる（**送ってもらう前提**なので、ここが甘いと出せない）
    //
    // ★ダミーのパスも**リテラルでは書かない**（`PUBLIC_REPO_allowlist.md` §D 検査2b:
    //   `C:[\\/]Users` に、テストのダミーでも当たってしまうため）。
    //   v3 で「例外的に出てよいものを無くす」と決めてある——「いつものやつ」の隣に
    //   本物が並んだとき気づけなくなるから。**組み立てて**作れば、将来この検査が
    //   どのドライブ文字にも広がっても当たらない。
    //   伏せる対象は「ホームフォルダの文字列」でありさえすればよく、本物である必要はない。
    let drive = "Z:"; // 実在しないドライブ（`{drive}` を挟むので走査の並びにならない）
    let home = format!(r"{drive}\Users\someone");
    let home = home.as_str();
    for (raw, want) in [
        (
            format!("{home}{}", r"\Documents\lib\a.memoanima"),
            r"<user>\Documents\lib\a.memoanima".to_string(),
        ),
        // 大文字小文字が違っても伏せる（Windows はどちらも通る）
        (
            format!(r"{}\users\SOMEONE\AppData\x", drive.to_lowercase()),
            r"<user>\AppData\x".to_string(),
        ),
        // 区切りが `/` でも伏せる
        (format!("{drive}/Users/someone/Desktop"), "<user>/Desktop".to_string()),
        // 1行に2回出てきても両方伏せる
        (
            format!("{home}\\a と {home}\\b"),
            r"<user>\a と <user>\b".to_string(),
        ),
        // 関係ない文字列は変えない
        ("[V154b] save ok frames=300 bytes=103033".to_string(), "[V154b] save ok frames=300 bytes=103033".to_string()),
    ] {
        let got = animemo_lib::redact_home(&raw, home);
        assert_eq!(got, want, "伏せ字が想定と違う: {raw}");
    }
    ok("利用者名を含むパスは `<user>` に伏せる（大文字小文字・`/`・複数回）");
    // ホームが短すぎるときは触らない（ドライブの根っこを伏せても意味が無い）
    let root = format!(r"{drive}\");
    assert_eq!(
        animemo_lib::redact_home(&format!(r"{drive}\a"), &root),
        format!(r"{drive}\a")
    );
    ok("ホームが短すぎるときは何もしない（誤爆させない）");

    // (b) 上限（1MB・2世代）
    let logs = lib.join("logs-sim");
    fs::create_dir_all(&logs).expect("ログフォルダ");
    let line = "x".repeat(1000);
    for _ in 0..1050 {
        animemo_lib::append_log_line(&logs, &line).expect("ログ書き込み");
    }
    let cur = logs.join("memoanima.log");
    let old = logs.join("memoanima.log.1");
    assert!(cur.is_file() && old.is_file(), "2世代になっていない");
    let cur_len = fs::metadata(&cur).unwrap().len();
    let old_len = fs::metadata(&old).unwrap().len();
    assert!(cur_len < 1_000_000, "回したのに現行が 1MB を超えている: {cur_len}");
    assert!(old_len > 1_000_000, "回す前のほうが小さい: {old_len}");
    ok(&format!(
        "1MB で世代交代する（現行 {cur_len} B / 1つ前 {old_len} B）"
    ));
    // 3世代目は作らない
    let files = fs::read_dir(&logs)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("memoanima.log"))
        .count();
    assert_eq!(files, 2, "ログが3つ以上ある（無限に育つ）");
    ok("2世代までで打ち止め（無限に育たない）");

    // ---------------- 9. HK1 (A-22): settings.json の原子化 ----------------
    // 隔離ディレクトリ（このスモークの一時フォルダの下）だけを使う。作者の実設定には触れない
    {
        let cfg = lib.join("hk1_settings");
        fs::create_dir_all(&cfg).unwrap();
        let v1 = serde_json::json!({ "lang": "ja", "theme": "dark", "gen": 1 });
        let v2 = serde_json::json!({ "lang": "ja", "theme": "light", "gen": 2 });
        let dest = cfg.join("settings.json");
        let bak = cfg.join("settings.json.bak");

        // 9-1: ふつうの往復
        animemo_lib::save_settings_impl(&cfg, &v1).expect("save v1");
        assert_eq!(animemo_lib::load_settings_impl(&cfg), v1);
        ok("HK1: settings の書き込み→読み込みが往復する");

        // 9-2: 2回目の書き込みで .bak に1世代前が残る（W-1 と同じ形）
        animemo_lib::save_settings_impl(&cfg, &v2).expect("save v2");
        assert_eq!(animemo_lib::load_settings_impl(&cfg), v2);
        let bak_v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&bak).expect(".bak が無い")).unwrap();
        assert_eq!(bak_v, v1, ".bak が1世代前になっていない");
        ok("HK1: .bak に1世代前が残る");

        // 9-3: クラッシュ窓① — tmp を書いている途中で死んだ（半端な tmp が残る）。
        // dest は旧の完全な内容のまま＝読める
        fs::write(cfg.join("settings.json.99.tmp"), b"{\"half\":").unwrap();
        assert_eq!(animemo_lib::load_settings_impl(&cfg), v2);
        ok("HK1: 窓①（tmp 書き込み中に死亡）でも設定は旧内容のまま読める");

        // 9-4: クラッシュ窓② — `dest → .bak` の退避直後・確定 rename の前に死んだ。
        // dest が存在しない瞬間。従来はここで「初回起動」と誤認して**全設定が既定に戻った**
        fs::remove_file(&bak).ok();
        fs::rename(&dest, &bak).unwrap(); // 窓②の状態を作る（dest 無し・.bak=直近）
        assert_eq!(animemo_lib::load_settings_impl(&cfg), v2, "窓②で設定が失われた");
        ok("HK1: 窓②（退避後・確定前に死亡）でも .bak から復旧する");

        // 9-5: dest が壊れた JSON でも .bak から復旧し、壊れたものは .broken に残る
        animemo_lib::save_settings_impl(&cfg, &v2).expect("save v2 again"); // 状態を直す
        animemo_lib::save_settings_impl(&cfg, &v1).expect("save v1 (bak=v2)");
        fs::write(&dest, b"{ broken json !!").unwrap();
        assert_eq!(animemo_lib::load_settings_impl(&cfg), v2, ".bak からの復旧に失敗");
        assert!(cfg.join("settings.json.broken").is_file(), "壊れた設定が .broken に残っていない");
        ok("HK1: 壊れた settings は .broken へ退避し .bak から復旧する");

        // 9-6: .bak も無いときだけ既定値＋ __recovered（フロントの案内はこのときだけ）
        fs::remove_file(&dest).ok();
        fs::remove_file(&bak).ok();
        fs::remove_file(cfg.join("settings.json.broken")).ok();
        fs::write(&dest, b"{ broken json !!").unwrap();
        let got = animemo_lib::load_settings_impl(&cfg);
        assert_eq!(got.get("__recovered"), Some(&serde_json::json!(true)), "__recovered が立っていない");
        ok("HK1: .bak も無いときだけ既定値へ（__recovered でフロントが案内）");

        // 9-7: まっさら（初回起動）は空オブジェクト
        fs::remove_file(&dest).ok();
        fs::remove_file(cfg.join("settings.json.broken")).ok();
        assert_eq!(animemo_lib::load_settings_impl(&cfg), serde_json::json!({}));
        ok("HK1: 初回起動は空オブジェクト（案内は出ない）");
    }

    if temp {
        let _ = fs::remove_dir_all(&lib);
    }
    println!("\nv154_smoke: ALL OK");
}
