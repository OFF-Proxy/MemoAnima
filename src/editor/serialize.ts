// 独自プロジェクト形式（.animemo）の入出力（M3・SPEC §13 / N-2=v2 / M6-2=v3）
// 構造: JSON（レイヤーバッファは base64） → 全体を gzip。
// - version フィールド必須・未知フィールドは無視（前方互換）
// - v2: indexBits(8|16) を追加。16bit索引は 1画素2バイトの リトルエンディアン固定 で直列化
//   （本アプリは Windows/x86 = LE 専用。TypedArray の直接バイトビュー＝LE 前提）
// - v3: audio セクション追加（単一トラック・data=base64）。v1/v2（audio無し）は audio:null で可逆
// - v4: folders＋layerDefs[].parent 追加（M3.7 レイヤーフォルダ）。旧は folders:[]・全ルートで可逆。
//   壊れた parent（存在しないid/循環）はルートへ隔離して絵は開ける
// - v5: audio を { bgm, se[] } に刷新＋frames[].se（SE配置）＋nextSeId（M5-1）。
//   v3/v4 の旧 audio（単一トラック）は bgm へ可逆マイグレーション
//   （source "kwz-original"→"kwz" / "external"→"external"・baseSpeedIndex=doc.speedIndex）。
//   壊れた bgm/se/frames[].se は sanitizeAudio で隔離して絵は必ず開ける
// - v1（indexBits無し）は 8bit として読む（完全可逆・従来と同一）
// - .kwz は入力専用（この形式でのみ保存する）

import { t } from "../i18n";
// V156 (P-1・条件3): 眠っているレイヤーを**その場で1枚だけ**展開して流すための口。
// 起こさない＝`f.layers` には入れないので、保存中に実メモリの山が立たない
import { borrowLayerBytes } from "./sleep";
import { folderBaseName, untitledTitle } from "../i18n/defaults";
import {
  Project,
  Frame,
  IndexBuf,
  BgmTrack,
  SeTrack,
  ProjectAudio,
  LayerFolder,
  LayerDef,
  PIXELS,
  W,
  H,
  sanitizeFolders,
  sanitizeAudio,
} from "./model";

const MAGIC = "ANIMEMO";
export const PROJECT_VERSION = 5;

function legacyBytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** M10-23: ネイティブ Uint8Array.prototype.toBase64（Chromium 140+ / Node 22+）が使えるなら
 *  そちらを使う（btoa 経路の約10倍）。出力は RFC4648・パディング付きで btoa 経路と同一。
 *  保存データなので、起動時に3種の端数長ベクタで一致を自己確認してからでないと採用しない。 */
const nativeB64Ok = (() => {
  try {
    const probe = (n: number) => {
      const t = new Uint8Array(n);
      for (let i = 0; i < n; i++) t[i] = (i * 37 + 5) & 0xff;
      const f = (t as unknown as { toBase64?: () => string }).toBase64;
      return typeof f === "function" && f.call(t) === legacyBytesToBase64(t);
    };
    return probe(12) && probe(13) && probe(14);
  } catch {
    return false;
  }
})();

function bytesToBase64(bytes: Uint8Array): string {
  if (nativeB64Ok) return (bytes as unknown as { toBase64(): string }).toBase64();
  return legacyBytesToBase64(bytes);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// M10-23: 圧縮側は encodeProject が CompressionStream へ直接チャンク供給する形になった
//（旧 gzip(data) ヘルパは撤去。出力バイト列は同一 — encodeProject のコメント参照）

// V155 (L-1): 一括展開（`gunzip`）は**撤去した**。
// `new Response(stream).arrayBuffer()` は展開後の全体を1つの ArrayBuffer に確保するので、
// 2.1 GiB の作品では確保に失敗する（そこが「保存はできるのに開けない」の入口だった）。
// いまは `streamProjectDoc` が流しながら読む。

interface SerializedFrame {
  paper: number;
  layers: Record<string, string>; // layerId -> base64(索引バイト列。幅は indexBits に従う)
  order?: string[]; // コマ固有の描画順（下→上）
  se?: string[]; // v5: このコマで鳴らす SeTrack id 群（空なら省略）
  /** V157 (D-2): このコマだけのレイヤー表示色（layerId -> "#RRGGBB"）。空なら省略。
   *  任意キー＝`PROJECT_VERSION = 5` のまま。旧ビルドは知らないキーとして読み飛ばし、
   *  **色の無い作品として開く**（絵は完全に一致）。 */
  layerColors?: Record<string, string>;
}

/** 索引バッファ → バイト列（LE）。indexBits=16 なのに 8bit バッファが混在していた場合は
 *  値保存で widening してから直列化する（truncate 経路を作らない防御）。 */
/** V156 (P-1): 1コマぶんのレイヤー id を**決まった順序で**返す。
 *
 *  `layerDefs` の並びを先に、そこに無い id（壊れたファイル・将来の拡張）は後ろに付ける。
 *  眠り→起きるで `f.layers` の挿入順が変わっても、**保存バイト列が揺れない**ようにするため。 */
function orderedLayerIds(p: Project, f: Frame): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ld of p.layerDefs) {
    if (f.layers[ld.id] || f.sleep?.[ld.id]) {
      out.push(ld.id);
      seen.add(ld.id);
    }
  }
  for (const id of Object.keys(f.layers)) if (!seen.has(id)) { out.push(id); seen.add(id); }
  if (f.sleep) for (const id of Object.keys(f.sleep)) if (!seen.has(id)) { out.push(id); seen.add(id); }
  return out;
}

function indexBufToBytes(buf: IndexBuf, bits: 8 | 16): Uint8Array {
  if (bits === 16 && buf instanceof Uint8Array) {
    const wide = new Uint16Array(PIXELS);
    wide.set(buf);
    buf = wide;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** M10-23: エンコードの分割実行オプション（オートセーブ用）。
 *  yieldNow: チャンク間でメインスレッドを譲る（入力イベントを先に処理させる）。
 *  aborted: true を返すとエンコードを破棄して null を返す（変更が起きたスナップショットは書かない）。 */
export interface EncodeInterruptOpts {
  yieldNow?: () => Promise<void>;
  aborted?: () => boolean;
}

/** 共通エンコーダ。出力バイト列は従来の一括経路（JSON.stringify 全体→TextEncoder→gzip）と
 *  完全に同一（機械比較で検証）。同一である理由:
 *  - JSON: doc は frames が最後のキーなので、frames 抜きの JSON 末尾 `"frames":[]}` を
 *    `...,"frames":[` に置き換え、各コマの JSON.stringify をカンマ区切りで続けても
 *    文字列として JSON.stringify(doc) と一致する（stringify は文脈自由・空白なし）
 *  - UTF-8: チャンク境界は常に JSON トークン境界＝文字境界なので分割エンコードでも同一
 *  - gzip: 従来経路も Blob.stream() が内部で分割供給しており、CompressionStream は
 *    途中フラッシュしない（分割粒度は出力に影響しない） */
async function encodeProject(
  p: Project,
  opts?: EncodeInterruptOpts
): Promise<Uint8Array | null> {
  // 防御: 16bitバッファが1枚でもあれば indexBits=16 として書く
  // （8bit宣言のまま16bit値を truncate して書く経路を残さない）
  let bits: 8 | 16 = p.indexBits ?? 8;
  if (bits === 8) {
    outer: for (const f of p.frames) {
      for (const b of Object.values(f.layers)) {
        if (b instanceof Uint16Array) {
          bits = 16;
          break outer;
        }
      }
      // V156 (P-1): 眠っているぶんは**起こさずに**幅を答える（控えが自分の幅を覚えている）。
      // ここで起こしてしまうと、保存のたびに全コマが生に戻って P-1 の意味が消える
      if (f.sleep) {
        for (const [id, e] of Object.entries(f.sleep)) {
          if (!f.layers[id] && e.bits === 16) {
            bits = 16;
            break outer;
          }
        }
      }
    }
  }
  const doc = {
    magic: MAGIC,
    version: PROJECT_VERSION,
    width: p.width,
    height: p.height,
    colorTable: p.colorTable,
    indexBits: bits,
    layerDefs: p.layerDefs,
    // v4: フォルダ（空なら省略）
    folders: p.folders && p.folders.length > 0 ? p.folders : undefined,
    speedIndex: p.speedIndex,
    loop: p.loop,
    // M10-14: サムネコマ（任意項目・PROJECT_VERSION は 5 のまま。旧ビルドは未知キーを
    // 無視して開ける。コマ削除で範囲外になっていてもここでクランプして書く）
    thumbFrame: Math.max(
      0,
      Math.min(p.frames.length - 1, Math.floor(p.thumbFrame ?? 0))
    ),
    colorMode: p.colorMode,
    nextLayerId: p.nextLayerId,
    meta: { ...p.meta, modifiedAt: new Date().toISOString() },
    // v5: SEトラック採番カウンタ
    nextSeId: p.nextSeId,
    // v5: 音声 { bgm, se[] }（無ければ省略）
    audio: p.audio
      ? {
          bgm: p.audio.bgm
            ? {
                source: p.audio.bgm.source,
                mime: p.audio.bgm.mime,
                data: bytesToBase64(p.audio.bgm.data),
                muted: p.audio.bgm.muted,
                volume: p.audio.bgm.volume,
                trimStartMs: p.audio.bgm.trimStartMs,
                trimEndMs: p.audio.bgm.trimEndMs,
                syncMode: p.audio.bgm.syncMode,
                baseSpeedIndex: p.audio.bgm.baseSpeedIndex,
                name: p.audio.bgm.name,
              }
            : null,
          se: p.audio.se.map((s) => ({
            id: s.id,
            name: s.name,
            source: s.source,
            mime: s.mime,
            data: bytesToBase64(s.data),
            volume: s.volume,
            muted: s.muted,
          })),
        }
      : undefined,
    frames: [] as never[],
  };
  const headJson = JSON.stringify(doc);
  // frames は doc の最後のキー。この前提が崩れると分割組み立てが壊れるので毎回検査する
  if (!headJson.endsWith('"frames":[]}')) {
    throw new Error(t("ed.save.internalOrder.msg"));
  }
  const headPart = headJson.slice(0, -2); // 末尾の `]}` を除去 → `...,"frames":[`
  const cs = new CompressionStream("gzip");
  const collected = new Response(cs.readable).arrayBuffer(); // 先に排出を開始（デッドロック防止）
  // write/close が例外で脱出した場合に collected の拒否が unhandledrejection に
  // ならないよう観測だけしておく（実際の失敗は末尾の await collected が伝える）
  void collected.catch(() => {});
  const writer = cs.writable.getWriter();
  const enc = new TextEncoder();
  const abort = async () => {
    try {
      await writer.abort();
    } catch {
      /* 破棄失敗は無視（結果は使わない） */
    }
    try {
      await collected;
    } catch {
      /* 同上 */
    }
    return null;
  };
  let sliceStart = typeof performance !== "undefined" ? performance.now() : 0;
  await writer.write(enc.encode(headPart));
  const frames = p.frames;
  for (let i = 0; i < frames.length; i++) {
    if (opts?.aborted?.()) return abort();
    const f = frames[i];
    const layers: Record<string, string> = {};
    // V156 (P-1・条件3): 起きているものと眠っているものを**同じ順序で**書く。
    // 順序は `layerDefs` 基準に決め打つ——眠って起きるとキーの挿入順が変わるので、
    // `Object.keys(f.layers)` のままだと**同じ絵でも保存バイト列が変わる**（差分が読めなくなる）。
    // 眠っているぶんは `borrowLayerBytes` で1枚だけ展開して base64 にし、**すぐ捨てる**
    //（`f.layers` には入れない＝保存中に実メモリの山が立たない）
    for (const id of orderedLayerIds(p, f)) {
      const buf = f.layers[id];
      if (buf) {
        layers[id] = bytesToBase64(indexBufToBytes(buf, bits));
        continue;
      }
      const lent = await borrowLayerBytes(p, f, id);
      if (!lent) continue; // 起きても眠ってもいない＝そのレイヤーは無い
      const view: IndexBuf =
        lent.bits === 16 ? new Uint16Array(lent.raw.buffer, lent.raw.byteOffset, PIXELS) : lent.raw;
      layers[id] = bytesToBase64(indexBufToBytes(view, bits));
    }
    const sf: SerializedFrame = {
      paper: f.paper,
      layers,
      order: f.order,
      se: f.se && f.se.length > 0 ? f.se : undefined,
      // V157 (D-2): 空のときは**キーごと省く**（色を使っていない作品の保存バイト列を1バイトも変えない）
      layerColors:
        f.layerColors && Object.keys(f.layerColors).length > 0 ? f.layerColors : undefined,
    };
    await writer.write(enc.encode((i > 0 ? "," : "") + JSON.stringify(sf)));
    // 約8msごとにメインスレッドを譲る（占有をチャンク1個ぶんに抑える）
    if (opts?.yieldNow && performance.now() - sliceStart > 8) {
      await opts.yieldNow();
      sliceStart = performance.now();
    }
  }
  if (opts?.aborted?.()) return abort();
  await writer.write(enc.encode("]}"));
  await writer.close();
  return new Uint8Array(await collected);
}

export async function projectToBytes(p: Project): Promise<Uint8Array> {
  // opts なし＝中断しない・譲らない（従来と同じ一気呵成。出力バイト列も同一）
  return (await encodeProject(p))!;
}

/** M10-23: オートセーブ用の中断可能エンコード。中断時は null（部分データは決して返さない） */
export async function projectToBytesInterruptible(
  p: Project,
  opts: EncodeInterruptOpts
): Promise<Uint8Array | null> {
  return encodeProject(p, opts);
}

/** V154b: gzip の末尾4バイト（ISIZE）＝**展開後の大きさ**（mod 2^32・LE）。
 *  **展開する前に**大きさが分かるので、「開けないと分かっているものを、まず開こうとして
 *  メモリを使い切る」のを避けられる。4 GiB を超える作品では一周してしまうが、
 *  そこまで来ると下の例外分けで拾えるので実害はない。 */
function gzipIsize(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n < 4) return 0;
  return (
    (bytes[n - 4] | (bytes[n - 3] << 8) | (bytes[n - 2] << 16) | (bytes[n - 1] << 24)) >>> 0
  );
}

/** V154b: 展開に失敗した理由が「大きすぎる」なのか「壊れている」なのかを分ける。
 *
 *  `DecompressionStream` は中身が合わないと `TypeError`（`incorrect data check` /
 *  `truncated`）を投げ、メモリを確保できないと `RangeError`（`Array buffer allocation failed` /
 *  `Invalid string length`）を投げる。**この2つを混ぜて「壊れています」と言ってはいけない。** */
function isSizeFailure(e: unknown): boolean {
  if (e instanceof RangeError) return true;
  const m = String((e as { message?: string })?.message ?? e);
  return /allocation|Invalid string length|out of memory|too large/i.test(m);
}

// ---------------- V155 (L-1): 読み込みを分割にする ----------------

/** V155: コマ1つの JSON は必ずこの9文字で始まる（`encodeProject` が
 *  `JSON.stringify({paper, layers, order, se})` の順で書く）。
 *
 *  **この並びがコマの先頭以外に現れないことは、JSON の仕様が保証する**——
 *  文字列の中の `"` は必ず `\"` に escape されるので、レイヤー名を `{"paper":` にしても
 *  ファイルには `{\"paper\":` と書かれ、この9文字にはならない。素朴な `indexOf` でよい。 */
const FRAME_HEAD = '{"paper":';

/** V155: **こちらが文言を決めて投げた**読み込みエラー。
 *
 *  展開そのものの失敗（`DecompressionStream` の例外）と区別するために印を付ける。
 *  以前はメッセージの正規表現で見分けようとしていたが、**メッセージが空の例外**
 *  （ISIZE を書き換えた gzip で実際に出る）を素通しして、画面に空の理由が出た。
 *  型で見分ければ、相手が何を投げてきても取り違えない。 */
class LoadError extends Error {}

/** V155: 読み込み中の doc は**未知の形**（旧版・手で壊されたもの）も通すので、
 *  従来の `JSON.parse` の戻り（`any`）と同じ緩さで受けて、下の分岐で1つずつ確かめる。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadedDoc = Record<string, any>;

/** V155: コマの並びの始まり。`encodeProject` は `…,"frames":[` まで書いてからコマを並べる。
 *  ここも上と同じ理由（`"` は必ず escape される）で、ヘッダの途中には現れない。
 *
 *  **`frames` が最後のキーだとは仮定しない。**歴代の書き手はどれも最後に置いているが、
 *  そこに寄りかかると、キーの並びが違うだけのファイルを「壊れている」と言ってしまう
 *  （＝この回が直しているのと同じ種類の事故）。`]` の後ろに続きがあれば拾って繋ぐ。 */
const FRAMES_KEY = '"frames":[';

/** V155 (L-1): gzip を**流しながら**読み、ヘッダと Frame を1つずつ組み立てる。
 *
 *  ★これが V155 の本体。以前は
 *
 *      gunzip 全体 → TextDecoder で**1本の文字列**（2.1 GiB）→ JSON.parse
 *
 *  としていたので、V8 の文字列上限（536,870,888 文字＝512 MiB）に当たり、
 *  **保存はできるのに二度と開けない**作品ができていた。保存側は最初から分割で
 *  書いているのに、読み込み側だけが一括だった——その非対称が原因。
 *
 *  抱えるのは「ヘッダ ＋ いま処理中のコマ1つ」だけ（20レイヤーで約2MB）。
 *  1コマぶんの JSON が確定するたびに `Frame` へ変換し、**元のテキストは捨てる**。 */
async function streamProjectDoc(
  bytes: Uint8Array,
  onFrame?: (done: number) => void
): Promise<{ doc: LoadedDoc; frames: Frame[] }> {
  const ds = new DecompressionStream("gzip");
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(ds).getReader();
  const dec = new TextDecoder();
  const frames: Frame[] = [];

  // ★ここではビット幅を決めない。`indexBits` が frames より後ろに書かれていても
  //   正しく読めるように、**base64 を解いた生バイトのまま**積んでおき、
  //   doc が揃ってから 8/16 の解釈と長さの検査をする（`finalizeFrames`）。
  //   生バイトはどのみち必要な実体なので、これで余分なメモリは増えない。
  const sp = createDocSplitter(
    (text) => {
      frames.push(frameFromSerialized(JSON.parse(text) as SerializedFrame));
      onFrame?.(frames.length);
    },
    // **中身を読む前に**分かることは先に見る（2 GiB 流したあとで「別のファイルでした」
    // と言わないため）。`frames` より後ろのキーはまだ見えていないので、
    // **見えているものだけ**を判定する。そろった判定は最後の `validateDoc`
    (head) => earlyCheck(head)
  );

  // V156 (P-3 / A-35): **切り分けとは別の数え方**で、コマの頭 `{"paper":` を数える。
  //
  //  V155 で見つかった「チャンクの切れ目で同じ頭を二度数える」バグは、
  //  **コマ数だけが静かに増えて**通ってしまう種類だった（絵は途中で切れているのに例外は出ない）。
  //  切り分け（`createDocSplitter`）が吐いた数と、ここで素朴に数えた数を最後に突き合わせれば、
  //  同じ種類の事故が**次に起きたとき必ず止まる**。数え方は `verifySavedBytes`（保存の検証）と
  //  同じ素朴な `indexOf` ＋ 持ち越し——**わざと別実装**にしてある（同じ関数を共有すると
  //  同じバグで両方とも間違えるので、突き合わせの意味が消える）。
  const counter = createFrameHeadCounter();
  const countHeads = counter.push;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    countHeads(chunk);
    sp.push(chunk);
  }
  const lastChunk = dec.decode(); // 末尾（マルチバイトの繰り越しを吐き出す）
  countHeads(lastChunk);
  sp.push(lastChunk);

  // ヘッダ（`…"frames":[`）＋ `]` 以降 ＝ **コマ抜きの、キーが全部そろった JSON**
  const { head, tail } = sp.end();
  let doc: LoadedDoc;
  try {
    doc = JSON.parse(head + tail) as LoadedDoc;
  } catch {
    throw new LoadError(t("ed.load.notProject.msg"));
  }
  const bits = validateDoc(doc);
  // ★A-35: 突き合わせ。合わなければ**うるさく失敗する**（静かに1コマ減って開かない）
  const headCount = counter.count();
  if (frames.length !== headCount) {
    throw new LoadError(
      t("ed.load.frameCountMismatch.msg", { got: frames.length, want: headCount })
    );
  }
  finalizeFrames(frames, bits);
  return { doc, frames };
}

/** V155: 流れてくるテキストを「ヘッダ」「コマ1つぶんの JSON」「残り」に切り分ける。
 *
 *  ★**チャンクの切れ目がどこに来ても結果が変わらないこと**が、この関数のすべて。
 *   最初の実装は「コマの頭がチャンクの末尾 8 文字以内に来る」と同じ頭を二度数え、
 *   コマを途中でぶつ切りにしていた（実測: 音声つき作品の 1 つで再現。
 *   起きる確率は 1 コマあたり 1 万分の 1 程度で、**運が良ければ通ってしまう**種類の
 *   壊れ方だった）。切れ目を作るのは `DecompressionStream` なので、こちらからは
 *   選べない——だから切り分けだけを関数にして、`v155_smoke` が
 *   **あらゆる切れ方**（1文字ずつ／頭をまたぐ位置／境界ぴったり）を総当たりで当てる。
 *
 *  `onFrame` にはコマ1つぶんの JSON をそのまま渡す（呼び出し側が parse して捨てる）。 */
/** V156 (P-3 / A-35): コマの頭 `{"paper":` を数えるだけの、**切り分けとは別実装**の数え上げ。
 *
 *  同じ関数を共有すると同じバグで両方とも間違えるので、突き合わせの意味が消える。
 *  こちらは `verifySavedBytes`（保存の検証）と同じ素朴な `indexOf` ＋ 持ち越しにしてある。
 *  チャンクの切れ目に左右されないこと（V155 で実際に踏んだ穴）は `v156_smoke` が総当たりで見る。 */
export function createFrameHeadCounter() {
  const KEEP = FRAME_HEAD.length - 1;
  let n = 0;
  let carry = "";
  return {
    push(chunk: string): void {
      const hay = carry + chunk;
      let at = hay.indexOf(FRAME_HEAD);
      while (at >= 0) {
        n++;
        at = hay.indexOf(FRAME_HEAD, at + FRAME_HEAD.length);
      }
      carry = hay.slice(Math.max(0, hay.length - KEEP));
    },
    count(): number {
      return n;
    },
  };
}

export function createDocSplitter(
  onFrame: (text: string) => void,
  onHead?: (head: string) => void
) {
  // 区切りが切れ目をまたいでも拾えるよう、末尾この文字数だけを次へ持ち越す
  const KEEP = Math.max(FRAME_HEAD.length, FRAMES_KEY.length) - 1;
  let phase: "head" | "frames" = "head";
  let headParts: string[] = []; // ヘッダの断片（音声つきだと数十MBになる）
  let head = ""; // `…,"frames":[` まで
  let pre: string[] = []; // 最初のコマより前（普通は空。コマ0個なら残り全部）
  let parts: string[] = []; // 組み立て中のコマの断片
  let open = false; // コマの途中か
  let carry = ""; // まだ確定させていない末尾

  // ★速さの要: **貯めた文字列を何度も走査しない。**
  //  素直に `pending += chunk; pending.indexOf(…)` と書くと、チャンクが来るたびに
  //  貯まっている 2MB を頭から走査し直す（しかも `+=` で作ったロープを毎回平坦化する）。
  //  1コマ 2MB ／ チャンク 64KB なら 1コマあたり 32 回 × 2MB＝64MB を走査することになり、
  //  1,098 コマで 70 GB を舐める計算になる。**実測 78 秒**だった。
  //  なので「新しく来たぶんだけを走査し、断片は `parts` に置いて最後に1回 `join`」。
  const scanFrames = (hay: string) => {
    let pos = 0; // hay のうち、まだ断片に移していない先頭
    let from = 0;
    for (;;) {
      const at = hay.indexOf(FRAME_HEAD, from);
      if (at < 0) break;
      if (open) {
        // 直前のコマの終わりは `at - 1`（区切りの `,` の手前）
        parts.push(hay.slice(pos, Math.max(pos, at - 1)));
        onFrame(parts.join(""));
        parts = [];
      } else {
        pre.push(hay.slice(pos, at));
      }
      open = true;
      // ★見つけた頭は**その場で断片に移す**。持ち越しに残すと、次の走査で
      //   同じ頭をもう一度見つけて、コマを途中で切ってしまう（上の注記の事故）
      parts.push(FRAME_HEAD);
      pos = at + FRAME_HEAD.length;
      from = pos;
    }
    // 末尾 KEEP 文字は「区切りの途中かもしれない」ので次へ持ち越す。
    // ただし**確定済みの位置より前には戻さない**
    const safeEnd = Math.max(pos, hay.length - KEEP);
    (open ? parts : pre).push(hay.slice(pos, safeEnd));
    carry = hay.slice(safeEnd);
  };

  return {
    push(chunk: string): void {
      if (phase === "frames") {
        scanFrames(carry + chunk);
        return;
      }
      // 音声を埋め込んだ作品ではヘッダ自体が数十MBになるので、ここも同じ流儀で走査する
      const hay = carry + chunk;
      const at = hay.indexOf(FRAMES_KEY);
      if (at < 0) {
        const safeEnd = Math.max(0, hay.length - KEEP);
        headParts.push(hay.slice(0, safeEnd));
        carry = hay.slice(safeEnd);
        return;
      }
      const headEnd = at + FRAMES_KEY.length;
      headParts.push(hay.slice(0, headEnd));
      head = headParts.join("");
      headParts = [];
      phase = "frames";
      carry = "";
      onHead?.(head);
      scanFrames(hay.slice(headEnd)); // 同じチャンクの残りは、もうコマの並び
    },

    /** 最後のコマを吐き出して、`head`（`…"frames":[`）と `tail`（`]…}`）を返す。
     *  `head + tail` が「コマ抜きの、キーが全部そろった JSON」になる。 */
    end(): { head: string; tail: string } {
      if (phase === "head") throw new LoadError(t("ed.load.notProject.msg"));
      const rest = (open ? parts.join("") : pre.join("")) + carry;
      let after: string;
      if (open) {
        // 「`]}` で終わっているはず」と決め打たない（`frames` が最後のキーとは限らない）。
        // 最後のコマの `}` がどこで閉じるかを数えて、そこから先を残りのヘッダとして扱う
        const at = objectEnd(rest);
        if (at < 0) throw new LoadError(t("ed.load.notProject.msg"));
        onFrame(rest.slice(0, at));
        after = rest.slice(at);
      } else {
        after = rest;
      }
      // `after` は空白のあと必ず `]`（frames 配列の閉じ）で始まる
      const close = after.indexOf("]");
      if (close < 0 || after.slice(0, close).trim() !== "")
        throw new LoadError(t("ed.load.notProject.msg"));
      return { head, tail: after.slice(close) };
    },
  };
}

/** V155: `text[0]` から始まる JSON オブジェクトが閉じる位置（`}` の次）を返す。無ければ -1。
 *  文字列の中の `{}` と escape された `"` を数えないためだけの、小さな状態機械。
 *  当てるのは**最後のコマ1つぶん**だけなので、速さは問題にならない。 */
function objectEnd(text: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** V155: `frames` より前に見えているキーだけで「明らかに違うもの」を先に落とす。
 *  ヘッダは `…,"frames":[` で終わっているので、`]}` を足せばコマ抜きの JSON になる。
 *  ここを通っても正しいとは限らない（本判定は最後の `validateDoc`）。 */
function earlyCheck(head: string): void {
  let doc: LoadedDoc;
  try {
    doc = JSON.parse(head + "]}") as LoadedDoc;
  } catch {
    throw new LoadError(t("ed.load.notProject.msg"));
  }
  if (doc.magic !== undefined && doc.magic !== MAGIC)
    throw new LoadError(t("ed.load.notProject.msg"));
  if (typeof doc.version === "number" && doc.version > PROJECT_VERSION)
    throw new LoadError(t("ed.load.newerVersion.msg", { version: doc.version }));
  if (doc.width !== undefined && doc.height !== undefined && (doc.width !== W || doc.height !== H))
    throw new LoadError(t("ed.load.badSize.msg"));
}

/** V155: 生バイトのまま積んだレイヤーを、確定したビット幅で解釈し直す。
 *  16bit のときは**同じバッファを見る**ビューを作るだけ（複製しない）。 */
function finalizeFrames(frames: Frame[], bits: 8 | 16): void {
  const expected = PIXELS * (bits / 8);
  for (const f of frames) {
    for (const [id, buf] of Object.entries(f.layers)) {
      const raw = buf as Uint8Array;
      if (raw.length !== expected) throw new LoadError(t("ed.load.badLayer.msg"));
      // base64ToBytes はオフセット0の自前バッファ（LE）なので、そのまま覗ける
      if (bits === 16) f.layers[id] = new Uint16Array(raw.buffer, 0, PIXELS);
    }
  }
}

/** V155: doc の形を確かめて、索引のビット幅を返す（従来の判定をそのまま関数にしただけ）。 */
function validateDoc(doc: LoadedDoc): 8 | 16 {
  if (doc.magic !== MAGIC) throw new LoadError(t("ed.load.notProject.msg"));
  if (typeof doc.version !== "number" || doc.version > PROJECT_VERSION) {
    throw new LoadError(t("ed.load.newerVersion.msg", { version: doc.version }));
  }
  if (doc.width !== W || doc.height !== H) {
    throw new LoadError(t("ed.load.badSize.msg"));
  }
  // v1 は indexBits 無し → 8bit（従来と同一の可逆ロード）
  return doc.indexBits === 16 ? 16 : 8;
}

/** V157 (D-2): コマ単位の表示色を健全化する。
 *  `"#RRGGBB"` のものだけ残し、1つも残らなければ `undefined`（キーごと消える）。
 *  `LayerDef.displayColor` の検証（`serialize.ts` の下の方）と**同じ規則**にしてある。
 *  存在しないレイヤー id が混ざっていても害は無い（描画時に引かれないだけ）ので落とさない
 *  ——落とすと「レイヤーを消して undo した」ときに色まで消える。 */
function sanitizeFrameColors(
  v: unknown
): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [id, c] of Object.entries(v as Record<string, unknown>)) {
    if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) out[id] = c;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** V155: 直列化された1コマ → `Frame`（従来の `map` の中身をそのまま関数にしただけ）。
 *  **ビット幅の解釈と長さの検査はここでは行わない**（`finalizeFrames` が最後にまとめて行う）。 */
function frameFromSerialized(sf: SerializedFrame): Frame {
  const layers: Record<string, IndexBuf> = {};
  for (const [id, b64] of Object.entries(sf.layers)) layers[id] = base64ToBytes(b64);
  return {
    paper: sf.paper,
    layers,
    order: sf.order,
    // v5: SE配置（未知idの除去は最後の sanitizeAudio が行う）
    se: Array.isArray(sf.se) ? sf.se.filter((x) => typeof x === "string") : undefined,
    // V157 (D-2): コマ単位の表示色。**"#RRGGBB" のものだけ**通す（`displayColor` と同じ作法。
    // 手で壊された値・数値・null はキーごと落として、絵は必ず開ける）
    layerColors: sanitizeFrameColors(sf.layerColors),
  };
}

/** V155 (L-2): 読み込みの進み具合を知らせる口（コマを1つ組み立てるたびに呼ぶ）。
 *  **数字は画面に出さない**（要件 W-8 の流儀）が、呼び出し側が
 *  「動いている」ことを見せるために使う。 */
export interface LoadOpts {
  onFrame?: (done: number) => void;
}

export async function projectFromBytes(
  bytes: Uint8Array,
  opts?: LoadOpts
): Promise<Project> {
  // V154b: 大きさの上限を**利用者向けの言葉**にするための材料（MiB は概数でよい）
  const mib = (n: number) => {
    const m = n / 1024 / 1024;
    return m >= 1024 ? `${Math.round((m / 1024) * 10) / 10}GB` : `${Math.round(m * 10) / 10}MB`;
  };
  // V155（Codex レビュー §2・優先度 高）: **「この版が開ける上限」はもう出さない。**
  // V154b では固定の門番（512MB）で断っていたので上限を出すのが正しかったが、
  // 分割読み込みにした今、ここへ来るのは**本当にメモリが足りなかったとき**だけ。
  // 固定の数字を出すと「直ったはずなのに、やっぱり版の上限で無理なのか」と読まれる
  const tooLarge = (rawBytes: number) =>
    new Error(
      t("ed.load.tooLarge.msg", { size: rawBytes > 0 ? mib(rawBytes) : mib(bytes.length) })
    );

  // V154b: **gzip のマジック（1f 8b）があれば、それは gzip。**
  //
  // 以前はここが無条件の try/catch で、展開に失敗すると**gzip の生バイトをそのまま
  // JSON として読もうとして** `SyntaxError: Unexpected token '\ufffd'` になっていた。
  // 画面には「読み込みエラー: … is not valid JSON」と出るので、**1バイトも壊れていない
  // ファイルなのに「あなたのデータは壊れています」としか読めない**。これが嘘の正体。
  // 「非圧縮かもしれない」の保険は、**マジックが無いときだけ**に限る。
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  let doc: LoadedDoc;
  let frames: Frame[];
  if (isGzip) {
    // ★V155 (L-1): **流しながら読む。**巨大な1本の文字列は作らない。
    //
    // V154b では、ここに `if (isize > MAX_JSON_CHARS) throw tooLarge(isize)` という門番が
    // 立っていた。当時は「どうせ文字列にできないのだから、掴めないメモリを掴みに
    // いかせない」ための正しい門番だったが、**分割で読める今は、この門番こそが
    // 再現データを追い返す張本人**になる（ISIZE 2.10 GiB > 512 MiB）。だから外す。
    //
    // 代わりの上限は**置かない**。理由は要件 §L-1 の「推測で数字を置かない」で、
    // ここで効く本当の限界は「索引バッファをメモリに置けるか」＝機械ごとに違うため。
    // 置けなかったときは確保が `RangeError` で落ちるので、`isSizeFailure` で拾って
    // **「大きすぎて開けません／ファイルは壊れていません」**を出す（嘘をつかない）。
    try {
      const r = await streamProjectDoc(bytes, opts?.onFrame);
      doc = r.doc;
      frames = r.frames;
    } catch (e) {
      // ①こちらが文言を決めて投げたもの（形が違う・版が新しい・レイヤーが壊れている）はそのまま
      if (e instanceof LoadError) throw e;
      // ②大きすぎて確保できなかった（`RangeError` 等）＝**壊れてはいない**
      if (isSizeFailure(e)) throw tooLarge(gzipIsize(bytes));
      // ③それ以外は展開そのものの失敗（CRC・ISIZE 不一致・途中切れ）＝壊れている
      //   ここへ**メッセージが空の例外**も落ちる（素通しさせない）
      throw new Error(t("ed.load.decompressFailed.msg"));
    }
  } else {
    // 旧・非圧縮の可能性に備える（前方互換の保険）。**マジックが無いときだけ**。
    // こちらは「gzip すら通していない古いもの＝小さい」ので、従来の一括で読む
    let text: string;
    try {
      text = new TextDecoder().decode(bytes);
    } catch (e) {
      if (isSizeFailure(e)) throw tooLarge(bytes.length);
      throw e;
    }
    // V155: ここも**生の SyntaxError を利用者に見せない**（「Unexpected token 'h'…」が
    // 帯に出ていた。gzip 側は V154b で直したが、こちらが残っていた）
    try {
      doc = JSON.parse(text) as LoadedDoc;
    } catch {
      throw new LoadError(t("ed.load.notProject.msg"));
    }
    const bits = validateDoc(doc);
    frames = (doc.frames as SerializedFrame[]).map((sf) => frameFromSerialized(sf));
    finalizeFrames(frames, bits);
  }
  // 保存し直すときのビット幅（`Project.indexBits`）。上の2経路とも `validateDoc` で確かめ済み
  const bits: 8 | 16 = doc.indexBits === 16 ? 16 : 8;
  // 音声の復元。破損していても絵は開けるよう、失敗は隔離する（従来方針）
  // - v5: { bgm, se[] } をそのまま復元
  // - v3/v4: 旧 audio（単一トラック）→ bgm へ可逆マイグレーション
  //   （source "kwz-original"→"kwz"・baseSpeedIndex=doc.speedIndex。se は []）
  // - v1/v2: audio なし
  let audio: ProjectAudio | null = null;
  const speedIndexForBase = typeof doc.speedIndex === "number" ? doc.speedIndex : 6;
  const parseBgm = (src: unknown, baseDefault: number): BgmTrack | null => {
    const d = src as Record<string, unknown> | null | undefined;
    if (!d || typeof d.data !== "string") return null;
    try {
      return {
        source: d.source === "external" ? "external" : d.source === "mic" ? "mic" : "kwz",
        mime: typeof d.mime === "string" ? d.mime : "audio/wav",
        data: base64ToBytes(d.data),
        muted: d.muted === true,
        volume:
          typeof d.volume === "number" ? Math.max(0, Math.min(1, d.volume)) : 1,
        trimStartMs: typeof d.trimStartMs === "number" ? d.trimStartMs : 0,
        trimEndMs: typeof d.trimEndMs === "number" ? d.trimEndMs : null,
        syncMode: d.syncMode === "animToAudio" ? "animToAudio" : "audioToAnim",
        baseSpeedIndex:
          typeof d.baseSpeedIndex === "number" ? d.baseSpeedIndex : baseDefault,
        name: typeof d.name === "string" ? d.name : undefined,
      };
    } catch (e) {
      console.warn("BGMデータの復元に失敗（BGMなしとして続行）:", e);
      return null;
    }
  };
  try {
    if (doc.version >= 5) {
      if (doc.audio && typeof doc.audio === "object") {
        const bgm = parseBgm(doc.audio.bgm, speedIndexForBase);
        const se: SeTrack[] = [];
        if (Array.isArray(doc.audio.se)) {
          for (const d of doc.audio.se) {
            if (!d || typeof d.id !== "string" || typeof d.data !== "string") continue;
            try {
              se.push({
                id: d.id,
                name: typeof d.name === "string" ? d.name : d.id,
                source:
                  d.source === "external" ? "external" : d.source === "mic" ? "mic" : "kwz",
                mime: typeof d.mime === "string" ? d.mime : "audio/wav",
                data: base64ToBytes(d.data),
                volume:
                  typeof d.volume === "number" ? Math.max(0, Math.min(1, d.volume)) : 1,
                muted: d.muted === true,
              });
            } catch (e) {
              console.warn(`SE(${d.id})の復元に失敗（このSEを除外）:`, e);
            }
          }
        }
        audio = bgm || se.length > 0 ? { bgm, se } : null;
      }
    } else if (doc.audio && typeof doc.audio.data === "string") {
      // v3/v4 旧単一トラック → bgm（旧 source 値 "kwz-original" は parseBgm が "kwz" に写像）
      const bgm = parseBgm(doc.audio, speedIndexForBase);
      audio = bgm ? { bgm, se: [] } : null;
    }
  } catch (e) {
    console.warn("音声データの復元に失敗（音声なしとして続行）:", e);
    audio = null;
  }
  // v4: folders（v1〜v3 は無し → []・全ルートで可逆）
  const folders: LayerFolder[] = Array.isArray(doc.folders)
    ? (doc.folders as LayerFolder[])
        .filter((f) => f && typeof f.id === "string")
        .map((f) => ({
          id: f.id,
          name: typeof f.name === "string" ? f.name : folderBaseName(),
          visible: f.visible !== false,
          opacity:
            typeof f.opacity === "number" ? Math.max(0, Math.min(1, f.opacity)) : 1,
          collapsed: f.collapsed === true,
          parent: typeof f.parent === "string" ? f.parent : undefined,
          // V157 (D-1): フォルダの 🔒。**ここは `layerDefs` と違ってキーを明示列挙して
          // 作り直している**ので、書かないと読み込みで消える（実際に検査で捕まえた）。
          // true のときだけ足す＝壊れた値は自然に落ちる（`sanitizeFolders` と同じ結論）
          ...(f.locked === true ? { locked: true as const } : {}),
        }))
    : [];
  const p: Project = {
    version: 1,
    width: W,
    height: H,
    colorTable: doc.colorTable,
    indexBits: bits,
    layerDefs: doc.layerDefs,
    folders,
    frames,
    speedIndex: doc.speedIndex ?? 6,
    loop: doc.loop ?? true,
    // M10-14: 無ければ 0（先頭コマ）・数値でも「コマ数-1」でクランプ（壊れた値で落とさない）
    thumbFrame:
      typeof doc.thumbFrame === "number" && Number.isFinite(doc.thumbFrame)
        ? Math.max(0, Math.min(frames.length - 1, Math.floor(doc.thumbFrame)))
        : 0,
    colorMode: doc.colorMode === "fullcolor" ? "fullcolor" : "palette",
    nextLayerId: doc.nextLayerId ?? 1000,
    nextSeId: typeof doc.nextSeId === "number" ? doc.nextSeId : undefined,
    meta: doc.meta ?? { title: untitledTitle() },
    audio,
  };
  // M11-20: LayerDef.clip（クリッピング）は任意キー・PROJECT_VERSION=5 のまま。true 以外（欠損・非 boolean・
  // 手で壊した値）は false 扱い＝キーを落とす。**オブジェクトは作り直さない**（layerDefs は素通しで
  // 読み書きしているので、旧ビルドがこのファイルを開いて保存し直しても未知キーとして残る＝互換の要）
  if (Array.isArray(p.layerDefs)) {
    for (const ld of p.layerDefs as unknown[]) {
      if (ld && typeof ld === "object" && "clip" in ld && (ld as LayerDef).clip !== true) {
        delete (ld as { clip?: unknown }).clip;
      }
      // M15 (K-2): displayColor は "#RRGGBB" のみ有効。壊れた値・非文字列はキーを落とす（clip と同じ作法）
      if (ld && typeof ld === "object" && "displayColor" in ld) {
        const dc = (ld as LayerDef).displayColor;
        if (typeof dc !== "string" || !/^#[0-9a-fA-F]{6}$/.test(dc)) {
          delete (ld as { displayColor?: unknown }).displayColor;
        }
      }
      // M15 (K-1): shared は true のみ有効。それ以外はキーを落とす
      if (ld && typeof ld === "object" && "shared" in ld && (ld as LayerDef).shared !== true) {
        delete (ld as { shared?: unknown }).shared;
      }
      // V157 (D-1): locked も true のみ有効（shared と同じ作法）。
      // 壊れた値で「解除できないロック」が生まれないようにキーごと落とす
      if (ld && typeof ld === "object" && "locked" in ld && (ld as LayerDef).locked !== true) {
        delete (ld as { locked?: unknown }).locked;
      }
    }
    // M15 (K-1): 旧版で共通レイヤーのコマ間に差が生まれた場合の裁定（REQ §4）。
    // 保存時は全コマへ同一内容を書くので、読み込んだ各コマのバッファが**すべて一致**していれば
    // 共通は健在。1つでも違うコマがあれば「旧ビルドで編集された」＝共通を外してそのまま開く
    //（旧版の編集を捨てない・作者決定）。実体の張り直し（全コマ同一参照へ）は editor 側の relinkShared。
    let conflict = false;
    for (const ld of p.layerDefs) {
      if (ld.shared !== true) continue;
      const base = frames[0]?.layers[ld.id];
      let differs = false;
      for (const f of frames) {
        const b = f.layers[ld.id];
        if (!base || !b || b.length !== base.length) { differs = true; break; }
        for (let i = 0; i < b.length; i++) if (b[i] !== base[i]) { differs = true; break; }
        if (differs) break;
      }
      if (differs) {
        delete (ld as { shared?: unknown }).shared;
        conflict = true;
      }
    }
    // 呼び出し側（editor.mount）が1回だけトーストを出すための一時フラグ（settings の __recovered の前例）。
    // Project の interface には足さない（読んだら消す運用）
    if (conflict) (p as { __sharedConflict?: boolean }).__sharedConflict = true;
  }
  // 壊れた parent（存在しないid・循環）をルートへ隔離（絵は必ず開ける）
  sanitizeFolders(p);
  // M5-1: 壊れた bgm/se・未知SE配置の隔離＋nextSeId 健全化（絵は必ず開ける）
  sanitizeAudio(p);
  return p;
}

// ---------------- V154 (W-6): 保存したものが読み戻せるかを確かめる ----------------

/** V154 (W-6): 検証の結果。`ok` 以外は**保存を確定させない**（控えを捨てない）。 */
export interface SavedCheck {
  ok: boolean;
  /** 失敗の理由。**画面には出さない**（利用者向けの文言は `ed.file.saveBroken.msg`）。
   *  ログと報告に使う識別子なので ASCII で書く（grep しやすく・ログの文字化けも避ける） */
  reason: string;
  /** 展開できたバイト数（0 = 展開できなかった） */
  rawBytes: number;
  /** 数えられたコマ数（-1 = 数えられなかった） */
  frames: number;
}

/**
 * V154 (W-6): **保存したバイト列が本当に読み戻せるか**を確かめる。
 *
 * なぜ要るか: 手動保存はこれまで `data` の中身を一切見ずに「書けた＝成功」としていた。
 * そのため**壊れたバイト列が「保存成功」として確定し、控え（`.bak`）とオートセーブの
 * 両方をアプリ自身が捨てていた**（V154 追記の事故モデル）。確定の前にここを通す。
 *
 * 見るもの（要件の最低線）:
 *   1. 長さが 0 でない
 *   2. gzip である（先頭 `1f 8b`）
 *   3. **展開できる** — ここが本命。gzip は末尾に CRC32 と長さを持ち、
 *      `DecompressionStream` はそれを検証して合わなければ例外を投げる。
 *      つまり**1バイトでも化けていれば必ず落ちる**（途中切れも同じ）
 *   4. 先頭に `{"magic":"ANIMEMO","version":N` があり、N が読める版である
 *   5. 大きさが 320×240 である
 *   6. **コマ数が期待どおり**
 *
 * 重い作品でも耐えられるよう、**展開したものは保持しない**（読み捨てながら数える）。
 * 保持するのは先頭 512 文字と、チャンク境界をまたぐ 8 文字だけ。
 * `expectFrames` に負数を渡すとコマ数の検査だけ省く（数えた結果は返す）。
 */
export async function verifySavedBytes(
  bytes: Uint8Array | null | undefined,
  expectFrames: number
): Promise<SavedCheck> {
  const fail = (reason: string, rawBytes = 0, frames = -1): SavedCheck => ({
    ok: false,
    reason,
    rawBytes,
    frames,
  });
  if (!bytes || bytes.length === 0) return fail("empty-file");
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return fail(`not-gzip: head ${bytes[0]} ${bytes[1]}`);
  }
  // コマ1つは JSON.stringify(SerializedFrame) ＝ 必ず `{"paper":` で始まる（encodeProject）。
  // base64 には `"` が入らないので、絵のデータの中で偶然一致することはない
  const NEEDLE = '{"paper":';
  const KEEP = NEEDLE.length - 1;
  let rawBytes = 0;
  let frames = 0;
  let head = "";
  let overlap = "";
  let first = true;
  try {
    const ds = new DecompressionStream("gzip");
    const reader = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(ds)
      .getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      rawBytes += value.byteLength;
      const hay = overlap + dec.decode(value, { stream: true });
      if (first) {
        head = hay.slice(0, 512);
        first = false;
      }
      let at = -1;
      while ((at = hay.indexOf(NEEDLE, at + 1)) >= 0) frames++;
      // 次のチャンクとの境目で切れたコマを取りこぼさない（重複して数えない長さに保つ）
      overlap = hay.slice(Math.max(0, hay.length - KEEP));
    }
  } catch (e) {
    // gzip の CRC・長さが合わない＝**書いたものが壊れている**
    return fail(`gunzip-failed: ${String(e)}`, rawBytes, -1);
  }
  if (rawBytes === 0) return fail("empty-after-gunzip", 0, -1);
  if (!head.startsWith(`{"magic":"${MAGIC}","version":`)) {
    return fail(`bad-header: ${JSON.stringify(head.slice(0, 40))}`, rawBytes, frames);
  }
  const mv = head.match(/^\{"magic":"[A-Z]+","version":(\d+)/);
  const ver = mv ? Number(mv[1]) : NaN;
  if (!Number.isFinite(ver) || ver < 1 || ver > PROJECT_VERSION) {
    return fail(`bad-version: ${mv?.[1] ?? "?"}`, rawBytes, frames);
  }
  if (!head.includes(`"width":${W},"height":${H}`)) {
    return fail(`bad-size: want ${W}x${H}`, rawBytes, frames);
  }
  if (expectFrames >= 0 && frames !== expectFrames) {
    return fail(`frames-mismatch: want ${expectFrames} got ${frames}`, rawBytes, frames);
  }
  return { ok: true, reason: "", rawBytes, frames };
}
