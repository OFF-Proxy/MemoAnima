// M3 スモークテスト（GUIなし・Node実行）
// 1) 実 .kwz → importFlipnote → compositeFrame が flipnote.js の getFramePixelsRgba と一致するか（忠実性）
// 2) Project → projectToBytes → projectFromBytes の往復でバッファが完全一致するか（保存形式）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "flipnote.js";
import { importFlipnote } from "../src/editor/kwzImport";
import { compositeFrame } from "../src/editor/render";
import {
  projectToBytes,
  projectFromBytes,
} from "../src/editor/serialize";
// V176b: ログにライブラリのパスと作品名を出さないための伏せ字（src/library.ts と同じ道具）
import { importLogSafe, logSafeFileLabel } from "../src/gzname";
// M12-1c-2: 文言の pin が言語に左右されないよう ja に固定する（pin の文字列は変えていない）
import { setLang } from "../src/i18n";
setLang("ja");

const libRoot = process.argv[2];
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".kwz")) files.push(p);
  }
})(libRoot);

// 全体から均等に ~40 作品サンプル
const step = Math.max(1, Math.floor(files.length / 40));
const samples = files.filter((_, i) => i % step === 0);

// V176b: 実データのライブラリには**開けない .kwz** が混ざり得る（0 バイト・途中で切れた・読めない）。
//  以前はここで例外がそのまま上がり、**1 件で止まって残りを 1 つも検査していなかった**
//  （実例: 848 件中 1 件の 0 バイトが並び順の先頭に居て、3 本とも最初の 1 件で死んでいた）。
//  ⚠ **黙って continue してはいけない**——「検査したつもり」で緑になるのがいちばん危ない。
//  なので **NG として数え、最後に件数と理由をまとめて出す**。
//  ⚠ 理由の文にはパスが混ざり得るので `importLogSafe` を通す（W-10 と同じ作法）。
//  `.kwz` の名前は 3DS が付ける英数字のハッシュ＝作品名ではないので、**名前だけは出してよい**。
const unreadable: string[] = [];
function noteUnreadable(path: string, e: unknown): void {
  const name = logSafeFileLabel(path) || "(名前不明)";
  let size = -1;
  try {
    size = statSync(path).size;
  } catch {
    /* 走っている最中に消えた等。大きさは分からないが、開けなかったことは記録する */
  }
  const why =
    size === 0 ? "中身が空" : importLogSafe(String((e as Error)?.message ?? e), [path]);
  unreadable.push(`${name}: ${why}（${size < 0 ? "大きさ不明" : `${size} バイト`}）`);
}

/** 開けた .kwz（`note` と `project`）。開けなければ null。 */
type Opened = {
  note: any;
  project: Awaited<ReturnType<typeof importFlipnote>>["project"];
};

let okFidelity = 0;
let ngFidelity = 0;
// V176b: 往復検査に使う 1 件は「**開けたもの**」から選ぶ（先頭決め打ちだと壊れた 1 件を掴む）
let roundtripSrc: string | null = null;

for (const f of samples) {
  // ★try で囲むのは「**開く**」ところだけ。この下の照合まで囲むと、こちら側の描画が壊れたときに
  //  「開けなかった」として数えてしまい、本物の不具合が 1 行の注記に化ける
  let opened: Opened | null = null;
  try {
    const nodeBuf = readFileSync(f);
    const ab = nodeBuf.buffer.slice(
      nodeBuf.byteOffset,
      nodeBuf.byteOffset + nodeBuf.byteLength
    );
    const note: any = await parse(ab.slice(0));
    const { project } = await importFlipnote(ab.slice(0), f);
    opened = { note, project };
  } catch (e) {
    noteUnreadable(f, e);
  }
  if (!opened) continue;
  const { note, project } = opened;
  if (roundtripSrc === null) roundtripSrc = f;
  if (project.frames.length !== note.frameCount) {
    console.log(
      `NG frames: ${logSafeFileLabel(f)} ${project.frames.length} != ${note.frameCount}`
    );
    ngFidelity++;
    continue;
  }
  // 数フレームをピクセル比較
  const checkFrames = [
    0,
    Math.floor(note.frameCount / 2),
    note.frameCount - 1,
  ].filter((v, i, a) => a.indexOf(v) === i);
  let mismatch = 0;
  for (const fi of checkFrames) {
    const ours = compositeFrame(project, fi);
    const theirs: Uint32Array = note.getFramePixelsRgba(fi);
    // flipnote.js は 320x240 で返す（kwz）
    for (let i = 0; i < 320 * 240; i++) {
      // RGB比較（アルファは常に255）
      if ((ours[i] & 0xffffff) !== (theirs[i] & 0xffffff)) mismatch++;
    }
  }
  if (mismatch === 0) {
    okFidelity++;
  } else {
    ngFidelity++;
    console.log(`NG pixels: ${logSafeFileLabel(f)} mismatch=${mismatch}`);
  }
}
console.log(`fidelity: ok=${okFidelity} ng=${ngFidelity} (${samples.length} notes)`);
// ★0 件でも必ず出す（出さないと「見ていない」のか「無かった」のか読む側に分からない）
console.log(`開けなかった .kwz: ${unreadable.length} 件 / ${samples.length} 件中${unreadable.length ? "（NG）" : ""}`);
for (const u of unreadable) console.log(`  - ${u}`);

// 保存形式の往復
// V176b: 使う 1 件は**開けたもの**から選ぶ（`samples[0]` の決め打ちだと、壊れた 1 件が
//  並び順の先頭に居るだけでここが落ちる＝実際にそうなっていた）
let same = false;
if (roundtripSrc === null) {
  // 開けた .kwz が 1 件も無い＝往復検査は「通った」でも「落ちた」でもなく **できていない**。
  // 黙って OK にすると、ライブラリが壊れているのにスモークだけ緑になる
  console.log(`roundtrip: NG (開ける .kwz が 1 件も無い)`);
} else {
  const nb = readFileSync(roundtripSrc);
  const { project: p1 } = await importFlipnote(
    nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength),
    roundtripSrc
  );
  const bytes = await projectToBytes(p1);
  const p2 = await projectFromBytes(bytes);
  same =
    p1.frames.length === p2.frames.length &&
    JSON.stringify(p1.colorTable) === JSON.stringify(p2.colorTable) &&
    JSON.stringify(p1.layerDefs) === JSON.stringify(p2.layerDefs) &&
    p1.speedIndex === p2.speedIndex;
  if (same) {
    outer: for (let fi = 0; fi < p1.frames.length; fi++) {
      if (p1.frames[fi].paper !== p2.frames[fi].paper) {
        same = false;
        break;
      }
      for (const [id, buf] of Object.entries(p1.frames[fi].layers)) {
        const b2 = p2.frames[fi].layers[id];
        if (!b2 || b2.length !== buf.length) {
          same = false;
          break outer;
        }
        for (let i = 0; i < buf.length; i++)
          if (buf[i] !== b2[i]) {
            same = false;
            break outer;
          }
      }
    }
  }
  console.log(
    `roundtrip: ${same ? "OK" : "NG"} (${p1.frames.length} frames, ${bytes.length} bytes gz)`
  );
}

// V176b: 総合判定。開けなかった .kwz も NG として数える（黙って 0 で終わらない）。
//  ★`process.exit` ではなく `exitCode`——Windows では標準出力が非同期で、
//   exit すると上の行が出きらないまま切れることがある
const verdict = ngFidelity === 0 && unreadable.length === 0 && same;
console.log(
  `m3 smoke: ${verdict ? "OK" : "NG"} (fidelity ng=${ngFidelity}, 開けなかった=${unreadable.length}, roundtrip=${same ? "OK" : "NG"})`
);
if (!verdict) process.exitCode = 1;
