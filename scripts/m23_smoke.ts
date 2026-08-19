// M10-23 スモーク: 保存系の軽量化（分割エンコード＋高速base64）の完全等価性
// 使い方: npx tsx scripts/m23_smoke.ts   （引数不要・実データ不要）
//
// 検証の柱:
//  1) 新 projectToBytes（チャンク分割組み立て＋toBase64 高速経路）の出力が、
//     **M10-22 までの旧アルゴリズム（一括 JSON.stringify→TextEncoder→Blob gzip・btoa base64）の
//     逐語コピー**とバイト完全一致（8bit/16bit/混在/音声/フォルダ/order/se/1コマの全形）
//  2) projectToBytesInterruptible: 中断なしなら projectToBytes と同一バイト列・
//     中断したら必ず null（部分データを返さない）・yieldNow が実際に呼ばれる・
//     中断後の再エンコードも同一（内部状態を汚さない）
//  3) 新バイト列を projectFromBytes（本ハンドオフ非接触＝旧ビルドと同じ復号器）で開いて
//     画素・colorTable・音声バイトが往復一致（＝旧ビルドで開けることの機械的根拠）
//  4) 比較器はミュータント（1画素改変）を検出できることを自己証明
//
// modifiedAt は毎回 new Date() で変わるため、Date を固定して新旧を同時刻にする。

import {
  Project,
  Frame,
  IndexBuf,
  PIXELS,
  W,
  H,
  newProject,
  newLayerId,
  makeEmptyFrame,
  ensureColor,
  promoteTo16,
} from "../src/editor/model";
import {
  projectToBytes,
  projectToBytesInterruptible,
  projectFromBytes,
} from "../src/editor/serialize";
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

const bytesEq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ---- Date 固定（modifiedAt を新旧で同一にする） ----
const FIXED = 1753600000000;
const RealDate = Date;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Date = class extends RealDate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    if (args.length === 0) super(FIXED);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else super(...(args as [any]));
  }
  static now() {
    return FIXED;
  }
};

// ---- 旧アルゴリズムの逐語コピー（M10-22 時点 serialize.ts 34-163行相当・参照実装） ----
function refBytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
async function refGzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const blob = new Blob([data as BlobPart]);
  const stream = blob.stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function refIndexBufToBytes(buf: IndexBuf, bits: 8 | 16): Uint8Array {
  if (bits === 16 && buf instanceof Uint8Array) {
    const wide = new Uint16Array(PIXELS);
    wide.set(buf);
    buf = wide;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
async function refProjectToBytes(p: Project): Promise<Uint8Array> {
  let bits: 8 | 16 = p.indexBits ?? 8;
  if (bits === 8) {
    outer: for (const f of p.frames) {
      for (const b of Object.values(f.layers)) {
        if (b instanceof Uint16Array) {
          bits = 16;
          break outer;
        }
      }
    }
  }
  const frames = p.frames.map((f) => {
    const layers: Record<string, string> = {};
    for (const [id, buf] of Object.entries(f.layers)) {
      layers[id] = refBytesToBase64(refIndexBufToBytes(buf, bits));
    }
    return {
      paper: f.paper,
      layers,
      order: f.order,
      se: f.se && f.se.length > 0 ? f.se : undefined,
    };
  });
  const doc = {
    magic: "ANIMEMO",
    version: 5,
    width: p.width,
    height: p.height,
    colorTable: p.colorTable,
    indexBits: bits,
    layerDefs: p.layerDefs,
    folders: p.folders && p.folders.length > 0 ? p.folders : undefined,
    speedIndex: p.speedIndex,
    loop: p.loop,
    thumbFrame: Math.max(
      0,
      Math.min(p.frames.length - 1, Math.floor(p.thumbFrame ?? 0))
    ),
    colorMode: p.colorMode,
    nextLayerId: p.nextLayerId,
    meta: { ...p.meta, modifiedAt: new Date().toISOString() },
    nextSeId: p.nextSeId,
    audio: p.audio
      ? {
          bgm: p.audio.bgm
            ? {
                source: p.audio.bgm.source,
                mime: p.audio.bgm.mime,
                data: refBytesToBase64(p.audio.bgm.data),
                muted: p.audio.bgm.muted,
                volume: p.audio.bgm.volume,
                trimStartMs: p.audio.bgm.trimStartMs,
                trimEndMs: p.audio.bgm.trimEndMs,
                syncMode: p.audio.bgm.syncMode,
                baseSpeedIndex: p.audio.bgm.baseSpeedIndex,
                name: p.audio.bgm.name,
              }
            : null,
          se: p.audio.se.map((s) => ({
            id: s.id,
            name: s.name,
            source: s.source,
            mime: s.mime,
            data: refBytesToBase64(s.data),
            volume: s.volume,
            muted: s.muted,
          })),
        }
      : undefined,
    frames,
  };
  const json = new TextEncoder().encode(JSON.stringify(doc));
  return refGzip(json);
}

// ---- 検証用プロジェクト生成（決定的LCG） ----
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

function scribble(buf: IndexBuf, colors: number) {
  for (let s = 0; s < 10; s++) {
    let x = (rnd() * W) | 0;
    let y = (rnd() * H) | 0;
    const col = 1 + ((rnd() * colors) | 0);
    for (let k = 0; k < 120; k++) {
      buf[y * W + x] = col;
      x = Math.max(0, Math.min(W - 1, x + ((rnd() * 3) | 0) - 1));
      y = Math.max(0, Math.min(H - 1, y + ((rnd() * 3) | 0) - 1));
    }
  }
}

/** 8bit・4レイヤー・order/se/フォルダ/音声つきのフル装備プロジェクト */
function makeFullProject(nFrames: number): Project {
  const p = newProject("m23検証");
  p.layerDefs.push({ id: newLayerId(p), name: "レイヤーD", visible: true, opacity: 0.7 });
  p.folders = [
    { id: "F1", name: "フォルダ", visible: true, opacity: 1, collapsed: false },
  ];
  p.layerDefs[0].parent = "F1";
  const paper = p.frames[0].paper;
  p.frames.length = 0;
  for (let i = 0; i < nFrames; i++) {
    const f = makeEmptyFrame(p, paper);
    for (const ld of p.layerDefs) scribble(f.layers[ld.id], 6);
    if (i % 2 === 0) f.order = p.layerDefs.map((l) => l.id).reverse();
    if (i % 3 === 0) f.se = ["S1"];
    if (i % 5 === 0) f.se = []; // 空 → 省略される経路
    p.frames.push(f);
  }
  const wav = new Uint8Array(1000);
  for (let i = 0; i < wav.length; i++) wav[i] = (i * 31) & 0xff;
  const se1 = new Uint8Array(333);
  for (let i = 0; i < se1.length; i++) se1[i] = (i * 7 + 3) & 0xff;
  p.audio = {
    bgm: {
      source: "kwz",
      mime: "audio/wav",
      data: wav,
      muted: false,
      volume: 0.8,
      trimStartMs: 120,
      trimEndMs: null,
      syncMode: "audioToAnim",
      baseSpeedIndex: 6,
      name: "テストBGM",
    },
    se: [
      { id: "S1", name: "ポン", source: "external", mime: "audio/ogg", data: se1, volume: 1, muted: false },
    ],
  };
  p.nextSeId = 2;
  p.thumbFrame = Math.min(2, nFrames - 1);
  return p;
}

async function main() {
  // ---- 1) 新旧バイト完全一致 ----
  const cases: [string, Project][] = [];
  cases.push(["8bitフル装備(12コマ)", makeFullProject(12)]);
  {
    const p = makeFullProject(6);
    promoteTo16(p);
    cases.push(["16bit昇格(6コマ)", p]);
  }
  {
    // 8bit宣言のまま 16bit バッファ混在（防御的 bits=16 経路）
    const p = makeFullProject(4);
    const id0 = p.layerDefs[0].id;
    const wide = new Uint16Array(PIXELS);
    wide.set(p.frames[1].layers[id0] as Uint8Array);
    wide[123] = 300;
    p.frames[1].layers[id0] = wide;
    cases.push(["8bit宣言+16bit混在(4コマ)", p]);
  }
  {
    const p = newProject("最小");
    cases.push(["新規1コマ・音声なし", p]);
  }
  {
    const p = makeFullProject(40);
    p.audio = null;
    for (let i = 0; i < 250; i++) ensureColor(p, `#${(i * 65536 + 40).toString(16).padStart(6, "0")}`);
    cases.push(["40コマ・多色(8bit上限近く)", p]);
  }

  for (const [name, p] of cases) {
    const nw = await projectToBytes(p);
    const rf = await refProjectToBytes(p);
    check(`新旧バイト一致: ${name}`, bytesEq(nw, rf), `new=${nw.length} ref=${rf.length}`);
  }

  // ---- 4) 比較器のミュータント自己証明（1画素変えたら不一致になる） ----
  {
    const p = makeFullProject(3);
    const a = await projectToBytes(p);
    const id0 = p.layerDefs[0].id;
    const before = p.frames[1].layers[id0][555];
    p.frames[1].layers[id0][555] = before === 3 ? 4 : 3;
    const b = await projectToBytes(p);
    check("ミュータント検出（1画素改変で不一致）", !bytesEq(a, b));
    p.frames[1].layers[id0][555] = before;
    const c = await projectToBytes(p);
    check("復元で再一致", bytesEq(a, c));
  }

  // ---- 2) interruptible ----
  const big = makeFullProject(30);
  const base = await projectToBytes(big);
  {
    let yields = 0;
    const r = await projectToBytesInterruptible(big, {
      yieldNow: async () => {
        yields++;
      },
    });
    check("interruptible(中断なし) = projectToBytes", r != null && bytesEq(r, base));
    check(`yieldNow が呼ばれる（${yields}回）`, yields >= 1);
  }
  {
    const r = await projectToBytesInterruptible(big, { aborted: () => true });
    check("最初から中断 → null", r === null);
  }
  {
    let calls = 0;
    const r = await projectToBytesInterruptible(big, {
      aborted: () => ++calls > 5,
    });
    check("途中で中断 → null（部分データを返さない）", r === null);
  }
  {
    // 中断後の再エンコードが汚れないこと
    await projectToBytesInterruptible(big, { aborted: () => true });
    const again = await projectToBytes(big);
    check("中断後の再エンコードも同一", bytesEq(again, base));
  }

  // ---- 3) 往復ロード（projectFromBytes は本ハンドオフ非接触＝旧ビルドの復号器そのもの） ----
  {
    const p = cases[1][1]; // 16bit昇格
    const bytes = await projectToBytes(p);
    const q = await projectFromBytes(bytes);
    check("往復: コマ数・indexBits", q.frames.length === p.frames.length && q.indexBits === 16);
    let same = true;
    for (let i = 0; i < p.frames.length && same; i++) {
      for (const ld of p.layerDefs) {
        const a = p.frames[i].layers[ld.id];
        const b = q.frames[i].layers[ld.id];
        if (!a || !b || a.length !== b.length) {
          same = false;
          break;
        }
        for (let k = 0; k < a.length; k++)
          if (a[k] !== b[k]) {
            same = false;
            break;
          }
      }
    }
    check("往復: 全コマ全レイヤー画素一致", same);
    check("往復: colorTable 一致", JSON.stringify(q.colorTable) === JSON.stringify(p.colorTable));
    check(
      "往復: BGM/SE バイト一致",
      !!q.audio?.bgm &&
        bytesEq(q.audio.bgm.data, p.audio!.bgm!.data) &&
        q.audio.se.length === 1 &&
        bytesEq(q.audio.se[0].data, p.audio!.se[0].data)
    );
    check("往復: order/se/thumbFrame 保持",
      JSON.stringify(q.frames[0].order) === JSON.stringify(p.frames[0].order) &&
      JSON.stringify(q.frames[3].se ?? null) === JSON.stringify(p.frames[3].se ?? null) &&
      q.thumbFrame === p.thumbFrame
    );
  }

  console.log(`\nm23_smoke: ${pass} ok / ${fail} NG`);
  if (fail > 0) process.exit(1);
}

void main();
