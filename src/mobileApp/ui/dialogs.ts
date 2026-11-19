// V221 (M-2b-2・UI §5-9・§6-12): お知らせと確認（暗くした地の真ん中の島）。
//
// ★お知らせ: 上の中央（上 30）・高さ 44・丸・`--ink` の地に `--paper` の文字・「くるっと」で出て 1.7 秒で消える。戻せる操作は右に［元に戻す］。
// ★確認: 暗くした地（`--scrim`）の真ん中に島（角 18・枠 3・`--shadow-float`）。ボタンは高さ 50〜52。絵や作品が消える方は赤の縁と `--warn-bg`。
// ★コアのお知らせの文には `{icon:名前}` の印が入ることがある（PC の辞書の値）。モバイルのアイコンにある形はアイコンにし、無い形は落とす
//  （絵文字や字の置き換えにしない）。
// ★文は呼び出し側が辞書から渡す（PC のキーは t()・モバイルのキーは mt()）。ここは並べるだけ。
import { isMobileIconId, mobileIconSvg } from "../../mobile/icons";
import { t } from "../../i18n";
import { mt } from "../i18n";
import { h, btn, icon, txt } from "./dom";
import { holdBackground, type InertNode } from "./modalInert";

export const TOAST_MS = 1700;

/** 画面の上に重ねる層（お知らせ・確認）。描く画面とライブラリで同じもの */
let layer: HTMLElement | null = null;
export function setDialogLayer(el: HTMLElement): void {
  layer = el;
}

/** 文の中の `{icon:名前}` を、アイコン（あれば）と文字の並びにする */
export function richText(s: string, cls = ""): HTMLElement {
  const out = h("span", cls);
  const re = /\{icon:([a-z0-9-]+)\}/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.append(s.slice(last, m.index));
    if (isMobileIconId(m[1])) {
      const sp = document.createElement("span");
      sp.className = "mb-ic mb-ic-inline";
      sp.innerHTML = mobileIconSvg(m[1], 16);
      out.append(sp);
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.append(s.slice(last));
  return out;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastEl: HTMLElement | null = null;
/** 動きを止めているか（描いている・視差効果を減らす）。画面の側が入れる */
let quiet: () => boolean = () => false;
export function setQuiet(f: () => boolean): void {
  quiet = f;
}

/** お知らせ（上の中央・1.7 秒）。undo を渡すと右に［元に戻す］ */
export function toast(msg: string, undo?: () => void): void {
  if (!layer) return;
  toastEl?.remove();
  if (toastTimer) clearTimeout(toastTimer);
  const el = h("div", `mb-toast mb-ui${quiet() ? "" : " mb-anim-flip"}`, richText(msg, "mb-toast-text"));
  el.setAttribute("role", "status");
  if (undo)
    el.append(
      btn("mb-toast-undo", t("keys.cmd.editUndo.label"), () => {
        el.remove();
        undo();
      }, txt("", t("keys.cmd.editUndo.label")))
    );
  layer.append(el);
  toastEl = el;
  toastTimer = setTimeout(() => {
    if (toastEl === el) toastEl = null;
    el.remove();
  }, TOAST_MS);
}

/** いま出ているお知らせの文（確かめ画面と検査） */
export function toastText(): string | null {
  return toastEl?.textContent ?? null;
}

export interface DialogButton<T> {
  label: string;
  value: T;
  kind?: "go" | "warn" | "plain";
  iconId?: Parameters<typeof icon>[0];
  /** 押せない（名前が空のときの［保存］など） */
  disabled?: () => boolean;
}

export interface DialogSpec<T> {
  title: string;
  titleIcon?: Parameters<typeof icon>[0];
  body?: (string | HTMLElement)[];
  buttons: DialogButton<T>[];
  /** ボタンを縦に並べる（戻るときの確認） */
  vertical?: boolean;
  width?: number;
  /** 地を押したときの値（無ければ地を押しても閉じない） */
  dismiss?: T;
  /** ［次回から表示しない］を付ける */
  skippable?: boolean;
  cls?: string;
  /** ★V223: 島を出したあとに 1 回（閉じる口を渡す＝欄の改行で決める・閉じたあとの片付けは呼び出し側の then） */
  onReady?: (close: (value: T) => void, box: HTMLElement) => void;
}

/** ★V225 (指示書 ■3 の K): 出ている確認の、キーボードの受け口（いちばん上の 1 つだけが受ける）。Esc＝［やめる］・Enter＝緑のボタン */
const keyStack: ((e: KeyboardEvent) => void)[] = [];
let keyBound = false;
function bindDialogKeys(): void {
  if (keyBound || typeof window === "undefined") return;
  keyBound = true;
  window.addEventListener(
    "keydown",
    (e) => {
      const top = keyStack[keyStack.length - 1];
      if (top) top(e);
    },
    true
  );
}

let openCount = 0;
/** 確認が出ているか（描く画面は、その間は描かない＝地が ui） */
export function dialogOpen(): boolean {
  return openCount > 0;
}

/** ★V226 (B-3): 箱を外から「やめる」で閉じるときの値の決め方（画面を持たない・scripts/v226_smoke.ts [D] が箱ごとに見る）。
 *  1. 地を押したときの値（dismiss）がある箱 → その値
 *  2. ボタンが 1 つだけの箱（読んで閉じるだけ）→ そのボタン
 *  3. 緑でも赤でもないボタンがちょうど 1 つの箱 → そのボタン（［やめる］［閉じる］［あとで］）。押せないときは閉じない
 *  4. どれでもない箱 → 閉じない（どれが「やめる」か決められない。緑・赤＝作品が変わる側の値は選ばない） */
export function cancelChoice<T>(spec: Pick<DialogSpec<T>, "dismiss" | "buttons">): { ok: true; value: T } | { ok: false } {
  if (spec.dismiss !== undefined) return { ok: true, value: spec.dismiss as T };
  const only = spec.buttons.length === 1 ? spec.buttons[0] : null;
  const plain = spec.buttons.filter((b) => (b.kind ?? "plain") === "plain");
  const pick = only ?? (plain.length === 1 ? plain[0] : null);
  if (!pick || pick.disabled?.()) return { ok: false };
  return { ok: true, value: pick.value };
}

/** 出ている箱の「外から閉じる手」（上にあるものが後ろ） */
const cancelStack: (() => boolean)[] = [];

/** ★V226 (B-3): 一番上の箱を［やめる］で閉じる（Android の戻るボタン）。開いた側の await は、［やめる］を押したときと同じ答えを受け取る。
 *  "none"＝箱が出ていない・"closed"＝閉じた・"kept"＝出ているが閉じない（「やめる」を決められない箱） */
export function closeTopDialog(): "none" | "closed" | "kept" {
  const top = cancelStack[cancelStack.length - 1];
  if (!top) return "none";
  return top() ? "closed" : "kept";
}

/** 確認を出して、押されたボタンの値を返す */
export function openDialog<T>(spec: DialogSpec<T>): Promise<{ value: T; skip: boolean }> {
  return new Promise((resolve) => {
    if (!layer) {
      resolve({ value: spec.dismiss ?? spec.buttons[spec.buttons.length - 1].value, skip: false });
      return;
    }
    openCount++;
    const scrim = h("div", `mb-scrim mb-ui${quiet() ? "" : " mb-anim-fade"}`);
    const box = h("div", `mb-dialog mb-ui ${spec.cls ?? ""}${quiet() ? "" : " mb-anim-pop"}`);
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    if (spec.width) box.style.width = `${spec.width}px`;
    const head = h("div", "mb-dialog-head", spec.titleIcon ? icon(spec.titleIcon, 24) : null, txt("mb-dialog-title", spec.title));
    box.append(head);
    for (const b of spec.body ?? []) box.append(typeof b === "string" ? richText(b, "mb-dialog-body") : b);
    let skip = false;
    if (spec.skippable) {
      const row = h("label", "mb-dialog-skip");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.addEventListener("change", () => (skip = cb.checked));
      row.append(cb, txt("", t("common.dontShowAgain.label")));
      box.append(row);
    }
    let closed = false;
    // ★V227 (X-1): 出ている間は後ろ（描く画面・ライブラリ・下の箱）を inert に。閉じたら開く前の状態へ戻す
    let release: () => void = () => undefined;
    const close = (value: T) => {
      if (closed) return;
      closed = true;
      const ki = keyStack.indexOf(onKey);
      if (ki >= 0) keyStack.splice(ki, 1);
      const ci = cancelStack.indexOf(cancelFromOutside);
      if (ci >= 0) cancelStack.splice(ci, 1);
      openCount--;
      scrim.remove();
      release();
      resolve({ value, skip });
    };
    const row = h("div", `mb-dialog-btns${spec.vertical ? " mb-vertical" : ""}`);
    const refreshers: (() => void)[] = [];
    for (const b of spec.buttons) {
      const el = btn(`mb-dlg-btn mb-${b.kind ?? "plain"}`, b.label, () => {
        if (b.disabled?.()) return;
        close(b.value);
      }, b.iconId ? icon(b.iconId, 20) : null, txt("", b.label));
      if (b.disabled) {
        const upd = () => el.setAttribute("aria-disabled", b.disabled!() ? "true" : "false");
        refreshers.push(upd);
        upd();
      }
      row.append(el);
    }
    box.append(row);
    (box as HTMLElement & { mbRefresh?: () => void }).mbRefresh = () => refreshers.forEach((f) => f());
    // ★V225 (K): ハードウェアキーボード。Esc＝地を押したときの値（無ければ、緑でも赤でもない最初のボタン）・Enter＝緑のボタンが 1 つならそれ
    //  （押せないときは何もしない）。欄の中の Enter は欄の側が決める（nameDialog・saveDialog）。変換中のキーは通さない
    const onKey = (e: KeyboardEvent) => {
      if (closed || e.isComposing || e.keyCode === 229 || e.repeat) return;
      const tg = e.target as HTMLElement | null;
      const inField = !!tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA");
      if (e.code === "Escape") {
        const plain = spec.buttons.find((b) => (b.kind ?? "plain") === "plain");
        if (spec.dismiss !== undefined) close(spec.dismiss as T);
        else if (plain && !plain.disabled?.()) close(plain.value);
        else return;
        e.preventDefault();
        e.stopPropagation();
      } else if ((e.code === "Enter" || e.code === "NumpadEnter") && !inField) {
        const go = spec.buttons.filter((b) => b.kind === "go");
        if (go.length !== 1 || go[0].disabled?.()) return;
        e.preventDefault();
        e.stopPropagation();
        close(go[0].value);
      }
    };
    // ★V226 (B-3): 外から［やめる］で閉じる手（値の決め方は cancelChoice）
    const cancelFromOutside = (): boolean => {
      const c = cancelChoice(spec);
      if (closed || !c.ok) return false;
      close(c.value);
      return true;
    };
    cancelStack.push(cancelFromOutside);
    bindDialogKeys();
    keyStack.push(onKey);
    scrim.append(box);
    if (spec.dismiss !== undefined) {
      scrim.addEventListener("pointerup", (e) => {
        if (e.target === scrim) close(spec.dismiss as T);
      });
    }
    layer.append(scrim);
    release = holdBackground(scrim as unknown as InertNode);
    spec.onReady?.(close, box);
  });
}

/** はい／いいえ（コアの confirm） */
export async function confirmBox(msg: string): Promise<boolean> {
  const r = await openDialog({
    title: msg,
    buttons: [
      { label: mt("mb.cancel.btn"), value: false },
      { label: t("common.yes.btn"), value: true, kind: "go" },
    ],
  });
  return r.value;
}

/** ［次回から表示しない］つき（コアの confirmSkippable）。消す操作の確認なので、進む方は赤の縁 */
export async function confirmSkippableBox(msg: string): Promise<{ ok: boolean; skip: boolean }> {
  const r = await openDialog({
    title: msg,
    skippable: true,
    buttons: [
      { label: mt("mb.cancel.btn"), value: false },
      { label: mt("mb.delete.btn"), value: true, kind: "warn" },
    ],
  });
  return { ok: r.value, skip: r.value && r.skip };
}

/** 選ばせる（コアの choose・null＝やめる） */
export async function chooseBox(msg: string, options: string[]): Promise<number | null> {
  const r = await openDialog<number | null>({
    title: msg,
    vertical: true,
    // ★V225（第三者レビューの指摘 2）: 地を押す・Esc は［やめる］（選択肢の 1 つ目を選ばない＝作品を変えない）
    dismiss: null,
    buttons: [...options.map((o, i) => ({ label: o, value: i as number | null })), { label: mt("mb.cancel.btn"), value: null }],
  });
  return r.value;
}

/** 読んで閉じるだけ（コアの notice） */
export async function noticeBox(msg: string, title?: string): Promise<void> {
  await openDialog({
    title: title ?? msg,
    titleIcon: title ? "warn" : undefined,
    body: title ? [msg] : [],
    buttons: [{ label: t("common.close.btn"), value: true }],
  });
}
