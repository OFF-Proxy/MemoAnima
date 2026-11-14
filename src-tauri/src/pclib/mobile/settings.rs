//! V220 (M-2b-1b・要件 docs/REQ_mobile_m2_editor.md §5-1 の 2・決-17・C5): **モバイルの設定の口**（読む・渡したキーだけを直す）。
//!
//! ★PC の `save_settings`（ファイル全体を置き換える）はモバイルに出さない（V211 で登録から外した＝L1）。モバイルの画面は、
//!  この口で「キー → 値」の 1 段の表を渡し、Rust が `lock_lib()` を持ったまま **読む → `__recovered` を外す → 渡したキーだけを置く →
//!  `save_settings_impl`** の順で書く。渡していないキーは 1 つも変えない。**キーを消す口は作らない**（不変条件 #5「settings は追加のみ」・
//!  PC も消さない）。
//! ★断る（決まった値で返し、ファイルに触らない＝読みもしない）:
//!  - Rust が書くキー（`mobileLibraryReady`＝[`super::init::READY_KEY`]）と `__` で始まるキー（`__recovered` ほか）→ `reserved-key`
//!  - 値が null（キーを消す・null で潰す形）・表でない引数・空のキー → `bad-request`
//!  - 空の表 → 何もしない（ファイルに触らない・成功）
//! ★置き場は Rust が決める（`dirs_from_app` の `config`）。確かめ画面の印のビルドで試験用のライブラリを開いている間は、試験用の側の設定に
//!  書く（本物の側に 1 バイトも書かない）。
//! ★読む口は PC の `load_settings_impl` のまま（壊れていれば PC と同じ段＝`.broken` に退けて `.bak`、それもだめなら
//!  `{"__recovered": true}`）。`__recovered` は外さずに返す（画面が「設定を戻しました」の案内に使う）。読む口も鍵を持つ
//!  （壊れた設定を `.broken` へ退ける＝ファイルを動かすので、直す口・作り終える手続きと重ならないように）。
//!
//! **キーの決まり（画面の側への約束・M-2b-3 で設定の画面を作るときに守る）**
//! - キーは足すだけ・意味を変えない（親§3-7）。PC が設定に書いているキー（配色 `theme`・確認 `hiddenConfirms` と `frameDeleteConfirm`・
//!   キーの割り当て `keys`・よく使う色・マイ柄・オニオン ほか）は、**PC のキーと PC の値の形**を使う。
//! - モバイルだけの設定は `mobile` で始まる名前にする（今の `mobileLibraryReady` と同じ）。この回ではまだ作らない（画面と一緒に M-2b-3）。
//! - PC が保存しないもの（ピクセル格子・筆圧で太さ・手ブレ補正）は、モバイルでも保存しない（開き直すと既定に戻る＝PC と同じ）。
//! - 1 つのキーに複数の画面の値が入るもの（`hiddenConfirms`）は、**画面の側で今の値と混ぜてから**渡す（PC の `main.ts` の
//!   `mergeEditorHiddenConfirms` と同じ）。この口はキーの中身を混ぜない（値を丸ごと置く）。
//! - ★命令は同期（ほかのモバイルの命令と同じ）。保存が `lock_lib` を持つ間、主スレッドで鍵を待つことになる。保存を主スレッドの外へ出す
//!   M-2b-4 で、この口も async にするかを決める（申し送り）。

use serde::{Deserialize, Serialize};

use super::{code, Dirs, Refusal};
use crate::pclib::lock_lib;

/// 直す口の引数（contract.json の mobile_settings_merge.args）。`values` は「キー → 値」の 1 段の表
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsMergeArgs {
    pub values: serde_json::Value,
}

/// Rust だけが書くキーか（`mobileLibraryReady`・`__` で始まるもの）
pub fn is_reserved_key(k: &str) -> bool {
    k == super::init::READY_KEY || k.starts_with("__")
}

/// ★渡された表を確かめる（ファイルに触る前）。断りは決まった値
pub fn check_values(values: &serde_json::Value) -> Result<&serde_json::Map<String, serde_json::Value>, Refusal> {
    let m = values.as_object().ok_or(Refusal(code::BAD_REQUEST))?;
    for (k, v) in m {
        if k.is_empty() || v.is_null() {
            return Err(Refusal(code::BAD_REQUEST));
        }
        if is_reserved_key(k) {
            return Err(Refusal(code::RESERVED_KEY));
        }
    }
    Ok(m)
}

/// ★読む（PC の `load_settings_impl` と同じ段で戻す・`__recovered` はそのまま返す）
pub fn read(d: &Dirs) -> serde_json::Value {
    let _guard = lock_lib();
    crate::load_settings_impl(&d.config)
}

/// ★渡したキーだけを直す
pub fn merge(d: &Dirs, values: &serde_json::Value) -> Result<(), Refusal> {
    merge_with(d, values, &mut || {})
}

/// `between` は検査の口（読んでから書くまでの間・鍵を持ったまま呼ぶ）。製品は何もしない手を渡す
pub fn merge_with(d: &Dirs, values: &serde_json::Value, between: &mut dyn FnMut()) -> Result<(), Refusal> {
    let m = check_values(values)?;
    if m.is_empty() {
        return Ok(());
    }
    let _guard = lock_lib();
    let mut settings = crate::load_settings_impl(&d.config);
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    between();
    if let Some(s) = settings.as_object_mut() {
        // 読めなかった設定の「復旧した」印は書き戻さない（ライブラリを作り終える手続きと同じ）
        s.remove("__recovered");
        for (k, v) in m {
            s.insert(k.clone(), v.clone());
        }
    }
    crate::save_settings_impl(&d.config, &settings).map_err(|_| Refusal(code::IO))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    static N: AtomicU64 = AtomicU64::new(0);

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("v220-set-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn dirs(root: &Path) -> Dirs {
        Dirs::under(root.join("lib"), &root.join("config"))
    }
    fn file(d: &Dirs) -> PathBuf {
        d.config.join("settings.json")
    }
    fn on_disk(d: &Dirs) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(file(d)).unwrap()).unwrap()
    }
    fn put(d: &Dirs, v: serde_json::Value) {
        fs::create_dir_all(&d.config).unwrap();
        crate::save_settings_impl(&d.config, &v).unwrap();
    }

    /// ★渡したキーだけが変わる・ほかのキーと mobileLibraryReady は残る
    #[test]
    fn merge_changes_only_given_keys() {
        let root = tmp("only");
        let d = dirs(&root);
        put(&d, serde_json::json!({ "theme": "light", "lang": "ja", "mobileLibraryReady": true, "keys": { "preset": "standard" } }));
        merge(&d, &serde_json::json!({ "theme": "dark", "mobileX": 3 })).unwrap();
        let s = on_disk(&d);
        assert_eq!(s["theme"], "dark");
        assert_eq!(s["mobileX"], 3);
        assert_eq!(s["lang"], "ja", "渡していないキーが変わった");
        assert_eq!(s["keys"], serde_json::json!({ "preset": "standard" }));
        assert_eq!(s["mobileLibraryReady"], true, "Rust の印が消えた");
        assert_eq!(s.as_object().unwrap().len(), 5);
        // 読む口は同じものを返す
        assert_eq!(read(&d), s);
        let _ = fs::remove_dir_all(&root);
    }

    /// ★Rust のキー・`__` のキー・null・表でない・空のキーは断り、ファイルのバイトが変わらない（.bak も作らない）
    #[test]
    fn refused_values_leave_file_untouched() {
        let root = tmp("refuse");
        let d = dirs(&root);
        put(&d, serde_json::json!({ "theme": "light", "mobileLibraryReady": true }));
        let before = fs::read(file(&d)).unwrap();
        let bak_before = fs::read(d.config.join("settings.json.bak")).ok();
        let cases: Vec<(serde_json::Value, &str)> = vec![
            (serde_json::json!({ "mobileLibraryReady": false }), code::RESERVED_KEY),
            (serde_json::json!({ "theme": "dark", "mobileLibraryReady": false }), code::RESERVED_KEY),
            (serde_json::json!({ "__recovered": true }), code::RESERVED_KEY),
            (serde_json::json!({ "__x": 1 }), code::RESERVED_KEY),
            (serde_json::json!({ "theme": null }), code::BAD_REQUEST),
            (serde_json::json!({ "": 1 }), code::BAD_REQUEST),
            (serde_json::json!([["theme", "dark"]]), code::BAD_REQUEST),
            (serde_json::json!("theme"), code::BAD_REQUEST),
            (serde_json::Value::Null, code::BAD_REQUEST),
        ];
        for (v, want) in cases {
            assert_eq!(merge(&d, &v), Err(Refusal(want)), "{v}");
            assert_eq!(fs::read(file(&d)).unwrap(), before, "断ったのに書いた: {v}");
            assert_eq!(fs::read(d.config.join("settings.json.bak")).ok(), bak_before, "断ったのに .bak が動いた: {v}");
        }
        // 空の表は何もしない（ファイルに触らない）
        merge(&d, &serde_json::json!({})).unwrap();
        assert_eq!(fs::read(file(&d)).unwrap(), before);
        let _ = fs::remove_dir_all(&root);
    }

    /// ★壊れた設定: PC と同じ段で戻る（.broken に退けて .bak）。読む口は __recovered を返し、直しても __recovered は書かれない
    #[test]
    fn broken_settings_recover_like_pc_and_never_write_recovered() {
        // (1) .bak が読める → .bak の中身
        let root = tmp("broken-bak");
        let d = dirs(&root);
        put(&d, serde_json::json!({ "theme": "light" }));
        put(&d, serde_json::json!({ "theme": "dark" })); // .bak＝light
        fs::write(file(&d), b"{broken").unwrap();
        let r = read(&d);
        assert_eq!(r["theme"], "light");
        assert_eq!(fs::read(d.config.join("settings.json.broken")).unwrap(), b"{broken", ".broken に退けていない");
        // (2) .bak もだめ → __recovered
        let root2 = tmp("broken-all");
        let d2 = dirs(&root2);
        fs::create_dir_all(&d2.config).unwrap();
        fs::write(file(&d2), b"{broken").unwrap();
        fs::write(d2.config.join("settings.json.bak"), b"also broken").unwrap();
        assert_eq!(read(&d2), serde_json::json!({ "__recovered": true }), "読む口は __recovered を返す");
        // 壊れた設定から直す（まだ .broken に退けていない形でも）
        fs::write(file(&d2), b"{broken again").unwrap();
        merge(&d2, &serde_json::json!({ "theme": "dark" })).unwrap();
        let s = on_disk(&d2);
        assert_eq!(s, serde_json::json!({ "theme": "dark" }), "__recovered を書いた: {s}");
        assert!(!fs::read_to_string(file(&d2)).unwrap().contains("__recovered"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }

    /// 読みを片側で止めている間に、もう片方を走らせる（鍵が無いと、もう片方は止めている間に書き終える）。
    /// 返すのは「もう片方が止めている間に終わったか」
    fn overlap(d: &Dirs, first: serde_json::Value, second: impl FnOnce() + Send + 'static) -> bool {
        let (read_tx, read_rx) = mpsc::channel::<()>();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let d1 = d.clone();
        let a = std::thread::spawn(move || {
            merge_with(&d1, &first, &mut || {
                read_tx.send(()).unwrap();
                // 鍵を持ったまま、もう片方が走る間を待つ
                let _ = go_rx.recv_timeout(Duration::from_secs(20));
            })
            .unwrap();
        });
        read_rx.recv_timeout(Duration::from_secs(20)).expect("片側が読まなかった");
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let b = std::thread::spawn(move || {
            second();
            let _ = done_tx.send(());
        });
        // 鍵があれば、もう片方は止めている間に終われない（0.8 秒待つ）
        let finished_while_held = done_rx.recv_timeout(Duration::from_millis(800)).is_ok();
        go_tx.send(()).unwrap();
        a.join().unwrap();
        b.join().unwrap();
        finished_while_held
    }

    /// ★2 つの直しが重なっても、両方のキーが残る（読んでから書くまでの間を止めて、もう片方を走らせる）
    #[test]
    fn two_merges_overlapping_keep_both_keys() {
        let root = tmp("two");
        let d = dirs(&root);
        put(&d, serde_json::json!({ "base": 1 }));
        let d2 = d.clone();
        let raced = overlap(&d, serde_json::json!({ "a": 1 }), move || merge(&d2, &serde_json::json!({ "b": 2 })).unwrap());
        assert!(!raced, "鍵を持っている間にもう片方が書き終えた");
        let s = on_disk(&d);
        assert_eq!((s["a"].clone(), s["b"].clone(), s["base"].clone()), (serde_json::json!(1), serde_json::json!(2), serde_json::json!(1)), "片方のキーが消えた: {s}");
        let _ = fs::remove_dir_all(&root);
    }

    /// ★読む口も鍵を待つ（壊れた設定を .broken へ退ける＝ファイルを動かすので、直しの途中に割り込まない・V220 の独立レビューの確かめで足した）
    #[test]
    fn read_waits_for_merge_in_progress() {
        let root = tmp("read");
        let d = dirs(&root);
        put(&d, serde_json::json!({ "base": 1 }));
        let d2 = d.clone();
        let raced = overlap(&d, serde_json::json!({ "a": 1 }), move || {
            let _ = read(&d2);
        });
        assert!(!raced, "直しの途中に読む口が鍵を待たずに終わった");
        let _ = fs::remove_dir_all(&root);
    }

    /// ★ライブラリを作り終える手続きと重なっても、印（mobileLibraryReady）が消えない
    #[test]
    fn merge_overlapping_library_init_keeps_mark() {
        let root = tmp("init");
        let d = dirs(&root);
        put(&d, serde_json::json!({ "lang": "ja" }));
        let d2 = d.clone();
        let raced = overlap(&d, serde_json::json!({ "theme": "dark" }), move || {
            super::super::init::init_library(&d2, "未分類", None).unwrap();
        });
        assert!(!raced, "鍵を持っている間に作り終える手続きが書き終えた");
        let s = on_disk(&d);
        assert_eq!(s[super::super::init::READY_KEY], true, "印が消えた: {s}");
        assert_eq!(s["theme"], "dark");
        assert_eq!(s["lang"], "ja");
        let _ = fs::remove_dir_all(&root);
    }

    /// ★試験用のライブラリを開いている間は、試験用の側だけに書く（本物の側は 1 バイトも変わらない）。ログも同じ
    #[test]
    fn test_library_writes_only_test_side() {
        let _g = super::super::devcheck::SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("devcheck");
        let real_config = root.join("real-config");
        let real_lib = root.join("real-lib");
        let real = Dirs::under(real_lib.clone(), &real_config);
        put(&real, serde_json::json!({ "theme": "light", "mobileLibraryReady": true }));
        fs::create_dir_all(&real.logs).unwrap();
        fs::write(real.logs.join("memoanima.log"), b"real\n").unwrap();
        let snapshot = |p: &Path| -> Vec<(PathBuf, Vec<u8>)> {
            let mut v = Vec::new();
            let mut st = vec![p.to_path_buf()];
            while let Some(x) = st.pop() {
                if let Ok(rd) = fs::read_dir(&x) {
                    for e in rd.flatten() {
                        let ep = e.path();
                        if ep.starts_with(real_config.join(super::super::devcheck::TEST_DIR)) {
                            continue;
                        }
                        if ep.is_dir() {
                            st.push(ep);
                        } else {
                            v.push((ep.clone(), fs::read(&ep).unwrap()));
                        }
                    }
                }
            }
            v.sort();
            v
        };
        let before = snapshot(&root);
        super::super::devcheck::open(&real_config).unwrap();
        let d = super::super::devcheck::switched(real_lib.clone(), &real_config);
        merge(&d, &serde_json::json!({ "theme": "dark" })).unwrap();
        super::super::applog::append(&d, "x").unwrap();
        let test_s = on_disk(&d);
        super::super::devcheck::close();
        assert_eq!(test_s["theme"], "dark");
        assert!(d.config.starts_with(real_config.join(super::super::devcheck::TEST_DIR)));
        assert!(d.logs.join("memoanima.log").is_file(), "試験用の側のログに書いていない");
        assert_eq!(snapshot(&root), before, "本物の側が変わった");
        assert_eq!(read(&real)["theme"], "light");
        let _ = fs::remove_dir_all(&root);
    }
}
