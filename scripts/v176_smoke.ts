// V176（ブラシの線の段を揃える A-70 ＋ 文字ツールの書体を 5 本足す A-71）の回帰ゲート。引数不要:
//   npx tsx scripts/v176_smoke.ts
//
// ★この回は**描いた結果が変わる**回。だから守るものが 2 種類ある。
//
//  A-70 で怖いのは「**直したつもりが、別の経路を巻き込む**」こと。
//   段が揃わない真因は `raster.ts` ではなく **座標の渡され方**（`clientToPixel` の `floor` と、
//   関節ごとに `lastPt` を整数へ丸め直していたこと）なので、**`raster.ts` は 1 行も触らない**。
//   触らなければ、`raster.ts` を import している既存スモーク **8 本**（m1119 / m12c / m132b /
//   m14 / m16 / m17 / m19 / m22）がそのまま緑でいられる → [S-1] が**ハッシュで**固定する。
//   そして「丸めを戻す」逆戻りを [S-4] が捕まえる（**丸めるのは打点の瞬間だけ**）。
//
//  A-71 で怖いのは「**黙って作り直す**」こと。
//   `subset.py` は `JOBS` を全部作り直す作りなので、そのまま走らせると**既存 7 本の woff2 も
//   作り直される**。fontTools の版が違えばバイト列が変わり、**見た目はほぼ同じなので誰も気づけない**。
//   → [S-11] が既存 7 本のハッシュを**2 重**に固定する（MANIFEST の記録と／この回の実測値と）。
//   もう 1 つは「**2 箇所に書き分けてズレる**」こと → [S-5]・[S-7]・[S-8] が `FONTS` と
//   `@font-face` の対応を 1 対 1 で縛る。
//
// [S-1]  src/editor/raster.ts が V174 時点から 1 バイトも変わっていない
// [S-2]  clientToPixel() が clientToPixelF() の Math.floor で書かれている（実装が 2 つに割れていない）
// [S-3]  ブラシ／ペン／消しゴムの経路が clientToPixelF を使っている
// [S-4]  lastPt / smoothPt に Math.round / Math.floor を掛けて保存していない（逆戻り検知）
// [S-5]  FONTS の各項目に styles.css の @font-face が過不足なく 1 対 1
// [S-6]  sizes が空でなく・昇順・重複なし。dot 系は設計グリッドの整数倍
// [S-7]  hasBold: false の書体に weight 700 の @font-face が無い
// [S-8]  assets/fonts/ の woff2 が全部参照されている（孤児ファイルなし）
// [S-9]  MANIFEST.txt に新しい 5 本の行がある
// [S-10] tools/fonts/licenses/ に新しい 5 本の条文がある（make_licenses.ts が読む名前と一致）
// [S-11] ★既存 7 本の woff2 の SHA-256 が不変（黙った作り直しの検知）
// [S-12] 新しい 5 本の書体名が 7 言語ぜんぶにある
// [S-13] 反証: 上の検査が**わざと壊すと赤くなる**ことを、その場で写しを作って確かめる
import crypto from "node:crypto";
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
const readIf = (p: string) =>
  fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), "utf8") : "";
const sha256 = (p: string): string =>
  fs.existsSync(path.join(root, p))
    ? crypto.createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex")
    : "";

type V = { ok: boolean; why: string };
const ok = (): V => ({ ok: true, why: "" });
const ng = (why: string): V => ({ ok: false, why });

// ★V213 (M-2a): 描く処理（ペン系の pointerdown / pointermove の中身・lastPt / smoothPt）はコア（src/editor/core/editorCore.ts）へ移った。
//  editor.ts とコアの字を順に並べたものを読む（見る所を広げるだけ・数え方は変えない。コアが無い木では editor.ts だけ）
const editorRaw = readEditorSource(root);
const fontsRaw = readIf("src/editor/fonts.ts");
const cssRaw = readIf("src/styles.css");
const manifestRaw = readIf("tools/fonts/MANIFEST.txt");
const licRaw = readIf("scripts/make_licenses.ts");

// ⚠ 切り出しが空振りしたら**赤**にする（窓が壊れると検査は黙る＝いちばん損な壊れ方）
check("[S-0] src/editor/editor.ts を読めた", editorRaw !== "");
check("[S-0] src/editor/fonts.ts を読めた", fontsRaw !== "");
check("[S-0] src/styles.css を読めた", cssRaw !== "");
check("[S-0] tools/fonts/MANIFEST.txt を読めた", manifestRaw !== "");

/** 1 行で書かれたメソッドの本体を、**署名行の最後の `{`** から括弧の対応で取り出す。
 *  ⚠ 戻り値の型注釈が `{ x: number; y: number }` のように `{` を含むので、
 *   「head のあと最初の `{`」では**型注釈を掴んでしまう**。最後の `{` を取ること。 */
function methodBody(src: string, name: string): string {
  const re = new RegExp(`^[ \\t]*(?:private |public |protected )?(?:async )?${name}\\s*\\(.*$`, "m");
  const m = re.exec(src);
  if (!m) return "";
  const rel = m[0].lastIndexOf("{");
  if (rel < 0) return "";
  const open = m.index + rel;
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") {
      d--;
      if (d === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

/** `head`（正規表現）に続くブロックを、括弧の対応で丸ごと取り出す（複数） */
function blocksAfter(src: string, head: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(head.source, head.flags.includes("g") ? head.flags : head.flags + "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = src.indexOf("{", m.index + m[0].length - 1);
    if (open < 0) continue;
    let d = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") d++;
      else if (src[i] === "}") {
        d--;
        if (d === 0) {
          out.push(src.slice(open, i + 1));
          re.lastIndex = i;
          break;
        }
      }
    }
  }
  return out;
}

// ================= [S-1] raster.ts が 1 バイトも変わっていない =================
//
// 段が揃わない真因は**座標の渡され方**であって `raster.ts` ではない。触らなければ、
// `raster.ts` を import している既存スモーク 8 本がそのまま緑でいられる。
// ★ハッシュで固定する（`git diff` は作業ツリーの状態に左右されるので、検査には使わない）。
const RASTER_SHA_V174 = "23af7320c29458a6da5f2c72f2da75d47711e1912fd63d04ae754aa29f58f1be";
const checkS1 = (actual: string): V => {
  if (actual === "") return ng("raster.ts を読めない");
  if (actual !== RASTER_SHA_V174) return ng(`★raster.ts が変わっている（${actual.slice(0, 16)}…）`);
  return ok();
};
{
  const v = checkS1(sha256("src/editor/raster.ts"));
  check("[S-1] ★src/editor/raster.ts が V174 時点から変わっていない", v.ok, v.why);
}

// ================= [S-2] clientToPixel は clientToPixelF の floor =================
// 実装が 2 つに割れると、**カーソル表示と描線で座標がズレる**（しかも誰も気づかない）
const checkS2 = (src: string): V => {
  if (src === "") return ng("editor.ts を読めない");
  const f = methodBody(src, "clientToPixelF");
  if (f === "") return ng("★clientToPixelF が無い");
  if (!/getBoundingClientRect/.test(f)) return ng("clientToPixelF に写像の中身が無い（検査が黙る）");
  if (/Math\.floor/.test(f)) return ng("★clientToPixelF が小数を返していない（floor が入っている）");
  const i = methodBody(src, "clientToPixel");
  if (i === "") return ng("clientToPixel が無い");
  if (!/clientToPixelF\(/.test(i)) return ng("★clientToPixel が clientToPixelF を使っていない（実装が 2 つに割れている）");
  if (!/Math\.floor/.test(i)) return ng("★clientToPixel が floor していない（既存の呼び出し元の挙動が変わる）");
  if (/getBoundingClientRect|viewRot/.test(i)) return ng("★clientToPixel が写像を自前で持っている（実装が 2 つに割れている）");
  return ok();
};
{
  const v = checkS2(editorRaw);
  check("[S-2] clientToPixel() が clientToPixelF() の Math.floor で書かれている", v.ok, v.why);
}

// ================= [S-3] 描線の経路が clientToPixelF を使う =================
const PEN_CASE = /case "pen":\s*\n\s*case "brush":\s*\n\s*case "eraser":\s*/;
/** ペン／ブラシ／消しゴムの case のうち、**座標を触る 2 つ**（pointerdown と pointermove）。
 *  同じ case は道具オプションの組み立てと pointerup にもあるが、そちらは座標を扱わない。
 *  「絵を描く呼び出しがあるか」で選り分ける（行番号で覚えない）。 */
function penCoordBlocks(src: string): string[] {
  return blocksAfter(src, PEN_CASE).filter((b) => /R\.(stamp|strokeSegment)\(/.test(b));
}
// ★「`clientToStrokePt` という字面がある」だけでは足りない（独立レビューの指摘）。
//  `ptF` を受け取っておきながら、描くのは整数の `pt` のまま——という書き方で素通りできた。
//  そこで **許す形を 1 つだけ決めて、その形であることを要求する**（V174 で効いたやり方）。
const DOWN_MUST = [
  // ★V213: 前の `this.clientToStrokePt(e.clientX, e.clientY)` は、コアの `this.sampleStrokePt(s)`（半画素ずらしはここ）
  /const ptF = this\.sampleStrokePt\(s\);/,
  /this\.smoothPt = \{ x: ptF\.x, y: ptF\.y \};/,
  /this\.lastPt = \{ x: ptF\.x, y: ptF\.y \};/,
  // ★最初の打点は**整数の pt**（＝floor）。小数を丸め直すとカーソルと 1 ドットずれる
  /R\.stamp\(buf2, pt\.x, pt\.y, o\);/,
];
const MOVE_MUST = [
  /const ptF = this\.sampleStrokePt\(s\);/, // ★V213: 前の `this.clientToStrokePt(ev.clientX, ev.clientY)`
  /let tx = ptF\.x;/,
  /let ty = ptF\.y;/,
  /this\.smoothPt\.x \+= \(ptF\.x - this\.smoothPt\.x\) \* 0\.35;/,
  /tx = this\.smoothPt\.x;/,
  /R\.strokeSegment\(\s*buf,\s*this\.lastPt\.x,\s*this\.lastPt\.y,\s*tx,\s*ty,/,
  /this\.lastPt = \{ x: tx, y: ty \};/,
];
const checkS3 = (src: string): V => {
  if (src === "") return ng("editor.ts を読めない");
  const blocks = penCoordBlocks(src);
  // ⚠ 空振り（0 件）と、数が変わったときは**赤**。pointerdown と pointermove の 2 か所あるはず
  if (blocks.length !== 2) return ng(`座標を触るペン系の case が ${blocks.length} 件（2 件のはず）`);
  const [down, move] = blocks;
  for (const re of DOWN_MUST) if (!re.test(down)) return ng(`★pointerdown の形が違う: ${re.source.slice(0, 40)}`);
  for (const re of MOVE_MUST) if (!re.test(move)) return ng(`★pointermove の形が違う: ${re.source.slice(0, 40)}`);
  // ★小数を受け取りながら整数の pt で描く「受け取っただけ」を塞ぐ
  if (/\bpt\.[xy]\b/.test(move)) return ng("★pointermove の描線経路に整数の pt が残っている");
  // 線に渡す座標が clientToPixelF の上に建っていること（写像を2つに書き分けない）
  // ★V213 (M-2a): 前の `clientToStrokePt(cx, cy)`（＝`clientToPixelF` − 0.5）は 2 段に割れた。
  //  PC の `sampleOf(e)` が `clientToPixelF` の結果を**そのまま**サンプルの x・y にし、コアの `sampleStrokePt(s)` がそれを半画素ずらす。
  //  ペン系の 2 経路（DOWN_MUST / MOVE_MUST）が `sampleStrokePt(s)` を使うことは上で縛った。ここでは 3 つを縛る:
  //  ① sampleStrokePt がサンプルの x・y から半画素引く ② sampleOf が clientToPixelF の結果をそのまま x・y にする
  //  ③ PC の pointerdown / pointermove が描き始め・動いた点へ渡すサンプルは sampleOf で作ったもの
  const sp = methodBody(src, "sampleStrokePt");
  if (sp === "") return ng("★sampleStrokePt が無い");
  if (!/\bs\.x\b/.test(sp) || !/\bs\.y\b/.test(sp)) return ng("★sampleStrokePt がサンプルの x・y を使っていない");
  if (!/- 0\.5/.test(sp)) return ng("★sampleStrokePt が半画素ずらしていない（カーソルと 1 ドットずれる）");
  const so = methodBody(src, "sampleOf");
  if (so === "") return ng("★sampleOf が無い");
  if (!/const p = this\.clientToPixelF\(e\.clientX, e\.clientY\);/.test(so)) return ng("★sampleOf が clientToPixelF を使っていない");
  if (!/\bx: p\.x, y: p\.y\b/.test(so)) return ng("★sampleOf が clientToPixelF の結果をそのまま x・y にしていない");
  if (!/this\.strokeStart\(this\.sampleOf\(e\)\)/.test(src)) return ng("★pointerdown が sampleOf のサンプルで描き始めていない");
  if (!/this\.strokeMoveOne\(this\.sampleOf\(ev\)\)/.test(src)) return ng("★pointermove が sampleOf のサンプルを渡していない");
  return ok();
};
{
  const v = checkS3(editorRaw);
  check("[S-3] ブラシ／ペン／消しゴムの 2 経路が小数座標を**実際に描画へ渡している**", v.ok, v.why);
  const blocks = penCoordBlocks(editorRaw);
  const move = blocks[1] ?? "";
  check("[S-3b] 手ブレ補正の係数 0.35 は変えていない", /0\.35/.test(move));
  check("[S-3c] 打点は strokeSegment に任せる（この経路で stamp を直接呼ぶのは pointerdown だけ）",
    !/R\.stamp\(/.test(move) && /R\.stamp\(/.test(blocks[0] ?? ""));
}

// ================= [S-4] lastPt / smoothPt を丸めて保存していない =================
// ★逆戻り検知。**丸めるのは打点の瞬間だけ**（strokeSegment の中で既に Math.round している）
/** `lastPt` / `smoothPt` に書いてよい形の**全部**。ここに無い書き方は赤。
 *  ★「右辺に Math.round が無いこと」だけを見ると、丸めた一時変数を代入する／
 *   `this.lastPt.x = Math.round(...)` とプロパティを直に書く、で素通りできた（独立レビューの指摘）。 */
const PT_WRITE_OK = [
  "this.smoothPt = { x: ptF.x, y: ptF.y };",
  "this.lastPt = { x: ptF.x, y: ptF.y };",
  "this.lastPt = { x: tx, y: ty };",
  "this.lastPt = null;",
  "this.smoothPt = null;",
  // 手ブレ補正の EMA（加算なので丸めではない）
  "this.smoothPt.x += (ptF.x - this.smoothPt.x) * 0.35;",
  "this.smoothPt.y += (ptF.y - this.smoothPt.y) * 0.35;",
];
const checkS4 = (src: string): V => {
  if (src === "") return ng("editor.ts を読めない");
  let seen = 0;
  // プロパティへの直書き（`this.lastPt.x = …`）も含めて拾う
  const WRITE_RE = /this\.(lastPt|smoothPt)(?:\.[xy])?\s*(?:\+=|=)[^;\n]*;/g;
  for (const m of src.matchAll(WRITE_RE)) {
    seen++;
    const stmt = m[0].trim();
    if (!PT_WRITE_OK.includes(stmt))
      return ng(`★lastPt / smoothPt に許していない書き方がある: ${stmt.slice(0, 60)}`);
  }
  // ★V213 (決-6): コアに**新しく**足した「やめる口」（strokeCancel・モバイルの 2 本目の指）は描きかけを捨てるので
  //  `this.lastPt = null;` `this.smoothPt = null;` を 1 回ずつ書く（V213 の前には無いメソッド＝移したコードではない）。
  //  書き方は上で全部（やめる口の中も）許した形かを見たうえで、やめる口の中は**ちょうどこの 2 文**であることを縛り、
  //  数（7）はやめる口の外で数える（前の木と同じ 7）。やめる口が無い木（V213 より前）では 0 件
  const cancel = methodBody(src, "strokeCancel");
  const cancelWrites = [...cancel.matchAll(WRITE_RE)].map((m) => m[0].trim());
  if (cancel !== "" && cancelWrites.join(" ") !== "this.lastPt = null; this.smoothPt = null;")
    return ng(`★やめる口（strokeCancel）の lastPt / smoothPt への書き込みが違う: ${cancelWrites.join(" ").slice(0, 80)}`);
  seen -= cancelWrites.length;
  // ⚠ 空振りは赤（書き方が変わって検査が素通りする形を塞ぐ）
  if (seen !== PT_WRITE_OK.length)
    return ng(`lastPt / smoothPt への書き込みが ${seen} 件（${PT_WRITE_OK.length} 件のはず）`);
  // 手ブレ補正の後に丸めていないこと（tx / ty は小数のまま strokeSegment へ渡す）
  const blocks = penCoordBlocks(src);
  const move = blocks[1] ?? "";
  if (move === "") return ng("pointermove の経路を切り出せない（検査が黙る）");
  if (/(tx|ty)\s*=\s*Math\.(round|floor)/.test(move)) return ng("★手ブレ補正の後で丸めている");
  return ok();
};
{
  const v = checkS4(editorRaw);
  check("[S-4] ★lastPt / smoothPt を丸めて保存していない（逆戻り検知）", v.ok, v.why);
}

// ================= フォントの表を読む =================
interface FontRow {
  key: string;
  cssFamily: string;
  kind: string;
  sizes: number[];
  hasBold: boolean;
  labelKey: string;
}
function parseFonts(src: string): FontRow[] {
  const out: FontRow[] = [];
  for (const m of src.matchAll(
    /\{\s*key:\s*"([^"]+)",\s*labelKey:\s*"([^"]+)",\s*cssFamily:\s*"([^"]+)",\s*kind:\s*"([^"]+)",\s*sizes:\s*\[([^\]]*)\],\s*hasBold:\s*(true|false)\s*\}/g
  ))
    out.push({
      key: m[1],
      labelKey: m[2],
      cssFamily: m[3],
      kind: m[4],
      sizes: m[5].split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)),
      hasBold: m[6] === "true",
    });
  return out;
}
interface FaceRow {
  family: string;
  file: string;
  weight: number;
}
function parseFaces(src: string): FaceRow[] {
  const out: FaceRow[] = [];
  for (const m of src.matchAll(
    /@font-face\s*\{[^}]*font-family:\s*"([^"]+)"[^}]*url\("([^"]+)"\)[^}]*font-weight:\s*(\d+)[^}]*\}/g
  ))
    out.push({ family: m[1], file: path.basename(m[2]), weight: Number(m[3]) });
  return out;
}

const NEW_KEYS = ["kaku", "dot16", "tegaki", "shippori", "reggae"];
/** dot 系の設計グリッド。★ここに無い dot 書体は**赤**（黙って半端なサイズを許さない）。
 *  ⚠ `dot16` は**入っていない**——実測で 16px の設計グリッドを持たないことが分かり、
 *   `kind` を `outline` に切り替えたため（作者決定 2026-09-22）。
 *   もし誰かが `dot16` を `dot` に戻したら、ここに無いので**赤になる**（それが正しい）。 */
const DOT_GRID: Record<string, number> = { misaki: 8, pixel12: 12 };

// ================= [S-5] FONTS ↔ @font-face が 1 対 1 =================
const checkS5 = (fsrc: string, csrc: string): V => {
  const fonts = parseFonts(fsrc);
  const faces = parseFaces(csrc);
  if (fonts.length === 0) return ng("FONTS を 1 件も読めない（検査が黙る）");
  if (faces.length === 0) return ng("@font-face を 1 件も読めない（検査が黙る）");
  for (const f of fonts) {
    const mine = faces.filter((x) => x.family === f.cssFamily);
    const reg = mine.find((x) => x.weight === 400);
    if (!reg) return ng(`★${f.key}: @font-face（weight 400）が無い`);
    const want = f.hasBold ? 2 : 1;
    if (mine.length !== want) return ng(`★${f.key}: @font-face が ${mine.length} 件（${want} 件のはず）`);
    // ★書体と woff2 の**結びつき**まで見る（独立レビューの指摘）。
    //  family とウェイト数だけを照合していたので、`MA Kaku` と `MA Reggae` の url を
    //  入れ替えても全部緑だった。この製品の決まりは「ファイル名＝FontKey」
    if (reg.file !== `${f.key}.woff2`) return ng(`★${f.key}: weight 400 が ${reg.file} を指している`);
    if (f.hasBold) {
      const bold = mine.find((x) => x.weight === 700);
      if (!bold) return ng(`★${f.key}: hasBold なのに weight 700 が無い`);
      if (bold.file !== `${f.key}-bold.woff2`) return ng(`★${f.key}: weight 700 が ${bold.file} を指している`);
    }
  }
  const known = new Set(fonts.map((f) => f.cssFamily));
  const orphan = faces.filter((x) => !known.has(x.family)).map((x) => x.family);
  if (orphan.length) return ng(`★FONTS に無い @font-face がある: ${[...new Set(orphan)].join(", ")}`);
  return ok();
};
{
  const v = checkS5(fontsRaw, cssRaw);
  check("[S-5] FONTS と @font-face が過不足なく 1 対 1", v.ok, v.why);
  const fonts = parseFonts(fontsRaw);
  check("[S-5b] 書体が 10 種類ある（既存 5 ＋ この回の 5）", fonts.length === 10, `いま ${fonts.length}`);
  check("[S-5c] 新しい 5 本が既存の後ろに足されている（並びと既定値を変えない）",
    fonts.slice(0, 5).map((f) => f.key).join(",") === "misaki,pixel12,maru,pop,mincho" &&
      fonts.slice(5).map((f) => f.key).join(",") === NEW_KEYS.join(","));
  check("[S-5d] 既定値 DEFAULT_TEXT は maru 16 太字のまま",
    /family:\s*"maru"\s*as FontKey,\s*size:\s*16,\s*bold:\s*true/.test(fontsRaw));
  check("[S-5e] FontKey に 5 本が足されている",
    NEW_KEYS.every((k) => new RegExp(`\\|\\s*"${k}"`).test(fontsRaw)));
}

// ================= [S-6] sizes の形 =================
const checkS6 = (fsrc: string): V => {
  const fonts = parseFonts(fsrc);
  if (fonts.length === 0) return ng("FONTS を 1 件も読めない（検査が黙る）");
  for (const f of fonts) {
    if (f.sizes.length === 0) return ng(`★${f.key}: sizes が空`);
    for (let i = 1; i < f.sizes.length; i++)
      if (f.sizes[i] <= f.sizes[i - 1]) return ng(`★${f.key}: sizes が昇順でない／重複がある`);
    if (f.kind === "dot") {
      const g = DOT_GRID[f.key];
      if (!g) return ng(`★${f.key}: dot 系なのに設計グリッドが分からない（DOT_GRID に足すこと）`);
      const bad = f.sizes.filter((s) => s % g !== 0);
      if (bad.length) return ng(`★${f.key}: 設計グリッド ${g} の整数倍でない sizes（${bad.join(",")}）`);
    }
  }
  return ok();
};
{
  const v = checkS6(fontsRaw);
  check("[S-6] sizes が空でなく・昇順・重複なし／dot 系は設計グリッドの整数倍", v.ok, v.why);
}

// ================= [S-7] hasBold: false に 700 が無い =================
const checkS7 = (fsrc: string, csrc: string): V => {
  const fonts = parseFonts(fsrc);
  const faces = parseFaces(csrc);
  if (fonts.length === 0 || faces.length === 0) return ng("表を読めない（検査が黙る）");
  for (const f of fonts) {
    if (f.hasBold) continue;
    const bold = faces.filter((x) => x.family === f.cssFamily && x.weight >= 700);
    if (bold.length) return ng(`★${f.key}: hasBold は false なのに weight 700 の @font-face がある`);
  }
  return ok();
};
{
  const v = checkS7(fontsRaw, cssRaw);
  check("[S-7] hasBold: false の書体に weight 700 の @font-face が無い", v.ok, v.why);
  const fonts = parseFonts(fontsRaw);
  check("[S-7b] 新しい 5 本はすべて hasBold: false（合成ボールドでグリッドを壊さない）",
    fonts.filter((f) => NEW_KEYS.includes(f.key)).every((f) => !f.hasBold));
}

// ================= [S-8] 孤児の woff2 が無い =================
const checkS8 = (csrc: string): V => {
  const dir = path.join(root, "assets", "fonts");
  if (!fs.existsSync(dir)) return ng("assets/fonts が無い");
  const onDisk = fs.readdirSync(dir).filter((n) => n.endsWith(".woff2"));
  if (onDisk.length === 0) return ng("woff2 が 1 本も無い（検査が黙る）");
  const used = new Set(parseFaces(csrc).map((x) => x.file));
  const orphan = onDisk.filter((n) => !used.has(n));
  if (orphan.length) return ng(`★どこからも参照されていない woff2: ${orphan.join(", ")}`);
  const missing = [...used].filter((n) => !onDisk.includes(n));
  if (missing.length) return ng(`★@font-face が指す実体が無い: ${missing.join(", ")}`);
  return ok();
};
{
  const v = checkS8(cssRaw);
  check("[S-8] assets/fonts の woff2 が全部参照されている（孤児なし・実体の欠けなし）", v.ok, v.why);
}

// ================= [S-9] MANIFEST に新しい 5 本 =================
const NEW_OUT = ["kaku.woff2", "dot16.woff2", "tegaki.woff2", "shippori.woff2", "reggae.woff2"];
/** MANIFEST の「サブセット: assets/fonts/x.woff2 … sha256 : …」を読む */
function manifestSubsetSha(msrc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of msrc.matchAll(/サブセット:\s*assets\/fonts\/(\S+)[\s\S]{0,120}?sha256\s*:\s*([0-9a-f]{64})/g))
    out[m[1]] = m[2];
  return out;
}
const checkS9 = (msrc: string): V => {
  if (msrc === "") return ng("MANIFEST.txt を読めない");
  // ★パスの字面だけでは足りない（独立レビューの指摘）。SHA-256 の行を消してもパスが残れば緑だった。
  //  **記録の集合と、実際に置いてある woff2 の集合が完全に一致する**ことを要求する
  const rec = manifestSubsetSha(msrc);
  const dir = path.join(root, "assets", "fonts");
  if (!fs.existsSync(dir)) return ng("assets/fonts が無い");
  const onDisk = fs.readdirSync(dir).filter((n) => n.endsWith(".woff2")).sort();
  const listed = Object.keys(rec).sort();
  if (JSON.stringify(listed) !== JSON.stringify(onDisk))
    return ng(`★MANIFEST の記録（${listed.length}）と実ファイル（${onDisk.length}）が一致しない`);
  const miss = NEW_OUT.filter((n) => !rec[n]);
  if (miss.length) return ng(`★MANIFEST に SHA-256 の記録が無い: ${miss.join(", ")}`);
  // 取得元 URL の記録も要る（「後から同じものを取り直せる」ための MANIFEST なので）
  for (const label of ["Zen Kaku Gothic New", "DotGothic16", "Yomogi", "Shippori Mincho", "Reggae One"])
    if (!msrc.includes(label)) return ng(`★MANIFEST に ${label} の項目が無い`);
  const noUrl = NEW_OUT.filter((n) => {
    const at = msrc.indexOf(`assets/fonts/${n}`);
    return at < 0 || !msrc.slice(Math.max(0, at - 700), at).includes("URL");
  });
  if (noUrl.length) return ng(`★取得元 URL の記録が無い: ${noUrl.join(", ")}`);
  return ok();
};
{
  const v = checkS9(manifestRaw);
  check("[S-9] MANIFEST.txt の記録が実ファイルと過不足なく一致し、取得元も残っている", v.ok, v.why);
}

// ================= [S-10] ライセンス条文 =================
const NEW_LIC = [
  "OFL-1.1_ZenKakuGothicNew.txt",
  "OFL-1.1_DotGothic16.txt",
  "OFL-1.1_Yomogi.txt",
  "OFL-1.1_ShipporiMincho.txt",
  "OFL-1.1_ReggaeOne.txt",
];
const checkS10 = (lsrc: string): V => {
  const dir = path.join(root, "tools", "fonts", "licenses");
  const miss = NEW_LIC.filter((n) => !fs.existsSync(path.join(dir, n)));
  if (miss.length) return ng(`★条文が無い: ${miss.join(", ")}`);
  if (lsrc === "") return ng("make_licenses.ts を読めない");
  const unread = NEW_LIC.filter((n) => !lsrc.includes(n));
  if (unread.length) return ng(`★make_licenses.ts が読んでいない: ${unread.join(", ")}`);
  return ok();
};
{
  const v = checkS10(licRaw);
  check("[S-10] 新しい 5 本の条文があり、make_licenses.ts が同じ名前で読んでいる", v.ok, v.why);
  check("[S-10b] make_licenses.ts の同梱フォント一覧に新しい 5 本がある",
    NEW_OUT.every((n) => licRaw.includes(n)));
}

// ================= [S-11] ★既存 7 本の woff2 が不変 =================
//
// `subset.py` は JOBS を全部作り直す作りなので、**既存 7 本も黙って作り直される**。
// fontTools の版が違えばバイト列が変わり、見た目はほぼ同じなので誰も気づけない。
// → 2 重に縛る: ①この回の実測値（下の表）と ②MANIFEST.txt の記録と。
const KEEP_SHA: Record<string, string> = {
  "misaki.woff2": "c4fefbc37cd5756a9bbaf5abb3eedc9b3d48a34c176e9fdb1cbc9237f83dcdf1",
  "pixel12.woff2": "b263b3854aef7a471ca3a10b1415e2ddf2034e0e9f0ab81035ae2a5d7a0ed723",
  "pixel12-bold.woff2": "b4b6bf62a22bba05fce02464dcb74413f209049e5eb37fd392ff573c866b4a66",
  "maru.woff2": "f6e7fb784cb010c26bf8be40abc2ce20ccd0af0201d4443039dd8e182f770d76",
  "maru-bold.woff2": "35bc65a8a619f10c1bb9aadcf6f772f8e3eb798ed36852c69102dae7ee93de3d",
  "pop.woff2": "dc6ff5ec2cb29786e2e3e37a82a7b5c2b28f0183ca89a31856ffed046a4cfb5e",
  "mincho.woff2": "1de89c8f6cf3d64a2a8a77819a75bf39e413db47c299cc58e633407a4779f28d",
};
const checkS11 = (actual: Record<string, string>): V => {
  const bad = Object.entries(KEEP_SHA).filter(([f, h]) => actual[f] !== h).map(([f]) => f);
  if (bad.length) return ng(`★既存の woff2 が変わっている: ${bad.join(", ")}`);
  return ok();
};
{
  const actual: Record<string, string> = {};
  for (const f of Object.keys(KEEP_SHA)) actual[f] = sha256(`assets/fonts/${f}`);
  const v = checkS11(actual);
  check("[S-11] ★既存 7 本の woff2 が 1 バイトも変わっていない（黙った作り直しの検知）", v.ok, v.why);
  const rec = manifestSubsetSha(manifestRaw);
  check("[S-11b] MANIFEST の記録が 12 本そろっている（検査が黙らない）", Object.keys(rec).length === 12, `${Object.keys(rec).length} 件`);
  const mism = Object.entries(rec).filter(([f, h]) => sha256(`assets/fonts/${f}`) !== h).map(([f]) => f);
  check("[S-11c] MANIFEST の記録と実ファイルの SHA-256 が全部一致", mism.length === 0, mism.join(", "));
}

// ================= [S-12] 書体名が 7 言語そろっている =================
const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
{
  const missing: string[] = [];
  for (const lang of LANGS) {
    const src = readIf(`src/i18n/${lang}.ts`);
    if (src === "") {
      missing.push(`${lang}(読めない)`);
      continue;
    }
    for (const k of NEW_KEYS) if (!src.includes(`"ed.text.font.${k}.label"`)) missing.push(`${lang}:${k}`);
  }
  check("[S-12] 新しい 5 本の書体名が 7 言語ぜんぶにある", missing.length === 0, missing.slice(0, 6).join(", "));
  // labelKey は fonts.ts の定義と一致していること（画面に出るのはこの対応）
  const rows = parseFonts(fontsRaw);
  check("[S-12b] labelKey が ed.text.font.<key>.label の形",
    rows.length > 0 && rows.every((f) => f.labelKey === `ed.text.font.${f.key}.label`));
}

// ================= [S-14] 書体の種別を 2 か所に書き分けていない =================
//
// ★V176 で一度、**アプリは dot で描くのに見本シートだけ outline と言う**状態を作りかけた
// （独立レビューが「検査を黙らせている」と止めた）。いまは dot16 が**アプリ自身 outline** なので、
// 道具がそれに従うのは正しい——ただし**表を 2 か所に持つと、また同じズレが起きる**。
// そこで道具側は `src/editor/fonts.ts` の `kind` を**読む**形にし、書き写しを禁じる。
const TOOLS_READ_KIND = ["tools/fonts/make_sample_sheet.ts", "tools/fonts/verify_text_mask.ts"];
/** コメントを落としてから見る（「`dot: true/false` を書き写すな」と**書いてある注意書き**を
 *  書き写しだと誤解しないように）。この道具の注意書きはまさにその字面を含む */
//  ⚠ **行コメントを先に落とすこと。** ブロックコメントから先に落とすと、
//   行コメントの中の `assets/fonts/*.woff2` の `/*` を開始と誤解して、
//   次の `*/` までを丸ごと食う（import 行が消えて検査が誤爆した）
const stripComments = (s: string) =>
  s
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/[^\n"'`]*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
const checkS14 = (raw: Record<string, string>): V => {
  for (const f of TOOLS_READ_KIND) {
    const src = raw[f] ? stripComments(raw[f]) : "";
    if (!src) return ng(`${f} を読めない`);
    if (!/from "\.\.\/\.\.\/src\/editor\/fonts"/.test(src))
      return ng(`★${f} が fonts.ts を読んでいない（種別を書き写している）`);
    if (!/APP_FONTS/.test(src)) return ng(`★${f} が fonts.ts の FONTS を使っていない`);
    // ★書き写しの字面が残っていないこと。
    //  ⚠ 見るのは**表の項目**だけ（`{` か `,` の直後）。`kind: "dot" | "outline"` という
    //   **引数の型注釈**は書き写しではないので、当てない
    if (/[,{]\s*dot:\s*(?:true|false)/.test(src)) return ng(`★${f} の表に dot: が書き写されている`);
    //  （引数の並びもカンマ区切りなので、`"dot" | "outline"` の `|` が続く形は除く）
    if (/[,{]\s*kind:\s*"(?:dot|outline)"(?!\s*\|)/.test(src))
      return ng(`★${f} の表に kind: が書き写されている`);
  }
  return ok();
};
{
  const srcs: Record<string, string> = {};
  for (const f of TOOLS_READ_KIND) srcs[f] = readIf(f);
  const v = checkS14(srcs);
  check("[S-14] 見本シートと参照マスクの道具が、書体の種別を fonts.ts から読んでいる", v.ok, v.why);
  // dot16 が実際に outline になっていること（この回の決定）
  const rows = parseFonts(fontsRaw);
  const d16 = rows.find((f) => f.key === "dot16");
  check("[S-14b] dot16 が outline になっている（設計グリッドを持たないことの実測を受けて）", d16?.kind === "outline", d16?.kind ?? "無い");
  check("[S-14c] dot16 の sizes が 16 の整数倍の縛りから外れている（12 が入っている）", d16?.sizes.includes(12) === true);
}

// ================= [S-13] 反証（わざと壊して赤くなることを見る） =================
{
  // 2z: clientToPixel が自前で写像を持つ（実装が 2 つに割れる）
  const mut2 = editorRaw.replace(
    /private clientToPixel\(cx: number, cy: number\): \{ x: number; y: number \} \{/,
    "private clientToPixel(cx: number, cy: number): { x: number; y: number } {\n    const rect = ($(\"#ed-canvas\") as unknown as HTMLCanvasElement).getBoundingClientRect();"
  );
  check("[S-13] 反証 2z: clientToPixel が写像を自前で持つ写しは [S-2] が赤", editorRaw !== "" && mut2 !== editorRaw && !checkS2(mut2).ok);

  // 1z: raster.ts を 1 バイトでも変える
  check("[S-13] 反証 1z: raster.ts のハッシュが違う写しは [S-1] が赤", !checkS1("0".repeat(64)).ok);

  // 3z: 描線の経路を整数版に戻す
  // ★V213: 前の `clientToStrokePt(ev.clientX, ev.clientY)` → `clientToPixel(ev.clientX, ev.clientY)` は、
  //  コアの pointermove の経路（strokeMoveOne）の `sampleStrokePt(s)` → `samplePixel(s)`（同じ「整数版に戻す」）
  const mut3 = editorRaw.replace(/sampleStrokePt\(s\)(;\n\s*let tx = ptF\.x;)/, "samplePixel(s)$1");
  check("[S-13] 反証 3z: 描線の経路を clientToPixel に戻した写しは [S-3] が赤", editorRaw !== "" && mut3 !== editorRaw && !checkS3(mut3).ok);
  // ★独立レビューの指摘の抜け道: 小数を**受け取るだけ受け取って**、描くのは整数の pt のまま
  const mut3b = editorRaw.replace(/let tx = ptF\.x;\n(\s*)let ty = ptF\.y;/, "let tx = pt.x;\n$1let ty = pt.y;");
  check("[S-13] 反証 3z'（独立レビュー）小数を受け取るだけで描かない写しは [S-3] が赤", editorRaw !== "" && mut3b !== editorRaw && !checkS3(mut3b).ok);
  // ★半画素ずらしを外すと、カーソルと 1 ドットずれる（この回で踏んだ穴）
  //  ★V213: 半画素ずらしはコアの sampleStrokePt（前の `p.x - 0.5` は `s.x - 0.5`）
  const mut3c = editorRaw.replace(/return \{ x: s\.x - 0\.5, y: s\.y - 0\.5 \};/, "return { x: s.x, y: s.y };");
  check("[S-13] 反証 3z''（独立レビュー）半画素ずらしを外した写しは [S-3] が赤", editorRaw !== "" && mut3c !== editorRaw && !checkS3(mut3c).ok);
  // ★最初の打点を小数の丸め直しに戻す（カーソルと 1 ドットずれる形）
  const mut3d = editorRaw.replace(/R\.stamp\(buf2, pt\.x, pt\.y, o\);/, "R.stamp(buf2, Math.round(ptF.x), Math.round(ptF.y), o);");
  check("[S-13] 反証 3z'''（独立レビュー）打点を丸め直しに戻した写しは [S-3] が赤", editorRaw !== "" && mut3d !== editorRaw && !checkS3(mut3d).ok);

  // 4z: lastPt を丸めて保存する（逆戻り）
  const mut4 = editorRaw.replace(/this\.lastPt = \{ x: tx, y: ty \};/, "this.lastPt = { x: Math.round(tx), y: Math.round(ty) };");
  check("[S-13] 反証 4z: lastPt を丸めて保存した写しは [S-4] が赤", editorRaw !== "" && mut4 !== editorRaw && !checkS4(mut4).ok);
  // 4z': 手ブレ補正の後で丸める（以前の形）
  const mut4b = editorRaw.replace(/tx = this\.smoothPt\.x;/, "tx = Math.round(this.smoothPt.x);");
  check("[S-13] 反証 4z': 手ブレ補正の後で丸めた写しは [S-4] が赤", editorRaw !== "" && mut4b !== editorRaw && !checkS4(mut4b).ok);
  // ★独立レビューの指摘の抜け道: 丸めた一時変数を代入する／プロパティを直に丸める
  const mut4c = editorRaw.replace(/this\.lastPt = \{ x: tx, y: ty \};/, "const rx = Math.round(tx), ry = Math.round(ty);\n          this.lastPt = { x: rx, y: ry };");
  check("[S-13] 反証 4z''（独立レビュー）丸めた一時変数を入れた写しは [S-4] が赤", editorRaw !== "" && mut4c !== editorRaw && !checkS4(mut4c).ok);
  const mut4d = editorRaw.replace(/this\.lastPt = \{ x: tx, y: ty \};/, "this.lastPt.x = Math.round(tx);");
  check("[S-13] 反証 4z'''（独立レビュー）プロパティを直に丸めた写しは [S-4] が赤", editorRaw !== "" && mut4d !== editorRaw && !checkS4(mut4d).ok);

  // 5z: @font-face を 1 本だけ消す
  const mut5 = cssRaw.replace(/@font-face \{ font-family: "MA Kaku";[^\n]*\n/, "");
  check("[S-13] 反証 5z: @font-face を 1 本消した写しは [S-5] が赤", cssRaw !== "" && mut5 !== cssRaw && !checkS5(fontsRaw, mut5).ok);
  // 5z': FONTS にだけ足して css に足さない形（＝書き分けのズレ）
  check("[S-13] 反証 5z': css だけ古いままの写しは [S-8] も赤", cssRaw !== "" && mut5 !== cssRaw && !checkS8(mut5).ok);

  // 6z: sizes を降順にする／dot のグリッドを外す／dot 系なのにグリッドが分からない
  const mut6 = fontsRaw.replace(/sizes: \[8, 16, 24, 32, 40, 48\]/, "sizes: [48, 40, 32, 24, 16, 8]");
  check("[S-13] 反証 6z: sizes を降順にした写しは [S-6] が赤", fontsRaw !== "" && mut6 !== fontsRaw && !checkS6(mut6).ok);
  const mut6b = fontsRaw.replace(/sizes: \[12, 24, 36, 48\]/, "sizes: [12, 20, 36, 48]");
  check("[S-13] 反証 6z': dot 系にグリッド外のサイズを入れた写しは [S-6] が赤", fontsRaw !== "" && mut6b !== fontsRaw && !checkS6(mut6b).ok);
  // ★dot16 を dot に戻すと、設計グリッドが分からないので赤（DOT_GRID に無い）
  const mut6c = fontsRaw.replace(
    /{ key: "dot16", labelKey: "ed\.text\.font\.dot16\.label", cssFamily: "MA Dot16", kind: "outline"/,
    '{ key: "dot16", labelKey: "ed.text.font.dot16.label", cssFamily: "MA Dot16", kind: "dot"'
  );
  check("[S-13] 反証 6z'': dot16 を dot に戻した写しは [S-6] が赤（設計グリッドが無い）",
    fontsRaw !== "" && mut6c !== fontsRaw && !checkS6(mut6c).ok);

  // 7z: hasBold: false の書体に 700 を足す
  const mut7 = cssRaw.replace(
    /(@font-face \{ font-family: "MA Kaku";[^\n]*\n)/,
    '$1@font-face { font-family: "MA Kaku"; src: url("../assets/fonts/kaku.woff2") format("woff2"); font-weight: 700; font-display: block; }\n'
  );
  check("[S-13] 反証 7z: hasBold false に 700 を足した写しは [S-7] が赤", cssRaw !== "" && mut7 !== cssRaw && !checkS7(fontsRaw, mut7).ok);

  // 9z / 10z: 記録を消す
  const mut9 = manifestRaw.replace("assets/fonts/kaku.woff2", "assets/fonts/xxx.woff2");
  check("[S-13] 反証 9z: MANIFEST から 1 本消した写しは [S-9] が赤", manifestRaw !== "" && mut9 !== manifestRaw && !checkS9(mut9).ok);
  // ★独立レビューの指摘: パスは残したまま SHA-256 の行だけ消す
  const mut9b = manifestRaw.replace(
    /(サブセット: assets\/fonts\/kaku\.woff2[\s\S]{0,60}?)sha256  : [0-9a-f]{64}/,
    "$1"
  );
  check("[S-13] 反証 9z'（独立レビュー）SHA-256 の行だけ消した写しは [S-9] が赤", manifestRaw !== "" && mut9b !== manifestRaw && !checkS9(mut9b).ok);
  // 11z: 既存の woff2 が 1 バイトでも変わる
  const actual: Record<string, string> = {};
  for (const f of Object.keys(KEEP_SHA)) actual[f] = sha256(`assets/fonts/${f}`);
  check("[S-13] 反証 11z（独立レビュー）既存の woff2 が変わった写しは [S-11] が赤",
    !checkS11({ ...actual, "maru.woff2": "0".repeat(64) }).ok);
  // 5z'': 書体と woff2 の結びつきを入れ替える
  const mut5c = cssRaw
    .replace('"MA Kaku";     src: url("../assets/fonts/kaku.woff2")', '"MA Kaku";     src: url("../assets/fonts/reggae.woff2")')
    .replace('"MA Reggae";   src: url("../assets/fonts/reggae.woff2")', '"MA Reggae";   src: url("../assets/fonts/kaku.woff2")');
  check("[S-13] 反証 5z''（独立レビュー）書体と woff2 を入れ替えた写しは [S-5] が赤", cssRaw !== "" && mut5c !== cssRaw && !checkS5(fontsRaw, mut5c).ok);
  const mut10 = licRaw.replace("OFL-1.1_ZenKakuGothicNew.txt", "OFL-1.1_Xxx.txt");
  check("[S-13] 反証 10z: make_licenses.ts が条文を読まなくなった写しは [S-10] が赤", licRaw !== "" && mut10 !== licRaw && !checkS10(mut10).ok);

  // 14z: 道具側に種別を書き写す（＝アプリとズレる余地を作る）
  const sheetRaw = readIf("tools/fonts/make_sample_sheet.ts");
  const maskRaw = readIf("tools/fonts/verify_text_mask.ts");
  const mut14 = sheetRaw.replace(
    '{ key: "dot16", label: "DotGothic16", file: "dot16.woff2", family: "M10Dot16"',
    '{ key: "dot16", label: "DotGothic16", file: "dot16.woff2", family: "M10Dot16", dot: true'
  );
  check("[S-13] 反証 14z: 見本シートに dot: を書き写した写しは [S-14] が赤",
    sheetRaw !== "" && mut14 !== sheetRaw &&
      !checkS14({ "tools/fonts/make_sample_sheet.ts": mut14, "tools/fonts/verify_text_mask.ts": maskRaw }).ok);
  const mut14b = sheetRaw.replace(/import { FONTS as APP_FONTS } from "\.\.\/\.\.\/src\/editor\/fonts";\n/, "");
  check("[S-13] 反証 14z': 見本シートが fonts.ts を読まなくなった写しは [S-14] が赤",
    sheetRaw !== "" && mut14b !== sheetRaw &&
      !checkS14({ "tools/fonts/make_sample_sheet.ts": mut14b, "tools/fonts/verify_text_mask.ts": maskRaw }).ok);
  const mut14c = maskRaw.replace(
    '{ key: "dot16", file: "dot16.woff2", family: "MA Dot16"',
    '{ key: "dot16", file: "dot16.woff2", family: "MA Dot16", kind: "dot"'
  );
  check("[S-13] 反証 14z'': 参照マスクに kind: を書き写した写しは [S-14] が赤",
    maskRaw !== "" && mut14c !== maskRaw &&
      !checkS14({ "tools/fonts/make_sample_sheet.ts": sheetRaw, "tools/fonts/verify_text_mask.ts": mut14c }).ok);
}

console.log(`\nv176 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
