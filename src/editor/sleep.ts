// V156 (P-1): 見えていないコマのレイヤーを gzip で眠らせる。
//
// ★なぜ要るか
//   V155 で大きい作品は「開ける」ようになったが、開いたあとは全コマ・全レイヤーの生ピクセルが
//   メモリに乗りっぱなしになる（再現データ 1,098コマ×20レイヤーで **1.57 GiB**）。
//   1コマだけ見ている間も、遠くの900コマ目が生のまま居座る。
//   スパイク（docs/handoff/V156_spike_report.md）の実測:
//     圧縮率 中央 28.06倍・全体 24.2倍（1.57 GiB → 66.5 MiB）・可逆でなかった面 0
//     展開は Chromium で 1枚 0.70ms・20枚並列で 12.5ms（30fps の 33.33ms に収まる）
//
// ★眠りは**レイヤー単位**（コマ単位ではない）
//   コマ単位にすると「眠っているコマに1枚だけ代入する」（レイヤー削除の undo がやる形）が
//   不正な状態になってしまう。レイヤー単位なら「このレイヤーだけ起きている」が**合法な状態**で、
//   不変条件が1本で済む:
//
//       f.layers[id] がある      ⟺ そのレイヤーは起きている（生の IndexBuf が使える）
//       f.sleep[id] がある       ⟺ そのレイヤーの**圧縮控え**を持っている
//
//     - 眠っている            : sleep だけ
//     - 起きている・控えあり  : 両方（`live` が入っている）＝眠らせるのが**只**
//     - 起きている・控えなし  : layers だけ ＝ 眠らせるには圧縮が要る
//
// ★条件2と条件5（要件 §1 P-1）
//   条件2「**読み**で起こしたコマの控えは捨てない」… 再生は窓が全コマを通るので、
//     起こすたびに控えを捨てると再生1回で 25 秒の再圧縮が走る。だから控えは残す。
//   条件5「**書き**で起こしたコマの控えは必ず捨てる」… 残すと、次に眠るとき
//     **古い絵の控えがそのまま使われ、編集が静かに消える**。
//
//   この2つを両立させる仕掛けが `live`（指紋）:
//     - 読みで起こしたとき、中身の指紋を控えに書いておく
//     - 眠らせ直すとき、**いまの中身の指紋と突き合わせる**
//     - 一致 → 控えはまだ正しい。捨てるだけ（只）
//     - 不一致 → 誰かが書いた。**控えを捨てて圧縮し直す**＋ログに残す
//
//   つまり「書いた経路を全部数え上げる」ことに頼っていない。数え漏れがあっても
//   **絵は失われず、性能が落ちてログに出る**（V155 の「静かに嘘をつかない」と同じ作法）。
//   数え上げ側の手当ては editor 側（`dirty` のセッター＝41箇所が通る1か所と、
//   全コマ操作の明示的な起こし）で行い、こちらはその**網**。

import { PIXELS, type IndexBuf, type Project, type Frame } from "./model";

/** V156: 眠っているレイヤーの控え。 */
export interface SleepEntry {
  /** gzip 済みの生バイト列 */
  z: Uint8Array;
  /** `z` を作ったときの索引幅。起こすとき `p.indexBits` へ広げる（昇格は値保存＝可逆） */
  bits: 8 | 16;
  /** 起きているあいだの指紋（null = いま起きていない＝眠っている）。
   *  `sum` は下の `fingerprint`・`bits` はそのとき広げた幅。 */
  live: { sum: number; bits: 8 | 16 } | null;
}

/** V156: いま眠っている（起きていない）か。 */
export function isAsleep(f: Frame, id: string): boolean {
  return !f.layers[id] && !!f.sleep?.[id];
}

/** V156: そのコマが持つレイヤー id の全部（起きている＋眠っている）。
 *  **面数・論理サイズ・保存はこれを使う**（`Object.keys(f.layers)` を直に使うと眠りぶんが消える）。 */
export function frameLayerIds(f: Frame): string[] {
  const ids = Object.keys(f.layers);
  if (f.sleep) for (const id of Object.keys(f.sleep)) if (!f.layers[id]) ids.push(id);
  return ids;
}

/** V156: そのコマのレイヤー数（`frameLayerIds().length` の速い版）。 */
export function frameLayerCount(f: Frame): number {
  let n = Object.keys(f.layers).length;
  if (f.sleep) for (const id of Object.keys(f.sleep)) if (!f.layers[id]) n++;
  return n;
}

/** V156: 中身の指紋（FNV-1a を 32bit 語ごとに回した版）。
 *
 *  1バイトずつ回すと 76,800 回になるので、**4バイトまとめて** 19,200 回で済ませる
 *  （`base64ToBytes` も `allocIndexBuf` もオフセット0の自前バッファなので Uint32 で覗ける。
 *   覗けない形のときだけバイト単位に落とす）。1レイヤーあたり実測 0.02ms 台。
 *
 *  ここは**安全網**であって、正しさの主役ではない（主役は editor 側の明示的な破棄）。
 *  万一ぶつかっても起きるのは「古い控えを使ってしまう」ことなので、
 *  網としては 32bit で十分だが、**長さと幅も一緒に見る**ことで実質の衝突余地をさらに狭めている。 */
export function fingerprint(buf: IndexBuf): number {
  let h = 0x811c9dc5;
  const bl = buf.byteLength;
  if (buf.byteOffset % 4 === 0 && bl % 4 === 0) {
    const w = new Uint32Array(buf.buffer, buf.byteOffset, bl >>> 2);
    for (let i = 0; i < w.length; i++) {
      h ^= w[i];
      h = Math.imul(h, 0x01000193);
    }
  } else {
    const b = new Uint8Array(buf.buffer, buf.byteOffset, bl);
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  // 長さも混ぜる（幅違いを取り違えない）
  h ^= bl;
  return (Math.imul(h, 0x01000193) >>> 0) || 1; // 0 は「指紋なし」に使わないので避ける
}

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

/** V156: `IndexBuf` → 生バイト列のビュー（コピーしない）。 */
function viewBytes(buf: IndexBuf): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** V156: 生バイト列 → `IndexBuf`。`from` 幅で書かれたものを `to` 幅へ広げる（値は保存）。 */
function bytesToIndexBuf(raw: Uint8Array, from: 8 | 16, to: 8 | 16): IndexBuf {
  if (from === to) {
    if (to === 8) return raw;
    // raw は自前バッファ（オフセット0）なのでそのまま覗ける
    return new Uint16Array(raw.buffer, raw.byteOffset, PIXELS);
  }
  // 8bit で書かれたものを 16bit で使う（昇格後に起こした場合）。narrowing は起きない
  const wide = new Uint16Array(PIXELS);
  wide.set(raw);
  return wide;
}

/** V156: 「誰かが書いた」ことにする＝控えを捨てる。**条件5の主役**。
 *  ここを通ったレイヤーは、次に眠るとき必ず圧縮し直される。 */
export function invalidateLayer(f: Frame, id: string): void {
  if (f.sleep?.[id]) {
    delete f.sleep[id];
    if (Object.keys(f.sleep).length === 0) delete f.sleep;
  }
}

/** V156: そのコマの控えを全部捨てる（コマ丸ごとに書いたとき）。 */
export function invalidateFrame(f: Frame): void {
  if (!f.sleep) return;
  for (const id of Object.keys(f.sleep)) if (f.layers[id]) delete f.sleep[id];
  if (Object.keys(f.sleep).length === 0) delete f.sleep;
}

/** V156: 1レイヤーを起こす。
 *
 *  @param mode "write" なら**控えを捨てる**（＝これから書き換える。条件5）。
 *              "read" なら控えを残す（＝眠らせ直すのが只。条件2）。
 *  すでに起きていれば何もしない（"write" のときだけ控えを捨てる）。 */
export async function wakeLayer(
  p: Project,
  f: Frame,
  id: string,
  mode: "read" | "write"
): Promise<IndexBuf | null> {
  const bits: 8 | 16 = p.indexBits === 16 ? 16 : 8;
  const cur = f.layers[id];
  if (cur) {
    if (mode === "write") invalidateLayer(f, id);
    return cur;
  }
  const e = f.sleep?.[id];
  if (!e) return null; // そのコマにこのレイヤーは無い
  const raw = await gunzipBytes(e.z);
  const buf = bytesToIndexBuf(raw, e.bits, bits);
  f.layers[id] = buf;
  if (mode === "write") invalidateLayer(f, id);
  else e.live = { sum: fingerprint(buf), bits };
  return buf;
}

/** V156: 1コマの全レイヤーを起こす。**展開は並列**（スパイク実測: Chromium の最悪が
 *  逐次 92.1ms → 並列 23.6ms。裾が段違いに安定する）。 */
export async function wakeFrame(p: Project, f: Frame, mode: "read" | "write"): Promise<void> {
  if (!f.sleep) {
    if (mode === "write") invalidateFrame(f);
    return;
  }
  const ids = Object.keys(f.sleep).filter((id) => !f.layers[id]);
  if (ids.length === 0) {
    if (mode === "write") invalidateFrame(f);
    return;
  }
  await Promise.all(ids.map((id) => wakeLayer(p, f, id, mode)));
  if (mode === "write") invalidateFrame(f);
}

/** V156: 眠らせるときにログへ出す口（editor が繋ぐ）。名前もパスも出さない。 */
export let onStaleSleep: ((detail: string) => void) | null = null;
export function setStaleSleepLogger(fn: ((detail: string) => void) | null): void {
  onStaleSleep = fn;
}

/** V156: 1レイヤーを眠らせる。
 *
 *  控えがあり、**指紋が一致していれば圧縮しない**（生を手放すだけ＝只）。
 *  指紋が違えば「誰かが書いた」＝控えを捨てて圧縮し直す＋ログ。
 *  ここが条件2と条件5の合流点。 */
export async function sleepLayer(
  p: Project,
  f: Frame,
  id: string,
  freeOnly = false
): Promise<boolean> {
  const buf = f.layers[id];
  if (!buf) return false; // すでに眠っている／そのレイヤーが無い
  const bits: 8 | 16 = p.indexBits === 16 ? 16 : 8;
  const e = f.sleep?.[id];
  // `freeOnly` = **圧縮の要らないものだけ**片付ける（再生中・描画中に使う）。
  // 控えが生きているぶんは「生を手放すだけ」で只なので、体感に一切出ない。
  // これが無いと、再生中は掃除を止めるしかなく、1周するころには全部が生に戻ってしまう
  if (freeOnly && !(e && e.live)) return false;
  if (e && e.live) {
    if (e.live.bits === bits && e.live.sum === fingerprint(buf)) {
      // 控えはまだ正しい。生を手放すだけ
      e.live = null;
      delete f.layers[id];
      return true;
    }
    // ★数え漏れ（または索引幅が変わった）。**絵は失わない**——控てを捨てて圧縮し直す
    onStaleSleep?.(`stale sleep copy discarded (layer=${id.length}ch)`);
    invalidateLayer(f, id);
  }
  const z = await gzipBytes(viewBytes(buf));
  if (!f.sleep) f.sleep = {};
  f.sleep[id] = { z, bits, live: null };
  delete f.layers[id];
  return true;
}

/** V156: 1コマの全レイヤーを眠らせる。`keep` に入っている id は起きたまま残す（📌 共通レイヤー）。 */
export async function sleepFrame(
  p: Project,
  f: Frame,
  keep?: Set<string>,
  freeOnly = false
): Promise<number> {
  const ids = Object.keys(f.layers).filter((id) => !keep?.has(id));
  if (ids.length === 0) return 0;
  let n = 0;
  for (const id of ids) if (await sleepLayer(p, f, id, freeOnly)) n++;
  return n;
}

/** V156: そのコマから1レイヤーを**完全に**取り除く（起きていても眠っていても）。
 *
 *  ★`delete f.layers[id]` だけでは足りない。眠っているぶんは `f.sleep[id]` にいるので、
 *  そちらを消し忘れると「消したはずのレイヤーが、次に起こしたとき生き返る」。
 *  全コマからレイヤーを消す操作（レイヤー削除・統合・フォルダごと削除・undo の巻き戻し）は
 *  すべてこれを通すこと。 */
export function dropLayer(f: Frame, id: string): void {
  delete f.layers[id];
  invalidateLayer(f, id);
}

/** V156: 指定したレイヤーだけを**全コマで**起こす。
 *
 *  全コマ一括の操作（レイヤー削除・統合・全コマへ貼り付け・📌 ON/OFF・フォルダごと削除）は、
 *  `f.layers[id] ?? allocIndexBuf(p)` の形で書かれている——眠っていると
 *  **空バッファに差し替わって絵が静かに消える**。だから触る前に必ず起こす。
 *
 *  コマ丸ごとではなく**関わるレイヤーだけ**なのが要点。20レイヤーの作品で
 *  1枚だけ起こせば、全部起こすより 20 倍速い（1,098コマで 13.7 秒 → 0.8 秒）。 */
export async function wakeLayersAllFrames(
  p: Project,
  ids: string[],
  mode: "read" | "write"
): Promise<void> {
  for (const f of p.frames) {
    const need = ids.filter((id) => !f.layers[id] && f.sleep?.[id]);
    if (need.length === 0) {
      if (mode === "write") for (const id of ids) invalidateLayer(f, id);
      continue;
    }
    await Promise.all(need.map((id) => wakeLayer(p, f, id, mode)));
    if (mode === "write") for (const id of ids) invalidateLayer(f, id);
  }
}

/** V156: そのコマに眠っているレイヤーが1枚でもあるか（描く前・サムネの前の判定用）。 */
export function frameHasAsleep(f: Frame): boolean {
  if (!f.sleep) return false;
  for (const id of Object.keys(f.sleep)) if (!f.layers[id]) return true;
  return false;
}

/** V156: 眠っているレイヤーの生バイト列を**その場で1枚だけ**取り出す（保存用・条件3）。
 *  起こさない＝`f.layers` には入れない。呼び出し側は使い終わったら捨てること。 */
export async function borrowLayerBytes(
  p: Project,
  f: Frame,
  id: string
): Promise<{ raw: Uint8Array; bits: 8 | 16 } | null> {
  const cur = f.layers[id];
  if (cur) return { raw: viewBytes(cur), bits: p.indexBits === 16 ? 16 : 8 };
  const e = f.sleep?.[id];
  if (!e) return null;
  return { raw: await gunzipBytes(e.z), bits: e.bits };
}

/** V156: いま眠りが抱えている圧縮バイト数（メーターの「実メモリ」行用）。 */
export function sleepBytes(p: Project): number {
  let n = 0;
  for (const f of p.frames) {
    if (!f.sleep) continue;
    for (const e of Object.values(f.sleep)) n += e.z.byteLength;
  }
  return n;
}

/** V156: いま起きている生バッファのバイト数（同じ実体は1回だけ数える＝📌 対策）。 */
export function awakeBytes(p: Project): number {
  const seen = new Set<ArrayBufferView>();
  let n = 0;
  for (const f of p.frames)
    for (const b of Object.values(f.layers)) {
      if (seen.has(b)) continue;
      seen.add(b);
      n += b.byteLength;
    }
  return n;
}

/** V156: 眠っているレイヤーの枚数（検査・報告用）。 */
export function asleepCount(p: Project): number {
  let n = 0;
  for (const f of p.frames) {
    if (!f.sleep) continue;
    for (const id of Object.keys(f.sleep)) if (!f.layers[id]) n++;
  }
  return n;
}
