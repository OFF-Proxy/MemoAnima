// V225 (M-2b-3b-2／M-2c・UI §6-11・指示書 ■2 の A-1・B-3・■3 の S): 設定の画面（部品は 1 つ）。
//
// ★描く画面のその他の［設定］から開くと 4 区分（表示〔表示言語なし〕・描き心地・ジェスチャー・確認）、ライブラリの歯車から開くと全部（U-34）。
//  区分と行の並びは model.ts の表（sectionsFor・rowsFor）＝検査が見るのは表。ここは表のとおりに並べるだけ。
// ★値を変えたら、すぐ設定に書く（変えた一番上のキーだけ＝model.ts の mergeFor）。当てるのは呼んだ側（onChange）。
// ★描く画面の上に全面で出す（作品は開いたまま）。置き場は body の直下（確認とお知らせの層 #mb-layer より下）。押すのは ui/globalInput.ts
//  （離したときに押したことにする・描く画面が開いている間は振り分け層を通る＝手のひらで押さない）。
// ★色は変数だけ（settings.css）。画面の大きさを読まない（横と縦の形は CSS が決める）。pointerType を読まない。
// ★まだ使えない行は押せない札（押すと「これからの版で」のお知らせ）。
import { LANGS, getLang, t, type Lang } from "../../i18n";
import { formatSize } from "../../editor/core/formatBytes";
import { presetName } from "../../keymap";
import type { MobileIconId } from "../../mobile/icons";
import { mt, type MbKey } from "../i18n";
import { pressureCurve } from "../input/router";
import { dialogOpen, toast } from "../ui/dialogs";
import { btn, h, icon, txt } from "../ui/dom";
import { holdBackground, type InertNode } from "../ui/modalInert";
import {
  fingerDrawShown,
  keyPresetChoices,
  mergeFor,
  readMobileSettings,
  rowsFor,
  sectionEnabled,
  sectionsFor,
  type GestureId,
  type MobileSettings,
  type SectionId,
  type SettingChange,
} from "./model";

export interface SettingsStats {
  works: number;
  albums: number;
  bytes: number;
}

export interface SettingsDeps {
  from: "editor" | "library";
  /** いまの設定（読んだもの）。変えたら、ここにも写す */
  raw: Record<string, unknown>;
  /** 設定に書く（変えた一番上のキーだけ） */
  merge(values: Record<string, unknown>): void;
  /** 変えたものを画面へ当てる（配色・言語・利き手・入力の設定 ほか） */
  applied(change: SettingChange, now: MobileSettings): void;
  /** 戻る */
  closed(): void;
  version: string;
  stats?: SettingsStats | null;
  /** 開いたときの区分（回したあと・言語を替えたあとの組み直しで同じ区分に戻す） */
  section?: SectionId;
}

export interface SettingsHandle {
  close(): void;
  /** 組み直す（言語を替えた・数が分かった） */
  rebuild(): void;
  section(): SectionId;
  /** 区分を替える（Android の戻るボタンの前の区分へ・確かめ画面の数え） */
  show(id: SectionId): void;
  setStats(s: SettingsStats | null): void;
  readonly el: HTMLElement;
}

/** 言語の名前（それぞれの言語の名前で。辞書に入れない＝どの表示言語でも同じ字） */
export const LANG_NAMES: Readonly<Record<Lang, string>> = {
  ja: "日本語", // i18n-exempt: 言語の名前（その言語の字で出す・訳さない）
  en: "English",
  es: "Español",
  "pt-BR": "Português (BR)",
  ko: "한국어", // i18n-exempt: 言語の名前（その言語の字で出す・訳さない）
  "zh-Hans": "简体中文", // i18n-exempt: 言語の名前（その言語の字で出す・訳さない）
  "zh-Hant": "繁體中文", // i18n-exempt: 言語の名前（その言語の字で出す・訳さない）
}; // i18n-exempt: 言語の名前は訳さない（その言語の字で出す）

const SECTION_ICON: Record<SectionId, MobileIconId> = {
  display: "display",
  feel: "pen",
  gesture: "set-gesture",
  confirm: "set-confirm",
  library: "project",
  sync: "set-sync",
  about: "info",
};
const SECTION_LABEL: Record<SectionId, MbKey> = {
  display: "mb.set.sec.display.label",
  feel: "mb.set.sec.feel.label",
  gesture: "mb.set.sec.gesture.label",
  confirm: "mb.set.sec.confirm.label",
  library: "mb.set.sec.library.label",
  sync: "mb.set.sec.sync.label",
  about: "mb.set.sec.about.label",
};

/** まだ使えない札（押すとお知らせ・読み上げにも同じ文を添える） */
export function soonBtn(cls: string, name: string, ...kids: (Node | string | null)[]): HTMLElement {
  const b = btn(`mb-soon ${cls}`, name, () => toast(mt("mb.soon.toast")), ...kids);
  b.ariaDescription = mt("mb.soon.toast");
  return b;
}

let screensRoot: HTMLElement | null = null;
/** 設定とライブラリを置く根（body の直下・確認とお知らせの層より前） */
export function screensHost(): HTMLElement {
  if (!screensRoot || !screensRoot.isConnected) {
    screensRoot = document.createElement("div");
    screensRoot.id = "mb-screens";
    const layer = document.getElementById("mb-layer");
    document.body.insertBefore(screensRoot, layer);
  }
  return screensRoot;
}

export function openSettings(deps: SettingsDeps): SettingsHandle {
  const sections = sectionsFor(deps.from);
  let cur: SectionId = deps.section && sections.includes(deps.section) ? deps.section : "display";
  let stats = deps.stats ?? null;
  const root = h("div", "mb-app mb-set mb-ui");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  let closed = false;

  const change = (c: SettingChange) => {
    const values = mergeFor(deps.raw, c);
    if (Object.keys(values).length === 0) return;
    Object.assign(deps.raw, values);
    deps.merge(values);
    deps.applied(c, readMobileSettings(deps.raw));
    if (!closed) build();
  };

  const seg = <T>(name: string, items: { label: string; value: T; iconId?: MobileIconId }[], value: T, pick: (v: T) => void, off = false): HTMLElement => {
    const el = h("div", `mb-seg mb-set-seg${off ? " mb-dim" : ""}`);
    el.setAttribute("role", "radiogroup");
    el.ariaLabel = name;
    for (const it of items) {
      const b = btn(`mb-seg-item${it.value === value ? " mb-on" : ""}`, it.label, () => {
        if (!off && it.value !== value) pick(it.value);
      }, it.iconId ? icon(it.iconId, 18) : null, txt("", it.label));
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", it.value === value ? "true" : "false");
      if (off) b.setAttribute("aria-disabled", "true");
      el.append(b);
    }
    return el;
  };
  const sw = (name: string, on: boolean, flip: (v: boolean) => void, off = false): HTMLElement => {
    const b = btn(`mb-set-switch${on ? " mb-on" : ""}${off ? " mb-dim" : ""}`, name, () => {
      if (!off) flip(!on);
    }, h("span", "mb-set-knob"));
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", on ? "true" : "false");
    if (off) b.setAttribute("aria-disabled", "true");
    return b;
  };
  const row = (label: string, hint: string | null, control: HTMLElement | null, lead: HTMLElement | null = null, cls = ""): HTMLElement =>
    h("div", `mb-set-row ${cls}`, lead, h("div", "mb-set-rowtext", txt("mb-set-label", label), hint ? txt("mb-set-hint", hint) : null), control);
  const gicon = (id: MobileIconId) => h("span", "mb-set-gicon", icon(id, 26));

  function buildSection(s: MobileSettings): HTMLElement[] {
    const out: HTMLElement[] = [];
    const rows = rowsFor(cur, deps.from);
    const has = (id: string) => rows.some((r) => r.id === id);
    if (cur === "display") {
      if (has("lang")) {
        const grid = h("div", "mb-set-langs");
        grid.setAttribute("role", "radiogroup");
        grid.ariaLabel = t("set.lang.label");
        for (const l of LANGS) {
          const on = l === getLang();
          const b = btn(`mb-set-lang${on ? " mb-on" : ""}`, LANG_NAMES[l], () => {
            if (!on) change({ id: "lang", value: l });
          }, h("span", "mb-set-radio"), txt("", LANG_NAMES[l]));
          b.setAttribute("role", "radio");
          b.setAttribute("aria-checked", on ? "true" : "false");
          b.lang = l;
          grid.append(b);
        }
        out.push(h("div", "mb-set-block", h("div", "mb-set-blockhead", txt("mb-set-label", t("set.lang.label")), txt("mb-set-hint", t("set.lang.hint"))), grid, txt("mb-set-hint", mt("mb.set.lang.cjk.msg"))));
      }
      out.push(
        row(t("set.theme.label"), t("set.theme.hint"), seg(t("set.theme.label"), [
          { label: t("set.theme.light.btn"), value: "light" as const },
          { label: t("set.theme.dark.btn"), value: "dark" as const },
        ], s.theme, (v) => change({ id: "theme", value: v })))
      );
      const pic = h("span", `mb-set-handpic${s.hand === "left" ? " mb-left-hand" : ""}`, h("span", "mb-hp-tools"), h("span", "mb-hp-art"), h("span", "mb-hp-side"), h("span", "mb-hp-bar"));
      pic.setAttribute("aria-hidden", "true");
      out.push(
        row(mt("mb.set.hand.label"), mt("mb.set.hand.msg"), h("div", "mb-set-handctl", pic, seg(mt("mb.set.hand.label"), [
          { label: mt("mb.set.hand.right.btn"), value: "right" as const },
          { label: mt("mb.set.hand.left.btn"), value: "left" as const },
        ], s.hand, (v) => change({ id: "hand", value: v }))))
      );
      out.push(row(mt("mb.set.flip.label"), mt("mb.set.flip.msg"), sw(mt("mb.set.flip.label"), s.flipPage, (v) => change({ id: "flipPage", value: v }))));
    } else if (cur === "feel") {
      out.push(row(mt("mb.set.fingerDraw.label"), mt("mb.set.fingerDraw.msg"), sw(mt("mb.set.fingerDraw.label"), fingerDrawShown(s), (v) => change({ id: "fingerDraw", value: v }), s.noFinger), null, s.noFinger ? "mb-dimrow" : ""));
      out.push(row(mt("mb.set.noFinger.label"), mt("mb.set.noFinger.msg"), sw(mt("mb.set.noFinger.label"), s.noFinger, (v) => change({ id: "noFinger", value: v }))));
      const cv = document.createElement("canvas");
      cv.className = "mb-set-preview";
      cv.setAttribute("role", "img");
      cv.ariaLabel = mt("mb.set.pressure.preview.msg");
      out.push(
        h(
          "div",
          "mb-set-block",
          h("div", "mb-set-row mb-noline", h("div", "mb-set-rowtext", txt("mb-set-label", mt("mb.set.pressure.label"))), seg(mt("mb.set.pressure.label"), [
            { label: mt("mb.set.pressure.weak.btn"), value: "weak" as const },
            { label: mt("mb.set.pressure.standard.btn"), value: "standard" as const },
            { label: mt("mb.set.pressure.strong.btn"), value: "strong" as const },
          ], s.pressureCurve, (v) => change({ id: "pressureCurve", value: v }))),
          h("div", "mb-set-previewbox", cv, txt("mb-set-previewcap", mt("mb.set.pressure.preview.msg"))),
          txt("mb-set-hint", mt("mb.set.pressure.msg"))
        )
      );
      requestAnimationFrame(() => paintPressurePreview(cv, s.pressureCurve));
      out.push(
        row(mt("mb.set.hover.label"), mt("mb.set.hover.msg"), seg(mt("mb.set.hover.label"), [
          { label: mt("mb.set.hover.ring.btn"), value: "ring" as const, iconId: "hover-ring" },
          { label: mt("mb.set.hover.cross.btn"), value: "cross" as const, iconId: "hover-cross" },
          { label: mt("mb.set.hover.none.btn"), value: "none" as const },
        ], s.hover, (v) => change({ id: "hover", value: v })))
      );
      out.push(
        row(mt("mb.set.keys.label"), mt("mb.set.keys.msg"), seg(mt("mb.set.keys.label"), keyPresetChoices().map((p) => ({ label: presetName(p), value: p.id })), s.keysActiveId, (v) => change({ id: "keys", value: v })))
      );
    } else if (cur === "gesture") {
      if (s.noFinger) out.push(h("div", "mb-set-note", icon("warn", 20), txt("", mt("mb.set.gesture.noFinger.msg"))));
      out.push(row(mt("mb.set.g.panPinch.title"), mt("mb.set.g.panPinch.msg"), txt("mb-set-chip", mt("mb.set.g.always.label")), gicon("g-pan-pinch")));
      const g = (id: GestureId, label: string, hint: string, ic: MobileIconId) =>
        row(label, hint, sw(label, s.gestures[id], (v) => change({ id: "gesture", gesture: id, value: v }), s.noFinger), gicon(ic), s.noFinger ? "mb-dimrow" : "");
      out.push(g("undoTap", mt("mb.set.g.tap2.label"), t("keys.cmd.editUndo.label"), "g-tap2"));
      out.push(g("redoTap", mt("mb.set.g.tap3.label"), t("keys.cmd.editRedo.label"), "g-tap3"));
      out.push(g("twist", mt("mb.set.g.twist.label"), mt("mb.set.g.twist.msg"), "g-twist"));
      out.push(g("toolsTap", mt("mb.set.g.tap4.label"), mt("mb.set.g.tap4.msg"), "g-tap4"));
      const lpOff = s.noFinger || !s.gestures.longPress;
      const lp = g("longPress", mt("mb.set.g.longPress.label"), mt("mb.set.g.longPress.msg"), "g-long-press");
      lp.classList.add("mb-noline");
      out.push(lp);
      out.push(
        h("div", `mb-set-subrow${lpOff ? " mb-dimrow" : ""}`, txt("mb-set-hint", mt("mb.set.g.longPressTime.label")), seg(mt("mb.set.g.longPressTime.label"), [300, 500, 800].map((ms) => ({ label: mt("mb.set.g.seconds.label", { sec: (ms / 1000).toFixed(1) }), value: ms })), s.longPressMs, (v) => change({ id: "longPressMs", value: v }), lpOff))
      );
      out.push(row(mt("mb.set.undoBadge.label"), mt("mb.set.undoBadge.msg"), sw(mt("mb.set.undoBadge.label"), s.undoBadge, (v) => change({ id: "undoBadge", value: v })), gicon("undo-badge")));
    } else if (cur === "confirm") {
      // ★V227 (Y-3・ボード s04): 「このコマの絵を消す」のとき（いつも）・オフの行には「次回から表示しない」でオフになることを添える
      const c = (id: string, label: string) => {
        const on = !s.hiddenConfirms.includes(id);
        const hints = [id === "clearFrame" ? mt("mb.set.confirm.clearFrame.msg") : "", on ? "" : mt("mb.set.confirm.skipped.msg")].filter(Boolean);
        const r = row(label, hints[0] ?? null, sw(label, on, (v) => change({ id: "confirm", confirm: id, value: v })));
        if (hints[1]) r.querySelector(".mb-set-rowtext")?.append(txt("mb-set-hint", hints[1]));
        return r;
      };
      out.push(c("clearFrame", t("set.confirms.clearFrame.label")), c("layerDelete", t("set.confirms.layerDelete.label")), c("folderDelete", t("set.confirms.folderDelete.label")));
      out.push(row(t("set.frameDeleteConfirm.label"), mt("mb.set.frameDelete.msg"), sw(t("set.frameDeleteConfirm.label"), s.frameDeleteConfirm, (v) => change({ id: "frameDeleteConfirm", value: v }))));
    } else if (cur === "library") {
      const chips = h("div", "mb-set-stats");
      if (stats) {
        chips.append(
          txt("mb-set-chip mb-num", t("lib.shelf.count.label", { count: stats.works })),
          txt("mb-set-chip mb-num", mt("mb.set.stats.albums.label", { count: stats.albums })),
          txt("mb-set-chip mb-num", mt("mb.set.stats.size.label", { size: formatSize(stats.bytes) }))
        );
      }
      out.push(chips);
      out.push(row(mt("mb.set.exportAll.btn"), mt("mb.set.exportAll.msg"), soonBtn("mb-set-go", mt("mb.set.exportAll.btn"), icon("export", 20), txt("", mt("mb.set.exportAll.btn")))));
      out.push(h("div", "mb-set-warnbox", icon("warn", 22), txt("", mt("mb.set.uninstall.msg"))));
    } else if (cur === "about") {
      out.push(h("div", "mb-set-app", h("span", "mb-set-applogo"), h("div", "mb-set-rowtext", txt("mb-set-label", mt("mb.set.about.app.title", { version: deps.version })), txt("mb-set-hint", mt("mb.set.about.author.title")))));
      for (const k of ["mb.set.about.terms.title", "mb.set.about.privacy.title", "mb.set.about.external.title", "mb.set.about.licenses.title", "mb.set.about.guide.title"] as const)
        out.push(soonBtn("mb-set-link", mt(k), txt("mb-set-label", mt(k)), icon("chev-right", 20)));
      out.push(txt("mb-set-legal", t("set.legal.disclaimer.msg")));
    }
    return out;
  }

  const HINT: Partial<Record<SectionId, () => string>> = {
    display: () => mt("mb.set.display.msg"),
    feel: () => mt("mb.set.feel.msg"),
    gesture: () => mt("mb.set.gesture.msg"),
    confirm: () => t("set.confirms.hint"),
    library: () => mt("mb.set.library.msg"),
  };

  let scrollKeep = 0;
  function build(): void {
    const s = readMobileSettings(deps.raw);
    const old = root.querySelector(".mb-set-body");
    if (old) scrollKeep = old.scrollTop;
    const backName = deps.from === "editor" ? mt("mb.set.back.editor.title") : mt("mb.set.back.library.title");
    const back = btn("mb-set-back", backName, () => handle.close(), icon("chev-left", 22), txt("", deps.from === "editor" ? mt("mb.set.back.editor.btn") : mt("mb.set.back.library.btn")));
    const top = h("div", "mb-topbar", back, txt("mb-topbar-title", t("lib.settings.title")));
    const nav = h("div", "mb-set-nav");
    nav.setAttribute("role", "tablist");
    sections.forEach((id) => {
      const name = mt(SECTION_LABEL[id]);
      if (id === "library") nav.append(h("div", "mb-set-navsep"));
      const kids = [icon(SECTION_ICON[id], 24), txt("mb-set-navname", name), id === "sync" ? icon("chev-right", 20) : null];
      const b = sectionEnabled(id)
        ? btn(`mb-set-navrow${id === cur ? " mb-on" : ""}`, name, () => {
            if (cur === id) return;
            cur = id;
            scrollKeep = 0;
            build();
          }, ...kids)
        : soonBtn("mb-set-navrow", name, ...kids);
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", id === cur ? "true" : "false");
      nav.append(b);
    });
    if (deps.from === "editor") nav.append(txt("mb-set-navnote", mt("mb.set.fromEditor.msg")));
    // 区分「確認」の中の見出しは PC の「確認ダイアログ」（ボード s04・UI §6-11）
    const hint = HINT[cur]?.() ?? "";
    const body = h("div", "mb-set-body", h("div", "mb-set-head", txt("mb-set-title", cur === "confirm" ? t("set.confirms.label") : mt(SECTION_LABEL[cur])), hint ? txt("mb-set-hint", hint) : null), ...buildSection(s));
    body.dataset.section = cur;
    root.replaceChildren(top, h("div", "mb-set-main", h("div", "mb-card mb-set-navbox", nav), h("div", "mb-card mb-set-bodybox", body)));
    body.scrollTop = scrollKeep;
  }

  // ハードウェアキーボードの Esc で戻る（確認の箱が上に出ている間は箱が先に受ける）
  const onKey = (e: KeyboardEvent) => {
    if (e.code !== "Escape" || e.repeat || dialogOpen()) return;
    e.preventDefault();
    handle.close();
  };
  window.addEventListener("keydown", onKey);
  const handle: SettingsHandle = {
    el: root,
    close: () => {
      if (closed) return;
      closed = true;
      window.removeEventListener("keydown", onKey);
      root.remove();
      release();
      deps.closed();
    },
    rebuild: () => {
      if (!closed) build();
    },
    section: () => cur,
    show: (id) => {
      if (closed || !sections.includes(id) || !sectionEnabled(id)) return;
      cur = id;
      scrollKeep = 0;
      build();
    },
    setStats: (s) => {
      stats = s;
      if (!closed && cur === "library") build();
    },
  };
  build();
  screensHost().append(root);
  // ★V227 (X-1): 設定が出ている間は、後ろ（描く画面・ライブラリ）を inert に（上に確認が出たら、確認が一番上）
  const release = holdBackground(root as unknown as InertNode);
  return handle;
}

/** 太さ 8 の見本の線（軽く入り、強く押して、抜く）。筆圧の曲線は振り分け層と同じ関数・太さの係数はコアと同じ（0.4 + 筆圧 × 1.2）。
 *  色は変数から読む（配色を替えたら、行ごと組み直すので描き直る） */
export function paintPressurePreview(cv: HTMLCanvasElement, curve: Parameters<typeof pressureCurve>[1]): void {
  const box = cv.parentElement;
  if (!box) return;
  const cssW = Math.max(120, Math.floor(box.clientWidth - 24));
  const cssH = 64;
  // 1 ドットを CSS の 2px で描く（ドットの線に見える大きさ）
  const w = Math.floor(cssW / 2);
  const hh = Math.floor(cssH / 2);
  cv.width = w;
  cv.height = hh;
  cv.style.width = `${w * 2}px`;
  cv.style.height = `${hh * 2}px`;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, hh);
  ctx.fillStyle = getComputedStyle(cv).color;
  for (const d of pressurePreviewDots(w, hh, curve)) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 見本の線の点（画面を持たない計算） */
export function pressurePreviewDots(w: number, hh: number, curve: Parameters<typeof pressureCurve>[1]): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = [];
  const x0 = 14;
  const x1 = w - 14;
  const n = Math.max(2, (x1 - x0) * 2);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    // 軽く入り（0.08）→ 強く押して（0.75）→ 抜く（0.05）
    const raw = u < 0.45 ? 0.08 + (0.75 - 0.08) * Math.sin((u / 0.45) * (Math.PI / 2)) : 0.05 + (0.75 - 0.05) * Math.cos(((u - 0.45) / 0.55) * (Math.PI / 2));
    const p = pressureCurve(raw, curve);
    const width = Math.max(1, 8 * (0.4 + p * 1.2));
    out.push({ x: x0 + (x1 - x0) * u, y: hh / 2 + Math.sin(u * Math.PI * 1.3 + 0.4) * (hh * 0.14), r: width / 4 });
  }
  return out;
}
