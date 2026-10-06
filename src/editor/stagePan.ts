// V195 (A-98・Discord REQ-006): 拡大したとき、絵のどの点でも（四隅を含めて）窓の真ん中まで動かせるようにする。
//
// ★決まり（REQ_discord_tickets_1004 §3）
//   **全体表示（zoomMode === "fit"）でないときは、絵のどの点でも窓の真ん中まで動かせる。それより外へは動かない。**
//   今までは `#ed-scroll`（overflow:auto・padding:10px）の中で絵の端が窓の端の 10px 内側で止まっていた。
//
// ★仕組み（DOM の形は editor.ts の applyZoom・CSS は styles.css の `.stage-scroll.pan`）
//   - 絵の周りに**窓の幅・高さの半分ずつ**の余白を取る。余白の大きさを決めるのは、`#ed-scroll` の中の
//     **変形しない箱**（`#ed-cvpan`）の幅・高さだけ＝スクロールの範囲は「箱の大きさ − 窓の大きさ」でぴったり決まる。
//     ★`#ed-cvwrap` は表示の回転（transform）を持つので、これをスクロールの中身にすると回転したときの
//     はみ出し（左・上へはスクロールできない）で範囲が崩れる。だから絵の箱は absolute で箱の真ん中に置くだけにする
//   - 箱の幅 = 見た目の絵の幅 + 左右に floor(窓/2) ずつ。スクロール 0 のとき窓の真ん中＝絵の左端、
//     いちばん右へスクロールしたとき窓の真ん中＝絵の右端。窓の幅が奇数のときは真ん中が x.5 になるので、
//     両端とも**絵の内側 0.5px** で止まる（外へは 1 画素も出ない・絵は整数の位置に置く＝ドットがにじまない）。高さも同じ
//   - 回転 90°・270° は見た目の幅と高さが入れ替わる。絵の箱（回転前の大きさ）の真ん中を箱の真ん中に合わせるので、
//     回転の中心（transform-origin の既定＝真ん中）が箱の真ん中に来て、回転した見た目がちょうど余白の内側に収まる
//
// ★倍率を変えたときの基準点（REQ §3「見ていた場所が今より大きく飛ばない」・指示書 V195 §3 ★）
//   **窓の真ん中に見えていた絵の点が、倍率を変えたあとも真ん中に残る。**表示の回転・反転・窓の大きさの変化も同じ。
//   点は「絵の座標（0..320 × 0..240・小数）」で持つ＝回転・反転・倍率に依らない。DOM の矩形を読まず、
//   最後に置いた形（`PanGeom`）とスクロール位置だけから計算するので、大画面（swapped）を挟んでも狂わない。
//
// ★写像は editor.ts の `clientToPixelF`（逆写像）と同じ式。描く座標は今までどおり #ed-canvas の矩形から取る
//   （余白は #ed-canvas の外なので、描く・カーソル・格子・四隅変形・範囲選択・テキストは 1 つも変えない）。

import { W, H } from "./model";

/** パン（全体表示でないとき）の形。applyZoom が置いた値をそのまま持つ。 */
export interface PanGeom {
  /** 窓の中身（スクロールの中身）での、見た目の絵の左上（px） */
  L: number;
  T: number;
  /** 見た目の絵の幅・高さ（回転 90°/270° は入れ替わる） */
  vw: number;
  vh: number;
  /** 置いたときの窓の幅・高さ（スクロールバーを除いた clientWidth / clientHeight） */
  viewW: number;
  viewH: number;
  rot: number;
  flip: boolean;
}

export interface PanLayout {
  geom: PanGeom;
  /** 変形しない箱（#ed-cvpan）の幅・高さ＝スクロールの中身の大きさ */
  sizerW: number;
  sizerH: number;
  /** 絵の箱（#ed-cvwrap・枠線を含む・回転前）の左上 */
  wrapLeft: number;
  wrapTop: number;
}

/** 表示の回転は 0/90/180/270 のどれか（それ以外は 0 として扱う） */
export function isRotated(rot: number): boolean {
  return rot === 90 || rot === 270;
}

/** 全体表示（`zoomMode === "fit"`）で選ばれる倍率。`availW/H` は applyZoom の物差し（`#ed-stage` の
 *  clientWidth/Height − 40）。見た目の絵（回転のあと）が収まるいちばん大きい整数倍・1 未満にはしない。
 *  ★applyZoom の全体表示と、下の `panNeeded` の両方がこの 1 つを使う（物差しを書き分けない） */
export function fitZoom(availW: number, availH: number, rot: number): number {
  const r = isRotated(rot);
  const cw = r ? H : W;
  const ch = r ? W : H;
  return Math.max(1, Math.floor(Math.min(availW / cw, availH / ch)));
}

/** ★V195b（作者決定 2026-10-04「収まる大きさは元の形」）: 数字の倍率 `z` で**余白を付けて動かす形にするか**。
 *  見た目の絵（回転のあと）が窓（`availW/H`＝全体表示と同じ物差し）から幅か高さではみ出すとき＝
 *  **全体表示で選ばれる倍率より大きいとき**だけ。それ以下（収まる）は全体表示と同じ今までの形。
 *  全体表示の倍率と同じ数字なら必ず同じ形になる（窓が小さすぎて 1 倍でもはみ出すときは、全体表示も 1 倍を
 *  今までの形で出すので、数字の 1 倍も今までの形） */
export function panNeeded(z: number, availW: number, availH: number, rot: number): boolean {
  return z > fitZoom(availW, availH, rot);
}

/** 窓の大きさ・倍率・回転からパンの形を決める。`border` は #ed-cvwrap の枠線の太さ（px）。 */
export function panLayout(
  viewW: number,
  viewH: number,
  z: number,
  rot: number,
  flip: boolean,
  border: number
): PanLayout {
  const vW = Math.max(0, Math.floor(viewW));
  const vH = Math.max(0, Math.floor(viewH));
  const cw = W * z; // 絵の箱の中身（回転前）
  const ch = H * z;
  const r = isRotated(rot);
  const vw = r ? ch : cw; // 見た目
  const vh = r ? cw : ch;
  const L = Math.floor(vW / 2);
  const T = Math.floor(vH / 2);
  const sizerW = vw + 2 * L;
  const sizerH = vh + 2 * T;
  // 絵の箱の真ん中＝見た目の絵の真ん中（回転の中心）。回転前の箱の左上はそこから半分ずつ戻した所
  const wrapLeft = L + vw / 2 - cw / 2 - border;
  const wrapTop = T + vh / 2 - ch / 2 - border;
  return { geom: { L, T, vw, vh, viewW: vW, viewH: vH, rot, flip }, sizerW, sizerH, wrapLeft, wrapTop };
}

/** 絵の座標（0..W × 0..H・小数）→ 見た目の絵の中の割合（0..1）。editor.ts `pixelToClient` と同じ順（反転→回転）。 */
export function canvasToVisual(x: number, y: number, rot: number, flip: boolean): { nx: number; ny: number } {
  let u = x / W;
  const v = y / H;
  if (flip) u = 1 - u;
  switch (rot) {
    case 90:
      return { nx: 1 - v, ny: u };
    case 180:
      return { nx: 1 - u, ny: 1 - v };
    case 270:
      return { nx: v, ny: 1 - u };
    default:
      return { nx: u, ny: v };
  }
}

/** 見た目の絵の中の割合 → 絵の座標。editor.ts `clientToPixelF` と同じ式（回転を戻してから反転を戻す）。 */
export function visualToCanvas(nx: number, ny: number, rot: number, flip: boolean): { x: number; y: number } {
  let u: number;
  let v: number;
  switch (rot) {
    case 90:
      u = ny;
      v = 1 - nx;
      break;
    case 180:
      u = 1 - nx;
      v = 1 - ny;
      break;
    case 270:
      u = 1 - ny;
      v = nx;
      break;
    default:
      u = nx;
      v = ny;
  }
  if (flip) u = 1 - u;
  return { x: u * W, y: v * H };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** いま窓の真ん中に見えている絵の点（絵の座標）。置いたときの形 `g` と、いまのスクロール位置から求める。 */
export function anchorAt(g: PanGeom, scrollLeft: number, scrollTop: number): { x: number; y: number } {
  const nx = g.vw > 0 ? clamp((scrollLeft + g.viewW / 2 - g.L) / g.vw, 0, 1) : 0.5;
  const ny = g.vh > 0 ? clamp((scrollTop + g.viewH / 2 - g.T) / g.vh, 0, 1) : 0.5;
  const p = visualToCanvas(nx, ny, g.rot, g.flip);
  return { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) };
}

/** スクロールできる最大（箱 − 窓）。窓の幅が奇数なら見た目の絵の幅より 1 小さい */
export function maxScroll(g: PanGeom): { left: number; top: number } {
  return { left: Math.max(0, g.vw + 2 * g.L - g.viewW), top: Math.max(0, g.vh + 2 * g.T - g.viewH) };
}

/** 絵の点 `a` を窓の真ん中に置くスクロール位置（スクロールできる範囲に収める・整数）。 */
export function scrollFor(g: PanGeom, a: { x: number; y: number }): { left: number; top: number } {
  const { nx, ny } = canvasToVisual(clamp(a.x, 0, W), clamp(a.y, 0, H), g.rot, g.flip);
  const m = maxScroll(g);
  const left = clamp(Math.round(g.L + nx * g.vw - g.viewW / 2), 0, m.left);
  const top = clamp(Math.round(g.T + ny * g.vh - g.viewH / 2), 0, m.top);
  return { left, top };
}
