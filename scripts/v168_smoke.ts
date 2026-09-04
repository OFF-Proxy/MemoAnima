// V168（「作品まるごとを1回で扱う道」に見積りを）の回帰ゲート。引数不要:
//   npx tsx scripts/v168_smoke.ts
//
// ★この回でいちばん怖いのは3つ:
//   ① **保存の見積りが過小**（＝断るべき写しを通し、Data cannot be cloned が戻る）
//      → 検査1 が「生の合計 ≦ 見積り」を固定し、📌 と PV6 ビューを**二重に数えない**ことも確かめる
//   ② **「作品まるごと」を1回で扱う道が増える／見積りの外に出る**（V166・V168 の穴の形そのもの）
//      → 検査4（網）が `wakeLayersAllFrames(` の呼び出し元を**全数**で持ち、増えたら赤・
//        各行は「同じ関数に見積りがある」か「許可一覧に理由つき」。書き出しの入口は**呼んでいないこと**が緑。
//        4z がわざと1つ足して赤くなることを実証する
//   ③ **保存の待ちがロックになる**（V161-A「保存中も描ける」が死ぬ）
//      → 検査3 が `prepareSnapshot` の中に `beginBusy` / `.ed-busy` が無いこと、
//        待ちが基準点の**前**にあることを固定（v161 検査5 と二段構え）
//
// 1. 見積りの純関数（過小でない・二重に数えない・音声込み）
// 2. 門番（4.4GB→sweep かつ不許可／0.2GB→clone かつ許可／2.6GB→不許可・境界）
// 3. 保存の配線（基準点の前・ロック無し・断りの道・ログ・段階文言の源は1つ）
// 4. ★網: 「作品まるごと」を1回で扱う道の一覧（増えたら赤）＋ 4z わざと足すと赤
// 5. 書き出し（供給元 async・同期版なし・呼ぶ側は全部 await・入口で起こさない・自分が起こしたコマだけ眠らせ直す）
// 6. i18n（7言語・差し込み）
import fs from "node:fs";
import path from "node:path";
import {
  snapshotBytes,
  saveSnapshotPlan,
  saveSnapshotAllowed,
  SAVE_SNAPSHOT_SOFT_BYTES,
  SAVE_SNAPSHOT_MAX_BYTES,
  SNAPSHOT_FACE_OVERHEAD,
  SNAPSHOT_FIXED_OVERHEAD,
  HEAVY_ALLOC_MAX_BYTES,
} from "../src/editor/prefs";
import { newProject, makeEmptyFrame, allocIndexBuf, PIXELS, type Project } from "../src/editor/model";
import { awakeBytes, sleepBytes, sleepFrame, wakeFrame, frameHasAsleep } from "../src/editor/sleep";
import { projectSource, EXPORT_PREWAKE } from "../src/editor/frameSource";

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
const edRaw = read("src/editor/editor.ts");
const libRaw = read("src/library.ts");
const strip = (s: string) => s.replace(/^[ \t]*\/\/.*$/gm, ""); // 自分のコメントに当たらない（V165/V167 の反省）
const ed = strip(edRaw);
const lib = strip(libRaw);

function make(frames: number, layers: number, seed = 7): Project {
  const p = newProject("V168");
  p.layerDefs = [];
  for (let i = 0; i < layers; i++)
    p.layerDefs.push({ id: `L${i + 1}`, name: `L${i + 1}`, visible: true, opacity: 1 });
  p.frames = [];
  for (let f = 0; f < frames; f++) {
    const fr = makeEmptyFrame(p, 0);
    fr.layers = {};
    p.layerDefs.forEach((ld, li) => {
      const b = allocIndexBuf(p);
      for (let k = (f * 7 + seed + li * 11) % 53; k < PIXELS; k += 53) b[k] = ((k + f + li) % 6) + 1;
      fr.layers[ld.id] = b;
    });
    p.frames.push(fr);
  }
  return p;
}

// ================= 1. 見積りの純関数 =================
{
  // 全部起きている作品: 生の合計を下回らない
  const p = make(8, 3);
  const est = snapshotBytes(p);
  const raw = awakeBytes(p) + sleepBytes(p);
  check("1 ★見積りは生の合計を下回らない（全部起きている）", est.est >= raw, `est=${est.est} raw=${raw}`);
  check("1 内訳 awake が生の合計と一致", est.awake === raw);
  check("1 面数を数えている", est.faces === 8 * 3);
  check("1 骨組みぶんが足されている", est.est === raw + est.faces * SNAPSHOT_FACE_OVERHEAD + SNAPSHOT_FIXED_OVERHEAD);

  // 半分眠らせた作品: awake+sleep を下回らない
  for (let i = 0; i < 4; i++) await sleepFrame(p, p.frames[i]);
  const est2 = snapshotBytes(p);
  const raw2 = awakeBytes(p) + sleepBytes(p);
  check("1 ★半分眠らせても生の合計（awake+sleep）を下回らない", est2.est >= raw2, `est=${est2.est} raw=${raw2}`);
  check("1 眠らせたぶん見積りが減る（掃除を待つ意味がある）", est2.est < est.est);
  check("1 面数は眠っても変わらない（起きている＋眠っている）", est2.faces === 24);

  // ★📌 共通レイヤー: 全コマが同じ実体を指す → 1回だけ数える
  const s = make(10, 2);
  const shared = allocIndexBuf(s);
  for (const f of s.frames) f.layers["L1"] = shared; // 全コマが同じバッファ
  const es = snapshotBytes(s);
  check("1 ★📌（同じ実体）は1回だけ数える", es.awake === awakeBytes(s) && es.awake === shared.byteLength + 10 * PIXELS, `awake=${es.awake}`);

  // ★PV6 遅延読みのビュー: z が1本のファイルバッファへのビュー → 下敷きを1回だけ数える
  const v = make(6, 1);
  const file = new Uint8Array(6 * 1000 + 777); // 「ファイル」のつもり
  for (let i = 0; i < 6; i++) {
    const f = v.frames[i];
    delete f.layers["L1"];
    f.sleep = { L1: { z: file.subarray(i * 1000, i * 1000 + 1000), bits: 8, live: null } };
  }
  const ev = snapshotBytes(v);
  check("1 ★PV6 のビューは下敷きを1回だけ数える（ビューの合計ではない）", ev.sleep === file.byteLength, `sleep=${ev.sleep} file=${file.byteLength}`);
  check("1 その値はビューの合計（sleepBytes）以上（＝過小でない）", ev.sleep >= sleepBytes(v));

  // 音声: bgm と se を数える（同じ実体は1回）
  const a = make(2, 1);
  const wav = new Uint8Array(12345);
  a.audio = {
    bgm: { source: "external", mime: "audio/wav", data: wav, muted: false, volume: 1, trimStartMs: 0, trimEndMs: null, syncMode: "audioToAnim", baseSpeedIndex: 6 },
    se: [
      { id: "S1", name: "a", mime: "audio/wav", data: new Uint8Array(500), volume: 1, muted: false },
      { id: "S2", name: "b", mime: "audio/wav", data: wav, volume: 1, muted: false }, // bgm と同じ実体
    ],
  };
  const ea = snapshotBytes(a);
  check("1 音声を数える（bgm＋se・同じ実体は1回）", ea.audio === 12345 + 500, `audio=${ea.audio}`);
  check("1 音声込みでも生の合計を下回らない", ea.est >= awakeBytes(a) + sleepBytes(a) + ea.audio);
}

// ================= 2. 門番 =================
{
  // 事故の入力: 56,860面が全部起きている ≈ 4.37GB → sweep かつ 不許可
  const allAwake = 56860 * PIXELS;
  check("2 ★56,860面が全部起きている（≈4.4GB）→ sweep", saveSnapshotPlan(allAwake) === "sweep");
  check("2 ★その見積りは不許可", !saveSnapshotAllowed(allAwake));
  // 全部眠っている ≈ 0.2GB → clone かつ 許可
  const allAsleep = Math.round(0.2 * 1024 * 1024 * 1024);
  check("2 ★全部眠っている（≈0.2GB）→ clone", saveSnapshotPlan(allAsleep) === "clone");
  check("2 ★その見積りは許可", saveSnapshotAllowed(allAsleep));
  // ★今回のダイアログの入力: 2.6GB → 不許可（＝断られる）
  const today = Math.round(2.6 * 1024 * 1024 * 1024);
  check("2 ★2.6GB（今回落ちた入力）→ 不許可", !saveSnapshotAllowed(today));
  check("2 2.6GB は sweep（先に掃除を待つ）", saveSnapshotPlan(today) === "sweep");
  // 境界
  check("2 soft ちょうどは clone・+1 は sweep", saveSnapshotPlan(SAVE_SNAPSHOT_SOFT_BYTES) === "clone" && saveSnapshotPlan(SAVE_SNAPSHOT_SOFT_BYTES + 1) === "sweep");
  check("2 max ちょうどは許可・+1 は不許可", saveSnapshotAllowed(SAVE_SNAPSHOT_MAX_BYTES) && !saveSnapshotAllowed(SAVE_SNAPSHOT_MAX_BYTES + 1));
  check("2 soft = 512MiB（HEAVY_ALLOC_MAX_BYTES と同値だが別名）", SAVE_SNAPSHOT_SOFT_BYTES === 512 * 1024 * 1024 && SAVE_SNAPSHOT_SOFT_BYTES === HEAVY_ALLOC_MAX_BYTES);
  check("2 max = 1.5GiB（実効上限 約2GiB の 75%）", SAVE_SNAPSHOT_MAX_BYTES === Math.floor(1.5 * 1024 * 1024 * 1024));
  check("2 反証: 再現データ級（1,098コマ×20L 全部起きている ≈1.69GB）は不許可（上限の内側だが余裕なし＝掃除を待つ）", !saveSnapshotAllowed(1098 * 20 * PIXELS));
  check("2 反証: 再現データが掃除済み（≈70MB）なら clone・許可", saveSnapshotPlan(70 * 1024 * 1024) === "clone" && saveSnapshotAllowed(70 * 1024 * 1024));
}

/** 関数名から本体（次の同じ深さのメソッドまで）を切り出す（v166 と同じ作法） */
function bodyOf(src: string, fn: string): string | null {
  const m = new RegExp(
    `\\n  (?:private |protected |public )?(?:async )?${fn}\\s*(?:<[^>]{0,60}>)?\\s*(?:\\([^)]*\\)|\\([\\s\\S]{0,400}?\\))\\s*(?::[^{]{0,120})?\\{`
  ).exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = src.indexOf("\n  }", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

// ================= 3. 保存の配線 =================
{
  const save = bodyOf(ed, "runBackgroundSave") ?? "";
  check("3 runBackgroundSave が見つかる", save !== "");
  const iPrep = save.indexOf("await this.prepareSnapshot()");
  const iExpect = save.indexOf("const expectFrames = this.project.frames.length;");
  const iEpoch = save.indexOf("const epoch0 = this.editEpoch;");
  const iPost = save.indexOf("worker.postMessage({");
  check("3 ★写す前に見積もる（prepareSnapshot を呼ぶ）", iPrep >= 0);
  check("3 ★待ちは基準点（expectFrames / epoch0）より**前**", iPrep >= 0 && iPrep < iExpect && iPrep < iEpoch, `prep=${iPrep} expect=${iExpect} epoch=${iEpoch}`);
  check("3 基準点は postMessage より前（従来どおり）", iEpoch >= 0 && iEpoch < iPost);
  check("3 断られたら写さない（null で return false）", /if \(!prep\) return false;/.test(save));

  const prep = bodyOf(ed, "prepareSnapshot") ?? "";
  check("3 prepareSnapshot が見つかる", prep !== "");
  // ★V161-A: ロックを足していない
  check("3 ★待ちの間にロックを掛けない（beginBusy / ed-busy が無い）", !/beginBusy\(/.test(prep) && !/ed-busy/.test(prep) && !/runHeavy\(/.test(prep));
  check("3 ★soft を超えたら掃除を待つ（plan=sweep）", /saveSnapshotPlan\(est\.est\)/.test(prep) && /await this\.sweepPass\(\);/.test(prep));
  check("3 ★1周ごとに条件を見直す（無限に回さない: clone になった／窓の外に起きているコマが無い／画面を離れた）",
    /if \(saveSnapshotPlan\(est\.est\) === "clone"\) break;/.test(prep) && /if \(prog\.outside === 0\) break;/.test(prep) && /if \(!this\.mounted\) break;/.test(prep));
  check("3 進まなかった周は間を空ける（CPU を回し続けない）", /if \(prog\.n <= before\) await new Promise/.test(prep));
  check("3 ★待っても max を超えたら断る（例外にしない）", /if \(!saveSnapshotAllowed\(est\.est\)\) \{[\s\S]{0,300}?this\.reportSnapshotTooBig\(est\.est\);[\s\S]{0,60}?return null;/.test(prep));
  check("3 ★ログ: prepare（est/awake/sleep/audio/plan/waited/swept/est2）", /\[V168\] save prepare est=\$\{est0\.est\} awake=\$\{est0\.awake\} sleep=\$\{est0\.sleep\} audio=\$\{est0\.audio\}[\s\S]{0,200}?plan=\$\{plan\} waited=\$\{waited\}ms swept=\$\{swept\} est2=\$\{est\.est\}/.test(edRaw));
  check("3 ★ログ: refused（est/max）", /\[V168\] save refused est=\$\{est\.est\} max=\$\{SAVE_SNAPSHOT_MAX_BYTES\}/.test(edRaw));
  // 断りの道
  const tooBig = bodyOf(ed, "reportSnapshotTooBig") ?? "";
  check("3 ★断りの文言（何が・いくつ・どうすれば）＋ログ送付の一言", /ed\.save\.tooBig\.msg/.test(tooBig) && /ed\.log\.sendHint\.msg/.test(tooBig));
  check("3 断っても dirty は残す（return false・W-6 と同じ）", /return false;/.test(tooBig));
  // 段階文言の源は1つ（ピル／中央／進みが止まったとき、の出し分けも同じ関数の中）
  check("3 ★ピルと中央表示の文言は savePhaseText 1つから", /private savePhaseText\(where: "pill" \| "central" = "pill"\): string \{/.test(ed) && (ed.match(/ed\.save\.prepare\.msg/g) ?? []).length === 1);
  check("3 ピルは段階に合わせて描き直す", /this\.renderSavePhase\(\);[\s\S]{0,60}?el\.hidden = false;/.test(bodyOf(ed, "updateSavePill") ?? ""));
  const wait = bodyOf(ed, "waitForSave") ?? "";
  check("3 ★waitForSave（閉じる・別名・書き出しの前）も同じ段階の文言を出す（中央向け）", /this\.cb\.busy\?\.\(this\.savePhaseText\("central"\)\)/.test(wait));
  // Codex 指摘（中）×2: 中央表示（モーダル）は「描き続けられます」と言わない／進みが止まったら文言を切り替える
  const phaseText = bodyOf(ed, "savePhaseText") ?? "";
  check("3 ★中央表示は「描き続けられます」を言わない（prepareWait を使う）", /where === "central"\) return t\("ed\.save\.prepareWait\.msg", v\);/.test(phaseText));
  check("3 ★進みが止まったら文言を切り替える（prepareStalled）", /this\.savePrepStalled \? t\("ed\.save\.prepareStalled\.msg", v\) : t\("ed\.save\.prepare\.msg", v\)/.test(phaseText));
  check("3 止まった判定は時間で見る（3秒・1秒ごと）", /SAVE_PREP_STALL_MS = 3000;/.test(ed) && /setInterval\(\(\) => \{[\s\S]{0,300}?SAVE_PREP_STALL_MS/.test(bodyOf(ed, "prepareSnapshot") ?? ""));
  check("3 止まった判定のタイマーは finally で必ず止める", /clearInterval\(stallTimer\);/.test(bodyOf(ed, "prepareSnapshot") ?? ""));
  check("3 写しに入ったら「保存中」へ戻す", /this\.setSavePhase\("save"\);/.test(save));
  check("3 掃除の1周は Promise で待てる（sweepJob）", /private sweepJob: Promise<void> \| null = null;/.test(ed) && /this\.sweepJob = job;/.test(ed));
  check("3 掃除の進みをピルへ流す口がある", /this\.sweepProgressCb\?\.\(\);/.test(ed));
  // オートセーブは触っていない
  check("3 オートセーブは写しを作らない経路のまま（prepareSnapshot を呼ばない）", !/prepareSnapshot/.test(bodyOf(ed, "runAutosave") ?? "x"));
  // perfDone("save") は待ちを含む（t0 は関数の頭）
  check("3 perfDone(\"save\") は待ちを含む（t0 は関数の頭）", save.indexOf("const t0 = performance.now();") < iPrep && /perfDone\("save", t0\)/.test(save));
}

// ================= 4. ★網: 「作品まるごと」を1回で扱う道 =================
//
// `wakeLayersAllFrames(` の呼び出し元を**全数**で持つ。増えたら赤。各行は
//   (a) 同じ関数の中に `allowBufferAlloc(` がある（V166 B の見積り）か、
//   (b) 許可一覧に理由つきで載っている（履歴の prepare: 元の操作が見積り済み・履歴予算が持つ）
// のどちらか。書き出しの入口（#ed-export / exportSelected）は**呼んでいない**ことが緑。

/** 呼び出し位置から、いちばん近い上のメソッド名を拾う */
function enclosingFn(src: string, idx: number): string {
  const head = src.slice(0, idx);
  const re = /\n  (?:private |protected |public )?(?:async )?([A-Za-z_$][\w$]*)\s*(?:<[^>]{0,60}>)?\s*\(/g;
  let name = "?";
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) name = m[1];
  return name;
}
function wakeSites(src: string): { fn: string; prepare: boolean }[] {
  const out: { fn: string; prepare: boolean }[] = [];
  const re = /wakeLayersAllFrames\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const line = src.slice(lineStart, m.index);
    out.push({ fn: enclosingFn(src, m.index), prepare: /prepare:\s*\(\)\s*=>\s*$/.test(line) });
  }
  return out;
}
{
  const sites = wakeSites(ed);
  const direct = sites.filter((s) => !s.prepare).map((s) => s.fn).sort();
  const prepare = sites.filter((s) => s.prepare).map((s) => s.fn).sort();
  // ★一覧（要件 §1-N の表）。増えたら赤＝新しい「作品まるごと」の道が見積りの外に生えたことになる
  const EXPECT_DIRECT = [
    "deleteFolderWithContents", // フォルダごと削除（全コマ×消す枚数）
    "deleteLayerInner", // レイヤー削除（全コマ×1枚）
    "mergeLayerDownInner", // レイヤー統合（全コマ×2枚）
    "pasteLayerAllFramesInner", // 全コマへレイヤー貼り付け
    "sharedScanOthersDiffer", // 📌 の見比べ（read）
    "toggleLayerSharedInner", // 📌 の切り替え
  ].sort();
  const EXPECT_PREPARE = [
    "deleteFolderWithContents",
    "deleteLayerInner",
    "mergeLayerDownInner",
    "pasteLayerAllFramesInner",
    "toggleLayerSharedInner",
  ].sort();
  check("4 ★直接の呼び出し元は一覧どおり（editor.ts・6か所）", JSON.stringify(direct) === JSON.stringify(EXPECT_DIRECT), `実際=${direct.join(",")}`);
  check("4 ★履歴の prepare は一覧どおり（5か所）", JSON.stringify(prepare) === JSON.stringify(EXPECT_PREPARE), `実際=${prepare.join(",")}`);
  // (a) 直接の呼び出し元は同じ関数に見積りがある
  for (const fn of EXPECT_DIRECT) {
    const body = bodyOf(ed, fn) ?? "";
    check(`4 ${fn}: 同じ関数に allowBufferAlloc がある（V166 B）`, /allowBufferAlloc\(/.test(body));
  }
  // (b) prepare の許可一覧（理由: 元の操作が同じ面を見積り済み。undo/redo が起こすのは同じレイヤー・
  //     控えの実体は履歴予算（bytes）が持つ。V166 の判断を踏襲＝この回では見積りを足さない）
  check("4 prepare の5か所は許可一覧に載っている（理由は報告書 §N）", EXPECT_PREPARE.length === 5);
  // 書き出しの入口は呼んでいない
  check("4 ★書き出しの入口（#ed-export）で全コマを起こさない", !/#ed-export"\)\.onclick = async[\s\S]{0,1600}?wakeLayersAllFrames\(/.test(ed));
  check("4 ★書き出しの入口（library.exportSelected）で全コマを起こさない", wakeSites(lib).length === 0 && !/wakeLayersAllFrames/.test(lib));
  // PerfOp の**列挙そのもの**を読む（コメントに「export.wake」と書いてあっても引っかからない・v159 と同じ作法）
  const perfBlock = read("src/perf.ts").match(/export type PerfOp =([\s\S]*?);/)?.[1] ?? "";
  const perfOps = new Set((perfBlock.match(/^\s*\|\s*"([a-z.]+)"/gm) ?? []).map((l) => l.replace(/^\s*\|\s*"|"$/g, "")));
  check("4 PerfOp から export.wake が消えている（列挙を読む）", perfOps.size > 0 && !perfOps.has("export.wake"), `${perfOps.size} 件`);
  check("4 1コマ画像保存の「1コマだけ起こす」はそのまま", /#ed-imgexport"\)\.onclick = async[\s\S]{0,700}?wakeFrame\(this\.project, fr, "read"\)/.test(ed));

  // ---- 4z. ★わざと1つ足すと赤くなることの実証 ----
  {
    const injected = ed.replace(
      "\n  private ensureSaveWorker(): Worker {",
      "\n  private ensureSaveWorker(): Worker {\n    void wakeLayersAllFrames(this.project, [], \"read\");"
    );
    const d2 = wakeSites(injected).filter((s) => !s.prepare).map((s) => s.fn).sort();
    check("4z ★見積りの無い呼び出しを1つ足すと一覧の検査が赤くなる（網の実証）", JSON.stringify(d2) !== JSON.stringify(EXPECT_DIRECT) && d2.includes("ensureSaveWorker"), `実際=${d2.join(",")}`);
  }
}

// ================= 5. 書き出し =================
{
  const fsrc = read("src/editor/frameSource.ts");
  const exp = read("src/editor/exporter.ts");
  const mainTs = read("src/main.ts");
  check("5 ★getFrameRgba は Promise を返す型（同期版を残さない）", /getFrameRgba\(i: number\): Promise<Uint8ClampedArray>;/.test(fsrc) && !/getFrameRgba\(i: number\): Uint8ClampedArray/.test(fsrc));
  check("5 exporter.ts に同期の getFrameRgba 定義が残っていない", !/getFrameRgba\(i: number\): Uint8ClampedArray/.test(exp));
  // ★呼ぶ側は全部 await。**src/ と scripts/ の全ファイル**を走査する（Codex 指摘・低: exporter.ts だけ見ていて、
  //  tsc の範囲外にある scripts/ の取りこぼし（m1120 / m1122）を見逃していた）。
  //  「呼び出し」＝ `.getFrameRgba(` / `collectGifPalette(` の直後が引数（定義・型・プロパティ名は除く）
  const listTs = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(ts|mts)$/.test(ent.name)) out.push(p);
      }
    };
    walk(path.join(root, dir));
    return out;
  };
  const leaks: string[] = [];
  let calls = 0;
  for (const file of [...listTs("src"), ...listTs("scripts")]) {
    // 行コメントもブロックコメント（JSDoc）も落とす（説明文の中の `collectGifPalette(` に当たらない）
    const text = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const rel = path.relative(root, file);
    for (const m of text.matchAll(/(?<![\w.])(?:[\w$.]+\.)?(getFrameRgba|collectGifPalette)\(/g)) {
      const before = text.slice(Math.max(0, m.index! - 40), m.index!);
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 30);
      // 定義（`function collectGifPalette(`／`getFrameRgba(i: number)`／`async getFrameRgba(`）と型・プロパティ定義は除く
      if (/function\s*$|async\s*$/.test(before) || /^\s*i: number\)|^i\)|^\s*\)\s*:/.test(after)) continue;
      if (/getFrameRgba: |getFrameRgba\(i: number\)/.test(m[0] + after)) continue;
      calls++;
      // await している／Promise をそのまま返している（`=> src.getFrameRgba(`・`return …(`）なら取りこぼしではない
      if (!/await\s*$|await \(\s*$|=>\s*$|return\s*$/.test(before)) leaks.push(`${rel}: …${before.slice(-24).replace(/\s+/g, " ")}${m[0]}`);
    }
  }
  check("5 ★src/ と scripts/ の呼び出しは全部 await（取りこぼし無し）", calls >= 8 && leaks.length === 0, `${leaks.length} 件 / 全 ${calls}: ${leaks.slice(0, 4).join(" | ")}`);
  check("5 collectGifPalette は async（main.ts も await）", /export async function collectGifPalette/.test(exp) && /await collectGifPalette\(src, whiteBg\)/.test(mainTs));
  // Codex 指摘（中）: GIF の二重走査を省く（見積りのパレットを渡す）
  check("5 ★GIF は見積りのパレットを書き出しへ渡す（二重走査しない）", /gifPalette\?: number\[\] \| null;/.test(exp) && /o\.gifPalette !== undefined \? o\.gifPalette : await collectGifPalette\(src, o\.whiteBg\)/.test(exp) && /gifPalette: format === "gif" \? gifPal : undefined,/.test(mainTs));
  // Codex 指摘（低）: MP4 のループ境界でも先回りが効く（回り込み）
  check("5 先回りは末尾から先頭へ回り込む（MP4 ループ）", /p\.frames\[\(i \+ k\) % n\]/.test(fsrc));
  check("5 exportGif は Promise executor の同期ループを async 関数に組み替えた", /export async function exportGif\(/.test(exp) && !/return new Promise\(\(resolve, reject\) => \{\s*\n\s*const scaler = new FrameScaler/.test(exp));
  check("5 withRange は供給元の Promise をそのまま通す", /getFrameRgba: \(i\) => src\.getFrameRgba\(lo \+ i\)/.test(fsrc));
  // 供給元: 読む直前に起こす・自分が起こしたコマだけ眠らせ直す
  check("5 ★読む直前に起こす（read）", /wakeFrame\(p, f, "read"\)/.test(fsrc));
  check("5 ★自分が起こしたコマだけ眠らせ直す（mine）", /const mine = new Set<Frame>\(\);/.test(fsrc) && /mine\.has\(behind\)/.test(fsrc) && /sleepFrame\(p, behind, undefined, true/.test(fsrc));
  check("5 先回りは小さい（2〜3）", EXPORT_PREWAKE >= 2 && EXPORT_PREWAKE <= 3);
  check("5 frameSource.ts は DOM に触らない（document / window が無い）", !/\bdocument\b|\bwindow\b/.test(fsrc));

  // ---- 5z. 実際に動かす: 眠ったコマでも白紙にならず、自分が起こしたコマは眠らせ直し、他人のコマは触らない ----
  {
    const { compositeFrame } = await import("../src/editor/render");
    const p = make(12, 2, 3);
    const truth = p.frames.map((_, i) => new Uint8ClampedArray(compositeFrame(p, i).buffer.slice(0, PIXELS * 4)));
    // 0..7 を眠らせ、8..11 は「エディタの窓」のつもりで起こしたまま
    for (let i = 0; i < 8; i++) await sleepFrame(p, p.frames[i]);
    const src = projectSource(p);
    let same = 0;
    for (let i = 0; i < 12; i++) {
      const got = await src.getFrameRgba(i);
      let eq = true;
      for (let k = 0; k < got.length; k++) if (got[k] !== truth[i][k]) { eq = false; break; }
      if (eq) same++;
    }
    await new Promise((r) => setTimeout(r, 20)); // 後片付け（void sleepFrame）を待つ
    check("5z ★眠ったコマも含めて全コマが起きている合成と一致", same === 12, `${same}/12`);
    // 先回りは末尾から先頭へ回り込む（MP4 ループ対策）ので、最後の読みで 0..EXPORT_PREWAKE-1 は再び起きる。
    // それを除いた「読み頭の後ろ」（EXPORT_PREWAKE .. 8-1-EXPORT_PREWAKE-1）は全部眠りに戻っているはず
    const lo = EXPORT_PREWAKE;
    const hi = 8 - 1 - EXPORT_PREWAKE; // 排他
    const backAsleep = p.frames.slice(lo, hi).filter((f) => frameHasAsleep(f)).length;
    check("5z ★自分が起こしたコマは読み終えたら眠らせ直している（読み頭の後ろ）", hi > lo && backAsleep === hi - lo, `${backAsleep}/${hi - lo} コマが眠りに戻った`);
    // 回り込みで起こした先頭のコマは、読みで起こした（控えあり）＝あとの掃除が只で戻せる
    check("5z 回り込みで起こした先頭のコマは控えつきで起きている（只で眠りに戻せる）", p.frames.slice(0, EXPORT_PREWAKE).every((f) => !!f.sleep && Object.values(f.sleep).every((e) => e.live !== null)));
    const othersAwake = p.frames.slice(8).every((f) => !frameHasAsleep(f));
    check("5z ★他人（エディタの窓）が起こしていたコマは触らない（起きたまま）", othersAwake);
    // 反証: 起こさない供給元だと白紙になる（この検査が空振りしていない）
    const q = make(2, 2, 3);
    const before = new Uint8ClampedArray(compositeFrame(q, 0).buffer.slice(0, PIXELS * 4));
    await sleepFrame(q, q.frames[0]);
    const blank = new Uint8ClampedArray(compositeFrame(q, 0).buffer.slice(0, PIXELS * 4));
    let differs = false;
    for (let k = 0; k < before.length; k++) if (before[k] !== blank[k]) { differs = true; break; }
    check("5z 反証: 起こさずに合成すると白紙になる", differs);
    void wakeFrame;
  }
}

// ================= 6. i18n =================
{
  const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
  const NEEDED: Record<string, string[]> = {
    "ed.save.prepare.msg": ["{n}", "{total}"],
    "ed.save.prepareStalled.msg": ["{n}", "{total}"], // Codex 指摘（中）: 進みが止まったとき
    "ed.save.prepareWait.msg": ["{n}", "{total}"], // Codex 指摘（中）: 中央表示（モーダル）向け
    "ed.save.tooBig.msg": ["{est}", "{max}"],
  };
  for (const lang of LANGS) {
    const dict = read(`src/i18n/${lang}.ts`);
    for (const [k, phs] of Object.entries(NEEDED)) {
      const line = dict.split("\n").find((l) => l.includes(`"${k}"`));
      check(`6 ${lang} に ${k} がある`, !!line);
      if (line) check(`6 ★${lang} ${k} の差し込みが揃っている`, phs.every((ph) => line.includes(ph)));
    }
  }
  // 断りの文言は「何が・いくつ・どうすれば」を持つ（ja）
  const ja = read("src/i18n/ja.ts").split("\n").find((l) => l.includes('"ed.save.tooBig.msg"')) ?? "";
  check("6 ★断りの文言に「上限」「減らす」「分けて」がある（どうすればが読める）", /上限/.test(ja) && /減ら/.test(ja) && /分け/.test(ja));
  check("6 断りの文言に「消えていません」がある（脅しにしない）", /消えていません/.test(ja));
}

console.log(`v168 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
