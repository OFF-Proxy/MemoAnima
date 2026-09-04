// V159 (G-1): 性能ログ。**「重い」の正体を、推測ではなく数字で掴むための1か所**。
//
// ★なぜ要るか
//   作者から「重いファイルで操作が重いまま」と報告が来ているが、**どこが重いのか分からない**。
//   疑わしい大物（フィルムの全サムネ・操作ごとの作り直し・合成が UI と同列）はどれも推測で、
//   推測で直しに行くと「直したのに変わらない」を繰り返す。
//   だから**先に測る版を出し、作者が普段の作業で取ったログ**から次の狙いを決める。
//
// ★守っている線（W-10・要件の壊すなリスト）
//   **作品名・フォルダのパス・作品の中身は1文字も書かない。**書くのは
//   「決められた操作名」と「数値」だけ。操作名は下の `PerfOp` に**列挙した文字列しか使えない**
//   ——呼ぶ側が好きな文字列を渡せる作りにすると、いつか作品名が混ざる。
//   （この形を `scripts/v159_smoke.ts` が機械で見張っている）
//
// ★計測自体を重くしない
//   - `performance.now()` 2回と、配列に1行 push するだけ。
//   - **50ms 未満は書かない**（ログを膨らませない・既定のしきい値は下の定数）。
//   - ログの書き出し（IPC）は**まとめて1秒に1回**。1操作ごとに invoke すると、
//     測るために遅くする本末転倒になる。
//   - 描画ループの中では呼ばない（「描き始め」は1ストロークに1回だけ測る）。

/** 記録してよい操作名。**ここに無い文字列は書けない**（W-10 の線を型で守る）。 */
export type PerfOp =
  // 開く・保存
  | "open.project" // ライブラリ → エディタ（.memoanima）
  | "open.note" // ライブラリ → エディタ（.kwz / .ppm）
  | "open.preview" // ライブラリで選んだときのプレビュー読み込み
  | "save"
  // コマ
  | "frame.goto"
  | "frame.add"
  | "frame.del"
  | "frame.reorder"
  // ★V166 (層2): 重い操作は**待たせる対象と数える対象を同じ一覧**にする。
  //  ここに無い操作は `runHeavy` を通せない＝漏斗の外に置けない（型で縛る）。
  //  ⚠ 要件 §1 の表のうち、**ここに無い2つ**は意図して外してある（報告書に理由あり）:
  //   ・「コマでずらす」＝トグル1つ。画素も確保も動かない（漏斗に入れると
  //     チェックボックスにロックが掛かるだけで、守るものが無い）
  //   ・眠らせ（sweep）＝**描きながら裏で進む**のが設計。入口を閉じたら描けなくなる。
  //     多重起動を防ぐ入口は `this.sweeping` が元から持っている
  | "frame.copy"
  | "frame.paste"
  | "frame.addMany"
  | "frame.wobble"
  // レイヤー
  | "layer.add"
  | "layer.del"
  | "layer.move"
  | "layer.lock"
  | "layer.merge"
  | "layer.allFrames"
  // 変形・歪み
  | "xform.commit"
  | "warp.commit"
  // 画像
  | "image.frames"
  // そのほかの「待つ可能性のある処理」
  //  ⚠ V168: "export.wake"（V163 の書き出し前の全コマ起こし）は**消した**。
  //   全コマを一度に起こすのは論理サイズを丸ごと生で展開する見積りなしの確保で、
  //   書き出しは1コマずつ読むので不要（frameSource.ts が読む直前に起こす）
  | "play.start"
  | "draw.first" // pointerdown → 最初の描画
  | "tool.switch"
  | "film.rebuild"
  | "layers.rebuild"
  | "meter.update";

/** これ未満は書かない（要件 G-1）。利用者が「待った」と感じない時間はログの邪魔にしかならない。 */
export const PERF_MIN_MS = 50;

/** メインスレッドがこれ以上ふさがったら「長タスク」として1行（要件 G-1）。 */
export const PERF_LONG_MS = 100;

/** 溜めた行を流す間隔。 */
const FLUSH_MS = 1000;

/** 一度に溜めておく上限（流せない状況が続いても青天井にしない）。 */
const MAX_PENDING = 200;

/** 作品の大きさ。**数値だけ**（名前も紙の色も入らない）。 */
export interface PerfCtx {
  /** コマ数 */
  f: number;
  /** レイヤー数（layerDefs） */
  l: number;
  /** 面数（レイヤー×コマ。アプリが画面で使っているのと同じ言葉） */
  s: number;
}

type Sink = (text: string) => void;

let sink: Sink | null = null;
let ctxProvider: (() => PerfCtx | null) | null = null;
let busyProbe: (() => boolean) | null = null;
let pending: string[] = [];
let flushTimer: number | null = null;
let observing = false;

/** 直前に測り終えた区間。長タスクが「何をしている間に起きたか」を言うために覚えておく。 */
let lastSpan: { op: PerfOp; t0: number; t1: number } | null = null;

/** ログの流し先を1つ登録する（`main.ts` が `append_log` へ橋渡しする）。 */
export function setPerfSink(fn: Sink | null): void {
  sink = fn;
}

/** 作品の大きさを教える口（エディタが登録）。**重い計算をここでしないこと**——
 *  ログの行ごとに呼ばれるので、呼ばれた側は覚えている値を返すだけにする。 */
export function setPerfContext(fn: (() => PerfCtx | null) | null): void {
  ctxProvider = fn;
}

/** 「いま読み込み中の表示が出ているか」を教える口（`ui/busy.ts` が登録）。
 *  長タスクなのに表示が無い＝**利用者には固まって見えている**ので、そこを狙って探せるようにする。 */
export function setBusyProbe(fn: (() => boolean) | null): void {
  busyProbe = fn;
}

/** 計測の開始点。`performance.now()` そのもの（名前を付けて意図を読めるようにしているだけ）。 */
export function perfNow(): number {
  return performance.now();
}

/** W-10 の最後の網: 文脈の値は**必ず数値になる**ことを、書く直前にもう一度確かめる。
 *  型では「数値」と言ってあるが、型は実行時には効かない——ここを通さずに文字列が入ると、
 *  いつか作品名がログに出る。数値でないものは 0 にする（記録が1つ雑になるだけで、線は破られない）。 */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

function push(line: string): void {
  if (!sink) return;
  if (pending.length >= MAX_PENDING) return; // 溢れたら捨てる（測るために詰まらせない）
  pending.push(line);
  if (flushTimer !== null) return;
  // `window.setTimeout` ではなく素の `setTimeout`——スモークは Node で走るので、
  // `window` を前提にすると**検査だけが落ちる**（アプリでは同じもの）
  flushTimer = setTimeout(flush, FLUSH_MS) as unknown as number;
}

/** 溜まった行をまとめて1回だけ流す。 */
export function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.length || !sink) {
    pending = [];
    return;
  }
  const lines = pending;
  pending = [];
  sink(lines.join("\n"));
}

/** 1区間ぶんの記録。`t0` は `perfNow()` の戻り値。
 *
 *  **50ms 未満なら1文字も書かない。**返り値は所要ms（呼び出し側が使いたいときのため）。 */
export function perfDone(op: PerfOp, t0: number): number {
  const t1 = perfNow();
  const ms = t1 - t0;
  lastSpan = { op, t0, t1 };
  if (ms < PERF_MIN_MS) return ms;
  const c = ctxProvider?.() ?? null;
  push(`[perf] ${op} ms=${Math.round(ms)}` + (c ? ` f=${num(c.f)} l=${num(c.l)} s=${num(c.s)}` : ""));
  return ms;
}

/** 同期の処理をそのまま測る（早期 return がある長いメソッドでは `perfNow`＋`perfDone` を直に使う）。 */
export function perfSync<T>(op: PerfOp, fn: () => T): T {
  const t0 = perfNow();
  try {
    return fn();
  } finally {
    perfDone(op, t0);
  }
}

/** 非同期の処理をそのまま測る。**失敗しても測る**（「失敗するまでに何秒待たされたか」も知りたい）。 */
export async function perfAsync<T>(op: PerfOp, fn: () => Promise<T>): Promise<T> {
  const t0 = perfNow();
  try {
    return await fn();
  } finally {
    perfDone(op, t0);
  }
}

/** 長タスクの見張りを始める（1回だけ）。
 *
 *  `PerformanceObserver` の longtask は**メインスレッドが 50ms 以上ふさがった**ことを教えてくれる。
 *  そのうち `PERF_LONG_MS` 以上のものだけを、**そのとき何をしていたか**と
 *  **読み込み中の表示が出ていたか**を添えて1行にする。
 *  `busy=no` の長タスクは、利用者からは**ただ固まって見えている**区間＝次に塞ぐ候補。
 *  （要件 G-3 の「ほかの空白区間はログがあぶり出す」がこれ） */
export function startLongTaskWatch(): void {
  if (observing) return;
  observing = true;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < PERF_LONG_MS) continue;
        // 直前に測り終えた区間と時間が重なっていれば、その操作の最中だったと言える
        const s = lastSpan;
        const during =
          s && e.startTime < s.t1 && e.startTime + e.duration > s.t0 ? s.op : "-";
        push(
          `[perf] long ms=${Math.round(e.duration)} during=${during} busy=${
            busyProbe?.() ? "yes" : "no"
          }`
        );
      }
    });
    po.observe({ type: "longtask", buffered: false });
  } catch {
    // longtask を知らない環境（古い WebView・テスト）では、ただ長タスクの行が出ないだけ
    observing = false;
  }
}

/** テスト用: 溜まっている行を覗く／捨てる。 */
export function _pendingForTest(): string[] {
  return pending.slice();
}
export function _resetForTest(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  pending = [];
  lastSpan = null;
  sink = null;
  ctxProvider = null;
  busyProbe = null;
  observing = false;
}
