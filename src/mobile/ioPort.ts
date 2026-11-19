// V229 (M-4・REQ_mobile_m4_io.md §3-4〜§3-9): **出し入れの口**（書き出したファイル・選んだ／受け取ったファイル・全部書き出す）。
//
// ★命令の名前と形の正は src/mobile/contract.json（v229_smoke [K] がこのファイルと突き合わせる・v202_smoke [K-2] の invoke の網もここを見る）。
//  保存のつなぎ（port.ts・session.ts）は変えない。断る値のうち出し入れで足したもの（IO_REFUSALS）はここに持つ。
// ★JS が Rust へ渡すのは、一時の場所の名札（16 桁の 16 進）とライブラリの作品の名前だけ。パスは渡さない・受け取らない（IO25）。
// ★大きいバイト列を IPC で数の配列にしない（V169・V212）: 書き出しは 4MiB 以下の塊で、Android は base64 の文字・iOS は生のボディ。
//  読むのも 4MiB 以下の切れ端（戻りは生のバイト列＝ArrayBuffer・Uint8Array・数の配列のどれでも asBytes で揃える）。
// ★ネイティブの画面（共有・保存・選ぶ）は、命令を送ったあと、結果が window.__mbIoDone(req, 結果) で返る（Android の MainActivity.kt）。
//  iOS は Mac の作業まで "unsupported" で断る。
// ★`@tauri-apps/api` はここでも読まない（invoke を受け取る形）。
import { asBytes, MobileRefusal, packRawBody, REFUSALS, type InvokeLike, type RefusalCode } from "./port";
import type { OutFile } from "./io/exportMobile";

/** 出し入れで足した断る値（contract.json の refusals の後ろ 5 つ） */
export const IO_REFUSALS = ["unsupported-kind", "zip-unsafe", "zip-broken", "cancelled", "busy"] as const;
export type IoRefusalCode = RefusalCode | (typeof IO_REFUSALS)[number];
export class IoRefusal extends Error {
  readonly code: IoRefusalCode;
  constructor(code: IoRefusalCode) {
    super(`refused: ${code}`);
    this.code = code;
  }
}

/** 1 回に送る・受け取る大きさ（Rust の iotmp::PIECE_MAX と同じ 4MiB） */
export const IO_PIECE = 4 * 1024 * 1024;

/** 片付けた数（types.Cleaned） */
export interface Cleaned {
  removed: number;
}
/** 選んだ・受け取ったファイル 1 つ（types.InItem）。表示名・大きさは来なければ空・実の大きさ */
export interface InItem {
  tag: string;
  name: string;
  size: number;
}
/** 見分けた種類（types.SniffedKinds） */
export type SniffedKind = "workPv6" | "workPv5" | "kwz" | "ppm" | "zip" | "png" | "jpeg" | "heic" | "mp3" | "wav" | "ogg" | "isom" | "matroska" | "unknown";
/** 見分けた結果（types.Sniffed） */
export interface Sniffed {
  tag: string;
  kind: SniffedKind;
  size: number;
  name: string;
}
/** ライブラリに写したもの（types.Placed） */
export interface Placed {
  album: string;
  name: string;
  kind: SniffedKind;
}
/** 取り込みの結果（types.ImportOutcome） */
export interface ImportOutcome {
  placed: Placed[];
  skipped: number;
  albumsCreated: string[];
}
/** 全部書き出すの進み具合（types.ExportAllStatus） */
export interface ExportAllStatus {
  state: "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  skipped: number;
  tag: string | null;
  refusal: string | null;
}
/** .kwz・.ppm の一覧の 1 件（types.LibraryNote） */
export interface LibraryNote {
  album: string;
  name: string;
  size: number;
  sortedAt: number;
}
/** 選ぶもの（kind） */
export type PickKind = "works" | "image" | "audio" | "photo";

/** 決まった値の断りは IoRefusal に */
async function call<T>(p: Promise<unknown>): Promise<T> {
  try {
    return (await p) as T;
  } catch (e) {
    if (typeof e === "string" && ((REFUSALS as readonly string[]).includes(e) || (IO_REFUSALS as readonly string[]).includes(e))) throw new IoRefusal(e as IoRefusalCode);
    if (e instanceof MobileRefusal) throw new IoRefusal(e.code);
    throw e;
  }
}

/** base64（大きい塊は 32KiB ずつ文字に） */
function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/** ネイティブの画面の結果を待つ（window.__mbIoDone(req, 結果の JSON か文字)） */
type Pending = { resolve: (v: unknown) => void };
const pending = new Map<string, Pending>();
let reqSeq = 0;
function installDone(): void {
  const w = globalThis as unknown as { __mbIoDone?: (req: string, result: unknown) => void };
  if (w.__mbIoDone) return;
  w.__mbIoDone = (req, result) => {
    const p = pending.get(req);
    if (!p) return;
    pending.delete(req);
    let v: unknown = result;
    if (typeof result === "string") {
      try {
        v = JSON.parse(result);
      } catch {
        v = result;
      }
    }
    p.resolve(v);
  };
}
function nextReq(): string {
  reqSeq = (reqSeq + 1) % 1_000_000;
  return `r${Date.now().toString(36)}-${reqSeq}`;
}

export interface IoPort {
  cleanup(startup: boolean): Promise<Cleaned>;
  /** 書き出しを始める（`name` は終えたときのファイル名の土台＝作品名） */
  beginOut(ext: string, name: string): Promise<OutFile>;
  /** ライブラリの作品を一時の場所へ写す（.memoanima を渡す）。名札を返す */
  outWork(album: string, name: string): Promise<string>;
  /** 共有（Android）。共有を開けたら "shared"（共有したかは Android では分からない） */
  share(tag: string): Promise<"shared" | "failed">;
  /** 保存（Android の ACTION_CREATE_DOCUMENT）。"saved"・"cancelled"・"failed" */
  saveAs(tag: string): Promise<"saved" | "cancelled" | "failed">;
  /** 選ぶ（Android の ACTION_OPEN_DOCUMENT・PickVisualMedia）。やめたら [] */
  pick(kind: PickKind, multiple: boolean): Promise<InItem[]>;
  /** 受け取ったもの（共有・このアプリで開く）。1 回の受け取りは 1 回だけ返る */
  received(): Promise<InItem[]>;
  sniff(tag: string): Promise<Sniffed>;
  importTo(tag: string, album: string, fallback: string): Promise<ImportOutcome>;
  /** 画面が中身を読む（画像・音・作品をすぐ開く）。全部を 4MiB 以下の切れ端で */
  readAll(tag: string, size: number): Promise<Uint8Array>;
  discard(tag: string): Promise<void>;
  exportAllBegin(name: string): Promise<string>;
  exportAllStatus(job: string): Promise<ExportAllStatus>;
  exportAllCancel(job: string): Promise<void>;
  libraryNotes(): Promise<LibraryNote[]>;
}

/** ★出し入れの口。`platform` は書き出しの塊の送り方（Android は base64・iOS は生のボディ） */
export function makeIoPort(invoke: InvokeLike, platform: "android" | "ios"): IoPort {
  installDone();
  const native = <T>(send: (req: string) => Promise<unknown>): Promise<T> => {
    const req = nextReq();
    return new Promise<T>((resolve, reject) => {
      pending.set(req, { resolve: resolve as (v: unknown) => void });
      call<null>(send(req)).catch((e) => {
        pending.delete(req);
        reject(e);
      });
    });
  };
  return {
    cleanup: (startup) => call<Cleaned>(invoke("mobile_io_cleanup", { args: { startup } })),
    beginOut: async (ext, name) => {
      const tag = await call<string>(invoke("mobile_out_begin", { args: { ext } }));
      return {
        tag,
        write: async (position: number, bytes: Uint8Array) => {
          for (let off = 0; off < bytes.length; off += IO_PIECE) {
            const part = bytes.subarray(off, Math.min(bytes.length, off + IO_PIECE));
            if (platform === "android") await call<null>(invoke("mobile_out_write", { args: { tag, position: position + off, data: toBase64(part) } }));
            else await call<null>(invoke("mobile_out_write_raw", packRawBody({ tag, position: position + off }, [part])));
          }
        },
        finish: () => call<number>(invoke("mobile_out_finish", { args: { tag, name } })),
        abort: async () => void (await call<null>(invoke("mobile_out_abort", { args: { tag } }))),
      };
    },
    outWork: (album, name) => call<string>(invoke("mobile_out_work", { args: { album, name } })),
    share: (tag) => native<"shared" | "failed">((req) => invoke("mobile_out_share", { args: { tag, req } })),
    saveAs: (tag) => native<"saved" | "cancelled" | "failed">((req) => invoke("mobile_out_save", { args: { tag, req } })),
    pick: (kind, multiple) => native<InItem[]>((req) => invoke("mobile_in_pick", { args: { kind, multiple, req } })),
    received: () => call<InItem[]>(invoke("mobile_in_received")),
    sniff: (tag) => call<Sniffed>(invoke("mobile_in_sniff", { args: { tag } })),
    importTo: (tag, album, fallback) => call<ImportOutcome>(invoke("mobile_in_import", { args: { tag, album, fallback } })),
    readAll: async (tag, size) => {
      const out = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += IO_PIECE) {
        const len = Math.min(IO_PIECE, size - offset);
        const b = asBytes(await call<ArrayBuffer>(invoke("mobile_in_read", { args: { tag, offset, len } })));
        if (b.length !== len) throw new IoRefusal("io");
        out.set(b, offset);
      }
      return out;
    },
    discard: async (tag) => void (await call<null>(invoke("mobile_in_discard", { args: { tag } }))),
    exportAllBegin: (name) => call<string>(invoke("mobile_export_all_begin", { args: { name } })),
    exportAllStatus: (job) => call<ExportAllStatus>(invoke("mobile_export_all_status", { args: { job } })),
    exportAllCancel: async (job) => void (await call<null>(invoke("mobile_export_all_cancel", { args: { job } }))),
    libraryNotes: () => call<LibraryNote[]>(invoke("mobile_library_notes")),
  };
}

/** 全部書き出すの zip の名前（「メモアニマ_全作品_2026-11-17」の形。前半は画面の辞書の字・日付は端末の日付） */
export function exportAllName(prefix: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
