// V179 スモーク（A-73）: 画像取り込みの範囲をドラッグで動かす・拡大する
//   要件 docs/REQ_image_import_crop.md §5 ／ 指示書 docs/handoff/SEND_TO_CODE_V179.html [D]
//   実行: npx tsx scripts/v179_smoke.ts   （引数不要）
//
// ★見るのは**動かした結果（出力画素）**。ソースの字面を並べて禁じる形（denylist）は使わない。
// ★反証は**実ファイルを書き換えた写し**で当てる: src/ を node_modules/.v179-smoke/<pid>/ へ写し、
//   src/editor/imageConvert.ts の 1 か所だけを書き換えて、本物と同じ import の道で読む。
//   書き換えがちょうど 1 か所に当たらなければ赤。**例外で落ちた反証は「効いた」と数えない**。
//
//   [S-0] 無改変の写しでは全部緑（写しの仕組みが赤を作っていない）
//   [S-1] ★既定値（zoom・center 省略）の出力が、この回の前とバイト一致
//         （凍結コピー／この回の前の blob そのもの／固定のハッシュ の 3 つと突き合わせる・奇数幅を含む）
//         ★V182（A-79）で意図して置き換えた（消していない）: 倍率 1 の範囲の出し方を浮動小数から整数の割り算にしたので、
//         「既定値の出力＝この回の前の式（凍結コピー）の**範囲の 4 行だけ**を整数にしたもの」「倍率 >1 は V182 の前とバイト一致」の形。
//         置き場所（奇数幅の罠）・平均の切り捨て・α・明るさ/コントラスト・変換一式は前と同じく 1 バイトまで見る（緩めたのは範囲の式の 1 点だけ）
//   [S-2] zoom=2・中央で、元画像の中央 1/2 の範囲が枠いっぱいに出る（期待画素は別の計算）
//   [S-3] center を端（0・1・範囲外）にしても枠に隙間ができない
//   [S-4] 枠より小さい軸は中央に固定（contain・zoom=1 は center を動かしても出力が変わらない）
//   [S-5] ★大きさの違う 2 枚に同じ zoom・center を渡すと同じ構図（割合で持つ・連番は全ページ共通）
//   [S-6] 拡大はにじまない（zoom=4 で出力の各画素が元画像のどれか 1 画素の色と一致）
//   [S-7] zoom は 1〜8 に収まる（範囲外を渡しても収めて使う）
//   [S-8] プレビューの素の絵（ドラッグ中）が使う置き場所 canvasPlacement と、変換の結果が同じ所に絵を置く（R-8）
//   [S-9] ドラッグ・ホイールの計算（panCropCenter / zoomCropCenter / 段）: 絵は指についてくる・端より先へは動かない・
//         端から戻すとすぐ動く・動かせない軸は変えない・ホイールはカーソルの下の点を動かさない（R-2・R-5）
//   [S-10] ★ダイアログの操作（本物の createCropController / bindCropCanvas / cropSliderHandlers に、偽の canvas・
//         偽のタイマー・偽の window で出来事を流す）: ドラッグ・倍率スライダーを触っている間は変換 0 回・
//         離したら 100ms 後に 1 回・ホイールは既定の動き（スクロール）を止めて 1 ノッチ＝1 段・250ms 後に変換・
//         「離した」が届かなくても止まったままにならない・位置を戻す／2 択で出発点・閉じたら何もしない（R-3・R-5・R-6・R-10）
//   [S-11] ★main.ts が呼ぶ組み立て createCropPreview に偽の canvas 要素を渡す: pointer 5 種と wheel の受け口・
//         ★wheel は passive: false・枠線と表示の倍率を除いた座標・捕捉が例外を投げてもドラッグが続く・掴んだカーソル・
//         返されたスライダーの口（main.ts に残るのは、この 1 つを呼ぶことと DOM の要素を渡すことだけ）
//   [S-12] main.ts の呼び出し口の形を TypeScript の構文木で見る（main.ts は Node で動かせない）: createCropPreview は 1 回・
//         本物の #ii-cv（const）と window を渡す・プレビューの変換は関所の中と「取り込む」ボタンの中だけ・CSS の touch-action: none
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
/** 画素ごとに**すべて違う**色（α=255）。出力の色から「どの画素が出たか」を引ける */
function distinctImg(w: number, h: number, seed: number): { img: Img; where: Map<number, number> } {
  const r = rng(seed);
  const data = new Uint8Array(w * h * 4);
  const where = new Map<number, number>();
  for (let i = 0; i < w * h; i++) {
    let c: number;
    do c = Math.floor(r() * 0x1000000);
    while (where.has(c));
    where.set(c, i);
    data[i * 4] = c >> 16;
    data[i * 4 + 1] = (c >> 8) & 255;
    data[i * 4 + 2] = c & 255;
    data[i * 4 + 3] = 255;
  }
  return { img: { w, h, data }, where };
}
/** 座標をそのまま色にした絵（x・y の下位 8bit と上位 4bit）。1:1 と最近傍の出力から座標を読み戻せる */
function coordImg(w: number, h: number): Img {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x & 255;
      data[i + 1] = y & 255;
      data[i + 2] = ((x >> 8) & 15) | (((y >> 8) & 15) << 4);
      data[i + 3] = 255;
    }
  return { w, h, data };
}
const decodeX = (d: Uint8Array | Uint8ClampedArray, i: number) => d[i] | ((d[i + 2] & 15) << 8);
const decodeY = (d: Uint8Array | Uint8ClampedArray, i: number) => d[i + 1] | (((d[i + 2] >> 4) & 15) << 8);
/** なめらかな傾き（R＝横の位置・G＝縦の位置）。大きさが違っても「同じ絵」を描ける */
function rampImg(w: number, h: number): Img {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.round((255 * (x + 0.5)) / w);
      data[i + 1] = Math.round((255 * (y + 0.5)) / h);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  return { w, h, data };
}
/** 最近傍で k 倍に広げた写し（同じ絵を大きさ違いで持つ） */
function upscale(src: Img, k: number): Img {
  const w = src.w * k;
  const h = src.h * k;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (Math.floor(y / k) * src.w + Math.floor(x / k)) * 4;
      const di = (y * w + x) * 4;
      data[di] = src.data[si];
      data[di + 1] = src.data[si + 1];
      data[di + 2] = src.data[si + 2];
      data[di + 3] = src.data[si + 3];
    }
  return { w, h, data };
}
const sameBytes = (a: Uint8Array | Uint8ClampedArray | Uint16Array, b: Uint8Array | Uint8ClampedArray | Uint16Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const firstDiff = (a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return `画素 (${(i >> 2) % W}, ${Math.floor((i >> 2) / W)}) ch${i & 3}: ${a[i]} ≠ ${b[i]}`;
  return a.length === b.length ? "" : `長さ ${a.length} ≠ ${b.length}`;
};

// ================= この回の前の resizeToCanvas（凍結コピー） =================
// blob 672c37023ad77fb6ad896436215844da3de1f623（src/editor/imageConvert.ts・M12-1c-2 以降 V178 まで不変）の
// 107-150 行を**そのまま**写したもの。★書き換えない（[S-1] の物差し）
function oldResizeToCanvas(img: Img, fit: Fit): Img {
  const out = new Uint8Array(W * H * 4);
  const scale =
    fit === "cover" ? Math.max(W / img.w, H / img.h) : Math.min(W / img.w, H / img.h);
  const dw = Math.max(1, Math.round(img.w * scale));
  const dh = Math.max(1, Math.round(img.h * scale));
  const dx0 = Math.floor((W - dw) / 2);
  const dy0 = Math.floor((H - dh) / 2);
  for (let dy = 0; dy < dh; dy++) {
    const oy = dy0 + dy;
    if (oy < 0 || oy >= H) continue;
    const sy0 = (dy / dh) * img.h;
    const sy1 = ((dy + 1) / dh) * img.h;
    for (let dx = 0; dx < dw; dx++) {
      const ox = dx0 + dx;
      if (ox < 0 || ox >= W) continue;
      const sx0 = (dx / dw) * img.w;
      const sx1 = ((dx + 1) / dw) * img.w;
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      const yA = Math.floor(sy0);
      const yB = Math.min(img.h - 1, Math.max(yA, Math.ceil(sy1) - 1));
      const xA = Math.floor(sx0);
      const xB = Math.min(img.w - 1, Math.max(xA, Math.ceil(sx1) - 1));
      for (let sy = yA; sy <= yB; sy++)
        for (let sx = xA; sx <= xB; sx++) {
          const si = (sy * img.w + sx) * 4;
          r += img.data[si];
          g += img.data[si + 1];
          b += img.data[si + 2];
          n++;
        }
      const oi = (oy * W + ox) * 4;
      out[oi] = r / n;
      out[oi + 1] = g / n;
      out[oi + 2] = b / n;
      out[oi + 3] = 255;
    }
  }
  return { w: W, h: H, data: out };
}
const BASELINE_BLOB = "672c37023ad77fb6ad896436215844da3de1f623";

// ================= V182: 倍率 1 の範囲を整数の割り算にした物差し =================
// oldResizeToCanvas（上の凍結コピー）の**範囲の 4 行（sy0・sy1・sx0・sx1）だけ**を整数の割り算 (i * s) / d にしたもの。
// それ以外（置き場所・平均の切り捨て・α）は 1 文字も変えていない。★書き換えない（V182 の [S-1] の物差し）
function intResizeToCanvas(img: Img, fit: Fit): Img {
  const out = new Uint8Array(W * H * 4);
  const scale =
    fit === "cover" ? Math.max(W / img.w, H / img.h) : Math.min(W / img.w, H / img.h);
  const dw = Math.max(1, Math.round(img.w * scale));
  const dh = Math.max(1, Math.round(img.h * scale));
  const dx0 = Math.floor((W - dw) / 2);
  const dy0 = Math.floor((H - dh) / 2);
  for (let dy = 0; dy < dh; dy++) {
    const oy = dy0 + dy;
    if (oy < 0 || oy >= H) continue;
    const sy0 = (dy * img.h) / dh;
    const sy1 = ((dy + 1) * img.h) / dh;
    for (let dx = 0; dx < dw; dx++) {
      const ox = dx0 + dx;
      if (ox < 0 || ox >= W) continue;
      const sx0 = (dx * img.w) / dw;
      const sx1 = ((dx + 1) * img.w) / dw;
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      const yA = Math.floor(sy0);
      const yB = Math.min(img.h - 1, Math.max(yA, Math.ceil(sy1) - 1));
      const xA = Math.floor(sx0);
      const xB = Math.min(img.w - 1, Math.max(xA, Math.ceil(sx1) - 1));
      for (let sy = yA; sy <= yB; sy++)
        for (let sx = xA; sx <= xB; sx++) {
          const si = (sy * img.w + sx) * 4;
          r += img.data[si];
          g += img.data[si + 1];
          b += img.data[si + 2];
          n++;
        }
      const oi = (oy * W + ox) * 4;
      out[oi] = r / n;
      out[oi + 1] = g / n;
      out[oi + 2] = b / n;
      out[oi + 3] = 255;
    }
  }
  return { w: W, h: H, data: out };
}
/** 1 軸ぶん、前の式（浮動小数）と整数の割り算で範囲が違う出力の位置（置き場所は前の式）。[S-1] で「変わってよい画素」を決める */
function spanChanged(d: number, s: number, frame: number): boolean[] {
  const d0 = Math.floor((frame - d) / 2);
  const out: boolean[] = [];
  for (let o = 0; o < frame; o++) {
    const k = o - d0;
    if (k < 0 || k >= d) {
      out.push(false);
      continue;
    }
    const fa = Math.floor((k / d) * s);
    const fb = Math.min(s - 1, Math.max(fa, Math.ceil(((k + 1) / d) * s) - 1));
    const ia = Math.floor((k * s) / d);
    const ib = Math.min(s - 1, Math.max(ia, Math.ceil(((k + 1) * s) / d) - 1));
    out.push(fa !== ia || fb !== ib);
  }
  return out;
}
/** V182 の前（V181 まで）の imageConvert.ts の blob（倍率 >1 はこれとバイト一致のまま） */
const V182_PRE_BLOB = "b3a07751539ec2443db6012ff91c580227d2aee4";
/** この回（V179）の前の blob に当てる V182 の 1 点（範囲の 4 行を整数の割り算に）。どれもちょうど 1 か所に当たること */
const V182_INT_EDITS = [
  { from: "    const sy0 = (dy / dh) * img.h;", to: "    const sy0 = (dy * img.h) / dh;" },
  { from: "    const sy1 = ((dy + 1) / dh) * img.h;", to: "    const sy1 = ((dy + 1) * img.h) / dh;" },
  { from: "      const sx0 = (dx / dw) * img.w;", to: "      const sx0 = (dx * img.w) / dw;" },
  { from: "      const sx1 = ((dx + 1) / dw) * img.w;", to: "      const sx1 = ((dx + 1) * img.w) / dw;" },
];

// [S-1] の絵の一覧: 横長・縦長・正方形・奇数幅・1×1 ほか（名前つき）＋種つきの乱数の大きさ 40 通り
const NAMED: [number, number][] = [
  [500, 300], // 横長
  [300, 500], // 縦長
  [256, 256], // 正方形
  [333, 211], // 奇数幅（横長）
  [211, 333], // 奇数幅（縦長）
  [1, 1],
  [1, 7],
  [7, 1],
  [3, 2],
  [1280, 720],
  [640, 480], // 4:3 ちょうど（はみ出しなし）
  [641, 319],
  [100, 75], // 小さい画像の拡大（出発点が 1 より大きい）
  [97, 61],
  [320, 240],
  [321, 241],
  [319, 239],
  [700, 70], // 細長い
];
function corpus(): Img[] {
  const list: Img[] = NAMED.map(([w, h], i) => randImg(w, h, 1000 + i));
  const r = rng(179);
  while (list.length < NAMED.length + 40) {
    const w = 1 + Math.floor(r() * 900);
    const h = 1 + Math.floor(r() * 900);
    const s = Math.max(W / w, H / h);
    if (Math.round(w * s) * Math.round(h * s) > 4_000_000) continue; // 古い形は全部の行を回すので極端な細長は避ける
    list.push(randImg(w, h, 5000 + list.length));
  }
  return list;
}
const CORPUS = corpus();
/** 固定のハッシュ: この回の前のコードで CORPUS を cover・contain の順に変換した出力の SHA-256（2026-09-24 に算出）。
 *  ★V182 のあとも消さない＝V179 の前（と V181 まで）の既定の出力。凍結コピーとこの回の前の blob がこれを出すこと（物差しが動いていない） */
const PINNED_DEFAULT_SHA = "0db9726468fad6ca9efcc1a77231197538b588484336e8073de62daa01a05823";
/** 固定のハッシュ（V182・2026-09-25 に算出）: 倍率 1 の範囲を整数の割り算にしたあとの既定の出力。
 *  ★本物だけでなく、凍結コピーの範囲の 4 行だけを整数にした写し（intResizeToCanvas）もこれを出すこと＝貼り替えただけの値ではない */
const PINNED_DEFAULT_SHA_V182 = "32d700fc4a4e7307c805139c6ae5adee782edcce092112cac239e841f54a9783";

function outputsSha(resize: (img: Img, fit: Fit) => Img): string {
  const hsh = crypto.createHash("sha256");
  for (const img of CORPUS)
    for (const fit of FITS) {
      const o = resize(img, fit);
      hsh.update(o.data);
    }
  return hsh.digest("hex");
}
function defaultOutputsSha(IC: Mod): string {
  return outputsSha((img, fit) => IC.resizeToCanvas(img, fit) as Img);
}

// ================= 検査（どれも「赤の理由の一覧」を返す＝空なら緑） =================
type Check = (IC: Mod, ctx: Ctx) => string[];
interface Ctx {
  /** この回の前の imageConvert（blob から取り出した本物）。取り出せないときは null */
  OLD: Mod | null;
  /** V182: この回の前の blob に、範囲の 4 行だけを整数にする 1 点（V182_INT_EDITS）を当てた写し。取り出せないときは null */
  OLD_INT: Mod | null;
  /** V182 の前（V181 まで）の imageConvert（blob b3a0775）。倍率 >1 はこれとバイト一致。取り出せないときは null */
  PRE182: Mod | null;
  /** 見ている木の根（本物＝リポジトリ・反証＝写し）。[S-12] が src/main.ts と src/styles.css を読む */
  dir: string;
}

// ---------------- [S-1] 既定値（倍率 1）＝この回の前の式の範囲だけ整数（V182）・倍率 >1 は V182 の前とバイト一致 ----------------
// ★V182（A-79）で置き換えた。V179 の時点は「既定値の出力が、この回の前（凍結コピー・blob・固定のハッシュ）とバイト一致」だった。
//   緩めたのは**範囲の出し方の 1 点だけ**: 物差しを凍結コピー oldResizeToCanvas から、その範囲の 4 行だけを整数にした intResizeToCanvas へ。
//   置き場所（奇数幅の罠）・平均の切り捨て・α・明るさ/コントラスト・変換一式（量子化・ディザ・トーン・線画）は前と同じく 1 バイトまで見る。
const S1: Check = (IC, ctx) => {
  const bad: string[] = [];
  let odd = 0;
  let changed = 0;
  for (const img of CORPUS)
    for (const fit of FITS) {
      const ref = intResizeToCanvas(img, fit);
      const a = IC.resizeToCanvas(img, fit) as Img;
      if (!sameBytes(a.data, ref.data)) bad.push(`省略 ${img.w}×${img.h} ${fit}: ${firstDiff(a.data, ref.data)}`);
      // 画面の「位置を戻す」と同じ明示の既定値（倍率 1・中央）も同じ絵
      const b = IC.resizeToCanvas(img, fit, 1, { x: 0.5, y: 0.5 }) as Img;
      if (!sameBytes(b.data, ref.data)) bad.push(`明示の既定値 ${img.w}×${img.h} ${fit}: ${firstDiff(b.data, ref.data)}`);
      // この絵が「奇数幅の罠」に当たっているか（枠との差が奇数）を数える＝罠が検査に入っていることの確認
      const s = fit === "cover" ? Math.max(W / img.w, H / img.h) : Math.min(W / img.w, H / img.h);
      const dw = Math.max(1, Math.round(img.w * s));
      const dh = Math.max(1, Math.round(img.h * s));
      if ((W - dw) % 2 !== 0 || (H - dh) % 2 !== 0) odd++;
      // V182: 前の式（凍結コピー）と違ってよいのは、浮動小数と整数で範囲が違う画素だけ（ほかの画素は前と 1 バイトも同じ）
      const old = oldResizeToCanvas(img, fit);
      const cx = spanChanged(dw, img.w, W);
      const cy = spanChanged(dh, img.h, H);
      let other = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (a.data[i] === old.data[i] && a.data[i + 1] === old.data[i + 1] && a.data[i + 2] === old.data[i + 2] && a.data[i + 3] === old.data[i + 3]) continue;
          if (cx[x] || cy[y]) changed++;
          else other++;
        }
      if (other) bad.push(`${img.w}×${img.h} ${fit}: 範囲が変わらない画素なのに前の式と違う ${other} 画素`);
    }
  if (odd < 20) bad.push(`奇数幅の罠に当たる絵が少ない（${odd} 件）＝検査が罠を見ていない`);
  if (changed === 0) bad.push("V182 で範囲が変わる画素が 1 つも無い（検査が空振り＝物差しが前の式と同じ）");
  // prepareCanvas（明るさ・コントラスト込み）も同じ
  for (const img of CORPUS.slice(0, 12))
    for (const fit of FITS)
      for (const [br, ct] of [
        [0, 0],
        [30, -20],
      ]) {
        const o = { ...IC.DEFAULT_CONVERT, fit, brightness: br, contrast: ct };
        const a = IC.prepareCanvas(img, o) as Img;
        const ref = intResizeToCanvas(IC.applyBC(img, br, ct), fit);
        if (!sameBytes(a.data, ref.data)) bad.push(`prepareCanvas ${img.w}×${img.h} ${fit} BC(${br},${ct})`);
      }
  // 固定のハッシュ（2 つ）
  // ・V179 の前の出力: 凍結コピーとこの回の前の blob がこれを出す（物差しが動いていない）
  if (outputsSha(oldResizeToCanvas) !== PINNED_DEFAULT_SHA) bad.push("凍結コピー（前の式）の出力が V179 の前の固定のハッシュと違う（物差しが動いた）");
  if (ctx.OLD && defaultOutputsSha(ctx.OLD) !== PINNED_DEFAULT_SHA) bad.push("この回の前の blob の出力が固定のハッシュと違う（固定値の取り違え）");
  // ・V182 の出力: 本物と、凍結コピーの範囲だけ整数にした写しの両方がこれを出す（貼り替えただけの値ではない）
  if (PINNED_DEFAULT_SHA_V182 !== "TBD") {
    const sha = defaultOutputsSha(IC);
    if (sha !== PINNED_DEFAULT_SHA_V182) bad.push(`既定値の出力のハッシュが V182 の固定値と違う: ${sha.slice(0, 16)}… ≠ ${PINNED_DEFAULT_SHA_V182.slice(0, 16)}…`);
    if (outputsSha(intResizeToCanvas) !== PINNED_DEFAULT_SHA_V182) bad.push("範囲だけ整数にした凍結コピーの出力が V182 の固定のハッシュと違う（固定値の取り違え）");
  } else bad.push("V182 の固定のハッシュが未設定（TBD）");
  // この回の前の blob に V182 の 1 点だけを当てた写し: 変換一式（量子化・ディザ・トーン・線画まで）が 1 バイトも違わない
  if (ctx.OLD_INT) {
    const modes: Record<string, unknown>[] = [
      { mode: "color" },
      { mode: "color", palette: "ugo", dither: "ordered" },
      { mode: "color", palette: "retro", dither: "none", colors: 8 },
      { mode: "tone", threshold: 40, ditherAmt: 70 },
      { mode: "tone", dither: "ordered", invert: true },
      { mode: "lineart", edge: 70 },
    ];
    const imgs = [CORPUS[0], CORPUS[1], CORPUS[3], CORPUS[4], CORPUS[12], CORPUS[13]];
    for (const m of modes)
      for (const fit of FITS) {
        const o = { ...IC.DEFAULT_CONVERT, ...m, fit, title: "t", brightness: 10, contrast: 5 };
        const pn = IC.convertToProject(imgs, o);
        const po = ctx.OLD_INT.convertToProject(imgs, o);
        if (pn.colorTable.join() !== po.colorTable.join()) bad.push(`変換一式 ${JSON.stringify(m)} ${fit}: colorTable`);
        else
          for (let f = 0; f < po.frames.length; f++)
            if (!sameBytes(pn.frames[f].layers.L1, po.frames[f].layers.L1)) {
              bad.push(`変換一式 ${JSON.stringify(m)} ${fit}: コマ ${f} の画素`);
              break;
            }
      }
  }
  // この回の前の blob そのもの: 量子化・ディザ・トーン・線画の関数（同じ入力 → 同じ出力＝触っていない）
  if (ctx.OLD) {
    const cv = IC.prepareCanvas(CORPUS[3], { ...IC.DEFAULT_CONVERT });
    const pal = IC.medianCut([cv], 24);
    if (JSON.stringify(pal) !== JSON.stringify(ctx.OLD.medianCut([cv], 24))) bad.push("medianCut が前と違う");
    for (const d of ["fs", "ordered", "none"])
      if (!sameBytes(IC.quantizeFrame(cv, pal, d), ctx.OLD.quantizeFrame(cv, pal, d))) bad.push(`quantizeFrame(${d}) が前と違う`);
    const g = IC.toGray(cv);
    for (const d of ["fs", "ordered"])
      if (JSON.stringify(IC.toneBinarize(g, 45, 60, d, false)) !== JSON.stringify(ctx.OLD.toneBinarize(g, 45, 60, d, false)))
        bad.push(`toneBinarize(${d}) が前と違う`);
    if (JSON.stringify(IC.lineartBinarize(g, 60, true)) !== JSON.stringify(ctx.OLD.lineartBinarize(g, 60, true)))
      bad.push("lineartBinarize が前と違う");
  }
  // ★V182: 倍率 >1 は V182 の前（blob b3a0775）とバイト一致（出力・変換一式）
  if (ctx.PRE182) {
    for (const img of CORPUS.slice(0, NAMED.length))
      for (const fit of FITS)
        for (const z of [1.25, 2, 3.5, 8])
          for (const c of [undefined, { x: 0.2, y: 0.9 }]) {
            const a = IC.resizeToCanvas(img, fit, z, c) as Img;
            const b = ctx.PRE182.resizeToCanvas(img, fit, z, c) as Img;
            if (!sameBytes(a.data, b.data)) bad.push(`倍率 ${z} ${img.w}×${img.h} ${fit}: V182 の前と違う（${firstDiff(a.data, b.data)}）`);
          }
    for (const m of [{ mode: "color" }, { mode: "tone", threshold: 40, ditherAmt: 70 }]) {
      const o = { ...IC.DEFAULT_CONVERT, ...m, title: "t", zoom: 2, center: { x: 0.3, y: 0.6 } };
      const imgs = [CORPUS[0], CORPUS[3], CORPUS[12]];
      const pn = IC.convertToProject(imgs, o);
      const pp = ctx.PRE182.convertToProject(imgs, o);
      if (pn.colorTable.join() !== pp.colorTable.join() || pn.frames.some((f: Mod, i: number) => !sameBytes(f.layers.L1, pp.frames[i].layers.L1)))
        bad.push(`倍率 2 の変換一式 ${JSON.stringify(m)}: V182 の前と違う`);
    }
  }
  return bad;
};

// ---------------- [S-2] zoom=2・中央 → 中央 1/2 が枠いっぱい ----------------
const S2: Check = (IC) => {
  const bad: string[] = [];
  // (a) 640×480（出発点 0.5 倍）→ 2 倍で 1:1。出力 (x, y) は元の (x+160, y+120)＝中央 1/2
  const c = coordImg(640, 480);
  for (const fit of FITS) {
    const o = IC.resizeToCanvas(c, fit, 2) as Img;
    let n = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (o.data[i + 3] !== 255 || decodeX(o.data, i) !== x + 160 || decodeY(o.data, i) !== y + 120) n++;
      }
    if (n) bad.push(`640×480 ${fit} zoom=2: 中央 1/2 と違う画素 ${n}`);
  }
  // (b) 1280×960（出発点 0.25 倍）→ 2 倍で 0.5 倍＝出力 1 画素は元の 2×2 の平均（小数は切り捨て）
  const r = randImg(1280, 960, 42);
  const o = IC.resizeToCanvas(r, "cover", 2) as Img;
  let nb = 0;
  for (let y = 0; y < H && nb < 5; y++)
    for (let x = 0; x < W; x++) {
      const sx = 2 * x + 320;
      const sy = 2 * y + 240;
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (const [ax, ay] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ])
          s += r.data[((sy + ay) * 1280 + sx + ax) * 4 + k];
        if (o.data[(y * W + x) * 4 + k] !== Math.trunc(s / 4)) nb++;
      }
    }
  if (nb) bad.push(`1280×960 zoom=2: 2×2 の平均と違う画素がある`);
  // (c) 960×480（2:1・画面いっぱいの出発点 0.5 倍）→ 2 倍で 1:1。見えるのは元の (x+320, y+120)
  const c2 = coordImg(960, 480);
  const o2 = IC.resizeToCanvas(c2, "cover", 2) as Img;
  let n2 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (decodeX(o2.data, i) !== x + 320 || decodeY(o2.data, i) !== y + 120) n2++;
    }
  if (n2) bad.push(`960×480 cover zoom=2: 中央 1/2 と違う画素 ${n2}`);
  // (d) なめらかな傾きで、倍率 1 と 2 の見える範囲を比べる（2 倍は 1 倍の真ん中の半分）
  const rp = rampImg(900, 500);
  for (const fit of FITS) {
    const o1 = IC.resizeToCanvas(rp, fit) as Img;
    const oz = IC.resizeToCanvas(rp, fit, 2) as Img;
    // 横: 2 倍の左端 = 1 倍の 1/4 の位置・右端 = 3/4 の位置（見えている絵の範囲で比べる）
    const span = (img: Img, y: number) => {
      let lo = 999,
        hi = -1;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (img.data[i + 3] !== 255) continue;
        lo = Math.min(lo, img.data[i]);
        hi = Math.max(hi, img.data[i]);
      }
      return [lo, hi];
    };
    const [l1, h1] = span(o1, 120);
    const [lz, hz] = span(oz, 120);
    const q1 = l1 + (h1 - l1) / 4;
    const q3 = l1 + ((h1 - l1) * 3) / 4;
    if (fit === "cover" && (Math.abs(lz - q1) > 3 || Math.abs(hz - q3) > 3))
      bad.push(`900×500 cover zoom=2: 横の範囲 ${lz}〜${hz}（1 倍の真ん中の半分 ${q1.toFixed(0)}〜${q3.toFixed(0)} のはず）`);
    if (fit === "contain") {
      // contain（出発点で横がぴったり）: 2 倍の横の範囲は 1 倍の真ん中の半分
      if (Math.abs(lz - q1) > 3 || Math.abs(hz - q3) > 3)
        bad.push(`900×500 contain zoom=2: 横の範囲 ${lz}〜${hz}（${q1.toFixed(0)}〜${q3.toFixed(0)} のはず）`);
    }
  }
  return bad;
};

// ---------------- [S-3] 端でも隙間なし ----------------
const S3: Check = (IC) => {
  const bad: string[] = [];
  const c = coordImg(640, 480);
  // 2 倍＝1:1。center の端は元画像の端がそのまま枠の端に来る
  const want: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [1, 1, 320, 240],
    [0, 1, 0, 240],
    [1, 0, 320, 0],
    [-3, 9, 0, 240], // 範囲外も端に収まる
    [0.5, 0.5, 160, 120],
  ];
  for (const [cx, cy, ox, oy] of want) {
    const o = IC.resizeToCanvas(c, "cover", 2, { x: cx, y: cy }) as Img;
    let n = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (o.data[i + 3] !== 255 || decodeX(o.data, i) !== x + ox || decodeY(o.data, i) !== y + oy) n++;
      }
    if (n) bad.push(`640×480 zoom=2 center(${cx},${cy}): 元の (${ox},${oy}) からの 1:1 と違う画素 ${n}`);
  }
  // いろいろな大きさ・倍率・端で、画面いっぱいは 1 画素も透けない
  const sizes: [number, number][] = [
    [500, 300],
    [300, 500],
    [333, 211],
    [97, 61],
    [1280, 720],
    [700, 70],
  ];
  const edges: [number, number][] = [
    [0, 0],
    [1, 1],
    [0, 1],
    [1, 0],
    [-1, 2],
    [0.5, 0],
    [NaN, 1],
  ];
  for (const [w, h] of sizes) {
    const img = randImg(w, h, w * 7 + h);
    for (const z of [1, 1.5, 3, 8])
      for (const [cx, cy] of edges) {
        const o = IC.resizeToCanvas(img, "cover", z, { x: cx, y: cy }) as Img;
        let gap = 0;
        for (let i = 3; i < o.data.length; i += 4) if (o.data[i] !== 255) gap++;
        if (gap) bad.push(`${w}×${h} cover zoom=${z} center(${cx},${cy}): 隙間 ${gap} 画素`);
      }
  }
  // 全体を入れる・横だけはみ出す（640×240 を 1.5 倍＝横 480・縦 180）: 横の端でも横に隙間なし
  const c2 = coordImg(640, 240);
  for (const cx of [0, 1]) {
    const o = IC.resizeToCanvas(c2, "contain", 1.5, { x: cx, y: 0.5 }) as Img;
    let n = 0;
    for (let y = 30; y < 210; y++)
      for (let x = 0; x < W; x++) if (o.data[(y * W + x) * 4 + 3] !== 255) n++;
    if (n) bad.push(`640×240 contain zoom=1.5 center.x=${cx}: 横に隙間 ${n} 画素`);
    // 左端・右端の列に元画像の端が来ている（縮小なので面積平均＝左端は元の 0〜1 列目・右端は 638〜639 列目）
    const xl = o.data[(120 * W + 0) * 4 + 3] === 255 ? decodeX(o.data, (120 * W + 0) * 4) : -1;
    const xr = o.data[(120 * W + 319) * 4 + 3] === 255 ? decodeX(o.data, (120 * W + 319) * 4) : -1;
    if (cx === 0 && xl > 1) bad.push(`640×240 contain zoom=1.5 center.x=0: 左端の列が元の x≈${xl}（0 付近のはず）`);
    if (cx === 1 && xr < 638) bad.push(`640×240 contain zoom=1.5 center.x=1: 右端の列が元の x≈${xr}（639 付近のはず）`);
  }
  return bad;
};

// ---------------- [S-4] 枠より小さい軸は中央に固定 ----------------
const S4: Check = (IC) => {
  const bad: string[] = [];
  const sizes: [number, number][] = [
    [500, 300],
    [300, 500],
    [333, 211],
    [97, 61],
    [1, 1],
    [640, 480],
  ];
  const centers: [number, number][] = [
    [0, 0],
    [1, 1],
    [0.2, 0.9],
    [NaN, 5],
    [-4, 0.3],
  ];
  for (const [w, h] of sizes) {
    const img = randImg(w, h, w + h * 3);
    const base = IC.resizeToCanvas(img, "contain") as Img;
    for (const z of [undefined, 1])
      for (const [cx, cy] of centers) {
        const o = IC.resizeToCanvas(img, "contain", z, { x: cx, y: cy }) as Img;
        if (!sameBytes(o.data, base.data)) bad.push(`${w}×${h} contain zoom=${z} center(${cx},${cy}) で絵が動いた`);
      }
  }
  // 4:3 の画面いっぱい（ぴったり＝どちらの軸もはみ出さない）も動かない
  const img43 = randImg(400, 300, 43);
  const b43 = IC.resizeToCanvas(img43, "cover") as Img;
  for (const [cx, cy] of centers) {
    const o = IC.resizeToCanvas(img43, "cover", 1, { x: cx, y: cy }) as Img;
    if (!sameBytes(o.data, b43.data)) bad.push(`400×300 cover zoom=1 center(${cx},${cy}) で絵が動いた`);
  }
  // 横だけはみ出す（640×240 contain ×1.5）: 縦（枠より小さい）は center.y を変えても動かず、横は動く
  const c2 = coordImg(640, 240);
  const mid = IC.resizeToCanvas(c2, "contain", 1.5, { x: 0.5, y: 0.5 }) as Img;
  for (const cy of [0, 1, 0.2, -3]) {
    const o = IC.resizeToCanvas(c2, "contain", 1.5, { x: 0.5, y: cy }) as Img;
    if (!sameBytes(o.data, mid.data)) bad.push(`640×240 contain zoom=1.5: center.y=${cy} で縦に動いた（枠より小さい軸）`);
  }
  // 縦の置き場所はいまどおり中央（(240 − 180) / 2 = 30 行目から）
  let top = -1;
  for (let y = 0; y < H && top < 0; y++) if (mid.data[(y * W + 160) * 4 + 3] === 255) top = y;
  if (top !== 30) bad.push(`640×240 contain zoom=1.5: 絵の上端が ${top} 行目（30 のはず）`);
  const moved = IC.resizeToCanvas(c2, "contain", 1.5, { x: 0.1, y: 0.5 }) as Img;
  if (sameBytes(moved.data, mid.data)) bad.push("640×240 contain zoom=1.5: center.x を変えても横に動かない（検査が空振り）");
  return bad;
};

// ---------------- [S-5] 大きさが違っても同じ構図 ----------------
const S5: Check = (IC) => {
  const bad: string[] = [];
  const { img: A, where } = distinctImg(160, 120, 5);
  const B2 = upscale(A, 2); // 320×240
  const B3 = upscale(A, 3); // 480×360
  const combos: [number, number, number, Img[]][] = [
    [2, 0.3, 0.6, [B2, B3]],
    [3, 0.8, 0.2, [B2, B3]],
    [1.5, 0.5, 0.5, [B2, B3]],
    [4, 0, 1, [B2, B3]],
    [1.25, 0.7, 0.4, [B2]], // B3 は 1.25 倍だと縮小になる（面積平均）ので 2 倍の写しだけ
    [8, 0.45, 0.55, [B2, B3]],
  ];
  for (const fit of FITS)
    for (const [z, cx, cy, others] of combos) {
      const oa = IC.resizeToCanvas(A, fit, z, { x: cx, y: cy }) as Img;
      const def = IC.resizeToCanvas(A, fit) as Img;
      if (sameBytes(oa.data, def.data)) bad.push(`${fit} zoom=${z} center(${cx},${cy}): 既定と同じ絵（検査が空振り）`);
      for (const B of others) {
        const ob = IC.resizeToCanvas(B, fit, z, { x: cx, y: cy }) as Img;
        if (!sameBytes(oa.data, ob.data))
          bad.push(`${fit} zoom=${z} center(${cx},${cy}): 160×120 と ${B.w}×${B.h} で構図が違う（${firstDiff(oa.data, ob.data)}）`);
      }
      // 枠の真ん中に来ているのは、元画像の (cx, cy) の割合の点（端で止まらない組み合わせだけ）
      const s0 = fit === "cover" ? Math.max(W / 160, H / 120) : Math.min(W / 160, H / 120);
      const dw = 160 * s0 * z;
      const dh = 120 * s0 * z;
      const mx = W / (2 * dw);
      const my = H / (2 * dh);
      if (cx >= mx && cx <= 1 - mx && cy >= my && cy <= 1 - my) {
        const i = (120 * W + 160) * 4;
        const col = (oa.data[i] << 16) | (oa.data[i + 1] << 8) | oa.data[i + 2];
        const at = where.get(col);
        if (at === undefined) bad.push(`${fit} zoom=${z}: 枠の真ん中の色が元画像に無い`);
        else {
          const sx = at % 160;
          const sy = Math.floor(at / 160);
          if (Math.abs(sx + 0.5 - cx * 160) > 1.01 || Math.abs(sy + 0.5 - cy * 120) > 1.01)
            bad.push(`${fit} zoom=${z} center(${cx},${cy}): 枠の真ん中が元の (${sx},${sy})（(${(cx * 160).toFixed(1)},${(cy * 120).toFixed(1)}) 付近のはず）`);
        }
      }
    }
  // 連番（変換一式）: 大きさの違う 2 枚が同じ位置・倍率で同じコマになる
  const o = { ...IC.DEFAULT_CONVERT, title: "t", zoom: 2, center: { x: 0.3, y: 0.6 } };
  const p = IC.convertToProject([A, B2, B3], o);
  if (!sameBytes(p.frames[0].layers.L1, p.frames[1].layers.L1) || !sameBytes(p.frames[0].layers.L1, p.frames[2].layers.L1))
    bad.push("連番の変換: 大きさの違うページで構図が違う");
  const pd = IC.convertToProject([A], { ...IC.DEFAULT_CONVERT, title: "t" });
  if (sameBytes(p.frames[0].layers.L1, pd.frames[0].layers.L1)) bad.push("連番の変換: zoom・center が効いていない（既定と同じ）");
  // 縮小の側（面積平均）でも、なめらかな絵なら大きさ違いで同じ構図（差は丸めのぶんだけ）
  const R1 = rampImg(800, 600);
  const R2 = rampImg(1600, 1200);
  for (const fit of FITS)
    for (const [z, cx, cy] of [
      [1.5, 0.3, 0.7],
      [2.5, 0.75, 0.25],
    ]) {
      const o1 = IC.resizeToCanvas(R1, fit, z, { x: cx, y: cy }) as Img;
      const o2 = IC.resizeToCanvas(R2, fit, z, { x: cx, y: cy }) as Img;
      let sum = 0,
        mx = 0;
      for (let i = 0; i < o1.data.length; i++) {
        if ((i & 3) === 3) continue;
        const d = Math.abs(o1.data[i] - o2.data[i]);
        sum += d;
        mx = Math.max(mx, d);
      }
      const mean = sum / (W * H * 3);
      if (mean > 1 || mx > 4) bad.push(`傾き 800×600 と 1600×1200 ${fit} zoom=${z}: 差の平均 ${mean.toFixed(2)}・最大 ${mx}`);
    }
  return bad;
};

// ---------------- [S-6] 拡大はにじまない ----------------
const S6: Check = (IC) => {
  const bad: string[] = [];
  const cases: [number, number][] = [
    [97, 61],
    [400, 300], // 出発点 0.8 倍 → 4 倍で 3.2（整数でない拡大）
    [320, 240],
    [150, 250],
  ];
  for (const [w, h] of cases) {
    const { img, where } = distinctImg(w, h, w * 31 + h);
    for (const fit of FITS)
      for (const z of [4, 2.5, 8])
        for (const [cx, cy] of [
          [0.5, 0.5],
          [0.2, 0.8],
          [1, 0],
        ]) {
          const o = IC.resizeToCanvas(img, fit, z, { x: cx, y: cy }) as Img;
          let mixed = 0;
          for (let i = 0; i < o.data.length; i += 4) {
            if (o.data[i + 3] !== 255) continue; // 余白（紙）は見ない
            const col = (o.data[i] << 16) | (o.data[i + 1] << 8) | o.data[i + 2];
            if (!where.has(col)) mixed++;
          }
          if (mixed) bad.push(`${w}×${h} ${fit} zoom=${z} center(${cx},${cy}): 元画像に無い色（混ざった画素）${mixed}`);
        }
  }
  return bad;
};

// ---------------- [S-7] zoom は 1〜8 に収まる ----------------
const S7: Check = (IC) => {
  const bad: string[] = [];
  const img = randImg(400, 300, 7);
  for (const fit of FITS) {
    const z1 = IC.resizeToCanvas(img, fit) as Img;
    const z8 = IC.resizeToCanvas(img, fit, 8) as Img;
    const z7 = IC.resizeToCanvas(img, fit, 7) as Img;
    if (sameBytes(z8.data, z1.data) || sameBytes(z8.data, z7.data)) bad.push(`${fit}: 8 倍が 1 倍・7 倍と区別できない（検査が空振り）`);
    for (const z of [0, -5, 0.5, 0.999, NaN, -Infinity]) {
      const o = IC.resizeToCanvas(img, fit, z) as Img;
      if (!sameBytes(o.data, z1.data)) bad.push(`${fit} zoom=${z}: 1 倍に収まっていない`);
    }
    for (const z of [100, 8.5, 1e9, Infinity]) {
      const o = IC.resizeToCanvas(img, fit, z) as Img;
      if (!sameBytes(o.data, z8.data)) bad.push(`${fit} zoom=${z}: 8 倍に収まっていない`);
    }
    // 置き場所の大きさも収まっている（素の絵もこの大きさで描く）
    const p0 = IC.canvasPlacement(400, 300, fit, 0);
    const p100 = IC.canvasPlacement(400, 300, fit, 100);
    const pd = IC.canvasPlacement(400, 300, fit);
    const p8 = IC.canvasPlacement(400, 300, fit, 8);
    if (p0.dw !== pd.dw || p100.dw !== p8.dw) bad.push(`${fit}: canvasPlacement の倍率が 1〜8 に収まっていない`);
  }
  // 段の一覧: 最初が 1（スライダーの既定＝いままでと同じ絵）・最後が 8・昇順・どれも 1〜8
  const st = IC.CROP_ZOOM_STEPS as number[];
  if (!Array.isArray(st) || st[0] !== 1 || st[st.length - 1] !== 8) bad.push(`段の一覧の両端が 1・8 でない: ${st}`);
  else for (let i = 1; i < st.length; i++) if (!(st[i] > st[i - 1])) bad.push(`段の一覧が昇順でない: ${st}`);
  return bad;
};

// ---------------- [S-8] 素の絵の置き場所 = 変換の置き場所 ----------------
const S8: Check = (IC) => {
  const bad: string[] = [];
  const sizes: [number, number][] = [
    [500, 300],
    [300, 500],
    [333, 211],
    [97, 61],
    [1280, 720],
    [640, 240],
    [7, 1],
  ];
  const r = rng(8);
  for (const [w, h] of sizes) {
    const img = coordImg(w, h);
    for (const fit of FITS)
      for (let k = 0; k < 6; k++) {
        const z = k === 0 ? undefined : (IC.CROP_ZOOM_STEPS as number[])[Math.floor(r() * 13)];
        const cen = k === 0 ? undefined : { x: r() * 1.4 - 0.2, y: r() * 1.4 - 0.2 };
        const P = IC.canvasPlacement(w, h, fit, z, cen);
        const o = IC.resizeToCanvas(img, fit, z, cen) as Img;
        const x0 = Math.max(0, P.dx0);
        const x1 = Math.min(W, P.dx0 + P.dw);
        const y0 = Math.max(0, P.dy0);
        const y1 = Math.min(H, P.dy0 + P.dh);
        let n = 0;
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
            if ((o.data[(y * W + x) * 4 + 3] === 255) !== inside) n++;
          }
        if (n) bad.push(`${w}×${h} ${fit} zoom=${z}: 絵のある範囲が置き場所と ${n} 画素食い違う`);
        if (P.movableX !== P.dw > W || P.movableY !== P.dh > H) bad.push(`${w}×${h} ${fit} zoom=${z}: 動かせる軸の判定が大きさと食い違う`);
        // 拡大（最近傍）のときは、各画素が「素の絵を最近傍で描いたときに画素の中心へ来る元の画素」そのもの
        if ((z ?? 1) > 1 && P.dw > w && P.dh > h) {
          let m = 0;
          for (let y = y0; y < y1; y += 7)
            for (let x = x0; x < x1; x += 5) {
              const i = (y * W + x) * 4;
              // 画素の中心 (x + 0.5) に乗る元の画素（整数の割り算＝浮動小数の丸めを入れない）
              const ex = Math.floor(((2 * (x - P.dx0) + 1) * w) / (2 * P.dw));
              const ey = Math.floor(((2 * (y - P.dy0) + 1) * h) / (2 * P.dh));
              if (decodeX(o.data, i) !== ex || decodeY(o.data, i) !== ey) m++;
            }
          if (m) bad.push(`${w}×${h} ${fit} zoom=${z}: 最近傍の画素が素の絵の位置と ${m} 点食い違う`);
        }
      }
  }
  return bad;
};

// ---------------- [S-9] ドラッグ・ホイールの計算 ----------------
const S9: Check = (IC) => {
  const bad: string[] = [];
  const place = (w: number, h: number, fit: Fit, z: number, c: { x: number; y: number }) => IC.canvasPlacement(w, h, fit, z, c);
  // (a) 横長 1280×720 を画面いっぱい（横にはみ出す）: 右へ 10 画素ドラッグ → 絵が右へ 10 画素（±1）
  let c = { x: 0.5, y: 0.5 };
  const p0 = place(1280, 720, "cover", 1, c);
  c = IC.panCropCenter(1280, 720, "cover", 1, c, 10, 0);
  const p1 = place(1280, 720, "cover", 1, c);
  if (Math.abs(p1.dx0 - p0.dx0 - 10) > 1) bad.push(`右へ 10 画素ドラッグで絵が ${p1.dx0 - p0.dx0} 画素動いた（10 のはず）`);
  if (p1.dy0 !== p0.dy0) bad.push("横へのドラッグで縦に動いた");
  // (b) ずっと右へ → 絵の左端が枠の左端で止まる（端より先へは動かない）
  for (let i = 0; i < 100; i++) c = IC.panCropCenter(1280, 720, "cover", 1, c, 10, 0);
  const pe = place(1280, 720, "cover", 1, c);
  if (pe.dx0 !== 0) bad.push(`右へ動かし続けたら左端が ${pe.dx0}（0 で止まるはず）`);
  // (b') 持っている center は**いま見えている位置そのもの**（端の先の値をため込まない）。
  //      center は全ページに同じ割合で効く（決-3）ので、見えていない「端の先」を持つとほかのページの構図がずれる
  if (Math.abs(c.x - W / (2 * pe.dw)) > 1e-9) bad.push(`端で止まったのに center.x が ${c.x}（見えている位置 ${W / (2 * pe.dw)} のはず）`);
  // (c) 端から戻す → すぐ動く（行き過ぎた分をため込まない）
  const cb = IC.panCropCenter(1280, 720, "cover", 1, c, -10, 0);
  const pb = place(1280, 720, "cover", 1, cb);
  if (Math.abs(pb.dx0 - -10) > 1) bad.push(`端から左へ 10 画素戻したら ${pb.dx0}（-10 のはず・行き過ぎをため込んでいる）`);
  // (d) ずっと左へ → 右端で止まる
  for (let i = 0; i < 100; i++) c = IC.panCropCenter(1280, 720, "cover", 1, c, -10, 0);
  const pl = place(1280, 720, "cover", 1, c);
  if (pl.dx0 !== W - pl.dw) bad.push(`左へ動かし続けたら左端が ${pl.dx0}（${W - pl.dw} で止まるはず）`);
  // (e) 動かせない軸（縦・ぴったり）は center を変えない
  if (c.y !== 0.5) bad.push(`動かせない縦の center が ${c.y} に変わった`);
  const cf = IC.panCropCenter(1280, 720, "cover", 1, { x: 0.5, y: 0.5 }, 0, 25);
  if (cf.y !== 0.5 || cf.x !== 0.5) bad.push(`動かせない軸へのドラッグで center が (${cf.x},${cf.y}) に変わった`);
  // (f) 全体を入れる・倍率 1（どちらの軸も動かせない）→ 何も変わらない
  const cc = IC.panCropCenter(640, 240, "contain", 1, { x: 0.5, y: 0.5 }, 40, -40);
  if (cc.x !== 0.5 || cc.y !== 0.5) bad.push(`contain・倍率 1 でドラッグして center が (${cc.x},${cc.y}) に変わった`);
  // (g) 拡大してから縦にも動かせる（2 倍の 4:3）: 下へ 7 画素 → 絵が下へ 7（±1）
  let c4 = { x: 0.5, y: 0.5 };
  const q0 = place(800, 600, "cover", 2, c4);
  c4 = IC.panCropCenter(800, 600, "cover", 2, c4, 0, 7);
  const q1 = place(800, 600, "cover", 2, c4);
  if (Math.abs(q1.dy0 - q0.dy0 - 7) > 1) bad.push(`2 倍で下へ 7 画素ドラッグで絵が ${q1.dy0 - q0.dy0} 画素動いた`);
  // (h) ホイール: カーソルの下の元画像の点が動かない（±1.5 画素）
  const anchors: [number, number][] = [
    [40, 30],
    [300, 200],
    [160, 120],
    [10, 230],
  ];
  for (const [ax, ay] of anchors)
    for (const [zf, zt] of [
      [1, 2],
      [2, 4],
      [4, 3],
      [1.5, 8],
    ]) {
      const w = 1000;
      const h = 700;
      const cen = { x: 0.52, y: 0.47 };
      const a = place(w, h, "cover", zf, cen);
      const u = (ax - a.dx0) / a.dw;
      const v = (ay - a.dy0) / a.dh;
      const cn = IC.zoomCropCenter(w, h, "cover", zf, zt, cen, { x: ax, y: ay });
      const b = place(w, h, "cover", zt, cn);
      // 端で止まった軸は見ない（端より先へは動かないほうが優先）
      const atEdgeX = b.dx0 === 0 || b.dx0 === W - b.dw;
      const atEdgeY = b.dy0 === 0 || b.dy0 === H - b.dh;
      const ex = b.dx0 + u * b.dw;
      const ey = b.dy0 + v * b.dh;
      if (!atEdgeX && Math.abs(ex - ax) > 1.5) bad.push(`ホイール ${zf}→${zt} @(${ax},${ay}): カーソルの下の点が横に ${(ex - ax).toFixed(2)} 画素ずれた`);
      if (!atEdgeY && Math.abs(ey - ay) > 1.5) bad.push(`ホイール ${zf}→${zt} @(${ax},${ay}): カーソルの下の点が縦に ${(ey - ay).toFixed(2)} 画素ずれた`);
    }
  // (i) 真ん中を錨にした倍率の変更（スライダー）は center を変えない（収まる範囲なら）
  const cs = IC.zoomCropCenter(1000, 700, "cover", 1, 3, { x: 0.4, y: 0.6 });
  if (Math.abs(cs.x - 0.4) > 1e-12 || Math.abs(cs.y - 0.6) > 1e-12) bad.push(`スライダーの倍率変更で center が (${cs.x},${cs.y}) に変わった`);
  // (j) 倍率を下げて範囲が狭まったら、端で止まる位置へ収め直す（はみ出した center を持ち越さない）
  const edge = IC.panCropCenter(1000, 700, "cover", 4, { x: 0.5, y: 0.5 }, 5000, 5000);
  const back = IC.zoomCropCenter(1000, 700, "cover", 4, 2, edge);
  const pb2 = place(1000, 700, "cover", 2, back);
  const moveBack = IC.panCropCenter(1000, 700, "cover", 2, back, -10, 0);
  const pm = place(1000, 700, "cover", 2, moveBack);
  if (pb2.dx0 !== 0) bad.push(`4 倍で左上へ寄せて 2 倍へ戻したら左端が ${pb2.dx0}（0 のはず）`);
  if (Math.abs(pm.dx0 - -10) > 1) bad.push(`2 倍へ戻したあと左へ 10 画素で ${pm.dx0}（-10 のはず・はみ出した center を持ち越している）`);
  return bad;
};

// ---------------- [S-10] ★ダイアログの操作（本物の createCropController / bindCropCanvas / cropSliderHandlers） ----------------
// 偽の canvas（出来事の受け口を記録）・偽のタイマー（手で進める）・偽の window で、ダイアログと同じ口に出来事を流す。
// 見るのは「変換（convert）が何回・いつ呼ばれたか」「素の縮小画（drawRaw）」「既定の動きを止めたか（preventDefault）」
interface Harness {
  o: Mod;
  ctl: Mod;
  n: { raw: number; convert: number; sync: number };
  timers: { id: number; fn: () => void; ms: number }[];
  fire: (type: string, props?: Record<string, number>) => boolean;
  tick: () => number | null;
  captured: number[];
  grabbing: () => boolean;
  win: { fire: (t: string) => void; count: () => number; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
}
function harness(IC: Mod, imgW = 1600, imgH = 900): Harness {
  const o = { ...IC.DEFAULT_CONVERT, title: "t" };
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let tid = 0;
  const n = { raw: 0, convert: 0, sync: 0 };
  const ctl = IC.createCropController(o, {
    image: () => ({ w: imgW, h: imgH }),
    drawRaw: () => n.raw++,
    convert: () => n.convert++,
    sync: () => n.sync++,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++tid;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const handlers: Record<string, (e: Record<string, unknown>) => void> = {};
  const captured: number[] = [];
  let grabbing = false;
  IC.bindCropCanvas(
    {
      onPointer: (type: string, fn: (e: Record<string, unknown>) => void) => {
        handlers[type] = fn;
      },
      onWheel: (fn: (e: Record<string, unknown>) => void) => {
        handlers.wheel = fn;
      },
      capture: (id: number) => captured.push(id),
      toCanvas: (x: number, y: number) => ({ x: x / 2, y: y / 2 }), // 2 倍表示の偽物
      grabbing: (on: boolean) => {
        grabbing = on;
      },
    },
    ctl
  );
  const fire = (type: string, props: Record<string, number> = {}) => {
    let prevented = false;
    const e = { pointerId: 1, button: 0, buttons: 1, clientX: 320, clientY: 240, deltaY: 0, deltaMode: 0, ...props, preventDefault: () => (prevented = true) };
    const h = handlers[type];
    if (!h) throw new Error(`${type} の受け口が付いていない`);
    h(e);
    return prevented;
  };
  const tick = () => {
    const t = timers.shift();
    if (!t) return null;
    t.fn();
    return t.ms;
  };
  const wl: Record<string, (() => void)[]> = {};
  const win = {
    addEventListener: (t: string, f: () => void) => {
      (wl[t] ??= []).push(f);
    },
    removeEventListener: (t: string, f: () => void) => {
      wl[t] = (wl[t] ?? []).filter((g) => g !== f);
    },
    fire: (t: string) => [...(wl[t] ?? [])].forEach((f) => f()),
    count: () => Object.values(wl).reduce((a, b) => a + b.length, 0),
  };
  return { o, ctl, n, timers, fire, tick, captured, grabbing: () => grabbing, win };
}
const S10: Check = (IC) => {
  const bad: string[] = [];
  // (a) ★ドラッグ: 押す → 動かす（途中で予約していた変換の時刻が来ても）→ 離す
  {
    const h = harness(IC);
    h.ctl.gate.schedule(); // ドラッグの前に予約された変換（明るさを変えた直後など）
    const pd = h.fire("pointerdown", { clientX: 640, clientY: 480 });
    if (!pd) bad.push("押したとき既定の動きを止めていない（文字選択・スクロールが走る）");
    if (h.captured[0] !== 1) bad.push("押したポインタを捕捉していない（キャンバスの外へ出るとドラッグが切れる）");
    if (!h.grabbing()) bad.push("掴んでいる間のカーソルになっていない");
    h.tick(); // 予約の時刻が来た（ドラッグ中）
    for (let i = 1; i <= 6; i++) h.fire("pointermove", { clientX: 640 - 40 * i, clientY: 480 });
    if (h.n.convert !== 0) bad.push(`★ドラッグ中に変換が ${h.n.convert} 回走った（0 のはず）`);
    if (h.n.raw < 1) bad.push("ドラッグ中に素の縮小画を描いていない");
    const p = h.ctl.placement();
    if (p.dx0 === Math.floor((W - p.dw) / 2)) bad.push("ドラッグしても絵が動いていない");
    if (h.timers.length !== 0) bad.push(`ドラッグ中に変換の予約が残っている（${h.timers.length}）`);
    h.fire("pointerup", { clientX: 400, clientY: 480, buttons: 0 });
    if (h.grabbing()) bad.push("離したのに掴んだカーソルのまま");
    if (h.timers.length !== 1 || h.timers[0].ms !== 100) bad.push(`離したあとの予約が ${h.timers.map((t) => t.ms).join(",") || "なし"}（100ms が 1 つのはず）`);
    h.tick();
    if (h.n.convert !== 1) bad.push(`離したあとの変換が ${h.n.convert} 回（1 回のはず）`);
  }
  // (a2) ★受け口を通した移動の量と向き: 右へ 5 画素ずつ 3 回 → 絵も右へ 15 画素（±1）。左へ戻すと元の位置（±1）。
  //      前の位置との差だけ動く（押した所からの差を毎回足すと、指より大きく動く）
  {
    const h = harness(IC);
    const x0 = h.ctl.placement().dx0;
    h.fire("pointerdown", { clientX: 640, clientY: 480 });
    for (const cx of [650, 660, 670]) h.fire("pointermove", { clientX: cx, clientY: 480 }); // 偽物は 2 倍表示＝枠の 5 画素ずつ
    const x1 = h.ctl.placement().dx0;
    if (Math.abs(x1 - x0 - 15) > 1) bad.push(`★右へ 15 画素ドラッグで絵が ${x1 - x0} 画素動いた（+15 のはず・向きか量が違う）`);
    for (const cx of [660, 650, 640]) h.fire("pointermove", { clientX: cx, clientY: 480 });
    const x2 = h.ctl.placement().dx0;
    if (Math.abs(x2 - x0) > 1) bad.push(`元の位置までドラッグで戻したのに絵が ${x2 - x0} 画素ずれている（0 のはず）`);
    h.fire("pointerup", { clientX: 640, clientY: 480, buttons: 0 });
  }
  // (b) 動かさずに離す（クリックだけ）: 変換しない（絵は変わっていない）
  {
    const h = harness(IC);
    h.fire("pointerdown");
    h.fire("pointerup", { buttons: 0 });
    if (h.timers.length || h.n.convert) bad.push("動かさずに離しただけで変換した");
  }
  // (c) ★ホイール: プレビューの上では既定の動き（ダイアログのスクロール）を止め、1 ノッチ＝1 段・250ms 後に変換
  {
    const h = harness(IC);
    const s0 = h.n.sync;
    const pv = h.fire("wheel", { deltaY: -100, clientX: 320, clientY: 240 });
    if (!pv) bad.push("★ホイールで既定の動きを止めていない（プレビューの上でダイアログもスクロールする）");
    if (h.n.sync !== s0 + 1) bad.push(`ホイールで倍率を変えたのに表示を合わせない（sync ${h.n.sync - s0} 回・1 回のはず）＝倍率の表示・スライダー・カーソルが古いまま`);
    if (h.ctl.zoomIndex() !== 1) bad.push(`ホイール 1 ノッチで段が ${h.ctl.zoomIndex()}（1 のはず）`);
    if (h.o.zoom !== 1.25) bad.push(`ホイール 1 ノッチの倍率が ${h.o.zoom}（1.25 のはず）`);
    if (h.n.raw !== 1 || h.n.convert !== 0) bad.push(`ホイール直後: 素の絵 ${h.n.raw}・変換 ${h.n.convert}（1・0 のはず）`);
    if (h.timers.length !== 1 || h.timers[0].ms !== 250) bad.push(`ホイールのあとの予約が ${h.timers.map((t) => t.ms).join(",") || "なし"}（250ms のはず）`);
    h.tick();
    if (h.n.convert !== 1) bad.push("ホイールのあと変換されない");
    h.fire("wheel", { deltaY: 100 });
    if (h.ctl.zoomIndex() !== 0) bad.push("手前へ回しても縮まない");
    // タッチパッド（少しずつ）: ためて 1 段。向きが変わったらためた分を捨てる
    h.fire("wheel", { deltaY: -30 });
    if (h.ctl.zoomIndex() !== 0) bad.push("30 だけで 1 段進んだ（ためていない）");
    h.fire("wheel", { deltaY: -30 });
    if (h.ctl.zoomIndex() !== 1) bad.push("30＋30 で 1 段進まない");
    h.fire("wheel", { deltaY: -30 });
    h.fire("wheel", { deltaY: 30 });
    h.fire("wheel", { deltaY: -30 });
    if (h.ctl.zoomIndex() !== 1) bad.push("向きが変わったのにためた分を持ち越した");
    // 行単位（deltaMode 1）の 1 ノッチ（3 行）も 1 段
    h.fire("wheel", { deltaY: -3, deltaMode: 1 });
    if (h.ctl.zoomIndex() !== 2) bad.push("行単位のホイール 1 ノッチで 1 段進まない");
    // ページ単位（deltaMode 2）の 1 ページも 1 段（1 ページ＝1 ノッチ）
    h.fire("wheel", { deltaY: -1, deltaMode: 2 });
    if (h.ctl.zoomIndex() !== 3) bad.push(`ページ単位のホイール 1 ページが 1 段にならない（段 ${h.ctl.zoomIndex()}・3 のはず）`);
    h.fire("wheel", { deltaY: 1, deltaMode: 2 });
    if (h.ctl.zoomIndex() !== 2) bad.push(`ページ単位のホイールで戻らない（段 ${h.ctl.zoomIndex()}・2 のはず）`);
    // まとめて届いた 3 ノッチ（-300 が 1 回）は 3 段（1 ノッチ＝1 段。回した分より進まない、を作らない）
    h.fire("wheel", { deltaY: -300 });
    if (h.ctl.zoomIndex() !== 5) bad.push(`まとめて届いた 3 ノッチ（-300）で段が ${h.ctl.zoomIndex()}（5 のはず）`);
    h.fire("wheel", { deltaY: 200 });
    if (h.ctl.zoomIndex() !== 3) bad.push(`まとめて届いた 2 ノッチ（+200）で段が ${h.ctl.zoomIndex()}（3 のはず）`);
    // 上限・下限で止まる
    for (let i = 0; i < 30; i++) h.fire("wheel", { deltaY: -100 });
    if (h.o.zoom !== 8) bad.push(`ホイールで上限の先へ行った（${h.o.zoom}）`);
  }
  // (d) ホイールで拡大するとき、カーソルの下の絵が動かない
  {
    const h = harness(IC, 1000, 700);
    const at = { clientX: 100, clientY: 80 }; // 枠の (50, 40)
    const a = h.ctl.placement();
    const u = (50 - a.dx0) / a.dw;
    const v = (40 - a.dy0) / a.dh;
    h.fire("wheel", { deltaY: -100, ...at });
    h.fire("wheel", { deltaY: -100, ...at });
    const b = h.ctl.placement();
    if (Math.abs(b.dx0 + u * b.dw - 50) > 1.5 || Math.abs(b.dy0 + v * b.dh - 40) > 1.5)
      bad.push(`ホイールでカーソルの下の点が (${(b.dx0 + u * b.dw).toFixed(1)}, ${(b.dy0 + v * b.dh).toFixed(1)}) へずれた（(50, 40) のはず）`);
  }
  // (e) 「離した」が届かない: ボタンの離れた move で終える／次に押せば取り直す（触ったまま止まらない）
  {
    const h = harness(IC);
    h.fire("pointerdown", { pointerId: 2 });
    h.fire("pointermove", { pointerId: 2, buttons: 0 });
    if (h.ctl.gate.dragging(2)) bad.push("ボタンが離れた move でドラッグが終わらない");
    h.ctl.gate.schedule();
    h.tick();
    if (h.n.convert !== 1) bad.push("ボタンが離れたあとも変換が止まったまま");
    const h2 = harness(IC);
    h2.fire("pointerdown", { pointerId: 3 }); // 離したが届かなかった
    h2.fire("pointerdown", { pointerId: 4 });
    if (!h2.ctl.gate.dragging(4) || h2.ctl.gate.dragging(3)) bad.push("次に押したポインタでドラッグを取り直さない");
    h2.fire("pointermove", { pointerId: 4, clientX: 200 });
    h2.fire("pointerup", { pointerId: 4, buttons: 0 });
    h2.tick();
    if (h2.n.convert !== 1) bad.push("取り直したドラッグを離しても変換されない（止まったまま）");
  }
  // (f) ほかのポインタの「離した」では終わらない・右ボタンでは掴まない
  {
    const h = harness(IC);
    h.fire("pointerdown", { pointerId: 5 });
    h.fire("pointerup", { pointerId: 6, buttons: 0 });
    if (!h.ctl.gate.dragging(5)) bad.push("ほかのポインタの pointerup でドラッグが終わった");
    // ドラッグ中に別のポインタ（もう片方の手のマウス・2 本目の指）が動いても絵は動かない／押していないポインタの move でも動かない
    const px0 = h.ctl.placement().dx0;
    const r0 = h.n.raw;
    h.fire("pointermove", { pointerId: 6, buttons: 1, clientX: 100 });
    if (h.ctl.placement().dx0 !== px0 || h.n.raw !== r0) bad.push("ドラッグ中に別のポインタの move で絵が動いた");
    const hv = harness(IC);
    hv.fire("pointermove", { pointerId: 1, buttons: 1, clientX: 100 });
    if (hv.n.raw !== 0) bad.push("押していないのに move で絵が動いた");
    const h2 = harness(IC);
    const pv = h2.fire("pointerdown", { button: 2 });
    if (pv || h2.ctl.gate.dragging(1)) bad.push("右ボタンで掴んだ");
    // 捕捉が失敗しても落ちない
  }
  // (g) ★倍率スライダー: 掴んでいる間は変換しない・離したら 100ms 後・値が変わらずに離しても解ける
  {
    const h = harness(IC);
    const sl = IC.cropSliderHandlers(h.ctl, h.win);
    sl.onDown();
    if (h.win.count() !== 2) bad.push(`スライダーを掴んだとき窓の pointerup/cancel を待っていない（${h.win.count()}）`);
    const s0 = h.n.sync;
    sl.onInput(4);
    if (h.o.zoom !== 2) bad.push(`スライダー 4 段目の倍率が ${h.o.zoom}（2 のはず）`);
    if (h.n.sync !== s0 + 1) bad.push(`スライダーで倍率を変えたのに表示を合わせない（sync ${h.n.sync - s0} 回・1 回のはず）`);
    sl.onInput(6);
    h.ctl.gate.schedule();
    h.tick();
    sl.onChange(); // 掴んでいる間に change が来ても
    h.tick();
    if (h.n.convert !== 0) bad.push(`★スライダーを掴んでいる間に変換が ${h.n.convert} 回走った（0 のはず）`);
    if (h.n.raw !== 2) bad.push(`スライダーを動かした 2 回で素の絵が ${h.n.raw} 回（2 のはず）`);
    h.win.fire("pointerup");
    if (h.win.count() !== 0) bad.push("離したあとも窓の待ち受けが残っている");
    if (h.timers.length !== 1 || h.timers[0].ms !== 100) bad.push(`スライダーを離したあとの予約が ${h.timers.map((t) => t.ms).join(",") || "なし"}（100ms のはず）`);
    h.tick();
    if (h.n.convert !== 1) bad.push(`スライダーを離したあとの変換が ${h.n.convert} 回（1 回のはず）`);
    // 値が変わらずに離す（クリックだけ）→ 触っている状態が解ける（変換が止まったままにならない）
    sl.onDown();
    h.win.fire("pointercancel");
    h.ctl.gate.schedule();
    h.tick();
    if (h.n.convert !== 2) bad.push("スライダーを動かさずに離したあと変換が止まったまま");
    // キーボード（onDown なし）: input のたびに素の絵・change で 100ms 後に変換
    sl.onInput(7);
    sl.onChange();
    if (h.timers.length !== 1 || h.timers[0].ms !== 100) bad.push("キーボードで倍率を変えたとき変換を予約しない");
    h.tick();
    if (h.n.convert !== 3) bad.push("キーボードで倍率を変えたあと変換されない");
  }
  // (h) 「位置を戻す」と 2 択の切り替え: 出発点（倍率 1・中央）へ・同じ 2 択の押し直しでは戻さない
  {
    const h = harness(IC);
    const sl = IC.cropSliderHandlers(h.ctl, h.win);
    sl.onInput(5);
    h.fire("pointerdown");
    h.fire("pointermove", { clientX: 100 });
    h.fire("pointerup", { buttons: 0 });
    const c1 = { ...h.o.center };
    h.ctl.setFit("cover"); // 同じ 2 択
    if (h.ctl.zoomIndex() !== 5 || h.o.center.x !== c1.x) bad.push("同じ 2 択を押し直したら出発点に戻った");
    const fs0 = h.n.sync;
    const fr0 = h.n.raw;
    h.ctl.setFit("contain");
    if (h.o.fit !== "contain" || h.ctl.zoomIndex() !== 0 || h.o.zoom !== 1 || h.o.center.x !== 0.5 || h.o.center.y !== 0.5)
      bad.push(`2 択を切り替えても出発点に戻らない（段 ${h.ctl.zoomIndex()}・center ${JSON.stringify(h.o.center)}）`);
    if (h.n.sync !== fs0 + 1) bad.push(`2 択を切り替えたのに表示を合わせない（sync ${h.n.sync - fs0} 回・1 回のはず）＝倍率の表示・カーソル・案内が古いまま`);
    if (h.n.raw !== fr0 + 1) bad.push(`2 択を切り替えたのに素の絵を描かない（${h.n.raw - fr0} 回）＝変換まで古い構図のまま`);
    const s0 = h.n.sync;
    if (h.ctl.reset()) bad.push("出発点で「位置を戻す」が何かした");
    sl.onInput(3);
    const rr0 = h.n.raw;
    if (!h.ctl.reset() || h.ctl.zoomIndex() !== 0 || h.o.zoom !== 1 || h.n.sync <= s0) bad.push("「位置を戻す」で出発点に戻らない（または表示を合わせない）");
    if (h.n.raw !== rr0 + 1) bad.push(`「位置を戻す」で素の絵を描かない（${h.n.raw - rr0} 回）＝変換まで古い構図のまま`);
  }
  // (i) 閉じたあとは何もしない（予約を捨てる・素の絵も変換も描かない）
  {
    const h = harness(IC);
    h.ctl.gate.schedule();
    h.ctl.gate.close();
    h.tick();
    h.fire("pointerdown");
    h.fire("pointermove", { clientX: 100 });
    h.fire("pointerup", { buttons: 0 });
    h.ctl.gate.schedule();
    h.ctl.gate.now();
    h.tick();
    if (h.n.convert || h.n.raw) bad.push(`閉じたあとに描いた（変換 ${h.n.convert}・素の絵 ${h.n.raw}）`);
  }
  // (k) 事前の予約なしでドラッグして離す → 「動いた」ことだけで、離したあと変換が 1 回走る
  {
    const h = harness(IC);
    h.fire("pointerdown");
    h.fire("pointermove", { clientX: 200 });
    if (h.n.raw !== 1) bad.push(`動かしたのに素の絵が ${h.n.raw} 回（1 回のはず）`);
    h.fire("pointerup", { buttons: 0 });
    h.tick();
    if (h.n.convert !== 1) bad.push(`事前の予約なしのドラッグを離したあとの変換が ${h.n.convert} 回（1 回のはず）`);
  }
  // (l) 予約は 1 つにまとまる（何度頼んでも変換は 1 回）・いますぐ変換したら残っていた予約は捨てる
  {
    const h = harness(IC);
    h.ctl.gate.schedule();
    h.ctl.gate.schedule();
    h.ctl.gate.schedule(250);
    if (h.timers.length !== 1) bad.push(`変換の予約が ${h.timers.length} 個たまった（1 つにまとまるはず）`);
    while (h.tick() !== null);
    if (h.n.convert !== 1) bad.push(`3 回頼んだ変換が ${h.n.convert} 回走った（1 回のはず）`);
    h.ctl.gate.schedule();
    h.ctl.gate.now();
    while (h.tick() !== null);
    if (h.n.convert !== 2) bad.push(`予約のあとの「いますぐ変換」で変換が ${h.n.convert - 1} 回（1 回のはず＝残った予約が二重に走った）`);
  }
  // (m) 動かせない絵（全体を入れる・倍率 1）をドラッグしても素の絵も変換も走らない／同じ段の onInput は何もしない
  {
    const h = harness(IC);
    h.ctl.setFit("contain");
    h.ctl.gate.schedule(); // 2 択の切り替えのぶんの変換を済ませてから測る（ダイアログでは切り替えのあと予約される）
    while (h.tick() !== null);
    const r0 = h.n.raw;
    const c0 = h.n.convert;
    h.fire("pointerdown");
    for (const cx of [300, 200, 100]) h.fire("pointermove", { clientX: cx });
    h.fire("pointerup", { clientX: 100, buttons: 0 });
    while (h.tick() !== null);
    if (h.n.raw !== r0 || h.n.convert !== c0) bad.push(`動かせない絵をドラッグして描いた（素の絵 ${h.n.raw - r0}・変換 ${h.n.convert - c0}）`);
    const sl = IC.cropSliderHandlers(h.ctl, h.win);
    sl.onInput(0);
    sl.onInput(Number.NaN);
    if (h.n.raw !== r0 || h.ctl.zoomIndex() !== 0 || h.o.zoom !== 1) bad.push("同じ段・数でない値の onInput で何かした");
  }
  // (n) ★pointercancel・lostpointercapture でもドラッグが終わる（終わらないと、触ったまま変換が止まり続ける）
  {
    for (const t of ["pointercancel", "lostpointercapture"]) {
      const h = harness(IC);
      h.fire("pointerdown", { pointerId: 9 });
      h.fire("pointermove", { pointerId: 9, clientX: 300 });
      h.fire(t, { pointerId: 9, buttons: 0 });
      if (h.ctl.gate.dragging(9)) bad.push(`${t} でドラッグが終わらない`);
      if (h.grabbing()) bad.push(`${t} のあとも掴んだカーソルのまま`);
      while (h.tick() !== null);
      if (h.n.convert !== 1) bad.push(`${t} で終えたドラッグのあと変換されない`);
    }
  }
  // (o) 「位置を戻す」でホイールのためた分も捨てる（戻した直後の半ノッチで進まない）
  {
    const h = harness(IC);
    h.fire("wheel", { deltaY: -100 });
    h.fire("wheel", { deltaY: -30 });
    h.ctl.reset();
    h.fire("wheel", { deltaY: -30 });
    if (h.ctl.zoomIndex() !== 0) bad.push("「位置を戻す」の前にためたホイールが残っていた");
  }
  // (p) ページ送り: 表示をそのページに合わせて変換（触っている間なら離すまで持ち越す）
  {
    const h = harness(IC);
    const s0 = h.n.sync;
    h.ctl.pageChanged();
    if (h.n.sync !== s0 + 1 || h.n.convert !== 1) bad.push(`ページ送りで表示合わせ ${h.n.sync - s0} 回・変換 ${h.n.convert} 回（1・1 のはず）`);
    h.fire("pointerdown");
    h.ctl.pageChanged();
    if (h.n.convert !== 1) bad.push("ドラッグ中のページ送りで変換した");
    h.fire("pointerup", { buttons: 0 });
    while (h.tick() !== null);
    if (h.n.convert !== 2) bad.push("ドラッグ中のページ送りで持ち越した変換が、離したあとに走らない");
  }
  // (j) ドラッグ中の「いますぐ変換」（ページ送り）も離すまで持ち越す
  {
    const h = harness(IC);
    h.fire("pointerdown");
    h.ctl.gate.now();
    if (h.n.convert) bad.push("ドラッグ中のページ送りで変換した");
    h.fire("pointerup", { buttons: 0 });
    h.tick();
    if (h.n.convert !== 1) bad.push("ドラッグ中に持ち越した変換が、離したあとに走らない");
  }
  return bad;
};

// ---------------- [S-11] ★main.ts と同じ組み立て（createCropPreview）に、偽の canvas 要素を渡す ----------------
// main.ts が呼ぶのはこの 1 つだけ（操作を作る・canvas に受け口を付ける・スライダーの口を作る）。
// 受け口の種類とホイールの passive: false・座標（枠線と表示の倍率）・捕捉の失敗に強いこと・掴んだカーソルを見る
function fakeCanvasElement(captureThrows = false) {
  const listeners: { type: string; fn: (e: Record<string, unknown>) => void; opts?: { passive?: boolean } }[] = [];
  const cls = new Set<string>();
  const captured: number[] = [];
  const el = {
    addEventListener: (type: string, fn: (e: Record<string, unknown>) => void, opts?: { passive?: boolean }) => {
      listeners.push({ type, fn, opts });
    },
    setPointerCapture: (id: number) => {
      if (captureThrows) throw new Error("InvalidPointerId"); // 捕捉できない（合成の出来事・すでに離れたポインタ等）
      captured.push(id);
    },
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    clientLeft: 3, // 枠線 3px
    clientTop: 3,
    clientWidth: 640, // 2 倍表示
    clientHeight: 480,
    classList: {
      toggle: (t: string, force?: boolean) => {
        const on = force ?? !cls.has(t);
        if (on) cls.add(t);
        else cls.delete(t);
        return on;
      },
    },
  };
  const fire = (type: string, props: Record<string, number> = {}) => {
    let prevented = false;
    // 本物の DOM と同じく、受け口が無ければ何も起きない（付いていないことは (a) が赤にする）。
    // passive: true で付けた受け口の preventDefault は効かない（本物の DOM と同じ）
    for (const l of listeners)
      if (l.type === type) {
        const passive = l.opts?.passive === true;
        const e = {
          pointerId: 1,
          button: 0,
          buttons: 1,
          clientX: 423,
          clientY: 293,
          deltaY: 0,
          deltaMode: 0,
          ...props,
          preventDefault: () => {
            if (!passive) prevented = true;
          },
        };
        l.fn(e);
      }
    return prevented;
  };
  return { el, listeners, cls, captured, fire };
}
function previewHarness(IC: Mod, captureThrows = false) {
  const f = fakeCanvasElement(captureThrows);
  const o = { ...IC.DEFAULT_CONVERT, title: "t" };
  const n = { raw: 0, convert: 0 };
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let tid = 0;
  const wl: Record<string, (() => void)[]> = {};
  const win = {
    addEventListener: (t: string, fn: () => void) => {
      (wl[t] ??= []).push(fn);
    },
    removeEventListener: (t: string, fn: () => void) => {
      wl[t] = (wl[t] ?? []).filter((g) => g !== fn);
    },
  };
  const { ctl, slider } = IC.createCropPreview(
    o,
    {
      image: () => ({ w: 1600, h: 900 }),
      drawRaw: () => n.raw++,
      convert: () => n.convert++,
      sync: () => {},
      setTimer: (fn: () => void, ms: number) => {
        const id = ++tid;
        timers.push({ id, fn, ms });
        return id;
      },
      clearTimer: (h: unknown) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    f.el,
    "ii-grabbing",
    win
  );
  const tick = () => {
    const t = timers.shift();
    if (t) t.fn();
    return t?.ms ?? null;
  };
  const winFire = (t: string) => [...(wl[t] ?? [])].forEach((fn) => fn());
  return { f, o, n, ctl, slider, timers, tick, winFire };
}
const S11: Check = (IC) => {
  const bad: string[] = [];
  // (a) 受け口: pointer 5 種と wheel。★wheel は passive: false（preventDefault が効く）
  {
    const h = previewHarness(IC);
    const types = h.f.listeners.map((l) => l.type).sort();
    for (const t of ["lostpointercapture", "pointercancel", "pointerdown", "pointermove", "pointerup", "wheel"])
      if (!types.includes(t)) bad.push(`プレビューに ${t} の受け口が付いていない（ドラッグ・ホイールが効かない）`);
    const passivePointers = h.f.listeners.filter((l) => l.type.startsWith("pointer") && l.opts?.passive === true).map((l) => l.type);
    if (passivePointers.length) bad.push(`pointer の受け口が passive: true（${passivePointers.join(",")}）＝押したときの preventDefault が効かない`);
    const wheel = h.f.listeners.filter((l) => l.type === "wheel");
    if (wheel.length !== 1 || wheel[0].opts?.passive !== false)
      bad.push(`★ホイールの受け口が passive: false でない（${JSON.stringify(wheel.map((l) => l.opts ?? null))}）＝preventDefault が効かずダイアログもスクロールし得る`);
  }
  // (b) 座標: 枠線 3px・2 倍表示 → 枠の画素
  {
    const f = fakeCanvasElement();
    const port = IC.cropCanvasPort(f.el, "g");
    const at = (x: number, y: number) => port.toCanvas(x, y);
    const a = at(103, 53);
    const b = at(103 + 320, 53 + 240);
    const c = at(103 + 640, 53 + 480);
    if (a.x !== 0 || a.y !== 0 || b.x !== 160 || b.y !== 120 || c.x !== 320 || c.y !== 240)
      bad.push(`クライアント座標 → 枠の画素がずれる（左上 ${a.x},${a.y}・中央 ${b.x},${b.y}・右下 ${c.x},${c.y}）`);
  }
  // (c) 通しで: ホイールで既定の動きを止めて 1 段・ドラッグは捕捉して掴んだカーソル・触っている間は変換しない・離したら 100ms 後
  {
    const h = previewHarness(IC);
    if (!h.f.fire("wheel", { deltaY: -100 })) bad.push("★組み立てたプレビューで、ホイールの既定の動きを止めていない");
    if (h.ctl.zoomIndex() !== 1) bad.push("組み立てたプレビューで、ホイール 1 ノッチが 1 段にならない");
    h.tick();
    const c0 = h.n.convert;
    if (!h.f.fire("pointerdown", { pointerId: 7 })) bad.push("組み立てたプレビューで、押したとき既定の動きを止めていない");
    if (h.f.captured[0] !== 7) bad.push("組み立てたプレビューで、押したポインタを捕捉していない");
    if (!h.f.cls.has("ii-grabbing")) bad.push("掴んでいる間のカーソル（ii-grabbing）が付かない");
    for (let i = 1; i <= 4; i++) h.f.fire("pointermove", { pointerId: 7, clientX: 423 - 30 * i });
    h.ctl.gate.schedule();
    h.tick();
    if (h.n.convert !== c0) bad.push("★組み立てたプレビューで、ドラッグ中に変換が走った");
    h.f.fire("pointerup", { pointerId: 7, buttons: 0 });
    if (h.f.cls.has("ii-grabbing")) bad.push("離したのに掴んだカーソル（ii-grabbing）のまま");
    if (h.timers.length !== 1 || h.timers[0].ms !== 100) bad.push("組み立てたプレビューで、離したあと 100ms の変換を予約しない");
    h.tick();
    if (h.n.convert !== c0 + 1) bad.push("組み立てたプレビューで、離したあと変換されない");
  }
  // (d) ★捕捉が失敗しても（例外）ドラッグは続き、離せば変換される（落ちない・止まらない）
  {
    const h = previewHarness(IC, true);
    let threw = false;
    try {
      h.f.fire("pointerdown", { pointerId: 8 });
    } catch {
      threw = true;
    }
    if (threw) bad.push("捕捉の失敗で例外が外へ出た");
    if (!h.ctl.gate.dragging(8)) bad.push("捕捉に失敗したらドラッグが始まらない");
    h.f.fire("pointermove", { pointerId: 8, clientX: 300 });
    if (h.n.raw < 1) bad.push("捕捉に失敗したあと、ドラッグで絵が動かない");
    h.f.fire("pointerup", { pointerId: 8, buttons: 0 });
    h.tick();
    if (h.n.convert !== 1) bad.push("捕捉に失敗したドラッグを離しても変換されない");
  }
  // (e) 返されたスライダーの口: 掴んでいる間は変換しない・窓の pointerup で解けて 100ms 後に変換
  {
    const h = previewHarness(IC);
    h.slider.onDown();
    h.slider.onInput(4);
    h.ctl.gate.schedule();
    h.tick();
    if (h.n.convert !== 0) bad.push("★組み立てたスライダーの口で、掴んでいる間に変換が走った");
    h.winFire("pointerup");
    h.tick();
    if (h.n.convert !== 1) bad.push("組み立てたスライダーの口で、離したあと変換されない");
  }
  return bad;
};

// ---------------- [S-12] main.ts の呼び出し口の形（main.ts は Node で動かせない＝構文木で見る） ----------------
// ★ここまでの [S-10]・[S-11] は部品を動かして見ている。main.ts に残るのは「部品を呼ぶ」「本物の要素を渡す」だけなので、
//   その形を TypeScript の構文木で固定する（正規表現の字面ではなく構文で見る＝空白・改行・書き方の違いでは黙らない）。
//   見るのは偶発的に起こり得る壊れ方: 呼び出し口が 1 つ・本物の #ii-cv（const）と window を渡す・
//   プレビューの変換（convertToProject）は関所の中（createCropPreview の convert）と「取り込む」ボタンの中だけ・
//   CSS で #ii-cv に touch-action: none（ペン・タッチのドラッグをスクロールに取られない）
function isInside(node: ts.Node, container: ts.Node | undefined): boolean {
  if (!container) return false;
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (n === container) return true;
  return false;
}
const S12: Check = (_IC, ctx) => {
  const bad: string[] = [];
  const src = fs.readFileSync(path.join(ctx.dir, "src/main.ts"), "utf8");
  const sf = ts.createSourceFile("main.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let dialog: ts.FunctionDeclaration | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "openImageImportDialog") dialog = n;
  });
  if (!dialog) return ["main.ts に openImageImportDialog が無い（検査が空振り）"];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const previews: ts.CallExpression[] = [];
  const converts: ts.CallExpression[] = [];
  const okHandlers: ts.Node[] = [];
  const pageHandlers: Record<string, ts.Node[]> = { "#ii-prev": [], "#ii-next": [] };
  const cvDecls: ts.VariableDeclaration[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const ex = n.expression;
      if (ts.isIdentifier(ex) && ex.text === "createCropPreview") previews.push(n);
      if (ts.isIdentifier(ex) && ex.text === "convertToProject") converts.push(n);
      // q("#ii-ok").addEventListener("click", <処理>)
      if (
        ts.isPropertyAccessExpression(ex) &&
        ex.name.text === "addEventListener" &&
        ts.isCallExpression(ex.expression) &&
        ex.expression.arguments.length === 1 &&
        ts.isStringLiteral(ex.expression.arguments[0]) &&
        ex.expression.arguments[0].text === "#ii-ok" &&
        n.arguments.length >= 2
      )
        okHandlers.push(n.arguments[1]);
      // q("#ii-prev" / "#ii-next").addEventListener("click", <処理>)
      if (
        ts.isPropertyAccessExpression(ex) &&
        ex.name.text === "addEventListener" &&
        ts.isCallExpression(ex.expression) &&
        ex.expression.arguments.length === 1 &&
        ts.isStringLiteral(ex.expression.arguments[0]) &&
        ex.expression.arguments[0].text in pageHandlers &&
        n.arguments.length >= 2
      )
        pageHandlers[ex.expression.arguments[0].text].push(n.arguments[1]);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "cv") cvDecls.push(n);
    n.forEachChild(walk);
  };
  walk(dialog);
  // (a) 呼び出し口は 1 つ・3〜5 番目は cv / "ii-grabbing" / window
  if (previews.length !== 1) bad.push(`createCropPreview の呼び出しが ${previews.length} 回（1 回のはず＝付け忘れ・二重に付けている）`);
  const call = previews[0];
  if (call) {
    const a = call.arguments;
    const ok =
      a.length === 5 &&
      ts.isIdentifier(a[2]) &&
      a[2].text === "cv" &&
      ts.isStringLiteral(a[3]) &&
      a[3].text === "ii-grabbing" &&
      ts.isIdentifier(a[4]) &&
      a[4].text === "window";
    if (!ok) bad.push(`★createCropPreview に本物のプレビュー（cv）と window を渡していない（${line(call)} 行: ${a.slice(2).map((x) => x.getText(sf)).join(", ")}）`);
  }
  // (b) cv は const で、q<HTMLCanvasElement>("#ii-cv")（別の要素・書き換えられる変数にしない）
  if (cvDecls.length !== 1) bad.push(`ダイアログの中の cv の宣言が ${cvDecls.length} 個（1 個のはず）`);
  else {
    const d = cvDecls[0];
    const isConst = ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;
    const init = d.initializer;
    const ok =
      isConst &&
      !!init &&
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === "q" &&
      init.arguments.length === 1 &&
      ts.isStringLiteral(init.arguments[0]) &&
      init.arguments[0].text === "#ii-cv";
    if (!ok) bad.push(`cv が const q<HTMLCanvasElement>("#ii-cv") でない（${line(d)} 行: ${d.getText(sf).slice(0, 80)}）`);
  }
  // (c) プレビューの変換は関所の中（createCropPreview の 2 番目の convert）と「取り込む」ボタンの中だけ
  let gateConvert: ts.Node | undefined;
  const io = call?.arguments[1];
  if (io && ts.isObjectLiteralExpression(io))
    for (const p of io.properties)
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "convert") gateConvert = p.initializer;
  if (!gateConvert) bad.push("createCropPreview に convert（変換済みの絵を描く処理）を渡していない");
  let inGate = 0;
  for (const c of converts) {
    if (isInside(c, gateConvert)) inGate++;
    else if (!okHandlers.some((h) => isInside(c, h))) bad.push(`★関所の外でプレビューを変換している（${line(c)} 行）＝触っている間も走り得る`);
  }
  if (gateConvert && inGate === 0) bad.push("関所の convert の中で変換していない（検査が空振り）");
  if (!okHandlers.length) bad.push("「取り込む」ボタンの処理が見つからない（検査が空振り）");
  // (f) ページ送りのボタンは crop.pageChanged() を呼ぶ（表示をそのページに合わせる・変換も関所を通す）
  for (const [id, hs] of Object.entries(pageHandlers)) {
    const calls: ts.CallExpression[] = [];
    const findPc = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "pageChanged" &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === "crop"
      )
        calls.push(n);
      n.forEachChild(findPc);
    };
    hs.forEach(findPc);
    if (hs.length !== 1 || calls.length !== 1) bad.push(`${id} のボタンが crop.pageChanged() を呼んでいない（受け口 ${hs.length}・呼び出し ${calls.length}）＝ページを送っても表示が前のページのまま`);
  }
  // (g) render は crop.gate.now()（開いた直後はすぐ変換）・schedule は crop.gate.schedule(ms)（設定の変更は 100ms 後）・
  //     開いた直後に render() を呼ぶ（どちらも関所を通す）
  const arrowCalls = (name: string): string | null => {
    let found: string | null = null;
    const look = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isArrowFunction(n.initializer)) {
        const b = n.initializer.body;
        const call = ts.isCallExpression(b) ? b : null;
        found = call ? call.getText(sf).replace(/\s+/g, "") : `（呼び出しでない: ${b.getText(sf).slice(0, 40)}）`;
      }
      n.forEachChild(look);
    };
    look(dialog!);
    return found;
  };
  const rd = arrowCalls("render");
  const sc = arrowCalls("schedule");
  if (rd !== "crop.gate.now()") bad.push(`render が crop.gate.now() でない（${rd}）＝開いた直後・ページ送りの変換がすぐ走らない／関所を通らない`);
  if (sc !== "crop.gate.schedule(ms)") bad.push(`schedule が crop.gate.schedule(ms) でない（${sc}）＝設定の変更の変換が 100ms 待たない／関所を通らない`);
  const topRender = dialog!.body
    ? (() => {
        let n = 0;
        const walkTop = (x: ts.Node) => {
          if (ts.isExpressionStatement(x) && ts.isCallExpression(x.expression) && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === "render") n++;
          x.forEachChild(walkTop);
        };
        walkTop(dialog!.body);
        return n;
      })()
    : 0;
  if (topRender < 1) bad.push("開いた直後に render() を呼んでいない（プレビューが空のまま）");
  // (e) 部品の名前は import したものを指す（main.ts の中で同じ名前の関数・変数・引数を作って差し替えない）
  const shadowed: string[] = [];
  const seek = (n: ts.Node) => {
    const nm = (n as { name?: ts.Node }).name;
    if (
      nm &&
      ts.isIdentifier(nm) &&
      ["createCropPreview", "convertToProject"].includes(nm.text) &&
      (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isClassDeclaration(n))
    )
      shadowed.push(`${nm.text}（${line(n)} 行）`);
    n.forEachChild(seek);
  };
  seek(sf);
  if (shadowed.length) bad.push(`main.ts の中で部品と同じ名前を作って差し替えている: ${shadowed.join("・")}`);
  // (d) CSS: #ii-cv に touch-action: none
  const css = fs.readFileSync(path.join(ctx.dir, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // V192: 前の形 `(^|\})` は前の規則の `}` を**食べる**ので、matchAll が規則を 1 つおきにしか見ていなかった
  //（V192 で styles.css に規則を 1 つ足したら偶奇がずれ、touch-action の規則が飛ばされて**誤って**赤になった）。
  // `}` は見るだけ（後読み）にして全部の規則を見る。見落としていた規則も見るようになり、誤った赤が消えた——
  // 検査の中身（#ii-cv に touch-action: none があるか）は同じで、厳しくも緩くもしていない（前に緑だった所は今も緑）
  const cvRules = [...css.matchAll(/(^|(?<=\}))\s*([^{}]+)\{([^}]*)\}/g)].filter((m) => m[2].split(",").some((sel) => sel.trim() === "#ii-cv"));
  if (!cvRules.some((m) => /(^|;|\s)touch-action\s*:\s*none\s*(;|$)/.test(m[3].trim())))
    bad.push("styles.css の #ii-cv に touch-action: none が無い（ペン・タッチのドラッグがスクロールに取られる）");
  return bad;
};

const CHECKS: [string, Check][] = [
  ["[S-1] ★既定値（倍率 1）＝この回の前の式の範囲だけ整数（V182）・倍率 >1 は V182 の前とバイト一致", S1],
  ["[S-2] zoom=2・中央で、元画像の中央 1/2 が枠いっぱい", S2],
  ["[S-3] center を端にしても枠に隙間ができない", S3],
  ["[S-4] 枠より小さい軸は中央に固定", S4],
  ["[S-5] ★大きさの違う 2 枚に同じ zoom・center → 同じ構図", S5],
  ["[S-6] 拡大はにじまない（最近傍）", S6],
  ["[S-7] zoom は 1〜8 に収まる", S7],
  ["[S-8] 素の絵（ドラッグ中）と変換の結果が同じ所に絵を置く", S8],
  ["[S-9] ドラッグ・ホイールの計算（指につく・端で止まる・戻すとすぐ動く・カーソルの下が動かない）", S9],
  ["[S-10] ★ダイアログの操作: 触っている間は変換 0 回・離したら 100ms 後に 1 回・ホイールは既定の動きを止める・止まったままにならない", S10],
  ["[S-11] ★main.ts と同じ組み立て（createCropPreview）: 受け口 6 種・ホイールは passive: false・座標・捕捉の失敗に強い・スライダーの口", S11],
  ["[S-12] main.ts の呼び出し口の形（構文木）: createCropPreview に本物の #ii-cv と window・変換は関所と「取り込む」だけ・touch-action: none", S12],
];

function run(fn: Check, IC: Mod, ctx: Ctx): { bad: string[]; threw: boolean } {
  try {
    return { bad: fn(IC, ctx), threw: false };
  } catch (e) {
    return { bad: [`例外: ${String((e as Error)?.message ?? e).slice(0, 160)}`], threw: true };
  }
}

// ================= 写し（無改変・この回の前・反証）の置き場 =================
// 既定は node_modules/.v179-smoke/<pid>（git の外・npm の部品が見える）。
// サンドボックスで node_modules へ書けないとき（使い捨て worktree で node_modules がジャンクション等）は
// 環境変数 V179_SMOKE_WORK で置き場を差し替える。**その祖先に node_modules があること**（部品を解決するため）
const WORK = path.join(process.env.V179_SMOKE_WORK || path.join(root, "node_modules", ".v179-smoke"), String(process.pid));
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
  /** 書き換えるファイル（src からの相対・省略＝imageConvert.ts） */
  file?: string;
  from: string;
  to: string;
}
let seq = 0;
/** src/ を写して `edits` を当てた木を読む（既定は imageConvert.ts・`file` で main.ts / styles.css も）。書き換えは**ちょうど 1 か所**に当たること */
async function mutant(edits: Edit[]): Promise<{ IC: Mod | null; dir: string; why: string }> {
  const dir = path.join(WORK, `m${++seq}`);
  copySrc(dir);
  for (const e of edits) {
    const f = path.join(dir, e.file ?? IC_REL);
    const text = fs.readFileSync(f, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const from = e.from.replace(/\n/g, eol);
    const n = text.split(from).length - 1;
    if (n !== 1) return { IC: null, dir, why: `書き換えが当たらない（${n} 箇所）: ${e.from.trim().slice(0, 70)}` };
    fs.writeFileSync(f, text.replace(from, () => e.to.replace(/\n/g, eol)));
  }
  return { IC: await loadIC(dir), dir, why: "" };
}
/** 過去の imageConvert.ts（blob）を写しに戻して読む（`edits` があれば当てる・どれもちょうど 1 か所）。
 *  git が無い・blob が無い・書き換えが当たらないときは null */
async function loadOld(blob = BASELINE_BLOB, name = "old", edits: Edit[] = []): Promise<Mod | null> {
  let text: string;
  try {
    text = execFileSync("git", ["cat-file", "-p", blob], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const e of edits) {
    const from = e.from.replace(/\n/g, eol);
    if (text.split(from).length - 1 !== 1) return null;
    text = text.replace(from, () => e.to.replace(/\n/g, eol));
  }
  const dir = path.join(WORK, name);
  copySrc(dir);
  fs.writeFileSync(path.join(dir, IC_REL), text);
  return loadIC(dir);
}

// ================= 反証（壊した写し → 赤になること） =================
interface Counter {
  id: string;
  what: string;
  edits: Edit[];
  /** 赤になるべき検査（CHECKS の添字） */
  expect: number[];
}
const COUNTERS: Counter[] = [
  {
    id: "1z",
    what: "既定値でも新しい丸め（round）を通す",
    edits: [{ from: "Math.floor(frame / 2 - c * d)", to: "Math.round(frame / 2 - c * d)" }],
    expect: [0],
  },
  {
    id: "1z'",
    what: "枠より小さい軸も要件の式そのまま（round・中央の分岐なし）",
    edits: [{ from: "if (d <= frame) return Math.floor((frame - d) / 2);", to: "if (d <= frame) return Math.round(frame / 2 - c * d);" }],
    expect: [0],
  },
  {
    id: "1z''",
    what: "倍率 1 でも拡大を最近傍にする（小さい画像の既定の絵が変わる）",
    edits: [{ from: "const zoomed = clampCropZoom(zoom) > 1;", to: "const zoomed = true;" }],
    expect: [0],
  },
  {
    id: "1v182",
    what: "V182 を戻す（倍率 1 の範囲を浮動小数の式に）→ 置き換えた [S-1] が赤",
    edits: [
      {
        // V182 の倍率 1 の枝の速い道（字下げ 8・後ろに BigInt の道の頭）
        from: "        lo = Math.floor((k * s) / d);\n        hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) * s) / d) - 1));\n      } else {",
        to: "        lo = Math.floor((k / d) * s);\n        hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) / d) * s) - 1));\n      } else {",
      },
    ],
    expect: [0],
  },
  {
    id: "2z",
    what: "zoom を掛け忘れる",
    edits: [{ from: "const scale = s0 * clampCropZoom(zoom);", to: "const scale = s0;" }],
    expect: [1],
  },
  {
    id: "3z",
    what: "はみ出しの制限を外す",
    edits: [
      {
        from: "return Math.min(0, Math.max(frame - d, Math.floor(frame / 2 - c * d)));",
        to: "return Math.floor(frame / 2 - c * d);",
      },
    ],
    expect: [2],
  },
  {
    id: "4z",
    what: "枠より小さい軸も center で動かす",
    edits: [{ from: "if (d <= frame) return Math.floor((frame - d) / 2);", to: "if (d <= frame) return Math.floor((frame - d) * c);" }],
    expect: [3],
  },
  {
    id: "5z",
    what: "倍率をページ自身の出発点に掛けない（足し算）",
    edits: [{ from: "const scale = s0 * clampCropZoom(zoom);", to: "const scale = s0 + clampCropZoom(zoom) - 1;" }],
    expect: [4],
  },
  {
    id: "5z'",
    what: "center を割合でなく決まった画素数で持つ",
    edits: [{ from: "Math.floor(frame / 2 - c * d)", to: "Math.floor(frame / 2 - c * 100)" }],
    expect: [4],
  },
  {
    id: "6z",
    what: "拡大を混ぜる（面積平均のまま＝境目の画素が 2 色の平均）",
    edits: [{ from: "} else if (d > s) {", to: "} else if (false) {" }],
    expect: [5],
  },
  {
    id: "6z'",
    what: "拡大の最近傍を画素の中心でなく左端で取る（素の絵の drawImage と 1 画素ずれる）",
    edits: [
      {
        from: "lo = hi = Math.min(s - 1, Math.floor(((2 * k + 1) * s) / (2 * d)));",
        to: "lo = hi = Math.min(s - 1, Math.floor((k * s) / d));",
      },
    ],
    expect: [7],
  },
  {
    id: "2z'",
    what: "倍率を上げたときの縮小の範囲を前の浮動小数の式に戻す（1:1・2 分の 1 で隣の画素を拾う）",
    // V182: 倍率 1 の枝も同じ 2 行になったので、後ろに続く `}` と `spans[...] = lo;` まで含めて縮小の枝の 1 か所に決める
    edits: [
      {
        from: "      lo = Math.floor((k * s) / d);\n      hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) * s) / d) - 1));\n    }\n    spans[(k - from) * 2] = lo;",
        to: "      lo = Math.floor((k / d) * s);\n      hi = Math.min(s - 1, Math.max(lo, Math.ceil(((k + 1) / d) * s) - 1));\n    }\n    spans[(k - from) * 2] = lo;",
      },
    ],
    expect: [1, 2],
  },
  {
    id: "7z",
    what: "zoom を収めない",
    edits: [{ from: "return Math.min(CROP_ZOOM_MAX, Math.max(CROP_ZOOM_MIN, z));", to: "return z;" }],
    expect: [6],
  },
  {
    id: "7z'",
    what: "上だけ収めない（100 がそのまま通る）",
    edits: [{ from: "return Math.min(CROP_ZOOM_MAX, Math.max(CROP_ZOOM_MIN, z));", to: "return Math.max(CROP_ZOOM_MIN, z);" }],
    expect: [6],
  },
  {
    id: "7z''",
    what: "下だけ収めない（0 がそのまま通る）",
    edits: [{ from: "return Math.min(CROP_ZOOM_MAX, Math.max(CROP_ZOOM_MIN, z));", to: "return Math.min(CROP_ZOOM_MAX, z);" }],
    expect: [6],
  },
  {
    id: "8z",
    what: "変換だけ 1 画素ずらす（素の絵と取り込んだ結果が食い違う）",
    edits: [{ from: "const ox = dx0 + dxS + i / 2;", to: "const ox = dx0 + dxS + i / 2 + 1;" }],
    expect: [7],
  },
  {
    id: "9z",
    what: "ドラッグの center を収めない（端で行き過ぎをため込む）",
    edits: [{ from: "x: p.movableX ? clampCenterAxis(W, p.dw, cx - dx / p.dw) : cx,", to: "x: p.movableX ? cx - dx / p.dw : cx," }],
    expect: [8],
  },
  {
    id: "9z'",
    what: "ドラッグの向きが逆（絵が指と逆へ動く）",
    edits: [{ from: "clampCenterAxis(W, p.dw, cx - dx / p.dw)", to: "clampCenterAxis(W, p.dw, cx + dx / p.dw)" }],
    expect: [8],
  },
  {
    id: "9z''",
    what: "動かせない軸の center も変える",
    edits: [{ from: "y: p.movableY ? clampCenterAxis(H, p.dh, cy - dy / p.dh) : cy,", to: "y: clampCenterAxis(H, p.dh, cy - dy / p.dh)," }],
    expect: [8],
  },
  {
    id: "9z'''",
    what: "ホイールでカーソルの下の点を保たない",
    edits: [{ from: "x: to.movableX ? clampCenterAxis(W, to.dw, (W / 2 - anchor.x) / to.dw + u) : cx,", to: "x: to.movableX ? clampCenterAxis(W, to.dw, cx) : cx," }],
    expect: [8],
  },
  {
    id: "10z",
    what: "★触っている間も変換する（関所を外す）",
    edits: [{ from: "    if (touching()) {\n      pending = true;\n      return;\n    }\n    pending = false;\n    io.convert();", to: "    pending = false;\n    io.convert();" }],
    expect: [9],
  },
  {
    id: "10z'",
    what: "離しても変換を予約しない（ドット化された絵に戻らない）",
    edits: [{ from: "if (!touching() && pending) schedule(CROP_CONVERT_DELAY_MS);", to: "pending = false;" }],
    expect: [9],
  },
  {
    id: "10z''",
    what: "離したあとの待ちを 100ms でなく 0ms にする",
    edits: [{ from: "if (!touching() && pending) schedule(CROP_CONVERT_DELAY_MS);", to: "if (!touching() && pending) schedule(0);" }],
    expect: [9],
  },
  {
    id: "10z'''",
    what: "動いたことを覚えない（事前の予約が無いと、離しても変換しない）",
    edits: [{ from: "      pending = true;\n      io.drawRaw();", to: "      io.drawRaw();" }],
    expect: [9],
  },
  {
    id: "10z4",
    what: "閉じても止めない（閉じたあとに変換が走る）",
    edits: [{ from: "      closed = true;\n      cancel();", to: "      cancel();" }],
    expect: [9],
  },
  {
    id: "10z5",
    what: "「離した」が届かないとき、次に押しても取り直さない（触ったまま止まる）",
    edits: [{ from: "      drag = pointerId;", to: "      if (drag === null) drag = pointerId;" }],
    expect: [9],
  },
  {
    id: "10z6",
    what: "ボタンの離れた move で終えない",
    edits: [{ from: "    if (e.buttons === 0) {\n      end(e);\n      return;\n    }\n", to: "" }],
    expect: [9],
  },
  {
    id: "10z7",
    what: "★ホイールで既定の動きを止めない（ダイアログもスクロールする）",
    edits: [{ from: "    e.preventDefault();\n    ctl.wheel(", to: "    ctl.wheel(" }],
    expect: [9],
  },
  {
    id: "10z8",
    what: "押したとき既定の動きを止めない",
    edits: [{ from: "    if (e.button !== 0) return;\n    e.preventDefault();", to: "    if (e.button !== 0) return;" }],
    expect: [9],
  },
  {
    id: "10z9",
    what: "押したポインタを捕捉しない",
    edits: [{ from: "      port.capture(e.pointerId);", to: "      void e.pointerId;" }],
    expect: [9],
  },
  {
    id: "10z10",
    what: "★スライダーを掴んでも「触っている」にしない（掴んでいる間に変換が走る）",
    edits: [{ from: "      ctl.gate.slideStart();", to: "" }],
    expect: [9],
  },
  {
    id: "10z11",
    what: "ホイールの向きが逆",
    edits: [{ from: "const dir = wheelAcc < 0 ? 1 : -1;", to: "const dir = wheelAcc < 0 ? -1 : 1;" }],
    expect: [9],
  },
  {
    id: "10z12",
    what: "ホイールをためない（タッチパッドの小さな動きごとに 1 段）",
    edits: [{ from: "      if (Math.abs(wheelAcc) < CROP_WHEEL_NOTCH_PX / 2) return;", to: "" }],
    expect: [9],
  },
  {
    id: "10z15",
    what: "まとめて届いたノッチを 1 段に数える（回した分より進まない）",
    edits: [{ from: "if (ctl.zoomTo(zoomIdx + dir * steps, anchor))", to: "if (ctl.zoomTo(zoomIdx + dir, anchor))" }],
    expect: [9],
  },
  {
    id: "10z13",
    what: "ホイールのあとの待ちを 250ms でなく 100ms にする（回している途中に変換が割り込む）",
    edits: [{ from: "gate.schedule(CROP_WHEEL_SETTLE_MS)", to: "gate.schedule()" }],
    expect: [9],
  },
  {
    id: "10z14",
    what: "2 択を切り替えても出発点に戻さない",
    edits: [{ from: "      o.fit = fit;\n      toStart();", to: "      o.fit = fit;" }],
    expect: [9],
  },
  {
    id: "10z16",
    what: "ドラッグの差を前の位置でなく押した所から取る（指より大きく動く）",
    edits: [{ from: "    last = p;\n    ctl.panBy(dx, dy);", to: "    ctl.panBy(dx, dy);" }],
    expect: [9],
  },
  {
    id: "10z17",
    what: "受け口から渡す移動の向きが逆（絵が指と逆へ動く）",
    edits: [{ from: "    const dx = p.x - last.x;", to: "    const dx = last.x - p.x;" }],
    expect: [9],
  },
  {
    id: "10z18",
    what: "倍率を変えても表示（倍率・スライダー・カーソル・案内）を合わせない",
    edits: [{ from: "      zoomIdx = ni;\n      io.sync();\n      gate.moved();", to: "      zoomIdx = ni;\n      gate.moved();" }],
    expect: [9],
  },
  {
    id: "10z19",
    what: "予約を取り消さない（何度も頼むと変換が何回も走る）",
    edits: [{ from: "    if (timer !== null) io.clearTimer(timer);\n", to: "" }],
    expect: [9],
  },
  {
    id: "10z20",
    what: "動かなくても素の絵を描く（動かせない絵のドラッグで変換も走る）",
    edits: [{ from: "      if (after.dx0 === before.dx0 && after.dy0 === before.dy0) return false; // 端・動かせない軸・1 画素未満\n", to: "" }],
    expect: [9],
  },
  {
    id: "10z21",
    what: "★pointercancel でドラッグを終えない",
    edits: [{ from: "  port.onPointer(\"pointercancel\", end);", to: "  port.onPointer(\"pointercancel\", () => {});" }],
    expect: [9],
  },
  {
    id: "10z22",
    what: "lostpointercapture でドラッグを終えない",
    edits: [{ from: "  port.onPointer(\"lostpointercapture\", end);", to: "  port.onPointer(\"lostpointercapture\", () => {});" }],
    expect: [9],
  },
  {
    id: "10z23",
    what: "同じ段でも倍率を変えたことにする（素の絵・表示合わせが余計に走る）",
    edits: [{ from: "      if (ni === zoomIdx) return false;", to: "" }],
    expect: [9],
  },
  {
    id: "10z24",
    what: "ページ単位のホイールを 1 ページ＝8 段に数える",
    edits: [{ from: "deltaMode === 2 ? deltaY * CROP_WHEEL_NOTCH_PX : deltaY;", to: "deltaMode === 2 ? deltaY * 800 : deltaY;" }],
    expect: [9],
  },
  {
    id: "10z25",
    what: "「位置を戻す」でホイールのためた分を捨てない",
    edits: [{ from: "    zoomIdx = 0;\n    wheelAcc = 0;", to: "    zoomIdx = 0;" }],
    expect: [9],
  },
  {
    id: "10z26",
    what: "2 択を切り替えても表示（倍率・カーソル・案内）を合わせない",
    edits: [{ from: "      o.fit = fit;\n      toStart();\n      io.sync();", to: "      o.fit = fit;\n      toStart();" }],
    expect: [9],
  },
  {
    id: "10z27",
    what: "「位置を戻す」で素の絵を描かない（変換まで古い構図のまま）",
    edits: [{ from: "      gate.moved(); // 表示と絵を揃える（倍率の表示だけ先に変わって絵が古いまま、を作らない）\n", to: "" }],
    expect: [9],
  },
  {
    id: "10z28",
    what: "ページ送りで表示を合わせない",
    edits: [{ from: "    pageChanged() {\n      io.sync();", to: "    pageChanged() {" }],
    expect: [9],
  },
  {
    id: "10z29",
    what: "move がいまのドラッグのポインタか確かめない（別のポインタ・押していない move で絵が動く）",
    edits: [{ from: "  port.onPointer(\"pointermove\", (e) => {\n    if (!ctl.gate.dragging(e.pointerId)) return;\n", to: "  port.onPointer(\"pointermove\", (e) => {\n" }],
    expect: [9],
  },
  {
    id: "11z",
    what: "★ホイールの受け口を passive: false で付けない（preventDefault が効かない）",
    edits: [{ from: "onWheel: (fn) => cv.addEventListener(\"wheel\", fn, { passive: false }),", to: "onWheel: (fn) => cv.addEventListener(\"wheel\", fn)," }],
    expect: [10],
  },
  {
    id: "11z6",
    what: "★pointer の受け口を passive: true で付ける（押したときの preventDefault が効かない）",
    edits: [{ from: "    onPointer: (type, fn) => cv.addEventListener(type, fn),", to: "    onPointer: (type, fn) => cv.addEventListener(type, fn, { passive: true })," }],
    expect: [10],
  },
  {
    id: "11z'",
    what: "★プレビューに受け口を付けない（ドラッグもホイールも効かない）",
    edits: [{ from: "  bindCropCanvas(cropCanvasPort(cv, grabbingClass), ctl);", to: "  void cropCanvasPort;" }],
    expect: [10],
  },
  {
    id: "11z''",
    what: "★捕捉に失敗したらドラッグを始めない",
    edits: [{ from: "      /* 捕捉できなくてもドラッグは続けられる（キャンバスの外へ出ると止まるだけ） */", to: "      return;" }],
    expect: [10],
  },
  {
    id: "11z'''",
    what: "座標の変換で枠線を引かない（指と絵が 1〜2 画素ずれる）",
    edits: [{ from: "x: ((clientX - r.left - cv.clientLeft) * W) / (cv.clientWidth || W),", to: "x: ((clientX - r.left) * W) / (cv.clientWidth || W)," }],
    expect: [10],
  },
  {
    id: "11z4",
    what: "掴んでいる間のカーソルを付けない",
    edits: [{ from: "      cv.classList.toggle(grabbingClass, on);", to: "      void on;" }],
    expect: [10],
  },
  {
    id: "11z5",
    what: "★組み立てで、スライダーの口に「掴んでいる」を入れない（掴んでいる間に変換が走る）",
    edits: [
      {
        from: "  return { ctl, slider: cropSliderHandlers(ctl, win) };",
        to: "  return { ctl, slider: { onDown: () => {}, onInput: (i: number) => { ctl.zoomTo(i); }, onChange: () => ctl.gate.schedule() } };",
      },
    ],
    expect: [10],
  },
  {
    id: "12z",
    what: "★main.ts で本物の canvas の代わりに受け口を付けない偽物を渡す（Codex 3 回目の形）",
    edits: [
      {
        file: "src/main.ts",
        from: "    }, cv, \"ii-grabbing\", window);",
        to: "    }, ({ ...cv, addEventListener: () => {} } as any), \"ii-grabbing\", window);",
      },
    ],
    expect: [11],
  },
  {
    id: "12z'",
    what: "★main.ts で関所の外からプレビューを変換する",
    edits: [{ file: "src/main.ts", from: "    zoomSl.root.style.flex = \"1\";", to: "    zoomSl.root.style.flex = \"1\";\n    convertToProject(images, o);" }],
    expect: [11],
  },
  {
    id: "12z''",
    what: "main.ts で別の要素をプレビューとして渡す",
    edits: [{ file: "src/main.ts", from: "    const cv = q<HTMLCanvasElement>(\"#ii-cv\");", to: "    const cv = q<HTMLCanvasElement>(\".imgimp-left\");" }],
    expect: [11],
  },
  {
    id: "12z'''",
    what: "styles.css から #ii-cv の touch-action: none を消す（ペン・タッチのドラッグがスクロールに取られる）",
    edits: [{ file: "src/styles.css", from: "#ii-cv {\n  touch-action: none;\n}", to: "#ii-cv {\n}" }],
    expect: [11],
  },
  {
    id: "12z5",
    what: "main.ts の中で createCropPreview を同じ名前の関数で差し替える（本物の cv を受けても使わない）",
    edits: [
      {
        file: "src/main.ts",
        from: "    const PREVIEW_EXACT_MAX = 8;",
        to: "    const PREVIEW_EXACT_MAX = 8;\n    const createCropPreview = (a: ConvertOptions, b: Parameters<typeof createCropController>[1], _c: unknown, _d: string, _e: unknown) => ({ ctl: createCropController(a, b), slider: { onDown() {}, onInput() {}, onChange() {} } });",
      },
      { file: "src/main.ts", from: "  CROP_ZOOM_STEPS,\n  canvasPlacement,", to: "  CROP_ZOOM_STEPS,\n  canvasPlacement,\n  createCropController," },
    ],
    expect: [11],
  },
  {
    id: "12z4",
    what: "main.ts で createCropPreview を呼ばずに操作だけ作る（受け口が付かない）",
    edits: [
      { file: "src/main.ts", from: "    const { ctl: crop, slider: zoomSliderIo } = createCropPreview(o, {", to: "    const { ctl: crop, slider: zoomSliderIo } = ((a: ConvertOptions, b: Parameters<typeof createCropPreview>[1]) => createCropPreview(a, b, { addEventListener() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientLeft: 0, clientTop: 0, clientWidth: 1, clientHeight: 1, classList: { toggle: () => false } }, \"ii-grabbing\", window))(o, {" },
      { file: "src/main.ts", from: "    }, cv, \"ii-grabbing\", window);", to: "    });" },
    ],
    expect: [11],
  },
  {
    id: "12z6",
    what: "main.ts のページ送り（◀）で crop.pageChanged() を呼ばない（表示が前のページのまま）",
    edits: [{ file: "src/main.ts", from: "      crop.pageChanged(); // 表示をそのページに合わせて変換（触っている間なら離すまで持ち越す）", to: "      render();" }],
    expect: [11],
  },
  {
    id: "12z7",
    what: "main.ts の render を crop.gate.schedule() に取り違える（開いた直後・ページ送りがすぐ変換されない）",
    edits: [{ file: "src/main.ts", from: "    const render = () => crop.gate.now();", to: "    const render = () => crop.gate.schedule();" }],
    expect: [11],
  },
  {
    id: "12z8",
    what: "main.ts の schedule を crop.gate.now() に取り違える（設定を変えるたびに待たずに変換）",
    edits: [{ file: "src/main.ts", from: "    const schedule = (ms?: number) => crop.gate.schedule(ms);", to: "    const schedule = (ms?: number) => (void ms, crop.gate.now());" }],
    expect: [11],
  },
];

// ================= 実行 =================
const t0 = Date.now();
const REAL = (await import("../src/editor/imageConvert")) as Mod;
const OLD = await loadOld();
if (!OLD) console.log(`SKIP この回の前の blob ${BASELINE_BLOB.slice(0, 7)} を取り出せない（git が無い・clone に無い）→ 凍結コピーと固定のハッシュだけで見る`);
const OLD_INT = await loadOld(BASELINE_BLOB, "old-int", V182_INT_EDITS);
if (!OLD_INT) console.log(`SKIP この回の前の blob に V182 の 1 点を当てた写しを作れない → 変換一式の突き合わせを飛ばす`);
const PRE182 = await loadOld(V182_PRE_BLOB, "pre182");
if (!PRE182) console.log(`SKIP V182 の前の blob ${V182_PRE_BLOB.slice(0, 7)} を取り出せない → 倍率 >1 の突き合わせを飛ばす`);
const ctx: Ctx = { OLD, OLD_INT, PRE182, dir: root };

if (process.argv.includes("--print-pin")) {
  // V182: 固定値を出すときは、凍結コピーの範囲だけ整数にした写しの値も並べる（食い違えば貼らない）
  console.log(`本物の既定値の出力 = ${defaultOutputsSha(REAL)}`);
  console.log(`範囲だけ整数にした凍結コピー = ${outputsSha(intResizeToCanvas)}`);
  console.log(`前の式の凍結コピー = ${outputsSha(oldResizeToCanvas)}（PINNED_DEFAULT_SHA と同じはず）`);
  process.exit(0);
}

// 本物
for (const [name, fn] of CHECKS) {
  const r = run(fn, REAL, ctx);
  check(name, r.bad.length === 0, r.bad.slice(0, 6).join(" ／ ") + (r.bad.length > 6 ? ` ／ …ほか ${r.bad.length - 6} 件` : ""));
}

// [S-0] 無改変の写し
{
  const m = await mutant([]);
  let bad = 0;
  const why: string[] = [];
  for (const [name, fn] of CHECKS) {
    const r = run(fn, m.IC!, { ...ctx, dir: m.dir });
    if (r.bad.length) {
      bad++;
      why.push(`${name.slice(0, 6)}: ${r.bad[0]}`);
    }
  }
  check("[S-0] 無改変の写しでは全部緑（写しの仕組みが赤を作っていない）", bad === 0, why.join(" ／ "));
}

// 反証
for (const c of COUNTERS) {
  const m = await mutant(c.edits);
  if (!m.IC) {
    check(`反証 ${c.id}（${c.what}）→ 赤になる`, false, m.why);
    continue;
  }
  const reds: string[] = [];
  let threwOnly = true;
  for (const k of c.expect) {
    const r = run(CHECKS[k][1], m.IC, { ...ctx, dir: m.dir });
    if (r.bad.length) {
      reds.push(`${CHECKS[k][0].slice(0, 6)} ${r.bad[0]}`);
      if (!r.threw) threwOnly = false;
    }
  }
  const okRed = reds.length > 0 && !threwOnly;
  check(`反証 ${c.id}（${c.what}）→ 赤になる`, okRed, reds.length ? `例外でしか落ちない: ${reds[0]}` : "緑のまま（検査が効いていない）");
  if (okRed) console.log(`  反証 ${c.id} → 赤: ${reds[0].slice(0, 150)}`);
}

console.log(`\nv179_smoke: pass=${pass} fail=${fail}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
process.exit(fail ? 1 : 0);
