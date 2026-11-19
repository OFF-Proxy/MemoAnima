// V222 (M-2b-3a・UI docs/REQ_mobile_ui_v1.md §5-5・指示書 ■3 の E-14): レイヤーの行（フォルダを含む）を**長押しから動かす**決まり
// （画面を持たない・DOM を読まない・v222 [L] が本物のコアで見る）。
//
// ★PC の行のドラッグ（editor.ts の updateRowDrag・hitTestRowDrag・行を離したところ）と同じ順で、コアと layerTree.ts の今ある手続きを呼ぶ:
//  掴む＝grabRowForDrag(id, kind)（選択の外の行を掴んだら、その行を選んでから動かす。呼ばないと前に選んでいた行が動く）→
//  動かすもの＝topNodesOf(選んでいる行) を一覧の並びで並べたもの → 指の下の行と位置から dropTargetAt で行き先 →
//  離した所で performTreeMove(動かすもの, 行き先)（履歴 1 件）。長押しして動かさずに離したときは何もしない。
// ★閉じたフォルダの上でしばらく止めたら開く（openFolderForDrop）のは画面の側（時計を持つ）。
import { layerDisplayRows, dropTargetAt, topNodesOf, type DropTarget, type RowDropHit, type RowDropPlan, type LayerListRow } from "../../editor/layerTree";
import type { Project } from "../../editor/model";

/** コアの口（MobileEditor が protected の手続きを渡す・検査は本物のコアを受け継いだクラスで渡す） */
export interface RowDragOps {
  project(): Project;
  selected(): Iterable<string>;
  grab(id: string, kind: "layer" | "folder"): boolean;
  move(ids: string[], target: DropTarget): void;
}

export class RowDrag {
  /** 動かすもの（一番上の行だけ・一覧の並び） */
  readonly ids: string[];
  plan: RowDropPlan | null = null;
  moved = false;
  /** 掴んだときに選びが替わったか */
  readonly regrabbed: boolean;

  private constructor(ids: string[], regrabbed: boolean) {
    this.ids = ids;
    this.regrabbed = regrabbed;
  }

  /** 長押しになった（掴む） */
  static begin(ops: RowDragOps, id: string, kind: "layer" | "folder"): RowDrag {
    const regrabbed = ops.grab(id, kind);
    const p = ops.project();
    const order = layerDisplayRows(p).map((r) => r.id);
    const ids = topNodesOf(p, [...ops.selected()]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return new RowDrag(ids, regrabbed);
  }

  /** 指が動いた（指の下の行と位置 → 行き先） */
  over(ops: RowDragOps, rows: readonly LayerListRow[], hit: RowDropHit | null): RowDropPlan | null {
    this.moved = true;
    this.plan = dropTargetAt(ops.project(), rows, hit, this.ids);
    return this.plan;
  }

  /** 離した（取り上げられたら何もしない・動かさずに離したら何もしない）。動かしたら true */
  drop(ops: RowDragOps, cancelled: boolean): boolean {
    if (cancelled || !this.moved || !this.plan || this.ids.length === 0) return false;
    ops.move(this.ids, this.plan.target);
    return true;
  }
}

// ---------------- ★V227 (R・UI §5-5・REQ_layer_panel.md §9): 段の見せ方 ----------------

/** 1 段ぶんのずらし（px） */
export const ROW_INDENT = 18;
/** ずらす上限の段（4 段より深い行は 4 段と同じ所に置く＝パネルの幅 300 でも名前の幅を残す。3 段の入れ子は見分けられる） */
export const ROW_INDENT_MAX_DEPTH = 4;
/** 行の箱を右へずらす量（箱の左端が親より下がって見える。箱の右端は揃える＝幅が縮む）。中の余白と並びはどの段も同じ */
export function rowIndent(depth: number): number {
  return ROW_INDENT * Math.max(0, Math.min(Math.floor(depth), ROW_INDENT_MAX_DEPTH));
}

/** 行の左の空いた所（ずらした分）を押したか: 押した所が、その行の縦の範囲の中で、箱の左端より左なら、その行を返す */
export function gapRowAt(rows: readonly { idx: number; left: number; top: number; bottom: number }[], x: number, y: number): number | null {
  for (const r of rows) if (y >= r.top && y < r.bottom) return x < r.left ? r.idx : null;
  return null;
}
