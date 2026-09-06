// V171: 線画アイコンの器（REQ_icon_set.md §3-1）。
//   絵文字は OS のフォントで描かれるので Windows と Mac で絵が変わる（2026-09-05・Mac 実機で発覚）。
//   SVG を **インライン**で挿す（<img> にしない＝ `currentColor` で周りの文字色を継承する。夜の紙でも同じファイル）。
//   素材は src/icons/*.svg（Cowork の成果物・触らない）→ scripts/gen_icons.ts が `_bundle.ts` に束ねる（実行時に fetch しない）。
//   `IconId` は icons.json の id から**型で**作られる（typo はコンパイルで落ちる）。
import { ICON_IDS, ICON_INNER, ICON_STROKE, type IconId } from "./_bundle";
import { t } from "../i18n";

export type { IconId };
export { ICON_IDS };

const SVG_NS = "http://www.w3.org/2000/svg";
const ID_SET: ReadonlySet<string> = new Set(ICON_IDS);

/** 文字列が icons.json の id か（`{icon:xxx}` の検証・DOM の data-icon の検証に使う） */
export function isIconId(s: string): s is IconId {
  return ID_SET.has(s);
}

export interface IconOpts {
  /** 固定サイズ（px）。省略時は CSS の 1em（周りの文字に追従） */
  size?: number | string;
  /** 追加クラス（`.icon-16` `.icon-20` `.icon-24` は styles.css に定義） */
  class?: string;
  /** 読み上げ・ツールチップ。渡さなければ aria-hidden（装飾扱い） */
  title?: string;
}

/** ルート <svg> の属性（icons.json の値と同じ。SVG 側の属性は使わず、ここで統一して付ける） */
function rootAttrs(id: IconId, o?: IconOpts): Record<string, string> {
  const a: Record<string, string> = {
    class: "icon icon-" + id + (o?.class ? " " + o.class : ""),
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": String(ICON_STROKE),
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    focusable: "false",
  };
  if (o?.size !== undefined) {
    const s = typeof o.size === "number" ? `${o.size}px` : o.size;
    a.width = s;
    a.height = s;
  }
  if (o?.title) a.role = "img";
  else a["aria-hidden"] = "true";
  return a;
}

/** インライン <svg> 要素を返す（DOM 版）。 */
export function icon(id: IconId, o?: IconOpts): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries(rootAttrs(id, o))) el.setAttribute(k, v);
  if (o?.title) {
    const tt = document.createElementNS(SVG_NS, "title");
    tt.textContent = o.title;
    el.appendChild(tt);
  }
  // 中身は生成物の文字列（path 等・色なし）。innerHTML は SVG の名前空間の中なので path が SVG 要素として入る
  el.innerHTML += ICON_INNER[id];
  return el;
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 文字列が要る所（innerHTML のテンプレート）用。 */
export function iconHtml(id: IconId, o?: IconOpts): string {
  const attrs = Object.entries(rootAttrs(id, o))
    .map(([k, v]) => `${k}="${escAttr(v)}"`)
    .join(" ");
  const title = o?.title ? `<title>${escAttr(o.title)}</title>` : "";
  return `<svg xmlns="${SVG_NS}" ${attrs}>${title}${ICON_INNER[id]}</svg>`;
}

/** ボタンのラベル先頭に置く形（`<span class="btn-ic">svg</span>`）。ラベルは textContent 相当に escape する */
export function iconLabelHtml(id: IconId, label: string, o?: IconOpts): string {
  return `<span class="btn-ic">${iconHtml(id, o)}</span>${escAttr(label)}`;
}

/** 要素の中身を「アイコン＋文字」にする（textContent の置き換え版・子を作り直す） */
export function setIconLabel(el: HTMLElement, id: IconId, label: string, o?: IconOpts): void {
  const span = document.createElement("span");
  span.className = "btn-ic";
  span.appendChild(icon(id, o));
  el.replaceChildren(span, document.createTextNode(label));
}

// ---------------- 文中の参照 `{icon:xxx}` ----------------

const PLACEHOLDER = /\{icon:([a-z0-9-]+)\}/g;

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 訳文などの**文字列**を HTML にする: `{icon:xxx}` だけをインライン SVG に置換し、**それ以外の `<` `>` `&` は escape**
 *  （翻訳文は信頼できるが、それでも HTML の入口を作らない＝XSS の網）。知らない id は文字のまま残す（smoke 検査4 で赤になる）。 */
export function iconizeText(s: string, o?: IconOpts): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(PLACEHOLDER)) {
    out += escHtml(s.slice(last, m.index));
    const id = m[1];
    out += isIconId(id) ? iconHtml(id, o ?? { size: "1em" }) : escHtml(m[0]);
    last = m.index! + m[0].length;
  }
  return out + escHtml(s.slice(last));
}

/** 文中参照を持つキー用の `t()`。返り値は **HTML**（innerHTML に入れる）。`t()` と同じ引数。 */
export function tHtml(key: string, vars?: Record<string, unknown>): string {
  return iconizeText(t(key, vars));
}

/** `{icon:xxx}` を**文字**にする（title 属性など HTML が入らない所に、どうしても置くとき用）。
 *  いまは使っていない＝title 属性に入るキーは訳文側で言葉に直した。 */
export function stripIconPlaceholders(s: string): string {
  return s.replace(PLACEHOLDER, "").replace(/\s{2,}/g, " ").trim();
}

// ---------------- 静的 DOM（index.html の data-icon） ----------------

/** `data-icon="undo"` を持つ要素に SVG を差し込む。`data-i18n` と併用する要素は、**applyI18n のあと**に呼ぶ
 *  （applyI18n は textContent を書くので子が消える＝呼ぶ順序が肝心。両方の入口＝起動時と言語切替）。
 *  文字を持つボタン（保存 等）は先頭に `<span class="btn-ic">`、文字を持たないボタン（↶ 等）は SVG だけにする。 */
export function applyIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    const id = el.dataset.icon ?? "";
    if (!isIconId(id)) return; // smoke 検査5 が赤にする
    // 既に差してあれば作り直す（言語切替で applyI18n が textContent を書いたあと）
    el.querySelectorAll(":scope > .btn-ic, :scope > svg.icon").forEach((n) => n.remove());
    const text = (el.textContent ?? "").trim();
    if (text) setIconLabel(el, id, text);
    else el.replaceChildren(icon(id));
  });
}
