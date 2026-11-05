// V169（開くと真っ白になる件＝JSON 配列の IPC／Alt 単独で固まる件＝OS のメニューモード）の回帰ゲート。
// 引数不要:  npx tsx scripts/v169_smoke.ts
//
// ★この回でいちばん怖いのは2つ:
//   ① **.memoanima を JSON 配列（`read_file_bytes`）で読む道が残る／また増える**
//      → 128MiB（V8 `FixedArray::kMaxLength` = 134,217,728 要素）を超えた瞬間にレンダラが**例外ではなく致命停止**する
//        （crbug.com/1201626・ログも catch も効かない＝真っ白）。検査1 が呼び出し元を**全数**で持ち、増えたら赤。
//        検査2 が `projectFromBytes(` の入力は必ず `readProjectRaw` から、を固定する。
//   ② **Alt 単独の既定動作（Win32 SC_KEYMENU）を止める網が片方だけになる**
//      → DefWindowProc は keydown で印を立て keyup で発火するので、**両方**止めないと入る。検査5 と 5z（片方外すと赤）。
//
// 1. `read_file_bytes` の呼び出し元一覧（src 全走査・file:関数名）。許可 4件（V172 で音声が抜けて 5→4）・増えたら赤
// 2. `projectFromBytes(` の入力は `readProjectRaw` から（同じ関数の手前に `read_file_bytes` が無い）
// 3. `readProjectRaw` の定義は src に1つ（写し禁止）
// 4. `TOO_LARGE:` が帯に生のまま届かない（純関数 `tooLargeBytes` ＋ showLoadError の分岐 ＋ 7言語）
// 5. Alt 単独の keydown と keyup の**両方**が window の capture で preventDefault（純関数 `isLoneAltKey` を Node で叩く）
//    5z 反証: 片方の登録を外した写しは赤になる
// 6. `[V167 C] alt unbalanced` の行が残っている（直ったことを同じ行で確かめる道を消していない）
// 7. Rust 側コメント（B-4）・inputlog の dp=（A-3）・perf 行を足していない（B-5）
// 8. V201 (P-3): オートセーブも生のバイト列で受け取る（load_autosave の呼び出し元の固定・数の配列で受け取る所が 0・Rust の戻り値の形）
//    8z 反証: 数の配列に戻す・呼び出しを足す・Rust を JSON に戻すと赤
// 9. V202 (M-1a): モバイルの開く道（mobile_read_work・mobile_autosave_read）も生のバイト列（呼び出し元の固定・数の配列で受け取る所が 0）
//    9z 反証: 数の配列に戻す・呼び出しを足す・Rust を JSON に戻すと赤
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
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
// 自分のコメントに当たらない（行コメントもブロックコメントも落とす）
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/[^\n"'`]*$/gm, "");
const mainRaw = read("src/main.ts");
const libRaw = read("src/library.ts");
// ★V213 (M-2a): editor.ts の描く処理はコア（src/editor/core/editorCore.ts）へ移った＝editor.ts とコアの字を並べて見る
const edRaw = readEditorSource(root);
const main = strip(mainRaw);
const lib = strip(libRaw);
const ed = strip(edRaw);

/** 位置 idx を含む関数の名前（top-level の function/const と、クラスのメソッド/矢印プロパティ）。
 *  `if (`・`for (` 等のキーワードは関数名として拾わない。 */
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "typeof", "new", "else", "do", "try"]);
function enclosingFn(src: string, idx: number): string {
  const head = src.slice(0, idx);
  const re =
    /\n(?:export )?(?:async )?function\s+([A-Za-z_$][\w$]*)\s*\(|\n(?:export )?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|\n  (?:private |protected |public )?(?:static )?(?:readonly )?(?:async )?([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s*)?)?\(/g;
  let name = "?";
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    const n = m[1] ?? m[2] ?? m[3];
    if (!KEYWORDS.has(n)) name = n;
  }
  return name;
}
function sitesOf(src: string, file: string, needle: RegExp): { file: string; fn: string; idx: number }[] {
  const out: { file: string; fn: string; idx: number }[] = [];
  const re = new RegExp(needle.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ file, fn: enclosingFn(src, m.index), idx: m.index });
  return out;
}
/** src/ 直下と src/editor・src/ui の .ts を全部（走査の対象を増やしたときに漏らさない） */
function listSrc(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.ts$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(path.relative(root, p).replace(/\\/g, "/"));
    }
  };
  walk(path.join(root, "src"));
  return out;
}
const SRC = listSrc();

// ================= 1. read_file_bytes の呼び出し元一覧（増えたら赤） =================
{
  const all: { file: string; fn: string }[] = [];
  // 独立レビューの指摘（低）: 型引数なしの `invoke("read_file_bytes"` も拾う
  for (const f of SRC) all.push(...sitesOf(strip(read(f)), f, /invoke(?:<[^>]*>)?\("read_file_bytes"/));
  const got = all.map((s) => `${s.file}:${s.fn}`).sort();
  // 薄いラッパー（`const CMD = "read_file_bytes"` 等）経由も見逃さない: コメントを除いた **文字列の出現数** が呼び出し数と一致
  let mentions = 0;
  for (const f of SRC) mentions += (strip(read(f)).match(/read_file_bytes/g) ?? []).length;
  check("1 read_file_bytes の語はコメント以外では invoke の呼び出しにしか現れない（ラッパー無し）", mentions === all.length, `語=${mentions} 呼び出し=${all.length}`);
  // 許可（4件）: .kwz/.ppm と PNG サイドカー（数MB・境界の下）。
  // 画像は V170 で read_file_raw へ（読む前の門番 IMAGE_IMPORT_MAX_BYTES＝v170_smoke 検査1）。
  // 音声（mp3/wav/ogg）は V172 で read_file_raw へ（読む前の門番 AUDIO_IMPORT_MAX_BYTES＝v172_smoke 検査1）
  const ALLOW = [
    "src/library.ts:loadThumb", // PNG サイドカー／note のサムネ（同じ関数の中に2つ。V169 前は project の予備道も含めて3つ）
    "src/library.ts:loadThumb",
    "src/library.ts:select", // note のプレビュー
    "src/main.ts:openEditorWithNote", // .kwz/.ppm を開く
  ].sort();
  check("1 ★read_file_bytes の呼び出し元は許可4件と一致（.memoanima・画像・音声を読む道に残っていない・増えていない）", JSON.stringify(got) === JSON.stringify(ALLOW), `いま ${got.length} 件: ${got.join(" | ")}`);
  check("1 全走査の対象に main.ts と library.ts が入っている", SRC.includes("src/main.ts") && SRC.includes("src/library.ts"));
}

// ================= 2. projectFromBytes の入力は readProjectRaw から =================
{
  const bad: string[] = [];
  let n = 0;
  for (const [file, src] of [["src/main.ts", main], ["src/library.ts", lib]] as const) {
    const re = /projectFromBytes\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      n++;
      // この呼び出しの**直前の読み**が何か: 手前で最後に現れた `readProjectRaw(` と `"read_file_bytes"` の近いほう。
      // （同じ関数に .kwz/PNG 用の read_file_bytes が別枝で先にあっても、それは projectFromBytes の入力ではない）
      const fnName = enclosingFn(src, m.index);
      const fnStart = src.lastIndexOf(`${fnName}`, m.index);
      const window_ = src.slice(Math.max(0, fnStart), m.index);
      const iJson = window_.lastIndexOf('"read_file_bytes"');
      const iRaw = window_.lastIndexOf("readProjectRaw(");
      if (iJson >= 0 && iJson > iRaw) bad.push(`${file}:${fnName}`);
    }
  }
  check("2 ★projectFromBytes の入力を read_file_bytes から得ている関数が無い", bad.length === 0, `${bad.length} 件: ${bad.join(", ")}`);
  check("2 走査は projectFromBytes の呼び出しを拾っている（0 なら走査が壊れている）", n >= 5, `n=${n}`);
  // 2z 反証: どれか1つを JSON 配列に戻した写しは赤になる（検出器が本当に見ているか）
  const detect = (src: string): number => {
    let hits = 0;
    const re = /projectFromBytes\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(src))) {
      const fnName = enclosingFn(src, mm.index);
      const w = src.slice(Math.max(0, src.lastIndexOf(fnName, mm.index)), mm.index);
      const iJson = w.lastIndexOf('"read_file_bytes"');
      if (iJson >= 0 && iJson > w.lastIndexOf("readProjectRaw(")) hits++;
    }
    return hits;
  };
  const reverted = lib.replace(
    /const bytes = await readProjectRaw\(it\.path\);\n(\s*)if \(stale\(\)\) return;/,
    'const bytes = await invoke<number[]>("read_file_bytes", { path: it.path });\n$1if (stale()) return;'
  );
  check("2z ★反証: select の読みを JSON 配列に戻した写しは赤になる", detect(lib) === 0 && reverted !== lib && detect(reverted) === 1, `now=${detect(lib)} reverted=${detect(reverted)}`);
  // 開く3か所は readProjectRaw を呼んでいる（正の確認）
  const open = main.slice(main.indexOf("async function openEditorWithProject("), main.indexOf("function newNote("));
  check("2 openEditorWithProject は readProjectRaw を呼ぶ", /await readProjectRaw\(item\.path\)/.test(open));
  // V173b: ★ここにも同じ穴があった——終わりを**署名の字面**で探していたので、引数が増えた瞬間に
  // `indexOf` が -1 になり、`slice(selStart, -1)` が **select の中ではなくファイル末尾まで**広がっていた
  //（検査が名前どおりのものを見なくなる＝黙る）。両端とも「定義の行頭」で探し、
  // 見つからなければ**黙って通さず**に赤くする
  const selStart = lib.search(/\n\s{2}async select\(it: LibraryView\)/);
  const selEnd = lib.search(/\n\s{2}showLoadError\(/);
  check("2 select と showLoadError の定義が見つかる（切り出しが空振りしていない）", selStart >= 0 && selEnd > selStart, `select@${selStart} showLoadError@${selEnd}`);
  const sel = selStart < 0 || selEnd <= selStart ? "" : lib.slice(selStart, selEnd);
  check("2 ライブラリの select（open.preview の project 枝）は readProjectRaw を呼ぶ", /await readProjectRaw\(it\.path\)/.test(sel));
  const thumbIdx = lib.indexOf("frameToPngBlob(project, project.thumbFrame");
  check("2 サムネの予備道（サイドカー PNG が無いとき）は readProjectRaw を呼ぶ", thumbIdx > 0 && /await readProjectRaw\(it\.path\)/.test(lib.slice(Math.max(0, thumbIdx - 400), thumbIdx)));
}

// ================= 3. readProjectRaw の定義は1つ =================
{
  let defs = 0;
  const where: string[] = [];
  for (const f of SRC) {
    const c = (strip(read(f)).match(/async function readProjectRaw\(/g) ?? []).length;
    if (c) where.push(`${f}×${c}`);
    defs += c;
  }
  check("3 ★readProjectRaw の定義は src に1つ（写し禁止）", defs === 1, where.join(", "));
  check("3 main.ts と library.ts の両方から同じ定義に届く", /readProjectRaw/.test(main) && /readProjectRaw/.test(lib) && (/export async function readProjectRaw\(/.test(lib) || /export async function readProjectRaw\(/.test(main)));
  const raw = SRC.map((f) => strip(read(f))).join("\n");
  // V170 で `IMAGE_IMPORT_MAX_BYTES`（画像・64MiB）が増えた。名前の一部が同じなので、語頭を切って .memoanima 用だけ数える
  check("3 門番 IMPORT_MAX_BYTES は 512MiB のまま（A-59 まで上げない）", /(?<![A-Z_])IMPORT_MAX_BYTES = 512 \* 1024 \* 1024/.test(raw) && (raw.match(/(?<![A-Z_])IMPORT_MAX_BYTES = /g) ?? []).length === 1);
  check("3 読む前に弾く順序（read_file_raw に maxBytes を渡す）は従来どおり", /"read_file_raw",\s*\{\s*path,\s*maxBytes: IMPORT_MAX_BYTES,/.test(raw));
}

// ================= 4. TOO_LARGE が帯に生のまま届かない =================
{
  const et = (await import("../src/ui/errText").catch(() => ({}))) as { tooLargeBytes?: (msg: string) => number | null };
  const fn = et.tooLargeBytes;
  check("4 ★純関数 tooLargeBytes が errText.ts にある", typeof fn === "function");
  if (fn) {
    check("4 'TOO_LARGE:600000000' → 600000000", fn("TOO_LARGE:600000000") === 600000000);
    check("4 'Error: TOO_LARGE:12' → 12（Error の頭が付いていても）", fn("Error: TOO_LARGE:12") === 12);
    check("4 '読み込み失敗: …' → null（他の失敗は触らない）", fn("読み込み失敗: The system cannot find the file") === null);
    check("4 'TOO_LARGE:' だけ → null（数字が無ければ生の文のまま）", fn("TOO_LARGE:") === null);
  }
  // V173b: 切り出しを**署名の字面**（`showLoadError(msg: string)`）で探していたため、引数が増えた瞬間に
  // `indexOf` が -1 を返し、`slice(-1, …)` で**ほぼ空の切れ端**を見て 4 件が赤になった（不変条件は壊れていない）。
  // 定義の行頭だけを見る形にし、見つからなければ**黙って通さず**に赤くする
  const sleStart = lib.search(/\n\s{2}showLoadError\(/);
  check("4 showLoadError の定義が見つかる（切り出しが空振りしていない）", sleStart >= 0);
  const sle = sleStart < 0 ? "" : lib.slice(sleStart, lib.indexOf("private renderMeta("));
  check("4 ★showLoadError は TOO_LARGE を人が読める文（lib.open.tooLarge.msg）に置き換える", /tooLargeBytes\(msg\)/.test(sle) && /t\("lib\.open\.tooLarge\.msg"/.test(sle));
  check("4 それ以外の失敗は従来の文言（lib.meta.loadError.label）のまま", /t\("lib\.meta\.loadError\.label", \{ err: msg \}\)/.test(sle));
  check("4 上限の数字は門番の定数から作る（別の数字を手で書かない）", /IMPORT_MAX_BYTES/.test(sle));
  check("4 約 X MB は切り上げ（独立レビューの指摘・中: 四捨五入だと 512MiB+1B が「約 512 MB・上限 512 MB」になる）", /Math\.ceil\(tooLarge \/ 1024 \/ 1024\)/.test(sle) && !/toFixed\(0\)/.test(sle));
  // 7言語
  const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
  for (const l of LANGS) {
    const d = read(`src/i18n/${l}.ts`);
    const m = /"lib\.open\.tooLarge\.msg":\s*"([^"]*)"/.exec(d);
    check(`4 i18n ${l}: lib.open.tooLarge.msg があり {mb} と {max} を差し込む`, !!m && m[1].includes("{mb}") && m[1].includes("{max}"), m ? m[1].slice(0, 40) : "無い");
  }
  const ja = read("src/i18n/ja.ts");
  const jm = /"lib\.open\.tooLarge\.msg":\s*"([^"]*)"/.exec(ja)?.[1] ?? "";
  check("4 ja の文に「壊れていません」と「どうすればいいか（保存し直した版を開く）」がある", /壊れていません/.test(jm) && /保存し直した/.test(jm));
}

// ================= 5. Alt 単独の keydown/keyup を両方 capture で止める =================
{
  const km = (await import("../src/keymap").catch(() => ({}))) as { isLoneAltKey?: (key: string) => boolean };
  const fn = km.isLoneAltKey;
  check("5 ★純関数 isLoneAltKey が keymap.ts にある", typeof fn === "function");
  if (fn) {
    check("5 'Alt' → 止める", fn("Alt") === true);
    check("5 'AltGraph' → 止めない（欧州配列の文字入力を壊さない）", fn("AltGraph") === false);
    check("5 'a'・'Control'・'Shift'・'F4'・'Meta' → 止めない", ["a", "Control", "Shift", "F4", "Meta", " "].every((k) => fn(k) === false));
  }
  // 登録: window・capture・keydown と keyup の両方・アプリの生存中ずっと（mount/unmount に紐づけない）
  const guardBoth = (src: string) =>
    /window\.addEventListener\("keydown", loneAltGuard, true\);/.test(src) && /window\.addEventListener\("keyup", loneAltGuard, true\);/.test(src);
  check("5 ★keydown と keyup の両方を window の capture で止めている", guardBoth(main));
  const body = /function loneAltGuard\(e: KeyboardEvent\): void \{([\s\S]*?)\n\}/.exec(main)?.[1] ?? "";
  check("5 loneAltGuard は isLoneAltKey(e.key) で判定し preventDefault する", /isLoneAltKey\(e\.key\)/.test(body) && /e\.preventDefault\(\)/.test(body));
  check("5 repeat も文字入力中も止める（body に repeat / isComposing / target の門番が無い）", body !== "" && !/repeat|isComposing|target|INPUT|TEXTAREA/.test(body));
  check("5 伝播は止めない（stopPropagation を呼ばない＝既存の keydown ハンドラの順序を変えない）", body !== "" && !/stopPropagation|stopImmediatePropagation/.test(body));
  check("5 removeEventListener していない（アプリの生存中ずっと）", !/removeEventListener\("key(?:down|up)", loneAltGuard/.test(main));
  // 5z 反証: 片方の登録を外した写しは赤
  const noUp = main.replace(/window\.addEventListener\("keyup", loneAltGuard, true\);/, "");
  const noDown = main.replace(/window\.addEventListener\("keydown", loneAltGuard, true\);/, "");
  check("5z ★反証: keyup の登録を外すと赤になる", guardBoth(main) && !guardBoth(noUp));
  check("5z ★反証: keydown の登録を外すと赤になる", guardBoth(main) && !guardBoth(noDown));
  // エディタ側の計数は残っている（直ったことを同じ行で確かめる）
  check("5 エディタの Alt 計数（altDownCount++ / altUpCount++）は残っている", /this\.altDownCount\+\+/.test(ed) && /this\.altUpCount\+\+/.test(ed));
  check("5 syncAltFromEvent（V166 の自己修復）は残っている", /private syncAltFromEvent\(/.test(ed));
}

// ================= 6. [V167 C] alt unbalanced の行が残っている =================
check("6 ★`[V167 C] alt unbalanced` の行が残っている", /\[V167 C\] alt unbalanced down=\$\{this\.altDownCount\} up=\$\{this\.altUpCount\}/.test(edRaw));

// ================= 7. 周辺（B-4・A-3・B-5） =================
{
  const rs = read("src-tauri/src/lib.rs");
  const i = rs.indexOf("fn read_file_bytes(");
  const above = rs.slice(Math.max(0, i - 700), i);
  check("7 B-4: lib.rs の read_file_bytes のコメントに「.memoanima を読む道には使わない（V169）」と v169_smoke の案内がある", /V169/.test(above) && /v169_smoke/.test(above) && /\.memoanima/.test(above));
  check("7 B-4: read_file_bytes の Rust 実装は変わっていない（1行）", /fn read_file_bytes\(path: String\) -> Result<Vec<u8>, String> \{\n    fs::read\(&path\)\.map_err\(\|e\| format!\("読み込み失敗: \{e\}"\)\)\n\}/.test(rs));
  check("7 A-3: inputlog の keydown/keyup 行に dp=（defaultPrevented）がある", /repeat=\$\{e\.repeat \? 1 : 0\} dp=\$\{e\.defaultPrevented \? 1 : 0\}/.test(edRaw));
  check("7 B-5: perf の open.preview / open.project は従来の1か所ずつ（新しい行を足していない）", (main.match(/runWithBusy\("open\.project"/g) ?? []).length === 1 && (lib.match(/runWithBusy\("open\.preview"/g) ?? []).length === 1);
  // V173b: この行は `showLoadError` の 1 行へ畳んだ（同じ失敗で 2 行出ていた・こちらだけ伏せ字の外だった）。
  // **意図は同じ**——開く失敗のログは「大きさと理由だけ」で、作品名もパスも書かない
  // ⚠ **コメントを落とした側**（`main`）で見る——説明文の中に旧い行の引用が残っているため
  check("7 開く失敗のログは大きさと理由だけ（size は showLoadError の logNote へ畳んだ）", /showLoadError\(errText\(e\), \[item\.path\], false, `size=\$\{item\.size\}`\)/.test(main));
  check("7 ★理由を素の String(e) でログへ書く道が開く経路に無い（伏せ字の外を通らない）", !/open failed/.test(main));
}

// ================= 8. V201 (P-3): オートセーブも生のバイト列で受け取る（数の配列で受け取る所が 0） =================
//  前は Rust の load_autosave が {meta, data, path} の data を JSON の数の配列で返し、JS が number[] で受けていた
//  （大きい作品のオートセーブで、起動のたびにレンダラが同じ所で落ちる＝検査1 と同じ形）。read_file_raw と同じく生のバイト列にした。
//  モバイルの開く道（V202）はこの回では作らない（要件 A8 のモバイルの分は V202 で足す）
{
  /** load_autosave の呼び出し元（file:関数名）とコメント以外の語の数 */
  const sites = (files: [string, string][]) => {
    const all: { file: string; fn: string }[] = [];
    let mentions = 0;
    for (const [f, src] of files) {
      all.push(...sitesOf(src, f, /invoke(?:<[^>]*>)?\("load_autosave"/));
      mentions += (src.match(/load_autosave/g) ?? []).length;
    }
    return { got: all.map((x) => `${x.file}:${x.fn}`).sort(), mentions };
  };
  const files: [string, string][] = SRC.map((f) => [f, strip(read(f))]);
  const s8 = sites(files);
  const ok81 = (x: { got: string[]; mentions: number }) => JSON.stringify(x.got) === JSON.stringify(["src/main.ts:checkAutosave"]) && x.mentions === 1;
  check("8 ★load_autosave の呼び出し元は main.ts の checkAutosave の 1 か所だけ（語はコメント以外では呼び出しにしか現れない）", ok81(s8), `${s8.got.join(" | ")} 語=${s8.mentions}`);
  /** checkAutosave の受け方: ArrayBuffer で受けて共通の部品の readAutosaveEnvelope に渡す・数の配列の形が無い */
  const recvOk = (mainSrc: string) => {
    const at = mainSrc.indexOf("async function checkAutosave(");
    const body = at < 0 ? "" : mainSrc.slice(at, mainSrc.indexOf("\n}\n", at));
    return (
      body !== "" &&
      /payload = readAutosaveEnvelope\(await invoke<ArrayBuffer>\("load_autosave"\)\);/.test(body) &&
      !/number\[\]/.test(body) &&
      !/new Uint8Array\(payload\.data\)/.test(body) &&
      !/Array\.from\(/.test(body) &&
      /projectFromBytes\(payload\.data\)/.test(body)
    );
  };
  check("8 ★checkAutosave は生のバイト列（ArrayBuffer）で受けて readAutosaveEnvelope で分ける・数の配列で受け取る形（number[]・new Uint8Array(配列)）が無い", recvOk(main));
  const core = strip(read("src/editor/saveCore.ts"));
  const env = core.slice(core.indexOf("export function readAutosaveEnvelope("), core.indexOf("\n}\n", core.indexOf("export function readAutosaveEnvelope(")));
  check(
    "8 封筒を分ける関数は ArrayBuffer／Uint8Array だけを受け、作品のバイト列は写さない（subarray）・数の配列の逃げ道が無い",
    env !== "" && /raw: ArrayBuffer \| Uint8Array \| null \| undefined/.test(env) && /data: b\.subarray\(4 \+ headLen\)/.test(env) && !/number\[\]|Array\.isArray|Array\.from/.test(env)
  );
  // Rust: 生のバイト列（tauri::ipc::Response）で返す・数の配列（JSON の data）を作らない
  const rsAll = read("src-tauri/src/lib.rs");
  const rsOk = (rs: string) => {
    const at = rs.indexOf("fn load_autosave(");
    const body = at < 0 ? "" : rs.slice(at, rs.indexOf("\n}\n", at));
    return (
      /fn load_autosave\(app: tauri::AppHandle\) -> Result<tauri::ipc::Response, String> \{/.test(rs) &&
      /tauri::ipc::Response::new\(pack_autosave_payload\(&meta, &p, data\)\)/.test(body) &&
      /Ok\(tauri::ipc::Response::new\(Vec::new\(\)\)\)/.test(body) &&
      !/"data":/.test(rs.slice(rs.indexOf("fn parse_autosave("), rs.indexOf("fn load_autosave(")))
    );
  };
  check("8 ★Rust の load_autosave は生のバイト列（tauri::ipc::Response）で返す・無ければ空の本体・JSON の data（数の配列）を作らない", rsOk(rsAll));
  check(
    "8 読む順（本体 → 控え）と控えに回る条件（読めない・形が違う）は前と同じ",
    /for p in \[file\.clone\(\), dir\.join\("current\.asv\.bak"\)\] \{\n\s*if p\.is_file\(\) \{\n\s*if let Ok\(bytes\) = fs::read\(&p\) \{\n\s*if let Some\(\(meta, data\)\) = parse_autosave\(&bytes\) \{/.test(rsAll)
  );
  // 反証
  check("8z ★反証: checkAutosave の受け方を数の配列に戻した写しは赤", !recvOk(main.replace('payload = readAutosaveEnvelope(await invoke<ArrayBuffer>("load_autosave"));', 'payload = await invoke<{ meta: any; data: number[]; path: string }>("load_autosave");')));
  check("8z ★反証: 作品を new Uint8Array(payload.data) で写す形に戻した写しは赤", !recvOk(main.replace("projectFromBytes(payload.data)", "projectFromBytes(new Uint8Array(payload.data))")));
  check(
    "8z ★反証: load_autosave の呼び出しを 1 つ足した写しは赤",
    !ok81(sites(files.map(([f, src]) => [f, f === "src/library.ts" ? src + '\nvoid invoke("load_autosave");\n' : src] as [string, string])))
  );
  check(
    "8z ★反証: Rust を JSON（Option<serde_json::Value>）で返す形に戻した写しは赤",
    !rsOk(rsAll.replace("fn load_autosave(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {", "fn load_autosave(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {"))
  );
}

// ================= 9. V202 (M-1a・A8 のモバイルの分): モバイルの開く道も生のバイト列（数の配列で受け取る所が 0） =================
//  モバイルだけの読む命令（mobile_read_work＝作品と保存元の指紋・mobile_autosave_read＝開いた作品ごとのオートセーブ）は、Rust が
//  tauri::ipc::Response で返し、JS の口（src/mobile/port.ts）は ArrayBuffer で受けて readAutosaveEnvelope で分ける（写さない）。
//  読む前の大きさの門番（512MiB）は Rust の定数（JS から受けない）。モバイルの道は read_file_bytes も read_file_raw も呼ばない
{
  const READS = /invoke(?:<[^>]*>)?\("mobile_(?:read_work|autosave_read)"/;
  const sites9 = (files: [string, string][]) => {
    const all: { file: string; fn: string }[] = [];
    let mentions = 0;
    for (const [f, src] of files) {
      all.push(...sitesOf(src, f, READS));
      mentions += (src.match(/mobile_(?:read_work|autosave_read)\b/g) ?? []).length;
    }
    return { got: all.map((x) => `${x.file}:${x.fn}`).sort(), mentions };
  };
  const files9: [string, string][] = SRC.map((f) => [f, strip(read(f))]);
  const s9 = sites9(files9);
  const ok91 = (x: { got: string[]; mentions: number }) =>
    JSON.stringify(x.got) === JSON.stringify(["src/mobile/port.ts:makeMobilePort", "src/mobile/port.ts:makeMobilePort"]) && x.mentions === 2;
  check("9 ★モバイルの読む命令（mobile_read_work・mobile_autosave_read）の呼び出し元は src/mobile/port.ts の口の 2 か所だけ（語は呼び出しにしか現れない）", ok91(s9), `${s9.got.join(" | ")} 語=${s9.mentions}`);
  const port = strip(read("src/mobile/port.ts"));
  const recv9 = (p: string) =>
    /readWork: async \(album, name\) => \{\n\s*const raw = await call<ArrayBuffer>\(invoke\("mobile_read_work", \{ args: \{ album, name \} \}\)\);\n\s*const env = readAutosaveEnvelope\(raw\);/.test(p) &&
    /autosaveRead: async \(session\) => \{\n\s*const raw = await call<ArrayBuffer>\(invoke\("mobile_autosave_read", \{ args: \{ session \} \}\)\);\n\s*const env = readAutosaveEnvelope\(raw\);/.test(p) &&
    !/number\[\]|Array\.from\(|Array\.isArray|new Uint8Array\([a-z]+\.data\)/.test(p) &&
    !/read_file_bytes|read_file_raw/.test(p);
  check("9 ★JS の口は ArrayBuffer で受けて readAutosaveEnvelope で分ける・数の配列で受け取る形が 0・read_file_bytes／read_file_raw を呼ばない", recv9(port));
  const mobileSrc = SRC.filter((f) => f.startsWith("src/mobile/")).map((f) => strip(read(f))).join("\n");
  check("9 src/mobile は read_file_bytes・read_file_raw・load_autosave を呼ばない（モバイルの読む道は 9 の 2 つだけ）", SRC.some((f) => f.startsWith("src/mobile/")) && !/"(read_file_bytes|read_file_raw|load_autosave)"/.test(mobileSrc));
  const rs9 = read("src-tauri/src/pclib/mobile/commands.rs");
  const rsOk9 = (rs: string) =>
    /pub fn mobile_read_work\(app: tauri::AppHandle, args: WorkArgs\) -> Result<tauri::ipc::Response, String> \{\n\s*let d = dirs_from_app\(&app\)\?;\n\s*args_read_work\(&d, &args\)\.map\(tauri::ipc::Response::new\)/.test(rs) &&
    /pub fn mobile_autosave_read\(app: tauri::AppHandle, args: SessionArgs\) -> Result<tauri::ipc::Response, String> \{\n\s*let d = dirs_from_app\(&app\)\?;\n\s*args_autosave_read\(&d, &args\)\.map\(tauri::ipc::Response::new\)/.test(rs);
  check("9 ★Rust のモバイルの読む命令は生のバイト列（tauri::ipc::Response）で返す", rsOk9(rs9));
  check("9 読む前の大きさの門番は Rust の定数 512MiB（PC の IMPORT_MAX_BYTES と同じ値・JS から受けない）", /pub const READ_MAX_BYTES: u64 = 512 \* 1024 \* 1024;/.test(read("src-tauri/src/pclib/mobile/ops.rs")) && !/maxBytes/.test(port));
  // 反証
  check("9z ★反証: 口を数の配列で受ける形に戻した写しは赤", !recv9(port.replace('const raw = await call<ArrayBuffer>(invoke("mobile_read_work"', 'const raw = await call<number[]>(invoke("mobile_read_work"')));
  check("9z ★反証: 読む命令の呼び出しを src/library.ts に 1 つ足した写しは赤", !ok91(sites9(files9.map(([f, src]) => [f, f === "src/library.ts" ? src + '\nvoid invoke("mobile_read_work", { args: {} });\n' : src] as [string, string]))));
  check("9z ★反証: Rust を JSON（Vec<u8>）で返す形に戻した写しは赤", !rsOk9(rs9.replace("pub fn mobile_read_work(app: tauri::AppHandle, args: WorkArgs) -> Result<tauri::ipc::Response, String> {", "pub fn mobile_read_work(app: tauri::AppHandle, args: WorkArgs) -> Result<Vec<u8>, String> {")));
}

console.log(`v169 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
