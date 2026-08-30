// V161: 背景保存（A）・検証一重化（C）の回帰ゲート。引数不要:
//   npx tsx scripts/v161_smoke.ts
//
// ★V163 で改訂: V161-B（Rust flate2 のチャンク集積）は PV6 で不要になり撤去された。
//   ここでは「撤去が完全であること」（Rust コマンド・flate2・chunks モードが残っていない）と、
//   V161-A/C の配線（リスナー先行・waitForSave・スナップショット規律）が生きていることを固定する。
//   PV6 そのものの検査は scripts/v163_smoke.ts。
//
// 1. roundtrip: 旧形式（projectToBytes ＝ PV5 の書き手）を projectFromBytes で開くと画素が完全一致
//    （旧形式書き出し（作者決定②）の土台。バイト列は v1.5.9 と同一の経路）
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
  check("1 旧形式の出力を開くと画素が完全一致（旧形式書き出しの土台）", diff === 0, `${diff} 画素`);
}

// ---------------------------------------------------------------- 2. 配線の走査
{
  const ed = fs.readFileSync(path.join(root, "src/editor/editor.ts"), "utf8");
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const wk = fs.readFileSync(path.join(root, "src/editor/saveWorker.ts"), "utf8");
  const rs = fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");

  // ★リスナーは postMessage より先（小さい作品で done を取り逃がして保存が固まる競合。
  //   ハーネスで実際に踏んだので、テキストの順序で固定する）
  const iListen = ed.indexOf("const encodedPromise = new Promise");
  const iPost = ed.indexOf('worker.postMessage({\n        kind: "encode"');
  check("2 ★Worker のリスナーが postMessage より先にある", iListen >= 0 && iPost > iListen, `listen=${iListen} post=${iPost}`);

  // waitForSave の配線（閉じる・書き出し・終了・更新）
  check("2 confirmLeave が保存完了を待つ", /confirmLeave\([\s\S]{0,400}?await this\.waitForSave\(\);/.test(ed));
  check("2 書き出しボタンが保存完了を待つ", /#ed-export"\)\.onclick = async[\s\S]{0,300}?await this\.waitForSave\(\);/.test(ed));
  check("2 終了メニューが保存完了を待つ", /set-quit[\s\S]{0,300}?await editor\.waitForSave\(\);/.test(main));
  check("2 「いま更新する」が保存完了を待つ", /nowBtn\.addEventListener[\s\S]{0,400}?await editor\.waitForSave\(\);/.test(main));

  // オートセーブは背景保存の飛行中を見送る
  check("2 オートセーブが saveInFlight を見送る", /this\.saveInFlight != null \|\|/.test(ed));

  // Codex 指摘の再発防止（V161 レビューで採用した配線）
  check(
    "2 ★別名保存は飛行中の保存を先に待つ（無言で通常保存に化けない・Codex①）",
    /async saveAs\(\) \{[\s\S]{0,500}?await this\.waitForSave\(\);[\s\S]{0,300}?this\.askSaveTarget = true;/.test(ed)
  );
  check(
    "2 1コマ画像保存も保存完了を待つ（Codex④）",
    /#ed-imgexport"\)\.onclick = async[\s\S]{0,300}?await this\.waitForSave\(\);/.test(ed)
  );
  check(
    "2 保存中に描いた場合は完了トーストの文言が分かれる（Codex③）",
    /ed\.file\.savedPartial\.toast/.test(ed)
  );
  {
    // ★スナップショットの基準点（epoch0）から postMessage まで、**実行経路上の** await が無い
    //（Codex⑤。挟まると「保存に入るのに dirty が残る」ズレが再発する）。
    const m = ed.match(/const epoch0 = this\.editEpoch;([\s\S]*?)worker\.postMessage\(\{\n        kind: "encode"/);
    const pathAwaits = m
      ? m[1]
          .split("\n")
          .filter((l) => !l.trim().startsWith("//") && /^ {1,8}\S/.test(l) && /\bawait\b/.test(l))
      : ["パターン不一致"];
    check("2 ★基準点→postMessage の間に実行経路の await が無い（Codex⑤）", !!m && pathAwaits.length === 0, pathAwaits.join(" / "));
  }

  // W-7 進化: 予約は1件（フラグ1本＝bool）
  check("2 予約は bool 1本（キューを持たない）", /private saveQueued = false;/.test(ed));

  // C: 書く前の重複検証が**手動保存から**消えている（オートセーブには残る）
  check(
    "2 手動保存の pre-write 検証は無い（読み戻し1回・C）",
    !/reportSaveBroken\("pre-write"/.test(ed)
  );
  check("2 オートセーブの書く前検証は残っている（あちらは読み戻しが無い）", /okAuto = await verifySavedBytes/.test(ed));

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
  check("2 flate2 が依存から消えている", !/^flate2 = /m.test(cargo));
  check("2 Worker に chunks モードが残っていない", !/"chunks"/.test(wk));
  check("2 Worker のモードは pv6 と gzip（旧形式）", /"pv6" \| "gzip"/.test(wk));
  check("2 editor に gzBegin/gzChunk/gzAbort の呼び出しが残っていない", !/cb\.gz(Begin|Chunk|Abort)/.test(ed));
}

console.log(`v161 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
