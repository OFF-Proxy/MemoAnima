//! アニメモ (AniMemo) — Tauri バックエンド
//!
//! 公開コマンド:
//! - `app_info`             : アプリ名・バージョン・マイルストン
//! - `read_file_bytes`      : ファイルをバイト列で読む（ビューア用）
//! - `scan_flipnote_folder` : うごメモ保存フォルダの read-only 再帰スキャン（直接一覧）
//! - `import_flipnotes`     : 取り込み元→PCライブラリへ独立コピー（M2・元は不変）
//! - `scan_library`         : PCライブラリの索引一覧（M2）
//! - `load_thumb`/`save_thumb` : サムネイルPNGのディスクキャッシュ（M2）
//! - `load_settings`/`save_settings` : アプリ設定の永続化（M2・ライブラリフォルダ等）

pub mod library;
pub mod pclib;

use std::fs;
use std::path::Path;
use tauri::{Emitter, Manager};

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        // M7-2c: 商標衝突回避のため改名（旧称アニメモ/AniMemo・2026-07-27）
        "name": "メモアニマ (MemoAnima)",
        "version": env!("CARGO_PKG_VERSION"),
        // M7-1 R-C: タイトル下の表示（バージョン＋非公式表明）に使う
        "milestone": "非公式・非営利のファンツール",
    })
}

/// 任意のファイルをバイト列で読み込む（ビューアが .kwz/.ppm を flipnote.js に渡すのに使う）。
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("読み込み失敗: {e}"))
}

/// M10-7: 生バイナリのまま返す（IPC の raw response）。
/// `read_file_bytes` は `Vec<u8>` を JSON 配列にシリアライズするため、数百MBの動画では
/// 現実的な速度・メモリで扱えない。動画からの音声抽出はこちらを使う。
/// **`read_file_bytes` は他の呼び出し元があるので触らない。**
///
/// `max_bytes` を渡すと**読み込む前に** metadata でサイズを見て、超えていれば
/// `TOO_LARGE:<実サイズ>` を返す。読んでから捨てる形にすると、Rust 側の Vec と
/// IPC 転送で実測 1.1GB のファイルがアプリごと落ちた（0xE0000008 / 572MB は成功）。
#[tauri::command]
fn read_file_raw(path: String, max_bytes: Option<u64>) -> Result<tauri::ipc::Response, String> {
    if let Some(limit) = max_bytes {
        let len = fs::metadata(&path)
            .map_err(|e| format!("読み込み失敗: {e}"))?
            .len();
        if len > limit {
            return Err(format!("TOO_LARGE:{len}"));
        }
    }
    let bytes = fs::read(&path).map_err(|e| format!("読み込み失敗: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// うごメモ3Dの保存フォルダを read-only で再帰スキャンし、生の .kwz/.ppm 一覧を返す。
#[tauri::command]
fn scan_flipnote_folder(root: String) -> Result<Vec<library::FlipnoteEntry>, String> {
    library::scan(&root)
}

/// 取り込み元からPCライブラリへ独立コピー（元は不変・内容ハッシュで重複回避）。
/// 進捗は `import-progress` イベントで通知（M3）。
#[tauri::command]
async fn import_flipnotes(
    app: tauri::AppHandle,
    src_root: String,
    lib_root: String,
) -> Result<pclib::ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pclib::import(&src_root, &lib_root, |p| {
            let _ = app.emit("import-progress", p);
        })
    })
    .await
    .map_err(|e| format!("取り込みタスク失敗: {e}"))?
}

/// 進行中の取り込みを中断する。
#[tauri::command]
fn cancel_import() {
    pclib::cancel_import();
}

/// 単発ファイル（.kwz/.ppm）の取り込み（合作受け取り）。
#[tauri::command]
fn import_single_file(
    lib_root: String,
    src_path: String,
    album: String,
) -> Result<(String, String), String> {
    pclib::import_single_file(&lib_root, &src_path, &album)
}

/// PCライブラリの一覧（索引ベース・実在ファイルのみ＋.animemoプロジェクト）。
#[tauri::command]
fn scan_library(lib_root: String) -> Result<Vec<pclib::LibraryView>, String> {
    pclib::scan_library(&lib_root)
}

/// アルバム一覧。
#[tauri::command]
fn list_albums(lib_root: String) -> Result<Vec<String>, String> {
    pclib::list_albums(&lib_root)
}

/// アルバム作成。
#[tauri::command]
fn create_album(lib_root: String, name: String) -> Result<String, String> {
    pclib::create_album(&lib_root, &name)
}

/// アルバムのリネーム。
#[tauri::command]
fn rename_album(lib_root: String, old: String, new: String) -> Result<String, String> {
    pclib::rename_album(&lib_root, &old, &new)
}

/// アルバム削除（空のみ）。
#[tauri::command]
fn delete_album(lib_root: String, name: String) -> Result<(), String> {
    pclib::delete_album(&lib_root, &name)
}

/// メモ/プロジェクトを1件削除（ライブラリ内のみ・SD/取り込み元は非接触）。
/// 対象パスはサーバ側で索引から解決する（フロントのパスは信用しない）。
#[tauri::command]
fn delete_note(
    lib_root: String,
    hash: String,
    album: String,
    name: String,
) -> Result<(), String> {
    pclib::delete_item(&lib_root, &hash, &album, &name)
}

/// メモを別アルバムへ移動。
#[tauri::command]
fn move_note(lib_root: String, hash: String, dest_album: String) -> Result<(), String> {
    pclib::move_note(&lib_root, &hash, &dest_album)
}

/// アルバム内のメモ表示順を保存。
#[tauri::command]
fn set_note_order(lib_root: String, hashes: Vec<String>) -> Result<(), String> {
    pclib::set_note_order(&lib_root, &hashes)
}

/// プロジェクト（.animemo）を保存（サイドカーサムネ付き）。
#[tauri::command]
fn save_project(
    lib_root: String,
    album: String,
    name: String,
    data: Vec<u8>,
    thumb_png: Vec<u8>,
) -> Result<String, String> {
    pclib::save_project(&lib_root, &album, &name, &data, &thumb_png)
}

/// サムネイルPNGをキャッシュから読む（無ければ null）。
#[tauri::command]
fn load_thumb(lib_root: String, hash: String) -> Result<Option<Vec<u8>>, String> {
    pclib::load_thumb(&lib_root, &hash)
}

/// サムネイルPNGをキャッシュへ保存する。
#[tauri::command]
fn save_thumb(lib_root: String, hash: String, png: Vec<u8>) -> Result<(), String> {
    pclib::save_thumb(&lib_root, &hash, &png)
}

/// M10-14: 直置きプロジェクトのサイドカーサムネを書き戻す（lib_root 封じ込め検証あり）。
#[tauri::command]
fn save_project_thumb(lib_root: String, project_path: String, png: Vec<u8>) -> Result<(), String> {
    pclib::save_project_thumb(&lib_root, &project_path, &png)
}

/// M10-16: ドロップ取り込み — 元ファイルを Rust 側で読んでライブラリへ直接保存する
/// （バイト列を IPC に通さない。src_path は読むだけ・書き込みは lib_root 配下のみ）。
#[tauri::command]
fn import_project_file(
    lib_root: String,
    album: String,
    name: String,
    src_path: String,
    thumb_png: Vec<u8>,
) -> Result<String, String> {
    pclib::import_project_file(&lib_root, &album, &name, &src_path, &thumb_png)
}

// ---- M6-1: エクスポート書き出し ----

/// 書き出し結果をユーザー選択パスへ保存する（保存ダイアログで得た絶対パス）。
/// 大容量出力に備えチャンク分割呼び出しに対応: first=true で新規作成（truncate）、
/// false で追記。フロントは数MB単位で順次呼び出す。
#[tauri::command]
fn export_write(path: String, data: Vec<u8>, first: bool) -> Result<(), String> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    if first {
        opts.create(true).write(true).truncate(true);
    } else {
        opts.create(true).append(true);
    }
    let mut f = opts
        .open(&path)
        .map_err(|e| format!("書き出し先を開けません: {e}"))?;
    f.write_all(&data).map_err(|e| format!("書き出し失敗: {e}"))
}

// ---- F-3: オートセーブ（アプリ設定領域 autosave/。クラッシュ復元用） ----

/// 単一ファイル形式: `AMAS1\n<meta JSON 1行>\n<gzipプロジェクトバイト列>`
/// meta と data を1ファイルで原子的に置換する（2ファイル分割だと片方だけ新しくなる
/// クラッシュ窓があり、復元時に別ファイルへ上書きし得る — Codexレビュー指摘#1）。
const AUTOSAVE_MAGIC: &[u8] = b"AMAS1\n";

fn autosave_paths(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定フォルダ取得失敗: {e}"))?
        .join("autosave");
    let file = dir.join("current.asv");
    Ok((dir, file))
}

/// tmp書き→（既存があれば.bak退避→）rename の原子的置換（save_project と同じ作法）
fn atomic_replace(dir: &std::path::Path, dest: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("autosave");
    let tmp = dir.join(format!("{name}.{}.tmp", N.fetch_add(1, Ordering::SeqCst)));
    fs::write(&tmp, bytes).map_err(|e| format!("書き込み失敗: {e}"))?;
    if dest.exists() {
        let bak = dir.join(format!("{name}.bak"));
        let _ = fs::remove_file(&bak);
        if let Err(e) = fs::rename(dest, &bak) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("退避失敗: {e}"));
        }
        if let Err(e) = fs::rename(&tmp, dest) {
            let _ = fs::rename(&bak, dest);
            let _ = fs::remove_file(&tmp);
            return Err(format!("置換失敗: {e}"));
        }
        let _ = fs::remove_file(&bak);
        Ok(())
    } else {
        fs::rename(&tmp, dest).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("確定失敗: {e}")
        })
    }
}

/// オートセーブ保存の本体（AMAS1 組み立て＋原子的置換）。
/// 従来の save_autosave と M10-23 の save_autosave_raw が同じこの実装を使う。
fn save_autosave_impl(
    app: &tauri::AppHandle,
    data: &[u8],
    meta: &serde_json::Value,
) -> Result<String, String> {
    let (dir, file) = autosave_paths(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("オートセーブフォルダ作成失敗: {e}"))?;
    let meta_s = serde_json::to_string(meta).map_err(|e| format!("meta生成失敗: {e}"))?;
    let mut buf = Vec::with_capacity(AUTOSAVE_MAGIC.len() + meta_s.len() + 1 + data.len());
    buf.extend_from_slice(AUTOSAVE_MAGIC);
    buf.extend_from_slice(meta_s.as_bytes());
    buf.push(b'\n');
    buf.extend_from_slice(data);
    atomic_replace(&dir, &file, &buf)?;
    Ok(dir.to_string_lossy().to_string())
}

/// オートセーブを保存する。戻り値は保存先フォルダのパス（ユーザー告知用）。
#[tauri::command]
fn save_autosave(
    app: tauri::AppHandle,
    data: Vec<u8>,
    meta: serde_json::Value,
) -> Result<String, String> {
    save_autosave_impl(&app, &data, &meta)
}

// ---- M10-23: 保存系 IPC の raw ボディ版 ----
// number[] JSON（1バイト→数文字）を IPC に通すと 300ページ級で invoke だけで
// メインスレッドを約0.7秒塞ぐ実測だったため、raw ボディで受ける。
// 封筒: [u32 metaLen LE][meta JSON utf8]（[u32 partLen LE][part] × n）。
// 保存処理そのもの（AMAS1 組み立て・原子的置換・封じ込め・サニタイズ）は
// 既存実装（save_autosave_impl / pclib::save_project）へそのまま委譲する。

fn parse_save_envelope<'a>(
    body: &'a [u8],
    nparts: usize,
) -> Result<(serde_json::Value, Vec<&'a [u8]>), String> {
    const ERR: &str = "保存データの形式が不正です";
    let take_u32 = |o: usize| -> Result<usize, String> {
        body.get(o..o + 4)
            .map(|s| u32::from_le_bytes(s.try_into().unwrap()) as usize)
            .ok_or_else(|| ERR.to_string())
    };
    let mut o = 0usize;
    let ml = take_u32(o)?;
    o += 4;
    let meta_b = body.get(o..o + ml).ok_or_else(|| ERR.to_string())?;
    o += ml;
    let meta: serde_json::Value =
        serde_json::from_slice(meta_b).map_err(|e| format!("meta解析失敗: {e}"))?;
    let mut parts = Vec::with_capacity(nparts);
    for _ in 0..nparts {
        let l = take_u32(o)?;
        o += 4;
        parts.push(body.get(o..o + l).ok_or_else(|| ERR.to_string())?);
        o += l;
    }
    if o != body.len() {
        return Err(ERR.to_string());
    }
    Ok((meta, parts))
}

fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b.as_slice()),
        _ => Err("rawボディが必要です".to_string()),
    }
}

/// オートセーブ（raw ボディ版）: 封筒 = [meta JSON][data]
#[tauri::command]
fn save_autosave_raw(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let body = raw_body(&request)?;
    let (meta, parts) = parse_save_envelope(body, 1)?;
    save_autosave_impl(&app, parts[0], &meta)
}

/// プロジェクト保存（raw ボディ版）: 封筒 = [meta JSON{libRoot,album,name}][data][thumbPng]
#[tauri::command]
fn save_project_raw(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let body = raw_body(&request)?;
    let (meta, parts) = parse_save_envelope(body, 2)?;
    let s = |k: &str| -> Result<String, String> {
        meta.get(k)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("meta.{k} がありません"))
    };
    pclib::save_project(&s("libRoot")?, &s("album")?, &s("name")?, parts[0], parts[1])
}

fn parse_autosave(bytes: &[u8], path: &std::path::Path) -> Option<serde_json::Value> {
    let rest = bytes.strip_prefix(AUTOSAVE_MAGIC)?;
    let nl = rest.iter().position(|&b| b == b'\n')?;
    let meta: serde_json::Value = serde_json::from_slice(&rest[..nl]).ok()?;
    let data = &rest[nl + 1..];
    Some(serde_json::json!({
        "meta": meta,
        "data": data,
        "path": path.to_string_lossy(),
    }))
}

/// オートセーブがあれば {meta, data, path} を返す（無ければ null）。
/// 置換途中クラッシュに備え `.bak` からの復旧も試みる。
#[tauri::command]
fn load_autosave(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let (dir, file) = autosave_paths(&app)?;
    for p in [file.clone(), dir.join("current.asv.bak")] {
        if p.is_file() {
            if let Ok(bytes) = fs::read(&p) {
                if let Some(v) = parse_autosave(&bytes, &p) {
                    return Ok(Some(v));
                }
            }
        }
    }
    Ok(None)
}

/// オートセーブを破棄する（.bak・一時ファイルも含む）。
#[tauri::command]
fn clear_autosave(app: tauri::AppHandle) -> Result<(), String> {
    let (dir, file) = autosave_paths(&app)?;
    if file.exists() {
        fs::remove_file(&file).map_err(|e| format!("破棄失敗: {e}"))?;
    }
    let _ = fs::remove_file(dir.join("current.asv.bak"));
    if let Ok(entries) = fs::read_dir(&dir) {
        for ent in entries.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if name.ends_with(".tmp") {
                let _ = fs::remove_file(ent.path());
            }
        }
    }
    Ok(())
}

/// アプリ設定（ライブラリフォルダ等）を読み込む。未作成なら空オブジェクト。
/// M7-1 R-A: 破損時はクラッシュせず `.broken` へ退避して既定値で起動
/// （`__recovered: true` を返してフロントが復旧案内を出す）。
#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定フォルダ取得失敗: {e}"))?;
    let p = dir.join("settings.json");
    if !p.is_file() {
        return Ok(serde_json::json!({}));
    }
    let parsed = fs::read_to_string(&p)
        .map_err(|e| format!("設定読み込み失敗: {e}"))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| format!("設定解析失敗: {e}")));
    match parsed {
        Ok(v) => Ok(v),
        Err(_) => {
            let broken = dir.join("settings.json.broken");
            let _ = fs::remove_file(&broken);
            let _ = fs::rename(&p, &broken);
            Ok(serde_json::json!({ "__recovered": true }))
        }
    }
}

/// M7-1 R-A: ライブラリ索引のヘルスチェック（壊れていれば退避＋ディスク再構築して true）
#[tauri::command]
fn library_health(lib_root: String) -> Result<bool, String> {
    pclib::heal_index(&lib_root)
}

/// M7-1 R-A: フォルダ存在チェック（ライブラリフォルダ消失＝USB抜き等の起動時判定用）
#[tauri::command]
fn dir_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// M7-1 R-A: ローカルエラーログ追記（`app_config_dir/logs/animemo.log`）。
/// 1MB 超で `.1` へローテート（最大2世代）。**送信機能はない**（オフライン完結・ローカルのみ）。
#[tauri::command]
fn append_log(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定フォルダ取得失敗: {e}"))?
        .join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("ログフォルダ作成失敗: {e}"))?;
    let p = dir.join("memoanima.log");
    if let Ok(md) = fs::metadata(&p) {
        if md.len() > 1_000_000 {
            let p1 = dir.join("memoanima.log.1");
            let _ = fs::remove_file(&p1);
            let _ = fs::rename(&p, &p1);
        }
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| format!("ログを開けません: {e}"))?;
    writeln!(f, "{text}").map_err(|e| format!("ログ書き込み失敗: {e}"))
}

/// アプリ設定を保存する。
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定フォルダ取得失敗: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("設定フォルダ作成失敗: {e}"))?;
    let s = serde_json::to_string_pretty(&settings).map_err(|e| format!("設定生成失敗: {e}"))?;
    fs::write(dir.join("settings.json"), s).map_err(|e| format!("設定保存失敗: {e}"))
}

/// M7-2c N-2: 旧identifier（com.root.animemo）の設定を新ディレクトリへ**コピー**する起動時移行。
/// - 新側に settings.json が既にあれば何もしない（初回の一度だけ実行される）
/// - コピーのみ。**旧フォルダは削除しない**（切り戻し可能に保つ）
/// - 対象: settings.json / autosave/ / logs/（直下ファイルのみ）
fn migrate_old_config_dir(new_dir: &Path) {
    if new_dir.join("settings.json").exists() {
        return;
    }
    let Some(parent) = new_dir.parent() else {
        return;
    };
    let old_dir = parent.join("com.root.animemo");
    if !old_dir.join("settings.json").exists() && !old_dir.join("autosave").is_dir() {
        return;
    }
    let _ = fs::create_dir_all(new_dir);
    let _ = fs::copy(old_dir.join("settings.json"), new_dir.join("settings.json"));
    for sub in ["autosave", "logs"] {
        let od = old_dir.join(sub);
        if !od.is_dir() {
            continue;
        }
        let nd = new_dir.join(sub);
        let _ = fs::create_dir_all(&nd);
        if let Ok(entries) = fs::read_dir(&od) {
            for e in entries.flatten() {
                if e.path().is_file() {
                    let _ = fs::copy(e.path(), nd.join(e.file_name()));
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Ok(dir) = app.path().app_config_dir() {
                migrate_old_config_dir(&dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            read_file_bytes,
            read_file_raw,
            scan_flipnote_folder,
            import_flipnotes,
            cancel_import,
            import_single_file,
            scan_library,
            list_albums,
            create_album,
            rename_album,
            delete_album,
            delete_note,
            move_note,
            set_note_order,
            save_project,
            save_project_raw,
            export_write,
            save_autosave,
            save_autosave_raw,
            load_autosave,
            clear_autosave,
            load_thumb,
            save_thumb,
            save_project_thumb,
            import_project_file,
            load_settings,
            save_settings,
            library_health,
            dir_exists,
            append_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
