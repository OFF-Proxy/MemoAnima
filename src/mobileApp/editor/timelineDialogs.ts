// V223 (M-2b-3b-1・UI §5-7・§6-12・指示書 ■3 の F-7): 広げたタイムラインの小窓（まとめて足す・ゆらゆら）。
//
// ★形は確認の島（dialogs.ts）。中身は PC の小窓と同じ（src/editor/editor.ts の openAddFramesDialog・openWobbleDialog）。
//  地を押したら［やめる］と同じ。変形の途中は開かない（呼び出し側が先にコアの xformGuard を通す）。
// ★ゆらゆらの見本は wobblePreview.ts（§5-0 の一時的な写し）。閉じたら見本の時計と作りかけを止める。
import { W, H, type Project } from "../../editor/model";
import { presentToCanvas } from "../../editor/render";
import { ADD_FRAMES_MAX } from "../../editor/prefs";
import type { WobbleTargets } from "../../editor/layerTree";
import type { WobbleKind, WobbleStrength } from "../../editor/wobble";
import { t } from "../../i18n";
import { mt } from "../i18n";
import { h, btn, icon, txt } from "../ui/dom";
import { openDialog } from "../ui/dialogs";
import { keepAboveKeyboard } from "../ui/nameDialog";
import { buildWobblePreview, wobbleLast, rememberWobble, wobblePreviewFps, clampStrength, WOBBLE_COUNTS, WOBBLE_STRENGTH_MIN, WOBBLE_STRENGTH_MAX, type WobbleOpt } from "./wobblePreview";

/** まとめて足すの始めの値と上限（PC の小窓と同じ: 5・1〜ADD_FRAMES_MAX） */
export const ADD_FRAMES_FIRST = 5;
export { ADD_FRAMES_MAX };

/** ★枚数の欄の読み方（PC の小窓と同じ: 小数は切り捨て・1〜上限に収める・数でなければ 1） */
export function clampAddCount(raw: string | number, max = ADD_FRAMES_MAX): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(1, Math.min(max, n)) : 1;
}

/** 切り替え（選んでいるものは黄）。選ぶたびに pick を呼び、印を付け直す */
function seg<T>(items: { label: string; value: T }[], get: () => T, pick: (v: T) => void): HTMLElement {
  const el = h("div", "mb-seg");
  const draw = () => {
    el.replaceChildren(
      ...items.map((it) =>
        btn(`mb-seg-item${it.value === get() ? " mb-on" : ""}`, it.label, () => {
          pick(it.value);
          draw();
        }, txt("", it.label))
      )
    );
  };
  draw();
  return el;
}

/** スイッチの行（行の全体が当たり） */
function switchRow(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const sw = h("span", "mb-switch", h("span", "mb-knob"));
  const row = btn("mb-switch-row", label, () => {
    set(!get());
    draw();
  }, txt("mb-switch-label", label), sw);
  row.setAttribute("role", "switch");
  const draw = () => {
    sw.classList.toggle("mb-on", get());
    row.setAttribute("aria-checked", get() ? "true" : "false");
  };
  draw();
  return row;
}

/** まとめて足す。決めたら { count, duplicate }・やめたら null */
export function askAddFrames(): Promise<{ count: number; duplicate: boolean } | null> {
  const max = ADD_FRAMES_MAX;
  let duplicate = false;
  const body = h("div", "mb-namebody");
  const input = document.createElement("input");
  input.className = "mb-name mb-count-in mb-num";
  input.type = "text";
  input.inputMode = "numeric";
  input.value = String(ADD_FRAMES_FIRST);
  input.ariaLabel = t("ed.tl.addFrames.count.label");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("enterkeyhint", "done");
  const step = (d: number) => {
    input.value = String(clampAddCount(clampAddCount(input.value, max) + d, max));
  };
  input.addEventListener("change", () => (input.value = String(clampAddCount(input.value, max))));
  body.append(
    txt("mb-sub", t("ed.tl.addFrames.count.label")),
    h(
      "div",
      "mb-count-row",
      btn("mb-sq", mt("mb.count.dec.title"), () => step(-1), txt("mb-chip-mark", "−")),
      input,
      btn("mb-sq", mt("mb.count.inc.title"), () => step(1), icon("add", 20)),
      txt("mb-soft", t("ed.tl.addFrames.range.hint", { max }))
    ),
    switchRow(t("ed.tl.addFrames.dup.label"), () => duplicate, (v) => (duplicate = v))
  );
  const off = keepAboveKeyboard(body);
  return openDialog<boolean>({
    title: t("ed.tl.addFrames.dialog.label"),
    body: [body],
    cls: "mb-namebox",
    dismiss: false,
    buttons: [
      { label: mt("mb.cancel.btn"), value: false },
      { label: t("ed.tl.addFrames.ok.btn"), value: true, kind: "go" },
    ],
    onReady: (close) => {
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        close(true);
      });
    },
  }).then((r) => {
    off();
    return r.value ? { count: clampAddCount(input.value, max), duplicate } : null;
  });
}

export interface WobbleAsk {
  project: Project;
  frameIndex: number;
  /** 範囲選択（無ければ null） */
  mask: Uint8Array | null;
  /** 「選んでいるもの」の対象（コアの wobbleTargets＝開いたときに決める） */
  targets: WobbleTargets;
  /** コアの wobbleSeed */
  seed(kind: WobbleKind, strength: WobbleStrength): number;
}

/** 対象［選んでいるもの］の名前（PC と同じ決め方・長い名前は 12 字＋…） */
export function wobbleTargetLabel(wt: WobbleTargets): string {
  const cps = [...wt.name];
  const name = cps.length > 12 ? `${cps.slice(0, 12).join("")}…` : wt.name;
  if (wt.kind === "folder") return t("ed.wobble.targetFolder.label", { name });
  if (wt.kind === "multi") return t("ed.wobble.targetMulti.label", { count: wt.ids.length });
  return name ? t("ed.wobble.targetActiveNamed.label", { name }) : t("ed.wobble.targetActive.label");
}

/** ゆらゆら。決めたら値（アプリを閉じるまで覚える）・やめたら null */
export function askWobble(ask: WobbleAsk): Promise<WobbleOpt | null> {
  const o: WobbleOpt = wobbleLast();
  const body = h("div", "mb-wobblebody");
  const cv = document.createElement("canvas");
  cv.className = "mb-wb-preview";
  cv.width = W;
  cv.height = H;
  cv.classList.toggle("mb-clear", ask.project.frames[ask.frameIndex]?.paper === 0);
  const fps = wobblePreviewFps(ask.project);
  const active: ReadonlySet<string> = new Set(ask.targets.ids);
  let frames: Uint32Array[] | null = null;
  let shown = 0;
  let done = false;
  let gen = 0;
  let building = false;
  const paint = () => {
    if (done || !frames) return;
    presentToCanvas(frames[shown % frames.length], cv);
  };
  // 値を変えたら作り直す（作りかけは止める＝1 枚ごとに譲り、その間に変わったら最後の値で作り直す）
  const build = async () => {
    if (building) return;
    building = true;
    try {
      for (;;) {
        const my = gen;
        const opt = { ...o };
        const made = await buildWobblePreview(ask.project, ask.frameIndex, opt, ask.seed(opt.kind, opt.strength), ask.mask, active, () => new Promise((r) => setTimeout(r, 0)), () => !done && my === gen);
        if (done) return;
        if (my !== gen) continue;
        if (made) {
          frames = made;
          shown = 0;
          paint();
        }
        return;
      }
    } finally {
      building = false;
    }
  };
  const kick = () => {
    gen++;
    void build();
  };
  const timer = setInterval(() => {
    shown++;
    paint();
  }, 1000 / fps);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(WOBBLE_STRENGTH_MIN);
  slider.max = String(WOBBLE_STRENGTH_MAX);
  slider.step = "1";
  slider.value = String(o.strength);
  slider.className = "mb-range";
  slider.ariaLabel = t("ed.wobble.strength.label");
  const num = txt("mb-range-num mb-num", String(o.strength));
  slider.addEventListener("input", () => {
    o.strength = clampStrength(Number(slider.value));
    num.textContent = String(o.strength);
    kick();
  });
  body.append(
    h("div", "mb-wb-prevbox", cv),
    h(
      "div",
      "mb-wb-opts",
      txt("mb-sub", t("ed.wobble.count.label")),
      seg(
        WOBBLE_COUNTS.map((n) => ({ label: t(`ed.wobble.count${n}.label`), value: n })),
        () => o.count,
        (v) => {
          o.count = v;
          kick();
        }
      ),
      txt("mb-sub", t("ed.wobble.kind.label")),
      seg<WobbleKind>(
        [
          { label: t("ed.wobble.kindLine.label"), value: "line" },
          { label: t("ed.wobble.kindWhole.label"), value: "whole" },
        ],
        () => o.kind,
        (v) => {
          o.kind = v;
          kick();
        }
      ),
      h("label", "mb-range-row", txt("mb-range-label", t("ed.wobble.strength.label")), slider, num),
      txt("mb-sub", t("ed.wobble.target.label")),
      seg<"all" | "active">(
        [
          { label: t("ed.wobble.targetAll.label"), value: "all" },
          { label: wobbleTargetLabel(ask.targets), value: "active" },
        ],
        () => o.target,
        (v) => {
          o.target = v;
          kick();
        }
      )
    )
  );
  kick();
  return openDialog<boolean>({
    title: mt("mb.wobble.dialog.title"),
    titleIcon: "wobble",
    body: [body],
    cls: "mb-wobblebox",
    dismiss: false,
    buttons: [
      { label: mt("mb.cancel.btn"), value: false },
      { label: t("ed.wobble.ok.btn"), value: true, kind: "go" },
    ],
  }).then((r) => {
    // 閉じたら見本の時計と作りかけを止める
    done = true;
    clearInterval(timer);
    // 枚数・種類・強さ・対象は、アプリを閉じるまで覚える（PC と同じ: やめても覚える）
    rememberWobble(o);
    return r.value ? { ...o } : null;
  });
}
