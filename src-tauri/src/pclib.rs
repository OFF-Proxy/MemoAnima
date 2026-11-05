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
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::library;

// V202 (M-1a・要件 §4-3・§4-4・§4-5): モバイルだけの保存の仕組み（名前の決まり・指紋で確かめる上書き・退避と再開・開いた作品ごとの
// オートセーブ・探す）。pclib の子に置くのは、ここの関数（sanitize_component・validate_album・lock_lib ほか）を**見える範囲を広げずに**
// 使うため。PC の製品のビルドでは組み立てない（モバイル・cargo test・検査用の実行ファイル〔feature mobile-harness〕だけ）
#[cfg(any(mobile, test, feature = "mobile-harness"))]
pub mod mobile;

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
/// 索引の load-modify-save が並行実行で互いを上書きしないようにする（独立レビューの指摘）。
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

/// V154 (W-1): **置き換えの確定だけ**を担う共通ヘルパー。tmp は呼び出し側が用意する。
///
/// 手順は従来どおり「既存を `<file>.bak` へ退避 → tmp を本体へ rename」だが、
/// **最後に `.bak` を消さない**。ここが V154 の本体:
///
/// 退避と確定は2回の rename で、そのあいだに**プロセスが死ぬ窓**がある
///（メモリ枯渇で落ちるのは、まさにこの「死ぬ」ケース）。窓で死ぬと本体が存在しない状態が残るが、
/// **`.bak` を残しておけば中身はディスクに在る**＝次の起動で拾って戻せる（`scan_recoverable`）。
/// 消えるより 1世代ぶんディスクを食うほうがましだ、という判断（要件 §2-b ⑥・許容）。
///
/// **世代は1つのまま**: 次の保存の先頭で古い `.bak` を消してから退避するので、増えていかない。
/// **ロールバックは弱めない**: 確定の rename が失敗したら退避を本体へ戻す（従来と同じ）。
///
/// 呼び出し側は `pclib::save_project_impl`（手動保存）と `lib.rs::atomic_replace`
///（**オートセーブ・15秒ごと**）の2つ。**同じ手順が2か所に書かれていたこと自体が事故のもと**
/// だったので、確定の3手順はここ1つに寄せた（要件 §2-b ①）。
pub fn commit_replace(dir: &Path, dest: &Path, tmp: &Path) -> Result<(), String> {
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "保存先の名前を解決できません".to_string())?;
    if dest.exists() {
        let bak = dir.join(format!("{name}.bak"));
        // 前回の退避は捨てる（**世代は常に1つ**）
        let _ = fs::remove_file(&bak);
        if let Err(e) = fs::rename(dest, &bak) {
            let _ = fs::remove_file(tmp);
            return Err(format!("旧ファイルの退避に失敗: {e}"));
        }
        if let Err(e) = fs::rename(tmp, dest) {
            // ロールバック: 旧ファイルを戻す（従来どおり）
            let _ = fs::rename(&bak, dest);
            let _ = fs::remove_file(tmp);
            return Err(format!("保存確定失敗（旧ファイルは維持）: {e}"));
        }
        // V154: ここで `.bak` を**消さない**（従来は remove_file していた）
        Ok(())
    } else if let Err(e) = fs::rename(tmp, dest) {
        let _ = fs::remove_file(tmp);
        Err(format!("保存確定失敗: {e}"))
    } else {
        Ok(())
    }
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

/// V216b (A-131): アルバムのフォルダがリンクで、ライブラリの外（か辿れない先）を指すときの断り（パスを入れない＝W-10）
pub const ALBUM_LINK_OUTSIDE: &str = "アルバムのフォルダがライブラリの外を指しています（リンク）。書き込み・移動はできません";

/// ★V216b (A-131・要件 §2-3): 書く・動かす前に、アルバムのフォルダがリンク（シンボリックリンク・Windows のジャンクション）かを見て、
/// **リンクのときだけ**辿った先がライブラリの辿った先の下かを確かめる。外・辿れない・ライブラリそのものなら断る。
/// リンクでない（普通のフォルダ・まだ無いフォルダ）は辿らない＝`canonicalize` に失敗するドライブでも今と同じに動く。
/// 呼ぶのは保存と取り込み（`save_project_core`）・まとめ変換（`create_project_with`）・SD と単発の取り込み・メモの移動（元と行き先）・
/// `.gz` の名前の直し。作品の移動・削除・作品のサムネ・元に戻すは今の確かめのまま
fn ensure_album_inside(lib: &Path, dir: &Path) -> Result<(), String> {
    ensure_album_inside_with(lib, dir, |p| p.canonicalize())
}

/// `ensure_album_inside` の本体（`canon` はテストが「辿れない」を差し込む口・本物は `canonicalize`）
fn ensure_album_inside_with(
    lib: &Path,
    dir: &Path,
    canon: impl Fn(&Path) -> std::io::Result<PathBuf>,
) -> Result<(), String> {
    match fs::symlink_metadata(dir) {
        Ok(m) if m.file_type().is_symlink() => {}
        _ => return Ok(()),
    }
    let lib_c = canon(lib).map_err(|_| ALBUM_LINK_OUTSIDE.to_string())?;
    let dir_c = canon(dir).map_err(|_| ALBUM_LINK_OUTSIDE.to_string())?;
    if dir_c.starts_with(&lib_c) && dir_c != lib_c {
        Ok(())
    } else {
        Err(ALBUM_LINK_OUTSIDE.to_string())
    }
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

/// M11-4: **外部（エクスプローラー等）でライブラリ内を移動された作品を探し直す。**
/// 幽霊行を消す前に呼ぶこと。実体が見つかった行は `album`/`name`/`rel_path` を新しい位置へ
/// 書き換える（＝索引から消さない）。戻り値は復旧した行数。
///
/// コスト（重要・ハンドオフ指定）:
/// - **幽霊行が1件も無ければ即座に返る**（＝通常の起動・スキャンではファイルを1つも読まない）
/// - 照合対象は「索引に載っていない実ファイル」だけ（全件のハッシュは計算しない）
/// - 読むのは**幽霊行と同じサイズの候補だけ**（索引の `size` で足切り）。
///   幽霊行が求める実体が全部そろった時点で打ち切る（残りの候補は読まない）
///
/// サムネキャッシュは `thumbs/<hash>.png` でハッシュ基準のため追随不要。
/// 同一内容（同ハッシュ）の実体が複数ある場合は、1行に1実体ずつ順に割り当てる。
fn relocate_moved_notes(lib: &Path, index: &mut LibraryIndex, alive: &[bool]) -> usize {
    // 1) 探しているもの（幽霊行）のハッシュとサイズ。size が 0 の行（壊れた索引）が
    //    混じっていたらサイズ足切りは使わない＝取りこぼすより読む方を選ぶ
    let mut want_hashes: HashSet<String> = HashSet::new();
    let mut want_sizes: HashSet<u64> = HashSet::new();
    let mut want_rows = 0usize;
    let mut use_size = true;
    for (item, a) in index.items.iter().zip(alive) {
        if *a {
            continue;
        }
        want_rows += 1;
        want_hashes.insert(item.hash.clone());
        if item.size == 0 {
            use_size = false;
        } else {
            want_sizes.insert(item.size);
        }
    }
    if want_rows == 0 {
        return 0;
    }
    // 2) 実在している行の相対パスは照合対象から外す（別の行が使っているファイル）
    let taken: HashSet<String> = index
        .items
        .iter()
        .zip(alive)
        .filter(|(_, a)| **a)
        .map(|(i, _)| i.rel_path.to_ascii_lowercase())
        .collect();
    // 3) ライブラリ内の .kwz/.ppm のうち、索引に載っていないものだけを候補にする
    let mut candidates: Vec<(String, String, String, u64)> = Vec::new(); // (album, name, rel, size)
    for album in list_albums(&lib.to_string_lossy()).unwrap_or_default() {
        let Ok(entries) = fs::read_dir(lib.join(&album)) else {
            continue;
        };
        for ent in entries.flatten() {
            let Ok(md) = ent.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            let p = ent.path();
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if ext != "kwz" && ext != "ppm" {
                continue;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let rel = format!("{album}/{name}");
            if taken.contains(&rel.to_ascii_lowercase()) {
                continue;
            }
            candidates.push((album.clone(), name.to_string(), rel, md.len()));
        }
    }
    if candidates.is_empty() {
        return 0;
    }
    candidates.sort_by(|a, b| a.2.cmp(&b.2)); // 実行ごとに同じ結果になるように
    // 4) 候補のハッシュを取る（サイズ違いは読まない・求めているものが全部そろったら打ち切り）
    let mut by_hash: std::collections::HashMap<String, Vec<(String, String, String)>> =
        std::collections::HashMap::new();
    let mut found = 0usize;
    for (album, name, rel, size) in candidates {
        if use_size && !want_sizes.contains(&size) {
            continue;
        }
        let Ok(bytes) = fs::read(lib.join(&rel)) else {
            continue;
        };
        let h = hex::encode(Sha256::digest(&bytes));
        if !want_hashes.contains(&h) {
            continue; // 幽霊行が求めていない実体は覚えない
        }
        by_hash.entry(h).or_default().push((album, name, rel));
        found += 1;
        if found >= want_rows {
            break;
        }
    }
    // 5) 幽霊行に一致があれば新しい位置へ書き換える（1つの実体は1行だけが引き受ける）
    let mut fixed = 0usize;
    for (item, a) in index.items.iter_mut().zip(alive) {
        if *a {
            continue;
        }
        let Some(v) = by_hash.get_mut(&item.hash) else { continue };
        if v.is_empty() {
            continue;
        }
        let (album, name, rel) = v.remove(0);
        item.album = album;
        item.name = name;
        item.rel_path = rel;
        fixed += 1;
    }
    fixed
}

/// M10-18 + M11-4: 索引の自己修復。戻り値は (復旧した行数, 掃除した行数)。
///
/// - **実ファイルは一切消さない**（消してよいのは台帳の行だけ）
/// - 実体が見つからない行は、まず M11-4 の探し直し（外部移動）にかけ、
///   それでも見つからなければ M10-18 どおり行を落とす
/// - **実在判定（stat）は1周だけ**。健全な状態（幽霊行ゼロ）では旧 `prune_ghost_rows`
///   と同じコストで即座に返る＝通常スキャンを一切重くしない（ハンドオフの計測条件）
/// - サムネキャッシュ（.animemo/thumbs/）は触らない（同ハッシュの別行が生きている場合がある）
fn heal_index_rows(lib: &Path, index: &mut LibraryIndex) -> (usize, usize) {
    // V154 (W-1b): **退避（`.bak`）がある行は「実体あり」として扱う**。
    // 保存の窓（退避 → 確定のあいだ）で死ぬと本体が消えた状態になるが、中身は `.bak` に在る。
    // ここで行を落とすと**再起動が復旧のとどめを刺す**（Culoe さんの報告「再起動しても直らず」）。
    // 落とさずに残しておけば、`scan_recoverable` → 復元プロンプトへつながる。
    // ※「実ファイルは一切消さない」という既存の原則はそのまま（消してよいのは台帳の行だけ）
    let has_row_file = |rel: &str| lib.join(rel).is_file() || lib.join(format!("{rel}.bak")).is_file();
    let alive: Vec<bool> = index.items.iter().map(|i| has_row_file(&i.rel_path)).collect();
    if alive.iter().all(|a| *a) {
        return (0, 0); // 幽霊行なし＝探索も掃除も不要（ファイルは1つも読まない）
    }
    let relocated = relocate_moved_notes(lib, index, &alive);
    let before = index.items.len();
    // 復旧できなかった行だけを落とす（復旧済みの行は実体があるので残る）
    index.items.retain(|i| has_row_file(&i.rel_path));
    // 同じ実体を指す行が2行できていたら1行にする（M10-18 の「重複行を作らない」規約の保険。
    // 実在判定と探索のあいだで一時的に stat が失敗した場合などに起こりうる）
    let mut seen: HashSet<String> = HashSet::new();
    index.items.retain(|i| seen.insert(i.rel_path.to_ascii_lowercase()));
    (relocated, before - index.items.len())
}

/// V154 (W-6): **書いたものを読み戻して、書いたつもりのバイト列と同じか**を確かめる。
///
/// なぜ要るか（追記の事故モデル）: 報告者のフォルダに `.bak` が1つも無かった＝
/// **保存は最後まで成功していた**。「窓で死んだ」のではなく、**壊れたバイト列が
/// 「保存成功」として確定し、正しい版が2つとも捨てられた**というのが最も合う筋書き。
/// 書きっぱなしで成功を名乗らず、必ず1回読み直す。
///
/// 違っていたら**前の版（`<name>.bak`）へ戻す**。壊れたほうは `<name>.broken` として
/// 残す（消さない＝原因を調べられる。同名があれば連番）。控えが無ければ戻さず、
/// 書いたものをそのまま残して Err にする（**何も消さない**のはどちらでも同じ）。
///
/// 費用: ファイルをもう1回読む（同じ大きさのメモリを一時的に使う）。
/// 保存のたびに1回だけで、絵を描いている最中には走らない。
pub fn verify_or_rollback(dir: &Path, dest: &Path, want: &[u8]) -> Result<(), String> {
    let got = match fs::read(dest) {
        Ok(b) => b,
        Err(e) => return Err(format!("保存を確認できませんでした（読み戻せません）: {e}")),
    };
    if got.len() == want.len() && got == want {
        return Ok(());
    }
    let detail = if got.len() != want.len() {
        format!("長さが違います（書いた {} / 読めた {}）", want.len(), got.len())
    } else {
        "中身が違います".to_string()
    };
    Err(rollback_to_bak(dir, dest, &detail))
}

/// V154 (W-6): 検証に落ちたときの後始末。**前の版へ戻し、壊れたほうは残す**。
/// 戻り値はそのまま利用者向けの理由になる文字列。
fn rollback_to_bak(dir: &Path, dest: &Path, detail: &str) -> String {
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let bak = dir.join(format!("{name}.bak"));
    if !bak.is_file() {
        return format!("保存できませんでした（{detail}）");
    }
    let mut broken = dir.join(format!("{name}.broken"));
    for i in 2..100 {
        if !broken.exists() {
            break;
        }
        broken = dir.join(format!("{name}.broken{i}"));
    }
    if fs::rename(dest, &broken).is_ok() && fs::rename(&bak, dest).is_ok() {
        return format!(
            "保存できませんでした（{detail}）。前の版に戻しました。書けなかったものは {} に残しています",
            broken.file_name().and_then(|n| n.to_str()).unwrap_or("")
        );
    }
    // 戻せなかった場合も**何も消さない**（控えはそのまま）
    format!("保存できませんでした（{detail}）。前の版は控え（.bak）に残っています")
}

/// V154 (W-1): 復元できそうな残骸（保存の窓で死んだ跡）。フロントの復元プロンプト用。
#[derive(Debug, Serialize)]
pub struct RecoverableView {
    pub album: String,
    /// 本体のファイル名（`.bak` を外した形。例: `さくひん.memoanima`）
    pub name: String,
    /// ライブラリからの相対パス（例: `アルバム/さくひん.memoanima`）
    pub rel_path: String,
    /// 退避（`<name>.bak`）のバイト数。0 なら退避なし＝`.tmp` だけがある状態
    pub bak_size: u64,
    /// 退避の更新時刻（UNIX秒・取得できなければ 0）
    pub bak_at: u64,
    /// 保存途中で残った `.tmp`（**新しいほうの世代**の可能性がある）。絶対パスと大きさ
    pub tmp_files: Vec<(String, u64)>,
}

/// V154 (W-1): ライブラリを走査して「保存の途中で終了した跡」を集める。
///
/// 拾うのは **本体が無いのに `<本体>.bak` がある**プロジェクトだけ
///（本体が在るなら、`.bak` は正常な1世代前の控え＝出さない）。
/// あわせて同じ本体名の `.tmp` も添える（要件 §0: `.tmp` は**新しいほうの世代**かもしれないので、
/// **こちらから勝手に消さない**。復元の判断材料として見せるだけ）。
///
/// **何も消さない・何も書かない**（読むだけ）。復元は `recover_project` で明示的に行う。
pub fn scan_recoverable(lib_root: &str) -> Result<Vec<RecoverableView>, String> {
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let mut out: Vec<RecoverableView> = Vec::new();
    for album in list_albums(lib_root)? {
        let dir = lib.join(&album);
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        // 1周目: `.bak` を集める（本体が無いものだけ）
        let mut tmp_by_base: std::collections::HashMap<String, Vec<(String, u64)>> =
            std::collections::HashMap::new();
        let mut baks: Vec<(String, u64, u64)> = Vec::new(); // (本体名, size, mtime)
        let list: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
        for p in &list {
            let Some(fname) = p.file_name().and_then(|n| n.to_str()) else { continue };
            if let Some(base) = fname.strip_suffix(".bak") {
                // `.bak` の本体がプロジェクトの拡張子でなければ相手にしない（索引や設定の控えを拾わない）
                let base_ext = Path::new(base)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .unwrap_or_default();
                if !is_project_ext(&base_ext) {
                    continue;
                }
                if dir.join(base).is_file() {
                    continue; // 本体が在る＝正常な控え
                }
                let meta = fs::metadata(p).ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                if size == 0 {
                    // 中身が空の控えは**復元しても開けない**。候補に出すと「戻したのに開けない」に
                    // なるだけなので出さない（ファイルは消さない＝手で触る道は残す）
                    continue;
                }
                let at = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                baks.push((base.to_string(), size, at));
            } else if fname.ends_with(".tmp") {
                // `<本体>.<数字>-<数字>.tmp` / `<本体>.<数字>.tmp` の**本体名**を取り出す
                if let Some(base) = tmp_base_name(fname) {
                    let size = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                    tmp_by_base
                        .entry(base)
                        .or_default()
                        .push((p.to_string_lossy().to_string(), size));
                }
            }
        }
        for (base, size, at) in baks {
            let tmp_files = tmp_by_base.get(&base).cloned().unwrap_or_default();
            out.push(RecoverableView {
                album: album.clone(),
                name: base.clone(),
                rel_path: format!("{album}/{base}"),
                bak_size: size,
                bak_at: at,
                tmp_files,
            });
        }
    }
    // 新しい順（拾いやすさ優先）
    out.sort_by(|a, b| b.bak_at.cmp(&a.bak_at));
    Ok(out)
}

/// `<本体名>.<数字>-<数字>.tmp` / `<本体名>.<数字>.tmp` から本体名を取り出す。
/// 一時名の作り方は `save_project_impl`（timestamp-counter）と `lib.rs::atomic_replace`（counter）の2種類。
fn tmp_base_name(fname: &str) -> Option<String> {
    let stem = fname.strip_suffix(".tmp")?;
    let (base, tail) = stem.rsplit_once('.')?;
    // tail は「数字」または「数字-数字」だけを認める（利用者のファイル名を誤爆しないため）
    let ok = !tail.is_empty()
        && tail
            .split('-')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    if !ok {
        return None;
    }
    let base_ext = Path::new(base)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !is_project_ext(&base_ext) {
        return None;
    }
    Some(base.to_string())
}

/// V154 (W-1): 退避（`.bak`）から本体を戻す。**上書きはしない**（本体が在るなら何もしない）。
///
/// 戻すのは rename 1回だけ＝`.bak` の中身をそのまま本体名にする。
/// 失敗しても `.bak` は残る（利用者が手で戻す道を塞がない）。
pub fn recover_project(lib_root: &str, rel_path: &str) -> Result<String, String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let lib_c = lib.canonicalize().map_err(|e| format!("ライブラリ確認失敗: {e}"))?;
    // 相対パスは「アルバム/ファイル名」の2要素だけを認める（`..` や絶対パスを弾く）
    let (album, name) = rel_path
        .split_once('/')
        .ok_or_else(|| "復元対象の指定が不正です".to_string())?;
    let album_s = validate_album(album)?;
    let name_s = sanitize_component(name);
    let ext = Path::new(&name_s)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !is_project_ext(&ext) {
        return Err("プロジェクト（.memoanima / .animemo）以外は復元できません".into());
    }
    let dir = lib.join(&album_s);
    let dest = dir.join(&name_s);
    let bak = dir.join(format!("{name_s}.bak"));
    if !bak.is_file() {
        return Err("復元のもとになる控えが見つかりません".into());
    }
    // 封じ込め: 控えは必ずライブラリ配下であること
    let bak_c = bak.canonicalize().map_err(|e| format!("控えの確認に失敗: {e}"))?;
    if !bak_c.starts_with(&lib_c) {
        return Err("ライブラリ外のファイルは復元できません".into());
    }
    if dest.exists() {
        // 本体が在るなら触らない（上書きは絶対にしない）
        return Err("同じ名前の作品が既にあります（控えは残したままにしました）".into());
    }
    fs::rename(&bak_c, &dest).map_err(|e| format!("復元に失敗: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
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
    // M11-4: 掃除の前に外部移動の探し直しを挟む（scan_library と同じ順序。これが無いと
    // 取り込みのたびに「移動しただけの作品」の行が消えてしまう）
    heal_index_rows(lib, &mut index);
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
            ensure_album_inside(lib, &album_dir)?; // V216b (A-131)
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
    ensure_album_inside(lib, &dir)?; // V216b (A-131)
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

/// M11-4: 外部変更の**軽量**検知用の指紋。アルバム名と、その中の**作品ファイルの名前・サイズ**
/// （.kwz/.ppm/.memoanima/.animemo だけ）＋索引ファイルの更新時刻・サイズを見る。
/// `scan_library` と違い索引の読み込みも JSON 直列化も行わないので2桁軽い。
/// フォーカス復帰のたびに呼び、値が変わったときだけ本スキャンする。
///
/// フォルダの更新時刻を使わない理由（M11-4 レビュー反映）:
/// - アプリ自身が書くサイドカーサムネ（`<作品名>.memoanima.png`）でフォルダの更新時刻と
///   エントリ数が動く＝**外部変更が無いのに毎回フル再スキャン**していた
/// - `mtime` の秒丸めで「同じ秒に起きた2回目の変更」を取りこぼしていた
/// 名前とサイズを見ることで、リネーム・追加・削除・上書き（サイズ変化）を直接拾える。
/// 「同名・同サイズでの中身の差し替え」だけは拾えないが、これは 🔄 更新ボタンの担当。
pub fn library_stamp(lib_root: &str) -> Result<String, String> {
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let mut h = Sha256::new();
    for album in list_albums(lib_root)? {
        h.update([0u8]); // 区切り（名前の連結で偶然一致しないように）
        h.update(album.as_bytes());
        let mut files: Vec<(String, u64)> = Vec::new();
        if let Ok(entries) = fs::read_dir(lib.join(&album)) {
            for ent in entries.flatten() {
                let Ok(md) = ent.metadata() else { continue };
                if !md.is_file() {
                    continue;
                }
                let name = ent.file_name().to_string_lossy().to_string();
                let ext = Path::new(&name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .unwrap_or_default();
                if ext != "kwz" && ext != "ppm" && !is_project_ext(&ext) {
                    continue; // サムネ等の付属物は無視（自分の書き込みで指紋を動かさない）
                }
                files.push((name, md.len()));
            }
        }
        files.sort();
        for (name, len) in files {
            h.update([1u8]);
            h.update(name.as_bytes());
            h.update(len.to_le_bytes());
        }
    }
    // 索引ファイル（外部からの差し替え・別プロセスの取り込みを拾う。秒丸めは避ける）
    let idx = index_path(lib);
    let (mtime, len) = fs::metadata(&idx)
        .map(|m| {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            (t, m.len())
        })
        .unwrap_or((0, 0));
    h.update(mtime.to_le_bytes());
    h.update(len.to_le_bytes());
    Ok(hex::encode(h.finalize()))
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
    // M11-4: 掃除の前に「外部で移動された作品」を探し直す（幽霊行があるときだけ走る）。
    // これが無いと、エクスプローラーでアルバムを移した .kwz が幽霊行として消え、
    // アプリから見えなくなる（再取り込みが必要になる）
    let (relocated, pruned) = heal_index_rows(lib, &mut index);
    if relocated > 0 || pruned > 0 {
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

// ---------------- V173 (A-65): クラウド経由の改名（`.gz`）からの復帰 ----------------
//
// ★何が起きているか: クラウド（共有リンク・同期フォルダ）を経由すると、作品ファイルの名前の末尾に
//  `.gz` が付いて返ってくることがある。PV6 の器は**先頭が `1f 8b`＝gzip に見える**ため、
//  転送側が「これは gzip だ」と判断して拡張子を足す。**中身は 1 バイトも変わっていない。**
//
// ★なぜアルバムが 0 件に見えるか: `scan_library` のディスク走査は `p.extension()` が
//  `"gz"` になった時点で `is_project_ext` に落ちる。`.kwz` / `.ppm` は索引の行から出るので無事＝
//  **`.memoanima` だけが消えて見える**（Finder には PNG サムネが見えるのに、アプリでは 0 件）。
//
// ★直し方の作法（改名は**元に戻せない操作**なので、条件を 1 つも落とさない）:
//   - 名前が `.memoanima.gz` / `.animemo.gz` で終わる（大小無視）
//   - `.gz` を外した名前の**実体が無い**（あるなら別物。触らない）
//   - **先頭 2 バイトが `1f 8b`**（中身はこれ以上読まない）
//  の 3 つを**すべて**満たすものだけを改名し、**既に同名があれば飛ばす（上書きしない）**。
//  1 件ごとに独立＝途中で失敗しても、それまでの改名は有効。失敗は `errors` に積んでフロントがログへ。
//  `is_app_sidecar` に `.gz` を**足さない**こと（足すと「作品 0 件のアルバム」と一緒に消える。`v173_smoke` [S-5]）。

/// クラウドが付ける拡張子。
const GZ_SUFFIX: &str = ".gz";

/// `.memoanima.gz` / `.animemo.gz` なら、`.gz` を外した名前を返す。それ以外は `None`。
/// **`.png.gz` は対象外**（サイドカーのサムネは作品ではない）。
fn gz_renamed_target(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let hit = lower.ends_with(&format!(".{PROJECT_EXT}{GZ_SUFFIX}"))
        || lower.ends_with(&format!(".{PROJECT_EXT_LEGACY}{GZ_SUFFIX}"));
    if !hit {
        return None;
    }
    Some(name[..name.len() - GZ_SUFFIX.len()].to_string())
}

/// その名前が**既に使われている**か。`exists()` ではなく `symlink_metadata` を使うのは、
/// **壊れたシンボリックリンク**（リンク先が無い）も「既にある」として扱うため
/// （`exists()` はリンクを辿るので false を返し、上書きの判断を誤る。独立レビューの指摘・優先度 高）。
fn path_taken(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// 先頭 2 バイトが gzip の magic（`1f 8b`）か。**中身はこれ以上読まない。**
fn is_gzip_magic(p: &Path) -> bool {
    let Ok(mut f) = fs::File::open(p) else {
        return false;
    };
    let mut head = [0u8; 2];
    f.read_exact(&mut head).is_ok() && head == [0x1f, 0x8b]
}

/// 改名の候補を 1 件ずつ渡す（`scan_renamed_projects` と `fix_renamed_projects` で**同じ条件**を使う）。
fn for_each_renamed(lib_root: &str, mut f: impl FnMut(&str, &str, &Path, &Path)) -> Result<(), String> {
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    for album in list_albums(lib_root)? {
        let dir = lib.join(&album);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for ent in entries.flatten() {
            let p = ent.path();
            if !p.is_file() {
                continue;
            }
            let fname = ent.file_name().to_string_lossy().to_string();
            let Some(target) = gz_renamed_target(&fname) else {
                continue;
            };
            let dest = dir.join(&target);
            // 条件②: `.gz` を外した名前が既に使われているなら、それは別のファイル。触らない
            if path_taken(&dest) {
                continue;
            }
            // 条件③: 中身が gzip（＝PV6 の器）に見えるものだけ
            if !is_gzip_magic(&p) {
                continue;
            }
            f(&album, &fname, &p, &dest);
        }
    }
    Ok(())
}

/// V173 (A-65): `.gz` が付いて見えなくなっている作品を探す。**読むだけ**（改名はしない）。
/// 戻りは `アルバム/ファイル名`。フロントは**件数だけ**を使う（W-10: 作品名をログに書かない）。
pub fn scan_renamed_projects(lib_root: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for_each_renamed(lib_root, |album, fname, _p, _dest| {
        out.push(format!("{album}/{fname}"));
    })?;
    Ok(out)
}

/// V173 (A-65) の結果。`skipped` は「同名が既にあるので飛ばした」件数。
#[derive(Debug, Serialize)]
pub struct FixRenamedResult {
    pub renamed: u32,
    pub skipped: u32,
    pub errors: Vec<String>,
}

/// V173 (A-65): `.gz` を外して元の名前に戻す。**中身には一切触れない**。
/// - 既に同名があれば**飛ばす**（上書きしない・`skipped`）
/// - 1 件ごとに独立（1 件失敗しても、それまでの改名は有効・残りも試す）
/// - `errors` の文には**作品名を入れない**（W-10。理由だけ）
///
/// ★**`fs::rename` を使わない**（独立レビューの指摘・優先度 高）: `rename` は宛先が在っても**黙って置き換える**
///  （Windows も Unix も）。`lock_lib()` はアプリ内のロックなので、**クラウドの同期クライアントや
///  エクスプローラー**が「見てから改名するまで」の隙に同じ名前を作ると、**上書きしてしまう**——
///  そもそもこの事故を起こしているのが同期クライアントなので、この隙は現実に踏み得る。
///  代わりに **`hard_link`（宛先が在れば必ず失敗する＝OS が保証）→ 元を消す**の 2 手で行う。
///  ハードリンクを作れないファイルシステム（FAT32 / exFAT など）では**改名せず `errors` に積む**
///  ——「直せませんでした」で済ませるほうが、上書きの危険を残すより安全。
pub fn fix_renamed_projects(lib_root: &str) -> Result<FixRenamedResult, String> {
    let _guard = lock_lib();
    let mut renamed = 0u32;
    let mut skipped = 0u32;
    let mut errors: Vec<String> = Vec::new();
    let lib = Path::new(lib_root);
    for_each_renamed(lib_root, |album, _fname, p, dest| {
        // ★V216b (A-131): リンクのアルバムがライブラリの外を指すなら触らない（理由だけ・作品名を入れない）
        if let Err(e) = ensure_album_inside(lib, &lib.join(album)) {
            errors.push(e);
            return;
        }
        // 安い門番（この時点で在れば、そもそも試さない）
        if path_taken(dest) {
            skipped += 1;
            return;
        }
        // ★本当の保証はこちら: 宛先が在れば `hard_link` は AlreadyExists で失敗する（原子的）
        match fs::hard_link(p, dest) {
            Ok(()) => {
                // 実体は 1 つのまま。古い名前（`.gz`）を外す
                if let Err(e) = fs::remove_file(p) {
                    // リンクは張れたが古い名前が消せない＝**両方の名前が同じ中身を指している**。
                    // 作品は見えるようになるので実害は小さいが、跡が残るのでログに残す
                    errors.push(format!("old name left: {e}"));
                }
                renamed += 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => skipped += 1,
            Err(e) => errors.push(format!("link failed: {e}")),
        }
    })?;
    Ok(FixRenamedResult {
        renamed,
        skipped,
        errors,
    })
}

/// V173 (A-65 案 4): 利用者が**明示的に選んだ 1 個**のファイルが作品かどうかを、名前ではなく中身で見る。
/// **先頭 2 バイト（gzip の magic）と末尾 16 バイト（PV6 のトレーラ `AMPV6END`）だけ**を読む。
/// ファイル全体は読まない（`v173_smoke` [S-4]）。走査（`scan_library`）からは呼ばない。
#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub gzip: bool,
    pub pv6: bool,
    pub size: u64,
}

pub fn probe_project_file(path: &str) -> Result<ProbeResult, String> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| format!("確認失敗: {e}"))?;
    if !meta.is_file() {
        return Err("ファイルではありません".into());
    }
    let size = meta.len();
    let mut f = fs::File::open(p).map_err(|e| format!("確認失敗: {e}"))?;
    let mut head = [0u8; 2];
    let gzip = f.read_exact(&mut head).is_ok() && head == [0x1f, 0x8b];
    // PV6 のトレーラ: "AMPV6END"(8) + u32LE headerGzLen + u32LE blobSectionLen ＝ 16 バイト
    let mut pv6 = false;
    if size >= 16 {
        let mut tail = [0u8; 16];
        if f.seek(SeekFrom::End(-16)).is_ok() && f.read_exact(&mut tail).is_ok() {
            pv6 = &tail[..8] == b"AMPV6END";
        }
    }
    Ok(ProbeResult { gzip, pv6, size })
}

/// M11-1: 作品ファイル（利用者の作品そのもの）か。これが1件でもあるアルバムは削除しない。
fn is_work_file(name: &str) -> bool {
    match Path::new(name).extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            is_project_ext(ext) || ext.eq_ignore_ascii_case("kwz") || ext.eq_ignore_ascii_case("ppm")
        }
        None => false,
    }
}

/// M11-1: アプリ／OS が作る付属物か（作品が0件なら、これらは一緒に消してよい）。
/// **ここに列挙したもの以外は「利用者が置いたファイル」として扱い、決して消さない。**
fn is_app_sidecar(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(&format!(".{PROJECT_EXT}.png"))
        || lower.ends_with(&format!(".{PROJECT_EXT_LEGACY}.png"))
        || lower == "thumbs.db"
        || lower == "desktop.ini"
        || lower == ".ds_store"
}

/// アルバムを削除する。
///
/// M11-1: 「空である」の判定を**作品ファイルの有無**で行う（従来は全ファイル数だったため、
/// アプリ自身が作るサイドカーサムネ `<作品名>.memoanima.png` が残っているだけで
/// 利用者がアルバムを削除できなかった）。
/// - 作品（.memoanima/.animemo/.kwz/.ppm）が1件でもあれば拒否（件数は「作品数」で示す）
/// - 作品0件なら、アプリ／OS 由来の付属物（`is_app_sidecar`）ごと削除してよい
/// - **利用者が置いた未知のファイルが1件でもあれば拒否**（黙って消さない）
/// - サブフォルダがある場合は従来どおり拒否（アルバムはフラット構造）
/// - 削除は lib_root 配下のみ（canonicalize + starts_with。delete_item と同じ作法）
pub fn delete_album(lib_root: &str, name: &str) -> Result<(), String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    let name = validate_album(name)?;
    let dir = lib.join(&name);
    if !dir.is_dir() {
        return Err(format!("アルバムが見つかりません: {name}"));
    }
    // M11-1: アルバム自体がリンク（ジャンクション/シンボリックリンク）なら触らない。
    // canonicalize はリンクを解決するため、解決先を削除すると「リンクを消したつもりが
    // 別フォルダの中身が消える」ことになる（レビューで実測した回帰の対策）
    let link_meta = fs::symlink_metadata(&dir).map_err(|e| format!("アルバム確認失敗: {e}"))?;
    if link_meta.file_type().is_symlink() {
        return Err(format!(
            "アルバム「{name}」はリンク（ショートカット）です。実体を確認のうえ、エクスプローラーで削除してください。"
        ));
    }
    // 封じ込め: ジャンクション/シンボリックリンクでライブラリ外を指していても消さない
    let lib_c = lib
        .canonicalize()
        .map_err(|e| format!("ライブラリ確認失敗: {e}"))?;
    let dir_c = dir
        .canonicalize()
        .map_err(|e| format!("アルバム確認失敗: {e}"))?;
    if !dir_c.starts_with(&lib_c) || dir_c == lib_c {
        return Err("ライブラリ外のフォルダは削除できません".into());
    }

    let mut works = 0usize;
    let mut sidecars: Vec<PathBuf> = Vec::new();
    let mut others: Vec<String> = Vec::new();
    let mut has_subdir = false;
    for ent in fs::read_dir(&dir_c)
        .map_err(|e| format!("一覧取得失敗: {e}"))?
        .flatten()
    {
        let fname = ent.file_name().to_string_lossy().to_string();
        // シンボリックリンクは is_dir/is_file とも false → others 扱い（＝消さずに拒否）
        let ftype = ent.file_type().map_err(|e| format!("種別確認失敗: {e}"))?;
        if ftype.is_dir() {
            has_subdir = true;
        } else if is_work_file(&fname) {
            works += 1;
        } else if ftype.is_file() && is_app_sidecar(&fname) {
            sidecars.push(ent.path());
        } else {
            others.push(fname);
        }
    }
    if works > 0 {
        return Err(format!(
            "アルバム「{name}」には {works} 件の作品があります。先に中身を移動してください。"
        ));
    }
    if has_subdir {
        return Err(format!(
            "アルバム「{name}」の中にフォルダがあります。先に中身を移動してください。"
        ));
    }
    if !others.is_empty() {
        let sample = others
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join("、");
        let more = if others.len() > 3 {
            format!(" ほか{}件", others.len() - 3)
        } else {
            String::new()
        };
        return Err(format!(
            "アルバム「{name}」に作品以外のファイルが残っています（{sample}{more}）。中身を確認してから削除してください。"
        ));
    }
    // 作品0件・未知のファイルなし → アプリ由来の付属物ごと削除する
    for p in sidecars {
        let pc = p
            .canonicalize()
            .map_err(|e| format!("付属ファイル確認失敗: {e}"))?;
        if !pc.starts_with(&dir_c) {
            return Err("アルバム外を指すファイルがあるため削除できません".into());
        }
        fs::remove_file(&pc).map_err(|e| format!("削除失敗: {e}"))?;
    }
    fs::remove_dir(&dir_c).map_err(|e| format!("削除失敗: {e}"))
}

/// M11-3: プロジェクト（.memoanima/.animemo）を別アルバムへ移動する。戻り値は移動後のフルパス。
///
/// `move_note` はハッシュ索引に載るノート専用なので、索引外のプロジェクト用に新設した。
/// - **サイドカーサムネ `<ファイル名>.png` も一緒に移動する。** 置き去りにすると移動先で
///   サムネが消え、移動元に孤児PNGが残って**アルバムを削除できなくなる**（M11-1 で直した症状の再発）
/// - 同名衝突は `unique_dest`（既存の作法）で回避し、**PNGの名前も確定した本体名に合わせる**
///   （V201 P-2: 移した先の名前は `unique_project_dest`＝本体と控え（`.bak`）の**どちらも無い**名前）
/// - **V201 (P-2): 控え（`<ファイル名>.bak`）も一緒に移す。** 置き去りにすると元のアルバムに知らないファイルが残って
///   **アルバムを削除できず**（`delete_album`）、作品が無くなったかのように復元の候補にも出ていた（`scan_recoverable`）
/// - `project_order` のキー（`album/name`）を新しいキーへ付け替える（`rename_album` と同じ流儀）
/// - 失敗時は**何も動いていない状態へ戻す**（本体 rename 後に PNG・控えで失敗したら、動かした分を戻す）
/// - 封じ込め: canonicalize + starts_with で lib_root 配下のみ（`delete_item` と同じ作法）
pub fn move_project(
    lib_root: &str,
    album: &str,
    name: &str,
    dest_album: &str,
) -> Result<String, String> {
    move_project_with(lib_root, album, name, dest_album, |a, b| fs::rename(a, b))
}

/// `move_project` の本体。`rename` は動かす 1 手（本物は `fs::rename`。テストが「控えだけ動かせない」を差し込む）
fn move_project_with(
    lib_root: &str,
    album: &str,
    name: &str,
    dest_album: &str,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<String, String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let lib_c = lib
        .canonicalize()
        .map_err(|e| format!("ライブラリ確認失敗: {e}"))?;
    let album_s = validate_album(album)?;
    let dest_s = validate_album(dest_album)?;
    let name_s = sanitize_component(name);
    let ext_ok = Path::new(&name_s)
        .extension()
        .and_then(|e| e.to_str())
        .map(is_project_ext)
        .unwrap_or(false);
    if !ext_ok {
        return Err("プロジェクト（.memoanima / .animemo）以外は移動できません".into());
    }
    // 対象パスはフロントの path を信用せず album/name から組み立てる（delete_item と同じ）
    let src_c = lib
        .join(&album_s)
        .join(&name_s)
        .canonicalize()
        .map_err(|e| format!("対象確認失敗: {e}"))?;
    if !src_c.starts_with(&lib_c) {
        return Err("ライブラリ外のファイルは移動できません".into());
    }
    if !src_c.is_file() {
        return Err("移動対象がファイルではありません".into());
    }
    if album_s == dest_s {
        // 同じアルバム＝何もしない。**戻り値は scan_library と同じ形式**にする
        //（canonicalize 産物は Windows で `\\?\` 付きになり、フロントの path 比較が
        //   必ず外れる — レビュー検出）
        return Ok(lib.join(&album_s).join(&name_s).to_string_lossy().to_string());
    }
    let dest_dir = lib.join(&dest_s);
    fs::create_dir_all(&dest_dir).map_err(|e| format!("移動先フォルダ作成失敗: {e}"))?;
    let dest_dir_c = dest_dir
        .canonicalize()
        .map_err(|e| format!("移動先確認失敗: {e}"))?;
    if !dest_dir_c.starts_with(&lib_c) {
        return Err("ライブラリ外へは移動できません".into());
    }
    // V201 (P-2): 本体と控え（.bak）のどちらも無い名前（unique_dest は取り込みと move_note も使うので変えない）
    let dest = unique_project_dest(&dest_dir_c, &name_s);

    // 1) 本体を移動
    rename(&src_c, &dest).map_err(|e| format!("移動失敗: {e}"))?;
    let dest_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&name_s)
        .to_string();

    // 2) サイドカーPNG（無ければ何もしない。失敗したら本体を戻して「何も起きていない」状態へ）
    let src_png = with_suffix(&src_c, ".png");
    let dest_png = with_suffix(&dest, ".png");
    let moved_png = src_png.is_file();
    if moved_png {
        if let Err(e) = rename(&src_png, &dest_png) {
            // 戻しにも失敗したら「取り消しました」と嘘をつかない（実際の在り処を伝える）
            return Err(match rename(&dest, &src_c) {
                Ok(_) => format!("サムネイルの移動に失敗（移動を取り消しました）: {e}"),
                Err(e2) => format!(
                    "サムネイルの移動に失敗し、取り消しにも失敗しました。作品は「{dest_s}」にあります（{e} / {e2}）"
                ),
            });
        }
    }

    // 2b) V201 (P-2): 控え（.bak）も一緒に（無ければ何もしない）。移した先の名前は本体に合わせる（unique_project_dest が
    //     その名前の控えも無いことを確かめてある＝移した先の控えを置き換えない）。失敗したら PNG と本体を戻す
    let src_bak = with_suffix(&src_c, ".bak");
    if src_bak.is_file() {
        let dest_bak = with_suffix(&dest, ".bak");
        if let Err(e) = rename(&src_bak, &dest_bak) {
            let png_back = if moved_png { rename(&dest_png, &src_png) } else { Ok(()) };
            let body_back = rename(&dest, &src_c);
            // 作品（本体）の在り処は、本体を戻せたかで決める（サムネだけ戻せなかったときに「移動先にある」と言わない・独立レビューの指摘 R2）
            return Err(match (png_back, body_back) {
                (Ok(_), Ok(_)) => format!("控え（.bak）の移動に失敗（移動を取り消しました）: {e}"),
                (Err(e2), Ok(_)) => format!(
                    "控え（.bak）の移動に失敗しました。作品は元の「{album_s}」に戻しましたが、サムネイルは「{dest_s}」に残っています（{e} / {e2}）"
                ),
                (a, Err(e3)) => format!(
                    "控え（.bak）の移動に失敗し、取り消しにも失敗しました。作品は「{dest_s}」にあります（{e} / {} / {e3}）",
                    a.err().map(|x| x.to_string()).unwrap_or_default()
                ),
            });
        }
    }

    // 3) 表示順のキーを付け替える（rename_album と同じ remove→insert）
    let mut index = load_index(lib)?;
    let old_key = format!("{album_s}/{name_s}");
    let new_key = format!("{dest_s}/{dest_name}");
    let old_order = index.project_order.remove(&old_key);
    // 移動先に同名キーの残骸（アプリ外で消された作品の分など）があれば、その順序を
    // 引き継がないよう必ず捨てる
    let had_stale = index.project_order.remove(&new_key).is_some();
    if let Some(v) = old_order {
        index.project_order.insert(new_key, v);
    }
    if old_order.is_some() || had_stale {
        save_index(lib, &index)?;
    }
    // 戻り値は scan_library の path と同じ形式（生の lib_root からの join）にする
    Ok(lib
        .join(&dest_s)
        .join(&dest_name)
        .to_string_lossy()
        .to_string())
}

/// V201 (P-2): `move_project` の移した先の名前。`unique_dest` と同じ付け方（`名前-1.ext`, `名前-2.ext` …）で、
/// **本体と控え（`<名前>.bak`）のどちらも無い**名前を選ぶ（控えだけが残った名前＝復元の候補を、黙って置き換えない）。
/// 在るかは `path_taken`（壊れたリンク・同じ名前のフォルダも「在る」）
fn unique_project_dest(dir: &Path, name: &str) -> PathBuf {
    let free = |p: &Path| !path_taken(p) && !path_taken(&with_suffix(p, ".bak"));
    let first = dir.join(name);
    if free(&first) {
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
        if free(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

/// パスの後ろに文字を足す（`a.memoanima` → `a.memoanima.png`／`.bak`）
fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
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
    // ★V216b (A-131): 元のアルバムと行き先のアルバムの両方（リンクで外を指すなら動かさない）
    if let Some(src_dir) = src.parent() {
        ensure_album_inside(lib, src_dir)?;
    }
    ensure_album_inside(lib, &dest_dir)?;
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
///
/// ★V216b (A-126): これは**同じ名前が在れば確かめずに置き換える**今までの形（`SaveMode::Replace`）。
///  **画面の命令からは呼ばない**（`save_project_raw`・古い `save_project` 命令は `save_project_checked` を通る）。
///  残すのは Rust の試し・例（examples/）が「置き換える」を前提に書かれているため
pub fn save_project(
    lib_root: &str,
    album: &str,
    name: &str,
    data: &[u8],
    thumb_png: &[u8],
) -> Result<String, String> {
    save_project_impl(lib_root, album, name, ProjectSource::Bytes(data), thumb_png)
}

/// V216b (A-126): 保存の命令が渡す決まり（要件 docs/REQ_prerelease_fixes_v2_0_0.md §2-1）。
/// - `work_file`: その作品のファイル（ライブラリで開いた `.memoanima`・前に保存したファイル）。宛先がこれと同じなら確かめずに上書き
/// - `allow_replace`: 画面で［置き換える］を選んだ（確かめた宛先とその 1 回の書き込みだけ）
/// どちらでもなければ**置き換えない**（在れば `SAVE_EXISTS_TAKEN`／控えだけなら `SAVE_EXISTS_RESERVED` で断る）
#[derive(Debug, Clone, Copy, Default)]
pub struct SaveGuard<'a> {
    pub work_file: Option<&'a str>,
    pub allow_replace: bool,
}

/// V216b: 書く所で「在る」と断ったときの文（画面がこの字で見分けて、もう一度確かめを出す。パスを入れない＝W-10）
pub const SAVE_EXISTS_TAKEN: &str = "save-exists:taken";
pub const SAVE_EXISTS_RESERVED: &str = "save-exists:reserved";

/// V216b (A-126): 画面の保存（`save_project_raw`）と古い `save_project` 命令が通る保存。決まりは `SaveGuard`
pub fn save_project_checked(
    lib_root: &str,
    album: &str,
    name: &str,
    data: &[u8],
    thumb_png: &[u8],
    guard: SaveGuard,
) -> Result<String, String> {
    save_project_core(
        lib_root,
        album,
        name,
        ProjectSource::Bytes(data),
        thumb_png,
        SaveMode::Checked(guard),
        write_project_tmp,
        |a, b| fs::hard_link(a, b),
        move_noreplace,
    )
}

/// M10-16: ドロップ取り込み用 — **元ファイル（src_path）を Rust 側で読み、ライブラリへ直接書く**。
/// src_path は読み取り専用（fs::copy で読むだけ。移動・削除・書き込みしない）。
/// 書き込み先の組み立て・サニタイズ・サムネ規約は save_project と同じ
/// （validate_album / sanitize_component が lib 配下にしかパスを組めない＝封じ込めも同一）。
/// ★V216b (A-126 §2-1 の 7): **在る作品を置き換えない**。名前が「在る」「控えだけ」なら、次の空いた名前
///  （`名前 (2)`〜）を**ここで**決める（画面の名前の整え方と食い違っても置き換えない＝C-8）。戻り値は書いたパス
pub fn import_project_file(
    lib_root: &str,
    album: &str,
    name: &str,
    src_path: &str,
    thumb_png: &[u8],
) -> Result<String, String> {
    import_project_file_with(lib_root, album, name, src_path, thumb_png, |a, b| fs::hard_link(a, b))
}

fn import_project_file_with(
    lib_root: &str,
    album: &str,
    name: &str,
    src_path: &str,
    thumb_png: &[u8],
    link: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<String, String> {
    let src = Path::new(src_path);
    if !src.is_file() {
        return Err(format!("取り込み元が見つかりません: {src_path}"));
    }
    save_project_core(
        lib_root,
        album,
        name,
        ProjectSource::File(src),
        thumb_png,
        SaveMode::NextFree,
        write_project_tmp,
        link,
        move_noreplace,
    )
}

fn save_project_impl(
    lib_root: &str,
    album: &str,
    name: &str,
    src: ProjectSource,
    thumb_png: &[u8],
) -> Result<String, String> {
    save_project_impl_with(lib_root, album, name, src, thumb_png, write_project_tmp)
}

/// V216b (A-126): 保存の決まり。`Replace`＝今までの上書き（Rust の試し・例だけ）／`Checked`＝画面の保存／
/// `NextFree`＝取り込み（在れば次の空いた名前へ）
#[derive(Clone, Copy)]
enum SaveMode<'a> {
    Replace,
    Checked(SaveGuard<'a>),
    NextFree,
}

/// `save_project_impl` の本体。`write_tmp` は一時ファイルを作る 1 手（本物は `write_project_tmp`）。
/// V201 (P-4): テストが「書いている途中で失敗する」を差し込めるように口を開けた（前例は `create_project_with` の確定の 1 手）
fn save_project_impl_with(
    lib_root: &str,
    album: &str,
    name: &str,
    src: ProjectSource,
    thumb_png: &[u8],
    write_tmp: impl Fn(&Path, &ProjectSource) -> std::io::Result<()>,
) -> Result<String, String> {
    save_project_core(
        lib_root,
        album,
        name,
        src,
        thumb_png,
        SaveMode::Replace,
        write_tmp,
        |a, b| fs::hard_link(a, b),
        move_noreplace,
    )
}

/// V216b (A-126): 保存と取り込みの本体。`link`・`mv` は置き換えない確定の 2 手（本物は `fs::hard_link`・`move_noreplace`。
/// テストが「ハードリンクを作れない」「その間に同じ名前ができる」を差し込む）
#[allow(clippy::too_many_arguments)]
fn save_project_core(
    lib_root: &str,
    album: &str,
    name: &str,
    src: ProjectSource,
    thumb_png: &[u8],
    mode: SaveMode,
    write_tmp: impl Fn(&Path, &ProjectSource) -> std::io::Result<()>,
    link: impl Fn(&Path, &Path) -> std::io::Result<()>,
    mv: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<String, String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if !lib.is_dir() {
        return Err(format!("ライブラリフォルダが見つかりません: {lib_root}"));
    }
    let album_s = validate_album(album)?;
    // V198: 名前の組み立ては project_file_name と同じ（V216b で 1 つに寄せた。v198_tests::same_path_as_save が見張る）
    let mut file = project_file_name(name);
    let dir = lib.join(&album_s);
    ensure_album_inside(lib, &dir)?; // V216b (A-131): 保存と .memoanima の取り込み
    fs::create_dir_all(&dir).map_err(|e| format!("アルバムフォルダ作成失敗: {e}"))?;
    let mut dest = dir.join(&file);
    // ★V216b (A-126): 置き換えてよいか（ロックの中で決める）。置き換えないときは「空き」のときだけ、置き換えない確定で書く
    match mode {
        SaveMode::Replace => {}
        SaveMode::Checked(g) => {
            let st = name_status(&dest, g.work_file.map(Path::new));
            match st {
                NameStatus::Own => {}
                // 控えだけの名前は［置き換える］でも書かない（控え＝元に戻す前の作品を消さない・要件 §2-1 の 4）
                NameStatus::Reserved => return Err(SAVE_EXISTS_RESERVED.into()),
                NameStatus::Taken if g.allow_replace => {}
                NameStatus::Taken => return Err(SAVE_EXISTS_TAKEN.into()),
                NameStatus::Free if g.allow_replace => {}
                NameStatus::Free => {
                    return match place_new_project(&dir, &dest, &file, &src, &write_tmp, &link, &mv)? {
                        Placed::Created => {
                            write_thumb(&dir, &file, thumb_png);
                            Ok(dest.to_string_lossy().to_string())
                        }
                        Placed::Exists(NameStatus::Reserved) => Err(SAVE_EXISTS_RESERVED.into()),
                        Placed::Exists(_) => Err(SAVE_EXISTS_TAKEN.into()),
                    };
                }
            }
        }
        SaveMode::NextFree => {
            // 取り込み: 在る・控えだけの名前は飛ばして `名前 (2)`〜（確定で在ると分かったら次へ）
            let mut k = 1u32;
            loop {
                if name_status(&dest, None) == NameStatus::Free {
                    if let Placed::Created = place_new_project(&dir, &dest, &file, &src, &write_tmp, &link, &mv)? {
                        write_thumb(&dir, &file, thumb_png);
                        return Ok(dest.to_string_lossy().to_string());
                    }
                }
                k += 1;
                if k > NEXT_FREE_MAX {
                    return Err("空いている名前が見つかりません".into());
                }
                file = project_file_name(&format!("{name} ({k})"));
                dest = dir.join(&file);
            }
        }
    }
    // 一意な一時名に書き、バックアップ経由で置換（rename失敗時も旧ファイルを失わない）
    let tmp = dir.join(format!(
        "{file}.{}-{}.tmp",
        now_unix(),
        TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    if let Err(e) = write_tmp(&tmp, &src) {
        // ★V201 (P-4): 書いている途中で失敗したら（空きが無い等）、書きかけの一時ファイルを消す（前は ? で抜けて残っていた）
        remove_tmp(&tmp);
        return Err(format!("保存失敗: {e}"));
    }
    // V154 (W-1): 確定の3手順は `commit_replace` へ集約した（**`.bak` は残す**）
    commit_replace(&dir, &dest, &tmp)?;
    // V154 (W-6): 書いたものを読み戻して確かめる。違っていたら前の版へ戻して Err にする。
    // 取り込み（ProjectSource::File）は元ファイルを丸ごともう1回読むことになるので、
    // **長さの一致だけ**見る（こちらは「編集して保存」ではなく複製で、事故の経路でもない）
    match src {
        ProjectSource::Bytes(data) => verify_or_rollback(&dir, &dest, data)?,
        ProjectSource::File(p) => {
            let want = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let got = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            if want != got {
                return Err(rollback_to_bak(
                    &dir,
                    &dest,
                    &format!("長さが違います（元 {want} / 読めた {got}）"),
                ));
            }
        }
    }
    write_thumb(&dir, &file, thumb_png);
    Ok(dest.to_string_lossy().to_string())
}

/// サイドカーサムネ（`<file>.png`）を書く（失敗は捨てる＝今までと同じ）。**作品を書けたときだけ**呼ぶ
fn write_thumb(dir: &Path, file: &str, thumb_png: &[u8]) {
    if !thumb_png.is_empty() {
        let _ = fs::write(dir.join(format!("{file}.png")), thumb_png);
    }
}

/// V216b (A-126): 取り込みが `名前 (k)` を探す上限（普通は 2 で空く。壊れた環境で回り続けない）
const NEXT_FREE_MAX: u32 = 10_000;

/// V216b (A-126・要件 §2-1 の 4): 保存先の名前の空き。
/// `Own`＝その作品のファイル（確かめを出さない）／`Taken`＝本体が在る／`Reserved`＝本体が無く `.bak`（元に戻す前の作品）か
/// `.gz`（名前に .gz が付いた作品）が在る／`Free`＝どれも無い
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NameStatus {
    Own,
    Taken,
    Reserved,
    Free,
}

/// 宛先の空き。在るかは `path_taken`（壊れたリンク・同じ名前のフォルダも在る）。
/// その作品のファイルとの比べは**パスの要素の一致**だけ（大文字と小文字だけ違う・別の書き方は「違う」＝確かめが出る側）
fn name_status(dest: &Path, work_file: Option<&Path>) -> NameStatus {
    if work_file.is_some_and(|w| w == dest) {
        return NameStatus::Own;
    }
    if path_taken(dest) {
        NameStatus::Taken
    } else if path_taken(&with_suffix(dest, ".bak")) || path_taken(&with_suffix(dest, GZ_SUFFIX)) {
        NameStatus::Reserved
    } else {
        NameStatus::Free
    }
}

/// V216b (A-126): 画面が書く前に引く空きの判定（読むだけ・フォルダも作らない）。名前は保存と同じ決め方（`project_file_name`）
pub fn save_target_status(
    lib_root: &str,
    album: &str,
    name: &str,
    work_file: Option<&str>,
) -> Result<NameStatus, String> {
    let lib = Path::new(lib_root);
    if lib_root.is_empty() || !lib.is_dir() {
        return Err("ライブラリフォルダが見つかりません".into());
    }
    let dest = lib.join(validate_album(album)?).join(project_file_name(name));
    Ok(name_status(&dest, work_file.map(Path::new)))
}

/// V216b (A-126・要件 §2-1 の 3・6): 空いている名前の案。`name` が空きならそのまま、そうでなければ `name (2)`〜で最初の空き。
/// その作品のファイルも「空き」ではない（別の名前で保存の案は別の名前にする）。読むだけ
pub fn free_project_name(lib_root: &str, album: &str, name: &str) -> Result<String, String> {
    let lib = Path::new(lib_root);
    if lib_root.is_empty() || !lib.is_dir() {
        return Err("ライブラリフォルダが見つかりません".into());
    }
    let dir = lib.join(validate_album(album)?);
    if name_status(&dir.join(project_file_name(name)), None) == NameStatus::Free {
        return Ok(name.to_string());
    }
    for k in 2..=NEXT_FREE_MAX {
        let cand = format!("{name} ({k})");
        if name_status(&dir.join(project_file_name(&cand)), None) == NameStatus::Free {
            return Ok(cand);
        }
    }
    Err("空いている名前が見つかりません".into())
}

/// V216b (A-126・要件 §2-1 の 8): その作品のファイルの大きさと更新時刻（オートセーブの印に控え、戻すときに比べる）。
/// ライブラリの中の作品のファイル（`.memoanima`）だけに答える（ほかは None）。パスは返さない
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct WorkFileStamp {
    pub size: u64,
    /// 更新時刻（UNIX のマイクロ秒。JS の数で正確に持てる範囲）
    pub mtime_us: u64,
}

pub fn work_file_stamp(lib_root: &str, path: &str) -> Option<WorkFileStamp> {
    let lib = Path::new(lib_root);
    if lib_root.is_empty() || !lib.is_dir() {
        return None;
    }
    let p = Path::new(path);
    let ext_ok = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(PROJECT_EXT));
    if !ext_ok {
        return None;
    }
    let meta = fs::symlink_metadata(p).ok()?;
    if !meta.is_file() {
        return None;
    }
    let lib_c = lib.canonicalize().ok()?;
    let p_c = p.canonicalize().ok()?;
    if !p_c.starts_with(&lib_c) {
        return None;
    }
    let mtime_us = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_micros()
        .min(u64::MAX as u128) as u64;
    Some(WorkFileStamp { size: meta.len(), mtime_us })
}

/// V216b: 置き換えない確定の結果。`Exists` はその時点の空き（`Taken`／`Reserved`）
enum Placed {
    Created,
    Exists(NameStatus),
}

/// V216b (A-126・要件 §2-1 の 5): 一時ファイル（`create_new`）に書いて**確定の前に**照合し、置き換えずに名前を付ける。
/// ロックの中で呼ぶ。どの抜け方でも一時ファイルの名前を消す
fn place_new_project(
    dir: &Path,
    dest: &Path,
    file: &str,
    src: &ProjectSource,
    write_tmp: &impl Fn(&Path, &ProjectSource) -> std::io::Result<()>,
    link: &impl Fn(&Path, &Path) -> std::io::Result<()>,
    mv: &impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<Placed, String> {
    let tmp = dir.join(format!(
        "{file}.{}-{}.tmp",
        now_unix(),
        TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let r = place_new_inner(dir, &tmp, dest, src, write_tmp, link, mv);
    // hard_link のあとも一時ファイルの名前は残る＝消す（移したあと・断ったあとは無い＝消せたことにする）
    remove_tmp(&tmp);
    r
}

fn place_new_inner(
    dir: &Path,
    tmp: &Path,
    dest: &Path,
    src: &ProjectSource,
    write_tmp: &impl Fn(&Path, &ProjectSource) -> std::io::Result<()>,
    link: &impl Fn(&Path, &Path) -> std::io::Result<()>,
    mv: &impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<Placed, String> {
    // 一時ファイルは create_new で作ってから書く（同じ名前の残骸に書き足さない）
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)
        .map_err(|e| format!("保存失敗: {e}"))?;
    write_tmp(tmp, src).map_err(|e| format!("保存失敗: {e}"))?;
    // 照合は確定の前（新しいファイルには戻す版が無いので、作る前に止める＝create_from_tmp と同じ）
    match src {
        ProjectSource::Bytes(data) => {
            let got = fs::read(tmp).map_err(|e| format!("保存を確認できませんでした（読み戻せません）: {e}"))?;
            if got.len() != data.len() {
                return Err(format!(
                    "保存できませんでした（長さが違います（書いた {} / 読めた {}））",
                    data.len(),
                    got.len()
                ));
            }
            if got != *data {
                return Err("保存できませんでした（中身が違います）".into());
            }
        }
        ProjectSource::File(p) => {
            let want = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let got = fs::metadata(tmp).map(|m| m.len()).unwrap_or(0);
            if want != got {
                return Err(format!("保存できませんでした（長さが違います（元 {want} / 読めた {got}））"));
            }
        }
    }
    match link(tmp, dest) {
        Ok(()) => return Ok(Placed::Created),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(Placed::Exists(NameStatus::Taken)),
        Err(_) => {}
    }
    // ハードリンクを作れない（exFAT など）: ロックの中でもう一度見て、空きのときだけ置き換えない移し方 → だめなら今の確定
    let st = name_status(dest, None);
    if st != NameStatus::Free {
        return Ok(Placed::Exists(st));
    }
    match mv(tmp, dest) {
        Ok(()) => return Ok(Placed::Created),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(Placed::Exists(NameStatus::Taken)),
        Err(_) => {}
    }
    let st = name_status(dest, None);
    if st != NameStatus::Free {
        return Ok(Placed::Exists(st));
    }
    // 空きのまま＝今の確定（`fs::rename` を直に使わない。宛先が無いので退避は起きない）
    commit_replace(dir, dest, tmp)?;
    Ok(Placed::Created)
}

/// V216b: 置き換えない移し方（Windows は `MoveFileExW` を置き換えの印なしで＝宛先が在れば OS が断る。
/// `pclib/mobile/place.rs` の Windows の枝と同じ。ほかの OS では使えない＝`Unsupported`）
fn move_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }
        let w = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(std::iter::once(0)).collect() };
        let (f, t) = (w(from), w(to));
        // flags = 0: 置き換えない（ERROR_ALREADY_EXISTS／ERROR_FILE_EXISTS＝AlreadyExists）・別のボリュームへ写さない
        let ok = unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), 0) };
        if ok != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (from, to);
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no-replace move unavailable"))
    }
}

/// 一時ファイルを作る（Bytes＝書く／File＝写して、読み取り専用の印を外す）。
/// V201 (P-4) で `save_project_impl` から切り出した（中身は同じ）
fn write_project_tmp(tmp: &Path, src: &ProjectSource) -> std::io::Result<()> {
    match src {
        ProjectSource::Bytes(data) => fs::write(tmp, data),
        ProjectSource::File(p) => {
            fs::copy(p, tmp)?;
            // fs::copy は読み取り専用属性まで複製する。ライブラリ側のファイルは
            // 従来の fs::write と同じ「普通に書けるファイル」であるべきなので外す
            if let Ok(meta) = fs::metadata(tmp) {
                let mut perm = meta.permissions();
                if perm.readonly() {
                    perm.set_readonly(false);
                    let _ = fs::set_permissions(tmp, perm);
                }
            }
            Ok(())
        }
    }
}

/// V198 (A-104 E-2): 保存の書き先と**同じ決め方**のファイル名（`save_project_impl` の名前の組み立てと同じ規則）。
/// 旧拡張子 `.animemo` の名前は `.memoanima` に付け替え、拡張子が無ければ `.memoanima` を足す。
/// ★`save_project_impl` そのものは触らない（保存の道を変えない）。ずれていないことは下の単体テスト
/// `v198_tests::same_path_as_save` が、本物の `save_project` が返したパスと突き合わせて見張る
fn project_file_name(name: &str) -> String {
    let file = sanitize_component(name);
    let lower = file.to_ascii_lowercase();
    if let Some(stem) = lower
        .strip_suffix(&format!(".{PROJECT_EXT_LEGACY}"))
        .map(|s| s.len())
    {
        format!("{}.{PROJECT_EXT}", &file[..stem])
    } else if !lower.ends_with(&format!(".{PROJECT_EXT}")) {
        format!("{file}.{PROJECT_EXT}")
    } else {
        file
    }
}

/// V198 (A-104 E-2): 作品の `.memoanima`（保存すると書かれる場所）が**いまライブラリの中に在れば**そのパス。
/// 書き出しのあとの「保存先を開く」を出すか・開くかに使う。**読むだけ**（フォルダも作らない）。
/// 封じ込め: canonicalize して lib_root の配下のときだけ（`delete_item` と同じ作法）。
/// 返すのは canonicalize 前の形（Windows の `\\?\` を付けない）。パスはフロントへ返さない（lib.rs の命令が使うだけ）
pub fn existing_project_file(lib_root: &str, album: &str, name: &str) -> Option<PathBuf> {
    let lib = Path::new(lib_root);
    if lib_root.is_empty() || !lib.is_dir() {
        return None;
    }
    let album_s = validate_album(album).ok()?;
    let dest = lib.join(&album_s).join(project_file_name(name));
    if !dest.is_file() {
        return None;
    }
    let lib_c = lib.canonicalize().ok()?;
    let dest_c = dest.canonicalize().ok()?;
    if !dest_c.starts_with(&lib_c) {
        return None;
    }
    Some(dest)
}

/// V200 (A-100): まとめ変換（アルバムの .kwz／.ppm → .memoanima）で 1 件を作った結果。
/// `created == false` は「同じ名前がもう在ったので作らなかった」（上書きしない）。`path` は作ったときだけ。
/// `tmp_left` は「作れたが、一時ファイルの名前を消せなかった」（中身は作ったファイルと同じ。フロントがログに 1 行残す）
#[derive(Debug, Serialize)]
pub struct CreateProjectResult {
    pub created: bool,
    pub path: String,
    pub tmp_left: bool,
}

/// V200 (A-100): その名前の `.memoanima` が**もう在るか**を名前ごとに返す（まとめ変換の確認の件数）。**読むだけ**。
/// 名前の決め方は保存と同じ（`project_file_name`）。在るかは `path_taken`（壊れたリンク・同じ名前のフォルダも「在る」）。
/// ★V216b (A-129・C-1): 本体が無くても、控え（`.bak`＝元に戻す前の作品）か `.gz`（名前に .gz が付いた作品）だけが在る名前も
///  「使われている」（`name_status` が Free でない）。作らずに飛ばす＝今の「同じ名前があったので飛ばしました」に数える
/// 断りの文にパスを入れない（W-10）
pub fn projects_taken(lib_root: &str, album: &str, names: &[String]) -> Result<Vec<bool>, String> {
    let lib = Path::new(lib_root);
    if lib_root.is_empty() || !lib.is_dir() {
        return Err("ライブラリフォルダが見つかりません".into());
    }
    let dir = lib.join(validate_album(album)?);
    Ok(names
        .iter()
        .map(|n| name_status(&dir.join(project_file_name(n)), None) != NameStatus::Free)
        .collect())
}

/// V200 (A-100): **新しい** `.memoanima` を作る（まとめ変換の 1 件）。同じ名前が在れば**作らない**（`created: false`）。
///
/// 保存（`save_project_impl`）と同じもの: ロック・名前の決め方（`project_file_name`）・一時ファイルの名前
/// （`<file>.<秒>-<連番>.tmp`）・書いた中身の照合・サイドカーサムネ（`<file>.png`）。
/// 違うのは**確定の 1 手**と照合の位置だけ:
/// - 保存の確定（`commit_replace`）は在るファイルを `.bak` へ退けて**置き換える**。ここは置き換えない:
///   **`hard_link`（宛先が在れば OS が必ず断る＝原子的）→ 一時ファイルの名前を消す**の 2 手
///   （V173 の `fix_renamed_projects` と同じ。`fs::rename` は宛先を黙って置き換えるので**どの道でも使わない**）
/// - 照合は**確定の前**（一時ファイルを読み戻す）。違えば一時ファイルを消して Err＝`<名前>.memoanima` は一度もできない
///   （保存は確定のあとに照合して `.bak` へ戻すが、新しいファイルには戻す版が無いので、作る前に止める）
/// - アルバムのフォルダは作らない（無ければ Err。変換の途中で消された・名前を変えられたアルバムを作り直さない）
/// - ハードリンクを作れないファイルシステム（FAT32 / exFAT など）では**作らずに Err**（V173 と同じ決まり。
///   「確かめてから rename」は、その一瞬にアプリの外（同期クライアントなど）で同じ名前ができると置き換えてしまう）。
///   フロントは「作れませんでした」に数え、理由をログに残す
/// - **どの抜け方でも一時ファイルを消す**（作りかけを残さない・要件 §5 ③）。消せなかったら `tmp_left`
/// 断りの文にパスを入れない（W-10）
pub fn create_project(
    lib_root: &str,
    album: &str,
    name: &str,
    data: &[u8],
    thumb_png: &[u8],
) -> Result<CreateProjectResult, String> {
    create_project_with(lib_root, album, name, data, thumb_png, |a, b| fs::hard_link(a, b))
}

/// `create_project` の本体。`link` は確定の 1 手（本物は `fs::hard_link`。テストがハードリンクを作れない
/// ファイルシステムの断り方を差し込む）
fn create_project_with(
    lib_root: &str,
    album: &str,
    name: &str,
    data: &[u8],
    thumb_png: &[u8],
    link: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<CreateProjectResult, String> {
    let _guard = lock_lib();
    let lib = Path::new(lib_root);
    if lib_root.is_empty() || !lib.is_dir() {
        return Err("ライブラリフォルダが見つかりません".into());
    }
    let dir = lib.join(validate_album(album)?);
    if !dir.is_dir() {
        return Err("アルバムフォルダが見つかりません".into());
    }
    ensure_album_inside(lib, &dir)?; // V216b (A-131)
    let file = project_file_name(name);
    let dest = dir.join(&file);
    // 安い門番（在れば書きもしない）。本当の保証は create_from_tmp の hard_link
    // ★V216b (A-129): 控え・.gz だけの名前も作らない（作ると控えは元に戻す候補から外れ、次の保存で消える＝C-1）
    if name_status(&dest, None) != NameStatus::Free {
        return Ok(CreateProjectResult {
            created: false,
            path: String::new(),
            tmp_left: false,
        });
    }
    let tmp = dir.join(format!(
        "{file}.{}-{}.tmp",
        now_unix(),
        TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let outcome = create_from_tmp(&tmp, &dest, data, link);
    // どの抜け方でも一時ファイルの名前を消す（hard_link のあとは実体が dest に残る）
    let tmp_left = !remove_tmp(&tmp);
    if !outcome? {
        return Ok(CreateProjectResult {
            created: false,
            path: String::new(),
            tmp_left,
        });
    }
    if !thumb_png.is_empty() {
        let _ = fs::write(dir.join(format!("{file}.png")), thumb_png);
    }
    Ok(CreateProjectResult {
        created: true,
        path: dest.to_string_lossy().to_string(),
        tmp_left,
    })
}

/// V200: 一時ファイルに書いて読み戻して照合し、**置き換えずに**確定する。Ok(true)=作った／Ok(false)=もう在った。
/// 一時ファイルの後始末は呼び出し側（`remove_tmp`）
fn create_from_tmp(
    tmp: &Path,
    dest: &Path,
    data: &[u8],
    link: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<bool, String> {
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(tmp)
            .map_err(|e| format!("保存失敗: {e}"))?;
        f.write_all(data).map_err(|e| format!("保存失敗: {e}"))?;
        // 確定の前にディスクへ（できないファイルシステムでも作ること自体は止めない）
        let _ = f.sync_all();
    }
    let got = fs::read(tmp).map_err(|e| format!("保存を確認できませんでした（読み戻せません）: {e}"))?;
    if got.len() != data.len() {
        return Err(format!(
            "保存できませんでした（長さが違います（書いた {} / 読めた {}））",
            data.len(),
            got.len()
        ));
    }
    if got != data {
        return Err("保存できませんでした（中身が違います）".into());
    }
    match link(tmp, dest) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        // ハードリンクを作れない（FAT32 / exFAT など）ほかの失敗も、置き換えの道へは行かない（V173 と同じ）
        Err(e) => Err(format!("link failed: {e}")),
    }
}

/// V200: 一時ファイルの名前を消す。消せた（か初めから無い）なら true。
/// ウイルス対策などが一瞬つかんでいることがあるので 3 回まで。
/// V201 (P-4): 保存（`save_project_impl_with`）とオートセーブ（lib.rs の `atomic_replace_with`）の書きかけの後始末にも使う
pub(crate) fn remove_tmp(tmp: &Path) -> bool {
    for _ in 0..3 {
        match fs::remove_file(tmp) {
            Ok(()) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(30)),
        }
    }
    false
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
/// 設計（独立レビューの反映）:
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
        let mut side = tgt_c.clone().into_os_string();
        side.push(".png");
        let _ = fs::remove_file(PathBuf::from(side));
    }
    // 4) V154（要件 §2-b ⑤）: 保存の控え（`.bak`）と保存途中の残骸（`.tmp`）も片づける。
    //    W-1 で `.bak` を残す運用にしたので、これが無いと**消した作品の控えが残り続け**、
    //    起動時の復元プロンプトが「削除した作品を復元しますか？」と誤爆する。
    //    **本体削除が成功した後**に、サムネと同じ「失敗してもエラーにしない」扱いで行う
    //    （索引ロールバックの順序＝索引先行・本体・ロールバックには触れない）。
    {
        let mut bak = tgt_c.clone().into_os_string();
        bak.push(".bak");
        let _ = fs::remove_file(PathBuf::from(bak));
        if let (Some(parent), Some(fname)) = (tgt_c.parent(), tgt_c.file_name().and_then(|n| n.to_str())) {
            if let Ok(entries) = fs::read_dir(parent) {
                for ent in entries.flatten() {
                    let p = ent.path();
                    let Some(n) = p.file_name().and_then(|x| x.to_str()) else { continue };
                    if tmp_base_name(n).as_deref() == Some(fname) {
                        let _ = fs::remove_file(&p);
                    }
                }
            }
        }
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

#[cfg(test)]
mod v198_tests {
    use super::*;

    /// 使い捨ての場所（%TEMP% の下）。ライブラリはその中の `lib`、「ライブラリの外」もこの中に作る＝
    /// テストが途中で落ちても、消すのはこのフォルダ 1 つで済む（%TEMP% の直下に何も残さない）
    struct TmpLib {
        base: PathBuf,
        lib: PathBuf,
    }
    impl TmpLib {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "v198-pclib-{tag}-{}-{}",
                std::process::id(),
                TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&base);
            let lib = base.join("lib");
            fs::create_dir_all(&lib).unwrap();
            TmpLib { base, lib }
        }
        fn root(&self) -> &str {
            self.lib.to_str().unwrap()
        }
    }
    impl Drop for TmpLib {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    /// ★「保存先を開く」が指すファイル＝本物の save_project が書いたファイル（名前の決め方がずれていない）
    #[test]
    fn same_path_as_save() {
        let lib = TmpLib::new("same");
        let names = [
            "memo-20261012-1200",
            "作品 A",
            "done.memoanima",
            "Old.animemo",
            "LOUD.ANIMEMO",
            "Mixed.MemoAnima",
            "a:b?c*d",
            "trailing. ",
            "dots.v2",
        ];
        for (i, name) in names.iter().enumerate() {
            let album = if i % 2 == 0 { "アルバム" } else { "a<b" };
            assert!(
                existing_project_file(lib.root(), album, name).is_none(),
                "保存する前から在ることになっている: {name}"
            );
            let saved = save_project(lib.root(), album, name, b"v198", &[]).unwrap();
            let found = existing_project_file(lib.root(), album, name)
                .unwrap_or_else(|| panic!("保存したのに見つからない: {name}"));
            assert_eq!(found, PathBuf::from(&saved), "保存したパスと違う: {name}");
        }
    }

    /// 無いもの・ライブラリの外・フォルダ・空のライブラリは None
    #[test]
    fn none_when_missing_or_outside() {
        let lib = TmpLib::new("none");
        save_project(lib.root(), "al", "x", b"v198", &[]).unwrap();
        assert!(existing_project_file(lib.root(), "al", "x").is_some());
        assert!(existing_project_file(lib.root(), "al", "y").is_none(), "無い作品");
        assert!(existing_project_file(lib.root(), "other", "x").is_none(), "別のアルバム");
        assert!(existing_project_file("", "al", "x").is_none(), "ライブラリ未設定");
        assert!(existing_project_file(lib.root(), ".hidden", "x").is_none(), "隠しフォルダは断る");
        // `..` やパス区切りで外へ出ようとしても、1 つの名前に潰れる（validate_album / sanitize_component）
        // ライブラリのすぐ外（base の直下）に同じ名前の作品を置いておく。返したら外へ出られている
        fs::write(lib.base.join("x.memoanima"), b"outside").unwrap();
        fs::create_dir_all(lib.base.join("al")).unwrap();
        fs::write(lib.base.join("al").join("x.memoanima"), b"outside").unwrap();
        assert!(existing_project_file(lib.root(), "..", "x").is_none(), "`..` で外へ出られる");
        assert!(existing_project_file(lib.root(), "al", "../x").is_none(), "名前の `..` で外へ出られる");
        assert!(existing_project_file(lib.root(), "al", r"..\..\x").is_none(), r"名前の `\` で外へ出られる");
        assert!(existing_project_file(lib.root(), "../al", "x").is_none(), "アルバムの `../` で外へ出られる");
        // 同じ名前のフォルダはファイルではない
        fs::create_dir_all(lib.lib.join("al").join("dir.memoanima")).unwrap();
        assert!(existing_project_file(lib.root(), "al", "dir").is_none(), "フォルダを作品として返す");
        // 消したら None
        fs::remove_file(lib.lib.join("al").join("x.memoanima")).unwrap();
        assert!(existing_project_file(lib.root(), "al", "x").is_none(), "消した作品");
    }

    /// .kwz の名前を渡しても .kwz は返さない（`.memoanima` だけを探す）
    #[test]
    fn never_returns_non_project() {
        let lib = TmpLib::new("kwz");
        fs::create_dir_all(lib.lib.join("al")).unwrap();
        fs::write(lib.lib.join("al").join("note.kwz"), b"kwz").unwrap();
        assert!(existing_project_file(lib.root(), "al", "note.kwz").is_none());
        assert!(existing_project_file(lib.root(), "al", "note").is_none());
    }
}

/// V199 (A-106): 保存の書き先の名前の決め方の表。フロントの `src/editor/workTitle.ts` の `savedFileBase`
/// （保存するときに作品の中の題名 `meta.title` をファイルの名前にそろえる）は、この決め方を写している。
/// ★`scripts/v199_smoke.ts` [T-1] がこの表を**そのまま読んで** `savedFileBase` にも当てる＝両側がずれたら赤。
/// 表に足すときは `("入れた名前", "書かれるファイル名")` の形で（Rust の文字列のエスケープは \ \" \t だけ使う）
#[cfg(test)]
const V199_NAME_CASES: &[(&str, &str)] = &[
    ("あと3日", "あと3日.memoanima"),
    ("150_ひかりのたま", "150_ひかりのたま.memoanima"),
    ("a:b", "a_b.memoanima"),
    ("x<y>z\"q", "x_y_z_q.memoanima"),
    ("pipe|q?star*", "pipe_q_star_.memoanima"),
    ("a/b\\c", "a_b_c.memoanima"),
    ("tab\tname", "tab_name.memoanima"),
    ("dot. ", "dot.memoanima"),
    ("...", "_.memoanima"),
    ("", "_.memoanima"),
    ("my.work", "my.work.memoanima"),
    ("Old.animemo", "Old.memoanima"),
    ("Old.ANIMEMO", "Old.memoanima"),
    ("ok.memoanima", "ok.memoanima"),
    ("Mixed.MemoAnima", "Mixed.MemoAnima"),
    ("絵文字🎨", "絵文字🎨.memoanima"),
];

#[cfg(test)]
mod v199_tests {
    use super::*;

    /// 表のとおりの名前で書かれる（名前の組み立て `project_file_name` と、本物の `save_project` の両方）
    #[test]
    fn name_cases_match_save() {
        for (input, want) in V199_NAME_CASES {
            assert_eq!(&project_file_name(input), want, "project_file_name({input:?})");
        }
        let base = std::env::temp_dir().join(format!(
            "v199-pclib-{}-{}",
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&base);
        let lib = base.join("lib");
        fs::create_dir_all(&lib).unwrap();
        let root = lib.to_str().unwrap().to_string();
        let mut bad: Vec<String> = Vec::new();
        for (input, want) in V199_NAME_CASES {
            match save_project(&root, "al", input, b"V199", &[]) {
                Ok(p) => {
                    let got = Path::new(&p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    if &got != want {
                        bad.push(format!("{input:?}: {got}"));
                    }
                }
                Err(e) => bad.push(format!("{input:?}: Err {e}")),
            }
        }
        let _ = fs::remove_dir_all(&base);
        assert!(bad.is_empty(), "save_project が表と違う名前で書いた: {bad:?}");
    }
}

/// V200 (A-100): まとめ変換の書き手（`create_project`）。`scripts/v200_smoke.ts` [R-1] が `cargo test pclib::v200_tests` で回す
#[cfg(test)]
mod v200_tests {
    use super::*;

    /// 使い捨ての場所（%TEMP% の下・v198_tests と同じ作り。落ちても消すのはこのフォルダ 1 つ）
    struct TmpLib {
        base: PathBuf,
        lib: PathBuf,
    }
    impl TmpLib {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "v200-pclib-{tag}-{}-{}",
                std::process::id(),
                TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&base);
            let lib = base.join("lib");
            fs::create_dir_all(&lib).unwrap();
            TmpLib { base, lib }
        }
        fn root(&self) -> &str {
            self.lib.to_str().unwrap()
        }
        fn album(&self, a: &str) -> PathBuf {
            let d = self.lib.join(a);
            fs::create_dir_all(&d).unwrap();
            d
        }
    }
    impl Drop for TmpLib {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    /// フォルダに残った作りかけ（`.tmp`）と退避（`.bak`）
    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp") || n.ends_with(".bak"))
            .collect()
    }

    /// ★名前は保存と同じ（V199 の表）。中身は渡したバイトそのまま・サムネは `<file>.png`・作りかけも退避も残らない
    #[test]
    fn creates_with_save_names() {
        let lib = TmpLib::new("names");
        for (i, (input, want)) in V199_NAME_CASES.iter().enumerate() {
            // 表には同じ書き先になる名前が 2 つある（Old.animemo / Old.ANIMEMO）。1 件ずつ別のアルバムで
            let album = format!("al{i}");
            let dir = lib.album(&album);
            let data = format!("V200-{i}").into_bytes();
            let r = create_project(lib.root(), &album, input, &data, b"png").unwrap();
            assert!(r.created, "作られなかった: {input:?}");
            let got = Path::new(&r.path).file_name().unwrap().to_string_lossy().to_string();
            assert_eq!(&got, want, "名前が保存と違う: {input:?}");
            assert_eq!(fs::read(&r.path).unwrap(), data, "中身が違う: {input:?}");
            assert_eq!(fs::read(dir.join(format!("{want}.png"))).unwrap(), b"png", "サムネ: {input:?}");
            assert!(leftovers(&dir).is_empty(), "残った: {:?}", leftovers(&dir));
            // 保存（save_project）なら同じアルバムの同じ名前に書く＝同じファイル
            let saved = save_project(lib.root(), &album, input, &data, &[]).unwrap();
            assert_eq!(PathBuf::from(&saved), PathBuf::from(&r.path), "保存と書き先が違う: {input:?}");
        }
    }

    /// ★同じ名前が在れば作らない。在るファイルもサムネも 1 バイトも変えない・作りかけを残さない
    #[test]
    fn never_overwrites() {
        let lib = TmpLib::new("keep");
        let dir = lib.album("al");
        fs::write(dir.join("x.memoanima"), b"old").unwrap();
        fs::write(dir.join("x.memoanima.png"), b"oldpng").unwrap();
        let r = create_project(lib.root(), "al", "x", b"new", b"newpng").unwrap();
        assert!(!r.created && r.path.is_empty());
        assert_eq!(fs::read(dir.join("x.memoanima")).unwrap(), b"old");
        assert_eq!(fs::read(dir.join("x.memoanima.png")).unwrap(), b"oldpng");
        assert!(leftovers(&dir).is_empty(), "残った: {:?}", leftovers(&dir));
        // 同じ名前のフォルダも「在る」
        fs::create_dir_all(dir.join("d.memoanima")).unwrap();
        assert!(!create_project(lib.root(), "al", "d", b"new", &[]).unwrap().created);
        assert!(dir.join("d.memoanima").is_dir());
        // 大文字小文字だけ違う名前: 区別しないファイルシステム（Windows・Mac の既定）では「在る」
        fs::write(dir.join("Case.memoanima"), b"old").unwrap();
        let insensitive = dir.join("CASE.MEMOANIMA").exists();
        let r = create_project(lib.root(), "al", "case", b"new", &[]).unwrap();
        if insensitive {
            assert!(!r.created, "大文字小文字だけ違う名前を作った（上書きの危険）");
            assert_eq!(fs::read(dir.join("Case.memoanima")).unwrap(), b"old");
        }
        assert!(leftovers(&dir).is_empty(), "残った: {:?}", leftovers(&dir));
    }

    /// ★安い門番を通り抜けたあとで同じ名前ができても（外で作られた）、hard_link が断る＝置き換えない。一時ファイルは消える
    #[test]
    fn link_refuses_existing() {
        let lib = TmpLib::new("race");
        let dir = lib.album("al");
        let dest = dir.join("r.memoanima");
        fs::write(&dest, b"theirs").unwrap();
        let tmp = dir.join("r.memoanima.1-1.tmp");
        assert!(!create_from_tmp(&tmp, &dest, b"ours", |a, b| fs::hard_link(a, b)).unwrap(), "在るのに作ったことになった");
        assert!(remove_tmp(&tmp));
        assert_eq!(fs::read(&dest).unwrap(), b"theirs", "在ったファイルが置き換わった");
        assert!(leftovers(&dir).is_empty(), "残った: {:?}", leftovers(&dir));
    }

    /// ★ハードリンクを作れないファイルシステム（FAT32 / exFAT など）: 作らずに Err（V173 と同じ）。
    /// 置き換えの道（rename）へは行かない・一時ファイルも作りかけも残さない・在ったファイルも変えない
    #[test]
    fn no_hardlink_fs_refuses() {
        let lib = TmpLib::new("nolink");
        let dir = lib.album("al");
        let nolink = |_: &Path, _: &Path| -> std::io::Result<()> { Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no links")) };
        let e = create_project_with(lib.root(), "al", "n", b"data", b"png", nolink).unwrap_err();
        assert!(e.starts_with("link failed: "), "理由: {e}");
        assert!(!dir.join("n.memoanima").exists() && !dir.join("n.memoanima.png").exists(), "作れないのに作った");
        assert!(leftovers(&dir).is_empty(), "残った: {:?}", leftovers(&dir));
        // 照合のあいだに外で同じ名前ができていても（安い門番のあと）、置き換えない
        fs::write(dir.join("m.memoanima"), b"theirs").unwrap();
        let tmp = dir.join("m.memoanima.1-1.tmp");
        assert!(create_from_tmp(&tmp, &dir.join("m.memoanima"), b"ours", nolink).is_err());
        assert!(remove_tmp(&tmp));
        assert_eq!(fs::read(dir.join("m.memoanima")).unwrap(), b"theirs");
        assert!(leftovers(&dir).is_empty(), "残った: {:?}", leftovers(&dir));
        // ふつうの道は一時ファイルの名前を消せている（tmp_left は false）
        let r = create_project(lib.root(), "al", "ok", b"x", &[]).unwrap();
        assert!(r.created && !r.tmp_left);
    }

    /// 2 回目は全部飛ばす（要件 §5 ②）。元の .kwz／.ppm は変わらない（④）
    #[test]
    fn second_run_skips_and_sources_untouched() {
        let lib = TmpLib::new("again");
        let dir = lib.album("3DS");
        fs::write(dir.join("a.kwz"), b"KFH\x14kwz-a").unwrap();
        fs::write(dir.join("b.ppm"), b"PARAppm-b").unwrap();
        let before = (fs::read(dir.join("a.kwz")).unwrap(), fs::read(dir.join("b.ppm")).unwrap());
        assert!(create_project(lib.root(), "3DS", "a", b"A", &[]).unwrap().created);
        assert!(create_project(lib.root(), "3DS", "b", b"B", &[]).unwrap().created);
        let names = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(projects_taken(lib.root(), "3DS", &names).unwrap(), vec![true, true, false]);
        assert!(!create_project(lib.root(), "3DS", "a", b"A2", &[]).unwrap().created);
        assert!(!create_project(lib.root(), "3DS", "b", b"B2", &[]).unwrap().created);
        assert_eq!(fs::read(dir.join("a.memoanima")).unwrap(), b"A");
        assert_eq!(fs::read(dir.join("b.memoanima")).unwrap(), b"B");
        assert_eq!((fs::read(dir.join("a.kwz")).unwrap(), fs::read(dir.join("b.ppm")).unwrap()), before);
        assert!(leftovers(&dir).is_empty(), "残った: {:?}", leftovers(&dir));
    }

    /// アルバムが無ければ断る（作り直さない）・ライブラリ未設定も断る・断りの文にパスを入れない
    #[test]
    fn refuses_missing_album() {
        let lib = TmpLib::new("missing");
        let e = create_project(lib.root(), "gone", "x", b"x", &[]).unwrap_err();
        assert!(!lib.lib.join("gone").exists(), "無いアルバムを作った");
        assert!(!e.contains(lib.root()), "断りの文にパス: {e}");
        assert!(create_project("", "al", "x", b"x", &[]).is_err());
        assert!(projects_taken("", "al", &["x".to_string()]).is_err());
        // 隠しフォルダ・外へ出る名前は 1 つの名前に潰れる（保存と同じ）
        assert!(create_project(lib.root(), ".hidden", "x", b"x", &[]).is_err());
        let dir = lib.album("al");
        let r = create_project(lib.root(), "al", "../x", b"x", &[]).unwrap();
        assert!(r.created && Path::new(&r.path).starts_with(&dir), "外へ書いた: {}", r.path);
        assert!(!lib.base.join("x.memoanima").exists());
    }
}

#[cfg(test)]
mod v201_tests {
    use super::*;

    /// 使い捨ての場所（%TEMP% の下・v200_tests と同じ作り。落ちても消すのはこのフォルダ 1 つ）
    struct TmpLib {
        base: PathBuf,
        lib: PathBuf,
    }
    impl TmpLib {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "v201-pclib-{tag}-{}-{}",
                std::process::id(),
                TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&base);
            let lib = base.join("lib");
            fs::create_dir_all(&lib).unwrap();
            TmpLib { base, lib }
        }
        fn root(&self) -> &str {
            self.lib.to_str().unwrap()
        }
        fn album(&self, a: &str) -> PathBuf {
            let d = self.lib.join(a);
            fs::create_dir_all(&d).unwrap();
            d
        }
    }
    impl Drop for TmpLib {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }

    /// ★P-2: 移すと控え（.bak）も移る・サムネも追随・元のアルバムは空になって削除できる（R-3）
    #[test]
    fn move_carries_bak() {
        let lib = TmpLib::new("bak");
        let a = lib.album("A");
        lib.album("B");
        fs::write(a.join("作品.memoanima"), b"BODY").unwrap();
        fs::write(a.join("作品.memoanima.bak"), b"OLD").unwrap();
        fs::write(a.join("作品.memoanima.png"), b"PNG").unwrap();
        let p = move_project(lib.root(), "A", "作品.memoanima", "B").unwrap();
        let b = lib.lib.join("B");
        assert!(p.ends_with("作品.memoanima"));
        assert_eq!(names(&b), vec!["作品.memoanima", "作品.memoanima.bak", "作品.memoanima.png"]);
        assert_eq!(fs::read(b.join("作品.memoanima.bak")).unwrap(), b"OLD");
        assert!(names(&a).is_empty(), "元のアルバムに残った: {:?}", names(&a));
        delete_album(lib.root(), "A").unwrap();
        assert!(!a.exists());
    }

    /// ★P-2: 移した先に「控えだけ」が残った名前（復元の候補）があれば、その名前を使わない（控えを置き換えない）。
    ///  本体があれば今までどおり避ける。名前の付け方は unique_dest と同じ（名前-1・名前-2）
    #[test]
    fn dest_name_avoids_bak_and_body() {
        let lib = TmpLib::new("dest");
        let a = lib.album("A");
        let b = lib.album("B");
        fs::write(a.join("x.memoanima"), b"BODY").unwrap();
        fs::write(a.join("x.memoanima.bak"), b"MINE").unwrap();
        fs::write(b.join("x.memoanima.bak"), b"THEIRS").unwrap(); // 控えだけが残った名前
        fs::write(b.join("x-1.memoanima"), b"OTHER").unwrap(); // 本体がある名前
        let p = move_project(lib.root(), "A", "x.memoanima", "B").unwrap();
        assert!(p.ends_with("x-2.memoanima"), "{p}");
        assert_eq!(fs::read(b.join("x.memoanima.bak")).unwrap(), b"THEIRS", "移した先の控えを置き換えた");
        assert_eq!(fs::read(b.join("x-1.memoanima")).unwrap(), b"OTHER");
        assert_eq!(fs::read(b.join("x-2.memoanima")).unwrap(), b"BODY");
        assert_eq!(fs::read(b.join("x-2.memoanima.bak")).unwrap(), b"MINE");
    }

    /// 控えの無い作品は今までどおり（控えを作らない）・同じアルバムへの移動は何もしない
    #[test]
    fn no_bak_and_same_album_unchanged() {
        let lib = TmpLib::new("plain");
        let a = lib.album("A");
        lib.album("B");
        fs::write(a.join("y.memoanima"), b"BODY").unwrap();
        fs::write(a.join("z.memoanima"), b"Z").unwrap();
        fs::write(a.join("z.memoanima.bak"), b"ZB").unwrap();
        move_project(lib.root(), "A", "y.memoanima", "B").unwrap();
        assert_eq!(names(&lib.lib.join("B")), vec!["y.memoanima"]);
        let same = move_project(lib.root(), "A", "z.memoanima", "A").unwrap();
        assert!(same.ends_with("z.memoanima"));
        assert_eq!(names(&a), vec!["z.memoanima", "z.memoanima.bak"]);
    }

    /// ★P-4: 保存で、一時ファイルを書いている途中で失敗したら、書きかけを残さない（前のファイルも控えも変えない）。
    ///  保存（Bytes）とドロップの取り込み（File）の両方の道。前のファイルが無い名前でも同じ
    #[test]
    fn save_write_failure_leaves_no_tmp() {
        let lib = TmpLib::new("p4");
        let a = lib.album("A");
        fs::write(a.join("s.memoanima"), b"PREV").unwrap();
        let src_file = lib.base.join("外.memoanima");
        fs::write(&src_file, b"FROM-OUTSIDE").unwrap();
        let half = |tmp: &Path, _src: &ProjectSource| -> std::io::Result<()> {
            fs::write(tmp, b"HALF")?;
            Err(std::io::Error::other("disk full"))
        };
        for (name, src) in [
            ("s", ProjectSource::Bytes(b"NEW-CONTENT")),
            ("s", ProjectSource::File(&src_file)),
            ("t", ProjectSource::Bytes(b"NEW")),
        ] {
            let e = save_project_impl_with(lib.root(), "A", name, src, b"PNG", half).unwrap_err();
            assert!(e.starts_with("保存失敗: "), "{e}");
            assert_eq!(names(&a), vec!["s.memoanima"], "書きかけ・控え・サムネが残った");
            assert_eq!(fs::read(a.join("s.memoanima")).unwrap(), b"PREV");
        }
        // 本物の 1 手では今までどおり書ける（一時ファイルは残らない・控えは 1 つ）
        save_project(lib.root(), "A", "s", b"NEW-CONTENT", b"PNG").unwrap();
        assert_eq!(names(&a), vec!["s.memoanima", "s.memoanima.bak", "s.memoanima.png"]);
        import_project_file(lib.root(), "A", "u", src_file.to_str().unwrap(), b"").unwrap();
        assert_eq!(fs::read(a.join("u.memoanima")).unwrap(), b"FROM-OUTSIDE");
        assert!(names(&a).iter().all(|n| !n.ends_with(".tmp")));
    }

    /// ★独立レビューの指摘 R2・R6: 動かす・戻すの各段で失敗させ、本体の在り処と案内が合うこと（ファイルの一覧とバイトで見る）
    #[test]
    fn rollback_paths_tell_the_truth() {
        let fails = |which: &'static [(&'static str, &'static str)]| {
            move |from: &Path, to: &Path| -> std::io::Result<()> {
                let f = from.to_string_lossy().to_string();
                let t = to.to_string_lossy().to_string();
                // V211 (§15): 仕込む条件の区切りは、その OS の区切りで比べる（字は Windows の形で書いてある・Mac と Linux は / に）
                let os_sep = |x: &str| x.replace('\\', std::path::MAIN_SEPARATOR_STR);
                for (a, b) in which {
                    if f.contains(&os_sep(a)) && t.contains(&os_sep(b)) {
                        return Err(std::io::Error::other("locked"));
                    }
                }
                fs::rename(from, to)
            }
        };
        let setup = |tag: &str| {
            let lib = TmpLib::new(tag);
            let a = lib.album("A");
            lib.album("B");
            fs::write(a.join("v.memoanima"), b"BODY").unwrap();
            fs::write(a.join("v.memoanima.png"), b"PNG").unwrap();
            fs::write(a.join("v.memoanima.bak"), b"OLD").unwrap();
            lib
        };
        // ① サムネを動かせない → 本体を戻す（何も動いていない）
        let lib = setup("r1");
        let e = move_project_with(lib.root(), "A", "v.memoanima", "B", fails(&[("\\A\\v.memoanima.png", "\\B\\")])).unwrap_err();
        assert!(e.contains("サムネイルの移動に失敗（移動を取り消しました）"), "{e}");
        assert_eq!(names(&lib.lib.join("A")), vec!["v.memoanima", "v.memoanima.bak", "v.memoanima.png"]);
        assert!(names(&lib.lib.join("B")).is_empty());
        // ② 控えを動かせず、サムネの戻しも失敗・本体は戻せた → 作品は元の A（サムネだけ B）
        let lib = setup("r2");
        let e = move_project_with(lib.root(), "A", "v.memoanima", "B", fails(&[(".memoanima.bak", "\\B\\"), ("\\B\\v.memoanima.png", "\\A\\")])).unwrap_err();
        assert!(e.contains("作品は元の「A」に戻しました") && e.contains("サムネイルは「B」に残っています"), "{e}");
        assert_eq!(fs::read(lib.lib.join("A").join("v.memoanima")).unwrap(), b"BODY");
        assert_eq!(names(&lib.lib.join("B")), vec!["v.memoanima.png"]);
        // ③ 控えを動かせず、本体の戻しも失敗 → 作品は B
        let lib = setup("r3");
        let e = move_project_with(lib.root(), "A", "v.memoanima", "B", fails(&[(".memoanima.bak", "\\B\\"), ("\\B\\v.memoanima", "\\A\\")])).unwrap_err();
        assert!(e.contains("取り消しにも失敗しました。作品は「B」にあります"), "{e}");
        assert_eq!(fs::read(lib.lib.join("B").join("v.memoanima")).unwrap(), b"BODY");
        // ④ サムネを動かせず、本体の戻しも失敗 → 作品は B（嘘の「取り消しました」を言わない）
        let lib = setup("r4");
        let e = move_project_with(lib.root(), "A", "v.memoanima", "B", fails(&[("\\A\\v.memoanima.png", "\\B\\"), ("\\B\\v.memoanima", "\\A\\")])).unwrap_err();
        assert!(e.contains("取り消しにも失敗しました。作品は「B」にあります") && !e.contains("取り消しました）"), "{e}");
        assert_eq!(fs::read(lib.lib.join("B").join("v.memoanima")).unwrap(), b"BODY");
    }

    /// 控えだけ動かせなかったら、本体とサムネを元へ戻す（何も動いていない状態）
    #[test]
    fn bak_failure_rolls_back() {
        let lib = TmpLib::new("rb");
        let a = lib.album("A");
        let b = lib.album("B");
        fs::write(a.join("w.memoanima"), b"BODY").unwrap();
        fs::write(a.join("w.memoanima.bak"), b"OLD").unwrap();
        fs::write(a.join("w.memoanima.png"), b"PNG").unwrap();
        let r = move_project_with(lib.root(), "A", "w.memoanima", "B", |from, to| {
            if from.to_string_lossy().ends_with(".bak") {
                Err(std::io::Error::other("locked"))
            } else {
                fs::rename(from, to)
            }
        });
        let e = r.unwrap_err();
        assert!(e.contains("取り消しました"), "{e}");
        assert_eq!(names(&a), vec!["w.memoanima", "w.memoanima.bak", "w.memoanima.png"]);
        assert!(names(&b).is_empty(), "{:?}", names(&b));
    }

    /// ★第三者レビュー R1: 番号つきの候補（名前-1）も、控えだけが残っていれば使わない（最初の候補だけでなく）
    #[test]
    fn numbered_candidate_avoids_bak_too() {
        let lib = TmpLib::new("num");
        let a = lib.album("A");
        let b = lib.album("B");
        fs::write(a.join("x.memoanima"), b"BODY").unwrap();
        fs::write(b.join("x.memoanima"), b"OTHER").unwrap(); // 本体がある名前
        fs::write(b.join("x-1.memoanima.bak"), b"THEIRS").unwrap(); // 番号つきの名前に控えだけ
        let p = move_project(lib.root(), "A", "x.memoanima", "B").unwrap();
        assert!(p.ends_with("x-2.memoanima"), "{p}");
        assert_eq!(fs::read(b.join("x-1.memoanima.bak")).unwrap(), b"THEIRS", "移した先の控えに本体を重ねた");
        assert!(!b.join("x-1.memoanima").exists(), "控えだけの名前に本体を置いた");
        assert_eq!(fs::read(b.join("x-2.memoanima")).unwrap(), b"BODY");
    }

    /// ★第三者レビュー R2: サムネの無い作品で控えだけ動かせなかった → 本体を戻して「取り消しました」（サムネを作らない）
    #[test]
    fn bak_failure_without_png_rolls_back() {
        let lib = TmpLib::new("nopng");
        let a = lib.album("A");
        let b = lib.album("B");
        fs::write(a.join("n.memoanima"), b"BODY").unwrap();
        fs::write(a.join("n.memoanima.bak"), b"OLD").unwrap();
        let r = move_project_with(lib.root(), "A", "n.memoanima", "B", |from, to| {
            if from.to_string_lossy().ends_with(".bak") {
                Err(std::io::Error::other("locked"))
            } else {
                fs::rename(from, to)
            }
        });
        let e = r.unwrap_err();
        assert!(e.contains("控え（.bak）の移動に失敗（移動を取り消しました）"), "{e}");
        assert_eq!(names(&a), vec!["n.memoanima", "n.memoanima.bak"]);
        assert!(names(&b).is_empty(), "{:?}", names(&b));
    }
}

// V216b (A-126・A-129・A-131): 同じ名前を確かめずに置き換えない・まとめ変換の空き・ジャンクションのアルバム。
// 一時フォルダに試験用のライブラリを作り、終わったら消す（作者のライブラリには触れない）
#[cfg(test)]
mod v216b_tests {
    use super::*;

    struct TmpLib {
        base: PathBuf,
        lib: PathBuf,
    }
    impl TmpLib {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "v216b-pclib-{tag}-{}-{}",
                std::process::id(),
                TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&base);
            let lib = base.join("lib");
            fs::create_dir_all(lib.join("A")).unwrap();
            TmpLib { base, lib }
        }
        fn root(&self) -> &str {
            self.lib.to_str().unwrap()
        }
        fn a(&self) -> PathBuf {
            self.lib.join("A")
        }
    }
    impl Drop for TmpLib {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }
    fn tmp_count(dir: &Path) -> usize {
        names(dir).iter().filter(|n| n.ends_with(".tmp")).count()
    }
    fn guard(work_file: Option<&str>, allow_replace: bool) -> SaveGuard<'_> {
        SaveGuard { work_file, allow_replace }
    }
    /// 置き換えない確定の 2 手を差し込んで保存する（`link`・`mv`）
    fn save_with(
        l: &TmpLib,
        name: &str,
        data: &[u8],
        g: SaveGuard,
        link: impl Fn(&Path, &Path) -> std::io::Result<()>,
        mv: impl Fn(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<String, String> {
        save_project_core(l.root(), "A", name, ProjectSource::Bytes(data), b"PNG", SaveMode::Checked(g), write_project_tmp, link, mv)
    }
    fn unsupported() -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::Unsupported, "test: no hard links")
    }

    /// ★空きの判定（§2-1 の 4）: その作品のファイル／在る／控えだけ（.bak・.gz）／空き。大文字と小文字だけ違うのは「違う」
    #[test]
    fn status_kinds() {
        let l = TmpLib::new("st");
        let a = l.a();
        fs::write(a.join("x.memoanima"), b"B").unwrap();
        fs::write(a.join("r.memoanima.bak"), b"R").unwrap();
        fs::write(a.join("g.memoanima.gz"), [0x1f, 0x8b, 1]).unwrap();
        fs::create_dir(a.join("d.memoanima")).unwrap();
        let own = a.join("x.memoanima");
        let st = |n: &str, w: Option<&str>| save_target_status(l.root(), "A", n, w).unwrap();
        println!(
            "V216B-STATUS x={:?} own={:?} r={:?} g={:?} d={:?} f={:?}",
            st("x", None),
            st("x", own.to_str()),
            st("r", None),
            st("g", None),
            st("d", None),
            st("f", None)
        );
        assert_eq!(st("x", None), NameStatus::Taken);
        assert_eq!(st("x", own.to_str()), NameStatus::Own);
        assert_eq!(st("x.memoanima", own.to_str()), NameStatus::Own);
        assert_eq!(st("x.animemo", own.to_str()), NameStatus::Own);
        assert_eq!(st("r", None), NameStatus::Reserved);
        assert_eq!(st("g", None), NameStatus::Reserved);
        assert_eq!(st("d", None), NameStatus::Taken, "同じ名前のフォルダも在る");
        assert_eq!(st("f", None), NameStatus::Free);
        // 大文字と小文字だけ違うその作品のファイル＝違う（確かめが出る側）
        let upper = a.join("X.memoanima");
        assert_eq!(st("x", upper.to_str()), NameStatus::Taken);
        // x..memoanima を開いた作品の名前（x.）は隣の x.memoanima へ向く＝その作品のファイルではない（C-8 の根）
        let dotted = a.join("x..memoanima");
        fs::write(&dotted, b"D").unwrap();
        assert_eq!(st("x.", dotted.to_str()), NameStatus::Taken);
        // 空きの案
        assert_eq!(free_project_name(l.root(), "A", "x").unwrap(), "x (2)");
        fs::write(a.join("x (2).memoanima.bak"), b"R").unwrap();
        assert_eq!(free_project_name(l.root(), "A", "x").unwrap(), "x (3)");
        assert_eq!(free_project_name(l.root(), "A", "f").unwrap(), "f");
        assert_eq!(free_project_name(l.root(), "A", "r").unwrap(), "r (2)");
    }

    /// ★S-1・S-2（C-6・C-7）: 在る名前へは置き換えない。［置き換える］で置き換わり .bak が前の作品。その作品のファイルは確かめずに上書き
    #[test]
    fn checked_save_never_replaces_without_consent() {
        let l = TmpLib::new("ck");
        let a = l.a();
        let b = a.join("x.memoanima");
        fs::write(&b, b"WORK-B").unwrap();
        let e = save_project_checked(l.root(), "A", "x", b"WORK-A", b"PNG", guard(None, false)).unwrap_err();
        println!("V216B-TAKEN err={e} b_kept={}", fs::read(&b).unwrap() == b"WORK-B");
        assert_eq!(e, SAVE_EXISTS_TAKEN);
        assert_eq!(fs::read(&b).unwrap(), b"WORK-B");
        assert!(!a.join("x.memoanima.bak").exists());
        assert!(!a.join("x.memoanima.png").exists(), "断ったときはサムネも書かない");
        assert_eq!(tmp_count(&a), 0);
        // 古い save_project 命令と同じ既定（欄が無い）も置き換えない
        assert_eq!(
            save_project_checked(l.root(), "A", "x", b"WORK-A", b"", SaveGuard::default()).unwrap_err(),
            SAVE_EXISTS_TAKEN
        );
        // ［置き換える］
        let p = save_project_checked(l.root(), "A", "x", b"WORK-A", b"PNG", guard(None, true)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"WORK-A");
        assert_eq!(fs::read(a.join("x.memoanima.bak")).unwrap(), b"WORK-B");
        // その作品のファイル（書いたパス）への上書きは確かめない（今と同じ・.bak は 1 世代）
        let p2 = save_project_checked(l.root(), "A", "x", b"WORK-A2", b"", guard(Some(&p), false)).unwrap();
        assert_eq!(p2, p);
        assert_eq!(fs::read(&p).unwrap(), b"WORK-A2");
        assert_eq!(fs::read(a.join("x.memoanima.bak")).unwrap(), b"WORK-A");
        assert_eq!(tmp_count(&a), 0);
        // 空きの名前は置き換えない確定で作る（サムネも書く）
        let n = save_project_checked(l.root(), "A", "new", b"NEW", b"PNG", guard(None, false)).unwrap();
        assert_eq!(fs::read(&n).unwrap(), b"NEW");
        assert_eq!(fs::read(a.join("new.memoanima.png")).unwrap(), b"PNG");
        assert_eq!(tmp_count(&a), 0);
    }

    /// ★C-8: x..memoanima を開いて保存しても、隣の x.memoanima を確かめずに上書きしない
    #[test]
    fn dotted_name_does_not_hit_neighbour() {
        let l = TmpLib::new("dot");
        let a = l.a();
        fs::write(a.join("x.memoanima"), b"NEIGHBOUR").unwrap();
        let dotted = a.join("x..memoanima");
        fs::write(&dotted, b"MINE").unwrap();
        let e = save_project_checked(l.root(), "A", "x.", b"EDIT", b"", guard(dotted.to_str(), false)).unwrap_err();
        assert_eq!(e, SAVE_EXISTS_TAKEN);
        assert_eq!(fs::read(a.join("x.memoanima")).unwrap(), b"NEIGHBOUR");
        assert_eq!(fs::read(&dotted).unwrap(), b"MINE");
    }

    /// ★S-3（A-126）: 控えだけ・.gz だけの名前は［置き換える］でも書かない。控えのバイト・元に戻す候補・改名の候補の数が変わらない
    #[test]
    fn reserved_names_are_kept() {
        let l = TmpLib::new("rs");
        let a = l.a();
        fs::write(a.join("r.memoanima.bak"), b"LOST-WORK").unwrap();
        fs::write(a.join("g.memoanima.gz"), [0x1f, 0x8b, 9, 9]).unwrap();
        let rec0 = scan_recoverable(l.root()).unwrap().len();
        let ren0 = scan_renamed_projects(l.root()).unwrap().len();
        for replace in [false, true] {
            assert_eq!(
                save_project_checked(l.root(), "A", "r", b"N", b"P", guard(None, replace)).unwrap_err(),
                SAVE_EXISTS_RESERVED
            );
            assert_eq!(
                save_project_checked(l.root(), "A", "g", b"N", b"P", guard(None, replace)).unwrap_err(),
                SAVE_EXISTS_RESERVED
            );
        }
        println!(
            "V216B-RESERVED rec={rec0}->{} ren={ren0}->{}",
            scan_recoverable(l.root()).unwrap().len(),
            scan_renamed_projects(l.root()).unwrap().len()
        );
        assert_eq!(fs::read(a.join("r.memoanima.bak")).unwrap(), b"LOST-WORK");
        assert_eq!(scan_recoverable(l.root()).unwrap().len(), rec0);
        assert_eq!(scan_renamed_projects(l.root()).unwrap().len(), ren0);
        assert!(!a.join("r.memoanima").exists() && !a.join("g.memoanima").exists());
        assert_eq!(tmp_count(&a), 0);
    }

    /// ★S-4: 確かめのあと書く前に同じ名前ができる → 書かずに断る（hard_link が断る・ハードリンクを作れない道でも見直しが断る）
    #[test]
    fn name_appearing_late_is_refused() {
        let l = TmpLib::new("late");
        let a = l.a();
        let dest = a.join("z.memoanima");
        // hard_link の直前に宛先ができる（同期クライアントの形）
        let d1 = dest.clone();
        let e = save_with(
            &l,
            "z",
            b"MINE",
            guard(None, false),
            move |t, d| {
                fs::write(&d1, b"OTHER").unwrap();
                fs::hard_link(t, d)
            },
            move_noreplace,
        )
        .unwrap_err();
        assert_eq!(e, SAVE_EXISTS_TAKEN);
        assert_eq!(fs::read(&dest).unwrap(), b"OTHER");
        assert_eq!(tmp_count(&a), 0);
        assert!(!a.join("z.memoanima.png").exists());
        fs::remove_file(&dest).unwrap();
        // ハードリンクを作れない（「在る」以外の失敗）＋その間に宛先ができる → 見直しで断る（移す 2 手目も呼ばない）
        let d2 = dest.clone();
        let e = save_with(
            &l,
            "z",
            b"MINE",
            guard(None, false),
            move |_, _| {
                fs::write(&d2, b"OTHER2").unwrap();
                Err(unsupported())
            },
            |_, _| panic!("宛先が在るのに移そうとした"),
        )
        .unwrap_err();
        assert_eq!(e, SAVE_EXISTS_TAKEN);
        assert_eq!(fs::read(&dest).unwrap(), b"OTHER2");
        assert_eq!(tmp_count(&a), 0);
        fs::remove_file(&dest).unwrap();
        // 置き換えない移し方の最中に宛先ができる（移す口が「在る」と断る）
        let d3 = dest.clone();
        let e = save_with(&l, "z", b"MINE", guard(None, false), |_, _| Err(unsupported()), move |t, d| {
            fs::write(&d3, b"OTHER3").unwrap();
            move_noreplace(t, d)
        })
        .unwrap_err();
        println!("V216B-LATE refused tmp_left={}", tmp_count(&a));
        assert_eq!(e, SAVE_EXISTS_TAKEN);
        assert_eq!(fs::read(&dest).unwrap(), b"OTHER3");
        assert_eq!(tmp_count(&a), 0);
    }

    /// ★S-4: ハードリンクを作れないファイルシステムでも、初めての保存ができる（置き換えない移し方 → だめなら今の確定）
    #[test]
    fn no_hard_link_still_saves() {
        let l = TmpLib::new("nolink");
        let a = l.a();
        let p = save_with(&l, "m", b"VIA-MOVE", guard(None, false), |_, _| Err(unsupported()), move_noreplace).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"VIA-MOVE");
        let p = save_with(&l, "c", b"VIA-COMMIT", guard(None, false), |_, _| Err(unsupported()), |_, _| Err(unsupported())).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"VIA-COMMIT");
        println!("V216B-NOLINK files={:?}", names(&a));
        assert_eq!(names(&a), vec!["c.memoanima", "c.memoanima.png", "m.memoanima", "m.memoanima.png"]);
    }

    /// ★書いている途中で失敗しても一時ファイルを残さない・作品もサムネも作らない
    #[test]
    fn failed_write_leaves_nothing() {
        let l = TmpLib::new("fail");
        let a = l.a();
        let half = |t: &Path, _: &ProjectSource| -> std::io::Result<()> {
            fs::write(t, b"HALF")?;
            Err(std::io::Error::other("test: disk full"))
        };
        let e = save_project_core(
            l.root(),
            "A",
            "w",
            ProjectSource::Bytes(b"DATA"),
            b"PNG",
            SaveMode::Checked(guard(None, false)),
            half,
            |a, b| fs::hard_link(a, b),
            move_noreplace,
        )
        .unwrap_err();
        assert!(e.starts_with("保存失敗"), "{e}");
        assert!(names(&a).is_empty(), "{:?}", names(&a));
    }

    /// ★S-5（C-8）: 取り込みは在る作品を置き換えない。在る・控えだけなら Rust が次の空いた名前を決める
    #[test]
    fn import_never_replaces() {
        let l = TmpLib::new("imp");
        let a = l.a();
        let src_dir = l.base.join("src");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(a.join("x.memoanima"), b"KEEP-X").unwrap();
        fs::write(a.join("y.memoanima.bak"), b"KEEP-Y").unwrap();
        let s1 = src_dir.join("x..memoanima");
        fs::write(&s1, b"IMPORTED-1").unwrap();
        // 画面の名前の整え方（importBaseName）が x. を返す形
        let p1 = import_project_file(l.root(), "A", "x.", s1.to_str().unwrap(), b"PNG").unwrap();
        let p2 = import_project_file(l.root(), "A", "x", s1.to_str().unwrap(), b"").unwrap();
        let p3 = import_project_file(l.root(), "A", "y", s1.to_str().unwrap(), b"").unwrap();
        let fname = |p: &str| Path::new(p).file_name().unwrap().to_string_lossy().to_string();
        println!("V216B-IMPORT {} {} {}", fname(&p1), fname(&p2), fname(&p3));
        assert_eq!(fname(&p1), "x. (2).memoanima");
        assert_eq!(fname(&p2), "x (2).memoanima");
        assert_eq!(fname(&p3), "y (2).memoanima");
        assert_eq!(fs::read(a.join("x.memoanima")).unwrap(), b"KEEP-X");
        assert_eq!(fs::read(a.join("y.memoanima.bak")).unwrap(), b"KEEP-Y");
        assert_eq!(fs::read(&p1).unwrap(), b"IMPORTED-1");
        assert_eq!(fs::read(&s1).unwrap(), b"IMPORTED-1", "取り込み元は変えない");
        assert_eq!(tmp_count(&a), 0);
        // 確定で在ると分かったら次の名前へ（hard_link の直前に宛先ができる）
        let late = a.join("q.memoanima");
        let p4 = import_project_file_with(l.root(), "A", "q", s1.to_str().unwrap(), b"", move |t, d| {
            if d == late && !late.exists() {
                fs::write(&late, b"OTHER").unwrap();
            }
            fs::hard_link(t, d)
        })
        .unwrap();
        assert_eq!(fname(&p4), "q (2).memoanima");
        assert_eq!(fs::read(a.join("q.memoanima")).unwrap(), b"OTHER");
        assert_eq!(tmp_count(&a), 0);
    }

    /// ★今までの上書き（Rust の試し・例の save_project）は変えていない＝置き換える（V154 の 1 世代の控え）
    #[test]
    fn legacy_rust_save_still_replaces() {
        let l = TmpLib::new("legacy");
        let a = l.a();
        save_project(l.root(), "A", "k", b"G1", b"").unwrap();
        save_project(l.root(), "A", "k", b"G2", b"").unwrap();
        assert_eq!(fs::read(a.join("k.memoanima")).unwrap(), b"G2");
        assert_eq!(fs::read(a.join("k.memoanima.bak")).unwrap(), b"G1");
    }

    /// ★オートセーブの印（§2-1 の 8）: ライブラリの中の .memoanima だけに答え、書き換えると大きさか更新時刻が変わる
    #[test]
    fn work_file_stamp_answers_only_inside() {
        let l = TmpLib::new("stamp");
        let a = l.a();
        let p = save_project_checked(l.root(), "A", "s", b"ONE", b"", guard(None, false)).unwrap();
        let s1 = work_file_stamp(l.root(), &p).unwrap();
        assert_eq!(s1.size, 3);
        std::thread::sleep(std::time::Duration::from_millis(20));
        save_project_checked(l.root(), "A", "s", b"TWO!", b"", guard(Some(&p), false)).unwrap();
        let s2 = work_file_stamp(l.root(), &p).unwrap();
        assert_ne!(s1, s2);
        let outside = l.base.join("o.memoanima");
        fs::write(&outside, b"O").unwrap();
        assert!(work_file_stamp(l.root(), outside.to_str().unwrap()).is_none());
        fs::write(a.join("n.kwz"), b"K").unwrap();
        assert!(work_file_stamp(l.root(), a.join("n.kwz").to_str().unwrap()).is_none());
        assert!(work_file_stamp(l.root(), a.join("missing.memoanima").to_str().unwrap()).is_none());
    }

    /// ★S-6（A-129・C-1）: 控えだけ・.gz だけの名前でまとめ変換 → 作らない・候補の数と控えのバイトが変わらない（付録 A-1 P1・P2／A-2）
    #[test]
    fn batch_skips_reserved_names() {
        let l = TmpLib::new("batch");
        let a = l.a();
        fs::write(a.join("x.memoanima.bak"), b"EDITED-ORIGINAL").unwrap();
        fs::write(a.join("y.memoanima.gz"), [0x1f, 0x8b, b'O', b'K']).unwrap();
        let rec0 = scan_recoverable(l.root()).unwrap().len();
        let ren0 = scan_renamed_projects(l.root()).unwrap().len();
        let taken = projects_taken(l.root(), "A", &["x".into(), "y".into(), "z".into()]).unwrap();
        let rx = create_project(l.root(), "A", "x", b"CONVERTED", b"PNG").unwrap();
        let ry = create_project(l.root(), "A", "y", b"CONVERTED", b"PNG").unwrap();
        println!(
            "V216B-BATCH taken={taken:?} created_x={} created_y={} rec={rec0}->{} ren={ren0}->{}",
            rx.created,
            ry.created,
            scan_recoverable(l.root()).unwrap().len(),
            scan_renamed_projects(l.root()).unwrap().len()
        );
        assert_eq!(taken, vec![true, true, false]);
        assert!(!rx.created && !ry.created);
        assert_eq!(scan_recoverable(l.root()).unwrap().len(), rec0);
        assert_eq!(scan_renamed_projects(l.root()).unwrap().len(), ren0);
        assert_eq!(fs::read(a.join("x.memoanima.bak")).unwrap(), b"EDITED-ORIGINAL");
        assert!(recover_project(l.root(), "A/x.memoanima").is_ok(), "控えは元に戻せる");
        assert!(!a.join("x.memoanima.png").exists() && !a.join("y.memoanima.png").exists());
        assert_eq!(tmp_count(&a), 0);
    }

    /// ★S-7（A-131）: 辿れない（canonicalize の失敗を差し込む）ときも、普通のアルバムは辿らない＝今と同じ・まだ無いフォルダも同じ
    #[test]
    fn plain_album_is_not_followed() {
        let l = TmpLib::new("plain");
        let fail = |_: &Path| -> std::io::Result<PathBuf> { Err(std::io::Error::other("test: cannot canonicalize")) };
        assert!(ensure_album_inside_with(&l.lib, &l.a(), fail).is_ok());
        assert!(ensure_album_inside_with(&l.lib, &l.lib.join("not-yet"), fail).is_ok());
        // 普通のアルバムへの保存・取り込み・メモの移動は今と同じ
        let p = save_project_checked(l.root(), "A", "p", b"P", b"", guard(None, false)).unwrap();
        assert_eq!(fs::read(p).unwrap(), b"P");
    }

    /// ★S-7（A-131・C-26・C-2）: 外を指すジャンクションのアルバムへの保存・まとめ変換・取り込み・メモの移動（元と行き先）・.gz の直しが断られ、
    /// 外のフォルダのファイルが増えない・変わらない（付録 A-10 の形）。ライブラリの中を指すリンクは今と同じ。
    /// ジャンクションはテストの中で作れない（V216）ので、v216b_smoke が外で作って `V216B_JUNC` で渡す。無ければ「見ていない」と出す
    #[test]
    fn junction_album_is_refused() {
        let Ok(b) = std::env::var("V216B_JUNC") else {
            println!("V216B-JUNC not-checked (V216B_JUNC が無い)");
            return;
        };
        let base = PathBuf::from(b);
        let lib = base.join("library");
        let outside = base.join("outside");
        let root = lib.to_str().unwrap();
        let linked = lib.join("linked");
        let is_link = fs::symlink_metadata(&linked).map(|m| m.file_type().is_symlink()).unwrap_or(false);
        assert!(is_link, "linked がリンクではない（ジャンクションを作れていない）");
        let snapshot = |d: &Path| -> Vec<(String, Vec<u8>)> {
            let mut v: Vec<(String, Vec<u8>)> = fs::read_dir(d)
                .unwrap()
                .flatten()
                .map(|e| (e.file_name().to_string_lossy().to_string(), fs::read(e.path()).unwrap_or_default()))
                .collect();
            v.sort();
            v
        };
        fs::write(outside.join("saved.memoanima"), b"OLD").unwrap();
        fs::write(outside.join("r.memoanima.gz"), [0x1f, 0x8b, 7, 7]).unwrap();
        let note_src = base.join("src").join("linked");
        fs::create_dir_all(&note_src).unwrap();
        fs::write(note_src.join("n1.kwz"), b"sd-note").unwrap();
        // 外のフォルダに置いた .kwz を「linked の作品」として索引に載せる（取り込んだあとにアルバムをリンクへ差し替えた形）
        fs::write(outside.join("m.kwz"), b"moved-note").unwrap();
        let mut idx = load_index(&lib).unwrap();
        idx.items.push(LibraryItem {
            hash: "h-linked".into(),
            album: "linked".into(),
            name: "m.kwz".into(),
            ext: "kwz".into(),
            size: 10,
            rel_path: "linked/m.kwz".into(),
            imported_at: 0,
            order: 0,
        });
        save_index(&lib, &idx).unwrap();
        let before = snapshot(&outside);
        let r_save = save_project_checked(root, "linked", "saved", b"NEW", b"PNG", guard(None, true));
        let r_save_new = save_project_checked(root, "linked", "fresh", b"NEW", b"PNG", guard(None, false));
        let src_file = base.join("drop.memoanima");
        fs::write(&src_file, b"DROPPED").unwrap();
        let r_import = import_project_file(root, "linked", "dropped", src_file.to_str().unwrap(), b"");
        let r_create = create_project(root, "linked", "batch", b"BATCH", b"PNG");
        let single = base.join("single.kwz");
        fs::write(&single, b"single-note").unwrap();
        let r_single = import_single_file(root, single.to_str().unwrap(), "linked");
        let r_sd = import(base.join("src").to_str().unwrap(), root, |_| {});
        let (_, inside_hash) = import_single_file(root, single.to_str().unwrap(), "inside").unwrap();
        let r_move_to = move_note(root, &inside_hash, "linked");
        let r_move_from = move_note(root, "h-linked", "inside");
        let r_fix = fix_renamed_projects(root);
        let after = snapshot(&outside);
        println!(
            "V216B-JUNC save={:?} save_new={:?} import={:?} create={:?} single={:?} sd_errors={:?} move_to={:?} move_from={:?} fix_errors={:?} outside_same={}",
            r_save.as_ref().err(),
            r_save_new.as_ref().err(),
            r_import.as_ref().err(),
            r_create.as_ref().err(),
            r_single.as_ref().err(),
            r_sd.as_ref().map(|r| r.errors.len()),
            r_move_to.as_ref().err(),
            r_move_from.as_ref().err(),
            r_fix.as_ref().map(|r| r.errors.len()),
            before == after
        );
        let refused = |r: &Result<String, String>| r.as_ref().err().map(|e| e == ALBUM_LINK_OUTSIDE).unwrap_or(false);
        assert!(refused(&r_save) && refused(&r_save_new) && refused(&r_import));
        assert_eq!(r_create.as_ref().err().map(String::as_str), Some(ALBUM_LINK_OUTSIDE));
        assert_eq!(r_single.as_ref().err().map(String::as_str), Some(ALBUM_LINK_OUTSIDE));
        let sd = r_sd.unwrap();
        assert_eq!(sd.imported, 0);
        assert!(sd.errors.iter().all(|e| e.ends_with(ALBUM_LINK_OUTSIDE)) && sd.errors.len() == 1, "{:?}", sd.errors);
        assert_eq!(r_move_to.err().as_deref(), Some(ALBUM_LINK_OUTSIDE));
        assert_eq!(r_move_from.err().as_deref(), Some(ALBUM_LINK_OUTSIDE));
        let fix = r_fix.unwrap();
        assert_eq!(fix.renamed, 0);
        assert_eq!(fix.errors, vec![ALBUM_LINK_OUTSIDE.to_string()]);
        assert_eq!(before, after, "外のフォルダのファイルが変わった");
        assert!(lib.join("inside").read_dir().unwrap().count() >= 1, "中のアルバムのメモは動いていない");
        // 辿れない（canonicalize の失敗を差し込む）ときは、リンクのアルバムは断る
        let fail = |_: &Path| -> std::io::Result<PathBuf> { Err(std::io::Error::other("test: cannot canonicalize")) };
        assert_eq!(ensure_album_inside_with(&lib, &linked, fail).unwrap_err(), ALBUM_LINK_OUTSIDE);
        // ライブラリの中を指すリンクは今と同じ（書ける）
        let linkin = lib.join("linkin");
        if fs::symlink_metadata(&linkin).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            let p = save_project_checked(root, "linkin", "ok", b"IN", b"", guard(None, false)).unwrap();
            let landed = lib.join("target-in").join("ok.memoanima");
            println!("V216B-JUNC-IN saved={} landed={}", Path::new(&p).is_file(), landed.is_file());
            assert!(landed.is_file());
            assert!(create_project(root, "linkin", "batch-in", b"B", b"").unwrap().created);
        } else {
            panic!("linkin がリンクではない");
        }
    }
}
