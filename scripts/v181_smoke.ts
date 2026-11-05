// V181（Mac では ⌘ を Ctrl として扱う・A-25）の回帰ゲート。引数不要:
//   npx tsx scripts/v181_smoke.ts               … 全部（反証込み）
//   npx tsx scripts/v181_smoke.ts --no-mutants  … 反証を除く（赤先行の確認・各コミットへの当て直し用）
//   npx tsx scripts/v181_smoke.ts --table       … 辞書の置き換え表（7 言語・全件）を Markdown で出す（報告書用）
//
// ★この回の約束は 2 つ（要件 docs/REQ_mac_cmd_shortcuts.md v2・作者決定 G-1〜G-3）:
//   ① Mac では、Ctrl で書かれたショートカットがすべて ⌘ でも効き、画面の表記も ⌘ ⌥ ⇧ になる
//   ② Windows は 1 か所も変わらない（Win キーは今までどおり Ctrl とは別物＝M11-5）
//  Windows で書く回なので、**Node で「Mac のふり／Windows のふり」を注入して両方を走らせる**
//  （`src/platform.ts` の `setMacPlatformForTest`）。Mac の実機は作者が見る（報告書の R-1〜R-10）。
//
// [S-A] 判定: 作者が Mac で測った文字列（M-1: platform=MacIntel・UA に Macintosh）で Mac、WebView2 の文字列で Windows。
//       Node の navigator（動かしている機械の OS を名乗る）では判定しない＝検査の結果が機械で変わらない。
//       navigator の platform / userAgent を読むのは src/platform.ts だけ。
//       ★**注入しない経路（アプリと同じ）**: navigator を差し替えて木を新しい実体として読み込み直し、最初の呼び出しで
//       Mac / Windows と判定して覚える（独立レビュー 1 回目: 注入の経路しか見ていなかった）
// [S-1] ★Mac のふり: 組み込み 2 プリセット＋固定キーの Ctrl 系が **⌘ の打鍵で全部一致**（control でも・両方押しても）。
//       ⇧⌘Z が edit.redo（利用者の割り当てがあればそちらが勝つ）・⌘＋クリック・⌘ の単押し（タップ）。
//       全コード × ⇧/⌥ で ⌘ の照合と登録が Ctrl と同じ（⌘＋⌥ も）。
//       **本物の editor.ts** の keydown で ⌘Z / ⌘Y / ⇧⌘Z / ⌘C / ⌘X / ⌘V / ⌘S / ⇧⌘S / ⇧⌘C / ⇧⌘V / ⌘Enter が効く・
//       押しっぱなしのくり返しは（走らせない命令も）preventDefault。**ホーム画面**（main.ts をそのまま）の ⌘, も
// [S-2] ★Windows のふり: 照合キー・登録（main.ts の captureKey をそのまま取り出して動かす・preventDefault も）・
//       引き当て表・タップ・本物の editor.ts の keydown（くり返しも）と行の選択・ホーム画面のキーが
//       **この回の前とビット一致**（固定値＋取り出した旧版）。
//       表記（keyLabel・modLabel・全辞書の t()）も旧版と同じ。Win+Z は一致しない・⇧Ctrl+Z は足されていない
// [S-3] ★表記: 辞書（7 言語）の「Ctrl」「Alt」「Shift」を含む文言を**全部**通して、Mac のふりでは 1 つも残らず、
//       記号の数が元の語の数と一致（⌘=Ctrl・⌥=Alt・⇧=Shift）・並びは ⌥⇧⌘・検査側の独立した実装（oracle）と一致。
//       Windows のふりでは全キーが原文のまま。キーではない語（en の「Shift per frame」＝ずらす）は置き換えない。
//       生成する表記（keyLabel・タップ・modLabel）も同じ規則。**件数は表で固定**（増えたら分類し直す）。
//       t() の複数形の道も（検査の写しの ja.ts にだけ 1 行足して通す）
// [S-4] 登録: Mac のふりで ⌘＋文字・⌘＋クリック・⌘ の単押し → 保存される形は ctrl: true / tap: "Control"
//       （settings.json の形は不変＝sanitize を往復しても同じ・meta という項目は出ない）。取った打鍵は preventDefault
//       ＋ stopPropagation（Mac の既定のメニューへ回さない）
// [S-5] `ctrlKey` / `metaKey` の直読みは `primaryMod` / `unfoldedMeta` の中と、理由のある 5 か所だけ（構文木で数える）。
//       `primaryMod` / `unfoldedMeta` を呼ぶ所も表と突き合わせる
// [S-6] 入力欄（textarea・input・select・contenteditable）にフォーカスがあるとき、Mac のふりの ⌘C / ⌘V / ⌘Z /
//       ⌘ の単押しが**本物の editor.ts** でアプリの命令を動かさない（preventDefault もしない＝文字の編集として効く）。
//       ホーム画面の検索欄・ダイアログでも ⌘, で設定を開かない
// [S-0] 無改変の写しでは全部緑
// [S-R] 反証（わざと壊した写しで、狙った検査が赤くなること）
//
// ★反証は**実ファイルを書き換えた写し**で走らせる（V177〜V180 と同じ流儀）。写しは `node_modules/.v181-smoke/<pid>/`。
//  書き換えは**ちょうど 1 か所に当たる**こと。**例外で落ちた反証は「効いた」と数えない**。
//
// ⚠ 辞書に「Ctrl」「Alt」「Shift」を含む文言を足した／変えたら [S-3] の件数の表（DICT_COUNTS）が赤になる。
//   キーの名前として使っているなら件数を直すだけ（表示は自動で ⌘ ⌥ ⇧ になる）。
//   **キーではない語**（例「Shift per frame」＝ずらす）なら src/platform.ts の NON_KEY_WORD_DICT_KEYS に足し、
//   この検査の NON_KEY_EXPECTED にも足す（Mac で ⇧ に化けるのを防ぐ）。

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
async function safe(fn: () => V | Promise<V>): Promise<V> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, why: `例外: ${String((e as Error)?.message ?? e).slice(0, 200)}`, threw: true };
  }
}
type R = { name: string; v: V };
const root = path.resolve(import.meta.dirname, "..");
const NO_MUTANTS = process.argv.includes("--no-mutants");
const TABLE = process.argv.includes("--table");

// ================= 本物の editor.ts を Node で動かすための最小の舞台（V180 と同じ） =================
const G = globalThis as unknown as Record<string, unknown>;
G.self = G; // exporter.ts が読む gif.js（ブラウザ前提・self 参照）
G.window = G; // editor.ts の window.setTimeout 等
G.devicePixelRatio = 1;
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
G.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => NOOP_CTX }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = Record<string, any>;
const LANGS = ["ja", "en", "es", "pt-BR", "ko", "zh-Hans", "zh-Hant"] as const;
interface Tree {
  label: string;
  dir: string;
  /** src/platform.ts（この回の前には無い＝null） */
  P: Mod | null;
  K: Mod;
  I: Mod;
  D: Record<string, Record<string, string>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Editor: any;
  mainSrc: string;
}
async function loadTree(dir: string, label: string): Promise<Tree> {
  const u = (p: string) => pathToFileURL(path.join(dir, p)).href;
  const hasP = fs.existsSync(path.join(dir, "src/platform.ts"));
  const P = hasP ? await import(u("src/platform.ts")) : null;
  const K = await import(u("src/keymap.ts"));
  const I = await import(u("src/i18n/index.ts"));
  const D: Record<string, Record<string, string>> = {};
  for (const l of LANGS) D[l] = (await import(u(`src/i18n/${l}.ts`))).default;
  const E = await import(u("src/editor/editor.ts"));
  const mainSrc = fs.readFileSync(path.join(dir, "src/main.ts"), "utf8");
  return { label, dir, P, K, I, D, Editor: E.Editor, mainSrc };
}

// ================= 写し（無改変・旧版・反証）の置き場 =================
// 既定は node_modules/.v181-smoke/<pid>（git の外・npm の部品が見える）。
// サンドボックスで node_modules へ書けないときは環境変数 V181_SMOKE_WORK で差し替える
// （**その祖先に node_modules があること**＝部品を解決するため）
const WORK = path.join(
  process.env.V181_SMOKE_WORK || path.join(root, "node_modules", ".v181-smoke"),
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
let seq = 0;
async function mutant(edits: Edit[]): Promise<{ tree: Tree | null; why: string }> {
  const dir = path.join(WORK, `m${++seq}`);
  copySrc(dir);
  const why = applyEdits(dir, edits);
  if (why) return { tree: null, why };
  return { tree: await loadTree(dir, `m${seq}`), why: "" };
}

// ★この回の前（54cfbf5）の 4 ファイル。**この回が書き換えるファイルだけ**を旧版へ戻した写しを作る
//  （ほかのファイルはこの回で 1 行も変えていない＝写しは「この回の前の木」そのもの）。
//  公開リポジトリの clone など blob が無い所では [S-2r] を SKIP と表示する（固定値の [S-2] は走る）
const BASE_BLOBS: Record<string, string> = {
  "src/keymap.ts": "5786690c63be7ca8f157c733369d9cb8de7443e5",
  "src/editor/editor.ts": "413191b65f33b941f3036f7c48cdf8fa411c6d5e",
  "src/main.ts": "3643fd1cbaca9cbf5a1a851e36125442007dd21f",
  "src/i18n/index.ts": "d1ac153922409d4b7a7cd5a9c3930496217864b9",
};
async function baseTree(): Promise<Tree | null> {
  const dir = path.join(WORK, "base");
  copySrc(dir);
  try {
    for (const [f, blob] of Object.entries(BASE_BLOBS)) {
      const text = execFileSync("git", ["cat-file", "blob", blob], { cwd: root, maxBuffer: 64 << 20 });
      fs.writeFileSync(path.join(dir, f), text);
    }
  } catch {
    return null;
  }
  fs.rmSync(path.join(dir, "src/platform.ts"), { force: true }); // この回の前には無いファイル
  return loadTree(dir, "base");
}

// ================= 道具 =================
type Mods = { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
const MOD16: Mods[] = Array.from({ length: 16 }, (_, i) => ({
  ctrl: !!(i & 1),
  shift: !!(i & 2),
  alt: !!(i & 4),
  meta: !!(i & 8),
}));
const tag = (m: Mods) => `${m.ctrl ? "C" : "-"}${m.shift ? "S" : "-"}${m.alt ? "A" : "-"}${m.meta ? "M" : "-"}`;
const CANVAS_T = { tagName: "CANVAS" };
function kev(key: string, code: string, m: Mods = {}, extra: Mod = {}): Mod {
  const e: Mod = {
    type: "keydown",
    key,
    code,
    ctrlKey: !!m.ctrl,
    shiftKey: !!m.shift,
    altKey: !!m.alt,
    metaKey: !!m.meta,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    target: CANVAS_T,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
    stopImmediatePropagation() {
      e.stopped = true;
    },
    ...extra,
  };
  return e;
}
function pev(button: number, m: Mods = {}, extra: Mod = {}): Mod {
  const e: Mod = {
    type: "pointerdown",
    button,
    ctrlKey: !!m.ctrl,
    shiftKey: !!m.shift,
    altKey: !!m.alt,
    metaKey: !!m.meta,
    clientX: 100,
    clientY: 100,
    pointerId: 1,
    pointerType: "mouse",
    target: CANVAS_T,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
    ...extra,
  };
  return e;
}
const MOD_KEYS: [keyof Mods, string, string][] = [
  ["ctrl", "Control", "ControlLeft"],
  ["shift", "Shift", "ShiftLeft"],
  ["alt", "Alt", "AltLeft"],
  ["meta", "Meta", "MetaLeft"],
];
const CODES: string[] = [
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  "NumpadEnter",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "BracketLeft",
  "BracketRight",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Backslash",
  "Minus",
  "Equal",
  "Backquote",
  "IntlRo",
  "IntlYen",
  "Delete",
  "Backspace",
  "Enter",
  "Space",
  "Escape",
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "ControlLeft",
  "ShiftLeft",
  "AltLeft",
  "MetaLeft",
  "IntlBackslash",
];
const binding = (code: string, i: number): Mod => {
  const b: Mod = { code };
  if (i & 1) b.ctrl = true;
  if (i & 2) b.shift = true;
  if (i & 4) b.alt = true;
  return b;
};
/** 表記の検査に使う割り当ての全部（キー×修飾 8 通り・クリック 3 種×8 通り・タップ 3 種） */
function labelBattery(): Mod[] {
  const out: Mod[] = [];
  for (const code of CODES) for (let i = 0; i < 8; i++) out.push(binding(code, i));
  for (const button of [0, 1, 2]) for (let i = 0; i < 8; i++) out.push({ ...binding("", i), button });
  for (const tap of ["Control", "Shift", "Alt"]) out.push({ code: "", tap });
  return out;
}
/** 利用者のプリセット（照合・編集画面の検査に使う）。タップ・＋クリック・⇧Ctrl+Z の上書きを含む */
const USER_PRESETS: Mod[] = [
  {
    id: "u1",
    name: "u1",
    bindings: {
      "edit.undo": { code: "", tap: "Control" },
      "edit.redo": { code: "", tap: "Alt" },
      "edit.pickColor": { code: "", button: 0, ctrl: true },
      "tool.pen": { code: "KeyZ", ctrl: true, shift: true },
      "file.save": { code: "KeyS", alt: true },
    },
  },
  {
    id: "u2",
    name: "u2",
    bindings: {
      "tool.pen": { code: "KeyP" },
      "tool.brush": { code: "KeyP" },
      "view.zoomIn": { code: "", button: 2, ctrl: true, shift: true },
      "edit.copy": { code: "", tap: "Shift" },
      "frame.add": { code: "KeyN", ctrl: true },
    },
  },
];
const lookupLines = (L: Map<string, string[]>) =>
  [...L.entries()].map(([k, v]) => `${k}=${v.join(",")}`).sort();
const sha = (lines: string[]) => crypto.createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
function setMac(T: Tree, mac: boolean | null) {
  T.P?.setMacPlatformForTest(mac);
}

// ================= main.ts の captureKey（設定画面のキー取得）を**そのまま取り出して**動かす =================
class FakeWindow {
  ls: { type: string; fn: (e: Mod) => void; cap: boolean }[] = [];
  addEventListener(type: string, fn: (e: Mod) => void, opt?: unknown) {
    this.ls.push({ type, fn, cap: opt === true || (opt as Mod)?.capture === true });
  }
  removeEventListener(type: string, fn: (e: Mod) => void, opt?: unknown) {
    const cap = opt === true || (opt as Mod)?.capture === true;
    this.ls = this.ls.filter((l) => !(l.type === type && l.fn === fn && l.cap === cap));
  }
  fire(type: string, e: Mod) {
    for (const l of [...this.ls]) if (l.type === type) l.fn(e);
  }
}
function findFunctionText(src: string, name: string): string {
  const sf = ts.createSourceFile("main.ts", src, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements)
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st.getText(sf);
  throw new Error(`main.ts に function ${name} が無い`);
}
/** main.ts の `import { … } from "./keymap"` / `"./platform"` を読んで、ローカル名 → 値の表を作る（別名も解く） */
function importScope(src: string, T: Tree): Record<string, unknown> {
  const sf = ts.createSourceFile("main.ts", src, ts.ScriptTarget.Latest, true);
  const scope: Record<string, unknown> = {};
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const mod = spec === "./keymap" ? T.K : spec === "./platform" ? T.P : null;
    if (!mod) continue;
    const nb = st.importClause?.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) {
      if (el.isTypeOnly) continue;
      scope[el.name.text] = mod[(el.propertyName ?? el.name).text];
    }
  }
  return scope;
}
type Act = ["down" | "up", string, string, Mods, Mod?] | ["ptr", number, Mods] | ["wait", number] | ["blur"];
function makeCapture(T: Tree) {
  const js = ts.transpileModule(findFunctionText(T.mainSrc, "captureKey"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const scope = importScope(T.mainSrc, T);
  const names = Object.keys(scope);
  const win = new FakeWindow();
  const clock = { t: 1000 };
  const perf = { now: () => clock.t };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const captureKey = new Function(...names, "window", "performance", `"use strict";\n${js}\nreturn captureKey;`)(
    ...names.map((n) => scope[n]),
    win,
    perf
  ) as () => { promise: Promise<unknown>; cancel: () => void };
  /** 直前の run で流したイベントごとの「既定の動きを止めたか（P）・伝わるのを止めたか（S）」（独立レビュー 1 回目の低 3） */
  let flags = "";
  /** 一連の操作を流して、取れた割り当て（JSON）／"pending"（まだ待っている）／"null"（Escape）を返す */
  async function run(acts: Act[]): Promise<string> {
    const cap = captureKey();
    let val: unknown = undefined;
    void cap.promise.then((v) => (val = v));
    const evs: Mod[] = [];
    for (const a of acts) {
      if (win.ls.length === 0) break; // 取り終わった
      if (a[0] === "wait") clock.t += a[1];
      else if (a[0] === "blur") win.fire("blur", {});
      else {
        const e =
          a[0] === "ptr"
            ? pev(a[1], a[2])
            : kev(a[1], a[2], a[3], { ...(a[4] ?? {}), type: a[0] === "down" ? "keydown" : "keyup" });
        evs.push(e);
        win.fire(e.type, e);
      }
    }
    flags = evs.map((e) => `${e.defaultPrevented ? "P" : "-"}${e.stopped ? "S" : "-"}`).join(",");
    const pending = win.ls.length > 0;
    if (pending) cap.cancel();
    await Promise.resolve();
    await Promise.resolve();
    if (win.ls.length) return "LEAK";
    return pending ? "pending" : JSON.stringify(val);
  }
  return { run, flags: () => flags };
}
// ★独立レビュー 1 回目の低 3: ホーム画面の ⌘,（V153）の preventDefault がどの検査にも入っていなかった。
//  captureKey と同じく、main.ts の homeKeyBlocked / homeKeyHandler / homeKeyUpHandler を**そのまま取り出して**動かす。
//  main.ts のほかの変数（editorOpen・homeLookup・homeModTap・openSettingsMenu・document）は引数で渡す
const BODY_T = { tagName: "BODY" };
/** ホーム画面のタップで設定を開く利用者のプリセット（V165 のタップ × V153 の app.settings） */
const HOME_TAP_PRESET: Mod = { id: "u3", name: "u3", bindings: { "app.settings": { code: "", tap: "Control" } } };
function makeHome(T: Tree, preset: Mod, opts: { modal?: boolean } = {}) {
  const src = T.mainSrc;
  const sf = ts.createSourceFile("main.ts", src, ts.ScriptTarget.Latest, true);
  const wanted = new Set(["homeKeyBlocked", "homeKeyHandler", "homeKeyUpHandler"]);
  const parts: string[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && wanted.has(st.name.text)) parts.push(st.getText(sf));
    else if (
      ts.isVariableStatement(st) &&
      st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && wanted.has(d.name.text))
    )
      parts.push(st.getText(sf));
  }
  if (parts.length !== 3) throw new Error(`main.ts のホームのキーの部品が ${parts.length} つ（3 つのはず）`);
  const js = ts.transpileModule(parts.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const scope = importScope(src, T);
  const names = Object.keys(scope);
  const calls: string[] = [];
  const doc = { querySelector: (sel: string) => (sel === ".modal-back" && opts.modal ? {} : null) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const H = new Function(
    ...names,
    "editorOpen",
    "homeLookup",
    "homeModTap",
    "openSettingsMenu",
    "document",
    `"use strict";\n${js}\nreturn { homeKeyHandler, homeKeyUpHandler };`
  )(
    ...names.map((n) => scope[n]),
    false,
    T.K.buildLookup(preset),
    new T.K.ModTapWatcher(),
    async () => void calls.push("settings"),
    doc
  ) as { homeKeyHandler: (e: Mod) => void; homeKeyUpHandler: (e: Mod) => void };
  const key = (e: Mod): string => {
    calls.length = 0;
    H.homeKeyHandler(e);
    return `${calls.join("+") || "-"}${e.defaultPrevented ? " pd" : ""}`;
  };
  const tap = (k: string, c: string, target: Mod = BODY_T): string => {
    calls.length = 0;
    const d = kev(k, c, {}, { target });
    const u = kev(k, c, {}, { target, type: "keyup" });
    H.homeKeyHandler(d);
    H.homeKeyUpHandler(u);
    return `${calls.join("+") || "-"}${d.defaultPrevented || u.defaultPrevented ? " pd" : ""}`;
  };
  return { key, tap };
}
function homeBattery(T: Tree): string[] {
  const out: string[] = [];
  for (const p of [...T.K.BUILTIN_PRESETS, ...USER_PRESETS, HOME_TAP_PRESET]) {
    const H = makeHome(T, p);
    for (const [k, code] of [
      [",", "Comma"],
      ["s", "KeyS"],
      ["z", "KeyZ"],
    ])
      for (const m of MOD16) {
        out.push(`home ${p.id} ${code} ${tag(m)} => ${H.key(kev(k, code, m, { target: BODY_T }))}`);
        out.push(`home ${p.id} ${code} ${tag(m)} input => ${H.key(kev(k, code, m, { target: { tagName: "INPUT" } }))}`);
      }
    for (const [, k, c] of MOD_KEYS) out.push(`home ${p.id} tap ${k} => ${H.tap(k, c)}`);
    const HM = makeHome(T, p, { modal: true });
    for (const m of MOD16) out.push(`home ${p.id} modal , ${tag(m)} => ${HM.key(kev(",", "Comma", m, { target: BODY_T }))}`);
  }
  return out;
}
/** 修飾キーを ctrl→shift→alt→meta の順に押して、最後に本命のキーを押す */
function combo(key: string, code: string, m: Mods): Act[] {
  const acts: Act[] = [];
  const held: Mods = {};
  for (const [flag, k, c] of MOD_KEYS) {
    if (!m[flag]) continue;
    held[flag] = true;
    acts.push(["down", k, c, { ...held }]);
  }
  acts.push(["down", key, code, m]);
  return acts;
}
const CAPTURE_KEYS: [string, string][] = [
  ["s", "KeyS"],
  ["z", "KeyZ"],
  [",", "Comma"],
  ["Enter", "Enter"],
  ["Delete", "Delete"],
  ["F5", "F5"],
  ["1", "Numpad1"],
  ["`", "Backquote"],
  ["Escape", "Escape"],
];
async function captureBattery(T: Tree): Promise<string[]> {
  const C0 = makeCapture(T);
  // 取れた形に、流したイベントごとの preventDefault（P）・stopPropagation（S）を添える
  const C = { run: async (acts: Act[]) => `${await C0.run(acts)} [${C0.flags()}]` };
  const out: string[] = [];
  for (const [k, code] of CAPTURE_KEYS)
    for (const m of MOD16) out.push(`key ${code} ${tag(m)} => ${await C.run(combo(k, code, m))}`);
  for (const [, k, c] of MOD_KEYS)
    for (const held of [0, 100, 250, 251])
      out.push(`tap ${k} ${held} => ${await C.run([["down", k, c, {}], ["wait", held], ["up", k, c, {}]])}`);
  for (const button of [0, 1, 2])
    for (const m of MOD16) out.push(`ptr ${button} ${tag(m)} => ${await C.run([["ptr", button, m]])}`);
  // 修飾キーを押してからクリック（タップ候補はクリックで壊れる）・押しっぱなし・フォーカスが外れた
  for (const [flag, k, c] of MOD_KEYS) {
    out.push(`mod+ptr ${k} => ${await C.run([["down", k, c, { [flag]: true }], ["ptr", 0, { [flag]: true }]])}`);
    out.push(
      `repeat ${k} => ${await C.run([["down", k, c, {}, { repeat: true }], ["wait", 10], ["up", k, c, {}]])}`
    );
    out.push(`blur ${k} => ${await C.run([["down", k, c, {}], ["blur"], ["up", k, c, {}]])}`);
    out.push(
      `other-up ${k} => ${await C.run([["down", k, c, {}], ["wait", 10], ["up", "Shift", "ShiftLeft", {}]])}`
    );
  }
  // ★第三者レビュー X10 / X19: 修飾キーを 2 つ重ねる（2 つ目は候補を壊す・Win と押しっぱなしも）。
  //  以前は 1 つずつの形しか流していなかったので、「2 つ目の修飾キーで候補を壊す」を外しても緑だった
  for (const [fa, ka, ca] of MOD_KEYS)
    for (const [fb, kb, cb] of MOD_KEYS) {
      if (ka === kb) continue;
      const both = { [fa]: true, [fb]: true } as Mods;
      out.push(
        `pair ${ka}>${kb} up-b-a => ${await C.run([
          ["down", ka, ca, { [fa]: true }],
          ["down", kb, cb, both],
          ["up", kb, cb, { [fa]: true }],
          ["up", ka, ca, {}],
        ])}`
      );
      out.push(
        `pair ${ka}>${kb} up-a => ${await C.run([
          ["down", ka, ca, { [fa]: true }],
          ["down", kb, cb, both],
          ["up", ka, ca, { [fb]: true }],
        ])}`
      );
    }
  for (const [fa, ka, ca] of MOD_KEYS)
    out.push(
      `rep-mid ${ka} => ${await C.run([
        ["down", ka, ca, { [fa]: true }],
        ["down", ka, ca, { [fa]: true }, { repeat: true }],
        ["up", ka, ca, {}],
      ])}`
    );
  // ⌘/Win と Ctrl を両方押して離す（2 つ目の修飾キーは候補を壊す）
  out.push(
    `meta+ctrl => ${await C.run([
      ["down", "Meta", "MetaLeft", { meta: true }],
      ["down", "Control", "ControlLeft", { meta: true, ctrl: true }],
      ["up", "Control", "ControlLeft", { meta: true }],
      ["up", "Meta", "MetaLeft", {}],
    ])}`
  );
  return out;
}

// ================= 本物の editor.ts =================
function makeEd(T: Tree, preset: Mod) {
  const ed = new T.Editor();
  const calls: string[] = [];
  ed.cb = { toast: () => {}, appendLog: () => {} };
  ed.mounted = true;
  ed.runCommand = (id: string) => void calls.push(`cmd:${id}`);
  ed.commitTextDraft = () => void calls.push("commitText");
  for (const k of ["refreshShapePreview", "rebuildLayers", "renderCanvas", "redrawOverlay", "updatePanCursor"])
    ed[k] = () => {};
  ed.applyKeyPreset(preset);
  /** keydown を 1 回（V157 の二重発火の防御は検査の連打で効かないよう毎回空にする） */
  const key = (e: Mod): string => {
    calls.length = 0;
    ed.lastCommandAt = new Map();
    ed.keydownHandler(e);
    return `${calls.join("+") || "-"}${e.defaultPrevented ? " pd" : ""}`;
  };
  /** 修飾キーを押してすぐ離す（タップ）。keydown と keyup の両方の口を通す */
  const tap = (k: string, c: string, target: Mod = CANVAS_T): string => {
    calls.length = 0;
    ed.lastCommandAt = new Map();
    const d = kev(k, c, {}, { target });
    const u = kev(k, c, {}, { target, type: "keyup" });
    ed.keydownHandler(d);
    ed.keyupHandler(u);
    return `${calls.join("+") || "-"}${d.defaultPrevented || u.defaultPrevented ? " pd" : ""}`;
  };
  return { ed, calls, key, tap };
}
const ED_KEYS: [string, string][] = [
  ["z", "KeyZ"],
  ["y", "KeyY"],
  ["c", "KeyC"],
  ["x", "KeyX"],
  ["v", "KeyV"],
  ["s", "KeyS"],
  ["h", "KeyH"],
  ["p", "KeyP"],
  ["q", "KeyQ"],
  ["n", "KeyN"],
  [",", "Comma"],
  ["Delete", "Delete"],
  ["Backspace", "Backspace"],
  ["Enter", "Enter"],
  ["[", "BracketLeft"],
  ["1", "Digit1"],
  ["F5", "F5"],
];
function editorBattery(T: Tree): string[] {
  const out: string[] = [];
  const presets = [...T.K.BUILTIN_PRESETS, ...USER_PRESETS];
  for (const p of presets) {
    const E = makeEd(T, p);
    for (const [k, code] of ED_KEYS) for (const m of MOD16) out.push(`${p.id} ${code} ${tag(m)} => ${E.key(kev(k, code, m))}`);
    // 押しっぱなしのくり返し（Windows では「くり返さない命令」の 2 回目以降は preventDefault しない＝この回の前のまま）
    for (const [k, code] of ED_KEYS)
      for (const m of MOD16) out.push(`${p.id} ${code} ${tag(m)} repeat => ${E.key(kev(k, code, m, { repeat: true }))}`);
    for (const [, k, c] of MOD_KEYS) out.push(`${p.id} tap ${k} => ${E.tap(k, c)}`);
    // 文字の確定（Ctrl+Enter）: 浮動テキストがあるとき
    E.ed.textDraft = { text: "x" };
    for (const m of MOD16) out.push(`${p.id} draft Enter ${tag(m)} => ${E.key(kev("Enter", "Enter", m))}`);
    E.ed.textDraft = null;
  }
  // 行の選択（レイヤー／フォルダ・Ctrl=トグル・Shift=範囲）
  const E = makeEd(T, T.K.BUILTIN_PRESETS[0]);
  const ed = E.ed;
  for (const kind of ["layer", "folder"] as const)
    for (const pre of [null, "F1"])
      for (const m of MOD16) {
        ed.suppressRowClick = false;
        ed.displayRows = ["L1", "F1", "L2"].map((id) => ({ id }));
        ed.selectedNodeIds = new Set(["L1"]);
        ed.selAnchorId = "L1";
        ed.selectedFolderId = pre;
        ed.activeLayerId = "L1";
        const id = kind === "folder" ? "F1" : "L2";
        ed.updateSelection(id, kind, { ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });
        out.push(
          `sel ${kind} pre=${pre} ${tag(m)} => nodes=${[...ed.selectedNodeIds].sort().join(",")} folder=${ed.selectedFolderId} active=${ed.activeLayerId} anchor=${ed.selAnchorId}`
        );
      }
  return out;
}

// ================= Windows の「この回の前」と比べる材料（言語に依らない部分） =================
function keymapBattery(T: Tree): string[] {
  const K = T.K;
  const out: string[] = [];
  for (const code of CODES)
    for (const m of MOD16) {
      const e = kev("x", code, m);
      out.push(`ek ${code} ${tag(m)} ${K.eventKey(e)} ${JSON.stringify(K.bindingFromEvent(e))}`);
    }
  for (const button of [0, 1, 2])
    for (const m of MOD16) {
      const e = pev(button, m);
      out.push(`pk ${button} ${tag(m)} ${K.pointerEventKey(e)} ${JSON.stringify(K.bindingFromPointer(e))}`);
      // meta を持たない形（旧来の呼び方・m16 のスモーク）でも同じ
      const { metaKey: _m, ...noMeta } = e;
      out.push(`pk- ${button} ${tag(m)} ${JSON.stringify(K.bindingFromPointer(noMeta))}`);
    }
  for (const b of labelBattery()) out.push(`bk ${JSON.stringify(b)} ${K.bindingKey(b)}`);
  for (const p of [...K.BUILTIN_PRESETS, ...USER_PRESETS]) out.push(`lk ${p.id} ${lookupLines(K.buildLookup(p)).join(" ")}`);
  for (const k of ["Control", "Shift", "Alt", "Meta", "a", "Fn", ""]) out.push(`tm ${k} ${K.isTapMod(k)}`);
  out.push(...tapWatcherBattery(T));
  const fresh = K.sanitizeKeysSettings(undefined);
  out.push(`fresh ${JSON.stringify(fresh)} ${lookupLines(K.buildLookup(K.activePreset(fresh))).join(" ")}`);
  return out;
}
function tapWatcherBattery(T: Tree): string[] {
  const out: string[] = [];
  const keys = ["Control", "Shift", "Alt", "Meta", "a", "Fn"];
  for (const k of keys)
    for (const held of [0, 100, 250, 251]) {
      let now = 0;
      const w = new T.K.ModTapWatcher(() => now);
      w.down(k);
      now += held;
      out.push(`tw ${k} ${held} ${w.up(k)}`);
    }
  for (const a of keys)
    for (const b of keys) {
      let now = 0;
      const w = new T.K.ModTapWatcher(() => now);
      w.down(a);
      w.down(b);
      now += 10;
      out.push(`tw2 ${a}>${b} up(a)=${w.up(a)}`);
      w.down(a);
      now += 10;
      out.push(`tw3 ${a} up(${b})=${w.up(b)} pend=${w.pending}`);
    }
  for (const k of keys) {
    let now = 0;
    const w = new T.K.ModTapWatcher(() => now);
    w.down(k, { repeat: true });
    out.push(`twr ${k} ${w.up(k)}`);
    w.down(k, { blocked: true });
    out.push(`twb ${k} ${w.up(k)}`);
    w.down(k);
    const p = w.pending;
    w.cancel();
    out.push(`twc ${k} pend=${p} ${w.up(k)}`);
  }
  return out;
}

// ================= 表記の検査側の実装（oracle）: 要件 G-3 をこちらでも独立に書く =================
// 実装（src/platform.ts）は正規表現で置き換える。こちらは 1 文字ずつ読む別の書き方にして、両者の一致を見る
const SYM: Record<string, string> = { Alt: "⌥", Shift: "⇧", Ctrl: "⌘" };
const RANK: Record<string, number> = { "⌥": 1, "⇧": 2, "⌘": 3 }; // Mac のメニューの並び ⌃⌥⇧⌘（⌃ は出ない）
const KEY_NAMES = [
  "Backspace",
  "PageDown",
  "PageUp",
  "Escape",
  "Delete",
  "Insert",
  "Enter",
  "Space",
  "Home",
  "End",
  "Tab",
  "Esc",
  "F12",
  "F11",
  "F10",
  "F9",
  "F8",
  "F7",
  "F6",
  "F5",
  "F4",
  "F3",
  "F2",
  "F1",
];
const isW = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
function modAt(s: string, j: number): string | null {
  for (const m of ["Ctrl", "Alt", "Shift"])
    if (s.startsWith(m, j) && !isW(s[j - 1]) && !isW(s[j + m.length])) return m;
  return null;
}
function capAt(s: string, j: number): string | null {
  const free = (len: number) => !/[A-Za-z0-9]/.test(s[j + len] ?? "");
  for (const n of KEY_NAMES) if (s.startsWith(n, j) && free(n.length)) return n;
  const c = s[j];
  if (c === undefined) return null;
  if ("¥＿←→↑↓".includes(c)) return c;
  if (c >= "!" && c <= "~" && free(1)) return c;
  return null;
}
function oracleMac(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const m = modAt(s, i);
    if (!m) {
      out += s[i++];
      continue;
    }
    const set = new Set([m]);
    let j = i + m.length;
    while (s[j] === "+" || s[j] === "＋") {
      const m2 = modAt(s, j + 1);
      if (!m2) break;
      set.add(m2);
      j += 1 + m2.length;
    }
    const sym = ["Alt", "Shift", "Ctrl"].filter((x) => set.has(x)).map((x) => SYM[x]).join("");
    if (s[j] === "+" || s[j] === "＋") {
      const cap = capAt(s, j + 1);
      if (cap) {
        out += sym + cap;
        i = j + 1 + cap.length;
        continue;
      }
    }
    out += sym;
    i = j;
  }
  return out;
}
const MOD_WORD = /\b(Ctrl|Alt|Shift)\b/;
const countOf = (s: string, re: RegExp) => (s.match(re) ?? []).length;
/** 記号の並びが ⌥⇧⌘ の順（重なりなし）か */
function symOrderOk(s: string): boolean {
  for (const run of s.match(/[⌥⇧⌘]+/g) ?? []) {
    let prev = 0;
    for (const c of run) {
      if (RANK[c] <= prev) return false;
      prev = RANK[c];
    }
  }
  return true;
}

// ★辞書の「Ctrl」「Alt」「Shift」を含む文言の件数（2026-09-25・54cfbf5 の辞書を数えた）。**増減したら分類し直す**
// V195（2026-10-05）: 7 言語とも +3（`ed.color.delete.msg`・`ed.color.deleted.toast`・`ed.color.usedHistory.toast`。
//   どれも「Ctrl+Z」＝キーの表記として ⌘Z に置き換わる側＝NON_KEY_EXPECTED には入れない。置き換えの検査は緑のまま）
// V215（2026-11-01・A-125［整理］）: ja は +2（`ed.color.tidy.confirm.msg`・`ed.color.tidy.done.toast`）・ほかの 6 言語は +4
//   （その 2 つと `ed.color.tidy.confirmKeep.msg`・`ed.color.tidy.keptOnly.toast`。ja のこの 2 つは「取り消しの記録」と書き、Ctrl+Z を書かない）。
//   どれも「Ctrl+Z」＝キーの表記＝NON_KEY_EXPECTED には入れない
const DICT_COUNTS: Record<string, { entries: number; Ctrl: number; Alt: number; Shift: number }> = {
  ja: { entries: 19, Ctrl: 16, Alt: 2, Shift: 8 },
  en: { entries: 22, Ctrl: 18, Alt: 2, Shift: 9 },
  es: { entries: 21, Ctrl: 18, Alt: 2, Shift: 8 },
  "pt-BR": { entries: 21, Ctrl: 18, Alt: 2, Shift: 8 },
  ko: { entries: 21, Ctrl: 18, Alt: 2, Shift: 8 },
  "zh-Hans": { entries: 21, Ctrl: 18, Alt: 2, Shift: 8 },
  "zh-Hant": { entries: 21, Ctrl: 18, Alt: 2, Shift: 8 },
};
/** キーではない語として「Ctrl / Alt / Shift」を含む訳文（言語・辞書のキー）。Mac でも置き換えない */
const NON_KEY_EXPECTED = ["en ed.tone.ditherShift.label"];
/** 指示書の例（要件 G-3・[D]）。ja の画面に**この姿で**出ること */
const ANCHORS_JA: [string, (s: string) => boolean, string][] = [
  ["ed.undo.title", (s) => s === "元に戻す (⌘Z)", "元に戻す (⌘Z)"],
  ["ed.saveAs.title", (s) => s.endsWith("(⇧⌘S)"), "…(⇧⌘S)"],
  ["guide.recent.msg", (s) => s.includes("⌥＋クリック＝スポイト"), "…⌥＋クリック＝スポイト…"],
  ["keys.cmd.appSettings.hint", (s) => s === "ホーム画面で使えます（既定 ⌘,）", "ホーム画面で使えます（既定 ⌘,）"],
  ["keys.tap.msg", (s) => s.startsWith("⌘ / ⇧ / ⌥ は、単独で"), "⌘ / ⇧ / ⌥ は、単独で…"],
  ["ed.redo.title", (s) => s === "やり直し (⌘Y)", "やり直し (⌘Y)"],
  ["ed.tl.copyFrames.title", (s) => s.includes("⇧+クリックで範囲選択 / ⇧⌘C"), "…⇧+クリックで範囲選択 / ⇧⌘C）"],
  ["ed.text.draftingHint.hint", (s) => s.includes("⌘Enter で確定"), "…⌘Enter で確定…"],
];

// =====================================================================================
// [S-A] 判定
// =====================================================================================
async function groupSA(T: Tree): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  const P = T.P;
  await add("[S-A] src/platform.ts がある（Mac のふりを注入できる）", () => (P ? ok() : ng("platform.ts が無い")));
  if (!P) return r;
  const WK =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"; // M-1（作者の実測）
  const WV2 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";
  const cases: [string, unknown, boolean][] = [
    ["M-1 の実測（MacIntel・Macintosh）", { platform: "MacIntel", userAgent: WK }, true],
    ["platform だけ Mac（UA が空）", { platform: "MacIntel", userAgent: "" }, true],
    ["UA だけ Macintosh（platform が空＝予備）", { platform: "", userAgent: WK }, true],
    ["Windows の WebView2（Win32）", { platform: "Win32", userAgent: WV2 }, false],
    ["★Node on macOS（platform=MacIntel・UA=Node.js/24）は判定しない", { platform: "MacIntel", userAgent: "Node.js/24" }, false],
    ["Node on Windows", { platform: "Win32", userAgent: "Node.js/24" }, false],
    ["navigator が無い", undefined, false],
    ["型が違う", { platform: 1, userAgent: null }, false],
  ];
  for (const [label, nav, want] of cases)
    await add(`[S-A] detectMacFrom: ${label} → ${want}`, () =>
      P.detectMacFrom(nav) === want ? ok() : ng(`${P.detectMacFrom(nav)}`)
    );
  await add("[S-A] 注入なしのこの機械（Node）では Windows 扱い（検査の結果が機械で変わらない）", () => {
    P.setMacPlatformForTest(null);
    return P.isMacPlatform() === false ? ok() : ng("Mac と判定した");
  });
  await add("[S-A] 注入が効く（true → Mac・false → Windows・null → 戻る）", () => {
    P.setMacPlatformForTest(true);
    const a = P.isMacPlatform();
    P.setMacPlatformForTest(false);
    const b = P.isMacPlatform();
    P.setMacPlatformForTest(null);
    const c = P.isMacPlatform();
    return a === true && b === false && c === false ? ok() : ng(`${a}/${b}/${c}`);
  });
  // navigator の platform / userAgent を読むのは platform.ts だけ（判定を 1 か所に）
  await add("[S-A] ★navigator.platform / userAgent を読むのは src/platform.ts だけ", () => {
    const bad: string[] = [];
    for (const [file, src] of srcFiles(T.dir)) {
      if (file === "src/platform.ts") continue;
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (
          ts.isPropertyAccessExpression(n) &&
          ["platform", "userAgent", "userAgentData"].includes(n.name.text) &&
          n.expression.getText(sf).endsWith("navigator")
        )
          bad.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.getText(sf)}`);
        n.forEachChild(visit);
      };
      visit(sf);
    }
    return bad.length === 0 ? ok() : ng(bad.join(" / "));
  });
  // ★独立レビュー 1 回目の穴: 上の検査は「純関数」と「注入」しか通らず、**アプリが使う経路**（注入しない
  //  isMacPlatform() が最初の呼び出しで navigator を読んで覚える）を Mac の navigator で一度も動かしていなかった
  //  （覚えの初期値を false にしても 107/0 のまま）。**この木の src をもう一度写して新しい実体として読み込み**、
  //  navigator を差し替えたまま、注入を一度もしないで動かす＝起動したアプリと同じ道
  // platform の読みを数える（1 回の判定の中で何回読むかは実装の都合＝数えるのは「判定のあとに増えないこと」）
  const reads = { n: 0, afterFirst: -1, end: -1 };
  const macNav = {
    get platform() {
      reads.n++;
      return "MacIntel";
    },
    userAgent: WK,
  };
  await add("[S-A] ★注入なしの経路（アプリと同じ）: Mac の navigator（M-1）で読み込んだ木は、最初の呼び出しで Mac と判定する（⌘Z・⇧⌘Z・表記まで）", () =>
    withNavigator(macNav, async () => {
      const F = await freshCopy(T);
      if (!F.P) return ng("写しに platform.ts が無い");
      const mac = F.P.isMacPlatform();
      reads.afterFirst = reads.n; // ここで判定は済んでいる（読み込みの途中の t() で済んでいることもある）
      const z = F.K.eventKey(kev("z", "KeyZ", { meta: true }));
      const L: Map<string, string[]> = F.K.buildLookup(F.K.BUILTIN_PRESETS[0]);
      const redo = L.get(F.K.eventKey(kev("z", "KeyZ", { meta: true, shift: true })))?.join(",");
      F.I.setLang("ja");
      const title = F.I.t("ed.undo.title");
      const label = F.K.keyLabel({ code: "KeyS", ctrl: true, shift: true });
      for (let i = 0; i < 3; i++) F.P.isMacPlatform();
      reads.end = reads.n;
      const got = `${mac} ${z} ${redo} ${title} ${label}`;
      return got === "true C|KeyZ edit.redo 元に戻す (⌘Z) ⇧⌘S" ? ok() : ng(got);
    })
  );
  await add("[S-A] 注入なしの経路: 判定のあとは navigator を読み直さない（一度読んだら覚える）", () =>
    reads.afterFirst > 0 && reads.end === reads.afterFirst
      ? ok()
      : ng(`判定までに ${reads.afterFirst} 回・そのあと ${reads.end - reads.afterFirst} 回読んだ`)
  );
  await add("[S-A] 注入なしの経路: platform が空でも UA の Macintosh（予備）で Mac と判定する", () =>
    withNavigator({ platform: "", userAgent: WK }, async () => {
      const F = await freshCopy(T);
      const got = `${F.P?.isMacPlatform()} ${F.K.eventKey(kev("z", "KeyZ", { meta: true }))}`;
      return got === "true C|KeyZ" ? ok() : ng(got);
    })
  );
  await add("[S-A] 注入なしの経路: Node の navigator（macOS 上の Node＝MacIntel・Node.js/24）では Windows のまま", () =>
    withNavigator({ platform: "MacIntel", userAgent: "Node.js/24" }, async () => {
      const F = await freshCopy(T);
      const got = `${F.P?.isMacPlatform()} ${F.K.eventKey(kev("z", "KeyZ", { meta: true }))}`;
      return got === "false M|KeyZ" ? ok() : ng(got);
    })
  );
  await add("[S-A] ★注入なしの経路: WebView2 の navigator で読み込んだ木は Windows（Win+Z は一致しない・表記は Ctrl）", () =>
    withNavigator({ platform: "Win32", userAgent: WV2 }, async () => {
      const F = await freshCopy(T);
      if (!F.P) return ng("写しに platform.ts が無い");
      const mac = F.P.isMacPlatform();
      const z = F.K.eventKey(kev("z", "KeyZ", { meta: true }));
      F.I.setLang("ja");
      const title = F.I.t("ed.undo.title");
      const got = `${mac} ${z} ${title}`;
      return got === "false M|KeyZ 元に戻す (Ctrl+Z)" ? ok() : ng(got);
    })
  );
  return r;
}
/** navigator を差し替えて fn を走らせ、必ず元へ戻す（Node の navigator は差し替えのきく getter） */
async function withNavigator(nav: unknown, fn: () => Promise<V>): Promise<V> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
}
/** 検査中の木（反証の写しを含む）の src をもう一度写して、**新しい実体**として読み込む（判定の覚えも白紙）。
 *  edits は写しにだけ当てる（検査用の辞書の 1 行など） */
async function freshCopy(T: Tree, edits: Edit[] = []): Promise<Tree> {
  const dir = path.join(WORK, `f${++seq}`);
  fs.cpSync(path.join(T.dir, "src"), path.join(dir, "src"), {
    recursive: true,
    filter: (s) => fs.statSync(s).isDirectory() || s.endsWith(".ts"),
  });
  const why = applyEdits(dir, edits);
  if (why) throw new Error(why);
  return loadTree(dir, `fresh${seq}`);
}

// =====================================================================================
// [S-1] ★Mac のふり: ⌘ で全部効く
// =====================================================================================
async function groupS1(T: Tree): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  const K = T.K;
  // Windows で Ctrl を押したときに引ける命令（期待値）を先に作る
  const winCmd = new Map<string, string>();
  setMac(T, false);
  const winL = new Map<string, Map<string, string[]>>();
  for (const p of [...K.BUILTIN_PRESETS, ...USER_PRESETS]) winL.set(p.id, K.buildLookup(p));
  setMac(T, true);
  try {
    for (const p of K.BUILTIN_PRESETS as Mod[]) {
      const L: Map<string, string[]> = K.buildLookup(p);
      const WL = winL.get(p.id)!;
      // 組み込みの割り当て＋固定キーのうち Ctrl を持つもの（キーボード）
      const ctrlB: Mod[] = [];
      for (const b of Object.values(p.bindings) as Mod[]) if (b.ctrl && b.button === undefined && !b.tap) ctrlB.push(b);
      for (const b of [
        { code: "KeyZ", ctrl: true },
        { code: "KeyY", ctrl: true },
        { code: "KeyC", ctrl: true },
        { code: "KeyX", ctrl: true },
        { code: "KeyV", ctrl: true },
        { code: "KeyS", ctrl: true },
        { code: "KeyS", ctrl: true, shift: true },
        { code: "KeyC", ctrl: true, shift: true },
        { code: "KeyV", ctrl: true, shift: true },
        { code: "Comma", ctrl: true },
      ])
        ctrlB.push(b);
      let n = 0;
      const bad: string[] = [];
      for (const b of ctrlB) {
        const want = WL.get(K.bindingKey(b))?.join(",") ?? "";
        const mods = { shift: !!b.shift, alt: !!b.alt };
        const viaMeta = L.get(K.eventKey(kev("x", b.code, { ...mods, meta: true })))?.join(",") ?? "";
        const viaCtrl = L.get(K.eventKey(kev("x", b.code, { ...mods, ctrl: true })))?.join(",") ?? "";
        const viaBoth = L.get(K.eventKey(kev("x", b.code, { ...mods, ctrl: true, meta: true })))?.join(",") ?? "";
        n++;
        if (!want || viaMeta !== want || viaCtrl !== want || viaBoth !== want)
          bad.push(`${K.bindingKey(b)} want=${want || "∅"} ⌘=${viaMeta || "∅"} ⌃=${viaCtrl || "∅"} 両方=${viaBoth || "∅"}`);
      }
      await add(`[S-1] ★「${p.id}」の Ctrl 系 ${n} 通りが ⌘ でも control でも両方押しても、Windows の Ctrl と同じ命令`, () =>
        n >= 10 && bad.length === 0 ? ok() : ng(bad.slice(0, 4).join(" / ") || `n=${n}`)
      );
      const get = (code: string, m: Mods) => L.get(K.eventKey(kev("x", code, m)))?.join(",") ?? "∅";
      await add(`[S-1] ★「${p.id}」: ⇧⌘Z = やり直し・⌘Y = やり直し・⌘Z = 元に戻す・control+Z = 元に戻す`, () => {
        const got = [
          get("KeyZ", { meta: true, shift: true }),
          get("KeyY", { meta: true }),
          get("KeyZ", { meta: true }),
          get("KeyZ", { ctrl: true }),
          get("KeyZ", { ctrl: true, shift: true }), // Mac の control+Shift+Z も同じ（折り畳み）
        ];
        const want = ["edit.redo", "edit.redo", "edit.undo", "edit.undo", "edit.redo"];
        return got.join("|") === want.join("|") ? ok() : ng(got.join(" | "));
      });
    }
    // 利用者の割り当てが ⇧Ctrl+Z を使っていればそちらが勝つ（固定キーの後勝ち）
    await add("[S-1] ⇧⌘Z は利用者の割り当て（u1: ペン）があればそちらが勝つ", () => {
      const L: Map<string, string[]> = K.buildLookup(USER_PRESETS[0]);
      const got = L.get(K.eventKey(kev("z", "KeyZ", { meta: true, shift: true })))?.join(",");
      return got === "tool.pen" ? ok() : ng(`${got}`);
    });
    // ⌘＋クリック（利用者の Ctrl＋クリック）・control＋クリック
    await add("[S-1] ★⌘＋クリックが Ctrl＋クリックの割り当てに一致（control＋クリックも）", () => {
      const L: Map<string, string[]> = K.buildLookup(USER_PRESETS[0]);
      const a = L.get(K.pointerEventKey(pev(0, { meta: true })))?.join(",");
      const b = L.get(K.pointerEventKey(pev(0, { ctrl: true })))?.join(",");
      const c = L.get(K.pointerEventKey(pev(2, { meta: true, shift: true })))?.join(",");
      const d = K.buildLookup(USER_PRESETS[1]).get(K.pointerEventKey(pev(2, { meta: true, shift: true })))?.join(",");
      return a === "edit.pickColor" && b === "edit.pickColor" && c === undefined && d === "view.zoomIn"
        ? ok()
        : ng(`⌘click=${a} ⌃click=${b} ⇧⌘右(u1)=${c} ⇧⌘右(u2)=${d}`);
    });
    // ⌘ の単押しは Control のタップ（実行側の状態機械）
    await add("[S-1] ★⌘ の単押しは Control のタップ（250ms 以内）・長押しは発動しない", () => {
      let now = 0;
      const w = new K.ModTapWatcher(() => now);
      w.down("Meta");
      now += 100;
      const a = w.up("Meta");
      w.down("Meta");
      now += 251;
      const b = w.up("Meta");
      w.down("Meta");
      w.down("z"); // ⌘Z の途中
      const c = w.up("Meta");
      return a === "Control" && b === null && c === null ? ok() : ng(`${a}/${b}/${c}`);
    });
    // 本物の editor.ts の keydown で
    const E = makeEd(T, K.BUILTIN_PRESETS[0]);
    const cases: [string, string, Mods, string][] = [
      ["z", "KeyZ", { meta: true }, "cmd:edit.undo pd"],
      ["y", "KeyY", { meta: true }, "cmd:edit.redo pd"],
      ["z", "KeyZ", { meta: true, shift: true }, "cmd:edit.redo pd"],
      ["c", "KeyC", { meta: true }, "cmd:edit.copy pd"],
      ["x", "KeyX", { meta: true }, "cmd:edit.cut pd"],
      ["v", "KeyV", { meta: true }, "cmd:edit.paste pd"],
      ["s", "KeyS", { meta: true }, "cmd:file.save pd"],
      ["s", "KeyS", { meta: true, shift: true }, "cmd:file.saveAs pd"],
      ["c", "KeyC", { meta: true, shift: true }, "cmd:frame.copyPage pd"],
      ["v", "KeyV", { meta: true, shift: true }, "cmd:frame.pastePage pd"],
      [",", "Comma", { meta: true }, "cmd:app.settings pd"],
      ["z", "KeyZ", { ctrl: true }, "cmd:edit.undo pd"],
      ["z", "KeyZ", { ctrl: true, meta: true }, "cmd:edit.undo pd"],
      ["h", "KeyH", { meta: true }, "-"], // 手のひらは素の H だけ（⌘H は Mac の「隠す」に残る）
    ];
    const bad: string[] = [];
    for (const [k, code, m, want] of cases) {
      const got = E.key(kev(k, code, m));
      if (got !== want) bad.push(`${tag(m)} ${code}: ${got}（期待 ${want}）`);
    }
    await add(`[S-1] ★本物の editor.ts の keydown: ⌘ の ${cases.length} 通りが Windows の Ctrl と同じ命令・preventDefault`, () =>
      bad.length === 0 ? ok() : ng(bad.slice(0, 4).join(" / "))
    );
    await add("[S-1] ★本物の editor.ts: 文字の確定は ⌘Enter でも（control+Enter も）", () => {
      E.ed.textDraft = { text: "x" };
      const a = E.key(kev("Enter", "Enter", { meta: true }));
      const b = E.key(kev("Enter", "Enter", { ctrl: true }));
      E.ed.textDraft = null;
      return a === "commitText pd" && b === "commitText pd" ? ok() : ng(`⌘Enter=${a} ⌃Enter=${b}`);
    });
    await add("[S-1] ★本物の editor.ts: ⌘ の単押しで Control のタップの割り当て（u1: 元に戻す）が動く", () => {
      const U = makeEd(T, USER_PRESETS[0]);
      const a = U.tap("Meta", "MetaLeft");
      const b = U.tap("Control", "ControlLeft");
      return a === "cmd:edit.undo" && b === "cmd:edit.undo" ? ok() : ng(`⌘=${a} ⌃=${b}`);
    });
    // ★第三者レビュー X06 / X07 / X11 / X17: Mac の検査は Ctrl を持つ割り当てしか見ていなかったので、⌘ を含まない入力
    //  （⌥＋クリックのスポイト・⌥ のタップ・⌥＋文字の登録・左手向けの H）を Mac でだけ壊しても緑だった。
    //  **同じ電池を Mac と Windows で回し、⌘（meta）を含まない行は 1 行も違わない**ことを見る。
    //  違ってよいのは 2 つだけ: ①Mac の固定キー ⇧⌘Z（＝Ctrl+Shift+Z → やり直し・引き当て表の 1 項目と、それが効く打鍵）
    //  ②押しっぱなしのくり返しで Mac だけ preventDefault（swallowRepeatOnMac）
    await add("[S-1] ★Mac でも ⌘ を含まない入力は Windows と 1 行も違わない（照合・登録・引き当て・タップ・取得・editor・ホーム）", async () => {
      const run = async (mac: boolean) => {
        setMac(T, mac);
        return [...keymapBattery(T), ...(await captureBattery(T)), ...editorBattery(T), ...homeBattery(T)];
      };
      const W = await run(false);
      const M = await run(true);
      if (W.length !== M.length) return ng(`行数 ${W.length} ≠ ${M.length}`);
      const bad: string[] = [];
      const allowed = { redoEntry: 0, redoKey: 0, repeatPd: 0 };
      let compared = 0;
      for (let i = 0; i < W.length; i++) {
        const w = W[i];
        const m = M[i];
        const tagTok = w.split(" ").find((x) => /^[C-][S-][A-][M-]$/.test(x));
        if ((tagTok && tagTok[3] === "M") || /meta/i.test(w)) continue; // ⌘（meta）を含む行は比べない（Meta キーを押す行も）
        compared++;
        if (w === m) continue;
        if (/^(lk|fresh) /.test(w) && !/ CS\|KeyZ=/.test(w) && m.replace(" CS|KeyZ=edit.redo", "") === w) {
          allowed.redoEntry++;
          continue;
        }
        const [wl, wr] = w.split(" => ");
        const [ml, mr] = m.split(" => ");
        if (wl === ml && / KeyZ CS-- /.test(` ${wl} `) && wr === "-" && mr === "cmd:edit.redo pd") {
          allowed.redoKey++;
          continue;
        }
        if (wl === ml && / repeat$/.test(wl) && !/ pd$/.test(wr) && mr === `${wr} pd`) {
          allowed.repeatPd++;
          continue;
        }
        bad.push(`Win「${w.slice(0, 110)}」／Mac「${m.slice(0, 110)}」`);
      }
      if (bad.length) return ng(`${bad.length} 行: ${bad.slice(0, 2).join(" ・ ")}`);
      // 空振りしていない（比べた行があり、許した差が 3 種とも実際に出ている）
      if (compared < 3000 || !allowed.redoEntry || !allowed.redoKey || !allowed.repeatPd)
        return ng(`比べた ${compared} 行・許した差 ${JSON.stringify(allowed)}`);
      return ok();
    });
    // ★独立レビュー 1 回目の表 3（⌘＋⌥ のときだけ畳まない書き換え）が、組み込みの反証の字面が当たらない赤でしか
    //  赤くならなかった＝⌘ と ⌥ を一緒に押す形を検査が見ていなかった。**全コード × ⇧ / ⌥ の 4 通り**で見る
    await add("[S-1] ★全コード × ⇧/⌥ の 4 通り（＋クリック 3 × 4）で、⌘・control・両方の照合キーと登録の形が「Ctrl の割り当て」と同じ・M は立たない", () => {
      const bad: string[] = [];
      let n = 0;
      for (let sa = 0; sa < 4; sa++) {
        const shift = !!(sa & 1);
        const alt = !!(sa & 2);
        for (const code of CODES) {
          const b: Mod = { code, ctrl: true };
          if (shift) b.shift = true;
          if (alt) b.alt = true;
          const want = K.bindingKey(b);
          for (const m of [{ meta: true }, { ctrl: true }, { ctrl: true, meta: true }]) {
            n++;
            const e = kev("x", code, { ...m, shift, alt });
            const got = K.eventKey(e);
            const reg = K.bindingKey(K.bindingFromEvent(e));
            if (got !== want || reg !== want) bad.push(`${tag({ ...m, shift, alt })} ${code}: 照合 ${got}・登録 ${reg}（期待 ${want}）`);
          }
        }
        for (const button of [0, 1, 2]) {
          const b: Mod = { code: "", button, ctrl: true };
          if (shift) b.shift = true;
          if (alt) b.alt = true;
          const want = K.bindingKey(b);
          for (const m of [{ meta: true }, { ctrl: true }, { ctrl: true, meta: true }]) {
            n++;
            const e = pev(button, { ...m, shift, alt });
            const got = K.pointerEventKey(e);
            const reg = K.bindingKey(K.bindingFromPointer(e));
            if (got !== want || reg !== want) bad.push(`${tag({ ...m, shift, alt })} B${button}: 照合 ${got}・登録 ${reg}（期待 ${want}）`);
          }
        }
      }
      return bad.length ? ng(`${bad.length}/${n}: ${bad.slice(0, 3).join(" / ")}`) : ok();
    });
    // ★独立レビュー 1 回目の中 1: 押しっぱなしのくり返し。**走らせない**が、Mac では既定の動き（メニューの Copy 等・警告音）を止める
    await add("[S-1] ★本物の editor.ts: ⌘C / ⌘X / ⌘V / ⌘S / ⇧⌘S / ⇧⌘C / ⇧⌘V / ⌘, の押しっぱなし（くり返し）は走らせず preventDefault・⌘Z / ⌘Y はくり返し効く", () => {
      const cases: [string, string, Mods, string][] = [
        ["c", "KeyC", { meta: true }, "- pd"],
        ["x", "KeyX", { meta: true }, "- pd"],
        ["v", "KeyV", { meta: true }, "- pd"],
        ["s", "KeyS", { meta: true }, "- pd"],
        ["s", "KeyS", { meta: true, shift: true }, "- pd"],
        ["c", "KeyC", { meta: true, shift: true }, "- pd"],
        ["v", "KeyV", { meta: true, shift: true }, "- pd"],
        [",", "Comma", { meta: true }, "- pd"],
        ["z", "KeyZ", { meta: true }, "cmd:edit.undo pd"],
        ["y", "KeyY", { meta: true }, "cmd:edit.redo pd"],
        ["z", "KeyZ", { meta: true, shift: true }, "cmd:edit.redo pd"],
      ];
      const bad: string[] = [];
      for (const [k, code, m, want] of cases) {
        const got = E.key(kev(k, code, m, { repeat: true }));
        if (got !== want) bad.push(`${tag(m)} ${code}: ${got}（期待 ${want}）`);
      }
      // 同じキーを共有する道具（u2 の P＝ペンとブラシ）の押しっぱなしも巡回せず止める
      const U2 = makeEd(T, USER_PRESETS[1]);
      const tool = U2.key(kev("p", "KeyP", {}, { repeat: true }));
      if (tool !== "- pd") bad.push(`道具の巡回のくり返し: ${tool}`);
      return bad.length ? ng(bad.join(" / ")) : ok();
    });
    await add("[S-1] ★ホーム画面（main.ts をそのまま）: ⌘, と control+, で設定が開き preventDefault・⌘ の単押し（Control のタップ）でも開く", () => {
      const H = makeHome(T, K.BUILTIN_PRESETS[0]);
      const a = H.key(kev(",", "Comma", { meta: true }, { target: BODY_T }));
      const b = H.key(kev(",", "Comma", { ctrl: true }, { target: BODY_T }));
      const c = makeHome(T, HOME_TAP_PRESET).tap("Meta", "MetaLeft");
      return a === "settings pd" && b === "settings pd" && c === "settings pd" ? ok() : ng(`⌘,=${a} ⌃,=${b} ⌘タップ=${c}`);
    });
    await add("[S-1] 本物の editor.ts: フォルダの行を ⌘＋クリック → Ctrl＋クリックと同じ（フォルダの選択は切り替えない）", () => {
      const ed = E.ed;
      const one = (m: Mods) => {
        ed.suppressRowClick = false;
        ed.displayRows = ["L1", "F1", "L2"].map((id) => ({ id }));
        ed.selectedNodeIds = new Set(["L1"]);
        ed.selAnchorId = "L1";
        ed.selectedFolderId = null;
        ed.activeLayerId = "L1";
        ed.updateSelection("F1", "folder", { ctrlKey: !!m.ctrl, shiftKey: false, altKey: false, metaKey: !!m.meta });
        return `${[...ed.selectedNodeIds].sort().join(",")}|${ed.selectedFolderId}`;
      };
      const a = one({ meta: true });
      const b = one({ ctrl: true });
      return a === b && a === "F1,L1|null" ? ok() : ng(`⌘=${a} ⌃=${b}`);
    });
  } finally {
    setMac(T, null);
  }
  return r;
}

// =====================================================================================
// [S-2] ★Windows のふり: この回の前とビット一致
// =====================================================================================
// この回の前（54cfbf5）の木で keymapBattery ＋ captureBattery ＋ editorBattery ＋ homeBattery を回した指紋（言語に依らない部分）
// ★V183 (A-82) で 4 行が変わった（旧 2180af30dcfdd2e7＝旧版の木から取った値）: 取得で「Win を押したまま Ctrl / Shift / Alt を
//  押して離す」（pair Meta>Control / Shift / Alt up-b-a・meta+ctrl）は、以前はタップとして取れた（Win はタップの対象外なので候補を
//  壊すだけで、次の修飾キーが新しい候補になった）。V183 の規則（ほかの修飾キーが押されている間は候補にしない）で待ち続ける形に
//  なった。[S-2r] がこの 4 行だけを許し、残りの 5,726 行は旧版の木と 1 行も違わないことを見る（V183 の報告書 §3）
const WIN_FP = "297e4b4cbbca5ea0"; // 5730 行（keymap 2577・capture 253・editor 2320・home 580）
async function groupS2(T: Tree, B: Tree | null): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  setMac(T, false);
  try {
    const kb = keymapBattery(T);
    const cb = await captureBattery(T);
    const eb = editorBattery(T);
    const hb = homeBattery(T);
    const fp = sha([...kb, ...cb, ...eb, ...hb]);
    if (process.env.V181_PRINT_FP)
      console.log(`WIN_FP(${T.label}) = ${fp}  keymap=${kb.length} capture=${cb.length} editor=${eb.length} home=${hb.length}`);
    await add(
      `[S-2] ★Windows の照合・登録・引き当て・タップ・editor の keydown（くり返しも）と行の選択・ホーム画面のキー（${kb.length + cb.length + eb.length + hb.length} 行）が固定値と一致`,
      () => (fp === WIN_FP ? ok() : ng(`指紋 ${fp}（固定値 ${WIN_FP}）`))
    );
    const K = T.K;
    await add("[S-2] ★Win+Z は一致しない（M11-5）・⇧Ctrl+Z は足されていない（組み込み 2 つ）", () => {
      const bad: string[] = [];
      for (const p of K.BUILTIN_PRESETS as Mod[]) {
        const L: Map<string, string[]> = K.buildLookup(p);
        const w = L.get(K.eventKey(kev("z", "KeyZ", { meta: true })));
        const sz = L.get(K.eventKey(kev("z", "KeyZ", { ctrl: true, shift: true })));
        const wc = L.get(K.pointerEventKey(pev(0, { meta: true })));
        if (w || sz || wc) bad.push(`${p.id}: Win+Z=${w} ⇧Ctrl+Z=${sz} Win+click=${wc}`);
      }
      return bad.length ? ng(bad.join(" / ")) : ok();
    });
    await add("[S-2] Win キーの単押しはタップにならない・Win＋文字は Ctrl に数えない", () => {
      let now = 0;
      const w = new K.ModTapWatcher(() => now);
      w.down("Meta");
      now += 50;
      const a = w.up("Meta");
      const b = K.bindingFromEvent(kev("s", "KeyS", { meta: true }));
      const c = K.eventKey(kev("s", "KeyS", { meta: true, ctrl: true }));
      return a === null && !b.ctrl && c === "CM|KeyS" ? ok() : ng(`${a} ${JSON.stringify(b)} ${c}`);
    });
    // 表記（言語ごと）: Windows では keyLabel が旧来の式（Ctrl/Shift/Alt を + でつなぐ）のまま・t() は辞書そのまま
    await add("[S-2] ★Windows の keyLabel（7 言語 × 全割り当て）が旧来の式と一致", () => {
      const bad: string[] = [];
      let n = 0;
      for (const l of LANGS) {
        T.I.setLang(l);
        for (const b of labelBattery()) {
          n++;
          const old = b.tap
            ? T.I.t("keys.tap.label", { key: b.tap === "Control" ? "Ctrl" : b.tap })
            : [b.ctrl ? "Ctrl" : "", b.shift ? "Shift" : "", b.alt ? "Alt" : "", b.button !== undefined ? pointerWord(T, b.button) : K.codeLabel(b.code)]
                .filter(Boolean)
                .join("+");
          const got = K.keyLabel(b);
          if (got !== old) bad.push(`${l} ${JSON.stringify(b)}: ${got} ≠ ${old}`);
        }
      }
      T.I.setLang("ja");
      return bad.length ? ng(bad.slice(0, 3).join(" / ")) : n === LANGS.length * labelBattery().length ? ok() : ng(`n=${n}`);
    });
    await add("[S-2] ★Windows の modLabel は Ctrl / Shift / Alt", () => {
      const got = ["Control", "Shift", "Alt"].map((m) => K.modLabel(m)).join(",");
      return got === "Ctrl,Shift,Alt" ? ok() : ng(got);
    });
    await add("[S-2] ★Windows の t() は 7 言語 × 全キーで辞書の原文そのまま", () => {
      const bad: string[] = [];
      let n = 0;
      for (const l of LANGS) {
        T.I.setLang(l);
        for (const [k, raw] of Object.entries(T.D[l])) {
          n++;
          if (T.I.t(k) !== raw) bad.push(`${l} ${k}`);
        }
      }
      T.I.setLang("ja");
      return bad.length ? ng(`${bad.length} 件: ${bad.slice(0, 3).join(", ")}`) : ok();
    });
    // 旧版の木（blob）と直接比べる
    if (!B) {
      console.log("SKIP [S-2r] この回の前の blob が無い（公開リポジトリの clone など）。固定値の [S-2] は上で走った");
    } else {
      await add("[S-2r] ★旧版の木と、照合・登録・引き当て・タップ・editor の keydown（くり返しも）・行の選択・ホーム画面のキーが 1 行も違わない（V183 で変わった取得の 4 行を除く）", async () => {
        const mine = [...kb, ...cb, ...eb, ...hb];
        const theirs = [...keymapBattery(B), ...(await captureBattery(B)), ...editorBattery(B), ...homeBattery(B)];
        if (process.env.V181_PRINT_FP) console.log(`WIN_FP(base) = ${sha(theirs)}  lines=${theirs.length}`);
        if (mine.length !== theirs.length) return ng(`行数 ${mine.length} ≠ ${theirs.length}`);
        // ★V183 (A-82): 取得で Win を押したまま Ctrl / Shift / Alt を押して離す 4 行だけ、旧版＝タップ・いま＝待ち続ける（WIN_FP の注）
        let v183 = 0;
        for (let i = 0; i < mine.length; i++) {
          if (mine[i] === theirs[i]) continue;
          const [ml, mr] = mine[i].split(" => ");
          const [tl, tr] = theirs[i].split(" => ");
          if (
            ml === tl &&
            /^(pair Meta>(Control|Shift|Alt) up-b-a|meta\+ctrl)$/.test(ml) &&
            /^\{"code":"","tap":"(Control|Shift|Alt)"\} \[--,--,PS\]$/.test(tr) &&
            mr === "pending [--,--,--,--]"
          ) {
            v183++;
            continue;
          }
          return ng(`${i} 行目: ${mine[i]} ≠ ${theirs[i]}`);
        }
        return v183 === 4 ? ok() : ng(`V183 で変わった行が ${v183}（4 のはず）`);
      });
      await add("[S-2r] ★旧版の木と、7 言語の keyLabel・modLabel・全辞書の t()（{…} を埋めた形も）が 1 文字も違わない", () => {
        const bad: string[] = [];
        for (const l of LANGS) {
          T.I.setLang(l);
          B.I.setLang(l);
          for (const b of labelBattery()) if (T.K.keyLabel(b) !== B.K.keyLabel(b)) bad.push(`${l} keyLabel ${JSON.stringify(b)}`);
          for (const m of ["Control", "Shift", "Alt"]) if (T.K.modLabel(m) !== B.K.modLabel(m)) bad.push(`${l} modLabel ${m}`);
          const vars = { key: "Ctrl+S", mod: "Ctrl", cmd: "Shift", names: "Alt", count: 2, n: 3, name: "Ctrl用" };
          for (const k of Object.keys(T.D[l])) {
            if (T.I.t(k) !== B.I.t(k)) bad.push(`${l} t(${k})`);
            if (T.I.t(k, vars) !== B.I.t(k, vars)) bad.push(`${l} t(${k}, vars)`);
          }
        }
        T.I.setLang("ja");
        B.I.setLang("ja");
        return bad.length ? ng(`${bad.length} 件: ${bad.slice(0, 3).join(", ")}`) : ok();
      });
    }
  } finally {
    setMac(T, null);
  }
  return r;
}
function pointerWord(T: Tree, button: number): string {
  return T.I.t(button === 1 ? "keys.pointer.mid.label" : button === 2 ? "keys.pointer.right.label" : "keys.pointer.left.label");
}

// =====================================================================================
// [S-3] ★表記
// =====================================================================================
interface DictRow {
  lang: string;
  key: string;
  raw: string;
  mac: string;
}
async function groupS3(T: Tree, rows?: DictRow[]): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  // 辞書の「Ctrl」「Alt」「Shift」を含む文言を全部拾う
  const hits: { lang: string; key: string; raw: string }[] = [];
  for (const l of LANGS) for (const [k, v] of Object.entries(T.D[l])) if (MOD_WORD.test(v)) hits.push({ lang: l, key: k, raw: v });
  await add("[S-3] ★辞書の「Ctrl」「Alt」「Shift」を含む文言の件数が表（DICT_COUNTS）と一致（増減したら分類し直す）", () => {
    const bad: string[] = [];
    for (const l of LANGS) {
      const hs = hits.filter((h) => h.lang === l);
      const got = {
        entries: hs.length,
        Ctrl: hs.reduce((a, h) => a + countOf(h.raw, /\bCtrl\b/g), 0),
        Alt: hs.reduce((a, h) => a + countOf(h.raw, /\bAlt\b/g), 0),
        Shift: hs.reduce((a, h) => a + countOf(h.raw, /\bShift\b/g), 0),
      };
      if (JSON.stringify(got) !== JSON.stringify(DICT_COUNTS[l])) bad.push(`${l}: ${JSON.stringify(got)}`);
    }
    return bad.length ? ng(bad.join(" / ")) : ok();
  });
  const P = T.P;
  await add("[S-3] キーではない語の表（NON_KEY_WORD_DICT_KEYS）が検査の分類と一致", () => {
    if (!P) return ng("platform.ts が無い");
    const got = [...(P.NON_KEY_WORD_DICT_KEYS as Set<string>)].sort();
    const want = [...new Set(NON_KEY_EXPECTED.map((x) => x.split(" ")[1]))].sort();
    if (got.join(",") !== want.join(",")) return ng(`${got.join(",")}（期待 ${want.join(",")}）`);
    // どの除外も、少なくとも 1 言語で実際に「Ctrl / Alt / Shift」を含む（死んだ除外を残さない）
    const dead = got.filter((k) => !hits.some((h) => h.key === k));
    return dead.length ? ng(`死んだ除外: ${dead.join(",")}`) : ok();
  });
  setMac(T, true);
  try {
    const bad: string[] = [];
    const order: string[] = [];
    const counts: string[] = [];
    const oracle: string[] = [];
    let nKey = 0;
    let nNon = 0;
    const nonBad: string[] = [];
    const withVars: string[] = [];
    for (const h of hits) {
      T.I.setLang(h.lang);
      const mac = T.I.t(h.key);
      // ★第三者レビュー X13: {…} を渡した呼び方でも同じに置き換わる（渡した値を使わない文言でも、道は同じであること）
      if (T.I.t(h.key, { zz: 1 }) !== mac) withVars.push(`${h.lang} ${h.key}`);
      rows?.push({ lang: h.lang, key: h.key, raw: h.raw, mac });
      if (NON_KEY_EXPECTED.includes(`${h.lang} ${h.key}`)) {
        nNon++;
        if (mac !== h.raw) nonBad.push(`${h.lang} ${h.key}: ${mac}`);
        continue;
      }
      nKey++;
      if (MOD_WORD.test(mac)) bad.push(`${h.lang} ${h.key}: ${mac}`);
      const c = [countOf(h.raw, /\bCtrl\b/g), countOf(h.raw, /\bAlt\b/g), countOf(h.raw, /\bShift\b/g)];
      const s = [countOf(mac, /⌘/g), countOf(mac, /⌥/g), countOf(mac, /⇧/g)];
      if (c.join() !== s.join()) counts.push(`${h.lang} ${h.key}: 語 ${c} ≠ 記号 ${s}`);
      if (!symOrderOk(mac)) order.push(`${h.lang} ${h.key}: ${mac}`);
      if (mac !== oracleMac(h.raw)) oracle.push(`${h.lang} ${h.key}: ${mac} ≠ ${oracleMac(h.raw)}`);
    }
    T.I.setLang("ja");
    await add(`[S-3] ★Mac のふり: キーの意味の ${nKey} 件すべてで「Ctrl」「Alt」「Shift」が 1 つも残らない`, () =>
      nKey > 0 && bad.length === 0 ? ok() : ng(`${bad.length} 件: ${bad.slice(0, 3).join(" / ")}`)
    );
    await add("[S-3] ★Mac のふり: 記号の数が元の語の数と一致（⌘=Ctrl・⌥=Alt・⇧=Shift）", () =>
      counts.length === 0 ? ok() : ng(counts.slice(0, 3).join(" / "))
    );
    await add("[S-3] ★Mac のふり: 記号の並びは Mac のメニューと同じ ⌥⇧⌘", () => (order.length === 0 ? ok() : ng(order.slice(0, 3).join(" / "))));
    await add("[S-3] ★Mac のふり: 検査側の独立した実装（oracle）と 1 文字も違わない", () =>
      oracle.length === 0 ? ok() : ng(oracle.slice(0, 3).join(" / "))
    );
    await add("[S-3] ★Mac のふり: t() に {…} を渡しても同じに置き換わる（99 件すべて）", () =>
      withVars.length === 0 ? ok() : ng(`${withVars.length} 件: ${withVars.slice(0, 3).join(", ")}`)
    );
    await add(`[S-3] キーではない語（${nNon} 件: en の「Shift per frame」）は Mac でも置き換えない`, () =>
      nNon === NON_KEY_EXPECTED.length && nonBad.length === 0 ? ok() : ng(`${nNon} 件 ${nonBad.join(" / ")}`)
    );
    for (const [k, pred, want] of ANCHORS_JA)
      await add(`[S-3] 指示書の例: ja「${k}」→「${want}」`, () => {
        T.I.setLang("ja");
        const got = T.I.t(k);
        return pred(got) ? ok() : ng(got);
      });
    await add("[S-3] ★Mac のふりでも、「Ctrl」「Alt」「Shift」を含まない文言は 7 言語 × 全キーで 1 文字も変わらない", () => {
      const diff: string[] = [];
      for (const l of LANGS) {
        T.I.setLang(l);
        for (const [k, raw] of Object.entries(T.D[l])) if (!MOD_WORD.test(raw) && T.I.t(k) !== raw) diff.push(`${l} ${k}`);
      }
      T.I.setLang("ja");
      return diff.length ? ng(`${diff.length} 件: ${diff.slice(0, 3).join(", ")}`) : ok();
    });
    await add("[S-3] ★Mac のふり: {…} に差し込む値（利用者の名前など）は置き換えない（訳文の側だけ）", () => {
      T.I.setLang("ja");
      const got = T.I.t("keys.preset.delete.msg", { name: "Ctrl用" });
      return got.includes("Ctrl用") ? ok() : ng(got);
    });
    // 生成する表記（keyLabel・タップ・modLabel）も同じ規則
    await add("[S-3] ★Mac のふり: keyLabel（7 言語 × 全割り当て）＝ Windows の表記に同じ規則を当てたもの・語は残らない", () => {
      const bad2: string[] = [];
      let n = 0;
      for (const l of LANGS) {
        T.I.setLang(l);
        for (const b of labelBattery()) {
          setMac(T, false);
          const win = T.K.keyLabel(b);
          setMac(T, true);
          const mac = T.K.keyLabel(b);
          n++;
          if (mac !== oracleMac(win) || MOD_WORD.test(mac)) bad2.push(`${l} ${JSON.stringify(b)}: ${mac}（Win ${win}）`);
        }
      }
      T.I.setLang("ja");
      return bad2.length ? ng(`${bad2.length} 件: ${bad2.slice(0, 3).join(" / ")}`) : n === LANGS.length * labelBattery().length ? ok() : ng(`n=${n}`);
    });
    await add("[S-3] Mac のふり: keyLabel の例（⇧⌘S・⌥⇧⌘S・⌘,・⌥+クリック・⌘（タップ））", () => {
      T.I.setLang("ja");
      const got = [
        T.K.keyLabel({ code: "KeyS", ctrl: true, shift: true }),
        T.K.keyLabel({ code: "KeyS", ctrl: true, shift: true, alt: true }),
        T.K.keyLabel({ code: "Comma", ctrl: true }),
        T.K.keyLabel({ code: "", button: 0, alt: true }),
        T.K.keyLabel({ code: "", tap: "Control" }),
        T.K.keyLabel({ code: "KeyZ" }),
      ];
      const want = ["⇧⌘S", "⌥⇧⌘S", "⌘,", "⌥+クリック", "⌘（タップ）", "Z"];
      return got.join("|") === want.join("|") ? ok() : ng(got.join(" | "));
    });
    await add("[S-3] ★Mac のふり: modLabel は ⌘ / ⇧ / ⌥", () => {
      const got = ["Control", "Shift", "Alt"].map((m) => T.K.modLabel(m)).join(",");
      return got === "⌘,⇧,⌥" ? ok() : ng(got);
    });
    // ★独立レビュー 1 回目の低 4: いまの辞書の複数形（`_other`）に Ctrl/Alt/Shift を含む文言が無いので、t() の複数形の道
    //  だけ置き換えを外しても緑だった。**検査の写しの ja.ts にだけ** 1 行足して、その道を実際に通す（本物の辞書は触らない）
    await add("[S-3] ★t() の複数形の道（{count} で `_other` を引く）も置き換える: Mac「⌘Z を 3 回」・Windows「Ctrl+Z を 3 回」", async () => {
      const F = await freshCopy(T, [
        {
          file: "src/i18n/ja.ts",
          from: "const ja = {\n",
          to: 'const ja = {\n  "v181.test.plural_other": "Ctrl+Z を {count} 回",\n  "v181.test.vars": "Ctrl+Shift+S で「{name}」",\n',
        },
      ]);
      if (!F.P) return ng("写しに platform.ts が無い");
      F.I.setLang("ja");
      F.P.setMacPlatformForTest(true);
      const mac = F.I.t("v181.test.plural", { count: 3 });
      // 複数形でない道に {…} を渡す形も（差し込む値は置き換えない）
      const macV = F.I.t("v181.test.vars", { name: "Ctrl用" });
      F.P.setMacPlatformForTest(false);
      const win = F.I.t("v181.test.plural", { count: 3 });
      const winV = F.I.t("v181.test.vars", { name: "Ctrl用" });
      const got = `${mac}|${win}|${macV}|${winV}`;
      return got === "⌘Z を 3 回|Ctrl+Z を 3 回|⇧⌘S で「Ctrl用」|Ctrl+Shift+S で「Ctrl用」" ? ok() : ng(got);
    });
  } finally {
    setMac(T, null);
  }
  return r;
}

// =====================================================================================
// [S-4] 登録（設定画面の captureKey をそのまま動かす）
// =====================================================================================
async function groupS4(T: Tree): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  setMac(T, true);
  try {
    const C = makeCapture(T);
    const K = T.K;
    /** 取れた割り当てを settings.json と同じ道（JSON → sanitize）に通して、戻ってきた形 */
    const saved = (json: string) => {
      const b = JSON.parse(json);
      const s = K.sanitizeKeysSettings(JSON.parse(JSON.stringify({ activeId: "u9", presets: [{ id: "u9", name: "u", bindings: { "edit.undo": b } }] })));
      return s.presets[0]?.bindings["edit.undo"];
    };
    const want = async (label: string, acts: Act[], expect: Mod, matchEv: Mod | null) =>
      add(`[S-4] ★Mac のふり: ${label} → ${JSON.stringify(expect)}（取った打鍵は preventDefault ＋ stopPropagation）`, async () => {
        const got = await C.run(acts);
        if (got !== JSON.stringify(expect)) return ng(`取れた形 ${got}`);
        // 独立レビュー 1 回目の低 3: 取った打鍵（最後に流したイベント）の既定の動きを止めていること（Mac のメニューへ回さない）
        const last = C.flags().split(",").pop();
        if (last !== "PS") return ng(`取った打鍵の preventDefault / stopPropagation が ${last}（期待 PS・全体 ${C.flags()}）`);
        const back = saved(got);
        if (JSON.stringify(back) !== got) return ng(`sanitize の往復で変わった: ${JSON.stringify(back)}`);
        if (/meta/i.test(got)) return ng("meta という項目が出た（settings.json の形が変わる）");
        if (matchEv) {
          const key = matchEv.type === "pointerdown" ? K.pointerEventKey(matchEv) : K.eventKey(matchEv);
          if (K.bindingKey(back) !== key) return ng(`登録した割り当てが同じ打鍵に一致しない（${K.bindingKey(back)} ≠ ${key}）`);
        }
        return ok();
      });
    await want("⌘＋S", combo("s", "KeyS", { meta: true }), { code: "KeyS", ctrl: true }, kev("s", "KeyS", { meta: true }));
    await want("⇧⌘S", combo("s", "KeyS", { meta: true, shift: true }), { code: "KeyS", ctrl: true, shift: true }, kev("s", "KeyS", { meta: true, shift: true }));
    await want("⌘＋,", combo(",", "Comma", { meta: true }), { code: "Comma", ctrl: true }, kev(",", "Comma", { meta: true }));
    await want("control＋S（Mac の control も Ctrl）", combo("s", "KeyS", { ctrl: true }), { code: "KeyS", ctrl: true }, kev("s", "KeyS", { meta: true }));
    await want("control＋⌘＋S（両方でも Ctrl は 1 つ）", combo("s", "KeyS", { ctrl: true, meta: true }), { code: "KeyS", ctrl: true }, null);
    await want("⌘＋クリック", [["ptr", 0, { meta: true }]], { code: "", button: 0, ctrl: true }, pev(0, { meta: true }));
    await want("⇧⌘＋右クリック", [["ptr", 2, { meta: true, shift: true }]], { code: "", button: 2, ctrl: true, shift: true }, pev(2, { meta: true, shift: true }));
    await want(
      "⌘ の単押し（100ms）",
      [["down", "Meta", "MetaLeft", { meta: true }], ["wait", 100], ["up", "Meta", "MetaLeft", {}]],
      { code: "", tap: "Control" },
      null
    );
    await add("[S-4] Mac のふり: ⌘ の長押し（251ms）はタップとして取らない（実行側と同じ MOD_TAP_MS）", async () => {
      const got = await C.run([["down", "Meta", "MetaLeft", { meta: true }], ["wait", 251], ["up", "Meta", "MetaLeft", {}]]);
      return got === "pending" ? ok() : ng(got);
    });
    await add("[S-4] Mac のふり: ⌘ を押したまま Z → ⌘Z（タップにはならない）", async () => {
      const got = await C.run([
        ["down", "Meta", "MetaLeft", { meta: true }],
        ["down", "z", "KeyZ", { meta: true }],
        ["up", "Meta", "MetaLeft", {}],
      ]);
      return got === JSON.stringify({ code: "KeyZ", ctrl: true }) ? ok() : ng(got);
    });
    await add("[S-4] Mac のふり: 取れた ⌘（タップ）が実行側の ⌘ の単押しと同じ表キー", async () => {
      const got = await C.run([["down", "Meta", "MetaLeft", { meta: true }], ["wait", 50], ["up", "Meta", "MetaLeft", {}]]);
      let now = 0;
      const w = new K.ModTapWatcher(() => now);
      w.down("Meta");
      now += 50;
      const fired = w.up("Meta");
      return got !== "pending" && fired && K.bindingKey(JSON.parse(got)) === K.tapEventKey(fired) ? ok() : ng(`${got} / ${fired}`);
    });
  } finally {
    setMac(T, null);
  }
  return r;
}

// =====================================================================================
// [S-5] ctrlKey / metaKey の直読みを数える（構文木）
// =====================================================================================
function srcFiles(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".ts")) out.push([path.relative(dir, p).replace(/\\/g, "/"), fs.readFileSync(p, "utf8")]);
    }
  };
  walk(path.join(dir, "src"));
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
/** そのノードを囲む**名前のある**入れ物の並び（関数・メソッド・クラスのフィールド・関数を入れた変数） */
function chainOf(n: ts.Node): string {
  const names: string[] = [];
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (
      (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p)) &&
      p.name
    )
      names.unshift(p.name.getText());
    else if (
      ts.isVariableDeclaration(p) &&
      p.initializer &&
      (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))
    )
      names.unshift(p.name.getText());
  }
  return names.join(">") || "(top)";
}
/** `ctrlKey` / `metaKey` の読み（プロパティ・添字・分割代入）と getModifierState を全部拾う。
 *  ★V213: サンプルへの写し（isSampleCopy）は `copies` へ分ける（数え方は同じ・置き場所が別なだけ） */
function modReads(dir: string, copies: string[] = []): string[] {
  const out: string[] = [];
  for (const [file, src] of srcFiles(dir)) {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      let prop: string | null = null;
      if (ts.isPropertyAccessExpression(n)) prop = n.name.text;
      else if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)) prop = n.argumentExpression.text;
      else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent))
        prop = (n.propertyName ?? n.name).getText(sf).replace(/["']/g, "");
      if (prop === "ctrlKey" || prop === "metaKey") (isSampleCopy(n, prop) ? copies : out).push(`${file}|${chainOf(n)}|${prop}`);
      else if (prop === "getModifierState") out.push(`${file}|${chainOf(n)}|getModifierState`);
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out.sort();
}
/** ★V213 (M-2a): コアのサンプルへの**写し**。PC の `sampleOf(e)` は `{ …, ctrl: e.ctrlKey, meta: e.metaKey }` を返す
 *  （コアは描くときに受け取る点の形を 1 つにした＝`StrokeSample`）。ここは**判断をしていない**（読んだ値をそのまま
 *  サンプルの ctrl / meta に置くだけ）ので、上の「判断に直読みしてよい所」の表（15 か所）には入れず、別に縛る:
 *   ① 写しは「`return { … }` の中の `ctrl: <名前>.ctrlKey` / `meta: <名前>.metaKey`」の形だけを数え、表 EXPECTED_SAMPLE_COPY と
 *      過不足なく一致（ほかの所で同じ形を書けば余分＝赤。sampleOf で形を変えれば直読みの表の余分＝赤）
 *   ② サンプルの ctrl / meta を**読む所が 0**（型で見る＝`StrokeSample` の値の `.ctrl` / `.meta`・添字・分割代入）。
 *      写した値で Ctrl を判断すると primaryMod を通らない（Mac の ⌘ が畳まれない）ので、写しを判断の抜け道にさせない
 *  V213 より前の木には sampleOf も StrokeSample も無い＝どちらも 0 件（直読みの表は前と同じ 15 か所） */
function isSampleCopy(n: ts.Node, prop: string): boolean {
  const pa = n.parent;
  return (
    ts.isPropertyAccessExpression(n) &&
    ts.isIdentifier(n.expression) &&
    !!pa &&
    ts.isPropertyAssignment(pa) &&
    pa.initializer === n &&
    pa.name.getText() === (prop === "ctrlKey" ? "ctrl" : "meta") &&
    ts.isObjectLiteralExpression(pa.parent) &&
    !!pa.parent.parent &&
    ts.isReturnStatement(pa.parent.parent)
  );
}
const EXPECTED_SAMPLE_COPY = ["src/editor/editor.ts|sampleOf|ctrlKey", "src/editor/editor.ts|sampleOf|metaKey"].sort();
/** `StrokeSample` の値から ctrl / meta を読む所（型を見る）。`probe` はサンプルの x を読む所の数（型が引けている＝空振りしていない印） */
function sampleModReads(dir: string): { reads: string[]; probe: number } {
  const files = srcFiles(dir).map(([f]) => path.join(dir, f));
  const prog = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noResolve: true,
    types: [],
  });
  const checker = prog.getTypeChecker();
  const isSample = (t: ts.Type): boolean =>
    t.isUnion() ? t.types.some(isSample) : (t.aliasSymbol ?? t.getSymbol())?.getName() === "StrokeSample";
  const reads: string[] = [];
  let probe = 0;
  const srcRoot = path.join(dir, "src");
  for (const sf of prog.getSourceFiles()) {
    if (!path.resolve(sf.fileName).startsWith(srcRoot)) continue;
    const file = path.relative(dir, sf.fileName).replace(/\\/g, "/");
    const visit = (n: ts.Node) => {
      let recv: ts.Node | null = null;
      let prop = "";
      if (ts.isPropertyAccessExpression(n)) [recv, prop] = [n.expression, n.name.text];
      else if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)) [recv, prop] = [n.expression, n.argumentExpression.text];
      else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent))
        [recv, prop] = [n.parent, (n.propertyName ?? n.name).getText(sf).replace(/["']/g, "")];
      if (recv && (prop === "ctrl" || prop === "meta" || prop === "x") && isSample(checker.getTypeAtLocation(recv))) {
        if (prop === "x") probe++;
        else reads.push(`${file}|${chainOf(n)}|${prop}`);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return { reads: reads.sort(), probe };
}
/** 名前で呼んでいる所（`primaryMod(…)` 等）を全部拾う */
function callSites(dir: string, fname: string): string[] {
  const out: string[] = [];
  for (const [file, src] of srcFiles(dir)) {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fname) out.push(`${file}|${chainOf(n)}`);
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out.sort();
}
// ★直読みしてよい所（これ以外に 1 つでも増えたら赤・減っても赤）
const EXPECTED_READS = [
  // この回の 1 関数（「Ctrl か（Mac なら ⌘ も）」「Ctrl に畳んでいない meta（Windows の Win キー）」）
  "src/platform.ts|primaryMod|ctrlKey",
  "src/platform.ts|primaryMod|metaKey",
  "src/platform.ts|unfoldedMeta|metaKey",
  // 以前から ctrl と meta の**両方**を見ている所（Windows の Win＋クリック等の挙動を変えないため触らない）
  "src/editor/editor.ts|updateSelection|ctrlKey",
  "src/editor/editor.ts|updateSelection|metaKey",
  "src/main.ts|isReloadKey|ctrlKey",
  "src/main.ts|isReloadKey|metaKey",
  "src/library.ts|mount|ctrlKey",
  "src/library.ts|mount|metaKey",
  // V183 (A-82): 押した修飾キーの**ほか**に押されている修飾キー（単体タップの候補にしない）。⌘ の keydown では自分の metaKey を除き
  //  control は数える＝ctrlKey と metaKey を畳まずに別々に読む必要がある（primaryMod では区別できない）
  "src/keymap.ts|otherModHeld|ctrlKey",
  "src/keymap.ts|otherModHeld|metaKey",
  // 診断ログ（押した修飾キーを**そのまま**記録するのが目的）
  "src/editor/editor.ts|keyLogHandler|ctrlKey",
  "src/editor/editor.ts|keyLogHandler|ctrlKey",
  "src/editor/editor.ts|keyLogHandler|metaKey",
  "src/editor/editor.ts|keyLogHandler|metaKey",
].sort();
const EXPECTED_PRIMARY = [
  "src/keymap.ts|bindingFromEvent",
  "src/keymap.ts|bindingFromPointer",
  "src/keymap.ts|eventKey",
  "src/keymap.ts|pointerEventKey",
  "src/main.ts|captureKey>onPointer",
  "src/editor/editor.ts|openAudioPanel>bind", // Ctrl（Mac は ⌘ も）＋ホイール＝波形の拡大
  "src/editor/editor.ts|updateSelection", // フォルダの行の Shift/Ctrl 判定
  "src/editor/editor.ts|buildToolOptions", // 文字の入力欄の中の Ctrl+Enter
  "src/editor/editor.ts|onKeyDown", // 入力欄の外の Ctrl+Enter
].sort();
/** 呼ぶ所の「判断に使っている式」の形（空白は詰める）。keymap.ts の中は振る舞いの検査があるので、画面側だけを固定する */
const EXPECTED_SHAPES = [
  "src/editor/editor.ts|openAudioPanel>bind|if (primaryMod(e))",
  'src/editor/editor.ts|buildToolOptions|if ((e.code === "Enter" || e.code === "NumpadEnter") && primaryMod(e))',
  // ★V214 (M-2b-1a): フォルダの行の選び方と Enter の確定はコア（selectLayerRow・enterKey(primary)）へ移った。primaryMod を呼ぶのは
  //  前と同じ PC の 2 関数で、判断はその値を受けたコアがする（`kind === "folder" && !m.shift && !m.primary`／`this.textDraft && primary`＝
  //  式の意味は前と同じ。動きは [S-1] が updateSelection と ⌘Enter を本物で叩いて見る）。表は PC の呼ぶ所の形に合わせた（数は同じ 6）。
  //  updateSelection の形は if でも変数でもない（コアへ渡す 1 文）＝下の「?」の形を**切らずに**全部持つ（primary: primaryMod(ev) まで縛る）
  "src/editor/editor.ts|updateSelection|?this.selectLayerRow( id, kind, { ctrlOrMeta: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey, primary: primaryMod(ev) }, this.displayRows.map((r) => r.id) );",
  "src/editor/editor.ts|onKeyDown|if (this.enterKey(primaryMod(e)))",
  "src/main.ts|captureKey>onPointer|const mods = primaryMod(e) || e.altKey || e.shiftKey",
  "src/main.ts|captureKey>onPointer|if (unfoldedMeta(e))",
].sort();
/** 画面側（editor.ts・main.ts）で fnames を呼ぶ所を囲む if の条件／変数の初期化の形 */
function conditionShapes(dir: string, fnames: string[]): string[] {
  const out: string[] = [];
  for (const [file, src] of srcFiles(dir)) {
    // ★V213: editor.ts のコードの一部はコア（src/editor/core/editorCore.ts）へ移った＝コアも画面側と同じに見る（いまは呼ぶ所 0）
    if (file !== "src/editor/editor.ts" && file !== "src/editor/core/editorCore.ts" && file !== "src/main.ts") continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && fnames.includes(n.expression.text)) {
        let p: ts.Node = n;
        while (p.parent && !ts.isIfStatement(p.parent) && !ts.isVariableDeclaration(p.parent) && !ts.isBlock(p.parent)) p = p.parent;
        const host = p.parent;
        const norm = (t: string) => t.replace(/\s+/g, " ").trim();
        if (host && ts.isIfStatement(host)) out.push(`${file}|${chainOf(n)}|if (${norm(host.expression.getText(sf))})`);
        else if (host && ts.isVariableDeclaration(host))
          out.push(`${file}|${chainOf(n)}|${norm((host.parent as ts.VariableDeclarationList).getText(sf))}`);
        // ★V214: 前は 80 字で切っていた（そのときは表に「?」の形が無かった）。V214 でコアへ渡す 1 文が表に入ったので、
        //  切ると primaryMod の所が表から落ちる＝全部持つ（縛りは強くなるだけ）
        else out.push(`${file}|${chainOf(n)}|?${norm(p.getText(sf))}`);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out.sort();
}
const EXPECTED_UNFOLDED = [
  "src/keymap.ts|eventKey",
  "src/keymap.ts|pointerEventKey",
  "src/main.ts|captureKey>onPointer",
].sort();
function multisetDiff(got: string[], want: string[]): string {
  const g = [...got];
  const missing: string[] = [];
  for (const w of want) {
    const i = g.indexOf(w);
    if (i >= 0) g.splice(i, 1);
    else missing.push(w);
  }
  return [g.length ? `余分: ${g.join(", ")}` : "", missing.length ? `足りない: ${missing.join(", ")}` : ""].filter(Boolean).join(" / ");
}
async function groupS5(T: Tree): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  const copies: string[] = [];
  const reads = modReads(T.dir, copies);
  if (process.env.V181_PRINT_READS) console.log([...reads, ...copies.map((c) => `${c}（サンプルへの写し）`)].join("\n"));
  await add(`[S-5] ★ctrlKey / metaKey の直読みは表の ${EXPECTED_READS.length} か所だけ（構文木・分割代入と添字も数える）`, () => {
    const d = multisetDiff(reads, EXPECTED_READS);
    return d ? ng(d) : ok();
  });
  await add(`[S-5] ★V213: コアのサンプルへの写し（ctrl: e.ctrlKey / meta: e.metaKey）は表の ${EXPECTED_SAMPLE_COPY.length} か所だけ・サンプルの ctrl / meta を読む所は 0（型で見る）`, () => {
    const d = multisetDiff(copies, EXPECTED_SAMPLE_COPY);
    if (d) return ng(`写し: ${d}`);
    const sm = sampleModReads(T.dir);
    if (sm.probe === 0) return ng("サンプルの型が引けない（StrokeSample の x を読む所が 0＝検査が黙る）");
    return sm.reads.length ? ng(`★サンプルの ctrl / meta を読んでいる（primaryMod を通らない判断）: ${sm.reads.join(", ")}`) : ok();
  });
  await add(`[S-5] ★primaryMod を呼ぶ所が表の ${EXPECTED_PRIMARY.length} か所`, () => {
    const d = multisetDiff(callSites(T.dir, "primaryMod"), EXPECTED_PRIMARY);
    return d ? ng(d) : ok();
  });
  await add(`[S-5] unfoldedMeta を呼ぶ所が表の ${EXPECTED_UNFOLDED.length} か所`, () => {
    const d = multisetDiff(callSites(T.dir, "unfoldedMeta"), EXPECTED_UNFOLDED);
    return d ? ng(d) : ok();
  });
  // ★第三者レビュー X01 / X02: 入力欄の中の ⌘Enter（buildToolOptions）と波形の ⌘＋ホイール（openAudioPanel>bind）は
  //  DOM を組まないと動かせず、primaryMod を「呼んでいるか」しか見ていなかった（Shift+Enter でも確定・拡大と移動が逆、が緑）。
  //  **呼ぶ所ごとに、その式の形を固定**する（書き方を変えたら赤＝黙らない。直すときはこの表も直す）
  await add("[S-5] ★primaryMod / unfoldedMeta を使う式の形が表どおり（入力欄の ⌘Enter・波形の ⌘＋ホイール・フォルダの行・取得の＋クリック）", () => {
    const got = conditionShapes(T.dir, ["primaryMod", "unfoldedMeta"]);
    const d = multisetDiff(got, EXPECTED_SHAPES);
    return d ? ng(d) : ok();
  });
  await add("[S-5] 拾えている（空振りしていない）: 直読みが 1 件以上・primaryMod の呼び出しが 1 件以上", () =>
    reads.length > 0 && callSites(T.dir, "primaryMod").length > 0 ? ok() : ng(`reads=${reads.length}`)
  );
  return r;
}

// =====================================================================================
// [S-6] 入力欄では、Mac のふりの ⌘C / ⌘V / ⌘Z がアプリの命令を動かさない（本物の editor.ts）
// =====================================================================================
async function groupS6(T: Tree): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  setMac(T, true);
  try {
    const E = makeEd(T, T.K.BUILTIN_PRESETS[0]);
    const U = makeEd(T, USER_PRESETS[0]);
    const KEYS: [string, string, Mods][] = [
      ["c", "KeyC", { meta: true }],
      ["v", "KeyV", { meta: true }],
      ["x", "KeyX", { meta: true }],
      ["z", "KeyZ", { meta: true }],
      ["z", "KeyZ", { meta: true, shift: true }],
      ["y", "KeyY", { meta: true }],
      ["a", "KeyA", { meta: true }],
      ["s", "KeyS", { meta: true }],
    ];
    // 対照: キャンバスでは効く（この検査が空振りしていない）
    await add("[S-6] 対照: 入力欄の外では ⌘C / ⌘V / ⌘Z が命令を動かす", () => {
      const got = [E.key(kev("c", "KeyC", { meta: true })), E.key(kev("v", "KeyV", { meta: true })), E.key(kev("z", "KeyZ", { meta: true }))];
      return got.join("|") === "cmd:edit.copy pd|cmd:edit.paste pd|cmd:edit.undo pd" ? ok() : ng(got.join(" | "));
    });
    const TARGETS: [string, Mod][] = [
      ["textarea（文字ツールの入力欄）", { tagName: "TEXTAREA" }],
      ["input（ライブラリの検索欄など）", { tagName: "INPUT" }],
      ["select", { tagName: "SELECT" }],
      ["contenteditable", { tagName: "DIV", isContentEditable: true }],
    ];
    for (const [label, target] of TARGETS)
      await add(`[S-6] ★${label} にフォーカス: ⌘C / ⌘V / ⌘X / ⌘Z / ⇧⌘Z / ⌘Y / ⌘A / ⌘S が何も動かさず preventDefault もしない`, () => {
        const bad: string[] = [];
        for (const [k, code, m] of KEYS) {
          const got = E.key(kev(k, code, m, { target }));
          if (got !== "-") bad.push(`${tag(m)} ${code}: ${got}`);
        }
        return bad.length ? ng(bad.join(" / ")) : ok();
      });
    await add("[S-6] ★入力欄にフォーカス: ⌘ の単押しもタップを発動しない（Control のタップ＝元に戻す を割り当てていても）", () => {
      const a = U.tap("Meta", "MetaLeft", { tagName: "TEXTAREA" });
      const b = U.tap("Meta", "MetaLeft", CANVAS_T); // 対照
      return a === "-" && b === "cmd:edit.undo" ? ok() : ng(`入力欄=${a} 対照=${b}`);
    });
    await add("[S-6] ★ホーム画面（main.ts をそのまま）: 検索欄など入力欄の中・ダイアログが出ているときは ⌘, も ⌘ の単押しも設定を開かず preventDefault もしない", () => {
      const H = makeHome(T, T.K.BUILTIN_PRESETS[0]);
      const a = H.key(kev(",", "Comma", { meta: true }, { target: { tagName: "INPUT" } }));
      const b = makeHome(T, T.K.BUILTIN_PRESETS[0], { modal: true }).key(kev(",", "Comma", { meta: true }, { target: BODY_T }));
      const c = makeHome(T, HOME_TAP_PRESET).tap("Meta", "MetaLeft", { tagName: "INPUT" });
      const d = H.key(kev(",", "Comma", { meta: true }, { target: BODY_T })); // 対照
      return a === "-" && b === "-" && c === "-" && d === "settings pd" ? ok() : ng(`入力欄=${a} ダイアログ=${b} 入力欄のタップ=${c} 対照=${d}`);
    });
    await add("[S-6] 入力欄の中の ⌘Enter は window 側では確定しない（入力欄自身の keydown が確定する＝二重にならない）", () => {
      E.ed.textDraft = { text: "x" };
      const a = E.key(kev("Enter", "Enter", { meta: true }, { target: { tagName: "TEXTAREA" } }));
      const b = E.key(kev("Enter", "Enter", { meta: true })); // 対照（入力欄の外）
      E.ed.textDraft = null;
      return a === "-" && b === "commitText pd" ? ok() : ng(`入力欄=${a} 外=${b}`);
    });
  } finally {
    setMac(T, null);
  }
  return r;
}

// =====================================================================================
// 実行
// =====================================================================================
type Group = "S-A" | "S-1" | "S-2" | "S-3" | "S-4" | "S-5" | "S-6";
async function runGroups(T: Tree, B: Tree | null, groups: Group[], rows?: DictRow[]): Promise<Record<Group, R[]>> {
  const out = {} as Record<Group, R[]>;
  for (const g of groups) {
    out[g] =
      g === "S-A"
        ? await groupSA(T)
        : g === "S-1"
          ? await groupS1(T)
          : g === "S-2"
            ? await groupS2(T, B)
            : g === "S-3"
              ? await groupS3(T, rows)
              : g === "S-4"
                ? await groupS4(T)
                : g === "S-5"
                  ? await groupS5(T)
                  : await groupS6(T);
  }
  return out;
}

const t0 = Date.now();
const ALL: Group[] = ["S-A", "S-1", "S-2", "S-3", "S-4", "S-5", "S-6"];
const m0dir = path.join(WORK, "m0");
copySrc(m0dir);
const T0 = await loadTree(m0dir, "m0");
const B = await baseTree();
const rows: DictRow[] = [];
const res0 = await runGroups(T0, B, ALL, rows);
for (const g of ALL) for (const x of res0[g]) check(x.name, x.v.ok, x.v.why);
const allGreen = ALL.every((g) => res0[g].every((x) => x.v.ok));
check("[S-0] 無改変の写しでは全部緑", allGreen);

if (TABLE) {
  console.log("\n| 言語 | キー | 辞書（Windows の表示＝原文） | Mac の表示 |\n|---|---|---|---|");
  for (const x of rows) console.log(`| ${x.lang} | \`${x.key}\` | ${x.raw.replace(/\|/g, "\\|")} | ${x.mac.replace(/\|/g, "\\|")} |`);
}

// =====================================================================================
// [S-R] 反証: わざと壊した写しで、狙った検査が赤くなること
// =====================================================================================
interface Mutation {
  id: string;
  why: string;
  edits: Edit[];
  /** 赤くなるはずの検査群。**挙げた群のどれもが**「例外以外の赤」を 1 つ以上出したときだけ効いたと数える */
  expect: Group[];
}
const PF = "src/platform.ts";
const KM = "src/keymap.ts";
const MA = "src/main.ts";
const ED = "src/editor/editor.ts";
const CORE = "src/editor/core/editorCore.ts"; // ★V213: editor.ts の描く処理の移り先
const MUTATIONS: Mutation[] = [
  // ---- [S-1] 折り畳み（Mac のふりで ⌘ が効く） ----
  {
    id: "R01",
    why: "折り畳みを外す（primaryMod が ctrlKey だけ）",
    edits: [{ file: PF, from: "return Boolean(e.ctrlKey) || (isMacPlatform() && Boolean(e.metaKey));", to: "return Boolean(e.ctrlKey);" }],
    expect: ["S-1", "S-4", "S-6"],
  },
  {
    id: "R02",
    why: "Mac でも ⌘ を M として混ぜる（unfoldedMeta が常に meta）",
    edits: [{ file: PF, from: "return !isMacPlatform() && Boolean(e.metaKey);", to: "return Boolean(e.metaKey);" }],
    expect: ["S-1"],
  },
  {
    id: "R03",
    why: "照合キー（eventKey）が ctrlKey を直に読む",
    edits: [
      {
        file: KM,
        from: 'return `${primaryMod(e) ? "C" : ""}${e.shiftKey ? "S" : ""}${e.altKey ? "A" : ""}${\n    unfoldedMeta(e) ? "M" : ""\n  }|${normCode(e.code)}`;',
        to: 'return `${e.ctrlKey ? "C" : ""}${e.shiftKey ? "S" : ""}${e.altKey ? "A" : ""}${\n    unfoldedMeta(e) ? "M" : ""\n  }|${normCode(e.code)}`;',
      },
    ],
    expect: ["S-1", "S-5"],
  },
  {
    id: "R04",
    why: "クリックの照合キー（pointerEventKey）が ctrlKey を直に読む",
    edits: [
      {
        file: KM,
        from: 'return `${primaryMod(e) ? "C" : ""}${e.shiftKey ? "S" : ""}${e.altKey ? "A" : ""}${\n    unfoldedMeta(e) ? "M" : ""\n  }|B${e.button}`;',
        to: 'return `${e.ctrlKey ? "C" : ""}${e.shiftKey ? "S" : ""}${e.altKey ? "A" : ""}${\n    unfoldedMeta(e) ? "M" : ""\n  }|B${e.button}`;',
      },
    ],
    expect: ["S-1", "S-5"],
  },
  {
    id: "R05",
    why: "⇧⌘Z（Mac の固定キー）を足さない",
    edits: [
      {
        file: KM,
        from: "const legacy = isMacPlatform() ? [...LEGACY_BINDINGS, ...MAC_LEGACY_BINDINGS] : LEGACY_BINDINGS;",
        to: "const legacy = LEGACY_BINDINGS;",
      },
    ],
    expect: ["S-1"],
  },
  {
    id: "R06",
    why: "実行側のタップで ⌘ を Control に畳まない（ModTapWatcher.up）",
    edits: [
      {
        file: KM,
        from: "    const k = tapModOf(key);\n    if (!cand || !k || cand.key !== k) return null;",
        to: "    const k = isTapMod(key) ? key : null;\n    if (!cand || !k || cand.key !== k) return null;",
      },
    ],
    expect: ["S-1"],
  },
  {
    id: "R07",
    why: "入力欄の外の ⌘Enter（文字の確定）が ctrlKey を直に読む",
    // ★V214 (M-2b-1a): 文字の確定の判断はコアの enterKey(primary) へ移った。PC は `this.enterKey(primaryMod(e))` で渡す＝同じ壊し方をそこに当てる
    edits: [{ file: ED, from: "if (this.enterKey(primaryMod(e))) {", to: "if (this.enterKey(e.ctrlKey)) {" }],
    expect: ["S-1", "S-5"],
  },
  {
    id: "R08",
    why: "フォルダの行の Ctrl 判定が ctrlKey を直に読む",
    // ★V214 (M-2b-1a): フォルダの行の判断はコアの selectLayerRow へ移った。PC は `primary: primaryMod(ev)` で渡す＝同じ壊し方をそこに当てる
    edits: [
      {
        file: ED,
        from: "primary: primaryMod(ev) }",
        to: "primary: ev.ctrlKey }",
      },
    ],
    expect: ["S-1", "S-5"],
  },
  // ---- [S-2] Windows は 1 か所も変えない ----
  {
    id: "R09",
    why: "折り畳みを Windows にも効かせる（Win キーも Ctrl）",
    edits: [
      {
        file: PF,
        from: "return Boolean(e.ctrlKey) || (isMacPlatform() && Boolean(e.metaKey));",
        to: "return Boolean(e.ctrlKey) || Boolean(e.metaKey);",
      },
    ],
    expect: ["S-2"],
  },
  {
    id: "R10",
    why: "⇧Ctrl+Z（やり直し）を Windows にも足す",
    edits: [
      {
        file: KM,
        from: "const legacy = isMacPlatform() ? [...LEGACY_BINDINGS, ...MAC_LEGACY_BINDINGS] : LEGACY_BINDINGS;",
        to: "const legacy = [...LEGACY_BINDINGS, ...MAC_LEGACY_BINDINGS];",
      },
    ],
    expect: ["S-2"],
  },
  {
    id: "R11",
    why: "Win キーの単押しを Control のタップにする（Windows でも畳む）",
    edits: [
      {
        file: KM,
        from: 'const k = key === "Meta" && isMacPlatform() ? "Control" : key;',
        to: 'const k = key === "Meta" ? "Control" : key;',
      },
    ],
    expect: ["S-2"],
  },
  {
    id: "R12",
    why: "記号への置き換えを Windows にも効かせる（生成する表記）",
    edits: [{ file: PF, from: "return isMacPlatform() ? macKeyNotation(text) : text;", to: "return macKeyNotation(text);" }],
    expect: ["S-2"],
  },
  {
    id: "R13",
    why: "記号への置き換えを Windows にも効かせる（辞書の文言）",
    edits: [
      {
        file: PF,
        from: "if (!isMacPlatform() || NON_KEY_WORD_DICT_KEYS.has(dictKey)) return text;",
        to: "if (NON_KEY_WORD_DICT_KEYS.has(dictKey)) return text;",
      },
    ],
    expect: ["S-2"],
  },
  // ---- [S-3] 表記 ----
  {
    id: "R14",
    why: "Shift の規則を外す（⇧ にしない）",
    edits: [
      {
        file: PF,
        from: 'const MOD_SYMBOL: Record<string, string> = { Alt: "⌥", Shift: "⇧", Ctrl: "⌘" };',
        to: 'const MOD_SYMBOL: Record<string, string> = { Alt: "⌥", Shift: "Shift", Ctrl: "⌘" };',
      },
    ],
    expect: ["S-3"],
  },
  {
    id: "R15",
    why: "Alt の規則を外す（⌥ にしない）",
    edits: [
      {
        file: PF,
        from: 'const MOD_SYMBOL: Record<string, string> = { Alt: "⌥", Shift: "⇧", Ctrl: "⌘" };',
        to: 'const MOD_SYMBOL: Record<string, string> = { Alt: "Alt", Shift: "⇧", Ctrl: "⌘" };',
      },
    ],
    expect: ["S-3"],
  },
  {
    id: "R16",
    why: "並びを Mac のメニューと逆にする（⌘⇧S）",
    edits: [{ file: PF, from: 'const MOD_ORDER = ["Alt", "Shift", "Ctrl"];', to: 'const MOD_ORDER = ["Ctrl", "Shift", "Alt"];' }],
    expect: ["S-3"],
  },
  {
    id: "R17",
    why: "キーの刻印の前の区切りを落とさない（⌘+Z）",
    edits: [{ file: PF, from: "return cap === undefined ? sym : sym + cap;", to: 'return cap === undefined ? sym : sym + "+" + cap;' }],
    expect: ["S-3"],
  },
  {
    id: "R18",
    why: "キーではない語の除外を外す（en の Shift per frame が ⇧ に化ける）",
    edits: [
      {
        file: PF,
        from: "if (!isMacPlatform() || NON_KEY_WORD_DICT_KEYS.has(dictKey)) return text;",
        to: "if (!isMacPlatform()) return text;",
      },
    ],
    expect: ["S-3"],
  },
  {
    id: "R19",
    why: "t() が置き換えを通さない（辞書の文言が Ctrl のまま）",
    edits: [{ file: "src/i18n/index.ts", from: "  return fill(platformKeysForDict(key, raw), vars);", to: "  return fill(raw, vars);" }],
    expect: ["S-3"],
  },
  {
    id: "R20",
    why: "keyLabel が置き換えを通さない",
    edits: [{ file: KM, from: "return platformKeys(keyLabelText(b));", to: "return keyLabelText(b);" }],
    expect: ["S-3"],
  },
  {
    id: "R21",
    why: "modLabel が置き換えを通さない",
    edits: [{ file: KM, from: 'return platformKeys(m === "Control" ? "Ctrl" : m);', to: 'return m === "Control" ? "Ctrl" : m;' }],
    expect: ["S-3"],
  },
  {
    id: "R22",
    why: "置き換えを {…} を埋めたあとに当てる（利用者の名前まで ⌘ に化ける）",
    edits: [
      {
        file: "src/i18n/index.ts",
        from: "  return fill(platformKeysForDict(key, raw), vars);",
        to: "  return platformKeysForDict(key, fill(raw, vars));",
      },
    ],
    expect: ["S-3"],
  },
  // ---- [S-4] 登録 ----
  {
    id: "R23",
    why: "⌘＋文字を meta のまま保存する（ctrl にしない）",
    edits: [
      {
        file: KM,
        from: "  const b: KeyBinding = { code: normCode(e.code) };\n  if (primaryMod(e)) b.ctrl = true;",
        to: "  const b: KeyBinding = { code: normCode(e.code) };\n  if (e.ctrlKey) b.ctrl = true;\n  if (e.metaKey) (b as Record<string, unknown>).meta = true;",
      },
    ],
    expect: ["S-4", "S-5"],
  },
  {
    id: "R24",
    why: "⌘＋クリックを ctrl として登録しない（bindingFromPointer が ctrlKey を直に読む）",
    edits: [
      {
        file: KM,
        from: '  const b: KeyBinding = { code: "", button: (e.button === 1 ? 1 : e.button === 2 ? 2 : 0) as 0 | 1 | 2 };\n  if (primaryMod(e)) b.ctrl = true;',
        to: '  const b: KeyBinding = { code: "", button: (e.button === 1 ? 1 : e.button === 2 ? 2 : 0) as 0 | 1 | 2 };\n  if (e.ctrlKey) b.ctrl = true;',
      },
    ],
    expect: ["S-4", "S-5"],
  },
  {
    id: "R25",
    why: "設定画面が ⌘＋クリックを Win と同じく断る（e.metaKey を直に読む）",
    edits: [{ file: MA, from: "if (unfoldedMeta(e)) return; // Win は登録できない", to: "if (e.metaKey) return; // Win は登録できない" }],
    expect: ["S-4", "S-5"],
  },
  {
    id: "R26",
    why: "設定画面が ⌘ の単押しを候補にしない（押したとき）",
    edits: [
      {
        file: MA,
        // V183: 押したときの判定は tapCandidateOf になった（狙いは同じ＝⌘ の単押しを候補にしない）
        from: "        const tk = tapCandidateOf(e.key, {",
        to: '        const tk = e.key === "Meta" ? null : tapCandidateOf(e.key, {',
      },
    ],
    expect: ["S-4"],
  },
  {
    id: "R27",
    why: "設定画面が ⌘ の単押しを受けない（離したとき）",
    edits: [{ file: MA, from: "const tk = tapModOf(e.key); // V181", to: 'const tk = e.key === "Meta" ? null : tapModOf(e.key); // V181' }],
    expect: ["S-4"],
  },
  // ---- [S-5] 直読み ----
  {
    id: "R28",
    why: "波形の拡大で ctrl と meta を直に読む（Mac では同じ動きだが 1 関数を通らない）",
    edits: [
      {
        file: ED,
        from: "            if (primaryMod(e)) {\n              const frac",
        to: "            if (e.ctrlKey || e.metaKey) {\n              const frac",
      },
    ],
    expect: ["S-5"],
  },
  {
    id: "R29",
    why: "分割代入で ctrlKey を読む（別名に移す形）",
    // ★V214 (M-2b-1a): 文字の確定の判断はコアの enterKey(primary) へ移った。PC の `this.enterKey(primaryMod(e))` に当てる
    edits: [
      {
        file: ED,
        from: "      if (this.enterKey(primaryMod(e))) {",
        to: "      const { ctrlKey: held } = e;\n      if (this.enterKey(primaryMod(e) || held)) {",
      },
    ],
    expect: ["S-5"],
  },
  // ★V213: コアのサンプルへの写し（sampleOf）を判断の抜け道にする
  {
    id: "R53",
    why: "コアがサンプルの ctrl を読んで判断する（写した値は primaryMod を通らない）",
    edits: [
      {
        file: CORE,
        from: "    const pt = this.samplePixel(s);\n    this.pointerDown = true;\n",
        to: "    const pt = this.samplePixel(s);\n    if (s.ctrl) return \"\";\n    this.pointerDown = true;\n",
      },
    ],
    expect: ["S-5"],
  },
  {
    id: "R54",
    why: "コアがサンプルの meta を分割代入で読む（別名に移す形）",
    edits: [
      {
        file: CORE,
        from: "    const pt = this.samplePixel(s);\n    this.pointerDown = true;\n",
        to: "    const pt = this.samplePixel(s);\n    const { meta: held } = s;\n    if (held) return \"\";\n    this.pointerDown = true;\n",
      },
    ],
    expect: ["S-5"],
  },
  {
    id: "R55",
    why: "サンプルへの写しで Ctrl と ⌘ を畳む（写しの形を変える＝判断を sampleOf に持ち込む）",
    edits: [{ file: ED, from: "ctrl: e.ctrlKey, meta: e.metaKey };", to: "ctrl: e.ctrlKey || e.metaKey, meta: e.metaKey };" }],
    expect: ["S-5"],
  },
  // ---- [S-6] 入力欄 ----
  {
    id: "R30",
    why: "editor の keydown の入力欄の門番を外す",
    edits: [
      {
        file: ED,
        from: "    // M11-2: contenteditable も文字入力として除外（Space/Enter を再生に取られないように）\n    if (this.isTextEntry(e.target)) return;\n",
        to: "    // M11-2: contenteditable も文字入力として除外（Space/Enter を再生に取られないように）\n",
      },
    ],
    expect: ["S-6"],
  },
  {
    // ⚠ タップの門番は**押したとき（候補を立てない）と離したとき（発動しない）の 2 段**（V165）。
    //  片方だけ外しても、もう片方が止めるので挙動は変わらない（実測: 片方だけの書き換えは [S-6] 緑のまま）。
    //  ここでは両方を外して「入力欄で ⌘ の単押しが命令を動かす」形を作る
    id: "R31",
    why: "タップの入力欄の門番を 2 段とも外す（押したときの候補・離したときの発動）",
    edits: [
      { file: ED, from: "        this.isTextEntry(e.target) ||\n        e.isComposing ||", to: "        e.isComposing ||" },
      {
        file: ED,
        from: "if (!this.mounted || this.dialogOpen() || this.isTextEntry(e.target) || this.pointerDown) return;",
        to: "if (!this.mounted || this.dialogOpen() || this.pointerDown) return;",
      },
    ],
    expect: ["S-6"],
  },
  // ---- [S-A] 判定 ----
  {
    id: "R32",
    why: "Node の navigator でも判定する（macOS の機械で検査の結果が変わる）",
    edits: [{ file: PF, from: '  if (ua.startsWith("Node.js/")) return false;\n', to: "" }],
    expect: ["S-A"],
  },
  {
    // ★独立レビュー 1 回目の形そのもの（注入の経路しか見ていないと緑のまま）
    id: "R34",
    why: "判定の覚えの初期値を false にする（アプリは Mac でも一度も Mac と判定しない）",
    edits: [{ file: PF, from: "let detected: boolean | null = null;", to: "let detected: boolean | null = false;" }],
    expect: ["S-A"],
  },
  {
    id: "R35",
    why: "注入しない経路で navigator を渡さない",
    edits: [
      {
        file: PF,
        from: 'if (detected === null) detected = detectMacFrom(typeof navigator === "undefined" ? undefined : navigator);',
        to: "if (detected === null) detected = detectMacFrom(undefined);",
      },
    ],
    expect: ["S-A"],
  },
  {
    id: "R36",
    why: "判定を覚えない（呼ぶたびに navigator を読む）",
    edits: [
      {
        file: PF,
        from: 'if (detected === null) detected = detectMacFrom(typeof navigator === "undefined" ? undefined : navigator);',
        to: 'detected = detectMacFrom(typeof navigator === "undefined" ? undefined : navigator);',
      },
    ],
    expect: ["S-A"],
  },
  // ---- 独立レビュー 1 回目の指摘の形そのもの（どれも以前は v181 と旧 6 ゲートが緑） ----
  {
    id: "R37",
    why: "設定画面の取得で取った打鍵の preventDefault を外す（独立レビュー 表 8）",
    edits: [
      {
        file: MA,
        from: '      tapCand = null; // 他のキーが来た＝組み合わせ（この直後 finish するので実質は保険）\n      e.preventDefault();\n',
        to: "      tapCand = null; // 他のキーが来た＝組み合わせ（この直後 finish するので実質は保険）\n",
      },
    ],
    expect: ["S-4", "S-2"],
  },
  {
    id: "R38",
    why: "ホーム画面の ⌘, の preventDefault を外す（独立レビュー 表 9）",
    edits: [
      {
        file: MA,
        from: '  if (!ids || !ids.includes("app.settings")) return;\n  e.preventDefault();\n  void openSettingsMenu();\n};\n\n/** V153',
        to: '  if (!ids || !ids.includes("app.settings")) return;\n  void openSettingsMenu();\n};\n\n/** V153',
      },
    ],
    expect: ["S-1", "S-2"],
  },
  {
    id: "R39",
    why: "t() の複数形の道だけ置き換えを通さない（独立レビュー 表 10）",
    edits: [
      {
        file: "src/i18n/index.ts",
        from: "    if (v !== undefined) return fill(platformKeysForDict(key, v), vars);",
        to: "    if (v !== undefined) return fill(v, vars);",
      },
    ],
    expect: ["S-3"],
  },
  {
    id: "R40",
    why: "⌘ と ⌥ を一緒に押したときだけ畳まない（独立レビュー 表 3）",
    edits: [
      {
        file: PF,
        from: "return Boolean(e.ctrlKey) || (isMacPlatform() && Boolean(e.metaKey));",
        to: "return Boolean(e.ctrlKey) || (isMacPlatform() && Boolean(e.metaKey) && !(e as { altKey?: boolean }).altKey);",
      },
    ],
    expect: ["S-1"],
  },
  {
    id: "R41",
    why: "押しっぱなしのくり返しを Mac でも止めない（独立レビュー 中 1 の直す前の形）",
    edits: [{ file: ED, from: "    if (isMacPlatform()) e.preventDefault();\n  }", to: "  }" }],
    expect: ["S-1"],
  },
  {
    id: "R42",
    why: "押しっぱなしのくり返しを Windows でも止める（Windows が変わる）",
    edits: [{ file: ED, from: "    if (isMacPlatform()) e.preventDefault();\n  }", to: "    e.preventDefault();\n  }" }],
    expect: ["S-2"],
  },
  {
    id: "R43",
    why: "道具の巡回の押しっぱなしだけ Mac でも止めない",
    edits: [{ file: ED, from: "      if (e.repeat) return this.swallowRepeatOnMac(e);", to: "      if (e.repeat) return;" }],
    expect: ["S-1"],
  },
  // ---- 第三者レビュー（独立レビュー 2 回目の代わり）の形そのもの（どれも以前は v181 と旧 6 ゲートが緑） ----
  {
    id: "R44",
    why: "入力欄の中の確定が Shift+Enter でも効く（X01）",
    edits: [
      {
        file: ED,
        from: '} else if ((e.code === "Enter" || e.code === "NumpadEnter") && primaryMod(e)) {',
        to: '} else if ((e.code === "Enter" || e.code === "NumpadEnter") && (primaryMod(e) || e.shiftKey)) {',
      },
    ],
    expect: ["S-5"],
  },
  {
    id: "R45",
    why: "波形の拡大と移動が逆（X02）",
    edits: [{ file: ED, from: "            if (primaryMod(e)) {\n              const frac", to: "            if (!primaryMod(e)) {\n              const frac" }],
    expect: ["S-5"],
  },
  {
    id: "R46",
    why: "Mac でだけ Ctrl の無いクリックの割り当てを捨てる＝⌥＋クリックのスポイトが死ぬ（X06）",
    edits: [
      {
        file: KM,
        from: "    if (RESERVED_CODES.has(b.code)) continue;\n    put(bindingKey(b as KeyBinding), id as CommandId);",
        to: "    if (RESERVED_CODES.has(b.code)) continue;\n    if (isMacPlatform() && (b as KeyBinding).button !== undefined && !(b as KeyBinding).ctrl) continue;\n    put(bindingKey(b as KeyBinding), id as CommandId);",
      },
    ],
    expect: ["S-1"],
  },
  {
    id: "R47",
    why: "Mac でだけ ⌥ をタップの対象から外す（X07）",
    edits: [{ file: KM, from: "  return isTapMod(k) ? k : null;", to: '  return isTapMod(k) && !(isMacPlatform() && k === "Alt") ? k : null;' }],
    expect: ["S-1"],
  },
  {
    id: "R48",
    why: "設定画面の取得で 2 つ目の修飾キーが候補を壊さない（X10）",
    edits: [
      {
        // V183: 2 つ目の修飾キーは「もう候補がある」と「ほかの修飾キーのフラグ」の 2 つで候補にならない。両方を渡さない形が X10 と同じ穴
        file: MA,
        from: "pending: tapCand !== null, mods: e });",
        to: "pending: false });",
      },
    ],
    expect: ["S-2"],
  },
  {
    id: "R49",
    why: "Mac でだけ ⌘ の無い ⌥＋文字の登録で ⌥ を落とす（X11）",
    edits: [
      {
        file: KM,
        from: "  if (e.shiftKey) b.shift = true;\n  if (e.altKey) b.alt = true;\n  return b;\n}\n\n/** M16 (K-4): PointerEvent → KeyBinding",
        to: "  if (e.shiftKey) b.shift = true;\n  if (e.altKey && !(isMacPlatform() && !e.metaKey)) b.alt = true;\n  return b;\n}\n\n/** M16 (K-4): PointerEvent → KeyBinding",
      },
    ],
    expect: ["S-1"],
  },
  {
    id: "R50",
    why: "t() に {…} を渡したときだけ置き換えない（X13）",
    edits: [
      {
        file: "src/i18n/index.ts",
        from: "  return fill(platformKeysForDict(key, raw), vars);",
        to: "  return fill(vars ? raw : platformKeysForDict(key, raw), vars);",
      },
    ],
    expect: ["S-3"],
  },
  {
    id: "R51",
    why: "Mac でだけ Ctrl の無い固定キーを捨てる＝左手向けの H（手のひら）が消える（X17）",
    edits: [
      {
        file: KM,
        from: "const legacy = isMacPlatform() ? [...LEGACY_BINDINGS, ...MAC_LEGACY_BINDINGS] : LEGACY_BINDINGS;",
        to: "const legacy = isMacPlatform() ? [...LEGACY_BINDINGS.filter((l) => l.b.ctrl), ...MAC_LEGACY_BINDINGS] : LEGACY_BINDINGS;",
      },
    ],
    expect: ["S-1"],
  },
  {
    id: "R52",
    why: "設定画面の取得で Win（タップにならない修飾キー）が候補を壊さない（X19）",
    edits: [
      {
        // V183: 取得の候補の行が変わった（狙いは同じ＝Win の keydown で立っていた候補を捨てない）
        file: MA,
        from: "tapCand = tk ? { key: tk, at: performance.now() } : null;",
        to: 'tapCand = tk ? { key: tk, at: performance.now() } : e.key === "Meta" ? tapCand : null;',
      },
    ],
    expect: ["S-2"],
  },
  {
    id: "R33",
    why: "platform.ts の外で navigator.platform を読む（判定が 2 か所になる）",
    edits: [
      {
        file: KM,
        from: 'const k = key === "Meta" && isMacPlatform() ? "Control" : key;',
        to: 'const k = key === "Meta" && navigator.platform.startsWith("Mac") ? "Control" : key;',
      },
    ],
    expect: ["S-A"],
  },
];

if (!NO_MUTANTS) {
  for (const m of MUTATIONS) {
    const { tree, why } = await mutant(m.edits);
    if (!tree) {
      check(`[S-R] ${m.id}: ${m.why}`, false, why);
      continue;
    }
    const res = await runGroups(tree, B, m.expect);
    // 群ごとに「例外以外の赤」を拾う。**挙げた群のどれもが**赤くならなければ効いたと数えない
    const redsBy = m.expect.map((g) => ({
      g,
      reds: res[g].filter((x) => !x.v.ok && !x.v.threw).map((x) => `${x.name}（${x.v.why.slice(0, 90)}）`),
      threw: res[g].filter((x) => x.v.threw).map((x) => x.name),
    }));
    const green = redsBy.filter((x) => x.reds.length === 0);
    check(
      `[S-R] ${m.id}: ${m.why} → ${m.expect.join("・")} が赤`,
      green.length === 0,
      green.map((x) => `${x.g} は緑のまま${x.threw.length ? `（例外だけ: ${x.threw.slice(0, 2).join(", ")}）` : ""}`).join(" / ")
    );
    if (process.env.V181_VERBOSE) for (const x of redsBy) if (x.reds.length) console.log(`   ${m.id} ${x.g} の赤: ${x.reds[0]}`);
  }
}

console.log(`v181 smoke: pass=${pass} fail=${fail}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
if (fail > 0) process.exit(1);
