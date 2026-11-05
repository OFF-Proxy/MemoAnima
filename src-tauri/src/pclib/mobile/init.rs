//! V211 (M-1b・要件 docs/REQ_mobile_m1_base.md §6-2・決-2): 初めて起動したときに、ライブラリを作り終える。
//!
//! 手順（どれも「あるものは作り直さない・消さない」＝途中で止まっても次の起動で続きから安全にやり直せる）:
//!  1. ライブラリのフォルダ（iOS は Documents＝在る）
//!  2. 既定のアルバム（JS が `defaultAlbumName()` を渡す。大小と NFC を無視して同じ名前のアルバムが在れば作らない）
//!  3. 空の索引（PC の索引と同じ形＝`version: 1`・`items: []`。pclib の `save_index` を通す。形が違うと `load_index` が `.broken` に
//!     退けて作り直し、その `.broken` がファイル App に見える）。在れば（壊れていても）触らない
//!  4. 最後に「作り終えた印」を、設定（`app_config_dir` の `settings.json` に足すキー [`READY_KEY`]）に書く（ファイル App から見えない所）。
//!     設定のほかのキーはそのまま（読んで足して書く・PC の `load_settings_impl`・`save_settings_impl` を通す）
//! - 印があれば何もしない。印は M-4 で「索引が消されたのか、初めから無いのか」を見分けるのに使う（この回では拾い直しをしない）
//! - ライブラリと設定の場所は JS から受けない（[`Dirs`]＝命令の皮が OS から取る）。受けるのは既定のアルバムの名前だけ

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;

use super::names::{self, fold_key};
use super::{code, io_refusal, Dirs, Refusal, STOPPED};
use crate::pclib::{index_path, lock_lib, save_index, LibraryIndex};

/// 作り終えた印の設定のキー（contract.json の settingsKey）
pub const READY_KEY: &str = "mobileLibraryReady";

/// 手順の名前（contract.json の initSteps と同じ並び）
pub const STEPS: &[&str] = &["library", "album", "index", "mark"];

/// 結果（contract.json の types.LibraryInit）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInit {
    /// この回にしたこと（STEPS の名前）
    pub steps: Vec<String>,
    /// 作り終えた印がある
    pub ready: bool,
}

/// 引数（contract.json の commands の mobile_library_init.args）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryInitArgs {
    /// 既定のアルバムの名前（JS の defaultAlbumName()）
    pub album: String,
}

/// 作り終えた印があるか
pub fn is_ready(d: &Dirs) -> bool {
    crate::load_settings_impl(&d.config).get(READY_KEY).and_then(|v| v.as_bool()) == Some(true)
}

/// ★ライブラリを作り終える。`stop_after` は検査の口（その手順のあとで止まったことにする＝`STOPPED`）。製品は `None`
pub fn init_library(d: &Dirs, album: &str, stop_after: Option<&str>) -> Result<LibraryInit, Refusal> {
    let a = names::new_album_name(album)?;
    let _guard = lock_lib();
    if is_ready(d) {
        return Ok(LibraryInit { steps: vec![], ready: true });
    }
    let mut steps: Vec<String> = Vec::new();
    let stop = |step: &str| -> Result<(), Refusal> {
        if stop_after == Some(step) {
            Err(Refusal(STOPPED))
        } else {
            Ok(())
        }
    };
    // 1. ライブラリのフォルダ
    if !d.lib.is_dir() {
        fs::create_dir_all(&d.lib).map_err(|e| io_refusal(&e))?;
        steps.push("library".into());
    }
    stop("library")?;
    // 2. 既定のアルバム（同じ名前〔大小・NFC を無視〕が在れば作らない）
    if !names::album_taken(&d.lib, &fold_key(&a), None).map_err(|e| io_refusal(&e))? {
        match fs::create_dir(d.lib.join(&a)) {
            Ok(()) => steps.push("album".into()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io_refusal(&e)),
        }
    }
    stop("album")?;
    // 3. 空の索引（在れば触らない＝壊れていても退けない。直すのはライブラリを開くときの PC の道）
    if fs::symlink_metadata(index_path(&d.lib)).is_err() {
        let empty = LibraryIndex { version: 1, ..Default::default() };
        save_index(&d.lib, &empty).map_err(|_| Refusal(code::IO))?;
        steps.push("index".into());
    }
    stop("index")?;
    // 4. 最後に印（設定のほかのキーはそのまま。読めなかった設定の「復旧した」印は書き戻さない）
    let mut settings = crate::load_settings_impl(&d.config);
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    if let Some(m) = settings.as_object_mut() {
        m.remove("__recovered");
        m.insert(READY_KEY.to_string(), serde_json::Value::Bool(true));
    }
    crate::save_settings_impl(&d.config, &settings).map_err(|_| Refusal(code::IO))?;
    steps.push("mark".into());
    Ok(LibraryInit { steps, ready: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("v211-init-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn dirs(root: &std::path::Path) -> Dirs {
        Dirs::under(root.join("lib"), &root.join("config"))
    }
    fn names_in(p: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(p).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        v.sort();
        v
    }

    /// ★初めて: 4 つの手順を全部して印がある。索引は PC の索引と同じ形（load_index がそのまま読む＝.broken を作らない）
    #[test]
    fn first_run_makes_album_index_and_mark() {
        let root = tmp("first");
        let d = dirs(&root);
        let r = init_library(&d, "未分類", None).unwrap();
        assert_eq!(r.steps, vec!["library", "album", "index", "mark"]);
        assert!(r.ready && is_ready(&d));
        // ★決-4: 設定に絶対パスを書かない（印は true だけ）
        let settings = fs::read_to_string(d.config.join("settings.json")).unwrap();
        for p in [&d.lib, &d.config, &root] {
            assert!(!settings.contains(&*p.to_string_lossy()), "設定に絶対パスを書いた");
        }
        assert!(!settings.contains(std::path::MAIN_SEPARATOR) && !settings.contains('/'), "設定にパスらしい字を書いた: {settings}");
        assert_eq!(names_in(&d.lib), vec!["animemo-library.json".to_string(), "未分類".to_string()]);
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(index_path(&d.lib)).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["items"], serde_json::json!([]));
        crate::pclib::load_index(&d.lib).unwrap();
        assert_eq!(names_in(&d.lib).len(), 2, "load_index が .broken を作った");
        // もう 1 回: 何もしない
        let before = fs::read(index_path(&d.lib)).unwrap();
        let r2 = init_library(&d, "未分類", None).unwrap();
        assert!(r2.steps.is_empty() && r2.ready);
        assert_eq!(fs::read(index_path(&d.lib)).unwrap(), before);
        let _ = fs::remove_dir_all(&root);
    }

    /// ★各手順のあとで止めても、もう 1 回走らせると続きから作り終える（あるものは作り直さない・消さない）
    #[test]
    fn resumes_after_stop_at_each_step() {
        for (i, step) in ["library", "album", "index"].iter().enumerate() {
            let root = tmp(&format!("stop-{step}"));
            let d = dirs(&root);
            assert_eq!(init_library(&d, "未分類", Some(step)), Err(Refusal(STOPPED)));
            assert!(!is_ready(&d), "{step} で止めたのに印がある");
            // 止まったあとに利用者が作品を入れても消さない
            if i >= 1 {
                fs::write(d.lib.join("未分類").join("w.memoanima"), b"x").unwrap();
            }
            let r = init_library(&d, "未分類", None).unwrap();
            let want: Vec<&str> = STEPS[i + 1..].to_vec();
            assert_eq!(r.steps, want, "{step} のあとの続き");
            assert!(is_ready(&d));
            if i >= 1 {
                assert_eq!(fs::read(d.lib.join("未分類").join("w.memoanima")).unwrap(), b"x");
            }
            let _ = fs::remove_dir_all(&root);
        }
    }

    /// 同じ名前（大小・NFC）のアルバム・壊れた索引・設定のほかのキーは、そのまま
    #[test]
    fn keeps_what_exists() {
        let root = tmp("keep");
        let d = dirs(&root);
        fs::create_dir_all(d.lib.join("UNSORTED")).unwrap();
        fs::write(index_path(&d.lib), b"{broken").unwrap();
        fs::create_dir_all(&d.config).unwrap();
        crate::save_settings_impl(&d.config, &serde_json::json!({ "lang": "ja", "x": 1 })).unwrap();
        let r = init_library(&d, "Unsorted", None).unwrap();
        assert_eq!(r.steps, vec!["mark"]);
        assert_eq!(fs::read(index_path(&d.lib)).unwrap(), b"{broken");
        assert_eq!(names_in(&d.lib), vec!["UNSORTED".to_string(), "animemo-library.json".to_string()]);
        let s = crate::load_settings_impl(&d.config);
        assert_eq!(s["lang"], "ja");
        assert_eq!(s["x"], 1);
        assert_eq!(s[READY_KEY], true);
        let _ = fs::remove_dir_all(&root);
    }

    /// 使えない名前は断る（何も作らない）
    #[test]
    fn bad_album_name_is_refused() {
        let root = tmp("bad");
        let d = dirs(&root);
        assert!(init_library(&d, ".hidden", None).is_err());
        assert!(!d.lib.exists() && !is_ready(&d));
        let _ = fs::remove_dir_all(&root);
    }
}
