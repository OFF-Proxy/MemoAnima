// V221 (M-2b-2): 描く画面の外（仮の一覧・確認とお知らせの層）のボタンを、描く画面と同じ決まり（離したときに押したことにする）で押す。
//
// ★描く画面の根（`data-own-input` の付いた要素）の中の出来事は、描く画面が自分で振り分け層に通すので、ここでは見ない。
// ★描く画面の外には描く場所が無いので、振り分け層を通さずに全部をボタンへ通す（"ui"）。
import { TapManager } from "./tap";

let installed = false;
/** ★V221（第三者レビューの指摘 1）: 描く画面が開いている間は、層（確認とお知らせ）の接触も描く画面の振り分け層を通す
 *  （ペンが触れている間と離して 300ms の指＝手のひらを捨てる決まりを、確認のボタンにも効かせる）。"ui" 以外は押したことにしない */
let routeHook: ((e: PointerEvent) => "ui" | "consumed" | "dropped") | null = null;
let tapRef: TapManager | null = null;
export function setGlobalRouteHook(h: typeof routeHook): void {
  routeHook = h;
}
/** 振り分け層が取り上げた接触（uiCancel）を、層のボタンでも押したことにしない */
export function cancelGlobalTap(pointerId: number): void {
  tapRef?.cancel(pointerId);
}

export function installGlobalInput(): void {
  if (installed) return;
  installed = true;
  const tap = new TapManager(
    () => undefined,
    () => false
  );
  tapRef = tap;
  const own = (e: Event) => e.target instanceof Element && !!e.target.closest("[data-own-input]");
  const on = (e: PointerEvent) => {
    if (own(e)) return;
    if (routeHook && routeHook(e) !== "ui") {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "pointerup" || e.type === "pointercancel") tap.cancel(e.pointerId);
      return;
    }
    if (e.type === "pointerdown") tap.down(e);
    else if (e.type === "pointermove") tap.move(e);
    else if (e.type === "pointerup") tap.up(e);
    else tap.cancel(e.pointerId);
  };
  for (const ty of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) document.addEventListener(ty, on as EventListener, true);
  document.addEventListener(
    "click",
    (e) => {
      if (own(e)) return;
      tap.click(e);
    },
    true
  );
}
