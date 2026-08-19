// M6-1 映像エクスポート（docs/handoff/M6_1_video_export.md / REQ_M6_export.md）
// 形式: MP4（無音・M6-2で音声対応）/ GIF / APNG / PNG連番(zip)
// 不変条件: 出力は常に 320×240×N（N=1|2|4|8・M11-22 で ×8 解禁）・nearest-neighbor（補間なし）
// フレーム供給は FrameSource に統一（.animemo=compositeFrame / .kwz=getFramePixelsRgba）

import { zipSync } from "fflate";
import GIF from "gif.js";
import UPNG from "upng-js";
import gifWorkerUrl from "gif.js/dist/gif.worker.js?url";
import { Project, FPS_TABLE, W, H, PIXELS } from "./model";
import { compositeFrame } from "./render";
import { t } from "../i18n";

export interface FrameSource {
  /** 総コマ数 */
  count: number;
  /** 実fps（分数可） */
  fps: number;
  loop: boolean;
  /** i コマ目の 320×240 RGBA（長さ W*H*4。呼び出しごとに独立のコピーを返す） */
  getFrameRgba(i: number): Uint8ClampedArray;
}

export type ExportFormat = "mp4" | "gif" | "apng" | "pngzip";

/** M5-1: MP4 に mux する音声＝**ミックス済みWAV1本**（renderExportMix の結果）。
 *  null=無音経路。トリム/ループ/音量/速度rate/SE時刻はレンダ時に適用済みなので
 *  ffmpeg 側は「この WAV を1回再生して -t で切る」だけ（-af volume 撤去）。 */
export interface ExportAudio {
  wav: Uint8Array;
  /** 出力尺（秒）。映像の -t にも使う（syncMode 規則適用済み） */
  durationSec: number;
  /** animToAudio のとき映像を尺までループさせる判断に使う */
  syncMode: "audioToAnim" | "animToAudio";
}

/** M5-1: エクスポートダイアログへ渡す音声ソース（UI表示＋範囲確定後のミックス生成） */
export interface ExportAudioSource {
  /** 何かしら音がある（bgm または 配置済みSE） */
  has: boolean;
  /** 全トラックがミュート（表示は「ミュート中のため無音」） */
  allMuted: boolean;
  /** 「書き出す長さ」初期値 */
  syncMode: "audioToAnim" | "animToAudio";
  /** 範囲・モード確定後にミックスを生成（null=無音経路） */
  build(
    range: { a: number; b: number } | null,
    syncMode: "audioToAnim" | "animToAudio"
  ): Promise<ExportAudio | null>;
}

/** M11-22: 書き出し倍率の選択肢（アニメ書き出し・画像で保存とも）。×3 は廃止・×8=2560×1920 を解禁 */
export const EXPORT_SCALES = [1, 2, 4, 8] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];
/** 初回の既定は ×4（作者決定: ×1 は SNS で乱れる） */
export const DEFAULT_EXPORT_SCALE: ExportScale = 4;
/** settings.json の値（何が入っていても）→ 1|2|4|8。不正値・選択肢に無い値（3 を含む）はすべて既定 ×4 */
export function sanitizeExportScale(v: unknown): ExportScale {
  return (EXPORT_SCALES as readonly number[]).includes(v as number)
    ? (v as ExportScale)
    : DEFAULT_EXPORT_SCALE;
}
/** M11-22: 選択中倍率の説明（両ダイアログ共通）。
 *  - px: 出力ピクセル数 ／ use: 用途の一言（括弧は使わない＝呼び出し側で括弧を足しても二重にならない）
 *  - dots: 拡大の但し書き（×1 は拡大しないので空。呼び出し側は `title` へ逃がす）
 *  M11-24: 常時表示は `px`＋`use` だけにし、`use` も短くした（所要時間は M11-23 の確認ダイアログが言う）。
 *  `dots`（拡大はドット等倍・なましなし）はアプリ全体の約束なので画面に出しっぱなしにしない。 */
export function scaleNote(n: ExportScale): { px: string; use: string; dots: string } {
  const px = `${W * n}×${H * n}`;
  const dots = n === 1 ? "" : t("export.scale.dots.title");
  switch (n) {
    case 1:
      return { px, use: t("export.scale.use1.hint"), dots };
    case 2:
      return { px, use: t("export.scale.use2.hint"), dots };
    case 4:
      return { px, use: t("export.scale.use4.hint"), dots };
    case 8:
      return { px, use: t("export.scale.use8.hint"), dots };
  }
}
/** M11-22: GIF ×8 の容量注意（数十MB級になり得る）。M11-24: 何が起きるかだけに詰めた。
 *  M12-1c-2: **定数から関数へ**。module 直下で `t()` を呼ぶと読み込み時の言語で固まるため */
export function gifX8Warning(): string {
  return t("export.gifX8.warn.hint");
}

// ---------------- M11-23: 書き出しの事前見積もり（メモリ・所要時間） ----------------

/** M11-23: **全コマの RGBA をエンコード前に主スレッドが抱える**形式。
 *  GIF（gif.js の `frames[]`）と APNG（UPNG に渡す `imgs[]`）だけ。MP4（1枚ずつ ffmpeg の MEMFS へ）と
 *  PNG連番（1枚ずつ zip へ）は抱えない＝メモリ見積もりの対象外（M11-22 報告 §3 の実測と構造の両方で確認） */
export const HOLDS_ALL_FRAMES: Record<ExportFormat, boolean> = {
  mp4: false,
  gif: true,
  apng: true,
  pngzip: false,
};

/**
 * M11-23: 所要時間の係数。モデルは `秒 = perFrame × コマ数 + perMpx × (コマ数 × 1コマの Mpx) [+ load]`
 *   1コマの Mpx = 320×240×倍率² / 1e6（×4=1.229・×8=4.915）
 * **配布ビルド（release exe）の実測で較正**。M11-22 報告 §3 の数値は `tauri:dev` の WebView 実測で、
 * 同じ素材・同じ手順でも release は 0.23〜0.66 倍しかかからない（下表）。ユーザーが使うのは release なので
 * そちらに合わせた（dev 由来の係数のままだと推定時間が 2〜3 倍に出て、確認ダイアログが不要に出てしまう）。
 * 実測（release exe・実 UI・100 コマ・「書き出し」を押してから進捗 100% まで／M11-23 報告 §3）:
 *   | 形式               | ×4     | ×8      | dev（M11-22 §3）|
 *   | GIF 6色            | 1.80s  | 6.14s   | 7.7 / 19       |
 *   | GIF 246色          | 32.06s | 127.81s | 69 / 267（243色）|
 *   | GIF 306色(NeuQuant)| 9.42s  | 31.19s  | 23.5 / 88（303色）|
 *   | APNG               | 1.93s  | 6.59s   | − / 12         |
 *   | MP4                | 5.20s  | 14.44s  | − / 22         |
 *   | PNG連番            | 1.81s  | 2.64s   | − / 5          |
 * 導出（2 点直線・傾き=(t8−t4)/(491.52−122.88) s/Mpx・切片をコマ数で割って perFrame）:
 *   - GIF 6色 → 0.01178 s/Mpx・0.0035 s/コマ／GIF 246色 → 0.25974 s/Mpx・0.0015 s/コマ
 *     → 色数の効き: (0.25974−0.01178)/240=0.001033 s/Mpx/色 ＝ `perMpx(c) = 0.0056 + 0.001033c`
 *       （perFrame は両者とも誤差レベルなので 0.003 に丸めて共通化）
 *   - GIF NeuQuant（>256色・M11-22 で触っていない従来経路）→ 0.0591 s/Mpx・0.0216 s/コマ（**色数に依らない**・
 *     quality=10 の標本抽出なので固定）
 *   - APNG → 0.01266 s/Mpx・0.0037 s/コマ
 *   - MP4 → 0.0251 s/Mpx＋固定 2.1s（ffmpeg.wasm core のロードと writeFile の下駄）
 *   - PNG連番 → 0.00223 s/Mpx・0.0154 s/コマ（zip の deflate がコマ数に効く）
 * 検算: 40コマ・246色・×8 の実測 51.76s に対し式は 51.2s（−1.1%）＝コマ数方向の線形性も確認済み。
 * 外れる条件: 絵の複雑さ（LZW/deflate の圧縮率・x264 の動き検出）・PC 性能・初回の core ロード。
 * **桁が合えばよい**用途に限る（走り出したあとの「残り 約N分」は実測から出し直す）。
 */
export const TIME_COEF = {
  /** GIF 固定パレット（≤256色）: 線形最近傍が色数×画素数に比例 */
  gifFixed: (colors: number) => ({ perFrame: 0.003, perMpx: 0.0056 + 0.001033 * colors }),
  /** GIF NeuQuant（>256色・M11-22 で変えていない従来経路） */
  gifNeuQuant: { perFrame: 0.0216, perMpx: 0.0591 },
  apng: { perFrame: 0.0037, perMpx: 0.01266 },
  /** MP4 は ffmpeg.wasm core のロードぶんを固定で足す */
  mp4: { perFrame: 0, perMpx: 0.0251, load: 2.1 },
  pngzip: { perFrame: 0.0154, perMpx: 0.00223 },
} as const;

/** M11-23: 危険域の閾値。
 *  - メモリ 1.5GB: 100コマ×8（見積もり 1.97×10⁹ バイト＝1.8GB 表示・実測ピーク +2.3GB）は出す／
 *    10コマ×8（197MB）は出さない、の間で切った。WebView2（Chromium）のレンダラは 4GB 前後で落ちるので、
 *    その半分を目安にしている。**この式は実測ではなく確定値**（コマ数×画素数×4）なので PC 性能に依らない
 *  - 時間 60秒: REQ §2-b の「1分超」。release 実測で 100コマ246色×8（128s）は出る・
 *    100コマ246色×4（32s）や 6色×8（6s）・MP4 ×8（14s）は出ない */
export const RISK_MEMORY_BYTES = 1.5 * 1024 * 1024 * 1024;
export const RISK_SECONDS = 60;

export interface ExportEstimate {
  /** 出力1コマの寸法 */
  w: number;
  h: number;
  /** 作品のコマ数（表示用） */
  frames: number;
  /** 実際にエンコードされるコマ数。MP4 の「曲の長さで書き出す」は映像をループするので frames より増える */
  encodedFrames: number;
  /** 全コマ保持型のみ: エンコード前に抱える RGBA の合計バイト（0=対象外） */
  memBytes: number;
  /** 推定所要秒 */
  seconds: number;
  /** GIF のとき: 固定パレットの色数（>256 で NeuQuant のときは null） */
  gifColors: number | null;
  /** 危険域か（＝確認ダイアログを出すか） */
  risky: boolean;
  /** 危険と判定した理由（報告・文言用） */
  reasons: ("memory" | "time")[];
}

/**
 * M11-23: 書き出し前の見積もり（純関数）。
 * - `gifColors` は `collectGifPalette()` の色数（null=NeuQuant 経路）
 * - `encodedFrames` は**実際にエンコードされるコマ数**。MP4 の「曲の長さで書き出す」(animToAudio) は
 *   `-stream_loop -1` ＋ `-t 曲の尺` なので、アニメのコマ数と無関係に「曲の尺×fps」コマぶん処理される
 *   （既定は `frames`。**時間だけに効かせ、メモリと表示のコマ数は作品のコマ数のまま**＝ MP4 はメモリ対象外）
 */
export function estimateExport(opts: {
  format: ExportFormat;
  scale: number;
  frames: number;
  encodedFrames?: number;
  gifColors?: number | null;
}): ExportEstimate {
  const { format, scale, frames } = opts;
  const encodedFrames = Math.max(frames, Math.round(opts.encodedFrames ?? frames));
  const w = W * scale;
  const h = H * scale;
  const mpxPerFrame = (w * h) / 1e6;
  const totalMpx = mpxPerFrame * encodedFrames;
  const gifColors = format === "gif" ? (opts.gifColors ?? null) : null;
  let seconds: number;
  if (format === "gif") {
    const c = gifColors === null ? TIME_COEF.gifNeuQuant : TIME_COEF.gifFixed(gifColors);
    seconds = c.perFrame * encodedFrames + c.perMpx * totalMpx;
  } else if (format === "apng") {
    seconds = TIME_COEF.apng.perFrame * encodedFrames + TIME_COEF.apng.perMpx * totalMpx;
  } else if (format === "mp4") {
    seconds = TIME_COEF.mp4.load + TIME_COEF.mp4.perMpx * totalMpx;
  } else {
    seconds = TIME_COEF.pngzip.perFrame * encodedFrames + TIME_COEF.pngzip.perMpx * totalMpx;
  }
  const memBytes = HOLDS_ALL_FRAMES[format] ? frames * w * h * 4 : 0;
  const reasons: ("memory" | "time")[] = [];
  if (memBytes >= RISK_MEMORY_BYTES) reasons.push("memory");
  if (seconds >= RISK_SECONDS) reasons.push("time");
  return {
    w,
    h,
    frames,
    encodedFrames,
    memBytes,
    seconds,
    gifColors,
    risky: reasons.length > 0,
    reasons,
  };
}

/** M11-23: 「約N分」「約N秒」の粒度に丸める（残り時間・見積もりの共通表記）。
 *  秒単位でチカチカしないよう、1分以上は分に丸める */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 45) return t("export.eta.seconds.label", { n: Math.max(5, Math.round(sec / 5) * 5) });
  if (sec < 90) return t("export.eta.oneMinute.label");
  const m = Math.round(sec / 60);
  return m >= 60
    ? t("export.eta.hours.label", { n: Math.round(m / 6) / 10 })
    : t("export.eta.minutes.label", { n: m });
}

/** M11-23: バイト数の表示（見積もり用・GB/MB） */
export function formatBytes(n: number): string {
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  return `${Math.round(n / (1024 * 1024))}MB`;
}

/**
 * M11-23: 残り時間の目安。`onProgress` のたびに `update()` を呼び、表示する文字列（""=まだ出さない）を返す。
 * 時刻は呼び出し側から渡す（純粋・スモークで検査できる）。
 *
 * 規則:
 * - **開始直後は出さない**: 基準点から `minElapsedMs`(既定 2.5s) 経ち、かつ**基準点で残っていた仕事**の
 *   `minRatio`(既定 10%) 以上を片づけてから。短い書き出し（10コマ×4 の GIF は 1 秒未満）では
 *   **最後まで一度も出ない**
 *   ※ 分母は「全体」ではなく「基準点での残り（`total − done0`）」。MP4 のエンコードは進捗が
 *     `コマ数 → コマ数+1` の**1 目盛しか動かない**ので、全体を分母にすると 33 コマ以上で永久に 3% を割り、
 *     いちばん長いエンコード中に表示が固まってしまう（M11-23 レビュー指摘）
 * - **フェーズが変わったら基準点を取り直す**（GIF は「フレーム生成」と「GIFエンコード」で 1 コマの重さが
 *   まったく違うため。前の表示は消さずに保ち、新しい値が出たら差し替える）
 * - **表示の更新は `refreshMs`(既定 3s) に 1 回**だけ・「約N分／約N秒」に丸める＝秒単位でチカチカしない
 * - **事前見積もりの残り（`preSeconds − 開始からの経過`）を下限**にする。GIF はコマ生成が速くエンコードが
 *   遅い／MP4 は最後の 1 目盛が x264 全体、と**進捗の目盛と実時間が比例しない**ので、実測だけだと
 *   途中で極端に短く出てしまう。経過ぶんだけ減る下限なので、時間とともに自然に実測へ主導権が移る
 * - **100%（`done ≥ total`）に達したら消す**（「200 / 200　残り 約5秒」を残さない）
 */
export function createEtaEstimator(
  preSeconds = 0,
  opts: { minElapsedMs?: number; minRatio?: number; refreshMs?: number } = {}
) {
  const minElapsedMs = opts.minElapsedMs ?? 2500;
  // 「基準点で残っていた仕事」の何割を片づけたら実測を信じるか。MP4 のエンコードは x264 の立ち上がりで
  // 最初の数秒だけ極端に遅く見えるので、少し進んでから測る（実機: 3% だと 4 倍・10% で 2 倍に跳ねた）
  const minRatio = opts.minRatio ?? 0.2;
  const refreshMs = opts.refreshMs ?? 3000;
  let phase0 = "";
  let t0 = -1;
  let done0 = 0;
  let lastCalc = -1;
  let shown = "";
  let tFirst = -1; // 書き出し開始（最初の onProgress）の時刻。事前見積もりの下限を減らすのに使う
  return {
    /** @returns 表示文字列（"" のときは残り時間を出さない） */
    update(done: number, total: number, phase: string, now: number): string {
      if (total <= 0) return shown;
      // 出し切ったら消す（「400 / 400　残り 約5秒」のような矛盾した表示を残さない）
      if (done >= total) {
        shown = "";
        return "";
      }
      if (tFirst < 0) tFirst = now;
      if (phase !== phase0 || t0 < 0) {
        // フェーズの切り替わり（＝1目盛あたりの重さが変わる）で基準を取り直す。表示は保つ
        phase0 = phase;
        t0 = now;
        done0 = done;
        lastCalc = -1;
        return shown;
      }
      const elapsed = now - t0;
      const progressed = done - done0;
      // 分母は「基準点で残っていた仕事」。MP4 のエンコードのように 1 目盛しか動かないフェーズでも判定できる
      const segTotal = Math.max(1e-9, total - done0);
      if (elapsed < minElapsedMs || progressed / segTotal < minRatio) return shown;
      if (lastCalc >= 0 && now - lastCalc < refreshMs) return shown;
      lastCalc = now;
      const left = Math.max(0, total - done);
      const measured = (elapsed / 1000) * (left / progressed);
      // 事前見積もりの残り（経過ぶん減らす）を下限にする。進捗の目盛と実時間がずれる形式で短く出すぎるのを防ぐ
      const floor = preSeconds > 0 ? preSeconds - (now - tFirst) / 1000 : 0;
      shown = formatDuration(Math.max(measured, floor));
      return shown;
    },
  };
}

/** M12-1c-2: 進捗フェーズの**識別子**。
 *
 *  以前はここに日本語の表示名（"GIFエンコード" など）が入っていて、
 *  ① `createEtaEstimator` が `phase !== phase0` で**フェーズ切替の判定**に使い
 *  ② `main.ts` が `${phase}… 12 / 200` と**そのまま画面へ出す**
 *  という「識別子と表示名が同じ文字列」の形だった（keymap.ts の `"道具"` と同じ罠）。
 *  訳した瞬間に判定が言語で揺れるので、**識別子は ASCII・表示名は辞書**に分けた。 */
export type ExportPhase =
  | "pngGen"
  | "zip"
  | "countColors"
  | "gifEncode"
  | "frameGen"
  | "apngEncode"
  | "encoderInit"
  | "frameWrite"
  | "mp4Encode"
  | "done";

/** 進捗フェーズの表示名（`*Key: "…"` の規約＝検査4 から見える形） */
export const EXPORT_PHASES: readonly { id: ExportPhase; labelKey: string }[] = [
  { id: "pngGen", labelKey: "export.phase.pngGen.label" },
  { id: "zip", labelKey: "export.phase.zip.label" },
  { id: "countColors", labelKey: "export.phase.countColors.label" },
  { id: "gifEncode", labelKey: "export.phase.gifEncode.label" },
  { id: "frameGen", labelKey: "export.phase.frameGen.label" },
  { id: "apngEncode", labelKey: "export.phase.apngEncode.label" },
  { id: "encoderInit", labelKey: "export.phase.encoderInit.label" },
  { id: "frameWrite", labelKey: "export.phase.frameWrite.label" },
  { id: "mp4Encode", labelKey: "export.phase.mp4Encode.label" },
  { id: "done", labelKey: "export.phase.done.label" },
];

/** 進捗フェーズの表示名を引く唯一の口（未知の id はそのまま返す＝壊さない） */
export function exportPhaseLabel(id: string): string {
  const p = EXPORT_PHASES.find((x) => x.id === id);
  return p ? t(p.labelKey) : id;
}

export interface ExportOptions {
  format: ExportFormat;
  /** 整数倍率 1|2|4|8（EXPORT_SCALES）。拡大は FrameScaler の nearest 整数倍 */
  scale: number;
  onProgress: (done: number, total: number, phase: ExportPhase) => void;
  cancel: { cancelled: boolean };
  /** MP4 のみ使用。GIF/APNG/PNG連番は無音仕様のため無視 */
  audio?: ExportAudio | null;
  /** M10-13: 透過部分を純白 #ffffff で塗ってから書き出す。
   *  .kwz 直接書き出しは透明画素をそのまま流すため、MP4 は yuv420p 変換で
   *  alpha が捨てられて黒、GIF は透明色の解釈がプレイヤー依存で黒く見える。
   *  3DS 本体の書き出しは白背景なので、それに合わせる。**必須**（呼び出し元で明示）。 */
  whiteBg: boolean;
}

/** .animemo / エディタの Project から */
export function projectSource(p: Project): FrameSource {
  return {
    count: p.frames.length,
    fps: FPS_TABLE[p.speedIndex] ?? 8,
    loop: p.loop,
    getFrameRgba(i: number): Uint8ClampedArray {
      // compositeFrame は使い回しバッファではないが、明示コピーで独立性を保証（handoff §9）
      const u32 = compositeFrame(p, i);
      return new Uint8ClampedArray(u32.buffer.slice(0, PIXELS * 4));
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
    getFrameRgba(i: number): Uint8ClampedArray {
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

/** 320×240 RGBA → 320N×240N へ nearest 拡大（canvas 使い回し） */
class FrameScaler {
  private small: HTMLCanvasElement;
  private smallCtx: CanvasRenderingContext2D;
  readonly big: HTMLCanvasElement;
  readonly bigCtx: CanvasRenderingContext2D;
  readonly ow: number;
  readonly oh: number;

  constructor(readonly n: number, private readonly whiteBg: boolean) {
    this.ow = W * n;
    this.oh = H * n;
    this.small = document.createElement("canvas");
    this.small.width = W;
    this.small.height = H;
    this.smallCtx = this.small.getContext("2d")!;
    this.big = document.createElement("canvas");
    this.big.width = this.ow;
    this.big.height = this.oh;
    this.bigCtx = this.big.getContext("2d", { willReadFrequently: true })!;
    this.bigCtx.imageSmoothingEnabled = false;
  }

  /** 描き込んで big canvas を返す（呼び出し側は即時に使うこと） */
  draw(rgba: Uint8ClampedArray): HTMLCanvasElement {
    this.smallCtx.putImageData(new ImageData(rgba, W, H), 0, 0);
    this.bigCtx.imageSmoothingEnabled = false; // 念のため毎回（状態リセット対策）
    // M10-13: ここが全4形式（PNG連番/GIF/APNG/MP4）の唯一の関所。
    // whiteBg なら先に純白で塗ってから重ねる＝透過部分だけが白になる。
    // 不透明な画素の下に白が見えることはないので、通常作品の出力は1画素も変わらない
    if (this.whiteBg) {
      this.bigCtx.fillStyle = "#ffffff";
      this.bigCtx.fillRect(0, 0, this.ow, this.oh);
    } else {
      this.bigCtx.clearRect(0, 0, this.ow, this.oh);
    }
    this.bigCtx.drawImage(this.small, 0, 0, W, H, 0, 0, this.ow, this.oh);
    return this.big;
  }

  toPngBlob(rgba: Uint8ClampedArray): Promise<Blob | null> {
    this.draw(rgba);
    return new Promise((res) => this.big.toBlob(res, "image/png"));
  }

  /** 拡大後の RGBA バイト列（毎回新規） */
  toRgbaBytes(rgba: Uint8ClampedArray): ArrayBuffer {
    this.draw(rgba);
    return this.bigCtx.getImageData(0, 0, this.ow, this.oh).data.buffer;
  }
}

const CANCELLED = null;

function pad4(i: number): string {
  return String(i + 1).padStart(4, "0");
}

// ---------------- M11-21: PNG の色チャンク（sRGB＋gAMA）と MP4 の色引数 ----------------

/** CRC32（PNG チャンク用・zlib と同じ多項式） */
let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * M11-21: PNG（単体・APNG とも）に **sRGB(1)＋gAMA(45455)** チャンクを付ける。既にあるものは足さない。
 * 画素データ（IDAT/fdAT）には一切触れない＝出力の RGB は 1 バイトも変わらない。
 * - Chromium の canvas.toBlob("image/png") は色チャンクを一切書かない（PNG連番・M11-11 画像保存で実測）
 * - UPNG.encode（APNG）は sRGB(1) だけ書き、gAMA は書かない
 * 色管理するビューア（Chrome/Windows フォト等）は「未タグ＝sRGB」として扱うので見え方は変わらないが、
 * gAMA しか見ない古いビューアで gamma 1.0 扱いされる／ICC 変換の解釈がぶれるのを防ぐ（PNG 仕様推奨の組）。
 * 挿入位置は IHDR の直後（sRGB があればその直後）。PNG 署名でなければそのまま返す。
 */
export function withSrgbChunks(png: Uint8Array): Uint8Array {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 33 || SIG.some((b, i) => png[i] !== b)) return png;
  const rd32 = (o: number) => ((png[o] << 24) | (png[o + 1] << 16) | (png[o + 2] << 8) | png[o + 3]) >>> 0;
  const type = (o: number) => String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
  // チャンクを走査: 既存の sRGB / gAMA を探し、IHDR（と sRGB）の直後の位置を覚える
  let o = 8;
  let insertAt = -1;
  let hasSrgb = false;
  let hasGama = false;
  while (o + 12 <= png.length) {
    const len = rd32(o);
    const t = type(o);
    const next = o + 12 + len;
    if (next > png.length) return png; // 長さが壊れている＝触らずそのまま返す（レビュー保険）
    if (t === "IHDR" && insertAt < 0) insertAt = next;
    if (t === "sRGB") {
      hasSrgb = true;
      insertAt = next; // gAMA は sRGB の直後に
    }
    if (t === "gAMA") hasGama = true;
    if (t === "iCCP") return png; // 埋め込み ICC があれば sRGB は共存不可（PNG 仕様）＝何も足さない（レビュー保険）
    if (t === "IDAT" || t === "IEND" || t === "PLTE") break; // 先頭部の走査で足りる（acTL は跨いで見る）
    o = next;
  }
  if (insertAt < 0 || (hasSrgb && hasGama)) return png;
  const chunk = (t: string, data: number[]) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  };
  const parts: Uint8Array[] = [];
  if (!hasSrgb) parts.push(chunk("sRGB", [1])); // 1 = 相対的な色域を維持（Relative colorimetric）
  if (!hasGama) parts.push(chunk("gAMA", [0x00, 0x00, 0xb1, 0x8f])); // 45455 = 1/2.2
  const add = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(png.length + add);
  out.set(png.subarray(0, insertAt), 0);
  let w = insertAt;
  for (const p of parts) {
    out.set(p, w);
    w += p.length;
  }
  out.set(png.subarray(insertAt), w);
  return out;
}

/** M11-21: MP4 の色まわりの引数（両経路で共通）。
 *  - `-vf scale=out_color_matrix=bt709:out_range=tv`: RGB→YUV の変換を **BT.709・リミテッドレンジで明示**
 *    （従来は swscale 既定＝BT.601 で書かれ、タグ無しだった）
 *  - `-colorspace/-color_primaries/-color_trc bt709 -color_range tv`: 出力ストリームに色タグ（VUI/colr）
 *  同梱 ffmpeg.wasm（FFmpeg 5.1.4・single thread）で有効なことを実測済み（M11-21 報告書 §3）。 */
export const MP4_COLOR_VF = "scale=out_color_matrix=bt709:out_range=tv";
export const MP4_COLOR_TAGS = [
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
];

/** M11-21: `exportMp4` が ffmpeg に渡す引数列（純関数・スモークで pin する）。
 *  色以外（-framerate/-i/-t/-c:v/-c:a/-b:a/-pix_fmt/-movflags/-stream_loop の並びと値）は M5-1/M6-1 と同一。 */
export function mp4ExecArgs(
  fps: number,
  audio: { durationSec: number; syncMode: "audioToAnim" | "animToAudio" } | null
): string[] {
  if (!audio) {
    return [
      "-framerate",
      String(fps),
      "-i",
      "f%04d.png",
      "-vf",
      MP4_COLOR_VF,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      ...MP4_COLOR_TAGS,
      "-movflags",
      "+faststart",
      "out.mp4",
    ];
  }
  const margs: string[] = [];
  if (audio.syncMode === "animToAudio") {
    margs.push("-stream_loop", "-1", "-framerate", String(fps), "-i", "f%04d.png");
  } else {
    margs.push("-framerate", String(fps), "-i", "f%04d.png");
  }
  margs.push("-i", "mix.wav");
  margs.push(
    "-t",
    audio.durationSec.toFixed(3),
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-vf",
    MP4_COLOR_VF,
    "-pix_fmt",
    "yuv420p",
    ...MP4_COLOR_TAGS,
    "-movflags",
    "+faststart",
    "out.mp4"
  );
  return margs;
}

// ---------------- PNG連番 (zip) ----------------

export async function exportPngZip(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  const scaler = new FrameScaler(o.scale, o.whiteBg);
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < src.count; i++) {
    if (o.cancel.cancelled) return CANCELLED;
    const blob = await scaler.toPngBlob(src.getFrameRgba(i));
    if (!blob) throw new Error(t("export.pngGenFailed.msg"));
    // M11-21: 色チャンク（sRGB＋gAMA）を付ける。画素は不変
    files[`${pad4(i)}.png`] = withSrgbChunks(new Uint8Array(await blob.arrayBuffer()));
    o.onProgress(i + 1, src.count, "pngGen");
  }
  files["info.txt"] = new TextEncoder().encode(
    `frames=${src.count}\nfps=${src.fps}\nsize=${W * o.scale}x${H * o.scale}\nloop=${src.loop}\n`
  );
  o.onProgress(src.count, src.count, "zip");
  const zipped = zipSync(files, { level: 0 }); // PNGは圧縮済みのため store
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

// ---------------- GIF ----------------

/** M11-22: GIF の固定パレット上限（GIF の色表は 256 エントリ） */
export const GIF_MAX_PALETTE = 256;

/**
 * M11-22: 書き出す全コマの**実使用色**を数え、256 色以下なら gif.js の `globalPalette`
 * （r,g,b,… の平坦配列）を返す。257 色以上なら null（＝従来どおり NeuQuant に任せる）。
 * - gif.js は addFrame の RGBA から alpha を捨てて RGB で扱うので、**gif.js が見る色と同じ規則**で数える:
 *   alpha=255 → その RGB／alpha=0 → whiteBg なら白（FrameScaler が先に白で塗る）・OFF なら黒
 *  （clearRect 済み canvas の透明画素は (0,0,0,0)＝gif.js では黒）。0/255 以外の alpha は本アプリの合成では
 *   出ない（render.ts blendPixel は 0xff 固定・透明紙は 0）が、見つけたら安全側で null（NeuQuant へ）
 * - 拡大前の 320×240 で数える。FrameScaler は nearest の整数倍で新しい色を作らないので集合は同じ
 * - 色の順は「最初に現れた順」＝決定的（同じ入力なら同じパレット・同じ索引）
 * - 不透明度 <1 のレイヤーが作るブレンド色（合成後の RGB）もそのまま実使用色として数える
 */
export function collectGifPalette(src: FrameSource, whiteBg: boolean): number[] | null {
  const seen = new Set<number>();
  const order: number[] = [];
  for (let i = 0; i < src.count; i++) {
    const rgba = src.getFrameRgba(i);
    let prev = -1;
    for (let p = 0; p < PIXELS; p++) {
      const a = rgba[p * 4 + 3];
      let key: number;
      if (a === 255) key = (rgba[p * 4] << 16) | (rgba[p * 4 + 1] << 8) | rgba[p * 4 + 2];
      else if (a === 0) key = whiteBg ? 0xffffff : 0x000000;
      else return null; // 想定外の半透明 → 従来経路
      if (key === prev) continue; // 連続する同色は Set を叩かない
      prev = key;
      if (!seen.has(key)) {
        if (seen.size >= GIF_MAX_PALETTE) return null; // 257 色目 → 従来経路
        seen.add(key);
        order.push(key);
      }
    }
  }
  const pal: number[] = [];
  for (const k of order) pal.push((k >> 16) & 0xff, (k >> 8) & 0xff, k & 0xff);
  return pal;
}

export function exportGif(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const scaler = new FrameScaler(o.scale, o.whiteBg);
    // U-1: GIF のディレイはセンチ秒粒度（gif.js が ms→cs へ丸め）。既知の制約
    const delay = Math.round(1000 / src.fps);
    // M11-22: 実使用色が 256 色以下なら固定パレット（NeuQuant を通らない＝色は完全一致・全コマ同一パレット・
    // 2 コマ目以降のローカル色表なし）。257 色以上は従来どおり（オプションも従来と同一＝出力バイト列不変）
    o.onProgress(0, src.count * 2, "countColors");
    const palette = collectGifPalette(src, o.whiteBg);
    if (o.cancel.cancelled) {
      resolve(CANCELLED);
      return;
    }
    const gif = new GIF({
      workers: 2,
      quality: 10,
      width: scaler.ow,
      height: scaler.oh,
      repeat: src.loop ? 0 : -1,
      workerScript: gifWorkerUrl,
      ...(palette ? { globalPalette: palette } : {}),
    });
    gif.on("finished", (blob) => resolve(blob));
    gif.on("progress", (p) => {
      if (o.cancel.cancelled) {
        gif.abort();
        resolve(CANCELLED);
        return;
      }
      o.onProgress(src.count + Math.round(p * src.count), src.count * 2, "gifEncode");
    });
    try {
      for (let i = 0; i < src.count; i++) {
        if (o.cancel.cancelled) {
          resolve(CANCELLED);
          return;
        }
        scaler.draw(src.getFrameRgba(i));
        gif.addFrame(scaler.bigCtx, { delay, copy: true });
        o.onProgress(i + 1, src.count * 2, "frameGen");
      }
      gif.render();
    } catch (e) {
      reject(e);
    }
  });
}

// ---------------- APNG ----------------

export async function exportApng(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  const scaler = new FrameScaler(o.scale, o.whiteBg);
  const imgs: ArrayBuffer[] = [];
  const delays: number[] = [];
  const delay = 1000 / src.fps; // UPNG は ms 保持（分数fpsも正確）
  for (let i = 0; i < src.count; i++) {
    if (o.cancel.cancelled) return CANCELLED;
    imgs.push(scaler.toRgbaBytes(src.getFrameRgba(i)));
    delays.push(delay);
    o.onProgress(i + 1, src.count + 1, "frameGen");
    // UIを固まらせない
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  if (o.cancel.cancelled) return CANCELLED;
  o.onProgress(src.count, src.count + 1, "apngEncode");
  await new Promise((r) => setTimeout(r, 0));
  // ループは常に無限（num_plays=0）。loop=false の非ループは UPNG では指定不可（U-1同様・既知）
  // M11-21: UPNG は sRGB(1) を書くが gAMA を書かないので揃える（画素は不変）
  const encoded = withSrgbChunks(new Uint8Array(UPNG.encode(imgs, scaler.ow, scaler.oh, 0, delays)));
  o.onProgress(src.count + 1, src.count + 1, "done");
  return new Blob([encoded as unknown as BlobPart], { type: "image/png" });
}

// ---------------- MP4（無音・M6-2で音声対応） ----------------

export async function exportMp4(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  o.onProgress(0, src.count + 1, "encoderInit");
  // ffmpeg.wasm core はアプリに同梱（オフライン動作・実行時ネットワーク取得なし）
  const [{ FFmpeg }, { toBlobURL }, coreJs, coreWasm] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
    import("@ffmpeg/core?url"),
    import("@ffmpeg/core/wasm?url"),
  ]);
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(coreJs.default, "text/javascript"),
    wasmURL: await toBlobURL(coreWasm.default, "application/wasm"),
  });
  try {
    const scaler = new FrameScaler(o.scale, o.whiteBg);
    for (let i = 0; i < src.count; i++) {
      if (o.cancel.cancelled) return CANCELLED;
      const blob = await scaler.toPngBlob(src.getFrameRgba(i));
      if (!blob) throw new Error(t("export.pngGenFailed.msg"));
      await ffmpeg.writeFile(`f${pad4(i)}.png`, new Uint8Array(await blob.arrayBuffer()));
      o.onProgress(i + 1, src.count + 1, "frameWrite");
    }
    if (o.cancel.cancelled) return CANCELLED;
    ffmpeg.on("progress", ({ progress }) => {
      if (o.cancel.cancelled) {
        try {
          ffmpeg.terminate();
        } catch {
          /* noop */
        }
        return;
      }
      o.onProgress(
        src.count + Math.max(0, Math.min(1, progress)),
        src.count + 1,
        "mp4Encode"
      );
    });
    // フレームは拡大済みのため scale 不要（M11-21 の scale フィルタは色変換の指定だけで解像度は触らない）。
    // 分数fps（0.2等）も -framerate で正確。引数列は mp4ExecArgs（純関数・スモークで pin）
    const audio = o.audio ?? null;
    if (!audio) {
      // 無音経路（M6-1 と同一・M11-21 で色引数だけ追加）
      await ffmpeg.exec(mp4ExecArgs(src.fps, null));
    } else {
      // ---- M5-1: 音声 mux ----
      // 音は renderExportMix でミックス済みの WAV 1本（トリム/ループ/音量/速度rate/SE時刻は適用済み）。
      // ffmpeg 側は「WAVを1回入力して -t で決定的に切る」だけ（-af volume・音声側 stream_loop は撤去）。
      await ffmpeg.writeFile(
        "mix.wav",
        new Uint8Array(
          audio.wav.buffer.slice(audio.wav.byteOffset, audio.wav.byteOffset + audio.wav.byteLength)
        )
      );
      if (o.cancel.cancelled) return CANCELLED;
      // 長さ合わせ: -t=audio.durationSec（syncMode 規則で確定済み）
      //   audioToAnim（音をアニメに）: 映像1周 → 尺=アニメ
      //   animToAudio（アニメを音に）: 映像を無限ループ → 尺=（トリム後を rate 再生した）曲
      await ffmpeg.exec(mp4ExecArgs(src.fps, audio));
    }
    if (o.cancel.cancelled) return CANCELLED;
    const data = (await ffmpeg.readFile("out.mp4")) as Uint8Array;
    o.onProgress(src.count + 1, src.count + 1, "done");
    return new Blob([data as unknown as BlobPart], { type: "video/mp4" });
  } finally {
    try {
      ffmpeg.terminate();
    } catch {
      /* noop */
    }
  }
}

/** 形式ディスパッチ */
export function runExport(src: FrameSource, o: ExportOptions): Promise<Blob | null> {
  switch (o.format) {
    case "pngzip":
      return exportPngZip(src, o);
    case "gif":
      return exportGif(src, o);
    case "apng":
      return exportApng(src, o);
    case "mp4":
      return exportMp4(src, o);
  }
}

export const FORMAT_INFO: Record<
  ExportFormat,
  { labelKey: string; ext: string; mime: string; note?: string }
> = {
  mp4: { labelKey: "export.format.mp4.label", ext: "mp4", mime: "video/mp4" },
  gif: { labelKey: "export.format.gif.label", ext: "gif", mime: "image/gif" },
  apng: { labelKey: "export.format.apng.label", ext: "png", mime: "image/png" }, // M6-5 Q-5: 単語内改行防止のため短縮
  pngzip: { labelKey: "export.format.pngzip.label", ext: "zip", mime: "application/zip" },
};

// ---------------- M10-7: 動画・m4a から音声だけ抽出（MP3 192kbps） ----------------

/**
 * 動画（mp4/mov/webm/mkv）や m4a から**音声トラックだけ**を取り出して MP3 192kbps にする。
 * 同梱の ffmpeg.wasm core を使うので**実行時のネットワーク取得はゼロ**（オフライン完結）。
 *
 * 返すのは mp3 のバイト列だけで、動画そのものは保存しない。呼び出し側はこれを
 * 既存の外部音声（mp3 を選んだ場合）とまったく同じ流れに乗せる。
 *
 * `exportMp4` のロード部分と同じ形をとるが、**あちらは1行も変えていない**
 * （共通化して書き出しの挙動が変わるほうが損）。
 *
 * @returns 抽出できたら mp3 の Uint8Array、音声トラックが無い等で失敗したら null
 */
export async function extractAudioToMp3(
  bytes: Uint8Array,
  ext: string
): Promise<Uint8Array | null> {
  const [{ FFmpeg }, { toBlobURL }, coreJs, coreWasm] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
    import("@ffmpeg/core?url"),
    import("@ffmpeg/core/wasm?url"),
  ]);
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(coreJs.default, "text/javascript"),
    wasmURL: await toBlobURL(coreWasm.default, "application/wasm"),
  });
  const inName = `in.${ext.replace(/[^a-z0-9]/gi, "") || "bin"}`;
  try {
    await ffmpeg.writeFile(inName, bytes);
    // -vn: 映像を捨てる / -map 0:a:0: 最初の音声ストリームだけ
    const code = await ffmpeg.exec([
      "-i",
      inName,
      "-vn",
      "-map",
      "0:a:0",
      "-acodec",
      "libmp3lame",
      "-b:a",
      "192k",
      "out.mp3",
    ]);
    // 音声トラックが無い動画は非0で落ちる（out.mp3 も出ない）
    if (code !== 0) return null;
    const data = (await ffmpeg.readFile("out.mp3")) as Uint8Array;
    if (!data || data.byteLength === 0) return null;
    // ffmpeg の FS 上のバッファは terminate で消えるので、コピーを返す
    return new Uint8Array(data);
  } catch {
    return null;
  } finally {
    try {
      ffmpeg.terminate();
    } catch {
      /* 既に終了している場合は無視（書き出し側と同じ後始末） */
    }
  }
}
