// V159 (G-3): **長くかかりうる処理の共通入口**。
//
// 作者の要望は「全ての箇所で、長い読み込みが入るときは読み込み中の表示を出してほしい」。
// これを**箇所ごとに塞ぐ**と必ず数え漏れる（実際 V155 でエディタ側だけ塞いだ結果、
// **ライブラリでメモを選んだときの読み込み**が空白のまま残り、「固まって見える」の正体になっていた）。
//
// ★ §1-g の3層で守る
//   1. **漏斗**: 長い処理は `runWithBusy()` を通す。表示・遅延・後片付け・計測がここに1つだけある
//   2. **明示**: 漏斗を通せない特殊経路（保存中のロックを持つエディタ側）は、これまでどおり
//      `editor.ts` の `beginBusy`/`showBusyAfterDelay` を使う（あちらは操作ロックも兼ねているため）
//   3. **網**: 漏れても「気づけない」で終わらせない。`perf.ts` の長タスク行が
//      **`busy=no`** を付けて記録するので、塞ぎ忘れた区間はログに現れる
//      ＝壊れ方が「利用者には固まって見えるだけ」から「1行残る」に変わる
//
// **以後、長くかかりうる処理を足すときは必ず `runWithBusy()` を通すこと。**
import { perfDone, perfNow, setBusyProbe, type PerfOp } from "../perf";

/** 「◯◯中です」を出して、畳む関数を返すもの（`main.ts` の `busyOverlay`）。 */
export type BusyImpl = (msg: string) => () => void;

/** 出すまでの待ち時間。**一瞬で終わる処理でチラつかせない**ための遅延。
 *  W-8 が 450ms で定着しているので、同じ値を使う（見え方を変えない）。 */
export const BUSY_DELAY_MS = 450;

let impl: BusyImpl | null = null;
/** いま走っている長い処理の数。**箱は1枚だけ**（入れ子でも、重なっても）。 */
let depth = 0;
let timer: number | null = null;
let hide: (() => void) | null = null;

export function setBusyImpl(fn: BusyImpl | null): void {
  impl = fn;
  // 長タスクの行に「表示が出ていたか」を書けるようにする（3層目の網）
  setBusyProbe(() => hide !== null);
}

/** いま中央表示が出ているか。 */
export function busyVisible(): boolean {
  return hide !== null;
}

/** **長くかかりうる処理はこれを通す。**
 *
 *  - `BUSY_DELAY_MS` だけ待ってから中央表示を出す（一瞬で終わればそもそも出ない）
 *  - どの抜け方（成功・失敗・例外）でも必ず畳む
 *  - 所要時間を `perf.ts` へ記録する（50ms 未満は書かれない）
 *
 *  `op` は `PerfOp` の列挙から選ぶ＝ログに好きな文字列を書けない（W-10 の線）。 */
export async function runWithBusy<T>(
  op: PerfOp,
  msg: string,
  fn: () => Promise<T>
): Promise<T> {
  const t0 = perfNow();
  // ★V159（Codex 指摘①）: **「最初に始めた人」ではなく「1つでも走っているか」で決める。**
  //  以前は最初の呼び出しだけが箱の持ち主で、その人が終わると畳んでいた。
  //  棚のメモ A をクリックしてすぐ B をクリックすると、A が終わった時点で箱が消え、
  //  **まだ読み込んでいる B のあいだ画面が無表示に戻る**（＝直そうとした症状がそのまま出る）。
  //  いまは走っている数（depth）が 0 になったときだけ畳む。
  depth++;
  if (depth === 1 && impl && timer === null && hide === null) {
    // 素の `setTimeout`（`window.` を付けない）。理由は `perf.ts` の同じ箇所と同じ
    timer = setTimeout(() => {
      timer = null;
      if (depth > 0 && impl) hide = impl(msg);
    }, BUSY_DELAY_MS) as unknown as number;
  }
  try {
    return await fn();
  } finally {
    depth--;
    if (depth === 0) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      hide?.();
      hide = null;
    }
    perfDone(op, t0);
  }
}

/** テスト用。 */
export function _resetForTest(): void {
  impl = null;
  depth = 0;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  hide = null;
}
