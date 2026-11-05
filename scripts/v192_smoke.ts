// V192（A-93・REQ_thumb_scale・サムネイルと再生画面の縮め方・広げ方）の回帰ゲート。引数不要:
//   npx tsx scripts/v192_smoke.ts            （--report で表を全部出す＝報告書用）
//
// 決まり（REQ §2・作者決定）: 320×240 より小さく出すときは**面積で平均**、大きく出すときは**整数倍の最近傍**。
// どちらも「画面の実際の画素」（CSS の大きさ × devicePixelRatio）で数える。表示だけ（保存・PNG・IndexBuf は不変）。
// ★作者決定（2026-10-03・V192 の途中）: 混ぜる計算は**光の量で**（sRGB → リニア → 平均 → sRGB）。
//   赤 #ff1717 × 青 #0038ce の一松柄は (188, 43, 152) になること。
//
// [S-0] 写しの仕組み: 無改変の写しでは [S-8] が見る検査が全部緑
// [S-1] 面積平均の純関数 downscaleArea（src/editor/downscale.ts）:
//       (a) 赤 #ff1010 × 白・黒 #101010 × 白の一松柄を 1/2・1/4・0.4375（140/320）倍 → どの画素も光の量の中間
//           （255,188,188）／（188,188,188）±1（REQ K-1 の数をそのまま書いて照らす）
//       (b) ★赤 #ff1717 × 青 #0038ce の一松柄を 1/2・1/4 倍 → どの画素も (188, 43, 152) ちょうど。
//           0.4375 倍は面積の正解（別の書き方で 2 次元の重なりを数えた値）と ±1
//       (c) でたらめな絵（透明を含む）を何通りもの大きさへ → 面積の正解と ±1（256×192＝.ppm の元も）
//       (d) 単色の面は単色のまま／等倍は 1 バイトも変わらない
//       (e) 1 ドットの黒い線（縦横・全部の位置）は消えない（薄くなるだけ）
//       (f) 範囲の外を読まない（読んだ位置を全部記録）・入力を書き換えない・四隅の色が残る
// [S-2] ★今の縮め方（最近傍＝ drawImage の補間なし・CSS の pixelated）を同じ一松柄に掛けると [S-1] の基準で赤。
//       80×60 では片方の色しか残らない（数で出す）
// [S-3] 整数倍 fitDisplay: 枠 320〜2560 × 240〜1600（縦長・横長・小さい枠）× dpr 1 / 1.25 / 1.5 / 2 で、
//       k が整数・320k ≤ 枠（実画素）・k+1 は入らない・CSS の大きさ × dpr ＝ 320k（1 ドット＝k 実画素）・
//       枠が小さいときは縮める側（4:3・枠に入るいちばん大きい）
// [S-4] 静的: R-1〜R-5 の所で CSS の引き伸ばし（width/height 100%・object-fit・62%）が残っていない／
//       #preview-host を object-fit: contain で合わせていない／描く所が全部 presentFit を通り、
//       presentFit の縮める枝は downscaleArea だけ（drawImage を使わない）／大きさ・dpr の変化で作り直す
// [S-5] データを変えない: サムネの PNG を作る道（.kwz の save_thumb・.memoanima の save_project_thumb）を
//       V192 の前（2166690）と今の library.ts で**実際に動かし**、渡す PNG のハッシュが同じ・大きさは元のまま。
//       保存の封筒（editor.ts）と取り込み（main.ts）の PNG の道・render.ts・serialize.ts・pv6.ts・model.ts が前と同じ
// [S-6] 透明の紙（paper=0）: 透明のまま混ぜる（全部透明は alpha 0・描いた所の色は暗くならない）／
//       paper-clear のクラスの付け外しと CSS が残っている
// [S-7] 速さ（報告用）: 320×240 → 140×105・80×60 ほかの面積平均 1 回の時間
// [S-8] ★反証（写しで壊して赤を見る）: ①純関数を最近傍に戻す→[S-1] ②整数倍を floor しない→[S-3]
//       ③dpr を掛け忘れる→[S-3] ④コマ一覧だけ presentFit を通さない→[S-4] ⑤サムネの PNG を縮めて保存する→[S-5]
//       ⑥サムネの PNG を読むときにブラウザで縮める→[S-4] ⑦コマ一覧の見えなくなったサムネを手放さない→[S-4]
//       ⑧ライブラリの見えなくなったサムネを手放さない→[S-4]
//
// ★V192b（決-2 の改め・REQ §11）: ライブラリの再生画面だけは**枠いっぱい**。半端な倍率は境目を面積平均で混ぜる
//   （V192 と同じ式＝resampleArea は downscaleArea の別名）・ちょうど整数倍は最近傍。ほかの所は V192 のまま。
// [S-9]  枠いっぱい: fitDisplay(…, fill) が枠（実画素）に入る・4:3（±1）・縦か横が枠と一致（±1）・整数倍のときだけ "up"・
//        小さい枠は V192 と同じ縮め方。★library.ts の previewFit を取り出して偽の枠で動かし、同じ大きさになる
// [S-10] 混ぜ方: ちょうど 2・3・4 倍は最近傍と 1 画素も違わない。3.47・1.94 倍で一松柄の各ドットの中身の長さが
//        floor(s)−1〜floor(s)・境目は 1 画素・面積の正解（別の書き方）と ±1。単色は単色・透明は V192 と同じ。
//        V192 の関数（1374308）と全画素で同じ（速くした近道が答えを変えていない）
// [S-11] 速さ（報告用・目安 8 ms）: 1272×845・1912×1205・dpr 2 の枠で面積平均 1 回の中央値と 95%
//        （1 コマの描き直し＝合成＋面積平均＋putImageData は Node では測れない。画面で測った値は報告書 §V192b）
// [S-12] 静的: 再生画面の道だけが fill・presentFit の "fill" は面積平均の枝・resampleArea は downscaleArea の別名
// 反証 ⑨ 再生画面を整数倍に戻す→[S-9] ⑩ 半端な倍率を最近傍で広げる→[S-10] ⑪ 整数倍のときにも境目をずらして混ぜる→[S-10]
//      ⑫ 覚えの鍵から 2 つ目の画素を落とす→[S-10]（レビュー指摘）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
// V205 (A-113): model.ts の cloneFrame を意図して変えた回（名指し）と、新しい回から順に外す純関数（[S-5]）
import { undoFrom } from "./v205_named.ts";
import { readEditorSource } from "./editorSource";

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
    return { ok: false, why: `例外: ${String((e as Error)?.message ?? e).slice(0, 200)}`, threw: true };
  }
}
const root = path.resolve(import.meta.dirname, "..");
const REPORT = process.argv.includes("--report");
const BASE = "2166690"; // V192 の前（A-93 起票のコミット）
/** V197 (A-103) の saveWorker.ts（PV6 だけを書く形）の SHA-256（改行は LF）。[S-5] の注記を見よ */
const SAVE_WORKER_V197_SHA = "71a1a421fac2fb806b943e034a947068948222177847b4515a154eede942c1eb";
const sha = (b: Uint8Array | string) => crypto.createHash("sha256").update(b).digest("hex");
const log = (s: string) => console.log(s);

// ================= 木（本物・写し）を読む =================
type Tree = { root: string; read(rel: string): string };
const lf = (x: string) => x.replace(/\r\n/g, "\n");
/** ★V213 (M-2a): editor.ts の描く処理はコア（src/editor/core/editorCore.ts）へ移った。エディタのコードの性質を見る所は
 *  editor.ts とコアの字を並べたもの（editorSource.ts の readEditorSource）を読む。前の回の基準と比べる所（[S-5] の pairs）は除く */
const readEd = (T: Tree) => lf(readEditorSource(T.root));
/** 描く所（SITES）の字: editor.ts のものは editor.ts とコアを並べて読む */
const readSite = (T: Tree, rel: string) => (rel === "src/editor/editor.ts" ? readEd(T) : T.read(rel));
const realTree: Tree = { root, read: (rel) => lf(fs.readFileSync(path.join(root, rel), "utf8")) };
function baseBlob(rel: string): string | null {
  try {
    return lf(execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }));
  } catch {
    return null;
  }
}

type DS = typeof import("../src/editor/downscale");
async function loadDS(T: Tree): Promise<DS> {
  const p = path.join(T.root, "src/editor/downscale.ts");
  if (!fs.existsSync(p)) throw new Error("src/editor/downscale.ts が無い（純関数が未実装）");
  return (await import(pathToFileURL(p).href + `?t=${Date.now()}${Math.random()}`)) as DS;
}

// ================= 色と正解 =================
const enc = (L: number) => (L <= 0.0031308 ? 12.92 * L : 1.055 * Math.pow(L, 1 / 2.4) - 0.055);
const dec = (v8: number) => {
  const c = v8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const to8 = (L: number) => Math.round(255 * enc(L));

function checker(sw: number, sh: number, a: number[], b: number[]): Uint8ClampedArray {
  const s = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const o = (y * sw + x) * 4;
      const c = ((x + y) & 1) === 0 ? a : b;
      s[o] = c[0];
      s[o + 1] = c[1];
      s[o + 2] = c[2];
      s[o + 3] = c[3] ?? 255;
    }
  return s;
}

/** 面積の正解（**別の書き方**: 出す画素ごとに 2 次元の重なりの面積を浮動小数で数える・光の量・premultiplied） */
function oracle(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Float64Array {
  const out = new Float64Array(dw * dh * 4);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let j = 0; j < dh; j++) {
    const y0 = j * fy;
    const y1 = (j + 1) * fy;
    for (let i = 0; i < dw; i++) {
      const x0 = i * fx;
      const x1 = (i + 1) * fx;
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        area = 0;
      for (let y = Math.floor(y0); y < Math.min(sh, Math.ceil(y1 - 1e-9)); y++) {
        const oy = Math.min(y1, y + 1) - Math.max(y0, y);
        if (oy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.min(sw, Math.ceil(x1 - 1e-9)); x++) {
          const ox = Math.min(x1, x + 1) - Math.max(x0, x);
          if (ox <= 0) continue;
          const w = ox * oy;
          const p = (y * sw + x) * 4;
          const al = (src[p + 3] / 255) * w;
          r += dec(src[p]) * al;
          g += dec(src[p + 1]) * al;
          b += dec(src[p + 2]) * al;
          a += al;
          area += w;
        }
      }
      const o = (j * dw + i) * 4;
      if (a <= 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = 255 * enc(r / a);
        out[o + 1] = 255 * enc(g / a);
        out[o + 2] = 255 * enc(b / a);
        out[o + 3] = (255 * a) / area;
      }
    }
  }
  return out;
}

/** 今の縮め方: 出す画素の真ん中に当たる元の画素を 1 つ拾う（drawImage の imageSmoothingEnabled=false・CSS の pixelated） */
function nearest(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      const s = (sy * sw + sx) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = src[s + c];
    }
  return out;
}

const RED = [255, 0x10, 0x10];
const WHITE = [255, 255, 255];
const RED2 = [255, 0x17, 0x17];
const BLACK = [0x10, 0x10, 0x10];
const BLUE = [0x00, 0x38, 0xce];
/** 光の量の中間（一松柄＝ちょうど半分ずつ） */
const midOf = (a: number[], b: number[]) => [0, 1, 2].map((c) => to8((dec(a[c]) + dec(b[c])) / 2));

/** [S-1](a) の基準: どの画素も want ±tol。外れた画素の数と最大のずれを返す */
function judgeMid(out: Uint8ClampedArray, n: number, want: number[], tol: number) {
  let bad = 0;
  let maxDev = 0;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(out[i * 4 + c] - want[c]);
      if (d > maxDev) maxDev = d;
      if (d > tol) {
        bad++;
        break;
      }
    }
  return { bad, maxDev };
}
function distinct(out: Uint8ClampedArray, n: number): string[] {
  const s = new Set<string>();
  for (let i = 0; i < n; i++) s.add(`${out[i * 4]},${out[i * 4 + 1]},${out[i * 4 + 2]}`);
  return [...s];
}

const SIZES_A: [number, number, string][] = [
  [160, 120, "1/2"],
  [80, 60, "1/4"],
  [140, 105, "0.4375"],
];

// ================= [S-1] =================
async function S1(T: Tree): Promise<V> {
  const { downscaleArea } = await loadDS(T);
  const why: string[] = [];
  // (a) REQ K-1 の数（光の量の中間）。式で出した中間がその数と同じことも確かめる（式の写し違いで基準ごとずれない）
  for (const [a, b, want, cn] of [
    [RED, WHITE, [255, 188, 188], "赤白"],
    [BLACK, WHITE, [188, 188, 188], "黒白"],
  ] as const) {
    if (midOf(a as number[], b as number[]).join() !== (want as number[]).join()) why.push(`(a) ${cn}: 光の量の中間 ${midOf(a as number[], b as number[])} が REQ の ${want} と違う`);
    const src = checker(320, 240, a as number[], b as number[]);
    for (const [dw, dh, nm] of SIZES_A) {
      const o = downscaleArea(src, 320, 240, dw, dh);
      const j = judgeMid(o, dw * dh, want as number[], 1);
      if (j.bad) why.push(`(a) ${cn} ${nm}: ${want} ±1 を外れた画素 ${j.bad}（最大 ${j.maxDev}）`);
      if (REPORT && T === realTree) log(`  [S-1](a) ${cn} ${nm}: ${distinct(o, dw * dh).length} 色（${distinct(o, dw * dh).slice(0, 4).join(" / ")}）・${want} からの最大のずれ ${j.maxDev}`);
    }
  }
  // (b) 作者決定の数
  const rb = checker(320, 240, RED2, BLUE);
  for (const [dw, dh, nm] of SIZES_A.slice(0, 2)) {
    const o = downscaleArea(rb, 320, 240, dw, dh);
    const j = judgeMid(o, dw * dh, [188, 43, 152], 0);
    if (j.bad) why.push(`(b) 赤 #ff1717 × 青 #0038ce ${nm}: (188,43,152) でない画素 ${j.bad}（例 ${distinct(o, dw * dh).slice(0, 3).join(" / ")}）`);
  }
  {
    const o = downscaleArea(rb, 320, 240, 140, 105);
    const ref = oracle(rb, 320, 240, 140, 105);
    let bad = 0;
    for (let i = 0; i < o.length; i++) if (Math.abs(o[i] - ref[i]) > 1) bad++;
    if (bad) why.push(`(b) 赤青 0.4375: 面積の正解と ±1 を外れた値 ${bad}`);
    if (REPORT && T === realTree) {
      const j = judgeMid(o, 140 * 105, [188, 43, 152], 1);
      log(`  [S-1](b) 赤青 0.4375: ${distinct(o, 140 * 105).length} 色（${distinct(o, 140 * 105).slice(0, 4).join(" / ")}）・(188,43,152) からの最大のずれ ${j.maxDev}（窓 2.29 画素に赤と青がちょうど半分ずつは入らない＝面積の正解どおり）`);
    }
  }
  // (c) でたらめな絵（透明を含む）
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
  const cases: [number, number, number, number][] = [
    [320, 240, 160, 120],
    [320, 240, 80, 60],
    [320, 240, 140, 105],
    [320, 240, 150, 112],
    [320, 240, 69, 52],
    [320, 240, 104, 78],
    [320, 240, 296, 222],
    [320, 240, 213, 160],
    [320, 240, 1, 1],
    [320, 240, 7, 5],
    [256, 192, 140, 105],
    [256, 192, 80, 60],
    [256, 192, 150, 112],
  ];
  for (const [sw, sh, dw, dh] of cases) {
    const s = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < sw * sh; i++) {
      const t = rnd();
      const a = t < 0.2 ? 0 : t < 0.3 ? Math.floor(rnd() * 256) : 255;
      s[i * 4] = Math.floor(rnd() * 256);
      s[i * 4 + 1] = Math.floor(rnd() * 256);
      s[i * 4 + 2] = Math.floor(rnd() * 256);
      s[i * 4 + 3] = a;
    }
    const o = downscaleArea(s, sw, sh, dw, dh);
    const ref = oracle(s, sw, sh, dw, dh);
    let bad = 0;
    let maxd = 0;
    for (let i = 0; i < o.length; i++) {
      const d = Math.abs(o[i] - ref[i]);
      if (d > maxd) maxd = d;
      if (d > 1) bad++;
    }
    if (bad) why.push(`(c) ${sw}×${sh}→${dw}×${dh}: 正解と ±1 を外れた値 ${bad}（最大 ${maxd.toFixed(2)}）`);
  }
  // (d) 単色・等倍
  for (const col of [[0, 0, 0], [255, 255, 255], [12, 200, 77], [255, 23, 23], [0, 56, 206]]) {
    const s = checker(320, 240, col, col);
    for (const [dw, dh] of [[140, 105], [80, 60], [69, 52], [1, 1]]) {
      const o = downscaleArea(s, 320, 240, dw, dh);
      const ds = distinct(o, dw * dh);
      if (ds.length !== 1 || ds[0] !== col.join(",")) why.push(`(d) 単色 ${col} → ${dw}×${dh} で ${ds.slice(0, 3).join(" / ")}`);
    }
  }
  {
    const s = checker(320, 240, RED2, BLUE);
    const o = downscaleArea(s, 320, 240, 320, 240);
    if (sha(o) !== sha(s)) why.push("(d) 等倍（320×240 → 320×240）で値が変わった");
  }
  // (e) 1 ドットの黒い線
  for (const [dw, dh] of [[80, 60], [140, 105], [69, 52], [160, 120]]) {
    let lost = 0;
    let solid = 0;
    let faintest = 0;
    for (let v = 0; v < 320 + 240; v++) {
      const s = checker(320, 240, WHITE, WHITE);
      const vertical = v < 320;
      const pos = vertical ? v : v - 320;
      for (let k = 0; k < (vertical ? 240 : 320); k++) {
        const x = vertical ? pos : k;
        const y = vertical ? k : pos;
        const o = (y * 320 + x) * 4;
        s[o] = s[o + 1] = s[o + 2] = 0;
      }
      const o = downscaleArea(s, 320, 240, dw, dh);
      let mn = 255;
      for (let i = 0; i < dw * dh; i++) mn = Math.min(mn, o[i * 4]);
      if (mn >= 255) lost++;
      if (mn === 0) solid++;
      faintest = Math.max(faintest, mn);
    }
    if (lost) why.push(`(e) ${dw}×${dh}: 消えた 1 ドットの線 ${lost} 本`);
    if (solid) why.push(`(e) ${dw}×${dh}: 薄くならずに真っ黒のまま ${solid} 本`);
    if (REPORT && T === realTree) log(`  [S-1](e) ${dw}×${dh}: いちばん薄く残った線の明るさ ${faintest}（255 で消える）`);
  }
  // (f) 範囲の外を読まない・入力を書き換えない・四隅
  for (const [sw, sh, dw, dh] of [[320, 240, 140, 105], [320, 240, 80, 60], [256, 192, 69, 52], [320, 240, 7, 5]]) {
    const base = checker(sw, sh, RED2, BLUE);
    const before = sha(base);
    let oob = 0;
    const n = sw * sh * 4;
    const px = new Proxy(base, {
      get(t, k, r) {
        if (typeof k === "string" && /^-?\d+$/.test(k)) {
          const i = Number(k);
          if (i < 0 || i >= n) oob++;
          return t[i];
        }
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as unknown as Uint8ClampedArray;
    downscaleArea(px, sw, sh, dw, dh);
    if (oob) why.push(`(f) ${sw}×${sh}→${dw}×${dh}: 範囲の外を ${oob} 回読んだ`);
    if (sha(base) !== before) why.push(`(f) ${sw}×${sh}→${dw}×${dh}: 入力を書き換えた`);
    // 四隅だけ黒・ほか白 → 出す絵の四隅が白でない（1 ドットが窓の 1/30 以上を占める大きさだけ。7×5 は 1/2,000 で
    // 光の量で 0.05% しか暗くならず 8bit で 255 に丸まるのが正しい＝消えるのは範囲の読み違いではない）
    if ((sw / dw) * (sh / dh) > 30) continue;
    const c = checker(sw, sh, WHITE, WHITE);
    for (const [x, y] of [[0, 0], [sw - 1, 0], [0, sh - 1], [sw - 1, sh - 1]]) {
      const o = (y * sw + x) * 4;
      c[o] = c[o + 1] = c[o + 2] = 0;
    }
    const oc = downscaleArea(c, sw, sh, dw, dh);
    for (const [x, y] of [[0, 0], [dw - 1, 0], [0, dh - 1], [dw - 1, dh - 1]]) {
      if (oc[(y * dw + x) * 4] >= 255) why.push(`(f) ${sw}×${sh}→${dw}×${dh}: 隅 (${x},${y}) の黒が消えた`);
    }
  }
  return why.length ? ng(why.slice(0, 6).join("／")) : ok();
}

// ================= [S-2] =================
function S2(): V {
  const why: string[] = [];
  const rw = checker(320, 240, RED, WHITE);
  const rb = checker(320, 240, RED2, BLUE);
  const wantRW = midOf(RED, WHITE);
  for (const [dw, dh, nm] of [[80, 60, "1/4"], [140, 105, "0.4375"]] as const) {
    for (const [src, want, cn] of [[rw, wantRW, "赤白"], [rb, [188, 43, 152], "赤青"]] as const) {
      const o = nearest(src, 320, 240, dw, dh);
      const j = judgeMid(o, dw * dh, want as number[], 1);
      const ds = distinct(o, dw * dh);
      if (REPORT || j.bad === 0)
        log(`  [S-2] 最近傍 ${cn} ${nm}（${dw}×${dh}）: 中間 ±1 を外れた画素 ${j.bad}/${dw * dh}・残った色 ${ds.length} 色（${ds.join(" / ")}）`);
      if (j.bad === 0) why.push(`今の最近傍 ${cn} ${nm} が [S-1] の基準を通ってしまう（検査が今の見え方を捕まえない）`);
      if (dw === 80 && ds.length !== 1) why.push(`80×60 の最近傍 ${cn} で色が ${ds.length} 色残る（1 色のはず）`);
    }
  }
  return why.length ? ng(why.join("／")) : ok();
}

// ================= [S-3] =================
const BOX_W = [100, 140, 150, 200, 256, 300, 319, 320, 321, 400, 480, 639, 640, 641, 800, 960, 1270, 1280, 1366, 1600, 1920, 2560];
const BOX_H = [75, 105, 120, 180, 192, 239, 240, 241, 300, 479, 480, 481, 600, 720, 768, 900, 960, 1080, 1200, 1440, 1600];
const DPRS = [1, 1.25, 1.5, 2];
async function S3(T: Tree, report = false): Promise<V> {
  const { fitDisplay } = await loadDS(T);
  const why: string[] = [];
  let n = 0;
  for (const [sw, sh] of [[320, 240], [256, 192]])
    for (const dpr of DPRS)
      for (const bw of BOX_W)
        for (const bh of BOX_H) {
          n++;
          const f = fitDisplay(bw, bh, dpr, sw, sh);
          const BW = Math.floor(bw * dpr + 1e-6);
          const BH = Math.floor(bh * dpr + 1e-6);
          const tag = `${sw}×${sh} 枠 ${bw}×${bh} dpr ${dpr}`;
          if (!(Math.abs(f.cssW * dpr - f.devW) < 1e-6 && Math.abs(f.cssH * dpr - f.devH) < 1e-6))
            why.push(`${tag}: CSS の大きさ × dpr（${(f.cssW * dpr).toFixed(3)}）が実画素 ${f.devW} と違う`);
          if (f.devW > BW || f.devH > BH) why.push(`${tag}: 枠（実画素 ${BW}×${BH}）からはみ出す ${f.devW}×${f.devH}`);
          if (BW >= sw && BH >= sh) {
            const k = Math.floor(Math.min(BW / sw, BH / sh));
            if (f.mode !== "up" || !Number.isInteger(f.k)) why.push(`${tag}: 整数倍にならない（${f.mode} k=${f.k}）`);
            else {
              if (f.k !== k) why.push(`${tag}: k=${f.k}（入るいちばん大きい整数倍は ${k}）`);
              if (f.devW !== sw * f.k || f.devH !== sh * f.k) why.push(`${tag}: ${f.devW}×${f.devH} が ${sw}k×${sh}k でない`);
              if (sw * (f.k + 1) <= BW && sh * (f.k + 1) <= BH) why.push(`${tag}: k+1 も入る`);
            }
          } else {
            if (f.mode !== "down") why.push(`${tag}: 枠が小さいのに縮める側に回らない（${f.mode} ${f.devW}×${f.devH}）`);
            else {
              // 4:3 を保つ（±1 実画素）・枠に入るいちばん大きい（幅か高さのどちらかが枠いっぱい −1 まで）
              if (Math.abs(f.devW * sh - f.devH * sw) > Math.max(sw, sh)) why.push(`${tag}: 縦横比が崩れた ${f.devW}×${f.devH}`);
              if (f.devW < BW - 1 && f.devH < BH - 1) why.push(`${tag}: もっと大きく出せる ${f.devW}×${f.devH}（枠 ${BW}×${BH}）`);
            }
          }
        }
  if (report) {
    log("  [S-3] 表（320×240・抜粋）: 枠 CSS px → dpr → 実画素の枠 → k → 出す実画素 → CSS の大きさ");
    for (const [bw, bh] of [[140, 105], [150, 112.5], [640, 480], [960, 540], [1270, 800], [1270, 720], [1600, 900], [1920, 1080], [2560, 1440], [400, 1200], [1600, 300]])
      for (const dpr of DPRS) {
        const f = fitDisplay(bw, bh, dpr);
        log(`    ${bw}×${bh} @${dpr} → ${Math.floor(bw * dpr + 1e-6)}×${Math.floor(bh * dpr + 1e-6)} → ${f.mode === "up" ? "k=" + f.k : "縮める"} → ${f.devW}×${f.devH} → ${+f.cssW.toFixed(3)}×${+f.cssH.toFixed(3)}`);
      }
  }
  return why.length ? ng(`NG ${why.length} 件（${n} 通り中）: ${why.slice(0, 4).join("／")}`) : ok();
}

// ================= ソースの切り出し（構文木） =================
function sf(src: string, name = "x.ts") {
  return ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true);
}
/** クラスのメソッド・関数宣言・`const X = (...) =>` を名前で探して本文の文字列を返す（無ければ null） */
function fnText(src: string, name: string): string | null {
  const s = sf(src);
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && n.name.getText(s) === name) {
      found = n.getText(s);
      return;
    }
    if (ts.isVariableDeclaration(n) && n.name.getText(s) === name && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      found = n.getText(s);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(s);
  return found;
}
/** 本文からコメントを落とす（説明文に関数名が出てきても検査が当たらないように。"://" は残す） */
function noComments(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}
/** CSS の規則（セレクタ → 中身）。コメントは落とす */
function cssRules(css: string): { sel: string[]; body: string }[] {
  const t = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { sel: string[]; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) out.push({ sel: m[1].split(",").map((x) => x.trim().replace(/\s+/g, " ")), body: m[2] });
  return out;
}

// ================= [S-4] =================
/** 描く所（R-1〜R-5）: ファイル・関数名 */
const SITES: { r: string; file: string; fn: string }[] = [
  { r: "R-1 ライブラリのサムネ", file: "src/library.ts", fn: "paintThumb" },
  { r: "R-2 再生画面（.kwz/.ppm）", file: "src/library.ts", fn: "drawNoteFrame" },
  { r: "R-2 再生画面（.memoanima）", file: "src/library.ts", fn: "drawPreview" },
  { r: "R-3 コマ一覧", file: "src/editor/editor.ts", fn: "paintFilmThumb" },
  { r: "R-4 小さいプレビュー", file: "src/editor/editor.ts", fn: "paintMini" },
  { r: "R-5 音の窓のプレビュー", file: "src/editor/editor.ts", fn: "drawTrialFrame" },
];
/** R-1〜R-5 の CSS のセレクタ（1:1 で出す所） */
const SITE_SEL = [".thumb .pic canvas", ".thumb .pic img", "#preview-host", ".fr canvas", ".mini canvas", ".ap-big canvas", ".ap-big", "#ap-mini"];
function S4(T: Tree): V {
  const why: string[] = [];
  // CSS
  const css = T.read("src/styles.css");
  const rules = cssRules(css);
  if (rules.some((r) => r.sel.includes(".thumb .pic img"))) why.push("CSS: .thumb .pic img（img を CSS で縮める規則）が残っている");
  for (const r of rules) {
    const hit = r.sel.filter((s) => SITE_SEL.includes(s));
    if (!hit.length) continue;
    if (/object-fit\s*:/.test(r.body)) why.push(`CSS: ${hit.join(",")} に object-fit`);
    // 絵のキャンバス自身を % で引き伸ばさない（.ap-big は枠＝キャンバスを包む div なので幅の % は可・キャンバスは不可）
    const isCanvasRule = hit.some((s) => s !== ".ap-big");
    if (isCanvasRule && /(^|[^-])(width|height)\s*:\s*[\d.]+%/.test(r.body)) why.push(`CSS: ${hit.join(",")} が % の大きさ（CSS で引き伸ばす）`);
  }
  if (!rules.some((r) => r.sel.includes("#preview-host"))) why.push("CSS: #preview-host の規則が無い（検査の窓が壊れた）");
  if (!rules.some((r) => r.sel.includes(".thumb .pic canvas"))) why.push("CSS: .thumb .pic canvas の規則が無い");
  if (!rules.some((r) => r.sel.includes(".ap-big canvas"))) why.push("CSS: .ap-big canvas の規則が無い");
  // 描く所
  for (const s of SITES) {
    const raw = fnText(readSite(T, s.file), s.fn);
    if (!raw) {
      why.push(`${s.r}: ${s.file} に ${s.fn} が無い（検査の窓が壊れた）`);
      continue;
    }
    const body = noComments(raw);
    if (!/\bpresentFit\(/.test(body)) why.push(`${s.r}: ${s.fn} が presentFit を通らない`);
    if (/\bpresentToCanvas\(|\.drawImage\(|\.putImageData\(|(?<!dataset)\.src\s*=/.test(body)) why.push(`${s.r}: ${s.fn} に presentFit 以外の出し方（presentToCanvas / drawImage / putImageData / src）`);
  }
  // presentFit の中身
  const sv = (() => {
    try {
      return T.read("src/editor/scaledView.ts");
    } catch {
      return "";
    }
  })();
  const pfRaw = fnText(sv, "presentFit");
  const pf = pfRaw ? noComments(pfRaw) : null;
  if (!pf) why.push("scaledView.ts に presentFit が無い");
  else {
    // V192b: 枝の条件に "fill"（再生画面の枠いっぱい）が加わった。中で呼ぶのは resampleArea（＝downscaleArea の別名）
    const m = /if \(fit\.mode === "down"(?: \|\| fit\.mode === "fill")?\) \{([\s\S]*?)\n  \}/.exec(pf);
    if (!m) why.push("presentFit の縮める枝が見つからない");
    else {
      if (!/\b(downscaleArea|resampleArea)\(/.test(m[1])) why.push("presentFit の縮める枝が downscaleArea を通らない");
      if (/drawImage|imageSmoothing/.test(m[1])) why.push("presentFit の縮める枝がブラウザの縮小（drawImage）を使う");
    }
    if (!/imageSmoothingEnabled = false/.test(pf)) why.push("presentFit の広げる枝が補間を切っていない");
    if (!/sw \* fit\.k, sh \* fit\.k/.test(pf)) why.push("presentFit の広げる枝が整数 k 倍で描いていない");
    if (!/cv\.style\.width/.test(pf) || !/cv\.width !== fit\.devW/.test(pf)) why.push("presentFit が CSS の大きさとバッキングを fit で揃えていない");
  }
  // R-1 の読み込みは 1:1（drawImage に大きさを渡さない＝ここでブラウザに縮めさせない）
  const dec = noComments(fnText(sv, "decodeImageRgba") ?? "");
  const draws = dec.match(/\.drawImage\([^)]*\)/g) ?? [];
  if (draws.length !== 1 || !/^\.drawImage\(img, 0, 0\)$/.test(draws[0])) why.push(`decodeImageRgba の drawImage が 1:1 でない（${draws.join(" / ") || "無い"}）`);
  // R-3（F-0）: 見えなくなったコマ一覧のサムネはバッキングを手放す
  const rb = noComments(fnText(readEd(T), "rebuildFilm") ?? "");
  if (!/if \(!e\.isIntersecting\) \{[^}]*releaseCanvas\(cv\)/.test(rb)) why.push("rebuildFilm: 見えなくなったサムネを releaseCanvas していない（F-0）");
  const ff = fnText(sv, "fitFor");
  if (!ff || !/currentDpr\(\)/.test(ff) || !/fitDisplay\(/.test(ff)) why.push("fitFor が fitDisplay(…, currentDpr()) を通らない");
  if (!/devicePixelRatio/.test(fnText(sv, "currentDpr") ?? "")) why.push("currentDpr が devicePixelRatio を読まない");
  // 大きさ・dpr の変化で作り直す
  const lib = T.read("src/library.ts");
  const ed = readEd(T);
  if ((lib.match(/\bwatchFit\(/g) ?? []).length < 2) why.push("library.ts: 再生画面とサムネの棚の watchFit が 2 つ無い");
  // R-1: 見えなくなったサムネも手放す（canvas の画素はブラウザが捨てない＝棚で見た枚数ぶん増える）
  const rs = noComments(fnText(lib, "renderShelf") ?? "");
  if (!/if \(!e\.isIntersecting\) \{[^}]*releaseCanvas\(cv\)/.test(rs)) why.push("renderShelf: 見えなくなったサムネを releaseCanvas していない");
  for (const k of ["filmFitWatch", "miniFitWatch", "apFitWatch"])
    if (!new RegExp(`\\b${k}\\b[^\\n]*watchFit\\(`).test(ed)) why.push(`editor.ts: ${k} = watchFit(…) が無い`);
  // 再生画面の canvas: 余計な引き伸ばしをしない
  const html = T.read("index.html");
  if (!/<canvas id="preview-host"/.test(html)) why.push("index.html: #preview-host が無い");
  return why.length ? ng(why.slice(0, 6).join("／")) : ok();
}

// ================= [S-5] =================
type Rec = { cmd: string; args: Record<string, unknown> }[];
/** library.ts の loadThumb を取り出して動かす（V192 の前・今の両方）。保存に渡る PNG を返す */
async function runLoadThumb(libSrc: string, scenario: "kwz" | "ppm" | "project", R: Mods) {
  const text = fnText(libSrc, "loadThumb");
  if (!text) throw new Error("loadThumb が無い");
  const fnSrc = text.replace(/^private\s+/, "").replace(/^loadThumb\s*\(/, "async function loadThumb(");
  const js = ts.transpileModule(fnSrc, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const rec: Rec = [];
  const jobs: (() => Promise<void>)[] = [];
  const shown: unknown[] = [];
  const ioList: { cb: (e: unknown[]) => void; el: unknown }[] = [];
  class FakeIO {
    cb: (e: unknown[]) => void;
    constructor(cb: (e: unknown[]) => void) {
      this.cb = cb;
    }
    observe(el: unknown) {
      ioList.push({ cb: this.cb, el });
    }
    disconnect() {}
    unobserve() {}
  }
  const W0 = scenario === "ppm" ? 256 : 320;
  const H0 = scenario === "ppm" ? 192 : 240;
  const pixels = new Uint32Array(W0 * H0);
  for (let i = 0; i < pixels.length; i++) pixels[i] = ((i * 2654435761) >>> 0) | 0xff000000;
  const note = { imageWidth: W0, imageHeight: H0, thumbFrameIndex: 0, getFramePixelsRgba: () => pixels };
  const invoke = async (cmd: string, args: Record<string, unknown>) => {
    rec.push({ cmd, args });
    if (cmd === "load_thumb") return null;
    if (cmd === "read_file_bytes") return [1, 2, 3];
    return null;
  };
  const self = {
    libRoot: "LIB",
    enqueueThumb: (j: () => Promise<void>) => jobs.push(j),
    showThumb: (_cv: unknown, blob: unknown) => shown.push(blob),
    thumbSrc: new WeakMap(),
  };
  const it =
    scenario === "project"
      ? { kind: "project", thumb_path: null, path: "LIB/a/x.memoanima", hash: "h" }
      : { kind: "note", thumb_path: null, path: "LIB/a/x.kwz", hash: "h" };
  const el: Record<string, unknown> = { src: "" };
  const URLs = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
  const make = new Function(
    "invoke",
    "readProjectRaw",
    "projectFromBytes",
    "frameToPngBlob",
    "parse",
    "document",
    "IntersectionObserver",
    "URL",
    `"use strict"; ${js}; return loadThumb;`,
  );
  const loadThumb = make(
    invoke,
    async () => new Uint8Array([9]),
    async () => R.project,
    R.frameToPngBlob,
    async () => note,
    R.document,
    FakeIO,
    URLs,
  );
  await loadThumb.call(self, el, it);
  for (const io of ioList) io.cb([{ isIntersecting: true, target: io.el }]);
  while (jobs.length) await jobs.shift()!();
  const saved = rec.filter((r) => r.cmd === "save_thumb" || r.cmd === "save_project_thumb");
  return saved.map((r) => ({ cmd: r.cmd, png: Uint8Array.from(r.args.png as number[]) }));
}
type Mods = { project: unknown; frameToPngBlob: (p: unknown, i: number) => Promise<Blob | null>; document: unknown };
/** 偽の canvas: toBlob は「幅・高さ・画素の SHA-256」をそのまま PNG の代わりに返す（同じ入力 → 同じバイト） */
function fakeDocument() {
  return {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`createElement(${tag})`);
      let data: Uint8ClampedArray | null = null;
      const cv = {
        width: 300,
        height: 150,
        style: {},
        getContext: () => ({
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }) => {
            data = new Uint8ClampedArray(img.data);
            if (img.width !== cv.width || img.height !== cv.height) data = null;
          },
          drawImage: () => {
            data = null; // 縮めて描いた＝元の画素ではない
          },
          clearRect: () => {},
          imageSmoothingEnabled: true,
        }),
        toBlob: (cb: (b: Blob) => void) => {
          const head = `FAKEPNG ${cv.width}x${cv.height} `;
          cb(new Blob([head + (data ? sha(data) : "drawn")]));
        },
      };
      return cv;
    },
  };
}
async function S5(T: Tree): Promise<V> {
  const why: string[] = [];
  const baseLib = baseBlob("src/library.ts");
  if (!baseLib) return ng(`V192 の前の library.ts（${BASE}）が読めない`);
  // render.ts の frameToPngBlob を偽の canvas で動かす
  const G = globalThis as Record<string, unknown>;
  const doc = fakeDocument();
  G.document = doc;
  G.ImageData = class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(d: Uint8ClampedArray, w: number, h: number) {
      this.data = d;
      this.width = w;
      this.height = h;
    }
  };
  const M = (await import(pathToFileURL(path.join(root, "src/editor/model.ts")).href)) as typeof import("../src/editor/model");
  const Rd = (await import(pathToFileURL(path.join(root, "src/editor/render.ts")).href)) as typeof import("../src/editor/render");
  const p = M.newProject("v192");
  const red = M.ensureColor(p, "#ff1717");
  const blue = M.ensureColor(p, "#0038ce");
  const lb = p.frames[0].layers[p.layerDefs[0].id];
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) lb[y * 320 + x] = (x + y) & 1 ? red : blue;
  const mods: Mods = { project: p, frameToPngBlob: Rd.frameToPngBlob as Mods["frameToPngBlob"], document: doc };
  for (const sc of ["kwz", "ppm", "project"] as const) {
    const a = await runLoadThumb(baseLib, sc, mods);
    const b = await runLoadThumb(T.read("src/library.ts"), sc, mods);
    const fa = a.map((x) => `${x.cmd}:${sha(x.png).slice(0, 12)}`).join(",");
    const fb = b.map((x) => `${x.cmd}:${sha(x.png).slice(0, 12)}`).join(",");
    const want = sc === "ppm" ? "256x192" : "320x240";
    if (REPORT && T === realTree) log(`  [S-5] ${sc}: 前 ${fa} ／ 今 ${fb}`);
    if (a.length !== 1) why.push(`${sc}: V192 の前で保存が 1 回でない（${a.length}・検査の窓が壊れた）`);
    if (fa !== fb) why.push(`${sc}: 保存する PNG が前と違う（前 ${fa} ／ 今 ${fb}）`);
    for (const x of b) {
      const head = new TextDecoder().decode(x.png).split(" ")[1];
      if (head !== want) why.push(`${sc}: 保存する PNG の大きさ ${head}（元の ${want} のはず）`);
      if (new TextDecoder().decode(x.png).endsWith("drawn")) why.push(`${sc}: 保存する PNG が縮めて描いたもの`);
    }
  }
  // 封筒（editor.ts の保存）と取り込み（main.ts）の PNG の道・データの形のファイル
  // ★V201 (M-1a): editor.ts の保存は手順を共通の部品（saveCore.ts の saveWork）へ移し、サムネはその thumb の口（部品が渡す
  //  作品 p＝this.project）で描く形になった。前と同じ行かは、口の名前（p）を前の名前（this.project）に戻し、字下げをそろえて比べる
  //  （中身は同じ: frameToPngBlob を等倍で呼び、Blob をそのまま Uint8Array に）。部品がその PNG を書く口へ渡すことも見る
  const pairs: [string, string, string][] = [
    ["src/editor/editor.ts", "frameToPngBlob(p, p.thumbFrame ?? 0)", "frameToPngBlob(this.project, this.project.thumbFrame)"],
    ["src/main.ts", "frameToPngBlob(project, project.thumbFrame ?? 0)", "frameToPngBlob(project, project.thumbFrame ?? 0)"],
  ];
  for (const [file, needle, needleBefore] of pairs) {
    const now = T.read(file);
    const before = baseBlob(file);
    if (!before) {
      why.push(`${file}: 前が読めない`);
      continue;
    }
    const grab = (src: string, nd: string) => {
      const i = src.indexOf(nd);
      if (i < 0) return null;
      return src
        .slice(Math.max(0, src.lastIndexOf("\n", i - 1)), src.indexOf("\n", src.indexOf("thumb", i + nd.length) + 1))
        .replace(/^[ \t]+/gm, "");
    };
    const gn = grab(now, needle)?.split(needle).join(needleBefore) ?? null;
    const gb = grab(before, needleBefore);
    if (!gn || !gb) why.push(`${file}: サムネの PNG の行が見つからない`);
    else if (gn !== gb) why.push(`${file}: サムネの PNG を作る行が前と違う`);
  }
  {
    // 部品: サムネの口の戻り（PNG）をそのまま書く口へ渡す。editor: 書く口はそれを save_project の第 3 引数へ
    const core = T.read("src/editor/saveCore.ts");
    const ed = readEd(T);
    if (!/const thumb = await d\.thumb\(p\);/.test(core) || !/d\.write\(\{ kind: d\.kind, baseName: d\.baseName, data: bytes, thumb \}\)/.test(core))
      why.push("saveCore.ts: サムネの口の PNG をそのまま書く口へ渡していない");
    if (!/thumb: async \(p\) => \{\s*const blob = await frameToPngBlob\(p, p\.thumbFrame \?\? 0\);/.test(ed) ||
        // ★V216b (A-126): 書く口は「その作品のファイル」と「置き換えてよい」も渡す形（書く所の確かめつき）になった（v216b_smoke [W]・v216b_ui が見る）。
        //  ここではサムネの PNG をそのまま save_project の第 3 引数へ渡すことだけを見る（V216b の名指しの差分を外した字＝前の形と、今の字の第 3 引数）
        !(/write: async \(w\) => \(\{ path: await this\.cb\.saveProject\(ctx, w\.data, w\.thumb\) \}\),/.test(undoFrom(216, "src/editor/editor.ts", T.read("src/editor/editor.ts")) ?? "") &&
          /const path = await this\.cb\.saveProject\(ctx, w\.data, w\.thumb, \{/.test(ed)))
      why.push("editor.ts: 保存のサムネの口・書く口の形が違う");
  }
  for (const f of ["src/editor/render.ts", "src/editor/serialize.ts", "src/editor/pv6.ts", "src/editor/model.ts"]) {
    const before = baseBlob(f);
    if (!before) why.push(`${f}: 前が読めない`);
    // ★V205 (A-113): model.ts の cloneFrame は V205 で意図して変えた（このコマだけの表示色も写す）。名指しの差分（scripts/v205_named.ts の
    //  fixtures）を新しい回から順に外してから比べる（undoFrom(203, …)。render・serialize・pv6 は名指しの差分が無い＝外してもそのまま）
    else if (sha(before) !== sha(undoFrom(203, f, T.read(f)) ?? "")) why.push(`${f} が V192 の前と違う`);
  }
  // ★V197 (A-103): saveWorker.ts は V197 で**意図して**変えた（旧形式＝gzip の枝を消して PV6 だけに）。
  //  ここで守りたいのは「サムネの縮小（V192）が保存の道を変えない」こと＝V192 の前ではなく **V197 の形**と比べる
  //  （改行を LF にした SHA-256）。V197 の中身（どの mode を渡しても PV6）は v197_smoke [B-5] が動かして見る。
  //  次に saveWorker.ts を意図して変える回は、この値を更新して報告書に書く
  if (sha(T.read("src/editor/saveWorker.ts")) !== SAVE_WORKER_V197_SHA) why.push("src/editor/saveWorker.ts が V197 の形と違う");
  return why.length ? ng(why.slice(0, 6).join("／")) : ok();
}

// ================= [S-6] =================
async function S6(T: Tree): Promise<V> {
  const { downscaleArea } = await loadDS(T);
  const why: string[] = [];
  const TR = [0, 0, 0, 0];
  const RA = [255, 0x10, 0x10, 255];
  // 全部透明 → alpha 0
  {
    const s = checker(320, 240, TR, TR);
    for (const [dw, dh] of [[140, 105], [80, 60]]) {
      const o = downscaleArea(s, 320, 240, dw, dh);
      if (o.some((v) => v !== 0)) why.push(`全部透明 → ${dw}×${dh} で 0 でない画素がある（市松の見え方が変わる）`);
    }
  }
  // 赤と透明の一松柄 → 色は赤のまま（暗くならない）・alpha は半分
  {
    const s = checker(320, 240, RA, TR);
    for (const [dw, dh] of [[160, 120], [80, 60], [140, 105]]) {
      const o = downscaleArea(s, 320, 240, dw, dh);
      let bad = 0;
      let amin = 255,
        amax = 0;
      for (let i = 0; i < dw * dh; i++) {
        if (o[i * 4] !== 255 || o[i * 4 + 1] !== 0x10 || o[i * 4 + 2] !== 0x10) bad++;
        amin = Math.min(amin, o[i * 4 + 3]);
        amax = Math.max(amax, o[i * 4 + 3]);
      }
      if (bad) why.push(`赤と透明 → ${dw}×${dh}: 色が赤でない画素 ${bad}（透明の 0,0,0 が混ざった）`);
      if (amin < 125 || amax > 131) why.push(`赤と透明 → ${dw}×${dh}: alpha ${amin}〜${amax}（半分のはず）`);
      if (REPORT && T === realTree) log(`  [S-6] 赤と透明の一松柄 → ${dw}×${dh}: 色 (255,16,16)・alpha ${amin}〜${amax}`);
    }
  }
  // 紙が透明のコマ: 合成は alpha 0（render.ts は前と同じ＝[S-5]）。描く所で paper-clear を付け外しする
  for (const s of SITES.filter((x) => x.fn !== "paintThumb" && x.fn !== "drawNoteFrame")) {
    const body = fnText(T.read(s.file), s.fn) ?? "";
    if (!/classList\.toggle\("paper-clear"/.test(body)) why.push(`${s.r}: paper-clear の付け外しが無い`);
  }
  const before = baseBlob("src/styles.css");
  // ★V204 (A-111): ゆらゆらの見本（#wb-preview）を今の市松の規則に足した。その 1 つのセレクタだけを名指しで外して前と比べる
  //  （ほかのセレクタ・中身は前と字まで同じ。見本に市松が付くことは v204_smoke [E-*] が引き継ぐ）
  const pc = (css: string) => cssRules(css).filter((r) => r.sel.some((x) => /paper-clear/.test(x))).map((r) => r.sel.filter((x) => x !== "#wb-preview.paper-clear").join(",") + "{" + r.body.trim() + "}").join("\n");
  if (!before) why.push("styles.css の前が読めない");
  else if (pc(before) !== pc(T.read("src/styles.css"))) why.push("paper-clear の CSS が前と違う");
  return why.length ? ng(why.join("／")) : ok();
}

// ================= [S-7] =================
async function S7(T: Tree) {
  const { downscaleArea } = await loadDS(T);
  const s = checker(320, 240, RED2, BLUE);
  const rows: string[] = [];
  for (const [dw, dh, nm] of [
    [140, 105, "ライブラリのサムネ（REQ の概数）"],
    [136, 102, "ライブラリのサムネ（1280×800 の実測・dpr 1）"],
    [80, 60, "前のコマ一覧のバッキング"],
    [69, 52, "コマ一覧・既定の高さ（dpr 1）"],
    [148, 111, "コマ一覧・2 倍（dpr 1）"],
    [140, 105, "コマ一覧・既定の高さ（dpr 2）"],
    [296, 222, "コマ一覧・2 倍（dpr 2）"],
    [144, 108, "小さいプレビュー（dpr 1）"],
  ] as const) {
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let i = 0; i < 20; i++) downscaleArea(s, 320, 240, dw, dh, out);
    const ts: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      downscaleArea(s, 320, 240, dw, dh, out);
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    rows.push(`  [S-7] 320×240 → ${dw}×${dh}（${nm}）: 中央 ${ts[100].toFixed(3)} ms・95% ${ts[190].toFixed(3)} ms`);
  }
  for (const r of rows) log(r);
}

// ================= V192b: [S-9]〜[S-12] =================
/** 偽の DOM で scaledView の fitFor を動かすための枠（getBoundingClientRect と getComputedStyle だけ） */
function fakeBox(w: number, h: number) {
  return { getBoundingClientRect: () => ({ width: w, height: h }) };
}
async function withFakeDom<T>(dpr: number, fn: () => Promise<T> | T): Promise<T> {
  const G = globalThis as Record<string, unknown>;
  const keep = { window: G.window, getComputedStyle: G.getComputedStyle };
  G.window = { devicePixelRatio: dpr };
  G.getComputedStyle = () => ({ borderLeftWidth: "0px", borderRightWidth: "0px", borderTopWidth: "0px", borderBottomWidth: "0px", paddingLeft: "0px", paddingRight: "0px", paddingTop: "0px", paddingBottom: "0px" });
  try {
    return await fn();
  } finally {
    G.window = keep.window;
    G.getComputedStyle = keep.getComputedStyle;
  }
}
const BOX9_W = [...BOX_W, 632, 718, 792, 952, 1272, 1912, 333.5, 1126.4];
const BOX9_H = [...BOX_H, 527, 495, 627, 665, 845, 1205, 250.25, 844.6];
async function S9(T: Tree, report = false): Promise<V> {
  const { fitDisplay } = await loadDS(T);
  const why: string[] = [];
  let n = 0;
  for (const [sw, sh] of [[320, 240], [256, 192]])
    for (const dpr of DPRS)
      for (const bw of BOX9_W)
        for (const bh of BOX9_H) {
          n++;
          const f = fitDisplay(bw, bh, dpr, sw, sh, true);
          const g = fitDisplay(bw, bh, dpr, sw, sh);
          const BW = Math.floor(bw * dpr + 1e-6);
          const BH = Math.floor(bh * dpr + 1e-6);
          const tag = `${sw}×${sh} 枠 ${bw}×${bh} dpr ${dpr}`;
          if (!(Math.abs(f.cssW * dpr - f.devW) < 1e-6 && Math.abs(f.cssH * dpr - f.devH) < 1e-6)) why.push(`${tag}: CSS × dpr が実画素と違う`);
          if (f.devW > BW || f.devH > BH) why.push(`${tag}: はみ出す ${f.devW}×${f.devH}（枠 ${BW}×${BH}）`);
          if (Math.abs(f.devW * sh - f.devH * sw) > Math.max(sw, sh)) why.push(`${tag}: 縦横比が崩れた ${f.devW}×${f.devH}`);
          if (BW >= sw && BH >= sh) {
            if (f.devW < BW - 1 && f.devH < BH - 1) why.push(`${tag}: 枠いっぱいでない ${f.devW}×${f.devH}（枠 ${BW}×${BH}）`);
            const integer = f.devW % sw === 0 && f.devH === (f.devW / sw) * sh;
            if (integer ? f.mode !== "up" || f.k !== f.devW / sw : f.mode !== "fill") why.push(`${tag}: ${f.devW}×${f.devH} なのに ${f.mode} k=${f.k}`);
            if (f.devW < g.devW || f.devH < g.devH) why.push(`${tag}: 整数倍（${g.devW}×${g.devH}）より小さい`);
          } else if (JSON.stringify(f) !== JSON.stringify(g) || f.mode !== "down") why.push(`${tag}: 小さい枠で V192 と違う（${f.mode} ${f.devW}×${f.devH} ／ ${g.mode} ${g.devW}×${g.devH}）`);
        }
  // ★再生画面の道そのもの（library.ts の previewFit を取り出して、偽の枠で動かす）
  const text = fnText(T.read("src/library.ts"), "previewFit");
  if (!text) return ng("library.ts に previewFit が無い（検査の窓が壊れた）");
  const js = ts.transpileModule(text.replace(/^private\s+/, "function "), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const SV = (await import(pathToFileURL(path.join(T.root, "src/editor/scaledView.ts")).href + `?t=${Date.now()}${Math.random()}`)) as typeof import("../src/editor/scaledView");
  const rows: string[] = [];
  for (const dpr of [1, 1.25, 1.5, 2])
    for (const [bw, bh] of [[632, 527], [718, 495], [792, 627], [952, 665], [1272, 845], [1912, 1205], [400, 300], [320, 240], [640, 480], [300, 200]] as const)
      for (const [sw, sh] of [[320, 240], [256, 192]] as const) {
        const host = fakeBox(bw, bh);
        const got = await withFakeDom(dpr, () => {
          const self = { previewFitCache: null as unknown };
          const pf = new Function("$", "fitFor", `"use strict"; return (${js.trim().replace(/;$/, "")});`)(() => ({ parentElement: host }), SV.fitFor);
          return pf.call(self, sw, sh) as import("../src/editor/downscale").DisplayFit | null;
        });
        const want = fitDisplay(bw, bh, dpr, sw, sh, true);
        if (!got || JSON.stringify(got) !== JSON.stringify(want)) why.push(`previewFit ${sw}×${sh} 枠 ${bw}×${bh} dpr ${dpr}: ${got ? `${got.mode} ${got.devW}×${got.devH}` : "null"}（枠いっぱいは ${want.mode} ${want.devW}×${want.devH}）`);
        if (report && sw === 320) rows.push(`    ${bw}×${bh} @${dpr} → ${want.mode === "up" ? "k=" + want.k : want.mode} ${want.devW}×${want.devH}（${(want.devW / sw).toFixed(3)} 倍）／V192 ${fitDisplay(bw, bh, dpr).mode === "up" ? "k=" + fitDisplay(bw, bh, dpr).k : "縮める"} ${fitDisplay(bw, bh, dpr).devW}×${fitDisplay(bw, bh, dpr).devH}`);
      }
  if (report) {
    log("  [S-9] 再生画面（previewFit・320×240）: 枠（中身・CSS px）@dpr → 今 ／ V192");
    for (const r of rows) log(r);
  }
  return why.length ? ng(`NG ${why.length} 件（${n} 通り＋previewFit 80 通り中）: ${why.slice(0, 4).join("／")}`) : ok();
}

/** 整数 k 倍の最近傍（正解の写し）。透明（alpha 0）の画素は 0,0,0,0 として比べる——透明の RGB は見えない
 *  （面積平均は透明を「透明のまま」0 にする＝V192 の (e)。compositeFrame も透明は 0,0,0,0 しか作らない） */
function nearestUp(src: Uint8ClampedArray, sw: number, sh: number, k: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(sw * k * sh * k * 4);
  for (let y = 0; y < sh * k; y++)
    for (let x = 0; x < sw * k; x++) {
      const s0 = (((y / k) | 0) * sw + ((x / k) | 0)) * 4;
      const o = (y * sw * k + x) * 4;
      if (src[s0 + 3] === 0) continue;
      for (let c = 0; c < 4; c++) out[o + c] = src[s0 + c];
    }
  return out;
}
let oldDS: DS | null = null;
async function loadOldDS(): Promise<DS> {
  if (oldDS) return oldDS;
  const src = execFileSync("git", ["show", "1374308:src/editor/downscale.ts"], { cwd: root, encoding: "utf8" });
  const dir = path.join(tmpRoot, "v192-1374308");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "downscale.ts"), src);
  oldDS = (await import(pathToFileURL(path.join(dir, "downscale.ts")).href)) as DS;
  return oldDS;
}
async function S10(T: Tree): Promise<V> {
  const D = await loadDS(T);
  const why: string[] = [];
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
  const noise = (sw: number, sh: number) => {
    const s0 = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < sw * sh; i++) {
      const t = rnd();
      s0[i * 4] = (rnd() * 256) | 0;
      s0[i * 4 + 1] = (rnd() * 256) | 0;
      s0[i * 4 + 2] = (rnd() * 256) | 0;
      s0[i * 4 + 3] = t < 0.2 ? 0 : t < 0.3 ? (rnd() * 256) | 0 : 255;
    }
    return s0;
  };
  const rb = checker(320, 240, RED2, BLUE);
  // (a) ちょうど 2・3・4 倍は最近傍と 1 画素も違わない（一松柄と乱数）
  for (const k of [2, 3, 4])
    for (const [nm, src0] of [["一松柄", rb], ["乱数", noise(320, 240)]] as const) {
      const a = D.downscaleArea(src0, 320, 240, 320 * k, 240 * k);
      const b = nearestUp(src0, 320, 240, k);
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      if (diff) why.push(`(a) ${nm} ${k} 倍: 最近傍と ${diff} 値違う`);
    }
  // (b) 3.47 倍・1.94 倍の一松柄: どのドットも同じ大きさ（中身 floor(s)−1〜floor(s)・境目は 1 画素）・境目の色は面積の正解と ±1
  for (const s of [3.47, 1.94]) {
    const dw = Math.round(320 * s);
    const dh = Math.round(240 * s);
    const o = D.downscaleArea(rb, 320, 240, dw, dh);
    const ref = oracle(rb, 320, 240, dw, dh);
    let bad = 0;
    for (let i = 0; i < o.length; i++) if (Math.abs(o[i] - ref[i]) > 1) bad++;
    if (bad) why.push(`(b) ${s} 倍: 面積の正解と ±1 を外れた値 ${bad}`);
    // 形で見る: 縦に 1 画素だけの行（元の行 iy の中に丸ごと入る行）で、各画素が覆う元の列を整数で数える
    //（出す画素 x は元の [x·320/dw, (x+1)·320/dw)）。元の 1 列の中に丸ごと入る画素（ドットの中身）は**そのドットの色ちょうど**、
    // 2 列にまたがる画素（境目）だけが混ざる。ドットの中身の画素の数は floor(s)−1〜floor(s)（＝どのドットも同じ大きさ±1）。
    // 列（縦）も同じ。境目は 1 画素だけ（出す 1 画素は元の 1 画素より小さい＝2 つ以上の境目にはかからない）
    const lens = new Map<number, number>();
    let runBad = 0;
    let pureBad = 0;
    const axisCheck = (n: number, d: number, at: (i: number, j: number) => number, srcAt: (i: number, a: number) => number, other: number, otherSrc: (j: number) => number) => {
      // n: 元の長さ・d: 出す長さ・at(出す位置, もう一方の出す位置) → 出す画素の番号・srcAt(元の位置, もう一方の元の位置) → 元の画素の番号
      for (let j = 0; j < other; j++) {
        const oj = otherSrc(j);
        if (oj < 0) continue; // もう一方の向きで境目（混ざる）の行・列は見ない
        const inner = new Int32Array(n);
        for (let x = 0; x < d; x++) {
          const i0 = Math.floor((x * n) / d);
          const i1 = Math.floor(((x + 1) * n - 1) / d);
          if (i0 !== i1) continue;
          inner[i0]++;
          const o = at(x, j) * 4;
          const q = srcAt(i0, oj) * 4;
          if (o4(o, q)) pureBad++;
        }
        for (let i = 1; i < n - 1; i++) {
          lens.set(inner[i], (lens.get(inner[i]) ?? 0) + 1);
          if (inner[i] < Math.floor(d / n) - 1 || inner[i] > Math.floor(d / n)) runBad++;
        }
      }
    };
    const o4 = (o: number, q: number) => outv[o] !== rb[q] || outv[o + 1] !== rb[q + 1] || outv[o + 2] !== rb[q + 2] || outv[o + 3] !== rb[q + 3];
    const outv = o;
    const singleOf = (x: number, n: number, d: number) => {
      const i0 = Math.floor((x * n) / d);
      return i0 === Math.floor(((x + 1) * n - 1) / d) ? i0 : -1;
    };
    // 行（横の並び）: 縦に 1 画素だけの行 y
    axisCheck(320, dw, (x, y) => y * dw + x, (i, iy) => iy * 320 + i, dh, (y) => singleOf(y, 240, dh));
    // 列（縦の並び）: 横に 1 画素だけの列 x
    axisCheck(240, dh, (y, x) => y * dw + x, (i, ix) => i * 320 + ix, dw, (x) => singleOf(x, 320, dw));
    // ⚠ runBad（中身の画素の数）は形（整数の区間）だけから決まる＝出力に依らない（どの作りでも同じ）。出力で見ているのは
    //   pureBad（中身の画素がそのドットの色ちょうど）と、上の「面積の正解と ±1」（境目の色）
    if (runBad || pureBad) why.push(`(b) ${s} 倍: ドットの中身の画素の数が floor(s)−1〜floor(s) を外れた ${runBad}・ドットの中身なのに色がちょうどでない ${pureBad}`);
    if (REPORT && T === realTree) log(`  [S-10] ${s} 倍（${dw}×${dh}）: ドットの中身の画素の数 ${[...lens.entries()].sort((a, b) => a[0] - b[0]).map(([l, c]) => `${l} 画素 ×${c}`).join("・")}（縦横の並び・端のドットを除く）／中身の色がちょうどでない ${pureBad}／境目（混ざる画素）が面積の正解と ±1 を外れた値 ${bad}`);
  }
  // (c) 単色は単色・透明は V192 と同じ（透明は 0・半分は色はそのまま α が面積）
  for (const col of [[0, 0, 0], [255, 255, 255], [12, 200, 77]]) {
    const o = D.downscaleArea(checker(320, 240, col, col), 320, 240, 1110, 833);
    const ds = distinct(o, 1110 * 833);
    if (ds.length !== 1 || ds[0] !== col.join(",")) why.push(`(c) 単色 ${col} が ${ds.slice(0, 3).join(" / ")}`);
  }
  {
    const o = D.downscaleArea(checker(320, 240, [255, 0x10, 0x10, 255], [0, 0, 0, 0]), 320, 240, 1110, 833);
    let bad = 0;
    for (let i = 0; i < 1110 * 833; i++) {
      const a = o[i * 4 + 3];
      if (a === 0) {
        if (o[i * 4] || o[i * 4 + 1] || o[i * 4 + 2]) bad++;
      } else if (o[i * 4] !== 255 || o[i * 4 + 1] !== 0x10 || o[i * 4 + 2] !== 0x10) bad++;
    }
    if (bad) why.push(`(c) 赤と透明: 色が赤でない／透明に色がある画素 ${bad}`);
  }
  // (d) V192 の関数（1374308）と全画素で同じ（近道が答えを変えていない）。広げる・縮める・乱数・一松柄・透明・
  //     少ない色（4 色を画素ごとに選ぶ／同じ色が続く 5 色）——覚えの鍵（2 画素）の 2 つ目を落とす形は、2 色の交互や乱数では
  //     答えが変わらないので、少ない色で隣の組み合わせが入れ替わる絵が要る（レビュー指摘・反証 ⑫）
  const pal4 = [[255, 255, 255, 255], [0, 0, 0, 255], [255, 23, 23, 255], [0, 56, 206, 255], [12, 200, 77, 255]];
  const fewColors = (sw: number, sh: number, nc: number, runs: boolean) => {
    const s0 = new Uint8ClampedArray(sw * sh * 4);
    let c = 0;
    for (let i = 0; i < sw * sh; i++) {
      if (!runs || rnd() < 0.3) c = (rnd() * nc) | 0;
      const col = pal4[c];
      s0[i * 4] = col[0];
      s0[i * 4 + 1] = col[1];
      s0[i * 4 + 2] = col[2];
      s0[i * 4 + 3] = col[3];
    }
    return s0;
  };
  const O = await loadOldDS();
  for (const [sw, sh, dw, dh] of [[320, 240, 1126, 845], [320, 240, 1606, 1205], [320, 240, 1264, 948], [320, 240, 1110, 833], [320, 240, 621, 466], [256, 192, 1126, 845], [320, 240, 140, 105], [320, 240, 69, 52], [320, 240, 296, 222], [320, 240, 333, 250]] as const)
    for (const [nm, src0] of [["乱数", noise(sw, sh)], ["一松柄", checker(sw, sh, RED2, BLUE)], ["赤と透明", checker(sw, sh, [255, 0x10, 0x10, 255], [0, 0, 0, 0])], ["4 色", fewColors(sw, sh, 4, false)], ["5 色・続く", fewColors(sw, sh, 5, true)]] as const) {
      const a = D.downscaleArea(src0, sw, sh, dw, dh);
      const b = O.downscaleArea(src0, sw, sh, dw, dh);
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      if (diff) why.push(`(d) ${nm} ${sw}×${sh}→${dw}×${dh}: V192 の関数と ${diff} 値違う`);
    }
  if (D.resampleArea !== D.downscaleArea) why.push("resampleArea が downscaleArea と別の関数（式が 2 つに分かれた）");
  return why.length ? ng(why.slice(0, 6).join("／")) : ok();
}

async function S11(T: Tree) {
  const D = await loadDS(T);
  const typical = new Uint8ClampedArray(320 * 240 * 4);
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 320; x++) {
      const o = (y * 320 + x) * 4;
      const c = x > 40 && x < 200 && y > 30 && y < 180 ? ((x + y) & 1 ? RED2 : BLUE) : x % 37 === 0 || y % 23 === 0 ? [0, 0, 0] : WHITE;
      typical[o] = c[0];
      typical[o + 1] = c[1];
      typical[o + 2] = c[2];
      typical[o + 3] = 255;
    }
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
  const noise = new Uint8ClampedArray(320 * 240 * 4).map((_, i) => (i % 4 === 3 ? 255 : (rnd() * 256) | 0));
  const cases: [string, number, number, number][] = [
    ["1920×1080 の窓（枠 1272×845・dpr 1）", 1272, 845, 1],
    ["2560×1440 の窓（枠 1912×1205・dpr 1）", 1912, 1205, 1],
    ["1280×800 の窓（枠 632×527・dpr 2）", 632, 527, 2],
    ["1440×900 の窓（枠 792×627・dpr 2）", 792, 627, 2],
    ["2560×1440 の窓（枠 1912×1205・dpr 2）", 1912, 1205, 2],
  ];
  for (const [nm, bw, bh, dpr] of cases) {
    const f = D.fitDisplay(bw, bh, dpr, 320, 240, true);
    const cells: string[] = [];
    for (const [cn, src0] of [["一松柄", checker(320, 240, RED2, BLUE)], ["ふつうの絵", typical], ["乱数（最悪）", noise]] as const) {
      const out = new Uint8ClampedArray(f.devW * f.devH * 4);
      for (let i = 0; i < 10; i++) D.downscaleArea(src0, 320, 240, f.devW, f.devH, out);
      const ts: number[] = [];
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        D.downscaleArea(src0, 320, 240, f.devW, f.devH, out);
        ts.push(performance.now() - t0);
      }
      ts.sort((a, b) => a - b);
      cells.push(`${cn} ${ts[30].toFixed(2)}／${ts[57].toFixed(2)} ms`);
    }
    log(`  [S-11] ${nm} → ${f.mode} ${f.devW}×${f.devH}: 面積平均 1 回（合成と putImageData は含まない）${cells.join("・")}（中央／95%）`);
  }
}

function S12(T: Tree): V {
  const why: string[] = [];
  const lib = T.read("src/library.ts");
  const ed = readEd(T);
  const sv = T.read("src/editor/scaledView.ts");
  const ds = T.read("src/editor/downscale.ts");
  const pfx = noComments(fnText(lib, "previewFit") ?? "");
  if (!/fitFor\(host, sw, sh, true\)/.test(pfx)) why.push("再生画面（previewFit）が枠いっぱい（fitFor の fill）を通らない");
  for (const fn of ["drawNoteFrame", "drawPreview"]) {
    const b = noComments(fnText(lib, fn) ?? "");
    if (!/this\.previewFit\(/.test(b) || !/\bpresentFit\(/.test(b)) why.push(`${fn} が previewFit → presentFit を通らない`);
  }
  // ほかの所は V192 のまま（整数倍・fill を使わない）
  const fillCalls = [...noComments(lib).matchAll(/fitFor\([^)]*,\s*true\)/g)].length + [...noComments(ed).matchAll(/fitFor\([^)]*,\s*true\)/g)].length;
  if (fillCalls !== 1) why.push(`fitFor(…, true) が再生画面の 1 か所でない（${fillCalls} か所）`);
  const pt = noComments(fnText(lib, "paintThumb") ?? "");
  if (!/fitDisplay\(b\.w, b\.h, currentDpr\(\), w, h\)/.test(pt)) why.push("サムネ（paintThumb）の大きさが V192 の形でない");
  for (const [fn, re] of [["filmFitNow", /fitFor\(fr\)/], ["paintMini", /fitFor\(box\)/]] as const)
    if (!re.test(noComments(fnText(ed, fn) ?? ""))) why.push(`${fn} の大きさが V192 の形（整数倍）でない`);
  if (!/apFit = wrap \? fitFor\(wrap\) : null/.test(noComments(fnText(ed, "drawTrialFrame") ?? ""))) why.push("音の窓（drawTrialFrame）の大きさが V192 の形でない");
  // presentFit: "fill" は面積平均の枝（drawImage を使わない）
  const pf = noComments(fnText(sv, "presentFit") ?? "");
  if (!/if \(fit\.mode === "down" \|\| fit\.mode === "fill"\) \{/.test(pf)) why.push('presentFit の面積平均の枝が "fill" を受けない');
  if (!/export const resampleArea = downscaleArea;/.test(ds)) why.push("resampleArea が downscaleArea の別名でない");
  return why.length ? ng(why.join("／")) : ok();
}

// ================= 写し（[S-8] 反証） =================
const COPY_FILES = ["src/editor/downscale.ts", "src/editor/scaledView.ts", "src/library.ts", "src/editor/editor.ts", "src/editor/core/editorCore.ts", "src/styles.css", "index.html", "src/main.ts", "src/editor/render.ts", "src/editor/serialize.ts", "src/editor/pv6.ts", "src/editor/model.ts", "src/editor/saveWorker.ts", "src/editor/saveCore.ts"]; // V201: 保存の共通の部品（[S-5] が読む）／V213: コア（readEd が読む・無い木では飛ばす）
const tmpRoot = path.join(root, "node_modules", ".v192-smoke", String(process.pid));
function copyTree(tag: string, mutate?: (rel: string, s: string) => string): Tree {
  const dir = path.join(tmpRoot, tag);
  for (const rel of COPY_FILES) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    let s = fs.readFileSync(src, "utf8");
    if (mutate) s = mutate(rel, s);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), s);
  }
  return { root: dir, read: (rel) => lf(fs.readFileSync(path.join(dir, rel), "utf8")) };
}
function mustReplace(s: string, from: string | RegExp, to: string, what: string): string {
  const t = s.replace(from, to);
  if (t === s) throw new Error(`反証の書き換えが当たらない: ${what}`);
  return t;
}

// ================= 走らせる =================
async function main() {
  const r1 = await safe(() => S1(realTree));
  check("[S-1] 面積平均の純関数（一松柄の中間・作者の数 (188,43,152)・正解と ±1・単色・線・範囲）", r1.ok, r1.why);
  const r2 = await safe(() => S2());
  check("[S-2] ★今の最近傍は [S-1] の基準で赤・80×60 は 1 色だけ残る", r2.ok, r2.why);
  const r3 = await safe(() => S3(realTree, REPORT));
  check("[S-3] 整数倍（k が整数・入るいちばん大きい・dpr を掛ける・小さい枠は縮める）", r3.ok, r3.why);
  const r4 = await safe(() => S4(realTree));
  check("[S-4] 静的（CSS で引き伸ばさない・全部 presentFit・縮める枝は downscaleArea・作り直し）", r4.ok, r4.why);
  const r5 = await safe(() => S5(realTree));
  check("[S-5] データを変えない（保存するサムネの PNG が前と同じ・render/serialize/pv6/model は V192 の前と同じ・saveWorker は V197 の形）", r5.ok, r5.why);
  const r6 = await safe(() => S6(realTree));
  check("[S-6] 透明の紙（透明のまま混ぜる・paper-clear はそのまま）", r6.ok, r6.why);
  await safe(async () => (await S7(realTree), ok()));
  const r9 = await safe(() => S9(realTree, REPORT));
  check("[S-9] V192b 枠いっぱい（入る・4:3・縦か横が枠と一致・整数倍だけ up・小さい枠は V192 のまま・previewFit が同じ）", r9.ok, r9.why);
  const r10 = await safe(() => S10(realTree));
  check("[S-10] V192b 混ぜ方（整数倍は最近傍と同じ・半端な倍率でドットの大きさがそろう・境目は面積どおり・V192 の関数と全画素同じ）", r10.ok, r10.why);
  await safe(async () => (await S11(realTree), ok()));
  const r12 = await safe(() => S12(realTree));
  check("[S-12] V192b 静的（再生画面だけ fill・ほかは V192 のまま・fill は面積平均の枝・式は 1 つ）", r12.ok, r12.why);

  // [S-0] / [S-8]
  try {
    const plain = copyTree("plain");
    const z = [await safe(() => S1(plain)), await safe(() => S3(plain)), await safe(() => S4(plain)), await safe(() => S5(plain)), await safe(() => S9(plain)), await safe(() => S10(plain)), await safe(() => S12(plain))];
    check("[S-0] 無改変の写しでは [S-1][S-3][S-4][S-5][S-9][S-10][S-12] が緑", z.every((x) => x.ok), z.map((x) => x.why).filter(Boolean).join("／"));

    const muts: { id: string; what: string; run: (T: Tree) => Promise<V> | V; mut: (rel: string, s: string) => string }[] = [
      {
        id: "①",
        what: "純関数を最近傍に戻す",
        run: S1,
        mut: (rel, s) =>
          rel !== "src/editor/downscale.ts"
            ? s
            : mustReplace(s, "export function downscaleArea(", "function downscaleArea_v192(", "downscaleArea") +
              `\nexport function downscaleArea(src: Uint8ClampedArray | Uint8Array, sw: number, sh: number, dw: number, dh: number, out?: Uint8ClampedArray): Uint8ClampedArray {
  void downscaleArea_v192;
  const d = out && out.length === dw * dh * 4 ? out : new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw)), sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let c = 0; c < 4; c++) d[(y * dw + x) * 4 + c] = src[(sy * sw + sx) * 4 + c];
  }
  return d;
}\n`,
      },
      {
        id: "②",
        what: "整数倍を floor しない（実数倍）",
        run: S3,
        mut: (rel, s) =>
          rel !== "src/editor/downscale.ts"
            ? s
            : mustReplace(
                s,
                "if (k >= 1 && !fill) return { mode: \"up\", k, devW: sw * k, devH: sh * k, cssW: (sw * k) / r, cssH: (sh * k) / r };",
                "const kr = Math.min(bw / sw, bh / sh); if (k >= 1 && !fill) return { mode: \"up\", k: kr, devW: Math.floor(sw * kr), devH: Math.floor(sh * kr), cssW: Math.floor(sw * kr) / r, cssH: Math.floor(sh * kr) / r };",
                "fitDisplay の k",
              ),
      },
      {
        id: "③",
        what: "devicePixelRatio を掛け忘れる",
        run: S3,
        mut: (rel, s) =>
          rel !== "src/editor/downscale.ts" ? s : mustReplace(s, "const r = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;", "const r = 1; void dpr;", "fitDisplay の dpr"),
      },
      {
        id: "④",
        what: "コマ一覧だけ presentFit を通さない（前の drawImage で 80×60 へ）",
        run: S4,
        mut: (rel, s) =>
          rel !== "src/editor/editor.ts"
            ? s
            : mustReplace(
                s,
                /presentFit\(el, rgbaOf\(([^)]*\))\), W, H, fit\);/,
                "const ctx4 = el.getContext(\"2d\")!; ctx4.imageSmoothingEnabled = false; presentToCanvas($1, this.filmScratchCv()); ctx4.drawImage(this.filmScratchCv(), 0, 0, el.width, el.height); void fit;",
                "paintFilmThumb の presentFit",
              ),
      },
      {
        id: "⑤",
        what: "サムネの PNG を縮めて保存する（.kwz の canvas を 80×60 に drawImage してから toBlob）",
        run: S5,
        mut: (rel, s) =>
          rel !== "src/library.ts"
            ? s
            : mustReplace(s, "ctx.putImageData(imgData, 0, 0);", "ctx.putImageData(imgData, 0, 0); canvas.width = 80; canvas.height = 60; ctx.drawImage(canvas, 0, 0, 80, 60);", ".kwz のサムネの putImageData"),
      },
      {
        id: "⑥",
        what: "サムネの PNG を読むときにブラウザで縮める（drawImage に大きさを渡す）",
        run: S4,
        mut: (rel, s) =>
          rel !== "src/editor/scaledView.ts" ? s : mustReplace(s, "ctx.drawImage(img, 0, 0);", "ctx.drawImage(img, 0, 0, 140, 105);", "decodeImageRgba の drawImage"),
      },
      {
        id: "⑦",
        what: "コマ一覧の見えなくなったサムネを手放さない（F-0）",
        run: S4,
        mut: (rel, s) =>
          rel !== "src/editor/editor.ts" ? s : mustReplace(s, "            releaseCanvas(cv);\n            continue;", "            continue;", "rebuildFilm の releaseCanvas"),
      },
      {
        id: "⑧",
        what: "ライブラリの見えなくなったサムネを手放さない",
        run: S4,
        mut: (rel, s) =>
          rel !== "src/library.ts" ? s : mustReplace(s, "            releaseCanvas(cv);\n            continue;", "            continue;", "renderShelf の releaseCanvas"),
      },
      {
        id: "⑨",
        what: "再生画面を整数倍に戻す（previewFit が fill を渡さない）",
        run: S9,
        mut: (rel, s) => (rel !== "src/library.ts" ? s : mustReplace(s, "fitFor(host, sw, sh, true)", "fitFor(host, sw, sh)", "previewFit の fill")),
      },
      {
        id: "⑩",
        what: "半端な倍率を最近傍で広げる（広げる向きだけ最近傍）",
        run: S10,
        mut: (rel, s) =>
          rel !== "src/editor/downscale.ts"
            ? s
            : mustReplace(
                s,
                "  const tx = axisTable(sw, dw);\n  const ty = axisTable(sh, dh);\n  const ncx = tx.ncls;",
                "  if (dw > sw) {\n    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const q = (Math.floor((y * sh) / dh) * sw + Math.floor((x * sw) / dw)) * 4; for (let c = 0; c < 4; c++) dst[(y * dw + x) * 4 + c] = src[q + c]; }\n    return dst;\n  }\n  const tx = axisTable(sw, dw);\n  const ty = axisTable(sh, dh);\n  const ncx = tx.ncls;",
                "downscaleArea の始め",
              ),
      },
      {
        id: "⑪",
        what: "整数倍のときにも混ぜる（広げるとき境目を半分ずらす）",
        run: S10,
        mut: (rel, s) =>
          rel !== "src/editor/downscale.ts"
            ? s
            : mustReplace(s, "    const lo = j * s; // 単位 1/d の元の座標\n    const hi = (j + 1) * s;", "    const lo = j * s + (d > s ? Math.floor(s / 2) : 0); // 単位 1/d の元の座標\n    const hi = lo + s;", "axisTable の区間"),
      },
      {
        id: "⑫",
        what: "覚えの鍵から 2 つ目の画素を落とす（1 つ目の画素だけで覚えを引く）",
        run: S10,
        mut: (rel, s) => {
          if (rel !== "src/editor/downscale.ts") return s;
          let t = s;
          for (const [a, b] of [
            ["cm.a0[c] === kA && cm.b0[c] === kB", "cm.a0[c] === kA"],
            ["cm.a1[c] === kA && cm.b1[c] === kB", "cm.a1[c] === kA"],
            ["rA0 === kA && rB0 === kB", "rA0 === kA"],
            ["rA1 === kA && rB1 === kB", "rA1 === kA"],
          ])
            t = mustReplace(t, a, b, `覚えの鍵 ${a}`);
          return t;
        },
      },
    ];
    for (const m of muts) {
      let r: V;
      try {
        const T = copyTree(`m${muts.indexOf(m)}`, m.mut);
        r = await safe(() => m.run(T));
      } catch (e) {
        r = { ok: true, why: `写しを作れない: ${(e as Error).message}`, threw: true };
      }
      const caught = !r.ok && !r.threw;
      check(`[S-8] 反証${m.id} ${m.what} → 赤`, caught, caught ? "" : `赤にならない（${r.why || "緑のまま"}）`);
      if (REPORT || !caught) log(`  [S-8] ${m.id} ${m.what}: ${caught ? "赤 — " + r.why.slice(0, 160) : "×"}`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    try {
      fs.rmdirSync(path.dirname(tmpRoot));
    } catch {
      /* ほかの pid の写しが残っていれば消さない */
    }
  }

  console.log(`v192_smoke: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
void main();
