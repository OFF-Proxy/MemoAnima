// V211 (M-1b・要件 docs/REQ_mobile_m1_base.md §6-2・§4-6): モバイル（iOS）の画面の入口（mobile.html から）。
//
// ★PC の入口（main.ts）とは別。main.ts・library.ts・editor.ts・discordPresence.ts と、updater・dialog・opener のプラグインの JS は
//  読まない（scripts/v211_smoke.ts [E] が import をたどって見る）。
// ★最初に `app_info` の `os` を受け取って `setPlatformOs` を呼び、**そのあとで**辞書（`t()`）や判定を使うモジュールを動的 import で読む
//  （判定を覚えたあとに渡すと platform.ts が例外で止める＝V201 §7）。ここで静的に読むのは invoke と platform.ts だけ。
import { invoke } from "@tauri-apps/api/core";
import { setPlatformOs, type PlatformOs } from "../platform";

const OS_VALUES: readonly PlatformOs[] = ["windows", "macos", "ios", "android"];

/** ★V224 (D-M1-8): mobile.html の頭の古い書き方の小さいスクリプトが、古い Android System WebView（Chrome 111 未満）で立てる印。
 *  立っていれば何もしない（作品の画面へ進まない・ライブラリを作らない・更新を頼む文を消さない） */
export function oldWebView(w: unknown = globalThis): boolean {
  return Boolean((w as { __MB_OLD_WEBVIEW__?: unknown }).__MB_OLD_WEBVIEW__);
}

async function main(): Promise<void> {
  const info = (await invoke("app_info")) as { version?: unknown; os?: unknown };
  const os = typeof info.os === "string" && (OS_VALUES as readonly string[]).includes(info.os) ? (info.os as PlatformOs) : null;
  if (!os) throw new Error("unknown os");
  setPlatformOs(os);
  const { startMobileApp } = await import("./app");
  await startMobileApp({ os, version: typeof info.version === "string" ? info.version : "" });
}

if (!oldWebView()) main().catch(async () => {
  // 文はそのまま出さない（W-10・決まった値でない断りは「詳しくはログ」）。★V221: 文は辞書を動的に読んで出す（OS を決める前に辞書を
  //  静的に読まない＝v211 [E]）。読み込めないときだけ、短い固定の文（日本語と英語）
  const el = document.getElementById("app");
  if (!el) return;
  let msg = "起動できませんでした / Could not start"; // i18n-exempt: 辞書が読めないときだけの固定の文（指示書 ■2(2)）
  try {
    const { mt } = await import("./i18n");
    msg = mt("mb.boot.failed.msg");
  } catch {
    /* 固定の文のまま */
  }
  el.textContent = msg;
});
