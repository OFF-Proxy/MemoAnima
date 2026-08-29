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
  const ts = fs.readFileSync(path.join(root, "src/editor/editor.ts"), "utf8");
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

console.log(`v158 color check: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
