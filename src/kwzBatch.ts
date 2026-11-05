// V200 (A-100・REQ-007): アルバムの 3DS 作品（.kwz／.ppm）をまとめて .memoanima にする——決まりと段取り。
// 要件 docs/REQ_discord_tickets_1004.md §5
//
// ★手作業（ライブラリで .kwz を開いて Ctrl+S）と**同じもの**を作る。別の変換は書かない:
//   読む → importFlipnote（手作業と同じ関数・同じ題名の引数）→ 共通の部品の buildNewWorkBytes（V201: 保存の直前に
//   そろえる値＝手作業と同じ stampForSave → encodePV6〔保存の Worker が呼ぶのと同じ関数〕→ verifySavedBytes〔保存の読み戻しと同じ検査〕）
//   → サムネ（frameToPngBlob・main.ts が渡す）→ Rust の create_project
//     （名前・一時ファイル・照合・サムネは保存と同じ。違うのは「置き換えない」確定の 1 手だけ）
// ★1 件ずつ作って閉じる（全部を同時にメモリに持たない）。見積もりは全部の確保より前
//   （読む前のファイルの大きさ＝main.ts の read_file_raw の maxBytes・絵の面を確保する前の面の数＝beforeAlloc）。
// ★DOM・Tauri に触らない（Node の検査 v200_smoke が直に叩く）。画面・IPC は main.ts が deps で渡す。画面の文言は持たない

import { importFlipnote } from "./editor/kwzImport";
import { buildNewWorkBytes } from "./editor/saveCore";
import { savedFileBase } from "./editor/workTitle";
import { checkFrameAlloc, HEAVY_ALLOC_MAX_BYTES, isAllocFailure } from "./editor/prefs";
import type { Project } from "./editor/model";

/** 読む前の門番（.kwz／.ppm のファイルの大きさ）。作者のライブラリの .kwz 848 件は最大 約 4.0MB。
 *  これを超えるものは 3DS の作品としてあり得ないので、読まずに「作れなかった」にする（Rust が読む前に断る＝TOO_LARGE） */
export const NOTE_READ_MAX_BYTES = 64 * 1024 * 1024;

/** 1 件に許す絵の面の確保。エディタの重い操作 1 回ぶんと同じ（HEAVY_ALLOC_MAX_BYTES・512MiB）。
 *  .kwz の最大（999 コマ × 3 レイヤー × 76,800B）でも約 230MB なので、ふつうは当たらない */
export const NOTE_ALLOC_BUDGET = HEAVY_ALLOC_MAX_BYTES;

/** ライブラリの一覧の 1 行（main.ts / library.ts の LibraryView のうち、ここで使うところだけ） */
export interface NoteRef {
  kind: string;
  album: string;
  name: string;
  path: string;
}

/** 3DS の作品のファイル名か（.kwz／.ppm・大文字小文字は問わない） */
export function isNoteName(name: string): boolean {
  return /\.(?:kwz|ppm)$/i.test(name);
}

/** 手作業と同じ「保存に渡す名前」。main.ts の openEditorWithNote が渡す baseName（stripExt＝拡張子を 1 つ落とす）と同じ */
export function noteBaseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** できる .memoanima のファイル名（Rust の project_file_name と同じ決め方＝savedFileBase ＋ 拡張子。
 *  大文字小文字は Rust と違うことがある＝同じ回の中の重なりを見るときは小文字にして比べる） */
export function projectFileNameFor(baseName: string): string {
  return `${savedFileBase(baseName)}.memoanima`;
}

/** そのアルバムの 3DS 作品。並びは渡した一覧のまま（ライブラリの並び＝アルバム → 並び順 → 名前） */
export function batchCandidates<T extends NoteRef>(items: readonly T[], album: string): T[] {
  return items.filter((i) => i.kind === "note" && i.album === album && isNoteName(i.name));
}

export interface PlanRow<T extends NoteRef = NoteRef> {
  item: T;
  /** 保存に渡す名前（手作業の baseName と同じ） */
  baseName: string;
  /** できるファイルの名前 */
  fileName: string;
  /** 飛ばす理由: taken＝同じ名前の .memoanima がもう在る／dup＝この回の中で先の 1 件と同じ名前になる */
  skip: "taken" | "dup" | null;
}

/** @param taken 同じ名前の .memoanima がもう在るか（Rust の projects_taken・cands と同じ並び）。
 *    false と言われたもの以外は「在る」として飛ばす（数が合わないときも上書きの側に倒さない）
 *  同じ回の中で同じ名前になるもの（a.kwz と a.ppm・大文字小文字だけ違う）は**先の 1 件だけ**作り、後ろは飛ばす
 *  （手作業なら後ろが前を上書きする。まとめ変換は上書きしない） */
export function planBatch<T extends NoteRef>(cands: readonly T[], taken: readonly boolean[]): PlanRow<T>[] {
  const seen = new Set<string>();
  return cands.map((item, i) => {
    const baseName = noteBaseName(item.name);
    const fileName = projectFileNameFor(baseName);
    const key = fileName.toLowerCase();
    const skip: PlanRow["skip"] = taken[i] !== false ? "taken" : seen.has(key) ? "dup" : null;
    seen.add(key);
    return { item, baseName, fileName, skip };
  });
}

/** 確認の画面で言う件数（convert＝作る・skip＝同じ名前があるので飛ばす） */
export function planCounts(rows: readonly PlanRow[]): { total: number; convert: number; skip: number } {
  const convert = rows.filter((r) => !r.skip).length;
  return { total: rows.length, convert, skip: rows.length - convert };
}

// ★V201 (M-1a): 手作業の Ctrl+S が書く直前にそろえる値（V200 の stampAsManualSave）は、共通の部品の
//  `stampForSave`（saveCore.ts）1 か所に移した。まとめ変換は `buildNewWorkBytes` を通して**同じ関数**を呼ぶ
//  （サムネのコマ＝先頭〔開いた直後の Ctrl+S と同じ〕・題名＝これから書くファイルの名前）。

/** こちらで決めて断った理由。文は決まった英字と数字だけ（作品名・パスは入らない＝W-10） */
export class NoteBatchRefusal extends Error {}

export interface ConvertedNote {
  bytes: Uint8Array;
  thumb: Uint8Array;
  frames: number;
}

/** 1 件を、手作業で作ったのと同じ .memoanima のバイト列にする（書かない）。
 *  作品（Project）はこの関数の中だけで持つ＝返ったら誰も持っていない（1 件ずつ作って閉じる） */
export async function convertNote(
  buf: ArrayBuffer,
  row: PlanRow,
  deps: { thumb: (p: Project) => Promise<Uint8Array>; budget?: number }
): Promise<ConvertedNote> {
  const budget = deps.budget ?? NOTE_ALLOC_BUDGET;
  // 題名の引数は手作業と同じ（ファイル名のまま。meta.source.name にもこれが入る）
  const { project } = await importFlipnote(buf, row.item.name, {
    // ★絵の面を 1 枚も確保する前に見積もる（取り込みは必ず 8bit＝kwzImport.ts）
    beforeAlloc: ({ frames, layers }) => {
      const r = checkFrameAlloc(frames, layers, 8, budget);
      if (!r.ok)
        throw new NoteBatchRefusal(`too-large frames=${frames} layers=${layers} need=${r.needBytes} budget=${budget}`);
    },
  });
  // 保存の前に書く値（手動の保存と同じ stampForSave）→ PV6（encodePV6）→ 保存の読み戻し（W-6）と同じ検査を、
  // 書く前の手元のバイト列に当てる（Rust は書いたものがこれと同じかを照合する）。どれも共通の部品の中
  const built = await buildNewWorkBytes(project, row.baseName);
  if (!built.ok) throw new NoteBatchRefusal(built.reason);
  const thumb = await deps.thumb(project);
  return { bytes: built.bytes, thumb, frames: built.frames };
}

/** ログに書く理由（作品名・パスは main.ts の importLogSafe が落とす）。確保の失敗は決まった語にする */
export function failReason(e: unknown): string {
  if (isAllocFailure(e)) return "out-of-memory";
  return e instanceof Error ? e.message : String(e);
}

/** 0＝読む・1＝作る（変換と確かめ）・2＝書く（取り込みの進捗の 3 段と同じ数え方） */
export type BatchStage = 0 | 1 | 2;

export interface BatchDeps<T extends NoteRef> {
  read: (row: PlanRow<T>) => Promise<ArrayBuffer>;
  convert: (buf: ArrayBuffer, row: PlanRow<T>) => Promise<ConvertedNote>;
  /** true＝作った／false＝もう在った（確認のあとにできていた。上書きしない） */
  write: (row: PlanRow<T>, c: ConvertedNote) => Promise<boolean>;
  cancelled: () => boolean;
  progress?: (done: number, total: number, row: PlanRow<T>, stage: BatchStage) => void;
  failed?: (row: PlanRow<T>, err: unknown) => void;
  /** 1 件ごとに 1 拍譲る（画面を描かせる・中断のボタンを受ける） */
  yieldNow?: () => Promise<void>;
}

export interface BatchResult {
  created: number;
  /** 同じ名前があったので飛ばした（確認の前に分かったもの＋書くときに在ったもの） */
  skipped: number;
  failed: number;
  cancelled: boolean;
  /** 中断で作らなかった件数 */
  rest: number;
}

/** 1 件ずつ、読む → 作る → 書く。1 件が失敗しても残りは続ける（取り込みと同じ）。
 *  ★中断は**1 件の切れ目でだけ**見る＝いまの 1 件は書き終えてから止まる（作りかけを作らない・ドロップ取り込みと同じ）。
 *  ★作品は 1 件ぶんしか持たない（read の結果と convert の結果は、その周の中だけ） */
export async function runBatch<T extends NoteRef>(
  rows: readonly PlanRow<T>[],
  deps: BatchDeps<T>
): Promise<BatchResult> {
  const todo = rows.filter((r) => !r.skip);
  const res: BatchResult = { created: 0, skipped: rows.length - todo.length, failed: 0, cancelled: false, rest: 0 };
  for (let i = 0; i < todo.length; i++) {
    if (deps.cancelled()) {
      res.cancelled = true;
      res.rest = todo.length - i;
      break;
    }
    const row = todo[i];
    try {
      deps.progress?.(i, todo.length, row, 0);
      const buf = await deps.read(row);
      deps.progress?.(i, todo.length, row, 1);
      const c = await deps.convert(buf, row);
      deps.progress?.(i, todo.length, row, 2);
      if (await deps.write(row, c)) res.created++;
      else res.skipped++;
    } catch (e) {
      res.failed++;
      deps.failed?.(row, e);
    }
    await deps.yieldNow?.();
  }
  return res;
}
