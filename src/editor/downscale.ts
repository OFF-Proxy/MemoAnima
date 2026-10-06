// V192（A-93・REQ_thumb_scale §2）: 320×240 の絵を画面に出すときの縮め方・広げ方。**表示だけ**。
//
//   320×240 より小さく出すとき … 面積で平均する（downscaleArea・**光の量で混ぜる**）
//   大きく出すとき             … 整数倍の最近傍（fitDisplay の k）
//   ★V192b（決-2 の改め）: ライブラリの再生画面だけは**枠いっぱい**（fitDisplay の fill）。半端な倍率は
//     同じ面積平均の式で広げる（resampleArea＝downscaleArea の別名・境目の 1 画素だけが混ざる）。
//     ちょうど整数倍なら最近傍と 1 画素も違わない（境目が無いので混ざる画素が無い）
//   どれも「画面の実際の画素」（CSS の大きさ × devicePixelRatio）で数える。
//
// ⚠ ここで混ぜた色は画面の画素にだけ出る。IndexBuf・保存する .memoanima・サムネの PNG（320×240）には
//   決して戻さない（索引バッファは可逆のみの不変条件はそのまま）。
// ⚠ ブラウザの縮小（image-rendering: auto・drawImage の補間）に任せない。WebView2 と WKWebView で結果が違い、
//   倍率によっては飛ばし拾い（1 ドットおきの柄の片方の色が消える）が残るので、自分で計算する。
//
// DOM に触らない純関数だけを置く（Node のスモークがこのまま動かす）。

// ---------------- sRGB ⇄ 光の量（リニア） ----------------
// 作者決定（2026-10-03・V192 の途中）: 混ぜる計算は光の量で（sRGB → リニア → 平均 → sRGB）。
// 例: 赤 #ff1717 × 青 #0038ce の一松柄 → (188, 43, 152)。sRGB の値のまま平均すると暗く濁る（128, 40, 114.5）。

/** sRGB の 8bit 値 → 光の量（0〜1）。IEC 61966-2-1 の式そのもの */
function srgbToLinear(v8: number): number {
  const c = v8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 256 通りの表（8bit → 光の量） */
const LIN = new Float64Array(256);
/** 光の量 → 8bit の境目: L ≥ EDGE[v] のとき 8bit 値は v 以上（v = 1..255）。EDGE[256] は番兵（∞）。
 *  encode が単調なので「round(255 × encode(L)) ≥ v ⇔ L ≥ decode((v − 0.5) / 255)」＝表を引くだけで丸めが正確 */
const EDGE = new Float64Array(257);
for (let v = 0; v < 256; v++) {
  LIN[v] = srgbToLinear(v);
  EDGE[v] = v === 0 ? -Infinity : srgbToLinear(v - 0.5);
}
EDGE[256] = Infinity;

/** 境目の表の二分探索（下の早見表を作るときだけ使う） */
function linearTo8Search(L: number): number {
  let lo = 0;
  let hi = 255;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (L >= EDGE[mid]) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** V192b（速さ）: 早見表。LUT8[i] ＝ L = i / LUT_N のときの 8bit 値（＝答えの下限）。
 *  i / LUT_N ≤ L なので、そこから境目を越える間だけ 1 つずつ上げれば**二分探索と同じ答え**になる
 *  （表の 1 区間 1/4096 は、境目のいちばん狭い所 ≒ 1/3,295 より狭い＝上げるのは多くて 1〜2 回） */
const LUT_N = 4096;
const LUT8 = new Uint8Array(LUT_N + 1);
for (let i = 0; i <= LUT_N; i++) LUT8[i] = linearTo8Search(i / LUT_N);

/** 光の量（0〜1）→ sRGB の 8bit 値（round(255 × encode(L)) と同じ） */
function linearTo8(L: number): number {
  let i = (L * LUT_N) | 0;
  if (i > LUT_N) i = LUT_N;
  else if (i < 0) i = 0;
  let v = LUT8[i];
  while (v < 255 && L >= EDGE[v + 1]) v++;
  return v;
}

// ---------------- 面積の重み ----------------

/** 1 本の軸の重み表: 出す画素 j が覆う元の画素 [start, start+count) と、その重み（整数・合計 = s）。
 *  V192b: 「組」（cls）＝同じ重みになる出す画素のまとまり。元の 1 画素の中に丸ごと入る出す画素が続く所は
 *  1 つの組（広げるときのドットの中身）。それ以外（境目・縮めるとき）は 1 画素で 1 組。組の代表で 1 回だけ計算して並べる */
type AxisTable = {
  start: Int32Array;
  count: Int32Array;
  w: Int32Array;
  stride: number;
  /** 組の数・各組の代表（＝最初の出す画素）と長さ */
  ncls: number;
  clsFirst: Int32Array;
  clsLen: Int32Array;
  /** 元の 2 画素以上をまたぐ組（境目・縮めるとき）の数・その組の番号の並び・組 → その並びの何番目か（1 画素だけの組は −1） */
  nb: number;
  bList: Int32Array;
  bIdx: Int32Array;
};

const axisCache = new Map<string, AxisTable>();

/**
 * 元の長さ s を出す長さ d にするときの重み。出す画素 j は元の [j·s/d, (j+1)·s/d) を覆う。
 * 両辺を d 倍した整数の区間 [j·s, (j+1)·s) と、元の画素 i の区間 [i·d, (i+1)·d) の重なりが重み（**整数で正確**）。
 * 1 つの出す画素の重みの合計は必ず s（端数の画素は割合で入る）。範囲の外（i < 0・i ≥ s）は読まない。
 * 縮める（d < s）のも広げる（d > s）のも同じ式（広げるときは 1 つの出す画素が触る元の画素は多くて 2 つ）。
 */
function axisTable(s: number, d: number): AxisTable {
  const key = `${s}/${d}`;
  const hit = axisCache.get(key);
  if (hit) return hit;
  const stride = Math.ceil(s / d) + 1; // 1 つの出す画素が触る元の画素の数の上限
  const start = new Int32Array(d);
  const count = new Int32Array(d);
  const w = new Int32Array(d * stride);
  for (let j = 0; j < d; j++) {
    const lo = j * s; // 単位 1/d の元の座標
    const hi = (j + 1) * s;
    const i0 = Math.floor(lo / d);
    const i1 = Math.min(s - 1, Math.floor((hi - 1) / d));
    start[j] = i0;
    count[j] = i1 - i0 + 1;
    for (let i = i0; i <= i1; i++) w[j * stride + (i - i0)] = Math.min(hi, (i + 1) * d) - Math.max(lo, i * d);
  }
  // 組: count が 1 で start が同じ出す画素が続く所はまとめる（重みは必ず s で同じ）
  const firsts: number[] = [];
  const lens: number[] = [];
  for (let j = 0; j < d; j++) {
    const last = firsts.length - 1;
    if (last >= 0 && count[j] === 1) {
      const f = firsts[last];
      if (count[f] === 1 && start[f] === start[j]) {
        lens[last]++;
        continue;
      }
    }
    firsts.push(j);
    lens.push(1);
  }
  const bList: number[] = [];
  const bIdx = new Int32Array(firsts.length).fill(-1);
  for (let c = 0; c < firsts.length; c++)
    if (count[firsts[c]] > 1) {
      bIdx[c] = bList.length;
      bList.push(c);
    }
  const t: AxisTable = {
    start,
    count,
    w,
    stride,
    ncls: firsts.length,
    clsFirst: Int32Array.from(firsts),
    clsLen: Int32Array.from(lens),
    nb: bList.length,
    bList: Int32Array.from(bList),
    bIdx,
  };
  if (axisCache.size > 64) axisCache.clear();
  axisCache.set(key, t);
  return t;
}

let midScratch: Float64Array | null = null;
let valScratch: Uint32Array | null = null;

/** 列の覚え（列の組ごとに 2 枠: 左・右・値・使っているか・次に入れ替える枠） */
type Memo = {
  a0: Uint32Array;
  b0: Uint32Array;
  v0: Uint32Array;
  a1: Uint32Array;
  b1: Uint32Array;
  v1: Uint32Array;
  ok: Uint8Array;
  next: Uint8Array;
};
let memoScratch: Memo | null = null;
function newMemo(n: number): Memo {
  return {
    a0: new Uint32Array(n),
    b0: new Uint32Array(n),
    v0: new Uint32Array(n),
    a1: new Uint32Array(n),
    b1: new Uint32Array(n),
    v1: new Uint32Array(n),
    ok: new Uint8Array(n),
    next: new Uint8Array(n),
  };
}

/**
 * ★面積平均（REQ_thumb_scale §2・決-1）: RGBA（sw×sh・sRGB）を dw×dh に縮める（V192b から広げるのにも使う）。
 * 出す 1 画素は、覆う元の画素の色を覆う面積の割合で、**光の量で**混ぜた色（sRGB → リニア → 平均 → sRGB・
 * 端数の画素は割合で）。ちょうど 1/2・1/4 なら 2×2・4×4 の（光の量の）平均と同じ。単色の面は単色のまま。
 * ちょうど整数倍に広げるときは、どの出す画素も元の 1 画素の中に入る＝最近傍と 1 画素も違わない。
 *
 * 透明（紙が透明＝paper=0 のコマ）: **透明のまま混ぜる**（不透明度で重みを付けた平均＝premultiplied）。
 * 透明だけの所は alpha 0 のまま＝市松の背景（.paper-clear の CSS）がそのまま見える。半分だけ描いてある所は
 * 半透明になり、色は描いてある画素の色だけで決まる（透明の画素の RGB＝ふつう 0,0,0 が混ざって暗くならない）。
 * alpha は覆う面積の割合（光の量と同じく線形）なので、そのまま平均する。
 *
 * V192b（速さ・答えは V192 と 1 バイトも同じ）: 同じ重みになる出す画素（組）は代表で 1 回だけ計算して並べる。
 * 代表の計算は V192 と**同じ足し算を同じ順に**やる。縦横とも元の 1 画素の中に丸ごと入る組は、その画素を
 * そのまま写す（式で計算しても同じ値になる＝[S-10] が V192 の関数と全画素で照らす）。
 *
 * 純関数（入力を書き換えない）。out を渡せばそこへ書く（長さ dw*dh*4）。
 */
export function downscaleArea(
  src: Uint8ClampedArray | Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  sw = sw | 0;
  sh = sh | 0;
  dw = Math.max(1, dw | 0);
  dh = Math.max(1, dh | 0);
  if (sw <= 0 || sh <= 0) throw new Error(`downscaleArea: empty source (${sw}x${sh})`);
  if (src.length < sw * sh * 4) throw new Error(`downscaleArea: src too short (${src.length} < ${sw * sh * 4})`);
  const dst = out && out.length === dw * dh * 4 ? out : new Uint8ClampedArray(dw * dh * 4);
  const tx = axisTable(sw, dw);
  const ty = axisTable(sh, dh);
  const ncx = tx.ncls;
  const ncy = ty.ncls;
  const nb = tx.nb;
  // 元の画素を 32bit で読む（覆う画素が全部同じかを 1 回で比べる）。揃っていない入力は 1 回だけ写す
  let s32: Uint32Array;
  if (src.byteOffset % 4 === 0) s32 = new Uint32Array(src.buffer, src.byteOffset, sw * sh);
  else {
    s32 = new Uint32Array(sw * sh);
    for (let i = 0; i < sw * sh; i++)
      s32[i] = (src[i * 4] | (src[i * 4 + 1] << 8) | (src[i * 4 + 2] << 16) | (src[i * 4 + 3] << 24)) >>> 0;
  }
  // 1 段目: 横（元の各行 → 横に 2 画素以上をまたぐ列の組の代表＝境目・縮めるとき）。値は光の量 × 不透明度 × 横の重み
  //（premultiplied）。横に 1 画素だけの列の組は、2 段目でその場で同じ式（0 + L·α·w）を出す＝持たない
  const need = sh * nb * 4;
  if (!midScratch || midScratch.length < need) midScratch = new Float64Array(Math.max(need, 4));
  const mid = midScratch;
  for (let y = 0; y < sh; y++) {
    const srow = y * sw * 4;
    const mrow = y * nb * 4;
    for (let bi = 0; bi < nb; bi++) {
      const j = tx.clsFirst[tx.bList[bi]];
      const i0 = tx.start[j];
      const n = tx.count[j];
      const wb = j * tx.stride;
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let k = 0; k < n; k++) {
        const p = srow + (i0 + k) * 4;
        const al = src[p + 3] * tx.w[wb + k];
        if (al === 0) continue;
        r += LIN[src[p]] * al;
        g += LIN[src[p + 1]] * al;
        b += LIN[src[p + 2]] * al;
        a += al;
      }
      const m = mrow + bi * 4;
      mid[m] = r;
      mid[m + 1] = g;
      mid[m + 2] = b;
      mid[m + 3] = a;
    }
  }
  // 2 段目: 縦（行の組の代表 × 列の組）。重みの合計は sw·sh（横 sw × 縦 sh）。alpha は合計で割り、色は不透明度の合計で割る
  if (!valScratch || valScratch.length < ncx) valScratch = new Uint32Array(Math.max(ncx, 64));
  const vals = valScratch;
  const d32 = dst.byteOffset % 4 === 0 ? new Uint32Array(dst.buffer, dst.byteOffset, dw * dh) : null;
  const area = sw * sh;
  // 覚え（広げるとき・答えは同じ）: 重みが決まっていれば、答えは覆う 2 画素だけで決まる（同じ入力に同じ順の同じ計算）。
  //   列の覚え: 横の境目（列の組 c・横 2 画素）× 縦は 1 画素の行 → 列の組ごとに直近 2 組の (左, 右) → 値
  //   行の覚え: 縦の境目の行（行の組・縦 2 画素）× 横は 1 画素の列 → 行の組の中で直近 2 組の (上, 下) → 値
  // 一松柄のように同じ 2 色の組が並ぶ所で計算が要らなくなる
  if (!memoScratch || memoScratch.ok.length < ncx) memoScratch = newMemo(Math.max(ncx, 64));
  const cm = memoScratch;
  cm.ok.fill(0, 0, ncx);
  for (let rc = 0; rc < ncy; rc++) {
    const j = ty.clsFirst[rc];
    const i0 = ty.start[j];
    const n = ty.count[j];
    const wb = j * ty.stride;
    const row0 = i0 * sw;
    let rOk = 0,
      rA0 = 0,
      rB0 = 0,
      rV0 = 0,
      rA1 = 0,
      rB1 = 0,
      rV1 = 0,
      rNext = 0;
    for (let c = 0; c < ncx; c++) {
      const jx = tx.clsFirst[c];
      const xs = tx.start[jx];
      const xn = tx.count[jx];
      // 覆う元の画素（縦 n × 横 xn）が全部同じなら、その画素そのもの（透明は 0）。式で計算しても同じ値
      //（Σ L·α·w ÷ Σ α·w ＝ L の数 ulp 以内＝8bit の境目には届かない・α は整数の和で正確）＝[S-10] が全画素で照らす
      const v0 = s32[row0 + xs];
      let same = true;
      scan: for (let ky = 0; ky < n; ky++) {
        const rb = row0 + ky * sw + xs;
        for (let kx = 0; kx < xn; kx++)
          if (s32[rb + kx] !== v0) {
            same = false;
            break scan;
          }
      }
      if (same) {
        vals[c] = v0 >>> 24 === 0 ? 0 : v0;
        continue;
      }
      // 覚えを引く（広げるときの片側だけの境目）
      let memo = 0; // 1 = 列の覚え・2 = 行の覚え
      let kA = 0,
        kB = 0;
      if (n === 1 && xn === 2) {
        memo = 1;
        kA = v0;
        kB = s32[row0 + xs + 1];
        const ok = cm.ok[c];
        if (ok & 1 && cm.a0[c] === kA && cm.b0[c] === kB) {
          vals[c] = cm.v0[c];
          continue;
        }
        if (ok & 2 && cm.a1[c] === kA && cm.b1[c] === kB) {
          vals[c] = cm.v1[c];
          continue;
        }
      } else if (n === 2 && xn === 1) {
        memo = 2;
        kA = v0;
        kB = s32[row0 + sw + xs];
        if (rOk & 1 && rA0 === kA && rB0 === kB) {
          vals[c] = rV0;
          continue;
        }
        if (rOk & 2 && rA1 === kA && rB1 === kB) {
          vals[c] = rV1;
          continue;
        }
      }
      // 計算（V192 と同じ足し算を同じ順に）
      const bi = tx.bIdx[c];
      const wx1 = tx.w[jx * tx.stride]; // 横に 1 画素だけの列の組の重み（＝sw）
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let k = 0; k < n; k++) {
        const wk = ty.w[wb + k];
        let mr = 0,
          mg = 0,
          mb = 0,
          ma = 0;
        if (bi >= 0) {
          const m = ((i0 + k) * nb + bi) * 4;
          mr = mid[m];
          mg = mid[m + 1];
          mb = mid[m + 2];
          ma = mid[m + 3];
        } else {
          // 1 段目と同じ式（0 + L·α·w。α·w が 0 なら 0）
          const p = ((i0 + k) * sw + xs) * 4;
          const al = src[p + 3] * wx1;
          if (al !== 0) {
            mr = LIN[src[p]] * al;
            mg = LIN[src[p + 1]] * al;
            mb = LIN[src[p + 2]] * al;
            ma = al;
          }
        }
        r += mr * wk;
        g += mg * wk;
        b += mb * wk;
        a += ma * wk;
      }
      let val = 0;
      if (a > 0) {
        const R = linearTo8(r / a);
        const G = linearTo8(g / a);
        const B = linearTo8(b / a);
        const A = Math.round(a / area);
        val = (R | (G << 8) | (B << 16) | (A << 24)) >>> 0;
      }
      vals[c] = val;
      // 覚える（古い方を入れ替える）
      if (memo === 1) {
        if (cm.next[c] === 0) {
          cm.a0[c] = kA;
          cm.b0[c] = kB;
          cm.v0[c] = val;
          cm.ok[c] |= 1;
          cm.next[c] = 1;
        } else {
          cm.a1[c] = kA;
          cm.b1[c] = kB;
          cm.v1[c] = val;
          cm.ok[c] |= 2;
          cm.next[c] = 0;
        }
      } else if (memo === 2) {
        if (rNext === 0) {
          rA0 = kA;
          rB0 = kB;
          rV0 = val;
          rOk |= 1;
          rNext = 1;
        } else {
          rA1 = kA;
          rB1 = kB;
          rV1 = val;
          rOk |= 2;
          rNext = 0;
        }
      }
    }
    // 組の代表の行を並べ、同じ組のほかの行は写す
    const ylen = ty.clsLen[rc];
    const o = j * dw;
    if (d32) {
      for (let c = 0; c < ncx; c++) {
        const v = vals[c];
        const x0 = o + tx.clsFirst[c];
        const x1 = x0 + tx.clsLen[c];
        for (let x = x0; x < x1; x++) d32[x] = v;
      }
      for (let q = 1; q < ylen; q++) d32.copyWithin(o + q * dw, o, o + dw);
    } else {
      for (let c = 0; c < ncx; c++) {
        const v = vals[c];
        const x0 = o + tx.clsFirst[c];
        const x1 = x0 + tx.clsLen[c];
        for (let x = x0; x < x1; x++) {
          dst[x * 4] = v & 255;
          dst[x * 4 + 1] = (v >>> 8) & 255;
          dst[x * 4 + 2] = (v >>> 16) & 255;
          dst[x * 4 + 3] = v >>> 24;
        }
      }
      for (let q = 1; q < ylen; q++) dst.copyWithin((o + q * dw) * 4, o * 4, (o + dw) * 4);
    }
  }
  return dst;
}

/** V192b: 広げる向きにも使うときの名前（中身は downscaleArea そのもの＝式は 1 つ） */
export const resampleArea = downscaleArea;

// ---------------- 出す大きさ ----------------

/** 表示の決め方（fitDisplay の結果）。dev* は実画素・css* は CSS の px（= dev / dpr） */
export type DisplayFit = {
  /** "up" = 整数倍（k ≥ 1・最近傍）／"down" = 面積平均で縮める／"fill" = 枠いっぱい・半端な倍率を面積平均で広げる（V192b・再生画面だけ） */
  mode: "up" | "down" | "fill";
  /** 整数倍の倍率（"down"・"fill" のときは 0） */
  k: number;
  devW: number;
  devH: number;
  cssW: number;
  cssH: number;
};

/**
 * 枠（CSS の px・幅 boxW × 高さ boxH）に sw×sh の絵を出すときの大きさ（REQ_thumb_scale §2）。
 *   実画素の枠 = floor(CSS の大きさ × dpr)。
 *   既定（整数倍）: k = floor(min(枠の幅 / sw, 枠の高さ / sh))（実画素）。k ≥ 1 なら sw·k × sh·k の実画素（整数倍・最近傍）。
 *   k = 0（枠が sw×sh の実画素より小さい）なら、縦横比を保って枠に入るいちばん大きい大きさへ面積平均で縮める
 *   （k = 1 にしてはみ出させない）。
 *   ★fill（V192b・再生画面だけ）: 枠が sw×sh 以上なら、縦横比を保って枠に入る**いちばん大きい**大きさ（整数の実画素・
 *   縦か横のどちらかが枠いっぱい）。それがちょうど整数倍なら "up"（最近傍）・半端なら "fill"（面積平均で広げる）。
 *   枠が sw×sh より小さければ既定と同じ "down"。
 * 出す大きさは必ず枠（実画素）に入る。CSS の大きさは dev / dpr（キャンバスを CSS で引き伸ばさない＝1:1）。
 */
export function fitDisplay(
  boxW: number,
  boxH: number,
  dpr: number,
  sw = 320,
  sh = 240,
  fill = false,
): DisplayFit {
  const r = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  // 1e-6: CSS の大きさ × dpr がちょうど整数のとき（例 256 × 1.25 = 320）に浮動小数の誤差で 1 減らさない
  const bw = Math.max(0, Math.floor(boxW * r + 1e-6));
  const bh = Math.max(0, Math.floor(boxH * r + 1e-6));
  const k = Math.floor(Math.min(bw / sw, bh / sh));
  if (k >= 1 && !fill) return { mode: "up", k, devW: sw * k, devH: sh * k, cssW: (sw * k) / r, cssH: (sh * k) / r };
  // 縦横比を保って枠に入るいちばん大きい大きさ（整数の実画素）。縮める（k = 0）のも枠いっぱい（fill）も同じ数え方
  let dw = Math.min(bw, Math.floor((bh * sw) / sh));
  let dh = Math.round((dw * sh) / sw);
  if (dh > bh) {
    dh = bh;
    dw = Math.min(bw, Math.floor((dh * sw) / sh));
  }
  dw = Math.max(1, dw);
  dh = Math.max(1, dh);
  if (k >= 1) {
    // fill: ちょうど整数倍なら最近傍（混ぜる画素が無い）
    const kk = dw / sw;
    if (Number.isInteger(kk) && dh === sh * kk) return { mode: "up", k: kk, devW: dw, devH: dh, cssW: dw / r, cssH: dh / r };
    return { mode: "fill", k: 0, devW: dw, devH: dh, cssW: dw / r, cssH: dh / r };
  }
  return { mode: "down", k: 0, devW: dw, devH: dh, cssW: dw / r, cssH: dh / r };
}
