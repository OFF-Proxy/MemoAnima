// V164: 画面から来る値・設定から読んだ値を**安全な形に丸める純関数**だけを集めた小さな一枚。
//
// ★なぜ editor.ts の中ではなく別ファイルか
//   `editor.ts` は DOM に強く依存していて Node から import できない（スモークが触れない）。
//   壊れた `settings.json` で落ちないこと・入力の誤爆が起きないことは**機械で見張る**必要があるので、
//   純関数だけをここへ出す。`cursor.ts`（`sanitizeCursor`）・`customTone.ts`
//  （`sanitizeCustomTones`）と同じ作法で、前例に倣っている。
//
// ★共通の方針（V151/M15/V157 から続く「設定破損で挙動を変えない」）
//   - 壊れた値は**その要素だけ**捨てて続行する（全部捨てない・例外を投げない）
//   - 未設定・型違いは**既定へ倒す**。既定は「v1.6.0 と同じ絵・同じ挙動」
import type { OnionDir } from "./render";

/** V164 (U-1): オニオンの段数（0=切／1〜3）。範囲外・非整数・未設定は **0（切）**。 */
export function sanitizeOnionLevel(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3 ? v : 0;
}

/** V164 (U-1): 透かす向き。知らない値・未設定は **"both"**（＝v1.6.0 と1画素も変わらない既定）。 */
export function sanitizeOnionDir(v: unknown): OnionDir {
  return v === "prev" || v === "next" ? v : "both";
}

/** V164 (U-3): よく使う色の棚の上限。
 *  無制限にすると「第二の色見本の壁」になり、この機能の目的（選びやすさ）が消える。 */
export const FAVORITE_COLORS_MAX = 48;

/** V164 (U-3): 色ひとつを棚に入れられる形へ。入れられないものは null。
 *  - `"#RRGGBB"` だけ通す（透明＝`""` は色ではないので入れられない）
 *  - 大文字小文字は**小文字へ寄せる**（`#FFF000` と `#fff000` が二重に並ばない） */
export function normalizeFavColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const hex = v.toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

/** V164 (U-3): `settings.favoriteColors` を健全化する。**壊れた要素だけ落として続行**
 *  （`displayColor` / `layerColors` と同じ作法）。配列でなければ `[]`・重複は先勝ち・上限で打ち切り。 */
export function sanitizeFavoriteColors(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const hex = normalizeFavColor(x);
    if (hex === null || out.includes(hex)) continue;
    out.push(hex);
    if (out.length >= FAVORITE_COLORS_MAX) break;
  }
  return out;
}

// ================= V166 (B): 「確保する前に見積もって断る」 =================
//
// ★事故の形（2026-08-31・作者の実機）
//   1,098コマ×20レイヤーのコマをコピーし、貼り付けを連打 → `allocIndexBuf` が
//   `RangeError: Array buffer allocation failed` を投げ、そのあと WebView ごと落ちた。
//   **確保してみて失敗する**設計だったので、失敗したときにはもう手遅れだった。
//
// ★直し方: **1回の操作が新しく確保する量**を先に計算し、上限を超えるなら**確保せずに断る**。
//   断り文句は「入りません」ではなく「**あと約◯コマぶんまで貼れます**」（要件 §2-B）。

/** V166 (B): 1回の重い操作が新しく確保してよい上限（バイト）。
 *
 *  **512 MiB**。根拠:
 *  - 落ちた実例は 1,098コマ×20レイヤー＝**約 1.69 GB を一度に**確保しようとしていた
 *  - V164 で決めた「まとめて追加」の最悪ケース（100コマ×20レイヤー＝約150MB）の 3 倍強を許す
 *  - WebView2（Chromium）の描画プロセスは 2〜4GB 級だが、**断片化があるので上限より早く失敗する**。
 *    実測できる境界ではないので、「落ちた値の 1/3・通常操作の 3 倍」を安全側の目安として置いた
 *  V164 の `ADD_FRAMES_MAX` と同じ考え方＝**戻せない事故より、操作の回数**を選ぶ。 */
export const HEAVY_ALLOC_MAX_BYTES = 512 * 1024 * 1024;

/** V166 (B): 1コマぶんの生バイト数（レイヤー数 × 76,800 × ビット幅/8）。 */
export function frameBytes(layerCount: number, indexBits: 8 | 16): number {
  return Math.max(0, layerCount) * 320 * 240 * (indexBits === 16 ? 2 : 1);
}

/** V166 (B): 「いま何コマぶん入るか」と「この操作を通してよいか」を1か所で決める。
 *
 *  @param frames      これから確保するコマ数
 *  @param layerCount  1コマあたりのレイヤー数
 *  @param indexBits   索引の幅（16bit なら1コマぶんが倍）
 *  @param budget      1回の操作に許す上限（既定 `HEAVY_ALLOC_MAX_BYTES`。
 *                     確保に一度失敗した後は呼び出し側が下げて渡す＝E の「その先は伸ばさない」）
 *  @returns ok=通してよいか／needBytes=確保しようとしている量／maxFrames=いま入るコマ数
 *
 *  ★`maxFrames` を返すのが要点。断るときに**何コマなら入るか**を言うため（要件 §2-B）。 */
export function checkFrameAlloc(
  frames: number,
  layerCount: number,
  indexBits: 8 | 16,
  budget: number = HEAVY_ALLOC_MAX_BYTES
): { ok: boolean; needBytes: number; maxFrames: number; perFrame: number } {
  const perFrame = frameBytes(layerCount, indexBits);
  const needBytes = perFrame * Math.max(0, frames);
  // レイヤーが0枚（あり得ないが）のときは割り算しない＝常に通す
  const maxFrames = perFrame > 0 ? Math.floor(Math.max(0, budget) / perFrame) : Number.MAX_SAFE_INTEGER;
  return { ok: needBytes <= budget, needBytes, maxFrames, perFrame };
}

/** V166 (Codex 指摘・優先度高④): **昇格を織り込んだ見積もり幅**を返す。
 *
 *  ★見落としていた穴: 見積もりは「いまの `indexBits`」で計算していたが、
 *   貼り付け・連番画像は途中で `ensureColor` が走り、**257色目で 16bit へ自動昇格**する（N-2）。
 *   昇格すると (1) これから作るバッファが**倍**になり (2) `promoteTo16` が
 *   **いま起きている既存バッファも全部作り直す**。つまり実際の確保量は見積もりの倍以上になり得た。
 *
 *  ★正確に判定せず「起こり得るか」で倒す: 色を全画素走査すると、見積もりのほうが重くなる。
 *   代わりに**上限で判定**する——「いまの色数 ＋ 持ち込む色数」が 256 に収まるなら
 *   **昇格は起こり得ない**（8bit のまま）。収まらないなら**起こり得る**ので 16bit で見積もる。
 *   安全側にしか外れない（余計に断ることはあっても、通してはいけないものを通さない）。
 *
 *  @param curColors     いまの `colorTable.length`
 *  @param incomingColors 持ち込む色数の上限（クリップの palette 長など）
 *  @param curBits       いまの `indexBits`
 *  @returns 見積もりに使う幅
 */
export function estimateBits(
  curColors: number,
  incomingColors: number,
  curBits: 8 | 16
): 8 | 16 {
  if (curBits === 16) return 16;
  return curColors + incomingColors <= 256 ? 8 : 16;
}

/** V166 (Codex 指摘・優先度高④): 昇格が起こり得るとき、`promoteTo16` が
 *  **既存の起きているバッファを作り直す**ぶんの追加バイト数。
 *  16bit 化なので「起きている面数 × 76,800 × 2」を新しく確保する。 */
export function promotionExtraBytes(awakeFaces: number, willPromote: boolean): number {
  return willPromote ? Math.max(0, awakeFaces) * 320 * 240 * 2 : 0;
}

// ================= V167 (K-3): スポイトが発火したことを知らせる =================
//
// ★なぜ要るか（2026-09-02 の事故）
//   Alt＋クリックのスポイトは**無音で色を変える**。作者は「ペンで描けない」としか分からず、
//   実際に起きていた「ストロークがスポイトに食われている」に**気づく手がかりが無かった**。
//
// ★ただし連続で使う人の邪魔をしない
//   スポイトは**繰り返し使う道具**なので、拾うたびに毎回出すと画面が知らせで埋まる。
//   間引きの規則は下の1関数に集約してある（＝スモークが直接叩ける・要件に書き戻す）。

/** V167 (K-3): 知らせを出してから、次を出すまでの最短時間（ms）。
 *
 *  **3500ms。** ★Codex 指摘（中）で 1200ms から上げた——
 *  トーストは **3200ms 画面に残り、足すたびに積み上がる**（`main.ts` の `toast`）。
 *  間引きが 1.2 秒だと、Alt＋クリックで拾い続ける人の画面に**常時2〜3個**居座る。
 *  「1つ出したら消えるまで次を出さない」＝**同時に1つより多く出ない**ことを、
 *  トーストの寿命より長くすることで保証する（表示の仕組みには手を入れない）。
 *
 *  ⚠ この値を 3200 未満へ下げると積み上がりが戻る。`v167_smoke` の検査6が見張っている。 */
export const PICK_NOTICE_GAP_MS = 3500;

/** V167: トーストが画面に残る時間（`main.ts` の `toast` と同じ値）。
 *  上の間引きが**これ以上**であることをスモークが確かめるための、突き合わせ用の写し。 */
export const TOAST_LIFETIME_MS = 3200;

/** V167 (K-3): 拾ったことを知らせるか。**間引きの規則はここ1か所**。
 *
 *  ★経路で分ける。「**頼んでいない経路は必ず知らせる／自分で選んだ経路は変化があったときだけ**」
 *
 *  | 経路 | いつ知らせるか | なぜ |
 *  |---|---|---|
 *  | `pointer`（Alt＋クリック等） | **拾うたび**（時間の間引きのみ） | 利用者はスポイトを**選んでいない**。2026-09-02 の事故はこの経路が無音で走り、「ペンで描けない」としか分からなかった。**同じ色を拾って何も変わらなかったときこそ**、いちばん訳が分からない |
 *  | `tool` / `key` | **色が変わったときだけ** | 自分でスポイトを選んでいる＝発火は承知の上。何も変わらなかったことまで報告する必要はない |
 *
 *  共通の間引き: **直前の知らせから `PICK_NOTICE_GAP_MS` 未満なら出さない**
 *  （どの経路でも 1.2 秒に1回より多くは出ない＝連続で拾う人の邪魔をしない）。
 *
 *  @param via 発火の経路
 *  @param prevHex 拾う前に選ばれていた色（`""` は未設定）
 *  @param nextHex 拾った色
 *  @param lastNoticeAt 直前に知らせを出した時刻（まだなら `-Infinity`）
 *  @param now いまの時刻
 */
export function shouldNoticePick(
  via: "tool" | "pointer" | "key",
  prevHex: string,
  nextHex: string,
  lastNoticeAt: number,
  now: number
): boolean {
  // 時間の間引きは**どの経路にも**効く（1.2 秒に1回まで）
  if (now - lastNoticeAt < PICK_NOTICE_GAP_MS) return false;
  // 頼んでいない経路は、色が変わらなくても知らせる（＝黙って食われない）
  if (via === "pointer") return true;
  return prevHex !== nextHex;
}

// ================= V168 (S-1): 保存の写し（structured clone）を、写す前に見積もる =================
//
// ★事故（2026-09-02・実機・目安の 10.8 倍の作品）
//   2,843コマ×20レイヤー（56,860面）を貼り付けで作った直後の Ctrl+S が
//   `Failed to execute 'postMessage' on 'Worker': Data cannot be cloned, out of memory.`
//   メーターは「実際に使っている量 2.6GB」。前の版と .bak は無事（W-1）。
//   足りなかったのは**失敗しないこと**。
//
// ★原因
//   Chromium は postMessage の写しを**1本の連続バッファに直列化**する。実効の上限は約 2GiB。
//   写しの大きさ ≈ 起きている生（awake）＋眠り控え（sleep）＋音声＋骨組み ＝ メーターの実サイズ。
//   貼り付け直後は貼ったコマが**生のまま**（V156 の掃除が追いつく前）なので太る。
//   掃除が済んでいれば写しはファイル並み（この作品で約 0.2GB）。
//
// ★見落とし
//   V166 は保存を漏斗の外に置いた（保存中も描けるため・正しい）。その結果、
//   層2 の「確保する前に見積もる」が**保存にだけ無かった**。**写しは確保である。**
//
// ★ここにあるのは純関数だけ（Node のスモークが直接叩く）。待つ・断るの配線は editor.ts。

/** V168: 「先に掃除を待つ」しきい値。**512MiB**。
 *  `HEAVY_ALLOC_MAX_BYTES` と同値だが**別名**——意味が違う。写しは一時的に
 *  「直列化バッファ＋Worker 側の複製」で **2倍**積むので、512MiB の写し＝一時 +1GiB が目安。 */
export const SAVE_SNAPSHOT_SOFT_BYTES = 512 * 1024 * 1024;

/** V168: 写してよい上限。**1.5GiB**＝実効上限 約 2GiB の 75%（直列化の骨組み・タグぶんの余裕）。
 *  ⚠ 厳密な上限は環境で変わり得る。要件 §1-S-1 の「2.6GB が断られる／0.2GB が通る」を実機で確かめる。 */
export const SAVE_SNAPSHOT_MAX_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);

/** V168: 面（コマ×レイヤー）1つあたりの骨組み（オブジェクトのキー・型付き配列のヘッダ・タグ）の見積り。
 *  **過小に見積もらない**方向へ丸めてある（structured clone の直列化タグは数十バイト） */
export const SNAPSHOT_FACE_OVERHEAD = 128;

/** V168: 骨組み（colorTable・layerDefs・meta・audio の器など）の固定ぶん。 */
export const SNAPSHOT_FIXED_OVERHEAD = 1024 * 1024;

export interface SnapshotEstimate {
  /** 起きている生バッファ（同じ下敷きは1回） */
  awake: number;
  /** 眠り控え z の**下敷き**（PV6 遅延読みのビューは、ファイルバッファを1回だけ数える） */
  sleep: number;
  /** 音声（bgm.data ＋ se[].data。同じ下敷きは1回） */
  audio: number;
  /** 面数（起きている＋眠っている） */
  faces: number;
  /** 見積りの合計（骨組み込み） */
  est: number;
}

/** V168 (S-1): 保存の写し（structured clone）が何バイトになるかの見積り。
 *
 *  ★**同じ ArrayBuffer は1回だけ数える**。
 *   - 📌 全コマ共通レイヤーは全コマが同じ型付き配列を指す → 1回
 *   - PV6 遅延読みの眠り控え `z` は**ファイルバッファへのビュー**。structured clone は
 *     ビューを「下敷きの ArrayBuffer ごと」写すので、ビューの合計ではなく**下敷きの byteLength を1回**
 *   - 自前バッファの z（`gzipBytes` の結果）は下敷き＝自分なので同じ規則で正しく数えられる
 *  ★**過小に見積もらない**が要件（生の合計 awake+sleep+audio を下回ったら赤・スモーク）。
 *   `buffer.byteLength ≥ view.byteLength` は常に成り立つので、この数え方は下回らない。 */
export function snapshotBytes(p: {
  frames: { layers: Record<string, ArrayBufferView>; sleep?: Record<string, { z: ArrayBufferView }> }[];
  audio?: { bgm: { data: ArrayBufferView } | null; se: { data: ArrayBufferView }[] } | null;
}): SnapshotEstimate {
  const seen = new Set<ArrayBufferLike>();
  const count = (v: ArrayBufferView): number => {
    const buf = v.buffer;
    if (seen.has(buf)) return 0;
    seen.add(buf);
    return buf.byteLength;
  };
  let awake = 0;
  let sleep = 0;
  let audio = 0;
  let faces = 0;
  for (const f of p.frames) {
    for (const b of Object.values(f.layers)) {
      faces++;
      awake += count(b);
    }
    if (f.sleep)
      for (const e of Object.values(f.sleep)) {
        // ★Codex 指摘（低）: 「起きていて控えもある」レイヤーの控えも**骨組みとして数える**
        //  （バッファ本体は count() が数えている。過小に見積もらないを厳密にするなら控えの器も足す）
        faces++;
        sleep += count(e.z);
      }
  }
  if (p.audio) {
    if (p.audio.bgm) audio += count(p.audio.bgm.data);
    for (const s of p.audio.se) audio += count(s.data);
  }
  const est = awake + sleep + audio + faces * SNAPSHOT_FACE_OVERHEAD + SNAPSHOT_FIXED_OVERHEAD;
  return { awake, sleep, audio, faces, est };
}

/** V168 (S-2): 写す前に掃除を待つか。soft を超えていれば "sweep"（先に眠らせを待つ）。 */
export function saveSnapshotPlan(est: number): "clone" | "sweep" {
  return est > SAVE_SNAPSHOT_SOFT_BYTES ? "sweep" : "clone";
}

/** V168 (S-3): 写してよいか。max を超えていれば**断る**（例外にしない）。 */
export function saveSnapshotAllowed(est: number): boolean {
  return est <= SAVE_SNAPSHOT_MAX_BYTES;
}

/** V166 (E): 「メモリの確保に失敗した」例外か。
 *
 *  事故のログに出ていたのは `RangeError: Array buffer allocation failed`。
 *  WebView（Chromium）はこれのほかに `Invalid typed array length` / `Out of memory` も投げる。
 *  ★**名前ではなく文面で見る**——`RangeError` は範囲外の引数でも投げられるので、
 *   名前だけで判定すると**確保と無関係な不具合まで「メモリ不足です」と言ってしまう**。 */
export function isAllocFailure(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? "");
  return /allocation failed|Invalid typed array length|out of memory|Array buffer/i.test(msg);
}

/** V164 (U-4): 1回で足せるコマ数の上限。
 *
 *  **メモリの都合**——1枚は「レイヤー数 × 76.8KB」を実際に確保するので、20レイヤーの作品なら
 *  100枚で約 150MB。ここを大きくすると「間違えて1000枚」で確保そのものに失敗し得る
 *  （Undo で戻せても、確保で落ちたら意味がない）。足りなければもう一度押せばよい＝
 *  **戻せない事故より、押す回数**を選ぶ。 */
export const ADD_FRAMES_MAX = 100;

/** V164 (U-4): 「何枚足すか」を決める。**入力の丸めはここ1か所**。
 *
 *  @param want  画面から来た値（空欄・0・負数・小数・1000 などの誤入力を含む）
 *  @param total いまのコマ数
 *  @returns n=実際に足す枚数（0=1枚も足せない）／
 *    **clamped=「作品の上限（65,535コマ）に当たって減らしたか」**
 *
 *  ★`clamped` は 65,535 に当たった場合**だけ** true（Codex V164 指摘②で契約を明記）。
 *   1回の上限（`ADD_FRAMES_MAX`）への丸めはここでも起きるが、そちらは**小窓が先に見せる**
 *  （「1〜100枚」の但し書き・`max` 属性・確定時に入力欄の値そのものを丸める）ので、
 *   足したあとに知らせる必要がない。
 *  ★「途中まで入って黙って終わる」を作らないための関数（要件 U-4）。呼ぶ側は
 *   `clamped` が真なら**必ず知らせる**（`ed.tl.addFrames.clamped.toast`）。 */
export function clampAddFrames(
  want: unknown,
  total: number,
  max = ADD_FRAMES_MAX
): { n: number; clamped: boolean } {
  const raw = Math.floor(Number(want));
  const asked = Number.isFinite(raw) ? Math.max(1, Math.min(max, raw)) : 1;
  const room = Math.max(0, 65535 - total);
  const n = Math.min(asked, room);
  return { n, clamped: n < asked };
}
