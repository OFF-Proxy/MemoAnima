// V221 (M-2b-2・要件 docs/REQ_mobile_m2_editor.md §5-2・§5-6・決-2・決-4・UI docs/REQ_mobile_ui_v1.md §4・§5): モバイルの**描く画面**。
// ★V222 (M-2b-3a・§5-3・UI §5-11): 横（広）に縦（中）の置き方を足した。部品は 1 組だけ作り、置き方が替わったら入れ物を移す（mbArrange）。
//  置き方の決まり（案内・「表示」の置き場・開いていたものの対応・キーボード）は arrange.ts、倍率と位置の持ち越しは view/zoom.ts の carryView。
//  画面の大きさを読むのは mbScreen の 1 か所。レイヤーの行の長押しからの並べ替えは layerRows.ts（PC と同じ順でコアの口を呼ぶ）。
//
// ★`EditorCore` を受け継ぐ（決-2）。コアの頭の一覧のフック 52 を**全部** `override` 付きで上書きする（何もしないものも「何もしない」と書く）。
//  一覧と突き合わせる網は scripts/v221_smoke.ts の [H]（一覧に足されたら・上書きを 1 つ消したら赤）。
// ★V213 の網: 同じ名前のメソッドはフックの上書きだけ・コアのフィールドを宣言し直さない（`useDefineForClassFields` が true なので、
//  宣言し直すと受け継いだ値が黙って消える）。このクラスのフィールドとメソッドは `mb` で始め、コアの名前と重ねない。
//  振り分け層の sink はクラスとは別のオブジェクト（`pickColor`・`undo`・`redo` をクラスに置かない＝`pickColor` はコアのスポイトの口を上書きしてしまう）。
// ★`pointerType` はここで読まない（読むのは振り分け層の 1 か所＝V220 の網）。
// ★絵の画素は 320×240 だけを持つ（拡大した大きさの canvas を作らない＝×32 でも重くしない）。倍率と回転は CSS の transform。
//  重ねる層は 2 つ: 絵と同じ 320×240 の層（変形・文字・選択の色・図形の下書き＝PC の #ed-overlay と同じ役）と、
//  画面の解像度の層（選択の点線・変形の取っ手・四隅・ピクセル格子・ホバーの輪・予測の線。大きさは画面＝見えている範囲）。
// ★色は CSS の変数だけ。例外は要件書が値を決めたもの: ピクセル格子 `rgba(128, 128, 128, 0.28)`（UI §4-1）と、作品の絵の上の下書きの色
//  （PC と同じ値＝配色で変えない。PC の V158 C-2 の判断）。v221 [U] が名指しで数える。
import { EditorCore, PEN_SIZES, type CoreCallbacks, type Tool, type XformHitSizes, type BackgroundMark } from "../../editor/core/editorCore";
import { W, H, FPS_TABLE, type PenTexture } from "../../editor/model";
import { compositeFrame, presentToCanvas } from "../../editor/render";
import { selectionOutline, type SelOutline } from "../../editor/selOutline";
import { frameHasAsleep } from "../../editor/sleep";
import { downscaleArea } from "../../editor/downscale";
import { TONE_TILES } from "../../editor/raster";
import { FONTS } from "../../editor/fonts";
import { formatSize } from "../../editor/core/formatBytes";
import type { PerfOp } from "../../perf";
import { t } from "../../i18n";
import { handSwapped, type Hand } from "./arrange";
import { inputSettingsFrom, type MobileSettings } from "../settings/model";
import { KeyboardHandler, MOBILE_COMMANDS, type KeyEventLike } from "../input/keyboard";
import { WheelGesture } from "../view/wheel";
import { screenSize, setScreenOverride, realScreenWidth } from "../view/screen";
import { installPencilTap, pencilTapDo, pencilTapAttached } from "../ios/pencilTap";
import type { CommandId, Preset } from "../../keymap";
import { primaryMod } from "../../platform";
import { dialogOpen } from "../ui/dialogs";
import { mt, type MbKey } from "../i18n";
import type { MobileIconId } from "../../mobile/icons";
import { InputRouter, defaultInputSettings, type InputSettings, type RouterSink, type RouterView, type GestureUpdate, type HitKind } from "../input/router";
import type { StrokeSample } from "../../editor/core/editorCore";
import { categoryOf, openView, fitScale, liveScale, settle, clampToEdges, visibleArea, carryView, type View, type ViewCtx, type Category, PIC_BORDER } from "../view/zoom";
import { h, btn, disabledBtn, icon, txt, bindAct, actOf } from "../ui/dom";
import { narrowStep } from "./narrow";
import { shapeOf, viewInMoreAt, mediumGeometry, popLeft, keyboardOnly, isGroupTool, wideTier, textStripPlace, TEXT_STRIP_HIGH_TOP, GROUP_TOOLS, GROUP_FIRST, type Shape, type OpenState, type PanelId, type Box } from "./arrange";
import { ISLAND, openIsland, closeIsland, openPanelOver, hideTools, showTools, carryOpenIsland, RangeMode, inRange, type IslandOpen, type HiddenMemo, type RangeOps } from "./timeline";
import { shownColors, parseHexInput, hexLabel } from "./colorMath";
import { ColorPicker } from "./colorPicker";
import { askAddFrames, askWobble } from "./timelineDialogs";
import { askName } from "../ui/nameDialog";
import { pasteRange } from "../../editor/layerClip";
import { layerDisplayRows, type LayerListRow, type RowDropHit } from "../../editor/layerTree";
import { RowDrag, rowIndent, gapRowAt } from "./layerRows";
import { TapManager, bindHold, bindScroll, scrollBoxOf } from "../ui/tap";
import type { ScrollBox } from "../ui/press";
import { toast as showToast } from "../ui/dialogs";
import { setGlobalRouteHook, cancelGlobalTap } from "../ui/globalInput";
import { editorCloseTarget, type EditorClose } from "../android/backRules";
import { holdBackground, type InertNode } from "../ui/modalInert";

/** ★ピクセル格子の色（UI §4-1 が値を決めた・PC の updateGridOverlay と同じ） */
const GRID_RGBA = "rgba(128, 128, 128, 0.28)";
/** ★作品の絵の上の下書きの色（PC と同じ値・配色で変えない＝PC の V158 C-2） */
const SKETCH = { shape: "rgba(240,122,26,.9)", selRect: "rgba(44,38,33,.9)", text: "rgba(240,122,26,.75)", corner: "rgba(44,38,33,.85)", paper: "#ffffff", ink: "#000000", handle: "#f07a1a", textClear: "#888888" };
/** 選択の「色を付ける」の色（作品の絵の上の下書き・PC の SEL_MASK_RGBA の役） */
const SEL_MASK = [31, 162, 255, 90] as const;
/** ★V222: 縦の色のパネルで、よく使う色の空きを点線の枠で見せる数（1 行＝7） */
const FAV_SLOTS = 7;
/** 選択の点線の 1 回（PC と同じ 4・4 の破線を動かす） */
const ANTS_MS = 120;
/** 当たりの一辺（UI §3-7・親§3-3）: 画面の上で 44pt 以上 */
export const HIT_PT = 44;

/** ★V221b (■3): コアが出すお知らせと確認のうち、7 言語のどれかにキーの表記（Ctrl+Z・Enter・Esc）が入る 10 キー → モバイルの辞書の文。
 *  ほかのキーは PC の文のまま（coreText の既定の中身）。差し込み語の名前は PC と同じ（{hex}・{n}・{m}） */
export const MB_CORE_TEXT_SWAP: Readonly<Record<string, MbKey>> = {
  "ed.xform.guard.toast": "mb.core.xformGuard.toast",
  "ed.img.place.xformBusy.toast": "mb.core.imgXformBusy.toast",
  "ed.img.place.done.toast": "mb.core.imgPlaced.toast",
  "ed.color.usedHistory.toast": "mb.core.colorUsedHistory.toast",
  "ed.color.delete.msg": "mb.core.colorDelete.msg",
  "ed.color.deleted.toast": "mb.core.colorDeleted.toast",
  "ed.color.tidy.keptOnly.toast": "mb.core.tidyKeptOnly.toast",
  "ed.color.tidy.confirm.msg": "mb.core.tidyConfirm.msg",
  "ed.color.tidy.confirmKeep.msg": "mb.core.tidyConfirmKeep.msg",
  "ed.color.tidy.done.toast": "mb.core.tidyDone.toast",
};

/** ★V221b (■3): コアの文の口の中身（MobileEditor.coreText がこれを呼ぶ・検査も同じ関数を通す）。表にあるキーはモバイルの文・ほかは PC の文 */
export function mbCoreText(key: string, vars: Record<string, unknown> | undefined, pc: (key: string, vars?: Record<string, unknown>) => string): string {
  const mk = MB_CORE_TEXT_SWAP[key];
  return mk ? mt(mk, vars) : pc(key, vars);
}

/** ★V222 (■6): 確かめ画面の印のビルドだけが使う、描く画面が読む大きさの差し替え（印の無いビルドでは mbScreen が読まない＝
 *  `__MOBILE_DEVCHECK__` が false なら読む所ごと消え、この変数と下の関数も出力に残らない＝v222 [S]） */
const devOn = (): boolean => typeof __MOBILE_DEVCHECK__ !== "undefined" && __MOBILE_DEVCHECK__;
/** ★V222 (■6): 確かめ画面の印のビルドだけが呼ぶ。描く画面が読む大きさと根の大きさを替えて、区分の切り替えを起こす（null で戻す） */
export function mbDevSetScreen(w: number | null, hh: number | null): void {
  if (!devOn()) return;
  const devSize = w && hh ? { w, h: hh } : null;
  setScreenOverride(devSize); // ★V225 (L-1): 大きさを読む 1 か所（view/screen.ts）を差し替える＝ライブラリと設定にも効く
  const root = document.querySelector(".mb-ed") as HTMLElement | null;
  if (root) {
    root.style.right = devSize ? "auto" : "";
    root.style.bottom = devSize ? "auto" : "";
    root.style.width = devSize ? `${devSize.w}px` : "";
    root.style.height = devSize ? `${devSize.h}px` : "";
  }
  window.dispatchEvent(new Event("resize"));
}

/** 左の列のツール（UI §5-2: 上から ペン・ブラシ・消しゴム・塗り・図形・文字・スポイト／移動・範囲選択・変形・歪み） */
const TOOLS: { id: Tool; labelKey: string; icon: MobileIconId; format: "panel" | "strip" | null }[] = [
  { id: "pen", labelKey: "ed.tool.pen.label", icon: "pen", format: "panel" },
  { id: "brush", labelKey: "ed.tool.brush.label", icon: "brush", format: "panel" },
  { id: "eraser", labelKey: "ed.tool.eraser.label", icon: "eraser", format: "panel" },
  { id: "fill", labelKey: "ed.tool.fill.label", icon: "fill", format: "strip" },
  { id: "shape", labelKey: "ed.tool.shape.label", icon: "shape", format: "strip" },
  { id: "text", labelKey: "ed.tool.text.label", icon: "text", format: "strip" },
  { id: "eyedrop", labelKey: "ed.tool.eyedrop.label", icon: "eyedrop", format: null },
  { id: "move", labelKey: "ed.tool.move.label", icon: "move", format: "strip" },
  { id: "select", labelKey: "ed.tool.select.label", icon: "select", format: "strip" },
  { id: "transform", labelKey: "ed.tool.transform.label", icon: "transform", format: "strip" },
  { id: "warp", labelKey: "ed.tool.warp.label", icon: "warp", format: "strip" },
];

const PEN_TEX: { key: PenTexture; labelKey: string; icon: MobileIconId }[] = [
  { key: "solid", labelKey: "ed.pen.tex.solid.title", icon: "tex-solid" },
  { key: "spray", labelKey: "ed.pen.tex.spray.title", icon: "tex-spray" },
  { key: "sand", labelKey: "ed.pen.tex.sand.title", icon: "tex-sand" },
];

/** 画面の外（作品のセッション・時計・保存の段取り）へ知らせる口 */
export interface EditorHost {
  /** 編集の印（コアの workEdited）→ セッションと時計の noteEdit */
  edited(): void;
  /** 描いている印（飾りの動きを止める・時計の書かない間） */
  drawingChanged(on: boolean): void;
  /** 線を引き終えた（時計の strokeEnded） */
  strokeEnded(): void;
  /** 保存・別名で保存・戻る（段取りは画面の側＝workScreen.ts） */
  save(): void;
  saveAs(): void;
  back(): void;
  /** ペンを使う端末と分かった（モバイルだけの設定に書く・お知らせは 1 回） */
  penDeviceDetected(): void;
  /** ログに 1 行（作品名・パス・作品の中身を書かない） */
  log(line: string): void;
  /** 保存中か（保存の札を回す・戻るは何もしない） */
  saving(): boolean;
  /** ★V225 (A-1): その他の［設定］（開く前の関所と段取りは画面の側＝workScreen.ts） */
  settings(): void;
}

export interface MobileEditorOptions {
  /** 指で描くの値（null＝決めていない＝ペンを受けたら既定でオフ）・ペンを受けた印（モバイルだけの設定） */
  fingerDraw: boolean | null;
  penDevice: boolean;
  /** 4 本指のタップが使えるか（使えないときのお知らせの文） */
  fourFingerTap: boolean;
  /** ★V225 (S-1): 読んだ設定（入力・コマを変えるときの動き・利き手）。無ければ既定（今までの動き） */
  settings?: MobileSettings;
}

/** 開いた画面の状態（検査と確かめ画面が読む） */
export interface MobileEditorStats {
  repaints: number;
  overlayPaints: number;
}

export class MobileEditor extends EditorCore<CoreCallbacks, null> {
  // ---------------- このクラスだけのもの（名前は mb で始める＝コアと重ねない） ----------------
  private mbHost: EditorHost | null = null;
  private mbRoot: HTMLElement | null = null;
  private mbEl: Record<string, HTMLElement> = {};
  private mbArt: HTMLCanvasElement | null = null;
  private mbOvPix: HTMLCanvasElement | null = null;
  private mbOvUi: HTMLCanvasElement | null = null;
  private mbRouter: InputRouter | null = null;
  private mbTap: TapManager | null = null;
  private mbInput: InputSettings = defaultInputSettings();
  private mbView: View | null = null;
  private mbBase: View | null = null;
  private mbLive = false;
  private mbCat: Category = "wide";
  /** ★V222: 部品の置き方（案内を出している間は、案内に入る前の置き方のまま）・いまの絵の倍率と位置を決めた画面・前に読んだ大きさ */
  private mbShape: Shape = "wide";
  private mbArranged = false;
  private mbViewCtx: ViewCtx | null = null;
  private mbLastSize: { w: number; h: number } | null = null;
  /** 大きさが変わって振り分け層を止めている間（その間に終わったジェスチャーは寄せずに戻す） */
  private mbResizing = false;
  /** ★V222: まとめたボタンの最後に使ったもの（初めは範囲選択）・横で閉じて覚えたパネル（縦に戻ったら開く） */
  private mbGroupLast: Tool = GROUP_FIRST;
  private mbPanelMemo: PanelId | null = null;
  /** ★V222 (E-14): レイヤーの行を長押しから動かしている途中 */
  private mbRowDrag: RowDrag | null = null;
  private mbRowHover: { folder: string | null; timer: ReturnType<typeof setTimeout> | null } = { folder: null, timer: null };
  private mbFlip = false;
  private mbGrid = true;
  private mbMini = false;
  private mbToolsHidden = false;
  private mbPanel: PanelId | null = null;
  private mbPanelBeforeHide: PanelId | null = null;
  private mbStrip: Tool | null = null;
  private mbMore = false;
  private mbFrameBar: number | null = null;
  private mbDrawing = false;
  private mbBusy = false;
  private mbRaf = 0;
  private mbAntsTimer: ReturnType<typeof setTimeout> | null = null;
  private mbAntsPhase = 0;
  private mbSelSrc: Uint8Array | null = null;
  private mbSelOutline: SelOutline | null = null;
  private mbHover: { x: number; y: number; style: "ring" | "cross" } | null = null;
  private mbPredicted: readonly StrokeSample[] | null = null;
  private mbZoomBadgeTimer: ReturnType<typeof setTimeout> | null = null;
  private mbUndoBadgeTimer: ReturnType<typeof setTimeout> | null = null;
  private mbEatPointer = new Set<number>();
  private mbFrameDrag: { from: number; to: number } | null = null;
  private mbOpts: MobileEditorOptions = { fingerDraw: null, penDevice: false, fourFingerTap: true };
  private mbSize: { proj: number; real: number } | null = null;
  private mbSavePrep: string | null = null;
  private mbListeners: (() => void)[] = [];
  /** ★V223 (F-1): 画面の側で送る入れ物（下の帯のコマの帯・パネル・広げたタイムラインのフィルム）。入れ物ごとに 1 つ（惰性を止めるときの名札） */
  private mbScrollBoxes = new WeakMap<HTMLElement, ScrollBox>();
  /** ★V223 (F-4): コマの並び（下の帯のコマの帯と、広げたタイムラインのフィルム）。見えているコマだけサムネを描き、見えなくなったら canvas を手放す */
  private mbFilms: { el: HTMLElement; big: boolean; obs: IntersectionObserver | null; visible: Set<number> }[] = [];
  /** ★V223 (F-4): 広げたタイムラインの島が開いているか・縦で島の後ろに覚えたパネル・ツールを隠したときに覚えた島 */
  private mbIsland = false;
  private mbIslandMemo: PanelId | null = null;
  private mbHiddenMemo: HiddenMemo | null = null;
  private mbHiddenShape: Shape = "wide";
  /** ★V223 (F-6): ［範囲］の札 */
  private mbRange = new RangeMode();
  /** ★V223 (F-8): 色の四角を動かしている間（その間はパネルを組み直さない）・前に選んだ色相 */
  private mbColorDragging = false;
  private mbPickHue = 0;
  /** ★V223: レイヤーのメニューを出しているレイヤー（範囲が変わったら貼り付けの札の字を直す） */
  private mbLayerMenuId: string | null = null;
  private mbFloatCv = new WeakMap<object, HTMLCanvasElement>();
  private mbNarrow = false;
  private mbXformPeek = false;
  /** 範囲選択の「色を付ける」（PC は画面の側のフィールド＝モバイルも画面の側に持つ・設定へはコアの cb で知らせる） */
  private mbSelMaskShow = false;
  /** ★V225 (K・T): ハードウェアキーボードの受け手・Space を押している間・設定の画面が上に出ている間・トラックパッドとホイール */
  private mbKeys: KeyboardHandler | null = null;
  private mbKeyPreset: Preset | null = null;
  private mbSpacePan = false;
  private mbModal = false;
  private mbWheel: WheelGesture | null = null;
  /** ★V225 (P・C17): ペンのダブルタップ（前に持っていたツール・消しゴムへ切り替える前のツール・口の片付け） */
  private mbPrevTool: Tool | null = null;
  private mbBeforeEraser: Tool | null = null;
  private mbToolNow: Tool | null = null;
  private mbPencilOff: (() => void) | null = null;
  /** ★V225 (S-1・UI §3-6・§5-15): 設定「コマを変えるときの動き」「利き手」 */
  private mbFlipOn = true;
  private mbHand: Hand = "right";
  /** 検査と確かめ画面の数（C12: 何もしていない 1 分間に描き直しが 0 回） */
  readonly mbStats: MobileEditorStats = { repaints: 0, overlayPaints: 0 };

  // =====================================================================================
  // 開く・閉じる（コアの openWork*・closeWork* を PC と同じ順で呼ぶ）
  // =====================================================================================

  /** ★開く。PC の mount と同じ順: openWorkStart → openWorkReset → openWorkPlayAndFloat → openWorkSelection → openWorkPointer →
   *  （画面を組む・refreshAll）→ openWorkNotice → openWorkClean → openWorkSweepSoon */
  mbOpen(root: HTMLElement, project: EditorCore["project"], cb: CoreCallbacks, host: EditorHost, opts: MobileEditorOptions): void {
    this.mbHost = host;
    this.mbOpts = opts;
    this.mbInput = opts.settings ? inputSettingsFrom(opts.settings) : { ...defaultInputSettings(), fingerDraw: opts.fingerDraw };
    this.mbFlipOn = opts.settings ? opts.settings.flipPage : true;
    this.mbHand = opts.settings ? opts.settings.hand : "right";
    this.openWorkStart(project);
    this.openWorkReset(project, cb);
    this.openWorkPlayAndFloat();
    this.mbFlip = false;
    this.mbGrid = true; // ピクセル格子は開き直すとオン（PC と同じく保存しない）
    this.mbToolsHidden = false;
    this.mbPanel = null;
    this.mbStrip = null;
    this.mbMore = false;
    this.mbPanelMemo = null;
    this.mbIsland = false;
    this.mbIslandMemo = null;
    this.mbHiddenMemo = null;
    this.mbRange = new RangeMode();
    this.mbColorDragging = false;
    this.mbLayerMenuId = null;
    this.mbGroupLast = GROUP_FIRST;
    this.mbPrevTool = null;
    this.mbBeforeEraser = null;
    this.mbToolNow = null;
    this.mbArranged = false;
    this.mbView = null;
    this.mbViewCtx = null;
    this.mbLastSize = null;
    this.openWorkSelection();
    this.mbBuild(root);
    this.openWorkPointer();
    this.bindHistory();
    this.mbLayout();
    this.refreshAll();
    this.historyChanged();
    this.updateToolButtons(); // 開いたときの道具・太さ・色の印
    this.openWorkNotice();
    this.openWorkClean();
    this.openWorkSweepSoon();
    this.mbRaf = requestAnimationFrame(this.mbTick);
  }

  /** ★閉じる。PC の unmount と同じ順: closeWorkStart → closeWorkSleep → closeWorkPending（選択の帯を隠す前）→ closeWorkWarp → closeWorkEnd。
   *  描いている途中なら、先に振り分け層で確定する（interrupt） */
  mbClose(): void {
    if (!this.mounted) return;
    this.mbRouter?.interrupt();
    this.mbTap?.cancelAll();
    this.mbEatPointer.clear();
    setGlobalRouteHook(null);
    this.closeWorkStart();
    this.closeWorkSleep();
    this.closeWorkPending();
    this.mbStopAnts();
    this.mbCloseEverything();
    this.mbRowDragEnd(true);
    this.closeWorkWarp();
    for (const off of this.mbListeners.splice(0)) off();
    cancelAnimationFrame(this.mbRaf);
    this.mbFilmDisconnect();
    this.mbRoot?.replaceChildren();
    this.mbRoot?.removeAttribute("data-own-input");
    if (this.mbRoot) this.mbRoot.inert = false;
    this.mbRoot?.classList.remove("mb-ed", "mb-tools-hidden", "mb-drawing", "mb-busy", "mb-muted", "mb-waiting", "mb-shape-wide", "mb-shape-medium", "mb-view-in-more", "mb-tier-1", "mb-tier-2", "mb-tier-3", "mb-island-open");
    document.documentElement.classList.remove("mb-medium");
    this.mbRoot = null;
    this.mbEl = {};
    this.mbArt = this.mbOvPix = this.mbOvUi = null;
    this.mbRouter = null;
    this.mbTap = null;
    this.mbWheel?.drop();
    this.mbWheel = null;
    this.mbKeys = null;
    this.mbPencilOff?.();
    this.mbPencilOff = null;
    this.mbSpacePan = false;
    this.mbModal = false;
    this.closeWorkEnd();
  }

  // ---------------- 外（workScreen）から使う口 ----------------

  /** ★V225 (S-3): 設定を当てる（設定の画面で変えた・戻った）。入力の設定はその場で振り分け層に効く（次の接触から）。
   *  描き味の「筆圧で太さ」は設定に保存しない（ツールの設定のスイッチのまま） */
  mbApplySettings(s: MobileSettings): void {
    this.mbInput = { ...inputSettingsFrom(s), pressure: this.mbInput.pressure };
    this.mbFlipOn = s.flipPage;
    if (this.mbHand !== s.hand) {
      this.mbHand = s.hand;
      if (this.mbRoot && this.mbArranged) {
        this.mbArrange();
        this.mbPlace();
      }
    }
  }
  /** ★V225 (P・C17): ペンのダブルタップ（OS の設定の字を受けて、決まり〔ios/pencilTap.ts〕のとおりに） */
  private mbPencilTap(action: string): void {
    if (!this.mounted || !this.mbRoot) return;
    const d = pencilTapDo(action, {
      tool: this.tool,
      prevTool: this.mbPrevTool,
      beforeEraser: this.mbBeforeEraser,
      drawing: this.mbDrawing,
      blocked: this.mbModal || this.mbNarrow || this.mbBusy || dialogOpen(),
    });
    this.mbHost?.log(`[V225] pencil-tap action=${/^[a-zA-Z]{1,24}$/.test(action) ? action : "bad"} do=${d ? d.kind : "none"}`);
    if (!d) return;
    if (d.kind === "colorPanel") {
      if (this.mbPanel !== "color") this.mbOpenPanel("color");
      return;
    }
    this.runCoreCommand(`tool.${d.tool}`);
  }
  /** 確かめ画面の印のビルド: いまのツール（キーボードの記録に添える） */
  mbDevTool(): string {
    return this.tool;
  }
  /** 確かめ画面の印のビルド: 再生・太さ・倍率と位置・手のひら（キーボードとホイールの記録に添える） */
  mbDevKeyState(): string {
    const v = this.mbView;
    return `playing=${this.playing ? 1 : 0} size=${this.penSize} zoom=${v ? v.scale : 0} at=${v ? `${Math.round(v.x)},${Math.round(v.y)}` : ""} rot=${v ? v.rotationDeg : 0} hidden=${this.mbToolsHidden ? 1 : 0}`;
  }
  /** 確かめ画面の印のビルド: ネイティブの受け口が付いているか */
  mbPencilAttached(): boolean {
    return pencilTapAttached();
  }

  /** ★V225 (K): キーボードの割り当て（PC のプリセット。設定の画面で替えたときも同じ入口） */
  mbSetKeyPreset(p: Preset): void {
    this.mbKeyPreset = p;
    this.mbKeys?.setPreset(p);
  }
  /** ★V225 (S-3・K): 設定の画面が上に出ている間（キーボードのコマンドを効かせない・押しっぱなしの状態は畳む） */
  mbSetModal(on: boolean): void {
    this.mbModal = on;
    // 下の描く画面は、読み上げとフォーカスの行き先から外す（見た目は設定の画面が全面を覆う）
    if (this.mbRoot) this.mbRoot.inert = on;
    if (on) {
      this.mbKeys?.reset();
      this.mbWheel?.end();
    }
  }
  /** ★V225 (K): コアが受けないコマンド（表は input/keyboard.ts の MOBILE_COMMANDS。名前はその表の do） */
  private mbRunCommand(id: CommandId): void {
    if (this.runCoreCommand(id)) {
      // 手のひらに持ち替えた（H）: 画面のツールの列はどれも選ばれていない形になる（updateToolButtons が印を外す）
      return;
    }
    switch (MOBILE_COMMANDS[id] ?? null) {
      case "save":
        this.mbHost?.save();
        break;
      case "saveAs":
        this.mbHost?.saveAs();
        break;
      case "settings":
        this.mbHost?.settings();
        break;
      case "wobble":
        void this.mbWobbleAsk();
        break;
      case "loop":
        this.toggleLoop();
        if (this.mbIsland) this.mbRenderIslandHead();
        break;
      case "zoomIn":
        this.mbZoomStep(+1);
        break;
      case "zoomOut":
        this.mbZoomStep(-1);
        break;
      case "rotate":
        this.mbRotateStep();
        break;
      case "flip":
        this.mbFlip = !this.mbFlip;
        this.mbApplyView(false);
        if (this.mbPanel === "view") this.mbRenderPanel();
        break;
      case "peek":
        if (this.xformActive) this.mbPeek(true);
        break;
      case "mini":
        this.mbMini = !this.mbMini;
        if (this.mbPanel === "view") this.mbRenderPanel();
        break;
      case "focus":
        this.mbToggleTools();
        break;
    }
  }
  /** ★V225 (K): 倍率を 1 段（寄る刻み＝1 ÷ dpr）。見える範囲の真ん中を中心に・fit より下げない・×32 まで（寄せ方は指を離したときと同じ道） */
  private mbZoomStep(dir: 1 | -1): void {
    const v = this.mbView;
    if (!v || this.mbNarrow || this.mbLive) return;
    const { w, h: hh } = this.mbScreen();
    const dpr = this.mbDpr();
    const vis = visibleArea(this.mbShape, w, hh, dpr, this.mbToolsHidden);
    if (!vis) return;
    const center = { x: vis.x + vis.w / 2, y: vis.y + vis.h / 2 };
    const target = v.scale + dir / dpr;
    this.mbGesture({ phase: "start", center, pan: { dx: 0, dy: 0 }, scale: 1, rotationDeg: 0 });
    this.mbGesture({ phase: "end", center, pan: { dx: 0, dy: 0 }, scale: target / v.scale, rotationDeg: 0 });
  }
  /** ★V225 (K): 表示を 90° 回す（PC の回転のボタンと同じ 4 方向。見える範囲の真ん中を軸に） */
  private mbRotateStep(): void {
    const v = this.mbView;
    if (!v || this.mbNarrow || this.mbLive) return;
    const { w, h: hh } = this.mbScreen();
    const vis = visibleArea(this.mbShape, w, hh, this.mbDpr(), this.mbToolsHidden);
    if (!vis) return;
    const center = this.mbCenter(v);
    this.mbGesture({ phase: "start", center, pan: { dx: 0, dy: 0 }, scale: 1, rotationDeg: 0 });
    this.mbGesture({ phase: "end", center, pan: { dx: 0, dy: 0 }, scale: 1, rotationDeg: 90 });
  }
  /** ★V225 (K): Esc の、画面の側の分（PC の onKeyDown の Esc の頭: 帯を畳む・行やコマを運んでいる途中をやめる）。受けたら true */
  private mbEscapeUi(): boolean {
    if (this.mbRowDrag) {
      this.mbRowDragEnd(true);
      return true;
    }
    if (this.mbFrameDrag) {
      this.mbFrameDrop(true);
      return true;
    }
    if (this.mbTransientOpen()) {
      this.mbCloseTransient();
      this.mbSyncGroup();
      return true;
    }
    return false;
  }
  /** キーの出来事を受け手の形へ（入力欄の中か・ボタンにフォーカスがあるか） */
  private mbKeyLike(e: KeyboardEvent): KeyEventLike {
    const el = e.target as HTMLElement | null;
    const tag = el && typeof el.tagName === "string" ? el.tagName : "";
    return {
      key: e.key,
      code: e.code,
      repeat: e.repeat,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      isComposing: e.isComposing,
      keyCode: e.keyCode,
      textEntry: tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el?.isContentEditable === true,
      onButton: !!el?.closest?.("button, a"),
      preventDefault: () => e.preventDefault(),
    };
  }

  /** ★V225 (N): 配色を替えた。変数から色を読んで描いている所（ツールの設定のトーンの見本・レイヤーの絵の縁など）を描き直す。
   *  絵（作品の色）は配色を読まないので描き直さない（U-10） */
  mbThemeChanged(): void {
    if (!this.mbRoot) return;
    if (this.mbPanel) this.mbRenderPanel();
    if (this.mbStrip) this.mbRenderStrip();
    this.mbPaintUi();
  }
  /** ★V225 (S-3): 設定を開く前の関所（変形の途中なら開かない＝コアの xformGuard と同じ知らせ。文字の下書きは確定する） */
  mbSettingsBlocked(): boolean {
    return this.xformGuard();
  }

  /** パネル・帯・メニューを閉じる（保存の画面や確認を出す前）。
   *  ★V222 (E-4): 縦では一時的に開くもの（帯・一覧・その他・コマの帯）だけを閉じる（縦のパネルは保存しても開いたまま） */
  mbCloseAll(): void {
    this.mbCloseOverlays();
  }
  /** ★V226 (B-1): Android の戻るボタンで 1 つ閉じる（順の決まりは android/backRules.ts の editorCloseTarget）。
   *  今ある閉じ方をそのまま呼ぶ（Esc・同じボタン・⌄ と同じ道。縦のパネルと島は外を押しても閉じない決まり〔E-4〕のまま＝戻るボタンは閉じる操作）。
   *  描いている途中・変形の途中・重い処理の間は何もしない（"busy"）。閉じるものが無ければ "none"（＝画面の［戻る］の道へ） */
  mbBackClose(): EditorClose {
    const target = editorCloseTarget({
      touching: this.mbDrawing || this.mbLive || this.mbRowDrag !== null || this.mbFrameDrag !== null,
      transforming: this.xformActive || this.cornerActive,
      heavy: this.busyKind !== "" || this.mbHost?.saving() === true,
      transient: this.mbTransientOpen(),
      panel: this.mbPanel !== null,
      island: this.mbIsland,
    });
    if (target === "busy" || target === "none") return target;
    if (target === "transient") {
      this.mbCloseTransient();
      this.mbSyncGroup();
    } else if (target === "panel") this.mbClosePanel();
    else this.mbToggleIsland();
    return "closed";
  }
  /** 振り分け層（裏に回る・閉じる・替えるで interrupt） */
  mbInterrupt(): void {
    this.mbRouter?.interrupt();
    this.mbTap?.cancelAll();
    this.mbEatPointer.clear();
  }
  /** コアの「別の操作を始めた」（1 ドット動かすのまとめと全レイヤーの束を確定） */
  mbOtherOperation(): void {
    this.otherOperationStarted();
  }
  mbDrawingNow(): boolean {
    return this.mbDrawing;
  }
  mbAutosaveBlocked(): boolean {
    return this.autosaveBlocked();
  }
  mbAutosaveMark(): { hist0: number } {
    return this.autosaveMark();
  }
  mbChangedSince(m: { hist0: number }): boolean {
    return this.autosaveChangedSince(m);
  }
  /** ★V221b: 裏に回る便の印と「捨てる」（コアの backgroundMark・backgroundChangedSince） */
  mbBackgroundMark(): BackgroundMark {
    return this.backgroundMark();
  }
  mbBackgroundChangedSince(m: BackgroundMark): boolean {
    return this.backgroundChangedSince(m);
  }
  mbMounted(): boolean {
    return this.mounted;
  }
  mbSaveBlocked(): boolean {
    return this.saveBlocked();
  }
  mbLeaveBlocked(): boolean {
    return this.leaveBlocked();
  }
  /** 写す前の見積り（コアの prepareSnapshot＝眠らせて見積もる。断ったらコアが知らせ済み） */
  async mbPrepareSnapshot(): Promise<boolean> {
    return (await this.prepareSnapshot()) !== null;
  }
  mbFrameIndex(): number {
    return this.frameIndex;
  }
  /** 広でない大きさ（決-20）の案内が出ているか */
  mbIsNarrow(): boolean {
    return this.mbNarrow;
  }
  /** 確かめ画面の印のビルドだけが読む: 部品の位置（重ねた比べ・■6）。区分・倍率・主な部品の矩形（pt） */
  mbDebugLayout(): string {
    const r = (k: string) => {
      const e = this.mbEl[k];
      if (!e) return `${k}=-`;
      const b = e.getBoundingClientRect();
      return `${k}=${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}`;
    };
    const v = this.mbView;
    const q = (sel: string) => {
      const e = this.mbRoot?.querySelector(sel);
      if (!e) return `${sel}=-`;
      const b = e.getBoundingClientRect();
      return `${sel}=${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}`;
    };
    return [q(".mb-left .mb-tool"), q(".mb-col-sep"), q(".mb-size"), q(".mb-col-head"), q(".mb-bar .mb-bb"), q(".mb-toolrow .mb-tool"), q(".mb-top .mb-bb"), `cat=${this.mbCat}`, `shape=${this.mbShape}`, `narrow=${this.mbNarrow}`, `frame=${this.frameIndex}`, `hist=${this.history.mutations}`, `sel=${this.selMask ? 1 : 0}`, `xform=${this.xformActive ? 1 : 0}`, `float=${this.floatBuf ? `${this.floatBuf.ox + this.xform.tx},${this.floatBuf.oy + this.xform.ty}` : "-"}`, `text=${this.textDraft ? `${this.textDraft.x},${this.textDraft.y}` : "-"}`, `open=${this.mbPanel ?? "-"}/${this.mbStrip ?? "-"}/${this.mbPanelMemo ?? "-"}`, `island=${this.mbIsland ? 1 : 0}/${this.mbIslandMemo ?? "-"}`, `range=${this.mbRange.on ? 1 : 0}/${this.rangeSel ? `${this.rangeSel.a}-${this.rangeSel.b}` : "-"}`, `tier=${wideTier(this.mbScreen().h) ?? "-"}`, r("island"), r("tlHead"), r("tlFilm"), q(".mb-island .mb-fr"), `hidden=${this.mbToolsHidden ? 1 : 0}`, v ? `view=${v.scale},${v.x},${v.y},${v.rotationDeg}` : "view=-", r("back"), r("left"), r("file"), r("sizes"), r("panels"), r("bar"), r("pic"), r("panel"), r("strip"), r("menu"), r("top"), r("toolrow"), r("groupWrap"), r("list"), r("save"), r("play"), r("hide"), r("zoomBadge"), r("frameBar")].join(" ");
  }

  /** ★V223 (■6): 確かめ画面の印のビルドだけが読む: 本物のタッチのあとの様子（コマ・履歴の数・入れ物の送り・すべらせた行・コマの帯・色の数。作品の中身は書かない） */
  mbDebugTouch(): string {
    const E = this.mbEl;
    return [`frame=${this.frameIndex}`, `frames=${this.project.frames.length}`, `hist=${this.history.mutations}`, `film=${Math.round(E.film?.scrollLeft ?? -1)}`, `tl=${Math.round(E.tlFilm?.scrollLeft ?? -1)}/${Math.round((E.tlFilm?.scrollWidth ?? 0) - (E.tlFilm?.clientWidth ?? 0))}`, `panel=${Math.round(E.panel?.scrollTop ?? -1)}`, `swiped=${this.mbRoot?.querySelectorAll(".mb-lrow.mb-swiped").length ?? 0}`, `framebar=${this.mbFrameBar ?? "-"}`, `layers=${this.project.layerDefs.map((l) => l.id.slice(-3)).join("")}`, `colors=${this.project.colorTable.length}`, `color=${this.colorHex || "clear"}`, `favs=${this.favoriteColors.length}`, `open=${this.mbPanel ?? "-"}/${this.mbStrip ?? "-"}`, `sleep=${this.sleepOn ? 1 : 0}/${this.project.frames.filter((f) => frameHasAsleep(f)).length}/${this.project.frames[this.frameIndex] && frameHasAsleep(this.project.frames[this.frameIndex]) ? 1 : 0}`, `kb=${this.mbLastSize?.h ?? "-"}/${this.mbScreen().h}/${Math.round(window.visualViewport?.height ?? -1)}/${(document.activeElement as HTMLElement | null)?.className?.toString().split(" ")[0] || document.activeElement?.tagName || "-"}/${this.mbEl.panel?.style.transform || "-"}`, `thumbs=${this.mbFilms.map((v) => `${v.visible.size}:${v.el.querySelectorAll("canvas").length}`).join(",")}`].join(" ");
  }

  /** 確かめ画面の印のビルドだけが呼ぶ: 倍率と回転を決めて置く（■6 の拡大の写し）。寄る決まり（settle）を通す＝止まったときと同じ */
  mbDevZoom(scale: number, rotationDeg: number): void {
    const { w, h: hh } = this.mbScreen();
    const o = openView(this.mbShape, w, hh, this.mbDpr());
    if (!o) return;
    const c = this.mbCenter(o);
    const live: View = { scale, rotationDeg, x: 0, y: 0 };
    const lc = this.mbCenter(live);
    live.x = c.x - lc.x;
    live.y = c.y - lc.y;
    this.mbView = settle(live, c, { cat: this.mbShape, w, h: hh, dpr: this.mbDpr(), toolsHidden: this.mbToolsHidden });
    this.mbApplyView(false);
    this.mbShowZoomBadge(false);
  }


  /** 確かめ画面の印のビルドだけが呼ぶ: 言語を替えたあとに画面を組み直す（7 言語の数え・■6） */
  mbDevRebuild(): void {
    const root = this.mbRoot;
    if (!root) return;
    for (const off of this.mbListeners.splice(0)) off();
    cancelAnimationFrame(this.mbRaf);
    this.mbFilmDisconnect();
    this.mbBuild(root);
    this.mbLayout();
    this.refreshAll();
    this.historyChanged();
    this.updateToolButtons();
    this.mbRaf = requestAnimationFrame(this.mbTick);
  }

  /** 確かめ画面の印のビルドだけが呼ぶ: 状態ごとに、文字が切れた・はみ出した要素と横スクロールを数える（7 言語の数え・■6）。
   *  数えるのは「中身が箱より 1px を超えて広い／高い」要素（札の名前が札の外へ出るのを許した .mb-tool-name は、島の余白〔6〕の中なら数えない） */
  mbDevOverflow(): { state: string; n: number; items: string[] }[] {
    const out: { state: string; n: number; items: string[] }[] = [];
    const count = (state: string) => {
      const items: string[] = [];
      const scan = (rootEl: Element | null) => {
        if (!rootEl) return;
        rootEl.querySelectorAll("*").forEach((el) => {
          const e = el as HTMLElement;
          if (!e.offsetParent && getComputedStyle(e).position !== "fixed") return;
          if (e instanceof HTMLCanvasElement || e.tagName === "svg" || e.closest("svg")) return;
          let ow = e.scrollWidth - e.clientWidth;
          let oh = e.scrollHeight - e.clientHeight;
          if (ow <= 1 && oh <= 1) return;
          // ★V223: 当たりを広げる ::before（札の外へ出る・字は切れていない）の分は数えない
          const hit = getComputedStyle(e, "::before");
          if (hit.content !== "none" && hit.position === "absolute") {
            ow -= Math.max(0, -(parseFloat(hit.right) || 0));
            oh -= Math.max(0, -(parseFloat(hit.bottom) || 0));
            if (ow <= 1 && oh <= 1) return;
          }
          // ★V223: 色相の縦棒のつまみ（幅 34）は棒（幅 28）より広い＝ボードのとおり。字ではないので数えない
          //  縦の色のパネルの列（mb-ccol・mb-ccols）は、そのつまみ（右へ 3）と色の値の欄の当たり（下へ 5）の分だけ超える。中の字は 1 つずつ数えている
          if (e.classList.contains("mb-cp") || e.classList.contains("mb-cp-huebox")) return;
          if ((e.classList.contains("mb-ccol") || e.classList.contains("mb-ccols")) && ow <= 3 && oh <= 5) return;
          // ★V223: コマの並びは横に送るもの（コマが多ければ必ず幅を超える）。横の超えは数えない
          if (e.classList.contains("mb-film")) return;
          if (e.classList.contains("mb-panel") || e.classList.contains("mb-strip") || e.classList.contains("mb-list") || e.classList.contains("mb-film") || e.classList.contains("mb-albums") || e.classList.contains("mb-dialog")) {
            if (ow > 1) {
              // 縦に流れるのは許す（パネルの中だけ縦に送る）。はみ出した子も 1 つ書く（直す所を探すため）
              const right = e.getBoundingClientRect().right - 12;
              const kid = [...e.querySelectorAll("*")].find((k) => k.getBoundingClientRect().right > right + 1) as HTMLElement | undefined;
              items.push(`${e.className.split(" ")[0]}:w+${ow}<${kid ? `${kid.tagName.toLowerCase()}.${String(kid.className).split(" ")[0]}` : "?"}`);
            }
            return;
          }
          if (e.classList.contains("mb-tool-name")) {
            const r = e.getBoundingClientRect();
            const col = e.closest(".mb-col, .mb-toolrow, .mb-file, .mb-gcards")?.getBoundingClientRect();
            if (col && r.left >= col.left + 3 && r.right <= col.right - 3) return;
          }
          if (e.clientWidth === 0 && e.clientHeight === 0) return;
          items.push(`${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}:${(e.textContent ?? "").slice(0, 16)}:w+${ow},h+${oh}`);
        });
      };
      scan(this.mbRoot);
      scan(document.getElementById("mb-layer"));
      const hs = document.documentElement.scrollWidth - realScreenWidth();
      if (hs > 1) items.push(`hscroll+${hs}`);
      out.push({ state, n: items.length, items });
    };
    count("01");
    for (const p of ["color", "layer", "toolset", "view"] as PanelId[]) {
      this.mbOpenPanel(p);
      count(`panel:${p}`);
      this.mbCloseEverything();
    }
    const tool0 = this.tool;
    // ★V222: 変形の帯（縦は一覧）も数える（中身は変形していなくても組める）
    for (const tl of ["fill", "shape", "select", "warp", "move", "text", "transform"] as Tool[]) {
      this.runCoreCommand(`tool.${tl}`);
      this.mbOpenStrip(tl);
      count(`${this.mbShape === "medium" && isGroupTool(tl) ? "list" : "strip"}:${tl}`);
      this.mbCloseEverything();
    }
    this.runCoreCommand(`tool.${tool0}`);
    this.mbToggleMore();
    count("menu");
    this.mbCloseEverything();
    // ★V223 (■6): 広げたタイムライン（ふつう・［範囲］オンで範囲あり）・フルカラーの色のパネル・横の詰め方の段 1〜3
    const island0 = this.mbIsland;
    const memo0 = this.mbIslandMemo;
    if (!island0) this.mbSetIsland(true);
    count("island");
    this.mbRange.toggle(this.mbRangeOps());
    this.rangeSel = { a: 0, b: Math.min(2, this.project.frames.length - 1) };
    this.mbRenderIslandHead();
    this.updateFilmSelection();
    count("island:range");
    this.mbRange.toggle(this.mbRangeOps());
    this.mbRenderIslandHead();
    this.updateFilmSelection();
    if (!island0) this.mbSetIsland(false);
    this.mbIslandMemo = memo0;
    const mode0 = this.project.colorMode;
    this.project.colorMode = "fullcolor"; // 数えの間だけ（作品には残さない）
    this.mbOpenPanel("color");
    count("panel:color:full");
    this.project.colorMode = mode0;
    this.mbCloseEverything();
    if (this.mbShape === "wide") {
      for (const n of [1, 2, 3]) {
        for (const k of [1, 2, 3]) this.mbRoot?.classList.toggle(`mb-tier-${k}`, k === n);
        count(`tier:${n}`);
      }
      this.mbArrange();
    }
    this.mbEl.narrow.hidden = false;
    count("narrow");
    this.mbEl.narrow.hidden = !this.mbNarrow;
    return out;
  }

  /** ★V223 (■6): 確かめ画面の印のビルドだけが呼ぶ: 小窓と名前の欄の島を出す（7 言語の数え。閉じるのは呼ぶ側） */
  mbDevAsk(kind: "addFrames" | "wobble" | "rename"): void {
    if (kind === "addFrames") void this.mbAddFramesAsk();
    else if (kind === "wobble") void this.mbWobbleAsk();
    else void askName({ title: mt("mb.layer.rename.btn"), label: t("ed.layer.name.msg"), value: this.project.layerDefs[0]?.name ?? "", okLabel: mt("mb.rename.ok.btn") });
  }

  /** 重い処理の最中か（busyStarted〜busyEnded） */
  mbIsBusy(): boolean {
    return this.mbBusy;
  }

  // =====================================================================================
  // 画面を組む
  // =====================================================================================

  private mbBuild(root: HTMLElement): void {
    this.mbRoot = root;
    root.replaceChildren();
    root.classList.add("mb-ed");
    root.setAttribute("data-own-input", ""); // 描く画面の中の出来事は自分で振り分け層に通す（ui/globalInput.ts は見ない）
    const E = this.mbEl;
    // 絵の地（斜線）と絵
    E.stage = h("div", "mb-stage");
    E.pic = h("div", "mb-pic");
    this.mbArt = document.createElement("canvas");
    this.mbArt.className = "mb-art";
    this.mbArt.width = W;
    this.mbArt.height = H;
    this.mbOvPix = document.createElement("canvas");
    this.mbOvPix.className = "mb-ovpix";
    this.mbOvPix.width = W;
    this.mbOvPix.height = H;
    E.pic.append(this.mbArt, this.mbOvPix);
    this.mbOvUi = document.createElement("canvas");
    this.mbOvUi.className = "mb-ovui";
    E.stage.append(E.pic, this.mbOvUi);
    root.append(E.stage);

    // 戻る
    E.back = btn("mb-back mb-ui mb-round", mt("mb.back.btn"), () => this.mbHost?.back(), icon("chev-left", 24));
    // 左の列（ツール 11）
    E.left = h("div", "mb-col mb-left mb-ui");
    E.leftSep = h("div", "mb-col-sep");
    TOOLS.forEach((d, i) => {
      if (i === 7) E.left.append(E.leftSep);
      const name = t(d.labelKey);
      const b = btn(`mb-tool${d.format ? " mb-has-format" : ""}`, name, () => this.mbToolTap(d.id), icon(d.icon, 22), txt("mb-tool-name", name));
      b.dataset.tool = d.id;
      E.left.append(b);
    });
    // ★V222 (UI §5-11): 縦の上の段（元に戻す・やり直し｜「太さ」と太さ 6 つ）とツールの段（ペン〜スポイト｜まとめたボタン｜色〜表示）。
    //  部品は横と同じもの（mbArrange が入れ物を移す）。まとめたボタンと一覧は縦だけ
    E.top = h("div", "mb-top mb-ui");
    E.topSep = h("span", "mb-row-sep");
    E.toolrow = h("div", "mb-toolrow mb-ui");
    E.rowSep1 = h("span", "mb-row-sep");
    E.rowSep2 = h("span", "mb-row-sep");
    E.group = btn("mb-tool mb-has-format mb-group", "", () => this.mbGroupTap());
    E.groupWrap = h("div", "mb-group-wrap", E.group);
    E.list = h("div", "mb-list mb-ui");
    // 右の列①（保存・書き出し・その他）
    E.file = h("div", "mb-col mb-right mb-file mb-ui");
    E.save = btn("mb-tool mb-save", t("common.save.btn"), () => this.mbHost?.save(), icon("save", 22), txt("mb-tool-name mb-save-name", t("common.save.btn")));
    E.export = disabledBtn("mb-tool", t("ed.export.btn"), icon("export", 22), txt("mb-tool-name", t("ed.export.btn")));
    E.moreBtn = btn("mb-tool", mt("mb.more.btn"), () => this.mbToggleMore(), icon("more", 22), txt("mb-tool-name", mt("mb.more.btn")));
    E.file.append(E.save, E.export, E.moreBtn);
    // 右の列②（太さ）
    E.sizeHead = txt("mb-col-head", mt("mb.size.head.label"));
    E.sizes = h("div", "mb-col mb-right mb-sizes mb-ui", E.sizeHead);
    PEN_SIZES.forEach((n, i) => {
      const dot = h("span", "mb-size-dot");
      const d = [4, 6, 8, 11, 15, 20][i];
      dot.style.width = dot.style.height = `${d}px`;
      // 読み上げ「ペンの太さ 3ドット」＝PC の 2 つのキーを組み合わせる（UI §5-3）
      const name = mt("mb.pen.size.label", { name: t("ed.pen.size.label"), size: t("ed.pen.sizePick.title", { n }) });
      const b = btn("mb-size", name, () => {
        this.runCoreCommand(`pen.size${i + 1}`);
        this.refreshSizePicker();
      }, dot);
      b.dataset.size = String(n);
      E.sizes.append(b);
    });
    // 右の列③（色・レイヤー・ツールの設定・表示）
    E.panels = h("div", "mb-col mb-right mb-panels mb-ui");
    E.colorDot = h("span", "mb-color-dot");
    E.pColor = btn("mb-tool", mt("mb.color.btn"), () => this.mbTogglePanel("color"), E.colorDot, txt("mb-tool-name", mt("mb.color.btn")));
    E.pLayer = btn("mb-tool", t("ed.layer.head.label"), () => this.mbTogglePanel("layer"), icon("layers", 22), txt("mb-tool-name", t("ed.layer.head.label")));
    E.pTool = btn("mb-tool", mt("mb.tools.settings.label"), () => this.mbTogglePanel("toolset"), icon("tool-options", 22), txt("mb-tool-name", mt("mb.tools.settings.label")));
    E.pView = btn("mb-tool", mt("mb.view.btn"), () => this.mbTogglePanel("view"), icon("display", 22), txt("mb-tool-name", mt("mb.view.btn")));
    E.panels.append(E.pColor, E.pLayer, E.pTool, E.pView);
    // 下の帯
    E.bar = this.mbBuildBar();
    // 浮かぶもの（パネル・帯・メニュー・コマの帯・倍率の札・取り消しの表示・案内）
    E.panel = h("div", "mb-panel mb-ui");
    E.strip = h("div", "mb-strip mb-ui");
    E.menu = h("div", "mb-menu mb-ui");
    E.frameBar = h("div", "mb-framebar mb-ui");
    E.zoomBadge = h("div", "mb-zoombadge");
    E.undoBadge = h("div", "mb-undobadge");
    E.narrow = h("div", "mb-narrow mb-ui", h("div", "mb-narrow-box", icon("warn", 28), txt("mb-narrow-title", mt("mb.narrow.head.title")), txt("mb-narrow-msg", mt("mb.narrow.msg"))));
    // ★V223 (F-4): 広げたタイムラインの島（頭は状態が変わるたびに組み直す・フィルムは 1 つを持ち続ける）
    E.tlHead = h("div", "mb-tl-head");
    E.tlFilm = h("div", "mb-film mb-tl-film");
    E.island = h("div", "mb-island mb-ui", E.tlHead, h("div", "mb-tl-filmbox", h("div", "mb-tl-holes"), E.tlFilm, h("div", "mb-tl-holes")));
    for (const k of ["panel", "strip", "menu", "frameBar", "narrow", "list", "island"]) E[k].hidden = true;
    root.append(E.back, E.left, E.file, E.sizes, E.panels, E.top, E.toolrow, E.bar, E.island, E.panel, E.strip, E.list, E.menu, E.frameBar, E.zoomBadge, E.undoBadge, E.narrow);
    this.mbFilmDisconnect();
    this.mbFilms = [
      { el: E.film, big: false, obs: null, visible: new Set() },
      { el: E.tlFilm, big: true, obs: null, visible: new Set() },
    ];
    if (this.mbIsland) E.island.hidden = false;
    this.mbArranged = false;
    this.mbSyncGroup();
    this.mbBindInput(root);
    requestAnimationFrame(() => this.mbFitLabels());
  }

  /** 札の名前が札（56）に入らない言語では、字を小さくして入れる（7.5px まで・はみ出さない＝C9） */
  private mbFitLabels(): void {
    this.mbRoot?.querySelectorAll<HTMLElement>(".mb-tool-name").forEach((el) => {
      const box = el.parentElement;
      if (!box) return;
      el.style.fontSize = "";
      el.style.letterSpacing = "";
      let size = 10;
      while (el.scrollWidth > box.clientWidth - 2 && size > 7.5) {
        size -= 0.5;
        el.style.fontSize = `${size}px`;
        el.style.letterSpacing = "-0.02em";
      }
    });
  }

  private mbBuildBar(): HTMLElement {
    const E = this.mbEl;
    const bar = h("div", "mb-bar mb-ui");
    E.undo = btn("mb-bb", t("keys.cmd.editUndo.label"), () => this.runCoreCommand("edit.undo"), icon("undo", 22));
    E.redo = btn("mb-bb", t("keys.cmd.editRedo.label"), () => this.runCoreCommand("edit.redo"), icon("redo", 22));
    E.play = btn("mb-bb mb-play", t("ed.tl.play.title"), () => this.runCoreCommand("play.toggle"), icon("play", 22));
    E.onion = btn("mb-bb mb-onion", mt("mb.onion.btn"), () => this.setOnionLevel(this.onionLevel > 0 ? 0 : Math.max(1, this.mbOnionPrev)), icon("onion", 22), txt("mb-bb-text", mt("mb.onion.btn")));
    E.prev = btn("mb-bb", t("ed.tl.prev.title"), () => this.runCoreCommand("frame.prev"), icon("prev", 22));
    E.film = h("div", "mb-film");
    E.next = btn("mb-bb", t("ed.tl.next.title"), () => this.runCoreCommand("frame.next"), icon("next", 22));
    E.add = btn("mb-bb", t("keys.cmd.frameAdd.label"), () => this.runCoreCommand("frame.add"), icon("add", 22));
    E.count = h("span", "mb-count mb-num");
    E.copyPrev = btn("mb-bb mb-copyprev", t("ed.tool.copyprev.label"), () => this.runCoreCommand("edit.copyPrev"), icon("copyprev", 22), txt("mb-bb-text", t("ed.tool.copyprev.label")));
    E.expand = btn("mb-bb mb-expand", mt("mb.timeline.expand.title"), () => this.mbToggleIsland(), icon("chev-up", 22));
    E.hide = btn("mb-bb mb-hide", mt("mb.tools.hide.btn"), () => this.mbToggleTools(), icon("focus", 22));
    E.barSep = h("span", "mb-bar-sep");
    bar.append(E.undo, E.redo, E.barSep, E.play, E.onion, E.prev, E.film, E.next, E.add, E.count, E.copyPrev, E.expand, E.hide);
    return bar;
  }

  /** ★V222: 置き方に合わせて部品を入れ物へ移す（横＝左の列・右の列・下の帯／縦＝上の段・ファイルの島・ツールの段・下の帯）。
   *  押せる・押せない・選んでいる印・読み上げの名前は部品が持つので、置き方で食い違わない */
  private mbArrange(): void {
    const E = this.mbEl;
    const root = this.mbRoot;
    if (!root || !E.left) return;
    const tool = (id: Tool) => E.left.querySelector(`[data-tool="${id}"]`) ?? E.toolrow.querySelector(`[data-tool="${id}"]`);
    const toolBtns = TOOLS.map((d) => tool(d.id) as HTMLElement);
    const sizes = [...root.querySelectorAll(".mb-size")] as HTMLElement[];
    const medium = this.mbShape === "medium";
    const scr = this.mbScreen();
    const inMore = viewInMoreAt(this.mbShape, scr.w, scr.h);
    // ★V223 (F-9・UI §5-13): 横の高さが足りないときの詰め方の段（決まりは arrange.ts の wideTier）
    const tier = medium ? 0 : (wideTier(scr.h) ?? 0);
    for (const n of [1, 2, 3]) root.classList.toggle(`mb-tier-${n}`, tier === n);
    root.classList.toggle("mb-shape-wide", !medium);
    root.classList.toggle("mb-shape-medium", medium);
    root.classList.toggle("mb-view-in-more", inMore);
    // ★V225 (UI §5-15): 利き手が左なら、広の左右のかたまりをそっくり入れ替える（置き方は CSS の mb-hand-left・決まりは arrange.ts の wideParts）
    root.classList.toggle("mb-hand-left", handSwapped(this.mbShape, this.mbHand));
    document.documentElement.classList.toggle("mb-medium", medium);
    if (medium) {
      E.top.replaceChildren(E.undo, E.redo, E.topSep, E.sizeHead, ...sizes);
      E.toolrow.replaceChildren(...toolBtns.slice(0, 7), E.rowSep1, E.groupWrap, E.rowSep2, E.pColor, E.pLayer, E.pTool, ...(inMore ? [] : [E.pView]));
      E.left.replaceChildren(...toolBtns.slice(7));
      E.panels.replaceChildren(...(inMore ? [E.pView] : []));
      E.sizes.replaceChildren();
      E.bar.replaceChildren(E.play, E.onion, E.prev, E.film, E.next, E.add, E.count, E.expand, E.hide);
    } else {
      E.left.replaceChildren(...toolBtns.slice(0, 7), E.leftSep, ...toolBtns.slice(7));
      E.sizes.replaceChildren(E.sizeHead, ...sizes);
      E.panels.replaceChildren(E.pColor, E.pLayer, E.pTool, ...(inMore ? [] : [E.pView]));
      E.top.replaceChildren();
      E.toolrow.replaceChildren();
      E.bar.replaceChildren(E.undo, E.redo, E.barSep, E.play, E.onion, E.prev, E.film, E.next, E.add, E.count, E.copyPrev, E.expand, E.hide);
    }
    this.mbArranged = true;
  }

  /** ★V222: 縦の部品の位置（ツールの段の上・上の段とツールの段の横の真ん中・パネルの上）。横では書いた位置を消す */
  private mbPlace(): void {
    const E = this.mbEl;
    if (!E.toolrow) return;
    const { w, h: hh } = this.mbScreen();
    const g = this.mbShape === "medium" ? mediumGeometry(w, hh, this.mbDpr()) : null;
    if (!g) {
      for (const el of [E.toolrow, E.top, E.panel]) el.style.left = el.style.top = "";
      this.mbPlaceIsland();
      this.mbPositionPop();
      return;
    }
    E.toolrow.style.top = `${g.toolRowTop}px`;
    E.toolrow.style.left = `${Math.round(((w - E.toolrow.offsetWidth) / 2) * 2) / 2}px`;
    // 上の段は、戻る（右端 66）とファイルの島（左端＝幅−212）の間の真ん中
    E.top.style.left = `${Math.round(((66 + w - 212) / 2 - E.top.offsetWidth / 2) * 2) / 2}px`;
    E.panel.style.top = `${g.panelTop}px`;
    this.mbPlaceIsland();
    this.mbPositionPop();
  }

  /** ★V222: まとめたボタンの札（最後に使ったものの印と名前・◢・読み上げ「範囲選択（移動・範囲選択・変形・歪み）」） */
  private mbSyncGroup(): void {
    const b = this.mbEl.group;
    if (!b) return;
    const d = TOOLS.find((x) => x.id === this.mbGroupLast)!;
    const name = t(d.labelKey);
    b.replaceChildren(icon(d.icon, 22), txt("mb-tool-name", name));
    b.ariaLabel = mt("mb.group.title", { name });
    b.classList.toggle("mb-on", isGroupTool(this.tool));
    b.classList.toggle("mb-open", this.mbStrip !== null && isGroupTool(this.mbStrip) && this.mbShape === "medium");
  }

  /** 透かすを切ってから戻したときの段（PC の段の値は表示のパネルで選ぶ） */
  private mbOnionPrev = 1;

  // =====================================================================================
  // 入力（振り分け層をつなぐ・V220 の報告 §13 の 8）
  // =====================================================================================

  private mbBindInput(root: HTMLElement): void {
    const self = this;
    const sink: RouterSink = {
      strokeBegin: (s) => this.strokeBegin(s),
      strokeMove: (s) => this.strokeMove(s),
      strokeEnd: (s) => {
        const r = this.strokeEnd(s);
        this.mbHost?.strokeEnded();
        return r;
      },
      strokeCancel: () => this.strokeCancel(),
      modifiersChanged: (m) => this.modifiersChanged(m),
      // 取り消しは列で後から走る（V220 §13 の 8）: handleUndo() → 次の undoRedoShown で解ける Promise
      undo: () => this.mbUndoAwait(),
      redo: () => {
        this.handleRedo();
      },
      pickColor: (pt) => this.pickColorAt(pt),
    };
    const view: RouterView = {
      uiCancel: (id) => {
        this.mbTap?.cancel(id);
        cancelGlobalTap(id);
      },
      gesture: (g) => this.mbGesture(g),
      toggleTools: () => this.mbToggleTools(),
      drawingChanged: (on) => {
        if (on) this.mbTap?.stopInertia(); // ★V223 (F-1): 描き始めたら、送りの惰性を止める
        if (on) this.mbWheel?.end(); // ★V225（第三者レビューの指摘 6）: 描き始めたら、ホイールの寄りを先に済ませる（線の途中で絵が寄らない）
        this.mbDrawing = on;
        this.mbRoot?.classList.toggle("mb-drawing", on);
        this.mbHost?.drawingChanged(on);
      },
      penDeviceDetected: () => this.mbHost?.penDeviceDetected(),
      undoBadge: (k) => this.mbShowUndoBadge(k),
      hover: (pt, style) => {
        this.mbHover = pt ? { ...pt, style } : null;
        this.mbPaintUi();
      },
      predicted: (s) => {
        this.mbPredicted = s;
        this.mbPaintUi();
      },
    };
    this.mbRouter = new InputRouter(
      {
        hitTest: (x, y) => this.mbHitTest(x, y),
        toPixel: (x, y) => this.mbToPixel(x, y),
        state: () => ({ background: false, switching: false, busy: this.mbBusy, tool: this.tool, pan: this.tool === "hand" || this.mbSpacePan }), // 確認・案内は画面を覆う ui（描かない）。busy は重い処理だけ（確認のボタンも振り分け層を通るので、確認を busy にすると押せない）
        settings: () => this.mbInput,
      },
      sink,
      view,
      { penDevice: this.mbOpts.penDevice }
    );
    this.mbTap = new TapManager(
      () => this.otherOperationStarted(),
      () => this.mbBusy
    );
    const onPointer = (e: PointerEvent) => {
      if (!self.mbRouter) return;
      // 外を押すと閉じる（パネル・帯・メニュー・コマの帯）。閉じるための 1 回は描かない（UI §5-5）
      if (e.type === "pointerdown") {
        self.mbEatPointer.delete(e.pointerId); // 前の接触の印が残っていても（離した知らせが来なかった）持ち越さない
        if (self.mbOverlayOpen() && self.mbHitRaw(e.clientX, e.clientY) === "canvas") {
          self.mbCloseOverlays();
          self.mbEatPointer.add(e.pointerId);
        }
      }
      self.mbEatNowId = self.mbEatPointer.has(e.pointerId);
      const routed = self.mbRouter.handle(e);
      self.mbEatNowId = false;
      if (e.type === "pointerup" || e.type === "pointercancel") self.mbEatPointer.delete(e.pointerId);
      if (routed !== "ui") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.type === "pointerdown") self.mbTap?.down(e);
      else if (e.type === "pointermove") self.mbTap?.move(e);
      else if (e.type === "pointerup") self.mbTap?.up(e);
      else if (e.type === "pointercancel") self.mbTap?.cancel(e.pointerId);
    };
    for (const ty of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) this.mbOn(root, ty, onPointer as EventListener, true);
    // 層（確認とお知らせ）の接触も、この振り分け層を通す（手のひらで確認のボタンを押さない）
    setGlobalRouteHook((e) => (this.mbRouter ? this.mbRouter.handle(e) : "ui"));
    this.mbOn(root, "click", ((e: MouseEvent) => this.mbTap?.click(e)) as EventListener, true);
    // OS の標準の動き（長押しのメニュー・文字の選択・二度押しの拡大）を描く画面に出さない（文字の欄を除く）
    this.mbOn(root, "contextmenu", (e) => e.preventDefault(), true);
    this.mbOn(root, "touchstart", ((e: TouchEvent) => {
      const tg = e.target as HTMLElement | null;
      if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA")) return;
      if (e.touches.length > 1 || tg?.closest(".mb-stage")) e.preventDefault();
    }) as EventListener, false, { passive: false });
    this.mbOn(window, "resize", () => this.mbLayout(), false);
    if (window.visualViewport) this.mbOn(window.visualViewport, "resize", () => this.mbKeyboardFit(), false);
    // ハードウェアキーボードの修飾キー（§5-5 の 12）
    const mods = (e: KeyboardEvent) => this.mbRouter?.keyboardModifiers({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    // ★V225 (K・C16): ハードウェアキーボード（PC のプリセットのキー・決まったキー・Space・矢印）。段取りは input/keyboard.ts
    this.mbKeys = new KeyboardHandler({
      mounted: () => this.mounted && !!this.mbRoot,
      blocked: () => this.mbModal || this.mbNarrow || dialogOpen(),
      pointerDown: () => this.mbDrawing,
      tool: () => this.tool,
      settleEraseAll: () => this.settleEraseAll(),
      endArrowSession: () => this.endArrowSession(),
      escapeUi: () => this.mbEscapeUi(),
      escapeKey: () => this.escapeKey(),
      backspaceKey: (r) => this.backspaceKey(r),
      enterKey: (p) => this.enterKey(p),
      nudgeArrow: (dx, dy) => this.nudgeArrow(dx, dy),
      run: (id) => this.mbRunCommand(id),
      togglePlayback: () => this.togglePlayback(),
      spaceHeld: (on) => {
        this.mbSpacePan = on;
      },
      peek: (on) => this.mbPeek(on),
      peeking: () => this.mbXformPeek,
      pointerSessionEnd: () => this.mbInterrupt(),
      now: () => performance.now(),
    });
    if (this.mbKeyPreset) this.mbKeys.setPreset(this.mbKeyPreset);
    this.mbPencilOff?.();
    this.mbPencilOff = installPencilTap((a) => this.mbPencilTap(a));
    this.mbOn(window, "keydown", ((e: KeyboardEvent) => {
      mods(e);
      this.mbKeys?.down(this.mbKeyLike(e));
    }) as EventListener, false);
    this.mbOn(window, "keyup", ((e: KeyboardEvent) => {
      mods(e);
      this.mbKeys?.up(this.mbKeyLike(e));
    }) as EventListener, false);
    this.mbOn(window, "blur", () => this.mbKeys?.blur(), false);
    this.mbOn(window, "pointerdown", () => this.mbKeys?.pointerDown(), true);
    // ★V225 (T・C16): トラックパッドとマウスのホイール（ピンチ・2 本指のスクロール・Ctrl〔⌘〕＋スクロール）。決まりは view/wheel.ts
    this.mbWheel = new WheelGesture({
      zoomed: () => {
        const { w, h: hh } = this.mbScreen();
        const fit = fitScale(this.mbShape, w, hh, this.mbDpr());
        return !!this.mbView && fit !== null && this.mbView.scale > fit;
      },
      primary: (e) => primaryMod(e),
      gesture: (g) => this.mbGesture(g),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
    const onCanvas = (e: { clientX: number; clientY: number; target: EventTarget | null }) => !(e.target as Element | null)?.closest?.(".mb-ui") && !this.mbModal && !this.mbNarrow && !this.mbBusy && !dialogOpen();
    this.mbOn(root, "wheel", ((e: WheelEvent) => {
      if (!onCanvas(e)) return; // パネルや帯の上は、その入れ物の送りのまま
      if (this.mbDrawing) {
        e.preventDefault();
        return;
      }
      if (this.mbWheel?.wheel(e)) e.preventDefault();
    }) as EventListener, false, { passive: false });
    type GestureEv = Event & { scale: number; clientX: number; clientY: number };
    this.mbOn(root, "gesturestart", ((e: GestureEv) => {
      e.preventDefault();
      if (onCanvas(e) && !this.mbDrawing && !this.mbLive) this.mbWheel?.nativeStart(e.clientX, e.clientY);
    }) as EventListener, false, { passive: false });
    this.mbOn(root, "gesturechange", ((e: GestureEv) => {
      e.preventDefault();
      this.mbWheel?.nativeChange(e.scale);
    }) as EventListener, false, { passive: false });
    this.mbOn(root, "gestureend", ((e: GestureEv) => {
      e.preventDefault();
      this.mbWheel?.nativeEnd();
    }) as EventListener, false, { passive: false });
  }

  /** ★V223 (F-1): 入れ物の送りの口（同じ入れ物には同じ口を返す） */
  private mbBoxOf(el: HTMLElement, axis: "x" | "y"): ScrollBox {
    let b = this.mbScrollBoxes.get(el);
    if (!b) {
      b = scrollBoxOf(el, axis);
      this.mbScrollBoxes.set(el, b);
    }
    return b;
  }

  private mbOn(target: EventTarget, type: string, fn: EventListener, capture: boolean, extra: AddEventListenerOptions = {}): void {
    target.addEventListener(type, fn, { capture, ...extra });
    this.mbListeners.push(() => target.removeEventListener(type, fn, { capture }));
  }

  /** rAF: 振り分け層の時計（控えの 150ms・長押し）。出来事の timeStamp と同じ時計 */
  private mbTick = (now: number) => {
    if (!this.mbRouter) return;
    this.mbRouter.tick(now);
    this.mbRaf = requestAnimationFrame(this.mbTick);
  };

  /** 当たり（画面の部品の上か・絵の場所か）。外を押して閉じた 1 回は ui（描かない） */
  private mbHitTest(x: number, y: number): HitKind {
    return this.mbHitRaw(x, y);
  }
  private mbHitRaw(x: number, y: number): HitKind {
    const el = document.elementFromPoint(x, y);
    if (!el) return "canvas";
    if (el.closest(".mb-ui")) return "ui";
    if (this.mbEatNow()) return "ui";
    return "canvas";
  }
  /** いま振り分け層へ渡している出来事が、外を押して閉じた 1 回の接触か（その接触だけを ui にする＝ほかの接触は描ける） */
  private mbEatNowId = false;
  private mbEatNow(): boolean {
    return this.mbEatNowId;
  }

  /** 取り消しを 1 回（コアの列で後から走る）。終わるまで待てる Promise（振り分け層の手のひらの取り消し） */
  private mbUndoWaiters: (() => void)[] = [];
  private mbUndoAwait(): Promise<void> {
    return new Promise((resolve) => {
      this.mbUndoWaiters.push(resolve);
      this.handleUndo();
    });
  }

  // =====================================================================================
  // 絵の表示（倍率は view/zoom.ts・物理画素に揃える）
  // =====================================================================================

  private mbDpr(): number {
    return window.devicePixelRatio || 1;
  }

  /** ★V222: 描く画面が画面の大きさを読む 1 か所。★V225 (L-1): 読むのは view/screen.ts の screenSize（ライブラリ・設定と同じ口。
   *  確かめ画面の印のビルドだけ、差し替えた大きさを返す） */
  private mbScreen(): { w: number; h: number } {
    return screenSize();
  }

  /** いま文字の欄にフォーカスがあるか（ソフトウェアキーボード＝E-3） */
  private mbTextFocused(): boolean {
    const a = document.activeElement as HTMLInputElement | null;
    if (!a) return false;
    if (a.tagName === "TEXTAREA") return true;
    return a.tagName === "INPUT" && !["range", "color", "checkbox", "button"].includes(a.type);
  }

  /**
   * 区分と倍率を決め直す（開いたとき・画面の大きさが変わったとき）。
   * ★V222 (E-2・E-3・UI §4-3):
   *  - 文字の欄にフォーカスがあって高さだけが変わった（キーボード）なら、区分も倍率も決め直さない（寄せるだけ）
   *  - 大きさが変わったら、描いている線をそこまでで確定し、押したことにする途中の接触を取り消す（mbInterrupt＝§5-5 の 14 と同じ）
   *  - 案内（狭・低・744 未満の中）に入るときは、帯・一覧・その他・コマの帯を閉じる。パネルは閉じずに覚え（案内の下で開いたまま）、
   *    案内が出ている間は倍率と位置を動かさない。案内が消えたら、案内に入る前の置き方の倍率と位置から持ち越す
   *  - 置き方（横・縦）が替わったら、開いていたものを新しい置き方の形で開き直し（arrange.ts の carryOpen）、部品を置き直す
   *  - 倍率と位置は carryView（区分が変わらない大きさの変化も同じ関数を通す）。作品の状態（コマ・選択・浮いた絵・変形・四隅・文字の下書き・履歴）には触らない
   */
  private mbLayout(): void {
    if (!this.mbRoot) return;
    const { w, h: hh } = this.mbScreen();
    const size = { w, h: hh };
    if (keyboardOnly(this.mbLastSize, size, this.mbTextFocused())) {
      this.mbKeyboardFit();
      return;
    }
    const resized = !!this.mbLastSize && (this.mbLastSize.w !== w || this.mbLastSize.h !== hh);
    this.mbLastSize = size;
    const dpr = this.mbDpr();
    this.mbCat = categoryOf(w, hh);
    if (resized) {
      this.mbWheel?.drop(); // ★V225（第三者レビューの指摘 6）: 大きさが変わったら、ホイールの途中の動きは捨てる（古い置き方で寄せない）
      // ★V222（第三者レビューの指摘 2）: ピンチの途中に大きさが変わったら、ジェスチャーを始める前の倍率と位置へ戻す（古い置き方で寄せない）
      this.mbResizing = true;
      this.mbInterrupt();
      this.mbResizing = false;
    }
    // 案内（決-20・E-2・決まりは narrow.ts）: 作品は開いたまま、描きかけは確定する
    const step = narrowStep(this.mbNarrow, w, hh);
    if (step.changed) {
      this.mbNarrow = step.narrow;
      this.mbEl.narrow.hidden = !step.narrow;
      if (step.interrupt) {
        this.mbInterrupt();
        this.mbCloseTransient();
        this.mbRowDragEnd(true);
      }
    }
    const shape = shapeOf(w, hh);
    if (shape) {
      if (shape !== this.mbShape || !this.mbArranged) {
        const prev = this.mbShape;
        const wasArranged = this.mbArranged;
        const next = carryOpenIsland(prev, shape, this.mbIslandState());
        this.mbShape = shape;
        this.mbArrange();
        if (wasArranged && prev !== shape) this.mbApplyOpen(next);
      } else this.mbArrange();
      const ctx: ViewCtx = { cat: shape, w, h: hh, dpr };
      if (!this.mbView || !this.mbViewCtx) this.mbView = openView(shape, w, hh, dpr);
      else this.mbView = carryView(this.mbViewCtx, ctx, this.mbView, this.mbToolsHidden) ?? this.mbView;
      this.mbViewCtx = ctx;
      this.mbPlace();
      this.mbFitLabels();
    }
    if (this.mbOvUi) {
      this.mbOvUi.width = Math.round(w * dpr);
      this.mbOvUi.height = Math.round(hh * dpr);
      this.mbOvUi.style.width = `${w}px`;
      this.mbOvUi.style.height = `${hh}px`;
    }
    this.mbApplyView(false);
    if (this.mbEl.zoomBadge?.classList.contains("mb-show")) this.mbShowZoomBadge(false);
  }

  /** 絵の要素へ倍率と位置を当てる（animate＝寄る 0.16s） */
  private mbApplyView(animate: boolean): void {
    const v = this.mbView;
    const pic = this.mbEl.pic;
    if (!v || !pic) return;
    const s = v.scale;
    const rot = ((v.rotationDeg % 360) + 360) % 360;
    const rotated = Math.abs((rot % 180) - 90) < 45;
    const bw = (rotated ? H : W) * s;
    const bh = (rotated ? W : H) * s;
    const cx = v.x + bw / 2;
    const cy = v.y + bh / 2;
    pic.style.width = `${W * s}px`;
    pic.style.height = `${H * s}px`;
    pic.classList.toggle("mb-settling", animate && !this.mbReducedMotion());
    pic.style.transform = `translate(${cx - (W * s) / 2 - PIC_BORDER}px, ${cy - (H * s) / 2 - PIC_BORDER}px) rotate(${v.rotationDeg}deg)${this.mbFlip ? " scaleX(-1)" : ""}`;
    this.mbPaintUi();
  }

  /** 画面の座標 → 絵の画素の座標（小数・画素 n が [n, n+1)） */
  private mbToPixel(x: number, y: number): { x: number; y: number } {
    const v = this.mbView;
    if (!v) return { x: -1, y: -1 };
    const c = this.mbCenter(v);
    const a = (-v.rotationDeg * Math.PI) / 180;
    let dx = x - c.x;
    const dy = y - c.y;
    const rx = dx * Math.cos(a) - dy * Math.sin(a);
    const ry = dx * Math.sin(a) + dy * Math.cos(a);
    dx = this.mbFlip ? -rx : rx;
    return { x: dx / v.scale + W / 2, y: ry / v.scale + H / 2 };
  }

  /** 絵の画素の座標 → 画面の座標 */
  private mbToScreen(px: number, py: number, v = this.mbView): { x: number; y: number } {
    if (!v) return { x: 0, y: 0 };
    const c = this.mbCenter(v);
    let dx = (px - W / 2) * v.scale;
    const dy = (py - H / 2) * v.scale;
    if (this.mbFlip) dx = -dx;
    const a = (v.rotationDeg * Math.PI) / 180;
    return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
  }

  private mbCenter(v: View): { x: number; y: number } {
    const rot = ((v.rotationDeg % 360) + 360) % 360;
    const rotated = Math.abs((rot % 180) - 90) < 45;
    return { x: v.x + ((rotated ? H : W) * v.scale) / 2, y: v.y + ((rotated ? W : H) * v.scale) / 2 };
  }

  /** ジェスチャー（2 本指で動かす・ピンチ・ひねる＝同時。離すと寄る 0.16s） */
  private mbGesture(g: GestureUpdate): void {
    if (!this.mbView || this.mbNarrow) return;
    const dpr = this.mbDpr();
    const { w, h: hh } = this.mbScreen();
    const fit = fitScale(this.mbShape, w, hh, dpr)!;
    if (g.phase === "start") {
      this.mbKeys?.notePanned(); // ★V225 (K): Space を押している間に絵を動かしたら、すぐ離しても再生にしない
      this.mbBase = { ...this.mbView };
      this.mbLive = true;
      // ★V222 (E-5): 縦のまとめたボタンの一覧は、2 本指で触れたら閉じる
      if (this.mbShape === "medium" && this.mbStrip && isGroupTool(this.mbStrip)) this.mbCloseTransient();
      return;
    }
    const base = this.mbBase ?? this.mbView;
    if (g.phase === "revert" || this.mbResizing) {
      this.mbView = base;
      this.mbBase = null;
      this.mbLive = false;
      this.mbApplyView(true);
      return;
    }
    // 始めの中心の下の絵の点が、いまの中心に付いてくる
    const s = liveScale(base.scale * g.scale, fit);
    const k = s / base.scale;
    const c0 = { x: g.center.x - g.pan.dx, y: g.center.y - g.pan.dy };
    const bc = this.mbCenter(base);
    const a = (g.rotationDeg * Math.PI) / 180;
    const ox = (bc.x - c0.x) * k;
    const oy = (bc.y - c0.y) * k;
    const ncx = g.center.x + ox * Math.cos(a) - oy * Math.sin(a);
    const ncy = g.center.y + ox * Math.sin(a) + oy * Math.cos(a);
    const rotDeg = base.rotationDeg + g.rotationDeg;
    const live: View = { scale: s, rotationDeg: rotDeg, x: 0, y: 0 };
    const lc = this.mbCenter({ ...live, x: 0, y: 0 });
    live.x = ncx - lc.x;
    live.y = ncy - lc.y;
    this.mbView = live;
    this.mbShowZoomBadge(true);
    if (g.phase === "move") {
      this.mbApplyView(false);
      return;
    }
    // end: 寄る・吸い付く
    this.mbLive = false;
    this.mbBase = null;
    this.mbView = settle(live, g.center, { cat: this.mbShape, w, h: hh, dpr, toolsHidden: this.mbToolsHidden });
    this.mbApplyView(true);
    this.mbShowZoomBadge(false);
  }

  /** 倍率の札（拡大縮小している間と、離してから 1.3 秒） */
  private mbShowZoomBadge(live: boolean): void {
    const el = this.mbEl.zoomBadge;
    const v = this.mbView;
    if (!el || !v) return;
    const { w, h: hh } = this.mbScreen();
    const fit = fitScale(this.mbShape, w, hh, this.mbDpr());
    el.replaceChildren(txt("mb-zoom-num mb-num", `×${Math.round(v.scale * 10) / 10}`));
    if (!live) el.append(txt("mb-zoom-label", v.scale === fit ? mt("mb.zoom.fit.label") : mt("mb.zoom.dotExact.label")));
    el.classList.add("mb-show");
    // 見える範囲の下の中央（下から 16・札の高さ 40）
    const vis = visibleArea(this.mbShape, w, hh, this.mbDpr(), this.mbToolsHidden);
    if (vis) {
      el.style.left = `${vis.x + vis.w / 2}px`;
      // ★V223 (F-4): 島が開いていれば島の上 16（見える範囲の計算と fit・端の決まりは変えない＝島は絵の上に浮かぶだけ）
      const it = this.mbIslandTop();
      el.style.top = `${Math.min(vis.y + vis.h - 16 - 40, it === null ? Infinity : it - ISLAND.badgeClear - 40)}px`;
    }
    if (this.mbZoomBadgeTimer) clearTimeout(this.mbZoomBadgeTimer);
    this.mbZoomBadgeTimer = live ? null : setTimeout(() => el.classList.remove("mb-show"), 1300);
  }

  private mbReducedMotion(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** 表示のパネル: 回転を 0° に戻す・大きさを戻す・左右反転 */
  private mbResetRotation(): void {
    if (!this.mbView) return;
    const c = this.mbCenter(this.mbView);
    const v: View = { ...this.mbView, rotationDeg: 0 };
    const nc = this.mbCenter(v);
    v.x += c.x - nc.x;
    v.y += c.y - nc.y;
    const { w, h: hh } = this.mbScreen();
    const vis = visibleArea(this.mbShape, w, hh, this.mbDpr(), this.mbToolsHidden)!;
    this.mbView = clampToEdges(v, vis, this.mbDpr());
    this.mbApplyView(true);
  }
  private mbResetZoom(): void {
    const { w, h: hh } = this.mbScreen();
    const o = openView(this.mbShape, w, hh, this.mbDpr());
    if (!o || !this.mbView) return;
    this.mbView = { ...o, rotationDeg: this.mbView.rotationDeg };
    const vis = visibleArea(this.mbShape, w, hh, this.mbDpr(), this.mbToolsHidden)!;
    if (this.mbView.rotationDeg % 180 !== 0) this.mbView = clampToEdges(this.mbView, vis, this.mbDpr());
    this.mbApplyView(true);
  }

  /** ツールを隠す・表示する（絵の倍率と位置は変えない＝見える範囲だけ変わる） */
  private mbToggleTools(): void {
    this.mbToolsHidden = !this.mbToolsHidden;
    if (this.mbToolsHidden) {
      // ★V223 (F-4): 島も閉じて覚える（表示に戻すと開く＝パネルと同じ。決まりは timeline.ts の hideTools・showTools）
      this.mbHiddenMemo = hideTools(this.mbIslandState()).memo;
      this.mbHiddenShape = this.mbShape;
      this.mbPanelBeforeHide = this.mbPanel;
      this.mbCloseEverything();
      this.mbSetIsland(false);
      this.mbIslandMemo = null;
    } else {
      let back = this.mbHiddenMemo ? showTools(this.mbIslandState(), this.mbHiddenMemo) : null;
      this.mbHiddenMemo = null;
      // 隠している間に区分が替わっていたら、覚えた島とパネルを新しい区分の形にする（縦の覚えを横へ持ち込まない）
      if (back?.island && this.mbHiddenShape !== this.mbShape) back = carryOpenIsland(this.mbHiddenShape, this.mbShape, back);
      if (this.mbPanelBeforeHide) {
        this.mbOpenPanel(this.mbPanelBeforeHide);
        this.mbPanelBeforeHide = null;
      }
      if (back?.island) {
        this.mbIslandMemo = back.islandMemo;
        this.mbSetIsland(true);
        if (back.panel && !this.mbPanel) this.mbShowPanel(back.panel);
      }
    }
    this.mbRoot?.classList.toggle("mb-tools-hidden", this.mbToolsHidden);
    const E = this.mbEl;
    E.hide.replaceChildren(icon(this.mbToolsHidden ? "tools-show" : "focus", 22));
    E.hide.ariaLabel = this.mbToolsHidden ? mt("mb.tools.show.btn") : mt("mb.tools.hide.btn");
    E.hide.classList.toggle("mb-on", this.mbToolsHidden);
    if (this.mbToolsHidden) showToast(this.mbOpts.fourFingerTap ? mt("mb.tools.hidden.toast") : mt("mb.tools.hiddenNoTap.toast"));
  }

  /** キーボードが出たら、文字の帯と浮かんでいる文字が隠れないように（L6）。
   *  ★V222: 縦でも同じ（帯は下端をキーボードの上 8 へ・浮かんでいる文字が隠れるなら絵ごと上へずらす）。キーボードが出たかは、
   *  最後に決めた画面の高さ（mbLastSize）と見えている高さで見る（キーボードでは区分を決め直さない＝E-3） */
  /** ソフトウェアキーボードが出ているか（最後に決めた画面の高さと見えている高さ） */
  private mbKeyboardUp(): boolean {
    const vv = window.visualViewport;
    if (!vv) return false;
    return (this.mbLastSize?.h ?? this.mbScreen().h) - vv.height > 80;
  }

  private mbKeyboardFit(): void {
    const vv = window.visualViewport;
    const stage = this.mbEl.stage;
    if (!vv || !stage) return;
    const layoutH = this.mbLastSize?.h ?? this.mbScreen().h;
    const kb = layoutH - vv.height > 80;
    // ★V223 (F-8): 縦の色の値の欄にフォーカスがあってキーボードが出たら、パネルを、欄がキーボードの上 8 に来るまで上へ寄せる
    //  （絵に重なってよい・フォーカスが外れたら戻す）
    const panel = this.mbEl.panel;
    if (panel) {
      // ★V223: フォーカスのある欄そのものを見る（覚えてある cpHex は、パネルを組み直すと別の要素になる）
      const act = document.activeElement;
      const hexIn = act instanceof HTMLInputElement && act.classList.contains("mb-hexin") && panel.contains(act) ? act : null;
      let up = 0;
      if (kb && hexIn) {
        panel.style.transform = "";
        // ★キーボードが出ると、iOS は見えている範囲を下へ送る（vv.offsetTop）。このあと送りを 0 に戻す（下の scrollTo）ので、
        //  欄の位置は送りの分を足して数える（足さないと「隠れていない」と数えて、戻したあと欄がキーボードの下に残る）
        up = Math.max(0, hexIn.getBoundingClientRect().bottom + vv.offsetTop + 8 - vv.height);
      }
      panel.style.transform = up ? `translateY(${-up}px)` : "";
    }
    let shift = 0;
    if (kb && this.textDraft) {
      const p = this.mbToScreen(this.textDraft.x, this.textDraft.y + this.textDraft.size * 1.4);
      const limit = vv.height - 16;
      if (p.y > limit) shift = limit - p.y;
    }
    let popTop = Infinity;
    let popL = 0;
    let popR = 0;
    for (const el of [this.mbEl.strip, this.mbEl.list]) {
      if (!el || el.hidden) continue;
      if (kb) {
        const top = Math.max(8, vv.height - el.offsetHeight - 8);
        el.style.top = `${top}px`;
        el.style.bottom = "auto";
        const r = el.getBoundingClientRect();
        popTop = top;
        popL = r.left;
        popR = r.right;
      } else {
        el.style.top = el.dataset.top ?? "";
        el.style.bottom = el.dataset.bottom ?? "";
      }
    }
    if (kb && this.textDraft) {
      // 浮かんでいる文字が、キーボードの上の帯に重なるなら、帯の上まで絵ごと上へずらす
      const a = this.mbToScreen(this.textDraft.x, this.textDraft.y + this.textDraft.size * 1.4);
      const b = this.mbToScreen(this.textDraft.x + this.textDraft.size * Math.max(1, this.textDraft.text.length), this.textDraft.y);
      const overlap = Math.max(a.x, b.x) > popL && Math.min(a.x, b.x) < popR;
      const limit = overlap ? Math.min(vv.height - 16, popTop - 8) : vv.height - 16;
      shift = a.y > limit ? limit - a.y : 0;
    }
    stage.style.transform = shift ? `translateY(${shift}px)` : "";
    window.scrollTo(0, 0);
  }

  // =====================================================================================
  // 重ねる層
  // =====================================================================================

  /** 画面の解像度の層（選択の点線・変形の取っ手・四隅・格子・ホバー・予測の線） */
  private mbPaintUi(): void {
    const cv = this.mbOvUi;
    const v = this.mbView;
    if (!cv || !v) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    this.mbStats.overlayPaints++;
    const dpr = this.mbDpr();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const P = (x: number, y: number) => this.mbToScreen(x, y);
    // ピクセル格子（×8 から・物理 1 画素・回っている途中は出さない）
    if (this.mbGrid && v.scale >= 8 && v.rotationDeg % 90 === 0 && !this.mbLive) this.mbPaintGrid(ctx, v, dpr);
    const lw = 1 / dpr;
    // 選択の点線
    const outline = this.mbSelOutlineNow();
    if (outline) {
      const path = new Path2D();
      const { pts, loops } = outline.o;
      for (let k = 0; k + 1 < loops.length; k++) {
        const s = loops[k];
        const e = loops[k + 1];
        if (e - s < 2) continue;
        const p0 = P(pts[2 * s] + outline.dx, pts[2 * s + 1] + outline.dy);
        path.moveTo(p0.x, p0.y);
        for (let q = s + 1; q < e; q++) {
          const p = P(pts[2 * q] + outline.dx, pts[2 * q + 1] + outline.dy);
          path.lineTo(p.x, p.y);
        }
        path.closePath();
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = SKETCH.paper;
      ctx.stroke(path);
      ctx.strokeStyle = SKETCH.ink;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -this.mbAntsPhase;
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
    // 囲んでいる途中の線（自由選択・囲い塗り）
    const trail = this.lassoPts.length > 1 ? this.lassoPts : this.enclosePts.length > 1 ? this.enclosePts : null;
    if (trail) {
      ctx.beginPath();
      const p0 = P(trail[0].x, trail[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (const q of trail.slice(1)) {
        const p = P(q.x, q.y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = SKETCH.paper;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = SKETCH.ink;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 変形の枠と取っ手
    if (this.xformActive && this.floatBuf) {
      const f = this.floatBuf;
      const tr = this.xform;
      const cx = f.ox + f.w / 2 + tr.tx;
      const cy = f.oy + f.h / 2 + tr.ty;
      const hw = Math.abs((f.w / 2) * tr.sx);
      const hh = Math.abs((f.h / 2) * tr.sy);
      const corner = (sx: number, sy: number) => {
        const ca = Math.cos(tr.angle);
        const sa = Math.sin(tr.angle);
        return P(cx + sx * hw * ca - sy * hh * sa, cy + sx * hw * sa + sy * hh * ca);
      };
      const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      ctx.strokeStyle = SKETCH.handle;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      const hs = this.xformHandleWorld();
      const knob = this.clampedHandle(hs[4].x, hs[4].y) ?? hs[4];
      const k1 = P(hs[5].x, hs[5].y);
      const k2 = P(knob.x, knob.y);
      ctx.beginPath();
      ctx.moveTo(k1.x, k1.y);
      ctx.lineTo(k2.x, k2.y);
      ctx.stroke();
      for (let i = 0; i < hs.length; i++) {
        const cl = this.clampedHandle(hs[i].x, hs[i].y);
        const p = P((cl ?? hs[i]).x, (cl ?? hs[i]).y);
        this.mbSquare(ctx, p.x, p.y, cl ? SKETCH.handle : SKETCH.paper, SKETCH.handle);
      }
    }
    // 四隅
    if (this.cornerActive && this.cornerPts.length === 4) {
      ctx.strokeStyle = SKETCH.corner;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      this.cornerPts.forEach((c, i) => {
        const p = P(c.x, c.y);
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
      for (const c of this.cornerHandles()) {
        const p = P(c.x, c.y);
        this.mbSquare(ctx, p.x, p.y, SKETCH.paper, SKETCH.corner);
      }
    }
    // ホバーの輪（太さ）
    if (this.mbHover) {
      const p = P(this.mbHover.x + 0.5, this.mbHover.y + 0.5);
      const r = Math.max(2, (this.penSize / 2) * v.scale);
      ctx.strokeStyle = SKETCH.corner;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (this.mbHover.style === "ring") ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      else {
        ctx.moveTo(p.x - 8, p.y);
        ctx.lineTo(p.x + 8, p.y);
        ctx.moveTo(p.x, p.y - 8);
        ctx.lineTo(p.x, p.y + 8);
      }
      ctx.stroke();
    }
    // 予測の仮の線（確定の線には使わない）
    if (this.mbPredicted && this.mbPredicted.length > 1) {
      ctx.strokeStyle = SKETCH.corner;
      ctx.lineWidth = Math.max(1, this.penSize * v.scale * 0.5);
      ctx.beginPath();
      this.mbPredicted.forEach((s, i) => {
        const p = P(s.x, s.y);
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();
    }
    void lw;
  }

  private mbSquare(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string, stroke: string): void {
    const r = 6;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.strokeRect(x - r, y - r, r * 2, r * 2);
  }

  /** ピクセル格子（各ドットの左端と上端の 1 物理画素・境目の 1〜319 列・1〜239 行・外側の縁には引かない） */
  private mbPaintGrid(ctx: CanvasRenderingContext2D, v: View, dpr: number): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = GRID_RGBA;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const a = this.mbToScreen(0, 0, v);
    const b = this.mbToScreen(W, H, v);
    const x0 = Math.min(a.x, b.x) * dpr;
    const x1 = Math.max(a.x, b.x) * dpr;
    const y0 = Math.min(a.y, b.y) * dpr;
    const y1 = Math.max(a.y, b.y) * dpr;
    const step = v.scale * dpr;
    const cols = Math.round((x1 - x0) / step);
    const rows = Math.round((y1 - y0) / step);
    const top = Math.max(0, Math.round(y0));
    const bot = Math.min(ch, Math.round(y1));
    const lef = Math.max(0, Math.round(x0));
    const rig = Math.min(cw, Math.round(x1));
    for (let i = 1; i < cols; i++) {
      const x = Math.round(x0 + i * step);
      if (x >= 0 && x < cw) ctx.fillRect(x, top, 1, bot - top);
    }
    for (let j = 1; j < rows; j++) {
      const y = Math.round(y0 + j * step);
      if (y >= 0 && y < ch) ctx.fillRect(lef, y, rig - lef, 1);
    }
    ctx.restore();
  }

  /** 選択の境目（作り直すのはマスクの実体が替わったときだけ） */
  private mbSelOutlineNow(): { o: SelOutline; dx: number; dy: number } | null {
    if (!this.selMask || this.xformActive) return null;
    if (this.tool === "select" && this.shapeStart) return null;
    if (this.dragMode === "selmove") return null;
    const drag = this.selMaskDrag;
    const src = drag ? drag.base : this.selMask;
    if (src !== this.mbSelSrc || !this.mbSelOutline) {
      this.mbSelSrc = src;
      this.mbSelOutline = selectionOutline(src, W, H);
    }
    if (this.mbSelOutline.edges === 0) return null;
    return { o: this.mbSelOutline, dx: drag ? drag.dx : 0, dy: drag ? drag.dy : 0 };
  }

  /** 点線を動かす（選択があるときだけ＝C12: 選択が無いとき、何もしていない間は描き直さない） */
  private mbSyncAnts(): void {
    const want = !!this.selMask && !this.xformActive && !this.mbReducedMotion();
    if (want && !this.mbAntsTimer) {
      const tick = () => {
        this.mbAntsTimer = null;
        if (!this.selMask || this.xformActive || !this.mbRoot) return;
        this.mbAntsPhase = (this.mbAntsPhase + 1) % 8;
        this.mbPaintUi();
        this.mbAntsTimer = setTimeout(tick, ANTS_MS);
      };
      this.mbAntsTimer = setTimeout(tick, ANTS_MS);
    } else if (!want) this.mbStopAnts();
  }
  private mbStopAnts(): void {
    if (this.mbAntsTimer) clearTimeout(this.mbAntsTimer);
    this.mbAntsTimer = null;
  }

  /** 絵と同じ 320×240 の層（選択の色・変形の絵・文字の下書き） */
  private mbOvCtx(): CanvasRenderingContext2D | null {
    return this.mbOvPix?.getContext("2d") ?? null;
  }

  private mbFloatCanvas(f: { w: number; h: number; data: ArrayLike<number> }): HTMLCanvasElement {
    const hit = this.mbFloatCv.get(f);
    if (hit) return hit;
    const cv = document.createElement("canvas");
    cv.width = f.w;
    cv.height = f.h;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(f.w, f.h);
    const lut = this.project.colorTable;
    for (let i = 0; i < f.w * f.h; i++) {
      const v = f.data[i];
      if (v === 0) continue;
      const hex = lut[v] ?? SKETCH.textClear;
      img.data[i * 4] = parseInt(hex.slice(1, 3), 16);
      img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.mbFloatCv.set(f, cv);
    return cv;
  }

  // =====================================================================================
  // パネル・帯・メニュー（開くのは 1 つだけ）
  // =====================================================================================

  /** 外を押すと閉じるものが開いているか。★V222 (E-4): 縦のパネルは数えない（開いたまま描ける） */
  private mbOverlayOpen(): boolean {
    return (this.mbShape === "wide" && this.mbPanel !== null) || this.mbTransientOpen();
  }
  /** 一時的に開くもの（帯・縦の一覧・その他のメニュー・コマを長押しの帯） */
  private mbTransientOpen(): boolean {
    return this.mbStrip !== null || this.mbMore || this.mbFrameBar !== null;
  }

  /** 閉じる。横は開いているもの全部（開くのは 1 つ）。★V222 (E-4): 縦は一時的に開くものだけ（パネルは閉じない） */
  private mbCloseOverlays(): void {
    if (this.mbShape === "medium") this.mbCloseTransient();
    else this.mbCloseEverything();
  }
  /** 一時的に開くものを閉じる */
  private mbCloseTransient(): void {
    const E = this.mbEl;
    this.mbStrip = null;
    this.mbMore = false;
    this.mbFrameBar = null;
    for (const k of ["strip", "list", "menu", "frameBar"]) if (E[k]) E[k].hidden = true;
    this.mbMarkOpen();
  }
  /** パネルを閉じる（同じボタン・頭の［×］） */
  private mbClosePanel(): void {
    this.mbRowDragEnd(true);
    if (this.mbEl.panel) this.mbTap?.stopInertia(this.mbBoxOf(this.mbEl.panel, "y"));
    this.mbPanel = null;
    if (this.mbEl.panel) this.mbEl.panel.hidden = true;
    this.mbMarkOpen();
  }
  /** パネルも一時的に開くものも閉じる（ツールを隠す・閉じる・数え） */
  private mbCloseEverything(): void {
    this.mbClosePanel();
    this.mbCloseTransient();
  }

  /** ★V222 (E-3): いま開いているもの（置き方が替わったときの対応の入力） */
  private mbOpenState(): OpenState {
    return { panel: this.mbPanel, strip: this.mbStrip, more: this.mbMore, frameBar: this.mbFrameBar !== null, panelMemo: this.mbPanelMemo };
  }
  /** ★V222 (E-3): 対応のあとの開いているものを、新しい置き方の形で開き直す */
  /** ★V223 (F-4): 開いているものに、島と、縦で島の後ろに覚えたパネルを足したもの */
  private mbIslandState(): IslandOpen {
    return { ...this.mbOpenState(), island: this.mbIsland, islandMemo: this.mbIslandMemo };
  }
  private mbApplyOpen(st: IslandOpen): void {
    this.mbCloseEverything();
    this.mbPanelMemo = st.panelMemo;
    this.mbIslandMemo = st.islandMemo; // 島は開いたまま（置き場は mbPlace が新しい区分の形にする）
    if (st.strip) this.mbOpenStrip(st.strip);
    if (st.panel) this.mbShowPanel(st.panel);
    this.mbSyncGroup();
  }

  private mbMarkOpen(): void {
    const E = this.mbEl;
    E.pColor?.classList.toggle("mb-on", this.mbPanel === "color");
    E.pLayer?.classList.toggle("mb-on", this.mbPanel === "layer");
    E.pTool?.classList.toggle("mb-on", this.mbPanel === "toolset");
    E.pView?.classList.toggle("mb-on", this.mbPanel === "view");
    E.moreBtn?.classList.toggle("mb-on", this.mbMore);
    this.mbSyncGroup();
  }

  private mbTogglePanel(p: PanelId): void {
    if (this.mbPanel === p) {
      this.mbClosePanel();
      return;
    }
    this.mbOpenPanel(p);
  }

  /** パネルを開く。横は開いているものを全部閉じてから（開くのは 1 つ・横で開いたら覚えたパネルは忘れる）。
   *  ★V222 (E-4): 縦はパネルだけを入れ替える（帯と一覧は開いたまま） */
  private mbOpenPanel(p: PanelId): void {
    // ★V223 (F-4): 縦で島が開いているときにパネルを開くと、島は閉じる（覚えない＝timeline.ts の openPanelOver）
    if (this.mbIsland && !openPanelOver(this.mbShape, this.mbIslandState(), p).island) {
      this.mbIslandMemo = null;
      this.mbSetIsland(false);
    }
    if (this.mbShape === "medium") this.mbClosePanel();
    else {
      this.mbCloseEverything();
      this.mbPanelMemo = null;
    }
    this.mbShowPanel(p);
  }
  private mbShowPanel(p: PanelId): void {
    this.mbPanel = p;
    this.mbRenderPanel();
    this.mbEl.panel.hidden = false;
    this.mbPlaceIsland(); // 横で島が開いていれば、パネルの下端は島の上 12
    this.mbAnimate(this.mbEl.panel, "mb-anim-pop");
    this.mbMarkOpen();
  }

  private mbAnimate(el: HTMLElement, cls: string): void {
    if (this.mbDrawing || this.mbReducedMotion()) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  /** パネルの頭（題・［×］） */
  private mbPanelHead(title: string, ...extra: HTMLElement[]): HTMLElement {
    return h("div", "mb-panel-head", txt("mb-panel-title", title), ...extra, btn("mb-sq mb-close", t("common.close.btn"), () => this.mbClosePanel(), icon("close", 20)));
  }

  /** 切り替え（選んでいるものは黄） */
  private mbSeg(items: { label: string; on: boolean; act: () => void }[]): HTMLElement {
    const seg = h("div", "mb-seg");
    for (const it of items) seg.append(btn(`mb-seg-item${it.on ? " mb-on" : ""}`, it.label, () => {
      it.act();
      this.mbRerender();
    }, txt("", it.label)));
    return seg;
  }

  /** スイッチの行（行の全体が当たり） */
  private mbSwitch(label: string, on: boolean, act: () => void): HTMLElement {
    const sw = h("span", `mb-switch${on ? " mb-on" : ""}`, h("span", "mb-knob"));
    const row = btn("mb-switch-row", label, () => {
      act();
      this.mbRerender();
    }, txt("mb-switch-label", label), sw);
    row.setAttribute("role", "switch");
    row.setAttribute("aria-checked", on ? "true" : "false");
    return row;
  }

  /** つまみ（数字つき）。動かしている間は live、離したら commit */
  private mbSlider(label: string, min: number, max: number, value: number, live: (v: number) => void, commit?: (v: number) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.className = "mb-range";
    input.ariaLabel = label;
    // ★V231 (A-158): 横の数字は、つまみが実際にいる値（範囲の外の値で開いても、つまみと数字が食い違わない）
    const num = txt("mb-range-num mb-num", input.value);
    input.addEventListener("input", () => {
      num.textContent = input.value;
      live(Number(input.value));
    });
    input.addEventListener("change", () => commit?.(Number(input.value)));
    return h("label", "mb-range-row", txt("mb-range-label", label), input, num);
  }

  /** 開いているパネル・帯・メニューを今の状態で組み直す */
  private mbRerender(): void {
    if (this.mbPanel) this.mbRenderPanel();
    if (this.mbStrip) this.mbRenderStrip();
    if (this.mbMore) this.mbRenderMore();
  }

  private mbRenderPanel(): void {
    const el = this.mbEl.panel;
    if (!el || !this.mbPanel) return;
    el.replaceChildren();
    this.mbLayerMenuId = null;
    el.classList.toggle("mb-panel-wide", this.mbPanel === "color");
    if (this.mbPanel === "color") this.mbColorPanel(el);
    else if (this.mbPanel === "layer") this.mbLayerPanel(el);
    else if (this.mbPanel === "toolset") this.mbToolsetPanel(el);
    else this.mbViewPanel(el);
    // ★V222 (■2(2)): 縦のツールの設定と表示は 2 列（印 .mb-split の前と後）。入らない分はパネルの中で縦に送る
    if (this.mbShape === "medium" && (this.mbPanel === "toolset" || this.mbPanel === "view")) this.mbTwoCols(el);
  }

  private mbTwoCols(el: HTMLElement): void {
    const kids = [...el.children].slice(1) as HTMLElement[];
    const at = kids.findIndex((k) => k.classList.contains("mb-split"));
    if (at <= 0) return;
    el.append(h("div", "mb-ccols", h("div", "mb-ccol", ...kids.slice(0, at)), h("div", "mb-ccol", ...kids.slice(at))));
  }

  /** 色のパネル。横は 1 列（切り替え・色見本かフルカラーの色の四角・よく使う色・紙の色）。
   *  ★V222 (E-15・UI §5-11): 縦は 2 列＝左に「この作品の色」・「よく使う色」・「紙の色」、右にフルカラーの色の選び。
   *  ★V223 (F-8・U-9): フルカラーの色の選びは canvas の色の四角と色相の縦棒（colorPicker.ts・色は計算で作る）。OS の色の入力はやめた。
   *   縦の右の列は、上に「フルカラー」のスイッチの行・オンのときその下に色の四角と色相・色の値の行（いまの色の見本と #RRGGBB の欄）。
   *   色見本（この作品の色）は、空き番号と同じ色の重なりを出さない（PC と同じ・数も出した数）。パレットのときだけ出す */
  private mbColorPanel(el: HTMLElement): void {
    const full = this.project.colorMode === "fullcolor";
    const medium = this.mbShape === "medium";
    el.append(this.mbPanelHead(mt("mb.color.btn")));
    const work: HTMLElement[] = [];
    if (!full) {
      const cols = shownColors(this.project.colorTable);
      const head = h("div", "mb-sub", txt("", mt("mb.color.workColors.label")), txt("mb-num mb-soft", String(cols.length)));
      const grid = h("div", "mb-swatches");
      const clear = btn(`mb-swatch mb-clear${this.colorHex === "" ? " mb-on" : ""}`, t("ed.color.transparent.title"), () => {
        this.selectColor("");
        this.mbRerender();
      });
      grid.append(clear);
      for (const hex of cols) {
        const b = btn(`mb-swatch${this.colorHex === hex ? " mb-on" : ""}`, hex, () => {
          this.selectColor(hex);
          this.mbRerender();
        });
        b.style.setProperty("--sw", hex);
        grid.append(b);
      }
      work.push(head, grid);
    }
    // フルカラーの色の選び（色の四角と色相）。横は幅 320 のパネルで四角 252×150・間 10・縦棒 28。縦は右の列の幅から縦棒 30 と間 12 を引いた幅×176
    let picker: HTMLElement | null = null;
    let hexRow: HTMLElement | null = null;
    if (full) {
      const colW = (this.mbScreen().w - 2 * 16 - 2 * 15 - 24) / 2;
      const cp = new ColorPicker({
        svW: medium ? Math.max(120, Math.floor(colW - 30 - 12)) : 252,
        svH: medium ? 176 : 150,
        hueW: medium ? 30 : 28,
        gap: medium ? 12 : 10,
        svLabel: mt("mb.color.sv.title"),
        hueLabel: mt("mb.color.hue.title"),
        hex: this.colorHex,
        hue: this.mbPickHue,
        onStart: () => {
          this.mbColorDragging = true;
        },
        // 動かすたびに描く色が替わる（選んだだけでは色の表は増えない＝PC と同じ・足すのは描いたとき）
        onPick: (hex) => {
          this.mbPickHue = cp.hueNow();
          this.selectColor(hex);
        },
        // 離したら、パネルを組み直す（よく使う色の札の字ほか）
        onEnd: () => {
          this.mbColorDragging = false;
          this.mbPickHue = cp.hueNow();
          if (this.mbPanel === "color") this.mbRenderPanel();
        },
      });
      this.mbPickHue = cp.hueNow();
      cp.el.classList.toggle("mb-cp-medium", medium);
      picker = cp.el;
      if (medium) {
        const dot = h("span", `mb-cp-now${this.colorHex ? "" : " mb-clear"}`);
        dot.style.setProperty("--sw", this.colorHex || "transparent");
        const input = document.createElement("input");
        input.className = "mb-hexin mb-num";
        input.type = "text";
        input.value = this.colorHex ? hexLabel(this.colorHex) : "";
        input.maxLength = 7;
        input.ariaLabel = mt("mb.color.hex.label");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("autocapitalize", "characters");
        input.setAttribute("spellcheck", "false");
        input.setAttribute("enterkeyhint", "done");
        // ★V225（追い書き a）: 英数のキーボードを先に出す（打つのは 0〜9・A〜F・# だけ。かなが先に出て得をする場面が無い）。
        //  入力の種類は url（iOS も Android も英字の並びを出す・自動の直しと予測を切る）。type は text のまま（値の読み方は変えない）
        input.setAttribute("inputmode", "url");
        input.setAttribute("autocorrect", "off");
        input.lang = "en";
        // 決めるのは改行か欄を離れたとき。読めない値なら前の値に戻す
        const commit = () => {
          if (!input.isConnected) return; // 組み直しで欄が消えたときの blur では決めない（組み直しの中に入れ子で入らない）
          const hex = parseHexInput(input.value);
          if (hex && hex !== this.colorHex) {
            this.selectColor(hex);
            return; // 色のパネルが組み直る
          }
          input.value = this.colorHex ? hexLabel(this.colorHex) : "";
        };
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          input.blur();
        });
        // ★V223: キーボードが出きるまで少しかかる（visualViewport の resize が来ない端末でも寄せられるように、少しあとにも見る）
        input.addEventListener("focus", () => {
          for (const ms of [0, 350, 700]) setTimeout(() => this.mbKeyboardFit(), ms);
        });
        input.addEventListener("blur", () => {
          commit();
          setTimeout(() => this.mbKeyboardFit(), 0);
        });
        this.mbEl.cpDot = dot;
        this.mbEl.cpHex = input;
        hexRow = h("label", "mb-cp-hexrow", dot, input);
      }
    }
    // よく使う色。★V222 (E-8): 札は PC と同じく、いまの色が登録してなければ「いまの色を登録」（＋）、登録してあれば「登録を外す」（−）。
    //  透明のときは押せない（読み上げの名前は付ける）
    const favNow = this.favoriteHexNow();
    const registered = favNow !== null && this.favoriteColors.includes(favNow);
    const favLabel = registered ? mt("mb.color.favRemove.btn") : mt("mb.color.favAdd.btn");
    const favMark = registered ? txt("mb-chip-mark", "−") : icon("add", 16);
    const favChip =
      favNow === null
        ? disabledBtn("mb-chip", favLabel, favMark, txt("", favLabel))
        : btn("mb-chip", favLabel, () => {
            this.toggleFavoriteColor();
            this.mbRerender();
          }, favMark, txt("", favLabel));
    const favHead = h("div", "mb-sub", txt("", t("ed.color.fav.head.label")), favChip);
    const favs = h("div", "mb-swatches");
    for (const hex of this.favoriteColors) {
      const b = btn(`mb-swatch${this.colorHex === hex ? " mb-on" : ""}`, hex, () => {
        this.selectColor(hex);
        this.mbRerender();
      });
      b.style.setProperty("--sw", hex);
      bindHold(b, {
        hold: () => {
          // 長押しで「登録を外す」（PC の「− 登録を外す」）
          this.selectColor(hex);
          this.toggleFavoriteColor();
          this.mbRerender();
        },
      });
      favs.append(b);
    }
    // 縦は空きを点線の枠で見せる（よく使う色の上限まで・ボードの形）
    if (medium) for (let i = this.favoriteColors.length; i < FAV_SLOTS; i++) favs.append(h("span", "mb-swatch mb-swatch-empty"));
    // 紙の色
    const paperIdx = this.project.frames[this.frameIndex]?.paper ?? 0;
    const paperHex = this.project.colorTable[paperIdx] ?? "";
    const pd = h("span", `mb-swatch mb-swatch-sm${paperIdx === 0 ? " mb-clear" : ""}`);
    pd.style.setProperty("--sw", paperHex || "transparent");
    const paper = btn("mb-row", t("ed.color.paper.label"), () => {
      if (this.colorHex) this.setPaper(this.colorHex);
      this.mbRerender();
    }, txt("mb-row-label", t("ed.color.paper.label")), pd, icon("chev-right", 18));
    if (medium) {
      // 右の列の上: 「フルカラー」のスイッチの行（高さ 32・押すと PC と同じ toggleFullcolor）
      const sw = h("span", `mb-switch${full ? " mb-on" : ""}`, h("span", "mb-knob"));
      const fullRow = btn("mb-switch-row mb-cp-switch", t("ed.color.fullcolor.label"), () => void this.toggleFullcolor().then(() => this.mbRerender()), txt("mb-switch-label", t("ed.color.fullcolor.label")), sw);
      fullRow.setAttribute("role", "switch");
      fullRow.setAttribute("aria-checked", full ? "true" : "false");
      el.append(h("div", "mb-ccols", h("div", "mb-ccol", ...work, favHead, favs, paper), h("div", "mb-ccol mb-cp-col", fullRow, ...(picker ? [picker] : []), ...(hexRow ? [hexRow] : []))));
      return;
    }
    const seg = this.mbSeg([
      { label: mt("mb.color.palette.btn"), on: !full, act: () => full && void this.toggleFullcolor().then(() => this.mbRerender()) },
      { label: t("ed.color.fullcolor.label"), on: full, act: () => !full && void this.toggleFullcolor().then(() => this.mbRerender()) },
    ]);
    el.append(seg, ...work, ...(picker ? [picker] : []), favHead, favs, paper);
  }

  /** レイヤーのパネル。★V222 (UI §5-5・E-14): 行の並びは PC と同じ layerDisplayRows（フォルダの行＝開閉の印・フォルダの絵・中の行は 18 下げる）。
   *  いまの行をもう一度押すとメニュー（フォルダならフォルダのメニュー）。行を長押しから動かすと並べ替えとフォルダへの出し入れ（layerRows.ts）。
   *  レイヤーの行を長押しの前に左へすべらせると統合と削除（今のまま） */
  private mbLayerPanel(el: HTMLElement): void {
    const defs = this.project.layerDefs;
    el.append(
      this.mbPanelHead(
        t("ed.layer.head.label"),
        txt("mb-num mb-soft", String(defs.length)),
        btn("mb-sq", mt("mb.layer.add.btn"), () => {
          this.addLayer();
          this.mbRerender();
        }, icon("add", 20)),
        btn("mb-sq", mt("mb.layer.folder.btn"), () => {
          this.addFolder();
          this.mbRerender();
        }, icon("folder", 20))
      )
    );
    const list = h("div", "mb-layers");
    const rows = layerDisplayRows(this.project);
    const order = rows.map((r) => r.id);
    const plan = this.mbRowDrag?.plan ?? null;
    rows.forEach((r, idx) => {
      const row = r.kind === "folder" ? this.mbFolderRow(r, order) : this.mbLayerRow(r, order);
      if (!row) return;
      row.dataset.idx = String(idx);
      // ★V227 (R-1): フォルダの中の行は、行の箱ごと右へずらす（箱の左端が親より下がる・右端は揃う）。中の余白と並びはどの段も同じ
      row.style.paddingLeft = "8px";
      row.style.marginLeft = `${rowIndent(r.depth)}px`;
      if (this.mbRowDrag && this.mbRowDrag.ids.includes(r.id)) row.classList.add("mb-dragging");
      if (plan?.view.kind === "into" && plan.view.rowIdx === idx) row.classList.add("mb-drop-into");
      if (plan?.view.kind === "line" && plan.view.gap === idx) row.classList.add("mb-drop-above");
      list.append(row);
    });
    if (plan?.view.kind === "line" && plan.view.gap >= rows.length) list.classList.add("mb-drop-end");
    // ★V227 (R-3): 行の左の空いた所（ずらした分）を押したら、その行を押したのと同じ（落とす所は縦の位置だけで決まる＝mbRowDragMove）
    let down: { x: number; y: number } | null = null;
    list.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }), { passive: true });
    bindAct(list, () => {
      if (!down) return;
      const els = [...list.querySelectorAll(":scope > .mb-lrow")] as HTMLElement[];
      const i = gapRowAt(els.map((e) => ({ idx: Number(e.dataset.idx), left: e.getBoundingClientRect().left, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom })), down.x, down.y);
      const body = i === null ? null : els.find((e) => Number(e.dataset.idx) === i)?.querySelector(".mb-lbody");
      if (body) actOf(body)?.act();
    });
    el.append(list);
    const cur = defs.find((l) => l.id === this.activeLayerId);
    if (cur) {
      el.append(
        // ★V231 (A-158): レイヤーは 10〜100（PC と同じ）・コアへは 0〜100 の値をそのまま渡す（コアの setLayerOpacityLive が 100 で割る）
        this.mbSlider(mt("mb.layer.opacity.label"), 10, 100, Math.round((cur.opacity ?? 1) * 100), (v) => this.setLayerOpacityLive(cur, v), () => this.mbRerender())
      );
    }
    el.append(
      h(
        "div",
        "mb-panel-foot",
        btn("mb-wide", t("ed.layer.mergeDown.title"), () => void this.mergeLayerDown().then(() => this.mbRerender()), icon("merge-down", 20), txt("", t("ed.layer.mergeDown.title"))),
        btn("mb-sq", t("ed.layer.shared.off.title"), () => cur && void this.toggleLayerShared(cur.id).then(() => this.mbRerender()), icon("pin", 20)),
        btn("mb-sq", mt("mb.layer.delete.btn"), () => void this.deleteLayer().then(() => this.mbRerender()), icon("trash", 20))
      )
    );
  }

  /** レイヤーの行（目・サムネ・名前・全コマ共通の印。左へすべらせると統合と削除） */
  private mbLayerRow(r: LayerListRow, order: string[]): HTMLElement | null {
    const ld = this.project.layerDefs.find((l) => l.id === r.id);
    if (!ld) return null;
    const active = ld.id === this.activeLayerId && !this.selectedFolderId;
    const row = h("div", `mb-lrow${active ? " mb-active" : ""}${!active && this.selectedNodeIds.has(ld.id) ? " mb-sel" : ""}`);
    const eye = btn("mb-eye", mt("mb.layer.visible.title"), () => {
      this.toggleLayerVisible(ld);
      this.mbRerender();
    }, icon(ld.visible ? "eye" : "eye-off", 20));
    const thumb = document.createElement("canvas");
    thumb.className = "mb-lthumb";
    thumb.width = 104;
    thumb.height = 82;
    this.mbPaintLayerThumb(thumb, ld.id);
    const name = txt("mb-lname", ld.name);
    const body = btn("mb-lbody", ld.name, () => {
      if (this.activeLayerId === ld.id && !this.selectedFolderId) this.mbLayerMenu(ld.id);
      else {
        this.selectLayerRow(ld.id, "layer", { ctrlOrMeta: false, shift: false, primary: false }, order);
        this.mbRerender();
      }
    }, thumb, name, ld.shared ? icon("pin", 16) : null);
    bindHold(body, {
      swipe: (dx) => {
        if (dx < 0) row.classList.add("mb-swiped");
        else row.classList.remove("mb-swiped");
      },
      ...this.mbRowHold(ld.id, "layer"),
    });
    const acts = h(
      "div",
      "mb-lacts",
      btn("mb-lact", mt("mb.layer.merge.btn"), () => {
        this.selectLayerRow(ld.id, "layer", { ctrlOrMeta: false, shift: false, primary: false }, order);
        void this.mergeLayerDown().then(() => this.mbRerender());
      }, txt("", mt("mb.layer.merge.btn"))),
      btn("mb-lact mb-warn", mt("mb.layer.remove.btn"), () => {
        this.selectLayerRow(ld.id, "layer", { ctrlOrMeta: false, shift: false, primary: false }, order);
        void this.deleteLayer().then(() => this.mbRerender());
      }, txt("", mt("mb.layer.remove.btn")))
    );
    row.append(eye, body, acts);
    bindScroll(row, this.mbBoxOf(this.mbEl.panel, "y"), "y"); // ★V223 (F-1): 行のどこからでもパネルを送れる
    return row;
  }

  /** ★V222 (UI §5-5): フォルダの行（目・開閉の印・フォルダの絵・名前）。いまのフォルダの行をもう一度押すとフォルダのメニュー */
  private mbFolderRow(r: LayerListRow, order: string[]): HTMLElement | null {
    const f = this.folderById(r.id);
    if (!f) return null;
    const active = this.selectedFolderId === f.id;
    const row = h("div", `mb-lrow mb-frow${active ? " mb-active" : ""}${!active && this.selectedNodeIds.has(f.id) ? " mb-sel" : ""}`);
    const eye = btn("mb-eye", mt("mb.layer.visible.title"), () => {
      this.toggleFolderVisible(f);
      this.mbRerender();
    }, icon(f.visible ? "eye" : "eye-off", 20));
    const fold = btn("mb-eye mb-fold", t("ed.layer.folderCollapse.title"), () => {
      this.toggleFolderCollapsed(f);
      this.mbRerender();
    }, icon(f.collapsed ? "chev-right" : "chev-down", 20));
    fold.setAttribute("aria-expanded", f.collapsed ? "false" : "true");
    const body = btn("mb-lbody", f.name, () => {
      if (this.selectedFolderId === f.id) this.mbFolderMenu(f.id);
      else {
        this.selectLayerRow(f.id, "folder", { ctrlOrMeta: false, shift: false, primary: false }, order);
        this.mbRerender();
      }
    }, icon("folder", 24), txt("mb-lname", f.name), f.locked ? icon("pin", 16) : null);
    bindHold(body, this.mbRowHold(f.id, "folder"));
    row.append(eye, fold, body);
    bindScroll(row, this.mbBoxOf(this.mbEl.panel, "y"), "y");
    return row;
  }

  /** ★V222 (UI §5-5): フォルダのメニュー（名前を変える・ロック・不透明度・フォルダを削除） */
  private mbFolderMenu(fid: string): void {
    const el = this.mbEl.panel;
    const f = this.folderById(fid);
    if (!f) return;
    el.replaceChildren(this.mbPanelHead(f.name));
    const item = (label: string, ic: MobileIconId, act: () => unknown, warn = false) =>
      btn(`mb-row${warn ? " mb-warn-text" : ""}`, label, () => {
        void Promise.resolve(act()).then(() => this.mbRerender());
      }, icon(ic, 20), txt("mb-row-label", label));
    let opBefore: number | null = null;
    el.append(
      // ★V223 (F-2): 名前の欄の島で聞く（iOS の WebView は頁の prompt を出さない）。中身はコアの renameFolder（PC と同じ・履歴もコアのまま）
      item(mt("mb.layer.rename.btn"), "text", async () => {
        const v = await askName({ title: mt("mb.layer.rename.btn"), label: t("ed.layer.folderName.msg"), value: f.name, okLabel: mt("mb.rename.ok.btn") });
        if (v !== null && this.folderById(f.id) === f) this.renameFolder(f, v);
      }),
      item(mt("mb.layer.lock.btn"), "pin", () => this.toggleFolderLock(f.id)),
      this.mbSlider(mt("mb.layer.opacity.label"), 0, 100, Math.round((f.opacity ?? 1) * 100), (v) => {
        if (opBefore === null) opBefore = f.opacity;
        this.setFolderOpacityLive(f, v);
      }, () => {
        this.commitFolderOpacity(f, opBefore);
        opBefore = null;
      }),
      item(t("ed.layer.folderDelete.title"), "trash", () => this.deleteFolder(f.id), true)
    );
  }

  // ---------------- ★V222 (E-14): 行を長押しから動かす ----------------

  /** 行の長押し・動かす・離す（コアの口は layerRows.ts の順で呼ぶ） */
  private mbRowHold(id: string, kind: "layer" | "folder"): { hold: () => void; drag: (x: number, y: number) => void; drop: (x: number, y: number, cancelled: boolean) => void } {
    return {
      // ★V222（第三者レビューの記録 4）: 掴む（選びを替える）のは長押しのあと動かしたとき（PC と同じく動いてから）。動かさずに離したら何も変えない
      hold: () => undefined,
      drag: (x, y) => {
        if (!this.mbRowDrag) {
          this.mbRowDrag = RowDrag.begin(this.mbRowOps(), id, kind);
          this.mbRenderPanel();
        }
        this.mbRowDragMove(x, y);
      },
      drop: (_x, _y, cancelled) => this.mbRowDragEnd(cancelled),
    };
  }

  private mbRowOps() {
    return {
      project: () => this.project,
      selected: () => this.selectedNodeIds,
      grab: (id: string, kind: "layer" | "folder") => this.grabRowForDrag(id, kind),
      move: (ids: string[], target: Parameters<EditorCore["performTreeMove"]>[1]) => this.performTreeMove(ids, target),
    };
  }

  /** 指の下の行と位置 → 行き先（上半分／下半分・行の間・最後の行より下）。パネルの端に近づくと中を送る。閉じたフォルダの上で 1 秒止めたら開く */
  private mbRowDragMove(x: number, y: number): void {
    const d = this.mbRowDrag;
    const panel = this.mbEl.panel;
    if (!d || !panel || panel.hidden) return;
    const pr = panel.getBoundingClientRect();
    if (y < pr.top + 40) panel.scrollTop -= 12;
    else if (y > pr.bottom - 40) panel.scrollTop += 12;
    const rows = layerDisplayRows(this.project);
    const els = [...panel.querySelectorAll(".mb-layers > .mb-lrow")] as HTMLElement[];
    let hit: RowDropHit | null = null;
    // ★V222（第三者レビューの指摘 3）: パネルの外（上下も）で離したら落とさない（PC の hitTestRowDrag と同じ）。端の送りはそのまま
    if (x >= pr.left - 12 && x <= pr.right + 12 && y >= pr.top && y <= pr.bottom) {
      hit = { kind: "end" };
      for (const e of els) {
        const r = e.getBoundingClientRect();
        const idx = Number(e.dataset.idx);
        if (y < r.top) {
          hit = { kind: "gap", index: idx };
          break;
        }
        if (y < r.bottom) {
          hit = { kind: "row", index: idx, half: y < r.top + r.height / 2 ? "upper" : "lower" };
          break;
        }
      }
    }
    const before = JSON.stringify(d.plan?.view ?? null);
    d.over(this.mbRowOps(), rows, hit);
    const hoverRow = hit && hit.kind === "row" ? rows[hit.index] : null;
    this.mbRowHoverFolder(hoverRow && hoverRow.kind === "folder" && this.folderById(hoverRow.id)?.collapsed ? hoverRow.id : null);
    // 行き先の見せ方が変わったときだけ組み直す（動かすたびにサムネを描き直さない）
    if (JSON.stringify(d.plan?.view ?? null) !== before) this.mbRenderPanel();
  }

  private mbRowHoverFolder(fid: string | null): void {
    const hv = this.mbRowHover;
    if (hv.folder === fid) return;
    if (hv.timer) clearTimeout(hv.timer);
    hv.timer = null;
    hv.folder = fid;
    if (fid)
      hv.timer = setTimeout(() => {
        hv.timer = null;
        if (this.mbRowDrag) this.openFolderForDrop(fid);
      }, 1000);
  }

  /** 離した（取り上げられた・パネルを閉じた・案内に入ったときは cancelled＝動かさない） */
  private mbRowDragEnd(cancelled: boolean): void {
    const d = this.mbRowDrag;
    this.mbRowHoverFolder(null);
    if (!d) return;
    this.mbRowDrag = null;
    if (d.drop(this.mbRowOps(), cancelled) || this.mbPanel === "layer") this.mbRerender();
  }

  /** いまのレイヤーの行をもう一度押す → そのレイヤーのメニュー（名前・ロック・レイヤーカラー・クリッピング・コピーと貼り付け） */
  private mbLayerMenu(id: string): void {
    const el = this.mbEl.panel;
    const ld = this.project.layerDefs.find((l) => l.id === id);
    if (!ld) return;
    el.replaceChildren(this.mbPanelHead(ld.name));
    this.mbLayerMenuId = id;
    // ★V223 (F-6): 2 コマ以上の範囲を選んでいれば、貼り付けの札の字を PC と同じ「貼り付け → コマ a〜b」にする（中身はコアのまま）
    const range = pasteRange(this.rangeSel, this.project.frames.length);
    const pasteLabel = range ? t("ed.layerclip.pasteToFrames.btn", { from: range.a + 1, to: range.b + 1 }) : t("ed.layerclip.paste.btn");
    const item = (label: string, ic: MobileIconId, act: () => unknown) =>
      btn("mb-row", label, () => {
        void Promise.resolve(act()).then(() => this.mbRerender());
      }, icon(ic, 20), txt("mb-row-label", label));
    el.append(
      // ★V223 (F-2): 名前の欄の島で聞く。中身はコアの renameLayer（PC と同じ）
      item(mt("mb.layer.rename.btn"), "text", async () => {
        const v = await askName({ title: mt("mb.layer.rename.btn"), label: t("ed.layer.name.msg"), value: ld.name, okLabel: mt("mb.rename.ok.btn") });
        if (v !== null && this.project.layerDefs.includes(ld)) this.renameLayer(ld, v);
      }),
      item(mt("mb.layer.lock.btn"), "pin", () => this.toggleLayerLock(ld.id)),
      item(mt("mb.layer.color.btn"), "display", () => this.mbLayerColor(ld.id)),
      item(mt("mb.layer.clip.btn"), "layers", () => this.toggleLayerClipping(ld.id)),
      item(t("ed.layerclip.copy.btn"), "copyprev", () => this.copyLayerFrame()),
      item(pasteLabel, "import", () => this.pasteLayerFrame()),
      item(t("ed.layerclip.pasteNew.btn"), "add", () => this.pasteLayerToNew()),
      item(t("ed.layerclip.pasteAll.btn"), "layers", () => this.pasteLayerAllFrames())
    );
  }

  private async mbLayerColor(id: string): Promise<void> {
    // PC のレイヤーカラーと同じ口（付け先を選ぶのはコアの手続き＝V157 D-2）
    await this.chooseLayerColorScope(id);
  }

  private mbPaintLayerThumb(cv: HTMLCanvasElement, id: string): void {
    const f = this.project.frames[this.frameIndex];
    const b = f?.layers[id];
    const ctx = cv.getContext("2d");
    if (!ctx || !b) return;
    const img = new ImageData(W, H);
    const lut = this.project.colorTable;
    for (let i = 0; i < W * H; i++) {
      const v = b[i];
      if (!v) continue;
      const hex = lut[v] ?? SKETCH.textClear;
      img.data[i * 4] = parseInt(hex.slice(1, 3), 16);
      img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[i * 4 + 3] = 255;
    }
    // ★V223: 縮めるのは画素の計算で（downscaleArea＝PC のサムネと同じ面積平均）。前は使い回しの canvas に置いてから drawImage で
    //  縮めていたが、シミュレーターの WebKit では続けて描いたときに「次に描いた絵」が前の canvas に出た（mbThumbTo の注釈）
    this.mbThumbTo(cv, ctx, img.data);
  }

  /** ★V223: 320×240 の RGBA を、サムネの canvas の大きさへ縮めてそのまま置く（canvas から canvas へ写さない）。
   *  前の作り（使い回しの canvas へ putImageData → drawImage で縮める）は、iPadOS 27 のシミュレーターの WebKit で、
   *  続けて何枚も描くと 1 つ前の canvas に次の絵が赤と青の入れ替わった色で出て、最後の canvas が白のままになった
   *  （コマの並びを組み直した直後・レイヤーの行）。画素を計算して putImageData するだけなら、写す元を共有しない */
  private mbThumbTo(cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D, rgba: Uint8ClampedArray): void {
    if (cv.width <= 0 || cv.height <= 0) return;
    const out = downscaleArea(rgba, W, H, cv.width, cv.height);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(out), cv.width, cv.height), 0, 0);
  }

  private mbToolsetPanel(el: HTMLElement): void {
    const tl = this.tool;
    const toolName = t(TOOLS.find((d) => d.id === tl)?.labelKey ?? "ed.tool.pen.label");
    el.append(this.mbPanelHead(mt("mb.tools.settings.label"), txt("mb-soft", toolName)));
    if (tl === "pen") {
      el.append(txt("mb-sub", t("ed.pen.kind.label")));
      const row = h("div", "mb-texrow");
      for (const d of PEN_TEX) {
        const on = !this.penToneId && this.texture === d.key;
        row.append(btn(`mb-tex${on ? " mb-on" : ""}`, t(d.labelKey), () => {
          this.pickPenTexture(d.key);
          this.mbRerender();
        }, icon(d.icon, 26), txt("", t(d.labelKey))));
      }
      el.append(row);
    } else if (tl === "brush" || tl === "eraser") {
      if (tl === "eraser") el.append(this.mbSwitch(t("ed.eraser.allLayers.label"), this.eraseAllOn(), () => this.setEraseAllLayers(!this.eraseAllOn())));
      el.append(txt("mb-sub", tl === "brush" ? t("ed.tone.head.brush.label") : t("ed.tone.head.eraser.label")));
      el.append(this.mbToneGrid(tl === "brush" ? "brush" : "eraser", tl === "brush" ? this.brushToneId : this.eraserToneId));
    }
    el.append(txt("mb-sub mb-split", mt("mb.feel.head.label")));
    el.append(this.mbSwitch(t("ed.feel.pressure.label"), this.pressureEnabled, () => {
      this.pressureEnabled = !this.pressureEnabled;
      this.mbInput = { ...this.mbInput, pressure: this.pressureEnabled };
    }));
    el.append(this.mbSwitch(t("ed.feel.stabilizer.label"), this.stabilizer, () => (this.stabilizer = !this.stabilizer)));
    el.append(txt("mb-sub", mt("mb.line.head.label")));
    el.append(
      h(
        "div",
        "mb-btnrow",
        btn("mb-wide", mt("mb.line.thicken.btn"), () => this.runCoreCommand("edit.thicken"), icon("line-thicken", 20), txt("", mt("mb.line.thicken.btn"))),
        btn("mb-wide", mt("mb.line.thin.btn"), () => this.runCoreCommand("edit.thin"), icon("line-thin", 20), txt("", mt("mb.line.thin.btn")))
      )
    );
  }

  private mbToneGrid(mode: "brush" | "fill" | "eraser", cur: string): HTMLElement {
    const grid = h("div", "mb-tones");
    for (const tone of TONE_TILES) {
      const b = btn(`mb-tone${tone.id === cur ? " mb-on" : ""}`, t(tone.nameKey), () => {
        this.setToneIdFor(mode, tone.id);
        this.mbRerender();
      });
      const cv = document.createElement("canvas");
      cv.width = 24;
      cv.height = 24;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = this.mbInk();
      for (let y = 0; y < 24; y++)
        for (let x = 0; x < 24; x++) {
          const tile = tone.tile;
          const side = tile ? Math.round(Math.sqrt(tile.length)) : 1;
          const on = !tile || tile[(y % side) * side + (x % side)];
          if (on) ctx.fillRect(x, y, 1, 1);
        }
      b.append(cv);
      grid.append(b);
    }
    return grid;
  }

  /** 画面の文字の色（CSS の変数 --ink を読む＝色を直書きしない） */
  private mbInk(): string {
    return getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "currentColor";
  }

  private mbViewPanel(el: HTMLElement): void {
    el.append(this.mbPanelHead(mt("mb.view.btn")));
    el.append(txt("mb-sub", mt("mb.onion.head.label")));
    el.append(
      this.mbSeg([0, 1, 2, 3].map((lv) => ({ label: lv === 0 ? t("ed.onion.off.btn") : String(lv), on: this.onionLevel === lv, act: () => this.setOnionLevel(lv) })))
    );
    el.append(
      this.mbSeg([
        { label: t("ed.onion.dirPrev.btn"), on: this.onionDir === "prev", act: () => this.setOnionDir("prev") },
        { label: t("ed.onion.dirBoth.btn"), on: this.onionDir === "both", act: () => this.setOnionDir("both") },
        { label: t("ed.onion.dirNext.btn"), on: this.onionDir === "next", act: () => this.setOnionDir("next") },
      ])
    );
    const grid = this.mbSwitch(t("ed.feel.grid.label"), this.mbGrid, () => {
      this.mbGrid = !this.mbGrid;
      this.mbPaintUi();
    });
    grid.classList.add("mb-split");
    el.append(grid);
    el.append(this.mbSwitch(mt("mb.view.flip.label"), this.mbFlip, () => {
      this.mbFlip = !this.mbFlip;
      this.mbApplyView(false);
    }));
    el.append(this.mbSwitch(mt("mb.view.mini.label"), this.mbMini, () => {
      this.mbMini = !this.mbMini;
      this.renderCanvas();
    }));
    el.append(
      btn("mb-wide mb-full", mt("mb.view.resetRotation.btn"), () => this.mbResetRotation(), icon("restore", 20), txt("", mt("mb.view.resetRotation.btn"))),
      btn("mb-wide mb-full", mt("mb.view.resetZoom.btn"), () => this.mbResetZoom(), icon("zoom", 20), txt("", mt("mb.view.resetZoom.btn")))
    );
    if (this.mbMini) {
      const mini = document.createElement("canvas");
      mini.className = "mb-mini";
      mini.width = W;
      mini.height = H;
      presentToCanvas(compositeFrame(this.project, this.frameIndex), mini);
      el.append(mini);
    }
  }

  // ---------------- ツールの帯（左の列から） ----------------

  /** ツールの札を押した（横は左の列・縦はツールの段）。選んでいるツールをもう一度押したとき（U-13）: ペン・ブラシ・消しゴムは
   *  ツールの設定のパネル、ほかは帯（開いていれば閉じる）。持ち替えたときは、横は開いているものを閉じ、縦は帯と一覧だけを閉じる（E-4） */
  private mbToolTap(id: Tool): void {
    if (this.tool === id) {
      const d = TOOLS.find((x) => x.id === id)!;
      if (d.format === "panel") this.mbTogglePanel("toolset");
      else if (d.format === "strip") {
        if (this.mbStrip === id) this.mbCloseTransient();
        else this.mbOpenStrip(id);
      }
      return;
    }
    this.mbCloseOverlays();
    this.runCoreCommand(`tool.${id}`);
  }

  /** ★V222 (E-5・UI §5-11): まとめたボタン。ほかのツールのときは最後に使ったものに持ち替える。4 つのどれかのときは一覧を開く（もう一度で閉じる） */
  private mbGroupTap(): void {
    if (!isGroupTool(this.tool)) {
      this.mbCloseTransient();
      this.runCoreCommand(`tool.${this.mbGroupLast}`);
      return;
    }
    if (this.mbStrip !== null && isGroupTool(this.mbStrip)) this.mbCloseTransient();
    else this.mbOpenStrip(this.tool);
  }

  /** 縦の一覧の札を押した: 持ち替えて、一覧は開いたまま */
  private mbGroupPick(id: Tool): void {
    if (this.tool !== id) this.runCoreCommand(`tool.${id}`);
    if (this.mbShape !== "medium") return;
    // ★V222（第三者レビューの指摘 1）: 持ち替えで変形が終わると updateXformBadge が一覧を閉じることがある。開き直して、見えない一覧を残さない
    this.mbOpenStrip(id);
  }

  /** 帯を開く（横は左の列の帯・縦はまとめたボタンの 4 つなら一覧、塗り・図形・文字なら帯） */
  private mbOpenStrip(id: Tool): void {
    if (this.mbShape === "medium") this.mbCloseTransient();
    else this.mbCloseOverlays();
    this.mbStrip = id;
    const el = this.mbPopEl();
    this.mbRenderStrip();
    el.hidden = false;
    this.mbPositionPop();
    this.mbAnimate(el, "mb-anim-pop");
    this.mbSyncGroup();
  }

  /** いまの帯の要素（縦のまとめたボタンの 4 つは一覧） */
  private mbPopEl(): HTMLElement {
    return this.mbShape === "medium" && this.mbStrip !== null && isGroupTool(this.mbStrip) ? this.mbEl.list : this.mbEl.strip;
  }

  /** 帯と一覧の位置。横: 上端は押したツールの札の高さ・下の帯（下 84）に当たるなら上へ。
   *  ★V222 (E-4・E-5): 縦: 下端はツールの段の上 10、横は押した札（一覧はまとめたボタン）の真ん中に合わせて左右 16 の内。上端は上 72 より上に出さない（中を縦に送る） */
  private mbPositionPop(): void {
    const id = this.mbStrip;
    if (!id) return;
    const el = this.mbPopEl();
    const { w, h: hh } = this.mbScreen();
    if (this.mbShape === "medium") {
      const g = mediumGeometry(w, hh, this.mbDpr());
      if (!g) return;
      const anchor = (isGroupTool(id) ? this.mbEl.group : this.mbEl.toolrow.querySelector(`[data-tool="${id}"]`)) as HTMLElement | null;
      const r = anchor?.getBoundingClientRect();
      const cx = r ? r.left + r.width / 2 : w / 2;
      const left = popLeft(cx, el.offsetWidth, w);
      el.style.left = `${left}px`;
      el.style.top = "auto";
      el.style.bottom = `${hh - g.popBottom}px`;
      el.style.maxHeight = `${g.popBottom - g.popTopLimit}px`;
      // ★V223 (F-10): 文字の帯が、浮かんでいる文字に重なるときは上へ寄せる（上端を上 80。決まりは arrange.ts の textStripPlace）
      if (id === "text") {
        const low: Box = { left, right: left + el.offsetWidth, top: g.popBottom - el.offsetHeight, bottom: g.popBottom };
        if (textStripPlace(low, this.mbTextDraftBox()) === "high") {
          el.style.top = `${TEXT_STRIP_HIGH_TOP}px`;
          el.style.bottom = "auto";
          el.style.maxHeight = `${g.popBottom - TEXT_STRIP_HIGH_TOP}px`;
        }
      }
    } else {
      const b = this.mbEl.left.querySelector(`[data-tool="${id}"]`) as HTMLElement | null;
      const top0 = b ? b.getBoundingClientRect().top : 83;
      el.style.left = el.style.bottom = el.style.maxHeight = "";
      // ★V223 (F-4): 島が開いていれば、帯の下の限りは島の上 12
      const it = this.mbIslandTop();
      const lower = it === null ? hh - 84 : it - ISLAND.clear;
      el.style.maxHeight = it === null ? "" : `${Math.max(120, lower - 8)}px`;
      const limit = lower - el.offsetHeight;
      const top = Math.max(8, Math.min(top0, limit));
      el.style.top = `${top}px`;
    }
    el.dataset.top = el.style.top;
    el.dataset.bottom = el.style.bottom;
  }

  /** ★V223 (F-10): 浮かんでいる文字（文字の下書き）の画面の上の矩形（無ければ null） */
  private mbTextDraftBox(): Box | null {
    const d = this.textDraft;
    if (!d) return null;
    const mask = this.textDraftMask();
    const org = this.textDraftOrigin(d);
    const w0 = mask ? mask.w : 2;
    const h0 = mask ? mask.h : Math.max(2, Math.ceil(d.size * 1.35));
    const ox = mask ? org.x : d.x;
    const oy = mask ? org.y : d.y;
    const ps = [this.mbToScreen(ox, oy), this.mbToScreen(ox + w0, oy), this.mbToScreen(ox, oy + h0), this.mbToScreen(ox + w0, oy + h0)];
    const sh = this.mbStageShift();
    return { left: Math.min(...ps.map((q) => q.x)), right: Math.max(...ps.map((q) => q.x)), top: Math.min(...ps.map((q) => q.y)) + sh, bottom: Math.max(...ps.map((q) => q.y)) + sh };
  }
  /** キーボードで絵ごと上へずらしている分（mbKeyboardFit） */
  private mbStageShift(): number {
    const m = /translateY\((-?[\d.]+)px\)/.exec(this.mbEl.stage?.style.transform ?? "");
    return m ? Number(m[1]) : 0;
  }

  private mbRenderStrip(): void {
    const id = this.mbStrip;
    if (!id || !this.mbEl.strip) return;
    const el = this.mbPopEl();
    el.replaceChildren();
    // ★V222 (E-5): 縦の一覧＝頭にいまの名前と［×］・4 つの札（60 高）・その下にいまのツールの帯の中身（横の帯と同じ部品）
    const asList = el === this.mbEl.list;
    if (asList) {
      const d = TOOLS.find((x) => x.id === id)!;
      el.append(h("div", "mb-panel-head", txt("mb-panel-title", t(d.labelKey)), btn("mb-sq mb-close", t("common.close.btn"), () => this.mbCloseTransient(), icon("close", 20))));
      const cards = h("div", "mb-gcards");
      for (const gid of GROUP_TOOLS) {
        const g = TOOLS.find((x) => x.id === gid)!;
        const b = btn(`mb-gcard${gid === this.tool ? " mb-on" : ""}`, t(g.labelKey), () => this.mbGroupPick(gid), icon(g.icon, 22), txt("mb-tool-name", t(g.labelKey)));
        b.dataset.tool = gid;
        cards.append(b);
      }
      el.append(cards);
    } else el.classList.toggle("mb-strip-wide", id === "warp");
    const head = (key: string): Node => (asList ? document.createDocumentFragment() : h("div", "mb-panel-head", txt("mb-panel-title", t(key))));
    /** ★V222 (E-5): 縦の一覧は、範囲選択の［コピー］［切り取り］［貼り付け］［削除］［選択を解除］で閉じる */
    const closeList = () => {
      if (asList) this.mbCloseTransient();
    };
    const nudge = () =>
      h(
        "div",
        "mb-nudge",
        txt("mb-sub", mt("mb.nudge.head.label")),
        h(
          "div",
          "mb-nudge-row",
          this.mbNudgeBtn(mt("mb.nudge.left.btn"), "chev-left", -1, 0),
          this.mbNudgeBtn(mt("mb.nudge.up.btn"), "chev-up", 0, -1),
          this.mbNudgeBtn(mt("mb.nudge.down.btn"), "chev-down", 0, 1),
          this.mbNudgeBtn(mt("mb.nudge.right.btn"), "chev-right", 1, 0)
        )
      );
    if (id === "fill") {
      el.append(head("ed.fill.head.label"));
      el.append(this.mbSeg([
        { label: t("ed.fill.bucket.btn"), on: this.fillMode === "bucket", act: () => this.setFillMode("bucket") },
        { label: t("ed.fill.enclose.btn"), on: this.fillMode === "enclose", act: () => this.setFillMode("enclose") },
      ]));
      el.append(txt("mb-sub", t("ed.fill.ref.label")));
      el.append(this.mbSeg([
        { label: t("ed.fill.refSelf.btn"), on: !this.fillRefAll, act: () => this.setFillRefAll(false) },
        { label: t("ed.fill.refAll.btn"), on: this.fillRefAll, act: () => this.setFillRefAll(true) },
      ]));
      el.append(txt("mb-sub", t("ed.tone.head.fill.label")), this.mbToneGrid("fill", this.fillToneId));
    } else if (id === "shape") {
      el.append(head("ed.shape.head.label"));
      el.append(this.mbSeg([
        { label: t("ed.shape.line.btn"), on: this.shapeKind === "line", act: () => this.setShapeKind("line") },
        { label: t("ed.shape.rect.btn"), on: this.shapeKind === "rect", act: () => this.setShapeKind("rect") },
        { label: t("ed.shape.ellipse.btn"), on: this.shapeKind === "ellipse", act: () => this.setShapeKind("ellipse") },
      ]));
      el.append(this.mbSwitch(t("ed.shape.fill.label"), this.shapeFill, () => (this.shapeFill = !this.shapeFill)));
    } else if (id === "select") {
      el.append(head("ed.sel.head.label"));
      el.append(this.mbSeg([
        { label: t("ed.sel.rect.btn"), on: this.selectKind === "rect", act: () => this.setSelectKind("rect") },
        { label: t("ed.sel.lasso.btn"), on: this.selectKind === "lasso", act: () => this.setSelectKind("lasso") },
        { label: t("ed.sel.auto.btn"), on: this.selectKind === "auto", act: () => this.setSelectKind("auto") },
      ]));
      if (this.selectKind === "auto") {
        el.append(txt("mb-sub", t("ed.sel.ref.label")));
        el.append(this.mbSeg([
          { label: t("ed.sel.refSel.btn"), on: !this.selectRefAll, act: () => this.setSelectRefAll(false) },
          { label: t("ed.sel.refAll.btn"), on: this.selectRefAll, act: () => this.setSelectRefAll(true) },
        ]));
        el.append(txt("mb-sub", t("ed.sel.scope.label")));
        el.append(this.mbSeg([
          { label: t("ed.sel.scopeConn.btn"), on: !this.selectAutoGlobal, act: () => (this.selectAutoGlobal = false) },
          { label: t("ed.sel.scopeGlobal.btn"), on: this.selectAutoGlobal, act: () => (this.selectAutoGlobal = true) },
        ]));
      }
      el.append(txt("mb-sub", mt("mb.sel.on.label")));
      const op = (label: string, cmd: string) => btn("mb-op", label, () => {
        this.runCoreCommand(cmd);
        closeList();
        this.mbRerender();
      }, txt("", label));
      el.append(h("div", "mb-ops", op(t("ed.sel.copy.btn"), "edit.copy"), op(t("ed.sel.cut.btn"), "edit.cut"), op(t("ed.sel.paste.btn"), "edit.paste"), op(t("ed.sel.delete.btn"), "edit.deleteSelection")));
      const sop = (key: string, name: string, ic: MobileIconId) => btn("mb-sq", t(key), () => {
        this.selOp(name);
        this.mbRerender();
      }, icon(ic, 20));
      el.append(
        h(
          "div",
          "mb-ops2",
          sop("ed.sel.invert.title", "invert", "restore"),
          sop("ed.sel.expand.title", "expand", "line-thicken"),
          sop("ed.sel.contract.title", "contract", "line-thin"),
          sop("ed.sel.copyToLayer.title", "copy-layer", "layers"),
          sop("ed.sel.cutToLayer.title", "cut-layer", "merge-down"),
          sop("ed.sel.toTransform.title", "transform", "transform"),
          btn("mb-sq", t("ed.sel.registerTone.btn"), () => void this.registerCustomTone(), icon("heart", 20))
        )
      );
      el.append(this.mbSwitch(t("ed.sel.maskShow.label"), this.mbSelMaskShow, () => {
        this.mbSelMaskShow = !this.mbSelMaskShow;
        this.cb.onSelMaskShowChange?.(this.mbSelMaskShow);
        this.redrawOverlay();
      }));
      el.append(nudge());
      el.append(btn("mb-wide mb-full", mt("mb.sel.deselect.btn"), () => {
        this.deselect();
        closeList();
        this.mbRerender();
      }, txt("", mt("mb.sel.deselect.btn"))));
    } else if (id === "transform") {
      el.append(head("ed.tool.transform.label"));
      el.append(h("div", "mb-ops", btn("mb-op", t("ed.xform.flipH.btn"), () => this.toggleXformFlip("h"), txt("", t("ed.xform.flipH.btn"))), btn("mb-op", t("ed.xform.flipV.btn"), () => this.toggleXformFlip("v"), txt("", t("ed.xform.flipV.btn")))));
      const num = (label: string, value: string, set: (v: string) => void) => {
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.className = "mb-numin mb-num";
        input.value = value;
        input.ariaLabel = label;
        input.addEventListener("change", () => set(input.value));
        return h("label", "mb-numrow", txt("", label), input);
      };
      const tr = this.xform;
      el.append(
        h(
          "div",
          "mb-nums",
          num(t("ed.xform.angle.label"), String(Math.round((tr.angle * 180) / Math.PI)), (v) => this.setXformAngleInput(v)),
          num(t("ed.xform.scaleW.label"), String(Math.round(tr.sx * 100)), (v) => this.setXformScaleInput("x", v)),
          num(t("ed.xform.scaleH.label"), String(Math.round(tr.sy * 100)), (v) => this.setXformScaleInput("y", v))
        )
      );
      const peek = btn("mb-wide", t("ed.xform.peek.btn"), () => undefined, txt("", t("ed.xform.peek.btn")));
      bindHold(peek, {});
      peek.addEventListener("pointerdown", () => this.mbPeek(true));
      peek.addEventListener("pointerup", () => this.mbPeek(false));
      peek.addEventListener("pointercancel", () => this.mbPeek(false));
      el.append(peek, nudge());
      el.append(txt("mb-hint", mt("mb.xform.decide.hint")));
      el.append(
        h(
          "div",
          "mb-btnrow",
          btn("mb-wide", t("ed.common.cancelMark.btn"), () => {
            this.cancelTransformAndReturn();
            this.mbCloseOverlays();
          }, txt("", t("ed.common.cancelMark.btn"))),
          btn("mb-wide mb-go", t("ed.common.commit.btn"), () => {
            void this.commitTransform().then(() => this.mbCloseOverlays());
          }, icon("check", 20), txt("", t("ed.common.commit.btn")))
        )
      );
    } else if (id === "warp") {
      el.append(head("ed.tool.warp.label"));
      el.append(this.mbSeg([
        { label: t("ed.warp.push.btn"), on: this.warpMode === "push", act: () => this.selectWarpMode("push") },
        { label: t("ed.warp.bulge.btn"), on: this.warpMode === "bulge", act: () => this.selectWarpMode("bulge") },
        { label: t("ed.warp.pinch.btn"), on: this.warpMode === "pinch", act: () => this.selectWarpMode("pinch") },
        { label: t("ed.warp.corner.btn"), on: this.warpMode === "corner", act: () => this.selectWarpMode("corner") },
      ]));
      const hint = this.warpMode === "push" ? mt("mb.warp.push.msg") : this.warpMode === "bulge" ? mt("mb.warp.bulge.msg") : this.warpMode === "pinch" ? mt("mb.warp.pinch.msg") : mt("mb.warp.corner.msg");
      el.append(txt("mb-hint", hint));
      if (this.warpMode === "corner") {
        el.append(
          h(
            "div",
            "mb-btnrow",
            btn("mb-wide", t("ed.common.cancelMark.btn"), () => this.cancelCornerWarp(), txt("", t("ed.common.cancelMark.btn"))),
            btn("mb-wide mb-go", t("ed.common.commit.btn"), () => void this.commitCornerWarp(), icon("check", 20), txt("", t("ed.common.commit.btn")))
          )
        );
      } else {
        el.append(this.mbSlider(t("ed.warp.radius.label"), 8, 80, this.warpRadius, (v) => (this.warpRadius = v)));
        el.append(this.mbSlider(t("ed.warp.strength.label"), 0, 100, this.warpStrength, (v) => (this.warpStrength = v)));
      }
    } else if (id === "move") {
      el.append(head("ed.tool.move.label"), txt("mb-hint", mt("mb.move.hint.msg")), nudge());
    } else if (id === "text") {
      el.append(head("ed.text.head.label"));
      const input = document.createElement("textarea");
      input.className = "mb-textin";
      input.rows = 2;
      input.placeholder = mt("mb.text.input.placeholder");
      input.value = this.textDraft?.text ?? "";
      input.addEventListener("input", () => this.setTextDraftText(input.value));
      this.mbEl.textIn = input;
      const fonts = document.createElement("select");
      fonts.className = "mb-select";
      fonts.ariaLabel = t("ed.text.font.label");
      for (const f of FONTS) {
        const o = document.createElement("option");
        o.value = f.key;
        o.textContent = t(f.labelKey);
        o.selected = f.key === this.textFamily;
        fonts.append(o);
      }
      fonts.addEventListener("change", () => {
        this.setTextFamily(fonts.value as typeof this.textFamily, "options");
        this.mbRerender();
      });
      const def = FONTS.find((f) => f.key === this.textFamily)!;
      const sizes = document.createElement("select");
      sizes.className = "mb-select mb-num";
      sizes.ariaLabel = t("ed.text.size.label");
      for (const s of def.sizes) {
        const o = document.createElement("option");
        o.value = String(s);
        o.textContent = String(s);
        o.selected = s === this.textSize;
        sizes.append(o);
      }
      sizes.addEventListener("change", () => this.setTextSize(Number(sizes.value)));
      el.append(input, txt("mb-sub", t("ed.text.font.label")), fonts, txt("mb-sub", t("ed.text.size.label")), sizes);
      if (def.hasBold) el.append(this.mbSwitch(t("ed.text.bold.label"), this.textBold, () => this.toggleTextBold()));
      el.append(this.mbSeg([
        { label: t("ed.text.dirH.btn"), on: !this.textVertical, act: () => this.setTextVertical(false) },
        { label: t("ed.text.dirV.btn"), on: this.textVertical, act: () => this.setTextVertical(true) },
      ]));
      el.append(
        h(
          "div",
          "mb-btnrow",
          btn("mb-wide", t("ed.common.cancelMark.btn"), () => {
            this.cancelTextDraft();
            this.mbRerender();
          }, txt("", t("ed.common.cancelMark.btn"))),
          btn("mb-wide mb-go", t("ed.common.commit.btn"), () => {
            this.commitTextDraft();
            this.mbRerender();
          }, icon("check", 20), txt("", t("ed.common.commit.btn")))
        )
      );
    }
  }

  /** 下を見る（押している間だけ、変形の絵を薄くする＝PC と同じ 0.18。見せ方だけで作品に触らない） */
  private mbPeek(on: boolean): void {
    if (this.mbXformPeek === on) return;
    this.mbXformPeek = on;
    this.redrawOverlay();
  }

  /** 1 ドット動かす（押し続けると続けて動く＝PC の矢印キー） */
  private mbNudgeBtn(label: string, ic: MobileIconId, dx: number, dy: number): HTMLElement {
    const b = btn("mb-sq", label, () => {
      this.nudgeArrow(dx, dy);
      this.redrawOverlay();
    }, icon(ic, 20));
    let rep: ReturnType<typeof setInterval> | null = null;
    bindHold(b, {
      hold: () => {
        rep = setInterval(() => this.nudgeArrow(dx, dy), 90);
      },
      drop: () => {
        if (rep) clearInterval(rep);
        rep = null;
      },
    });
    return b;
  }

  // ---------------- その他のメニュー ----------------

  private mbToggleMore(): void {
    if (this.mbMore) {
      this.mbCloseOverlays();
      return;
    }
    this.mbCloseOverlays();
    this.mbMore = true;
    this.mbRenderMore();
    this.mbEl.menu.hidden = false;
    this.mbAnimate(this.mbEl.menu, "mb-anim-pop");
    this.mbMarkOpen();
  }

  private mbRenderMore(): void {
    const el = this.mbEl.menu;
    el.replaceChildren();
    const v = this.mbView;
    // 頭: 「12コマ · 320×240 · ×3 ドット等倍」（ボードの形・■5）
    const zoomPart = v ? `×${Math.round(v.scale * 10) / 10} ${mt("mb.zoom.dotExact.label")}` : "";
    const sub = [mt("mb.more.frames.label", { count: this.project.frames.length }), "320×240", zoomPart].filter(Boolean).join(" · ");
    const size = this.mbSize ? `${mt("mb.more.size.label")} ${formatSize(this.mbSize.real)}` : "";
    el.append(h("div", "mb-menu-head", txt("mb-menu-title", this.mbTitle()), txt("mb-menu-sub mb-num", sub), size ? txt("mb-menu-size", size) : null));
    const row = (label: string, ic: MobileIconId, act: (() => void) | null, warn = false) =>
      act ? btn(`mb-mrow${warn ? " mb-warn-text" : ""}`, label, () => {
        this.mbCloseOverlays();
        act();
      }, icon(ic, 20), txt("mb-row-label", label)) : disabledBtn("mb-mrow", label, icon(ic, 20), txt("mb-row-label", label));
    el.append(
      row(mt("mb.more.post.btn"), "post", null),
      row(t("ed.saveAs.btn"), "save", () => this.mbHost?.saveAs()),
      row(mt("mb.more.image.btn"), "camera", null),
      row(t("ed.tool.audio.label"), "audio", null),
      row(mt("mb.more.clearFrame.btn"), "clear", () => this.runCoreCommand("edit.clearFrame"), true),
      row(t("lib.settings.title"), "gear", () => this.mbHost?.settings())
    );
    // ★V222 (E-2・UI §5-11 の最後): 幅が足りない縦（mini の 744 など）では「表示」をここへ移す
    if (viewInMoreAt(this.mbShape, this.mbScreen().w, this.mbScreen().h)) el.append(row(mt("mb.view.btn"), "display", () => this.mbOpenPanel("view")));
  }

  /** 左上の名前（画面の側が入れる） */
  mbTitleText = "";
  private mbTitle(): string {
    return this.mbTitleText;
  }

  // ---------------- コマの並び（下の帯のコマの帯と、広げたタイムラインのフィルム） ----------------

  private mbFilmDisconnect(): void {
    for (const v of this.mbFilms) {
      v.obs?.disconnect();
      v.obs = null;
      v.visible.clear();
    }
  }

  /** ★V223 (F-6): 範囲の決まり（timeline.ts の RangeMode）へ渡すコアの口 */
  private mbRangeOps(): RangeOps {
    return {
      frameIndex: () => this.frameIndex,
      range: () => this.rangeSel,
      anchor: () => this.rangeAnchor,
      setAnchor: (i) => {
        this.rangeAnchor = i;
      },
      clearRange: () => {
        this.rangeSel = null;
      },
      clickFrame: (i, shift) => this.clickFrame(i, shift),
      gotoFrame: (i) => this.gotoFrame(i),
    };
  }

  /** コマの並びを組み直す（下の帯と、開いていれば島のフィルム）。
   *  ★V223 (F-4): サムネは見えているコマだけ描き、見えなくなったら canvas を手放す（PC の V192 と同じ考え）。
   *  ★V223 (F-1): コマは `touch-action: none`。コマの上で指を動かしたら、並びを画面の側で送る（bindScroll） */
  private mbRebuildFilm(): void {
    if (!this.mbEl.film) return;
    // コアが範囲を解いたあと（並べ替え・足す・消す・はりつけ・ゆらゆらと、その取り消し・やり直し）: ［範囲］がオンなら、いまのコマを新しい起点に
    this.mbRange.coreChanged(this.mbRangeOps());
    for (const v of this.mbFilms) this.mbBuildFilm(v);
    this.mbEl.count.textContent = `${this.frameIndex + 1} / ${this.project.frames.length}`;
    this.mbScrollFilm();
    if (this.mbIsland) this.mbRenderIslandHead();
  }

  private mbBuildFilm(v: { el: HTMLElement; big: boolean; obs: IntersectionObserver | null; visible: Set<number> }): void {
    const film = v.el;
    v.obs?.disconnect();
    v.obs = null;
    v.visible.clear();
    this.mbTap?.stopInertia(this.mbBoxOf(film, "x"));
    film.replaceChildren();
    // 島が閉じている間は、島のフィルムを組まない（canvas を持たない）
    if (v.big && !this.mbIsland) return;
    v.obs = new IntersectionObserver((ents) => {
      for (const en of ents) {
        const fr = en.target as HTMLElement;
        const i = Number(fr.dataset.idx);
        if (en.isIntersecting) {
          v.visible.add(i);
          if (!fr.querySelector("canvas")) {
            const cv = document.createElement("canvas");
            cv.width = v.big ? 124 : 92;
            cv.height = v.big ? 96 : 72;
            fr.prepend(cv);
          }
          this.paintFilmThumb(i);
        } else {
          v.visible.delete(i);
          // 見えなくなったら canvas を手放す。眠っているコマは、戻ってきたときに描き直せない（起こさない）ので持ち続ける
          const f = this.project.frames[i];
          const cv = fr.querySelector("canvas");
          if (cv && !(f && this.sleepOn && frameHasAsleep(f))) {
            cv.width = cv.height = 0;
            cv.remove();
          }
        }
      }
    }, { root: film, rootMargin: "0px 120px" });
    const n = this.project.frames.length;
    const box = this.mbBoxOf(film, "x");
    for (let i = 0; i < n; i++) {
      const fr = h("div", `mb-fr${v.big ? " mb-fr-big" : ""}${i === this.frameIndex ? " mb-on" : ""}${inRange(this.rangeSel, i) ? " mb-range" : ""}`);
      fr.dataset.idx = String(i);
      fr.append(txt("mb-fr-num mb-num", String(i + 1)));
      this.mbFrameMark(fr, i);
      bindAct(fr, () => {
        if (this.mbFrameDrag) return;
        // ［範囲］がオンなら起点からそのコマまで・オフならふつうに移る（範囲は解ける）
        this.mbRange.tapFrame(this.mbRangeOps(), i);
        this.updateFilmSelection(); // コアがコマを移さなかったとき（変形の途中）も、青の縁を今の範囲に合わせる
      });
      fr.ariaLabel = t("ed.view.badge.label", { frame: i + 1, total: n });
      fr.setAttribute("role", "button");
      bindHold(fr, {
        hold: () => this.mbOpenFrameBar(i, film),
        drag: (x) => this.mbFrameDragMove(film, i, x),
        drop: (_x, _y, cancelled) => this.mbFrameDrop(cancelled),
      });
      bindScroll(fr, box, "x");
      film.append(fr);
      v.obs.observe(fr);
    }
    // 島のフィルムの最後: 点線の［＋］（PC の「最後にコマをついか」）
    if (v.big) film.append(btn("mb-fr-add", t("ed.tl.addLast.title"), () => void this.addFrame(false, true), icon("add", 22)));
  }

  /** ★V223 (F-4): コマの色の目印（そのコマに付けたレイヤーカラーの最初の色の小さな帯・PC の filmColorMark と同じ決まり。色は作品の値） */
  private mbFrameMark(fr: HTMLElement, i: number): void {
    fr.querySelector(".mb-fr-mark")?.remove();
    const fcs = this.project.frames[i]?.layerColors;
    const first = fcs ? Object.values(fcs)[0] : undefined;
    if (!first) return;
    const bar = h("i", "mb-fr-mark");
    bar.style.setProperty("--sw", first);
    fr.append(bar);
  }

  /** いまのコマが見える所まで送る（下の帯と、開いていれば島のフィルム） */
  private mbScrollFilm(): void {
    for (const v of this.mbFilms) {
      if (v.big && !this.mbIsland) continue;
      const cur = v.el.querySelector(`.mb-fr[data-idx="${this.frameIndex}"]`) as HTMLElement | null;
      if (!cur) continue;
      // 並びの中だけを送る（scrollIntoView は外の入れ物まで送ることがある）
      const a = cur.offsetLeft - v.el.offsetLeft;
      const pad = 6;
      const to = a - pad < v.el.scrollLeft ? a - pad : a + cur.offsetWidth + pad > v.el.scrollLeft + v.el.clientWidth ? a + cur.offsetWidth + pad - v.el.clientWidth : null;
      if (to === null) continue;
      this.mbTap?.stopInertia(this.mbBoxOf(v.el, "x")); // はじいた直後でも、惰性に書き戻させない
      v.el.scrollLeft = to;
    }
  }

  /** コマを長押しして離す → 小さな帯（複製・コピー・はりつけ・複写・さくじょ）。押したコマの上に出す
   *  ★V223 (F-4): 押したコマが選んでいる範囲の中なら、範囲を残したままそのコマへ移る（外なら今のまま）。［範囲］がオンでも範囲を広げない */
  private mbOpenFrameBar(i: number, film: HTMLElement = this.mbEl.film): void {
    // ★V226（独立レビューの指摘・高）: 再生中にいまのコマを長押しすると、コマを移さないので再生が続き、帯の［さくじょ］が進んだコマに当たっていた。
    //  帯を出す前に再生を止める（帯の操作は、押したコマ〔か、それを含む範囲〕に当たる）
    if (this.playing) this.stopPlayback();
    this.mbCloseOverlays();
    this.mbRange.holdFrame(this.mbRangeOps(), i);
    this.mbFrameBar = i;
    const el = this.mbEl.frameBar;
    el.replaceChildren();
    const it = (label: string, cmd: string, warn = false) =>
      btn(`mb-fb${warn ? " mb-warn" : ""}`, label, () => {
        this.mbCloseOverlays();
        this.runCoreCommand(cmd);
      }, txt("", label));
    el.append(
      it(t("ed.tl.dupFrame.btn"), "frame.duplicate"),
      it(t("ed.tl.copyFrames.btn"), "frame.copyPage"),
      it(t("ed.tl.pasteFrames.btn"), "frame.pastePage"),
      it(t("ed.tool.copyprev.label"), "edit.copyPrev"),
      it(t("ed.tl.delFrame.btn"), "frame.delete", true)
    );
    el.hidden = false;
    const fr = film.querySelector(`.mb-fr[data-idx="${i}"]`) as HTMLElement | null;
    const r = fr?.getBoundingClientRect();
    const { w, h: hh } = this.mbScreen();
    if (r) el.style.left = `${Math.max(8, Math.min(w - el.offsetWidth - 8, r.left + r.width / 2 - el.offsetWidth / 2))}px`;
    // 島のコマなら、そのコマの上。下の帯のコマで島が開いていれば、島の上
    const it0 = this.mbIslandTop();
    el.style.bottom = film === this.mbEl.tlFilm && r ? `${hh - r.top + 8}px` : it0 !== null ? `${hh - it0 + 8}px` : "";
    this.mbAnimate(el, "mb-anim-pop");
  }

  /** 長押しから運ぶ（並べ替え・取り消しの列には「コマ並べ替え」で 1 つ＝コアの reorderFrame） */
  private mbFrameDragMove(film: HTMLElement, from: number, x: number): void {
    if (this.mbFrameBar !== null) {
      this.mbEl.frameBar.hidden = true;
      this.mbFrameBar = null;
    }
    const frs = [...film.querySelectorAll(".mb-fr")] as HTMLElement[];
    let to = from;
    for (const fr of frs) {
      const r = fr.getBoundingClientRect();
      if (x >= r.left && x < r.right) to = Number(fr.dataset.idx);
    }
    const fr0 = film.getBoundingClientRect();
    if (x < fr0.left + 24) film.scrollLeft -= 12;
    else if (x > fr0.right - 24) film.scrollLeft += 12;
    this.mbFrameDrag = { from, to };
    this.mbRoot?.querySelectorAll(".mb-fr.mb-drop").forEach((e) => e.classList.remove("mb-drop"));
    frs.forEach((f) => f.classList.toggle("mb-drop", Number(f.dataset.idx) === to && to !== from));
  }

  private mbFrameDrop(cancelled: boolean): void {
    const d = this.mbFrameDrag;
    this.mbFrameDrag = null;
    this.mbRoot?.querySelectorAll(".mb-fr.mb-drop").forEach((e) => e.classList.remove("mb-drop"));
    if (!d || cancelled || d.from === d.to) return;
    void this.reorderFrame(d.from, d.to);
  }

  // ---------------- ★V223 (F-4〜F-7): 広げたタイムライン ----------------

  /** 島の上端（画面の上からの y）。閉じていれば null */
  private mbIslandTop(): number | null {
    const el = this.mbEl.island;
    if (!this.mbIsland || !el || el.hidden) return null;
    return this.mbScreen().h - ISLAND.bottom - el.offsetHeight;
  }

  /** 下の帯の ⌃⌄ */
  private mbToggleIsland(): void {
    const st = this.mbIslandState();
    if (this.mbIsland) {
      // 閉じる: 縦は覚えていたパネルを開く（決まりは timeline.ts の closeIsland）
      const next = closeIsland(this.mbShape, st);
      this.mbIslandMemo = null;
      this.mbSetIsland(false);
      if (next.panel && next.panel !== this.mbPanel) this.mbShowPanel(next.panel);
      return;
    }
    // 開く: 縦は開いていたパネルを閉じて覚える（決まりは timeline.ts の openIsland）
    const next = openIsland(this.mbShape, st);
    if (this.mbPanel && !next.panel) this.mbClosePanel();
    this.mbIslandMemo = next.islandMemo;
    this.mbSetIsland(true);
  }

  /** 島を出す・しまう（覚えたパネルは呼ぶ側が扱う）。しまうと［範囲］はオフになるが、選んだ範囲は残る（F-6） */
  private mbSetIsland(on: boolean): void {
    const E = this.mbEl;
    if (!E.island) return;
    const was = this.mbIsland;
    // コマを長押しの帯は、島の出し入れで置き場が変わるので閉じる
    if (this.mbFrameBar !== null) {
      this.mbFrameBar = null;
      E.frameBar.hidden = true;
    }
    this.mbIsland = on;
    E.island.hidden = !on;
    this.mbRoot?.classList.toggle("mb-island-open", on);
    if (!on) {
      if (was) this.mbRange.islandClosed();
      this.mbBuildFilm(this.mbFilms[1]); // canvas を手放す
    } else {
      this.mbRenderIslandHead();
      this.mbPlaceIsland();
      this.mbBuildFilm(this.mbFilms[1]);
      this.mbPlaceIsland();
      this.mbScrollFilm();
      if (!was) this.mbAnimate(E.island, "mb-anim-slide");
    }
    this.mbSyncIsland();
    this.mbPlaceIsland();
    this.mbPositionPop();
    if (E.zoomBadge?.classList.contains("mb-show")) this.mbShowZoomBadge(false);
  }

  /** 下の帯の ⌃ の札（開いている間は黄で ⌄・読み上げは PC の「タイムラインを畳む」） */
  private mbSyncIsland(): void {
    const b = this.mbEl.expand;
    if (!b) return;
    b.replaceChildren(icon(this.mbIsland ? "chev-down" : "chev-up", 22));
    b.ariaLabel = this.mbIsland ? t("ed.panel.foldTl.title") : mt("mb.timeline.expand.title");
    b.classList.toggle("mb-on", this.mbIsland);
    b.setAttribute("aria-expanded", this.mbIsland ? "true" : "false");
  }

  /** 島と、島に合わせるもの（横のパネルの下端＝島の上 12）の位置 */
  private mbPlaceIsland(): void {
    const E = this.mbEl;
    if (!E.island || !E.panel) return;
    const top = this.mbIslandTop();
    const { h: hh } = this.mbScreen();
    if (this.mbShape === "wide" && top !== null) {
      // パネルは高さを縮めて中を送る
      E.panel.style.bottom = `${hh - top + ISLAND.clear}px`;
      E.panel.style.maxHeight = `${Math.max(120, top - ISLAND.clear - 16)}px`;
    } else {
      E.panel.style.bottom = "";
      E.panel.style.maxHeight = "";
    }
  }

  /** 島の頭（F-5）。1 段目＝題と 7 つの札・2 段目＝［範囲］・先頭・末尾・ループ（左）と速さ（右端）。1 段目が入らなければ札の前で折り返す */
  private mbRenderIslandHead(): void {
    const head = this.mbEl.tlHead;
    if (!head) return;
    const tb = (label: string, act: () => void, cls = "", ...kids: (Node | string)[]) => btn(`mb-tl-btn ${cls}`, label, act, ...(kids.length ? kids : [txt("", label)]));
    const hasClip = MobileEditor.frameClip !== null;
    const paste = hasClip ? tb(t("ed.tl.pasteFrames.btn"), () => void this.pasteFrames()) : disabledBtn("mb-tl-btn", t("ed.tl.pasteFrames.btn"), txt("", t("ed.tl.pasteFrames.btn")));
    const row1 = h(
      "div",
      "mb-tl-row",
      txt("mb-tl-title", t("ed.tl.head.label")),
      tb(t("ed.tl.addFrame.btn"), () => void this.addFrame(false)),
      tb(t("ed.tl.addFrames.btn"), () => void this.mbAddFramesAsk()),
      tb(t("ed.tl.dupFrame.btn"), () => void this.addFrame(true)),
      tb(t("ed.tl.delFrame.btn"), () => void this.deleteFrame(), "mb-warn"),
      tb(t("ed.tl.copyFrames.btn"), () => void this.copySelectedFrames()),
      paste,
      tb(mt("mb.timeline.wobble.btn"), () => void this.mbWobbleAsk(), "", icon("wobble", 20), txt("", mt("mb.timeline.wobble.btn")))
    );
    const range = tb(mt("mb.timeline.range.btn"), () => {
      this.mbRange.toggle(this.mbRangeOps());
      this.updateFilmSelection();
      this.syncPasteRangeLabel();
      this.mbRenderIslandHead();
    }, this.mbRange.on ? "mb-on" : "");
    range.setAttribute("aria-pressed", this.mbRange.on ? "true" : "false");
    const loop = tb(t("ed.tl.loop.title"), () => {
      this.toggleLoop();
      this.mbRenderIslandHead();
    }, `mb-tl-sq${this.project.loop ? " mb-on" : ""}`, icon("loop", 20));
    loop.setAttribute("aria-pressed", this.project.loop ? "true" : "false");
    const speed = document.createElement("select");
    speed.className = "mb-select mb-tl-speed mb-num";
    speed.ariaLabel = t("ed.tl.speed.label");
    FPS_TABLE.forEach((f, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = t("ed.tl.speedOption.label", { n: i, fps: f });
      o.selected = i === this.project.speedIndex;
      speed.append(o);
    });
    speed.addEventListener("change", () => this.setSpeedIndex(Number(speed.value)));
    const row2 = h(
      "div",
      "mb-tl-row",
      range,
      tb(t("ed.tl.first.title"), () => this.gotoFrame(0), "mb-tl-sq", icon("skip-first", 20)),
      tb(t("ed.tl.last.title"), () => this.gotoFrame(this.project.frames.length - 1), "mb-tl-sq", icon("skip-last", 20)),
      loop,
      h("label", "mb-tl-speedbox", txt("mb-tl-speedlabel", t("ed.tl.speed.label")), speed)
    );
    head.replaceChildren(row1, row2);
  }

  /** ［＋ まとめて］: 先に変形の途中を止める（PC と同じ xformGuard）→ 小窓 → コアの addFrames */
  private async mbAddFramesAsk(): Promise<void> {
    if (this.xformGuard()) return;
    const r = await askAddFrames();
    if (!r || !this.mounted) return;
    await this.addFrames(r.count, r.duplicate);
  }

  /** ［ゆらゆら］: 先に変形の途中を止める → 小窓（見本つき）→ コアの applyWobble */
  private async mbWobbleAsk(): Promise<void> {
    if (this.xformGuard()) return;
    if (!this.project.frames[this.frameIndex]) return;
    const opt = await askWobble({
      project: this.project,
      frameIndex: this.frameIndex,
      mask: this.selMask ?? null,
      targets: this.wobbleTargets(),
      seed: (kind, strength) => this.wobbleSeed(kind, strength),
    });
    if (!opt || !this.mounted) return;
    await this.applyWobble(opt);
  }

  /** めくる（傾きだけ・絵に filter を掛けない・再生中と視差効果を減らすでは出さない・描いている間は出さない） */
  private mbFlipPage(): void {
    if (!this.mbFlipOn) return; // ★V225: 設定「コマを変えるときの動き」
    if (this.playing || this.mbDrawing || this.mbReducedMotion()) return;
    const el = this.mbEl.pic;
    if (!el) return;
    el.classList.remove("mb-anim-page");
    void el.offsetWidth;
    el.classList.add("mb-anim-page");
  }

  private mbShowUndoBadge(kind: "undo" | "redo"): void {
    const el = this.mbEl.undoBadge;
    if (!el) return;
    el.replaceChildren(icon(kind === "undo" ? "undo" : "redo", 18), txt("", kind === "undo" ? t("keys.cmd.editUndo.label") : t("keys.cmd.editRedo.label")));
    el.classList.add("mb-show");
    if (this.mbUndoBadgeTimer) clearTimeout(this.mbUndoBadgeTimer);
    this.mbUndoBadgeTimer = setTimeout(() => el.classList.remove("mb-show"), 1000);
  }

  // =====================================================================================
  // ★フック（コアの頭の一覧 51・全部を上書きする。何もしないものも「何もしない」と書く）
  // =====================================================================================

  /** 絵を描き直す（中身はコアの renderWork＝眠ったコマを起こす・1px の仮・オニオン）。1px の仮が打たれている間に見せる */
  protected override renderCanvas(): void {
    if (!this.mbArt) return;
    this.mbStats.repaints++;
    this.renderWork((composite) => {
      if (this.mbArt) presentToCanvas(composite, this.mbArt);
      this.mbArt?.classList.toggle("mb-paper-clear", this.project.frames[this.frameIndex]?.paper === 0);
    });
  }
  protected override paintFilmThumb(i: number): void {
    const targets: HTMLCanvasElement[] = [];
    for (const v of this.mbFilms) {
      if (!v.visible.has(i)) continue;
      const cv = v.el.querySelector(`.mb-fr[data-idx="${i}"] canvas`) as HTMLCanvasElement | null;
      if (cv) targets.push(cv);
    }
    if (!targets.length) return;
    const f = this.project.frames[i];
    // 眠っているコマは起こさない（大きい作品のメモリ）。白のままにして、起きたときに描く
    if (!f || (this.sleepOn && frameHasAsleep(f))) {
      // ★V223: 描かないときも、作ったばかりの canvas を空にしておく（シミュレーターの WebKit で、手放した別のコマの絵が
      //  赤と青が入れ替わった色で残って見えた＝描いていない canvas に前の中身が出た）
      for (const fr of targets) fr.getContext("2d")?.clearRect(0, 0, fr.width, fr.height);
      return;
    }
    const comp = compositeFrame(this.project, i);
    const rgba = new Uint8ClampedArray(comp.buffer, comp.byteOffset, W * H * 4);
    for (const fr of targets) {
      const ctx = fr.getContext("2d");
      if (ctx) this.mbThumbTo(fr, ctx, rgba);
    }
  }
  protected override rebuildFilm(): void {
    this.mbRebuildFilm();
  }
  protected override rebuildLayers(): void {
    super.rebuildLayers(); // V214: 組み直す前に選択の手入れ（コアの既定）
    if (this.mbPanel === "layer") this.mbRenderPanel();
  }
  protected override rebuildPalette(): void {
    this.mbEl.colorDot?.style.setProperty("--sw", this.colorHex || "transparent");
    this.mbEl.colorDot?.classList.toggle("mb-clear", !this.colorHex);
    // ★V223 (F-8): 色の四角・色相を動かしている間は組み直さない（触っている canvas を捨てない）。色の値といまの色の見本だけを直す
    if (this.mbColorDragging) {
      const E = this.mbEl;
      if (E.cpHex?.isConnected) (E.cpHex as HTMLInputElement).value = this.colorHex ? hexLabel(this.colorHex) : "";
      if (E.cpDot?.isConnected) {
        E.cpDot.style.setProperty("--sw", this.colorHex || "transparent");
        E.cpDot.classList.toggle("mb-clear", !this.colorHex);
      }
      return;
    }
    if (this.mbPanel === "color") this.mbRenderPanel();
  }
  protected override rebuildFavPalette(): void {
    if (this.mbPanel === "color" && !this.mbColorDragging) this.mbRenderPanel();
  }
  protected override rebuildTexPicker(): void {
    if (this.mbPanel === "toolset") this.mbRenderPanel();
  }
  protected override buildToolOptions(): void {
    this.mbRerender();
  }
  protected override updateToolButtons(): void {
    this.mbRoot?.querySelectorAll(".mb-left .mb-tool, .mb-toolrow .mb-tool[data-tool]").forEach((b) => b.classList.toggle("mb-on", (b as HTMLElement).dataset.tool === this.tool));
    if (isGroupTool(this.tool)) this.mbGroupLast = this.tool;
    this.mbSyncGroup();
    this.refreshSizePicker();
    this.rebuildPalette();
  }
  protected override afterFormatChange(): void {
    this.mbRerender();
  }
  protected override toolChanging(_t: Tool): void {
    // 何もしない（PC は形式のストリップと太さの表示。モバイルは toolChanged でまとめて見せる）
  }
  protected override toolChanged(): void {
    // ★V225 (P): 前に持っていたツールを覚える（ペンのダブルタップの「前のツールへ」「消しゴムへ切り替え」）
    if (this.mbToolNow !== null && this.mbToolNow !== this.tool) {
      this.mbPrevTool = this.mbToolNow;
      if (this.tool === "eraser") this.mbBeforeEraser = this.mbToolNow;
    }
    this.mbToolNow = this.tool;
    this.updateToolButtons();
    const on = (this.mbShape === "medium" ? this.mbEl.toolrow?.querySelector(".mb-tool.mb-on") : this.mbEl.left?.querySelector(".mb-tool.mb-on")) as HTMLElement | null;
    if (on) this.mbAnimate(on, "mb-anim-pop");
    // 変形・歪みの四隅・文字は帯を開いて決める（決めるときは下のボタンで）
    if (this.tool === "transform" && this.xformActive) this.mbOpenStrip("transform");
  }
  protected override paintUiOverlay(): void {
    this.mbPaintUi();
  }
  protected override paintSelectionUi(): void {
    this.mbSyncAnts();
    this.mbPaintUi();
  }
  /** 不変条件 #8: 選択が変わる道はここを通る。最後に refreshSelectionLauncher() と paintSelectionUi() を呼ぶ（PC と同じ） */
  protected override redrawOverlay(): void {
    const ctx = this.mbOvCtx();
    if (ctx) {
      ctx.clearRect(0, 0, W, H);
      if (this.selMask && !this.xformActive && this.mbSelMaskShow) {
        const img = ctx.createImageData(W, H);
        // 選んだドットに半透明の単色（PC の SEL_MASK_RGBA と同じ役。作品の絵の上の下書き＝配色で変えない）
        for (let i = 0; i < W * H; i++) {
          if (!this.selMask[i]) continue;
          img.data[i * 4] = SEL_MASK[0];
          img.data[i * 4 + 1] = SEL_MASK[1];
          img.data[i * 4 + 2] = SEL_MASK[2];
          img.data[i * 4 + 3] = SEL_MASK[3];
        }
        ctx.putImageData(img, 0, 0);
      }
      if (this.xformActive && this.floatBuf) {
        const f = this.floatBuf;
        const tr = this.xform;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        if (this.mbXformPeek) ctx.globalAlpha = 0.18;
        ctx.translate(f.ox + f.w / 2 + tr.tx, f.oy + f.h / 2 + tr.ty);
        ctx.rotate(tr.angle);
        ctx.scale(tr.sx * (tr.flipH ? -1 : 1), tr.sy * (tr.flipV ? -1 : 1));
        for (const L of this.xformLayers) ctx.drawImage(this.mbFloatCanvas(L.float), -L.float.w / 2, -L.float.h / 2);
        ctx.restore();
      }
      if (this.textDraft) this.mbDrawTextDraft(ctx);
    }
    // ★V223 (F-10): 縦の文字の帯は、浮かんでいる文字が動いたら置き場を決め直す（キーボードが出ている間は mbKeyboardFit のまま）
    if (this.mbShape === "medium" && this.mbStrip === "text" && !this.mbKeyboardUp()) this.mbPositionPop();
    this.refreshSelectionLauncher();
    this.paintSelectionUi();
  }
  protected override clearOverlay(): void {
    this.mbOvCtx()?.clearRect(0, 0, W, H);
  }
  protected override previewShape(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const ctx = this.mbOvCtx();
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = SKETCH.shape;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (this.shapeKind === "line") {
      ctx.moveTo(a.x + 0.5, a.y + 0.5);
      ctx.lineTo(b.x + 0.5, b.y + 0.5);
    } else if (this.shapeKind === "rect") ctx.rect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  protected override previewSelectRect(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const ctx = this.mbOvCtx();
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = SKETCH.selRect;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
    this.mbPaintUi();
  }
  protected override redrawSelMovePreview(): void {
    const ctx = this.mbOvCtx();
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (!this.floatBuf) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.mbFloatCanvas(this.floatBuf), this.floatBuf.ox + this.xform.tx, this.floatBuf.oy + this.xform.ty);
    this.mbPaintUi();
  }
  /** 範囲選択の帯（「選んだところを」のボタン）。帯が開いていれば組み直す */
  protected override refreshSelectionLauncher(): void {
    if (this.mbStrip === "select") this.mbRenderStrip();
  }
  protected override updateFilmSeMarks(): void {
    // 何もしない（効果音の印は音声を入れる M-4 まで出さない）
  }
  protected override updateFilmSelection(): void {
    const film = this.mbEl.film;
    if (!film) return;
    const before = Number(film.dataset.cur ?? "-1");
    // ★V223 (F-6): いまのコマは黄・範囲のコマは青の縁（両方のフィルム）
    for (const v of this.mbFilms)
      v.el.querySelectorAll(".mb-fr").forEach((e) => {
        const i = Number((e as HTMLElement).dataset.idx);
        e.classList.toggle("mb-on", i === this.frameIndex);
        e.classList.toggle("mb-range", inRange(this.rangeSel, i));
      });
    if (this.mbEl.count) this.mbEl.count.textContent = `${this.frameIndex + 1} / ${this.project.frames.length}`;
    film.dataset.cur = String(this.frameIndex);
    this.syncPasteRangeLabel(); // 範囲が変わったら、レイヤーのメニューの貼り付けの札も（PC と同じ）
    if (before !== this.frameIndex) {
      this.mbScrollFilm();
      if (before >= 0) this.mbFlipPage();
      if (this.mbPanel === "layer") this.mbRenderPanel();
    }
  }
  protected override updateFilmColorMark(i: number): void {
    // ★V223 (F-4): 1 コマだけ、色の目印を今の色に直す（両方のフィルム）
    for (const v of this.mbFilms) {
      const fr = v.el.querySelector(`.mb-fr[data-idx="${i}"]`) as HTMLElement | null;
      if (fr) this.mbFrameMark(fr, i);
    }
  }
  protected override updateAudioToolButton(): void {
    // 何もしない（音声は M-4）
  }
  protected override updateXformBadge(): void {
    this.undoRedoShown();
    if (this.xformActive || this.cornerActive) {
      if (this.tool === "transform" && this.mbStrip !== "transform") this.mbOpenStrip("transform");
    } else if (this.mbStrip === "transform") this.mbCloseOverlays();
    if (this.mbStrip === "warp") this.mbRenderStrip();
  }
  protected override muteFloatingOverlays(on: boolean): void {
    // 変形の間は、パネルと太さを薄くする（ツールの帯は決めるボタンがあるので薄くしない）
    this.mbRoot?.classList.toggle("mb-muted", on);
  }
  protected override xformCursorReset(): void {
    // 何もしない（カーソルが無い）
  }
  protected override xformDragCursor(_cursor: string): void {
    // 何もしない（カーソルが無い）
  }
  protected override xformDragEnded(_pt: { x: number; y: number }): void {
    // 何もしない（カーソルが無い）
  }
  protected override updateLayerClipButtons(): void {
    if (this.mbPanel === "layer") this.mbRenderPanel();
  }
  protected override updatePasteButton(): void {
    if (this.mbStrip === "select") this.mbRenderStrip();
    // ★V223 (F-5): 島の［はりつけ］は、写したコマが無ければ押せない
    if (this.mbIsland) this.mbRenderIslandHead();
  }
  protected override syncPasteRangeLabel(): void {
    // ★V223 (F-6): レイヤーのメニューを出していれば、貼り付けの札の字を今の範囲で直す
    if (this.mbPanel === "layer" && this.mbLayerMenuId && !this.mbEl.panel.hidden) this.mbLayerMenu(this.mbLayerMenuId);
  }
  protected override revealLayerClip(): void {
    if (this.mbPanel === "layer") this.mbRenderPanel();
  }
  /** 文字の帯の入力欄にフォーカスする（キーボードが出ても隠れない＝L6） */
  protected override focusTextInput(): void {
    if (this.mbStrip !== "text") this.mbOpenStrip("text");
    const el = this.mbEl.textIn as HTMLTextAreaElement | undefined;
    if (!el) return;
    el.value = this.textDraft?.text ?? "";
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }
  protected override flushInputLogSoon(): void {
    // 何もしない（入力の診断ログは PC だけ）
  }
  protected override pointerDownChanged(_down: boolean): void {
    // 何もしない（描いている印は振り分け層の drawingChanged で受ける）
  }
  protected override pointerReleased(): void {
    // 何もしない（ポインタの捕捉を持たない。振り分け層がその接触の残りを捨てる）
  }
  protected override repaintCursor(): void {
    if (this.mbHover) this.mbPaintUi();
  }
  protected override refreshSizePicker(): void {
    const n = this.penSize;
    this.mbRoot?.querySelectorAll(".mb-size").forEach((b) => b.classList.toggle("mb-on", Number((b as HTMLElement).dataset.size) === n));
  }
  protected override undoRedoShown(): void {
    const on = this.xformActive || this.cornerActive;
    this.mbEl.undo?.setAttribute("aria-disabled", on ? "false" : this.history.canUndo ? "false" : "true");
    this.mbEl.redo?.setAttribute("aria-disabled", on ? "true" : this.history.canRedo ? "false" : "true");
    // 振り分け層の手のひらの取り消し・2 本指のタップの取り消しが、終わるのを待っている
    for (const r of this.mbUndoWaiters.splice(0)) r();
  }
  protected override showWaitBadge(on: boolean): void {
    this.mbRoot?.classList.toggle("mb-waiting", on);
  }
  protected override busyStarted(): void {
    // 重い処理の間は、描く口とボタンに接触を回さない（§5-7）
    this.mbBusy = true;
    this.mbRouter?.interrupt();
    this.mbRoot?.classList.add("mb-busy");
  }
  protected override busyClosing(): void {
    // 何もしない（進み具合の箱は heavyBox が閉じる）
  }
  protected override busyEnded(): void {
    this.mbBusy = false;
    this.mbRoot?.classList.remove("mb-busy");
  }
  protected override playStateShown(playing: boolean): void {
    const b = this.mbEl.play;
    if (!b) return;
    b.replaceChildren(icon(playing ? "pause" : "play", 22));
    b.ariaLabel = playing ? mt("mb.play.stop.title") : t("ed.tl.play.title");
  }
  protected override paintSizeMeter(proj: number, real: number, _t0: number): void {
    // その他のメニューの頭の大きさ（段と知らせはコア）
    this.mbSize = { proj, real };
    if (this.mbMore) this.mbRenderMore();
  }
  protected override savePrepShow(stage: "begin" | "moved" | "pass" | "end" | "save", prog: { n: number; total: number } | null): void {
    // 保存の札の「保存の準備…」と数字
    this.mbSavePrep = stage === "end" || stage === "save" || !prog ? null : `${prog.n}/${prog.total}`;
    this.mbSyncSaveBtn();
  }
  protected override heavyYield(): Promise<void> {
    // 1 拍譲って描かせる（「◯◯しています」の箱を先に見せる）
    return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }
  protected override heavyBox<T>(_op: PerfOp, msg: string, fn: () => Promise<T>, delayMs: number): Promise<T> {
    // 「◯◯しています」の箱（UI §6-12 の形）。短く終わるものは出さない
    const layer = this.mbRoot;
    let box: HTMLElement | null = null;
    const timer = setTimeout(() => {
      if (!layer) return;
      box = h("div", "mb-scrim mb-ui", h("div", "mb-dialog mb-busybox", txt("mb-dialog-title", msg), h("div", "mb-progress", h("span", "mb-progress-bar"))));
      layer.append(box);
      release = holdBackground(box as unknown as InertNode); // ★V227 (X-1): 「◯◯しています」の間も後ろは inert
    }, delayMs);
    let release: () => void = () => undefined;
    return fn().finally(() => {
      clearTimeout(timer);
      box?.remove();
      release();
    });
  }
  /** 編集の印（dirty = true のたび）→ セッションと時計の noteEdit */
  protected override workEdited(): void {
    this.mbHost?.edited();
  }
  /** ★V221b (■3): コアが出すお知らせと確認の文。キーの表記が入る 10 キーだけモバイルの文に替え、ほかはコアの既定（PC の文） */
  protected override coreText(key: string, vars?: Record<string, unknown>): string {
    return mbCoreText(key, vars, (k, v) => super.coreText(k, v));
  }
  /** 変形の取っ手・回転の輪・四隅を掴む当たり（キャンバスのドット）。画面の上で一辺が 44pt（半径 22pt）以上になる値を、いまの倍率から返す
   *  （判定の順と決まりは変えない＝コアの xformHitTest のまま） */
  protected override xformHitSizes(): XformHitSizes {
    return mbHitSizesFor(this.mbView?.scale ?? 3);
  }

  // ---------------- 小さな見せ方 ----------------

  private mbDrawTextDraft(ctx: CanvasRenderingContext2D): void {
    const d = this.textDraft;
    if (!d) return;
    const mask = this.textDraftMask();
    const org = this.textDraftOrigin(d);
    ctx.save();
    ctx.strokeStyle = SKETCH.text;
    ctx.lineWidth = 1;
    if (!mask) {
      const hh = Math.max(2, Math.ceil(d.size * 1.35));
      ctx.beginPath();
      ctx.moveTo(d.x + 0.5, d.y);
      ctx.lineTo(d.x + 0.5, d.y + hh);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const cv = document.createElement("canvas");
    cv.width = mask.w;
    cv.height = mask.h;
    const c2 = cv.getContext("2d")!;
    const img = c2.createImageData(mask.w, mask.h);
    const hex = this.colorHex || SKETCH.textClear;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    for (let i = 0; i < mask.w * mask.h; i++) {
      if (!mask.data[i]) continue;
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    c2.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cv, org.x, org.y);
    ctx.strokeRect(org.x - 0.5, org.y - 0.5, mask.w + 1, mask.h + 1);
    ctx.restore();
  }

  /** 保存の札（保存中は回る印と「保存中」・準備の数字） */
  mbSyncSaveBtn(): void {
    const b = this.mbEl.save;
    if (!b) return;
    const saving = this.mbHost?.saving() ?? false;
    b.classList.toggle("mb-saving", saving);
    const name = b.querySelector(".mb-save-name");
    if (name) name.textContent = saving ? (this.mbSavePrep ? `${mt("mb.save.saving.label")} ${this.mbSavePrep}` : mt("mb.save.saving.label")) : t("common.save.btn");
  }

  /** 速さの表示（その他のメニュー） */
  mbFps(): number {
    return FPS_TABLE[this.project.speedIndex] ?? 8;
  }
}

/** ★当たりの大きさ（v221 [H] が倍率ごとに 44pt を下回らないかを見る）。コアの値はキャンバスのドット: hit＝取っ手の半径・ring＝回転の輪の幅・
 *  corner＝四隅の半径。画面の上で一辺 44pt（半径 22pt）＝ドットでは 22 ÷ 倍率。PC の値（6・12・8）より小さくはしない */
export function mbHitSizesFor(scale: number): XformHitSizes {
  const r = HIT_PT / 2 / Math.max(0.01, scale);
  return { hit: Math.max(6, r), ring: Math.max(12, r * 2), corner: Math.max(8, r) };
}
