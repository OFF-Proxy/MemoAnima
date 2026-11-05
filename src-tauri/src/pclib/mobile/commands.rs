//! V202 (§4-5): モバイルだけの命令の**薄い皮**（Tauri の命令）と、その下の 1 段（封筒・引数を分けて中身を呼ぶ）。
//!
//! - 皮は OS から置き場を取る（ライブラリ・app_config_dir）だけで、**ライブラリ・オートセーブ・退避先の場所を JS から受けない**
//! - 引数のある命令は、引数を 1 つのまとまり `args` で受ける（JS は `invoke(名前, { args: {...} })`。中の欄は camelCase＝serde の
//!   `rename_all`。Tauri の camel／snake の変換に頼る欄は `args` の 1 つだけ）。作品のバイト列を運ぶ命令は、PC の `save_project_raw` と
//!   同じ生のボディの封筒（lib.rs の `parse_save_envelope`・`raw_body`）で受ける
//! - 皮の下の 1 段（`body_*`・`args_*`）は、検査用の実行ファイル（examples/v202_mobile_harness.rs）が [`dispatch`] から**同じものを**呼ぶ
//!   （JS から見た名前・封筒の分け方・引数の欄の受け方が、命令と検査で同じ道を通る）
//! - ★命令をアプリに登録する（run() へつなぐ）のは M-1b。登録の表は [`handler`]（cfg(any(mobile, test))＝cargo test でも組み立てる）。
//!   PC の run() と登録の表（lib.rs）は 1 文字も変えていない
//! - 命令はどれも同期（PC の `save_project_raw` と同じ）。端末で主スレッドを塞ぐと分かったら M-1b で async にする

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::find::{FindArgs, FoundWork};
use super::ops::{AlbumPlace, FreeSpace, WorkPlace};
use super::save::{Hooks, NewMeta, NoHooks, OverwriteMeta, SaveResult};
use super::sessions::SessionEntry;
use super::init::{LibraryInit, LibraryInitArgs};
use super::{chunks, code, evac, find, init, ops, save, sessions, Dirs, Refusal};
use crate::pclib::lock_lib;

// ---------------- 引数のまとまり（JS から見た欄の名前＝contract.json の commands[].args） ----------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkArgs {
    pub album: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameWorkArgs {
    pub album: String,
    pub name: String,
    pub new_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveWorkArgs {
    pub album: String,
    pub name: String,
    pub dest_album: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlbumNameArgs {
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameAlbumArgs {
    pub album: String,
    pub new_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionArgs {
    pub session: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGenArgs {
    pub session: String,
    pub gen: u64,
}

/// オートセーブの書き込みの封筒の印（contract.json の mobile_autosave_write.meta）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutosaveWriteMeta {
    pub session: String,
    pub gen: u64,
    /// AMAS1 の中に書く印（部品が作る・形の決まりの無い JSON の物）
    pub meta: serde_json::Value,
}

/// V212 (M-1c・D-M1-3): Android の分けて送る道を始める（`kind` は saveNew・saveOverwrite・autosave。オートセーブは番号と世代も）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkBeginArgs {
    pub kind: String,
    pub total: u64,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub gen: Option<u64>,
}

/// V212: 塊を 1 つ（base64 の文字列・4MiB 以下）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkPutArgs {
    pub upload: String,
    pub index: u32,
    pub data: String,
}

/// V212: 送り終えた・やめる
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadArgs {
    pub upload: String,
}

/// V212: 分けて受け取るのを始める（`kind` は work〔album・name〕か autosave〔session〕）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadBeginArgs {
    pub kind: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
}

/// V212: 切れ端（4MiB 以下）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadSliceArgs {
    pub download: String,
    pub offset: u64,
    pub len: u64,
}

/// V212: 受け取りを終える
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadArgs {
    pub download: String,
}

// ---------------- 皮の下の 1 段（命令と検査の実行ファイルが同じものを呼ぶ） ----------------

fn meta_of<T: for<'de> Deserialize<'de>>(v: serde_json::Value) -> Result<T, Refusal> {
    serde_json::from_value(v).map_err(|_| Refusal(code::BAD_REQUEST))
}

pub fn body_save_new(d: &Dirs, body: &[u8], h: &mut dyn Hooks) -> Result<SaveResult, Refusal> {
    let (meta, parts) = crate::parse_save_envelope(body, 2).map_err(|_| Refusal(code::BAD_REQUEST))?;
    // V211: 書き始める前に空きを見る（足りなければ断る＝既存のファイルは変えない）
    ops::ensure_room(d, (parts[0].len() + parts[1].len()) as u64)?;
    let m: NewMeta = meta_of(meta)?;
    save::save_new(d, &m, parts[0], parts[1], h)
}

pub fn body_save_overwrite(d: &Dirs, body: &[u8], h: &mut dyn Hooks) -> Result<SaveResult, Refusal> {
    let (meta, parts) = crate::parse_save_envelope(body, 2).map_err(|_| Refusal(code::BAD_REQUEST))?;
    // V211: 書き始める前に空きを見る（足りなければ断る＝既存のファイルは変えない）
    ops::ensure_room(d, (parts[0].len() + parts[1].len()) as u64)?;
    let m: OverwriteMeta = meta_of(meta)?;
    save::save_overwrite(d, &m, parts[0], parts[1], h)
}

pub fn body_autosave_write(d: &Dirs, body: &[u8]) -> Result<(), Refusal> {
    let (meta, parts) = crate::parse_save_envelope(body, 1).map_err(|_| Refusal(code::BAD_REQUEST))?;
    let m: AutosaveWriteMeta = meta_of(meta)?;
    sessions::write(d, &m.session, m.gen, &m.meta, parts[0])
}

pub fn args_read_work(d: &Dirs, a: &WorkArgs) -> Result<Vec<u8>, Refusal> {
    ops::read_work(d, &a.album, &a.name)
}

pub fn args_find_works(d: &Dirs, a: &FindArgs) -> Result<Vec<FoundWork>, Refusal> {
    find::find_works(d, a.work_id.as_deref(), a.fingerprint.as_ref())
}

pub fn none_resume(d: &Dirs, h: &mut dyn Hooks) -> Result<Vec<evac::ResumeItem>, Refusal> {
    let _guard = lock_lib();
    evac::resume_all(d, h)
}

pub fn args_rename_work(d: &Dirs, a: &RenameWorkArgs) -> Result<WorkPlace, Refusal> {
    ops::rename_work(d, &a.album, &a.name, &a.new_name)
}

pub fn args_move_work(d: &Dirs, a: &MoveWorkArgs) -> Result<WorkPlace, Refusal> {
    ops::move_work(d, &a.album, &a.name, &a.dest_album)
}

pub fn args_create_album(d: &Dirs, a: &AlbumNameArgs) -> Result<AlbumPlace, Refusal> {
    ops::create_album(d, &a.name)
}

pub fn args_rename_album(d: &Dirs, a: &RenameAlbumArgs) -> Result<AlbumPlace, Refusal> {
    ops::rename_album(d, &a.album, &a.new_name)
}

pub fn none_free_space(d: &Dirs) -> Result<FreeSpace, Refusal> {
    ops::free_space(d)
}

pub fn none_autosave_next_gen() -> u64 {
    sessions::next_gen()
}

pub fn none_autosave_list(d: &Dirs) -> Vec<SessionEntry> {
    sessions::list(d)
}

pub fn args_autosave_read(d: &Dirs, a: &SessionArgs) -> Result<Vec<u8>, Refusal> {
    sessions::read(d, &a.session)
}

pub fn args_autosave_delete(d: &Dirs, a: &SessionGenArgs) -> Result<(), Refusal> {
    sessions::delete(d, &a.session, a.gen)
}

pub fn args_autosave_claim(a: &SessionGenArgs) -> Result<(), Refusal> {
    sessions::claim(&a.session, a.gen)
}

pub fn args_library_init(d: &Dirs, a: &LibraryInitArgs) -> Result<LibraryInit, Refusal> {
    init::init_library(d, &a.album, None)
}

// ---------------- V212 (M-1c・D-M1-3): Android の分けて送る・受け取る道の 1 段 ----------------
// ★そろってから今の 1 段（body_save_new・body_save_overwrite・body_autosave_write・args_read_work・args_autosave_read）へ渡すだけ。
//  封筒の検査・空きの決まり・原子的な置き方・512MiB の門番・置き場の切り替えは今の 1 段がそのまま行う

pub fn args_chunk_begin(d: &Dirs, a: &ChunkBeginArgs) -> Result<String, Refusal> {
    let kind = chunks::Kind::parse(&a.kind).ok_or(Refusal(code::BAD_REQUEST))?;
    chunks::begin(d, kind, a.total, a.session.as_deref(), a.gen)
}

pub fn args_chunk_put(d: &Dirs, a: &ChunkPutArgs) -> Result<(), Refusal> {
    chunks::put(d, &a.upload, a.index, &a.data)
}

pub fn args_chunk_save_new(d: &Dirs, a: &UploadArgs, h: &mut dyn Hooks) -> Result<SaveResult, Refusal> {
    let t = chunks::take(d, &a.upload, chunks::Kind::SaveNew)?;
    body_save_new(d, &t.body, h)
}

pub fn args_chunk_save_overwrite(d: &Dirs, a: &UploadArgs, h: &mut dyn Hooks) -> Result<SaveResult, Refusal> {
    let t = chunks::take(d, &a.upload, chunks::Kind::SaveOverwrite)?;
    body_save_overwrite(d, &t.body, h)
}

pub fn args_chunk_autosave_write(d: &Dirs, a: &UploadArgs) -> Result<(), Refusal> {
    let t = chunks::take(d, &a.upload, chunks::Kind::Autosave)?;
    // ★始めたときの番号と世代が、封筒の印と同じときだけ（違うセッション・世代の塊を混ぜない）
    let (meta, _) = crate::parse_save_envelope(&t.body, 1).map_err(|_| Refusal(code::BAD_REQUEST))?;
    let m: AutosaveWriteMeta = meta_of(meta)?;
    if t.session.as_deref() != Some(m.session.as_str()) || t.gen != Some(m.gen) {
        return Err(Refusal(code::BAD_REQUEST));
    }
    body_autosave_write(d, &t.body)
}

pub fn args_chunk_abort(a: &UploadArgs) -> Result<(), Refusal> {
    chunks::abort(&a.upload);
    Ok(())
}

pub fn args_read_begin(d: &Dirs, a: &ReadBeginArgs) -> Result<chunks::ReadHandle, Refusal> {
    match (a.kind.as_str(), &a.album, &a.name, &a.session) {
        ("work", Some(album), Some(name), None) => {
            let bytes = args_read_work(d, &WorkArgs { album: album.clone(), name: name.clone() })?;
            Ok(chunks::read_begin(chunks::READ_WORK, bytes))
        }
        ("autosave", None, None, Some(session)) => {
            let bytes = args_autosave_read(d, &SessionArgs { session: session.clone() })?;
            Ok(chunks::read_begin(chunks::READ_AUTOSAVE, bytes))
        }
        _ => Err(Refusal(code::BAD_REQUEST)),
    }
}

pub fn args_read_slice(a: &ReadSliceArgs) -> Result<Vec<u8>, Refusal> {
    chunks::read_slice(&a.download, a.offset, a.len)
}

pub fn args_read_end(a: &DownloadArgs) -> Result<(), Refusal> {
    chunks::read_end(&a.download);
    Ok(())
}

// ---------------- 薄い皮（Tauri の命令） ----------------

/// ★ライブラリの場所（毎回 OS から取る・保存しない＝決-4）。iOS は Documents・Android は app_data_dir の下の library。モバイルだけ
pub fn library_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // V211: 確かめ画面で試験用のライブラリを開いている間は、そこ（ビルドの印の中だけ・開いているかの正は Rust の状態）
    #[cfg(feature = "mobile-devcheck")]
    {
        use tauri::Manager;
        if let Ok(c) = app.path().app_config_dir() {
            if let Some((lib, _)) = super::devcheck::open_paths(&c) {
                return Ok(lib);
            }
        }
    }
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        app.path().document_dir().map_err(|_| code::IO.to_string())
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.path().app_data_dir().map(|p| p.join("library")).map_err(|_| code::IO.to_string())
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = app;
        Err(code::UNSUPPORTED.to_string())
    }
}

/// 置き場を OS から取る（ライブラリ・app_config_dir の下のオートセーブと退避先とログ）
pub fn dirs_from_app(app: &tauri::AppHandle) -> Result<Dirs, String> {
    use tauri::Manager;
    let lib = library_root(app)?;
    let config = app.path().app_config_dir().map_err(|_| code::IO.to_string())?;
    // V211: 試験用のライブラリを開いている間は、オートセーブ・退避先・ログ・設定も全部試験用の側（本物の側に 1 バイトも書かない）
    #[cfg(feature = "mobile-devcheck")]
    return Ok(super::devcheck::switched(lib, &config));
    #[cfg(not(feature = "mobile-devcheck"))]
    Ok(Dirs::under(lib, &config))
}

/// 保存の命令が渡す手（製品＝印の無いビルドは本物の手だけ。確かめ画面の印のあるビルドは、試験用のライブラリでだけ止める口）
#[cfg(not(feature = "mobile-devcheck"))]
fn save_hooks(_d: &Dirs) -> NoHooks {
    NoHooks
}
#[cfg(feature = "mobile-devcheck")]
fn save_hooks(d: &Dirs) -> super::devcheck::DevHooks {
    super::devcheck::DevHooks::for_save(d)
}

#[tauri::command]
pub fn mobile_save_new(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<SaveResult, String> {
    let d = dirs_from_app(&app)?;
    let body = crate::raw_body(&request).map_err(|_| code::BAD_REQUEST.to_string())?;
    body_save_new(&d, body, &mut save_hooks(&d)).map_err(String::from)
}

#[tauri::command]
pub fn mobile_save_overwrite(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<SaveResult, String> {
    let d = dirs_from_app(&app)?;
    let body = crate::raw_body(&request).map_err(|_| code::BAD_REQUEST.to_string())?;
    body_save_overwrite(&d, body, &mut save_hooks(&d)).map_err(String::from)
}

#[tauri::command]
pub fn mobile_read_work(app: tauri::AppHandle, args: WorkArgs) -> Result<tauri::ipc::Response, String> {
    let d = dirs_from_app(&app)?;
    args_read_work(&d, &args).map(tauri::ipc::Response::new).map_err(String::from)
}

#[tauri::command]
pub fn mobile_find_works(app: tauri::AppHandle, args: FindArgs) -> Result<Vec<FoundWork>, String> {
    let d = dirs_from_app(&app)?;
    args_find_works(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_resume(app: tauri::AppHandle) -> Result<Vec<evac::ResumeItem>, String> {
    let d = dirs_from_app(&app)?;
    none_resume(&d, &mut NoHooks).map_err(String::from)
}

#[tauri::command]
pub fn mobile_rename_work(app: tauri::AppHandle, args: RenameWorkArgs) -> Result<WorkPlace, String> {
    let d = dirs_from_app(&app)?;
    args_rename_work(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_move_work(app: tauri::AppHandle, args: MoveWorkArgs) -> Result<WorkPlace, String> {
    let d = dirs_from_app(&app)?;
    args_move_work(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_create_album(app: tauri::AppHandle, args: AlbumNameArgs) -> Result<AlbumPlace, String> {
    let d = dirs_from_app(&app)?;
    args_create_album(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_rename_album(app: tauri::AppHandle, args: RenameAlbumArgs) -> Result<AlbumPlace, String> {
    let d = dirs_from_app(&app)?;
    args_rename_album(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_free_space(app: tauri::AppHandle) -> Result<FreeSpace, String> {
    let d = dirs_from_app(&app)?;
    none_free_space(&d).map_err(String::from)
}

#[tauri::command]
pub fn mobile_library_root(app: tauri::AppHandle) -> Result<String, String> {
    library_root(&app).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn mobile_autosave_next_gen() -> u64 {
    none_autosave_next_gen()
}

#[tauri::command]
pub fn mobile_autosave_write(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let d = dirs_from_app(&app)?;
    let body = crate::raw_body(&request).map_err(|_| code::BAD_REQUEST.to_string())?;
    body_autosave_write(&d, body).map_err(String::from)
}

#[tauri::command]
pub fn mobile_autosave_list(app: tauri::AppHandle) -> Result<Vec<SessionEntry>, String> {
    let d = dirs_from_app(&app)?;
    Ok(none_autosave_list(&d))
}

#[tauri::command]
pub fn mobile_autosave_read(app: tauri::AppHandle, args: SessionArgs) -> Result<tauri::ipc::Response, String> {
    let d = dirs_from_app(&app)?;
    args_autosave_read(&d, &args).map(tauri::ipc::Response::new).map_err(String::from)
}

#[tauri::command]
pub fn mobile_autosave_delete(app: tauri::AppHandle, args: SessionGenArgs) -> Result<(), String> {
    let d = dirs_from_app(&app)?;
    args_autosave_delete(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_autosave_claim(args: SessionGenArgs) -> Result<(), String> {
    args_autosave_claim(&args).map_err(String::from)
}

/// V211 (§6-2): ライブラリを作り終える（初めての起動・途中で止まった続き）。場所は OS から（JS からは既定のアルバムの名前だけ）
#[tauri::command]
pub fn mobile_library_init(app: tauri::AppHandle, args: LibraryInitArgs) -> Result<LibraryInit, String> {
    let d = dirs_from_app(&app)?;
    args_library_init(&d, &args).map_err(String::from)
}

// ---------------- V212 (M-1c): Android だけで登録する命令（mobile_app.rs の #[cfg(target_os = "android")] の中）----------------

#[tauri::command]
pub fn mobile_chunk_begin(app: tauri::AppHandle, args: ChunkBeginArgs) -> Result<String, String> {
    let d = dirs_from_app(&app)?;
    args_chunk_begin(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_chunk_put(app: tauri::AppHandle, args: ChunkPutArgs) -> Result<(), String> {
    let d = dirs_from_app(&app)?;
    args_chunk_put(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_chunk_save_new(app: tauri::AppHandle, args: UploadArgs) -> Result<SaveResult, String> {
    let d = dirs_from_app(&app)?;
    args_chunk_save_new(&d, &args, &mut save_hooks(&d)).map_err(String::from)
}

#[tauri::command]
pub fn mobile_chunk_save_overwrite(app: tauri::AppHandle, args: UploadArgs) -> Result<SaveResult, String> {
    let d = dirs_from_app(&app)?;
    args_chunk_save_overwrite(&d, &args, &mut save_hooks(&d)).map_err(String::from)
}

#[tauri::command]
pub fn mobile_chunk_autosave_write(app: tauri::AppHandle, args: UploadArgs) -> Result<(), String> {
    let d = dirs_from_app(&app)?;
    args_chunk_autosave_write(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_chunk_abort(args: UploadArgs) -> Result<(), String> {
    args_chunk_abort(&args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_read_begin(app: tauri::AppHandle, args: ReadBeginArgs) -> Result<chunks::ReadHandle, String> {
    let d = dirs_from_app(&app)?;
    args_read_begin(&d, &args).map_err(String::from)
}

#[tauri::command]
pub fn mobile_read_slice(args: ReadSliceArgs) -> Result<tauri::ipc::Response, String> {
    args_read_slice(&args).map(tauri::ipc::Response::new).map_err(String::from)
}

#[tauri::command]
pub fn mobile_read_end(args: DownloadArgs) -> Result<(), String> {
    args_read_end(&args).map_err(String::from)
}

/// V212: 前の起動の塊を片付ける（Android の setup が起動のたびに呼ぶ。試験用のライブラリは起動のたびに閉じるので、ここは本物の置き場。
/// 試験用の置き場は、次に始めるときに `chunks::begin` が片付ける）
pub fn sweep_chunks(app: &tauri::AppHandle) {
    if let Ok(d) = dirs_from_app(app) {
        chunks::sweep(&d);
    }
}

/// ★Android だけの命令の名前（contract.json の androidCommands と同じ並び・登録は mobile_app.rs の Android の区切り）
pub const ANDROID_COMMANDS: &[&str] = &[
    "mobile_chunk_begin",
    "mobile_chunk_put",
    "mobile_chunk_save_new",
    "mobile_chunk_save_overwrite",
    "mobile_chunk_autosave_write",
    "mobile_chunk_abort",
    "mobile_read_begin",
    "mobile_read_slice",
    "mobile_read_end",
];

/// ★モバイルの命令の名前（contract.json の commands と同じ並び・contract.rs が [`handler`] の字と突き合わせる）
pub const COMMANDS: &[&str] = &[
    "mobile_save_new",
    "mobile_save_overwrite",
    "mobile_read_work",
    "mobile_find_works",
    "mobile_resume",
    "mobile_rename_work",
    "mobile_move_work",
    "mobile_create_album",
    "mobile_rename_album",
    "mobile_free_space",
    "mobile_library_root",
    "mobile_autosave_next_gen",
    "mobile_autosave_write",
    "mobile_autosave_list",
    "mobile_autosave_read",
    "mobile_autosave_delete",
    "mobile_autosave_claim",
    "mobile_library_init",
];

/// ★モバイルの登録の表。run() へつなぐのは M-1b（`.invoke_handler(pclib::mobile::commands::handler())`）。
/// PC の run() と登録の表（lib.rs）は変えていない
#[cfg(any(mobile, test))]
pub fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        mobile_save_new,
        mobile_save_overwrite,
        mobile_read_work,
        mobile_find_works,
        mobile_resume,
        mobile_rename_work,
        mobile_move_work,
        mobile_create_album,
        mobile_rename_album,
        mobile_free_space,
        mobile_library_root,
        mobile_autosave_next_gen,
        mobile_autosave_write,
        mobile_autosave_list,
        mobile_autosave_read,
        mobile_autosave_delete,
        mobile_autosave_claim,
        mobile_library_init
    ]
}

// ---------------- 検査の実行ファイルの入口（製品のビルドには入らない） ----------------

/// 皮の下の 1 段の戻り（JSON か生のバイト列）
#[cfg(any(test, feature = "mobile-harness"))]
pub enum Reply {
    Json(serde_json::Value),
    Raw(Vec<u8>),
}

/// ★検査用の実行ファイルが、命令と**同じ 1 段**を名前で呼ぶ。`payload` は JS が invoke に渡した物（`{args: {...}}`）、
/// `body` は生のボディ（作品のバイト列を運ぶ命令）。置き場は検査が作った [`Dirs`]
#[cfg(any(test, feature = "mobile-harness"))]
pub fn dispatch(d: &Dirs, cmd: &str, payload: &serde_json::Value, body: &[u8], h: &mut dyn Hooks) -> Result<Reply, String> {
    fn args<T: for<'de> Deserialize<'de>>(payload: &serde_json::Value) -> Result<T, String> {
        // Tauri と同じく、命令の引数 `args` を JS の物の同じ名前の欄から受ける
        serde_json::from_value(payload.get("args").cloned().unwrap_or(serde_json::Value::Null)).map_err(|_| code::BAD_REQUEST.to_string())
    }
    fn json<T: Serialize>(r: Result<T, Refusal>) -> Result<Reply, String> {
        r.map(|v| Reply::Json(serde_json::to_value(v).unwrap_or(serde_json::Value::Null))).map_err(String::from)
    }
    match cmd {
        "mobile_save_new" => json(body_save_new(d, body, h)),
        "mobile_save_overwrite" => json(body_save_overwrite(d, body, h)),
        "mobile_read_work" => args_read_work(d, &args::<WorkArgs>(payload)?).map(Reply::Raw).map_err(String::from),
        "mobile_find_works" => json(args_find_works(d, &args::<FindArgs>(payload)?)),
        "mobile_resume" => json(none_resume(d, h)),
        "mobile_rename_work" => json(args_rename_work(d, &args::<RenameWorkArgs>(payload)?)),
        "mobile_move_work" => json(args_move_work(d, &args::<MoveWorkArgs>(payload)?)),
        "mobile_create_album" => json(args_create_album(d, &args::<AlbumNameArgs>(payload)?)),
        "mobile_rename_album" => json(args_rename_album(d, &args::<RenameAlbumArgs>(payload)?)),
        "mobile_free_space" => json(none_free_space(d)),
        "mobile_library_root" => Err(code::UNSUPPORTED.to_string()),
        "mobile_autosave_next_gen" => Ok(Reply::Json(serde_json::json!(none_autosave_next_gen()))),
        "mobile_autosave_write" => json(body_autosave_write(d, body)),
        "mobile_autosave_list" => json(Ok::<_, Refusal>(none_autosave_list(d))),
        "mobile_autosave_read" => args_autosave_read(d, &args::<SessionArgs>(payload)?).map(Reply::Raw).map_err(String::from),
        "mobile_autosave_delete" => json(args_autosave_delete(d, &args::<SessionGenArgs>(payload)?)),
        "mobile_autosave_claim" => json(args_autosave_claim(&args::<SessionGenArgs>(payload)?)),
        "mobile_library_init" => json(args_library_init(d, &args::<LibraryInitArgs>(payload)?)),
        // V212: Android の分けて送る・受け取る道（検査は命令と同じ 1 段を呼ぶ）
        "mobile_chunk_begin" => json(args_chunk_begin(d, &args::<ChunkBeginArgs>(payload)?)),
        "mobile_chunk_put" => json(args_chunk_put(d, &args::<ChunkPutArgs>(payload)?)),
        "mobile_chunk_save_new" => json(args_chunk_save_new(d, &args::<UploadArgs>(payload)?, h)),
        "mobile_chunk_save_overwrite" => json(args_chunk_save_overwrite(d, &args::<UploadArgs>(payload)?, h)),
        "mobile_chunk_autosave_write" => json(args_chunk_autosave_write(d, &args::<UploadArgs>(payload)?)),
        "mobile_chunk_abort" => json(args_chunk_abort(&args::<UploadArgs>(payload)?)),
        "mobile_read_begin" => json(args_read_begin(d, &args::<ReadBeginArgs>(payload)?)),
        "mobile_read_slice" => args_read_slice(&args::<ReadSliceArgs>(payload)?).map(Reply::Raw).map_err(String::from),
        "mobile_read_end" => json(args_read_end(&args::<DownloadArgs>(payload)?)),
        _ => Err("unknown-command".to_string()),
    }
}
