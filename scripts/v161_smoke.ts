// V161: 背景保存（A）・Rust 圧縮の供給路（B）・検証一重化（C）の回帰ゲート。引数不要:
//   npx tsx scripts/v161_smoke.ts
//
// ★この回でいちばん怖いのは2つ:
//   ① 保存経路が2本（Worker 内 gzip / Rust flate2）になった＝**中身がズレたら片方だけ壊れる**。
//      → 検査1で「チャンク連結を gzip したもの ＝ 従来経路の出力」を**バイト一致**で固定する。
//   ② スナップショットの意味が壊れること（保存中の編集が混ざる／落ちる）。
//      → 実ブラウザの検査（報告書 §2）に加え、ここでは**構造**を固定する（検査5）。
//
// 1. ★経路の同一性: encodeProjectRawChunks の連結 → gzip ＝ projectToBytes（バイト一致）
// 2. チャンクの形: 上限を守る・連結が正しい JSON・コマ数が合う
// 3. 背圧: onChunk は**直列**に呼ばれる（並走 0＝作り溜めない）
// 4. roundtrip: チャンク経路の出力を projectFromBytes で開くと画素が完全一致
// 5. 配線の走査: リスナーが postMessage より先／waitForSave が 閉じる・書き出し・終了・更新 に居る／
//    オートセーブが保存飛行中を見送る／Rust コマンドが登録済み／Worker が DOM を触らない
import fs from "node:fs";
import path from "node:path";
import {
  newProject,
  makeEmptyFrame,
  allocIndexBuf,
  PIXELS,
  type Project,
} from "../src/editor/model";
import {
  projectToBytes,
  projectFromBytes,
  encodeProjectRawChunks,
} from "../src/editor/serialize";

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

const gzip = async (b: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer()
  );

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// meta.modifiedAt が呼ぶたびに変わると経路の比較ができないので、検査の間だけ時刻を止める。
// （保存の中身の検査であって、時刻の検査ではない）
const realToISO = Date.prototype.toISOString;
Date.prototype.toISOString = function () {
  return "2026-08-31T00:00:00.000Z";
};

try {
  // ---------------------------------------------------------------- 1. ★経路の同一性
  {
    const p = make(24, 4);
    const viaGzip = await projectToBytes(p);
    const chunks: Uint8Array[] = [];
    await encodeProjectRawChunks(p, async (c) => {
      chunks.push(c);
    }, 256 * 1024);
    const raw = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      raw.set(c, o);
      o += c.length;
    }
    const viaChunks = await gzip(raw);
    check(
      "1 ★チャンク連結→gzip が従来経路とバイト一致（保存経路が2本に割れない）",
      sameBytes(viaGzip, viaChunks),
      `gzip=${viaGzip.length} chunks=${viaChunks.length}`
    );

    // ---------------------------------------------------------------- 2. チャンクの形
    check("2 チャンクは複数に割れている（1本にまとまっていない）", chunks.length > 1, `${chunks.length}`);
    // 上限 256KB＋1コマぶんの遊び（フラッシュは「超えたら」なので最後の1個ぶんはみ出す）
    const tooBig = chunks.filter((c) => c.length > 256 * 1024 + 600 * 1024);
    check("2 どのチャンクも上限＋1コマぶんを超えない", tooBig.length === 0, `${tooBig.length} 個`);
    const text = new TextDecoder().decode(raw);
    const doc = JSON.parse(text) as { frames: unknown[] };
    check("2 連結が正しい JSON で、コマ数が合う", Array.isArray(doc.frames) && doc.frames.length === 24);

    // ---------------------------------------------------------------- 4. roundtrip（画素一致）
    const re = await projectFromBytes(viaChunks);
    let diff = 0;
    for (let i = 0; i < p.frames.length; i++)
      for (const ld of p.layerDefs) {
        const a = p.frames[i].layers[ld.id];
        const b = re.frames[i].layers[ld.id];
        for (let k = 0; k < PIXELS; k++) if (a[k] !== b[k]) diff++;
      }
    check("4 チャンク経路の出力を開くと画素が完全一致", diff === 0, `${diff} 画素`);
  }

  // ---------------------------------------------------------------- 3. 背圧（直列）
  {
    const p = make(12, 3);
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    await encodeProjectRawChunks(
      p,
      async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5)); // 受け側が遅いふり
        inFlight--;
      },
      128 * 1024
    );
    check("3 ★onChunk は直列（受け側が遅くても作り溜めない）", maxInFlight === 1 && calls > 1, `max=${maxInFlight} calls=${calls}`);
  }
} finally {
  Date.prototype.toISOString = realToISO;
}

// ---------------------------------------------------------------- 5. 配線の走査
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
  check("5 ★Worker のリスナーが postMessage より先にある", iListen >= 0 && iPost > iListen, `listen=${iListen} post=${iPost}`);

  // waitForSave の配線（閉じる・書き出し・終了・更新）
  check("5 confirmLeave が保存完了を待つ", /confirmLeave\([\s\S]{0,400}?await this\.waitForSave\(\);/.test(ed));
  check("5 書き出しボタンが保存完了を待つ", /#ed-export"\)\.onclick = async[\s\S]{0,300}?await this\.waitForSave\(\);/.test(ed));
  check("5 終了メニューが保存完了を待つ", /set-quit[\s\S]{0,300}?await editor\.waitForSave\(\);/.test(main));
  check("5 「いま更新する」が保存完了を待つ", /nowBtn\.addEventListener[\s\S]{0,400}?await editor\.waitForSave\(\);/.test(main));

  // オートセーブは背景保存の飛行中を見送る
  check("5 オートセーブが saveInFlight を見送る", /this\.saveInFlight != null \|\|/.test(ed));

  // Codex 指摘の再発防止（V161 レビューで採用した4件の配線）
  check(
    "5 ★別名保存は飛行中の保存を先に待つ（無言で通常保存に化けない・Codex①）",
    /async saveAs\(\) \{[\s\S]{0,500}?await this\.waitForSave\(\);[\s\S]{0,300}?this\.askSaveTarget = true;/.test(ed)
  );
  check(
    "5 1コマ画像保存も保存完了を待つ（Codex④）",
    /#ed-imgexport"\)\.onclick = async[\s\S]{0,300}?await this\.waitForSave\(\);/.test(ed)
  );
  check(
    "5 保存中に描いた場合は完了トーストの文言が分かれる（Codex③）",
    /ed\.file\.savedPartial\.toast/.test(ed)
  );
  {
    // ★スナップショットの基準点（epoch0）から postMessage まで、**実行経路上の** await が無い
    //（Codex⑤。挟まると「保存に入るのに dirty が残る」ズレが再発する）。
    // リスナーのコールバック内の await（インデントが深い）は実行経路ではないので除く
    const m = ed.match(/const epoch0 = this\.editEpoch;([\s\S]*?)worker\.postMessage\(\{\n        kind: "encode"/);
    const pathAwaits = m
      ? m[1]
          .split("\n")
          .filter((l) => !l.trim().startsWith("//") && /^ {1,8}\S/.test(l) && /\bawait\b/.test(l))
      : ["パターン不一致"];
    check("5 ★基準点→postMessage の間に実行経路の await が無い（Codex⑤）", !!m && pathAwaits.length === 0, pathAwaits.join(" / "));
  }

  // W-7 進化: 予約は1件（フラグ1本＝bool）
  check("5 予約は bool 1本（キューを持たない）", /private saveQueued = false;/.test(ed));

  // C: 書く前の重複検証が**手動保存から**消えている（オートセーブには残る）
  check(
    "5 手動保存の pre-write 検証は無い（読み戻し1回・C）",
    !/reportSaveBroken\("pre-write"/.test(ed)
  );
  check("5 オートセーブの書く前検証は残っている（あちらは読み戻しが無い）", /okAuto = await verifySavedBytes/.test(ed));

  // Worker は DOM を触らない（Worker には無い）
  check(
    "5 saveWorker が DOM を触らない",
    !/\bdocument\.|\bwindow\.|getElementById|querySelector/.test(wk)
  );

  // Rust: コマンド4つが定義され、handler に登録されている
  for (const c of ["gz_begin", "gz_chunk", "gz_abort", "save_project_gz"]) {
    check(`5 Rust ${c} が定義済み`, new RegExp(`fn ${c}\\(`).test(rs));
    check(`5 Rust ${c} が登録済み`, new RegExp(`\\n            ${c},`).test(rs));
  }
  check("5 flate2 が依存に入っている", /^flate2 = "1"/m.test(cargo));
  // 圧縮の確定は既存の pclib::save_project（W-1 の3手順）へ**そのまま**流れる
  check(
    "5 ★save_project_gz が既存の pclib::save_project を使う（W-1 を別実装しない）",
    /fn save_project_gz[\s\S]{0,1600}?pclib::save_project\(/.test(rs)
  );
}

console.log(`v161 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
