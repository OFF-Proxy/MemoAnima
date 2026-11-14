// V225 (指示書 ■3 の S-3・S-4・N): 設定を画面へ当てる（描く画面とライブラリで同じ口）。
//
// ★配色: `<html>` に data-theme を付けるだけ（色は mobile.css の `:root[data-theme="dark"]`＝変数だけの上書き）。PC の `src/ui/theme.ts` の
//  applyTheme をそのまま使う（PC のファイルは変えない）。OS のダークモードには従わない（PC と同じ）。
// ★起動のときは、最初の画面を描く前に当てる（app.ts が設定を読んだすぐあと＝applyBootSettings）。
import { applyTheme } from "../../ui/theme";
import { detectLang, setLang } from "../../i18n";
import { readMobileSettings, type MobileSettings, type SettingChange } from "./model";

/** 起動のとき（設定を読んだすぐあと・最初の画面の前）: 言語と配色 */
export function applyBootSettings(raw: Record<string, unknown>): MobileSettings {
  setLang(detectLang(raw.lang));
  const s = readMobileSettings(raw);
  applyTheme(s.theme);
  return s;
}

/** 設定の画面で変えたものを、アプリの全体に当てる（配色と言語）。描く画面だけに効くものは描く画面の側 */
export function applyAppSetting(c: SettingChange, now: MobileSettings): void {
  if (c.id === "theme") applyTheme(now.theme);
  if (c.id === "lang") setLang(detectLang(c.value));
}
