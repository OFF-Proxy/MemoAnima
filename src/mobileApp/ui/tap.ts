// V221 (M-2b-2・V220 の報告 §13 の 8): 画面のボタンを**離したとき**に押したことにする部品。
//
// ★描く画面の接触は、振り分け層（input/router.ts）が先に見る。"ui" と返した接触だけがここへ来る。
//  振り分け層が `uiCancel(id)` を出したら（手のひら・取り上げ）、その接触では押したことにしない。
// ★押したことにするのは、押したのと同じ部品の上で離したとき（動きが 12pt 以内）だけ。押した瞬間には何もしない
//  （ペンを置いた手のひらがボタンに触れても、ペンの間の指は振り分け層が捨てる＝ここへ来ない）。
// ★読み上げ（VoiceOver）のダブルタップとキーボードは、ポインタの出来事なしの click（detail 0）で来るので、それだけを受ける。
// ★長押し（コマ・レイヤーの行）・横にすべらせる（レイヤーの行）・長押しから運ぶ（コマ）は、部品ごとに `bindHold` で付ける。
// ★V223 (F-1): 長押しから動かせる部品（`touch-action: none`）の上から入れ物を送るのは、ここでする（`bindScroll`）。
//  切り分けの決まり（12 を超えた瞬間の向き・送る・惰性・すべらせる・長押し）は press.ts（画面を持たない）。ここは出来事と時計をつなぐだけ。
//  押してすぐ動かすもの（色の四角・色相の縦棒）は `bindTrack`（長押しを待たない）。
import { actOf } from "./dom";
import { Press, Inertia, HOLD_MS, TAP_SLOP, type Axis, type ScrollBox } from "./press";

export { TAP_SLOP, HOLD_MS };

export interface HoldHandlers {
  /** 長押しになった（動かさずに HOLD_MS） */
  hold?(x: number, y: number): void;
  /** 長押しのあと動いた（運ぶ） */
  drag?(x: number, y: number): void;
  /** 長押しのあと離した */
  drop?(x: number, y: number, cancelled: boolean): void;
  /** 長押しの前に横へすべらせた（dx が負＝左へ） */
  swipe?(dx: number): void;
}

/** 押してすぐ動かすもの（色の四角・色相の縦棒） */
export interface TrackHandlers {
  start(x: number, y: number): void;
  move(x: number, y: number): void;
  /** 離した（cancelled＝取り上げられた） */
  end(cancelled: boolean): void;
}

/** 時計（検査は偽の時計を渡して時刻を進める） */
export interface TapClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  /** 次の描画の前に 1 回（惰性を進める） */
  frame(fn: (now: number) => void): unknown;
  cancelFrame(h: unknown): void;
}

const realClock: TapClock = {
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  frame: (fn) => requestAnimationFrame(fn),
  cancelFrame: (h) => cancelAnimationFrame(h as number),
};

const HOLDS = new WeakMap<object, HoldHandlers>();
const SCROLLS = new WeakMap<object, { box: ScrollBox; axis: Axis }>();
const TRACKS = new WeakMap<object, TrackHandlers>();

export function bindHold(el: Element, hh: HoldHandlers): void {
  HOLDS.set(el, hh);
}

/** ★V223 (F-1): この部品（コマ・行）の上で指を動かしたら、入れ物を画面の側で送る */
export function bindScroll(el: Element, box: ScrollBox, axis: Axis): void {
  SCROLLS.set(el, { box, axis });
}

/** ★V223 (F-8): 押してすぐ動かす部品 */
export function bindTrack(el: Element, th: TrackHandlers): void {
  TRACKS.set(el, th);
}

/** 入れ物の要素から送りの口を作る（横＝scrollLeft・縦＝scrollTop） */
export function scrollBoxOf(el: HTMLElement, axis: Axis): ScrollBox {
  return axis === "x"
    ? { get: () => el.scrollLeft, set: (v) => (el.scrollLeft = v), max: () => el.scrollWidth - el.clientWidth }
    : { get: () => el.scrollTop, set: (v) => (el.scrollTop = v), max: () => el.scrollHeight - el.clientHeight };
}

function upFind<T>(map: WeakMap<object, T>, el: Element | null): T | null {
  let n: Element | null = el;
  while (n) {
    const v = map.get(n);
    if (v) return v;
    n = n.parentElement;
  }
  return null;
}

interface Down {
  el: Element | null;
  act: (() => void) | null;
  hh: HoldHandlers | null;
  track: TrackHandlers | null;
  press: Press;
  timer: unknown;
}

export interface TapEvent {
  pointerId: number;
  clientX: number;
  clientY: number;
  timeStamp?: number;
}

/** 当たりの部品を探す口（検査は DOM なしで差し替える） */
export interface TapEnv {
  /** 出来事の的を、上へたどれる部品にする（DOM では Element） */
  targetOf(t: EventTarget | null): Element | null;
  /** 画面の点の下の部品 */
  under(x: number, y: number): Element | null;
}

const realEnv: TapEnv = {
  targetOf: (t) => (t instanceof Element ? t : null),
  under: (x, y) => (typeof document !== "undefined" ? document.elementFromPoint(x, y) : null),
};

export class TapManager {
  private downs = new Map<number, Down>();
  private inertias: { inertia: Inertia; box: ScrollBox }[] = [];
  private frameH: unknown = null;
  /** 押したことにする直前に呼ぶ（別の操作を始めた＝コアの otherOperationStarted など） */
  constructor(private before: () => void, private blocked: () => boolean, private clock: TapClock = realClock, private env: TapEnv = realEnv) {}

  private timeOf(e: TapEvent): number {
    return typeof e.timeStamp === "number" && e.timeStamp > 0 ? e.timeStamp : this.clock.now();
  }

  down(e: TapEvent & { target: EventTarget | null }): void {
    const t = this.env.targetOf(e.target);
    const a = actOf(t);
    const hh = upFind(HOLDS, t);
    const scroll = upFind(SCROLLS, t);
    const track = upFind(TRACKS, t);
    // ★もう一度触れたら惰性は止まる。その接触では押したことにしない・長押しにしない（動かせば、また送れる）
    //  送る口の無い所（パネルの頭・つまみ・ほかのボタン）に触れたときも、動いている惰性は全部止める（その接触はふつうに押せる）
    const stoppedInertia = scroll ? this.stopInertia(scroll.box) : (this.stopInertia(), false);
    const press = new Press({ hold: !!hh?.hold, swipe: !!hh?.swipe, scroll, stoppedInertia }, e.clientX, e.clientY, this.timeOf(e));
    const d: Down = { el: a?.el ?? null, act: a?.act ?? null, hh, track, press, timer: null };
    if (track) track.start(e.clientX, e.clientY);
    else if (press.wantsHold()) {
      d.timer = this.clock.setTimer(() => {
        d.timer = null;
        if (this.downs.get(e.pointerId) === d && press.holdDue()) hh!.hold!(press.x0, press.y0);
      }, HOLD_MS);
    }
    this.downs.set(e.pointerId, d);
  }

  move(e: TapEvent): void {
    const d = this.downs.get(e.pointerId);
    if (!d) return;
    if (d.track) {
      d.track.move(e.clientX, e.clientY);
      return;
    }
    const r = d.press.move(e.clientX, e.clientY, this.timeOf(e));
    if (d.press.phase !== "press" && d.press.phase !== "held" && d.timer !== null) {
      this.clock.clearTimer(d.timer);
      d.timer = null;
    }
    if (r.kind === "drag") d.hh?.drag?.(r.x, r.y);
    else if (r.kind === "swipe") d.hh?.swipe?.(r.dx);
  }

  up(e: TapEvent): void {
    const d = this.downs.get(e.pointerId);
    if (!d) return;
    this.downs.delete(e.pointerId);
    if (d.timer !== null) this.clock.clearTimer(d.timer);
    if (d.track) {
      d.track.end(false);
      return;
    }
    const r = d.press.up(this.timeOf(e));
    if (r.kind === "drop") {
      d.hh?.drop?.(e.clientX, e.clientY, false);
      return;
    }
    if (r.kind === "fling") {
      const box = d.press.spec.scroll!.box;
      this.inertias.push({ inertia: new Inertia(box, r.velocity, this.timeOf(e)), box });
      this.runInertia();
      return;
    }
    if (r.kind !== "tap" || !d.act || !d.el) return;
    const a2 = actOf(this.env.under(e.clientX, e.clientY));
    if (!a2 || a2.el !== d.el) return;
    if (this.blocked()) return;
    this.before();
    d.act();
  }

  /** 振り分け層が取り上げた（手のひら・ペンが触れた）: その接触では押したことにしない */
  cancel(pointerId: number): void {
    const d = this.downs.get(pointerId);
    if (!d) return;
    this.downs.delete(pointerId);
    if (d.timer !== null) this.clock.clearTimer(d.timer);
    if (d.track) d.track.end(true);
    else if (d.press.phase === "held") d.hh?.drop?.(d.press.x0, d.press.y0, true);
  }

  /** 全部を取り上げる（裏に回る・閉じる）。惰性も止める */
  cancelAll(): void {
    for (const id of [...this.downs.keys()]) this.cancel(id);
    this.stopInertia();
  }

  /** 惰性を止める（box を渡すとその入れ物だけ）。止めたものがあれば true */
  stopInertia(box?: ScrollBox): boolean {
    const n = this.inertias.length;
    this.inertias = box ? this.inertias.filter((i) => i.box !== box) : [];
    if (this.inertias.length === 0 && this.frameH !== null) {
      this.clock.cancelFrame(this.frameH);
      this.frameH = null;
    }
    return this.inertias.length !== n;
  }

  /** 惰性が動いているか（検査と確かめ画面） */
  inertiaRunning(): boolean {
    return this.inertias.length > 0;
  }

  private runInertia(): void {
    if (this.frameH !== null) return;
    const step = (now: number) => {
      this.frameH = null;
      for (const i of this.inertias) i.inertia.step(now);
      this.inertias = this.inertias.filter((i) => !i.inertia.done);
      if (this.inertias.length) this.frameH = this.clock.frame(step);
    };
    this.frameH = this.clock.frame(step);
  }

  /** 読み上げ・キーボードの click（detail 0）だけを受ける。ポインタから来た click は止める（押したことにするのは up） */
  click(e: MouseEvent): void {
    const t = e.target instanceof Element ? e.target : null;
    const a = actOf(t);
    if (!a) return;
    e.preventDefault();
    if (e.detail !== 0) return;
    if (this.blocked()) return;
    this.before();
    a.act();
  }
}
