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
  hasClipLayers,
  clipBaseMap,
} from "./model";

export interface CompositeOptions {
  /** 紙を描かない（サムネ透過用途など） */
  skipPaper?: boolean;
  /** このレイヤーIDだけ除外 */
  excludeLayer?: string;
  /** オニオンスキン: 前後何コマ透かすか（0=off） */
  onion?: number;
  /** V164 (U-1): 透かす向き。"prev"=前のコマだけ（赤）／"next"=次のコマだけ（青）／
   *  **省略時は "both"＝前後の両方**（v1.6.0 までと1画素も変わらない既定）。
   *  段数（`onion`）とは独立した軸で、色は現行のまま（前＝赤・後＝青）。 */
  onionDir?: OnionDir;
}

/** V164 (U-1): オニオンの向き。設定に保存する値そのもの（`settings.onionDir`）。 */
export type OnionDir = "prev" | "both" | "next";

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

/** 1レイヤーを out に合成（索引は 8/16bit どちらでも同一コードで動く）。
 *  M11-20: `mask`（クリッピングの土台バッファ）を渡すと、**土台の同じ画素が非0のときだけ**描く。
 *  判定は添字の非0チェックのみ（色演算なし）。mask なしの 2 ループは M11-19 以前と 1 命令も変えていない
 *  （clip なし作品のホットパスを守る）。 */
function blendLayer(
  out: Uint32Array,
  buf: IndexBuf,
  lut: Uint32Array,
  opacity: number,
  mask: IndexBuf | null = null,
  /** M15 (K-2): レイヤーカラー。undefined＝従来どおり lut[v]（この既定のときホットパスは1命令も変わらない）。
   *  数値のとき、その RGBA を**索引に依らず一律で**使う（不透明ピクセルの色だけを置換・形は不変）。 */
  tint?: number
) {
  // M15 (K-2): 表示色が指定されているときだけ、index→RGBA 解決を tint に差し替える早期分岐。
  // tint === undefined の下は M11-20 から 1 命令も変えていない（displayColor 無しの合成は従来と同一＝スモークで固定）。
  if (tint !== undefined) {
    if (mask) {
      if (opacity >= 1) {
        for (let i = 0; i < PIXELS; i++) {
          const v = buf[i];
          if (v !== 0 && mask[i] !== 0) out[i] = tint;
        }
      } else if (opacity > 0) {
        for (let i = 0; i < PIXELS; i++) {
          const v = buf[i];
          if (v !== 0 && mask[i] !== 0) blendPixel(out, i, tint, opacity);
        }
      }
      return;
    }
    if (opacity >= 1) {
      for (let i = 0; i < PIXELS; i++) {
        const v = buf[i];
        if (v !== 0) out[i] = tint;
      }
    } else if (opacity > 0) {
      for (let i = 0; i < PIXELS; i++) {
        const v = buf[i];
        if (v !== 0) blendPixel(out, i, tint, opacity);
      }
    }
    return;
  }
  if (mask) {
    if (opacity >= 1) {
      for (let i = 0; i < PIXELS; i++) {
        const v = buf[i];
        if (v !== 0 && mask[i] !== 0) out[i] = lut[v];
      }
    } else if (opacity > 0) {
      for (let i = 0; i < PIXELS; i++) {
        const v = buf[i];
        if (v !== 0 && mask[i] !== 0) blendPixel(out, i, lut[v], opacity);
      }
    }
    return;
  }
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

/** M15 (K-2): "#RRGGBB" → 0xAABBGGRR（buildLut と同じ並び・不透明）。不正値は undefined。 */
function displayColorRgba(hex: string | undefined): number | undefined {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** M11-20: clip レイヤー ld の**土台バッファ**を返す。土台なし／土台が実効非表示／土台のバッファが
 *  そのコマに無い → null（＝この clip レイヤーは描かない）。bases が null なら clip なし作品＝常に「マスクなし」。
 *  戻り値の意味: `undefined` = 通常描画（マスクなし）／`null` = 描かない／IndexBuf = そのマスクで描く */
function clipMaskFor(
  ld: Project["layerDefs"][number],
  frame: Frame,
  eff: ReturnType<typeof effectiveLayerStates>,
  bases: Map<string, string | null> | null
): IndexBuf | null | undefined {
  if (!bases || ld.clip !== true) return undefined;
  const baseId = bases.get(ld.id);
  if (!baseId) return null;
  if (!(eff.get(baseId)?.visible ?? true)) return null;
  return frame.layers[baseId] ?? null;
}

/** オニオン用: フレームのシルエットを単色 tint で薄く重ねる（実効可視=フォルダ祖先の積で判定）。
 *  M11-20: clip レイヤーはそのコマの土台でマスクする（編集画面・書き出しと同じ見え方） */
function blendOnion(
  out: Uint32Array,
  p: Project,
  eff: ReturnType<typeof effectiveLayerStates>,
  bases: Map<string, string | null> | null,
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
    const mask = clipMaskFor(ld, f, eff, bases);
    if (mask === null) continue;
    if (mask) {
      for (let i = 0; i < PIXELS; i++) {
        if (buf[i] !== 0 && mask[i] !== 0) blendPixel(out, i, rgba, alpha);
      }
      continue;
    }
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
  // M11-20: クリッピングは「見えている絵」で判定する（見えない画素を境界にしない）
  const bases = hasClipLayers(p) ? clipBaseMap(p) : null;
  for (const ld of orderedLayerDefs(p, frame)) {
    const e = eff.get(ld.id) ?? { visible: ld.visible, opacity: ld.opacity };
    if (!e.visible) continue;
    const lb = frame.layers[ld.id];
    if (!lb) continue;
    const mask = clipMaskFor(ld, frame, eff, bases);
    if (mask === null) continue;
    if (mask) {
      for (let i = 0; i < PIXELS; i++) if (lb[i] !== 0 && mask[i] !== 0) out[i] = lb[i];
      continue;
    }
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
  } else if (frame.paper === 0) {
    // M11-16: 透明の紙（paper=0 は透明予約の添字）。skipPaper と同じ「0 のまま」＝合成バッファには
    // 何も焼かない（市松は表示層＝#ed-canvas の背景で出す）。旧ビルドはこの分岐が無く
    // `lut[0] || 白` に落ちるので、同じファイルを開くと「白い紙」として表示される（互換）
    buf.fill(0);
  } else {
    buf.fill(lut[frame.paper] || 0xffffffff);
  }
  // M3.7: フォルダの実効可視/不透明度（祖先の積）。オニオンも同じ実効可視で判定する
  const eff = effectiveLayerStates(p);
  // M11-20: クリッピングの土台（構造順・同じ親内・1 パス）。clip レイヤーが 1 枚も無ければ null＝
  // 以下の分岐はすべて「マスクなし」に落ち、clip なし作品の合成は従来と同じ経路を通る
  const bases = hasClipLayers(p) ? clipBaseMap(p) : null;
  const onion = opts.onion ?? 0;
  if (onion > 0) {
    // V164 (U-1): 向きで行を通す/通さないだけ。**段数・色・不透明度の式は1つも変えていない**
    //（"both" は従来と同じ2行＝既定の絵はビット同一）
    const dir = opts.onionDir ?? "both";
    const wantPrev = dir !== "next";
    const wantNext = dir !== "prev";
    for (let k = onion; k >= 1; k--) {
      const a = 0.28 / k;
      if (wantPrev && frameIndex - k >= 0)
        blendOnion(buf, p, eff, bases, frameIndex - k, 0xff, 0x3b, 0x3b, a);
      if (wantNext && frameIndex + k < p.frames.length)
        blendOnion(buf, p, eff, bases, frameIndex + k, 0x1f, 0xa2, 0xff, a);
    }
  }
  const defs = orderedLayerDefs(p, frame);
  for (const ld of defs) {
    const e = eff.get(ld.id) ?? { visible: ld.visible, opacity: ld.opacity };
    if (!e.visible || ld.id === opts.excludeLayer) continue;
    const lb = frame.layers[ld.id];
    if (!lb) continue;
    // clip: 土台の同じ画素が非0の所だけ描く。土台なし／土台非表示／土台バッファなし → 描かない
    const mask = clipMaskFor(ld, frame, eff, bases);
    if (mask === null) continue;
    // M15 (K-2): レイヤーカラー。undefined なら従来どおり lut で描く（displayColor 無しは完全に元の経路）
    // V157 (D-2): **このコマだけの指定があればそちらが勝つ**（レイヤー既定は `ld.displayColor`）。
    // 索引には一切触れない——描くときに色を差し替えるだけなので、外せば完全に元へ戻る
    blendLayer(
      buf,
      lb,
      lut,
      e.opacity,
      mask ?? null,
      displayColorRgba(frame.layerColors?.[ld.id] ?? ld.displayColor)
    );
  }
  return buf;
}

/** Uint32 合成結果を canvas(320×240) に転送 */
export function presentToCanvas(buf: Uint32Array, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const img = new ImageData(new Uint8ClampedArray(buf.buffer, 0, PIXELS * 4), W, H);
  ctx.putImageData(img, 0, 0);
}

/** M11-11: 1コマを画像に書き出す（PNG / JPEG・1〜8倍）。
 *  拡大は**整数倍のドット複製**（なましなし）。canvas の drawImage は使わず、
 *  画素をそのまま並べるので「補間で縁がぼける」ことが原理的に起きない。
 *  - transparent: 紙（背景）を透明にする。PNG のみ意味を持つ
 *  - JPEG は透過を持てないので、常に紙を敷いた合成を出す（＝作品の紙色。既定は白） */
export function frameToImageBlob(
  p: Project,
  frameIndex: number,
  opts: { scale: number; type: "image/png" | "image/jpeg"; transparent?: boolean }
): Promise<Blob | null> {
  const s = Math.max(1, Math.min(8, Math.round(opts.scale) || 1));
  const jpeg = opts.type === "image/jpeg";
  const transparent = !jpeg && opts.transparent === true;
  const src = compositeFrame(p, frameIndex, undefined, { skipPaper: transparent });
  const ow = W * s;
  const oh = H * s;
  const out = new Uint32Array(ow * oh);
  // ドット複製（最近傍）。1画素を s×s に広げるだけ＝平均も補間もしない
  for (let y = 0; y < H; y++) {
    const rowTop = y * s * ow;
    for (let x = 0; x < W; x++) {
      const v = src[y * W + x];
      const left = x * s;
      for (let dy = 0; dy < s; dy++) {
        const o = rowTop + dy * ow + left;
        for (let dx = 0; dx < s; dx++) out[o + dx] = v;
      }
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = ow;
  canvas.height = oh;
  const ctx = canvas.getContext("2d")!;
  if (jpeg) {
    // JPEG は透過を持てない。念のため白で塗ってから重ねる（合成側に alpha=0 が残っていても白になる）
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, ow, oh);
  }
  const img = new ImageData(new Uint8ClampedArray(out.buffer, 0, ow * oh * 4), ow, oh);
  if (jpeg) {
    // putImageData は下地を無視して置き換えるので、白の上に重ねるには一度別 canvas を経由する
    const tmp = document.createElement("canvas");
    tmp.width = ow;
    tmp.height = oh;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.putImageData(img, 0, 0);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, opts.type, jpeg ? 0.92 : undefined));
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
