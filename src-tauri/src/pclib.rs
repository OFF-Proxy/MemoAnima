//! PCライブラリ（M2/M3）
//!
//! 取り込み元（うごメモ保存フォルダ）から **read-only** で `.kwz`/`.ppm` を読み、
//! ユーザー指定のライブラリフォルダへ **独立コピー** する（元は不変）。
//! - 重複回避: 内容ハッシュ（SHA-256）。索引 `animemo-library.json` で管理。
//! - アルバム保持: 取り込み元のアルバム（サブフォルダ）名をライブラリ内フォルダとして再現。
//! - サムネイル: フロント（flipnote.js）が生成したPNGを `.animemo/thumbs/<hash>.png` にキャッシュ。
//! - M3: 取り込み進捗イベント／中断、アルバム操作（作成/リネーム/削除）、メモ移動・並べ替え、
//!   独自プロジェクト形式（`.animemo` ＋ サイドカーサムネ `.animemo.png`）の保存と一覧。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::library;

// INDEX_FILE / THUMB_DIR は既存ライブラリとの互換のため旧名のまま（ユーザー非可視の内部識別子）
const INDEX_FILE: &str = "animemo-library.json";
const THUMB_DIR: &str = ".animemo/thumbs";
// M7-2c: 新規保存は .memoanima。旧 .animemo は恒久的に読み込み・削除可能（両対応）
const PROJECT_EXT: &str = "memoanima";
const PROJECT_EXT_LEGACY: &str = "animemo";

/// プロジェクトファイルの拡張子か（新旧両対応・大文字小文字無視）
fn is_project_ext(ext: &str) -> bool {
    ext.eq_ignore_ascii_case(PROJECT_EXT) || ext.eq_ignore_ascii_case(PROJECT_EXT_LEGACY)
}

/// 取り込み中断フラグ（cancel_import コマンドで立てる）
static IMPORT_CANCEL: AtomicBool = AtomicBool::new(false);

/// ライブラリ（索引＋ファイル）を変更する操作の排他ロック。
/// 索引の load-modify-save が並行実行で互いを上書きしないようにする（Codexレビュー指摘）。
static LIB_LOCK: Mutex<()> = Mutex::new(());

/// 一時ファイル名の一意化用カウンタ
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn lock_lib() -> MutexGuard<'static, ()> {
    LIB_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryItem {
    pub hash: String,
    pub album: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    /// ライブラリフォルダからの相対パス（例: `アルバム名/xxxx.kwz`）
    pub rel_path: String,
    /// 取り込み時刻（UNIX秒）
    pub imported_at: u64,
    /// アルバム内の表示順（小さいほど先頭。同値は名前順）
    #[serde(default)]
    pub order: u32,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct LibraryIndex {
    pub version: u32,
    pub items: Vec<LibraryItem>,
    /// `.animemo` プロジェクトの表示順（キー = rel_path。ハッシュ索引外のため別管理）
    #[serde(default)]
    pub project_order: std::collections::HashMap<String, u32>,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub failed: u32,
    pub total: u32,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

/// 取り込み進捗イベントのペイロード（`import-progress` で emit）
#[derive(Debug, Serialize, Clone)]
pub struct ImportProgress {
    pub done: u32,
    pub total: u32,
    pub album: String,
    pub imported: u32,
    pub skipped: u32,
}

/// ライブラリ一覧用（フロントに返す。絶対パス付き）
#[derive(Debug, Serialize)]
pub struct LibraryView {
    /// "note"（.kwz/.ppm）または "project"（.animemo）
    pub kind: String,
    pub hash: String,
    pub album: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub path: String,
    /// プロジェクトのサイドカーサムネ（存在する場合のみ）
    pub thumb_path: Option<String>,
    pub order: u32,
    /// M10-20: 日付順ソート用の unix 秒（note=索引の imported_at / project=ファイル更新日時・
    /// 取得失敗は 0）。ソートの切り替え自体はフロントで行う（Rust は情報を足すだけ）
    pub sorted_at: u64,
}

fn index_path(lib_root: &Path) -> PathBuf {
    lib_root.join(INDEX_FILE)
}

fn load_index(lib_root: &Path) -> Result<LibraryIndex, String> {
    let p = index_path(lib_root);
    if !p.exists() {
        return Ok(LibraryIndex {
            version: 1,
            ..Default::default()
        });
    }
    // M7-1 R-A: 破損した索引でクラッシュ/エラー連鎖しない。
    // 読めない・解析できない → .broken へ退避し、ディスク走査で再構築（取り込み済みファイルは無事）
    let parsed = fs::read_to_string(&p)
        .map_err(|e| format!("索引の読み込みに失敗: {e}"))
        .and_then(|s| serde_json::from_str::<LibraryIndex>(&s).map_err(|e| format!("索引の解析に失敗: {e}")));
    match parsed {
        Ok(idx) => Ok(idx),
        Err(_) => Ok(recover_index(lib_root)),
    }
}

/// M7-1 R-A: 壊れた索引の回復。`.broken` へ退避 → アルバム走査で .kwz/.ppm を再登録 → 保存。
fn recover_index(lib_root: &Path) -> LibraryIndex {
    let p = index_path(lib_root);
    let broken = lib_root.join(format!("{INDEX_FILE}.broken"));
    let _ = fs::remove_file(&broken);
    let _ = fs::rename(&p, &broken);
    let rebuilt = rebuild_index_from_disk(lib_root);
    let _ = save_index(lib_root, &rebuilt);
    rebuilt
}

/// ライブラリ内のアルバムフォルダを走査し、.kwz/.ppm を索引に再登録する
/// （hash=内容SHA-256 なので以後の重複回避も従来どおり機能する）。
fn rebuild_index_from_disk(lib_root: &Path) -> LibraryIndex {
    let mut index = LibraryIndex {
        version: 1,
        ..Default::default()
    };
    let Ok(entries) = fs::read_dir(lib_root) else {
        return index;
    };
    for album_ent in entries.flatten() {
        let album_dir = album_ent.path();
        if !album_dir.is_dir() {
            continue;
        }
        let album = album_ent.file_name().to_string_lossy().to_string();
        if album.starts_with('.') {
            continue; // .animemo/thumbs 等
        }
        let Ok(files) = fs::read_dir(&album_dir) else {
            continue;
        };
        for ent in files.flatten() {
            let fp = ent.path();
            if !fp.is_file() {
                continue;
            }
            let ext = fp
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if ext != "kwz" && ext != "ppm" {
                continue;
            }
            let Ok(bytes) = fs::read(&fp) else { continue };
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let hash = format!("{:x}", hasher.finalize());
            let name = fp
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            index.items.push(LibraryItem {
                hash,
                album: album.clone(),
                name: name.clone(),
                ext,
                size: bytes.len() as u64,
                rel_path: format!("{album}/{name}"),
                imported_at: now_unix(),
                order: 0,
            });
        }
    }
    index
}

/// M7-1 R-A: 起動時ヘルスチェック（フロントの復旧案内用）。
/// 索引が壊れていれば退避＋再構築して true を返す（正常なら false・何もしない）。
pub fn heal_index(lib_root: &str) -> Result<bool, String> {
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Ok(false); // フォルダ消失は別経路（dir_exists）で案内
    }
    let _guard = lock_lib();
    let p = index_path(lib);
    if !p.exists() {
        return Ok(false);
    }
    let ok = fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<LibraryIndex>(&s).ok())
        .is_some();
    if ok {
        return Ok(false);
    }
    recover_index(lib);
    Ok(true)
}

fn save_index(lib_root: &Path, index: &LibraryIndex) -> Result<(), String> {
    let s = serde_json::to_string_pretty(index).map_err(|e| format!("索引の生成に失敗: {e}"))?;
    let tmp = lib_root.join(format!("{INDEX_FILE}.tmp"));
    fs::write(&tmp, s).map_err(|e| format!("索引の書き込みに失敗: {e}"))?;
    fs::rename(&tmp, index_path(lib_root)).map_err(|e| format!("索引の保存に失敗: {e}"))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Windows でフォルダ/ファイル名に使えない文字を避ける。パス区切りも潰す（1コンポーネント専用）。
fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "_".to_string()
    } else {
        trimmed
    }
}

/// アルバム名の妥当性（1コンポーネント・隠しフォルダ不可）
fn validate_album(name: &str) -> Result<String, String> {
    let s = sanitize_component(name);
    if s.starts_with('.') {
        return Err("アルバム名は '.' で始められません".into());
    }
    Ok(s)
}

/// 取り込み元とライブラリの包含関係を拒否する（元フォルダの中に書かない保証）
fn ensure_disjoint(src_root: &Path, lib_root: &Path) -> Result<(), String> {
    let src = fs::canonicalize(src_root).map_err(|e| format!("取り込み元にアクセスできません: {e}"))?;
    let lib = fs::canonicalize(lib_root).map_err(|e| format!("ライブラリフォルダにアクセスできません: {e}"))?;
    if lib.starts_with(&src) {
        return Err("ライブラリフォルダが取り込み元の中にあります。別の場所を指定してください（元フォルダは read-only を保証するため）。".into());
    }
    if src.starts_with(&lib) {
        return Err("取り込み元がライブラリフォルダの中にあります。別のフォルダを指定してください。".into());
    }
    Ok(())
}

/// 同名ファイルがある場合は `名前-1.ext`, `名前-2.ext` … と空きを探す
fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let ext = Path::new(name).extension().and_then(|e| e.to_str());
    for i in 1.. {
        let candidate = match ext {
            Some(e) => dir.join(format!("{stem}-{i}.{e}")),
            None => dir.join(format!("{stem}-{i}")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// 取り込みの中断を要求する。
pub fn cancel_import() {
    IMPORT_CANCEL.store(true, Ordering::SeqCst);
}

/// M10-18: 幽霊行（索引にあるが実ファイルが無い行）を索引から取り除く。戻り値は削除行数。
/// **実ファイルは一切消さない**（消してよいのは台帳の行だけ）。同ハッシュで両方実在する
/// 重複行は対象外（どちらを残すかは利用者がアプリの削除機能で決める）。
/// サムネキャッシュ（.animemo/thumbs/）も触らない（同ハッシュの別行が生きている場合がある）。
fn prune_ghost_rows(lib: &Path, index: &mut LibraryIndex) -> usize {
    let before = index.items.len();
    index.items.retain(|i| lib.join(&i.rel_path).is_file());
    before - index.items.len()
}

/// 取り込み元を read-only スキャンし、未取り込み分だけをライブラリへ独立コピーする。
/// `progress` は1件処理するごとに呼ばれる（Tauri イベント emit 用のフック）。
pub fn import(
    src_root: &str,
    lib_root: &str,
    mut progress: impl FnMut(&ImportProgress),
) -> Result<ImportResult, String> {
    let _guard = lock_lib();
    IMPORT_CANCEL.store(false, Ordering::SeqCst);
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    ensure_disjoint(Path::new(src_root), lib)?;

    // 取り込み元のスキャンは既存の read-only スキャナを利用
    let entries = library::scan(src_root)?;
    let mut index = load_index(lib)?;
    // M10-18: 幽霊行を掃除してから known を「実在する行」だけで構築する
    //（scan_library が先に走る保証はない。これで手動削除→SD再取り込みが skipped ではなく
    // imported になる＝アプリから復旧できる。掃除結果は末尾の既存 save_index で永続化）
    prune_ghost_rows(lib, &mut index);
    let mut known: HashSet<String> = index.items.iter().map(|i| i.hash.clone()).collect();

    let mut result = ImportResult {
        imported: 0,
        skipped: 0,
        failed: 0,
        total: entries.len() as u32,
        cancelled: false,
        errors: Vec::new(),
    };

    for (i, entry) in entries.iter().enumerate() {
        if IMPORT_CANCEL.load(Ordering::SeqCst) {
            result.cancelled = true;
            break;
        }
        let mut process = || -> Result<bool, String> {
            let bytes = fs::read(&entry.path).map_err(|e| format!("読み込み失敗 ({e})"))?;
            let hash = hex::encode(Sha256::digest(&bytes));
            if known.contains(&hash) {
                return Ok(false);
            }
            let album_dir_name = sanitize_component(&entry.album);
            let album_dir = lib.join(&album_dir_name);
            fs::create_dir_all(&album_dir).map_err(|e| format!("アルバムフォルダ作成失敗 ({e})"))?;
            let dest = unique_dest(&album_dir, &entry.name);
            fs::write(&dest, &bytes).map_err(|e| format!("コピー失敗 ({e})"))?;
            let dest_name = dest
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&entry.name)
                .to_string();
            index.items.push(LibraryItem {
                hash: hash.clone(),
                album: entry.album.clone(),
                name: dest_name.clone(),
                ext: entry.ext.clone(),
                size: bytes.len() as u64,
                rel_path: format!("{album_dir_name}/{dest_name}"),
                imported_at: now_unix(),
                order: 0,
            });
            known.insert(hash);
            Ok(true)
        };
        match process() {
            Ok(true) => result.imported += 1,
            Ok(false) => result.skipped += 1,
            Err(e) => {
                result.failed += 1;
                result.errors.push(format!("{}: {e}", entry.name));
            }
        }
        progress(&ImportProgress {
            done: (i + 1) as u32,
            total: result.total,
            album: entry.album.clone(),
            imported: result.imported,
            skipped: result.skipped,
        });
    }

    save_index(lib, &index)?;
    Ok(result)
}

/// 単発ファイル（.kwz/.ppm）をライブラリへ取り込む（合作受け取り・元は不変）。
/// 戻り値は (取り込んだ絶対パス, 内容ハッシュ)。既に同内容があればそのパスを返す。
pub fn import_single_file(
    lib_root: &str,
    src_path: &str,
    album: &str,
) -> Result<(String, String), String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let src = Path::new(src_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if ext != "kwz" && ext != "ppm" {
        return Err("対応形式は .kwz / .ppm です".into());
    }
    let bytes = fs::read(src).map_err(|e| format!("読み込み失敗: {e}"))?;
    let hash = hex::encode(Sha256::digest(&bytes));
    let mut index = load_index(lib)?;
    if let Some(existing) = index.items.iter().find(|i| i.hash == hash) {
        let p = lib.join(&existing.rel_path);
        if p.is_file() {
            return Ok((p.to_string_lossy().to_string(), hash));
        }
        // M10-18: 実ファイルが無い（幽霊行）→ 同ハッシュの行を**すべて**消してから取り込み直す。
        // 従来はここで消さずに push していたため台帳に重複行ができ、手動操作でファイルが
        // 両方実在すると同じ作品のサムネが2枚並んだ（合作テストの実測）
        index.items.retain(|i| i.hash != hash);
    }
    let album_s = validate_album(album)?;
    let dir = lib.join(&album_s);
    fs::create_dir_all(&dir).map_err(|e| format!("アルバムフォルダ作成失敗: {e}"))?;
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_component)
        .unwrap_or_else(|| format!("import.{ext}"));
    let dest = unique_dest(&dir, &name);
    fs::write(&dest, &bytes).map_err(|e| format!("コピー失敗: {e}"))?;
    let dest_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&name)
        .to_string();
    index.items.push(LibraryItem {
        hash: hash.clone(),
        album: album_s.clone(),
        name: dest_name.clone(),
        ext,
        size: bytes.len() as u64,
        rel_path: format!("{album_s}/{dest_name}"),
        imported_at: now_unix(),
        order: 0,
    });
    save_index(lib, &index)?;
    Ok((dest.to_string_lossy().to_string(), hash))
}

/// アルバム一覧（ライブラリ直下のフォルダ。`.animemo` 等の隠しフォルダは除外）。
pub fn list_albums(lib_root: &str) -> Result<Vec<String>, String> {
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let mut out = Vec::new();
    for ent in fs::read_dir(lib).map_err(|e| format!("一覧取得失敗: {e}"))?.flatten() {
        let p = ent.path();
        if !p.is_dir() {
            continue;
        }
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            if !name.starts_with('.') {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// ライブラリ索引＋ディスク上の `.animemo` プロジェクトを一覧で返す。
/// M10-18: 幽霊行（実ファイル無し）は表示から除外するだけでなく**索引からも掃除**する
///（自己修復。行を消すだけでファイルは消さない。変更ゼロなら書き戻さない）。
pub fn scan_library(lib_root: &str) -> Result<Vec<LibraryView>, String> {
    // M10-18: 索引を書き戻すことがあるため、書き込み系と同じくロックを取る
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let mut index = load_index(lib)?;
    if prune_ghost_rows(lib, &mut index) > 0 {
        save_index(lib, &index)?;
    }
    let index = index;
    let mut out: Vec<LibraryView> = index
        .items
        .iter()
        .filter_map(|i| {
            let p = lib.join(&i.rel_path);
            if p.is_file() {
                Some(LibraryView {
                    kind: "note".into(),
                    hash: i.hash.clone(),
                    album: i.album.clone(),
                    name: i.name.clone(),
                    ext: i.ext.clone(),
                    size: i.size,
                    path: p.to_string_lossy().to_string(),
                    thumb_path: None,
                    order: i.order,
                    // M10-20: kwz/ppm は取り込み日
                    sorted_at: i.imported_at,
                })
            } else {
                None
            }
        })
        .collect();

    // ディスク上のプロジェクト（.memoanima/.animemo 両対応・アルバム直下）を追加
    for album in list_albums(lib_root)? {
        let dir = lib.join(&album);
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for ent in entries.flatten() {
            let p = ent.path();
            if !p.is_file() {
                continue;
            }
            let file_ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if !is_project_ext(&file_ext) {
                continue;
            }
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            let thumb = PathBuf::from(format!("{}.png", p.to_string_lossy()));
            let order = index
                .project_order
                .get(&format!("{album}/{name}"))
                .copied()
                .unwrap_or(0);
            // M10-20: .memoanima は最終保存日（ファイル更新日時）。取得失敗は 0
            let sorted_at = ent
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(LibraryView {
                kind: "project".into(),
                hash: String::new(),
                album: album.clone(),
                name,
                ext: file_ext,
                size: ent.metadata().map(|m| m.len()).unwrap_or(0),
                path: p.to_string_lossy().to_string(),
                thumb_path: thumb.is_file().then(|| thumb.to_string_lossy().to_string()),
                order,
                sorted_at,
            });
        }
    }

    out.sort_by(|a, b| {
        a.album
            .cmp(&b.album)
            .then_with(|| a.order.cmp(&b.order))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// アルバム（フォルダ）を新規作成する。
pub fn create_album(lib_root: &str, name: &str) -> Result<String, String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    let name = validate_album(name)?;
    let dir = lib.join(&name);
    if dir.exists() {
        return Err(format!("同名のアルバムが既にあります: {name}"));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("作成失敗: {e}"))?;
    Ok(name)
}

/// アルバムをリネームする（フォルダ移動＋索引の rel_path/album を更新）。
pub fn rename_album(lib_root: &str, old: &str, new: &str) -> Result<String, String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    let old_s = validate_album(old)?;
    let new_s = validate_album(new)?;
    if old_s == new_s {
        return Ok(new_s);
    }
    let old_dir = lib.join(&old_s);
    let new_dir = lib.join(&new_s);
    if !old_dir.is_dir() {
        return Err(format!("アルバムが見つかりません: {old_s}"));
    }
    if new_dir.exists() {
        return Err(format!("同名のアルバムが既にあります: {new_s}"));
    }
    fs::rename(&old_dir, &new_dir).map_err(|e| format!("リネーム失敗: {e}"))?;
    let mut index = load_index(lib)?;
    for item in index.items.iter_mut() {
        if item.album == old || item.album == old_s || item.rel_path.starts_with(&format!("{old_s}/")) {
            item.album = new_s.clone();
            if let Some(rest) = item.rel_path.clone().strip_prefix(&format!("{old_s}/")) {
                item.rel_path = format!("{new_s}/{rest}");
            }
        }
    }
    // プロジェクト表示順のキー（rel_path）も付け替える
    let prefix = format!("{old_s}/");
    let moved: Vec<(String, u32)> = index
        .project_order
        .iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    for (k, v) in moved {
        index.project_order.remove(&k);
        index
            .project_order
            .insert(format!("{new_s}/{}", &k[prefix.len()..]), v);
    }
    save_index(lib, &index)?;
    Ok(new_s)
}

/// アルバムを削除する（空フォルダのみ。作品が残っている場合はエラー）。
pub fn delete_album(lib_root: &str, name: &str) -> Result<(), String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    let name = validate_album(name)?;
    let dir = lib.join(&name);
    if !dir.is_dir() {
        return Err(format!("アルバムが見つかりません: {name}"));
    }
    let count = fs::read_dir(&dir)
        .map_err(|e| format!("一覧取得失敗: {e}"))?
        .flatten()
        .count();
    if count > 0 {
        return Err(format!(
            "アルバム「{name}」には {count} 個のファイルがあります。先に中身を移動してください。"
        ));
    }
    fs::remove_dir(&dir).map_err(|e| format!("削除失敗: {e}"))
}

/// メモ（索引管理の .kwz/.ppm）を別アルバムへ移動する。
pub fn move_note(lib_root: &str, hash: &str, dest_album: &str) -> Result<(), String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    let dest_album_s = validate_album(dest_album)?;
    let mut index = load_index(lib)?;
    let item = index
        .items
        .iter_mut()
        .find(|i| i.hash == hash)
        .ok_or_else(|| "作品が索引に見つかりません".to_string())?;
    let src = lib.join(&item.rel_path);
    if !src.is_file() {
        return Err(format!("ファイルが見つかりません: {}", item.rel_path));
    }
    let dest_dir = lib.join(&dest_album_s);
    fs::create_dir_all(&dest_dir).map_err(|e| format!("移動先フォルダ作成失敗: {e}"))?;
    let dest = unique_dest(&dest_dir, &item.name);
    fs::rename(&src, &dest).map_err(|e| format!("移動失敗: {e}"))?;
    let dest_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&item.name)
        .to_string();
    item.album = dest_album_s.clone();
    item.name = dest_name.clone();
    item.rel_path = format!("{dest_album_s}/{dest_name}");
    save_index(lib, &index)
}

/// アルバム内の表示順を保存する。キーは `h:<hash>`（ノート）/ `p:<rel_path>`（プロジェクト）。
/// 前方互換: プレフィクス無しはハッシュとして扱う。
pub fn set_note_order(lib_root: &str, hashes: &[String]) -> Result<(), String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    let mut index = load_index(lib)?;
    for (pos, key) in hashes.iter().enumerate() {
        let ord = (pos + 1) as u32;
        if let Some(rel) = key.strip_prefix("p:") {
            index.project_order.insert(rel.to_string(), ord);
        } else {
            let h = key.strip_prefix("h:").unwrap_or(key);
            if let Some(item) = index.items.iter_mut().find(|i| i.hash == h) {
                item.order = ord;
            }
        }
    }
    save_index(lib, &index)
}

/// M10-16: 保存データの供給元。Bytes=フロントから受けた Vec<u8>（従来の save_project）／
/// File=元ファイルを Rust 側で読む（ドロップ取り込み。バイト列を IPC に通さない）。
/// 供給元以外（サニタイズ・拡張子正規化・原子的置換・サムネ規約）は save_project_impl の1本で共通。
enum ProjectSource<'a> {
    Bytes(&'a [u8]),
    File(&'a Path),
}

/// プロジェクト（.memoanima）とサイドカーサムネ（.memoanima.png）をライブラリ内に保存する。
/// 旧拡張子 .animemo の名前が渡されても新拡張子 .memoanima で保存する（M7-2c。旧ファイルは残る）。
/// 戻り値は保存した絶対パス。
pub fn save_project(
    lib_root: &str,
    album: &str,
    name: &str,
    data: &[u8],
    thumb_png: &[u8],
) -> Result<String, String> {
    save_project_impl(lib_root, album, name, ProjectSource::Bytes(data), thumb_png)
}

/// M10-16: ドロップ取り込み用 — **元ファイル（src_path）を Rust 側で読み、ライブラリへ直接書く**。
/// src_path は読み取り専用（fs::copy で読むだけ。移動・削除・書き込みしない）。
/// 書き込み先の組み立て・サニタイズ・原子的置換・サムネ規約は save_project と完全同一
/// （validate_album / sanitize_component が lib 配下にしかパスを組めない＝封じ込めも同一）。
pub fn import_project_file(
    lib_root: &str,
    album: &str,
    name: &str,
    src_path: &str,
    thumb_png: &[u8],
) -> Result<String, String> {
    let src = Path::new(src_path);
    if !src.is_file() {
        return Err(format!("取り込み元が見つかりません: {src_path}"));
    }
    save_project_impl(lib_root, album, name, ProjectSource::File(src), thumb_png)
}

fn save_project_impl(
    lib_root: &str,
    album: &str,
    name: &str,
    src: ProjectSource,
    thumb_png: &[u8],
) -> Result<String, String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let album_s = validate_album(album)?;
    let mut file = sanitize_component(name);
    let lower = file.to_ascii_lowercase();
    if let Some(stem) = lower
        .strip_suffix(&format!(".{PROJECT_EXT_LEGACY}"))
        .map(|s| s.len())
    {
        // 旧拡張子つきの名前 → 拡張子だけ新に付け替え（basename は不変）
        file = format!("{}.{PROJECT_EXT}", &file[..stem]);
    } else if !lower.ends_with(&format!(".{PROJECT_EXT}")) {
        file = format!("{file}.{PROJECT_EXT}");
    }
    let dir = lib.join(&album_s);
    fs::create_dir_all(&dir).map_err(|e| format!("アルバムフォルダ作成失敗: {e}"))?;
    let dest = dir.join(&file);
    // 一意な一時名に書き、バックアップ経由で置換（rename失敗時も旧ファイルを失わない）
    let tmp = dir.join(format!(
        "{file}.{}-{}.tmp",
        now_unix(),
        TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    match src {
        ProjectSource::Bytes(data) => {
            fs::write(&tmp, data).map_err(|e| format!("保存失敗: {e}"))?;
        }
        ProjectSource::File(p) => {
            fs::copy(p, &tmp).map_err(|e| format!("保存失敗: {e}"))?;
            // fs::copy は読み取り専用属性まで複製する。ライブラリ側のファイルは
            // 従来の fs::write と同じ「普通に書けるファイル」であるべきなので外す
            if let Ok(meta) = fs::metadata(&tmp) {
                let mut perm = meta.permissions();
                if perm.readonly() {
                    perm.set_readonly(false);
                    let _ = fs::set_permissions(&tmp, perm);
                }
            }
        }
    }
    if dest.exists() {
        let bak = dir.join(format!("{file}.bak"));
        let _ = fs::remove_file(&bak);
        if let Err(e) = fs::rename(&dest, &bak) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("旧ファイルの退避に失敗: {e}"));
        }
        if let Err(e) = fs::rename(&tmp, &dest) {
            // ロールバック: 旧ファイルを戻す
            let _ = fs::rename(&bak, &dest);
            let _ = fs::remove_file(&tmp);
            return Err(format!("保存確定失敗（旧ファイルは維持）: {e}"));
        }
        let _ = fs::remove_file(&bak);
    } else if let Err(e) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("保存確定失敗: {e}"));
    }
    if !thumb_png.is_empty() {
        let thumb = dir.join(format!("{file}.png"));
        let _ = fs::write(&thumb, thumb_png);
    }
    Ok(dest.to_string_lossy().to_string())
}

/// M10-14: ライブラリへ**直置き**されたプロジェクトのサイドカーサムネを遅延生成で書き戻す。
/// 規約は save_project と同一（`<プロジェクトパス>.png`）。
///
/// 封じ込め（delete_item と同じ作法）:
/// - フロントから渡るパスを信用せず canonicalize → lib_root 配下のみ許可
/// - 対象は実在する .memoanima / .animemo ファイルに限定（サムネ以外を書く経路を作らない）
/// - 書き込み先は canonicalize 済みターゲット起点で導出（`..` 等で外へ出られない）
pub fn save_project_thumb(lib_root: &str, project_path: &str, png: &[u8]) -> Result<(), String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let lib_c = lib
        .canonicalize()
        .map_err(|e| format!("ライブラリ確認失敗: {e}"))?;
    let tgt_c = Path::new(project_path)
        .canonicalize()
        .map_err(|e| format!("対象確認失敗: {e}"))?;
    if !tgt_c.starts_with(&lib_c) {
        return Err("ライブラリ外へのサムネイル書き込みは拒否しました".into());
    }
    if !tgt_c.is_file() {
        return Err("対象がファイルではありません".into());
    }
    let ext_ok = tgt_c
        .extension()
        .and_then(|e| e.to_str())
        .map(is_project_ext)
        .unwrap_or(false);
    if !ext_ok {
        return Err("プロジェクト（.memoanima / .animemo）以外のサムネイルは書きません".into());
    }
    if png.is_empty() {
        return Err("サムネイルPNGが空です".into());
    }
    let mut thumb = tgt_c.into_os_string();
    thumb.push(".png");
    fs::write(&thumb, png).map_err(|e| format!("サムネイル保存失敗: {e}"))
}

/// ライブラリ内のメモ/プロジェクトを1件削除する（M3.4 L-1。**元データ=SD/取り込み元には一切触れない**）。
/// - hash 有り = 取り込みノート（.kwz/.ppm）: **索引から rel_path を解決**して削除（path引数は受けない）
/// - hash 空  = .animemo プロジェクト: album/name をサニタイズして lib 配下で組み立て
///
/// 設計（Codexレビュー反映）:
/// - フロントから渡るパスを信用しない（対象はサーバ側で解決）→ path/hash 不整合による誤削除が構造的に不可能
/// - 順序: 索引を先に更新・保存 → 実ファイル削除（削除失敗時は索引をロールバック）。
///   逆順だと「ファイルだけ消えて索引に hash が残り、再取り込みも skip される」復旧不能状態になり得る
/// - サイドカーサムネは canonicalize 済みターゲット起点で導出（ライブラリ外を消さない）
pub fn delete_item(lib_root: &str, hash: &str, album: &str, name: &str) -> Result<(), String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let lib_c = lib
        .canonicalize()
        .map_err(|e| format!("ライブラリ確認失敗: {e}"))?;

    // 索引の読み込みに失敗したら何も消さない
    let mut index = load_index(lib)?;

    // 対象パスをサーバ側で解決
    let (target, removed_item): (PathBuf, Option<LibraryItem>) = if !hash.is_empty() {
        let item = index
            .items
            .iter()
            .find(|i| i.hash == hash)
            .cloned()
            .ok_or_else(|| "作品が索引に見つかりません".to_string())?;
        (lib.join(&item.rel_path), Some(item))
    } else {
        let album_s = validate_album(album)?;
        let name_s = sanitize_component(name);
        let lower = name_s.to_ascii_lowercase();
        if !lower.ends_with(&format!(".{PROJECT_EXT}"))
            && !lower.ends_with(&format!(".{PROJECT_EXT_LEGACY}"))
        {
            return Err("プロジェクト（.memoanima / .animemo）以外は削除できません".into());
        }
        (lib.join(&album_s).join(&name_s), None)
    };

    // 封じ込めガード: canonicalize して必ず lib_root 配下のファイルのみ削除する
    let tgt_c = target
        .canonicalize()
        .map_err(|e| format!("対象確認失敗: {e}"))?;
    if !tgt_c.starts_with(&lib_c) {
        return Err("ライブラリ外のファイルは削除できません".into());
    }
    if !tgt_c.is_file() {
        return Err("削除対象がファイルではありません".into());
    }
    if tgt_c
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == INDEX_FILE)
        .unwrap_or(false)
    {
        return Err("索引ファイルは削除できません".into());
    }

    // 1) 索引を先に更新・保存（失敗したら何も消えていない）
    let project_key = removed_item
        .is_none()
        .then(|| format!("{}/{}", validate_album(album).unwrap_or_default(), sanitize_component(name)));
    let removed_order = project_key
        .as_ref()
        .and_then(|k| index.project_order.remove(k).map(|v| (k.clone(), v)));
    if removed_item.is_some() {
        index.items.retain(|i| i.hash != hash);
    }
    save_index(lib, &index)?;

    // 2) 実ファイル削除（失敗したら索引をロールバック）
    if let Err(e) = fs::remove_file(&tgt_c) {
        if let Some(item) = removed_item {
            index.items.push(item);
        }
        if let Some((k, v)) = removed_order {
            index.project_order.insert(k, v);
        }
        let _ = save_index(lib, &index);
        return Err(format!("削除失敗: {e}"));
    }

    // 3) サムネ削除（存在しなくてもエラーにしない）
    if !hash.is_empty() {
        if let Ok(t) = thumb_path(lib, hash) {
            let _ = fs::remove_file(t);
        }
    } else {
        // canonical 済みターゲット起点でサイドカーを導出（ライブラリ内が保証される）
        let mut side = tgt_c.into_os_string();
        side.push(".png");
        let _ = fs::remove_file(PathBuf::from(side));
    }
    Ok(())
}

fn thumb_path(lib_root: &Path, hash: &str) -> Result<PathBuf, String> {
    // ハッシュは hex 64桁のみ許可（パス外への書き込みを防ぐ）
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("不正なハッシュ値です".into());
    }
    Ok(lib_root.join(THUMB_DIR).join(format!("{hash}.png")))
}

/// サムネイルPNGをキャッシュから読む（無ければ None）。
pub fn load_thumb(lib_root: &str, hash: &str) -> Result<Option<Vec<u8>>, String> {
    let p = thumb_path(Path::new(lib_root), hash)?;
    if !p.is_file() {
        return Ok(None);
    }
    fs::read(&p).map(Some).map_err(|e| format!("サムネイル読み込み失敗: {e}"))
}

/// フロントが生成したサムネイルPNGをキャッシュに保存する。
/// 削除との競合で残骸が復活しないよう、索引に存在するハッシュのみ受け付ける（M3.4）。
pub fn save_thumb(lib_root: &str, hash: &str, png: &[u8]) -> Result<(), String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    let p = thumb_path(lib, hash)?;
    let index = load_index(lib)?;
    if !index.items.iter().any(|i| i.hash == hash) {
        return Err("索引に存在しない作品のサムネイルは保存しません".into());
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("サムネイルフォルダ作成失敗: {e}"))?;
    }
    fs::write(&p, png).map_err(|e| format!("サムネイル保存失敗: {e}"))
}
