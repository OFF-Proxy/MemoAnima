/**
 * M12-C: 編集中のカーソル。**DOM に触らない純関数だけ**を置く（スモークで pin できる形にするため）。
 *
 * 2階建て:
 *   1階 = `#ed-canvas` の CSS `cursor`（この module の `cursorFor`）
 *   2階 = `#ed-cursor` レイヤーに描くペン先の輪とドット枠（形は `penFootprint`）
 *
 * 要件の正: `docs/REQ_M12_C_cursor.md` §8（案C＝点だけ・道具の印は出さない）
 */

/** 1階の見せ方。"dot"=点（既定・案C）/ "cross"=従来の十字 / "arrow"=標準の矢印 */
export type CursorStyle = "dot" | "cross" | "arrow";

export interface CursorSettings {
  style: CursorStyle;
  /** 2階: ペン先の輪（既定 true） */
  ring: boolean;
  /** 2階: 乗っているドットの枠（既定 **false**） */
  cell: boolean;
}

export const CURSOR_DEFAULTS: CursorSettings = { style: "dot", ring: true, cell: false };

/** 不正値・未知の値は既定へ（`sanitizeMiniDock` / `sanitizeExportScale` と同じ流儀）。 */
export function sanitizeCursor(v: unknown): CursorSettings {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    style: o.style === "cross" || o.style === "arrow" ? o.style : "dot",
    // 既定が異なるので既定側だけを明示的に判定する（ring は既定 true・cell は既定 false）
    ring: o.ring === false ? false : true,
    cell: o.cell === true,
  };
}

/**
 * 案C の点（2×2 ドット）。**黒の本体の下に白のフチ**（`stroke-width: 3`）を敷くので、
 * 黒い線の上でも濃い紙の上でも消えない。ホットスポットは点の中心＝(8,8)。
 * `#` や `"` を含むので必ず `encodeURIComponent` を通す（生のままだと壊れる）。
 */
const DOT_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
      '<rect x="7" y="7" width="2" height="2" fill="none" stroke="#ffffff" stroke-width="3"/>' +
      '<rect x="7" y="7" width="2" height="2" fill="#000000"/>' +
      "</svg>"
  );

/** **末尾に必ず標準名のフォールバック**を置く（data-URI が読めない環境でカーソルが消えないように）。 */
export const DOT_CURSOR = `url("${DOT_SVG}") 8 8, crosshair`;

/** 点を出すツール（REQ §8-b）。 */
const DOT_TOOLS = new Set([
  "pen",
  "eraser",
  "brush",
  "fill",
  "shape",
  "eyedrop",
  "select",
  "warp",
]);

/**
 * 「今のツールと設定 → `#ed-canvas` に入れるカーソル文字列」。
 *
 * **`null` は「触らない」という意味**（空文字ではない）。手のひらと変形は既存の仕組みが
 * `#ed-cvwrap` 側で面倒を見ているので、こちらからは一切代入しない（P-0: 不変）。
 *
 * ※ 実測（M12-C 事前計測）: v1.2.0 では**全ツールでキャンバス上は `crosshair`** だった。
 *   手のひらの `grab` は `#ed-cvwrap` に入るが `#ed-canvas { cursor: crosshair }` に負けて
 *   キャンバス上には出ていない。ここを "grab" に変えると**既存の見た目が変わる**ので変えない。
 */
export function cursorFor(tool: string, style: CursorStyle): string | null {
  // "cross" は「v1.2.0 と見分けがつかない状態に戻す」ための逃げ場。**全ツール**十字に倒す
  if (style === "cross") return "crosshair";
  // M12-G: 手のひらと変形のカーソルは**操作の当たり判定を伝える手がかり**（M11-24）なので、
  // 見た目の好みの設定（"arrow"）では消さない。変形は当たり判定ごとに変わるので
  // ここでは決めず（null＝触らない）、`xformHitTest` の返り値を流す側に任せる
  if (tool === "hand") return "grab";
  if (tool === "transform") return null;
  if (style === "arrow") return "default";
  if (tool === "move") return "move";
  if (tool === "text") return "text";
  return DOT_TOOLS.has(tool) ? DOT_CURSOR : "crosshair";
}

/**
 * M12-G: 手のひら・変形の**動的なカーソル**を `#ed-canvas` に入れるときの最終決定。
 *
 * 従来これらは `#ed-cvwrap` にしか代入されておらず、`#ed-canvas { cursor: crosshair }` が
 * 継承に勝つため**枠の 4px にしか出ていなかった**（M12-C §2-a の実測で判明）。
 * 代入先を増やすときも、`style: "cross"` の逃げ場だけは壊さない。
 */
export function canvasCursorFor(dynamic: string, style: CursorStyle): string {
  if (style === "cross") return "crosshair";
  // `""` は「どのゾーンでもない」＝ `xformHitTest` の既定。その style の素の形へ倒す。
  // "dot" では空にして CSS の `#ed-canvas { cursor: crosshair }` へ落とす（v1.2.0 と同じ見え方）
  if (dynamic === "") return style === "arrow" ? "default" : "";
  return dynamic;
}

/** 2階（輪・ドット枠）を出さないツール。 */
export function cursorLayerHidden(tool: string): boolean {
  return tool === "hand" || tool === "transform" || tool === "text";
}

/** 輪を出すツール（太さの概念があるもの）。 */
export function hasRing(tool: string): boolean {
  return tool === "pen" || tool === "brush" || tool === "eraser";
}

/**
 * 太さ `size` のスタンプが覆うドットの相対座標。
 *
 * **`raster.ts` の `stamp()`（M10-7）と同じ式**をそのまま写している:
 *   - `size === 2` だけは **(cx,cy) を左上とする 2×2 の正方形**（円形判定だと十字に見えるため）
 *   - それ以外は半径 `max(0.5, size/2)` の円（`dx²+dy² <= r²`）
 *   - `size <= 1` は中心1ドットだけ
 *
 * トーン/テクスチャは**ここでは考えない**（spray などは実際にはもっと疎らに飛ぶ）。
 * 輪が示すのは「置いたら塗られうる範囲の外形」で、REQ §2-b の「`PEN_SIZES` から決まる輪郭」に従う。
 *
 * ★この写しが `stamp()` からズレると輪が1ドット狂う。`scripts/m12c_smoke.ts` が
 *   **本物の `stamp()` の出力と突き合わせて**いるので、ズレたらそこで落ちる。
 */
export function penFootprint(size: number): { dx: number; dy: number }[] {
  const out: { dx: number; dy: number }[] = [];
  if (size === 2) {
    for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) out.push({ dx, dy });
    return out;
  }
  const r = Math.max(0.5, size / 2);
  const ri = Math.ceil(r);
  const r2 = r * r;
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 && size > 1) continue;
      if (size <= 1 && (dx !== 0 || dy !== 0)) continue;
      out.push({ dx, dy });
    }
  }
  return out;
}

/** 輪郭の1辺。`dx,dy` はドットの相対座標、`side` はそのドットのどの辺か。 */
export interface FootprintEdge {
  dx: number;
  dy: number;
  side: "top" | "bottom" | "left" | "right";
}

/**
 * `penFootprint` の**外周の辺だけ**を列挙する（隣が覆われていない側＝境界）。
 * こうして輪を描くと、実際に塗られるドットの外形と**必ず一致する**（同じ集合から導くため）。
 */
export function footprintEdges(size: number): FootprintEdge[] {
  const cells = penFootprint(size);
  const has = new Set(cells.map((c) => `${c.dx},${c.dy}`));
  const edges: FootprintEdge[] = [];
  for (const c of cells) {
    if (!has.has(`${c.dx},${c.dy - 1}`)) edges.push({ dx: c.dx, dy: c.dy, side: "top" });
    if (!has.has(`${c.dx},${c.dy + 1}`)) edges.push({ dx: c.dx, dy: c.dy, side: "bottom" });
    if (!has.has(`${c.dx - 1},${c.dy}`)) edges.push({ dx: c.dx, dy: c.dy, side: "left" });
    if (!has.has(`${c.dx + 1},${c.dy}`)) edges.push({ dx: c.dx, dy: c.dy, side: "right" });
  }
  return edges;
}

/**
 * 黒/白の交互（マーチングアンツと同じ流儀・`editor.ts` の `redrawOverlay` に合わせる）。
 * 4ドット周期。どんな背景でも必ずどちらかが見える。アニメーションはしない。
 */
export function antColor(x: number, y: number): string {
  return ((x + y) >> 2) % 2 === 1 ? "#ffffff" : "rgb(44, 38, 33)";
}
