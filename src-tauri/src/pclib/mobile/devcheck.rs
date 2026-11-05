//! V211 (M-1b・要件 §6-5・決-6): 確かめ画面（開発用）の Rust の側。**ビルドの印（feature `mobile-devcheck`）の中だけ**。
//!
//! ★試験用のライブラリ: ファイル App から見えない所（`app_config_dir/devcheck/` の下）に作る。作者の作品を入れない。開いている間は、
//!  ライブラリ・開いた作品ごとのオートセーブ・退避先・ログ・設定の置き場を**全部**試験用の側に切り替える（命令の皮の `dirs_from_app`・
//!  `library_root` がここを見る＝本物の側に 1 バイトも書かない）。
//! ★開いているかの正は**この Rust の状態だけ**（プロセスの中の値＝起動したら必ず本物の側に戻る）。JS は画面を出すたびに聞く。
//! ★故障を起こす操作（空きが無いふり・保存の途中で止める・メモリを使い切る）は、**試験用のライブラリを開いているときだけ**。
//!  画面で押せないだけでなく、ここ（命令の側）でも断る。止める口は V202 の検査の口（`save::Hooks`・`Stage`）の実装で、
//!  製品の道（印の無いビルド）は `NoHooks` のまま。
//! ★記録（裏に回った・戻った・書き始めた・書き終えた）は、置き場のログのフォルダの `lifecycle.log` に 1 行ずつ（作品名・パスを書かない
//!  決まった文だけ＝W-10）。画面に出してコピーできる。送らない。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;

use super::save::{Hooks, Stage, StageCtx, Step};
use super::Dirs;

/// 試験用のライブラリの置き場（app_config_dir の下・ファイル App から見えない）
pub const TEST_DIR: &str = "devcheck";

/// 故障を起こす操作を本物のライブラリで呼んだ（命令の側で断る）
pub const NOT_TEST_LIBRARY: &str = "not-test-library";

/// 故障の種類（JS から受ける値）
pub const FAULTS: &[&str] = &["no-space", "stop-after-temp", "stop-after-evac", "memory"];

static OPEN: AtomicBool = AtomicBool::new(false);
static FAKE_NO_SPACE: AtomicBool = AtomicBool::new(false);
/// 0＝止めない・1＝一時ファイルを書いたあと・2＝控え（退避先）へ移したあと（1 回だけ）
static STOP_AT: AtomicU8 = AtomicU8::new(0);
/// 開いた試験用のライブラリ（故障を起こす口は、渡された置き場がここのときだけ効く）
static TEST_LIB: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 試験用の置き場（ライブラリと設定）。`real_config` は本物の app_config_dir
pub fn test_paths(real_config: &Path) -> (PathBuf, PathBuf) {
    let base = real_config.join(TEST_DIR);
    (base.join("library"), base.join("config"))
}

/// 開いているか（Rust の状態だけが正）
pub fn is_open() -> bool {
    OPEN.load(Ordering::SeqCst)
}

/// 開いているなら、試験用の置き場（ライブラリ・設定）
pub fn open_paths(real_config: &Path) -> Option<(PathBuf, PathBuf)> {
    is_open().then(|| test_paths(real_config))
}

/// ★命令の皮が使う置き場（本物のライブラリと本物の app_config_dir を受け、開いていれば試験用の側を返す）。ライブラリ・オートセーブ・
/// 退避先・ログ・設定は全部この 2 つの下（Dirs::under）なので、開いている間は本物の側を指すものが 1 つも無い
pub fn switched(real_lib: PathBuf, real_config: &Path) -> Dirs {
    match open_paths(real_config) {
        Some((lib, config)) => Dirs::under(lib, &config),
        None => Dirs::under(real_lib, real_config),
    }
}

/// 試験用のライブラリを開く（フォルダを作る。中身は JS が mobile_library_init で作り終える）
pub fn open(real_config: &Path) -> std::io::Result<()> {
    let (lib, config) = test_paths(real_config);
    std::fs::create_dir_all(&lib)?;
    std::fs::create_dir_all(&config)?;
    *TEST_LIB.lock().unwrap_or_else(|e| e.into_inner()) = Some(lib);
    OPEN.store(true, Ordering::SeqCst);
    Ok(())
}

/// 閉じる（本物の側に戻す・故障の印も下ろす）
pub fn close() {
    OPEN.store(false, Ordering::SeqCst);
    FAKE_NO_SPACE.store(false, Ordering::SeqCst);
    STOP_AT.store(0, Ordering::SeqCst);
    *TEST_LIB.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 渡された置き場が、開いている試験用のライブラリか
fn is_test_lib(d: &Dirs) -> bool {
    is_open() && TEST_LIB.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(d.lib.as_path())
}

/// ★故障を起こす（試験用のライブラリを開いていなければ断る）。`on` が false なら下ろす（下ろすのはいつでもよい）
pub fn set_fault(kind: &str, on: bool) -> Result<(), &'static str> {
    if !FAULTS.contains(&kind) {
        return Err(super::code::BAD_REQUEST);
    }
    if on && !is_open() {
        return Err(NOT_TEST_LIBRARY);
    }
    match (kind, on) {
        ("no-space", v) => FAKE_NO_SPACE.store(v, Ordering::SeqCst),
        ("stop-after-temp", true) => STOP_AT.store(1, Ordering::SeqCst),
        ("stop-after-evac", true) => STOP_AT.store(2, Ordering::SeqCst),
        ("stop-after-temp", false) | ("stop-after-evac", false) => STOP_AT.store(0, Ordering::SeqCst),
        // メモリを使い切るのは JS（ここは試験用のライブラリかを確かめるだけ）
        _ => {}
    }
    Ok(())
}

/// いまの故障の印（画面に出す）
pub fn faults() -> serde_json::Value {
    serde_json::json!({
        "noSpace": FAKE_NO_SPACE.load(Ordering::SeqCst),
        "stopAt": match STOP_AT.load(Ordering::SeqCst) { 1 => "stop-after-temp", 2 => "stop-after-evac", _ => "" },
    })
}

/// ★空きが無いふり（試験用のライブラリの置き場のときだけ）
pub fn fake_no_space(d: &Dirs) -> bool {
    FAKE_NO_SPACE.load(Ordering::SeqCst) && is_test_lib(d)
}

/// ★保存の途中で止める口（V202 の検査の口の実装）。止めるのは試験用のライブラリの置き場のときだけ・1 回だけ
pub struct DevHooks {
    stop: u8,
    kill: fn(),
}

impl DevHooks {
    /// 保存の命令が受け取る（試験用のライブラリでなければ止めない）
    pub fn for_save(d: &Dirs) -> DevHooks {
        let stop = if is_test_lib(d) { STOP_AT.swap(0, Ordering::SeqCst) } else { 0 };
        DevHooks { stop, kill: kill_now }
    }
    #[cfg(test)]
    fn with(stop: u8, kill: fn()) -> DevHooks {
        DevHooks { stop, kill }
    }
}

/// アプリを止める（OS に止められたのをまねる＝後片付けをしない）
fn kill_now() {
    std::process::abort();
}

impl Hooks for DevHooks {
    fn at(&mut self, stage: Stage, _ctx: &StageCtx) -> Step {
        let hit = match self.stop {
            // 一時ファイルを書いて確かめたあと（上書きは照合のあと・新しく保存は置く直前）
            1 => matches!(stage, Stage::Checked | Stage::BeforePlaceNew),
            // 前のファイルを退避先へ移した直後
            2 => stage == Stage::Evacuated,
            _ => false,
        };
        if hit {
            (self.kill)();
        }
        Step::Go
    }
}

/// 記録（lifecycle.log）に 1 行（決まった文だけ）
pub fn log_lifecycle(d: &Dirs, line: &str) {
    let clean: String = line.chars().filter(|c| !c.is_control()).take(200).collect();
    let _ = std::fs::create_dir_all(&d.logs);
    let p = d.logs.join("lifecycle.log");
    if std::fs::metadata(&p).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&p, d.logs.join("lifecycle.log.1"));
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{clean}");
    }
}

/// 記録の終わりの n 行
pub fn lifecycle_tail(d: &Dirs, n: usize) -> Vec<String> {
    let s = std::fs::read_to_string(d.logs.join("lifecycle.log")).unwrap_or_default();
    let lines: Vec<String> = s.lines().map(String::from).collect();
    lines[lines.len().saturating_sub(n)..].to_vec()
}

// ---------------- Tauri の命令（印の中だけ） ----------------

#[cfg(feature = "mobile-devcheck")]
pub mod commands {
    use super::*;
    use tauri::Manager;

    fn real_config(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        app.path().app_config_dir().map_err(|_| super::super::code::IO.to_string())
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct FaultArgs {
        pub kind: String,
        pub on: bool,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct LogArgs {
        pub line: String,
    }

    /// いまの状態（試験用のライブラリを開いているか・故障の印）
    #[tauri::command]
    pub fn mobile_dev_state() -> serde_json::Value {
        serde_json::json!({ "testLibrary": is_open(), "faults": faults() })
    }

    #[tauri::command]
    pub fn mobile_dev_open_test_library(app: tauri::AppHandle) -> Result<(), String> {
        let c = real_config(&app)?;
        open(&c).map_err(|_| super::super::code::IO.to_string())
    }

    #[tauri::command]
    pub fn mobile_dev_close_test_library() {
        close();
    }

    #[tauri::command]
    pub fn mobile_dev_fault(args: FaultArgs) -> Result<(), String> {
        set_fault(&args.kind, args.on).map_err(String::from)
    }

    #[tauri::command]
    pub fn mobile_dev_log(app: tauri::AppHandle, args: LogArgs) -> Result<(), String> {
        let d = super::super::commands::dirs_from_app(&app)?;
        log_lifecycle(&d, &args.line);
        Ok(())
    }

    #[tauri::command]
    pub fn mobile_dev_log_tail(app: tauri::AppHandle) -> Result<Vec<String>, String> {
        let d = super::super::commands::dirs_from_app(&app)?;
        Ok(lifecycle_tail(&d, 300))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 状態は 1 つのプロセスの中の値なので、ここの試しは順に回す
    static SERIAL: Mutex<()> = Mutex::new(());

    fn d_at(lib: &Path) -> Dirs {
        Dirs::under(lib.to_path_buf(), &lib.join("..").join("cfg"))
    }

    fn panic_kill() {
        panic!("killed");
    }

    /// ★故障を起こす操作は、本物のライブラリ（試験用を開いていない）では断る・空きが無いふりと止める口も効かない
    #[test]
    fn faults_refused_on_real_library() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        close();
        for k in FAULTS {
            assert_eq!(set_fault(k, true), Err(NOT_TEST_LIBRARY), "{k}");
            assert_eq!(set_fault(k, false), Ok(()), "{k} を下ろすのはいつでも");
        }
        assert_eq!(set_fault("unknown", true), Err(super::super::code::BAD_REQUEST));
        let real = std::env::temp_dir().join(format!("v211-dev-real-{}", std::process::id()));
        let d = d_at(&real.join("lib"));
        assert!(!fake_no_space(&d));
        assert_eq!(DevHooks::for_save(&d).stop, 0);
    }

    /// ★試験用を開くと、試験用の置き場でだけ効く（ほかの置き場＝本物には効かない）。閉じると戻る
    #[test]
    fn faults_only_hit_test_library() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let real_config = std::env::temp_dir().join(format!("v211-dev-cfg-{}", std::process::id()));
        open(&real_config).unwrap();
        let (tlib, tcfg) = test_paths(&real_config);
        assert!(tlib.starts_with(real_config.join(TEST_DIR)) && tcfg.starts_with(real_config.join(TEST_DIR)));
        let test_d = Dirs::under(tlib.clone(), &tcfg);
        let real_d = d_at(&real_config.join("real-lib"));
        set_fault("no-space", true).unwrap();
        assert!(fake_no_space(&test_d));
        assert!(!fake_no_space(&real_d), "本物の置き場に空きが無いふりが効いた");
        set_fault("stop-after-temp", true).unwrap();
        assert_eq!(DevHooks::for_save(&real_d).stop, 0, "本物の置き場の保存で止める口が効いた");
        assert_eq!(DevHooks::for_save(&test_d).stop, 1);
        assert_eq!(DevHooks::for_save(&test_d).stop, 0, "止める口は 1 回だけ");
        set_fault("stop-after-evac", true).unwrap();
        close();
        assert!(!is_open() && !fake_no_space(&test_d));
        assert_eq!(DevHooks::for_save(&test_d).stop, 0);
        assert_eq!(faults()["noSpace"], false);
        let _ = std::fs::remove_dir_all(&real_config);
    }

    /// ★開いている間は、置き場が 1 つも本物の側（本物のライブラリ・devcheck の外の app_config_dir）を指さない。閉じれば本物に戻る
    #[test]
    fn switched_dirs_never_touch_real_side() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let real_config = std::env::temp_dir().join(format!("v211-dev-sw-{}", std::process::id()));
        let real_lib = std::env::temp_dir().join(format!("v211-dev-sw-lib-{}", std::process::id()));
        close();
        let d = switched(real_lib.clone(), &real_config);
        assert_eq!(d.lib, real_lib);
        assert_eq!(d.config, real_config);
        open(&real_config).unwrap();
        let d = switched(real_lib.clone(), &real_config);
        let test_base = real_config.join(TEST_DIR);
        for p in [&d.lib, &d.sessions, &d.evac, &d.logs, &d.config] {
            assert!(p.starts_with(&test_base), "試験用の外を指した: {}", p.display());
            assert!(!p.starts_with(&real_lib));
        }
        close();
        assert_eq!(switched(real_lib.clone(), &real_config).lib, real_lib, "閉じても試験用のまま");
        let _ = std::fs::remove_dir_all(&real_config);
    }

    /// ★保存の前の空き（第三者レビューの壊し方 3）: 書く大きさの 2 倍＋16MiB・空きが無いふりで書き始める前に断る（何も置かない）・
    /// ふりは試験用のライブラリの置き場だけ（同じ保存を本物の置き場でするときは断らない）
    #[test]
    fn save_refused_before_writing_when_no_room() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use super::super::{commands, ops};
        assert_eq!(ops::room_needed(10), 20 + ops::ROOM_MARGIN);
        let real_config = std::env::temp_dir().join(format!("v211-dev-room-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&real_config);
        open(&real_config).unwrap();
        let (tlib, tcfg) = test_paths(&real_config);
        std::fs::create_dir_all(tlib.join("A")).unwrap();
        let d = Dirs::under(tlib.clone(), &tcfg);
        let body = crate::pclib::mobile::port_body_for_test(&serde_json::json!({ "album": "A", "name": "w", "selfName": null }), &[b"WORK", b""]);
        set_fault("no-space", true).unwrap();
        assert_eq!(commands::body_save_new(&d, &body, &mut super::super::save::NoHooks).map(|_| ()), Err(super::super::Refusal(super::super::code::NO_SPACE)));
        assert_eq!(std::fs::read_dir(tlib.join("A")).unwrap().count(), 0, "断ったのに何か置いた");
        // 同じ保存を本物の置き場（試験用でない）でするときは、ふりが効かない
        let real_lib = real_config.join("real-lib");
        std::fs::create_dir_all(real_lib.join("A")).unwrap();
        let rd = Dirs::under(real_lib.clone(), &real_config.join("real-cfg"));
        assert!(commands::body_save_new(&rd, &body, &mut super::super::save::NoHooks).is_ok());
        set_fault("no-space", false).unwrap();
        assert!(commands::body_save_new(&d, &body, &mut super::super::save::NoHooks).is_ok(), "ふりを下ろしても書けない");
        close();
        let _ = std::fs::remove_dir_all(&real_config);
    }

    /// 止める口は、ねらった所だけで止める
    #[test]
    fn hooks_stop_at_the_right_stage() {
        let p = Path::new("x");
        let ctx = StageCtx { dir: p, dest: p, evac: None };
        for (stop, hits) in [(1u8, vec![Stage::Checked, Stage::BeforePlaceNew]), (2, vec![Stage::Evacuated])] {
            for s in Stage::ALL {
                let mut h = DevHooks::with(stop, panic_kill);
                let killed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _ = h.at(*s, &ctx);
                }))
                .is_err();
                assert_eq!(killed, hits.contains(s), "stop={stop} {}", s.name());
            }
        }
    }
}
