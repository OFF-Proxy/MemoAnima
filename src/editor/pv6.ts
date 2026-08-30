// V163 (A-40): 保存形式 PV6 — 「塊（レイヤー単位 gzip）＋ヘッダ」の二部構成。
//
// ★器（REQ_format_pv6.md §5 で確定・V162 スパイクで実測済み）:
//   [gzip(ヘッダ JSON)]   … 先頭が 1f 8b ＝旧ビルドが gzip として読み始められる（断り方の要）
//   [塊の並び]            … レイヤー単位の gzip × n（生バイナリ・base64 全廃）
//   [トレーラ 16B]        … "AMPV6END"(8) + u32LE headerGzLen + u32LE blobSectionLen
//
// ★なぜこの形か（数字は V162 スパイク・再現データ 1,098コマ×20レイヤー）:
//   - 開く 39.9s → 0.13〜0.2s: 塊を**そのまま V156 の眠り控えへ**写す（parse も展開も無い）
//   - 保存 30s → 0.5s: 眠っている塊は entry.z を**そのまま書く**（再圧縮ゼロ・窓だけ圧縮）
//   - 96.2 → 68.7MB: base64 の 4/3 が消える＋📌 は塊1個を全コマが参照（A-34）
//
// ★互換の要（v163_smoke が固定する）:
//   - ヘッダ JSON のキー順は **magic/version/width/height が先頭・blobs は frames の後**。
//     旧ビルドの earlyCheck は `"frames":[` までを JSON.parse するので、この順であれば
//     「このファイルは新しいバージョン（v6）で作られています」と**きれいに断れる**
//     （V162 で Node と Chromium の両方で実測）。順が崩れると生の JSON エラーが出てしまう。
//   - トレーラの headerGzLen/blobSectionLen は u32。**4GiB 以上は書けない**（明示的に断る。
//     blobSectionLen は fileLen−16−headerGzLen からも導けるが、検算のため両方書く）。
//   - 塊表 `blobs[].c` は**圧縮バイト列の CRC32**。検証（tier1.5）が展開せずに
//     「塊の中身1バイトの化け」まで捕まえるための列（V162 S-4 で故意破損により実証）。
//
// ★依存は model / i18n / sleep だけ（serialize からは importしない＝一方向）。
//   serialize.ts が isPV6 で振り分けてここを呼ぶ。Worker からも import される
//   （DOM に触らないこと。CompressionStream / TextEncoder / DataView は Worker で使える）。
import { t } from "../i18n";
import {
  PIXELS,
  W,
  H,
  type Project,
  type Frame,
  type IndexBuf,
} from "./model";
import type { EncodeInterruptOpts } from "./serialize";

export const PV6_TRAILER_MAGIC = "AMPV6END";
/** トレーラの大きさ（"AMPV6END" 8B + u32 headerGzLen + u32 blobSectionLen） */
export const PV6_TRAILER_LEN = 16;
/** u32 に収まる上限。ヘッダ gzip／塊セクションがこれを超える保存は明示的に断る */
const U32_MAX = 0xffffffff;

const enc = new TextEncoder();
const dec = new TextDecoder();

const gzipBytes = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer()
  );

const gunzipBytes = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
    ).arrayBuffer()
  );

function viewBytes(buf: IndexBuf): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ---- base64（音声だけ。画素は生バイナリなので通らない） ----
// serialize.ts と同じ「ネイティブ toBase64 の自己確認つき採用」。ここは serialize を
// import しない（一方向依存）ため小さく持ち直す。出力は RFC4648 パディング付きで同一。
function legacyB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
const nativeB64Ok = (() => {
  try {
    const probe = (n: number) => {
      const v = new Uint8Array(n);
      for (let i = 0; i < n; i++) v[i] = (i * 37 + 5) & 0xff;
      const f = (v as unknown as { toBase64?: () => string }).toBase64;
      return typeof f === "function" && f.call(v) === legacyB64(v);
    };
    return probe(12) && probe(13) && probe(14);
  } catch {
    return false;
  }
})();
function b64(bytes: Uint8Array): string {
  if (nativeB64Ok) return (bytes as unknown as { toBase64(): string }).toBase64();
  return legacyB64(bytes);
}

/** 塊表の1行。キー名は1文字（21,960 行がヘッダ JSON に並ぶため） */
export interface Pv6BlobMeta {
  /** 塊セクション先頭からの相対オフセット */
  o: number;
  /** 圧縮後の長さ */
  n: number;
  /** 書いたときの索引幅 */
  b: 8 | 16;
  /** 展開後の長さ（gzip 末尾の ISIZE と突き合わせる） */
  r: number;
  /** **圧縮バイト列**の CRC32（検証 tier1.5 が展開せずに中身を照合する） */
  c: number;
}

// CRC32（IEEE・zlib と同じ多項式）。slice-by-8（8テーブル・8バイトずつ）——
// 1バイトずつのテーブル法は実測 95MB/s で、69.7MB の塊走査が保存・検証の両方の主費用に
// なってしまう（V163 実測）。slice-by-8 で約4倍になり、保存 1.0s→検証込みでもスパイク値
//（保存 0.5s・検証 0.32s）に収まる。u32 の読みは little-endian 前提（x86/ARM の実行環境は
// すべて LE。本アプリは Windows 配布のみ）。テーブルは初回に1度だけ作る（8KB）
const CRC_TABLES = (() => {
  const t = new Uint32Array(256 * 8);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  for (let s = 1; s < 8; s++) {
    for (let i = 0; i < 256; i++) {
      const prev = t[(s - 1) * 256 + i];
      t[s * 256 + i] = (t[prev & 0xff] ^ (prev >>> 8)) >>> 0;
    }
  }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  const T = CRC_TABLES;
  let c = 0xffffffff;
  let i = 0;
  const n = bytes.length;
  // 塊はファイルバッファへの subarray ＝ 4バイト境界に揃っていないことがある。
  // 境界まで1バイトずつ進めてから u32 で読む
  while (i < n && ((bytes.byteOffset + i) & 3) !== 0) {
    c = T[(c ^ bytes[i++]) & 0xff] ^ (c >>> 8);
  }
  const words = (n - i) >> 3;
  if (words > 0) {
    const w = new Uint32Array(bytes.buffer, bytes.byteOffset + i, words * 2);
    for (let j = 0; j < words * 2; j += 2) {
      const one = (w[j] ^ c) >>> 0;
      const two = w[j + 1] >>> 0;
      c =
        (T[7 * 256 + (one & 0xff)] ^
          T[6 * 256 + ((one >>> 8) & 0xff)] ^
          T[5 * 256 + ((one >>> 16) & 0xff)] ^
          T[4 * 256 + (one >>> 24)] ^
          T[3 * 256 + (two & 0xff)] ^
          T[2 * 256 + ((two >>> 8) & 0xff)] ^
          T[1 * 256 + ((two >>> 16) & 0xff)] ^
          T[two >>> 24]) >>>
        0;
    }
    i += words * 8;
  }
  for (; i < n; i++) c = T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** レイヤーの並び（serialize.ts の orderedLayerIds と同じ規則: layerDefs 順＋はぐれ）。
 *  眠り→起きるで `f.layers` の挿入順が変わっても保存バイト列が揺れないための決め打ち。 */
function orderedIds(p: Project, f: Frame): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ld of p.layerDefs)
    if (f.layers[ld.id] || f.sleep?.[ld.id]) {
      out.push(ld.id);
      seen.add(ld.id);
    }
  for (const id of Object.keys(f.layers)) if (!seen.has(id)) { out.push(id); seen.add(id); }
  if (f.sleep) for (const id of Object.keys(f.sleep)) if (!seen.has(id)) { out.push(id); seen.add(id); }
  return out;
}

/** 保存の内訳（報告・ログ用。W-10: 作品名やパスは含めない） */
export interface Pv6Stats {
  blobCount: number;
  refCount: number;
  headerGzLen: number;
  blobSectionLen: number;
  /** 眠り控えをそのまま写した塊の数（再圧縮ゼロ） */
  reusedSleepZ: number;
  /** 起きていて圧縮した塊の数 */
  compressedAwake: number;
}

/** ★互換の要: ヘッダ JSON の**キー順の自己検査**。
 *
 *  旧ビルド（v1.5.10 まで）の earlyCheck は `"frames":[` までを JSON.parse して
 *  version を見る。だから magic/version/width/height が**先頭に**あり、塊表 blobs が
 *  **frames の後ろに**あることが「きれいに断る」の条件（V162 で両エンジン実測）。
 *  serialize.ts の `endsWith('"frames":[]}')` 検査と同じ流儀で、書くたびに確かめる。 */
export function assertPv6HeaderOrder(headJson: string): void {
  const prefix = `{"magic":"ANIMEMO","version":6,"width":${W},"height":${H},`;
  const fr = headJson.indexOf('"frames":[');
  const bl = headJson.indexOf('"blobs":[');
  if (!headJson.startsWith(prefix) || fr < 0 || bl < 0 || bl < fr) {
    throw new Error(t("ed.save.internalOrder.msg"));
  }
}

/** PV6 で書く。
 *
 *  - 眠っている塊（`f.sleep[id].z`）は**そのまま**写す（再圧縮しない＝保存 0.5s の理由）
 *  - 起きているバッファはレイヤー単位で gzip（V156 の眠り控えと同一の形式）
 *  - 同じ実体（バッファ／z）は塊1個に**まとめる**＝📌 共通レイヤーは1回だけ書かれる（A-34）
 *  - `opts`（オートセーブ用）: `aborted` が true を返したら**null を返して破棄**、
 *    `yieldNow` で約8msごとにメインスレッドを譲る（serialize.ts の分割エンコードと同じ作法）
 */
export async function encodePV6(
  p: Project,
  opts?: EncodeInterruptOpts
): Promise<{ bytes: Uint8Array; stats: Pv6Stats } | null> {
  // 防御: 16bit バッファ（起きている Uint16Array／眠り控えの bits:16）が1枚でもあれば
  // ヘッダは indexBits:16 として書く——serialize.ts の encodeProjectHead と同じ判定
  //（Codex V163 指摘①: p.indexBits が 8 のままズレていると「8bit ヘッダ＋16bit 塊」の
  //  自分で読めないファイルができる。眠りは**起こさずに**控えの幅だけ見る）
  let bits: 8 | 16 = p.indexBits === 16 ? 16 : 8;
  if (bits === 8) {
    outer: for (const f of p.frames) {
      for (const b of Object.values(f.layers)) {
        if (b instanceof Uint16Array) {
          bits = 16;
          break outer;
        }
      }
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
  const blobs: Uint8Array[] = [];
  const metas: Pv6BlobMeta[] = [];
  const byKey = new Map<object, number>();
  let off = 0;
  let reused = 0;
  let compressed = 0;
  let refs = 0;
  let sliceStart = typeof performance !== "undefined" ? performance.now() : 0;

  const frames: Record<string, unknown>[] = [];
  for (const f of p.frames) {
    if (opts?.aborted?.()) return null;
    const layers: Record<string, number> = {};
    for (const id of orderedIds(p, f)) {
      const buf = f.layers[id];
      const entry = !buf ? f.sleep?.[id] : undefined;
      const key: object | undefined = buf ?? entry?.z;
      if (!key) continue; // 起きても眠ってもいない＝そのレイヤーは無い
      let idx = byKey.get(key);
      if (idx === undefined) {
        let z: Uint8Array;
        let bbits: 8 | 16;
        let raw: number;
        if (buf) {
          z = await gzipBytes(viewBytes(buf));
          bbits = buf instanceof Uint16Array ? 16 : 8;
          raw = buf.byteLength;
          compressed++;
        } else {
          z = entry!.z; // ★再圧縮しない＝控えをそのまま書く
          bbits = entry!.bits;
          raw = PIXELS * (bbits / 8);
          reused++;
        }
        idx = blobs.length;
        blobs.push(z);
        metas.push({ o: off, n: z.length, b: bbits, r: raw, c: crc32(z) });
        off += z.length;
        // u32 の上限は**塊を積むたび**に見る（Codex 指摘④: 全部圧縮し終えてから
        // 気づくのでは、4GiB 級で何分も待たせた末に失敗する）
        if (off > U32_MAX) {
          throw new Error(`PV6: blob section exceeds u32 trailer (${off} bytes)`);
        }
        byKey.set(key, idx);
      }
      layers[id] = idx;
      refs++;
    }
    // キー順は PV5 の SerializedFrame と同じ（paper, layers, order, se, layerColors）
    const sf: Record<string, unknown> = { paper: f.paper, layers };
    if (f.order) sf.order = f.order;
    if (f.se && f.se.length > 0) sf.se = f.se;
    if (f.layerColors && Object.keys(f.layerColors).length > 0) sf.layerColors = f.layerColors;
    frames.push(sf);
    if (opts?.yieldNow && performance.now() - sliceStart > 8) {
      await opts.yieldNow();
      sliceStart = performance.now();
    }
  }
  if (opts?.aborted?.()) return null;

  // ヘッダ。★キー順（magic/version/width/height 先頭・blobs は frames の後）は互換の要件。
  // 中身のフィールドは serialize.ts の encodeProjectHead と同じ列挙（未知キーを増やさない）
  const doc: Record<string, unknown> = {
    magic: "ANIMEMO",
    version: 6,
    width: p.width,
    height: p.height,
    colorTable: p.colorTable,
    indexBits: bits,
    layerDefs: p.layerDefs,
    folders: p.folders && p.folders.length > 0 ? p.folders : undefined,
    speedIndex: p.speedIndex,
    loop: p.loop,
    thumbFrame: Math.max(0, Math.min(p.frames.length - 1, Math.floor(p.thumbFrame ?? 0))),
    colorMode: p.colorMode,
    nextLayerId: p.nextLayerId,
    meta: { ...p.meta, modifiedAt: new Date().toISOString() },
    nextSeId: p.nextSeId,
    audio: p.audio
      ? {
          bgm: p.audio.bgm
            ? {
                source: p.audio.bgm.source,
                mime: p.audio.bgm.mime,
                data: b64(p.audio.bgm.data),
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
            data: b64(s.data),
            volume: s.volume,
            muted: s.muted,
          })),
        }
      : undefined,
    frames,
    blobs: metas,
  };
  const headJson = JSON.stringify(doc);
  assertPv6HeaderOrder(headJson);
  const headerGz = await gzipBytes(enc.encode(headJson));
  if (opts?.aborted?.()) return null;

  // トレーラは u32 ×2。超える保存は**明示的に**断る（黙って mod 2^32 を書かない）。
  // blobSectionLen は fileLen−16−headerGzLen からも導けるが、検算のため両方書く
  if (headerGz.length > U32_MAX || off > U32_MAX) {
    throw new Error(`PV6: section too large for u32 trailer (header=${headerGz.length} blobs=${off})`);
  }
  const total = headerGz.length + off + PV6_TRAILER_LEN;
  const out = new Uint8Array(total);
  out.set(headerGz, 0);
  let o = headerGz.length;
  for (const z of blobs) {
    out.set(z, o);
    o += z.length;
  }
  out.set(enc.encode(PV6_TRAILER_MAGIC), o);
  const dv = new DataView(out.buffer);
  dv.setUint32(o + 8, headerGz.length, true);
  dv.setUint32(o + 12, off, true);
  return {
    bytes: out,
    stats: {
      blobCount: blobs.length,
      refCount: refs,
      headerGzLen: headerGz.length,
      blobSectionLen: off,
      reusedSleepZ: reused,
      compressedAwake: compressed,
    },
  };
}

/** PV6 か（先頭 1f 8b ＋ 末尾トレーラの magic）。PV1〜5 の gzip 末尾（CRC32+ISIZE の
 *  8バイト）が偶然 "AMPV6END" の ASCII になることはない（検査済みの決め打ちではなく、
 *  トレーラは 16B なのでファイル末尾 16B の**先頭 8B** を見る＝PV5 の末尾 8B とは位置も違う）。 */
export function isPV6(bytes: Uint8Array): boolean {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return false;
  const tail = dec.decode(bytes.subarray(bytes.length - 16, bytes.length - 8));
  return tail === PV6_TRAILER_MAGIC;
}

/** ヘッダ doc（読み込み中は未知の形も通すので緩く受ける。serialize.ts の LoadedDoc と同じ流儀） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pv6Doc = Record<string, any>;

interface Pv6SerializedFrame {
  paper: number;
  layers: Record<string, number>;
  order?: string[];
  se?: string[];
  layerColors?: Record<string, string>;
}

/** トレーラ→ヘッダ→塊表の3手で読む。壊れ方に応じて**利用者向けの文言**で断る
 *  （serialize.ts の LoadError と同じ考え方。ここの throw はそのまま画面の帯に出る）。 */
async function readPv6Header(
  bytes: Uint8Array
): Promise<{ doc: Pv6Doc; blobBase: number }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(bytes.length - 8, true);
  const blobLen = dv.getUint32(bytes.length - 4, true);
  if (headerLen + blobLen + PV6_TRAILER_LEN !== bytes.length) {
    throw new Error(t("ed.load.decompressFailed.msg"));
  }
  let doc: Pv6Doc;
  try {
    doc = JSON.parse(dec.decode(await gunzipBytes(bytes.subarray(0, headerLen)))) as Pv6Doc;
  } catch {
    // ヘッダ gzip の CRC 不一致・JSON の壊れ＝ファイルが壊れている
    throw new Error(t("ed.load.decompressFailed.msg"));
  }
  if (doc.magic !== "ANIMEMO") throw new Error(t("ed.load.notProject.msg"));
  if (typeof doc.version !== "number" || doc.version < 6) {
    throw new Error(t("ed.load.notProject.msg"));
  }
  if (doc.version > 6) {
    throw new Error(t("ed.load.newerVersion.msg", { version: doc.version }));
  }
  if (doc.width !== W || doc.height !== H) throw new Error(t("ed.load.badSize.msg"));
  if (!Array.isArray(doc.frames) || !Array.isArray(doc.blobs)) {
    throw new Error(t("ed.load.notProject.msg"));
  }
  return { doc, blobBase: headerLen };
}

/** 塊表の構造検査（tier1 相当・展開しない）: 連続・非負整数・収まり・gzip マジック・
 *  ISIZE（末尾4B＝展開後長）・raw 長が画素数どおり。withCrc で全塊の CRC32 走査を足す（tier1.5）。
 *  **verifyPV6 と通常の読み込み（decodePv6）の両方がここを通る**——読み込み時に壊れた塊が
 *  眠り控えとして紛れ込み、あとでコマ移動や書き出しのときに初めて落ちるのを防ぐ
 *（Codex V163 指摘③）。戻り値は不合格の理由（ASCII・ログ用）／null＝合格。 */
function blobTableIssue(
  bytes: Uint8Array,
  blobBase: number,
  metas: Pv6BlobMeta[],
  withCrc: boolean
): { reason: string; rawBytes: number } | null {
  let off = 0;
  let rawBytes = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    if (
      !m ||
      !Number.isInteger(m.o) ||
      !Number.isInteger(m.n) ||
      !Number.isInteger(m.r) ||
      typeof m.c !== "number" ||
      m.o < 0 ||
      m.n < 18
    )
      return { reason: `blob ${i} bad-meta`, rawBytes };
    if (m.o !== off) return { reason: `blob ${i} offset-gap`, rawBytes };
    off += m.n;
    const s = blobBase + m.o;
    if (s + m.n > bytes.length - PV6_TRAILER_LEN)
      return { reason: `blob ${i} out-of-bounds`, rawBytes };
    if (bytes[s] !== 0x1f || bytes[s + 1] !== 0x8b)
      return { reason: `blob ${i} not-gzip`, rawBytes };
    // gzip の ISIZE（末尾4B・LE）＝展開後の長さ。展開せずに検査できる
    const isize = dv.getUint32(s + m.n - 4, true);
    if (isize !== m.r) return { reason: `blob ${i} isize-mismatch`, rawBytes };
    const expect = PIXELS * ((m.b === 16 ? 16 : 8) / 8);
    if (m.r !== expect) return { reason: `blob ${i} raw-len`, rawBytes };
    // tier1.5: 圧縮バイト列そのものを CRC32 で照合（展開しない＝メモリ走査だけ）。
    // 表の値そのものはヘッダ gzip の CRC が守っている
    if (withCrc && crc32(bytes.subarray(s, s + m.n)) !== (m.c >>> 0))
      return { reason: `blob ${i} crc32-mismatch`, rawBytes };
    rawBytes += m.r;
  }
  // トレーラの blobSectionLen と塊表の合計が一致するか（readPv6Header はファイル長との
  // 整合しか見ていない。表の最後の塊が短く申告されていると余りバイトが生まれる）
  if (blobBase + off !== bytes.length - PV6_TRAILER_LEN)
    return { reason: "blob-section-len-mismatch", rawBytes };
  return null;
}

/** V157 (D-2) と同じ規則: "#RRGGBB" だけ通す（serialize.ts の sanitizeFrameColors と同一。
 *  こちらは serialize を import しない一方向依存のため、小さな規則をここに持ち直す） */
function cleanFrameColors(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [id, c] of Object.entries(v as Record<string, unknown>)) {
    if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) out[id] = c;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 塊 idx → IndexBuf（読み側の幅 `bits` へ広げて返す。同じ idx は**同じ実体**＝📌 の復元）。 */
async function inflateBlob(
  bytes: Uint8Array,
  blobBase: number,
  doc: Pv6Doc,
  idx: number,
  bits: 8 | 16,
  cache: Map<number, IndexBuf>
): Promise<IndexBuf> {
  const hit = cache.get(idx);
  if (hit) return hit;
  const m = doc.blobs[idx] as Pv6BlobMeta;
  let raw: Uint8Array;
  try {
    raw = await gunzipBytes(bytes.subarray(blobBase + m.o, blobBase + m.o + m.n));
  } catch {
    throw new Error(t("ed.load.badLayer.msg"));
  }
  if (raw.length !== m.r) throw new Error(t("ed.load.badLayer.msg"));
  let buf: IndexBuf;
  if (m.b === 16 || bits === 8) {
    if (raw.length !== PIXELS * (bits / 8)) throw new Error(t("ed.load.badLayer.msg"));
    buf = bits === 16 ? new Uint16Array(raw.buffer, raw.byteOffset, PIXELS) : raw;
  } else {
    // 8bit で書かれた塊を 16bit の作品で使う（値保存の widening。narrowing は無い）
    if (raw.length !== PIXELS) throw new Error(t("ed.load.badLayer.msg"));
    const wide = new Uint16Array(PIXELS);
    wide.set(raw);
    buf = wide;
  }
  cache.set(idx, buf);
  return buf;
}

/** 遅延読みのしきい値。これ未満の作品は**全部起こして**返す（眠りの仕掛けを持ち込まない＝
 *  小さい作品はいままでと同じ姿で開く）。editor.ts の SLEEP_MIN_BYTES と同じ 32 MiB。 */
export const PV6_EAGER_MAX_RAW = 32 * 1024 * 1024;

export interface Pv6Decoded {
  doc: Pv6Doc;
  frames: Frame[];
  /** true = 眠り控え（z ビュー）で返した。呼び出し側（serialize）が窓を起こす */
  lazy: boolean;
}

/** PV6 を読む（serialize.projectFromBytes が isPV6 で振り分けて呼ぶ）。
 *
 *  - 大きい作品（論理 32MiB 以上）: 塊を**ファイルバッファへのビュー**のまま
 *    眠り控え（`f.sleep[id]`）に入れて返す（コピーも展開もしない＝開く 0.13s の理由）。
 *    📌 共通レイヤーだけは**先に1回だけ展開**して全コマ同一実体にする
 *    （editor の relinkShared が構造的に満たされる形。眠り控えは作らない）。
 *  - 小さい作品: 全部展開して返す（従来と同じ、全部起きた姿）。
 *
 *  frames の中身（se の型・layerColors の規則）は serialize の frameFromSerialized と
 *  同じ健全化を通す。doc はそのまま返し、Project への組み立て（音声・folders・
 *  layerDefs の掃除・shared 裁定）は serialize 側の**PV5 と同じ道**を通す。 */
export async function decodePv6(
  bytes: Uint8Array,
  onFrame?: (done: number) => void
): Promise<Pv6Decoded> {
  const { doc, blobBase } = await readPv6Header(bytes);
  const bits: 8 | 16 = doc.indexBits === 16 ? 16 : 8;
  const sfs = doc.frames as Pv6SerializedFrame[];
  const metas = doc.blobs as Pv6BlobMeta[];

  // 塊表の構造検査（tier1 相当・展開しない・実測 27〜42ms）。壊れた塊を眠り控えに
  // 入れてしまうと、あとでコマ移動や書き出しのときに初めて落ちる——ここで断る
  const issue = blobTableIssue(bytes, blobBase, metas, false);
  if (issue) throw new Error(t("ed.load.badLayer.msg"));
  // 塊参照の範囲（範囲外の idx で undefined を触らない）
  for (const sf of sfs) {
    if (!sf || typeof sf !== "object" || !sf.layers || typeof sf.layers !== "object") {
      throw new Error(t("ed.load.notProject.msg"));
    }
    for (const idx of Object.values(sf.layers)) {
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= metas.length) {
        throw new Error(t("ed.load.badLayer.msg"));
      }
    }
  }

  // 論理サイズ（生なら何バイトか）で遅延/一括を決める
  let logicalRaw = 0;
  for (const sf of sfs)
    for (const idx of Object.values(sf.layers)) logicalRaw += metas[idx].r;
  const lazy = logicalRaw >= PV6_EAGER_MAX_RAW;

  // 📌 共通レイヤー（shared===true）は遅延でも**先に1回だけ**展開して全コマ同一実体にする。
  // 手で壊されたファイル（コマごとに違う塊を指す）でも、塊 idx ごとのキャッシュなので
  // 「違う実体」がそのまま現れ、serialize 側の shared 裁定（全コマ一致か）が正しく効く
  const sharedIds = new Set<string>();
  if (Array.isArray(doc.layerDefs)) {
    for (const ld of doc.layerDefs) {
      if (ld && typeof ld === "object" && (ld as { shared?: unknown }).shared === true) {
        sharedIds.add((ld as { id: string }).id);
      }
    }
  }

  const cache = new Map<number, IndexBuf>();
  const frames: Frame[] = [];
  for (let i = 0; i < sfs.length; i++) {
    const sf = sfs[i];
    const f: Frame = { paper: sf.paper, layers: {} };
    if (sf.order) f.order = sf.order;
    if (Array.isArray(sf.se)) {
      const se = sf.se.filter((x) => typeof x === "string");
      if (se.length > 0) f.se = se;
    }
    const lc = cleanFrameColors(sf.layerColors);
    if (lc) f.layerColors = lc;
    for (const [id, idx] of Object.entries(sf.layers)) {
      if (lazy && !sharedIds.has(id)) {
        // ★塊はファイルバッファへの**ビュー**（コピーしない）。眠り控えの不変条件
        //  （z は生成後不変・破棄は参照の付け替え）はビューでも成立する
        const m = metas[idx];
        if (!f.sleep) f.sleep = {};
        f.sleep[id] = {
          z: bytes.subarray(blobBase + m.o, blobBase + m.o + m.n),
          bits: m.b === 16 ? 16 : 8,
          live: null,
        };
      } else {
        f.layers[id] = await inflateBlob(bytes, blobBase, doc, idx, bits, cache);
      }
    }
    frames.push(f);
    onFrame?.(frames.length);
  }
  return { doc, frames, lazy };
}

/** V163 (W-6 の後継): 保存した PV6 バイト列の検証。
 *
 *  tier1  … トレーラ整合・ヘッダ gzip CRC・JSON・塊境界の連続/収まり・各塊の gzip マジック・
 *           ISIZE（gzip 末尾4B＝展開後長。**展開せずに**読める）・参照解決・コマ数（27〜42ms）
 *  tier1.5… tier1 ＋ **全塊の CRC32 走査**（ヘッダ表と照合・展開しない。317ms）。
 *           塊の中身1バイトの化けまで捕まえる（V162 S-4 の故意破損で実証: tier1 は素通し）。
 *           現行 W-6（全展開 2.2s・強度は gzip の CRC32）と**同じ CRC32 級の強度を 7 倍速で**
 *  tier2  … 全塊を実際に展開（gzip 自身の CRC まで。6.7〜13.3s。強度は tier1.5 と同等なので常用しない）
 *
 *  戻り値は serialize.verifySavedBytes（SavedCheck）と同じ形（呼び出し側が振り分けるため）。 */
export async function verifyPV6(
  bytes: Uint8Array,
  expectFrames: number,
  tier: 1 | 1.5 | 2 = 1.5
): Promise<{ ok: boolean; reason: string; rawBytes: number; frames: number }> {
  const fail = (reason: string, rawBytes = 0, frames = -1) => ({
    ok: false,
    reason,
    rawBytes,
    frames,
  });
  try {
    let doc: Pv6Doc;
    let blobBase: number;
    try {
      ({ doc, blobBase } = await readPv6Header(bytes));
    } catch (e) {
      // 文言（利用者向け）ではなくログ用の識別子で返す（SavedCheck の作法: reason は ASCII）
      return fail(`pv6-header: ${String((e as Error).message ?? e).slice(0, 80)}`);
    }
    if (doc.width !== W || doc.height !== H) return fail("bad-size");
    const metas = doc.blobs as Pv6BlobMeta[];
    const sfs = doc.frames as Pv6SerializedFrame[];
    const frames = sfs.length;
    // 塊の境界・gzip マジック・ISIZE（＋tier1.5 は CRC32 走査）——decodePv6 と同じ1か所を通す
    const issue = blobTableIssue(bytes, blobBase, metas, tier >= 1.5);
    if (issue) return fail(issue.reason, issue.rawBytes, frames);
    let rawBytes = 0;
    for (const m of metas) rawBytes += m.r;
    // 参照の解決
    for (let fi = 0; fi < sfs.length; fi++) {
      const layers = sfs[fi]?.layers;
      if (!layers || typeof layers !== "object")
        return fail(`frame ${fi} bad-layers`, rawBytes, frames);
      for (const idx of Object.values(layers))
        if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= metas.length)
          return fail(`frame ${fi} ref-out-of-range`, rawBytes, frames);
    }
    if (expectFrames >= 0 && frames !== expectFrames)
      return fail(`frames-mismatch: want ${expectFrames} got ${frames}`, rawBytes, frames);
    if (tier === 2) {
      // 全塊を実際に展開（gzip 自身の CRC・展開長まで）。並列バッチで回す
      const BATCH = 64;
      for (let i = 0; i < metas.length; i += BATCH) {
        try {
          await Promise.all(
            metas.slice(i, i + BATCH).map(async (m, j) => {
              const raw = await gunzipBytes(bytes.subarray(blobBase + m.o, blobBase + m.o + m.n));
              if (raw.length !== m.r) throw new Error(`blob ${i + j} inflate-len`);
            })
          );
        } catch (e) {
          return fail(`inflate: ${String(e).slice(0, 80)}`, rawBytes, frames);
        }
      }
    }
    return { ok: true, reason: "", rawBytes, frames };
  } catch (e) {
    return fail(`pv6-verify: ${String(e).slice(0, 120)}`);
  }
}
