// M8-1 I-1: 画像→ドット化変換エンジン（共有モジュール・純関数）
// うごメモ3D「写真/さつえい」機能の再現＋PC拡張。
// - アプリ内「📷 画像を取り込む」GUI と scripts/photo2memo.ts CLI の両方がこれを使う
//   （同一設定→同一出力。回帰ゲートは scripts/m8_smoke.ts）
// - 入力は RGBA バイト列（ブラウザ=canvas getImageData / CLI=pngjs・jpeg-js）。Node API に依存しない。
// - 出力は既存の Project（v5 保存形式のまま・保存形式変更なし）
import {
  W,
  H,
  PIXELS,
  FPS_TABLE,
  UGO_COLORS,
  RETRO_PALETTE,
  newProject,
  ensureColor,
  allocIndexBuf,
  type Project,
  type Frame,
} from "./model";
// M12-1c-2: アプリが自動で付ける名前は defaults.ts が唯一の出どころ
import { imageLayerName, imageProjectTitle } from "../i18n/defaults";

// ---------------- 型・オプション ----------------

/** 変換元画像（RGBA・任意サイズ） */
export interface SourceImage {
  w: number;
  h: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface ConvertOptions {
  mode: "color" | "tone" | "lineart";
  /** [color] auto の量子化色数（2..255） */
  colors: number;
  palette: "auto" | "ugo" | "retro";
  dither: "fs" | "ordered" | "none";
  fit: "cover" | "contain";
  /** 紙色 #rrggbb（contain の余白・tone/lineart の地） */
  paper: string;
  /** 複数ページ時の速度（FPS_TABLE の最近傍へ丸め） */
  fps: number;
  title: string;
  /** [tone] 2値化しきい値 0..100 */
  threshold: number;
  /** [tone] ディザ量 0..100（0=ベタ2値・100=全面ディザ） */
  ditherAmt: number;
  /** [tone/lineart] インク色 #rrggbb */
  ink: string;
  /** [tone/lineart] 明暗/線地の反転 */
  invert: boolean;
  /** [lineart] 輪郭検出の強さ 0..100 */
  edge: number;
  /** 共通 -100..100 */
  brightness: number;
  contrast: number;
}

export const DEFAULT_CONVERT: ConvertOptions = {
  mode: "color",
  colors: 24,
  palette: "auto",
  dither: "fs",
  fit: "cover",
  paper: "#ffffff",
  fps: 4,
  title: "",
  threshold: 50,
  ditherAmt: 60,
  ink: "#141414",
  invert: false,
  edge: 50,
  brightness: 0,
  contrast: 0,
};

export type RGB = [number, number, number];

export const hexToRgb = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
export const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
    .join("")}`;

// ---------------- 前処理（明るさ/コントラスト・リサイズ） ----------------

/** brightness/contrast（-100..100）を RGB に適用した写しを返す */
export function applyBC(img: SourceImage, brightness: number, contrast: number): SourceImage {
  if (!brightness && !contrast) return img;
  const out = new Uint8Array(img.data);
  const b = brightness * 1.275;
  const c = contrast * 2.55;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  for (let i = 0; i < out.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = f * (img.data[i + k] - 128) + 128 + b;
      out[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { w: img.w, h: img.h, data: out };
}

/** 320×240 へリサイズ（面積平均）。cover=中央クロップ / contain=余白は alpha=0（=紙が透ける） */
export function resizeToCanvas(img: SourceImage, fit: "cover" | "contain"): SourceImage {
  const out = new Uint8Array(W * H * 4);
  const scale =
    fit === "cover" ? Math.max(W / img.w, H / img.h) : Math.min(W / img.w, H / img.h);
  const dw = Math.max(1, Math.round(img.w * scale));
  const dh = Math.max(1, Math.round(img.h * scale));
  const dx0 = Math.floor((W - dw) / 2);
  const dy0 = Math.floor((H - dh) / 2);
  for (let dy = 0; dy < dh; dy++) {
    const oy = dy0 + dy;
    if (oy < 0 || oy >= H) continue;
    const sy0 = (dy / dh) * img.h;
    const sy1 = ((dy + 1) / dh) * img.h;
    for (let dx = 0; dx < dw; dx++) {
      const ox = dx0 + dx;
      if (ox < 0 || ox >= W) continue;
      const sx0 = (dx / dw) * img.w;
      const sx1 = ((dx + 1) / dw) * img.w;
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      const yA = Math.floor(sy0);
      const yB = Math.min(img.h - 1, Math.max(yA, Math.ceil(sy1) - 1));
      const xA = Math.floor(sx0);
      const xB = Math.min(img.w - 1, Math.max(xA, Math.ceil(sx1) - 1));
      for (let sy = yA; sy <= yB; sy++)
        for (let sx = xA; sx <= xB; sx++) {
          const si = (sy * img.w + sx) * 4;
          r += img.data[si];
          g += img.data[si + 1];
          b += img.data[si + 2];
          n++;
        }
      const oi = (oy * W + ox) * 4;
      out[oi] = r / n;
      out[oi + 1] = g / n;
      out[oi + 2] = b / n;
      out[oi + 3] = 255;
    }
  }
  return { w: W, h: H, data: out };
}

/** 前処理一括: BC → 320×240（GUI/CLI/シートで共用） */
export function prepareCanvas(img: SourceImage, o: ConvertOptions): SourceImage {
  return resizeToCanvas(applyBC(img, o.brightness, o.contrast), o.fit);
}

// ---------------- color モード（median-cut 量子化＋ディザ） ----------------

/** median-cut 量子化（不透明画素のみ・N色） */
export function medianCut(imgs: SourceImage[], n: number): RGB[] {
  const px: RGB[] = [];
  for (const img of imgs)
    for (let i = 0; i < img.data.length; i += 4)
      if (img.data[i + 3] > 0) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  if (!px.length) return [[0, 0, 0]];
  let boxes: RGB[][] = [px];
  while (boxes.length < n) {
    let bi = -1,
      bAxis = 0,
      bRange = -1;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let a = 0; a < 3; a++) {
        let lo = 255,
          hi = 0;
        for (const p of box) {
          if (p[a] < lo) lo = p[a];
          if (p[a] > hi) hi = p[a];
        }
        if (hi - lo > bRange) {
          bRange = hi - lo;
          bi = i;
          bAxis = a;
        }
      }
    });
    if (bi < 0 || bRange <= 0) break;
    const box = boxes[bi];
    box.sort((p, q) => p[bAxis] - q[bAxis]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    let r = 0,
      g = 0,
      b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n2 = box.length || 1;
    return [Math.round(r / n2), Math.round(g / n2), Math.round(b / n2)] as RGB;
  });
}

function nearestIdx(pal: RGB[], r: number, g: number, b: number): number {
  let best = 0,
    bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const dr = r - pal[i][0],
      dg = g - pal[i][1],
      db = b - pal[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** 変換に使うパレットを決定（auto=全ページまとめて量子化＝アニメでちらつかない） */
export function resolvePalette(canvases: SourceImage[], o: ConvertOptions): RGB[] {
  if (o.palette === "ugo") return Object.values(UGO_COLORS).map(hexToRgb);
  // M11-14b: 既定パレットが6色になったので、「レトロ14色」は独立した RETRO_PALETTE を使う
  //（中身は従来の DEFAULT_PALETTE と同一＝ドット化の結果は変わらない）
  if (o.palette === "retro") return RETRO_PALETTE.map(hexToRgb);
  return medianCut(canvases, Math.max(2, Math.min(255, o.colors)));
}

/** RGBA(320×240) → パレット index 配列（-1=透明） */
export function quantizeFrame(
  img: SourceImage,
  pal: RGB[],
  dither: ConvertOptions["dither"]
): Int16Array {
  const out = new Int16Array(PIXELS).fill(-1);
  if (dither === "fs") {
    const buf = new Float32Array(PIXELS * 3);
    for (let i = 0; i < PIXELS; i++) {
      buf[i * 3] = img.data[i * 4];
      buf[i * 3 + 1] = img.data[i * 4 + 1];
      buf[i * 3 + 2] = img.data[i * 4 + 2];
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (img.data[i * 4 + 3] === 0) continue;
        const r = buf[i * 3],
          g = buf[i * 3 + 1],
          b = buf[i * 3 + 2];
        const pi = nearestIdx(pal, r, g, b);
        out[i] = pi;
        const er = r - pal[pi][0],
          eg = g - pal[pi][1],
          eb = b - pal[pi][2];
        const spread = (di: number, w8: number) => {
          buf[di * 3] += (er * w8) / 16;
          buf[di * 3 + 1] += (eg * w8) / 16;
          buf[di * 3 + 2] += (eb * w8) / 16;
        };
        if (x + 1 < W) spread(i + 1, 7);
        if (y + 1 < H) {
          if (x > 0) spread(i + W - 1, 3);
          spread(i + W, 5);
          if (x + 1 < W) spread(i + W + 1, 1);
        }
      }
    }
  } else {
    const amp = dither === "ordered" ? 24 : 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (img.data[i * 4 + 3] === 0) continue;
        const o = amp ? (BAYER4[y & 3][x & 3] / 16 - 0.5) * amp : 0;
        out[i] = nearestIdx(
          pal,
          img.data[i * 4] + o,
          img.data[i * 4 + 1] + o,
          img.data[i * 4 + 2] + o
        );
      }
  }
  return out;
}

// ---------------- tone / lineart モード ----------------

export function toGray(img: SourceImage): Float32Array {
  const g = new Float32Array(PIXELS).fill(-1); // -1 = 透明
  for (let i = 0; i < PIXELS; i++) {
    if (img.data[i * 4 + 3] === 0) continue;
    g[i] =
      0.299 * img.data[i * 4] +
      0.587 * img.data[i * 4 + 1] +
      0.114 * img.data[i * 4 + 2];
  }
  return g;
}

/** さつえい再現: しきい値±ディザ量で ink(true)/paper(false) の2値へ。null=透明 */
export function toneBinarize(
  gray: Float32Array,
  threshold: number,
  ditherAmt: number,
  ditherMode: ConvertOptions["dither"],
  invert: boolean
): (boolean | null)[] {
  const t = threshold * 2.55;
  const k = ditherAmt / 100;
  const out: (boolean | null)[] = new Array(PIXELS).fill(null);
  if (ditherMode === "ordered") {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (gray[i] < 0) continue;
        const o = (BAYER4[y & 3][x & 3] / 16 - 0.5) * 255 * k;
        let ink = gray[i] + o < t;
        if (invert) ink = !ink;
        out[i] = ink;
      }
    return out;
  }
  // fs（既定）: 誤差拡散の強さを k 倍 → 0=ベタ2値 ⇔ 100=全面ディザ の連続変化
  const buf = Float32Array.from(gray);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (gray[i] < 0) continue;
      const v = buf[i];
      const ink0 = v < t;
      const err = (v - (ink0 ? 0 : 255)) * k;
      if (ditherMode === "fs" && k > 0) {
        if (x + 1 < W && gray[i + 1] >= 0) buf[i + 1] += (err * 7) / 16;
        if (y + 1 < H) {
          if (x > 0 && gray[i + W - 1] >= 0) buf[i + W - 1] += (err * 3) / 16;
          if (gray[i + W] >= 0) buf[i + W] += (err * 5) / 16;
          if (x + 1 < W && gray[i + W + 1] >= 0) buf[i + W + 1] += (err * 1) / 16;
        }
      }
      out[i] = invert ? !ink0 : ink0;
    }
  return out;
}

/** Sobel 輪郭 → ink(true)/地(false)。edge 0..100 で線の出やすさ */
export function lineartBinarize(
  gray: Float32Array,
  edge: number,
  invert: boolean
): (boolean | null)[] {
  const mag = new Float32Array(PIXELS);
  const g = (x: number, y: number) => {
    const i = Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x));
    return gray[i] < 0 ? 255 : gray[i];
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const gx =
        -g(x - 1, y - 1) - 2 * g(x - 1, y) - g(x - 1, y + 1) +
        g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1);
      const gy =
        -g(x - 1, y - 1) - 2 * g(x, y - 1) - g(x + 1, y - 1) +
        g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1);
      mag[y * W + x] = Math.hypot(gx, gy) / 4;
    }
  const t = 255 * (1 - edge / 100) + 8; // edge=100 でも微小ノイズは拾わない
  const out: (boolean | null)[] = new Array(PIXELS).fill(null);
  for (let i = 0; i < PIXELS; i++) {
    if (gray[i] < 0) continue;
    let ink = mag[i] > t;
    if (invert) ink = !ink;
    out[i] = ink;
  }
  return out;
}

// ---------------- Project 組み立て・合成 ----------------

/** 変換一式: 元画像群＋オプション → 素材集 Project（「背景」1レイヤー×ページ数） */
export function convertToProject(images: SourceImage[], o: ConvertOptions): Project {
  const canvases = images.map((img) => prepareCanvas(img, o));
  const p = newProject(o.title || imageProjectTitle());
  p.layerDefs = [{ id: "L1", name: imageLayerName(), visible: true, opacity: 1 }];
  p.nextLayerId = 2;
  p.colorTable = [""];
  p.indexBits = 8;
  p.frames = [];
  p.loop = true;
  let best = 0;
  FPS_TABLE.forEach((f, i) => {
    if (Math.abs(f - o.fps) < Math.abs(FPS_TABLE[best] - o.fps)) best = i;
  });
  p.speedIndex = best;
  const paperIdx = ensureColor(p, o.paper);

  if (o.mode === "color") {
    p.colorMode = "fullcolor";
    const pal = resolvePalette(canvases, o);
    for (const cv of canvases) {
      const indices = quantizeFrame(cv, pal, o.dither);
      // 色解決 → バッファ取得の順（昇格でバッファ幅が変わるため）
      const colorIdx = pal.map((c) => ensureColor(p, rgbToHex(c[0], c[1], c[2])));
      const frame: Frame = { paper: paperIdx, layers: {} };
      const buf = allocIndexBuf(p);
      for (let i = 0; i < PIXELS; i++) {
        const q = indices[i];
        buf[i] = q < 0 ? 0 : colorIdx[q];
      }
      frame.layers["L1"] = buf;
      p.frames.push(frame);
    }
  } else {
    p.colorMode = "palette";
    const inkIdx = ensureColor(p, o.ink);
    for (const cv of canvases) {
      const gray = toGray(cv);
      const bin =
        o.mode === "tone"
          ? toneBinarize(gray, o.threshold, o.ditherAmt, o.dither === "none" ? "fs" : o.dither, o.invert)
          : lineartBinarize(gray, o.edge, o.invert);
      const frame: Frame = { paper: paperIdx, layers: {} };
      const buf = allocIndexBuf(p);
      for (let i = 0; i < PIXELS; i++) buf[i] = bin[i] === true ? inkIdx : 0;
      frame.layers["L1"] = buf;
      p.frames.push(frame);
    }
  }
  return p;
}

/** 変換結果の1ページを RGBA(320×240) へ合成（プレビュー/サムネ用。紙→背景レイヤー） */
export function frameToRgba(p: Project, fi: number): Uint8Array {
  const rgba = new Uint8Array(PIXELS * 4);
  const paper = hexToRgb(p.colorTable[p.frames[fi].paper] || "#ffffff");
  const buf = p.frames[fi].layers["L1"];
  for (let i = 0; i < PIXELS; i++) {
    const ci = buf[i];
    const c = ci > 0 ? hexToRgb(p.colorTable[ci]) : paper;
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
