// V191（A-89・1px のペン・消しゴムの線から L 字の角をなくす）の回帰ゲート。引数不要:
//   npx tsx scripts/v191_smoke.ts
//
// 1px の線の「曲がる所・継ぎ目に 1 画素ずつ足される L 字の角」（2×2 の窓に 3 画素）が、うごメモの 30 倍以上あった
// （REQ_1px_line §4-4: うごメモ 0.7・メモアニマ v1.9.0 27.7／100 画素あたり）。直し方は「描く前に決める」
// （§6-1: いちばん新しい画素を仮にして、次の画素が確定した直前の画素と隣り合うなら仮は描かない）。
//
// ★見方: **本物の editor.ts を Node で動かす**（V178 の舞台を借りる）。`Editor` を new して `onPointerDown/Move/Up` に
//  点の列を流し、レイヤーの画素を数える。点の列は検査のための写しを通さず、**エディタと同じ関数**を通る。
//  「今の打ち方」は `raster.ts` の `strokeSegment` を点の列の順に引いたもの（= v1.9.0 のエディタ。[S-2b] で旧版の
//  editor.ts そのものと 1 画素も違わないことを確かめる）。
//
// 数えるもの（REQ §4-4 と同じ）:
//   L   … 2×2 の窓に 3 画素が入っている数（100 画素あたり）
//   近3 … 8 近傍に 3 画素以上ある画素の割合
//   塊  … 8 連結の塊の数（1 ＝途切れない）
//
// [S-1]  src/editor/raster.ts のハッシュが V191 を始める前と同じ（＝V174 時点・2px 以上と直線・図形を作りで守る）
// [S-2]  ★今の打ち方で、全部の組み合わせが L > 8（この検査が今の線を捕まえる）
//        [S-2b] 旧版の editor.ts（V191 の前）で同じ点の列を流すと、今の打ち方と 1 画素も違わない
// [S-3]  ★新しい道（本物のエディタ・手ブレ補正オフ）で、手ぶれ 0.15 は L ≤ 1.0・近3 ≤ 2%、
//        手ぶれ 0.3 は L ≤ 4.0・近3 ≤ 8%、どれも塊 1 つ。手ブレ補正オンでも塊 1 つ（数は報告）
// [S-4]  端と描き終わりの漏斗: 最初の画素＝押した位置・最後の画素＝最後の点の Math.round。離す前は最後の画素が
//        出ていない（仮）→ 離すと出る。取り消し 1 回で全部戻り・やり直しで最後の画素まで戻る（K-7）。
//        離したあとの線＝離す前に見えていた線＋最大 1 画素（K-8）。endPointerSession・UI を押した（全レイヤーの束の確定）・
//        途中で道具が変わった、のどれで終わっても最後の画素が出る。押した位置 pt と round(lastPt) が一致する（A-70）
// [S-5]  交差: 8 の字と輪で、同じなぞりで先に描いた画素が 1 つも消えない・塊 1 つ
// [S-6]  消しゴム（K-3）: 全面を塗ったバッファを同じ点の列で消すと、消えた画素＝ペンで描いた画素。全レイヤーでも同じ
// [S-7]  ★太さ 2・3・5・8・12・全部の種類・トーン・マイ柄・選択範囲・筆圧（太さ 2 以上のまま）・ブラシ（太さ 1 も）・
//        全レイヤー消しゴムで、エディタの出力が V191 の前と 1 バイトも同じ（K-4）
// [S-8]  筆圧で 1→2→1 と変わる点の列で、途切れない・最後の画素が出る・1px の区間は L 字の角が出ない
// [S-9]  点線: 長さ 100 の直線・円で、点の数と間隔を今と並べて出す（報告用。0 個・全部つながりは赤）
// [S-10] 選択範囲: 選択の外の画素が 1 つも変わらない（ペン・消しゴム・全レイヤー消しゴム）
// [S-11] 静的: onPointerUp で漏斗が `switch (this.tool)`・`commitEraseAll()`・`pushBufferHistory("描画"` より前／
//        finishEraseAllNow で `commitEraseAll()` より前／pointerdown の網で `commitEraseAll()` より前／mount で状態を捨てる／
//        新しいモジュールを呼ぶのはペン系の道だけ
// [S-0]  無改変の写しでは [S-12] が見る検査が全部緑（写しの仕組みが赤を作っていない）
// [S-12] ★反証（写しで壊して赤を見る）: ①「L 字のときだけ」→[S-3] ②漏斗を呼ばない→[S-4] ③太さ 2 にも新しい道→[S-7]
//        ④描いた画素を後から戻す形→[S-5] ⑤漏斗を pushBufferHistory の後ろへ→[S-11]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { editorFileHaving, readEditorSource } from "./editorSource";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}
type V = { ok: boolean; why: string; threw?: boolean };
const ok = (): V => ({ ok: true, why: "" });
const ng = (why: string): V => ({ ok: false, why });
/** 検査を走らせる。**例外は赤**（ただし反証では「効いた」と数えない＝threw で見分ける） */
async function safe(fn: () => Promise<V> | V): Promise<V> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, why: `例外: ${String((e as Error)?.message ?? e).slice(0, 160)}`, threw: true };
  }
}

const root = path.resolve(import.meta.dirname, "..");
const REPORT = process.argv.includes("--report"); // 表を全部出す（報告書用）

// ================= 本物の editor.ts を Node で動かすための最小の舞台（V178 と同じ） =================
const G = globalThis as unknown as Record<string, unknown>;
G.self = G; // exporter.ts が読む gif.js（ブラウザ前提・self 参照）
G.window = G; // editor.ts の window.setTimeout 等
G.devicePixelRatio = 1;
const cursorCtx = {
  fillStyle: "",
  imageSmoothingEnabled: false,
  clearRect() {},
  fillRect() {},
};
const CURSOR_CV = { width: 0, height: 0, hidden: true, getContext: () => cursorCtx };
/** `#ed-canvas`。矩形は 320×240 ちょうど＝クライアント座標 x+0.5 → 描線の座標 x（clientToStrokePt の半画素ずらし） */
const CANVAS = {
  offsetWidth: 960,
  offsetHeight: 720,
  style: {} as Record<string, string>,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
};
const CVWRAP = {
  style: {} as Record<string, string>,
  captured: null as number | null,
  setPointerCapture(id: number) {
    this.captured = id;
  },
  releasePointerCapture(id: number) {
    if (this.captured === id) this.captured = null;
  },
  addEventListener() {},
  removeEventListener() {},
};
G.document = {
  querySelector: (sel: string) =>
    sel === "#ed-canvas" ? CANVAS : sel === "#ed-cursor" ? CURSOR_CV : sel === "#ed-cvwrap" ? CVWRAP : null,
  querySelectorAll: () => [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = Record<string, any>;
type Buf = Uint8Array | Uint16Array;
interface Tree {
  label: string;
  dir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Editor: any;
  M: Mod;
  R: Mod;
  editorSrc: string;
}
async function loadTree(dir: string, label: string): Promise<Tree> {
  const u = (p: string) => pathToFileURL(path.join(dir, p)).href;
  const E = await import(u("src/editor/editor.ts"));
  const M = await import(u("src/editor/model.ts"));
  const R = await import(u("src/editor/raster.ts"));
  // ★V213 (M-2a): 描く処理はコア（src/editor/core/editorCore.ts）へ移った＝editor.ts とコアの字を順に並べたもの（[S-11] が読む）
  const editorSrc = readEditorSource(dir);
  return { label, dir, Editor: E.Editor, M, R, editorSrc };
}

// ================= 写し（無改変・旧版・反証）の置き場 =================
const WORK = path.join(
  process.env.V191_SMOKE_WORK || path.join(root, "node_modules", ".v191-smoke"),
  String(process.pid)
);
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
process.on("exit", () => {
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
    const parent = path.dirname(WORK);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
    /* 片付けの失敗は検査の結果を変えない */
  }
});
function copySrc(dest: string): void {
  fs.cpSync(path.join(root, "src"), path.join(dest, "src"), {
    recursive: true,
    filter: (s) => fs.statSync(s).isDirectory() || s.endsWith(".ts"),
  });
}
interface Edit {
  file: string;
  from: string;
  to: string;
}
let mutSeq = 0;
/** src/ を写して `edits` を当てた木を読み込む。書き換えは**ちょうど 1 か所**に当たること */
async function mutant(edits: Edit[]): Promise<{ tree: Tree | null; why: string }> {
  const dir = path.join(WORK, `m${++mutSeq}`);
  copySrc(dir);
  for (const e of edits) {
    const f = path.join(dir, e.file);
    const text = fs.readFileSync(f, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const from = e.from.replace(/\n/g, eol);
    const n = text.split(from).length - 1;
    if (n !== 1) return { tree: null, why: `書き換えが当たらない（${n} 箇所）: ${e.from.trim().slice(0, 70)}` };
    fs.writeFileSync(f, text.replace(from, () => e.to.replace(/\n/g, eol)));
  }
  return { tree: await loadTree(dir, `m${mutSeq}`), why: "" };
}

// ================= 道具 =================
const W = 320;
const H = 240;
const PIXELS = W * H;
const bytesOf = (b: Buf) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const shaOf = (...bs: Buf[]) => {
  const h = crypto.createHash("sha256");
  for (const b of bs) h.update(bytesOf(b));
  return h.digest("hex");
};
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rectMask = (x0: number, y0: number, x1: number, y1: number) => {
  const m = new Uint8Array(PIXELS);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
};
/** 0/1 の並び（描いた画素＝0 でない） */
const drawnMask = (b: Buf) => {
  const m = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) m[i] = 1;
  return m;
};
/** なぞって 0 になった画素（元から 0 だった画素は数えない） */
const zeroMask = (b: Buf, from: Buf) => {
  const m = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) if (b[i] === 0 && from[i] !== 0) m[i] = 1;
  return m;
};
const popcount = (m: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
};

interface Metrics {
  n: number;
  L: number;
  near3: number;
  clusters: number;
}
/** REQ §4-4 と同じ数え方。`region` があればその中の画素だけ数える（窓は左上の画素で判定） */
function metrics(m: Uint8Array, region?: (x: number, y: number) => boolean): Metrics {
  const on = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] ? 1 : 0);
  let n = 0;
  let L = 0;
  let n3 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (region && !region(x, y)) continue;
      if (on(x, y)) {
        n++;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) k += on(x + dx, y + dy);
        if (k >= 3) n3++;
      }
      if (on(x, y) + on(x + 1, y) + on(x, y + 1) + on(x + 1, y + 1) === 3) L++;
    }
  // 8 連結の塊
  const seen = new Uint8Array(PIXELS);
  let clusters = 0;
  for (let i = 0; i < PIXELS; i++) {
    if (!m[i] || seen[i]) continue;
    if (region && !region(i % W, (i / W) | 0)) continue;
    clusters++;
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const j = st.pop()!;
      const x = j % W;
      const y = (j / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (region && !region(xx, yy)) continue;
          const k = yy * W + xx;
          if (m[k] && !seen[k]) {
            seen[k] = 1;
            st.push(k);
          }
        }
    }
  }
  return { n, L: n ? (L / n) * 100 : 0, near3: n ? (n3 / n) * 100 : 0, clusters };
}

// ================= 点の列（乱数の種を固定） =================
type Pt = [number, number];
const SHAPES = ["circle", "wave", "diag"] as const;
const SPEEDS = [0.005, 0.01, 0.03, 0.08] as const;
const JITTERS = [0.15, 0.3] as const;
/** 1 点あたりの進み `step`（ラジアン）で、`shape` をなぞる点の列。手ぶれは標準偏差 `jit` px の正規分布（Box–Muller）。
 *  円 = 中心 (160,120)・半径 80 を 1 周（1 点あたり 80·step px）
 *  波 = x 30→290・振幅 50 の正弦 2 周期（t ∈ [0, 4π]）
 *  斜め線 = (40,200)→(280,50)（約 32°）を t ∈ [0, 2π] で
 *  8 の字 = 中心 (160,120) の 8（t ∈ [0, 2π]・中心で交わる）／輪 = 輪が 3 つ続く線（t ∈ [0, 6π]） */
function genPts(shape: string, step: number, jit: number, seed: number): Pt[] {
  const r = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(1e-12, r());
    const v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const T = shape === "wave" ? 4 * Math.PI : shape === "loops" ? 6 * Math.PI : 2 * Math.PI;
  const out: Pt[] = [];
  for (let t = 0; t <= T + 1e-9; t += step) {
    let x: number;
    let y: number;
    if (shape === "circle") {
      x = 160 + 80 * Math.cos(t);
      y = 120 + 80 * Math.sin(t);
    } else if (shape === "wave") {
      x = 30 + (260 * t) / T;
      y = 120 + 50 * Math.sin(t);
    } else if (shape === "diag") {
      x = 40 + (240 * t) / T;
      y = 200 - (150 * t) / T;
    } else if (shape === "eight") {
      x = 160 + 100 * Math.sin(t);
      y = 120 + 70 * Math.sin(t) * Math.cos(t);
    } else {
      // 輪（長い擺線）: x = a·t − b·sin t（b > a で輪ができて交わる）
      x = 40 + 12 * t - 34 * Math.sin(t);
      y = 120 - 34 * Math.cos(t);
    }
    out.push([x + gauss() * jit, y + gauss() * jit]);
  }
  return out;
}
interface Combo {
  shape: string;
  step: number;
  jit: number;
  pts: Pt[];
}
const COMBOS: Combo[] = [];
{
  let seed = 191000;
  for (const shape of SHAPES)
    for (const step of SPEEDS)
      for (const jit of JITTERS) COMBOS.push({ shape, step, jit, pts: genPts(shape, step, jit, ++seed) });
}
const comboName = (c: Combo) => `${c.shape}/${c.step}/${c.jit}`;

// ================= 本物のエディタで描く =================
/** 作りものの作品。`fills[i]` の色でレイヤー i を全面塗っておく（0 なら空） */
function build(T: Tree, fills: number[], frames = 1): Mod {
  const p = T.M.newProject("v191");
  const paper = p.frames[0].paper;
  const ids = fills.map((_, i) => String.fromCharCode(65 + i));
  p.layerDefs = ids.map((id) => ({ id, name: id, visible: true, opacity: 1 }));
  p.folders = [];
  p.nextLayerId = 1000;
  p.frames = [];
  for (let f = 0; f < frames; f++) {
    const fr: Mod = { paper, layers: {} };
    ids.forEach((id, i) => (fr.layers[id] = T.M.allocIndexBuf(p).fill(fills[i])));
    p.frames.push(fr);
  }
  return p;
}
function makeEd(T: Tree, p: Mod, o: { tool?: string; active?: string; frame?: number } = {}) {
  const ed = new T.Editor();
  const log = { renders: 0, toasts: [] as string[] };
  ed.cb = { toast: (m: string) => void log.toasts.push(m), appendLog: () => {} };
  ed.project = p;
  ed.frameIndex = o.frame ?? 0;
  ed.activeLayerId = o.active ?? "A";
  ed.tool = o.tool ?? "pen";
  ed.mounted = true;
  ed.lastLockToastAt = -1e9;
  ed.cursorLive = false;
  ed.renderCanvas = () => void log.renders++;
  ed.paintFilmThumb = () => {};
  ed.rebuildFilm = () => {};
  ed.customTones = [{ id: 7, w: 3, h: 2, colors: ["#141414", "", "", "#141414", "#141414", ""] }];
  return { ed, log };
}
const ev = (x: number, y: number, extra: Mod = {}) => ({
  clientX: x + 0.5,
  clientY: y + 0.5,
  pointerId: 1,
  pointerType: "pen",
  button: 0,
  buttons: 1,
  pressure: 0.5,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  preventDefault() {},
  stopPropagation() {},
  ...extra,
});
interface RunOpts {
  tool?: string;
  size?: number;
  stab?: boolean;
  texture?: string;
  penTone?: string;
  brushTone?: string;
  eraserTone?: string;
  /** レイヤーの塗り（既定: ペン/ブラシは空 1 枚・消しゴムは全面 1 の 1 枚） */
  fills?: number[];
  all?: boolean;
  sel?: Uint8Array;
  pressures?: number[];
  dither?: boolean;
  frame?: number;
  /** 終わり方（既定: pointerup） */
  end?: "up" | "session" | "ui" | "toolSwitch" | "none";
  /** 各イベントのあとに呼ぶ（i=0 が pointerdown） */
  onEvent?: (i: number, ed: Mod, p: Mod) => void;
}
function run(T: Tree, pts: Pt[], o: RunOpts = {}) {
  const tool = o.tool ?? "pen";
  const fills = o.fills ?? (tool === "eraser" ? [1] : [0]);
  const fi = o.frame ?? 0;
  const p = build(T, fills, Math.max(1, fi + 1));
  const { ed, log } = makeEd(T, p, { tool, frame: fi });
  if (o.size !== undefined) ed.penSize = o.size;
  ed.stabilizer = o.stab ?? false;
  if (o.texture) ed.texture = o.texture;
  if (o.penTone !== undefined) ed.penToneId = o.penTone;
  if (o.brushTone) ed.brushToneId = o.brushTone;
  if (o.eraserTone) ed.eraserToneId = o.eraserTone;
  if (o.sel) ed.selMask = o.sel;
  if (o.dither) ed.ditherFrameShift = true;
  if (o.all) {
    if (typeof ed.setEraseAllLayers !== "function") throw new Error("setEraseAllLayers が無い");
    ed.setEraseAllLayers(true);
  }
  const before = (Object.values(p.frames[fi].layers) as Buf[]).map((b) => b.slice());
  const pr = (i: number) => o.pressures?.[i] ?? 0.5;
  ed.onPointerDown(ev(pts[0][0], pts[0][1], { pressure: pr(0) }));
  o.onEvent?.(0, ed, p);
  for (let i = 1; i < pts.length; i++) {
    ed.onPointerMove(ev(pts[i][0], pts[i][1], { pressure: pr(i) }));
    o.onEvent?.(i, ed, p);
  }
  const [lx, ly] = pts[pts.length - 1];
  const end = o.end ?? "up";
  if (end === "up") ed.onPointerUp(ev(lx, ly, { buttons: 0, pressure: 0 }));
  else if (end === "session") ed.endPointerSession("blur");
  else if (end === "ui") ed.uiPointerHandler();
  else if (end === "toolSwitch") {
    ed.tool = "fill"; // ショートカットで道具が変わった（setTool は DOM を組み直すので、道具の値だけ替える）
    ed.onPointerUp(ev(lx, ly, { buttons: 0, pressure: 0 }));
  }
  const layers = Object.values(p.frames[fi].layers) as Buf[];
  return { p, ed, log, before, layers, buf: layers[0] };
}
/** ペン 1px（黒）で描いた 0/1 の並び */
const penMask = (T: Tree, pts: Pt[], o: RunOpts = {}) => drawnMask(run(T, pts, { size: 1, ...o }).buf);
/** 今の打ち方: 押した位置に stamp、あとは点の列の順に strokeSegment（v1.9.0 のエディタの手ブレ補正オフと同じ） */
function oldWay(T: Tree, pts: Pt[]): Uint8Array {
  const b = new Uint8Array(PIXELS);
  const o = { size: 1, color: 1, texture: "solid", seed: 1, dashAcc: { d: 0 } };
  T.R.stamp(b, Math.floor(pts[0][0] + 0.5), Math.floor(pts[0][1] + 0.5), o);
  for (let i = 1; i < pts.length; i++) T.R.strokeSegment(b, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], o);
  return b;
}
const fmt = (m: Metrics) => `L ${m.L.toFixed(1).padStart(4)} ／ 近3 ${m.near3.toFixed(1).padStart(4)}% ／ 塊 ${m.clusters} ／ ${m.n} 画素`;

// ================= 木を読む =================
const REAL = await loadTree(root, "いま");
/** V191 の前の editor.ts（コミット 7b44248 の blob）。★旧版との照合に使う（公開リポジトリの clone には無い） */
const OLD_EDITOR_BLOB = "2112b572ef65fe216d55f3899809d2486b161ec5";
let OLD: Tree | null = null;
try {
  execFileSync("git", ["cat-file", "-e", OLD_EDITOR_BLOB], { cwd: root, stdio: "ignore" });
  const dir = path.join(WORK, "old");
  copySrc(dir);
  fs.writeFileSync(
    path.join(dir, "src/editor/editor.ts"),
    execFileSync("git", ["cat-file", "blob", OLD_EDITOR_BLOB], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  );
  OLD = await loadTree(dir, "旧版");
} catch {
  console.log(`SKIP 旧版の editor.ts（blob ${OLD_EDITOR_BLOB.slice(0, 12)}…）がこの clone に無い＝固定値との照合だけ`);
}

// ================= [S-1] raster.ts が 1 バイトも変わっていない =================
/** V191 を始める前の値（2026-10-02 に測った）＝ V174 時点の値（v176 / v178 の [S-1] と同じ） */
const RASTER_SHA_BEFORE_V191 = "23af7320c29458a6da5f2c72f2da75d47711e1912fd63d04ae754aa29f58f1be";
{
  const f = path.join(root, "src/editor/raster.ts");
  const actual = fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : "";
  check(
    "[S-1] ★src/editor/raster.ts が V191 を始める前から 1 バイトも変わっていない",
    actual === RASTER_SHA_BEFORE_V191,
    `いま ${actual.slice(0, 16)}…`
  );
}

// ================= [S-2] 今の打ち方は L 字の角だらけ（この検査が今の線を捕まえる） =================
const oldRows: Record<string, Metrics> = {};
{
  let minL = Infinity;
  const bad: string[] = [];
  for (const c of COMBOS) {
    const m = metrics(oldWay(REAL, c.pts));
    oldRows[comboName(c)] = m;
    minL = Math.min(minL, m.L);
    if (!(m.L > 8)) bad.push(`${comboName(c)} L=${m.L.toFixed(1)}`);
  }
  check("[S-2] ★今の打ち方で、全部の組み合わせが L > 8", bad.length === 0, bad.join(", "));
  console.log(`  [S-2] 今の打ち方の L の最小 ${minL.toFixed(1)}（${COMBOS.length} 通り）`);
  if (OLD) {
    const diff: string[] = [];
    for (const c of COMBOS) {
      const a = oldWay(REAL, c.pts);
      const b = drawnMask(run(OLD, c.pts, { size: 1 }).buf);
      if (!same(a, b)) diff.push(comboName(c));
    }
    check("[S-2b] 旧版の editor.ts（手ブレ補正オフ）は「今の打ち方」と 1 画素も違わない", diff.length === 0, diff.join(", "));
  }
}

// ================= [S-3] 新しい道 =================
const LIMIT = { 0.15: { L: 1.0, near3: 2 }, 0.3: { L: 4.0, near3: 8 } } as Record<number, { L: number; near3: number }>;
const newRows: Record<string, Metrics> = {};
const stabRows: Record<string, { old: Metrics; now: Metrics }> = {};
/** 手ブレ補正オンで本物のエディタに流し、**エディタが実際に線を引いた点の列**（各イベントのあとの `lastPt`＝補正オンなら
 *  `smoothPt` の EMA・係数 0.35）を記録する。★EMA は検査のために写さない——エディタの式が作った点をそのまま使う */
function emaRun(T: Tree, pts: Pt[]) {
  const ema: Pt[] = [];
  const r = run(T, pts, {
    size: 1,
    stab: true,
    onEvent: (_i, ed) => {
      if (!ed.lastPt) throw new Error("lastPt が無い（記録できない）");
      ema.push([ed.lastPt.x, ed.lastPt.y]);
    },
  });
  if (ema.length !== pts.length) throw new Error(`記録した点が ${ema.length}（${pts.length} のはず）`);
  // 補正が本当に効いている（記録した点が生の点の列と違う）ことを前提として確かめる
  let moved = 0;
  for (let i = 1; i < pts.length; i++) if (ema[i][0] !== pts[i][0] || ema[i][1] !== pts[i][1]) moved++;
  if (moved < pts.length / 2) throw new Error("前提: 手ブレ補正が効いていない（記録した点が生の点の列のまま）");
  return { ema, mask: drawnMask(r.buf) };
}
/** [S-3b] 手ブレ補正オン: 同じ点の列にエディタの EMA を掛けてから、今の打ち方（R.strokeSegment）と新しい道（本物のエディタ）で */
function checkS3b(T: Tree, record = false): V {
  const bad: string[] = [];
  for (const c of COMBOS) {
    const { ema, mask } = emaRun(T, c.pts);
    const old = metrics(oldWay(T, ema));
    const now = metrics(mask);
    if (record) stabRows[comboName(c)] = { old, now };
    if (!(old.L > 8)) bad.push(`今 ${comboName(c)}: L ${old.L.toFixed(1)}（> 8 のはず）`);
    if (!(now.L <= 1.0 && now.near3 <= 2 && now.clusters === 1))
      bad.push(`新 ${comboName(c)}: L ${now.L.toFixed(2)} 近3 ${now.near3.toFixed(1)}% 塊 ${now.clusters}`);
  }
  return bad.length ? ng(bad.slice(0, 4).join(" ／ ")) : ok();
}
function checkS3(T: Tree, record = false): V {
  const bad: string[] = [];
  for (const c of COMBOS) {
    const m = metrics(penMask(T, c.pts));
    if (record) newRows[comboName(c)] = m;
    const lim = LIMIT[c.jit];
    if (!(m.L <= lim.L && m.near3 <= lim.near3 && m.clusters === 1))
      bad.push(`${comboName(c)}: L ${m.L.toFixed(2)} 近3 ${m.near3.toFixed(1)}% 塊 ${m.clusters}`);
  }
  return bad.length ? ng(bad.slice(0, 4).join(" ／ ")) : ok();
}
{
  const v = await safe(() => checkS3(REAL, true));
  check("[S-3] ★新しい道: 手ぶれ 0.15 は L ≤ 1.0・近3 ≤ 2%／0.3 は L ≤ 4.0・近3 ≤ 8%／どれも塊 1 つ", v.ok, v.why);
  const v2 = await safe(() => checkS3b(REAL, true));
  check("[S-3b] ★手ブレ補正オン: 今の打ち方で全部 L > 8・新しい道で全部 L ≤ 1.0・近3 ≤ 2%・塊 1 つ", v2.ok, v2.why);
  if (OLD) {
    // 旧版の editor.ts（補正オン）が描く画素＝「エディタが作った EMA の点の列」を今の打ち方で引いた画素
    //（記録した点の列が、旧版のエディタの EMA と同じものだと確かめる＝EMA は V191 で変わっていない）
    const v3 = await safe(() => {
      const diff: string[] = [];
      for (const c of COMBOS) {
        const { ema } = emaRun(REAL, c.pts);
        const b = drawnMask(run(OLD!, c.pts, { size: 1, stab: true }).buf);
        if (!same(oldWay(REAL, ema), b)) diff.push(comboName(c));
      }
      return diff.length ? ng(diff.join(", ")) : ok();
    });
    check("[S-3c] 旧版の editor.ts（手ブレ補正オン）は「エディタの EMA の点の列を今の打ち方で引いたもの」と 1 画素も違わない", v3.ok, v3.why);
    // ★赤先行の証跡: V191 の前の editor.ts で [S-3]・[S-3b] を回すと赤（この検査が今の線を捕まえる）
    const r3 = await safe(() => checkS3(OLD!));
    const r3b = await safe(() => checkS3b(OLD!));
    check("[S-3r] ★赤先行: 旧版の editor.ts では [S-3] が赤", !r3.ok && !r3.threw, r3.ok ? "緑（検査が今の線を捕まえていない）" : r3.why);
    check("[S-3r] ★赤先行: 旧版の editor.ts では [S-3b] が赤", !r3b.ok && !r3b.threw, r3b.ok ? "緑（検査が今の線を捕まえていない）" : r3b.why);
    console.log(`  [S-3r] 旧版: [S-3] ${r3.why.slice(0, 90)}`);
    console.log(`  [S-3r] 旧版: [S-3b] ${r3b.why.slice(0, 90)}`);
  }
  // 表（報告書の [S-2]・[S-3]・[S-3b]）
  const lines: string[] = [];
  const sum = { old: [0, 0], now: [0, 0], oldS: [0, 0], nowS: [0, 0] } as Record<string, number[]>;
  const add = (k: string, m: Metrics) => {
    sum[k][0] += m.L * m.n;
    sum[k][1] += m.n;
  };
  const cell = (m: Metrics | undefined, d: number) =>
    m ? `${m.L.toFixed(d)} ／ ${m.near3.toFixed(d)}% ／ ${m.clusters} ／ ${m.n}` : "-";
  for (const c of COMBOS) {
    const k = comboName(c);
    const a = oldRows[k];
    const b = newRows[k];
    const s = stabRows[k];
    if (!a || !b || !s) continue;
    add("old", a);
    add("now", b);
    add("oldS", s.old);
    add("nowS", s.now);
    lines.push(`| ${c.shape} | ${c.step} | ${c.jit} | ${cell(a, 1)} | ${cell(b, 2)} | ${cell(s.old, 1)} | ${cell(s.now, 2)} |`);
  }
  const avg = (k: string) => `L ${(sum[k][0] / Math.max(1, sum[k][1])).toFixed(2)}（${sum[k][1]} 画素）`;
  console.log(`  [S-3] 全体（補正オフ）: 今 ${avg("old")} → 新 ${avg("now")}`);
  console.log(`  [S-3b] 全体（補正オン）: 今 ${avg("oldS")} → 新 ${avg("nowS")}`);
  if (REPORT) {
    console.log(
      "| 形 | 進み | 手ぶれ | 補正オフ 今: L ／ 近3 ／ 塊 ／ 画素 | 補正オフ 新 | 補正オン 今 | 補正オン 新 |"
    );
    console.log("|---|---|---|---|---|---|---|");
    for (const l of lines) console.log(l);
  }
}

// ================= [S-4] 端と描き終わりの漏斗 =================
const rnd = (x: number) => Math.round(x);
const at = (b: Buf, x: number, y: number) => b[rnd(y) * W + rnd(x)];
/** 1 本の決まった線（手ぶれなし）。最後の点の画素は、それまでに一度も通らない */
const LINE: Pt[] = Array.from({ length: 41 }, (_, i) => [20.3 + (160.3 * i) / 40, 30.4 + (99.8 * i) / 40] as Pt);
async function checkS4(T: Tree): Promise<V> {
  // (a) 24 通り: 最初の画素＝押した位置・最後の画素＝最後の点の Math.round（K-8: 離して増えるのは最大 1 画素・消える画素なし）
  for (const c of COMBOS) {
    let beforeUp: Buf | null = null;
    const r = run(T, c.pts, {
      size: 1,
      onEvent: (i, ed, p) => {
        if (i === c.pts.length - 1) beforeUp = (p.frames[0].layers.A as Buf).slice();
      },
    });
    const [x0, y0] = c.pts[0];
    const [xl, yl] = c.pts[c.pts.length - 1];
    if (!at(r.buf, x0, y0)) return ng(`★${comboName(c)}: 押した位置 (${rnd(x0)},${rnd(y0)}) に画素が無い`);
    if (!at(r.buf, xl, yl)) return ng(`★${comboName(c)}: 最後の点の画素 (${rnd(xl)},${rnd(yl)}) が無い（漏斗が効いていない）`);
    const bu = beforeUp as unknown as Buf;
    let added = 0;
    for (let i = 0; i < PIXELS; i++) {
      if (bu[i] && r.buf[i] !== bu[i]) return ng(`★${comboName(c)}: 離したら見えていた画素が消えた（K-8）`);
      if (!bu[i] && r.buf[i]) added++;
    }
    if (added > 1) return ng(`★${comboName(c)}: 離したら ${added} 画素増えた（仮は 1 画素のはず・K-8）`);
  }
  // (b) 押しただけ: 押した位置の 1 画素だけ
  {
    const r = run(T, [[100.2, 50.7]], { size: 1 });
    if (popcount(drawnMask(r.buf)) !== 1 || !at(r.buf, 100.2, 50.7)) return ng("★押しただけで 1 画素（押した位置）にならない");
  }
  // (c) 決まった線: 離す前は最後の画素が出ていない（仮）→ 離すと出る
  const last = LINE[LINE.length - 1];
  let pre = -1;
  const r = run(T, LINE, {
    size: 1,
    onEvent: (i, _ed, p) => {
      if (i === LINE.length - 1) pre = at(p.frames[0].layers.A, last[0], last[1]);
    },
  });
  if (pre !== 0) return ng("前提: 離す前に最後の画素がもう出ている（仮になっていない）");
  if (!at(r.buf, last[0], last[1])) return ng("★離しても最後の画素が出ない（pointerup の漏斗）");
  // (d) 取り消し 1 回で全部戻る・やり直しで最後の画素まで戻る（K-7・漏斗が履歴より前）
  {
    const post = r.buf.slice();
    if (r.ed.history.undoDepth !== 1) return ng(`★履歴が ${r.ed.history.undoDepth} 個（1 のはず）`);
    await r.ed.applyHistory(() => r.ed.history.undo(), r.ed.history.peekUndo());
    if (!same(r.buf, r.before[0])) return ng("★Ctrl+Z 1 回で元に戻らない");
    await r.ed.applyHistory(() => r.ed.history.redo(), r.ed.history.peekRedo());
    if (!same(r.buf, post)) return ng("★やり直しで最後の画素が戻らない（漏斗が履歴より後ろ）");
  }
  // (e) endPointerSession（blur）で終わっても最後の画素が出る・履歴 1 つ
  {
    const s = run(T, LINE, { size: 1, end: "session" });
    if (!at(s.buf, last[0], last[1])) return ng("★endPointerSession で終わると最後の画素が出ない");
    if (s.ed.history.undoDepth !== 1) return ng(`★endPointerSession で履歴が ${s.ed.history.undoDepth} 個`);
    const post = s.buf.slice();
    await s.ed.applyHistory(() => s.ed.history.undo(), s.ed.history.peekUndo());
    await s.ed.applyHistory(() => s.ed.history.redo(), s.ed.history.peekRedo());
    if (!same(s.buf, post)) return ng("★endPointerSession: やり直しで最後の画素が戻らない");
  }
  // (f) 全レイヤー消しゴム: UI を押した（finishEraseAllNow で束を確定）で終わっても、3 枚とも最後の画素が消える・束に入る
  {
    const s = run(T, LINE, { tool: "eraser", size: 1, fills: [1, 2, 3], all: true, end: "ui" });
    for (const b of s.layers) if (at(b, last[0], last[1]) !== 0) return ng("★全レイヤー: UI を押して終えると最後の画素が消えない（finishEraseAllNow の漏斗）");
    if (s.ed.history.undoDepth !== 1) return ng(`★全レイヤー: 履歴が ${s.ed.history.undoDepth} 個`);
    const post = s.layers.map((b) => b.slice());
    await s.ed.applyHistory(() => s.ed.history.undo(), s.ed.history.peekUndo());
    for (let i = 0; i < 3; i++) if (!same(s.layers[i], s.before[i])) return ng("★全レイヤー: Ctrl+Z 1 回で戻らない");
    await s.ed.applyHistory(() => s.ed.history.redo(), s.ed.history.peekRedo());
    for (let i = 0; i < 3; i++) if (!same(s.layers[i], post[i])) return ng("★全レイヤー: やり直しで最後の画素が戻らない");
    // 遅れて本当の pointerup が来ても何も変わらない
    s.ed.onPointerUp(ev(last[0], last[1], { buttons: 0, pressure: 0 }));
    for (let i = 0; i < 3; i++) if (!same(s.layers[i], post[i])) return ng("★全レイヤー: 遅れた pointerup で絵が変わった");
  }
  // (g) 全レイヤー消しゴム: ふつうに離しても 3 枚とも最後の画素が消える
  {
    const s = run(T, LINE, { tool: "eraser", size: 1, fills: [1, 2, 3], all: true });
    for (const b of s.layers) if (at(b, last[0], last[1]) !== 0) return ng("★全レイヤー: 離しても最後の画素が消えない");
  }
  // (h) 途中で道具が変わっても（いまの道具に関係なく）最後の画素が出る
  {
    const s = run(T, LINE, { size: 1, end: "toolSwitch" });
    if (!at(s.buf, last[0], last[1])) return ng("★途中で道具が変わると最後の画素が出ない（漏斗が道具の分岐の中にある）");
  }
  // (j) ★重い処理の最中に裏へ回った（endPointerSession → onPointerUp が busyKind の関所で漏斗より前に抜ける）。
  //  そのなぞりの仮の 1 画素は、次に押したとき**別のレイヤーへ履歴の外に打たれない**（コミット前レビューの指摘）
  {
    const p = build(T, [0, 0]);
    const { ed } = makeEd(T, p, { tool: "pen" });
    ed.penSize = 1;
    ed.stabilizer = false;
    ed.onPointerDown(ev(LINE[0][0], LINE[0][1]));
    for (const [x, y] of LINE.slice(1)) ed.onPointerMove(ev(x, y));
    ed.busyKind = "heavy"; // 重い処理の最中（beginBusy と同じ値）
    ed.endPointerSession("blur");
    ed.busyKind = "";
    ed.activeLayerId = "B"; // 戻ってきて別のレイヤーを選んだ
    const B = p.frames[0].layers.B as Buf;
    const depth0 = ed.history.undoDepth;
    ed.onPointerDown(ev(10, 200));
    ed.onPointerMove(ev(30, 200));
    ed.onPointerUp(ev(30, 200, { buttons: 0, pressure: 0 }));
    if (at(B, last[0], last[1]) !== 0) return ng("★重い処理の最中に畳んだなぞりの仮の 1 画素が、次のなぞりで別のレイヤーへ履歴の外に打たれた");
    if (!at(B, 30, 200) || ed.history.undoDepth !== depth0 + 1) return ng("前提: 次のなぞりが描けていない");
    await ed.applyHistory(() => ed.history.undo(), ed.history.peekUndo());
    if (popcount(drawnMask(B)) !== 0) return ng("★次のなぞりを Ctrl+Z しても B に画素が残る（履歴の外に書かれた）");
  }
  // (i) 押した位置 pt と round(lastPt) が一致する（A-70 の半画素ずらし）。本物の clientToPixel / clientToStrokePt で
  // ★V213 (M-2a): PC の clientToStrokePt は消えた。lastPt に入る座標は、PC の sampleOf（clientToPixelF の結果をそのまま
  //  サンプルの x・y に）→ コアの sampleStrokePt（半画素ずらす）で作られる＝描線の経路が実際に通る道。その道で同じ値を作る
  //  （クライアント座標は ev() の +0.5 を通さずにそのまま渡す）
  const strokePtOf = (ed: Mod, cx: number, cy: number): { x: number; y: number } =>
    ed.sampleStrokePt(ed.sampleOf({ ...ev(0, 0), clientX: cx, clientY: cy }));
  {
    const { ed } = makeEd(T, build(T, [0]));
    const rr = mulberry32(4);
    for (let k = 0; k < 20000; k++) {
      const cx = -3 + rr() * 326;
      const cy = -3 + rr() * 246;
      const a = ed.clientToPixel(cx, cy);
      const b = strokePtOf(ed, cx, cy);
      if (a.x !== Math.round(b.x) || a.y !== Math.round(b.y)) return ng(`★pt と round(lastPt) がずれる (${cx}, ${cy})`);
    }
    for (let k = 0; k <= 320 * 16; k++) {
      const cx = k / 16; // 半画素・画素の境目ちょうども
      const a = ed.clientToPixel(cx, cx * 0.75);
      const b = strokePtOf(ed, cx, cx * 0.75);
      if (a.x !== Math.round(b.x) || a.y !== Math.round(b.y)) return ng(`★pt と round(lastPt) がずれる（境目 ${cx}）`);
    }
  }
  return ok();
}
{
  const v = await safe(() => checkS4(REAL));
  check("[S-4] ★端: 最初の画素＝押した位置・最後の画素＝最後の点（pointerup／endPointerSession／UI で束の確定／道具が変わった）・K-7・K-8", v.ok, v.why);
  // 参考（数えない）: なぞっている途中で道具が「塗り」に変わったとき、1 枚の履歴は積まれない＝V191 の前からの挙動（pointerup の
  // 履歴は道具の分岐の中にある）。V191 で変えていないことを旧版と並べて残す
  const depth = (T: Tree) => run(T, LINE, { size: 1, end: "toolSwitch" }).ed.history.undoDepth;
  console.log(`  [S-4] 参考: 途中で道具が塗りに変わったときの履歴の数 いま ${depth(REAL)}${OLD ? ` ／ 旧版 ${depth(OLD)}` : ""}`);
}

// ================= [S-5] 交差 =================
const CROSS: Combo[] = [];
{
  let seed = 195000;
  for (const shape of ["eight", "loops"]) for (const step of [0.01, 0.03]) for (const jit of JITTERS)
    CROSS.push({ shape, step, jit, pts: genPts(shape, step, jit, ++seed) });
}
const crossRows: Record<string, { now: Metrics; old: Metrics }> = {};
function checkS5(T: Tree, record = false): V {
  for (const c of CROSS) {
    let prev = new Uint8Array(PIXELS) as Buf;
    let lost = 0;
    const r = run(T, c.pts, {
      size: 1,
      onEvent: (_i, _ed, p) => {
        const cur = p.frames[0].layers.A as Buf;
        for (let i = 0; i < PIXELS; i++) if (prev[i] && cur[i] !== prev[i]) lost++;
        prev = cur.slice();
      },
    });
    for (let i = 0; i < PIXELS; i++) if (prev[i] && r.buf[i] !== prev[i]) lost++;
    const m = metrics(drawnMask(r.buf));
    if (record) crossRows[comboName(c)] = { now: m, old: metrics(oldWay(T, c.pts)) };
    if (lost) return ng(`★${comboName(c)}: 同じなぞりで先に描いた画素が ${lost} 回消えた`);
    if (m.clusters !== 1) return ng(`★${comboName(c)}: 塊が ${m.clusters} つ（途切れた）`);
    // 8 の字の交差（中心）は両方の筋が通る＝中心の 3×3 に画素がある
    if (c.shape === "eight") {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) k += r.buf[(120 + dy) * W + 160 + dx] ? 1 : 0;
      if (k < 2) return ng(`★${comboName(c)}: 交差に画素が残っていない`);
    }
  }
  return ok();
}
{
  const v = await safe(() => checkS5(REAL, true));
  check("[S-5] ★交差（8 の字・輪）: 先に描いた画素が 1 つも消えない・塊 1 つ・交差に画素が残る", v.ok, v.why);
  for (const [k, r] of Object.entries(crossRows)) console.log(`  [S-5] ${k.padEnd(16)} 今 ${fmt(r.old)}  →  新 ${fmt(r.now)}`);
}

// ================= [S-6] 消しゴム（K-3） =================
{
  const v = await safe(() => {
    for (const c of COMBOS) {
      const pen = penMask(REAL, c.pts);
      const er = run(REAL, c.pts, { tool: "eraser", size: 1, fills: [1] });
      if (!same(zeroMask(er.buf, er.before[0]), pen)) return ng(`★${comboName(c)}: 消えた画素 ≠ ペンで描いた画素`);
      for (let i = 0; i < PIXELS; i++) if (!pen[i] && er.buf[i] !== 1) return ng(`★${comboName(c)}: なぞりに関係ない画素が変わった`);
      const all = run(REAL, c.pts, { tool: "eraser", size: 1, fills: [1, 2, 3], all: true });
      for (let k = 0; k < 3; k++)
        if (!same(zeroMask(all.layers[k], all.before[k]), pen)) return ng(`★${comboName(c)}: 全レイヤーの ${k + 1} 枚目が、ペンの形で消えない`);
    }
    return ok();
  });
  check("[S-6] ★1px の消しゴム（1 枚・全レイヤー）で消えた画素＝ペンで描いた画素・ほかは 1 つも変わらない（K-3）", v.ok, v.why);
}

// ================= [S-7] 太さ 2 以上・ブラシ・種類・トーン・マイ柄・選択範囲は V191 の前と 1 バイトも同じ（K-4） =================
/** ★V191 の前の editor.ts（blob 2112b572）で [S-7] の筋書きを走らせて得た値（2026-10-02・実装の前に測った） */
const GOLDEN_S7 = "86ba93842c5e6990addf3905edadd4f1058d753a2eeb2d1a9ef33a5b744ea017";
const PATH: Pt[] = [
  [40, 60],
  [70, 80],
  [100, 95],
  [130, 120],
  [160, 130],
  [190, 125],
  [220, 110],
  [250, 100],
  [280, 150],
];
const SLOW = genPts("wave", 0.01, 0.3, 197001);
interface Case extends RunOpts {
  label: string;
}
function s7Cases(): Case[] {
  const cs: Case[] = [];
  for (const size of [2, 3, 5, 8, 12])
    for (const texture of ["solid", "dot", "rough", "spray", "sand", "halftone"]) cs.push({ label: `pen/${size}/${texture}`, tool: "pen", size, texture });
  for (const size of [2, 5]) cs.push({ label: `pen/${size}/custom:7`, tool: "pen", size, penTone: "custom:7" });
  for (const size of [1, 2, 3, 8])
    for (const brushTone of ["solid", "halftone-s", "checker-s", "custom:7"]) cs.push({ label: `brush/${size}/${brushTone}`, tool: "brush", size, brushTone });
  for (const size of [2, 3, 5, 12])
    for (const eraserTone of ["solid", "halftone-l", "custom:7"])
      cs.push({ label: `eraser/${size}/${eraserTone}`, tool: "eraser", size, eraserTone, fills: [1] });
  const sel = rectMask(100, 80, 220, 160);
  cs.push({ label: "pen/3/sel", tool: "pen", size: 3, sel });
  cs.push({ label: "eraser/5/sel", tool: "eraser", size: 5, sel, fills: [1] });
  cs.push({ label: "brush/8/sel", tool: "brush", size: 8, brushTone: "halftone-s", sel });
  cs.push({ label: "pen/3/stab", tool: "pen", size: 3, stab: true });
  cs.push({ label: "eraser/5/stab", tool: "eraser", size: 5, stab: true, fills: [1] });
  cs.push({ label: "brush/8/dither", tool: "brush", size: 8, brushTone: "checker-s", dither: true, frame: 1 });
  for (const size of [2, 5]) cs.push({ label: `eraserAll/${size}`, tool: "eraser", size, all: true, fills: [1, 2, 3] });
  cs.push({ label: "eraserAll/3/halftone-l", tool: "eraser", size: 3, eraserTone: "halftone-l", all: true, fills: [1, 2, 3] });
  return cs;
}
/** 筆圧つき（太さ 2 以上のまま: ペン 5 → 3〜8・消しゴム 4 → 3〜6） */
const pressuresFor = (n: number) => Array.from({ length: n }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 0.37)));
async function scenarioS7(T: Tree): Promise<string> {
  const rows: string[] = [];
  const saved = Math.random;
  const cases = s7Cases();
  for (const pts of [PATH, SLOW]) {
    const extra: Case[] = [
      { label: "pen/5/pressure", tool: "pen", size: 5, pressures: pressuresFor(pts.length) },
      { label: "eraser/4/pressure", tool: "eraser", size: 4, pressures: pressuresFor(pts.length), fills: [1] },
    ];
    for (const c of [...cases, ...extra]) {
      Math.random = mulberry32(191);
      try {
        const r = run(T, pts, c);
        rows.push(`${pts === PATH ? "P" : "S"}/${c.label}:${shaOf(...r.layers)}:${r.ed.history.undoDepth}`);
      } finally {
        Math.random = saved;
      }
    }
  }
  return rows.join("\n");
}
let oldS7Rows = "";
async function checkS7(T: Tree): Promise<V> {
  const rows = await scenarioS7(T);
  const sha = crypto.createHash("sha256").update(rows).digest("hex");
  if (oldS7Rows && rows !== oldS7Rows) {
    const a = oldS7Rows.split("\n");
    const b = rows.split("\n");
    const d: string[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push((b[i] ?? "").split(":")[0]);
    return ng(`★旧版と違う行 ${d.length}: ${d.slice(0, 5).join(", ")}`);
  }
  if (GOLDEN_S7 && sha !== GOLDEN_S7) return ng(`★固定値と違う（いま ${sha.slice(0, 16)}…）`);
  if (!GOLDEN_S7 && !oldS7Rows) return ng("固定値も旧版も無い（照合できない）");
  return ok();
}
{
  if (OLD) {
    const v = await safe(async () => {
      oldS7Rows = await scenarioS7(OLD!);
      const sha = crypto.createHash("sha256").update(oldS7Rows).digest("hex");
      console.log(`  [S-7] 旧版の筋書き ${oldS7Rows.split("\n").length} 行・${sha}`);
      return GOLDEN_S7 === "" || sha === GOLDEN_S7 ? ok() : ng(`★固定値は旧版の出力ではない（旧版 ${sha.slice(0, 16)}…）`);
    });
    check("[S-7r] 固定値は、取り出した旧版（V191 の前の editor.ts）そのものの出力", v.ok, v.why);
  }
  const v = await safe(() => checkS7(REAL));
  check("[S-7] ★太さ 2 以上・ブラシ（太さ 1 も）・種類・トーン・マイ柄・選択範囲・筆圧・全レイヤーで、V191 の前と 1 バイトも同じ（K-4）", v.ok, v.why);
}

// ================= [S-8] 筆圧で 1→2→1 =================
{
  const v = await safe(() => {
    const pts = genPts("wave", 0.03, 0.15, 198001);
    const n = pts.length;
    const lo = Math.floor(n * 0.4);
    const hi = Math.floor(n * 0.6);
    // 太さ 1: round(1·(0.4+0.3·1.2)) = 1 ／ 太さ 2: round(1·(0.4+0.95·1.2)) = 2
    const pressures = pts.map((_, i) => (i >= lo && i < hi ? 0.95 : 0.3));
    const r = run(REAL, pts, { size: 1, pressures }); // 筆圧は既定でオン（pressureEnabled = true）
    const m = metrics(drawnMask(r.buf));
    if (m.clusters !== 1) return ng(`★塊が ${m.clusters} つ（途切れた）`);
    const [xl, yl] = pts[n - 1];
    if (!at(r.buf, xl, yl)) return ng("★最後の画素が出ない");
    // 2px の区間が本当に 2px で描かれた（前提）
    const xLo = pts[lo][0];
    const xHi = pts[hi - 1][0];
    const mid = metrics(drawnMask(r.buf), (x) => x > xLo + 3 && x < xHi - 3);
    if (!(mid.n > 0 && mid.near3 > 30)) return ng(`前提: 2px の区間が太くない（近3 ${mid.near3.toFixed(1)}%）`);
    // 1px の区間（境目の 3 画素を除く）は L 字の角が出ない
    const one = metrics(drawnMask(r.buf), (x) => x < xLo - 3 || x > xHi + 3);
    if (!(one.L <= 1.0)) return ng(`★1px の区間に L 字の角が残る（L ${one.L.toFixed(2)}）`);
    // 全レイヤー消しゴムでも同じ: 3 枚とも同じ形・途切れない
    const e = run(REAL, pts, { tool: "eraser", size: 1, pressures, fills: [1, 2, 3], all: true });
    const z = e.layers.map((b, k) => zeroMask(b, e.before[k]));
    if (!same(z[0], z[1]) || !same(z[0], z[2])) return ng("★全レイヤー: 3 枚の消え方が違う");
    if (metrics(z[0]).clusters !== 1) return ng("★全レイヤー: 消えた所が途切れた");
    if (at(e.layers[0], xl, yl) !== 0) return ng("★全レイヤー: 最後の画素が消えない");
    console.log(`  [S-8] 1px の区間（前後 2 つ・塊は区間ごと）${fmt(one)} ／ 2px の区間 ${mid.n} 画素 ／ 全体の塊 ${m.clusters}`);
    return ok();
  });
  check("[S-8] 筆圧で 1→2→1: 途切れない・最後の画素が出る・1px の区間は L ≤ 1.0（全レイヤー消しゴムも）", v.ok, v.why);
}

// ================= [S-9] 点線（報告用） =================
{
  const lineH = (adv: number): Pt[] => Array.from({ length: Math.round(100 / adv) + 1 }, (_, i) => [100 + i * adv, 60] as Pt);
  const lineD = (adv: number): Pt[] =>
    Array.from({ length: Math.round(100 / adv) + 1 }, (_, i) => [60 + (i * adv) / Math.SQRT2, 100 + (i * adv) / Math.SQRT2] as Pt);
  const circ = (adv: number): Pt[] => {
    const n = Math.round((2 * Math.PI * 40) / adv);
    return Array.from({ length: n + 1 }, (_, i) => [220 + 40 * Math.cos((2 * Math.PI * i) / n), 160 + 40 * Math.sin((2 * Math.PI * i) / n)] as Pt);
  };
  const runs: [string, Pt[]][] = [
    ["横 100・速い（4px/点）", lineH(4)],
    ["横 100・ゆっくり（0.25px/点）", lineH(0.25)],
    ["斜め 100・速い", lineD(4)],
    ["斜め 100・ゆっくり", lineD(0.25)],
    ["円 r40・速い", circ(4)],
    ["円 r40・ゆっくり", circ(0.25)],
  ];
  const dots = (m: Uint8Array) => {
    const mm = metrics(m);
    return { dots: mm.clusters, px: mm.n };
  };
  const bad: string[] = [];
  for (const [name, pts] of runs) {
    const now = dots(penMask(REAL, pts, { texture: "dot" }));
    const old = OLD ? dots(penMask(OLD, pts, { texture: "dot" })) : null;
    console.log(
      `  [S-9] ${name.padEnd(22)} 新: 点 ${String(now.dots).padStart(3)}・画素 ${String(now.px).padStart(3)}（1 点 ${(now.px / Math.max(1, now.dots)).toFixed(2)} 画素）` +
        (old ? ` ／ 今: 点 ${String(old.dots).padStart(3)}・画素 ${String(old.px).padStart(3)}（1 点 ${(old.px / Math.max(1, old.dots)).toFixed(2)} 画素）` : "")
    );
    if (now.dots <= 1) bad.push(`${name}: 点 ${now.dots}`);
  }
  check("[S-9] 点線が点線のまま（0 個・全部つながりにならない）", bad.length === 0, bad.join(", "));
}

// ================= [S-10] 選択範囲 =================
{
  const v = await safe(() => {
    // 円（半径 80）・波・斜め線のどれもが、選択の縁を出入りする矩形
    const sel = rectMask(90, 50, 230, 170);
    for (const c of COMBOS.filter((c) => c.step >= 0.03 || c.shape === "wave")) {
      const pen = run(REAL, c.pts, { size: 1, sel });
      let inside = 0;
      for (let i = 0; i < PIXELS; i++) {
        if (!sel[i] && pen.buf[i] !== 0) return ng(`★${comboName(c)}: ペンが選択の外に描いた`);
        if (sel[i] && pen.buf[i]) inside++;
      }
      const er = run(REAL, c.pts, { tool: "eraser", size: 1, sel, fills: [1] });
      for (let i = 0; i < PIXELS; i++) if (!sel[i] && er.buf[i] !== 1) return ng(`★${comboName(c)}: 消しゴムが選択の外を消した`);
      const all = run(REAL, c.pts, { tool: "eraser", size: 1, sel, fills: [1, 2, 3], all: true });
      for (let k = 0; k < 3; k++) for (let i = 0; i < PIXELS; i++) if (!sel[i] && all.layers[k][i] !== k + 1) return ng(`★${comboName(c)}: 全レイヤーが選択の外を消した`);
      if (inside === 0) return ng(`前提: ${comboName(c)} が選択の中を通っていない`);
    }
    return ok();
  });
  check("[S-10] 選択範囲: 選択の外の画素が 1 つも変わらない（ペン・消しゴム・全レイヤー消しゴム）", v.ok, v.why);
}

// ================= [S-11] 静的: 漏斗の位置 =================
/** メソッドの本体を、**署名行の最後の `{`** から括弧の対応で取り出す（v176 と同じ） */
function methodBody(src: string, name: string): string {
  const re = new RegExp(`^[ \\t]*(?:private |public |protected )?(?:async )?${name}\\s*\\(.*$`, "m");
  const m = re.exec(src);
  if (!m) return "";
  const rel = m[0].lastIndexOf("{");
  if (rel < 0) return "";
  const open = m.index + rel;
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") {
      d--;
      if (d === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}
/** 署名が複数行にわたるメソッド（`mount(` など）の本体。署名の `(` から括弧の対応で `)` を探し、その後の最初の `{` から取る。
 *  ⚠ 戻り値の型に `{` があるメソッドには使わない（mount は戻り値の型を書いていない） */
function methodBodyML(src: string, name: string): string {
  const re = new RegExp(`^[ \\t]*(?:private |public |protected )?(?:async )?${name}\\s*\\(`, "m");
  const m = re.exec(src);
  if (!m) return "";
  let i = m.index + m[0].length - 1;
  let d = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") d++;
    else if (src[i] === ")") {
      d--;
      if (d === 0) break;
    }
  }
  const open = src.indexOf("{", i);
  if (open < 0) return "";
  d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") {
      d--;
      if (d === 0) return src.slice(open, k + 1);
    }
  }
  return "";
}
const FUNNEL = "this.endLine1px();";
// ★V213 (M-2a): PC の onPointerDownInner / onPointerMove / onPointerUp の描く中身はコアの片へ移った（PC は同じ順で片を呼ぶだけ）:
//  pointerdown の網（dropStaleLine1px・漏斗・束の確定の 3 行）→ strokeSettle／pointermove の道具ごとの中身 → strokeMoveOne／
//  pointerup の確定（漏斗・束の確定・道具ごとの確定）→ strokeFinish。順の縛りは片の中で、PC がその片を**1 回だけ**呼ぶことと
//  PC の側に漏斗・1px の呼び出しが無いこと（2 か所に割れていない）を縛る
function callsOnce(body: string, call: string): boolean {
  return body.split(call).length - 1 === 1;
}
function checkS11(src: string): V {
  const upPC = methodBody(src, "onPointerUp");
  if (upPC === "") return ng("onPointerUp を切り出せない（検査が黙る）");
  if (!callsOnce(upPC, "this.strokeFinish(this.sampleOf(e));")) return ng("★onPointerUp が確定（strokeFinish）を 1 回だけ呼んでいない");
  if (upPC.includes(FUNNEL)) return ng("★onPointerUp で漏斗を 2 回呼んでいる（どちらが効くか分からない）");
  const up = methodBody(src, "strokeFinish");
  if (up === "") return ng("strokeFinish を切り出せない（検査が黙る）");
  const f = up.indexOf(FUNNEL);
  if (f < 0) return ng("★onPointerUp で漏斗を呼んでいない");
  if (up.indexOf(FUNNEL, f + 1) >= 0) return ng("★onPointerUp で漏斗を 2 回呼んでいる（どちらが効くか分からない）");
  const c = up.indexOf("this.commitEraseAll()");
  const h = up.indexOf('this.pushBufferHistory("描画"');
  const s = up.indexOf("switch (this.tool)");
  if (c < 0 || h < 0 || s < 0) return ng("onPointerUp（strokeFinish）の commitEraseAll / pushBufferHistory / switch が見つからない（検査が黙る）");
  if (!(f < c)) return ng("★onPointerUp: 漏斗が commitEraseAll() より後ろ");
  if (!(f < h)) return ng('★onPointerUp: 漏斗が pushBufferHistory("描画" より後ろ');
  if (!(f < s)) return ng("★onPointerUp: 漏斗が道具の分岐（switch）の中にある（いまの道具に関係なく通らない）");
  const fin = methodBody(src, "finishEraseAllNow");
  if (fin === "") return ng("finishEraseAllNow を切り出せない");
  const ff = fin.indexOf(FUNNEL);
  const fc = fin.indexOf("this.commitEraseAll()");
  if (ff < 0) return ng("★finishEraseAllNow で漏斗を呼んでいない");
  if (fc < 0 || !(ff < fc)) return ng("★finishEraseAllNow: 漏斗が commitEraseAll() より後ろ");
  const downPC = methodBody(src, "onPointerDownInner");
  if (downPC === "") return ng("onPointerDownInner を切り出せない（検査が黙る）");
  if (!callsOnce(downPC, "this.strokeSettle();")) return ng("★pointerdown が網（strokeSettle）を 1 回だけ呼んでいない");
  if (downPC.includes(FUNNEL) || downPC.includes("this.dropStaleLine1px();")) return ng("★pointerdown の網が PC とコアの 2 か所に割れている");
  const down = methodBody(src, "strokeSettle");
  const df = down.indexOf(FUNNEL);
  const dc = down.indexOf("if (this.eraseAllStroke) this.commitEraseAll();");
  if (df < 0 || dc < 0 || !(df < dc)) return ng("★pointerdown の網で、漏斗が commitEraseAll() より前に無い");
  // ★pointermove の 1px の呼び出しは**小数の lastPt をそのまま**渡す（A-70。丸めて渡す後戻りは L の数にも端にも出ないので、
  //  形で縛る＝v176 [S-3] が strokeSegment の呼び出しに掛けているのと同じ縛りを、1px の呼び出しにも掛ける）
  const movePC = methodBody(src, "onPointerMove");
  if (movePC === "") return ng("onPointerMove を切り出せない（検査が黙る）");
  if (!callsOnce(movePC, "this.strokeMoveOne(this.sampleOf(ev))")) return ng("★pointermove が動いた点（strokeMoveOne）を 1 回だけ呼んでいない");
  if (/this\.line1pxSegment\(/.test(movePC)) return ng("★pointermove の 1px の呼び出しが PC とコアの 2 か所に割れている");
  const move = methodBody(src, "strokeMoveOne");
  if (move === "") return ng("strokeMoveOne を切り出せない（検査が黙る）");
  const MOVE_1PX = [
    "this.line1pxSegment(this.lastPt.x, this.lastPt.y, tx, ty, o, buf, null);",
    "this.line1pxSegment(this.lastPt.x, this.lastPt.y, tx, ty, o, null, all);",
  ];
  for (const f of MOVE_1PX) if (!move.includes(f)) return ng(`★pointermove の 1px の呼び出しの形が違う（小数の lastPt をそのまま渡していない）: ${f.slice(0, 60)}`);
  if ((move.match(/this\.line1pxSegment\(/g) ?? []).length !== 2) return ng("★pointermove の 1px の呼び出しが 2 か所でない");
  // ★endPointerSession: onPointerUp のあとで、1 枚の経路の取り残しを捨てる。pointerdown の網でも、漏斗より前で捨てる
  const eps = methodBody(src, "endPointerSession");
  const eu = eps.indexOf("this.onPointerUp(last)");
  const ed2 = eps.indexOf("this.dropStaleLine1px();");
  if (eu < 0 || ed2 < 0 || !(eu < ed2)) return ng("★endPointerSession で、onPointerUp のあとに 1 枚の経路の取り残しを捨てていない");
  const dd = down.indexOf("this.dropStaleLine1px();");
  if (dd < 0 || !(dd < df)) return ng("★pointerdown の網で、漏斗より前に 1 枚の経路の取り残しを捨てていない");
  const drop = methodBody(src, "dropStaleLine1px");
  // V209 (A-122): 捨てたとき、見せていた仮の 1 ドットを画面に残さないよう描き直す形になった（捨てる条件と捨て方は同じ）
  if (!/if \(this\.line1px && !this\.line1px\.all\) \{[^}]*?this\.line1px = null;/.test(drop)) return ng("★dropStaleLine1px の中身が違う（1 枚の経路だけを捨てる）");
  // ★V214 (M-2b-1a): mount の「描きかけの束と 1px の仮を捨てる」2 行はコアの openWorkReset へ移った（PC の mount は同じ位置で
  //  openWorkReset を呼ぶだけ）。PC の mount がその片を**1 回だけ**呼ぶことと、片の中で捨てていることを縛る（V213 の片と同じ形）
  const mountPC = methodBodyML(src, "mount");
  if (mountPC === "") return ng("mount を切り出せない（検査が黙る）");
  if (!callsOnce(mountPC, "this.openWorkReset(project, cb);")) return ng("★mount が作品の状態の初期化（openWorkReset）を 1 回だけ呼んでいない");
  const mount = methodBody(src, "openWorkReset");
  if (!/this\.eraseAllStroke = null;/.test(mount)) return ng("mount を切り出せない（検査が黙る）");
  if (!/this\.line1px = null;/.test(mount)) return ng("★mount で 1px の状態を捨てていない（別の作品へ持ち越す）");
  // 新しいモジュールを呼ぶのはペン系の道だけ（直線・図形・塗りには入らない＝K-5）
  // V209 (A-122・R-5): peekLine1px は 1px の線（ペン系の道）の仮の 1 ドットを合成のときだけ見せる所（描き終わりと同じ打ち方＝plot1px を位相の写しで）。
  //  直線・図形・塗りの道ではない（状態 this.line1px はペン系の道でしか作られない）ので、ここに並べる
  // ★V213: ペン系の道の onPointerDownInner / onPointerMove の中身はコアの strokeStart / strokeMoveOne へ移った（名前の置き換えだけ）
  const allowed = new Set(["strokeStart", "strokeMoveOne", "endLine1px", "line1pxSegment", "line1pxPlot", "peekLine1px"]);
  for (const m of src.matchAll(/\bL1\.\w+\(/g)) {
    // その呼び出しを含むメソッドの名前（直前のメソッド宣言）
    const head = src.slice(0, m.index);
    const decl = [...head.matchAll(/^ {2}(?:private |public |protected )?(?:async )?(\w+)\s*\([^\n]*\)[^\n]*\{\s*$/gm)].pop();
    const name = decl?.[1] ?? "?";
    if (!allowed.has(name)) return ng(`★新しいモジュールを ${name} から呼んでいる（ペン系の道だけのはず）`);
  }
  // ★V213: L1 を呼ぶのはコア（src/editor/core/）＝相対の置き場所が 1 段深い
  if (!/import \* as L1 from "\.\.?\/line1px";/.test(src)) return ng("新しいモジュールを import していない");
  return ok();
}
{
  const v = await safe(() => checkS11(REAL.editorSrc));
  check("[S-11] 静的: 漏斗が onPointerUp（道具の分岐・束の確定・履歴より前）／finishEraseAllNow／pointerdown の網にあり・mount で捨てる", v.ok, v.why);
}

// ================= [S-0] 無改変の写し =================
const ALL_CHECKS: { id: string; run: (T: Tree) => Promise<V> }[] = [
  { id: "S-3", run: async (T) => checkS3(T) },
  { id: "S-3b", run: async (T) => checkS3b(T) },
  { id: "S-4", run: (T) => checkS4(T) },
  { id: "S-5", run: async (T) => checkS5(T) },
  { id: "S-7", run: (T) => checkS7(T) },
  { id: "S-11", run: async (T) => checkS11(T.editorSrc) },
];
{
  const { tree, why } = await mutant([]);
  if (!tree) check("[S-0] 無改変の写しを読み込めた", false, why);
  else {
    const bad: string[] = [];
    for (const c of ALL_CHECKS) {
      const v = await safe(() => c.run(tree));
      if (!v.ok) bad.push(`${c.id}: ${v.why}`);
    }
    check("[S-0] 無改変の写しでは全部緑（写しの仕組みが赤を作っていない）", bad.length === 0, bad.slice(0, 3).join(" ／ "));
  }
}

// ================= [S-12] 反証 =================
const ED = "src/editor/editor.ts";
const L1F = "src/editor/line1px.ts";
interface Mut {
  id: string;
  what: string;
  target: string;
  edits: Edit[];
}
const MUTS: Mut[] = [
  {
    id: "①",
    what: "規則を「L 字のときだけ」にする（c が a の斜め隣で、b が a の縦横の隣のときだけ b を描かない）",
    target: "S-3",
    edits: [
      {
        file: L1F,
        from: "  if (Math.abs(cx - st.ax) <= 1 && Math.abs(cy - st.ay) <= 1) {",
        to:
          "  if (Math.abs(cx - st.ax) === 1 && Math.abs(cy - st.ay) === 1 && Math.abs(st.bx - st.ax) + Math.abs(st.by - st.ay) === 1) {",
      },
    ],
  },
  {
    id: "②",
    what: "pointerup の漏斗を呼ばない",
    target: "S-4",
    edits: [{ file: ED, from: "    this.endLine1px(); // ★V191 (A-89): 描き終わりの漏斗（pointerup）", to: "" }],
  },
  {
    id: "②b",
    what: "finishEraseAllNow の漏斗を呼ばない",
    target: "S-4",
    edits: [{ file: ED, from: "    this.endLine1px(); // ★V191 (A-89): 描き終わりの漏斗（束の確定）", to: "" }],
  },
  {
    id: "③",
    what: "太さ 2 にも新しい道を使う",
    target: "S-7",
    edits: [{ file: L1F, from: "  return o.size === 1;", to: "  return o.size <= 2;" }],
  },
  {
    id: "④",
    what: "描いた画素を後から戻す形（Aseprite の形: 仮も先に描き、描かないと決めたら元の色＝なぞる前の 0 に戻す）",
    target: "S-5",
    edits: [
      {
        file: L1F,
        from: "    st.hasB = true;\n    st.bx = cx;\n    st.by = cy;\n    st.bo = o;\n    return;",
        to: "    st.hasB = true;\n    st.bx = cx;\n    st.by = cy;\n    st.bo = o;\n    plot(cx, cy, 0, o);\n    return;",
      },
      {
        file: L1F,
        from: "    // c が a と隣り合う（a そのものも含む）→ b は描かない。仮を c に置き換える\n",
        to:
          "    // c が a と隣り合う（a そのものも含む）→ b は描かない。仮を c に置き換える\n" +
          "    if (st.bx !== st.ax || st.by !== st.ay) plot(st.bx, st.by, 0, { ...(st.bo ?? o), color: 0, texture: \"solid\", tone: undefined, colorTile: undefined });\n" +
          "    plot(cx, cy, 0, o);\n",
      },
      {
        file: L1F,
        from: "  st.bx = cx;\n  st.by = cy;\n  st.bo = o;\n}",
        to: "  st.bx = cx;\n  st.by = cy;\n  st.bo = o;\n  plot(cx, cy, 0, o);\n}",
      },
    ],
  },
  {
    id: "⑥",
    what: "pointerup を最後まで通らずに終わったなぞりの、1 枚の経路の仮を捨てない（dropStaleLine1px を空にする）",
    target: "S-4",
    // V209 (A-122): 捨てる所は描き直しを足したブロックになった。捨てる 1 行を外す（捨てない）
    edits: [{ file: ED, from: "      this.line1px = null;\n      if (shown && this.mounted) this.renderCanvas();\n", to: "      if (shown && this.mounted) this.renderCanvas();\n" }],
  },
  {
    id: "⑦",
    what: "pointermove の 1px の呼び出しに lastPt を丸めて渡す（A-70 の後戻り）",
    target: "S-11",
    edits: [
      {
        file: ED,
        from: "this.line1pxSegment(this.lastPt.x, this.lastPt.y, tx, ty, o, buf, null);",
        to: "this.line1pxSegment(Math.round(this.lastPt.x), Math.round(this.lastPt.y), tx, ty, o, buf, null);",
      },
    ],
  },
  {
    id: "⑤",
    what: "pointerup の漏斗を pushBufferHistory の後ろへ動かす",
    target: "S-11",
    edits: [
      { file: ED, from: "    this.endLine1px(); // ★V191 (A-89): 描き終わりの漏斗（pointerup）\n", to: "" },
      {
        file: ED,
        from: '          this.pushBufferHistory("描画", buf, this.strokeBefore);\n',
        to: '          this.pushBufferHistory("描画", buf, this.strokeBefore);\n          this.endLine1px();\n',
      },
    ],
  },
];
// ★V213 (M-2a): 書き換える字（字そのものは変えない）がコアへ移ったものは、的のファイルをコアにする
//  （editor.ts とコアのどちらにちょうど 1 回あるか。どちらにも無い・両方にあるときは editor.ts のまま＝当たらずに赤）
for (const m of MUTS) for (const e of m.edits) if (e.file === ED) e.file = editorFileHaving(root, e.from) ?? ED;
for (const m of MUTS) {
  const { tree, why } = await mutant(m.edits);
  if (!tree) {
    check(`[S-12${m.id}] 反証の写しを作れた（${m.what}）`, false, why);
    continue;
  }
  const c = ALL_CHECKS.find((x) => x.id === m.target)!;
  const v = await safe(() => c.run(tree));
  const effective = !v.ok && !v.threw;
  check(`[S-12${m.id}] ★反証: ${m.what} → [${m.target}] が赤`, effective, v.ok ? "緑のまま（検査が効いていない）" : v.threw ? v.why : "");
  console.log(`  [S-12${m.id}] → [${m.target}] ${v.ok ? "緑" : "赤"}: ${v.why.slice(0, 120)}`);
  // 参考（数えない）: ① は手ブレ補正オンの [S-3b] でも捕まるか
  if (m.id === "①") {
    const vb = await safe(() => checkS3b(tree));
    console.log(`  [S-12①] 参考 → [S-3b] ${vb.ok ? "緑" : "赤"}: ${vb.why.slice(0, 120)}`);
  }
  // 参考（数えない）: ⑤ は静的な [S-11] だけでなく、動かす [S-4]（やり直しで最後の画素が戻るか）でも捕まるか
  if (m.id === "⑤") {
    const v4 = await safe(() => checkS4(tree));
    console.log(`  [S-12⑤] 参考 → [S-4] ${v4.ok ? "緑" : "赤"}: ${v4.why.slice(0, 120)}`);
  }
}

console.log(`\nv191_smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
