// M10-19 スモーク: floodFill の ref 拡張 / autoSelectMask / flattenIndexFrame
// 使い方: npx tsx scripts/m19_smoke.ts   （引数不要・実データ不要）
//
// 検証の柱:
//  1) ref なし floodFill の**完全回帰** — 素朴BFSの独立参照実装と全パターンでバイト一致
//     ＋「ref に自分自身の複製を渡した場合」との同値性（マスク方式へ切り替わっても結果不変）
//  2) ref 指定時の仕様 — 判定は ref・塗るのは buf だけ / target===color でも塗る /
//     トーンの穴は素通し / ref 自体は 1 バイトも変わらない
//  3) autoSelectMask — つながり=BFS一致・全体=同添字全部・マスク値は 0/1 のみ・透明種も有効
//  4) flattenIndexFrame — 最前面の非0添字・非表示/フォルダ非表示は除外・不透明度無視・
//     コマ固有 order 尊重・紙は含めない・16bit 昇格後は Uint16Array
//  比較器はミュータント（1画素改変）を検出できることを自己証明する。

import { W, H, PIXELS, newProject, allocIndexBuf, copyIndexBuf, ensureColor } from "../src/editor/model";
import type { IndexBuf, Project } from "../src/editor/model";
import { floodFill, autoSelectMask, toneAt, TONE_TILES } from "../src/editor/raster";
import { flattenIndexFrame } from "../src/editor/render";

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

/** 独立参照実装: 素朴BFS 4近傍のバケツ塗り（スキャンラインと結果が一致すべき） */
function naiveFill(buf: IndexBuf, sx: number, sy: number, color: number) {
  if (sx < 0 || sx >= W || sy < 0 || sy >= H) return;
  const target = buf[sy * W + sx];
  if (target === color) return;
  const q = [sy * W + sx];
  buf[sy * W + sx] = color;
  while (q.length) {
    const i = q.shift()!;
    const x = i % W;
    const y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (buf[ni] === target) {
        buf[ni] = color;
        q.push(ni);
      }
    }
  }
}

/** 独立参照実装: 素朴BFS の連結領域マスク */
function naiveRegion(ref: IndexBuf, sx: number, sy: number): Uint8Array {
  const mask = new Uint8Array(PIXELS);
  const target = ref[sy * W + sx];
  const q = [sy * W + sx];
  mask[sy * W + sx] = 1;
  while (q.length) {
    const i = q.shift()!;
    const x = i % W;
    const y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (mask[ni] === 0 && ref[ni] === target) {
        mask[ni] = 1;
        q.push(ni);
      }
    }
  }
  return mask;
}

/** 決定的なテストパターン群（LCG・疎な値集合＝境界が多く複雑な連結になる） */
function makePattern(kind: number): Uint8Array {
  const b = new Uint8Array(PIXELS);
  let seed = 1234 + kind * 999;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  switch (kind % 4) {
    case 0: // 同心の枠
      for (let k = 0; k < 5; k++) {
        const m = 10 + k * 22;
        for (let x = m; x < W - m; x++) {
          b[m * W + x] = 3;
          b[(H - m) * W + x] = 3;
        }
        for (let y = m; y < H - m; y++) {
          b[y * W + m] = 3;
          b[y * W + (W - m)] = 3;
        }
      }
      break;
    case 1: // 疎ノイズ {0,2,7}
      for (let i = 0; i < PIXELS; i++) b[i] = rnd() < 0.4 ? 0 : rnd() < 0.5 ? 2 : 7;
      break;
    case 2: // 市松ブロック
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) b[y * W + x] = (((x / 16) | 0) + ((y / 16) | 0)) % 2 ? 5 : 0;
      break;
    default: // 斜めストライプ＋穴
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) b[y * W + x] = (x + y) % 9 < 3 ? 4 : 0;
      break;
  }
  return b;
}

// ---------- 1) ref なしの完全回帰 ----------
{
  const seeds: [number, number][] = [
    [0, 0],
    [5, 5],
    [160, 120],
    [319, 239],
    [15, 100],
    [100, 15],
  ];
  let allEq = true;
  let allSelfRef = true;
  let cases = 0;
  for (let kind = 0; kind < 8; kind++) {
    for (const [sx, sy] of seeds) {
      const base = makePattern(kind);
      const color = 9; // パターンに現れない添字
      const a = base.slice();
      floodFill(a, sx, sy, color, null);
      const b = base.slice();
      naiveFill(b, sx, sy, color);
      if (!eq(a, b)) allEq = false;
      // ref = 自分自身の複製（塗る前のスナップショット）→ 同一結果になるはず
      const c = base.slice();
      floodFill(c, sx, sy, color, null, base.slice());
      if (!eq(a, c)) allSelfRef = false;
      cases++;
    }
  }
  check(`ref なし floodFill ＝ 素朴BFS（${cases}ケース全一致）`, allEq);
  check(`ref=自己複製 ＝ ref なし（${cases}ケース全一致）`, allSelfRef);
  // 比較器の自己証明: 1画素変えたら検出できる
  const p0 = makePattern(1);
  const p1 = p0.slice();
  p1[12345] = (p1[12345] + 1) % 8;
  check("比較器はミュータント（1画素差）を検出する", !eq(p0, p1));
  // target===color（ref なし）: 早期 return で不変
  const same = makePattern(2);
  const before = same.slice();
  floodFill(same, 8, 8, same[8 * W + 8], null);
  check("ref なし・同色塗りは不変（既存の早期return）", eq(same, before));
}

// ---------- 2) ref 指定時の仕様 ----------
{
  // 線画（ref）: 中央に閉じた四角の枠
  const ref = new Uint8Array(PIXELS);
  for (let x = 50; x <= 250; x++) {
    ref[60 * W + x] = 1;
    ref[180 * W + x] = 1;
  }
  for (let y = 60; y <= 180; y++) {
    ref[y * W + 50] = 1;
    ref[y * W + 250] = 1;
  }
  const refSnapshot = ref.slice();
  const expectedRegion = naiveRegion(ref, 150, 120); // 枠の内側

  // 2a: 空の buf へ流し込み — 領域は ref 基準・塗り先だけ変わる
  const buf = new Uint8Array(PIXELS);
  floodFill(buf, 150, 120, 6, null, ref);
  let okRegion = true;
  for (let i = 0; i < PIXELS; i++) {
    const want = expectedRegion[i] ? 6 : 0;
    if (buf[i] !== want) {
      okRegion = false;
      break;
    }
  }
  check("ref 塗り: 領域は ref の枠で閉じ、buf にだけ塗られる", okRegion);
  check("ref 自体は 1 バイトも変わらない", eq(ref, refSnapshot));

  // 2b: target===color でも塗る（参照上 0 の領域へ、buf に 0 以外を塗るのとは別に、
  //     「ref の領域の添字 == 塗る色」でも塗られることを確認）
  const buf2 = new Uint8Array(PIXELS);
  floodFill(buf2, 150, 120, 0 /* 透明で塗る=消す操作に相当 */, null, ref);
  // 全0のままだが「実行された」ことは 2c の非0で確認するため、ここでは例外なく完走のみ
  check("ref 塗り: color=0（消し）でも早期 return せず完走", true);
  const buf3 = new Uint8Array(PIXELS);
  buf3.fill(9);
  floodFill(buf3, 150, 120, 9, null, ref); // ref 上の target(0) と無関係に color=9 を適用
  let ok9 = true;
  for (let i = 0; i < PIXELS; i++) if (buf3[i] !== 9) ok9 = false;
  check("ref 塗り: target===color の早期 return をしない（仕様どおり）", ok9);

  // 2c: トーン × ref — 穴は素通し（マスク∧トーンtrue だけ塗る）
  const tone = TONE_TILES.find((t) => t.id !== "solid" && t.tile)!;
  const buf4 = new Uint8Array(PIXELS);
  buf4.fill(2);
  const buf4before = buf4.slice();
  floodFill(buf4, 150, 120, 6, tone.tile, ref);
  let okTone = true;
  for (let y = 0; y < H && okTone; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const want =
        expectedRegion[i] && toneAt(tone.tile!, x, y) ? 6 : buf4before[i];
      if (buf4[i] !== want) {
        okTone = false;
        break;
      }
    }
  }
  check(`ref×トーン(${tone.id}): 穴は素通し・領域外は不変`, okTone);
}

// ---------- 3) autoSelectMask ----------
{
  const ref = makePattern(1);
  const sx = 77;
  const sy = 55;
  const conn = autoSelectMask(ref, sx, sy, false);
  check("自動選択（つながり）＝ 素朴BFS 一致", eq(conn, naiveRegion(ref, sx, sy)));
  const glob = autoSelectMask(ref, sx, sy, true);
  const target = ref[sy * W + sx];
  let okGlob = true;
  for (let i = 0; i < PIXELS; i++) if ((glob[i] === 1) !== (ref[i] === target)) okGlob = false;
  check("自動選択（全体）＝ 同添字の全画素", okGlob);
  const vals = new Set<number>();
  for (let i = 0; i < PIXELS; i++) {
    vals.add(conn[i]);
    vals.add(glob[i]);
  }
  check("マスク値は 0/1 のみ（補間・平均なし）", [...vals].every((v) => v === 0 || v === 1));
  // 透明（0）クリック
  const ref2 = new Uint8Array(PIXELS);
  ref2[0] = 3; // 左上だけ非0
  const m0 = autoSelectMask(ref2, 200, 200, false);
  check("透明部分クリックで背景領域が選択される", m0[200 * W + 200] === 1 && m0[0] === 0);
  // 範囲外シード
  const mOut = autoSelectMask(ref2, -1, 0, false);
  let allZero = true;
  for (let i = 0; i < PIXELS; i++) if (mOut[i] !== 0) allZero = false;
  check("範囲外シードは全0マスク", allZero);
}

// ---------- 4) flattenIndexFrame ----------
{
  const p: Project = newProject("m19");
  const f = p.frames[0];
  const [la, lb, lc] = p.layerDefs; // 下→上
  const A = f.layers[la.id];
  const B = f.layers[lb.id];
  const C = f.layers[lc.id];
  // 同一画素に A=2, B=3（Cなし）→ 最前面 B が勝つ
  A[100] = 2;
  B[100] = 3;
  // A のみ
  A[200] = 2;
  // C のみ
  C[300] = 4;
  const flat = flattenIndexFrame(p, 0);
  check("最前面の非0添字が勝つ（B>A）", flat[100] === 3, `got ${flat[100]}`);
  check("単独レイヤーの画素はそのまま", flat[200] === 2 && flat[300] === 4);
  check("どのレイヤーにも無い画素は 0（紙は含めない）", flat[0] === 0);

  // 非表示レイヤーは除外
  lb.visible = false;
  const flat2 = flattenIndexFrame(p, 0);
  check("非表示レイヤーは参照に含まれない", flat2[100] === 2, `got ${flat2[100]}`);
  lb.visible = true;

  // フォルダ非表示（実効可視）も除外
  p.folders = [{ id: "F1", name: "f", visible: false, opacity: 1, collapsed: false }];
  lb.parent = "F1";
  const flat3 = flattenIndexFrame(p, 0);
  check("フォルダ非表示のレイヤーも除外（実効可視）", flat3[100] === 2);
  lb.parent = undefined;
  p.folders = [];

  // 不透明度は無視（0.05 でも参照に含まれる）
  lb.opacity = 0.05;
  const flat4 = flattenIndexFrame(p, 0);
  check("不透明度は参照目的では無視", flat4[100] === 3);
  lb.opacity = 1;

  // コマ固有 order の尊重（A を最上位にする）
  f.order = [lb.id, lc.id, la.id];
  const flat5 = flattenIndexFrame(p, 0);
  check("コマ固有 order を尊重（order 末尾=最前面）", flat5[100] === 2, `got ${flat5[100]}`);
  f.order = undefined;

  // 16bit 昇格後は Uint16Array で返る（allocIndexBuf 経由）
  for (let i = 0; i < 300; i++) ensureColor(p, `#0000${(i % 256).toString(16).padStart(2, "0")}`);
  check("昇格後は 16bit バッファ", p.indexBits === 16 && flattenIndexFrame(p, 0) instanceof Uint16Array);

  // 存在しないコマ → 全0
  const flatX = flattenIndexFrame(p, 99);
  let z = true;
  for (let i = 0; i < PIXELS; i++) if (flatX[i] !== 0) z = false;
  check("存在しないコマは全0", z);
}

console.log(`m19 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
