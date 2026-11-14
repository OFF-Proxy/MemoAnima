// V220 (M-2b-1b・要件 docs/REQ_mobile_m2_editor.md §5-1 の 5・C4・UI docs/REQ_mobile_ui_v1.md §4-1〜§4-3・U-30): **倍率の計算**。
//
// ★画面を持たない部品（DOM を読まない・時計を使わない）。画面の大きさ（CSS の px＝pt）と devicePixelRatio を受けて、区分・開いたときの
//  倍率と位置・ピンチを離したときに寄る倍率と位置・端の決まり・見える範囲を返す。動き（0.16s で寄る）は画面の側。
// ★位置は**絵の中身（1 ドット目）の左上**の画面の座標（x, y）。絵の縁（4px×2）はその外側（UI §4-1 の「絵の縁も含めて入ること」）。
//  90°・270° に回しているときは、回した絵の外接の箱の左上（縦と横を入れ替えた大きさで見る）。
// ★ドットを揃える（不変条件 #3・UG-4）: 倍率は物理画素の整数倍（n ÷ dpr）だけ。位置も**最後に 1 か所**（[`alignToDevice`]）で
//  物理画素（1 ÷ dpr）に丸める。端の決まりの範囲の中に収まる向きへ丸め（範囲が 1 物理画素より狭いときは近いほう）、端の決まりを壊さない。
// ★低（高さ 500 未満）は区分を返すだけ（倍率と配置は M-3 まで＝決-20）。狭（スマホ縦）は倍率だけ（位置と見える範囲は M-3）。

/** 絵の大きさ（ドット） */
export const PIC_W = 320;
export const PIC_H = 240;
/** 絵の縁（px・片側） */
export const PIC_BORDER = 4;
/** 上限（どの端末も・1 ドットが 32pt）・触れている間の行き過ぎ */
export const ZOOM_MAX = 32;
export const ZOOM_LIVE_MAX = 34;
/** 触れている間は fit のこの倍まで縮められる */
export const ZOOM_LIVE_MIN_RATIO = 0.6;
/** 端の決まり: 見える範囲より小さい絵は縁からこの内に収める・大きい絵の端はこの分までしか内側へ入れない */
export const EDGE_INSIDE = 4;
export const EDGE_REACH = 40;
/** 区分の境目（親D-15・UI §4-3 の仮） */
export const CAT_LOW_H = 500;
export const CAT_WIDE_W = 1000;
export const CAT_MEDIUM_W = 600;

/** 描く画面の寸法（UI §4-1・§5-1・§5-11） */
export const LAYOUT = {
  /** 横（広）: 左右の「端 12＋列 68＋すき間 16」・下の帯 72・上下のすき間 8 */
  wideSide: 12 + 68 + 16,
  wideBottomBar: 72,
  wideGapY: 8,
  /** 縦（中）: 左右 6・上の段とファイルの島の帯 72（上 4＋高さ 68）＋すき間 4・ツールの段 68＋すき間 12×2・下の帯 72 */
  mediumSide: 6,
  mediumTopBand: 4 + 68,
  mediumTopGap: 4,
  mediumToolRow: 68,
  mediumToolGap: 12,
  mediumBottomBar: 72,
  /** ★V222 (E-1): 縦の絵の下のパネルの場所（ツールの段の下 12 から下の帯の上 12 まで）に残す高さ 200 と、その下のすき間 12 */
  mediumPanelKeep: 200 + 12,
  /** 縦の見える範囲の下の余白（ボードの値に合わせた: ツールを出しているときはツールの段の上 6・隠したときは下の帯の上 4） */
  mediumVisibleAboveTools: 6,
  mediumVisibleAboveBar: 4,
  /** スマホ縦（狭）: 左右 8 */
  narrowSide: 8,
} as const;

export type Category = "wide" | "medium" | "narrow" | "low";

/** 区分（UI §4-3）: 低（高さ 500 未満）を先に・広（幅 1000 以上で横長）・中（幅 600 以上で広でない）・狭 */
export function categoryOf(w: number, h: number): Category {
  if (h < CAT_LOW_H) return "low";
  if (w >= CAT_WIDE_W && w > h) return "wide";
  if (w >= CAT_MEDIUM_W) return "medium";
  return "narrow";
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 絵を置ける場所（縁を含めた箱がこの中に入る）。低は null */
function placeArea(cat: Category, w: number, h: number): { w: number; h: number } | null {
  const L = LAYOUT;
  switch (cat) {
    case "wide":
      return { w: w - 2 * L.wideSide, h: h - L.wideBottomBar - 2 * L.wideGapY };
    case "medium":
      // ★V222 (E-1): パネルの場所に高さ 200 以上を残す（mediumPanelKeep をもう引く）
      return { w: w - 2 * L.mediumSide, h: h - L.mediumTopBand - L.mediumTopGap - L.mediumToolRow - 2 * L.mediumToolGap - L.mediumBottomBar - L.mediumPanelKeep };
    case "narrow":
      return { w: w - 2 * L.narrowSide, h: Infinity };
    default:
      return null;
  }
}

/** 縁を含めた箱の大きさ */
export function boxSize(scale: number, rotated = false): { w: number; h: number } {
  const a = PIC_W * scale + 2 * PIC_BORDER;
  const b = PIC_H * scale + 2 * PIC_BORDER;
  return rotated ? { w: b, h: a } : { w: a, h: b };
}

/** ★開いたときの倍率（fit）: 置ける場所に縁ごと入る、一番大きい n ÷ dpr。低は null。
 *  ★V222 (E-1): 縦（中）は ×1 より下げない（×1 でもパネルの場所が 200 に足りなければ、200 より低いまま ×1） */
export function fitScale(cat: Category, w: number, h: number, dpr: number): number | null {
  const area = placeArea(cat, w, h);
  if (!area) return null;
  let n = cat === "medium" ? mediumFloorN(dpr) : 1;
  while (n < ZOOM_MAX * dpr) {
    const b = boxSize((n + 1) / dpr);
    if (b.w > area.w || b.h > area.h) break;
    n++;
  }
  return n / dpr;
}

/** 見える範囲（UI §4-1）。広と中だけ（狭は M-3） */
export function visibleArea(cat: Category, w: number, h: number, dpr: number, toolsHidden: boolean): Rect | null {
  const L = LAYOUT;
  if (cat === "wide") {
    const bottom = h - L.wideBottomBar;
    return toolsHidden ? { x: 0, y: 0, w, h: bottom } : { x: L.wideSide, y: 0, w: w - 2 * L.wideSide, h: bottom };
  }
  if (cat === "medium") {
    const top = L.mediumTopBand;
    if (toolsHidden) return { x: 0, y: top, w, h: h - L.mediumBottomBar - L.mediumVisibleAboveBar - top };
    const fit = fitScale(cat, w, h, dpr)!;
    const toolRowTop = L.mediumTopBand + L.mediumTopGap + boxSize(fit).h + L.mediumToolGap;
    return { x: 0, y: top, w, h: toolRowTop - L.mediumVisibleAboveTools - top };
  }
  return null;
}

export interface View {
  scale: number;
  /** 絵の中身の左上（画面の座標） */
  x: number;
  y: number;
  /** 0・90・180・270（指が触れている間は途中の角度） */
  rotationDeg: number;
}

/** 物理画素に丸める（範囲 [lo, hi] の中へ・範囲が 1 物理画素より狭ければ近いほう） */
export function alignToDevice(v: number, dpr: number, lo = -Infinity, hi = Infinity): number {
  const r = Math.round(v * dpr) / dpr;
  const loA = Math.ceil(lo * dpr - 1e-9) / dpr;
  const hiA = Math.floor(hi * dpr + 1e-9) / dpr;
  if (loA > hiA) return r;
  return Math.min(hiA, Math.max(loA, r));
}

/** ★開いたときの倍率と位置（広: 余りを上下左右に均等／中: 上 76 に寄せ・左右は真ん中）。狭と低は null（M-3） */
export function openView(cat: Category, w: number, h: number, dpr: number): View | null {
  const L = LAYOUT;
  const fit = fitScale(cat, w, h, dpr);
  if (fit === null || (cat !== "wide" && cat !== "medium")) return null;
  const b = boxSize(fit);
  let bx: number;
  let by: number;
  if (cat === "wide") {
    const area = placeArea(cat, w, h)!;
    bx = L.wideSide + (area.w - b.w) / 2;
    by = L.wideGapY + (area.h - b.h) / 2;
  } else {
    bx = L.mediumSide + (w - 2 * L.mediumSide - b.w) / 2;
    by = L.mediumTopBand + L.mediumTopGap;
  }
  return { scale: fit, x: alignToDevice(bx + PIC_BORDER, dpr), y: alignToDevice(by + PIC_BORDER, dpr), rotationDeg: 0 };
}

/** 指が触れている間の倍率（fit の 0.6 倍〜×34） */
export function liveScale(raw: number, fit: number): number {
  return Math.min(ZOOM_LIVE_MAX, Math.max(fit * ZOOM_LIVE_MIN_RATIO, raw));
}

/** 回転は 0°・90°・180°・270° の一番近いものに吸い付く */
export function snapRotation(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return (Math.round(d / 90) * 90) % 360;
}

/** 寄る倍率（一番近いドットの揃う倍率＝n ÷ dpr・×32 まで）。fit より小さければ null（fit に戻す） */
export function snapScale(raw: number, fit: number, dpr: number): number | null {
  if (raw < fit) return null;
  const s = Math.round(raw * dpr) / dpr;
  return Math.min(ZOOM_MAX, Math.max(fit, s));
}

/** 端の決まりの範囲（箱の左上の x の許される範囲・1 つの軸） */
function edgeRange(boxLen: number, vStart: number, vLen: number): [number, number] {
  if (boxLen <= vLen - 2 * EDGE_INSIDE) return [vStart + EDGE_INSIDE, vStart + vLen - EDGE_INSIDE - boxLen];
  return [vStart + vLen - EDGE_REACH - boxLen, vStart + EDGE_REACH];
}

export interface SettleCtx {
  cat: Category;
  w: number;
  h: number;
  dpr: number;
  toolsHidden: boolean;
}

/**
 * ★ピンチ・ひねりの指を離した（UI §4-1・U-30）。`live` は触れている間の見た目（途中の倍率・角度）、`center` は指を離した所。
 *  - 倍率: fit より小さくして離すと fit と開いたときの位置に戻る。そうでなければ一番近いドットの揃う倍率（×32 まで）へ、離した所を中心に寄る
 *  - 回転: 一番近い 0°・90°・180°・270° に吸い付く
 *  - 端: 見える範囲より小さい絵は縁から 4 の内に収め、大きい絵は端が内側へ 40 までしか入らない（90°・270° は縦と横を入れ替えた大きさで見る）
 *  - 位置は最後に物理画素へ丸める（端の範囲の中へ）
 * 広と中だけ（狭と低は M-3）。
 */
export function settle(live: View, center: { x: number; y: number }, ctx: SettleCtx): View {
  const fit = fitScale(ctx.cat, ctx.w, ctx.h, ctx.dpr);
  const open = openView(ctx.cat, ctx.w, ctx.h, ctx.dpr);
  const vis = visibleArea(ctx.cat, ctx.w, ctx.h, ctx.dpr, ctx.toolsHidden);
  if (fit === null || !open || !vis) return live;
  const rot = snapRotation(live.rotationDeg);
  const s = snapScale(live.scale, fit, ctx.dpr);
  // ★V220（独立レビューの指摘）: fit と開いたときの位置へ戻すときも、90°・270° なら縦と横を入れ替えた大きさで端の決まりを通す
  if (s === null) return rot === 0 || rot === 180 ? { ...open, rotationDeg: rot } : clampToEdges({ ...open, rotationDeg: rot }, vis, ctx.dpr);
  // 離した所を中心に寄る（中心の下の絵の点が動かない）
  const k = s / live.scale;
  const x = center.x - (center.x - live.x) * k;
  const y = center.y - (center.y - live.y) * k;
  return clampToEdges({ scale: s, x, y, rotationDeg: rot }, vis, ctx.dpr);
}

/** 端の決まりと物理画素への丸め（寄ったあと・次に指で動かしたあと） */
export function clampToEdges(v: View, vis: Rect, dpr: number): View {
  const rotated = v.rotationDeg === 90 || v.rotationDeg === 270;
  const b = boxSize(v.scale, rotated);
  const [bxLo, bxHi] = edgeRange(b.w, vis.x, vis.w);
  const [byLo, byHi] = edgeRange(b.h, vis.y, vis.h);
  const bx = Math.min(bxHi, Math.max(bxLo, v.x - PIC_BORDER));
  const by = Math.min(byHi, Math.max(byLo, v.y - PIC_BORDER));
  return {
    ...v,
    x: alignToDevice(bx + PIC_BORDER, dpr, bxLo + PIC_BORDER, bxHi + PIC_BORDER),
    y: alignToDevice(by + PIC_BORDER, dpr, byLo + PIC_BORDER, byHi + PIC_BORDER),
  };
}

/** ★V222 (E-1): 縦（中）の倍率の下限＝×1（n ÷ dpr が 1 以上になる一番小さい n） */
function mediumFloorN(dpr: number): number {
  return Math.max(1, Math.ceil(dpr - 1e-9));
}

/** 区分が切り替わる前と後の画面（倍率と位置を持ち越すときの入力） */
export interface ViewCtx {
  cat: Category;
  w: number;
  h: number;
  dpr: number;
}

/**
 * ★V222 (E-3・UI §4-3): 区分が切り替わったとき・大きさが変わったときに、倍率と位置を持ち越す（画面を持たない）。
 *  - 前の倍率が前の区分（と大きさ）の fit なら、新しい区分の開いたときの倍率と位置
 *  - fit より大きければ倍率はそのまま（新しい fit より小さければ新しい fit と開いたときの位置）にして、前の見える範囲の真ん中にあった
 *    絵の点を、新しい見える範囲の真ん中に置き、端の決まりを当てる
 *  - 回転（0°・90°・180°・270°）はそのまま（左右反転は画面の側が持つので触らない）。開いたときの位置へ置くときも、90°・270° なら端の決まりを通す
 *  - 区分が変わらない大きさの変化も、同じ関数を通す
 * 広と中だけ（狭と低は null＝画面の側は案内を出していて、倍率と位置を動かさない）。
 */
export function carryView(prev: ViewCtx, next: ViewCtx, v: View, toolsHidden: boolean): View | null {
  const nOpen = openView(next.cat, next.w, next.h, next.dpr);
  const nFit = fitScale(next.cat, next.w, next.h, next.dpr);
  const nVis = visibleArea(next.cat, next.w, next.h, next.dpr, toolsHidden);
  if (!nOpen || nFit === null || !nVis) return null;
  const rot = snapRotation(v.rotationDeg);
  const pFit = fitScale(prev.cat, prev.w, prev.h, prev.dpr);
  const pVis = visibleArea(prev.cat, prev.w, prev.h, prev.dpr, toolsHidden);
  const toOpen = (): View => {
    const o = { ...nOpen, rotationDeg: rot };
    return rot === 0 || rot === 180 ? o : clampToEdges(o, nVis, next.dpr);
  };
  if (pFit === null || !pVis || v.scale <= pFit || v.scale < nFit) return toOpen();
  // 絵の箱の大きさは同じ（倍率と回転が同じ）なので、見える範囲の真ん中が動いた分だけ動かすと、真ん中の下の絵の点が付いてくる
  const dx = nVis.x + nVis.w / 2 - (pVis.x + pVis.w / 2);
  const dy = nVis.y + nVis.h / 2 - (pVis.y + pVis.h / 2);
  return clampToEdges({ scale: v.scale, x: v.x + dx, y: v.y + dy, rotationDeg: rot }, nVis, next.dpr);
}

/** ツールを隠す・表示する（UI §4-1）: 倍率と位置は変えない（見える範囲だけが変わる・端の決まりは次に動かしたときから） */
export function toggleTools(v: View): View {
  return { ...v };
}
