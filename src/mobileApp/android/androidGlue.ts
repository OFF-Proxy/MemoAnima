// V224 (A-4): Android の戻るボタンを Tauri につなぐ（app.ts が Android のときだけ動的 import する）。
//
// - 受けるのは `@tauri-apps/api/app` の `onBackButtonPress`（2.9.0 から。登録すると、既定の動き〔WebView の戻る・Activity を閉じる〕を
//   アプリが引き取る＝Activity を壊さない。V212 で、Activity が壊れたあとネイティブで落ちていた〔API 36 は FORTIFY・API 30 は SIGSEGV〕）。
//   権限は capabilities/mobile.json の core:default に入っている core:app:default の allow-register-listener（新しい capability は要らない）
// - 裏へ回すのは Android だけの命令 `mobile_move_task_to_back`（Rust が JNI で Activity の moveTaskToBack(true) を呼ぶ）
// - 画面の手の登録は backButton.ts の BackRouter（描く画面の登録は devlist/devList.ts の WorkScreen を作る所）
import { onBackButtonPress } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { BackRouter, setBackRouter } from "./backButton";

let router: BackRouter | null = null;

/** 戻るボタンを受け始める（何度呼んでも 1 つ）。登録できなければ null（既定の動きのまま＝記録に 1 行） */
export async function installAndroidBack(log: (line: string) => void): Promise<BackRouter | null> {
  if (router) return router;
  const r = new BackRouter({ moveToBack: async () => void (await invoke("mobile_move_task_to_back")), log });
  try {
    await onBackButtonPress(() => void r.press());
  } catch {
    log("[V224] back-button listener refused");
    return null;
  }
  // ★V226: Activity が作り直されたあとは、上の受け口（Tauri の AppPlugin）に戻るボタンが来ない（新しい Activity に付かない）。
  //  そのときは MainActivity.kt の最後の受け手が、この口を呼ぶ（置いていなければ裏へ回す＝古い WebView の画面・起動の途中）
  (window as unknown as { __mbAndroidBack?: () => void }).__mbAndroidBack = () => void r.press();
  router = r;
  setBackRouter(r);
  return r;
}
