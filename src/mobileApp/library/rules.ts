// V225 (M-2c・UI §6-1〜§6-8・指示書 ■3 の L): ライブラリの**決まり**（画面を持たない・DOM を読まない・scripts/v225_smoke.ts [L] が見る）。
//
// ★倍率と段の数（UI §6-7）: アルバムの列 220・棚は 250 以上（2 列）・再生はその残りに入る一番大きい「物理画素の整数倍」（n ÷ dpr）。
//  操作は 3 段に 206 以上の高さが取れれば 3 段、取れなければ 2 段（122）。間隔の詰め（上の帯 52・すき間 8・下 20）は、詰めると
//  たたんだ再生が 1 段上がる画面だけ（いまの端末では 1180×820）で、出す／たたむのどちらでも同じ間隔。
// ★全画面（UI §6-6）: 画面全体に入る一番大きい整数倍（上下左右 8）。操作の帯が絵の下に入らなければ、帯を絵に重ねる。
// ★縦（中）はモックが無い（UI §6-8 の方針: アルバムは「たたむ」の形だけ・再生は上に全幅・その下に操作・棚は下に 3〜4 列）。
// ★並び順と検索は、PC の src/library.ts の shelfItems の一時的な写し（§5-0。次の Windows の作業で共通へ）:
//    元: src/library.ts の shelfItems（746〜765）／写した所: このファイルの shelfItems／比べ方: v225 [L]（PC の関数の本文を取り出して、
//    同じ入力で同じ順）
import { categoryOf, PIC_W, PIC_H, PIC_BORDER, alignToDevice } from "../view/zoom";
import { guideNeeded } from "../editor/arrange";
import type { LibraryWork } from "../../mobile/port";
import { foldName } from "../../mobile/names";

export type ShelfSort = "manual" | "name" | "date";

/** 寸法（UI §6-1・11 型の実寸。CSS の変数へ渡す） */
export const LIB = {
  edge: 16,
  topBar: 60,
  topGap: 12,
  bottom: 22,
  /** 間隔の詰め（UI §6-7） */
  tightTopBar: 52,
  tightTopGap: 8,
  tightBottom: 20,
  albums: 220,
  albumsGap: 12,
  shelfGap: 16,
  shelfMin: 250,
  /** 操作の島: 3 段にできる高さ・2 段の高さ・再生との間（3 段のとき 12・2 段のとき 10） */
  ops3Min: 206,
  ops2: 122,
  opsGap3: 12,
  opsGap2: 10,
  /** 全画面: 四方の空き・操作の帯の高さ・絵との間・下の空き（ホームバー） */
  theaterEdge: 8,
  theaterBar: 56,
  theaterGap: 16,
  theaterBottom: 20,
  /** 縦（中）: 棚の列の一番狭い幅・操作の島の高さ（2 段） */
  mediumCardMin: 150,
  mediumOps: 122,
  mediumShelfMin: 160,
} as const;

/** 再生の箱（絵＋縁 4×2）の大きさ */
export function previewBox(scale: number): { w: number; h: number } {
  return { w: PIC_W * scale + PIC_BORDER * 2, h: PIC_H * scale + PIC_BORDER * 2 };
}

/** 箱が (maxW, maxH) に入る一番大きい「物理画素の整数倍」（n ÷ dpr）。1 ÷ dpr にも入らなければ null。
 *  ★V227 (Z-1・UI §6-7 の最後の★): 密度を丸めない（描く画面の fitScale と同じ考え）。密度 2 の iPad は今までどおり 0.5 刻み、
 *  密度 1.5 は 2/3 刻み・2.25 は 4/9 刻み・3 は 1/3 刻み＝どれも「倍率×密度」が整数（ドットが揃う） */
export function fitPreviewScale(maxW: number, maxH: number, dpr: number): number | null {
  const d = dpr > 0 ? dpr : 1;
  const n = Math.floor(Math.min((maxW - PIC_BORDER * 2) / PIC_W, (maxH - PIC_BORDER * 2) / PIC_H) * d + 1e-9);
  return n >= 1 ? n / d : null;
}

/** ★V227 (Z-2): 箱の位置を物理画素に揃える（CSS の整数に丸めてから、物理画素の格子へ）。整数の密度では今までと同じ値。
 *  絵は箱の左上から 4（縁 2＋内側の線 2）の所＝4 × 密度も整数なので、絵の左上も物理画素に乗る */
export function alignBox(v: number, dpr: number): number {
  return alignToDevice(Math.round(v), dpr > 0 ? dpr : 1);
}

export interface Spacing {
  tight: boolean;
  topBar: number;
  top: number;
  bottom: number;
}
function spacing(tight: boolean): Spacing {
  return tight ? { tight, topBar: LIB.tightTopBar, top: LIB.tightTopBar + LIB.tightTopGap, bottom: LIB.tightBottom } : { tight, topBar: LIB.topBar, top: LIB.topBar + LIB.topGap, bottom: LIB.bottom };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 横（広）のライブラリの置き方 */
export interface WideLayout {
  kind: "wide";
  folded: boolean;
  spacing: Spacing;
  scale: number;
  /** 操作の段の数（3＝出す形の並び・2＝たたんだ形の並び） */
  opsRows: 2 | 3;
  albums: Rect | null;
  preview: Rect;
  ops: Rect;
  shelf: Rect;
}

function wideWith(w: number, h: number, dpr: number, folded: boolean, sp: Spacing): Omit<WideLayout, "spacing"> | null {
  const areaH = h - sp.top - sp.bottom;
  const left = folded ? LIB.edge : LIB.edge + LIB.albums + LIB.albumsGap;
  const maxW = w - left - LIB.shelfGap - LIB.shelfMin - LIB.edge;
  // 高さ: 2 段の操作（122）と間（10）が入ること
  const scale = fitPreviewScale(maxW, areaH - LIB.opsGap2 - LIB.ops2, dpr);
  if (scale === null) return null;
  const box = previewBox(scale);
  const rest3 = areaH - box.h - LIB.opsGap3;
  const opsRows: 2 | 3 = rest3 >= LIB.ops3Min ? 3 : 2;
  const gap = opsRows === 3 ? LIB.opsGap3 : LIB.opsGap2;
  const shelfX = left + box.w + LIB.shelfGap;
  return {
    kind: "wide",
    folded,
    scale,
    opsRows,
    albums: folded ? null : { x: LIB.edge, y: sp.top, w: LIB.albums, h: areaH },
    preview: { x: alignBox(left, dpr), y: alignBox(sp.top, dpr), w: box.w, h: box.h },
    ops: { x: left, y: sp.top + box.h + gap, w: box.w, h: areaH - box.h - gap },
    shelf: { x: shelfX, y: sp.top, w: w - shelfX - LIB.edge, h: areaH },
  };
}

/** ★間隔を詰めるか（画面の大きさで決める＝出す／たたむで変えない）: 詰めると、たたんだ再生が 1 段上がる画面だけ */
export function tightSpacing(w: number, h: number, dpr: number): boolean {
  const a = wideWith(w, h, dpr, true, spacing(false));
  const b = wideWith(w, h, dpr, true, spacing(true));
  return !!b && (!a || b.scale > a.scale);
}

export function wideLayout(w: number, h: number, dpr: number, folded: boolean): WideLayout | null {
  const sp = spacing(tightSpacing(w, h, dpr));
  const l = wideWith(w, h, dpr, folded, sp);
  return l ? { ...l, spacing: sp } : null;
}

/** 縦（中）のライブラリの置き方（モックなし・UI §6-8 の方針） */
export interface MediumLayout {
  kind: "medium";
  folded: true;
  spacing: Spacing;
  scale: number;
  opsRows: 2;
  albums: null;
  preview: Rect;
  ops: Rect;
  shelf: Rect;
  /** 棚の列の数（3〜4。幅が足りなければ 2） */
  columns: number;
}

export function mediumLayout(w: number, h: number, dpr: number): MediumLayout | null {
  const sp = spacing(false);
  const areaH = h - sp.top - sp.bottom;
  // 再生は上に全幅（左右は描く画面の縦と同じ 6 まで寄せてよい＝11 型で ×2.5）。棚に 160 以上を残す
  const scale = fitPreviewScale(w - 12, areaH - LIB.opsGap2 - LIB.mediumOps - LIB.topGap - LIB.mediumShelfMin, dpr);
  if (scale === null) return null;
  const box = previewBox(scale);
  const x = alignBox((w - box.w) / 2, dpr);
  const opsY = sp.top + box.h + LIB.opsGap2;
  const shelfY = opsY + LIB.mediumOps + LIB.topGap;
  const shelfW = w - LIB.edge * 2;
  const columns = Math.max(2, Math.min(4, Math.floor((shelfW - 28) / LIB.mediumCardMin)));
  return {
    kind: "medium",
    folded: true,
    spacing: sp,
    scale,
    opsRows: 2,
    albums: null,
    preview: { x, y: alignBox(sp.top, dpr), w: box.w, h: box.h },
    ops: { x: LIB.edge, y: opsY, w: shelfW, h: LIB.mediumOps },
    shelf: { x: LIB.edge, y: shelfY, w: shelfW, h: h - sp.bottom - shelfY },
    columns,
  };
}

export type LibraryLayout = WideLayout | MediumLayout;

/** ★ライブラリの置き方（区分は描く画面と同じ決まり。案内が要る大きさ〔狭・低・幅 744 未満の中・高さ 721 未満の広〕は null＝決-20 の案内） */
export function libraryLayout(w: number, h: number, dpr: number, folded: boolean): LibraryLayout | null {
  if (guideNeeded(w, h)) return null;
  return categoryOf(w, h) === "wide" ? wideLayout(w, h, dpr, folded) : mediumLayout(w, h, dpr);
}

/** 全画面で見る（UI §6-6） */
export interface TheaterLayout {
  scale: number;
  pic: Rect;
  /** 操作の帯を絵に重ねるか（重ねるときは、再生中に 3 秒触らなければ隠す） */
  overlay: boolean;
  bar: Rect;
}
export const THEATER_HIDE_MS = 3000;
export function theaterLayout(w: number, h: number, dpr: number): TheaterLayout | null {
  const scale = fitPreviewScale(w - LIB.theaterEdge * 2, h - LIB.theaterEdge * 2, dpr);
  if (scale === null) return null;
  const box = previewBox(scale);
  const need = LIB.theaterEdge + box.h + LIB.theaterGap + LIB.theaterBar + LIB.theaterBottom;
  const overlay = need > h;
  const x = alignBox((w - box.w) / 2, dpr);
  const y = alignBox(overlay ? (h - box.h) / 2 : (h - box.h - LIB.theaterGap - LIB.theaterBar) / 2, dpr);
  const barY = overlay ? h - LIB.theaterBottom - LIB.theaterBar : y + box.h + LIB.theaterGap;
  return { scale, pic: { x, y, w: box.w, h: box.h }, overlay, bar: { x, y: barY, w: box.w, h: LIB.theaterBar } };
}

// =====================================================================================
// 並び順・検索・選択
// =====================================================================================

/** 拡張子を除いた名前（画面に出す名前・検索と並びに使う名前） */
export function displayName(fileName: string): string {
  return fileName.replace(/\.(memoanima|animemo)$/i, "");
}

/**
 * ★棚に出す作品（PC の shelfItems の写し）: 検索が空なら選んでいるアルバムの作品、検索があれば全部のアルバムから名前に含むもの。
 *  並び順 manual は渡された順のまま（Rust の既定の並び＝アルバム → order → 名前。モバイルで並べ替える操作は v1 に無い）、
 *  name は名前順・date は新しい順（同じなら名前順）。照合はいまの表示言語（PC と同じ）。
 *  ★PC の item.name は拡張子の無い名前。モバイルの一覧の name は拡張子つきなので、比べる前に外す。
 */
export function shelfItems(works: readonly LibraryWork[], album: string, search: string, sort: ShelfSort, lang: string): LibraryWork[] {
  const q = search.trim().toLowerCase();
  let list = works.filter((i) => i.album === album);
  if (q) list = works.filter((i) => displayName(i.name).toLowerCase().includes(q));
  if (sort === "name") list = [...list].sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), lang));
  else if (sort === "date") list = [...list].sort((a, b) => b.sortedAt - a.sortedAt || displayName(a.name).localeCompare(displayName(b.name), lang));
  return list;
}

/** アルバムごとの作品の数 */
export function albumCounts(albums: readonly string[], works: readonly LibraryWork[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of albums) m.set(a, 0);
  for (const w of works) m.set(w.album, (m.get(w.album) ?? 0) + 1);
  return m;
}

export interface Selection {
  album: string;
  /** 選んでいる作品（アルバムとファイルの名前）。無ければ null */
  work: { album: string; name: string } | null;
}

/**
 * ★一覧を取り直したあとの選択の持ち越し: アルバムが無くなっていれば、選んでいる作品のアルバムへ（無ければ先頭へ）。選んでいた作品が無くなっていれば選択を外す
 *  （勝手に別の作品を選ばない）。`prefer`＝描く画面から戻ったとき・名前を変えた・移したあとに選ぶ作品。
 */
export function carrySelection(prev: Selection, albums: readonly string[], works: readonly LibraryWork[], prefer?: { album: string; name: string } | null): Selection {
  const has = (w: { album: string; name: string } | null | undefined) => !!w && works.some((x) => x.album === w.album && x.name === w.name);
  if (prefer && has(prefer)) return { album: prefer.album, work: { album: prefer.album, name: prefer.name } };
  const work = has(prev.work) ? prev.work : null;
  // 見ていたアルバムが無くなったら、選んでいる作品のアルバムへ（無ければ先頭へ）
  const album = albums.includes(prev.album) ? prev.album : work && albums.includes(work.album) ? work.album : (albums[0] ?? "");
  return { album, work };
}

/** 同じアルバムに同じ名前の作品があるか（大小と NFC を無視＝ui/saveDialog.ts の sameName と同じ見方。自分は数えない） */
export function workNameTaken(works: readonly LibraryWork[], album: string, self: string, newBase: string): boolean {
  const f = foldName(newBase);
  return works.some((w) => w.album === album && w.name !== self && foldName(displayName(w.name)) === f);
}
/** 同じ名前のアルバムがあるか（自分は数えない） */
export function albumNameTaken(albums: readonly string[], self: string | null, name: string): boolean {
  const f = foldName(name);
  return albums.some((a) => a !== self && foldName(a) === f);
}

/** ライブラリの数と大きさ（設定の「ライブラリ」） */
export function libraryStats(albums: readonly string[], works: readonly LibraryWork[]): { works: number; albums: number; bytes: number } {
  return { works: works.length, albums: albums.length, bytes: works.reduce((a, w) => a + (Number.isFinite(w.size) ? w.size : 0), 0) };
}

/** 再生位置の読み上げとつまみ: 0〜1 の位置 → コマ（0 始まり） */
export function frameAt(ratio: number, total: number): number {
  if (total <= 1) return 0;
  return Math.max(0, Math.min(total - 1, Math.round(ratio * (total - 1))));
}
