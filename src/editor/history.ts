// Undo/Redo（M3）: クロージャベースのコマンド履歴。
// レイヤーバッファ変更は before/after のスナップショット（76.8KB=8bit / 最大153.6KB=16bit）で保持する。
// 幅不変条件: indexBits は昇格で増える方向にしか変わらないため、`live.set(before)` は
// 常に「同幅コピー」か「8bit→16bit の widening（値保存）」のどちらか。narrowing は発生しない。

import type { IndexBuf } from "./model";

export interface HistoryEntry {
  label: string;
  undo(): void;
  redo(): void;
}

const MAX_ENTRIES = 64;

export class History {
  private stack: HistoryEntry[] = [];
  private pos = 0; // stack[pos-1] が「実行済みの最後」
  onchange: (() => void) | null = null;
  /** M10-23: 変更カウンタ（push/undo/redo/clear で増える）。
   *  オートセーブの分割エンコード中に履歴経由の変更が起きたことを、
   *  dirty フラグとは独立に検出するための番人（スナップショット一貫性の保険） */
  mutations = 0;

  push(entry: HistoryEntry) {
    this.stack.length = this.pos;
    this.stack.push(entry);
    if (this.stack.length > MAX_ENTRIES) this.stack.shift();
    this.pos = this.stack.length;
    this.mutations++;
    this.onchange?.();
  }

  get canUndo() {
    return this.pos > 0;
  }
  get canRedo() {
    return this.pos < this.stack.length;
  }

  undo() {
    if (!this.canUndo) return;
    this.pos--;
    this.stack[this.pos].undo();
    this.mutations++;
    this.onchange?.();
  }

  redo() {
    if (!this.canRedo) return;
    this.stack[this.pos].redo();
    this.pos++;
    this.mutations++;
    this.onchange?.();
  }

  clear() {
    this.stack = [];
    this.pos = 0;
    this.mutations++;
    this.onchange?.();
  }
}

/**
 * レイヤーバッファ書き換えの履歴エントリを作る（before は呼び出し前に取得しておく）。
 * バッファ実体はレイヤー構造の undo/redo で再生成されることがあるため、
 * 参照を閉じ込めず `resolve` で適用時に解決する（stale 参照対策・Codexレビュー指摘）。
 */
export function bufferChangeEntry(
  label: string,
  resolve: () => IndexBuf | null,
  before: IndexBuf,
  after: IndexBuf,
  onApply?: () => void
): HistoryEntry {
  return {
    label,
    undo() {
      resolve()?.set(before);
      onApply?.();
    },
    redo() {
      resolve()?.set(after);
      onApply?.();
    },
  };
}

/**
 * M10-2a: 複数レイヤーのバッファをまとめて書き換える履歴エントリ。
 *
 * 歪みは1ストロークで全レイヤーを書き換えるので、bufferChangeEntry をレイヤー数ぶん
 * 積むと Undo が枚数ぶん必要になってしまう。ストローク1回＝履歴1エントリにするための型。
 *
 * 実体は `resolve(layerId)` で**適用時に**解決する（構造 undo/redo でバッファが
 * 再生成されても正しい実体へ書き戻すため。bufferChangeEntry と同じ理由）。
 *
 * before/after には**変化のあったレイヤーだけ**を入れること（メモリ節約）。
 */
export function multiBufferChangeEntry(
  label: string,
  resolve: (layerId: string) => IndexBuf | null,
  before: Record<string, IndexBuf>,
  after: Record<string, IndexBuf>,
  onApply?: () => void
): HistoryEntry {
  return {
    label,
    undo() {
      for (const id of Object.keys(before)) resolve(id)?.set(before[id]);
      onApply?.();
    },
    redo() {
      for (const id of Object.keys(after)) resolve(id)?.set(after[id]);
      onApply?.();
    },
  };
}
