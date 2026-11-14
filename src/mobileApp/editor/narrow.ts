// V221 (M-2b-2・決-20・指示書 ■2(8)): 描けない大きさになったときの決まり（画面を持たない・v221 [G]・v222 [G] が見る）。
// ★V222 (M-2b-3a・E-2): 案内を出すのは、狭・低と、中の配置が入らない幅（744 未満）の中だけ（決まりは arrange.ts の guideNeeded）。
//  広と、744 以上の中では出さない。作品は開いたまま、描きかけは確定する（入った瞬間に mbInterrupt）。案内が消えると続きから描ける。
import { guideNeeded } from "./arrange";

export interface NarrowStep {
  /** 案内を出している */
  narrow: boolean;
  /** いま切り替わった */
  changed: boolean;
  /** 描きかけを確定する（案内に入った瞬間） */
  interrupt: boolean;
}

export function narrowStep(prevNarrow: boolean, w: number, h: number): NarrowStep {
  const narrow = guideNeeded(w, h);
  const changed = narrow !== prevNarrow;
  return { narrow, changed, interrupt: changed && narrow };
}
