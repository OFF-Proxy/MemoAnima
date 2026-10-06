// V192（A-93・REQ_thumb_scale §2・§5）: 320×240 の絵を「画面の実際の画素」で出す共通の道（DOM 側）。
//
// R-1 ライブラリのサムネ／R-2 再生画面／R-3 コマ一覧／R-4 小さいプレビュー／R-5 音の窓のプレビューは、
// 全部ここの presentFit を通る。
//   ★V192b（決-2 の改め）: R-2 の再生画面だけは枠いっぱい（fitFor の fill）。半端な倍率は "fill"＝縮めるのと同じ
//     面積平均の式で広げる（境目の 1 画素だけが混ざる）。ちょうど整数倍なら "up"（最近傍）のまま
//   - 出す大きさ（fit）は fitDisplay（downscale.ts の純関数）が決める: 枠（CSS の px）× devicePixelRatio の実画素
//   - キャンバスのバッキング＝その実画素・CSS の大きさ＝実画素 / dpr（**CSS では引き伸ばさない＝1:1**）
//   - 縮めるとき（fit.mode === "down"）: downscaleArea（面積平均・光の量で混ぜる）→ putImageData。ブラウザの縮小は使わない
//   - 広げるとき（fit.mode === "up"）: 整数 k 倍の最近傍。元の大きさの下書きに置いて drawImage で k 倍（補間なし）
//     ——k は整数なので、出す画素 x は元の画素 floor(x / k) に必ず 1 対 1 で決まる（エンジンの差が出ない）
// ⚠ 表示だけ。ここで作った画素はどこにも保存しない（IndexBuf・.memoanima・サムネの PNG は 320×240 のまま）。

import { resampleArea, fitDisplay, type DisplayFit } from "./downscale";

export type { DisplayFit } from "./downscale";

/** いまの devicePixelRatio（0・NaN は 1） */
export function currentDpr(): number {
  const d = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return d > 0 && Number.isFinite(d) ? d : 1;
}

/** 要素の中身の大きさ（CSS の px・小数のまま）。枠線と padding を除く。表示されていなければ null */
export function contentBox(el: Element): { w: number; h: number } | null {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  const cs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const w =
    r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight);
  const h =
    r.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom);
  return w >= 1 && h >= 1 ? { w, h } : null;
}

/** 枠 el（の中身）に sw×sh の絵を出すときの大きさ（実画素で数える）。表示されていなければ null。
 *  fill＝枠いっぱい（V192b・ライブラリの再生画面だけ）。既定は整数倍（サムネ・コマ一覧・小さいプレビュー・音の窓） */
export function fitFor(el: Element, sw = 320, sh = 240, fill = false): DisplayFit | null {
  const b = contentBox(el);
  if (!b) return null;
  return fitDisplay(b.w, b.h, currentDpr(), sw, sh, fill);
}

/** fit を比べる鍵（大きさが同じなら描き直しは要らない） */
export function fitKey(f: DisplayFit | null): string {
  return f ? `${f.mode}:${f.devW}x${f.devH}@${f.cssW}` : "";
}

let scratch: HTMLCanvasElement | null = null;
const outCache = new Map<string, Uint8ClampedArray>();
/** V192b: 枠いっぱい（"fill"・再生画面）の出力は大きい（dpr 2 で 1 枚 31MB）ので、縮める用（小さい・枚数あり）と分けて
 *  **1 枠だけ**持つ。大きさが変わったら差し替える（窓の端をドラッグしても古い大きさを持ち続けない） */
let fillOut: Uint8ClampedArray | null = null;

/** Uint32Array（compositeFrame の戻り）を RGBA のバイト列として見る（写さない） */
export function rgbaOf(buf: Uint32Array, sw = 320, sh = 240): Uint8ClampedArray {
  return new Uint8ClampedArray(buf.buffer, buf.byteOffset, sw * sh * 4);
}

/**
 * ★RGBA（sw×sh）をキャンバス cv に fit のとおり出す（R-1〜R-5 の共通の出口）。
 * バッキング＝fit.devW×devH（実画素）・CSS の大きさ＝fit.cssW×cssH（1:1）。
 */
export function presentFit(
  cv: HTMLCanvasElement,
  rgba: Uint8ClampedArray,
  sw: number,
  sh: number,
  fit: DisplayFit,
): void {
  if (cv.width !== fit.devW) cv.width = fit.devW;
  if (cv.height !== fit.devH) cv.height = fit.devH;
  const cw = `${fit.cssW}px`;
  const ch = `${fit.cssH}px`;
  if (cv.style.width !== cw) cv.style.width = cw;
  if (cv.style.height !== ch) cv.style.height = ch;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  if (fit.mode === "down" || fit.mode === "fill") {
    // 面積平均（光の量で混ぜる）。ブラウザの縮小（drawImage の補間・CSS）には任せない。
    // 縮める（down）のも、枠いっぱいへ半端な倍率で広げる（fill・V192b の再生画面）のも同じ式（resampleArea＝downscaleArea）
    const n = fit.devW * fit.devH * 4;
    let out: Uint8ClampedArray | undefined;
    if (fit.mode === "fill") {
      if (!fillOut || fillOut.length !== n) fillOut = new Uint8ClampedArray(n);
      out = fillOut;
    } else {
      const key = `${fit.devW}x${fit.devH}`;
      out = outCache.get(key);
      if (!out) {
        if (outCache.size > 8) outCache.clear();
        out = new Uint8ClampedArray(n);
        outCache.set(key, out);
      }
    }
    resampleArea(rgba, sw, sh, fit.devW, fit.devH, out);
    ctx.putImageData(new ImageData(out, fit.devW, fit.devH), 0, 0);
    return;
  }
  // 整数 k 倍（k ≥ 1）の最近傍
  if (fit.k === 1 && fit.devW === sw && fit.devH === sh) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, sw * sh * 4), sw, sh), 0, 0);
    return;
  }
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== sw) scratch.width = sw;
  if (scratch.height !== sh) scratch.height = sh;
  const sctx = scratch.getContext("2d");
  if (!sctx) return;
  sctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, sw * sh * 4), sw, sh), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, fit.devW, fit.devH);
  ctx.drawImage(scratch, 0, 0, sw, sh, 0, 0, sw * fit.k, sh * fit.k);
}

let decodeCv: HTMLCanvasElement | null = null;

/**
 * 画像（サムネの PNG）を **1:1 で** RGBA に読む（縮めない・補間しない）。R-1 のサムネはこれで元の 320×240 を読み、
 * presentFit で面積平均する。読めなければ投げる。
 */
export async function decodeImageRgba(png: Blob): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const url = URL.createObjectURL(png);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!(w > 0 && h > 0)) throw new Error("decodeImageRgba: empty image");
  if (!decodeCv) decodeCv = document.createElement("canvas");
  if (decodeCv.width !== w) decodeCv.width = w;
  if (decodeCv.height !== h) decodeCv.height = h;
  const ctx = decodeCv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("decodeImageRgba: no 2d context");
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0); // 等倍（大きさを渡さない＝拡大縮小しない）
  return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
}

/** キャンバスのバッキングを手放す（コマ一覧の見えていないサムネ・F-0 のメモリ）。CSS の大きさはそのまま */
export function releaseCanvas(cv: HTMLCanvasElement): void {
  if (cv.width !== 0) cv.width = 0;
  if (cv.height !== 0) cv.height = 0;
}

// ---------------- devicePixelRatio の変化 ----------------
// ResizeObserver は CSS の大きさが同じなら dpr だけ変わっても呼ばれない（窓を別の画面へ動かした・表示倍率を変えた）。
// matchMedia の resolution で拾う（変わるたびに今の dpr で張り直す）。

const dprSubs = new Set<() => void>();
let dprMq: MediaQueryList | null = null;

function onDpr() {
  armDpr();
  for (const f of [...dprSubs]) {
    try {
      f();
    } catch {
      /* 1 つの失敗で止めない */
    }
  }
}

function armDpr() {
  dprMq?.removeEventListener("change", onDpr);
  dprMq = typeof matchMedia === "function" ? matchMedia(`(resolution: ${currentDpr()}dppx)`) : null;
  dprMq?.addEventListener("change", onDpr);
}

/**
 * 枠 el の大きさか devicePixelRatio が変わったら cb を呼ぶ（作り直しの合図）。戻り値で止める。
 * 大きさは ResizeObserver（中身の大きさ）・dpr は matchMedia。
 */
export function watchFit(el: Element, cb: () => void): () => void {
  const ro = new ResizeObserver(() => cb());
  ro.observe(el);
  if (!dprMq) armDpr();
  dprSubs.add(cb);
  return () => {
    ro.disconnect();
    dprSubs.delete(cb);
  };
}
