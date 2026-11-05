// V195（Discord のチケット 4 件: A-96・A-97・A-98＋A-98b・A-99）の回帰ゲート。引数不要:
//   npx tsx scripts/v195_smoke.ts            （--report で表を全部出す）
//
// 要件: docs/REQ_discord_tickets_1004.md §1〜§4 ／ 指示書: docs/handoff/SEND_TO_CODE_V195.html
//
// ★見方: **本物の editor.ts を Node で動かす**（V178・V191 の舞台＋偽の DOM）。ライブラリの再生（library.ts）は
//  構文木で本文を取り出して `new Function` で動かす（V181・V183 の作法）。判断の純関数（playStart.ts・stagePan.ts・
//  colorUsage.ts）は総当たりで見る。どの検査も**写しを壊すと赤になる**ことを [X] で確かめる（反証の表は報告書へ）。
//
// [A96-1] playStartFrame: ループなし・最後のコマ → 0／途中 → そのまま／ループあり → そのまま／1 コマ → 0
// [A96-2] 編集画面（本物の togglePlayback）: ループなしで最後まで再生して止まったあと ▶ → 先頭から（BGM 0 秒・先頭の SE）
//         ／途中からはそのコマから／ループありは最後のコマから
// [A96-3] ライブラリ .memoanima（本物の togglePreviewPlayback）: 最後のコマ・ループなし → previewFrame 0 で startPreview
// [A96-4] ライブラリ .kwz/.ppm（同じ入口・Player の偽物）: 最後のコマ・ループなし → setCurrentFrame(0) してから play()
// [A96-0] 赤先行: V195 の前（`73f8d7b`・V195 の親に固定）の editor.ts / library.ts では [A96-2]〜[A96-4] の「最後のコマ → 先頭」が赤
// [A97-1] 本物の gotoFrame: 再生中に呼ぶと再生が止まる（⏸ ではなく停止＝音は stop・続きは捨てる・タイマーも消える）
// [A97-2] 入口ぜんぶ: ⏮◀▶⏭（本物の buildTimeline のボタン）・タイムラインのコマ（本物の rebuildFilm・Shift＋クリックも）・
//         frame.prev/next・←→ キー で、再生が止まり、そのコマが出ている。先頭で ◀ でも止まる
// [A97-3] コマのドラッグ（並べ替え）を再生中に始めると止まる
// [A97-4] 入口は 1 か所: gotoFrame の最初の return より前に stopPlayback・呼び出し元の本文に stopPlayback が無い
// [A97-0] 赤先行: V195 の前（`73f8d7b`）の editor.ts では [A97-1] が赤
// [A98-1] stagePan を CSS の変形（rotate→scaleX の順・真ん中が中心）の独立した写像と総当たりで突き合わせる:
//         見た目の絵の矩形＝[L, L+vw]×[T, T+vh]／四隅が窓の真ん中まで来る・それより外へは行かない（±0.5px）／
//         visualToCanvas が CSS の逆写像と一致し、editor.ts の clientToPixelF とも一致／倍率を変えても真ん中の点が残る
// [A98-2] 本物の applyZoom / layoutPan（偽の DOM）: 全体表示は今の形（.pan なし・インラインなし）／拡大で余白・真ん中の点が
//         残る（倍率・回転・反転・窓の大きさ・大画面の行き来）／収まる倍率へ降りたら今の形／全体表示の回転は transform だけ
// [A98-4] ★V195b（作者決定「収まる大きさは元の形」）: 余白を付けるのは見た目の絵が窓（全体表示と同じ物差し
//         availW/H＝#ed-stage − 40）からはみ出すときだけ。panNeeded の総当たり／1600×1000 で 1〜4 倍は全体表示と同じ形・
//         5 倍で余白（絵の真ん中）・4 倍へ戻すと今の形／990×800 の 3 倍（物差しの −40 の境目）／1400×800 で 0° は収まり
//         90° ははみ出す（回転の受け口で入れ替わる）／大画面の間に収まる・はみ出すが入れ替わる
// [A98-3] CSS と index.html: #ed-cvpan が #ed-scroll の中・.pan の間だけ箱を出して絵を absolute に
// [A98b]  本物の applyHud: 隠すとボタン列に hud-collapsed・CSS は隠す／出すボタン以外を display:none・四隅変形の間に
//         隠す／出すをしても抜けたあとインラインが残らない・隠している間もキーで拡大・回転・反転が効く
// [A99-1] colorSlots / colorDeleteVerdict
// [A99-2] scanColorUse（純関数）: 起きているレイヤー・眠っている控え（起こさない・控えはそのまま）・紙・履歴の bufs/frames/papers・
//         網（申告なしで大きい）・NO_COLOR_REFS・コピー中の絵・16bit の番号
// [A99-3] 本物の Editor の deletePaletteColor: 使っていない色は消える（空き番号・取り消しで戻る・やり直しでまた消える）／
//         コマ・眠ったコマ・紙・描いて Ctrl+Z した絵・消したコマ・消したレイヤー・紙色の取り消し・コピー中の絵 → 消さない（文は種類別）／
//         確認でキャンセル → 何も変わらない／透明は対象外／16bit の作品は 16bit のまま／消したあと同じ色は新しい番号で足される
// [A99-4] 消しても画素は 1 つも変わらない／保存（PV6）→ 読み込み（今の版・v1.9.0 の serialize.ts と pv6.ts）で
//         colorTable も全レイヤーの画素も合成した絵も同じ
// [A99-5] 履歴を積む所の棚卸し（構文木）: this.history.push の全 42 か所が colorRefs を申告している（または申告の入る工場で作る）
// [S-0]   無改変の写しでは [X] が使う検査が全部緑
// [X]     反証（写しを壊して赤を見る）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
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
async function safe(fn: () => Promise<V> | V): Promise<V> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, why: `例外: ${String((e as Error)?.stack ?? e).slice(0, 300)}`, threw: true };
  }
}
const root = path.resolve(import.meta.dirname, "..");
const REPORT = process.argv.includes("--report");
const log = (s: string) => console.log(s);

// ================= 偽の DOM（editor.ts を Node で動かす最小の舞台） =================
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
class FakeClassList {
  s = new Set<string>();
  add(...c: string[]) {
    for (const x of c) this.s.add(x);
  }
  remove(...c: string[]) {
    for (const x of c) this.s.delete(x);
  }
  toggle(c: string, force?: boolean) {
    const on = force === undefined ? !this.s.has(c) : force;
    if (on) this.s.add(c);
    else this.s.delete(c);
    return on;
  }
  contains(c: string) {
    return this.s.has(c);
  }
}
const fakeCtx = {
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  globalAlpha: 1,
  imageSmoothingEnabled: false,
  clearRect() {},
  fillRect() {},
  strokeRect() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  fill() {},
  arc() {},
  closePath() {},
  save() {},
  restore() {},
  setLineDash() {},
  translate() {},
  scale() {},
  rotate() {},
  drawImage() {},
  putImageData() {},
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  measureText: () => ({ width: 0 }),
};
class FakeEl {
  tag: string;
  id = "";
  classList = new FakeClassList();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  listeners: Record<string, ((e: Any) => void)[]> = {};
  onclick: ((e: Any) => void) | null = null;
  title = "";
  textContent = "";
  private _html = "";
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v: string) {
    this._html = v;
    this.children = []; // 本物と同じく中身を作り直す（"" で空にする）
  }
  hidden = false;
  disabled = false;
  value = "";
  checked = false;
  clientWidth = 0;
  clientHeight = 0;
  clientLeft = 0;
  clientTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 0;
  scrollHeight = 0;
  width = 0;
  height = 0;
  rect = { left: 0, top: 0, width: 0, height: 0 };
  constructor(tag: string) {
    this.tag = tag;
  }
  get className() {
    return [...this.classList.s].join(" ");
  }
  set className(v: string) {
    this.classList.s = new Set(v.split(/\s+/).filter(Boolean));
  }
  appendChild(c: FakeEl) {
    if (c && typeof c === "object") {
      c.parentElement = this;
      this.children.push(c);
    }
    return c;
  }
  append(...cs: FakeEl[]) {
    for (const c of cs) this.appendChild(c);
  }
  prepend(...cs: FakeEl[]) {
    for (const c of cs) this.appendChild(c);
  }
  insertBefore(c: FakeEl) {
    return this.appendChild(c);
  }
  replaceChildren(...cs: FakeEl[]) {
    this.children = [];
    for (const c of cs) this.appendChild(c);
  }
  removeChild(c: FakeEl) {
    this.children = this.children.filter((x) => x !== c);
    return c;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  hasAttribute(k: string) {
    return k in this.attrs;
  }
  addEventListener(t: string, f: (e: Any) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener(t: string, f: (e: Any) => void) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f);
  }
  dispatch(t: string, e: Any = {}) {
    for (const f of [...(this.listeners[t] ?? [])]) f(e);
  }
  click() {
    this.dispatch("click", { shiftKey: false, preventDefault() {}, stopPropagation() {} });
    this.onclick?.({ preventDefault() {}, stopPropagation() {} });
  }
  querySelector(): FakeEl | null {
    return null;
  }
  querySelectorAll(): FakeEl[] {
    return [];
  }
  closest() {
    return null;
  }
  contains() {
    return false;
  }
  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() {
    return false;
  }
  getBoundingClientRect() {
    const r = this.rect;
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  getContext() {
    return fakeCtx;
  }
  toBlob(cb: (b: null) => void) {
    cb(null);
  }
}
const reg = new Map<string, FakeEl>();
function el(sel: string): FakeEl {
  let e = reg.get(sel);
  if (!e) {
    e = new FakeEl(sel);
    if (sel.startsWith("#")) e.id = sel.slice(1);
    reg.set(sel, e);
  }
  return e;
}
const fakeDocument = {
  querySelector: (sel: string) => el(sel),
  querySelectorAll: (sel: string) => {
    if (sel === "#ed-film .fr") return el("#ed-film").children.filter((c) => c.classList.contains("fr"));
    return [];
  },
  getElementById: (id: string) => el("#" + id),
  createElement: (t: string) => new FakeEl(t),
  createElementNS: (_ns: string, t: string) => new FakeEl(t),
  createTextNode: (t: string) => ({ textContent: t }),
  body: new FakeEl("body"),
  documentElement: new FakeEl("html"),
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
  visibilityState: "visible",
  hidden: false,
  title: "",
};
const G = globalThis as unknown as Record<string, unknown>;
G.self = G;
G.window = G;
G.devicePixelRatio = 1;
G.document = fakeDocument;
G.addEventListener = () => {};
G.removeEventListener = () => {};
G.requestAnimationFrame = () => 0;
G.cancelAnimationFrame = () => {};
class NoopObs {
  observe() {}
  unobserve() {}
  disconnect() {}
}
G.ResizeObserver = NoopObs;
G.IntersectionObserver = NoopObs;
G.HTMLElement = FakeEl;
G.HTMLCanvasElement = FakeEl;
if (!G.localStorage) G.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// 再生のタイマーは手で回す（本物の setInterval だと勝手に進む・プロセスが終わらない）
const intervals = new Map<number, () => void>();
let nextIv = 1;
G.setInterval = (fn: () => void) => {
  const id = nextIv++;
  intervals.set(id, fn);
  return id;
};
G.clearInterval = (id: number) => {
  intervals.delete(id);
};
// ★V209 (A-121・R-5): 再生は経過時間からコマを決める形（playClock.ts の PlayClock・requestAnimationFrame）になった。
//  時計（performance.now()・音の時計・描く合図）を偽物にして、tickAll は「1 コマぶんの時間を進めて描く合図を回す」にする。
//  前の版の木（V195 の前・v1.9.0・写し）は今までどおり setInterval の拍を回す（両方を 1 回ずつ）
const clockNow = { ms: 1000 };
const rafQ: (() => void)[] = [];
let curFps = 8;
const fakeCtxV209 = { state: "running", currentTime: 0, baseLatency: 0, outputLatency: 0, destination: {} };
function tickAll() {
  for (const fn of [...intervals.values()]) fn();
  // 1 コマぶん（＋1 ms）進めて、描く合図を回す（音の時計も同じだけ進む）
  const d = 1000 / curFps + 1;
  clockNow.ms += d;
  fakeCtxV209.currentTime += d / 1000;
  for (const f of rafQ.splice(0)) f();
}
/** V209: 木の playClock.ts の時計を偽物に（その木に playClock.ts があるときだけ）。PlayClock.start を包んで始めた秒を記録する */
const wrappedPC = new WeakSet<object>();
let curAudioRec: Any[] | null = null;
function fakeClockFor(T: Tree) {
  const PC = T.PC;
  if (!PC?.playEnv) return;
  PC.playEnv.now = () => clockNow.ms;
  PC.playEnv.raf = (cb: () => void) => (rafQ.push(cb), rafQ.length);
  PC.playEnv.caf = () => {
    rafQ.length = 0;
  };
  PC.playEnv.ctx = () => fakeCtxV209;
  if (!wrappedPC.has(PC)) {
    wrappedPC.add(PC);
    const st0 = PC.PlayClock.prototype.start;
    PC.PlayClock.prototype.start = function (this: Any, o: Any) {
      // 前の版の start(bgm, offset) の記録と同じ形（BGM の頭出しの秒＝始めた位置）
      curAudioRec?.push(["start", o.t0]);
      return st0.call(this, o);
    };
  }
}
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ================= 木（今の src・写し・V195 の前・v1.9.0） =================
interface Tree {
  label: string;
  dir: string;
  Editor: Any;
  M: Any; // model
  H: Any; // history
  PS: Any; // playStart
  SP: Any; // stagePan
  CU: Any; // colorUsage
  S: Any; // serialize
  SL: Any; // sleep
  R: Any; // render
  I: Any; // i18n
  PC: Any; // V209: playClock（無い木は null）
  editorSrc: string;
  libSrc: string;
  css: string;
  html: string;
}
async function loadTree(dir: string, label: string, opts: { pure?: boolean } = {}): Promise<Tree> {
  const u = (p: string) => pathToFileURL(path.join(dir, p)).href;
  const has = (p: string) => fs.existsSync(path.join(dir, p));
  const imp = async (p: string) => (has(p) ? await import(u(p)) : null);
  const E = opts.pure ? null : await import(u("src/editor/editor.ts"));
  const rd = (p: string) => (has(p) ? fs.readFileSync(path.join(dir, p), "utf8") : "");
  return {
    label,
    dir,
    Editor: E?.Editor,
    M: await imp("src/editor/model.ts"),
    H: await imp("src/editor/history.ts"),
    PS: await imp("src/editor/playStart.ts"),
    SP: await imp("src/editor/stagePan.ts"),
    CU: await imp("src/editor/colorUsage.ts"),
    S: await imp("src/editor/serialize.ts"),
    SL: await imp("src/editor/sleep.ts"),
    R: await imp("src/editor/render.ts"),
    I: await imp("src/i18n/index.ts"),
    PC: await imp("src/editor/playClock.ts"), // V209 (A-121): 再生の時計（前の版の木には無い）
    // ★V213: 描く処理（gotoFrame・this.history.push の多く）はコア src/editor/core/editorCore.ts へ字を変えずに移った。
    //  editor.ts とコアの字を順に並べたものを読む（コアの無い前の木では editor.ts だけ＝数え方は同じ）
    editorSrc: readEditorSource(dir),
    libSrc: rd("src/library.ts"),
    css: rd("src/styles.css"),
    html: rd("index.html"),
  };
}
const WORK = path.join(process.env.V195_SMOKE_WORK || path.join(root, "node_modules", ".v195-smoke"), String(process.pid));
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
    filter: (s) => fs.statSync(s).isDirectory() || s.endsWith(".ts") || s.endsWith(".css"),
  });
  fs.copyFileSync(path.join(root, "index.html"), path.join(dest, "index.html"));
}
/** git の版 `rev` の src/ と index.html を書き出す */
function exportRev(rev: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(dest, "src.tar");
  execFileSync("git", ["-C", root, "archive", "--format=tar", "-o", tar, rev, "src", "index.html"]);
  // 相対パスで渡す（Git Bash の GNU tar は "C:" をホスト名と読む）
  execFileSync("tar", ["-xf", "src.tar"], { cwd: dest });
  fs.rmSync(tar);
}
interface Edit {
  file: string;
  from: string;
  to: string;
}
let mutSeq = 0;
const ED = "src/editor/editor.ts";
/** ★V213: editor.ts を的にした書き換えは、書き換える字のあるファイル（editor.ts かコア src/editor/core/editorCore.ts）へ当てる。
 *  描く処理はコアへ字を変えずに移った。どちらにも無い・両方にあるときは editor.ts のまま（＝当たらない数で赤） */
function editTarget(dir: string, e: Edit): string {
  if (e.file !== ED) return e.file;
  return editorFileHaving(dir, e.from) ?? e.file;
}
async function mutant(edits: Edit[]): Promise<{ tree: Tree | null; why: string }> {
  const dir = path.join(WORK, `m${++mutSeq}`);
  copySrc(dir);
  for (const e of edits) {
    const file = editTarget(dir, e);
    const f = path.join(dir, file);
    const text = fs.readFileSync(f, "utf8");
    const n = text.split(e.from).length - 1;
    if (n !== 1) return { tree: null, why: `書き換えが当たらない（${n} 箇所）: ${file}: ${e.from.trim().slice(0, 80)}` };
    fs.writeFileSync(f, text.replace(e.from, () => e.to));
  }
  return { tree: await loadTree(dir, `m${mutSeq}`), why: "" };
}

// ================= 構文木の道具 =================
function sf(src: string, name = "x.ts") {
  return ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true);
}
/** クラスのメソッド・関数宣言を名前で探して本文を返す */
function fnText(src: string, name: string): string | null {
  const s = sf(src);
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && n.name.getText(s) === name) {
      found = n.getText(s);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(s);
  return found;
}
function noComments(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

// ================= 道具 =================
const W = 320;
const H = 240;
const PIXELS = W * H;
const shaOf = (bs: ArrayBufferView[]) => {
  const h = crypto.createHash("sha256");
  for (const b of bs) h.update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  return h.digest("hex");
};
function fakeAudio(rec: Any[]) {
  return {
    start: async (_bgm: unknown, off: number) => void rec.push(["start", off]),
    stop: () => void rec.push(["stop"]),
    pause: () => void rec.push(["pause"]),
    stopSe: () => void rec.push(["stopSe"]),
    resumeSe: () => [],
    prepareSe: async () => {},
    fireSe: (t: { id: string }) => void rec.push(["fireSe", t.id]),
    restart: () => void rec.push(["restart"]),
    invalidate() {},
    // ★V209 (A-121): 新しい音の口（PlayClock が予約する）。SE の予約は前の fireSe と同じ記録にする（鳴らした SE の id）
    preparePlay: async () => ({ ctx: null, bgm: null }),
    seBuffer: () => ({ duration: 1 }),
    scheduleSe: (_c: unknown, _b: unknown, t: { id: string } | null) => void (t && rec.push(["fireSe", t.id])),
    scheduleBgm: () => {},
    stopBgm: () => {},
    cancelBgmFrom: () => {},
    cancelSeFrom: () => {},
    restopBgm: () => {},
    recutSe: () => {},
    pauseSe: () => {},
    discardPausedSe: () => {},
    setBgmVolume: () => {},
  };
}
/** 作りものの作品。frames 枚・layers 枚。fill(fi, li) で各レイヤーの中身を作る */
function build(T: Tree, o: { frames: number; layers?: number; loop?: boolean; bits?: 8 | 16; fill?: (fi: number, li: number, b: Any) => void }) {
  const p = T.M.newProject("v195");
  const nl = o.layers ?? 1;
  const ids = Array.from({ length: nl }, (_, i) => String.fromCharCode(65 + i));
  p.layerDefs = ids.map((id) => ({ id, name: id, visible: true, opacity: 1 }));
  p.folders = [];
  p.nextLayerId = 1000;
  if (o.bits === 16) p.indexBits = 16;
  const paper = p.frames[0].paper;
  p.frames = [];
  for (let f = 0; f < o.frames; f++) {
    const fr: Any = { paper, layers: {} };
    ids.forEach((id, li) => {
      const b = T.M.allocIndexBuf(p);
      o.fill?.(f, li, b);
      fr.layers[id] = b;
    });
    p.frames.push(fr);
  }
  p.loop = o.loop ?? false;
  return p;
}
function makeEd(T: Tree, p: Any, frame = 0) {
  const ed = new T.Editor();
  const rec = { toasts: [] as string[], audio: [] as Any[], confirms: [] as string[], confirm: true };
  ed.cb = {
    toast: (m: string) => void rec.toasts.push(m),
    appendLog: () => {},
    confirm: async (m: string) => {
      rec.confirms.push(m);
      return rec.confirm;
    },
    onHudHiddenChange: () => {},
  };
  ed.project = p;
  ed.frameIndex = frame;
  ed.activeLayerId = p.layerDefs[0]?.id ?? "A";
  ed.mounted = true;
  ed.audioPreview = fakeAudio(rec.audio);
  ed.renderCanvas = () => {};
  ed.redrawOverlay = () => {};
  ed.updateFilmSelection = () => {};
  ed.refreshSelectionLauncher = () => {};
  ed.paintFilmThumb = () => {};
  ed.nudgeSweep = () => {};
  ed.evictBehind = async () => {};
  ed.updateSizeMeter = () => {};
  intervals.clear();
  // V209: 時計を偽物に・始めた秒の記録先・1 コマぶんの長さ
  rafQ.length = 0;
  fakeClockFor(T);
  curAudioRec = rec.audio;
  curFps = T.M.FPS_TABLE[p.speedIndex] || 8;
  return { ed, rec };
}
const tt = (T: Tree, key: string, vars?: Any) => T.I.t(key, vars);

// =====================================================================================
// A-96
// =====================================================================================
function a96pure(T: Tree): V {
  const f = T.PS?.playStartFrame;
  if (typeof f !== "function") return ng("playStartFrame が無い");
  const cases: [number, number, boolean, number][] = [
    [4, 5, false, 0],
    [2, 5, false, 2],
    [0, 5, false, 0],
    [4, 5, true, 4],
    [0, 1, false, 0],
    [0, 1, true, 0],
    [1, 2, false, 0],
    [1, 2, true, 1],
  ];
  for (const [cur, n, loop, want] of cases) {
    const got = f(cur, n, loop);
    if (got !== want) return ng(`playStartFrame(${cur}, ${n}, ${loop}) = ${got}（期待 ${want}）`);
  }
  return ok();
}

/** 編集画面: 本物の togglePlayback で再生を始め、始まったコマ・BGM の位置・鳴った SE を返す */
async function edPlay(T: Tree, o: { frames: number; loop: boolean; at: number; runToEnd?: boolean }) {
  const p = build(T, { frames: o.frames, loop: o.loop });
  p.audio = { bgm: null, se: [{ id: "s0", name: "s0", source: "external", mime: "audio/wav", data: new Uint8Array(4), volume: 1, muted: false }, { id: "sL", name: "sL", source: "external", mime: "audio/wav", data: new Uint8Array(4), volume: 1, muted: false }] };
  p.frames[0].se = ["s0"];
  p.frames[o.frames - 1].se = ["sL"];
  const { ed, rec } = makeEd(T, p, o.at);
  const fps = T.M.FPS_TABLE[p.speedIndex] || 8;
  if (o.runToEnd) {
    // 先頭から最後まで流して、ループしない作品が終端で止まるところまで（＝BUG-003 の前提）
    ed.frameIndex = 0;
    ed.togglePlayback();
    await flush();
    for (let i = 0; i < o.frames + 2 && ed.playing; i++) tickAll();
    if (ed.playing) throw new Error("ループなしの再生が終端で止まらない");
    rec.audio.length = 0;
  }
  const startFrame = ed.frameIndex;
  ed.togglePlayback();
  const frameAtStart = ed.frameIndex;
  await flush();
  const start = rec.audio.find((a: Any) => a[0] === "start");
  const se = rec.audio.filter((a: Any) => a[0] === "fireSe").map((a: Any) => a[1]);
  const playing = ed.playing;
  ed.stopPlayback();
  return { startFrame, frameAtStart, bgmSec: start ? start[1] : null, fps, se, playing };
}
async function a96editor(T: Tree): Promise<V> {
  // ① ループなし・最後まで再生して止まった → ▶ で先頭から（音も頭から・先頭のコマの SE）
  const a = await edPlay(T, { frames: 5, loop: false, at: 0, runToEnd: true });
  if (a.startFrame !== 4) return ng(`前提: 終端で止まったときのコマが ${a.startFrame}（期待 4）`);
  if (!a.playing) return ng("① ▶ で再生が始まらない");
  if (a.frameAtStart !== 0) return ng(`① 最後のコマで ▶ → ${a.frameAtStart} から（期待 0）`);
  if (a.bgmSec !== 0) return ng(`① BGM の頭出し ${a.bgmSec} 秒（期待 0）`);
  if (a.se.join() !== "s0") return ng(`① 鳴った SE ${a.se.join()}（期待 s0）`);
  // ② ◀▶ で最後のコマへ送ってから ▶（終端まで再生していない）
  const b = await edPlay(T, { frames: 5, loop: false, at: 4 });
  if (b.frameAtStart !== 0 || b.bgmSec !== 0) return ng(`② 最後のコマへ送って ▶ → ${b.frameAtStart}・${b.bgmSec} 秒（期待 0・0）`);
  // ③ 途中のコマ → そのコマから
  const c = await edPlay(T, { frames: 5, loop: false, at: 2 });
  if (c.frameAtStart !== 2 || Math.abs((c.bgmSec ?? -1) - 2 / c.fps) > 1e-9) return ng(`③ 途中で ▶ → ${c.frameAtStart}・${c.bgmSec} 秒（期待 2・${2 / c.fps}）`);
  // ④ ループありは最後のコマから（今どおり）
  const d = await edPlay(T, { frames: 5, loop: true, at: 4 });
  if (d.frameAtStart !== 4) return ng(`④ ループありの最後のコマで ▶ → ${d.frameAtStart}（期待 4）`);
  // 1 コマだけ
  const e = await edPlay(T, { frames: 1, loop: false, at: 0 });
  if (e.frameAtStart !== 0 || !e.playing) return ng(`1 コマ: ${e.frameAtStart}・playing=${e.playing}`);
  return ok();
}

/** library.ts の togglePreviewPlayback を取り出して、偽の this で動かす */
function libToggle(libSrc: string, playStartFrame: Any) {
  const text = fnText(libSrc, "togglePreviewPlayback");
  if (!text) throw new Error("togglePreviewPlayback が無い");
  const js = ts.transpileModule(`function ${text}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  // ★V209 (A-121): 「曲の長さで書き出す」の形かを LibraryScreen.songModeWanted で見るようになった。本物の本文を取り出して渡す
  //  （前の版の木には無い＝いつも偽）
  const sm = fnText(libSrc, "songModeWanted");
  const songModeWanted = sm
    ? new Function(`"use strict"; ${ts.transpileModule(`function ${sm.replace(/^\s*(?:private |public )?static /, "")}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return songModeWanted;`)()
    : () => false;
  return new Function("playStartFrame", "LibraryScreen", `"use strict"; ${js}; return togglePreviewPlayback;`)(playStartFrame, { songModeWanted });
}
function a96libProject(T: Tree, fn?: Any): V {
  const toggle = fn ?? libToggle(T.libSrc, T.PS?.playStartFrame ?? ((c: number) => c));
  const run = (frames: number, loop: boolean, at: number, playing = false) => {
    const r: Any[] = [];
    const self: Any = {
      selected: { kind: "project" },
      previewPlaying: playing,
      previewProject: { frames: Array.from({ length: frames }, () => ({})), loop },
      previewFrame: at,
      player: null,
      drawPreview() {
        r.push(["draw", this.previewFrame]);
      },
      async startPreview() {
        r.push(["start", this.previewFrame]);
      },
      stopPreview() {
        r.push(["stop"]);
      },
      updatePlayButton() {},
    };
    toggle.call(self);
    return r;
  };
  const a = run(5, false, 4);
  const sa = a.find((x) => x[0] === "start");
  if (!sa || sa[1] !== 0) return ng(`① 最後のコマ・ループなしで ▶ → ${sa ? sa[1] : "始まらない"}（期待 0）`);
  if (!a.some((x) => x[0] === "draw" && x[1] === 0)) return ng("① 先頭のコマを描き直していない");
  const b = run(5, false, 2);
  const sb = b.find((x) => x[0] === "start");
  if (!sb || sb[1] !== 2 || b.some((x) => x[0] === "draw")) return ng(`③ 途中で ▶ → ${JSON.stringify(b)}`);
  const c = run(5, true, 4);
  if (c.find((x) => x[0] === "start")?.[1] !== 4) return ng(`④ ループありの最後で ▶ → ${JSON.stringify(c)}`);
  const d = run(5, false, 4, true);
  if (d.length !== 1 || d[0][0] !== "stop") return ng(`再生中の ▶（⏸）→ ${JSON.stringify(d)}`);
  const e = run(1, false, 0);
  if (e.find((x) => x[0] === "start")?.[1] !== 0) return ng(`1 コマ → ${JSON.stringify(e)}`);
  return ok();
}
/** flipnote.js の Player の、この入口に関わる所だけの偽物（setCurrentFrame・play・_hasEnded の決まりは Player.mjs と同じ） */
class FakePlayer {
  isPlaying = false;
  _hasEnded = false;
  _frame = 0;
  playbackTime = 0;
  framerate = 8;
  frameCount: number;
  loop: boolean;
  note = {};
  startedAt: number | null = null;
  constructor(n: number, loop: boolean) {
    this.frameCount = n;
    this.loop = loop;
  }
  get paused() {
    return !this.isPlaying;
  }
  get currentFrame() {
    return this._frame;
  }
  setCurrentFrame(i: number) {
    const v = Math.max(0, Math.min(Math.floor(i), this.frameCount - 1));
    if (v === this._frame) return;
    this._frame = v;
    if (!this.isPlaying) this.playbackTime = v / this.framerate;
  }
  play() {
    if (this.isPlaying) return;
    if (this._hasEnded) {
      this.playbackTime = 0;
      this._hasEnded = false;
    }
    this.isPlaying = true;
    this.startedAt = Math.round(this.playbackTime * this.framerate);
  }
  pause() {
    this.isPlaying = false;
  }
}
function a96libNote(T: Tree, fn?: Any): V {
  const toggle = fn ?? libToggle(T.libSrc, T.PS?.playStartFrame ?? ((c: number) => c));
  const run = (n: number, loop: boolean, at: number, ended = false) => {
    const p = new FakePlayer(n, loop);
    p.setCurrentFrame(at);
    p._hasEnded = ended;
    const self: Any = { selected: { kind: "note" }, player: p, updatePlayButton() {} };
    toggle.call(self);
    return p;
  };
  // ② ◀▶ で最後のコマへ送ってから ▶（stepPreviewFrame は _hasEnded を下ろす）
  const a = run(5, false, 4, false);
  if (a.startedAt !== 0) return ng(`② 最後のコマ・ループなしで ▶ → ${a.startedAt} から（期待 0）`);
  // ① 終端まで再生して止まった（_hasEnded）→ 先頭（Player 自身の決まり・変えていない）
  const b = run(5, false, 4, true);
  if (b.startedAt !== 0) return ng(`① 終端で止まったあと ▶ → ${b.startedAt}`);
  const c = run(5, false, 2);
  if (c.startedAt !== 2) return ng(`③ 途中で ▶ → ${c.startedAt}（期待 2）`);
  const d = run(5, true, 4);
  if (d.startedAt !== 4) return ng(`④ ループありの最後で ▶ → ${d.startedAt}（期待 4）`);
  const e = run(1, false, 0);
  if (e.startedAt !== 0) return ng(`1 コマ → ${e.startedAt}`);
  return ok();
}

// =====================================================================================
// A-97
// =====================================================================================
async function startLoopPlaying(T: Tree, frames = 6, at = 1) {
  const p = build(T, { frames, loop: true });
  const { ed, rec } = makeEd(T, p, at);
  ed.togglePlayback();
  await flush();
  if (!ed.playing) throw new Error("再生が始まらない");
  tickAll(); // 1 コマ進める（再生中である）
  rec.audio.length = 0;
  return { ed, rec, p };
}
async function a97goto(T: Tree): Promise<V> {
  const { ed, rec } = await startLoopPlaying(T);
  ed.gotoFrame(4);
  if (ed.playing) return ng("再生中に gotoFrame(4) → 再生が止まらない");
  if (ed.frameIndex !== 4) return ng(`gotoFrame(4) → コマ ${ed.frameIndex}`);
  if (!rec.audio.some((a: Any) => a[0] === "stop")) return ng(`音が止まらない（${JSON.stringify(rec.audio)}）`);
  if (rec.audio.some((a: Any) => a[0] === "pause")) return ng("⏸（pause）で止めている＝続きが残る");
  // V209: 再生のタイマー（前の版）も時計（今の版）も残っていない
  if (intervals.size !== 0 || ed.playClock?.running || rafQ.length !== 0) return ng("再生のタイマー（時計）が残っている");
  const n = rec.toasts.length;
  if (n !== 0) return ng(`トーストが出た: ${rec.toasts.join()}`);
  // ▶ でそこから音と絵が揃って始まる
  rec.audio.length = 0;
  ed.togglePlayback();
  await flush();
  const st = rec.audio.find((a: Any) => a[0] === "start");
  const fps = T.M.FPS_TABLE[ed.project.speedIndex] || 8;
  if (!ed.playing || ed.frameIndex !== 4 || !st || Math.abs(st[1] - 4 / fps) > 1e-9) return ng(`止めたあとの ▶: コマ ${ed.frameIndex}・音 ${st?.[1]}`);
  ed.stopPlayback();
  return ok();
}
async function a97entries(T: Tree): Promise<V> {
  const why: string[] = [];
  const tryEntry = async (name: string, fire: (ed: Any) => void, want: number, at = 1) => {
    const { ed } = await startLoopPlaying(T, 6, at);
    ed.buildTimeline();
    fire(ed);
    if (ed.playing) why.push(`${name}: 止まらない`);
    else if (ed.frameIndex !== want) why.push(`${name}: コマ ${ed.frameIndex}（期待 ${want}）`);
    ed.stopPlayback();
  };
  // 再生は at=1 から始めて 1 tick 進めた＝いま 2
  await tryEntry("⏮", () => el("#ed-first").click(), 0);
  await tryEntry("◀", () => el("#ed-prev").click(), 1);
  await tryEntry("▶|", () => el("#ed-next").click(), 3);
  await tryEntry("⏭", () => el("#ed-last").click(), 5);
  await tryEntry("◀ を先頭で", () => el("#ed-prev").click(), 0, 5); // 5 → tick で 0（ループ）→ ◀ は範囲外
  await tryEntry("フィルムのコマ", () => {
    const fr = el("#ed-film").children.filter((c) => c.classList.contains("fr"))[4];
    fr.dispatch("click", { shiftKey: false });
  }, 4);
  await tryEntry("フィルムのコマ（Shift）", () => {
    const fr = el("#ed-film").children.filter((c) => c.classList.contains("fr"))[5];
    fr.dispatch("click", { shiftKey: true });
  }, 5);
  await tryEntry("frame.prev", (ed) => ed.runCommand("frame.prev"), 1);
  await tryEntry("frame.next", (ed) => ed.runCommand("frame.next"), 3);
  await tryEntry("←", (ed) => ed.handleArrowKey({ code: "ArrowLeft", shiftKey: false, preventDefault() {} }), 1);
  await tryEntry("→", (ed) => ed.handleArrowKey({ code: "ArrowRight", shiftKey: false, preventDefault() {} }), 3);
  return why.length ? ng(why.join("／")) : ok();
}
async function a97drag(T: Tree): Promise<V> {
  const { ed } = await startLoopPlaying(T);
  const e0 = { pointerId: 3, clientX: 10, clientY: 10, button: 0 };
  ed.startFrameDrag(e0, 2);
  ed.updateFrameDrag({ ...e0, clientX: 12 }); // しきい値未満（クリックのまま）
  if (!ed.playing) return ng("しきい値未満で止まった（クリックは click→gotoFrame が止める）");
  ed.updateFrameDrag({ ...e0, clientX: 40 });
  const stopped = !ed.playing;
  ed.cancelFrameDrag();
  ed.stopPlayback();
  return stopped ? ok() : ng("並べ替えを始めても再生が止まらない");
}
function a97static(T: Tree): V {
  const g = fnText(T.editorSrc, "gotoFrame");
  if (!g) return ng("gotoFrame が無い");
  const body = noComments(g);
  const iStop = body.indexOf("this.stopPlayback()");
  const iRet = body.indexOf("return");
  if (iStop < 0) return ng("gotoFrame に stopPlayback() が無い");
  if (iRet >= 0 && iStop > iRet) return ng("stopPlayback が最初の return より後ろ（範囲外・ガードで抜けると止まらない）");
  if (!/if \(this\.playing\) this\.stopPlayback\(\);/.test(body)) return ng("gotoFrame の止め方が `if (this.playing) this.stopPlayback();` でない");
  // 呼び出し元に散らしていない
  const why: string[] = [];
  const tl = noComments(fnText(T.editorSrc, "buildTimeline") ?? "");
  for (const id of ["ed-first", "ed-prev", "ed-next", "ed-last"]) {
    const lines = tl.split("\n");
    const at = lines.findIndex((l) => l.includes(`$("#${id}").addEventListener("click"`));
    if (at < 0) {
      why.push(`#${id} の受け口が見つからない`);
      continue;
    }
    // 受け口の本文（次の受け口の行まで）
    let end = at + 1;
    while (end < lines.length && !/^\s*\$\("#/.test(lines[end])) end++;
    const body = lines.slice(at, end).join("\n");
    if (!/this\.gotoFrame\(/.test(body)) why.push(`#${id} の受け口が gotoFrame を呼んでいない`);
    if (/stopPlayback/.test(body)) why.push(`#${id} の受け口に stopPlayback`);
  }
  const film = noComments(fnText(T.editorSrc, "rebuildFilm") ?? "");
  const click = film.slice(film.indexOf('fr.addEventListener("click"'), film.indexOf('fr.addEventListener("pointerdown"'));
  if (!click || /stopPlayback/.test(click)) why.push("フィルムの click に stopPlayback（または見つからない）");
  const ak = noComments(fnText(T.editorSrc, "handleArrowKey") ?? "");
  if (!ak || /stopPlayback/.test(ak)) why.push("handleArrowKey に stopPlayback（または見つからない）");
  // ★V214 (M-2b-1a): frame.prev / next の分岐は PC の runCommand からコアの runCoreCommand へ移った（中身は同じ・PC の runCommand は
  //  先にコアへ渡す）。frame.prev〜frame.add の間を見るのは同じ
  const rc = noComments(fnText(T.editorSrc, "runCoreCommand") ?? "");
  const seg = rc.slice(rc.indexOf('case "frame.prev"'), rc.indexOf('case "frame.add"'));
  if (!seg || /stopPlayback/.test(seg)) why.push("frame.prev/next に stopPlayback（または見つからない）");
  return why.length ? ng(why.join("／")) : ok();
}

// =====================================================================================
// A-98
// =====================================================================================
/** CSS の変形の独立した写像: 絵の箱（左上 wrapLeft/Top・枠線 b）の中の点 (lx, ly) → スクロールの中身の座標。
 *  transform: rotate(rot) scaleX(-1)（関数は右から当たる＝先に反転）・transform-origin は箱の真ん中 */
function cssMap(lx: number, ly: number, o: { wrapLeft: number; wrapTop: number; bw: number; bh: number; rot: number; flip: boolean }) {
  let dx = lx - o.bw / 2;
  const dy = ly - o.bh / 2;
  if (o.flip) dx = -dx;
  const th = (o.rot * Math.PI) / 180;
  const c = Math.round(Math.cos(th));
  const s = Math.round(Math.sin(th));
  return { x: o.wrapLeft + o.bw / 2 + dx * c - dy * s, y: o.wrapTop + o.bh / 2 + dx * s + dy * c };
}
function a98pure(T: Tree, ed?: Any): V {
  const SP = T.SP;
  if (!SP?.panLayout) return ng("stagePan が無い");
  const views: [number, number][] = [[863, 545], [1600, 900], [400, 300], [201, 151], [3000, 2000], [640, 481]];
  const why: string[] = [];
  let n = 0;
  const rnd = mulberry32(195);
  for (const [vwW, vwH] of views)
    for (let z = 1; z <= 8; z++)
      for (const rot of [0, 90, 180, 270])
        for (const flip of [false, true]) {
          n++;
          const b = 4;
          const lay = SP.panLayout(vwW, vwH, z, rot, flip, b);
          const g = lay.geom;
          const o = { wrapLeft: lay.wrapLeft, wrapTop: lay.wrapTop, bw: W * z + 2 * b, bh: H * z + 2 * b, rot, flip };
          const tag = `${vwW}×${vwH} z${z} r${rot}${flip ? "f" : ""}`;
          // 見た目の絵の矩形（CSS の写像）＝ [L, L+vw]×[T, T+vh]
          const cs = [cssMap(b, b, o), cssMap(b + W * z, b, o), cssMap(b, b + H * z, o), cssMap(b + W * z, b + H * z, o)];
          const x0 = Math.min(...cs.map((c) => c.x)), x1 = Math.max(...cs.map((c) => c.x));
          const y0 = Math.min(...cs.map((c) => c.y)), y1 = Math.max(...cs.map((c) => c.y));
          if (Math.abs(x0 - g.L) > 1e-9 || Math.abs(x1 - (g.L + g.vw)) > 1e-9 || Math.abs(y0 - g.T) > 1e-9 || Math.abs(y1 - (g.T + g.vh)) > 1e-9) {
            why.push(`${tag}: 見た目の絵 [${x0},${x1}]×[${y0},${y1}] ≠ [${g.L},${g.L + g.vw}]×[${g.T},${g.T + g.vh}]`);
            continue;
          }
          // 窓の真ん中が動ける範囲（スクロール 0..sizer−窓）
          const cxMin = vwW / 2, cxMax = lay.sizerW - vwW / 2;
          const cyMin = vwH / 2, cyMax = lay.sizerH - vwH / 2;
          // 四隅が真ん中まで来る（±0.5px）
          for (const c of cs) {
            const ex = Math.abs(c.x - Math.min(cxMax, Math.max(cxMin, c.x)));
            const ey = Math.abs(c.y - Math.min(cyMax, Math.max(cyMin, c.y)));
            if (ex > 0.5 || ey > 0.5) why.push(`${tag}: 隅 (${c.x},${c.y}) が真ん中まで来ない（${ex}, ${ey}）`);
          }
          // それより外へは 1 画素も行かない（真ん中の範囲が絵の矩形の内側・端から 0.5px 以内まで来る）
          if (cxMin < x0 - 1e-9 || cxMin > x0 + 0.5 || cxMax > x1 + 1e-9 || cxMax < x1 - 0.5 || cyMin < y0 - 1e-9 || cyMin > y0 + 0.5 || cyMax > y1 + 1e-9 || cyMax < y1 - 0.5)
            why.push(`${tag}: 真ん中の範囲 [${cxMin},${cxMax}]×[${cyMin},${cyMax}] が絵 [${x0},${x1}]×[${y0},${y1}] とずれる`);
          // スクロールの範囲（箱 − 窓）＝見た目の絵の大きさ（窓が奇数なら 1 小さい）＝ maxScroll
          const ms = SP.maxScroll(g);
          if (lay.sizerW - vwW !== g.vw - (vwW % 2) || lay.sizerH - vwH !== g.vh - (vwH % 2) || ms.left !== lay.sizerW - vwW || ms.top !== lay.sizerH - vwH)
            why.push(`${tag}: スクロールの範囲 ${lay.sizerW - vwW}×${lay.sizerH - vwH}・maxScroll ${ms.left}×${ms.top}`);
          // visualToCanvas は CSS の逆写像（絵の点 → CSS → 割合 → 絵の点）
          for (let k = 0; k < 6; k++) {
            const q = { x: rnd() * W, y: rnd() * H };
            const m = cssMap(b + q.x * z, b + q.y * z, o);
            const back = SP.visualToCanvas((m.x - g.L) / g.vw, (m.y - g.T) / g.vh, rot, flip);
            if (Math.abs(back.x - q.x) > 1e-6 || Math.abs(back.y - q.y) > 1e-6) {
              why.push(`${tag}: visualToCanvas が CSS の逆写像と違う (${q.x},${q.y}) → (${back.x},${back.y})`);
              break;
            }
            const fw = SP.canvasToVisual(q.x, q.y, rot, flip);
            if (Math.abs(g.L + fw.nx * g.vw - m.x) > 1e-6 || Math.abs(g.T + fw.ny * g.vh - m.y) > 1e-6) {
              why.push(`${tag}: canvasToVisual が CSS と違う`);
              break;
            }
            // editor.ts の clientToPixelF（描く座標）と同じ
            if (ed) {
              el("#ed-canvas").rect = { left: g.L, top: g.T, width: g.vw, height: g.vh };
              ed.viewRot = rot;
              ed.viewFlipH = flip;
              const pf = ed.clientToPixelF(m.x, m.y);
              if (Math.abs(pf.x - q.x) > 1e-6 || Math.abs(pf.y - q.y) > 1e-6) {
                why.push(`${tag}: clientToPixelF (${pf.x},${pf.y}) ≠ (${q.x},${q.y})`);
                break;
              }
            }
          }
          // 真ん中の点の往復（scrollFor → anchorAt）と、倍率を変えても残ること
          for (let k = 0; k < 4; k++) {
            const a = { x: rnd() * W, y: rnd() * H };
            const s = SP.scrollFor(g, a);
            const a1 = SP.anchorAt(g, s.left, s.top);
            const tol = 0.5 / z + 1e-9;
            if (Math.abs(a1.x - a.x) > tol || Math.abs(a1.y - a.y) > tol) {
              why.push(`${tag}: 真ん中の点の往復 (${a.x},${a.y}) → (${a1.x},${a1.y})`);
              break;
            }
            const z2 = 1 + Math.floor(rnd() * 8);
            const g2 = SP.panLayout(vwW, vwH, z2, rot, flip, b).geom;
            const s2 = SP.scrollFor(g2, a1);
            const a2 = SP.anchorAt(g2, s2.left, s2.top);
            if (Math.abs(a2.x - a1.x) > 0.5 / z2 + 1e-9 || Math.abs(a2.y - a1.y) > 0.5 / z2 + 1e-9) {
              why.push(`${tag}: 倍率 ${z}→${z2} で真ん中の点が動く (${a1.x},${a1.y}) → (${a2.x},${a2.y})`);
              break;
            }
          }
        }
  if (REPORT) log(`  [A98-1] ${n} 通り（窓 ${views.length}×倍率 8×回転 4×反転 2）`);
  return why.length ? ng(`${why.length} 件: ${why.slice(0, 4).join("／")}`) : ok();
}
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 本物の applyZoom / layoutPan を偽の DOM で動かす。窓（#ed-stage）の大きさ・スクロールの窓（バーのぶん 17px 小さい） */
function setStage(w: number, h: number) {
  const stage = el("#ed-stage");
  stage.clientWidth = w;
  stage.clientHeight = h;
  const sc = el("#ed-scroll");
  sc.clientWidth = w - 17;
  sc.clientHeight = h - 17;
}
function stageEd(T: Tree, w = 900, h = 600) {
  const p = build(T, { frames: 1 });
  const { ed } = makeEd(T, p);
  const sc = el("#ed-scroll");
  sc.classList = new FakeClassList();
  setStage(w, h);
  sc.scrollLeft = 0;
  sc.scrollTop = 0;
  const wrap = el("#ed-cvwrap");
  wrap.clientLeft = 4;
  wrap.style = {};
  const sizer = el("#ed-cvpan");
  sizer.style = {};
  ed.updateGridOverlay = () => {};
  ed.paintCursorLayer = () => {};
  ed.paintUiOverlay = () => {};
  ed.zoomMode = "fit";
  ed.viewRot = 0;
  ed.viewFlipH = false;
  ed.previewLarge = false;
  return { ed, sc, wrap, sizer };
}
function a98stage(T: Tree): V {
  const SP = T.SP;
  const { ed, sc, wrap, sizer } = stageEd(T);
  const anchor = () => SP.anchorAt(ed.panGeom, sc.scrollLeft, sc.scrollTop);
  const near = (a: Any, b: Any, z: number) => Math.abs(a.x - b.x) <= 0.5 / z + 1e-9 && Math.abs(a.y - b.y) <= 0.5 / z + 1e-9;
  ed.applyZoom();
  if (sc.classList.contains("pan") || sizer.style.width || wrap.style.left) return ng(`全体表示: .pan=${sc.classList.contains("pan")} sizer=${sizer.style.width} left=${wrap.style.left}`);
  if (wrap.style.width !== `${W * 2}px`) return ng(`全体表示の倍率: ${wrap.style.width}（期待 ${W * 2}px）`);
  // 全体表示 → 拡大（絵の真ん中が窓の真ん中）
  ed.adjustZoom(+1);
  if (ed.zoomMode !== 3 || !sc.classList.contains("pan")) return ng(`拡大: zoom=${ed.zoomMode} pan=${sc.classList.contains("pan")}`);
  if (sizer.style.width !== `${W * 3 + 882}px` || sizer.style.height !== `${H * 3 + 582}px`) return ng(`箱の大きさ ${sizer.style.width}×${sizer.style.height}`);
  if (wrap.style.left !== `${441 - 4}px` || wrap.style.top !== `${291 - 4}px`) return ng(`絵の箱の位置 ${wrap.style.left}, ${wrap.style.top}`);
  if (!near(anchor(), { x: 160, y: 120 }, 3)) return ng(`全体表示から拡大: 真ん中の点 ${JSON.stringify(anchor())}`);
  // 好きな所へ動かして倍率を変える → 真ん中の点が残る（はみ出す倍率 3〜8 の中で）
  sc.scrollLeft = 123;
  sc.scrollTop = 77;
  let a0 = anchor();
  for (const d of [+1, +1, +1, +1, +1, -1, -1, -1, -1, -1]) {
    const zPrev = ed.zoomMode;
    ed.adjustZoom(d);
    if (!near(anchor(), a0, Math.min(zPrev, ed.zoomMode))) return ng(`倍率 ${zPrev}→${ed.zoomMode} で真ん中の点が動く ${JSON.stringify(a0)} → ${JSON.stringify(anchor())}`);
    a0 = anchor();
  }
  // V195b: 窓に収まる倍率（全体表示の 2 倍以下）へ降りたら今までの形・また上がったら絵の真ん中
  for (const d of [-1, -1, +1]) {
    ed.adjustZoom(d);
    if (sc.classList.contains("pan") || sizer.style.width || wrap.style.left || ed.panGeom) return ng(`収まる倍率 ${ed.zoomMode} で余白が付いている`);
  }
  ed.adjustZoom(+1);
  if (ed.zoomMode !== 3 || !sc.classList.contains("pan") || !near(anchor(), { x: 160, y: 120 }, 3)) return ng(`収まる → はみ出す（${ed.zoomMode}）: 絵の真ん中が窓の真ん中でない ${JSON.stringify(ed.panGeom && anchor())}`);
  // 回転・反転（本物の applyViewChange＝#ed-view-rot の受け口が呼ぶ所）
  ed.zoomMode = 4;
  ed.applyZoom();
  sc.scrollLeft = 900;
  sc.scrollTop = 300;
  a0 = anchor();
  for (const step of ["rot", "rot", "flip", "rot", "flip", "rot"]) {
    if (step === "rot") ed.viewRot = (ed.viewRot + 90) % 360;
    else ed.viewFlipH = !ed.viewFlipH;
    ed.applyViewChange();
    const g = ed.panGeom;
    const rot = ed.viewRot === 90 || ed.viewRot === 270;
    if (!g || g.vw !== (rot ? H : W) * 4 || g.rot !== ed.viewRot || g.flip !== ed.viewFlipH) return ng(`回転 ${ed.viewRot} 反転 ${ed.viewFlipH}: 形が追従しない ${JSON.stringify(g)}`);
    const wantLeft = g.L - 4 + (rot ? -40 * 4 : 0);
    if (wrap.style.left !== `${wantLeft}px`) return ng(`回転 ${ed.viewRot}: 絵の箱 ${wrap.style.left}（期待 ${wantLeft}px）`);
    if (!near(anchor(), a0, 4)) return ng(`回転・反転で真ん中の点が動く ${JSON.stringify(a0)} → ${JSON.stringify(anchor())}`);
    if (wrap.style.transform === undefined || !wrap.style.transform.includes(`rotate(${ed.viewRot}deg)`)) return ng(`transform が当たっていない: ${wrap.style.transform}`);
  }
  // 窓の大きさが変わる（ResizeObserver → applyZoom）→ 範囲が追従・真ん中の点が残る
  a0 = anchor();
  sc.clientWidth = 601;
  sc.clientHeight = 377;
  ed.applyZoom();
  if (ed.panGeom.viewW !== 601 || sizer.style.width !== `${ed.panGeom.vw + 600}px`) return ng(`窓の大きさに追従しない ${JSON.stringify(ed.panGeom)} ${sizer.style.width}`);
  if (!near(anchor(), a0, 4)) return ng(`窓の大きさを変えると真ん中の点が動く`);
  // 大画面（swapped）を行き来しても同じ点
  a0 = anchor();
  ed.previewLarge = true;
  ed.applyZoom();
  if (sc.classList.contains("pan") || wrap.style.left || sizer.style.width) return ng("大画面の間に .pan・インラインが残る");
  sc.scrollLeft = 0;
  sc.scrollTop = 0; // 大画面ではスクロールの中身が無くなる
  ed.previewLarge = false;
  ed.applyZoom();
  if (!sc.classList.contains("pan") || !near(anchor(), a0, 4)) return ng(`大画面から戻ると真ん中の点が戻らない ${JSON.stringify(a0)} → ${JSON.stringify(anchor())}`);
  // V195b: 窓を大きくして 4 倍が収まる（1600×1000 → 全体表示も 4 倍）→ 今までの形 → 戻すとはみ出す＝絵の真ん中
  setStage(1600, 1000);
  ed.applyZoom();
  if (sc.classList.contains("pan") || sizer.style.width || wrap.style.left || ed.panGeom) return ng("窓を大きくして収まったのに余白が付いている");
  setStage(900, 600);
  ed.applyZoom();
  if (!sc.classList.contains("pan") || !near(anchor(), { x: 160, y: 120 }, 4)) return ng(`窓を小さくしてはみ出したのに絵の真ん中が窓の真ん中でない ${JSON.stringify(ed.panGeom && anchor())}`);
  // 全体表示の回転は transform だけ（倍率を計算し直さない＝今どおり）
  const s2 = stageEd(T);
  s2.ed.applyZoom();
  const w0 = s2.wrap.style.width;
  s2.ed.viewRot = 90;
  s2.ed.applyViewChange();
  if (s2.sc.classList.contains("pan") || s2.wrap.style.width !== w0 || !String(s2.wrap.style.transform).includes("rotate(90deg)")) return ng("全体表示の回転が今どおりでない");
  return ok();
}
/** ★V195b（作者決定「収まる大きさは元の形」）: 余白を付けるのは、見た目の絵が窓（全体表示と同じ物差し
 *  availW/H＝#ed-stage − 40）からはみ出すときだけ */
function a98fit(T: Tree): V {
  const SP = T.SP;
  if (!SP?.fitZoom || !SP?.panNeeded) return ng("stagePan に fitZoom / panNeeded が無い");
  const why: string[] = [];
  // ① 純関数: はみ出す（幅か高さ）⟺ panNeeded。窓が小さすぎて 1 倍でもはみ出すときだけ全体表示（1 倍）と同じ形
  let n = 0;
  for (let aw = 100; aw <= 2700; aw += 37)
    for (let ah = 80; ah <= 2100; ah += 41)
      for (const rot of [0, 90, 180, 270])
        for (let z = 1; z <= 8; z++) {
          n++;
          const r = rot === 90 || rot === 270;
          const cw = r ? H : W;
          const ch = r ? W : H;
          const over = z * cw > aw || z * ch > ah;
          const raw = Math.floor(Math.min(aw / cw, ah / ch));
          const want = raw >= 1 ? over : z > 1;
          if (SP.panNeeded(z, aw, ah, rot) !== want) {
            why.push(`panNeeded(${z}, ${aw}, ${ah}, ${rot})=${SP.panNeeded(z, aw, ah, rot)}（期待 ${want}）`);
            if (why.length > 3) return ng(why.join("／"));
          }
          if (SP.fitZoom(aw, ah, rot) !== Math.max(1, raw)) why.push(`fitZoom(${aw}, ${ah}, ${rot})`);
        }
  if (REPORT) log(`  [A98-4] panNeeded の総当たり ${n} 通り`);
  // ② 本物の applyZoom: 1600×1000（全体表示は 4 倍）→ 数字の 2・3・4 倍は全体表示と同じ形、5 倍で余白・絵の真ん中
  const shape = (s: Any) => JSON.stringify({ pan: s.sc.classList.contains("pan"), sizer: [s.sizer.style.width ?? "", s.sizer.style.height ?? ""], left: s.wrap.style.left ?? "", top: s.wrap.style.top ?? "", w: s.wrap.style.width, geom: s.ed.panGeom });
  {
    const s = stageEd(T, 1600, 1000);
    s.ed.applyZoom();
    if (s.wrap.style.width !== `${W * 4}px`) why.push(`1600×1000 の全体表示が 4 倍でない（${s.wrap.style.width}）`);
    const fitShape = shape(s);
    for (const z of [1, 2, 3, 4]) {
      s.ed.zoomMode = z;
      s.ed.applyZoom();
      if (s.sc.classList.contains("pan") || s.sizer.style.width || s.wrap.style.left || s.ed.panGeom) why.push(`1600×1000 の ${z} 倍（収まる）で余白が付いた`);
      if (z === 4 && shape(s) !== fitShape) why.push(`全体表示（4 倍）と数字の 4 倍で形が違う ${fitShape} / ${shape(s)}`);
    }
    s.ed.zoomMode = 5;
    s.ed.applyZoom();
    const a = s.ed.panGeom && SP.anchorAt(s.ed.panGeom, s.sc.scrollLeft, s.sc.scrollTop);
    if (!s.sc.classList.contains("pan") || !a || Math.abs(a.x - 160) > 0.2 || Math.abs(a.y - 120) > 0.2) why.push(`収まる 4 倍 → はみ出す 5 倍: 絵の真ん中が窓の真ん中でない ${JSON.stringify(a)}`);
    s.ed.zoomMode = 4;
    s.ed.applyZoom();
    if (shape(s) !== fitShape) why.push("はみ出す 5 倍 → 収まる 4 倍で今までの形に戻らない");
  }
  // ③ 境目の物差しは availW（#ed-stage − 40）: 990×800 → avail 950×760。3 倍の幅 960 は窓の 990 には収まるが 950 を超える＝はみ出す
  {
    const s = stageEd(T, 990, 800);
    s.ed.zoomMode = 3;
    s.ed.applyZoom();
    if (!s.sc.classList.contains("pan")) why.push("990×800 の 3 倍（availW 950 を超える 960）で余白が付かない＝物差しが全体表示と違う");
    s.ed.applyZoom(); // 全体表示の倍率も 2（＝3 倍ははみ出す側）であること
    s.ed.zoomMode = "fit";
    s.ed.applyZoom();
    if (s.wrap.style.width !== `${W * 2}px`) why.push(`990×800 の全体表示が 2 倍でない（${s.wrap.style.width}）`);
  }
  // ④ 回転 90°: 横長の窓 1400×800（avail 1360×760）。0° の全体表示は 3 倍・90° は 2 倍＝3 倍は 0° で収まり 90° ではみ出す
  {
    const s = stageEd(T, 1400, 800);
    s.ed.zoomMode = 3;
    s.ed.applyZoom();
    if (s.sc.classList.contains("pan")) why.push("1400×800・0°・3 倍（収まる）で余白が付いた");
    s.ed.viewRot = 90;
    s.ed.applyViewChange(); // #ed-view-rot の受け口と同じ
    const a = s.ed.panGeom && SP.anchorAt(s.ed.panGeom, s.sc.scrollLeft, s.sc.scrollTop);
    if (!s.sc.classList.contains("pan") || !a || Math.abs(a.x - 160) > 0.2 || Math.abs(a.y - 120) > 0.2) why.push(`回転 90° で縦長になってはみ出したのに、余白が付かない／絵の真ん中が真ん中でない ${JSON.stringify(a)}`);
    if (s.ed.panGeom && (s.ed.panGeom.vw !== H * 3 || s.ed.panGeom.vh !== W * 3)) why.push(`回転 90° の見た目の大きさ ${s.ed.panGeom.vw}×${s.ed.panGeom.vh}`);
    s.ed.viewRot = 180;
    s.ed.applyViewChange();
    if (s.sc.classList.contains("pan") || s.ed.panGeom || s.wrap.style.left) why.push("回転 180°（横長に戻って収まる）で余白が残った");
    if (!String(s.wrap.style.transform).includes("rotate(180deg)")) why.push("回転 180° の transform が当たっていない");
  }
  // ⑤ 大画面の往復の間に「収まる／はみ出す」が入れ替わる
  {
    const s = stageEd(T, 900, 600);
    s.ed.zoomMode = 3;
    s.ed.applyZoom(); // はみ出す
    s.sc.scrollLeft = 400;
    s.sc.scrollTop = 200;
    s.ed.previewLarge = true;
    s.ed.applyZoom();
    setStage(1600, 1000); // 大画面の間に窓を大きく
    s.ed.applyZoom();
    s.ed.previewLarge = false;
    s.ed.applyZoom();
    if (s.sc.classList.contains("pan") || s.ed.panGeom || s.ed.panHeld) why.push("大画面の間に収まる大きさになったのに、戻ると余白付き（控えた点が残る）");
    s.ed.previewLarge = true;
    s.ed.applyZoom();
    setStage(900, 600); // 大画面の間に窓を小さく
    s.ed.applyZoom();
    s.ed.previewLarge = false;
    s.ed.applyZoom();
    const a = s.ed.panGeom && SP.anchorAt(s.ed.panGeom, s.sc.scrollLeft, s.sc.scrollTop);
    if (!s.sc.classList.contains("pan") || !a || Math.abs(a.x - 160) > 0.2 || Math.abs(a.y - 120) > 0.2) why.push(`大画面の間にはみ出す大きさになった → 戻ると絵の真ん中でない ${JSON.stringify(a)}`);
  }
  return why.length ? ng(why.join("／")) : ok();
}
function a98static(T: Tree): V {
  const css = T.css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: string) => {
    const re = new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
    const m = css.match(re);
    return m ? m[2] : null;
  };
  const why: string[] = [];
  if (!/display:\s*none/.test(rule(".cv-pan") ?? "")) why.push(".cv-pan { display:none } が無い");
  if (!/display:\s*block/.test(rule(".stage-scroll.pan .cv-pan") ?? "")) why.push(".stage-scroll.pan .cv-pan { display:block } が無い");
  const w = rule(".stage-scroll.pan .cvwrap") ?? "";
  if (!/position:\s*absolute/.test(w) || !/margin:\s*0/.test(w)) why.push(".stage-scroll.pan .cvwrap { position:absolute; margin:0 } が無い");
  const s = rule(".stage-scroll.pan") ?? "";
  if (!/padding:\s*0/.test(s) || !/display:\s*block/.test(s)) why.push(".stage-scroll.pan { display:block; padding:0 } が無い");
  const h = T.html;
  const iS = h.indexOf('id="ed-scroll"'), iP = h.indexOf('id="ed-cvpan"'), iW = h.indexOf('id="ed-cvwrap"');
  if (!(iS >= 0 && iP > iS && iW > iP)) why.push("index.html: #ed-cvpan が #ed-scroll の中で #ed-cvwrap より前に無い");
  return why.length ? ng(why.join("／")) : ok();
}
function a98hud(T: Tree): V {
  const p = build(T, { frames: 1 });
  const { ed } = makeEd(T, p);
  const right = el(".cvright");
  right.classList = new FakeClassList();
  right.style = {};
  ed.miniDock = "float";
  ed.hudHidden = false;
  ed.applyHud();
  if (right.classList.contains("hud-collapsed")) return ng("出している間に hud-collapsed");
  ed.toggleHudHidden();
  if (!ed.hudHidden || !right.classList.contains("hud-collapsed")) return ng("「隠す」でボタン列が畳まれない（hud-collapsed が付かない）");
  ed.toggleHudHidden();
  if (right.classList.contains("hud-collapsed")) return ng("もう一度で戻らない");
  // 四隅変形の間に隠す／出す → 抜けたらインラインが残らない
  ed.muteFloatingOverlays(true);
  if (right.style.pointerEvents !== "none") return ng("前提: muteFloatingOverlays が列を止めていない");
  ed.toggleHudHidden();
  ed.toggleHudHidden();
  ed.muteFloatingOverlays(false);
  if (right.style.pointerEvents || right.style.opacity || right.classList.contains("hud-collapsed")) return ng(`四隅変形を抜けたあと: pe=${right.style.pointerEvents} op=${right.style.opacity} collapsed=${right.classList.contains("hud-collapsed")}`);
  ed.muteFloatingOverlays(true);
  ed.toggleHudHidden(); // 隠したまま抜ける
  ed.muteFloatingOverlays(false);
  if (right.style.pointerEvents || right.style.opacity || !right.classList.contains("hud-collapsed")) return ng("隠したまま四隅変形を抜けるとインラインが残る／畳みが外れる");
  // 隠している間もキーで拡大・回転・反転（本物の bindHeader の受け口・clickUi）
  const st = stageEd(T);
  const e2 = st.ed;
  el(".cvright").classList.add("hud-collapsed");
  e2.hudHidden = true;
  e2.bindHeader();
  e2.applyZoom();
  e2.runCommand("view.zoomIn");
  if (e2.zoomMode !== 3) return ng(`隠している間の view.zoomIn → ${e2.zoomMode}`);
  e2.runCommand("view.rotate");
  if (e2.viewRot !== 90) return ng(`隠している間の view.rotate → ${e2.viewRot}`);
  e2.runCommand("view.flip");
  if (e2.viewFlipH !== true) return ng("隠している間の view.flip が効かない");
  // CSS: 隠す／出すのボタン以外を display:none
  const css = T.css.replace(/\/\*[\s\S]*?\*\//g, "");
  const m = css.match(/\.cvright\.hud-collapsed\s*>\s*:not\(#ed-mini-toggle\)\s*\{([^}]*)\}/);
  if (!m || !/display:\s*none/.test(m[1])) return ng("CSS: .cvright.hud-collapsed > :not(#ed-mini-toggle) { display:none } が無い");
  const h = T.html;
  const cv = h.slice(h.indexOf('<div class="cvright">'), h.indexOf("</div>", h.indexOf('<div class="cvright">')));
  if (!cv.includes('id="ed-mini-toggle"')) return ng("index.html: 隠す／出すのボタンが .cvright の中に無い");
  return ok();
}

// =====================================================================================
// A-99
// =====================================================================================
function a99pure(T: Tree): V {
  const CU = T.CU;
  if (!CU?.colorSlots) return ng("colorUsage が無い");
  const p = T.M.newProject("x");
  p.colorTable = ["", "#111111", "#ABCDEF", "", "#abcdef", "#222222"];
  const s = CU.colorSlots(p, "#abcdef");
  if (s.join() !== "2,4") return ng(`colorSlots 大文字小文字・重複: ${s}`);
  if (CU.colorSlots(p, "").length !== 0) return ng("透明（\"\"）が番号を返す");
  const v = CU.colorDeleteVerdict;
  if (v({ frames: 3, history: true, clip: true }) !== "frames" || v({ frames: 0, history: true, clip: true }) !== "history" || v({ frames: 0, history: false, clip: true }) !== "clip" || v({ frames: 0, history: false, clip: false }) !== "ok") return ng("colorDeleteVerdict の順");
  return ok();
}
const yieldNow = () => new Promise<void>((r) => setImmediate(r));
async function a99scan(T: Tree): Promise<V> {
  const CU = T.CU;
  const SL = T.SL;
  const why: string[] = [];
  const mk = () => {
    const p = build(T, { frames: 4, layers: 2 });
    p.colorTable = ["", "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff"];
    for (const f of p.frames) f.paper = 2;
    p.frames[1].layers.A[10] = 3; // 赤は 1 コマ目のレイヤー A
    p.frames[3].layers.B[PIXELS - 1] = 3; // と 3 コマ目のレイヤー B
    return p;
  };
  const scan = (p: Any, slots: number[], history: Any[] = [], clips: Any[] = []) => CU.scanColorUse(p, slots, { history, clips }, yieldNow, 0);
  let p = mk();
  let u = await scan(p, [3]);
  if (u.frames !== 2) why.push(`起きているレイヤー: frames=${u.frames}（期待 2）`);
  u = await scan(p, [4]);
  if (u.frames !== 0 || u.history || u.clip) why.push(`使っていない色: ${JSON.stringify(u)}`);
  u = await scan(p, [2]);
  if (u.frames !== 4) why.push(`紙: frames=${u.frames}（期待 4）`);
  // 眠っている控え（起こさない・控えはそのまま）
  p = mk();
  for (const f of p.frames.slice(1)) await SL.sleepFrame(p, f);
  const asleep0 = SL.asleepCount(p);
  const entry = p.frames[3].sleep.B;
  u = await scan(p, [3]);
  if (u.frames !== 2) why.push(`眠っている控え: frames=${u.frames}（期待 2）`);
  if (SL.asleepCount(p) !== asleep0 || p.frames[3].layers.B || p.frames[3].sleep.B !== entry) why.push("調べたら眠っているレイヤーが起きた／控えが作り直された");
  u = await scan(p, [3]); // 2 回目は覚えた一覧で
  if (u.frames !== 2) why.push(`眠っている控え（2 回目）: frames=${u.frames}`);
  // 📌 同じ実体を共有するコマ
  p = mk();
  const shared = T.M.allocIndexBuf(p);
  shared[5] = 5;
  for (const f of p.frames) f.layers.B = shared;
  u = await scan(p, [5]);
  if (u.frames !== 4) why.push(`共通レイヤー: frames=${u.frames}（期待 4）`);
  // 履歴
  p = mk();
  const b4 = T.M.allocIndexBuf(p);
  b4[3] = 4;
  const H = T.H;
  const e1 = H.bufferChangeEntry("x", () => null, b4, T.M.allocIndexBuf(p));
  u = await scan(p, [4], [e1]);
  if (!u.history) why.push("履歴の bufs（bufferChangeEntry）を見ていない");
  const fr: Any = { paper: 2, layers: { A: b4 } };
  u = await scan(p, [4], [{ label: "f", undo() {}, redo() {}, colorRefs: () => ({ frames: [fr] }) }]);
  if (!u.history) why.push("履歴の frames を見ていない");
  const frS: Any = { paper: 2, layers: { A: b4 } };
  await SL.sleepLayer(p, frS, "A");
  u = await scan(p, [4], [{ label: "f", undo() {}, redo() {}, colorRefs: () => ({ frames: [frS] }) }]);
  if (!u.history) why.push("履歴の眠っているコマを見ていない");
  u = await scan(p, [5], [{ label: "p", undo() {}, redo() {}, colorRefs: () => ({ papers: [1, 5] }) }]);
  if (!u.history) why.push("履歴の papers を見ていない");
  u = await scan(p, [5], [{ label: "m", bytes: PIXELS * 2, undo() {}, redo() {} }]);
  if (!u.history) why.push("網: 申告なしで画素ぶんの bytes → 分からない（消さない）にならない");
  u = await scan(p, [5], [{ label: "m", bytes: PIXELS * 2, colorRefs: H.NO_COLOR_REFS, undo() {}, redo() {} }, { label: "l", bytes: 64, undo() {}, redo() {} }]);
  if (u.history) why.push("NO_COLOR_REFS／小さい申告を「使っている」にしている");
  // 作品に入っているコマは ① で見た（履歴の frames に同じコマがあっても二重に数えない・止まらない）
  u = await scan(p, [4], [{ label: "f", undo() {}, redo() {}, colorRefs: () => ({ frames: [p.frames[0]] }) }]);
  if (u.history || u.frames) why.push(`作品に入っているコマを履歴でも数えた ${JSON.stringify(u)}`);
  // ★同じ中身の控えは 1 回だけ展開する。使い回すのは**幅もバイトも同じ**ときだけ（目印が同じだけでは使い回さない）
  {
    const q = build(T, { frames: 4, layers: 1 });
    q.frames[0].layers.A[3000] = 3;
    for (const i of [1, 2]) q.frames[i].layers.A.set(q.frames[0].layers.A); // 複製（中身が同じ別の控えになる）
    q.frames[3].layers.A[3000] = 4;
    for (const f of q.frames) await SL.sleepFrame(q, f);
    const z0 = q.frames[0].sleep.A.z;
    if (q.frames[1].sleep.A.z === z0 || q.frames[1].sleep.A.z.some((x: number, i: number) => x !== z0[i])) why.push("前提: 複製したコマの控えが「同じ中身の別の実体」でない");
    u = await scan(q, [3]);
    if (u.frames !== 3) why.push(`同じ中身の控え 3 枚: frames=${u.frames}（期待 3）`);
    u = await scan(q, [4]);
    if (u.frames !== 1) why.push(`別の中身の控え: frames=${u.frames}（期待 1）`);
    const list = [{ bits: 8, z: z0 }];
    const same = Uint8Array.from(z0);
    const diff = Uint8Array.from(z0);
    const mid = 10 + Math.floor((z0.length - 11) / 2) + 1; // 目印に拾われない位置（真ん中の次）
    diff[mid] ^= 0xff;
    if (CU.sampleKey(8, diff) !== CU.sampleKey(8, z0)) why.push("前提: 1 バイト変えた控えの目印が変わった（拾う位置の作りが変わった）");
    if (!CU.findSameControl(list, 8, same)) why.push("同じバイトの別の実体を同じ中身と見ない");
    if (CU.findSameControl(list, 8, diff)) why.push("目印が同じで 1 バイト違う控えを同じ中身として使い回した");
    if (CU.findSameControl(list, 16, same)) why.push("幅が違う控えを同じ中身として使い回した");
  }
  // コピー中の絵
  u = await scan(p, [4], [], [null, b4]);
  if (!u.clip) why.push("コピー中の絵を見ていない");
  // 16bit の番号（8bit のバッファには無い）
  const p16 = build(T, { frames: 2, bits: 16 });
  p16.colorTable = Array.from({ length: 400 }, (_, i) => (i === 0 ? "" : `#${i.toString(16).padStart(6, "0")}`));
  p16.frames[1].layers.A[7] = 300;
  u = await scan(p16, [300]);
  if (u.frames !== 1) why.push(`16bit: frames=${u.frames}`);
  const b8 = new Uint8Array(PIXELS).fill(44); // 300 & 255 = 44 を 8bit で持っていても 300 ではない
  u = await scan(p16, [300], [], [b8]);
  if (u.clip) why.push("8bit のバッファで 300 を見つけた（桁あふれ）");
  return why.length ? ng(why.join("／")) : ok();
}

/** 本物の Editor の deletePaletteColor */
/** ★V213: 範囲のコピー（static clipboard）を置く。`clipboard` はコアの `EditorCore` の static へ移り、コアは
 *  `EditorCore.clipboard` を読む。`T.Editor.clipboard = …` と書くと `Editor` に自前の値ができてコアの値と別になる
 *  （読む側は見ない）。だから持ち主（プロトタイプの鎖で `clipboard` を自前で持つクラス）に書く。前の木では `Editor` 自身 */
function setClipboard(T: Tree, v: unknown): void {
  let o: Any = T.Editor;
  while (o && !Object.prototype.hasOwnProperty.call(o, "clipboard")) o = Object.getPrototypeOf(o);
  (o ?? T.Editor).clipboard = v;
}
async function a99editor(T: Tree): Promise<V> {
  const why: string[] = [];
  const RED = "#ff1717";
  const fresh = (o: { frames?: number; bits?: 8 | 16 } = {}) => {
    const p = build(T, { frames: o.frames ?? 3, layers: 2, bits: o.bits });
    const { ed, rec } = makeEd(T, p, 0);
    setClipboard(T, null);
    ed.layerClip = null;
    ed.history.clear();
    return { p, ed, rec };
  };
  const pal = () => el("#ed-pal").children.filter((c) => !c.classList.contains("tp")).map((c) => c.title);
  const idx = (p: Any, hex: string) => p.colorTable.indexOf(hex);
  // ① 使っていない色 → 消える（空き番号）・帯から消える・取り消しで戻る・やり直しでまた消える
  {
    const { p, ed, rec } = fresh();
    // 関係ない描画（別の色）を履歴に積んでおく＝履歴があっても使っていない色は消せる
    const buf = p.frames[0].layers.A;
    const before = T.M.copyIndexBuf(buf);
    buf[100] = 1;
    ed.pushBufferHistory("描画", buf, before);
    const k = idx(p, "#ffe600");
    const len = p.colorTable.length;
    ed.rebuildPalette();
    const n0 = pal().length;
    await ed.deletePaletteColor("#ffe600");
    if (p.colorTable[k] !== "" || p.colorTable.length !== len) why.push(`① 消えない／番号が詰まった: [${k}]=${JSON.stringify(p.colorTable[k])} len ${p.colorTable.length}`);
    if (pal().length !== n0 - 1 || pal().some((t) => t.startsWith("#ffe600"))) why.push("① 帯から消えない");
    if (rec.confirms.length !== 1) why.push("① 確認が出ない");
    if (rec.toasts.at(-1) !== tt(T, "ed.color.deleted.toast")) why.push(`① 消したあとの知らせ: ${rec.toasts.at(-1)}`);
    if (!ed.dirty) why.push("① dirty にならない");
    ed.history.undo();
    if (p.colorTable[k] !== "#ffe600" || pal().length !== n0) why.push("① Ctrl+Z で帯に戻らない");
    ed.history.redo();
    if (p.colorTable[k] !== "") why.push("① Ctrl+Y でまた消えない");
    // 消したあとに同じ色を使うと新しい番号（空き番号は使い回さない）
    const k2 = T.M.ensureColor(p, "#ffe600");
    if (k2 === k || k2 !== p.colorTable.length - 1) why.push(`① 消した番号を ensureColor が使い回した（${k2}）`);
  }
  // ② コマで使っている → 消さない・コマ数を知らせる
  {
    const { p, ed, rec } = fresh();
    const k = idx(p, RED);
    p.frames[0].layers.A[1] = k;
    p.frames[2].layers.B[2] = k;
    await ed.deletePaletteColor(RED);
    if (p.colorTable[k] !== RED) why.push("② 使っている色を消した");
    if (rec.toasts.at(-1) !== tt(T, "ed.color.usedFrames.toast", { n: 2 })) why.push(`② 知らせ: ${rec.toasts.at(-1)}`);
    if (rec.confirms.length !== 0) why.push("② 消せない色に確認を出した");
    if (ed.history.canUndo) why.push("② 履歴に積んだ");
  }
  // ③ 眠っているコマで使っている（起こさない）
  {
    const { p, ed, rec } = fresh();
    const k = idx(p, RED);
    p.frames[2].layers.A[9] = k;
    await T.SL.sleepFrame(p, p.frames[2]);
    await ed.deletePaletteColor(RED);
    if (p.colorTable[k] !== RED || rec.toasts.at(-1) !== tt(T, "ed.color.usedFrames.toast", { n: 1 })) why.push(`③ 眠ったコマ: ${rec.toasts.at(-1)}`);
    if (p.frames[2].layers.A) why.push("③ 眠っていたコマを起こした");
  }
  // ④ 紙
  {
    const { p, ed, rec } = fresh();
    const k = idx(p, "#0038ce");
    p.frames[1].paper = k;
    await ed.deletePaletteColor("#0038ce");
    if (p.colorTable[k] !== "#0038ce" || rec.toasts.at(-1) !== tt(T, "ed.color.usedFrames.toast", { n: 1 })) why.push(`④ 紙: ${rec.toasts.at(-1)}`);
  }
  // ⑤ 描いて Ctrl+Z した絵（取り消しの記録の中）→ 記録が残っている間は消さない
  {
    const { p, ed, rec } = fresh();
    const k = idx(p, RED);
    const buf = p.frames[0].layers.A;
    const before = T.M.copyIndexBuf(buf);
    buf[50] = k;
    ed.pushBufferHistory("描画", buf, before);
    ed.history.undo();
    if (buf[50] !== 0) why.push("⑤ 前提: 取り消しで絵が戻らない");
    await ed.deletePaletteColor(RED);
    if (p.colorTable[k] !== RED || rec.toasts.at(-1) !== tt(T, "ed.color.usedHistory.toast")) why.push(`⑤ 取り消しの記録: ${rec.toasts.at(-1)}`);
    ed.history.clear();
    await ed.deletePaletteColor(RED);
    if (p.colorTable[k] !== "") why.push("⑤ 記録が無くなったあとも消せない");
  }
  // ⑥ 消したコマ（Ctrl+Z で戻る）
  {
    const { p, ed, rec } = fresh();
    const k = idx(p, RED);
    p.frames[1].layers.B[7] = k;
    ed.deleteFrameInner(1, 1);
    if (p.frames.length !== 2) why.push("⑥ 前提: コマが消えない");
    await ed.deletePaletteColor(RED);
    if (p.colorTable[k] !== RED || rec.toasts.at(-1) !== tt(T, "ed.color.usedHistory.toast")) why.push(`⑥ 消したコマ: ${rec.toasts.at(-1)}`);
  }
  // ⑦ 消したレイヤー
  {
    const { p, ed, rec } = fresh();
    const k = idx(p, RED);
    p.frames[2].layers.B[7] = k;
    ed.afterLayerChange = () => {};
    const def = p.layerDefs[1];
    await ed.deleteLayerInner(def, 1);
    if (p.layerDefs.length !== 1) why.push("⑦ 前提: レイヤーが消えない");
    await ed.deletePaletteColor(RED);
    if (p.colorTable[k] !== RED || rec.toasts.at(-1) !== tt(T, "ed.color.usedHistory.toast")) why.push(`⑦ 消したレイヤー: ${rec.toasts.at(-1)}`);
  }
  // ⑧ 紙色を変えて Ctrl+Z（紙色の記録）
  {
    const { p, ed, rec } = fresh();
    ed.afterStructuralChange = () => {};
    const k = idx(p, "#0038ce");
    ed.setPaper("#0038ce");
    ed.history.undo();
    if (p.frames[0].paper === k) why.push("⑧ 前提: 紙色が戻らない");
    await ed.deletePaletteColor("#0038ce");
    if (p.colorTable[k] !== "#0038ce" || rec.toasts.at(-1) !== tt(T, "ed.color.usedHistory.toast")) why.push(`⑧ 紙色の記録: ${rec.toasts.at(-1)}`);
  }
  // ⑨ コピー中の絵（範囲・レイヤー）
  {
    const { p, ed, rec } = fresh();
    const k = idx(p, RED);
    const d = T.M.allocIndexBuf(p);
    d[0] = k;
    setClipboard(T, { w: 1, h: 1, x: 0, y: 0, data: d });
    await ed.deletePaletteColor(RED);
    if (p.colorTable[k] !== RED || rec.toasts.at(-1) !== tt(T, "ed.color.usedClip.toast")) why.push(`⑨ 範囲のコピー: ${rec.toasts.at(-1)}`);
    setClipboard(T, null);
    // V199 (A-105): レイヤーの控えは { kind, …, buf } の形になった（フォルダの控えは items[].buf）。調べるのは同じ（clipBuffers）
    ed.layerClip = { kind: "layer", frame: 0, layerId: "A", name: "A", buf: d };
    await ed.deletePaletteColor(RED);
    if (p.colorTable[k] !== RED || rec.toasts.at(-1) !== tt(T, "ed.color.usedClip.toast")) why.push(`⑨ レイヤーのコピー: ${rec.toasts.at(-1)}`);
    ed.layerClip = null;
  }
  // ⑩ 確認でキャンセル → 何も変わらない
  {
    const { p, ed, rec } = fresh();
    rec.confirm = false;
    const k = idx(p, "#008232");
    await ed.deletePaletteColor("#008232");
    if (p.colorTable[k] !== "#008232" || ed.history.canUndo) why.push("⑩ キャンセルしたのに変わった");
  }
  // ⑪ 透明は対象外・帯に透明の右クリックは付かない
  {
    const { p, ed, rec } = fresh();
    const ct = p.colorTable.slice();
    await ed.deletePaletteColor("");
    if (JSON.stringify(ct) !== JSON.stringify(p.colorTable) || rec.confirms.length) why.push("⑪ 透明で何かが起きた");
    ed.rebuildPalette();
    const tp = el("#ed-pal").children.find((c) => c.classList.contains("tp"));
    if (!tp || tp.listeners.contextmenu?.length) why.push("⑪ 透明に右クリックが付いている");
    const sw = el("#ed-pal").children.find((c) => !c.classList.contains("tp"));
    if (!sw?.listeners.contextmenu?.length) why.push("⑪ 色に右クリックが付いていない");
    if (sw && sw.title !== tt(T, "ed.color.swatch.title", { hex: p.colorTable[1] })) why.push(`⑪ 色の title: ${sw?.title}`);
    for (const pp of el("#ed-paperpal").children) if (pp.listeners.contextmenu?.length) why.push("⑪ 紙の色の列に右クリック");
  }
  // ⑫ 16bit の作品は 16bit のまま（消しても 8bit に戻さない）
  {
    const { p, ed } = fresh({ bits: 16 });
    for (let i = p.colorTable.length; i < 300; i++) p.colorTable.push(`#${(i * 4099).toString(16).padStart(6, "0").slice(-6)}`);
    const hex = p.colorTable[290];
    await ed.deletePaletteColor(hex);
    if (p.colorTable[290] !== "" || p.indexBits !== 16 || !(p.frames[0].layers.A instanceof Uint16Array)) why.push(`⑫ 16bit: [290]=${p.colorTable[290]} bits=${p.indexBits}`);
  }
  // ⑬ 矢印キーでレイヤーを動かしている途中（移動前の絵は番号のまま layerDrag に・800ms 後のタイマーで確定）。
  //    消す色の画素を画面の外へ押し出した状態で調べても、**先に確定してから**調べる＝取り消しの記録として見つかる
  //    （キーボードから右クリックのメニューを出すと、マウスのように押した時点での確定を通らない・レビュー指摘）
  {
    const { p, ed, rec } = fresh();
    const k = idx(p, RED);
    p.frames[0].layers.A[3] = k; // (3, 0)
    ed.tool = "move";
    ed.handleArrowKey({ code: "ArrowLeft", shiftKey: true, preventDefault() {} });
    if (p.frames[0].layers.A.includes(k)) why.push("⑬ 前提: 矢印キーの移動で絵が画面の外へ出ない");
    else if (ed.history.canUndo) why.push("⑬ 前提: 確定する前から履歴に積まれている");
    else {
      await ed.deletePaletteColor(RED);
      if (p.colorTable[k] !== RED || rec.toasts.at(-1) !== tt(T, "ed.color.usedHistory.toast")) why.push(`⑬ 矢印キーの移動の途中: [${k}]=${JSON.stringify(p.colorTable[k])} ${rec.toasts.at(-1)}`);
    }
    ed.endArrowSession();
  }
  return why.length ? ng(why.join("／")) : ok();
}

/** 消しても画素は 1 つも変わらない／保存 → 読み込み（今の版・v1.9.0）で同じ */
async function a99save(T: Tree, readers: { label: string; tree: Tree }[]): Promise<V> {
  const why: string[] = [];
  for (const bits of [8, 16] as const) {
    const rnd = mulberry32(1004 + bits);
    const p = build(T, { frames: 6, layers: 3, bits, loop: true });
    p.colorTable = ["", ...Array.from({ length: bits === 16 ? 320 : 40 }, (_, i) => `#${((i + 1) * 0x10307).toString(16).padStart(6, "0").slice(-6)}`)];
    const used = new Set<number>();
    for (const f of p.frames) {
      f.paper = 1;
      for (const id of Object.keys(f.layers)) {
        const b = f.layers[id];
        for (let i = 0; i < 400; i++) {
          const v = 2 + Math.floor(rnd() * 20) * 2; // 偶数の番号だけ使う＝奇数は使っていない
          b[Math.floor(rnd() * PIXELS)] = v;
          used.add(v);
        }
      }
    }
    const { ed } = makeEd(T, p, 0);
    const shaBefore = shaOf(p.frames.flatMap((f: Any) => Object.values(f.layers)));
    const rgbaBefore = p.frames.map((_: Any, i: number) => shaOf([T.R.compositeFrame(p, i)]));
    const targets = bits === 16 ? [3, 301, 17] : [3, 17, 39];
    const hexes = targets.map((k) => p.colorTable[k]); // 消す前に控える（番号を詰める壊し方でも同じ色を狙う）
    for (const hx of hexes) await ed.deletePaletteColor(hx);
    for (const k of targets) if (p.colorTable[k] !== "") why.push(`${bits}bit: [${k}] が消えていない`);
    const shaAfter = shaOf(p.frames.flatMap((f: Any) => Object.values(f.layers)));
    if (shaBefore !== shaAfter) why.push(`${bits}bit: 消したら画素が変わった`);
    const rgbaAfter = p.frames.map((_: Any, i: number) => shaOf([T.R.compositeFrame(p, i)]));
    if (rgbaBefore.join() !== rgbaAfter.join()) why.push(`${bits}bit: 消したら合成した絵が変わった`);
    const bytes: Uint8Array = await T.S.projectToBytes(p);
    for (const r of readers) {
      try {
        const q = await r.tree.S.projectFromBytes(bytes);
        for (const f of q.frames) await r.tree.SL.wakeFrame(q, f, "read");
        if (JSON.stringify(q.colorTable) !== JSON.stringify(p.colorTable)) why.push(`${bits}bit ${r.label}: colorTable が違う`);
        if (q.indexBits !== bits) why.push(`${bits}bit ${r.label}: indexBits ${q.indexBits}`);
        const shaQ = shaOf(q.frames.flatMap((f: Any) => p.layerDefs.map((d: Any) => f.layers[d.id])));
        const shaP = shaOf(p.frames.flatMap((f: Any) => p.layerDefs.map((d: Any) => f.layers[d.id])));
        if (shaQ !== shaP) why.push(`${bits}bit ${r.label}: 画素が違う`);
        const rgbaQ = q.frames.map((_: Any, i: number) => shaOf([r.tree.R.compositeFrame(q, i)]));
        if (rgbaQ.join() !== rgbaBefore.join()) why.push(`${bits}bit ${r.label}: 合成した絵が違う`);
        if (REPORT) log(`  [A99-4] ${bits}bit ${r.label}: ${bytes.length} B・colorTable ${q.colorTable.length}（空き ${q.colorTable.filter((x: string, i: number) => i > 0 && x === "").length}）・画素一致`);
      } catch (e) {
        why.push(`${bits}bit ${r.label}: 開けない（${String((e as Error)?.message ?? e).slice(0, 120)}）`);
      }
    }
  }
  return why.length ? ng(why.join("／")) : ok();
}

/** this.history.push の棚卸し */
function a99inventory(T: Tree): V {
  const s = sf(T.editorSrc, "editor.ts");
  const sites: { line: number; ok: boolean; what: string }[] = [];
  // 工場で作ったエントリ（変数）: その変数の初期化が bufferChangeEntry / multiBufferChangeEntry
  const factoryVars = new Set<string>();
  const visitVars = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)) {
      const c = n.initializer.expression.getText(s);
      if (c === "bufferChangeEntry" || c === "multiBufferChangeEntry") factoryVars.add(n.name.getText(s));
    }
    ts.forEachChild(n, visitVars);
  };
  visitVars(s);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(s) === "this.history.push") {
      const a = n.arguments[0];
      const line = s.getLineAndCharacterOfPosition(n.getStart(s)).line + 1;
      if (a && ts.isObjectLiteralExpression(a)) {
        const has = a.properties.some((p) => p.name && p.name.getText(s) === "colorRefs");
        sites.push({ line, ok: has, what: "object" });
      } else if (a && ts.isIdentifier(a)) {
        sites.push({ line, ok: factoryVars.has(a.text), what: `var ${a.text}` });
      } else sites.push({ line, ok: false, what: a ? a.getText(s).slice(0, 30) : "?" });
    }
    ts.forEachChild(n, visit);
  };
  visit(s);
  const bad = sites.filter((x) => !x.ok);
  if (REPORT) log(`  [A99-5] this.history.push ${sites.length} か所（object ${sites.filter((x) => x.what === "object").length}・工場 ${sites.filter((x) => x.what !== "object").length}）`);
  // V199 (A-105): 42 → 43。レイヤーの貼り付け（このコマ・範囲・全コマ）を 1 本の pushLayerPasteHistory にまとめ（-1 +1）、
  //  フォルダの控えの「新規レイヤーへ」（pasteFolderToNew）が 1 つ増えた。どれも colorRefs を申告している（下の bad で見る）
  // ★V215 (A-125): 43 → 44。［整理］（tidyPaletteColors・使っていない色をまとめて消す）の取り消しが 1 つ増えた。colorRefs を申告している（下の bad で見る）
  if (sites.length !== 44) return ng(`this.history.push の数が ${sites.length}（V215 時点 44。増えたら colorRefs を申告して数を直す）`);
  if (bad.length) return ng(`colorRefs の申告が無い: ${bad.map((b) => `${b.line}(${b.what})`).join(", ")}`);
  // 工場（history.ts）が申告していること
  const h = fnText(fs.readFileSync(path.join(T.dir, "src/editor/history.ts"), "utf8"), "bufferChangeEntry") ?? "";
  const m = fnText(fs.readFileSync(path.join(T.dir, "src/editor/history.ts"), "utf8"), "multiBufferChangeEntry") ?? "";
  if (!/colorRefs:/.test(h) || !/colorRefs:/.test(m)) return ng("bufferChangeEntry / multiBufferChangeEntry が colorRefs を申告していない");
  return ok();
}

// =====================================================================================
// 走らせる
// =====================================================================================
const CHECKS: { id: string; fn: (T: Tree) => Promise<V> | V }[] = [
  { id: "A96-1", fn: a96pure },
  { id: "A96-2", fn: a96editor },
  { id: "A96-3", fn: (T) => a96libProject(T) },
  { id: "A96-4", fn: (T) => a96libNote(T) },
  { id: "A97-1", fn: a97goto },
  { id: "A97-2", fn: a97entries },
  { id: "A97-3", fn: a97drag },
  { id: "A97-4", fn: a97static },
  { id: "A98-1", fn: (T) => a98pure(T, stageEd(T).ed) },
  { id: "A98-2", fn: a98stage },
  { id: "A98-3", fn: a98static },
  { id: "A98-4", fn: a98fit },
  { id: "A98b", fn: a98hud },
  { id: "A99-1", fn: a99pure },
  { id: "A99-2", fn: a99scan },
  { id: "A99-3", fn: a99editor },
  { id: "A99-5", fn: a99inventory },
];

const cur = await loadTree(root, "今");
for (const c of CHECKS) {
  const r = await safe(() => c.fn(cur));
  check(`[${c.id}]`, r.ok, r.why);
}
// [A99-4] 今の版と v1.9.0 の読み手
const v190dir = path.join(WORK, "v190");
exportRev("v1.9.0", v190dir);
const v190 = await loadTree(v190dir, "v1.9.0", { pure: true });
{
  const r = await safe(() => a99save(cur, [{ label: "今の読み手", tree: cur }, { label: "v1.9.0 の読み手", tree: v190 }]));
  check("[A99-4] 消しても画素は変わらない・保存→読み込み（今・v1.9.0）で同じ", r.ok, r.why);
}

// [A96-0] [A97-0] 赤先行: V195 の前の editor.ts / library.ts では赤。
// ★基準は V195 の親 `73f8d7b` に固定（HEAD だと V195 をコミットした時点で必ず緑になる＝v193_smoke の BASE と同じ作法）
{
  const headDir = path.join(WORK, "head");
  exportRev("73f8d7b", headDir);
  const head = await loadTree(headDir, "V195 の前");
  const ps = cur.PS.playStartFrame;
  const r1 = await safe(() => a96editor(head));
  check("[A96-0] V195 の前の編集画面は最後のコマの ▶ で先頭へ戻らない（この検査が BUG-003 を捕まえる）", !r1.ok && !r1.threw, r1.why || "緑になった");
  const r2 = await safe(() => a96libProject(head, libToggle(head.libSrc, ps)));
  check("[A96-0] V195 の前のライブラリ .memoanima も赤", !r2.ok && !r2.threw, r2.why || "緑になった");
  const r3 = await safe(() => a96libNote(head, libToggle(head.libSrc, ps)));
  check("[A96-0] V195 の前のライブラリ .kwz も赤", !r3.ok && !r3.threw, r3.why || "緑になった");
  const r4 = await safe(() => a97goto(head));
  check("[A97-0] V195 の前の gotoFrame は再生を止めない（この検査が BUG-004 を捕まえる）", !r4.ok && !r4.threw, r4.why || "緑になった");
  if (REPORT) log(`  [赤先行] A96 編集画面: ${r1.why}\n  [赤先行] A96 .memoanima: ${r2.why}\n  [赤先行] A96 .kwz: ${r3.why}\n  [赤先行] A97: ${r4.why}`);
}

// [S-0] と [X] 反証
interface Mut {
  id: string;
  what: string;
  edits: Edit[];
  checks: string[];
}
const MUTS: Mut[] = [
  { id: "X1", what: "編集画面の ▶ で playStartFrame を呼ばない", checks: ["A96-2"], edits: [{ file: ED, from: "    if (at !== this.frameIndex) this.gotoFrame(at);\n", to: "" }] },
  { id: "X2", what: "ライブラリ .memoanima の巻き戻しを消す", checks: ["A96-3"], edits: [{ file: "src/library.ts", from: "          if (at !== this.previewFrame) {\n            this.previewFrame = at;", to: "          if (false) {\n            this.previewFrame = at;" }] },
  { id: "X3", what: "ライブラリ .kwz の setCurrentFrame(at) を消す", checks: ["A96-4"], edits: [{ file: "src/library.ts", from: "            p.setCurrentFrame(at);\n", to: "" }] },
  { id: "X4", what: "playStartFrame の条件を「最後のコマ」から外す", checks: ["A96-1", "A96-2"], edits: [{ file: "src/editor/playStart.ts", from: "cur === count - 1", to: "cur === count" }] },
  { id: "X5", what: "gotoFrame の入口で止めない", checks: ["A97-1", "A97-2"], edits: [{ file: ED, from: "    if (this.playing) this.stopPlayback();\n    if (i < 0 || i >= this.project.frames.length) return;", to: "    if (i < 0 || i >= this.project.frames.length) return;" }] },
  { id: "X6", what: "gotoFrame で ⏸（pause）にする", checks: ["A97-1"], edits: [{ file: ED, from: "    if (this.playing) this.stopPlayback();\n    if (i < 0 || i >= this.project.frames.length) return;", to: "    if (this.playing) this.stopPlayback(true);\n    if (i < 0 || i >= this.project.frames.length) return;" }] },
  { id: "X7", what: "gotoFrame の止めを範囲外の return の後ろへ", checks: ["A97-2", "A97-4"], edits: [{ file: ED, from: "    if (this.playing) this.stopPlayback();\n    if (i < 0 || i >= this.project.frames.length) return;", to: "    if (i < 0 || i >= this.project.frames.length) return;\n    if (this.playing) this.stopPlayback();" }] },
  { id: "X8", what: "並べ替えの開始で止めない", checks: ["A97-3"], edits: [{ file: ED, from: "      this.suppressFrameClick = true;\n      // ★V195 (A-97): 再生中に並べ替えを始めたら**先に止める**（gotoFrame と同じ止め方）。\n      //  クリックで終わるときは click → gotoFrame が止めるので、ここは「掴んだ」と決まった瞬間だけ\n      if (this.playing) this.stopPlayback();", to: "      this.suppressFrameClick = true;" }] },
  { id: "X9", what: "呼び出し元（◀）にも stopPlayback を散らす", checks: ["A97-4"], edits: [{ file: ED, from: '$("#ed-prev").addEventListener("click", () => this.gotoFrame(this.frameIndex - 1));', to: '$("#ed-prev").addEventListener("click", () => { this.stopPlayback(); this.gotoFrame(this.frameIndex - 1); });' }] },
  { id: "X10", what: "余白の箱を 2px 大きくする（真ん中より外へ動ける）", checks: ["A98-1"], edits: [{ file: "src/editor/stagePan.ts", from: "  const sizerW = vw + 2 * L;", to: "  const sizerW = vw + 2 * L + 2;" }] },
  { id: "X11", what: "回転のときの絵の箱の位置を直さない", checks: ["A98-1", "A98-2"], edits: [{ file: "src/editor/stagePan.ts", from: "  const wrapLeft = L + vw / 2 - cw / 2 - border;", to: "  const wrapLeft = L - border;" }] },
  { id: "X12", what: "倍率を変えるとき控えた点を使わない（いつも絵の真ん中）", checks: ["A98-2"], edits: [{ file: ED, from: "    const s = scrollFor(g, anchor ?? { x: W / 2, y: H / 2 });", to: "    const s = scrollFor(g, { x: W / 2, y: H / 2 });" }] },
  { id: "X13", what: "パンの間の回転で置き直さない", checks: ["A98-2"], edits: [{ file: ED, from: '    if (this.zoomMode !== "fit" && !this.previewLarge) this.applyZoom();\n    else this.applyViewTransform();', to: "    this.applyViewTransform();" }] },
  { id: "X28", what: "V195b: 余白の条件を旧い「全体表示でないとき」に戻す", checks: ["A98-2", "A98-4"], edits: [{ file: ED, from: '    const pan = this.zoomMode !== "fit" && !this.previewLarge && panNeeded(z, availW, availH, this.viewRot);', to: '    const pan = this.zoomMode !== "fit" && !this.previewLarge;' }] },
  { id: "X29", what: "V195b: 境目の物差しを availW（−40）でなく窓そのものにする", checks: ["A98-4"], edits: [{ file: ED, from: "    this.layoutPan(z, anchor, availW, availH);", to: "    this.layoutPan(z, anchor, stage.clientWidth, stage.clientHeight);" }] },
  { id: "X30", what: "V195b: 回転で置き直すのをパンの間だけにする（収まる → はみ出すを見落とす）", checks: ["A98-4"], edits: [{ file: ED, from: '    if (this.zoomMode !== "fit" && !this.previewLarge) this.applyZoom();\n    else this.applyViewTransform();', to: "    if (this.panGeom) this.applyZoom();\n    else this.applyViewTransform();" }] },
  { id: "X31", what: "V195b: 大画面の間に収まっても控えた点を捨てない", checks: ["A98-4"], edits: [{ file: ED, from: '      this.panHeld = this.previewLarge && this.zoomMode !== "fit" ? anchor : null;', to: '      this.panHeld = this.zoomMode !== "fit" ? anchor ?? this.panHeld : null;' }] },
  { id: "X14", what: "visualToCanvas の 90° を取り違える", checks: ["A98-1"], edits: [{ file: "src/editor/stagePan.ts", from: "    case 90:\n      u = ny;\n      v = 1 - nx;", to: "    case 90:\n      u = 1 - ny;\n      v = nx;" }] },
  { id: "X15", what: "「隠す」でボタン列を畳まない", checks: ["A98b"], edits: [{ file: ED, from: '    right?.classList.toggle("hud-collapsed", this.hudHidden);\n', to: "" }] },
  { id: "X16", what: "眠っている控えを見ない", checks: ["A99-2", "A99-3"], edits: [{ file: "src/editor/colorUsage.ts", from: "    } else asleep.push(id);", to: "    }" }] },
  { id: "X16b", what: "同じ中身の控えを目印だけで決める（バイトを比べない）", checks: ["A99-2"], edits: [{ file: "src/editor/colorUsage.ts", from: "x.bits === bits && sameBytes(x.z, z)", to: "x.bits === bits" }] },
  { id: "X17", what: "取り消しの記録を見ない", checks: ["A99-2", "A99-3"], edits: [{ file: "src/editor/colorUsage.ts", from: "  scan: for (const e of src.history) {", to: "  scan: for (const e of src.history.slice(0, 0)) {" }] },
  { id: "X18", what: "紙を見ない", checks: ["A99-2", "A99-3"], edits: [{ file: "src/editor/colorUsage.ts", from: "  if (slots.includes(f.paper)) return true;\n", to: "" }] },
  { id: "X19", what: "コピー中の絵を見ない", checks: ["A99-2", "A99-3"], edits: [{ file: "src/editor/colorUsage.ts", from: "  for (const b of src.clips) if (b && bufHasAny(b, slots, b instanceof Uint8Array)) use.clip = true;", to: "" }] },
  { id: "X20", what: "網を外す（申告なしを「使っていない」にする）", checks: ["A99-2"], edits: [{ file: "src/editor/history.ts", from: "  if (e.colorRefs) return false;\n", to: "  if (e.colorRefs || true) return false;\n" }] },
  { id: "X21", what: "bufferChangeEntry が申告しない（網で全部「分からない」→ 関係ない描画があると消せない）", checks: ["A99-3", "A99-5"], edits: [{ file: "src/editor/history.ts", from: "    colorRefs: () => ({ bufs: [before, after] }), // V195 (A-99): 抱えている画素も自動で申告\n", to: "" }] },
  { id: "X22", what: "コマ削除の申告を NO_COLOR_REFS に（嘘の申告）", checks: ["A99-3"], edits: [{ file: ED, from: "      colorRefs: () => ({ frames: removed }), // V195 (A-99)", to: "      colorRefs: NO_COLOR_REFS, // V195 (A-99)" }] },
  { id: "X23", what: "紙色の記録の申告を消す（網に掛からない小さいエントリ）", checks: ["A99-3", "A99-5"], edits: [{ file: ED, from: "      colorRefs: () => ({ papers: [oldPaper, newPaper] }), // V195 (A-99)\n", to: "" }] },
  { id: "X24", what: "消すときに番号を詰める（splice）", checks: ["A99-3", "A99-4"], edits: [{ file: ED, from: '      for (const k of slots) project.colorTable[k] = toEmpty ? "" : hex;', to: "      if (toEmpty) for (const k of [...slots].reverse()) project.colorTable.splice(k, 1);\n      else for (const k of slots) project.colorTable.splice(k, 0, hex);" }] },
  { id: "X25", what: "帯に空き番号（\"\"）を出す", checks: ["A99-3"], edits: [{ file: ED, from: "      if (!hex || shown.has(hex)) return false;", to: "      if (shown.has(hex)) return false;" }] },
  { id: "X26", what: "使っていても確認を出して消す（判定を見ない）", checks: ["A99-3"], edits: [{ file: ED, from: '    if (verdict === "frames") {', to: '    if (verdict === "frames" && false) {' }] },
  { id: "X27", what: "消す前に矢印キーの移動を確定しない", checks: ["A99-3"], edits: [{ file: ED, from: "    this.endArrowSession();\n    if (this.xformGuard()) return; // 変形中の浮いた絵（番号のまま）を抱えたまま空けない", to: "    if (this.xformGuard()) return; // 変形中の浮いた絵（番号のまま）を抱えたまま空けない" }] },
];
{
  // [S-0] 無改変の写し
  const { tree } = await mutant([]);
  const ids = [...new Set(MUTS.flatMap((m) => m.checks))];
  const bad: string[] = [];
  for (const id of ids) {
    const c = id === "A99-4" ? { fn: (T: Tree) => a99save(T, [{ label: "写し", tree: T }]) } : CHECKS.find((x) => x.id === id)!;
    const r = await safe(() => c.fn(tree!));
    if (!r.ok) bad.push(`${id}: ${r.why}`);
  }
  check("[S-0] 無改変の写しで反証が使う検査が全部緑", bad.length === 0, bad.join("／"));
}
const xRows: string[] = [];
for (const m of MUTS) {
  const { tree, why } = await mutant(m.edits);
  if (!tree) {
    check(`[${m.id}] ${m.what}`, false, why);
    continue;
  }
  const reds: string[] = [];
  for (const id of m.checks) {
    const c = id === "A99-4" ? { fn: (T: Tree) => a99save(T, [{ label: "写し", tree: T }]) } : CHECKS.find((x) => x.id === id)!;
    const r = await safe(() => c.fn(tree));
    if (!r.ok && !r.threw) reds.push(`${id}: ${r.why.slice(0, 140)}`);
    else if (r.threw) reds.push(`(例外・赤に数えない) ${id}: ${r.why.slice(0, 200)}`);
  }
  const real = reds.filter((r) => !r.startsWith("(例外"));
  check(`[${m.id}] 反証「${m.what}」→ 赤`, real.length === m.checks.length, `赤 ${real.length}/${m.checks.length}: ${reds.join("／")}`);
  xRows.push(`| ${m.id} | ${m.what} | ${real.map((r) => r.split(":")[0]).join("・")} | ${real.length}/${m.checks.length} |`);
}
if (REPORT) {
  log("\n| # | 壊し方 | 赤になった検査 | 赤 |\n|---|---|---|---|");
  for (const r of xRows) log(r);
}
console.log(`\nv195 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
