// M6-1 映像エクスポート（docs/handoff/M6_1_video_export.md / REQ_M6_export.md）
// 形式: MP4（無音・M6-2で音声対応）/ GIF / APNG / PNG連番(zip)
// 不変条件: 出力は常に 320×240×N（N=1..4）・nearest-neighbor（補間なし）
// フレーム供給は FrameSource に統一（.animemo=compositeFrame / .kwz=getFramePixelsRgba）

import { zipSync } from "fflate";
import GIF from "gif.js";
import UPNG from "upng-js";
import gifWorkerUrl from "gif.js/dist/gif.worker.js?url";
import { Project, FPS_TABLE, W, H, PIXELS } from "./model";
import { compositeFrame } from "./render";

export interface FrameSource {
  /** 総コマ数 */
  count: number;
  /** 実fps（分数可） */
  fps: number;
  loop: boolean;
  /** i コマ目の 320×240 RGBA（長さ W*H*4。呼び出しごとに独立のコピーを返す） */
  getFrameRgba(i: number): Uint8ClampedArray;
}

export type ExportFormat = "mp4" | "gif" | "apng" | "pngzip";

/** M5-1: MP4 に mux する音声＝**ミックス済みWAV1本**（renderExportMix の結果）。
 *  null=無音経路。トリム/ループ/音量/速度rate/SE時刻はレンダ時に適用済みなので
 *  ffmpeg 側は「この WAV を1回再生して -t で切る」だけ（-af volume 撤去）。 */
export interface ExportAudio {
  wav: Uint8Array;
  /** 出力尺（秒）。映像の -t にも使う（syncMode 規則適用済み） */
  durationSec: number;
  /** animToAudio のとき映像を尺までループさせる判断に使う */
  syncMode: "audioToAnim" | "animToAudio";
}

/** M5-1: エクスポートダイアログへ渡す音声ソース（UI表示＋範囲確定後のミックス生成） */
export interface ExportAudioSource {
  /** 何かしら音がある（bgm または 配置済みSE） */
  has: boolean;
  /** 全トラックがミュート（表示は「ミュート中のため無音」） */
  allMuted: boolean;
  /** 「書き出す長さ」初期値 */
  syncMode: "audioToAnim" | "animToAudio";
  /** 範囲・モード確定後にミックスを生成（null=無音経路） */
  build(
    range: { a: number; b: number } | null,
    syncMode: "audioToAnim" | "animToAudio"
  ): Promise<ExportAudio | null>;
}

export interface ExportOptions {
  format: ExportFormat;
  /** 整数倍率 1..4 */
  scale: number;
  onProgress: (done: number, total: number, phase: string) => void;
  cancel: { cancelled: boolean };
  /** MP4 のみ使用。GIF/APNG/PNG連番は無音仕様のため無視 */
  audio?: ExportAudio | null;
  /** M10-13: 透過部分を純白 #ffffff で塗ってから書き出す。
   *  .kwz 直接書き出しは透明画素をそのまま流すため、MP4 は yuv420p 変換で
   *  alpha が捨てられて黒、GIF は透明色の解釈がプレイヤー依存で黒く見える。
   *  3DS 本体の書き出しは白背景なので、それに合わせる。**必須**（呼び出し元で明示）。 */
  whiteBg: boolean;
}

/** .animemo / エディタの Project から */
export function projectSource(p: Project): FrameSource {
  return {
    count: p.frames.length,
    fps: FPS_TABLE[p.speedIndex] ?? 8,
    loop: p.loop,
    getFrameRgba(i: number): Uint8ClampedArray {
      // compositeFrame は使い回しバッファではないが、明示コピーで独立性を保証（handoff §9）
      const u32 = compositeFrame(p, i);
      return new Uint8ClampedArray(u32.buffer.slice(0, PIXELS * 4));
    },
  };
}

/** flipnote.js の note（.kwz / .ppm）から。256×192(.ppm) は 320×240 の白紙へ中央配置 */
export function noteSource(note: {
  frameCount: number;
  framerate: number;
  imageWidth: number;
  imageHeight: number;
  meta?: { loop?: boolean };
  getFramePixelsRgba(i: number): Uint32Array;
}): FrameSource {
  const nw = note.imageWidth;
  const nh = note.imageHeight;
  const ox = Math.floor((W - nw) / 2);
  const oy = Math.floor((H - nh) / 2);
  return {
    count: note.frameCount,
    fps: note.framerate,
    loop: note.meta?.loop ?? true,
    getFrameRgba(i: number): Uint8ClampedArray {
      const px = note.getFramePixelsRgba(i);
      if (nw === W && nh === H) {
        return new Uint8ClampedArray(px.buffer.slice(px.byteOffset, px.byteOffset + PIXELS * 4));
      }
      // 中央配置（余白は白）
      const out = new Uint32Array(PIXELS).fill(0xffffffff);
      for (let y = 0; y < nh; y++) {
        const src = y * nw;
        const dst = (y + oy) * W + ox;
        out.set(px.subarray(src, src + nw), dst);
      }
      return new Uint8ClampedArray(out.buffer);
    },
  };
}

/** コマ範囲 [a..b]（両端含む）に限定するラッパ */
export function withRange(src: FrameSource, a: number, b: number): FrameSource {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(src.count - 1, Math.max(a, b));
  return {
    count: hi - lo + 1,
    fps: src.fps,
    loop: src.loop,
    getFrameRgba: (i) => src.getFrameRgba(lo + i),
  };
}

/** 320×240 RGBA → 320N×240N へ nearest 拡大（canvas 使い回し） */
class FrameScaler {
  private small: HTMLCanvasElement;
  private smallCtx: CanvasRenderingContext2D;
  readonly big: HTMLCanvasElement;
  readonly bigCtx: CanvasRenderingContext2D;
  readonly ow: number;
  readonly oh: number;

  constructor(readonly n: number, private readonly whiteBg: boolean) {
    this.ow = W * n;
    this.oh = H * n;
    this.small = document.createElement("canvas");
    this.small.width = W;
    this.small.height = H;
    this.smallCtx = this.small.getContext("2d")!;
    this.big = document.createElement("canvas");
    this.big.width = this.ow;
    this.big.height = this.oh;
    this.bigCtx = this.big.getContext("2d", { willReadFrequently: true })!;
    this.bigCtx.imageSmoothingEnabled = false;
  }

  /** 描き込んで big canvas を返す（呼び出し側は即時に使うこと） */
  draw(rgba: Uint8ClampedArray): HTMLCanvasElement {
    this.smallCtx.putImageData(new ImageData(rgba, W, H), 0, 0);
    this.bigCtx.imageSmoothingEnabled = false; // 念のため毎回（状態リセット対策）
    // M10-13: ここが全4形式（PNG連番/GIF/APNG/MP4）の唯一の関所。
    // whiteBg なら先に純白で塗ってから重ねる＝透過部分だけが白になる。
    // 不透明な画素の下に白が見えることはないので、通常作品の出力は1画素も変わらない
    if (this.whiteBg) {
      this.bigCtx.fillStyle = "#ffffff";
      this.bigCtx.fillRect(0, 0, this.ow, this.oh);
    } else {
      this.bigCtx.clearRect(0, 0, this.ow, this.oh);
    }
    this.bigCtx.drawImage(this.small, 0, 0, W, H, 0, 0, this.ow, this.oh);
    return this.big;
  }

  toPngBlob(rgba: Uint8ClampedArray): Promise<Blob | null> {
    this.draw(rgba);
    return new Promise((res) => this.big.toBlob(res, "image/png"));
  }

  /** 拡大後の RGBA バイト列（毎回新規） */
  toRgbaBytes(rgba: Uint8ClampedArray): ArrayBuffer {
    this.draw(rgba);
    return this.bigCtx.getImageData(0, 0, this.ow, this.oh).data.buffer;
  }
}

const CANCELLED = null;

function pad4(i: number): string {
  return String(i + 1).padStart(4, "0");
}

// ---------------- PNG連番 (zip) ----------------

export async function exportPngZip(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  const scaler = new FrameScaler(o.scale, o.whiteBg);
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < src.count; i++) {
    if (o.cancel.cancelled) return CANCELLED;
    const blob = await scaler.toPngBlob(src.getFrameRgba(i));
    if (!blob) throw new Error("PNG生成に失敗しました");
    files[`${pad4(i)}.png`] = new Uint8Array(await blob.arrayBuffer());
    o.onProgress(i + 1, src.count, "PNG生成");
  }
  files["info.txt"] = new TextEncoder().encode(
    `frames=${src.count}\nfps=${src.fps}\nsize=${W * o.scale}x${H * o.scale}\nloop=${src.loop}\n`
  );
  o.onProgress(src.count, src.count, "zip圧縮");
  const zipped = zipSync(files, { level: 0 }); // PNGは圧縮済みのため store
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

// ---------------- GIF ----------------

export function exportGif(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const scaler = new FrameScaler(o.scale, o.whiteBg);
    // U-1: GIF のディレイはセンチ秒粒度（gif.js が ms→cs へ丸め）。既知の制約
    const delay = Math.round(1000 / src.fps);
    const gif = new GIF({
      workers: 2,
      quality: 10,
      width: scaler.ow,
      height: scaler.oh,
      repeat: src.loop ? 0 : -1,
      workerScript: gifWorkerUrl,
    });
    gif.on("finished", (blob) => resolve(blob));
    gif.on("progress", (p) => {
      if (o.cancel.cancelled) {
        gif.abort();
        resolve(CANCELLED);
        return;
      }
      o.onProgress(src.count + Math.round(p * src.count), src.count * 2, "GIFエンコード");
    });
    try {
      for (let i = 0; i < src.count; i++) {
        if (o.cancel.cancelled) {
          resolve(CANCELLED);
          return;
        }
        scaler.draw(src.getFrameRgba(i));
        gif.addFrame(scaler.bigCtx, { delay, copy: true });
        o.onProgress(i + 1, src.count * 2, "フレーム生成");
      }
      gif.render();
    } catch (e) {
      reject(e);
    }
  });
}

// ---------------- APNG ----------------

export async function exportApng(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  const scaler = new FrameScaler(o.scale, o.whiteBg);
  const imgs: ArrayBuffer[] = [];
  const delays: number[] = [];
  const delay = 1000 / src.fps; // UPNG は ms 保持（分数fpsも正確）
  for (let i = 0; i < src.count; i++) {
    if (o.cancel.cancelled) return CANCELLED;
    imgs.push(scaler.toRgbaBytes(src.getFrameRgba(i)));
    delays.push(delay);
    o.onProgress(i + 1, src.count + 1, "フレーム生成");
    // UIを固まらせない
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  if (o.cancel.cancelled) return CANCELLED;
  o.onProgress(src.count, src.count + 1, "APNGエンコード");
  await new Promise((r) => setTimeout(r, 0));
  // ループは常に無限（num_plays=0）。loop=false の非ループは UPNG では指定不可（U-1同様・既知）
  const encoded = UPNG.encode(imgs, scaler.ow, scaler.oh, 0, delays);
  o.onProgress(src.count + 1, src.count + 1, "完了");
  return new Blob([encoded], { type: "image/png" });
}

// ---------------- MP4（無音・M6-2で音声対応） ----------------

export async function exportMp4(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  o.onProgress(0, src.count + 1, "エンコーダ準備中（初回は時間がかかります）");
  // ffmpeg.wasm core はアプリに同梱（オフライン動作・実行時ネットワーク取得なし）
  const [{ FFmpeg }, { toBlobURL }, coreJs, coreWasm] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
    import("@ffmpeg/core?url"),
    import("@ffmpeg/core/wasm?url"),
  ]);
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(coreJs.default, "text/javascript"),
    wasmURL: await toBlobURL(coreWasm.default, "application/wasm"),
  });
  try {
    const scaler = new FrameScaler(o.scale, o.whiteBg);
    for (let i = 0; i < src.count; i++) {
      if (o.cancel.cancelled) return CANCELLED;
      const blob = await scaler.toPngBlob(src.getFrameRgba(i));
      if (!blob) throw new Error("PNG生成に失敗しました");
      await ffmpeg.writeFile(`f${pad4(i)}.png`, new Uint8Array(await blob.arrayBuffer()));
      o.onProgress(i + 1, src.count + 1, "フレーム書き込み");
    }
    if (o.cancel.cancelled) return CANCELLED;
    ffmpeg.on("progress", ({ progress }) => {
      if (o.cancel.cancelled) {
        try {
          ffmpeg.terminate();
        } catch {
          /* noop */
        }
        return;
      }
      o.onProgress(
        src.count + Math.max(0, Math.min(1, progress)),
        src.count + 1,
        "MP4エンコード"
      );
    });
    // フレームは拡大済みのため scale 不要。分数fps（0.2等）も -framerate で正確
    const audio = o.audio ?? null;
    if (!audio) {
      // 無音経路（M6-1 と同一・回帰なし）
      await ffmpeg.exec([
        "-framerate",
        String(src.fps),
        "-i",
        "f%04d.png",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-movflags",
        "+faststart",
        "out.mp4",
      ]);
    } else {
      // ---- M5-1: 音声 mux ----
      // 音は renderExportMix でミックス済みの WAV 1本（トリム/ループ/音量/速度rate/SE時刻は適用済み）。
      // ffmpeg 側は「WAVを1回入力して -t で決定的に切る」だけ（-af volume・音声側 stream_loop は撤去）。
      await ffmpeg.writeFile(
        "mix.wav",
        new Uint8Array(
          audio.wav.buffer.slice(audio.wav.byteOffset, audio.wav.byteOffset + audio.wav.byteLength)
        )
      );
      if (o.cancel.cancelled) return CANCELLED;
      // 長さ合わせ: -t=audio.durationSec（syncMode 規則で確定済み）
      //   audioToAnim（音をアニメに）: 映像1周 → 尺=アニメ
      //   animToAudio（アニメを音に）: 映像を無限ループ → 尺=（トリム後を rate 再生した）曲
      const margs: string[] = [];
      if (audio.syncMode === "animToAudio") {
        margs.push("-stream_loop", "-1", "-framerate", String(src.fps), "-i", "f%04d.png");
      } else {
        margs.push("-framerate", String(src.fps), "-i", "f%04d.png");
      }
      margs.push("-i", "mix.wav");
      margs.push(
        "-t",
        audio.durationSec.toFixed(3),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "out.mp4"
      );
      await ffmpeg.exec(margs);
    }
    if (o.cancel.cancelled) return CANCELLED;
    const data = (await ffmpeg.readFile("out.mp4")) as Uint8Array;
    o.onProgress(src.count + 1, src.count + 1, "完了");
    return new Blob([data as unknown as BlobPart], { type: "video/mp4" });
  } finally {
    try {
      ffmpeg.terminate();
    } catch {
      /* noop */
    }
  }
}

/** 形式ディスパッチ */
export function runExport(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  switch (o.format) {
    case "pngzip":
      return exportPngZip(src, o);
    case "gif":
      return exportGif(src, o);
    case "apng":
      return exportApng(src, o);
    case "mp4":
      return exportMp4(src, o);
  }
}

export const FORMAT_INFO: Record<
  ExportFormat,
  { label: string; ext: string; mime: string; note?: string }
> = {
  mp4: { label: "MP4（動画）", ext: "mp4", mime: "video/mp4" },
  gif: { label: "GIF（アニメ）", ext: "gif", mime: "image/gif" },
  apng: { label: "APNG（透過）", ext: "png", mime: "image/png" }, // M6-5 Q-5: 単語内改行防止のため短縮
  pngzip: { label: "PNG連番（zip）", ext: "zip", mime: "application/zip" },
};

// ---------------- M10-7: 動画・m4a から音声だけ抽出（MP3 192kbps） ----------------

/**
 * 動画（mp4/mov/webm/mkv）や m4a から**音声トラックだけ**を取り出して MP3 192kbps にする。
 * 同梱の ffmpeg.wasm core を使うので**実行時のネットワーク取得はゼロ**（オフライン完結）。
 *
 * 返すのは mp3 のバイト列だけで、動画そのものは保存しない。呼び出し側はこれを
 * 既存の外部音声（mp3 を選んだ場合）とまったく同じ流れに乗せる。
 *
 * `exportMp4` のロード部分と同じ形をとるが、**あちらは1行も変えていない**
 * （共通化して書き出しの挙動が変わるほうが損）。
 *
 * @returns 抽出できたら mp3 の Uint8Array、音声トラックが無い等で失敗したら null
 */
export async function extractAudioToMp3(
  bytes: Uint8Array,
  ext: string
): Promise<Uint8Array | null> {
  const [{ FFmpeg }, { toBlobURL }, coreJs, coreWasm] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
    import("@ffmpeg/core?url"),
    import("@ffmpeg/core/wasm?url"),
  ]);
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(coreJs.default, "text/javascript"),
    wasmURL: await toBlobURL(coreWasm.default, "application/wasm"),
  });
  const inName = `in.${ext.replace(/[^a-z0-9]/gi, "") || "bin"}`;
  try {
    await ffmpeg.writeFile(inName, bytes);
    // -vn: 映像を捨てる / -map 0:a:0: 最初の音声ストリームだけ
    const code = await ffmpeg.exec([
      "-i",
      inName,
      "-vn",
      "-map",
      "0:a:0",
      "-acodec",
      "libmp3lame",
      "-b:a",
      "192k",
      "out.mp3",
    ]);
    // 音声トラックが無い動画は非0で落ちる（out.mp3 も出ない）
    if (code !== 0) return null;
    const data = (await ffmpeg.readFile("out.mp3")) as Uint8Array;
    if (!data || data.byteLength === 0) return null;
    // ffmpeg の FS 上のバッファは terminate で消えるので、コピーを返す
    return new Uint8Array(data);
  } catch {
    return null;
  } finally {
    try {
      ffmpeg.terminate();
    } catch {
      /* 既に終了している場合は無視（書き出し側と同じ後始末） */
    }
  }
}
