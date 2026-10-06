// V195 (A-99・Discord REQ-009): 上の色の帯（作品の colorTable）から色を消す前に、その色を「使っているか」を調べる。
//
// ★決まり（REQ_discord_tickets_1004 §4）
//   帯の色を右クリック → 確かめてから消す。**その色を使っているときは消さない**。「使っている」の範囲は
//   ① 全コマ・全レイヤー（眠っているコマも）② 紙の色 ③ 取り消し／やり直しの記録の中の絵。どれか 1 つに当たれば消さない。
//   ④ コピー中の絵（範囲のクリップボード `Editor.clipboard`・レイヤーのクリップボード `layerClip`）も数える——
//   どちらも色の**番号**のまま持っていて、消したあとに貼ると番号が色を失う（③と同じ理由・要件の趣旨に沿って足した）。
//   ページのクリップボード（frameClip）は色を hex で持ち、貼るときに番号を引き直すので数えない。
//   マイ柄・よく使う色の棚も hex なので数えない（作品の色ではない）。
//
// ★消し方（editor.ts `deletePaletteColor`）: 番号は詰めず、**空き番号として残す**（colorTable[k] = ""）。
//   使っていないことを確かめてから空けるので、**絵の画素は 1 つも書き換えない**（IndexBuf に触れない）。
//   空きの "" は番号 0（透明の予約）と同じ形で、今の読み手（v1.9.0 の serialize.ts / pv6.ts・ギャラリー）は
//   colorTable を検めずにそのまま受け取り、`buildLut` は "" を飛ばす＝どの読み手でも開ける（v195_smoke [A99-4]）。
//   空いた番号は `ensureColor` が再利用しない（`indexOf(hex)` は "" に当たらない）＝消した色を指す画素は二度と生まれない。
//
// ★眠っているコマは**起こさない**（V156 の窓の決まり・P-0）。控え（gzip）を 1 枚ずつ展開して見て、すぐ手放す
//   （`borrowLayerBytes`＝保存と同じ借り方）。展開した結果は「その控えに入っている番号の一覧」だけを控えの実体に
//   ひもづけて覚える（WeakMap・控えが作り直されれば自然に消える）＝2 回目からは展開しない。
//   1 回目も、**中身が 1 バイトも違わない控えは 1 回だけ展開する**（コマの複製は同じ絵を別々の控えに持つ）・
//   1 コマのぶんは並べて展開する。作者の 3,175 コマ × 20 レイヤーの作品（眠っている面 63,420）で、1 回目は
//   1 枚ずつ展開する形の 22,462ms → 1,007ms（Node）・950ms（Chromium）。2 回目からは 11〜17ms（V195 報告書 §4）。
//   起きているレイヤーは毎回 `indexOf` で見る（書き換わるので覚えない）。数ミリ秒ごとに譲る（大きい作品で固めない）。

import type { Project, Frame, IndexBuf } from "./model";
import { frameLayerIds, borrowLayerBytes } from "./sleep";
import { colorRefsUnknown, type HistoryEntry } from "./history";

/** 帯から消そうとしている色の番号（同じ hex が複数の番号にあれば全部・0 は透明の予約なので入れない） */
export function colorSlots(p: Project, hex: string): number[] {
  const h = (hex ?? "").toLowerCase();
  const out: number[] = [];
  if (!h) return out;
  for (let i = 1; i < p.colorTable.length; i++) if ((p.colorTable[i] ?? "").toLowerCase() === h) out.push(i);
  return out;
}

/** 調べた結果 */
export interface ColorUse {
  /** その色を使っているコマの数（レイヤーの画素か紙の色）。0 でなければ消さない（下の 2 つは調べない） */
  frames: number;
  /** 取り消し・やり直しの記録の中の絵で使っている（申告の無いエントリがあるときも true＝網） */
  history: boolean;
  /** コピー中の絵（範囲・レイヤーのクリップボード）で使っている */
  clip: boolean;
}

export type ColorVerdict = "frames" | "history" | "clip" | "ok";

/** 消してよいか。理由は「コマ → 記録 → コピー」の順に 1 つだけ返す（知らせる文も 1 つ） */
export function colorDeleteVerdict(u: ColorUse): ColorVerdict {
  if (u.frames > 0) return "frames";
  if (u.history) return "history";
  if (u.clip) return "clip";
  return "ok";
}

export interface ColorScanSources {
  /** 履歴が抱えているエントリ全部（`History.entriesForScan()`） */
  history: readonly HistoryEntry[];
  /** コピー中の絵（索引バッファ） */
  clips: readonly (IndexBuf | null | undefined)[];
}

/** 索引バッファにその番号のどれかがあるか（8bit のバッファに 256 以上の番号は無い） */
export function bufHasAny(buf: ArrayLike<number> & { indexOf(v: number): number }, slots: readonly number[], bits8: boolean): boolean {
  for (const k of slots) {
    if (bits8 && k > 255) continue;
    if (buf.indexOf(k) !== -1) return true;
  }
  return false;
}

/** 控え（gzip）の実体 → その中にある番号の一覧（昇順・重複なし） */
const sleepValues = new WeakMap<Uint8Array, Uint16Array>();
/** 番号の一覧を作るときの目印（作り直さない・使ったら戻す） */
let marks: Uint8Array | null = null;

function uniqueValues(view: Uint8Array | Uint16Array): Uint16Array {
  if (!marks) marks = new Uint8Array(65536);
  const m = marks;
  const seen: number[] = [];
  for (let i = 0; i < view.length; i++) {
    const v = view[i];
    if (m[v] === 0) {
      m[v] = 1;
      seen.push(v);
    }
  }
  for (const v of seen) m[v] = 0; // 目印を戻す（次の呼び出しのため）
  seen.sort((a, b) => a - b);
  return Uint16Array.from(seen);
}

/** 2 つの控え（gzip のバイト列）が 1 バイトも違わないか */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const n = a.byteLength >>> 2;
    const wa = new Uint32Array(a.buffer, a.byteOffset, n);
    const wb = new Uint32Array(b.buffer, b.byteOffset, n);
    for (let i = 0; i < n; i++) if (wa[i] !== wb[i]) return false;
    for (let i = n << 2; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 控えを中身で仕分けるための目印（長さ＋あちこちから拾った 24 バイト。gzip の頭 10 バイトは毎回同じなので飛ばす）。
 *  目印が同じでも**中身はバイト単位で比べてから**使う（目印だけを信じない＝取り違えて「使っていない」と言わない） */
export function sampleKey(bits: number, z: Uint8Array): string {
  const n = z.byteLength;
  let k = `${bits}:${n}:`;
  if (n <= 10) return k + Array.from(z).join(",");
  for (let i = 0; i < 24; i++) k += z[10 + Math.floor(((n - 11) * i) / 23)] + ",";
  return k;
}

/** 同じ中身の控えを探す。**幅もバイトも 1 つ残らず同じ**ときだけ見つかる（目印が同じだけでは使い回さない） */
export function findSameControl<T extends { bits: number; z: Uint8Array }>(list: readonly T[], bits: number, z: Uint8Array): T | undefined {
  return list.find((x) => x.bits === bits && sameBytes(x.z, z));
}

/** 1 回の調べの中で、同じ中身の控えを 1 回だけ展開するための控え（調べ終わったら捨てる＝控えの実体を握り続けない）。
 *  作者の大きい作品（3,175 コマ × 20 レイヤー）は 63,420 枚の控えのうち中身が違うのは約 2,600 枚
 *  （KD-192: コマの複製は深いコピーなので、同じ絵が別々の控えになる） */
export type ContentCache = Map<string, { bits: number; z: Uint8Array; vals: Promise<Uint16Array | null> }[]>;

/** 眠っているレイヤーにその番号のどれかがあるか（起こさない・展開した結果は番号の一覧だけ覚える） */
async function asleepHasAny(
  p: Project,
  f: Frame,
  id: string,
  slots: readonly number[],
  cc: ContentCache
): Promise<boolean> {
  const e = f.sleep?.[id];
  if (!e) return false;
  let vals: Uint16Array | null | undefined = sleepValues.get(e.z);
  if (!vals) {
    const key = sampleKey(e.bits, e.z);
    const list = cc.get(key) ?? [];
    const hit = findSameControl(list, e.bits, e.z);
    if (hit) vals = await hit.vals;
    else {
      const z = e.z;
      const pr = borrowLayerBytes(p, f, id).then((b) => {
        if (!b) return null;
        const view =
          b.bits === 16 ? new Uint16Array(b.raw.buffer, b.raw.byteOffset, b.raw.byteLength >>> 1) : b.raw;
        return uniqueValues(view);
      });
      list.push({ bits: e.bits, z, vals: pr });
      cc.set(key, list);
      vals = await pr;
    }
    if (!vals) return false;
    sleepValues.set(e.z, vals);
  }
  for (const k of slots) if (vals.includes(k)) return true;
  return false;
}

/** 1 コマ（紙・起きているレイヤー・眠っている控え）にその番号のどれかがあるか。
 *  `memo` は同じバッファ実体（📌 全コマ共通レイヤー）を 1 回だけ見るための控え */
async function frameHasAny(
  p: Project,
  f: Frame,
  slots: readonly number[],
  memo: Map<IndexBuf, boolean>,
  cc: ContentCache,
  tick: () => Promise<void>
): Promise<boolean> {
  if (slots.includes(f.paper)) return true;
  // 眠っている控えは**そのコマのぶんを並べて展開する**（wakeFrame と同じ形。逐次より速い）
  const asleep: string[] = [];
  for (const id of frameLayerIds(f)) {
    const b = f.layers[id];
    if (b) {
      let r = memo.get(b);
      if (r === undefined) {
        r = bufHasAny(b, slots, b instanceof Uint8Array);
        memo.set(b, r);
      }
      if (r) return true;
    } else asleep.push(id);
  }
  if (asleep.length) {
    const rs = await Promise.all(asleep.map((id) => asleepHasAny(p, f, id, slots, cc)));
    if (rs.some(Boolean)) return true;
  }
  await tick();
  return false;
}

/** その番号（`slots`）を使っている所を調べる。`yieldNow` は大きい作品で画面を固めないための譲り
 *  （editor は MessageChannel で譲る）。`budgetMs` ごとに 1 回譲る。 */
export async function scanColorUse(
  p: Project,
  slots: readonly number[],
  src: ColorScanSources,
  yieldNow: () => Promise<void>,
  budgetMs = 12
): Promise<ColorUse> {
  const use: ColorUse = { frames: 0, history: false, clip: false };
  if (slots.length === 0) return use;
  let t0 = performance.now();
  const tick = async () => {
    if (performance.now() - t0 < budgetMs) return;
    await yieldNow();
    t0 = performance.now();
  };
  const memo = new Map<IndexBuf, boolean>();
  const cc: ContentCache = new Map();
  // ① ② 全コマ（紙・全レイヤー・眠っている控え）
  for (const f of p.frames) if (await frameHasAny(p, f, slots, memo, cc, tick)) use.frames++;
  if (use.frames > 0) return use; // コマで使っていれば消さない＝ここで決まる（知らせる文はコマ数）
  // ③ 取り消し・やり直しの記録（作品にいま入っているコマは ① で見たので飛ばす）
  const live = new Set<Frame>(p.frames);
  scan: for (const e of src.history) {
    if (colorRefsUnknown(e)) {
      use.history = true; // 網: 画素を抱えているのに申告が無い＝分からないので消さない
      break;
    }
    const r = e.colorRefs?.();
    if (!r) continue;
    for (const pp of r.papers ?? []) if (slots.includes(pp)) {
      use.history = true;
      break scan;
    }
    for (const b of r.bufs ?? []) {
      if (!b) continue;
      let hit = memo.get(b);
      if (hit === undefined) {
        hit = bufHasAny(b, slots, b instanceof Uint8Array);
        memo.set(b, hit);
      }
      if (hit) {
        use.history = true;
        break scan;
      }
      await tick();
    }
    for (const f of r.frames ?? []) {
      if (live.has(f)) continue;
      if (await frameHasAny(p, f, slots, memo, cc, tick)) {
        use.history = true;
        break scan;
      }
    }
  }
  if (use.history) return use;
  // ④ コピー中の絵
  for (const b of src.clips) if (b && bufHasAny(b, slots, b instanceof Uint8Array)) use.clip = true;
  return use;
}
