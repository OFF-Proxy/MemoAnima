//! V211 (M-1b・要件 docs/REQ_mobile_m1_base.md §6): モバイル（iOS）の入口 `run()` と、**モバイルの登録の表**。
//!
//! ★デスクトップの `run()` と登録の表（lib.rs の generate_handler!・45 本）は並びも中身も変えていない。モバイルはこの別の表だけ
//!  （scripts/v211_smoke.ts [R] が字で見る）。
//! ★出すのは、モバイルの命令（`pclib::mobile::commands`）と、PC の命令の `app_info`（版と OS・場所を受けない）だけ。
//!  ★V224: 場所を JS から受ける PC の命令 7 本は外し、Rust が場所を決めるライブラリの命令（`mobile_library_*` ほか）に置き換えた。
//!  設定とログの PC の命令（load_settings・save_settings・append_log）は、確かめ画面が使わないので出さない
//!  （いつも本物の app_config_dir に書く＝試験用のライブラリの切り替えを通らない・lock_lib も取らない＝第三者レビュー L1。要るなら M-2 で
//!  dirs_from_app と鍵を通すモバイルの口を作る）。PC の保存・移す・名前を変える・アルバムを作る・取り込む命令は出さない
//!  （モバイルは `mobile_*` で。PC の命令は指紋の確かめ・置き換えない置き方・オートセーブの印を直すことをしない）。
//! ★updater・Discord・dialog・opener はモバイルでは組み立てない・登録しない（フォルダを選ぶ画面も外のアプリで開くことも使わない）。
//! ★確かめ画面の命令（`pclib::mobile::devcheck`）は、ビルドの印（cargo の feature `mobile-devcheck`）の中だけ。
//! ★V220 (L6): `lib.rs` の頭の `allow(dead_code)` を、このモジュールでは戻す（PC の lib.rs は変えない）。

#![cfg_attr(mobile, warn(dead_code))]

use crate::pclib::mobile::commands::*;

/// モバイルの登録の表（デスクトップの表とは別）
fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // モバイルの命令（21＝V202 の 17＋ライブラリを作り終える 1＋V220 の設定とログの口 3・contract.json の commands と同じ並び）
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
        // V220 (M-2b-1b・決-17): 設定とログの口（PC の load_settings・save_settings・append_log の代わり＝V211 の L1）
        mobile_settings_read,
        mobile_settings_merge,
        mobile_log_append,
        // V224 (M-2c・V211b の F2): ライブラリの命令（場所は Rust が決める。PC の命令 7 本の代わり＝contract.json の commands と同じ並び）
        mobile_library_list,
        mobile_library_stamp,
        mobile_thumb_read,
        mobile_thumb_write,
        mobile_work_peek,
        mobile_delete_work,
        mobile_delete_album,
        mobile_recoverable_list,
        mobile_recover,
        // V229 (M-4): 出し入れ（iOS と Android の両方。ネイティブの画面は Android だけ・iOS は unsupported）
        mobile_io_cleanup,
        mobile_out_begin,
        mobile_out_write,
        mobile_out_write_raw,
        mobile_out_finish,
        mobile_out_abort,
        mobile_out_work,
        mobile_out_share,
        mobile_out_save,
        mobile_in_pick,
        mobile_in_received,
        mobile_in_sniff,
        mobile_in_import,
        mobile_in_read,
        mobile_in_discard,
        mobile_export_all_begin,
        mobile_export_all_status,
        mobile_export_all_cancel,
        mobile_library_notes,
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
        // V224 (A-4・D-M1-7): 戻るボタンで Activity を壊さずに裏へ回す（JNI の moveTaskToBack）
        #[cfg(target_os = "android")]
        mobile_move_task_to_back,
        // PC の命令は app_info だけ（場所を受けない）。★V224: 場所を JS から受ける PC の命令 7 本（read_file_raw・list_albums・scan_library・
        //  list_recoverable・recover_project・delete_note・delete_album）は外した（V211b の F2・scripts/v224_smoke.ts [R]）
        crate::app_info,
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
    // ★V229 (M-4): iOS も起動のとき一時の場所を片付ける（Android は下の setup の中）
    #[cfg(target_os = "ios")]
    let builder = builder.setup(|app| {
        sweep_io(app.handle());
        Ok(())
    });
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app| {
        sweep_chunks(app.handle());
        // ★V229 (M-4): 出し入れの一時の場所の書きかけ（止められた書き出し・取り込み）と 24 時間より古いものを片付ける
        sweep_io(app.handle());
        Ok(())
    });
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
