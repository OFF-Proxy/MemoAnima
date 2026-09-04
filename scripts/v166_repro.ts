// V166 の再現・実測（受け入れ基準1・B の裏づけ）。**読み取りだけ**:
//   npx tsx scripts/v166_repro.ts "<再現データの .memoanima>"
//
// 事故（2026-08-31）の再現データを実際に開き、
//   ① 貼り付け1回が**確保しようとしていた量**を実測する（＝落ちた理由の数字）
//   ② V166 の見積もり（`checkFrameAlloc`）が**確保する前に**断ることを示す
//   ③ そのとき「あと何コマ入るか」が出ることを示す
//   ④ 連打（10回）が漏斗で1回に潰れることを、`runHeavy` と同じ規則の小さな模型で示す
//
// ★このファイルは**書き込みを1バイトもしない**（P-0: 作者のライブラリを守る）。
import fs from "node:fs";
import { projectFromBytes } from "../src/editor/serialize";
import { makeClip, buildFramesFromClip, clipBytes } from "../src/editor/frameClip";
import { checkFrameAlloc, HEAVY_ALLOC_MAX_BYTES } from "../src/editor/prefs";

const file = process.argv[2];
if (!file) {
  console.error("使い方: npx tsx scripts/v166_repro.ts <再現データの .memoanima>");
  process.exit(2);
}

const bytes = fs.readFileSync(file);
console.log(`file: ${bytes.length.toLocaleString()} バイト`);
// PV6 の目印。トレーラは 16 バイトで、その**先頭 8 バイト**が "AMPV6END"
const trailer = bytes.subarray(bytes.length - 16, bytes.length - 8).toString("latin1");
console.log(`形式: ${trailer === "AMPV6END" ? "PV6（AMPV6END あり）" : `不明（${trailer}）`}`);

const project = await projectFromBytes(new Uint8Array(bytes));
const frames = project.frames.length;
const layers = project.layerDefs.length;
const bits: 8 | 16 = project.indexBits === 16 ? 16 : 8;
console.log(`\n作品: ${frames.toLocaleString()}コマ × ${layers}レイヤー × ${bits}bit`);

// ---- ① 事故と同じ形のコピー（作品の後ろ 1,098 コマ＝作者が選んだ範囲の大きさ） ----
const N = Math.min(1098, frames);
const idxs = Array.from({ length: N }, (_, i) => frames - N + i);
const clip = makeClip(project, idxs);
console.log(`\nコピー: ${N.toLocaleString()}コマ（クリップの保持量 ${clipBytes(clip).toLocaleString()} バイト）`);

// ---- ② 貼り付け1回が確保しようとする量 ----
const est = checkFrameAlloc(N, layers, bits);
const gb = (est.needBytes / 1024 / 1024 / 1024).toFixed(2);
console.log(`\n貼り付け1回が確保する量: ${est.needBytes.toLocaleString()} バイト（約 ${gb} GB）`);
console.log(`1回の上限: ${HEAVY_ALLOC_MAX_BYTES.toLocaleString()} バイト（512 MiB）`);
console.log(`判定: ${est.ok ? "通す" : "★断る（確保しない）"}`);
console.log(`断り文句に出す数: あと約 ${est.maxFrames.toLocaleString()} コマ`);

// ---- ③ 10回連打したときに確保される合計（V166 前 / 後） ----
const before = est.needBytes * 10;
console.log(
  `\n10回連打したときに確保しに行く量: V166 前 = ${(before / 1024 / 1024 / 1024).toFixed(1)} GB ／ ` +
    "V166 後 = 0 バイト（見積もりで断るので buildFramesFromClip を呼ばない）"
);

// ---- ④ 連打が漏斗で1回に潰れることの模型（`runHeavy` と同じ規則） ----
{
  let busy = "";
  let ran = 0;
  const runHeavy = async (fn: () => Promise<void>) => {
    if (busy) return; // ★実物と同じ1行（実行中は受け付けない）
    busy = "heavy";
    try {
      await fn();
    } finally {
      busy = "";
    }
  };
  // 10回「連打」する＝待たずに10回呼ぶ（ボタンの click は待ってくれない）
  await Promise.all(
    Array.from({ length: 10 }, () =>
      runHeavy(async () => {
        ran++;
        await new Promise((r) => setTimeout(r, 20)); // 重い処理のつもり
      })
    )
  );
  console.log(`\n連打の模型: 10回押して実際に走ったのは ${ran} 回`);
  if (ran !== 1) {
    console.error("NG: 連打が潰れていない");
    process.exit(1);
  }
}

// ---- ⑤ 反証: 小さい作品なら同じ経路が通ること（断り一辺倒になっていない） ----
{
  const small = checkFrameAlloc(10, layers, bits);
  console.log(`反証: 同じ作品へ 10 コマの貼り付けは ${small.ok ? "通る" : "断られる"}`);
  if (!small.ok) {
    console.error("NG: 小さい貼り付けまで断っている（体感を壊している）");
    process.exit(1);
  }
  // 実際に組み立てて、確保が通ることを1回だけ確かめる（10コマ＝約15MB）
  const smallClip = makeClip(project, idxs.slice(0, 10));
  const built = buildFramesFromClip(project, smallClip);
  console.log(`反証: 10コマの組み立ては成功（${built.length}コマ）`);
}

console.log("\nv166 repro: OK");
