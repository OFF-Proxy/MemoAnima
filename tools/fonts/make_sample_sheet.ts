// M10-1a P-4: 見本シート PNG の生成 ＋ 中間調ピクセルの数値検証
//
//   npx tsx tools/fonts/make_sample_sheet.ts
//
// **サブセット後の assets/fonts/*.woff2 を実際に読んで**描画する。
// 目的は2つ:
//   ① 作者が等倍と4倍を見比べて書体の採否を決める（確認ゲート）
//   ② サブセット化が設計グリッドを壊していないことを数値で証明する
//      ドット系（美咲・PixelMplus12）は設計サイズの整数倍なら中間調ピクセルが出ない。
//      出たらサブセットかレンダ設定のどちらかが壊れている。
//
// 描画は @napi-rs/canvas（Skia）。アプリの WebView2（Chromium/Skia）と同系統の
// ラスタライザなので、M10-1c で Canvas 2D に載せ替えたときの挙動を予測できる。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FONT_DIR = path.join(ROOT, "assets", "fonts");
const OUT_PNG = path.join(HERE, "sample_sheet.png");

const SAMPLE = "あいうえお アイウエオ 漢字混じりの見本 ABC 123";

/** 書体定義。sizes は HANDOFF P-4 の指定。dot=設計グリッドを持つドット系 */
interface FontDef {
  key: string;
  label: string;
  file: string;
  family: string;
  sizes: number[];
  dot: boolean;
  /** 期待する中間調割合の上限（%）。超えたら異常として報告する */
  maxMidTone: number;
}

const FONTS: FontDef[] = [
  { key: "misaki", label: "美咲ゴシック", file: "misaki.woff2", family: "M10Misaki", sizes: [8, 16, 24], dot: true, maxMidTone: 0 },
  { key: "pixel12", label: "PixelMplus12 R", file: "pixel12.woff2", family: "M10Pixel12", sizes: [12, 24, 36], dot: true, maxMidTone: 0.5 },
  { key: "pixel12-bold", label: "PixelMplus12 B", file: "pixel12-bold.woff2", family: "M10Pixel12B", sizes: [12, 24, 36], dot: true, maxMidTone: 0.5 },
  { key: "maru", label: "Zen Maru Gothic R", file: "maru.woff2", family: "M10Maru", sizes: [8, 12, 16, 24], dot: false, maxMidTone: 100 },
  { key: "maru-bold", label: "Zen Maru Gothic B", file: "maru-bold.woff2", family: "M10MaruB", sizes: [8, 12, 16, 24], dot: false, maxMidTone: 100 },
  { key: "pop", label: "Dela Gothic One", file: "pop.woff2", family: "M10Pop", sizes: [8, 12, 16, 24], dot: false, maxMidTone: 100 },
  { key: "mincho", label: "Zen Antique", file: "mincho.woff2", family: "M10Mincho", sizes: [8, 12, 16, 24], dot: false, maxMidTone: 100 },
];

for (const f of FONTS) {
  const p = path.join(FONT_DIR, f.file);
  if (!fs.existsSync(p)) {
    console.error(`FATAL: フォントが見つかりません: ${p}（先に subset.py を実行）`);
    process.exit(1);
  }
  GlobalFonts.registerFromPath(p, f.family);
}

/** アンチエイリアスを切らずに素の alpha を得る（2値化前の生の分布を見るため） */
function renderAlpha(f: FontDef, px: number): { w: number; h: number; alpha: Uint8Array } {
  const probe = createCanvas(8, 8).getContext("2d");
  probe.font = `${px}px "${f.family}"`;
  const w = Math.max(1, Math.ceil(probe.measureText(SAMPLE).width) + 4);
  const h = Math.ceil(px * 1.6) + 4;
  const cv = createCanvas(w, h);
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.font = `${px}px "${f.family}"`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000";
  ctx.fillText(SAMPLE, 2, 2);
  const data = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];
  return { w, h, alpha };
}

/** 中間調（alpha が 0 でも 255 でもない）ピクセルの割合。分母は「描画された画素」＝alpha>0 */
function midToneRatio(alpha: Uint8Array): { drawn: number; mid: number; pct: number } {
  let drawn = 0;
  let mid = 0;
  for (const a of alpha) {
    if (a === 0) continue;
    drawn++;
    if (a !== 255) mid++;
  }
  return { drawn, mid, pct: drawn ? (mid / drawn) * 100 : 0 };
}

// ---------------- 数値検証 ----------------

interface Row {
  font: FontDef;
  px: number;
  img: { w: number; h: number; alpha: Uint8Array };
  stat: { drawn: number; mid: number; pct: number };
}

const rows: Row[] = [];
let failed = false;

console.log("=== 中間調ピクセルの数値検証（2値化前の生アルファ） ===");
console.log("書体                サイズ   描画画素   中間調    割合      判定");
for (const f of FONTS) {
  for (const px of f.sizes) {
    const img = renderAlpha(f, px);
    const stat = midToneRatio(img.alpha);
    rows.push({ font: f, px, img, stat });
    const ok = stat.pct <= f.maxMidTone;
    if (f.dot && !ok) failed = true;
    const verdict = f.dot ? (ok ? "OK" : "NG ← 設計グリッドが壊れている") : "(アウトライン系＝正常)";
    console.log(
      `${f.label.padEnd(20)}${String(px).padStart(3)}px ${String(stat.drawn).padStart(9)} ${String(stat.mid).padStart(9)}  ${stat.pct.toFixed(2).padStart(6)}%  ${verdict}`
    );
  }
}

// ---------------- 見本シートの描画 ----------------

const SCALE = 4;
const PAD = 12;
const LABEL_W = 150;
const GAP = 16;
const HEADER_H = 44;

let sheetW = 0;
let sheetH = HEADER_H + PAD;
const rowH: number[] = [];
for (const r of rows) {
  const h = Math.max(r.img.h * SCALE, 22);
  rowH.push(h);
  sheetH += h + GAP;
  sheetW = Math.max(sheetW, LABEL_W + r.img.w + GAP + r.img.w * SCALE + PAD * 2);
}
sheetH += PAD;

const sheet = createCanvas(sheetW, sheetH);
const g: SKRSContext2D = sheet.getContext("2d");
g.fillStyle = "#ffffff";
g.fillRect(0, 0, sheetW, sheetH);

g.fillStyle = "#111111";
g.font = "16px sans-serif";
g.textBaseline = "top";
g.fillText("メモアニマ M10-1a フォント見本（左=ドット等倍 / 右=4倍 nearest）", PAD, 10);
g.font = "11px sans-serif";
g.fillStyle = "#666666";
g.fillText(`見本文字列: ${SAMPLE}`, PAD, 28);

let y = HEADER_H + PAD;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const h = rowH[i];

  // 行ラベル（書体名・サイズ・中間調割合）
  g.fillStyle = "#111111";
  g.font = "12px sans-serif";
  g.fillText(`${r.font.label}`, PAD, y);
  g.fillStyle = "#666666";
  g.font = "11px sans-serif";
  g.fillText(`${r.px}px / 中間調 ${r.stat.pct.toFixed(2)}%`, PAD, y + 15);

  // 等倍（黒文字を白地に合成）
  const one = createCanvas(r.img.w, r.img.h);
  const oc = one.getContext("2d");
  const id = oc.createImageData(r.img.w, r.img.h);
  for (let p = 0; p < r.img.w * r.img.h; p++) {
    const a = r.img.alpha[p];
    id.data[p * 4] = 255 - a;
    id.data[p * 4 + 1] = 255 - a;
    id.data[p * 4 + 2] = 255 - a;
    id.data[p * 4 + 3] = 255;
  }
  oc.putImageData(id, 0, 0);
  g.drawImage(one, LABEL_W, y);

  // 4倍（nearest。アプリの整数倍表示と同じ見え方にする）
  g.imageSmoothingEnabled = false;
  g.drawImage(one, LABEL_W + r.img.w + GAP, y, r.img.w * SCALE, r.img.h * SCALE);

  y += h + GAP;
}

fs.writeFileSync(OUT_PNG, sheet.encodeSync("png"));
console.log(`\nsample sheet: ${OUT_PNG} (${sheetW}x${sheetH})`);

if (failed) {
  console.error("\nFATAL: ドット系フォントで中間調ピクセルが期待値を超えた。サブセット化かレンダ設定が設計グリッドを壊している。");
  process.exit(1);
}
console.log("判定: ドット系はすべて期待値以内");
