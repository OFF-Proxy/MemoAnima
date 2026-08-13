// M10-22 スモーク: 選択範囲クリップ（PenOptions.clip / floodFill clip / stampMask clip）
// 使い方: npx tsx scripts/m22_smoke.ts   （引数不要・実データ不要）
//
// 検証の柱:
//  1) clip 未指定と clip=全1 が**全描画関数で1画素も違わない**（クリップが純粋なゲートである証明。
//     未指定経路の回帰は m19 の独立BFS比較・mcp スモークが併走で担保）
//  2) 直接書き込み系（stamp/strokeSegment/shapeRect/shapeEllipse/stampMask）は
//     「clip あり出力 = clip 内は clip なし出力・clip 外は元のまま」の恒等式を全画素で満たす
//  3) floodFill は clip=0 を**壁**として扱う（連結が変わるので 2) の恒等式ではなく、
//     壁つき独立BFS実装との一致で検証。ref あり/なし・トーンあり/なし）
//  4) 比較器はミュータント（1画素改変）を検出できることを自己証明

import { W, H, PIXELS } from "../src/editor/model";
import type { IndexBuf } from "../src/editor/model";
import {
  stamp,
  strokeSegment,
  shapeRect,
  shapeEllipse,
  shapeLine,
  floodFill,
  stampMask,
  toneAt,
  TONE_TILES,
  type PenOptions,
} from "../src/editor/raster";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}

const eq = (a: IndexBuf | Uint8Array, b: IndexBuf | Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 決定的な下地（疎な値集合） */
function basePattern(seedK: number): Uint8Array {
  const b = new Uint8Array(PIXELS);
  let seed = 777 + seedK * 131;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < PIXELS; i++) b[i] = rnd() < 0.5 ? 0 : rnd() < 0.5 ? 2 : 7;
  return b;
}

/** クリップ: 左半分＋中央に横穴（連結テスト用） */
function halfClip(): Uint8Array {
  const c = new Uint8Array(PIXELS);
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) c[y * W + x] = 1;
  return c;
}
const allOnes = () => new Uint8Array(PIXELS).fill(1);

const tone = TONE_TILES.find((t) => t.id !== "solid" && t.tile)!;
const mkOpts = (over: Partial<PenOptions> = {}): PenOptions => ({
  size: 5,
  color: 9,
  texture: "solid",
  seed: 4242,
  ...over,
});

// ---------- 1) clip 未指定 ＝ clip=全1（全描画関数） ----------
{
  type Case = { name: string; run: (buf: IndexBuf, clip?: Uint8Array) => void };
  const cases: Case[] = [
    { name: "stamp solid", run: (b, c) => stamp(b, 100, 100, mkOpts({ clip: c })) },
    { name: "stamp size2", run: (b, c) => stamp(b, 100, 100, mkOpts({ size: 2, clip: c })) },
    { name: "stamp rough", run: (b, c) => stamp(b, 60, 60, mkOpts({ texture: "rough", clip: c })) },
    { name: "stamp spray", run: (b, c) => stamp(b, 60, 60, mkOpts({ texture: "spray", clip: c })) },
    { name: "stamp tone", run: (b, c) => stamp(b, 80, 80, mkOpts({ tone: tone.tile, clip: c })) },
    {
      name: "strokeSegment dot",
      run: (b, c) =>
        strokeSegment(b, 10, 10, 300, 200, mkOpts({ texture: "dot", dashAcc: { d: 0 }, clip: c })),
    },
    { name: "shapeLine", run: (b, c) => shapeLine(b, 5, 5, 310, 230, mkOpts({ clip: c })) },
    { name: "shapeRect fill", run: (b, c) => shapeRect(b, 40, 40, 280, 200, mkOpts({ clip: c }), true) },
    { name: "shapeRect outline", run: (b, c) => shapeRect(b, 40, 40, 280, 200, mkOpts({ clip: c }), false) },
    { name: "shapeEllipse fill", run: (b, c) => shapeEllipse(b, 40, 40, 280, 200, mkOpts({ clip: c }), true) },
    { name: "shapeEllipse outline", run: (b, c) => shapeEllipse(b, 40, 40, 280, 200, mkOpts({ clip: c }), false) },
    { name: "floodFill ベタ", run: (b, c) => floodFill(b, 160, 120, 9, null, undefined, c) },
    { name: "floodFill トーン", run: (b, c) => floodFill(b, 160, 120, 9, tone.tile, undefined, c) },
    {
      name: "floodFill ref",
      run: (b, c) => floodFill(b, 160, 120, 9, null, basePattern(3), c),
    },
    {
      name: "stampMask",
      run: (b, c) => {
        const m = { w: 60, h: 40, data: new Uint8Array(60 * 40) };
        for (let i = 0; i < m.data.length; i += 3) m.data[i] = 1;
        stampMask(b, m, 150, 110, 9, c);
      },
    },
  ];
  for (const cs of cases) {
    const a = basePattern(1);
    const b = basePattern(1);
    cs.run(a, undefined);
    cs.run(b, allOnes());
    check(`未指定=全1: ${cs.name}`, eq(a, b));
  }
  // 比較器の自己証明
  const p = basePattern(1);
  const q = p.slice();
  q[54321] = (q[54321] + 1) % 8;
  check("比較器はミュータント（1画素差）を検出する", !eq(p, q));
}

// ---------- 2) 直接書き込み系の恒等式: clip内=なし出力 / clip外=元のまま ----------
{
  const clip = halfClip();
  type Case = { name: string; run: (buf: IndexBuf, clip?: Uint8Array) => void };
  const cases: Case[] = [
    { name: "stamp（境界跨ぎ）", run: (b, c) => stamp(b, 158, 120, mkOpts({ size: 12, clip: c })) },
    { name: "stamp tone（境界跨ぎ）", run: (b, c) => stamp(b, 158, 120, mkOpts({ size: 12, tone: tone.tile, clip: c })) },
    { name: "strokeSegment（横断）", run: (b, c) => strokeSegment(b, 20, 120, 300, 120, mkOpts({ clip: c })) },
    { name: "shapeRect fill（跨ぎ）", run: (b, c) => shapeRect(b, 100, 60, 260, 180, mkOpts({ clip: c }), true) },
    { name: "shapeRect outline（跨ぎ）", run: (b, c) => shapeRect(b, 100, 60, 260, 180, mkOpts({ clip: c }), false) },
    { name: "shapeEllipse fill（跨ぎ）", run: (b, c) => shapeEllipse(b, 100, 60, 260, 180, mkOpts({ clip: c }), true) },
    { name: "shapeEllipse outline（跨ぎ）", run: (b, c) => shapeEllipse(b, 100, 60, 260, 180, mkOpts({ clip: c }), false) },
    {
      name: "stampMask（跨ぎ）",
      run: (b, c) => {
        const m = { w: 80, h: 30, data: new Uint8Array(80 * 30).fill(1) };
        stampMask(b, m, 130, 110, 9, c);
      },
    },
  ];
  for (const cs of cases) {
    const before = basePattern(2);
    const noClip = before.slice();
    const withClip = before.slice();
    cs.run(noClip, undefined);
    cs.run(withClip, clip);
    let ok = true;
    for (let i = 0; i < PIXELS; i++) {
      const want = clip[i] ? noClip[i] : before[i];
      if (withClip[i] !== want) {
        ok = false;
        break;
      }
    }
    check(`恒等式: ${cs.name}`, ok);
  }
}

// ---------- 3) floodFill: clip=0 は壁（壁つき独立BFSと一致） ----------
{
  /** 独立参照実装: 壁つき素朴BFS（判定元 src・塗り先 dst） */
  const naiveFillClip = (
    dst: Uint8Array,
    src: Uint8Array,
    sx: number,
    sy: number,
    color: number,
    clip: Uint8Array | null,
    paintSameColor: boolean
  ) => {
    if (clip && !clip[sy * W + sx]) return;
    const target = src[sy * W + sx];
    if (!paintSameColor && target === color) return;
    const seen = new Uint8Array(PIXELS);
    const q = [sy * W + sx];
    seen[sy * W + sx] = 1;
    while (q.length) {
      const i = q.shift()!;
      dst[i] = color;
      const x = i % W;
      const y = (i / W) | 0;
      for (const [dx2, dy2] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx2;
        const ny = y + dy2;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (seen[ni] || src[ni] !== target) continue;
        if (clip && !clip[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
  };

  const clip = halfClip();
  // 3a: ref なし — 左右をつなぐ一様領域に左側から流す → clip 内だけ塗られる
  {
    const base = new Uint8Array(PIXELS); // 全0の一枚岩領域
    const a = base.slice();
    floodFill(a, 50, 120, 9, null, undefined, clip);
    const b = base.slice();
    naiveFillClip(b, base, 50, 120, 9, clip, false);
    check("floodFill(clip・refなし) ＝ 壁つきBFS", eq(a, b));
    check("clip 外は 1 画素も塗られていない", a.every((v, i) => (clip[i] ? true : v === 0)));
  }
  // 3b: 種が clip 外 → 何もしない
  {
    const a = basePattern(4);
    const before = a.slice();
    floodFill(a, 300, 120, 9, null, undefined, clip);
    check("種が clip 外なら何もしない", eq(a, before));
  }
  // 3c: ref あり — 参照の一様領域を clip 壁で分断
  {
    const ref = new Uint8Array(PIXELS); // ref 全0＝全面が同添字
    const a = new Uint8Array(PIXELS);
    floodFill(a, 50, 120, 6, null, ref, clip);
    const b = new Uint8Array(PIXELS);
    naiveFillClip(b, ref, 50, 120, 6, clip, true); // ref経路は同色早期returnなし
    check("floodFill(clip・refあり) ＝ 壁つきBFS", eq(a, b));
  }
  // 3d: トーン × clip — 領域は壁つき・塗るのはトーンtrueのみ
  {
    const base = new Uint8Array(PIXELS);
    const a = base.slice();
    floodFill(a, 50, 120, 9, tone.tile, undefined, clip);
    let ok = true;
    for (let y = 0; y < H && ok; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inRegion = clip[i] === 1; // 一枚岩なので領域=クリップ内全体
        const want = inRegion && toneAt(tone.tile!, x, y) ? 9 : 0;
        if (a[i] !== want) {
          ok = false;
          break;
        }
      }
    check("floodFill(clip×トーン): 壁内×トーンtrueのみ塗る", ok);
  }
}

// ---------- 4) M11-12: stampMask がキャンバス外へはみ出しても絵を壊さない ----------
// textToMask のクランプを外したので、マスクは 320×240 より大きくなり、dx/dy には負の値も来る。
// 「重なった画素だけが期待どおりに変わり、それ以外は1画素も変わらない」ことを、
// 独立実装（総当たり）との一致で確かめる。
{
  /** 参照実装: マスクの全画素を見て、キャンバス内に入るものだけ書く（境界の書き方を変えた別実装） */
  const naiveStamp = (
    buf: IndexBuf,
    mask: { w: number; h: number; data: Uint8Array },
    dx: number,
    dy: number,
    color: number,
    clip?: Uint8Array
  ) => {
    for (let y = 0; y < mask.h; y++)
      for (let x = 0; x < mask.w; x++) {
        if (!mask.data[y * mask.w + x]) continue;
        const tx = dx + x;
        const ty = dy + y;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if (clip && !clip[ty * W + tx]) continue;
        buf[ty * W + tx] = color;
      }
  };
  /** 決定的な市松＋斜線のマスク（全1でも全0でもない） */
  const mkMask = (w: number, h: number) => {
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data[y * w + x] = (x * 7 + y * 3) % 5 === 0 || x === y ? 1 : 0;
    return { w, h, data };
  };
  const cases: { name: string; w: number; h: number; dx: number; dy: number }[] = [
    { name: "左上へ大きくはみ出す（負の座標）", w: 400, h: 300, dx: -350, dy: -260 },
    { name: "右下へはみ出す", w: 400, h: 300, dx: 300, dy: 220 },
    { name: "キャンバスより大きいマスクが全面を覆う", w: 900, h: 700, dx: -290, dy: -230 },
    { name: "完全に画面外（左）", w: 100, h: 60, dx: -101, dy: 50 },
    { name: "完全に画面外（右）", w: 100, h: 60, dx: W, dy: 50 },
    { name: "完全に画面外（上）", w: 100, h: 60, dx: 40, dy: -60 },
    { name: "完全に画面外（下）", w: 100, h: 60, dx: 40, dy: H },
    { name: "1画素だけ重なる（左上隅）", w: 100, h: 60, dx: -99, dy: -59 },
    { name: "1画素だけ重なる（右下隅）", w: 100, h: 60, dx: W - 1, dy: H - 1 },
    { name: "画面内（従来どおり）", w: 60, h: 40, dx: 130, dy: 100 },
  ];
  const clip4 = halfClip();
  for (const cs of cases) {
    const mask = mkMask(cs.w, cs.h);
    for (const withClip of [false, true]) {
      const a = basePattern(5);
      const b = basePattern(5);
      stampMask(a, mask, cs.dx, cs.dy, 9, withClip ? clip4 : undefined);
      naiveStamp(b, mask, cs.dx, cs.dy, 9, withClip ? clip4 : undefined);
      check(`はみ出し${withClip ? "（clipあり）" : ""}: ${cs.name}`, eq(a, b));
    }
    // 完全に画面外なら1画素も変わらない
    if (cs.dx + cs.w <= 0 || cs.dy + cs.h <= 0 || cs.dx >= W || cs.dy >= H) {
      const a = basePattern(5);
      const before = a.slice();
      stampMask(a, mask, cs.dx, cs.dy, 9, undefined);
      check(`完全に画面外は1画素も変えない: ${cs.name}`, eq(a, before));
    }
  }
  // バッファ長が変わらない（範囲外へ書いて Uint8Array/Uint16Array を伸ばしていない）
  {
    const a = basePattern(5);
    stampMask(a, mkMask(2000, 1500), -1000, -700, 9);
    check("stampMask 後もバッファ長は 320×240 のまま", a.length === PIXELS);
  }
}

console.log(`m22 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
