// V220 (M-2b-1b・UI §3-5): モバイルの画面のアイコンの器。PC の src/icons/index.ts と同じ属性（viewBox 20・線 1.8・端と角は丸い・
// currentColor）で、束（_bundle.ts＝scripts/gen_mobile_icons.ts の生成物）の中身を包む。実行時に fetch しない（オフライン）。
// ★PC の src/icons/ は読まない（PC の形は束に写してある）。DOM を作らず文字列で返す（画面の側が置き方を決める）。
// ★名前（読み上げ・長押しの名前）は画面の側が辞書から、要素のプロパティで付ける（ここには文言を持たない・訳文を属性の字に
//  埋め込まない＝i18n の検査6 と同じ決まり）。ここが返すのはいつも aria-hidden の飾り。
import { MOBILE_ICON_IDS, MOBILE_ICON_INNER, type MobileIconId } from "./_bundle";

export type { MobileIconId };
export { MOBILE_ICON_IDS };

const ID_SET: ReadonlySet<string> = new Set(MOBILE_ICON_IDS);

export function isMobileIconId(s: string): s is MobileIconId {
  return ID_SET.has(s);
}

/** インライン <svg> の文字列（飾り＝aria-hidden。大きさは px の数だけ） */
export function mobileIconSvg(id: MobileIconId, size?: number): string {
  const sz = typeof size === "number" && Number.isFinite(size) ? ` width="${size}" height="${size}"` : "";
  return (
    `<svg class="mb-icon mb-icon-${id}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"${sz}>${MOBILE_ICON_INNER[id]}</svg>`
  );
}
