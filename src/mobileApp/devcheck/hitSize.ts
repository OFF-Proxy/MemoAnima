// V226 (H-1・DU-3 は A): 押せるものの当たりを数える（確かめ画面の印のビルドだけ）。
//
// ★当たり＝その点を押すと、その押せるもの（か、その中の要素）に届く範囲。見た目の矩形の辺の真ん中から外へ 1px ずつ `elementFromPoint` で確かめて
//  測る（当たりを広げる疑似要素・隣の押せるものが上に重なる所・入れ物が切る所を、押したときと同じ答えで数える）。
// ★記録に書くのは要素の種類（クラスの頭・タグ）と大きさだけ。名前（読み上げの名前は作品名になりうる）は書かない（W-10）。

/** 押せるもの（tap.ts が受けるもの〔data-act〕と、欄・つまみ） */
export const HIT_SELECTOR = '[data-act], input:not([type="hidden"]), select, textarea, [role="slider"], [role="switch"]';

/** 確かめ画面の印のビルドだけに出る開発用のボタン（数えない） */
const DEV_ONLY = '.mb-lib-devexit, [id^="v225-"], [id^="v226-"], [data-id="devcheck-root"]';

export interface HitRow {
  /** 要素の種類（タグ.クラスの頭 2 つ） */
  kind: string;
  /** 当たりの幅と高さ（CSS の px・dp と同じ） */
  w: number;
  h: number;
  /** 見た目の幅と高さ */
  vw: number;
  vh: number;
}

export interface HitReport {
  /** 測った数（見えていて、真ん中を押すと自分に届くもの） */
  measured: number;
  /** 真ん中を押しても自分に届かないもの（上に何かが重なっている）。種類だけ */
  covered: string[];
  /** 当たりが min に足りないもの */
  small: HitRow[];
}

function kindOf(el: Element): string {
  const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter((c) => c && c !== "mb-btn" && c !== "mb-ui").slice(0, 2).join(".") : "";
  return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
}

/** 外へどこまで自分に届くか（px・0.5 刻み・最大 max）。辺のすぐ内側（0.25）から外へ進む */
function reach(doc: Document, el: Element, x: number, y: number, dx: number, dy: number, max: number): number {
  let n = 0;
  for (let i = 0.5; i <= max; i += 0.5) {
    const hit = doc.elementFromPoint(x + dx * (i - 0.25), y + dy * (i - 0.25));
    if (!hit || !(hit === el || el.contains(hit))) break;
    n = i;
  }
  return n;
}

/** 押せるものの当たりを測る。root の中の、見えているものだけ */
export function measureHits(root: ParentNode, min = 48, doc: Document = document): HitReport {
  const vw = doc.documentElement.clientWidth;
  const vh = doc.documentElement.clientHeight;
  const out: HitReport = { measured: 0, covered: [], small: [] };
  root.querySelectorAll(HIT_SELECTOR).forEach((el0) => {
    if (el0.getAttribute("aria-disabled") === "true" || (el0 as HTMLInputElement).disabled) return;
    // 字を打つ欄が <label> の中にあれば、押せる範囲は label（label のどこを押しても欄に入る＝検索欄の丸い箱）。
    //  選ぶ部品（select）は、開くのは部品そのものを押したときなので、そのまま数える
    const el = (/^(INPUT|TEXTAREA)$/.test(el0.tagName) && !/^(range|checkbox|radio)$/.test((el0 as HTMLInputElement).type) ? el0.closest("label") : null) ?? el0;
    if (el.closest("[inert]") || el.closest("[hidden]") || el.closest(DEV_ONLY)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) return;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.pointerEvents === "none") return;
    const at = doc.elementFromPoint(cx, cy);
    if (!at || !(at === el || el.contains(at))) {
      // 中に別の押せるもの（札の中の小さいボタンなど）があるときは、真ん中がそちらに届く＝重なりではない
      if (!(at && (at.closest(HIT_SELECTOR) ?? null) && el.contains(at.closest(HIT_SELECTOR)))) out.covered.push(kindOf(el));
      return;
    }
    out.measured++;
    const MAX = 40;
    const left = reach(doc, el, r.left, cy, -1, 0, MAX);
    const right = reach(doc, el, r.right, cy, 1, 0, MAX);
    const up = reach(doc, el, cx, r.top, 0, -1, MAX);
    const down = reach(doc, el, cx, r.bottom, 0, 1, MAX);
    const w = Math.round((r.width + left + right) * 10) / 10;
    const hgt = Math.round((r.height + up + down) * 10) / 10;
    if (w < min - 0.01 || hgt < min - 0.01) out.small.push({ kind: kindOf(el), w, h: hgt, vw: Math.round(r.width * 10) / 10, vh: Math.round(r.height * 10) / 10 });
  });
  return out;
}

/** 記録の行にする（種類ごとにまとめる） */
export function hitLines(rep: HitReport): string[] {
  const by = new Map<string, { n: number; row: HitRow }>();
  for (const s of rep.small) {
    const k = `${s.kind} ${s.w}x${s.h} (${s.vw}x${s.vh})`;
    const e = by.get(k);
    if (e) e.n++;
    else by.set(k, { n: 1, row: s });
  }
  const lines = [`measured=${rep.measured} small=${rep.small.length} covered=${rep.covered.length}`];
  for (const [k, v] of by) lines.push(`small x${v.n} ${k}`);
  const cov = new Map<string, number>();
  for (const c of rep.covered) cov.set(c, (cov.get(c) ?? 0) + 1);
  for (const [k, n] of cov) lines.push(`covered x${n} ${k}`);
  return lines;
}
