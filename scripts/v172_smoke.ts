// V172（Mac の音: 音源読み込み前から待ち表示・スリープ後に無音になる対策・更新チェックの空振りを静かに）の回帰ゲート。
// 引数不要:
//   npx tsx scripts/v172_smoke.ts
//
// ★この回でいちばん怖いのは3つ:
//   ① **音声だけ JSON 配列（read_file_bytes）のまま残る／戻る**——Mac（JavaScriptCore）では数 MB でも「固まった」に見える
//      → 検査1 が readAudioFile は read_file_raw（maxBytes 付き）だけを呼ぶことを固定、1z が戻した写しは赤
//   ② **`state === "suspended"` の直書きが残る／戻る**——WebKit の `"interrupted"` を拾えず、以後ずっと無音
//      → 検査2 が src 全走査で 0 件を固定、2z が戻した写しは赤。検査10 は Node で偽の AudioContext を渡して挙動そのものを叩く
//   ③ **待ち表示が「読む前」に無い**——ダイアログを閉じてから読み終わるまで何も出ない（件 1 の正体）
//      → 検査4 が読む関数の中で busy が read_file_raw より前にあることを固定、4z が後ろへ動かした写しは赤
//
// 1. main.ts の readAudioFile に read_file_bytes が無く read_file_raw がある（v169 の許可一覧も 5→4）
// 2. src/**/*.ts（コメント除外）に `state === "suspended"` の直書きが 0
// 3. audio.ts の addEventListener("statechange" はちょうど 1 か所（sharedCtx の作成直後）
// 4. readAudioFile の中で runWithBusy が read_file_raw より前に現れる（両方の読み）
// 5. main.ts の update check に `None of the fallback platforms` の分岐があり、その中に logError が無い（外には残る）
// 6. i18n 7 言語に set.update.noPlatform.toast が揃っている（キー数が 7 ファイルで一致）
// 7. 1z 反証: read_file_raw を read_file_bytes に戻した写しは検査1 が赤
// 8. 2z 反証: editor.ts の試し再生を `=== "suspended"` に戻した写しは検査2 が赤
// 9. 4z 反証: busy を read の後ろへ動かした写しは検査4 が赤
// 10. ensureAudioRunning を Node で叩く（偽 AudioContext）: running は触らない／resume 成功は同じ ctx／
//     resume 失敗・closed・resume が返ってこない は作り直し／購読は ctx ごとに 1 回／ログ行の形（W-10）
// 11. 16MB の確認（ed.audio.largeWarn.msg）の文言と条件が不変
// 12. 配線: main.ts が setAudioLogSink を呼ぶ・PerfOp に audio.read / audio.load がある
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
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/[^\n"'`]*$/gm, "");
const mainRaw = read("src/main.ts");
const main = strip(mainRaw);
const audioRaw = read("src/editor/audio.ts");
const audio = strip(audioRaw);
// ★V213 (M-2a): editor.ts の描く処理はコア（src/editor/core/editorCore.ts）へ移った＝editor.ts とコアの字を並べて見る
const edRaw = readEditorSource(root);

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
const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
const keysOf = (src: string): string[] => [...src.matchAll(/^\s+"([a-zA-Z0-9.\-_]+)":/gm)].map((m) => m[1]);

// ================= 1. readAudioFile は read_file_raw だけ =================
const READ_FN = "readAudioFile";
const check1 = (src: string): { ok: boolean; why: string } => {
  const b = fnBody(src, READ_FN);
  if (b === "") return { ok: false, why: `${READ_FN} が見つからない` };
  if (/"read_file_bytes"/.test(b)) return { ok: false, why: "read_file_bytes が残っている" };
  const n = (b.match(/"read_file_raw"/g) ?? []).length;
  if (n < 1) return { ok: false, why: "read_file_raw が無い" };
  if (!/"read_file_raw",\s*\{\s*path:[^}]*maxBytes:/.test(b)) return { ok: false, why: "maxBytes（読む前の門番）が無い" };
  return { ok: true, why: "" };
};
{
  const r = check1(main);
  check("1 ★readAudioFile は read_file_raw（maxBytes 付き）だけを呼ぶ・read_file_bytes を呼ばない", r.ok, r.why);
  const b = fnBody(main, READ_FN);
  check("1 音声の上限は定数 AUDIO_IMPORT_MAX_BYTES（64MiB）で、読む前に渡す", /maxBytes: AUDIO_IMPORT_MAX_BYTES/.test(b) && /const AUDIO_IMPORT_MAX_BYTES = 64 \* 1024 \* 1024/.test(main));
  check("1 TOO_LARGE は従来と同じ ed.audio.tooLarge.toast（{mb}）で断る", /TOO_LARGE:\(\\d\+\)/.test(b) && /ed\.audio\.tooLarge\.toast/.test(b));
  // pickAudioFile はダイアログだけ（読まない）
  const pb = fnBody(main, "pickAudioFile");
  check("1 pickAudioFile はダイアログだけ（read_file_raw / read_file_bytes を呼ばない）", pb !== "" && !/read_file_(raw|bytes)/.test(pb) && /await open\(/.test(pb));
  // v169 の許可一覧から pickAudioFile が消えている（5→4）
  const v169 = read("scripts/v169_smoke.ts");
  const allowBlock = v169.match(/const ALLOW = \[([\s\S]*?)\];/)?.[1] ?? "";
  const allowN = (allowBlock.match(/^\s*"src\//gm) ?? []).length;
  check("1 v169_smoke の read_file_bytes 許可一覧は 4 件で pickAudioFile を含まない", allowN === 4 && !/pickAudioFile/.test(allowBlock), `${allowN} 件`);
}

// ================= 2. `state === "suspended"` の直書きが 0 =================
const SUSPENDED_RE = /state\s*={2,3}\s*"suspended"|"suspended"\s*={2,3}\s*[A-Za-z_.$]*state/;
const check2 = (files: { f: string; src: string }[]): string[] => {
  const bad: string[] = [];
  for (const { f, src } of files) if (SUSPENDED_RE.test(strip(src))) bad.push(f);
  return bad;
};
{
  const files = SRC.map((f) => ({ f, src: read(f) }));
  const bad = check2(files);
  check("2 ★src/**/*.ts に `state === \"suspended\"` の直書きが 0（復帰は ensureAudioRunning だけ）", bad.length === 0, bad.join(", "));
  // 走査が空振りしていない: audio.ts と editor.ts が対象に入っている
  check("2 走査に audio.ts と editor.ts が入っている", SRC.includes("src/editor/audio.ts") && SRC.includes("src/editor/editor.ts"));
  // 3 か所とも ensureAudioRunning を通っている
  const inAudio = (audio.match(/ensureAudioRunning\(/g) ?? []).length;
  const inEd = (strip(edRaw).match(/ensureAudioRunning\(/g) ?? []).length;
  check("2 ensureAudioRunning は audio.ts で定義＋2 か所（BGM start / SE）・editor.ts の試し再生で 1 か所", /export async function ensureAudioRunning\(/.test(audio) && inAudio >= 3 && inEd >= 1, `audio.ts ${inAudio} / editor.ts ${inEd}`);
}

// ================= 3. statechange の購読はちょうど 1 か所 =================
const check3 = (src: string): { ok: boolean; why: string } => {
  const n = (src.match(/addEventListener\(\s*"statechange"/g) ?? []).length;
  if (n !== 1) return { ok: false, why: `${n} か所` };
  const body = fnBody(src, "sharedCtx");
  if (!/new AudioContext\(\)/.test(body)) return { ok: false, why: "sharedCtx に new AudioContext が無い" };
  if (!/addEventListener\(\s*"statechange"/.test(body)) return { ok: false, why: "購読が sharedCtx の中に無い" };
  if (body.indexOf("new AudioContext()") > body.indexOf('"statechange"')) return { ok: false, why: "購読が作成より前" };
  return { ok: true, why: "" };
};
{
  const r = check3(audio);
  check("3 ★audio.ts の addEventListener(\"statechange\" はちょうど 1 か所（sharedCtx の作成直後）", r.ok, r.why);
  check("3 new AudioContext() は audio.ts に 1 か所（sharedCtx）だけ", (audio.match(/new AudioContext\(/g) ?? []).length === 1);
}

// ================= 4. 読む前に busy =================
const check4 = (src: string): { ok: boolean; why: string } => {
  const b = fnBody(src, READ_FN);
  if (b === "") return { ok: false, why: `${READ_FN} が見つからない` };
  const busyIdx = [...b.matchAll(/\b(?:runWithBusy|beginBusy)\(/g)].map((m) => m.index!);
  const rawIdx = [...b.matchAll(/"read_file_raw"/g)].map((m) => m.index!);
  if (!busyIdx.length) return { ok: false, why: "busy が無い" };
  if (!rawIdx.length) return { ok: false, why: "read_file_raw が無い" };
  for (const r of rawIdx) if (!busyIdx.some((bi) => bi < r)) return { ok: false, why: `read_file_raw@${r} の前に busy が無い` };
  return { ok: true, why: "" };
};
{
  const r = check4(main);
  check("4 ★readAudioFile の中で runWithBusy が read_file_raw より前に現れる（両方の読み）", r.ok, r.why);
  const b = fnBody(main, READ_FN);
  check("4 遅延は既定（runWithBusy に第4引数を渡していない＝450ms 維持）", !/runWithBusy\("audio\.read",[^;]*?\},\s*\d/.test(b));
  // 呼び出し元（editor.ts）は「ダイアログ → beginBusy → runWithBusy(audio.load) の中で read → decode」の 1 本
  const ed = strip(edRaw);
  const loads = [...ed.matchAll(/await self\.cb\.pickAudioFile\(\)/g)].length;
  const reads = [...ed.matchAll(/await self\.cb\.readAudioFile\(/g)].length;
  const outer = [...ed.matchAll(/runWithBusy\("audio\.load"/g)].length;
  check("4 editor.ts の呼び出し元 2 か所が pickAudioFile → readAudioFile に分かれ、読み＋デコードを runWithBusy(\"audio.load\") 1 本で覆う", loads === 2 && reads === 2 && outer === 2, `pick ${loads} / read ${reads} / audio.load ${outer}`);
  // 二重にならない: 呼び出し元 2 か所は showBusyAfterDelay を使わない（箱は runWithBusy の 1 枚）
  const bgm = ed.slice(ed.indexOf('#ap-load"'), ed.indexOf('#ap-del"'));
  const se = ed.slice(ed.indexOf("const addSe = async"), ed.indexOf("this.seSectionRefresh = renderSeSection"));
  check("4 ★二重にならない: BGM 読み込みと SE 追加は showBusyAfterDelay を呼ばない（表示は runWithBusy だけ・beginBusy は入口の閉鎖）", !/showBusyAfterDelay/.test(bgm) && !/showBusyAfterDelay/.test(se) && /beginBusy\("audio"\)/.test(bgm) && /beginBusy\("audio"\)/.test(se));
  // 16MB の確認は箱の外（withBusyHidden）
  check("4 16MB の確認ダイアログは箱を消して聞く（withBusyHidden）", /withBusyHidden\(/.test(b) && /export async function withBusyHidden/.test(strip(read("src/ui/busy.ts"))));
}

// ================= 5. 更新チェック: platform 無しは静かに =================
const check5 = (src: string): { ok: boolean; why: string } => {
  const b = fnBody(src, "runUpdateCheck");
  if (b === "") return { ok: false, why: "runUpdateCheck が見つからない" };
  const i = b.indexOf("None of the fallback platforms");
  if (i < 0) return { ok: false, why: "分岐が無い" };
  // 分岐の中身: その行の `{` から対応する `}` まで
  const open = b.indexOf("{", i);
  let depth = 0;
  let j = open;
  for (; j < b.length; j++) {
    if (b[j] === "{") depth++;
    else if (b[j] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const branch = b.slice(open, j + 1);
  // 独立レビューの指摘（中）: 語だけの分岐は Windows 向け feed の欠落まで飲み込む。無かった platform が darwin のときだけ
  const cond = b.slice(b.lastIndexOf("if (", i), open);
  if (!/darwin-/.test(cond)) return { ok: false, why: "分岐の条件に darwin- が無い（Windows の feed 欠落まで飲み込む）" };
  if (/logError\(/.test(branch)) return { ok: false, why: "分岐の中に logError がある" };
  if (!/\blog\(/.test(branch)) return { ok: false, why: "分岐の中に log（1 行）が無い" };
  if (!/set\.update\.noPlatform\.toast/.test(branch)) return { ok: false, why: "手動の文が無い" };
  if (!/mode === "manual"/.test(branch)) return { ok: false, why: "手動だけ知らせる形になっていない" };
  // 外（Windows の正当な失敗）は今まで通り logError ＋ failed.toast
  const outside = b.slice(0, open) + b.slice(j + 1);
  if (!/logError\("update"/.test(outside) || !/set\.update\.failed\.toast/.test(outside)) return { ok: false, why: "それ以外の失敗の logError / failed.toast が消えている" };
  return { ok: true, why: "" };
};
{
  const r = check5(main);
  check("5 ★runUpdateCheck: `None of the fallback platforms` の分岐に logError が無く、外の失敗は従来どおり", r.ok, r.why);
  check("5 log(kind, detail) は logError と同じ行の形（時刻＋[kind]）で append_log へ", /^function log\(kind: string, detail: string\)/m.test(main) && /function log\(kind: string, detail: string\) \{\n  const line = `\[\$\{new Date\(\)\.toISOString\(\)\}\] \[\$\{kind\}\] \$\{detail\}`;/.test(main));
}

// ================= 6. i18n 7 言語 =================
{
  const counts: number[] = [];
  let missing: string[] = [];
  for (const l of LANGS) {
    const src = read(`src/i18n/${l}.ts`);
    const ks = keysOf(src);
    counts.push(ks.length);
    if (!ks.includes("set.update.noPlatform.toast")) missing.push(l);
  }
  check("6 ★7 言語に set.update.noPlatform.toast がある", missing.length === 0, `無い: ${missing.join(", ")}`);
  check("6 キー数が 7 ファイルで一致（+1）", new Set(counts).size === 1, counts.join("/"));
  // V190（v1.9.0 の版上げ）で固定値を置き換えた。v1.9.0 で Mac を β から外し、Windows と同じ Release に並べるので、
  // 「（Mac テスト版）」を名乗る文をやめて、版にも β にも触れない文にした（作者決定 2026-09-20・当日パック v1.9.0 [1] の表）。
  // 見ているもの（Mac で手動の「更新を確認」を押したときに出る ja の文）は変えていない。
  // 旧: 「この版では自動更新に対応していません（Mac テスト版）」（v1.8.0〜・V172）
  const ja = read("src/i18n/ja.ts").match(/"set\.update\.noPlatform\.toast": "([^"]+)"/)?.[1] ?? "";
  check(
    "6 ja の文は「この環境ではアプリ内の自動更新に対応していません。新しい版は配布ページから入手してください」",
    ja === "この環境ではアプリ内の自動更新に対応していません。新しい版は配布ページから入手してください",
    ja
  );
}

// ================= 7. 1z 反証 =================
{
  const b = fnBody(main, READ_FN);
  const z = main.replace(b, b.replace(/"read_file_raw"/g, '"read_file_bytes"'));
  check("7 1z: read_file_bytes に戻した写しは検査1 が赤", !check1(z).ok);
}

// ================= 8. 2z 反証 =================
{
  // V209 (A-121・R-5): 試し再生は ▶ の前に ensureAudioRunning を待つ形になった（`void ensureAudioRunning(ctx);` → `await ensureAudioRunning(getAudioCtx());`）。
  //  その待ちを `=== "suspended"` の直書きに戻した写しで、検査2 が赤になることを見る（確かめる中身は同じ）
  const z = edRaw.replace(/await ensureAudioRunning\(getAudioCtx\(\)\);/, 'if (getAudioCtx().state === "suspended") void getAudioCtx().resume().catch(() => {});');
  check("8 2z: 試し再生を `=== \"suspended\"` に戻した写しは検査2 が赤", z !== edRaw && check2([{ f: "z", src: z }]).length === 1);
}

// ================= 9. 4z 反証 =================
{
  const b = fnBody(main, READ_FN);
  // busy の語を全部後ろへ: runWithBusy( → runWithBusyLater( にして、本体の末尾に runWithBusy( を置く
  const zb = b.replace(/runWithBusy\(/g, "runWithBusyLater(") + "\n  runWithBusy(";
  const z = main.replace(b, zb);
  check("9 4z: busy を read の後ろへ動かした写しは検査4 が赤", !check4(z).ok);
}

// ================= 10. ensureAudioRunning を Node で叩く（偽 AudioContext） =================
{
  type Listener = (e: unknown) => void;
  class FakeCtx {
    static made: FakeCtx[] = [];
    state = "suspended";
    listeners = new Map<string, Listener[]>();
    resumeCalls = 0;
    closeCalls = 0;
    resumeImpl: () => Promise<void> = () => {
      this.state = "running";
      return Promise.resolve();
    };
    constructor() {
      FakeCtx.made.push(this);
    }
    addEventListener(type: string, fn: Listener) {
      const arr = this.listeners.get(type) ?? [];
      arr.push(fn);
      this.listeners.set(type, arr);
    }
    resume() {
      this.resumeCalls++;
      return this.resumeImpl();
    }
    close() {
      this.closeCalls++;
      this.state = "closed";
      return Promise.resolve();
    }
    fire(type: string) {
      for (const f of this.listeners.get(type) ?? []) f({ target: this });
    }
  }
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
  const mod = (await import("../src/editor/audio")) as unknown as {
    ensureAudioRunning?: (ctx: unknown) => Promise<unknown>;
    getAudioCtx?: () => unknown;
    setAudioLogSink?: (fn: ((line: string) => void) | null) => void;
    _resetAudioForTest?: () => void;
    AUDIO_RESUME_TIMEOUT_MS?: number;
  };
  const has = typeof mod.ensureAudioRunning === "function" && typeof mod.setAudioLogSink === "function" && typeof mod._resetAudioForTest === "function";
  check("10 audio.ts が ensureAudioRunning / setAudioLogSink / _resetAudioForTest を export している", has);
  if (has) {
    const lines: string[] = [];
    mod.setAudioLogSink!((l) => lines.push(l));
    mod._resetAudioForTest!();
    FakeCtx.made = [];
    // (a) running は触らない
    const c1 = mod.getAudioCtx!() as FakeCtx;
    c1.state = "running";
    const r1 = await mod.ensureAudioRunning!(c1);
    check("10a running なら resume を呼ばず同じ ctx", r1 === c1 && c1.resumeCalls === 0);
    // (b) suspended → resume 成功 → 同じ ctx
    c1.state = "suspended";
    const r2 = await mod.ensureAudioRunning!(c1);
    check("10b suspended → resume 1 回 → 同じ ctx（running）", r2 === c1 && c1.resumeCalls === 1 && c1.state === "running");
    // (b') interrupted（WebKit 標準外）も同じ道で拾う
    c1.state = "interrupted";
    const r2b = await mod.ensureAudioRunning!(c1);
    check("10b' ★interrupted（WebKit）も resume する（=== \"suspended\" では拾えなかった状態）", r2b === c1 && c1.resumeCalls === 2 && c1.state === "running");
    // (c) resume 失敗 → 作り直し（sharedCtx が新しいものを返す・古いのは close）
    c1.state = "interrupted";
    c1.resumeImpl = () => Promise.reject(new Error("x"));
    lines.length = 0;
    const r3 = (await mod.ensureAudioRunning!(c1)) as FakeCtx;
    check("10c ★resume 失敗 → 新しい ctx を返し、getAudioCtx も同じ新しい ctx・古いのは close", r3 !== c1 && mod.getAudioCtx!() === r3 && c1.closeCalls === 1 && FakeCtx.made.length === 2);
    // 独立レビューの指摘（低）: 作り直しのログは**実体**を見る（前は固定文字列を足して見ていたので消えても通った）
    check("10c 作り直しは `[audio] ctx recreate reason=resume-failed` を 1 行残す", lines.length === 1 && lines[0] === "[audio] ctx recreate reason=resume-failed", lines.join(" | "));
    // (d) closed → 作り直し（resume は呼ばない）
    const c2 = r3;
    c2.state = "closed";
    const r4 = (await mod.ensureAudioRunning!(c2)) as FakeCtx;
    check("10d closed → resume せず作り直し", r4 !== c2 && c2.resumeCalls === 0 && mod.getAudioCtx!() === r4);
    // (e) 購読は ctx ごとに 1 回（作り直しても増えない）
    const subs = FakeCtx.made.map((c) => (c.listeners.get("statechange") ?? []).length);
    check("10e ★statechange の購読は ctx ごとにちょうど 1 回（作り直した ctx にも付く・増えない）", subs.length === 3 && subs.every((n) => n === 1), subs.join("/"));
    // (f) ログ行の形（W-10）: [audio] ctx state=<state> vis=<vis> gap=<秒>
    lines.length = 0;
    r4.state = "interrupted";
    r4.fire("statechange");
    const LINE_RE = /^\[audio\] ctx state=(running|suspended|interrupted|closed) vis=(visible|hidden|unknown) gap=\d+(\.\d)?$/;
    check("10f ★statechange で 1 行: `[audio] ctx state=interrupted vis=… gap=…`（作品名・パスになりうる文字なし）", lines.length === 1 && LINE_RE.test(lines[0]) && /state=interrupted/.test(lines[0]), lines.join(" | "));
    // (g) resume が返ってこない → タイムアウトで作り直し
    const before = FakeCtx.made.length;
    r4.state = "interrupted";
    r4.resumeImpl = () => new Promise(() => {});
    lines.length = 0;
    const t0 = Date.now();
    const r5 = (await mod.ensureAudioRunning!(r4)) as FakeCtx;
    const took = Date.now() - t0;
    const tmo = mod.AUDIO_RESUME_TIMEOUT_MS ?? 1500;
    check("10g ★resume が返ってこない（WebKit の interrupted で起きうる）→ タイムアウトで作り直し", r5 !== r4 && FakeCtx.made.length === before + 1 && took >= tmo - 50 && took < tmo + 1000, `${took}ms / timeout ${tmo}`);
    check("10g 作り直しは `[audio] ctx recreate reason=resume-timeout` を 1 行残す（決められた語だけ）", lines.length === 1 && lines[0] === "[audio] ctx recreate reason=resume-timeout", lines.join(" | "));
    // 古い ctx の購読からのログは出ない（作り直した後に古い ctx が statechange を出しても 1 行も書かない）
    lines.length = 0;
    c1.state = "closed";
    c1.fire("statechange");
    check("10h 捨てた ctx の statechange は書かない（同じ事象が 2 行にならない）", lines.length === 0, lines.join(" | "));
    mod._resetAudioForTest!();
    mod.setAudioLogSink!(null);
  }
}

// ================= 11. 16MB の確認は不変 =================
{
  const b = fnBody(main, READ_FN);
  check("11 ★16MB の確認は読んだ後に mb > 16 → confirmDialog(ed.audio.largeWarn.msg {mb}) のまま", /mb > 16\)/.test(b) && /confirmDialog\(t\("ed\.audio\.largeWarn\.msg", \{ mb: mb\.toFixed\(0\) \}\)\)/.test(b));
  const ja = read("src/i18n/ja.ts");
  check("11 ja の文言が不変", ja.includes('"ed.audio.largeWarn.msg": "音声が大きめです（{mb}MB）。プロジェクトファイルに埋め込まれるためファイルが肥大し、保存・読み込みが重くなる場合があります。続行しますか？"'));
  check("11 64MB のガードは門番（読む前）に吸収され、sizeGuard の mb > 64 も残る（抽出経路が使う）", /mb > 64\)/.test(b));
}

// ================= 12. 配線 =================
{
  check("12 main.ts が setAudioLogSink を append_log に配線している（W-10 の枠に相乗り）", /setAudioLogSink\(\(text\) =>[\s\S]{0,200}append_log/.test(main));
  const perf = read("src/perf.ts");
  check("12 PerfOp に audio.read と audio.load がある", /^\s*\|\s*"audio\.read"/m.test(perf) && /^\s*\|\s*"audio\.load"/m.test(perf));
  check("12 実行時 fetch なし（audio.ts / busy.ts）", !/\bfetch\(/.test(audio) && !/\bfetch\(/.test(strip(read("src/ui/busy.ts"))));
}

console.log(`\nv172 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
