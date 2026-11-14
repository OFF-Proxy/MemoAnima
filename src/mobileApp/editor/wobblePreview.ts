// V223 (M-2b-3b-1・UI §5-7・指示書 ■3 の F-7): ゆらゆらの小窓の**見本**を作る計算。
//
// ★要件書 §5-0 の「一時的に書く」: PC の画面（src/editor/editor.ts の openWobbleDialog の中の build＝見本）と同じ計算を、モバイルの側に書いた写し。
//   元の場所: src/editor/editor.ts の openWobbleDialog（見本を作る build・`buildWobbleFrame` と `compositeFrame`）
//   書いた場所: ここ（buildWobblePreview）
//  次の Windows の回で共通（コアか wobble.ts）へ移す。移すまでは、ここで作った見本の絵と［つくる］（コアの applyWobble）で作られたコマの合成が
//  画素まで同じことを scripts/v223_smoke.ts [Y] が見る。
// ★種はコアの wobbleSeed(kind, strength)（呼び出し側が受け継いだ口から渡す）。差分は wobble.ts の buildWobbleFrame で 1 枚ずつ作り、
//  合成（320×240 の RGBA）だけを持つ（コマの写しを抱え続けない）。1 枚ごとに譲り、その間に値が変わったら・閉じたらやめる。
import type { Project } from "../../editor/model";
import { FPS_TABLE } from "../../editor/model";
import { compositeFrame } from "../../editor/render";
import { buildWobbleFrame, WOBBLE_STRENGTH_DEFAULT, WOBBLE_STRENGTH_MIN, WOBBLE_STRENGTH_MAX, type WobbleKind, type WobbleStrength } from "../../editor/wobble";
import { WarpField } from "../../editor/warp";

export interface WobbleOpt {
  count: number;
  kind: WobbleKind;
  strength: WobbleStrength;
  target: "all" | "active";
}

/** 始めの値（PC の Editor.wobbleLast と同じ: 枚数 3・強さ 5・線がふるえる・全レイヤー） */
export const WOBBLE_FIRST: Readonly<WobbleOpt> = { count: 3, strength: WOBBLE_STRENGTH_DEFAULT, kind: "line", target: "all" };
export const WOBBLE_COUNTS: readonly number[] = [2, 3, 4];
export { WOBBLE_STRENGTH_MIN, WOBBLE_STRENGTH_MAX };

/** ★アプリを閉じるまで覚える値（PC と同じ・保存しない） */
let last: WobbleOpt = { ...WOBBLE_FIRST };
export function wobbleLast(): WobbleOpt {
  return { ...last };
}
export function rememberWobble(o: WobbleOpt): void {
  last = { ...o };
}

/** 見本の速さ（作品の速さ・4fps より遅い作品は 4fps） */
export function wobblePreviewFps(p: Project): number {
  return Math.max(4, FPS_TABLE[p.speedIndex] ?? 8);
}

/** 強さを 1〜10 に収める */
export function clampStrength(n: number): WobbleStrength {
  return Math.max(WOBBLE_STRENGTH_MIN, Math.min(WOBBLE_STRENGTH_MAX, Math.round(n))) as WobbleStrength;
}

/**
 * 見本の絵（[0] は元のコマの合成・1〜 が差分の合成）。alive が false を返したら途中でやめて null。
 * @param seed コアの wobbleSeed(opt.kind, opt.strength)
 * @param mask 範囲選択（無ければ null）
 * @param active 「選んでいるもの」の対象のレイヤー（開いたときに決めた集まり）。opt.target が "all" のときは使わない
 */
export async function buildWobblePreview(
  proj: Project,
  frameIndex: number,
  opt: WobbleOpt,
  seed: number,
  mask: Uint8Array | null,
  active: ReadonlySet<string>,
  pause: () => Promise<void>,
  alive: () => boolean
): Promise<Uint32Array[] | null> {
  const cur = proj.frames[frameIndex];
  if (!cur) return null;
  const frames: Uint32Array[] = [compositeFrame(proj, frameIndex)];
  const field = new WarpField();
  for (let k = 0; k < opt.count - 1; k++) {
    await pause();
    if (!alive()) return null;
    const nf = buildWobbleFrame(proj, cur, k, opt.kind, opt.strength, seed, mask, opt.target === "active" ? active : null, field);
    frames.push(compositeFrame({ ...proj, frames: [nf] }, 0));
  }
  return frames;
}
