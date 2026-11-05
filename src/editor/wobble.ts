// M10-3: ゆらゆら差分の自動生成（純関数部分）。
// M11-20 で editor.ts から切り出した。**DOM 非依存**（scripts/*_smoke.ts と mcp/ から呼べる）。
// ★V204 (A-111): 写し方を「1px の線を切らない」形（warpKeepLines）に変えた。前の写し方（線も applyWarp）とは
//   同じ設定でも絵が変わる（わざと・REQ_wobble_tuning §3）。M10-3 の参照の実装とのビット単位の比べは外し、
//   決まった結果・単体＝全レイヤー・範囲の外は不変・索引の閉包で見る（scripts/m1120_smoke.ts ②・scripts/v204_smoke.ts）。
//   強さは 1〜10（WOBBLE_LEVELS）。3・5・7 は今の WOBBLE_TABLE の行そのもの。

import { Frame, Project, cloneFrame, copyIndexBuf, W, H, PIXELS } from "./model";
import type { IndexBuf } from "./model";
import { WarpField, applyWarp } from "./warp";

// M10-3: ゆらゆら差分。種類と強さ
export type WobbleKind = "line" | "whole";
/** V204 (A-111): 強さは 1〜10（1 が一番弱い）。前の弱・中・強は 3・5・7 */
export type WobbleStrength = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export const WOBBLE_STRENGTH_MIN = 1;
export const WOBBLE_STRENGTH_MAX = 10;
/** V204 (A-111): ダイアログの既定（前の「中」） */
export const WOBBLE_STRENGTH_DEFAULT: WobbleStrength = 5;

/** M10-3 P-6: ゆらゆらの波長(L)と振幅(A)。**波長は固定**し、枚ごとの違いはシードだけで作る。
 *  振幅の下限を REQ の 1.5 / 0.5 ちょうどにしていないのは意図的で、0.5px だと
 *  `Math.round` で動く画素がごくわずかになり「押したのに何も起きない」に見えるため。
 *  ★V204: 形・長さ 3・並び（[0]=強さ 3・[1]=5・[2]=7）・値は変えない（main.ts の `?wobble` が添字 0〜2 で読む）。
 *  1〜10 の表は下の WOBBLE_LEVELS */
export const WOBBLE_TABLE: Record<WobbleKind, { L: number; A: number }[]> = {
  whole: [
    { L: 44, A: 1.8 },
    { L: 36, A: 2.4 },
    { L: 28, A: 3.0 },
  ],
  line: [
    { L: 7, A: 0.8 },
    { L: 6, A: 1.1 },
    { L: 5, A: 1.5 },
  ],
};

/** V204 (A-111・REQ §2-2): 強さ 1〜10 の波長と振幅（添字 0 が強さ 1）。3・5・7 は WOBBLE_TABLE の行そのもの（同じ実体） */
export const WOBBLE_LEVELS: Record<WobbleKind, readonly { L: number; A: number }[]> = {
  line: [
    { L: 8, A: 0.55 },
    { L: 7.5, A: 0.68 },
    WOBBLE_TABLE.line[0],
    { L: 6.5, A: 0.95 },
    WOBBLE_TABLE.line[1],
    { L: 5.5, A: 1.3 },
    WOBBLE_TABLE.line[2],
    { L: 5, A: 1.75 },
    { L: 5, A: 2.05 },
    { L: 5, A: 2.4 },
  ],
  whole: [
    { L: 52, A: 1.2 },
    { L: 48, A: 1.5 },
    WOBBLE_TABLE.whole[0],
    { L: 40, A: 2.1 },
    WOBBLE_TABLE.whole[1],
    { L: 32, A: 2.7 },
    WOBBLE_TABLE.whole[2],
    { L: 24, A: 3.3 },
    { L: 20, A: 3.6 },
    { L: 16, A: 3.9 },
  ],
};

/** 強さ（1〜10・範囲の外は端へ寄せる）の波長と振幅 */
export function wobbleLevel(kind: WobbleKind, strength: number): { L: number; A: number } {
  const s = Math.max(WOBBLE_STRENGTH_MIN, Math.min(WOBBLE_STRENGTH_MAX, Math.round(strength) || WOBBLE_STRENGTH_DEFAULT));
  return WOBBLE_LEVELS[kind][s - 1];
}

/**
 * V204 (A-111): シードの式（見本と［つくる］の両方がここを通る）。考え方は M10-3 のまま
 * （コマの中身のハッシュ・コマ数・コマの位置・種類・強さ）。種類と強さの項は `kindIndex * 10 + strength` にして
 * 重ならないようにした（前の `kindIndex * 3 + strength + 1` に 1〜10 を入れると、線がふるえるの 4〜10 と
 * 全体がゆれるの 1〜7 が同じ値になる）。
 */
export function wobbleSeedBase(
  frameHash: number,
  frameCount: number,
  frameIndex: number,
  kind: WobbleKind,
  strength: WobbleStrength
): number {
  const kindIndex = kind === "line" ? 0 : 1;
  return (
    ((frameHash >>> 0) ^
      Math.imul(frameCount, 0x9e3779b1) ^
      Math.imul(frameIndex + 1, 0x85ebca6b) ^
      Math.imul(kindIndex * 10 + strength, 0xc2b2ae35)) >>>
    0
  );
}

/**
 * ★V205 (A-114): 揺らす対象。`null`＝全レイヤー（📌 は除く）／レイヤー id の文字列＝そのレイヤーだけ（M11-20 の形・今も受ける）／
 * id の集まり＝その中のレイヤーだけ（選んだレイヤーやフォルダ・layerTree.ts の `wobbleTargetLayerIds`）。
 * 文字列は 1 件の集まりと同じ。**空の集まりは「どれも揺らさない」で、null（全レイヤー）とは違う**。どの形でも 📌 は揺らさない
 */
export type WobbleTarget = string | ReadonlySet<string> | null;

/** 対象に入るか（null＝全レイヤー） */
function inTarget(target: WobbleTarget, id: string): boolean {
  if (target === null) return true;
  return typeof target === "string" ? id === target : target.has(id);
}

/** 1 枚目（k=0）から数えた k 枚目の場のシード */
function seedOf(seedBase: number, k: number): number {
  return (seedBase + Math.imul(k + 1, 0x9e3779b9)) >>> 0;
}

/**
 * M10-3: ゆらゆら差分を作る。**元のコマ `cur` は読むだけで一切変更しない。**
 * 戻り値は「原本の直後に挿入する count−1 枚」。`p.frames` には触らない。
 *
 * - `seedBase` は呼び出し側が作る（editor は wobbleSeedBase。`?wobble` は固定値を渡して決定性を検証する）
 * - `mask`（選択範囲・M11-8 P-4）: あれば範囲内だけを揺らす（範囲の外は 1 画素も変えない）
 * - M11-20 `targetLayerId`: null なら**全レイヤー**（非表示レイヤーも含む・📌 全コマ共通のレイヤーは除く＝V204）。
 *   レイヤー id を渡すと**そのレイヤーだけ**を揺らし、他のレイヤーは cloneFrame の複製のまま。
 *   V205 (A-114): id の集まり（`WobbleTarget`）も受ける＝その中のレイヤーだけ（空の集まりはどれも揺らさない）
 *   （＝元コマとピクセル不変）。場（field）の作り方・シード派生は対象によらず同じで、レイヤーごとの計算は
 *   そのレイヤーだけを見るので、単体モードの対象レイヤーの画素は全レイヤーモードの同じレイヤーとビット同一になる
 * - V204: strength は 1〜10（wobbleLevel）。写し方は warpKeepLines
 */
export function buildWobbleFrames(
  p: Project,
  cur: Frame,
  count: number, // 2 | 3 | 4（原本を含めた総枚数）
  kind: WobbleKind,
  strength: WobbleStrength,
  seedBase: number,
  mask: Uint8Array | null,
  targetLayerId: WobbleTarget = null
): Frame[] {
  const field = new WarpField();
  const out: Frame[] = [];
  for (let k = 0; k < count - 1; k++) out.push(buildWobbleFrame(p, cur, k, kind, strength, seedBase, mask, targetLayerId, field));
  return out;
}

/**
 * V204 (A-111): k 枚目（0 から）だけを作る。buildWobbleFrames の 1 枚ぶんそのもの（見本は 1 枚ずつ作って合成し、
 * コマの写しを持ち続けない＝ダイアログの間に作品の全レイヤーの写しを count−1 枚ぶん抱えない）。
 * `field` は使い回し用（渡さなければ作る）。
 */
export function buildWobbleFrame(
  p: Project,
  cur: Frame,
  k: number,
  kind: WobbleKind,
  strength: WobbleStrength,
  seedBase: number,
  mask: Uint8Array | null,
  targetLayerId: WobbleTarget = null,
  field: WarpField = new WarpField()
): Frame {
  const { L, A } = wobbleLevel(kind, strength);
  const seedK = seedOf(seedBase, k);
  // dx と dy に別シード（同じだと全画素が斜めにずれるだけで「ゆれ」に見えない）
  field.setValueNoise(seedK, (seedK ^ 0x6d2b79f5) >>> 0, L, A);
  const nf = cloneFrame(cur);
  // 効果音は複製しない（同じ音が N 回鳴るのは誰も望まない）
  nf.se = undefined;
  // **1枚につき変位場は1つ**。全レイヤーに同じ場を当てるのでレイヤー間でズレない。
  // 非表示レイヤーも含める（除外すると絵の整合が崩れる）
  for (const ld of p.layerDefs) {
    if (!inTarget(targetLayerId, ld.id)) continue; // M11-20: 単体モードは対象だけ（V205: 集まりならその中だけ・空なら揺らさない）
    // ★V204（第三者レビュー D-1）: 📌 全コマ共通のレイヤーは揺らさない。挿入すると relinkShared が全コマの共通レイヤーを
    // 先頭のコマの実体へ張り直すので、揺らしても残らない（前からそう）＝見本でも揺らさないと見本と［つくる］の絵が食い違う
    if (ld.shared === true) continue;
    const src = cur.layers[ld.id];
    const dst = nf.layers[ld.id];
    // src と dst は別実体（cloneFrame → copyIndexBuf が新しい typed array を作る）。
    // 適用元は**常に原本**で、直前の生成結果には絶対に再適用しない。
    if (src && dst) warpKeepLines(src, dst, field, mask);
  }
  return nf;
}

// ---------------- V204 (A-111): 1px の線を切らない写し方 ----------------

/** 8 近傍（左上から時計回り）。細らせるときの輪の並びもこの順 */
const N8X = [-1, 0, 1, 1, 1, 0, -1, -1];
const N8Y = [-1, -1, -1, 0, 1, 1, 1, 0];

/**
 * V204 (A-111・REQ §2-1): ゆらゆらの写し方。`applyWarp`（逆写像・最近傍）は、変位がなめらかに変わると元の 1 列が
 * 飛ばされる所ができ、1px の線はそこで切れる。そこで点を「線」と「面」に分け、線だけは前へ送って繋ぎ直す。
 *
 * 1. 同じ色の 8 近傍が 0〜3 の点は線、4 以上は面。ただし線の点でも、同じ色の 8 近傍に近傍 5 以上の点
 *    （塗りの縁・内側）があれば面（塗りの角・とがった先を塗りと一緒に今の写し方にする＝角のそばに透明な穴を出さない）
 * 2. 面は今と同じ写し方（applyWarp に線の点を 0 にした写しを渡す）で下地にする。別の色の面に接する線の点（塗りの縁取り・塗りの上の線）は
 *    0 にせず下地にも残す（0 にすると塗りの中に紙が透ける）
 * 3. 線は各点を変位の先（round(x + dx)・round(y + dy)）へ 1 回だけ置く。別の色の面に接する線の点だけは、そこから p = x + d(p) を
 *    2 回たどって面の写し方（逆写像）で元の点が出る所へ寄せる（縁取りと塗りが一緒に動く）
 * 4. 同じ色で 8 近傍に隣り合っていた 2 点（どちらかが線）の送り先が離れたら、その間を 1px の線（Bresenham）で結ぶ
 * 5. 送った・結んだ点で、L 字の角にあって抜いても輪の上の同じ色が 1 つの塊のままなら抜く（下地へ戻す）。送った点のうち元の絵でも
 *    L 字の角だった点（ペンの線の段）は、2×2 の塊を作っていなければ抜かない（変位 0 の所の絵は 1 画素も変わらない）
 *
 * - 索引は**写すだけ**（`out[i] = src[j]` と、同じ色かどうかの比べだけ）。出てくる索引は src にある索引か 0。8/16bit どちらでも
 * - `mask` があるとき、`mask[i] === 0` の画素は `dst[i] = src[i]`（1 画素も変えない）。送る・結ぶ・細らせるは範囲の中にだけ書く。
 *   ★範囲の外の線は送らない（範囲の外は変えないので、送ると外の元の線と 2 本になる）。外の点は動かない点として扱い、
 *   範囲の中で送った点との間は範囲の中の分だけ結ぶ。範囲の外へ送られた点は書かないので、境目のそばでは切れることがある
 *   （今の写し方より少ない）
 * - 判定（線か面か）は範囲によらず元の絵全体で行う
 * - `src` と `dst` は別の実体。作業用の写しは copyIndexBuf（src の幅を保つ）。0/1 の印は Uint8Array
 * - 同じ入力なら同じ結果（走査の順番は固定・乱数なし）
 */
export function warpKeepLines(src: IndexBuf, dst: IndexBuf, field: WarpField, mask: Uint8Array | null): void {
  // 何も描いていないレイヤーは、何をしても透明のまま（範囲の外も 0）
  let any = false;
  for (let i = 0; i < PIXELS; i++)
    if (src[i] !== 0) {
      any = true;
      break;
    }
  if (!any) {
    dst.fill(0);
    return;
  }
  const { dx, dy } = field;
  // 1) 同じ色の 8 近傍の数
  const nCount = new Uint8Array(PIXELS);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = src[i];
      if (c === 0) continue;
      let n = 0;
      for (let d = 0; d < 8; d++) {
        const xx = x + N8X[d];
        const yy = y + N8Y[d];
        if (xx >= 0 && xx < W && yy >= 0 && yy < H && src[yy * W + xx] === c) n++;
      }
      nCount[i] = n;
    }
  // 線か面か（1-2: 近傍 5 以上の点に隣り合う線の点は面）
  const isLine = new Uint8Array(PIXELS);
  let lines = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = src[i];
      if (c === 0 || nCount[i] > 3) continue;
      let face = false;
      for (let d = 0; d < 8; d++) {
        const xx = x + N8X[d];
        const yy = y + N8Y[d];
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
        const j = yy * W + xx;
        if (src[j] === c && nCount[j] >= 5) {
          face = true;
          break;
        }
      }
      if (!face) {
        isLine[i] = 1;
        lines++;
      }
    }
  // 2) 面は今の写し方。線の点を 0 にした写しを applyWarp に渡し、範囲の外は元から写し直す
  //   （applyWarp は範囲の外を渡した写しのまま＝線の点が 0 のまま残るため）。
  //   ★V204（第三者レビュー S-1）: ただし**別の色の面に 8 近傍で接している線の点**（塗りの縁取り・塗りの上の線）は 0 にせず下地にも残す。
  //   0 にすると、塗りが元の線の位置を拾った所が透明になり、送った線がそこを覆わないと塗りの中に紙が透ける（同じレイヤーの
  //   線画＋バケツで 1 枚あたり最大 300 画素ほど）。残した線は今の写し方でも描かれ、送った線と重なって太る所がある（今の写し方と同じ程度）
  const face = copyIndexBuf(src);
  /** 別の色の面に接している線の点（塗りの縁取り・塗りの上の線） */
  const edgeLine = new Uint8Array(PIXELS);
  if (lines > 0)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!isLine[i]) continue;
        const c = src[i];
        let bordersFace = false;
        for (let d = 0; d < 8 && !bordersFace; d++) {
          const xx = x + N8X[d];
          const yy = y + N8Y[d];
          if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
          const j = yy * W + xx;
          if (src[j] !== 0 && src[j] !== c && !isLine[j]) bordersFace = true;
        }
        if (!bordersFace) face[i] = 0;
        else edgeLine[i] = 1;
      }
  const out = copyIndexBuf(src);
  applyWarp(face, out, field, mask);
  if (mask) for (let i = 0; i < PIXELS; i++) if (!mask[i]) out[i] = src[i];
  if (lines === 0) {
    dst.set(out);
    return;
  }
  // 細らせるときに戻す下地（面だけを写した絵・範囲の外は元のまま）
  const base = copyIndexBuf(out);
  const inMask = (i: number) => !mask || mask[i] !== 0;
  // 3) 送り先。範囲の外の点は動かない
  const fx = new Int16Array(PIXELS);
  const fy = new Int16Array(PIXELS);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (src[i] === 0) continue;
      if (inMask(i)) {
        // 送り先は round(x + dx)（付録 A と同じ）。★V204（第三者レビュー S-1 のあと）: 別の色の面に接している線の点（edgeLine）だけは、
        //  面の写し方（逆写像 out[p] = in[p − d(p)]）で元の点が出る所へ寄せる＝p = x + d(p) を 2 回たどる。強い揺れでは x + d(x) と
        //  逆写像の位置が 2px ほどずれ、下地に残した縁取りと送った線が二重になって間に紙が透けていた（縁取りと塗りが一緒に動く）。
        //  ほかの線は付録 A のまま（伸びた所で点が増えすぎない）。変位 0 なら元の位置のまま
        let px = x + dx[i];
        let py = y + dy[i];
        for (let it = 0; edgeLine[i] && it < 2; it++) {
          const q = Math.min(H - 1, Math.max(0, Math.round(py))) * W + Math.min(W - 1, Math.max(0, Math.round(px)));
          px = x + dx[q];
          py = y + dy[q];
        }
        fx[i] = Math.round(px);
        fy[i] = Math.round(py);
      } else {
        fx[i] = x;
        fy[i] = y;
      }
    }
  const fromLine = new Uint8Array(PIXELS);
  /** 絵の中・範囲の中だけ書く。書いた所に印 */
  const plot = (x: number, y: number, c: number) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const j = y * W + x;
    if (!inMask(j)) return;
    out[j] = c;
    fromLine[j] = 1;
  };
  /** Bresenham の 1px の線（両端を含む） */
  const seg = (x0: number, y0: number, x1: number, y1: number, c: number) => {
    const ax = Math.abs(x1 - x0);
    const ay = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = ax - ay;
    let x = x0;
    let y = y0;
    for (;;) {
      plot(x, y, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -ay) {
        err -= ay;
        x += sx;
      }
      if (e2 < ax) {
        err += ax;
        y += sy;
      }
    }
  };
  /** 送った点の行き先 → 元の点（1 足し・0 は無し）。細らせるとき、元で L 字の角（ペンの段）だった点を抜かないために使う */
  const fwdFrom = new Int32Array(PIXELS);
  for (let i = 0; i < PIXELS; i++)
    if (isLine[i] && inMask(i)) {
      plot(fx[i], fy[i], src[i]);
      const fxi = fx[i];
      const fyi = fy[i];
      if (fxi >= 0 && fxi < W && fyi >= 0 && fyi < H) fwdFrom[fyi * W + fxi] = i + 1;
    }
  // 4) 同じ色で隣り合っていた 2 点（どちらかが線）の送り先が離れたら結ぶ（右・下・右下・左下の 4 向きで全部の組を 1 回ずつ）
  const FX = [1, 0, 1, -1];
  const FY = [0, 1, 1, 1];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = src[i];
      if (c === 0) continue;
      for (let d = 0; d < 4; d++) {
        const xx = x + FX[d];
        const yy = y + FY[d];
        if (xx < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (src[j] !== c || (!isLine[i] && !isLine[j])) continue;
        if (!inMask(i) && !inMask(j)) continue; // 両方とも範囲の外＝動かない（書く所も無い）
        if (Math.max(Math.abs(fx[i] - fx[j]), Math.abs(fy[i] - fy[j])) > 1) seg(fx[i], fy[i], fx[j], fy[j], c);
        else {
          plot(fx[i], fy[i], c);
          plot(fx[j], fy[j], c);
        }
      }
    }
  // 5) 細らせる: 送った・結んだ点で、L 字の角にあり、抜いても輪の上の同じ色の点が 1 つの塊のままなら下地へ戻す
  const ring = [false, false, false, false, false, false, false, false];
  const idx: number[] = [];
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const c = out[i];
      if (c === 0 || !fromLine[i] || !inMask(i)) continue;
      // ★V204（第三者レビュー D-2）: 送った点のうち、**元の絵でも L 字の角だった点**（ペンの線の段＝元の形そのもの）は抜かない。
      //  抜くのは送った・結んだせいでできた角だけ＝変位 0 の所の絵は 1 画素も変わらず、動いた所でもペンの段が細らない。
      //  ただし送った先で同じ色の 2×2 の塊を作っているときは、元の角でも抜いてよい（線を太らせない）
      const from = fwdFrom[i] - 1;
      if (from >= 0 && src[from] === c) {
        const fxk = from % W;
        const l = fxk > 0 && src[from - 1] === c;
        const r = fxk < W - 1 && src[from + 1] === c;
        const u = from >= W && src[from - W] === c;
        const dn = from < PIXELS - W && src[from + W] === c;
        if ((l && u) || (u && r) || (r && dn) || (dn && l)) {
          // 元の角でも、送った先で同じ色の 2×2 の塊を作っているなら抜いてよい（下の決まりで繋がりを確かめてから）
          const o = (dx2: number, dy2: number) => out[i + dy2 * W + dx2] === c;
          const block = (o(-1, 0) && o(0, -1) && o(-1, -1)) || (o(1, 0) && o(0, -1) && o(1, -1)) || (o(1, 0) && o(0, 1) && o(1, 1)) || (o(-1, 0) && o(0, 1) && o(-1, 1));
          if (!block) continue;
        }
      }
      let cnt = 0;
      for (let d = 0; d < 8; d++) {
        ring[d] = out[(y + N8Y[d]) * W + (x + N8X[d])] === c;
        if (ring[d]) cnt++;
      }
      if (cnt < 2) continue; // 端は抜かない
      const corner = (ring[7] && ring[1]) || (ring[1] && ring[3]) || (ring[3] && ring[5]) || (ring[5] && ring[7]);
      if (!corner) continue;
      // 輪の上の同じ色の点が 8 近傍どうしで 1 つの塊か
      idx.length = 0;
      for (let d = 0; d < 8; d++) if (ring[d]) idx.push(d);
      let seen = 1 << idx[0];
      const stack = [idx[0]];
      while (stack.length) {
        const a = stack.pop()!;
        for (const b of idx) {
          if (seen & (1 << b)) continue;
          if (Math.max(Math.abs(N8X[a] - N8X[b]), Math.abs(N8Y[a] - N8Y[b])) <= 1) {
            seen |= 1 << b;
            stack.push(b);
          }
        }
      }
      let all = true;
      for (const b of idx) if (!(seen & (1 << b))) all = false;
      if (all) out[i] = base[i];
    }
  dst.set(out);
}
