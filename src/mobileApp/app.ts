// V211 (M-1b・要件 §6-2): モバイルの入口の本体（entry.ts が setPlatformOs のあとで動的 import する）。
//
// - 起動したら: ライブラリを作り終えているかを Rust に任せて確かめる（初めてなら、既定のアルバムと空の索引を作り、最後に「作り終えた印」を
//   app_config_dir の設定に書く＝`mobile_library_init`。途中で止まっても次の起動で続きから）→ 止まっていた保全を続ける（`mobile_resume`）
// - 確かめ画面（開発用）はビルドの印（__MOBILE_DEVCHECK__）が立っているときだけ読み込む（立っていなければ呼ぶ所ごと消える＝v211 [D]）
// - 辞書の言語は既定（日本語）のまま。言語の設定はモバイルの設定の画面（M-3）で決める
import { tauriMobilePort } from "../mobile/tauriPort";
import type { LibraryInit, MobilePort, ResumeItem } from "../mobile/port";
import { defaultAlbumName } from "../i18n/defaults";

export interface MobileAppInfo {
  os: string;
  version: string;
}

/** 起動の結果（確かめ画面に出す） */
export interface BootResult {
  port: MobilePort;
  info: MobileAppInfo;
  init: LibraryInit | { error: string };
  resumed: ResumeItem[] | { error: string };
}

/** 断りの値（決まった値ならその値・それ以外は文を出さずに "error"＝W-10・V202 §12 の 18） */
export function refusalText(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") return (e as { code: string }).code;
  return "error";
}

/** ライブラリを作り終える（初めての起動・途中で止まった続き）→ 止まっていた保全を続ける。試験用のライブラリを開いたときも同じ道 */
export async function prepareLibrary(port: MobilePort): Promise<{ init: BootResult["init"]; resumed: BootResult["resumed"] }> {
  let init: BootResult["init"];
  try {
    init = await port.libraryInit(defaultAlbumName());
  } catch (e) {
    init = { error: refusalText(e) };
  }
  let resumed: BootResult["resumed"];
  try {
    resumed = await port.resume();
  } catch (e) {
    resumed = { error: refusalText(e) };
  }
  return { init, resumed };
}

export async function startMobileApp(info: MobileAppInfo): Promise<void> {
  // V212: Android は分けて送る・受け取る口（invoke に大きいバイト列を渡さない）。iOS は今の口のまま
  const port = tauriMobilePort(info.os);
  const { init, resumed } = await prepareLibrary(port);
  const boot: BootResult = { port, info, init, resumed };
  const root = document.getElementById("app")!;
  if (__MOBILE_DEVCHECK__) {
    const { startDevcheck } = await import("./devcheck/screen");
    await startDevcheck(root, boot);
    return;
  }
  // 印の無いビルド: 描く画面とライブラリの画面は M-2。ここではライブラリを用意するだけ
  root.textContent = `メモアニマ（開発中のビルド）${info.version}`;
}
