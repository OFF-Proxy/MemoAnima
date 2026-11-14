// V211 (M-1b・要件 §6-2): モバイルの入口の本体（entry.ts が setPlatformOs のあとで動的 import する）。
//
// - 起動したら: ライブラリを作り終えているかを Rust に任せて確かめる（初めてなら、既定のアルバムと空の索引を作り、最後に「作り終えた印」を
//   app_config_dir の設定に書く＝`mobile_library_init`。途中で止まっても次の起動で続きから）→ 止まっていた保全を続ける（`mobile_resume`）
// - 確かめ画面（開発用）はビルドの印（__MOBILE_DEVCHECK__）が立っているときだけ読み込む（立っていなければ呼ぶ所ごと消える＝v211 [D]）
// - ★V221: 辞書の言語は PC と同じ決め方（設定の lang → 端末の言語 → 英語＝`detectLang`）。設定は Rust が読む口（決-17）。
//   言語を選ぶ画面はモバイルの設定の画面（M-3）
// - ★V225 (M-2c): 起動するとライブラリ（library/libraryScreen.ts）。仮の一覧（devlist/・V221〜V224）は消した
// V220 (M-2b-1b・決-18): 画面の土台（色の変数・画面用の書体・文字のツールの書体）。entry.ts からは読まない（v211 [E]）
import "./mobile.css";
import "./editor/editor.css";
import "./screens.css";
import { applyBootSettings } from "./settings/apply";
import { tauriMobilePort } from "../mobile/tauriPort";
import type { LibraryInit, MobilePort, ResumeItem } from "../mobile/port";
import { defaultAlbumName } from "../i18n/defaults";
import { setAutosaveTiming, type AutosaveTiming } from "./autosaveClock";

/** ★V224 (A-5・D-M1-6): Android の手が止まってから書くまでと、前に書いてから空ける時間（エミュレーターで測って決めた数＝V224 の報告）。
 *  iOS は autosaveClock.ts の定数のまま（2 秒・5 秒＝D-M1-2） */
export const ANDROID_AUTOSAVE_TIMING: AutosaveTiming = { idleMs: 500, gapMs: 3_000 };

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

/** ★V221: 設定を読み、言語を決める（PC と同じ決め方）。読めなければ空の設定（既定）で続ける（描く・保存は止めない） */
export async function readSettings(port: MobilePort): Promise<Record<string, unknown>> {
  let settings: Record<string, unknown> = {};
  try {
    settings = await port.settingsRead();
  } catch {
    void port.logAppend("[V221] settings-read refused").catch(() => {});
  }
  // ★V225 (N・S-4): 言語と配色を、最初の画面を描く前に当てる（設定が読めなければ既定＝明るい紙）。OS のダークモードには従わない
  applyBootSettings(settings);
  return settings;
}

/** ★確かめ画面の印のビルドだけ: 捕まえていない例外の種類と場所をログへ（英数字と記号だけ・作品名とパスを書かない） */
function devErrorLog(port: MobilePort): void {
  const clean = (x: unknown) => String(x ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 180);
  window.addEventListener("error", (e) => void port.logAppend(`[V221 dev] error ${clean(e.message)} @${clean(e.filename?.split("/").pop())}:${e.lineno}:${e.colno}`).catch(() => {}));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as Error | undefined;
    void port.logAppend(`[V221 dev] rejection ${clean(r?.name)} ${clean(r?.message ?? r)} ${clean(r?.stack?.split("\n")[0])} ${clean(r?.stack?.split("\n")[1])}`).catch(() => {});
  });
}

export async function startMobileApp(info: MobileAppInfo): Promise<void> {
  // V212: Android は分けて送る・受け取る口（invoke に大きいバイト列を渡さない）。iOS は今の口のまま
  const port = tauriMobilePort(info.os);
  if (info.os === "android") setAutosaveTiming(ANDROID_AUTOSAVE_TIMING);
  // ★V226 (H-1): Android だけの見た目（当たり 48dp）。印のクラスと Android だけの CSS（iOS では読まない）
  if (info.os === "android") {
    const { applyAndroidLook } = await import("./android/androidLook");
    applyAndroidLook();
  }
  // ★V224 (A-4): Android は戻るボタンをアプリで受ける（Activity を壊さない。登録の無い画面では裏へ回す）
  if (info.os === "android") {
    const { installAndroidBack } = await import("./android/androidGlue");
    await installAndroidBack((line) => void port.logAppend(line).catch(() => {}));
  }
  // ★V221: 既定のアルバムの名前（辞書）より前に言語を決める
  const settings = await readSettings(port);
  const { init, resumed } = await prepareLibrary(port);
  const boot: BootResult = { port, info, init, resumed };
  const root = document.getElementById("app")!;
  if (__MOBILE_DEVCHECK__) devErrorLog(port);
  if (__MOBILE_DEVCHECK__) {
    const { startDevcheck } = await import("./devcheck/screen");
    await startDevcheck(root, boot);
    return;
  }
  // ★V225 (M-2c): 起動するとライブラリ（PC と同じ）。提案 → ライブラリ → 描く画面
  const { startLibrary } = await import("./library/libraryScreen");
  await startLibrary({ port, root, settings, version: info.version, log: (line) => void port.logAppend(line).catch(() => {}) });
}
