// M10-1c P-6: textToMask の参照ビットマップを Node 側で作り、ブラウザ側の結果と突き合わせる。
//
//   npx tsx tools/fonts/verify_text_mask.ts            # 参照を作って JSON で出す
//   npx tsx tools/fonts/verify_text_mask.ts --json out.json
//
// **閾値規則は src/editor/raster.ts の textToMask と同一**にすること
// （dot 系 = 等倍レンダ＋alpha > 128 ／ outline 系 = 3倍レンダ＋3×3平均＋>= 128）。
// 規則を2箇所に書き分けると検証の意味が無くなるので、変更時は必ず両方を直す。
//
// 描画は @napi-rs/canvas（Skia）。アプリの WebView2 は DirectWrite でアンチエイリアスの
// 出方が違うが、**2値化後は一致する**ことを M10-1a で確認済み（美咲は diff=0）。
// したがって「2値化後のビットマップ」を比較する本スクリプトは engine 差を吸収できる。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FONT_DIR = path.join(ROOT, "assets", "fonts");

/** src/editor/fonts.ts の FONTS と対応させること */
const FONTS = [
  { key: "misaki", file: "misaki.woff2", family: "MA Misaki", kind: "dot", sizes: [8, 16, 24] },
  { key: "pixel12", file: "pixel12.woff2", family: "MA Pixel12", kind: "dot", sizes: [12, 24, 36] },
  { key: "maru", file: "maru.woff2", family: "MA Maru", kind: "outline", sizes: [12, 16, 24] },
  { key: "pop", file: "pop.woff2", family: "MA Pop", kind: "outline", sizes: [12, 16, 24] },
  { key: "mincho", file: "mincho.woff2", family: "MA Mincho", kind: "outline", sizes: [12, 16, 24] },
] as const;

export const SAMPLE = "あいうえお アイウエオ 漢字 ABC 123";

const W = 320;
const H = 240;

for (const f of FONTS) {
  const p = path.join(FONT_DIR, f.file);
  if (!fs.existsSync(p)) {
    console.error(`FATAL: フォントが見つかりません: ${p}`);
    process.exit(1);
  }
  GlobalFonts.registerFromPath(p, f.family);
}

/** raster.ts の textToMask と同一規則でマスクを作る */
function textToMask(text: string, px: number, family: string, kind: "dot" | "outline") {
  const oversample = kind === "outline" ? 3 : 1;
  const renderPx = px * oversample;
  const fontStr = `${renderPx}px "${family}"`;

  const probe = createCanvas(8, 8).getContext("2d");
  probe.font = fontStr;
  const m = probe.measureText(text);
  const w = Math.min(W, Math.ceil(m.width / oversample) + 2);
  const h = Math.min(H, Math.ceil(px * 1.35) + 2);
  if (w <= 2 || text.length === 0) return null;

  const cv = createCanvas(w * oversample, h * oversample);
  const c2 = cv.getContext("2d");
  c2.font = fontStr;
  c2.textBaseline = "top";
  c2.fillStyle = "#000";
  c2.fillText(text, oversample, oversample);
  const img = c2.getImageData(0, 0, cv.width, cv.height).data;

  const data = new Uint8Array(w * h);
  if (oversample === 1) {
    for (let i = 0; i < w * h; i++) data[i] = img[i * 4 + 3] > 128 ? 1 : 0;
    return { w, h, data };
  }
  const sw = cv.width;
  const area = oversample * oversample;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let oy = 0; oy < oversample; oy++)
        for (let ox = 0; ox < oversample; ox++)
          sum += img[((y * oversample + oy) * sw + x * oversample + ox) * 4 + 3];
      data[y * w + x] = sum / area >= 128 ? 1 : 0;
    }
  }
  return { w, h, data };
}

const refs: Record<string, { w: number; h: number; bits: string }> = {};
for (const f of FONTS) {
  for (const px of f.sizes) {
    const m = textToMask(SAMPLE, px, f.family, f.kind);
    if (!m) continue;
    refs[`${f.key}@${px}`] = { w: m.w, h: m.h, bits: Array.from(m.data).join("") };
  }
}

const argIdx = process.argv.indexOf("--json");
const outPath = argIdx >= 0 ? process.argv[argIdx + 1] : null;
const payload = { sample: SAMPLE, refs };
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");
  console.log(`reference written: ${outPath} (${Object.keys(refs).length} entries)`);
} else {
  console.log(JSON.stringify(payload));
}
