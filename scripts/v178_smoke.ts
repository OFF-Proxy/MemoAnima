// V178（全レイヤー消しゴム A-72）の回帰ゲート。引数不要:
//   npx tsx scripts/v178_smoke.ts
//
// 消しゴムに「全レイヤー」の切り替えを足した回。オンのとき、なぞったところが**そのコマの見えている
// レイヤーすべて**から消える。この回で怖いのは 3 つ:
//   ① 取り違え … ふつうの消しゴムのつもりで全レイヤーを消す。守りは「切り替えが見える」と「Ctrl+Z 1 回で戻る」
//   ② 📌 … 全コマ共通のレイヤーは、ひとなぞりで**全コマから**消える
//   ③ オフのときに今までと変わる（1 画素でも）
//
// ★見方: **本物の editor.ts を Node で動かす**。`Editor` を new して `onPointerDown/Move/Up` に合成した
//  ポインタを流し、**画素・履歴の数・バッファの実体**を見る。禁止の言葉を並べる形（denylist）にはしない
//  ——[S-6]（V174）・[S-14]（V176）・[S-13]（V177）は「字面を見ているだけ」で、書き方を変えると黙った。
//  DOM は最小の偽物だけ: `#ed-canvas` の矩形（クライアント座標 x+0.5 → ドット x の恒等写像）と、
//  `#ed-cursor` に描かれた矩形の記録。画面の描き直し（renderCanvas / paintFilmThumb / rebuildFilm）は
//  **呼ばれた回数だけ数える**（絵を描くのは本物・画面へ出すところだけ偽物）。
//
// ★反証は**実ファイルを書き換えた写し**で走らせる（V177 と同じ流儀）。写しは `node_modules/.v178-smoke/`
//  の下に置く（editor.ts は npm の部品を import するので、リポジトリの node_modules が見える場所でないと
//  読み込めない。node_modules は git の外）。書き換えは**ちょうど 1 か所に当たる**ことを確かめ、
//  当たらなければ赤（実装の形が変わったら気づける）。**例外で落ちた反証は「効いた」と数えない**。
//
// [S-1]  src/editor/raster.ts が V174 時点から 1 バイトも変わっていない
// [S-2]  対象＝実効の 👁 が true かつ実効の 🔒 が false（親・祖父フォルダも表で当てる）。opacity と clip は見ない
// [S-3]  ひとなぞり＝履歴 1 つ・undo で全部戻る・redo でまた消える
//        （★3b: コマを移ってから Ctrl+Z しても、なぞったコマへ戻る／★3c: 眠ったコマでも Ctrl+Z が空振りしない）
// [S-4]  かすり消しの位相: ベタ以外の種類・マイ柄で 3 枚をなぞると、3 枚の消え方が 1 枚の消しゴムと完全に一致
//        （4b: 点線で消すと仮定しても一致＝dashAcc をレイヤーごとに持っている／4c: いまの消しゴムは solid）
// [S-5]  オフのときの出力が、この回の前の editor.ts とビット単位で同じ（固定値＋取り出した旧版）
// [S-6]  1 画素も変わらなかったレイヤーは履歴に入らない（何も変わらなければ履歴を積まない）
// [S-7]  📌 は消したあとも全コマで同じ実体・全コマから消える・フィルムを全部塗り直す・知らせは作品で 1 回
// [S-8]  選択範囲（clip）が全対象に同じように効く
// [S-9]  対象 0 枚（全部 🔒／全部非表示／非表示のフォルダ）でなぞっても 1 画素も変わらず履歴も増えない
// [S-10] ★この回で足した: カーソルの二重線（全レイヤーのときだけ・太さの輪はそのまま・形は太らせた外周）
// [S-11] ★この回で足した: 「全レイヤー」は覚えない（既定オフ・設定に書く口を 1 つも呼ばない）
// [S-12] ★この回で足した: 眠りの最後の網（眠っている対象があるストロークは描かない・半分だけ消さない）
// [S-13] ★この回で足した: いまのレイヤーが 🔒 でも、ほかの見えているレイヤーは消える（オフなら従来どおり止まる）
// [S-14] ★この回で足した: なぞっている途中で道具が変わっても、束をペンの色で塗らない・消した分は確定する
// [S-15] ★Codex 指摘: 全レイヤーの束は、作品に別の変更が入る前（キー・コマンド・重い処理・↶↷・UI を押した時点）に
//        確定して終え、pointerup と同じ状態に戻る。描きながらコマを消しても Ctrl+Z で元の絵に戻る。
//        入口を通らない経路でも、ほかの履歴が積まれる直前に束を確定する（最後の網）。残った束は次に触れた時点で確定して
//        次のストロークを乗っ取らない（別の作品に移っていたら積まない）
// [S-0]  無改変の写しでは全部緑（写しの仕組みが赤を作っていない）
// [S-R]  反証（わざと壊した写しで赤くなること）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
async function safe(fn: () => Promise<V>): Promise<V> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, why: `例外: ${String((e as Error)?.message ?? e).slice(0, 160)}`, threw: true };
  }
}

const root = path.resolve(import.meta.dirname, "..");

// ================= 本物の editor.ts を Node で動かすための最小の舞台 =================
const G = globalThis as unknown as Record<string, unknown>;
G.self = G; // exporter.ts が読む gif.js（ブラウザ前提・self 参照）
G.window = G; // editor.ts の window.setTimeout 等（Node の同名の関数がそのまま使える）
G.devicePixelRatio = 1;
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const cursorRects: Rect[] = [];
const cursorCtx = {
  fillStyle: "",
  imageSmoothingEnabled: false,
  clearRect() {
    cursorRects.length = 0;
  },
  fillRect(x: number, y: number, w: number, h: number) {
    cursorRects.push({ x, y, w, h });
  },
};
/** `#ed-cursor`（2 階のカーソル層）。描かれた矩形を `cursorRects` に記録する */
const CURSOR_CV = { width: 0, height: 0, hidden: true, getContext: () => cursorCtx };
/** `#ed-canvas`。矩形は 320×240 ちょうど＝クライアント座標がそのままドット座標（x+0.5 → 画素 x）。
 *  offsetWidth はカーソル層の大きさ（1 ドット＝3 物理 px）を決めるだけ。
 *  style は `#ed-cvwrap` が見つかると updatePanCursor → applyCanvasCursor がカーソルを代入するため */
const CANVAS = {
  offsetWidth: 960,
  offsetHeight: 720,
  style: {} as Record<string, string>,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
};
/** `#ed-cvwrap`（ポインタを掴む外枠）。**捕捉を本当に取らせる**（掴んだ id を覚える）——終えたストロークが
 *  捕捉を放したかを状態で見るため（Codex 3 回目の穴: releaseCapture を外しても緑だった） */
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Editor: any;
  M: Mod;
  S: Mod;
  LT: Mod;
  C: Mod;
  t: (k: string, v?: Record<string, unknown>) => string;
}
async function loadTree(dir: string, label: string): Promise<Tree> {
  const u = (p: string) => pathToFileURL(path.join(dir, p)).href;
  const E = await import(u("src/editor/editor.ts"));
  const M = await import(u("src/editor/model.ts"));
  const S = await import(u("src/editor/sleep.ts"));
  const LT = await import(u("src/editor/layerTree.ts"));
  const C = await import(u("src/editor/cursor.ts"));
  const I = await import(u("src/i18n/index.ts"));
  return { label, Editor: E.Editor, M, S, LT, C, t: I.t };
}

// ================= 写し（無改変・旧版・反証）の置き場 =================
// 既定は node_modules/.v178-smoke/<pid>（git の外・npm の部品が見える）。
// サンドボックスで node_modules へ書けないとき（使い捨て worktree で node_modules がジャンクション等）は
// 環境変数 V178_SMOKE_WORK で置き場を差し替える。**その祖先に node_modules があること**（部品を解決するため）
const WORK = path.join(
  process.env.V178_SMOKE_WORK || path.join(root, "node_modules", ".v178-smoke"),
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
/** 作業ツリーの src/ の .ts だけを写す（絵の素材や CSS は import されない） */
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
const same = (a: Buf, b: Buf) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** 「なぞって 0 になった画素」の 0/1 の並び（元から 0 だった画素は数えない） */
const zeroMask = (b: Buf, from: Buf) => {
  const m = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) if (b[i] === 0 && from[i] !== 0) m[i] = 1;
  return m;
};
const count = (m: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
};
const snap = (p: Mod, fi: number): Record<string, Buf> =>
  Object.fromEntries(Object.entries(p.frames[fi].layers as Record<string, Buf>).map(([k, v]) => [k, v.slice()]));
const rectMask = (x0: number, y0: number, x1: number, y1: number) => {
  const m = new Uint8Array(PIXELS);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
};

interface LSpec {
  id: string;
  fill?: number;
  visible?: boolean;
  locked?: boolean;
  parent?: string;
  opacity?: number;
  clip?: boolean;
  shared?: boolean;
  /** このコマにこのレイヤーの絵が無い */
  absent?: boolean;
}
interface FSpec {
  id: string;
  visible?: boolean;
  locked?: boolean;
  parent?: string;
}
/** 作りものの作品。各レイヤーは `fill` の色で**全面**塗っておく（どこを消しても分かる） */
function build(T: Tree, frames: number, layers: LSpec[], folders: FSpec[] = []): Mod {
  const p = T.M.newProject("v178");
  const paper = p.frames[0].paper;
  p.layerDefs = layers.map((l) => {
    const d: Mod = { id: l.id, name: l.id, visible: l.visible ?? true, opacity: l.opacity ?? 1 };
    if (l.parent) d.parent = l.parent;
    if (l.clip) d.clip = true;
    if (l.shared) d.shared = true;
    if (l.locked) d.locked = true;
    return d;
  });
  p.folders = folders.map((f) => {
    const d: Mod = { id: f.id, name: f.id, visible: f.visible ?? true, opacity: 1, collapsed: false };
    if (f.parent) d.parent = f.parent;
    if (f.locked) d.locked = true;
    return d;
  });
  p.nextLayerId = 1000;
  p.frames = [];
  const shared: Record<string, Buf> = {};
  for (let i = 0; i < frames; i++) {
    const f: Mod = { paper, layers: {} };
    for (const l of layers) {
      if (l.absent) continue;
      if (l.shared) {
        shared[l.id] ??= T.M.allocIndexBuf(p).fill(l.fill ?? 0);
        f.layers[l.id] = shared[l.id];
      } else f.layers[l.id] = T.M.allocIndexBuf(p).fill(l.fill ?? 0);
    }
    p.frames.push(f);
  }
  return p;
}

interface Log {
  toasts: string[];
  renders: number;
  thumbs: number[];
  films: number;
  /** `cb` の口のうち、トーストとログ以外に触ったもの（設定に書く口など） */
  cb: string[];
}
/** 本物の Editor を作って、作品と道具を持たせる（mount は DOM を組むので通さない） */
function makeEd(T: Tree, p: Mod, o: { frame?: number; active?: string; tool?: string } = {}) {
  const ed = new T.Editor();
  const log: Log = { toasts: [], renders: 0, thumbs: [], films: 0, cb: [] };
  const base: Record<string, unknown> = {
    toast: (m: string) => void log.toasts.push(m),
    appendLog: () => {},
  };
  ed.cb = new Proxy(base, {
    get(tg, k) {
      if (typeof k === "string" && !(k in tg)) log.cb.push(k);
      return (tg as Mod)[k as string];
    },
  });
  ed.project = p;
  ed.frameIndex = o.frame ?? 0;
  ed.activeLayerId = o.active ?? p.layerDefs[p.layerDefs.length - 1].id;
  ed.tool = o.tool ?? "eraser";
  ed.mounted = true;
  // ロックの知らせの間引き（3.4 秒）は `lastLockToastAt = 0` から数える。Node の performance.now() は
  // 起動からの ms なので、起動直後だと**最初の知らせまで間引かれる**（アプリでは起動から描くまでに過ぎている）
  ed.lastLockToastAt = -1e9;
  ed.cursorLive = false; // ホバーのカーソル追従（rAF）は通さない。カーソルは [S-10] が直に描かせて見る
  ed.renderCanvas = () => void log.renders++;
  ed.paintFilmThumb = (i: number) => void log.thumbs.push(i);
  ed.rebuildFilm = () => void log.films++;
  ed.customTones = [{ id: 7, w: 3, h: 2, colors: ["#141414", "", "", "#141414", "#141414", ""] }];
  return { ed, log };
}
/** 「全レイヤー」を切り替える（画面のトグルと同じ口を呼ぶ） */
function setAll(ed: Mod, on: boolean) {
  if (typeof ed.setEraseAllLayers !== "function")
    throw new Error("★setEraseAllLayers が無い（全レイヤーの切り替えが実装されていない）");
  ed.setEraseAllLayers(on);
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
/** キーを押した（`keydownHandler` へ流す形）。target は無し＝文字入力欄ではない */
const key = (k: string, code: string, extra: Mod = {}) => ({
  key: k,
  code,
  repeat: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 0,
  target: null,
  preventDefault() {},
  stopPropagation() {},
  ...extra,
});
type Pt = [number, number];
/** 押す→動かす→離す（本物のハンドラへ） */
function stroke(ed: Mod, pts: Pt[], pressure = 0.5) {
  ed.onPointerDown(ev(pts[0][0], pts[0][1], { pressure }));
  for (const [x, y] of pts.slice(1)) ed.onPointerMove(ev(x, y, { pressure }));
  const [lx, ly] = pts[pts.length - 1];
  ed.onPointerUp(ev(lx, ly, { buttons: 0, pressure: 0 }));
}
/** Ctrl+Z / Ctrl+Y と同じ道（`prepare` を待ってから適用する） */
async function undo(ed: Mod) {
  await ed.applyHistory(() => ed.history.undo(), ed.history.peekUndo());
}
async function redo(ed: Mod) {
  await ed.applyHistory(() => ed.history.redo(), ed.history.peekRedo());
}
/** なぞる道（関節の多い曲がった線。手ブレ補正も効く） */
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
const PATH2: Pt[] = [
  [60, 200],
  [120, 190],
  [180, 205],
  [240, 195],
];

/** 消しゴムでなぞって、各レイヤーの「0 になった画素」の並びを返す */
async function runErase(
  T: Tree,
  o: {
    all: boolean;
    layers: string[];
    active: string;
    frame?: number;
    tone?: string;
    size?: number;
    dither?: boolean;
    stab?: boolean;
    sel?: Uint8Array;
    /** 点線（dot）で消すと仮定する＝penOptions の texture だけ差し替える（位相の仕組みを見るため） */
    dot?: boolean;
    path?: Pt[];
    pressure?: number;
  }
) {
  const fi = o.frame ?? 0;
  const p = build(T, 3, o.layers.map((id, i) => ({ id, fill: i + 1 })));
  const { ed, log } = makeEd(T, p, { frame: fi, active: o.active });
  ed.eraserToneId = o.tone ?? "solid";
  if (o.size) ed.penSize = o.size;
  if (o.dither) ed.ditherFrameShift = true;
  if (o.stab === false) ed.stabilizer = false;
  if (o.sel) ed.selMask = o.sel;
  if (o.dot) {
    const orig = ed.penOptions.bind(ed);
    ed.penOptions = (pr: number) => ({ ...orig(pr), texture: "dot" });
  }
  if (o.all) setAll(ed, true);
  const before = snap(p, fi);
  stroke(ed, o.path ?? PATH, o.pressure ?? 0.5);
  const f = p.frames[fi];
  const masks: Record<string, Uint8Array> = {};
  for (const id of o.layers) masks[id] = zeroMask(f.layers[id], before[id]);
  return { p, ed, log, masks, before };
}

// ================= [S-1] raster.ts が 1 バイトも変わっていない =================
// 描き方（stamp / strokeSegment）は 1 行も変えない約束。変えなければ、raster.ts を import している
// 既存スモーク 8 本（m1119 / m12c / m132b / m14 / m16 / m17 / m19 / m22）はそのまま緑でいられる。
// ★ハッシュで固定する（v176_smoke と同じ値＝V174 時点）。
const RASTER_SHA_V174 = "23af7320c29458a6da5f2c72f2da75d47711e1912fd63d04ae754aa29f58f1be";
const checkS1 = (actual: string): V =>
  actual === RASTER_SHA_V174 ? ok() : ng(`★raster.ts が変わっている（${actual.slice(0, 16)}…）`);

// ================= [S-2] 対象の決め方（白リスト・規則は 1 つ） =================
async function checkS2(T: Tree): Promise<V> {
  if (typeof T.LT.eraseAllTargets !== "function") return ng("★layerTree.ts に eraseAllTargets が無い");
  const folders: FSpec[] = [
    { id: "F1" },
    { id: "F2", visible: false },
    { id: "F3", locked: true },
    { id: "F4", parent: "F2" }, // 自分は表示・親（F2）が非表示
    { id: "F5", parent: "F3" }, // 自分はロックなし・親（F3）がロック
    { id: "F6", parent: "F1" },
  ];
  const layers: LSpec[] = [
    { id: "A", fill: 1 },
    { id: "B", fill: 1, visible: false },
    { id: "C", fill: 1, locked: true },
    { id: "D", fill: 1, opacity: 0 }, // 薄い → 対象（opacity は見ない）
    { id: "E", fill: 1, clip: true }, // クリッピング → 対象（clip は見ない）
    { id: "F", fill: 1, parent: "F1" },
    { id: "G", fill: 1, parent: "F2" }, // ★親が非表示
    { id: "I", fill: 1, parent: "F3" }, // ★親がロック
    { id: "J", fill: 1, parent: "F4" }, // ★祖父が非表示
    { id: "K", fill: 1, parent: "F5" }, // ★祖父がロック
    { id: "L", fill: 1, parent: "F6" },
    { id: "M", fill: 1, absent: true }, // このコマに絵が無い
    { id: "N", fill: 1, visible: false }, // 非表示で眠っている → 眠りの勘定にも入れない
    { id: "P", fill: 1, shared: true },
    { id: "Q", fill: 1, parent: "F999" }, // 壊れた親（存在しない）＝ルート扱い
    { id: "Z", fill: 1 }, // 見えていて、コマ 0 では眠っている
  ];
  const p = build(T, 2, layers, folders);
  await T.S.sleepLayer(p, p.frames[0], "Z");
  await T.S.sleepLayer(p, p.frames[0], "N");
  if (p.frames[0].layers.Z || !p.frames[0].sleep?.Z) return ng("前提: Z が眠っていない（検査が黙る）");
  const r = T.LT.eraseAllTargets(p, 0);
  const want = ["A", "D", "E", "F", "L", "P", "Q"];
  if (JSON.stringify(r?.ids) !== JSON.stringify(want))
    return ng(`★対象が違う: ${r?.ids?.join(",")}（期待 ${want.join(",")}）`);
  if (JSON.stringify(r?.asleep) !== JSON.stringify(["Z"]))
    return ng(`★眠っている対象が違う: ${r?.asleep?.join(",")}（期待 Z）`);
  // 動かして見る（眠りの無いコマ 1）: 対象だけが消え、ほかは 1 画素も変わらない
  const { ed } = makeEd(T, p, { frame: 1, active: "A" });
  setAll(ed, true);
  const before = snap(p, 1);
  stroke(ed, PATH);
  const changed = p.layerDefs
    .map((l: Mod) => l.id as string)
    .filter((id: string) => p.frames[1].layers[id] && !same(p.frames[1].layers[id], before[id]));
  const want1 = [...want, "Z"];
  if (JSON.stringify(changed) !== JSON.stringify(want1))
    return ng(`★なぞって消えたレイヤーが違う: ${changed.join(",")}（期待 ${want1.join(",")}）`);
  return ok();
}

// ================= [S-3] ひとなぞり＝履歴 1 つ =================
const ABC: LSpec[] = [
  { id: "A", fill: 1 },
  { id: "B", fill: 2 },
  { id: "C", fill: 3 },
];
async function checkS3(T: Tree): Promise<V> {
  const p = build(T, 3, ABC);
  const { ed } = makeEd(T, p, { frame: 1, active: "B" });
  setAll(ed, true);
  const pre = snap(p, 1);
  const other = shaOf(...Object.values(p.frames[0].layers as Record<string, Buf>), ...Object.values(p.frames[2].layers as Record<string, Buf>));
  const d0 = ed.history.undoDepth;
  stroke(ed, PATH);
  const post = snap(p, 1);
  const grew = ed.history.undoDepth - d0;
  if (grew !== 1) return ng(`★ひとなぞりで履歴が ${grew} 増えた（1 のはず）`);
  for (const id of ["A", "B", "C"]) if (same(post[id], pre[id])) return ng(`★${id} が消えていない`);
  await undo(ed);
  for (const id of ["A", "B", "C"])
    if (!same(p.frames[1].layers[id], pre[id])) return ng(`★Ctrl+Z 1 回で ${id} が戻らない`);
  await redo(ed);
  for (const id of ["A", "B", "C"])
    if (!same(p.frames[1].layers[id], post[id])) return ng(`★Ctrl+Y で ${id} がもう一度消えない`);
  const other2 = shaOf(...Object.values(p.frames[0].layers as Record<string, Buf>), ...Object.values(p.frames[2].layers as Record<string, Buf>));
  if (other2 !== other) return ng("★なぞっていないコマの絵が変わった");
  return ok();
}
/** 3b: なぞったあとコマを移ってから Ctrl+Z しても、なぞったコマへ戻る（いま見ているコマへ書き戻さない） */
async function checkS3b(T: Tree): Promise<V> {
  const p = build(T, 3, ABC);
  // コマ 2 は別の絵にしておく（書き戻し先を取り違えたら分かるように）
  for (const id of ["A", "B", "C"]) p.frames[2].layers[id].fill(5);
  const { ed } = makeEd(T, p, { frame: 1, active: "B" });
  setAll(ed, true);
  const pre1 = snap(p, 1);
  const pre2 = snap(p, 2);
  stroke(ed, PATH);
  ed.frameIndex = 2; // 矢印キーなどでコマを移った
  await undo(ed);
  for (const id of ["A", "B", "C"]) {
    if (!same(p.frames[2].layers[id], pre2[id])) return ng(`★Ctrl+Z がいま見ているコマ（2）の ${id} を書き換えた`);
    if (!same(p.frames[1].layers[id], pre1[id])) return ng(`★Ctrl+Z でなぞったコマ（1）の ${id} が戻らない`);
  }
  return ok();
}
/** 3c: 大きい作品で、なぞったコマが窓の外へ出て眠ってからの Ctrl+Z / Ctrl+Y */
async function checkS3c(T: Tree): Promise<V> {
  const p = build(T, 12, ABC);
  const { ed } = makeEd(T, p, { frame: 1, active: "B" });
  ed.sleepOn = true;
  setAll(ed, true);
  const pre = snap(p, 1);
  stroke(ed, PATH);
  const post = snap(p, 1);
  if (same(post.A, pre.A)) return ng("前提: 消えていない（検査が黙る）");
  ed.frameIndex = 10;
  await T.S.sleepFrame(p, p.frames[1], new Set());
  if (!T.S.frameHasAsleep(p.frames[1])) return ng("前提: コマ 1 が眠っていない（検査が黙る）");
  await undo(ed);
  await T.S.wakeFrame(p, p.frames[1], "read");
  for (const id of ["A", "B", "C"])
    if (!same(p.frames[1].layers[id], pre[id])) return ng(`★眠ったコマの Ctrl+Z で ${id} が戻らない（黙って空振り）`);
  await T.S.sleepFrame(p, p.frames[1], new Set());
  await redo(ed);
  await T.S.wakeFrame(p, p.frames[1], "read");
  for (const id of ["A", "B", "C"])
    if (!same(p.frames[1].layers[id], post[id])) return ng(`★眠ったコマの Ctrl+Y で ${id} が消えない`);
  return ok();
}

// ================= [S-4] かすり消しの位相 =================
async function checkS4a(T: Tree): Promise<V> {
  const cases: { tone: string; size?: number; stab?: boolean; frame?: number; dither?: boolean }[] = [
    { tone: "halftone-l" },
    { tone: "checker-s", size: 5 },
    { tone: "hatch-l", size: 12 },
    { tone: "dot-sparse-l", size: 5, stab: false },
    { tone: "custom:7", size: 8 }, // マイ柄（形で消す）
    { tone: "grid-s", size: 3, frame: 2, dither: true }, // コマでずらす（コマ 2 はずれる）
  ];
  // 前提: ベタ以外は本当に「かすれて」消えている（ベタより消える画素が少ない）
  const solid = await runErase(T, { all: false, layers: ["A"], active: "A", size: 12 });
  const hatch = await runErase(T, { all: false, layers: ["A"], active: "A", size: 12, tone: "hatch-l" });
  if (!(count(hatch.masks.A) > 0 && count(hatch.masks.A) < count(solid.masks.A)))
    return ng("前提: かすり消しがかすれていない（検査が黙る）");
  // タップ（押して動かさずに離す）＝押した瞬間の打点だけ。動かすなぞりでは次の線分が同じ所を打ち直すので、
  // 「打点を 1 枚にしか打たない」形はタップでしか見えない
  for (const size of [1, 2, 5, 12]) {
    const tap: Pt[] = [[160, 120]];
    const ref = await runErase(T, { all: false, layers: ["A"], active: "A", size, path: tap });
    const got = await runErase(T, { all: true, layers: ["A", "B", "C"], active: "B", size, path: tap });
    if (count(ref.masks.A) === 0) return ng(`前提: 太さ ${size} のタップで消えていない（検査が黙る）`);
    for (const id of ["A", "B", "C"])
      if (!same(got.masks[id], ref.masks.A)) return ng(`★太さ ${size} のタップ: ${id} の消え方が 1 枚の消しゴムと違う`);
  }
  for (const c of cases) {
    const ref = await runErase(T, { all: false, layers: ["A"], active: "A", ...c });
    const got = await runErase(T, { all: true, layers: ["A", "B", "C"], active: "B", ...c });
    if (count(ref.masks.A) === 0) return ng(`前提: ${c.tone} で 1 画素も消えていない（検査が黙る）`);
    for (const id of ["A", "B", "C"])
      if (!same(got.masks[id], ref.masks.A))
        return ng(`★${c.tone}: ${id} の消え方が 1 枚の消しゴムと違う（位相がずれている）`);
  }
  return ok();
}
/** 4b: 位相の仕組み。**点線（dot）で消すと仮定して** penOptions の texture だけ差し替えても、
 *  3 枚の穴の位置が 1 枚の消しゴムと同じ＝dashAcc をレイヤーごとに持っている（要件 §3-2 の落とし穴） */
async function checkS4b(T: Tree): Promise<V> {
  const solid = await runErase(T, { all: false, layers: ["A"], active: "A", size: 3 });
  const ref = await runErase(T, { all: false, layers: ["A"], active: "A", size: 3, dot: true });
  if (!(count(ref.masks.A) > 0 && count(ref.masks.A) < count(solid.masks.A)))
    return ng("前提: 点線で消えていない（検査が黙る）");
  const got = await runErase(T, { all: true, layers: ["A", "B", "C"], active: "B", size: 3, dot: true });
  for (const id of ["A", "B", "C"])
    if (!same(got.masks[id], ref.masks.A))
      return ng(`★点線で消すと ${id} の穴の位置が 1 枚の消しゴムとずれる（dashAcc を共有している）`);
  return ok();
}
/** 4c: いまの消しゴムは texture=solid（＝点線の位相を消費しない）。変わったら 4b が守りの本体になる */
async function checkS4c(T: Tree): Promise<V> {
  const p = build(T, 1, ABC);
  for (const tone of ["solid", "halftone-l", "custom:7"]) {
    const { ed } = makeEd(T, p, { active: "A" });
    ed.eraserToneId = tone;
    ed.texture = "dot"; // ペンで点線を選んでいても、消しゴムは solid
    const o = ed.penOptions(0.5);
    if (o.texture !== "solid") return ng(`${tone}: 消しゴムの texture が ${o.texture}`);
    if (o.color !== 0) return ng(`${tone}: 消しゴムの色が 0 でない`);
  }
  return ok();
}

// ================= [S-5] オフのときは、この回の前とビット単位で同じ =================
/** この回の前の editor.ts（コミット 952c321 の blob）。★生きた旧版との照合に使う */
const OLD_EDITOR_BLOB = "f4f3eadea90e7b9a3fc6a302b2811dbd7d3ec9f5";
/** ★この回の前の editor.ts で [S-5] の筋書きを走らせて得た値（2026-09-23・V178 の実装前に測った） */
const GOLDEN_S5 = "39ac411bf68c854f4b1928a408ffd62362b299b19af9dcbb932dc73baf9c5b31";
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** オフのまま（「全レイヤー」を一度も触らない）で、消しゴム・ペン・ブラシを 1 枚になぞる筋書き */
async function scenarioS5(T: Tree): Promise<string> {
  const cases: {
    tool: string;
    size: number;
    tone?: string;
    texture?: string;
    brushTone?: string;
    stab?: boolean;
    pressure?: number;
    dither?: boolean;
    frame?: number;
    sel?: boolean;
  }[] = [
    { tool: "eraser", size: 3 },
    { tool: "eraser", size: 12, tone: "halftone-l", stab: false, pressure: 0.8 },
    { tool: "eraser", size: 1, tone: "custom:7" },
    { tool: "eraser", size: 2, tone: "checker-s", dither: true, frame: 1 },
    { tool: "eraser", size: 5, sel: true },
    { tool: "pen", size: 5, texture: "rough" },
    { tool: "pen", size: 3, texture: "dot" },
    { tool: "brush", size: 8, brushTone: "halftone-s" },
  ];
  const rows: string[] = [];
  const saved = Math.random;
  for (const c of cases) {
    Math.random = mulberry32(178);
    try {
      const fi = c.frame ?? 0;
      const p = build(T, 3, ABC);
      const { ed } = makeEd(T, p, { frame: fi, active: "B", tool: c.tool });
      if (c.tone) ed.eraserToneId = c.tone;
      if (c.brushTone) ed.brushToneId = c.brushTone;
      if (c.texture) ed.texture = c.texture;
      ed.penSize = c.size;
      if (c.dither) ed.ditherFrameShift = true;
      if (c.stab === false) ed.stabilizer = false;
      if (c.sel) ed.selMask = rectMask(100, 80, 220, 160);
      const layers = () => ["A", "B", "C"].map((id) => p.frames[fi].layers[id] as Buf);
      const pre = shaOf(...layers());
      stroke(ed, PATH, c.pressure ?? 0.5);
      const post = shaOf(...layers());
      const depth = ed.history.undoDepth;
      await undo(ed);
      const back = shaOf(...layers()) === pre;
      rows.push(`${c.tool}/${c.size}/${c.tone ?? c.texture ?? c.brushTone ?? "-"}:${post}:${depth}:${back}`);
    } finally {
      Math.random = saved;
    }
  }
  return rows.join("\n");
}

// ================= [S-6] 変わらなかったレイヤーは履歴に入らない =================
async function checkS6(T: Tree): Promise<V> {
  // A: 全面に絵 / B: 空 / C: なぞる所の外（左上 20×20）にだけ絵
  const p = build(T, 1, [
    { id: "A", fill: 1 },
    { id: "B", fill: 0 },
    { id: "C", fill: 0 },
  ]);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) p.frames[0].layers.C[y * W + x] = 3;
  const { ed } = makeEd(T, p, { active: "A" });
  setAll(ed, true);
  const pre = snap(p, 0);
  const d0 = ed.history.undoDepth;
  stroke(ed, PATH);
  if (ed.history.undoDepth !== d0 + 1) return ng(`前提: 履歴が ${ed.history.undoDepth - d0} 増えた（1 のはず）`);
  const e = ed.history.peekUndo();
  const per = PIXELS * (p.frames[0].layers.A as Buf).BYTES_PER_ELEMENT;
  if (e?.bytes !== 2 * per)
    return ng(`★変わっていないレイヤーまで履歴に入っている（${e?.bytes} B・変わったのは 1 枚＝${2 * per} B のはず）`);
  if (!same(p.frames[0].layers.B, pre.B) || !same(p.frames[0].layers.C, pre.C)) return ng("前提: B・C が変わった");
  await undo(ed);
  if (!same(p.frames[0].layers.A, pre.A)) return ng("★Ctrl+Z で A が戻らない");
  // 何も変わらないなぞり（全部空の所）は、履歴を積まない
  const q = build(T, 1, [
    { id: "A", fill: 0 },
    { id: "B", fill: 0 },
  ]);
  const r = makeEd(T, q, { active: "A" });
  setAll(r.ed, true);
  const d1 = r.ed.history.undoDepth;
  stroke(r.ed, PATH);
  if (r.ed.history.undoDepth !== d1) return ng("★1 画素も変わらないなぞりで履歴を積んだ");
  return ok();
}

// ================= [S-7] 📌 全コマ共通レイヤー =================
async function checkS7(T: Tree): Promise<V> {
  const p = build(T, 5, [
    { id: "P", fill: 4, shared: true },
    { id: "A", fill: 1 },
  ]);
  const { ed, log } = makeEd(T, p, { frame: 2, active: "A" });
  setAll(ed, true);
  const P0 = p.frames[0].layers.P as Buf;
  const pre = P0.slice();
  const pin = T.t("ed.eraser.allLayers.pinned.toast");
  const pins = () => log.toasts.filter((x) => x === pin).length;
  stroke(ed, PATH);
  for (let i = 0; i < 5; i++) if (p.frames[i].layers.P !== P0) return ng(`★📌 がコマ ${i} で別の実体になった`);
  const erased = count(zeroMask(P0, pre));
  if (erased === 0) return ng("★📌 が消えていない");
  if (log.films < 1) return ng("★📌 を消したのに、フィルムを全部塗り直していない（全コマが変わったことに気づけない）");
  if (pins() !== 1) return ng(`★📌 の知らせが ${pins()} 回（最初の 1 回だけのはず）`);
  const afterFirst = P0.slice();
  stroke(ed, PATH2);
  if (pins() !== 1) return ng(`★2 回目のなぞりでも 📌 の知らせが出た（${pins()} 回）`);
  const films0 = log.films;
  await undo(ed);
  if (!same(P0, afterFirst)) return ng("★Ctrl+Z で 2 回目のなぞりが 📌 から戻らない");
  await undo(ed);
  if (!same(P0, pre)) return ng("★Ctrl+Z で 📌 が戻らない");
  for (let i = 0; i < 5; i++) if (p.frames[i].layers.P !== P0) return ng(`★Ctrl+Z のあと 📌 がコマ ${i} で別の実体`);
  if (log.films < films0 + 2) return ng("★📌 の Ctrl+Z でフィルムを塗り直していない");
  // 📌 が対象に入らない（非表示）なら、全コマは変わらない＝塗り直さない・知らせない
  const q = build(T, 5, [
    { id: "P", fill: 4, shared: true, visible: false },
    { id: "A", fill: 1 },
  ]);
  const r = makeEd(T, q, { frame: 2, active: "A" });
  setAll(r.ed, true);
  stroke(r.ed, PATH);
  if (r.log.films !== 0) return ng("★📌 を消していないのにフィルムを全部塗り直した");
  if (r.log.toasts.includes(pin)) return ng("★📌 を消していないのに 📌 の知らせが出た");
  // ★知らせは**作品ごと**に 1 回。同じ Editor で別の作品を開いたら、その作品でもう一度出す
  //  （mount は Node で動かせないので、作品の入れ替えは project の差し替えで表す）
  const p2 = build(T, 3, [
    { id: "P", fill: 4, shared: true },
    { id: "A", fill: 1 },
  ]);
  ed.project = p2;
  ed.frameIndex = 1;
  stroke(ed, PATH);
  if (pins() !== 2) return ng(`★別の作品を開いたのに 📌 の知らせが出ない（通算 ${pins()} 回・2 回のはず）`);
  stroke(ed, PATH2);
  if (pins() !== 2) return ng(`★同じ作品の 2 回目でも 📌 の知らせが出た（通算 ${pins()} 回）`);
  // ★知らせを出した作品の記録は**弱い参照**（WeakSet）。ふつうの Set だと、閉じた作品（数百 MB になり得る）を
  //  Editor が抱え続ける。WeakSet は中身を数えられないので、実体の型で見る（Codex 2 回目の穴）
  if (!(ed.eraseAllPinNoticed instanceof WeakSet)) return ng("★📌 の知らせの記録が WeakSet でない（閉じた作品を抱え込む）");
  return ok();
}

// ================= [S-8] 選択範囲 =================
async function checkS8(T: Tree): Promise<V> {
  const sel = rectMask(100, 80, 200, 160);
  const ref = await runErase(T, { all: false, layers: ["A"], active: "A", sel, size: 5 });
  const got = await runErase(T, { all: true, layers: ["A", "B", "C"], active: "B", sel, size: 5 });
  if (count(ref.masks.A) === 0) return ng("前提: 範囲の中で消えていない（検査が黙る）");
  for (const id of ["A", "B", "C"]) {
    const m = got.masks[id];
    for (let i = 0; i < PIXELS; i++) if (m[i] && !sel[i]) return ng(`★${id}: 選択範囲の外が消えた`);
    if (!same(m, ref.masks.A)) return ng(`★${id}: 消え方が 1 枚の消しゴム（選択あり）と違う`);
  }
  return ok();
}

// ================= [S-9] 対象 0 枚 =================
async function checkS9(T: Tree): Promise<V> {
  const kinds: { kind: string; layers: LSpec[]; folders?: FSpec[] }[] = [
    { kind: "全部非表示", layers: [{ id: "A", fill: 1, visible: false }, { id: "B", fill: 2, visible: false }] },
    { kind: "全部ロック", layers: [{ id: "A", fill: 1, locked: true }, { id: "B", fill: 2, locked: true }] },
    {
      kind: "非表示のフォルダの中",
      layers: [{ id: "A", fill: 1, parent: "F" }, { id: "B", fill: 2, parent: "F" }],
      folders: [{ id: "F", visible: false }],
    },
  ];
  for (const k of kinds) {
    const p = build(T, 1, k.layers, k.folders ?? []);
    const { ed, log } = makeEd(T, p, { active: "B" });
    setAll(ed, true);
    const pre = shaOf(p.frames[0].layers.A, p.frames[0].layers.B);
    const d0 = ed.history.undoDepth;
    stroke(ed, PATH);
    if (shaOf(p.frames[0].layers.A, p.frames[0].layers.B) !== pre) return ng(`★${k.kind}: 対象 0 枚なのに絵が変わった`);
    if (ed.history.undoDepth !== d0) return ng(`★${k.kind}: 対象 0 枚なのに履歴が増えた`);
    const none = T.t("ed.eraser.allLayers.none.toast");
    const n = log.toasts.filter((x) => x === none).length;
    if (n !== 1) return ng(`★${k.kind}: 「消せるレイヤーがない」の知らせが ${n} 回（1 回のはず）`);
    if (ed.pointerDown) return ng(`★${k.kind}: 描き始めてしまっている（掴んだまま）`);
  }
  return ok();
}

// ================= [S-10] カーソルの二重線 =================
type PxSet = Set<number>;
const K = (x: number, y: number) => (y + 4096) * 16384 + (x + 4096);
function rectsToSet(rs: Rect[]): PxSet {
  const s: PxSet = new Set();
  for (const r of rs) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) s.add(K(x, y));
  return s;
}
/** 検査側が**自分で**求める物差し: 消えるドットの集合を g だけ太らせた領域の、4 近傍で外に接する画素 */
function dilationBoundary(
  cells: { dx: number; dy: number }[],
  L: (d: number) => number,
  Tt: (d: number) => number,
  g: number
): PxSet {
  const rects = cells.map((c) => ({ x0: L(c.dx) - g, x1: L(c.dx + 1) + g, y0: Tt(c.dy) - g, y1: Tt(c.dy + 1) + g }));
  const inD = (x: number, y: number) => rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
  const xs0 = Math.min(...rects.map((r) => r.x0)) - 1;
  const xs1 = Math.max(...rects.map((r) => r.x1)) + 1;
  const ys0 = Math.min(...rects.map((r) => r.y0)) - 1;
  const ys1 = Math.max(...rects.map((r) => r.y1)) + 1;
  const out: PxSet = new Set();
  for (let y = ys0; y < ys1; y++)
    for (let x = xs0; x < xs1; x++) {
      if (!inD(x, y)) continue;
      if (!inD(x - 1, y) || !inD(x + 1, y) || !inD(x, y - 1) || !inD(x, y + 1)) out.add(K(x, y));
    }
  return out;
}
const setEq = (a: PxSet, b: PxSet) => a.size === b.size && [...a].every((k) => b.has(k));
async function checkS10(T: Tree): Promise<V> {
  if (typeof T.C.outerRingRuns !== "function") return ng("★cursor.ts に outerRingRuns が無い");
  // (a) 純関数: どの太さ・どの倍率でも「太らせた領域の外周」と 1 画素も違わない
  for (const size of [1, 2, 3, 5, 8, 12])
    for (const px of [1, 2, 3, 4.5, 8, 16])
      for (const g of [2, 3, 6]) {
        const L = (d: number) => Math.round((160 + d) * px);
        const Tt = (d: number) => Math.round((120 + d) * px);
        const got = rectsToSet(
          (T.C.outerRingRuns(size, L, Tt, g) as { x: number; y: number; w: number }[]).map((r) => ({ ...r, h: 1 }))
        );
        const want = dilationBoundary(T.C.penFootprint(size), L, Tt, g);
        if (!setEq(got, want)) return ng(`★太さ ${size}・1 ドット ${px}px・間 ${g}: 外側の線が太らせた外周とずれる`);
      }
  // (b) 本物の paintCursorLayer: 全レイヤーのときだけ二重・太さの輪はそのまま
  const p = build(T, 1, [{ id: "A", fill: 1 }]);
  const { ed } = makeEd(T, p, { active: "A" });
  ed.cursorLive = true; // 2 階（輪）は cursorLive のときだけ描く（makeEd はホバー追従を止めている）
  ed.cursorDot = { x: 160, y: 120 };
  const px = CANVAS.offsetWidth / W; // devicePixelRatio 1
  for (const size of [1, 3, 8]) {
    ed.penSize = size;
    setAll(ed, false);
    ed.cursorPainted = "";
    ed.paintCursorLayer();
    const off = rectsToSet(cursorRects);
    if (off.size === 0) return ng("前提: 輪が描かれていない（検査が黙る）");
    setAll(ed, true); // 切り替えたら、ポインタを動かさなくても描き直す
    const on = rectsToSet(cursorRects);
    for (const k of off) if (!on.has(k)) return ng(`★太さ ${size}: 全レイヤーにすると太さの輪が変わった`);
    const extra: PxSet = new Set([...on].filter((k) => !off.has(k)));
    if (extra.size === 0) return ng(`★太さ ${size}: 全レイヤーなのに二重線が出ない（切り替えても描き直していない）`);
    const L = (d: number) => Math.round((160 + d) * px);
    const Tt = (d: number) => Math.round((120 + d) * px);
    const cells = T.C.penFootprint(size) as { dx: number; dy: number }[];
    // 外側の線と輪の中身の間隔 g（チェビシェフ距離）。外周の画素はどれも同じ距離にあるはず
    const dist = (k: number) => {
      const x = (k % 16384) - 4096;
      const y = Math.floor(k / 16384) - 4096;
      let best = Infinity;
      for (const c of cells) {
        const gx = Math.max(0, L(c.dx) - x, x - (L(c.dx + 1) - 1));
        const gy = Math.max(0, Tt(c.dy) - y, y - (Tt(c.dy + 1) - 1));
        best = Math.min(best, Math.max(gx, gy));
      }
      return best;
    };
    const ds = [...extra].map(dist);
    const g = Math.max(...ds);
    if (Math.min(...ds) !== g || g < 2) return ng(`★太さ ${size}: 外側の線が輪から一定の間隔で離れていない（${Math.min(...ds)}〜${g}）`);
    if (!setEq(extra, dilationBoundary(cells, L, Tt, g))) return ng(`★太さ ${size}: 外側の線が太らせた外周の形でない`);
  }
  // ペンでは、全レイヤーをオンにしていても二重にしない（消しゴムの設定）
  ed.tool = "pen";
  ed.penSize = 3;
  setAll(ed, false);
  ed.cursorPainted = "";
  ed.paintCursorLayer();
  const penOff = rectsToSet(cursorRects);
  setAll(ed, true);
  ed.cursorPainted = "";
  ed.paintCursorLayer();
  if (!setEq(penOff, rectsToSet(cursorRects))) return ng("★ペンのカーソルまで二重になった");
  return ok();
}

// ================= [S-11] 覚えない =================
async function checkS11(T: Tree): Promise<V> {
  const p = build(T, 1, [{ id: "A", fill: 1 }]);
  const { ed, log } = makeEd(T, p, { active: "A" });
  if (ed.eraseAllLayers !== false) return ng(`★既定がオフでない（${String(ed.eraseAllLayers)}）`);
  setAll(ed, true);
  if (ed.eraseAllLayers !== true) return ng("前提: オンにできない");
  setAll(ed, false);
  setAll(ed, true);
  if (log.cb.length) return ng(`★切り替えで設定に書く口を呼んだ: ${log.cb.join(",")}（覚えない約束）`);
  if (new T.Editor().eraseAllLayers !== false) return ng("★新しく作った Editor がオンで始まる");
  return ok();
}

// ================= [S-12] 眠りの最後の網 =================
async function checkS12(T: Tree): Promise<V> {
  const p = build(T, 3, [...ABC, { id: "H", fill: 4, visible: false }]);
  const f = p.frames[0];
  await T.S.sleepLayer(p, f, "B");
  await T.S.sleepLayer(p, f, "H"); // 非表示は対象外＝眠っていても止めない
  if (f.layers.B || f.layers.H) return ng("前提: 眠っていない（検査が黙る）");
  const { ed, log } = makeEd(T, p, { active: "A" });
  ed.sleepOn = true;
  // オンにした時点で、窓がまだ眠っていれば起こす入口（renderCanvas）を 1 回叩く（先回り・§3-5）
  const rOn = log.renders;
  setAll(ed, true);
  if (log.renders !== rOn + 1) return ng(`★オンにしたとき、眠っている窓を起こす入口を叩いていない（${log.renders - rOn} 回）`);
  // 眠りが無ければ叩かない（オンにするたびに描き直さない）
  {
    const q = build(T, 3, ABC);
    const r = makeEd(T, q, { active: "A" });
    r.ed.sleepOn = true;
    const r0 = r.log.renders;
    setAll(r.ed, true);
    if (r.log.renders !== r0) return ng("★眠りが無いのに、オンにしただけで描き直した");
  }
  const preA = (f.layers.A as Buf).slice();
  const preC = (f.layers.C as Buf).slice();
  const d0 = ed.history.undoDepth;
  const r0 = log.renders;
  stroke(ed, PATH);
  if (!same(f.layers.A, preA) || !same(f.layers.C, preC))
    return ng("★眠っている対象があるのに、起きている分だけ消えた（半分だけ消えた状態）");
  if (ed.history.undoDepth !== d0) return ng("★眠っている対象があるのに履歴を積んだ");
  const wait = T.t("ed.eraser.allLayers.wait.toast");
  const n = log.toasts.filter((x) => x === wait).length;
  if (n !== 1) return ng(`★「準備中です」の知らせが ${n} 回（1 回のはず）`);
  if (log.renders <= r0) return ng("★起こす入口（renderCanvas の窓）を叩いていない");
  if (ed.pointerDown) return ng("★描き始めてしまっている（掴んだまま）");
  // 起こし終わったら、次のストロークから効く（非表示の H は眠ったまま＝止めない）
  await T.S.wakeLayer(p, f, "B", "write");
  const preB = (f.layers.B as Buf).slice();
  stroke(ed, PATH);
  if (same(f.layers.A, preA) || same(f.layers.B, preB) || same(f.layers.C, preC))
    return ng("★起こしたあとのストロークで消えない");
  if (f.layers.H) return ng("★非表示の H まで起こして触った");
  if (ed.history.undoDepth !== d0 + 1) return ng("★起こしたあとのストロークの履歴が 1 でない");
  return ok();
}

// ================= [S-15] 束は、作品に別の変更が入る前に確定して終える（Codex 指摘 3 回） =================
// 描いている最中でもショートカットは効く（onKeyDown に pointerDown の関所は無い）。束より先にコマの削除などが走ると、
// その履歴が「消したあと」の絵を抱え、**Ctrl+Z しても元の絵に戻らない**（Codex 2 回目・高）。
// ↶↷ ボタンは runCommand を通らず、もう 1 本のポインタ（ペンを置いたままマウス）で押せる（Codex 3 回目・高）。
// また重い処理の最中にフォーカスを失うと pointerup の関所で確定されず、**残った束が次のストロークを乗っ取る**（Codex 1 回目・中）。
// 終えたあとは **pointerup と同じ状態**（捕捉・終端の控え・解決済みトーンを残さない＝Codex 3 回目の穴）
/** 全レイヤーで描き始めて、押したまま途中まで動かす */
function beginAllLayerStroke(ed: Mod) {
  setAll(ed, true);
  ed.onPointerDown(ev(40, 60));
  ed.onPointerMove(ev(120, 60));
  if (!ed.pointerDown || !ed.eraseAllStroke) throw new Error("前提: 描きかけになっていない");
  if (ed.capturedPointerId !== 1 || CVWRAP.captured !== 1) throw new Error("前提: ポインタを掴んでいない（検査が黙る）");
}
/** 束を終えたあとは、pointerup と同じ状態に戻っていること（束なし・押していない・捕捉なし・終端の控えなし・解決済みトーンなし） */
function endedLikePointerUp(ed: Mod, where: string): V {
  if (ed.eraseAllStroke) return ng(`★${where}: 束が残っている`);
  if (ed.pointerDown) return ng(`★${where}: 描きかけが続いている`);
  if (ed.capturedPointerId !== null || CVWRAP.captured !== null) return ng(`★${where}: ポインタを掴んだまま（releaseCapture していない）`);
  if (ed.lastPointerEvent !== null) return ng(`★${where}: 途切れたときの終端の控え（lastPointerEvent）が残っている`);
  if (ed.strokeTone !== null) return ng(`★${where}: ストロークの解決済みトーン（strokeTone）が残っている`);
  return ok();
}
async function checkS15(T: Tree): Promise<V> {
  // (a) ★描きながらショートカットでコマを消す（本物の入口 runCommand("frame.delete") → runHeavy → deleteFrameInner）
  {
    const p = build(T, 3, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    ed.afterFrameStructureChange = () => {}; // コマ構造が変わったあとの画面の組み直し（DOM）だけ差し替える
    const f0 = p.frames[0];
    const pre = snap(p, 0);
    beginAllLayerStroke(ed);
    ed.runCommand("frame.delete");
    for (let i = 0; i < 50 && ed.busyKind; i++) await new Promise((r) => setTimeout(r, 10));
    if (p.frames.includes(f0)) return ng("前提: コマが消えていない（検査が黙る）");
    if (ed.history.undoDepth !== 2) return ng(`★描きかけの束が、コマの削除より先に確定していない（履歴 ${ed.history.undoDepth}・消しゴム→削除の 2 のはず）`);
    const st = endedLikePointerUp(ed, "コマの削除のあと");
    if (!st.ok) return st;
    // 押したまま動かして離しても、もう何も起きない（ストロークはコマンドの時点で終わっている）
    const mid = p.frames.map((f: Mod) => shaOf(...(Object.values(f.layers) as Buf[]))).join();
    ed.onPointerMove(ev(200, 80));
    ed.onPointerUp(ev(200, 80, { buttons: 0 }));
    if (p.frames.map((f: Mod) => shaOf(...(Object.values(f.layers) as Buf[]))).join() !== mid) return ng("★コマンドのあとのなぞりで絵が変わった");
    if (ed.history.undoDepth !== 2) return ng("★コマンドのあとの pointerup で履歴が増えた");
    await undo(ed); // コマの削除を戻す
    await undo(ed); // 消しゴムを戻す
    if (!p.frames.includes(f0)) return ng("★Ctrl+Z でコマが戻らない");
    for (const id of ["A", "B", "C"]) if (!same(f0.layers[id], pre[id])) return ng(`★Ctrl+Z 2 回でコマ 0 の ${id} が元の絵に戻らない`);
  }
  // (b) 重い処理の入口（beginBusy）でも確定して終える＝重い処理の最中に束が残らない
  {
    const p = build(T, 2, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    const pre = snap(p, 0);
    beginAllLayerStroke(ed);
    ed.beginBusy("heavy");
    if (ed.history.undoDepth !== 1) return ng(`★重い処理の入口で束を確定していない（履歴 ${ed.history.undoDepth}）`);
    const st = endedLikePointerUp(ed, "重い処理の入口のあと");
    if (!st.ok) return st;
    ed.blurHandler(); // 重い処理の最中にフォーカスを失っても、もう取りこぼさない
    ed.endBusy();
    await undo(ed);
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], pre[id])) return ng(`★Ctrl+Z で ${id} が戻らない`);
  }
  // (c) 最後の網: 知られていない経路で束が残っても（busyKind を直に立ててフォーカスを失う）、次に触れた時点で確定し、
  //     次のストロークを乗っ取らせない
  {
    const p = build(T, 2, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    const pre0 = snap(p, 0);
    beginAllLayerStroke(ed);
    ed.busyKind = "heavy"; // beginBusy を通らない経路の見立て
    ed.blurHandler();
    ed.busyKind = "";
    if (ed.pointerDown || !ed.eraseAllStroke) return ng("前提: 束が取りこぼされていない（検査が黙る）");
    const mid0 = snap(p, 0);
    setAll(ed, false);
    ed.frameIndex = 1;
    const pre1 = snap(p, 1);
    stroke(ed, [
      [40, 200],
      [200, 200],
    ]);
    for (const id of ["A", "B", "C"])
      if (!same(p.frames[0].layers[id], mid0[id])) return ng(`★次のストロークが古い束（コマ 0 の ${id}）へ描いた`);
    if (!same(p.frames[1].layers.A, pre1.A) || !same(p.frames[1].layers.C, pre1.C))
      return ng("★オフのストロークがいまのレイヤー以外を消した");
    const erased = count(zeroMask(p.frames[1].layers.B, pre1.B));
    if (erased < 100) return ng(`★オフのストロークがいまのレイヤーを最後までなぞっていない（${erased} 画素）`);
    if (ed.history.undoDepth !== 2) return ng(`★履歴が ${ed.history.undoDepth}（取りこぼした束＋いまのストローク＝2 のはず）`);
    await undo(ed);
    await undo(ed);
    for (const id of ["A", "B", "C"]) {
      if (!same(p.frames[0].layers[id], pre0[id])) return ng(`★Ctrl+Z 2 回でコマ 0 の ${id} が戻らない`);
      if (!same(p.frames[1].layers[id], pre1[id])) return ng(`★Ctrl+Z 2 回でコマ 1 の ${id} が戻らない`);
    }
    if (ed.eraseAllStroke) return ng("★束が残っている");
  }
  // (d) 取りこぼしたまま別の作品を開いたら、古い作品の束は積まない（新しい作品の履歴を汚さない）
  {
    const p = build(T, 2, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    beginAllLayerStroke(ed);
    ed.busyKind = "heavy";
    ed.blurHandler();
    ed.busyKind = "";
    const q = build(T, 2, ABC);
    ed.project = q; // 別の作品（mount は Node で動かせないので差し替えで表す）
    ed.frameIndex = 0;
    ed.history.clear();
    stroke(ed, PATH2);
    if (ed.history.undoDepth !== 1) return ng(`★別の作品の履歴に、古い作品の束が積まれた（履歴 ${ed.history.undoDepth}）`);
  }
  // (f) ★描きながら Ctrl+Z（重くないコマンド・本物の入口 runCommand("edit.undo")）: いま消した分がまず確定され、
  //     **それが**取り消される。前の操作は巻き戻らない（入口で畳まないと、前の操作のほうが巻き戻り、
  //     あとで消しゴムを取り消すと、巻き戻したはずのものが戻ってくる）
  {
    const p = build(T, 1, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    stroke(ed, PATH2); // 前の操作（オフの消しゴムで B を消す）
    if (ed.history.undoDepth !== 1) return ng("前提: 前の操作が積まれていない");
    const afterPrev = snap(p, 0);
    beginAllLayerStroke(ed);
    ed.runCommand("edit.undo");
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    for (const id of ["A", "B", "C"])
      if (!same(p.frames[0].layers[id], afterPrev[id])) return ng(`★描きながらの Ctrl+Z で、いまの束ではなく前の操作が巻き戻った（${id}）`);
    if (ed.history.undoDepth !== 1 || !ed.history.canRedo) return ng(`★描きながらの Ctrl+Z のあとの履歴がおかしい（${ed.history.undoDepth}）`);
    if (ed.pointerDown || ed.eraseAllStroke) return ng("★Ctrl+Z のあとも描きかけが残っている");
  }
  // (g) ★↶ ボタン（runCommand を通らない・フォーカスのあるボタンをキーで押しても来る）: handleUndo を直に呼ぶ。
  //     いまの束が先に確定され、**それが**取り消される（Codex 3 回目・高）
  {
    const p = build(T, 1, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    stroke(ed, PATH2); // 前の操作
    const afterPrev = snap(p, 0);
    beginAllLayerStroke(ed);
    ed.handleUndo();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    for (const id of ["A", "B", "C"])
      if (!same(p.frames[0].layers[id], afterPrev[id])) return ng(`★↶ ボタンで、いまの束ではなく前の操作が巻き戻った（${id}）`);
    if (ed.history.undoDepth !== 1 || !ed.history.canRedo) return ng(`★↶ ボタンのあとの履歴がおかしい（${ed.history.undoDepth}）`);
    const st = endedLikePointerUp(ed, "↶ ボタンのあと");
    if (!st.ok) return st;
    // ↷ ボタンも同じ入口の形（描きかけの束を先に確定＝新しい操作が積まれるので、やり直しは空になる）
    beginAllLayerStroke(ed);
    const mid = snap(p, 0);
    ed.handleRedo();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], mid[id])) return ng(`★↷ ボタンで絵が変わった（${id}）`);
    if (ed.history.canRedo) return ng("★↷ の前に束を確定していない（やり直しが残っている）");
    const st2 = endedLikePointerUp(ed, "↷ ボタンのあと");
    if (!st2.ok) return st2;
  }
  // (h) ★もう 1 本のポインタで UI を押す（エディタ画面の capture 段階の漏斗 uiPointerHandler・どのボタンより先）
  {
    const p = build(T, 1, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    const pre = snap(p, 0);
    beginAllLayerStroke(ed);
    ed.uiPointerHandler();
    if (ed.history.undoDepth !== 1) return ng(`★UI を押した時点で束を確定していない（履歴 ${ed.history.undoDepth}）`);
    const st = endedLikePointerUp(ed, "UI を押したあと");
    if (!st.ok) return st;
    await undo(ed);
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], pre[id])) return ng(`★Ctrl+Z で ${id} が戻らない`);
  }
  // (i) ★ショートカットの表を通らない固定のキー（選択があるときの Backspace＝選択消去）。キーの入口で束を**先に**
  //     確定する＝消しゴム → 選択消去の順に積まれ、Ctrl+Z 2 回で元の絵。やり直しで消しゴムの分に選択消去の分が混ざらない
  {
    const p = build(T, 1, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    ed.redrawOverlay = () => {}; // 選択の枠の描き直し（DOM）だけ差し替える
    ed.selMask = rectMask(30, 40, 140, 90); // なぞる道（40,60）→（120,60）を含む
    const pre = snap(p, 0);
    beginAllLayerStroke(ed);
    const mid = snap(p, 0);
    ed.keydownHandler(key("Backspace", "Backspace"));
    if (same(p.frames[0].layers.B, mid.B)) return ng("前提: Backspace で選択部分が消えていない（検査が黙る）");
    if (ed.history.undoDepth !== 2) return ng(`★キーの時点で束を確定していない（履歴 ${ed.history.undoDepth}・消しゴム→選択消去の 2 のはず）`);
    const st = endedLikePointerUp(ed, "Backspace のあと");
    if (!st.ok) return st;
    await undo(ed); // 選択消去を戻す
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], mid[id])) return ng(`★選択消去を戻したら、消しゴムの途中の絵（${id}）に戻らない`);
    await undo(ed); // 消しゴムを戻す
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], pre[id])) return ng(`★Ctrl+Z 2 回で ${id} が元の絵に戻らない`);
    await redo(ed); // 消しゴムだけやり直す
    for (const id of ["A", "B", "C"])
      if (!same(p.frames[0].layers[id], mid[id])) return ng(`★やり直しで、消しゴムの分に選択消去の分が混ざった（${id}・束をキーの入口で確定していない）`);
  }
  // (j) 描きながら押さえて使うキー（Shift・Ctrl・Alt・Space）と、押しっぱなしのくり返しでは終えない。ふつうのキーは終える
  {
    const p = build(T, 1, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    beginAllLayerStroke(ed);
    const held: [string, Mod][] = [
      ["Shift", key("Shift", "ShiftLeft", { shiftKey: true })],
      ["Ctrl", key("Control", "ControlLeft", { ctrlKey: true })],
      ["Alt", key("Alt", "AltLeft", { altKey: true })],
      ["Space", key(" ", "Space")],
      ["押しっぱなしのくり返し（Q）", key("q", "KeyQ", { repeat: true })],
    ];
    for (const [label, k] of held) {
      ed.keydownHandler(k);
      if (!ed.eraseAllStroke || !ed.pointerDown) return ng(`★${label} で描きかけが終わった（描きながら押さえて使うキー・くり返しでは終えない）`);
    }
    // 文字入力欄への入力・IME の変換中はエディタの操作ではない（onKeyDown の関所で抜ける）＝終えない（Codex 4 回目）
    const notEditor: [string, Mod][] = [
      ["文字入力欄への入力", key("a", "KeyA", { target: { tagName: "INPUT" } })],
      ["IME の変換中", key("Process", "KeyA", { isComposing: true, keyCode: 229 })],
    ];
    for (const [label, k] of notEditor) {
      ed.keydownHandler(k);
      if (!ed.eraseAllStroke || !ed.pointerDown) return ng(`★${label}で描きかけが終わった（エディタの操作ではないキー）`);
    }
    ed.keydownHandler(key("q", "KeyQ"));
    const st = endedLikePointerUp(ed, "ふつうのキー（割り当ての無い Q）のあと");
    if (!st.ok) return st;
    if (ed.history.undoDepth !== 1) return ng(`★ふつうのキーで束を確定していない（履歴 ${ed.history.undoDepth}）`);
    // ★Enter（フォーカスのあるボタンを押す＝ブラウザ既定の click がこのあとに来る）・Esc でも終える（Codex 4 回目の穴）
    const focusedButton = { tagName: "BUTTON", closest: () => ({}) };
    for (const [label, k] of [
      ["Enter（フォーカスのあるボタン）", key("Enter", "Enter", { target: focusedButton })],
      ["Esc", key("Escape", "Escape")],
    ] as [string, Mod][]) {
      const q = build(T, 1, ABC);
      const { ed: e2 } = makeEd(T, q, { active: "B" });
      e2.redrawOverlay = () => {}; // Esc は選択の枠を描き直す（DOM）
      beginAllLayerStroke(e2);
      e2.keydownHandler(k);
      const st2 = endedLikePointerUp(e2, `${label}のあと`);
      if (!st2.ok) return st2;
      if (e2.history.undoDepth !== 1) return ng(`★${label}で束を確定していない（履歴 ${e2.history.undoDepth}）`);
    }
  }
  // (k) ★最後の網（EditorHistory）: 入口を通らない経路（知られていない経路・これから足す機能）が描きかけの最中に
  //     履歴を積んでも、束が**先に**積まれる＝Ctrl+Z を続ければ元の絵に戻る。ここでは選択消去を**直に**呼ぶ
  {
    const p = build(T, 1, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    ed.redrawOverlay = () => {};
    ed.selMask = rectMask(30, 40, 140, 90);
    const pre = snap(p, 0);
    beginAllLayerStroke(ed);
    ed.deleteSelection(); // 入口（キー・コマンド・ボタン）を通らずに直に
    if (ed.history.undoDepth !== 2) return ng(`★入口を通らない操作の履歴より先に束が積まれていない（履歴 ${ed.history.undoDepth}）`);
    const st = endedLikePointerUp(ed, "入口を通らない操作のあと");
    if (!st.ok) return st;
    await undo(ed);
    await undo(ed);
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], pre[id])) return ng(`★Ctrl+Z 2 回で ${id} が元の絵に戻らない`);
  }
  // (l) 網: 入口を通らずに**なぞっているコマを作品から外して**積む操作（コマの削除の見立て）でも、束が先に積まれる。
  //     Ctrl+Z でコマが戻り、もう 1 回で元の絵に戻る（外れたコマでも、同じ作品なら束は積む）
  {
    const p = build(T, 2, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    const f0 = p.frames[0];
    const pre = snap(p, 0);
    beginAllLayerStroke(ed);
    p.frames.splice(0, 1);
    ed.history.push({
      label: "外でコマを外す",
      undo() {
        p.frames.splice(0, 0, f0);
      },
      redo() {
        p.frames.splice(0, 1);
      },
    });
    if (ed.history.undoDepth !== 2) return ng(`★コマを外す操作より先に束が積まれていない（履歴 ${ed.history.undoDepth}）`);
    await undo(ed);
    await undo(ed);
    if (p.frames[0] !== f0) return ng("前提: Ctrl+Z でコマが戻らない");
    for (const id of ["A", "B", "C"]) if (!same(f0.layers[id], pre[id])) return ng(`★Ctrl+Z 2 回で、外したコマの ${id} が元の絵に戻らない`);
  }
  // (e) ショートカットを押したら、そこでストロークは終わる（太さを変えるだけのコマンドでも）。消した分は Ctrl+Z 1 回で戻る
  {
    const p = build(T, 1, ABC);
    const { ed } = makeEd(T, p, { active: "B" });
    const pre = snap(p, 0);
    beginAllLayerStroke(ed);
    const mid = snap(p, 0);
    ed.runCommand("pen.sizeUp");
    if (ed.history.undoDepth !== 1) return ng("★ショートカットの時点で束を確定して終えていない");
    const st = endedLikePointerUp(ed, "ショートカットのあと");
    if (!st.ok) return st;
    ed.onPointerMove(ev(260, 180));
    ed.onPointerUp(ev(260, 180, { buttons: 0 }));
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], mid[id])) return ng(`★ショートカットのあとのなぞりで ${id} が変わった`);
    await undo(ed);
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], pre[id])) return ng(`★Ctrl+Z で ${id} が戻らない`);
  }
  return ok();
}

// ================= [S-13] いまのレイヤーが 🔒 =================
async function checkS13(T: Tree): Promise<V> {
  const p = build(T, 1, [
    { id: "A", fill: 1 },
    { id: "B", fill: 2, locked: true },
    { id: "C", fill: 3 },
  ]);
  const lockT = T.t("ed.layer.locked.toast");
  // オフ: 従来どおりロックで止まる（知らせ・絵は変わらない）
  {
    const { ed, log } = makeEd(T, p, { active: "B" });
    const pre = snap(p, 0);
    stroke(ed, PATH);
    if (!log.toasts.includes(lockT)) return ng("★オフのとき、ロック中のレイヤーの知らせが出ない（従来と違う）");
    for (const id of ["A", "B", "C"]) if (!same(p.frames[0].layers[id], pre[id])) return ng(`★オフのとき ${id} が変わった`);
  }
  const { ed, log } = makeEd(T, p, { active: "B" });
  setAll(ed, true);
  const pre = snap(p, 0);
  stroke(ed, PATH);
  if (same(p.frames[0].layers.A, pre.A) || same(p.frames[0].layers.C, pre.C))
    return ng("★いまのレイヤーが 🔒 だと、ほかの見えているレイヤーまで消えない");
  if (!same(p.frames[0].layers.B, pre.B)) return ng("★🔒 のレイヤーが消えた");
  if (log.toasts.includes(lockT)) return ng("★ロックの知らせで止めている（対象の束で決めるはず）");
  return ok();
}

// ================= [S-14] なぞっている途中で道具が変わる =================
async function checkS14(T: Tree): Promise<V> {
  for (const next of ["pen", "fill"]) {
    // 元の絵は塗りの色（黒＝索引 1）とは別の色にしておく（塗られたら必ず違う値になる）
    const p = build(T, 1, [
      { id: "A", fill: 3 },
      { id: "B", fill: 4 },
    ]);
    const { ed } = makeEd(T, p, { active: "B" });
    setAll(ed, true);
    const pre = snap(p, 0);
    const d0 = ed.history.undoDepth;
    ed.onPointerDown(ev(40, 60));
    for (const [x, y] of [
      [60, 70],
      [80, 80],
    ] as Pt[])
      ed.onPointerMove(ev(x, y));
    // 描いている途中でショートカットが道具を変えた（setTool と同じ状態にする）
    ed.tool = next;
    ed.strokeTone = null;
    for (const [x, y] of [
      [120, 160],
      [200, 200],
      [260, 220],
    ] as Pt[])
      ed.onPointerMove(ev(x, y));
    ed.onPointerUp(ev(260, 220, { buttons: 0 }));
    for (const id of ["A", "B"]) {
      const b = p.frames[0].layers[id] as Buf;
      // 消しゴムが作れるのは 0 だけ。元の値でも 0 でもない値になった画素＝何かの色で塗られた
      for (let i = 0; i < b.length; i++)
        if (b[i] !== pre[id][i] && b[i] !== 0)
          return ng(`★${next}: 道具が変わったあと、束に色が塗られた（${id}・索引 ${b[i]}）`);
      if (same(b, pre[id])) return ng(`★${next}: 道具が変わる前に消した分が ${id} に残っていない`);
    }
    if (ed.history.undoDepth !== d0 + 1)
      return ng(`★${next}: 途中で道具が変わったストロークの履歴が ${ed.history.undoDepth - d0}（1 のはず）`);
    await undo(ed);
    for (const id of ["A", "B"]) if (!same(p.frames[0].layers[id], pre[id])) return ng(`★${next}: Ctrl+Z で ${id} が戻らない`);
  }
  return ok();
}

// ================= 走らせる =================
interface Named {
  id: string;
  name: string;
  run: (T: Tree) => Promise<V>;
}
const CHECKS: Named[] = [
  { id: "S-2", name: "対象＝実効の 👁 かつ実効の 🔒 でない（親・祖父フォルダ・opacity・clip・壊れた親・眠り）", run: checkS2 },
  { id: "S-3", name: "★ひとなぞり＝履歴 1 つ・undo で全部戻る・redo でまた消える", run: checkS3 },
  { id: "S-3b", name: "★コマを移ってから Ctrl+Z しても、なぞったコマへ戻る", run: checkS3b },
  { id: "S-3c", name: "★眠ったコマでも Ctrl+Z / Ctrl+Y が空振りしない", run: checkS3c },
  { id: "S-4", name: "★かすり消し（ベタ以外・マイ柄・コマでずらす）とタップの消え方が 3 枚とも 1 枚の消しゴムと一致", run: checkS4a },
  { id: "S-4b", name: "★点線で消すと仮定しても 3 枚の穴の位置が一致（dashAcc はレイヤーごと）", run: checkS4b },
  { id: "S-4c", name: "いまの消しゴムは texture=solid・色 0（位相を消費しない）", run: checkS4c },
  { id: "S-6", name: "1 画素も変わらなかったレイヤーは履歴に入らない", run: checkS6 },
  { id: "S-7", name: "★📌 は全コマで同じ実体・全コマから消える・フィルムを全部塗り直す・知らせは作品ごとに 1 回", run: checkS7 },
  { id: "S-8", name: "選択範囲が全対象に同じように効く", run: checkS8 },
  { id: "S-9", name: "対象 0 枚は 1 画素も変わらず履歴も増えない・知らせ 1 回・描き始めない", run: checkS9 },
  { id: "S-10", name: "★カーソルの二重線（全レイヤーのときだけ・太さの輪はそのまま・太らせた外周）", run: checkS10 },
  { id: "S-11", name: "★「全レイヤー」は覚えない（既定オフ・設定に書く口を呼ばない）", run: checkS11 },
  { id: "S-12", name: "★眠っている対象があるストロークは描かない（半分だけ消さない）・オンにした時点で窓を起こす", run: checkS12 },
  { id: "S-13", name: "★いまのレイヤーが 🔒 でも、ほかの見えているレイヤーは消える（オフは従来どおり）", run: checkS13 },
  { id: "S-14", name: "★途中で道具が変わっても束をペンの色で塗らない・消した分は確定する", run: checkS14 },
  { id: "S-15", name: "★束は作品に別の変更が入る前（キー・コマンド・重い処理・↶↷・UI を押した時点・ほかの履歴を積む直前）に確定して終え、pointerup と同じ状態に戻る・残った束は次に触れた時点で確定し乗っ取らない", run: checkS15 },
];
const byId = (id: string) => CHECKS.find((c) => c.id === id)!;

const REAL = await loadTree(root, "本物");

// [S-1]
{
  const actual = fs.existsSync(path.join(root, "src/editor/raster.ts"))
    ? crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "src/editor/raster.ts"))).digest("hex")
    : "";
  const v = checkS1(actual);
  check("[S-1] ★src/editor/raster.ts が V174 時点から 1 バイトも変わっていない", v.ok, v.why);
}

// [S-2]〜[S-14]（[S-5] を除く）
for (const c of CHECKS) {
  const v = await safe(() => c.run(REAL));
  check(`[${c.id}] ${c.name}`, v.ok, v.why);
}

// [S-5]
{
  const cur = await safe(async () => {
    const rows = await scenarioS5(REAL);
    return { ok: true, why: rows };
  });
  const curRows = cur.ok ? cur.why : "";
  const curSha = crypto.createHash("sha256").update(curRows).digest("hex");
  check("[S-5] 筋書きが最後まで走った", cur.ok, cur.why);
  check(
    "[S-5] ★オフのときの出力が、この回の前の editor.ts で測った固定値とビット単位で同じ",
    cur.ok && curSha === GOLDEN_S5,
    `いま ${curSha} ／ 固定値 ${GOLDEN_S5 || "（未設定）"}`
  );
  // 生きた旧版（このリポジトリに blob があるときだけ。公開リポジトリの clone には無い）
  let haveOld = false;
  try {
    execFileSync("git", ["cat-file", "-e", OLD_EDITOR_BLOB], { cwd: root, stdio: "ignore" });
    haveOld = true;
  } catch {
    haveOld = false;
  }
  if (!haveOld) {
    console.log(`SKIP [S-5r] この回の前の editor.ts（blob ${OLD_EDITOR_BLOB.slice(0, 12)}…）がこの clone に無い＝固定値との照合だけ`);
  } else {
    const dir = path.join(WORK, "old");
    copySrc(dir);
    fs.writeFileSync(
      path.join(dir, "src/editor/editor.ts"),
      execFileSync("git", ["cat-file", "blob", OLD_EDITOR_BLOB], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    );
    const old = await safe(async () => ({ ok: true, why: await scenarioS5(await loadTree(dir, "旧版")) }));
    const oldSha = crypto.createHash("sha256").update(old.ok ? old.why : "").digest("hex");
    check("[S-5r] 取り出した旧版で筋書きが最後まで走った", old.ok, old.why);
    check(
      "[S-5r] ★固定値は、取り出した旧版（この回の前の editor.ts）そのものの出力",
      old.ok && oldSha === GOLDEN_S5,
      `旧版 ${oldSha.slice(0, 16)}… ／ 固定値 ${GOLDEN_S5.slice(0, 16) || "（未設定）"}…`
    );
    if (old.ok && cur.ok && old.why !== curRows) {
      const a = old.why.split("\n");
      const b = curRows.split("\n");
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) console.log(`    旧 ${a[i]}\n    今 ${b[i]}`);
    }
    check("[S-5r] ★いまの editor.ts の出力が旧版と 1 行も違わない", old.ok && cur.ok && old.why === curRows);
  }
}

// [S-0] 無改変の写し
{
  const { tree, why } = await mutant([]);
  if (!tree) check("[S-0] 無改変の写しを読み込めた", false, why);
  else {
    const bad: string[] = [];
    for (const c of CHECKS) {
      const v = await safe(() => c.run(tree));
      if (!v.ok) bad.push(`${c.id}: ${v.why}`);
    }
    check("[S-0] 無改変の写しでは全部緑（写しの仕組みが赤を作っていない）", bad.length === 0, bad.slice(0, 3).join(" ／ "));
  }
}

// ================= [S-R] 反証（わざと壊した写し） =================
const ED = "src/editor/editor.ts";
const LTF = "src/editor/layerTree.ts";
interface Mut {
  id: string;
  what: string;
  target: string;
  edits: Edit[];
}
const MUTS: Mut[] = [
  {
    id: "2z",
    what: "対象の決め方で effectiveLayerStates を通さず、レイヤー定義の 👁 / 🔒 を直接読む",
    target: "S-2",
    edits: [{ file: LTF, from: "const e = eff.get(ld.id);", to: "const e = { visible: ld.visible, locked: ld.locked === true };" }],
  },
  {
    id: "3z",
    what: "レイヤーごとに bufferChangeEntry を積む",
    target: "S-3",
    edits: [
      {
        file: ED,
        from: "this.history.push(entry);",
        to: 'for (const id of Object.keys(afterDiff)) this.history.push(bufferChangeEntry("消しゴム（全レイヤー）", () => frame.layers[id] ?? null, beforeDiff[id], afterDiff[id], onApply));',
      },
    ],
  },
  {
    id: "3z'",
    what: "戻し先を「いま表示中のコマ」で解決する（歪みの確定の形）",
    target: "S-3b",
    edits: [
      {
        file: ED,
        from: '"消しゴム（全レイヤー）",\n      (id) => frame.layers[id] ?? null,',
        to: '"消しゴム（全レイヤー）",\n      (id) => this.project.frames[this.frameIndex]?.layers[id] ?? null,',
      },
    ],
  },
  {
    id: "3z''",
    what: "取り消しの前にコマを起こさない（prepare を外す）",
    target: "S-3c",
    edits: [{ file: ED, from: 'entry.prepare = () => wakeFrame(self.project, frame, "write");', to: "" }],
  },
  {
    id: "4z",
    what: "★dashAcc を 1 つ共有する（要件 §3-2 の落とし穴）",
    target: "S-4b",
    edits: [{ file: ED, from: "o.dashAcc = st.dash[id];", to: "o.dashAcc = this.dashAcc;" }],
  },
  {
    id: "4z'",
    what: "押した瞬間の打点を最初の対象にだけ打つ",
    target: "S-4",
    edits: [{ file: ED, from: "R.stamp(buf, x, y, o);", to: "if (id === st.ids[0]) R.stamp(buf, x, y, o);" }],
  },
  {
    id: "5z",
    what: "分岐を取り違えて、消しゴムは常に全レイヤーになる",
    target: "S-5",
    edits: [{ file: ED, from: 'return this.tool === "eraser" && this.eraseAllLayers;', to: 'return this.tool === "eraser";' }],
  },
  {
    id: "6z",
    what: "変わらなかったレイヤーも無条件に積む",
    target: "S-6",
    edits: [{ file: ED, from: "if (!differs) continue;", to: "" }],
  },
  {
    id: "7z",
    what: "📌 をコマごとに写してから消す",
    target: "S-7",
    edits: [
      {
        file: ED,
        from: "st.before[id] = copyIndexBuf(frame.layers[id]);",
        to: "frame.layers[id] = copyIndexBuf(frame.layers[id]);\n      st.before[id] = copyIndexBuf(frame.layers[id]);",
      },
    ],
  },
  {
    id: "7z'",
    what: "📌 を消してもフィルムを全部は塗り直さない",
    target: "S-7",
    edits: [{ file: ED, from: "if (pinned) self.rebuildFilm();", to: "if (false) self.rebuildFilm();" }],
  },
  {
    id: "8z",
    what: "選択範囲を最初の対象にだけ効かせる",
    target: "S-8",
    edits: [
      {
        file: ED,
        from: "R.strokeSegment(buf, x0, y0, x1, y1, o);",
        to: "R.strokeSegment(buf, x0, y0, x1, y1, o);\n      o.clip = undefined;",
      },
    ],
  },
  {
    id: "9z",
    what: "対象 0 枚のとき素通しにする（1 枚の消しゴムの道へ落ちる）",
    target: "S-9",
    edits: [
      {
        file: ED,
        from: 'if (ids.length === 0) {\n      this.eraseAllToast("none");',
        to: 'if (false) {\n      this.eraseAllToast("none");',
      },
      {
        file: ED,
        from: "const buf2 = multi ? null : this.activeBuffer();",
        to: "const buf2 = multi && all && all.ids.length > 0 ? null : this.activeBuffer();",
      },
    ],
  },
  {
    id: "10z",
    what: "カーソルを二重にしない",
    target: "S-10",
    edits: [{ file: ED, from: "const dbl = ring && this.eraseAllOn();", to: "const dbl = false;" }],
  },
  {
    id: "11z",
    what: "「全レイヤー」を設定に覚えさせる",
    target: "S-11",
    edits: [
      {
        file: ED,
        from: "this.eraseAllLayers = on;",
        to: "this.eraseAllLayers = on;\n    this.cb.onEraseAllLayersChange?.(on);",
      },
    ],
  },
  {
    id: "12z",
    what: "眠っている対象を見ないで描き始める",
    target: "S-12",
    edits: [{ file: ED, from: "if (asleep.length > 0) {", to: "if (false) {" }],
  },
  {
    id: "13z",
    what: "全レイヤーでも、いまのレイヤーのロックで止める",
    target: "S-13",
    edits: [{ file: ED, from: "(this.eraseAllOn() ? this.eraseAllGuard() : this.lockGuard())", to: "this.lockGuard()" }],
  },
  {
    id: "7z''",
    what: "📌 の知らせを作品ごとではなく Editor で 1 回にする（別の作品で出し直さない）",
    target: "S-7",
    edits: [
      { file: ED, from: "!this.eraseAllPinNoticed.has(this.project)", to: "!this.eraseAllPinNoticed.has(Editor as unknown as Project)" },
      { file: ED, from: "this.eraseAllPinNoticed.add(this.project);", to: "this.eraseAllPinNoticed.add(Editor as unknown as Project);" },
    ],
  },
  {
    id: "12z'",
    what: "オンにした時点の先回り（眠っている窓を起こす）を外す（Codex 指摘の穴）",
    target: "S-12",
    edits: [{ file: ED, from: "if (on && this.sleepOn && !this.frameReady()) this.renderCanvas();", to: "" }],
  },
  {
    id: "15z",
    what: "次に触れた時点で取りこぼした束を確定しない",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "if (this.eraseAllStroke) this.commitEraseAll(); // 取りこぼした束を先に確定（次の 1 枚の経路を乗っ取らせない）",
        to: "",
      },
    ],
  },
  {
    id: "15z'",
    what: "★コマンドの入口で束を確定しない（Codex 2 回目・高: 描きながらコマを消すと Ctrl+Z で戻らない）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "    if (this.eraseAllStroke) this.finishEraseAllNow();\n    switch (id) {",
        to: "    switch (id) {",
      },
    ],
  },
  {
    id: "15z'''",
    what: "重い処理の入口で束を確定しない",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "    if (this.eraseAllStroke) this.finishEraseAllNow();\n    this.busyKind = kind;",
        to: "    this.busyKind = kind;",
      },
    ],
  },
  {
    id: "15z4",
    what: "★↶↷ の入口で束を確定しない（ボタンは runCommand を通らない・Codex 3 回目・高）",
    target: "S-15",
    edits: [
      {
        file: ED,
        // V180 (A-78 [D]): ↶ の入口は取り消しを列に並べる形（queueHistory）になった。反証の中身は同じ
        //（取り消しの前の「束を確定して終える」1 行を外す）
        from: '    if (this.eraseAllStroke) this.finishEraseAllNow();\n    this.queueHistory("undo");',
        to: '    this.queueHistory("undo");',
      },
    ],
  },
  {
    id: "15z5",
    what: "UI を押した時点（capture の漏斗）で束を確定しない",
    target: "S-15",
    edits: [{ file: ED, from: "    if (this.mounted && this.eraseAllStroke) this.finishEraseAllNow();", to: "" }],
  },
  {
    id: "15z6",
    what: "束を終えるときにポインタの捕捉を放さない（Codex 3 回目の穴）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "      this.strokeTone = null;\n      this.releaseCapture();\n    }",
        to: "      this.strokeTone = null;\n    }",
      },
    ],
  },
  {
    id: "15z7",
    what: "束を終えるときに途切れたときの終端の控えを消さない（Codex 3 回目の穴）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "      this.pointerDown = false;\n      this.lastPointerEvent = null;\n      this.strokeTone = null;",
        to: "      this.pointerDown = false;\n      this.strokeTone = null;",
      },
    ],
  },
  {
    id: "15z8",
    what: "束を終えるときに解決済みトーンを捨てない（pointerup と同じ後始末になっていない）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "      this.lastPointerEvent = null;\n      this.strokeTone = null;\n      this.releaseCapture();",
        to: "      this.lastPointerEvent = null;\n      this.releaseCapture();",
      },
    ],
  },
  {
    id: "7z'''",
    what: "📌 の知らせの記録を WeakSet ではなく Set にする（閉じた作品を抱え込む・Codex 2 回目の穴）",
    target: "S-7",
    edits: [{ file: ED, from: "private eraseAllPinNoticed = new WeakSet<Project>();", to: "private eraseAllPinNoticed = new Set<Project>();" }],
  },
  {
    id: "15z''",
    what: "作品が替わっていても積む",
    target: "S-15",
    edits: [{ file: ED, from: "    if (st.project !== this.project) return;", to: "" }],
  },
  {
    id: "15z9",
    what: "★キーの入口で束を確定しない（ショートカットの表を通らない Backspace の選択消去が束より先に走る）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "    if (this.eraseAllStroke && !e.repeat && !Editor.HELD_WHILE_DRAWING.has(e.key)) this.finishEraseAllNow();\n",
        to: "",
      },
    ],
  },
  {
    id: "15z10",
    what: "押しっぱなしのくり返しでも束を終える（キーを押さえたまま描けなくなる）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "if (this.eraseAllStroke && !e.repeat && !Editor.HELD_WHILE_DRAWING.has(e.key))",
        to: "if (this.eraseAllStroke && !Editor.HELD_WHILE_DRAWING.has(e.key))",
      },
    ],
  },
  {
    id: "15z11",
    what: "修飾キー・Space でも束を終える（Shift の拘束・Space の手のひらを押さえたまま描けなくなる）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "if (this.eraseAllStroke && !e.repeat && !Editor.HELD_WHILE_DRAWING.has(e.key))",
        to: "if (this.eraseAllStroke && !e.repeat)",
      },
    ],
  },
  {
    id: "15z14",
    what: "キーの入口を、ダイアログ・文字入力欄・IME の関所より前に置く（文字を打っただけでストロークが終わる・Codex 4 回目）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "    if (this.eraseAllStroke && !e.repeat && !Editor.HELD_WHILE_DRAWING.has(e.key)) this.finishEraseAllNow();\n",
        to: "",
      },
      {
        file: ED,
        from: "  private keydownHandler = (e: KeyboardEvent) => {\n",
        to: "  private keydownHandler = (e: KeyboardEvent) => {\n    if (this.eraseAllStroke && !e.repeat && !Editor.HELD_WHILE_DRAWING.has(e.key)) this.finishEraseAllNow();\n",
      },
    ],
  },
  {
    id: "15z15",
    what: "Enter も押さえて使うキーに入れる（フォーカスのあるボタンの click が束より先に走る・Codex 4 回目の穴）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: 'new Set(["Shift", "Control", "Alt", "Meta", " "])',
        to: 'new Set(["Shift", "Control", "Alt", "Meta", " ", "Enter"])',
      },
    ],
  },
  {
    id: "15z12",
    what: "★最後の網を外す（積む直前に束を確定しない）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "  history = new EditorHistory(() => {\n    if (this.eraseAllStroke) this.finishEraseAllNow();\n  });",
        to: "  history = new EditorHistory(() => {});",
      },
    ],
  },
  {
    id: "15z13",
    what: "なぞったコマが作品から外れていたら積まない（網の前で外した操作があると、元の絵に戻らない）",
    target: "S-15",
    edits: [
      {
        file: ED,
        from: "    if (st.project !== this.project) return;",
        to: "    if (st.project !== this.project || !this.project.frames.includes(st.frame)) return;",
      },
    ],
  },
  {
    id: "14z",
    what: "途中で道具が変わっても束に描き続ける",
    target: "S-14",
    edits: [{ file: ED, from: 'else if (all && this.tool === "eraser")', to: "else if (all)" }],
  },
];
check("[S-1] 反証 1z: raster.ts のハッシュが違う写しは [S-1] が赤", !checkS1("0".repeat(64)).ok);
for (const m of MUTS) {
  const { tree, why } = await mutant(m.edits);
  if (!tree) {
    check(`[S-R] 反証 ${m.id}: ${m.what} → [${m.target}] が赤`, false, why);
    continue;
  }
  let v: V;
  if (m.target === "S-5") {
    const r = await safe(async () => ({ ok: true, why: await scenarioS5(tree) }));
    const s = crypto.createHash("sha256").update(r.ok ? r.why : "").digest("hex");
    v = r.ok ? (s === GOLDEN_S5 ? ok() : ng("固定値と違う")) : r;
  } else v = await safe(() => byId(m.target).run(tree));
  check(
    `[S-R] 反証 ${m.id}: ${m.what} → [${m.target}] が赤`,
    !v.ok && !v.threw,
    v.ok ? "★壊した写しでも緑のまま（検査が効いていない）" : v.threw ? `例外で落ちた（効いたと数えない）: ${v.why}` : ""
  );
  // 赤になった理由も残す（「別の理由で赤」を見分けるため。報告書の証跡）
  if (!v.ok && !v.threw) console.log(`  反証 ${m.id} → [${m.target}] 赤: ${v.why}`);
  // ★参考（数えない）: 要件 §3-2 の落とし穴（dashAcc の共有）は、**いまの消しゴムでは画素に出ない**。
  //  消しゴムの penOptions は texture=solid で、strokeSegment が位相を使うのは texture=dot のときだけ
  //  （かすり消しの柄はキャンバス座標で決まる）。だから 4z は [S-4]（実際の設定）では緑のままで、
  //  守りの本体は点線で消すと仮定した [S-4b]。種類が増えて位相を使うようになったら、この行が「赤」に変わる
  if (m.id === "4z") {
    const r = await safe(() => checkS4a(tree));
    console.log(
      `  参考 4z → [S-4]（実際の消しゴム）は ${r.ok ? "緑のまま（いまの消しゴムは位相を使わない）" : `赤: ${r.why}`}`
    );
  }
}

console.log(`\nv178 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
