// M6-1 映像エクスポート（docs/handoff/M6_1_video_export.md / REQ_M6_export.md）
// 形式: MP4（無音・M6-2で音声対応）/ GIF / APNG / PNG連番(zip)
// 不変条件: 出力は常に 320×240×N（N=1|2|4|8・M11-22 で ×8 解禁）・nearest-neighbor（補間なし）
// フレーム供給は FrameSource に統一（.animemo=compositeFrame / .kwz=getFramePixelsRgba）

// ★V229 (M-4): ffmpeg を使わない所は exportCore.ts へ移した（モバイルはそちらだけを引く）。ここは MP4（ffmpeg）と、
//   動画・m4a からの音の取り出し（ffmpeg）と、形式ディスパッチだけを持ち、移したものは同じ名前で出し直す（PC の import は変えない）。

import { mp4LoopPlan } from "./audio"; // M16 (X-1)→V216b (A-134): ループ時の映像と音声の並べ方（純関数）
import { t } from "../i18n";
import type { FrameSource } from "./frameSource";
import { FrameScaler, CANCELLED, pad4, exportPngZip, exportGif, exportApng, type ExportOptions, type ExportAudio } from "./exportCore";
export * from "./exportCore";

/** M11-21: MP4 の色まわりの引数（両経路で共通）。
 *  - `-vf scale=out_color_matrix=bt709:out_range=tv`: RGB→YUV の変換を **BT.709・リミテッドレンジで明示**
 *    （従来は swscale 既定＝BT.601 で書かれ、タグ無しだった）
 *  - `-colorspace/-color_primaries/-color_trc bt709 -color_range tv`: 出力ストリームに色タグ（VUI/colr）
 *  同梱 ffmpeg.wasm（FFmpeg 5.1.4・single thread）で有効なことを実測済み（M11-21 報告書 §3）。 */
export const MP4_COLOR_VF = "scale=out_color_matrix=bt709:out_range=tv";
export const MP4_COLOR_TAGS = [
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
];

/** M11-21: `exportMp4` が ffmpeg に渡す引数列（純関数・スモークで pin する）。
 *  色と -bf 0 以外（-framerate/-i/-t/-c:v/-c:a/-b:a/-pix_fmt/-movflags/-stream_loop の並びと値）は M5-1/M6-1 と同一。
 *  A-123（V210）: -bf 0＝B フレームを使わない。使うと x264 は映像の頭を 2 コマ後ろに置き、編集リスト（elst）で戻す形になる。
 *  編集リストを読まないプレーヤー（Windows の標準のプレーヤー）では絵が 2 コマ遅れる＝音が先に聞こえる（12fps で 0.15 秒）。 */
export function mp4ExecArgs(
  fps: number,
  audio: { durationSec: number; syncMode: "audioToAnim" | "animToAudio" } | null
): string[] {
  if (!audio) {
    return [
      "-framerate",
      String(fps),
      "-i",
      "f%04d.png",
      "-vf",
      MP4_COLOR_VF,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-bf",
      "0",
      ...MP4_COLOR_TAGS,
      "-movflags",
      "+faststart",
      "out.mp4",
    ];
  }
  const margs: string[] = [];
  if (audio.syncMode === "animToAudio") {
    margs.push("-stream_loop", "-1", "-framerate", String(fps), "-i", "f%04d.png");
  } else {
    margs.push("-framerate", String(fps), "-i", "f%04d.png");
  }
  margs.push("-i", "mix.wav");
  margs.push(
    "-t",
    audio.durationSec.toFixed(3),
    "-c:v",
    "libx264",
    "-bf",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-vf",
    MP4_COLOR_VF,
    "-pix_fmt",
    "yuv420p",
    ...MP4_COLOR_TAGS,
    "-movflags",
    "+faststart",
    "out.mp4"
  );
  return margs;
}

// ---------------- MP4（無音・M6-2で音声対応） ----------------

export async function exportMp4(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  // M16 (X-1): ループ回数（1〜10）。1（既定）のとき下は従来と完全に同一の経路を通る（x1 バイト一致）
  const loops = Math.max(1, Math.min(10, Math.floor(o.loopCount ?? 1)));
  // ★V216b (A-134・C-28): 並べ方は mp4LoopPlan（曲が主で回数 2 回以上は 1 回ぶんを曲の長さ×fps の切り上げのコマに）。回数 1 は今と同じ
  const lp = mp4LoopPlan(src.count, src.fps, loops, o.audio ?? null);
  const total = lp.total;
  o.onProgress(0, total + 1, "encoderInit");
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
    // M16 (X-1): フレーム供給を N 周（i%count で元コマへ）。loops=1 なら i=0..count-1＝従来と同一の書き出し
    for (let i = 0; i < total; i++) {
      if (o.cancel.cancelled) return CANCELLED;
      const blob = await scaler.toPngBlob(await src.getFrameRgba(lp.frameOf(i))); // V168 (E-1)
      if (!blob) throw new Error(t("export.pngGenFailed.msg"));
      await ffmpeg.writeFile(`f${pad4(i)}.png`, new Uint8Array(await blob.arrayBuffer()));
      o.onProgress(i + 1, total + 1, "frameWrite");
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
      o.onProgress(total + Math.max(0, Math.min(1, progress)), total + 1, "mp4Encode");
    });
    // フレームは拡大済みのため scale 不要（M11-21 の scale フィルタは色変換の指定だけで解像度は触らない）。
    // 分数fps（0.2等）も -framerate で正確。引数列は mp4ExecArgs（純関数・スモークで pin）
    // M16 (X-1): ループ時は音声も N 連結（周ごとに頭から）＋尺を N 倍。loops=1 なら audio をそのまま使う＝従来と同一
    //  V216b (A-134): 曲が主のときは 1 回ぶんを映像の長さまで無音で足してから N 連結（mp4LoopPlan）
    const effAudio: ExportAudio | null = lp.audio;
    if (!effAudio) {
      // 無音経路（M6-1 と同一・M11-21 で色引数だけ追加）
      await ffmpeg.exec(mp4ExecArgs(src.fps, null));
    } else {
      // ---- M5-1: 音声 mux ----
      // 音は renderExportMix でミックス済みの WAV 1本（トリム/ループ/音量/速度rate/SE時刻は適用済み）。
      // ffmpeg 側は「WAVを1回入力して -t で決定的に切る」だけ（-af volume・音声側 stream_loop は撤去）。
      await ffmpeg.writeFile(
        "mix.wav",
        new Uint8Array(
          effAudio.wav.buffer.slice(effAudio.wav.byteOffset, effAudio.wav.byteOffset + effAudio.wav.byteLength)
        )
      );
      if (o.cancel.cancelled) return CANCELLED;
      // 長さ合わせ: -t=effAudio.durationSec（syncMode 規則で確定済み・ループ時は ×N）
      //   audioToAnim（音をアニメに）: 映像 N 周 → 尺=アニメ×N
      //   animToAudio（アニメを音に）: 映像を無限ループ → 尺=（トリム後を rate 再生した）曲×N
      await ffmpeg.exec(mp4ExecArgs(src.fps, effAudio));
    }
    if (o.cancel.cancelled) return CANCELLED;
    const data = (await ffmpeg.readFile("out.mp4")) as Uint8Array;
    o.onProgress(total + 1, total + 1, "done");
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
