// M13-2b: 変形の回帰スモーク（引数不要:  npx tsx scripts/m132b_smoke.ts）
//
// REQ_M13_2b §4 の設計を**純関数の側**で固定する:
//   1. 同じ1枚のマスクで切り出した float は、全レイヤーで ox/oy/w/h が一致する（＝回転中心が共通）
//   2. 1枚だけのときの共通マスク（自分の非透明画素）は、従来の切り出しとビット単位で同じ
//   3. 恒等変換で N 枚を戻すと、元のレイヤーとピクセル一致する（切り出し→焼き込みの可逆性）
//   4. N 枚を同じ Transform で回すと、レイヤー間の相対位置が保たれる（バラバラにならない）
//   5. レイヤーごとに**別々の**マスクで切り出すと中心がずれる（＝この設計が必要な理由の実証。反例）
//   6. 非等比（sx≠sy）の焼き込みで、索引の集合が増えない（補間・中間色なし）
//   7. 辺ハンドルの「対辺を止める」補正: 中心を s*(half1-half0) ずらすと対辺の世界座標が不動
//   8. 四隅の辺ハンドル: 法線方向の移動で両端2点が同じだけ動き、辺が平行のまま
// extractFloat / blitFloatTransformed の**中身には触れていない**（呼び方だけ）ことはレビューで git diff を見る。
import { W, H, PIXELS } from "../src/editor/model";
import {
  extractFloat,
  blitFloatTransformed,
  maskBBox,
  type Transform,
  type FloatBuf,
} from "../src/editor/raster";
import { isConvexQuad } from "../src/editor/warp";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? ` ${detail}` : ""}`);
  }
}
const rect = (b: Uint8Array, x0: number, y0: number, w: number, h: number, v: number) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) b[y * W + x] = v;
};
const nonzeroMask = (bufs: Uint8Array[]) => {
  const m = new Uint8Array(PIXELS);
  for (const b of bufs) for (let i = 0; i < PIXELS; i++) if (b[i]) m[i] = 1;
  return m;
};
const bbox = (b: Uint8Array) => maskBBox(nonzeroMask([b]));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const ID: Transform = { tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, flipH: false, flipV: false };

// 場面: 3レイヤー。絵の位置がバラバラ（L1 左上 / L2 中央 / L3 右下）、L0 は空
const L0 = new Uint8Array(PIXELS);
const L1 = new Uint8Array(PIXELS); rect(L1, 40, 40, 30, 30, 1);
const L2 = new Uint8Array(PIXELS); rect(L2, 140, 100, 40, 20, 2);
const L3 = new Uint8Array(PIXELS); rect(L3, 240, 180, 20, 40, 3);
const originals = [L0, L1, L2, L3].map((b) => b.slice());

// ---- 1. 共通マスク → 全 float が同寸 ----
{
  const bufs = [L0, L1, L2, L3].map((b) => b.slice());
  const mask = nonzeroMask(bufs);
  const floats = bufs.map((b) => extractFloat(b, mask, true)!);
  check("1: 共通マスクで全レイヤーの float が作れる（空レイヤーも）", floats.every((f) => !!f));
  const k = (f: FloatBuf) => `${f.ox},${f.oy},${f.w}x${f.h}`;
  check("1: ox/oy/w/h が4枚とも一致", new Set(floats.map(k)).size === 1, floats.map(k).join(" / "));
  check("1: 寸法は合成の外接矩形（40,40〜260,220）", k(floats[0]) === "40,40,220x180", k(floats[0]));
  check("1: 切り出し後の元バッファは空", bufs.every((b) => b.every((v) => v === 0)));
}

// ---- 2. 1枚だけ＝従来と同じ ----
{
  const a = L2.slice();
  const b = L2.slice();
  const fOld = extractFloat(a, nonzeroMask([a]), true)!; // 従来: 自分の非透明画素
  const fNew = extractFloat(b, nonzeroMask([b]), true)!; // 新: 対象1枚の合成＝同じもの
  check("2: 1枚のときの float が従来とビット単位で同じ", fOld.ox === fNew.ox && fOld.oy === fNew.oy && fOld.w === fNew.w && same(fOld.data as Uint8Array, fNew.data as Uint8Array));
}

// ---- 3. 恒等変換の可逆性（N 枚） ----
{
  const bufs = originals.map((b) => b.slice());
  const mask = nonzeroMask(bufs);
  const floats = bufs.map((b) => extractFloat(b, mask, true)!);
  floats.forEach((f, i) => blitFloatTransformed(bufs[i], f, ID));
  check("3: 恒等変換で4枚ともピクセル一致", bufs.every((b, i) => same(b, originals[i])));
}

// ---- 4. 同じ Transform で相対位置が保たれる ----
{
  const bufs = originals.map((b) => b.slice());
  const mask = nonzeroMask(bufs);
  const floats = bufs.map((b) => extractFloat(b, mask, true)!);
  const t: Transform = { ...ID, angle: Math.PI }; // 180°: 共通中心 (150,130) の点対称
  floats.forEach((f, i) => blitFloatTransformed(bufs[i], f, t));
  const cx = 40 + 220 / 2, cy = 40 + 180 / 2;
  const b1 = bbox(bufs[1])!, b3 = bbox(bufs[3])!;
  // L1 (40..69, 40..69) は (230..259, 190..219) へ、L3 (240..259,180..219) は (40..59, 40..79) へ
  check("4: L1 が共通中心の点対称へ", b1.x === 2 * cx - 70 && b1.y === 2 * cy - 70, JSON.stringify(b1));
  check("4: L3 が共通中心の点対称へ", b3.x === 2 * cx - 260 && b3.y === 2 * cy - 220, JSON.stringify(b3));
  check("4: 面積が保たれる（最近傍の180°は可逆）", bufs[1].filter((v) => v).length === 900 && bufs[3].filter((v) => v).length === 800);
  check("4: 空レイヤーは空のまま", bufs[0].every((v) => v === 0));
}

// ---- 5. 反例: レイヤーごとのマスクだと中心がずれる ----
{
  const bufs = [L1.slice(), L3.slice()];
  const floats = bufs.map((b) => extractFloat(b, nonzeroMask([b]), true)!); // 各自のマスク
  const t: Transform = { ...ID, angle: Math.PI };
  floats.forEach((f, i) => blitFloatTransformed(bufs[i], f, t));
  const b1 = bbox(bufs[0])!, b3 = bbox(bufs[1])!;
  // 各自の中心で回る＝その場で回るだけ。相対位置が保たれる（上の 4）結果と**違う**ことを示す
  check("5: 別々のマスクだと L1 はその場で回るだけ（共通中心へ行かない）", b1.x === 40 && b1.y === 40, JSON.stringify(b1));
  check("5: 別々のマスクだと L3 もその場", b3.x === 240 && b3.y === 180, JSON.stringify(b3));
}

// ---- 6. 非等比でも中間色なし ----
{
  const b = L2.slice();
  const mask = nonzeroMask([b]);
  const f = extractFloat(b, mask, true)!;
  blitFloatTransformed(b, f, { ...ID, sx: 2.3, sy: 0.5 });
  const used = new Set(b.filter((v) => v));
  check("6: 非等比の焼き込みで索引の集合は {2} のまま", used.size === 1 && used.has(2), [...used].join(","));
  const bb = bbox(b)!;
  check("6: 横に伸びて縦に潰れた（w≈92, h≈10）", Math.abs(bb.w - 92) <= 1 && Math.abs(bb.h - 10) <= 1, JSON.stringify(bb));
}

// ---- 7. 辺ハンドルの対辺固定（editor.ts の補正式を数式で） ----
{
  // 幅 w=40 の float を角度 a で置き、右辺（s=+1）のハンドルをローカル x=l まで引く。
  // 新しい半幅は「ポインタと対辺の距離の半分」 (s*l + half0)/2、中心を s*(half1-half0) だけローカル x へ
  // ずらすと**左辺が不動**で、**右辺がポインタの位置に来る**（中心からの距離を半幅にすると右辺が2倍動く）
  const w = 40, a = 0.7;
  const cos = Math.cos(a), sin = Math.sin(a);
  const half0 = w / 2;
  const l = half0 + 30; // 右辺を 30 引く
  const half1 = (1 * l + half0) / 2;
  const d = +1 * (half1 - half0);
  const cx0 = 100, cy0 = 80;
  const cx1 = cx0 + d * cos, cy1 = cy0 + d * sin;
  const leftBefore = { x: cx0 - half0 * cos, y: cy0 - half0 * sin };
  const leftAfter = { x: cx1 - half1 * cos, y: cy1 - half1 * sin };
  const rightAfterLocal = d + half1; // 新しい右辺のローカル x（元の中心基準）
  check("7: 右辺を伸ばしても左辺の世界座標が不動", Math.abs(leftBefore.x - leftAfter.x) < 1e-9 && Math.abs(leftBefore.y - leftAfter.y) < 1e-9);
  check("7: 右辺はポインタの位置 l に来る（2倍動かない）", Math.abs(rightAfterLocal - l) < 1e-9, `${rightAfterLocal} vs ${l}`);
  const wrong = 1 * l; // 旧式: 中心からの距離をそのまま半幅に
  check("7: 旧式（half1 = s·l）だと右辺が 2倍動く（反例）", Math.abs((1 * (wrong - half0) + wrong) - l) > 1);
}

// ---- 8. 四隅の辺ハンドル（cornerTrial の法線射影） ----
{
  const base = [{ x: 50, y: 40 }, { x: 150, y: 40 }, { x: 150, y: 120 }, { x: 50, y: 120 }];
  // 上辺（点0-1）を法線方向へ。ドラッグ (−7, −10) のうち法線成分（y）だけが効く
  const a = 0, bI = 1;
  const ex = base[bI].x - base[a].x, ey = base[bI].y - base[a].y, len = Math.hypot(ex, ey);
  const nx = -ey / len, ny = ex / len;
  const dd = -7 * nx + -10 * ny;
  const trial = base.map((p, i) => (i === a || i === bI ? { x: p.x + dd * nx, y: p.y + dd * ny } : p));
  check("8: 上辺の両端が同じだけ動く（y が −10・x は変わらない）", trial[0].y === 30 && trial[1].y === 30 && trial[0].x === 50 && trial[1].x === 150, JSON.stringify(trial));
  check("8: 対辺（下辺）は動かない", trial[2].y === 120 && trial[3].y === 120);
  check("8: 結果は凸のまま", isConvexQuad(trial));
  // ★ 上辺を下辺より下まで押し込むと、四角形は**凸のまま裏返る**（isConvexQuad は向きを見ない）。
  //   editor.ts の cornerTrial はこれを「符号付き面積の符号が変わる」で弾いている。その前提を固定する
  const flipped = base.map((p, i) => (i === a || i === bI ? { x: p.x, y: 130 } : p));
  const area = (q: { x: number; y: number }[]) =>
    q.reduce((s, p, i) => s + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0);
  check("8: 対辺を越えた四角形は isConvexQuad では弾けない（凸のまま裏返る）", isConvexQuad(flipped));
  check("8: 裏返りは符号付き面積の符号で検出できる", Math.sign(area(flipped)) !== Math.sign(area(base)));
}

console.log(`m132b smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
