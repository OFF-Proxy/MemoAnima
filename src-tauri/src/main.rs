// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// M7-3 P-2: WebView2 ランタイムの存在チェック（WebView 生成前・ネイティブ側）。
/// 見つからない場合のみ案内ダイアログを出して終了する。自動ダウンロードはしない（オフライン不変条件）。
/// 判定は控えめ（確認手段自体が失敗したら「有り」とみなして起動を続ける＝誤ブロックしない）。
#[cfg(windows)]
fn webview2_available() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // 検証用: 未搭載環境を模擬して案内ダイアログの表示を確認する（M7-3 P-4・通常運用では未設定）
    if std::env::var_os("MEMOANIMA_SIMULATE_NO_WEBVIEW2").is_some() {
        return false;
    }
    // Evergreen ランタイムのクライアント登録（per-machine 64/32bit・per-user）
    const KEYS: [&str; 3] = [
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    let mut all_queries_ran = true;
    for key in KEYS {
        match std::process::Command::new("reg")
            .args(["query", key, "/v", "pv"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(out) if out.status.success() => return true,
            Ok(_) => {}
            Err(_) => all_queries_ran = false,
        }
    }
    // インストールフォルダの実在でも判定（レジストリ検査の取りこぼし保険）
    for env in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Ok(base) = std::env::var(env) {
            if std::path::Path::new(&base)
                .join(r"Microsoft\EdgeWebView\Application")
                .is_dir()
            {
                return true;
            }
        }
    }
    // 確認手段が動かなかった場合は誤ブロックを避けて「有り」とみなす
    !all_queries_ran
}

#[cfg(windows)]
fn show_webview2_notice() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let msg = "メモアニマの実行には Microsoft Edge WebView2 ランタイムが必要です。\n\
通常は Windows 10/11 に搭載されていますが、このPCでは見つかりませんでした。\n\n\
Microsoft の配布ページから「Evergreen ブートストラップ」をインストールしてから、もう一度起動してください:\n\
https://developer.microsoft.com/ja-jp/microsoft-edge/webview2/\n\n\
（本アプリは通信・自動ダウンロードを行わないため、インストールはお手数ですが手動でお願いします）";
    // メッセージは環境変数で渡す（クォート事故を避ける）
    let _ = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; \
             [System.Windows.Forms.MessageBox]::Show($env:MEMOANIMA_MSG, 'メモアニマ (MemoAnima)') | Out-Null",
        ])
        .env("MEMOANIMA_MSG", msg)
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

fn main() {
    #[cfg(windows)]
    if !webview2_available() {
        show_webview2_notice();
        return;
    }
    animemo_lib::run()
}
