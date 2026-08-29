// V158: 右パネルの2段（L-1）と配色（C-1〜C-3）の回帰ゲート。引数不要:
//   npx tsx scripts/v158_smoke.ts
//
// ★この回でいちばん怖いのは1つ。**配色が作品に漏れること**。
//   画面の色を替えたつもりが、書き出した MP4/GIF/PNG の**絵まで変わって**しまったら、
//   夜の紙で作った人の作品が全部ちがう色で出る——気づくのは公開したあと。
//   だから 4 で「同じ作品を、明るい／夜の紙で合成して**1画素も違わない**」ことを毎回見る。
//
// 1. 配色の値の正規化（知らない値・壊れた値は必ず「明るい」）
// 2. uiColor: 配色を替えたら**新しい色**を返す（覚えっぱなしにしない）／CSS が無い環境では fallback
// 3. 右パネルの2段: 分割比のしまい方（％・範囲外は丸める）／たたみ方（両方たたむは既定へ）
// 4. ★書き出しは配色に左右されない（明るい／夜の紙で compositeFrame が1画素も違わない）
// 5. 書き出し・保存・合成の経路が、配色を**そもそも読んでいない**（import からして無い）
import fs from "node:fs";
import path from "node:path";
import {
  newProject,
  makeEmptyFrame,
  allocIndexBuf,
  PIXELS,
  type Project,
} from "../src/editor/model";
import { compositeFrame } from "../src/editor/render";
import { sanitizeTheme, uiColor, uiColorA, applyTheme, clearThemeCache } from "../src/ui/theme";

// editor.ts は gif.js（ブラウザ前提・self 参照）を静的 import するので self を敷いてから動的 import
(globalThis as unknown as { self: unknown }).self = globalThis;
const { sanitizeLayout, sanitizeSideFold, LAYOUT_DEFAULT, SIDE_FOLD_DEFAULT } = await import(
  "../src/editor/editor"
);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}

const root = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------- 1. 配色の正規化
{
  check("1 既定は明るい", sanitizeTheme(undefined) === "light");
  check(
    "1 知らない値・壊れた値は明るいへ",
    ["Dark", "", null, 0, {}, [], "light", "ダーク"].every((v) => sanitizeTheme(v) === "light")
  );
  check('1 "dark" だけが夜の紙', sanitizeTheme("dark") === "dark");
}

// ---------------------------------------------------------------- 2. uiColor
{
  // ① CSS を読んでいない環境（スモーク・DEV ページ）では fallback で続く＝落ちない
  clearThemeCache();
  check("2 CSS が無ければ fallback", uiColor("--panel", "#ffffff") === "#ffffff");
  check("2 uiColorA が rgba を組む", uiColorA("--ink-rgb", 0.5, "44, 38, 33") === "rgba(44, 38, 33, 0.5)");

  // ② 最小の DOM を敷いて、**配色を替えたら値が変わる**ことを見る。
  //    ここが動かないと、波形・変形の枠だけ明るい配色のまま取り残される（C-2 の肝）
  let attr: string | null = null;
  const VALUES: Record<string, Record<string, string>> = {
    light: { "--panel": "#ffffff" },
    dark: { "--panel": "#352d29" },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    documentElement: {
      setAttribute: (_k: string, v: string) => {
        attr = v;
      },
      removeAttribute: () => {
        attr = null;
      },
    },
  };
  g.getComputedStyle = () => ({
    getPropertyValue: (k: string) => VALUES[attr === "dark" ? "dark" : "light"][k] ?? "",
  });

  applyTheme("light");
  const light = uiColor("--panel", "#000000");
  const lightAgain = uiColor("--panel", "#000000"); // 覚えている経路
  applyTheme("dark");
  const dark = uiColor("--panel", "#000000");
  check("2 明るいの値を読む", light === "#ffffff", light);
  check("2 覚えていても同じ値", lightAgain === light);
  check("2 夜の紙で値が変わる（覚えっぱなしにしない）", dark === "#352d29", dark);
  check("2 明るいへ戻すと data-theme が消える", (applyTheme("light"), attr === null));
}

// ---------------------------------------------------------------- 3. 右パネルの2段
{
  const d = sanitizeLayout(undefined);
  check("3 既定に sideTop がある（％）", d.sideTop === LAYOUT_DEFAULT.sideTop && d.sideTop > 0 && d.sideTop < 100);
  check("3 範囲外は丸める（下段が消えない）", sanitizeLayout({ sideTop: 999 }).sideTop <= 80);
  check("3 小さすぎも丸める", sanitizeLayout({ sideTop: -5 }).sideTop >= 25);
  check(
    "3 壊れた値は既定へ",
    [null, "60", NaN, {}, Infinity].every(
      (v) => sanitizeLayout({ sideTop: v }).sideTop === LAYOUT_DEFAULT.sideTop
    )
  );
  check("3 他の分割は巻き添えにならない", sanitizeLayout({ sideTop: 40 }).sideW === LAYOUT_DEFAULT.sideW);

  check("3 たたみ方の既定は両方ひらく", sanitizeSideFold(undefined).top === false && sanitizeSideFold(undefined).bot === false);
  check("3 上だけたたむ", sanitizeSideFold({ top: true }).top === true && sanitizeSideFold({ top: true }).bot === false);
  // ★両方たたむと「レイヤーが常に見える」が壊れる。受け取っても既定へ落とす
  const both = sanitizeSideFold({ top: true, bot: true });
  check("3 両方たたむ値は既定へ（レイヤーが消えない）", both.top === SIDE_FOLD_DEFAULT.top && both.bot === SIDE_FOLD_DEFAULT.bot);
  check(
    "3 壊れた値は既定へ",
    [null, "yes", 1, []].every((v) => {
      const s = sanitizeSideFold({ top: v, bot: v });
      return s.top === false && s.bot === false;
    })
  );
}

// ---------------------------------------------------------------- 4. ★配色は作品に漏れない
{
  const p: Project = newProject("V158");
  p.layerDefs = [
    { id: "L1", name: "L1", visible: true, opacity: 1 },
    { id: "L2", name: "L2", visible: true, opacity: 0.5 },
    { id: "L3", name: "L3", visible: true, opacity: 1 },
  ];
  p.frames = [];
  for (let f = 0; f < 3; f++) {
    const fr = makeEmptyFrame(p, 0);
    fr.layers = {};
    p.layerDefs.forEach((ld, li) => {
      const b = allocIndexBuf(p);
      for (let k = (f * 7 + li * 11) % 53; k < PIXELS; k += 53) b[k] = ((k + f + li) % 6) + 1;
      fr.layers[ld.id] = b;
    });
    p.frames.push(fr);
  }

  const hash = (a: Uint32Array) => {
    // FNV-1a（32bit）。「何画素目が違うか」まで出したいので差分も数える
    let h = 0x811c9dc5;
    for (let i = 0; i < a.length; i++) {
      h ^= a[i] & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (a[i] >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (a[i] >>> 16) & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (a[i] >>> 24) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  };

  applyTheme("light");
  const lightFrames = p.frames.map((_, i) => compositeFrame(p, i, undefined, { onion: false }));
  applyTheme("dark");
  const darkFrames = p.frames.map((_, i) => compositeFrame(p, i, undefined, { onion: false }));
  applyTheme("light");

  let diff = 0;
  for (let i = 0; i < lightFrames.length; i++)
    for (let k = 0; k < PIXELS; k++) if (lightFrames[i][k] !== darkFrames[i][k]) diff++;
  check(
    "4 ★明るい／夜の紙で合成が1画素も違わない",
    diff === 0,
    `${diff} 画素ちがう（light=${lightFrames.map(hash).join(",")} dark=${darkFrames.map(hash).join(",")}）`
  );
  console.log(`   合成のハッシュ（明/暗とも）: ${lightFrames.map(hash).join(" ")}`);
}

// ---------------------------------------------------------------- 5. 経路に配色が入り込んでいない
{
  // 4 は「今の実装では漏れない」ことしか言えない。**そもそも配色を読める場所に無い**ことまで見る。
  // ここに `ui/theme` や `getComputedStyle` が現れたら、それは書き出しの絵が配色に依存し始めた合図。
  const FILES = [
    "src/editor/render.ts",
    "src/editor/raster.ts",
    "src/editor/serialize.ts",
    "src/editor/exporter.ts",
    "src/editor/model.ts",
    "src/editor/frameClip.ts",
    "src/editor/kwzImport.ts",
  ];
  const bad: string[] = [];
  for (const f of FILES) {
    const s = fs.readFileSync(path.join(root, f), "utf8");
    if (/ui\/theme|uiColor|getComputedStyle|data-theme/.test(s)) bad.push(f);
  }
  check("5 ★書き出し・保存・合成が配色を読まない", bad.length === 0, bad.join(" "));
}

console.log(`v158 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
