// V221 (M-2b-2): モバイルの画面の小さな部品（要素を作る・アイコン・押せるもの）。
//
// ★文言は呼び出し側が辞書から渡す（ここに文を持たない）。訳文を属性の字に埋め込まない（i18n の検査6）＝名前はプロパティで付ける。
// ★色は CSS の変数だけ（ここに色を書かない＝U-9）。
import { mobileIconSvg, type MobileIconId } from "../../mobile/icons";

type Child = Node | string | null | undefined | false;

/** 要素を作る（属性は文字列か真偽。on〜 は付けない＝押す決まりは tap.ts） */
export function h(tag: string, cls = "", ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}

/** アイコン（飾り・aria-hidden）の span */
export function icon(id: MobileIconId, size = 22): HTMLElement {
  const s = document.createElement("span");
  s.className = "mb-ic";
  s.innerHTML = mobileIconSvg(id, size);
  return s;
}

/** 押せるもの（role=button・名前は読み上げにも使う）。act は data で持ち、押したことにするのは tap.ts（離したとき） */
export function btn(cls: string, name: string, act: () => void, ...kids: Child[]): HTMLElement {
  const b = h("button", `mb-btn ${cls}`, ...kids);
  (b as HTMLButtonElement).type = "button";
  b.ariaLabel = name;
  bindAct(b, act);
  return b;
}

/** まだ無い操作（置き場だけ・押せない・お知らせも出さない・読み上げの名前は付ける） */
export function disabledBtn(cls: string, name: string, ...kids: Child[]): HTMLElement {
  const b = h("button", `mb-btn mb-off ${cls}`, ...kids);
  (b as HTMLButtonElement).type = "button";
  b.ariaLabel = name;
  b.setAttribute("aria-disabled", "true");
  return b;
}

const ACTS = new WeakMap<Element, () => void>();

/** 押したときの手続きを付ける（tap.ts が離したときに呼ぶ） */
export function bindAct(el: Element, act: () => void): void {
  ACTS.set(el, act);
  el.setAttribute("data-act", "1");
}

/** 押せるものの手続き（無ければ null） */
export function actOf(el: Element | null): { el: Element; act: () => void } | null {
  let n: Element | null = el;
  while (n) {
    const a = ACTS.get(n);
    if (a) {
      if (n.getAttribute("aria-disabled") === "true") return null;
      return { el: n, act: a };
    }
    n = n.parentElement;
  }
  return null;
}

/** 文字だけの span */
export function txt(cls: string, s: string): HTMLElement {
  const e = h("span", cls);
  e.textContent = s;
  return e;
}
