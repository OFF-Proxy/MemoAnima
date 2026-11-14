// V222 (M-2b-3a・要件 docs/REQ_mobile_m2_editor.md §5-3・決-20・UI docs/REQ_mobile_ui_v1.md §4-3・§5-11・指示書 ■3 の E-2〜E-5):
// 縦（中）と横（広）の**置き方の決まり**（画面を持たない・DOM を読まない・v222 [C][G] が見る）。
//
// ★中の配置が入らない幅（E-2）: ツールの段（773）が左右 16 の内に入らない幅（805 未満）では「表示」をその他へ移す（712）。
//  712 でも入らない幅（744 未満）は、中の部品が入らないので決-20 の案内（M-3 まで）。案内は「狭・低・744 未満の中」。
// ★区分が切り替わったときの開いていたもの（E-3）: パネルは新しい形で開いたまま。帯と一覧はその区分の形で開き直す（横の帯 ↔ 縦の一覧・帯）。
//  横は開くのが 1 つだけなので、縦でパネルと帯（一覧）の両方が開いていたら、横では帯を残してパネルを閉じて覚える（縦に戻ったら開く・
//  横でほかのパネルを開いたら忘れる＝画面の側）。その他のメニューとコマを長押しの帯は閉じる。
// ★キーボード（E-3）: 文字の欄にフォーカスがあって高さだけが変わったときは、区分と倍率を決め直さない（幅が変わったら決め直す）。
// ★倍率と位置の持ち越しは view/zoom.ts の carryView。
import type { Tool } from "../../editor/core/editorCore";
import { categoryOf, fitScale, boxSize, LAYOUT, type Category } from "../view/zoom";

export type PanelId = "color" | "layer" | "toolset" | "view";
/** 部品の置き方（案内を出している間は、案内に入る前の置き方のまま） */
export type Shape = "wide" | "medium";

/** 縦のツールの段の幅（ペン〜スポイトの 7・まとめたボタン・色〜表示の 4・区切り 2）と「表示」をその他へ移した幅・左右の余白 */
export const MEDIUM_TOOLROW_W = 773;
export const MEDIUM_TOOLROW_SHORT_W = 712;
export const MEDIUM_EDGE = 16;
/** 「表示」をツールの段に置ける一番狭い幅（805）・中の部品が入る一番狭い幅（744） */
export const MEDIUM_VIEW_MIN_W = MEDIUM_TOOLROW_W + 2 * MEDIUM_EDGE;
export const MEDIUM_MIN_W = MEDIUM_TOOLROW_SHORT_W + 2 * MEDIUM_EDGE;

/** まとめたボタンの 4 つ（UI §5-11）と、初めの「最後に使ったもの」 */
export const GROUP_TOOLS: readonly Tool[] = ["move", "select", "transform", "warp"];
export const GROUP_FIRST: Tool = "select";
export function isGroupTool(t: Tool): boolean {
  return GROUP_TOOLS.includes(t);
}

/**
 * ★V223 (F-9・UI §5-13): 横（広）の高さが足りないときの詰め方の段（今の CSS の寸法から計算・列どうしと下の帯が重ならない＝すき間 0 以上）。
 *  段 0＝今のまま（高さ 818 以上）／段 1＝右の列の札（ファイルの島・パネルの島）を 44 に（787 以上）／段 2＝左の列の札も 44・太さの札を 32 に（740 以上）／
 *  段 3＝段 2 に足して「表示」をその他のメニューへ（721 以上）／721 未満は入らない（null＝決-20 の案内）。
 *  端末（横）: Pro 11（834）・Air 11 と第 10 世代（820）・13 型＝段 0／第 9 世代（810）＝段 1／mini（744）＝段 2
 */
export const WIDE_TIER_MIN_H: readonly [number, number, number, number] = [818, 787, 740, 721];
export type WideTier = 0 | 1 | 2 | 3;
export function wideTier(h: number): WideTier | null {
  if (h >= WIDE_TIER_MIN_H[0]) return 0;
  if (h >= WIDE_TIER_MIN_H[1]) return 1;
  if (h >= WIDE_TIER_MIN_H[2]) return 2;
  if (h >= WIDE_TIER_MIN_H[3]) return 3;
  return null;
}

/** ★決-20・E-2: 案内を出す大きさ（狭・低・幅 744 未満の中）。744 以上の中では出さない。
 *  ★V223 (F-9): 広でも、段 3 でも入らない高さ（721 未満）は案内（列の中を送る形はとらない） */
export function guideNeeded(w: number, h: number): boolean {
  const c: Category = categoryOf(w, h);
  if (c === "wide") return wideTier(h) === null;
  if (c === "medium") return w < MEDIUM_MIN_W;
  return true;
}

/** 置き方（案内が要る大きさでは null） */
export function shapeOf(w: number, h: number): Shape | null {
  if (guideNeeded(w, h)) return null;
  return categoryOf(w, h) === "wide" ? "wide" : "medium";
}

/** ★E-2: 縦で「表示」をその他のメニューへ移すか（幅 805 未満） */
export function viewInMore(shape: Shape, w: number): boolean {
  return shape === "medium" && w < MEDIUM_VIEW_MIN_W;
}

/** ★V223 (F-9): 「表示」をその他のメニューへ移すか（縦の幅 805 未満と、横の段 3） */
export function viewInMoreAt(shape: Shape, w: number, h: number): boolean {
  return viewInMore(shape, w) || (shape === "wide" && wideTier(h) === 3);
}

/**
 * ★V223 (F-10): 縦の文字の帯（ツールの段の上に出す帯）の置き場。浮かんでいる文字（文字の下書き）の画面の上の場所に重なるときは、
 *  帯を上へ寄せる（上端を上 80）。どちらに置いても重なるときは、重なる面積が小さい方（同じなら今の下の置き場）。
 *  low＝今の置き場（下端がツールの段の上 10）の帯の矩形・highTop＝上に寄せたときの上端・draft＝浮かんでいる文字の矩形（無ければ null）
 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export const TEXT_STRIP_HIGH_TOP = 80;
export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}
export function textStripPlace(low: Box, draft: Box | null, highTop = TEXT_STRIP_HIGH_TOP): "low" | "high" {
  if (!draft) return "low";
  const lowArea = overlapArea(low, draft);
  if (lowArea === 0) return "low";
  const height = low.bottom - low.top;
  const highArea = overlapArea({ left: low.left, right: low.right, top: highTop, bottom: highTop + height }, draft);
  return highArea < lowArea ? "high" : "low";
}

/** 縦の寸法（UI §5-11・■4）: ツールの段の上（絵の下 12）・パネルの上（ツールの段の下 12）・パネルの下（下の帯の上 12＝下 84） */
export interface MediumGeometry {
  toolRowTop: number;
  panelTop: number;
  panelBottom: number;
  /** 帯と一覧の下端（ツールの段の上 10）と、上端の限り（上の段の下＝上 72） */
  popBottom: number;
  popTopLimit: number;
}
export function mediumGeometry(w: number, h: number, dpr: number): MediumGeometry | null {
  const fit = fitScale("medium", w, h, dpr);
  if (fit === null) return null;
  const L = LAYOUT;
  const toolRowTop = L.mediumTopBand + L.mediumTopGap + boxSize(fit).h + L.mediumToolGap;
  return {
    toolRowTop,
    panelTop: toolRowTop + L.mediumToolRow + L.mediumToolGap,
    panelBottom: L.mediumBottomBar + L.mediumToolGap,
    popBottom: toolRowTop - 10,
    popTopLimit: L.mediumTopBand,
  };
}

/** 帯や一覧を、押した札の真ん中に合わせて左右 16 の内に置く（左端を返す） */
export function popLeft(anchorCenterX: number, popW: number, screenW: number): number {
  return Math.max(MEDIUM_EDGE, Math.min(screenW - MEDIUM_EDGE - popW, anchorCenterX - popW / 2));
}

/** 開いているもの（パネル・帯〔縦ではまとめたボタンの 4 つなら一覧〕・その他・コマを長押しの帯）と、横で閉じて覚えたパネル */
export interface OpenState {
  panel: PanelId | null;
  strip: Tool | null;
  more: boolean;
  frameBar: boolean;
  /** 縦でパネルと帯の両方が開いていて横に移ったときに閉じたパネル（縦に戻ったら開く） */
  panelMemo: PanelId | null;
}

/**
 * ★E-3: 区分（置き方）が切り替わったときの開いていたものの対応（同じ置き方なら何も変えない）。
 *  - 縦 → 横: パネルと帯の両方なら、帯を残してパネルを閉じて覚える。どちらか 1 つならそのまま
 *  - 横 → 縦: 覚えたパネルがあって今パネルが開いていなければ開く（覚えは消す）
 *  - その他のメニューとコマを長押しの帯は閉じる
 */
export function carryOpen(prev: Shape, next: Shape, s: OpenState): OpenState {
  if (prev === next) return { ...s };
  const out: OpenState = { ...s, more: false, frameBar: false };
  if (next === "wide") {
    if (s.panel && s.strip) {
      out.panelMemo = s.panel;
      out.panel = null;
    }
  } else if (s.panelMemo) {
    if (!s.panel) out.panel = s.panelMemo;
    out.panelMemo = null;
  }
  return out;
}

/** ★E-3: 文字の欄にフォーカスがあって高さだけが変わった（ソフトウェアキーボード）＝決め直さない */
export function keyboardOnly(prev: { w: number; h: number } | null, next: { w: number; h: number }, textFocused: boolean): boolean {
  return !!prev && textFocused && prev.w === next.w && prev.h !== next.h;
}

// =====================================================================================
// ★V225 (M-2b-3b-2・UI §5-15・指示書 ■3 の H): 利き手
// =====================================================================================

export type Hand = "right" | "left";

/** 左右を入れ替えるか（広だけ。縦〔中〕は段と帯が横並びで左右の差が無いので入れ替えない） */
export function handSwapped(shape: Shape, hand: Hand): boolean {
  return shape === "wide" && hand === "left";
}

/** 広の部品の矩形（CSS の寸法と同じ数。scripts/v225_smoke.ts [H] が CSS の字と突き合わせる） */
export interface PartBox extends Box {
  id: string;
  /** 利き手で左右を映す部品か（下の帯・広げたタイムラインの島は映さない＝コマは左から右へ流れる） */
  mirrored: boolean;
}
export const WIDE_PART = {
  edge: 12,
  col: 68,
  backLeft: 21,
  backTop: 17,
  backSize: 50,
  leftTop: 83,
  fileTop: 17,
  sizesTop: [211, 193, 193, 193],
  panelsBottom: 96,
  popEdge: 92,
  popW: 300,
  menuW: 270,
  bar: 72,
  /** 札の高さ（左の列・右の列）と太さの札の高さ（段 0〜3） */
  leftTool: [50, 50, 44, 44],
  rightTool: [50, 44, 44, 44],
  size: [38, 38, 32, 32],
  /** 島の縁（枠 3＋余白 6）×2・札の間・太さの間・区切り 9・太さの頭 */
  pad: 18,
  gap: 5,
  sizeGap: 3,
  sep: 9,
  sizeHead: 16,
} as const;

/** 広の、利き手が右のときの部品の矩形（閉じているもの〔パネル・帯・その他〕は開いたときの置き場） */
export function wideParts(w: number, h: number, tier: WideTier): PartBox[] {
  const P = WIDE_PART;
  const box = (id: string, left: number, top: number, bw: number, bh: number, mirrored = true): PartBox => ({ id, left, top, right: left + bw, bottom: top + bh, mirrored });
  const leftH = P.pad + 11 * P.leftTool[tier] + 11 * P.gap + P.sep;
  const fileH = P.pad + 3 * P.rightTool[tier] + 2 * P.gap;
  const sizesH = P.pad + P.sizeHead + 6 * P.size[tier] + 6 * P.sizeGap;
  const nPanels = tier === 3 ? 3 : 4;
  const panelsH = P.pad + nPanels * P.rightTool[tier] + (nPanels - 1) * P.gap;
  const rightX = w - P.edge - P.col;
  return [
    box("back", P.backLeft, P.backTop, P.backSize, P.backSize),
    box("left", P.edge, P.leftTop, P.col, leftH),
    box("file", rightX, P.fileTop, P.col, fileH),
    box("sizes", rightX, P.sizesTop[tier], P.col, sizesH),
    box("panels", rightX, h - P.panelsBottom - panelsH, P.col, panelsH),
    box("strip", P.popEdge, P.leftTop, P.popW, 200),
    box("panel", w - P.popEdge - P.popW, h - 84 - 300, P.popW, 300),
    box("menu", w - P.popEdge - P.menuW, P.fileTop, P.menuW, 300),
    box("bar", 0, h - P.bar, w, P.bar, false),
  ];
}

/** 画面の真ん中を軸に左右を映す */
export function mirrorBox<T extends Box>(b: T, w: number): T {
  return { ...b, left: w - b.right, right: w - b.left };
}

/** 利き手に合わせた広の部品の矩形（左なら、映す部品だけを映す） */
export function widePartsFor(w: number, h: number, tier: WideTier, hand: Hand): PartBox[] {
  const parts = wideParts(w, h, tier);
  return hand === "left" ? parts.map((p) => (p.mirrored ? mirrorBox(p, w) : p)) : parts;
}
