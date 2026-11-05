// ★V209 (A-121・docs/REQ_playback_clock.md): アプリ内の再生の時計。
//
// エディタの ▶・ライブラリのプレビュー・音の窓の試し再生の 3 か所が、これを使う（ゆらゆらの見本は対象外）。
// 今までは `setInterval(…, 1000 / fps)` で 1 回に 1 コマずつ進めていた。ブラウザは間隔を整数のミリ秒に切り捨てる
// （12 fps の 83.333 → 83 ms・24 fps の 41.667 → 41 ms）ので、BGM（AudioContext の別の時計）よりだんだん先に進んでいた。
// ここでは **始めてからの経過時間からコマを求める**（コマ i を出すのは i/fps 以上 (i+1)/fps 未満の間＝書き出しと同じ時刻表）。
//
// - 音を鳴らす再生（BGM か SE がある）は **音の時計**で、聞こえている所（出力の遅れを 1 回だけ引いた所）からコマを決める。
//   BGM と SE はコマの時刻に予約する（`start(when, offset)`・少し先まで）。⏸ の位置は描き終わっている所（`currentTime`）。
// - 音を鳴らさない再生は `performance.now()`。
// - 描くのは `requestAnimationFrame` で、コマが変わったときだけ（遅れたらコマを飛ばす）。
// - 時計（音の時計・`performance.now()`・描く合図）は `playEnv` で差し替えられる（検査で手で進める）。
//
// 純関数（`periodOf`・`posAt`・`startTimeOf`・`heardTimeOf`）と、小さな駆動部（`PlayClock`）からなる。
// 画面の文言は無い（m1201 の KEYED_FILES には playStart.ts と同じ理由で入れてある＝足さないと検査が黙る）。
import type { SeTrack } from "./model";
import { getAudioCtx } from "./audio";

// ---------------- 純関数 ----------------

/** 再生の形。`songSec` は「曲の長さで書き出す」（animToAudio）で BGM があるときの曲の長さ L（トリム後÷rate・アニメの秒）。それ以外は null */
export interface PlayShape {
  fps: number;
  frameCount: number;
  loop: boolean;
  songSec: number | null;
}

/** 経過から求めた位置。`period` は何回目の繰り返しか（曲の長さの形は曲の何回目・ほかはアニメの何周目）、
 *  `lap` はその繰り返しの中でアニメが何周目か（曲の長さの形でだけ 1 以上になる） */
export interface PlayPos {
  frame: number;
  lap: number;
  period: number;
  ended: boolean;
}

const EPS = 1e-9;

function fpsOf(s: { fps: number }): number {
  return s.fps > 0 && isFinite(s.fps) ? s.fps : 8;
}
function countOf(s: { frameCount: number }): number {
  return Math.max(1, Math.floor(s.frameCount) || 1);
}

/** 繰り返しの単位の長さ（秒）。曲の長さの形は L、ほかは コマ数/fps（書き出しの時刻表と同じ） */
export function periodOf(s: PlayShape): number {
  if (s.songSec != null && s.songSec > 0 && isFinite(s.songSec)) return s.songSec;
  return countOf(s) / fpsOf(s);
}

/** 長さ P の繰り返しの中で、最後に始まるコマの通し番号（始まる時刻が P より前の最後の 1 つ） */
function lastGlobalFrame(P: number, fps: number): number {
  return Math.max(0, Math.ceil(P * fps - EPS) - 1);
}

/** 経過 t 秒（繰り返しの頭＝曲の頭から。負は 0）での位置。ループしない形で t が繰り返しの長さを越えたら、最後のコマで終わり */
export function posAt(s: PlayShape, t: number): PlayPos {
  const fps = fpsOf(s);
  const n = countOf(s);
  const P = periodOf(s);
  const gEnd = lastGlobalFrame(P, fps);
  let tt = isFinite(t) ? Math.max(0, t) : 0;
  let period = 0;
  if (tt >= P) {
    if (!s.loop) return { frame: gEnd % n, lap: Math.floor(gEnd / n), period: 0, ended: true };
    period = Math.floor(tt / P);
    tt -= period * P;
    if (tt >= P) {
      period++;
      tt -= P;
    }
    if (tt < 0) tt = 0;
  }
  const g = Math.min(gEnd, Math.floor(tt * fps + EPS));
  return { frame: g % n, lap: Math.floor(g / n), period, ended: false };
}

/** コマ frame（その繰り返しの中のアニメの lap 周目）が始まる時刻（繰り返しの頭から・秒） */
export function startTimeOf(s: { fps: number; frameCount: number }, frame: number, lap = 0): number {
  return (Math.max(0, lap) * countOf(s) + Math.max(0, frame)) / fpsOf(s);
}

// ---------------- 聞こえている所 ----------------

/** 出力の遅れの値（`baseLatency`・`outputLatency`）。数でなければ 0（Safari 18.4 より前は outputLatency が無い） */
function latencyNum(v: unknown): number {
  return typeof v === "number" && isFinite(v) && v >= 0 && v < 2 ? v : 0;
}

/** getOutputTimestamp の値が使えるかの閾値（報告に書く）。
 *  - performanceTime が今から MAX_TS_AGE_MS より離れていたら使わない
 *  - 聞こえている所が currentTime より MAX_AHEAD_SEC 以上後なら使わない（遅れは負にならない）
 *  - 聞こえている所が currentTime の MIN_RATIO 倍より小さければ使わない（WebKit の、サンプルレートで割られた値）
 *  - 遅れが MAX_LAT_SEC より大きければ使わない
 *  - 前の値からの進みが、performanceTime の進みと MAX_RATE_DEV より違えば、その ctx では以後使わない（進み方で見分ける） */
export const HEARD_LIMITS = {
  MAX_TS_AGE_MS: 500,
  MAX_AHEAD_SEC: 0.005,
  MIN_RATIO: 0.5,
  MAX_LAT_SEC: 1,
  MAX_RATE_DEV: 0.05,
  /** 進み方を比べるのは、前の値から performanceTime がこれだけ進んでから（短いと performanceTime の揺れで外れる） */
  RATE_WINDOW_MS: 1000,
  /** 進み方が続けてこの回数外れたら、その ctx では以後使わない */
  RATE_FAILS_TO_LATCH: 3,
  /** 比で見分けて「以後使わない」と決めるのは currentTime がこれより大きくなってから。まともな値でも currentTime が遅れの 2 倍より
   *  小さいうちは比が 0.5 を割る（作ったばかりの ctx）ので、それまではその 1 回だけ遅れの式に倒す（第三者レビューの指摘） */
  LATCH_MIN_CT: 2,
};

/** 1 つの ctx について覚えておくこと（壊れていると分かったか・前の値） */
interface HeardMemo {
  broken: boolean;
  prev: { est: number; perf: number } | null;
  /** 進み方が続けて外れた回数 */
  fails: number;
}
const heardMemo = new WeakMap<object, HeardMemo>();

/** 起点を取り直すとき（再生を始める・音の時計へ取り直す）に、進み方を比べる前の値を捨てる（止まっていた間の値と比べない）。
 *  「壊れている」と分かった印は残す */
export function resetHeardMemo(ctx: object): void {
  const m = heardMemo.get(ctx);
  if (m) {
    m.prev = null;
    m.fails = 0;
  }
}

/** いま聞こえている所（ctx の時計の秒）。getOutputTimestamp があってまともならそれ（performanceTime の時点の値を今まで進める）、
 *  無い・使えないときだけ currentTime −（baseLatency＋outputLatency）。**二重に引かない**。 */
export function heardTimeOf(ctx: AudioContext, perfNowMs: number): { t: number; src: "ts" | "latency" } {
  const ct = ctx.currentTime;
  const fallback = () => ({ t: ct - (latencyNum((ctx as { baseLatency?: unknown }).baseLatency) + latencyNum((ctx as { outputLatency?: unknown }).outputLatency)), src: "latency" as const });
  let memo = heardMemo.get(ctx);
  if (!memo) {
    memo = { broken: false, prev: null, fails: 0 };
    heardMemo.set(ctx, memo);
  }
  if (memo.broken) return fallback();
  const fn = (ctx as { getOutputTimestamp?: () => AudioTimestamp }).getOutputTimestamp;
  if (typeof fn !== "function") return fallback();
  let ts: AudioTimestamp | null = null;
  try {
    ts = fn.call(ctx);
  } catch {
    ts = null;
  }
  const c = ts?.contextTime;
  const p = ts?.performanceTime;
  if (typeof c !== "number" || typeof p !== "number" || !isFinite(c) || !isFinite(p) || c <= 0 || p <= 0) return fallback();
  if (Math.abs(perfNowMs - p) > HEARD_LIMITS.MAX_TS_AGE_MS) return fallback();
  const est = c + (perfNowMs - p) / 1000;
  const L = HEARD_LIMITS;
  // 使えない形はその 1 回だけ遅れの式に倒す
  if (est > ct + L.MAX_AHEAD_SEC) return fallback();
  if (ct - est > L.MAX_LAT_SEC) return fallback();
  if (est < ct * L.MIN_RATIO) {
    // サンプルレートで割った値（WebKit Bug 264247）。currentTime が十分進んでからなら、その ctx では以後使わない
    if (ct > L.LATCH_MIN_CT) memo.broken = true;
    return fallback();
  }
  // 進み方: performanceTime の進みに対して contextTime がどれだけ進んだか（続けて外れたら以後使わない）
  const prev = memo.prev;
  if (!prev) memo.prev = { est: c, perf: p };
  else if (p - prev.perf >= L.RATE_WINDOW_MS) {
    const ratio = (c - prev.est) / ((p - prev.perf) / 1000);
    memo.prev = { est: c, perf: p };
    if (!isFinite(ratio) || Math.abs(ratio - 1) > L.MAX_RATE_DEV) {
      if (++memo.fails >= L.RATE_FAILS_TO_LATCH) memo.broken = true;
      return fallback();
    }
    memo.fails = 0;
  }
  return { t: est, src: "ts" };
}

// ---------------- 駆動部 ----------------

/** 差し替えられる時計（検査で手で進める）。ctx は音を鳴らす再生でだけ読む（音の無い再生で AudioContext を作らない） */
export const playEnv = {
  now: (): number => performance.now(),
  raf: (cb: () => void): number => requestAnimationFrame(() => cb()),
  caf: (id: number): void => cancelAnimationFrame(id),
  ctx: (): AudioContext => getAudioCtx(),
};

/** 始める時刻をどれだけ先にするか（秒）。予約が間に合うだけの余裕（▶ を押してから絵が動き出すまでが目に見えて遅くならない範囲） */
export const PLAY_LEAD_SEC = 0.05;
/** どれだけ先まで予約するか（秒） */
export const PLAY_LOOKAHEAD_SEC = 0.25;
/** 音の時計が止まったとみなす長さ: performance.now() がこれだけ進んでも currentTime が進まない（ミリ秒） */
export const PLAY_STALL_MS = 500;

/** BGM の鳴らし方（その時点の値。試し再生はトリムを変えると次に頭から鳴らすときから効く＝毎回読む） */
export interface BgmPlan {
  buf: AudioBuffer;
  trimStart: number;
  trimEnd: number;
  rate: number;
  volume: number;
}

/** 呼び出し側（エディタ・ライブラリ・試し再生） */
export interface PlayHost {
  /** 今の形（毎回読む。fps かコマ数が変わったら reshape を呼ぶ） */
  shape(): { fps: number; frameCount: number; loop: boolean };
  /** コマが変わった（描く） */
  show(frame: number): void;
  /** ループしない作品が終わりに着いた（駆動部はもう止まっている。音の止めは予約済み） */
  ended(): void;
  /** fps かコマ数が変わった（駆動部はもう止まっている。今のコマから始め直す） */
  reshape(): void;
  /** コマ frame に鳴らす SE（デコード済み・ミュートでないもの） */
  seAt(frame: number): { buf: AudioBuffer; track: SeTrack }[];
  /** BGM（無い・ミュート・デコードできなければ null） */
  bgm(): BgmPlan | null;
}

/** 音を鳴らす所（AudioPreview が持つ） */
export interface PlaySink {
  scheduleBgm(ctx: AudioContext, plan: BgmPlan, when: number, offset: number, stopAt: number | null): void;
  stopBgm(): void;
  cancelBgmFrom(when: number): void;
  restopBgm(at: number | null): void;
  scheduleSe(ctx: AudioContext, buf: AudioBuffer, track: SeTrack | null, when: number, offset: number, cutAt: number | null): void;
  cancelSeFrom(when: number): void;
  recutSe(cutAt: number | null): void;
  pauseSe(): void;
  resumeSe(when?: number, ctx?: AudioContext): string[];
  stopSe(): void;
  discardPausedSe(): void;
}

/** 始め方 */
export interface PlayStart {
  /** 始める位置（繰り返しの頭から・秒） */
  t0: number;
  /** 「曲の長さで書き出す」で BGM がある形か（始めたときに決める・BGM がデコードできなければ偽） */
  songMode: boolean;
  /** 音を鳴らす再生か（BGM か SE がある） */
  wantAudio: boolean;
  /** ⏸ で畳んだ SE の続きを鳴らすか（エディタと試し再生の ⏸→▶） */
  resume: boolean;
}

/** ⏸ したときの位置（呼び出し側が覚えて、速さ・コマ数・コマが同じときだけ使う） */
export interface PlayPaused {
  t: number;
  frame: number;
  fps: number;
  frameCount: number;
}

export class PlayClock {
  private host: PlayHost;
  private sink: PlaySink;
  running = false;
  private rafId = 0;
  // 形（始めたときの写し。ループだけは途中で変わってよい）
  private fps = 8;
  private n = 1;
  private loop = false;
  private songSec: number | null = null;
  // 時計の起点: 再生の時刻 T = t0 + (いまの時計 − w0)。src が audio なら w0 は ctx の秒（聞こえている所の起点）
  private src: "audio" | "perf" = "perf";
  private ctx: AudioContext | null = null;
  private t0 = 0;
  private w0 = 0;
  /** 経過の基準（ループを外したときに今の繰り返しの頭へずらす。いつも P の整数倍） */
  private base = 0;
  private wantAudio = false;
  /** ここまで予約した（再生の時刻） */
  private schedT = 0;
  /** 予約したコマの出来事（繰り返しの通し番号:その中のコマの通し番号 → 時刻）。時刻の足し算の誤差で同じ出来事を 2 回・0 回にしない */
  private schedDone = new Map<string, number>();
  /** BGM を予約し終えた繰り返しの番号（base から） */
  private bgmThrough = -1;
  private lastFrame = -1;
  /** 始めたコマの SE のうち、続きから鳴らしたもの（頭から鳴らし直さない） */
  private skipIds: string[] = [];
  // 音の時計が止まったかを見る
  private lastCt = -1;
  private lastCtPerf = 0;
  /** 止まったと分かった ctx と、そのときの currentTime（その ctx がまた進むまで音の時計へ戻らない） */
  private stalled: { ctx: AudioContext; ct: number } | null = null;

  constructor(host: PlayHost, sink: PlaySink) {
    this.host = host;
    this.sink = sink;
  }

  /** 今の形 */
  shape(): PlayShape {
    return { fps: this.fps, frameCount: this.n, loop: this.loop, songSec: this.songSec };
  }

  /** 始める（音の用意は呼び出し側が待ってから。ctx は running のときだけ音の時計に乗る） */
  start(o: PlayStart): void {
    this.cancelRaf();
    const s = this.host.shape();
    this.fps = fpsOf(s);
    this.n = countOf(s);
    this.loop = !!s.loop;
    const plan = this.host.bgm();
    this.songSec = o.songMode && plan && plan.rate > 0 ? Math.max(0, plan.trimEnd - plan.trimStart) / plan.rate : null;
    if (this.songSec != null && !(this.songSec > 0)) this.songSec = null;
    this.wantAudio = o.wantAudio;
    const P = periodOf(this.shape());
    let t0 = Math.max(0, isFinite(o.t0) ? o.t0 : 0);
    if (this.bgmPeriod() !== Infinity && t0 >= P) t0 = this.loop ? t0 % P : Math.max(0, P - 1 / this.fps);
    this.base = 0;
    this.running = true;
    this.lastFrame = posAt(this.shape(), t0).frame;
    this.anchor(t0, o.resume);
    this.loopRaf();
  }

  /** 再生の時刻（いま聞こえている所から）。1 回の起点の中では前に返した値より小さくしない（聞こえている所の出どころが
   *  getOutputTimestamp と遅れの式の間で切り替わる 1 回に、コマが戻らないように＝第三者レビュー 2 周目） */
  now(): number {
    const t =
      this.src === "audio" && this.ctx
        ? this.t0 + Math.max(0, heardTimeOf(this.ctx, playEnv.now()).t - this.w0)
        : this.t0 + Math.max(0, playEnv.now() / 1000 - this.w0);
    if (t < this.lastNow) return this.lastNow;
    this.lastNow = t;
    return t;
  }
  /** now() が前に返した値（起点を取り直したら捨てる） */
  private lastNow = 0;

  /** いま描き終わっている所（⏸ の位置。音の時計では currentTime） */
  private renderedNow(): number {
    if (this.src === "audio" && this.ctx) return this.t0 + Math.max(0, this.ctx.currentTime - this.w0);
    return this.now();
  }

  /** BGM を頭出しする間隔。1 コマの作品をループするとき（曲の長さの形でない）は頭出ししない＝無限 */
  private bgmPeriod(): number {
    if (this.songSec == null && this.n === 1 && this.loop) return Infinity;
    return periodOf(this.shape());
  }

  /** 再生の時刻 T を、今の時計の秒へ */
  private clockOf(T: number): number {
    return this.w0 + (T - this.t0);
  }

  /** 音の時計に乗れるか（running で、止まったと分かった ctx ならまた進んでいる） */
  private usable(ctx: AudioContext | null): ctx is AudioContext {
    if (!ctx || (ctx.state as string) !== "running") return false;
    const st = this.stalled;
    if (st && st.ctx === ctx && !(ctx.currentTime > st.ct + 0.05)) return false;
    return true;
  }

  /** 起点を決めて（取り直して）予約を入れる */
  private anchor(t0: number, resume: boolean): void {
    this.t0 = t0;
    this.lastNow = t0;
    this.skipIds = [];
    this.schedDone.clear();
    this.bgmThrough = -1;
    const ctx = this.wantAudio ? playEnv.ctx() : null;
    if (this.usable(ctx)) {
      this.stalled = null;
      this.src = "audio";
      this.ctx = ctx;
      resetHeardMemo(ctx); // 止まっていた間・前の再生の値と進み方を比べない
      this.w0 = ctx.currentTime + PLAY_LEAD_SEC;
      this.lastCt = ctx.currentTime;
      this.lastCtPerf = playEnv.now();
      if (resume) this.skipIds = this.sink.resumeSe(this.w0, ctx);
      this.scheduleStartBgm(ctx);
      this.schedT = t0 - 1e-7; // 起点ちょうどのコマも入れる（以後は「前の until 以上」をちょうどで比べる）
      this.scheduleUntil(t0 + PLAY_LEAD_SEC + PLAY_LOOKAHEAD_SEC);
    } else {
      // 動いていない AudioContext には予約しない（動き出した瞬間にまとめて鳴ってずれる）。あとで running になったら取り直す
      this.src = "perf";
      this.ctx = null;
      this.w0 = playEnv.now() / 1000;
      this.schedT = t0 - 1e-7;
      if (resume) this.sink.discardPausedSe();
    }
  }

  /** 起点の時刻を含む BGM の 1 回ぶん（途中から） */
  private scheduleStartBgm(ctx: AudioContext): void {
    const plan = this.host.bgm();
    if (!plan) return;
    const Pb = this.bgmPeriod();
    const te = this.t0 - this.base;
    const m = Pb === Infinity ? 0 : Math.floor(te / Pb);
    const rel = Pb === Infinity ? te : te - m * Pb;
    const stopAt = Pb === Infinity ? null : this.clockOf(this.base + (m + 1) * Pb);
    this.sink.scheduleBgm(ctx, plan, this.w0, plan.trimStart + rel * plan.rate, stopAt);
    this.bgmThrough = m;
  }

  /** [schedT, until) に始まるコマの SE と、繰り返しの頭の BGM を予約する */
  private scheduleUntil(until: number): void {
    const ctx = this.ctx;
    if (!ctx || this.src !== "audio") return;
    const P = periodOf(this.shape());
    const Pb = this.bgmPeriod();
    const gEnd = lastGlobalFrame(P, this.fps);
    let from = this.schedT;
    // 描き終わっている所（見えていない間から戻ったとき、もう切られた繰り返しは丸ごと飛ばす）
    const rendered = this.t0 + (ctx.currentTime - this.w0);
    let guard = 0;
    while (from < until && guard++ < 10000) {
      const te = from - this.base;
      const m = Math.max(0, Math.floor(te / P + EPS));
      if (!this.loop && m >= 1) break; // ループしない作品は 1 回で終わり
      const head = this.base + m * P;
      if (Pb !== Infinity && head + P <= rendered) {
        // この繰り返しの SE は切られる時刻（head＋P）を過ぎている・BGM も止めの時刻を過ぎている
        this.bgmThrough = Math.max(this.bgmThrough, m);
        from = head + P;
        continue;
      }
      // 繰り返しの頭の BGM（起点を含む 1 回ぶんは scheduleStartBgm が入れた）
      if (Pb !== Infinity && m > this.bgmThrough && head >= this.t0 - EPS && head < until) {
        const plan = this.host.bgm();
        if (plan) this.sink.scheduleBgm(ctx, plan, this.clockOf(head), plan.trimStart, this.clockOf(head + P));
        this.bgmThrough = m;
      }
      // SE を切る時刻: 繰り返しの頭（つなぎ目）・終わり・曲の終わり。1 コマの作品をループするとき（曲の長さの形でない）は切らない
      const cut = Pb === Infinity ? null : this.clockOf(head + P);
      const g0 = Math.max(0, Math.ceil((from - head) * this.fps - EPS));
      for (let g = g0; g <= gEnd; g++) {
        const at = head + g / this.fps;
        if (at >= until) break;
        const key = `${Math.round(head / P)}:${g}`;
        if (this.schedDone.has(key) || at < from - 1e-6) continue; // 前の予約で入れた
        this.schedDone.set(key, at);
        const frame = g % this.n;
        const first = Math.abs(at - this.t0) < 1e-7;
        for (const se of this.host.seAt(frame)) {
          if (first && this.skipIds.includes(se.track.id)) continue;
          this.sink.scheduleSe(ctx, se.buf, se.track, this.clockOf(at), 0, cut);
        }
      }
      const next = head + P;
      if (next >= until) {
        from = until;
        break;
      }
      from = next;
    }
    if (!this.loop) until = Math.min(until, this.base + P);
    this.schedT = Math.max(this.schedT, Math.min(until, from));
    if (this.schedDone.size > 512) for (const [k, at] of this.schedDone) if (at < this.schedT - 2 * P - 1) this.schedDone.delete(k);
  }

  private loopRaf(): void {
    if (!this.running) return;
    this.rafId = playEnv.raf(() => {
      this.rafId = 0;
      this.tick();
    });
  }
  private cancelRaf(): void {
    if (this.rafId) playEnv.caf(this.rafId);
    this.rafId = 0;
  }

  /** 描く合図ごと（検査からも呼べる） */
  tick(): void {
    if (!this.running) return;
    const s = this.host.shape();
    if (fpsOf(s) !== this.fps || countOf(s) !== this.n) {
      // 速さ・コマ数が変わった＝今のコマから始め直す（呼び出し側が始め直す）
      this.halt();
      this.host.reshape();
      return;
    }
    this.checkClock();
    if (!!s.loop !== this.loop) this.loopChanged(!!s.loop);
    const T = this.now();
    const sh = this.shape();
    const P = periodOf(sh);
    const te = T - this.base;
    if (!this.loop && te >= P) {
      const end = posAt(sh, P);
      if (end.frame !== this.lastFrame) {
        this.lastFrame = end.frame;
        this.host.show(end.frame);
      }
      this.cancelRaf();
      this.running = false;
      this.host.ended();
      return;
    }
    const pos = posAt(sh, te);
    if (pos.frame !== this.lastFrame) {
      this.lastFrame = pos.frame;
      this.host.show(pos.frame);
      if (!this.running) return; // 描いた先で止められた
    }
    // 予約の先読みは描き終わっている所から（聞こえている所からだと、出力の遅れが先読みより長いとき間に合わない）
    this.scheduleUntil(this.renderedNow() + PLAY_LOOKAHEAD_SEC);
    this.loopRaf();
  }

  /** 音の時計が止まった・作り直された・あとで running になった、に気づいて取り直す（statechange は購読しない＝描く合図ごとに見る） */
  private checkClock(): void {
    if (!this.wantAudio) return;
    const perf = playEnv.now();
    if (this.src === "audio" && this.ctx) {
      const cur = playEnv.ctx();
      const ct = this.ctx.currentTime;
      let stalled = false;
      if (ct > this.lastCt + 1e-6) {
        this.lastCt = ct;
        this.lastCtPerf = perf;
      } else if (perf - this.lastCtPerf > PLAY_STALL_MS) stalled = true;
      if (stalled) this.stalled = { ctx: this.ctx, ct };
      if (cur !== this.ctx || (this.ctx.state as string) !== "running" || stalled) this.reanchorAtFrame();
    } else if (this.src === "perf") {
      if (this.usable(playEnv.ctx())) this.reanchorAtFrame();
    }
  }

  /** 今のコマの頭を起点に取り直す（予約は全部取り消して入れ直す・BGM は今の位置から鳴らし直す）。
   *  乗る時計は anchor が決める（running の ctx があれば音の時計・無ければ performance.now()） */
  private reanchorAtFrame(): void {
    const T = this.src === "perf" ? this.now() : this.t0 + Math.max(0, (this.ctx ? this.lastCtSafe() : 0) - this.w0);
    const sh = this.shape();
    const te = T - this.base;
    const P = periodOf(sh);
    let head: number;
    if (this.bgmPeriod() === Infinity) head = Math.floor(te * this.fps + EPS) / this.fps;
    else {
      const m = Math.max(0, Math.floor(te / P + EPS));
      const pos = posAt(sh, te);
      head = m * P + startTimeOf(sh, pos.frame, pos.lap);
    }
    this.sink.stopBgm();
    this.sink.stopSe();
    // base は 0 に戻す（head は base からの時刻）
    const t0 = head;
    this.base = 0;
    this.anchor(t0, false);
  }

  /** 止まった時計でも最後に進んでいた所（currentTime） */
  private lastCtSafe(): number {
    if (!this.ctx) return 0;
    const ct = this.ctx.currentTime;
    return isFinite(ct) ? ct : this.lastCt;
  }

  /** ループを切り替えた: 見た目は今の繰り返しの終わりまで変えない。先に入れた予約（終わりの止め・次の頭出しと頭の SE）は入れ直す */
  private loopChanged(loop: boolean): void {
    const T = this.now();
    const sh = this.shape();
    const P = periodOf(sh);
    const te = T - this.base;
    const m = Math.max(0, Math.floor(te / P + EPS));
    const PbWas = this.bgmPeriod();
    this.loop = loop;
    this.base += m * P; // 今の繰り返しを 0 番目に
    this.bgmThrough -= m;
    const endT = this.base + P;
    if (this.src === "audio" && this.ctx) {
      const w = this.clockOf(endT) - 1e-4;
      this.sink.cancelBgmFrom(w);
      this.sink.cancelSeFrom(w);
      const Pb = this.bgmPeriod();
      if (Pb !== PbWas) {
        if (Pb === Infinity) {
          // 1 コマの作品でループを入れた: 曲を切らずに流し続ける＝今の位置から鳴らし直す
          this.sink.stopBgm();
          const plan = this.host.bgm();
          if (plan) {
            const now = this.ctx.currentTime;
            const rel = Math.max(0, this.renderedNow() - this.base);
            this.sink.scheduleBgm(this.ctx, plan, now, plan.trimStart + rel * plan.rate, null);
          }
          this.sink.recutSe(null);
        } else {
          this.sink.restopBgm(this.clockOf(endT));
          this.sink.recutSe(this.clockOf(endT));
        }
      }
      this.bgmThrough = Math.min(this.bgmThrough, 0);
    }
    this.schedT = Math.min(this.schedT, endT - 1e-7);
    for (const [k, at] of this.schedDone) if (at >= endT - 1e-7) this.schedDone.delete(k); // 取り消した出来事はまた入れる
  }

  /** 音も絵も止めて、駆動だけ外す（予約は呼び出し側の stop / pause が取り消す） */
  private halt(): void {
    this.cancelRaf();
    this.running = false;
    this.sink.stopBgm();
  }

  /** ⏸: 描き終わっている所で止める。表示をそのコマへ進めてから SE を畳む（エディタと試し再生）。位置を返す */
  pause(): PlayPaused {
    const T = this.running ? this.renderedNow() : this.t0;
    const sh = this.shape();
    const P = periodOf(sh);
    let te = T - this.base;
    if (!this.loop && te >= P) te = Math.max(0, P - 1e-6);
    const pos = posAt(sh, te);
    this.halt();
    if (pos.frame !== this.lastFrame) {
      this.lastFrame = pos.frame;
      this.host.show(pos.frame);
    }
    this.sink.pauseSe();
    let t = te;
    if (this.bgmPeriod() !== Infinity && t >= P) t -= Math.floor(t / P) * P;
    return { t, frame: pos.frame, fps: this.fps, frameCount: this.n };
  }

  /** 止める（予約も鳴っている音も取り消す・SE の続きも捨てる） */
  stop(): void {
    this.halt();
    this.sink.stopSe();
  }

  /** いまのコマが始まった時刻（繰り返しの頭から）。ライブラリの「曲の長さ」の形の ⏸ が何周目かを覚えるのに使う */
  frameHead(): number {
    const sh = this.shape();
    const te = this.now() - this.base; // 出ているコマ（聞こえている所で決めたコマ）の頭
    const pos = posAt(sh, te);
    if (this.bgmPeriod() === Infinity) return Math.floor(Math.max(0, te) * this.fps + EPS) / this.fps;
    return startTimeOf(sh, pos.frame, pos.lap);
  }

  /** 曲のいまの位置（バッファの秒・トリムの終わりで留める）。試し再生の波形の再生位置（絵と同じ時計） */
  songPos(plan: { trimStart: number; trimEnd: number; rate: number } | null, at?: number): number | null {
    if (!plan) return null;
    const te = Math.max(0, at ?? this.now() - this.base);
    const Pb = this.bgmPeriod();
    const rel = Pb === Infinity ? te : te - Math.floor(te / Pb + EPS) * Pb;
    return Math.min(plan.trimEnd, plan.trimStart + Math.max(0, rel) * plan.rate);
  }

  /** 検査用: 今の時計の出どころ */
  clockSource(): "audio" | "perf" {
    return this.src;
  }
}
