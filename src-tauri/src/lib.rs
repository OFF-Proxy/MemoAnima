//! メモアニマ (MemoAnima) — Tauri バックエンド
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
        // M7-2c: 商標衝突回避のため 2026-07-27 に改名（旧称は非公開の開発記録を参照）
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

/// M11-4: 外部変更の軽量検知用の指紋（フォーカス復帰のたびに呼び、変化時だけ本スキャン）。
#[tauri::command]
fn library_stamp(lib_root: String) -> Result<String, String> {
    pclib::library_stamp(&lib_root)
}

/// V154 (W-1): 保存の途中で終了した跡（本体が無く `<本体>.bak` だけがある作品）を集める。
/// **読むだけ**。復元するかどうかは利用者が決める（`recover_project`）。
#[tauri::command]
fn list_recoverable(lib_root: String) -> Result<Vec<pclib::RecoverableView>, String> {
    pclib::scan_recoverable(&lib_root)
}

/// V154 (W-1): 控え（`.bak`）から作品を戻す。本体が在るときは何もしない（上書きしない）。
#[tauri::command]
fn recover_project(lib_root: String, rel_path: String) -> Result<String, String> {
    pclib::recover_project(&lib_root, &rel_path)
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

/// アルバム削除（M11-1: 作品0件のみ。アプリ/OS 由来の付属物は一緒に削除する）。
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

/// M11-3: プロジェクト（.memoanima/.animemo）を別アルバムへ移動（サイドカーPNGも一緒に）。
#[tauri::command]
fn move_project(
    lib_root: String,
    album: String,
    name: String,
    dest_album: String,
) -> Result<String, String> {
    pclib::move_project(&lib_root, &album, &name, &dest_album)
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
    // V154 (W-1・要件 §2-b ①): 確定の3手順は `pclib::commit_replace` に一本化した。
    // **オートセーブはこの経路**で、15秒ごとに走る＝危険な窓が開く回数は手動保存の比ではない。
    // 以前はここにも同じ3手順が別に書いてあり、`.bak` を消していた（＝窓で死ぬと戻せない）。
    pclib::commit_replace(dir, dest, &tmp)?;
    // V154 (W-6): オートセーブも**同じ扱い**。書いたものを読み戻して確かめ、違っていたら
    // 前の版（`current.asv.bak`）へ戻す。呼び出し側（editor）は Err を受けて「保存待ち」に
    // 戻すので、次の周期でもう一度作り直す
    pclib::verify_or_rollback(dir, dest, bytes)
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

// V163: V161-B の「保存の gzip を Rust で行う」チャンク集積（gz_begin/gz_chunk/gz_abort/
// save_project_gz と flate2 依存）は撤去した。PV6 の保存は JS（Worker）が完成品
// （68.7MB 級）を組み、従来の save_project_raw（1回の raw ボディ）で届くため、
// 2.1GB の JSON を分割して流し込む仕掛けそのものが要らない。
// 書き込み側（pclib::save_project ＝ tmp→.bak→rename→照合）は従来と1手も変わらない。

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
    Ok(load_settings_impl(&dir))
}

/// HK1 (A-22): 読み込みの本体（隔離ディレクトリで検査できるよう分離）。
///
/// 復旧の3段構え:
///  1. `settings.json` が読めればそれ（ふつうの起動）
///  2. 壊れていれば `.broken` へ退避し、**`.bak`（1世代前・下の save が残す）を試す**。
///     読めれば**設定は失われていない**——静かに復旧してログに1行だけ残す
///     （オートセーブの `load_autosave` が `.bak` を試すのと同じ作法）
///  3. `.bak` も無い/壊れていれば既定値（`__recovered: true` でフロントが案内を出す＝従来どおり）
///
/// ★2 は書き込みの原子化（下の save_settings_impl）とセット。`.bak` 退避→確定 rename の
///  **すき間でクラッシュすると dest が一瞬存在しない**——そのとき従来は「初回起動」と誤認して
///  全設定が既定に戻っていた。dest が無くても `.bak` を見ることで、その窓も塞がる。
pub fn load_settings_impl(dir: &std::path::Path) -> serde_json::Value {
    let p = dir.join("settings.json");
    let bak = dir.join("settings.json.bak");
    let try_read = |path: &std::path::Path| -> Option<serde_json::Value> {
        let s = fs::read_to_string(path).ok()?;
        serde_json::from_str::<serde_json::Value>(&s).ok()
    };
    if !p.is_file() {
        // 初回起動 or 置換のすき間でクラッシュした直後。`.bak` があればそれが直近の設定
        if let Some(v) = try_read(&bak) {
            let _ = append_log_line(&dir.join("logs"), "[HK1] settings restored from .bak (dest missing)");
            return v;
        }
        return serde_json::json!({});
    }
    if let Some(v) = try_read(&p) {
        return v;
    }
    // 壊れている: 原因調査用に退避してから `.bak` を試す
    let broken = dir.join("settings.json.broken");
    let _ = fs::remove_file(&broken);
    let _ = fs::rename(&p, &broken);
    if let Some(v) = try_read(&bak) {
        let _ = append_log_line(&dir.join("logs"), "[HK1] settings restored from .bak (dest corrupted)");
        return v;
    }
    serde_json::json!({ "__recovered": true })
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
/// V154b (W-10): ログの置き場（`app_config_dir/logs`）。**新しいフォルダは作らない**——
/// `settings.json` と `autosave/` が既にある場所の隣に置くので、
/// 既に入れている人にも更新するだけで効く（移行の作業がいらない）。
fn log_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定フォルダ取得失敗: {e}"))?
        .join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("ログフォルダ作成失敗: {e}"))?;
    Ok(dir)
}

/// V154b (W-10): **利用者を特定できるものを書かない**ための伏せ字。
///
/// ログは「送ってください」と頼む前提のものなので、**Windows のユーザー名**が入ると
/// それだけで個人が分かってしまう。ホームフォルダのパスを `<user>` に置き換える。
/// 大文字小文字と `\` / `/` の違いも拾う（Windows はどちらも通る）。
///
/// 作品名・アルバム名は**そもそも呼び出し側が渡さない**（W-10 の線引き）。
/// ここは、例外メッセージのように**こちらが文面を決められないもの**への保険。
fn redact_user(app: &tauri::AppHandle, text: &str) -> String {
    let Ok(home) = app.path().home_dir() else {
        return text.to_string();
    };
    redact_home(text, &home.to_string_lossy())
}

/// V154b (W-10): `redact_user` の中身（**引数だけで決まる**ので検査できる）。
/// `home` が空や短すぎるときは何もしない（`C:\` を伏せても意味が無く、誤爆だけが増える）。
pub fn redact_home(text: &str, home: &str) -> String {
    let home = home.to_string();
    if home.len() < 4 {
        return text.to_string();
    }
    let mut out = text.to_string();
    for needle in [home.clone(), home.replace('\\', "/")] {
        let lower_needle = needle.to_lowercase();
        loop {
            let Some(at) = out.to_lowercase().find(&lower_needle) else { break };
            let end = at + needle.len();
            // 小文字化でバイト長が変わる文字が混ざっていると位置がずれ得る。
            // ずれていたら**触らずに諦める**（伏せ字が甘くなるより、落ちるほうが困る）
            if end > out.len() || !out.is_char_boundary(at) || !out.is_char_boundary(end) {
                break;
            }
            out.replace_range(at..end, "<user>");
        }
    }
    out
}

/// V154b (W-10): ログのフォルダをエクスプローラーで開く（⚙ の「ログのフォルダを開く」）。
/// **パスをフロントに渡さない**（渡すと画面やクリップボード経由で利用者名が漏れる）。
#[tauri::command]
fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = log_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("フォルダを開けません: {e}"))
}

#[tauri::command]
fn append_log(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let dir = log_dir(&app)?;
    append_log_line(&dir, &redact_user(&app, &text))
}

/// V154b (W-10): 1行足す（**上限つき**）。`app` を要らない形にしてあるので検査できる。
///
/// 1MB を超えたら `memoanima.log.1` へ回して新しく書き始める＝**2世代まで**。
/// 無限に育てない（送ってもらうものなので、大きすぎると送れない）。
pub fn append_log_line(dir: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
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
/// V151 (A-22): tmp→rename の原子的書込へ（プロジェクト保存 pclib と同じ作法）。
/// 従来の fs::write 直書きは、書込中のクラッシュ/電源断で settings.json が途中までの
/// 壊れた JSON になり、次回起動の load_settings が .broken へ退避して**全設定を失う**。
/// tmp に書き切ってから rename すれば、いつクラッシュしても settings.json は
/// 「旧の完全な内容」か「新の完全な内容」のどちらかにしかならない
/// （Windows の fs::rename は既存ファイルへの置換 = MOVEFILE_REPLACE_EXISTING）。
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定フォルダ取得失敗: {e}"))?;
    save_settings_impl(&dir, &settings)
}

/// HK1 (A-22): 書き込みの本体。従来の tmp→rename から、オートセーブと**同じ**
/// `atomic_replace`（V154 の形＝tmp 書き→`.bak` 温存→rename→読み戻し照合）へ揃えた。
/// 得るもの: ①1世代前が `.bak` に残る（上の load が復旧に使う）
/// ②書けたものが渡したものと一致することを毎回確かめる（違えば `.bak` へ自動復旧＝W-6/W-1 と同じ保証）
pub fn save_settings_impl(dir: &std::path::Path, settings: &serde_json::Value) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("設定フォルダ作成失敗: {e}"))?;
    let s = serde_json::to_string_pretty(settings).map_err(|e| format!("設定生成失敗: {e}"))?;
    let dest = dir.join("settings.json");
    atomic_replace(dir, &dest, s.as_bytes())
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
            // U-1: アプリ内アップデート（デスクトップのみ）。**確認そのものはフロント側が
            // 明示的に呼んだときだけ走る**（ここで登録するのはコマンドの口だけで、通信は起きない）。
            // ⚙ の「起動時に更新を確認する」がオフなら、フロントは check() を呼ばない＝通信ゼロ。
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
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
            library_stamp,
            list_recoverable,
            recover_project,
            open_log_folder,
            list_albums,
            create_album,
            rename_album,
            delete_album,
            delete_note,
            move_note,
            move_project,
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
