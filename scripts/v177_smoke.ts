// V177（A-75: 保存で「同じ中身の塊」を 1 つにまとめる）の回帰ゲート。
//   npx tsx scripts/v177_smoke.ts               … 作りもの＋旧版の読み手（タグ v1.8.0 から取り出した本物）で全部
//   npx tsx scripts/v177_smoke.ts <ライブラリ>   … [S-1] を m3_smoke と同じ 41 作品（実データ・読むだけ）でも回す
//
// ★この回でいちばん怖いのは「1 コマに描いた線が、別のコマにも出る」こと。
//   読み手の一括の道（論理 32MiB 未満）は、同じ塊 idx を**同じ実体**にして返す（📌 を復元するため）。
//   その読み手は v1.6.0 / v1.7.0 / v1.8.0 に入っていて、もう直せない。だから中身でまとめてよいのは
//   **どの版でも遅延の道（コマごとに別の実体）で開く、論理 32MiB 以上の作品だけ**。
//   → 書き手の判定と読み手の判定がずれたら事故になる。[S-1]〜[S-3] がそこを縛る。
//   → 旧版の読み手は**タグから取り出した本物**で開いて確かめる（[S-9]・写しの SHA-256 を固定）。
//
// ★反証は「実ファイルを書き換えた写し」で走らせる（写しの中だけの反証は、検査が写しにしか効かない形を見逃す）。
//   src/editor と src/i18n を一時フォルダへ写し、pv6.ts だけ書き換えて**本物と同じ import の道**
//  （serialize.projectFromBytes → decodePv6）で読み込む。書き換えが当たらなかったときも赤にする。
//   禁止の言葉を並べる形（denylist）は使わない: 判定は**動かした結果**と、決めた形の**完全一致**だけ。
//
// [S-0]  反証の土台: 無改変の写しでは全部緑（写しの仕組みが赤を作っていない）
// [S-1]  論理 32MiB 未満の作品は、保存のバイト列がこの回の前（v1.8.0 の書き手）と完全に同じ（D-4）
//        ＋境界: 判定は `>= 32MiB` の 1 本（436 面は一括・まとめない／437 面は遅延・まとめる）
// [S-2]  書き手の論理サイズ＝読み手の logicalRaw（眠り・起きの混ざった文書でも・D-11）
// [S-3]  まとめの前後で logicalRaw が変わらない（D-12）
// [S-4]  論理 32MiB 以上の作りもので、同じ中身の塊が 1 つにまとまる／開き直すと全コマ 1 画素も違わない（D-2）
// [S-4b] 幅のズレ（p.indexBits が 8 のまま起きている Uint16Array がある）大きい作品も、まとめて開き直すと全画素一致
//        （独立レビュー 2 回目の指摘: V163 の幅の防御を外しても v177 単体では緑だった穴を塞ぐ）
// [S-5]  まとめたファイルは遅延の道で開く／同じ塊を指す 2 コマは別の実体で、片方に描いても他方は変わらない（D-3）
// [S-6]  一括の道で、📌 でない層が同じ塊を指していても別の実体（§1-3 の 12 コマ・D-5）
// [S-7]  📌 が普通の層と同じ実体にならない（普通の層を先に展開しても・D-13）
// [S-7b] 別々の 📌 が同じ中身でも別々の実体（書き手は 📌 の塊をまとめない／読み手は層ごとに配る）
// [S-8]  📌 はいまどおり全コマ同じ実体・共通の裁定が緑（D-6）
// [S-9]  旧版の読み手（v1.8.0 の pv6.ts）でまとめたファイルを開いても D-2・D-3 が緑（D-7）
// [S-10] 保存形式の版（6）・ヘッダのキー順・塊表の形（o,n,b,r,c）が変わらない
// [S-11] 保存の検証（verifyPV6 tier1.5）がまとめた結果で通る／塊 1 バイトの化けで落ちる（D-8）
// [S-12] 遅延の道（眠り控えを作るブロック）が v1.8.0 と 1 文字も違わない
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { newProject, PIXELS, type Project, type IndexBuf, type Frame } from "../src/editor/model";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}
type V = { ok: boolean; why: string };
const ok = (): V => ({ ok: true, why: "" });
const ng = (why: string): V => ({ ok: false, why });

const root = path.resolve(import.meta.dirname, "..");
const LIB = process.argv[2];

// ================= 写し（旧版・無改変・反証）の仕組み =================

/** v1.6.0 / v1.7.0 / v1.8.0 が積んで配った pv6.ts（3 本とも同一・2026-09-23 確認）。
 *  PV6 を読める配布物はこの 3 版だけ（v1.5.10 以前は PV5）。**旧版の読み手＝この 1 本** */
const OLD_TAG = "v1.8.0";
const SHIPPED_PV6_SHA256 = "34524cda35875b668cb11c513a65716e1ffc9b0dee3aa688c48530f8156a9453";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "v177-smoke-"));
process.on("exit", () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 片付けの失敗は検査の結果を変えない */
  }
});

const sha = (b: Uint8Array | string): string => crypto.createHash("sha256").update(b).digest("hex");

/** タグの src/editor と src/i18n を dest へ取り出す（リポジトリには何も書かない＝cat-file で読むだけ） */
function extractTag(tag: string, dest: string): number {
  const list = execFileSync("git", ["ls-tree", "-r", "--name-only", tag, "--", "src/editor", "src/i18n"], {
    cwd: root,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter((p) => p.endsWith(".ts"));
  if (list.length === 0) throw new Error(`${tag} に src/editor が無い`);
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: list.map((p) => `${tag}:${p}\n`).join(""),
    maxBuffer: 512 * 1024 * 1024,
  });
  let pos = 0;
  for (const p of list) {
    const nl = out.indexOf(0x0a, pos);
    const head = out.subarray(pos, nl).toString("utf8").split(" ");
    if (head[1] !== "blob") throw new Error(`git cat-file: ${p} が blob でない`);
    const size = Number(head[2]);
    const to = path.join(dest, p);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return list.length;
}

/** いまの作業ツリーの src（.ts だけ）を dest へ写す。
 *  V181: 以前は src/editor と src/i18n だけを写していたが、`i18n/index.ts` が `src/platform.ts` を読むようになり
 *  写しの中で `../platform` が見つからずに反証が全部落ちた。**写す範囲を決め打ちにすると、次に src 直下へ
 *  足した部品でまた落ちる**ので、src をまるごと写す（v180_smoke の copySrc と同じ・旧版の取り出しは変えない） */
function copyWorkTree(dest: string): void {
  fs.cpSync(path.join(root, "src"), path.join(dest, "src"), {
    recursive: true,
    filter: (s) => fs.statSync(s).isDirectory() || s.endsWith(".ts"),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = Record<string, any>;
interface Tree {
  label: string;
  pv6: Mod;
  ser: Mod;
  sleep: Mod;
}
async function loadTree(dir: string, label: string): Promise<Tree> {
  const u = (p: string) => pathToFileURL(path.join(dir, p)).href;
  const pv6 = await import(u("src/editor/pv6.ts"));
  const ser = await import(u("src/editor/serialize.ts"));
  const sleep = await import(u("src/editor/sleep.ts"));
  return { label, pv6, ser, sleep };
}

const REAL = await loadTree(root, "本物");
const curPv6 = fs.readFileSync(path.join(root, "src/editor/pv6.ts"), "utf8");

let OLD: Tree | null = null;
let oldPv6 = "";
{
  let why = "";
  try {
    extractTag(OLD_TAG, path.join(TMP, "old"));
    oldPv6 = fs.readFileSync(path.join(TMP, "old/src/editor/pv6.ts"), "utf8");
    if (sha(oldPv6) !== SHIPPED_PV6_SHA256) why = `取り出した pv6.ts の SHA-256 が配った版と違う（${sha(oldPv6).slice(0, 16)}）`;
    else OLD = await loadTree(path.join(TMP, "old"), OLD_TAG);
  } catch (e) {
    why = `タグ ${OLD_TAG} を取り出せない: ${String((e as Error).message ?? e).slice(0, 120)}`;
  }
  check(`[S-9] 旧版の読み手をタグ ${OLD_TAG} から取り出した（pv6.ts の SHA-256 が配った版と一致）`, OLD !== null, why);
}
copyWorkTree(path.join(TMP, "cur"));

let mutSeq = 0;
/** pv6.ts だけを書き換えた写しを作って読み込む。書き換えは**ちょうど 1 箇所**に当たること */
async function mutant(base: "cur" | "old", edits: [string, string][]): Promise<{ tree: Tree | null; why: string }> {
  let text = base === "cur" ? curPv6 : oldPv6;
  if (base === "old" && !OLD) return { tree: null, why: "旧版を取り出せていない" };
  for (const [from, to] of edits) {
    const n = text.split(from).length - 1;
    if (n !== 1) return { tree: null, why: `書き換えが当たらない（${n} 箇所）: ${from.trim().slice(0, 60)}` };
    text = text.replace(from, () => to);
  }
  const dir = path.join(TMP, `mut-${++mutSeq}`);
  fs.cpSync(path.join(TMP, base), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "src/editor/pv6.ts"), text);
  return { tree: await loadTree(dir, `mut-${mutSeq}`), why: "" };
}

// ================= 道具 =================

const gunzip = async (b: Uint8Array) =>
  new Uint8Array(
    await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
  );
async function headJsonOf(bytes: Uint8Array): Promise<string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(bytes.length - 8, true);
  return new TextDecoder().decode(await gunzip(bytes.subarray(0, headerLen)));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function docOf(bytes: Uint8Array): Promise<any> {
  return JSON.parse(await headJsonOf(bytes));
}
/** 検査側が**自分で**数える論理サイズ（参照を全部数える）。本物の関数が壊れても一緒に壊れない物差し */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function oracleRaw(doc: any): number {
  let s = 0;
  for (const f of doc.frames) for (const idx of Object.values(f.layers) as number[]) s += doc.blobs[idx].r;
  return s;
}

/** meta.modifiedAt は保存のたびに今の時刻になる。新旧のバイト列を比べるときは時計を止める */
const FIXED_MS = Date.UTC(2026, 8, 23, 12, 0, 0);
async function frozen<T>(fn: () => Promise<T>): Promise<T> {
  const Real = Date;
  class Fixed extends Real {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(FIXED_MS);
      else super(...(a as [number]));
    }
    static now(): number {
      return FIXED_MS;
    }
  }
  globalThis.Date = Fixed as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = Real;
  }
}

interface Enc {
  bytes: Uint8Array;
  stats: Record<string, number>;
}
async function enc(t: Tree, p: Project): Promise<Enc> {
  const r = await t.pv6.encodePV6(p);
  if (!r) throw new Error("encodePV6 が null を返した");
  return r as Enc;
}

/** 面ごとにはっきり違う絵（種で決まる）。値は 8bit なら 1..6、16bit なら 256 以上を混ぜる */
function pat(seed: number, bits: 8 | 16 = 8): IndexBuf {
  const b = bits === 16 ? new Uint16Array(PIXELS) : new Uint8Array(PIXELS);
  const stride = 41 + (seed % 17);
  for (let k = (seed * 13) % stride; k < PIXELS; k += stride) b[k] = bits === 16 ? 256 + ((k + seed) % 40) : ((k + seed) % 6) + 1;
  const row = (seed * 7) % 240;
  for (let x = 0; x < 320; x++) b[row * 320 + x] = bits === 16 ? 300 : 3;
  return b;
}
const blank = (bits: 8 | 16 = 8): IndexBuf => (bits === 16 ? new Uint16Array(PIXELS) : new Uint8Array(PIXELS));

let PAPER = 1;
function project(title: string, defs: { id: string; shared?: boolean }[]): Project {
  const p = newProject(title);
  PAPER = p.frames[0]?.paper ?? 1;
  p.layerDefs = defs.map((d) => ({
    id: d.id,
    name: d.id,
    visible: true,
    opacity: 1,
    ...(d.shared ? { shared: true as const } : {}),
  }));
  p.frames = [];
  return p;
}
type Truth = Record<string, IndexBuf>[];
function snapshot(p: Project): Truth {
  return p.frames.map((f) => Object.fromEntries(Object.entries(f.layers).map(([id, b]) => [id, b.slice()])));
}
function diffTruth(q: Project, truth: Truth): number {
  if (q.frames.length !== truth.length) return -1;
  let d = 0;
  for (let i = 0; i < truth.length; i++) {
    const ids = new Set([...Object.keys(truth[i]), ...Object.keys(q.frames[i].layers)]);
    for (const id of ids) {
      const a = truth[i][id];
      const b = q.frames[i].layers[id];
      if (!a || !b || a.length !== b.length) return -1;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) d++;
    }
  }
  return d;
}
async function wakeAll(t: Tree, q: Project): Promise<void> {
  for (const f of q.frames) await t.sleep.wakeFrame(q, f, "read");
}
/** 📌 以外の面の中身の種類数＋📌 の枚数（📌 は 1 枚につき塊 1 個）＝まとめたあとの塊の数の期待値 */
function expectedBlobs(truth: Truth, pins: Set<string>): number {
  const seen = new Set<string>();
  for (const fr of truth)
    for (const [id, b] of Object.entries(fr))
      if (!pins.has(id)) seen.add(sha(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
  return seen.size + pins.size;
}

// ================= 作りもの =================

/** BIG: 150 コマ × 5 層＝750 面（論理 57.6MB ≥ 32MiB）。
 *  - P1 / P3（📌）: **同じ中身・別の実体**。P2（📌）: 空＝ L2 と同じ中身
 *  - L1: 3 コマずつ同じ絵（別の実体＝コマの複製と同じ形）・L2: 全コマ空（別の実体）
 *  - コマ 76〜149 の L1/L2 は眠り控え（📌 は起きたまま＝エディタと同じ）。
 *    グループ 25（コマ 75・76・77）は起きている面と眠っている面が**同じ中身**＝両方の形をまたいでまとまるか */
const BIG_FRAMES = 150;
const BIG_PINS = new Set(["P1", "P2", "P3"]);
async function buildBig(): Promise<{ p: Project; truth: Truth }> {
  const p = project("V177-big", [
    { id: "P1", shared: true },
    { id: "L1" },
    { id: "L2" },
    { id: "P2", shared: true },
    { id: "P3", shared: true },
  ]);
  const P1 = pat(1);
  const P2 = blank();
  const P3 = pat(1);
  for (let f = 0; f < BIG_FRAMES; f++) {
    p.frames.push({ paper: PAPER, layers: { P1, L1: pat(100 + Math.floor(f / 3)), L2: blank(), P2, P3 } });
  }
  const truth = snapshot(p);
  for (let f = 76; f < BIG_FRAMES; f++) await REAL.sleep.sleepFrame(p, p.frames[f], BIG_PINS);
  return { p, truth };
}

/** SMALL-DUP: 24 コマ × 3 層（📌 あり・3 コマずつ同じ絵・空の層・眠り混在・音・order/se/layerColors） */
async function buildSmallDup(): Promise<Project> {
  const p = project("V177-small", [{ id: "P", shared: true }, { id: "L1" }, { id: "L2" }]);
  const P = pat(7);
  for (let f = 0; f < 24; f++) p.frames.push({ paper: PAPER, layers: { P, L1: pat(200 + Math.floor(f / 3)), L2: blank() } });
  p.frames[2].order = ["L2", "P", "L1"];
  p.frames[3].se = ["S1"];
  p.frames[4].layerColors = { L1: "#ff0000" };
  p.frames[5].paper = PAPER + 1;
  p.speedIndex = 4;
  p.loop = false;
  p.thumbFrame = 5;
  const audio = new Uint8Array(800).map((_, i) => (i * 31) & 0xff);
  p.audio = {
    bgm: {
      source: "external",
      mime: "audio/mpeg",
      data: audio,
      muted: false,
      volume: 0.8,
      trimStartMs: 10,
      trimEndMs: 700,
      syncMode: "animToAudio",
      baseSpeedIndex: 4,
      name: "b",
    },
    se: [{ id: "S1", name: "s", source: "external", mime: "audio/wav", data: audio.slice(0, 64), volume: 1, muted: false }],
  };
  p.nextSeId = 2;
  for (let f = 12; f < 24; f++) await REAL.sleep.sleepFrame(p, p.frames[f], new Set(["P"]));
  return p;
}

/** SMALL-16: 16bit の作品（256 を超える索引・眠り控えも 16bit） */
async function buildSmall16(): Promise<Project> {
  const p = project("V177-16", [{ id: "L1" }, { id: "L2" }]);
  p.indexBits = 16;
  for (let c = 0; c < 300; c++) p.colorTable.push(`#${((c * 40503 + 123457) & 0xffffff).toString(16).padStart(6, "0")}`);
  for (let f = 0; f < 12; f++) p.frames.push({ paper: PAPER, layers: { L1: pat(300 + Math.floor(f / 2), 16), L2: blank(16) } });
  for (let f = 6; f < 12; f++) await REAL.sleep.sleepFrame(p, p.frames[f]);
  return p;
}

/** ALIAS-12（§1-3 の反証ファイル）: 12 コマ × 1 層。3 コマずつ**同じ実体**を指す＝どの書き手でも
 *  塊 4 個・参照 12 の「📌 でない層が同じ塊を指す」ファイルになる（論理 0.9MB＝一括の道） */
function buildAlias12(): Project {
  const p = project("V177-alias12", [{ id: "L1" }]);
  const g = [pat(401), pat(402), pat(403), pat(404)];
  for (let f = 0; f < 12; f++) p.frames.push({ paper: PAPER, layers: { L1: g[Math.floor(f / 3)] } });
  return p;
}
/** CONTENT-12: 12 コマ × 1 層。3 コマずつ**同じ中身・別の実体**（コマの複製の形）。
 *  §1-3 の「中身でまとめる書き手で書いて開く」は、しきい値を外した写しでこれを書く */
function buildContent12(): Project {
  const p = project("V177-content12", [{ id: "L1" }]);
  for (let f = 0; f < 12; f++) p.frames.push({ paper: PAPER, layers: { L1: pat(401 + Math.floor(f / 3)) } });
  return p;
}
/** ALIAS-PIN: 普通の層 L が**先**（layerDefs 順）・📌 P が後。コマ 0 の L と全コマの P が同じ塊を指す */
function buildAliasPin(): Project {
  const p = project("V177-aliaspin", [{ id: "L" }, { id: "P", shared: true }]);
  const X = pat(501);
  p.frames.push({ paper: PAPER, layers: { L: X, P: X } });
  p.frames.push({ paper: PAPER, layers: { L: pat(502), P: X } });
  p.frames.push({ paper: PAPER, layers: { L: pat(503), P: X } });
  return p;
}
/** PIN-PIN: 別々の 📌 が 2 枚、同じ塊を指す（手で作ったファイル・中身でまとめた書き手の形） */
function buildPinPin(): Project {
  const p = project("V177-pinpin", [{ id: "P1", shared: true }, { id: "P2", shared: true }]);
  const X = pat(601);
  for (let f = 0; f < 3; f++) p.frames.push({ paper: PAPER, layers: { P1: X, P2: X } });
  return p;
}
/** 境界: 436 面（33,484,800 B＜32MiB）と 437 面（33,561,600 B≥32MiB）。L1 は 2 コマずつ同じ絵・L2 は空 */
function buildBoundary(planes: 436 | 437): Project {
  const p = project(`V177-b${planes}`, [{ id: "L1" }, { id: "L2" }]);
  for (let f = 0; f < 218; f++) p.frames.push({ paper: PAPER, layers: { L1: pat(700 + Math.floor(f / 2)), L2: blank() } });
  if (planes === 437) p.frames.push({ paper: PAPER, layers: { L1: pat(700) } });
  return p;
}

/** ZURE: 幅のズレ（`p.indexBits` が 8 のまま、起きている Uint16Array がある）大きい作品。
 *  150 コマ × 3 層＝450 面（論理 34.56MB ≥ 32MiB）。W1 はコマ 0〜9 が 16bit（2 コマずつ同じ中身・256 超の値）、
 *  ほかは 8bit。コマ 76〜149 は眠り控え（そこは 8bit の面だけ＝ズレた 16bit を眠らせない）。
 *  書き手の防御（16bit の実体が 1 枚でもあればヘッダは indexBits:16）が効いていないと、開くと壊れる */
async function buildZure(): Promise<{ p: Project; truth: Truth }> {
  const p = project("V177-zure", [{ id: "L1" }, { id: "L2" }, { id: "W1" }]);
  for (let c = 0; c < 300; c++) p.colorTable.push(`#${((c * 40503 + 7) & 0xffffff).toString(16).padStart(6, "0")}`);
  for (let f = 0; f < 150; f++) {
    const W1 = f < 10 ? pat(900 + Math.floor(f / 2), 16) : pat(950 + Math.floor(f / 5));
    p.frames.push({ paper: PAPER, layers: { L1: pat(800 + Math.floor(f / 3)), L2: blank(), W1 } });
  }
  const truth = snapshot(p);
  for (let f = 76; f < 150; f++) await REAL.sleep.sleepFrame(p, p.frames[f]);
  return { p, truth };
}

const big = await buildBig();
const zure = await buildZure();
const smallDup = await buildSmallDup();
const small16 = await buildSmall16();
const alias12 = buildAlias12();
const content12 = buildContent12();
const aliasPin = buildAliasPin();
const pinPin = buildPinPin();
const b436 = buildBoundary(436);
const b437 = buildBoundary(437);
const SMALLS: [string, Project][] = [
  ["SMALL-DUP", smallDup],
  ["SMALL-16", small16],
  ["ALIAS-12", alias12],
  ["CONTENT-12", content12],
  ["ALIAS-PIN", aliasPin],
  ["PIN-PIN", pinPin],
  ["B436", b436],
];

// 作りものの前提（ここが崩れると以降の検査が空振りする）
{
  const nonPin = new Set<string>();
  for (const fr of big.truth) for (const id of ["L1", "L2"]) nonPin.add(sha(new Uint8Array(fr[id].buffer)));
  check("[前提] BIG の 📌 でない面は中身 51 種（L1 が 50・空が 1）", nonPin.size === 51, `${nonPin.size}`);
  check("[前提] BIG は眠りと起きが混ざっている", big.p.frames[75].layers.L1 !== undefined && !!big.p.frames[76].sleep?.L1 && !big.p.frames[76].layers.L1);
  check("[前提] BIG は論理 32MiB 以上・B436 は未満・B437 は以上", 750 * PIXELS >= 32 * 1024 * 1024 && 436 * PIXELS < 32 * 1024 * 1024 && 437 * PIXELS >= 32 * 1024 * 1024);
}

// ================= 検査の本体（木を引数に取る＝本物・旧版・写しで同じ関数を回す） =================

/** [S-1] 小さい作品は v1.8.0 の書き手とバイト列が完全に同じ／B437 はまとまる */
async function s1Writer(t: Tree): Promise<V> {
  if (!OLD) return ng("旧版が無い");
  for (const [name, p] of SMALLS) {
    const a = await frozen(() => enc(OLD!, p));
    const b = await frozen(() => enc(t, p));
    if (sha(a.bytes) !== sha(b.bytes))
      return ng(`${name}: 旧と違うバイト列（${a.bytes.length} → ${b.bytes.length} B・塊 ${a.stats.blobCount} → ${b.stats.blobCount}）`);
  }
  const a = await enc(OLD, b437);
  const b = await enc(t, b437);
  if (!(b.stats.blobCount < a.stats.blobCount)) return ng(`B437（32MiB 以上）がまとまらない（塊 ${a.stats.blobCount} → ${b.stats.blobCount}）`);
  return ok();
}
/** [S-1] 境界の判定は `>= 32MiB` の 1 本（値を関数に直接当てる＝面の大きさでは作れない境界ちょうども見る） */
function s1Boundary(t: Tree): V {
  const f = t.pv6.pv6OpensLazily;
  const T = 32 * 1024 * 1024;
  if (typeof f !== "function") return ng("pv6OpensLazily が無い（書き手と読み手が同じ判定を呼ぶ形になっていない）");
  if (t.pv6.PV6_EAGER_MAX_RAW !== T) return ng(`PV6_EAGER_MAX_RAW=${t.pv6.PV6_EAGER_MAX_RAW}（32MiB から変わった）`);
  if (f(T) !== true) return ng("境界ちょうど（32MiB）で遅延と言わない（> と >= の取り違え）");
  if (f(T - 1) !== false) return ng("32MiB 未満で遅延と言う");
  if (f(436 * PIXELS) !== false || f(437 * PIXELS) !== true) return ng("436 面／437 面の判定が違う");
  return ok();
}

/** [S-2] 書き手の論理サイズ＝読み手の logicalRaw＝検査側の物差し。読み手の遅延の判定も書き手の判定と同じ */
async function s2(t: Tree, p: Project): Promise<V> {
  const r = await enc(t, p);
  const w = r.stats.logicalRaw;
  if (typeof w !== "number") return ng("書き手が論理サイズ（stats.logicalRaw）を出していない");
  const d = await t.pv6.decodePv6(r.bytes);
  const o = oracleRaw(await docOf(r.bytes));
  if (typeof d.logicalRaw !== "number") return ng("読み手が logicalRaw を返していない");
  if (w !== d.logicalRaw || w !== o) return ng(`書き手 ${w} ／ 読み手 ${d.logicalRaw} ／ 物差し ${o}`);
  if (d.lazy !== (w >= 32 * 1024 * 1024)) return ng(`読み手の遅延 ${d.lazy} が論理サイズ ${w} と合わない`);
  return ok();
}
/** [S-3] まとめた（t）とまとめない（旧の書き手）で logicalRaw が同じ */
async function s3(t: Tree, p: Project): Promise<V> {
  if (!OLD) return ng("旧版が無い");
  const a = await enc(OLD, p);
  const b = await enc(t, p);
  if (!(b.stats.blobCount < a.stats.blobCount)) return ng(`前提: まとまっていない（塊 ${a.stats.blobCount} → ${b.stats.blobCount}）`);
  const oa = oracleRaw(await docOf(a.bytes));
  const ob = oracleRaw(await docOf(b.bytes));
  const da = (await REAL.pv6.decodePv6(a.bytes)).logicalRaw;
  const db = (await REAL.pv6.decodePv6(b.bytes)).logicalRaw;
  if (oa !== ob || da !== db || oa !== da) return ng(`まとめる前 ${oa}（読み手 ${da}）／後 ${ob}（読み手 ${db}）`);
  return ok();
}
/** [S-4] BIG が期待どおりの塊数にまとまり、開き直すと全コマ 1 画素も違わない */
async function s4(t: Tree): Promise<V & { before?: number; after?: number }> {
  if (!OLD) return ng("旧版が無い");
  const a = await enc(OLD, big.p);
  const b = await enc(t, big.p);
  const want = expectedBlobs(big.truth, BIG_PINS);
  const res = { before: a.stats.blobCount, after: b.stats.blobCount };
  if (b.stats.blobCount !== want) return { ...ng(`塊 ${a.stats.blobCount} → ${b.stats.blobCount}（期待 ${want}）`), ...res };
  if (b.stats.refCount !== a.stats.refCount) return { ...ng(`参照数が変わった ${a.stats.refCount} → ${b.stats.refCount}`), ...res };
  const q = await REAL.ser.projectFromBytes(b.bytes);
  await wakeAll(REAL, q);
  const d = diffTruth(q, big.truth);
  if (d !== 0) return { ...ng(`開き直すと画素差 ${d}`), ...res };
  return { ...ok(), ...res };
}

/** [S-4b] ZURE をまとめて書き、新旧の読み手で開き直して全画素一致（ヘッダは indexBits:16・256 超の値が残る） */
async function s4b(t: Tree): Promise<V> {
  let r: Enc;
  try {
    r = await enc(t, zure.p);
  } catch (e) {
    return ng(`書けない: ${String((e as Error).message ?? e).slice(0, 60)}`);
  }
  if (!(await headJsonOf(r.bytes)).includes('"indexBits":16')) return ng("ヘッダが indexBits:16 になっていない（16bit の実体があるのに）");
  if (!(r.stats.contentMerged > 0)) return ng(`前提: まとまっていない（contentMerged=${r.stats.contentMerged}）`);
  for (const rd of [REAL, OLD]) {
    if (!rd) return ng("旧版が無い");
    let q: Project;
    try {
      q = await rd.ser.projectFromBytes(r.bytes);
    } catch (e) {
      return ng(`${rd.label} の読み手で開けない: ${String((e as Error).message ?? e).slice(0, 60)}`);
    }
    await wakeAll(rd, q);
    const d = diffTruth(q, zure.truth);
    if (d !== 0) return ng(`${rd.label} の読み手で画素差 ${d}`);
    const k = zure.truth[0].W1.findIndex((v) => v >= 256); // 作りものに 256 を超える値が入っていること（前提）
    if (k < 0 || q.frames[0].layers.W1[k] !== zure.truth[0].W1[k]) return ng("256 を超える値が残っていない");
  }
  return ok();
}

interface S5 extends V {
  lazyOk: boolean;
  sameInstance: boolean;
  contaminated: boolean;
}
/** [S-5] まとめた BIG を読み手 t で開く: 遅延の道／同じ塊を指すコマ 30・31・32 が別の実体で、描いても伝染しない */
async function s5(t: Tree, bytes: Uint8Array): Promise<S5> {
  const r: S5 = { ok: false, why: "", lazyOk: false, sameInstance: false, contaminated: false };
  const doc = await docOf(bytes);
  const idx = [30, 31, 32].map((i) => doc.frames[i].layers.L1);
  if (!(idx[0] === idx[1] && idx[1] === idx[2])) {
    r.why = "前提: コマ 30・31・32 の L1 が同じ塊を指していない（まとまっていない）";
    return r;
  }
  const q = await t.ser.projectFromBytes(bytes);
  const refs = q.frames.length * 2; // L1・L2（📌 以外）
  const asleep = t.sleep.asleepCount(q);
  r.lazyOk = asleep >= refs * 0.9 && t.sleep.isAsleep(q.frames[30], "L1") && t.sleep.isAsleep(q.frames[31], "L1");
  const a = await t.sleep.wakeLayer(q, q.frames[30], "L1", "write");
  const b = await t.sleep.wakeLayer(q, q.frames[31], "L1", "write");
  r.sameInstance = a === b;
  const k = 4000;
  const want31 = big.truth[31].L1[k];
  a[k] = want31 === 5 ? 6 : 5; // コマ 30 に描く
  const c = await t.sleep.wakeLayer(q, q.frames[32], "L1", "read");
  r.contaminated = b[k] !== want31 || c[k] !== big.truth[32].L1[k];
  r.ok = r.lazyOk && !r.sameInstance && !r.contaminated;
  r.why = `遅延=${r.lazyOk}（眠り ${asleep}/${refs}） 同じ実体=${r.sameInstance} 伝染=${r.contaminated}`;
  return r;
}
/** [S-6] 12 コマの反証ファイルを読み手 t で開く（一括の道）: 実体 12・伝染しない */
async function s6(t: Tree, bytes: Uint8Array): Promise<V & { instances: number; contaminated: boolean }> {
  const q = await t.ser.projectFromBytes(bytes);
  const instances = new Set(q.frames.map((f: Frame) => f.layers.L1)).size;
  const lazy = t.sleep.asleepCount(q) > 0;
  const k = 2024;
  const before = q.frames[1].layers.L1[k];
  q.frames[0].layers.L1[k] = before === 5 ? 6 : 5; // 0 コマ目に描く
  const contaminated = q.frames[1].layers.L1[k] !== before;
  return { ok: !lazy && instances === 12 && !contaminated, why: `実体 ${instances}・伝染=${contaminated}・遅延=${lazy}`, instances, contaminated };
}
/** [S-7] ALIAS-PIN を読み手 t で開く: 📌 P が普通の層 L（先に展開される）と同じ実体にならない */
async function s7(t: Tree, bytes: Uint8Array): Promise<V> {
  const q = await t.ser.projectFromBytes(bytes);
  const L0 = q.frames[0].layers.L;
  const P0 = q.frames[0].layers.P;
  if (!L0 || !P0) return ng("層が無い");
  if (L0 === P0) return ng("📌 が普通の層と同じ実体（コマ 0 の L === P）");
  if (!q.frames.every((f: Frame) => f.layers.P === P0)) return ng("📌 が全コマ同じ実体になっていない");
  const k = 3030;
  const pv = P0[k];
  L0[k] = pv === 3 ? 4 : 3; // 普通の層に描く
  if (P0[k] !== pv) return ng("普通の層に描いた線が 📌 に出た");
  return ok();
}
/** [S-7b] PIN-PIN: 別々の 📌 は、同じ塊を指していても別々の実体（それぞれは全コマ同じ実体） */
async function s7b(t: Tree, bytes: Uint8Array): Promise<V> {
  const q = await t.ser.projectFromBytes(bytes);
  const A = q.frames[0].layers.P1;
  const B = q.frames[0].layers.P2;
  if (!A || !B) return ng("層が無い");
  if (A === B) return ng("別々の 📌 が同じ実体");
  if (!q.frames.every((f: Frame) => f.layers.P1 === A && f.layers.P2 === B)) return ng("📌 が全コマ同じ実体になっていない");
  const k = 555;
  const bv = B[k];
  A[k] = bv === 2 ? 4 : 2;
  if (B[k] !== bv) return ng("P1 に描いた線が P2 に出た");
  return ok();
}
/** [S-7b] まとめた BIG を読み手 t で開く: 同じ中身の 📌（P1・P3）と空の 📌（P2）が、それぞれ自分だけの実体 */
async function s7bBig(t: Tree, bytes: Uint8Array): Promise<V> {
  const q = await t.ser.projectFromBytes(bytes);
  const [P1, P2, P3] = ["P1", "P2", "P3"].map((id) => q.frames[0].layers[id]);
  if (!P1 || !P2 || !P3) return ng("📌 が起きていない");
  if (P1 === P3 || P1 === P2 || P2 === P3) return ng(`別々の 📌 が同じ実体（P1===P3:${P1 === P3} P2===P1:${P1 === P2}）`);
  const k = 7777;
  const v3 = P3[k];
  P1[k] = v3 === 4 ? 5 : 4;
  if (P3[k] !== v3) return ng("P1 に描いた線が P3 に出た");
  return ok();
}
/** [S-8] 📌 は全コマ同じ実体・shared が残る・共通の裁定が衝突と言わない */
async function s8(t: Tree, bytes: Uint8Array, pins: string[]): Promise<V> {
  const q = await t.ser.projectFromBytes(bytes);
  if ((q as { __sharedConflict?: boolean }).__sharedConflict) return ng("共通の裁定が衝突と判断した");
  for (const id of pins) {
    const ld = q.layerDefs.find((l: { id: string }) => l.id === id);
    if (!ld || ld.shared !== true) return ng(`${id} の shared が落ちた`);
    const base = q.frames[0].layers[id];
    if (!base) return ng(`${id} が起きていない`);
    if (!q.frames.every((f: Frame) => f.layers[id] === base)) return ng(`${id} が全コマ同じ実体でない`);
  }
  return ok();
}
/** [S-10] 版 6・キー順・塊表の形（o,n,b,r,c・o が先頭から連続）・トレーラ */
async function s10(t: Tree, p: Project): Promise<V> {
  let r: Enc;
  try {
    r = await enc(t, p);
  } catch (e) {
    return ng(`書けない: ${String((e as Error).message ?? e).slice(0, 60)}`);
  }
  const hj = await headJsonOf(r.bytes);
  if (!hj.startsWith('{"magic":"ANIMEMO","version":6,"width":320,"height":240,')) return ng("ヘッダの先頭が違う");
  const fr = hj.indexOf('"frames":[');
  const bl = hj.indexOf('"blobs":[');
  if (fr < 0 || bl < fr) return ng("blobs が frames の後ろに無い");
  try {
    REAL.pv6.assertPv6HeaderOrder(hj);
  } catch {
    return ng("assertPv6HeaderOrder が赤");
  }
  const doc = JSON.parse(hj);
  if (doc.version !== 6) return ng(`version=${doc.version}`);
  let o = 0;
  for (let i = 0; i < doc.blobs.length; i++) {
    const m = doc.blobs[i];
    if (Object.keys(m).join(",") !== "o,n,b,r,c") return ng(`塊表 ${i} の形が違う: ${Object.keys(m).join(",")}`);
    if (m.o !== o) return ng(`塊表 ${i} の o が連続していない`);
    o += m.n;
  }
  const tail = new TextDecoder().decode(r.bytes.subarray(r.bytes.length - 16, r.bytes.length - 8));
  if (tail !== "AMPV6END") return ng("トレーラの magic が違う");
  return ok();
}
/** [S-11] 検証がまとめた結果で通る／いちばん多く参照される塊を 1 バイト化けさせると tier1.5 で落ちる */
async function s11(bytes: Uint8Array, frames: number): Promise<V> {
  for (const tier of [1, 1.5, 2] as const) {
    const v = await REAL.pv6.verifyPV6(bytes, frames, tier);
    if (!v.ok) return ng(`tier${tier}: ${v.reason}`);
  }
  if (!(await REAL.ser.verifySavedBytes(bytes, frames)).ok) return ng("verifySavedBytes が赤");
  const doc = await docOf(bytes);
  const refs = new Map<number, number>();
  for (const f of doc.frames) for (const idx of Object.values(f.layers) as number[]) refs.set(idx, (refs.get(idx) ?? 0) + 1);
  const [top] = [...refs.entries()].sort((x, y) => y[1] - x[1])[0];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(bytes.length - 8, true);
  const m = doc.blobs[top];
  const bad = bytes.slice();
  bad[headerLen + m.o + (m.n >> 1)] ^= 0x01;
  if ((await REAL.pv6.verifyPV6(bad, frames, 1.5)).ok) return ng("化けた塊を tier1.5 が通した");
  return ok();
}
/** [S-12] 遅延の道（眠り控えを作るブロック）の文字列 */
function lazyBlock(src: string): string {
  const start = src.indexOf("      if (lazy && !sharedIds.has(id)) {");
  const end = start < 0 ? -1 : src.indexOf("      } else", start);
  return start >= 0 && end > start ? src.slice(start, end) : "";
}

// ================= 書く（本物の書き手） =================

const bigNew = await enc(REAL, big.p);
const smallNew = await enc(REAL, smallDup);
const alias12Bytes = (await enc(REAL, alias12)).bytes;
const aliasPinBytes = (await enc(REAL, aliasPin)).bytes;
const pinPinBytes = (await enc(REAL, pinPin)).bytes;
const bigMerged = bigNew.stats.blobCount < 3 + 2 * BIG_FRAMES;

// ================= [S-1] =================
{
  const w = await s1Writer(REAL);
  check("[S-1] ★論理 32MiB 未満の 7 作品は保存のバイト列が v1.8.0 の書き手と完全に同じ／B437 はまとまる", w.ok, w.why);
  const b = s1Boundary(REAL);
  check("[S-1] ★まとめる判定は `>= 32MiB` の 1 本（境界ちょうど・436 面・437 面）", b.ok, b.why);
  // 読み手の側の境界（旧版・本物とも）: 436 面は一括、437 面は遅延で開く＝書き手がまとめ始める所と同じ
  const f436 = (await enc(REAL, b436)).bytes;
  const f437 = (await enc(REAL, b437)).bytes;
  for (const t of [REAL, OLD]) {
    if (!t) continue;
    const q436 = await t.ser.projectFromBytes(f436);
    const q437 = await t.ser.projectFromBytes(f437);
    check(
      `[S-1] ${t.label} の読み手: 436 面は一括・437 面は遅延で開く（書き手の境界と同じ所）`,
      t.sleep.asleepCount(q436) === 0 && t.sleep.asleepCount(q437) > 0,
      `436 面の眠り ${t.sleep.asleepCount(q436)}・437 面の眠り ${t.sleep.asleepCount(q437)}`
    );
  }
}

// ================= [S-2] [S-3] =================
{
  for (const [name, p] of [["BIG（眠り・起き混在）", big.p], ["SMALL-DUP（眠り・起き混在）", smallDup], ["SMALL-16", small16], ["B437", b437]] as const) {
    const v = await s2(REAL, p);
    check(`[S-2] ★書き手の論理サイズ＝読み手の logicalRaw（${name}）`, v.ok, v.why);
  }
  const v3 = await s3(REAL, big.p);
  check("[S-3] ★まとめの前後で logicalRaw が変わらない（BIG）", v3.ok, v3.why);
  const v3b = await s3(REAL, b437);
  check("[S-3] まとめの前後で logicalRaw が変わらない（B437）", v3b.ok, v3b.why);
}

// ================= [S-4] =================
const v4 = await s4(REAL);
check("[S-4] ★BIG の同じ中身の塊が 1 つにまとまり、開き直すと全コマ 1 画素も違わない", v4.ok, v4.why);
const v4b = await s4b(REAL);
check("[S-4b] ★幅のズレ（indexBits 8 のまま起きている 16bit）がある大きい作品も、まとめて新旧の読み手で開き直すと全画素一致", v4b.ok, v4b.why);

// ================= [S-5] [S-9] =================
{
  const v5 = await s5(REAL, bigNew.bytes);
  check("[S-5] ★まとめたファイルは遅延の道で開く／同じ塊の 2 コマは別の実体・描いても伝染しない", v5.ok, v5.why);
  if (OLD) {
    check("[S-9] 前提: 旧版に渡すファイルは**まとまっている**", bigMerged, `塊 ${bigNew.stats.blobCount}`);
    const v9 = await s5(OLD, bigNew.bytes);
    check("[S-9] ★旧版（v1.8.0）の読み手でも遅延の道・別の実体・伝染しない（D-3）", v9.ok, v9.why);
    const q = await OLD.ser.projectFromBytes(bigNew.bytes);
    await wakeAll(OLD, q);
    const d = diffTruth(q, big.truth);
    check("[S-9] ★旧版（v1.8.0）の読み手で全コマ 1 画素も違わない（D-2）", d === 0, `画素差 ${d}`);
    const v9b = await s7bBig(OLD, bigNew.bytes);
    check("[S-9] ★旧版（v1.8.0）の読み手でも、同じ中身の 📌 どうしが別の実体（書き手が 📌 の塊をまとめていない）", v9b.ok, v9b.why);
  }
}

// ================= [S-6] [S-7] [S-7b] [S-8] =================
{
  const v6 = await s6(REAL, alias12Bytes);
  check("[S-6] ★一括の道で、📌 でない層が同じ塊を指しても別の実体（12 コマ→実体 12・伝染しない）", v6.ok, v6.why);
  if (OLD) {
    const c6 = await s6(OLD, alias12Bytes);
    check("[S-6] 対照: このファイルを旧版の読み手で開くと実体 4・伝染する（反証ファイルが本物）", c6.instances === 4 && c6.contaminated, c6.why);
  }
  const v7 = await s7(REAL, aliasPinBytes);
  check("[S-7] ★📌 が普通の層と同じ実体にならない（普通の層を先に展開しても）", v7.ok, v7.why);
  const v7b = await s7b(REAL, pinPinBytes);
  check("[S-7b] ★別々の 📌 が同じ塊を指しても、それぞれ自分だけの実体", v7b.ok, v7b.why);
  const v7c = await s7bBig(REAL, bigNew.bytes);
  check("[S-7b] まとめた BIG でも、同じ中身の 📌（P1・P3）と空の 📌（P2）は別々の実体", v7c.ok, v7c.why);
  const v8a = await s8(REAL, bigNew.bytes, [...BIG_PINS]);
  check("[S-8] ★📌 は全コマ同じ実体・共通の裁定が緑（BIG・遅延の道）", v8a.ok, v8a.why);
  const v8b = await s8(REAL, smallNew.bytes, ["P"]);
  check("[S-8] ★📌 は全コマ同じ実体・共通の裁定が緑（SMALL-DUP・一括の道）", v8b.ok, v8b.why);
  const v8c = await s8(REAL, aliasPinBytes, ["P"]);
  check("[S-8] 📌 は全コマ同じ実体（ALIAS-PIN）", v8c.ok, v8c.why);
}

// ================= [S-10] [S-11] [S-12] =================
{
  const v10a = await s10(REAL, big.p);
  check("[S-10] ★まとめた保存も版 6・キー順・塊表の形（o,n,b,r,c）が同じ", v10a.ok, v10a.why);
  const v10b = await s10(REAL, smallDup);
  check("[S-10] 小さい作品の保存も版 6・キー順・塊表の形が同じ", v10b.ok, v10b.why);
  check("[S-11] 前提: 検証に渡すファイルは**まとまっている**", bigMerged, `塊 ${bigNew.stats.blobCount}`);
  const v11 = await s11(bigNew.bytes, BIG_FRAMES);
  check("[S-11] ★まとめた結果で verifyPV6（tier1/1.5/2）と verifySavedBytes が緑・塊 1 バイトの化けは tier1.5 で赤", v11.ok, v11.why);
  const lb = lazyBlock(curPv6);
  check("[S-12] ★遅延の道（眠り控えを作るブロック）が v1.8.0 と 1 文字も違わない", lb !== "" && lb === lazyBlock(oldPv6), lb === "" ? "ブロックが見つからない" : "");
}

// ================= [S-1r] 実データ（引数あり・読むだけ） =================
if (LIB) {
  const { importFlipnote } = await import("../src/editor/kwzImport");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".kwz")) files.push(p);
    }
  })(LIB);
  // m3_smoke と同じ取り方（全体から均等に ~40 作品）
  const step = Math.max(1, Math.floor(files.length / 40));
  const samples = files.filter((_, i) => i % step === 0);
  let small = 0;
  let bigN = 0;
  let broken = 0;
  let blobsOld = 0;
  let blobsNew = 0;
  const bad: string[] = [];
  for (let si = 0; si < samples.length; si++) {
    let p: Project;
    try {
      const nb = fs.readFileSync(samples[si]);
      p = (await importFlipnote(nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength), samples[si])).project;
    } catch {
      broken++; // 開けない .kwz（0 バイト等）は作品ではない＝保存の比較の対象外（数だけ出す）
      continue;
    }
    const a = await frozen(() => enc(OLD!, p));
    const b = await frozen(() => enc(REAL, p));
    if (typeof b.stats.logicalRaw !== "number" || !REAL.pv6.pv6OpensLazily?.(b.stats.logicalRaw)) {
      small++;
      if (sha(a.bytes) !== sha(b.bytes)) bad.push(`#${si} 小さいのにバイト列が違う`);
      continue;
    }
    bigN++;
    blobsOld += a.stats.blobCount;
    blobsNew += b.stats.blobCount;
    if (b.stats.blobCount > a.stats.blobCount) bad.push(`#${si} 塊が増えた`);
    if (oracleRaw(await docOf(a.bytes)) !== oracleRaw(await docOf(b.bytes))) bad.push(`#${si} 論理サイズが変わった`);
    // 新旧の読み手で開き直し、1 コマずつ起こして元の作品と全画素比べる（全部起こすとメモリが山になる）
    for (const t of [REAL, OLD!]) {
      const q = await t.ser.projectFromBytes(b.bytes);
      let d = 0;
      for (let i = 0; i < p.frames.length; i++) {
        await t.sleep.wakeFrame(q, q.frames[i], "read");
        for (const [id, want] of Object.entries(p.frames[i].layers)) {
          const got = q.frames[i].layers[id];
          if (!got || got.length !== want.length) d = -1e9;
          else for (let k = 0; k < want.length; k++) if (got[k] !== want[k]) d++;
        }
        await t.sleep.sleepFrame(q, q.frames[i], undefined, true);
      }
      if (d !== 0) bad.push(`#${si} ${t.label} の読み手で画素差 ${d}`);
    }
  }
  console.log(
    `[S-1r] 実データ ${samples.length} 作品: 32MiB 未満 ${small}（バイト一致の検査）・以上 ${bigN}（まとめて開き直し・塊 ${blobsOld} → ${blobsNew}）・開けなかった .kwz ${broken} 件`
  );
  check("[S-1r] ★実データ: 32MiB 未満は旧とバイト列が同じ・以上はまとめても新旧の読み手で全画素一致", bad.length === 0 && small + bigN >= 40, bad.slice(0, 5).join(" / "));
} else {
  console.log("[S-1r] 実データ: 引数なし＝未実施（ライブラリのフォルダを渡すと m3_smoke と同じ 41 作品で回す）");
}

// ================= 反証（わざと壊した写しで赤になること） =================
{
  const bad = (m: { tree: Tree | null; why: string }) => m.tree === null;
  // [S-0] 土台: 無改変の写し
  const base = await mutant("cur", []);
  if (base.tree) {
    const t = base.tree;
    const results = [
      await s1Writer(t),
      s1Boundary(t),
      await s2(t, big.p),
      await s4(t),
      await s4b(t),
      await s5(t, bigNew.bytes),
      await s6(t, alias12Bytes),
      await s7(t, aliasPinBytes),
      await s7b(t, pinPinBytes),
      await s8(t, bigNew.bytes, [...BIG_PINS]),
      await s10(t, big.p),
    ];
    const reds = results.filter((r) => !r.ok).map((r) => r.why);
    check("[S-0] 反証の土台: 無改変の写しでは全部緑（写しの仕組みが赤を作っていない）", reds.length === 0, reds.slice(0, 3).join(" / "));
  } else check("[S-0] 反証の土台を作れた", false, base.why);

  // [S-1] しきい値を外した写し（小さい作品もまとめる）
  const thrOff = await mutant("cur", [["if (pv6OpensLazily(logicalRaw)) {", "if (true) {"]]);
  check("[S-1] 反証 1z: しきい値を外した写し（小さい作品もまとめる）は [S-1] が赤", !bad(thrOff) && !(await s1Writer(thrOff.tree!)).ok, thrOff.why);
  const thrInv = await mutant("cur", [["if (pv6OpensLazily(logicalRaw)) {", "if (!pv6OpensLazily(logicalRaw)) {"]]);
  check("[S-1] 反証 1z': 判定を逆にした写し（小さい作品をまとめ、大きい作品をまとめない）は [S-1] が赤", !bad(thrInv) && !(await s1Writer(thrInv.tree!)).ok, thrInv.why);
  const gt = await mutant("cur", [["return logicalRaw >= PV6_EAGER_MAX_RAW;", "return logicalRaw > PV6_EAGER_MAX_RAW;"]]);
  check("[S-1] 反証 1z'': `>=` を `>` に取り違えた写しは [S-1] の境界が赤", !bad(gt) && !s1Boundary(gt.tree!).ok, gt.why);
  // §1-3 そのもの: 中身でまとめる書き手（しきい値を外した写し）で 12 コマを書き、新旧の読み手で開く
  if (thrOff.tree) {
    const f12 = (await enc(thrOff.tree, content12)).bytes;
    const doc = await docOf(f12);
    const v = await s6(REAL, f12);
    check("[S-6] §1-3: 中身でまとめた 12 コマ（塊 4）を新しい読み手で開くと実体 12・伝染しない", doc.blobs.length === 4 && v.ok, `塊 ${doc.blobs.length}・${v.why}`);
    if (OLD) {
      const c = await s6(OLD, f12);
      check("[S-6] §1-3: 同じファイルを旧版の読み手で開くと実体 4・伝染する（だから小さい作品はまとめない）", c.instances === 4 && c.contaminated, c.why);
    }
  }

  // [S-2] 書き手が「塊の数で数える」写し
  const cnt = await mutant("cur", [["const logicalRaw = pv6LogicalRaw(sframes, metas);", "const logicalRaw = metas.reduce((s, m) => s + m.r, 0);"]]);
  check("[S-2] 反証 2z: 書き手が塊の数で論理サイズを数える写しは [S-2] が赤", !bad(cnt) && !(await s2(cnt.tree!, big.p)).ok, cnt.why);

  // [S-3] まとめるついでにコマから層を消す写し
  const drop = await mutant("cur", [
    ["  const remap = new Int32Array(blobs.length);\n", "  const remap = new Int32Array(blobs.length);\n  const seenTo = new Set<number>();\n"],
    [
      "    for (const id of Object.keys(layers)) layers[id] = remap[layers[id]];\n",
      "    for (const id of Object.keys(layers)) { const to = remap[layers[id]]; if (seenTo.has(to)) delete layers[id]; else { seenTo.add(to); layers[id] = to; } }\n",
    ],
  ]);
  check("[S-3] 反証 3z: まとめた塊を指すコマから層を消す写しは [S-3] が赤", !bad(drop) && !(await s3(drop.tree!, big.p)).ok, drop.why);

  // [S-4] まとめる段を外した写し
  const noMerge = await mutant("cur", [["if (pv6OpensLazily(logicalRaw)) {", "if (false) {"]]);
  check("[S-4] 反証 4z: まとめる段を外した写しは [S-4] が赤（塊の数が減らない）", !bad(noMerge) && !(await s4(noMerge.tree!)).ok, noMerge.why);
  // [S-4b] 幅の防御（起きている Uint16Array があればヘッダは 16）を外した写し（独立レビュー 2 回目が示した書き換えそのもの）
  const zureOff = await mutant("cur", [["        if (b instanceof Uint16Array) {\n", "        if (false && b instanceof Uint16Array) {\n"]]);
  check("[S-4b] 反証 4bz: 幅の防御を外した写しは [S-4b] が赤（ヘッダが 8 のまま＝開けない）", !bad(zureOff) && !(await s4b(zureOff.tree!)).ok, zureOff.why);

  // [S-5] 読み手の遅延を一括に書き換えた写し
  const eagerOld = await mutant("old", [["const lazy = logicalRaw >= PV6_EAGER_MAX_RAW;", "const lazy = false;"]]);
  if (eagerOld.tree) {
    const r = await s5(eagerOld.tree, bigNew.bytes);
    check("[S-5] 反証 5z: 旧版の読み手の遅延を一括に書き換えた写しは、同じ実体になり伝染する（[S-5] が赤）", !r.ok && r.sameInstance && r.contaminated, r.why);
  } else check("[S-5] 反証 5z を作れた", false, eagerOld.why);
  const eagerNew = await mutant("cur", [["const lazy = pv6OpensLazily(logicalRaw);", "const lazy = false;"]]);
  if (eagerNew.tree) {
    const r = await s5(eagerNew.tree, bigNew.bytes);
    check("[S-5] 反証 5z': 新しい読み手の遅延を一括に書き換えた写しは [S-5] が赤（伝染は [B] が止める）", !r.ok && !r.lazyOk && !r.contaminated, r.why);
  } else check("[S-5] 反証 5z' を作れた", false, eagerNew.why);

  // [S-6] [B] を外した写し（📌 でない層も塊 idx で同じ実体を配る＝元の形）
  const NONPIN = "        f.layers[id] = await inflateBlob(bytes, blobBase, doc, idx, bits);\n";
  const shareAll = await mutant("cur", [
    [
      NONPIN,
      "        { const k = `${idx}`; let b = pinnedBufs.get(k); if (!b) { b = await inflateBlob(bytes, blobBase, doc, idx, bits); pinnedBufs.set(k, b); } f.layers[id] = b; }\n",
    ],
  ]);
  if (shareAll.tree) {
    const r = await s6(shareAll.tree, alias12Bytes);
    check("[S-6] 反証 6z: [B] を外した写しは実体 4・伝染する（[S-6] が赤）", !r.ok && r.instances === 4 && r.contaminated, r.why);
  } else check("[S-6] 反証 6z を作れた", false, shareAll.why);

  // [S-7] 「当たったら写しを返す」だけにして、📌 でない層にもキャッシュへの書き込みを許した写し
  const PINKEY = "const key = `${idx}:${id}`;";
  const b1 = await mutant("cur", [
    [PINKEY, "const key = `${idx}`;"],
    [
      NONPIN,
      "        { const k = `${idx}`; const hit = pinnedBufs.get(k); if (hit) f.layers[id] = hit.slice(); else { const b = await inflateBlob(bytes, blobBase, doc, idx, bits); pinnedBufs.set(k, b); f.layers[id] = b; } }\n",
    ],
  ]);
  check("[S-7] 反証 7z: 当たったら写しを返すだけで、キャッシュへの書き込みを 📌 以外にも許した写しは [S-7] が赤", !bad(b1) && !(await s7(b1.tree!, aliasPinBytes)).ok, b1.why);

  // [S-7b] 読み手: 📌 の鍵からレイヤー id を外した写し／書き手: 📌 の塊もまとめる写し
  const keyNoId = await mutant("cur", [[PINKEY, "const key = `${idx}`;"]]);
  check("[S-7b] 反証 7bz: 📌 の鍵からレイヤー id を外した写しは [S-7b] が赤（別々の 📌 が同じ実体）", !bad(keyNoId) && !(await s7b(keyNoId.tree!, pinPinBytes)).ok, keyNoId.why);
  const mergePin = await mutant("cur", [["if (sharedIds.has(id)) pinned[idx] = 1;", "if (false) pinned[idx] = 1;"]]);
  if (mergePin.tree && OLD) {
    const f = (await enc(mergePin.tree, big.p)).bytes;
    const r = await s7bBig(OLD, f);
    check("[S-7b] 反証 7bz': 📌 の塊もまとめる書き手の写しは、旧版の読み手で P1 と P3 が同じ実体になる（[S-9] が赤）", !r.ok, r.why);
  } else check("[S-7b] 反証 7bz' を作れた", false, mergePin.why);

  // [S-8] 📌 も写しにした写し
  const pinCopy = await mutant("cur", [["        f.layers[id] = buf;\n      } else {", "        f.layers[id] = buf.slice();\n      } else {"]]);
  check("[S-8] 反証 8z: 📌 も写しにした写しは [S-8] が赤", !bad(pinCopy) && !(await s8(pinCopy.tree!, bigNew.bytes, [...BIG_PINS])).ok, pinCopy.why);

  // [S-10] 版を 7 にした写し
  const v7 = await mutant("cur", [["    version: 6,\n", "    version: 7,\n"]]);
  check("[S-10] 反証 10z: 版を 7 にした写しは [S-10] が赤", !bad(v7) && !(await s10(v7.tree!, big.p)).ok, v7.why);

  // [S-12] 遅延の道を 1 文字変えた写し（文字列の検査なので、写しの文字列で当てる）
  const lbMut = curPv6.replace("          live: null,\n", "          live: null ,\n");
  check("[S-12] 反証 12z: 遅延の道を 1 文字変えた写しは [S-12] が赤", lbMut !== curPv6 && lazyBlock(lbMut) !== lazyBlock(oldPv6));
}

console.log(
  `v177 数字: BIG 塊 ${v4.before ?? "?"} → ${v4.after ?? "?"}・${bigNew.bytes.length} B・論理 ${bigNew.stats.logicalRaw ?? "?"} B`
);
console.log(`v177 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
