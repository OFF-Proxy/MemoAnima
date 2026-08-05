// M6-2 音声サブシステム スモークテスト（Node・保存形式/取込のデータ層）
// AC-M6-6(取込・保存残存)/-11(round-trip・旧互換) の機械検証

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { newProject, PIXELS } from "../src/editor/model";
import { projectToBytes, projectFromBytes } from "../src/editor/serialize";
import { importFlipnote } from "../src/editor/kwzImport";
import { pcmS16ToWav } from "../src/editor/audio";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}

async function gzipJson(doc: unknown): Promise<Uint8Array> {
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

// ---- pcmS16ToWav ヘッダ検証 ----
{
  const pcm = new Int16Array(16364); // 1秒
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 10) * 20000);
  const wav = pcmS16ToWav(pcm, 16364, 1);
  const s = (o: number, n: number) => new TextDecoder().decode(wav.subarray(o, o + n));
  const v = new DataView(wav.buffer);
  check("WAV RIFF/WAVE/fmt/data", s(0, 4) === "RIFF" && s(8, 4) === "WAVE" && s(12, 4) === "fmt " && s(36, 4) === "data");
  check("WAV sampleRate/bits/ch", v.getUint32(24, true) === 16364 && v.getUint16(34, true) === 16 && v.getUint16(22, true) === 1);
  check("WAV dataサイズ", v.getUint32(40, true) === pcm.length * 2 && wav.length === 44 + pcm.length * 2);
}

// ---- kwz取込: 実データで音声抽出（AC-M6-6 データ層） ----
{
  const libRoot = process.argv[2];
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".kwz")) files.push(p);
    }
  })(libRoot);
  const step = Math.max(1, Math.floor(files.length / 15));
  const samples = files.filter((_, i) => i % step === 0);
  let withAudio = 0;
  let wavOk = 0;
  let roundtripOk = 0;
  for (const f of samples) {
    const nb = readFileSync(f);
    const { project } = await importFlipnote(
      nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength),
      f
    );
    if (project.audio) {
      withAudio++;
      // M5-1: 分離取込後は bgm/se の複数トラック。WAV 判定は全トラックで
      const tracks = [
        ...(project.audio.bgm ? [project.audio.bgm.data] : []),
        ...project.audio.se.map((s) => s.data),
      ];
      if (
        tracks.length > 0 &&
        tracks.every((d) => new TextDecoder().decode(d.subarray(0, 4)) === "RIFF")
      )
        wavOk++;
      // round-trip: 音声バイト＋設定＋SE配置の完全一致（AC-M6-11 の v5 版）
      const bytes = await projectToBytes(project);
      const p2 = await projectFromBytes(bytes);
      const a1 = project.audio;
      const a2 = p2.audio;
      const sameBytes = (x: Uint8Array, y: Uint8Array) => {
        if (x.length !== y.length) return false;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
        return true;
      };
      let same =
        !!a2 &&
        !!a1.bgm === !!a2.bgm &&
        a1.se.length === a2.se.length &&
        (!a1.bgm ||
          (a2.bgm!.source === a1.bgm.source &&
            a2.bgm!.muted === a1.bgm.muted &&
            a2.bgm!.volume === a1.bgm.volume &&
            a2.bgm!.trimStartMs === a1.bgm.trimStartMs &&
            a2.bgm!.trimEndMs === a1.bgm.trimEndMs &&
            a2.bgm!.syncMode === a1.bgm.syncMode &&
            a2.bgm!.baseSpeedIndex === a1.bgm.baseSpeedIndex &&
            sameBytes(a1.bgm.data, a2.bgm!.data))) &&
        a1.se.every(
          (s, i) =>
            a2!.se[i].id === s.id &&
            a2!.se[i].name === s.name &&
            sameBytes(s.data, a2!.se[i].data)
        );
      if (same) {
        for (let fi = 0; fi < project.frames.length; fi++) {
          if ((project.frames[fi].se ?? []).join() !== (p2.frames[fi].se ?? []).join()) {
            same = false;
            break;
          }
        }
      }
      if (same) roundtripOk++;
    }
  }
  console.log(`kwz audio: ${withAudio}/${samples.length} 作品に音声, WAV=${wavOk}, roundtrip=${roundtripOk}`);
  check("音声付きkwzが存在（実データ検証の前提）", withAudio > 0);
  check("抽出音声はWAV", wavOk === withAudio);
  check("v3往復で音声設定＋バイト完全一致", roundtripOk === withAudio);
}

// ---- 設定変更（ミュート/音量/トリム/syncMode/差し替え）が往復保持 ----
{
  const p = newProject("m62");
  p.audio = {
    bgm: {
      source: "external",
      mime: "audio/mpeg",
      data: new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]),
      muted: true,
      volume: 0.35,
      trimStartMs: 1500,
      trimEndMs: 32000,
      syncMode: "animToAudio",
      baseSpeedIndex: 6,
      name: "song.mp3",
    },
    se: [],
  };
  const p2 = await projectFromBytes(await projectToBytes(p));
  const a = p2.audio!.bgm!;
  check(
    "外部音声（BGM）の設定往復",
    a.source === "external" &&
      a.mime === "audio/mpeg" &&
      a.muted &&
      a.volume === 0.35 &&
      a.trimStartMs === 1500 &&
      a.trimEndMs === 32000 &&
      a.syncMode === "animToAudio" &&
      a.name === "song.mp3" &&
      [...a.data].join() === "1,2,3,4,5,250,251,252"
  );
}

// ---- 旧バージョン互換 ----
{
  const layer = new Uint8Array(PIXELS);
  const base = {
    magic: "ANIMEMO",
    width: 320,
    height: 240,
    colorTable: ["", "#141414"],
    layerDefs: [{ id: "L1", name: "A", visible: true, opacity: 1 }],
    speedIndex: 6,
    loop: true,
    colorMode: "palette",
    nextLayerId: 2,
    meta: { title: "old" },
    frames: [{ paper: 1, layers: { L1: b64(layer) } }],
  };
  const v1 = await projectFromBytes(await gzipJson({ ...base, version: 1 }));
  check("v1: audio=null で可逆ロード", v1.audio === null && v1.indexBits === 8);
  const v2 = await projectFromBytes(await gzipJson({ ...base, version: 2, indexBits: 8 }));
  check("v2: audio=null で可逆ロード", v2.audio === null);
  let rejected = false;
  try {
    // M5-1 で v5 が正当になったため、未来バージョンは v6 で検証
    await projectFromBytes(await gzipJson({ ...base, version: 6 }));
  } catch (e) {
    rejected = String(e).includes("アプリを更新");
  }
  check("未来版: 拒否（アプリを更新してください）", rejected);
  // 音声なしプロジェクトの v3 書き出しは audio フィールド省略（無音回帰なし）
  const p = newProject("noaudio");
  const bytes = await projectToBytes(p);
  const ds = new DecompressionStream("gzip");
  const json = JSON.parse(
    new TextDecoder().decode(
      await new Response(new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds)).arrayBuffer().then((b) => new Uint8Array(b))
    )
  );
  check("音声なしは audio 省略・version>=3", json.audio === undefined && json.version >= 3);
}

console.log(`m62 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
