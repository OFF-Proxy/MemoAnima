// V183（A-82 修飾キー 3 つ重ねのタップ誤発動 ＋ A-83 V181 の検査の穴 9 つ）の回帰ゲート。引数不要:
//   npx tsx scripts/v183_smoke.ts               … 全部（反証込み）
//   npx tsx scripts/v183_smoke.ts --no-mutants  … 反証を除く（赤先行の確認・各コミットへの当て直し用）
//
// ★この回の約束（要件 docs/REQ_v181_followup.md・作者決定 2026-09-25 の G-1 / G-2）:
//   A-82 ほかの修飾キーが 1 つでも押されている間に押した修飾キーは、単体タップの候補にしない（Windows も Mac も）。
//        押されているかは**イベントのフラグ**で見る（押したキー自身のフラグは除く）。実行側（ModTapWatcher）と
//        設定画面の取得（main.ts の captureKey）は同じ関数（keymap.ts の tapCandidateOf）で決める
//   A-83 V181 の Codex 2 回目で「全ゲート緑」だった書き換え 9 通り（Y01〜Y06・Y08・Y09・Y16）を検査で赤にする
//        （製品のコードは変えない）
//
// [S-1] ★修飾キー（Ctrl / Shift / Alt / Meta）の 3 つ・4 つ重ねの全順列 × 離す順 × Windows / Mac で、4 つの口
//       （ModTapWatcher・本物の editor.ts の keydown / keyup・ホーム画面・設定画面の取得）のどれもタップを返さない。
//       同じ規則で止まる 2 つの修飾キーの形（先の候補が消えたあとのトン・Windows の Win を押したまま）も
// [S-2] ★この回の前の木（blob）と比べる（Windows / Mac × 4 つの口）: 単体のタップ・2 つ重ね・修飾キー＋文字（くり返しも）・
//       修飾キー＋クリック・Win キー・フォーカスが外れて keyup が来なかった形・IME の変換中の打鍵が 1 行も違わない。違ってよいのは
//       「Windows で Win を押したまま Ctrl / Shift / Alt をトン」だけ（同じ規則の帰結・発動しなくなる向きだけ）。
//       ModTapWatcher の総当たり: 旧版との差は全部「ほかの修飾キーのフラグが立った keydown で旧版が候補を立て、
//       それが発動した」形だけ。設定画面の取得と実行側の判定が総当たりで 1 つも食い違わない。
//       IME の変換中（isComposing・keyCode 229・両方）はホーム画面と editor が動かない（Codex 1 回目の Z04・2 回目の W13）。
//       押したときは門番が開いていて、離すときに閉じた形（入力欄へ移った・ダイアログ・IME）でもタップが動かない（Codex 2 回目の W09）。
//       実行側と取得が同じ関数を呼び、呼び出し元がイベントのフラグを渡す（構文木）。型では mods の渡し忘れがエラー
//       （TypeScript に写しを型検査させる・Codex 1 回目の Z12・2 回目の W07 / W08 / C02）
// [S-3] ★A-83（V181 の検査の穴・製品は変えない）:
//   ① Y06 本物の editor.ts の pointerCommandFor（3 ボタン × 修飾 16 × プリセット 5）を Mac / Windows で:
//       Windows は V181 の前の木と一致・Mac は ⌘ を含まない行が Windows と同じ・⌘ の行は Ctrl に畳んだ行と同じ
//   ② Y08 偽の DOM（querySelectorAll だけの偽物）で applyI18n を 7 言語 × Mac / Windows で通す（textContent / title /
//       placeholder）: Mac は Ctrl / Alt / Shift の語が残らず・この回の前の t() と同じ・Windows は辞書の原文のまま
//   ③ Y01・Y09・Y16 文字の入力欄の受け口／Y02・Y03 波形のホイール: **構文木で取り出して動かす**（captureKey と同じ道）。
//       入力欄は**登録を含むブロックごと**、打ちかけの文字あり／なしの両方で組み立て、偽の要素に実際に付いた受け口へ打鍵を送る
//       （Codex 1 回目の中1: 条件つき・途中の return で付かない形）。同じブロックの input・✓ / ✕・フォーカスを戻す動きも見る
//       （Codex 2 回目: 行き場の無いフォーカス＝activeElement が body・打った文字の置き換え）。波形は受け口と、同じ入れ物の本物の
//       localX（const＝あとから差し替えられない・枠の左端が 0 でない・表示の幅と絵の幅が違う canvas・カーソルの位置 2 つ・
//       Codex 1 回目の中2・2 回目の W05 / W06）。受け口の種類と passive と囲む条件（if・関数の境目・switch / default・付ける前に抜ける道）の表・
//       Esc で取消・Ctrl+Enter（Mac は ⌘ も）で確定・
//       preventDefault ＋ stopPropagation・IME 中は何もしない・Ctrl（Mac は ⌘）＋ホイールの拡大の向きとカーソルの位置・素のホイールの移動・
//       音が無いときは何もしない。V181 の前の木とこの回の前の木からも同じ道で取り出して比べる
//   ④ Y04・Y05 addEventListener の配線（editor の mount / unmount・ホーム・取得）を、囲む条件（関数の境目・switch / default・
//       付ける前に抜ける道＝起動時は DEV の診断ページだけ）まで構文木で表と突き合わせる・付けた口は外す
// [S-4] ★Codex の Y01〜Y16（V181 の Codex 2 回目の書き換えそのもの）を当てて、16 通りとも挙げた群が赤
// [S-0] 無改変の写しでは全部緑
// [S-R] 反証 34 通り（A-82 の直しを戻す・強すぎる形・呼び出し元がフラグを渡さない・配線を外す・付ける前に抜ける道・型・
//       Codex 1 回目の Z04 / Z10 / Z12 / Z13 と 2 回目の W01〜W06 / W08〜W10 / W13 を字面のまま）
//
// ★反証は**実ファイルを書き換えた写し**で走らせる（V177〜V181 と同じ流儀）。写しは node_modules/.v183-smoke/<pid>/
//  （サンドボックスでは環境変数 V183_SMOKE_WORK。その祖先に node_modules があること）。書き換えは**ちょうど 1 か所**に
//  当たらなければ赤・例外で落ちた赤は効いたと数えない・**挙げた群のどれもが**赤でなければ効いたと数えない。
// ★「旧版」は 2 つ: この回の前（62296d2・A-82 の比較）と V181 の前（54cfbf5・A-83 の Windows の比較）。どちらも blob から写す。
//  公開リポジトリの clone など blob が無い所では、その比較を SKIP と表示する（固定値の検査は走る）。
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
const PRINT_FP = !!process.env.V183_PRINT_FP;

// ================= 本物の editor.ts を Node で動かすための最小の舞台（V180・V181 と同じ） =================
const G = globalThis as unknown as Record<string, unknown>;
G.self = G;
G.window = G;
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
  /** src/platform.ts（V181 の前の木には無い＝null） */
  P: Mod | null;
  K: Mod;
  I: Mod;
  D: Record<string, Record<string, string>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Editor: any;
  mainSrc: string;
  edSrc: string;
  kmSrc: string;
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
  const rd = (p: string) => fs.readFileSync(path.join(dir, p), "utf8");
  return {
    label,
    dir,
    P,
    K,
    I,
    D,
    Editor: E.Editor,
    mainSrc: rd("src/main.ts"),
    edSrc: rd("src/editor/editor.ts"),
    kmSrc: rd("src/keymap.ts"),
  };
}
function setMac(T: Tree, mac: boolean | null) {
  T.P?.setMacPlatformForTest(mac);
}

// ================= 写し（無改変・旧版・反証）の置き場 =================
const WORK = path.join(
  process.env.V183_SMOKE_WORK || path.join(root, "node_modules", ".v183-smoke"),
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
/** この回の前（62296d2）の、この回が書き換える 3 ファイル（ほかのファイルはこの回で 1 行も変えていない） */
const BASE83_BLOBS: Record<string, string> = {
  "src/keymap.ts": "3d15975d9b309f722f6dc3114d2e0c7576e19898",
  "src/main.ts": "5d6f78f060c3452952765e78548a079de891676a",
  "src/editor/editor.ts": "cb411aafb5fe000a740824a57e8e6082b6c47459",
};
/** V181 の前（54cfbf5）の 4 ファイル（v181_smoke の BASE_BLOBS と同じ）。この木には src/platform.ts がまだ無い */
const BASE81_BLOBS: Record<string, string> = {
  "src/keymap.ts": "5786690c63be7ca8f157c733369d9cb8de7443e5",
  "src/editor/editor.ts": "413191b65f33b941f3036f7c48cdf8fa411c6d5e",
  "src/main.ts": "3643fd1cbaca9cbf5a1a851e36125442007dd21f",
  "src/i18n/index.ts": "d1ac153922409d4b7a7cd5a9c3930496217864b9",
};
async function blobTree(label: string, blobs: Record<string, string>, drop: string[] = []): Promise<Tree | null> {
  const dir = path.join(WORK, label);
  copySrc(dir);
  try {
    for (const [f, blob] of Object.entries(blobs)) {
      const text = execFileSync("git", ["cat-file", "blob", blob], { cwd: root, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
      fs.writeFileSync(path.join(dir, f), text);
    }
  } catch {
    return null;
  }
  for (const f of drop) fs.rmSync(path.join(dir, f), { force: true });
  return loadTree(dir, label);
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
const BODY_T = { tagName: "BODY" };
const INPUT_T = { tagName: "INPUT" };
/** ★第三者レビューの T16: 本物のイベント（KeyboardEvent / PointerEvent / WheelEvent）は、type・key・code・修飾キーのフラグなどが
 *  **プロトタイプの getter**（`{ ...e }` で写すと全部落ちる）。偽物も同じ形にして、「イベントを写してから判定へ渡す」書き換えが
 *  偽物でだけ通るのを防ぐ。`target` と、既定の動きを止めたかの印（defaultPrevented / stopped）だけは自分のプロパティ（検査が書き換える） */
const EVENT_FIELDS = new Set([
  "type",
  "key",
  "code",
  "ctrlKey",
  "shiftKey",
  "altKey",
  "metaKey",
  "repeat",
  "isComposing",
  "keyCode",
  "button",
  "clientX",
  "clientY",
  "pointerId",
  "pointerType",
  "deltaX",
  "deltaY",
]);
/** 共通のプロトタイプ（getter は、イベントごとの見えない記録から読む＝`{ ...e }` の写しには記録も getter も乗らない） */
const EVENT_REC = Symbol("event-fields");
const EVENT_PROTO: Mod = {};
for (const k of EVENT_FIELDS)
  Object.defineProperty(EVENT_PROTO, k, {
    get(this: Mod) {
      return this[EVENT_REC as unknown as string][k];
    },
    enumerable: false,
  });
function realLike(fields: Mod, extra: Mod): Mod {
  const f: Mod = { ...fields };
  const own: Mod = { target: CANVAS_T, defaultPrevented: false, stopped: false };
  for (const [k, v] of Object.entries(extra)) (EVENT_FIELDS.has(k) ? f : own)[k] = v;
  const e: Mod = Object.create(EVENT_PROTO);
  Object.defineProperty(e, EVENT_REC, { value: f, enumerable: false });
  Object.assign(e, own);
  e.preventDefault = () => void (e.defaultPrevented = true);
  e.stopPropagation = () => void (e.stopped = true);
  e.stopImmediatePropagation = () => void (e.stopped = true);
  return e;
}
function kev(key: string, code: string, m: Mods = {}, extra: Mod = {}): Mod {
  return realLike(
    { type: "keydown", key, code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta, repeat: false, isComposing: false, keyCode: 0 },
    extra
  );
}
function pev(button: number, m: Mods = {}, extra: Mod = {}): Mod {
  return realLike(
    { type: "pointerdown", button, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta, clientX: 100, clientY: 100, pointerId: 1, pointerType: "mouse" },
    extra
  );
}
function* permutations<T>(xs: T[], k: number): Generator<T[]> {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest, k - 1)) yield [xs[i], ...p];
  }
}
const sha = (lines: string[]) => crypto.createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);

/** IME の印 → 打鍵に足す項目（本物の変換中は両方立つ） */
const IME_FIELDS: Record<string, Mod> = { "": {}, composing: { isComposing: true }, "229": { keyCode: 229 }, both: { isComposing: true, keyCode: 229 } };
// ---- 物理キー（code）→ key と修飾キーのフラグ ----
const KEYINFO: Record<string, { key: string; flag?: keyof Mods }> = {
  ControlLeft: { key: "Control", flag: "ctrl" },
  ControlRight: { key: "Control", flag: "ctrl" },
  ShiftLeft: { key: "Shift", flag: "shift" },
  ShiftRight: { key: "Shift", flag: "shift" },
  AltLeft: { key: "Alt", flag: "alt" },
  AltRight: { key: "Alt", flag: "alt" },
  MetaLeft: { key: "Meta", flag: "meta" },
  MetaRight: { key: "Meta", flag: "meta" },
  KeyQ: { key: "q" },
  KeyZ: { key: "z" },
  KeyY: { key: "y" },
  KeyC: { key: "c" },
  KeyX: { key: "x" },
  KeyV: { key: "v" },
  KeyS: { key: "s" },
  KeyH: { key: "h" },
  KeyP: { key: "p" },
  KeyN: { key: "n" },
  KeyA: { key: "a" },
  Comma: { key: "," },
  Enter: { key: "Enter" },
  NumpadEnter: { key: "Enter" },
  Escape: { key: "Escape" },
  Delete: { key: "Delete" },
  Backspace: { key: "Backspace" },
  F5: { key: "F5" },
  Digit1: { key: "1" },
  BracketLeft: { key: "[" },
};
const short = (code: string) =>
  ({ ControlLeft: "C", ControlRight: "c", ShiftLeft: "S", ShiftRight: "s", AltLeft: "A", AltRight: "a", MetaLeft: "M", MetaRight: "m" })[
    code
  ] ?? code;
/** 1 打鍵（押す・離す・くり返し・keyup が来ないまま離れた）／クリック／フォーカスが外れた／時間／描いている間 */
/** IME の変換中の打鍵（isComposing・keyCode 229）。★Codex 1 回目の Z04（ホーム画面の IME の門番を外しても緑）を見る */
type Ime = "composing" | "229" | "both";
type Ev =
  | { k: "down"; code: string; rep?: boolean; ime?: Ime }
  | { k: "up"; code: string; ime?: Ime }
  | { k: "lost"; code: string }
  | { k: "ptr"; button?: number }
  | { k: "blur" }
  | { k: "wait"; ms: number }
  | { k: "pen"; on: boolean };
const evText = (ev: Ev): string =>
  ev.k === "down"
    ? `${short(ev.code)}${ev.rep ? "↻" : "↓"}${ev.ime ? `(ime${ev.ime})` : ""}`
    : ev.k === "up"
      ? `${short(ev.code)}↑${ev.ime ? `(ime${ev.ime})` : ""}`
      : ev.k === "lost"
        ? `${short(ev.code)}⇡`
        : ev.k === "ptr"
          ? `click${ev.button ?? 0}`
          : ev.k === "blur"
            ? "blur"
            : ev.k === "wait"
              ? `+${ev.ms}ms`
              : ev.on
                ? "pen↓"
                : "pen↑";
const seqText = (s: Ev[]) => s.map(evText).join(" ");
function flagsOf(held: Set<string>): Mods {
  const m: Mods = {};
  for (const c of held) {
    const f = KEYINFO[c]?.flag;
    if (f) m[f] = true;
  }
  return m;
}
/** 1 つの口（ModTapWatcher・editor・ホーム・取得）。打鍵をそのまま流し、起きたことを文字で返す */
interface Port {
  feed(ev: Ev, e?: Mod): void;
  out(): string;
  done?(): boolean;
}
/** ブラウザと同じ形のフラグを付けて流す（keydown は押したキー自身も立つ・keyup は離したキーが落ちる） */
function runSeq(port: Port, s: Ev[], target: Mod = CANVAS_T): string {
  const held = new Set<string>();
  for (const ev of s) {
    if (port.done?.()) break;
    let e: Mod | undefined;
    const imeOf = (x?: Ime): Mod => ({ target, ...IME_FIELDS[x ?? ""] });
    if (ev.k === "down") {
      held.add(ev.code);
      e = kev(KEYINFO[ev.code].key, ev.code, flagsOf(held), { repeat: !!ev.rep, ...imeOf(ev.ime) });
    } else if (ev.k === "up") {
      held.delete(ev.code);
      e = kev(KEYINFO[ev.code].key, ev.code, flagsOf(held), { type: "keyup", ...imeOf(ev.ime) });
    } else if (ev.k === "lost") {
      held.delete(ev.code); // フォーカスの外で離した＝keyup は届かない
      continue;
    } else if (ev.k === "ptr") e = pev(ev.button ?? 0, flagsOf(held), { target });
    port.feed(ev, e);
  }
  return port.out();
}

// ================= 構文木から取り出して動かす（main.ts の captureKey・ホーム・editor の受け口） =================
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
/** ファイルの `import { … } from "./keymap"`・`"../platform"` などを読んで、ローカル名 → 値の表を作る（別名も解く） */
function importScope(src: string, T: Tree): Record<string, unknown> {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
  const scope: Record<string, unknown> = {};
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const mod = /(^|\/)keymap$/.test(spec) ? T.K : /(^|\/)platform$/.test(spec) ? T.P : null;
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
/** captureKey の `new Promise` を同期で決まる偽物にする（打鍵ごとに結果を読むため・await を挟まない） */
class SyncPromise<T> {
  done = false;
  v: T | undefined = undefined;
  constructor(exec: (res: (v: T) => void) => void) {
    exec((v) => {
      if (!this.done) {
        this.done = true;
        this.v = v;
      }
    });
  }
  then() {
    return this;
  }
}
interface Capture {
  captureKey: () => { promise: SyncPromise<unknown>; cancel: () => void };
  win: FakeWindow;
  clock: { t: number };
}
/** main.ts の captureKey を**そのまま**取り出す（./keymap・./platform の import は main.ts の import 文どおりに渡す） */
function compileCapture(T: Tree): Capture {
  const js = ts.transpileModule(findFunctionText(T.mainSrc, "captureKey"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const scope = importScope(T.mainSrc, T);
  const names = Object.keys(scope);
  const win = new FakeWindow();
  const clock = { t: 10_000 };
  const perf = { now: () => clock.t };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const captureKey = new Function(
    ...names,
    "window",
    "performance",
    "Promise",
    `"use strict";\n${js}\nreturn captureKey;`
  )(...names.map((n) => scope[n]), win, perf, SyncPromise) as Capture["captureKey"];
  return { captureKey, win, clock };
}
function capturePort(C: Capture): Port {
  const cap = C.captureKey();
  const evs: Mod[] = [];
  return {
    done: () => C.win.ls.length === 0,
    feed(ev, e) {
      if (C.win.ls.length === 0) return;
      if (ev.k === "down" || ev.k === "up") {
        evs.push(e!);
        C.win.fire(ev.k === "down" ? "keydown" : "keyup", e!);
      } else if (ev.k === "ptr") {
        evs.push(e!);
        C.win.fire("pointerdown", e!);
      } else if (ev.k === "blur") C.win.fire("blur", {});
      else if (ev.k === "wait") C.clock.t += ev.ms;
      // pen: 設定画面の取得の最中に描く道は無い（何もしない）
    },
    out() {
      const flags = evs.map((e) => `${e.defaultPrevented ? "P" : "-"}${e.stopped ? "S" : "-"}`).join(",");
      const pending = C.win.ls.length > 0;
      if (pending) cap.cancel();
      if (C.win.ls.length) return "LEAK";
      return `${pending ? "pending" : JSON.stringify(cap.promise.v)} [${flags}]`;
    },
  };
}
/** main.ts の homeKeyBlocked / homeKeyHandler / homeKeyUpHandler を**そのまま**取り出す（V181 の [S-1] と同じ道） */
function compileHome(T: Tree) {
  const src = T.mainSrc;
  const sf = ts.createSourceFile("main.ts", src, ts.ScriptTarget.Latest, true);
  // ★第三者レビューの T05: 候補を捨てる homeModTapCancel も本物（blur・pointerdown の capture で呼ばれる）
  const wanted = new Set(["homeKeyBlocked", "homeKeyHandler", "homeKeyUpHandler", "homeModTapCancel"]);
  const parts: string[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && wanted.has(st.name.text)) parts.push(st.getText(sf));
    else if (
      ts.isVariableStatement(st) &&
      st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && wanted.has(d.name.text))
    )
      parts.push(st.getText(sf));
  }
  if (parts.length !== 4) throw new Error(`main.ts のホームのキーの部品が ${parts.length} つ（4 つのはず）`);
  const js = ts.transpileModule(parts.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const scope = importScope(src, T);
  const names = Object.keys(scope);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    ...names,
    "editorOpen",
    "homeLookup",
    "homeModTap",
    "openSettingsMenu",
    "document",
    `"use strict";\n${js}\nreturn { homeKeyHandler, homeKeyUpHandler, homeModTapCancel };`
  );
  // ★第三者レビューの T14: editorOpen（エディタ中はホームの口は何もしない）も渡せるように
  return (preset: Mod, watcher: Mod, onSettings: () => void, doc: Mod = { querySelector: () => null }, editorOpen = false) =>
    factory(
      ...names.map((n) => scope[n]),
      editorOpen,
      T.K.buildLookup(preset),
      watcher,
      async () => onSettings(),
      doc
    ) as { homeKeyHandler: (e: Mod) => void; homeKeyUpHandler: (e: Mod) => void; homeModTapCancel: (e?: Mod) => void };
}
type HomeFactory = ReturnType<typeof compileHome>;
function homePort(T: Tree, H: HomeFactory, preset: Mod): Port {
  const clock = { t: 10_000 };
  const w = new T.K.ModTapWatcher(() => clock.t);
  const hits: string[] = [];
  let now: string[] = [];
  const h = H(preset, w, () => void now.push("settings"));
  return {
    feed(ev, e) {
      now = [];
      if (ev.k === "down") h.homeKeyHandler(e!);
      else if (ev.k === "up") h.homeKeyUpHandler(e!);
      else if (ev.k === "ptr") h.homeModTapCancel(e!); // pointerdown の capture
      else if (ev.k === "blur") h.homeModTapCancel(realLike({ type: "blur" }, {}));
      else if (ev.k === "wait") clock.t += ev.ms;
      else if (ev.k === "pen" && ev.on) h.homeModTapCancel(pev(0)); // 押した瞬間は pointerdown
      if (now.length || e?.defaultPrevented) hits.push(`${evText(ev)}:${now.join("+") || "-"}${e?.defaultPrevented ? " pd" : ""}`);
    },
    out: () => hits.join(",") || "-",
  };
}
/** ModTapWatcher を直に（時計は 10 秒から＝「今の時刻そのもの」と比べる書き換えも見える） */
function watcherPort(T: Tree): Port {
  const clock = { t: 10_000 };
  const w = new T.K.ModTapWatcher(() => clock.t);
  let blocked = false;
  const outs: string[] = [];
  return {
    feed(ev, e) {
      if (ev.k === "down") w.down(e!.key, { repeat: e!.repeat, blocked, mods: e });
      else if (ev.k === "up") {
        const r = w.up(e!.key);
        if (r) outs.push(`${evText(ev)}:tap ${r}`);
      } else if (ev.k === "ptr" || ev.k === "blur") w.cancel();
      else if (ev.k === "wait") clock.t += ev.ms;
      else if (ev.k === "pen") {
        blocked = ev.on;
        if (ev.on) w.cancel();
      }
    },
    out: () => outs.join(",") || "-",
  };
}
/** 本物の editor.ts（V180・V181 と同じ舞台）。単体タップの時計だけ差し替える */
function makeEd(T: Tree, preset: Mod) {
  const ed = new T.Editor();
  const calls: string[] = [];
  ed.cb = { toast: () => {}, appendLog: () => {} };
  ed.mounted = true;
  ed.runCommand = (id: string) => void calls.push(`cmd:${id}`);
  ed.commitTextDraft = () => void calls.push("commitText");
  for (const k of [
    "refreshShapePreview",
    "rebuildLayers",
    "renderCanvas",
    "redrawOverlay",
    "updatePanCursor",
    "setXformPeek",
    "endPointerSession",
  ])
    ed[k] = () => {};
  ed.applyKeyPreset(preset);
  const clock = { t: 10_000 };
  ed.modTap = new T.K.ModTapWatcher(() => clock.t);
  return { ed, calls, clock };
}
function editorPort(T: Tree, preset: Mod): Port {
  const { ed, calls, clock } = makeEd(T, preset);
  const hits: string[] = [];
  return {
    feed(ev, e) {
      calls.length = 0;
      ed.lastCommandAt = new Map(); // V157 の二重発火の防御（50ms）が検査の連打で効かないように
      if (ev.k === "down") ed.keydownHandler(e);
      else if (ev.k === "up") ed.keyupHandler(e);
      else if (ev.k === "ptr") ed.modTapPointerHandler(); // window の capture の pointerdown
      else if (ev.k === "blur") ed.blurHandler();
      else if (ev.k === "wait") clock.t += ev.ms;
      else if (ev.k === "pen") {
        if (ev.on) ed.modTapPointerHandler();
        ed.pointerDown = ev.on;
      }
      if (calls.length || e?.defaultPrevented) hits.push(`${evText(ev)}:${calls.join("+") || "-"}${e?.defaultPrevented ? " pd" : ""}`);
    },
    out: () => hits.join(",") || "-",
  };
}
const tapHit = (portName: string, out: string): boolean =>
  portName === "capture" ? /"tap"/.test(out) : portName === "watcher" ? /tap /.test(out) : /(cmd:|settings)/.test(out);

// ---- プリセット ----
/** 3 つの修飾キーのタップを全部割り当てた利用者のプリセット（固定キーの Ctrl+Z 等も引き当て表に入る） */
const TAP_ALL: Mod = {
  id: "tapall",
  name: "tapall",
  bindings: {
    "edit.undo": { code: "", tap: "Control" },
    "edit.redo": { code: "", tap: "Alt" },
    "edit.copy": { code: "", tap: "Shift" },
  },
};
const HOME_TAPS: Mod[] = (["Control", "Shift", "Alt"] as const).map((tp) => ({
  id: `home-${tp}`,
  name: `home-${tp}`,
  bindings: { "app.settings": { code: "", tap: tp } },
}));
/** V181 の利用者のプリセット（照合・クリックの検査）＋クリックの割り当てを並べたもの */
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
const PTR_PRESET: Mod = {
  id: "u4",
  name: "u4",
  bindings: {
    "edit.pickColor": { code: "", button: 0, alt: true },
    "view.zoomIn": { code: "", button: 1, shift: true },
    "view.zoomOut": { code: "", button: 2, ctrl: true, alt: true },
    "frame.add": { code: "", button: 1, ctrl: true },
  },
};

// ================= 打鍵の並び =================
const MODS4 = ["ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft"];
const TAP_CODES = ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight"];
const META_CODES = ["MetaLeft", "MetaRight"];
const ALL_MOD_CODES = [...TAP_CODES, ...META_CODES];
const d = (code: string, rep = false, ime?: Ime): Ev => ({ k: "down", code, rep, ime });
const u = (code: string, ime?: Ime): Ev => ({ k: "up", code, ime });
/** [S-1] 3 つ・4 つ重ね（全順列 × 離す順の全部） */
function overlapSeqs(): [string, Ev[]][] {
  const out: [string, Ev[]][] = [];
  for (const k of [3, 4])
    for (const order of permutations(MODS4, k))
      for (const rel of permutations(order, order.length)) out.push([`k${k}`, [...order.map((c) => d(c)), ...rel.map((c) => u(c))]]);
  return out;
}
/** [S-1] 同じ規則で止まる 2 つの修飾キーの形（B を押したまま A をトン。B の候補はもう消えている） */
function sameRuleSeqs(): [string, Ev[]][] {
  const out: [string, Ev[]][] = [];
  for (const A of MODS4)
    for (const B of MODS4) {
      if (A === B) continue;
      out.push(["held", [d(B), d(A), u(A), u(B)]]); // Windows の Win を押したまま（Win は候補を立てない）
      out.push(["retap", [d(B), d(A), u(A), d(A), u(A), u(B)]]); // 2 回目のトン
      out.push(["afterRepeat", [d(B), d(B, true), d(A), u(A), u(B)]]); // B の押しっぱなしのくり返しのあと
      out.push(["afterCombo", [d(B), d("KeyQ"), u("KeyQ"), d(A), u(A), u(B)]]); // B＋文字のあと
      out.push(["afterClick", [d(B), { k: "ptr" }, d(A), u(A), u(B)]]); // B＋クリックのあと
      out.push(["afterBlur", [d(B), { k: "blur" }, d(A), u(A), u(B)]]); // フォーカスが外れて戻ったあと
      out.push(["afterPen", [{ k: "pen", on: true }, d(B), { k: "pen", on: false }, d(A), u(A), u(B)]]); // 描いている間に押した B
    }
  return out;
}
interface Fam {
  fam: string;
  desc: string;
  s: Ev[];
  /** Windows で、この回の規則で**発動しなくなってよい**形（Win を先に押して Ctrl / Shift / Alt をトン） */
  winHeld?: boolean;
}
const COMBO_KEYS = [
  "KeyZ",
  "KeyY",
  "KeyC",
  "KeyX",
  "KeyV",
  "KeyS",
  "KeyH",
  "KeyP",
  "KeyQ",
  "KeyN",
  "Comma",
  "Enter",
  "NumpadEnter",
  "Escape",
  "Delete",
  "Backspace",
  "F5",
  "Digit1",
  "BracketLeft",
];
/** [S-2] 旧版とビット一致であるべき形（単体・2 つ重ね・修飾キー＋文字・修飾キー＋クリック・Win・keyup が来ない・IME） */
function families(): Fam[] {
  const out: Fam[] = [];
  for (const c of ALL_MOD_CODES) {
    for (const h of [0, 100, 250, 251]) out.push({ fam: "single", desc: `${short(c)} ${h}ms`, s: [d(c), { k: "wait", ms: h }, u(c)] });
    out.push({ fam: "single", desc: `${short(c)} rep`, s: [d(c), d(c, true), u(c)] });
    out.push({ fam: "single", desc: `${short(c)} rep-long`, s: [d(c), d(c, true), { k: "wait", ms: 300 }, u(c)] });
    out.push({ fam: "single", desc: `${short(c)} blur`, s: [d(c), { k: "blur" }, u(c)] });
    out.push({ fam: "single", desc: `${short(c)} click`, s: [d(c), { k: "ptr" }, u(c)] });
    out.push({ fam: "single", desc: `${short(c)} pen`, s: [{ k: "pen", on: true }, d(c), { k: "pen", on: false }, u(c)] });
    out.push({ fam: "single", desc: `${short(c)} twice`, s: [d(c), u(c), d(c), u(c)] });
  }
  for (const a of ALL_MOD_CODES)
    for (const b of ALL_MOD_CODES) {
      if (a === b) continue;
      const winHeld = META_CODES.includes(a) && TAP_CODES.includes(b);
      out.push({ fam: "pair", desc: `${short(a)}${short(b)} a↑b↑`, s: [d(a), d(b), u(a), u(b)] });
      out.push({ fam: "pair", desc: `${short(a)}${short(b)} b↑a↑`, s: [d(a), d(b), u(b), u(a)], winHeld });
      out.push({ fam: "pair", desc: `${short(a)}${short(b)} wait b↑a↑`, s: [d(a), d(b), { k: "wait", ms: 100 }, u(b), u(a)], winHeld });
    }
  const modsDown = (m: Mods) => MODS4.filter((c) => m[KEYINFO[c].flag!]);
  for (const m of MOD16)
    for (const key of COMBO_KEYS)
      for (const rep of [false, true]) {
        const md = modsDown(m);
        out.push({
          fam: "combo",
          desc: `${tag(m)} ${key}${rep ? " rep" : ""}`,
          s: [...md.map((c) => d(c)), d(key), ...(rep ? [d(key, true)] : []), u(key), ...[...md].reverse().map((c) => u(c))],
        });
      }
  for (const m of MOD16)
    for (const button of [0, 1, 2]) {
      const md = modsDown(m);
      out.push({ fam: "click", desc: `${tag(m)} B${button}`, s: [...md.map((c) => d(c)), { k: "ptr", button }, ...[...md].reverse().map((c) => u(c))] });
    }
  // フォーカスの外で離した（keyup が来ない）あとのトン: フラグが落ちているので、どちらの版でもタップになる
  for (const a of ALL_MOD_CODES)
    for (const b of TAP_CODES) {
      if (a === b) continue;
      out.push({ fam: "lost", desc: `${short(a)}${short(b)}`, s: [d(a), { k: "blur" }, { k: "lost", code: a }, d(b), u(b)] });
    }
  // ★Codex 1 回目の Z04: IME の変換中の打鍵（単体のタップ・修飾キー＋文字）。ホーム画面・editor の門番が止める形も旧版と同じ
  for (const ime of ["composing", "229", "both"] as const) {
    for (const c of MODS4) out.push({ fam: "ime", desc: `${ime} tap ${short(c)}`, s: [d(c, false, ime), u(c, ime)] });
    for (const m of MOD16)
      for (const key of ["Comma", "KeyZ", "KeyS"]) {
        const md = modsDown(m);
        out.push({
          fam: "ime",
          desc: `${ime} ${tag(m)} ${key}`,
          s: [...md.map((c) => d(c, false, ime)), d(key, false, ime), u(key, ime), ...[...md].reverse().map((c) => u(c, ime))],
        });
      }
  }
  return out;
}

// ================= 構文木の小道具 =================
function classMethod(sf: ts.SourceFile, cls: string, name: string): ts.MethodDeclaration | undefined {
  let found: ts.MethodDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name?.text === cls)
      for (const m of n.members) if (ts.isMethodDeclaration(m) && m.name.getText(sf) === name) found = m;
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}
interface ListenerCall {
  recv: string;
  method: "add" | "remove";
  type: string;
  fn: ts.Expression;
  opts?: ts.Expression;
  /** ★Codex 1 回目の Z13: 付ける口を囲む条件（scope から呼び出しまでの if / 三項 / && など）。「条件つきでしか付けない」書き換えを見る */
  cond: string;
}
/** 文 st の中で、囲む関数から抜ける道（return / throw・st の外のループへ出る break / continue）を、そこへ至る条件つきで並べる。
 *  入れ子の関数・クラスの中は見ない（そこでの return は囲む関数から抜けない） */
/** `import.meta.env.DEV && …`（&& の左端が DEV・一番外が || や ?? ではない）＝本番では必ず偽。字面ではなく構文で見る（第三者レビューの T10:
 *  `DEV && x || y` は字面が DEV で始まるのに、本番でも y で真になる） */
function isDevGated(e: ts.Expression): boolean {
  let x: ts.Expression = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return isDevGated(x.left);
  return norm(x.getText()) === "import.meta.env.DEV";
}
interface ExitPath {
  text: string;
  /** 途中のどこかが「DEV のときだけ入る if の中」＝本番では通らない */
  dev: boolean;
}
function exitPaths(st: ts.Node, sf: ts.SourceFile): ExitPath[] {
  const out: ExitPath[] = [];
  const c = (e: ts.Node) => norm(e.getText(sf));
  type Cond = { text: string; dev: boolean };
  const push = (conds: Cond[], kind: string) =>
    out.push({ text: `${conds.map((x) => x.text).join(" ／ ")}${conds.length ? " → " : ""}${kind}`, dev: conds.some((x) => x.dev) });
  // labels: st の中で宣言されたラベル（そこへの break / continue は st の中か直後へ戻るだけ＝st より後ろの口は飛ばさない）
  const walk = (n: ts.Node, conds: Cond[], inLoop: boolean, caught: boolean, labels: ReadonlySet<string> = new Set()) => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return; // 宣言しただけの関数・クラスの中は走らない（前の文そのものが関数の宣言でも）
    if (ts.isReturnStatement(n)) return void push(conds, "return");
    if (ts.isThrowStatement(n)) {
      if (!caught) push(conds, "throw"); // ★第三者レビューの T15: catch のある try の中の throw は捕まる＝抜けない
      return;
    }
    if (ts.isLabeledStatement(n)) return void walk(n.statement, conds, inLoop, caught, new Set([...labels, n.label.text]));
    // ★第三者レビューの T01: ラベル付きの break / continue も抜ける道。ただし st の中で宣言したラベルへのものは除く（st の後ろは飛ばさない）
    if ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && (n.label ? !labels.has(n.label.text) : !inLoop)) {
      return void push(conds, `${ts.isBreakStatement(n) ? "break" : "continue"}${n.label ? ` ${n.label.text}` : ""}`);
    }
    if (ts.isIfStatement(n)) {
      walk(n.thenStatement, [...conds, { text: `if ${c(n.expression)}`, dev: isDevGated(n.expression) }], inLoop, caught, labels);
      if (n.elseStatement) walk(n.elseStatement, [...conds, { text: `else ${c(n.expression)}`, dev: false }], inLoop, caught, labels);
      return;
    }
    if (ts.isTryStatement(n)) {
      walk(n.tryBlock, conds, inLoop, caught || !!n.catchClause, labels);
      if (n.catchClause) walk(n.catchClause.block, [...conds, { text: "catch", dev: false }], inLoop, caught, labels);
      if (n.finallyBlock) walk(n.finallyBlock, conds, inLoop, caught, labels);
      return;
    }
    if (ts.isIterationStatement(n, false) || ts.isSwitchStatement(n)) {
      n.forEachChild((x) => walk(x, [...conds, { text: ts.isSwitchStatement(n) ? `switch ${c(n.expression)}` : "loop", dev: false }], true, caught, labels));
      return;
    }
    n.forEachChild((x) => walk(x, conds, inLoop, caught, labels));
  };
  walk(st, [], false, false);
  return out;
}
/** ★Codex 2 回目の前に塞いだ形: 付ける口より前の文に「抜ける道」があると、条件の表には出ないまま付かない道ができる。
 *  抜ける道を並べ、**全部が DEV の診断ページ（`import.meta.env.DEV && …`）なら 1 語にまとめる**（本番では付ける前に抜けない、が表に残る） */
function exitsBefore(n: ts.Node, scope: ts.Node, sf: ts.SourceFile): string {
  const paths: ExitPath[] = [];
  let child: ts.Node = n;
  for (let p = n.parent; p; child = p, p = p.parent) {
    const list = ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) ? p.statements : undefined;
    if (list) {
      const at = list.indexOf(child as ts.Statement);
      for (let i = 0; i < at; i++) paths.push(...exitPaths(list[i], sf));
    }
    if (p === scope) break;
  }
  if (!paths.length) return "";
  if (paths.every((x) => x.dev)) return `先に抜ける道: DEV の診断ページ ×${paths.length}`;
  return `先に抜ける道: ${paths.map((x) => x.text).join(" ／ ")}`;
}
/** scope から n までの間で、n を実行するかどうかを決める条件（外側から順に）と、付ける前に抜ける道 */
function guardsOf(n: ts.Node, scope: ts.Node, sf: ts.SourceFile): string {
  const out: string[] = [];
  let child: ts.Node = n;
  for (let p = n.parent; p && child !== scope; child = p, p = p.parent) {
    const c = (e: ts.Node) => norm(e.getText(sf));
    if (ts.isIfStatement(p) && child !== p.expression) out.unshift(`${child === p.elseStatement ? "else" : "if"} ${c(p.expression)}`);
    else if (ts.isConditionalExpression(p) && child !== p.condition) out.unshift(`${child === p.whenFalse ? "?:else" : "?:"} ${c(p.condition)}`);
    else if (
      ts.isBinaryExpression(p) &&
      child === p.right &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)
    )
      out.unshift(`${p.operatorToken.getText(sf)} ${c(p.left)}`);
    else if (ts.isCaseClause(p)) out.unshift(`case ${c(p.expression)}`);
    else if (ts.isDefaultClause(p)) out.unshift("default");
    else if (ts.isSwitchStatement(p)) out.unshift(`switch ${c(p.expression)}`);
    else if (ts.isIterationStatement(p, false)) out.unshift("loop");
    else if (ts.isCatchClause(p)) out.unshift("catch");
    else if (p !== scope && ts.isFunctionLike(p)) {
      // ★Codex 2 回目の W02: 関数の中で付ける口は、その関数が呼ばれたときだけ付く。どの関数か（名前・何の引数か）を残す
      //  （第三者レビューの T02: オブジェクトのメソッド・アクセサの中へ移す形も）
      const q = p.parent;
      const named = (p as ts.FunctionLikeDeclaration).name;
      const who = (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isAccessor(p)) && named
        ? named.getText(sf)
        : ts.isVariableDeclaration(q) && ts.isIdentifier(q.name)
          ? q.name.text
          : (ts.isCallExpression(q) || ts.isNewExpression(q)) && q.arguments?.includes(p as ts.Expression)
            ? `${ts.isNewExpression(q) ? "new " : ""}${c(q.expression)} の引数`
            : ts.SyntaxKind[q.kind];
      out.unshift(`fn ${who}`);
    }
    if (p === scope) break;
  }
  const ex = exitsBefore(n, scope, sf);
  if (ex) out.push(ex);
  return out.length ? ` [${out.join(" ／ ")}]` : "";
}
function listenerCalls(scope: ts.Node, sf: ts.SourceFile, recv?: (r: string) => boolean): ListenerCall[] {
  const out: ListenerCall[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === "addEventListener" || n.expression.name.text === "removeEventListener")
    ) {
      const r = n.expression.expression.getText(sf);
      if (!recv || recv(r)) {
        const [a0, a1, a2] = n.arguments;
        out.push({
          recv: r,
          method: n.expression.name.text === "addEventListener" ? "add" : "remove",
          type: a0 && ts.isStringLiteralLike(a0) ? a0.text : a0 ? `?${a0.getText(sf)}` : "?",
          fn: a1,
          opts: a2,
          cond: guardsOf(n, scope, sf),
        });
      }
    }
    n.forEachChild(visit);
  };
  visit(scope);
  return out;
}
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
function fnKind(fn: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!fn) return "∅";
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) return "arrow";
  return norm(fn.getText(sf));
}
/** 設定の引数（`true` / `{ passive: false }` など）を評価した形。無ければ "" */
function optsText(opts: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!opts) return "";
  const js = ts.transpileModule(`(${opts.getText(sf)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return JSON.stringify(new Function(`"use strict"; return ${js.trim().replace(/;$/, "")};`)());
}
const JS_GLOBALS = new Set([
  "Math",
  "Number",
  "String",
  "Boolean",
  "Object",
  "Array",
  "JSON",
  "undefined",
  "NaN",
  "Infinity",
  "console",
  "Date",
  "Map",
  "Set",
  "Error",
]);
/** 関数の中で使っていて中で宣言していない名前（＝囲む関数の変数か import）。型の位置は数えない */
function freeIdentifiers(fn: ts.Node): string[] {
  const declared = new Set<string>();
  const collect = (n: ts.Node) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name))
      declared.add(n.name.text);
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) declared.add(n.name.text);
    n.forEachChild(collect);
  };
  collect(fn);
  const used = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isTypeNode(n)) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isMethodDeclaration(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.propertyName === n) ||
        (ts.isParameter(p) && p.name === n) ||
        (ts.isVariableDeclaration(p) && p.name === n);
      if (!isName && !declared.has(n.text) && !JS_GLOBALS.has(n.text)) used.add(n.text);
    }
    n.forEachChild(visit);
  };
  visit(fn);
  return [...used].sort();
}
/** 取り出した関数を、囲む関数の変数を差し替えて作る（`this` は self に束ねる）。代入された変数は vars() で読める */
function compileFn(
  fnText: string,
  free: string[],
  env: Record<string, unknown>,
  self: unknown
): { fn: (e: Mod) => void; vars: () => Record<string, unknown> } {
  for (const n of free) if (!(n in env)) throw new Error(`自由変数 ${n} の差し替えが無い`);
  const js = ts
    .transpileModule(`(${fnText})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } })
    .outputText.trim()
    .replace(/;$/, "");
  const decl = free.length ? `let ${free.map((n) => `${n} = __env[${JSON.stringify(n)}]`).join(", ")};` : "";
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(
    "__env",
    "__self",
    `"use strict";\n${decl}\nconst __fn = (function () { return (${js}); }).call(__self);\nreturn { fn: __fn, vars: () => ({ ${free.join(", ")} }) };`
  )(env, self);
}

// ================= [S-3] の材料: 取り出す受け口 =================
interface Extracted {
  rows: string[];
  fnText: string;
  free: string[];
  /** 波形だけ: 同じ入れ物にある `localX`（画面の座標 → 波形の x）。★Codex 1 回目の Z10（枠の左端を引き忘れる）を見るため、差し替えずに本物を使う */
  localX?: { fnText: string; free: string[] };
}
/** 文字の入力欄（buildToolOptions の中の `const ta = $("#ed-textinput")`）の受け口の表と、キーの受け口 */
function textareaListeners(src: string): Extracted {
  const sf = ts.createSourceFile("editor.ts", src, ts.ScriptTarget.Latest, true);
  const m = classMethod(sf, "Editor", "buildToolOptions");
  if (!m) throw new Error("Editor.buildToolOptions が無い");
  let block: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "ta" &&
      n.initializer &&
      n.initializer.getText(sf).includes('"#ed-textinput"')
    ) {
      let p: ts.Node = n;
      while (p.parent && !ts.isBlock(p.parent)) p = p.parent;
      block = p.parent;
    }
    n.forEachChild(visit);
  };
  visit(m);
  if (!block) throw new Error("#ed-textinput の入れ物が無い");
  const calls = listenerCalls(block, sf, (r) => r === "ta");
  // ★Codex 2 回目の W01: ブロックごと条件の中へ入れる形（`if (!this.textDraft) { const ta = … }`）は、ブロックの中からは見えない。
  //  ブロックそのものを囲む条件（buildToolOptions から）も表の 1 行にする
  const blockRow = `ta ブロック${guardsOf(block, m, sf)}`;
  // ★Codex 1 回目の中1（Z13）: 関数だけを取り出して呼ぶと、**実際に付くか**（条件つき・途中の return）が見えない。
  //  登録を含むブロックごと返し、偽の入力欄に付いた受け口へ打鍵を送る（textareaBattery）
  return {
    rows: [blockRow, ...calls.map((c) => `ta.${c.method}(${c.type}, ${fnKind(c.fn, sf)}${c.opts ? `, ${optsText(c.opts, sf)}` : ""})${c.cond}`)],
    fnText: (block as ts.Block).getText(sf),
    free: freeIdentifiers(block),
  };
}
/** 波形（openAudioPanel の中の cv）の受け口の表と、ホイールの受け口 */
function waveListeners(src: string): Extracted {
  const sf = ts.createSourceFile("editor.ts", src, ts.ScriptTarget.Latest, true);
  const m = classMethod(sf, "Editor", "openAudioPanel");
  if (!m) throw new Error("Editor.openAudioPanel が無い");
  const calls = listenerCalls(m, sf, (r) => r === "cv");
  const wheel = calls.filter((c) => c.fn && /setZoom\(/.test(c.fn.getText(sf)));
  if (wheel.length !== 1) throw new Error(`波形の拡大の受け口が ${wheel.length} 個（1 個のはず）`);
  // ホイールの受け口から外へたどり、最初に `const localX = …` を直に持つ入れ物の localX（受け口が呼ぶのと同じもの）
  let localX: ts.Expression | undefined;
  let localXKind = "";
  for (let p: ts.Node | undefined = wheel[0].fn.parent; p && !localX; p = p.parent)
    if (ts.isBlock(p))
      for (const st of p.statements)
        if (ts.isVariableStatement(st))
          for (const dcl of st.declarationList.declarations)
            if (ts.isIdentifier(dcl.name) && dcl.name.text === "localX" && dcl.initializer) {
              localX = dcl.initializer;
              const f = st.declarationList.flags;
              localXKind = f & ts.NodeFlags.Const ? "const" : f & ts.NodeFlags.Let ? "let" : "var";
            }
  if (!localX) throw new Error("波形の localX が無い");
  // 受け口を付ける関数（`fn …` の注記の名前）が、openAudioPanel の中で呼ばれている所と、その所を囲む条件（呼ばれなければ 1 つも付かない）。
  //  ★第三者レビューの T03: 回数だけでなく条件も（音があるときだけ呼ぶ、など）。呼ぶ所がまた別の関数の中なら、その関数もたどる
  const fnNames = (cond: string) => [...cond.matchAll(/(?:\[| ／ )fn ([A-Za-z_$][\w$]*)(?= ／|\])/g)].map((x) => x[1]); // 名前のある関数だけ（「…の引数」はたどらない）
  const seen = new Set<string>();
  const queue = [...new Set(calls.flatMap((c) => fnNames(c.cond)))];
  const calledRows: string[] = [];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const where: string[] = [];
    const v = (x: ts.Node) => {
      if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === name) where.push(guardsOf(x, m, sf) || " [条件なし]");
      x.forEachChild(v);
    };
    v(m);
    for (const w of where) queue.push(...fnNames(w));
    calledRows.push(`${name}() の呼び出し ×${where.length}${where.join("")}`);
  }
  calledRows.sort();
  return {
    rows: [
      `localX = ${localXKind}（受け口が呼ぶ座標の変換・あとから差し替えられない）`,
      ...calledRows,
      ...calls.map((c) => `cv.${c.method}(${c.type}, ${fnKind(c.fn, sf)}${c.opts ? `, ${optsText(c.opts, sf)}` : ""})${c.cond}`),
    ],
    fnText: wheel[0].fn.getText(sf),
    free: freeIdentifiers(wheel[0].fn),
    localX: { fnText: localX.getText(sf), free: freeIdentifiers(localX) },
  };
}
const TA_CODES = ["Escape", "Enter", "NumpadEnter", "KeyA", "KeyZ", "Backspace", "Delete"]; // Backspace / Delete は文字を消すだけ（第三者レビューの T07）
const IMES = ["-", "composing", "229", "both"] as const;
/** 受け口を記録する偽の要素（addEventListener で付いたものだけが dispatch で呼ばれる） */
class FakeTarget {
  ls: { type: string; fn: (e: Mod) => void; opt?: unknown }[] = [];
  value = "";
  addEventListener(type: string, fn: (e: Mod) => void, opt?: unknown) {
    this.ls.push({ type, fn, opt });
  }
  removeEventListener(type: string, fn: (e: Mod) => void) {
    this.ls = this.ls.filter((l) => !(l.type === type && l.fn === fn));
  }
  dispatch(type: string, e: Mod) {
    for (const l of [...this.ls]) if (l.type === type) l.fn(e);
  }
  focus() {}
}
/** 文字の入力欄のブロックを本物のまま組み立てる（打ちかけの文字あり／なし）。付いた受け口の種類と、keydown を送る口を返す */
function buildTextarea(T: Tree, X: Extracted, withDraft: boolean, focusElsewhere = false) {
  const scope = importScope(T.edSrc, T);
  const calls: string[] = [];
  const ta = new FakeTarget();
  const others = new Map<string, FakeTarget>();
  const $ = (q: string) => (q === "#ed-textinput" ? ta : (others.get(q) ?? others.set(q, new FakeTarget()).get(q)!));
  // フォーカスの行き場が無い状態（activeElement ＝ body）で組み立てる＝打ちかけの間は入力欄へ戻すはず。
  //  ★第三者レビューの T12: ほかの所にフォーカスがあるとき（focusElsewhere）は奪わない
  const body = {};
  const env: Record<string, unknown> = { $, drafting: withDraft, document: { activeElement: focusElsewhere ? { tagName: "SELECT" } : body, body } };
  for (const n of X.free) if (!(n in env) && n in scope) env[n] = scope[n];
  const self = {
    textDraft: withDraft ? { text: "x" } : null,
    redrawOverlay: () => void calls.push("redraw"),
    focusTextInput: () => void calls.push("focus"),
    cancelTextDraft: () => void calls.push("cancel"),
    commitTextDraft: () => void calls.push("commit"),
  };
  // ブロック（{ … }）を関数の本文として動かす（compileFn と同じく、囲む関数の変数は env から・this は self）
  compileFn(`() => ${X.fnText}`, X.free, env, self).fn({});
  const built = calls.splice(0).join("+") || "-";
  return { calls, ta, self, others, built, types: ta.ls.map((l) => l.type).sort().join(",") };
}
function textareaBattery(T: Tree, X: Extracted): string[] {
  const out: string[] = [];
  for (const withDraft of [false, true]) {
    const B = buildTextarea(T, X, withDraft);
    out.push(`draft=${withDraft} 付いた受け口 ${B.types || "無し"}`);
    // 同じブロックのほかの口: 組み立てたときの動き（打ちかけの間は入力欄へフォーカスを戻す）・打った文字が打ちかけへ入る・✓ / ✕
    out.push(`draft=${withDraft} 組み立て => ${B.built}・入力欄の初期値「${B.ta.value}」`);
    B.ta.value = " あい "; // 前後の空白もそのまま（第三者レビューの T08＝trim する書き換え）
    B.ta.dispatch("input", { type: "input", target: B.ta });
    out.push(`draft=${withDraft} 入力 => ${B.calls.splice(0).join("+") || "-"}・打ちかけ「${B.self.textDraft ? B.self.textDraft.text : "∅"}」`);
    for (const id of ["#ed-text-ok", "#ed-text-cancel"]) {
      B.others.get(id)?.dispatch("click", { type: "click" });
      out.push(`draft=${withDraft} ${id} click => ${B.calls.splice(0).join("+") || "-"}`);
    }
    out.push(`draft=${withDraft} ほかの所にフォーカス 組み立て => ${buildTextarea(T, X, withDraft, true).built}`);
    for (const code of TA_CODES)
      for (const m of MOD16)
        for (const ime of IMES) {
          B.calls.length = 0;
          const e = kev(KEYINFO[code].key, code, m, IME_FIELDS[ime === "-" ? "" : ime]);
          e.target = B.ta;
          B.ta.dispatch("keydown", e);
          out.push(`draft=${withDraft} ${code} ${tag(m)} ime=${ime} => ${B.calls.join("+") || "-"} ${e.defaultPrevented ? "P" : "-"}${e.stopped ? "S" : "-"}`);
        }
  }
  return out;
}
/** 入力欄の受け口の期待（要件どおり・独立に書く）: Esc は取消・Ctrl+Enter（Mac は ⌘ も）で確定・どちらも止めて伝えない */
function textareaExpect(mac: boolean): string[] {
  const out: string[] = [];
  for (const withDraft of [false, true]) {
    out.push(`draft=${withDraft} 付いた受け口 input,keydown`);
    out.push(`draft=${withDraft} 組み立て => ${withDraft ? "focus" : "-"}・入力欄の初期値「${withDraft ? "x" : ""}」`);
    out.push(`draft=${withDraft} 入力 => ${withDraft ? "redraw" : "-"}・打ちかけ「${withDraft ? " あい " : "∅"}」`);
    out.push(`draft=${withDraft} #ed-text-ok click => commit`);
    out.push(`draft=${withDraft} #ed-text-cancel click => cancel`);
    out.push(`draft=${withDraft} ほかの所にフォーカス 組み立て => -`);
    for (const code of TA_CODES)
      for (const m of MOD16)
        for (const ime of IMES) {
          let r = "- --";
          if (ime === "-") {
            if (code === "Escape") r = "cancel PS";
            else if ((code === "Enter" || code === "NumpadEnter") && (m.ctrl || (mac && m.meta))) r = "commit PS";
          }
          out.push(`draft=${withDraft} ${code} ${tag(m)} ime=${ime} => ${r}`);
        }
  }
  return out;
}
const WHEEL_CX = [250, 650];
const WHEEL_DELTAS: [number, number][] = [
  [-100, 0],
  [100, 0],
  [100, -40], // 斜め（縦が主）: 移動の向きは縦で決める（第三者レビューの T13）
  [-100, 40],
  [-3, 0],
  [0, 40],
  [0, -40],
  [0, 0],
];
function wheelBattery(T: Tree, X: Extracted): string[] {
  const scope = importScope(T.edSrc, T);
  const out: string[] = [];
  for (const m of MOD16)
    for (const [dy, dx] of WHEEL_DELTAS)
      for (const buf of [true, false])
        for (const cx of WHEEL_CX) {
        const calls: string[] = [];
        // 波形の canvas: 画面では左端 50px・幅 800px に 400px の絵を引き伸ばして出している（clientX 250 → 波形の x 100 → 1/4 の位置・650 → 300 → 3/4）
        const cv = { width: 400, getBoundingClientRect: () => ({ left: 50, top: 0, width: 800, height: 120 }) };
        const lx = compileFn(X.localX!.fnText, X.localX!.free, { cv }, undefined).fn;
        const env: Record<string, unknown> = {
          buffer: buf ? { duration: 10 } : null,
          view: () => ({ v0: 2, vd: 4 }),
          localX: lx,
          cv,
          setZoom: (z: number, a: number, f: number) => void calls.push(`zoom ${z.toFixed(2)} ${a.toFixed(2)} ${f.toFixed(3)}`),
          zoomT: 0.5,
          viewStart: 0,
          syncZoomUI: () => void calls.push("sync"),
          drawWave: () => void calls.push("draw"),
        };
        for (const n of X.free) if (!(n in env) && n in scope) env[n] = scope[n];
        const L = compileFn(X.fnText, X.free, env, undefined);
        const e: Mod = realLike(
          { type: "wheel", deltaY: dy, deltaX: dx, clientX: cx, clientY: 60, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta },
          {}
        );
        L.fn(e);
        const vs = L.vars().viewStart;
        out.push(
          `${tag(m)} x=${cx} dy=${dy} dx=${dx} buf=${buf} => ${calls.join("+") || "-"} vs=${typeof vs === "number" ? vs.toFixed(3) : String(vs)} ${
            e.defaultPrevented ? "P" : "-"
          }`
        );
        }
  return out;
}
/** 波形の受け口の期待（独立に書く）: 音が無ければ何もしない／Ctrl（Mac は ⌘ も）＋ホイールは拡大縮小（上へ回すと拡大）／
 *  素のホイールは移動（窓の 1 割）。どれも既定の動きを止める */
function wheelExpect(mac: boolean): string[] {
  const out: string[] = [];
  const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  for (const m of MOD16)
    for (const [dy, dx] of WHEEL_DELTAS)
      for (const buf of [true, false])
        for (const cx of WHEEL_CX) {
          const frac = (cx - 50) / 800; // 枠の左端 50・表示の幅 800 → 絵の上の割合（1/4・3/4）
          let r: string;
          if (!buf) r = "- vs=0.000 -";
          else if (m.ctrl || (mac && m.meta)) {
            const z = 0.5 - sign(dy) * 0.08; // 上へ回す（deltaY < 0）＝拡大（zoomT が増える）
            r = `zoom ${z.toFixed(2)} ${(2 + frac * 4).toFixed(2)} ${frac.toFixed(3)} vs=0.000 P`; // 基準＝表示窓の始まり 2 ＋ 割合 × 長さ 4
          } else r = `sync+draw vs=${(2 + sign(dy || dx) * 4 * 0.1).toFixed(3)} P`;
          out.push(`${tag(m)} x=${cx} dy=${dy} dx=${dx} buf=${buf} => ${r}`);
        }
  return out;
}
/** 受け口の表。★Codex 1 回目の Z13（`if (!this.textDraft) ta.addEventListener(...)`＝打ちかけの間だけ付かない）を見るため、
 *  付ける口を囲む条件と、付ける前に抜ける道も表に入れる（入力欄の 2 つは無し・波形は `if (cv)` の中で、重い処理の最中と
 *  もう開いているときは openAudioPanel が先に抜ける＝どちらも以前からの正しい道） */
const TA_ROWS = [
  'ta ブロック [else this.tool === "fill" ／ else this.tool === "shape" ／ if this.tool === "text"]', // 文字の道具のときだけ組む（Codex 2 回目の W01）
  "ta.add(input, arrow)",
  "ta.add(keydown, arrow)",
];
const WAVE_ROWS = [
  "localX = const（受け口が呼ぶ座標の変換・あとから差し替えられない）", // Codex 2 回目の W06
  // 受け口は bind の中で付け、bind は render の中で呼び、render は開いたときに条件なしで呼ぶ（Codex 2 回目の W02・第三者レビューの T03＝
  //  呼ばれない関数の中へ移す／音があるときだけ呼ぶ、の形）
  "bind() の呼び出し ×1 [fn render ／ 先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return]",
  "render() の呼び出し ×3 [fn bind ／ fn box.querySelector(\"#ap-load\")?.addEventListener の引数 ／ if done ／ 先に抜ける道: if self.busyKind → return ／ if !sel → return ／ if this.busyKind → return ／ if this.audioPanelEl → return] [fn bind ／ fn box.querySelector(\"#ap-del\")?.addEventListener の引数 ／ 先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return] [先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return]",
  "cv.add(pointerdown, arrow) [fn bind ／ if cv ／ 先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return]",
  "cv.add(pointermove, arrow) [fn bind ／ if cv ／ 先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return]",
  "cv.add(pointerup, up) [fn bind ／ if cv ／ 先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return]",
  "cv.add(pointercancel, up) [fn bind ／ if cv ／ 先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return]",
  "cv.add(lostpointercapture, arrow) [fn bind ／ if cv ／ 先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return]",
  'cv.add(wheel, arrow, {"passive":false}) [fn bind ／ if cv ／ 先に抜ける道: if this.busyKind → return ／ if this.audioPanelEl → return]',
];

// ---- ④ 配線（window / document の addEventListener / removeEventListener） ----
const KEYISH = new Set(["keydown", "keyup", "blur", "pointerdown"]);
function wiringRows(T: Tree): string[] {
  const rows: string[] = [];
  const fmt = (where: string, c: ListenerCall, sf: ts.SourceFile) =>
    `${where} ${c.recv}.${c.method}(${c.type}, ${fnKind(c.fn, sf)}${c.opts ? `, ${norm(c.opts.getText(sf))}` : ""})${c.cond}`;
  const isWinDoc = (r: string) => r === "window" || r === "document";
  {
    const sf = ts.createSourceFile("editor.ts", T.edSrc, ts.ScriptTarget.Latest, true);
    for (const name of ["mount", "unmount"]) {
      const m = classMethod(sf, "Editor", name);
      if (!m) throw new Error(`Editor.${name} が無い`);
      for (const c of listenerCalls(m, sf, isWinDoc)) rows.push(fmt(`editor.${name}`, c, sf));
    }
  }
  {
    const sf = ts.createSourceFile("main.ts", T.mainSrc, ts.ScriptTarget.Latest, true);
    let cap: ts.Node | undefined;
    let boot: ts.Node | undefined;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === "captureKey") cap = st;
      if (
        ts.isExpressionStatement(st) &&
        ts.isCallExpression(st.expression) &&
        st.expression.expression.getText(sf) === "window.addEventListener" &&
        st.expression.arguments[0] &&
        ts.isStringLiteralLike(st.expression.arguments[0]) &&
        st.expression.arguments[0].text === "DOMContentLoaded"
      )
        boot = st.expression.arguments[1];
    }
    if (!cap || !boot) throw new Error("main.ts の captureKey か DOMContentLoaded が無い");
    for (const c of listenerCalls(cap, sf, isWinDoc)) rows.push(fmt("main.captureKey", c, sf));
    for (const c of listenerCalls(boot, sf, isWinDoc)) if (KEYISH.has(c.type)) rows.push(fmt("main.boot", c, sf));
  }
  // ★第三者レビューの T11: キーとタップの受け口（editor の keydown / keyup・候補の破棄・ホーム画面の口）を、上の 4 つの入れ物の**外**で
  //  付け外ししている所（例: 別のメニューを閉じるとき、自分の口ではなく editor の keydown を外す写し間違い）。いまは 0 行のはず
  for (const [file, src, covered] of [
    ["editor", T.edSrc, (sf: ts.SourceFile) => ["mount", "unmount"].map((n) => classMethod(sf, "Editor", n)!)],
    ["main", T.mainSrc, (sf: ts.SourceFile): ts.Node[] => [
      ...sf.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name?.text === "captureKey"),
      ...sf.statements
        .filter((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && (s.expression.arguments[0] as ts.StringLiteral | undefined)?.text === "DOMContentLoaded")
        .map((s) => ((s as ts.ExpressionStatement).expression as ts.CallExpression).arguments[1]),
    ]],
  ] as [string, string, (sf: ts.SourceFile) => ts.Node[]][]) {
    const sf = ts.createSourceFile(`${file}.ts`, src, ts.ScriptTarget.Latest, true);
    const skip = new Set(covered(sf));
    for (const c of listenerCalls(sf, sf)) {
      const h = c.fn ? norm(c.fn.getText(sf)) : "";
      if (!KEY_HANDLERS.has(h)) continue;
      let p: ts.Node | undefined = c.fn;
      let inCovered = false;
      for (; p; p = p.parent) if (skip.has(p)) inCovered = true;
      if (!inCovered) rows.push(`${file}.ほか ${c.recv}.${c.method}(${c.type}, ${h}${c.opts ? `, ${norm(c.opts.getText(sf))}` : ""})${c.cond}`);
    }
  }
  return rows.sort();
}
/** キーとタップの受け口（付け外しを表で見張る関数の名前） */
const KEY_HANDLERS = new Set([
  "this.keydownHandler",
  "this.keyupHandler",
  "this.keyLogHandler",
  "this.modTapPointerHandler",
  "this.blurHandler",
  "homeKeyHandler",
  "homeKeyUpHandler",
  "homeModTapCancel",
  "loneAltGuard",
  "reloadGuardHandler",
]);
/** いまの配線（2026-09-26・この回の前と同じ）。**変えたらこの表も直す**（黙らない）。[…] は付ける口を囲む条件（Codex 1 回目の Z13）と、
 *  付ける前に抜ける道（unmount は「mount していなければ抜ける」・起動時は DEV の診断ページ 6 つだけ＝本番では抜けない） */
const EXPECTED_WIRING = [
  "editor.mount document.add(visibilitychange, this.winLogHandler) [if this.inputLog]",
  "editor.mount window.add(blur, this.blurHandler)",
  "editor.mount window.add(blur, this.winLogHandler) [if this.inputLog]",
  "editor.mount window.add(focus, this.winLogHandler) [if this.inputLog]",
  "editor.mount window.add(keydown, this.keyLogHandler) [if this.inputLog]",
  "editor.mount window.add(keydown, this.keydownHandler)",
  "editor.mount window.add(keyup, this.keyLogHandler) [if this.inputLog]",
  "editor.mount window.add(keyup, this.keyupHandler)",
  "editor.mount window.add(pointerdown, this.modTapPointerHandler, true)",
  "editor.mount window.add(resize, this.resizeHandler)",
  "editor.unmount document.remove(visibilitychange, this.winLogHandler) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(blur, this.blurHandler) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(blur, this.winLogHandler) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(focus, this.winLogHandler) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(keydown, this.keyLogHandler) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(keydown, this.keydownHandler) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(keyup, this.keyLogHandler) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(keyup, this.keyupHandler) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(pointerdown, this.modTapPointerHandler, true) [先に抜ける道: if !this.mounted → return]",
  "editor.unmount window.remove(resize, this.resizeHandler) [先に抜ける道: if !this.mounted → return]",
  "main.boot window.add(blur, homeModTapCancel) [先に抜ける道: DEV の診断ページ ×6]",
  "main.boot window.add(keydown, homeKeyHandler) [先に抜ける道: DEV の診断ページ ×6]",
  "main.boot window.add(keydown, loneAltGuard, true) [先に抜ける道: DEV の診断ページ ×6]",
  "main.boot window.add(keydown, reloadGuardHandler, true) [先に抜ける道: DEV の診断ページ ×6]",
  "main.boot window.add(keyup, homeKeyUpHandler) [先に抜ける道: DEV の診断ページ ×6]",
  "main.boot window.add(keyup, loneAltGuard, true) [先に抜ける道: DEV の診断ページ ×6]",
  "main.boot window.add(pointerdown, homeModTapCancel, true) [先に抜ける道: DEV の診断ページ ×6]",
  "main.captureKey window.add(blur, onBlur) [fn new Promise の引数]",
  "main.captureKey window.add(keydown, onKey, true) [fn new Promise の引数]",
  "main.captureKey window.add(keyup, onKeyUp, true) [fn new Promise の引数]",
  "main.captureKey window.add(pointerdown, onPointer, true) [fn new Promise の引数]",
  "main.captureKey window.remove(blur, onBlur) [fn new Promise の引数 ／ fn finish]",
  "main.captureKey window.remove(keydown, onKey, true) [fn new Promise の引数 ／ fn finish]",
  "main.captureKey window.remove(keyup, onKeyUp, true) [fn new Promise の引数 ／ fn finish]",
  "main.captureKey window.remove(pointerdown, onPointer, true) [fn new Promise の引数 ／ fn finish]",
].sort();
function multisetDiff(got: string[], want: string[]): string {
  const g = [...got];
  const missing: string[] = [];
  for (const w of want) {
    const i = g.indexOf(w);
    if (i >= 0) g.splice(i, 1);
    else missing.push(w);
  }
  return [g.length ? `余分: ${g.join(" ／ ")}` : "", missing.length ? `足りない: ${missing.join(" ／ ")}` : ""].filter(Boolean).join(" ・ ");
}

// ================= [S-3] ② applyI18n の偽の DOM =================
function indexHtmlKeys(): { text: string[]; title: string[]; ph: string[] } {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const grab = (attr: string) => [...html.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))].map((m) => m[1]);
  return { text: grab("data-i18n"), title: grab("data-i18n-title"), ph: grab("data-i18n-placeholder") };
}
const MOD_WORD = /\b(Ctrl|Alt|Shift)\b/;
function runApplyI18n(T: Tree, keys: string[]): { attr: string; key: string; v: string }[] {
  const mk = (attr: "data-i18n" | "data-i18n-title" | "data-i18n-placeholder", key: string) => {
    const el: Mod = {
      dataset: attr === "data-i18n" ? { i18n: key } : {},
      textContent: "",
      title: "",
      placeholder: "",
      getAttribute: (n: string) => (n === attr ? key : null),
    };
    return el;
  };
  const els = {
    "[data-i18n]": keys.map((k) => mk("data-i18n", k)),
    "[data-i18n-title]": keys.map((k) => mk("data-i18n-title", k)),
    "[data-i18n-placeholder]": keys.map((k) => mk("data-i18n-placeholder", k)),
  };
  T.I.applyI18n({ querySelectorAll: (sel: string) => (els as Record<string, Mod[]>)[sel] ?? [] });
  return [
    ...els["[data-i18n]"].map((el, i) => ({ attr: "textContent", key: keys[i], v: String(el.textContent) })),
    ...els["[data-i18n-title]"].map((el, i) => ({ attr: "title", key: keys[i], v: String(el.title) })),
    ...els["[data-i18n-placeholder]"].map((el, i) => ({ attr: "placeholder", key: keys[i], v: String(el.placeholder) })),
  ];
}

// =====================================================================================
// [S-1] ★3 つ・4 つ重ね（と同じ規則の 2 つの修飾キーの形）でタップが返らない
// =====================================================================================
interface Ports {
  name: string;
  make: () => Port;
}
function allPorts(T: Tree, C: Capture, H: HomeFactory): Ports[] {
  return [
    { name: "watcher", make: () => watcherPort(T) },
    { name: "editor", make: () => editorPort(T, TAP_ALL) },
    ...HOME_TAPS.map((p) => ({ name: `home(${p.bindings["app.settings"].tap})`, make: () => homePort(T, H, p) })),
    { name: "capture", make: () => capturePort(C) },
  ];
}
async function groupS1(T: Tree): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  const C = compileCapture(T);
  const H = compileHome(T);
  const ports = allPorts(T, C, H);
  try {
    for (const mac of [false, true]) {
      const pf = mac ? "Mac" : "Windows";
      setMac(T, mac);
      for (const [label, seqs] of [
        ["3 つ・4 つ重ね（全順列 × 離す順）", overlapSeqs()],
        ["2 つの修飾キーで、先の候補が消えたあとのトン（押したまま・2 回目・くり返し・＋文字・＋クリック・フォーカス・描画のあと）", sameRuleSeqs()],
      ] as [string, [string, Ev[]][]][]) {
        await add(`[S-1] ★${pf}: ${label} ${seqs.length} 通り × ${ports.length} つの口で、どれもタップを返さない`, () => {
          const bad: string[] = [];
          for (const P of ports)
            for (const [kind, s] of seqs) {
              const o = runSeq(P.make(), s);
              if (tapHit(P.name.startsWith("home") ? "home" : P.name, o)) bad.push(`${P.name} ${kind} ${seqText(s)} → ${o}`);
            }
          return bad.length ? ng(`${bad.length} 件: ${bad.slice(0, 3).join(" ／ ")}`) : ok();
        });
      }
      // 空振りしていない: 同じ口で、単体のタップはちゃんと返る（口が死んでいて「返らない」のではない）
      await add(`[S-1] ${pf}: 対照＝同じ 4 つの口で、単体のタップ（Ctrl / Shift / Alt${mac ? " / ⌘" : ""}）は返る`, () => {
        const bad: string[] = [];
        const singles = [...MODS4.slice(0, 3), ...(mac ? ["MetaLeft"] : [])];
        for (const P of ports)
          for (const c of singles) {
            const o = runSeq(P.make(), [d(c), u(c)]);
            const want = !P.name.startsWith("home") || P.name === `home(${mac && c === "MetaLeft" ? "Control" : KEYINFO[c].key})`;
            if (tapHit(P.name.startsWith("home") ? "home" : P.name, o) !== want) bad.push(`${P.name} ${short(c)} → ${o}`);
          }
        return bad.length ? ng(bad.slice(0, 4).join(" ／ ")) : ok();
      });
    }
  } finally {
    setMac(T, null);
  }
  return r;
}

// =====================================================================================
// [S-2] ★旧版とビット一致（変わってよいのは Windows の Win を押したままのトンだけ）＋総当たり＋同じ関数
// =====================================================================================
/** 全部の口で families を流した行（言語に依らない） */
function familyLines(T: Tree, mac: boolean): { lines: string[]; meta: Fam[]; port: string[] } {
  setMac(T, mac);
  const C = compileCapture(T);
  const H = compileHome(T);
  const ports: Ports[] = [
    { name: "watcher", make: () => watcherPort(T) },
    { name: "editor", make: () => editorPort(T, TAP_ALL) },
    { name: "editor-std", make: () => editorPort(T, T.K.BUILTIN_PRESETS[0]) },
    ...HOME_TAPS.map((p) => ({ name: `home(${p.bindings["app.settings"].tap})`, make: () => homePort(T, H, p) })),
    { name: "home-std", make: () => homePort(T, H, T.K.BUILTIN_PRESETS[0]) },
    { name: "capture", make: () => capturePort(C) },
  ];
  const fams = families();
  const lines: string[] = [];
  const meta: Fam[] = [];
  const port: string[] = [];
  for (const P of ports)
    for (const f of fams) {
      lines.push(`${P.name} ${f.fam} ${f.desc} => ${runSeq(P.make(), f.s)}`);
      meta.push(f);
      port.push(P.name);
    }
  return { lines, meta, port };
}
// ★この回のあとの木で families を流した指紋（blob が無い所でも走る固定値）。V183_PRINT_FP=1 で出す。
//  ⚠ 組み込みのプリセットや取得の形を**わざと**変えた回は赤になる: [S-2r]（旧版の木との行ごとの比較）の差が意図どおりかを
//  先に確かめてから写し直す（指紋だけ写すと、この検査は何も見なくなる）
// Windows はこの回の前（1854b5c4cb083877）から「Win を押したままのトン」の 96 行（ModTapWatcher・editor・取得 24 行ずつ＋ホーム 8 行 × 3）だけ変わった（[S-2r] が中身を見る）。
// Mac はこの回の前と同じ値（[S-2r] が 1 行も違わないことを見る）。Codex 1 回目・2 回目の対応で IME の形（isComposing・keyCode 229・両方 × 52 通り）を
// 足して 946 → 1,102 通りにした
const FAMILY_FP: Record<string, string> = { win: "705275e3a7022d6e", mac: "685f8b6df2ab7583" };

/** ModTapWatcher の総当たり（新旧を同じ打鍵で並走・状態は写して戻す）。差は全部「ほかの修飾キーのフラグが立った keydown で
 *  旧版が候補を立てて発動した」ものか・発動しなくなる向きだけか・規則がどこでも効いているか */
function exhaustiveWatcher(TN: Tree, TO: Tree, mac: boolean, maxLen: number) {
  setMac(TN, mac);
  setMac(TO, mac);
  const clock = { t: 10_000 };
  const wn = new TN.K.ModTapWatcher(() => clock.t);
  const wo = new TO.K.ModTapWatcher(() => clock.t);
  const CODES = ["ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft", "KeyQ"];
  const held = new Set<string>();
  let pen = false;
  // 旧版の候補が「ほかの修飾キーのフラグが立った keydown」で立ったか・そのとき旧版の候補が空だった理由
  let oldOther = false;
  let oldWhy = "";
  let oldNullWhy = "start";
  const st = { nodes: 0, diffs: 0, bad: [] as string[], cats: new Map<string, { n: number; ex: string }>() };
  const trail: Ev[] = [];
  const otherFlag = (e: Mod) =>
    (e.key !== "Control" && e.ctrlKey) || (e.key !== "Shift" && e.shiftKey) || (e.key !== "Alt" && e.altKey) || (e.key !== "Meta" && e.metaKey);
  const rec = (depth: number) => {
    if (depth === maxLen) return;
    const evs: Ev[] = [];
    for (const c of CODES) if (!held.has(c)) evs.push(d(c));
    for (const c of held) evs.push(u(c));
    for (const c of held) if (KEYINFO[c].flag) evs.push(d(c, true));
    evs.push({ k: "ptr" }, { k: "blur" }, { k: "wait", ms: 300 }, { k: "pen", on: !pen });
    for (const ev of evs) {
      st.nodes++;
      const snap = { n: (wn as Mod).cand, o: (wo as Mod).cand, t: clock.t, pen, oldOther, oldWhy, oldNullWhy, held: new Set(held) };
      trail.push(ev);
      if (ev.k === "down") {
        held.add(ev.code);
        const e = kev(KEYINFO[ev.code].key, ev.code, flagsOf(held), { repeat: !!ev.rep });
        const before = (wo as Mod).cand;
        wn.down(e.key, { repeat: e.repeat, blocked: pen, mods: e });
        wo.down(e.key, { repeat: e.repeat, blocked: pen, mods: e });
        const after = (wo as Mod).cand;
        if (after && after !== before) {
          oldOther = otherFlag(e);
          oldWhy = oldNullWhy;
        } else if (!after)
          oldNullWhy = !KEYINFO[ev.code].flag
            ? "＋文字"
            : ev.rep
              ? "くり返し"
              : pen
                ? "描画中"
                : before
                  ? "2 つ目の修飾キー"
                  : !mac && KEYINFO[ev.code].key === "Meta"
                    ? "Win"
                    : oldNullWhy;
      } else if (ev.k === "up") {
        held.delete(ev.code);
        const e = kev(KEYINFO[ev.code].key, ev.code, flagsOf(held), { type: "keyup" });
        const rn = wn.up(e.key);
        const ro = wo.up(e.key);
        if (rn !== ro) {
          st.diffs++;
          if (ro !== null && rn === null && oldOther) {
            const mods = new Set(trail.filter((x) => x.k === "down" && KEYINFO[x.code].flag).map((x) => (x as { code: string }).code));
            const cat = mods.size >= 3 ? "3 つ以上の修飾キー" : `2 つ（${oldWhy}のあと）`;
            const c = st.cats.get(cat) ?? { n: 0, ex: seqText(trail) };
            c.n++;
            if (seqText(trail).length < c.ex.length) c.ex = seqText(trail);
            st.cats.set(cat, c);
          } else if (st.bad.length < 5) st.bad.push(`${seqText(trail)}: 新 ${rn}・旧 ${ro}（旧の候補はほかのフラグ${oldOther ? "あり" : "なし"}）`);
        } else if (ro !== null && oldOther && st.bad.length < 5)
          st.bad.push(`${seqText(trail)}: ほかの修飾キーを押したまま立った候補が新でも発動（${rn}）`);
        oldNullWhy = "一度離した";
      } else if (ev.k === "ptr" || ev.k === "blur") {
        wn.cancel();
        wo.cancel();
        oldNullWhy = ev.k === "ptr" ? "＋クリック" : "フォーカス";
      } else if (ev.k === "wait") clock.t += ev.ms;
      else if (ev.k === "pen") {
        pen = ev.on;
        if (ev.on) {
          wn.cancel();
          wo.cancel();
          oldNullWhy = "描画中";
        }
      }
      rec(depth + 1);
      trail.pop();
      (wn as Mod).cand = snap.n;
      (wo as Mod).cand = snap.o;
      clock.t = snap.t;
      pen = snap.pen;
      oldOther = snap.oldOther;
      oldWhy = snap.oldWhy;
      oldNullWhy = snap.oldNullWhy;
      held.clear();
      for (const c of snap.held) held.add(c);
    }
  };
  rec(0);
  return st;
}
/** 取得（captureKey）と実行側（ModTapWatcher）の判定が、総当たりの全部の並びで一致するか（同じ木・同じ打鍵） */
function exhaustiveCaptureVsWatcher(T: Tree, mac: boolean, maxLen: number) {
  setMac(T, mac);
  const C = compileCapture(T);
  const CODES = ["ControlLeft", "ShiftLeft", "AltLeft", "MetaLeft", "KeyQ"];
  const st = { seqs: 0, taps: 0, bad: [] as string[] };
  const cur: Ev[] = [];
  const held = new Set<string>();
  const one = () => {
    st.seqs++;
    // 取得: 打鍵ごとに「終わったか・何を取ったか」
    const cap = C.captureKey();
    const clock = { t: 10_000 };
    const w = new T.K.ModTapWatcher(() => clock.t);
    C.clock.t = 10_000;
    const h = new Set<string>();
    let wTap: string | null = null;
    for (let i = 0; i < cur.length; i++) {
      const ev = cur[i];
      let e: Mod | undefined;
      if (ev.k === "down") {
        h.add(ev.code);
        e = kev(KEYINFO[ev.code].key, ev.code, flagsOf(h), { repeat: !!ev.rep });
        C.win.fire("keydown", e);
        w.down(e.key, { repeat: e.repeat, blocked: false, mods: e });
      } else if (ev.k === "up") {
        h.delete(ev.code);
        e = kev(KEYINFO[ev.code].key, ev.code, flagsOf(h), { type: "keyup" });
        C.win.fire("keyup", e);
        const r = w.up(e.key);
        if (r && !wTap) wTap = `${i}:${r}`;
      } else if (ev.k === "ptr") {
        e = pev(0, flagsOf(h));
        C.win.fire("pointerdown", e);
        w.cancel();
      } else if (ev.k === "blur") {
        C.win.fire("blur", {});
        w.cancel();
      } else if (ev.k === "wait") {
        C.clock.t += ev.ms;
        clock.t += ev.ms;
      }
      if (cap.promise.done) {
        const v = cap.promise.v as Mod | null;
        const cTap = v && v.tap ? `${i}:${v.tap}` : null;
        if (cTap) st.taps++;
        // 取得がタップで終わった → 実行側も同じ打鍵で同じ修飾キーを返している／タップ以外で終わった → 実行側はそれまで返していない
        if (cTap !== wTap && (cTap || wTap)) {
          if (st.bad.length < 5) st.bad.push(`${seqText(cur)}: 取得 ${cTap ?? JSON.stringify(v)}・実行側 ${wTap}`);
        }
        break;
      }
    }
    if (!cap.promise.done) {
      if (wTap && st.bad.length < 5) st.bad.push(`${seqText(cur)}: 取得は待ち続け・実行側 ${wTap}`);
      cap.cancel();
    }
    if (C.win.ls.length) {
      if (st.bad.length < 5) st.bad.push(`${seqText(cur)}: 受け口が外れていない`);
      C.win.ls = [];
    }
  };
  const rec = (depth: number) => {
    if (depth > 0) one();
    if (depth === maxLen) return;
    const evs: Ev[] = [];
    for (const c of CODES) if (!held.has(c)) evs.push(d(c));
    for (const c of held) evs.push(u(c));
    for (const c of held) if (KEYINFO[c].flag) evs.push(d(c, true));
    evs.push({ k: "ptr" }, { k: "blur" }, { k: "wait", ms: 300 });
    for (const ev of evs) {
      const hs = new Set(held);
      if (ev.k === "down") held.add(ev.code);
      else if (ev.k === "up") held.delete(ev.code);
      cur.push(ev);
      rec(depth + 1);
      cur.pop();
      held.clear();
      for (const c of hs) held.add(c);
    }
  };
  rec(0);
  return st;
}
/** 実行側と取得が同じ関数（tapCandidateOf）で決め、呼び出し元がイベントのフラグ（mods: e）を渡しているか（構文木） */
function sameFunctionShapes(T: Tree): string[] {
  const out: string[] = [];
  const callsTo = (node: ts.Node, sf: ts.SourceFile, name: string) => {
    const got: ts.CallExpression[] = [];
    const v = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) got.push(n);
      n.forEachChild(v);
    };
    v(node);
    return got;
  };
  const objProps = (o: ts.Expression | undefined, sf: ts.SourceFile) =>
    o && ts.isObjectLiteralExpression(o)
      ? o.properties
          .map((p) =>
            ts.isPropertyAssignment(p)
              ? `${p.name.getText(sf)}: ${norm(p.initializer.getText(sf))}`
              : ts.isShorthandPropertyAssignment(p)
                ? p.name.text
                : "?"
          )
          .sort()
          .join("; ")
      : "∅";
  {
    const sf = ts.createSourceFile("keymap.ts", T.kmSrc, ts.ScriptTarget.Latest, true);
    let down: ts.MethodDeclaration | undefined;
    for (const st of sf.statements)
      if (ts.isClassDeclaration(st) && st.name?.text === "ModTapWatcher")
        for (const m of st.members) if (ts.isMethodDeclaration(m) && m.name.getText(sf) === "down" && m.body) down = m;
    const tc = down ? callsTo(down, sf, "tapCandidateOf") : [];
    out.push(`keymap ModTapWatcher.down tapCandidateOf×${tc.length} tapModOf×${down ? callsTo(down, sf, "tapModOf").length : "?"}`);
    const exported = sf.statements.some(
      (s) => ts.isFunctionDeclaration(s) && s.name?.text === "tapCandidateOf" && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
    out.push(`keymap export tapCandidateOf=${exported}`);
  }
  {
    const sf = ts.createSourceFile("main.ts", T.mainSrc, ts.ScriptTarget.Latest, true);
    let onKey: ts.Node | undefined;
    const v = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "onKey" && n.initializer) onKey = n.initializer;
      n.forEachChild(v);
    };
    const cap = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "captureKey");
    if (cap) v(cap);
    const tc = onKey ? callsTo(onKey, sf, "tapCandidateOf") : [];
    out.push(`main captureKey>onKey tapCandidateOf×${tc.length} {${objProps(tc[0]?.arguments[1], sf)}} tapModOf×${onKey ? callsTo(onKey, sf, "tapModOf").length : "?"}`);
    // ホーム画面: homeModTap.down(e.key, { … })
    const downs: string[] = [];
    const w = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "down" &&
        n.expression.expression.getText(sf) === "homeModTap"
      )
        downs.push(`${norm(n.arguments[0]?.getText(sf) ?? "")} {${objProps(n.arguments[1], sf)}}`);
      n.forEachChild(w);
    };
    w(sf);
    out.push(`main homeModTap.down ${downs.join(" | ") || "∅"}`);
  }
  {
    const sf = ts.createSourceFile("editor.ts", T.edSrc, ts.ScriptTarget.Latest, true);
    const downs: string[] = [];
    const w = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "down" &&
        n.expression.expression.getText(sf) === "this.modTap"
      ) {
        const o = n.arguments[1];
        const mods =
          o && ts.isObjectLiteralExpression(o)
            ? o.properties.filter((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "mods").map((p) => norm((p as ts.PropertyAssignment).initializer.getText(sf)))
            : [];
        downs.push(`${norm(n.arguments[0]?.getText(sf) ?? "")} mods=${mods.join(",") || "∅"}`);
      }
      n.forEachChild(w);
    };
    w(sf);
    out.push(`editor this.modTap.down ${downs.join(" | ") || "∅"}`);
  }
  return out;
}
const EXPECTED_SAME_FN = [
  "keymap ModTapWatcher.down tapCandidateOf×1 tapModOf×0",
  "keymap export tapCandidateOf=true",
  "main captureKey>onKey tapCandidateOf×1 {mods: e; pending: tapCand !== null; repeat: e.repeat} tapModOf×0",
  "main homeModTap.down e.key {blocked: false; mods: e; repeat: e.repeat}",
  "editor this.modTap.down e.key mods=e",
];
/** ★Codex 1 回目の Z12・2 回目の W07 / W08 / C02: 「アプリの呼び出し元が mods を渡し忘れたら build が落ちる」は型にしか無い約束。
 *  構文の形で見ると、同じ意味の書き換え（型の別名）で赤になる。**TypeScript に写しの keymap.ts を型検査させて**確かめる:
 *  付け忘れ 3 通りに `@ts-expect-error`（エラーにならなくなると、それ自体が TS2578 のエラー）・正しい呼び方は通る */
function typeProbe(T: Tree): string[] {
  const probe = path.join(T.dir, "src", "__v183_type_probe.ts");
  fs.writeFileSync(
    probe,
    [
      'import { ModTapWatcher } from "./keymap";',
      "const w = new ModTapWatcher(() => 0);",
      "// @ts-expect-error mods が無い",
      'w.down("Shift", {});',
      "// @ts-expect-error opts が無い",
      'w.down("Shift");',
      "// @ts-expect-error mods に undefined",
      'w.down("Shift", { mods: undefined });',
      "// @ts-expect-error mods に null（第三者レビューの T06）",
      'w.down("Shift", { mods: null });',
      'w.down("Shift", { repeat: false, blocked: false, mods: { shiftKey: true } });',
      "",
    ].join("\n")
  );
  try {
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      types: [],
    };
    const program = ts.createProgram([probe], options);
    return ts
      .getPreEmitDiagnostics(program, program.getSourceFile(probe))
      .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 90)}`);
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
async function groupS2(T: Tree, B: Tree | null, depth: { w: number; c: number }): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  try {
    const W = familyLines(T, false);
    const M = familyLines(T, true);
    const fpW = sha(W.lines);
    const fpM = sha(M.lines);
    if (PRINT_FP) console.log(`FAMILY_FP(${T.label}) win=${fpW} mac=${fpM} lines=${W.lines.length}`);
    await add(`[S-2] ★Windows: 単体・2 つ重ね・修飾キー＋文字・＋クリック・Win・keyup が来ない形・IME × 8 つの口（${W.lines.length} 行）が固定値と一致`, () =>
      fpW === FAMILY_FP.win ? ok() : ng(`指紋 ${fpW}（固定値 ${FAMILY_FP.win}）`)
    );
    await add(`[S-2] ★Mac: 同じ ${M.lines.length} 行が固定値と一致`, () => (fpM === FAMILY_FP.mac ? ok() : ng(`指紋 ${fpM}（固定値 ${FAMILY_FP.mac}）`)));
    if (!B) console.log("SKIP [S-2r] この回の前の blob が無い（公開リポジトリの clone など）。固定値の [S-2] は上で走った");
    else {
      const BW = familyLines(B, false);
      const BM = familyLines(B, true);
      await add("[S-2r] ★Windows: この回の前の木と比べて、違うのは「Win を押したまま Ctrl / Shift / Alt をトン」で旧版が発動していた行だけ", () => {
        if (BW.lines.length !== W.lines.length) return ng(`行数 ${W.lines.length} ≠ ${BW.lines.length}`);
        const bad: string[] = [];
        const perPort = new Map<string, number>();
        for (let i = 0; i < W.lines.length; i++) {
          if (W.lines[i] === BW.lines[i]) continue;
          const f = W.meta[i];
          const pn = W.port[i];
          const kind = pn.startsWith("home") ? "home" : pn.startsWith("editor") ? "editor" : pn;
          const oldHit = tapHit(kind, BW.lines[i].split(" => ")[1]);
          const newHit = tapHit(kind, W.lines[i].split(" => ")[1]);
          if (f.winHeld && oldHit && !newHit) perPort.set(pn, (perPort.get(pn) ?? 0) + 1);
          else bad.push(`新「${W.lines[i].slice(0, 120)}」／旧「${BW.lines[i].slice(0, 120)}」`);
        }
        if (bad.length) return ng(`${bad.length} 行: ${bad.slice(0, 2).join(" ・ ")}`);
        // 空振りしていない: Win を先に押した形（2 つの Win × Ctrl / Shift / Alt の左右 6 × 離し方 2 = 24 通り）が、
        // タップを全部割り当てた口（ModTapWatcher・editor・取得）で 24 行ずつ、ホームは割り当てた 1 つぶん 8 行ずつ変わっている
        const want: Record<string, number> = { watcher: 24, editor: 24, capture: 24, "home(Control)": 8, "home(Shift)": 8, "home(Alt)": 8 };
        const got = Object.fromEntries(perPort);
        return JSON.stringify(got, Object.keys(want).sort()) === JSON.stringify(want, Object.keys(want).sort())
          ? ok()
          : ng(`口ごとの差 ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`);
      });
      await add(`[S-2r] ★Mac: この回の前の木と ${M.lines.length} 行が 1 行も違わない（⌘ はタップの対象＝Win のような例外は無い）`, () => {
        if (BM.lines.length !== M.lines.length) return ng(`行数 ${M.lines.length} ≠ ${BM.lines.length}`);
        const i = M.lines.findIndex((x, j) => x !== BM.lines[j]);
        return i < 0 ? ok() : ng(`新「${M.lines[i].slice(0, 140)}」／旧「${BM.lines[i].slice(0, 140)}」`);
      });
      for (const mac of [false, true]) {
        const pf = mac ? "Mac" : "Windows";
        await add(`[S-2r] ★${pf}: ModTapWatcher の総当たり（${depth.w} 打鍵まで）で、旧版との差は全部「ほかの修飾キーのフラグが立った keydown で旧版が立てた候補」が発動しなくなったものだけ・規則はどこでも効く`, () => {
          const st = exhaustiveWatcher(T, B, mac, depth.w);
          if (PRINT_FP || process.env.V183_PRINT_CATS)
            console.log(
              `  総当たり ${pf}: ${st.nodes} 通り・差 ${st.diffs}（${[...st.cats].map(([k, v]) => `${k} ${v.n}「${v.ex}」`).join(" ／ ")}）`
            );
          if (st.bad.length) return ng(st.bad.join(" ／ "));
          // 空振りしていない: 3 つ重ねの差が出ている（この回の本題）
          return st.diffs > 0 && [...st.cats.keys()].some((k) => k.startsWith("3 つ")) ? ok() : ng(`差 ${st.diffs}・分類 ${[...st.cats.keys()].join(",")}`);
        });
      }
    }
    for (const mac of [false, true]) {
      const pf = mac ? "Mac" : "Windows";
      await add(`[S-2] ★${pf}: 設定画面の取得と実行側の判定が、総当たり（${depth.c} 打鍵まで）の全部の並びで一致（取れる操作＝発動する操作）`, () => {
        const st = exhaustiveCaptureVsWatcher(T, mac, depth.c);
        if (st.bad.length) return ng(st.bad.join(" ／ "));
        return st.taps > 0 ? ok() : ng(`タップで終わった並びが 0（${st.seqs} 通り）`);
      });
    }
    await add("[S-2] ★IME の変換中（isComposing・keyCode 229）は、ホーム画面の Ctrl+, とタップ・editor のタップと Ctrl+Z が動かない（キャンバス・ページ本体が対象でも。入力欄は IME でなくても動かない。対照: IME でなく入力欄でもなければ動く・Codex 1 回目の Z04）", () => {
      const bad: string[] = [];
      const H = compileHome(T);
      for (const mac of [false, true]) {
        setMac(T, mac);
        const std = T.K.BUILTIN_PRESETS[0];
        for (const target of [CANVAS_T, BODY_T, INPUT_T])
          for (const ime of [undefined, "composing", "229", "both"] as (Ime | undefined)[]) {
            const moves = !ime && target !== INPUT_T;
            const comma = runSeq(homePort(T, H, std), [d("ControlLeft", false, ime), d("Comma", false, ime), u("Comma", ime), u("ControlLeft", ime)], target);
            const htap = runSeq(homePort(T, H, HOME_TAPS[0]), [d("ControlLeft", false, ime), u("ControlLeft", ime)], target);
            const etap = runSeq(editorPort(T, TAP_ALL), [d("ControlLeft", false, ime), u("ControlLeft", ime)], target);
            const ez = runSeq(editorPort(T, TAP_ALL), [d("ControlLeft", false, ime), d("KeyZ", false, ime), u("KeyZ", ime), u("ControlLeft", ime)], target);
            const got = [comma, htap, etap, ez].map((o) => (/(settings|cmd:)/.test(o) ? "動く" : "-")).join(",");
            const exp = [0, 1, 2, 3].map(() => (moves ? "動く" : "-")).join(",");
            if (got !== exp) bad.push(`${mac ? "Mac" : "Win"} ${target.tagName} ime=${ime ?? "なし"}: ${got}（期待 ${exp}）`);
          }
      }
      setMac(T, null);
      return bad.length ? ng(bad.join(" ／ ")) : ok();
    });
    await add("[S-2] ★押したときは門番が開いていて、離すときに閉じた形（入力欄へ移った・ダイアログが開いた・ホームは IME も）では、ホーム画面と editor のタップが動かない（離したときの門番・対照: 閉じなければ動く・Codex 2 回目の W09）", () => {
      const bad: string[] = [];
      const H = compileHome(T);
      for (const mac of [false, true]) {
        setMac(T, mac);
        for (const how of ["なし", "入力欄へ", "ダイアログ", "IME"] as const) {
          // ホーム画面: Ctrl のタップで設定を開く
          {
            const clock = { t: 10_000 };
            const w = new T.K.ModTapWatcher(() => clock.t);
            const doc = { modal: false, querySelector: (sel: string) => (sel === ".modal-back" && doc.modal ? {} : null) };
            let opened = 0;
            const h = H(HOME_TAPS[0], w, () => void opened++, doc);
            h.homeKeyHandler(kev("Control", "ControlLeft", { ctrl: true }, { target: BODY_T }));
            if (how === "ダイアログ") doc.modal = true;
            const up = kev("Control", "ControlLeft", {}, {
              type: "keyup",
              target: how === "入力欄へ" ? INPUT_T : BODY_T,
              ...(how === "IME" ? { isComposing: true } : {}),
            });
            h.homeKeyUpHandler(up);
            const want = how === "なし" ? 1 : 0;
            if (opened !== want) bad.push(`${mac ? "Mac" : "Win"} ホーム ${how}: 開いた ${opened}（期待 ${want}）`);
          }
          // editor: Ctrl のタップで元に戻す（IME は離したときの門番に無い＝押したときだけ見る。以前から）
          if (how !== "IME") {
            const { ed, calls } = makeEd(T, TAP_ALL);
            ed.keydownHandler(kev("Control", "ControlLeft", { ctrl: true }));
            let restore: (() => void) | null = null;
            if (how === "ダイアログ") {
              const orig = ed.dialogOpen;
              ed.dialogOpen = () => true;
              restore = () => (ed.dialogOpen = orig);
            }
            calls.length = 0;
            ed.lastCommandAt = new Map();
            ed.keyupHandler(kev("Control", "ControlLeft", {}, { type: "keyup", target: how === "入力欄へ" ? INPUT_T : CANVAS_T }));
            restore?.();
            const fired = calls.some((x) => x.startsWith("cmd:"));
            if (fired !== (how === "なし")) bad.push(`${mac ? "Mac" : "Win"} editor ${how}: ${calls.join("+") || "-"}`);
          }
        }
      }
      setMac(T, null);
      return bad.length ? ng(bad.join(" ／ ")) : ok();
    });
    await add("[S-2] ★押したときだけ門番が閉じていた形（重い処理・editor のダイアログ・main.ts のモーダル・ホームの IME）では、離すときに開いていてもタップが動かない（押したときの門番・対照: 閉じていなければ動く・第三者レビューの T09）", () => {
      const bad: string[] = [];
      const H = compileHome(T);
      const D = G.document as Mod;
      const q0 = D.querySelector;
      try {
        for (const mac of [false, true]) {
          setMac(T, mac);
          for (const how of ["なし", "重い処理", "editor のダイアログ", "main.ts のモーダル"] as const) {
            const { ed, calls } = makeEd(T, TAP_ALL);
            if (how === "重い処理") ed.busyKind = "save";
            if (how === "editor のダイアログ") ed.modalDepth = 1;
            if (how === "main.ts のモーダル") D.querySelector = (sel: string) => (sel === ".modal-back" ? {} : null);
            ed.keydownHandler(kev("Control", "ControlLeft", { ctrl: true }));
            ed.busyKind = "";
            ed.modalDepth = 0;
            D.querySelector = q0;
            calls.length = 0;
            ed.lastCommandAt = new Map();
            ed.keyupHandler(kev("Control", "ControlLeft", {}, { type: "keyup" }));
            const fired = calls.some((x) => x.startsWith("cmd:"));
            if (fired !== (how === "なし")) bad.push(`${mac ? "Mac" : "Win"} editor ${how}: ${calls.join("+") || "-"}`);
          }
          for (const how of ["なし", "モーダル", "IME"] as const) {
            const clock = { t: 10_000 };
            const w = new T.K.ModTapWatcher(() => clock.t);
            const doc = { modal: how === "モーダル", querySelector: (sel: string) => (sel === ".modal-back" && doc.modal ? {} : null) };
            let opened = 0;
            const h = H(HOME_TAPS[0], w, () => void opened++, doc);
            h.homeKeyHandler(kev("Control", "ControlLeft", { ctrl: true }, { target: BODY_T, ...(how === "IME" ? { isComposing: true, keyCode: 229 } : {}) }));
            doc.modal = false;
            h.homeKeyUpHandler(kev("Control", "ControlLeft", {}, { type: "keyup", target: BODY_T }));
            if (opened !== (how === "なし" ? 1 : 0)) bad.push(`${mac ? "Mac" : "Win"} ホーム ${how}: 開いた ${opened}`);
          }
        }
      } finally {
        D.querySelector = q0;
        setMac(T, null);
      }
      return bad.length ? ng(bad.join(" ／ ")) : ok();
    });
    await add("[S-2] ★ホーム画面の口は、エディタを開いている間は Ctrl+, もタップも動かさない（対照: 閉じていれば動く・第三者レビューの T14）", () => {
      const bad: string[] = [];
      const H = compileHome(T);
      for (const mac of [false, true]) {
        setMac(T, mac);
        for (const editorOpen of [false, true]) {
          const clock = { t: 10_000 };
          const w = new T.K.ModTapWatcher(() => clock.t);
          let opened = 0;
          const std = H(T.K.BUILTIN_PRESETS[0], w, () => void opened++, { querySelector: () => null }, editorOpen);
          const d1 = kev(",", "Comma", { ctrl: true }, { target: BODY_T });
          std.homeKeyHandler(d1);
          const tap = H(HOME_TAPS[0], new T.K.ModTapWatcher(() => clock.t), () => void opened++, { querySelector: () => null }, editorOpen);
          tap.homeKeyHandler(kev("Control", "ControlLeft", { ctrl: true }, { target: BODY_T }));
          tap.homeKeyUpHandler(kev("Control", "ControlLeft", {}, { type: "keyup", target: BODY_T }));
          const want = editorOpen ? 0 : 2;
          if (opened !== want || d1.defaultPrevented !== !editorOpen)
            bad.push(`${mac ? "Mac" : "Win"} editorOpen=${editorOpen}: 開いた ${opened}（期待 ${want}）・pd ${d1.defaultPrevented}`);
        }
      }
      setMac(T, null);
      return bad.length ? ng(bad.join(" ／ ")) : ok();
    });
    await add("[S-2] ★型: ModTapWatcher.down に mods を渡し忘れる 3 通り（opts ごと・mods なし・undefined）が型エラーで、正しい呼び方は通る（TypeScript に写しを型検査させる）", () => {
      const diags = typeProbe(T);
      return diags.length ? ng(diags.join(" ／ ")) : ok();
    });
    await add("[S-2] ★実行側（ModTapWatcher.down）と取得（captureKey）が同じ tapCandidateOf で決め、editor とホームがイベントのフラグを渡す（構文木）", () => {
      const d2 = multisetDiff(sameFunctionShapes(T), EXPECTED_SAME_FN);
      return d2 ? ng(d2) : ok();
    });
  } finally {
    setMac(T, null);
    if (B) setMac(B, null);
  }
  return r;
}

// =====================================================================================
// [S-3] ★A-83: V181 の検査の穴（Y06・Y08・Y01/Y09/Y16・Y02/Y03・Y04/Y05）
// =====================================================================================
function pointerBattery(T: Tree): string[] {
  const out: string[] = [];
  for (const p of [...T.K.BUILTIN_PRESETS, ...USER_PRESETS, PTR_PRESET]) {
    const { ed } = makeEd(T, p);
    for (const button of [0, 1, 2]) for (const m of MOD16) out.push(`${p.id} B${button} ${tag(m)} => ${ed.pointerCommandFor(pev(button, m)) ?? "-"}`);
  }
  return out;
}
async function groupS3(T: Tree, B83: Tree | null, B81: Tree | null): Promise<R[]> {
  const r: R[] = [];
  const add = async (name: string, fn: () => V | Promise<V>) => r.push({ name, v: await safe(fn) });
  try {
    // ---- ① Y06: editor の＋クリックの引き当て（pointerCommandFor） ----
    setMac(T, false);
    const PW = pointerBattery(T);
    setMac(T, true);
    const PM = pointerBattery(T);
    setMac(T, null);
    await add(`[S-3①] ★Mac の pointerCommandFor: ⌘ を含まない ${PM.length / 2} 行は Windows と同じ・⌘ の行は Ctrl に畳んだ Windows の行と同じ（Y06）`, () => {
      const bad: string[] = [];
      for (let i = 0; i < PM.length; i++) {
        const mi = i % 16;
        const want = mi & 8 ? PW[i - mi + ((mi & ~8) | 1)] : PW[i];
        const strip = (s: string) => s.split(" => ")[1];
        if (strip(PM[i]) !== strip(want)) bad.push(`Mac「${PM[i]}」／期待「${want}」`);
      }
      const hits = PM.filter((x) => !x.endsWith("=> -")).length;
      if (bad.length) return ng(`${bad.length} 行: ${bad.slice(0, 3).join(" ・ ")}`);
      // 空振りしていない: Alt＋クリックのスポイト（組み込み）と ⌘＋クリック（u1 の Ctrl＋クリック）が Mac で効いている。
      // 一致する行はちょうど 16: Ctrl を持たない割り当て 4 つ（組み込み 2 つのスポイト・u4 の Alt＋左／Shift＋中）は 1 行ずつ、
      // Ctrl を持つ割り当て 4 つ（u1 の Ctrl＋左・u2 の Ctrl+Shift＋右・u4 の Ctrl+Alt＋右／Ctrl＋中）は ctrl・⌘・両方の 3 行ずつ
      const std = PM.find((x) => x.startsWith("standard B0 --A- =>"));
      const u1 = PM.find((x) => x.startsWith("u1 B0 ---M =>"));
      return hits === 16 && std?.endsWith("edit.pickColor") && u1?.endsWith("edit.pickColor") ? ok() : ng(`一致 ${hits} 行（期待 16）・${std}・${u1}`);
    });
    if (B81) {
      const OW = pointerBattery(B81);
      await add(`[S-3①] ★Windows の pointerCommandFor（${PW.length} 行）が V181 の前の木と 1 行も違わない`, () => {
        const i = PW.findIndex((x, j) => x !== OW[j]);
        return PW.length === OW.length && i < 0 ? ok() : ng(`${i} 行目: ${PW[i]} ≠ ${OW[i]}`);
      });
    } else console.log("SKIP [S-3①] V181 の前の blob が無い");
    if (B83) {
      setMac(B83, true);
      const OM = pointerBattery(B83);
      setMac(B83, null);
      await add("[S-3①] Mac の pointerCommandFor がこの回の前の木と 1 行も違わない", () => {
        const i = PM.findIndex((x, j) => x !== OM[j]);
        return PM.length === OM.length && i < 0 ? ok() : ng(`${i} 行目: ${PM[i]} ≠ ${OM[i]}`);
      });
    }

    // ---- ② Y08: applyI18n（静的 DOM の textContent / title / placeholder） ----
    const html = indexHtmlKeys();
    const modKeys = Object.keys(T.D.ja).filter((k) => LANGS.some((l) => MOD_WORD.test(T.D[l][k] ?? "")));
    const keys = [...new Set([...html.text, ...html.title, ...html.ph, ...modKeys])];
    const nonKey: Set<string> = (T.P?.NON_KEY_WORD_DICT_KEYS as Set<string>) ?? new Set();
    const lookupRaw = (l: string, k: string) => T.D[l][k] ?? T.D.en[k] ?? T.D.ja[k] ?? `[${k}]`;
    await add(
      `[S-3②] ★Mac の applyI18n: 7 言語 × ${keys.length} キー × textContent / title / placeholder で Ctrl / Alt / Shift の語が残らず・記号になる（Y08）`,
      () => {
        const bad: string[] = [];
        let sym = 0;
        setMac(T, true);
        for (const l of LANGS) {
          T.I.setLang(l);
          for (const x of runApplyI18n(T, keys)) {
            if (/[⌘⌥⇧]/.test(x.v)) sym++;
            if (MOD_WORD.test(x.v) && !(l === "en" && nonKey.has(x.key))) bad.push(`${l} ${x.attr} ${x.key}「${x.v.slice(0, 60)}」`);
          }
        }
        T.I.setLang("ja");
        setMac(T, null);
        if (bad.length) return ng(`${bad.length} 件: ${bad.slice(0, 3).join(" ／ ")}`);
        // 空振りしていない: 3 つの口とも記号が入った（index.html の ↶ の説明「元に戻す (⌘Z)」を含む）
        return sym >= LANGS.length * 3 * 10 ? ok() : ng(`記号の入った値 ${sym}`);
      }
    );
    await add(`[S-3②] ★Windows の applyI18n: 7 言語 × ${keys.length} キー × 3 つの口が辞書の原文そのまま`, () => {
      const bad: string[] = [];
      setMac(T, false);
      for (const l of LANGS) {
        T.I.setLang(l);
        for (const x of runApplyI18n(T, keys)) if (x.v !== lookupRaw(l, x.key)) bad.push(`${l} ${x.attr} ${x.key}`);
      }
      T.I.setLang("ja");
      setMac(T, null);
      return bad.length ? ng(`${bad.length} 件: ${bad.slice(0, 3).join(", ")}`) : ok();
    });
    if (B83) {
      await add("[S-3②] ★Mac の applyI18n の 3 つの口が、この回の前の t() と 1 文字も違わない（7 言語）", () => {
        const bad: string[] = [];
        setMac(T, true);
        setMac(B83, true);
        for (const l of LANGS) {
          T.I.setLang(l);
          B83.I.setLang(l);
          for (const x of runApplyI18n(T, keys)) if (x.v !== B83.I.t(x.key)) bad.push(`${l} ${x.attr} ${x.key}「${x.v.slice(0, 50)}」`);
        }
        T.I.setLang("ja");
        B83.I.setLang("ja");
        setMac(T, null);
        setMac(B83, null);
        return bad.length ? ng(`${bad.length} 件: ${bad.slice(0, 3).join(" ／ ")}`) : ok();
      });
    }
    await add("[S-3②] 空振りしていない: index.html の説明（data-i18n-title）に Ctrl を含むものがあり、偽の DOM の 3 つの口が全部埋まる", () => {
      const withCtrl = html.title.filter((k) => /\bCtrl\b/.test(T.D.ja[k] ?? ""));
      T.I.setLang("ja");
      const got = runApplyI18n(T, keys);
      const empty = got.filter((x) => x.v === "");
      return withCtrl.length >= 2 && html.ph.length >= 1 && empty.length === 0 ? ok() : ng(`Ctrl の説明 ${withCtrl.length}・placeholder ${html.ph.length}・空 ${empty.length}`);
    });

    // ---- ③ Y01・Y09・Y16: 文字の入力欄／Y02・Y03: 波形のホイール（構文木で取り出して動かす） ----
    const TX = textareaListeners(T.edSrc);
    const WX = waveListeners(T.edSrc);
    // 表を直すときは V183_PRINT_ROWS=1 で、いまの木の表をそのまま出す（写す前に、差が意図どおりかを確かめること）
    if (process.env.V183_PRINT_ROWS) console.log(JSON.stringify({ TA_ROWS: TX.rows, WAVE_ROWS: WX.rows, EXPECTED_WIRING: wiringRows(T) }, null, 2));
    await add("[S-3③] ★波形の拡大・縮小（本物の setZoom・view・winSec）で、カーソルの下の時刻が動かない（1/4 と 3/4・拡大と縮小・第三者レビューの T04）", () => {
      const sf = ts.createSourceFile("editor.ts", T.edSrc, ts.ScriptTarget.Latest, true);
      const m = classMethod(sf, "Editor", "openAudioPanel");
      if (!m) return ng("openAudioPanel が無い");
      const pick = (name: string) => {
        let init: ts.Expression | undefined;
        const v = (x: ts.Node) => {
          if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === name && x.initializer && ts.isArrowFunction(x.initializer)) init = x.initializer;
          x.forEachChild(v);
        };
        v(m);
        if (!init) throw new Error(`${name} が無い`);
        return { text: init.getText(sf), free: freeIdentifiers(init) };
      };
      const fns = { winSec: pick("winSec"), view: pick("view"), setZoom: pick("setZoom") };
      const own = new Set(Object.keys(fns));
      const free = [...new Set(Object.values(fns).flatMap((f) => f.free))].filter((n) => !own.has(n)).sort();
      const bad: string[] = [];
      let moved = 0;
      for (const frac of [0.25, 0.75])
        for (const t of [0.58, 0.42]) {
          const env: Record<string, unknown> = {
            buffer: { duration: 10 },
            zoomT: 0.5,
            viewStart: 2,
            normTrim: () => ({ ts: 0, te: 10 }),
            syncZoomUI: () => {},
            drawWave: () => {},
          };
          for (const n of free) if (!(n in env)) throw new Error(`自由変数 ${n} の差し替えが無い`);
          const js = (x: string) => ts.transpileModule(`(${x})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText.trim().replace(/;$/, "");
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const Z = new Function(
            "__env",
            `"use strict";\nlet ${free.map((n) => `${n} = __env[${JSON.stringify(n)}]`).join(", ")};\nconst winSec = ${js(fns.winSec.text)};\nconst view = ${js(fns.view.text)};\nconst setZoom = ${js(fns.setZoom.text)};\nreturn { setZoom, view };`
          )(env) as { setZoom: (t: number, a: number, f: number) => void; view: () => { v0: number; vd: number } };
          const before = Z.view();
          const anchor = before.v0 + frac * before.vd; // いまカーソルの下にある時刻
          Z.setZoom(t, anchor, frac);
          const after = Z.view();
          if (Math.abs(after.vd - before.vd) > 1e-9) moved++;
          const under = after.v0 + frac * after.vd;
          if (Math.abs(under - anchor) > 1e-9) bad.push(`frac=${frac} t=${t}: 前 ${anchor.toFixed(4)} → 後 ${under.toFixed(4)}`);
        }
      return bad.length ? ng(bad.join(" ／ ")) : moved === 4 ? ok() : ng(`窓の幅が変わったのは ${moved}/4`);
    });
    await add("[S-3③] ★文字の入力欄の受け口の表（input・keydown）＝キーは keydown で受ける（Y09）", () => {
      const d3 = multisetDiff(TX.rows, TA_ROWS);
      return d3 ? ng(d3) : ok();
    });
    await add("[S-3③] ★波形の受け口の表（pointer 5 つ・wheel は passive: false）（Y02）", () => {
      const d3 = multisetDiff(WX.rows, WAVE_ROWS);
      return d3 ? ng(d3) : ok();
    });
    for (const mac of [false, true]) {
      const pf = mac ? "Mac" : "Windows";
      setMac(T, mac);
      const ta = textareaBattery(T, TX);
      const wh = wheelBattery(T, WX);
      setMac(T, null);
      await add(`[S-3③] ★${pf}: 入力欄の中で Esc は取消・Ctrl+Enter${mac ? "（⌘Enter も）" : ""}は確定・どちらも preventDefault ＋ stopPropagation・IME 中とほかのキーは何もしない（${ta.length} 通り・Y01 / Y16）`, () => {
        const want = textareaExpect(mac);
        const i = ta.findIndex((x, j) => x !== want[j]);
        return ta.length === want.length && i < 0 ? ok() : ng(`${ta[i]}（期待 ${want[i]?.split(" => ")[1] ?? want[i]}）`);
      });
      await add(`[S-3③] ★${pf}: 波形のホイール: Ctrl${mac ? "（⌘ も）" : ""}＋上へ回すと拡大・下へ回すと縮小（カーソルの位置が基準）・素のホイールは移動・音が無いときは何もしない・既定の動きを止める（${wh.length} 通り・Y03）`, () => {
        const want = wheelExpect(mac);
        const i = wh.findIndex((x, j) => x !== want[j]);
        return wh.length === want.length && i < 0 ? ok() : ng(`${wh[i]}（期待 ${want[i]?.split(" => ")[1]}）`);
      });
      if (B83) {
        setMac(B83, mac);
        const ta83 = textareaBattery(B83, textareaListeners(B83.edSrc));
        const wh83 = wheelBattery(B83, waveListeners(B83.edSrc));
        setMac(B83, null);
        await add(`[S-3③] ${pf}: 入力欄と波形の受け口が、この回の前の木から同じ道で取り出したものと 1 行も違わない`, () => {
          const a = ta.findIndex((x, j) => x !== ta83[j]);
          const b = wh.findIndex((x, j) => x !== wh83[j]);
          return a < 0 && b < 0 && ta.length === ta83.length && wh.length === wh83.length ? ok() : ng(`入力欄 ${ta[a]} ／ 波形 ${wh[b]}`);
        });
      }
    }
    if (B81) {
      await add("[S-3③] ★Windows: 入力欄と波形の受け口（と受け口の表）が、V181 の前の木から同じ道で取り出したものと 1 行も違わない", () => {
        const TX81 = textareaListeners(B81.edSrc);
        const WX81 = waveListeners(B81.edSrc);
        setMac(T, false);
        const ta = textareaBattery(T, TX);
        const wh = wheelBattery(T, WX);
        setMac(T, null);
        const ta81 = textareaBattery(B81, TX81);
        const wh81 = wheelBattery(B81, WX81);
        const a = ta.findIndex((x, j) => x !== ta81[j]);
        const b = wh.findIndex((x, j) => x !== wh81[j]);
        const rowsSame = TX81.rows.join("|") === TX.rows.join("|") && WX81.rows.join("|") === WX.rows.join("|");
        return a < 0 && b < 0 && rowsSame && ta.length === ta81.length ? ok() : ng(`入力欄 ${ta[a]} ／ 波形 ${wh[b]} ／ 表 ${rowsSame}`);
      });
    }

    // ---- ④ Y04・Y05: 配線 ----
    const rows = wiringRows(T);
    await add(`[S-3④] ★配線の表（editor の mount / unmount・ホーム・取得の ${EXPECTED_WIRING.length} 行）が表どおり（Y04 / Y05）`, () => {
      const d4 = multisetDiff(rows, EXPECTED_WIRING);
      return d4 ? ng(d4) : ok();
    });
    await add("[S-3④] ★付けた口は外す: editor の mount と unmount・取得の add と remove が 1 対 1（種類・受け手・capture まで）", () => {
      const pick = (pfx: string, meth: string) =>
        rows
          .filter((x) => x.startsWith(pfx) && x.includes(`.${meth}(`))
          .map((x) => x.replace(/^\S+ /, "").replace(`.${meth}(`, "(").replace(/ \[.*\]$/, ""))
          .sort();
      const a = pick("editor.mount ", "add").join("|");
      const b = pick("editor.unmount ", "remove").join("|");
      const c = pick("main.captureKey ", "add").join("|");
      const e = pick("main.captureKey ", "remove").join("|");
      return a === b && c === e && a.length > 0 && c.length > 0 ? ok() : ng(`editor ${a === b}・取得 ${c === e}`);
    });
  } finally {
    setMac(T, null);
  }
  return r;
}

// =====================================================================================
// 実行
// =====================================================================================
type Group = "S-1" | "S-2" | "S-3";
async function runGroups(T: Tree, groups: Group[], depth: { w: number; c: number }): Promise<Record<Group, R[]>> {
  const res = { "S-1": [], "S-2": [], "S-3": [] } as Record<Group, R[]>;
  if (groups.includes("S-1")) res["S-1"] = await groupS1(T);
  if (groups.includes("S-2")) res["S-2"] = await groupS2(T, B83, depth);
  if (groups.includes("S-3")) res["S-3"] = await groupS3(T, B83, B81);
  return res;
}
const t0 = Date.now();
const ALL: Group[] = ["S-1", "S-2", "S-3"];
const m0dir = path.join(WORK, "m0");
copySrc(m0dir);
const T0 = await loadTree(m0dir, "m0");
const B83 = await blobTree("base83", BASE83_BLOBS);
const B81 = await blobTree("base81", BASE81_BLOBS, ["src/platform.ts"]);
const FULL = { w: 6, c: 5 };
const res0 = await runGroups(T0, ALL, FULL);
for (const g of ALL) for (const x of res0[g]) check(x.name, x.v.ok, x.v.why);
const allGreen = ALL.every((g) => res0[g].every((x) => x.v.ok));
check("[S-0] 無改変の写しでは全部緑", allGreen);

// =====================================================================================
// [S-4] ★Codex の Y01〜Y16 ／ [S-R] 反証
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
const II = "src/i18n/index.ts";
// ★V181 の Codex 2 回目（review_v181.py の M 表）の書き換えを**そのまま**写した（from / to の字面も同じ）。
//  V181 の報告書 §12: Y01〜Y06・Y08・Y09・Y16 が全ゲート緑（＝検査の穴）、Y07・Y10〜Y15 は v181 で赤
const CODEX_Y: (Edit & { id: string; why: string })[] = [
  { id: "Y01", file: ED, why: "textarea commit becomes cancel", from: "            this.commitTextDraft();\n          }\n        });\n        $(\"#ed-text-ok\")", to: "            this.cancelTextDraft();\n          }\n        });\n        $(\"#ed-text-ok\")" },
  { id: "Y02", file: ED, why: "wheel listener passive", from: "          { passive: false }\n        );\n      }\n      box.querySelector(\"#ap-apply\")", to: "          { passive: true }\n        );\n      }\n      box.querySelector(\"#ap-apply\")" },
  { id: "Y03", file: ED, why: "wheel zoom direction reversed", from: "setZoom(zoomT - Math.sign(e.deltaY) * 0.08, v0 + frac * vd, frac);", to: "setZoom(zoomT + Math.sign(e.deltaY) * 0.08, v0 + frac * vd, frac);" },
  { id: "Y04", file: ED, why: "editor keyup registered under wrong event", from: "window.addEventListener(\"keyup\", this.keyupHandler);", to: "window.addEventListener(\"keydown\", this.keyupHandler);" },
  { id: "Y05", file: MA, why: "home shortcut registered on keyup", from: "window.addEventListener(\"keydown\", homeKeyHandler);", to: "window.addEventListener(\"keyup\", homeKeyHandler);" },
  { id: "Y06", file: ED, why: "Mac pointer lookup result discarded", from: "    return ids && ids.length ? ids[0] : null;", to: "    return ids && ids.length && !isMacPlatform() ? ids[0] : null;" },
  { id: "Y07", file: KM, why: "Mac NumpadEnter normalization removed", from: "return code === \"NumpadEnter\" ? \"Enter\" : code;", to: "return code === \"NumpadEnter\" && !isMacPlatform() ? \"Enter\" : code;" },
  { id: "Y08", file: II, why: "DOM titles bypass translated formatter", from: "if (k) el.title = t(k);", to: "if (k) el.title = lookup(k) ?? `[${k}]`;" },
  { id: "Y09", file: ED, why: "text input listener attached to keyup", from: "ta.addEventListener(\"keydown\", (e) => {", to: "ta.addEventListener(\"keyup\", (e) => {" },
  { id: "Y10", file: PF, why: "modifier regexp only replaces first chain", from: "[¥＿←→↑↓]))?/g;", to: "[¥＿←→↑↓]))?/;" },
  { id: "Y11", file: KM, why: "Mac registration turns middle click into right click", from: "button: (e.button === 1 ? 1 : e.button === 2 ? 2 : 0)", to: "button: (e.button === 1 ? (isMacPlatform() ? 2 : 1) : e.button === 2 ? 2 : 0)" },
  { id: "Y12", file: KM, why: "Mac physical code replaced by layout key on registration", from: "const b: KeyBinding = { code: normCode(e.code) };", to: "const b: KeyBinding = { code: normCode(isMacPlatform() && e.key.length === 1 ? \"Key\" + e.key.toUpperCase() : e.code) };" },
  { id: "Y13", file: ED, why: "repeatable redo removed only on Mac", from: "if (e.repeat && !Editor.REPEATABLE.has(id)) return this.swallowRepeatOnMac(e);", to: "if (e.repeat && (!Editor.REPEATABLE.has(id) || (isMacPlatform() && id === \"edit.redo\"))) return this.swallowRepeatOnMac(e);" },
  { id: "Y14", file: KM, why: "Mac held tap clock made absolute", from: "return this.now() - cand.at <= MOD_TAP_MS ? cand.key : null;", to: "return this.now() - (isMacPlatform() ? 0 : cand.at) <= MOD_TAP_MS ? cand.key : null;" },
  { id: "Y15", file: MA, why: "capture Escape commits Escape instead of cancelling", from: "finish(e.code === \"Escape\" ? null : bindingFromEvent(e));", to: "finish(bindingFromEvent(e));" },
  { id: "Y16", file: ED, why: "textarea Cmd Enter loses preventDefault", from: "            // V181: Mac は ⌘Enter でも確定（`primaryMod`＝Ctrl か、Mac なら ⌘ も）\n            e.preventDefault();", to: "            // V181: Mac は ⌘Enter でも確定（`primaryMod`＝Ctrl か、Mac なら ⌘ も）" },
];
/** Y ごとに赤くなるはずの群（V181 の検査の穴 9 つは [S-3]・v181 でも赤だった 7 つはこの回の [S-2] の旧版比較でも赤） */
const Y_EXPECT: Record<string, Group[]> = {
  Y01: ["S-3"],
  Y02: ["S-3"],
  Y03: ["S-3"],
  Y04: ["S-3"],
  Y05: ["S-3"],
  Y06: ["S-3"],
  Y07: ["S-2"],
  Y08: ["S-3"],
  Y09: ["S-3"],
  Y10: ["S-3"],
  Y11: ["S-2"],
  Y12: ["S-2"],
  Y13: ["S-2"],
  Y14: ["S-2"],
  Y15: ["S-2"],
  Y16: ["S-3"],
};
const MUTATIONS: Mutation[] = [
  ...CODEX_Y.map((y) => ({ id: y.id, why: `Codex ${y.why}`, edits: [{ file: y.file, from: y.from, to: y.to }], expect: Y_EXPECT[y.id] })),
  // ---- [S-R] A-82 の直し ----
  {
    id: "R01",
    why: "直す前の条件に戻す（ほかの修飾キーのフラグを見ない）",
    edits: [{ file: KM, from: "if (!k || o.repeat || o.blocked || o.pending || otherModHeld(key, o.mods)) return null;", to: "if (!k || o.repeat || o.blocked || o.pending) return null;" }],
    expect: ["S-1", "S-2"],
  },
  {
    id: "R02",
    why: "強すぎる: 押したキー自身のフラグも数える（単体のタップまで候補にならない）",
    edits: [{ file: KM, from: '(key !== "Control" && Boolean(f.ctrlKey)) ||', to: "Boolean(f.ctrlKey) ||" }],
    expect: ["S-2"],
  },
  {
    id: "R03",
    why: "強すぎる: 2 つ重ねたあとは全部離しても候補を立てない（覚えた状態で止める）",
    edits: [
      {
        file: KM,
        from: "    this.cand = k ? { key: k, at: this.now() } : null;",
        to: "    if (!k && this.cand && tapModOf(key)) this.stuck = true;\n    this.cand = k && !this.stuck ? { key: k, at: this.now() } : null;",
      },
      { file: KM, from: "  private cand: { key: TapMod; at: number } | null = null;", to: "  private cand: { key: TapMod; at: number } | null = null;\n  private stuck = false;" },
    ],
    expect: ["S-2"],
  },
  {
    id: "R04",
    why: "Win / ⌘ を「ほかの修飾キー」に数えない（metaKey を見落とす）",
    edits: [{ file: KM, from: '    (key !== "Meta" && Boolean(f.metaKey))', to: "    false" }],
    expect: ["S-1"],
  },
  {
    id: "R05",
    why: "editor がイベントのフラグを渡さない",
    edits: [{ file: ED, from: "      mods: e, // V183", to: "      mods: undefined, // V183" }],
    expect: ["S-1", "S-2"],
  },
  {
    id: "R06",
    why: "ホーム画面がイベントのフラグを渡さない",
    edits: [{ file: MA, from: "homeModTap.down(e.key, { repeat: e.repeat, blocked: false, mods: e });", to: "homeModTap.down(e.key, { repeat: e.repeat, blocked: false });" }],
    expect: ["S-1", "S-2"],
  },
  {
    id: "R07",
    why: "設定画面の取得が同じ関数を使わない（直す前の自前の条件）",
    edits: [
      {
        file: MA,
        from: "        const tk = tapCandidateOf(e.key, { repeat: e.repeat, pending: tapCand !== null, mods: e });\n        tapCand = tk ? { key: tk, at: performance.now() } : null;",
        to: "        const tk = tapModOf(e.key);\n        tapCand = !e.repeat && !tapCand && tk ? { key: tk, at: performance.now() } : null;",
      },
    ],
    expect: ["S-1", "S-2"],
  },
  {
    id: "R08",
    why: "実行側で「もう候補が立っている」を渡さない（同じ修飾キーの左右を続けて押すと候補が立ち直る）",
    edits: [{ file: KM, from: "pending: this.cand !== null,", to: "pending: false," }],
    expect: ["S-2"],
  },
  {
    id: "R09",
    why: "規則を Windows でだけ効かせる",
    edits: [{ file: KM, from: "  if (!f) return false;", to: "  if (!f || isMacPlatform()) return false;" }],
    expect: ["S-1"],
  },
  {
    id: "R10",
    why: "規則を Mac でだけ効かせる",
    edits: [{ file: KM, from: "  if (!f) return false;", to: "  if (!f || !isMacPlatform()) return false;" }],
    expect: ["S-1"],
  },
  // ---- 配線（④）: Codex の Y04 / Y05 のほかに ----
  {
    id: "R11",
    why: "取得の keyup を capture で受けない",
    edits: [{ file: MA, from: 'window.addEventListener("keyup", onKeyUp, true); // V165 (D-4)', to: 'window.addEventListener("keyup", onKeyUp); // V165 (D-4)' }],
    expect: ["S-3"],
  },
  {
    id: "R12",
    why: "editor の unmount で keyup を外さない（付けた口が残る）",
    edits: [{ file: ED, from: '    window.removeEventListener("keyup", this.keyupHandler);\n', to: "" }],
    expect: ["S-3"],
  },
  {
    id: "R13",
    why: "ホーム画面のフォーカスが外れたときの候補の破棄を外す",
    edits: [{ file: MA, from: '  window.addEventListener("blur", homeModTapCancel);\n', to: "" }],
    expect: ["S-3"],
  },
  // ---- Codex 1 回目（V183）の書き換えのうち、この回の最初の検査（9e48b63）で全ゲート緑だった 4 通り（字面もそのまま） ----
  {
    id: "R14",
    why: "Codex Z04: ホーム画面が IME の変換中を止めない",
    edits: [{ file: MA, from: "if (e.isComposing || e.keyCode === 229) return true;", to: "if (false) return true;" }],
    expect: ["S-2"],
  },
  {
    id: "R15",
    why: "Codex Z10: 波形の座標（localX）が枠の左端を引き忘れる",
    edits: [{ file: ED, from: "return ((e.clientX - r.left) / r.width) * cv.width;", to: "return (e.clientX / r.width) * cv.width;" }],
    expect: ["S-3"],
  },
  {
    id: "R16",
    why: "Codex Z12: 型の overload で mods を任意にする（渡し忘れても build が通る）",
    edits: [
      {
        file: KM,
        from: "down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods: ModFlags }): void;",
        to: "down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods?: ModFlags }): void;",
      },
    ],
    expect: ["S-2"],
  },
  {
    id: "R18",
    why: "文字の入力欄: キーの受け口を付ける前に、打ちかけの間は return（条件の表には出ない形）",
    edits: [
      {
        file: ED,
        from: '        ta.addEventListener("keydown", (e) => {',
        to: '        if (this.textDraft) return;\n        ta.addEventListener("keydown", (e) => {',
      },
    ],
    expect: ["S-3"],
  },
  // ---- 付ける前に抜ける道・型・同じブロックのほかの口（Codex 2 回目の前に自分で塞いだ形） ----
  {
    id: "R19",
    why: "起動時: ホーム画面のキーの受け口より前に、本番でも抜ける return を差し込む",
    edits: [{ file: MA, from: '  window.addEventListener("keydown", loneAltGuard, true);\n', to: '  if (!keys.presets) return;\n  window.addEventListener("keydown", loneAltGuard, true);\n' }],
    expect: ["S-3"],
  },
  {
    id: "R20",
    why: "起動時: DEV の診断ページの 1 つから `import.meta.env.DEV &&` を落とす（本番でも抜ける道になる）",
    edits: [
      {
        file: MA,
        from: 'if (import.meta.env.DEV && new URLSearchParams(location.search).has("tones")) {',
        to: 'if (new URLSearchParams(location.search).has("tones")) {',
      },
    ],
    expect: ["S-3"],
  },
  {
    id: "R21",
    why: "型の overload で opts ごと任意にする（opts を丸ごと渡し忘れても build が通る）",
    edits: [
      {
        file: KM,
        from: "down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods: ModFlags }): void;",
        to: "down(key: string, opts?: { repeat?: boolean; blocked?: boolean; mods: ModFlags }): void;",
      },
    ],
    expect: ["S-2"],
  },
  {
    id: "R22",
    why: "editor の mount: keydown / keyup の受け口より前に return を差し込む",
    edits: [{ file: ED, from: '    window.addEventListener("keydown", this.keydownHandler);\n', to: '    if (!this.cb) return;\n    window.addEventListener("keydown", this.keydownHandler);\n' }],
    expect: ["S-3"],
  },
  {
    id: "R23",
    why: "文字の入力欄: 打った文字を打ちかけへ入れない（input の受け口の中身）",
    edits: [{ file: ED, from: "          this.textDraft.text = ta.value;\n", to: "" }],
    expect: ["S-3"],
  },
  // ---- Codex 2 回目（e8629f8・自前の書き換え）のうち全ゲート緑だったもの（字面のまま）。W07 は R21 と同じ・W11 は赤だった ----
  {
    id: "R24",
    why: "Codex 2 回目 W01: 入力欄のブロックごと、打ちかけの間は組まない（`if (!this.textDraft) {`）",
    edits: [{ file: ED, from: "      {\n        const ta = $(\"#ed-textinput\") as HTMLTextAreaElement;", to: "      if (!this.textDraft) {\n        const ta = $(\"#ed-textinput\") as HTMLTextAreaElement;" }],
    expect: ["S-3"],
  },
  {
    id: "R25",
    why: "Codex 2 回目 W02: 波形のホイールの受け口を、呼ばれない関数の中へ移す",
    edits: [{ file: ED, from: "        cv.addEventListener(\n          \"wheel\",", to: "        void (() => cv.addEventListener(\n          \"wheel\"," }, { file: ED, from: "          { passive: false }\n        );\n      }\n      box.querySelector(\"#ap-apply\")", to: "          { passive: false }\n        ));\n      }\n      box.querySelector(\"#ap-apply\")" }],
    expect: ["S-3"],
  },
  {
    id: "R26",
    why: "Codex 2 回目 W03: editor の mount の keydown を、届かない switch の default へ移す",
    edits: [{ file: ED, from: "    window.addEventListener(\"keydown\", this.keydownHandler);", to: "    switch (0 as number) { case 0: break; default: window.addEventListener(\"keydown\", this.keydownHandler); }" }],
    expect: ["S-3"],
  },
  {
    id: "R27",
    why: "Codex 2 回目 W04: 入力欄: フォーカスの行き場が無い（activeElement ＝ body）ときは keydown を付ける前に return",
    edits: [{ file: ED, from: "        ta.addEventListener(\"keydown\", (e) => {", to: "        if (document.activeElement === document.body) return;\n        ta.addEventListener(\"keydown\", (e) => {" }],
    expect: ["S-3"],
  },
  {
    id: "R28",
    why: "Codex 2 回目 W05: 波形の localX を 100 で頭打ちに",
    edits: [{ file: ED, from: "return ((e.clientX - r.left) / r.width) * cv.width;", to: "return Math.min(100, ((e.clientX - r.left) / r.width) * cv.width);" }],
    expect: ["S-3"],
  },
  {
    id: "R29",
    why: "Codex 2 回目 W06: 波形の localX を let にして、あとから 0 を返す関数に差し替える",
    edits: [{ file: ED, from: "        const localX = (e: { clientX: number }) => {", to: "        let localX = (e: { clientX: number }) => {" }, { file: ED, from: "        const localY = (e: { clientY: number }) => {", to: "        localX = (_e: { clientX: number }) => 0;\n        const localY = (e: { clientY: number }) => {" }],
    expect: ["S-3"],
  },
  {
    id: "R30",
    why: "Codex 2 回目 W08: 型の overload の mods を `ModFlags | undefined` に（undefined を渡せる）",
    edits: [{ file: KM, from: "down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods: ModFlags }): void;", to: "down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods: ModFlags | undefined }): void;" }],
    expect: ["S-2"],
  },
  {
    id: "R31",
    why: "Codex 2 回目 W09: ホーム画面の keyup が門番（入力欄・ダイアログ・IME）を見ない",
    edits: [{ file: MA, from: "  if (!key || homeKeyBlocked(e)) return;", to: "  if (!key || (homeKeyBlocked(e) && e.type !== \"keyup\")) return;" }],
    expect: ["S-2"],
  },
  {
    id: "R32",
    why: "Codex 2 回目 W10: 入力欄の input が打ちかけを置き換えず、足していく",
    edits: [{ file: ED, from: "          this.textDraft.text = ta.value;", to: "          this.textDraft.text += ta.value;" }],
    expect: ["S-3"],
  },
  {
    id: "R33",
    why: "Codex 2 回目 W13: ホーム画面の IME の門番を「どちらか片方だけのとき」にする（本物の変換中＝両方立つと通る）",
    edits: [{ file: MA, from: "if (e.isComposing || e.keyCode === 229) return true;", to: "if (!!e.isComposing !== (e.keyCode === 229)) return true;" }],
    expect: ["S-2"],
  },
  {
    id: "R34",
    why: "文字の入力欄の IME の門番を「どちらか片方だけのとき」にする（W13 と同じ形を入力欄にも）",
    edits: [
      {
        file: ED,
        from: "if (e.isComposing || e.keyCode === 229) return; // IME 変換中は触らない",
        to: "if (!!e.isComposing !== (e.keyCode === 229)) return; // IME 変換中は触らない",
      },
    ],
    expect: ["S-3"],
  },
  {
    id: "R35",
    why: "editor の mount: ラベルつきの break で keydown の受け口を飛ばす（ラベルの文の中・条件の表には出ない形）",
    edits: [
      {
        file: ED,
        from: '    window.addEventListener("keydown", this.keydownHandler);\n',
        to: '    reg: {\n      if (!this.cb) break reg;\n      window.addEventListener("keydown", this.keydownHandler);\n    }\n',
      },
    ],
    expect: ["S-3"],
  },
  // ---- 第三者レビュー（Codex 3 回目の代わり・9e2e390・自前の書き換え）の書き換え（字面のまま）。T15 は安全な対照（下の SAFE）----
  {
    id: "R36",
    why: "第三者 T01: editor の mount: keydown / keyup の登録を名前付きブロックに入れ、'break wire'（ラベル付き break）で抜ける道を作る（document.hidden のとき＝裏で開いた作品ではキーが一切効かない）",
    edits: [{ file: ED, from: "    window.addEventListener(\"keydown\", this.keydownHandler);\n    window.addEventListener(\"keyup\", this.keyupHandler);\n", to: "    wire: {\n      if (document.hidden) break wire; // 裏で開いたときは付けない（表に出たときに付ける）\n      window.addEventListener(\"keydown\", this.keydownHandler);\n      window.addEventListener(\"keyup\", this.keyupHandler);\n    }\n" }],
    expect: ["S-3"],
  },
  {
    id: "R37",
    why: "第三者 T02: 起動時: ホーム画面の keydown の登録を、呼ばれないオブジェクトのメソッド（attach()）の中へ移す（Ctrl+, もホームのタップの候補も死ぬ）",
    edits: [{ file: MA, from: "  window.addEventListener(\"keydown\", homeKeyHandler);\n", to: "  void { attach() { window.addEventListener(\"keydown\", homeKeyHandler); } }; // 付け外しを 1 か所に（attach は後で呼ぶ）\n" }],
    expect: ["S-3"],
  },
  {
    id: "R38",
    why: "第三者 T03: 音声パネル: bind() の呼び出しを「音があるときだけ」にする（BGM の無い作品では読み込み・適用・取消・波形の受け口が 1 つも付かない）",
    edits: [{ file: ED, from: "      bind();\n      renderSeSection();\n", to: "      if (w.bytes) bind(); // 音が無いときは受け口は要らない\n      renderSeSection();\n" }],
    expect: ["S-3"],
  },
  {
    id: "R39",
    why: "第三者 T04: 波形の setZoom: 基準の時刻を置く位置を、新しい窓ではなく前の窓の幅で計算する（Ctrl＋ホイールの拡大でカーソルの下の時刻がずれる）",
    edits: [{ file: ED, from: "      if (anchorT != null && anchorFrac != null) viewStart = anchorT - anchorFrac * vd;\n", to: "      if (anchorT != null && anchorFrac != null) viewStart = anchorT - anchorFrac * prev.vd;\n" }],
    expect: ["S-3"],
  },
  {
    id: "R40",
    why: "第三者 T05: ホーム画面の候補の破棄（homeModTapCancel）を blur のときだけにする（Ctrl＋クリックのあと素早く離すとホームのタップが発動）",
    edits: [{ file: MA, from: "const homeModTapCancel = () => homeModTap.cancel();\n", to: "const homeModTapCancel = (e?: Event) => {\n  if (e?.type === \"blur\") homeModTap.cancel(); // クリックは組み合わせではない（ホームでは捨てない）\n};\n" }],
    expect: ["S-2"],
  },
  {
    id: "R41",
    why: "第三者 T06: 型: ModTapWatcher.down の overload の mods を 'ModFlags | null' に（実装と本文も合わせて tsc は通る）＝ null を渡せる",
    edits: [{ file: KM, from: "  down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods: ModFlags }): void;\n  down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods?: ModFlags } = {}): void {\n    // 修飾キー以外（＝組み合わせ）・押しっぱなしのリピート・同じキーの2度目・2つ目の修飾キー・止められている状態・\n    // ほかの修飾キーが押されている（V183）では候補にしない（立っていた候補も捨てる）。V181: Mac の ⌘ は Control\n    const k = tapCandidateOf(key, {\n      repeat: opts.repeat,\n      blocked: opts.blocked,\n      pending: this.cand !== null,\n      mods: opts.mods,\n", to: "  down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods: ModFlags | null }): void;\n  down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods?: ModFlags | null } = {}): void {\n    // 修飾キー以外（＝組み合わせ）・押しっぱなしのリピート・同じキーの2度目・2つ目の修飾キー・止められている状態・\n    // ほかの修飾キーが押されている（V183）では候補にしない（立っていた候補も捨てる）。V181: Mac の ⌘ は Control\n    const k = tapCandidateOf(key, {\n      repeat: opts.repeat,\n      blocked: opts.blocked,\n      pending: this.cand !== null,\n      mods: opts.mods ?? undefined,\n" }],
    expect: ["S-2"],
  },
  {
    id: "R42",
    why: "第三者 T07: 文字の入力欄: Backspace でも打ちかけを取り消す（1 文字消すつもりで文字が全部消える）",
    edits: [{ file: ED, from: "if (e.isComposing || e.keyCode === 229) return; // IME 変換中は触らない\n          if (e.code === \"Escape\") {\n", to: "if (e.isComposing || e.keyCode === 229) return; // IME 変換中は触らない\n          if (e.code === \"Escape\" || e.code === \"Backspace\") {\n" }],
    expect: ["S-3"],
  },
  {
    id: "R43",
    why: "第三者 T08: 文字の入力欄: 打った文字を trim してから打ちかけへ入れる（先頭・末尾の空白と改行が消える）",
    edits: [{ file: ED, from: "          this.textDraft.text = ta.value;\n", to: "          this.textDraft.text = ta.value.trim();\n" }],
    expect: ["S-3"],
  },
  {
    id: "R44",
    why: "第三者 T09: タップの押したときの門番: dialogOpen() を modalDepth > 0 のときだけにする（字面は残す。重い処理中・main.ts のモーダル中に押した修飾キーが候補になる）",
    edits: [{ file: ED, from: "        this.dialogOpen() ||\n        this.isTextEntry(e.target) ||\n", to: "        (this.dialogOpen() && this.modalDepth > 0) ||\n        this.isTextEntry(e.target) ||\n" }],
    expect: ["S-2"],
  },
  {
    id: "R45",
    why: "第三者 T10: 起動時: DEV の診断ページの条件に '|| import.meta.env.VITE_INPUTLOG === \"1\"' を足す（優先順位で診断ビルドでは本番でも抜け、ホームのキーの受け口が付かない）",
    edits: [{ file: MA, from: "if (import.meta.env.DEV && new URLSearchParams(location.search).has(\"tones\")) {", to: "if (import.meta.env.DEV && new URLSearchParams(location.search).has(\"tones\") || import.meta.env.VITE_INPUTLOG === \"1\") {" }],
    expect: ["S-3"],
  },
  {
    id: "R46",
    why: "第三者 T11: 「…」メニューを閉じるとき、自分の Esc の受け口ではなく editor の keydown の受け口を外す（写し間違い: 以後ショートカットもタップの候補も全部死ぬ）",
    edits: [{ file: ED, from: "      window.removeEventListener(\"pointerdown\", onDown, true);\n      window.removeEventListener(\"keydown\", onKey, true);\n      window.removeEventListener(\"resize\", onAway);\n", to: "      window.removeEventListener(\"pointerdown\", onDown, true);\n      window.removeEventListener(\"keydown\", this.keydownHandler);\n      window.removeEventListener(\"resize\", onAway);\n" }],
    expect: ["S-3"],
  },
  {
    id: "R47",
    why: "第三者 T12: 文字の入力欄: パネルを作り直すたびに、フォーカスの行き場があっても入力欄へ奪う（activeElement の条件を外す）",
    edits: [{ file: ED, from: "        if (drafting && document.activeElement === document.body) this.focusTextInput();\n", to: "        if (drafting) this.focusTextInput();\n" }],
    expect: ["S-3"],
  },
  {
    id: "R48",
    why: "第三者 T13: 波形の素のホイール: 横の量を優先する（斜めのトラックパッド操作で、縦の少しの揺れで向きが逆になる）",
    edits: [{ file: ED, from: "              viewStart = v0 + Math.sign(e.deltaY || e.deltaX) * vd * 0.1;\n", to: "              viewStart = v0 + Math.sign(e.deltaX || e.deltaY) * vd * 0.1;\n" }],
    expect: ["S-3"],
  },
  {
    id: "R49",
    why: "第三者 T14: ホーム画面の門番から「エディタ中は無視」を外す（エディタの中で Ctrl+, が設定を開き、ホームのタップも editor のタップと二重に動く）",
    edits: [{ file: MA, from: "function homeKeyBlocked(e: KeyboardEvent): boolean {\n  if (editorOpen) return true;\n", to: "function homeKeyBlocked(e: KeyboardEvent): boolean {\n" }],
    expect: ["S-2"],
  },
  {
    id: "R50",
    why: "第三者 T16: ModTapWatcher.down: 受け取ったイベントを写してから判定へ渡す（'{ ...opts.mods }'。本物の KeyboardEvent はフラグが prototype の getter なので写しでは全部落ちる）",
    edits: [{ file: KM, from: "      mods: opts.mods,\n    });\n", to: "      mods: opts.mods && { ...opts.mods }, // イベントそのものは持ち回らない（写しで渡す）\n    });\n" }],
    expect: ["S-1"],
  },
  {
    id: "R51",
    why: "第三者 T17: （検出の確認）Mac の ⌘ の keydown では shiftKey を「ほかの修飾キー」に数えない（⇧ を押したまま ⌘ をトンで発動）",
    edits: [{ file: KM, from: "    (key !== \"Shift\" && Boolean(f.shiftKey)) ||\n", to: "    (key !== \"Shift\" && key !== \"Meta\" && Boolean(f.shiftKey)) ||\n" }],
    expect: ["S-1"],
  },
  {
    id: "R17",
    why: "Codex Z13: 文字の入力欄のキーの受け口を、打ちかけの間は付けない",
    edits: [{ file: ED, from: 'ta.addEventListener("keydown", (e) => {', to: 'if (!this.textDraft) ta.addEventListener("keydown", (e) => {' }],
    expect: ["S-3"],
  },
];
/** ★安全な対照: 動きも約束も変えない書き換え。**当てても全部緑のまま**であること（検査が字面に寄りすぎて「壊していないのに赤」に
 *  ならないか）。Codex 2 回目の C02（型を別名へ）・第三者レビューの T15（捕まえる throw を前に置く）・自前の L01（何も囲まないラベルの break）。
 *  ⚠ Codex 2 回目の C01（登録を if (true) で囲む）は**赤のまま**＝囲む条件の表は字面で固定する設計（報告書 §6） */
const SAFE: { id: string; why: string; edits: Edit[] }[] = [
  {
    id: "C02",
    why: "Codex 2 回目 C02（安全な対照）: 必須の opts の型を別名へ移す（呼び出しの約束は同じ）",
    edits: [
      {
        file: KM,
        from: "  down(key: string, opts: { repeat?: boolean; blocked?: boolean; mods: ModFlags }): void;",
        to: "  down(key: string, opts: ReviewRequiredOpts): void;",
      },
      {
        file: KM,
        from: "export class ModTapWatcher {",
        to: "type ReviewRequiredOpts = { repeat?: boolean; blocked?: boolean; mods: ModFlags };\nexport class ModTapWatcher {",
      },
    ],
  },
  {
    id: "L01",
    why: "自前の安全な対照: editor の mount の受け口より前に、何も囲まないラベル付きブロックの break を置く（ブロックの直後へ戻るだけ＝受け口は必ず付く）",
    edits: [
      {
        file: ED,
        from: '    window.addEventListener("keydown", this.keydownHandler);\n',
        to: '    probe: {\n      if (!this.cb) break probe;\n    }\n    window.addEventListener("keydown", this.keydownHandler);\n',
      },
    ],
  },
  { id: "T15", why: "第三者 T15（安全な対照）: 【対照・安全】起動時: 受け口の前に try { if (!document.body) throw … } catch {} を置く（throw は必ず捕まえる＝受け口は必ず付く）", edits: [{ file: MA, from: "  window.addEventListener(\"keydown\", reloadGuardHandler, true);\n", to: "  try {\n    if (!document.body) throw new Error(\"no body\");\n  } catch {\n    /* 起動は続ける（受け口は付ける） */\n  }\n  window.addEventListener(\"keydown\", reloadGuardHandler, true);\n" }] },
];
const table: string[] = [];
if (!NO_MUTANTS) {
  for (const C of SAFE) {
    const { tree, why } = await mutant(C.edits);
    if (!tree) {
      check(`[S-C] ${C.id} ${C.why}`, false, why);
      continue;
    }
    const res = await runGroups(tree, ALL, { w: 5, c: 4 });
    const all = ALL.flatMap((g) => res[g]);
    const red = all.find((x) => !x.v.ok);
    check(`[S-C] ★安全な対照 ${C.id} を当てても全部緑（${C.why}）`, !red, red ? `${red.name.slice(0, 60)}: ${red.v.why.slice(0, 160)}` : "");
    table.push(`| ${C.id} | ${C.why.replace(/\|/g, "｜")} | ${red ? "赤（誤検出）" : "—（全部緑）"} | ${red ? `${red.name.slice(0, 50)}: ${red.v.why.slice(0, 120)}`.replace(/\|/g, "／") : `${ALL.join("・")} の ${all.length} 件がすべて緑`} |`);
  }
  const MUT = { w: 5, c: 4 }; // 反証は総当たりを 1 打鍵ずつ浅く（家族の比較と固定値で十分に効く・時間を抑える）
  for (const M of MUTATIONS) {
    const { tree, why } = await mutant(M.edits);
    if (!tree) {
      check(`[${M.id.startsWith("Y") ? "S-4" : "S-R"}] ${M.id} ${M.why}`, false, why);
      table.push(`| ${M.id} | ${M.why} | — | ${why} |`);
      continue;
    }
    const res = await runGroups(tree, M.expect, MUT);
    const firstRed = (g: Group) => res[g].find((x) => !x.v.ok && !x.v.threw);
    const reds = M.expect.map((g) => ({ g, x: firstRed(g) }));
    const effective = reds.every((z) => z.x);
    const detail = reds.map((z) => (z.x ? `${z.g}:「${z.x.name.slice(0, 50)}」${z.x.v.why.slice(0, 90)}` : `${z.g}: 赤にならない`)).join(" ／ ");
    check(`[${M.id.startsWith("Y") ? "S-4" : "S-R"}] ${M.id} ${M.why} → ${M.expect.join("・")} が赤`, effective, detail);
    table.push(`| ${M.id} | ${M.why.replace(/\|/g, "｜")} | ${reds.filter((z) => z.x).map((z) => z.g).join("・") || "—"} | ${detail.replace(/\|/g, "／").slice(0, 220)} |`);
  }
  if (process.env.V183_TABLE) console.log(["| # | 書き換え | 赤 | 理由（最初の赤） |", "|---|---|---|---|", ...table].join("\n"));
}
console.log(`v183 smoke: pass=${pass} fail=${fail}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
if (fail > 0) process.exit(1);
