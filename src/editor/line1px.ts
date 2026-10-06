// V191 (A-89): 1px のペン・消しゴムの線。曲がる所・継ぎ目に 1 画素ずつ足される「L 字の角」を出さない。
//
// ★なぜ別のモジュールか: `raster.ts` は 1 バイトも変えない約束（v176 / v178 / v191 の [S-1] がハッシュで固定）。
//  2px 以上と直線・図形は今までどおり `strokeSegment` を通る＝1 画素も変わらない（REQ_1px_line §6-2・K-4・K-5）。
//  ここに来るのは「太さ 1 で打つ線分」だけ（`uses1px`）。
//
// ★作り（REQ_1px_line §6-1・「描く前に決める」）:
//  画素の並びは `strokeSegment` と**同じ式**（`Math.ceil(Math.hypot)` 回に分けて `Math.round`）で作り、
//  いちばん新しい画素を「仮」にして**まだ描かない**。次の画素 c が来たら、確定した直前の画素を a・仮を b として
//   - c が b と同じ → 何もしない
//   - c が a と 8 近傍で隣り合う（c が a そのものも含む）→ b は描かない（仮を c に置き換える）
//   - それ以外 → b を描いて確定（a ← b）・仮を c に
//  この 1 つの規則で、L 字の角（c が a の斜め隣）も、1 画素より小さい手ぶれの行ったり戻り（c が a そのもの・隣）も消える。
//  ⚠「L 字のときだけ」の規則にしない（とてもゆっくり描くと行ったり戻りが残る）。
//  ⚠ 描いた画素をあとから戻す形（Aseprite の形）にしない。同じなぞりの交差に穴が開く・消しゴムで元の色の控えが要る。
//   ここでは**描かないだけ**なので、`IndexBuf` へは今までどおり「打つ」書き込みしかしない（取り消しの形も変わらない）。
//
// ★引き換えに、描いている最中はペン先の 1 画素だけ遅れて出る。なぞりが終わる道は全部
//  `Editor.endLine1px`（描き終わりの漏斗）を通り、そこで `line1pxEnd` が仮の画素を描く。

import { stamp, type PenOptions } from "./raster";
import type { IndexBuf } from "./model";

/** ★この道に入る線分か。**太さ 1 だけ**（ペン・消しゴム・全レイヤー消しゴム）。ブラシは `penOptions` が
 *  `Math.max(size, 3)` にするので来ない。筆圧で 1 以外になった線分も来ない（今までの `strokeSegment` で描く） */
export function uses1px(o: PenOptions): boolean {
  return o.size === 1;
}

/** 1 本のなぞりの 1px の状態。座標は画素（整数）。 */
export interface Line1px {
  /** 確定した直前の画素（もう描いてある） */
  ax: number;
  ay: number;
  /** 仮の画素があるか（まだ描いていない） */
  hasB: boolean;
  bx: number;
  by: number;
  /** 仮の画素を作ったときの打ち方。確定・描き終わりはこれで打つ（途中で道具が替わっても、その画素を作った道具で打つ） */
  bo: PenOptions | null;
}

/** 確定した画素を 1 つ打つ受け口。`s` は直前の確定画素からの距離（1 か √2）＝点線の位相を進める量 */
export type Plot1px = (x: number, y: number, s: number, o: PenOptions) => void;

/** 状態を始める。(x, y) は**もう描いてある**画素（押した瞬間の打点／太い線分の終わり） */
export function line1pxBegin(x: number, y: number): Line1px {
  return { ax: x, ay: y, hasB: false, bx: x, by: y, bo: null };
}

/** 画素を 1 つ受け取って、規則どおりに「仮」を進める（描くのは確定した画素だけ） */
export function line1pxPush(st: Line1px, cx: number, cy: number, o: PenOptions, plot: Plot1px): void {
  if (!st.hasB) {
    if (cx === st.ax && cy === st.ay) return; // 同じ画素が続いた
    st.hasB = true;
    st.bx = cx;
    st.by = cy;
    st.bo = o;
    return;
  }
  if (cx === st.bx && cy === st.by) return; // 同じ画素が続いた
  if (Math.abs(cx - st.ax) <= 1 && Math.abs(cy - st.ay) <= 1) {
    // c が a と隣り合う（a そのものも含む）→ b は描かない。仮を c に置き換える
    st.bx = cx;
    st.by = cy;
    st.bo = o;
    return;
  }
  // b を描いて確定し、仮を c に
  plot(st.bx, st.by, Math.hypot(st.bx - st.ax, st.by - st.ay), st.bo ?? o);
  st.ax = st.bx;
  st.ay = st.by;
  st.bx = cx;
  st.by = cy;
  st.bo = o;
}

/** 線分を画素の並びにして流す。並びの作り方は `raster.ts` の `strokeSegment` と**同じ式**
 *  （steps = max(1, ceil(hypot(dx, dy)))・x = Math.round(x0 + dx * t)）。続けて同じ画素が来たら捨てる */
export function line1pxSegment(
  st: Line1px,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  o: PenOptions,
  plot: Plot1px
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    line1pxPush(st, Math.round(x0 + dx * t), Math.round(y0 + dy * t), o, plot);
  }
}

/** ★描き終わり: 仮の画素を描いて状態を空にする。仮が確定した直前の画素と同じなら描かない（同じ画素を 2 回打たない）。
 *  描いたら true */
export function line1pxEnd(st: Line1px, plot: Plot1px): boolean {
  if (!st.hasB) return false;
  st.hasB = false;
  const o = st.bo;
  st.bo = null;
  if (!o || (st.bx === st.ax && st.by === st.ay)) return false;
  plot(st.bx, st.by, Math.hypot(st.bx - st.ax, st.by - st.ay), o);
  st.ax = st.bx;
  st.ay = st.by;
  return true;
}

/** 確定した画素を 1 枚のバッファへ打つ。打つかどうかの判定（選択範囲・マイ柄・トーン・種類）は `stamp` のまま。
 *  ★点線は**確定した画素ごと**に位相を進める（進める量 `s` は直前の確定画素との距離）。周期は `strokeSegment` と同じ
 *  `max(6, size*3)`。位相は「その画素がなぞりの頭からどれだけ進んだ所か」＝押した瞬間の打点が 0（描く）。 */
export function plot1px(buf: IndexBuf, x: number, y: number, s: number, o: PenOptions): void {
  if (o.texture === "dot" && o.dashAcc) {
    const dashPeriod = Math.max(6, o.size * 3);
    o.dashAcc.d += s;
    if (o.dashAcc.d % dashPeriod >= dashPeriod / 2) return;
  }
  stamp(buf, x, y, o);
}
