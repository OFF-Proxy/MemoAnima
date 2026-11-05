// V201 (M-1a・要件 docs/REQ_mobile_m1_base.md §4-1): 作品の保存とオートセーブの手順のうち、**編集画面に依らない所**の部品。
//
// ★ここに置くもの（PC の編集画面・まとめ変換・これからのモバイルの入口が同じものを通る）
//   - 保存の前に作品へ書く値を決める**ただ 1 か所**（`stampForSave`）: サムネのコマ・題名（V199 A-106 の決まり）
//   - 保存の手順（`saveWork`）: 見積り → 書く値をそろえる → 基準点 → 写し（PV6 にする）→ サムネ → 書く →
//     読み戻して確かめる → 保存の途中で描き足されたかの判断（確定して dirty を下ろすか・残すか・どちらの知らせか）
//   - オートセーブの手順（`autosaveWork`）: PV6 にする（譲りと中断つき）→ 確かめる → 書く
//   - まとめ変換が新しい作品のバイト列を作る道（`buildNewWorkBytes`）
// ★ここに置かないもの（呼び出し側が口で渡す）
//   - 書く道（Tauri の命令）・読み戻す道・サムネを描く道・眠らせの待ち・画面の段の表示・トースト・dirty の持ち方
//   - PC の編集画面は今の `EditorCallbacks` の実装を渡す。検査（Node）は記録する偽の口を渡す
// ★約束
//   - DOM（document・window）を読まない。`@tauri-apps/*` を import しない。編集画面（editor.ts）・main.ts・library.ts を
//     たどれる import を持たない（v201_smoke [C-1] が構文木で静的・動的の両方を見張る）
//   - 基準点から写し（`encode` の口の呼び出し＝PC では Worker への postMessage の structured clone）までに
//     await を置かない・動的 import も置かない（v201_smoke [C-3] が構文木で見る＝v161 検査5 の引き継ぎ）
//   - 画面の文言は持たない（知らせの種類だけを返す）
import { encodePV6 } from "./pv6";
import { verifySavedBytes } from "./serialize";
import { savedFileBase } from "./workTitle";
import type { Project } from "./model";

/** 保存の種類（呼び出し側が明示で渡す。V202 で書く道が種類ごとに分かれる＝初めては置き換えない置き方・上書きは指紋で確かめる） */
export type SaveKind = "first" | "overwrite" | "saveAs";

// ================= 作品の ID と版（P-1・要件 §4-2・決-1） =================
//
// ★作品のファイルの中（`meta.workId`・`meta.rev`）に書く。`ProjectMeta` の型には足さない（model.ts は変えない）。
//  読み手と書き手（serialize.ts・pv6.ts）は meta をそのまま通すので、PROJECT_VERSION を上げずに足せる（thumbFrame と同じ足し方）。
//  いま出回っている版（v1.9.5 まで）で開いて保存しても残る（v201_smoke [A2]）。
// ★ID は UUID の第 4 版（乱数）。`crypto.getRandomValues` で作る（randomUUID は安全なコンテキストでないと無い）。
// ★版は v2.0.0 から数えた保存の回数。書く版は手元の版＋1。保存に失敗した分、番号が飛ぶのはよい。
//  JS で正確に数えられる上限（Number.MAX_SAFE_INTEGER）に着いたら、それより上げない（自分で書いた版が次に「崩れた値」と
//  読まれて 1 に戻らないように。普通の保存では着かない＝作られた値だけ。独立レビューの指摘 R3）
// ★形が崩れた値（UUID の形でない・正の整数でない）は無いものとして扱う（ID は作り直す・版は 0 から）。ID を作り直すときは版も 0 から。
// ★ID と版は作品を見分けるためのもので、上書きの確かめには使わない（それは保存元の指紋＝V202）。
// ★この部品の外で meta.workId・meta.rev に書かない（v201_smoke [F-1] が構文木で見張る）

/** UUID の形（小文字・8-4-4-4-12・版 1〜8・変種 10xx）。nil や max は通さない */
const WORK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** meta を形の決まりの無い JSON として読む（型は足さない＝ここだけで形を確かめる） */
function metaRecord(p: Project): Record<string, unknown> {
  return p.meta as unknown as Record<string, unknown>;
}

/** 正しい作品の ID か（UUID の形） */
export function isWorkId(v: unknown): v is string {
  return typeof v === "string" && WORK_ID_RE.test(v);
}

/** 正しい版か（正の整数） */
export function isRev(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

/** 作品の ID。無い・形が崩れていれば null */
export function readWorkId(p: Project): string | null {
  const v = metaRecord(p).workId;
  return isWorkId(v) ? v : null;
}

/** 作品の版。無い・形が崩れていれば 0。ID が無い・崩れているときも 0（ID を作り直すときは版も 0 から） */
export function readRev(p: Project): number {
  const m = metaRecord(p);
  return isWorkId(m.workId) && isRev(m.rev) ? m.rev : 0;
}

/** UUID の第 4 版を作る。`crypto.getRandomValues` だけを使う（安全なコンテキストでない WebView でも動く） */
export function newWorkId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // 版 4
  b[8] = (b[8] & 0x3f) | 0x80; // 変種 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 新しい ID を入れ、版を 0 からにする（版のキーを消す） */
function assignWorkId(p: Project): string {
  const m = metaRecord(p);
  const id = newWorkId();
  m.workId = id;
  delete m.rev;
  return id;
}

/** ID が無ければ（形が崩れていれば）メモリの中で作る。作ったときは版も 0 から。**開いただけではファイルを変えない**。
 *  新規メモ・3DS の作品・ID の無い作品（v1.9.5 までに保存したもの）は、最初のオートセーブか保存の前にここを通る */
export function ensureWorkId(p: Project): string {
  return readWorkId(p) ?? assignWorkId(p);
}

/** ★別名で保存: 保存先が新しくなった時点で新しい ID を入れる（版は 0 から＝次に書くと 1）。
 *  **今ある正しい ID を別のものに替えるのはここだけ**（呼ぶのは明示の「別名で保存」だけ） */
export function bindNewWorkId(p: Project): string {
  return assignWorkId(p);
}

// ================= 保存の前に作品へ書く値（漏斗） =================

/** 保存の前に作品へ書いた値（書けなかったとき、題名がまだこの値なら、保存に入ったときの題名へ戻す＝saveWork） */
export interface SaveStamp {
  titleSet: string;
}

/** ★保存の前に作品へ書く値を決める**ただ 1 か所**。手動の保存（初めて・上書き・別名）とまとめ変換がここを通る。
 *  - サムネのコマ＝いま開いているコマ（M10-14: 手動の保存のときだけ更新。オートセーブは通らない）
 *  - 作品の中の題名＝**これから書くファイルの名前**（V199 A-106・`savedFileBase` は Rust の保存と同じ決め方）
 *  - 作品の ID（無ければ作る）と版（手元の版＋1。書けなかったら戻さない＝番号が飛ぶ）（V201 P-1）
 *  ここに足すものが増えたら、まとめ変換（`buildNewWorkBytes`）にも同じ値が入る（同じ関数を呼ぶので） */
export function stampForSave(p: Project, o: { baseName: string; frameIndex: number }): SaveStamp {
  p.thumbFrame = Math.max(0, Math.min(p.frames.length - 1, o.frameIndex));
  const titleSet = savedFileBase(o.baseName);
  p.meta.title = titleSet;
  ensureWorkId(p);
  metaRecord(p).rev = Math.min(readRev(p) + 1, Number.MAX_SAFE_INTEGER);
  return { titleSet };
}

// ================= 保存 =================

/** 書く口へ渡すもの（1 つのまとまり。V202 で上書きの指紋などを足せる） */
export interface SaveWriteRequest {
  kind: SaveKind;
  /** 保存先の名前（拡張子なし・`stampForSave` に渡したもの） */
  baseName: string;
  data: Uint8Array;
  thumb: Uint8Array;
}

/** 書く口が返すもの（1 つのまとまり。PC は書いたファイルのパス＝`save_project_raw` の戻り値） */
export interface SaveWriteResult {
  path: string;
}

export interface SaveWorkDeps<R extends SaveWriteResult = SaveWriteResult> {
  project: Project;
  kind: SaveKind;
  baseName: string;
  /** いま開いているコマ（サムネのコマになる）。**見積りを待ったあと**に呼ぶ（待っている間にコマを移ったら、移った先のコマ＝
   *  V201 の前と同じ。独立レビューの指摘で値から口に直した） */
  currentFrame: () => number;
  /** 写す前の見積り（V168: 大きければ掃除を待ち、それでも大きければ断る）。false＝断った（知らせは呼び出し側が済ませている）。
   *  **基準点より前**に待つ（基準点 → 写しの間には待ちを置かない） */
  prepare?: () => Promise<boolean>;
  /** 基準点で呼ぶ。返した関数が「基準点のあとに編集があったか」を答える（PC の編集画面は editEpoch で答える） */
  markEdits: () => () => boolean;
  /** 写して PV6 にする口。**呼んだその場で写しを取る**こと（PC は Worker への postMessage＝structured clone）。
   *  返す Promise は PV6 のバイト列（返せなかったら null） */
  encode: (p: Project) => Promise<Uint8Array | null>;
  /** 写しを取った直後（PC はピルの段を「保存中」へ） */
  afterSnapshot?: () => void;
  /** サムネ（PNG）。写しの**後**に、いまの作品から描く */
  thumb: (p: Project) => Promise<Uint8Array>;
  /** 書く口。V202: 戻りは `SaveWriteResult` を広げた形でよい（モバイルは書いた中身の指紋と置いた先を足す＝型だけの欄。PC は今のまま） */
  write: (w: SaveWriteRequest) => Promise<R>;
  /** 書いたものを読み戻す口（無ければ確かめを省く。null＝読めなかったので省く。throw＝確かめられなかったので省く） */
  readBack?: (r: R) => Promise<Uint8Array | null>;
  /** 書けて確かめも通った直後（PC は保存先を選ばせる印を下ろし、左上の名前を書いたファイルの名前に） */
  onCommitted?: (r: R) => void;
  /** 基準点のあとに編集が無かったとき（＝ファイルが最新）。PC は dirty を下ろし、オートセーブの世代を進めてから消す */
  onSettled?: () => Promise<void>;
  log?: (line: string) => void;
}

export type SaveWorkResult<R extends SaveWriteResult = SaveWriteResult> =
  /** 写す前の見積りで断った（作品は変えていない） */
  | { ok: false; stage: "refused" }
  /** 写しが返らなかった・読み戻したものが開けなかった。書く値（題名）は戻してある */
  | { ok: false; stage: "encode" | "read-back"; reason: string }
  | {
      ok: true;
      written: R;
      /** 基準点のコマ数 */
      frames: number;
      /** 基準点のあとに編集が無かった＝確定した（onSettled を呼んだ） */
      settled: boolean;
      /** 出す知らせの種類（saved＝いまの絵まで保存した／savedPartial＝保存の途中で描いた分はまだ保存していない） */
      notice: "saved" | "savedPartial";
    };

/** ★保存の手順（V161 の背景保存・V168 の見積り・V199 の題名・V154 の読み戻し）。
 *  口から投げられた例外はそのまま上へ（呼び出し側が「保存できなかった」を知らせる）。書けなかったら題名は元へ戻す。 */
export async function saveWork<R extends SaveWriteResult = SaveWriteResult>(d: SaveWorkDeps<R>): Promise<SaveWorkResult<R>> {
  const p = d.project;
  // V199 (A-106): 保存に失敗したら、そろえた題名を元へ戻す（ファイルの無い名前を残さない＝新しいメモの左上・オートセーブの知らせ）。
  //  戻す先は**保存に入ったとき**の題名（見積りを待つ前。V201 の前と同じ。独立レビューの指摘）
  const titleAtEntry = p.meta.title;
  let stamp: SaveStamp | null = null;
  let committed = false;
  try {
    // ★V168 (S-1〜S-3): **写す前に見積もり、大きければ掃除を待ち、それでも大きければ断る。**
    //  ここは**基準点より前**（基準点 → 写しに await を挟まない約束は破らない）
    if (d.prepare && !(await d.prepare())) return { ok: false, stage: "refused" };
    // ★保存の前に作品へ書く値（ただ 1 か所＝stampForSave）
    stamp = stampForSave(p, { baseName: d.baseName, frameIndex: d.currentFrame() });
    // ★スナップショットの基準点。「保存に入るのはこの瞬間まで」をここで取る。
    //  ここから写し（encode の口）まで **await は 1 つも無い**（v201_smoke [C-3] が構文木で固定）
    const expectFrames = p.frames.length;
    const edited = d.markEdits();
    const encoded = d.encode(p);
    // 拒否がサムネの await 中に起きても unhandledrejection にしない（実際の失敗は下の await が伝える）
    void encoded.catch(() => {});
    // ---- ここから編集は自由（写しは取ってある） ----
    d.afterSnapshot?.();
    // サムネは写しの直後に読む（1 コマの合成。スナップショットとほぼ同時点＝その一瞬に描かれた線が
    // サムネだけに写る理屈上の窓はあるが、絵のデータには影響しない）
    const thumb = await d.thumb(p);
    const bytes = await encoded;
    if (!bytes) return { ok: false, stage: "encode", reason: "worker returned no bytes" };
    const written = await d.write({ kind: d.kind, baseName: d.baseName, data: bytes, thumb });
    // V154 (W-6) → V161 (C): 検証は**ディスクから読み戻す側だけ**（書く前の重複は落とした）。
    // 壊れたものを書いてしまう危険は Rust の byte 照合（verify_or_rollback・W-1）が塞いでいて、
    // ここは「書けたものがアプリで開けるか」を確かめる最後の門
    const post = await verifyWritten(d, written, expectFrames);
    if (!post.ok) return { ok: false, stage: "read-back", reason: post.reason };
    committed = true;
    d.onCommitted?.(written);
    const settled = !edited();
    if (settled) {
      // 保存中に編集が無かった＝ファイルは最新。確定する（PC: dirty を下ろし、古いオートセーブが保存後に復活しないよう
      // 世代を進めてから消す）
      await d.onSettled?.();
    }
    // else: 保存中に描いた＝ファイルはスナップショット時点の姿。dirty は残し、オートセーブにも触らない
    // （あちらのほうが新しい状態を守っている。次の 15 秒周期が最新の姿で上書きする）
    // 独立レビューの指摘③（V161）: 保存中に描いた人が「いまの絵まで保存された」と誤解しないよう、知らせを分ける
    // （確定のあと＝オートセーブを消している間に描いた分も「まだ保存していない」の側に入る）
    return { ok: true, written, frames: expectFrames, settled, notice: edited() ? "savedPartial" : "saved" };
  } finally {
    // V199 (A-106): 書けなかったら題名を戻す（その間にほかで書き換わっていたら触らない）
    if (!committed && stamp !== null && p.meta.title === stamp.titleSet) p.meta.title = titleAtEntry;
  }
}

/** V154 (W-6): 保存したファイルを読み戻して中身を確かめる。
 *
 *  読み戻せないとき（口が無い・巨大すぎて読めない）は**検査を省いて通す**。
 *  ここで落とすと、確かめる手段が無いだけの人が保存できなくなるため。
 *  その場合も Rust 側のバイト照合は効いている。 */
async function verifyWritten<R extends SaveWriteResult>(
  d: SaveWorkDeps<R>,
  written: R,
  expectFrames: number
): Promise<{ ok: boolean; reason: string }> {
  if (!d.readBack) return { ok: true, reason: "" };
  let bytes: Uint8Array | null = null;
  try {
    bytes = await d.readBack(written);
  } catch (e) {
    // 読み出しそのものが失敗＝**確かめられなかった**だけ。保存は成功している可能性が高い
    d.log?.(`[V154 W-6] read-back-unavailable (check skipped): ${String(e)}`);
    return { ok: true, reason: "" };
  }
  if (!bytes) return { ok: true, reason: "" };
  const r = await verifySavedBytes(bytes, expectFrames);
  return { ok: r.ok, reason: r.reason };
}

// ================= 写しを取る口（encode） =================

/** Worker のうち、ここで使う所だけ（DOM の型に頼らない） */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", fn: (ev: { message: string }) => void): void;
  removeEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "error", fn: (ev: { message: string }) => void): void;
}

/** V161 (A): 保存の Worker（`saveWorker.ts`）で PV6 にする。**呼んだその場で** postMessage する（structured clone が写しを取る）。
 *
 *  ★postMessage は**同期的に**全体を写し取るので、それ以後の編集はこの保存に混ざらない
 *  （V160 S-2 で実証: 眠り控えの z は生成後不変・破棄は参照の付け替えなので clone は安全。
 *   起きている生バッファと音声データは clone がコピーする）。
 *  ★リスナーは **postMessage より先に**張る。あとから張ると、小さい作品では Worker のエンコードが
 *   サムネの await より先に終わり、`done` が**誰も聞いていないうちに**発火して保存が永遠に待ち続ける
 *  （ハーネスの故意破損テストで実際に踏んだ——大きい作品では出ない競合）。 */
export function encodeViaWorker(worker: WorkerLike, seq: number, project: Project): Promise<Uint8Array | null> {
  const encodedPromise = new Promise<Uint8Array | null>((resolve, reject) => {
    const onMsg = (ev: { data: unknown }) => {
      const d = ev.data as
        | { kind: "done"; seq: number; bytes?: Uint8Array }
        | { kind: "error"; seq: number; message: string };
      if (!d || d.seq !== seq) return;
      if (d.kind === "done") {
        cleanup();
        resolve(d.bytes ?? null);
      } else {
        cleanup();
        reject(new Error(d.message));
      }
    };
    const onErr = (ev: { message: string }) => {
      cleanup();
      reject(new Error(`worker error: ${ev.message}`));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
    };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onErr);
  });
  // 拒否を誰も受け取らないまま残さない（postMessage がその場で投げた〔写しのメモリ不足など〕あとに Worker の error が来ても
  // 未処理の拒否にしない＝V201 の前と同じく postMessage より前に付ける。実際の失敗は呼び出し側の await が受け取る。第三者レビューの L1）
  void encodedPromise.catch(() => {});
  // V197 (A-103): 形式は送らない＝Worker はいつも PV6 で書く（v197_smoke [B-3][B-5] が固定）
  worker.postMessage({
    kind: "encode",
    seq,
    project,
  });
  return encodedPromise;
}

/** Worker を使わない所（検査・Worker の無い入口）: その場で写してから PV6 にする。
 *  写しは `structuredClone`＝postMessage と同じ写し方（呼んだその場で取る） */
export function encodeOnThisThread(project: Project): Promise<Uint8Array | null> {
  const snap = structuredClone(project);
  return encodePV6(snap).then((r) => r?.bytes ?? null);
}

// ================= オートセーブ =================

/** オートセーブの書く口へ渡すもの（1 つのまとまり。V202 でセッションの番号と世代を足せる） */
export interface AutosaveWriteRequest {
  data: Uint8Array;
  /** AMAS1 の中の印（PC は題名・保存先など。形の決まりの無い JSON） */
  meta: Record<string, unknown>;
}

export interface AutosaveDeps {
  project: Project;
  /** PV6 にする間、入力へ譲る口（PC は scheduler.yield／MessageChannel） */
  yieldNow?: () => Promise<void>;
  /** PV6 にしている間に編集が始まった等で、途中で捨てるか。**呼ぶ前に基準（履歴の数など）を取っておく**こと */
  aborted: () => boolean;
  /** 書く直前に、この便がまだ有効か（PC は画面を離れていない・保存や破棄で世代が進んでいない） */
  stillCurrent: () => boolean;
  /** 書く直前に作る印（書いた時刻などを含む＝呼んだときの値） */
  meta: () => Record<string, unknown>;
  write: (w: AutosaveWriteRequest) => Promise<void>;
  log?: (line: string) => void;
}

/** aborted＝PV6 にしている途中で捨てた／stale＝世代が進んでいたので書かない／bad＝確かめに落ちたので書かない／written＝書いた */
export type AutosaveOutcome = "written" | "aborted" | "stale" | "bad";

/** ★オートセーブの手順。保存と違ってメインスレッドで PV6 にする（譲りと中断つき）。
 *  題名・サムネのコマ・版は書かない（保存の前に書く値は手動の保存だけ＝`stampForSave` を通らない）。
 *  作品の ID だけは、無ければここで作る（V201 P-1: 新規メモ・3DS の作品・ID の無い作品は最初のオートセーブで ID が付く） */
export async function autosaveWork(d: AutosaveDeps): Promise<AutosaveOutcome> {
  ensureWorkId(d.project);
  // M10-23: 大型作品でエンコードがメインスレッドを数秒塞いでいた（300ページで約2.7秒
  // →ペンの pointerdown が最大1.9秒待たされる実測）。チャンクごとに入力へ譲り、
  // エンコード中に編集が起きたら破棄して次の機会に回す（途切れたスナップショットは決して書かない）。
  // V163: オートセーブも現行形式（PV6）で書く。眠っている塊は控えをそのまま写すので、
  // 掃除の済んだ大きい作品では従来（全コマ base64+gzip）より桁違いに軽い。
  // 復元は projectFromBytes の振り分けがそのまま読む（AMAS1 の皮は従来どおり）
  const r = await encodePV6(d.project, { yieldNow: d.yieldNow, aborted: d.aborted });
  const data = r?.bytes ?? null;
  if (!data) return "aborted";
  // 直前にライブラリ保存/破棄が完了していたら、この古いスナップショットは書かない
  if (!d.stillCurrent()) return "stale";
  // V154 (W-6): **手動保存と同じ扱い**。書く前に中身を確かめ、通らなければ書かない。
  // オートセーブの上書きは1世代前を `.bak` へ退避するので、壊れたものを書くと
  // **良い世代が1つ押し出される**。書かなければ、前の世代がそのまま残る。
  // 期待コマ数は**エンコード中に構造が変わっていない**ことが `aborted` で保証されている
  const okAuto = await verifySavedBytes(data, d.project.frames.length);
  if (!okAuto.ok) {
    d.log?.(`[V154 W-6] autosave skipped (bad bytes): ${okAuto.reason}`);
    return "bad";
  }
  await d.write({ data, meta: d.meta() });
  return "written";
}

// ================= オートセーブを読む（P-3） =================

/** 起動したときの復元に使うオートセーブ（Rust の `load_autosave` が生のバイト列で返す封筒を分けたもの） */
export interface AutosaveEnvelope {
  /** AMAS1 の中の印（形の決まりの無い JSON。前の版と同じく null もあり得る） */
  meta: Record<string, unknown>;
  /** オートセーブのファイルの場所（復元の知らせに出す） */
  path: string;
  /** 作品のバイト列（**写さない**＝封筒と同じ下敷きのビュー。Rust が 8 の倍数の位置から始めている） */
  data: Uint8Array;
}

/** V201 (P-3): `load_autosave` の封筒 `[u32 LE 頭の長さ][{meta, path} の JSON][作品のバイト列]` を分ける
 *  （Rust の `pack_autosave_payload` と対）。空の本体（オートセーブが無い）・形の崩れた封筒は null */
export function readAutosaveEnvelope(raw: ArrayBuffer | Uint8Array | null | undefined): AutosaveEnvelope | null {
  if (!raw) return null;
  const b = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (b.length < 4) return null;
  const headLen = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
  if (4 + headLen > b.length) return null;
  let head: unknown;
  try {
    head = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + headLen)));
  } catch {
    return null;
  }
  if (!head || typeof head !== "object" || !("meta" in head)) return null;
  const h = head as { meta: unknown; path?: unknown };
  if (typeof h.path !== "string") return null;
  return { meta: h.meta as Record<string, unknown>, path: h.path, data: b.subarray(4 + headLen) };
}

// ================= まとめ変換（新しい作品のバイト列） =================

/** V200 (A-100) のまとめ変換が 1 件の `.memoanima` を作る（書かない）: 保存の前に書く値をそろえ（手動の保存と**同じ関数**）、
 *  PV6 にして、保存の読み戻しと同じ検査を書く前の手元のバイト列に当てる。サムネのコマは先頭（開いた直後の Ctrl+S と同じ） */
export async function buildNewWorkBytes(
  p: Project,
  baseName: string
): Promise<{ ok: true; bytes: Uint8Array; frames: number } | { ok: false; reason: string }> {
  stampForSave(p, { baseName, frameIndex: 0 });
  const frames = p.frames.length;
  const enc = await encodePV6(p);
  if (!enc) return { ok: false, reason: "encode returned nothing" };
  const check = await verifySavedBytes(enc.bytes, frames);
  if (!check.ok) return { ok: false, reason: `verify ${check.reason}` };
  return { ok: true, bytes: enc.bytes, frames };
}
