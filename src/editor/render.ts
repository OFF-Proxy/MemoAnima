// 合成レンダラ（M3）: 320×240 の Uint32(RGBA) バッファへ合成する。
// 表示側は canvas(320×240) + CSS 整数倍 + image-rendering:pixelated で nearest-neighbor を保証。

import {
  Project,
  Frame,
  IndexBuf,
  PIXELS,
  W,
  H,
  buildLut,
  allocIndexBuf,
  effectiveLayerStates,
} from "./model";

export interface CompositeOptions {
  /** 紙を描かない（サムネ透過用途など） */
  skipPaper?: boolean;
  /** このレイヤーIDだけ除外 */
  excludeLayer?: string;
  /** オニオンスキン: 前後何コマ透かすか（0=off） */
  onion?: number;
}

const ONION_PREV = 0xff3b3bff; // 前=赤（値は下で分解して使う）
const ONION_NEXT = 0xffa21fff; // 次=青

/** src(不透明色) を alpha で out[i] に重ねる */
function blendPixel(out: Uint32Array, i: number, rgba: number, alpha: number) {
  if (alpha >= 1) {
    out[i] = rgba;
    return;
  }
  const dst = out[i];
  const sr = rgba & 0xff,
    sg = (rgba >> 8) & 0xff,
    sb = (rgba >> 16) & 0xff;
  const dr = dst & 0xff,
    dg = (dst >> 8) & 0xff,
    db = (dst >> 16) & 0xff;
  const r = (sr * alpha + dr * (1 - alpha)) | 0;
  const g = (sg * alpha + dg * (1 - alpha)) | 0;
  const b = (sb * alpha + db * (1 - alpha)) | 0;
  out[i] = (r | (g << 8) | (b << 16) | (0xff << 24)) >>> 0;
}

/** 1レイヤーを out に合成（索引は 8/16bit どちらでも同一コードで動く） */
function blendLayer(
  out: Uint32Array,
  buf: IndexBuf,
  lut: Uint32Array,
  opacity: number
) {
  if (opacity >= 1) {
    for (let i = 0; i < PIXELS; i++) {
      const v = buf[i];
      if (v !== 0) out[i] = lut[v];
    }
  } else if (opacity > 0) {
    for (let i = 0; i < PIXELS; i++) {
      const v = buf[i];
      if (v !== 0) blendPixel(out, i, lut[v], opacity);
    }
  }
}

/** オニオン用: フレームのシルエットを単色 tint で薄く重ねる（実効可視=フォルダ祖先の積で判定） */
function blendOnion(
  out: Uint32Array,
  p: Project,
  eff: ReturnType<typeof effectiveLayerStates>,
  frameIndex: number,
  tintR: number,
  tintG: number,
  tintB: number,
  alpha: number
) {
  const f = p.frames[frameIndex];
  if (!f) return;
  const rgba = (tintR | (tintG << 8) | (tintB << 16) | (0xff << 24)) >>> 0;
  for (const ld of p.layerDefs) {
    // M6-4 P-7: フォルダで非表示のレイヤーはオニオンにも出さない（不透明度は従来どおり無視）
    if (!(eff.get(ld.id)?.visible ?? ld.visible)) continue;
    const buf = f.layers[ld.id];
    if (!buf) continue;
    for (let i = 0; i < PIXELS; i++) {
      if (buf[i] !== 0) blendPixel(out, i, rgba, alpha);
    }
  }
}

/** コマ固有の描画順（KWZの3D奥行き由来）があればそれを優先した layerDefs 列を返す。
 *  破損・将来ファイルで order に載っていないレイヤーは末尾（最上位）に補完し、
 *  重複・未知IDは無視する（レイヤーが黙って消えないように・Codexレビュー指摘）。
 *  M10-19: compositeFrame と flattenIndexFrame で同一の順序解決を共有するため関数化（挙動不変）。 */
function orderedLayerDefs(p: Project, frame: Frame): Project["layerDefs"] {
  let defs = p.layerDefs;
  if (frame.order) {
    const seen = new Set<string>();
    const list: typeof p.layerDefs = [];
    for (const id of frame.order) {
      if (seen.has(id)) continue;
      const ld = p.layerDefs.find((l) => l.id === id);
      if (ld) {
        list.push(ld);
        seen.add(id);
      }
    }
    for (const ld of p.layerDefs) if (!seen.has(ld.id)) list.push(ld);
    defs = list;
  }
  return defs;
}

/** M10-19: 添字レベルの平坦化 — 実効可視レイヤーを合成順（下→上）に走査し、
 *  各画素で**最前面の非0添字**を採った参照バッファを返す（全レイヤー参照のバケツ/自動選択用）。
 *  - 紙（paper）は含めない（0=透明のまま。「紙は境界ではなく空白」として扱う）
 *  - 不透明度は参照目的では無視（実効可視でありさえすれば非0画素は境界になる）
 *  - オニオンスキンは含めない
 *  - 値は添字のコピーだけ。色計算・補間・平均・ブレンドは一切しない（IndexBuf の掟） */
export function flattenIndexFrame(p: Project, frameIndex: number): IndexBuf {
  const out = allocIndexBuf(p);
  const frame = p.frames[frameIndex];
  if (!frame) return out;
  const eff = effectiveLayerStates(p);
  for (const ld of orderedLayerDefs(p, frame)) {
    const e = eff.get(ld.id) ?? { visible: ld.visible, opacity: ld.opacity };
    if (!e.visible) continue;
    const lb = frame.layers[ld.id];
    if (!lb) continue;
    // 下→上へ非0を上書き＝結果として各画素は最前面の非0添字になる
    for (let i = 0; i < PIXELS; i++) if (lb[i] !== 0) out[i] = lb[i];
  }
  return out;
}

/**
 * フレームを合成する。戻り値は使い回し可能な Uint32Array（out を渡せばそこへ描く）。
 * 描画順: 紙 → オニオン（前=赤/次=青） → レイヤー（下→上）。
 */
export function compositeFrame(
  p: Project,
  frameIndex: number,
  out?: Uint32Array,
  opts: CompositeOptions = {}
): Uint32Array {
  const lut = buildLut(p.colorTable);
  const buf = out ?? new Uint32Array(PIXELS);
  const frame = p.frames[frameIndex];
  if (!frame) {
    buf.fill(0);
    return buf;
  }
  if (opts.skipPaper) {
    buf.fill(0);
  } else {
    buf.fill(lut[frame.paper] || 0xffffffff);
  }
  // M3.7: フォルダの実効可視/不透明度（祖先の積）。オニオンも同じ実効可視で判定する
  const eff = effectiveLayerStates(p);
  const onion = opts.onion ?? 0;
  if (onion > 0) {
    for (let k = onion; k >= 1; k--) {
      const a = 0.28 / k;
      if (frameIndex - k >= 0)
        blendOnion(buf, p, eff, frameIndex - k, 0xff, 0x3b, 0x3b, a);
      if (frameIndex + k < p.frames.length)
        blendOnion(buf, p, eff, frameIndex + k, 0x1f, 0xa2, 0xff, a);
    }
  }
  const defs = orderedLayerDefs(p, frame);
  for (const ld of defs) {
    const e = eff.get(ld.id) ?? { visible: ld.visible, opacity: ld.opacity };
    if (!e.visible || ld.id === opts.excludeLayer) continue;
    const lb = frame.layers[ld.id];
    if (lb) blendLayer(buf, lb, lut, e.opacity);
  }
  return buf;
}

/** Uint32 合成結果を canvas(320×240) に転送 */
export function presentToCanvas(buf: Uint32Array, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const img = new ImageData(new Uint8ClampedArray(buf.buffer, 0, PIXELS * 4), W, H);
  ctx.putImageData(img, 0, 0);
}

/** フレームのサムネイル PNG Blob（等倍320×240） */
export function frameToPngBlob(p: Project, frameIndex: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  presentToCanvas(compositeFrame(p, frameIndex), canvas);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// 参照されないimport警告避け（ONION定数はドキュメント目的で残置）
void ONION_PREV;
void ONION_NEXT;
