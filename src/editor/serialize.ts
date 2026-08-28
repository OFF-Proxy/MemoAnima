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
  MAX_JSON_CHARS,
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

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const blob = new Blob([data as BlobPart]);
  const stream = blob.stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface SerializedFrame {
  paper: number;
  layers: Record<string, string>; // layerId -> base64(索引バイト列。幅は indexBits に従う)
  order?: string[]; // コマ固有の描画順（下→上）
  se?: string[]; // v5: このコマで鳴らす SeTrack id 群（空なら省略）
}

/** 索引バッファ → バイト列（LE）。indexBits=16 なのに 8bit バッファが混在していた場合は
 *  値保存で widening してから直列化する（truncate 経路を作らない防御）。 */
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
    for (const [id, buf] of Object.entries(f.layers)) {
      layers[id] = bytesToBase64(indexBufToBytes(buf, bits));
    }
    const sf: SerializedFrame = {
      paper: f.paper,
      layers,
      order: f.order,
      se: f.se && f.se.length > 0 ? f.se : undefined,
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

export async function projectFromBytes(bytes: Uint8Array): Promise<Project> {
  // V154b: 大きさの上限を**利用者向けの言葉**にするための材料（MiB は概数でよい）
  const mib = (n: number) => {
    const m = n / 1024 / 1024;
    return m >= 1024 ? `${Math.round((m / 1024) * 10) / 10}GB` : `${Math.round(m * 10) / 10}MB`;
  };
  const tooLarge = (rawBytes: number) =>
    new Error(
      t("ed.load.tooLarge.msg", {
        size: rawBytes > 0 ? mib(rawBytes) : mib(bytes.length),
        max: mib(MAX_JSON_CHARS),
      })
    );

  // V154b: **gzip のマジック（1f 8b）があれば、それは gzip。**
  //
  // 以前はここが無条件の try/catch で、展開に失敗すると**gzip の生バイトをそのまま
  // JSON として読もうとして** `SyntaxError: Unexpected token '\ufffd'` になっていた。
  // 画面には「読み込みエラー: … is not valid JSON」と出るので、**1バイトも壊れていない
  // ファイルなのに「あなたのデータは壊れています」としか読めない**。これが嘘の正体。
  // 「非圧縮かもしれない」の保険は、**マジックが無いときだけ**に限る。
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  let json: Uint8Array;
  if (isGzip) {
    // 展開する前に、末尾の ISIZE で「そもそも文字列にできない大きさか」を見る
    const isize = gzipIsize(bytes);
    if (isize > MAX_JSON_CHARS) throw tooLarge(isize);
    try {
      json = await gunzip(bytes);
    } catch (e) {
      // 大きすぎて確保できなかったのか、中身が合わないのかを分ける（混ぜない）
      if (isSizeFailure(e)) throw tooLarge(isize);
      throw new Error(t("ed.load.decompressFailed.msg"));
    }
  } else {
    // 旧・非圧縮の可能性に備える（前方互換の保険）。**マジックが無いときだけ**
    json = bytes;
  }
  let text: string;
  try {
    text = new TextDecoder().decode(json);
  } catch (e) {
    // 展開はできたが、1本の文字列にできなかった（V8 の上限）。これも「壊れている」ではない
    if (isSizeFailure(e)) throw tooLarge(json.length);
    throw e;
  }
  const doc = JSON.parse(text);
  if (doc.magic !== MAGIC) throw new Error(t("ed.load.notProject.msg"));
  if (typeof doc.version !== "number" || doc.version > PROJECT_VERSION) {
    throw new Error(
      t("ed.load.newerVersion.msg", { version: doc.version })
    );
  }
  if (doc.width !== W || doc.height !== H) {
    throw new Error(t("ed.load.badSize.msg"));
  }
  // v1 は indexBits 無し → 8bit（従来と同一の可逆ロード）
  const bits: 8 | 16 = doc.indexBits === 16 ? 16 : 8;
  const expected = PIXELS * (bits / 8);
  const frames: Frame[] = (doc.frames as SerializedFrame[]).map((sf) => {
    const layers: Record<string, IndexBuf> = {};
    for (const [id, b64] of Object.entries(sf.layers)) {
      const raw = base64ToBytes(b64);
      if (raw.length !== expected) throw new Error(t("ed.load.badLayer.msg"));
      layers[id] =
        bits === 16
          ? new Uint16Array(raw.buffer, 0, PIXELS) // base64ToBytes はオフセット0の自前バッファ（LE）
          : raw;
    }
    return {
      paper: sf.paper,
      layers,
      order: sf.order,
      // v5: SE配置（未知idの除去は最後の sanitizeAudio が行う）
      se: Array.isArray(sf.se) ? sf.se.filter((x) => typeof x === "string") : undefined,
    };
  });
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
