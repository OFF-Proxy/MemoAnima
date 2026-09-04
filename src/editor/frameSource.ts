// V168 (E): 書き出しの**フレーム供給**。`exporter.ts` から DOM に依存しない部分だけを切り出した。
//
// ★なぜ別ファイルか
//   `exporter.ts` は gif.js（`self` を触る）を import するので **Node から読めない**
//   （`scripts/` のスモークが落ちる＝`smoke-avoid-importing-exporter` の教訓）。
//   ここは `compositeFrame`（純関数）と眠り（`sleep.ts`・DOM なし）しか使わないので、
//   スモークが**直接叩ける**。V163 検査9 の置き換え（「眠ったコマでも白紙を返さない」）はこれで見張る。
//
// ★2026-09-02 の穴（V168・作者決定「1コマずつ起こす」）
//   V163 は「眠ったまま書き出すと白紙」を、**書き出しの入口で全コマを起こす**ことで塞いだ。
//   目安の 10.8 倍の作品（56,860面）では、それが**論理サイズ 4.1GB をそのまま生で展開する
//   見積りなしの確保**になる（8/31 の落ち方と同じ形）。書き出しは 1 コマずつしか読まないので、
//   全コマを同時に起こす必要はそもそも無い。→ **読む直前に起こし、読み終えたら眠らせ直す**。
//   白紙防止という不変条件は残し、**守り方だけ**を変えた。
import { type Project, type Frame, FPS_TABLE, W, H, PIXELS } from "./model";
import { compositeFrame } from "./render";
import { wakeFrame, sleepFrame, frameHasAsleep } from "./sleep";

export interface FrameSource {
  /** 総コマ数 */
  count: number;
  /** 実fps（分数可） */
  fps: number;
  loop: boolean;
  /** i コマ目の 320×240 RGBA（長さ W*H*4。呼び出しごとに独立のコピーを返す）。
   *  V168 (E-1): **async**。眠っているコマを読む直前に起こすため。
   *  同期版は残さない（Promise を同期の型の場所へ渡せば tsc が赤＝型で縛る） */
  getFrameRgba(i: number): Promise<Uint8ClampedArray>;
}

/** V168 (E-2): 先回りして起こすコマ数。ライブラリの `prewakePreview`（8）より小さいのは、
 *  書き出しは読む側（PNG 化・エンコード）のほうが展開より遅いので、2 で十分に隠れるから。 */
export const EXPORT_PREWAKE = 2;

/** .animemo / エディタの Project から。
 *
 *  ★V168 (E-2): **この供給元が起こしたコマだけ**を眠らせ直す（`mine`）。
 *   エディタの窓（表示中±3）・📌 共通レイヤー・元から起きているコマは触らない
 *   （起こす前に眠っていなかったコマは `mine` に入らない）。
 *   読みで起こす（"read"）ので控えは残り、眠らせ直しは**只**（`freeOnly`）。
 *   同時に生で持つのは読み頭の前後数コマだけ＝メモリは「実際に使っている量」から数十MB しか増えない。 */
export function projectSource(p: Project): FrameSource {
  /** この供給元が起こしたコマ（眠らせ直してよいもの） */
  const mine = new Set<Frame>();
  /** 起こし途中のコマ（先回りと本読みで同じコマを2回展開しない） */
  const pending = new Map<Frame, Promise<void>>();
  const wakeOnce = (f: Frame): Promise<void> => {
    if (!frameHasAsleep(f)) return Promise.resolve();
    let job = pending.get(f);
    if (!job) {
      mine.add(f);
      job = wakeFrame(p, f, "read").finally(() => pending.delete(f));
      pending.set(f, job);
    }
    return job;
  };
  return {
    count: p.frames.length,
    fps: FPS_TABLE[p.speedIndex] ?? 8,
    loop: p.loop,
    async getFrameRgba(i: number): Promise<Uint8ClampedArray> {
      const f = p.frames[i];
      if (f) await wakeOnce(f);
      // compositeFrame は使い回しバッファではないが、明示コピーで独立性を保証（handoff §9）
      const u32 = compositeFrame(p, i);
      const out = new Uint8ClampedArray(u32.buffer.slice(0, PIXELS * 4));
      // 先回り: 次の数コマを裏で起こしておく（待たずに進む）。
      // ★Codex 指摘（低）: MP4 のループは `i % count` で末尾から先頭へ戻るので、**回り込んで**先回りする
      //  （ループしない書き出しでは末尾で 0/1 コマ目を余分に起こすだけ＝数 MB・只で眠りに戻る）
      const n = p.frames.length;
      for (let k = 1; k <= EXPORT_PREWAKE && n > 0; k++) {
        const g = p.frames[(i + k) % n];
        if (g) void wakeOnce(g);
      }
      // 後片付け: 読み頭の後ろにある**自分が起こした**コマを只で眠らせ直す
      const behind = p.frames[i - 1];
      if (behind && mine.has(behind) && !pending.has(behind)) {
        mine.delete(behind);
        void sleepFrame(p, behind, undefined, true /* 只で片付くものだけ */);
      }
      return out;
    },
  };
}

/** flipnote.js の note（.kwz / .ppm）から。256×192(.ppm) は 320×240 の白紙へ中央配置 */
export function noteSource(note: {
  frameCount: number;
  framerate: number;
  imageWidth: number;
  imageHeight: number;
  meta?: { loop?: boolean };
  getFramePixelsRgba(i: number): Uint32Array;
}): FrameSource {
  const nw = note.imageWidth;
  const nh = note.imageHeight;
  const ox = Math.floor((W - nw) / 2);
  const oy = Math.floor((H - nh) / 2);
  return {
    count: note.frameCount,
    fps: note.framerate,
    loop: note.meta?.loop ?? true,
    async getFrameRgba(i: number): Promise<Uint8ClampedArray> {
      const px = note.getFramePixelsRgba(i);
      if (nw === W && nh === H) {
        return new Uint8ClampedArray(px.buffer.slice(px.byteOffset, px.byteOffset + PIXELS * 4));
      }
      // 中央配置（余白は白）
      const out = new Uint32Array(PIXELS).fill(0xffffffff);
      for (let y = 0; y < nh; y++) {
        const src = y * nw;
        const dst = (y + oy) * W + ox;
        out.set(px.subarray(src, src + nw), dst);
      }
      return new Uint8ClampedArray(out.buffer);
    },
  };
}

/** コマ範囲 [a..b]（両端含む）に限定するラッパ */
export function withRange(src: FrameSource, a: number, b: number): FrameSource {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(src.count - 1, Math.max(a, b));
  return {
    count: hi - lo + 1,
    fps: src.fps,
    loop: src.loop,
    getFrameRgba: (i) => src.getFrameRgba(lo + i),
  };
}
