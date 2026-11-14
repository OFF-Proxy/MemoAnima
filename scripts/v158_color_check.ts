// V158 (C-4): 配色トークンを経由しない**新しい**色が増えたら落とす検査。引数不要:
//   npx tsx scripts/v158_color_check.ts
//
// ★なぜ要るか
//   V158 で `styles.css` の直書き（#fff 62・枠線 56・その他 24）を全部 `:root` の変数へ寄せ、
//   `:root[data-theme="dark"]` は**変数だけ**を上書きする形にした。
//   ここに新しい直書きが1つ混ざると、その要素だけが**夜の紙で明るいまま**取り残される
//   ——しかも「明るい配色では正しく見える」ので、作った本人は気づけない。
//
// ★ベースライン方式（m1201 の検査3 と同じ流儀）
//   いま残っている分（＝**意図した例外**）を数で固定し、**それを超えたら落とす**。
//   既存を全部直せと言わない代わりに、増えたら必ず止まる。
import fs from "node:fs";
import path from "node:path";
import { readEditorSource } from "./editorSource";

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
const css = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");

/** `:root { … }` と `:root[data-theme="dark"] { … }` の中は**色の置き場所**なので対象外。
 *  コメントも外す（解説で `#2c2621` と書いただけで落ちると、説明が書けなくなる）。 */
function stripRootBlocks(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")) // 行番号を保つ
    .replace(/^:root(\[data-theme="[a-z]+"\])? \{[\s\S]*?^\}/gm, "");
}

// ---------------------------------------------------------------- styles.css
{
  const body = stripRootBlocks(css);
  const hexes = body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  const rgbas = body.match(/rgba?\((?!var)[^)]*\)/g) ?? [];

  // 意図した例外＝**透明の市松**だけ。どんな背景の上でも「透明」と読めることが仕事なので、
  // 配色に追随させてはいけない（要件の壊すなリスト）。4か所 × 2色 = 8
  const CHECKER_BASELINE = 8;
  // 残っている直書きは、**1つ残らず市松の行にある**ことまで見る。
  // 数だけだと「市松を1つ消して別の直書きを1つ入れる」を見逃す
  const strayHex: string[] = [];
  let checkerDecl = 0;
  for (const l of body.split("\n")) {
    if (/repeating-conic-gradient\(#/.test(l)) checkerDecl++;
    const t = l.trim();
    if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("-")) continue; // 冒頭の解説コメント
    if (!/#[0-9a-fA-F]{3,8}\b/.test(l)) continue;
    if (l.includes("repeating-conic-gradient(")) continue;
    strayHex.push(t.slice(0, 80));
  }

  check(
    `styles.css: 変数を経由しない色は市松の ${CHECKER_BASELINE} 個だけ`,
    hexes.length <= CHECKER_BASELINE,
    `いま ${hexes.length} 個: ${[...new Set(hexes)].join(" ")}`
  );
  check("styles.css: 直書きは市松の行にだけある", strayHex.length === 0, "\n    " + strayHex.join("\n    "));
  check("styles.css: 素の rgba() が無い（成分は --*-rgb から組む）", rgbas.length === 0, rgbas.join(" "));
  check("styles.css: 市松は 4 か所のまま", checkerDecl === 4, `${checkerDecl} 行`);
  check("styles.css: 夜の紙の変数ブロックがある", /:root\[data-theme="dark"\] \{/.test(css));

  // 明るい側で定義した変数は、夜の紙側にも**全部**ある（片方だけ足して取り残さない）
  const grab = (re: RegExp) => {
    const m = css.match(re);
    return new Set((m?.[0].match(/^\s*(--[a-z0-9-]+):/gm) ?? []).map((x) => x.trim().replace(":", "")));
  };
  const light = grab(/^:root \{[\s\S]*?^\}/m);
  const dark = grab(/^:root\[data-theme="dark"\] \{[\s\S]*?^\}/m);
  // フォント等の色でない変数は夜の紙側に無くてよい
  const NON_COLOR = new Set(["--ed-side-top"]);
  const missing = [...light].filter((k) => !dark.has(k) && !NON_COLOR.has(k));
  check(
    "styles.css: 明るい側の色の変数が、夜の紙側にも全部ある",
    missing.length === 0,
    `足りない: ${missing.join(" ")}`
  );
}

// ---------------------------------------------------------------- canvas に描く UI（TS 側）
//  CSS 変数が届かない場所は `uiColor()` で**同じ変数を読む**（C-2）。
//  ここも直書きが増えたら落とす。**作品データの色**（紙色・パレット・描画色）と
//  **絵の上に重ねるプレビュー**（投げ縄・図形・選択枠・格子・カーソル・市松）は対象外。
{
  // ★V213 (M-2a): editor.ts の描く処理はコア（src/editor/core/editorCore.ts）へ移った＝editor.ts とコアの字を並べて数える
  //  （L の番号は並べた字の行。数え方・基準の数は前と同じ）
  const ts = readEditorSource(root);
  const lines = ts.split("\n");
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    // `uiColor("--x", "#fff")` の第2引数は「変数が無いときの保険」なので直書きに数えない。
    // 呼び出しごと外す（`uiColor` を含む行を丸ごと飛ばすと、同じ行の**本当の**直書きを見逃す）
    const l = t.replace(/uiColorA?\([^)]*\)/g, "");
    if (!/"#[0-9a-fA-F]{3,8}"|rgba?\(\d/.test(l)) continue;
    hits.push(`L${i + 1} ${t.slice(0, 70)}`);
  }
  // いま残っているのは**意図した例外**だけ。内訳は報告書 V158_report.md §4 に一覧がある
  const TS_BASELINE = 15;
  check(
    `editor.ts: 配色を経由しない色は ${TS_BASELINE} か所（意図した例外）まで`,
    hits.length <= TS_BASELINE,
    `いま ${hits.length} か所:\n    ` + hits.join("\n    ")
  );
}

// ---------------------------------------------------------------- モバイルの画面（V220・U-9）
//  ★V220 (M-2b-1b・UI §3-1・U-9): モバイルのスタイル（src/mobile/・src/mobileApp/ の .css）も PC と同じ作法。変数の置き場（:root と
//  :root[data-theme="dark"]）の外に色を直書きしない（例外は市松だけ＝いまは市松も無い）。PC と同じ名前の変数は PC と同じ値
//  （例外は明るい紙の --ink-soft と --ink-soft-rgb だけ）。PC の節（上）の基準（市松 8・TS 15）は動かさない。
//  確かめ画面（src/mobileApp/devcheck/・開発用・M-2c で消す）の要素の style の直書きは対象外（画面の部品ではない）。
{
  const walk = (dir: string, ext: RegExp, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, ext, out);
      else if (ext.test(e.name)) out.push(rel);
    }
    return out;
  };
  const cssFiles = [...walk("src/mobile", /\.css$/), ...walk("src/mobileApp", /\.css$/)].sort();
  check("mobile: モバイルのスタイル（mobile.css）を見ている", cssFiles.includes("src/mobileApp/mobile.css"), cssFiles.join(" "));
  const MOBILE_CHECKER_BASELINE = 0;
  for (const f of cssFiles) {
    const text = fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
    const body = stripRootBlocks(text);
    const hexes = body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    const rgbas = body.match(/(?:rgba?|hsla?)\((?!var)[^)]*\)/g) ?? [];
    const named = body.replace(/var\([^)]*\)/g, "").match(/(?<![-\w])(?:color|background(?:-color)?|border(?:-[a-z]+)?|fill|stroke|outline(?:-color)?|box-shadow)\s*:[^;]*\b(?:white|black|red|blue|green|yellow|gray|grey|orange)\b/gi) ?? [];
    check(
      `mobile: ${f} に変数を経由しない色が無い（市松 ${MOBILE_CHECKER_BASELINE}）`,
      hexes.length <= MOBILE_CHECKER_BASELINE && rgbas.length === 0 && named.length === 0,
      [...hexes, ...rgbas, ...named].join(" ")
    );
  }
  // ★V221 (M-2b-2・指示書 ■7 [U]): 名指しの例外の行（要件書が値を決めた色＝ピクセル格子 UI §4-1・作品の絵の上の下書きの色＝PC と同じ値で
  //  配色で変えない＝PC の V158 C-2 と同じ判断）。行の頭の字で名指しする（ほかの行に色を書くと今までどおり赤）
  const V221_TS_COLOR_LINES = [
    { file: "src/mobileApp/editor/mobileEditor.ts", line: 'const GRID_RGBA = "rgba(128, 128, 128, 0.28)";' },
    { file: "src/mobileApp/editor/mobileEditor.ts", line: 'const SKETCH = { shape: "rgba(240,122,26,.9)",' },
    { file: "src/mobileApp/editor/mobileEditor.ts", line: "// ★色は CSS の変数だけ。例外は要件書が値を決めたもの: ピクセル格子 `rgba(128, 128, 128, 0.28)`" },
  ];
  // TS（DOM に色を差す所）: 生成物の束（色は var() だけ）と確かめ画面を除いて、直書きが 0
  const tsFiles = [...walk("src/mobile", /\.ts$/), ...walk("src/mobileApp", /\.ts$/)].filter((f) => !f.startsWith("src/mobileApp/devcheck/")).sort();
  const tsHits: string[] = [];
  for (const f of tsFiles) {
    fs.readFileSync(path.join(root, f), "utf8")
      .split("\n")
      .forEach((l, i) => {
        const t = l.trim();
        if (t.startsWith("//") || t.startsWith("*")) return;
        if (/["'`][^"'`]*#[0-9a-fA-F]{3,8}\b|rgba?\(\d/.test(t) && !V221_TS_COLOR_LINES.some((x) => x.file === f && t.startsWith(x.line)))
          tsHits.push(`${f}:${i + 1} ${t.slice(0, 70)}`);
      });
  }
  check("mobile: TS に色の直書きが無い（確かめ画面を除く）", tsHits.length === 0, tsHits.join(" | "));

  // PC と同じ名前の変数は PC と同じ値（var() は同じ区画の中で開いてから比べる・数の書き方の揺れ〔.18 と 0.18〕は揃える）
  const block = (text: string, dark: boolean): Map<string, string> => {
    const re = dark ? /^:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m : /^:root \{([\s\S]*?)^\}/m;
    const m = text.replace(/\/\*[\s\S]*?\*\//g, "").match(re);
    const out = new Map<string, string>();
    for (const r of (m?.[1] ?? "").matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(r[1], r[2].trim());
    return out;
  };
  const resolve =
    (vars: Map<string, string>, fallback: Map<string, string> | null) =>
    (v: string): string => {
      let s2 = v;
      for (let i = 0; i < 5; i++) s2 = s2.replace(/var\((--[A-Za-z0-9-]+)\)/g, (_, k: string) => vars.get(k) ?? fallback?.get(k) ?? `var(${k})`);
      return s2
        .replace(/\s+/g, " ")
        .replace(/(^|[^\d])\.(\d)/g, (_m, a: string, b: string) => `${a}0.${b}`)
        .replace(/\s*,\s*/g, ", ")
        .toLowerCase();
    };
  const mcss = fs.readFileSync(path.join(root, "src/mobileApp/mobile.css"), "utf8").replace(/\r\n/g, "\n");
  const pcText = css.replace(/\r\n/g, "\n");
  const pcL = block(pcText, false);
  const pcD = block(pcText, true);
  const mL = block(mcss, false);
  const mD = block(mcss, true);
  const EXCEPT_LIGHT = new Set(["--ink-soft", "--ink-soft-rgb"]);
  const diffs: string[] = [];
  let compared = 0;
  for (const [dark, mm, pp] of [
    [false, mL, pcL],
    [true, mD, pcD],
  ] as const) {
    const rm = resolve(mm, dark ? mL : null);
    const rp = resolve(pp, dark ? pcL : null);
    for (const [k, v] of mm) {
      if (!pp.has(k)) continue;
      if (!dark && EXCEPT_LIGHT.has(k)) continue;
      compared++;
      if (rm(v) !== rp(pp.get(k)!)) diffs.push(`${dark ? "dark" : "light"} ${k}: ${rm(v)} ≠ PC ${rp(pp.get(k)!)}`);
    }
  }
  check(
    "mobile: PC と同じ名前の変数は PC と同じ値（例外は明るい紙の --ink-soft・--ink-soft-rgb だけ）",
    diffs.length === 0 && compared >= 50,
    `${compared} 個を比べた ${diffs.join(" | ")}`
  );
  check("mobile: 明るい紙の --ink-soft は #6f6456・--ink-soft-rgb は 111, 100, 86（UI §3-1）", mL.get("--ink-soft") === "#6f6456" && mL.get("--ink-soft-rgb") === "111, 100, 86");
  // UI §3-1 の表の全部（明るい紙と夜の紙）と §3-2・§3-3 と、組む -rgb（期待は手で書く）
  const WANT = [
    "--paper", "--paper2", "--paper3", "--paper4", "--panel", "--surface-2", "--ink", "--ink-soft", "--line", "--film-bg", "--yellow", "--green",
    "--blue", "--red", "--orange", "--orange-l", "--tangerine", "--warn-bg", "--film-hole", "--theater-bg",
    "--dotC", "--emptyB", "--sep", "--delC", "--scrim", "--ring", "--selBg",
    "--ink-on-accent", "--shadow", "--shadow-float", "--ink-rgb", "--shadow-rgb", "--scrim-rgb", "--ink-soft-rgb", "--blue-rgb",
  ];
  const lack = WANT.flatMap((k) => [...(mL.has(k) ? [] : [`light ${k}`]), ...(mD.has(k) ? [] : [`dark ${k}`])]);
  check(`mobile: UI §3-1〜§3-3 の変数 ${WANT.length} 個が明るい紙と夜の紙の両方にある`, lack.length === 0, lack.join(" "));
  const NON_COLOR_M = new Set(["--font-ui", "--font-num"]);
  const onlyLight = [...mL.keys()].filter((k) => !mD.has(k) && !NON_COLOR_M.has(k));
  check("mobile: 明るい側の色の変数が、夜の紙側にも全部ある", onlyLight.length === 0, onlyLight.join(" "));
  // 足した名前の値（ボードの値・PC の成分から組む＝UI §3-1・指示書 ■2(2)a）
  const rmL = resolve(mL, null);
  const rmD = resolve(mD, mL);
  const BOARD: [string, string, string][] = [
    ["--dotC", "rgba(44, 38, 33, 0.05)", "rgba(242, 230, 210, 0.05)"],
    ["--emptyB", "rgba(44, 38, 33, 0.25)", "rgba(242, 230, 210, 0.25)"],
    ["--sep", "rgba(44, 38, 33, 0.15)", "rgba(242, 230, 210, 0.14)"],
    ["--delC", "#c42b2b", "#ff8a8a"],
    ["--scrim", "rgba(44, 38, 33, 0.42)", "rgba(0, 0, 0, 0.55)"],
    ["--ring", "rgba(31, 162, 255, 0.3)", "rgba(77, 184, 255, 0.35)"],
    ["--selbg", "rgba(31, 162, 255, 0.25)", "rgba(77, 184, 255, 0.3)"],
    ["--film-hole", "#fbefd6", "#4a3e37"],
    ["--theater-bg", "#1b1613", "#1b1613"],
  ];
  const getCI = (m: Map<string, string>, k: string) => [...m].find(([kk]) => kk.toLowerCase() === k.toLowerCase())?.[1] ?? "";
  const bad = BOARD.filter(([k, l, d]) => rmL(getCI(mL, k)) !== l || rmD(getCI(mD, k)) !== d).map(([k]) => `${k}: ${rmL(getCI(mL, k))} / ${rmD(getCI(mD, k))}`);
  check("mobile: 足した 9 つの値（ボードの値・--scrim の明るい紙は PC の 44,38,33）", bad.length === 0, bad.join(" | "));
  const composed = ["--dotC", "--emptyB", "--sep", "--scrim", "--ring", "--selBg"].filter(
    (k) => !/var\(--[a-z-]+-rgb\)/.test(mL.get(k) ?? "") || !/var\(--[a-z-]+-rgb\)/.test(mD.get(k) ?? "")
  );
  check("mobile: 組める 6 つ（--dotC・--emptyB・--sep・--scrim・--ring・--selBg）は PC の -rgb から組む", composed.length === 0, composed.join(" "));
}

console.log(`v158 color check: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
