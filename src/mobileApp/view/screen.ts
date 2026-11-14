// V225 (M-2c・指示書 ■3 の L-1): **画面の大きさを読む 1 か所**（描く画面・ライブラリ・設定が同じ口を使う）。
//
// ★`window.innerWidth`・`innerHeight` を直に読むのはここだけ（scripts/v225_smoke.ts [L] が src/mobileApp の全部を数える。
//  V222 までは描く画面の mbScreen の 1 か所だった＝v222 [C] は V225 の写しを外した字で見る）。
// ★確かめ画面の印のビルドだけ、差し替えた大きさを返す（区分の切り替え・案内・端末の表を、シミュレーターを替えずに見る口）。
let override: { w: number; h: number } | null = null;

/** 確かめ画面の印のビルドだけが呼ぶ（null で戻す） */
export function setScreenOverride(size: { w: number; h: number } | null): void {
  override = size;
}
export function screenOverride(): { w: number; h: number } | null {
  return override ? { ...override } : null;
}

/** いまの画面（ウィンドウ）の大きさ（CSS の px） */
export function screenSize(): { w: number; h: number } {
  if (override) return { ...override };
  return { w: window.innerWidth, h: window.innerHeight };
}

/** 差し替えていない本物の幅（確かめ画面の数え＝横スクロールの有無を見るときだけ） */
export function realScreenWidth(): number {
  return window.innerWidth;
}
