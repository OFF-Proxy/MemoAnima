// M3.8: レイヤーツリーの移動ロジック（純関数・Editor非依存）
// クリスタ流DnD（行間=並べ替え・フォルダ行=入れる・複数選択）の中核。
// ★不変条件（M3.7 独立レビューの指摘の再発防止・m37_smoke で機械検証）:
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
 *   2. ★V206 (A-115): 知らない id を除き（同じ id は 1 回）`topNodesOf` で畳んで、残りが 0 か**レイヤー 1 枚**なら
 *      `activeLayerId` 1件（描いているレイヤー＝オレンジの枠。ゆらゆらの `wobbleTargetLayerIds` と同じ決まり・作者決定 2026-10-21）。
 *      ＋でレイヤーを足した直後などは青い枠（selectedNodeIds）が前のレイヤーに残るが、動くのは描いているレイヤー。
 *      フォルダ 1 つ・2 つ以上なら、**畳む前の**選んでいるものを起点に 3・4 へ（中身も並びも今のまま）
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
  // 2: 0 か、レイヤー 1 枚なら描いているレイヤー（V206・A-115）。フォルダや 2 つ以上は畳む前の seeds が起点（畳んだあとを起点にすると並びが変わる）
  const known = [...new Set(seeds)].filter((id) => !!folderById(p, id) || p.layerDefs.some((l) => l.id === id));
  const tops = topNodesOf(p, known);
  const oneLayer = tops.length === 0 || (tops.length === 1 && !folderById(p, tops[0]));
  const roots = oneLayer ? (activeLayerId ? [activeLayerId] : []) : seeds;

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
  // V157 (D-1): **実効ロックも同じ場所で除外**する（実効可視の除外に1条件足しただけ）。
  // ロックを使っていない作品では `locked` が全部 false なので、挙動は1ミリも変わらない。
  // ここを通るのは複数レイヤーの移動・変形——🔒を1枚混ぜて掴んでも、その1枚は動かない
  return out.filter(
    (id) =>
      eff.get(id)?.visible === true && eff.get(id)?.locked !== true && !!frame?.layers[id]
  );
}

/** V205 (A-114): ゆらゆらの「選択中」の対象。`layer`＝描いているレイヤー 1 枚／`folder`＝フォルダ 1 つの中／`multi`＝2 つ以上の和 */
export interface WobbleTargets {
  kind: "layer" | "folder" | "multi";
  /** 揺らすレイヤーの id（下→上・重複なし・📌 は除いた）。空なら揺らせるレイヤーが無い */
  ids: string[];
  /** 表示に出す名前。`layer`＝描いているレイヤーの名前・`folder`＝フォルダの名前・`multi`＝""（数だけを出す） */
  name: string;
}

/**
 * ★V205 (A-114・REQ_wobble_targets §2-1): ゆらゆらの「選択中」で揺らすレイヤーを決める。
 * ダイアログの対象の行（ラベル・説明の数）・見本・［つくる］の 3 か所が、どれもこの関数を呼ぶ。
 *
 *   1. 選んでいるもの（`selectedNodeIds`）から、知らない id を除き、`topNodesOf` で畳む
 *      （フォルダとその中のレイヤーを両方選んだら、フォルダだけ）
 *   2. 残りが 0 か、レイヤー 1 枚 → **描いているレイヤー（`activeLayerId`）1 枚**（今と同じ・作者決定 2026-10-20）。
 *      ＋でレイヤーを足した直後は青い枠（selectedNodeIds）が前のレイヤーに残るが、揺れるのはオレンジ（描いている方）
 *   3. フォルダ 1 つ → その中のレイヤー全部（入れ子も・`folderLayerIndices`）
 *   4. 2 つ以上 → それぞれ（フォルダは中のレイヤー全部）の和。重複は除く
 *   5. 📌（全コマ共通）は入れない（揺らしても挿入のときに張り直されて残らない＝V204）
 *
 * ★移動ツールの `moveTargetLayerIds` とは規則が**逆**の所がある: こちらは 👁 で隠したレイヤー（フォルダごと隠したものも）と
 *   🔒 のレイヤーも**入れる**（「全レイヤー」と同じ＝あとで表示しても、ほかのレイヤーとずれない・作者決定 2026-10-20）。
 *   なので可視とロックは見ない。そのコマにバッファがあるかでも落とさない（`buildWobbleFrame` が無いものを飛ばす）。
 *   2 の「1 枚なら描いているレイヤー」は移動ツールも同じになった（V206・A-115）。
 */
export function wobbleTargetLayerIds(
  p: Project,
  selectedNodeIds: Iterable<string>,
  activeLayerId: string | null | undefined
): WobbleTargets {
  const layerOf = (id: string) => p.layerDefs.find((l) => l.id === id);
  // 1: 知らない id を除いてから畳む（同じ id が 2 回あっても 1 回＝配列でも Set と同じ答え）
  const known = [...new Set(selectedNodeIds)].filter((id) => !!layerOf(id) || !!folderById(p, id));
  const tops = topNodesOf(p, known);
  // 2: 0 か、レイヤー 1 枚 → 描いているレイヤー
  if (tops.length === 0 || (tops.length === 1 && !folderById(p, tops[0]))) {
    const ld = activeLayerId ? layerOf(activeLayerId) : undefined;
    return { kind: "layer", ids: ld && ld.shared !== true ? [ld.id] : [], name: ld?.name ?? "" };
  }
  // 3・4: フォルダは入れ子ごと中のレイヤーへ広げる。集合に入れて、最後に layerDefs の並び（下→上）で取り出す＝重複は 1 回
  const want = new Set<string>();
  for (const id of tops) {
    if (folderById(p, id)) {
      for (const i of folderLayerIndices(p, id)) {
        const ld = p.layerDefs[i];
        if (ld) want.add(ld.id);
      }
    } else want.add(id);
  }
  // 5: 📌 は入れない
  const ids = p.layerDefs.filter((ld) => want.has(ld.id) && ld.shared !== true).map((ld) => ld.id);
  if (tops.length === 1) return { kind: "folder", ids, name: folderById(p, tops[0])?.name ?? "" };
  return { kind: "multi", ids, name: "" };
}

/**
 * ★V178 (A-72): 全レイヤー消しゴムの対象（白リスト・規則は 1 つ）。
 *
 * そのコマの `layerDefs` のうち、**実効の 👁 が true かつ実効の 🔒 が false** のものだけ。
 * `opacity` と `clip` は見ない——規則を「👁 と 🔒 の 2 つだけ」にすると利用者が説明できる
 * （「👁 で消えている絵は消えない・🔒 のレイヤーは守られる」）。
 *
 * ★可視とロックの判定は `effectiveLayerStates()` だけで行う（`ld.visible` / `ld.locked` を自分で見ない）。
 *   親フォルダが非表示・ロックのとき、中のレイヤーも対象から外すため（`moveTargetLayerIds` と同じ理由）。
 *
 * ⚠ M11-2 の「消す」コマンド（非表示も消す）とは方針が**逆**。あちらは「まとめて空にする」ので
 *   *見えないから残った、のほうが事故*。こちらは「見えている絵をなぞって消す」ので
 *   *なぞってもいない絵が消えるほうが事故*（作者決定 2026-09-23・要件 §3-1）。
 *
 * @returns `ids` = そのコマに絵がある対象（下→上）。
 *          `asleep` = 規則は満たすのに、そのコマでまだ眠っている（起きていない）もの。
 *          呼び出し側は `asleep` が 1 枚でもあれば**描かない**（半分だけ消えた状態を作らない）。
 */
export function eraseAllTargets(p: Project, frameIndex: number): { ids: string[]; asleep: string[] } {
  const eff = effectiveLayerStates(p);
  const frame = p.frames[frameIndex];
  const ids: string[] = [];
  const asleep: string[] = [];
  if (!frame) return { ids, asleep };
  for (const ld of p.layerDefs) {
    const e = eff.get(ld.id);
    if (e?.visible !== true || e.locked === true) continue;
    if (frame.layers[ld.id]) ids.push(ld.id);
    else if (frame.sleep?.[ld.id]) asleep.push(ld.id);
  }
  return { ids, asleep };
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

// ================= V208 (A-120): 一覧の並びと、ドラッグの入る先（上下の位置だけで決める） =================
// 作者の決定（2026-10-24・REQ_layer_drag）: 左右の位置は見ない。レイヤーの行は上半分＝上・下半分＝下、
// フォルダの行は上半分＝上・下半分＝中の一番下。空のフォルダは親の中の一番下に出す。
// DOM の測り（行の矩形・ポインタの y・スクロールの枠）は editor.ts、決め方はここ（Node から動かせる）。

/** 一覧の 1 行（上→下）。phys はレイヤーの物理 index（フォルダは -1） */
export interface LayerListRow {
  kind: "layer" | "folder";
  id: string;
  parent: string | undefined;
  phys: number;
  /** 字下げの段（祖先フォルダの数） */
  depth: number;
}

/** フォルダ（ネスト込み）に 1 枚もレイヤーが無いか（空のフォルダしか入っていないものも空） */
function folderIsEmpty(p: Project, folderId: string): boolean {
  return !p.layerDefs.some((ld) => ancestorChain(p, ld.parent).includes(folderId));
}

/**
 * レイヤーの一覧に出す行の並び（上→下・たたんだフォルダの中は出さない）。rebuildLayers はこれをそのまま描く。
 * 中身のあるフォルダは、中のいちばん上のレイヤーの直前に見出しを出す（従来どおり＝不変条件1の連続を前提）。
 * 空のフォルダは物理の位置を持たないので、**親の中身の一番下**（親のブロックを出るとき）に出す。
 * いちばん外の空のフォルダは一覧の一番下。同じ親の空のフォルダ同士は folders の並び順。
 */
export function layerDisplayRows(p: Project): LayerListRow[] {
  const folders = p.folders ?? [];
  const rows: LayerListRow[] = [];
  const emitted = new Set<string>();
  const collapsedIn = (chain: string[]) => chain.some((fid) => folderById(p, fid)?.collapsed);
  const emptyKids = (parentId: string | undefined) =>
    folders.filter((f) => {
      if (emitted.has(f.id) || !folderIsEmpty(p, f.id)) return false;
      const chain = ancestorChain(p, f.parent);
      // 親が無い・壊れた親（ancestorChain が空）はいちばん外
      return parentId === undefined ? chain.length === 0 : chain[chain.length - 1] === parentId;
    });
  const emitFolder = (f: LayerFolder) => {
    if (emitted.has(f.id)) return;
    emitted.add(f.id);
    const chain = ancestorChain(p, f.parent);
    if (collapsedIn(chain)) return; // たたんだフォルダの中（見出しも出さない）
    rows.push({ kind: "folder", id: f.id, parent: f.parent, phys: -1, depth: chain.length });
  };
  // 空のフォルダを（その中の空のフォルダごと）出す
  const emitEmptyUnder = (parentId: string | undefined) => {
    for (const f of emptyKids(parentId)) {
      emitFolder(f);
      emitEmptyUnder(f.id);
    }
  };
  const open: string[] = []; // 今出しているフォルダの連鎖（外→内）
  const closeTo = (keep: number) => {
    while (open.length > keep) {
      const fid = open.pop()!;
      emitEmptyUnder(fid); // 親のブロックを出るときに、その中の空のフォルダを一番下に出す
    }
  };
  for (let i = p.layerDefs.length - 1; i >= 0; i--) {
    const ld = p.layerDefs[i];
    const chain = ancestorChain(p, ld.parent);
    let common = 0;
    while (common < open.length && common < chain.length && open[common] === chain[common]) common++;
    closeTo(common);
    for (let d = common; d < chain.length; d++) {
      const f = folderById(p, chain[d]);
      if (f) emitFolder(f);
      open.push(chain[d]);
    }
    if (collapsedIn(chain)) continue;
    rows.push({ kind: "layer", id: ld.id, parent: ld.parent, phys: i, depth: chain.length });
  }
  closeTo(0);
  emitEmptyUnder(undefined);
  // 保険: 親の連鎖が輪になっているなど、上で出せなかったフォルダ（従来の「末尾にまとめて出す」と同じ）
  for (const f of folders) {
    if (emitted.has(f.id)) continue;
    for (const fid of [...ancestorChain(p, f.parent), f.id]) {
      const g = folderById(p, fid);
      if (g) emitFolder(g);
    }
  }
  return rows;
}

/** 行の当たり（editor.ts が DOM で測って渡す）。gap＝rows[index] の上の隙間・end＝最後の行より下の空き地 */
export type RowDropHit =
  | { kind: "row"; index: number; half: "upper" | "lower" }
  | { kind: "gap"; index: number }
  | { kind: "end" };

/** 入る先の決め方の結果 */
export interface RowDropPlan {
  /** moveNodes に渡す入る先 */
  target: DropTarget;
  /** 見せ方: 挿入線（rows の gap 番目の隙間＝rows[gap] の上に・depth 段の字下げで）か、フォルダの行の枠（中の一番下へ） */
  view: { kind: "line"; gap: number; depth: number } | { kind: "into"; rowIdx: number };
  /** 入る先のフォルダ（色で囲む・名前を出す）。いちばん外は undefined */
  folder: string | undefined;
  /** ゴーストの 2 行目: in＝フォルダの中の行のあいだ・inEnd＝フォルダの行の下半分・out＝いちばん外 */
  label: "in" | "inEnd" | "out";
}

type RowLike = Pick<LayerListRow, "kind" | "id" | "parent" | "phys">;

/** 隙間 gi（rows[gi] の上）の物理の位置＝隙間より下で最初に物理の位置を持つ行の直上（空のフォルダは飛ばす） */
function gapPhys(p: Project, rows: readonly RowLike[], gi: number): number {
  for (let i = gi; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === "layer") return r.phys + 1;
    const members = folderLayerIndices(p, r.id);
    if (members.length > 0) return members[members.length - 1] + 1;
  }
  return 0;
}

/** moveNodes を写しで動かした作品（元の p は変えない）。動かせなければ null */
function projectAfterMove(p: Project, ids: string[], target: DropTarget): Project | null {
  const q: Project = {
    ...p,
    layerDefs: p.layerDefs.map((l) => ({ ...l })),
    folders: (p.folders ?? []).map((f) => ({ ...f })),
  };
  return moveNodes(q, ids, target).ok ? q : null;
}

/** moveNodes を写しで動かして、落としたあとの一覧の並びを返す（元の p は変えない） */
export function rowsAfterMove(p: Project, ids: string[], target: DropTarget): LayerListRow[] | null {
  const q = projectAfterMove(p, ids, target);
  return q ? layerDisplayRows(q) : null;
}

/**
 * ポインタの当たりから、入る先を決める（X は見ない）。
 *   レイヤーの行の上半分＝その行の上／下半分＝その行の下（どちらもその行の親の中）
 *   フォルダの行の上半分＝そのフォルダの上（フォルダの親の中）／下半分＝そのフォルダの中の一番下
 *   行と行の間の隙間＝下の行の上／最後の行より下の空き地＝フォルダの外の一番下
 * 自分や子孫の中へは null（wouldCycle）。
 * ★中の一番下で、入る先のフォルダに掴んでいないレイヤーが 1 枚も無いとき（中身の無いフォルダ・空のフォルダしか
 *   入っていない・中身を全部掴んでいる）は、moveNodes に渡すのを「そのフォルダの行のすぐ下の隙間（parent＝そのフォルダ）」
 *   にする。into のままだと moveNodes の空のフォルダの枝が物理の位置を動かさず、親の子が連続でなくなる（V208 で見つけた
 *   前からの不具合・不変条件1）。見せ方・文言は中へのまま。
 * 線は**落としたあとに掴んだ物が出る所**に引く（空のフォルダは物理の位置を持たないので、指した隙間と違う所に出ることがある）。
 */
export function dropTargetAt(
  p: Project,
  rows: readonly RowLike[],
  hit: RowDropHit | null,
  draggedIds: string[]
): RowDropPlan | null {
  const ids = topNodesOf(p, draggedIds);
  if (!hit || ids.length === 0) return null;
  let gi: number; // 指した隙間（rows[gi] の上）
  let parent: string | undefined;
  const idx = hit.kind === "end" ? rows.length : Math.max(0, Math.min(rows.length, hit.index));
  const r = idx < rows.length ? rows[idx] : undefined;
  if (hit.kind === "row" && r && r.kind === "folder" && hit.half === "lower") {
    // フォルダの中の一番下
    if (wouldCycle(p, ids, r.id)) return null;
    const moved = new Set<string>();
    for (const id of ids) {
      if (folderById(p, id)) for (const i of folderLayerIndices(p, id)) moved.add(p.layerDefs[i].id);
      else moved.add(id);
    }
    const keeps = folderLayerIndices(p, r.id).some((i) => !moved.has(p.layerDefs[i].id));
    const target: DropTarget = keeps
      ? { type: "into", folder: r.id }
      : { type: "gap", parent: r.id, phys: gapPhys(p, rows, idx + 1) };
    return { target, view: { kind: "into", rowIdx: idx }, folder: r.id, label: "inEnd" };
  }
  if (!r) {
    gi = rows.length; // 最後の行より下の空き地＝フォルダの外の一番下
    parent = undefined;
  } else if (hit.kind === "row" && hit.half === "lower") {
    gi = idx + 1; // レイヤーの行の下半分＝その行の下（その行の親の中）
    parent = r.parent;
  } else {
    gi = idx; // 上半分・隙間＝その行の上（その行の親の中）
    parent = r.parent;
  }
  if (parent !== undefined && !folderById(p, parent)) parent = undefined; // 壊れた親はいちばん外（表示と同じ）
  if (wouldCycle(p, ids, parent)) return null;
  const target: DropTarget = { type: "gap", parent, phys: r ? gapPhys(p, rows, gi) : 0 };
  return {
    target,
    view: { kind: "line", gap: landingGap(p, rows, ids, target, gi), depth: ancestorChain(p, parent).length },
    folder: parent,
    label: parent === undefined ? "out" : "in",
  };
}

/** 落としたあとに掴んだ物（の最初）が出る所を、今の rows の隙間の番号で返す（出る所の直下の行の上） */
function landingGap(p: Project, rows: readonly RowLike[], ids: string[], target: DropTarget, fallback: number): number {
  const q = projectAfterMove(p, ids, target);
  if (!q) return fallback;
  const after = layerDisplayRows(q);
  const set = new Set(ids);
  const first = after.findIndex((x) => set.has(x.id));
  if (first < 0) return fallback; // たたんだフォルダの中など、出ない所
  const inBlock = (x: LayerListRow) =>
    set.has(x.id) ||
    ancestorChain(p, x.kind === "folder" ? folderById(p, x.id)?.parent : x.parent).some((a) => set.has(a));
  // 線の目安は、掴んだ物のあとに来る「動かない行」。この移動で空になる・空でなくなるフォルダは、中身ごと動く（空のフォルダは
  // 親の中の一番下に並ぶ）ので、そのフォルダとその中の行は目安にしない（第三者レビューの指摘 2 つ・目安にすると線が見当違いの所に出る）
  const flips = (fid: string) => folderIsEmpty(p, fid) !== folderIsEmpty(q, fid);
  const moves = (x: LayerListRow) =>
    inBlock(x) || [...(x.kind === "folder" ? [x.id] : []), ...ancestorChain(p, x.kind === "folder" ? folderById(p, x.id)?.parent : x.parent)].some(flips);
  let k = first + 1;
  while (k < after.length && moves(after[k])) k++;
  if (k >= after.length) return rows.length;
  const next = rows.findIndex((x) => x.id === after[k].id);
  return next >= 0 ? next : fallback;
}

/**
 * V208 (A-120): ドラッグ中の一覧の流れ（1 フレームの量・px）。枠の上端・下端から edge px の中で端に近いほど速く、
 * 枠を越えたら（見出しの上など）いちばん速く。負＝上へ・0＝流さない。
 */
export function dragScrollStep(y: number, top: number, bottom: number, edge = 24, max = 14): number {
  if (bottom - top <= 2 * edge) return 0;
  if (y < top + edge) return -Math.max(1, Math.round((max * Math.min(edge, top + edge - y)) / edge));
  if (y > bottom - edge) return Math.max(1, Math.round((max * Math.min(edge, y - (bottom - edge))) / edge));
  return 0;
}
