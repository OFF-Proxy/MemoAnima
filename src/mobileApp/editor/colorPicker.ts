// V223 (M-2b-3b-1・UI §5-5 の色・§5-11・U-9・指示書 ■3 の F-8): 色の四角（明るさと鮮やかさ）と色相の縦棒。
//
// ★四角と縦棒は canvas で描き、色は計算で作る（colorMath.ts。CSS のグラデーションと色の直書きを使わない＝U-9）。画面の解像度（dpr）で描く。
// ★四角と縦棒は `touch-action: none`（editor.css）。パネルは中を送れる入れ物なので、無いと指を動かしたところで取り上げられる（F-1 と同じ）。
//  押してすぐ動かす（tap.ts の bindTrack）。動かすたびに onPick（描画の 1 回ごとにまとめる）・離したら onEnd。
// ★いまの色が透明・灰・黒（色相が決まらない）のときは、前に選んだ色相のまま。
import { h } from "../ui/dom";
import { bindTrack } from "../ui/tap";
import { hexToHsv, hsvToHex, svAt, hueAt, paintSv, paintHue, type Hsv } from "./colorMath";

export interface ColorPickerOptions {
  /** 四角の幅と高さ・縦棒の幅（高さは四角と同じ）・間 */
  svW: number;
  svH: number;
  hueW: number;
  gap: number;
  /** 読み上げの名前 */
  svLabel: string;
  hueLabel: string;
  /** いまの色（透明は ""）と、前に選んだ色相 */
  hex: string;
  hue: number;
  /** 動かした（色が替わる） */
  onPick(hex: string, hsv: Hsv): void;
  /** 触り始めた・離した */
  onStart(): void;
  onEnd(): void;
}

export class ColorPicker {
  readonly el: HTMLElement;
  private sv: HTMLCanvasElement;
  private hue: HTMLCanvasElement;
  private svKnob: HTMLElement;
  private hueKnob: HTMLElement;
  private cur: Hsv;
  /** いまの色が透明（四角のつまみを出さない） */
  private clear: boolean;
  private paintedHue = -1;
  private raf = 0;
  private pending: string | null = null;

  constructor(private o: ColorPickerOptions) {
    const hsv = o.hex ? hexToHsv(o.hex, o.hue) : null;
    this.clear = !hsv;
    this.cur = hsv ?? { h: o.hue, s: 0, v: 1 };
    this.sv = document.createElement("canvas");
    this.sv.className = "mb-cp-sv";
    this.hue = document.createElement("canvas");
    this.hue.className = "mb-cp-hue";
    this.svKnob = h("span", "mb-cp-knob");
    this.hueKnob = h("span", "mb-cp-hknob");
    const svBox = h("div", "mb-cp-svbox", this.sv, this.svKnob);
    const hueBox = h("div", "mb-cp-huebox", this.hue, this.hueKnob);
    svBox.style.width = `${o.svW}px`;
    svBox.style.height = hueBox.style.height = `${o.svH}px`;
    hueBox.style.width = `${o.hueW}px`;
    svBox.setAttribute("role", "slider");
    svBox.ariaLabel = o.svLabel;
    hueBox.setAttribute("role", "slider");
    hueBox.ariaLabel = o.hueLabel;
    hueBox.setAttribute("aria-valuemin", "0");
    hueBox.setAttribute("aria-valuemax", "360");
    this.el = h("div", "mb-cp", svBox, hueBox);
    this.el.style.gap = `${o.gap}px`;
    const frac = (box: HTMLElement, x: number, y: number) => {
      const r = box.getBoundingClientRect();
      if (!box.isConnected || r.width <= 0 || r.height <= 0) return null; // 触っている途中に組み直された（矩形が無い）ときは拾わない
      return { fx: r.width > 0 ? (x - r.left) / r.width : 0, fy: r.height > 0 ? (y - r.top) / r.height : 0 };
    };
    const onSv = (x: number, y: number) => {
      const f = frac(svBox, x, y);
      if (!f) return;
      const { s, v } = svAt(f.fx, f.fy);
      this.cur = { h: this.cur.h, s, v };
      this.clear = false; // 透明のときに四角へ触れたら色になる
      this.changed();
    };
    const onHue = (x: number, y: number) => {
      const f = frac(hueBox, x, y);
      if (!f) return;
      this.cur = { ...this.cur, h: hueAt(f.fy) };
      this.changed();
    };
    bindTrack(svBox, { start: (x, y) => (o.onStart(), onSv(x, y)), move: onSv, end: () => this.finish() });
    bindTrack(hueBox, { start: (x, y) => (o.onStart(), onHue(x, y)), move: onHue, end: () => this.finish() });
    this.size(this.sv, o.svW, o.svH);
    this.size(this.hue, o.hueW, o.svH);
    this.paint();
  }

  /** いまの色相（組み直しても持ち越す） */
  hueNow(): number {
    return this.cur.h;
  }

  private size(cv: HTMLCanvasElement, w: number, hh: number): void {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(hh * dpr));
    cv.style.width = `${w}px`;
    cv.style.height = `${hh}px`;
  }

  private changed(): void {
    // つまみはすぐ動かし、四角の塗り直しと色の知らせは描画の 1 回ごとにまとめる
    this.knobs();
    if (!this.clear) this.pending = hsvToHex(this.cur);
    if (!this.raf)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.paint();
        this.flush();
      });
  }

  private flush(): void {
    const hex = this.pending;
    this.pending = null;
    if (hex !== null) this.o.onPick(hex, this.cur);
  }

  private finish(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.paint();
    this.flush();
    this.o.onEnd();
  }

  private paint(): void {
    if (this.paintedHue !== this.cur.h) {
      const ctx = this.sv.getContext("2d");
      if (ctx) {
        const img = ctx.createImageData(this.sv.width, this.sv.height);
        paintSv(img.data, img.width, img.height, this.cur.h);
        ctx.putImageData(img, 0, 0);
      }
      if (this.paintedHue < 0) {
        const hc = this.hue.getContext("2d");
        if (hc) {
          const img = hc.createImageData(this.hue.width, this.hue.height);
          paintHue(img.data, img.width, img.height);
          hc.putImageData(img, 0, 0);
        }
      }
      this.paintedHue = this.cur.h;
    }
    this.knobs();
  }

  private knobs(): void {
    this.svKnob.hidden = this.clear;
    this.svKnob.style.left = `${this.cur.s * 100}%`;
    this.svKnob.style.top = `${(1 - this.cur.v) * 100}%`;
    this.svKnob.style.setProperty("--sw", hsvToHex(this.cur));
    this.hueKnob.style.top = `${(this.cur.h / 360) * 100}%`;
    this.hueKnob.style.setProperty("--sw", hsvToHex({ h: this.cur.h, s: 1, v: 1 }));
    this.el.querySelector(".mb-cp-huebox")?.setAttribute("aria-valuenow", String(Math.round(this.cur.h)));
  }
}
