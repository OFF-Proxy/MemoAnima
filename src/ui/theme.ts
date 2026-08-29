// V158 (C-1/C-2/C-3): 配色（明るい／夜の紙）の1か所。
//
// ★色の出どころは `styles.css` の `:root` **だけ**にする。
//   画面の大半は CSS 変数がそのまま効くが、**canvas に描く UI**（音声の波形・変形の枠・
//   トーンのスウォッチ）には変数が届かない。そこだけ `uiColor()` で**同じ変数を読む**。
//   各所が `#f07a1a` のように色を持つと、配色を足すたびに拾い漏れが出る（C-2 の要件）。

/** 選べる配色。`"light"` が既定＝これまでの明るい配色。 */
export type Theme = "light" | "dark";

/** 設定から読んだ値を安全な範囲へ。**知らない値・壊れた値は必ず "light"**
 *  （＝設定を消した人も、古い版から上がってきた人も、これまでどおりの見た目で起動する）。 */
export function sanitizeTheme(v: unknown): Theme {
  return v === "dark" ? "dark" : "light";
}

let cache = new Map<string, string>();

/** V158 (C-2): 配色から色を1つ読む（`--orange` のような CSS 変数名で）。
 *
 *  `getComputedStyle` は安くないので**覚えておく**。波形は1フレームに何十回も色を引くので、
 *  毎回問い合わせると描画が目に見えて遅くなる。配色を切り替えたときに `applyTheme` が捨てる。
 *  変数が無いとき（テストや DEV ページで CSS を読んでいない）は `fallback` を返す。 */
export function uiColor(varName: string, fallback = "#000000"): string {
  const hit = cache.get(varName);
  if (hit !== undefined) return hit;
  let v = "";
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  } catch {
    /* DOM が無い環境（スモーク）では fallback で続行 */
  }
  const out = v || fallback;
  cache.set(varName, out);
  return out;
}

/** V158 (C-2): `rgba()` を組み立てる（`--ink-rgb` のような「成分」変数から）。 */
export function uiColorA(rgbVarName: string, alpha: number, fallback = "0,0,0"): string {
  return `rgba(${uiColor(rgbVarName, fallback)}, ${alpha})`;
}

/** V158 (C-3): 配色を画面へ当てる。**`<html>` に `data-theme` を付けるだけ**——
 *  色そのものは `styles.css` の `:root[data-theme="dark"]` が持つ（変数だけの上書き）。
 *  ライブラリ画面もエディタも同じ `<html>` の下なので、これ1つでアプリ全体に効く。 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  // canvas 側が覚えている色は、もう古い
  cache = new Map();
}

/** テスト・DEV 用: 覚えている色を捨てる（配色を切り替えずに読み直したいとき）。 */
export function clearThemeCache(): void {
  cache = new Map();
}
