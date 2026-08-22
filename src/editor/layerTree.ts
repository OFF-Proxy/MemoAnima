// M3.8: レイヤーツリーの移動ロジック（純関数・Editor非依存）
// クリスタ流DnD（行間=並べ替え・フォルダ行=入れる・複数選択）の中核。
// ★不変条件（M3.7 Codex指摘の再発防止・m37_smoke で機械検証）:
//   1. layerDefs は下→上の平坦順で、同一フォルダの子（ネスト込み）は常に連続ブロック。
//   2. 物理順（id列）が実際に変わったときだけ frames[].order を標準化（呼び出し側へ changed で通知）。
//   3. 循環（フォルダを自分/子孫へ）を禁止。

import { Project, LayerFolder, effectiveLayerStates } from "./model";
import { t } from "../i18n";

/** 挿入先。gap=行間（parent の子として物理 phys 位置へ挿入）/ into=フォルダの末尾の子 */
export type DropTarget =
  | { type: "gap"; parent: string | undefined; phys: number }
  | { type: "into"; folder: string };

export interface MoveResult {
  ok: boolean;
  /** 物理順（layerDefs の id 列）が変わったか（true なら呼び出し側で frames[].order を標準化） */
  changedPhys: boolean;
  error?: string;
}

const folderById = (p: Project, id: string | undefined): LayerFolder | undefined =>
  (p.folders ?? []).find((f) => f.id === id);

/** 祖先フォルダ連鎖（root→…→直親。壊れ/循環は打ち切り） */
export function ancestorChain(p: Project, parent: string | undefined): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = parent;
  while (cur && !seen.has(cur)) {
    const f = folderById(p, cur);
    if (!f) break;
    seen.add(cur);
    chain.unshift(cur);
    cur = f.parent;
  }
  return chain;
}

/** folderId（ネスト込み）に属するレイヤーの index 列（昇順） */
export function folderLayerIndices(p: Project, folderId: string): number[] {
  const out: number[] = [];
  p.layerDefs.forEach((ld, i) => {
    if (ancestorChain(p, ld.parent).includes(folderId)) out.push(i);
  });
  return out;
}

/** 選択 id 群から「トップノード」（祖先が選択に含まれない node）だけを残す */
export function topNodesOf(p: Project, ids: string[]): string[] {
  const set = new Set(ids);
  const isLayer = (id: string) => p.layerDefs.some((l) => l.id === id);
  return ids.filter((id) => {
    const parent = isLayer(id)
      ? p.layerDefs.find((l) => l.id === id)?.parent
      : folderById(p, id)?.parent;
    return !ancestorChain(p, parent).some((a) => set.has(a));
  });
}

/**
 * M13-1: 移動ツール（**選択範囲が無いとき**）で動かすレイヤーを決める。
 *
 * `selectedNodeIds`（M3.8 の複数選択）が起点。以前は `selectedFolderId` → `activeLayerId` しか
 * 見ておらず、**複数選択を一度も見ていなかった**（レイヤーを3枚選んでも1枚しか動かない症状の原因）。
 *
 * REQ_M13_1_move §6-1 の7段:
 *   1. `selectedNodeIds` を集める（レイヤー / フォルダが混在しうる）
 *   2. 空なら `activeLayerId` 1件（＝従来の挙動を残す）
 *   3. フォルダはネスト込みで中のレイヤーへ展開
 *   4. 重複を除く（混在選択で同じレイヤーが2回入ると移動量が2倍になる）
 *   5. **実効可視が false のものを除く**
 *   6. 掴んだコマにバッファが無いものを除く
 *   7. 残り0件なら呼び出し側が `ed.layer.move.noTarget.toast` を出す
 *
 * ★可視の判定は必ず `effectiveLayerStates()` を使う（`ld.visible` を自分で見ない）。
 *   フォルダの非表示が中身へ効かず、**UI と合成（render.ts）が食い違う**ため。
 *
 * UI 状態を引数で受け取る純関数にしてある（`m37_smoke` から展開・重複除去・非表示除外を検証するため）。
 */
export function moveTargetLayerIds(
  p: Project,
  selectedNodeIds: Iterable<string>,
  activeLayerId: string | null | undefined,
  frameIndex: number
): string[] {
  const seeds = [...selectedNodeIds];
  // 2: 何も選んでいないときだけ activeLayerId へフォールバック
  const roots = seeds.length > 0 ? seeds : activeLayerId ? [activeLayerId] : [];

  // 3・4: フォルダを展開しつつ、挿入順を保ったまま重複を除く
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of roots) {
    if (folderById(p, id)) {
      for (const i of folderLayerIndices(p, id)) {
        const ld = p.layerDefs[i];
        if (ld) push(ld.id);
      }
    } else if (p.layerDefs.some((l) => l.id === id)) {
      push(id);
    }
  }

  // 5・6
  const eff = effectiveLayerStates(p);
  const frame = p.frames[frameIndex];
  return out.filter((id) => eff.get(id)?.visible === true && !!frame?.layers[id]);
}

/** ドロップ先 parent（gap の親 or intoフォルダ）に対する循環チェック。true=循環で不可 */
export function wouldCycle(p: Project, ids: string[], targetParent: string | undefined): boolean {
  if (!targetParent) return false;
  const folderIds = ids.filter((id) => folderById(p, id));
  if (folderIds.length === 0) return false;
  const chain = [targetParent, ...ancestorChain(p, folderById(p, targetParent)?.parent)];
  return folderIds.some((fid) => fid === targetParent || chain.includes(fid));
}

/** ★不変条件1の検査: 全フォルダの子レイヤー（ネスト込み）が連続ブロックか */
export function checkContiguity(p: Project): boolean {
  for (const f of p.folders ?? []) {
    const idx = folderLayerIndices(p, f.id);
    for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return false;
  }
  return true;
}

/**
 * 選択ノード群（レイヤー/フォルダ混在可・複数可）を target へ移動する。
 * - 表示上の相対順（=物理 index の順）を保ったまま 1 ブロックとして挿入。
 * - トップノードの parent を付け替え（フォルダ内部の構造は不変）。
 * - frames[].order の標準化は行わない（changedPhys を見て呼び出し側が行う）。
 */
export function moveNodes(p: Project, ids: string[], target: DropTarget): MoveResult {
  const tops = topNodesOf(p, ids);
  if (tops.length === 0) return { ok: false, changedPhys: false, error: t("ed.layer.move.noTarget.msg") };

  const targetParent = target.type === "into" ? target.folder : target.parent;
  if (targetParent && !folderById(p, targetParent))
    return { ok: false, changedPhys: false, error: t("ed.layer.move.folderMissing.msg") };
  if (wouldCycle(p, tops, targetParent))
    return { ok: false, changedPhys: false, error: t("ed.layer.move.cycle.msg") };

  // 移動レイヤー集合（トップがフォルダなら子孫レイヤーも全部）
  const movedLayerIds = new Set<string>();
  for (const id of tops) {
    if (folderById(p, id)) {
      for (const i of folderLayerIndices(p, id)) movedLayerIds.add(p.layerDefs[i].id);
    } else if (p.layerDefs.some((l) => l.id === id)) {
      movedLayerIds.add(id);
    }
  }

  const defs = p.layerDefs;
  const idsBefore = defs.map((l) => l.id).join();
  // ブロック＝移動レイヤーを物理昇順のまま並べたもの（表示上の相対順が保たれる）
  const block = defs.filter((l) => movedLayerIds.has(l.id));
  const rest = defs.filter((l) => !movedLayerIds.has(l.id));

  // 挿入位置（rest 基準に補正）
  let insertAt: number;
  if (target.type === "into") {
    const memberIdx: number[] = [];
    rest.forEach((l, i) => {
      if (ancestorChain(p, l.parent).includes(target.folder)) memberIdx.push(i);
    });
    insertAt =
      memberIdx.length > 0
        ? memberIdx[0] // 既存メンバーの最下位の下 = 表示上の「末尾の子」
        : rest.length > 0
          ? Math.min(defs.findIndex((l) => movedLayerIds.has(l.id)), rest.length) // 空フォルダ: 物理位置は極力動かさない
          : 0;
    if (insertAt < 0) insertAt = rest.length;
  } else {
    // gap: defs 基準の phys を rest 基準へ（挿入点より下にいた移動分だけ詰まる）
    let removedBelow = 0;
    defs.forEach((l, i) => {
      if (i < target.phys && movedLayerIds.has(l.id)) removedBelow++;
    });
    insertAt = Math.max(0, Math.min(rest.length, target.phys - removedBelow));
  }

  // parent 付け替え（トップノードのみ。フォルダ内部は不変）
  for (const id of tops) {
    const f = folderById(p, id);
    if (f) f.parent = targetParent;
    else {
      const ld = defs.find((l) => l.id === id);
      if (ld) ld.parent = targetParent;
    }
  }

  rest.splice(insertAt, 0, ...block);
  p.layerDefs = rest;
  const changedPhys = rest.map((l) => l.id).join() !== idsBefore;
  return { ok: true, changedPhys };
}
