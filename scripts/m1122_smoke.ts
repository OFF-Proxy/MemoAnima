// M11-22 スモーク: 倍率の正規化・説明文言・GIF 固定パレットの実使用色の数え方（純関数）
// 引数不要:  npx tsx scripts/m1122_smoke.ts
// ※ 実ファイル（GIF 完全一致・全コマ同一パレット・×N nearest）は scripts/m1121_export_check.mts（tauri:dev が要る）
import { W, H, PIXELS } from "../src/editor/model";
// M12-1c-2: 文言が t() 経由になったので**言語を ja に固定**してから読む（pin の文字列は1文字も変えていない）
import { setLang } from "../src/i18n";
setLang("ja");
(globalThis as unknown as { self: unknown }).self = globalThis; // exporter.ts は gif.js（self 参照）を静的 import
const { EXPORT_SCALES, DEFAULT_EXPORT_SCALE, sanitizeExportScale, scaleNote, gifX8Warning, collectGifPalette, GIF_MAX_PALETTE } =
  await import("../src/editor/exporter");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}

// ---------- 倍率 ----------
check("倍率の選択肢は [1,2,4,8]・既定 4", JSON.stringify(EXPORT_SCALES) === "[1,2,4,8]" && DEFAULT_EXPORT_SCALE === 4);
check("sanitize: 1/2/4/8 はそのまま", [1, 2, 4, 8].every((n) => sanitizeExportScale(n) === n));
check("sanitize: 3・0・-1・16・小数・文字列 '4'・null・undefined・{} は既定 4", [3, 0, -1, 16, 2.5, "4", null, undefined, {}, true, NaN].every((v) => sanitizeExportScale(v) === 4));
for (const n of EXPORT_SCALES) {
  const s = scaleNote(n);
  check(`scaleNote(${n}) の px は ${W * n}×${H * n}`, s.px === `${W * n}×${H * n}` && s.use.length > 0, JSON.stringify(s));
  // 用途に括弧を入れない（呼び出し側が括弧で囲むので二重括弧にならない）
  check(`scaleNote(${n}) の use に括弧が無い`, !/[（）()]/.test(s.use), s.use);
}
check("×4 の用途に「おすすめ」・×1 に「乱れる」・×8 に「大きく」", /おすすめ/.test(scaleNote(4).use) && /乱れ/.test(scaleNote(1).use) && /大き/.test(scaleNote(8).use));
check("×1 は拡大の但し書きなし（等倍なので「拡大」と書かない）・×2/×4/×8 はあり", scaleNote(1).dots === "" && [2, 4, 8].every((n) => /拡大はドット等倍/.test(scaleNote(n as 2).dots)));
check("×1 の用途に「拡大」が出てこない", !/拡大/.test(scaleNote(1).use), scaleNote(1).use);
// M11-24: 文言を短くしたので pin も合わせる。**意図は同じ**＝「容量が大きくなることと、代わりの選択肢が読める」
// （形式名 GIF は注意文が出る場所＝GIF を選んでいるときだけなので本文からは落とした）
check("GIF×8 の注意文がある（容量と代替が読める）", /MB/.test(gifX8Warning()) && /×4|MP4/.test(gifX8Warning()), gifX8Warning());
// M11-24: 常時表示は短く（UI_TEXT_guide 4: 目安 30 字）。超えたら削れないか考える合図
check("常時表示の文言が 30 字以内（用途の一言・GIF×8 の注意）", EXPORT_SCALES.every((n) => [...scaleNote(n).use].length <= 30) && [...gifX8Warning()].length <= 30, `${EXPORT_SCALES.map((n) => [...scaleNote(n).use].length).join("/")} ・警告 ${[...gifX8Warning()].length}`);

// ---------- GIF 固定パレット ----------
// V168 (E-1): 供給元は async（Promise を返す）。同期版は残さない＝ここも型を寄せる
const mkSrc = (frames: Uint8ClampedArray[]) => ({ count: frames.length, fps: 8, loop: true, getFrameRgba: async (i: number) => frames[i] });
const frame = () => new Uint8ClampedArray(PIXELS * 4);
const setPx = (f: Uint8ClampedArray, i: number, r: number, g: number, b: number, a = 255) => { f[i * 4] = r; f[i * 4 + 1] = g; f[i * 4 + 2] = b; f[i * 4 + 3] = a; };
{
  // 3 色＋透明: 白埋めなら白・透過なら黒（gif.js が alpha を捨てて見る色）。並びは最初に現れた順
  const f = frame();
  for (let i = 0; i < PIXELS; i++) setPx(f, i, 255, 255, 255);
  setPx(f, 10, 20, 20, 20); setPx(f, 11, 255, 23, 23); setPx(f, 12, 0, 56, 206);
  setPx(f, 13, 0, 0, 0, 0); // 透明
  const white = await collectGifPalette(mkSrc([f]), true)!;
  const trans = await collectGifPalette(mkSrc([f]), false)!;
  check("白埋め: 透明は白に吸収され 4 色（白,黒,赤,青）・最初に現れた順", JSON.stringify(white) === JSON.stringify([255, 255, 255, 20, 20, 20, 255, 23, 23, 0, 56, 206]), JSON.stringify(white));
  check("透過: 透明は黒として 5 色目に数える", JSON.stringify(trans) === JSON.stringify([255, 255, 255, 20, 20, 20, 255, 23, 23, 0, 56, 206, 0, 0, 0]), JSON.stringify(trans));
  check("長さは 3 の倍数", white.length % 3 === 0 && trans.length % 3 === 0);
}
{
  // 全コマの合算で数える（コマ 2 にだけある色も入る）
  const f0 = frame(), f1 = frame();
  for (let i = 0; i < PIXELS; i++) { setPx(f0, i, 255, 255, 255); setPx(f1, i, 255, 255, 255); }
  setPx(f0, 0, 1, 2, 3); setPx(f1, 5, 4, 5, 6);
  const pal = await collectGifPalette(mkSrc([f0, f1]), true)!;
  check("全コマ合算: コマ 2 だけの色も含む（3 色・最初に現れた順＝画素 0 の (1,2,3) が先頭）", JSON.stringify(pal) === JSON.stringify([1, 2, 3, 255, 255, 255, 4, 5, 6]), JSON.stringify(pal));
}
{
  // ちょうど 256 色 → 固定パレット／257 色 → null（従来 NeuQuant）
  const f = frame();
  for (let i = 0; i < PIXELS; i++) setPx(f, i, i % 256, 0, 0);
  const p256 = await collectGifPalette(mkSrc([f]), true);
  check("ちょうど 256 色 → 固定パレット（768 要素）", !!p256 && p256.length === GIF_MAX_PALETTE * 3, String(p256?.length));
  setPx(f, 0, 0, 1, 0); // 257 色目
  check("257 色 → null（従来経路）", (await collectGifPalette(mkSrc([f]), true)) === null);
}
{
  // 半透明（0/255 以外の alpha）が 1 画素でもあれば安全側で null
  const f = frame();
  for (let i = 0; i < PIXELS; i++) setPx(f, i, 255, 255, 255);
  setPx(f, 100, 10, 10, 10, 128);
  check("半透明 alpha があれば null（従来経路）", (await collectGifPalette(mkSrc([f]), true)) === null);
}
{
  // 決定性: 同じ入力 → 同じ配列
  const f = frame();
  for (let i = 0; i < PIXELS; i++) setPx(f, i, (i * 7) % 200, (i * 13) % 200, (i * 17) % 50);
  const a = await collectGifPalette(mkSrc([f]), true), b = await collectGifPalette(mkSrc([f]), true);
  check("決定性（同じ入力 → 同じパレット or 同じ null）", JSON.stringify(a) === JSON.stringify(b));
}

console.log(`m1122 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
