// Undo/Redo（M3）: クロージャベースのコマンド履歴。
// レイヤーバッファ変更は before/after のスナップショット（76.8KB=8bit / 最大153.6KB=16bit）で保持する。
// 幅不変条件: indexBits は昇格で増える方向にしか変わらないため、`live.set(before)` は
// 常に「同幅コピー」か「8bit→16bit の widening（値保存）」のどちらか。narrowing は発生しない。

import type { IndexBuf, Frame } from "./model";

/** ★V195 (A-99): 履歴のエントリが抱えている「色の番号」の在りか。
 *
 *  上の色の帯から色を消すとき、**取り消し・やり直しで作品へ戻ってくる絵**がその色を指していたら消さない
 *  （消した色の番号を指す画素が Ctrl+Z で出てくると、その画素は色を失う）。`undo` / `redo` はクロージャなので
 *  中身を外から辿れない——`bytes` と同じく**作った側が申告する**（`bufferChangeEntry` / `multiBufferChangeEntry` は自動）。
 *
 *  - `bufs`   … 画素の索引バッファ（before / after の写しなど）。**選択マスクは入れない**（0/1 なので色 1 と区別できない）
 *  - `frames` … コマ（紙の色・起きているレイヤー・眠っている控えを全部見る）。挿入・削除したコマなど
 *  - `papers` … 紙の色の番号（紙色の変更・複写・ページ貼り付けの前後）
 *
 *  ⚠ 画素を抱えているのに申告の無いエントリ（`bytes` 等の合計が 1 画面ぶん以上）は「どの色を抱えているか
 *  分からない」として、そのエントリが履歴にある間は**どの色も消さない**（網・`colorRefsUnknown`）。
 *  色を 1 つも抱えないエントリ（メタデータ・選択マスク・音だけ）は `NO_COLOR_REFS` を申告する。 */
export interface HistoryColorRefs {
  bufs?: readonly (IndexBuf | null | undefined)[];
  frames?: readonly Frame[];
  papers?: readonly number[];
}

/** V195 (A-99): 色の番号を 1 つも抱えていないエントリの申告（メタデータ・選択マスク・音だけ） */
export const NO_COLOR_REFS = (): HistoryColorRefs => ({});

/** V195 (A-99): 網。画素を抱えているはずなのに `colorRefs` を申告していないエントリか。
 *  申告の量（`bytes` / `bytesIfUndone` / `bytesIfApplied` の合計）が 1 画面ぶん（8bit で 76,800 B）以上なら
 *  画素を抱えている見込み＝どの色を持っているか分からない。小さい申告（ロックの 64 B 等）は画素ではない */
export function colorRefsUnknown(e: HistoryEntry): boolean {
  if (e.colorRefs) return false;
  const n = (e.bytes ?? 0) + (e.bytesIfUndone ?? 0) + (e.bytesIfApplied ?? 0);
  return n >= COLOR_NET_BYTES;
}
/** 網のしきい値＝8bit の 1 面（320×240） */
const COLOR_NET_BYTES = 320 * 240;

export interface HistoryEntry {
  label: string;
  /** V154（要件 §2-b ②）: このエントリが抱えているバイト数。
   *
   *  `undo` / `redo` は**クロージャ**なので、抱えているバッファを外から辿る手段が無い。
   *  「元に戻す ◯◯ MB」の行を作るには、**作った側が申告する**しかない
   *  （`bufferChangeEntry` / `multiBufferChangeEntry` は自動で入る。手組みのエントリは
   *   `entryBytes()` で数えて渡す）。
   *
   *  ここに入れるのは**どちらの状態でも履歴が抱えているもの**＝before/after のスナップショット。
   *  「適用済みのときだけ」「取り消し済みのときだけ」抱えるものは下の2つを使う。 */
  bytes?: number;
  /** **取り消し済み（undo した状態）のときだけ**履歴が抱える量。
   *  例: コマ追加・ページ挿入・連番挿入・ゆらゆら・SE追加。
   *  適用済みならその実体は**プロジェクト側**にあるので `projectBytes` が数える＝ここでは数えない
   *  （両方で数えると二重になる。Codex レビュー指摘: 申告しないと **undo 後に減ったように見える**） */
  bytesIfUndone?: number;
  /** **適用済み（redo した状態）のときだけ**履歴が抱える量。
   *  例: コマ削除・SE削除。取り消すと実体はプロジェクトへ戻るので、そのときは数えない。 */
  bytesIfApplied?: number;
  undo(): void;
  redo(): void;
  /** V156 (P-1): `undo` / `redo` を走らせる**前に**済ませておくこと。
   *
   *  全コマの画素を触るエントリ（レイヤー削除・統合・全コマへ貼り付け・📌 ON/OFF・
   *  フォルダごと削除）は、眠っているコマを起こしてからでないと
   *  `f.layers[id] ?? allocIndexBuf(p)` が**空バッファに差し替わって絵を消す**。
   *  `undo`/`redo` は同期なので待てない——そこで「待つのは呼び出し側」に分けた。
   *  `History` 自身は同期のまま（`undo()`/`redo()` の契約は変えていない）。 */
  prepare?: () => Promise<void>;
  /** ★V195 (A-99): このエントリが抱えている色の番号の在りか（上の `HistoryColorRefs`）。
   *  取り消し済み・適用済みのどちらの状態でも、抱えているものを全部返す（作品側にあるものも返してよい） */
  colorRefs?: () => HistoryColorRefs;
}

/** V156 (P-2 / A-32 段1): 64 → **200**。
 *
 *  件数だけで打ち切っていた頃の 64 は「大きい作品でメモリを使い切らないため」の保険だったが、
 *  V154 でバイト予算（`budgetBytes`）が入ったので、**重さは予算が見る**。件数はもう
 *  「軽い操作をどれだけ遡れるか」だけを決める数字なので、素直に増やしてよい。
 *  ペン1手は 153,600 B（8bit）なので 200 手＝29.3 MiB、16bit でも 58.6 MiB。
 *  予算の下限（64 MiB）でどちらも収まる。 */
const MAX_ENTRIES = 200;

/** V154: 履歴エントリが抱えるバイト数を数える小道具。
 *
 *  `IndexBuf` 単体・配列・`Record<string, IndexBuf>`・それらを含むオブジェクト
 *  （コマの `{ layers: {...} }` など）を混ぜて渡せる。**同じ実体は1回だけ**数える
 *  （📌 全コマ共通レイヤーのように、同じバッファを複数の場所から参照している場合の二重計上を防ぐ）。 */
export function entryBytes(...parts: unknown[]): number {
  const seen = new Set<object>();
  let total = 0;
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 4) return;
    if (ArrayBuffer.isView(v)) {
      if (seen.has(v)) return;
      seen.add(v);
      total += (v as ArrayBufferView).byteLength;
      return;
    }
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  for (const p of parts) walk(p, 0);
  return total;
}

export class History {
  private stack: HistoryEntry[] = [];
  private pos = 0; // stack[pos-1] が「実行済みの最後」
  onchange: (() => void) | null = null;
  /** M10-23: 変更カウンタ（push/undo/redo/clear で増える）。
   *  オートセーブの分割エンコード中に履歴経由の変更が起きたことを、
   *  dirty フラグとは独立に検出するための番人（スナップショット一貫性の保険） */
  mutations = 0;
  /** V154 (W-4): バイト予算。**作品の大きさに連動**させて外から入れる
   *  （A-32 / V155 L-5 の「一律 256 MiB」は、大型作品では本体＋履歴で 563 MiB になり
   *   **今回の事故を起こしやすくする**方向の仕様だった＝訂正）。
   *  0 以下なら件数（`MAX_ENTRIES`）だけで打ち切る従来どおりの動き。 */
  budgetBytes = 0;

  /** V154: いま履歴が抱えている合計バイト数。
   *  `stack[i]` は **i < pos なら適用済み・i >= pos なら取り消し済み**なので、
   *  状態によって持ち主が変わる実体（挿入したコマ・削除したコマ）を取り違えずに数えられる。 */
  totalBytes(): number {
    let n = 0;
    for (let i = 0; i < this.stack.length; i++) {
      const e = this.stack[i];
      n += e.bytes ?? 0;
      n += i < this.pos ? (e.bytesIfApplied ?? 0) : (e.bytesIfUndone ?? 0);
    }
    return n;
  }

  /** V154: 予算オーバーぶんを**古いほうから**捨てる。
   *  **最低1件は残す**（1エントリだけで予算を超える大型作品でも「直前の操作は戻せる」を守る）。 */
  private trimToBudget() {
    if (this.budgetBytes <= 0) return;
    while (this.stack.length > 1 && this.totalBytes() > this.budgetBytes) {
      this.stack.shift();
      if (this.pos > 0) this.pos--;
    }
  }

  push(entry: HistoryEntry) {
    this.stack.length = this.pos;
    this.stack.push(entry);
    if (this.stack.length > MAX_ENTRIES) this.stack.shift();
    this.pos = this.stack.length;
    this.trimToBudget(); // V154 (W-4): 大型作品では戻せる回数が自動で減る
    this.mutations++;
    this.onchange?.();
  }

  get canUndo() {
    return this.pos > 0;
  }
  get canRedo() {
    return this.pos < this.stack.length;
  }

  /** V156 (P-2): **いま何手戻れるか。**
   *  200 手と言いながら、大きい作品では予算で自動的に減る。減った結果を
   *  メーターに出すために、外から読めるようにする（数えるだけ・状態は変えない）。 */
  get undoDepth(): number {
    return this.pos;
  }

  /** ★V195 (A-99): いま抱えているエントリ全部（取り消し済みも含む・読むだけ）。
   *  色の帯から色を消す前に「取り消し・やり直しで戻ってくる絵」を調べるのに使う */
  entriesForScan(): readonly HistoryEntry[] {
    return this.stack;
  }

  /** V156: 次に `undo()` が動かすエントリ（`prepare` を先に走らせるため）。 */
  peekUndo(): HistoryEntry | null {
    return this.canUndo ? this.stack[this.pos - 1] : null;
  }

  /** V156: 次に `redo()` が動かすエントリ。 */
  peekRedo(): HistoryEntry | null {
    return this.canRedo ? this.stack[this.pos] : null;
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
    bytes: entryBytes(before, after), // V154: 抱えている量を自動で申告
    colorRefs: () => ({ bufs: [before, after] }), // V195 (A-99): 抱えている画素も自動で申告
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
    bytes: entryBytes(before, after), // V154: 同じ実体を2回数えない（📌 共通レイヤー対策）
    colorRefs: () => ({ bufs: [...Object.values(before), ...Object.values(after)] }), // V195 (A-99)
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
