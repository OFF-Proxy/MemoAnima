/**
 * M12-C スモーク — カーソルの純関数を pin する（引数なしで走る）。
 *   npx tsx scripts/m12c_smoke.ts
 *
 * いちばん大事なのは §2:
 *   `cursor.ts` の `penFootprint()` は `raster.ts` の `stamp()` の式を**写した**もの。
 *   写しがズレると輪が1ドット狂うので、**本物の stamp() を空バッファに打った結果**と
 *   突き合わせて、集合として完全一致することを確かめる。
 */
import { W, H, type IndexBuf } from "../src/editor/model";
import { stamp } from "../src/editor/raster";
import {
  sanitizeCursor,
  cursorFor,
  canvasCursorFor,
  cursorLayerHidden,
  hasRing,
  penFootprint,
  footprintEdges,
  antColor,
  DOT_CURSOR,
  CURSOR_DEFAULTS,
} from "../src/editor/cursor";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  NG ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

const PEN_SIZES = [1, 2, 3, 5, 8, 12];

// ---------------- §1 設定の正規化（不正値は既定へ） ----------------
{
  const d = sanitizeCursor(undefined);
  ok("既定は 点＋輪ON＋枠OFF", d.style === "dot" && d.ring === true && d.cell === false);
  ok("既定値の定数と一致", JSON.stringify(d) === JSON.stringify(CURSOR_DEFAULTS));
  ok("style の未知値は dot へ", sanitizeCursor({ style: "banana" }).style === "dot");
  ok("style: cross は通る", sanitizeCursor({ style: "cross" }).style === "cross");
  ok("style: arrow は通る", sanitizeCursor({ style: "arrow" }).style === "arrow");
  ok("ring は false のときだけ false", sanitizeCursor({ ring: false }).ring === false);
  ok("ring の不正値は既定 true", sanitizeCursor({ ring: "no" }).ring === true);
  ok("cell は true のときだけ true", sanitizeCursor({ cell: true }).cell === true);
  ok("cell の不正値は既定 false", sanitizeCursor({ cell: 1 }).cell === false);
  ok("null でも落ちない", sanitizeCursor(null).style === "dot");
}

// ---------------- §2 輪の形が stamp() と1ドットも違わない（最重要） ----------------
{
  const cx = 100;
  const cy = 80;
  for (const size of PEN_SIZES) {
    // 本物の stamp() を空バッファへ打つ（テクスチャ/トーンなしの素の形）
    const buf = new Uint8Array(W * H) as unknown as IndexBuf;
    stamp(buf, cx, cy, {
      size,
      color: 1,
      texture: "solid",
      seed: 0,
    } as Parameters<typeof stamp>[3]);
    const real = new Set<string>();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (buf[y * W + x] === 1) real.add(`${x - cx},${y - cy}`);

    const mine = new Set(penFootprint(size).map((o) => `${o.dx},${o.dy}`));
    const missing = [...real].filter((k) => !mine.has(k));
    const extra = [...mine].filter((k) => !real.has(k));
    ok(
      `太さ${size}: penFootprint が stamp() と一致（${real.size}ドット）`,
      missing.length === 0 && extra.length === 0,
      `足りない=${missing.join(" ")} 余計=${extra.join(" ")}`
    );
  }
  // 太さ2 は「(cx,cy) を左上とする 2×2」という特別扱い（M10-7）。ここが崩れると輪が半ドットずれる
  const two = penFootprint(2).map((o) => `${o.dx},${o.dy}`).sort().join(" ");
  ok("太さ2 は右下へ伸びる 2×2", two === "0,0 0,1 1,0 1,1", two);
  ok("太さ1 は中心1ドットだけ", penFootprint(1).length === 1);
}

// ---------------- §3 輪郭の辺（外周だけを拾えているか） ----------------
{
  ok("太さ1 の輪は4辺", footprintEdges(1).length === 4);
  ok("太さ2 の輪は8辺（2×2 の外周）", footprintEdges(2).length === 8);
  for (const size of PEN_SIZES) {
    const cells = penFootprint(size).length;
    const edges = footprintEdges(size).length;
    // 内側のドットは辺を出さない＝辺の数はドット数×4より必ず少ない（太さ1以外）
    ok(`太さ${size}: 外周だけになっている`, size === 1 ? edges === 4 : edges < cells * 4);
  }
  // 内側に穴が空いていない（外周の辺は必ず偶数本で閉じる）
  for (const size of PEN_SIZES) {
    ok(`太さ${size}: 辺の数が偶数`, footprintEdges(size).length % 2 === 0);
  }
}

// ---------------- §4 1階のカーソル文字列 ----------------
{
  const DOT_TOOLS = ["pen", "eraser", "brush", "fill", "shape", "eyedrop", "select", "warp"];
  for (const tool of DOT_TOOLS) {
    ok(`${tool}: 既定は点`, cursorFor(tool, "dot") === DOT_CURSOR);
  }
  ok("move は move", cursorFor("move", "dot") === "move");
  ok("text は text", cursorFor("text", "dot") === "text");
  // M12-G: 手のひらは grab を返す（キャンバス上にも出す）。変形は当たり判定ごとに変わるので null
  ok("hand は grab", cursorFor("hand", "dot") === "grab");
  ok("hand は arrow でも grab（操作を伝えるカーソルは残す）", cursorFor("hand", "arrow") === "grab");
  ok("hand も cross では crosshair（逃げ場）", cursorFor("hand", "cross") === "crosshair");
  ok("transform は動的なので null", cursorFor("transform", "dot") === null);
  ok("transform は arrow でも null", cursorFor("transform", "arrow") === null);
  ok("transform も cross では crosshair（逃げ場）", cursorFor("transform", "cross") === "crosshair");
  // 「従来の十字に戻せる」＝ cross では全ツール crosshair
  for (const tool of [...DOT_TOOLS, "move", "text"]) {
    ok(`${tool}: cross は crosshair`, cursorFor(tool, "cross") === "crosshair");
  }
  for (const tool of [...DOT_TOOLS, "move", "text"]) {
    ok(`${tool}: arrow は default`, cursorFor(tool, "arrow") === "default");
  }
  // data-URI の作法（ホットスポット明示・末尾に標準名のフォールバック）
  ok("点は data:image/svg+xml", DOT_CURSOR.includes("data:image/svg+xml"));
  ok("ホットスポットを明示している", / 8 8, /.test(DOT_CURSOR));
  ok("末尾が標準名のフォールバック", DOT_CURSOR.trimEnd().endsWith(", crosshair"));
  ok("白のフチが入っている", DOT_CURSOR.includes(encodeURIComponent('stroke-width="3"')));
  ok("生の # が混ざっていない（要エンコード）", !DOT_CURSOR.slice(DOT_CURSOR.indexOf(",") + 1).includes("#"));
}

// ---------------- §5 2階を出さないツール ----------------
{
  ok("hand は2階を出さない", cursorLayerHidden("hand"));
  ok("transform は2階を出さない", cursorLayerHidden("transform"));
  ok("text は2階を出さない", cursorLayerHidden("text"));
  ok("pen は2階を出す", !cursorLayerHidden("pen"));
  ok("輪はペン/ブラシ/消しゴムだけ", hasRing("pen") && hasRing("brush") && hasRing("eraser"));
  for (const tool of ["fill", "shape", "eyedrop", "select", "warp", "text", "hand", "move", "transform"]) {
    ok(`${tool} に輪は出さない`, !hasRing(tool));
  }
}

// ---------------- §6 黒白交互（マーチングアンツと同じ流儀） ----------------
{
  ok("4ドット周期で切り替わる", antColor(0, 0) !== antColor(0, 4));
  ok("同じ周期内は同色", antColor(0, 0) === antColor(0, 3));
  ok("白と黒の2色だけ", new Set([antColor(0, 0), antColor(0, 4)]).size === 2);
  ok("黒はアンツと同じ値", antColor(0, 0) === "rgb(44, 38, 33)");
}

// ---------------- §7 M12-G: 手のひら・変形の動的カーソルを #ed-canvas へ流す ----------------
{
  // xformHitTest（M11-24）が返しうる文字列の全部。**この一覧は判定側の写しではなく、
  // 「流す側が何を受け取っても壊れない」ことを確かめるためのもの**
  const ZONES = ["nwse-resize", "nesw-resize", "grab", "move", ""];
  for (const z of ZONES) {
    ok(`dot: ${z || "(指定なし)"} はそのまま流れる`, canvasCursorFor(z, "dot") === z);
    ok(`cross: ${z || "(指定なし)"} は crosshair へ倒れる`, canvasCursorFor(z, "cross") === "crosshair");
  }
  // arrow は**操作カーソルは残す**が、「どのゾーンでもない」ときだけ素の矢印へ倒す
  for (const z of ZONES.filter((z) => z !== "")) {
    ok(`arrow: ${z} はそのまま流れる`, canvasCursorFor(z, "arrow") === z);
  }
  ok("arrow の「指定なし」は default", canvasCursorFor("", "arrow") === "default");
  ok("dot の「指定なし」は空（CSS の crosshair へ落とす）", canvasCursorFor("", "dot") === "");
  // 逃げ場の要（style: "cross" なら、どんな動的カーソルでも v1.2.0 と同じ十字）
  ok(
    "cross ではすべて crosshair",
    ZONES.every((z) => canvasCursorFor(z, "cross") === "crosshair")
  );
}

console.log(`\nm12c smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
