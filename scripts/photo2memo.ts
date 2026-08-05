// MAT-1/1b → M8-1: 写真/画像 → ドット化 → 素材集 .memoanima(v5) 変換 CLI（量産・バッチ用）
// 変換エンジンは src/editor/imageConvert.ts（アプリ内「📷 画像を取り込む」と共有・同一設定→同一出力）。
// 回帰ゲート: scripts/m8_smoke.ts（CLI と共有モジュールの出力一致を検証）
//
// 実行例:
//   npx tsx scripts/photo2memo.ts input.jpg -o 夕焼け.memoanima
//   npx tsx scripts/photo2memo.ts f01.png f02.png f03.png -o 波アニメ.memoanima --fps 4
//   npx tsx scripts/photo2memo.ts input.jpg -o 白黒.memoanima --mode tone --threshold 55 --dither-amt 70
//   npx tsx scripts/photo2memo.ts input.jpg --sheet            （5×5バリエーション一覧PNG）
//
// オプション:
//   -o PATH          出力 .memoanima（--sheet 時は一覧PNGの出力先 .png）
//   --mode MODE      color(既定) | tone(モノクロ2値＋ディザ=さつえい再現) | lineart(輪郭線画)
//   --colors N       [color] パレット色数（既定24・最大255。median-cut量子化）
//   --palette MODE   [color] auto(既定) | ugo(うごメモ6色) | retro(既定14色)
//   --dither MODE    fs(既定・Floyd–Steinberg) | ordered(4x4 Bayer) | none
//   --fit MODE       cover(既定・320×240を埋めて中央クロップ) | contain(余白=紙)
//   --paper HEX      紙色（既定 #ffffff）
//   --fps N          複数画像時の速度（FPS_TABLE の最近傍へ丸め・既定4）
//   --title NAME     プロジェクト名（既定=出力ファイル名）
//   --threshold N    [tone] 2値化しきい値 0..100（既定50）
//   --dither-amt N   [tone] ディザ量 0..100（既定60。0=ベタ2値・100=全面ディザ）
//   --ink HEX        [tone/lineart] インク色（既定 #141414）
//   --invert         [tone/lineart] 明暗/線地の反転
//   --edge N         [lineart] 輪郭検出の強さ 0..100（既定50・Sobel）
//   --brightness N   全モード共通 -100..100（既定0）
//   --contrast N     全モード共通 -100..100（既定0）
//   --sheet          バリエーション一覧PNG（5×5・各セルに番号とパラメータ）
//   --sheet-mode M   tone(既定・threshold×dither-amt) | lineart(edge×threshold)
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import * as jpeg from "jpeg-js";
import { W, H, PIXELS, FPS_TABLE } from "../src/editor/model";
import { projectFromBytes, projectToBytes } from "../src/editor/serialize";
import {
  DEFAULT_CONVERT,
  convertToProject,
  frameToRgba,
  prepareCanvas,
  toGray,
  toneBinarize,
  lineartBinarize,
  hexToRgb,
  type ConvertOptions,
  type SourceImage,
  type RGB,
} from "../src/editor/imageConvert";

// ---------------- 引数 ----------------

interface Opts extends ConvertOptions {
  inputs: string[];
  out: string | null;
  sheet: boolean;
  sheetMode: "tone" | "lineart";
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    ...DEFAULT_CONVERT,
    inputs: [],
    out: null,
    sheet: false,
    sheetMode: "tone",
  };
  const num = (s: string, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Number(s)));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "-o" || a === "--out") o.out = next();
    else if (a === "--mode") o.mode = next() as Opts["mode"];
    else if (a === "--colors") o.colors = num(next(), 2, 255);
    else if (a === "--palette") o.palette = next() as Opts["palette"];
    else if (a === "--dither") o.dither = next() as Opts["dither"];
    else if (a === "--fit") o.fit = next() as Opts["fit"];
    else if (a === "--paper") o.paper = normHex(next());
    else if (a === "--fps") o.fps = Number(next());
    else if (a === "--title") o.title = next();
    else if (a === "--threshold") o.threshold = num(next(), 0, 100);
    else if (a === "--dither-amt") o.ditherAmt = num(next(), 0, 100);
    else if (a === "--ink") o.ink = normHex(next());
    else if (a === "--invert") o.invert = true;
    else if (a === "--edge") o.edge = num(next(), 0, 100);
    else if (a === "--brightness") o.brightness = num(next(), -100, 100);
    else if (a === "--contrast") o.contrast = num(next(), -100, 100);
    else if (a === "--sheet") o.sheet = true;
    else if (a === "--sheet-mode") o.sheetMode = next() as Opts["sheetMode"];
    else if (a.startsWith("-")) throw new Error(`不明なオプション: ${a}`);
    else o.inputs.push(a);
  }
  if (!o.inputs.length) throw new Error("入力画像を指定してください");
  if (!["color", "tone", "lineart"].includes(o.mode))
    throw new Error(`--mode は color|tone|lineart: ${o.mode}`);
  return o;
}

function normHex(s: string): string {
  const h = s.startsWith("#") ? s : `#${s}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) throw new Error(`色は #rrggbb 形式で: ${s}`);
  return h.toLowerCase();
}

// ---------------- 画像I/O（Node側のみ・pngjs/jpeg-js） ----------------

function decodeImage(file: string): SourceImage {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { w: png.width, h: png.height, data: new Uint8Array(png.data) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
    return { w: j.width, h: j.height, data: new Uint8Array(j.data) };
  }
  throw new Error(`PNG/JPG ではありません: ${file}`);
}

function writePng(file: string, w: number, h: number, rgba: Uint8Array) {
  const png = new PNG({ width: w, height: h });
  Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).copy(png.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

// ---------------- コンタクトシート（5×5一覧・CLI専用） ----------------

const FONT: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7], "3": [7, 1, 7, 1, 7],
  "4": [5, 5, 7, 1, 1], "5": [7, 4, 7, 1, 7], "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 2, 2],
  "8": [7, 5, 7, 5, 7], "9": [7, 5, 7, 1, 7], "#": [5, 7, 5, 7, 5], " ": [0, 0, 0, 0, 0],
  T: [7, 2, 2, 2, 2], A: [2, 5, 7, 5, 5], E: [7, 4, 6, 4, 7], D: [6, 5, 5, 5, 6],
};

function drawText(
  rgba: Uint8Array,
  imgW: number,
  x0: number,
  y0: number,
  text: string,
  scale: number,
  rgb: RGB
) {
  let cx = x0;
  for (const ch of text) {
    const rows = FONT[ch] ?? FONT[" "];
    for (let ry = 0; ry < 5; ry++)
      for (let rx = 0; rx < 3; rx++) {
        if (!((rows[ry] >> (2 - rx)) & 1)) continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const o = ((y0 + ry * scale + sy) * imgW + cx + rx * scale + sx) * 4;
            rgba[o] = rgb[0];
            rgba[o + 1] = rgb[1];
            rgba[o + 2] = rgb[2];
            rgba[o + 3] = 255;
          }
      }
    cx += 4 * scale;
  }
}

function half(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(160 * 120 * 4);
  for (let y = 0; y < 120; y++)
    for (let x = 0; x < 160; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const si = ((y * 2 + dy) * W + x * 2 + dx) * 4;
          r += rgba[si]; g += rgba[si + 1]; b += rgba[si + 2];
        }
      const oi = (y * 160 + x) * 4;
      out[oi] = r / 4; out[oi + 1] = g / 4; out[oi + 2] = b / 4; out[oi + 3] = 255;
    }
  return out;
}

function makeSheet(canvas: SourceImage, o: Opts): { rgba: Uint8Array; w: number; h: number } {
  const gray = toGray(canvas);
  const CELL_W = 160, CELL_H = 120, LABEL = 14, PAD = 4;
  const w = PAD + 5 * (CELL_W + PAD);
  const h = PAD + 5 * (CELL_H + LABEL + PAD);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 34; rgba[i * 4 + 1] = 38; rgba[i * 4 + 2] = 46; rgba[i * 4 + 3] = 255;
  }
  const A = o.sheetMode === "tone" ? [10, 30, 50, 70, 90] : [20, 40, 60, 80, 100];
  const B = o.sheetMode === "tone" ? [0, 25, 50, 75, 100] : [30, 40, 50, 60, 70];
  const ink = hexToRgb(o.ink);
  const paper = hexToRgb(o.paper);
  let num = 1;
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 5; col++, num++) {
      const bin =
        o.sheetMode === "tone"
          ? toneBinarize(gray, A[row], B[col], o.dither === "none" ? "fs" : o.dither, o.invert)
          : lineartBinarize(gray, A[row], o.invert);
      let bin2 = bin;
      if (o.sheetMode === "lineart") {
        const g2 = new Float32Array(PIXELS);
        for (let i = 0; i < PIXELS; i++) g2[i] = bin[i] === true ? 0 : 255;
        bin2 = toneBinarize(g2, B[col], 0, "fs", false);
      }
      const cell = new Uint8Array(PIXELS * 4);
      for (let i = 0; i < PIXELS; i++) {
        const c = bin2[i] === true ? ink : paper;
        cell[i * 4] = c[0]; cell[i * 4 + 1] = c[1]; cell[i * 4 + 2] = c[2]; cell[i * 4 + 3] = 255;
      }
      const small = half(cell);
      const x0 = PAD + col * (CELL_W + PAD);
      const y0 = PAD + row * (CELL_H + LABEL + PAD);
      for (let y = 0; y < CELL_H; y++)
        for (let x = 0; x < CELL_W; x++) {
          const si = (y * CELL_W + x) * 4;
          const oi = ((y0 + y) * w + x0 + x) * 4;
          rgba[oi] = small[si]; rgba[oi + 1] = small[si + 1]; rgba[oi + 2] = small[si + 2]; rgba[oi + 3] = 255;
        }
      const label =
        o.sheetMode === "tone"
          ? `#${num} T${A[row]} A${B[col]}`
          : `#${num} E${A[row]} T${B[col]}`;
      drawText(rgba, w, x0 + 2, y0 + CELL_H + 3, label, 2, [235, 238, 245]);
    }
  return { rgba, w, h };
}

// ---------------- main ----------------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const images = o.inputs.map(decodeImage);

  // --sheet: 一覧PNGのみ生成して終了
  if (o.sheet) {
    const sheet = makeSheet(prepareCanvas(images[0], o), o);
    const out =
      o.out && o.out.toLowerCase().endsWith(".png")
        ? o.out
        : `${o.inputs[0].replace(/\.[^.]+$/, "")}_sheet_${o.sheetMode}.png`;
    writePng(out, sheet.w, sheet.h, sheet.rgba);
    console.log(
      `sheet: ${path.resolve(out)} (${sheet.w}x${sheet.h}・#番号→ ${o.sheetMode === "tone" ? "T=threshold A=dither-amt" : "E=edge T=threshold"})`
    );
    return;
  }

  const out = o.out ?? `${o.inputs[0].replace(/\.[^.]+$/, "")}.memoanima`;
  if (!o.title) o.title = path.basename(out).replace(/\.[^.]+$/, "");

  const project = convertToProject(images, o);
  const bytes = await projectToBytes(project);
  fs.writeFileSync(out, bytes);

  // サイドカーサムネ（1コマ目・320×240）
  writePng(`${out}.png`, W, H, frameToRgba(project, 0));

  // 自己検証: 往復ロードして一致確認（保存形式の安全確認）
  const rt = await projectFromBytes(new Uint8Array(fs.readFileSync(out)));
  let same = rt.frames.length === project.frames.length && rt.indexBits === project.indexBits;
  if (same) {
    outer: for (let fi = 0; fi < rt.frames.length; fi++) {
      const a = project.frames[fi].layers["L1"];
      const b = rt.frames[fi].layers["L1"];
      for (let i = 0; i < PIXELS; i++)
        if (a[i] !== b[i]) { same = false; break outer; }
    }
  }
  console.log(
    `out: ${path.resolve(out)}\n` +
      `  mode=${o.mode} pages=${project.frames.length} colors=${project.colorTable.length - 1} ` +
      `indexBits=${project.indexBits} fps=${FPS_TABLE[project.speedIndex]} ` +
      `size=${bytes.length} bytes roundtrip=${same ? "OK" : "NG"}`
  );
  if (!same) process.exit(1);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
