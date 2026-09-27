// M8-1 I-1: 画像→ドット化変換エンジン（共有モジュール・純関数）
// うごメモ3D「写真/さつえい」機能の再現＋PC拡張。
// - アプリ内「📷 画像を取り込む」GUI と scripts/photo2memo.ts CLI の両方がこれを使う
//   （同一設定→同一出力。回帰ゲートは scripts/m8_smoke.ts）
// - 入力は RGBA バイト列（ブラウザ=canvas getImageData / CLI=pngjs・jpeg-js）。Node API に依存しない。
// - 出力は既存の Project（v5 保存形式のまま・保存形式変更なし）
import {
  W,
  H,
  PIXELS,
  FPS_TABLE,
  UGO_COLORS,
  RETRO_PALETTE,
  newProject,
  ensureColor,
  allocIndexBuf,
  type Project,
  type Frame,
} from "./model";
// M12-1c-2: アプリが自動で付ける名前は defaults.ts が唯一の出どころ
import { imageLayerName, imageProjectTitle } from "../i18n/defaults";

// ---------------- 型・オプション ----------------

/** 変換元画像（RGBA・任意サイズ） */
export interface SourceImage {
  w: number;
  h: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface ConvertOptions {
  mode: "color" | "tone" | "lineart";
  /** [color] auto の量子化色数（2..255） */
  colors: number;
  palette: "auto" | "ugo" | "retro";
  dither: "fs" | "ordered" | "none";
  fit: "cover" | "contain";
  /** V179 (A-73): 出発点（fit の大きさ）に掛ける倍率。1〜8 に収めて使う。**省略＝1（明示の 1 と 1 画素も同じ）** */
  zoom?: number;
  /** V179 (A-73): 枠の中心に来る元画像の点（元画像の幅・高さに対する割合 0〜1）。**省略＝中央**。
   *  割合で持つ＝大きさの違うページにも同じ構図で効く（連番は全ページ共通） */
  center?: CropCenter;
  /** 紙色 #rrggbb（contain の余白・tone/lineart の地） */
  paper: string;
  /** 複数ページ時の速度（FPS_TABLE の最近傍へ丸め） */
  fps: number;
  title: string;
  /** [tone] 2値化しきい値 0..100 */
  threshold: number;
  /** [tone] ディザ量 0..100（0=ベタ2値・100=全面ディザ） */
  ditherAmt: number;
  /** [tone/lineart] インク色 #rrggbb */
  ink: string;
  /** [tone/lineart] 明暗/線地の反転 */
  invert: boolean;
  /** [lineart] 輪郭検出の強さ 0..100 */
  edge: number;
  /** 共通 -100..100 */
  brightness: number;
  contrast: number;
}

export const DEFAULT_CONVERT: ConvertOptions = {
  mode: "color",
  colors: 24,
  palette: "auto",
  dither: "fs",
  fit: "cover",
  paper: "#ffffff",
  fps: 4,
  title: "",
  threshold: 50,
  ditherAmt: 60,
  ink: "#141414",
  invert: false,
  edge: 50,
  brightness: 0,
  contrast: 0,
};

export type RGB = [number, number, number];

export const hexToRgb = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
export const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
    .join("")}`;

// ---------------- 前処理（明るさ/コントラスト・リサイズ） ----------------

/** brightness/contrast（-100..100）を RGB に適用した写しを返す */
export function applyBC(img: SourceImage, brightness: number, contrast: number): SourceImage {
  if (!brightness && !contrast) return img;
  const out = new Uint8Array(img.data);
  const b = brightness * 1.275;
  const c = contrast * 2.55;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  for (let i = 0; i < out.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = f * (img.data[i + k] - 128) + 128 + b;
      out[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { w: img.w, h: img.h, data: out };
}

// ---------------- V179 (A-73): 取り込む範囲（倍率・位置） ----------------

/** V179: 倍率の範囲。1＝出発点（fit の大きさ）のまま。
 *  上限 8 の理由: 320×240 の 1/8 は 40×30 画素＝それ以上は元画像の数画素を引き伸ばすだけになる */
export const CROP_ZOOM_MIN = 1;
export const CROP_ZOOM_MAX = 8;
/** V179: 倍率スライダーの段（ホイール 1 ノッチ＝1 段）。先頭の 1 がスライダーの既定＝出発点（倍率を使わないときと同じ絵）。
 *  隣どうしの比は 1.14〜1.25 倍（ペンでも狙った段に止めやすく、顔のアップなども刻みすぎずに寄れる） */
export const CROP_ZOOM_STEPS: readonly number[] = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];

/** V179: 枠の中心に来る元画像の点（元画像の幅・高さに対する割合 0〜1） */
export interface CropCenter {
  x: number;
  y: number;
}

/** V179: 倍率を 1〜8 に収める（数でない・NaN は 1＝既定） */
export function clampCropZoom(z: number | undefined): number {
  if (typeof z !== "number" || Number.isNaN(z)) return CROP_ZOOM_MIN;
  return Math.min(CROP_ZOOM_MAX, Math.max(CROP_ZOOM_MIN, z));
}

/** center の 1 軸（数でない・NaN は 0.5＝中央・0〜1 に収める） */
function cropAxis(c: number | undefined): number {
  return typeof c === "number" && !Number.isNaN(c) ? Math.min(1, Math.max(0, c)) : 0.5;
}

/** 1 軸ぶんの置き場所（左上）。枠より小さい（か同じ）軸は**いまどおり中央に固定**。
 *  枠より大きい軸は center の点が枠の真ん中に来る位置を、**隙間ができない範囲 [frame − d, 0]** に収める。
 *  ★丸めは今の式（floor）に合わせる: c = 0.5 のとき floor(frame/2 − d/2) = floor((frame − d)/2)。
 *   round にすると frame − d が奇数のとき 1 ずれる＝既定値でこの回の前と違う絵になる（v179_smoke [S-1]） */
function placeAxis(frame: number, d: number, c: number): number {
  if (d <= frame) return Math.floor((frame - d) / 2);
  return Math.min(0, Math.max(frame - d, Math.floor(frame / 2 - c * d)));
}

/** V179: 元画像を枠のどこに・どの大きさで置くか（出力画素）。
 *  **変換（resizeToCanvas）と、プレビューの素の絵（ドラッグ中の drawImage）が同じこの式を使う**
 *  ＝離したときの絵と取り込んだ結果が同じ所に来る（v179_smoke [S-8]） */
export interface CanvasPlacement {
  /** 置いた大きさ */
  dw: number;
  dh: number;
  /** 置いた左上（枠からはみ出すと負） */
  dx0: number;
  dy0: number;
  /** その軸が枠より大きい＝ドラッグで動かせる */
  movableX: boolean;
  movableY: boolean;
}
export function canvasPlacement(
  w: number,
  h: number,
  fit: "cover" | "contain",
  zoom?: number,
  center?: CropCenter
): CanvasPlacement {
  const s0 = fit === "cover" ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  const scale = s0 * clampCropZoom(zoom);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  return {
    dw,
    dh,
    dx0: placeAxis(W, dw, cropAxis(center?.x)),
    dy0: placeAxis(H, dh, cropAxis(center?.y)),
    movableX: dw > W,
    movableY: dh > H,
  };
}

/** 動かせる軸の center を、隙間ができない範囲 [frame/2d, 1 − frame/2d] に収める（動かせない軸はそのまま） */
function clampCenterAxis(frame: number, d: number, c: number): number {
  if (d <= frame) return c;
  const m = frame / (2 * d);
  return Math.min(1 - m, Math.max(m, c));
}

/** V179: ドラッグ。絵を (dx, dy) 出力画素だけ動かしたあとの center。
 *  端より先へは動かない（行き過ぎをため込まない＝端から戻すとすぐ動く）・動かせない軸は変えない */
export function panCropCenter(
  w: number,
  h: number,
  fit: "cover" | "contain",
  zoom: number | undefined,
  center: CropCenter | undefined,
  dx: number,
  dy: number
): CropCenter {
  const p = canvasPlacement(w, h, fit, zoom, center);
  // 先に「いまの絵の位置」へ収め直してから動かす（別のページで範囲の外になっていた center を持ち越さない）
  const cx = clampCenterAxis(W, p.dw, cropAxis(center?.x));
  const cy = clampCenterAxis(H, p.dh, cropAxis(center?.y));
  return {
    x: p.movableX ? clampCenterAxis(W, p.dw, cx - dx / p.dw) : cx,
    y: p.movableY ? clampCenterAxis(H, p.dh, cy - dy / p.dh) : cy,
  };
}

/** V179: 倍率を変えたあとの center。`anchor`（出力画素の点）を渡すと、その点の下にある元画像の点が動かない
 *  （ホイールはカーソルの位置）。渡さなければ center のまま、新しい倍率で収まる範囲へ収め直すだけ（スライダー） */
export function zoomCropCenter(
  w: number,
  h: number,
  fit: "cover" | "contain",
  zoomFrom: number | undefined,
  zoomTo: number | undefined,
  center: CropCenter | undefined,
  anchor?: { x: number; y: number }
): CropCenter {
  const cx = cropAxis(center?.x);
  const cy = cropAxis(center?.y);
  const to = canvasPlacement(w, h, fit, zoomTo, center);
  if (!anchor)
    return {
      x: clampCenterAxis(W, to.dw, cx),
      y: clampCenterAxis(H, to.dh, cy),
    };
  const from = canvasPlacement(w, h, fit, zoomFrom, center);
  const u = Math.min(1, Math.max(0, (anchor.x - from.dx0) / from.dw));
  const v = Math.min(1, Math.max(0, (anchor.y - from.dy0) / from.dh));
  return {
    x: to.movableX ? clampCenterAxis(W, to.dw, (W / 2 - anchor.x) / to.dw + u) : cx,
    y: to.movableY ? clampCenterAxis(H, to.dh, (H / 2 - anchor.y) / to.dh + v) : cy,
  };
}

// ---------------- V179 (A-73): 取り込みダイアログの操作（DOM に触らない＝v179_smoke で本物を動かせる） ----------------
// ダイアログ（main.ts）は出来事を流し、描く・変換する・表示を合わせるのはここから渡された口で行う。
// ★プレビューの変換（量子化＋ディザ）を呼ぶのは関所 `CropPreviewGate` だけ＝触っている間は走らない。

/** V179: 離してから変換済みの絵へ描き替えるまでの待ち（ms）＝設定を変えたときと同じ */
export const CROP_CONVERT_DELAY_MS = 100;
/** V179: ホイールで倍率を変えたあと、変換済みの絵へ描き替えるまでの待ち（ms）。
 *  回し続けている間（ノッチの間隔はふつう 100ms 以下）に変換が割り込まないよう、離したときより長く待つ */
export const CROP_WHEEL_SETTLE_MS = 250;
/** V179: ホイールの 1 ノッチの量（px・deltaMode 0）。1 ノッチ＝倍率 1 段。
 *  半ノッチ（50）たまったら 1 段進める＝タッチパッドの少しずつの動きもためて 1 段。
 *  まとめて届いた量（回している途中で重なると -300 のように 1 回で届く）は、ノッチの数だけ進める */
export const CROP_WHEEL_NOTCH_PX = 100;

/** V179: プレビューの関所。**触っている間（ドラッグ・倍率スライダー）は変換しない**
 *  （変換は重く、動かすたびに走らせると絵が止まって見える）。そのあいだは素の縮小画を描き、
 *  離したら 100ms 後に変換済みの絵へ描き替える */
export interface CropPreviewGate {
  /** 変換を ms 後に予約する（設定を変えたとき・ホイール）。触っている間なら、離すまで持ち越す */
  schedule(ms?: number): void;
  /** いますぐ変換する（開いた直後・ページ送り）。触っている間なら、離すまで持ち越す */
  now(): void;
  /** ドラッグの始まり。前のドラッグの「離した」が届いていなくても、ここで取り直す（触ったまま止まらない） */
  dragStart(pointerId: number): void;
  /** いまドラッグしているポインタか */
  dragging(pointerId: number): boolean;
  /** 絵が動いた（ドラッグ・倍率）: 素の縮小画を描く。変換は離してから */
  moved(): void;
  /** ドラッグの終わり（ほかのポインタの終わりは無視） */
  dragEnd(pointerId: number): void;
  /** 倍率スライダーを掴んだ／離した */
  slideStart(): void;
  slideEnd(): void;
  /** ダイアログを閉じた: 予約を捨て、以後は何も描かない */
  close(): void;
}
export function createCropPreviewGate(io: {
  drawRaw: () => void;
  convert: () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}): CropPreviewGate {
  let drag: number | null = null;
  let sliding = false;
  /** 触っている間に変換を頼まれた（か絵が動いた）＝離したら変換する */
  let pending = false;
  let closed = false;
  let timer: unknown = null;
  const touching = () => drag !== null || sliding;
  const cancel = () => {
    if (timer !== null) io.clearTimer(timer);
    timer = null;
  };
  const run = () => {
    timer = null;
    if (closed) return;
    if (touching()) {
      pending = true;
      return;
    }
    pending = false;
    io.convert();
  };
  const schedule = (ms = CROP_CONVERT_DELAY_MS) => {
    if (closed) return;
    cancel();
    timer = io.setTimer(run, ms);
  };
  const release = () => {
    if (!touching() && pending) schedule(CROP_CONVERT_DELAY_MS);
  };
  return {
    schedule,
    now() {
      cancel();
      run();
    },
    dragStart(pointerId) {
      drag = pointerId;
    },
    dragging: (pointerId) => drag === pointerId,
    moved() {
      if (closed) return;
      pending = true;
      io.drawRaw();
    },
    dragEnd(pointerId) {
      if (drag !== pointerId) return;
      drag = null;
      release();
    },
    slideStart() {
      sliding = true;
    },
    slideEnd() {
      sliding = false;
      release();
    },
    close() {
      closed = true;
      cancel();
    },
  };
}

/** V179: ダイアログから受け取る口 */
export interface CropIo {
  /** いま表示しているページの元画像の大きさ */
  image(): { w: number; h: number };
  /** 素の縮小画を描く（量子化もディザもしない＝drawImage 1 回・置き場所は canvasPlacement） */
  drawRaw(): void;
  /** 変換済みの絵を描く（量子化＋ディザ・重い）。関所からしか呼ばれない */
  convert(): void;
  /** 倍率の表示・スライダーの位置・カーソル・案内を、いまの状態に合わせる */
  sync(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}
/** V179: 取り込む範囲の操作。位置と倍率は渡された `o`（o.zoom / o.center）に書く＝全ページ共通（決-3）。
 *  **覚えない**（ダイアログを開くたびに新しく作る＝出発点から） */
export interface CropController {
  readonly gate: CropPreviewGate;
  /** いまの倍率の段（CROP_ZOOM_STEPS の添字） */
  zoomIndex(): number;
  /** いま表示しているページの置き場所 */
  placement(): CanvasPlacement;
  /** 倍率を段 i へ（anchor＝枠の画素の点。その下の絵を動かさない）。変わったら素の縮小画を描いて true */
  zoomTo(i: number, anchor?: { x: number; y: number }): boolean;
  /** 絵を (dx, dy) 枠の画素だけ動かす（1 画素未満もためる）。絵が動いたら素の縮小画を描いて true */
  panBy(dx: number, dy: number): boolean;
  /** 「位置を戻す」: 出発点（倍率 1・中央）へ。表示を合わせ、素の縮小画をすぐ描く（変換は呼び出し側の予約で）。
   *  もう出発点なら何もせず false */
  reset(): boolean;
  /** 2 択（画面いっぱい／全体を入れる）の切り替え。違うときだけ切り替えて出発点へ（持ち越すと意味が変わる）。
   *  表示を合わせ、素の縮小画をすぐ描く */
  setFit(fit: "cover" | "contain"): void;
  /** ページ送り: 表示（動かせるか・案内）をそのページに合わせ、変換する（触っている間なら離すまで持ち越す）。
   *  倍率と位置は全ページ共通のまま */
  pageChanged(): void;
  /** ホイールの 1 回分。1 段ぶんたまったら倍率を 1 段変え、少し待ってから変換する */
  wheel(deltaY: number, deltaMode: number, anchor: { x: number; y: number }): void;
}
export function createCropController(o: ConvertOptions, io: CropIo): CropController {
  const gate = createCropPreviewGate(io);
  let zoomIdx = 0;
  let wheelAcc = 0;
  const placement = () => {
    const im = io.image();
    return canvasPlacement(im.w, im.h, o.fit, o.zoom, o.center);
  };
  const toStart = () => {
    o.zoom = CROP_ZOOM_STEPS[0];
    o.center = { x: 0.5, y: 0.5 };
    zoomIdx = 0;
    wheelAcc = 0;
  };
  const ctl: CropController = {
    gate,
    zoomIndex: () => zoomIdx,
    placement,
    zoomTo(i, anchor) {
      if (typeof i !== "number" || !Number.isFinite(i)) return false;
      const ni = Math.max(0, Math.min(CROP_ZOOM_STEPS.length - 1, Math.round(i)));
      if (ni === zoomIdx) return false;
      const im = io.image();
      o.center = zoomCropCenter(im.w, im.h, o.fit, CROP_ZOOM_STEPS[zoomIdx], CROP_ZOOM_STEPS[ni], o.center, anchor);
      o.zoom = CROP_ZOOM_STEPS[ni];
      zoomIdx = ni;
      io.sync();
      gate.moved();
      return true;
    },
    panBy(dx, dy) {
      const before = placement();
      const im = io.image();
      o.center = panCropCenter(im.w, im.h, o.fit, o.zoom, o.center, dx, dy);
      const after = placement();
      if (after.dx0 === before.dx0 && after.dy0 === before.dy0) return false; // 端・動かせない軸・1 画素未満
      gate.moved();
      return true;
    },
    reset() {
      const c = o.center;
      if (zoomIdx === 0 && (!c || (c.x === 0.5 && c.y === 0.5))) return false;
      toStart();
      io.sync();
      gate.moved(); // 表示と絵を揃える（倍率の表示だけ先に変わって絵が古いまま、を作らない）
      return true;
    },
    setFit(fit) {
      if (o.fit === fit) return;
      o.fit = fit;
      toStart();
      io.sync();
      gate.moved();
    },
    pageChanged() {
      io.sync();
      gate.now();
    },
    wheel(deltaY, deltaMode, anchor) {
      // 行単位（deltaMode 1）は 1 行 40px 相当（3 行＝1 ノッチ）・ページ単位（2）は 1 ページ＝1 ノッチ
      const d = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * CROP_WHEEL_NOTCH_PX : deltaY;
      if (!d) return;
      if (Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0; // 向きが変わったらためた分を捨てる
      wheelAcc += d;
      if (Math.abs(wheelAcc) < CROP_WHEEL_NOTCH_PX / 2) return;
      const steps = Math.max(1, Math.floor(Math.abs(wheelAcc) / CROP_WHEEL_NOTCH_PX));
      const dir = wheelAcc < 0 ? 1 : -1; // 奥へ回す＝拡大
      wheelAcc = 0;
      if (ctl.zoomTo(zoomIdx + dir * steps, anchor)) gate.schedule(CROP_WHEEL_SETTLE_MS);
    },
  };
  return ctl;
}

/** V179: プレビューの canvas が受ける出来事（DOM の PointerEvent / WheelEvent の形だけ借りる＝スモークで偽物を渡せる） */
export interface CropPointerEvent {
  pointerId: number;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}
export interface CropWheelEvent {
  deltaY: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}
export type CropPointerType = "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture";
/** V179: プレビューの canvas との口（main.ts が canvas の addEventListener 等をそのまま渡す） */
export interface CropCanvasPort {
  onPointer(type: CropPointerType, fn: (e: CropPointerEvent) => void): void;
  /** ★`{ passive: false }` で付けること（preventDefault でダイアログのスクロールを止めるため） */
  onWheel(fn: (e: CropWheelEvent) => void): void;
  capture(pointerId: number): void;
  /** クライアント座標 → 枠の画素（表示の倍率・枠線を除いて） */
  toCanvas(clientX: number, clientY: number): { x: number; y: number };
  /** 掴んでいる間のカーソル（grabbing） */
  grabbing(on: boolean): void;
}
/** V179: ドラッグ（pointer events＝マウス・ペン・タッチを同じ道で・捕捉）とホイールをプレビューに付ける */
export function bindCropCanvas(port: CropCanvasPort, ctl: CropController): void {
  let last = { x: 0, y: 0 };
  port.onPointer("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      port.capture(e.pointerId);
    } catch {
      /* 捕捉できなくてもドラッグは続けられる（キャンバスの外へ出ると止まるだけ） */
    }
    last = port.toCanvas(e.clientX, e.clientY);
    ctl.gate.dragStart(e.pointerId); // 前のドラッグの「離した」が届いていなくても、ここで取り直す
    port.grabbing(true);
  });
  const end = (e: CropPointerEvent) => {
    if (!ctl.gate.dragging(e.pointerId)) return;
    ctl.gate.dragEnd(e.pointerId); // 動いていたら 100ms 後に変換済みの絵へ
    port.grabbing(false);
  };
  port.onPointer("pointermove", (e) => {
    if (!ctl.gate.dragging(e.pointerId)) return;
    // ボタンが離れているのに「離した」が届いていない（窓の外で離した等）→ ここで終える（触ったまま止まらない）
    if (e.buttons === 0) {
      end(e);
      return;
    }
    const p = port.toCanvas(e.clientX, e.clientY);
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    last = p;
    ctl.panBy(dx, dy); // 絵は指についてくる・端より先へは動かない
  });
  port.onPointer("pointerup", end);
  port.onPointer("pointercancel", end);
  port.onPointer("lostpointercapture", end);
  // ホイール: プレビューの上でだけ効く（ここで既定の動き＝ダイアログのスクロールを止める。外には付けない）。
  // 1 ノッチ＝スライダー 1 段・カーソルの下の絵が動かないように拡大する
  port.onWheel((e) => {
    e.preventDefault();
    ctl.wheel(e.deltaY, e.deltaMode, port.toCanvas(e.clientX, e.clientY));
  });
}
/** V179: 倍率スライダー（createSlider）に渡す口。掴んでいる間は変換しない。値が変わらずに離しても、窓の pointerup で必ず解く */
export function cropSliderHandlers(
  ctl: CropController,
  win: {
    addEventListener(type: "pointerup" | "pointercancel", fn: () => void): void;
    removeEventListener(type: "pointerup" | "pointercancel", fn: () => void): void;
  }
): { onDown: () => void; onInput: (i: number) => void; onChange: () => void } {
  return {
    onDown: () => {
      ctl.gate.slideStart();
      const up = () => {
        win.removeEventListener("pointerup", up);
        win.removeEventListener("pointercancel", up);
        ctl.gate.slideEnd();
      };
      win.addEventListener("pointerup", up);
      win.addEventListener("pointercancel", up);
    },
    onInput: (i) => {
      ctl.zoomTo(i);
    },
    // キーボード（矢印キー）は押すたびに change が来る＝そのつど予約（掴んでいる間なら関所が持ち越す）
    onChange: () => ctl.gate.schedule(),
  };
}

/** V179: プレビューの canvas 要素の形（DOM の型は使わない＝形だけ借りる。スモークで偽物を渡せる） */
export interface CropCanvasElementLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, fn: (e: any) => void, opts?: { passive?: boolean }): void;
  setPointerCapture(pointerId: number): void;
  getBoundingClientRect(): { left: number; top: number };
  readonly clientLeft: number;
  readonly clientTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly classList: { toggle(token: string, force?: boolean): boolean };
}
/** V179: canvas 要素から `bindCropCanvas` の口を作る。ホイールは **`passive: false`**（preventDefault でダイアログの
 *  スクロールを止めるため）。座標は枠線（clientLeft/Top）を除いた描画域の幅・高さで割る＝2 倍表示でも幅いっぱいでも同じ */
export function cropCanvasPort(cv: CropCanvasElementLike, grabbingClass: string): CropCanvasPort {
  return {
    onPointer: (type, fn) => cv.addEventListener(type, fn),
    onWheel: (fn) => cv.addEventListener("wheel", fn, { passive: false }),
    capture: (pointerId) => cv.setPointerCapture(pointerId),
    toCanvas: (clientX, clientY) => {
      const r = cv.getBoundingClientRect();
      return {
        x: ((clientX - r.left - cv.clientLeft) * W) / (cv.clientWidth || W),
        y: ((clientY - r.top - cv.clientTop) * H) / (cv.clientHeight || H),
      };
    },
    grabbing: (on) => {
      cv.classList.toggle(grabbingClass, on);
    },
  };
}
/** V179: ダイアログのプレビューに、取り込む範囲の操作一式を付けて返す。**main.ts はこれ 1 つを呼ぶ**
 *  （操作を作る・canvas に受け口を付ける・スライダーの口を作る、を 1 か所で＝付け忘れが起きない） */
export function createCropPreview(
  o: ConvertOptions,
  io: CropIo,
  cv: CropCanvasElementLike,
  grabbingClass: string,
  win: {
    addEventListener(type: "pointerup" | "pointercancel", fn: () => void): void;
    removeEventListener(type: "pointerup" | "pointercancel", fn: () => void): void;
  }
): { ctl: CropController; slider: { onDown: () => void; onInput: (i: number) => void; onChange: () => void } } {
  const ctl = createCropController(o, io);
  bindCropCanvas(cropCanvasPort(cv, grabbingClass), ctl);
  return { ctl, slider: cropSliderHandlers(ctl, win) };
}

/** V179: 1 軸ぶん、出力の画素 k（from ≤ k < to）が平均する元画像の画素の範囲 [lo, hi]（2 つずつ並べる）。
 *  d = 置いた大きさ・s = 元画像の大きさ */
function sourceSpans(d: number, s: number, from: number, to: number, zoomed: boolean): Int32Array {
  const spans = new Int32Array(Math.max(0, to - from) * 2);
  for (let k = from; k < to; k++) {
    let lo: number, hi: number;
    if (!zoomed) {
      // 倍率 1（既定）: V182 (A-79) で、下の縮小の枝と同じ整数の割り算にした（拡大・縮小どちらも）。
      //（前の (k / d) * s は浮動小数の丸めで、1:1・2 倍・半分でも隣の画素を拾って混ぜることがあった＝v182_smoke [S-1]）
      // 等倍でない拡大（256×192 など）は面積平均のまま＝境目の画素は混ざる（最近傍にはしない・作者決定 G-2・[S-3]）
      // (k + 1)·s が 2^53 を超える極端な大きさ（CLI・MCP だけで届く。画面の取り込みは長辺 4096 で届かない）は、
      // 掛け算そのものが丸まって範囲が 1 画素ずれるので BigInt で求める（例 24,333,387×7・v182_smoke [S-4]）
      if ((k + 1) * s <= Number.MAX_SAFE_INTEGER) {
        lo = Math.floor((k * s) / d);
        hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) * s) / d) - 1));
      } else {
        const S = BigInt(s);
        const D = BigInt(d);
        lo = Number((BigInt(k) * S) / D);
        hi = Math.min(s - 1, Math.max(lo, Number((BigInt(k + 1) * S + D - 1n) / D) - 1));
      }
    } else if (d > s) {
      // 拡大: 最近傍＝出力の画素の中心に乗る元の 1 画素（にじまない・素の絵の drawImage と同じ画素）
      lo = hi = Math.min(s - 1, Math.floor(((2 * k + 1) * s) / (2 * d)));
    } else {
      // 縮小（と 1:1）: 面積平均。範囲は整数の割り算で求める
      //（前の式は (k / d) * s の丸めで、1:1 や 2 分の 1 でも隣の画素を拾って 3 画素の平均になることがある）
      lo = Math.floor((k * s) / d);
      hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) * s) / d) - 1));
    }
    spans[(k - from) * 2] = lo;
    spans[(k - from) * 2 + 1] = hi;
  }
  return spans;
}

/** 320×240 へリサイズ（面積平均）。cover=中央クロップ / contain=余白は alpha=0（=紙が透ける）
 *  V179 (A-73): `zoom`・`center`（省略可）で「どこを切り取るか」を動かす。**省略＝倍率 1・中央（明示の既定値と 1 画素も同じ）**。
 *  倍率を上げたときは、拡大の軸（元画像の 1 画素が出力の 1 画素より大きい）が**最近傍＝にじまない**
 *  （面積平均のままだと、整数倍でない拡大で境目の画素が 2 色の平均になる）。倍率 1 は面積平均のまま
 *  （V182: 範囲は整数の割り算＝1:1・整数倍・整数分の 1 がぴったり入る。等倍でない拡大は境目が混ざる） */
export function resizeToCanvas(
  img: SourceImage,
  fit: "cover" | "contain",
  zoom?: number,
  center?: CropCenter
): SourceImage {
  const out = new Uint8Array(W * H * 4);
  const { dw, dh, dx0, dy0 } = canvasPlacement(img.w, img.h, fit, zoom, center);
  const zoomed = clampCropZoom(zoom) > 1;
  // 枠に入る範囲だけ回す（枠の外の画素は従来も continue で何もしていない＝出力は同じ。拡大で dw が大きくても速い）
  const dxS = Math.max(0, -dx0);
  const dyS = Math.max(0, -dy0);
  const xs = sourceSpans(dw, img.w, dxS, Math.min(dw, W - dx0), zoomed);
  const ys = sourceSpans(dh, img.h, dyS, Math.min(dh, H - dy0), zoomed);
  for (let j = 0; j < ys.length; j += 2) {
    const oy = dy0 + dyS + j / 2;
    const yA = ys[j];
    const yB = ys[j + 1];
    for (let i = 0; i < xs.length; i += 2) {
      const ox = dx0 + dxS + i / 2;
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      const xA = xs[i];
      const xB = xs[i + 1];
      for (let sy = yA; sy <= yB; sy++)
        for (let sx = xA; sx <= xB; sx++) {
          const si = (sy * img.w + sx) * 4;
          r += img.data[si];
          g += img.data[si + 1];
          b += img.data[si + 2];
          n++;
        }
      const oi = (oy * W + ox) * 4;
      out[oi] = r / n;
      out[oi + 1] = g / n;
      out[oi + 2] = b / n;
      out[oi + 3] = 255;
    }
  }
  return { w: W, h: H, data: out };
}

/** 前処理一括: BC → 320×240（GUI/CLI/シートで共用）。V179: 倍率・位置（省略可）も通す */
export function prepareCanvas(img: SourceImage, o: ConvertOptions): SourceImage {
  return resizeToCanvas(applyBC(img, o.brightness, o.contrast), o.fit, o.zoom, o.center);
}

// ---------------- color モード（median-cut 量子化＋ディザ） ----------------

/** median-cut 量子化（不透明画素のみ・N色） */
export function medianCut(imgs: SourceImage[], n: number): RGB[] {
  const px: RGB[] = [];
  for (const img of imgs)
    for (let i = 0; i < img.data.length; i += 4)
      if (img.data[i + 3] > 0) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  if (!px.length) return [[0, 0, 0]];
  let boxes: RGB[][] = [px];
  while (boxes.length < n) {
    let bi = -1,
      bAxis = 0,
      bRange = -1;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let a = 0; a < 3; a++) {
        let lo = 255,
          hi = 0;
        for (const p of box) {
          if (p[a] < lo) lo = p[a];
          if (p[a] > hi) hi = p[a];
        }
        if (hi - lo > bRange) {
          bRange = hi - lo;
          bi = i;
          bAxis = a;
        }
      }
    });
    if (bi < 0 || bRange <= 0) break;
    const box = boxes[bi];
    box.sort((p, q) => p[bAxis] - q[bAxis]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    let r = 0,
      g = 0,
      b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n2 = box.length || 1;
    return [Math.round(r / n2), Math.round(g / n2), Math.round(b / n2)] as RGB;
  });
}

function nearestIdx(pal: RGB[], r: number, g: number, b: number): number {
  let best = 0,
    bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const dr = r - pal[i][0],
      dg = g - pal[i][1],
      db = b - pal[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** 変換に使うパレットを決定（auto=全ページまとめて量子化＝アニメでちらつかない） */
export function resolvePalette(canvases: SourceImage[], o: ConvertOptions): RGB[] {
  if (o.palette === "ugo") return Object.values(UGO_COLORS).map(hexToRgb);
  // M11-14b: 既定パレットが6色になったので、「レトロ14色」は独立した RETRO_PALETTE を使う
  //（中身は従来の DEFAULT_PALETTE と同一＝ドット化の結果は変わらない）
  if (o.palette === "retro") return RETRO_PALETTE.map(hexToRgb);
  return medianCut(canvases, Math.max(2, Math.min(255, o.colors)));
}

/** RGBA(320×240) → パレット index 配列（-1=透明） */
export function quantizeFrame(
  img: SourceImage,
  pal: RGB[],
  dither: ConvertOptions["dither"]
): Int16Array {
  const out = new Int16Array(PIXELS).fill(-1);
  if (dither === "fs") {
    const buf = new Float32Array(PIXELS * 3);
    for (let i = 0; i < PIXELS; i++) {
      buf[i * 3] = img.data[i * 4];
      buf[i * 3 + 1] = img.data[i * 4 + 1];
      buf[i * 3 + 2] = img.data[i * 4 + 2];
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (img.data[i * 4 + 3] === 0) continue;
        const r = buf[i * 3],
          g = buf[i * 3 + 1],
          b = buf[i * 3 + 2];
        const pi = nearestIdx(pal, r, g, b);
        out[i] = pi;
        const er = r - pal[pi][0],
          eg = g - pal[pi][1],
          eb = b - pal[pi][2];
        const spread = (di: number, w8: number) => {
          buf[di * 3] += (er * w8) / 16;
          buf[di * 3 + 1] += (eg * w8) / 16;
          buf[di * 3 + 2] += (eb * w8) / 16;
        };
        if (x + 1 < W) spread(i + 1, 7);
        if (y + 1 < H) {
          if (x > 0) spread(i + W - 1, 3);
          spread(i + W, 5);
          if (x + 1 < W) spread(i + W + 1, 1);
        }
      }
    }
  } else {
    const amp = dither === "ordered" ? 24 : 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (img.data[i * 4 + 3] === 0) continue;
        const o = amp ? (BAYER4[y & 3][x & 3] / 16 - 0.5) * amp : 0;
        out[i] = nearestIdx(
          pal,
          img.data[i * 4] + o,
          img.data[i * 4 + 1] + o,
          img.data[i * 4 + 2] + o
        );
      }
  }
  return out;
}

// ---------------- tone / lineart モード ----------------

export function toGray(img: SourceImage): Float32Array {
  const g = new Float32Array(PIXELS).fill(-1); // -1 = 透明
  for (let i = 0; i < PIXELS; i++) {
    if (img.data[i * 4 + 3] === 0) continue;
    g[i] =
      0.299 * img.data[i * 4] +
      0.587 * img.data[i * 4 + 1] +
      0.114 * img.data[i * 4 + 2];
  }
  return g;
}

/** さつえい再現: しきい値±ディザ量で ink(true)/paper(false) の2値へ。null=透明 */
export function toneBinarize(
  gray: Float32Array,
  threshold: number,
  ditherAmt: number,
  ditherMode: ConvertOptions["dither"],
  invert: boolean
): (boolean | null)[] {
  const t = threshold * 2.55;
  const k = ditherAmt / 100;
  const out: (boolean | null)[] = new Array(PIXELS).fill(null);
  if (ditherMode === "ordered") {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (gray[i] < 0) continue;
        const o = (BAYER4[y & 3][x & 3] / 16 - 0.5) * 255 * k;
        let ink = gray[i] + o < t;
        if (invert) ink = !ink;
        out[i] = ink;
      }
    return out;
  }
  // fs（既定）: 誤差拡散の強さを k 倍 → 0=ベタ2値 ⇔ 100=全面ディザ の連続変化
  const buf = Float32Array.from(gray);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (gray[i] < 0) continue;
      const v = buf[i];
      const ink0 = v < t;
      const err = (v - (ink0 ? 0 : 255)) * k;
      if (ditherMode === "fs" && k > 0) {
        if (x + 1 < W && gray[i + 1] >= 0) buf[i + 1] += (err * 7) / 16;
        if (y + 1 < H) {
          if (x > 0 && gray[i + W - 1] >= 0) buf[i + W - 1] += (err * 3) / 16;
          if (gray[i + W] >= 0) buf[i + W] += (err * 5) / 16;
          if (x + 1 < W && gray[i + W + 1] >= 0) buf[i + W + 1] += (err * 1) / 16;
        }
      }
      out[i] = invert ? !ink0 : ink0;
    }
  return out;
}

/** Sobel 輪郭 → ink(true)/地(false)。edge 0..100 で線の出やすさ */
export function lineartBinarize(
  gray: Float32Array,
  edge: number,
  invert: boolean
): (boolean | null)[] {
  const mag = new Float32Array(PIXELS);
  const g = (x: number, y: number) => {
    const i = Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x));
    return gray[i] < 0 ? 255 : gray[i];
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const gx =
        -g(x - 1, y - 1) - 2 * g(x - 1, y) - g(x - 1, y + 1) +
        g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1);
      const gy =
        -g(x - 1, y - 1) - 2 * g(x, y - 1) - g(x + 1, y - 1) +
        g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1);
      mag[y * W + x] = Math.hypot(gx, gy) / 4;
    }
  const t = 255 * (1 - edge / 100) + 8; // edge=100 でも微小ノイズは拾わない
  const out: (boolean | null)[] = new Array(PIXELS).fill(null);
  for (let i = 0; i < PIXELS; i++) {
    if (gray[i] < 0) continue;
    let ink = mag[i] > t;
    if (invert) ink = !ink;
    out[i] = ink;
  }
  return out;
}

// ---------------- Project 組み立て・合成 ----------------

/** 変換一式: 元画像群＋オプション → 素材集 Project（「背景」1レイヤー×ページ数） */
export function convertToProject(images: SourceImage[], o: ConvertOptions): Project {
  const canvases = images.map((img) => prepareCanvas(img, o));
  const p = newProject(o.title || imageProjectTitle());
  p.layerDefs = [{ id: "L1", name: imageLayerName(), visible: true, opacity: 1 }];
  p.nextLayerId = 2;
  p.colorTable = [""];
  p.indexBits = 8;
  p.frames = [];
  p.loop = true;
  let best = 0;
  FPS_TABLE.forEach((f, i) => {
    if (Math.abs(f - o.fps) < Math.abs(FPS_TABLE[best] - o.fps)) best = i;
  });
  p.speedIndex = best;
  const paperIdx = ensureColor(p, o.paper);

  if (o.mode === "color") {
    p.colorMode = "fullcolor";
    const pal = resolvePalette(canvases, o);
    for (const cv of canvases) {
      const indices = quantizeFrame(cv, pal, o.dither);
      // 色解決 → バッファ取得の順（昇格でバッファ幅が変わるため）
      const colorIdx = pal.map((c) => ensureColor(p, rgbToHex(c[0], c[1], c[2])));
      const frame: Frame = { paper: paperIdx, layers: {} };
      const buf = allocIndexBuf(p);
      for (let i = 0; i < PIXELS; i++) {
        const q = indices[i];
        buf[i] = q < 0 ? 0 : colorIdx[q];
      }
      frame.layers["L1"] = buf;
      p.frames.push(frame);
    }
  } else {
    p.colorMode = "palette";
    const inkIdx = ensureColor(p, o.ink);
    for (const cv of canvases) {
      const gray = toGray(cv);
      const bin =
        o.mode === "tone"
          ? toneBinarize(gray, o.threshold, o.ditherAmt, o.dither === "none" ? "fs" : o.dither, o.invert)
          : lineartBinarize(gray, o.edge, o.invert);
      const frame: Frame = { paper: paperIdx, layers: {} };
      const buf = allocIndexBuf(p);
      for (let i = 0; i < PIXELS; i++) buf[i] = bin[i] === true ? inkIdx : 0;
      frame.layers["L1"] = buf;
      p.frames.push(frame);
    }
  }
  return p;
}

/** 変換結果の1ページを RGBA(320×240) へ合成（プレビュー/サムネ用。紙→背景レイヤー） */
export function frameToRgba(p: Project, fi: number): Uint8Array {
  const rgba = new Uint8Array(PIXELS * 4);
  const paper = hexToRgb(p.colorTable[p.frames[fi].paper] || "#ffffff");
  const buf = p.frames[fi].layers["L1"];
  for (let i = 0; i < PIXELS; i++) {
    const ci = buf[i];
    const c = ci > 0 ? hexToRgb(p.colorTable[ci]) : paper;
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
