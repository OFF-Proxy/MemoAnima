// V223 (M-2b-3b-1・UI §5-7・U-28・指示書 ■3 の F-4〜F-6・■4): 広げたタイムラインの**決まり**（画面を持たない・DOM を読まない・v223 [I][R] が見る）。
//
// ★置き場: 横は左 88・右 88・下 84、縦はパネルの場所（左 16・右 16・下 84）。下端を揃え、高さは頭の段の数で決まる。
// ★開け閉め: 外を押しても・保存と戻るの前にも・ツールを持ち替えても・確認の島でも閉じない。閉じるのは ⌃⌄ とツールを隠したとき（覚えて戻す）。
//  横は、島とほかの 1 つ（パネル・帯・その他・コマの帯）が一緒に開いていてよい。縦は、島とパネルが同じ場所なのでどちらか 1 つ
//  （島を開くとパネルを閉じて覚え、島を閉じると戻す。島が開いているときにパネルを開くと島は閉じる＝覚えない）。
// ★範囲: ［範囲］をオンにしたときのコマが起点。オンの間にコマを押すと起点からそのコマまで。オフで解ける。島を閉じるとオフになるが範囲は残る。
import type { OpenState, PanelId, Shape } from "./arrange";
import { carryOpen } from "./arrange";

/** 島の寸法（ボード t01_timeline.png と ■4） */
export const ISLAND = {
  sideWide: 88,
  sideMedium: 16,
  bottom: 84,
  /** 余白 12 と縁 3 */
  pad: 15,
  headRow: 40,
  headGap: 8,
  headFilmGap: 10,
  /** フィルム（穴 6×2・コマ 48・上下の余白） */
  film: 92,
  /** 横のパネルの下端・帯の下の限り・縦の帯の…は、島の上からこれだけ離す */
  clear: 12,
  /** 倍率の札は島の上これだけ */
  badgeClear: 16,
} as const;

/** 島の高さ（頭の段の数から。1 段 172＝ボード・2 段 220・3 段 268） */
export function islandHeight(rows: number): number {
  const r = Math.max(1, rows);
  return ISLAND.pad + ISLAND.headRow * r + ISLAND.headGap * (r - 1) + ISLAND.headFilmGap + ISLAND.film + ISLAND.pad;
}

/** 島の位置と大きさ */
export function islandRect(shape: Shape, w: number, h: number, rows: number): { left: number; top: number; width: number; height: number } {
  const side = shape === "wide" ? ISLAND.sideWide : ISLAND.sideMedium;
  const height = islandHeight(rows);
  return { left: side, top: h - ISLAND.bottom - height, width: w - side * 2, height };
}

/** 横で、パネルの下端と帯の下の限り（画面の上からの y）。島が開いていれば島の上 12、閉じていれば下の帯の上（下 84） */
export function wideLowerLimit(h: number, islandOpen: boolean, rows: number): number {
  return islandOpen ? h - ISLAND.bottom - islandHeight(rows) - ISLAND.clear : h - ISLAND.bottom;
}

/** 開いているもの（V222 の OpenState）に、島と、縦で島の後ろに覚えたパネルを足したもの */
export interface IslandOpen extends OpenState {
  island: boolean;
  /** 縦で島を開いたときに閉じて覚えたパネル（島を閉じると戻る） */
  islandMemo: PanelId | null;
}

/** ⌃ を押した: 島を開く。縦は開いていたパネルを閉じて覚える */
export function openIsland(shape: Shape, s: IslandOpen): IslandOpen {
  const out: IslandOpen = { ...s, island: true };
  if (shape === "medium" && s.panel) {
    out.islandMemo = s.panel;
    out.panel = null;
  }
  return out;
}

/** ⌄ を押した: 島を閉じる。縦は覚えていたパネルを開く */
export function closeIsland(shape: Shape, s: IslandOpen): IslandOpen {
  const out: IslandOpen = { ...s, island: false, islandMemo: null };
  if (shape === "medium" && s.islandMemo && !s.panel) out.panel = s.islandMemo;
  return out;
}

/** パネルを開く: 縦で島が開いていれば島は閉じる（覚えない）。横は島はそのまま */
export function openPanelOver(shape: Shape, s: IslandOpen, p: PanelId): IslandOpen {
  if (shape === "medium") return { ...s, panel: p, island: false, islandMemo: null };
  return { ...s, panel: p };
}

/** ★閉じないもの: 外を押した・保存と戻るの前（mbCloseAll）・ツールの持ち替え・確認の島。どれも島と、縦で覚えたパネルを変えない。
 *  渡すのは、そのときに V222 の決まりで閉じたあとの状態（panel・strip・more・frameBar） */
export function keepIsland(before: IslandOpen, after: OpenState): IslandOpen {
  return { ...after, island: before.island, islandMemo: before.islandMemo };
}

/** ツールを隠す: 島も閉じて覚える（表示に戻すと開く＝パネルと同じ） */
export interface HiddenMemo {
  island: boolean;
  islandMemo: PanelId | null;
}
export function hideTools(s: IslandOpen): { next: IslandOpen; memo: HiddenMemo } {
  return { next: { ...s, panel: null, strip: null, more: false, frameBar: false, island: false, islandMemo: null }, memo: { island: s.island, islandMemo: s.islandMemo } };
}
export function showTools(s: IslandOpen, memo: HiddenMemo): IslandOpen {
  return { ...s, island: memo.island, islandMemo: memo.island ? memo.islandMemo : null };
}

/**
 * ★区分（置き方）が切り替わったとき（V222 の E-3 の carryOpen に島を足す）。島が開いていれば、開いたまま新しい区分の形にする。
 *  - 横 → 縦で、島とパネルが両方開いていた: 島を残してパネルを覚える（縦で島を閉じると戻る）
 *  - 横 → 縦で、島と帯が開き、E-3 でパネルを覚えていた: 島を残し、パネルは覚えたまま（開かない。縦で島を閉じると開く）
 *  - 縦 → 横で、島の後ろにパネルを覚えていた: 横では両方開いてよいのでパネルを開く（帯も開いていたら E-3 のとおり帯を残してパネルを覚える）
 *  島が閉じていれば V222 の carryOpen と同じ
 */
export function carryOpenIsland(prev: Shape, next: Shape, s: IslandOpen): IslandOpen {
  if (prev === next) return { ...s };
  if (!s.island) return { ...carryOpen(prev, next, s), island: false, islandMemo: null };
  const out: IslandOpen = { ...s, more: false, frameBar: false };
  if (next === "medium") {
    // 縦では島とパネルはどちらか 1 つ: 開いていたパネル（無ければ E-3 で覚えていたパネル）を、島の後ろに覚える
    out.islandMemo = s.panel ?? s.panelMemo;
    out.panel = null;
    out.panelMemo = null;
  } else {
    const p = s.islandMemo;
    out.islandMemo = null;
    if (p) {
      if (s.strip) out.panelMemo = p;
      else out.panel = p;
    }
  }
  return out;
}

// ---------------- 範囲（F-6） ----------------

/** コアの口（画面の側が、受け継いだ口をそのまま渡す） */
export interface RangeOps {
  frameIndex(): number;
  range(): { a: number; b: number } | null;
  anchor(): number | null;
  setAnchor(i: number | null): void;
  clearRange(): void;
  /** コアの clickFrame（shift＝起点からの範囲） */
  clickFrame(i: number, shift: boolean): void;
  gotoFrame(i: number): void;
}

/** ［範囲］の札 */
export class RangeMode {
  on = false;

  /** ［範囲］を押した。オン＝いまのコマを起点にして範囲を空に。オフ＝範囲を解く */
  toggle(ops: RangeOps): void {
    this.on = !this.on;
    ops.clearRange();
    if (this.on) ops.setAnchor(ops.frameIndex());
  }

  /** 島を閉じた: ［範囲］はオフになるが、選んだ範囲は残す（ふつうにコマを押すと解ける＝コアの clickFrame(i, false)） */
  islandClosed(): void {
    this.on = false;
  }

  /** コマを押した（島のフィルムでも下の帯でも）: オンなら起点からそのコマまで・オフならふつうに移る（範囲は解ける） */
  tapFrame(ops: RangeOps, i: number): void {
    ops.clickFrame(i, this.on);
  }

  /** コマを長押しした（帯を出す前）: 範囲の中なら範囲を残したままそのコマへ移る。外なら V221 のまま（ほかのコマならふつうに押したのと同じ）。
   *  ［範囲］がオンでも、長押しで範囲を広げない */
  holdFrame(ops: RangeOps, i: number): void {
    const r = ops.range();
    if (r && i >= Math.min(r.a, r.b) && i <= Math.max(r.a, r.b)) {
      if (i !== ops.frameIndex()) ops.gotoFrame(i);
      return;
    }
    // 範囲の外: ほかのコマならふつうに押したのと同じ。いまのコマでも、範囲が残っていれば解く（帯の［コピー］が見えていない範囲を写さない）
    if (i !== ops.frameIndex() || r) ops.clickFrame(i, false);
  }

  /** コアが範囲を解いたあと（並べ替え・足す・消す・はりつけ・ゆらゆらと、その取り消し・やり直し）: オンなら、いまのコマを新しい起点にする */
  coreChanged(ops: RangeOps): void {
    if (this.on && ops.anchor() === null) ops.setAnchor(ops.frameIndex());
  }
}

/** そのコマが範囲の中か（青の縁） */
export function inRange(r: { a: number; b: number } | null, i: number): boolean {
  return !!r && i >= Math.min(r.a, r.b) && i <= Math.max(r.a, r.b);
}
