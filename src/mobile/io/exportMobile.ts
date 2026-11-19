// V229 (M-4・REQ_mobile_m4_io.md §3-1〜§3-4): モバイルの書き出しの段取り（画面を持たない）。
//
// ★PC と同じ入力（FrameSource・倍率・範囲・白地・ループ回数・音）を受け、同じ部品を通す:
//   GIF・APNG・PNG 連番＝exportCore の exportGif・exportApng・exportPngZip（PC と同じ関数）／1 コマの画像＝render.ts の frameToImageBlob／
//   MP4＝mp4Encode.ts（WebCodecs。PC は ffmpeg）
// ★書いたものはネイティブの一時ファイル（OutFile＝ioPort の口）へ 4MiB 以下の塊で、位置を指定して書く。終えたファイルだけを渡せる。
//   やめた・失敗したら一時ファイルを消す（ライブラリの作品は 1 バイトも変えない）。
// ★同時に 1 つ（書き出し・取り込み・全部書き出す）。2 つ目は "busy" で断る（ioLock）。
// ★全部のコマをメモリに持つ形式（GIF・APNG・PNG 連番）は、見積りが端末の線（holdAllLimit）を超えたら始める前に断る（D-M4-1 の仮の数）。
import { estimateExport, exportApng, exportGif, exportPngZip, FORMAT_INFO, HOLDS_ALL_FRAMES, type ExportAudio, type ExportFormat, type ExportPhase } from "../../editor/exportCore";
import type { FrameSource } from "../../editor/frameSource";
import { exportMp4WebCodecs, Mp4Error, type ByteSink, type CodecApi } from "./mp4Encode";
import { ioLock } from "./ioLock";

/** 1 回に書く大きさ（Android の base64 の塊と同じ 4MiB） */
export const OUT_CHUNK = 4 * 1024 * 1024;
/** ★D-M4-1（仮）: 全部のコマをメモリに持つ形式の見積りの線（バイト）。エミュレーターで仮に置き、協力者の実機で直す */
export const HOLD_ALL_LIMIT_DEFAULT = 768 * 1024 * 1024;

/** 書き出したファイルの書き手（ネイティブの一時ファイル）。ioPort の beginOut が返す */
export interface OutFile extends ByteSink {
  /** 一時の場所の名札（JS はパスを持たない） */
  readonly tag: string;
  /** 書き終えて閉じる（同期して閉じる）。大きさを返す */
  finish(): Promise<number>;
  /** やめる（消す） */
  abort(): Promise<void>;
}

export type MobileExportKind = ExportFormat | "png1" | "jpeg1";
export type MobileExportFailure = "busy" | "tooBig" | "cancelled" | "noH264" | "noAac" | "encoderClosed" | "badAudio" | "failed";
export class MobileExportError extends Error {
  constructor(readonly code: MobileExportFailure, detail = "") {
    super(`${code}${detail ? `: ${detail}` : ""}`);
  }
}

export interface MobileExportRequest {
  kind: MobileExportKind;
  src: FrameSource;
  scale: number;
  whiteBg: boolean;
  loopCount?: number;
  audio?: ExportAudio | null;
  cancel: { cancelled: boolean };
  onProgress?: (done: number, total: number, phase: ExportPhase) => void;
  /** 1 コマの画像（png1・jpeg1）だけ: 画像を作る関数（render.ts の frameToImageBlob を作品とコマで包んだもの） */
  image?: () => Promise<Blob | null>;
  /** 試しの口 */
  codecApi?: CodecApi;
  holdAllLimit?: number;
}

/** 形式ごとの拡張子と種類（MIME）。.memoanima は application/octet-stream（application/gzip にすると受け手が .gz を足しやすい） */
export function outTypeOf(kind: MobileExportKind | "memoanima" | "zipAll"): { ext: string; mime: string } {
  if (kind === "png1") return { ext: "png", mime: "image/png" };
  if (kind === "jpeg1") return { ext: "jpg", mime: "image/jpeg" };
  if (kind === "memoanima") return { ext: "memoanima", mime: "application/octet-stream" };
  if (kind === "zipAll") return { ext: "zip", mime: "application/zip" };
  return { ext: FORMAT_INFO[kind].ext, mime: FORMAT_INFO[kind].mime };
}

/** Blob を 4MiB 以下の塊で書く */
export async function writeBlob(out: ByteSink, blob: Blob, cancel: { cancelled: boolean }): Promise<number> {
  for (let off = 0; off < blob.size; off += OUT_CHUNK) {
    if (cancel.cancelled) throw new MobileExportError("cancelled");
    const part = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + OUT_CHUNK)).arrayBuffer());
    await out.write(off, part);
  }
  return blob.size;
}

/** ★書き出しを 1 回。成功で終えた一時ファイルの名札と大きさを返す。やめた・失敗は一時ファイルを消してから MobileExportError を投げる */
export async function runMobileExport(req: MobileExportRequest, beginOut: (ext: string) => Promise<OutFile>): Promise<{ tag: string; size: number; ext: string; mime: string }> {
  const release = ioLock.acquire("export");
  if (!release) throw new MobileExportError("busy");
  const prog = req.onProgress ?? (() => undefined);
  const t = outTypeOf(req.kind);
  let out: OutFile | null = null;
  try {
    if (req.kind !== "mp4" && req.kind !== "png1" && req.kind !== "jpeg1" && HOLDS_ALL_FRAMES[req.kind]) {
      const est = estimateExport({ format: req.kind, scale: req.scale, frames: req.src.count });
      if (est.memBytes > (req.holdAllLimit ?? HOLD_ALL_LIMIT_DEFAULT)) throw new MobileExportError("tooBig", String(est.memBytes));
    }
    out = await beginOut(t.ext);
    if (req.kind === "mp4") {
      try {
        await exportMp4WebCodecs(req.src, { scale: req.scale, whiteBg: req.whiteBg, loopCount: req.loopCount, audio: req.audio ?? null, cancel: req.cancel, onProgress: prog, codecApi: req.codecApi }, out);
      } catch (e) {
        if (e instanceof Mp4Error) throw new MobileExportError(e.code, e.message);
        throw e;
      }
    } else {
      let blob: Blob | null;
      if (req.kind === "png1" || req.kind === "jpeg1") {
        if (!req.image) throw new MobileExportError("failed", "no image");
        blob = await req.image();
      } else {
        const o = { format: req.kind, scale: req.scale, whiteBg: req.whiteBg, cancel: req.cancel, onProgress: prog };
        blob = req.kind === "gif" ? await exportGif(req.src, o) : req.kind === "apng" ? await exportApng(req.src, o) : await exportPngZip(req.src, o);
      }
      if (req.cancel.cancelled) throw new MobileExportError("cancelled");
      if (!blob) throw new MobileExportError("failed", "no blob");
      await writeBlob(out, blob, req.cancel);
    }
    if (req.cancel.cancelled) throw new MobileExportError("cancelled");
    const size = await out.finish();
    const tag = out.tag;
    out = null;
    return { tag, size, ...t };
  } catch (e) {
    if (out) await out.abort().catch(() => undefined);
    if (e instanceof MobileExportError) throw e;
    if (req.cancel.cancelled) throw new MobileExportError("cancelled");
    throw new MobileExportError("failed", String((e as Error)?.message ?? e).slice(0, 200));
  } finally {
    release();
  }
}
