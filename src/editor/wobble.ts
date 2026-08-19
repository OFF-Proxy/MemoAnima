// M10-3: ゆらゆら差分の自動生成（純関数部分）。
// M11-20 で editor.ts から切り出した。**DOM 非依存**（scripts/*_smoke.ts と mcp/ から呼べる）。
// 「全レイヤー」経路の計算順序・シード派生・applyWarp の引数は M10-3 当時（editor.ts 内）と
// 一字一句同じに保つこと ＝ 従来の結果とビット単位で同一（scripts/m1120_smoke.ts が参照実装と突き合わせる）。

import { Frame, Project, cloneFrame } from "./model";
import { WarpField, applyWarp } from "./warp";

// M10-3: ゆらゆら差分。種類と強さ（弱/中/強）
export type WobbleKind = "line" | "whole";
export type WobbleStrength = 0 | 1 | 2;

/** M10-3 P-6: ゆらゆらの波長(L)と振幅(A)。**波長は固定**し、枚ごとの違いはシードだけで作る。
 *  振幅の下限を REQ の 1.5 / 0.5 ちょうどにしていないのは意図的で、0.5px だと
 *  `Math.round` で動く画素がごくわずかになり「押したのに何も起きない」に見えるため。 */
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

/**
 * M10-3: ゆらゆら差分を作る。**元のコマ `cur` は読むだけで一切変更しない。**
 * 戻り値は「原本の直後に挿入する count−1 枚」。`p.frames` には触らない。
 *
 * - `seedBase` は呼び出し側が作る（editor は hashCurrentFrame ^ コマ数 ^ コマ位置 ^ 種類/強さ。
 *   `?wobble` は固定値を渡して決定性を検証する）
 * - `mask`（選択範囲・M11-8 P-4）: あれば範囲内だけを揺らす（範囲外は applyWarp が dst[i]=src[i]＝複製と同値）
 * - M11-20 `targetLayerId`: null なら**全レイヤー**（従来どおり・非表示レイヤーも含む）。
 *   レイヤー id を渡すと**そのレイヤーだけ**を歪め、他のレイヤーは cloneFrame の複製のまま
 *   （＝元コマとピクセル不変）。場（field）の作り方・シード派生は対象によらず同じなので、
 *   単体モードの対象レイヤーの画素は全レイヤーモードの同じレイヤーとビット同一になる
 */
export function buildWobbleFrames(
  p: Project,
  cur: Frame,
  count: number, // 2 | 3 | 4（原本を含めた総枚数）
  kind: WobbleKind,
  strength: WobbleStrength,
  seedBase: number,
  mask: Uint8Array | null,
  targetLayerId: string | null = null
): Frame[] {
  const { L, A } = WOBBLE_TABLE[kind][strength];
  const field = new WarpField();
  const out: Frame[] = [];
  for (let k = 0; k < count - 1; k++) {
    const seedK = (seedBase + Math.imul(k + 1, 0x9e3779b9)) >>> 0;
    // dx と dy に別シード（同じだと全画素が斜めにずれるだけで「ゆれ」に見えない）
    field.setValueNoise(seedK, (seedK ^ 0x6d2b79f5) >>> 0, L, A);
    const nf = cloneFrame(cur);
    // 効果音は複製しない（同じ音が N 回鳴るのは誰も望まない）
    nf.se = undefined;
    // **1枚につき変位場は1つ**。全レイヤーに同じ場を当てるのでレイヤー間でズレない。
    // 非表示レイヤーも含める（除外すると絵の整合が崩れる）
    for (const ld of p.layerDefs) {
      if (targetLayerId !== null && ld.id !== targetLayerId) continue; // M11-20: 単体モードは対象だけ
      const src = cur.layers[ld.id];
      const dst = nf.layers[ld.id];
      // src と dst は別実体（cloneFrame → copyIndexBuf が新しい typed array を作る）。
      // 適用元は**常に原本**で、直前の生成結果には絶対に再適用しない。
      if (src && dst) applyWarp(src, dst, field, mask);
    }
    out.push(nf);
  }
  return out;
}
