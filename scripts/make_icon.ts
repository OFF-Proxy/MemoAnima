// M7-3 P-1 → M10-12: アプリアイコン生成（1024×1024 PNG）
// 32×32 のドット絵を ×32 で拡大（nearest）。うごメモ/カエル/任天堂連想の意匠は不使用。
//
// M10-12: 意匠を **アプリ内ヘッダーのロゴマーク** に合わせた（styles.css:218-234 の `.logo .mark`）。
//   - 白 #ffffff の角丸正方形＋墨色 #2c2621 の枠（太さ3グリッド・角丸 9/32 相当）
//   - 外周から5グリッド内側に角丸 4/32 相当の正方形を置き、
//     左上半分 #ff4b4b（赤）／右下半分 #1fa2ff（青）で **ハードに** 塗り分ける
//     （CSS の `linear-gradient(135deg, red 0 50%, blue 50% 100%)` の忠実再現。
//      境界は右上→左下の反対角線＝ `x + y` が中央値以下なら赤）
//   - 背景は透明（四隅に黒縁・白縁を出さない）
//
// 実行: npx tsx scripts/make_icon.ts → assets/icon_memoanima_1024.png（同名上書き）
import * as fs from "node:fs";
import * as path from "node:path";
import UPNG from "upng-js";

const G = 32; // グリッド
const S = 32; // 拡大倍率 → 1024
const W = G * S;

// パレット（styles.css の CSS 変数と同値）
const INK = [0x2c, 0x26, 0x21, 255]; // --ink   枠
const WHITE = [0xff, 0xff, 0xff, 255]; // 白地
const RED = [0xff, 0x4b, 0x4b, 255]; // --red  左上
const BLUE = [0x1f, 0xa2, 0xff, 255]; // --blue 右下
const TRANSPARENT = [0, 0, 0, 0];

const grid: number[][][] = Array.from({ length: G }, () =>
  Array.from({ length: G }, () => TRANSPARENT)
);

function put(x: number, y: number, c: number[]) {
  if (x >= 0 && x < G && y >= 0 && y < G) grid[y][x] = c;
}
/** 角丸の矩形を塗る。半径 r（グリッド単位）で四隅を円弧状にカットする */
function roundRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  c: number[]
) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // 角の丸めの中心。角の領域に入っていない軸は null のまま＝丸めない
      let cx: number | null = null;
      let cy: number | null = null;
      if (x < x0 + r) cx = x0 + r;
      else if (x > x1 - r) cx = x1 - r;
      if (y < y0 + r) cy = y0 + r;
      else if (y > y1 - r) cy = y1 - r;
      if (cx !== null && cy !== null) {
        // +0.4 は既存 circleFill と同じ流儀（ドットの縁を欠けさせすぎない）
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r + 0.4) continue;
      }
      put(x, y, c);
    }
  }
}

// --- 外枠: 墨色の角丸正方形（border-radius 9px / border 3px 相当） ---
const OUTER_R = 9;
roundRect(0, 0, G - 1, G - 1, OUTER_R, INK);

// --- 白地: 枠 3グリッドぶん内側 ---
const B = 3;
roundRect(B, B, G - 1 - B, G - 1 - B, OUTER_R - B, WHITE);

// --- 内側の赤／青: inset 5px・border-radius 4px ---
const I = 5;
const IX0 = I;
const IY0 = I;
const IX1 = G - 1 - I;
const IY1 = G - 1 - I;
// 反対角線（右上→左下）で分ける。境界の中央値は 4隅の座標和の半分
const MID = (IX0 + IX1 + IY0 + IY1) / 2;
roundRect(IX0, IY0, IX1, IY1, 4, RED);
// 右下半分を青へ。角丸で落ちた画素は RED になっていないので自然に除外される
for (let y = IY0; y <= IY1; y++) {
  for (let x = IX0; x <= IX1; x++) {
    if (grid[y][x] !== RED) continue;
    if (x + y > MID) grid[y][x] = BLUE;
  }
}

// --- ×S 拡大して PNG 出力 ---
const rgba = new Uint8Array(W * W * 4);
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) {
    const c = grid[Math.floor(y / S)][Math.floor(x / S)];
    const o = (y * W + x) * 4;
    rgba[o] = c[0];
    rgba[o + 1] = c[1];
    rgba[o + 2] = c[2];
    rgba[o + 3] = c[3];
  }
const png = UPNG.encode([rgba.buffer], W, W, 0);
const out = path.resolve("assets/icon_memoanima_1024.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(png));
console.log(`icon written: ${out} (${W}x${W})`);

// 生成結果を目視できるよう、32×32 のグリッドを ASCII で出す（.=透明 #=枠 空白=白 R=赤 B=青）
const label = (c: number[]) =>
  c === TRANSPARENT ? "." : c === INK ? "#" : c === WHITE ? " " : c === RED ? "R" : "B";
console.log(grid.map((row) => row.map(label).join("")).join("\n"));
