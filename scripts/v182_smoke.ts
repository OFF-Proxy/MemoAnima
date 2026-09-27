// V182 スモーク（A-79）: 画像を 1:1・整数倍で取り込むと、隣の画素と混ざる
//   要件 docs/REQ_import_one_to_one.md §5 ／ 指示書 docs/handoff/SEND_TO_CODE_V182.html [C]
//   実行: npx tsx scripts/v182_smoke.ts   （引数不要・反証込みで約 70 秒）
//         npx tsx scripts/v182_smoke.ts --no-mutants   … [S-1]〜[S-4] だけ（[S-0]・反証・[S-5] の記録を除く＝約 15 秒。
//                                                         赤先行の確認・各コミットへの当て直し・自前の書き換えの判定用）
//
// 直すのは src/editor/imageConvert.ts の sourceSpans() の**倍率 1 の枝（!zoomed）だけ**: 元画像のどこからどこまでを
// 平均するかを、浮動小数 (k / d) * s から**整数の割り算** (k * s) / d へ（倍率を上げたときの縮小の枝と同じ式）。
//
// ★見るのは**動かした結果（出力画素）**。期待値は製品の式を写さず、別の計算（元の画素そのもの・きっちりした四角の平均・
//   BigInt の割り算で求めた範囲）で作る。置き場所（canvasPlacement）はこの回で触らないので、この回の前の式の写しを物差しにする。
// ★反証は**実ファイルを書き換えた写し**で当てる（V179 と同じ仕組み）: src/ を node_modules/.v182-smoke/<pid>/ へ写し、
//   src/editor/imageConvert.ts の 1 か所だけを書き換えて、本物と同じ import の道で読む。
//   書き換えがちょうど 1 か所に当たらなければ赤。**例外で落ちた反証は「効いた」と数えない**。
//
//   [S-0] 無改変の写しでは全部緑（写しの仕組みが赤を作っていない）
//   [S-1] ★ぴったり: 1:1 は元の画素そのもの・2/3/4/5/8 倍は同じ色の四角・半分/3 分の 1/4 分の 1/5 分の 1 はきっちりした四角の平均
//         （乱数の画像・cover / contain・はみ出す 1:1（400×240）と位置・余白つき（256×240 contain）も）。この回の前は赤（1:1 で 1,280 画素）
//   [S-2] ★変わるのは倍率 1 の範囲の式だけ:
//         (a) 倍率 1 の出力＝**BigInt の整数の割り算**で求めた範囲の平均（いろいろな大きさ × cover/contain × 位置 × 明るさ・コントラスト）
//         (b) 倍率 >1 はこの回の前（blob b3a0775）とバイト一致（大きさ × 2 択 × 倍率 × 位置）
//         (c) 変換一式（量子化・ディザ・トーン・線画まで）が、この回の前の blob に [A] の 1 点だけを当てた写しと 1 バイトも違わない
//         (d) imageConvert.ts の**コメントを除いたコード**が、この回の前の blob に [A] の 1 点だけを当てた写しと 1 文字も違わない
//             （TypeScript でコメントを落として JS にして比べる＝空白・改行・コメントの書き換えでは変わらず、コードの 1 文字で変わる）
//         ★(c)(d) は**この回の差分（「この回の前＋[A]」）の確認**。次に imageConvert.ts を変える回では、ここが赤になるのが正しい
//           （v179 の [S-1] を V182 で置き換えたのと同じ作法）: その回の報告書に理由を書き、BASELINE_BLOB をその回の前の blob に、
//           FIX_A をその回の 1 点に置き換える。[A] が blob に当たらないときは黙って飛ばさず赤にする（git と blob が無いときだけ SKIP）
//           ※(d) はコードの字面なので、振る舞いが同じ書き換え（`| 0` など）でも赤になる。反証の数え方では (a)〜(c) と分けて見る
//   [S-3] 等倍でない拡大（256×192 ほか）は混ぜるまま（G-2）:
//         (a) この回の前も誤差の無かった大きさ（256×192・128×96・97×61・300×225）は、この回の前とバイト一致
//         (b) 境目をまたぐ出力の画素は、またいだ 2 画素（縦横なら 4 画素）の平均のまま（数は BigInt の計算と一致・0 でない）
//         (c) この回の前と違う画素は、どれも前の式が浮動小数の誤差で**隣の画素を余計に拾っていた**所だけ（混ぜるべき所は減らしていない）
//   [S-4] 取り込める上限（main.ts の長辺 MAXSIDE・倍率 8 まで）と、上限の無い CLI/MCP の極端な細長で、範囲が溢れない・
//         元画像の外へ出ない（BigInt の範囲の平均と一致）。★(k+1)·s が 2^53 を超える大きさ（24,333,387×7 ほか・画素は作らずに
//         読むたびに色を返す）でも一致＝倍率 1 の枝の BigInt の道（Codex 3 回目の低）。d·s の最大と 2^53 の比を記録する
//   [S-5] 色を減らしたあとの差（写真に近い画像・既定の設定）を**数えて記録**（判定ではない）
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

const root = path.resolve(import.meta.dirname, "..");
const W = 320;
const H = 240;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = Record<string, any>;
interface Img {
  w: number;
  h: number;
  data: Uint8Array | Uint8ClampedArray;
}
type Fit = "cover" | "contain";
const FITS: Fit[] = ["cover", "contain"];
type Center = { x: number; y: number } | undefined;
const fmt = (n: number) => n.toLocaleString("en-US");

// ================= 絵の素（乱数は種で固定＝毎回同じ） =================
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 画素ごとにばらばらの色（α もばらばら＝変換が α を見ないことも一緒に固定する） */
function randImg(w: number, h: number, seed: number): Img {
  const r = rng(seed);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
  return { w, h, data };
}
/** 大きい画像用のばらばらの色（画素ごとの整数ハッシュ＝乱数を 1 バイトずつ引くより速い） */
function hashImg(w: number, h: number, seed: number): Img {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 7, 0x85ebca6b) ^ Math.imul(seed, 0xc2b2ae35);
      v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
      v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
      v ^= v >>> 16;
      const i = (y * w + x) * 4;
      data[i] = v & 255;
      data[i + 1] = (v >>> 8) & 255;
      data[i + 2] = (v >>> 16) & 255;
      data[i + 3] = v >>> 24;
    }
  return { w, h, data };
}
/** 写真に近い画像（なめらかな明るさの変化＋大きな色むら＋細かいゆらぎ・不透明）。[S-5] の記録用。
 *  sin(A + B) = sin A cos B + cos A sin B で横と縦に分けて表を作る（4032×3024 でも速い） */
function photoImg(w: number, h: number, seed: number): Img {
  const r = rng(seed);
  const waves = Array.from({ length: 5 }, () => ({
    fx: (0.5 + r() * 3) / w,
    fy: (0.5 + r() * 3) / h,
    ph: r() * Math.PI * 2,
    amp: [30 + r() * 50, 30 + r() * 50, 30 + r() * 50],
  }));
  const sx = waves.map((wv) => Float64Array.from({ length: w }, (_, x) => Math.sin(2 * Math.PI * wv.fx * x)));
  const cx = waves.map((wv) => Float64Array.from({ length: w }, (_, x) => Math.cos(2 * Math.PI * wv.fx * x)));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    // 縦の側（チャンネルごとに位相をずらす）
    const sy = waves.map((wv) => [0, 1, 2].map((c) => Math.sin(2 * Math.PI * wv.fy * y + wv.ph + c)));
    const cy = waves.map((wv) => [0, 1, 2].map((c) => Math.cos(2 * Math.PI * wv.fy * y + wv.ph + c)));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = 110 + (60 * x) / w - (40 * y) / h + c * 12;
        for (let k = 0; k < waves.length; k++) v += (waves[k].amp[c] / 3) * (sx[k][x] * cy[k][c] + cx[k][x] * sy[k][c]);
        v += (r() - 0.5) * 12;
        data[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
      data[i + 3] = 255;
    }
  }
  return { w, h, data };
}
const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** 出力の 2 枚で違う画素の数と最初の 1 つ */
function diffPixels(a: Img, b: Img): { n: number; first: string } {
  let n = 0;
  let first = "";
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) {
      if (!n)
        first = `(${p % W}, ${Math.floor(p / W)}) ${[0, 1, 2, 3].map((k) => a.data[i + k]).join(",")} ≠ ${[0, 1, 2, 3].map((k) => b.data[i + k]).join(",")}`;
      n++;
    }
  }
  return { n, first };
}

// ================= 物差し（製品の式を写さない・この回の前の置き場所だけは写す） =================
/** この回の前（blob b3a0775）の canvasPlacement の計算を写したもの。★書き換えない（置き場所はこの回で触らない）。
 *  本物・この回の前の blob と全部の組み合わせで一致することを [S-2] (a0) で確かめる */
function placeRef(w: number, h: number, fit: Fit, zoom?: number, center?: Center) {
  const s0 = fit === "cover" ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  const z = typeof zoom !== "number" || Number.isNaN(zoom) ? 1 : Math.min(8, Math.max(1, zoom));
  const dw = Math.max(1, Math.round(w * s0 * z));
  const dh = Math.max(1, Math.round(h * s0 * z));
  const ax = (c: number | undefined) => (typeof c === "number" && !Number.isNaN(c) ? Math.min(1, Math.max(0, c)) : 0.5);
  const place = (frame: number, d: number, c: number) =>
    d <= frame ? Math.floor((frame - d) / 2) : Math.min(0, Math.max(frame - d, Math.floor(frame / 2 - c * d)));
  return { dw, dh, dx0: place(W, dw, ax(center?.x)), dy0: place(H, dh, ax(center?.y)), zoomed: z > 1 };
}
type SpanFn = (d: number, s: number, k: number) => [number, number];
/** ★正解の範囲: 出力の画素 k が覆う元の区間 [k·s/d, (k+1)·s/d) に掛かる画素（BigInt の割り算＝丸めが入らない） */
const exactSpan: SpanFn = (d, s, k) => {
  const S = BigInt(s);
  const D = BigInt(d);
  const K = BigInt(k);
  const lo = (K * S) / D;
  const num = (K + 1n) * S;
  let c = num / D;
  if (c * D < num) c++;
  let hi = c - 1n;
  if (hi < lo) hi = lo;
  if (hi > S - 1n) hi = S - 1n;
  return [Number(lo), Number(hi)];
};
/** 倍率 >1（V179）の正解の範囲: 拡大は画素の中心に乗る 1 画素（最近傍）・縮小は exactSpan（BigInt） */
const zoomedSpan: SpanFn = (d, s, k) => {
  if (d > s) {
    const v = (BigInt(2 * k + 1) * BigInt(s)) / BigInt(2 * d);
    const n = Math.min(s - 1, Number(v));
    return [n, n];
  }
  return exactSpan(d, s, k);
};
/** この回の前（blob b3a0775）の倍率 1 の式を写したもの（浮動小数）。★書き換えない。[S-3] (c) で「何が変わったか」を説明する物差し。
 *  この回の前の blob の出力と全画素一致することを [S-3] (c) で確かめる */
const floatSpan: SpanFn = (d, s, k) => {
  const lo = Math.floor((k / d) * s);
  const hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) / d) * s) - 1));
  return [lo, hi];
};
/** 範囲の決め方 `span` と置き場所 placeRef で 320×240 を作る（平均は切り捨て＝Uint8Array への代入。余白は α=0） */
function refResize(img: Img, fit: Fit, zoom: number | undefined, center: Center, span: SpanFn): Img {
  const P = placeRef(img.w, img.h, fit, zoom, center);
  const out = new Uint8Array(W * H * 4);
  const x0 = Math.max(0, P.dx0);
  const x1 = Math.min(W, P.dx0 + P.dw);
  const y0 = Math.max(0, P.dy0);
  const y1 = Math.min(H, P.dy0 + P.dh);
  const xs: [number, number][] = [];
  for (let x = x0; x < x1; x++) xs.push(span(P.dw, img.w, x - P.dx0));
  for (let y = y0; y < y1; y++) {
    const [yA, yB] = span(P.dh, img.h, y - P.dy0);
    for (let x = x0; x < x1; x++) {
      const [xA, xB] = xs[x - x0];
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let sy = yA; sy <= yB; sy++)
        for (let sx = xA; sx <= xB; sx++) {
          const si = (sy * img.w + sx) * 4;
          r += img.data[si];
          g += img.data[si + 1];
          b += img.data[si + 2];
          n++;
        }
      const oi = (y * W + x) * 4;
      out[oi] = r / n;
      out[oi + 1] = g / n;
      out[oi + 2] = b / n;
      out[oi + 3] = 255;
    }
  }
  return { w: W, h: H, data: out };
}

// ================= 検査（どれも「赤の理由の一覧」を返す＝空なら緑） =================
type Check = (IC: Mod, ctx: Ctx, push: (s: string) => void) => void;
interface Ctx {
  /** この回の前の imageConvert（blob b3a0775 そのもの）。取り出せないときは null */
  OLD: Mod | null;
  /** この回の前の blob に [A] の 1 点（倍率 1 の範囲を整数の割り算に）だけを当てた写し。取り出せないときは null */
  OLDA: Mod | null;
  /** この回の前の blob に [A] の 1 点だけを当てた写しの本文（[S-2] (d)）。取り出せないときは null */
  OLDA_TEXT: string | null;
  /** 見ている木の根（本物＝リポジトリ・反証＝写し）。[S-2] (d) がそこの imageConvert.ts を読む */
  dir: string;
  /** 反証・[S-0] では最初の赤で止める（赤かどうかだけ分かればよい＝速い） */
  quick?: boolean;
}
/** コメントを除いたコード（TypeScript → JS。書式は印字し直すので、空白・改行・コメントの違いでは変わらない） */
function codeOnly(text: string): string {
  return ts.transpileModule(text, {
    compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}
/** quick のとき、最初の赤で検査を抜けるための印（run() が受け止めて「赤」として返す） */
class StopEarly extends Error {}
/** 赤の理由を足す口。quick なら最初の 1 件で抜ける */
function reasons(ctx: Ctx): { bad: string[]; push: (s: string) => void } {
  const bad: string[] = [];
  return {
    bad,
    push: (s: string) => {
      bad.push(s);
      if (ctx.quick) throw new StopEarly();
    },
  };
}
const BASELINE_BLOB = "b3a07751539ec2443db6012ff91c580227d2aee4"; // V181 まで（V179 で倍率・位置を足したあと）の imageConvert.ts

// ---------------- [S-1] ぴったり ----------------
interface ExactCase {
  name: string;
  w: number;
  h: number;
  fit: Fit;
  center?: { x: number; y: number };
  /** 期待の置き場所（手で計算した値＝製品の式を写さない） */
  dw: number;
  dh: number;
  dx0: number;
  dy0: number;
  /** f 倍の拡大（元の 1 画素 → f×f）／1/g の縮小（元の g×g → 1 画素） */
  up?: number;
  down?: number;
}
const EXACT: ExactCase[] = [
  { name: "1:1", w: 320, h: 240, fit: "cover", dw: 320, dh: 240, dx0: 0, dy0: 0, up: 1 },
  { name: "1:1", w: 320, h: 240, fit: "contain", dw: 320, dh: 240, dx0: 0, dy0: 0, up: 1 },
  { name: "1:1 はみ出す（3DS の上画面の大きさ）", w: 400, h: 240, fit: "cover", dw: 400, dh: 240, dx0: -40, dy0: 0, up: 1 },
  { name: "1:1 はみ出す・左端", w: 400, h: 240, fit: "cover", center: { x: 0, y: 0.5 }, dw: 400, dh: 240, dx0: 0, dy0: 0, up: 1 },
  { name: "1:1 はみ出す・右端", w: 400, h: 240, fit: "cover", center: { x: 1, y: 0.5 }, dw: 400, dh: 240, dx0: -80, dy0: 0, up: 1 },
  { name: "1:1 はみ出す・途中", w: 400, h: 240, fit: "cover", center: { x: 0.45, y: 0.9 }, dw: 400, dh: 240, dx0: -20, dy0: 0, up: 1 },
  { name: "1:1 余白つき", w: 256, h: 240, fit: "contain", dw: 256, dh: 240, dx0: 32, dy0: 0, up: 1 },
  { name: "1:1 余白つき（縦）", w: 320, h: 200, fit: "contain", dw: 320, dh: 200, dx0: 0, dy0: 20, up: 1 },
  { name: "2 倍", w: 160, h: 120, fit: "cover", dw: 320, dh: 240, dx0: 0, dy0: 0, up: 2 },
  { name: "2 倍", w: 160, h: 120, fit: "contain", dw: 320, dh: 240, dx0: 0, dy0: 0, up: 2 },
  { name: "2 倍 はみ出す", w: 200, h: 120, fit: "cover", dw: 400, dh: 240, dx0: -40, dy0: 0, up: 2 },
  { name: "2 倍 余白つき", w: 160, h: 100, fit: "contain", dw: 320, dh: 200, dx0: 0, dy0: 20, up: 2 },
  { name: "3 倍 はみ出す", w: 120, h: 80, fit: "cover", dw: 360, dh: 240, dx0: -20, dy0: 0, up: 3 },
  { name: "4 倍", w: 80, h: 60, fit: "cover", dw: 320, dh: 240, dx0: 0, dy0: 0, up: 4 },
  { name: "4 倍", w: 80, h: 60, fit: "contain", dw: 320, dh: 240, dx0: 0, dy0: 0, up: 4 },
  { name: "5 倍", w: 64, h: 48, fit: "cover", dw: 320, dh: 240, dx0: 0, dy0: 0, up: 5 },
  { name: "8 倍", w: 40, h: 30, fit: "contain", dw: 320, dh: 240, dx0: 0, dy0: 0, up: 8 },
  { name: "半分", w: 640, h: 480, fit: "cover", dw: 320, dh: 240, dx0: 0, dy0: 0, down: 2 },
  { name: "半分", w: 640, h: 480, fit: "contain", dw: 320, dh: 240, dx0: 0, dy0: 0, down: 2 },
  { name: "半分 はみ出す", w: 800, h: 480, fit: "cover", dw: 400, dh: 240, dx0: -40, dy0: 0, down: 2 },
  { name: "半分 はみ出す・右端", w: 800, h: 480, fit: "cover", center: { x: 1, y: 0 }, dw: 400, dh: 240, dx0: -80, dy0: 0, down: 2 },
  { name: "半分 余白つき", w: 640, h: 400, fit: "contain", dw: 320, dh: 200, dx0: 0, dy0: 20, down: 2 },
  { name: "3 分の 1", w: 960, h: 720, fit: "cover", dw: 320, dh: 240, dx0: 0, dy0: 0, down: 3 },
  { name: "4 分の 1", w: 1280, h: 960, fit: "contain", dw: 320, dh: 240, dx0: 0, dy0: 0, down: 4 },
  { name: "5 分の 1", w: 1600, h: 1200, fit: "cover", dw: 320, dh: 240, dx0: 0, dy0: 0, down: 5 },
];
const exactImgs = new Map<string, Img>();
function exactImg(c: ExactCase): Img {
  const key = `${c.w}x${c.h}`;
  let img = exactImgs.get(key);
  if (!img) exactImgs.set(key, (img = randImg(c.w, c.h, 182_000 + c.w * 7 + c.h)));
  return img;
}
const S1: Check = (IC, _ctx, push) => {
  for (const c of EXACT) {
    const img = exactImg(c);
    // 期待の置き場所が本物と同じか（手の計算の取り違えを防ぐ。置き場所はこの回で触らない）
    const P = IC.canvasPlacement(c.w, c.h, c.fit, undefined, c.center);
    if (P.dw !== c.dw || P.dh !== c.dh || P.dx0 !== c.dx0 || P.dy0 !== c.dy0) {
      push(`${c.name} ${c.w}×${c.h} ${c.fit}: 置き場所が期待（${c.dw}×${c.dh} @${c.dx0},${c.dy0}）と違う（${P.dw}×${P.dh} @${P.dx0},${P.dy0}）`);
      continue;
    }
    const outs: [string, Img][] = [["省略", IC.resizeToCanvas(img, c.fit, undefined, c.center) as Img]];
    outs.push(["倍率 1", IC.resizeToCanvas(img, c.fit, 1, c.center) as Img]);
    for (const [label, o] of outs) {
      let n = 0;
      let first = "";
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const oi = (y * W + x) * 4;
          const u = x - c.dx0;
          const v = y - c.dy0;
          const inside = u >= 0 && u < c.dw && v >= 0 && v < c.dh;
          let ok: boolean;
          let want = "";
          if (!inside) ok = o.data[oi + 3] === 0;
          else if (c.up) {
            const si = (Math.floor(v / c.up) * c.w + Math.floor(u / c.up)) * 4;
            ok = o.data[oi + 3] === 255 && o.data[oi] === img.data[si] && o.data[oi + 1] === img.data[si + 1] && o.data[oi + 2] === img.data[si + 2];
            want = `${img.data[si]},${img.data[si + 1]},${img.data[si + 2]}`;
          } else {
            const g = c.down!;
            const sums = [0, 0, 0];
            for (let dy = 0; dy < g; dy++)
              for (let dx = 0; dx < g; dx++) {
                const si = ((v * g + dy) * c.w + u * g + dx) * 4;
                for (let k = 0; k < 3; k++) sums[k] += img.data[si + k];
              }
            const e = sums.map((s) => Math.trunc(s / (g * g)));
            ok = o.data[oi + 3] === 255 && o.data[oi] === e[0] && o.data[oi + 1] === e[1] && o.data[oi + 2] === e[2];
            want = e.join(",");
          }
          if (!ok) {
            if (!n) first = `(${x}, ${y}) ${o.data[oi]},${o.data[oi + 1]},${o.data[oi + 2]},α${o.data[oi + 3]} ≠ ${want || "余白 α0"}`;
            n++;
          }
        }
      const what = c.up ? (c.up === 1 ? "元の画素と違う" : `${c.up}×${c.up} の元の画素と違う`) : `${c.down}×${c.down} の平均と違う`;
      if (n) push(`${c.name} ${c.w}×${c.h} ${c.fit}${c.center ? ` 位置(${c.center.x},${c.center.y})` : ""}（${label}）: ${what} ${fmt(n)} 画素（最初 ${first}）`);
    }
  }
};

// ---------------- [S-2] 変わるのは倍率 1 の範囲の式だけ ----------------
const NAMED: [number, number][] = [
  // Cowork の実測（要件 §2-2）の大きさ
  [320, 240],
  [160, 120],
  [80, 60],
  [640, 480],
  [1280, 960],
  [960, 720],
  [800, 600],
  [1600, 1200],
  [1440, 1080],
  [1024, 768],
  [2048, 1536],
  [1920, 1080],
  [1000, 1000],
  [256, 192],
  // ほか（等倍でない拡大・細長・奇数・1 画素）
  [240, 160],
  [256, 240],
  [400, 240],
  [100, 75],
  [97, 61],
  [200, 150],
  [288, 216],
  [480, 360],
  [333, 211],
  [211, 333],
  [700, 70],
  [641, 319],
  [321, 241],
  [319, 239],
  [1, 1],
  [1, 7],
  [7, 1],
  [3, 2],
];
const CENTERS: Center[] = [undefined, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.3, y: 0.7 }, { x: NaN, y: 2 }];
let corpusCache: { img: Img; centers: Center[] }[] | null = null;
function corpus() {
  if (corpusCache) return corpusCache;
  const list: { img: Img; centers: Center[] }[] = NAMED.map(([w, h], i) => ({ img: randImg(w, h, 2000 + i), centers: CENTERS }));
  const r = rng(182);
  while (list.length < NAMED.length + 60) {
    const w = 1 + Math.floor(r() * 1300);
    const h = 1 + Math.floor(r() * 1300);
    list.push({ img: randImg(w, h, 6000 + list.length), centers: [undefined, { x: r(), y: r() }] });
  }
  list.push({ img: hashImg(4032, 3024, 4032), centers: [undefined] });
  return (corpusCache = list);
}
const ZOOMS = [1.0000001, 1.0001, 1.25, 1.5, 2, 2.5, 3.3, 5, 8];
/** 変わらない物差し（BigInt の範囲の平均・この回の前の blob・blob＋[A]）の出力は、反証のたびに作り直さず要約（SHA-1）を覚える。
 *  本物・写しの出力の要約と食い違ったときだけ作り直して、違う画素を出す（反証 23 通りで [S-2] を回しても重くならない） */
const digestCache = new Map<string, string>();
const sha1 = (d: Uint8Array | Uint8ClampedArray) => crypto.createHash("sha1").update(d).digest("hex");
function cachedSha(key: string, make: () => Img): string {
  let v = digestCache.get(key);
  if (v === undefined) digestCache.set(key, (v = sha1(make().data)));
  return v;
}
const ck = (c: Center) => (c ? `${c.x},${c.y}` : "-");
let changedVsOldCache: boolean | null = null;
const oldaCache = new Map<string, { pa: Mod; rgba: Uint8Array[] }>();
const S2: Check = (IC, ctx, push) => {
  // (a0) 物差しの置き場所（placeRef）が本物・この回の前の blob と同じ（倍率 >1 も）
  for (const { img, centers } of corpus())
    for (const fit of FITS)
      for (const z of [undefined, 1, ...ZOOMS])
        for (const c of centers) {
          const R = placeRef(img.w, img.h, fit, z, c);
          for (const [who, M] of [
            ["本物", IC],
            ["この回の前", ctx.OLD],
          ] as [string, Mod | null][]) {
            if (!M) continue;
            const P = M.canvasPlacement(img.w, img.h, fit, z, c);
            if (P.dw !== R.dw || P.dh !== R.dh || P.dx0 !== R.dx0 || P.dy0 !== R.dy0)
              push(`(a0) ${who}の置き場所が物差しと違う ${img.w}×${img.h} ${fit} 倍率${z}: ${P.dw}×${P.dh}@${P.dx0},${P.dy0} ≠ ${R.dw}×${R.dh}@${R.dx0},${R.dy0}`);
          }
        }
  // (a) 倍率 1 の出力＝BigInt の整数の割り算で求めた範囲の平均
  corpus().forEach(({ img, centers }, idx) => {
    for (const fit of FITS)
      for (const c of centers) {
        const refSha = cachedSha(`a|${idx}|${fit}|${ck(c)}`, () => refResize(img, fit, 1, c, exactSpan));
        // 省略はどれも・明示の 1 は名前つきの大きさ・1 に収まる値（0.5・NaN）は先頭 6 枚
        const zs: (number | undefined)[] = idx < 6 && c === undefined ? [undefined, 1, 0.5, NaN] : idx < NAMED.length ? [undefined, 1] : [undefined];
        for (const z of zs) {
          const o = IC.resizeToCanvas(img, fit, z, c) as Img;
          if (sha1(o.data) === refSha) continue;
          const d = diffPixels(o, refResize(img, fit, 1, c, exactSpan));
          push(`(a) ${img.w}×${img.h} ${fit} 倍率${z}${c ? ` 位置(${c.x},${c.y})` : ""}: 整数の範囲の平均と違う ${fmt(d.n)} 画素（最初 ${d.first}）`);
        }
      }
  });
  // この回の前と違う絵が 1 枚はある（物差しが前の式と同じ＝空振り、でないこと）。この回の前も物差しも変わらないので 1 回だけ数える
  if (ctx.OLD && changedVsOldCache === null) {
    changedVsOldCache = false;
    const list = corpus();
    for (let idx = 0; idx < list.length && !changedVsOldCache; idx++)
      for (const fit of FITS)
        for (const c of list[idx].centers) {
          const img = list[idx].img;
          const refSha = cachedSha(`a|${idx}|${fit}|${ck(c)}`, () => refResize(img, fit, 1, c, exactSpan));
          if (sha1((ctx.OLD.resizeToCanvas(img, fit, undefined, c) as Img).data) !== refSha) changedVsOldCache = true;
        }
  }
  if (ctx.OLD && changedVsOldCache === false) push("(a) この回の前と違う絵が 1 枚も無い（検査が空振り＝物差しが前の式と同じ）");
  // prepareCanvas（明るさ・コントラスト込み＝CLI・MCP・画面が通る道）
  for (const { img } of corpus().slice(0, 14))
    for (const fit of FITS)
      for (const [br, ct] of [
        [0, 0],
        [30, -20],
      ]) {
        const o = IC.prepareCanvas(img, { ...IC.DEFAULT_CONVERT, fit, brightness: br, contrast: ct }) as Img;
        // 物差しの明るさ・コントラストは、この回の前の applyBC（写しの applyBC に左右されない）。blob が無いときは本物のもの
        const BC = ctx.OLD ?? IC;
        const make = () => refResize(BC.applyBC(img, br, ct) as Img, fit, 1, undefined, exactSpan);
        const refSha = ctx.OLD ? cachedSha(`pc|${img.w}x${img.h}|${fit}|${br}|${ct}`, make) : sha1(make().data);
        if (sha1(o.data) === refSha) continue;
        const d = diffPixels(o, make());
        push(`(a) prepareCanvas ${img.w}×${img.h} ${fit} BC(${br},${ct}): ${fmt(d.n)} 画素（最初 ${d.first}）`);
      }
  // (b) 倍率 >1 はこの回の前とバイト一致（blob そのもの＋V179 の式の物差し）
  corpus()
    .slice(0, NAMED.length)
    .forEach(({ img }, idx) => {
      for (const fit of FITS)
        for (const z of ZOOMS)
          for (const c of [undefined, idx % 2 ? { x: 0.2, y: 0.8 } : { x: 1, y: 0 }]) {
            const o = IC.resizeToCanvas(img, fit, z, c) as Img;
            const oSha = sha1(o.data);
            if (ctx.OLD) {
              const OLD = ctx.OLD;
              const oldSha = cachedSha(`b|${idx}|${fit}|${z}|${ck(c)}`, () => OLD.resizeToCanvas(img, fit, z, c) as Img);
              if (oSha !== oldSha) {
                const d = diffPixels(o, OLD.resizeToCanvas(img, fit, z, c) as Img);
                push(`(b) ${img.w}×${img.h} ${fit} 倍率${z}${c ? ` 位置(${c.x},${c.y})` : ""}: この回の前と違う ${fmt(d.n)} 画素（最初 ${d.first}）`);
              }
            }
            if (idx < 12 || !ctx.OLD) {
              const refSha = cachedSha(`bz|${idx}|${fit}|${z}|${ck(c)}`, () => refResize(img, fit, z, c, zoomedSpan));
              if (oSha !== refSha) {
                const d2 = diffPixels(o, refResize(img, fit, z, c, zoomedSpan));
                push(`(b) ${img.w}×${img.h} ${fit} 倍率${z}: 倍率 >1 の式（最近傍・整数の面積平均）と違う ${fmt(d2.n)} 画素（最初 ${d2.first}）`);
              }
            }
          }
    });
  // (c) 変換一式が「この回の前の blob に [A] の 1 点だけを当てた写し」と 1 バイトも違わない
  if (ctx.OLDA) {
    const modes: Record<string, unknown>[] = [
      { mode: "color" },
      { mode: "color", palette: "ugo", dither: "ordered" },
      { mode: "color", palette: "retro", dither: "none", colors: 8 },
      { mode: "tone", threshold: 40, ditherAmt: 70 },
      { mode: "tone", dither: "ordered", invert: true },
      { mode: "lineart", edge: 70 },
    ];
    const pick = (w: number, h: number) => corpus().find((e) => e.img.w === w && e.img.h === h)!.img;
    // 6 モード × 2 択は 1:1 と半分（この回で絵が変わる代表）の 2 枚＝連番 2 コマ。ほかの大きさは既定のモードで
    const imgs = [pick(320, 240), pick(640, 480)];
    const cases: { m: Record<string, unknown>; fit: Fit; z?: number; c?: Center; set: Img[] }[] = [];
    for (const m of modes) for (const fit of FITS) cases.push({ m, fit, set: imgs });
    for (const m of [modes[0], modes[3]]) cases.push({ m, fit: "cover", z: 2, c: { x: 0.3, y: 0.6 }, set: imgs });
    cases.push({ m: modes[0], fit: "cover", set: [pick(800, 600), pick(240, 160), pick(100, 75)] });
    cases.push({ m: modes[0], fit: "contain", set: [pick(1920, 1080), pick(333, 211)] });
    // 明るさ・コントラストの端（明るさ 0 でコントラストだけ・負の明るさ）と、自動の色数の上限（255）
    cases.push({ m: { mode: "color", brightness: 0, contrast: 30 }, fit: "cover", set: imgs });
    cases.push({ m: { mode: "tone", brightness: -25, contrast: 0 }, fit: "cover", set: imgs });
    cases.push({ m: { mode: "color", colors: 255 }, fit: "cover", set: imgs });
    // 9 枚の連番（9 枚目だけ色が違う＝パレットは全ページから）・白でない紙色の余白・線画の反転（Codex 3 回目の穴②③④）
    cases.push({ m: modes[0], fit: "cover", set: [...Array(8).fill(pick(320, 240)), pick(640, 480)] });
    cases.push({ m: { mode: "color", paper: "#ff2040" }, fit: "contain", set: [pick(1920, 1080), pick(333, 211)] });
    cases.push({ m: { mode: "lineart", edge: 60, invert: true }, fit: "cover", set: imgs });
    cases.forEach((k, ci) => {
      const OLDA = ctx.OLDA!;
      const o = { ...IC.DEFAULT_CONVERT, brightness: 10, contrast: 5, ...k.m, fit: k.fit, zoom: k.z, center: k.c, title: "t" };
      const pn = IC.convertToProject(k.set, o);
      let A = oldaCache.get(`c|${ci}`);
      if (!A) {
        // 既定の設定は blob＋[A] のもの（写しの DEFAULT_CONVERT に左右されない＝控えられる）
        const oa = { ...OLDA.DEFAULT_CONVERT, brightness: 10, contrast: 5, ...k.m, fit: k.fit, zoom: k.z, center: k.c, title: "t" };
        const pa0 = OLDA.convertToProject(k.set, oa);
        A = { pa: pa0, rgba: pa0.frames.map((_f: Mod, f: number) => OLDA.frameToRgba(pa0, f) as Uint8Array) };
        oldaCache.set(`c|${ci}`, A);
      }
      const pa = A.pa;
      const tag = `${JSON.stringify(k.m)} ${k.fit}${k.z ? ` 倍率${k.z}` : ""}`;
      const meta = (p: Mod) =>
        JSON.stringify([p.layerDefs, p.nextLayerId, p.speedIndex, p.loop, p.colorMode, p.indexBits, p.frames.map((f: Mod) => [f.paper, Object.keys(f.layers)])]);
      if (meta(pn) !== meta(pa)) push(`(c) 変換一式 ${tag}: レイヤーの定義・速さ・ループ・色の形・紙色のどれかが違う（${meta(pn).slice(0, 90)}）`);
      if (pn.colorTable.join() !== pa.colorTable.join()) push(`(c) 変換一式 ${tag}: 色の表が違う`);
      else if (pn.indexBits !== pa.indexBits || pn.frames.length !== pa.frames.length) push(`(c) 変換一式 ${tag}: 形が違う`);
      else
        for (let f = 0; f < pa.frames.length; f++) {
          if (!sameBytes(pn.frames[f].layers.L1, pa.frames[f].layers.L1)) {
            push(`(c) 変換一式 ${tag}: コマ ${f} の画素が違う`);
            break;
          }
          // 合成（紙＋背景レイヤー）もこの回の前と同じ（プレビュー・サムネが使う frameToRgba）
          if (!sameBytes(IC.frameToRgba(pn, f), A.rgba[f])) {
            push(`(c) 変換一式 ${tag}: コマ ${f} の合成（frameToRgba）が違う`);
            break;
          }
        }
    });
  }
  // 既定の設定そのもの（CLI・MCP・画面が `{ ...DEFAULT_CONVERT }` で使う）
  if (ctx.OLDA && JSON.stringify(IC.DEFAULT_CONVERT) !== JSON.stringify(ctx.OLDA.DEFAULT_CONVERT))
    push(`(c) 既定の設定 DEFAULT_CONVERT がこの回の前と違う: ${JSON.stringify(IC.DEFAULT_CONVERT).slice(0, 120)}`);
  // (d) コメントを除いたコードが「この回の前の blob＋[A]」と 1 文字も違わない（触らないもの＝差分 0 行を機械で見る）
  if (ctx.OLDA_TEXT) {
    const a = codeOnly(fs.readFileSync(path.join(ctx.dir, IC_REL), "utf8")).split(/\r?\n/);
    const b = codeOnly(ctx.OLDA_TEXT).split(/\r?\n/);
    const i = a.findIndex((line, j) => line !== b[j]);
    if (i >= 0 || a.length !== b.length) {
      const at = i >= 0 ? i : Math.min(a.length, b.length);
      push(`(d) imageConvert.ts のコードが「この回の前＋[A]」と違う（JS の ${at + 1} 行目: ${String(a[at]).trim().slice(0, 70)} ≠ ${String(b[at]).trim().slice(0, 70)}）`);
    }
  }
};

// ---------------- [S-3] 等倍でない拡大は混ぜるまま（G-2） ----------------
/** どちらかの軸が「等倍でない拡大」になる大きさ（cover / contain のどちらかで） */
const UPS: [number, number][] = [
  [256, 192], // DS の画面（1.25 倍）
  [240, 160], // 1.5 倍
  [256, 240], // cover で縦 1.25 倍
  [100, 75], // 3.2 倍
  [97, 61],
  [200, 150], // 1.6 倍
  [288, 216], // 1.11 倍
  [128, 96], // 2.5 倍
  [300, 225], // 1.07 倍
  [213, 160],
  [170, 128],
  [250, 180],
  [310, 230],
  [33, 25],
  [101, 77],
  [150, 250],
  [123, 45],
];
/** この回の前も浮動小数の誤差が無かった大きさ（要件 §2-2 の 256×192＝0 ほか・この回の前の blob で実測） */
const UNCHANGED_UPS: [number, number][] = [
  [256, 192],
  [128, 96],
  [97, 61],
  [300, 225],
];
const upsImgs = new Map<string, Img>();
function upsImg(w: number, h: number): Img {
  const key = `${w}x${h}`;
  let img = upsImgs.get(key);
  if (!img) upsImgs.set(key, (img = randImg(w, h, 3000 + w * 13 + h)));
  return img;
}
const S3: Check = (IC, ctx, push) => {
  // (a) この回の前とバイト一致（blob そのもの・前の式の写し）
  for (const [w, h] of UNCHANGED_UPS) {
    const img = upsImg(w, h);
    for (const fit of FITS) {
      const o = IC.resizeToCanvas(img, fit) as Img;
      const d = diffPixels(o, refResize(img, fit, 1, undefined, floatSpan));
      if (d.n) push(`(a) ${w}×${h} ${fit}: この回の前の式と違う ${fmt(d.n)} 画素（最初 ${d.first}）`);
      if (ctx.OLD) {
        const d2 = diffPixels(o, ctx.OLD.resizeToCanvas(img, fit) as Img);
        if (d2.n) push(`(a) ${w}×${h} ${fit}: この回の前（blob）と違う ${fmt(d2.n)} 画素（最初 ${d2.first}）`);
      }
    }
  }
  // (b) 境目をまたぐ画素は混ぜるまま ／ (c) 変わったのは前の式が隣を余計に拾っていた所だけ
  let anyUp = 0;
  for (const [w, h] of UPS) {
    const img = upsImg(w, h);
    for (const fit of FITS)
      for (const c of [undefined, { x: 0.2, y: 0.8 }]) {
        const P = placeRef(w, h, fit, 1, c);
        const upX = P.dw > w && P.dw % w !== 0;
        const upY = P.dh > h && P.dh % h !== 0;
        if (!upX && !upY) continue;
        anyUp++;
        const o = IC.resizeToCanvas(img, fit, undefined, c) as Img;
        const x0 = Math.max(0, P.dx0);
        const x1 = Math.min(W, P.dx0 + P.dw);
        const y0 = Math.max(0, P.dy0);
        const y1 = Math.min(H, P.dy0 + P.dh);
        const ex = Array.from({ length: x1 - x0 }, (_, i) => exactSpan(P.dw, w, x0 + i - P.dx0));
        const ey = Array.from({ length: y1 - y0 }, (_, i) => exactSpan(P.dh, h, y0 + i - P.dy0));
        const fx = Array.from({ length: x1 - x0 }, (_, i) => floatSpan(P.dw, w, x0 + i - P.dx0));
        const fy = Array.from({ length: y1 - y0 }, (_, i) => floatSpan(P.dh, h, y0 + i - P.dy0));
        let straddle = 0;
        let badMix = 0;
        let firstBad = "";
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const [xA, xB] = ex[x - x0];
            const [yA, yB] = ey[y - y0];
            if (xB === xA && yB === yA) continue;
            straddle++;
            const sums = [0, 0, 0];
            for (let sy = yA; sy <= yB; sy++)
              for (let sx = xA; sx <= xB; sx++) for (let k = 0; k < 3; k++) sums[k] += img.data[(sy * w + sx) * 4 + k];
            const n = (xB - xA + 1) * (yB - yA + 1);
            const oi = (y * W + x) * 4;
            for (let k = 0; k < 3; k++)
              if (o.data[oi + k] !== Math.trunc(sums[k] / n)) {
                if (!badMix) firstBad = `(${x}, ${y}) ch${k} ${o.data[oi + k]} ≠ ${Math.trunc(sums[k] / n)}（${n} 画素の平均）`;
                badMix++;
                break;
              }
          }
        const tag = `${w}×${h} ${fit}${c ? ` 位置(${c.x},${c.y})` : ""}（${P.dw}×${P.dh}）`;
        if (!straddle) push(`(b) ${tag}: 境目をまたぐ画素が 0（等倍でない拡大なのに＝検査が空振り）`);
        if (badMix) push(`(b) ${tag}: 境目をまたぐ ${fmt(straddle)} 画素のうち ${fmt(badMix)} 画素が混ざっていない（最初 ${firstBad}）`);
        // (c) この回の前と違う画素は、前の式の範囲が正解より 1 画素広かった（隣を余計に拾った）所だけ
        if (ctx.OLD) {
          const old = ctx.OLD.resizeToCanvas(img, fit, undefined, c) as Img;
          const dOld = diffPixels(old, refResize(img, fit, 1, c, floatSpan));
          if (dOld.n) push(`(c) ${tag}: 物差し（前の式の写し）がこの回の前の blob と ${fmt(dOld.n)} 画素違う（写し間違い）`);
          const wider = (f: [number, number], e: [number, number]) =>
            f[0] <= e[0] && f[1] >= e[1] && f[1] - f[0] === e[1] - e[0] + 1;
          const same = (f: [number, number], e: [number, number]) => f[0] === e[0] && f[1] === e[1];
          let other = 0;
          let firstOther = "";
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
              const oi = (y * W + x) * 4;
              if (o.data[oi] === old.data[oi] && o.data[oi + 1] === old.data[oi + 1] && o.data[oi + 2] === old.data[oi + 2]) continue;
              const X = [fx[x - x0], ex[x - x0]] as const;
              const Y = [fy[y - y0], ey[y - y0]] as const;
              const explained = (wider(X[0], X[1]) || same(X[0], X[1])) && (wider(Y[0], Y[1]) || same(Y[0], Y[1])) && !(same(X[0], X[1]) && same(Y[0], Y[1]));
              if (!explained) {
                if (!other) firstOther = `(${x}, ${y}) 前 x${X[0]} y${Y[0]} / 正解 x${X[1]} y${Y[1]}`;
                other++;
              }
            }
          if (other) push(`(c) ${tag}: 隣を余計に拾っていた所以外で変わった画素 ${fmt(other)}（最初 ${firstOther}）`);
        }
      }
  }
  if (anyUp < 20) push(`等倍でない拡大の組み合わせが少ない（${anyUp}）＝検査が空振り`);
};

// ---------------- [S-4] 取り込める上限で範囲が溢れない ----------------
/** main.ts の decodeImageFile が画像を縮める長辺（取り込める上限）。**ちょうど 1 か所**から読む（見つからなければ赤） */
function readMaxSide(): { v: number; why: string } {
  const text = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");
  const m = [...text.matchAll(/const MAXSIDE = (\d+);/g)];
  if (m.length !== 1) return { v: 0, why: `main.ts の「const MAXSIDE = 数;」が ${m.length} か所（1 か所のはず）` };
  return { v: Number(m[0][1]), why: "" };
}
let s4Record = "";
/** 画素を持たず、data[i] を読むたびに色を返す画像（24,333,387×7 のように RGBA だと 681MB になる大きさを、作らずに当てる）。
 *  色は列（横長）か行（縦長）ごとにばらばら＝範囲が 1 画素ずれると平均が変わる */
function lazyImg(w: number, h: number, seed: number): Img {
  const along = w >= h;
  const data = new Proxy({} as Record<string, number>, {
    get: (_t, key) => {
      const i = Number(key);
      if (!Number.isInteger(i)) return undefined;
      const p = i >> 2;
      const c = i & 3;
      if (c === 3) return 255;
      const n = along ? p % w : Math.floor(p / w);
      let v = Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(seed + c, 0x85ebca6b);
      v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d);
      return (v ^ (v >>> 12)) & 255;
    },
  });
  return { w, h, data: data as unknown as Uint8Array };
}
const s4Imgs = new Map<string, Img>();
function s4Img(w: number, h: number, seed: number): Img {
  const key = `${w}x${h}`;
  let img = s4Imgs.get(key);
  if (!img) s4Imgs.set(key, (img = hashImg(w, h, seed)));
  return img;
}
const S4: Check = (IC, _ctx, push) => {
  const { v: M, why } = readMaxSide();
  if (!M) return push(why);
  if (M < 1024) push(`取り込める上限の長辺が ${M}（小さすぎる＝読み違い）`);
  const q = (n: number) => Math.round((M * n) / 4);
  // 上限いっぱいの大きさ（画面の取り込み）＋上限の無い CLI・MCP の極端な細長
  const big: [number, number, Center[]][] = [
    [M, M, [undefined, { x: 0.37, y: 0.61 }]],
    [M, q(3), [undefined, { x: 0, y: 1 }]],
    [q(3), M, [undefined]],
    [M, Math.round((M * 9) / 16), [undefined, { x: 1, y: 0 }]],
  ];
  const thin: [number, number][] = [
    [M, 1],
    [1, M],
    [M, 2],
    [2, M],
    [M - 1, 1],
    [1, M - 1],
    [M, 3],
    [3, M - 1],
    [1, 100_000], // CLI・MCP には上限が無い（目安として 10 万画素の細長）
    [100_000, 1],
    [2, 65_536],
  ];
  let maxDS = 0;
  let maxAt = "";
  const run = (img: Img, fit: Fit, z: number | undefined, c: Center) => {
    const R = placeRef(img.w, img.h, fit, z, c);
    for (const [d, s, ax] of [
      [R.dw, img.w, "横"],
      [R.dh, img.h, "縦"],
    ] as [number, number, string][])
      if (d * s > maxDS) {
        maxDS = d * s;
        maxAt = `${img.w}×${img.h} ${fit} 倍率${z ?? 1} ${ax}（d=${fmt(d)}・s=${fmt(s)}）`;
      }
    const o = IC.resizeToCanvas(img, fit, z, c) as Img;
    const ref = refResize(img, fit, z, c, R.zoomed ? zoomedSpan : exactSpan);
    const d = diffPixels(o, ref);
    if (d.n) push(`${img.w}×${img.h} ${fit} 倍率${z ?? 1}${c ? ` 位置(${c.x},${c.y})` : ""}: BigInt の範囲の平均と違う ${fmt(d.n)} 画素（最初 ${d.first}）`);
  };
  for (const [w, h, cs] of big) {
    const img = s4Img(w, h, w + h);
    for (const fit of FITS) for (const z of [undefined, 8]) for (const c of cs) run(img, fit, z, c);
  }
  for (const [w, h] of thin) {
    const img = s4Img(w, h, w * 3 + h);
    for (const fit of FITS) for (const z of [undefined, 1.25, 8]) for (const c of [undefined, { x: 0.13, y: 0.87 }, { x: 1, y: 0 }]) run(img, fit, z, c);
  }
  // ★2^53 を超える所（CLI・MCP だけで届く）: Codex 3 回目の例 24,333,387×7（倍率 1・中央で (40,120) が前の式は正しく、BigInt の道が無いと 1 画素ずれる）
  //   と、縦長・位置違い。倍率 1 だけ（倍率 >1 の枝は V179 のまま＝CLI・MCP は倍率を渡さない）
  for (const [w, h] of [
    [24_333_387, 7],
    [7, 24_333_387],
    [30_000_001, 3],
  ] as [number, number][]) {
    const img = lazyImg(w, h, w % 97);
    for (const c of [undefined, { x: 0.2, y: 0.8 }]) run(img, "cover", undefined, c);
  }
  // 画面の取り込みで起こりうる d·s の最大（細長 1×M を「画面いっぱい」・倍率 1 と 8）
  if (!(maxDS > 2 ** 53)) push(`2^53 を超える大きさを当てていない（最大 d·s ${fmt(maxDS)}）＝BigInt の道が検査されていない`);
  const appMax1 = W * M * M;
  const appMax8 = W * 8 * M * M;
  s4Record =
    `取り込める上限（main.ts MAXSIDE）= 長辺 ${M}／画面の取り込みで d·s（k·s の上限）の最大 = 倍率 1: ${fmt(appMax1)}・倍率 8: ${fmt(appMax8)}` +
    `（2^53 = ${fmt(2 ** 53)} の 1/${fmt(Math.floor(2 ** 53 / appMax1))}・1/${fmt(Math.floor(2 ** 53 / appMax8))}）／` +
    `この検査で当てた最大 d·s = ${fmt(maxDS)}（${maxAt}・2^53 の ${(maxDS / 2 ** 53).toFixed(2)} 倍＝BigInt の道）`;
  if (!(maxDS >= appMax1)) push(`上限の細長を当てていない（最大 d·s ${fmt(maxDS)} < ${fmt(appMax1)}）`);
};

// ---------------- [S-5] 色を減らしたあとの差（記録・判定ではない） ----------------
function finalRgb(p: Mod, fi: number): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  const paper = p.colorTable[p.frames[fi].paper] as string;
  const buf = p.frames[fi].layers.L1 as ArrayLike<number>;
  for (let i = 0; i < W * H; i++) {
    const hex = (buf[i] > 0 ? p.colorTable[buf[i]] : paper) as string;
    out[i * 3] = parseInt(hex.slice(1, 3), 16);
    out[i * 3 + 1] = parseInt(hex.slice(3, 5), 16);
    out[i * 3 + 2] = parseInt(hex.slice(5, 7), 16);
  }
  return out;
}
/** パレットと索引（quantizeFrame の結果）→ 最終の色（RGB） */
function quantRgb(pal: number[][], idx: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const c = idx[i] < 0 ? [255, 255, 255] : pal[idx[i]];
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}
/** 最終の色 2 枚の差: 違う画素・8×8 の平均で見た差（最大・平均） */
function rgbDiff(ra: Uint8Array, rb: Uint8Array): { px: number; bMax: number; bMean: number } {
  let px = 0;
  for (let p = 0; p < W * H; p++) if (ra[p * 3] !== rb[p * 3] || ra[p * 3 + 1] !== rb[p * 3 + 1] || ra[p * 3 + 2] !== rb[p * 3 + 2]) px++;
  let bMax = 0,
    bSum = 0,
    bN = 0;
  for (let by = 0; by < H; by += 8)
    for (let bx = 0; bx < W; bx += 8)
      for (let k = 0; k < 3; k++) {
        let sa = 0,
          sb = 0;
        for (let y = by; y < by + 8; y++)
          for (let x = bx; x < bx + 8; x++) {
            sa += ra[(y * W + x) * 3 + k];
            sb += rb[(y * W + x) * 3 + k];
          }
        const dd = Math.abs(sa - sb) / 64;
        bMax = Math.max(bMax, dd);
        bSum += dd;
        bN++;
      }
  return { px, bMax, bMean: bSum / bN };
}
/** 2 つの変換結果（1 コマ目）の差: 違う画素・色の表で入れ替わった色・8×8 の平均で見た差（最大・平均） */
function finalDiff(pa: Mod, pb: Mod): { px: number; swapped: number; colors: number; bMax: number; bMean: number } {
  const ra = finalRgb(pa, 0);
  const rb = finalRgb(pb, 0);
  const { px } = rgbDiff(ra, rb);
  const setB = new Set(pb.colorTable.slice(1));
  const swapped = pa.colorTable.slice(1).filter((c: string) => !setB.has(c)).length;
  const { bMax, bMean } = rgbDiff(ra, rb);
  return { px, swapped, colors: pa.colorTable.length - 1, bMax, bMean };
}
function recordS5(IC: Mod, OLD: Mod | null): number {
  if (!OLD) {
    console.log(`SKIP [S-5] この回の前の blob ${BASELINE_BLOB.slice(0, 7)} を取り出せない → 記録しない`);
    return 0;
  }
  const sizes: [number, number, Fit][] = [
    [800, 600, "cover"],
    [1600, 1200, "cover"],
    [640, 480, "cover"],
    [1280, 960, "cover"],
    [960, 720, "cover"],
    [1440, 1080, "cover"],
    [480, 360, "cover"],
    [3000, 2000, "cover"],
    [1920, 1080, "cover"],
    [1920, 1080, "contain"],
    [4032, 3024, "cover"],
    [1024, 768, "cover"],
    [800, 600, "contain"],
  ];
  console.log("\n[S-5] 色を減らしたあとの差（写真に近い画像・既定の設定＝24 色・誤差拡散。判定ではなく記録）");
  console.log("  ★目安＝この回の前の縮小画の、同じ数の画素を同じ大きさ（±1〜最大）だけ乱数で揺らして、この回の前の色減らしに通したときの差");
  console.log("   （誤差拡散は小さな揺れでも点々の並びが入れ替わる＝この回に限らない、を見るため）");
  console.log("  大きさ / 2 択 | 色を減らす前: 違う画素・最大・平均 | 色を減らしたあと: 違う画素（/76,800）・入れ替わった色 | 8×8 の平均の差: 最大・平均 || 目安（同じ数だけ揺らす）: 違う画素・8×8 の最大・平均");
  let n = 0;
  for (const [w, h, fit] of sizes) {
    const img = photoImg(w, h, w * 11 + h);
    const o = { ...IC.DEFAULT_CONVERT, fit, title: "t" };
    const cn = IC.prepareCanvas(img, o) as Img;
    const co = OLD.prepareCanvas(img, o) as Img;
    let cDiff = 0,
      cMax = 0,
      cSum = 0;
    for (let p = 0; p < W * H; p++) {
      let m = 0;
      for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(cn.data[p * 4 + k] - co.data[p * 4 + k]));
      if (m) {
        cDiff++;
        cMax = Math.max(cMax, m);
        cSum += m;
      }
    }
    const po = OLD.convertToProject([img], o);
    const f = finalDiff(IC.convertToProject([img], o), po);
    // 目安: この回の前の縮小画 co を、同じ数（cDiff）の画素だけ ±1〜cMax 揺らす → この回の前の色減らし（パレット＋誤差拡散）
    const r = rng(w + h);
    const shaken = { w: W, h: H, data: Uint8Array.from(co.data) };
    for (let t = 0; t < cDiff; t++) {
      const p = Math.floor(r() * W * H);
      const k = Math.floor(r() * 3);
      const dv = (1 + Math.floor(r() * Math.max(1, cMax))) * (r() < 0.5 ? -1 : 1);
      shaken.data[p * 4 + k] = Math.min(255, Math.max(0, shaken.data[p * 4 + k] + dv));
    }
    const palO = OLD.resolvePalette([co], o);
    const palS = OLD.resolvePalette([shaken], o);
    const b = rgbDiff(quantRgb(palS, OLD.quantizeFrame(shaken, palS, o.dither)), quantRgb(palO, OLD.quantizeFrame(co, palO, o.dither)));
    console.log(
      `  ${w}×${h} ${fit} | ${fmt(cDiff)}・${cMax}/255・${cDiff ? (cSum / cDiff).toFixed(1) : "0"} | ` +
        `${fmt(f.px)}（${((f.px / (W * H)) * 100).toFixed(1)}%）・${f.swapped}/${f.colors} 色 | ${f.bMax.toFixed(1)}/255・${f.bMean.toFixed(2)} || ` +
        `${fmt(b.px)}（${((b.px / (W * H)) * 100).toFixed(1)}%）・${b.bMax.toFixed(1)}/255・${b.bMean.toFixed(2)}`
    );
    n++;
  }
  // 種を変えた写真（同じ大きさで 3 枚ずつ）: 8×8 の平均の差の最大（V182 と目安）
  let vMax = 0,
    bMax2 = 0,
    vAt = "",
    m = 0;
  for (const [w, h] of [
    [800, 600],
    [640, 480],
    [1600, 1200],
    [480, 360],
  ] as [number, number][])
    for (const seed of [5, 17, 29]) {
      const img = photoImg(w, h, seed * 1009 + w);
      const o = { ...IC.DEFAULT_CONVERT, fit: "cover" as Fit, title: "t" };
      const co = OLD.prepareCanvas(img, o) as Img;
      const cn = IC.prepareCanvas(img, o) as Img;
      let cDiff = 0,
        cMax = 0;
      for (let p = 0; p < W * H; p++) {
        let mm = 0;
        for (let k = 0; k < 3; k++) mm = Math.max(mm, Math.abs(cn.data[p * 4 + k] - co.data[p * 4 + k]));
        if (mm) {
          cDiff++;
          cMax = Math.max(cMax, mm);
        }
      }
      const po = OLD.convertToProject([img], o);
      const f = finalDiff(IC.convertToProject([img], o), po);
      if (f.bMax > vMax) {
        vMax = f.bMax;
        vAt = `${w}×${h} 種 ${seed}`;
      }
      const r = rng(seed + w);
      const shaken = { w: W, h: H, data: Uint8Array.from(co.data) };
      for (let t = 0; t < cDiff; t++) {
        const pp = Math.floor(r() * W * H);
        const k = Math.floor(r() * 3);
        const dv = (1 + Math.floor(r() * Math.max(1, cMax))) * (r() < 0.5 ? -1 : 1);
        shaken.data[pp * 4 + k] = Math.min(255, Math.max(0, shaken.data[pp * 4 + k] + dv));
      }
      const palO = OLD.resolvePalette([co], o);
      const palS = OLD.resolvePalette([shaken], o);
      const b = rgbDiff(quantRgb(palS, OLD.quantizeFrame(shaken, palS, o.dither)), quantRgb(palO, OLD.quantizeFrame(co, palO, o.dither)));
      bMax2 = Math.max(bMax2, b.bMax);
      m++;
    }
  console.log(`  種を変えた写真 ${m} 枚（4 つの大きさ × 3 つの種）の 8×8 の平均の差の最大: V182 ${vMax.toFixed(1)}/255（${vAt}）・目安 ${bMax2.toFixed(1)}/255`);
  console.log("  ※写真によっては自動パレットの色が入れ替わり、一部の領域の色味が変わる（この回に限らず、同じ大きさの揺れでも起こる）");
  return n;
}

const CHECKS: [string, Check][] = [
  ["[S-1] ★ぴったり: 1:1 は元の画素・整数倍は同じ色の四角・整数分の 1 はきっちりした四角の平均", S1],
  ["[S-2] ★変わるのは倍率 1 の範囲の式だけ（倍率 1＝整数の範囲の平均・倍率 >1 と変換一式はこの回の前のまま）", S2],
  ["[S-3] 等倍でない拡大は混ぜるまま（G-2）・変わるのは前の式が隣を余計に拾っていた所だけ", S3],
  ["[S-4] 取り込める上限と極端な細長で、範囲が溢れない・元画像の外へ出ない", S4],
];

function run(fn: Check, IC: Mod, ctx: Ctx): { bad: string[]; threw: boolean } {
  const r = reasons(ctx);
  try {
    fn(IC, ctx, r.push);
    return { bad: r.bad, threw: false };
  } catch (e) {
    if (e instanceof StopEarly) return { bad: r.bad, threw: false };
    return { bad: [...r.bad, `例外: ${String((e as Error)?.message ?? e).slice(0, 160)}`], threw: r.bad.length === 0 };
  }
}

// ================= 写し（無改変・この回の前・反証）の置き場 =================
// 既定は node_modules/.v182-smoke/<pid>（git の外・npm の部品が見える）。
// 使い捨て worktree 等で node_modules へ書けないときは、環境変数 V182_SMOKE_WORK で置き場を差し替える
// （**その祖先に node_modules があること**＝部品を解決するため）
const WORK = path.join(process.env.V182_SMOKE_WORK || path.join(root, "node_modules", ".v182-smoke"), String(process.pid));
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
}
const IC_REL = "src/editor/imageConvert.ts";
async function loadIC(dir: string): Promise<Mod> {
  return (await import(pathToFileURL(path.join(dir, IC_REL)).href)) as Mod;
}
interface Edit {
  from: string;
  to: string;
}
/** text に edits を当てる。どれもちょうど 1 か所に当たること（当たらなければ理由を返す） */
function applyEdits(text: string, edits: Edit[]): { text: string; why: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const e of edits) {
    const from = e.from.replace(/\n/g, eol);
    const n = text.split(from).length - 1;
    if (n !== 1) return { text, why: `書き換えが当たらない（${n} 箇所）: ${e.from.trim().slice(0, 80)}` };
    text = text.replace(from, () => e.to.replace(/\n/g, eol));
  }
  return { text, why: "" };
}
let seq = 0;
/** src/ を写して imageConvert.ts に `edits` を当てた木を読む。書き換えは**ちょうど 1 か所**に当たること */
async function mutant(edits: Edit[]): Promise<{ IC: Mod | null; dir: string; why: string }> {
  const dir = path.join(WORK, `m${++seq}`);
  copySrc(dir);
  const f = path.join(dir, IC_REL);
  const r = applyEdits(fs.readFileSync(f, "utf8"), edits);
  if (r.why) return { IC: null, dir, why: r.why };
  fs.writeFileSync(f, r.text);
  return { IC: await loadIC(dir), dir, why: "" };
}
/** この回の前の imageConvert.ts（blob）を写しに戻して読む（`edits` があれば当てる）。git が無い・blob が無いときは null */
async function loadOld(name: string, edits: Edit[] = []): Promise<{ M: Mod | null; text: string | null; why: string }> {
  let text: string;
  try {
    text = execFileSync("git", ["cat-file", "-p", BASELINE_BLOB], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { M: null, text: null, why: "git が無い・blob が無い" };
  }
  const r = applyEdits(text, edits);
  if (r.why) return { M: null, text: null, why: r.why };
  const dir = path.join(WORK, name);
  copySrc(dir);
  fs.writeFileSync(path.join(dir, IC_REL), r.text);
  return { M: await loadIC(dir), text: r.text, why: "" };
}

// ================= [A] の 1 点（この回の前の blob に当てる） =================
// 倍率 1 の枝の 2 行（後ろに続く `} else if (d > s) {` まで含めて 1 か所に決める＝コメントの言い回しに頼らない）
const TAIL = "    } else if (d > s) {";
const FLOAT_LINES = "      lo = Math.floor((k / d) * s);\n      hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) / d) * s) - 1));\n";
/** 縮小の枝（倍率 >1）の 2 行（字下げ 6） */
const INT_LINES = "      lo = Math.floor((k * s) / d);\n      hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) * s) / d) - 1));\n";
/** 倍率 1 の枝の速い道（字下げ 8・2^53 まで）と、その後ろ（BigInt の道の頭）＝反証の書き換えを 1 か所に決める */
const FAST_LINES = "        lo = Math.floor((k * s) / d);\n        hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) * s) / d) - 1));\n";
const FAST_TAIL = "      } else {\n        const S = BigInt(s);";
/** [A] の本文（Codex 3 回目の指摘で、(k + 1)·s が 2^53 を超える所だけ BigInt にした） */
const NEW_BRANCH =
  "      if ((k + 1) * s <= Number.MAX_SAFE_INTEGER) {\n" +
  FAST_LINES +
  FAST_TAIL +
  "\n        const D = BigInt(d);\n" +
  "        lo = Number((BigInt(k) * S) / D);\n" +
  "        hi = Math.min(s - 1, Math.max(lo, Number((BigInt(k + 1) * S + D - 1n) / D) - 1));\n" +
  "      }\n";
const FIX_A: Edit = { from: FLOAT_LINES + TAIL, to: NEW_BRANCH + TAIL };

// ================= 反証（壊した写し → 赤になること） =================
interface Counter {
  id: string;
  what: string;
  edits: Edit[];
  /** 赤になるべき検査（CHECKS の添字） */
  expect: number[];
}
// 縮小の枝（倍率 >1・V179）の 2 行は、後ろの `}` と `spans[...] = lo;` まで含めて 1 か所に決める
const ZTAIL = "    }\n    spans[(k - from) * 2] = lo;";
const COUNTERS: Counter[] = [
  {
    id: "1f",
    what: "倍率 1 の範囲を浮動小数の式に戻す（この回の前）",
    edits: [{ from: FAST_LINES + FAST_TAIL, to: FLOAT_LINES.replace(/^      /gm, "        ") + FAST_TAIL }],
    expect: [0],
  },
  {
    id: "1f-lo",
    what: "倍率 1 の lo だけ浮動小数に戻す",
    edits: [{ from: FAST_LINES + FAST_TAIL, to: "        " + FLOAT_LINES.split("\n")[0].trim() + "\n" + FAST_LINES.split("\n")[1] + "\n" + FAST_TAIL }],
    expect: [0],
  },
  {
    id: "1f-hi",
    what: "倍率 1 の hi だけ浮動小数に戻す",
    edits: [{ from: FAST_LINES + FAST_TAIL, to: FAST_LINES.split("\n")[0] + "\n        " + FLOAT_LINES.split("\n")[1].trim() + "\n" + FAST_TAIL }],
    expect: [0],
  },
  {
    id: "1w",
    what: "倍率 1 の hi を 1 画素広く取る（- 1 を落とす）",
    edits: [
      {
        from: "Math.ceil(((k + 1) * s) / d) - 1));\n" + FAST_TAIL,
        to: "Math.ceil(((k + 1) * s) / d)));\n" + FAST_TAIL,
      },
    ],
    expect: [0],
  },
  {
    id: "1t",
    what: "平均を切り捨てでなく四捨五入に（resizeToCanvas の本体・赤だけ）",
    edits: [{ from: "      out[oi] = r / n;", to: "      out[oi] = Math.round(r / n);" }],
    expect: [0],
  },
  {
    id: "2z",
    what: "倍率 >1 の縮小の範囲を浮動小数の式に（zoomed の枝も替える）",
    edits: [{ from: INT_LINES + ZTAIL, to: FLOAT_LINES + ZTAIL }],
    expect: [1],
  },
  {
    id: "2n",
    what: "倍率 >1 の拡大を面積平均に（最近傍をやめる＝zoomed の枝を倍率 1 と同じに）",
    edits: [{ from: "} else if (d > s) {", to: "} else if (false) {" }],
    expect: [1],
  },
  {
    id: "2e",
    what: "倍率 >1 の拡大の最近傍を、画素の中心でなく左端で取る",
    edits: [
      {
        from: "lo = hi = Math.min(s - 1, Math.floor(((2 * k + 1) * s) / (2 * d)));",
        to: "lo = hi = Math.min(s - 1, Math.floor((k * s) / d));",
      },
    ],
    expect: [1],
  },
  {
    id: "2p",
    what: "置き場所の丸めを round に（canvasPlacement を触る）",
    edits: [{ from: "Math.floor(frame / 2 - c * d)", to: "Math.round(frame / 2 - c * d)" }],
    expect: [1],
  },
  {
    id: "2q",
    what: "色を減らす処理を触る（medianCut の箱を 1 つ減らす）",
    edits: [{ from: "while (boxes.length < n) {", to: "while (boxes.length < n - 1) {" }],
    expect: [1],
  },
  {
    id: "2a",
    what: "倍率 1 を k * (s / d) の順で計算する（別の浮動小数の式）",
    edits: [
      {
        from: FAST_LINES + FAST_TAIL,
        to: "        lo = Math.floor(k * (s / d));\n        hi = Math.min(s - 1, Math.max(lo, Math.ceil((k + 1) * (s / d)) - 1));\n" + FAST_TAIL,
      },
    ],
    expect: [1],
  },
  {
    id: "2d",
    what: "検査で動かさない関数を触る（frameToRgba の紙色の既定＝(d) だけが見る）",
    edits: [{ from: 'p.colorTable[p.frames[fi].paper] || "#ffffff"', to: 'p.colorTable[p.frames[fi].paper] || "#fffffe"' }],
    expect: [1],
  },
  {
    id: "2b",
    what: "明るさ 0 ならコントラストも掛けない（applyBC の早い return を明るさだけで判定）",
    edits: [{ from: "  if (!brightness && !contrast) return img;", to: "  if (!brightness) return img;" }],
    expect: [1],
  },
  {
    id: "2m",
    what: "負の明るさを無視する（applyBC）",
    edits: [{ from: "  const b = brightness * 1.275;", to: "  const b = Math.max(0, brightness) * 1.275;" }],
    expect: [1],
  },
  {
    id: "2c",
    what: "自動の色数の上限を 255 から 64 に（resolvePalette）",
    edits: [{ from: "Math.max(2, Math.min(255, o.colors))", to: "Math.max(2, Math.min(64, o.colors))" }],
    expect: [1],
  },
  {
    id: "2t",
    what: "倍率 1 とみなす幅を 1.000001 まで広げる（Codex 2 回目の 03）",
    edits: [{ from: "const zoomed = clampCropZoom(zoom) > 1;", to: "const zoomed = clampCropZoom(zoom) > 1.000001;" }],
    expect: [1],
  },
  {
    id: "2v",
    what: "取り込んだレイヤーを見えなくする（Codex 2 回目の 09）",
    edits: [{ from: 'p.layerDefs = [{ id: "L1", name: imageLayerName(), visible: true, opacity: 1 }];', to: 'p.layerDefs = [{ id: "L1", name: imageLayerName(), visible: false, opacity: 1 }];' }],
    expect: [1],
  },
  {
    id: "2f",
    what: "既定の速さを 4 から 8 に（DEFAULT_CONVERT・Codex 2 回目の 11）",
    edits: [{ from: '  fps: 4,\n  title: "",', to: '  fps: 8,\n  title: "",' }],
    expect: [1],
  },
  {
    id: "4b",
    what: "BigInt の道を外す（2^53 を超えても浮動小数の掛け算のまま・Codex 3 回目の低）",
    edits: [{ from: "      if ((k + 1) * s <= Number.MAX_SAFE_INTEGER) {", to: "      if (true) {" }],
    expect: [3],
  },
  {
    id: "4g",
    what: "BigInt の道の hi を切り上げでなく切り捨てに",
    edits: [{ from: "Number((BigInt(k + 1) * S + D - 1n) / D) - 1", to: "Number((BigInt(k + 1) * S) / D) - 1" }],
    expect: [3],
  },
  {
    id: "2p8",
    what: "連番のパレットを先頭 8 枚だけから作る（Codex 3 回目の 19）",
    edits: [{ from: "return medianCut(canvases, Math.max(2, Math.min(255, o.colors)));", to: "return medianCut(canvases.slice(0, 8), Math.max(2, Math.min(255, o.colors)));" }],
    expect: [1],
  },
  {
    id: "2w",
    what: "合成の紙色を白に固定（frameToRgba・Codex 3 回目の 20）",
    edits: [{ from: 'const paper = hexToRgb(p.colorTable[p.frames[fi].paper] || "#ffffff");', to: 'const paper = hexToRgb("#ffffff");' }],
    expect: [1],
  },
  {
    id: "2i",
    what: "線画の反転を無視する（convertToProject・Codex 3 回目の 21）",
    edits: [{ from: ": lineartBinarize(gray, o.edge, o.invert);", to: ": lineartBinarize(gray, o.edge, false);" }],
    expect: [1],
  },
  {
    id: "3n",
    what: "倍率 1 の拡大を最近傍にする（等倍でない拡大が混ざらなくなる）",
    edits: [{ from: "    if (!zoomed) {", to: "    if (!zoomed && d <= s) {" }],
    expect: [2],
  },
  {
    id: "3z",
    what: "倍率 1 でも倍率 >1 の道を通す（const zoomed = true）",
    edits: [{ from: "const zoomed = clampCropZoom(zoom) > 1;", to: "const zoomed = true;" }],
    expect: [2],
  },
  {
    id: "4i",
    what: "倍率 1 の k·s を 32 bit の掛け算（Math.imul）にする（上限の大きさで溢れる）",
    edits: [
      {
        from: FAST_LINES + FAST_TAIL,
        to: "        lo = Math.floor(Math.imul(k, s) / d);\n        hi = Math.min(s - 1, Math.max(lo, Math.ceil(Math.imul(k + 1, s) / d) - 1));\n" + FAST_TAIL,
      },
    ],
    expect: [3],
  },
  {
    id: "4f",
    what: "倍率 1 の k·s を単精度（Math.fround）で持つ（大きい値で丸まる）",
    edits: [
      {
        from: FAST_LINES + FAST_TAIL,
        to: "        lo = Math.floor(Math.fround(k * s) / d);\n        hi = Math.min(s - 1, Math.max(lo, Math.ceil(Math.fround((k + 1) * s) / d) - 1));\n" + FAST_TAIL,
      },
    ],
    expect: [3],
  },
  {
    id: "4c",
    what: "倍率 1 の hi の上限（s − 1）を外し、ceil の代わりに +1 する（元画像の外を読む）",
    edits: [
      {
        from: "        hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) * s) / d) - 1));\n" + FAST_TAIL,
        to: "        hi = Math.max(lo, Math.floor(((k + 1) * s) / d));\n" + FAST_TAIL,
      },
    ],
    expect: [3],
  },
];

// ================= 実行 =================
const NO_MUTANTS = process.argv.includes("--no-mutants");
const t0 = Date.now();
const REAL = (await import("../src/editor/imageConvert")) as Mod;
const old = await loadOld("old");
const olda = await loadOld("olda", [FIX_A]);
if (!old.M) console.log(`SKIP この回の前の blob ${BASELINE_BLOB.slice(0, 7)} を取り出せない（${old.why}）→ blob との突き合わせを飛ばす`);
// blob はあるのに [A] が当たらない＝基準か [A] の字面が古い。黙って (c)(d) を飛ばさず赤にする
if (old.M) check("[S-2] の基準: この回の前の blob に [A] がちょうど 1 か所当たる", !!olda.M, olda.why);
const ctx: Ctx = { OLD: old.M, OLDA: olda.M, OLDA_TEXT: olda.text, dir: root };

// 本物（V182_VERBOSE=1 なら赤の理由を全部出す＝報告書の表を作るとき）
const VERBOSE = process.env.V182_VERBOSE === "1";
for (const [name, fn] of CHECKS) {
  const t1 = Date.now();
  const r = run(fn, REAL, ctx);
  if (process.env.V182_TIME === "1") console.log(`  ${name.slice(0, 6)} ${((Date.now() - t1) / 1000).toFixed(1)} 秒`);
  const keep = VERBOSE ? r.bad.length : 6;
  const sep = VERBOSE ? "\n    " : " ／ ";
  check(name, r.bad.length === 0, r.bad.slice(0, keep).join(sep) + (r.bad.length > keep ? ` ／ …ほか ${r.bad.length - keep} 件` : ""));
}
if (s4Record) console.log(`  [S-4] 記録: ${s4Record}`);

// [S-5] 記録（判定ではない）
if (!NO_MUTANTS) {
  const n = recordS5(REAL, ctx.OLD);
  check("[S-5] 色を減らしたあとの差を記録した（判定ではない）", n > 0 || !ctx.OLD, `${n} 枚`);
}

// [S-0] 無改変の写し
if (!NO_MUTANTS) {
  const m = await mutant([]);
  let bad = 0;
  const why: string[] = [];
  for (const [name, fn] of CHECKS) {
    const r = run(fn, m.IC!, { ...ctx, dir: m.dir, quick: true });
    if (r.bad.length) {
      bad++;
      why.push(`${name.slice(0, 6)}: ${r.bad[0]}`);
    }
  }
  check("[S-0] 無改変の写しでは全部緑（写しの仕組みが赤を作っていない）", bad === 0, why.join(" ／ "));
}

// 反証
for (const c of NO_MUTANTS ? [] : COUNTERS) {
  const m = await mutant(c.edits);
  if (!m.IC) {
    check(`反証 ${c.id}（${c.what}）→ 赤になる`, false, m.why);
    continue;
  }
  const reds: string[] = [];
  let threwOnly = true;
  for (const k of c.expect) {
    const r = run(CHECKS[k][1], m.IC, { ...ctx, dir: m.dir, quick: true });
    if (r.bad.length) {
      reds.push(`${CHECKS[k][0].slice(0, 6)} ${r.bad[0]}`);
      if (!r.threw) threwOnly = false;
    }
  }
  const okRed = reds.length > 0 && !threwOnly;
  check(`反証 ${c.id}（${c.what}）→ 赤になる`, okRed, reds.length ? `例外でしか落ちない: ${reds[0]}` : "緑のまま（検査が効いていない）");
  if (okRed) console.log(`  反証 ${c.id} → 赤: ${reds[0].slice(0, 160)}`);
}

console.log(`\nv182_smoke: pass=${pass} fail=${fail}${NO_MUTANTS ? "（--no-mutants）" : ""}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
process.exit(fail ? 1 : 0);
