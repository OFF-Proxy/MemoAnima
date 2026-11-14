// V225 (M-2b-3b-2・UI §4-1 の最後・C16・指示書 ■3 の T): トラックパッドとマウスのホイールの**決まり**（画面を持たない）。
//
// ★出来事の列から、2 本指のジェスチャーと同じ形（GestureUpdate＝始め・動き・終わり）を作る。倍率と位置を出すのは、指のときと同じ
//  描く画面の道（寄せ方と端の決まりは view/zoom.ts の settle）。
//  - ピンチ（WKWebView は `wheel` に ctrlKey を立てて渡す・キーボードの Ctrl〔⌘〕＋スクロールも同じ形＝PC と同じ）: その場を中心に拡大縮小
//  - 2 本指のスクロール（ctrlKey なしの `wheel`）: 絵を動かす。**拡大しているときだけ**（fit のときは動かさない）
//  - `gesturestart`／`gesturechange`／`gestureend`（WebKit がトラックパッドのピンチを渡すもう 1 つの形）: scale をそのまま使う
//  - 手を止めて 0.22 秒たったら終わり（寄る）
// ★pointerType を読まない（wheel と gesture の出来事はポインタの種類を持たない）。
import type { GestureUpdate } from "../input/router";

/** 手を止めてから寄るまで（UI §4-1） */
export const WHEEL_SETTLE_MS = 220;
/** ピンチの wheel の 1 目盛りあたりの拡大（deltaY 1 で約 1%。WebKit と Chromium のトラックパッドのピンチと同じ感じ） */
export const WHEEL_ZOOM_RATE = 0.01;
/** 1 回の出来事の deltaY の限り（マウスのホイールの 1 刻みが大きすぎて飛ばないように） */
export const WHEEL_DELTA_CAP = 60;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0＝px・1＝行・2＝頁 */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  clientX: number;
  clientY: number;
}

export interface WheelEnv {
  /** いま拡大しているか（fit より大きい） */
  zoomed(): boolean;
  /** Ctrl に畳む修飾キー（⌘）が押されているか */
  primary(e: { ctrlKey: boolean; metaKey: boolean }): boolean;
  /** ジェスチャーの知らせ（描く画面の mbGesture） */
  gesture(g: GestureUpdate): void;
  /** 時計（検査は差し替える） */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
}

export class WheelGesture {
  private live: { center: { x: number; y: number }; dx: number; dy: number; scale: number } | null = null;
  private timer: unknown = null;
  /** gesturechange の途中（その間の wheel は使わない＝2 重に拡大しない） */
  private native = false;

  constructor(private env: WheelEnv) {}

  /** いま途中か */
  active(): boolean {
    return this.live !== null;
  }

  private update(phase: GestureUpdate["phase"]): GestureUpdate {
    const l = this.live!;
    return { phase, center: { x: l.center.x + l.dx, y: l.center.y + l.dy }, pan: { dx: l.dx, dy: l.dy }, scale: l.scale, rotationDeg: 0 };
  }

  private begin(x: number, y: number): void {
    if (this.live) return;
    this.live = { center: { x, y }, dx: 0, dy: 0, scale: 1 };
    this.env.gesture(this.update("start"));
  }

  private arm(): void {
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      this.end();
    }, WHEEL_SETTLE_MS);
  }

  /** そこまでで止めて寄る */
  end(): void {
    if (this.timer !== null) {
      this.env.clearTimer(this.timer);
      this.timer = null;
    }
    if (!this.live) return;
    const u = this.update("end");
    this.live = null;
    this.native = false;
    this.env.gesture(u);
  }

  /** 何もせずに捨てる（作品を閉じる・大きさが変わった） */
  drop(): void {
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
    this.live = null;
    this.native = false;
  }

  /** ★wheel を 1 つ受ける。受けたら true（呼ぶ側が既定の動き〔頁の拡大・送り〕を止める） */
  wheel(e: WheelLike): boolean {
    if (this.native) return true;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 240 : 1;
    if (e.ctrlKey || this.env.primary(e)) {
      const dy = Math.max(-WHEEL_DELTA_CAP, Math.min(WHEEL_DELTA_CAP, e.deltaY * unit));
      if (dy === 0) return true;
      this.begin(e.clientX, e.clientY);
      this.live!.scale *= Math.exp(-dy * WHEEL_ZOOM_RATE);
      this.env.gesture(this.update("move"));
      this.arm();
      return true;
    }
    // 2 本指のスクロール: 拡大しているときだけ動かす（途中で fit へ戻っても、始めた動きは最後まで続ける）
    if (!this.live && !this.env.zoomed()) return true;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (dx === 0 && dy === 0) return true;
    this.begin(e.clientX, e.clientY);
    this.live!.dx -= dx;
    this.live!.dy -= dy;
    this.env.gesture(this.update("move"));
    this.arm();
    return true;
  }

  /** WebKit の gesturestart／gesturechange／gestureend（scale は始めからの比） */
  nativeStart(x: number, y: number): void {
    this.end();
    this.native = true;
    this.begin(x, y);
  }
  nativeChange(scale: number): void {
    if (!this.native || !this.live) return;
    if (!(scale > 0) || !Number.isFinite(scale)) return;
    this.live.scale = scale;
    this.env.gesture(this.update("move"));
  }
  nativeEnd(): void {
    if (!this.native) return;
    // 指を離してから 0.22 秒で寄る（wheel と同じ間）
    this.arm();
    this.native = false;
  }
}
