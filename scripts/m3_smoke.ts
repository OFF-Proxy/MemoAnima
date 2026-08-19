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

let okFidelity = 0;
let ngFidelity = 0;

for (const f of samples) {
  const nodeBuf = readFileSync(f);
  const ab = nodeBuf.buffer.slice(
    nodeBuf.byteOffset,
    nodeBuf.byteOffset + nodeBuf.byteLength
  );
  const note: any = await parse(ab.slice(0));
  const { project } = await importFlipnote(ab.slice(0), f);
  if (project.frames.length !== note.frameCount) {
    console.log(`NG frames: ${f} ${project.frames.length} != ${note.frameCount}`);
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
    console.log(`NG pixels: ${f} mismatch=${mismatch}`);
  }
}
console.log(`fidelity: ok=${okFidelity} ng=${ngFidelity} (${samples.length} notes)`);

// 保存形式の往復
const f0 = samples[0];
const nb = readFileSync(f0);
const { project: p1 } = await importFlipnote(
  nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength),
  f0
);
const bytes = await projectToBytes(p1);
const p2 = await projectFromBytes(bytes);
let same =
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
