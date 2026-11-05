// V211 (M-1b・要件 §6-4): 裏に回る・戻る知らせ。
//
// ★iOS の WebView は、ホームへ出ても `visibilitychange` が来ないことがある（V184c: シミュレーターでは visible のまま）。来るのは Tauri の
//  `tauri://suspended`・`tauri://resumed`。`visibilitychange`（hidden）・`pagehide` が来る端末ではそれも「裏に回った」として扱う。
//  同じ回に何通来ても、裏に回る手続きは 1 回にまとめる（戻るまで）。
import { listen } from "@tauri-apps/api/event";

export interface LifecycleHandlers {
  /** 裏に回った（どの知らせから来たか） */
  suspend: (from: string) => void;
  /** 戻った */
  resume: (from: string) => void;
}

export async function watchLifecycle(h: LifecycleHandlers): Promise<void> {
  let away = false;
  const goAway = (from: string) => {
    if (away) return;
    away = true;
    h.suspend(from);
  };
  const comeBack = (from: string) => {
    if (!away) return;
    away = false;
    h.resume(from);
  };
  await listen("tauri://suspended", () => goAway("tauri-suspended"));
  await listen("tauri://resumed", () => comeBack("tauri-resumed"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") goAway("visibility-hidden");
    else comeBack("visibility-visible");
  });
  window.addEventListener("pagehide", () => goAway("pagehide"));
}
