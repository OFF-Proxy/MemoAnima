// V211 (M-1b・要件 docs/REQ_mobile_m1_base.md §6-2・§4-6): モバイル（iOS）の画面の入口（mobile.html から）。
//
// ★PC の入口（main.ts）とは別。main.ts・library.ts・editor.ts・discordPresence.ts と、updater・dialog・opener のプラグインの JS は
//  読まない（scripts/v211_smoke.ts [E] が import をたどって見る）。
// ★最初に `app_info` の `os` を受け取って `setPlatformOs` を呼び、**そのあとで**辞書（`t()`）や判定を使うモジュールを動的 import で読む
//  （判定を覚えたあとに渡すと platform.ts が例外で止める＝V201 §7）。ここで静的に読むのは invoke と platform.ts だけ。
import { invoke } from "@tauri-apps/api/core";
import { setPlatformOs, type PlatformOs } from "../platform";

const OS_VALUES: readonly PlatformOs[] = ["windows", "macos", "ios", "android"];

async function main(): Promise<void> {
  const info = (await invoke("app_info")) as { version?: unknown; os?: unknown };
  const os = typeof info.os === "string" && (OS_VALUES as readonly string[]).includes(info.os) ? (info.os as PlatformOs) : null;
  if (!os) throw new Error("unknown os");
  setPlatformOs(os);
  const { startMobileApp } = await import("./app");
  await startMobileApp({ os, version: typeof info.version === "string" ? info.version : "" });
}

main().catch(() => {
  // 文はそのまま出さない（W-10・決まった値でない断りは「詳しくはログ」）
  const el = document.getElementById("app");
  if (el) el.textContent = "起動できませんでした（詳しくはログ）";
});
