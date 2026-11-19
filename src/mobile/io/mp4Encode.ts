// V229 (M-4・REQ_mobile_m4_io.md §3-2): モバイルの MP4（WebCodecs の H.264・AAC ＋ mp4-muxer 5.2.2）。ffmpeg を使わない。
//
// ★PC の MP4（exporter.ts の exportMp4＝ffmpeg）と同じ入力（FrameSource・倍率・白地・ループ回数・音）を受け、同じ並べ方（mp4LoopPlan）を通す:
//   - 音なし: コマ total 枚・1 コマ 1/fps
//   - 音をアニメに（audioToAnim）: コマ total 枚。音は durationSec（-t）で切る
//   - アニメを音に（animToAudio）: 映像は total 枚を繰り返して durationSec まで（-stream_loop -1 と -t）。最後のコマは尺で切る
// ★時刻: コマ i の見せる時刻は i/fps（µs に丸めてから箱の目盛り 57600/秒へ＝表の fps はどれも割り切れる）。B フレームを使わない
//  （Baseline の H.264・latencyMode "quality" でも B フレームは出ない形）。目次は頭（fastStart にコマと音の塊の数を先に渡す）。
// ★書き手は sink（位置を指定して書く）。ネイティブの一時ファイルへ 4MiB 以下の塊で書く（REQ §0-2 の 6）。全部をメモリに持たない。
// ★端末で作れないときは黙らない: 能力の判定（probeMp4Caps）で H.264 の倍率と AAC を返す。AAC が無いのに音を渡されたら
//  "noAac" で断る（音を黙って落とさない＝§0-2 の 12）。
import { Muxer, StreamTarget } from "mp4-muxer";
import { mp4LoopPlan } from "../../editor/audio";
import { FrameScaler, type ExportAudio, type ExportPhase } from "../../editor/exportCore";
import type { FrameSource } from "../../editor/frameSource";
import { W, H } from "../../editor/model";

/** 書き出しの倍率（PC の EXPORT_SCALES と同じ） */
export const MP4_SCALES = [1, 2, 4, 8] as const;
export type Mp4Scale = (typeof MP4_SCALES)[number];

/** 倍率ごとの H.264 の codec の字（Constrained Baseline。レベルは大きさで選ぶ: ×1・×2＝3.0・×4＝3.2・×8＝5.1） */
export function avcCodecFor(scale: number): string {
  if (scale <= 2) return "avc1.42E01E";
  if (scale <= 4) return "avc1.42E020";
  return "avc1.42E033";
}
/** 音の codec（AAC-LC）と速さ（PC と同じ 192kbps） */
export const AAC_CODEC = "mp4a.40.2";
export const AAC_BITRATE = 192_000;
/** 映像の速さの目安（1 画素あたり。×4 の 1280×960 で約 8Mbps） */
export function videoBitrateFor(scale: number): number {
  return Math.round(W * scale * H * scale * 6.5);
}

/** 能力の判定の結果 */
export interface Mp4Caps {
  /** H.264 を使える倍率（空なら MP4 は選べない） */
  scales: Mp4Scale[];
  /** AAC を使える（false なら音つきの MP4 は作れない） */
  aac: boolean;
  /** 判定に使った sampleRate・チャンネル */
  aacRate: number;
  aacChannels: number;
}

/** 判定に使う口（試しで「H.264 なし」「AAC なし」に差し替える＝IO6） */
export interface CodecApi {
  videoSupported(cfg: VideoEncoderConfig): Promise<boolean>;
  audioSupported(cfg: AudioEncoderConfig): Promise<boolean>;
}
export const browserCodecApi: CodecApi = {
  async videoSupported(cfg) {
    if (typeof VideoEncoder === "undefined") return false;
    try {
      return (await VideoEncoder.isConfigSupported(cfg)).supported === true;
    } catch {
      return false;
    }
  },
  async audioSupported(cfg) {
    if (typeof AudioEncoder === "undefined") return false;
    try {
      return (await AudioEncoder.isConfigSupported(cfg)).supported === true;
    } catch {
      return false;
    }
  },
};

export function videoConfigFor(scale: number, fps: number): VideoEncoderConfig {
  return {
    codec: avcCodecFor(scale),
    width: W * scale,
    height: H * scale,
    bitrate: videoBitrateFor(scale),
    framerate: Math.max(1, fps),
    avc: { format: "avc" },
    latencyMode: "quality",
  };
}
export function audioConfigFor(sampleRate: number, channels: number): AudioEncoderConfig {
  return { codec: AAC_CODEC, sampleRate, numberOfChannels: channels, bitrate: AAC_BITRATE };
}

let capsCache: Mp4Caps | null = null;
/** 書き出しの前に倍率ごとの H.264 と AAC を確かめる。その起動の間は控える（OS の更新で変わるので、次の起動では確かめ直す） */
export async function probeMp4Caps(api: CodecApi = browserCodecApi, opts: { fresh?: boolean } = {}): Promise<Mp4Caps> {
  if (capsCache && !opts.fresh && api === browserCodecApi) return capsCache;
  const scales: Mp4Scale[] = [];
  for (const s of MP4_SCALES) if (await api.videoSupported(videoConfigFor(s, 12))) scales.push(s);
  const aac = await api.audioSupported(audioConfigFor(48000, 2));
  const caps: Mp4Caps = { scales, aac, aacRate: 48000, aacChannels: 2 };
  if (api === browserCodecApi) capsCache = caps;
  return caps;
}

/** 書く先（位置を指定して書く）。write は順に呼ばれる（前の write の終わりを待ってから次を呼ぶ） */
export interface ByteSink {
  write(position: number, bytes: Uint8Array): Promise<void>;
}

/** 断り（決まった値・画面の文は画面の作業で） */
export type Mp4Failure = "noH264" | "noAac" | "encoderClosed" | "cancelled" | "badAudio";
export class Mp4Error extends Error {
  constructor(readonly code: Mp4Failure, detail = "") {
    super(`${code}${detail ? `: ${detail}` : ""}`);
  }
}

/** 44 バイトの頭の WAV（pcmS16ToWav・padWavToSec・repeatWav の形）から PCM を取り出す */
export function parseWav16(wav: Uint8Array): { rate: number; channels: number; frames: number; pcm: Int16Array } {
  if (wav.length < 44) throw new Mp4Error("badAudio", "short");
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") throw new Mp4Error("badAudio", "header");
  const channels = v.getUint16(22, true);
  const rate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  if (bits !== 16 || channels < 1 || channels > 2 || rate < 8000) throw new Mp4Error("badAudio", "format");
  const size = Math.min(v.getUint32(40, true), wav.length - 44);
  const frames = Math.floor(size / (2 * channels));
  const copy = new Uint8Array(frames * 2 * channels);
  copy.set(wav.subarray(44, 44 + copy.length));
  return { rate, channels, frames, pcm: new Int16Array(copy.buffer) };
}

/** 映像のコマの並び（純関数・v229 [B] が見る）。返すのは「何枚・i 枚目はどの元コマ・i 枚目の時刻と長さ（µs）・全体の長さ（秒）」 */
export function mp4Timeline(srcCount: number, fps: number, loops: number, audio: ExportAudio | null) {
  const lp = mp4LoopPlan(srcCount, fps, loops, audio);
  const a = lp.audio;
  const f = fps > 0 ? fps : 8;
  const stamp = (i: number) => Math.round((i * 1e6) / f);
  let frames: number;
  let endUs: number;
  if (a && a.syncMode === "animToAudio") {
    // -stream_loop -1 と -t: 映像は durationSec まで繰り返す（最後のコマは尺で切る）
    endUs = Math.round(a.durationSec * 1e6);
    frames = Math.max(1, Math.ceil(a.durationSec * f - 1e-9));
  } else {
    frames = lp.total;
    endUs = a ? Math.round(a.durationSec * 1e6) : stamp(frames);
    // audioToAnim の -t は映像の長さと同じ（syncMode の決まりで確定済み）。映像の尺を -t に合わせる
    if (a) frames = Math.max(1, Math.min(frames, Math.ceil(a.durationSec * f - 1e-9)));
  }
  const total = lp.total;
  return {
    frames,
    frameOf: (i: number) => lp.frameOf(i % total),
    timestamp: stamp,
    duration: (i: number) => Math.max(1, (i + 1 < frames ? stamp(i + 1) : endUs) - stamp(i)),
    endUs,
    durationSec: endUs / 1e6,
    audio: a,
  };
}

export interface Mp4Options {
  scale: number;
  whiteBg: boolean;
  loopCount?: number;
  audio?: ExportAudio | null;
  cancel: { cancelled: boolean };
  onProgress: (done: number, total: number, phase: ExportPhase) => void;
  /** 試しの口: 判定を差し替える（IO6） */
  codecApi?: CodecApi;
}

/** ★モバイルの MP4。成功で全体の大きさ（バイト）を返す。やめた・失敗は Mp4Error を投げる（書きかけの後片付けは呼ぶ側＝一時ファイルの口） */
export async function exportMp4WebCodecs(src: FrameSource, o: Mp4Options, sink: ByteSink): Promise<number> {
  const caps = await probeMp4Caps(o.codecApi ?? browserCodecApi, { fresh: !!o.codecApi });
  const scale = Math.max(1, Math.min(8, Math.round(o.scale)));
  if (!caps.scales.includes(scale as Mp4Scale)) throw new Mp4Error("noH264", `x${scale}`);
  const loops = Math.max(1, Math.min(10, Math.floor(o.loopCount ?? 1)));
  const tl = mp4Timeline(src.count, src.fps, loops, o.audio ?? null);
  const wav = tl.audio ? parseWav16(tl.audio.wav) : null;
  if (wav && !caps.aac) throw new Mp4Error("noAac");
  if (wav && !(await (o.codecApi ?? browserCodecApi).audioSupported(audioConfigFor(wav.rate, wav.channels)))) throw new Mp4Error("noAac", `${wav.rate}/${wav.channels}`);
  const audioFrames = wav ? Math.min(wav.frames, Math.round(tl.durationSec * wav.rate)) : 0;
  const AUDIO_BLOCK = 1024;
  const expectedAudioChunks = wav ? Math.ceil(audioFrames / AUDIO_BLOCK) + 16 : 0;

  // 書き手: muxer の onData は同期なので順に並べて書く。溜まりすぎたら絵の側で待つ
  let writeChain: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let written = 0;
  let writeErr: unknown = null;
  const target = new StreamTarget({
    chunked: true,
    chunkSize: 4 * 1024 * 1024,
    onData: (data, position) => {
      const copy = data.slice();
      pendingBytes += copy.length;
      written = Math.max(written, position + copy.length);
      writeChain = writeChain.then(async () => {
        if (writeErr) return;
        try {
          await sink.write(position, copy);
        } catch (e) {
          writeErr = e;
        } finally {
          pendingBytes -= copy.length;
        }
      });
    },
  });
  const ow = W * scale;
  const oh = H * scale;
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: ow, height: oh },
    ...(wav ? { audio: { codec: "aac" as const, numberOfChannels: wav.channels, sampleRate: wav.rate } } : {}),
    fastStart: { expectedVideoChunks: tl.frames, ...(wav ? { expectedAudioChunks } : {}) },
    firstTimestampBehavior: "strict",
  });

  let encErr: unknown = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (e) {
        encErr = e;
      }
    },
    error: (e) => {
      encErr = e;
    },
  });
  venc.configure(videoConfigFor(scale, src.fps));
  let aenc: AudioEncoder | null = null;
  if (wav) {
    aenc = new AudioEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addAudioChunk(chunk, meta);
        } catch (e) {
          encErr = e;
        }
      },
      error: (e) => {
        encErr = e;
      },
    });
    aenc.configure(audioConfigFor(wav.rate, wav.channels));
  }
  const closeAll = () => {
    for (const e of [venc, aenc]) {
      try {
        if (e && e.state !== "closed") e.close();
      } catch {
        /* 閉じるときの失敗は数えない */
      }
    }
  };
  const fail = (): never => {
    closeAll();
    if (o.cancel.cancelled) throw new Mp4Error("cancelled");
    if (writeErr) throw writeErr;
    throw new Mp4Error("encoderClosed", String((encErr as Error)?.message ?? encErr ?? ""));
  };
  const broken = () => o.cancel.cancelled || encErr !== null || writeErr !== null || venc.state === "closed" || (aenc !== null && aenc.state === "closed");

  try {
    const steps = tl.frames + (wav ? 1 : 0) + 1;
    o.onProgress(0, steps, "encoderInit");
    // 音は先に全部渡す（短い・mux は映像と音を時刻で並べる）
    if (wav && aenc) {
      for (let at = 0; at < audioFrames; at += AUDIO_BLOCK) {
        if (broken()) fail();
        const n = Math.min(AUDIO_BLOCK, audioFrames - at);
        const planar = new Float32Array(n * wav.channels);
        for (let c = 0; c < wav.channels; c++) for (let k = 0; k < n; k++) planar[c * n + k] = wav.pcm[(at + k) * wav.channels + c] / 32768;
        const ad = new AudioData({ format: "f32-planar", sampleRate: wav.rate, numberOfFrames: n, numberOfChannels: wav.channels, timestamp: Math.round((at * 1e6) / wav.rate), data: planar });
        aenc.encode(ad);
        ad.close();
        while (aenc.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 0));
      }
      o.onProgress(1, steps, "frameWrite");
    }
    const scaler = new FrameScaler(scale, o.whiteBg);
    const keyEvery = Math.max(1, Math.round(Math.max(1, src.fps) * 2));
    for (let i = 0; i < tl.frames; i++) {
      if (broken()) fail();
      const canvas = scaler.draw(await src.getFrameRgba(tl.frameOf(i)));
      const vf = new VideoFrame(canvas, { timestamp: tl.timestamp(i), duration: tl.duration(i) });
      venc.encode(vf, { keyFrame: i % keyEvery === 0 });
      vf.close();
      while (venc.encodeQueueSize > 4 || pendingBytes > 16 * 1024 * 1024) {
        if (broken()) fail();
        await (pendingBytes > 16 * 1024 * 1024 ? writeChain : new Promise((r) => setTimeout(r, 0)));
      }
      o.onProgress(i + 1 + (wav ? 1 : 0), steps, "mp4Encode");
    }
    if (broken()) fail();
    await venc.flush();
    if (aenc) await aenc.flush();
    if (broken()) fail();
    muxer.finalize();
    await writeChain;
    if (writeErr) throw writeErr;
    closeAll();
    o.onProgress(steps, steps, "done");
    return written;
  } catch (e) {
    closeAll();
    await writeChain.catch(() => undefined);
    if (e instanceof Mp4Error) throw e;
    if (o.cancel.cancelled) throw new Mp4Error("cancelled");
    if (writeErr) throw writeErr;
    throw new Mp4Error("encoderClosed", String((e as Error)?.message ?? e));
  }
}
