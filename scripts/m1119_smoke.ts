// M11-19 スモーク: 線を太らせる／細らせる（索引バッファの 1px モルフォロジー）の性質を pin する。
// - 3px→5px→3px の往復・1px 線の消滅・2色隣接の決定性と優先規則・画面端の規則・選択境界の規則・色集合不変
// - M11-8 の選択範囲用 expandMask / contractMask が**無改変**（参照実装とビット単位で一致）
// 実行: npx tsx scripts/m1119_smoke.ts（引数不要）
import { W, H, PIXELS } from "../src/editor/model";
import type { IndexBuf } from "../src/editor/model";
import * as R from "../src/editor/raster";
// M12-1c-2: 文言の pin が言語に左右されないよう ja に固定する（pin の文字列は変えていない）
import { setLang } from "../src/i18n";
setLang("ja");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}
const eq = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const at = (b: ArrayLike<number>, x: number, y: number) => b[y * W + x];
const mk = (bits: 8 | 16 = 8): IndexBuf => (bits === 16 ? new Uint16Array(PIXELS) : new Uint8Array(PIXELS));
const rect = (b: IndexBuf, x0: number, y0: number, x1: number, y1: number, v: number) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) b[y * W + x] = v;
};
const rowRun = (b: ArrayLike<number>, y: number, x0: number, x1: number) => {
  // y 行の x0..x1 で不透明の連続幅
  let n = 0;
  for (let x = x0; x <= x1; x++) if (b[y * W + x]) n++;
  return n;
};
const colRun = (b: ArrayLike<number>, x: number, y0: number, y1: number) => {
  let n = 0;
  for (let y = y0; y <= y1; y++) if (b[y * W + x]) n++;
  return n;
};
const values = (b: ArrayLike<number>) => {
  const s = new Set<number>();
  for (let i = 0; i < b.length; i++) if (b[i]) s.add(b[i]);
  return [...s].sort((a, b2) => a - b2).join(",");
};

// ---- ① 3px 横線 → 太らせる → 5px → 細らせる → 元とビット一致 ----
for (const bits of [8, 16] as const) {
  const src = mk(bits);
  rect(src, 40, 100, 240, 102, 1); // 3px 幅（y=100..102）
  const fat = mk(bits);
  const c1 = R.thickenIndex(src, fat, null);
  check(`①(${bits}bit) 3px→5px（縦の連続幅）`, colRun(fat, 100, 90, 110) === 5 && at(fat, 100, 99) === 1 && at(fat, 100, 103) === 1 && at(fat, 100, 98) === 0 && at(fat, 100, 104) === 0, `run=${colRun(fat, 100, 90, 110)}`);
  check(`①(${bits}bit) 端も 1px 伸びる（x=39・x=241）`, at(fat, 39, 101) === 1 && at(fat, 241, 101) === 1 && at(fat, 38, 101) === 0);
  check(`①(${bits}bit) 変化画素数 = 上下 2行×201 + 左右 2列×3 + 角4`, c1 === 2 * 201 + 2 * 3 + 4, `changed=${c1}`);
  const back = mk(bits);
  const c2 = R.thinIndex(fat, back, null);
  check(`①(${bits}bit) 太らせ→細らせ で元とビット一致（横線は往復で保存される）`, eq(back, src), `changed=${c2}`);
  check(`①(${bits}bit) 色集合は不変（1 だけ）`, values(fat) === "1" && values(back) === "1", values(fat));
}
// 角のある形（矩形）は往復で角が保存される（3×3 モルフォロジーは矩形を矩形に写す）
{
  const src = mk();
  rect(src, 100, 100, 130, 120, 3);
  const fat = mk(); R.thickenIndex(src, fat, null);
  const back = mk(); R.thinIndex(fat, back, null);
  check("① 矩形は往復でビット一致（角も保存）", eq(back, src));
  // 斜め線（1px・階段）も往復で元に戻る（3×3 のクロージングは 1px の斜め線を保存する）
  const diag = mk();
  for (let k = 0; k < 40; k++) diag[(100 + k) * W + (100 + k)] = 1;
  const dfat = mk(); R.thickenIndex(diag, dfat, null);
  const dback = mk(); R.thinIndex(dfat, dback, null);
  check("①(所感) 1px の斜め線も往復でビット一致（太らせは幅3の帯＝行方向に5画素・細らせで元へ）", eq(dback, diag) && rowRun(dfat, 120, 100, 140) === 5, `fatRow120=${rowRun(dfat, 120, 100, 140)} same=${eq(dback, diag)}`);
  // 2px 以下の隙間は往復で埋まる（クロージング）・3px の隙間は戻る（所感用に pin）
  const gap2 = mk(); rect(gap2, 50, 50, 60, 60, 1); rect(gap2, 63, 50, 70, 60, 1);
  const g2f = mk(); R.thickenIndex(gap2, g2f, null); const g2b = mk(); R.thinIndex(g2f, g2b, null);
  check("①(所感) 2px の隙間は往復で埋まる（x=61,62 が残る）", at(g2b, 61, 55) === 1 && at(g2b, 62, 55) === 1);
  const gap3 = mk(); rect(gap3, 50, 50, 60, 60, 1); rect(gap3, 64, 50, 70, 60, 1);
  const g3f = mk(); R.thickenIndex(gap3, g3f, null); const g3b = mk(); R.thinIndex(g3f, g3b, null);
  check("①(所感) 3px の隙間は往復で元に戻る", eq(g3b, gap3));
}

// ---- ② 1px 線は細らせると消える ----
{
  const src = mk();
  rect(src, 40, 100, 240, 100, 1);
  const out = mk();
  const c = R.thinIndex(src, out, null);
  check("② 1px 横線は細らせると消える（全 0）", c === 201 && values(out) === "", `changed=${c} values=${values(out)}`);
  const one = mk(); one[100 * W + 100] = 2;
  const o2 = mk(); const c3 = R.thinIndex(one, o2, null);
  check("② 1画素も消える", c3 === 1 && o2[100 * W + 100] === 0);
}

// ---- ③ 2色隣接の決定性・優先規則（上→左→右→下→左上→右上→左下→右下） ----
{
  const src = mk();
  rect(src, 100, 100, 110, 120, 1); // 赤=1 左ブロック
  rect(src, 112, 100, 122, 120, 2); // 青=2 右ブロック（x=111 が 1px の透明の隙間）
  const a = mk(); R.thickenIndex(src, a, null);
  const b = mk(); R.thickenIndex(src, b, null);
  check("③ 同じ入力→同じ出力（2回）", eq(a, b));
  check("③ 隙間 x=111 は「左」が「右」より先なので 1（赤）", at(a, 111, 110) === 1);
  // 斜めだけが赤・辺が青の画素 → 4近傍優先で青
  const s2 = mk();
  s2[100 * W + 100] = 1; // 左上に赤
  s2[101 * W + 102] = 2; // 右に青（対象 (101,101) の右隣）
  const o = mk(); R.thickenIndex(s2, o, null);
  check("③ 4近傍（右=青）が斜め（左上=赤）より優先", at(o, 101, 101) === 2, `got=${at(o, 101, 101)}`);
  // 上と左が両方あるとき「上」が勝つ
  const s3 = mk();
  s3[99 * W + 100] = 5; // 上
  s3[100 * W + 99] = 6; // 左
  const o3 = mk(); R.thickenIndex(s3, o3, null);
  check("③ 上（5）が左（6）より優先", at(o3, 100, 100) === 5, `got=${at(o3, 100, 100)}`);
  // 走査順に依存しない: 入力を左右反転しても、規則どおりに決まる（右ブロック=赤・左=青なら隙間は左=青）
  const s4 = mk();
  rect(s4, 100, 100, 110, 120, 2);
  rect(s4, 112, 100, 122, 120, 1);
  const o4 = mk(); R.thickenIndex(s4, o4, null);
  check("③ 左右を入れ替えると隙間は左の色（2）", at(o4, 111, 110) === 2);
  check("③ 色集合は不変", values(a) === "1,2" && values(o4) === "1,2");
}

// ---- ④ 画面端: 収縮は外を不透明扱い（端から痩せない）・膨張は端の外へ出ない ----
{
  const src = mk();
  rect(src, 0, 100, 20, 120, 1); // 左端に接した塗り
  const thin = mk(); R.thinIndex(src, thin, null);
  check("④ 端（x=0）は痩せない・内側（x=20）は 1px 痩せる", colRun(thin, 0, 100, 120) === 19 && at(thin, 0, 101) === 1 && at(thin, 20, 110) === 0 && at(thin, 19, 110) === 1, `x0run=${colRun(thin, 0, 100, 120)} x20=${at(thin, 20, 110)}`);
  check("④ 上下は 1px ずつ痩せる（y=100・120 が消える）", at(thin, 5, 100) === 0 && at(thin, 5, 120) === 0 && at(thin, 5, 101) === 1);
  const fat = mk(); R.thickenIndex(src, fat, null);
  check("④ 膨張は端の外へ出ない（x=319 に回り込まない）・右へは 1px", at(fat, W - 1, 110) === 0 && at(fat, 21, 110) === 1 && at(fat, 22, 110) === 0);
  // 四隅: (0,0) の1画素は細らせても残る（3方向が外＝不透明扱い、残りは透明なので消える）— いや 8近傍に透明があるので消える。
  // 端の1px 線（x=0 の縦線）は「端側は不透明扱い」でも右隣が透明なので消える＝端に接しているだけでは守られない
  const line = mk(); rect(line, 0, 50, 0, 150, 1);
  const lt = mk(); const cl = R.thinIndex(line, lt, null);
  check("④ 端の 1px 縦線は（右隣が透明なので）消える", cl === 101 && values(lt) === "");
  // 端に接した塗りの往復: 3px 幅で x=0..2 → 太らせ x=0..3 → 細らせ x=0..2（端側が保たれるので往復で元に戻る）
  const e3 = mk(); rect(e3, 0, 100, 2, 120, 1);
  const ef = mk(); R.thickenIndex(e3, ef, null);
  const eb = mk(); R.thinIndex(ef, eb, null);
  check("④ 端に接した 3px 帯は往復で元に戻る（外を不透明扱いにする理由）", eq(eb, e3) && at(ef, 3, 110) === 1);
}

// ---- ⑤ 選択範囲（clip）: 範囲外は不変・境界の規則 ----
{
  const src = mk();
  rect(src, 100, 100, 200, 102, 1); // 3px 横線 x=100..200
  const clip = R.rectMask(120, 90, 160, 110); // 線の途中を囲う
  const fat = mk(); R.thickenIndex(src, fat, clip);
  let outsideSame = true;
  for (let i = 0; i < PIXELS; i++) if (!clip[i] && fat[i] !== src[i]) { outsideSame = false; break; }
  check("⑤ 太らせ: 範囲外は 1画素も変わらない", outsideSame);
  check("⑤ 太らせ: 範囲内では 5px", colRun(fat, 140, 95, 108) === 5 && colRun(fat, 110, 95, 108) === 3);
  // 境界: 範囲外に線があっても取り込まない（範囲内が透明のとき）
  const s2 = mk(); rect(s2, 100, 100, 118, 102, 1); // 線は x<=118 まで（clip は 119..）
  const clip2 = R.rectMask(119, 90, 160, 110);
  const f2 = mk(); const c2 = R.thickenIndex(s2, f2, clip2);
  check("⑤ 太らせ: 範囲外の絵から範囲内へは広がらない（変化 0）", c2 === 0 && eq(f2, s2));
  // 収縮: 範囲外を不透明扱い → 範囲の境界で痩せない。帯 x=100..200 y=100..110、clip x=100..160 y=95..115
  //（左境界 x=100 は実際は外が透明だが「不透明扱い」で痩せない／上下は clip 内の透明に接するので痩せる）
  const s3 = mk(); rect(s3, 100, 100, 200, 110, 1);
  const clip3 = R.rectMask(100, 95, 160, 115);
  const t3 = mk(); R.thinIndex(s3, t3, clip3);
  check("⑤ 細らせ: 範囲の左境界 x=100（外は透明でも不透明扱い）は痩せない・上下 y=100/110 は痩せる・右境界 x=160 も痩せない",
    at(t3, 100, 105) === 1 && at(t3, 160, 105) === 1 && at(t3, 140, 100) === 0 && at(t3, 140, 110) === 0 && at(t3, 140, 101) === 1 && at(t3, 140, 109) === 1,
    `x100=${at(t3, 100, 105)} x160=${at(t3, 160, 105)} y100=${at(t3, 140, 100)} y110=${at(t3, 140, 110)}`);
  let out3 = true; for (let i = 0; i < PIXELS; i++) if (!clip3[i] && t3[i] !== s3[i]) { out3 = false; break; }
  check("⑤ 細らせ: 範囲外は不変", out3);
  // clip なしなら x=100 は痩せる（規則の対比）
  const t3n = mk(); R.thinIndex(s3, t3n, null);
  check("⑤ 対比: clip 無しでは x=100 も痩せる", at(t3n, 100, 105) === 0);
}

// ---- ⑥ 色集合と幅: 16bit でも値を保つ・新しい色は生まれない ----
{
  const src = mk(16);
  rect(src, 50, 50, 60, 60, 300); // 255 超の索引
  rect(src, 64, 50, 70, 60, 4000); // 隙間 3px（2px 以下は往復で埋まるので）
  const f = mk(16); R.thickenIndex(src, f, null);
  const t = mk(16); R.thinIndex(f, t, null);
  check("⑥ 16bit: 色集合 {300,4000} のまま・往復でビット一致", values(f) === "300,4000" && eq(t, src), values(f));
}

// ---- ⑦ M11-8 の選択範囲用 expandMask / contractMask は無改変（参照実装とビット一致） ----
{
  const refExpand = (mask: Uint8Array) => {
    const m = new Uint8Array(PIXELS);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const y0 = Math.max(0, y - 1), y1 = Math.min(H - 1, y + 1), x0 = Math.max(0, x - 1), x1 = Math.min(W - 1, x + 1);
      for (let ny = y0; ny <= y1; ny++) for (let nx = x0; nx <= x1; nx++) m[ny * W + nx] = 1;
    }
    return m;
  };
  const refContract = (mask: Uint8Array) => {
    const m = new Uint8Array(PIXELS);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      let keep = true;
      for (let ny = y - 1; ny <= y + 1 && keep; ny++) for (let nx = x - 1; nx <= x + 1; nx++) {
        if (nx < 0 || nx >= W || ny < 0 || ny >= H || !mask[ny * W + nx]) { keep = false; break; }
      }
      if (keep) m[y * W + x] = 1;
    }
    return m;
  };
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const masks: Uint8Array[] = [R.rectMask(10, 10, 100, 80), R.rectMask(0, 0, 50, 50), R.rectMask(300, 200, 319, 239)];
  const noise = new Uint8Array(PIXELS); for (let i = 0; i < PIXELS; i++) noise[i] = rnd() < 0.3 ? 1 : 0; masks.push(noise);
  masks.push(R.lassoMask([{ x: 20, y: 20 }, { x: 200, y: 40 }, { x: 120, y: 200 }]));
  let allOk = true;
  for (const m of masks) { if (!eq(R.expandMask(m), refExpand(m)) || !eq(R.contractMask(m), refContract(m))) { allOk = false; break; } }
  check("⑦ expandMask / contractMask（M11-8）は参照実装とビット一致（無改変）", allOk);
}

// ---- ⑧ 性能: 320×240 全画素の 1回 ----
{
  const src = mk();
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let i = 0; i < PIXELS; i++) src[i] = rnd() < 0.5 ? 1 + ((i * 7) % 5) : 0;
  const dst = mk();
  const t0 = performance.now();
  for (let k = 0; k < 50; k++) R.thickenIndex(src, dst, null);
  const t1 = performance.now();
  for (let k = 0; k < 50; k++) R.thinIndex(src, dst, null);
  const t2 = performance.now();
  console.log(`perf: thicken ${((t1 - t0) / 50).toFixed(2)}ms/op, thin ${((t2 - t1) / 50).toFixed(2)}ms/op（ノイズ画像・Node）`);
  check("⑧ 1回あたり 50ms 未満", (t1 - t0) / 50 < 50 && (t2 - t1) / 50 < 50);
}

console.log(`m1119 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
