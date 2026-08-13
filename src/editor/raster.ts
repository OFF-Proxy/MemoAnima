// ラスタ演算（M3）: 320×240 の colorTable-index バッファに対する純粋関数群。
// すべての結果はドット格子に確定する（うごメモのドット感・SPEC §4）。

// 型の使い分け（N-2・16bitパレット対応）:
// - IndexBuf … レイヤーの索引バッファ（8/16bit。色indexは255超になり得る）
// - Uint8Array … 0/1 マスク・文字マスク（16bit化しない。索引ではない）
import { W, H, PIXELS } from "./model";

export type { PenTexture, IndexBuf } from "./model";
import type { PenTexture, IndexBuf } from "./model";
// M10-1c: 書体テーブルは fonts.ts が唯一の置き場所（UI とラスタライズで共有する）
import { fontDef, type FontKey } from "./fonts";

/** M10-1c: 文字ツールの書体指定 */
export interface TextOpts {
  family: FontKey;
  bold: boolean;
  /** M10-11: 縦書き（1列・上から下）。falsy なら従来の横書き経路をそのまま通る */
  vertical?: boolean;
}

// ---- M10-11: 縦組で 90°回転させる文字（作者確定の固定リスト。増減しないこと） ----
// 長音・波・リーダ類 / 括弧類 / 罫・記号。矢印（→←↑↓）は回転しない。
const V_ROTATE = new Set(
  [...'ー〜～…‥―（）()「」『』【】［］[]｛｝{}〈〉《》−-＝=＿_']
);
/** 半角英数記号（U+0020〜U+007E）は縦組の欧文作法で 90°回転する */
function isAsciiPrintable(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c >= 0x20 && c <= 0x7e;
}
/** 句読点は回転せず、セルの右上寄りに置く（標準の縦組位置） */
const V_PUNCT_TOPRIGHT = new Set([...'、。，．']);

/** 決定的ノイズ（再描画で柄が揺れないように座標＋シードから算出） */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = (h * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) % 1000;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// ---------------- M5-4: トーンパターン（うごメモ「ぶつぶつペイント」準拠） ----------------

/** 8×8 タイル（1bit）。tile[y*8+x] が 1 なら塗る */
export type ToneTile = Uint8Array; // 長さ64

/** パターンは**キャンバス座標に固定**（coordinate-anchored）。
 *  ストロークを何度重ねても柄が継ぎ目なく繋がる（うごメモのトーン感の正体）。 */
export function toneAt(tile: ToneTile, x: number, y: number): boolean {
  return tile[(y & 7) * 8 + (x & 7)] !== 0;
}

/** 8行×8文字（'#'=塗る）からタイルを作る */
function T(...rows: string[]): ToneTile {
  const t = new Uint8Array(64);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) t[y * 8 + x] = rows[y]?.[x] === "#" ? 1 : 0;
  return t;
}

export interface ToneDef {
  id: string;
  name: string;
  /** null=ベタ（パターンなし全塗り） */
  tile: ToneTile | null;
  group: string;
}

/** 3DSピッカー準拠の柄ファミリー（各 大/小）＋ベタ。データ駆動で後から追加可能 */
export const TONE_TILES: ToneDef[] = [
  {
    id: "dot-sparse-l", name: "ドット疎（大）", group: "ドット疎",
    tile: T("##......", "##......", "........", "........", "....##..", "....##..", "........", "........"),
  },
  {
    id: "dot-sparse-s", name: "ドット疎（小）", group: "ドット疎",
    tile: T("#.......", "........", "........", "........", "....#...", "........", "........", "........"),
  },
  {
    id: "halftone-l", name: "網点（大）", group: "網点",
    tile: T("##..##..", "##..##..", "........", "........", "..##..##", "..##..##", "........", "........"),
  },
  {
    id: "halftone-s", name: "網点（小）", group: "網点",
    tile: T("#.#.#.#.", "........", ".#.#.#.#", "........", "#.#.#.#.", "........", ".#.#.#.#", "........"),
  },
  // M5-5 T-2: 細密化 — 小=1pxピッチ基調・大=小の約2倍ピッチ（うごメモのトーン感へ）
  {
    id: "hatch-l", name: "斜め網掛け（大）", group: "斜め網掛け",
    // 1px斜線クロス・ピッチ8（X字格子。交点=ドット混合の見え）
    tile: T("#.......", ".#.....#", "..#...#.", "...#.#..", "....#...", "...#.#..", "..#...#.", ".#.....#"),
  },
  {
    id: "hatch-s", name: "斜め網掛け（小）", group: "斜め網掛け",
    // 1px斜線クロス・ピッチ4（旧・大）
    tile: T("#...#...", ".#.#.#.#", "..#...#.", ".#.#.#.#", "#...#...", ".#.#.#.#", "..#...#.", ".#.#.#.#"),
  },
  {
    id: "vline-l", name: "縦線（大）", group: "縦線",
    // 幅1px・間隔3（旧: 幅2間隔2のブロック状を細線化）
    tile: T("#...#...", "#...#...", "#...#...", "#...#...", "#...#...", "#...#...", "#...#...", "#...#..."),
  },
  {
    id: "vline-s", name: "縦線（小）", group: "縦線",
    // 幅1px・間隔1（最細）
    tile: T("#.#.#.#.", "#.#.#.#.", "#.#.#.#.", "#.#.#.#.", "#.#.#.#.", "#.#.#.#.", "#.#.#.#.", "#.#.#.#."),
  },
  {
    id: "hline-l", name: "横線（大）", group: "横線",
    // 高さ1px・間隔3
    tile: T("########", "........", "........", "........", "########", "........", "........", "........"),
  },
  {
    id: "hline-s", name: "横線（小）", group: "横線",
    // 高さ1px・間隔1（最細）
    tile: T("########", "........", "########", "........", "########", "........", "########", "........"),
  },
  {
    id: "checker-l", name: "市松（大）", group: "市松",
    // 2pxチェッカー（旧4pxのブロック状を細分化）
    tile: T("##..##..", "##..##..", "..##..##", "..##..##", "##..##..", "##..##..", "..##..##", "..##..##"),
  },
  {
    id: "checker-s", name: "市松（小）", group: "市松",
    // 1pxチェッカー（古典ディザ・最細）
    tile: T("#.#.#.#.", ".#.#.#.#", "#.#.#.#.", ".#.#.#.#", "#.#.#.#.", ".#.#.#.#", "#.#.#.#.", ".#.#.#.#"),
  },
  {
    id: "grid-l", name: "格子（大）", group: "格子",
    tile: T("########", "#.......", "#.......", "#.......", "#.......", "#.......", "#.......", "#......."),
  },
  {
    id: "grid-s", name: "格子（小）", group: "格子",
    tile: T("########", "#...#...", "#...#...", "#...#...", "########", "#...#...", "#...#...", "#...#..."),
  },
  {
    id: "cross-l", name: "クロスドット（大）", group: "クロスドット",
    tile: T("..#.....", "..#.....", "#####...", "..#.....", "..#.....", "........", "........", "........"),
  },
  {
    id: "cross-s", name: "クロスドット（小）", group: "クロスドット",
    tile: T(".#......", "###.....", ".#......", "........", ".....#..", "....###.", ".....#..", "........"),
  },
  { id: "solid", name: "ベタ", group: "ベタ", tile: null },
];

export function toneById(id: string): ToneDef | undefined {
  return TONE_TILES.find((t) => t.id === id);
}

export interface PenOptions {
  size: number; // 直径（ドット）
  color: number; // colorTable index（0=透明＝消し）
  texture: PenTexture;
  seed: number;
  /** ストローク内の累積距離（点線用） */
  dashAcc?: { d: number };
  /** M5-4: ブラシのトーンパターン。指定時は texture より優先。
   *  タイルの穴（0）は既存画素を触らない（透過・下を消さない） */
  tone?: ToneTile | null;
  /** M10-22: 選択範囲クリップ（0/1 マスク）。指定時はマスク外へ一切書かない。
   *  「書くか書かないか」の判定のみ（補間・平均はしない）。未指定=従来どおり全面 */
  clip?: Uint8Array;
}

/** M10-7: stamp() のテクスチャ判定（1画素ぶん）。true=塗る / false=飛ばす。
 *  円形経路と 2×2 経路の**両方から呼ぶ**。元の switch と判定は完全に同値
 *  （continue する条件を反転して return false にしただけ）。 */
function texturePasses(
  o: PenOptions,
  x: number,
  y: number,
  d2: number,
  r: number
): boolean {
  switch (o.texture) {
    case "solid":
      return true;
    case "dot":
      return true; // 点線はストローク側で on/off
    case "rough":
      return hash2(x, y, o.seed) >= 380;
    case "spray": {
      // 半径2倍にまばらに飛ばす
      const rr = r * 2;
      if (d2 > rr * rr) return false;
      return hash2(x, y, o.seed) < 140;
    }
    case "sand":
      return hash2(x, y, o.seed) < 280;
    case "halftone":
      return BAYER4[(y & 3) * 4 + (x & 3)] < 8;
  }
  return true;
}

/** 1スタンプ（円。ただし太さ2だけ 2×2 の正方形）を打つ */
export function stamp(buf: IndexBuf, cx: number, cy: number, o: PenOptions) {
  const r = Math.max(0.5, o.size / 2);
  // M10-7: 太さ2は **(cx, cy) を左上とする 2×2 の正方形**にする。
  // 円形判定だと半径1で四隅が落ちて「5ドットの十字」になり、3×3 の太さ3と
  // 見た目がほとんど変わらなかった。偶数径には中心ドットが無いので、
  // カーソル位置＝左上として右下へ伸ばす（ドット絵ツールの一般的な挙動）。
  // per-pixel のトーン/テクスチャ判定は円形経路とまったく同じものを通す。
  if (o.size === 2) {
    for (let dy = 0; dy <= 1; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = 0; dx <= 1; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        // M10-22: 選択範囲クリップ（トーン経路含む全書き込みの直前で判定）
        if (o.clip && !o.clip[y * W + x]) continue;
        if (o.tone) {
          if (toneAt(o.tone, x, y)) buf[y * W + x] = o.color;
          continue;
        }
        if (!texturePasses(o, x, y, dx * dx + dy * dy, r)) continue;
        buf[y * W + x] = o.color;
      }
    }
    return;
  }
  const ri = Math.ceil(r);
  const r2 = r * r;
  for (let dy = -ri; dy <= ri; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -ri; dx <= ri; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= W) continue;
      const d2 = (dx + 0.0) * dx + (dy + 0.0) * dy;
      if (d2 > r2 && o.size > 1) continue;
      if (o.size <= 1 && (dx !== 0 || dy !== 0)) continue;
      // M10-22: 選択範囲クリップ（トーン経路含む全書き込みの直前で判定）
      if (o.clip && !o.clip[y * W + x]) continue;
      // M5-4: トーンパターン（キャンバス座標固定）。穴は素通し＝下の絵を消さない
      if (o.tone) {
        if (toneAt(o.tone, x, y)) buf[y * W + x] = o.color;
        continue;
      }
      if (!texturePasses(o, x, y, d2, r)) continue;
      buf[y * W + x] = o.color;
    }
  }
}

/** 線分に沿ってスタンプを打つ（点線は累積距離で on/off） */
export function strokeSegment(
  buf: IndexBuf,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  o: PenOptions
) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist));
  const dashPeriod = Math.max(6, o.size * 3);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + dx * t);
    const y = Math.round(y0 + dy * t);
    if (o.texture === "dot" && o.dashAcc) {
      const phase = o.dashAcc.d % dashPeriod;
      o.dashAcc.d += dist / steps;
      if (phase >= dashPeriod / 2) continue;
    }
    stamp(buf, x, y, o);
  }
}

/** M10-19: ref 上で (sx,sy) と4近傍連結の同添字領域を 0/1 マスク化する（走査線・floodFill と同規則）。
 *  読み取りは添字の === 比較のみ・書き込みはマスクの 0/1 のみ（補間・平均・ブレンドなし）。
 *  floodFill(ref指定時) と autoSelectMask(つながり) の共通領域確定部。
 *  M10-22: clip 指定時は clip=0 の画素を**壁扱い**にする（選択範囲クリップ。未指定=従来どおり） */
function regionMask(
  ref: IndexBuf,
  sx: number,
  sy: number,
  clip?: Uint8Array
): Uint8Array {
  const mask = new Uint8Array(PIXELS);
  if (clip && !clip[sy * W + sx]) return mask; // 種が壁の中なら何も選ばない
  const open = (i: number): boolean => !clip || clip[i] !== 0;
  const target = ref[sy * W + sx];
  const stack: number[] = [sy * W + sx];
  while (stack.length) {
    const idx = stack.pop()!;
    const y = (idx / W) | 0;
    let x = idx % W;
    while (x > 0 && ref[y * W + x - 1] === target && mask[y * W + x - 1] === 0 && open(y * W + x - 1)) x--;
    let spanUp = false;
    let spanDown = false;
    while (x < W && ref[y * W + x] === target && mask[y * W + x] === 0 && open(y * W + x)) {
      mask[y * W + x] = 1;
      if (y > 0) {
        const up =
          ref[(y - 1) * W + x] === target && mask[(y - 1) * W + x] === 0 && open((y - 1) * W + x);
        if (up && !spanUp) {
          stack.push((y - 1) * W + x);
          spanUp = true;
        } else if (!up) spanUp = false;
      }
      if (y < H - 1) {
        const down =
          ref[(y + 1) * W + x] === target && mask[(y + 1) * W + x] === 0 && open((y + 1) * W + x);
        if (down && !spanDown) {
          stack.push((y + 1) * W + x);
          spanDown = true;
        } else if (!down) spanDown = false;
      }
      x++;
    }
  }
  return mask;
}

/** M10-19: 自動選択（✨）。ref 上の (sx,sy) と同添字の画素を 0/1 マスクで返す。
 *  global=false: 4近傍連結領域のみ / global=true: 画面全体の同添字すべて。
 *  透明（添字0）のクリックも有効（背景領域の選択は正当）。 */
export function autoSelectMask(
  ref: IndexBuf,
  sx: number,
  sy: number,
  global: boolean
): Uint8Array {
  if (sx < 0 || sx >= W || sy < 0 || sy >= H) return new Uint8Array(PIXELS);
  if (!global) return regionMask(ref, sx, sy);
  const mask = new Uint8Array(PIXELS);
  const target = ref[sy * W + sx];
  for (let i = 0; i < PIXELS; i++) if (ref[i] === target) mask[i] = 1;
  return mask;
}

/** バケツ塗り（4近傍・スキャンライン）。
 *  M5-5 T-3: tone 指定時は「領域マスク算出→toneAt(x,y) が true の画素だけ現在色」
 *  （座標固定＝ブラシのトーンと柄が繋がる。false の画素は元のまま残す）
 *  M10-19: ref 指定時は領域判定を ref に対して行い、塗るのは buf だけ（全レイヤー参照バケツ）。
 *  ref 省略時は従来経路をそのまま通す（1画素も変えない）。 */
export function floodFill(
  buf: IndexBuf,
  sx: number,
  sy: number,
  color: number,
  tone?: ToneTile | null,
  ref?: IndexBuf,
  clip?: Uint8Array
) {
  if (sx < 0 || sx >= W || sy < 0 || sy >= H) return;
  // M10-22: 選択範囲クリップ — clip=0 の画素は壁扱い（種が壁の中なら何もしない）
  if (clip && !clip[sy * W + sx]) return;
  const open = (i: number): boolean => !clip || clip[i] !== 0;
  if (ref) {
    // M10-19: 判定元(ref)と塗り先(buf)が別物なので常に visited マスク方式。
    // 参照上の色と塗り先の状態は無関係のため target === color の早期 return はしない
    //（例: 線画レイヤー参照で、下のレイヤーへ参照と同じ添字を塗るのは正当）
    const mask = regionMask(ref, sx, sy, clip);
    if (tone) {
      // トーンの穴は素通し（従来規則のまま）
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          if (mask[row + x] !== 0 && toneAt(tone, x, y)) buf[row + x] = color;
        }
      }
    } else {
      for (let i = 0; i < PIXELS; i++) if (mask[i] !== 0) buf[i] = color;
    }
    return;
  }
  const target = buf[sy * W + sx];
  if (target === color && !tone) return;
  // トーン時は塗りで領域判定が壊れないよう visited マスクで領域を確定してから適用
  const mask = tone ? new Uint8Array(PIXELS) : null;
  const visited = (i: number): boolean => (mask ? mask[i] !== 0 : buf[i] !== target);
  const markOrPaint = (i: number) => {
    if (mask) mask[i] = 1;
    else buf[i] = color;
  };
  if (mask && target === color) {
    // 同色へのトーン塗り: 領域は広がらない見込みだが、穴あけはできないため何もしない
    // （トーンの穴は「元のまま残す」仕様＝同色なら見た目不変）
    return;
  }
  const stack: number[] = [sy * W + sx];
  while (stack.length) {
    const idx = stack.pop()!;
    const y = (idx / W) | 0;
    let x = idx % W;
    // 左端へ（M10-22: clip=0 は壁）
    while (x > 0 && buf[y * W + x - 1] === target && !visited(y * W + x - 1) && open(y * W + x - 1)) x--;
    let spanUp = false;
    let spanDown = false;
    while (x < W && buf[y * W + x] === target && !visited(y * W + x) && open(y * W + x)) {
      markOrPaint(y * W + x);
      if (y > 0) {
        const up =
          buf[(y - 1) * W + x] === target && !visited((y - 1) * W + x) && open((y - 1) * W + x);
        if (up && !spanUp) {
          stack.push((y - 1) * W + x);
          spanUp = true;
        } else if (!up) spanUp = false;
      }
      if (y < H - 1) {
        const down =
          buf[(y + 1) * W + x] === target && !visited((y + 1) * W + x) && open((y + 1) * W + x);
        if (down && !spanDown) {
          stack.push((y + 1) * W + x);
          spanDown = true;
        } else if (!down) spanDown = false;
      }
      x++;
    }
  }
  // トーン適用（穴は元の画素を残す）
  if (mask && tone) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        if (mask[row + x] !== 0 && toneAt(tone, x, y)) buf[row + x] = color;
      }
    }
  }
}

/** 図形: 直線 */
export function shapeLine(
  buf: IndexBuf,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  o: PenOptions
) {
  strokeSegment(buf, x0, y0, x1, y1, { ...o, texture: "solid", tone: undefined });
}

/** 図形: 四角（fill=塗りつぶし） */
export function shapeRect(
  buf: IndexBuf,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  o: PenOptions,
  fill: boolean
) {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
  if (fill) {
    // M10-22: 塗りつぶしは PenOptions（stamp）を通らない直接代入なのでここでもクリップ判定
    for (let y = Math.max(0, ay); y <= Math.min(H - 1, by); y++)
      for (let x = Math.max(0, ax); x <= Math.min(W - 1, bx); x++) {
        if (o.clip && !o.clip[y * W + x]) continue;
        buf[y * W + x] = o.color;
      }
    return;
  }
  const so = { ...o, texture: "solid" as PenTexture, tone: undefined };
  strokeSegment(buf, ax, ay, bx, ay, so);
  strokeSegment(buf, bx, ay, bx, by, so);
  strokeSegment(buf, bx, by, ax, by, so);
  strokeSegment(buf, ax, by, ax, ay, so);
}

/** 図形: 丸（楕円。fill=塗りつぶし） */
export function shapeEllipse(
  buf: IndexBuf,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  o: PenOptions,
  fill: boolean
) {
  // クリックのみ（ドラッグ幅ゼロ）は1ドット打点にフォールバック
  if (Math.abs(x1 - x0) < 1 && Math.abs(y1 - y0) < 1) {
    stamp(buf, Math.round(x0), Math.round(y0), { ...o, texture: "solid", tone: undefined });
    return;
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const a = Math.max(0.75, Math.abs(x1 - x0) / 2);
  const b = Math.max(0.75, Math.abs(y1 - y0) / 2);
  const t = Math.max(1, o.size);
  const ax0 = Math.max(0, Math.floor(cx - a - t));
  const ax1 = Math.min(W - 1, Math.ceil(cx + a + t));
  const ay0 = Math.max(0, Math.floor(cy - b - t));
  const ay1 = Math.min(H - 1, Math.ceil(cy + b + t));
  const ia = Math.max(0.25, a - t);
  const ib = Math.max(0.25, b - t);
  for (let y = ay0; y <= ay1; y++) {
    for (let x = ax0; x <= ax1; x++) {
      const nx = (x + 0.5 - cx) / a;
      const ny = (y + 0.5 - cy) / b;
      const outer = nx * nx + ny * ny <= 1;
      if (!outer) continue;
      // M10-22: 塗りつぶし/輪郭とも直接代入経路なのでここでクリップ判定
      if (o.clip && !o.clip[y * W + x]) continue;
      if (fill) {
        buf[y * W + x] = o.color;
      } else {
        const mx = (x + 0.5 - cx) / ia;
        const my = (y + 0.5 - cy) / ib;
        if (mx * mx + my * my >= 1) buf[y * W + x] = o.color;
      }
    }
  }
}

/** 文字 → ドットマスク（0/1）。Canvas でレンダして閾値化 */
/**
 * 文字を 0/1 のマスクへラスタライズする（M10-1c で書体対応）。
 *
 * 系統でレンダリング経路を分ける:
 * - dot 系（美咲 / PixelMplus12）: 等倍でレンダし `alpha > 128` で2値化。
 *   設計グリッドの整数倍サイズなら、この閾値で参照ビットマップと一致する。
 * - outline 系（丸文字 / ポップ / 明朝）: 3倍サイズでレンダ → 3×3 平均 → `>= 0.5` で2値化。
 *   等倍＋閾値だと細い筆画が飛ぶ。
 *
 * **索引バッファとの関係**: ここで平均しているのは 0〜255 の**アルファ値**であって
 * colorTable の添字ではない。戻り値は 0/1 のマスクで、焼き込みは `stampMask` が
 * 単色を代入するだけ。索引バッファへの補間・平均・ブレンドは一切発生しない。
 *
 * **M11-12**: 改行（`\n`）に対応し、**マスクをキャンバス（320×240）に切るのをやめた**。
 * 旧実装は `Math.min(W/H, …)` で生成の時点で切っていたため、はみ出す文字は
 * 「置く前に失われて」いた（＝消して打ち直すしかなかった）。戻り値のマスクは
 * キャンバスより大きくなり得る。**はみ出しの切り出しは `stampMask` の責務**
 *（負のオフセットも受ける）。行送りは `ceil(px * 1.35)`＝1行だけのときの高さと同値なので、
 * 単一行・単一列の出力は M10-11 時点と1画素も変わらない。
 */
export function textToMask(
  text: string,
  px: number,
  opts: TextOpts
): { w: number; h: number; data: Uint8Array } | null {
  const def = fontDef(opts.family);
  // Bold を持たない書体で bold を立てるとブラウザが合成ボールドを作り、
  // ドットのグリッドが壊れる。UI 側の制御だけに頼らずここで必ず落とす。
  const bold = def.hasBold && opts.bold;
  const oversample = def.kind === "outline" ? 3 : 1;
  const renderPx = px * oversample;
  const fontStr = `${bold ? "bold " : ""}${renderPx}px "${def.cssFamily}"`;

  const vertical = !!opts.vertical;
  // M11-12: 改行で分ける。横書き＝行が下へ / 縦書き＝列が**左へ**（日本語の縦組の流儀）。
  // 空行も1行ぶんの場所を取る（split の結果に空文字が残るのでそのまま数に入る）
  const lines = text.split("\n");
  // M10-11: 縦書きは 1文字＝1セル（送り px）。文字数は書記素ではなくコードポイント単位
  // （サロゲートペアを割らないため Array.from を使う）
  const cols = vertical ? lines.map((l) => Array.from(l)) : [];
  const lineH = Math.ceil(px * 1.35); // 行送り＝1行だけのときの高さと同じ値

  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = fontStr;
  // 出力（等倍）のサイズ。余白 1px は現行の挙動を維持する。
  // M11-12: **キャンバス（320×240）でのクランプは廃止**。ここで切ると
  // 「はみ出す文字を置く前に失う」（＝消して打ち直すしかない）ので、
  // マスクはキャンバスより大きくてよいものとし、切り出しは stampMask に任せる
  let rawW: number;
  let rawH: number;
  if (vertical) {
    rawW = px * cols.length + 2;
    let maxLen = 0;
    for (const c of cols) maxLen = Math.max(maxLen, c.length);
    rawH = px * maxLen + 2;
  } else {
    let maxW = 0;
    for (const l of lines) {
      if (!l) continue;
      maxW = Math.max(maxW, Math.ceil(probe.measureText(l).width / oversample));
    }
    rawW = maxW + 2;
    rawH = lineH * lines.length + 2;
  }
  if (text.length === 0 || rawW <= 2 || rawH <= 2) return null;
  // 安全弁: 「キャンバスより大きくてよい」＝無制限ではない。canvas の実際的な上限と、
  // 打鍵ごとに作り直すコストの両方を抑える。通常の入力（100文字程度）では発火しない
  const MASK_MAX_SIDE = 4096; // キャンバス約13枚分
  const MASK_MAX_CELLS = Math.floor(32_000_000 / (oversample * oversample));
  const w = Math.min(MASK_MAX_SIDE, rawW);
  let h = Math.min(MASK_MAX_SIDE, rawH);
  if (w * h > MASK_MAX_CELLS) h = Math.max(1, Math.floor(MASK_MAX_CELLS / w));

  const canvas = document.createElement("canvas");
  canvas.width = w * oversample;
  canvas.height = h * oversample;
  const c2 = canvas.getContext("2d")!;
  c2.font = fontStr;
  c2.textBaseline = "top";
  c2.fillStyle = "#000";
  if (vertical) {
    // セル（倍率つき）。左右に余白1px＝oversample を取るのは横書きと同じ流儀
    const cell = px * oversample;
    const half = cell / 2;
    // M11-12: 列は**右から左**へ並ぶ。1列目（読み始め）が一番右
    for (let j = 0; j < cols.length; j++) {
      const left = oversample + (cols.length - 1 - j) * cell;
      if (left >= canvas.width) continue;
      const chars = cols[j];
      for (let k = 0; k < chars.length; k++) {
        const top = oversample + k * cell;
        if (top >= canvas.height) break; // 安全弁に当たった分だけ下端で切る
        const ch = chars[k];
        if (V_ROTATE.has(ch) || isAsciiPrintable(ch)) {
          // 90°時計回り。セル中心へ移してから回すので、回転後もセル内に収まる
          c2.save();
          c2.translate(left + half, top + half);
          c2.rotate(Math.PI / 2);
          c2.textAlign = "center";
          c2.textBaseline = "middle";
          c2.fillText(ch, 0, 0);
          c2.restore();
          c2.textAlign = "start";
          c2.textBaseline = "top";
        } else if (V_PUNCT_TOPRIGHT.has(ch)) {
          // 句読点は右上へ。グリフは em ボックスの左下に描かれるので、
          // 描画原点を右へ半角・上へ半角ずらすとセルの右上区画に収まる
          c2.fillText(ch, left + half, top - half);
        } else {
          // かな・漢字・？！・全角英数・矢印などは立てたまま、セル中央に置く
          c2.textAlign = "center";
          c2.fillText(ch, left + half, top);
          c2.textAlign = "start";
        }
      }
    }
  } else {
    // 余白も倍率ぶん取り、縮小後に現行と同じ 1px になるようにする。
    // M11-12: 2行目以降は行送り（lineH）ぶんずつ下へ（左揃え）
    for (let i = 0; i < lines.length; i++) {
      const top = oversample + i * lineH * oversample;
      if (top >= canvas.height) break; // 安全弁に当たった分だけ下端で切る
      if (lines[i]) c2.fillText(lines[i], oversample, top);
    }
  }
  const img = c2.getImageData(0, 0, canvas.width, canvas.height).data;

  const data = new Uint8Array(w * h);
  if (oversample === 1) {
    for (let i = 0; i < w * h; i++) data[i] = img[i * 4 + 3] > 128 ? 1 : 0;
    return { w, h, data };
  }
  const sw = canvas.width;
  const area = oversample * oversample;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let oy = 0; oy < oversample; oy++) {
        for (let ox = 0; ox < oversample; ox++) {
          sum += img[(((y * oversample + oy) * sw) + x * oversample + ox) * 4 + 3];
        }
      }
      // 9画素の平均カバレッジが半分以上なら塗る
      data[y * w + x] = sum / area >= 128 ? 1 : 0;
    }
  }
  return { w, h, data };
}

/** マスクを色で焼き込む（M10-22: clip 指定時は選択範囲内にのみ書く）。
 *
 *  M11-12: `textToMask` がキャンバスより大きなマスクを返すようになり、`dx`/`dy` には
 *  **負の値**も来る（画面の外へはみ出した文字）。**キャンバスと重なる範囲だけ**を回すので、
 *  範囲外の索引バッファには触れない（`buf` の長さは常に 320×240 のまま）。
 *  行・列の単位で先に刈るため、巨大なマスクでも画面外を空回りしない。 */
export function stampMask(
  buf: IndexBuf,
  mask: { w: number; h: number; data: Uint8Array },
  dx: number,
  dy: number,
  color: number,
  clip?: Uint8Array
) {
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  const x0 = Math.max(0, -ox);
  const x1 = Math.min(mask.w, W - ox);
  const y0 = Math.max(0, -oy);
  const y1 = Math.min(mask.h, H - oy);
  for (let y = y0; y < y1; y++) {
    const ty = oy + y;
    const row = y * mask.w;
    for (let x = x0; x < x1; x++) {
      if (!mask.data[row + x]) continue;
      const tx = ox + x;
      if (clip && !clip[ty * W + tx]) continue;
      buf[ty * W + tx] = color;
    }
  }
}

// ---------- 範囲選択 ----------

/** 矩形マスク */
export function rectMask(x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const mask = new Uint8Array(PIXELS);
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
  for (let y = Math.max(0, ay); y <= Math.min(H - 1, by); y++)
    mask.fill(1, y * W + Math.max(0, ax), y * W + Math.min(W - 1, bx) + 1);
  return mask;
}

/** 自由選択（多角形・even-odd スキャンライン） */
export function lassoMask(points: { x: number; y: number }[]): Uint8Array {
  const mask = new Uint8Array(PIXELS);
  const n = points.length;
  if (n < 3) return mask;
  for (let y = 0; y < H; y++) {
    const xs: number[] = [];
    const yc = y + 0.5;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (a.y === b.y) continue;
      const [lo, hi] = a.y < b.y ? [a, b] : [b, a];
      if (yc < lo.y || yc >= hi.y) continue;
      xs.push(lo.x + ((yc - lo.y) / (hi.y - lo.y)) * (hi.x - lo.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // ピクセル中心（x+0.5）が [xs[k], xs[k+1]) に入る列だけ塗る（半開区間・右端の1列過選択を防ぐ）
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      if (x1 >= x0) mask.fill(1, y * W + x0, y * W + x1 + 1);
    }
  }
  return mask;
}

/** M11-8: 選択範囲を反転する（選ばれていた所と外側を入れ替える）。2回で元に戻る */
export function invertMask(mask: Uint8Array): Uint8Array {
  const m = new Uint8Array(PIXELS);
  for (let i = 0; i < PIXELS; i++) m[i] = mask[i] ? 0 : 1;
  return m;
}

/** M11-8: 外側へ1px 広げる（3×3 の膨張）。キャンバスの外へは広がらない＝端でクランプ */
export function expandMask(mask: Uint8Array): Uint8Array {
  const m = new Uint8Array(PIXELS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(H - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(W - 1, x + 1);
      for (let ny = y0; ny <= y1; ny++) for (let nx = x0; nx <= x1; nx++) m[ny * W + nx] = 1;
    }
  }
  return m;
}

/** M11-8: 内側へ1px 狭める（3×3 の収縮）。**キャンバスの外は「選ばれていない」扱い**なので、
 *  端まで選んでいる範囲は端からも縮む（一般的な画像編集ソフトと同じ）。
 *  全部消えたら呼び出し側で選択を解除する */
export function contractMask(mask: Uint8Array): Uint8Array {
  const m = new Uint8Array(PIXELS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      let keep = true;
      for (let ny = y - 1; ny <= y + 1 && keep; ny++) {
        for (let nx = x - 1; nx <= x + 1; nx++) {
          if (nx < 0 || nx >= W || ny < 0 || ny >= H || !mask[ny * W + nx]) {
            keep = false;
            break;
          }
        }
      }
      if (keep) m[y * W + x] = 1;
    }
  }
  return m;
}

export function maskBBox(
  mask: Uint8Array
): { x: number; y: number; w: number; h: number } | null {
  let minX = W,
    minY = H,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (mask[y * W + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 選択範囲を浮動バッファとして抜き出す（cut=trueで元から消す） */
export interface FloatBuf {
  w: number;
  h: number;
  /** colorTable index（0=透明）。幅は抜き出し元レイヤーに追従（16bit索引は255超を含み得る） */
  data: IndexBuf;
  /** 元の位置（bbox 左上） */
  ox: number;
  oy: number;
}

export function extractFloat(
  buf: IndexBuf,
  mask: Uint8Array,
  cut: boolean
): FloatBuf | null {
  const bbox = maskBBox(mask);
  if (!bbox) return null;
  // 元レイヤーと同じ幅で確保（8bitに固定すると16bit索引が truncate される）
  const data: IndexBuf =
    buf instanceof Uint16Array
      ? new Uint16Array(bbox.w * bbox.h)
      : new Uint8Array(bbox.w * bbox.h);
  for (let y = 0; y < bbox.h; y++)
    for (let x = 0; x < bbox.w; x++) {
      const src = (bbox.y + y) * W + (bbox.x + x);
      if (mask[src]) {
        data[y * bbox.w + x] = buf[src];
        if (cut) buf[src] = 0;
      }
    }
  return { w: bbox.w, h: bbox.h, data, ox: bbox.x, oy: bbox.y };
}

/** マスク内を消す */
export function deleteMasked(buf: IndexBuf, mask: Uint8Array) {
  for (let i = 0; i < PIXELS; i++) if (mask[i]) buf[i] = 0;
}

// ---------- 変形（高精度演算 → ドット確定） ----------

export interface Transform {
  tx: number;
  ty: number;
  /** ラジアン */
  angle: number;
  sx: number;
  sy: number;
  flipH: boolean;
  flipV: boolean;
}

/** 浮動バッファを変形して焼き込む（nearest-neighbor・結果は320×240格子に確定） */
export function blitFloatTransformed(buf: IndexBuf, f: FloatBuf, t: Transform) {
  const cx = f.ox + f.w / 2 + t.tx;
  const cy = f.oy + f.h / 2 + t.ty;
  const cos = Math.cos(t.angle);
  const sin = Math.sin(t.angle);
  const sx = t.sx * (t.flipH ? -1 : 1);
  const sy = t.sy * (t.flipV ? -1 : 1);
  // 変形後の bbox を4隅から算出
  const hw = (f.w / 2) * Math.abs(sx);
  const hh = (f.h / 2) * Math.abs(sy);
  const ext = Math.abs(cos) * hw + Math.abs(sin) * hh;
  const eyt = Math.abs(sin) * hw + Math.abs(cos) * hh;
  const x0 = Math.max(0, Math.floor(cx - ext - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + ext + 1));
  const y0 = Math.max(0, Math.floor(cy - eyt - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + eyt + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // 逆変換: 回転→スケールの逆
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const rx = (cos * dx + sin * dy) / sx;
      const ry = (-sin * dx + cos * dy) / sy;
      const sxp = Math.floor(rx + f.w / 2);
      const syp = Math.floor(ry + f.h / 2);
      if (sxp < 0 || sxp >= f.w || syp < 0 || syp >= f.h) continue;
      const v = f.data[syp * f.w + sxp];
      if (v !== 0) buf[y * W + x] = v;
    }
  }
}
