//! V211 (M-1b・要件 docs/REQ_mobile_m1_base.md §6): モバイル（iOS）の入口 `run()` と、**モバイルの登録の表**。
//!
//! ★デスクトップの `run()` と登録の表（lib.rs の generate_handler!・45 本）は並びも中身も変えていない。モバイルはこの別の表だけ
//!  （scripts/v211_smoke.ts [R] が字で見る）。
//! ★出すのは、モバイルの命令（`pclib::mobile::commands`）と、確かめ画面が使う PC の命令のうち要るものだけ
//!  （読む・一覧・復元の候補・削除）。設定とログの PC の命令（load_settings・save_settings・append_log）は、確かめ画面が使わないので出さない
//!  （いつも本物の app_config_dir に書く＝試験用のライブラリの切り替えを通らない・lock_lib も取らない＝第三者レビュー L1。要るなら M-2 で
//!  dirs_from_app と鍵を通すモバイルの口を作る）。PC の保存・移す・名前を変える・アルバムを作る・取り込む命令は出さない
//!  （モバイルは `mobile_*` で。PC の命令は指紋の確かめ・置き換えない置き方・オートセーブの印を直すことをしない）。
//!  PC の命令は場所（lib_root）を JS から受けるので、JS は `mobile_library_root` で受け取った場所を渡す（覚えない・保存しない＝決-4）。
//! ★updater・Discord・dialog・opener はモバイルでは組み立てない・登録しない（フォルダを選ぶ画面も外のアプリで開くことも使わない）。
//! ★確かめ画面の命令（`pclib::mobile::devcheck`）は、ビルドの印（cargo の feature `mobile-devcheck`）の中だけ。

use crate::pclib::mobile::commands::*;

/// モバイルの登録の表（デスクトップの表とは別）
fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // モバイルの命令（18＝V202 の 17＋ライブラリを作り終える 1・contract.json の commands と同じ並び）
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
        mobile_library_init,
        // V212 (M-1c・D-M1-3): Android だけ。invoke はいつも postMessage で、生のボディ・生のバイト列の大きい渡しが使えないので、
        //  分けて送る（base64 の塊・4MiB 以下）・分けて受け取る（4MiB 以下の切れ端）。iOS の表は変えない（commands::ANDROID_COMMANDS と同じ並び）
        #[cfg(target_os = "android")]
        mobile_chunk_begin,
        #[cfg(target_os = "android")]
        mobile_chunk_put,
        #[cfg(target_os = "android")]
        mobile_chunk_save_new,
        #[cfg(target_os = "android")]
        mobile_chunk_save_overwrite,
        #[cfg(target_os = "android")]
        mobile_chunk_autosave_write,
        #[cfg(target_os = "android")]
        mobile_chunk_abort,
        #[cfg(target_os = "android")]
        mobile_read_begin,
        #[cfg(target_os = "android")]
        mobile_read_slice,
        #[cfg(target_os = "android")]
        mobile_read_end,
        // 確かめ画面が使う PC の命令（場所は mobile_library_root で受け取ったものを JS が渡す）
        crate::app_info,
        crate::read_file_raw,
        crate::list_albums,
        crate::scan_library,
        crate::list_recoverable,
        crate::recover_project,
        crate::delete_note,
        crate::delete_album,
        // 確かめ画面（開発用）の命令: ビルドの印の中だけ
        #[cfg(feature = "mobile-devcheck")]
        crate::pclib::mobile::devcheck::commands::mobile_dev_state,
        #[cfg(feature = "mobile-devcheck")]
        crate::pclib::mobile::devcheck::commands::mobile_dev_open_test_library,
        #[cfg(feature = "mobile-devcheck")]
        crate::pclib::mobile::devcheck::commands::mobile_dev_close_test_library,
        #[cfg(feature = "mobile-devcheck")]
        crate::pclib::mobile::devcheck::commands::mobile_dev_fault,
        #[cfg(feature = "mobile-devcheck")]
        crate::pclib::mobile::devcheck::commands::mobile_dev_log,
        #[cfg(feature = "mobile-devcheck")]
        crate::pclib::mobile::devcheck::commands::mobile_dev_log_tail
    ]
}

#[tauri::mobile_entry_point]
pub fn run() {
    let builder = tauri::Builder::default().invoke_handler(handler());
    // ★WebView の中身だけが落ちたとき（メモリが足りない等）: wry 0.57.1 は読み込み直さない（Tauri 2.12.5 はこの口を使ったときだけ
    //  知らせる）＝そのままでは真っ白で止まる。読み込み直して、起動と同じ道で復元を提案する（D4）。
    //  この口は macOS にも効くので iOS の中だけに置く（Mac 版のデスクトップの挙動を変えない＝v211 [X] が見る）
    #[cfg(target_os = "ios")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        use tauri::Manager;
        if let Ok(d) = dirs_from_app(webview.app_handle()) {
            crate::pclib::mobile::log_line(&d, "[V211] webview content process terminated; reloading");
        }
        let _ = webview.reload();
    });
    // V212 (M-1c): Android は起動のたびに、前の起動で止まった塊（分けて送る道の置き場）を片付ける
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app| {
        sweep_chunks(app.handle());
        Ok(())
    });
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
