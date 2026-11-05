// V161: 背景保存（A）・検証一重化（C）の回帰ゲート。引数不要:
//   npx tsx scripts/v161_smoke.ts
//
// ★V163 で改訂: V161-B（Rust flate2 のチャンク集積）は PV6 で不要になり撤去された。
//   ここでは「撤去が完全であること」（Rust コマンド・flate2・chunks モードが残っていない）と、
//   V161-A/C の配線（リスナー先行・waitForSave・スナップショット規律）が生きていることを固定する。
//   PV6 そのものの検査は scripts/v163_smoke.ts。
//
// 1. roundtrip: 旧形式（projectToBytes ＝ PV5 の書き手）を projectFromBytes で開くと画素が完全一致
//    （旧形式の作品を**開ける**ことの土台。V197 (A-103) で製品からの PV5 の保存はなくしたが、
//     PV1〜PV5 を開くのは恒久。書き手は検査と私有の MCP が使う＝呼び出し元の一覧は v197_smoke [B-4]）
// 2. 配線の走査: リスナーが postMessage より先／waitForSave が 閉じる・書き出し・終了・更新 に居る／
//    オートセーブが保存飛行中を見送る／Worker が DOM を触らない／V161-B の残骸ゼロ
import fs from "node:fs";
import path from "node:path";
import {
  newProject,
  makeEmptyFrame,
  allocIndexBuf,
  PIXELS,
  type Project,
} from "../src/editor/model";
import { projectToBytes, projectFromBytes } from "../src/editor/serialize";
import ts from "typescript";
import { readEditorSource } from "./editorSource";

function walkTs(n: ts.Node, f: (n: ts.Node) => void) {
  f(n);
  n.forEachChild((c) => walkTs(c, f));
}
/** トップレベルの関数宣言（無ければ null） */
function fnDecl(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  let out: ts.FunctionDeclaration | null = null;
  walkTs(sf, (n) => {
    if (!out && ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) out = n;
  });
  return out;
}
/** クラスのメソッド（無ければ null） */
function methodDecl(sf: ts.SourceFile, name: string): ts.MethodDeclaration | null {
  let out: ts.MethodDeclaration | null = null;
  walkTs(sf, (n) => {
    if (!out && ts.isMethodDeclaration(n) && n.name.getText(sf) === name && n.body) out = n;
  });
  return out;
}
/** その木の中に await・動的 import（import(…)）があるか */
function awaitsIn(n: ts.Node): string[] {
  const hit: string[] = [];
  walkTs(n, (c) => {
    if (ts.isAwaitExpression(c)) hit.push("await");
    if (ts.isCallExpression(c) && c.expression.kind === ts.SyntaxKind.ImportKeyword) hit.push("import()");
    if (ts.isForOfStatement(c) && c.awaitModifier) hit.push("for await");
  });
  return hit;
}
const isAsync = (n: ts.Node) => !!ts.getModifiers(n as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
/** V201: 基準点 → postMessage の鎖（部品の saveWork → editor の口 → 部品の encodeViaWorker）に await・動的 import が無いか。
 *  見つからない輪があれば、それも理由に返す（形が変わって検査が黙るのを防ぐ） */
function awaitChainIssues(coreSf: ts.SourceFile, edSf: ts.SourceFile): string[] {
  const why: string[] = [];
  // ① 部品の saveWork: 基準点（const expectFrames）から写しの口（const encoded = d.encode(p)）まで、同じ並びの文に await が無い
  const sw = fnDecl(coreSf, "saveWork");
  let block: ts.Block | null = null;
  if (sw) {
    walkTs(sw, (n) => {
      if (!block && ts.isBlock(n) && n.statements.some((s) => /^const expectFrames = /.test(s.getText(coreSf)))) block = n;
    });
  }
  if (!block) why.push("部品の saveWork に基準点（const expectFrames）が見つからない");
  else {
    const st = (block as ts.Block).statements.map((s) => s.getText(coreSf));
    const iBase = st.findIndex((s) => /^const expectFrames = p\.frames\.length;$/.test(s));
    const iMark = st.findIndex((s) => /^const edited = d\.markEdits\(\);$/.test(s));
    const iEnc = st.findIndex((s) => /^const encoded = d\.encode\(p\);$/.test(s));
    if (!(iBase >= 0 && iMark > iBase && iEnc > iMark)) why.push(`部品の基準点→markEdits→encode の並びが崩れた（${iBase},${iMark},${iEnc}）`);
    else
      for (let i = iBase; i <= iEnc; i++) {
        const a = awaitsIn((block as ts.Block).statements[i]);
        if (a.length) why.push(`部品の基準点→写しの間に ${a.join(",")}（${st[i].slice(0, 40)}）`);
      }
  }
  // ② editor の口: encode と markEdits は同期の矢印関数（await・動的 import が無い）。encode は encodeViaWorker を呼ぶだけ
  const rbs = methodDecl(edSf, "runBackgroundSave");
  let props: ts.ObjectLiteralExpression | null = null;
  if (rbs)
    walkTs(rbs, (n) => {
      if (!props && ts.isCallExpression(n) && n.expression.getText(edSf) === "saveWork" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) props = n.arguments[0];
    });
  if (!props) why.push("editor の runBackgroundSave が saveWork({…}) を呼んでいない");
  else {
    const prop = (name: string) =>
      (props as ts.ObjectLiteralExpression).properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(edSf) === name);
    for (const name of ["encode", "markEdits"]) {
      const p = prop(name);
      const fn = p?.initializer;
      if (!fn || !ts.isArrowFunction(fn)) why.push(`editor の ${name} の口が矢印関数でない`);
      else if (isAsync(fn)) why.push(`editor の ${name} の口が async`);
      else if (awaitsIn(fn).length) why.push(`editor の ${name} の口に ${awaitsIn(fn).join(",")}`);
    }
    const enc = prop("encode")?.initializer;
    if (enc && ts.isArrowFunction(enc) && !(ts.isCallExpression(enc.body) && enc.body.expression.getText(edSf) === "encodeViaWorker"))
      why.push("editor の encode の口が encodeViaWorker を直に呼んでいない");
  }
  // ③ 部品の encodeViaWorker: 同期の関数・await 無し・postMessage がある
  const vw = fnDecl(coreSf, "encodeViaWorker");
  if (!vw) why.push("部品に encodeViaWorker が無い");
  else {
    if (isAsync(vw)) why.push("encodeViaWorker が async");
    const a = awaitsIn(vw.body!);
    if (a.length) why.push(`encodeViaWorker に ${a.join(",")}`);
    if (!/worker\.postMessage\(/.test(vw.body!.getText(coreSf))) why.push("encodeViaWorker に postMessage が無い");
  }
  return why;
}

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

function make(frames: number, layers: number, seed = 7): Project {
  const p = newProject("V161");
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

// ---------------------------------------------------------------- 1. 旧形式 roundtrip（画素一致）
{
  const p = make(24, 4);
  const bytes = await projectToBytes(p);
  check("1 旧形式（PV5）は gzip 一体型（先頭 1f 8b・トレーラ magic なし）",
    bytes[0] === 0x1f && bytes[1] === 0x8b &&
    new TextDecoder().decode(bytes.subarray(bytes.length - 16, bytes.length - 8)) !== "AMPV6END");
  const re = await projectFromBytes(bytes);
  let diff = 0;
  for (let i = 0; i < p.frames.length; i++)
    for (const ld of p.layerDefs) {
      const a = p.frames[i].layers[ld.id];
      const b = re.frames[i].layers[ld.id];
      for (let k = 0; k < PIXELS; k++) if (a[k] !== b[k]) diff++;
    }
  check("1 旧形式の出力を開くと画素が完全一致（旧形式を開く土台）", diff === 0, `${diff} 画素`);
}

// ---------------------------------------------------------------- 2. 配線の走査
{
  // ★V213 (M-2a): editor.ts の描く処理はコア（src/editor/core/editorCore.ts）へ移った＝editor.ts とコアの字を並べて見る
  //  （「無い」を見る検査がコアへ移った字を見落とさないように。構文木もこの字で作る）
  const ed = readEditorSource(root);
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const wk = fs.readFileSync(path.join(root, "src/editor/saveWorker.ts"), "utf8");
  const rs = fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");

  // ★V201 (M-1a): 写しを取る所（リスナー → postMessage）と基準点は、共通の部品（saveCore.ts の encodeViaWorker・saveWork）へ移った。
  //  見張る中身は同じ（リスナーが先・基準点から postMessage まで await 無し）。見る場所を部品と、部品へ渡す editor の口に直した
  const core = fs.readFileSync(path.join(root, "src/editor/saveCore.ts"), "utf8").replace(/\r\n/g, "\n");
  const coreSf = ts.createSourceFile("saveCore.ts", core, ts.ScriptTarget.Latest, true);
  const edSf = ts.createSourceFile("editor.ts", ed, ts.ScriptTarget.Latest, true);
  const viaWorker = fnDecl(coreSf, "encodeViaWorker");
  const viaText = viaWorker?.body?.getText(coreSf) ?? "";
  // ★リスナーは postMessage より先（小さい作品で done を取り逃がして保存が固まる競合。
  //   ハーネスで実際に踏んだので、テキストの順序で固定する）
  const iListen = viaText.indexOf("const encodedPromise = new Promise");
  const iAdd = viaText.indexOf('worker.addEventListener("message", onMsg);');
  const iPost = viaText.indexOf('worker.postMessage({\n    kind: "encode"');
  check(
    "2 ★Worker のリスナーが postMessage より先にある（部品の encodeViaWorker）",
    iListen >= 0 && iAdd > iListen && iPost > iAdd && viaText.split("postMessage(").length === 2,
    `listen=${iListen} add=${iAdd} post=${iPost}`
  );
  // editor の保存はこの口を通る（自分では postMessage しない＝写しの取り方は部品の 1 か所）
  const rbs = methodDecl(edSf, "runBackgroundSave");
  const rbsText = rbs?.body?.getText(edSf) ?? "";
  check(
    "2 ★editor の保存は写しを部品の encodeViaWorker で取る（自分で postMessage しない）",
    /encode: \(p\) => encodeViaWorker\(worker, seq, p\),/.test(rbsText) && !/postMessage\(/.test(rbsText),
    rbsText.slice(0, 80)
  );

  // waitForSave の配線（閉じる・書き出し・終了・更新）
  check("2 confirmLeave が保存完了を待つ", /confirmLeave\([\s\S]{0,400}?await this\.waitForSave\(\);/.test(ed));
  check("2 書き出しボタンが保存完了を待つ", /#ed-export"\)\.onclick = async[\s\S]{0,300}?await this\.waitForSave\(\);/.test(ed));
  check("2 終了メニューが保存完了を待つ", /set-quit[\s\S]{0,300}?await editor\.waitForSave\(\);/.test(main));
  check("2 「いま更新する」が保存完了を待つ", /nowBtn\.addEventListener[\s\S]{0,400}?await editor\.waitForSave\(\);/.test(main));

  // オートセーブは背景保存の飛行中を見送る
  check("2 オートセーブが saveInFlight を見送る", /this\.saveInFlight != null \|\|/.test(ed));

  // 独立レビューの指摘の再発防止（V161 レビューで採用した配線）
  check(
    "2 ★別名保存は飛行中の保存を先に待つ（無言で通常保存に化けない・独立レビュー①）",
    /async saveAs\(\) \{[\s\S]{0,500}?await this\.waitForSave\(\);[\s\S]{0,300}?this\.askSaveTarget = true;/.test(ed)
  );
  check(
    "2 1コマ画像保存も保存完了を待つ（独立レビュー④）",
    /#ed-imgexport"\)\.onclick = async[\s\S]{0,300}?await this\.waitForSave\(\);/.test(ed)
  );
  check(
    "2 保存中に描いた場合は完了トーストの文言が分かれる（独立レビュー③）",
    /ed\.file\.savedPartial\.toast/.test(ed)
  );
  {
    // ★スナップショットの基準点から postMessage まで、**実行経路上の** await が無い
    //（独立レビュー⑤。挟まると「保存に入るのに dirty が残る」ズレが再発する）。
    // ★V201: 前は editor.ts の 1 区間の字（epoch0 → postMessage）を見ていた。いまの鎖は
    //  部品の saveWork（基準点 → d.markEdits() → d.encode(p)）→ editor の encode の口（同期の矢印関数）→
    //  部品の encodeViaWorker（同期の関数 → worker.postMessage）。**どの輪にも await・動的 import が無い**ことを構文木で見る
    const issues = awaitChainIssues(coreSf, edSf);
    check("2 ★基準点→postMessage の鎖に実行経路の await・動的 import が無い（独立レビュー⑤・V201 で構文木に）", issues.length === 0, issues.join(" / "));
  }

  // W-7 進化: 予約は1件（フラグ1本＝bool）
  check("2 予約は bool 1本（キューを持たない）", /private saveQueued = false;/.test(ed));

  // C: 書く前の重複検証が**手動保存から**消えている（オートセーブには残る）
  check(
    "2 手動保存の pre-write 検証は無い（読み戻し1回・C）",
    !/reportSaveBroken\("pre-write"/.test(ed)
  );
  // V201: オートセーブの手順は部品の autosaveWork へ移った（editor の runAutosave はそれを呼ぶ）。書く前の検証は書く口より前
  {
    const aw = fnDecl(coreSf, "autosaveWork")?.body?.getText(coreSf) ?? "";
    const iV = aw.indexOf("const okAuto = await verifySavedBytes(data, d.project.frames.length);");
    const iW = aw.indexOf("await d.write(");
    check(
      "2 オートセーブの書く前検証は残っている（あちらは読み戻しが無い・部品の autosaveWork・書く口より前）",
      iV >= 0 && iW > iV && /const out = await autosaveWork\(\{/.test(methodDecl(edSf, "runAutosave")?.body?.getText(edSf) ?? ""),
      `verify=${iV} write=${iW}`
    );
  }

  // Worker は DOM を触らない（Worker には無い）
  check(
    "2 saveWorker が DOM を触らない",
    !/\bdocument\.|\bwindow\.|getElementById|querySelector/.test(wk)
  );

  // ---- V163: V161-B の撤去が完全であること（中途半端に残ると死角になる） ----
  for (const c of ["gz_begin", "gz_chunk", "gz_abort", "save_project_gz"]) {
    check(`2 Rust ${c} が撤去済み（定義なし）`, !new RegExp(`fn ${c}\\(`).test(rs));
    check(`2 Rust ${c} が登録からも消えている`, !new RegExp(`\\n            ${c},`).test(rs));
  }
  // ★V202 (M-1a): flate2 は、モバイルだけの保存の仕組み（作品のヘッダの ID を読む）のために、Cargo.toml の末尾の V202 の節
  //  （モバイルの対象の依存・検査用の optional・dev-dependencies）にだけ足した。PC の製品の依存（その節より前）には今も無い
  //  （PC の製品の木で animemo が直に使う依存が同じことは v202_smoke [D-1] が cargo tree で見る）
  const V202_MARK = "# V202 (M-1a): モバイルだけの保存の仕組み（pclib::mobile）が使う依存。";
  const cargoLf = cargo.replace(/\r\n/g, "\n");
  const pcPart = cargoLf.includes(V202_MARK) ? cargoLf.slice(0, cargoLf.indexOf(V202_MARK)) : cargoLf;
  const v202Part = cargoLf.includes(V202_MARK) ? cargoLf.slice(cargoLf.indexOf(V202_MARK)) : "";
  check("2 flate2 が PC の製品の依存から消えている（V202 の節より前に無い）", !/^flate2 = /m.test(pcPart) && !/^\[dependencies\.flate2\]/m.test(pcPart) && /\nhex = "0\.4"\n/.test(pcPart));
  check(
    "2 V202 の節の flate2 は、モバイルの対象・検査用の optional（feature mobile-harness）・dev-dependencies だけ",
    v202Part === "" ||
      (/\[target\.'cfg\(any\(target_os = "android", target_os = "ios"\)\)'\.dependencies\]\nflate2 = "1"/.test(v202Part) &&
        /\[dependencies\.flate2\]\nversion = "1"\noptional = true/.test(v202Part) &&
        /\[dev-dependencies\]\nflate2 = "1"/.test(v202Part) &&
        (v202Part.match(/^flate2 = |^\[dependencies\.flate2\]/gm) ?? []).length === 3)
  );
  check("2 Worker に chunks モードが残っていない", !/"chunks"/.test(wk));
  // ★V197 (A-103): 逆向きにした（前は「pv6 と gzip（旧形式）の 2 つがある」を固定していた）。
  //  Worker は PV6 だけ・PV5 の書き手を持ち込まない（動かして確かめるのは v197_smoke [B-5]）
  check("2 Worker に旧形式（gzip）モードが無い（V197）", !/"gzip"/.test(wk) && !/\bmode\b/.test(wk.replace(/\/\/[^\n]*/g, "")));
  check("2 Worker は PV5 の書き手（projectToBytes）を import しない（V197）", !/import \{[^}]*projectToBytes[^}]*\} from/.test(wk));
  check("2 Worker は encodePV6 で書く（空振り防止）", /await encodePV6\(d\.project\)/.test(wk));
  check("2 editor に gzBegin/gzChunk/gzAbort の呼び出しが残っていない", !/cb\.gz(Begin|Chunk|Abort)/.test(ed));
}

console.log(`v161 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
