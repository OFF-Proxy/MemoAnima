// V170（画像取り込みに門番を置く）の回帰ゲート。引数不要:
//   npx tsx scripts/v170_smoke.ts
//
// ★この回でいちばん怖いのは2つ:
//   ① **画像だけ JSON 配列（read_file_bytes）のまま残る／戻る**——128MiB 超でレンダラが致命停止する道（V169 と同じ形）
//      → 検査1 が「decodeImageFile は read_file_raw を maxBytes 付きで呼ぶ」を固定、1z が戻した写しは赤を実証
//   ② **断りの文が2か所に分かれて片方だけ古くなる**／**上限の数字を手で書く**（ed.audio.tooLarge.toast の轍）
//      → 検査3 が「文を作る所は1つ・両方の呼び出し元がそれを使う」、検査4 が「数字は定数から・切り上げ」、3z が反証
//
// 1. decodeImageFile は read_file_raw（maxBytes 付き）・read_file_bytes を呼ばない
// 2. IMAGE_IMPORT_MAX_BYTES の定義は src に1つ・64 * 1024 * 1024
// 3. 断りの文を作る所は1つ（imageImportErrorText）・両方の呼び出し元がそれを使う・img.decodeFail.toast の直書きが無い
// 4. 上限の数字は定数から（Math.ceil・toFixed(0) 無し）
// 5. i18n 7言語に img.tooLarge.toast（{mb} {max} {name}・{name} は最後）
// 6. tooLargeBytes を Node で叩く（他の失敗は従来の文言のまま通る根拠）
// 7. 1z 反証: read_file_bytes に戻した写しは検査1 が赤
// 8. 3z 反証: 片方だけ直書きした写しは検査3 が赤
// 9. 1枚が失敗しても続く形（for の中の try/catch・catch に return/break/throw が無い）
// 10. createImageBitmap 〜 getImageData の行が変わっていない（MAXSIDE 4096 の縮小）
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
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/[^\n"'`]*$/gm, "");
const mainRaw = read("src/main.ts");
const main = strip(mainRaw);

/** top-level 関数の本体（`function name(` / `async function name(` から、次の行頭 `}` まで） */
function fnBody(src: string, name: string): string {
  const re = new RegExp(`\\n(?:export )?(?:async )?function ${name}\\s*\\([^)]*\\)[^{]*\\{`);
  const m = re.exec(src);
  if (!m) return "";
  const start = m.index + m[0].length;
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}
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

// ================= 1. decodeImageFile は read_file_raw（maxBytes 付き） =================
const decodeOk = (src: string): boolean => {
  const b = fnBody(src, "decodeImageFile");
  return b !== "" && /"read_file_raw",\s*\{\s*path,\s*maxBytes: IMAGE_IMPORT_MAX_BYTES,?\s*\}/.test(b) && !/"read_file_bytes"/.test(b);
};
{
  const b = fnBody(main, "decodeImageFile");
  check("1 decodeImageFile が見つかる", b !== "");
  check("1 ★decodeImageFile は read_file_raw を maxBytes: IMAGE_IMPORT_MAX_BYTES 付きで呼ぶ", decodeOk(main));
  check("1 read_file_bytes（JSON 配列）を呼んでいない", b !== "" && !/"read_file_bytes"/.test(b));
  check("1 返りの正規化は readProjectRaw と同じ3分岐（Uint8Array / ArrayBuffer / number[]）", /raw instanceof Uint8Array[\s\S]{0,80}raw instanceof ArrayBuffer[\s\S]{0,80}new Uint8Array\(raw as number\[\]\)/.test(b));
}

// ================= 2. IMAGE_IMPORT_MAX_BYTES は1つ・64MiB =================
{
  let defs = 0;
  const where: string[] = [];
  for (const f of SRC) {
    const c = (strip(read(f)).match(/const IMAGE_IMPORT_MAX_BYTES = /g) ?? []).length;
    if (c) where.push(`${f}×${c}`);
    defs += c;
  }
  check("2 ★IMAGE_IMPORT_MAX_BYTES の定義は src に1つ", defs === 1, where.join(", "));
  check("2 値は 64 * 1024 * 1024（作者決定）", /const IMAGE_IMPORT_MAX_BYTES = 64 \* 1024 \* 1024;/.test(main));
  check("2 IMPORT_MAX_BYTES（512MiB・.memoanima）と EXTRACT_MAX_MB（動画）は別の定数のまま", /IMPORT_MAX_BYTES = 512 \* 1024 \* 1024/.test(strip(read("src/library.ts"))) && /const EXTRACT_MAX_MB = 512/.test(main));
}

// ================= 3. 断りの文を作る所は1つ =================
const usesShared = (src: string): { ok: boolean; direct: number; flow: boolean; flowEd: boolean } => {
  const direct = (src.match(/t\("img\.decodeFail\.toast"/g) ?? []).length;
  const helper = fnBody(src, "imageImportErrorText");
  const flow = /imageImportErrorText\(/.test(fnBody(src, "openImageImportFlow"));
  const flowEd = /imageImportErrorText\(/.test(fnBody(src, "openImageImportFlowForEditor"));
  // 直書きは helper の中の1つだけ（helper が従来の文を出す分岐を持つ）
  return { ok: helper !== "" && direct === 1 && /t\("img\.decodeFail\.toast"/.test(helper) && flow && flowEd, direct, flow, flowEd };
};
{
  const r = usesShared(main);
  check("3 ★断りの文を作る所は imageImportErrorText 1つ・両方の呼び出し元がそれを使う", r.ok, `direct=${r.direct} flow=${r.flow} flowEd=${r.flowEd}`);
  const helper = fnBody(main, "imageImportErrorText");
  check("3 helper は tooLargeBytes(errText(e)) が number なら img.tooLarge.toast、null なら従来の img.decodeFail.toast", /tooLargeBytes\(errText\(e\)\)/.test(helper) && /t\("img\.tooLarge\.toast"/.test(helper) && /t\("img\.decodeFail\.toast", \{ name, err: errText\(e\) \}\)/.test(helper));
}

// ================= 4. 上限の数字は定数から・切り上げ =================
{
  const helper = fnBody(main, "imageImportErrorText");
  check("4 ★上限の数字は IMAGE_IMPORT_MAX_BYTES から作る（別の数字を手で書かない）", /IMAGE_IMPORT_MAX_BYTES \/ 1024 \/ 1024/.test(helper));
  check("4 約 X MB は切り上げ（Math.ceil・toFixed(0) 無し）", /Math\.ceil\(/.test(helper) && !/toFixed\(0\)/.test(helper));
}

// ================= 5. i18n 7言語 =================
{
  const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
  for (const l of LANGS) {
    const d = read(`src/i18n/${l}.ts`);
    const m = /"img\.tooLarge\.toast":\s*"([^"]*)"/.exec(d);
    const s = m?.[1] ?? "";
    check(`5 i18n ${l}: img.tooLarge.toast があり {mb} {max} {name} を差し込む・{name} は最後`, !!m && s.includes("{mb}") && s.includes("{max}") && s.includes("{name}") && s.lastIndexOf("{name}") > s.lastIndexOf("{max}") && s.lastIndexOf("{name}") > s.lastIndexOf("{mb}"), s.slice(0, 50) || "無い");
    check(`5 i18n ${l}: 上限の数字（64）を文に直書きしていない`, !!m && !/64/.test(s));
    const f = /"img\.decodeFail\.toast":\s*"([^"]*)"/.exec(d)?.[1] ?? "";
    check(`5 i18n ${l}: img.decodeFail.toast は従来どおり（{name} と {err}）`, f.includes("{name}") && f.includes("{err}"));
  }
}

// ================= 6. tooLargeBytes（他の失敗は従来の文言のまま通る根拠） =================
{
  const { tooLargeBytes } = await import("../src/ui/errText");
  check("6 'TOO_LARGE:70000000' → 70000000", tooLargeBytes("TOO_LARGE:70000000") === 70000000);
  check("6 '読み込み失敗: …' → null（壊れた画像・無いファイルは従来の文言）", tooLargeBytes("読み込み失敗: The system cannot find the file") === null);
  check("6 createImageBitmap の失敗（'The source image could not be decoded.'）→ null", tooLargeBytes("The source image could not be decoded.") === null);
}

// ================= 7. 1z 反証 =================
{
  const reverted = main.replace(
    /const raw = await invoke<ArrayBuffer \| Uint8Array \| number\[\]>\("read_file_raw", \{\s*path,\s*maxBytes: IMAGE_IMPORT_MAX_BYTES,?\s*\}\);/,
    'const raw = await invoke<number[]>("read_file_bytes", { path });'
  );
  check("7 ★1z 反証: decodeImageFile を read_file_bytes に戻した写しは検査1 が赤", decodeOk(main) && reverted !== main && !decodeOk(reverted));
}

// ================= 8. 3z 反証 =================
{
  // openImageImportFlowForEditor の中の helper 呼び出しを直書きに戻す
  const body = fnBody(main, "openImageImportFlowForEditor");
  // 引数に `base(files[i])` の括弧が1段あるので、括弧を1段だけ許す形で拾う
  const mutated = body.replace(/toast\(imageImportErrorText\((?:[^()]|\([^()]*\))*\)\);/, 'toast(t("img.decodeFail.toast", { name: base(files[i]), err: errText(e) }));');
  const forged = main.replace(body, mutated);
  check("8 ★3z 反証: 片方の呼び出し元だけ img.decodeFail.toast を直に書いた写しは検査3 が赤", usesShared(main).ok && forged !== main && !usesShared(forged).ok);
}

// ================= 9. 1枚が失敗しても続く =================
{
  for (const fn of ["openImageImportFlow", "openImageImportFlowForEditor"]) {
    const b = fnBody(main, fn);
    const loop = /for \((?:const f of files|let i = 0; i < files\.length; i\+\+)\) \{[\s\S]*?try \{[\s\S]*?decodeImageFile\([\s\S]*?\} catch \(e\) \{([\s\S]*?)\n\s*\}/.exec(b);
    check(`9 ${fn}: for の中の try/catch が残っている`, !!loop);
    check(`9 ${fn}: catch の中に return / break / throw が無い（1枚で全部を巻き戻さない）`, !!loop && !/\b(return|break|throw)\b/.test(loop[1]));
  }
  check("9 連番の進捗モーダルは finally で片づける（途中で消えない・最後に消える）", /finally \{\s*prog\?\.back\.remove\(\);/.test(fnBody(main, "openImageImportFlowForEditor")));
}

// ================= 10. createImageBitmap 〜 getImageData は不変 =================
{
  const b = fnBody(main, "decodeImageFile");
  const tail = [
    "const bmp = await createImageBitmap(blob);",
    "const MAXSIDE = 4096;",
    "const scale = Math.min(1, MAXSIDE / Math.max(bmp.width, bmp.height));",
    "const w = Math.max(1, Math.round(bmp.width * scale));",
    "const h = Math.max(1, Math.round(bmp.height * scale));",
    'const cv = document.createElement("canvas");',
    "cv.width = w;",
    "cv.height = h;",
    'const ctx = cv.getContext("2d")!;',
    "ctx.drawImage(bmp, 0, 0, w, h);",
    "bmp.close();",
    "const data = ctx.getImageData(0, 0, w, h).data;",
    "return { w, h, data };",
  ];
  const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
  const idx = lines.indexOf(tail[0]);
  check("10 ★createImageBitmap から return までの 13 行が1行も変わっていない（MAXSIDE 4096 の縮小を消していない）", idx >= 0 && tail.every((l, k) => lines[idx + k] === l), idx < 0 ? "createImageBitmap の行が無い" : lines.slice(idx, idx + tail.length).find((l, k) => l !== tail[k]) ?? "");
  check("10 new Blob([bytes]) の直前までが読みの変更・それ以降は同じ", /const blob = new Blob\(\[bytes\]\);/.test(b));
}

console.log(`v170 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
