// V223 (M-2b-3b-1・UI §5-5 の色・§5-11・U-9・指示書 ■3 の F-8): 色の四角と色相の**計算**（画面を持たない・v223 [C] が見る）。
//
// ★色は計算で作る（ここに色の値を直書きしない＝U-9）。色相 h は 0〜360（0 と 360 は同じ赤）・鮮やかさ s と明るさ v は 0〜1。
// ★作品の色の値は「# と 16 進 6 桁の小文字」（PC の色の入力と同じ形）。画面に出すときは大文字。

export interface Hsv {
  h: number;
  s: number;
  v: number;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const HEX_DIGITS = 16;

/** HSV → RGB（0〜255 の整数） */
export function hsvToRgb(c: Hsv): [number, number, number] {
  const h = (((c.h % 360) + 360) % 360) / 60;
  const s = clamp01(c.s);
  const v = clamp01(c.v);
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const rgb = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return [Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255)];
}

function two(n: number): string {
  return n.toString(HEX_DIGITS).padStart(2, "0");
}

/** RGB → 作品の色の値（小文字） */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${two(r)}${two(g)}${two(b)}`;
}

export function hsvToHex(c: Hsv): string {
  const [r, g, b] = hsvToRgb(c);
  return rgbToHex(r, g, b);
}

/** 作品の色の値 → RGB（読めなければ null） */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], HEX_DIGITS), parseInt(m[2], HEX_DIGITS), parseInt(m[3], HEX_DIGITS)];
}

/** 作品の色の値 → HSV。色相が決まらない色（灰・黒＝鮮やかさ 0）は keepHue を色相にする（前に選んだ色相のまま） */
export function hexToHsv(hex: string, keepHue = 0): Hsv | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  if (d === 0) return { h: keepHue, s, v };
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, v };
}

/** 色の値の欄の読み方: `#RRGGBB`・`RRGGBB`・`#RGB`（大文字小文字どちらでも・前後の空白は捨てる）。読めなければ null */
export function parseHexInput(text: string): string | null {
  const s = text.trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) return `#${m[1].toLowerCase()}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  return null;
}

/** 画面に出す形（大文字） */
export function hexLabel(hex: string): string {
  return hex.toUpperCase();
}

/** ★色見本（この作品の色）に出す色: 色の表の 1 番から、空き番号（""）と同じ色の重なりを除く（PC の V195・A-99 と同じ） */
export function shownColors(colorTable: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 1; i < colorTable.length; i++) {
    const hex = colorTable[i];
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

/** 四角の上の点（0〜1）→ 鮮やかさと明るさ（左が白っぽく・右が鮮やか・上が明るく・下が暗い） */
export function svAt(fx: number, fy: number): { s: number; v: number } {
  return { s: clamp01(fx), v: 1 - clamp01(fy) };
}

/** 縦棒の上の点（0〜1・上が赤＝色相 0）→ 色相（一番下は 360 にせず、赤の手前で止める） */
export function hueAt(fy: number): number {
  return Math.min(359.999, clamp01(fy) * 360);
}

/** 色相だけの色（鮮やかさ 1・明るさ 1）の 3 つの成分（0〜1・丸めない） */
export function hueUnit(hue: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 60;
  const i = Math.floor(h) % 6;
  const f = h - Math.floor(h);
  return ([
    [1, f, 0],
    [1 - f, 1, 0],
    [0, 1, f],
    [0, 1 - f, 1],
    [f, 0, 1],
    [1, 0, 1 - f],
  ] as [number, number, number][])[i];
}

/** 四角の絵（幅 w・高さ h の RGBA）。色は計算で作る。
 *  ★1 画素ごとに hsvToRgb を呼ばない（指に付いて色相を動かすたびに塗り直すので軽くする＝第三者レビューの M1）。
 *  成分 c（0〜1）の色相で、鮮やかさ s・明るさ v の値は v×(1 − s×(1 − c))＝hsvToRgb と同じ式 */
export function paintSv(data: Uint8ClampedArray, w: number, h: number, hue: number): void {
  const [ur, ug, ub] = hueUnit(hue);
  const kr = 1 - ur;
  const kg = 1 - ug;
  const kb = 1 - ub;
  const sx = w > 1 ? 1 / (w - 1) : 0;
  for (let y = 0; y < h; y++) {
    const v255 = (1 - (h > 1 ? y / (h - 1) : 0)) * 255;
    let o = y * w * 4;
    for (let x = 0; x < w; x++) {
      const s = x * sx;
      data[o] = Math.round(v255 * (1 - s * kr));
      data[o + 1] = Math.round(v255 * (1 - s * kg));
      data[o + 2] = Math.round(v255 * (1 - s * kb));
      data[o + 3] = 255;
      o += 4;
    }
  }
}

/** 縦棒の絵（上が赤） */
export function paintHue(data: Uint8ClampedArray, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const [r, g, b] = hsvToRgb({ h: hueAt(h > 1 ? y / (h - 1) : 0), s: 1, v: 1 });
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
}
