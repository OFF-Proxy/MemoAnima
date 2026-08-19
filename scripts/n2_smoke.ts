// N-2（16bitパレット自動昇格）スモークテスト（GUIなし・Node実行）
// AC-N2-1/2/3/4/5/6/7 のデータ層検証。
// 使い方: esbuild で bundle して node 実行（引数: testlib フォルダ）

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  newProject,
  ensureColor,
  promoteTo16,
  PIXELS,
} from "../src/editor/model";
import { compositeFrame } from "../src/editor/render";
import { projectToBytes, projectFromBytes } from "../src/editor/serialize";
import { importFlipnote } from "../src/editor/kwzImport";
// M12-1c-2: 文言の pin が言語に左右されないよう ja に固定する（pin の文字列は変えていない）
import { setLang } from "../src/i18n";
setLang("ja");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}

async function gunzipJson(bytes: Uint8Array): Promise<any> {
  const ds = new DecompressionStream("gzip");
  const blob = new Blob([bytes as unknown as BlobPart]);
  const out = new Uint8Array(
    await new Response(blob.stream().pipeThrough(ds)).arrayBuffer()
  );
  return JSON.parse(new TextDecoder().decode(out));
}

async function gzipJson(doc: any): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const blob = new Blob([new TextEncoder().encode(JSON.stringify(doc)) as unknown as BlobPart]);
  return new Uint8Array(await new Response(blob.stream().pipeThrough(cs)).arrayBuffer());
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---- AC-N2-1: 新規=8bit・保存は version2/indexBits8・往復で Uint8Array ----
{
  const p = newProject("n2");
  check("N2-1 newProject indexBits=8", p.indexBits === 8);
  const bytes = await projectToBytes(p);
  const doc = await gunzipJson(bytes);
  // v2でindexBits導入・v3(M6-2)でaudio追加。indexBits の互換検証としては version>=2 が本質
  check("N2-1 version>=2", doc.version >= 2);
  check("N2-1 doc.indexBits=8", doc.indexBits === 8);
  const p2 = await projectFromBytes(bytes);
  const buf = Object.values(p2.frames[0].layers)[0];
  check("N2-1 roundtrip Uint8Array", buf instanceof Uint8Array);
}

// ---- AC-N2-2: 257色目で自動昇格・見た目可逆 ----
{
  const p = newProject("n2-promote");
  const lay = Object.keys(p.frames[0].layers)[0];
  // 既定パレットのうち黒(idx1)と白(idx2)で数ドット描いておく（色数には依存しない）
  p.frames[0].layers[lay][0] = 1;
  p.frames[0].layers[lay][100] = 2;
  const before = compositeFrame(p, 0).slice();
  let promotedAt = -1;
  for (let i = 0; p.colorTable.length < 256; i++) {
    ensureColor(p, `#${(0x100000 + i * 37).toString(16).padStart(6, "0").slice(0, 6)}`);
  }
  check("N2-2 256でまだ8bit", p.indexBits === 8 && p.colorTable.length === 256);
  ensureColor(p, "#123456"); // 257色目
  promotedAt = p.colorTable.length;
  check("N2-2 257色目で16bit昇格", p.indexBits === 16 && promotedAt === 257);
  const bufAfter = Object.values(p.frames[0].layers)[0];
  check("N2-2 昇格後はUint16Array", bufAfter instanceof Uint16Array);
  const after = compositeFrame(p, 0);
  let same = true;
  for (let i = 0; i < PIXELS; i++)
    if (before[i] !== after[i]) {
      same = false;
      break;
    }
  check("N2-2 昇格の見た目可逆", same);
}

// ---- AC-N2-3/5: 300色・索引255超を含む保存→再読込がバイト完全一致（LE） ----
{
  const p = newProject("n2-300");
  for (let i = 0; i < 400; i++) {
    ensureColor(p, `#${((i * 3391 + 0x111111) & 0xffffff).toString(16).padStart(6, "0")}`);
  }
  check("N2-3 400色登録で16bit", p.indexBits === 16 && p.colorTable.length > 300);
  const lay = Object.keys(p.frames[0].layers)[0];
  const buf = p.frames[0].layers[lay];
  for (let i = 0; i < PIXELS; i++) buf[i] = (i % (p.colorTable.length - 1)) + 1; // 255超を大量に含む
  const bytes = await projectToBytes(p);
  const p2 = await projectFromBytes(bytes);
  const buf2 = p2.frames[0].layers[lay];
  check("N2-5 再読込がUint16Array", buf2 instanceof Uint16Array);
  let same = buf2.length === PIXELS;
  if (same)
    for (let i = 0; i < PIXELS; i++)
      if (buf[i] !== buf2[i]) {
        same = false;
        break;
      }
  check("N2-3/5 索引値バイト完全一致", same);
  check(
    "N2-3 色テーブル完全一致",
    JSON.stringify(p.colorTable) === JSON.stringify(p2.colorTable)
  );
}

// ---- AC-N2-4: v1 旧ファイル（indexBits無し）が可逆ロード ----
{
  const layerData = new Uint8Array(PIXELS);
  for (let i = 0; i < PIXELS; i++) layerData[i] = i % 7;
  const v1doc = {
    magic: "ANIMEMO",
    version: 1,
    width: 320,
    height: 240,
    colorTable: ["", "#141414", "#ffffff", "#ff1717", "#ffe600", "#008232", "#06aeff"],
    layerDefs: [{ id: "L1", name: "レイヤーA", visible: true, opacity: 1 }],
    speedIndex: 6,
    loop: true,
    colorMode: "palette",
    nextLayerId: 2,
    meta: { title: "v1file" },
    frames: [{ paper: 2, layers: { L1: b64(layerData) } }],
  };
  const v1bytes = await gzipJson(v1doc);
  const p = await projectFromBytes(v1bytes);
  check("N2-4 v1ロード indexBits=8", p.indexBits === 8);
  const buf = p.frames[0].layers["L1"];
  let same = buf instanceof Uint8Array && buf.length === PIXELS;
  if (same) for (let i = 0; i < PIXELS; i++) if (buf[i] !== layerData[i]) { same = false; break; }
  check("N2-4 v1データ可逆", same);
  // v1を開いて昇格→v2/16bitで保存できる
  for (let i = 0; i < 300; i++) ensureColor(p, `#${((i * 7919 + 0x0f0f0f) & 0xffffff).toString(16).padStart(6, "0")}`);
  check("N2-4 v1→昇格", p.indexBits === 16);
  const v2bytes = await projectToBytes(p);
  const doc2 = await gunzipJson(v2bytes);
  check("N2-4 昇格後保存 16bit", doc2.version >= 2 && doc2.indexBits === 16);
  const p3 = await projectFromBytes(v2bytes);
  const b3 = p3.frames[0].layers["L1"];
  let same3 = true;
  for (let i = 0; i < PIXELS; i++) if (b3[i] !== layerData[i]) { same3 = false; break; }
  check("N2-4 昇格保存後も画素値保存", same3);
}

// ---- AC-N2-6: 昇格をまたぐスナップショット widening（.set 方向） ----
{
  const p = newProject("n2-undo");
  const lay = Object.keys(p.frames[0].layers)[0];
  const before8 = new Uint8Array(p.frames[0].layers[lay]); // 8bit時代のスナップショット
  before8[5] = 3;
  promoteTo16(p);
  const live = p.frames[0].layers[lay];
  check("N2-6 昇格後live=16bit", live instanceof Uint16Array);
  live.set(before8); // widening（undo相当）
  check("N2-6 widening値保存", live[5] === 3 && live[0] === 0);
}

// ---- AC-N2-7: .kwz インポートは 8bit のまま・ピクセル一致（回帰） ----
{
  const libRoot = process.argv[2];
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const pth = join(dir, name);
      if (statSync(pth).isDirectory()) walk(pth);
      else if (name.endsWith(".kwz")) files.push(pth);
    }
  })(libRoot);
  const step = Math.max(1, Math.floor(files.length / 10));
  const samples = files.filter((_, i) => i % step === 0);
  const { parse } = await import("flipnote.js");
  let ok = 0;
  for (const f of samples) {
    const nb = readFileSync(f);
    const ab = nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength);
    const note: any = await parse(ab.slice(0));
    const { project } = await importFlipnote(ab.slice(0), f);
    if (project.indexBits !== 8) {
      check("N2-7 import 8bit", false, f);
      continue;
    }
    const ours = compositeFrame(project, 0);
    const theirs: Uint32Array = note.getFramePixelsRgba(0);
    let same = true;
    for (let i = 0; i < PIXELS; i++)
      if ((ours[i] & 0xffffff) !== (theirs[i] & 0xffffff)) {
        same = false;
        break;
      }
    if (same) ok++;
    else check("N2-7 pixel match", false, f);
  }
  check(`N2-7 ${ok}/${samples.length} 一致`, ok === samples.length);
}

console.log(`n2 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
