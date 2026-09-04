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
// 1. `read_file_bytes` の呼び出し元一覧（src 全走査・file:関数名）。許可 6件・増えたら赤
// 2. `projectFromBytes(` の入力は `readProjectRaw` から（同じ関数の手前に `read_file_bytes` が無い）
// 3. `readProjectRaw` の定義は src に1つ（写し禁止）
// 4. `TOO_LARGE:` が帯に生のまま届かない（純関数 `tooLargeBytes` ＋ showLoadError の分岐 ＋ 7言語）
// 5. Alt 単独の keydown と keyup の**両方**が window の capture で preventDefault（純関数 `isLoneAltKey` を Node で叩く）
//    5z 反証: 片方の登録を外した写しは赤になる
// 6. `[V167 C] alt unbalanced` の行が残っている（直ったことを同じ行で確かめる道を消していない）
// 7. Rust 側コメント（B-4）・inputlog の dp=（A-3）・perf 行を足していない（B-5）
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
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
// 自分のコメントに当たらない（行コメントもブロックコメントも落とす）
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/[^\n"'`]*$/gm, "");
const mainRaw = read("src/main.ts");
const libRaw = read("src/library.ts");
const edRaw = read("src/editor/editor.ts");
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
  // Codex 指摘（低）: 型引数なしの `invoke("read_file_bytes"` も拾う
  for (const f of SRC) all.push(...sitesOf(strip(read(f)), f, /invoke(?:<[^>]*>)?\("read_file_bytes"/));
  const got = all.map((s) => `${s.file}:${s.fn}`).sort();
  // 薄いラッパー（`const CMD = "read_file_bytes"` 等）経由も見逃さない: コメントを除いた **文字列の出現数** が呼び出し数と一致
  let mentions = 0;
  for (const f of SRC) mentions += (strip(read(f)).match(/read_file_bytes/g) ?? []).length;
  check("1 read_file_bytes の語はコメント以外では invoke の呼び出しにしか現れない（ラッパー無し）", mentions === all.length, `語=${mentions} 呼び出し=${all.length}`);
  // 許可（5件）: .kwz/.ppm と PNG サイドカーと音声（数MB〜64MB・境界の下・残りは A-60）。
  // 画像は V170 で read_file_raw へ（読む前の門番 IMAGE_IMPORT_MAX_BYTES＝v170_smoke 検査1）
  const ALLOW = [
    "src/library.ts:loadThumb", // PNG サイドカー／note のサムネ（同じ関数の中に2つ。V169 前は project の予備道も含めて3つ）
    "src/library.ts:loadThumb",
    "src/library.ts:select", // note のプレビュー
    "src/main.ts:openEditorWithNote", // .kwz/.ppm を開く
    "src/main.ts:pickAudioFile", // 音声（mp3/wav/ogg・64MB/16MB の門番は読んだ後＝境界の下）
  ].sort();
  check("1 ★read_file_bytes の呼び出し元は許可5件と一致（.memoanima・画像を読む道に残っていない・増えていない）", JSON.stringify(got) === JSON.stringify(ALLOW), `いま ${got.length} 件: ${got.join(" | ")}`);
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
  const sel = lib.slice(lib.indexOf("async select(it: LibraryView)"), lib.indexOf("showLoadError(msg: string)"));
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
  const sle = lib.slice(lib.indexOf("showLoadError(msg: string)"), lib.indexOf("private renderMeta("));
  check("4 ★showLoadError は TOO_LARGE を人が読める文（lib.open.tooLarge.msg）に置き換える", /tooLargeBytes\(msg\)/.test(sle) && /t\("lib\.open\.tooLarge\.msg"/.test(sle));
  check("4 それ以外の失敗は従来の文言（lib.meta.loadError.label）のまま", /t\("lib\.meta\.loadError\.label", \{ err: msg \}\)/.test(sle));
  check("4 上限の数字は門番の定数から作る（別の数字を手で書かない）", /IMPORT_MAX_BYTES/.test(sle));
  check("4 約 X MB は切り上げ（Codex 指摘・中: 四捨五入だと 512MiB+1B が「約 512 MB・上限 512 MB」になる）", /Math\.ceil\(tooLarge \/ 1024 \/ 1024\)/.test(sle) && !/toFixed\(0\)/.test(sle));
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
  check("7 [V154b] open failed のログ行は従来どおり（size と理由だけ）", /\[V154b\] open failed size=\$\{item\.size\} \$\{String\(e\)\}/.test(mainRaw));
}

console.log(`v169 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
