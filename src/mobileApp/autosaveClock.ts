// V211 (M-1b・要件 §6-4・D-M1-2 の暫定): モバイルのオートセーブを**いつ**書くか（書くこと自体は MobileWorkSession の列）。
//
// きっかけ:
//  - 15 秒ごと（PC と同じ）
//  - 線を引き終えて手が止まったとき（2 秒。前に書いてから 5 秒は空ける）
//  - 裏に回る知らせ: 描きかけの線をそこで確定し、書いている途中のオートセーブがあれば終わるのを待ち、そのあとも変わっていればもう 1 回書く。
//    ★この知らせには 2 秒・5 秒・PC の 3 秒の間引きを当てない
// 普段は、線を引いている途中・変形の途中（busy）は書かない（裏に回るときは先に線を確定するので書ける）。
// 変わっていない（最後に書けたときから編集が無い）ときは書かない。

export const AUTOSAVE_INTERVAL_MS = 15_000;
export const AUTOSAVE_IDLE_MS = 2_000;
export const AUTOSAVE_GAP_MS = 5_000;

export type ClockWriteResult = "written" | "aborted" | "stale" | "bad" | "skipped";

export interface AutosaveClockDeps {
  /** 線を引いている途中・変形の途中 */
  busy: () => boolean;
  /** 描きかけの線をそこで確定する（裏に回るとき） */
  finishStroke: () => void;
  /** 書く（セッションの列に並べる）。書けたら "written" */
  write: (reason: string) => Promise<ClockWriteResult>;
  now?: () => number;
  /** 書き始めた・書き終えた（記録用） */
  onEvent?: (ev: "begin" | "end", reason: string, result?: ClockWriteResult) => void;
}

export class AutosaveClock {
  private readonly d: AutosaveClockDeps;
  /** 編集の回数（書き始めたときの値を控え、書けたらそこまでを「書いた」とする） */
  private epoch = 0;
  private writtenEpoch = 0;
  private lastWriteAt = -Infinity;
  private inflight: Promise<ClockWriteResult> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  /** 最後に書けた時刻（画面に出す） */
  lastWrittenAt: number | null = null;
  /** 閉じた（保存しないで戻る・作品を閉じる）。以後は何も書かない（消したオートセーブを戻さない＝第三者レビュー M1） */
  private closed = false;
  /** 保存の便（終わるまで書かない。終わったら、まだ変わっていれば書く＝保存のあとに古い写しを残さない＝第三者レビュー M2） */
  private hold: Promise<unknown> | null = null;
  /** 線を引いている途中で 15 秒の便を飛ばした（次に線を引き終えたら、2 秒を待たずに書く＝第三者レビュー L3） */
  private owed = false;

  constructor(d: AutosaveClockDeps) {
    this.d = d;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    this.stop();
    this.closed = false;
    this.intervalTimer = setInterval(() => void this.tryWrite("interval", false), AUTOSAVE_INTERVAL_MS);
  }

  stop(): void {
    this.closed = true;
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.intervalTimer = null;
    this.idleTimer = null;
  }

  /** 編集があった */
  noteEdit(): void {
    this.epoch++;
  }

  /** 書いていない編集があるか */
  pending(): boolean {
    return this.epoch !== this.writtenEpoch;
  }

  /** 線を引き終えた（手が止まって 2 秒・前に書いてから 5 秒） */
  strokeEnded(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const wait = this.owed ? 0 : AUTOSAVE_IDLE_MS;
    const at = Math.max(this.now() + wait, this.lastWriteAt + AUTOSAVE_GAP_MS);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.tryWrite("idle", false);
    }, Math.max(0, at - this.now()));
  }

  /** ★裏に回った: 線を確定 → 書いている途中なら待つ → まだ変わっていればもう 1 回（間引きを当てない） */
  async suspend(): Promise<ClockWriteResult> {
    this.d.finishStroke();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.inflight) await this.inflight.catch(() => "bad" as const);
    if (!this.pending()) return "skipped";
    return this.tryWrite("suspend", true);
  }

  /** 閉じる（オートセーブは残す）前: 書いていない編集を書き切る。書き切れたら true（閉じてよい）・書けなかったら false（閉じない＝V211b F1） */
  async flushForClose(): Promise<boolean> {
    if (this.pending()) await this.suspend();
    return !this.pending();
  }

  /** 書く（busy・変わっていない・書いている途中なら書かない。force は裏に回るとき＝busy を見ない） */
  private async tryWrite(reason: string, force: boolean): Promise<ClockWriteResult> {
    if (this.closed) return "skipped";
    if (!this.pending()) return "skipped";
    if (!force && this.d.busy()) {
      if (reason === "interval") this.owed = true;
      return "skipped";
    }
    // 保存の便が終わるまで待つ（保存がこのセッションのオートセーブを消したあとに、古い写しを書き戻さない）
    while (this.hold) {
      const h = this.hold;
      await h.catch(() => undefined);
      if (this.hold === h) this.hold = null;
    }
    if (this.closed || !this.pending()) return "skipped";
    if (this.inflight) {
      if (!force) return "skipped";
      await this.inflight.catch(() => "bad" as const);
      if (!this.pending()) return "skipped";
    }
    const e0 = this.epoch;
    this.owed = false;
    this.d.onEvent?.("begin", reason);
    const run = (async (): Promise<ClockWriteResult> => {
      try {
        const r = await this.d.write(reason);
        if (r === "written") {
          this.writtenEpoch = Math.max(this.writtenEpoch, e0);
          this.lastWriteAt = this.now();
          this.lastWrittenAt = this.lastWriteAt;
        }
        return r;
      } catch {
        return "bad";
      }
    })();
    this.inflight = run;
    const r = await run;
    if (this.inflight === run) this.inflight = null;
    this.d.onEvent?.("end", reason, r);
    return r;
  }

  /** 保存の便（終わるまでオートセーブを書かない。終わる前に settledAt を呼ぶ形の Promise を渡す） */
  holdUntil(p: Promise<unknown>): void {
    this.hold = p;
  }

  /** 保存が確定して、セッションがオートセーブを消した（ファイルが最新）: ここまでの編集は書かなくてよい */
  settledAt(epochAtSaveStart: number): void {
    this.writtenEpoch = Math.max(this.writtenEpoch, epochAtSaveStart);
  }

  /** いまの編集の回数（保存の前に控える） */
  currentEpoch(): number {
    return this.epoch;
  }
}
