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

/** V224 (M-2c): 一覧の作品 1 件（types.LibraryWork）。`name` は拡張子つき・`sortedAt` は秒・`thumb` はサムネがあるか。絶対パスは無い */
export interface LibraryWork {
  album: string;
  name: string;
  size: number;
  sortedAt: number;
  order: number;
  thumb: boolean;
}

/** V224: アルバムと作品の一覧（types.LibraryList。作品は .memoanima・.animemo だけ） */
export interface LibraryList {
  albums: string[];
  works: LibraryWork[];
}

/** V224: PV6 のヘッダだけを開いて読んだ値（types.WorkPeek。PV5 以前・読めないものは null） */
export interface WorkPeek {
  workId: string | null;
  frames: number | null;
  speedIndex: number | null;
}

/** V224: 復元の候補（types.RecoverableItem。一時ファイルは数だけ） */
export interface RecoverableItem {
  album: string;
  name: string;
  bakSize: number;
  bakAt: number;
  tmpCount: number;
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
  // V220 (M-2b-1b・決-17): 画面から書けない設定のキー（Rust が書く mobileLibraryReady・`__` で始まるもの）
  "reserved-key",
  // V224 (M-2c・L-4): アルバムを消すときの断り（作品が入っている／作品でないファイルかフォルダが入っている）
  "album-not-empty",
  "album-has-files",
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

/** V224: 生のバイト列の戻り（iOS は ArrayBuffer・Android は ArrayBuffer／Uint8Array／数の配列のどれか）を Uint8Array に揃える */
export function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new MobileRefusal("io");
}

/** V224: base64（標準の字・`=` の詰め。サムネを書く命令の引数） */
export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
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
  /**
   * V220 (M-2b-1b・決-17): 設定を読む（PC と同じ段で戻した表・壊れて既定に戻ったときは `__recovered: true` が入る＝画面の案内に使う）。
   * 置き場は Rust が決める（試験用のライブラリを開いている間は試験用の側）
   */
  settingsRead(): Promise<Record<string, unknown>>;
  /**
   * V220: 渡したキーだけを直す（Rust が読んで足して書く・渡していないキーは変えない・キーを消す口は無い）。
   * ★キーの決まり（M-2b-3 の設定の画面）: キーは足すだけ・意味を変えない／PC のキーは PC の値の形／モバイルだけは `mobile` で始める／
   *  PC が保存しないもの（ピクセル格子・筆圧で太さ・手ブレ補正）は保存しない／`hiddenConfirms` は画面の側で今の値と混ぜてから渡す。
   * 断り: `mobileLibraryReady`・`__` で始まるキー → `reserved-key`、null の値・空のキー・表でない → `bad-request`（どれもファイルに触らない）
   */
  settingsMerge(values: Record<string, unknown>): Promise<void>;
  /** V220: ログに 1 行（Rust が改行と制御文字を落とし、置き場のパスを伏せ、長さを切る）。★作品名・パス・作品の中身を渡さない（W-10） */
  logAppend(line: string): Promise<void>;
  // ---- V224 (M-2c・V211b の F2): ライブラリの命令。場所は Rust が決める（試験用のライブラリを開いている間は試験用の側）。パスを渡さない・受けない ----
  /** アルバムと作品の一覧（PC の list_albums と scan_library を Rust が決めた場所で。並べ替えは画面がする） */
  libraryList(): Promise<LibraryList>;
  /** 外（ファイル App など）で変わったかを見る印（PC の library_stamp） */
  libraryStamp(): Promise<string>;
  /** 作品の隣のサムネ（PNG の生のバイト列）。無ければ `target-missing`・4MiB を超えれば `too-large` */
  thumbRead(album: string, name: string): Promise<Uint8Array>;
  /** サムネを書く（作品があるときだけ・PNG の頭・1MiB まで） */
  thumbWrite(album: string, name: string, png: Uint8Array): Promise<void>;
  /** PV6 のヘッダだけを開いて、作品の ID・コマの数・速さ（PV5 以前は全部 null） */
  workPeek(album: string, name: string): Promise<WorkPeek>;
  /** 作品を消す（退避の記録の保全が先・片付かなければ `pending-record`。オートセーブは消さない） */
  deleteWork(album: string, name: string): Promise<void>;
  /** アルバムを消す（作品があれば `album-not-empty`・作品でないファイルかフォルダがあれば `album-has-files`） */
  deleteAlbum(album: string): Promise<void>;
  /** 復元の候補（本体が無いのに控えがある作品） */
  recoverableList(): Promise<RecoverableItem[]>;
  /** 控えから戻す（本体があれば `name-taken`・置き換えない置き方） */
  recover(album: string, name: string): Promise<WorkPlace>;
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
    settingsRead: () => call<Record<string, unknown>>(invoke("mobile_settings_read")),
    settingsMerge: async (values) => {
      await call<null>(invoke("mobile_settings_merge", { args: { values } }));
    },
    logAppend: async (line) => {
      await call<null>(invoke("mobile_log_append", { args: { line } }));
    },
    libraryList: () => call<LibraryList>(invoke("mobile_library_list")),
    libraryStamp: () => call<string>(invoke("mobile_library_stamp")),
    thumbRead: async (album, name) => asBytes(await call<unknown>(invoke("mobile_thumb_read", { args: { album, name } }))),
    thumbWrite: async (album, name, png) => {
      await call<null>(invoke("mobile_thumb_write", { args: { album, name, png: bytesToBase64(png) } }));
    },
    workPeek: (album, name) => call<WorkPeek>(invoke("mobile_work_peek", { args: { album, name } })),
    deleteWork: async (album, name) => {
      await call<null>(invoke("mobile_delete_work", { args: { album, name } }));
    },
    deleteAlbum: async (album) => {
      await call<null>(invoke("mobile_delete_album", { args: { album } }));
    },
    recoverableList: () => call<RecoverableItem[]>(invoke("mobile_recoverable_list")),
    recover: (album, name) => call<WorkPlace>(invoke("mobile_recover", { args: { album, name } })),
  };
}
