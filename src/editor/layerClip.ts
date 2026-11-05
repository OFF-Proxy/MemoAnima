// V199 (A-105): レイヤーのコピー・貼り付けの決まり（純関数・DOM に触らない）。
//   要件 docs/REQ_layer_copy_v1.md（作者の決定 2026-10-12）
//
// ★控え（LayerClip）は 2 つの形:
//   - "layer"  … 選んでいるレイヤー 1 枚の、いまのコマの絵（M11-15 からの形）
//   - "folder" … 選んでいるフォルダの中の全部のレイヤー（中のフォルダの中も・非表示も）の、いまのコマの絵。
//                **レイヤーの id ごと**に控える＝貼り先は「控えた同じレイヤー」（何を選んでいても同じ）
//
// ★控えは作品をまたがない（editor の `clearLayerClip()` が mount で捨てる）。保存形式には一切触れない。
// ★ここは「何を・どこへ」を決めて書くだけ。確認・ロックの知らせ・履歴・眠っているコマを起こすのは editor 側。

import { type Project, type Frame, type IndexBuf, type LayerDef, type LayerFolder, copyIndexBuf } from "./model";
import { ancestorChain, folderLayerIndices } from "./layerTree";

/** フォルダの控えの 1 枚 */
export interface LayerClipItem {
  layerId: string;
  /** 控えたときの名前と見え方（「新規レイヤーへ」で同じ並びを作るときに使う） */
  def: { name: string; visible: boolean; opacity: number; clip?: boolean; displayColor?: string };
  /** 控えたときの親（コピーしたフォルダ自身か、その中のフォルダ） */
  parent: string;
  buf: IndexBuf;
  /** ★V216b (A-132): 控えたコマの「このコマだけの表示色」（`frame.layerColors`）。無ければ付けない */
  frameColor?: string;
}

/** 控えたときの中のフォルダ（入れ子） */
export interface LayerClipSubfolder {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  parent: string;
}

export type LayerClip =
  /** V216b (A-132): frameColor＝控えたコマの「このコマだけの表示色」（無ければ付けない） */
  | { kind: "layer"; frame: number; layerId: string; name: string; buf: IndexBuf; frameColor?: string }
  | {
      kind: "folder";
      frame: number;
      folderId: string;
      name: string;
      folder: { visible: boolean; opacity: number };
      /** layerDefs の順（下から上） */
      items: LayerClipItem[];
      /** project.folders の順 */
      subfolders: LayerClipSubfolder[];
      /** ★V216b (A-132): 控えたコマに描画順（`frame.order`）があれば、その中での items のレイヤーの前後（下から上）。無ければ付けない */
      order?: string[];
    };

export type FolderClip = Extract<LayerClip, { kind: "folder" }>;

/** フォルダ（入れ子込み）の中のレイヤー。layerDefs の順（下から上） */
export function folderMembers(p: Project, folderId: string): LayerDef[] {
  return folderLayerIndices(p, folderId).map((i) => p.layerDefs[i]);
}

/** フォルダの中のフォルダ（子孫だけ・自分は含めない）。project.folders の順 */
export function folderDescendants(p: Project, folderId: string): LayerFolder[] {
  return (p.folders ?? []).filter((f) => f.id !== folderId && ancestorChain(p, f.parent).includes(folderId));
}

/** レイヤー 1 枚の、コマ `frameIndex` の絵を控える。レイヤーかバッファが無ければ null。
 *  ★眠っているコマは呼び出し側が先に起こす（起こさずに呼ぶとバッファが無い＝null） */
export function copyLayerClip(p: Project, frameIndex: number, layerId: string): LayerClip | null {
  const ld = p.layerDefs.find((l) => l.id === layerId);
  const fr = p.frames[frameIndex];
  const buf = fr?.layers[layerId];
  if (!ld || !buf) return null;
  const clip: LayerClip = { kind: "layer", frame: frameIndex, layerId, name: ld.name, buf: copyIndexBuf(buf) };
  const color = fr?.layerColors?.[layerId];
  if (color) clip.frameColor = color; // V216b (A-132)
  return clip;
}

/** フォルダの中の全部のレイヤー（中のフォルダの中も・非表示も）の、コマ `frameIndex` の絵を控える。
 *  フォルダが無ければ null。レイヤーが 1 枚も無ければ items が空（呼び出し側が「レイヤーがありません」と言う）。
 *  ★眠っているコマは呼び出し側が先に起こす */
export function copyFolderClip(p: Project, frameIndex: number, folderId: string): FolderClip | null {
  const folder = (p.folders ?? []).find((f) => f.id === folderId);
  const fr = p.frames[frameIndex];
  if (!folder || !fr) return null;
  const items: LayerClipItem[] = [];
  for (const ld of folderMembers(p, folderId)) {
    const buf = fr.layers[ld.id];
    if (!buf) continue;
    const def: LayerClipItem["def"] = { name: ld.name, visible: ld.visible, opacity: ld.opacity };
    if (ld.clip) def.clip = true;
    if (ld.displayColor) def.displayColor = ld.displayColor;
    const item: LayerClipItem = { layerId: ld.id, def, parent: ld.parent ?? folderId, buf: copyIndexBuf(buf) };
    const color = fr.layerColors?.[ld.id];
    if (color) item.frameColor = color; // V216b (A-132): このコマだけの表示色
    items.push(item);
  }
  // V216b (A-132): このコマの描画順の中での前後（下から上）
  const ids = new Set(items.map((i) => i.layerId));
  const order = fr.order ? fr.order.filter((id) => ids.has(id)) : undefined;
  return {
    ...(order ? { order } : {}),
    kind: "folder",
    frame: frameIndex,
    folderId,
    name: folder.name,
    folder: { visible: folder.visible, opacity: folder.opacity },
    items,
    subfolders: folderDescendants(p, folderId).map((f) => ({
      id: f.id,
      name: f.name,
      visible: f.visible,
      opacity: f.opacity,
      parent: f.parent ?? folderId,
    })),
  };
}

/** 控えが抱えている絵の全部（色を消す前の調べ・履歴の申告に使う） */
export function clipBuffers(c: LayerClip | null): IndexBuf[] {
  if (!c) return [];
  return c.kind === "layer" ? [c.buf] : c.items.map((i) => i.buf);
}

/** 貼り先の決まり（どのレイヤーへ・どの絵を）。消えたレイヤー・ロック中のレイヤーは飛ばして数える */
export interface PastePlan {
  writes: { layerId: string; src: IndexBuf }[];
  /** 控えたあとに消えたレイヤーの枚数 */
  missing: number;
  /** ロック中で飛ばした枚数 */
  locked: number;
}

/** 貼り先を決める。
 *  - レイヤーの控え: 選んでいるレイヤー（`activeLayerId`）へ。ロック中なら書かない
 *  - フォルダの控え: **控えた同じレイヤー**それぞれへ（何を選んでいても同じ）。
 *    消えたレイヤーとロック中のレイヤーは飛ばす */
export function planLayerPaste(
  p: Project,
  c: LayerClip,
  activeLayerId: string,
  isLocked: (layerId: string) => boolean
): PastePlan {
  const exists = new Set(p.layerDefs.map((l) => l.id));
  if (c.kind === "layer") {
    if (!exists.has(activeLayerId)) return { writes: [], missing: 1, locked: 0 };
    if (isLocked(activeLayerId)) return { writes: [], missing: 0, locked: 1 };
    return { writes: [{ layerId: activeLayerId, src: c.buf }], missing: 0, locked: 0 };
  }
  const plan: PastePlan = { writes: [], missing: 0, locked: 0 };
  for (const it of c.items) {
    if (!exists.has(it.layerId)) plan.missing++;
    else if (isLocked(it.layerId)) plan.locked++;
    else plan.writes.push({ layerId: it.layerId, src: it.buf });
  }
  return plan;
}

/** 眠っている面を起こしている間（await の間）に、貼り先のレイヤーが消えた・ロックされたかもしれない。
 *  **貼り先は決めたときのまま**で、まだ在ってロックされていないものだけを残す（選んでいるレイヤーが
 *  その間に替わっても、起こしていない別のレイヤーへは書かない）。飛ばしたぶんは数に足す */
export function recheckPastePlan(p: Project, plan: PastePlan, isLocked: (layerId: string) => boolean): PastePlan {
  const exists = new Set(p.layerDefs.map((l) => l.id));
  const out: PastePlan = { writes: [], missing: plan.missing, locked: plan.locked };
  for (const w of plan.writes) {
    if (!exists.has(w.layerId)) out.missing++;
    else if (isLocked(w.layerId)) out.locked++;
    else out.writes.push(w);
  }
  return out;
}

/** 貼って変わった 1 面（コマ × レイヤー）。取り消しはコマの実体と id で**その時に**解決する
 *  （構造の取り消し・やり直しでバッファが作り直されても正しい実体へ書き戻す＝bufferChangeEntry と同じ理由） */
export interface TouchedFace {
  frame: Frame;
  layerId: string;
  before: IndexBuf;
  src: IndexBuf;
}

function sameBuf(a: IndexBuf, b: IndexBuf): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `frames` の各コマの `writes` のレイヤーを、控えの絵で**丸ごと差し替える**。変わった面だけ返す。
 *  - そのコマにバッファが無い面は触らない（眠っている面は呼び出し側が先に起こす）
 *  - 同じ実体（📌 全コマ共通レイヤー）は 1 回だけ見る＝before を二重に取らない
 *  - **控えを全部取ってから書く**（書いたあとの絵を before に取らない）
 *  - 8/16bit: dst が 16bit・src が 8bit でも `.set` は値を保つ（逆は起きない＝作品は降格しない） */
export function applyLayerPaste(frames: readonly Frame[], writes: PastePlan["writes"]): TouchedFace[] {
  const seen = new Set<IndexBuf>();
  const touched: TouchedFace[] = [];
  for (const f of frames) {
    for (const w of writes) {
      const dst = f.layers[w.layerId];
      if (!dst || seen.has(dst)) continue;
      seen.add(dst);
      if (sameBuf(dst, w.src)) continue;
      touched.push({ frame: f, layerId: w.layerId, before: copyIndexBuf(dst), src: w.src });
    }
  }
  for (const t of touched) t.frame.layers[t.layerId].set(t.src as unknown as ArrayLike<number>);
  return touched;
}

/** 取り消し（貼る前の絵へ） */
export function undoLayerPaste(touched: readonly TouchedFace[]): void {
  for (const t of touched) t.frame.layers[t.layerId]?.set(t.before as unknown as ArrayLike<number>);
}

/** やり直し（控えの絵へ） */
export function redoLayerPaste(touched: readonly TouchedFace[]): void {
  for (const t of touched) t.frame.layers[t.layerId]?.set(t.src as unknown as ArrayLike<number>);
}

// ---------------- V203 (A-109): 重ね貼り（docs/REQ_layer_overlay_paste.md） ----------------
//  控えの**描いてある画素（索引が 0 でない画素）だけ**を貼り先へ書き、0 の所は貼り先のまま残す
//  （範囲選択の確定＝raster.ts の blitFloatTransformed と同じ重なり方）。貼り先の決め方（planLayerPaste・
//  recheckPastePlan）・取り消し（undoLayerPaste＝書く前の絵へ）は差し替えと同じものを使う。
//  ★重ねたあとの絵は持たない: やり直しは、書く前の絵の写し（before）と控えの写し（src）から作り直す
//  （履歴が抱える量・確保の見積もり・色の参照は差し替えと同じで済む）

/** 控えに描いてある画素が 1 つでもあるか（フォルダの控えなら、どれかの絵に 1 つでもあれば true） */
export function clipHasInk(c: LayerClip): boolean {
  for (const b of clipBuffers(c)) for (let i = 0; i < b.length; i++) if (b[i] !== 0) return true;
  return false;
}

/** `src` を `dst` へ重ねたら 1 画素でも変わるか（src の 0 でない画素のどこかが dst と違う） */
function overlayChanges(dst: IndexBuf, src: IndexBuf): boolean {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (v !== 0 && dst[i] !== v) return true;
  }
  return false;
}

/** `src` の 0 でない画素だけを `dst` へ書く（8/16bit: dst が 16bit・src が 8bit でも値を保つ） */
function overlayInto(dst: IndexBuf, src: IndexBuf): void {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (v !== 0) dst[i] = v;
  }
}

/** `frames` の各コマの `writes` のレイヤーへ、控えの絵を**重ねる**。変わった面だけ返す。
 *  決まりは applyLayerPaste と同じ（バッファが無い面は触らない・📌 の同じ実体は 1 回だけ・
 *  **書く前の絵を全部取ってから書く**）。重ねても変わらない面は数えない */
export function applyLayerOverlay(frames: readonly Frame[], writes: PastePlan["writes"]): TouchedFace[] {
  const seen = new Set<IndexBuf>();
  const touched: TouchedFace[] = [];
  for (const f of frames) {
    for (const w of writes) {
      const dst = f.layers[w.layerId];
      if (!dst || seen.has(dst)) continue;
      seen.add(dst);
      if (!overlayChanges(dst, w.src)) continue;
      touched.push({ frame: f, layerId: w.layerId, before: copyIndexBuf(dst), src: w.src });
    }
  }
  for (const t of touched) overlayInto(t.frame.layers[t.layerId], t.src);
  return touched;
}

/** やり直し（**重ねたあとの絵**へ）。書く前の絵の写しに控えの写しを重ねて作り直す（控えの絵そのものではない）。
 *  コマの実体と id で**その時に**解決する（構造の取り消し・やり直しで実体が作り直されても正しい実体へ） */
export function redoLayerOverlay(touched: readonly TouchedFace[]): void {
  for (const t of touched) {
    const d = t.frame.layers[t.layerId];
    if (!d) continue;
    d.set(t.before as unknown as ArrayLike<number>);
    overlayInto(d, t.src);
  }
}

/** 「新規レイヤーへ」をフォルダの控えで押したときの置き場所。
 *  元のフォルダがまだあって中にレイヤーがあれば、**そのフォルダのすぐ上**（同じ親・最後のレイヤーの直後）。
 *  無ければ `fallback`（ふつうのレイヤーの追加と同じ規則で editor が決める） */
export function folderPasteNewAnchor(
  p: Project,
  c: FolderClip,
  fallback: { parent: string | undefined; insertAt: number }
): { parent: string | undefined; insertAt: number } {
  const orig = (p.folders ?? []).find((f) => f.id === c.folderId);
  if (!orig) return fallback;
  const idx = folderLayerIndices(p, orig.id);
  if (idx.length === 0) return fallback;
  return { parent: orig.parent, insertAt: idx[idx.length - 1] + 1 };
}

/** 「新規レイヤーへ」（フォルダの控え）で作るもの。**新しいフォルダ**を 1 つ作り、その中に控えと同じ並び
 *  （中のフォルダも同じ入れ子）の新しいレイヤーを作る。名前は元の名前のまま。絵を入れるのは呼び出し側（いまのコマだけ） */
export interface FolderPasteNew {
  rootId: string;
  /** 新しいフォルダ（先頭が外側のフォルダ・残りは中のフォルダ。project.folders の末尾へこの順で足す） */
  folders: LayerFolder[];
  /** 新しいレイヤー（下から上・`insertAt` から続けて入れる＝フォルダの中が 1 つながりのまま） */
  defs: LayerDef[];
  /** defs と同じ順の控えの絵 */
  bufs: IndexBuf[];
  insertAt: number;
  /** ★V216b (A-132): defs と同じ順の、控えた元のレイヤーの id（貼るコマの描画順で、元のすぐ上に入れる） */
  srcIds: string[];
  /** ★V216b (A-132): defs と同じ順の「このコマだけの表示色」（無いものは undefined） */
  frameColors: (string | undefined)[];
  /** ★V216b (A-132): 控えたコマの描画順の中での前後（新しい id・下から上）。控えたコマに描画順が無ければ undefined */
  order?: string[];
}

/** ★V216b (A-132): 貼るコマに描画順（`frame.order`）があるとき、新しいレイヤーを入れた描画順を作る。
 *  それぞれ**控えた元のレイヤーのすぐ上**に入れる（元を隠すと、そのコマの合成が貼る前と同じ）。元がそのコマの順に無いものは、
 *  控えたコマの前後（`plan.order`・無ければ defs の順）で最上位へ。返すのは新しい配列（元の配列は変えない） */
export function orderWithPasted(order: string[], plan: Pick<FolderPasteNew, "defs" | "srcIds" | "order">): string[] {
  const out = order.slice();
  const rank = new Map((plan.order ?? plan.defs.map((d) => d.id)).map((id, i) => [id, i] as const));
  const pending: string[] = [];
  // 控えたコマで上にあったものから入れる＝同じ元の上に重ねても、上下が控えたときのまま
  const seq = plan.defs
    .map((d, i) => ({ id: d.id, src: plan.srcIds[i] }))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  for (const { id, src } of seq) {
    const at = out.indexOf(src);
    if (at < 0) pending.push(id);
    else out.splice(at + 1, 0, id);
  }
  out.push(...pending);
  return out;
}

export function planFolderPasteNew(
  c: FolderClip,
  anchor: { parent: string | undefined; insertAt: number },
  newLayerId: () => string,
  newFolderId: () => string
): FolderPasteNew {
  const rootId = newFolderId();
  const map = new Map<string, string>([[c.folderId, rootId]]);
  for (const sf of c.subfolders) map.set(sf.id, newFolderId());
  const folders: LayerFolder[] = [
    {
      id: rootId,
      name: c.name,
      visible: c.folder.visible,
      opacity: c.folder.opacity,
      collapsed: false,
      ...(anchor.parent ? { parent: anchor.parent } : {}),
    },
    ...c.subfolders.map((sf) => ({
      id: map.get(sf.id)!,
      name: sf.name,
      visible: sf.visible,
      opacity: sf.opacity,
      collapsed: false,
      parent: map.get(sf.parent) ?? rootId,
    })),
  ];
  const defs: LayerDef[] = [];
  const bufs: IndexBuf[] = [];
  const srcIds: string[] = [];
  const frameColors: (string | undefined)[] = [];
  const idMap = new Map<string, string>();
  for (const it of c.items) {
    const d: LayerDef = {
      id: newLayerId(),
      name: it.def.name,
      visible: it.def.visible,
      opacity: it.def.opacity,
      parent: map.get(it.parent) ?? rootId,
    };
    if (it.def.clip) d.clip = true;
    if (it.def.displayColor) d.displayColor = it.def.displayColor;
    defs.push(d);
    bufs.push(it.buf);
    srcIds.push(it.layerId);
    frameColors.push(it.frameColor);
    idMap.set(it.layerId, d.id);
  }
  const order = c.order?.map((id) => idMap.get(id)).filter((id): id is string => !!id);
  return { rootId, folders, defs, bufs, insertAt: anchor.insertAt, srcIds, frameColors, ...(order ? { order } : {}) };
}

/** タイムラインで 2 コマ以上を選んでいるか（1 コマだけの範囲は「このコマ」と同じ扱い）。
 *  返すのは**いまのコマ数へ詰めた**範囲（古い範囲を持ち越していても外へはみ出さない） */
export function pasteRange(
  rangeSel: { a: number; b: number } | null,
  frameCount: number
): { a: number; b: number } | null {
  if (!rangeSel || frameCount <= 0) return null;
  const last = frameCount - 1;
  const a = Math.max(0, Math.min(rangeSel.a, rangeSel.b, last));
  const b = Math.max(0, Math.min(Math.max(rangeSel.a, rangeSel.b), last));
  return b > a ? { a, b } : null;
}

/** Ctrl+V（edit.paste）が貼るほう: **最後にコピーしたほう**。
 *  レイヤー（フォルダ）の控えが最後でも、作品を開き直して控えが消えていれば範囲の貼り付け（今までどおり） */
export function pasteKind(last: "sel" | "layer" | null, hasLayerClip: boolean): "sel" | "layer" {
  return last === "layer" && hasLayerClip ? "layer" : "sel";
}

/** Ctrl+C（edit.copy）がするほう: 範囲選択があれば範囲のコピー（今までどおり）、無ければレイヤー（フォルダ）のコピー */
export function copyKind(hasSelection: boolean): "sel" | "layer" {
  return hasSelection ? "sel" : "layer";
}
