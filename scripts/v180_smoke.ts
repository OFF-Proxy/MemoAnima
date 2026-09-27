// V180（取り消しの不具合 2 件 A-78）の回帰ゲート。引数不要:
//   npx tsx scripts/v180_smoke.ts
//
// ① 歪みを取り消すと、コマを移っていれば**いま見ているコマ**へ書き戻していた（別のコマの絵が壊れる）
// ② 大きい作品で、窓の外へ出て**眠ったコマ**の Ctrl+Z / Ctrl+Y が黙って空振りしていた
//    （履歴は 1 つ戻るのに絵は戻らない＝取り消したつもりの線が残る。その履歴はやり直し側へ移るので二度と戻せない）
// ③ Ctrl+Z の押しっぱなし（同じ瞬間に 2 回）で、眠ったコマの取り消しが**両方とも**消えていた
//    （V180 で実測: 2 回とも一番上の `prepare` を待ち、同じコマを 2 か所から起こして、先に戻した絵を
//     古い控えで上書きした。2 回目は下のエントリを起こさずに走らせて空振り）
//
// ★見方は V178 と同じ: **本物の editor.ts を Node で動かす**。`Editor` を new して、道具・コマンドの本物の口
//  （onPointerDown/Move/Up・deleteSelection・copySelection・beginTransform・clearFrame…）を叩き、
//  取り消し・やり直しは**画面と同じ入口**（handleUndo / handleRedo）から入れる。見るのは**画素と履歴**。
//  禁止の言葉を並べる形（denylist）にはしない。DOM は最小の偽物だけ・画面の描き直しは数えるだけ。
//  眠りは本物の sleep.ts（gzip）で起こす／眠らせる。
//
// ★反証は**実ファイルを書き換えた写し**で走らせる（V177・V178 と同じ流儀）。写しは `node_modules/.v180-smoke/`
//  の下（npm の部品が見える場所）。書き換えは**ちょうど 1 か所に当たる**こと。**例外で落ちた反証は「効いた」と数えない**。
//
// [S-1]  ★歪み: コマ 0 で歪ませ、コマ 5 へ移って Ctrl+Z → コマ 5 は 1 画素も変わらず、コマ 0 が戻る
//        （サムネもコマ 0 を塗る）。Ctrl+Y でコマ 0 に歪みが戻る
// [S-2]  ★操作ごとの表: 操作したコマを**眠らせてから** Ctrl+Z → 起こすと元の絵・Ctrl+Y → 操作後の絵。
//        いま見ているコマは 1 画素も変わらない・眠りの網（古い控えのログ）が 1 回も鳴らない・
//        保存した直後の Ctrl+Z / Ctrl+Y で未保存の印（dirty）が立つ（Codex 1 回目の穴）・画面を描き直す・
//        （手組みでない行は）塗り直すサムネが操作したコマだけ
// [S-2b] ページ貼り付け（手組み・prepare なし）は眠ったコマでも戻る（取り消しがバッファごと差し替える＝対象外の根拠）
// [S-3]  ★`bufferChangeEntry` / `multiBufferChangeEntry` を**呼ぶ所の数＝`prepare` を付ける所の数**（構文木で数える）。
//        さらに呼ぶ所（関数）と [S-2] の表の行が 1 対 1 に対応する（新しい操作は表にも行を足す）
// [S-4]  小さい作品（眠りなし）では、画素・履歴の深さ・塗り直すサムネが**この回の前の editor.ts とビット単位で同じ**
//        （固定値＋取り出した旧版）。`wakeFrame` は 1 回の取り消し／やり直しにつき、その操作のコマへ 1 回だけ
// [S-5]  コマ番号で持つ所（四隅変形・レイヤーの移動・複写・新規レイヤーへ）は、そのコマが無くても例外を投げない
// [S-6]  ★連打: 眠ったコマ 2 つ（3 つ）に 1 回ずつ操作 → **同じ瞬間に** Ctrl+Z を 2 回（3 回）→ 全部戻る。Ctrl+Y も。
//        同じ瞬間の Z・Z・Y は押した順に 1 つずつ効く（取り消しとやり直しは 1 本の列）
// [S-6b] 1 回の取り消しが失敗しても列は止まらない・失敗は未処理の拒否として外へ出る（握り潰さない）
// [S-0]  無改変の写しでは全部緑（写しの仕組みが赤を作っていない）
// [S-R]  反証（わざと壊した写しで赤くなること）
//
// ⚠ 新しく「1 コマの絵を書き換える履歴」を足すときは、V178 と同じ形で書くこと:
//     const entry = multiBufferChangeEntry(…);             // または bufferChangeEntry(…)
//     entry.prepare = () => wakeFrame(this.project, <そのコマ>, "write");
//   [S-3] は **この形（呼んだ結果を名前で受け、同じ関数の中で `<名前>.prepare = …`）だけ**を数える。
//   そのうえで [S-2] の表（ROWS）に行を足す（呼ぶ関数の名前を `site` に書く）。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

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

// ================= 未処理の拒否を記録する（[S-5] が見る・ほかの検査でも出たら理由に添える） =================
const rejections: string[] = [];
process.on("unhandledRejection", (r) => {
  rejections.push(String((r as Error)?.message ?? r).slice(0, 120));
});

// ================= 本物の editor.ts を Node で動かすための最小の舞台 =================
const G = globalThis as unknown as Record<string, unknown>;
G.self = G; // exporter.ts が読む gif.js（ブラウザ前提・self 参照）
G.window = G; // editor.ts の window.setTimeout 等
G.devicePixelRatio = 1;
/** 何を呼ばれても何もしない 2D 文脈（オーバーレイ・変形の下書きは画素の検査に関係しない） */
const NOOP_CTX = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === "createImageData"
        ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
        : () => {},
    set: () => true,
  }
);
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
const CURSOR_CV = { width: 0, height: 0, hidden: true, getContext: () => NOOP_CTX };
const OVERLAY_CV = { width: 320, height: 240, style: {}, getContext: () => NOOP_CTX };
G.document = {
  querySelector: (sel: string) =>
    sel === "#ed-canvas"
      ? CANVAS
      : sel === "#ed-cursor"
        ? CURSOR_CV
        : sel === "#ed-cvwrap"
          ? CVWRAP
          : sel === "#ed-overlay"
            ? OVERLAY_CV
            : null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => NOOP_CTX }),
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
  S: Mod;
  FC: Mod;
}
async function loadTree(dir: string, label: string): Promise<Tree> {
  const u = (p: string) => pathToFileURL(path.join(dir, p)).href;
  const E = await import(u("src/editor/editor.ts"));
  const M = await import(u("src/editor/model.ts"));
  const S = await import(u("src/editor/sleep.ts"));
  const FC = await import(u("src/editor/frameClip.ts"));
  return { label, dir, Editor: E.Editor, M, S, FC };
}

// ================= 写し（無改変・旧版・計器つき・反証）の置き場 =================
// 既定は node_modules/.v180-smoke/<pid>（git の外・npm の部品が見える）。
// サンドボックスで node_modules へ書けないときは環境変数 V180_SMOKE_WORK で差し替える
// （**その祖先に node_modules があること**＝部品を解決するため）
const WORK = path.join(
  process.env.V180_SMOKE_WORK || path.join(root, "node_modules", ".v180-smoke"),
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
/** 作業ツリーの src/ の .ts だけを写す */
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
/** 書き換えを当てる。**ちょうど 1 か所**に当たらなければ理由を返す */
function applyEdits(dir: string, edits: Edit[]): string {
  for (const e of edits) {
    const f = path.join(dir, e.file);
    const text = fs.readFileSync(f, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const from = e.from.replace(/\n/g, eol);
    const n = text.split(from).length - 1;
    if (n !== 1) return `書き換えが当たらない（${n} 箇所）: ${e.from.trim().slice(0, 70)}`;
    fs.writeFileSync(f, text.replace(from, () => e.to.replace(/\n/g, eol)));
  }
  return "";
}
/** ★計器: sleep.ts の `wakeFrame` が呼ばれるたびに（コマ・起こし方）を記録する。**sleep.ts 本体は触らない**——
 *  写しの中だけに 1 行足す（[S-4] が「取り消し 1 回につき、その操作のコマへ 1 回だけ」を数えるため） */
const WAKE_PROBE: Edit = {
  file: "src/editor/sleep.ts",
  from: 'export async function wakeFrame(p: Project, f: Frame, mode: "read" | "write"): Promise<void> {\n',
  to:
    'export async function wakeFrame(p: Project, f: Frame, mode: "read" | "write"): Promise<void> {\n' +
    "  ((globalThis as any).__v180Wake ??= []).push({ f, mode, hadSleep: !!f?.sleep });\n",
};
let seq = 0;
/** src/ を写して `edits` を当てた木を読み込む（`probe` なら計器も付ける） */
async function mutant(edits: Edit[], probe = false): Promise<{ tree: Tree | null; why: string }> {
  const dir = path.join(WORK, `m${++seq}`);
  copySrc(dir);
  const why = applyEdits(dir, probe ? [WAKE_PROBE, ...edits] : edits);
  if (why) return { tree: null, why };
  return { tree: await loadTree(dir, `m${seq}`), why: "" };
}

// ================= 道具 =================
const W = 320;
const H = 240;
const PIXELS = W * H;
const bytesOf = (b: Buf) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const same = (a: Buf | undefined, b: Buf | undefined) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const diffCount = (a: Buf, b: Buf) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};
const snap = (p: Mod, fi: number): Record<string, Buf> =>
  Object.fromEntries(Object.entries(p.frames[fi].layers as Record<string, Buf>).map(([k, v]) => [k, v.slice()]));
/** 全コマ・全レイヤー（起きている分）の指紋。レイヤー名の順に並べる */
const shaAll = (p: Mod) => {
  const h = crypto.createHash("sha256");
  for (const f of p.frames as Mod[]) {
    for (const id of Object.keys(f.layers).sort()) {
      h.update(id);
      h.update(bytesOf(f.layers[id]));
    }
    h.update(`|${f.paper}|`);
  }
  return h.digest("hex").slice(0, 16);
};
const rectMask = (x0: number, y0: number, x1: number, y1: number) => {
  const m = new Uint8Array(PIXELS);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const immediate = () => new Promise((r) => setImmediate(r));
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 作りものの作品。レイヤー A・B・C に**コマとレイヤーで位相のずれた縞**を描く
 *  （どのコマの絵がどこへ書き戻されたか分かる・歪みや移動で画素が必ず動く） */
function build(T: Tree, frames: number): Mod {
  const p = T.M.newProject("v180");
  const paper = p.frames[0].paper;
  p.layerDefs = ["A", "B", "C"].map((id) => ({ id, name: id, visible: true, opacity: 1 }));
  p.folders = [];
  p.nextLayerId = 1000;
  p.frames = [];
  for (let i = 0; i < frames; i++) {
    const f: Mod = { paper, layers: {} };
    ["A", "B", "C"].forEach((id, li) => {
      const b = T.M.allocIndexBuf(p);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) if (((x >> 3) + (y >> 3) + i + li) % 3 === 0) b[y * W + x] = li + 1;
      f.layers[id] = b;
    });
    p.frames.push(f);
  }
  return p;
}

interface Log {
  toasts: string[];
  thumbs: number[];
  renders: number;
  stale: number;
}
/** 本物の Editor を作って作品と道具を持たせる（mount は DOM を組むので通さない）。
 *  画面の描き直しは数えるだけ・DOM を組み直すだけの口は止める（画素にも履歴にも触らない口だけ） */
function makeEd(T: Tree, p: Mod, frame = 1) {
  const ed = new T.Editor();
  const log: Log = { toasts: [], thumbs: [], renders: 0, stale: 0 };
  ed.cb = { toast: (m: string) => void log.toasts.push(m), appendLog: () => {} };
  ed.project = p;
  ed.frameIndex = frame;
  ed.activeLayerId = "B";
  ed.tool = "pen";
  ed.mounted = true;
  ed.lastLockToastAt = -1e9;
  ed.cursorLive = false;
  ed.renderCanvas = () => void log.renders++;
  ed.paintFilmThumb = (i: number) => void log.thumbs.push(i);
  ed.rebuildFilm = () => {};
  for (const k of [
    "rebuildLayers",
    "updateSizeMeter",
    "paintUiOverlay",
    "buildToolOptions",
    "updateToolButtons",
    "updateFilmSeMarks",
    "refreshSelectionLauncher",
  ])
    ed[k] = () => {};
  // 眠りの網（「古い控えを捨てた」ログ）が鳴った回数。書きで起こしていれば鳴らない
  T.S.setStaleSleepLogger(() => void log.stale++);
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
type Pt = [number, number];
/** 押す→動かす→離す（本物のハンドラへ） */
function stroke(ed: Mod, pts: Pt[]) {
  ed.onPointerDown(ev(pts[0][0], pts[0][1]));
  for (const [x, y] of pts.slice(1)) ed.onPointerMove(ev(x, y));
  const [lx, ly] = pts[pts.length - 1];
  ed.onPointerUp(ev(lx, ly, { buttons: 0, pressure: 0 }));
}
const PATH: Pt[] = [
  [40, 60],
  [100, 95],
  [160, 130],
  [220, 110],
  [280, 150],
];
/** 取り消し・やり直しが**走り終わる**まで待つ（`mutations` が target に届くまで）。
 *  届いたあとも少し待つ——並走した起こしが遅れて古い控えを書き戻す形（③）も拾うため */
async function settle(ed: Mod, target: number) {
  const t0 = Date.now();
  while (ed.history.mutations < target && Date.now() - t0 < 3000) await immediate();
  // gunzip はスレッドプールで 1 枚 1 ms 未満。20 ms 待てば並走した起こしは必ず着地している
  //（setTimeout の細かい刻みは Windows で約 15 ms に丸められて遅いので、刻まずに 1 回だけ待つ）
  await tick(20);
}
/** Ctrl+Z / Ctrl+Y と同じ入口（↶↷ ボタン・ショートカットの表の edit.undo / edit.redo が呼ぶ口） */
async function undo(ed: Mod) {
  const m = ed.history.mutations;
  ed.handleUndo();
  await settle(ed, m + 1);
}
async function redo(ed: Mod) {
  const m = ed.history.mutations;
  ed.handleRedo();
  await settle(ed, m + 1);
}

// ================= 操作の表（[S-2]・[S-4] が使う・[S-3] と突き合わせる） =================
interface Row {
  id: string;
  /** 積まれたエントリのラベル（別の経路を測っていないことの確認） */
  label: string;
  /** `bufferChangeEntry` / `multiBufferChangeEntry` を呼ぶ関数（[S-3] の構文木と 1 対 1）。
   *  手組みの履歴（object を直に push）は "手組み:" を付ける＝[S-3] の数え上げの外（[S-2] の表だけで守る） */
  site: string;
  run: (ed: Mod, p: Mod) => Promise<void> | void;
}
const SEL = () => rectMask(40, 40, 140, 120);
const ROWS: Row[] = [
  { id: "描画（ペン）", label: "描画", site: "pushBufferHistory", run: (ed) => stroke(ed, PATH) },
  { id: "塗り", label: "塗り", site: "pushBufferHistory", run: (ed) => ((ed.tool = "fill"), stroke(ed, [[5, 5]])) },
  {
    id: "選択の移動（合成エントリ）",
    label: "選択移動",
    site: "pushBufferHistory",
    run: (ed) => {
      ed.tool = "move";
      ed.selMask = SEL();
      stroke(ed, [
        [80, 80],
        [100, 90],
        [120, 100],
      ]);
    },
  },
  {
    id: "切り取り（合成エントリ）",
    label: "切り取り",
    site: "pushBufferHistory",
    run: (ed) => ((ed.selMask = SEL()), ed.copySelection(true)),
  },
  {
    id: "選択部分を消去",
    label: "選択部分を消去",
    site: "pushBufferHistory",
    run: (ed) => ((ed.selMask = SEL()), ed.deleteSelection()),
  },
  {
    id: "四隅変形",
    label: "四隅変形",
    site: "commitCornerWarpInner",
    run: (ed) => {
      ed.tool = "warp";
      ed.warpMode = "corner";
      ed.beginCornerWarp();
      const r = ed.cornerRect;
      ed.cornerPts = [
        { x: r.x0 + 30, y: r.y0 + 20 },
        { x: r.x1, y: r.y0 },
        { x: r.x1, y: r.y1 },
        { x: r.x0, y: r.y1 },
      ];
      ed.updateCornerPreview();
      ed.commitCornerWarpInner();
    },
  },
  {
    id: "歪み",
    label: "歪み",
    site: "onPointerUp",
    run: (ed) => {
      ed.tool = "warp";
      ed.warpMode = "push";
      stroke(ed, [
        [100, 100],
        [130, 110],
        [160, 120],
        [190, 125],
      ]);
    },
  },
  {
    id: "レイヤーの移動",
    label: "レイヤーの移動",
    site: "commitLayerMove",
    run: (ed) => {
      ed.tool = "move";
      stroke(ed, [
        [100, 100],
        [110, 105],
        [123, 111],
      ]);
    },
  },
  {
    id: "変形（合成エントリ）",
    label: "変形",
    site: "commitTransformInner",
    run: (ed) => {
      ed.selMask = SEL();
      ed.tool = "transform";
      ed.beginTransform();
      ed.xform.tx = 17;
      ed.xform.ty = 9;
      ed.commitTransformInner();
    },
  },
  {
    id: "消す",
    label: "消す",
    site: "clearFrame",
    run: async (ed) => {
      ed.confirmWithSkip = async () => true;
      await ed.clearFrame();
    },
  },
  {
    id: "消しゴム（全レイヤー）",
    label: "消しゴム（全レイヤー）",
    site: "commitEraseAll",
    run: (ed) => {
      ed.tool = "eraser";
      ed.setEraseAllLayers(true);
      stroke(ed, PATH);
      ed.setEraseAllLayers(false);
    },
  },
  { id: "複写（手組み）", label: "複写", site: "手組み:copyPrevFrame", run: (ed) => ed.copyPrevFrame() },
  {
    id: "切り取って新規レイヤー（手組み）",
    label: "切り取って新規レイヤー",
    site: "手組み:selectionToNewLayer",
    run: (ed) => ((ed.selMask = SEL()), ed.selectionToNewLayer(true)),
  },
  {
    id: "コピーして新規レイヤー（手組み）",
    label: "コピーして新規レイヤー",
    site: "手組み:selectionToNewLayer",
    run: (ed) => ((ed.selMask = SEL()), ed.selectionToNewLayer(false)),
  },
];

// ================= [S-1] 歪みはコマを移ってからの Ctrl+Z でも、歪ませたコマへ書き戻す =================
async function checkS1(T: Tree): Promise<V> {
  const p = build(T, 8);
  const { ed, log } = makeEd(T, p, 0);
  const pre0 = snap(p, 0);
  const pre5 = snap(p, 5);
  ed.tool = "warp";
  ed.warpMode = "push";
  stroke(ed, [
    [100, 100],
    [130, 110],
    [160, 120],
    [190, 125],
  ]);
  const post0 = snap(p, 0);
  const moved = Object.keys(pre0).reduce((n, k) => n + diffCount(pre0[k], post0[k]), 0);
  if (moved === 0) return ng("前提: 歪みで 1 画素も動いていない（検査が黙る）");
  if (ed.history.peekUndo()?.label !== "歪み") return ng(`前提: 積まれたのが「歪み」でない（${ed.history.peekUndo()?.label}）`);
  ed.frameIndex = 5; // 矢印キーなどでコマを移った（コマの移動は履歴に入らない）
  log.thumbs.length = 0;
  await undo(ed);
  for (const k of Object.keys(pre5)) {
    const d = diffCount(pre5[k], p.frames[5].layers[k]);
    if (d) return ng(`★Ctrl+Z がいま見ているコマ（5）の ${k} を ${d} 画素書き換えた`);
  }
  for (const k of Object.keys(pre0))
    if (!same(p.frames[0].layers[k], pre0[k])) return ng(`★Ctrl+Z で歪ませたコマ（0）の ${k} が戻らない`);
  if (!log.thumbs.includes(0) || log.thumbs.includes(5))
    return ng(`★取り消しのあとに塗り直したサムネが違う（${JSON.stringify(log.thumbs)}・コマ 0 だけのはず）`);
  log.thumbs.length = 0;
  await redo(ed);
  for (const k of Object.keys(pre0))
    if (!same(p.frames[0].layers[k], post0[k])) return ng(`★Ctrl+Y でコマ 0 の ${k} に歪みが戻らない`);
  for (const k of Object.keys(pre5))
    if (!same(p.frames[5].layers[k], pre5[k])) return ng(`★Ctrl+Y がいま見ているコマ（5）の ${k} を書き換えた`);
  if (!log.thumbs.includes(0) || log.thumbs.includes(5))
    return ng(`★やり直しのあとに塗り直したサムネが違う（${JSON.stringify(log.thumbs)}）`);
  return ok();
}

// ================= [S-2] 眠ったコマの Ctrl+Z / Ctrl+Y（操作ごと） =================
const OPF = 1; // 操作するコマ
const VIEW = 10; // 移った先（窓の外＝操作したコマが眠る距離）
async function checkS2Row(T: Tree, r: Row): Promise<V> {
  const p = build(T, 12);
  const { ed, log } = makeEd(T, p, OPF);
  ed.sleepOn = true;
  const pre = snap(p, OPF);
  const view = snap(p, VIEW);
  const d0 = ed.history.undoDepth;
  await r.run(ed, p);
  const post = snap(p, OPF);
  if (ed.history.undoDepth !== d0 + 1) return ng(`前提: 履歴が ${ed.history.undoDepth - d0} 増えた（1 のはず）`);
  const top = ed.history.peekUndo();
  if (top?.label !== r.label) return ng(`前提: 積まれたのが「${r.label}」でない（${top?.label}）`);
  const changed = Object.keys(post).some((k) => !same(pre[k], post[k]));
  if (!changed) return ng("前提: 操作で絵が変わっていない（検査が黙る）");
  // コマを移った（選択はコマの移動で外れる）→ 操作したコマが眠る
  ed.selMask = null;
  ed.frameIndex = VIEW;
  const f = p.frames[OPF];
  await T.S.sleepFrame(p, f, new Set());
  if (!T.S.frameHasAsleep(f)) return ng("前提: 操作したコマが眠っていない（検査が黙る）");
  const has = top.prepare ? "あり" : "なし";
  /** 取り消し／やり直しのあと: 画面を描き直した・（手組みでない行は）塗り直したサムネが**操作したコマだけ**（①と同じ目） */
  const repainted = (what: string): V => {
    if (log.renders === 0) return ng(`★${what}のあとに画面を描き直していない`);
    if (!r.site.startsWith("手組み:") && (log.thumbs.length === 0 || log.thumbs.some((i) => i !== OPF)))
      return ng(`★${what}のあとに塗り直したサムネが違う（${JSON.stringify(log.thumbs)}・操作したコマ ${OPF} だけのはず）`);
    return ok();
  };
  log.renders = 0;
  log.thumbs.length = 0;
  ed.dirty = false; // 保存した直後（取り消しは「変更」なので、未保存の印とオートセーブの予約が立つこと）
  await undo(ed);
  if (ed.history.undoDepth !== d0) return ng(`前提: Ctrl+Z で履歴が戻っていない（${ed.history.undoDepth}）`);
  if (!ed.dirty) return ng("★保存した直後の Ctrl+Z で未保存の印（dirty）が立たない（オートセーブも終了時の確認も働かない）");
  {
    const v = repainted("Ctrl+Z");
    if (!v.ok) return v;
  }
  for (const k of Object.keys(view))
    if (!same(p.frames[VIEW].layers[k], view[k])) return ng(`★Ctrl+Z がいま見ているコマ（${VIEW}）の ${k} を書き換えた`);
  await T.S.wakeFrame(p, f, "read");
  for (const k of Object.keys(pre))
    if (!same(f.layers[k], pre[k]))
      return ng(
        `★眠ったコマの Ctrl+Z で ${k} が戻らない（黙って空振り・${f.layers[k] ? diffCount(f.layers[k], pre[k]) : "無い"} 画素・prepare ${has}）`
      );
  for (const k of Object.keys(f.layers))
    if (!(k in pre)) return ng(`★Ctrl+Z のあとに、操作前に無かったレイヤー ${k} が残っている`);
  await T.S.sleepFrame(p, f, new Set());
  log.renders = 0;
  log.thumbs.length = 0;
  ed.dirty = false;
  await redo(ed);
  if (!ed.dirty) return ng("★保存した直後の Ctrl+Y で未保存の印（dirty）が立たない");
  {
    const v = repainted("Ctrl+Y");
    if (!v.ok) return v;
  }
  await T.S.wakeFrame(p, f, "read");
  for (const k of Object.keys(post))
    if (!same(f.layers[k], post[k]))
      return ng(`★眠ったコマの Ctrl+Y で ${k} が操作後の絵にならない（${f.layers[k] ? diffCount(f.layers[k], post[k]) : "無い"} 画素）`);
  for (const k of Object.keys(view))
    if (!same(p.frames[VIEW].layers[k], view[k])) return ng(`★Ctrl+Y がいま見ているコマ（${VIEW}）の ${k} を書き換えた`);
  // 書きで起こしていれば、眠りの網（古い控えを捨てた＝数え漏れのログ）は鳴らない
  await T.S.sleepFrame(p, f, new Set());
  if (log.stale) return ng(`★眠りの網が ${log.stale} 回鳴った（取り消しの前に書きで起こしていない）`);
  return ok();
}
async function checkS2(T: Tree): Promise<V> {
  const bad: string[] = [];
  for (const r of ROWS) {
    const v = await safe(() => checkS2Row(T, r));
    if (!v.ok) bad.push(`${r.id}: ${v.why}`);
  }
  return bad.length ? ng(bad.join(" ／ ")) : ok();
}

/** 2b: ページ貼り付け（手組み・prepare なし）は、眠ったコマでも Ctrl+Z / Ctrl+Y で戻る。
 *  取り消しが `.set()` ではなく**バッファごと差し替える**（`frame.layers[id] = nb`）ので起こさなくてよい——
 *  この回の報告書に「対象外」と書いた根拠を、読むだけでなく動かして固定する。
 *  （差し替えを `.set()` に書き換えると、ほかの手組みと同じく眠ったコマで空振りする＝反証 2bz） */
async function checkS2b(T: Tree): Promise<V> {
  const p = build(T, 12);
  const { ed } = makeEd(T, p, OPF);
  ed.sleepOn = true;
  ed.heavyAllocBudget = 1e12; // 見積もりの関所（V166）は mount で決まる。ここでは通す
  const pre = snap(p, OPF);
  const view = snap(p, VIEW);
  const clip = T.FC.makeClip(p, [6]); // コマ 6 の絵（縞の位相がコマ 1 と違う）を写して、コマ 1 へ上書きで貼る
  const d0 = ed.history.undoDepth;
  await ed.pasteFramesBody(clip);
  if (ed.history.undoDepth !== d0 + 1 || ed.history.peekUndo()?.label !== "ページ貼り付け")
    return ng(`前提: ページ貼り付けが積まれていない（${ed.history.peekUndo()?.label}）`);
  const post = snap(p, OPF);
  if (Object.keys(pre).every((k) => same(pre[k], post[k]))) return ng("前提: 貼り付けで絵が変わっていない");
  ed.frameIndex = VIEW;
  const f = p.frames[OPF];
  await T.S.sleepFrame(p, f, new Set());
  if (!T.S.frameHasAsleep(f)) return ng("前提: コマ 1 が眠っていない");
  await undo(ed);
  await T.S.wakeFrame(p, f, "read");
  for (const k of Object.keys(pre)) if (!same(f.layers[k], pre[k])) return ng(`★眠ったコマのページ貼り付けの Ctrl+Z で ${k} が戻らない`);
  await T.S.sleepFrame(p, f, new Set());
  await redo(ed);
  await T.S.wakeFrame(p, f, "read");
  for (const k of Object.keys(post)) if (!same(f.layers[k], post[k])) return ng(`★眠ったコマのページ貼り付けの Ctrl+Y で ${k} が貼った絵にならない`);
  for (const k of Object.keys(view)) if (!same(p.frames[VIEW].layers[k], view[k])) return ng(`★いま見ているコマの ${k} が変わった`);
  return ok();
}

// ================= [S-3] 呼ぶ所の数＝prepare を付ける所の数（構文木） =================
interface Site {
  file: string;
  fn: string;
  line: number;
  prepared: boolean;
}
const ENTRY_FNS = new Set(["bufferChangeEntry", "multiBufferChangeEntry"]);
/** 呼ぶ所を全部拾う（src/ の .ts 全部・定義のある history.ts を除く）。
 *  ★別名でも拾う: `import { bufferChangeEntry as x }`・`import * as H` の `H.bufferChangeEntry(…)`。
 *  さらに**呼ぶ以外の参照**（`const mk = bufferChangeEntry` のように別の名前へ移す）は `strays` に入れて赤にする
 *  ——移された先の呼び出しは数えられないので、字面の数え上げが黙る形（V178 の教訓）を先に塞ぐ */
function findSites(dir: string): { sites: Site[]; strays: string[] } {
  const out: Site[] = [];
  const strays: string[] = [];
  const walkDir = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, ent.name);
      if (ent.isDirectory()) walkDir(f);
      else if (ent.name.endsWith(".ts") && !f.endsWith(path.join("editor", "history.ts"))) scanFile(f);
    }
  };
  const fnName = (n: ts.Node): { name: string; body: ts.Node } | null => {
    for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
      if (
        (ts.isMethodDeclaration(c) || ts.isFunctionDeclaration(c) || ts.isGetAccessor(c) || ts.isSetAccessor(c)) &&
        c.name
      )
        return { name: c.name.getText(), body: c };
      if (ts.isConstructorDeclaration(c)) return { name: "constructor", body: c };
      if (ts.isPropertyDeclaration(c) && c.initializer && (ts.isArrowFunction(c.initializer) || ts.isFunctionExpression(c.initializer)))
        return { name: c.name.getText(), body: c };
    }
    return null;
  };
  const scanFile = (file: string) => {
    const src = fs.readFileSync(file, "utf8");
    if (!/history/.test(src)) return; // history から import していなければ呼びようがない
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = path.relative(dir, file).replace(/\\/g, "/");
    const where = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    // import の別名を集める
    const names = new Set<string>();
    const spaces = new Set<string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      if (!/(^|\/)history(\.ts)?$/.test(st.moduleSpecifier.text)) continue;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) spaces.add(nb.name.text);
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements) if (ENTRY_FNS.has((el.propertyName ?? el.name).text)) names.add(el.name.text);
    }
    if (names.size === 0 && spaces.size === 0) return;
    /** その式が「呼ぶ関数」を指しているか（別名・名前空間つきも） */
    const isEntryRef = (e: ts.Node) =>
      (ts.isIdentifier(e) && names.has(e.text)) ||
      (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && spaces.has(e.expression.text) && ENTRY_FNS.has(e.name.text));
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && isEntryRef(n.expression)) {
        const owner = fnName(n);
        let prepared = false;
        // 許す形は 1 つ: `const <名前> = …Entry(…)` と、同じ関数の中の `<名前>.prepare = …`
        if (owner && ts.isVariableDeclaration(n.parent) && n.parent.initializer === n && ts.isIdentifier(n.parent.name)) {
          const v = n.parent.name.text;
          const seek = (m: ts.Node): boolean =>
            (ts.isBinaryExpression(m) &&
              m.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(m.left) &&
              ts.isIdentifier(m.left.expression) &&
              m.left.expression.text === v &&
              m.left.name.text === "prepare") ||
            !!m.forEachChild(seek);
          prepared = seek(owner.body);
        }
        out.push({ file: rel, fn: owner?.name ?? "（関数の外）", line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, prepared });
        // 引数の中は見るが、呼ぶ関数そのもの（n.expression）は「呼ぶ以外の参照」に数えない
        for (const a of n.arguments) visit(a);
        return;
      }
      // `obj.bufferChangeEntry` の名前の側は別物。`bufferChangeEntry.call(…)` のような式の側は参照に数える
      if (isEntryRef(n) && !ts.isImportSpecifier(n.parent) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) strays.push(where(n));
      else if (ts.isPropertyAccessExpression(n) && isEntryRef(n)) strays.push(where(n));
      if (ts.isImportDeclaration(n)) return; // import の中の名前は参照に数えない
      n.forEachChild(visit);
    };
    visit(sf);
  };
  walkDir(path.join(dir, "src"));
  return { sites: out, strays };
}
async function checkS3(T: Tree): Promise<V> {
  const { sites, strays } = findSites(T.dir);
  // ⚠ 空振り（1 件も拾えない）は赤。書き方が変わって検査が素通りする形を塞ぐ
  if (sites.length === 0) return ng("呼ぶ所を 1 件も拾えない（検査が黙る）");
  if (strays.length) return ng(`★呼ぶ以外の形で参照している（別の名前へ移すと数えられない）: ${strays.join(", ")}`);
  const bare = sites.filter((s) => !s.prepared);
  const prepared = sites.length - bare.length;
  if (bare.length)
    return ng(
      `★prepare の無い呼ぶ所がある（呼ぶ所 ${sites.length} ／ prepare ${prepared}）: ${bare.map((s) => `${s.fn}@${s.file}:${s.line}`).join(", ")}`
    );
  const fns = new Set(sites.map((s) => s.fn));
  const rows = new Set(ROWS.filter((r) => !r.site.startsWith("手組み:")).map((r) => r.site));
  const noRow = [...fns].filter((f) => !rows.has(f));
  const noSite = [...rows].filter((f) => !fns.has(f));
  if (noRow.length) return ng(`★[S-2] の表に行の無い呼ぶ所がある（新しい操作は表にも行を足す）: ${noRow.join(", ")}`);
  if (noSite.length) return ng(`[S-2] の表の行が指す呼ぶ所が無い: ${noSite.join(", ")}`);
  return ok();
}

// ================= [S-4] 小さい作品では、この回の前とビット単位で同じ =================
/** この回の前の editor.ts（コミット e354a45 の blob）。★生きた旧版との照合に使う */
const OLD_EDITOR_BLOB = "0e30f8dbc3e28dfc2923cc79de263a47482e414a";
/** ★この回の前の editor.ts で [S-4] の筋書きを走らせて得た値（2026-09-25・V180 の実装前に測った） */
const GOLDEN_S4 = "b961eecb51ffbe7fc2286d5d292fbc7ebb2ff4b64c96355b53d15fe622661ed0";
interface WakeRec {
  f: Mod;
  mode: string;
  hadSleep: boolean;
}
/** 眠りの無い小さい作品（3 コマ）で、表の操作を 1 つずつ: 操作 → Ctrl+Z → Ctrl+Y → Ctrl+Z。
 *  各段で「全コマの画素の指紋・履歴の深さ・塗り直したサムネ」を 1 行に */
async function scenarioS4(T: Tree): Promise<{ rows: string; wakes: string[] }> {
  const rows: string[] = [];
  const wakes: string[] = [];
  const saved = Math.random;
  try {
    for (const r of ROWS) {
      Math.random = mulberry32(180);
      const p = build(T, 3);
      const { ed, log } = makeEd(T, p, OPF);
      G.__v180Wake = [];
      await r.run(ed, p);
      const line = (tag: string) => {
        const s = `${r.id}/${tag}:${shaAll(p)}:${ed.history.undoDepth}:${log.thumbs.join(",")}`;
        log.thumbs.length = 0;
        return s;
      };
      rows.push(line("操作"));
      const opWakes = (G.__v180Wake as WakeRec[]).length;
      await undo(ed);
      rows.push(line("Ctrl+Z"));
      await redo(ed);
      rows.push(line("Ctrl+Y"));
      await undo(ed);
      rows.push(line("Ctrl+Z"));
      const ws = (G.__v180Wake as WakeRec[]).slice(opWakes);
      const where = ws.map((w) => `${p.frames.indexOf(w.f)}${w.mode === "write" ? "w" : "r"}${w.hadSleep ? "!" : ""}`);
      wakes.push(`${r.id}:${where.join(",")}:${p.frames.some((f: Mod) => f.sleep) ? "眠りあり" : "眠りなし"}`);
    }
  } finally {
    Math.random = saved;
  }
  return { rows: rows.join("\n"), wakes };
}
/** wakeFrame の呼び方: 1 回の取り消し／やり直しにつき、**その操作のコマ（1）へ書きで 1 回だけ**・眠りは生まれない */
function checkWakes(wakes: string[]): V {
  for (const w of wakes) {
    const [id, calls, sl] = w.split(":");
    if (sl !== "眠りなし") return ng(`★${id}: 小さい作品に眠りが生まれた`);
    if (calls !== "1w,1w,1w") return ng(`★${id}: wakeFrame の呼び方が違う（${calls || "0 回"}・「1w,1w,1w」のはず）`);
  }
  return ok();
}
async function checkS4(T: Tree): Promise<V> {
  const { rows, wakes } = await scenarioS4(T);
  const sha = crypto.createHash("sha256").update(rows).digest("hex");
  if (GOLDEN_S4 && sha !== GOLDEN_S4) return ng(`★この回の前の固定値と違う（いま ${sha.slice(0, 16)}…）`);
  return checkWakes(wakes);
}

// ================= [S-5] コマ番号で持つ所は、そのコマが無くても例外を投げない =================
async function checkS5(T: Tree): Promise<V> {
  const cases: { id: string; run: (ed: Mod, p: Mod) => void; undoToo: boolean }[] = [
    { id: "四隅変形", run: (ed, p) => ROWS.find((r) => r.id === "四隅変形")!.run(ed, p) as void, undoToo: true },
    { id: "レイヤーの移動", run: (ed, p) => ROWS.find((r) => r.id === "レイヤーの移動")!.run(ed, p) as void, undoToo: true },
    // 手組みの 2 つは取り消しの**中身**がコマの有無を見ない（以前から・この回は触らない）＝ prepare だけを見る
    { id: "複写", run: (ed) => ed.copyPrevFrame(), undoToo: false },
    { id: "切り取って新規レイヤー", run: (ed) => ((ed.selMask = SEL()), ed.selectionToNewLayer(true)), undoToo: true },
  ];
  for (const c of cases) {
    const p = build(T, 6);
    const { ed } = makeEd(T, p, 3);
    await c.run(ed, p);
    const e = ed.history.peekUndo();
    if (!e) return ng(`前提: ${c.id} が履歴に積まれていない`);
    if (!e.prepare) return ng(`★${c.id}: prepare が無い（コマを起こす備えが無い）`);
    // 履歴の外でコマが減った（そのコマ番号のコマが無い）
    p.frames.splice(2);
    ed.frameIndex = 1;
    // 残っているコマの A・B・C（新規レイヤーの操作は、取り消しで全コマからそのレイヤーを外すのが正しい動き）
    const abc = () => shaAll({ frames: p.frames.map((f: Mod) => ({ paper: f.paper, layers: { A: f.layers.A, B: f.layers.B, C: f.layers.C } })) });
    const before0 = abc();
    const nRej = rejections.length;
    try {
      await e.prepare();
    } catch (err) {
      return ng(`★${c.id}: コマが無いと prepare が例外を投げた（${String((err as Error)?.message ?? err).slice(0, 60)}）`);
    }
    if (c.undoToo) {
      const d = ed.history.undoDepth;
      await undo(ed);
      if (rejections.length !== nRej) return ng(`★${c.id}: コマが無いと取り消しが未処理の拒否を出した（${rejections[nRej]}）`);
      if (ed.history.undoDepth !== d - 1) return ng(`★${c.id}: コマが無いと取り消しが進まない（${ed.history.undoDepth}）`);
      if (abc() !== before0) return ng(`★${c.id}: 残っているコマの絵が変わった`);
    }
  }
  return ok();
}

// ================= [S-6] 連打（同じ瞬間に Ctrl+Z を 2 回・3 回） =================
async function checkS6With(T: Tree, kind: "pen" | "eraseAll", frames: number[]): Promise<V> {
  const p = build(T, 12);
  const { ed } = makeEd(T, p, frames[0]);
  ed.sleepOn = true;
  const pre: Record<number, Record<string, Buf>> = {};
  const post: Record<number, Record<string, Buf>> = {};
  for (const fi of frames) {
    ed.frameIndex = fi;
    pre[fi] = snap(p, fi);
    if (kind === "eraseAll") ROWS.find((r) => r.id === "消しゴム（全レイヤー）")!.run(ed, p);
    else stroke(ed, PATH);
    post[fi] = snap(p, fi);
    if (Object.keys(pre[fi]).every((k) => same(pre[fi][k], post[fi][k]))) return ng(`前提: コマ ${fi} の絵が変わっていない`);
  }
  ed.frameIndex = VIEW;
  const view = snap(p, VIEW);
  const sleepAll = async () => {
    for (const fi of frames) await T.S.sleepFrame(p, p.frames[fi], new Set());
    for (const fi of frames) if (!T.S.frameHasAsleep(p.frames[fi])) throw new Error(`前提: コマ ${fi} が眠っていない`);
  };
  const wakeAll = async () => {
    for (const fi of frames) await T.S.wakeFrame(p, p.frames[fi], "read");
  };
  await sleepAll();
  let m = ed.history.mutations;
  for (let i = 0; i < frames.length; i++) ed.handleUndo(); // ★同じ瞬間（キーのくり返しが追いつく形）
  await settle(ed, m + frames.length);
  if (ed.history.undoDepth !== 0) return ng(`前提: 履歴が ${ed.history.undoDepth} 残っている`);
  await wakeAll();
  // 戻らなかったコマを全部挙げる（下のエントリの空振りと、上のエントリの上書きは別の壊れ方）
  const lost: string[] = [];
  for (const fi of frames) {
    const px = Object.keys(pre[fi]).reduce((n, k) => n + diffCount(p.frames[fi].layers[k], pre[fi][k]), 0);
    if (px) lost.push(`コマ ${fi}（${px} 画素）`);
  }
  if (lost.length) return ng(`★同じ瞬間の Ctrl+Z ${frames.length} 回で戻らない: ${lost.join("・")}`);
  await sleepAll();
  m = ed.history.mutations;
  for (let i = 0; i < frames.length; i++) ed.handleRedo();
  await settle(ed, m + frames.length);
  await wakeAll();
  for (const fi of frames)
    for (const k of Object.keys(post[fi]))
      if (!same(p.frames[fi].layers[k], post[fi][k]))
        return ng(`★同じ瞬間の Ctrl+Y ${frames.length} 回で、コマ ${fi} の ${k} が操作後の絵にならない`);
  for (const k of Object.keys(view))
    if (!same(p.frames[VIEW].layers[k], view[k])) return ng(`★いま見ているコマ（${VIEW}）の ${k} が変わった`);
  return ok();
}
/** 6（混ぜ）: 同じ瞬間に Ctrl+Z・Ctrl+Z・Ctrl+Y → **押した順に 1 つずつ**効く
 *  （上のコマ 3 は戻ったまま・下のコマ 1 は戻してからやり直した絵）。取り消しとやり直しが別々の列だと、
 *  やり直しが取り消しを追い越して空振りする */
async function checkS6Mixed(T: Tree): Promise<V> {
  const p = build(T, 12);
  const { ed } = makeEd(T, p, 1);
  ed.sleepOn = true;
  const pre1 = snap(p, 1);
  stroke(ed, PATH);
  const post1 = snap(p, 1);
  ed.frameIndex = 3;
  const pre3 = snap(p, 3);
  stroke(ed, PATH);
  ed.frameIndex = VIEW;
  for (const fi of [1, 3]) await T.S.sleepFrame(p, p.frames[fi], new Set());
  const m = ed.history.mutations;
  ed.handleUndo();
  ed.handleUndo();
  ed.handleRedo();
  await settle(ed, m + 3);
  for (const fi of [1, 3]) await T.S.wakeFrame(p, p.frames[fi], "read");
  const d3 = Object.keys(pre3).reduce((n, k) => n + diffCount(p.frames[3].layers[k], pre3[k]), 0);
  const d1 = Object.keys(post1).reduce((n, k) => n + diffCount(p.frames[1].layers[k], post1[k]), 0);
  if (d3) return ng(`★同じ瞬間の Z・Z・Y で、コマ 3 が戻っていない（${d3} 画素）`);
  if (d1) return ng(`★同じ瞬間の Z・Z・Y で、コマ 1 がやり直した絵になっていない（${d1} 画素・元の絵との差 ${Object.keys(pre1).reduce((n, k) => n + diffCount(p.frames[1].layers[k], pre1[k]), 0)}）`);
  if (ed.history.undoDepth !== 1) return ng(`★同じ瞬間の Z・Z・Y のあとの履歴の深さが ${ed.history.undoDepth}（1 のはず）`);
  return ok();
}
const S6_CASES = [
  ["pen", [1, 3]],
  ["pen", [1, 3, 5]],
  // この回の前から prepare を持っていた消しゴム（全レイヤー）でも同じ形（③はこの回の前からある）
  ["eraseAll", [1, 3]],
] as const;
async function checkS6(T: Tree): Promise<V> {
  const bad: string[] = [];
  for (const [kind, frames] of S6_CASES) {
    const v = await safe(() => checkS6With(T, kind, [...frames]));
    if (!v.ok) bad.push(`${kind === "pen" ? "描画" : "消しゴム（全レイヤー）"}×${frames.length}: ${v.why}`);
  }
  const mixed = await safe(() => checkS6Mixed(T));
  if (!mixed.ok) bad.push(`Z・Z・Y: ${mixed.why}`);
  return bad.length ? ng(bad.join(" ／ ")) : ok();
}

/** 6b: 1 回の取り消しが失敗しても（prepare が拒否）、**列は止まらない**。失敗はこれまでどおり
 *  未処理の拒否として外へ出る（main.ts の unhandledrejection の網がログに残す＝握り潰さない） */
async function checkS6b(T: Tree): Promise<V> {
  const p = build(T, 3);
  const { ed } = makeEd(T, p, OPF);
  const pre = snap(p, OPF);
  stroke(ed, PATH); // 描画（本物のエントリ）
  // 一番上に「1 回目だけ準備に失敗する」エントリ（起こす途中で壊れた控えに当たった、の代わり）
  let calls = 0;
  let undone = 0;
  ed.history.push({
    label: "v180-失敗",
    undo() {
      undone++;
    },
    redo() {},
    prepare: () => (++calls === 1 ? Promise.reject(new Error("v180: 準備に失敗")) : Promise.resolve()),
  });
  const nRej = rejections.length;
  const m = ed.history.mutations;
  ed.handleUndo(); // 1 回目: 準備に失敗 → 取り消さない
  ed.handleUndo(); // 2 回目: まだ一番上の同じエントリ → 準備が通って取り消す
  ed.handleUndo(); // 3 回目: 描画を取り消す
  await settle(ed, m + 2);
  if (calls < 2 || undone !== 1) return ng(`★1 回の失敗で列が止まった（準備 ${calls} 回・取り消し ${undone} 回）`);
  if (!same(p.frames[OPF].layers.B, pre.B)) return ng("★失敗のあとの Ctrl+Z で描画が戻らない（列が止まった）");
  if (rejections.length !== nRej + 1)
    return ng(`★失敗が未処理の拒否として外へ出ていない（${rejections.length - nRej} 件・ログの網に届かない）`);
  return ok();
}

// ================= 実行 =================
const REAL = await loadTree(root, "本物");
interface Chk {
  id: string;
  name: string;
  run: (T: Tree) => Promise<V>;
}
const CHECKS: Chk[] = [
  { id: "S-1", name: "★歪み: コマを移ってからの Ctrl+Z / Ctrl+Y は歪ませたコマにだけ効く（見ているコマは 1 画素も変わらない）", run: checkS1 },
  { id: "S-2", name: "★操作ごとの表: 操作したコマが眠っていても Ctrl+Z で元の絵・Ctrl+Y で操作後の絵", run: checkS2 },
  { id: "S-2b", name: "ページ貼り付け（手組み・prepare なし）は、眠ったコマでも Ctrl+Z / Ctrl+Y で戻る（バッファごと差し替える）", run: checkS2b },
  { id: "S-3", name: "★呼ぶ所の数＝prepare を付ける所の数（構文木）・呼ぶ所と表の行が 1 対 1", run: checkS3 },
  { id: "S-5", name: "コマ番号で持つ所は、そのコマが無くても例外を投げない", run: checkS5 },
  { id: "S-6", name: "★連打: 同じ瞬間の Ctrl+Z / Ctrl+Y 2 回・3 回で、眠ったコマが全部戻る", run: checkS6 },
  { id: "S-6b", name: "1 回の取り消しが失敗しても列は止まらない・失敗は未処理の拒否として外へ出る", run: checkS6b },
];
const byId = (id: string) => CHECKS.find((c) => c.id === id) ?? { id, name: id, run: checkS4 };

for (const c of CHECKS) {
  const v = await safe(() => c.run(REAL));
  check(`[${c.id}] ${c.name}`, v.ok, v.why);
  // 表の検査は行ごとの結果も残す（報告書の証跡）
  if (c.id === "S-2")
    for (const r of ROWS) {
      const rv = await safe(() => checkS2Row(REAL, r));
      console.log(`  [S-2] ${rv.ok ? "緑" : "赤"} ${r.id}${rv.ok ? "" : ` — ${rv.why}`}`);
    }
  if (c.id === "S-3") for (const s of findSites(REAL.dir).sites) console.log(`  [S-3] ${s.prepared ? "prepare あり" : "prepare なし"} ${s.fn}（${s.file}:${s.line}）`);
}

// [S-4]（計器つきの写し＝本物の src/ と同じもの＋wakeFrame の記録 1 行）
{
  const cur = await mutant([], true);
  if (!cur.tree) check("[S-4] 計器つきの写しを作れた", false, cur.why);
  else {
    const r = await safe(async () => ({ ok: true, why: JSON.stringify(await scenarioS4(cur.tree!)) }));
    check("[S-4] 筋書きが最後まで走った", r.ok, r.why);
    const { rows, wakes } = r.ok ? (JSON.parse(r.why) as { rows: string; wakes: string[] }) : { rows: "", wakes: [] };
    const sha = crypto.createHash("sha256").update(rows).digest("hex");
    check(
      "[S-4] ★小さい作品の画素・履歴・サムネが、この回の前の editor.ts で測った固定値とビット単位で同じ",
      r.ok && sha === GOLDEN_S4,
      `いま ${sha} ／ 固定値 ${GOLDEN_S4 || "（未設定）"}`
    );
    const w = checkWakes(wakes);
    check("[S-4] ★wakeFrame は 1 回の取り消し／やり直しにつき、その操作のコマへ書きで 1 回だけ（眠りは生まれない）", w.ok, w.why);
    for (const x of wakes) console.log(`  [S-4] ${x}`);
    // 生きた旧版（このリポジトリに blob があるときだけ。公開リポジトリの clone には無い）
    let haveOld = false;
    try {
      execFileSync("git", ["cat-file", "-e", OLD_EDITOR_BLOB], { cwd: root, stdio: "ignore" });
      haveOld = true;
    } catch {
      haveOld = false;
    }
    if (!haveOld) console.log(`SKIP [S-4r] この回の前の editor.ts（blob ${OLD_EDITOR_BLOB.slice(0, 12)}…）がこの clone に無い＝固定値との照合だけ`);
    else {
      const dir = path.join(WORK, "old");
      copySrc(dir);
      fs.writeFileSync(
        path.join(dir, "src/editor/editor.ts"),
        execFileSync("git", ["cat-file", "blob", OLD_EDITOR_BLOB], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
      );
      const probe = applyEdits(dir, [WAKE_PROBE]);
      const old = probe
        ? { ok: false, why: probe }
        : await safe(async () => ({ ok: true, why: (await scenarioS4(await loadTree(dir, "旧版"))).rows }));
      const oldSha = crypto.createHash("sha256").update(old.ok ? old.why : "").digest("hex");
      check("[S-4r] 取り出した旧版で筋書きが最後まで走った", old.ok, old.why);
      check(
        "[S-4r] ★固定値は、取り出した旧版（この回の前の editor.ts）そのものの出力",
        old.ok && oldSha === GOLDEN_S4,
        `旧版 ${oldSha} ／ 固定値 ${GOLDEN_S4 || "（未設定）"}`
      );
      if (old.ok && r.ok && old.why !== rows) {
        const a = old.why.split("\n");
        const b = rows.split("\n");
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) console.log(`    旧 ${a[i]}\n    今 ${b[i]}`);
      }
      check("[S-4r] ★いまの editor.ts の出力が旧版と 1 行も違わない", old.ok && r.ok && old.why === rows);
    }
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
interface Mut {
  id: string;
  what: string;
  target: string;
  edits: Edit[];
  /** [S-2] の反証: 赤になるはずの行。**これ以外の行は緑のまま**であること（表で当てる） */
  rows?: string[];
}
/** 1 コマの絵を書き換える履歴の prepare（コマ番号で持つ形）。反証の書き換えに使う */
const idxPrepare = (who: string, v: string, ind: string) =>
  `${ind}${who}.prepare = () => {\n${ind}  const fr = this.project.frames[${v}];\n${ind}  return fr ? wakeFrame(this.project, fr, "write") : Promise.resolve();\n${ind}};\n`;
const handPrepare = (v: string) =>
  `      prepare: () => {\n        const fr = self.project.frames[${v}];\n        return fr ? wakeFrame(self.project, fr, "write") : Promise.resolve();\n      },\n`;
const PBH = '    base.prepare = () => wakeFrame(self.project, frame, "write");\n    if (!sel) {';
const SEL_ROWS = ["選択の移動（合成エントリ）", "切り取り（合成エントリ）"];
const PBH_ROWS = ["描画（ペン）", "塗り", ...SEL_ROWS, "選択部分を消去"];
const MUTS: Mut[] = [
  {
    id: "1z",
    what: "★歪みの戻し先を、適用時の this.frameIndex（見ているコマ）で解決する（この回の前の形）",
    target: "S-1",
    edits: [
      { file: ED, from: "(layerId) => f.layers[layerId] ?? null,", to: "(layerId) => this.project.frames[this.frameIndex]?.layers[layerId] ?? null," },
    ],
  },
  {
    id: "1z'",
    what: "歪みの取り消しのあとに、見ているコマのサムネを塗る（この回の前の形）",
    target: "S-1",
    edits: [
      {
        file: ED,
        from: "            const fi = this.project.frames.indexOf(f);\n            if (fi >= 0) this.paintFilmThumb(fi);",
        to: "            this.paintFilmThumb(this.frameIndex);",
      },
    ],
  },
  {
    id: "2z-1",
    what: "★pushBufferHistory の prepare を外す（描画・塗り・選択系の全部）",
    target: "S-2",
    rows: PBH_ROWS,
    edits: [{ file: ED, from: PBH, to: "    if (!sel) {" }],
  },
  {
    id: "2z-2",
    what: "pushBufferHistory の合成エントリ（選択の移動・切り取り）で prepare を運ばない",
    target: "S-2",
    rows: SEL_ROWS,
    edits: [{ file: ED, from: "        prepare: base.prepare,\n", to: "" }],
  },
  {
    id: "2z-3",
    what: "四隅変形の prepare を外す",
    target: "S-2",
    rows: ["四隅変形"],
    edits: [{ file: ED, from: idxPrepare("cornerEntry", "fi", "      "), to: "" }],
  },
  {
    id: "2z-4",
    what: "歪みの prepare を外す",
    target: "S-2",
    rows: ["歪み"],
    edits: [{ file: ED, from: '        warpEntry.prepare = () => wakeFrame(this.project, f, "write");\n', to: "" }],
  },
  {
    id: "2z-5",
    what: "レイヤーの移動の prepare を外す",
    target: "S-2",
    rows: ["レイヤーの移動"],
    edits: [{ file: ED, from: idxPrepare("moveEntry", "frameIdx", "    "), to: "" }],
  },
  {
    id: "2z-6",
    what: "変形の prepare を外す",
    target: "S-2",
    rows: ["変形（合成エントリ）"],
    edits: [
      {
        file: ED,
        from: '    base.prepare = () => wakeFrame(this.project, frame, "write");\n    this.pushWithSelection(',
        to: "    this.pushWithSelection(",
      },
    ],
  },
  {
    id: "2z-7",
    what: "pushWithSelection（変形の包み・V156 からある行）で prepare を運ばない",
    target: "S-2",
    rows: ["変形（合成エントリ）"],
    edits: [{ file: ED, from: "      prepare: base.prepare,\n      undo() {", to: "      undo() {" }],
  },
  {
    id: "2z-8",
    what: "消すの prepare を外す",
    target: "S-2",
    rows: ["消す"],
    edits: [{ file: ED, from: '    clearEntry.prepare = () => wakeFrame(this.project, frame, "write");\n', to: "" }],
  },
  {
    id: "2z-9",
    what: "全レイヤー消しゴム（V178）の prepare を外す",
    target: "S-2",
    rows: ["消しゴム（全レイヤー）"],
    edits: [{ file: ED, from: '    entry.prepare = () => wakeFrame(self.project, frame, "write");\n', to: "" }],
  },
  {
    id: "2z-10",
    what: "複写（手組み）の prepare を外す",
    target: "S-2",
    rows: ["複写（手組み）"],
    edits: [{ file: ED, from: handPrepare("fi"), to: "" }],
  },
  {
    id: "2z-11",
    what: "選択→新規レイヤー（手組み）の prepare を外す",
    target: "S-2",
    rows: ["切り取って新規レイヤー（手組み）", "コピーして新規レイヤー（手組み）"],
    edits: [{ file: ED, from: handPrepare("frameIdx"), to: "" }],
  },
  {
    id: "2z-12",
    what: "pushBufferHistory の prepare を「読み」で起こす（書きで起こさない＝眠りの控えを捨てない）",
    target: "S-2",
    rows: PBH_ROWS,
    edits: [{ file: ED, from: PBH, to: '    base.prepare = () => wakeFrame(self.project, frame, "read");\n    if (!sel) {' }],
  },
  {
    id: "2z-13",
    what: "★歪みの取り消し・やり直しで未保存の印（dirty）を立てない（Codex 1 回目の穴そのもの）",
    target: "S-2",
    rows: ["歪み"],
    edits: [
      {
        file: ED,
        from: "            this.dirty = true;\n            this.renderCanvas();\n            // ★V180: 塗り直すのも歪ませたコマのサムネ",
        to: "            this.renderCanvas();\n            // ★V180: 塗り直すのも歪ませたコマのサムネ",
      },
    ],
  },
  {
    id: "2z-14",
    what: "レイヤーの移動の取り消し・やり直しで未保存の印（dirty）を立てない（この回の前の形）",
    target: "S-2",
    rows: ["レイヤーの移動"],
    edits: [
      {
        file: ED,
        from: "        this.dirty = true;\n        this.renderCanvas();\n        this.redrawOverlay();\n        this.paintFilmThumb(frameIdx);",
        to: "        this.renderCanvas();\n        this.redrawOverlay();\n        this.paintFilmThumb(frameIdx);",
      },
    ],
  },
  {
    id: "2z-15",
    what: "pushBufferHistory の取り消しのあとに、見ているコマのサムネを塗る",
    target: "S-2",
    rows: PBH_ROWS,
    edits: [
      {
        file: ED,
        from: "        self.renderCanvas();\n        const fi = self.project.frames.indexOf(frame);\n        if (fi >= 0) self.paintFilmThumb(fi);\n      }\n    );\n    // ★V180 (A-78 ②): 描画・塗り",
        to: "        self.renderCanvas();\n        self.paintFilmThumb(self.frameIndex);\n      }\n    );\n    // ★V180 (A-78 ②): 描画・塗り",
      },
    ],
  },
  {
    id: "2z-16",
    what: "消すの取り消しのあとに画面を描き直さない",
    target: "S-2",
    rows: ["消す"],
    edits: [
      {
        file: ED,
        from: "      () => {\n        self.dirty = true;\n        self.renderCanvas();\n        const fi = self.project.frames.indexOf(frame);\n        if (fi >= 0) self.paintFilmThumb(fi);\n      }\n    );\n    // ★V180 (A-78 ②): 取り消し・やり直しの前に、そのコマを書きで起こす（眠っていると黙って空振りする）\n    clearEntry",
        to: "      () => {\n        self.dirty = true;\n        const fi = self.project.frames.indexOf(frame);\n        if (fi >= 0) self.paintFilmThumb(fi);\n      }\n    );\n    // ★V180 (A-78 ②): 取り消し・やり直しの前に、そのコマを書きで起こす（眠っていると黙って空振りする）\n    clearEntry",
      },
    ],
  },
  {
    id: "2bz",
    what: "ページ貼り付けの取り消しを、バッファの差し替えではなく .set() で書き戻す",
    target: "S-2b",
    edits: [
      {
        file: ED,
        from: "          const nb = allocIndexBuf(self.project);\n          nb.set(layers[id]);\n          frame.layers[id] = nb;",
        to: "          frame.layers[id]?.set(layers[id]);",
      },
    ],
  },
  {
    id: "3z",
    what: "★新しい呼ぶ所を prepare なしで足す（今後の付け忘れ）",
    target: "S-3",
    edits: [
      {
        file: ED,
        from: '  private queueHistory(dir: "undo" | "redo"): void {\n',
        to: '  private v180Extra(b: IndexBuf) {\n    this.history.push(bufferChangeEntry("x", () => null, b, b));\n  }\n  private queueHistory(dir: "undo" | "redo"): void {\n',
      },
    ],
  },
  {
    id: "3z'",
    what: "新しい呼ぶ所に prepare を付けたが、[S-2] の表に行を足さない",
    target: "S-3",
    edits: [
      {
        file: ED,
        from: '  private queueHistory(dir: "undo" | "redo"): void {\n',
        to:
          '  private v180Extra(b: IndexBuf) {\n    const e = bufferChangeEntry("x", () => null, b, b);\n    e.prepare = async () => {};\n    this.history.push(e);\n  }\n' +
          '  private queueHistory(dir: "undo" | "redo"): void {\n',
      },
    ],
  },
  {
    id: "3z4",
    what: "★呼ぶ関数を別の名前へ移してから呼ぶ（字面の数え上げが黙る形）",
    target: "S-3",
    edits: [
      {
        file: ED,
        from: '  private queueHistory(dir: "undo" | "redo"): void {\n',
        to: '  private v180Extra(b: IndexBuf) {\n    const mk = bufferChangeEntry;\n    this.history.push(mk("x", () => null, b, b));\n  }\n  private queueHistory(dir: "undo" | "redo"): void {\n',
      },
    ],
  },
  {
    id: "3z5",
    what: "import の別名で呼ぶ（prepare なし）",
    target: "S-3",
    edits: [
      { file: ED, from: "  bufferChangeEntry,\n  entryBytes,\n", to: "  bufferChangeEntry,\n  bufferChangeEntry as bce,\n  entryBytes,\n" },
      {
        file: ED,
        from: '  private queueHistory(dir: "undo" | "redo"): void {\n',
        to: '  private v180Extra(b: IndexBuf) {\n    this.history.push(bce("x", () => null, b, b));\n  }\n  private queueHistory(dir: "undo" | "redo"): void {\n',
      },
    ],
  },
  {
    id: "3z''",
    what: "既存の呼ぶ所（消す）から prepare の行を外す",
    target: "S-3",
    edits: [{ file: ED, from: '    clearEntry.prepare = () => wakeFrame(this.project, frame, "write");\n', to: "" }],
  },
  {
    id: "4z",
    what: "★prepare で全コマを起こす（小さい作品でも wakeFrame をコマ数ぶん呼ぶ）",
    target: "S-4",
    edits: [
      {
        file: ED,
        from: PBH,
        to: '    base.prepare = async () => {\n      for (const fr of self.project.frames) await wakeFrame(self.project, fr, "write");\n    };\n    if (!sel) {',
      },
    ],
  },
  {
    id: "5z",
    what: "四隅変形の prepare がコマの有無を見ない",
    target: "S-5",
    edits: [
      {
        file: ED,
        from: '        const fr = this.project.frames[fi];\n        return fr ? wakeFrame(this.project, fr, "write") : Promise.resolve();',
        to: '        return wakeFrame(this.project, this.project.frames[fi], "write");',
      },
    ],
  },
  {
    id: "5z'",
    what: "レイヤーの移動の prepare がコマの有無を見ない",
    target: "S-5",
    edits: [
      {
        file: ED,
        from: '      const fr = this.project.frames[frameIdx];\n      return fr ? wakeFrame(this.project, fr, "write") : Promise.resolve();',
        to: '      return wakeFrame(this.project, this.project.frames[frameIdx], "write");',
      },
    ],
  },
  {
    id: "6z",
    what: "★取り消しを並べずに走らせる（押した瞬間に peek して await＝この回の前の形）",
    target: "S-6",
    edits: [
      {
        file: ED,
        from: '    this.queueHistory("undo");\n  }',
        to: "    void this.applyHistory(() => this.history.undo(), this.history.peekUndo());\n  }",
      },
    ],
  },
  {
    id: "6z'",
    what: "やり直しだけ並べずに走らせる",
    target: "S-6",
    edits: [
      {
        file: ED,
        from: '    this.queueHistory("redo");\n  }',
        to: "    void this.applyHistory(() => this.history.redo(), this.history.peekRedo());\n  }",
      },
    ],
  },
  {
    id: "6z''",
    what: "列には並べるが、どのエントリを待つかは押した瞬間に決める",
    target: "S-6",
    edits: [
      {
        file: ED,
        from: "    const prev = this.historyQueue;\n",
        to: '    const early = dir === "undo" ? this.history.peekUndo() : this.history.peekRedo();\n    const prev = this.historyQueue;\n',
      },
      {
        file: ED,
        from: '        if (dir === "undo") await this.applyHistory(() => this.history.undo(), this.history.peekUndo());\n        else await this.applyHistory(() => this.history.redo(), this.history.peekRedo());',
        to: '        if (dir === "undo") await this.applyHistory(() => this.history.undo(), early);\n        else await this.applyHistory(() => this.history.redo(), early);',
      },
    ],
  },
  {
    id: "6z6",
    what: "取り消しとやり直しを別々の列に並べる（やり直しが取り消しを追い越す）",
    target: "S-6",
    edits: [
      {
        file: ED,
        from: "    const prev = this.historyQueue;\n    let release!: () => void;\n    this.historyQueue = new Promise<void>((r) => (release = r));\n",
        to:
          '    const own = this as unknown as { redoQueue?: Promise<void> };\n' +
          '    const prev = dir === "undo" ? this.historyQueue : (own.redoQueue ?? Promise.resolve());\n' +
          "    let release!: () => void;\n" +
          '    const gate = new Promise<void>((r) => (release = r));\n' +
          '    if (dir === "undo") this.historyQueue = gate;\n' +
          "    else own.redoQueue = gate;\n",
      },
    ],
  },
  {
    id: "6z7",
    what: "列の次を、前の 1 回が済む前に通してしまう（release を先に呼ぶ）",
    target: "S-6",
    edits: [
      {
        file: ED,
        from: "    void prev.then(async () => {\n      try {\n",
        to: "    void prev.then(async () => {\n      release();\n      try {\n",
      },
    ],
  },
  {
    id: "6z4",
    what: "失敗した 1 回で列が止まる（release を finally に置かない）",
    target: "S-6b",
    edits: [
      {
        file: ED,
        from: "      } finally {\n        release();\n      }\n    });",
        to: "        release();\n      } finally {\n      }\n    });",
      },
    ],
  },
  {
    id: "6z5",
    what: "失敗を握り潰す（ログの網に届かない）",
    target: "S-6b",
    edits: [
      {
        file: ED,
        from: "      } finally {\n        release();\n      }\n    });",
        to: "      } catch {\n        /* 握り潰す */\n      } finally {\n        release();\n      }\n    });",
      },
    ],
  },
];
for (const m of MUTS) {
  const label = `[S-R] 反証 ${m.id}: ${m.what} → [${m.target}]${m.rows ? `（${m.rows.join("・")}）` : ""} が赤`;
  const { tree, why } = await mutant(m.edits, m.target === "S-4");
  if (!tree) {
    check(label, false, why);
    continue;
  }
  if (m.target === "S-2" && m.rows) {
    // ★表で当てる: 外した所の行**だけ**が赤（ほかの行は緑のまま）
    const red: string[] = [];
    let threw = "";
    for (const r of ROWS) {
      const v = await safe(() => checkS2Row(tree, r));
      if (v.threw) threw = `${r.id}: ${v.why}`;
      else if (!v.ok) red.push(r.id);
    }
    const want = [...m.rows].sort().join("|");
    const got = [...red].sort().join("|");
    check(label, !threw && got === want, threw ? `例外で落ちた（効いたと数えない）: ${threw}` : `赤になった行: ${red.join("・") || "なし"}`);
    if (!threw && got === want) console.log(`  反証 ${m.id} → [S-2] 赤の行: ${red.join("・")}`);
    continue;
  }
  const v = await safe(() => byId(m.target).run(tree));
  check(
    label,
    !v.ok && !v.threw,
    v.ok ? "★壊した写しでも緑のまま（検査が効いていない）" : v.threw ? `例外で落ちた（効いたと数えない）: ${v.why}` : ""
  );
  if (!v.ok && !v.threw) console.log(`  反証 ${m.id} → [${m.target}] 赤: ${v.why.slice(0, 200)}`);
}

console.log(`\nv180 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
