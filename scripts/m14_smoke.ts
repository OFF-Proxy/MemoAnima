// M14: 囲い塗り（S-2）の回帰スモーク（引数不要: npx tsx scripts/m14_smoke.ts）
//
// 囲い塗りの実装は「自由選択のマスク生成（lassoMask=多角形→走査線）＋ A-3 の塗り込み
// （トーン対応・toneAt 判定つき書き込み）」の合成。ここでは合成の素になる不変条件を固定する:
//   1. lassoMask が閉じた多角形の内側だけを 1 にする（始点終点は自動で結ばれる）
//   2. トーン塗りが**バケツと同座標で同柄**（floodFill と mask-fill が全画素一致）
//   3. 選択範囲クリップ（selMask 外は 1 ドットも塗らない）
//   4. 極小の囲い（数px）は塗る面積が ENCLOSE_MIN_PX 未満（＝呼び出し側が何もしない）
//   5. 索引の置き換えのみ（中間色を作らない＝使用索引が {元の色, 現在色} に収まる）
import { W, H, PIXELS, type IndexBuf } from "../src/editor/model";
import { lassoMask, floodFill, toneAt, toneById, rectMask } from "../src/editor/raster";

const ENCLOSE_MIN_PX = 8; // editor.ts の同名定数と一致させる

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " " + detail : ""}`);
  }
}
const popcount = (m: Uint8Array) => {
  let c = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) c++;
  return c;
};

// ---- 1. lassoMask が閉じた多角形の内側を塗る ----
{
  // 中心(160,120) の菱形（半径40）。始点終点は lassoMask 内で自動的に結ばれる
  const pts = [
    { x: 160, y: 80 },
    { x: 200, y: 120 },
    { x: 160, y: 160 },
    { x: 120, y: 120 },
  ];
  const m = lassoMask(pts);
  check("1: 内側の中心は選ばれる", m[120 * W + 160] === 1);
  check("1: 外側（隅）は選ばれない", m[0] === 0 && m[PIXELS - 1] === 0);
  check("1: 面積がそれなりにある", popcount(m) > 1000);
}

// ---- 2. トーン塗りがバケツ（floodFill）と全画素一致（＝同座標で同柄） ----
{
  const tile = toneById("dot-grid-l")?.tile ?? null;
  check("2(前提): トーン tile がある", !!tile);
  const color = 5;
  // (a) バケツ: 空バッファ全域を tone 付きで flood
  const a: IndexBuf = new Uint8Array(PIXELS);
  floodFill(a, 10, 10, color, tile, undefined, undefined);
  // (b) 囲い塗りの塗り込み経路（mask=全域・toneAt 判定つき書き込み）
  const b: IndexBuf = new Uint8Array(PIXELS);
  for (let i = 0; i < PIXELS; i++) {
    const x = i % W;
    const y = (i / W) | 0;
    if (!tile || toneAt(tile, x, y)) b[i] = color;
  }
  let same = true;
  for (let i = 0; i < PIXELS; i++)
    if (a[i] !== b[i]) {
      same = false;
      break;
    }
  check("2: 囲い塗りのトーンがバケツと全画素一致（同座標で同柄）", same);
}

// ---- 3. 選択範囲クリップ（selMask 外は塗らない） ----
{
  const pts = [
    { x: 160, y: 60 },
    { x: 240, y: 120 },
    { x: 160, y: 180 },
    { x: 80, y: 120 },
  ];
  const mask = lassoMask(pts);
  const sel = rectMask(160, 0, 319, 239); // 右半分だけ選択
  for (let i = 0; i < PIXELS; i++) if (!sel[i]) mask[i] = 0;
  // 左内側（x=120）は消え、右内側（x=200）は残る
  check("3: 選択範囲の外（左内側）は塗られない", mask[120 * W + 120] === 0);
  check("3: 選択範囲の中（右内側）は塗られる", mask[120 * W + 200] === 1);
}

// ---- 4. 極小の囲いは面積が ENCLOSE_MIN_PX 未満 ----
{
  const tiny = lassoMask([
    { x: 100, y: 100 },
    { x: 101, y: 100 },
    { x: 100, y: 101 },
  ]);
  check("4: 数px の極小囲いは塗る面積が ENCLOSE_MIN_PX 未満（＝何もしない）", popcount(tiny) < ENCLOSE_MIN_PX);
}

// ---- 5. 索引の置き換えのみ（中間色を作らない） ----
{
  const buf: IndexBuf = new Uint8Array(PIXELS).fill(2); // 元の色=2
  const color = 7;
  const mask = lassoMask([
    { x: 160, y: 80 },
    { x: 200, y: 120 },
    { x: 160, y: 160 },
    { x: 120, y: 120 },
  ]);
  for (let i = 0; i < PIXELS; i++) if (mask[i]) buf[i] = color; // ベタ（tone なし）
  const used = new Set<number>();
  for (let i = 0; i < PIXELS; i++) used.add(buf[i]);
  const ok = [...used].every((v) => v === 2 || v === 7);
  check("5: 使用索引が {元の色, 現在色} に収まる（中間色なし）", ok, `used=${[...used].join(",")}`);
}

console.log(`m14 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
