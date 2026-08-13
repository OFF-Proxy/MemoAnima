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
// M11-10: ショートカット（キー → コマンドID → 実行）。定義とプリセットは src/keymap.ts に集約
import {
  COMMANDS,
  buildLookup,
  eventKey,
  type CommandId,
  type Preset,
} from "../keymap";
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
  | "warp"
  // M11-8 P-2: 絵そのものを動かす専用ツール（選択範囲は「位置決めの道具」になったため）
  | "move";

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
  /** M11-11: いま見ているコマ1枚を画像で保存する（PNG / JPEG・1/2/4/8倍）。
   *  アニメの書き出し（openExport）とは UI も経路も分けてある（1枚に範囲・音声・進捗は要らない） */
  openImageExport?: (p: Project, frameIndex: number, baseName: string) => void;
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
  /** M11-2: ツールごとの太さ（ペン/ブラシ/消しゴムが各自の値を覚える）。
   *  図形などはペンの値を流用する（＝独立サイズを持たせない・従来どおり）。
   *  永続化はしない（従来の penSize と同じくセッション内のみ） */
  private sizeByTool: Record<"pen" | "brush" | "eraser", number> = {
    pen: 3,
    brush: 3,
    eraser: 3,
  };
  /** 現在のツールの太さ。**実体は sizeByTool 側**にしかない（二重状態を持たない）。
   *  こうしておかないと setTool を経由しないツール変更（貼り付け・画像配置・変形の
   *  離脱/確定）で「記憶値と実際の太さ」が食い違う — レビュー検出 */
  get penSize(): number {
    return this.sizeByTool[this.sizeSlot(this.tool)];
  }
  set penSize(v: number) {
    this.sizeByTool[this.sizeSlot(this.tool)] = v;
  }
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
  /** M11-12: 確定前の浮動テキスト。**保持するのは文字のパラメータでピクセルではない**
   *  （書体やサイズを変えても位置を保ったまま作り直せる。ピクセルで持つと変えるたびに劣化する）。
   *
   *  変形モード（`xformActive` + `floatBuf`）と同じ「浮いて → 動かして → 確定/取消」の
   *  状態機械だが、**プロジェクトには一切触れていない**点が違う（レイヤーから切り出さない）。
   *  そのため保存・オートセーブは浮いていても正しく走る（作品の中身は完全なまま）。
   *  保存しない・履歴にも積まない（確定したときに1エントリだけ積む）。 */
  private textDraft: {
    text: string;
    x: number;
    y: number;
    family: FontKey;
    size: number;
    bold: boolean;
    vertical: boolean;
  } | null = null;
  /** 生成したマスクのキャッシュ（位置を動かすだけなら作り直さない）。
   *  `cv` は色つきのプレビュー用キャンバスで、色を変えたときだけ作り直す */
  private textDraftCache: {
    key: string;
    mask: { w: number; h: number; data: Uint8Array } | null;
    cv: HTMLCanvasElement | null;
    cvColor: string;
  } | null = null;
  /** 浮動テキストを掴んでいる位置（掴んだ点と左上の差） */
  private textDrag: { ox: number; oy: number } | null = null;
  /** E-2: ピクセル格子（1ドット≥8px で表示・既定ON） */
  gridEnabled = true;
  /** E-1: Space押下中の一時手のひら */
  private spaceHeld = false;
  /** M11-2: Space を押した時刻。keyup までが短く、その間にパンしていなければ「単押し」＝再生トグル */
  private spaceDownAt = 0;
  /** M11-2: この Space 押下中に実際にパンが始まったか（始まっていたら再生トグルにしない） */
  private spacePanned = false;
  /** M11-2: 単押しと判定する上限（ms）。これを超えたら従来どおり手のひらだけ */
  private static readonly SPACE_TAP_MS = 250;
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
  /** M11-5: いま #ed-cvwrap が掴んでいるポインタ。pointerup/pointercancel が届かないまま
   *  終わった接触を後から解放するために覚えておく（掴みっぱなしだと、その入力機器の
   *  イベントが全部キャンバスへ配送され続け、ボタン類が押せなくなる） */
  private capturedPointerId: number | null = null;
  /** M11-5: 直近のポインタイベント。接触が途切れたとき、この位置でストロークを閉じる */
  private lastPointerEvent: PointerEvent | null = null;
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
  // M11-8: selmask=選択枠だけの移動（P-1） / layermove=レイヤーの絵の移動（P-2）
  private dragMode: "" | "move" | "scale" | "rotate" | "selmove" | "selmask" | "layermove" = "";
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
      const wasHeld = this.spaceHeld;
      const held = performance.now() - this.spaceDownAt;
      const panned = this.spacePanned;
      this.spaceHeld = false;
      this.spacePanned = false;
      this.updatePanCursor();
      // M11-2: 単押し（短く押して離す・その間パンしていない）なら再生/一時停止のトグル。
      // 長押しは従来どおり手のひらのまま（何もしない）。ダイアログ中・文字入力中は無反応
      if (
        wasHeld &&
        !panned &&
        held <= Editor.SPACE_TAP_MS &&
        this.mounted &&
        !this.dialogOpen() &&
        !this.isTextEntry(e.target)
      ) {
        this.togglePlayback();
      }
    }
    if (e.key === "Shift") {
      this.shiftHeld = false;
      this.refreshShapePreview();
    }
    // M11-11: 「押している間だけ透かす」を離したら戻す（割り当てを変えても同じ物理キーで戻る）
    if (this.xformPeek && (this.peekCode === null || e.code === this.peekCode)) {
      this.setXformPeek(false);
    }
  };
  /** M11-5: ウィンドウがフォーカスを失ったときの後始末。
   *
   *  作者症状「修飾キーを連打しているとペンだけ操作が効かなくなる（マウスなら動く）」の調査で、
   *  **接触の pointerup が届かないまま終わると状態が残り続ける**ことを実 exe で確認した:
   *  - `#ed-cvwrap` がそのポインタを掴んだまま → **同じ入力機器のイベントが全部
   *    キャンバスへ配送され、ツールボタン等が押せない**（ポインタごとに別管理なので
   *    掴まれていない機器＝マウスは平気。「ペンだけ効かない」の説明になる）
   *  - `pointerDown` が立ちっぱなし → かざしただけで線が引かれる・オートセーブが止まる
   *  - `spaceHeld` が立ちっぱなし → 手のひらのままで描けない
   *  フォーカスを失うと keyup も pointerup も**二度と来ない**ので、ここで畳む。
   *  （ポインタ種別で分岐していない。「接触が途切れた」という事実だけを扱う） */
  private blurHandler = () => {
    if (!this.mounted) return;
    this.spaceHeld = false;
    this.spacePanned = false;
    this.shiftHeld = false;
    // M11-11: 透かしたままフォーカスを失うと keyup が来ない（薄いまま戻らなくなる）
    this.setXformPeek(false);
    this.endPointerSession("blur");
    // レイヤー行のドラッグも同じ理由で取り残される（pointerup が来ないと
    // 以後どの行も掴めなくなる）。こちらは取り消し＝並びは動かさない
    this.cancelRowDrag();
    // M11-6: 音声パネルの波形も同じ（掴んだままだと、戻ったあと載せただけで値が動く）
    this.audioWaveEndDrag?.();
    this.updatePanCursor();
  };
  private resizeHandler = () => this.applyZoom();
  /** M11-10: エディタ画面のどこかを押したら「別の操作を始めた」とみなして、
   *  矢印キーの移動セッションを確定する。capture 段階なので**どのボタンの処理より先**に走る
   *（保存・書き出し・タイムライン・レイヤー行・キャンバス…を1箇所でまかなう） */
  private uiPointerHandler = () => {
    if (this.mounted) this.endArrowSession();
  };
  /** M11-8: ステージのスクロール（手のひら・ホイール）にランチャーを追従させる */
  private stageScrollHandler = () => {
    if (this.mounted) this.refreshSelectionLauncher();
  };
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
    // M11-5: 診断ビルドのみ — キーとフォーカスの出入りも記録する（通常ビルドでは登録しない）。
    // **本体のハンドラより先に**登録する（処理が走る前の状態をログに残すため。
    // 後ろに置くと「H を押した瞬間のツール」が既に hand になっていて因果が読めない）
    if (this.inputLog) {
      window.addEventListener("keydown", this.keyLogHandler);
      window.addEventListener("keyup", this.keyLogHandler);
      window.addEventListener("blur", this.winLogHandler);
      window.addEventListener("focus", this.winLogHandler);
      document.addEventListener("visibilitychange", this.winLogHandler);
    }
    window.addEventListener("keydown", this.keydownHandler);
    window.addEventListener("keyup", this.keyupHandler);
    window.addEventListener("resize", this.resizeHandler);
    window.addEventListener("blur", this.blurHandler);
    this.spaceHeld = false;
    // M11-5: 前のセッションの接触状態を持ち越さない（pointerup が届かないまま閉じた場合、
    // 開き直しても「かざしただけで線が引かれる」等が残っていた）。
    // **掴んだままなら解放してから忘れる** — ウィンドウへのドロップ→「編集」は unmount() を
    // 通らずに mount() し直すので、ここで id を忘れるだけだと二度と解放できなくなる
    this.spacePanned = false;
    this.pointerDown = false;
    this.panState = null;
    this.lastPointerEvent = null;
    this.releaseCapture();
    this.cancelRowDrag();
    this.cancelFrameDrag(); // M11-7: 掴んだまま別の作品を開かない
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
    // M11-8: 手のひら/スクロールでキャンバスが動いたらランチャーも追従させる
    // （M3.9 H-1 でスクロールは内側の #ed-scroll に限定されている。#ed-stage は動かない）
    $("#ed-scroll").addEventListener("scroll", this.stageScrollHandler);
    // M11-10: 矢印キーの移動セッションを「別の操作」で確定させる（capture）
    $("#screen-editor").addEventListener("pointerdown", this.uiPointerHandler, true);
    // F-3: オートセーブ（15秒間隔・変更があるときだけ・描画中はスキップ）
    this._dirty = false;
    this.autosavePending = false;
    this.autosaveTimer = window.setInterval(() => void this.runAutosave(), 15000);
  }

  unmount() {
    // M11-6: 二度呼んでも安全にする（showEditor() の先頭と showLibrary() の両方から
    // 呼ばれ得るため）。mount していない状態での後始末は何もしない
    if (!this.mounted) return;
    this.stopPlayback();
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
    window.removeEventListener("resize", this.resizeHandler);
    window.removeEventListener("blur", this.blurHandler);
    // M11-5: 診断ビルドで張った分（張っていなければ何も起きない）
    window.removeEventListener("keydown", this.keyLogHandler);
    window.removeEventListener("keyup", this.keyLogHandler);
    window.removeEventListener("blur", this.winLogHandler);
    window.removeEventListener("focus", this.winLogHandler);
    document.removeEventListener("visibilitychange", this.winLogHandler);
    this.releaseCapture(); // M11-5: 掴んだまま画面を離れない
    // M11-7: 進行中の自前ドラッグ（window リスナー）を残さない
    this.cancelRowDrag();
    this.cancelFrameDrag();
    // M11-10: 矢印キーの移動セッションを持ったまま画面を離れない（確定してから閉じる）
    this.endArrowSession();
    // M11-12: 浮動テキストも同じ（保険。⟵もどる等の通常経路では xformGuard で既に焼けている）。
    // DOM が消えかけているので silent（UI 更新なし）で呼ぶ
    this.commitTextDraft(true);
    document
      .querySelector("#screen-editor")
      ?.removeEventListener("pointerdown", this.uiPointerHandler, true);
    // M11-8: ランチャーと、そのスクロール購読を残さない
    document.querySelector("#ed-scroll")?.removeEventListener("scroll", this.stageScrollHandler);
    this.hideSelectionLauncher();
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
  /** M11-6: 編集を中断してよいか確かめる。true=進んでよい / false=中断する。
   *
   *  「変形ガード → 未保存の確認 → 破棄ならオートセーブも消す」の3点は、
   *  ⟵もどる（`#ed-back`）と、ウィンドウへのドロップ→「編集」の**両方**が通る必要がある。
   *  片方にしか無かったせいで、ドロップ経路では編集中の変更が黙って消えていた（M11-6 P-1）。
   *  破棄のときにオートセーブも消すのは、次回起動で「復元しますか？」を出さないため。
   *  ※ 設定メニューの「終了」は**この経路を通さない**（オートセーブを残したまま終わる
   *    従来の挙動を維持する。M11-6 P-1-5） */
  async confirmLeave(
    message = "保存していない変更があります。破棄してライブラリへ戻りますか？"
  ): Promise<boolean> {
    if (!this.mounted) return true;
    if (this.xformGuard()) return false; // E-4: 変形中は確定/取消が先
    if (this.dirty) {
      const ok = await this.cb.confirm(message);
      if (!ok) return false;
      await this.invalidateAutosave();
    }
    return true;
  }

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
      // M11-8 P-2: 絵を動かすのはこのツール（選択範囲内のドラッグは枠だけが動く）
      { key: "move", icon: "✥", label: "移動" },
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

  /** M11-2: そのツールが太さを記憶する枠。ペン/ブラシ/消しゴムは各自、
   *  それ以外（図形など）はペンの枠を共有する */
  private sizeSlot(t: Tool): "pen" | "brush" | "eraser" {
    return t === "brush" ? "brush" : t === "eraser" ? "eraser" : "pen";
  }

  /** M11-2: 太さピッカーの選択表示を現在の penSize に合わせ直す（DOMは作り直さない） */
  private refreshSizePicker() {
    const host = document.querySelector("#ed-sizes");
    if (!host) return;
    host.querySelectorAll(".sz").forEach((el, i) => {
      el.classList.toggle("on", PEN_SIZES[i] === this.penSize);
    });
  }

  private setTool(t: Tool) {
    // M11-12: 文字ツールから抜けるときは浮動テキストを**確定**する（変形の「取り消し」とは逆。
    // 打った文字が黙って消えないように＝REQ「別のツールへ切り替える＝確定」）
    if (this.textDraft && t !== "text") this.commitTextDraft();
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
    // M11-2: 太さの実体は sizeByTool なので、ここは表示（.sz の on）を合わせるだけ
    this.refreshSizePicker();
    if (t === "transform") this.beginTransform();
    // M10-2c: 歪みへ戻ってきたときにモードが corner のままなら再開する
    // （これが無いとハンドルの出ていない死んだモードになる）
    if (t === "warp" && this.warpMode === "corner" && !this.cornerActive)
      this.beginCornerWarp();
    this.updateToolButtons();
    this.buildToolOptions();
    this.rebuildTexPicker(); // M5-4: ペン⇄ブラシでピッカー切替（各自の選択を記憶）
    this.redrawOverlay();
    this.revealToolOptions();
  }

  /** M11-11: ツールオプションはサイドパネルの一番下にあるので、画面が低いと
   *  「枠からはみ出している」ように見えて確定/キャンセルのボタンに気づけない。
   *  はみ出しているときだけ、そこまでスクロールして見せる（収まっていれば何もしない） */
  private revealToolOptions() {
    const side = document.querySelector("#ed-side") as HTMLElement | null;
    const host = document.querySelector("#ed-toolopts") as HTMLElement | null;
    if (!side || !host || !host.firstChild) return;
    const sr = side.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    if (hr.bottom > sr.bottom + 1) host.scrollIntoView({ block: "end" });
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
        this.penSize = s; // setter が「今のツールの枠」へ書く（図形などはペンの枠）
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
  /** M11-6: 波形（`#ap-wave`）のドラッグを畳む手（`audioPanelClose` と同じ流儀）。
   *  キャンバス側と同じく「接触が途切れたら畳む」を通すために外から呼べるようにする */
  private audioWaveEndDrag: (() => void) | null = null;

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
      self.audioPreview.stopSe(); // M11-1: 試し再生で発火したSEも止める
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
    const fireTrialSe = (i: number, skipIds?: string[]) => {
      const a = proj.audio;
      if (!a || a.se.length === 0) return;
      const ids = proj.frames[i]?.se;
      if (!ids) return;
      for (const id of ids) {
        if (skipIds && skipIds.includes(id)) continue; // M11-9: 続きから鳴っているSEは重ねない
        const t = a.se.find((s) => s.id === id);
        if (t) self.audioPreview.fireSe(t);
      }
    };
    const startFrameTimer = (skipIds?: string[]) => {
      fireTrialSe(trialFrame, skipIds); // 開始コマ
      trialTimer = window.setInterval(() => {
        let next = trialFrame + 1;
        if (next >= frameCount) {
          next = 0;
          if (frameCount > 1) {
            playTrialAudio(); // A-1と同じ: アニメが先頭に戻るたび音も頭出し
            self.audioPreview.stopSe(); // M11-1: SEも本再生と同じく頭出しし直す（周回で重ねない）
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
      // M11-1: 一時停止でSEも止める（本再生の⏸と同じ扱い）
      // M11-9: 止めるだけでなく「どこまで鳴ったか」を畳む＝再開で続きから鳴る
      self.audioPreview.pauseSe();
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
      // M11-9: 一時停止で畳んだSEを続きから鳴らし、そのぶんは開始コマで重ねて鳴らさない
      startFrameTimer(self.audioPreview.resumeSe());
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
      // M11-6: 描き直すと古い #ap-wave は DOM から外れる。畳む手も作り直すので、
      // ここで捨てておく（BGM を消した直後は波形が無く、再代入されないため）
      this.audioWaveEndDrag?.();
      this.audioWaveEndDrag = null;
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
        // M11-6: 掴んだポインタを覚え、解放を1箇所に集約する（キャンバス側と同じ流儀）。
        // 掴みっぱなしのまま戻ってくると「カーソルを載せただけでトリムが動く」ため
        let wavePointerId: number | null = null;
        const releaseWave = () => {
          if (wavePointerId == null) return;
          try {
            cv.releasePointerCapture(wavePointerId);
          } catch {
            /* すでに解放済み・そのポインタが無い場合は何もしなくてよい */
          }
          wavePointerId = null;
        };
        /** 進行中のドラッグを畳む（トリム／ルーラーパン／波形移動のすべて共通） */
        const endWaveDrag = () => {
          if (dragging === "seek" || dragging === "viewpan") syncZoomUI();
          dragging = "";
          releaseWave();
        };
        this.audioWaveEndDrag = endWaveDrag;
        cv.addEventListener("pointerdown", (e) => {
          if (!buffer) return;
          // 前の接触が pointerup 無しで終わっていたら、ここで畳んでから始める（M11-5 と同じ）
          if (dragging || wavePointerId != null) endWaveDrag();
          try {
            cv.setPointerCapture(e.pointerId);
            wavePointerId = e.pointerId;
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
          // M11-6: 掴んでいるポインタ以外の移動は無視する（手本: library.ts の mine()）
          if (wavePointerId != null && e.pointerId !== wavePointerId) return;
          // M11-6: 「掴んでいるはずなのにボタンが押されていない」＝ pointerup の取りこぼし。
          // 畳んでからホバー扱いにする（これが無いと載せただけでトリムが動く）
          if (dragging && e.buttons === 0) {
            endWaveDrag();
            cv.style.cursor = zoneCursor(e);
            return;
          }
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
          if (wavePointerId != null && e.pointerId !== wavePointerId) return; // M11-6
          endWaveDrag(); // syncZoomUI・dragging クリア・キャプチャ解放をここに集約
          cv.style.cursor = zoneCursor(e);
        };
        cv.addEventListener("pointerup", up);
        cv.addEventListener("pointercancel", up);
        // M11-6: ブラウザ側で解放されたときも記録を合わせる（記録のみ）
        cv.addEventListener("lostpointercapture", (e) => {
          if (wavePointerId === e.pointerId) wavePointerId = null;
        });
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
      // M11-6: 掴んだまま閉じない（要素ごと消えるので実害は無いが、記録も残さない）
      this.audioWaveEndDrag?.();
      this.audioWaveEndDrag = null;
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
    // M11-9 P-1: SEを編集したら「一時停止で畳んだ続き」は捨てる（消した音源の続きが後から鳴らない）。
    // 鳴っている音には触れない＝従来の挙動は変えない
    this.audioPreview.discardPausedSe();
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
    // M11-12: 浮動テキストのプレビューは現在の色で描いているので、色が変わったら描き直す
    //（色の変更は必ずここを通る＝スポイト・カラーピッカー・パレット・透明のすべて）
    if (this.textDraft) this.redrawOverlay();
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
    /** M11-7 P-2: 掴んだポインタ。これ以外の move/up は無視する */
    pointerId: number;
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
    // M11-7 P-2: 掴んだポインタ以外（2本目の指・別のペン）の move/up は無視する。
    // 見ていないと、触れた指の座標でドロップ先が計算され、**指していない位置へ行が動く**。
    // down 側には入れない（M11-6 P-3 と同じ理由＝自己修復の復帰経路を塞がないため）
    const mine = (ev: PointerEvent) => this.rowDrag?.pointerId === ev.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (mine(ev)) this.updateRowDrag(ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (mine(ev)) this.finishRowDrag(ev);
    };
    this.rowDrag = {
      id,
      kind,
      pointerId: e.pointerId,
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
      // M11-12: 浮動テキストがあるときだけ入力欄と確定/取消を使える状態にする
      const drafting = !!this.textDraft;
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
        <textarea id="ed-textinput" class="tinput" rows="3" spellcheck="false"
          placeholder="${drafting ? "ここに入力（Enter で改行）" : "キャンバスをクリックしてから入力"}"
          ${drafting ? "" : "disabled"}></textarea>
        <div class="selacts">
          <button class="minibtn ok" id="ed-text-ok"${drafting ? "" : " disabled"}>✔ 確定</button>
          <button class="minibtn" id="ed-text-cancel"${drafting ? "" : " disabled"}>✖ 取り消し</button>
        </div>
        <p class="hintline">${
          drafting
            ? "Ctrl+Enter か ✔ で確定。Esc で取り消し。文字をドラッグして動かせます（そのあとは矢印キーで1ドット・Shift で10ドット）。"
            : "キャンバスをクリックすると、その位置に文字を置けます。確定するまで何度でも直せます。"
        }</p>`;
      $("#ed-textfont").addEventListener("change", (e) => {
        this.textFamily = (e.target as HTMLSelectElement).value as FontKey;
        const d = fontDef(this.textFamily);
        // 直前のサイズが新候補にあれば維持し、無ければ最も近い値へ
        this.textSize = nearestSize(d, this.textSize);
        if (!d.hasBold) this.textBold = false;
        this.syncTextDraftStyle(); // M11-12: 浮動テキストへ即反映（位置は変えない）
        this.buildToolOptions();
        this.redrawOverlay();
        this.cb.onTextSettingsChange?.(this.textSettings());
      });
      $("#ed-textsize").addEventListener("change", (e) => {
        this.textSize = Number((e.target as HTMLSelectElement).value);
        this.syncTextDraftStyle();
        this.redrawOverlay();
        this.cb.onTextSettingsChange?.(this.textSettings());
      });
      // M10-15: 行は hasBold の書体でしか描かない — 存在するときだけリスナを張る
      document.querySelector("#ed-textbold")?.addEventListener("click", () => {
        if (!fontDef(this.textFamily).hasBold) return; // 最終防衛線（行が無いので実質不要）
        this.textBold = !this.textBold;
        this.syncTextDraftStyle();
        this.buildToolOptions();
        this.redrawOverlay();
        this.cb.onTextSettingsChange?.(this.textSettings());
      });
      // M10-11: 向き（横書き／縦書き）。既存の .oni + .lv だけで組む（新規CSSなし）
      host.querySelectorAll("#ed-textdir .lv").forEach((b) =>
        b.addEventListener("click", () => {
          const v = (b as HTMLElement).dataset.v === "v";
          if (v === this.textVertical) return;
          this.textVertical = v;
          this.syncTextDraftStyle();
          this.buildToolOptions();
          this.redrawOverlay();
          this.cb.onTextSettingsChange?.(this.textSettings());
        })
      );
      // M11-12: 複数行の入力欄。打つたびにプレビューを作り直す（間引きなし・実測で不要と判断）
      {
        const ta = $("#ed-textinput") as HTMLTextAreaElement;
        ta.value = this.textDraft?.text ?? "";
        ta.addEventListener("input", () => {
          if (!this.textDraft) return;
          this.textDraft.text = ta.value;
          this.redrawOverlay();
        });
        // Escape と Ctrl+Enter は**入力欄の中でも**効かせる。window 側の onKeyDown は
        // isTextEntry() で早期 return するので、ここで受けないとどちらも届かない。
        // それ以外（Enter=改行 / 矢印=カーソル移動 / P=「P」）はブラウザ既定のまま通す
        ta.addEventListener("keydown", (e) => {
          if (e.isComposing || e.keyCode === 229) return; // IME 変換中は触らない
          if (e.code === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.cancelTextDraft();
          } else if ((e.code === "Enter" || e.code === "NumpadEnter") && e.ctrlKey) {
            e.preventDefault();
            e.stopPropagation();
            this.commitTextDraft();
          }
        });
        $("#ed-text-ok").addEventListener("click", () => this.commitTextDraft());
        $("#ed-text-cancel").addEventListener("click", () => this.cancelTextDraft());
        // 書体やサイズを変えるとこのパネルごと作り直されてフォーカスが飛ぶ。
        // 浮動中で行き場を失っていたら入力欄へ戻す（打ちかけの続きをそのまま打てるように）
        if (drafting && document.activeElement === document.body) this.focusTextInput();
      }
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
      // M11-2: 4つを1本の .oni に並べると `.oni .lv{flex:1}` ＋ `white-space:nowrap` で
      // ラベルがパネル右端からはみ出す（作者報告）。**2個ずつ2行**の .oni に分ける
      // （styles.css は触らない・既存クラスのみ。行間は .oni の gap と同じ 5px）
      const modeBtn = (m: (typeof modes)[number]) =>
        `<button class="lv${m.k === this.warpMode ? " on" : ""}" data-m="${m.k}"${
          m.ready ? "" : " disabled"
        }>${m.label}</button>`;
      host.innerHTML = `<h3>歪み</h3>
        <div id="ed-warpmode">
          <div class="oni">${modes.slice(0, 2).map(modeBtn).join("")}</div>
          <div class="oni" style="margin-top:5px">${modes.slice(2).map(modeBtn).join("")}</div>
        </div>
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
          ? "クリックした場所と同じ色の範囲を選択します。選択内ドラッグで枠だけ移動。"
          : "選択内ドラッグで枠だけ移動。絵を動かすには ✥ 移動ツール。"
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
      // M11-11: 数値の行は畳める（変形の状態には一切触らない・見た目だけ）
      const fold = this.xformNumFold;
      host.innerHTML = `<h3>変形（高精度・結果はドット確定）</h3>
      <div class="selacts">
        <button class="minibtn" id="ed-x-fold" title="回転・拡縮の数値を畳む/開く">${
          fold ? "▸ 数値をひらく" : "▾ 数値をたたむ"
        }</button>
        <button class="minibtn" id="ed-x-peek" title="押している間だけ下の絵を透かして見る">👁 下を見る</button>
      </div>
      <div id="ed-x-nums"${fold ? " hidden" : ""}>
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
      </div>
      <div class="selacts">
        <button class="minibtn ok" id="ed-x-ok">✔ 確定</button>
        <button class="minibtn" id="ed-x-cancel">✖ キャンセル</button>
      </div>`;
      $("#ed-x-fold").addEventListener("click", () => {
        this.xformNumFold = !this.xformNumFold;
        this.buildToolOptions();
      });
      // 押している間だけ透かす（ペンでもマウスでも同じ pointer 経路）。
      // 離す・指が外れる・キャンセルのいずれでも必ず戻す
      {
        const peek = $("#ed-x-peek");
        const on = (e: Event) => {
          e.preventDefault();
          this.setXformPeek(true);
        };
        const off = () => this.setXformPeek(false);
        peek.addEventListener("pointerdown", on);
        peek.addEventListener("pointerup", off);
        peek.addEventListener("pointercancel", off);
        peek.addEventListener("pointerleave", off);
      }
      if (fold) {
        // 畳んでいる間は数値の入力欄が無いので、以降の配線は飛ばす
        $("#ed-x-ok").addEventListener("click", () => this.commitTransform());
        $("#ed-x-cancel").addEventListener("click", () => {
          this.cancelTransform();
          this.setTool(this.prevTool === "transform" ? "pen" : this.prevTool);
        });
        return;
      }
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
  /** M11-11: 変形の数値の行を畳んでいるか（見た目だけ・変形の状態には触らない） */
  private xformNumFold = false;
  /** M11-11: 変形プレビューを透かしているか（押している間だけ true） */
  private xformPeek = false;
  /** 透かしを始めたキー。同じキーの keyup で戻す（コマンドの割り当てが変わっても追従する） */
  private peekCode: string | null = null;
  /** 直近の keydown の e.code（「押している間だけ」のコマンドへ渡す） */
  private peekPendingCode: string | null = null;

  /** M11-11: 変形プレビューの透かしを入/切する。**変形の状態は一切変えない**（描き直すだけ） */
  private setXformPeek(on: boolean, code: string | null = null) {
    if (this.xformPeek === on) {
      if (on && code) this.peekCode = code;
      return;
    }
    this.xformPeek = on;
    this.peekCode = on ? code : null;
    this.redrawOverlay();
  }

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
    // M11-8 P-4（REQ 表D）: 選択範囲があるときは**範囲内だけ**を揺らす（歪みツールと揃える）。
    // 全コマ共通の場（field）は変えず、適用時にマスクで弾く
    const clip = this.selMask ?? null;
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
        if (src && dst) applyWarp(src, dst, field, clip);
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
        // M11-7: 並べ替えで掴んだあとの click ではコマを切り替えない
        if (this.suppressFrameClick) return;
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
      // M11-7: 並べ替えは Pointer Events の自前ドラッグ（HTML5 DnD は実 exe で発火しない）
      fr.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        this.startFrameDrag(e, i);
      });
      // 保険: 万一ネイティブのドラッグが始まると pointermove を奪われる（M11-3 の実害）
      fr.addEventListener("dragstart", (e) => e.preventDefault());
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

  // ---------------- M11-7: フィルムのコマ並べ替え（Pointer Events 自前ドラッグ） ----------------
  // HTML5 DnD（draggable + dragstart/dragover/drop）は Tauri の dragDropEnabled が既定 true の
  // もとで **実 exe ではまったく発火しない**（ペンでもマウスでも🚫が出て掴めない）。
  // M3.9 H-2（レイヤー行）・M11-3（ライブラリのカード）と同じ pointer 方式へ置き換える。
  // 移動そのものは既存の reorderFrame(from, to) を通す＝履歴は「コマ並べ替え」のまま。
  private frameDrag: {
    from: number;
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    active: boolean;
    ghost: HTMLElement | null;
    line: HTMLElement | null;
    /** 挿入位置（0..frames.length）。null = 有効な落とし先が無い */
    gap: number | null;
    scrollDir: -1 | 0 | 1;
    raf: number | null;
    onMove: (e: PointerEvent) => void;
    onUp: (e: PointerEvent) => void;
    onBlur: () => void;
  } | null = null;
  /** ドラッグ確定後の click でコマを切り替えないための抑止（rowDrag / cardDrag と同じ） */
  private suppressFrameClick = false;
  /** 掴んだと判定する移動距離（px）。library の CARD_DRAG_THRESHOLD に揃える（時間条件は付けない） */
  private static readonly FRAME_DRAG_THRESHOLD = 6;
  /** フィルムの端からこの内側でオートスクロール（横一列なので必須） */
  private static readonly FILM_EDGE_PX = 40;

  private frameEl(i: number): HTMLElement | null {
    return document.querySelector(`#ed-film .fr[data-idx="${i}"]`) as HTMLElement | null;
  }

  private startFrameDrag(e: PointerEvent, from: number) {
    if (this.frameDrag) return;
    this.suppressFrameClick = false;
    // 掴んだポインタ以外（別の指・別のペン）のイベントは無視する
    const mine = (ev: PointerEvent) => this.frameDrag?.pointerId === ev.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (mine(ev)) this.updateFrameDrag(ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      // pointercancel は「何も起きなかった」で終わる（まだ並びを変えていないので失うものが無い）
      if (ev.type === "pointercancel") this.cancelFrameDrag();
      else this.finishFrameDrag();
    };
    const onBlur = () => this.cancelFrameDrag();
    this.frameDrag = {
      from,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      active: false,
      ghost: null,
      line: null,
      gap: null,
      scrollDir: 0,
      raf: null,
      onMove,
      onUp,
      onBlur,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onBlur);
  }

  private updateFrameDrag(ev: PointerEvent) {
    const d = this.frameDrag;
    if (!d) return;
    d.lastX = ev.clientX;
    d.lastY = ev.clientY;
    if (!d.active) {
      if (
        Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < Editor.FRAME_DRAG_THRESHOLD
      )
        return; // しきい値未満はクリック（コマ切替・Shift 範囲選択）のまま
      d.active = true;
      this.suppressFrameClick = true;
      const g = document.createElement("div");
      g.className = "drag-ghost"; // 既存クラス（レイヤー行・カードと共用）
      g.textContent = `コマ ${d.from + 1}`;
      document.body.appendChild(g);
      d.ghost = g;
      // 挿入位置の手がかり。新しいクラスを作らず、既存色をインラインで当てる
      //（`.drag-ghost` と同じ position:fixed なので、フィルムのスクロールとも噛み合う）
      const line = document.createElement("div");
      line.style.cssText =
        "position:fixed;z-index:121;pointer-events:none;width:3px;border-radius:2px;background:var(--green);";
      document.body.appendChild(line);
      d.line = line;
      const src = this.frameEl(d.from);
      if (src) src.style.opacity = "0.4"; // 掴んでいる元コマを薄く（styles.css は触らない）
    }
    if (d.ghost) {
      d.ghost.style.left = `${ev.clientX + 14}px`;
      d.ghost.style.top = `${ev.clientY + 16}px`;
    }
    d.gap = this.hitTestFrameDrag(ev.clientX, ev.clientY);
    this.showFrameIndicator(d.gap);
    d.ghost?.classList.toggle("invalid", d.gap === null);
    this.updateFilmAutoScroll(ev.clientX);
  }

  /** 画面座標 → 挿入位置（0..frames.length）。フィルムの外なら null */
  private hitTestFrameDrag(x: number, y: number): number | null {
    const film = document.querySelector("#ed-film") as HTMLElement | null;
    if (!film) return null;
    const fr = film.getBoundingClientRect();
    if (x < fr.left - 24 || x > fr.right + 24 || y < fr.top - 24 || y > fr.bottom + 24) return null;
    const els = [...film.querySelectorAll(".fr")] as HTMLElement[];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i; // このコマの手前へ
    }
    return els.length; // 末尾へ
  }

  private showFrameIndicator(gap: number | null) {
    const d = this.frameDrag;
    if (!d?.line) return;
    const film = document.querySelector("#ed-film") as HTMLElement | null;
    if (gap === null || !film) {
      d.line.style.display = "none";
      return;
    }
    const els = [...film.querySelectorAll(".fr")] as HTMLElement[];
    const fr = film.getBoundingClientRect();
    let x = fr.left;
    if (gap < els.length) x = els[gap].getBoundingClientRect().left - 4;
    else if (els.length > 0) x = els[els.length - 1].getBoundingClientRect().right + 1;
    x = Math.max(fr.left, Math.min(fr.right - 3, x));
    d.line.style.display = "";
    d.line.style.left = `${Math.round(x)}px`;
    d.line.style.top = `${Math.round(fr.top + 2)}px`;
    d.line.style.height = `${Math.round(fr.height - 4)}px`;
  }

  /** フィルムは横一列なので、端に来たら自動でスクロールする（無いと見えている範囲にしか運べない） */
  private updateFilmAutoScroll(clientX: number) {
    const d = this.frameDrag;
    const film = document.querySelector("#ed-film") as HTMLElement | null;
    if (!d || !film) return;
    const r = film.getBoundingClientRect();
    d.scrollDir =
      clientX < r.left + Editor.FILM_EDGE_PX ? -1 : clientX > r.right - Editor.FILM_EDGE_PX ? 1 : 0;
    if (d.scrollDir === 0) {
      this.stopFilmAutoScroll();
      return;
    }
    if (d.raf != null) return;
    const step = () => {
      const dd = this.frameDrag;
      const f = document.querySelector("#ed-film") as HTMLElement | null;
      if (!dd || !f || dd.scrollDir === 0) {
        if (dd) dd.raf = null;
        return;
      }
      f.scrollLeft += dd.scrollDir * 14;
      // 指を止めていてもコマが動くので、挿入位置を測り直す
      dd.gap = this.hitTestFrameDrag(dd.lastX, dd.lastY);
      this.showFrameIndicator(dd.gap);
      dd.raf = requestAnimationFrame(step);
    };
    d.raf = requestAnimationFrame(step);
  }

  private stopFilmAutoScroll() {
    const d = this.frameDrag;
    if (!d || d.raf == null) return;
    cancelAnimationFrame(d.raf);
    d.raf = null;
  }

  private finishFrameDrag() {
    const d = this.frameDrag;
    if (!d) return;
    const { from, gap, active } = d;
    this.endFrameDrag();
    // click は pointerup 直後に来るので、そのあとで必ず抑止を解く（rowDrag と同じ作法）
    if (active) setTimeout(() => (this.suppressFrameClick = false), 0);
    if (!active || gap === null) return;
    // gap（挿入位置）→ reorderFrame の to（取り除いたあとの添字）へ
    const to = gap > from ? gap - 1 : gap;
    this.reorderFrame(from, to); // 履歴（コマ並べ替え）も xformGuard も既存のまま
  }

  /** Esc / pointercancel / ウィンドウ外 → 何も起きない状態へ戻す（並びは動かさない） */
  cancelFrameDrag() {
    const d = this.frameDrag;
    if (!d) return;
    const wasActive = d.active;
    this.endFrameDrag();
    if (wasActive) setTimeout(() => (this.suppressFrameClick = false), 0);
  }

  private endFrameDrag() {
    const d = this.frameDrag;
    if (!d) return;
    this.stopFilmAutoScroll();
    window.removeEventListener("pointermove", d.onMove);
    window.removeEventListener("pointerup", d.onUp);
    window.removeEventListener("pointercancel", d.onUp);
    window.removeEventListener("blur", d.onBlur);
    d.ghost?.remove();
    d.line?.remove();
    const src = this.frameEl(d.from);
    if (src) src.style.opacity = "";
    this.frameDrag = null;
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
      if (!(await this.confirmLeave())) return;
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
    // M11-11: いま見ているコマ1枚を画像で保存（アニメの書き出しとは別の導線）
    $("#ed-imgexport").onclick = () => {
      if (this.xformGuard()) return; // 変形/歪みの未確定があるときは先に確定させる
      if (this.playing) this.stopPlayback();
      this.cb.openImageExport?.(
        this.project,
        this.frameIndex,
        (this.project.meta.title || "無題").replace(/\.[^.]+$/, "")
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
    this.refreshSelectionLauncher(); // M11-8: ズーム/リサイズ/回転反転に追従
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
    // M11-12: 浮動テキスト（実際のドット＋外接する薄い枠。選択範囲では切らない）
    if (this.textDraft) this.drawTextDraftPreview(ctx);
    // 自由選択の軌跡
    if (this.lassoPts.length > 1) {
      ctx.strokeStyle = "rgba(44,38,33,.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.lassoPts[0].x + 0.5, this.lassoPts[0].y + 0.5);
      for (const p of this.lassoPts) ctx.lineTo(p.x + 0.5, p.y + 0.5);
      ctx.stroke();
    }
    // M11-8 P-3: 選択の状態が変わる経路はすべてここを通るので、ランチャーもここで更新する
    this.refreshSelectionLauncher();
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
    // M11-11: 「下を見る」中は絵だけ薄くする（枠とハンドルは残す＝位置合わせの参考になる）
    if (this.xformPeek) ctx.globalAlpha = 0.18;
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
    ctx.restore();
    // M11-11: ハンドル（四隅＋回転ノブ）は**キャンバス座標**で描く。
    // 枠が画面の外へ出たハンドルは内側へ寄せて描く（外に描いても 320×240 の
    // オーバーレイでは見えず、掴めなくなるため）。寄せた印として色を変える
    const hs = this.xformHandleWorld();
    const topMid = hs[5];
    const knob = this.clampedHandle(hs[4].x, hs[4].y) ?? hs[4];
    ctx.save();
    ctx.strokeStyle = "#f07a1a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(topMid.x, topMid.y);
    ctx.lineTo(knob.x, knob.y);
    ctx.stroke();
    for (let i = 0; i < 5; i++) {
      const cl = this.clampedHandle(hs[i].x, hs[i].y);
      const p = cl ?? hs[i];
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(t.angle);
      ctx.fillStyle = cl ? "#f07a1a" : "#fff"; // 寄せたハンドルは塗りつぶし
      ctx.fillRect(-2, -2, 4, 4);
      ctx.strokeRect(-2, -2, 4, 4);
      ctx.restore();
    }
    ctx.restore();
  }

  /** M11-11: 変形ハンドルのキャンバス座標。[四隅4つ, 回転ノブ, 上辺中央] */
  private xformHandleWorld(): { x: number; y: number }[] {
    const f = this.floatBuf!;
    const t = this.xform;
    const cx = f.ox + f.w / 2 + t.tx;
    const cy = f.oy + f.h / 2 + t.ty;
    const hw = Math.abs((f.w / 2) * t.sx);
    const hh = Math.abs((f.h / 2) * t.sy);
    const cos = Math.cos(t.angle);
    const sin = Math.sin(t.angle);
    const w = (lx: number, ly: number) => ({
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    });
    return [w(-hw, -hh), w(hw, -hh), w(hw, hh), w(-hw, hh), w(0, -hh - 12), w(0, -hh)];
  }

  /** M11-11: キャンバスの外へ出たハンドルを内側へ寄せた位置。外に出ていなければ null */
  private clampedHandle(wx: number, wy: number): { x: number; y: number } | null {
    const M = 6; // 端からの余白（ドット）。□の半径 2 より大きくして枠線に潜らせない
    const x = Math.max(M, Math.min(W - M, wx));
    const y = Math.max(M, Math.min(H - M, wy));
    return x === wx && y === wy ? null : { x, y };
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
    // M11-6: pointercancel も **onPointerUp に流して確定させる**（据え置きの判断）。
    // 画素は move の時点で既にレイヤーへ書かれており（R.stamp / R.strokeSegment）、
    // 履歴を積むのは onPointerUp だけ。「無かったこと」にすると **Undo で戻せない絵**が残り、
    // 選択移動では切り出し済みの絵が消えたままになる。確定側の副作用は Undo 1回で戻せる。
    // ライブラリのカードドラッグが cancel を「何も起きなかった」にしているのは、
    // あちらが「まだ何も変えていない」＝取り消しても失うものが無いため（非対称でよい）
    wrap.onpointercancel = h("cancel", (e) => this.onPointerUp(e));
    // M11-5: ブラウザ側で解放されたときも「掴んでいる id」の記録を合わせる（記録のみ）
    wrap.onlostpointercapture = (e) => {
      if (this.capturedPointerId === (e as PointerEvent).pointerId) this.capturedPointerId = null;
    };
    // M11-5: 診断ビルドのみ — 「pointerdown が来ないのか、来ているのに何も起きないのか」を
    // 切り分けるため、接触していないときの出入りも記録する（通常ビルドでは登録しない）
    if (this.inputLog) {
      wrap.onpointerover = h("over", () => {});
      wrap.onpointerenter = h("enter", () => {});
      wrap.onpointerleave = h("leave", () => {});
      wrap.ongotpointercapture = h("gotcapture", () => {});
      wrap.onlostpointercapture = h("lostcapture", (e) => {
        if (this.capturedPointerId === e.pointerId) this.capturedPointerId = null;
      });
    }
  }

  /** M10-21: 入力診断ログ（フラグ時のみ到達）。IPC 連打を避けるため 400ms でまとめて書く */
  private logInput(name: string, e: PointerEvent, dtMs: number) {
    const co =
      "getCoalescedEvents" in e ? (e as unknown as { getCoalescedEvents(): unknown[] }).getCoalescedEvents().length : -1;
    this.inputLogBuf.push(
      // M11-5: id（ポインタごとの識別子）を追加。「ペンだけ効かない」は
      // 「その id のキャプチャが残っている」ときに起きるため、id 無しでは切り分けられない
      `[inputlog] ${name} pt=${e.pointerType} id=${e.pointerId} btn=${e.button} btns=${e.buttons} ` +
        `p=${e.pressure.toFixed(2)} co=${co} ${this.stateLine()} dt=${dtMs.toFixed(2)}ms`
    );
    this.flushInputLogSoon();
  }

  /** M11-5: 診断ビルド専用のアプリ内部状態スナップショット（フラグOFFでは呼ばれない） */
  private stateLine(): string {
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    const id = this.capturedPointerId;
    let held = "-";
    if (wrap && id != null) {
      try {
        held = wrap.hasPointerCapture(id) ? "yes" : "no";
      } catch {
        held = "?";
      }
    }
    return (
      `tool=${this.tool} down=${this.pointerDown ? 1 : 0} pan=${this.panState ? 1 : 0} ` +
      `space=${this.spaceHeld ? 1 : 0} shift=${this.shiftHeld ? 1 : 0} ` +
      `capId=${id ?? "-"} capHeld=${held} focus=${document.hasFocus() ? 1 : 0} vis=${document.visibilityState}`
    );
  }

  /** M11-5: キー入力の診断ログ（フラグ時のみ登録される）。
   *  **打った文字そのものは残さない**（作品の文字・レイヤー名・ファイル名が
   *  ログに平文で残ると、作者がログを渡しにくい）。1文字のキーは伏せ字にし、
   *  文字入力欄でのキーはそもそも記録しない。修飾キー・機能キーは診断に要るので残す */
  private keyLogHandler = (e: KeyboardEvent) => {
    if (this.isTextEntry(e.target)) return;
    const printable = e.key.length === 1;
    const mod =
      `${e.shiftKey ? "S" : "-"}${e.ctrlKey ? "C" : "-"}${e.altKey ? "A" : "-"}${e.metaKey ? "M" : "-"}`;
    // ショートカット判定に要るものだけ素で出す（修飾キー併用・エディタが見ている単キー）
    const named =
      !printable || e.ctrlKey || e.altKey || e.metaKey || e.key === " " || e.key.toLowerCase() === "h";
    this.inputLogBuf.push(
      `[inputlog] ${e.type} key=${named ? e.key : "*"} code=${named ? e.code : "*"} ` +
        `repeat=${e.repeat ? 1 : 0} mod=${mod} ` +
        this.stateLine()
    );
    this.flushInputLogSoon();
  };
  /** M11-5: ウィンドウのフォーカス出入りの診断ログ（フラグ時のみ登録される） */
  private winLogHandler = (e: Event) => {
    this.inputLogBuf.push(`[inputlog] win:${e.type} ${this.stateLine()}`);
    this.flushInputLogSoon();
  };

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

  /** M11-5: 掴んでいるポインタを解放する（掴んでいなければ何もしない） */
  private releaseCapture(pointerId?: number) {
    const id = pointerId ?? this.capturedPointerId;
    if (id == null) return;
    try {
      ($("#ed-cvwrap") as HTMLElement).releasePointerCapture(id);
    } catch {
      /* すでに解放済み・そのポインタが存在しない場合は何もしなくてよい */
    }
    if (this.capturedPointerId === id) this.capturedPointerId = null;
  }

  /** M11-5: 進行中の接触を「直前の位置で離した」ことにして畳む。
   *  pointerup が来ないまま終わった接触の後始末（フォーカス喪失・新しい接触の開始時）。
   *  描きかけのストロークは pointerup と同じ経路で確定する（履歴が飛ばない） */
  private endPointerSession(src: "blur" | "down" | "move" | "mount") {
    // 診断ビルドのみ: 自己修復が走った事実を残す（何回取りこぼしたかを数えられるように）
    if (this.inputLog && (this.pointerDown || this.capturedPointerId !== null)) {
      this.inputLogBuf.push(`[inputlog] heal from=${src} ${this.stateLine()}`);
      this.flushInputLogSoon();
    }
    const last = this.lastPointerEvent;
    this.lastPointerEvent = null;
    if (this.pointerDown && last) this.onPointerUp(last);
    this.pointerDown = false;
    if (this.panState) {
      this.panState = null;
      this.updatePanCursor();
    }
    this.releaseCapture();
  }

  private onPointerDown(e: PointerEvent) {
    // M10-19: 右ボタンでは何も始めない（Windows のペン長押しは右クリック扱いになるため、
    // contextmenu 抑止とセットで「長押しで点を描いてしまう」事故を防ぐ。中ボタンは従来どおり）
    // M10-21b: スポイトだけは例外 — 狙いを定めるゆっくりタップが長押し判定で右クリック化され
    // 「ペンで色が拾えない」の正体だった（実走ログで確定）。スポイトは何も描かないので
    // 長押し誤爆の実害が構造的に無く、右ボタンでも拾ってよい（contextmenu は抑止済み）
    if (e.button === 2 && this.tool !== "eyedrop") return;
    // M11-9 P-2: 再生中にキャンバスへ触れたら**再生を止める**。ただし**その接触では描かない**
    //（描きたければもう一度触れる＝作者の決定）。描かないツール（手のひら・スポイト・ズーム）でも
    // 同じく止める。トーストは出さない。pointerDown を立てないので、この接触の move/up は
    // 何もしないまま素通りする（M11-6 のツール切替と同じ畳み方）
    if (this.playing) {
      this.stopPlayback();
      return;
    }
    // M11-5: 前の接触が pointerup 無しで終わっていたら、ここで畳んでから始める
    //（フォーカスを奪われて up が届かなかった場合の自己修復。正常時は何もしない）
    if (this.pointerDown || this.capturedPointerId !== null) this.endPointerSession("down");
    this.shiftHeld = e.shiftKey; // M10-7: pointer 側の modifier を真実として同期
    this.lastPointerEvent = e;
    try {
      ($("#ed-cvwrap") as HTMLElement).setPointerCapture(e.pointerId);
      this.capturedPointerId = e.pointerId;
    } catch {
      /* 合成イベント・ペン切断時などは捕捉なしで続行 */
    }
    // E-1: 手のひら / Space一時パン（変形中でも画面移動は可能）
    if (this.tool === "hand" || this.spaceHeld) {
      if (this.spaceHeld) this.spacePanned = true; // M11-2: パンしたら単押し扱いにしない
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
      case "text": {
        // M11-12: 浮いている文字の上を押したらドラッグ（移動）。
        // それ以外の場所なら、今のものを確定してから新しい文字を始める
        const d = this.textDraft;
        const mask = d ? this.textDraftMask() : null;
        const org = d ? this.textDraftOrigin(d) : null;
        if (
          d &&
          mask &&
          org &&
          pt.x >= org.x &&
          pt.y >= org.y &&
          pt.x < org.x + mask.w &&
          pt.y < org.y + mask.h
        ) {
          this.textDrag = { ox: pt.x - d.x, oy: pt.y - d.y };
          // 入力欄からフォーカスを外す。ここを外さないと onKeyDown が isTextEntry で
          // 早期 return し続けるので、**矢印キーでの微調整が一生できない**
          //（入力欄にフォーカスがある間はカーソル移動が優先＝REQ の要求。
          //   打ち直したくなったら入力欄をクリックすれば戻れる）
          (document.querySelector("#ed-textinput") as HTMLTextAreaElement | null)?.blur();
          break;
        }
        void this.beginTextDraft(pt);
        break;
      }
      case "eyedrop": {
        this.pickColor(pt);
        // M10-21b: pick 後の同一接触では何も起きないようにする。pickColor → setTool で
        // ツールが pen 等へ切り替わったまま pointerDown が立っていると、接触が続く同じペンが
        // 「拾った色のストローク」を描いてしまう（実走ログ 1012–1015 行の実害）。
        // pointerDown を下ろしてキャプチャも解放し、この接触の move/up を素通しにする
        this.pointerDown = false;
        this.lastPointerEvent = null;
        this.releaseCapture(e.pointerId); // M11-5: 解放は1箇所に集約（掴んだ id も忘れる）
        return;
      }
      case "move": {
        // M11-8 P-2: 選択範囲があれば「範囲の中の絵だけ」、無ければレイヤー（フォルダなら中身全部）
        if (this.selMask) this.beginSelectionMove(pt);
        else this.beginLayerMove(pt);
        break;
      }
      case "select": {
        if (this.selMask && this.selMask[pt.y * W + pt.x]) {
          // M11-8 P-1: 範囲内のドラッグは**枠だけ**が動く（絵は動かない）。
          // 絵を動かすのは移動ツール（上の case "move"）
          this.beginSelMaskMove(pt);
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
    // M11-6: 掴んでいるポインタ以外の移動は無視する（ペンで描いている最中に
    // 手のひらが触れて線が飛ぶのを防ぐ）。**down 側には入れない** —
    // 取りこぼしたキャプチャを次の pointerdown で畳んで直すのが M11-5 の復帰経路で、
    // そのとき届く down は別 id になり得るため、弾くと直した症状が戻る。
    // ※ この判定は下の「buttons===0 で畳む」自己修復より**前**にある。つまり
    //   取りこぼしからの復帰は「同じポインタの移動 / 次の pointerdown / blur」で起こり、
    //   **別のポインタを動かすだけでは起こらない**。ここを緩めると、描いている最中に
    //   別のポインタがホバーしただけでストロークが終わってしまうため、この順序を選んでいる
    if (this.capturedPointerId !== null && e.pointerId !== this.capturedPointerId) return;
    this.shiftHeld = e.shiftKey; // M10-7: pointer 側の modifier を真実として同期
    // M11-5: 「押している最中」のはずなのに、どのボタンも押されていないイベントが来たら、
    // pointerup を取りこぼしている（ペンが浮いて戻ってきた等）。直前の位置で畳んで解放する。
    // これが無いと、かざしただけで線が引かれ、キャプチャも掴まれたままになる
    if (this.pointerDown && e.buttons === 0) {
      this.endPointerSession("move");
      return;
    }
    if (this.pointerDown) this.lastPointerEvent = e; // M11-5: 途切れたときの終端に使う
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
        case "text": {
          // M11-12: 浮動テキストのドラッグ（1ドット単位・パラメータの x/y を動かすだけ）
          if (!this.textDrag || !this.textDraft) break;
          this.textDraft.x = pt.x - this.textDrag.ox;
          this.textDraft.y = pt.y - this.textDrag.oy;
          this.redrawOverlay();
          break;
        }
        case "move": {
          if (this.dragMode === "selmove") this.updateSelectionMove(pt);
          else if (this.dragMode === "layermove") this.updateLayerMove(pt);
          break;
        }
        case "select": {
          if (this.dragMode === "selmask") {
            this.updateSelMaskMove(pt); // M11-8 P-1: 枠だけ動かす
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
    // M11-6: 掴んでいるポインタ以外の up では、描きかけのストロークを切らない
    //（2本目の指を離しただけでペンの線が終わってしまうのを防ぐ）
    if (this.capturedPointerId !== null && e.pointerId !== this.capturedPointerId) return;
    // M11-5: 掴んだままにしない（pointerup/pointercancel の暗黙解放に頼らず必ず解放する）。
    // pointerDown が立っていなくても解放だけは通す
    this.lastPointerEvent = null;
    this.releaseCapture(e.pointerId);
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
      case "text": {
        // M11-12: 掴んでいた文字を離すだけ（確定ではない。履歴も積まない）。
        // **フォーカスは入力欄へ戻さない** — 戻すと矢印キーでの1ドット調整ができなくなる
        this.textDrag = null;
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
      case "move": {
        if (this.dragMode === "selmove") this.commitSelectionMove();
        else if (this.dragMode === "layermove") this.commitLayerMove();
        break;
      }
      case "select": {
        if (this.dragMode === "selmask") {
          this.commitSelMaskMove(); // M11-8 P-1
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

  // ---------------- M11-8 P-1: 選択範囲（枠）だけの移動 ----------------
  // 選択範囲ツールで範囲内をドラッグしても**絵は動かさない**。動くのは点線の枠だけ。
  // 枠は画面外へ出てよい（`base` + dx/dy を保持し、見えている分だけを selMask に materialize
  // するので、外へ出して戻せば形が復活する）。完全に外へ出たまま離したら解除する。
  private selMaskDrag: {
    start: { x: number; y: number };
    /** 掴んだ時点のマスク（これを平行移動して毎回作り直す） */
    base: Uint8Array;
    /** 履歴用の before */
    before: Uint8Array;
    dx: number;
    dy: number;
  } | null = null;

  private beginSelMaskMove(pt: { x: number; y: number }) {
    if (!this.selMask) return;
    this.selMaskDrag = {
      start: pt,
      base: this.selMask.slice(),
      before: this.selMask.slice(),
      dx: 0,
      dy: 0,
    };
    this.dragMode = "selmask";
    this.refreshSelectionLauncher(); // ドラッグ中は隠す（離したら再表示）
  }

  /** base を (dx, dy) だけ平行移動したマスクを作る（画面外は落ちる＝表示用） */
  private shiftedMask(base: Uint8Array, dx: number, dy: number): Uint8Array {
    const m = new Uint8Array(PIXELS);
    for (let y = 0; y < H; y++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let x = 0; x < W; x++) {
        if (!base[y * W + x]) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        m[ny * W + nx] = 1;
      }
    }
    return m;
  }

  private updateSelMaskMove(pt: { x: number; y: number }) {
    const d = this.selMaskDrag;
    if (!d) return;
    d.dx = pt.x - d.start.x;
    d.dy = pt.y - d.start.y;
    this.selMask = this.shiftedMask(d.base, d.dx, d.dy);
    this.redrawOverlay();
  }

  /** M11-8: ドラッグ中の Escape ＝この移動だけ取り消す（掴んだ時点の枠へ戻す・履歴は積まない） */
  private cancelSelMaskMove() {
    const d = this.selMaskDrag;
    if (!d) return;
    this.selMaskDrag = null;
    this.dragMode = "";
    this.selMask = d.before;
    this.redrawOverlay();
  }

  private commitSelMaskMove() {
    const d = this.selMaskDrag;
    this.selMaskDrag = null;
    this.dragMode = "";
    if (!d) return;
    const moved = this.shiftedMask(d.base, d.dx, d.dy);
    const empty = !moved.some((v) => v !== 0);
    if (empty) {
      // 完全に画面外へ出た＝解除（REQ E）
      this.selMask = null;
      this.pushSelectionHistory("選択解除", d.before, null);
    } else if (d.dx !== 0 || d.dy !== 0) {
      this.selMask = moved;
      this.pushSelectionHistory("選択範囲の移動", d.before, moved.slice());
    } else {
      this.selMask = moved; // 動いていない＝履歴に積まない
    }
    this.redrawOverlay();
  }

  // ---------------- M11-8 P-2: レイヤー移動（絵そのものを動かす） ----------------
  // 選択範囲が無いとき: 選択中のレイヤー1枚（フォルダ選択中はその中の全レイヤー）。
  // 選択範囲があるとき: 既存の beginSelectionMove（extractFloat）へ委譲＝範囲内の絵だけ動く。
  // はみ出しは**掴んだ時点のスナップショットから毎回描き直す**ので、外へ出して戻せば復活し、
  // 離した時点（＝確定）で外に出ている分だけが落ちる。Undo は before スナップショットへ戻す。
  private layerDrag: {
    start: { x: number; y: number };
    ids: string[];
    before: Record<string, IndexBuf>;
    /** 掴んだ時点のコマ。ドラッグ中に表示コマが変わっても**掴んだコマだけ**を書き換える */
    frameIdx: number;
    dx: number;
    dy: number;
  } | null = null;

  /** いま動かす対象のレイヤー id（フォルダ選択中はフォルダ内の全レイヤー） */
  private moveTargetLayerIds(): string[] {
    if (this.selectedFolderId) {
      const ids = this.folderLayerIndices(this.selectedFolderId)
        .map((i: number) => this.project.layerDefs[i]?.id)
        .filter((v): v is string => !!v);
      if (ids.length > 0) return ids;
    }
    return this.activeLayerId ? [this.activeLayerId] : [];
  }

  private beginLayerMove(pt: { x: number; y: number }) {
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    const ids = this.moveTargetLayerIds().filter((id) => !!f.layers[id]);
    if (ids.length === 0) {
      this.cb.toast("動かせるレイヤーがありません");
      return;
    }
    const before: Record<string, IndexBuf> = {};
    for (const id of ids) before[id] = copyIndexBuf(f.layers[id]);
    this.layerDrag = { start: pt, ids, before, frameIdx: this.frameIndex, dx: 0, dy: 0 };
    this.dragMode = "layermove";
    this.refreshSelectionLauncher(); // ドラッグ中は隠す（離したら再表示）
  }

  /** before スナップショットを (dx, dy) だけずらして書き直す（画面外は落ちる＝確定時の切り捨て） */
  private applyLayerMove(dx: number, dy: number) {
    const d = this.layerDrag;
    // 掴んだコマを覚えておく（ドラッグ中に ←→ や再生でコマが変わっても、
    // 別のコマの絵を「前のコマのスナップショット」で塗り潰さない）
    const f = d ? this.project.frames[d.frameIdx] : null;
    if (!d || !f) return;
    for (const id of d.ids) {
      const dst = f.layers[id];
      const src = d.before[id];
      if (!dst || !src) continue;
      dst.fill(0);
      for (let y = 0; y < H; y++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let x = 0; x < W; x++) {
          const v = src[y * W + x];
          if (!v) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          dst[ny * W + nx] = v;
        }
      }
    }
  }

  private updateLayerMove(pt: { x: number; y: number }) {
    const d = this.layerDrag;
    if (!d) return;
    d.dx = pt.x - d.start.x;
    d.dy = pt.y - d.start.y;
    this.applyLayerMove(d.dx, d.dy);
    this.renderCanvas();
  }

  /** M11-8: ドラッグ中の Escape ＝この移動だけ取り消す（掴んだ時点の絵へ戻す・履歴は積まない） */
  private cancelLayerMove() {
    const d = this.layerDrag;
    if (!d) return;
    this.applyLayerMove(0, 0);
    this.layerDrag = null;
    this.dragMode = "";
    this.renderCanvas();
    this.paintFilmThumb(d.frameIdx);
    this.refreshSelectionLauncher();
  }

  private commitLayerMove() {
    const d = this.layerDrag;
    this.layerDrag = null;
    this.dragMode = "";
    if (!d) return;
    const frameIdx = d.frameIdx;
    const f = this.project.frames[frameIdx];
    if (!f) return;
    if (d.dx === 0 && d.dy === 0) return; // 動いていない＝履歴に積まない
    const after: Record<string, IndexBuf> = {};
    for (const id of d.ids) if (f.layers[id]) after[id] = copyIndexBuf(f.layers[id]);
    this.history.push(
      multiBufferChangeEntry(
        "レイヤーの移動",
        (id) => this.project.frames[frameIdx]?.layers[id] ?? null,
        d.before,
        after,
        () => {
          this.renderCanvas();
          this.redrawOverlay();
          this.paintFilmThumb(frameIdx);
        }
      )
    );
    this.dirty = true;
    this.renderCanvas();
    this.paintFilmThumb(frameIdx);
    this.refreshSelectionLauncher();
  }

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

  /** 選択範囲の中を消す。**選択は維持する**（M11-9 P-3）。
   *  Delete / Backspace・側パネルの「削除」・ランチャーの「消去」の3つの入口が
   *  同じ結果になるよう、実体はこの1つだけにしてある。
   *  M10-22 では「画素の削除とマスク解除を1エントリに束ねる」形だったが、
   *  解除しなくなったので履歴には**画素の変化だけ**を積む */
  private deleteSelection() {
    const buf = this.activeBuffer();
    if (!buf || !this.selMask) return;
    // M11-9: 選択を維持するようになったので、**消すものが無ければ何もしない**。
    // これが無いと Delete のキーリピートで空の履歴が積み上がり、64件の上限を押し出して
    // 本物の履歴（＝消す前の絵）が戻せなくなる（「消す」の changed 判定と同じ作法）
    let hit = false;
    for (let i = 0; i < PIXELS; i++) {
      if (this.selMask[i] && buf[i]) {
        hit = true;
        break;
      }
    }
    if (!hit) return;
    const before = copyIndexBuf(buf);
    R.deleteMasked(buf, this.selMask);
    this.pushBufferHistory("選択部分を消去", buf, before);
    this.renderCanvas();
    this.redrawOverlay();
    this.paintFilmThumb(this.frameIndex);
  }

  // ---------------- M11-8 P-3: 選択範囲ランチャー ----------------
  // 選択範囲の下に浮かぶバー。#ed-cvwrap は表示回転/反転の CSS transform を持つので、
  // その**外側**の #ed-stage に置く（変形モードラベルと同じ作法）。

  /** ボタンの定義。M11-9 P-5 で並び順とアイコンを確定:
   *  「範囲をいじる」3つ ｜ 「絵をどうにかする」4つ ｜ 解除（末尾＝誤爆しにくい位置）。
   *  sep:true の直前に細い区切り線を1本入れる */
  private static readonly SEL_OPS: { op: string; icon: string; title: string; sep?: boolean }[] = [
    { op: "invert", icon: "⬛⬜", title: "選択範囲を反転" },
    { op: "expand", icon: "⊕", title: "選択範囲を拡張（1ドット）" },
    { op: "contract", icon: "⊖", title: "選択範囲を縮小（1ドット）" },
    { op: "erase", icon: "🧽", title: "選択部分を消去", sep: true },
    { op: "cut-layer", icon: "✂", title: "切り取って新規レイヤー" },
    { op: "copy-layer", icon: "⧉", title: "コピーして新規レイヤー" },
    { op: "transform", icon: "⤢", title: "変形モードを起動" },
    { op: "deselect", icon: "✕", title: "選択を解除 (Esc)", sep: true },
  ];

  private launcherEl: HTMLElement | null = null;
  /** 外接矩形のキャッシュ（マスクの実体が変わったときだけ再計算＝毎回の全画素走査を避ける） */
  private selBBoxCache: {
    mask: Uint8Array;
    box: { x: number; y: number; w: number; h: number } | null;
  } | null = null;

  private selBBox(): { x: number; y: number; w: number; h: number } | null {
    if (!this.selMask) return null;
    if (this.selBBoxCache && this.selBBoxCache.mask === this.selMask) return this.selBBoxCache.box;
    const box = R.maskBBox(this.selMask);
    this.selBBoxCache = { mask: this.selMask, box };
    return box;
  }

  /** ドット座標 → クライアント座標（clientToPixel の逆写像。ドットの中心を返す） */
  private pixelToClient(x: number, y: number): { x: number; y: number } {
    const rect = ($("#ed-canvas") as unknown as HTMLCanvasElement).getBoundingClientRect();
    let u = (x + 0.5) / W;
    let v = (y + 0.5) / H;
    if (this.viewFlipH) u = 1 - u;
    let nx: number, ny: number;
    switch (this.viewRot) {
      case 90:
        nx = 1 - v;
        ny = u;
        break;
      case 180:
        nx = 1 - u;
        ny = 1 - v;
        break;
      case 270:
        nx = v;
        ny = 1 - u;
        break;
      default:
        nx = u;
        ny = v;
    }
    return { x: rect.left + nx * rect.width, y: rect.top + ny * rect.height };
  }

  private buildSelectionLauncher(): HTMLElement {
    const el = document.createElement("div");
    el.id = "ed-sel-launcher";
    el.className = "sel-launcher";
    for (const o of Editor.SEL_OPS) {
      if (o.sep) {
        const hr = document.createElement("span");
        hr.className = "sep";
        el.appendChild(hr);
      }
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.op = o.op;
      b.textContent = o.icon;
      b.title = o.title;
      b.setAttribute("aria-label", o.title);
      el.appendChild(b);
    }
    // ランチャーの上でキャンバスの描画が始まらないようにする（クリックを抜けさせない）。
    // キャンバスと同じ pointer 方式なので、ペンでもマウスでも同じように反応する
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    el.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement | null)?.closest("button") as HTMLElement | null;
      if (!t || !t.dataset.op) return;
      e.stopPropagation();
      this.selOp(t.dataset.op);
    });
    return el;
  }

  /** 表示/非表示と位置の更新。selMask が変わる経路（redrawOverlay）と
   *  表示が変わる経路（applyZoom・ステージのスクロール）から呼ぶ */
  private refreshSelectionLauncher() {
    if (!this.mounted) {
      this.hideSelectionLauncher();
      return;
    }
    const show =
      !!this.selMask &&
      !this.xformActive &&
      !this.cornerActive &&
      !this.playing &&
      !this.selMaskDrag &&
      !this.layerDrag &&
      !this.floatBuf;
    const box = show ? this.selBBox() : null;
    const stage = document.querySelector("#ed-stage") as HTMLElement | null;
    if (!show || !box || !stage) {
      this.hideSelectionLauncher();
      return;
    }
    let el = this.launcherEl;
    if (!el || !el.isConnected) {
      el = this.buildSelectionLauncher();
      stage.appendChild(el);
      this.launcherEl = el;
    }
    // 外接矩形の4隅を写像して画面上の AABB を出す（回転/反転に追従）
    const cs = [
      this.pixelToClient(box.x, box.y),
      this.pixelToClient(box.x + box.w - 1, box.y),
      this.pixelToClient(box.x, box.y + box.h - 1),
      this.pixelToClient(box.x + box.w - 1, box.y + box.h - 1),
    ];
    const left = Math.min(...cs.map((c) => c.x));
    const right = Math.max(...cs.map((c) => c.x));
    const top = Math.min(...cs.map((c) => c.y));
    const bottom = Math.max(...cs.map((c) => c.y));
    const sr = stage.getBoundingClientRect();
    const w = el.offsetWidth || 240;
    const h = el.offsetHeight || 32;
    const GAP = 10;
    let cx = (left + right) / 2 - w / 2;
    let cy = bottom + GAP;
    // 下に入りきらないときは上へ。上にも入らなければ下端に寄せる
    if (cy + h > sr.bottom - 4) {
      const above = top - GAP - h;
      cy = above >= sr.top + 4 ? above : sr.bottom - 4 - h;
    }
    // 左右は表示領域の内側へ寄せる
    cx = Math.min(Math.max(cx, sr.left + 4), Math.max(sr.left + 4, sr.right - 4 - w));
    el.style.left = `${cx - sr.left + stage.scrollLeft}px`;
    el.style.top = `${cy - sr.top + stage.scrollTop}px`;
  }

  private hideSelectionLauncher() {
    this.launcherEl?.remove();
    this.launcherEl = null;
  }

  /** ランチャーの8操作。すべて1操作＝履歴1エントリ */
  private selOp(op: string) {
    if (!this.selMask) return;
    if (this.xformGuard()) return;
    switch (op) {
      case "deselect": {
        const before = this.selMask.slice();
        this.selMask = null;
        this.pushSelectionHistory("選択解除", before, null);
        this.dirty = true;
        this.redrawOverlay();
        break;
      }
      case "invert":
        this.replaceSelection("選択範囲の反転", R.invertMask(this.selMask));
        break;
      case "expand":
        this.replaceSelection("選択範囲の拡張", R.expandMask(this.selMask));
        break;
      case "contract":
        this.replaceSelection("選択範囲の縮小", R.contractMask(this.selMask));
        break;
      case "erase":
        this.deleteSelection(); // M11-9 P-3: Delete キーと同じ実体（選択は維持）
        break;
      case "cut-layer":
        this.selectionToNewLayer(true);
        break;
      case "copy-layer":
        this.selectionToNewLayer(false);
        break;
      case "transform":
        this.setTool("transform");
        break;
    }
    this.refreshSelectionLauncher();
  }

  /** 反転/拡張/縮小の共通処理。空になったら解除する（REQ 表E） */
  private replaceSelection(label: string, next: Uint8Array) {
    if (!this.selMask) return;
    const before = this.selMask.slice();
    const empty = !next.some((v) => v !== 0);
    this.selMask = empty ? null : next;
    this.pushSelectionHistory(label, before, empty ? null : next.slice());
    this.dirty = true;
    if (empty) this.cb.toast("選択範囲が無くなりました");
    this.redrawOverlay();
  }


  /** ランチャー #6/#7。新規レイヤーは**全コマ**に作られ（レイヤーは作品全体の構造）、
   *  絵が入るのは今のコマだけ。構造の変更と画素の移動を**1エントリ**に束ねるので
   *  Undo 1回でレイヤーごと元に戻る */
  private selectionToNewLayer(cut: boolean) {
    const mask = this.selMask;
    const src = this.activeBuffer();
    const frame = this.project.frames[this.frameIndex];
    if (!mask || !src || !frame) return;
    const srcLayerId = this.activeLayerId;
    const idx = this.project.layerDefs.findIndex((l) => l.id === srcLayerId);
    if (idx < 0) return;
    // 何も入らないなら作らない（空レイヤーが増えるだけ）
    let any = false;
    for (let i = 0; i < PIXELS; i++)
      if (mask[i] && src[i]) {
        any = true;
        break;
      }
    if (!any) {
      this.cb.toast("選択範囲に絵がありません");
      return;
    }
    const id = newLayerId(this.project);
    // 「1つ上」＝ソースレイヤーの直上。親は**ソースと同じフォルダ**（REQ）
    const parent = this.project.layerDefs[idx].parent;
    const def: LayerDef = {
      id,
      name: `レイヤー${this.project.layerDefs.length + 1}`, // addLayer と同じ規則
      visible: true,
      opacity: 1,
      parent,
    };
    const insertAt = idx + 1;
    const frameIdx = this.frameIndex;
    const prevActive = srcLayerId;
    const beforeSrc = copyIndexBuf(src);
    const self = this;
    const apply = () => {
      self.project.layerDefs.splice(insertAt, 0, def);
      for (const f of self.project.frames) {
        f.layers[id] = allocIndexBuf(self.project);
        if (f.order) f.order.push(id); // コマ固有描画順があれば最上位に追加（addLayer と同じ）
      }
      const fr = self.project.frames[frameIdx];
      const s = fr?.layers[srcLayerId];
      const d = fr?.layers[id];
      if (s && d) {
        for (let i = 0; i < PIXELS; i++) {
          if (!mask[i] || !s[i]) continue;
          d[i] = s[i];
          if (cut) s[i] = 0;
        }
      }
      self.activeLayerId = id;
      self.afterLayerChange();
      self.paintFilmThumb(frameIdx);
      self.redrawOverlay();
    };
    const revert = () => {
      const i = self.project.layerDefs.findIndex((l) => l.id === id);
      if (i >= 0) self.project.layerDefs.splice(i, 1);
      for (const f of self.project.frames) {
        delete f.layers[id];
        if (f.order) f.order = f.order.filter((x) => x !== id);
      }
      const s = self.project.frames[frameIdx]?.layers[srcLayerId];
      if (s) s.set(beforeSrc as unknown as ArrayLike<number>);
      self.activeLayerId = self.project.layerDefs.some((l) => l.id === prevActive)
        ? prevActive
        : (self.project.layerDefs[self.project.layerDefs.length - 1]?.id ?? "");
      self.afterLayerChange();
      self.paintFilmThumb(frameIdx);
      self.redrawOverlay();
    };
    this.history.push({
      label: cut ? "切り取って新規レイヤー" : "コピーして新規レイヤー",
      undo: revert,
      redo: apply,
    });
    apply();
    this.cb.toast(cut ? "切り取って新規レイヤーへ移しました" : "新規レイヤーへコピーしました");
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
    this.applyHistory(() => this.history.undo());
  }

  /** M3.8 L-B: Ctrl+Y / ↷。変形・浮動中は無効 */
  private handleRedo() {
    if (this.xformActive || this.floatBuf || this.cornerActive) {
      this.cb.toast("変形中はやり直しできません");
      return;
    }
    this.applyHistory(() => this.history.redo());
  }

  /** M11-8: 履歴の適用中は「コマ構造の変更＝選択解除」を働かせない
   *（undo/redo が復元したマスクを afterFrameStructureChange が消してしまわないように） */
  private applyingHistory = false;
  private applyHistory(run: () => void) {
    this.applyingHistory = true;
    try {
      run();
    } finally {
      this.applyingHistory = false;
    }
    this.refreshSelectionLauncher();
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

  /** E-4: 変形/浮動中は他操作をロック（true=ブロックした）。
   *
   *  M11-12: 「別のことを始める」入口はほぼすべてここを通っている（コマ移動・レイヤー切替・
   *  保存・書き出し・画像で保存・エディタを離れる・クリップボード・消す…）。浮動テキストは
   *  **ブロックではなく確定**なので、判定の前にここで焼き切る。確定後は textDraft が
   *  null になるので、以降の判定は従来どおり。**確定経路を1箇所に集約する**ための配置 */
  private xformGuard(): boolean {
    if (this.textDraft) this.commitTextDraft();
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
    // M11-11: キャンバスの外へ出たハンドルは内側へ寄せて**描いてある**ので、その位置でも掴める。
    // 画面内にあるハンドルは上の判定で済んでいるので、ここは寄せたものだけを見る
    // （回転ゾーンのリングより先に見る＝寄せたハンドルがリングに飲まれないように）
    {
      const hs = this.xformHandleWorld();
      const locals: readonly (readonly [number, number])[] = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ];
      for (let i = 0; i < 5; i++) {
        const cl = this.clampedHandle(hs[i].x, hs[i].y);
        if (!cl) continue;
        if (Math.hypot(pt.x - cl.x, pt.y - cl.y) > HIT) continue;
        if (i === 4) return { mode: "rotate", cursor: ROTATE_CURSOR };
        const c = locals[i];
        const ga = Math.atan2(c[1], c[0]) + t.angle;
        const deg = ((((ga * 180) / Math.PI) % 180) + 180) % 180;
        return { mode: "scale", cursor: deg < 90 ? "nwse-resize" : "nesw-resize" };
      }
    }
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

  // ---------------- M11-12: 浮動テキスト（確定するまで直せる文字） ----------------
  //
  // 確定は **commitTextDraft() 1つ**に集約し、あらゆる離脱経路から必ず呼ぶ
  //（M11-5 の endPointerSession・M11-10 の endArrowSession と同じ作法）。
  // 呼び出し元: 確定ボタン / Ctrl+Enter / 別ツールへの切替（setTool）/ キャンバスの別の場所を
  // クリック / xformGuard()（＝コマ移動・レイヤー切替・保存・書き出し・エディタを離れる等、
  // 「別のことを始める」入口すべてが既に通っている関門）/ unmount()。

  /** 文字ツールでキャンバスを押した位置に浮動テキストを始める（既にあれば確定してから）。
   *  @font-face は遅延ロードなので、measure より前に**明示的に**ロードを待つ
   *  （これが無いと起動直後の1回目だけ幅がずれる。document.fonts.ready だけでは待たない） */
  private async beginTextDraft(pt: { x: number; y: number }) {
    await ensureFontsLoaded();
    this.commitTextDraft();
    this.textDraft = {
      text: "",
      x: pt.x,
      y: pt.y,
      family: this.textFamily,
      size: this.textSize,
      bold: this.textBold,
      vertical: this.textVertical,
    };
    this.textDraftCache = null;
    this.textDrag = null;
    this.buildToolOptions(); // 入力欄を使える状態にして
    this.focusTextInput(); //   そこへフォーカスを移す
    this.redrawOverlay();
  }

  /** 浮動テキストのマスク（キャッシュつき）。位置だけ動かしたときは作り直さない */
  private textDraftMask(): { w: number; h: number; data: Uint8Array } | null {
    const d = this.textDraft;
    if (!d) return null;
    // 区切りは本文に現れない NUL（本文に空白や改行が入っても取り違えない）
    const key = [d.text, d.family, d.size, d.bold, d.vertical].join("\u0000");
    if (this.textDraftCache?.key === key) return this.textDraftCache.mask;
    const mask = d.text
      ? R.textToMask(d.text, d.size, { family: d.family, bold: d.bold, vertical: d.vertical })
      : null;
    this.textDraftCache = { key, mask, cv: null, cvColor: "" };
    return mask;
  }

  /** マスクの左上を置く位置。
   *
   *  横書きは押した位置がそのまま左上。**縦書きは1列目（＝一番右の列）を押した位置に合わせる**ので、
   *  列が増えたぶんだけ左へずらす。これが無いと、改行するたびに1列目が右へ飛び出してしまう
   *  （「列が左へ進む」＝すでに書いた列はその場に留まり、新しい列が左に生える、が正しい見え方）。 */
  private textDraftOrigin(d: NonNullable<Editor["textDraft"]>): { x: number; y: number } {
    if (!d.vertical) return { x: d.x, y: d.y };
    const cols = d.text.split("\n").length;
    return { x: d.x - d.size * (cols - 1), y: d.y };
  }

  /** 浮動テキストを焼き込んで終わる。**すべての離脱経路はここを通す**。
   *
   *  - 入力欄が空 / 完全に画面外 / 選択範囲で全部そぎ落とされた → **何も焼かず履歴にも積まない**
   *  - 一部だけはみ出している → 画面内の分だけ焼く（切り出しは `stampMask` の責務）
   *  - 焼くときは履歴1エントリだけ（Undo 1回で完全に元へ戻る）
   *  @param silent DOM を触らない（unmount 中など） */
  commitTextDraft(silent = false) {
    const d = this.textDraft;
    if (!d) return;
    const mask = this.textDraftMask();
    this.textDraft = null;
    this.textDrag = null;
    this.textDraftCache = null;
    // 画面と1画素も重ならないなら、色解決（＝16bit昇格し得る）にも触れずに終わる
    const org = this.textDraftOrigin(d);
    const overlaps =
      !!mask && org.x < W && org.y < H && org.x + mask.w > 0 && org.y + mask.h > 0;
    if (overlaps && mask) {
      // 色解決（昇格でバッファ差し替えあり）→ バッファ取得の順を守る
      const color = this.currentColorIndex();
      const buf = this.activeBuffer();
      if (buf) {
        const before = copyIndexBuf(buf);
        R.stampMask(buf, mask, org.x, org.y, color, this.selMask ?? undefined);
        // 1画素も変わらなかったら履歴に積まない（選択範囲で全部そぎ落とされた場合など）。
        // 空エントリで履歴（上限64）を押し流さないため — M11-9 の Delete 連打と同じ理由
        let changed = false;
        for (let i = 0; i < before.length; i++)
          if (before[i] !== buf[i]) {
            changed = true;
            break;
          }
        if (changed) this.pushBufferHistory("文字", buf, before);
      }
    }
    if (silent) return;
    this.buildToolOptions(); // 入力欄を空にして押せない状態へ戻す
    this.renderCanvas();
    this.redrawOverlay();
    this.paintFilmThumb(this.frameIndex);
  }

  /** 浮動テキストを捨てる（何も焼かない・履歴にも積まない） */
  private cancelTextDraft() {
    if (!this.textDraft) return;
    this.textDraft = null;
    this.textDrag = null;
    this.textDraftCache = null;
    this.buildToolOptions();
    this.redrawOverlay();
  }

  /** 書体・サイズ・太さ・向きの変更を浮動テキストへ反映する（**位置は変えない**） */
  private syncTextDraftStyle() {
    if (!this.textDraft) return;
    this.textDraft.family = this.textFamily;
    this.textDraft.size = this.textSize;
    this.textDraft.bold = this.textBold;
    this.textDraft.vertical = this.textVertical;
  }

  /** 入力欄へフォーカスを移し、末尾にカーソルを置く */
  private focusTextInput() {
    const ta = document.querySelector("#ed-textinput") as HTMLTextAreaElement | null;
    if (!ta || ta.disabled) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** マスク → 単色のプレビュー用キャンバス（色を変えたときだけ作り直す）。
   *  索引バッファには一切触れない＝ここでの色は**画面表示だけ**のもの */
  private textDraftCanvas(
    mask: { w: number; h: number; data: Uint8Array },
    hex: string
  ): HTMLCanvasElement {
    const c = this.textDraftCache;
    if (c && c.cv && c.cvColor === hex) return c.cv;
    const cv = document.createElement("canvas");
    cv.width = mask.w;
    cv.height = mask.h;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(mask.w, mask.h);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    for (let i = 0; i < mask.data.length; i++) {
      if (!mask.data[i]) continue;
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (c) {
      c.cv = cv;
      c.cvColor = hex;
    }
    return cv;
  }

  /** 浮動テキストのプレビュー（実際のドット＋外接する薄い枠）。
   *
   *  **選択範囲では切らない**。焼くときは範囲内だけに入るが、浮いている間に隠すと
   *  どこへ置かれるのか見えず調整できない。この非対称は要件で意図されたもの（REQ §選択範囲との関係）。 */
  private drawTextDraftPreview(ctx: CanvasRenderingContext2D) {
    const d = this.textDraft;
    if (!d) return;
    const mask = this.textDraftMask();
    const org = this.textDraftOrigin(d);
    ctx.save();
    ctx.strokeStyle = "rgba(240,122,26,.75)";
    ctx.lineWidth = 1;
    if (!mask) {
      // 空のうちは「ここに置かれる」ことだけ示す（1行ぶんの縦棒）
      const h = Math.max(2, Math.ceil(d.size * 1.35));
      ctx.beginPath();
      ctx.moveTo(d.x + 0.5, d.y);
      ctx.lineTo(d.x + 0.5, d.y + h);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.imageSmoothingEnabled = false;
    // 透明（消しゴム色）のときは見えないので、灰色で形だけ見せる
    ctx.drawImage(this.textDraftCanvas(mask, this.colorHex || "#888888"), org.x, org.y);
    ctx.strokeRect(org.x - 0.5, org.y - 0.5, mask.w + 1, mask.h + 1);
    ctx.restore();
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

  /** M11-2: 「消す」は**選択中のレイヤーだけ**を対象にする（従来はページ全体だった）。
   *  - フォルダ選択中は配下の全レイヤー（ネスト含む・再帰）。**レイヤー構造は残す**
   *  - 選択範囲があるときは範囲内だけ（M10-22 のクリップ方針と揃える）
   *  - **非表示レイヤーも消す**（表示状態は対象判定に使わない。「見えないから残った」ほうが事故）
   *  - Undo は multiBufferChangeEntry で1エントリ（フォルダで何枚消しても Ctrl+Z 1回） */
  private async clearFrame() {
    if (this.xformGuard()) return; // E-4: 浮動中は焼き込み前なので消させない
    // 確認ダイアログの間にコマが進むと「見ていたコマ」と対象がずれるので先に止める
    //（📷 画像取り込みと同じ流儀）
    if (this.playing) this.stopPlayback();
    const frame = this.project.frames[this.frameIndex];
    if (!frame) return;
    const folder = this.selectedFolderId
      ? this.folderById(this.selectedFolderId)
      : undefined;
    const targets = folder
      ? this.project.layerDefs.filter((ld) => this.ancestorChain(ld.parent).includes(folder.id))
      : this.project.layerDefs.filter((ld) => ld.id === this.activeLayerId);
    if (targets.length === 0) {
      this.cb.toast(folder ? "このフォルダにはレイヤーがありません" : "レイヤーが選ばれていません");
      return;
    }
    const scope = this.selMask ? "選択した範囲だけ" : "ぜんぶ";
    const ok = await this.cb.confirm(
      folder
        ? `フォルダ「${folder.name}」の中のレイヤー${targets.length}枚について、このページの絵を${scope}消しますか？（レイヤーは残ります）`
        : `レイヤー「${targets[0].name}」のこのページの絵を${scope}消しますか？`
    );
    if (!ok) return;
    const mask = this.selMask;
    const before: Record<string, IndexBuf> = {};
    const after: Record<string, IndexBuf> = {};
    for (const ld of targets) {
      const buf = frame.layers[ld.id];
      if (!buf) continue;
      const b = copyIndexBuf(buf);
      if (mask) R.deleteMasked(buf, mask);
      else buf.fill(0);
      let changed = false;
      for (let i = 0; i < buf.length; i++)
        if (buf[i] !== b[i]) {
          changed = true;
          break;
        }
      if (!changed) continue; // 元から空のレイヤーは履歴に含めない
      before[ld.id] = b;
      after[ld.id] = copyIndexBuf(buf);
    }
    if (Object.keys(before).length === 0) {
      this.cb.toast("消せる絵がありませんでした");
      return;
    }
    // バッファ実体は構造 undo/redo で作り直され得るので、Frame オブジェクト起点で適用時に解決する
    const self = this;
    this.history.push(
      multiBufferChangeEntry(
        "消す",
        (id) => frame.layers[id] ?? null,
        before,
        after,
        () => {
          self.dirty = true;
          self.renderCanvas();
          const fi = self.project.frames.indexOf(frame);
          if (fi >= 0) self.paintFilmThumb(fi);
        }
      )
    );
    // afterStructuralChange は「今表示中のコマ」のサムネを塗るが、対象は確認ダイアログ前に
    // 捉えたコマなので、ここは対象コマのサムネを塗る（矢印キー等でコマが動いていても整合）
    this.dirty = true;
    this.renderCanvas();
    const fi = this.project.frames.indexOf(frame);
    if (fi >= 0) this.paintFilmThumb(fi);
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
    const total = this.project.frames.length;
    if (total <= 1) {
      this.cb.toast("最後のコマは削除できません");
      return;
    }
    // M11-9 P-4: フィルムで範囲選択（Shift+クリック）しているときは、その範囲をまとめて削除する。
    // ただし範囲は ←→ や再生でコマが動いても残る（SE配置やページコピーがその前提で使う）ので、
    // **いま見ているコマが範囲の中にあるときだけ**まとめて削除する。外にいるときは
    // 従来どおり「いま見ているコマ」1枚（見ていない場所が黙って消えるのを防ぐ）
    const sel = this.rangeSel;
    const selA = sel ? Math.max(0, Math.min(sel.a, sel.b)) : -1;
    const selB = sel ? Math.min(total - 1, Math.max(sel.a, sel.b)) : -1;
    const useRange = sel != null && this.frameIndex >= selA && this.frameIndex <= selB;
    const at = useRange ? selA : this.frameIndex;
    const end = useRange ? selB : this.frameIndex;
    const count = end - at + 1;
    if (count >= total) {
      this.cb.toast("すべてのコマは削除できません（1枚は残す必要があります）");
      return;
    }
    if (count > 1) {
      const ok = await this.cb.confirm(
        `${count}枚のコマを削除します。よろしいですか？\n（コマ ${at + 1}〜${end + 1}）`
      );
      if (!ok) return;
      // 確認の間にコマ構造が変わっていたら中止（ダイアログ中の変更は無いはずだが保険）
      if (this.project.frames.length !== total) return;
    }
    // 削除するコマの実体を保持しておく（SEの配置 Frame.se も frame ごと持ち帰る＝undo で戻る）
    const removed = this.project.frames.slice(at, at + count);
    const self = this;
    const apply = () => {
      self.project.frames.splice(at, count);
      // 1枚のときは従来どおり「詰まってきたコマ」、複数のときは削除範囲の直前
      self.frameIndex =
        count > 1
          ? Math.max(0, Math.min(at - 1, self.project.frames.length - 1))
          : Math.min(at, self.project.frames.length - 1);
      self.afterFrameStructureChange();
    };
    const revert = () => {
      // 削除中にプロジェクトが16bit昇格していると frame が8bitのまま取り残される
      for (const f of removed) conformFrameWidth(self.project, f);
      self.project.frames.splice(at, 0, ...removed);
      self.frameIndex = at;
      self.afterFrameStructureChange();
    };
    this.history.push({ label: count > 1 ? `コマ削除（${count}枚）` : "コマ削除", undo: revert, redo: apply });
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

  /** M11-8 P-4（REQ 表E）: 「コマが移動した」ときの選択解除。解除の入口をここ1つに集約する
   *（gotoFrame＝←→キー/タイムライン、startPlayback＝再生、afterFrameStructureChange＝
   *  コマの追加・削除・並べ替え）。履歴には積まない（従来の gotoFrame と同じ） */
  private clearSelectionOnFrameMove() {
    if (!this.selMask) return;
    this.selMask = null;
    if (this.mounted) this.redrawOverlay();
  }

  gotoFrame(i: number) {
    if (i < 0 || i >= this.project.frames.length) return;
    // M11-10: コマが動く前に、矢印キーの移動セッションを確定する（下のドラッグ判定より先。
    // セッションは layerDrag / selMaskDrag を使うので、確定させてから通す）
    this.endArrowSession();
    if (this.xformGuard()) return; // E-4: 変形中はコマ移動をブロック
    // M11-8: ドラッグ中にコマが変わると、掴んだコマ以外の絵を壊す/選択が宙に浮く
    if (this.pointerDown || this.layerDrag || this.selMaskDrag) return;
    this.clearSelectionOnFrameMove();
    // M11-1: 別の位置へ飛んだら、前の位置で鳴り始めたSEは止める（BGMには触れない。
    // 再生ループはここを通らず frameIndex を直接進めるので、通常再生のSEは切れない）
    this.audioPreview.stopSe();
    this.frameIndex = i;
    this.renderCanvas();
    this.redrawOverlay();
    this.updateFilmSelection();
    this.seSectionRefresh?.(); // M5-1: 音声パネルの「配置先」表示を追従
  }

  // ---------------- 再生 ----------------

  togglePlayback() {
    // M11-2: ストローク中（ペンが接地したまま）に再生を始めると、コマが進んだ先で
    // 描き続けたストロークが「開始コマの before」で履歴に積まれ、Ctrl+Z が別コマを
    // 壊す（レビュー検出）。キー操作から呼ばれ得るようになったので入口で塞ぐ
    if (this.pointerDown) return;
    if (!this.playing && this.xformGuard()) return; // E-4
    // M11-9 P-1: ⏸ は「一時停止」＝SEは続きから鳴らせるように畳む（▶ で続きから）
    if (this.playing) this.stopPlayback(true);
    else this.startPlayback();
  }

  /** M5-1: 指定コマに配置されたSEを発火（多重可・muted/volumeはトラック別）。
   *  M11-9: skipIds に入っているものは鳴らさない（一時停止から続きを鳴らしたSEの二重発火を防ぐ） */
  private fireFrameSe(i: number, skipIds?: string[]) {
    const a = this.project.audio;
    if (!a || a.se.length === 0) return;
    const ids = this.project.frames[i]?.se;
    if (!ids) return;
    for (const id of ids) {
      if (skipIds && skipIds.includes(id)) continue;
      const t = a.se.find((s) => s.id === id);
      if (t) this.audioPreview.fireSe(t);
    }
  }

  private startPlayback() {
    if (this.playing) return;
    this.playing = true;
    // M11-8 P-4（REQ 表E）: 再生はコマを進めるので選択を解除する
    //（再生ループは gotoFrame を通らず frameIndex を直接進めるため、ここで1回だけ）
    this.clearSelectionOnFrameMove();
    $("#ed-play").textContent = "⏸";
    const fps = FPS_TABLE[this.project.speedIndex] || 8;
    // M6-2/3: BGMプレビュー（開始フレーム位置に頭出し・ループ毎リセット）
    // M5-1: 速度連動 rate（ピッチも変わる=原作準拠）＋SEのコマ発火
    const a = this.project.audio ?? null;
    const rate = a?.bgm ? bgmPlaybackRate(this.project.speedIndex, a.bgm.baseSpeedIndex) : 1;
    void this.audioPreview.start(a?.bgm ?? null, this.frameIndex / fps, rate);
    // M11-9 P-1: 一時停止で畳んだSEを続きから鳴らす。start() は同期的に「鳴っているSE」だけを
    // 止めて畳んだ分には触れないので、この順で呼べる
    const resumedSe = this.audioPreview.resumeSe();
    // Codex指摘#3: デコードは「配置済みかつ非ミュート」のSEだけ（未使用SEをキャッシュしない）
    if (a && a.se.length > 0) {
      const used = new Set<string>();
      for (const f of this.project.frames) for (const id of f.se ?? []) used.add(id);
      void this.audioPreview.prepareSe(a.se.filter((s) => !s.muted && used.has(s.id)));
    }
    // 開始コマのSEも鳴らす（続きから鳴らしたものは頭から鳴らし直さない）
    this.fireFrameSe(this.frameIndex, resumedSe);
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

  /** pause=true は ⏸（あとで ▶ で続きから）。それ以外の停止経路（画面を離れる・書き出し・
   *  キャンバスに触れた・ループしない作品が終端に達した等）は**続きを捨てる**（M11-9 P-1） */
  private stopPlayback(pause = false) {
    this.playing = false;
    if (pause) this.audioPreview.pause();
    else this.audioPreview.stop();
    if (this.playTimer != null) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    const btn = document.querySelector("#ed-play");
    if (btn) btn.textContent = "▶";
    if (this.mounted) this.renderCanvas();
    this.refreshSelectionLauncher();
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
    // M11-9: コマ構造が変わったら、鳴っているSEと畳んだ「続き」を捨てる（gotoFrame と同じ扱い。
    // 消えたコマに置かれていた音が鳴り続けたり、あとから続きが鳴ったりしないように）
    this.audioPreview.stopSe();
    // M11-8 P-4（REQ 表E）: コマの追加・削除・並べ替えは「コマの移動」を伴うので選択を解除する。
    // ここは undo/redo のクロージャからも呼ばれるため、履歴の適用中だけは触らない
    //（pushSelectionHistory が復元したマスクを直後に消してしまわないように）
    if (!this.applyingHistory) this.clearSelectionOnFrameMove();
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

  /** M11-2: ダイアログ（確認・保存先ピッカー・音声パネル等）が開いているか。
   *  `modalDepth` はゆらゆらダイアログしか増やさないため、main.ts の `modal()` が作る
   *  `.modal-back` の実在も見る。**再生トグルを裏で走らせないための番人**（レビュー検出） */
  private dialogOpen(): boolean {
    return this.modalDepth > 0 || !!document.querySelector(".modal-back");
  }

  /** M11-2: 文字入力中か（Space/Enter のショートカットを発火させない対象）。
   *  target が window など HTMLElement でない場合は false */
  private isTextEntry(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== "string") return false;
    const tag = el.tagName;
    return (
      tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el.isContentEditable === true
    );
  }

  // ---------------- M11-10: ショートカット（コマンド解決） ----------------

  /** キー → コマンドID の引き当て表（キー1打ごとに線形探索しない） */
  private keyLookup = new Map<string, CommandId>();
  private static readonly REPEATABLE = new Set<string>(
    COMMANDS.filter((c) => (c as { repeatable?: boolean }).repeatable).map((c) => c.id)
  );

  /** プリセットを適用する（設定画面から切り替えたときも同じ入口） */
  applyKeyPreset(preset: Preset) {
    this.keyLookup = buildLookup(preset);
  }

  /** UI のボタンを押す（ボタン側のガードをそのまま通したいコマンド用） */
  private clickUi(sel: string) {
    (document.querySelector(sel) as HTMLElement | null)?.click();
  }

  /** M11-10: コマンドの実行。**既存のボタンと同じ処理を呼ぶだけ**（新機能は作らない） */
  private runCommand(id: CommandId) {
    switch (id) {
      // 道具
      case "tool.pen":
      case "tool.brush":
      case "tool.eraser":
      case "tool.fill":
      case "tool.shape":
      case "tool.text":
      case "tool.eyedrop":
      case "tool.hand":
      case "tool.move":
      case "tool.select":
      case "tool.transform":
      case "tool.warp":
        this.setTool(id.slice(5) as Tool);
        break;
      // ペンの太さ
      case "pen.sizeDown":
      case "pen.sizeUp": {
        const i = PEN_SIZES.indexOf(this.penSize);
        const ni = Math.max(
          0,
          Math.min(PEN_SIZES.length - 1, (i < 0 ? 2 : i) + (id === "pen.sizeUp" ? 1 : -1))
        );
        this.penSize = PEN_SIZES[ni];
        this.refreshSizePicker();
        break;
      }
      case "pen.size1":
      case "pen.size2":
      case "pen.size3":
      case "pen.size4":
      case "pen.size5":
      case "pen.size6":
        this.penSize = PEN_SIZES[Number(id.slice(8)) - 1];
        this.refreshSizePicker();
        break;
      // 編集
      case "edit.undo":
        this.handleUndo();
        break;
      case "edit.redo":
        this.handleRedo();
        break;
      case "edit.copy":
        this.copySelection(false);
        break;
      case "edit.cut":
        this.copySelection(true);
        break;
      case "edit.paste":
        this.pasteClipboard();
        break;
      case "edit.deleteSelection":
        if (this.selMask) this.deleteSelection();
        break;
      case "edit.copyPrev":
        this.copyPrevFrame();
        break;
      case "edit.clearFrame":
        void this.clearFrame();
        break;
      // ファイル
      case "file.save":
        void this.save();
        break;
      case "file.saveAs":
        void this.saveAs();
        break;
      case "file.export":
        this.clickUi("#ed-export");
        break;
      case "file.image":
        this.clickUi("#ed-tool-image");
        break;
      case "file.audio":
        this.clickUi('#ed-tools .tool[data-tool="audio"]');
        break;
      // コマ
      case "frame.prev":
        this.gotoFrame(this.frameIndex - 1);
        break;
      case "frame.next":
        this.gotoFrame(this.frameIndex + 1);
        break;
      case "frame.add":
        this.addFrame(false);
        break;
      case "frame.duplicate":
        this.addFrame(true);
        break;
      case "frame.delete":
        void this.deleteFrame();
        break;
      case "frame.copyPage":
        this.copySelectedFrames();
        break;
      case "frame.pastePage":
        this.pasteFrames();
        break;
      case "frame.wobble":
        void this.onWobbleClick();
        break;
      // 再生・表示
      case "play.toggle":
        this.togglePlayback();
        break;
      case "play.loop":
        this.clickUi("#ed-loop");
        break;
      case "view.zoomIn":
        this.adjustZoom(+1);
        break;
      case "view.zoomOut":
        this.adjustZoom(-1);
        break;
      case "view.rotate":
        this.clickUi("#ed-view-rot");
        break;
      case "view.flip":
        this.clickUi("#ed-view-flip");
        break;
      case "xform.peek":
        // 押している間だけ透かす。戻すのは keyup（peekCode が一致したとき）
        if (this.xformActive) this.setXformPeek(true, this.peekPendingCode);
        break;
    }
  }

  // ---------------- M11-10: 矢印キーの1ドット移動（移動セッション） ----------------
  // キーボードには「離す」が無いので、ドラッグと違ってセッションを持たざるを得ない。
  // 確定は **endArrowSession() 1つ**に集約し、あらゆる離脱経路から必ず呼ぶ
  //（M11-5 の endPointerSession と同じ作法）。加えて 800ms の自動確定で状態を長く残さない。

  /** 進行中の移動セッションの種類（""＝無し） */
  private arrowKind: "" | "layer" | "selmask" | "selmove" = "";
  private arrowDx = 0;
  private arrowDy = 0;
  private arrowTimer: number | null = null;
  /** 最後の矢印キーからこの時間が経ったら自動で確定する（仮の値・REQ 未決6） */
  private static readonly ARROW_COMMIT_MS = 800;
  /** Shift＋矢印の移動量（仮の値・REQ 未決7） */
  private static readonly ARROW_BIG_STEP = 10;

  /** 移動セッションを確定する（履歴は1エントリ）。セッションが無ければ何もしない */
  endArrowSession() {
    const kind = this.arrowKind;
    if (this.arrowTimer != null) {
      clearTimeout(this.arrowTimer);
      this.arrowTimer = null;
    }
    if (!kind) return;
    this.arrowKind = "";
    this.arrowDx = 0;
    this.arrowDy = 0;
    if (kind === "layer") this.commitLayerMove();
    else if (kind === "selmask") this.commitSelMaskMove();
    else if (kind === "selmove") this.commitSelectionMove();
  }

  /** 移動セッションを取り消す（動かす前の位置へ戻す・履歴には積まない） */
  private cancelArrowSession() {
    const kind = this.arrowKind;
    if (this.arrowTimer != null) {
      clearTimeout(this.arrowTimer);
      this.arrowTimer = null;
    }
    if (!kind) return;
    this.arrowKind = "";
    this.arrowDx = 0;
    this.arrowDy = 0;
    if (kind === "layer") this.cancelLayerMove();
    else if (kind === "selmask") this.cancelSelMaskMove();
    else if (kind === "selmove") this.cancelSelectionMove();
  }

  private scheduleArrowCommit() {
    if (this.arrowTimer != null) clearTimeout(this.arrowTimer);
    this.arrowTimer = window.setTimeout(() => {
      this.arrowTimer = null;
      this.endArrowSession();
    }, Editor.ARROW_COMMIT_MS);
  }

  /** 矢印キー（割り当て対象外・モードで意味が変わる固定キー） */
  private handleArrowKey(e: KeyboardEvent) {
    const step = e.shiftKey ? Editor.ARROW_BIG_STEP : 1;
    const dx = e.code === "ArrowLeft" ? -step : e.code === "ArrowRight" ? step : 0;
    const dy = e.code === "ArrowUp" ? -step : e.code === "ArrowDown" ? step : 0;
    if (dx === 0 && dy === 0) return;
    // ① 変形モード中: 平行移動量を ±1 するだけ（確定は既存の Enter / 取消は Esc）。
    //    何回押しても履歴は確定時の1つ
    if (this.xformActive && this.floatBuf) {
      e.preventDefault();
      this.xform.tx += dx;
      this.xform.ty += dy;
      this.redrawOverlay();
      this.buildToolOptions(); // 数値表示を追従
      return;
    }
    // ①'' 浮動テキスト中: 位置（パラメータの x/y）を動かすだけ。確定は Ctrl+Enter / 取消は Esc
    //     なので、何回押しても履歴は確定時の1つ。
    //     **入力欄にフォーカスがある間はここへ来ない**（onKeyDown が isTextEntry で早期 return
    //     する＝文字カーソルの移動が優先。REQ の要求どおり）
    if (this.textDraft) {
      e.preventDefault();
      this.textDraft.x += dx;
      this.textDraft.y += dy;
      this.redrawOverlay();
      return;
    }
    // ①' 四隅変形中: 4点をまとめて平行移動する（形は変えずに位置だけ動かす）。
    //     確定/取消は既存のまま（Enter / Esc）なので、履歴はやはり確定時の1つ
    if (this.cornerActive) {
      e.preventDefault();
      this.cornerPts = this.cornerPts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      this.updateCornerPreview();
      return;
    }
    // ② 移動ツール / ③ 選択範囲ツール（枠だけ）
    const kind: "" | "layer" | "selmask" | "selmove" =
      this.tool === "move"
        ? this.selMask
          ? "selmove"
          : "layer"
        : this.tool === "select" && this.selMask
          ? "selmask"
          : "";
    if (kind) {
      e.preventDefault();
      if (this.arrowKind !== kind) {
        // 種類が変わったら前のセッションを確定してから始める
        this.endArrowSession();
        const at = { x: 0, y: 0 };
        if (kind === "layer") this.beginLayerMove(at);
        else if (kind === "selmask") this.beginSelMaskMove(at);
        else this.beginSelectionMove(at);
        // begin が失敗した（動かす対象が無い）ときはセッションを持たない
        const started =
          kind === "layer" ? !!this.layerDrag : kind === "selmask" ? !!this.selMaskDrag : !!this.floatBuf;
        if (!started) return;
        this.arrowKind = kind;
        this.arrowDx = 0;
        this.arrowDy = 0;
      }
      this.arrowDx += dx;
      this.arrowDy += dy;
      const at = { x: this.arrowDx, y: this.arrowDy };
      if (kind === "layer") this.updateLayerMove(at);
      else if (kind === "selmask") this.updateSelMaskMove(at);
      else this.updateSelectionMove(at);
      this.scheduleArrowCommit();
      return;
    }
    // ④ それ以外は従来どおり前後のコマ（↑↓ は従来どおり何もしない）
    if (dx < 0) this.gotoFrame(this.frameIndex - 1);
    else if (dx > 0) this.gotoFrame(this.frameIndex + 1);
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this.mounted) return;
    // M10-3 P-8: 自前ダイアログが開いている間はエディタのショートカットを一切通さない。
    // ダイアログ側の capture リスナーだけに頼ると、イベントの target が window そのものの
    // ときに同一要素のリスナー順で抜けてしまう（Escape で選択解除まで走る）
    // M11-7 P-3: 判定を `dialogOpen()` に広げる。`modalDepth` を増やすのは
    // ゆらゆらダイアログだけで、main.ts の `modal()`（ドロップの選択・取り込み進捗・
    // 保存先ピッカー等）は増やさないため、その裏で Escape/Delete がここまで届いていた。
    // カウンタを2箇所で上げ下げすると**片方が漏れた瞬間にショートカットが全滅する**ので、
    // 数えずに「.modal-back が実在するか」を見る（OR なので二重計上も起きない）
    if (this.dialogOpen()) return;
    // M11-2: contenteditable も文字入力として除外（Space/Enter を再生に取られないように）
    if (this.isTextEntry(e.target)) return;
    // M11-10: IME 変換中は発火しない（変換確定の Enter で再生が始まらないように）。
    // keyCode 229 は composition 中の古い環境向けの保険
    if (e.isComposing || e.keyCode === 229) return;

    // ---- 予約キー（割り当ての対象外。従来どおりの固定の分岐で受ける） ----
    if (e.code === "Space") {
      // E-1: Space押下中は一時的に手のひら（お絵描きソフト標準の作法）。
      // M11-2: 単押しなら keyup 側で再生トグルにする（長押しは従来どおり手のひら）
      e.preventDefault();
      // M11-10: 手のひら/再生は「別の操作」なので、矢印の移動セッションは確定しておく
      if (!e.repeat) this.endArrowSession();
      if (!e.repeat) {
        this.spaceHeld = true;
        this.spaceDownAt = performance.now();
        this.spacePanned = false;
        this.updatePanCursor();
      }
      return;
    }
    if (e.code === "Escape") {
      if (this.rowDrag) {
        // M3.9 H-2: レイヤードラッグ中の Esc はドラッグだけキャンセル
        this.cancelRowDrag();
        return;
      }
      if (this.frameDrag) {
        this.cancelFrameDrag(); // M11-7: コマの並べ替え中も同じ（並びは動かさない）
        return;
      }
      // M11-12: 浮動テキストは取り消して終わり（何も焼かない）。選択解除まで走らせない
      //（入力欄にフォーカスがあるときは、そちらの keydown が同じことをする）
      if (this.textDraft) {
        this.cancelTextDraft();
        return;
      }
      // M11-10: 矢印キーでの移動セッション中は、そのセッションだけ取り消す
      if (this.arrowKind) {
        this.cancelArrowSession();
        return;
      }
      // M11-8: 枠の移動／レイヤーの移動も「ドラッグ中の Esc はそのドラッグだけ取り消す」
      //（これが無いと、Esc で選択を消したのに指を離した時点で復活する）
      if (this.selMaskDrag) {
        this.cancelSelMaskMove();
        return;
      }
      if (this.layerDrag) {
        this.cancelLayerMove();
        return;
      }
      if (this.xformActive) this.cancelTransform();
      // M10-2c: 取消の復元を選択解除より**先に**走らせる（順序を入れ替えないこと。
      // cancelCornerWarp は selMask を読まないが、transform と流儀を揃えてある）
      if (this.cornerActive) this.cancelCornerWarp();
      this.selMask = null;
      this.lassoPts = [];
      this.redrawOverlay();
      return;
    }
    if (e.code.startsWith("Arrow")) {
      this.handleArrowKey(e);
      return;
    }
    if (e.code === "Backspace") {
      // 従来から Delete と2つある（Delete 側は割り当て可能・こちらは固定）
      if (this.selMask) {
        e.preventDefault();
        // M11-9: 押しっぱなしのキーリピートで履歴を空エントリで埋めない
        if (!e.repeat) {
          this.endArrowSession(); // M11-10: 消す前に移動を確定（別の操作）
          this.deleteSelection();
        }
      }
      return;
    }
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      // M11-12: Ctrl+Enter=浮動テキストの確定（入力欄の外にフォーカスがある場合。
      // 入力欄の中では、そちらの keydown が同じことをする）
      if (this.textDraft && e.ctrlKey) {
        e.preventDefault();
        this.commitTextDraft();
        return;
      }
      // E-4: Enter=変形確定（変形中・四隅変形中は確定が優先）
      if (this.xformActive) {
        e.preventDefault();
        this.commitTransform();
        return;
      }
      if (this.cornerActive) {
        e.preventDefault();
        this.commitCornerWarp();
        return;
      }
      // M11-10: 矢印キーでの移動セッションの明示的な確定
      if (this.arrowKind) {
        e.preventDefault();
        this.endArrowSession();
        return;
      }
      // M11-2: ボタンにフォーカスがあるときはブラウザ既定の「Enter でそのボタンを押す」を
      // 優先する（二重発火を避ける）。この判定は Enter/Space にだけ要る
      if ((e.target as HTMLElement | null)?.closest?.("button, a")) return;
      // 以降は割り当て（既定では play.toggle＝再生サブキー）へ流す
    }

    // ---- 割り当て（キー → コマンドID → 実行） ----
    const id = this.keyLookup.get(eventKey(e));
    if (!id) return;
    // ツール切替などはキーリピートで連続実行しない（Undo/Redo・コマ移動・ズームは従来どおり連続）
    if (e.repeat && !Editor.REPEATABLE.has(id)) return;
    e.preventDefault();
    // M11-11: 「押している間だけ」のコマンド用に、いま押されている物理キーを渡す
    this.peekPendingCode = e.code;
    // M11-10: 別の操作を始めたら、矢印キーの移動セッションは確定する
    this.endArrowSession();
    this.runCommand(id);
  }
}
