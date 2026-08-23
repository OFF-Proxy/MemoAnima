// M17: カスタムトーン（マイ柄）— 範囲選択から登録した自分の柄で塗る。
//
// 設計の要点:
// - マイ柄は settings にだけ保存する（プロジェクトの保存形式には触れない。塗った結果はただの索引ピクセル）。
//   色は colorTable の索引ではなく **RGB（"#rrggbb"）** で持つ＝パレットが違う作品でも同じ色が出る。
// - 既存の ToneTile（1ビット・22種）とは**別型**。描画エンジンへは「解決済みの色タイル」`ColorTile`
//   （raster.ts・索引 / -1=透明）として渡す。マイ柄を使わない描画はこのファイルを一切通らない。
// - 16bit 昇格の罠: 色の解決（ensureColor）は 257 色目でプロジェクト全体のバッファを差し替える。
//   **`buildColorTile` で全色を一括解決してから、描く側がバッファを取る**（順序が逆だと保持参照が死ぬ）。
//   この順序は editor.ts の全経路（ペン・ブラシ・バケツ・囲い塗り・かすり消し）で守る。
import { W, H, type IndexBuf } from "./model";
import { regionMask, colorTileAt, type ColorTile } from "./raster";

/** タイルの最大辺長（超える選択は左上をこの大きさで切り出す） */
export const CUSTOM_TONE_MAX_SIZE = 32;
/** 登録できる個数の上限（満杯なら一番古い＝登録順の先頭を消すか確認） */
export const CUSTOM_TONE_MAX_COUNT = 12;
/** トーン選択 id（brushToneId 等）でマイ柄を指す接頭辞。既存 TONE_TILES の id と字面が重ならない */
export const CUSTOM_TONE_ID_PREFIX = "custom:";

/** 保存されるマイ柄（settings.customTones の1要素）。colors は w*h 個の "#rrggbb" か ""（透明） */
export interface CustomTone {
  /** 登録ごとに増える安定 id（消しても詰めない＝選択中の id が別の柄を指さない） */
  id: number;
  w: number;
  h: number;
  colors: string[];
}

export function customToneKey(id: number): string {
  return CUSTOM_TONE_ID_PREFIX + id;
}

/** "custom:12" → 12。マイ柄でなければ null */
export function parseCustomToneKey(key: string): number | null {
  if (!key.startsWith(CUSTOM_TONE_ID_PREFIX)) return null;
  const n = Number(key.slice(CUSTOM_TONE_ID_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const HEX6 = /^#[0-9a-f]{6}$/;

/** 範囲選択から柄を切り出す（純関数）。
 *  - 範囲は**選択マスクの外接矩形**。その中で mask=1 かつ buf≠0 の画素だけ色（colorTable から RGB）、ほかは透明
 *    （色は colorTable の実色＝索引の色。レイヤーカラー（M15・表示だけ）は反映しない。スポイトと同じ規約）
 *  - 外接矩形が maxSize を超えれば**左上 maxSize×maxSize** に切り出し（cropped=true で知らせる。軸ごとに独立）。
 *    左上の窓に見えている画素が1つも無いとき（絵が右下にだけある等）は、**最初に見えている画素（行優先）を
 *    左上にした窓**へずらす＝「絵があるのに透明だけと言われる」拒否を避ける
 *  - 選択が無い／見えている画素が1つも無い（全透明）なら null（登録拒否） */
export function captureCustomTone(
  buf: IndexBuf,
  mask: Uint8Array,
  colorTable: string[],
  maxSize = CUSTOM_TONE_MAX_SIZE
): { w: number; h: number; colors: string[]; cropped: boolean } | null {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  let fx = -1, fy = -1; // 行優先で最初に見えている画素
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!mask[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (fx < 0 && buf[row + x] !== 0) { fx = x; fy = y; }
    }
  }
  if (x1 < 0) return null; // 選択なし
  if (fx < 0) return null; // 全透明は拒否
  const fullW = x1 - x0 + 1;
  const fullH = y1 - y0 + 1;
  const w = Math.min(maxSize, fullW);
  const h = Math.min(maxSize, fullH);
  const cropped = w < fullW || h < fullH;
  // 左上の窓に見えている画素が無ければ、最初の見えている画素を左上に据える（窓は外接矩形の内側に収める）
  let ox = x0, oy = y0;
  if (cropped && !(fx < x0 + w && fy < y0 + h)) {
    ox = Math.min(fx, x1 - w + 1);
    oy = Math.min(fy, y1 - h + 1);
  }
  const colors: string[] = new Array(w * h).fill("");
  let any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (oy + y) * W + (ox + x);
      if (!mask[i]) continue;
      const v = buf[i];
      if (v === 0) continue;
      const hex = (colorTable[v] ?? "").toLowerCase();
      if (!HEX6.test(hex)) continue;
      colors[y * w + x] = hex;
      any = true;
    }
  }
  if (!any) return null; // 色が解決できない（壊れた colorTable）ときだけここに来る
  return { w, h, colors, cropped };
}

/** マイ柄 → 描画エンジン用の色タイル（解決済み索引）。
 *  - `{ resolve }`: 「登録した色で塗る」。各色を resolve（ensureColor 相当）で索引へ。**同じ色は1回だけ**解決
 *  - `{ color }`: 「形だけ」。非透明画素を全部その索引に（現在色／かすり消しは 0）
 *  透明（""）は -1。★呼び出し側はこの関数の**後で**バッファを取ること（resolve が昇格し得る） */
export function buildColorTile(
  ct: { w: number; h: number; colors: string[] },
  mode: { resolve: (hex: string) => number } | { color: number }
): ColorTile {
  const idx = new Int32Array(ct.w * ct.h).fill(-1);
  if ("color" in mode) {
    for (let i = 0; i < idx.length; i++) if (ct.colors[i]) idx[i] = mode.color;
    return { w: ct.w, h: ct.h, idx };
  }
  const memo = new Map<string, number>();
  for (let i = 0; i < idx.length; i++) {
    const hex = ct.colors[i];
    if (!hex) continue;
    let v = memo.get(hex);
    if (v === undefined) {
      v = mode.resolve(hex);
      memo.set(hex, v);
    }
    idx[i] = v;
  }
  return { w: ct.w, h: ct.h, idx };
}

/** マスク内の画素へ色タイルを適用する（囲い塗り・バケツの共通の塗り込み）。
 *  透明(-1)は触らない。索引の置き換えのみ（混色なし）。戻り値＝1画素でも変わったか */
export function applyColorTile(buf: IndexBuf, mask: Uint8Array, ct: ColorTile, shift = 0): boolean {
  let changed = false;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      const v = colorTileAt(ct, x, y, shift);
      if (v < 0 || buf[i] === v) continue;
      buf[i] = v;
      changed = true;
    }
  }
  return changed;
}

/** マイ柄のバケツ塗り。領域確定は既存 floodFill と同じ規則（regionMask＝4近傍・clip は壁）で、
 *  ref 指定時は ref 上で判定して buf に塗る（全レイヤー参照）。塗り込みは applyColorTile。 */
export function floodFillColorTile(
  buf: IndexBuf,
  sx: number,
  sy: number,
  ct: ColorTile,
  ref?: IndexBuf,
  clip?: Uint8Array,
  shift = 0
): boolean {
  if (sx < 0 || sx >= W || sy < 0 || sy >= H) return false;
  if (clip && !clip[sy * W + sx]) return false;
  const mask = regionMask(ref ?? buf, sx, sy, clip);
  return applyColorTile(buf, mask, ct, shift);
}

/** settings.json の customTones を正規化する。**壊れた要素だけ捨てる**（全体は捨てない）。
 *  旧 settings（キー無し）は []。id は整数・重複なし（不正なら振り直し）。上限 CUSTOM_TONE_MAX_COUNT。 */
export function sanitizeCustomTones(raw: unknown): CustomTone[] {
  const out: CustomTone[] = [];
  if (!Array.isArray(raw)) return out;
  const used = new Set<number>();
  let next = 1;
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const w = o.w, h = o.h;
    if (!Number.isInteger(w) || !Number.isInteger(h)) continue;
    if ((w as number) < 1 || (w as number) > CUSTOM_TONE_MAX_SIZE) continue;
    if ((h as number) < 1 || (h as number) > CUSTOM_TONE_MAX_SIZE) continue;
    if (!Array.isArray(o.colors) || o.colors.length !== (w as number) * (h as number)) continue;
    const colors: string[] = [];
    let any = false;
    let bad = false;
    for (const c of o.colors) {
      if (typeof c !== "string") { bad = true; break; }
      const hex = c.toLowerCase();
      if (hex === "") { colors.push(""); continue; }
      if (!HEX6.test(hex)) { bad = true; break; }
      colors.push(hex);
      any = true;
    }
    if (bad || !any) continue; // 全透明・壊れた色は捨てる
    let id = Number.isInteger(o.id) && (o.id as number) >= 0 ? (o.id as number) : -1;
    if (id < 0 || used.has(id)) {
      while (used.has(next)) next++;
      id = next;
    }
    used.add(id);
    if (id >= next) next = id + 1;
    out.push({ id, w: w as number, h: h as number, colors });
    if (out.length >= CUSTOM_TONE_MAX_COUNT) break;
  }
  return out;
}

/** 次に登録する柄の id（既存の最大＋1・消しても詰めない） */
export function nextCustomToneId(list: CustomTone[]): number {
  let m = 0;
  for (const c of list) if (c.id >= m) m = c.id + 1;
  return m;
}
