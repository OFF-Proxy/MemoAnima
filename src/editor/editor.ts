// アニメモ エディタ（M3）コントローラ
// - キャンバスは 320×240 の canvas を CSS 整数倍＋image-rendering:pixelated で表示（ドット等倍）
// - 全ツールの結果は 320×240 格子に確定（SPEC §4）
// - レイヤー無制限・色両対応（パレット/フルカラー）・描き味トグル（OFFで3DS準拠）

import {
  Project,
  LayerDef,
  LayerFolder,
  IndexBuf,
  W,
  H,
  PIXELS,
  FPS_TABLE,
  PenTexture,
  ensureColor,
  allocIndexBuf,
  copyIndexBuf,
  promoteTo16,
  newLayerId,
  newFolderId,
  makeEmptyFrame,
  cloneFrame,
  conformFrameWidth,
  UGO_COLORS,
} from "./model";
import { compositeFrame, presentToCanvas, frameToPngBlob, flattenIndexFrame } from "./render";
import { History, bufferChangeEntry, multiBufferChangeEntry } from "./history";
// M10-2a: 変位マップエンジン（歪み3方式と M10-3 のゆらゆらが共有する適用側）
import { WarpField, applyWarp, isConvexQuad } from "./warp";
import * as R from "./raster";
import { FrameClip, makeClip, buildFramesFromClip } from "./frameClip";
import { FrameSource, projectSource, ExportAudioSource } from "./exporter";
import {
  AudioPreview,
  decodeAudio,
  getAudioCtx,
  bgmPlaybackRate,
  renderExportMix,
} from "./audio";
import type { BgmTrack, SeTrack, ProjectAudio, Frame } from "./model";
import { newSeId, sanitizeAudio } from "./model";
import { createSlider, SliderHandle } from "../ui/slider";
import { moveNodes, wouldCycle, topNodesOf, DropTarget } from "./layerTree";
// M10-1c: 書体テーブル・明示ロード・サイズ選択の規則は fonts.ts に集約
import {
  FONTS,
  DEFAULT_TEXT,
  fontDef,
  nearestSize,
  ensureFontsLoaded,
  sanitizeTextSettings,
  type FontKey,
} from "./fonts";

/** M10-1c: 文字ツールの設定（settings.json に永続化する） */
export interface TextSettings {
  family: FontKey;
  size: number;
  bold: boolean;
  /** M10-11: 縦書き。旧 settings.json に無ければ false */
  vertical: boolean;
}

type Tool =
  | "pen"
  | "eraser"
  | "brush"
  | "fill"
  | "shape"
  | "text"
  | "eyedrop"
  | "hand"
  | "select"
  | "transform"
  | "warp";

type ShapeKind = "line" | "rect" | "ellipse";

/** M10-2a: 歪みの方式。M10-2a で動くのは push のみ（残りは M10-2b/2c） */
type WarpMode = "push" | "bulge" | "pinch" | "corner";

// M10-3: ゆらゆら差分。種類と強さ（弱/中/強）
export type WobbleKind = "line" | "whole";
export type WobbleStrength = 0 | 1 | 2;

/** M10-2c: 四隅モード中だけ無効化する浮遊UI。×2 ズームでキャンバスの右上・右下の
 *  ハンドルに重なっていて、そのままでは4つ中2つが物理的に掴めない（実機で確認）。 */
const MUTED_OVERLAY_SELECTORS = [".cvright", "#ed-mini"];
/** 無効化中の不透明度。**設定側と比較側で必ずこの定数を使う**。
 *  `".4"` と書いて `"0.4"` で比べる形だと、CSSOM の正規化に依存して静かに壊れる。 */
const MUTED_OPACITY = "0.4";

/** M10-3 P-6: ゆらゆらの波長(L)と振幅(A)。**波長は固定**し、枚ごとの違いはシードだけで作る。
 *  振幅の下限を REQ の 1.5 / 0.5 ちょうどにしていないのは意図的で、0.5px だと
 *  `Math.round` で動く画素がごくわずかになり「押したのに何も起きない」に見えるため。 */
export const WOBBLE_TABLE: Record<WobbleKind, { L: number; A: number }[]> = {
  whole: [
    { L: 44, A: 1.8 },
    { L: 36, A: 2.4 },
    { L: 28, A: 3.0 },
  ],
  line: [
    { L: 7, A: 0.8 },
    { L: 6, A: 1.1 },
    { L: 5, A: 1.5 },
  ],
};

const PEN_SIZES = [1, 2, 3, 5, 8, 12];
// M5-4 B-3: ペンは「ベタ＋スプレー系」のみに整理。
// 旧 dot(点線)・halftone(網点=ブラシのトーンへ)は撤去、rough(かすれ)は sand（スプレー粗）へ集約・廃止。
// 既存作品の画素は不変（ツール状態は保存対象外・UIのみの整理）。
const TEXTURES: { key: PenTexture; label: string; icon: string }[] = [
  { key: "solid", label: "ベタ", icon: "━" },
  { key: "spray", label: "スプレー（細）", icon: "░" },
  { key: "sand", label: "スプレー（粗）", icon: "▒" },
];

export interface EditorSaveContext {
  libRoot: string;
  album: string;
  /** 拡張子なしのファイル名ベース */
  baseName: string;
}

export interface EditorCallbacks {
  onExit: () => void;
  onSaved: (path: string) => void;
  /** M8-2: 📷 画像をこのページに配置（変換モーダルは main.ts 側・共用） */
  importImage?: () => void;
  /** M10-1c: 文字ツールの書体・サイズ・太さが変わったら settings.json へ保存する
   *  （変えた瞬間だけ。文字を置くたびには呼ばない） */
  onTextSettingsChange?: (t: TextSettings) => void;
  /** ライブラリ保存（Rust呼び出し）を委譲 */
  saveProject: (
    ctx: EditorSaveContext,
    data: Uint8Array,
    thumbPng: Uint8Array
  ) => Promise<string>;
  /** F-4: 保存先ピッカー（既存アルバム一覧＋新規作成＋ファイル名） */
  pickSaveTarget: (
    defaultAlbum: string,
    defaultName: string
  ) => Promise<{ album: string; baseName: string } | null>;
  /** F-3: オートセーブ（アプリ設定領域へ・原子的保存はRust側） */
  autosave: (data: Uint8Array, meta: Record<string, unknown>) => Promise<void>;
  clearAutosave: () => Promise<void>;
  /** M6-1/2: エクスポートダイアログを開く（範囲初期値=フィルムの範囲選択・音声ソース付き）。
   *  M5-1: audio はミックス生成関数込みの ExportAudioSource（範囲・モード確定後にレンダ）。
   *  M6-4 P-6: onSyncModeChange=ダイアログの「書き出す長さ」変更をプロジェクトへ書き戻すフック */
  openExport: (
    source: FrameSource,
    baseName: string,
    defaultRange?: { a: number; b: number } | null,
    audio?: ExportAudioSource | null,
    onSyncModeChange?: (m: "audioToAnim" | "animToAudio") => void
  ) => void;
  /** M6-2: 音声ファイル（mp3/wav/ogg）を選んで読み込む。
   *  M10-8: m4a と動画（mp4/mov/webm/mkv）も通る。動画は main.ts 側で
   *  音声だけ MP3 192kbps に抽出されてから、外部音声と同じ形で返ってくる。 */
  pickAudioFile: () => Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
  confirm: (msg: string) => Promise<boolean>;
  prompt: (msg: string, def: string) => Promise<string | null>;
  toast: (msg: string) => void;
  /** M10-21: 入力診断ログ（ローカルの memoanima.log へ）。`?inputlog` か
   *  VITE_INPUTLOG=1 ビルドでのみ editor から呼ばれる。通常は一切呼ばれない */
  appendLog?: (text: string) => void;
}

/** M10-23: メインスレッドを一瞬手放して、待っている入力イベントを先に処理させる。
 *  scheduler.yield（入力優先の正式API・Chromium 129+）があればそれを、無ければ
 *  MessageChannel のマクロタスク（setTimeout と違い 4ms クランプが無い）で代替する。
 *  オートセーブの分割エンコードがチャンク間で呼ぶ。 */
function yieldToInput(): Promise<void> {
  const sch = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sch?.yield === "function") return sch.yield();
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

/** M6-6 R-2: 回転ゾーンのカーソルは標準 grab に変更。
 *  SVGカスタムカーソルは実機（WebView2＋ペンタブ）で表示されない/判別できないため撤去し、
 *  カーソル非依存の視覚補助（モードラベル .xmode-label）を併設する。 */
const ROTATE_CURSOR = "grab";

export class Editor {
  project!: Project;
  saveCtx: EditorSaveContext | null = null;
  cb!: EditorCallbacks;

  frameIndex = 0;
  activeLayerId = "";
  tool: Tool = "pen";
  prevTool: Tool = "pen";
  shapeKind: ShapeKind = "line";
  shapeFill = false;
  selectKind: "rect" | "lasso" | "auto" = "rect";
  /** M10-21: 入力診断ログの有効フラグ（mount 時に判定。通常起動では false のまま） */
  private inputLog = false;
  private inputLogBuf: string[] = [];
  private inputLogTimer: number | null = null;
  /** M10-19: 自動選択（✨）の参照（false=このレイヤー / true=全レイヤー）。セッションのみ */
  selectRefAll = false;
  /** M10-19: 自動選択の範囲（false=つながり=4方向連結 / true=画面全体の同添字） */
  selectAutoGlobal = false;
  /** M10-19: バケツ塗りの参照（false=このレイヤー（既定・従来） / true=全レイヤー）。セッションのみ */
  fillRefAll = false;
  colorHex: string = UGO_COLORS.black;
  penSize = 3;
  texture: PenTexture = "solid";
  /** M5-4: ブラシのトーンパターン（ペンの texture とは独立に記憶。既定=網点大） */
  brushToneId = "halftone-l";
  /** M5-5 T-3: バケツ塗りのトーン（ブラシとは独立に記憶。既定=ベタ） */
  fillToneId = "solid";
  onionLevel = 0;
  stabilizer = true;
  pressureEnabled = true;
  textSize = DEFAULT_TEXT.size;
  /** M10-1c: 文字ツールの書体と太さ（既定は現行の見た目に最も近い 丸文字/16px/太字） */
  textFamily: FontKey = DEFAULT_TEXT.family;
  textBold = DEFAULT_TEXT.bold;
  /** M10-11: 縦書き（1列・上から下）。textBold と同じ流儀で永続化する */
  textVertical = false;
  /** E-2: ピクセル格子（1ドット≥8px で表示・既定ON） */
  gridEnabled = true;
  /** E-1: Space押下中の一時手のひら */
  private spaceHeld = false;
  private panState: { sx: number; sy: number; sl: number; st: number } | null = null;

  // 表示
  zoomMode: "fit" | number = "fit";
  viewRot = 0; // 0/90/180/270
  viewFlipH = false;
  previewLarge = false;

  // 再生
  playing = false;
  playTimer: number | null = null;

  history = new History();
  /** ライブラリ未保存の変更があるか。true をセットするとオートセーブ対象にもなる */
  private _dirty = false;
  private autosavePending = false;
  private autosaveTimer: number | null = null;
  /** 保存/破棄でインクリメント。古い世代のオートセーブ書き込みを無効化する */
  private autosaveEpoch = 0;
  private autosaveInFlight: Promise<void> | null = null;
  /** 保存時に必ず保存先ピッカーを出すか（新規メモ・合作・保存先未定） */
  askSaveTarget = false;

  get dirty(): boolean {
    return this._dirty;
  }
  set dirty(v: boolean) {
    this._dirty = v;
    if (v) this.autosavePending = true;
  }

  // ストローク中
  private strokeBefore: IndexBuf | null = null;
  private strokeSeed = 1;
  private dashAcc = { d: 0 };
  private lastPt: { x: number; y: number } | null = null;
  private smoothPt: { x: number; y: number } | null = null;
  private pointerDown = false;
  private shapeStart: { x: number; y: number } | null = null;
  /** M10-7: 図形ドラッグ中の**生の**終点（拘束前）。Shift の押下/解放を
   *  マウスを動かさずに即反映するため、拘束前の座標を保持しておく必要がある */
  private shapeLastPt: { x: number; y: number } | null = null;
  /** M10-7: Shift の押下状態。pointer イベントの `shiftKey` を真実として毎回同期し、
   *  keydown/keyup でも更新する（ウィンドウ非フォーカス中の押下を取りこぼさないため） */
  private shiftHeld = false;
  // 歪み（M10-2a）。パラメータは既存の流儀に合わせて永続化しない（penSize 等と同じ）
  private warpMode: WarpMode = "push";
  private warpRadius = 24;
  private warpStrength = 50;
  private warpField: WarpField | null = null;
  /** ストローク開始時の全レイヤースナップショット（layerId -> IndexBuf）。適用元は常にこれ */
  private warpBefore: Record<string, IndexBuf> | null = null;
  private warpLastPt: { x: number; y: number } | null = null;
  /** M10-2b: 魚眼の中心。**ストローク開始位置で固定**する（追従させない）。
   *  中心が動くと場が複数中心の重ね合わせになって魚眼でなくなり、液状化の亜種になる。
   *  また行き過ぎ止めは「変位が径方向である」ことを前提にしているので、前提が崩れる。 */
  private warpCenter: { x: number; y: number } | null = null;
  /** M10-2b: 押しっぱなし連続適用のタイマー */
  private warpTimer: number | null = null;
  // M10-2c: 四隅変形。**transform とは独立した状態機械**にする（REQ §3.5）。
  // transform は「アクティブレイヤー1枚を floatBuf で切り出す」前提で
  // xformCutDone / selMoveBefore / cancelSelectionMove と絡んでいるので、
  // 全レイヤーへ当てる射影変換をそこへ差し込むと M5-3 → M5-5 系の退行を再演する。
  private cornerActive = false;
  /** 変形後の四隅（左上→右上→右下→左下）。ドット座標 */
  private cornerPts: { x: number; y: number }[] = [];
  /** 変形前の矩形（選択範囲があればその外接矩形、なければキャンバス全体） */
  private cornerRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private cornerBefore: Record<string, IndexBuf> | null = null;
  /** 掴んでいるハンドルの index（0..3）。null = 掴んでいない */
  private cornerDrag: number | null = null;
  /** 四隅モード中だけ pointer-events を切った浮遊UIと、その元の値 */
  private cornerMuted: { el: HTMLElement; prevPe: string; prevOp: string }[] = [];
  /** M10-3: エディタ内の自前ダイアログの開いている数。>0 の間はショートカットを通さない */
  private modalDepth = 0;
  /** M10-4 P-1-3: ゆらゆらダイアログの閉じ手（`audioPanelClose` と同じ流儀）。
   *  開いたまま unmount されると modalDepth が 1 のまま残り、再 mount 後に
   *  ショートカットが全滅する。**modalDepth を直接 0 にはしない**（片付け漏れが隠れる） */
  private wobbleDialogClose: (() => void) | null = null;
  private lassoPts: { x: number; y: number }[] = [];

  // 選択・変形
  private selMask: Uint8Array | null = null;
  private floatBuf: R.FloatBuf | null = null;
  private xform: R.Transform = {
    tx: 0,
    ty: 0,
    angle: 0,
    sx: 1,
    sy: 1,
    flipH: false,
    flipV: false,
  };
  private xformActive = false;
  private dragMode: "" | "move" | "scale" | "rotate" | "selmove" = "";
  private dragStart: { x: number; y: number } | null = null;
  private dragBase: R.Transform | null = null;
  private static clipboard: R.FloatBuf | null = null;
  /** M3.3: ページ／複数ページ・クリップボード（アプリ全体・クロスメモ保持） */
  private static frameClip: FrameClip | null = null;
  /** フィルムの範囲選択（Shift+クリック）。コマ構造変更でリセット */
  private rangeAnchor: number | null = null;
  private rangeSel: { a: number; b: number } | null = null;

  private composite = new Uint32Array(PIXELS);
  private keydownHandler = (e: KeyboardEvent) => {
    // M10-7: 図形の Shift 拘束を**マウスを動かさずに**即反映する。
    // 条件を満たさないときは何もしない（preventDefault もしない）ので、
    // 変形の15°スナップ・フィルム/レイヤーの Shift 範囲選択・Ctrl+Shift+C/V には触れない
    if (e.key === "Shift") {
      this.shiftHeld = true;
      this.refreshShapePreview();
    }
    this.onKeyDown(e);
  };
  private keyupHandler = (e: KeyboardEvent) => {
    if (e.key === " ") {
      this.spaceHeld = false;
      this.updatePanCursor();
    }
    if (e.key === "Shift") {
      this.shiftHeld = false;
      this.refreshShapePreview();
    }
  };
  private resizeHandler = () => this.applyZoom();
  private mounted = false;
  /** F-0対策: フィルムサムネは縮小解像度・可視分のみ遅延描画（canvasメモリ上限対策） */
  private static readonly THUMB_W = 80;
  private static readonly THUMB_H = 60;
  private filmScratch: HTMLCanvasElement | null = null;
  private filmObserver: IntersectionObserver | null = null;
  private resizeObs: ResizeObserver | null = null;

  // ---------------- 起動/終了 ----------------

  mount(
    project: Project,
    saveCtx: EditorSaveContext | null,
    cb: EditorCallbacks,
    opts: { askSaveTarget?: boolean } = {}
  ) {
    this.project = project;
    this.saveCtx = saveCtx;
    this.askSaveTarget = opts.askSaveTarget ?? saveCtx == null;
    this.cb = cb;
    this.frameIndex = 0;
    this.activeLayerId = project.layerDefs[project.layerDefs.length - 1]?.id ?? "";
    this.history.clear();
    this.dirty = false;
    this.mounted = true;
    this.playing = false;
    this.selMask = null;
    this.floatBuf = null;
    this.xformActive = false;
    // 表示状態は前回セッションを持ち越さない（swapped/回転/ズームのリセット）
    this.previewLarge = false;
    this.viewRot = 0;
    this.viewFlipH = false;
    this.zoomMode = "fit";
    // 範囲選択も前のメモを持ち越さない（古いインデックスでのコピー/クラッシュ防止）
    this.rangeSel = null;
    this.rangeAnchor = null;
    // フォルダ選択も持ち越さない（別プロジェクトの dangling parent 防止・Codexレビュー指摘#3）
    this.selectedFolderId = null;
    $("#ed-stage").classList.remove("swapped");

    // M10-21: 入力診断フラグ（?inputlog または VITE_INPUTLOG=1 の診断ビルド）。
    // 通常起動では false のまま＝bindCanvas が従来の直結ハンドラを張る
    this.inputLog =
      new URLSearchParams(location.search).has("inputlog") ||
      import.meta.env.VITE_INPUTLOG === "1";
    this.buildToolsPanel();
    this.buildSidePanel();
    this.buildTimeline();
    this.bindHeader();
    this.bindCanvas();
    window.addEventListener("keydown", this.keydownHandler);
    window.addEventListener("keyup", this.keyupHandler);
    window.addEventListener("resize", this.resizeHandler);
    this.spaceHeld = false;
    $("#ed-title").textContent = `✏ ${project.meta.title || "無題"}`;
    this.applyZoom();
    this.refreshAll();
    // F-0対策: レイアウト確定後にサイズ確定＋再描画（表示直後は clientWidth が不定になり得る）。
    // 以後のサイズ変化にも ResizeObserver で追従する（applyZoom はサイズ設定のみなので再描画も呼ぶ）。
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!this.mounted) return;
        this.applyZoom();
        this.renderCanvas();
      })
    );
    this.resizeObs = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (!this.mounted) return;
        this.applyZoom();
        this.renderCanvas();
      });
    });
    this.resizeObs.observe($("#ed-stage"));
    // F-3: オートセーブ（15秒間隔・変更があるときだけ・描画中はスキップ）
    this._dirty = false;
    this.autosavePending = false;
    this.autosaveTimer = window.setInterval(() => void this.runAutosave(), 15000);
  }

  unmount() {
    this.stopPlayback();
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
    window.removeEventListener("resize", this.resizeHandler);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.filmObserver?.disconnect();
    this.filmObserver = null;
    if (this.autosaveTimer != null) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    // M10-2b 積み残し: 連続適用タイマーを止める。
    // unmount() は pointerDown を触らないので、押しっぱなしのまま閉じるとタイマー側の
    // 三重ガード（pointerDown/tool/warpMode）を全部すり抜けて stepFisheye() が**1回実行される**。
    // pointerUp が来ないため履歴にも積まれず、Undo 不能な1段階の歪みが焼かれてしまう。
    this.clearFisheyeRepeat();
    // M10-2c: 未確定の四隅変形が残ったまま閉じないように取り消す（全画素を元へ戻す）。
    // DOM が消えかけているので silent（UI 更新なし）で呼ぶ
    if (this.cornerActive) this.cancelCornerWarp(true);
    this.warpCenter = null;
    this.warpField = null; // 最大 1.5MB を保持し続けないように
    this.warpBefore = null;
    this.warpLastPt = null;
    this.audioPreview.invalidate();
    this.audioPanelClose?.();
    // M10-4 P-1-3: 開いたままのゆらゆらダイアログを閉じる。close(null) を通るので
    // modalDepth の減算・capture リスナー解除・back.remove() が全部走り、
    // await 側は null を受け取って早期 return する（生成は起きない）
    this.wobbleDialogClose?.();
    // M10-21: 診断ログの残りを吐き切ってタイマーを止める（フラグなしなら両方とも空/None）
    if (this.inputLogTimer != null) {
      window.clearTimeout(this.inputLogTimer);
      this.inputLogTimer = null;
    }
    const rest = this.inputLogBuf.splice(0);
    if (rest.length) this.cb.appendLog?.(rest.join("\n"));
    this.mounted = false;
  }

  /** F-3: 変更があればアプリ設定領域へオートセーブ（保存の原子性はRust側が担保） */
  private async runAutosave() {
    // 変形/選択の浮動中はレイヤーから切り出したピクセルがプロジェクト外にあるため
    // スナップショットが欠損する — スキップして次周期へ（Codexレビュー指摘#6）
    if (
      !this.mounted ||
      !this.autosavePending ||
      // M10-23: 分割エンコード化で1回の所要が長くなり、15秒interval と3秒リトライが
      // 重なり得る。多重併走すると invalidateAutosave が後発の飛行中書き込みを待てない
      //（レビュー検出）。前の便が飛行中なら見送る（pending は残るので次の機会に走る）
      this.autosaveInFlight != null ||
      this.pointerDown ||
      this.xformActive ||
      this.floatBuf ||
      // M10-2c: 四隅変形は確定するまで何秒でも未確定のプレビューが置かれたままになる。
      // ここを塞がないと、確定していない絵がそのまま保存される
      this.cornerActive
    )
      return;
    this.autosavePending = false;
    const epoch = this.autosaveEpoch;
    const job = (async () => {
      const { projectToBytesInterruptible } = await import("./serialize");
      // M10-23: 大型作品でエンコードがメインスレッドを数秒塞いでいた（300ページで約2.7秒
      // →ペンの pointerdown が最大1.9秒待たされる実測）。チャンクごとに入力へ譲り、
      // エンコード中に編集が起きたら破棄して次の機会に回す（途切れたスナップショットは
      // 決して書かない）。変更は必ず dirty→autosavePending か history.mutations に現れる
      //（bufferChangeEntry の onApply / afterFrameStructureChange 等が dirty を立てる）
      const hist0 = this.history.mutations;
      const data = await projectToBytesInterruptible(this.project, {
        yieldNow: yieldToInput,
        aborted: () =>
          !this.mounted ||
          epoch !== this.autosaveEpoch ||
          this.autosavePending ||
          this.history.mutations !== hist0 ||
          this.pointerDown ||
          this.xformActive ||
          !!this.floatBuf ||
          this.cornerActive,
      });
      if (!data) {
        // 中断（エンコード中に編集が始まった等）。変更は残っているので保存待ちに戻し、
        // 次の15秒周期を待たずに、ペンを置いた隙間で保存できるよう短い再試行を1回だけ予約
        if (this.mounted && epoch === this.autosaveEpoch) {
          this.autosavePending = true;
          window.setTimeout(() => void this.runAutosave(), 3000);
        }
        return;
      }
      // 直前にライブラリ保存/破棄が完了していたら、この古いスナップショットは書かない
      if (epoch !== this.autosaveEpoch || !this.mounted) return;
      await this.cb.autosave(data, {
        title: this.project.meta.title ?? "無題",
        album: this.saveCtx?.album ?? null,
        baseName: this.saveCtx?.baseName ?? null,
        libRoot: this.saveCtx?.libRoot || null,
        askSaveTarget: this.askSaveTarget,
        savedAt: new Date().toISOString(),
      });
    })();
    const flight = job.then(
      () => {},
      () => {
        // オートセーブ失敗は編集を妨げない（次周期で再試行）
        if (epoch === this.autosaveEpoch) this.autosavePending = true;
      }
    );
    this.autosaveInFlight = flight;
    await flight;
    // 入口ガードにより多重併走はしない想定だが、万一に備え自分の便のときだけ空にする
    if (this.autosaveInFlight === flight) this.autosaveInFlight = null;
  }

  /** 進行中のオートセーブを待ち、以後の古い書き込みを無効化してからスロットを消す */
  private async invalidateAutosave() {
    this.autosaveEpoch++;
    this.autosavePending = false;
    if (this.autosaveInFlight) await this.autosaveInFlight.catch(() => {});
    await this.cb.clearAutosave().catch(() => {});
  }

  // ---------------- UI 構築 ----------------

  private buildToolsPanel() {
    const tools: { key: Tool; icon: string; label: string }[] = [
      // M3.10 G-2: 手のひらは最上段（ペンの上）。H/Space の割当は不変
      { key: "hand", icon: "✋", label: "手のひら" },
      { key: "pen", icon: "✏", label: "ペン" },
      { key: "brush", icon: "🖌", label: "ブラシ" },
      { key: "eraser", icon: "🧽", label: "消しゴム" },
      { key: "fill", icon: "🪣", label: "塗り" },
      { key: "shape", icon: "⬛", label: "図形" },
      { key: "text", icon: "Ａ", label: "文字" },
      { key: "eyedrop", icon: "💧", label: "スポイト" },
    ];
    const edits: { key: Tool | "copyprev" | "clear"; icon: string; label: string }[] = [
      { key: "select", icon: "⬚", label: "範囲選択" },
      { key: "transform", icon: "🔀", label: "変形" },
      // M10-2a: 方式（押す/ふくらませ/へこませ/四隅）はツールオプション内で切り替える。
      // 方式ごとにボタンを増やすと段組みが崩れるので、ツールは1つだけ（REQ §3.6）
      { key: "warp", icon: "🌊", label: "歪み" },
      { key: "copyprev", icon: "🗐", label: "複写" },
      { key: "clear", icon: "🌀", label: "消す" },
    ];
    const host = $("#ed-tools");
    host.innerHTML = "";
    const mk = (icon: string, label: string, key: string) => {
      const b = document.createElement("button");
      b.className = "tool";
      b.dataset.tool = key;
      b.innerHTML = `<span class="em">${icon}</span><span class="nm">${label}</span>`;
      return b;
    };
    for (const t of tools) {
      const b = mk(t.icon, t.label, t.key);
      b.addEventListener("click", () => this.setTool(t.key));
      host.appendChild(b);
    }
    const lbl = document.createElement("div");
    lbl.className = "tlabel";
    lbl.textContent = "─ 編集 ─";
    host.appendChild(lbl);
    for (const t of edits) {
      const b = mk(t.icon, t.label, t.key);
      b.addEventListener("click", () => {
        if (t.key === "copyprev") this.copyPrevFrame();
        else if (t.key === "clear") this.clearFrame();
        else this.setTool(t.key as Tool);
      });
      host.appendChild(b);
    }
    // M8-2b: 画像取り込みは左ツール列の「♪ 音声」直上（上部バーから移設）。
    // ツール選択ではないので dataset.tool は既存ツールと重ならない値にする（"on" が付かない）
    const img = mk("📷", "画像", "image");
    img.id = "ed-tool-image";
    img.title = "画像を取り込む（このページに配置）";
    img.addEventListener("click", () => {
      if (this.xformGuard()) return;
      if (this.playing) this.stopPlayback();
      this.cb.importImage?.();
    });
    host.appendChild(img);
    // M6-3 A-3: 音声は左ツール列のボタン → 波形調整パネル（モーダル）
    const au = mk("♪", "音声", "audio");
    au.id = "ed-tool-audio";
    au.addEventListener("click", () => void this.openAudioPanel());
    host.appendChild(au);
    this.updateAudioToolButton();
    this.updateToolButtons();
  }

  /** 音声ボタンの状態表示（♪=あり / 🔇=全ミュート / 薄色♪=なし）。M5-1: BGM+SE対応 */
  private updateAudioToolButton() {
    const b = document.querySelector("#ed-tool-audio") as HTMLElement | null;
    if (!b) return;
    const a = this.project.audio ?? null;
    const has = !!a && (!!a.bgm || a.se.length > 0);
    const allMuted =
      has && (!a!.bgm || a!.bgm.muted) && a!.se.every((s) => s.muted) && (a!.bgm != null || a!.se.length > 0);
    const em = b.querySelector(".em") as HTMLElement;
    em.textContent = has && allMuted ? "🔇" : "♪";
    b.style.opacity = has ? "1" : "0.55";
    const bgmLabel = !a?.bgm
      ? "BGMなし"
      : a.bgm.source === "kwz"
        ? "BGM: 元の音（3DS作品由来）"
        : `BGM: ${a.bgm.name ?? "外部音声"}`;
    b.title = !has
      ? "音声なし（クリックで読み込み）"
      : `${bgmLabel}・SE ${a!.se.length}本${allMuted ? "・全ミュート中" : ""}`;
  }

  /** M5-4 B-3/M5-5 T-3: ペン=テクスチャ3種 / ブラシ・バケツ=トーンピッカー（2列・大小並び・各自独立記憶） */
  private rebuildTexPicker() {
    const head = document.querySelector("#ed-texhead") as HTMLElement | null;
    const tex = document.querySelector("#ed-tex") as HTMLElement | null;
    if (!head || !tex) return;
    tex.innerHTML = "";
    const toneMode =
      this.tool === "brush" ? "brush" : this.tool === "fill" ? "fill" : null;
    if (toneMode) {
      head.textContent =
        toneMode === "brush" ? "トーンパターン（ブラシ）" : "塗りのトーン（バケツ）";
      tex.classList.add("tonegrid");
      const getId = () => (toneMode === "brush" ? this.brushToneId : this.fillToneId);
      const setId = (id: string) => {
        if (toneMode === "brush") this.brushToneId = id;
        else this.fillToneId = id;
      };
      for (const t of R.TONE_TILES) {
        const d = document.createElement("button");
        d.className = "tone-btn" + (t.id === getId() ? " on" : "");
        d.title = t.name;
        // スウォッチ: 32×32 バッキング（8×8タイル×4リピート・等倍描画）→ CSS ×2 pixelated
        const cv = document.createElement("canvas");
        cv.width = 32;
        cv.height = 32;
        const ctx = cv.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, 32, 32);
        ctx.fillStyle = "#2c2621";
        for (let y = 0; y < 32; y++)
          for (let x = 0; x < 32; x++)
            if (!t.tile || R.toneAt(t.tile, x, y)) ctx.fillRect(x, y, 1, 1);
        d.appendChild(cv);
        d.addEventListener("click", () => {
          setId(t.id);
          tex.querySelectorAll(".tone-btn").forEach((e) => e.classList.remove("on"));
          d.classList.add("on");
        });
        tex.appendChild(d);
      }
    } else {
      head.textContent = "ペンの種類";
      tex.classList.remove("tonegrid");
      for (const t of TEXTURES) {
        const d = document.createElement("button");
        d.className = "tx" + (t.key === this.texture ? " on" : "");
        d.title = t.label;
        d.textContent = t.icon;
        d.addEventListener("click", () => {
          this.texture = t.key;
          tex.querySelectorAll(".tx").forEach((e) => e.classList.remove("on"));
          d.classList.add("on");
        });
        tex.appendChild(d);
      }
    }
  }

  private setTool(t: Tool) {
    if (this.xformActive && t !== "transform") this.cancelTransform();
    // M10-2c: 歪み以外へ抜けるときは未確定の四隅変形を取り消す
    if (this.cornerActive && t !== "warp") this.cancelCornerWarp();
    // M10-2b: 歪み以外へ切り替えたら連続適用タイマーを確実に止める
    if (t !== "warp") {
      this.clearFisheyeRepeat();
      this.warpCenter = null;
    }
    this.prevTool = this.tool;
    this.tool = t;
    if (t === "transform") this.beginTransform();
    // M10-2c: 歪みへ戻ってきたときにモードが corner のままなら再開する
    // （これが無いとハンドルの出ていない死んだモードになる）
    if (t === "warp" && this.warpMode === "corner" && !this.cornerActive)
      this.beginCornerWarp();
    this.updateToolButtons();
    this.buildToolOptions();
    this.rebuildTexPicker(); // M5-4: ペン⇄ブラシでピッカー切替（各自の選択を記憶）
    this.redrawOverlay();
  }

  private updateToolButtons() {
    document.querySelectorAll("#ed-tools .tool").forEach((el) => {
      el.classList.toggle("on", (el as HTMLElement).dataset.tool === this.tool);
    });
  }

  private buildSidePanel() {
    const host = $("#ed-side");
    host.innerHTML = `
      <h3>ペンの太さ</h3><div class="sizes" id="ed-sizes"></div>
      <h3 id="ed-texhead">ペンの種類</h3><div class="tex" id="ed-tex"></div>
      <h3 id="ed-colhead">カラー（パレット）</h3>
      <div class="pal" id="ed-pal"></div>
      <div class="row" style="margin-top:2px">
        <span class="tog">フルカラー</span><div class="sw2" id="ed-fullcolor"></div>
        <input type="color" id="ed-colorpick" value="#141414" style="width:40px;height:28px;border:3px solid var(--ink);border-radius:8px;padding:0;background:#fff" hidden />
      </div>
      <div class="row"><span class="tog">紙の色</span><div id="ed-paperpal" class="pal" style="flex:1"></div></div>
      <h3>レイヤー <button class="minibtn" id="ed-layer-add">＋</button>
        <button class="minibtn" id="ed-folder-add" title="フォルダ追加（選択レイヤーを包む）">📁</button>
        <button class="minibtn" id="ed-layer-del">🗑</button>
        <button class="minibtn" id="ed-layer-merge" title="下と統合">⇓統合</button></h3>
      <div id="ed-layers"></div>
      <h3>透かす（オニオンスキン）</h3><div class="oni" id="ed-onion"></div>
      <h3>描き味（PC拡張・OFFで3DS準拠）</h3>
      <div class="row"><span class="tog">手ブレ補正</span><div class="sw2 on" id="ed-tog-stab"></div></div>
      <div class="row"><span class="tog">筆圧で太さ</span><div class="sw2 on" id="ed-tog-press"></div></div>
      <div class="row"><span class="tog">ピクセル格子（高倍率時）</span><div class="sw2 on" id="ed-tog-grid"></div></div>
      <div id="ed-toolopts"></div>
    `;
    // 太さ
    const sizes = $("#ed-sizes");
    for (const s of PEN_SIZES) {
      const d = document.createElement("button");
      d.className = "sz" + (s === this.penSize ? " on" : "");
      d.innerHTML = `<i style="width:${Math.min(18, s + 2)}px;height:${Math.min(18, s + 2)}px"></i>`;
      d.title = `${s}ドット`;
      d.addEventListener("click", () => {
        this.penSize = s;
        sizes.querySelectorAll(".sz").forEach((e) => e.classList.remove("on"));
        d.classList.add("on");
      });
      sizes.appendChild(d);
    }
    // M5-4: ペン=テクスチャ3種 / ブラシ=トーンパターンピッカー（ツールで切替・各自の選択を記憶）
    this.rebuildTexPicker();
    this.rebuildPalette();
    // フルカラー切替
    const fc = $("#ed-fullcolor");
    fc.classList.toggle("on", this.project.colorMode === "fullcolor");
    $("#ed-colorpick").hidden = this.project.colorMode !== "fullcolor";
    fc.addEventListener("click", () => {
      this.project.colorMode =
        this.project.colorMode === "palette" ? "fullcolor" : "palette";
      fc.classList.toggle("on", this.project.colorMode === "fullcolor");
      $("#ed-colorpick").hidden = this.project.colorMode !== "fullcolor";
      $("#ed-colhead").textContent =
        this.project.colorMode === "fullcolor"
          ? "カラー（フルカラー）"
          : "カラー（パレット）";
      this.dirty = true;
    });
    ($("#ed-colorpick") as HTMLInputElement).addEventListener("input", (e) => {
      this.colorHex = (e.target as HTMLInputElement).value;
      this.rebuildPalette();
    });
    // レイヤー操作
    $("#ed-layer-add").addEventListener("click", () => this.addLayer());
    $("#ed-folder-add").addEventListener("click", () => this.addFolder());
    $("#ed-layer-del").addEventListener("click", () => this.deleteLayer());
    // M3.8: ▲▼はDnD（挿入線）で代替・撤去
    $("#ed-layer-merge").addEventListener("click", () => this.mergeLayerDown());
    this.rebuildLayers();
    // オニオン
    const oni = $("#ed-onion");
    ["切", "1", "2", "3"].forEach((label, lv) => {
      const d = document.createElement("button");
      d.className = "lv" + (lv === this.onionLevel ? " on" : "");
      d.textContent = label;
      d.addEventListener("click", () => {
        this.onionLevel = lv;
        oni.querySelectorAll(".lv").forEach((e) => e.classList.remove("on"));
        d.classList.add("on");
        this.renderCanvas();
      });
      oni.appendChild(d);
    });
    // トグル
    const bindTog = (id: string, get: () => boolean, set: (v: boolean) => void) => {
      const el = $(id);
      el.classList.toggle("on", get());
      el.addEventListener("click", () => {
        set(!get());
        el.classList.toggle("on", get());
      });
    };
    bindTog("#ed-tog-stab", () => this.stabilizer, (v) => (this.stabilizer = v));
    bindTog("#ed-tog-press", () => this.pressureEnabled, (v) => (this.pressureEnabled = v));
    bindTog(
      "#ed-tog-grid",
      () => this.gridEnabled,
      (v) => {
        this.gridEnabled = v;
        this.applyZoom();
      }
    );
    this.buildToolOptions();
  }

  // ---------------- 音声UI（M6-3: 波形調整パネル） ----------------

  private audioPreview = new AudioPreview();
  private audioPanelEl: HTMLElement | null = null;
  private audioPanelClose: (() => void) | null = null;

  /** A-2: 波形＋コマ目盛＋試し再生の大パネル。
   *  M5-1: BGM側は従来どおり作業コピー（適用までプロジェクトに触らない）。
   *  SE側（トラック・コマ配置）は**即時反映＋Undo履歴**（handoff §6 の規則）。 */
  private async openAudioPanel() {
    if (this.audioPanelEl) return;
    if (this.playing) this.stopPlayback();
    const proj = this.project;
    const orig = proj.audio?.bgm ?? null;
    const fps = FPS_TABLE[proj.speedIndex] || 8;
    const frameCount = proj.frames.length;
    // BGM 作業コピー（キャンセルで破棄）
    const w = {
      bytes: (orig?.data ?? null) as Uint8Array | null,
      mime: orig?.mime ?? "audio/wav",
      name: orig?.name as string | undefined,
      source: (orig?.source ?? "external") as "kwz" | "external" | "mic",
      muted: orig?.muted ?? false,
      volume: orig?.volume ?? 1,
      trimStartMs: orig?.trimStartMs ?? 0,
      trimEndMs: (orig?.trimEndMs ?? null) as number | null,
      syncMode: (orig?.syncMode ?? "audioToAnim") as "audioToAnim" | "animToAudio",
      baseSpeedIndex: orig?.baseSpeedIndex ?? proj.speedIndex,
      deleted: false,
    };
    let buffer: AudioBuffer | null = null;
    // M6-4 P-3: 対数ズーム（0=全体 〜 1=最大ズーム0.5秒窓）＋明示パン（viewStart=表示窓の左端秒）
    let zoomT = 0;
    let viewStart = 0;
    // M6-5 Q-1: 共通スライダー部品のハンドル（render() のたびに作り直す）
    let zoomHandle: SliderHandle | null = null;
    let volHandle: SliderHandle | null = null;
    // M6-6 R-3: syncZoomUI が設定した scrollLeft のエコーを scroll リスナーで無視するための記録
    let scrollEcho = -1;
    const self = this;

    const back = document.createElement("div");
    back.className = "modal-back";
    const box = document.createElement("div");
    box.className = "modal-box audio-panel";
    back.appendChild(box);
    document.body.appendChild(back);
    this.audioPanelEl = back;

    // ---- 試し再生（音＋大プレビュー。ループ毎に頭出しリセット=A-1と同じ規則） ----
    let trialTimer: number | null = null;
    let trialFrame = 0;
    let trialNode: AudioBufferSourceNode | null = null;
    let trialGain: GainNode | null = null;
    // M6-4 P-5: 再生ヘッド（AudioContext.currentTime 基準。null=非再生）
    let playheadT0: number | null = null;
    let playheadRaf = 0;
    // M6-5 Q-2: 停止位置マーカー（次の再生開始・パネル閉でクリア）
    let stopMarkT: number | null = null;
    // M6-6 R-5: 一時停止位置（音源の絶対秒。null=一時停止中でない）
    let pausedAt: number | null = null;
    const normTrim = () => {
      const dur = buffer?.duration ?? 0;
      const ts = Math.max(0, Math.min(w.trimStartMs / 1000, Math.max(0, dur - 0.05)));
      let te = w.trimEndMs != null ? Math.min(w.trimEndMs / 1000, dur) : dur;
      if (te <= ts) te = dur;
      return { ts, te };
    };
    const stopTrialAudio = () => {
      try {
        trialNode?.stop();
        trialNode?.disconnect();
        trialGain?.disconnect();
      } catch {
        /* noop */
      }
      trialNode = null;
      trialGain = null;
    };
    /** M5-1（Codex指摘#2）: 試し再生も速度連動 rate を適用（通常再生・書き出しと一致させる） */
    const trialRate = () => bgmPlaybackRate(proj.speedIndex, w.baseSpeedIndex);
    /** offsetSec = 頭出し(ts)からの相対再開位置（R-5。0=頭出しから）。音源（バッファ）秒 */
    const playTrialAudio = (offsetSec = 0) => {
      stopTrialAudio();
      if (!buffer || w.muted) return;
      try {
        const ctx = getAudioCtx();
        if (ctx.state === "suspended") void ctx.resume().catch(() => {});
        const { ts, te } = normTrim();
        const startAt = ts + Math.max(0, offsetSec);
        if (startAt >= te) return; // 音側は終端まで再生済み（アニメだけ続く）
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = trialRate();
        const gain = ctx.createGain();
        gain.gain.value = Math.max(0, Math.min(1, w.volume));
        node.connect(gain);
        gain.connect(ctx.destination);
        node.start(0, startAt, Math.max(0, te - startAt));
        trialNode = node;
        trialGain = gain;
      } catch {
        /* 自動再生制限などは無音で続行 */
      }
    };
    /** 再生ヘッドの時計を合わせる（ミュート中も AudioContext の時計で動かす。
     *  offset=tsからの相対・音源秒。実時間には 1/rate 換算で積む） */
    const resetPlayhead = (offsetSec = 0) => {
      try {
        playheadT0 = getAudioCtx().currentTime - Math.max(0, offsetSec) / trialRate();
      } catch {
        playheadT0 = null;
      }
    };
    /** いま鳴っている位置（音源の絶対秒。トリム終端でクランプ。経過実時間×rate=音源秒） */
    const currentHeadT = () => {
      const { ts, te } = normTrim();
      let t = ts;
      if (playheadT0 != null) {
        try {
          t = ts + (getAudioCtx().currentTime - playheadT0) * trialRate();
        } catch {
          /* noop */
        }
      }
      return Math.min(t, te);
    };
    const setTrialButton = (playing: boolean) => {
      const b = box.querySelector("#ap-trial") as HTMLButtonElement | null;
      if (b) b.textContent = playing ? "■ 停止" : "▶ ここから試す";
    };
    const stopTrial = () => {
      pausedAt = null; // R-5: 完全停止（再開位置は持ち越さない）
      if (trialTimer != null) {
        clearInterval(trialTimer);
        trialTimer = null;
      }
      stopTrialAudio();
      if (playheadT0 != null) {
        // Q-2: どこまで聴いたか分かるよう、停止位置に薄いマーカーを残す
        stopMarkT = currentHeadT();
        playheadT0 = null;
        cancelAnimationFrame(playheadRaf);
        drawWave(); // ヘッドを消してマーカーを描く
      }
      setTrialButton(false);
    };
    const drawTrialFrame = () => {
      const cv = box.querySelector("#ap-mini") as HTMLCanvasElement | null;
      if (cv) presentToCanvas(compositeFrame(proj, trialFrame), cv);
    };
    const startHeadRaf = () => {
      const tickHead = () => {
        if (playheadT0 == null) return;
        drawWave();
        playheadRaf = requestAnimationFrame(tickHead);
      };
      playheadRaf = requestAnimationFrame(tickHead);
    };
    // M5-1: 試し再生でも配置SEをコマ発火（プロジェクトの生きた配置を参照）
    const fireTrialSe = (i: number) => {
      const a = proj.audio;
      if (!a || a.se.length === 0) return;
      const ids = proj.frames[i]?.se;
      if (!ids) return;
      for (const id of ids) {
        const t = a.se.find((s) => s.id === id);
        if (t) self.audioPreview.fireSe(t);
      }
    };
    const startFrameTimer = () => {
      fireTrialSe(trialFrame); // 開始コマ
      trialTimer = window.setInterval(() => {
        let next = trialFrame + 1;
        if (next >= frameCount) {
          next = 0;
          if (frameCount > 1) {
            playTrialAudio(); // A-1と同じ: アニメが先頭に戻るたび音も頭出し
            resetPlayhead(); // ヘッドも頭出し位置へ戻す
          }
        }
        trialFrame = next;
        fireTrialSe(next);
        drawTrialFrame();
      }, 1000 / fps);
    };
    const startTrial = () => {
      stopTrial();
      stopMarkT = null; // Q-2: 再生開始で停止位置マーカーをクリア
      trialFrame = 0;
      drawTrialFrame();
      playTrialAudio();
      resetPlayhead();
      startHeadRaf();
      startFrameTimer();
      setTrialButton(true);
    };
    // R-5: 一時停止（位置マーカーを残す）⇄ 同位置から再開。コマ位置(trialFrame)も維持する
    const pauseTrial = () => {
      if (trialTimer == null) return;
      const t = currentHeadT();
      clearInterval(trialTimer);
      trialTimer = null;
      stopTrialAudio();
      playheadT0 = null;
      cancelAnimationFrame(playheadRaf);
      pausedAt = t;
      stopMarkT = t; // 一時停止中はQ-2マーカーと同じ見た目で位置を示す
      drawWave();
      setTrialButton(false);
    };
    const resumeTrial = () => {
      if (trialTimer != null || pausedAt == null) return;
      const off = Math.max(0, pausedAt - normTrim().ts);
      pausedAt = null;
      stopMarkT = null;
      drawTrialFrame();
      playTrialAudio(off);
      resetPlayhead(off);
      startHeadRaf();
      startFrameTimer();
      setTrialButton(true);
    };

    // ---- 波形描画（ピーク min/max・コマ目盛ルーラー・トリムハンドル・再生ヘッド） ----
    const RULER_H = 26;
    /** 現在の表示窓の秒数（zoomT=0で全体、1で0.5秒。対数補間） */
    const winSec = () => {
      const dur = buffer?.duration ?? 1;
      if (zoomT <= 0) return dur;
      const minWin = Math.min(0.5, dur);
      return dur * Math.pow(minWin / dur, zoomT);
    };
    const view = () => {
      const dur = buffer?.duration ?? 1;
      const vd = winSec();
      // R-3: アンカー固定・波形可動のため、窓は音源の外側にもはみ出せる
      // （最低でも窓の10%は音源と重なるようにクランプ。全体表示時も波形を左右に送れる）
      const v0 = Math.max(-vd * 0.9, Math.min(viewStart, dur - vd * 0.1));
      return { v0, vd };
    };
    /** ズーム・パンのUI同期（スライダー値・表示窓ラベル・パン用スクロールバー） */
    const syncZoomUI = () => {
      const dur = buffer?.duration ?? 1;
      const { v0, vd } = view();
      zoomHandle?.set(Math.round(zoomT * 1000));
      const zl = box.querySelector("#ap-zoomv") as HTMLElement | null;
      if (zl)
        zl.textContent =
          vd >= dur - 1e-9 ? "全体" : `表示: ${vd >= 10 ? vd.toFixed(0) : vd.toFixed(1)}秒`;
      const sc = box.querySelector("#ap-scroll") as HTMLElement | null;
      if (sc) {
        const zoomed = vd < dur - 1e-9;
        // M5-3 S-2: hidden(display:none) だと行の高さが消えてパネル寸法がガタつくため
        // visibility で切替（高さは常時確保）
        sc.style.visibility = zoomed ? "visible" : "hidden";
        const inner = sc.firstElementChild as HTMLElement | null;
        if (zoomed) {
          const w = sc.clientWidth || 1;
          if (inner) inner.style.width = `${Math.round((dur / vd) * w)}px`;
          sc.scrollLeft = (v0 / dur) * (dur / vd) * w;
          scrollEcho = sc.scrollLeft; // R-3: エコー識別用（ブラウザのクランプ後の値を記録）
        } else if (inner) {
          inner.style.width = "0"; // S-2: 全体表示時は固有幅への寄与も消す
        }
      }
    };
    /** ズーム変更（anchor 指定時はその時刻を同じ画面位置に保つ。未指定は現在窓の中央維持・全体→ズームは頭出し付近へ） */
    const setZoom = (t: number, anchorT?: number, anchorFrac?: number) => {
      const dur = buffer?.duration ?? 1;
      const prev = view();
      const wasFit = prev.vd >= dur - 1e-9;
      zoomT = Math.max(0, Math.min(1, t));
      const vd = winSec();
      if (anchorT != null && anchorFrac != null) viewStart = anchorT - anchorFrac * vd;
      else if (wasFit) viewStart = normTrim().ts - vd * 0.25;
      else viewStart = prev.v0 + prev.vd / 2 - vd / 2;
      syncZoomUI();
      drawWave();
    };
    const drawWave = () => {
      const cv = box.querySelector("#ap-wave") as HTMLCanvasElement | null;
      if (!cv) return;
      const ctx2 = cv.getContext("2d")!;
      const W2 = cv.width;
      const H2 = cv.height;
      ctx2.clearRect(0, 0, W2, H2);
      if (!buffer) return;
      const { v0, vd } = view();
      const dur = buffer.duration;
      const secPerPx = vd / W2;
      const { ts, te } = normTrim();
      const xOf = (t: number) => ((t - v0) / vd) * W2;
      // トリム外を暗く
      ctx2.fillStyle = "rgba(44,38,33,.12)";
      const tsX = Math.max(0, xOf(ts));
      const teX = Math.min(W2, xOf(te));
      if (tsX > 0) ctx2.fillRect(0, RULER_H, tsX, H2 - RULER_H);
      if (teX < W2) ctx2.fillRect(teX, RULER_H, W2 - teX, H2 - RULER_H);
      // 波形（1pxごとに min/max）
      const ch = buffer.getChannelData(0);
      const rate = buffer.sampleRate;
      const mid = RULER_H + (H2 - RULER_H) / 2;
      const amp = (H2 - RULER_H) / 2 - 2;
      ctx2.strokeStyle = "#1fa2ff";
      ctx2.beginPath();
      for (let x = 0; x < W2; x++) {
        let s0 = Math.floor((v0 + x * secPerPx) * rate);
        const s1 = Math.min(ch.length, Math.floor((v0 + (x + 1) * secPerPx) * rate));
        if (s0 >= ch.length) break;
        if (s1 <= 0) continue; // R-3: 窓が音源より左（負の時間）の列は描かない
        if (s0 < 0) s0 = 0;
        let mn = 1;
        let mx = -1;
        const step = Math.max(1, Math.floor((s1 - s0) / 50));
        for (let s = s0; s < Math.max(s1, s0 + 1); s += step) {
          const v = ch[s];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        ctx2.moveTo(x + 0.5, mid - mx * amp);
        ctx2.lineTo(x + 0.5, mid - mn * amp + 1);
      }
      ctx2.stroke();
      // コマ目盛ルーラー（頭出し位置を起点にコマを配置）
      ctx2.fillStyle = "#fbefd6";
      ctx2.fillRect(0, 0, W2, RULER_H);
      // P-5: 試し再生中は現在コマをルーラー上でハイライト
      if (playheadT0 != null) {
        const fx0 = xOf(ts + trialFrame / fps);
        const fx1 = xOf(ts + (trialFrame + 1) / fps);
        if (fx1 > 0 && fx0 < W2) {
          ctx2.fillStyle = "rgba(240,122,26,.4)";
          ctx2.fillRect(fx0, 0, fx1 - fx0, RULER_H);
        }
      }
      ctx2.strokeStyle = "#2c2621";
      ctx2.fillStyle = "#2c2621";
      ctx2.font = "10px sans-serif";
      const pxPerFrame = (1 / fps) / secPerPx;
      const labelEvery = pxPerFrame >= 34 ? 1 : pxPerFrame >= 8 ? 5 : 10;
      ctx2.beginPath();
      for (let i = 0; i <= frameCount; i++) {
        const t = ts + i / fps;
        if (t < v0 || t > v0 + vd) continue;
        const x = xOf(t);
        const isLabel = i % labelEvery === 0;
        ctx2.moveTo(x + 0.5, RULER_H);
        ctx2.lineTo(x + 0.5, isLabel ? 6 : RULER_H - 6);
        if (isLabel && i < frameCount) ctx2.fillText(String(i + 1), x + 2, 12);
      }
      ctx2.stroke();
      // トリムハンドル
      const handle = (t: number, color: string) => {
        const x = xOf(t);
        if (x < -8 || x > W2 + 8) return;
        ctx2.strokeStyle = color;
        ctx2.lineWidth = 2;
        ctx2.beginPath();
        ctx2.moveTo(x, 0);
        ctx2.lineTo(x, H2);
        ctx2.stroke();
        ctx2.fillStyle = color;
        ctx2.fillRect(x - 5, RULER_H - 8, 10, 8);
        ctx2.lineWidth = 1;
      };
      handle(ts, "#f07a1a");
      if (w.trimEndMs != null || te < dur) handle(te, "#ff4b4b");
      // 情報
      ctx2.fillStyle = "#7a6f60";
      ctx2.fillText(
        `音源 ${dur.toFixed(2)}s / アニメ ${(frameCount / fps).toFixed(2)}s（${frameCount}コマ・${fps}fps）`,
        6,
        H2 - 6
      );
      // Q-2: 停止位置マーカー（ヘッドと同色の半透明・非再生時のみ）
      if (stopMarkT != null && playheadT0 == null) {
        const x = xOf(stopMarkT);
        if (x >= 0 && x <= W2) {
          ctx2.strokeStyle = "rgba(224,33,138,.45)";
          ctx2.lineWidth = 2;
          ctx2.beginPath();
          ctx2.moveTo(x + 0.5, 0);
          ctx2.lineTo(x + 0.5, H2);
          ctx2.stroke();
          ctx2.lineWidth = 1;
        }
      }
      // P-5: 再生ヘッド（AudioContext の時計基準。トリム終端で止め、表示窓の外なら描かない）
      // M5-1: 経過実時間×rate=音源秒（速度連動と一致）
      if (playheadT0 != null) {
        let t = ts;
        try {
          t = ts + (getAudioCtx().currentTime - playheadT0) * trialRate();
        } catch {
          /* noop */
        }
        if (t > te) t = te;
        const x = xOf(t);
        if (x >= 0 && x <= W2) {
          ctx2.strokeStyle = "#e0218a";
          ctx2.lineWidth = 2;
          ctx2.beginPath();
          ctx2.moveTo(x + 0.5, 0);
          ctx2.lineTo(x + 0.5, H2);
          ctx2.stroke();
          ctx2.lineWidth = 1;
        }
      }
    };

    const syncInputs = () => {
      const s = box.querySelector("#ap-start") as HTMLInputElement | null;
      const e = box.querySelector("#ap-end") as HTMLInputElement | null;
      if (s) s.value = (w.trimStartMs / 1000).toFixed(3);
      if (e) e.value = w.trimEndMs != null ? (w.trimEndMs / 1000).toFixed(3) : "";
      drawWave();
    };

    // ---- パネル描画 ----
    const render = () => {
      stopTrial();
      const baseFps = FPS_TABLE[w.baseSpeedIndex] ?? fps;
      const statusText = w.deleted || !w.bytes
        ? "BGMなし"
        : `${w.source === "kwz" ? "元の音（3DS作品由来）" : `差し替え${w.name ? `（${w.name}）` : ""}`}・速度連動の基準: ${baseFps}fps`;
      if (!w.bytes || w.deleted) {
        box.innerHTML = `
          <p class="modal-msg"><b>♪ 音声</b>　${statusText}</p>
          <div class="modal-field">
            <button class="btn blue" id="ap-load">🎵 BGMを読み込む（音声・動画）</button>
          </div>
          <div id="ap-se"></div>
          <div class="modal-actions">
            <span style="flex:1"></span>
            <button class="btn primary" id="ap-apply">適用して閉じる</button>
            <button class="btn" id="ap-cancel">キャンセル</button>
          </div>`;
      } else {
        box.innerHTML = `
          <p class="modal-msg"><b>♪ 音声の調整</b>　${statusText}</p>
          <!-- M5-5 T-1: 広幅レイアウト（プレビュー左＋SE右・波形は全幅が主役） -->
          <div class="ap-top">
            <canvas id="ap-mini" width="320" height="240" class="ap-big" title="クリックで再生 / 一時停止"></canvas>
            <div id="ap-se"></div>
          </div>
          <canvas id="ap-wave" width="1440" height="170" class="ap-wave"></canvas>
          <!-- M5-3 S-2: 高さは常時確保（出現/消滅でパネル寸法がガタつかないよう visibility で切替） -->
          <div class="ap-scroll" id="ap-scroll" style="visibility:hidden"><div></div></div>
          <div class="modal-field"><span>ズーム</span>
            <span id="ap-zoom"></span>
            <span id="ap-zoomv" style="font-weight:700;font-size:12px;width:86px">全体</span>
            <button class="minibtn ok" id="ap-trial">▶ ここから試す</button>
          </div>
          <div class="modal-field">
            <span>頭出し</span><input id="ap-start" type="number" min="0" step="0.001" style="width:100px"> 秒
            <span>終わり</span><input id="ap-end" type="number" min="0" step="0.001" placeholder="最後まで" style="width:100px"> 秒
          </div>
          <div class="modal-field"><span>音量</span>
            <span id="ap-vol"></span>
            <span id="ap-volv" style="font-weight:700;font-size:12px;width:44px">${Math.round(w.volume * 100)}%</span>
            <span class="tog">ミュート</span><div class="sw2${w.muted ? " on" : ""}" id="ap-mute"></div>
          </div>
          <div class="modal-actions">
            <button class="minibtn" id="ap-load">🎵 差し替え</button>
            <button class="minibtn" id="ap-del">🗑 削除</button>
            <span style="flex:1"></span>
            <button class="btn primary" id="ap-apply">適用して閉じる</button>
            <button class="btn" id="ap-cancel">キャンセル</button>
          </div>`;
      }
      bind();
      renderSeSection();
      syncInputs();
      syncZoomUI();
      drawTrialFrame();
    };

    const bind = () => {
      box.querySelector("#ap-load")?.addEventListener("click", async () => {
        const picked = await self.cb.pickAudioFile();
        if (!picked) return;
        w.bytes = picked.bytes;
        w.mime = picked.mime;
        w.name = picked.name;
        w.source = "external";
        w.deleted = false;
        w.trimStartMs = 0;
        w.trimEndMs = null;
        w.baseSpeedIndex = proj.speedIndex; // M5-1: 付けた時点の速度が連動の基準
        zoomT = 0;
        viewStart = 0;
        stopMarkT = null; // Q-2: 音源が変わるのでマーカーもクリア
        buffer = null;
        try {
          buffer = await decodeAudio(w.bytes);
        } catch {
          self.cb.toast("音声のデコードに失敗しました");
        }
        render();
      });
      box.querySelector("#ap-del")?.addEventListener("click", () => {
        w.deleted = true;
        w.bytes = null;
        buffer = null;
        render();
      });
      box.querySelector("#ap-mute")?.addEventListener("click", (e) => {
        w.muted = !w.muted;
        (e.currentTarget as HTMLElement).classList.toggle("on", w.muted);
        if (w.muted) stopTrialAudio();
      });
      // Q-1: 音量/ズームは共通スライダー部品（プレースホルダを差し替え）
      volHandle = null;
      const volPh = box.querySelector("#ap-vol");
      if (volPh) {
        volHandle = createSlider({
          min: 0,
          max: 100,
          value: Math.round(w.volume * 100),
          onInput: (v) => {
            w.volume = v / 100;
            (box.querySelector("#ap-volv") as HTMLElement).textContent = `${v}%`;
            if (trialGain) trialGain.gain.value = w.volume;
          },
        });
        volHandle.root.id = "ap-vol";
        volPh.replaceWith(volHandle.root);
      }
      // P-3: ズームスライダー（対数）＋パン用スクロールバー
      zoomHandle = null;
      const zoomPh = box.querySelector("#ap-zoom");
      if (zoomPh) {
        zoomHandle = createSlider({
          min: 0,
          max: 1000,
          value: Math.round(zoomT * 1000),
          onInput: (v) => setZoom(v / 1000),
        });
        zoomHandle.root.id = "ap-zoom";
        zoomPh.replaceWith(zoomHandle.root);
      }
      // 波形ドラッグ状態（scrollエコー抑止のため scroll リスナーより先に宣言）
      let dragging: "" | "start" | "end" | "seek" | "viewpan" = "";
      const sc = box.querySelector("#ap-scroll") as HTMLElement | null;
      sc?.addEventListener("scroll", () => {
        if (!buffer) return;
        // R-3: ドラッグ中と自前更新のエコーは無視（波形可動で v0 が負のとき上書きしない）
        if (dragging) return;
        if (Math.abs(sc.scrollLeft - scrollEcho) < 2) return;
        scrollEcho = sc.scrollLeft;
        viewStart = (sc.scrollLeft / Math.max(1, sc.scrollWidth)) * buffer.duration;
        drawWave();
      });
      box.querySelector("#ap-trial")?.addEventListener("click", () => {
        if (trialTimer != null) stopTrial();
        else startTrial(); // 一時停止中でもボタンは頭出しから（クリック再開はプレビュー側）
      });
      // R-5: 大プレビューのクリックで再生⇄一時停止（再開は同位置から）
      box.querySelector("#ap-mini")?.addEventListener("click", () => {
        if (trialTimer != null) pauseTrial();
        else if (pausedAt != null) resumeTrial();
        else startTrial();
      });
      (box.querySelector("#ap-start") as HTMLInputElement | null)?.addEventListener(
        "change",
        (e) => {
          w.trimStartMs = Math.max(
            0,
            Math.round(Number((e.target as HTMLInputElement).value) * 1000) || 0
          );
          syncInputs();
        }
      );
      (box.querySelector("#ap-end") as HTMLInputElement | null)?.addEventListener(
        "change",
        (e) => {
          const v = (e.target as HTMLInputElement).value.trim();
          let endMs = v === "" ? null : Math.max(0, Math.round(Number(v) * 1000) || 0);
          if (endMs != null && endMs <= w.trimStartMs) {
            self.cb.toast("「終わり」は「頭出し」より後にしてください（最後までに戻しました）");
            endMs = null;
          }
          w.trimEndMs = endMs;
          syncInputs();
        }
      );
      // P-3: 役割分離 — ハンドル±7px=トリム / ルーラー帯=パン / 波形=波形自体を動かして頭出し（R-3）
      const cv = box.querySelector("#ap-wave") as HTMLCanvasElement | null;
      if (cv) {
        let lastX = 0;
        const toTime = (px: number) => {
          const { v0, vd } = view();
          return v0 + (px / cv.width) * vd;
        };
        const pxOf = (t: number) => {
          const { v0, vd } = view();
          return ((t - v0) / vd) * cv.width;
        };
        const localX = (e: { clientX: number }) => {
          const r = cv.getBoundingClientRect();
          return ((e.clientX - r.left) / r.width) * cv.width;
        };
        const localY = (e: { clientY: number }) => {
          const r = cv.getBoundingClientRect();
          return ((e.clientY - r.top) / r.height) * cv.height;
        };
        // R-4: どの帯がどの操作か、ホバー/ドラッグ中カーソルで区別する
        const zoneCursor = (e: { clientX: number; clientY: number }) => {
          const x = localX(e);
          const { ts, te } = normTrim();
          if (Math.abs(x - pxOf(ts)) <= 7 || Math.abs(x - pxOf(te)) <= 7)
            return "col-resize"; // トリムハンドル
          if (localY(e) < RULER_H) return "grab"; // ルーラー帯=パン
          return "ew-resize"; // 波形=波形自体を左右に動かす
        };
        cv.addEventListener("pointerdown", (e) => {
          if (!buffer) return;
          try {
            cv.setPointerCapture(e.pointerId);
          } catch {
            /* 合成イベント・ペン切断時などは捕捉なしで続行 */
          }
          const x = localX(e);
          const y = localY(e);
          const { ts, te } = normTrim();
          if (Math.abs(x - pxOf(ts)) <= 7) dragging = "start";
          else if (Math.abs(x - pxOf(te)) <= 7) dragging = "end";
          else if (y < RULER_H) dragging = "viewpan";
          else dragging = "seek";
          cv.style.cursor =
            dragging === "viewpan" ? "grabbing" : dragging === "seek" ? "ew-resize" : "col-resize";
          lastX = x;
        });
        cv.addEventListener("pointermove", (e) => {
          if (!buffer) return;
          if (!dragging) {
            cv.style.cursor = zoneCursor(e); // R-4: ホバー中はゾーンに応じたカーソル
            return;
          }
          const x = localX(e);
          if (dragging === "start") {
            w.trimStartMs = Math.max(0, Math.round(toTime(x) * 1000));
            if (w.trimEndMs != null && w.trimEndMs <= w.trimStartMs) w.trimEndMs = null;
          } else if (dragging === "end") {
            const ms = Math.round(toTime(x) * 1000);
            w.trimEndMs = ms > w.trimStartMs ? ms : w.trimEndMs;
          } else if (dragging === "viewpan") {
            // ルーラーを掴んで表示窓を動かす（右へドラッグ＝過去へスクロール）
            const dSec = (x - lastX) * (view().vd / cv.width);
            viewStart = view().v0 - dSec;
            lastX = x;
            drawWave();
            return;
          } else {
            // R-3: アンカー固定・波形可動 — オレンジ頭出し線とルーラーは画面上で固定し、
            // 波形自体が指に追従する。trimStart と表示窓を同じ量だけ動かすと
            // 線・ルーラーのスクリーン座標が不変のまま波形だけが動く。
            const dSec = (x - lastX) * (view().vd / cv.width);
            const before = w.trimStartMs;
            const durMs = (buffer?.duration ?? 0) * 1000;
            w.trimStartMs = Math.round(
              Math.max(0, Math.min(durMs, before - dSec * 1000))
            );
            viewStart = view().v0 + (w.trimStartMs - before) / 1000;
            lastX = x;
          }
          syncInputs();
        });
        const up = (e: PointerEvent) => {
          if (dragging === "seek" || dragging === "viewpan") syncZoomUI(); // スクロールバーを再同期
          dragging = "";
          cv.style.cursor = zoneCursor(e);
        };
        cv.addEventListener("pointerup", up);
        cv.addEventListener("pointercancel", up);
        // 任意: Ctrl+ホイール=カーソル位置基準ズーム / ホイール=パン
        cv.addEventListener(
          "wheel",
          (e) => {
            if (!buffer) return;
            e.preventDefault();
            const { v0, vd } = view();
            if (e.ctrlKey) {
              const frac = Math.max(0, Math.min(1, localX(e) / cv.width));
              setZoom(zoomT - Math.sign(e.deltaY) * 0.08, v0 + frac * vd, frac);
            } else {
              viewStart = v0 + Math.sign(e.deltaY || e.deltaX) * vd * 0.1;
              syncZoomUI();
              drawWave();
            }
          },
          { passive: false }
        );
      }
      box.querySelector("#ap-apply")?.addEventListener("click", () => {
        // M5-1: BGM だけを書き戻す（SE は即時反映＋Undo なので触らない）
        const bgm: BgmTrack | null =
          w.deleted || !w.bytes
            ? null
            : {
                source: w.source,
                mime: w.mime,
                data: w.bytes,
                muted: w.muted,
                volume: w.volume,
                trimStartMs: w.trimStartMs,
                trimEndMs: w.trimEndMs,
                syncMode: w.syncMode,
                baseSpeedIndex: w.baseSpeedIndex,
                name: w.name,
              };
        const se = proj.audio?.se ?? [];
        proj.audio = bgm || se.length > 0 ? { bgm, se } : null;
        sanitizeAudio(proj); // BGM削除などで宙に浮いた状態を正規化
        self.dirty = true;
        self.audioPreview.invalidate();
        self.updateAudioToolButton();
        self.updateFilmSeMarks();
        close();
      });
      box.querySelector("#ap-cancel")?.addEventListener("click", () => close());
    };

    // ---- M5-1: SEセクション（トラック＋コマ配置。即時反映・Undo履歴・dirty連動） ----
    const renderSeSection = () => {
      const host = box.querySelector("#ap-se") as HTMLElement | null;
      if (!host) return;
      host.innerHTML = "";
      const se = proj.audio?.se ?? [];
      const head = document.createElement("div");
      head.className = "ap-se-head";
      const selFrames = self.selectedFrameIndices();
      head.innerHTML = `<b>効果音（SE）</b><span class="hintline">配置先: ${
        selFrames.length > 1
          ? `コマ ${selFrames[0] + 1}〜${selFrames[selFrames.length - 1] + 1}（${selFrames.length}コマ）`
          : `コマ ${self.frameIndex + 1}`
      }</span>`;
      host.appendChild(head);
      const mkRow = (t: SeTrack) => {
        const row = document.createElement("div");
        row.className = "ap-se-row";
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = `♪ ${t.name}`;
        nm.title = "ダブルクリックで名前変更";
        nm.addEventListener("dblclick", async () => {
          const v = await self.cb.prompt("SEの名前", t.name);
          if (v) self.renameSeTrack(t.id, v);
        });
        let volBefore: number | null = null;
        const vol = createSlider({
          min: 0,
          max: 100,
          value: Math.round(t.volume * 100),
          className: "lay-op",
          title: "音量",
          onDown: () => (volBefore = t.volume),
          onInput: (v) => {
            t.volume = v / 100;
            self.dirty = true;
          },
          onChange: () => {
            if (volBefore != null && volBefore !== t.volume)
              self.pushSeVolumeHistory(t.id, volBefore, t.volume);
            volBefore = null;
          },
        });
        const mute = document.createElement("div");
        mute.className = "sw2" + (t.muted ? " on" : "");
        mute.title = "ミュート";
        mute.addEventListener("click", () => self.toggleSeMute(t.id));
        const listen = document.createElement("button");
        listen.className = "minibtn";
        listen.textContent = "🔊";
        listen.title = "試聴";
        listen.addEventListener("click", () => self.audioPreview.fireSe(t));
        const place = document.createElement("button");
        const placedAll =
          selFrames.length > 0 && selFrames.every((i) => proj.frames[i]?.se?.includes(t.id));
        place.className = "minibtn" + (placedAll ? " ok" : "");
        place.textContent = placedAll ? "🎯配置中" : "🎯配置";
        place.title =
          "選択コマに配置/解除（フィルムでShift+クリックすると範囲にまとめて配置できます）";
        place.addEventListener("click", () => self.toggleSePlacement(t.id, selFrames));
        const del = document.createElement("button");
        del.className = "minibtn";
        del.textContent = "🗑";
        del.title = "SEを削除（配置も外れます）";
        del.addEventListener("click", () => self.deleteSeTrack(t.id));
        row.append(nm, vol.root, mute, listen, place, del);
        return row;
      };
      for (const t of se) host.appendChild(mkRow(t));
      // 既定4行分の空きを見せる（うごメモ準拠の見た目・追加は無制限）
      for (let i = se.length; i < 4; i++) {
        const empty = document.createElement("div");
        empty.className = "ap-se-row empty";
        empty.innerHTML = `<span class="nm">（空きスロット）</span>`;
        const add = document.createElement("button");
        add.className = "minibtn";
        add.textContent = "＋追加";
        add.addEventListener("click", () => void addSe());
        empty.appendChild(add);
        host.appendChild(empty);
      }
      const addRow = document.createElement("div");
      addRow.className = "ap-se-add";
      const addBtn = document.createElement("button");
      addBtn.className = "minibtn ok";
      addBtn.textContent = "＋ SEを追加（音声・動画）";
      addBtn.addEventListener("click", () => void addSe());
      addRow.appendChild(addBtn);
      host.appendChild(addRow);
    };
    const addSe = async () => {
      const picked = await self.cb.pickAudioFile();
      if (!picked) return;
      self.addSeTrack(picked);
    };
    // パネルが開いている間、SE操作（Undo含む）でセクションを再描画する
    this.seSectionRefresh = renderSeSection;

    const close = () => {
      stopTrial();
      this.seSectionRefresh = null;
      back.remove();
      this.audioPanelEl = null;
      this.audioPanelClose = null;
    };
    this.audioPanelClose = close;
    // M10-11: ペンで即閉じしないよう pointerdown に（main.ts の modal() と同じ理由）
    back.addEventListener("pointerdown", (e) => {
      if (e.target === back) close();
    });

    // 初期デコード（波形用）
    if (w.bytes) {
      try {
        buffer = await decodeAudio(w.bytes);
      } catch {
        this.cb.toast("音声のデコードに失敗しました（波形は表示できません）");
      }
    }
    render();
  }

  /** M5-1: 書き出しダイアログへ渡す音声ソース（範囲・モード確定後に最終ミックスをレンダ） */
  private buildExportAudioSource(): ExportAudioSource | null {
    const p = this.project;
    const a = p.audio;
    if (!a || (!a.bgm && a.se.length === 0)) return null;
    const audibleSe = (f: { se?: string[] }) =>
      f.se?.some((id) => {
        const t = a.se.find((s) => s.id === id);
        return !!t && !t.muted;
      }) ?? false;
    const anySeAudible = p.frames.some(audibleSe);
    const anySePlaced = p.frames.some((f) => f.se && f.se.length > 0);
    const has = !!a.bgm || anySePlaced;
    if (!has) return null;
    const audible = (!!a.bgm && !a.bgm.muted) || anySeAudible;
    return {
      has: true,
      allMuted: !audible,
      syncMode: a.bgm?.syncMode ?? "audioToAnim",
      build: async (range, syncMode) => {
        const lo = range ? Math.min(range.a, range.b) : 0;
        const hi = range ? Math.max(range.a, range.b) : p.frames.length - 1;
        const frameSe = p.frames
          .slice(lo, hi + 1)
          .map((f) => (f.se && f.se.length > 0 ? [...f.se] : undefined));
        return renderExportMix({
          bgm: a.bgm,
          se: a.se,
          frameSe,
          fps: FPS_TABLE[p.speedIndex] || 8,
          speedIndex: p.speedIndex,
          syncMode,
          // M10-11: 範囲先頭が作品先頭から何秒か。全範囲なら lo=0 → 0
          rangeStartSec: lo / (FPS_TABLE[p.speedIndex] || 8),
        });
      },
    };
  }

  // ---------------- M5-1: SEトラック・コマ配置の操作（Undo対応） ----------------

  /** 音声パネルが開いている間だけ設定される SEセクション再描画フック */
  private seSectionRefresh: (() => void) | null = null;

  /** SE配置の対象コマ（フィルム範囲選択中は範囲・それ以外は現在コマ） */
  private selectedFrameIndices(): number[] {
    if (this.rangeSel) {
      const out: number[] = [];
      for (let i = this.rangeSel.a; i <= this.rangeSel.b; i++) out.push(i);
      return out;
    }
    return [this.frameIndex];
  }

  private ensureProjectAudio(): ProjectAudio {
    if (!this.project.audio) this.project.audio = { bgm: null, se: [] };
    return this.project.audio;
  }

  /** SE変更後の共通処理（dirty・ボタン/フィルム表示・パネル再描画） */
  private afterSeChange() {
    this.dirty = true;
    sanitizeAudio(this.project);
    this.updateAudioToolButton();
    this.updateFilmSeMarks();
    this.seSectionRefresh?.();
  }

  private seById(id: string): SeTrack | undefined {
    return this.project.audio?.se.find((s) => s.id === id);
  }

  /** SEトラック追加（外部ファイル。M5-2でマイク録音を追加予定） */
  private addSeTrack(picked: { bytes: Uint8Array; mime: string; name: string }) {
    const track: SeTrack = {
      id: newSeId(this.project),
      name: picked.name.replace(/\.[^.]+$/, "") || "SE",
      source: "external",
      mime: picked.mime,
      data: picked.bytes,
      volume: 1,
      muted: false,
    };
    const self = this;
    const apply = () => {
      const a = self.ensureProjectAudio();
      if (!a.se.some((s) => s.id === track.id)) a.se.push(track);
      self.afterSeChange();
    };
    const revert = () => {
      const a = self.project.audio;
      if (a) a.se = a.se.filter((s) => s.id !== track.id);
      self.afterSeChange();
    };
    this.history.push({ label: "SE追加", undo: revert, redo: apply });
    apply();
  }

  /** SEトラック削除（全コマの配置も外す。Undoで配置ごと復元） */
  private deleteSeTrack(id: string) {
    const a = this.project.audio;
    const idx = a?.se.findIndex((s) => s.id === id) ?? -1;
    if (!a || idx < 0) return;
    const track = a.se[idx];
    const placedAt: number[] = [];
    this.project.frames.forEach((f, i) => {
      if (f.se?.includes(id)) placedAt.push(i);
    });
    const self = this;
    const apply = () => {
      const cur = self.project.audio;
      if (cur) cur.se = cur.se.filter((s) => s.id !== id);
      for (const i of placedAt) {
        const f = self.project.frames[i];
        if (f?.se) {
          f.se = f.se.filter((x) => x !== id);
          if (f.se.length === 0) f.se = undefined;
        }
      }
      self.afterSeChange();
    };
    const revert = () => {
      const cur = self.ensureProjectAudio();
      if (!cur.se.some((s) => s.id === id)) cur.se.splice(Math.min(idx, cur.se.length), 0, track);
      for (const i of placedAt) {
        const f = self.project.frames[i];
        if (!f) continue;
        if (!f.se) f.se = [];
        if (!f.se.includes(id)) f.se.push(id);
      }
      self.afterSeChange();
    };
    this.history.push({ label: "SE削除", undo: revert, redo: apply });
    apply();
  }

  /** 音量変更の履歴（スライダーの確定時に呼ぶ。値は既に反映済み） */
  private pushSeVolumeHistory(id: string, from: number, to: number) {
    const self = this;
    this.dirty = true;
    this.history.push({
      label: "SE音量",
      undo() {
        const t = self.seById(id);
        if (t) t.volume = from;
        self.afterSeChange();
      },
      redo() {
        const t = self.seById(id);
        if (t) t.volume = to;
        self.afterSeChange();
      },
    });
  }

  private toggleSeMute(id: string) {
    const t = this.seById(id);
    if (!t) return;
    const self = this;
    const apply = () => {
      const cur = self.seById(id);
      if (cur) cur.muted = !cur.muted;
      self.afterSeChange();
    };
    this.history.push({ label: "SEミュート", undo: apply, redo: apply });
    apply();
  }

  private renameSeTrack(id: string, name: string) {
    const t = this.seById(id);
    if (!t || t.name === name) return;
    const from = t.name;
    const self = this;
    this.history.push({
      label: "SE名前変更",
      undo() {
        const cur = self.seById(id);
        if (cur) cur.name = from;
        self.afterSeChange();
      },
      redo() {
        const cur = self.seById(id);
        if (cur) cur.name = name;
        self.afterSeChange();
      },
    });
    t.name = name;
    this.afterSeChange();
  }

  /** 選択コマへの配置トグル（全コマ配置済みなら解除・そうでなければ全コマへ配置。履歴1件） */
  private toggleSePlacement(id: string, frames: number[]) {
    if (!this.seById(id) || frames.length === 0) return;
    const all = frames.every((i) => this.project.frames[i]?.se?.includes(id));
    // 変化のあるコマだけ記録（Undoで正確に戻す）
    const affected = frames.filter((i) => {
      const has = this.project.frames[i]?.se?.includes(id) ?? false;
      return all ? has : !has;
    });
    if (affected.length === 0) return;
    const self = this;
    const add = !all;
    const applyTo = (doAdd: boolean) => {
      for (const i of affected) {
        const f = self.project.frames[i];
        if (!f) continue;
        if (doAdd) {
          if (!f.se) f.se = [];
          if (!f.se.includes(id)) f.se.push(id);
        } else if (f.se) {
          f.se = f.se.filter((x) => x !== id);
          if (f.se.length === 0) f.se = undefined;
        }
      }
      self.afterSeChange();
    };
    this.history.push({
      label: add ? "SE配置" : "SE配置解除",
      undo: () => applyTo(!add),
      redo: () => applyTo(add),
    });
    applyTo(add);
  }

  /** フィルムの ♪ マーク（SE配置のあるコマ）を更新 */
  private updateFilmSeMarks() {
    document.querySelectorAll("#ed-film .fr").forEach((el) => {
      const i = Number((el as HTMLElement).dataset.idx);
      const has = !Number.isNaN(i) && !!this.project.frames[i]?.se?.length;
      el.classList.toggle("hasse", has);
    });
  }

  private rebuildPalette() {
    const pal = $("#ed-pal");
    pal.innerHTML = "";
    const colors = this.project.colorTable.slice(1);
    colors.forEach((hex) => {
      const d = document.createElement("button");
      d.className = "sw" + (hex === this.colorHex ? " on" : "");
      d.style.background = hex;
      d.title = hex;
      d.addEventListener("click", () => {
        this.colorHex = hex;
        this.rebuildPalette();
      });
      pal.appendChild(d);
    });
    // 透明（＝消し色）
    const tp = document.createElement("button");
    tp.className = "sw tp" + (this.colorHex === "" ? " on" : "");
    tp.title = "透明（消す）";
    tp.addEventListener("click", () => {
      this.colorHex = "";
      this.rebuildPalette();
    });
    pal.appendChild(tp);
    // 紙色ボタン列
    const pp = $("#ed-paperpal");
    pp.innerHTML = "";
    for (const hex of [
      UGO_COLORS.white,
      UGO_COLORS.black,
      UGO_COLORS.red,
      UGO_COLORS.yellow,
      UGO_COLORS.green,
      UGO_COLORS.blue,
    ]) {
      const d = document.createElement("button");
      d.className = "sw sm";
      d.style.background = hex;
      d.title = `紙色: ${hex}`;
      d.addEventListener("click", () => this.setPaper(hex));
      pp.appendChild(d);
    }
  }

  // ---------------- M3.7: レイヤーツリー（フォルダ・ネスト対応） ----------------

  /** 選択中フォルダ（新規作成先・フォルダ操作の対象） */
  private selectedFolderId: string | null = null;
  /** M3.8: 複数選択（レイヤー/フォルダの node id。描画対象 activeLayerId は従来どおり1枚） */
  private selectedNodeIds = new Set<string>();
  /** M3.8: Shift範囲選択の起点（最後に普通クリックした node） */
  private selAnchorId: string | null = null;
  /** M3.8: ドラッグ中の選択トップノード群（DnDセッション中のみ） */
  private dragNodes: string[] | null = null;
  /** M3.8: 表示リスト（rebuildLayers が更新。DnDヒット判定・Shift範囲用） */
  private displayRows: {
    kind: "layer" | "folder";
    id: string;
    el: HTMLElement;
    parent: string | undefined;
    phys: number; // layer=defs index / folder=-1
  }[] = [];
  /** M3.8: 挿入線インジケータ（rebuildLayers が張り替える） */
  private insLineEl: HTMLElement | null = null;

  private clearDndUi() {
    if (this.insLineEl) this.insLineEl.hidden = true;
    document
      .querySelectorAll("#ed-layers .droptarget")
      .forEach((x) => x.classList.remove("droptarget"));
  }

  // ---------------- M3.9 H-2: Pointer Events 自前ドラッグ ----------------
  // HTML5 DnD は Windows Ink のペンで dragstart が発火せず「🚫で一切動かない」ため、
  // pointerdown→move（5px閾値）→up の自前実装に置換。moveNodes()（layerTree.ts）はそのまま。
  // 副次効果: ドラッグ中の DOM 再構築が安全になったので「折りたたみフォルダの1秒ホバー自動展開」も実装。

  private rowDrag: {
    id: string;
    kind: "layer" | "folder";
    startX: number;
    startY: number;
    active: boolean;
    ghost: HTMLElement | null;
    target: { t: DropTarget; zone: "above" | "below" | "into"; rowIdx: number } | null;
    hoverFolder: string | null;
    hoverTimer: number | null;
    onMove: (e: PointerEvent) => void;
    onUp: (e: PointerEvent) => void;
  } | null = null;
  /** ドラッグ後の click（選択変更）を1回だけ抑止する */
  private suppressRowClick = false;

  private startRowDrag(e: PointerEvent, id: string, kind: "layer" | "folder") {
    if (this.rowDrag) return;
    if (this.xformActive || this.floatBuf || this.cornerActive) return; // ガードのトーストは click 側に任せる
    this.suppressRowClick = false;
    const onMove = (ev: PointerEvent) => this.updateRowDrag(ev);
    const onUp = (ev: PointerEvent) => this.finishRowDrag(ev);
    this.rowDrag = {
      id,
      kind,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      ghost: null,
      target: null,
      hoverFolder: null,
      hoverTimer: null,
      onMove,
      onUp,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  private updateRowDrag(ev: PointerEvent) {
    const d = this.rowDrag;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 5) return;
      d.active = true;
      this.suppressRowClick = true; // ドラッグ確定後の click は選択変更しない
      // クリック→即ドラッグ: 選択外の行から開始したら単独選択に切替（クラスのみ更新）
      if (!this.selectedNodeIds.has(d.id)) {
        this.selectedNodeIds = new Set([d.id]);
        this.selAnchorId = d.id;
        if (d.kind === "layer") this.activeLayerId = d.id;
        this.displayRows.forEach((r) => {
          r.el.classList.toggle("sel", this.selectedNodeIds.has(r.id));
          if (r.kind === "layer") r.el.classList.toggle("active", r.id === this.activeLayerId);
        });
      }
      const order = this.displayRows.map((r) => r.id);
      this.dragNodes = topNodesOf(this.project, [...this.selectedNodeIds]).sort(
        (a, b) => order.indexOf(a) - order.indexOf(b)
      );
      // ゴースト（掴んでいる中身の表示）
      const g = document.createElement("div");
      g.className = "drag-ghost";
      const name =
        d.kind === "folder"
          ? `📁 ${this.folderById(d.id)?.name ?? ""}`
          : this.project.layerDefs.find((l) => l.id === d.id)?.name ?? "";
      const n = this.dragNodes.length;
      g.textContent = n > 1 ? `${name} ほか${n - 1}件` : name;
      document.body.appendChild(g);
      d.ghost = g;
    }
    if (d.ghost) {
      d.ghost.style.left = `${ev.clientX + 14}px`;
      d.ghost.style.top = `${ev.clientY + 16}px`;
    }
    // ヒットテスト
    const hit = this.hitTestRowDrag(ev.clientX, ev.clientY);
    d.target = hit;
    if (!hit) {
      this.clearDndUi();
      d.ghost?.classList.add("invalid");
      this.setDragHoverFolder(null);
      return;
    }
    d.ghost?.classList.remove("invalid");
    this.showRowIndicator(hit.rowIdx, hit.zone);
    // 折りたたみフォルダに1秒ホバーで自動展開（into ゾーンのみ）
    const hoverId =
      hit.zone === "into" && this.folderById(hit.t.type === "into" ? hit.t.folder : undefined)?.collapsed
        ? (hit.t as { folder: string }).folder
        : null;
    this.setDragHoverFolder(hoverId);
  }

  private setDragHoverFolder(folderId: string | null) {
    const d = this.rowDrag;
    if (!d) return;
    if (d.hoverFolder === folderId) return;
    if (d.hoverTimer != null) {
      clearTimeout(d.hoverTimer);
      d.hoverTimer = null;
    }
    d.hoverFolder = folderId;
    if (folderId) {
      d.hoverTimer = window.setTimeout(() => {
        const f = this.folderById(folderId);
        if (f && f.collapsed && this.rowDrag) {
          f.collapsed = false;
          this.dirty = true;
          this.rebuildLayers(); // 自前ドラッグなので再構築してもドラッグは継続できる
        }
      }, 1000);
    }
  }

  /** 画面座標 → 行/隙間ゾーンと DropTarget（null=パネル外 or 循環で不可） */
  private hitTestRowDrag(
    x: number,
    y: number
  ): { t: DropTarget; zone: "above" | "below" | "into"; rowIdx: number } | null {
    const host = document.querySelector("#ed-layers") as HTMLElement | null;
    const ids = this.dragNodes ?? [];
    if (!host || ids.length === 0) return null;
    const hr = host.getBoundingClientRect();
    if (x < hr.left - 12 || x > hr.right + 12 || y < hr.top - 12 || y > hr.bottom + 12)
      return null; // パネル外=ドロップなし（キャンセル）
    const rows = this.displayRows;
    let rowIdx = rows.length;
    let zone: "above" | "below" | "into" = "above";
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].el.getBoundingClientRect();
      if (y < r.top) {
        rowIdx = i;
        zone = "above"; // 行間（マージン）の隙間 = この行の上
        break;
      }
      if (y <= r.bottom) {
        rowIdx = i;
        const frac = (y - r.top) / Math.max(1, r.height);
        if (rows[i].kind === "folder")
          zone = frac < 0.25 ? "above" : frac > 0.75 ? "below" : "into";
        else zone = frac < 0.5 ? "above" : "below";
        break;
      }
    }
    const t: DropTarget =
      zone === "into"
        ? { type: "into", folder: this.displayRows[rowIdx].id }
        : this.gapTargetAt(zone === "above" ? rowIdx : rowIdx + 1);
    const parent = t.type === "into" ? t.folder : t.parent;
    if (wouldCycle(this.project, ids, parent)) return null; // 循環禁止
    return { t, zone, rowIdx };
  }

  private showRowIndicator(rowIdx: number, zone: "above" | "below" | "into") {
    this.clearDndUi();
    if (!this.insLineEl) return;
    if (zone === "into") {
      this.displayRows[rowIdx]?.el.classList.add("droptarget");
      return;
    }
    // 挿入線: gap の位置（末尾は最後の行の下）
    const gi = zone === "above" ? rowIdx : rowIdx + 1;
    let top: number;
    if (gi < this.displayRows.length) top = this.displayRows[gi].el.offsetTop - 4;
    else {
      const last = this.displayRows[this.displayRows.length - 1];
      top = last ? last.el.offsetTop + last.el.offsetHeight + 1 : 0;
    }
    this.insLineEl.hidden = false;
    this.insLineEl.style.top = `${top}px`;
  }

  private finishRowDrag(ev: PointerEvent) {
    const d = this.rowDrag;
    if (!d) return;
    const wasActive = d.active;
    const target = d.target;
    const ids = this.dragNodes;
    const cancelled = ev.type === "pointercancel";
    this.cancelRowDrag();
    // click は pointerup 直後（同期的なイベント順）に来るので、その後で抑止フラグを必ず解除する
    // （行外で離した場合などに click が来ずフラグが残り、次の正当なクリックを飲み込まないように）
    if (wasActive) setTimeout(() => (this.suppressRowClick = false), 0);
    if (wasActive && !cancelled && target && ids) this.performTreeMove(ids, target.t);
  }

  /** ドラッグの後片付け（移動はしない）。Escや浮遊状態リセットからも呼ぶ */
  private cancelRowDrag() {
    const d = this.rowDrag;
    if (!d) return;
    window.removeEventListener("pointermove", d.onMove);
    window.removeEventListener("pointerup", d.onUp);
    window.removeEventListener("pointercancel", d.onUp);
    if (d.hoverTimer != null) clearTimeout(d.hoverTimer);
    d.ghost?.remove();
    this.clearDndUi();
    this.rowDrag = null;
    this.dragNodes = null;
  }

  private folderById(id: string | undefined): LayerFolder | undefined {
    return (this.project.folders ?? []).find((f) => f.id === id);
  }

  /** レイヤーの祖先フォルダ連鎖（root→…→直親。壊れ/循環は途中で打ち切り） */
  private ancestorChain(parent: string | undefined): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = parent;
    while (cur && !seen.has(cur)) {
      const f = this.folderById(cur);
      if (!f) break;
      seen.add(cur);
      chain.unshift(cur);
      cur = f.parent;
    }
    return chain;
  }

  /** フォルダ（ネスト込み）に属するレイヤーの layerDefs インデックス列（昇順） */
  private folderLayerIndices(folderId: string): number[] {
    const out: number[] = [];
    this.project.layerDefs.forEach((ld, i) => {
      if (this.ancestorChain(ld.parent).includes(folderId)) out.push(i);
    });
    return out;
  }

  /** 構造スナップショット（defs順・parent・folders・コマ固有order）を撮る */
  private captureStructure() {
    return {
      defs: this.project.layerDefs.map((l) => ({ ...l })),
      folders: (this.project.folders ?? []).map((f) => ({ ...f })),
      orders: this.project.frames.map((f) => (f.order ? [...f.order] : undefined)),
      active: this.activeLayerId,
      selFolder: this.selectedFolderId,
    };
  }

  private restoreStructure(s: ReturnType<Editor["captureStructure"]>) {
    this.project.layerDefs = s.defs.map((l) => ({ ...l }));
    this.project.folders = s.folders.map((f) => ({ ...f }));
    this.project.frames.forEach((f, i) => {
      f.order = s.orders[i] ? [...s.orders[i]!] : undefined;
    });
    this.activeLayerId = s.active;
    this.selectedFolderId = s.selFolder;
    this.afterLayerChange();
  }

  /** 構造変更を履歴付きで実行（before/after スナップショット方式） */
  private pushStructure(label: string, mutate: () => void) {
    const before = this.captureStructure();
    mutate();
    const after = this.captureStructure();
    const self = this;
    this.history.push({
      label,
      undo: () => self.restoreStructure(before),
      redo: () => self.restoreStructure(after),
    });
    this.afterLayerChange();
  }

  /** 物理順（layerDefs）が変わる操作の前処理: コマ固有描画順を標準化（既存 moveLayer と同じ扱い） */
  private clearFrameOrders(): boolean {
    let had = false;
    for (const f of this.project.frames) {
      if (f.order) {
        f.order = undefined;
        had = true;
      }
    }
    return had;
  }

  /** フォルダ追加: 選択中レイヤーを子にして作成（フォルダ選択中はその中に空フォルダ） */
  private addFolder() {
    if (this.xformGuard()) return;
    const folders = (this.project.folders ??= []);
    const targetFolder = this.selectedFolderId
      ? this.folderById(this.selectedFolderId)
      : undefined;
    const active = this.project.layerDefs.find((l) => l.id === this.activeLayerId);
    this.pushStructure("フォルダ作成", () => {
      const id = newFolderId(this.project);
      const folder: LayerFolder = {
        id,
        name: `フォルダ${folders.length + 1}`,
        visible: true,
        opacity: 1,
        collapsed: false,
        parent: targetFolder ? targetFolder.id : active?.parent,
      };
      folders.push(folder);
      if (!targetFolder && active) active.parent = id; // 選択レイヤーを包む
      this.selectedFolderId = id;
    });
  }

  /** フォルダ削除（中身はルートへ or 中身ごと） */
  private async deleteFolder(id: string) {
    if (this.xformGuard()) return;
    const folder = this.folderById(id);
    if (!folder) return;
    const ok = await this.cb.confirm(`フォルダ「${folder.name}」を削除しますか？`);
    if (!ok) return;
    const memberIdx = this.folderLayerIndices(id);
    const withContents =
      memberIdx.length > 0 &&
      (await this.cb.confirm(
        `中のレイヤー（${memberIdx.length}枚）も削除しますか？\n「いいえ」でフォルダだけ削除（中身は1つ外へ出します）`
      ));
    if (!withContents) {
      this.pushStructure("フォルダ削除", () => {
        const folders = this.project.folders ?? [];
        // 直下の子（レイヤー/フォルダ）を1つ外（folder.parent）へ
        for (const ld of this.project.layerDefs)
          if (ld.parent === id) ld.parent = folder.parent;
        for (const f of folders) if (f.parent === id) f.parent = folder.parent;
        this.project.folders = folders.filter((f) => f.id !== id);
        if (this.selectedFolderId === id) this.selectedFolderId = null;
      });
      return;
    }
    // 中身ごと削除: レイヤーバッファも履歴に退避（deleteLayer と同等の可逆性）
    if (memberIdx.length >= this.project.layerDefs.length) {
      this.cb.toast("全レイヤーを削除することはできません");
      return;
    }
    const structBefore = this.captureStructure();
    const removedIds = memberIdx.map((i) => this.project.layerDefs[i].id);
    const savedBuffers = this.project.frames.map((f) => {
      const m: Record<string, IndexBuf> = {};
      for (const lid of removedIds)
        m[lid] = copyIndexBuf(f.layers[lid] ?? allocIndexBuf(this.project));
      return m;
    });
    const removeSet = new Set(removedIds);
    const removeFolderIds = new Set(
      (this.project.folders ?? [])
        .filter((f) => f.id === id || this.ancestorChain(f.parent).includes(id))
        .map((f) => f.id)
    );
    removeFolderIds.add(id);
    const apply = () => {
      this.project.layerDefs = this.project.layerDefs.filter((l) => !removeSet.has(l.id));
      this.project.folders = (this.project.folders ?? []).filter(
        (f) => !removeFolderIds.has(f.id)
      );
      for (const f of this.project.frames) {
        for (const lid of removedIds) delete f.layers[lid];
        if (f.order) f.order = f.order.filter((x) => !removeSet.has(x));
      }
      if (removeSet.has(this.activeLayerId))
        this.activeLayerId =
          this.project.layerDefs[this.project.layerDefs.length - 1]?.id ?? "";
      if (this.selectedFolderId && removeFolderIds.has(this.selectedFolderId))
        this.selectedFolderId = null;
      this.afterLayerChange();
    };
    const self = this;
    this.history.push({
      label: "フォルダごと削除",
      undo() {
        self.restoreStructure(structBefore);
        self.project.frames.forEach((f, fi) => {
          for (const lid of removedIds) {
            const nb = allocIndexBuf(self.project);
            nb.set(savedBuffers[fi][lid]);
            f.layers[lid] = nb;
          }
        });
        self.afterLayerChange();
      },
      redo: apply,
    });
    apply();
  }

  // ---------------- M3.8: クリスタ流DnD（選択・移動・挿入線） ----------------

  /** 選択の正規化: 存在しない node を除去し、空なら active を選択 */
  private pruneSelection() {
    const alive = new Set<string>([
      ...this.project.layerDefs.map((l) => l.id),
      ...(this.project.folders ?? []).map((f) => f.id),
    ]);
    for (const id of [...this.selectedNodeIds])
      if (!alive.has(id)) this.selectedNodeIds.delete(id);
    if (this.selectedNodeIds.size === 0 && this.activeLayerId)
      this.selectedNodeIds.add(this.activeLayerId);
  }

  /** 行クリックの選択更新（click=単独 / Ctrl=トグル / Shift=表示リスト範囲） */
  private updateSelection(id: string, kind: "layer" | "folder", ev: MouseEvent) {
    // M3.9 H-2: ドラッグ直後に発火する click では選択を変えない
    if (this.suppressRowClick) {
      this.suppressRowClick = false;
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      if (this.selectedNodeIds.has(id)) this.selectedNodeIds.delete(id);
      else {
        this.selectedNodeIds.add(id);
        if (kind === "layer") this.activeLayerId = id;
      }
      this.selAnchorId = id;
    } else if (ev.shiftKey && this.selAnchorId) {
      const order = this.displayRows.map((r) => r.id);
      const a = order.indexOf(this.selAnchorId);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        this.selectedNodeIds = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
        if (kind === "layer") this.activeLayerId = id;
      }
    } else {
      this.selectedNodeIds = new Set([id]);
      this.selAnchorId = id;
      if (kind === "layer") {
        this.activeLayerId = id;
        this.selectedFolderId = null;
      }
    }
    if (kind === "folder" && !ev.shiftKey && !ev.ctrlKey)
      this.selectedFolderId = this.selectedFolderId === id ? null : id;
    this.rebuildLayers();
  }

  /** 表示リストの隙間 gi（rows[gi] の上）を DropTarget(gap) に解決する */
  private gapTargetAt(gi: number): DropTarget {
    const rows = this.displayRows;
    // parent = 隙間の直下にある行の親（隙間に挿すとその行と同じ階層になる）
    let parent: string | undefined = undefined;
    if (gi < rows.length) parent = rows[gi].parent;
    // 物理位置 = 隙間より下（表示）で最初に物理アンカーを持つ行の直上
    let phys = 0;
    for (let i = gi; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind === "layer") {
        phys = r.phys + 1;
        break;
      }
      const members = this.folderLayerIndices(r.id);
      if (members.length > 0) {
        phys = members[members.length - 1] + 1;
        break;
      }
      // 空フォルダは物理アンカーなし → さらに下を見る
    }
    return { type: "gap", parent, phys };
  }

  /** DnD確定: 選択トップノード群を target へ（履歴1件・変化なしなら履歴を積まない） */
  private performTreeMove(ids: string[], target: DropTarget) {
    if (this.xformGuard()) return;
    const before = this.captureStructure();
    const res = moveNodes(this.project, ids, target);
    if (!res.ok) {
      if (res.error) this.cb.toast(res.error);
      return;
    }
    if (res.changedPhys && this.clearFrameOrders())
      this.cb.toast("コマごとの描画順（3D由来）を標準化しました");
    const after = this.captureStructure();
    if (JSON.stringify(after) === JSON.stringify(before)) {
      this.afterLayerChange();
      return; // 実質変化なし（同じ場所へドロップ等）
    }
    const self = this;
    this.history.push({
      label: "レイヤー移動",
      undo: () => self.restoreStructure(before),
      redo: () => self.restoreStructure(after),
    });
    this.afterLayerChange();
  }

  private rebuildLayers() {
    const host = $("#ed-layers");
    host.innerHTML = "";
    this.displayRows = [];
    this.pruneSelection();
    const folders = this.project.folders ?? [];
    const emittedFolders = new Set<string>();

    // M3.8: 挿入線インジケータ（rebuildごとに作り直し・クラスフィールドで共有）
    const insLine = document.createElement("div");
    insLine.className = "ins-line";
    insLine.hidden = true;
    host.appendChild(insLine);
    this.insLineEl = insLine;
    // M3.9 H-2: HTML5 DnD はペン（Windows Ink）で発火しないため、Pointer Events 自前ドラッグへ全面置換
    const bindRowDnd = (row: HTMLElement, id: string, kind: "layer" | "folder") => {
      row.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest(".uisl, .minibtn")) return; // スライダー/ボタンからは開始しない
        this.startRowDrag(e, id, kind);
      });
    };

    const isCollapsedUnder = (chain: string[]): boolean =>
      chain.some((fid) => this.folderById(fid)?.collapsed);

    const makeFolderRow = (f: LayerFolder, depth: number) => {
      const row = document.createElement("div");
      row.className =
        "lay lay-folder" +
        (f.visible ? " on" : "") +
        (this.selectedNodeIds.has(f.id) ? " sel" : "") +
        (f.id === this.selectedFolderId ? " active" : "");
      row.style.marginLeft = `${depth * 14}px`;
      const col = document.createElement("span");
      col.className = "eye";
      col.textContent = f.collapsed ? "▶" : "▼";
      col.title = "折りたたみ";
      col.addEventListener("click", (e) => {
        e.stopPropagation();
        f.collapsed = !f.collapsed;
        this.dirty = true;
        this.rebuildLayers();
      });
      const eye = document.createElement("span");
      eye.className = "eye";
      eye.textContent = f.visible ? "👁" : "🚫";
      eye.style.opacity = f.visible ? "1" : "0.35";
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.xformGuard()) return;
        this.pushStructure("フォルダ表示切替", () => {
          f.visible = !f.visible;
        });
      });
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = `📁 ${f.name}`;
      nm.title = "ダブルクリックでリネーム";
      nm.addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const v = await this.cb.prompt("フォルダ名", f.name);
        if (v)
          this.pushStructure("フォルダ名変更", () => {
            f.name = v;
          });
      });
      // M6-5 Q-1/Q-6: 共通スライダー部品（行DnDに乗っ取られない・端まで一致）
      let opBefore: number | null = null;
      const op = createSlider({
        min: 0,
        max: 100,
        value: Math.round(f.opacity * 100),
        className: "lay-op",
        title: "フォルダ不透明度（中身に乗算）",
        onDown: () => (opBefore = f.opacity),
        onInput: (v) => {
          f.opacity = v / 100;
          this.renderCanvas();
          this.dirty = true;
        },
        onChange: () => {
          if (opBefore != null && opBefore !== f.opacity) {
            const from = opBefore;
            const to = f.opacity;
            const fid = f.id;
            const self = this;
            // 構造系Undoで folders 配列が clone に差し替わるため、
            // オブジェクト参照でなく id で適用時に解決する（Codexレビュー指摘#5）
            this.history.push({
              label: "フォルダ不透明度",
              undo() {
                const cur = self.folderById(fid);
                if (cur) cur.opacity = from;
                self.afterLayerChange();
              },
              redo() {
                const cur = self.folderById(fid);
                if (cur) cur.opacity = to;
                self.afterLayerChange();
              },
            });
          }
          opBefore = null;
        },
      });
      const del = document.createElement("button");
      del.className = "minibtn";
      del.textContent = "🗑";
      del.title = "フォルダ削除";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.deleteFolder(f.id);
      });
      row.appendChild(col);
      row.appendChild(eye);
      row.appendChild(nm);
      row.appendChild(op.root);
      row.appendChild(del);
      row.addEventListener("click", (e) => {
        if (this.xformGuard()) return;
        this.updateSelection(f.id, "folder", e);
      });
      bindRowDnd(row, f.id, "folder");
      host.appendChild(row);
      this.displayRows.push({ kind: "folder", id: f.id, el: row, parent: f.parent, phys: -1 });
    };

    const emitFolderChain = (chain: string[]) => {
      chain.forEach((fid, depth) => {
        if (emittedFolders.has(fid)) return;
        const parentChain = chain.slice(0, depth);
        if (isCollapsedUnder(parentChain)) {
          emittedFolders.add(fid);
          return;
        }
        const f = this.folderById(fid);
        if (f) makeFolderRow(f, depth);
        emittedFolders.add(fid);
      });
    };

    // 上→下で表示（配列は下→上）。同一フォルダの子は連続配置の不変条件を前提に、
    // 各レイヤーの祖先チェーンに沿ってフォルダ見出しを挿入する
    for (let i = this.project.layerDefs.length - 1; i >= 0; i--) {
      const ld = this.project.layerDefs[i];
      const chain = this.ancestorChain(ld.parent);
      emitFolderChain(chain);
      if (isCollapsedUnder(chain)) continue; // 折りたたみ中
      const depth = chain.length;
      const row = document.createElement("div");
      row.className =
        "lay" +
        (ld.visible ? " on" : "") +
        (this.selectedNodeIds.has(ld.id) ? " sel" : "") +
        (ld.id === this.activeLayerId ? " active" : "");
      row.style.marginLeft = `${depth * 14}px`;
      const eye = document.createElement("span");
      eye.className = "eye";
      eye.textContent = ld.visible ? "👁" : "🚫";
      eye.style.opacity = ld.visible ? "1" : "0.35";
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.xformGuard()) return; // E-4
        ld.visible = !ld.visible;
        this.rebuildLayers();
        this.renderCanvas();
        // M10-23 レビュー検出の既存バグ: visible は保存対象なのに dirty を立てておらず、
        // 可視切替だけではオートセーブも終了警告も働かなかった（不透明度・名前と同じ流儀）
        this.dirty = true;
      });
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = ld.name;
      nm.title = "ダブルクリックでリネーム";
      nm.addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const v = await this.cb.prompt("レイヤー名", ld.name);
        if (v) {
          ld.name = v;
          this.rebuildLayers();
          this.dirty = true;
        }
      });
      // M6-5 Q-1/Q-6: 共通スライダー部品（行DnDに乗っ取られない・端まで一致）
      const op = createSlider({
        min: 10,
        max: 100,
        value: Math.round(ld.opacity * 100),
        className: "lay-op",
        title: "不透明度（PC拡張）",
        onInput: (v) => {
          ld.opacity = v / 100;
          this.renderCanvas();
          this.dirty = true;
        },
      });
      row.appendChild(eye);
      row.appendChild(nm);
      row.appendChild(op.root);
      row.addEventListener("click", (e) => {
        if (this.xformGuard()) return; // E-4: 変形対象レイヤーの切替を防ぐ
        this.updateSelection(ld.id, "layer", e);
      });
      bindRowDnd(row, ld.id, "layer");
      host.appendChild(row);
      this.displayRows.push({ kind: "layer", id: ld.id, el: row, parent: ld.parent, phys: i });
    }
    // 空フォルダ（メンバー無し）を末尾に表示
    for (const f of folders) {
      if (emittedFolders.has(f.id)) continue;
      const chain = [...this.ancestorChain(f.parent), f.id];
      emitFolderChain(chain);
    }
  }

  private buildToolOptions() {
    const host = $("#ed-toolopts");
    host.innerHTML = "";
    if (this.tool === "fill") {
      // M10-19: バケツ塗りの参照レイヤー選択（トーンは従来どおり #ed-tex 側のピッカー）
      host.innerHTML = `<h3>塗り</h3>
        <div class="row"><span class="tog">参照</span><div class="oni" style="flex:1" id="ed-fillref">
          <button class="lv${this.fillRefAll ? "" : " on"}" data-v="self">このレイヤー</button>
          <button class="lv${this.fillRefAll ? " on" : ""}" data-v="all">全レイヤー</button>
        </div></div>
        <p class="hintline">全レイヤー: 表示中の全レイヤーの絵を境界として、このレイヤーに塗ります。</p>`;
      host.querySelectorAll("#ed-fillref .lv").forEach((b) =>
        b.addEventListener("click", () => {
          this.fillRefAll = (b as HTMLElement).dataset.v === "all";
          this.buildToolOptions();
        })
      );
    } else if (this.tool === "shape") {
      host.innerHTML = `<h3>図形</h3><div class="oni">
        <button class="lv${this.shapeKind === "line" ? " on" : ""}" data-k="line">／直線</button>
        <button class="lv${this.shapeKind === "rect" ? " on" : ""}" data-k="rect">□四角</button>
        <button class="lv${this.shapeKind === "ellipse" ? " on" : ""}" data-k="ellipse">○丸</button>
      </div>
      <div class="row"><span class="tog">塗りつぶし</span><div class="sw2${this.shapeFill ? " on" : ""}" id="ed-shapefill"></div></div>`;
      host.querySelectorAll(".lv").forEach((b) =>
        b.addEventListener("click", () => {
          this.shapeKind = (b as HTMLElement).dataset.k as ShapeKind;
          this.buildToolOptions();
        })
      );
      $("#ed-shapefill").addEventListener("click", () => {
        this.shapeFill = !this.shapeFill;
        this.buildToolOptions();
      });
    } else if (this.tool === "text") {
      // M10-1c: 書体 → サイズ（書体連動）→ 太さ の順。選択肢は fonts.ts のテーブルから組む
      const def = fontDef(this.textFamily);
      host.innerHTML = `<h3>文字</h3>
        <div class="row"><span class="tog">書体</span>
          <select id="ed-textfont">${FONTS.map(
            (f) => `<option value="${f.key}"${f.key === this.textFamily ? " selected" : ""}>${f.label}</option>`
          ).join("")}</select></div>
        <div class="row"><span class="tog">サイズ</span>
          <select id="ed-textsize">${def.sizes
            .map((s) => `<option value="${s}"${s === this.textSize ? " selected" : ""}>${s}px</option>`)
            .join("")}</select></div>
        ${
          // M10-15: 太字を持つ書体だけ行を出す（手ブレ補正と同型＝スイッチ右端寄せ）。
          // 太字なし書体では行ごと非表示（M10-1c の「薄く残す」設計は作者判断で廃止）
          def.hasBold
            ? `<div class="row"><span class="tog">太さ</span>
          <div class="sw2${this.textBold ? " on" : ""}" id="ed-textbold"></div></div>`
            : ""
        }
        <div class="row"><span class="tog">向き</span>
          <div class="oni" style="flex:1" id="ed-textdir">
            <button type="button" class="lv${this.textVertical ? "" : " on"}" data-v="h">横書き</button>
            <button type="button" class="lv${this.textVertical ? " on" : ""}" data-v="v">縦書き</button>
          </div></div>
        <p class="hintline">キャンバスをクリックすると入力ダイアログが出ます。</p>`;
      $("#ed-textfont").addEventListener("change", (e) => {
        this.textFamily = (e.target as HTMLSelectElement).value as FontKey;
        const d = fontDef(this.textFamily);
        // 直前のサイズが新候補にあれば維持し、無ければ最も近い値へ
        this.textSize = nearestSize(d, this.textSize);
        if (!d.hasBold) this.textBold = false;
        this.buildToolOptions();
        this.cb.onTextSettingsChange?.(this.textSettings());
      });
      $("#ed-textsize").addEventListener("change", (e) => {
        this.textSize = Number((e.target as HTMLSelectElement).value);
        this.cb.onTextSettingsChange?.(this.textSettings());
      });
      // M10-15: 行は hasBold の書体でしか描かない — 存在するときだけリスナを張る
      document.querySelector("#ed-textbold")?.addEventListener("click", () => {
        if (!fontDef(this.textFamily).hasBold) return; // 最終防衛線（行が無いので実質不要）
        this.textBold = !this.textBold;
        this.buildToolOptions();
        this.cb.onTextSettingsChange?.(this.textSettings());
      });
      // M10-11: 向き（横書き／縦書き）。既存の .oni + .lv だけで組む（新規CSSなし）
      host.querySelectorAll("#ed-textdir .lv").forEach((b) =>
        b.addEventListener("click", () => {
          const v = (b as HTMLElement).dataset.v === "v";
          if (v === this.textVertical) return;
          this.textVertical = v;
          this.buildToolOptions();
          this.cb.onTextSettingsChange?.(this.textSettings());
        })
      );
    } else if (this.tool === "warp") {
      // M10-2a: モードボタンは最初から4つ置き、未実装の3つは無効表示で残す。
      // M10-2b/2c で並びが変わって段組みが崩れる（M5-3→M5-5 の再演）のを避けるため。
      const modes: { k: WarpMode; label: string; ready: boolean }[] = [
        { k: "push", label: "🫱 押す", ready: true },
        { k: "bulge", label: "◍ ふくらませ", ready: true },
        { k: "pinch", label: "◌ へこませ", ready: true },
        { k: "corner", label: "⛶ 四隅", ready: true }, // M10-2c
      ];
      // M10-2c: 四隅は半径・強さが意味を持たないが、行は残して disabled にする
      // （消すとパネルの高さが跳ねる。M10-2a でボタンを disabled で残したのと同じ理由）
      const isCorner = this.warpMode === "corner";
      const warpHint = isCorner
        ? "四隅をドラッグして台形にできます。Enter で確定、Esc で取り消し。"
        : this.warpMode === "bulge"
          ? "押した場所を中心にふくらみます。押しっぱなしで強くなります。"
          : this.warpMode === "pinch"
            ? "押した場所を中心にへこみます。押しっぱなしで強くなります。"
            : "ドラッグした向きに絵が引っ張られます。範囲選択があるとその中だけ。";
      host.innerHTML = `<h3>歪み</h3>
        <div class="oni" id="ed-warpmode">${modes
          .map(
            (m) =>
              `<button class="lv${m.k === this.warpMode ? " on" : ""}" data-m="${m.k}"${
                m.ready ? "" : " disabled"
              }>${m.label}</button>`
          )
          .join("")}</div>
        <div class="row"><span class="tog">半径 <b id="ed-warpr-v">${this.warpRadius}</b>px</span><div id="ed-warpr" style="flex:1"></div></div>
        <div class="row"><span class="tog">強さ <b id="ed-warps-v">${this.warpStrength}</b>%</span><div id="ed-warps" style="flex:1"></div></div>
        <p class="hintline">${warpHint}</p>${
          isCorner
            ? `<div class="selacts">
        <button class="minibtn ok" id="ed-corner-ok">✔ 確定</button>
        <button class="minibtn" id="ed-corner-cancel">✖ キャンセル</button>
      </div>`
            : ""
        }`;
      host.querySelectorAll("#ed-warpmode .lv").forEach((b) =>
        b.addEventListener("click", () => {
          if ((b as HTMLButtonElement).disabled) return;
          const next = (b as HTMLElement).dataset.m as WarpMode;
          if (next === this.warpMode) return;
          // M10-2c: 四隅から抜けるときは未確定の変形を取り消す（焼き込まない）
          if (this.cornerActive) this.cancelCornerWarp();
          this.warpMode = next;
          if (next === "corner") this.beginCornerWarp();
          this.buildToolOptions();
        })
      );
      if (isCorner) {
        host
          .querySelector("#ed-corner-ok")
          ?.addEventListener("click", () => this.commitCornerWarp());
        host
          .querySelector("#ed-corner-cancel")
          ?.addEventListener("click", () => this.cancelCornerWarp());
      }
      const rPh = host.querySelector("#ed-warpr");
      if (rPh) {
        const s = createSlider({
          min: 8,
          max: 80,
          value: this.warpRadius,
          onInput: (v) => {
            this.warpRadius = v;
            ($("#ed-warpr-v") as HTMLElement).textContent = String(v);
          },
        });
        rPh.replaceWith(s.root);
        s.root.id = "ed-warpr"; // 音声パネル（#ap-vol）と同じ流儀で id を引き継ぐ
        s.root.style.flex = "1";
        if (isCorner) this.disableSlider(s.root);
      }
      const sPh = host.querySelector("#ed-warps");
      if (sPh) {
        const s = createSlider({
          min: 0,
          max: 100,
          value: this.warpStrength,
          onInput: (v) => {
            this.warpStrength = v;
            ($("#ed-warps-v") as HTMLElement).textContent = String(v);
          },
        });
        sPh.replaceWith(s.root);
        s.root.id = "ed-warps";
        s.root.style.flex = "1";
        if (isCorner) this.disableSlider(s.root);
      }
    } else if (this.tool === "select") {
      // M10-19: 3種目「✨ 自動」（クリックで同添字領域を即選択）。auto 時のみ参照/範囲の2行を出す
      host.innerHTML = `<h3>範囲選択</h3><div class="oni">
        <button class="lv${this.selectKind === "rect" ? " on" : ""}" data-k="rect">⬚ 矩形</button>
        <button class="lv${this.selectKind === "lasso" ? " on" : ""}" data-k="lasso">➰ 自由</button>
        <button class="lv${this.selectKind === "auto" ? " on" : ""}" data-k="auto">✨ 自動</button>
      </div>
      ${
        this.selectKind === "auto"
          ? `<div class="row"><span class="tog">参照</span><div class="oni" style="flex:1" id="ed-selref">
          <button class="lv${this.selectRefAll ? "" : " on"}" data-v="self">このレイヤー</button>
          <button class="lv${this.selectRefAll ? " on" : ""}" data-v="all">全レイヤー</button>
        </div></div>
        <div class="row"><span class="tog">範囲</span><div class="oni" style="flex:1" id="ed-selscope">
          <button class="lv${this.selectAutoGlobal ? "" : " on"}" data-v="conn">つながり</button>
          <button class="lv${this.selectAutoGlobal ? " on" : ""}" data-v="global">全体</button>
        </div></div>`
          : ""
      }
      <div class="selacts">
        <button class="minibtn" id="ed-sel-copy">コピー</button>
        <button class="minibtn" id="ed-sel-cut">切り取り</button>
        <button class="minibtn" id="ed-sel-paste">貼り付け</button>
        <button class="minibtn" id="ed-sel-del">削除</button>
        <button class="minibtn" id="ed-sel-none">解除</button>
      </div>
      <p class="hintline">${
        this.selectKind === "auto"
          ? "クリックした場所と同じ色の範囲を選択します。選択内ドラッグで移動。"
          : "選択内ドラッグで移動。変形ツールで回転・拡縮。"
      }</p>`;
      // M10-19: 種別切替は data-k のボタンだけに束ねる（参照/範囲の .lv と混線させない）
      host.querySelectorAll("[data-k]").forEach((b) =>
        b.addEventListener("click", () => {
          this.selectKind = (b as HTMLElement).dataset.k as "rect" | "lasso" | "auto";
          this.buildToolOptions();
        })
      );
      host.querySelectorAll("#ed-selref .lv").forEach((b) =>
        b.addEventListener("click", () => {
          this.selectRefAll = (b as HTMLElement).dataset.v === "all";
          this.buildToolOptions();
        })
      );
      host.querySelectorAll("#ed-selscope .lv").forEach((b) =>
        b.addEventListener("click", () => {
          this.selectAutoGlobal = (b as HTMLElement).dataset.v === "global";
          this.buildToolOptions();
        })
      );
      $("#ed-sel-copy").addEventListener("click", () => this.copySelection(false));
      $("#ed-sel-cut").addEventListener("click", () => this.copySelection(true));
      $("#ed-sel-paste").addEventListener("click", () => this.pasteClipboard());
      $("#ed-sel-del").addEventListener("click", () => this.deleteSelection());
      $("#ed-sel-none").addEventListener("click", () => {
        // M10-22: 解除も履歴へ（選択が無いときは何も積まない）
        if (this.selMask) this.pushSelectionHistory("選択解除", this.selMask.slice(), null);
        this.selMask = null;
        this.redrawOverlay();
      });
    } else if (this.tool === "transform") {
      host.innerHTML = `<h3>変形（高精度・結果はドット確定）</h3>
      <div class="row"><span class="tog">回転</span><input type="number" id="ed-x-angle" value="${Math.round(
        (this.xform.angle * 180) / Math.PI
      )}" step="1" style="width:64px"> °
        <div class="sw2${this.snap15 ? " on" : ""}" id="ed-x-snap" title="15°スナップ"></div><span class="tog">15°</span></div>
      <div class="row"><span class="tog">拡縮</span><input type="number" id="ed-x-scale" value="${(
        this.xform.sx * 100
      ).toFixed(0)}" step="1" style="width:64px"> %</div>
      <div class="selacts">
        <button class="minibtn" id="ed-x-fliph">↔ 左右反転</button>
        <button class="minibtn" id="ed-x-flipv">↕ 上下反転</button>
      </div>
      <div class="selacts">
        <button class="minibtn ok" id="ed-x-ok">✔ 確定</button>
        <button class="minibtn" id="ed-x-cancel">✖ キャンセル</button>
      </div>`;
      $("#ed-x-angle").addEventListener("input", (e) => {
        this.xform.angle =
          ((Number((e.target as HTMLInputElement).value) || 0) * Math.PI) / 180;
        this.redrawOverlay();
      });
      $("#ed-x-scale").addEventListener("input", (e) => {
        const s = Math.max(1, Number((e.target as HTMLInputElement).value) || 100) / 100;
        this.xform.sx = s;
        this.xform.sy = s;
        this.redrawOverlay();
      });
      $("#ed-x-snap").addEventListener("click", () => {
        this.snap15 = !this.snap15;
        this.buildToolOptions();
      });
      $("#ed-x-fliph").addEventListener("click", () => {
        this.xform.flipH = !this.xform.flipH;
        this.redrawOverlay();
      });
      $("#ed-x-flipv").addEventListener("click", () => {
        this.xform.flipV = !this.xform.flipV;
        this.redrawOverlay();
      });
      $("#ed-x-ok").addEventListener("click", () => this.commitTransform());
      $("#ed-x-cancel").addEventListener("click", () => {
        this.cancelTransform();
        this.setTool(this.prevTool === "transform" ? "pen" : this.prevTool);
      });
    }
  }
  private snap15 = false;

  // ---------------- タイムライン ----------------

  private buildTimeline() {
    const head = $("#ed-tlhead");
    head.innerHTML = `
      <button class="ic" id="ed-first" title="先頭">⏮</button>
      <button class="ic" id="ed-prev" title="前のコマ">◀</button>
      <button class="ic play" id="ed-play" title="再生">▶</button>
      <button class="ic" id="ed-next" title="次のコマ">▶︎▍</button>
      <button class="ic" id="ed-last" title="末尾">⏭</button>
      <button class="ic${this.project.loop ? " onb" : ""}" id="ed-loop" title="ループ">🔁</button>
      <span class="t" style="margin-left:4px">タイムライン</span>
      <span class="sp"></span>
      <span class="speed">速さ <select id="ed-speed">${FPS_TABLE.map(
        (f, i) =>
          // M10-11: 表記を原作準拠の 0〜10 に（FPS_TABLE は添字0=0.2fps で元から原作の並び）。
          // value は従来どおり添字なので、保存値・速度連動 rate・書き出し fps は一切変わらない
          `<option value="${i}"${i === this.project.speedIndex ? " selected" : ""}>${i}（${f}fps）</option>`
      ).join("")}</select></span>
      <button class="hb" id="ed-addframe">＋ ついか</button>
      <button class="hb" id="ed-dupframe" title="このコマをその場に複製">⧉ 複製</button>
      <button class="hb" id="ed-wobble" title="このコマから、少し揺れた差分を数枚つくる">〰️ ゆらゆら</button>
      <button class="hb" id="ed-copypage" title="選択中のコマをコピー（Shift+クリックで範囲選択 / Ctrl+Shift+C）">🗐 コピー</button>
      <button class="hb" id="ed-pastepage" title="1枚=このコマに上書き / 複数=このコマの後ろに挿入（Ctrl+Shift+V）" disabled>📋 はりつけ</button>
      <button class="hb danger" id="ed-delframe">🗑 さくじょ</button>
    `;
    $("#ed-first").addEventListener("click", () => this.gotoFrame(0));
    $("#ed-prev").addEventListener("click", () => this.gotoFrame(this.frameIndex - 1));
    $("#ed-next").addEventListener("click", () => this.gotoFrame(this.frameIndex + 1));
    $("#ed-last").addEventListener("click", () =>
      this.gotoFrame(this.project.frames.length - 1)
    );
    $("#ed-play").addEventListener("click", () => this.togglePlayback());
    $("#ed-loop").addEventListener("click", () => {
      this.project.loop = !this.project.loop;
      $("#ed-loop").classList.toggle("onb", this.project.loop);
      this.dirty = true;
    });
    $("#ed-speed").addEventListener("change", (e) => {
      this.project.speedIndex = Number((e.target as HTMLSelectElement).value);
      this.dirty = true;
      if (this.playing) {
        this.stopPlayback();
        this.startPlayback();
      }
    });
    $("#ed-addframe").addEventListener("click", () => this.addFrame(false));
    $("#ed-dupframe").addEventListener("click", () => this.addFrame(true));
    $("#ed-wobble").addEventListener("click", () => void this.onWobbleClick());
    $("#ed-copypage").addEventListener("click", () => this.copySelectedFrames());
    $("#ed-pastepage").addEventListener("click", () => this.pasteFrames());
    $("#ed-delframe").addEventListener("click", () => this.deleteFrame());
    this.updatePasteButton();
    this.rebuildFilm();
  }

  // ---------------- M10-3: ゆらゆら差分の自動生成 ----------------

  /** 現在のコマの全レイヤーから決定的な32bitハッシュを作る（FNV-1a 風）。
   *  同じ絵なら必ず同じ値。ここで乱数を使うと「同じ入力で同じ結果」が壊れる。 */
  private hashCurrentFrame(): number {
    const f = this.project.frames[this.frameIndex];
    let h = 0x811c9dc5;
    if (!f) return h >>> 0;
    for (const ld of this.project.layerDefs) {
      const b = f.layers[ld.id];
      if (!b) continue;
      for (let i = 0; i < PIXELS; i++) {
        h ^= b[i];
        h = Math.imul(h, 0x01000193);
      }
    }
    return h >>> 0;
  }

  /**
   * M10-3: ゆらゆら差分を作る。**現在のコマは読むだけで一切変更しない。**
   * 戻り値は「原本の直後に挿入する N−1 枚」。`project.frames` には触らない。
   *
   * `seedBase` を**引数で受け取る**のは意図的。内部で `hashCurrentFrame()` を呼ぶと
   * `?wobble` から固定シードを渡して決定性を検証できなくなる。ハッシュは呼び出し側の仕事。
   */
  private buildWobbleFrames(
    count: number, // 2 | 3 | 4（原本を含めた総枚数）
    kind: WobbleKind,
    strength: WobbleStrength,
    seedBase: number
  ): Frame[] {
    const cur = this.project.frames[this.frameIndex];
    if (!cur) return [];
    const { L, A } = WOBBLE_TABLE[kind][strength];
    const field = new WarpField();
    const out: Frame[] = [];
    for (let k = 0; k < count - 1; k++) {
      const seedK = (seedBase + Math.imul(k + 1, 0x9e3779b9)) >>> 0;
      // dx と dy に別シード（同じだと全画素が斜めにずれるだけで「ゆれ」に見えない）
      field.setValueNoise(seedK, (seedK ^ 0x6d2b79f5) >>> 0, L, A);
      const nf = cloneFrame(cur);
      // 効果音は複製しない（同じ音が N 回鳴るのは誰も望まない）
      nf.se = undefined;
      // **1枚につき変位場は1つ**。全レイヤーに同じ場を当てるのでレイヤー間でズレない。
      // 非表示レイヤーも含める（除外すると絵の整合が崩れる）
      for (const ld of this.project.layerDefs) {
        const src = cur.layers[ld.id];
        const dst = nf.layers[ld.id];
        // src と dst は別実体（cloneFrame → copyIndexBuf が新しい typed array を作る）。
        // 適用元は**常に原本**で、直前の生成結果には絶対に再適用しない。
        // マスクは渡さない（ゆらゆらは別のコマを作る操作なので選択範囲を効かせない）
        if (src && dst) applyWarp(src, dst, field, null);
      }
      out.push(nf);
    }
    return out;
  }

  private async onWobbleClick(): Promise<void> {
    if (this.xformGuard()) return; // 変形中は止める（既存の流儀）
    if (!this.project.frames[this.frameIndex]) return;
    const opt = await this.openWobbleDialog();
    if (!opt) return;
    const n = opt.count - 1;
    if (this.project.frames.length + n > 65535) {
      this.cb.toast("コマ数が上限（65,535）を超えるため生成できません");
      return;
    }
    const willWarn = this.project.frames.length + n >= 2000;
    const kindIndex = opt.kind === "line" ? 0 : 1;
    const seedBase =
      (this.hashCurrentFrame() ^
        Math.imul(this.project.frames.length, 0x9e3779b1) ^
        Math.imul(this.frameIndex + 1, 0x85ebca6b) ^
        Math.imul(kindIndex * 3 + opt.strength + 1, 0xc2b2ae35)) >>>
      0;
    const newFrames = this.buildWobbleFrames(
      opt.count,
      opt.kind,
      opt.strength,
      seedBase
    );
    if (newFrames.length === 0) return;
    const at = this.frameIndex + 1;
    const self = this;
    const apply = () => {
      // redo 時に 16bit 昇格を跨いでいる可能性があるので正規化（pasteFrames と同じ）
      for (const f of newFrames) conformFrameWidth(self.project, f);
      self.project.frames.splice(at, 0, ...newFrames);
      // **frameIndex は動かさない**。ゆらゆらは「原本は変わらない」のが機能の肝なので、
      // pasteFrames と違って挿入先へは移動せず、押したあとも原本に留まる
      self.afterFrameStructureChange();
    };
    const revert = () => {
      self.project.frames.splice(at, newFrames.length);
      self.frameIndex = Math.min(self.frameIndex, self.project.frames.length - 1);
      self.afterFrameStructureChange();
    };
    this.history.push({ label: "ゆらゆら差分", undo: revert, redo: apply });
    apply();
    if (willWarn)
      this.cb.toast("⚠ コマ数が非常に多くなっています（動作が重くなる場合があります）");
    // 速度ヒント。**速度は勝手に変えない。** トーストが2連続で重なって読めないので、
    // 生成枚数のトーストにヒントを混ぜて1つにまとめる（P-9-2 の許容範囲）
    const fps = FPS_TABLE[this.project.speedIndex] ?? 8;
    this.cb.toast(
      fps >= 12
        ? `${newFrames.length}枚を生成しました（8fps くらいがゆらゆらに合います）`
        : `${newFrames.length}枚を生成しました`
    );
  }

  /** ゆらゆらの設定ダイアログ。`EditorCallbacks` は増やさず、
   *  `openAudioPanel` と同じく `modal-back` + `modal-box` を自前で組む。
   *  クラスは既存のものだけを使い、新しい CSS 宣言は1つも足さない。 */
  private openWobbleDialog(): Promise<{
    count: number;
    kind: WobbleKind;
    strength: WobbleStrength;
  } | null> {
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "modal-back";
      const box = document.createElement("div");
      box.className = "modal-box";
      back.appendChild(box);
      const radios = (
        name: string,
        items: { v: string; label: string }[],
        def: string
      ) =>
        items
          .map(
            (it) =>
              `<label style="margin-right:14px;white-space:nowrap"><input type="radio" name="${name}" value="${it.v}"${
                it.v === def ? " checked" : ""
              }> ${it.label}</label>`
          )
          .join("");
      box.innerHTML = `<p class="modal-msg">〰️ ゆらゆら差分をつくる</p>
        <div class="modal-msg" style="text-align:left">
          <div style="margin-bottom:8px">枚数 ${radios("wb-n", [
            { v: "2", label: "2枚" },
            { v: "3", label: "3枚" },
            { v: "4", label: "4枚" },
          ], "3")}</div>
          <div style="margin-bottom:8px">揺れの強さ ${radios("wb-s", [
            { v: "0", label: "弱" },
            { v: "1", label: "中" },
            { v: "2", label: "強" },
          ], "1")}</div>
          <div>種類 ${radios("wb-k", [
            { v: "line", label: "線がふるえる" },
            { v: "whole", label: "全体がゆれる" },
          ], "line")}</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="wb-cancel">キャンセル</button>
          <button class="btn primary" id="wb-ok">つくる</button>
        </div>`;
      document.body.appendChild(back);

      let done = false;
      const close = (
        r: { count: number; kind: WobbleKind; strength: WobbleStrength } | null
      ) => {
        if (done) return;
        done = true;
        this.modalDepth--;
        this.wobbleDialogClose = null;
        window.removeEventListener("keydown", onKey, true);
        back.remove();
        resolve(r);
      };
      this.wobbleDialogClose = () => close(null);
      // ダイアログが開いている間はエディタのショートカットを一切通さない。
      // capture フェーズで捕まえて stopPropagation することで、Escape が
      // エディタの onKeyDown へ届いて選択解除まで走るのを防ぐ（P-8）
      const onKey = (e: KeyboardEvent) => {
        // `stopPropagation` だけだと**同じ window に付いている**エディタの keydown には効かない
        // （同一要素の他リスナーは止まらない）。Escape がエディタ側へ抜けて
        // 選択解除まで走るので `stopImmediatePropagation` にする（P-8）
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          close(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          pick();
        }
      };
      window.addEventListener("keydown", onKey, true);
      this.modalDepth++;
      const val = (name: string) =>
        (box.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement)
          .value;
      const pick = () =>
        close({
          count: Number(val("wb-n")),
          kind: val("wb-k") as WobbleKind,
          strength: Number(val("wb-s")) as WobbleStrength,
        });
      (box.querySelector("#wb-ok") as HTMLElement).addEventListener("click", pick);
      (box.querySelector("#wb-cancel") as HTMLElement).addEventListener(
        "click",
        () => close(null)
      );
      // M10-11: ペンで即閉じしないよう pointerdown に（main.ts の modal() と同じ理由）
      back.addEventListener("pointerdown", (e) => {
        if (e.target === back) close(null);
      });
      (box.querySelector("#wb-ok") as HTMLElement).focus();
    });
  }

  private updatePasteButton() {
    const b = document.querySelector("#ed-pastepage") as HTMLButtonElement | null;
    if (b) b.disabled = !Editor.frameClip;
  }

  private rebuildFilm() {
    const film = $("#ed-film");
    film.innerHTML = "";
    // F-0対策: サムネは 80×60 の縮小 canvas＋可視分のみ遅延描画。
    // 320×240 を全コマ分確保すると数百コマで canvas メモリ上限を超え、
    // メインキャンバスの描画が白紙化する（WebView2 実機で確認された症状）。
    this.filmObserver?.disconnect();
    this.filmObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.filmObserver?.unobserve(e.target);
          const idx = Number((e.target as HTMLElement).dataset.idx);
          if (!Number.isNaN(idx)) this.paintFilmThumb(idx);
        }
      },
      { root: film, rootMargin: "200px" }
    );
    this.project.frames.forEach((_, i) => {
      const fr = document.createElement("div");
      fr.className = "fr" + (i === this.frameIndex ? " on" : "");
      fr.draggable = true;
      fr.dataset.idx = String(i);
      const no = document.createElement("span");
      no.className = "no";
      no.textContent = String(i + 1);
      const cv = document.createElement("canvas");
      cv.width = Editor.THUMB_W;
      cv.height = Editor.THUMB_H;
      fr.appendChild(no);
      fr.appendChild(cv);
      fr.addEventListener("click", (e) => {
        if (e.shiftKey) {
          // 範囲選択: 起点（rangeAnchor）〜 i
          if (this.rangeAnchor == null) this.rangeAnchor = this.frameIndex;
          this.rangeSel = {
            a: Math.min(this.rangeAnchor, i),
            b: Math.max(this.rangeAnchor, i),
          };
        } else {
          this.rangeSel = null;
          this.rangeAnchor = i;
        }
        this.gotoFrame(i);
      });
      fr.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/animemo-frame", String(i));
      });
      fr.addEventListener("dragover", (e) => e.preventDefault());
      fr.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData("text/animemo-frame"));
        if (!Number.isNaN(from)) this.reorderFrame(from, i);
      });
      film.appendChild(fr);
      this.filmObserver!.observe(fr);
    });
    const add = document.createElement("button");
    add.className = "fradd";
    add.textContent = "＋";
    add.title = "コマをついか";
    add.addEventListener("click", () => this.addFrame(false));
    film.appendChild(add);
    this.updateBadge();
    this.updateFilmSeMarks(); // M5-1: SE配置マーク
  }

  private paintFilmThumb(i: number, cv?: HTMLCanvasElement) {
    const film = $("#ed-film");
    const el =
      cv ??
      (film.querySelector(`.fr[data-idx="${i}"] canvas`) as HTMLCanvasElement | null);
    if (!el) return;
    // 共有スクラッチ（320×240）に合成 → 縮小して転写（nearest-neighbor）
    if (!this.filmScratch) {
      this.filmScratch = document.createElement("canvas");
      this.filmScratch.width = W;
      this.filmScratch.height = H;
    }
    presentToCanvas(compositeFrame(this.project, i), this.filmScratch);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.drawImage(this.filmScratch, 0, 0, el.width, el.height);
  }

  private updateFilmSelection() {
    document.querySelectorAll("#ed-film .fr").forEach((el) => {
      const idx = Number((el as HTMLElement).dataset.idx);
      el.classList.toggle("on", idx === this.frameIndex);
      el.classList.toggle(
        "rangesel",
        this.rangeSel != null && idx >= this.rangeSel.a && idx <= this.rangeSel.b
      );
    });
    this.updateBadge();
  }

  private updateBadge() {
    $("#ed-badge").textContent = `コマ ${this.frameIndex + 1} / ${this.project.frames.length}`;
  }

  // ---------------- ヘッダー ----------------

  private bindHeader() {
    $("#ed-back").onclick = async () => {
      if (this.xformGuard()) return; // E-4
      if (this.dirty) {
        const ok = await this.cb.confirm(
          "保存していない変更があります。破棄してライブラリへ戻りますか？"
        );
        if (!ok) return;
        // 破棄を選んだのでオートセーブも消す（次回起動時に復元を出さない）
        await this.invalidateAutosave();
      }
      this.cb.onExit();
    };
    // M3.8 L-B: ヘッダーの↶↷もキーと同じ規則（変形/浮動中はグローバル履歴に通さない）
    $("#ed-undo").onclick = () => this.handleUndo();
    $("#ed-redo").onclick = () => this.handleRedo();
    $("#ed-save").onclick = () => this.save();
    $("#ed-saveas").onclick = () => this.saveAs();
    $("#ed-export").onclick = () => {
      if (this.xformGuard()) return; // E-4
      if (this.playing) this.stopPlayback();
      this.cb.openExport(
        projectSource(this.project),
        (this.project.meta.title || "無題").replace(/\.[^.]+$/, ""),
        this.rangeSel,
        this.buildExportAudioSource(),
        (m) => {
          // P-6: 書き出しダイアログでの「書き出す長さ」選択を記憶（値の書き戻しのみ）
          const b = this.project.audio?.bgm;
          if (b && b.syncMode !== m) {
            b.syncMode = m;
            this.dirty = true;
          }
        }
      );
    };
    this.history.onchange = () => {
      ($("#ed-undo") as HTMLButtonElement).disabled = !this.history.canUndo;
      ($("#ed-redo") as HTMLButtonElement).disabled = !this.history.canRedo;
    };
    this.history.onchange();
    // 表示操作
    $("#ed-view-rot").onclick = () => {
      this.viewRot = (this.viewRot + 90) % 360;
      this.applyViewTransform();
    };
    $("#ed-view-flip").onclick = () => {
      this.viewFlipH = !this.viewFlipH;
      this.applyViewTransform();
    };
    $("#ed-zoom-in").onclick = () => this.adjustZoom(+1);
    $("#ed-zoom-out").onclick = () => this.adjustZoom(-1);
    $("#ed-mini").onclick = () => {
      this.previewLarge = !this.previewLarge;
      $("#ed-stage").classList.toggle("swapped", this.previewLarge);
      this.applyZoom();
    };
  }

  // ---------------- 保存 ----------------

  /** 保存。成功時 true / キャンセル・失敗時 false（saveAs のフラグ復元に使う） */
  async save(): Promise<boolean> {
    if (this.xformGuard()) return false; // E-4
    if (this.askSaveTarget || !this.saveCtx) {
      // F-4: 既存アルバムのピッカー（＋新規フォルダ作成）で保存先を選ぶ
      const defAlbum = this.saveCtx?.album ?? "未分類";
      const defName =
        this.saveCtx?.baseName ??
        (this.project.meta.title || "無題").replace(/\.[^.]+$/, "");
      const picked = await this.cb.pickSaveTarget(defAlbum, defName);
      if (!picked) return false;
      this.saveCtx = {
        libRoot: this.saveCtx?.libRoot ?? "",
        album: picked.album,
        baseName: picked.baseName,
      };
    }
    try {
      // M10-14: 手動保存（Ctrl+S・保存ボタン・別名保存）のときだけサムネコマを更新。
      // 15秒オートセーブは projectToBytes を直接呼ぶだけなので既存値のまま
      //（オートセーブでサムネが揺れない＝作者明示仕様）
      this.project.thumbFrame = Math.max(
        0,
        Math.min(this.project.frames.length - 1, this.frameIndex)
      );
      const { projectToBytes } = await import("./serialize");
      const data = await projectToBytes(this.project);
      const blob = await frameToPngBlob(this.project, this.project.thumbFrame);
      const thumb = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
      const path = await this.cb.saveProject(this.saveCtx, data, thumb);
      this.dirty = false;
      this.askSaveTarget = false;
      // 進行中の古いオートセーブが保存後に復活しないよう世代を進めてから消す
      await this.invalidateAutosave();
      this.cb.toast(`保存しました: ${path}`);
      this.cb.onSaved(path);
      return true;
    } catch (e) {
      this.cb.toast(`保存に失敗: ${e}`);
      return false;
    }
  }

  /** 別名保存（M3.3-A）: ピッカーを強制して save() へ。以降の保存は新ファイルへ向く。
   *  ピッカーをキャンセルした場合は元のフラグへ戻す（次の Ctrl+S が別名扱いにならないように） */
  async saveAs() {
    const prev = this.askSaveTarget;
    this.askSaveTarget = true;
    const ok = await this.save();
    if (!ok) this.askSaveTarget = prev;
  }

  // ---------------- ページ／複数ページ・クリップボード（M3.3-B） ----------------

  /** 選択中のコマ（単一 or Shift範囲）をアプリ全体クリップボードへ（非破壊・履歴なし） */
  copySelectedFrames() {
    // 変形/選択移動の浮動中は、切り出されたピクセルが本体に無く欠損コピーになる
    // M10-2c: 四隅変形中は未確定のプレビューをそのままコピーしてしまうので同様に止める
    if (this.xformActive || this.floatBuf || this.cornerActive) {
      this.cb.toast("変形・移動を確定（またはキャンセル）してからコピーしてください");
      return;
    }
    const last = this.project.frames.length - 1;
    const idxs: number[] = [];
    if (this.rangeSel) {
      // 範囲は現在のコマ数へクランプ（古い範囲の持ち越し対策の最終防衛線）
      const a = Math.max(0, Math.min(this.rangeSel.a, last));
      const b = Math.max(0, Math.min(this.rangeSel.b, last));
      for (let i = a; i <= b; i++) idxs.push(i);
    } else {
      idxs.push(Math.max(0, Math.min(this.frameIndex, last)));
    }
    Editor.frameClip = makeClip(this.project, idxs);
    this.updatePasteButton();
    // 大きな範囲は保持サイズも明示（静的保持のため）
    let bytes = 0;
    for (const f of Editor.frameClip.frames)
      for (const lay of f.layers) bytes += lay.byteLength;
    const sizeNote = bytes > 20 * 1024 * 1024 ? `（約${Math.round(bytes / 1024 / 1024)}MB保持）` : "";
    this.cb.toast(
      idxs.length === 1
        ? "ページをコピーしました"
        : `${idxs.length}枚コピーしました${sizeNote}`
    );
  }

  /** はりつけ: 1枚=現在ページに上書き（うごメモ準拠）／複数=現在コマの後ろに挿入（総集編） */
  pasteFrames() {
    const clip = Editor.frameClip;
    if (!clip || clip.frames.length === 0) {
      this.cb.toast("コピーされたページがありません");
      return;
    }
    if (this.xformGuard()) return; // E-4: copy側と統一（暗黙キャンセルしない）
    const self = this;
    const bitsBefore = this.project.indexBits;

    if (clip.frames.length === 1) {
      // --- 単ページ: 現在ページに上書き ---
      const frame = this.project.frames[this.frameIndex];
      if (!frame) return;
      // before 退避（色再マップ＝昇格の前に取得。widening は undo 側の alloc+set が担保）
      const layerIds = this.project.layerDefs.map((l) => l.id);
      const beforeLayers: Record<string, IndexBuf> = {};
      for (const id of layerIds)
        beforeLayers[id] = copyIndexBuf(frame.layers[id] ?? allocIndexBuf(this.project));
      const beforePaper = frame.paper;
      const beforeOrder = frame.order ? [...frame.order] : undefined;
      // M5-1（Codex指摘#1）: SE配置も上書き対象（コピー元の配置を貼る・Undoで元の配置へ戻す）
      const beforeSe = frame.se ? [...frame.se] : undefined;
      // 色再マップ→構築（昇格し得る。関数内で「色解決→確保」順を保証）
      const [built] = buildFramesFromClip(this.project, clip);
      const afterLayers: Record<string, IndexBuf> = {};
      for (const id of layerIds)
        afterLayers[id] = copyIndexBuf(built.layers[id] ?? allocIndexBuf(this.project));
      const afterPaper = built.paper;
      const afterSe = built.se ? [...built.se] : undefined; // 貼り付け先に存在するidのみ（filter済み）
      const restore = (
        layers: Record<string, IndexBuf>,
        paper: number,
        order: string[] | undefined,
        se: string[] | undefined
      ) => {
        for (const id of layerIds) {
          const nb = allocIndexBuf(self.project);
          nb.set(layers[id]);
          frame.layers[id] = nb;
        }
        frame.paper = paper;
        frame.order = order ? [...order] : undefined;
        frame.se = se && se.length > 0 ? [...se] : undefined;
        // ★昇格をまたぐ undo/redo の幅不整合防止（M3.3 ハンドオフ指定）
        conformFrameWidth(self.project, frame);
        self.afterStructuralChange();
        self.updateFilmSeMarks();
        self.redrawOverlay();
      };
      this.history.push({
        label: "ページ貼り付け",
        undo: () => restore(beforeLayers, beforePaper, beforeOrder, beforeSe),
        redo: () => restore(afterLayers, afterPaper, undefined, afterSe),
      });
      restore(afterLayers, afterPaper, undefined, afterSe);
      if (bitsBefore === 8 && this.project.indexBits === 16) {
        this.cb.toast("パレットを拡張しました（最大65,536色・高精細モード）");
      }
      this.cb.toast("ページを貼り付けました");
      return;
    }

    // --- 複数ページ: 現在コマの後ろに挿入 ---
    const n = clip.frames.length;
    if (this.project.frames.length + n > 65535) {
      this.cb.toast("コマ数が上限（65,535）を超えるため貼り付けできません");
      return;
    }
    const newFrames = buildFramesFromClip(this.project, clip);
    const at = this.frameIndex + 1;
    const apply = () => {
      // redo 時: 挿入待機中に16bit昇格が起きていると8bitのまま取り残されるため正規化
      for (const f of newFrames) conformFrameWidth(self.project, f);
      self.project.frames.splice(at, 0, ...newFrames);
      self.frameIndex = at;
      self.afterFrameStructureChange();
    };
    const revert = () => {
      self.project.frames.splice(at, n);
      self.frameIndex = Math.min(at - 1, self.project.frames.length - 1);
      self.afterFrameStructureChange();
    };
    this.history.push({ label: "ページ挿入", undo: revert, redo: apply });
    apply();
    if (bitsBefore === 8 && this.project.indexBits === 16) {
      this.cb.toast("パレットを拡張しました（最大65,536色・高精細モード）");
    }
    this.cb.toast(`${n}枚を挿入しました`);
  }

  // ---------------- キャンバス表示 ----------------

  private applyZoom() {
    if (!this.mounted) return;
    const stage = $("#ed-stage");
    const wrap = $("#ed-cvwrap");
    const availW = stage.clientWidth - 40;
    const availH = stage.clientHeight - 40;
    const rotated = this.viewRot % 180 !== 0;
    const cw = rotated ? H : W;
    const ch = rotated ? W : H;
    let z: number;
    if (this.zoomMode === "fit") {
      z = Math.max(1, Math.floor(Math.min(availW / cw, availH / ch)));
    } else {
      z = this.zoomMode;
    }
    wrap.style.width = `${W * z}px`;
    wrap.style.height = `${H * z}px`;
    $("#ed-zoominfo").textContent = `🔍 320×240 を ${z}.0倍表示（ドット等倍）`;
    // E-2/M3.10 G-1: ピクセル格子（1ドット≥8pxで表示・実測ピッチで再描画）
    this.updateGridOverlay(z);
    this.applyViewTransform();
  }

  /** M3.10 G-1: ピクセル格子の再描画。
   *  ピッチはズーム値でなく「実際に描かれているドットサイズ」（canvas.offsetWidth/320。
   *  transform 非依存のレイアウト実測）から取り、バッキングを cssSize×devicePixelRatio で
   *  確保して物理pxに線を引く（OSスケール 125%/150% の非整数CSSピッチでも滲み/倍ピッチ化しない）。
   *  呼び出し: applyZoom（ズーム/リサイズ=ResizeObserver/回転反転を含む表示更新の集約点）。 */
  private updateGridOverlay(zoomPx: number) {
    const grid = document.querySelector("#ed-grid") as HTMLCanvasElement | null;
    const canvas = document.querySelector("#ed-canvas") as HTMLCanvasElement | null;
    if (!grid || !canvas) return;
    const show = this.gridEnabled && zoomPx >= 8;
    grid.hidden = !show;
    if (!show) return;
    const cssW = canvas.offsetWidth || W * zoomPx;
    const cssH = canvas.offsetHeight || H * zoomPx;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (grid.width !== pw) grid.width = pw;
    if (grid.height !== ph) grid.height = ph;
    const ctx = grid.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, pw, ph);
    ctx.fillStyle = "rgba(128, 128, 128, 0.28)";
    // 原点はキャンバス左上（グリッドは canvas と同位置・同サイズの inset:0 オーバーレイ）
    const px = (cssW * dpr) / W; // 1ドットの物理px幅
    const py = (cssH * dpr) / H;
    for (let i = 1; i < W; i++) ctx.fillRect(Math.round(i * px), 0, 1, ph);
    for (let j = 1; j < H; j++) ctx.fillRect(0, Math.round(j * py), pw, 1);
  }

  private adjustZoom(delta: number) {
    const cur =
      this.zoomMode === "fit"
        ? Math.max(1, Math.round(parseFloat($("#ed-cvwrap").style.width) / W) || 1)
        : this.zoomMode;
    this.zoomMode = Math.min(8, Math.max(1, cur + delta));
    this.applyZoom();
  }

  private applyViewTransform() {
    const wrap = $("#ed-cvwrap");
    wrap.style.transform = `rotate(${this.viewRot}deg)${this.viewFlipH ? " scaleX(-1)" : ""}`;
  }

  /** クライアント座標 → キャンバスドット座標（表示回転/反転の逆写像）。
   *  M3.10 G-1: wrap 矩形は枠線4pxを含みドット領域とズレるため、canvas 自身の矩形で写像する */
  private clientToPixel(cx: number, cy: number): { x: number; y: number } {
    const rect = ($("#ed-canvas") as unknown as HTMLCanvasElement).getBoundingClientRect();
    // rect は回転後の AABB。回転が 90/270 のとき幅高さが入れ替わる
    let u: number, v: number;
    const nx = (cx - rect.left) / rect.width;
    const ny = (cy - rect.top) / rect.height;
    switch (this.viewRot) {
      case 90:
        u = ny;
        v = 1 - nx;
        break;
      case 180:
        u = 1 - nx;
        v = 1 - ny;
        break;
      case 270:
        u = 1 - ny;
        v = nx;
        break;
      default:
        u = nx;
        v = ny;
    }
    if (this.viewFlipH) u = 1 - u;
    return { x: Math.floor(u * W), y: Math.floor(v * H) };
  }

  renderCanvas() {
    compositeFrame(this.project, this.frameIndex, this.composite, {
      onion: this.playing ? 0 : this.onionLevel,
    });
    presentToCanvas(this.composite, $("#ed-canvas") as unknown as HTMLCanvasElement);
    // ミニプレビュー（オニオン無し）
    const mini = $("#ed-mini-canvas") as unknown as HTMLCanvasElement;
    presentToCanvas(compositeFrame(this.project, this.frameIndex), mini);
  }

  private overlayCtx(): CanvasRenderingContext2D {
    const cv = $("#ed-overlay") as unknown as HTMLCanvasElement;
    return cv.getContext("2d")!;
  }

  redrawOverlay() {
    const ctx = this.overlayCtx();
    ctx.clearRect(0, 0, W, H);
    // 選択のマーチングアンツ（ドット風）
    if (this.selMask && !this.xformActive) {
      const img = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!this.selMask[i]) continue;
          const edge =
            x === 0 ||
            y === 0 ||
            x === W - 1 ||
            y === H - 1 ||
            !this.selMask[i - 1] ||
            !this.selMask[i + 1] ||
            !this.selMask[i - W] ||
            !this.selMask[i + W];
          if (edge) {
            // M10-22: 間引きをやめ全輪郭画素を黒/白交互（4px周期）で描く。
            // どんな背景でも必ずどちらかが見える定番の作法（アニメーション不要）
            const white = ((x + y) >> 2) % 2 === 1;
            img.data[i * 4] = white ? 255 : 44;
            img.data[i * 4 + 1] = white ? 255 : 38;
            img.data[i * 4 + 2] = white ? 255 : 33;
            img.data[i * 4 + 3] = 255;
          }
        }
      ctx.putImageData(img, 0, 0);
    }
    // 変形プレビュー
    if (this.xformActive && this.floatBuf) {
      this.drawTransformPreview(ctx);
    }
    // M10-2c: 四隅変形のハンドル
    if (this.cornerActive) this.drawCornerHandles(ctx);
    // 自由選択の軌跡
    if (this.lassoPts.length > 1) {
      ctx.strokeStyle = "rgba(44,38,33,.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.lassoPts[0].x + 0.5, this.lassoPts[0].y + 0.5);
      for (const p of this.lassoPts) ctx.lineTo(p.x + 0.5, p.y + 0.5);
      ctx.stroke();
    }
  }

  private floatToCanvas(f: R.FloatBuf): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = f.w;
    cv.height = f.h;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(f.w, f.h);
    const lutHex = this.project.colorTable;
    for (let i = 0; i < f.w * f.h; i++) {
      const v = f.data[i];
      if (v === 0) continue;
      const hex = lutHex[v];
      img.data[i * 4] = parseInt(hex.slice(1, 3), 16);
      img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  private drawTransformPreview(ctx: CanvasRenderingContext2D) {
    const f = this.floatBuf!;
    const t = this.xform;
    const cx = f.ox + f.w / 2 + t.tx;
    const cy = f.oy + f.h / 2 + t.ty;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(cx, cy);
    ctx.rotate(t.angle);
    ctx.scale(t.sx * (t.flipH ? -1 : 1), t.sy * (t.flipV ? -1 : 1));
    ctx.drawImage(this.floatToCanvas(f), -f.w / 2, -f.h / 2);
    ctx.restore();
    // 枠
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t.angle);
    ctx.strokeStyle = "#f07a1a";
    ctx.lineWidth = 1;
    const hw = (f.w / 2) * t.sx;
    const hh = (f.h / 2) * t.sy;
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    // ハンドル（四隅＋回転）
    ctx.fillStyle = "#fff";
    for (const [hx, hy] of [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ]) {
      ctx.fillRect(hx - 2, hy - 2, 4, 4);
      ctx.strokeRect(hx - 2, hy - 2, 4, 4);
    }
    ctx.beginPath();
    ctx.moveTo(0, -hh);
    ctx.lineTo(0, -hh - 10);
    ctx.stroke();
    ctx.fillRect(-2, -hh - 12, 4, 4);
    ctx.strokeRect(-2, -hh - 12, 4, 4);
    ctx.restore();
  }

  // ---------------- 入力（ポインタ） ----------------

  private bindCanvas() {
    const wrap = $("#ed-cvwrap");
    // M10-21: 入力診断（?inputlog / VITE_INPUTLOG=1 ビルドのみ）。フラグなしは従来の直結のまま
    //（ラッパ自体を作らないので、通常ビルド・通常起動の入力経路は1命令も変わらない）
    const h = this.inputLog
      ? (name: string, fn: (e: PointerEvent) => void) => (e: PointerEvent) => {
          const t0 = performance.now();
          fn(e);
          this.logInput(name, e, performance.now() - t0);
        }
      : (_name: string, fn: (e: PointerEvent) => void) => fn;
    wrap.onpointerdown = h("down", (e) => this.onPointerDown(e));
    wrap.onpointermove = h("move", (e) => this.onPointerMove(e));
    wrap.onpointerup = h("up", (e) => this.onPointerUp(e));
    wrap.onpointercancel = h("cancel", (e) => this.onPointerUp(e));
  }

  /** M10-21: 入力診断ログ（フラグ時のみ到達）。IPC 連打を避けるため 400ms でまとめて書く */
  private logInput(name: string, e: PointerEvent, dtMs: number) {
    const co =
      "getCoalescedEvents" in e ? (e as unknown as { getCoalescedEvents(): unknown[] }).getCoalescedEvents().length : -1;
    this.inputLogBuf.push(
      `[inputlog] ${name} pt=${e.pointerType} btn=${e.button} btns=${e.buttons} ` +
        `p=${e.pressure.toFixed(2)} co=${co} tool=${this.tool} dt=${dtMs.toFixed(2)}ms`
    );
    this.flushInputLogSoon();
  }

  private flushInputLogSoon() {
    if (this.inputLogTimer != null) return;
    this.inputLogTimer = window.setTimeout(() => {
      this.inputLogTimer = null;
      const lines = this.inputLogBuf.splice(0);
      if (lines.length) this.cb.appendLog?.(lines.join("\n"));
    }, 400);
  }

  private activeBuffer(): IndexBuf | null {
    const f = this.project.frames[this.frameIndex];
    if (!f) return null;
    return f.layers[this.activeLayerId] ?? null;
  }

  /** 色を索引に解決する。257色目で16bitへ自動昇格（トースト1回）。
   *  ※ 昇格は全レイヤーバッファを差し替えるため、必ず「色解決 → バッファ取得」の順で使うこと。 */
  private currentColorIndex(): number {
    if (this.colorHex === "") return 0;
    const bitsBefore = this.project.indexBits;
    const lenBefore = this.project.colorTable.length;
    const idx = ensureColor(this.project, this.colorHex);
    if (bitsBefore === 8 && this.project.indexBits === 16) {
      this.cb.toast("パレットを拡張しました（最大65,536色・高精細モード）");
      this.dirty = true;
    } else if (
      lenBefore >= 65536 &&
      this.project.colorTable[idx] !== this.colorHex.toLowerCase()
    ) {
      this.cb.toast("パレットが上限（65,536色）に達したため、最も近い色を使いました");
    }
    return idx;
  }

  private penOptions(pressure: number): R.PenOptions {
    let size = this.penSize;
    if (this.pressureEnabled && pressure > 0 && pressure !== 0.5) {
      size = Math.max(1, Math.round(this.penSize * (0.4 + pressure * 1.2)));
    }
    let texture = this.texture;
    let tone: R.ToneTile | null | undefined;
    let color: number;
    if (this.tool === "eraser") {
      // 消しゴムは色を解決しない（未使用色の登録＝不要な16bit昇格を避ける）
      color = 0;
      texture = "solid";
    } else {
      color = this.currentColorIndex();
      if (this.tool === "brush") {
        // M5-4: ブラシ=うごメモ準拠トーンパターン（座標固定）。ベタ(tile=null)は solid で全塗り
        texture = "solid";
        tone = R.toneById(this.brushToneId)?.tile ?? null;
        size = Math.max(size, 3);
      }
    }
    return {
      size,
      color,
      texture,
      seed: this.strokeSeed,
      dashAcc: this.dashAcc,
      tone: tone ?? undefined,
      // M10-22: 選択中は選択範囲内にのみ描く（選択なしは undefined＝従来どおり・追加コストゼロ）
      clip: this.selMask ?? undefined,
    };
  }

  /** E-1: 手のひら/Spaceパンのカーソル表示 */
  private updatePanCursor(grabbing = false) {
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (!wrap) return;
    if (this.panState || grabbing) wrap.style.cursor = "grabbing";
    else if (this.tool === "hand" || this.spaceHeld) wrap.style.cursor = "grab";
    else wrap.style.cursor = "";
  }

  private onPointerDown(e: PointerEvent) {
    // M10-19: 右ボタンでは何も始めない（Windows のペン長押しは右クリック扱いになるため、
    // contextmenu 抑止とセットで「長押しで点を描いてしまう」事故を防ぐ。中ボタンは従来どおり）
    // M10-21b: スポイトだけは例外 — 狙いを定めるゆっくりタップが長押し判定で右クリック化され
    // 「ペンで色が拾えない」の正体だった（実走ログで確定）。スポイトは何も描かないので
    // 長押し誤爆の実害が構造的に無く、右ボタンでも拾ってよい（contextmenu は抑止済み）
    if (e.button === 2 && this.tool !== "eyedrop") return;
    if (this.playing) return;
    this.shiftHeld = e.shiftKey; // M10-7: pointer 側の modifier を真実として同期
    try {
      ($("#ed-cvwrap") as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 合成イベント・ペン切断時などは捕捉なしで続行 */
    }
    // E-1: 手のひら / Space一時パン（変形中でも画面移動は可能）
    if (this.tool === "hand" || this.spaceHeld) {
      const stage = $("#ed-scroll"); // M3.9 H-1: スクロールは #ed-scroll（HUDは固定）
      this.panState = {
        sx: e.clientX,
        sy: e.clientY,
        sl: stage.scrollLeft,
        st: stage.scrollTop,
      };
      this.pointerDown = true;
      this.updatePanCursor(true);
      return;
    }
    const pt = this.clientToPixel(e.clientX, e.clientY);
    this.pointerDown = true;

    if (this.xformActive && this.floatBuf) {
      this.beginTransformDrag(pt);
      // R-2: ドラッグ開始直後にモードラベルを表示（ペンでhoverが取れない環境でも判別できる）
      this.showXformModeLabel(this.dragMode, e.clientX, e.clientY);
      return;
    }

    switch (this.tool) {
      case "pen":
      case "brush":
      case "eraser": {
        // 色解決（penOptions→currentColorIndex）が16bit昇格でバッファを差し替えることが
        // あるため、必ずオプション解決後にバッファを取り直す
        const o = this.penOptions(e.pressure);
        const buf2 = this.activeBuffer();
        if (!buf2) return;
        this.strokeBefore = copyIndexBuf(buf2);
        this.strokeSeed = (Math.random() * 1e9) | 0;
        this.dashAcc = { d: 0 };
        o.seed = this.strokeSeed;
        o.dashAcc = this.dashAcc;
        this.smoothPt = { x: pt.x, y: pt.y };
        this.lastPt = { x: pt.x, y: pt.y };
        R.stamp(buf2, pt.x, pt.y, o);
        this.renderCanvas();
        break;
      }
      case "fill": {
        const color = this.currentColorIndex(); // 昇格し得るので先に解決
        const buf2 = this.activeBuffer();
        if (!buf2) return;
        const before = copyIndexBuf(buf2);
        // M10-19: 全レイヤー参照 — 領域判定は平坦化した参照バッファ・塗るのは編集レイヤーだけ
        //（平坦化は色解決＝昇格の後に作る。ref 省略時は従来経路そのまま）
        const ref = this.fillRefAll
          ? flattenIndexFrame(this.project, this.frameIndex)
          : undefined;
        // M5-5 T-3: トーン塗り（座標固定＝ブラシのトーンと柄が繋がる）。ベタ=従来どおり
        // M10-22: 選択中は clip=0 を壁として範囲内だけ塗る
        R.floodFill(
          buf2,
          pt.x,
          pt.y,
          color,
          R.toneById(this.fillToneId)?.tile ?? null,
          ref,
          this.selMask ?? undefined
        );
        this.pushBufferHistory("塗り", buf2, before);
        this.renderCanvas();
        break;
      }
      case "shape":
        this.shapeStart = pt;
        this.shapeLastPt = pt;
        break;
      case "text":
        this.placeText(pt);
        break;
      case "eyedrop": {
        this.pickColor(pt);
        // M10-21b: pick 後の同一接触では何も起きないようにする。pickColor → setTool で
        // ツールが pen 等へ切り替わったまま pointerDown が立っていると、接触が続く同じペンが
        // 「拾った色のストローク」を描いてしまう（実走ログ 1012–1015 行の実害）。
        // pointerDown を下ろしてキャプチャも解放し、この接触の move/up を素通しにする
        this.pointerDown = false;
        try {
          ($("#ed-cvwrap") as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          /* 捕捉していない合成イベント等は無視 */
        }
        return;
      }
      case "select": {
        if (this.selMask && this.selMask[pt.y * W + pt.x]) {
          // 選択内ドラッグ → 移動
          this.beginSelectionMove(pt);
        } else if (this.selectKind === "auto") {
          // M10-19: ✨自動 — クリックで即マスク生成（既存選択は置き換え）。
          // 生成した selMask の下流（点線・移動・コピー・削除・変形）は既存のまま
          const ref = this.selectRefAll
            ? flattenIndexFrame(this.project, this.frameIndex)
            : this.activeBuffer();
          if (!ref) return;
          // M10-22: 自動選択も履歴へ（作成・置換）
          const selBefore = this.selMask ? this.selMask.slice() : null;
          this.selMask = R.autoSelectMask(ref, pt.x, pt.y, this.selectAutoGlobal);
          this.pushSelectionHistory("自動選択", selBefore, this.selMask.slice());
          this.redrawOverlay();
        } else if (this.selectKind === "rect") {
          this.shapeStart = pt;
        } else {
          this.lassoPts = [pt];
        }
        break;
      }
      case "warp": {
        if (this.warpMode === "corner") {
          // M10-2c: 四隅はモード開始時に場を用意済み。ここではハンドルを掴むだけ
          if (!this.cornerActive) break;
          // 一番近いハンドルを掴む。しきい値はドット単位で ±8
          // （transform の四隅は ±6。四隅同士が近づいたときに取り違えないよう少し大きめ）
          let best = -1;
          let bestD = 8 * 8 + 1;
          for (let i = 0; i < 4; i++) {
            const hdx = this.cornerPts[i].x - pt.x;
            const hdy = this.cornerPts[i].y - pt.y;
            const d2 = hdx * hdx + hdy * hdy;
            if (d2 < bestD) {
              bestD = d2;
              best = i;
            }
          }
          this.cornerDrag = best >= 0 ? best : null;
          break;
        }
        const f = this.project.frames[this.frameIndex];
        if (!f) break;
        // 適用元は**ストローク開始時のスナップショット**に固定する。
        // 直前の適用結果へ再適用すると最近傍サンプルの誤差が積み上がってドットが溶ける。
        // 非表示レイヤーも含める（除外すると絵の整合が崩れる）
        const snap: Record<string, IndexBuf> = {};
        for (const ld of this.project.layerDefs) {
          const b = f.layers[ld.id];
          if (b) snap[ld.id] = copyIndexBuf(b);
        }
        this.warpBefore = snap;
        this.warpField = new WarpField();
        // 選択範囲のフェードは重みマップとしてここで1回だけ作る（毎moveだと 3.7M ループ）
        this.warpField.setRegionWeight(this.selMask, 3);
        this.warpLastPt = { x: pt.x, y: pt.y };
        // 液状化はここでは適用しない（クリックだけで絵が動かないように）。
        // 色も解決しない（歪みは既存の索引を移すだけ＝不要な16bit昇格を招かない）
        if (this.warpMode === "push") break;
        // 魚眼: 中心を固定して1段階かける。以降は押しっぱなしで連続
        this.warpCenter = { x: pt.x, y: pt.y };
        this.stepFisheye();
        this.scheduleFisheyeRepeat(250); // キーリピートと同じ流儀で最初だけ長めに待つ
        break;
      }
    }
  }

  private onPointerMove(e: PointerEvent) {
    this.shiftHeld = e.shiftKey; // M10-7: pointer 側の modifier を真実として同期
    // E-1: パン中はスクロールのみ（描画しない・ズーム非依存の画面座標）
    if (this.panState) {
      const stage = $("#ed-scroll"); // M3.9 H-1
      stage.scrollLeft = this.panState.sl - (e.clientX - this.panState.sx);
      stage.scrollTop = this.panState.st - (e.clientY - this.panState.sy);
      return;
    }
    // E-3: 変形中のホバーカーソル（角=拡縮 / 角の外側=回転）
    if (!this.pointerDown && this.xformActive && this.floatBuf) {
      this.updateXformHoverCursor(e);
      return;
    }
    if (!this.pointerDown) return;
    const events =
      "getCoalescedEvents" in e ? (e as any).getCoalescedEvents() as PointerEvent[] : [e];
    for (const ev of events) {
      const pt = this.clientToPixel(ev.clientX, ev.clientY);
      if (this.xformActive && this.dragMode) {
        this.updateTransformDrag(pt, ev.shiftKey);
        this.showXformModeLabel(this.dragMode, ev.clientX, ev.clientY); // R-2: ラベル追従
        continue;
      }
      switch (this.tool) {
        case "pen":
        case "brush":
        case "eraser": {
          const buf = this.activeBuffer();
          if (!buf || !this.lastPt) break;
          let tx = pt.x;
          let ty = pt.y;
          if (this.stabilizer && this.smoothPt) {
            // 手ブレ補正: EMA（OFFで3DS準拠の生座標）
            this.smoothPt.x += (pt.x - this.smoothPt.x) * 0.35;
            this.smoothPt.y += (pt.y - this.smoothPt.y) * 0.35;
            tx = Math.round(this.smoothPt.x);
            ty = Math.round(this.smoothPt.y);
          }
          R.strokeSegment(
            buf,
            this.lastPt.x,
            this.lastPt.y,
            tx,
            ty,
            this.penOptions(ev.pressure)
          );
          this.lastPt = { x: tx, y: ty };
          break;
        }
        case "shape": {
          if (!this.shapeStart) break;
          // M10-7: 生の終点を控えてから拘束をかける（Shift の即時反映で使う）
          this.shapeLastPt = pt;
          this.previewShape(this.shapeStart, this.shapeEnd(pt));
          break;
        }
        case "select": {
          if (this.dragMode === "selmove") {
            this.updateSelectionMove(pt);
          } else if (this.selectKind === "rect" && this.shapeStart) {
            this.previewSelectRect(this.shapeStart, pt);
          } else if (this.selectKind === "lasso" && this.lassoPts.length) {
            const last = this.lassoPts[this.lassoPts.length - 1];
            if (Math.abs(last.x - pt.x) + Math.abs(last.y - pt.y) >= 2)
              this.lassoPts.push(pt);
            this.redrawOverlay();
          }
          break;
        }
        case "warp": {
          // coalesced の各点では**場に加算するだけ**。適用はループの外で1回だけ。
          // レイヤー10枚なら1適用で 768K 画素のループになるので、点ごとに適用すると詰まる
          if (this.warpMode === "corner") {
            // M10-2c: 掴んでいるハンドルの位置を更新するだけ。適用はループの外で1回
            if (this.cornerDrag === null) break;
            // overlay は 320×240 しかないので、ハンドルはキャンバス内にクランプする
            // （外へ広げる操作は overlay を広げるまで対応しない）
            const nx = Math.max(0, Math.min(W, pt.x));
            const ny = Math.max(0, Math.min(H, pt.y));
            const prev = this.cornerPts[this.cornerDrag];
            if (prev.x === nx && prev.y === ny) break;
            const di = this.cornerDrag;
            const trial = this.cornerPts.map((p, i2) =>
              i2 === di ? { x: nx, y: ny } : p
            );
            // 非凸になる移動は**受け付けない**（直前の位置に留まる）。
            // 受け付けると消失線が矩形の内側に入り、分母 w が 0 を跨いで写像が発散する。
            // 絵が壊れて Esc しか復帰手段が無くなるので、移動そのものを弾く
            if (!isConvexQuad(trial)) break;
            this.cornerPts = trial;
            break;
          }
          if (this.warpMode !== "push") break; // 魚眼は中心固定・タイマー駆動
          if (!this.warpField || !this.warpLastPt) break;
          const vx = pt.x - this.warpLastPt.x;
          const vy = pt.y - this.warpLastPt.y;
          this.warpField.addLiquify(
            pt.x,
            pt.y,
            vx,
            vy,
            this.warpRadius,
            this.warpStrength
          );
          this.warpLastPt = { x: pt.x, y: pt.y };
          break;
        }
      }
    }
    // M10-2a: 適用はイベント1回につき1度だけ（coalesced ループの外）。
    // M10-2b: 魚眼は中心固定・タイマー駆動なので、move での再適用は不要
    // （場が変わっていないのに同じ結果を描き直すだけの無駄になる）
    if (this.tool === "warp") {
      if (this.warpMode === "push") this.applyWarpPreview();
      else if (this.warpMode === "corner" && this.cornerDrag !== null)
        this.updateCornerPreview();
    }
    if (["pen", "brush", "eraser"].includes(this.tool)) this.renderCanvas();
  }

  /** M10-2a: 変位場を現在のコマの全レイヤーへ適用してプレビューする。
   *  適用元は常に warpBefore（ストローク開始時のスナップショット）で、
   *  直前の適用結果には**絶対に**再適用しない（最近傍サンプルの誤差が積み上がってドットが溶ける）。 */
  private applyWarpPreview(): void {
    if (!this.warpField || !this.warpBefore) return;
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    for (const ld of this.project.layerDefs) {
      const src = this.warpBefore[ld.id];
      const dst = f.layers[ld.id];
      if (src && dst) applyWarp(src, dst, this.warpField, this.selMask);
    }
    this.renderCanvas();
  }

  // ---- M10-2c: 四隅変形（射影変換）。transform とは独立した状態機械 ----

  /** 四隅モードに入る（transform が setTool で即開始するのと同じ流儀） */
  private beginCornerWarp(): void {
    if (this.cornerActive) return;
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    // 変形前の矩形: 選択範囲があればその外接矩形、なければキャンバス全体。
    // 選択した部分だけを台形にしたいときに、四隅が絵の近くに出るほうが操作しやすい
    let x0 = 0;
    let y0 = 0;
    let x1 = W;
    let y1 = H;
    if (this.selMask) {
      let mnx = W;
      let mny = H;
      let mxx = -1;
      let mxy = -1;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (this.selMask[y * W + x]) {
            if (x < mnx) mnx = x;
            if (x > mxx) mxx = x;
            if (y < mny) mny = y;
            if (y > mxy) mxy = y;
          }
      if (mxx < 0) {
        this.cb.toast("変形する内容がありません");
        return;
      }
      x0 = mnx;
      y0 = mny;
      x1 = mxx + 1;
      y1 = mxy + 1;
    }
    this.cornerRect = { x0, y0, x1, y1 };
    this.cornerPts = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    // 適用元は常にこのスナップショット。非表示レイヤーも含める
    const snap: Record<string, IndexBuf> = {};
    for (const ld of this.project.layerDefs) {
      const b = f.layers[ld.id];
      if (b) snap[ld.id] = copyIndexBuf(b);
    }
    this.cornerBefore = snap;
    // 領域重み（setRegionWeight）は**設定しない**。重みで変位を減衰させると
    // もはや射影でなくなり、四隅を結ぶ直線が曲がる。選択範囲は applyWarp のマスクだけで効かせる
    this.warpField = new WarpField();
    this.cornerActive = true;
    this.muteFloatingOverlays(true);
    this.updateXformBadge();
    this.buildToolOptions();
    this.redrawOverlay();
  }

  /** 四隅から場を作り直して全レイヤーへ適用する。退化していたら何もしない（直前の絵が残る） */
  private updateCornerPreview(): void {
    if (!this.cornerActive || !this.warpField || !this.cornerBefore || !this.cornerRect)
      return;
    if (!this.warpField.setHomography(this.cornerPts, this.cornerRect)) return;
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    for (const ld of this.project.layerDefs) {
      const src = this.cornerBefore[ld.id];
      const dst = f.layers[ld.id];
      if (src && dst) applyWarp(src, dst, this.warpField, this.selMask);
    }
    this.renderCanvas();
    this.redrawOverlay();
  }

  /** Enter=確定。ここで初めて履歴に積む（それまでは1件も積まない） */
  private commitCornerWarp(): void {
    const before = this.cornerBefore;
    const f = this.project.frames[this.frameIndex];
    if (!before || !f) {
      this.endCornerWarp();
      return;
    }
    // **変化のあったレイヤーだけ** before/after を積む（M10-2a と同じ流儀）
    const bd: Record<string, IndexBuf> = {};
    const ad: Record<string, IndexBuf> = {};
    let changed = false;
    for (const ld of this.project.layerDefs) {
      const b = before[ld.id];
      const a = f.layers[ld.id];
      if (!b || !a) continue;
      let diff = false;
      for (let i = 0; i < PIXELS; i++)
        if (a[i] !== b[i]) {
          diff = true;
          break;
        }
      if (!diff) continue;
      bd[ld.id] = b;
      ad[ld.id] = copyIndexBuf(a);
      changed = true;
    }
    if (changed) {
      // frameIndex は**キャプチャした値**で引く（確定後にコマが移動しても正しいコマへ戻すため）
      const fi = this.frameIndex;
      this.history.push(
        multiBufferChangeEntry(
          "四隅変形",
          (id) => this.project.frames[fi]?.layers[id] ?? null,
          bd,
          ad,
          () => {
            // M10-23: Undo/Redo もデータ変更なので dirty（＝オートセーブ対象）にする
            //（bufferChangeEntry の onApply と同じ流儀。オートセーブ分割エンコードの
            // 中断判定もこの不変条件に依る）
            this.dirty = true;
            this.renderCanvas();
            this.paintFilmThumb(fi);
          }
        )
      );
      // M10-23 レビュー検出の既存バグ: 確定時に dirty を立てておらず、四隅変形だけでは
      // オートセーブも終了警告も働かなかった（歪みストローク確定と同じ流儀に揃える）
      this.dirty = true;
    }
    this.endCornerWarp();
    this.paintFilmThumb(this.frameIndex);
  }

  /** Esc=取消。全画素をスナップショットへ完全復元し、履歴は1件も積まない。
   *  `silent` は unmount 経由用（DOM が消えかけているので UI 更新を呼ばない） */
  private cancelCornerWarp(silent = false): void {
    const before = this.cornerBefore;
    const f = this.project.frames[this.frameIndex];
    if (before && f)
      for (const ld of this.project.layerDefs) {
        const b = before[ld.id];
        const a = f.layers[ld.id];
        if (b && a) a.set(b);
      }
    this.endCornerWarp(silent);
    if (!silent) this.renderCanvas();
  }

  private endCornerWarp(silent = false): void {
    this.cornerActive = false;
    this.cornerPts = [];
    this.cornerRect = null;
    this.cornerBefore = null;
    this.cornerDrag = null;
    this.warpField = null;
    this.muteFloatingOverlays(false);
    // 確定/取消のあとモードを「押す」へ戻す。`endTransform` が tool を pen へ戻すのと同じ流儀。
    // 戻さないと warpMode==="corner" のまま cornerActive===false という**死んだモード**が残り、
    // 同じボタンをもう一度押しても（next===warpMode で早期 return するので）何も起きなくなる
    if (this.warpMode === "corner") this.warpMode = "push";
    if (silent) return;
    this.updateXformBadge();
    this.buildToolOptions();
    this.redrawOverlay();
  }

  /** M10-2c: 四隅ハンドルはキャンバスの隅ちょうどに出るが、×2 以上のズームでは
   *  そこに表示切替ボタン列（`.cvright`）とミニプレビュー（`#ed-mini`）が重なっていて、
   *  **右上と右下のハンドルが物理的に掴めない**（実機で確認）。
   *  四隅モードの間だけ pointer-events を切り、抜けるときに元の値へ必ず戻す。
   *  styles.css は触らない制約（§3.7-8）があるのでインラインで行う。 */
  private muteFloatingOverlays(on: boolean): void {
    if (on) {
      if (this.cornerMuted.length) return;
      for (const sel of MUTED_OVERLAY_SELECTORS) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) continue;
        this.cornerMuted.push({
          el,
          prevPe: el.style.pointerEvents,
          prevOp: el.style.opacity,
        });
        el.style.pointerEvents = "none";
        // M10-3 P-1-1: 効かないことを見た目にも出す。無効化されているのが分からないと
        // 「ボタンを押しても何も起きない＝壊れた」に見える（disableSlider と同じ手口）
        el.style.opacity = MUTED_OPACITY;
      }
      return;
    }
    for (const m of this.cornerMuted) {
      m.el.style.pointerEvents = m.prevPe;
      m.el.style.opacity = m.prevOp;
    }
    this.cornerMuted = [];
    // M10-3 P-1-2: 保存した参照へ書き戻すだけだと、モード中に再描画で要素が作り直された場合に
    // (a) 新しい要素へ指定が残り (b) DOM から外れた古い要素へ書き戻すだけ、になる。
    // セレクタで引き直した現物からもインライン指定を消して取り残しを防ぐ
    for (const sel of MUTED_OVERLAY_SELECTORS) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      if (el.style.pointerEvents === "none") el.style.pointerEvents = "";
      if (el.style.opacity === MUTED_OPACITY) el.style.opacity = "";
    }
  }

  /** M10-2c: スライダーを無効表示にする。`createSlider` に disabled が無く、
   *  styles.css は触らない制約（§3.7-8）なのでインラインスタイルで済ませる */
  private disableSlider(root: HTMLElement): void {
    root.style.opacity = ".4";
    root.style.pointerEvents = "none";
    const inp = root.querySelector("input");
    if (inp) (inp as HTMLInputElement).disabled = true;
  }

  /** 四隅ハンドルと外周線。色は選択のマーチングアンツに揃える（新しい CSS を足さない） */
  private drawCornerHandles(ctx: CanvasRenderingContext2D): void {
    const p = this.cornerPts;
    if (p.length !== 4) return;
    ctx.save();
    ctx.strokeStyle = "rgba(44,38,33,.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p[0].x + 0.5, p[0].y + 0.5);
    for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x + 0.5, p[i].y + 0.5);
    ctx.closePath();
    ctx.stroke();
    for (const q of p) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(q.x - 3, q.y - 3, 6, 6);
      ctx.strokeRect(q.x - 2.5, q.y - 2.5, 5, 5);
    }
    ctx.restore();
  }

  /** M10-2b: 魚眼を1段階かけてプレビューする。符号はモードが決める（P-5） */
  private stepFisheye(): void {
    if (!this.warpField || !this.warpCenter) return;
    const sign = this.warpMode === "pinch" ? -1 : 1;
    this.warpField.addFisheye(
      this.warpCenter.x,
      this.warpCenter.y,
      this.warpRadius,
      sign * this.warpStrength
    );
    this.applyWarpPreview();
  }

  /** M10-2b: 次の1段階を予約する。**前の適用が終わってから**次を積むので、
   *  適用が重い環境（レイヤー多数）でも呼び出しが溜まらない。
   *  rAF は使わない — 60fps で秒60段階はドット絵に対して速すぎて制御できない。 */
  private scheduleFisheyeRepeat(delayMs: number): void {
    this.clearFisheyeRepeat();
    this.warpTimer = window.setTimeout(() => {
      this.warpTimer = null;
      // タイマー側でも状態を毎回見る二重ガード（後始末が1つ漏れても暴走しない）
      if (!this.pointerDown || this.tool !== "warp" || !this.warpField) return;
      if (this.warpMode !== "bulge" && this.warpMode !== "pinch") return;
      this.stepFisheye();
      this.scheduleFisheyeRepeat(90);
    }, delayMs);
  }

  private clearFisheyeRepeat(): void {
    if (this.warpTimer !== null) {
      window.clearTimeout(this.warpTimer);
      this.warpTimer = null;
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.pointerDown) return;
    // M10-7: 確定時の拘束は**離した瞬間の** Shift 状態で決める（pointerup にも modifier がある）。
    // pointercancel は shiftKey を持つが意味が薄いので、いずれにせよ直前の move と一致する
    this.shiftHeld = e.shiftKey;
    this.pointerDown = false;
    if (this.panState) {
      this.panState = null;
      this.updatePanCursor();
      return;
    }
    const pt = this.clientToPixel(e.clientX, e.clientY);

    if (this.xformActive && this.dragMode) {
      this.dragMode = "";
      this.hideXformModeLabel(); // R-2: ペンを離したらラベルを消す（hover環境では次のmoveで再表示）
      const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
      if (wrap) wrap.style.cursor = this.xformHitTest(pt).cursor;
      this.buildToolOptions(); // 数値表示更新
      return;
    }

    switch (this.tool) {
      case "pen":
      case "brush":
      case "eraser": {
        const buf = this.activeBuffer();
        if (buf && this.strokeBefore) {
          this.pushBufferHistory("描画", buf, this.strokeBefore);
          this.strokeBefore = null;
        }
        this.lastPt = null;
        this.smoothPt = null;
        this.paintFilmThumb(this.frameIndex);
        break;
      }
      case "warp": {
        // M10-2c: 四隅はハンドルを離すだけ。確定は Enter なので履歴を積まない
        if (this.warpMode === "corner") {
          this.cornerDrag = null;
          break;
        }
        // M10-2b: 連続適用タイマーを最優先で止める（pointercancel もこの経路を通る）
        this.clearFisheyeRepeat();
        this.warpCenter = null;
        const field = this.warpField;
        const before = this.warpBefore;
        this.warpField = null;
        this.warpBefore = null;
        this.warpLastPt = null;
        if (!field || !before) break;
        // 1画素も動いていなければ履歴を積まない（強さ0・クリックのみ）
        if (field.isIdentity()) break;
        const f = this.project.frames[this.frameIndex];
        if (!f) break;
        // **変化のあったレイヤーだけ** before/after を積む（メモリ節約）。
        // 透明なレイヤーや変位が届かなかったレイヤーは1バイトも記録しない
        const beforeDiff: Record<string, IndexBuf> = {};
        const afterDiff: Record<string, IndexBuf> = {};
        for (const ld of this.project.layerDefs) {
          const b = before[ld.id];
          const a = f.layers[ld.id];
          if (!b || !a) continue;
          let changed = false;
          for (let i = 0; i < b.length; i++) {
            if (b[i] !== a[i]) {
              changed = true;
              break;
            }
          }
          if (!changed) continue;
          beforeDiff[ld.id] = b;
          afterDiff[ld.id] = copyIndexBuf(a);
        }
        if (Object.keys(afterDiff).length === 0) break;
        // ストローク1回＝履歴1エントリ。実体は適用時に解決する（構造undo対策）
        this.history.push(
          multiBufferChangeEntry(
            "歪み",
            (layerId) => this.project.frames[this.frameIndex]?.layers[layerId] ?? null,
            beforeDiff,
            afterDiff,
            () => {
              // M10-23: Undo/Redo もデータ変更なので dirty にする（四隅変形と同じ）
              this.dirty = true;
              this.renderCanvas();
              this.paintFilmThumb(this.frameIndex);
            }
          )
        );
        this.dirty = true;
        this.renderCanvas();
        this.paintFilmThumb(this.frameIndex);
        break;
      }
      case "shape": {
        if (!this.shapeStart) break;
        // M10-7: プレビューと**同一のヘルパー**で終点を出す（形がズレないように）
        const end = this.shapeEnd(pt);
        // 色解決が昇格でバッファを差し替え得るため、penOptions を先に解決
        const o = this.penOptions(0.5);
        const buf = this.activeBuffer();
        if (buf) {
          const before = copyIndexBuf(buf);
          if (this.shapeKind === "line")
            R.shapeLine(buf, this.shapeStart.x, this.shapeStart.y, end.x, end.y, o);
          else if (this.shapeKind === "rect")
            R.shapeRect(buf, this.shapeStart.x, this.shapeStart.y, end.x, end.y, o, this.shapeFill);
          else
            R.shapeEllipse(
              buf,
              this.shapeStart.x,
              this.shapeStart.y,
              end.x,
              end.y,
              o,
              this.shapeFill
            );
          this.pushBufferHistory("図形", buf, before);
        }
        this.shapeStart = null;
        this.shapeLastPt = null;
        this.overlayCtx().clearRect(0, 0, W, H);
        this.renderCanvas();
        this.paintFilmThumb(this.frameIndex);
        break;
      }
      case "select": {
        if (this.dragMode === "selmove") {
          this.commitSelectionMove();
        } else if (this.selectKind === "rect" && this.shapeStart) {
          // M10-22: 選択の作成・置換を履歴へ（before=直前のマスク・null許容）
          const selBefore = this.selMask ? this.selMask.slice() : null;
          if (this.shapeStart.x === pt.x && this.shapeStart.y === pt.y) {
            // ドラッグなしの素クリック＝選択解除（1pxの見えない選択が clip で
            // 全描画を無音で封じる事故の防止。マーキー系ツールの標準挙動でもある）
            if (selBefore) this.pushSelectionHistory("選択解除", selBefore, null);
            this.selMask = null;
          } else {
            this.selMask = R.rectMask(this.shapeStart.x, this.shapeStart.y, pt.x, pt.y);
            this.pushSelectionHistory("範囲選択", selBefore, this.selMask.slice());
          }
          this.shapeStart = null;
          this.redrawOverlay();
        } else if (this.selectKind === "lasso" && this.lassoPts.length > 2) {
          const selBefore = this.selMask ? this.selMask.slice() : null;
          const lm = R.lassoMask(this.lassoPts);
          if (lm.some((v) => v !== 0)) {
            this.selMask = lm;
            this.pushSelectionHistory("範囲選択", selBefore, this.selMask.slice());
          } else {
            // 囲めていない軌跡（面積ゼロ）＝選択解除（全0マスクはアンツが1画素も
            // 出ず、clip で描けない原因が見えなくなるため選択として扱わない）
            if (selBefore) this.pushSelectionHistory("選択解除", selBefore, null);
            this.selMask = null;
          }
          this.lassoPts = [];
          this.redrawOverlay();
        } else {
          this.lassoPts = [];
          this.redrawOverlay();
        }
        break;
      }
    }
  }

  /**
   * M10-7: Shift 拘束をかけた終点を返す。**プレビューと確定の両方がこれを通る**
   * （別々に計算すると、見えていた形と焼き込まれる形がズレる）。
   *
   * - rect / ellipse: 縦横のドラッグ量の**長いほう**に合わせた正方形／正円
   * - line: 45°刻みの8方向へスナップ（長さはドラッグ距離を保つ）
   * - 幅ゼロ（クリック1点）は素通し。既存の1ドットフォールバックを壊さない
   */
  private constrainShapeEnd(
    a: { x: number; y: number },
    b: { x: number; y: number },
    kind: ShapeKind
  ): { x: number; y: number } {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) return b;
    if (kind === "line") {
      const r = Math.hypot(dx, dy);
      const step = Math.PI / 4;
      const ang = Math.round(Math.atan2(dy, dx) / step) * step;
      return {
        x: a.x + Math.round(r * Math.cos(ang)),
        y: a.y + Math.round(r * Math.sin(ang)),
      };
    }
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + (dx < 0 ? -m : m), y: a.y + (dy < 0 ? -m : m) };
  }

  /** M10-7: Shift 状態を反映した図形の終点。プレビュー・確定の共通入口 */
  private shapeEnd(b: { x: number; y: number }): { x: number; y: number } {
    if (!this.shiftHeld || !this.shapeStart) return b;
    return this.constrainShapeEnd(this.shapeStart, b, this.shapeKind);
  }

  /** M10-7: ドラッグ中に Shift が押された/離されたときだけプレビューを引き直す。
   *  図形ツールでドラッグ中でなければ**何もしない**（他の Shift 機能に干渉しない） */
  private refreshShapePreview(): void {
    if (this.tool !== "shape" || !this.pointerDown) return;
    if (!this.shapeStart || !this.shapeLastPt) return;
    this.previewShape(this.shapeStart, this.shapeEnd(this.shapeLastPt));
  }

  private previewShape(a: { x: number; y: number }, b: { x: number; y: number }) {
    const ctx = this.overlayCtx();
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(240,122,26,.9)";
    ctx.lineWidth = 1;
    if (this.shapeKind === "line") {
      ctx.beginPath();
      ctx.moveTo(a.x + 0.5, a.y + 0.5);
      ctx.lineTo(b.x + 0.5, b.y + 0.5);
      ctx.stroke();
    } else if (this.shapeKind === "rect") {
      ctx.strokeRect(
        Math.min(a.x, b.x) + 0.5,
        Math.min(a.y, b.y) + 0.5,
        Math.abs(b.x - a.x),
        Math.abs(b.y - a.y)
      );
    } else {
      ctx.beginPath();
      ctx.ellipse(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        Math.abs(b.x - a.x) / 2,
        Math.abs(b.y - a.y) / 2,
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
  }

  private previewSelectRect(a: { x: number; y: number }, b: { x: number; y: number }) {
    const ctx = this.overlayCtx();
    ctx.clearRect(0, 0, W, H);
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = "rgba(44,38,33,.9)";
    ctx.strokeRect(
      Math.min(a.x, b.x) + 0.5,
      Math.min(a.y, b.y) + 0.5,
      Math.abs(b.x - a.x),
      Math.abs(b.y - a.y)
    );
    ctx.setLineDash([]);
  }

  // ---------------- 選択の移動/コピー ----------------

  private selMoveBefore: IndexBuf | null = null;

  private beginSelectionMove(pt: { x: number; y: number }) {
    const buf = this.activeBuffer();
    if (!buf || !this.selMask) return;
    this.selMoveBefore = copyIndexBuf(buf);
    this.floatBuf = R.extractFloat(buf, this.selMask, true);
    if (!this.floatBuf) {
      this.selMoveBefore = null;
      return;
    }
    this.xform = { tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, flipH: false, flipV: false };
    this.dragMode = "selmove";
    this.dragStart = pt;
    this.renderCanvas();
    this.redrawSelMovePreview();
  }

  private updateSelectionMove(pt: { x: number; y: number }) {
    if (!this.dragStart) return;
    this.xform.tx = pt.x - this.dragStart.x;
    this.xform.ty = pt.y - this.dragStart.y;
    this.redrawSelMovePreview();
  }

  private redrawSelMovePreview() {
    const ctx = this.overlayCtx();
    ctx.clearRect(0, 0, W, H);
    if (!this.floatBuf) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.floatToCanvas(this.floatBuf),
      this.floatBuf.ox + this.xform.tx,
      this.floatBuf.oy + this.xform.ty
    );
  }

  private commitSelectionMove() {
    const buf = this.activeBuffer();
    this.dragMode = "";
    if (!buf || !this.floatBuf || !this.selMoveBefore) return;
    R.blitFloatTransformed(buf, this.floatBuf, this.xform);
    // 選択マスクも移動（M10-22: 履歴に合成するため先に after を作ってから1エントリで積む）
    const selBefore = this.selMask ? this.selMask.slice() : null;
    const dx = Math.round(this.xform.tx);
    const dy = Math.round(this.xform.ty);
    if (this.selMask) {
      const nm = new Uint8Array(PIXELS);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (this.selMask[y * W + x]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) nm[ny * W + nx] = 1;
          }
      this.selMask = nm;
    }
    // M10-22: 画素とマスク位置を1エントリに束ねる（Ctrl+Z 1回で両方戻る）
    this.pushBufferHistory("選択移動", buf, this.selMoveBefore, {
      before: selBefore,
      after: this.selMask ? this.selMask.slice() : null,
    });
    this.floatBuf = null;
    this.selMoveBefore = null;
    this.overlayCtx().clearRect(0, 0, W, H);
    this.renderCanvas();
    this.redrawOverlay();
    this.paintFilmThumb(this.frameIndex);
  }

  private copySelection(cut: boolean) {
    const buf = this.activeBuffer();
    if (!buf || !this.selMask) {
      this.cb.toast("先に範囲を選択してください");
      return;
    }
    const before = cut ? copyIndexBuf(buf) : null;
    const f = R.extractFloat(buf, this.selMask, cut);
    if (!f) return;
    Editor.clipboard = f;
    if (cut && before) {
      // M10-22: マスク自体は切り取りで変化しないが、undo/redo でその時点の選択状態へ
      // 揃うように（時系列の一貫性）バッファと同じ1エントリに束ねる
      const selNow = this.selMask ? this.selMask.slice() : null;
      this.pushBufferHistory("切り取り", buf, before, { before: selNow, after: selNow });
      this.renderCanvas();
      this.paintFilmThumb(this.frameIndex);
    }
    this.cb.toast(cut ? "切り取りました" : "コピーしました");
  }

  private pasteClipboard() {
    if (!Editor.clipboard) {
      this.cb.toast("クリップボードが空です");
      return;
    }
    // 16bitプロジェクト由来のクリップボード（索引255超を含み得る）を8bitプロジェクトへ
    // 貼る場合は、truncate を避けるため先にプロジェクトを昇格させる
    if (
      Editor.clipboard.data instanceof Uint16Array &&
      this.project.indexBits === 8 &&
      Editor.clipboard.data.some((v) => v > 255)
    ) {
      promoteTo16(this.project);
      this.cb.toast("パレットを拡張しました（最大65,536色・高精細モード）");
      this.dirty = true;
    }
    // 貼り付け → 変形モードで位置決め
    this.floatBuf = {
      ...Editor.clipboard,
      data: copyIndexBuf(Editor.clipboard.data),
    };
    this.selMask = null;
    this.xform = { tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, flipH: false, flipV: false };
    this.xformInitial = { ...this.xform }; // L-B
    this.xformActive = true;
    this.xformBefore = copyIndexBuf(this.activeBuffer()!);
    this.xformCutDone = false;
    this.tool = "transform";
    this.updateToolButtons();
    this.buildToolOptions();
    this.redrawOverlay();
  }

  // ---------------- M8-2: 📷 画像配置（変換結果→浮動→変形経路を流用） ----------------

  /** モーダルの「配置先: …」表示用（アクティブレイヤー名＋現在コマ番号） */
  placementInfo(): { layerName: string; frameNo: number } {
    const ld = this.project.layerDefs.find((l) => l.id === this.activeLayerId);
    return { layerName: ld?.name ?? "（レイヤーなし）", frameNo: this.frameIndex + 1 };
  }

  /** 変換済み1ページ（imageConvert の出力 Project）をアクティブレイヤーへ浮動配置する。
   *  色索引の不変条件（N-2/M3.3 の作法）:
   *  ①使用色の ensureColor を**全部先に**済ませる（途中で16bit昇格し得るため）
   *  ②昇格後の幅で allocIndexBuf → remap 書き込み
   *  ③あとは pasteClipboard と同一の浮動＋変形モード（Enter焼き込み/Esc/Undo規則は既存のまま） */
  placeConvertedImage(src: Project, transparentPaper: boolean) {
    const active = this.activeBuffer();
    if (!active) {
      this.cb.toast("配置先のレイヤーがありません");
      return;
    }
    if (this.xformActive) {
      this.cb.toast("変形中です。Enterで確定（Escで取消）してから配置してください");
      return;
    }
    const srcBuf = src.frames[0].layers["L1"];
    const paperHex = (src.colorTable[src.frames[0].paper] || "#ffffff").toLowerCase();
    // ① 色解決を全部先に（透過ONなら紙色一致の画素は登録しない＝パレット汚染防止）
    const used = new Set<number>();
    for (let i = 0; i < PIXELS; i++) if (srcBuf[i] > 0) used.add(srcBuf[i] as number);
    const bitsBefore = this.project.indexBits;
    const map = new Map<number, number>();
    for (const si of used) {
      const hex = src.colorTable[si].toLowerCase();
      if (transparentPaper && hex === paperHex) continue; // 透明化されるので登録不要
      map.set(si, ensureColor(this.project, hex));
    }
    let paperIdx = 0;
    if (!transparentPaper) paperIdx = ensureColor(this.project, paperHex);
    if (bitsBefore === 8 && this.project.indexBits === 16) {
      this.cb.toast("パレットを拡張しました（最大65,536色・高精細モード）");
      this.dirty = true;
    }
    // ② 昇格後の幅でバッファ確保 → remap（index0=透明は FloatBuf の透明と同義）
    const data = allocIndexBuf(this.project);
    for (let i = 0; i < PIXELS; i++) {
      const si = srcBuf[i] as number;
      if (si > 0) data[i] = map.get(si) ?? 0; // 紙色一致（透過ON）は 0
      else data[i] = paperIdx; // 透過ON時は 0 のまま
    }
    // ③ 浮動＋変形モード（pasteClipboard と同一の状態遷移）
    this.floatBuf = { w: W, h: H, ox: 0, oy: 0, data };
    this.selMask = null;
    this.xform = { tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, flipH: false, flipV: false };
    this.xformInitial = { ...this.xform };
    this.xformActive = true;
    this.xformBefore = copyIndexBuf(this.activeBuffer()!);
    this.xformCutDone = false;
    this.tool = "transform";
    this.updateToolButtons();
    this.buildToolOptions();
    this.redrawOverlay();
    this.cb.toast("配置しました — ドラッグで移動・Enterで確定・Escで取消");
  }

  private deleteSelection() {
    const buf = this.activeBuffer();
    if (!buf || !this.selMask) return;
    const before = copyIndexBuf(buf);
    R.deleteMasked(buf, this.selMask);
    // M10-22: 画素の削除とマスク解除を1エントリに束ねる（Ctrl+Z 1回で両方戻る）
    this.pushBufferHistory("選択削除", buf, before, {
      before: this.selMask.slice(),
      after: null,
    });
    this.selMask = null;
    this.renderCanvas();
    this.redrawOverlay();
    this.paintFilmThumb(this.frameIndex);
  }

  // ---------------- 変形 ----------------

  private xformBefore: IndexBuf | null = null;
  private xformCutDone = false;
  /** M3.8 L-B: 変形モード開始時のパラメータ（Ctrl+Zリセットの戻し先） */
  private xformInitial: R.Transform | null = null;

  /** M3.8 L-B: Ctrl+Z / ↶。変形・浮動中はグローバル履歴に絶対に通さない */
  private handleUndo() {
    if (this.xformActive) {
      const init = this.xformInitial ?? {
        tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, flipH: false, flipV: false,
      };
      const dirty =
        this.xform.tx !== init.tx ||
        this.xform.ty !== init.ty ||
        this.xform.angle !== init.angle ||
        this.xform.sx !== init.sx ||
        this.xform.sy !== init.sy ||
        this.xform.flipH !== init.flipH ||
        this.xform.flipV !== init.flipV;
      if (dirty) {
        // 変更あり → パラメータをモード開始時にリセット（モードは維持）
        this.xform = { ...init };
        this.redrawOverlay();
        this.buildToolOptions(); // 数値表示更新
        this.cb.toast("変形をリセットしました");
      } else {
        // 変更なし → モード解除（キャンセルと同じ）
        this.cancelTransform();
      }
      return;
    }
    if (this.cornerActive) {
      // M10-2c: transform と同じ流儀。動かしていれば四隅リセット・未変更なら解除
      const r = this.cornerRect;
      const home = r
        ? [
            { x: r.x0, y: r.y0 },
            { x: r.x1, y: r.y0 },
            { x: r.x1, y: r.y1 },
            { x: r.x0, y: r.y1 },
          ]
        : null;
      const dirty =
        !!home &&
        this.cornerPts.some((p, i) => p.x !== home[i].x || p.y !== home[i].y);
      if (dirty && home) {
        this.cornerPts = home;
        this.updateCornerPreview();
        this.cb.toast("四隅をリセットしました");
      } else {
        this.cancelCornerWarp();
      }
      return;
    }
    if (this.floatBuf) {
      // 選択移動の浮動中 → 浮動キャンセル（元位置に戻す）
      this.cancelSelectionMove();
      return;
    }
    this.history.undo();
  }

  /** M3.8 L-B: Ctrl+Y / ↷。変形・浮動中は無効 */
  private handleRedo() {
    if (this.xformActive || this.floatBuf || this.cornerActive) {
      this.cb.toast("変形中はやり直しできません");
      return;
    }
    this.history.redo();
  }

  /** M3.8 L-B: 選択移動の浮動をキャンセルして元位置に戻す（履歴には触れない） */
  private cancelSelectionMove() {
    const buf = this.activeBuffer();
    if (buf && this.selMoveBefore) buf.set(this.selMoveBefore);
    this.selMoveBefore = null;
    this.floatBuf = null;
    this.dragMode = "";
    this.overlayCtx().clearRect(0, 0, W, H);
    this.renderCanvas();
    this.redrawOverlay();
  }

  /** E-4: 変形/浮動中は他操作をロック（true=ブロックした） */
  private xformGuard(): boolean {
    if (this.xformActive || this.floatBuf || this.cornerActive) {
      this.cb.toast("変形を確定（Enter）またはキャンセル（Esc）してください");
      return true;
    }
    return false;
  }

  private updateXformBadge() {
    const on = this.xformActive || this.cornerActive; // M10-2c: 四隅変形も「変形中」
    const b = document.querySelector("#ed-xform-badge") as HTMLElement | null;
    if (b) b.hidden = !on;
    // M3.8 L-B: 変形中は ↶=リセット/解除として常に押せる・↷=無効。解除時は履歴状態に戻す
    const ub = document.querySelector("#ed-undo") as HTMLButtonElement | null;
    const rb = document.querySelector("#ed-redo") as HTMLButtonElement | null;
    if (ub && rb) {
      if (on) {
        ub.disabled = false;
        rb.disabled = true;
      } else {
        ub.disabled = !this.history.canUndo;
        rb.disabled = !this.history.canRedo;
      }
    }
  }

  private beginTransform() {
    const buf = this.activeBuffer();
    if (!buf) return;
    if (this.xformActive) return;
    this.xformBefore = copyIndexBuf(buf);
    let mask = this.selMask;
    if (!mask) {
      // 選択が無ければレイヤー全体（これは 0/1 マスク。索引ではないので Uint8Array のまま）
      mask = new Uint8Array(PIXELS);
      for (let i = 0; i < PIXELS; i++) if (buf[i] !== 0) mask[i] = 1;
    }
    this.floatBuf = R.extractFloat(buf, mask, true);
    this.xformCutDone = true;
    if (!this.floatBuf) {
      buf.set(this.xformBefore);
      this.xformBefore = null;
      this.xformCutDone = false;
      this.cb.toast("変形する内容がありません");
      this.tool = this.prevTool;
      this.updateToolButtons();
      return;
    }
    this.xform = { tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, flipH: false, flipV: false };
    this.xformInitial = { ...this.xform }; // L-B: Ctrl+Zリセットの戻し先
    this.xformActive = true;
    this.updateXformBadge();
    this.renderCanvas();
    this.redrawOverlay();
  }

  /** M6-5 Q-4: 変形ハンドルの2段ヒットテスト（発注者確定仕様）。
   *  四隅の□（±6ドット）=拡縮 / □の少し外側リング（□から+20ドットまで）=回転 /
   *  上辺中央の棒付き□=回転（残置・共存） / 枠内=移動 / それ以外=何もしない。
   *  単位はキャンバスのドット（表示倍率に応じて描画ハンドルと相似にスケール）。
   *  座標は枠のローカル系（逆回転）で判定するので、回転後も□の位置と一致する。 */
  private xformHitTest(pt: { x: number; y: number }): {
    mode: "" | "move" | "scale" | "rotate";
    cursor: string;
  } {
    const f = this.floatBuf;
    if (!f) return { mode: "", cursor: "" };
    const t = this.xform;
    const cx = f.ox + f.w / 2 + t.tx;
    const cy = f.oy + f.h / 2 + t.ty;
    const hw = Math.abs((f.w / 2) * t.sx);
    const hh = Math.abs((f.h / 2) * t.sy);
    const cos = Math.cos(t.angle);
    const sin = Math.sin(t.angle);
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const HIT = 6; // □の当たり半径（ドット）
    const RING = 20; // □の外側の回転ゾーン幅（ドット）
    let best = Infinity;
    let bestCorner: readonly [number, number] = [hw, hh];
    for (const c of [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ] as const) {
      const d = Math.hypot(lx - c[0], ly - c[1]);
      if (d < best) {
        best = d;
        bestCorner = c;
      }
    }
    if (best <= HIT) {
      // カーソル向きは回転後のグローバル方位で選ぶ（↖↘=nwse / ↗↙=nesw）
      const ga = Math.atan2(bestCorner[1], bestCorner[0]) + t.angle;
      const deg = ((((ga * 180) / Math.PI) % 180) + 180) % 180;
      return { mode: "scale", cursor: deg < 90 ? "nwse-resize" : "nesw-resize" };
    }
    if (Math.hypot(lx, ly - (-hh - 12)) <= HIT)
      return { mode: "rotate", cursor: ROTATE_CURSOR }; // 上辺中央の棒付き□
    if (best <= HIT + RING) return { mode: "rotate", cursor: ROTATE_CURSOR };
    if (Math.abs(lx) <= hw && Math.abs(ly) <= hh)
      return { mode: "move", cursor: "move" };
    return { mode: "", cursor: "" };
  }

  /** M6-6 R-2: 変形モードラベル（「⤡ 拡縮」「⟳ 回転」をカーソル追従で表示）。
   *  ペン入力ではOSのペンポインタが優先されCSSカーソルが見えないため、カーソルに頼らない補助。
   *  回転で歪まないよう #ed-stage（cvwrap の transform の外）に置く。 */
  private xmodeLabelEl: HTMLElement | null = null;
  private showXformModeLabel(mode: string, clientX: number, clientY: number) {
    const text = mode === "scale" ? "⤡ 拡縮" : mode === "rotate" ? "⟳ 回転" : "";
    if (!text) {
      this.hideXformModeLabel();
      return;
    }
    const stage = document.querySelector("#ed-stage") as HTMLElement | null;
    if (!stage) return;
    let el = this.xmodeLabelEl;
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      el.className = "xmode-label";
      stage.appendChild(el);
      this.xmodeLabelEl = el;
    }
    el.textContent = text;
    const r = stage.getBoundingClientRect();
    el.style.left = `${clientX - r.left + stage.scrollLeft + 16}px`;
    el.style.top = `${clientY - r.top + stage.scrollTop + 20}px`;
  }

  private hideXformModeLabel() {
    this.xmodeLabelEl?.remove();
    this.xmodeLabelEl = null;
  }

  /** E-3: 変形中のホバーカーソル（□=拡縮リサイズ / □の外側=grab / 枠内=move）＋モードラベル */
  private updateXformHoverCursor(e: PointerEvent) {
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (!wrap || !this.floatBuf) return;
    const pt = this.clientToPixel(e.clientX, e.clientY);
    const hit = this.xformHitTest(pt);
    wrap.style.cursor = hit.cursor;
    this.showXformModeLabel(hit.mode, e.clientX, e.clientY);
  }

  private beginTransformDrag(pt: { x: number; y: number }) {
    if (!this.floatBuf) return;
    this.dragStart = pt;
    this.dragBase = { ...this.xform };
    // Q-4: ヒットしない場所からのドラッグは何もしない（意図しないモード切替の防止）
    const hit = this.xformHitTest(pt);
    this.dragMode = hit.mode || "";
    // R-2: 掴んだ瞬間からモードが分かるようカーソルも更新（回転中は grabbing）
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (wrap) wrap.style.cursor = hit.mode === "rotate" ? "grabbing" : hit.cursor;
  }

  private updateTransformDrag(pt: { x: number; y: number }, shiftKey = false) {
    if (!this.dragStart || !this.dragBase || !this.floatBuf) return;
    const f = this.floatBuf;
    const cx = f.ox + f.w / 2 + this.dragBase.tx;
    const cy = f.oy + f.h / 2 + this.dragBase.ty;
    if (this.dragMode === "move") {
      this.xform.tx = this.dragBase.tx + (pt.x - this.dragStart.x);
      this.xform.ty = this.dragBase.ty + (pt.y - this.dragStart.y);
    } else if (this.dragMode === "scale") {
      const r0 = Math.hypot(this.dragStart.x - cx, this.dragStart.y - cy);
      const r1 = Math.hypot(pt.x - cx, pt.y - cy);
      const s = Math.max(0.05, (r1 / Math.max(1, r0)) * this.dragBase.sx);
      this.xform.sx = s;
      this.xform.sy = Math.max(0.05, (r1 / Math.max(1, r0)) * this.dragBase.sy);
    } else if (this.dragMode === "rotate") {
      const a0 = Math.atan2(this.dragStart.y - cy, this.dragStart.x - cx);
      const a1 = Math.atan2(pt.y - cy, pt.x - cx);
      let ang = this.dragBase.angle + (a1 - a0);
      // E-3: 自由回転＋Shift押下中は15°刻み（既存スナップトグルとも共存）
      if (this.snap15 || shiftKey) {
        const step = (15 * Math.PI) / 180;
        ang = Math.round(ang / step) * step;
      }
      this.xform.angle = ang;
    }
    this.redrawOverlay();
  }

  private commitTransform() {
    const buf = this.activeBuffer();
    if (!buf || !this.floatBuf || !this.xformBefore) return;
    R.blitFloatTransformed(buf, this.floatBuf, this.xform);
    // M10-22: 変形確定は endTransform で selMask が消えるため、画素とマスク解除を
    // 1エントリに束ねる（選択なし変形では before/after とも null＝実質従来どおり）
    this.pushBufferHistory("変形", buf, this.xformBefore, {
      before: this.selMask ? this.selMask.slice() : null,
      after: null,
    });
    this.endTransform();
    this.paintFilmThumb(this.frameIndex);
  }

  private cancelTransform() {
    const buf = this.activeBuffer();
    if (buf && this.xformBefore && this.xformCutDone) buf.set(this.xformBefore);
    this.endTransform();
  }

  private endTransform() {
    this.xformActive = false;
    this.xformInitial = null; // L-B
    this.updateXformBadge();
    this.hideXformModeLabel(); // R-2
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (wrap) wrap.style.cursor = "";
    this.xformBefore = null;
    this.xformCutDone = false;
    this.floatBuf = null;
    this.selMask = null;
    this.overlayCtx().clearRect(0, 0, W, H);
    this.renderCanvas();
    if (this.tool === "transform") {
      this.tool = "pen";
      this.updateToolButtons();
      this.buildToolOptions();
    }
  }

  // ---------------- 文字/スポイト/紙色/複写/消す ----------------

  /** M10-1c: 現在の文字設定（永続化用） */
  textSettings(): TextSettings {
    return {
      family: this.textFamily,
      size: this.textSize,
      bold: this.textBold,
      vertical: this.textVertical,
    };
  }

  /** M10-1c: settings.json から復元する。未知の値は fonts.ts 側で既定へ落とされる */
  restoreTextSettings(
    v: { family?: string; size?: number; bold?: boolean; vertical?: boolean } | null | undefined
  ) {
    const s = sanitizeTextSettings(v);
    this.textFamily = s.family;
    this.textSize = s.size;
    this.textBold = s.bold;
    this.textVertical = s.vertical;
  }

  private async placeText(pt: { x: number; y: number }) {
    // M10-1c: @font-face は遅延ロードなので、measureText より前に**明示的に**ロードを待つ。
    // これが無いと起動直後の1回目だけ幅がずれる（document.fonts.ready だけでは待たない）。
    await ensureFontsLoaded();
    const text = await this.cb.prompt("入力する文字", "");
    if (!text) return;
    const mask = R.textToMask(text, this.textSize, {
      family: this.textFamily,
      bold: this.textBold,
      vertical: this.textVertical, // M10-11
    });
    if (!mask) return;
    // 色解決（昇格でバッファ差し替えあり）→ バッファ取得の順を守る
    const color = this.currentColorIndex();
    const buf = this.activeBuffer();
    if (!buf) return;
    const before = copyIndexBuf(buf);
    R.stampMask(buf, mask, pt.x, pt.y, color, this.selMask ?? undefined);
    this.pushBufferHistory("文字", buf, before);
    this.renderCanvas();
    this.paintFilmThumb(this.frameIndex);
  }

  private pickColor(pt: { x: number; y: number }) {
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    const i = pt.y * W + pt.x;
    // 上のレイヤーから順に
    for (let L = this.project.layerDefs.length - 1; L >= 0; L--) {
      const ld = this.project.layerDefs[L];
      if (!ld.visible) continue;
      const v = f.layers[ld.id]?.[i] ?? 0;
      if (v !== 0) {
        this.colorHex = this.project.colorTable[v];
        this.rebuildPalette();
        this.setTool(this.prevTool === "eyedrop" ? "pen" : this.prevTool);
        this.logPick(pt, `layer=${ld.id} idx=${v}`);
        return;
      }
    }
    this.colorHex = this.project.colorTable[f.paper];
    this.rebuildPalette();
    this.setTool(this.prevTool === "eyedrop" ? "pen" : this.prevTool);
    this.logPick(pt, "paper");
  }

  /** M10-21: pickColor 到達と解決色の診断ログ（フラグ時のみ。通常は即 return） */
  private logPick(pt: { x: number; y: number }, src: string) {
    if (!this.inputLog) return;
    this.inputLogBuf.push(
      `[inputlog] pickColor (${pt.x},${pt.y}) ${src} -> ${this.colorHex || "(?)"} tool→${this.tool}`
    );
    this.flushInputLogSoon();
  }

  private setPaper(hex: string) {
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    const oldPaper = f.paper;
    const bitsBefore = this.project.indexBits;
    const newPaper = ensureColor(this.project, hex);
    if (bitsBefore === 8 && this.project.indexBits === 16) {
      this.cb.toast("パレットを拡張しました（最大65,536色・高精細モード）");
    }
    if (oldPaper === newPaper) return;
    const fi = this.frameIndex;
    const self = this;
    this.history.push({
      label: "紙色",
      undo() {
        self.project.frames[fi].paper = oldPaper;
        self.afterStructuralChange();
      },
      redo() {
        self.project.frames[fi].paper = newPaper;
        self.afterStructuralChange();
      },
    });
    f.paper = newPaper;
    this.afterStructuralChange();
  }

  private copyPrevFrame() {
    if (this.frameIndex === 0) {
      this.cb.toast("先頭のコマには複写元がありません");
      return;
    }
    const cur = this.project.frames[this.frameIndex];
    const prev = this.project.frames[this.frameIndex - 1];
    const beforeLayers: Record<string, IndexBuf> = {};
    for (const [k, v] of Object.entries(cur.layers)) beforeLayers[k] = copyIndexBuf(v);
    const beforePaper = cur.paper;
    for (const ld of this.project.layerDefs) {
      const src = prev.layers[ld.id];
      const dst = cur.layers[ld.id];
      if (src && dst) dst.set(src);
    }
    cur.paper = prev.paper;
    const afterLayers: Record<string, IndexBuf> = {};
    for (const [k, v] of Object.entries(cur.layers)) afterLayers[k] = copyIndexBuf(v);
    const afterPaper = cur.paper;
    const self = this;
    const fi = this.frameIndex;
    this.history.push({
      label: "複写",
      undo() {
        const f = self.project.frames[fi];
        for (const [k, v] of Object.entries(beforeLayers)) f.layers[k]?.set(v);
        f.paper = beforePaper;
        self.afterStructuralChange();
      },
      redo() {
        const f = self.project.frames[fi];
        for (const [k, v] of Object.entries(afterLayers)) f.layers[k]?.set(v);
        f.paper = afterPaper;
        self.afterStructuralChange();
      },
    });
    this.afterStructuralChange();
    this.cb.toast("前のコマを複写しました");
  }

  private async clearFrame() {
    const ok = await this.cb.confirm("このコマを全消ししますか？");
    if (!ok) return;
    const cur = this.project.frames[this.frameIndex];
    const beforeLayers: Record<string, IndexBuf> = {};
    for (const [k, v] of Object.entries(cur.layers)) beforeLayers[k] = copyIndexBuf(v);
    for (const v of Object.values(cur.layers)) v.fill(0);
    const self = this;
    const fi = this.frameIndex;
    this.history.push({
      label: "全消し",
      undo() {
        const f = self.project.frames[fi];
        for (const [k, v] of Object.entries(beforeLayers)) f.layers[k]?.set(v);
        self.afterStructuralChange();
      },
      redo() {
        const f = self.project.frames[fi];
        for (const v of Object.values(f.layers)) v.fill(0);
        self.afterStructuralChange();
      },
    });
    this.afterStructuralChange();
  }

  // ---------------- レイヤー操作 ----------------

  private addLayer() {
    if (this.xformGuard()) return; // E-4
    const id = newLayerId(this.project);
    const idx = this.project.layerDefs.findIndex((l) => l.id === this.activeLayerId);
    // M3.7: 選択中フォルダ（実在するもののみ）の中 or 選択レイヤーと同じ親に作成
    // （Codexレビュー指摘#2/#3: stale な selectedFolderId を parent に採用しない・
    //  フォルダ内作成時は既存ブロック末尾へ挿入して連続性を守る）
    const selFolder = this.selectedFolderId
      ? this.folderById(this.selectedFolderId)
      : undefined;
    const def: LayerDef = {
      id,
      name: `レイヤー${this.project.layerDefs.length + 1}`,
      visible: true,
      opacity: 1,
      parent: selFolder
        ? selFolder.id
        : this.project.layerDefs.find((l) => l.id === this.activeLayerId)?.parent,
    };
    let insertAt = idx >= 0 ? idx + 1 : this.project.layerDefs.length;
    if (selFolder) {
      const members = this.folderLayerIndices(selFolder.id);
      if (members.length > 0) insertAt = members[members.length - 1] + 1;
    }
    const self = this;
    const apply = () => {
      self.project.layerDefs.splice(insertAt, 0, def);
      for (const f of self.project.frames) {
        f.layers[id] = allocIndexBuf(self.project);
        // コマ固有描画順があれば最上位に追加
        if (f.order) f.order.push(id);
      }
      self.activeLayerId = id;
      self.afterLayerChange();
    };
    const revert = () => {
      const i = self.project.layerDefs.findIndex((l) => l.id === id);
      if (i >= 0) self.project.layerDefs.splice(i, 1);
      for (const f of self.project.frames) {
        delete f.layers[id];
        if (f.order) f.order = f.order.filter((x) => x !== id);
      }
      if (self.activeLayerId === id)
        self.activeLayerId = self.project.layerDefs[self.project.layerDefs.length - 1]?.id ?? "";
      self.afterLayerChange();
    };
    this.history.push({ label: "レイヤー追加", undo: revert, redo: apply });
    apply();
  }

  private async deleteLayer() {
    if (this.xformGuard()) return; // E-4
    if (this.project.layerDefs.length <= 1) {
      this.cb.toast("最後のレイヤーは削除できません");
      return;
    }
    const idx = this.project.layerDefs.findIndex((l) => l.id === this.activeLayerId);
    if (idx < 0) return;
    const def = this.project.layerDefs[idx];
    const ok = await this.cb.confirm(`「${def.name}」を削除しますか？（全コマから消えます）`);
    if (!ok) return;
    const saved: IndexBuf[] = this.project.frames.map((f) =>
      copyIndexBuf(f.layers[def.id] ?? allocIndexBuf(this.project))
    );
    const savedOrders = this.project.frames.map((f) => (f.order ? [...f.order] : undefined));
    const self = this;
    const apply = () => {
      const i = self.project.layerDefs.findIndex((l) => l.id === def.id);
      if (i >= 0) self.project.layerDefs.splice(i, 1);
      for (const f of self.project.frames) {
        delete f.layers[def.id];
        if (f.order) f.order = f.order.filter((x) => x !== def.id);
      }
      self.activeLayerId = self.project.layerDefs[Math.max(0, i - 1)]?.id ?? "";
      self.afterLayerChange();
    };
    const revert = () => {
      self.project.layerDefs.splice(idx, 0, def);
      self.project.frames.forEach((f, fi) => {
        // 削除後にプロジェクトが16bit昇格していても幅が揃うよう、現在幅で確保して復元
        const nb = allocIndexBuf(self.project);
        nb.set(saved[fi]);
        f.layers[def.id] = nb;
        f.order = savedOrders[fi] ? [...savedOrders[fi]!] : undefined;
      });
      self.activeLayerId = def.id;
      self.afterLayerChange();
    };
    this.history.push({ label: "レイヤー削除", undo: revert, redo: apply });
    apply();
  }

  private mergeLayerDown() {
    if (this.xformGuard()) return; // E-4
    const idx = this.project.layerDefs.findIndex((l) => l.id === this.activeLayerId);
    if (idx <= 0) {
      this.cb.toast("いちばん下のレイヤーです（統合先がありません）");
      return;
    }
    const top = this.project.layerDefs[idx];
    const bottom = this.project.layerDefs[idx - 1];
    const savedBottom: IndexBuf[] = this.project.frames.map((f) =>
      copyIndexBuf(f.layers[bottom.id] ?? allocIndexBuf(this.project))
    );
    const savedTop: IndexBuf[] = this.project.frames.map((f) =>
      copyIndexBuf(f.layers[top.id] ?? allocIndexBuf(this.project))
    );
    const savedOrders = this.project.frames.map((f) => (f.order ? [...f.order] : undefined));
    const self = this;
    const apply = () => {
      for (const f of self.project.frames) {
        const tb = f.layers[top.id];
        const bb = f.layers[bottom.id];
        if (tb && bb) {
          for (let i = 0; i < PIXELS; i++) if (tb[i] !== 0) bb[i] = tb[i];
        }
        delete f.layers[top.id];
        if (f.order) f.order = f.order.filter((x) => x !== top.id);
      }
      const i = self.project.layerDefs.findIndex((l) => l.id === top.id);
      if (i >= 0) self.project.layerDefs.splice(i, 1);
      self.activeLayerId = bottom.id;
      self.afterLayerChange();
    };
    const revert = () => {
      self.project.layerDefs.splice(idx, 0, top);
      self.project.frames.forEach((f, fi) => {
        // 統合後の昇格に備え、現在幅で確保して復元
        const nb = allocIndexBuf(self.project);
        nb.set(savedTop[fi]);
        f.layers[top.id] = nb;
        f.layers[bottom.id]?.set(savedBottom[fi]);
        f.order = savedOrders[fi] ? [...savedOrders[fi]!] : undefined;
      });
      self.activeLayerId = top.id;
      self.afterLayerChange();
    };
    this.history.push({ label: "レイヤー統合", undo: revert, redo: apply });
    apply();
  }

  // ---------------- コマ操作 ----------------

  private addFrame(duplicate: boolean) {
    if (this.xformGuard()) return; // E-4
    if (this.project.frames.length >= 65535) {
      this.cb.toast("コマ数が上限（65,535）に達しています");
      return;
    }
    if (this.project.frames.length >= 2000) {
      this.cb.toast("⚠ コマ数が非常に多くなっています（動作が重くなる場合があります）");
    }
    const at = this.frameIndex + 1;
    const cur = this.project.frames[this.frameIndex];
    const nf = duplicate ? cloneFrame(cur) : makeEmptyFrame(this.project, cur.paper);
    const self = this;
    const apply = () => {
      // redo時: undo中にプロジェクトが16bit昇格していると nf が8bitのまま取り残される
      conformFrameWidth(self.project, nf);
      self.project.frames.splice(at, 0, nf);
      self.frameIndex = at;
      self.afterFrameStructureChange();
    };
    const revert = () => {
      self.project.frames.splice(at, 1);
      self.frameIndex = Math.min(self.frameIndex, self.project.frames.length - 1);
      self.afterFrameStructureChange();
    };
    this.history.push({ label: duplicate ? "コマ複製" : "コマ追加", undo: revert, redo: apply });
    apply();
  }

  private async deleteFrame() {
    if (this.xformGuard()) return; // E-4
    if (this.project.frames.length <= 1) {
      this.cb.toast("最後のコマは削除できません");
      return;
    }
    const at = this.frameIndex;
    const frame = this.project.frames[at];
    const self = this;
    const apply = () => {
      self.project.frames.splice(at, 1);
      self.frameIndex = Math.min(at, self.project.frames.length - 1);
      self.afterFrameStructureChange();
    };
    const revert = () => {
      // 削除中にプロジェクトが16bit昇格していると frame が8bitのまま取り残される
      conformFrameWidth(self.project, frame);
      self.project.frames.splice(at, 0, frame);
      self.frameIndex = at;
      self.afterFrameStructureChange();
    };
    this.history.push({ label: "コマ削除", undo: revert, redo: apply });
    apply();
  }

  private reorderFrame(from: number, to: number) {
    if (from === to) return;
    if (this.xformGuard()) return; // E-4
    const self = this;
    const apply = () => {
      const [f] = self.project.frames.splice(from, 1);
      self.project.frames.splice(to, 0, f);
      self.frameIndex = to;
      self.afterFrameStructureChange();
    };
    const revert = () => {
      const [f] = self.project.frames.splice(to, 1);
      self.project.frames.splice(from, 0, f);
      self.frameIndex = from;
      self.afterFrameStructureChange();
    };
    this.history.push({ label: "コマ並べ替え", undo: revert, redo: apply });
    apply();
  }

  gotoFrame(i: number) {
    if (i < 0 || i >= this.project.frames.length) return;
    if (this.xformGuard()) return; // E-4: 変形中はコマ移動をブロック
    this.selMask = null;
    this.frameIndex = i;
    this.renderCanvas();
    this.redrawOverlay();
    this.updateFilmSelection();
    this.seSectionRefresh?.(); // M5-1: 音声パネルの「配置先」表示を追従
  }

  // ---------------- 再生 ----------------

  togglePlayback() {
    if (!this.playing && this.xformGuard()) return; // E-4
    if (this.playing) this.stopPlayback();
    else this.startPlayback();
  }

  /** M5-1: 指定コマに配置されたSEを発火（多重可・muted/volumeはトラック別） */
  private fireFrameSe(i: number) {
    const a = this.project.audio;
    if (!a || a.se.length === 0) return;
    const ids = this.project.frames[i]?.se;
    if (!ids) return;
    for (const id of ids) {
      const t = a.se.find((s) => s.id === id);
      if (t) this.audioPreview.fireSe(t);
    }
  }

  private startPlayback() {
    if (this.playing) return;
    this.playing = true;
    $("#ed-play").textContent = "⏸";
    const fps = FPS_TABLE[this.project.speedIndex] || 8;
    // M6-2/3: BGMプレビュー（開始フレーム位置に頭出し・ループ毎リセット）
    // M5-1: 速度連動 rate（ピッチも変わる=原作準拠）＋SEのコマ発火
    const a = this.project.audio ?? null;
    const rate = a?.bgm ? bgmPlaybackRate(this.project.speedIndex, a.bgm.baseSpeedIndex) : 1;
    void this.audioPreview.start(a?.bgm ?? null, this.frameIndex / fps, rate);
    // Codex指摘#3: デコードは「配置済みかつ非ミュート」のSEだけ（未使用SEをキャッシュしない）
    if (a && a.se.length > 0) {
      const used = new Set<string>();
      for (const f of this.project.frames) for (const id of f.se ?? []) used.add(id);
      void this.audioPreview.prepareSe(a.se.filter((s) => !s.muted && used.has(s.id)));
    }
    this.fireFrameSe(this.frameIndex); // 開始コマのSEも鳴らす
    this.playTimer = window.setInterval(() => {
      let next = this.frameIndex + 1;
      if (next >= this.project.frames.length) {
        if (this.project.loop) {
          next = 0;
          // A-1: アニメが先頭に戻るたび音も頭出しから鳴り直す（モード共通）。
          // 1コマ作品は毎tickラップするため除外（音が鳴れなくなる）
          if (this.project.frames.length > 1) this.audioPreview.restart();
        } else {
          this.stopPlayback();
          return;
        }
      }
      this.frameIndex = next;
      this.fireFrameSe(next); // M5-1: SEはコマ進行で発火（ループ毎周も自然に発火）
      this.renderCanvas();
      this.updateFilmSelection();
    }, 1000 / fps);
  }

  private stopPlayback() {
    this.playing = false;
    this.audioPreview.stop();
    if (this.playTimer != null) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    const btn = document.querySelector("#ed-play");
    if (btn) btn.textContent = "▶";
    if (this.mounted) this.renderCanvas();
  }

  // ---------------- 共通 ----------------

  private pushBufferHistory(
    label: string,
    buf: IndexBuf,
    before: IndexBuf,
    // M10-22: バッファとマスクが**同時に**変わる操作（選択移動確定・切り取り・選択削除・
    // 変形確定）は、マスクの before/after を同じエントリに合成して Ctrl+Z 1回で両方戻す。
    // 省略時は従来どおりバッファのみ（selMask には一切触れない）
    sel?: { before: Uint8Array | null; after: Uint8Array | null }
  ) {
    const after = copyIndexBuf(buf);
    // Frame オブジェクトと layerId で適用時に解決する（構造 undo/redo でバッファが
    // 再生成されても正しい実体に書き戻す）。Frame の同一性はコマ並べ替え等でも保たれる。
    const frame = this.project.frames[this.frameIndex];
    const layerId = this.activeLayerId;
    const self = this;
    const base = bufferChangeEntry(
      label,
      () => frame.layers[layerId] ?? null,
      before,
      after,
      () => {
        // Undo/Redo もデータ変更なので dirty（＝オートセーブ対象）にする
        self.dirty = true;
        self.renderCanvas();
        const fi = self.project.frames.indexOf(frame);
        if (fi >= 0) self.paintFilmThumb(fi);
      }
    );
    if (!sel) {
      this.history.push(base);
    } else {
      // 合成エントリ: バッファ復元（resolve 方式は base がそのまま担う）＋マスク復元。
      // マスク復元は**エントリ作成時のコマを表示中のときだけ**行う（Frame オブジェクト同一性で
      // 判定＝resolve と同じ原理）。gotoFrame が守る「コマ移動＝選択解除」の不変条件を
      // undo/redo が破らないように（別コマ表示中はバッファだけ静かに戻る）
      const selBefore = sel.before;
      const selAfter = sel.after;
      const onFrame = () => self.project.frames[self.frameIndex] === frame;
      this.history.push({
        label,
        undo() {
          base.undo();
          if (onFrame()) {
            self.selMask = selBefore ? selBefore.slice() : null;
            self.redrawOverlay();
          }
        },
        redo() {
          base.redo();
          if (onFrame()) {
            self.selMask = selAfter ? selAfter.slice() : null;
            self.redrawOverlay();
          }
        },
      });
    }
    this.dirty = true;
  }

  /** M10-22: 選択マスクの作成・置換・解除を履歴に積む（before/after はコピー・null 許容）。
   *  undo/redo は selMask の復元と点線の再描画のみ（バッファには触れない。
   *  選択はツール非依存の状態なので、redo 時にツールが select 以外でも復元する）。
   *  ただしマスクは**そのコマ上の状態**なので、エントリ作成時のコマを表示中のときだけ
   *  復元する（Frame オブジェクト同一性＝resolve と同じ原理。別コマでは何もしない＝
   *  gotoFrame の「コマ移動＝選択解除」の不変条件を守る） */
  private pushSelectionHistory(
    label: string,
    before: Uint8Array | null,
    after: Uint8Array | null
  ) {
    const self = this;
    const frame = this.project.frames[this.frameIndex];
    const onFrame = () => self.project.frames[self.frameIndex] === frame;
    this.history.push({
      label,
      undo() {
        if (!onFrame()) return;
        self.selMask = before ? before.slice() : null;
        self.redrawOverlay();
      },
      redo() {
        if (!onFrame()) return;
        self.selMask = after ? after.slice() : null;
        self.redrawOverlay();
      },
    });
  }

  private afterStructuralChange() {
    this.dirty = true;
    this.renderCanvas();
    this.paintFilmThumb(this.frameIndex);
  }

  private afterLayerChange() {
    this.dirty = true;
    this.rebuildLayers();
    this.renderCanvas();
    this.paintFilmThumb(this.frameIndex);
  }

  private afterFrameStructureChange() {
    this.dirty = true;
    // コマの追加/削除/並べ替え/挿入で範囲選択はインデックスがずれるためリセット
    this.rangeSel = null;
    this.rangeAnchor = null;
    this.rebuildFilm();
    this.renderCanvas();
    this.redrawOverlay();
  }

  private refreshAll() {
    this.rebuildLayers();
    this.rebuildPalette();
    this.rebuildFilm();
    this.renderCanvas();
    this.redrawOverlay();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this.mounted) return;
    // M10-3 P-8: 自前ダイアログが開いている間はエディタのショートカットを一切通さない。
    // ダイアログ側の capture リスナーだけに頼ると、イベントの target が window そのものの
    // ときに同一要素のリスナー順で抜けてしまう（Escape で選択解除まで走る）
    if (this.modalDepth > 0) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.ctrlKey && e.key.toLowerCase() === "z") {
      // M3.8 L-B: 最上流で変形/浮動を判定（グローバル履歴に通さない）
      e.preventDefault();
      this.handleUndo();
    } else if (e.ctrlKey && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.handleRedo();
    } else if (e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (e.shiftKey) this.saveAs();
      else this.save();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      // ページクリップボード（Ctrl+C/X/V はピクセル選択用に温存）
      e.preventDefault();
      this.copySelectedFrames();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      this.pasteFrames();
    } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
      this.copySelection(false);
    } else if (e.ctrlKey && e.key.toLowerCase() === "x") {
      this.copySelection(true);
    } else if (e.ctrlKey && e.key.toLowerCase() === "v") {
      this.pasteClipboard();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selMask) {
        e.preventDefault();
        this.deleteSelection();
      }
    } else if (e.key === "Enter") {
      // E-4: Enter=変形確定
      if (this.xformActive) {
        e.preventDefault();
        this.commitTransform();
      } else if (this.cornerActive) {
        e.preventDefault();
        this.commitCornerWarp();
      }
    } else if (e.key === "Escape") {
      if (this.rowDrag) {
        // M3.9 H-2: レイヤードラッグ中の Esc はドラッグだけキャンセル
        this.cancelRowDrag();
        return;
      }
      if (this.xformActive) this.cancelTransform();
      // M10-2c: 取消の復元を選択解除より**先に**走らせる（順序を入れ替えないこと。
      // cancelCornerWarp は selMask を読まないが、transform と流儀を揃えてある）
      if (this.cornerActive) this.cancelCornerWarp();
      this.selMask = null;
      this.lassoPts = [];
      this.redrawOverlay();
    } else if (e.key === " ") {
      // E-1: Space押下中は一時的に手のひら（お絵描きソフト標準の作法。
      // 従来の Space=再生 は再生ボタンに委譲）
      e.preventDefault();
      if (!e.repeat) {
        this.spaceHeld = true;
        this.updatePanCursor();
      }
    } else if (e.key.toLowerCase() === "h" && !e.ctrlKey) {
      this.setTool("hand");
    } else if (e.key === "ArrowLeft") {
      this.gotoFrame(this.frameIndex - 1);
    } else if (e.key === "ArrowRight") {
      this.gotoFrame(this.frameIndex + 1);
    }
  }
}
