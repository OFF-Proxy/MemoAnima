// V211 (M-1b): モバイル（iOS）の画面のビルド。PC の vite.config.ts・index.html・dist/ とは別（X3＝PC の出力は 1 バイトも変えない）。
//
// - 入口は mobile.html → src/mobileApp/entry.ts（PC の main.ts・library.ts・editor.ts・discordPresence.ts と、updater・dialog・opener の
//   プラグインの JS は読まない＝scripts/v211_smoke.ts [E]）。出力は dist-mobile/（tauri.ios.conf.json の frontendDist）
// - ★確かめ画面（開発用）はビルドの印で入れる: 環境変数 MEMOANIMA_MOBILE_DEVCHECK=1 のときだけ __MOBILE_DEVCHECK__ が true になり、
//   確かめ画面の部品が出力に入る（false なら呼ぶ所ごと消える＝v211 [D]）。Rust の側は cargo の feature `mobile-devcheck`
//   （scripts/mobile_build.ts が両方を同じ引数で立てる）
// - V220 (M-2b-1b・D-M1-8): 構文の的と CSS の的は Chrome 111 と Safari 18.2（Android の WebView の下限 111・iPadOS の下限）。
//   PC の vite.config.ts は変えない（PC の出力は 1 バイトも変えない＝X3）。下限ちょうどの WebView での確かめは M-2b-4
// - V220 (UI §3-5): 開発用のアイコンの頁（src/mobileApp/devpages/icons.html）は、印のビルドのときだけ入口に足す
//   （印なしの出力 dist-mobile/ には入らない＝v220 [N]）。開発サーバではいつでも開ける
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const devcheck = process.env.MEMOANIMA_MOBILE_DEVCHECK === "1";
const host = process.env.TAURI_DEV_HOST;

/** V220: 構文の的と CSS の的（D-M1-8） */
export const MOBILE_TARGETS = ["chrome111", "safari18.2"];

export default defineConfig({
  clearScreen: false,
  define: {
    __MOBILE_DEVCHECK__: JSON.stringify(devcheck),
  },
  build: {
    outDir: "dist-mobile",
    emptyOutDir: true,
    target: MOBILE_TARGETS,
    cssTarget: MOBILE_TARGETS,
    rollupOptions: {
      input: {
        mobile: fileURLToPath(new URL("./mobile.html", import.meta.url)),
        ...(devcheck ? { devicons: fileURLToPath(new URL("./src/mobileApp/devpages/icons.html", import.meta.url)) } : {}),
        // ★V221 (C8): F2 を WebKit で走らせる頁（印のビルドだけ＝v221 [S]）
        ...(devcheck ? { devf2: fileURLToPath(new URL("./src/mobileApp/devcheck/f2/f2.html", import.meta.url)) } : {}),
      },
    },
  },
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
