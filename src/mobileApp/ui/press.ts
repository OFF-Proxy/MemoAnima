// V223 (M-2b-3b-1・UI §5-4・§5-5・U-28・指示書 ■3 の F-1): 1 回の接触を「押す・長押し・運ぶ・すべらせる・送る」に切り分ける決まり。
//
// ★画面を持たない（DOM を読まない）。時刻は出来事と時計から受け取り、入れ物は「いまの送り・送れる限り」を読む口（ScrollBox）で受け取る。
//  Node の検査（scripts/v223_smoke.ts [H]）が、時刻を進めて同じ関数を通す。
// ★長押しから動かせるもの（コマ・レイヤーとフォルダの行）とすべらせるもの（レイヤーの行）は CSS で `touch-action: none` にしてある。
//  OS のスクロールに任せると、指が動いたところでブラウザが送り始めて `pointercancel` で取り上げられる（Chromium で確かめた）ので、
//  その部品の上から入れ物を送るのは、ここ（画面の側）でする:
//   - 長押しになる前に、指の動きが TAP_SLOP（12）を超えたら、**その瞬間の向き**で決める（横の動きが縦の動き以上なら横。あとで向きを変えても替えない）
//   - 向きが入れ物の送る向きと同じなら「送る」（指と同じだけ・1 対 1）。違えば長押しをやめるだけ（行の横はすべらせる）
//   - 離したときの速さで少し進んで止まる（惰性）。端で止まり、跳ね返らない。もう一度触れたら止まる
//   - 送っている間と惰性の間は、押したことにしない・長押しにしない
//  すべらせる（横へ 28 を超え、縦の 1.5 倍より横）・長押し（動かさずに 500）・運ぶ・離すは V221・V222 のまま。

export const TAP_SLOP = 12;
export const HOLD_MS = 500;
/** すべらせる: 横へこれを超え、縦の SWIPE_RATIO 倍より横 */
export const SWIPE_MIN = 28;
export const SWIPE_RATIO = 1.5;

/** ★惰性の数（iPad の送りに近いもの・Code が決めた）: 速さは 1ms ごとに INERTIA_RATE 倍（UIScrollView のふつうの減り方と同じ 0.998）。
 *  INERTIA_STOP（px/ms）より遅くなったら止まる。離す直前の VELOCITY_WINDOW_MS の動きから速さを出し、INERTIA_MIN より遅ければ惰性にしない。
 *  速さの上限は INERTIA_MAX（px/ms） */
export const INERTIA_RATE = 0.998;
export const INERTIA_STOP = 0.02;
export const INERTIA_MIN = 0.05;
export const INERTIA_MAX = 8;
export const VELOCITY_WINDOW_MS = 100;

export type Axis = "x" | "y";

/** 入れ物の送り（画面の側が DOM から作る。検査は数で作る） */
export interface ScrollBox {
  /** いまの送り（scrollLeft／scrollTop） */
  get(): number;
  set(v: number): void;
  /** 送れる限り（中身の大きさ − 見えている大きさ。0 なら送れない） */
  max(): number;
}

export interface PressSpec {
  /** 長押しを受ける（動かさずに HOLD_MS） */
  hold: boolean;
  /** 横にすべらせるのを受ける */
  swipe: boolean;
  /** 画面の側で送る入れ物と向き（無ければ送らない） */
  scroll: { box: ScrollBox; axis: Axis } | null;
  /** 触れたときに、この入れ物の惰性を止めた（その接触では押したことにしない・長押しにしない） */
  stoppedInertia?: boolean;
}

export type PressPhase = "press" | "held" | "scroll" | "swiped" | "moved";

/** 動かしたときに起きること（画面の側が部品へ伝える） */
export type PressEvent = { kind: "none" } | { kind: "drag"; x: number; y: number } | { kind: "swipe"; dx: number } | { kind: "scroll" };
/** 離したときに起きること */
export type PressEnd = { kind: "tap" } | { kind: "drop" } | { kind: "fling"; velocity: number } | { kind: "none" };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 1 回の接触 */
export class Press {
  phase: PressPhase = "press";
  /** 12 を超えた瞬間に決めた向き（決まったら替えない） */
  dir: Axis | null = null;
  moved = 0;
  private scroll0 = 0;
  private samples: { t: number; p: number }[] = [];

  constructor(readonly spec: PressSpec, readonly x0: number, readonly y0: number, readonly t0: number) {
    if (spec.scroll) this.scroll0 = spec.scroll.box.get();
  }

  /** 長押しを待っているか（時計が HOLD_MS で holdDue を呼ぶ） */
  wantsHold(): boolean {
    return this.spec.hold && !this.spec.stoppedInertia;
  }

  /** HOLD_MS たった: 動かしていなければ長押しになる（true） */
  holdDue(): boolean {
    if (this.phase !== "press" || !this.wantsHold() || this.moved > TAP_SLOP) return false;
    this.phase = "held";
    return true;
  }

  move(x: number, y: number, t: number): PressEvent {
    const dx = x - this.x0;
    const dy = y - this.y0;
    this.moved = Math.max(this.moved, Math.hypot(dx, dy));
    if (this.phase === "held") return { kind: "drag", x, y };
    if (this.phase === "scroll") return this.scrollTo(x, y, t);
    if (this.phase === "swiped") return { kind: "none" };
    // ★12 を超えた瞬間の向きで決める（横の動きが縦の動き以上なら横）。あとで向きを変えても替えない
    if (this.dir === null && this.moved > TAP_SLOP) {
      this.dir = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      this.phase = "moved"; // 長押しにしない
      const sc = this.spec.scroll;
      if (sc && sc.axis === this.dir) {
        this.phase = "scroll";
        return this.scrollTo(x, y, t);
      }
    }
    // すべらせる: 送る向きに決まった接触ではしない（行は、向きが横に決まったときだけ）
    const sc = this.spec.scroll;
    const swipeOk = this.spec.swipe && (!sc || this.dir === "x");
    if (swipeOk && Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO) {
      this.phase = "swiped";
      return { kind: "swipe", dx };
    }
    return { kind: "none" };
  }

  /** 入れ物を指と同じだけ送る（押したときの送り − 指の動き・端で止める） */
  private scrollTo(x: number, y: number, t: number): PressEvent {
    const sc = this.spec.scroll!;
    const p = sc.axis === "x" ? x : y;
    const p0 = sc.axis === "x" ? this.x0 : this.y0;
    sc.box.set(clamp(this.scroll0 - (p - p0), 0, Math.max(0, sc.box.max())));
    this.samples.push({ t, p });
    while (this.samples.length > 2 && t - this.samples[0].t > VELOCITY_WINDOW_MS) this.samples.shift();
    return { kind: "scroll" };
  }

  /** 離した */
  up(t: number): PressEnd {
    if (this.phase === "held") return { kind: "drop" };
    if (this.phase === "scroll") {
      const s = this.samples;
      if (s.length >= 2) {
        const a = s[0];
        const b = s[s.length - 1];
        // 離す前に止まっていたら（最後の動きから間があいた）惰性にしない
        if (b.t > a.t && t - b.t <= VELOCITY_WINDOW_MS) {
          const v = clamp(-(b.p - a.p) / (b.t - a.t), -INERTIA_MAX, INERTIA_MAX);
          if (Math.abs(v) >= INERTIA_MIN) return { kind: "fling", velocity: v };
        }
      }
      return { kind: "none" };
    }
    if (this.phase === "swiped" || this.moved > TAP_SLOP || this.spec.stoppedInertia) return { kind: "none" };
    return { kind: "tap" };
  }
}

/** 惰性（離したときの速さで進み、だんだん遅くなって止まる。端で止まる） */
export class Inertia {
  private v: number;
  private pos: number;
  private last: number;
  done = false;

  /** velocity は送りの向きの速さ（px/ms・正なら送りが増える） */
  constructor(readonly box: ScrollBox, velocity: number, t: number) {
    this.v = velocity;
    this.pos = box.get();
    this.last = t;
  }

  /** 時刻 t まで進める（進めた分を入れ物に書く）。止まったら done */
  step(t: number): void {
    if (this.done) return;
    const dt = Math.max(0, t - this.last);
    this.last = t;
    if (dt === 0) return;
    // 速さ v·r^s を s＝0〜dt で足した分だけ進む
    const k = Math.log(INERTIA_RATE);
    const r = Math.pow(INERTIA_RATE, dt);
    this.pos += (this.v * (r - 1)) / k;
    this.v *= r;
    const max = Math.max(0, this.box.max());
    if (this.pos <= 0 || this.pos >= max) {
      this.pos = clamp(this.pos, 0, max);
      this.done = true; // 端で止まる（跳ね返らない）
    }
    if (Math.abs(this.v) < INERTIA_STOP) this.done = true;
    this.box.set(this.pos);
  }
}
