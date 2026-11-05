// V202 (M-1a・要件 docs/REQ_mobile_m1_base.md §4-5): モバイルだけの Rust の命令を呼ぶ**薄い口**。
//
// ★`@tauri-apps/api` はここでも読まない（invoke を受け取る形＝`makeMobilePort(invoke)`）。本物の invoke を渡すのは `tauriPort.ts` の
//  1 か所だけ。検査（scripts/v202_smoke.ts）は、本物の Rust の関数につながる検査用の実行ファイルへ送る invoke を渡す（偽の Rust だけで
//  緑にしない）
// ★命令の名前・引数の欄・封筒の印の欄・戻り値の型・断る値は `contract.json`（JS と Rust の 1 か所の表）と同じ。v202_smoke [K-2] が
//  この字を構文木で表と突き合わせる（片側だけ変えると赤）
// ★作品のバイト列は数の配列で渡さない（V169）: 書く命令は PC の save_project_raw と同じ生のボディの封筒、読む命令は生のバイト列
//  （P-3 の封筒）で受けて `readAutosaveEnvelope` で分ける（写さない）
// ★画面の文言は持たない（断りは決まった値 `MobileRefusal.code` で上へ。文は M-2 で辞書に足す）。DOM を読まない
import { readAutosaveEnvelope } from "../editor/saveCore";

/** Tauri の `invoke` と同じ形（検査は本物の Rust へ送る口を渡す） */
export type InvokeLike = (cmd: string, args?: Record<string, unknown> | Uint8Array) => Promise<unknown>;

/** 指紋＝ファイルの中身の SHA-256（小文字の hex 64 字）と大きさ（contract.json の types.Fingerprint） */
export interface Fingerprint {
  sha256: string;
  size: number;
}

/** 保存の結果（contract.json の types.SaveResult） */
export interface SaveResult {
  fingerprint: Fingerprint;
  album: string;
  name: string;
  oursMoved: boolean;
  keptCopies: string[];
  recordLeft: boolean;
}

/** 見つけた作品（types.FoundWork） */
export interface FoundWork {
  album: string;
  name: string;
  idMatch: boolean;
  fingerprintMatch: boolean;
}

export type ResumeOutcome = "restored" | "backup" | "copy" | "dropped" | "waiting";

/** 再開の結果の 1 件（types.ResumeItem） */
export interface ResumeItem {
  album: string;
  name: string;
  outcome: ResumeOutcome;
}

/** 作品の置き場（types.WorkPlace） */
export interface WorkPlace {
  album: string;
  name: string;
}

/** アルバム（types.AlbumPlace） */
export interface AlbumPlace {
  album: string;
}

/** 空き容量（types.FreeSpace） */
export interface FreeSpace {
  available: number;
  total: number;
}

/** ライブラリを作り終えたか（types.LibraryInit・V211）。steps＝この回にしたこと（"library"・"album"・"index"・"mark"）・ready＝作り終えた印がある */
export interface LibraryInit {
  steps: string[];
  ready: boolean;
}

/** 開いた作品ごとのオートセーブの一覧の 1 件（types.SessionEntry） */
export interface SessionEntry {
  session: string;
  meta: Record<string, unknown>;
  from: "body" | "bak";
}

/** 読んだ作品（封筒の頭 types.WorkHead＋実のファイル名＋作品のバイト列＝写さないビュー） */
export interface ReadWork {
  data: Uint8Array;
  fingerprint: Fingerprint;
  album: string;
  name: string;
}

/** 読んだオートセーブ */
export interface SessionRead {
  session: string;
  meta: Record<string, unknown>;
  data: Uint8Array;
}

/** 想定内の断り（contract.json の refusals と同じ並び） */
export const REFUSALS = [
  "bad-request",
  "bad-name",
  "name-too-long",
  "name-taken",
  "album-missing",
  "target-missing",
  "fingerprint-mismatch",
  "pending-record",
  "stale-generation",
  "bad-session",
  "too-large",
  "cross-volume",
  "no-space",
  "cannot-place",
  "verify-failed",
  "outside",
  "unsupported",
  "io",
] as const;
export type RefusalCode = (typeof REFUSALS)[number];

/** Rust が決まった値で断った（文は持たない） */
export class MobileRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode) {
    super(`refused: ${code}`);
    this.code = code;
  }
}

export function isRefusal(e: unknown, code?: RefusalCode): e is MobileRefusal {
  return e instanceof MobileRefusal && (code === undefined || e.code === code);
}

/** invoke の失敗を、決まった値なら MobileRefusal に（それ以外はそのまま） */
function asRefusal(e: unknown): unknown {
  if (typeof e === "string" && (REFUSALS as readonly string[]).includes(e)) return new MobileRefusal(e as RefusalCode);
  return e;
}

async function call<T>(p: Promise<unknown>): Promise<T> {
  try {
    return (await p) as T;
  } catch (e) {
    throw asRefusal(e);
  }
}

/** ★生のボディの封筒（PC の save_project_raw と同じ並び: [u32 LE 印の長さ][印の JSON]（[u32 LE 長さ][中身]）× n）。
 *  見本は contract.json の saveBody（Rust の parse_save_envelope が同じ見本を読む） */
export function packRawBody(meta: Record<string, unknown>, parts: Uint8Array[]): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  for (const p of [metaBytes, ...parts]) if (p.length > 0xffffffff) throw new MobileRefusal("bad-request");
  let total = 4 + metaBytes.length;
  for (const p of parts) total += 4 + p.length;
  const body = new Uint8Array(total);
  const dv = new DataView(body.buffer);
  let o = 0;
  dv.setUint32(o, metaBytes.length, true);
  o += 4;
  body.set(metaBytes, o);
  o += metaBytes.length;
  for (const p of parts) {
    dv.setUint32(o, p.length, true);
    o += 4;
    body.set(p, o);
    o += p.length;
  }
  return body;
}

/** 部品から見た命令（名前は contract.json の commands と 1 対 1） */
export interface MobilePort {
  saveNew(w: { album: string; name: string; selfName: string | null; data: Uint8Array; thumb: Uint8Array }): Promise<SaveResult>;
  saveOverwrite(w: { album: string; name: string; sourceFingerprint: Fingerprint; data: Uint8Array; thumb: Uint8Array }): Promise<SaveResult>;
  readWork(album: string, name: string): Promise<ReadWork>;
  findWorks(q: { workId: string | null; fingerprint: Fingerprint | null }): Promise<FoundWork[]>;
  resume(): Promise<ResumeItem[]>;
  renameWork(album: string, name: string, newName: string): Promise<WorkPlace>;
  moveWork(album: string, name: string, destAlbum: string): Promise<WorkPlace>;
  createAlbum(name: string): Promise<AlbumPlace>;
  renameAlbum(album: string, newName: string): Promise<AlbumPlace>;
  freeSpace(): Promise<FreeSpace>;
  libraryRoot(): Promise<string>;
  autosaveNextGen(): Promise<number>;
  autosaveWrite(session: string, gen: number, meta: Record<string, unknown>, data: Uint8Array): Promise<void>;
  autosaveList(): Promise<SessionEntry[]>;
  autosaveRead(session: string): Promise<SessionRead | null>;
  autosaveDelete(session: string, gen: number): Promise<void>;
  autosaveClaim(session: string, gen: number): Promise<void>;
  libraryInit(album: string): Promise<LibraryInit>;
}

/** ★薄い口。`invoke` は Tauri の本物（tauriPort.ts）か、検査が本物の Rust へつなぐもの */
export function makeMobilePort(invoke: InvokeLike): MobilePort {
  return {
    saveNew: (w) =>
      call<SaveResult>(invoke("mobile_save_new", packRawBody({ album: w.album, name: w.name, selfName: w.selfName }, [w.data, w.thumb]))),
    saveOverwrite: (w) =>
      call<SaveResult>(
        invoke("mobile_save_overwrite", packRawBody({ album: w.album, name: w.name, sourceFingerprint: w.sourceFingerprint }, [w.data, w.thumb]))
      ),
    readWork: async (album, name) => {
      const raw = await call<ArrayBuffer>(invoke("mobile_read_work", { args: { album, name } }));
      const env = readAutosaveEnvelope(raw);
      if (!env) throw new MobileRefusal("io");
      return { data: env.data, fingerprint: env.meta.fingerprint as Fingerprint, album: String(env.meta.album), name: env.path };
    },
    findWorks: (q) => call<FoundWork[]>(invoke("mobile_find_works", { args: { workId: q.workId, fingerprint: q.fingerprint } })),
    resume: () => call<ResumeItem[]>(invoke("mobile_resume")),
    renameWork: (album, name, newName) => call<WorkPlace>(invoke("mobile_rename_work", { args: { album, name, newName } })),
    moveWork: (album, name, destAlbum) => call<WorkPlace>(invoke("mobile_move_work", { args: { album, name, destAlbum } })),
    createAlbum: (name) => call<AlbumPlace>(invoke("mobile_create_album", { args: { name } })),
    renameAlbum: (album, newName) => call<AlbumPlace>(invoke("mobile_rename_album", { args: { album, newName } })),
    freeSpace: () => call<FreeSpace>(invoke("mobile_free_space")),
    libraryRoot: () => call<string>(invoke("mobile_library_root")),
    autosaveNextGen: () => call<number>(invoke("mobile_autosave_next_gen")),
    autosaveWrite: async (session, gen, meta, data) => {
      await call<null>(invoke("mobile_autosave_write", packRawBody({ session, gen, meta }, [data])));
    },
    autosaveList: () => call<SessionEntry[]>(invoke("mobile_autosave_list")),
    autosaveRead: async (session) => {
      const raw = await call<ArrayBuffer>(invoke("mobile_autosave_read", { args: { session } }));
      const env = readAutosaveEnvelope(raw);
      return env ? { session: env.path, meta: env.meta, data: env.data } : null;
    },
    autosaveDelete: async (session, gen) => {
      await call<null>(invoke("mobile_autosave_delete", { args: { session, gen } }));
    },
    autosaveClaim: async (session, gen) => {
      await call<null>(invoke("mobile_autosave_claim", { args: { session, gen } }));
    },
    libraryInit: (album) => call<LibraryInit>(invoke("mobile_library_init", { args: { album } })),
  };
}
