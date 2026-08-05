// M10-2a: 変位マップエンジン。
//
// 歪み3方式（液状化 / 魚眼 / 四隅）も M10-3 のゆらゆら差分も、すべて
// 「変位場を作る → 適用する」という同じ形をしている。**違うのは場の作り方だけ**。
// 適用側（最近傍サンプル・範囲外処理・マスク処理）をここに一本化することで、
// 方式ごとに実装が分岐して、どれかが補間を混ぜてしまう事故を防ぐ。
//
// **絶対不変条件（REQ §1）**: IndexBuf の値は colorTable の**添字**であって色ではない。
// バイリニア補間や平均を取ると、存在しない添字になるか無関係な色に化ける。
// したがって適用は `dst[i] = src[j]` の**代入のみ**。索引に対する演算は一切しない。
//
// 依存は ./model の定数だけ。document にも editor.ts にも依存させない（純関数＋クラス）。
import { W, H, PIXELS } from "./model";
import type { IndexBuf } from "./model";

/** 変位量の上限（px）。320×240 でこれを超える引っ張りは実用上ただの破壊なので、
 *  暴走で絵が消えるのを防ぐために各画素でクランプする。
 *
 *  **加算系（addLiquify / addFisheye）の暴走防止用**であって、
 *  絶対位置で決まる写像（setHomography）には掛けない。
 *  四隅を大きく動かすと変位は容易に 64px を超えるため、クランプすると隅が固まって絵が破綻する。
 *  意図的な非対称なので「他の2つと揃っていない」と思って揃えに行かないこと。 */
export const MAX_DISPLACEMENT = 64;

/** 決定的な擬似乱数（mulberry32）。同じ seed で必ず同じ列を返す。
 *  M10-3 のゆらゆらは「同じ入力なら同じ結果」が受け入れ基準なので `Math.random` は使わない。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 波長 L の値ノイズを返す。戻り値は (x, y) -> -1..1。
 * 格子点に乱数を置き、smoothstep で補間する。
 *
 * **ここは索引ではなく変位場（float）を作る処理なので、補間してよい。**
 * M10 でずっと言ってきた「補間・平均・ブレンド禁止」は `IndexBuf` に対しての話で、
 * `Float32Array` の変位場を滑らかに繋ぐのはむしろ必要。補間せず格子のまま使うと、
 * 波長のブロックがそのまま四角く見えて汚くなる。
 * **索引に対する補間は相変わらず禁止**（適用は `applyWarp` の最近傍サンプルのまま）。
 */
function makeValueNoise(
  seed: number,
  wavelength: number
): (x: number, y: number) => number {
  const L = Math.max(2, wavelength);
  // 格子は W/L, H/L より +2 大きく取る。x<=W-1 なら i0 <= floor((W-1)/L) なので
  // i0+1 <= floor((W-1)/L)+1 <= ceil(W/L)+1 = gw-1 に必ず収まる（x>=0 より i0>=0）
  const gw = Math.ceil(W / L) + 2;
  const gh = Math.ceil(H / L) + 2;
  const g = new Float32Array(gw * gh);
  const rnd = mulberry32(seed);
  for (let i = 0; i < g.length; i++) g[i] = rnd() * 2 - 1;
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const gx = x / L;
    const gy = y / L;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const tx = fade(gx - i0);
    const ty = fade(gy - j0);
    const a = g[j0 * gw + i0];
    const b = g[j0 * gw + i0 + 1];
    const c = g[(j0 + 1) * gw + i0];
    const d = g[(j0 + 1) * gw + i0 + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
}

/** 4点が凸四角形をなすか。非凸・自己交差・3点一直線は false。
 *  射影変換は凸四角形の内側でのみ意味を持つ（非凸だと消失線が内部に入り、
 *  分母 w が 0 を跨いで写像が発散する）。ハンドル移動の受理判定に使う。 */
export function isConvexQuad(p: { x: number; y: number }[]): boolean {
  if (p.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    const c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false; // 退化（3点が一直線）
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 4点対応 dst[i] -> src[i] のホモグラフィ係数 [h0..h7] を返す（h8=1）。
 *  u = (h0·x + h1·y + h2) / (h6·x + h7·y + 1)
 *  v = (h3·x + h4·y + h5) / (h6·x + h7·y + 1)
 *  解けない（特異）場合は null。 */
export function solveHomography(
  dstPts: { x: number; y: number }[],
  srcPts: { x: number; y: number }[]
): number[] | null {
  // 8×9 の拡大係数行列を組んでガウス消去（部分ピボット付き）
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dstPts[i];
    const { x: u, y: v } = srcPts[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++)
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-10) return null; // 特異
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    for (let c = col; c < 9; c++) A[col][c] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row) => row[8]);
}

/**
 * 変位場 D: (x, y) -> (dx, dy)。**float のまま**保持する。
 * 適用は out[x, y] = in[ round(x - dx), round(y - dy) ]。
 * dx が正なら絵は右へずれる（逆写像なので符号に注意）。
 *
 * 変位を先に整数へ丸めるとドットが階段状に跳ねて、M10-3 のゆらゆらが汚くなる。
 * `Math.round` はサンプル時の一度だけ。
 */
export class WarpField {
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  /** 選択範囲の重み（0..1）。null = 全画素 1 として扱う */
  private weight: Float32Array | null = null;

  constructor() {
    this.dx = new Float32Array(PIXELS);
    this.dy = new Float32Array(PIXELS);
  }

  /** 場を 0 に戻す（領域重みは保持する） */
  clear(): void {
    this.dx.fill(0);
    this.dy.fill(0);
  }

  /** 1画素も動かないなら true（履歴を積むかどうかの判定に使う） */
  isIdentity(): boolean {
    for (let i = 0; i < PIXELS; i++) {
      // round したときに 0 でないなら実際に動く
      if (Math.round(this.dx[i]) !== 0 || Math.round(this.dy[i]) !== 0) return false;
    }
    return true;
  }

  /**
   * 選択範囲がある場合の領域重みを作る。**ストローク開始時に1回だけ**呼ぶこと。
   *
   * 毎 move で境界からの距離を測ると PIXELS × (2f+1)^2 ≈ 3.7M 回のループが
   * ドラッグ中ずっと回る。重みマップを先に1枚作って、加算時に掛けるだけにする。
   *
   * mask=null なら全画素 1。マスク外は 0、マスク内でも縁から fadePx 以内は
   * 距離に応じて 0→1 へ滑らかに上げる（マスク際で絵が千切れないように）。
   */
  setRegionWeight(mask: Uint8Array | null, fadePx: number): void {
    if (!mask) {
      this.weight = null;
      return;
    }
    const w = new Float32Array(PIXELS);
    const f = Math.max(0, Math.floor(fadePx));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!mask[i]) continue; // マスク外は 0 のまま
        if (f === 0) {
          w[i] = 1;
          continue;
        }
        // 縁からの距離（f を超えたら 1）。近傍の走査は f が小さい前提（既定 3px）
        let d = f;
        for (let oy = -f; oy <= f && d > 0; oy++) {
          const yy = y + oy;
          for (let ox = -f; ox <= f; ox++) {
            const xx = x + ox;
            const outside =
              xx < 0 || xx >= W || yy < 0 || yy >= H || !mask[yy * W + xx];
            if (!outside) continue;
            const dist = Math.max(Math.abs(ox), Math.abs(oy));
            if (dist < d) d = dist;
            if (d === 0) break;
          }
        }
        w[i] = Math.min(1, d / f);
      }
    }
    this.weight = w;
  }

  /**
   * 液状化: 中心 (cx, cy) 半径 R の円内に移動ベクトル (vx, vy) を距離減衰させて**加算**する。
   * 減衰は w = (1 - (d/R)^2)^2（境界で滑らかに 0 になる形）。
   * strength は 0..100（%）。加算時に領域重みを掛ける。
   */
  addLiquify(
    cx: number,
    cy: number,
    vx: number,
    vy: number,
    radius: number,
    strength: number
  ): void {
    const R = Math.max(1, radius);
    const s = Math.max(0, Math.min(100, strength)) / 100;
    if (s === 0 || (vx === 0 && vy === 0)) return;
    const x0 = Math.max(0, Math.floor(cx - R));
    const x1 = Math.min(W - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const y1 = Math.min(H - 1, Math.ceil(cy + R));
    const R2 = R * R;
    for (let y = y0; y <= y1; y++) {
      const ddy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const ddx = x - cx;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 >= R2) continue;
        const t = 1 - d2 / R2;
        let w = t * t * s; // (1 - (d/R)^2)^2
        const i = y * W + x;
        if (this.weight) {
          w *= this.weight[i];
          if (w === 0) continue;
        }
        // 加算後にクランプ（暴走防止）
        const nx = this.dx[i] + vx * w;
        const ny = this.dy[i] + vy * w;
        this.dx[i] = nx < -MAX_DISPLACEMENT ? -MAX_DISPLACEMENT : nx > MAX_DISPLACEMENT ? MAX_DISPLACEMENT : nx;
        this.dy[i] = ny < -MAX_DISPLACEMENT ? -MAX_DISPLACEMENT : ny > MAX_DISPLACEMENT ? MAX_DISPLACEMENT : ny;
      }
    }
  }

  /**
   * 魚眼: 中心 (cx, cy) 半径 R の円内に、径方向の写像 rSrc = R * (r/R)^k を**加算**する。
   * strength は -100..+100（正でふくらみ、負でへこみ、0 で無変化）。
   *
   * **式は逆写像として読む**（r が出力側の距離・rSrc がサンプル元の距離）。
   * applyWarp が out[x,y] = in[x-dx, y-dy] の逆写像なのでそのまま噛み合う:
   *   s>0 → k>1 → rSrc<r（内側から持ってくる）→ 中心付近が拡大＝ふくらむ
   *   s<0 → k<1 → rSrc>r（外側から持ってくる）→ 外の絵が中心へ＝へこむ
   *
   * 境界 r=R では rSrc=R となって変位が自然に 0 になるので、液状化のような
   * (1-(d/R)^2)^2 の距離減衰は**追加で掛けない**（掛けるとレンズらしさが消える）。
   * 掛けるのは選択範囲の重みだけ。
   */
  addFisheye(cx: number, cy: number, radius: number, strength: number): void {
    const R = Math.max(1, radius);
    const s = Math.max(-100, Math.min(100, strength)) / 100;
    if (s === 0) return;
    // s=-1 で k=0 になると rSrc=R（全画素が円周から来る）に退化するので下限を切る
    const k = Math.max(0.25, 1 + s);
    const x0 = Math.max(0, Math.floor(cx - R));
    const x1 = Math.min(W - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const y1 = Math.min(H - 1, Math.ceil(cy + R));
    const R2 = R * R;
    for (let y = y0; y <= y1; y++) {
      const ddy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const ddx = x - cx;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 >= R2) continue;
        const r = Math.sqrt(d2);
        if (r < 0.5) continue; // 中心画素は動かさない（0除算回避）
        const i = y * W + x;
        let w = 1;
        if (this.weight) {
          w = this.weight[i];
          if (w === 0) continue;
        }
        const rSrc = R * Math.pow(r / R, k);
        const m = (r - rSrc) * w; // 径方向の変位量（正=外へ引き伸ばす＝ふくらみ）
        const ex = ddx / r;
        const ey = ddy / r;
        let nx = this.dx[i] + ex * m;
        let ny = this.dy[i] + ey * m;
        // --- 行き過ぎ止め ---
        // 変位を N 回加算するとサンプル元距離 r(1-N+N·p) が負になり、絵が点対称に反転する。
        // 径方向成分が r を超えたぶんだけ引き戻すことで、サンプル元距離は最小でも 0（中心）で止まる。
        // 接線方向成分は触らないので、液状化と混ざっても壊れない。
        const radial = nx * ex + ny * ey;
        if (radial > r) {
          const over = radial - r;
          nx -= ex * over;
          ny -= ey * over;
        }
        this.dx[i] = nx < -MAX_DISPLACEMENT ? -MAX_DISPLACEMENT : nx > MAX_DISPLACEMENT ? MAX_DISPLACEMENT : nx;
        this.dy[i] = ny < -MAX_DISPLACEMENT ? -MAX_DISPLACEMENT : ny > MAX_DISPLACEMENT ? MAX_DISPLACEMENT : ny;
      }
    }
  }

  /**
   * 射影変換（ホモグラフィ）の変位場を**作り直す**（加算ではない）。
   * 加算ではないので名前も `add*` ではなく `set*`。中で必ず `clear()` を呼ぶ。
   *
   * quad は変形後の四隅（左上→右上→右下→左下の順）、rect は変形前の矩形。
   * 出力画素 (x,y) について、元矩形のどこから来るかを逆写像で求める。
   * `applyWarp` が round(x - dx) をサンプルするので、dx = x - u をそのまま入れればよい。
   *
   * 元矩形の外から来る画素は「絵が無い」ので透明にする。`applyWarp` は W/H の外しか 0 に
   * しないため、変位を W+H だけ足して確実に範囲外へ飛ばす。
   *
   * `MAX_DISPLACEMENT` は掛けない（絶対位置で決まる写像なのでクランプすると隅が固まる）。
   * 領域重み（setRegionWeight）も**使わない**。射影変換の変位を重みで減衰させると
   * もはや射影でなくなり、四隅の直線が曲がる。選択範囲は applyWarp のマスクだけで効かせる。
   *
   * @returns 場を作れたら true、四角形が退化していて作れなければ false（場は変更しない）
   */
  setHomography(
    quad: { x: number; y: number }[],
    rect: { x0: number; y0: number; x1: number; y1: number }
  ): boolean {
    if (!isConvexQuad(quad)) return false;
    const srcPts = [
      { x: rect.x0, y: rect.y0 },
      { x: rect.x1, y: rect.y0 },
      { x: rect.x1, y: rect.y1 },
      { x: rect.x0, y: rect.y1 },
    ];
    const h = solveHomography(quad, srcPts);
    if (!h) return false;
    this.clear();
    const OUT = W + H; // 確実に範囲外へ飛ばすための下駄
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const w = h[6] * x + h[7] * y + 1;
        if (Math.abs(w) < 1e-9) {
          // 消失線上（凸なら通常来ない・安全弁）
          this.dx[i] = x + OUT;
          this.dy[i] = y + OUT;
          continue;
        }
        const u = (h[0] * x + h[1] * y + h[2]) / w;
        const v = (h[3] * x + h[4] * y + h[5]) / w;
        if (u < rect.x0 - 0.5 || u > rect.x1 + 0.5 || v < rect.y0 - 0.5 || v > rect.y1 + 0.5) {
          this.dx[i] = x + OUT;
          this.dy[i] = y + OUT;
          continue;
        }
        this.dx[i] = x - u;
        this.dy[i] = y - v;
      }
    }
    return true;
  }

  /**
   * M10-3: ゆらゆら用のノイズ変位場を**代入で**作る（加算ではない）。
   *
   * dx と dy に**別のシード**を使う。同じシードだと全画素が斜め方向にしか動かず、
   * 「ぐにゃぐにゃ揺れる」ではなく「斜めにずれる」になってしまう。
   *
   * `MAX_DISPLACEMENT` は掛けない。振幅は最大 3px で自明に下回るため意味がなく、
   * `setHomography` と同じく「加算系でないものにはクランプを掛けない」という規則に従う。
   * `setRegionWeight` も使わない（ゆらゆらは選択範囲を効かせない）。
   */
  setValueNoise(
    seedX: number,
    seedY: number,
    wavelength: number,
    amplitude: number
  ): void {
    this.clear();
    const nx = makeValueNoise(seedX, wavelength);
    const ny = makeValueNoise(seedY, wavelength);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        this.dx[i] = nx(x, y) * amplitude;
        this.dy[i] = ny(x, y) * amplitude;
      }
    }
  }
}

/**
 * 変位場を適用する。
 *
 * - `src` と `dst` は**必ず別の実体**であること（同一バッファを渡すと読みながら書いて壊れる）。
 * - `mask` があるとき、`mask[i] === 0` の画素は `dst[i] = src[i]` とし、絶対に書き換えない。
 * - 範囲外から来た画素は `0`（透明）。紙色や黒で埋めない。
 * - サンプルは最近傍のみ。**代入以外の演算を索引に対して行わない**。
 */
export function applyWarp(
  src: IndexBuf,
  dst: IndexBuf,
  field: WarpField,
  mask: Uint8Array | null
): void {
  const { dx, dy } = field;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask && !mask[i]) {
        dst[i] = src[i];
        continue;
      }
      const sx = Math.round(x - dx[i]);
      const sy = Math.round(y - dy[i]);
      dst[i] = sx < 0 || sx >= W || sy < 0 || sy >= H ? 0 : src[sy * W + sx];
    }
  }
}
