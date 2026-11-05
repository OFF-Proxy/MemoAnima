// V173b（**開けなかった理由**もログに残す ＋ 英語の生メッセージを画面から消す）の回帰ゲート。引数不要:
//   npx tsx scripts/v173b_smoke.ts
//
// ★この回でいちばん怖いのは3つ:
//   ① **開けなかった理由が、また黙って消える**——V173 で塞いだのは「取り込み」だけで、
//      実機で実際に起きていた「**開こうとして失敗**」は帯に出るだけ・ログに 1 行も残らなかった
//      （作者の Mac のログにも実際に 1 行も無かった）。→ [S-16] が `showLoadError` の中の `logError` を固定・反証 1z
//   ② **ログに作品名・パスが漏れる**——ここは作品を開く経路なので、理由に作品のフルパスが混ざり得る
//      → [S-17] が `importLogSafe` を **`known` 付き**で通すことを固定・反証 2z。[S-21] が Node で実際の漏れ方を叩く
//   ③ **画面の英語を消したつもりが、翻訳済みの文まで巻き込む**——en/es/pt の辞書には
//      "could not" / "invalid" を含む**正しい訳文**がある。英単語で判定すると、それらが
//      「読めませんでした」に化ける。→ [S-20] が **7 言語の全辞書の値**を実際に通して 1 件も誤爆しないことを固定
//
// [S-16] showLoadError の中に logError がある（無ければ赤＝逆戻り検知）
// [S-17] showLoadError が importLogSafe を known 付きで呼んでいる
// [S-18] 反証: 1z logError を外した写しは [S-16] が赤／2z known を外した写しは [S-17] が赤
// [S-19] i18n 7 言語のキー数一致・新キー lib.open.unreadable.msg がそろっている
// [S-20] Node: isUnreadableSource が flipnote.js の印だけを拾う（★7 言語の全辞書の値で誤爆 0）
// [S-21] Node: 開く経路のログの伏せ字（.memoanima は名前ごと／.kwz はファイル名が残る／★原文の英語は残る）
// [S-22] 画面の分岐: tooLarge は従来のキーのまま・unreadable は新キー・それ以外は従来どおり
// [S-23] 呼び出し元 3 か所すべてが known（パス）を渡している
// [S-24] 古い読み込みの失敗（stale）でも**ログには残る**（画面には出さない＝V159 の意図はそのまま）
// [S-25] V173 で入れたものを触っていない（取り込みの 4 か所・.gz の関数・scan_library の判定）
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
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/[^\n"'`]*$/gm, "");
const stripRs = (s: string) => s.replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/[^\n"]*$/gm, "");

const mainRaw = read("src/main.ts");
const main = strip(mainRaw);
const libRaw = read("src/library.ts");
const libTs = strip(libRaw);
const pclib = stripRs(read("src-tauri/src/pclib.rs"));

const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
const keysOf = (src: string): string[] => [...src.matchAll(/^\s+"([a-zA-Z0-9.\-_]+)":/gm)].map((m) => m[1]);
/** 辞書の**値**（訳文そのもの）を全部集める */
const valuesOf = (src: string): string[] =>
  [...src.matchAll(/^\s+"[a-zA-Z0-9.\-_]+": "((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1]);

/** クラスのメソッド／top-level 関数の本体（同じ字下げの行頭 `}` まで）。
 *
 *  ⚠ 字下げは **`[ \t]*`（横の空白だけ）**で取ること。`\s*` にすると**改行まで飲む**ので、
 *   定義の前に空行がある top-level 関数で `indent` が `"\n\n"` になり、終わりの目印
 *   `"\n" + indent + "}"` が見つからず、**本体がファイル末尾まで広がる**（＝検査が黙る）。
 *   実際に踏んだ: `openEditorWithNote` の本体が 102,627 文字になっていた。 */
function fnBody(src: string, name: string): string {
  const re = new RegExp(
    `\\n([ \\t]*)(?:export )?(?:private |public )?(?:async )?(?:function )?${name}\\s*\\([^)]*\\)[^{]*\\{`
  );
  const m = re.exec(src);
  if (!m) return "";
  const indent = m[1];
  const start = m.index + m[0].length;
  const end = src.indexOf(`\n${indent}}`, start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}
function rsFn(src: string, name: string): string {
  const re = new RegExp(`\\n(?:pub )?fn ${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return "";
  const start = m.index + m[0].length;
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

// ================= [S-16] showLoadError の中に logError がある =================
const checkS16 = (src: string): { ok: boolean; why: string } => {
  const b = fnBody(src, "showLoadError");
  if (b === "") return { ok: false, why: "showLoadError が見つからない" };
  if (!/logError\??\.?\(/.test(b)) return { ok: false, why: "★logError が無い（理由がログに残らない）" };
  // ⚠ 独立レビューの指摘（中）: 本体には `lib.open.tooLarge.msg` などがあるので、`"open"` を**どこかに**探すだけだと
  //  種別を `"import"` に壊しても緑のままだった。**呼び出しの第1引数**を直接見る
  if (!/logError\??\.?\(\s*["']open["']/.test(b)) return { ok: false, why: 'ログの種別が "open" でない（第1引数）' };
  return { ok: true, why: "" };
};
{
  const r = checkS16(libTs);
  check("[S-16] ★showLoadError が呼ばれたら理由を 1 行ログへ（logError(\"open\"）", r.ok, r.why);
  const b = fnBody(libTs, "showLoadError");
  // 画面に出す前に書く（早期 return で書き損じない）
  const iLog = b.search(/logError/);
  const iRender = b.search(/renderMeta/);
  check("[S-16] ログは画面より先（早期 return があっても必ず 1 行残る）", iLog >= 0 && iRender > iLog, `log@${iLog} render@${iRender}`);
}

// ================= [S-17] importLogSafe を known 付きで =================
const checkS17 = (src: string): { ok: boolean; why: string } => {
  const b = fnBody(src, "showLoadError");
  if (b === "") return { ok: false, why: "showLoadError が見つからない" };
  const m = /importLogSafe\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(b);
  if (!m) return { ok: false, why: "★importLogSafe を known 付きで呼んでいない" };
  return { ok: true, why: "" };
};
{
  const r = checkS17(libTs);
  check("[S-17] ★showLoadError が importLogSafe を known 付きで呼ぶ（W-10: 作品名とパスを伏せる）", r.ok, r.why);
  check("[S-17] library.ts が importLogSafe を import している", /import \{[^}]*importLogSafe[^}]*\} from "\.\/gzname"/.test(libTs));
  check("[S-17] showLoadError は known を引数で受け取る（呼び出し元から渡せる形）", /showLoadError\(\s*msg: string,\s*known: string\[\]/.test(libTs));
}

// ================= [S-18] 反証 =================
{
  const b = fnBody(libTs, "showLoadError");
  // 1z: ログを外した写し
  const z1 = libTs.replace(b, b.replace(/this\.cb\??\.?logError\??\.?\([^;]*\);/, ""));
  check("[S-18] 1z: logError を外した写しは [S-16] が赤", b !== "" && z1 !== libTs && !checkS16(z1).ok);
  // 2z: known を外した写し（伏せ字が効かなくなる）
  const z2 = libTs.replace(b, b.replace(/importLogSafe\(([A-Za-z_$][\w$]*),\s*[A-Za-z_$][\w$]*\)/, "importLogSafe($1)"));
  check("[S-18] 2z: importLogSafe から known を外した写しは [S-17] が赤", b !== "" && z2 !== libTs && !checkS17(z2).ok);
  // 3z（独立レビューの指摘・中）: 種別だけ "import" に変えた写しも赤になること（呼び出しは複数行）
  const z3 = libTs.replace(b, b.replace(/(logError\?\.\(\s*)"open"/, '$1"import"'));
  check("[S-18] 3z: ログの種別を \"import\" に変えた写しは [S-16] が赤", b !== "" && z3 !== libTs && !checkS16(z3).ok);
}

// ================= [S-19] i18n =================
{
  const NEW_KEYS = ["lib.open.unreadable.msg"];
  const counts: number[] = [];
  const missing: string[] = [];
  for (const l of LANGS) {
    const ks = keysOf(read(`src/i18n/${l}.ts`));
    counts.push(ks.length);
    for (const k of NEW_KEYS) if (!ks.includes(k)) missing.push(`${l}:${k}`);
  }
  check("[S-19] ★新キー lib.open.unreadable.msg が 7 言語にそろっている", missing.length === 0, `無い: ${missing.join(", ")}`);
  check("[S-19] 7 ファイルのキー数が一致", new Set(counts).size === 1, counts.join("/"));
  const ja = read("src/i18n/ja.ts").match(/"lib\.open\.unreadable\.msg": "([^"]+)"/)?.[1] ?? "";
  check("[S-19] ja の文が「読めなかった・壊れているか対応していない形式」を伝える・{err} を含まない", ja.includes("読め") && !ja.includes("{err}"), ja);
  // ★多視点レビュー指摘: ja だけ「**この形式の**ファイルとして」で、何の形式か画面のどこにも出ていなかった
  //（他 6 言語は「アニメーションとして」）。**辞書の正は ja** なので、ja を他に合わせる
  check("[S-19] ★ja が他の 6 言語と同じ意味（「アニメーションとして読めなかった」）", ja.includes("アニメーション"), ja);
  const OTHERS: [string, string][] = [
    ["en", "animation"], ["es", "animación"], ["pt-BR", "animação"],
    ["ko", "애니메이션"], ["zh-Hans", "动画"], ["zh-Hant", "動畫"],
  ];
  const off = OTHERS.filter(([l, w]) => !(read(`src/i18n/${l}.ts`).match(/"lib\.open\.unreadable\.msg": "([^"]+)"/)?.[1] ?? "").includes(w));
  check("[S-19] 6 言語とも「アニメーション」に当たる語で言っている", off.length === 0, off.map(([l]) => l).join(", "));
  // 「次に何をすればいいか」が入っている（独立レビューの指摘・低）
  const noAction = LANGS.filter((l) => {
    const v = read(`src/i18n/${l}.ts`).match(/"lib\.open\.unreadable\.msg": "([^"]+)"/)?.[1] ?? "";
    return !/(お試し|another file|otro archivo|outro arquivo|다른 파일|其他文件|其他檔案)/.test(v);
  });
  check("[S-19] 7 言語とも「次にどうするか」を書いている", noAction.length === 0, noAction.join(", "));
}

// ================= [S-20] Node: isUnreadableSource（★誤爆 0 を全辞書で） =================
type ErrMod = {
  isUnreadableSource: (s: string) => boolean;
  tooLargeBytes: (s: string) => number | null;
};
const errMod: ErrMod | null = await import("../src/ui/errText")
  .then((m) => m as unknown as ErrMod)
  .catch(() => null);
if (!errMod || typeof errMod.isUnreadableSource !== "function") {
  check("[S-20] src/ui/errText.ts が isUnreadableSource を export している", false, "見つからない");
} else {
  const { isUnreadableSource } = errMod;
  // flipnote.js の失敗は**必ず** `flipnote.js error: ` を通る（`err()` が付ける）。
  // Player 経由はさらに `Error loading Flipnote: ` で包まれる
  check("[S-20] 実機で出た文を拾う", isUnreadableSource("Error loading Flipnote: flipnote.js error: Could not identify source as a valid Flipnote file"));
  check("[S-20] 生の flipnote.js error も拾う", isUnreadableSource("flipnote.js error: Could not identify source as a valid Flipnote file"));
  check("[S-20] 壊れた kwz の別の失敗（範囲外）も拾う", isUnreadableSource("flipnote.js error: value 300 should be between 0 and 255"));
  check("[S-20] 前後に何か付いていても拾う", isUnreadableSource("読み込みエラー: flipnote.js error: x"));
  // ★誤爆 0: **7 言語の辞書の値を全部通す**。en/es/pt には "could not" / "invalid" を含む
  //  正しい訳文があるので、英単語で判定していると必ずここで落ちる
  const wrong: string[] = [];
  let scanned = 0;
  for (const l of LANGS)
    for (const v of valuesOf(read(`src/i18n/${l}.ts`))) {
      scanned++;
      if (isUnreadableSource(v)) wrong.push(`${l}: ${v.slice(0, 60)}`);
    }
  check("[S-20] ★7 言語の訳文を全部通しても 1 件も誤爆しない", wrong.length === 0, `${wrong.length} 件: ${wrong.slice(0, 3).join(" / ")}`);
  check("[S-20] 走査が空振りしていない（訳文を実際に通した）", scanned > 5000, `${scanned} 件`);
  // 自前の失敗（serialize / Rust の門番）は従来どおりそのまま出す
  check("[S-20] 自前の日本語の失敗は拾わない", !isUnreadableSource("このファイルは新しいバージョン（v6）で作られています。アプリを更新してください。"));
  check("[S-20] 門番の TOO_LARGE は拾わない（あちらの分岐のまま）", !isUnreadableSource("TOO_LARGE:600000000") && errMod.tooLargeBytes("TOO_LARGE:600000000") === 600000000);
}

// ================= [S-21] Node: 開く経路の伏せ字（R-12 / R-13 の根拠） =================
type GzMod = {
  importLogSafe: (s: string, known?: string[]) => string;
  logSafeFileLabel: (p: string) => string;
};
const gz: GzMod | null = await import("../src/gzname")
  .then((m) => m as unknown as GzMod)
  .catch(() => null);
if (!gz) {
  check("[S-21] src/gzname.ts の importLogSafe を使える", false, "見つからない");
} else {
  const { importLogSafe } = gz;
  // R-12: `.memoanima` は名前＝作品名なので、フルパスも名前も残さない
  const projPath = "C:\\Users\\me\\Documents\\MemoAnimaライブラリ\\album\\わたしの 作品.memoanima";
  const s1 = importLogSafe(`読み込み失敗: ${projPath} が壊れています`, [projPath]);
  check("[S-21] ★.memoanima は作品名もパスも残らない（空白入りの名前でも）",
    !s1.includes("わたしの") && !s1.includes("作品") && !s1.includes("me") && s1.includes("<file>"), s1);
  // R-11: `.kwz` はファイル名が残る（3DS のハッシュ名＝作品名ではない・どれが失敗したかの手掛かり）
  const kwzPath = "C:\\Users\\me\\Documents\\MemoAnimaライブラリ\\album\\abcd1234efgh1234ijkl1234mnop.kwz";
  const s2 = importLogSafe(`Error loading Flipnote: flipnote.js error: Could not identify source as a valid Flipnote file`, [kwzPath]);
  check("[S-21] ★ログには原文（英語）が残る（画面と用途が違う）", s2.includes("Could not identify source as a valid Flipnote file") && s2.includes("flipnote.js error"), s2);
  const s3 = importLogSafe(`読み込み失敗: ${kwzPath}`, [kwzPath]);
  check("[S-21] .kwz はファイル名が残り、フォルダは消える", s3.includes("abcd1234efgh1234ijkl1234mnop.kwz") && !s3.includes("Users") && !s3.includes("me"), s3);

  // ===== 独立レビューの指摘（優先度 高）の漏れ方を実際に叩く =====
  // ★known とエラー文で**区切り文字の書き方がズレる**（Rust 側が正規化する等）と、
  //  完全一致では素通りし、保険は空白で止まるので**利用者名とフォルダ名の断片が残っていた**
  const win = "D:\\Users\\John Doe\\My Album\\Secret Work.memoanima";
  const posix = "D:/Users/John Doe/My Album/Secret Work.memoanima";
  const leak = (s: string) => /John|Doe|My Album|Secret|Work/.test(s);
  check("[S-21] ★区切りが逆でも漏れない（known=\\ ／ 理由=/）", !leak(importLogSafe(`読み込み失敗: ${posix}`, [win])), importLogSafe(`読み込み失敗: ${posix}`, [win]));
  check("[S-21] ★区切りが逆でも漏れない（known=/ ／ 理由=\\）", !leak(importLogSafe(`読み込み失敗: ${win}`, [posix])), importLogSafe(`読み込み失敗: ${win}`, [posix]));
  check("[S-21] ★known を渡し忘れても漏れない（空白入りのフルパス）", !leak(importLogSafe(`読み込み失敗: ${posix}`)) && !leak(importLogSafe(`読み込み失敗: ${win}`)), importLogSafe(`読み込み失敗: ${posix}`));
  check("[S-21] ★大文字の拡張子でも漏れない", !leak(importLogSafe("読み込み失敗: D:/Users/John Doe/My Album/Secret Work.MEMOANIMA")));
  check("[S-21] ★UNC でも漏れない", !leak(importLogSafe("読み込み失敗: \\\\nas\\share\\John Doe\\Secret Work.animemo")));
  check("[S-21] ★相対パスでも漏れない", !leak(importLogSafe("読み込み失敗: ./John Doe/Secret Work.memoanima.gz")));
  check("[S-21] ★大小が違う known でも漏れない", !leak(importLogSafe(`読み込み失敗: ${win}`, [win.toLowerCase()])));
  // ★後読み（`(?<=…)`）を使っていない: この伏せ字は Mac（JavaScriptCore）でも走る。
  //  Safari 16.4 より前は後読みが**構文エラー**になり、モジュールごと読めなくなる
  //  ⚠ コメントを落としてから見る——**説明文の中に書いた `(?<=…)` に自分で当たる**（V165 の轍）
  const gzSrc = strip(read("src/gzname.ts"));
  check("[S-21] 反証: コメントを落とすと中身が変わる（この前処理が効いている）", gzSrc.length < read("src/gzname.ts").length);
  check("[S-21] ★伏せ字に後読み正規表現を使っていない（Mac の WebView で走る）", !/\(\?<[=!]/.test(gzSrc));
  // 巻き込みすぎない: 日本語の説明文や `mp3/wav` は残る
  check("[S-21] 説明文を巻き込まない", importLogSafe("この作品は約 600 MB で、開ける上限を超えています").includes("開ける上限"));
  check("[S-21] `mp3/wav/ogg` は潰さない", importLogSafe("対応していない形式です: mp3/wav/ogg のみ").includes("mp3/wav/ogg"));

  // ===== 独立レビューの指摘（優先度 低）: どれが失敗したかが分かる =====
  const { logSafeFileLabel } = gz;
  // ★V216b (A-133): 名前を残すのは 3DS が付ける名前の形のときだけ（材料を 3DS の形の名前にした。改名した形は v216b_smoke [N] が見る）
  check("[S-21] logSafeFileLabel: .kwz / .ppm はファイル名を返す", logSafeFileLabel(kwzPath) === "abcd1234efgh1234ijkl1234mnop.kwz" && logSafeFileLabel("/x/y/F12345_0123456789ABC_001.PPM") === "F12345_0123456789ABC_001.PPM");
  check("[S-21] ★logSafeFileLabel: 作品ファイルには何も付けない（名前＝作品名）", logSafeFileLabel(projPath) === "" && logSafeFileLabel("a/b.memoanima.gz") === "");
  const sle = fnBody(libTs, "showLoadError");
  check("[S-21] showLoadError が .kwz のときだけ名前を頭に付ける", /logSafeFileLabel/.test(sle) && /label \? `\$\{label\}:` : ""/.test(sle));
}

// ================= [S-22] 画面の分岐 =================
{
  const b = fnBody(libTs, "showLoadError");
  check("[S-22] tooLarge の分岐は従来のまま（lib.open.tooLarge.msg・切り上げ）", /tooLargeBytes\(msg\)/.test(b) && /lib\.open\.tooLarge\.msg/.test(b) && /Math\.ceil/.test(b));
  check("[S-22] ★読めない形式は新キー（lib.open.unreadable.msg）", /isUnreadableSource\(msg\)/.test(b) && /lib\.open\.unreadable\.msg/.test(b));
  check("[S-22] それ以外は従来どおり理由つき（lib.meta.loadError.label）", /lib\.meta\.loadError\.label/.test(b));
  // ★画面には生の理由を出さない道が要る: unreadable の分岐で {err} を渡していない
  const m = /lib\.open\.unreadable\.msg"\s*\)/.exec(b);
  check("[S-22] ★unreadable の文に理由（英語）を差し込んでいない", !!m, "t(\"lib.open.unreadable.msg\") が素で呼ばれていない");
}

// ================= [S-23] 呼び出し元 3 か所が known を渡す =================
{
  // ⚠ `[^)]*` では `errText(e)` の入れ子で切れる。**文末の `);` まで**貪欲に取る（呼び出しは 1 行）
  const sites = [
    ...[...libTs.matchAll(/showLoadError\((.+)\);/g)].map((m) => ({ f: "src/library.ts", a: m[1] })),
    ...[...main.matchAll(/showLoadError\((.+)\);/g)].map((m) => ({ f: "src/main.ts", a: m[1] })),
  ].filter((s) => !/msg: string/.test(s.a)); // 定義そのものは除く
  check("[S-23] 呼び出しは 3 か所（library.ts の選択・main.ts の 2 経路）", sites.length === 3, `${sites.length} 件: ${sites.map((s) => s.f).join(", ")}`);
  const bad = sites.filter((s) => !/,/.test(s.a) || !/\bpath\b/.test(s.a));
  check("[S-23] ★3 か所すべてがパス（known）を渡している", bad.length === 0, bad.map((b) => `${b.f}: ${b.a}`).join(" | "));
}

// ================= [S-23b] 開く経路のログは 1 行だけ・伏せ字の外を通らない =================
// ★多視点レビュー指摘（低）: `openEditorWithProject` の catch に V154b の `append_log` 直呼びが残っていて、
//  同じ失敗で **2 行**出るうえ、その 1 行だけ `String(e)` を素で書く＝**伏せ字の外**にあった
{
  const openFns = ["openEditorWithNote", "openEditorWithProject"];
  const bad = openFns.filter((f) => /append_log/.test(fnBody(main, f)));
  check("[S-23b] ★開く 2 経路に append_log の直呼びが残っていない（伏せ字の外を通らない・2 行にならない）", bad.length === 0, bad.join(", "));
  check("[S-23b] V154b の `open failed` の行が消えている", !/\[V154b\] open failed/.test(main));
  // 失われた手掛かり（size）は showLoadError の logNote へ畳んである
  check("[S-23b] size= は showLoadError の logNote に畳んだ（情報を捨てていない）", /showLoadError\(errText\(e\), \[item\.path\], false, `size=\$\{item\.size\}`\)/.test(main));
  const b = fnBody(libTs, "showLoadError");
  check("[S-23b] logNote はログにだけ入る（画面の文には混ざらない）", /logNote/.test(b) && b.indexOf("logNote") < b.indexOf("if (logOnly)") && !/renderMeta\(\[[^\]]*logNote/.test(b));
}

// ================= [S-24] stale でもログは残る =================
{
  const b = fnBody(libTs, "showLoadError");
  check("[S-24] showLoadError は「ログだけ」で抜ける道を持つ（logOnly）", /logOnly/.test(b));
  const sel = fnBody(libTs, "select");
  check("[S-24] ★古い読み込みの失敗も showLoadError を通る（画面には出さない・ログには残る）",
    /showLoadError\(.+stale\(\)\);/.test(sel), "select の catch が stale() を渡していない");
  check("[S-24] 画面に出す処理は logOnly の後ろ", b.indexOf("logOnly") < b.indexOf("renderMeta"));
}

// ================= [S-25] V173 で入れたものを触っていない =================
{
  // 取り込みの 4 か所（V173 の [S-3] と同じ一覧）
  const SITES: { file: string; fn: string; src: string }[] = [
    { file: "src/library.ts", fn: "importFolder", src: libTs },
    { file: "src/library.ts", fn: "openSingleFile", src: libTs },
    { file: "src/main.ts", fn: "importDroppedProjects", src: main },
    { file: "src/main.ts", fn: "handleDroppedPaths", src: main },
  ];
  const missing = SITES.filter((s) => !/logError(?:\?\.)?\("import"/.test(fnBody(s.src, s.fn)));
  check("[S-25] V173 の取り込み 4 か所の logError(\"import\" が残っている", missing.length === 0, missing.map((m) => `${m.file}:${m.fn}`).join(", "));
  // .gz まわり（V173）
  for (const f of ["for_each_renamed", "fix_renamed_projects", "probe_project_file", "gz_renamed_target", "is_gzip_magic", "path_taken"])
    check(`[S-25] .gz の関数 ${f} が残っている`, rsFn(pclib, f) !== "");
  const fix = rsFn(pclib, "fix_renamed_projects");
  check("[S-25] 上書きしない作り（hard_link・fs::rename を使わない）が残っている", /fs::hard_link/.test(fix) && !/fs::rename/.test(fix));
  // scan_library の判定
  const scan = rsFn(pclib, "scan_library");
  check("[S-25] scan_library は従来どおり拡張子で判定（中身を覗きにいかない）", /is_project_ext/.test(scan) && !/probe_project_file|is_gzip_magic/.test(scan));
  // 触らないファイル
  for (const f of ["src/editor/serialize.ts", "src/editor/pv6.ts", "src/editor/raster.ts"])
    check(`[S-25] ${f} に開く経路のログを持ち込んでいない`, !/logError/.test(strip(read(f))));
}

console.log(`\nv173b smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
