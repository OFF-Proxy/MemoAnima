// .kwz / .ppm → Project 忠実インポート（M3）
// flipnote.js の decodeFrame（レイヤー生値 0/1/2）＋ getFramePaletteIndices（紙＋各層色）を使い、
// 3層・各層2色・紙色の構造を colorTable index として per-pixel に忠実再現する。
// ※ getLayerPixels は「白(グローバル0)＝透明」に潰れる罠があるため使わない。

import { parse } from "flipnote.js";
import {
  Project,
  Frame,
  SeTrack,
  newLayerId,
  newSeId,
  ensureColor,
  allocIndexBuf,
  sanitizeAudio,
  W,
  H,
  DEFAULT_PALETTE,
  FPS_TABLE,
} from "./model";
import { pcmS16ToWav } from "./audio";
import { layerBaseName } from "../i18n/defaults";

function rgbToHex(c: [number, number, number, number]): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** note.framerate に最も近い速度段階を返す */
function nearestSpeedIndex(fps: number): number {
  let best = 0;
  let bestD = Infinity;
  FPS_TABLE.forEach((f, i) => {
    const d = Math.abs(f - fps);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export interface ImportedProject {
  project: Project;
  /** 320×240 ではない場合（.ppm=256×192）は中央配置した旨 */
  placedOffset: { x: number; y: number } | null;
}

/** .kwz/.ppm バイト列からプロジェクトを生成する */
export async function importFlipnote(
  buf: ArrayBuffer,
  title: string
): Promise<ImportedProject> {
  const note: any = await parse(buf);
  const numLayers: number = note.numLayers;
  const numLayerColors: number = note.numLayerColors ?? (note.format === "PPM" ? 1 : 2);
  const srcW: number = note.srcWidth ?? note.imageWidth;
  const xOffs: number = note.imageOffsetX ?? 0;
  const yOffs: number = note.imageOffsetY ?? 0;
  const iw: number = note.imageWidth;
  const ih: number = note.imageHeight;
  const globalPalette: [number, number, number, number][] = note.globalPalette;
  const frameCount: number = note.frameCount;

  // 320×240 未満（.ppm 256×192）は中央配置
  const px0 = Math.floor((W - iw) / 2);
  const py0 = Math.floor((H - ih) / 2);
  const placed = px0 !== 0 || py0 !== 0 ? { x: px0, y: py0 } : null;

  const p: Project = {
    version: 1,
    width: W,
    height: H,
    colorTable: [""],
    // インポートは うごメモ6色＋紙色のみ（既定パレット込みでも256未満）→ 必ず 8bit
    indexBits: 8,
    layerDefs: [],
    frames: [],
    speedIndex: nearestSpeedIndex(note.framerate),
    loop: note.meta?.loop ?? true,
    colorMode: "palette",
    nextLayerId: 1,
    meta: {
      title,
      source: { name: title, format: note.format },
      createdAt: new Date().toISOString(),
    },
  };
  // 既定パレットを先に登録（うごメモ6色が先頭に来る）
  for (const hex of DEFAULT_PALETTE) ensureColor(p, hex);

  // レイヤースタック順: getFrameLayerOrder(0)（先に描く=下）
  const order: number[] = note.getFrameLayerOrder(0);
  const names = ["A", "B", "C"];
  const layerIdByOriginal: string[] = new Array(numLayers);
  // flipnote.js の layerVisibility は 1始まり（[_, L1, L2, L3]）
  const layerVisibility: Record<number, boolean> = note.layerVisibility ?? {};
  for (const orig of order) {
    const id = newLayerId(p);
    layerIdByOriginal[orig] = id;
    p.layerDefs.push({
      id,
      name: `${layerBaseName()}${names[orig] ?? orig + 1}`,
      visible: layerVisibility[orig + 1] !== false,
      opacity: 1,
    });
  }

  for (let f = 0; f < frameCount; f++) {
    const pal: number[] = note.getFramePaletteIndices(f); // [紙, A1,A2, B1,B2, C1,C2]（PPM: [紙, L1, L2]）
    const paperIdx = ensureColor(p, rgbToHex(globalPalette[pal[0]]));
    const rawLayers: Uint8Array[] = note.decodeFrame(f);
    // コマ固有の描画順（KWZは3D奥行きで変わる）を保持
    const frameOrder: number[] = note.getFrameLayerOrder(f);
    const frame: Frame = {
      paper: paperIdx,
      layers: {},
      order: frameOrder.map((orig) => layerIdByOriginal[orig]),
    };
    for (let L = 0; L < numLayers; L++) {
      const dst = allocIndexBuf(p); // indexBits=8 なので Uint8Array（従来と同一）
      // このレイヤーの色スロット → colorTable index
      const colorIdx: number[] = [0];
      for (let c = 1; c <= numLayerColors; c++) {
        const gp = pal[L * numLayerColors + c];
        colorIdx.push(ensureColor(p, rgbToHex(globalPalette[gp])));
      }
      const src = rawLayers[L];
      for (let y = 0; y < ih; y++) {
        const sy = y + yOffs;
        const ty = y + py0;
        if (ty < 0 || ty >= H) continue;
        for (let x = 0; x < iw; x++) {
          const v = src[sy * srcW + (x + xOffs)];
          if (v === 0) continue;
          const tx = x + px0;
          if (tx < 0 || tx >= W) continue;
          dst[ty * W + tx] = colorIdx[v] ?? colorIdx[colorIdx.length - 1];
        }
      }
      frame.layers[layerIdByOriginal[L]] = dst;
    }
    p.frames.push(frame);
  }

  // M5-1: 元音声の分離取込（旧マスターミックス1本を置き換え）
  // - BGM: getAudioTrackPcm(BGM)。flipnote.js はここで bgmAdjust=framerate/bgmrate を
  //   PCM に焼き込む（KwzParser.getAudioTrackPcm: srcFreq = rawSampleRate * bgmAdjust）。
  //   つまり返る PCM は「作品の現在 framerate で再生すれば原作聴感」になっている。
  //   したがって baseSpeedIndex は bgmSpeed の写像ではなく**取込時の speedIndex**
  //   （= nearestSpeedIndex(note.framerate)）が正しい（rate=1 で原作一致。
  //   旧マスターミックス getAudioMasterPcm も同じ調整済みBGMを rate=1 で混ぜており、
  //   その聴感一致は M6-2 実機確認済み → 同一性を根拠に採用）。
  // - SE1〜SE4: getAudioTrackPcm(SEn)（調整なし・素のPCM）＋ getSoundEffectFlags() で
  //   コマ別配置（frame.se）を再現。
  try {
    const rate: number = note.sampleRate ?? 16364;
    // FlipnoteAudioTrack enum: BGM=0, SE1..SE4=1..4（flipnote.js 定数）
    const hasTrack = (id: number): boolean => note.hasAudioTrack?.(id) === true;
    let bgmData: Uint8Array | null = null;
    if (hasTrack(0)) {
      const pcm: Int16Array | null = note.getAudioTrackPcm?.(0, rate) ?? null;
      if (pcm && pcm.length > 0) bgmData = pcmS16ToWav(pcm, rate, 1);
    }
    const seTracks: SeTrack[] = [];
    const seIdBySlot: (string | null)[] = [null, null, null, null];
    for (let n = 1; n <= 4; n++) {
      if (!hasTrack(n)) continue;
      const pcm: Int16Array | null = note.getAudioTrackPcm?.(n, rate) ?? null;
      if (!pcm || pcm.length === 0) continue;
      const id = newSeId(p);
      seIdBySlot[n - 1] = id;
      seTracks.push({
        id,
        name: `SE${n}`,
        source: "kwz",
        mime: "audio/wav",
        data: pcmS16ToWav(pcm, rate, 1),
        volume: 1,
        muted: false,
      });
    }
    // コマ別のSE配置（getSoundEffectFlags(): frameごとの [SE1..SE4] boolean）
    if (seTracks.length > 0) {
      const flags: boolean[][] = note.getSoundEffectFlags?.() ?? [];
      for (let f = 0; f < Math.min(frameCount, flags.length); f++) {
        const ids: string[] = [];
        for (let n = 0; n < 4; n++) {
          if (flags[f]?.[n] && seIdBySlot[n]) ids.push(seIdBySlot[n]!);
        }
        if (ids.length > 0) p.frames[f].se = ids;
      }
    }
    p.audio =
      bgmData || seTracks.length > 0
        ? {
            bgm: bgmData
              ? {
                  source: "kwz",
                  mime: "audio/wav",
                  data: bgmData,
                  muted: false,
                  volume: 1,
                  trimStartMs: 0,
                  trimEndMs: null,
                  syncMode: "audioToAnim",
                  baseSpeedIndex: p.speedIndex, // 上記根拠: 調整焼き込み済みPCM＝現在速度が基準
                }
              : null,
            se: seTracks,
          }
        : null;
  } catch {
    p.audio = null;
  }
  sanitizeAudio(p);

  return { project: p, placedOffset: placed };
}
