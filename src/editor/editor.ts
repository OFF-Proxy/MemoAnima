// メモアニマ (MemoAnima) エディタ（M3）コントローラ
// - キャンバスは 320×240 の canvas を CSS 整数倍＋image-rendering:pixelated で表示（ドット等倍）
// - 全ツールの結果は 320×240 格子に確定（SPEC §4）
// - レイヤー無制限・色両対応（パレット/フルカラー）・描き味トグル（OFFで3DS準拠）

import {
  Project,
  LayerFolder,
  W,
  H,
  PIXELS,
  FPS_TABLE,
  PenTexture,
  UGO_COLORS,
  UGO3D_BLUE,
  clipBaseMap,
  effectiveLayerStates,
  ancestorLocked,
  loadWallFaces,
} from "./model";
import { compositeFrame, presentToCanvas, frameToPngBlob, } from "./render";
import { PlayClock, type PlayHost, type PlayPaused, type BgmPlan } from "./playClock"; // ★V209 (A-121)
// V195 (A-98): 拡大したとき隅を窓の真ん中まで（余白の形と、倍率を変えても真ん中の点を残す計算）
import { panLayout, anchorAt, scrollFor, fitZoom, panNeeded, type PanGeom } from "./stagePan";
// V192 (A-93): コマ一覧・小さいプレビュー・音の窓のプレビューは「実際の画素」で出す（縮めるときは面積平均・広げるときは整数倍）
import { presentFit, fitFor, fitKey, watchFit, rgbaOf, releaseCanvas, type DisplayFit } from "./scaledView";
// V164: 設定・入力の丸め（純関数だけの一枚。Node から import できる＝スモークが見張る）
import {
  ADD_FRAMES_MAX,
} from "./prefs";
// M10-2a: 変位マップエンジン（歪み3方式と M10-3 のゆらゆらが共有する適用側）
import { WarpField, } from "./warp";
import { type WobbleKind, type WobbleStrength, } from "./wobble";
// V204 (A-111): 見本は 1 枚ずつ作る・シードの式は見本と［つくる］で 1 つ
import { buildWobbleFrame, WOBBLE_STRENGTH_MIN, WOBBLE_STRENGTH_MAX, WOBBLE_STRENGTH_DEFAULT } from "./wobble";
// M12-C: カーソルの純関数（DOM に触らない側）は cursor.ts に分けてある
import {
  type CursorSettings,
  CURSOR_DEFAULTS,
  sanitizeCursor,
  cursorFor,
  cursorLayerHidden,
  hasRing,
  cursorFrameOps, // ★V209 (A-122): 塗られるドットの外側の黒白 2 本線の枠（全レイヤー消しゴムの二重線も）
  frameLineWidth,
  paintedSize,
  antColor,
  canvasCursorFor,
  panCursorFor,
} from "./cursor";
import * as R from "./raster";
// V208 (A-119): 範囲選択の境目の線（純関数）と、押してほとんど動かさずに離したかの判定
import { selectionOutline, type SelOutline } from "./selOutline";
// M17: マイ柄（カスタムトーン）。登録・解決・塗り込みの純関数はここ（settings にだけ保存・保存形式には触れない）
import * as CT from "./customTone";
// V156 (P-1): 見えていないコマを圧縮して眠らせる（仕組みの全文は sleep.ts の冒頭）
import {
  wakeFrame,
  sleepFrame,
  frameHasAsleep,
} from "./sleep";
// V199 (A-106): 作品の名前の正はファイル名（左上・書き出しの既定の名前・保存のときの meta.title）
import { savedFileBase, baseFromSavedPath, displayTitle, exportBaseName } from "./workTitle";
// V201 (M-1a): 保存とオートセーブの手順は共通の部品（画面と Tauri に触らない・モバイルも同じものを通る）
import { saveWork, autosaveWork, encodeViaWorker, bindNewWorkId, type SaveKind } from "./saveCore";
// V199 (A-105): レイヤー（フォルダ）のコピー・貼り付けの決まり（純関数・何を／どこへを決めて書くだけ）
import {
  pasteRange,
} from "./layerClip";
import { FrameSource, projectSource, ExportAudioSource, formatSize } from "./exporter";
import {
  decodeAudio,
  getAudioCtx,
  ensureAudioRunning, // V172 (G-2)
  type AudioPick,
  bgmPlaybackRate,
  renderExportMix,
} from "./audio";
import type { BgmTrack, SeTrack, } from "./model";
import { sanitizeAudio } from "./model";
import { createSlider, SliderHandle } from "../ui/slider";
import { t } from "../i18n";
// V171: 線画アイコン（絵文字は OS で絵が変わるので、インライン SVG・currentColor に）
import { icon, iconHtml, iconLabelHtml, setIconLabel, type IconId } from "../icons";
import { errText } from "../ui/errText";
// V158 (C-2): canvas に描く UI の色は**配色から読む**（各所が色を持たない）
import { uiColor, uiColorA } from "../ui/theme";
// V159 (G-1): 性能ログ。**操作名は列挙されたものだけ**（作品名は書けない作り）
import { perfNow, perfDone, type PerfOp } from "../perf";
// V166 (層1): 重い操作の漏斗が使う共通の表示（ライブラリ・ホームと**同じ1つの実装**）
import { runWithBusy, yieldToPaint } from "../ui/busy"; // V155 (A-33): 画面に `Error:` を出さない
// M12-1c-2: アプリが自動で付ける名前は defaults.ts が唯一の出どころ（literal の二重持ちを解消）
import { untitledTitle } from "../i18n/defaults";
import {
  topNodesOf,
  ancestorChain,
  // V208 (A-120): 一覧の並び（空のフォルダは親の中の一番下）と、ドラッグの入る先（上下の位置だけ）・端で流す量
  layerDisplayRows,
  dropTargetAt,
  dragScrollStep,
  type RowDropHit,
  type RowDropPlan,
} from "./layerTree";
// M11-10: ショートカット（キー → コマンドID → 実行）。定義とプリセットは src/keymap.ts に集約
import {
  COMMANDS,
  buildLookup,
  eventKey,
  pointerEventKey,
  // V165 (D-4): 修飾キーの単体タップ（条件としきい値は keymap.ts の1か所）
  ModTapWatcher,
  tapEventKey,
  isHoldOnlyCommand,
  // V167 (K-3): 「Alt＋クリックで色を拾いました」の『Alt＋クリック』を作る
  keyLabel,
  bindingFromPointer,
  type CommandId,
  type Preset,
} from "../keymap";
// V181 (A-25): 「Ctrl か（Mac なら ⌘ も）」。`ctrlKey` を直に読まずにこれを通す（v181_smoke [S-5] が数える）。
//  isMacPlatform は押しっぱなしのくり返しを Mac でだけ止めるため（swallowRepeatOnMac）
import { isMacPlatform, primaryMod } from "../platform";
// M10-1c: 書体テーブル・明示ロード・サイズ選択の規則は fonts.ts に集約
import {
  FONTS,
  fontDef,
  type FontKey,
} from "./fonts";
// ★V213 (M-2a): 描く操作はコア（src/editor/core/editorCore.ts）。この Editor はそれを受け継ぎ、画面と入力の皮だけを持つ
import { EditorCore, type CoreCallbacks, yieldToInput, type Tool, type StrokeSample, type XformHitSizes, PEN_SIZES } from "./core/editorCore";
export type { TextSettings } from "./core/editorCore";

// M14 (S-1): ツール形式ストリップとサイドパネルが**同じ定義から**ボタン群を作るための単一ソース。
// active は組み立て時のスナップショット（形式が変わるたび buildToolOptions/ストリップを組み直す）。
interface FormatItem {
  id: string;
  /** 文字ラベルの i18n キー（variant="oni"）。既存キーを再利用する */
  labelKey?: string;
  /** V171: ラベルの先頭に置く線画アイコン（絵文字は i18n から剥がし、呼び出し側がここで指定する） */
  icon?: IconId;
  titleKey?: string;
  active: boolean;
  disabled?: boolean;
  /** variant="sizes" のドット丸など、ボタンの中身を自前で作るとき */
  makeInner?: (btn: HTMLButtonElement) => void;
  /** 押されたときの状態変更（呼び出し側で afterFormatChange 相当まで面倒を見る） */
  select: () => void;
}
interface FormatGroup {
  key: string;
  /** 行の見出し（例: 参照）。省略時は見出しなしの .oni 1本 */
  labelKey?: string;
  variant: "oni" | "sizes";
  items: FormatItem[];
  /** false のとき出さない（例: 範囲選択の参照は「✨自動」のときだけ） */
  visible?: boolean;
  /** パネル側だけ N 個ずつ改行する（歪みの4形式は幅が足りず2行）。ストリップは常に1行 */
  panelChunk?: number;
}

// M10-3: ゆらゆら差分。種類と強さ（V204 で 1〜10）— M11-20 で純関数部分を wobble.ts へ切り出し。
// main.ts（`?wobble` 診断）が editor から WOBBLE_TABLE を import しているので再エクスポートを残す（V204 も形は今のまま）
export type { WobbleKind, WobbleStrength } from "./wobble";
export { WOBBLE_TABLE } from "./wobble";

/** M10-2c: 四隅モード中だけ無効化する浮遊UI。×2 ズームでキャンバスの右上・右下の
 *  ハンドルに重なっていて、そのままでは4つ中2つが物理的に掴めない（実機で確認）。 */
const MUTED_OVERLAY_SELECTORS = [".cvright", "#ed-mini"];
/** 無効化中の不透明度。**設定側と比較側で必ずこの定数を使う**。
 *  `".4"` と書いて `"0.4"` で比べる形だと、CSSOM の正規化に依存して静かに壊れる。 */
const MUTED_OPACITY = "0.4";

// M14 (S-1): ツールボタンにポインタが乗ってからストリップを出すまでの遅延（暴発防止）。実機で調整
const STRIP_HOVER_MS = 150;
// M14 (S-1): ボタンから離れてからストリップを畳むまでの猶予（ボタン→ストリップへ渡る間の隙間で消えないように）
const STRIP_CLOSE_MS = 140;
// M17: マイ柄チップのプレビュー（32×32 バッキング→CSS ×2・透明は 4px 市松）。実機判断で調整する定数
const CUSTOM_CHIP_PX = 32;
const CUSTOM_CHIP_CHECKER = 4;
// M5-4 B-3: ペンは「ベタ＋スプレー系」のみに整理。
// 旧 dot(点線)・halftone(網点=ブラシのトーンへ)は撤去、rough(かすれ)は sand（スプレー粗）へ集約・廃止。
// 既存作品の画素は不変（ツール状態は保存対象外・UIのみの整理）。
/**
 * M12-1b-2: `innerHTML` のテンプレートへ**ユーザーのデータ**（レイヤー名・音声ファイル名）を差すときだけ通す。
 * `textContent` / `title` / `placeholder` へ入れるときは**通さない**（通すと `&lt;` が文字として見える）。
 * 属性値そのものはテンプレートに埋めない（R-2 案1＝組んだあとに `el.title = t(...)`）。
 */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// M12-1b: 表示名は i18n のキーで持つ（値は ja.ts。t() は使う直前に呼ぶ＝言語切替に追従する）
// **動的キーの規約**: 変数で引くキーは `*Key: "…"` という名前のプロパティで持つ（検査4 がこの形を見る）
// V171: 絵文字（━ ░ ▒）→ 線画アイコンの id（質感の見本として線画で描いてある）
const TEXTURES: { key: PenTexture; labelKey: string; icon: IconId }[] = [
  { key: "solid", labelKey: "ed.pen.tex.solid.title", icon: "tex-solid" },
  { key: "spray", labelKey: "ed.pen.tex.spray.title", icon: "tex-spray" },
  { key: "sand", labelKey: "ed.pen.tex.sand.title", icon: "tex-sand" },
];

/** ★V216b (A-126・要件 docs/REQ_prerelease_fixes_v2_0_0.md §2-1): **その作品のファイル**（1 つのパス）。
 *  ライブラリで開いた `.memoanima`・保存に成功したら Rust が返したパス。ほか（.kwz／.ppm／.animemo・新規メモ・ドロップ）は持たない（null）。
 *  保存先がこのファイルなら確かめずに上書きし、ほかの在る名前へは確かめてから書く（比べるのは Rust）。
 *  `size`・`mtimeUs` は開いた・書いた時点のそのファイルの大きさと更新時刻（オートセーブの印に控え、戻すときに比べる・分からなければ null） */
export interface WorkFileRef {
  path: string;
  size: number | null;
  mtimeUs: number | null;
}

/** V216b: 保存先の名前の空き（Rust の `save_target_status`）。own＝その作品のファイル／taken＝在る／reserved＝控え・.gz だけ／free＝空き */
export type SaveTargetStatus = "own" | "taken" | "reserved" | "free";

/** V216b: Rust が書く所で「在る」と断った文から種類を取り出す（`pclib::SAVE_EXISTS_TAKEN`／`SAVE_EXISTS_RESERVED`）。違う失敗は null */
export function saveExistsKind(e: unknown): "taken" | "reserved" | null {
  const m = /save-exists:(taken|reserved)/.exec(String(e));
  return m ? (m[1] as "taken" | "reserved") : null;
}

export interface EditorSaveContext {
  libRoot: string;
  album: string;
  /** 拡張子なしのファイル名ベース */
  baseName: string;
  // ★V197 (A-103・作者決定 2026-10-07): V163 の `legacy`（旧形式 PV5 でこの保存先に書く）はなくした。
  //  保存は**いつも PV6**（runBackgroundSave）。旧形式（PV1〜PV5）の作品を開くのは今までどおり
}

/** M11-17: パネル寸法（px）。settings.json の `layout` に保存する3つの数値 */
export interface EditorLayout {
  /** 左ツール列の幅 */
  toolsW: number;
  /** 右パネルの幅 */
  sideW: number;
  /** タイムラインの高さ */
  tlH: number;
  /** V158 (L-1): 右パネルの**上段（道具）が占める割合**（%）。下段（レイヤー）は残り。
   *  他の3つが px なのに対しここだけ % なのは、右パネルの高さが窓の高さで変わるため
   *  ——px で覚えると、小さい窓で開いたときに下段が消える。 */
  sideTop: number;
}
export type LayoutKey = keyof EditorLayout;

/** V158 (L-1): 右パネルの**段ごとの畳み**（true = 畳んでいる＝相手が伸びる）。
 *  両方 true は作らない（畳むときに相手を必ず開く）。settings へ**追加キーのみ**で保存する。
 *  ★V215 (A-124): `col` = 色の段（上段の下端・いつも見える段）の畳み。top・bot の「片方を畳むともう片方は開く」とは
 *  **別に**覚える（道具の段を畳んでも色の段は見えたまま）。前の版の設定（top・bot だけ）では開いている */
export interface SideFold {
  top: boolean;
  bot: boolean;
  col: boolean;
}
export const SIDE_FOLD_DEFAULT: Readonly<SideFold> = { top: false, bot: false, col: false };

/** 壊れた値・両方 true は既定（どちらも開いている）へ倒す。色の段は true のときだけ畳む（壊れた値は開く） */
export function sanitizeSideFold(v: unknown): SideFold {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const top = o.top === true;
  const bot = o.bot === true;
  const col = o.col === true;
  if (top && bot) return { ...SIDE_FOLD_DEFAULT, col };
  return { top, bot, col };
}

/** 既定値＝M11-16 までの固定値（styles.css の `--ed-*` 初期値と一致させる） */
export const LAYOUT_DEFAULT: Readonly<EditorLayout> = {
  toolsW: 88,
  sideW: 268,
  tlH: 148,
  // V158 (L-1): 既定は上6:下4（要件 U-1 の仮置き）。実画面で確かめて、この値のまま出荷する
  sideTop: 60,
};

/** 上下限（px）。根拠は M11_17_report §2:
 *  - toolsW 88..176: 88 はボタン66＋バー8＋padding4＋枠6 の一列ぶん（これ未満はボタンが欠ける）。
 *    176 は二列（66×2＋gap7＋chrome18＝157）が入る幅＋余白。三列は道具列としては広すぎるので許さない
 *  - sideW 220..420: 220 で中身幅 177（一番幅を食うトーン横長スウォッチ 144 が入る）。
 *    420 は 1280 幅でもキャンバスが 2倍表示（640＋40）を保てる上限
 *  - tlH 148..400: 下限は**既定と同じ 148**＝「タイムラインは今より高くはできるが低くはできない」。
 *    見出し1行＋サムネ1段の理論最小は 130.5（見出し 38＋余白 6＋帯の padding 8＋サムネ 58.5＋
 *    カード padding 14＋枠 6）だが、フィルムに横スクロールバー（約 17px）が出るとサムネが帯から
 *    はみ出して縦バーが二重に出る（レビュー指摘）。148 未満で得られるのは十数 px の余白だけなので、
 *    壊れ得る領域ごと切った。見出しが折り返して2行になる幅（1280×800 の既定など）では、
 *    ドラッグ中に実測の見出し高から下限を動的に持ち上げる（clampLayoutLive）。400 は 800 高でも
 *    キャンバスが 1倍表示（240＋40）を保てる上限。ドラッグ中はさらに実寸から動的に狭める（同） */
export const LAYOUT_RANGE: Readonly<Record<LayoutKey, readonly [number, number]>> = {
  toolsW: [88, 176],
  sideW: [220, 420],
  tlH: [148, 400],
  // V158 (L-1): 上段は 25%〜80%。上限 80 は**下段にレイヤー3行を残す**ため
  //（下段の実効最低高は CSS の min-height でも守る＝二重の防御）。
  // 下限 25 は上段に「いま選んでいる道具の形式＋太さ」が入る最小
  sideTop: [25, 80],
};

/** ドラッグ用: 値を静的な上下限へ丸める（整数化）。数でなければ既定 */
export function clampLayoutValue(key: LayoutKey, v: unknown): number {
  const [lo, hi] = LAYOUT_RANGE[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return LAYOUT_DEFAULT[key];
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** 復元用: 数でない・範囲外は**既定へ倒す**（REQ §1「壊れた値や範囲外は既定へ」。丸めて採用はしない） */
export function sanitizeLayoutValue(key: LayoutKey, v: unknown): number {
  const [lo, hi] = LAYOUT_RANGE[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return LAYOUT_DEFAULT[key];
  const r = Math.round(v);
  return r < lo || r > hi ? LAYOUT_DEFAULT[key] : r;
}

/** M11-18: ミニプレビューの置き場。"timeline"=タイムライン左端に収納（既定）／"float"=従来のフロート
 *  M11-21: "off"=表示しない（DOM 非表示・合成もしない・slot ごと消える・大画面切替の入口も無し）。
 *  未知の値・壊れた値は既定（収納）へ */
export type MiniDock = "timeline" | "float" | "off";
export function sanitizeMiniDock(v: unknown): MiniDock {
  return v === "float" || v === "off" ? v : "timeline";
}

/** M11-18: 個別の畳み状態（settings.collapsed に保存）。true 以外はすべて「開いている」 */
export interface CollapsedState {
  tools: boolean;
  side: boolean;
  tl: boolean;
}
export type CollapseKey = keyof CollapsedState;
export function sanitizeCollapsed(v: unknown): CollapsedState {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { tools: o.tools === true, side: o.side === true, tl: o.tl === true };
}
/** 畳んだパネル（つまみ）の幅/高さ（px）。カード枠 3×2＋縦書き 11px 文字が入る最小 */
export const COLLAPSED_PX = 22;

/** settings.json の値（何が入っていても）→ 正常な EditorLayout。項目ごとに独立して既定へ倒す */
export function sanitizeLayout(v: unknown): EditorLayout {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    toolsW: sanitizeLayoutValue("toolsW", o.toolsW),
    sideW: sanitizeLayoutValue("sideW", o.sideW),
    tlH: sanitizeLayoutValue("tlH", o.tlH),
    sideTop: sanitizeLayoutValue("sideTop", o.sideTop),
  };
}

export interface EditorCallbacks extends CoreCallbacks {
  onExit: () => void;
  onSaved: (path: string) => void;
  /** M8-2: 📷 画像をこのページに配置（変換モーダルは main.ts 側・共用） */
  importImage?: () => void;
  /** M11-13: ミニプレビューを隠す/出すが変わったら settings.json へ保存する
   *  （文字設定と同じ「変えた瞬間に保存」の流儀） */
  onHudHiddenChange?: (hidden: boolean) => void;
  /** M11-17: スプリッターで幅/高さを変えたら settings.json へ保存する（ドラッグ確定・既定復帰の瞬間だけ。
   *  ドラッグ中は呼ばない）。渡す値は clamp 済み */
  onLayoutChange?: (layout: EditorLayout) => void;
  /** M11-18: 個別の畳み状態が変わったら settings.json へ保存する（つまみ・畳むボタンの瞬間だけ。
   *  集中トグルは一時的な見方なので呼ばない） */
  onCollapsedChange?: (collapsed: CollapsedState) => void;
  /** V158 (L-1): 右パネルの段ごとの畳みが変わったら settings.json へ保存する（同じ流儀） */
  onSideFoldChange?: (fold: SideFold) => void;
  /** M14 (S-3): 右パネルの「種類/トーン」一覧の開閉が変わったら settings.json へ保存する（同じ流儀） */
  onToneOpenChange?: (open: boolean) => void;
  /** ライブラリ保存（Rust呼び出し）を委譲 */
  // V163: V161-B の Rust 側 gzip（gzBegin/gzChunk/gzAbort/saveProjectGz）は撤去した。
  // PV6 は Worker が完成品（68.7MB 級）を返すので、従来の saveProject（1回の raw ボディ）で足りる
  saveProject: (
    ctx: EditorSaveContext,
    data: Uint8Array,
    thumbPng: Uint8Array,
    /** V216b (A-126): その作品のファイル（null＝無い）と、［置き換える］を選んだか（確かめた宛先とその 1 回だけ）。
     *  在る名前で置き換えてよくなければ Rust が `save-exists:taken|reserved` で断る（`saveExistsKind`） */
    guard?: { workFile: string | null; replace: boolean }
  ) => Promise<string>;
  /** V216b (A-126): 書く前に引く保存先の名前の空き（無い・失敗は「分からない」＝書く所の Rust の断りに任せる） */
  saveTargetStatus?: (ctx: EditorSaveContext, workFile: string | null) => Promise<SaveTargetStatus>;
  /** V216b (A-126): その作品のファイルの大きさと更新時刻（オートセーブの印・分からなければ null） */
  workFileStamp?: (path: string) => Promise<{ size: number; mtimeUs: number } | null>;
  /** F-4: 保存先ピッカー（既存アルバム一覧＋新規作成＋ファイル名）。
   *  V197 (A-103): V163 の形式の選択（旧形式チェック）はなくした＝選ぶのは保存先だけ */
  pickSaveTarget: (
    /** M12-D: 入れたいアルバム。**null＝おまかせ**（呼び出し側は既定名の文字列を作らない） */
    album: string | null,
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
  /** V172: ダイアログだけ（読まない）。読みは `readAudioFile`＝呼び出し元の「読み込み中」の中で行う */
  pickAudioFile: () => Promise<AudioPick | null>;
  readAudioFile: (pick: AudioPick) => Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
  prompt: (msg: string, def: string) => Promise<string | null>;
  /** V154 (W-6): 保存したファイルを読み戻す（確定の前に中身を確かめるため）。
   *  未実装なら読み戻しの検査は省く（書く前の検査と Rust 側のバイト照合は効いたまま） */
  readSavedFile?: (path: string) => Promise<Uint8Array | null>;
  /** V154b (W-8): 画面中央に「◯◯中です」を出す。**戻り値を呼ぶと畳む**。
   *  取り込みの進捗（`openImportProgressModal`）と同じ骨格で、数字は出さない。
   *  未実装なら進捗が出ないだけ（W-7 のロックと W-9 の遮断は効いたまま） */
  busy?: (msg: string) => () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

/** M13-2a (A-2): 選択範囲の内側に塗る色（オーバーレイ専用・索引バッファには一切触れない）。
 *  **1箇所の定数**（REQ §6-2）。青にしているのは 3DS の作法に倣ったもので、
 *  既定パレットの青 `[0,56,206]` とは**わざと違う色**（描いた青と見分けがつかなくなるため）。
 *  REQ §8-1: 値は仮。実機で紙色・6色と見分けがつくかを見て決める */
const SEL_MASK_RGBA: readonly [number, number, number, number] = [64, 140, 255, 102]; // rgba(64,140,255,.40)

/** V208 (A-119): 範囲選択の線の白黒。cursor.ts の antColor（カーソルの輪・ドット枠の白黒）と同じ 2 色を使う。
 *  絵の上に重ねるプレビューなので配色に追随させない（V158 C-2 と同じ理由） */
const SEL_UI_INK = antColor(0, 0);
const SEL_UI_PAPER = antColor(4, 0);
/** V208 (A-119): 境目の点線をずらす間隔（ms） */
const SEL_UI_TICK_MS = 110;
/** V208 (A-119): 境目の辺がこれより多いときは点線を止めたままにする（1 回の描き直しを数ミリ秒に収める） */
const SEL_UI_ANIM_MAX_EDGES = 20000;

export class Editor extends EditorCore<EditorCallbacks, HTMLCanvasElement> {
  saveCtx: EditorSaveContext | null = null;
  /** ★V216b (A-126): その作品のファイル（`WorkFileRef`）。替えるのは開いたとき・保存に成功したときだけ（確かめのキャンセルでは替えない） */
  workFile: WorkFileRef | null = null;
  /** V216b: 書く所の確かめで［別の名前で保存］を選んだ＝保存が終わったら保存先を選ぶ画面を開き直す（同じアルバム・その名前から案を作る） */
  private saveRedirect: { album: string; baseName: string } | null = null;
  /** V216b: 保存先を決めている最中（空きを聞いている・確かめを出している） */
  private savePlanning = false;
  /** V216b: 書く所の確かめ（背景の保存の途中）を出している最中。保存を待つ側（waitForSave）が中央の表示を重ねない */
  private saveAsking = false;
  /** ★V199 (A-106): いま開いているファイルの名前（拡張子なし）。**作品の名前の正**（要件 docs/REQ_title_filename.md）。
   *  null＝まだファイルが無い（保存していない新しいメモ）。左上・書き出しの既定の名前・別名で保存の既定の名前はここから作る
   *  （前は作ったときに入れた `meta.title` をそのまま出していて、名前を変えても最初の名前のままだった）。
   *  決めるのは mount（開いたファイル）と保存の成功（書いたファイル）の 2 か所だけ */
  fileBase: string | null = null;
  private inputLogTimer: number | null = null;
  /** M13-2a (A-2): 選択範囲の内側に色を付けて見せるか（settings.json へ永続化）。
   *  V208 (A-119): 既定は**オフ**（作者の決定 2026-10-24。押してオンにした人＝true が保存されている人はオンのまま） */
  selMaskShow = false;
  /** M14 (S-3): 右パネルの「種類/トーン」一覧を開いているか（既定=閉・settings.json へ永続化） */
  private toneOpen = false;
  /** M14 (S-1): 形式ストリップ（ツールボタン横の一時オーバーレイ）の状態 */
  private stripEl: HTMLElement | null = null;
  private stripOpenFor: Tool | null = null;
  private stripAnchor: HTMLElement | null = null;
  private stripOpenTimer: number | null = null;
  private stripCloseTimer: number | null = null;
  /** M12-C: カーソルの設定（`settings.cursor` を正規化したもの）。 */
  private cursorCfg: CursorSettings = CURSOR_DEFAULTS;
  /** M12-C: 2階（輪・ドット枠）のどちらかが ON か。**false のときホバーは従来どおり素通り**。
   *  `onPointerMove` の判定を1つの真偽値で済ませるために持つ */
  private cursorLive = CURSOR_DEFAULTS.ring || CURSOR_DEFAULTS.cell;
  /** M12-C: 最後に見たドット位置（同じなら描き直さない） */
  private cursorDot: { x: number; y: number } | null = null;
  /** M12-C: 予約中の rAF（1フレーム1回に間引く） */
  private cursorRaf: number | null = null;
  /** M12-C: いま描いてある内容の指紋（位置・太さ・寸法。同じなら clearRect すらしない） */
  private cursorPainted = "";
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
  /** V195 (A-98): パン（全体表示でないとき）で最後に置いた形。null＝パンしていない（全体表示・大画面）。
   *  窓の真ん中の点はこれとスクロール位置から出す（`stagePan.ts` の `anchorAt`） */
  private panGeom: PanGeom | null = null;
  /** V195 (A-98): 大画面（swapped）のあいだ控えておく「入る前に窓の真ん中に見えていた点」 */
  private panHeld: { x: number; y: number } | null = null;
  /** M11-16: HUD（ミニプレビュー・左下バッジ・倍率表示）をまとめて隠しているか。
   *  V195 (A-98b): 右上のボタン列（`.cvright`）も畳む（隠す／出すのボタン 1 つだけ残す・クラス `hud-collapsed`）。
   *  M11-13 の miniHidden（ミニ単独）を置き換え・統合。**設定 `hudHidden` に保存**して次回も維持
   *（既定は表示＝従来どおり）。四隅変形の `muteFloatingOverlays()` とは別物で、
   *  あちらは opacity/pointer-events を一時的に触るだけ・こちらは hidden 属性なので衝突しない */
  hudHidden = false;
  /** M11-16: ストローク中（pointerdown〜up）の自動非表示が立っているか。設定には保存しない */
  private hudStroke = false;
  /** ストローク終了 → HUD を戻すまでの遅延タイマー（連続ストロークの点滅防止） */
  private hudRestoreTimer: number | null = null;
  /** HUD を戻すまでの遅延（ms）。次のストロークがこの間に始まれば消えたまま */
  private static readonly HUD_RESTORE_MS = 350;

  /** M11-17: パネル寸法（設定 `layout` に保存・セッションを跨いで持ち越す）。DOM への反映は applyLayout() 1つ */
  layout: EditorLayout = { ...LAYOUT_DEFAULT };
  /** M11-18: ミニプレビューの置き場（設定 `miniDock`）。反映は applyHud() */
  miniDock: MiniDock = "timeline";
  /** M11-18: 個別の畳み状態（設定 `collapsed`・持ち越す）。反映は applyLayout() */
  collapsed: CollapsedState = { tools: false, side: false, tl: false };
  /** M11-18: キャンバス集中（3パネル一括畳み）。**保存しない**（mount でリセット・previewLarge と同じ扱い）。
   *  発動時に個別状態を focusSnap に控え、解除で戻す。集中中につまみで個別に開いたら focusSnap は捨てて
   *  「現状」を個別状態の新しい基準にする（2重管理の食い違い防止・REQ §3） */
  private focusActive = false;
  private focusSnap: CollapsedState | null = null;
  /** M11-18: 見出しの子要素の元の並び順（全部）。reflowTlHead はまずこの順に組み直してから測る */
  private tlHeadOrder: HTMLElement[] = [];
  /** M11-18: 見出しの「…」メニューへ送れる要素（元の並び順）。reflowTlHead が後ろから送る */
  private tlHeadItems: HTMLElement[] = [];
  /** M11-18: 直前の applyLayout でタイムラインが畳まれていたか（開いた瞬間に収納ミニを描き直すため） */
  private tlWasCollapsed = false;
  /** 「…」メニューを閉じる関数（開いている間だけ非 null） */
  private tlMoreClose: (() => void) | null = null;
  /** M11-17: 進行中のスプリッタードラッグ。frameDrag と同じ「window リスナー＋mine() で id を絞る」作法。
   *  終わり方は finishSplitDrag() 1経路（pointerup / pointercancel / blur / unmount / Esc）＝掴んだまま残らない */
  private splitDrag: {
    key: LayoutKey;
    el: HTMLElement;
    pointerId: number;
    startX: number;
    startY: number;
    startVal: number;
    onMove: (e: PointerEvent) => void;
    onUp: (e: PointerEvent) => void;
    onBlur: () => void;
  } | null = null;
  private autosaveTimer: number | null = null;
  /** 保存/破棄でインクリメント。古い世代のオートセーブ書き込みを無効化する */
  private autosaveEpoch = 0;
  private autosaveInFlight: Promise<void> | null = null;
  /** V154 (W-5): 書き出し中か。true のあいだオートセーブは見送る（`autosavePending` は残す） */
  private exporting = false;
  /** 進捗を畳む手（`cb.busy` の戻り値）。出していなければ null */
  private busyHide: (() => void) | null = null;
  /** 進捗を出すまでの遅延タイマー（0＝予約なし） */
  private busyTimer = 0;
  /** 進捗を出すまでの待ち時間。**一瞬で終わる保存でチラつかせない**ための遅延。
   *  50コマの保存は実測 0.4 秒台なので、ここを超えるものだけ「待つ画面」を出す */
  private static readonly BUSY_DELAY_MS = 450;
  /** 保存時に必ず保存先ピッカーを出すか（新規メモ・取り込んだ 3DS 作品・保存先未定） */
  askSaveTarget = false;

  // ---------------- V161 (A): 背景保存 ----------------
  /** 飛行中の背景保存（null=保存していない）。**編集ロックはしない**（W-9 は保存では外した）。
   *  閉じる・別メモ・書き出しは `waitForSave()` でこれの完了を待つ。 */
  private saveInFlight: Promise<boolean> | null = null;
  /** V154b (W-7) の進化: 飛行中に来た保存要求を**1件だけ**予約（連打しても1件）。 */
  private saveQueued = false;
  /** エンコードと圧縮を追い出す先（遅延生成・unmount で破棄）。 */
  private saveWorker: Worker | null = null;
  /** Worker への往復に付ける連番（古い保存の返事を新しい保存が拾わないため）。 */
  private saveSeq = 0;
  /** 右下の保存ピルを出すまでの遅延タイマー（0=予約なし）。一瞬で終わる保存でチラつかせない。 */
  private savePillTimer = 0;
  /** V168 (S-2): 保存の段階。"prepare"＝写す前の掃除待ち／"save"＝写し以降。
   *  **ピルと中央表示の文言はこれ1つから作る**（`savePhaseText`・文言の源は1つ）。 */
  private savePhase: "" | "prepare" | "save" = "";
  /** V168 (S-2): 掃除待ちの進み（片づいたコマ数／全コマ数）。表示にだけ使う。 */
  private savePrep = { n: 0, total: 0 };

  /** V178: 描きながら押さえて使うキー（`KeyboardEvent.key`）。これらが来ても全レイヤーの束は終えない
   *  （Shift・Ctrl・Alt は修飾・単体タップの割り当て、Space は手のひら。どれも作品を変えない） */
  private static readonly HELD_WHILE_DRAWING = new Set(["Shift", "Control", "Alt", "Meta", " "]);

  /** V156: コマの準備待ちの札。出しっぱなしにならないよう、隠すのは必ず同じ1か所を通す。 */
  protected override showWaitBadge(on: boolean): void {
    const el = document.querySelector("#ed-wait-badge") as HTMLElement | null;
    if (el) el.hidden = !on;
  }
  /** M11-5: いま #ed-cvwrap が掴んでいるポインタ。pointerup/pointercancel が届かないまま
   *  終わった接触を後から解放するために覚えておく（掴みっぱなしだと、その入力機器の
   *  イベントが全部キャンバスへ配送され続け、ボタン類が押せなくなる） */
  private capturedPointerId: number | null = null;
  /** M11-5: 直近のポインタイベント。接触が途切れたとき、この位置でストロークを閉じる */
  private lastPointerEvent: PointerEvent | null = null;
  /** 四隅モード中だけ pointer-events を切った浮遊UIと、その元の値 */
  private cornerMuted: { el: HTMLElement; prevPe: string; prevOp: string }[] = [];
  /** M10-3: エディタ内の自前ダイアログの開いている数。>0 の間はショートカットを通さない */
  private modalDepth = 0;
  /** M10-4 P-1-3: ゆらゆらダイアログの閉じ手（`audioPanelClose` と同じ流儀）。
   *  開いたまま unmount されると modalDepth が 1 のまま残り、再 mount 後に
   *  ショートカットが全滅する。**modalDepth を直接 0 にはしない**（片付け漏れが隠れる） */
  private wobbleDialogClose: (() => void) | null = null;
  /** V204 (A-111・REQ §2-2): ゆらゆらのダイアログの前の値。**アプリを閉じるまで覚える**（static＝作品を開き直しても残る・保存しない） */
  private static wobbleLast: { count: number; strength: WobbleStrength; kind: WobbleKind; target: "all" | "active" } = {
    count: 3,
    strength: WOBBLE_STRENGTH_DEFAULT,
    kind: "line",
    target: "all",
  };
  /** V204 (A-111・B-6): いま見本に出している絵（検査の入口）。frames[0] は元のコマ、1〜 が差分（どれも 320×240 の合成＝
   *  compositeFrame と同じ・拡大した canvas の画素ではない）。ダイアログを閉じたら null */
  private wobblePreview: {
    count: number;
    strength: WobbleStrength;
    kind: WobbleKind;
    target: "all" | "active";
    seed: number;
    fps: number;
    frames: Uint32Array[];
    ms: number;
  } | null = null;
  /** V164 (U-4): 「まとめて追加」ダイアログの閉じ手（`wobbleDialogClose` と同じ理由・同じ流儀） */
  private addFramesDialogClose: (() => void) | null = null;
  // ---------------- V208 (A-119): 範囲選択の線の層（#ed-sel-ui・画面解像度） ----------------
  /** 境目の線を作ったマスクの実体（替わったときだけ作り直す） */
  private selUiSrc: Uint8Array | null = null;
  private selUiOutline: SelOutline | null = null;
  /** 境目の線の Path2D（物理 px）と、作ったときの寸法・ずらし */
  private selUiPath: Path2D | null = null;
  private selUiPathKey = "";
  /** 辺が多すぎて点線を止めているときの、境目の線を描いた絵の控え（1 枚だけ）と、その寸法・位相 */
  private selUiCache: HTMLCanvasElement | null = null;
  private selUiCacheKey = "";
  /** 点線をずらすタイマー（動いていなければ null）と、点線の位相 */
  private selUiTimer: number | null = null;
  private selUiPhase = 0;
  /** 今その間は線を出さない場面（矩形選択のドラッグ中・移動ツールで範囲の絵を動かしている間） */
  private selUiHideFor: "rect" | "selmove" | null = null;

  // ================= V166 (C): Alt でカーソルが止まる件 =================
  //
  // ★症状（作者・液タブ／Alt に「元に戻す」を割り当てている）
  //   描いている最中に Alt を押すと**カーソルが止まり、もう一度 Alt を押すまで戻らない**。
  //
  // ★候補は2つあり、**どちらかはログでしか決まらない**（要件 C: 推測で直さない）
  //   候補1: **keyup が届いていない**。Windows は Alt 単独押しで「メニュー操作モード」に入る。
  //          このとき窓はフォーカスを失い、以後のキー・ポインタがアプリに来ない
  //          （＝もう一度 Alt を押すと抜ける＝症状の「Alt を押すまで戻らない」と一致する）
  //   候補2: **タブレットのドライバが Alt を掴んだまま**にしている（押しっぱなし扱い）
  //
  // ★見分け方（この回で足した計測）
  //   候補1なら `keydown key=Alt` の**直後に `win:blur`** が出て、`altD`（押した数）が
  //   `altU`（離した数）より多いまま止まる。
  //   候補2なら blur は出ず、**ポインタの行が `alt=1` を出し続ける**（アプリは離したと思っているのに
  //   イベントは押されていると言う／またはその逆）。`alt=` と `altD/altU` を並べたのはこのため。
  //
  // ★直し方は**どちらでも安全な形**にしてある（原因が確定する前に壊さない）
  //   - イベントが `altKey` について言うことを**真実として採る**（覚えている状態が食い違ったら直す）。
  //     前例: `onPointerDownInner` の `this.shiftHeld = e.shiftKey;`（M10-7）と同じ作法
  //   - フォーカスを失ったら修飾キーの状態も落とす（`blurHandler`）
  //   - ★`preventDefault` は**足していない**。Alt を止めると Alt＋クリックのスポイト（M16 K-4）と
  //     OS 側の挙動に手が入る＝壊すなリストに触れる。原因が候補1と確定したときに、
  //     **そのとき初めて**「Alt 単独の keydown だけ止める」を検討する

  /** V166 (C): アプリが覚えている Alt の状態。**イベントと食い違ったらイベントに合わせる**。 */
  private altHeld = false;
  /** V166 (C): Alt の押した数／離した数。**釣り合わなければ keyup が来ていない**（候補1）。 */
  private altDownCount = 0;
  private altUpCount = 0;
  /** V166 (C): 食い違いを直した回数（通常ログへ出すのは最初の1回だけ＝ログを埋めない）。 */
  private altFixCount = 0;

  /** V166 (C): イベントが言う `altKey` に合わせる。**食い違ったときだけ**記録する。
   *  `where` は "pointerdown" 等の**決められた語**（W-10: 作品名・パスは書かない）。 */
  private syncAltFromEvent(altKey: boolean, where: string): void {
    if (this.altHeld === altKey) return;
    this.altHeld = altKey;
    this.altFixCount++;
    // ★通常のログに出す。要件 C の「普通のログには何も出ない」を埋めるため——
    //  `?inputlog` を立てて再現してもらう前に、**送られてくるログだけで**兆候が分かるようにする。
    //  最初の1回だけ（連発してログを埋めない）
    if (this.altFixCount === 1) {
      this.cb.appendLog?.(
        `[V166 C] alt mismatch fixed at=${where} now=${altKey ? 1 : 0} ` +
          `down=${this.altDownCount} up=${this.altUpCount}`
      );
    }
  }

  private keydownHandler = (e: KeyboardEvent) => {
    // V166 (C): Alt の押し・離しを数える（釣り合いが崩れたら keyup が届いていない＝候補1）
    if (e.key === "Alt") {
      if (!e.repeat) this.altDownCount++;
      this.altHeld = true;
    }
    // M10-7: 図形の Shift 拘束を**マウスを動かさずに**即反映する。
    // 条件を満たさないときは何もしない（preventDefault もしない）ので、
    // 変形の15°スナップ・フィルム/レイヤーの Shift 範囲選択・Ctrl+Shift+C/V には触れない
    if (e.key === "Shift") {
      this.shiftHeld = true;
      this.refreshShapePreview();
    }
    this.trackModTapDown(e); // V165 (D-4)
    this.onKeyDown(e);
  };
  private keyupHandler = (e: KeyboardEvent) => {
    if (e.key === "Alt") {
      this.altUpCount++;
      this.altHeld = false;
    }
    this.handleModTapUp(e); // V165 (D-4): 単体タップの判定は**離したとき**
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
    // ★V165 (D-4): **フォーカスを失ったら単体タップの候補は必ず捨てる。**
    //  Alt+Tab は「Alt を押したまま別の窓へ行き、戻ってきて Alt を離す」＝そのままだと
    //  戻った瞬間に発動してしまう（要件の名指しの事故）。ここで捨てれば keyup は空振りする
    this.modTap.cancel();
    this.spaceHeld = false;
    this.spacePanned = false;
    this.shiftHeld = false;
    // ★V166 (C): 修飾キーの状態も落とす。Alt でメニュー操作モードに入ると（候補1）
    //  keyup は**二度と来ない**ので、ここで落とさないと押しっぱなしのまま残る
    this.altHeld = false;
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
    // ★V214 (M-2b-1a): 確定する中身（矢印の移動・全レイヤーの束）はコアの otherOperationStarted
    this.otherOperationStarted();
  };
  /** M11-8: ステージのスクロール（手のひら・ホイール）にランチャーを追従させる */
  private stageScrollHandler = () => {
    if (this.mounted) this.refreshSelectionLauncher();
    // ★V209 (A-122): スクロール（手のひら・ホイール）で絵が動いたら、枠をポインタの下へ引き直す
    if (this.mounted && this.cursorLive) this.syncCursorFrame();
  };
  /** F-0対策: フィルムサムネは可視分のみ遅延描画（canvasメモリ上限対策）。
   *  V192 (R-3): バッキングは 80×60 固定をやめ、**枠の実画素**（CSS の大きさ × dpr）で面積平均して描く。
   *  そのぶん 1 枚が大きくなり得る（dpr 2・2 倍の高さで 296×222）ので、**見えなくなったサムネはバッキングを手放す**
   *  （releaseCanvas）＝メモリは「見えている枚数」で頭打ち（コマ数に比例しない） */
  private filmObserver: IntersectionObserver | null = null;
  /** V192 (R-3): 見えている（＋前後 200px）サムネ。描くのはこれだけ */
  private filmVisible = new Set<HTMLCanvasElement>();
  /** V192 (R-3): いま出している大きさ（fitKey）。違えば描き直す */
  private filmPainted = new WeakMap<HTMLCanvasElement, string>();
  /** V192: 1 枚の枠の出す大きさ（コマ一覧・小さいプレビュー）。枠・dpr が変わったら捨てる＝毎回測らない */
  private filmFit: DisplayFit | null = null;
  private miniFit: DisplayFit | null = null;
  private filmFitWatch: (() => void) | null = null;
  private miniFitWatch: (() => void) | null = null;
  /** V192 (R-5): 音の窓のプレビューの枠の見張り（パネルを閉じたら止める） */
  private apFitWatch: (() => void) | null = null;
  /** V192: コマ一覧・小さいプレビューの合成の使い回し（毎回 320×240 を確保しない） */
  private filmComposite = new Uint32Array(PIXELS);
  private miniComposite = new Uint32Array(PIXELS);
  private resizeObs: ResizeObserver | null = null;
  /** M11-17: タイムライン見出しの高さ（1行/2行）を追う。--ed-tlhead-h の更新だけ */
  private headObs: ResizeObserver | null = null;

  // ---------------- 起動/終了 ----------------

  mount(
    project: Project,
    saveCtx: EditorSaveContext | null,
    cb: EditorCallbacks,
    // V199 (A-106): fileName＝保存先は無いが名前の分かるファイル（ウィンドウへのドロップ→「編集」）の名前（拡張子なし）
    opts: { askSaveTarget?: boolean; sideFold?: SideFold; fileName?: string; workFile?: WorkFileRef | null } = {}
  ) {
    // V158 (L-1): 右パネルの段の畳み（settings から。壊れた値・両方畳みは既定へ）
    this.sideFold = sanitizeSideFold(this.sideFoldPending ?? opts.sideFold);
    // ★V214 (M-2b-1a): 作品を受け取って、共通レイヤーを張り直し・眠りを効かせるか決める（コアの openWorkStart・字と順は前と同じ）
    this.openWorkStart(project);
    this.saveCtx = saveCtx;
    this.askSaveTarget = opts.askSaveTarget ?? saveCtx == null;
    // ★V216b (A-126): その作品のファイル（ライブラリで開いた .memoanima・その項目つきのオートセーブ。ほかは無い）
    this.workFile = opts.workFile ?? null;
    this.saveRedirect = null;
    // ★V199 (A-106): 開いたファイルの名前。保存先が決まっていて選び直さない（＝ライブラリのファイルを開いた・
    //  その作品のオートセーブを戻した）ならその名前、ドロップで開いたならそのファイルの名前、新しいメモは null。
    //  「保存先を選ぶ」かどうかの判定は main.ts の editorWorkRef（V198）と同じ
    this.fileBase = opts.fileName || (saveCtx && !this.askSaveTarget ? saveCtx.baseName : null);
    // ★V214: 位置・履歴・未保存の印・開いた印・性能の口・作品ごとの知らせ・描きかけを最初の姿に（コアの openWorkReset・字と順は前と同じ）
    this.openWorkReset(project, cb);
    this.exporting = false; // W-5: 書き出し中に戻る→別の作品を開く、で取り残さない
    // ★V214: 再生と時計・選択（と選択の線）・浮いた絵・変形を最初の姿に（コアの openWorkPlayAndFloat）
    this.openWorkPlayAndFloat();
    // 表示状態は前回セッションを持ち越さない（swapped/回転/ズームのリセット）
    this.previewLarge = false;
    this.viewRot = 0;
    this.viewFlipH = false;
    this.zoomMode = "fit";
    // V195 (A-98): パンの形・控えた点も持ち越さない（開いたら全体表示＝applyZoom が .pan を外す）
    this.panGeom = null;
    this.panHeld = null;
    // ★V214: コマの範囲・フォルダとレイヤーの選択・レイヤーの控えを持ち越さない（コアの openWorkSelection）
    this.openWorkSelection();
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
    // V165 (D-4): 単体タップの候補を壊すためだけの listener（capture＝誰かが止めても届く）
    window.addEventListener("pointerdown", this.modTapPointerHandler, true);
    window.addEventListener("resize", this.resizeHandler);
    window.addEventListener("blur", this.blurHandler);
    // M12-C: キャンバスから出たらカーソル層を消す。**addEventListener で足す**
    //（診断ビルドが `wrap.onpointerleave` プロパティを使っているので、上書きし合わないように）
    document
      .querySelector("#ed-cvwrap")
      ?.addEventListener("pointerleave", this.cursorLeaveHandler);
    this.spaceHeld = false;
    // M11-5: 前のセッションの接触状態を持ち越さない（pointerup が届かないまま閉じた場合、
    // 開き直しても「かざしただけで線が引かれる」等が残っていた）。
    // **掴んだままなら解放してから忘れる** — ウィンドウへのドロップ→「編集」は unmount() を
    // 通らずに mount() し直すので、ここで id を忘れるだけだと二度と解放できなくなる
    this.spacePanned = false;
    this.openWorkPointer(); // ★V214: 押している印を下ろす（コアの openWorkPointer・前と同じ位置＝HUD のフックはパンの状態を読む）
    this.panState = null;
    this.lastPointerEvent = null;
    this.releaseCapture();
    this.cancelRowDrag();
    this.cancelFrameDrag(); // M11-7: 掴んだまま別の作品を開かない
    this.finishSplitDrag(false); // M11-17: スプリッターも同じ
    this.refreshTitle(); // V199 (A-106): 左上はいまのファイルの名前（V171: ✏ → pen の線画）
    // M11-18: キャンバス集中は**持ち越さない**（previewLarge と同じ一時的な見方）。個別の畳み（collapsed）と
    // ミニの置き場（miniDock）は設定から復元済みで、applyLayout / applyHud が DOM へ反映する
    this.focusActive = false;
    this.focusSnap = null;
    this.bindPanelFolds();
    // M11-17: パネル寸法は hudHidden と同じく**セッションを跨ぐ**状態。設定から復元済みの値を DOM へ
    //（applyZoom より前＝復元後の stage 寸法で倍率を決める）。スプリッターの配線もここで
    this.bindSplitters();
    this.applyLayout();
    // M11-13/16: 隠す/出す（hudHidden）は**セッションを跨いで持ち越す**状態なので、上の表示リセット
    //（previewLarge/回転/ズーム）とは別に、設定から復元した値をここで DOM へ反映する。
    // ストロークの自動非表示は**持ち越さない**（前の作品で押しっぱなしのまま閉じても薄いまま始まらない）
    if (this.hudRestoreTimer != null) {
      clearTimeout(this.hudRestoreTimer);
      this.hudRestoreTimer = null;
    }
    this.hudStroke = false;
    this.applyHud();
    // M12-C: 1階のカーソルを今のツールに合わせる（設定は main 側から restoreCursor で入る）。
    // 2階は位置が決まってから描くので、ここでは触らない
    this.applyCanvasCursor();
    this.cursorDot = null;
    this.cursorClient = null; // ★V209 (A-122)
    this.frameCursorOn = false;
    this.cursorPainted = "";
    this.applyZoom();
    this.refreshAll();
    this.openWorkNotice(); // ★V214: 共通を外して開いたときの一言（コアの openWorkNotice）
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
    // V192 (R-3・R-4): 枠の大きさか devicePixelRatio が変わったら作り直す（実画素で出しているので）。
    // コマ一覧の 1 枚の高さはタイムラインの高さで変わる＝帯（#ed-film）の高さも一緒に変わる
    this.filmFit = null;
    this.miniFit = null;
    this.filmFitWatch?.(); // 念のため（unmount を通らずに mount し直しても 2 重に見張らない）
    this.miniFitWatch?.();
    this.filmFitWatch = watchFit($("#ed-film"), () => this.refitFilm());
    this.miniFitWatch = watchFit($("#ed-mini"), () => {
      this.miniFit = null;
      if (this.miniShown()) this.paintMini();
    });
    // M11-17: 見出しの実高を --ed-tlhead-h へ（サムネの伸びの上限に使う）。
    // M11-18: 見出しは常に1行になったが、幅が変わったらあふれの振り分け（reflowTlHead）もここで。
    // reflow は見出しの寸法を変えない（1行固定・幅は親由来）ので観測ループにならない
    this.headObs = new ResizeObserver(() => {
      this.publishTlHeadHeight();
      this.reflowTlHead();
    });
    this.headObs.observe($("#ed-tlhead"));
    // M11-8: 手のひら/スクロールでキャンバスが動いたらランチャーも追従させる
    // （M3.9 H-1 でスクロールは内側の #ed-scroll に限定されている。#ed-stage は動かない）
    $("#ed-scroll").addEventListener("scroll", this.stageScrollHandler);
    // M11-10: 矢印キーの移動セッションを「別の操作」で確定させる（capture）
    $("#screen-editor").addEventListener("pointerdown", this.uiPointerHandler, true);
    // F-3: オートセーブ（15秒間隔・変更があるときだけ・描画中はスキップ）
    this.openWorkClean(); // ★V214: 未保存の印と便の印を下ろす（コアの openWorkClean・setter を通らない）
    this.autosaveTimer = window.setInterval(() => void this.runAutosave(), 15000);
    this.openWorkSweepSoon(); // ★V214: 眠りの片付けを少し待ってから始める（コアの openWorkSweepSoon）
  }

  unmount() {
    // M11-6: 二度呼んでも安全にする（showEditor() の先頭と showLibrary() の両方から
    // 呼ばれ得るため）。mount していない状態での後始末は何もしない
    if (!this.mounted) return;
    // ★V167 (K-4): Alt の押した数と離した数が**釣り合わないまま**編集を終えたら1行残す。
    //  2026-09-02 の特定は `?inputlog` を立てた実機ログで `altD=2 / altU=4` が見えたから
    //  できた（＝OS が keydown を落としている）。同じ報告が次に来たとき、
    //  **診断ビルドを送る前に**当たりが付くよう、普通のログにも1行だけ残す。
    //  釣り合っているときは何も書かない（ログを埋めない）
    if (this.altDownCount !== this.altUpCount) {
      this.cb.appendLog?.(
        `[V167 C] alt unbalanced down=${this.altDownCount} up=${this.altUpCount} fix=${this.altFixCount}`
      );
    }
    this.closeWorkStart(); // ★V214: 再生を止めて履歴を捨てる（コアの closeWorkStart・字と順は前と同じ）
    // V161 (A): 保存 Worker を畳む（leave は waitForSave を通るので、ここに来る時点で
    // 飛行中の保存は無い。次の作品で必要になれば作り直す）
    this.saveWorker?.terminate();
    this.saveWorker = null;
    if (this.savePillTimer) {
      clearTimeout(this.savePillTimer);
      this.savePillTimer = 0;
    }
    this.closeWorkSleep(); // ★V214: 性能の口・眠り・待ちの印・ログの口を外す（コアの closeWorkSleep）
    window.removeEventListener("keydown", this.keydownHandler);
    window.removeEventListener("keyup", this.keyupHandler);
    window.removeEventListener("pointerdown", this.modTapPointerHandler, true); // V165 (D-4)
    this.modTap.cancel();
    window.removeEventListener("resize", this.resizeHandler);
    window.removeEventListener("blur", this.blurHandler);
    // M12-C: 同一参照で外す。予約している rAF も畳む（画面を離れてから描かない）
    document
      .querySelector("#ed-cvwrap")
      ?.removeEventListener("pointerleave", this.cursorLeaveHandler);
    this.cancelCursorFrame();
    this.stopSelUiTimer(); // V208 (A-119): 選択の点線のタイマーを止める（画面を離れてから描かない）
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
    this.finishSplitDrag(true); // M11-17: 掴んだまま画面を離れない（変わっていれば保存してから）
    this.closeTlMore(); // M11-18: 「…」メニューを開いたまま画面を離れない
    // M14 (S-1): 形式ストリップは document.body 直付けの固定オーバーレイなので、画面を離れる前に必ず畳む
    //（他の浮遊UIと同じ後始末。タイマーも closeStrip の中で全て止める＝ライブラリ画面に残らない）
    this.closeStrip();
    // ★V214: 矢印の移動と文字の下書きを確定する（コアの closeWorkPending）。画面のフックを呼ぶので、選択の小窓を隠すより前
    this.closeWorkPending();
    document
      .querySelector("#screen-editor")
      ?.removeEventListener("pointerdown", this.uiPointerHandler, true);
    // M11-8: ランチャーと、そのスクロール購読を残さない
    document.querySelector("#ed-scroll")?.removeEventListener("scroll", this.stageScrollHandler);
    this.hideSelectionLauncher();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.headObs?.disconnect(); // M11-17
    this.headObs = null;
    this.filmObserver?.disconnect();
    this.filmObserver = null;
    this.filmVisible.clear();
    // V192: 枠の見張りを止める（作品を閉じたあとに描きに来ない）
    this.filmFitWatch?.();
    this.filmFitWatch = null;
    this.miniFitWatch?.();
    this.miniFitWatch = null;
    this.apFitWatch?.();
    this.apFitWatch = null;
    if (this.refitFilmTimer != null) {
      window.clearTimeout(this.refitFilmTimer);
      this.refitFilmTimer = null;
    }
    if (this.autosaveTimer != null) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    this.closeWorkWarp(); // ★V214: 魚眼の連続を止め・四隅を取り消し・歪みの場と音の試聴を捨てる（コアの closeWorkWarp）
    this.audioPanelClose?.();
    // M10-4 P-1-3: 開いたままのゆらゆらダイアログを閉じる。close(null) を通るので
    // modalDepth の減算・capture リスナー解除・back.remove() が全部走り、
    // await 側は null を受け取って早期 return する（生成は起きない）
    this.wobbleDialogClose?.();
    // V164 (U-4): 「まとめて追加」も同じ（開いたまま離脱すると modalDepth が残る）
    this.addFramesDialogClose?.();
    // M10-21: 診断ログの残りを吐き切ってタイマーを止める（フラグなしなら両方とも空/None）
    if (this.inputLogTimer != null) {
      window.clearTimeout(this.inputLogTimer);
      this.inputLogTimer = null;
    }
    const rest = this.inputLogBuf.splice(0);
    if (rest.length) this.cb.appendLog?.(rest.join("\n"));
    this.closeWorkEnd(); // ★V214: 開いた印を下ろす（コアの closeWorkEnd）
  }

  /** F-3: 変更があればアプリ設定領域へオートセーブ（保存の原子性はRust側が担保） */
  private async runAutosave() {
    // 変形/選択の浮動中はレイヤーから切り出したピクセルがプロジェクト外にあるため
    // スナップショットが欠損する — スキップして次周期へ（独立レビューの指摘#6）
    // ★V214 (M-2b-1a): 作品の側の「書き始めない」条件（閉じた・重い処理・押している・変形・浮いた絵・四隅）はコアの autosaveBlocked。
    //  PC の便の印（autosavePending）・前の便と保存の飛行中・書き出し中はここで足す（判断は前と同じ）
    if (
      !this.autosavePending ||
      // M10-23: 分割エンコード化で1回の所要が長くなり、15秒interval と3秒リトライが
      // 重なり得る。多重併走すると invalidateAutosave が後発の飛行中書き込みを待てない
      //（レビュー検出）。前の便が飛行中なら見送る（pending は残るので次の機会に走る）
      this.autosaveInFlight != null ||
      // V161 (A): 背景保存の飛行中も見送る（同じ作品を2本同時に直列化しない。
      // pending は残るので、保存が終わった次の周期に走る）
      this.saveInFlight != null ||
      // V154 (W-5): 書き出し中は見送る。600コマの動画をエンコードしている最中に
      // 15秒ごとに作品まるごと（138〜276MB）を直列化し直すと、書き出しと保存が
      // 同時に山を作って落ちる。**書き出し中は編集できない＝取りこぼす変更が無い**ので、
      // pending を残したまま見送り、終わった直後に走らせる（setExporting）
      this.exporting ||
      this.autosaveBlocked()
    )
      return;
    this.autosavePending = false;
    const epoch = this.autosaveEpoch;
    const job = (async () => {
      // ★V201 (M-1a): 手順（PV6 にする〔譲りと中断つき〕→ 確かめる → 書く）は共通の部品 `autosaveWork`（saveCore.ts）へ移した。
      //  ここに残すのは、いつ捨てるか・いつ書かないかの判断（編集画面の状態）と、書く印（題名・保存先）と、結果ごとの後始末。
      // 変更は必ず dirty→autosavePending か history.mutations に現れる
      //（bufferChangeEntry の onApply / afterFrameStructureChange 等が dirty を立てる）
      // ★V214 (M-2b-1a): 書き始めの印（autosaveMark）と、その印からの変化（autosaveChangedSince＝閉じた・履歴が変わった・押した・
      //  変形・浮いた絵・四隅）はコア。PC の時計の世代と便の印（autosavePending）はここで足す
      const mark = this.autosaveMark();
      const out = await autosaveWork({
        project: this.project,
        yieldNow: yieldToInput,
        aborted: () =>
          epoch !== this.autosaveEpoch ||
          this.autosavePending ||
          this.autosaveChangedSince(mark),
        // 直前にライブラリ保存/破棄が完了していたら、この古いスナップショットは書かない
        stillCurrent: () => epoch === this.autosaveEpoch && this.mounted,
        meta: () => ({
          title: this.titleNow(), // V199 (A-106): 復元の知らせに出す名前＝いまのファイルの名前（無ければ題名）
          // V199 (A-106): 保存先の無いファイル（ドロップで開いた作品）の名前。戻したときの左上に使う（AMAS1 の meta は形の決まりの無い JSON）
          fileBase: this.fileBase,
          album: this.saveCtx?.album ?? null,
          baseName: this.saveCtx?.baseName ?? null,
          libRoot: this.saveCtx?.libRoot || null,
          askSaveTarget: this.askSaveTarget,
          // ★V216b (A-126 §2-1 の 8): その作品のファイルと、開いた・書いた時点の大きさと更新時刻（分からなければ書かない＝戻すと「無い」）
          workFile:
            this.workFile && this.workFile.size != null && this.workFile.mtimeUs != null
              ? { path: this.workFile.path, size: this.workFile.size, mtimeUs: this.workFile.mtimeUs }
              : null,
          savedAt: new Date().toISOString(),
        }),
        write: (w) => this.cb.autosave(w.data, w.meta),
        log: (line) => void this.cb.appendLog?.(line),
      });
      if (out === "aborted") {
        // 中断（エンコード中に編集が始まった等）。変更は残っているので保存待ちに戻し、
        // 次の15秒周期を待たずに、ペンを置いた隙間で保存できるよう短い再試行を1回だけ予約
        if (this.mounted && epoch === this.autosaveEpoch) {
          this.autosavePending = true;
          window.setTimeout(() => void this.runAutosave(), 3000);
        }
      } else if (out === "bad") {
        // 確かめに落ちて書かなかった（ログは部品が書いた）。変更は残っているので保存待ちに戻す（次の周期でもう一度作り直す）
        if (this.mounted && epoch === this.autosaveEpoch) this.autosavePending = true;
      }
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

  /** V154 (W-5): 書き出しの開始/終了を知らせる（`main.ts` のエクスポートダイアログが呼ぶ）。
   *  終わったら、待たせていた便を**次の周期を待たずに**走らせる（最大15秒の空白を作らない）。 */
  setExporting(v: boolean) {
    if (this.exporting === v) return;
    this.exporting = v;
    // V154b (W-9): 書き出しの実行中も編集を受け付けない。
    // **進捗は出さない**——書き出しダイアログが自前の進捗（％と段階）を出しているので、
    // その上にもう1枚重ねると、どちらを見ればいいのか分からなくなる
    if (v) {
      if (!this.busyKind) this.beginBusy("export");
    } else if (this.busyKind === "export") {
      this.endBusy();
    }
    if (!v && this.autosavePending) void this.runAutosave();
    // V163: 書き出し前の「全コマ起こし」を眠らせ直す（読みで起こしたので只＝freeOnly で片付く）
    if (!v && this.sleepOn) this.nudgeSweep();
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
    message = t("ed.leave.discard.msg")
  ): Promise<boolean> {
    if (!this.mounted) return true;
    // V161 (A): 画面を離れる前に、飛行中の保存を待つ（要件: 閉じる・別メモは保存完了を待つ）
    await this.waitForSave();
    if (this.leaveBlocked()) return false; // E-4: 変形中は確定/取消が先（★V214: 判断はコアの leaveBlocked）
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

  /** M12-E: **危ない操作の直前に、オートセーブをもう1回だけ走らせる**。
   *
   *  15秒の周期（`mount()` の setInterval）は**変えない**。これはその周期に加えて、
   *  「再読み込みされるかもしれない」「背面に回った」といった**取りこぼしが起きうる瞬間**に
   *  1回だけ差し込むための入口。`runAutosave()` は private なので公開ラッパを置く。
   *
   *  `runAutosave()` の入口ガードはそのまま効く。したがって次のときは**何も書かない**:
   *   - 変更が無い（`autosavePending` が false）… 書く必要が無い
   *   - 前の便が飛行中（`autosaveInFlight`）… 既に書いている最中
   *   - ペン接触中・変形中・浮動中・四隅中 … **中途半端な状態を焼き付けないための既存の判断**
   *  「書けなかった」ことは戻り値に出ない（`runAutosave` は成否を返さない）。
   *  呼び出し側は**待つだけ**にして、書けたかどうかで分岐しないこと。 */
  async autosaveNow(): Promise<void> {
    if (!this.mounted) return;
    await this.runAutosave();
  }

  // ---------------- UI 構築 ----------------

  private buildToolsPanel() {
    const tools: { key: Tool; icon: IconId; label: string }[] = [
      // M3.10 G-2: 手のひらは最上段（ペンの上）。H/Space の割当は不変
      { key: "hand", icon: "hand", label: t("ed.tool.hand.label") },
      { key: "pen", icon: "pen", label: t("ed.tool.pen.label") },
      { key: "brush", icon: "brush", label: t("ed.tool.brush.label") },
      { key: "eraser", icon: "eraser", label: t("ed.tool.eraser.label") },
      { key: "fill", icon: "fill", label: t("ed.tool.fill.label") },
      { key: "shape", icon: "shape", label: t("ed.tool.shape.label") },
      { key: "text", icon: "text", label: t("ed.tool.text.label") },
      { key: "eyedrop", icon: "eyedrop", label: t("ed.tool.eyedrop.label") },
    ];
    const edits: { key: Tool | "copyprev" | "clear"; icon: IconId; label: string }[] = [
      // M11-8 P-2: 絵を動かすのはこのツール（選択範囲内のドラッグは枠だけが動く）
      { key: "move", icon: "move", label: t("ed.tool.move.label") },
      { key: "select", icon: "select", label: t("ed.tool.select.label") },
      { key: "transform", icon: "transform", label: t("ed.tool.transform.label") },
      // M10-2a: 方式（押す/ふくらませ/へこませ/四隅）はツールオプション内で切り替える。
      // 方式ごとにボタンを増やすと段組みが崩れるので、ツールは1つだけ（REQ §3.6）
      { key: "warp", icon: "warp", label: t("ed.tool.warp.label") },
      { key: "copyprev", icon: "copyprev", label: t("ed.tool.copyprev.label") },
      { key: "clear", icon: "clear", label: t("ed.tool.clear.label") },
    ];
    const host = $("#ed-tools");
    host.innerHTML = "";
    // V171: `icon` は絵文字の文字列から**アイコン id**（IconId・icons.json から型で作る）へ。インライン SVG で挿す
    const mk = (iconId: IconId, label: string, key: string) => {
      const b = document.createElement("button");
      b.className = "tool";
      b.dataset.tool = key;
      b.innerHTML = `<span class="em">${iconHtml(iconId)}</span><span class="nm">${escHtml(label)}</span>`;
      return b;
    };
    // M14 (S-1): ツールボタンへ setTool＋形式ストリップ（ホバー＋選択中の再クリックで開く）を配線する。
    // ストリップを持つツールだけ（画像・音声・複写・手のひら・スポイト・移動は toolHasStrip=false で出ない）
    const wireToolButton = (b: HTMLElement, key: Tool) => {
      b.addEventListener("click", () => {
        const wasActive = this.tool === key;
        this.setTool(key);
        if (wasActive && this.toolHasStrip(key)) this.openStrip(key, b); // 再クリックで開く
      });
      if (this.toolHasStrip(key)) this.attachToolStrip(b, key); // ホバーで開く（150ms）
    };
    for (const t of tools) {
      const b = mk(t.icon, t.label, t.key);
      wireToolButton(b, t.key as Tool);
      host.appendChild(b);
    }
    const lbl = document.createElement("div");
    lbl.className = "tlabel";
    lbl.textContent = t("ed.tool.editGroup.label");
    host.appendChild(lbl);
    for (const t of edits) {
      const b = mk(t.icon, t.label, t.key);
      if (t.key === "copyprev") b.addEventListener("click", () => this.copyPrevFrame());
      else if (t.key === "clear") b.addEventListener("click", () => this.clearFrame());
      else wireToolButton(b, t.key as Tool);
      host.appendChild(b);
    }
    // M8-2b: 画像取り込みは左ツール列の「♪ 音声」直上（上部バーから移設）。
    // ツール選択ではないので dataset.tool は既存ツールと重ならない値にする（"on" が付かない）
    const img = mk("camera", t("ed.tool.image.label"), "image");
    img.id = "ed-tool-image";
    img.title = t("ed.tool.image.title");
    img.addEventListener("click", () => {
      if (this.xformGuard()) return;
      if (this.playing) this.stopPlayback();
      this.cb.importImage?.();
    });
    host.appendChild(img);
    // M6-3 A-3: 音声は左ツール列のボタン → 波形調整パネル（モーダル）
    const au = mk("audio", t("ed.tool.audio.label"), "audio");
    au.id = "ed-tool-audio";
    au.addEventListener("click", () => void this.openAudioPanel());
    host.appendChild(au);
    this.updateAudioToolButton();
    this.updateToolButtons();
  }

  /** 音声ボタンの状態表示（♪=あり / 🔇=全ミュート / 薄色♪=なし）。M5-1: BGM+SE対応 */
  protected override updateAudioToolButton() {
    const b = document.querySelector("#ed-tool-audio") as HTMLElement | null;
    if (!b) return;
    const a = this.project.audio ?? null;
    const has = !!a && (!!a.bgm || a.se.length > 0);
    const allMuted =
      has && (!a!.bgm || a!.bgm.muted) && a!.se.every((s) => s.muted) && (a!.bgm != null || a!.se.length > 0);
    const em = b.querySelector(".em") as HTMLElement;
    em.replaceChildren(icon(has && allMuted ? "audio-muted" : "audio")); // V171: 状態ペア audio / audio-muted
    b.style.opacity = has ? "1" : "0.55";
    // M12-1b-2（監査 #6 / R-3）: 断片を連結せず、BGM の状態 × 全ミュート有無で**完全文**を選ぶ。
    // 差し込み先は title プロパティなので escHtml は通さない（通すと &lt; が字として見える）
    const count = a?.se.length ?? 0;
    const name = a?.bgm?.name ?? t("ed.tool.audio.bgmUnnamed.label");
    b.title = !has
      ? t("ed.tool.audio.none.title")
      : !a?.bgm
        ? allMuted
          ? t("ed.tool.audio.summaryNoneMuted.title", { count })
          : t("ed.tool.audio.summaryNone.title", { count })
        : a.bgm.source === "kwz"
          ? allMuted
            ? t("ed.tool.audio.summaryKwzMuted.title", { count })
            : t("ed.tool.audio.summaryKwz.title", { count })
          : allMuted
            ? t("ed.tool.audio.summaryExtMuted.title", { name, count })
            : t("ed.tool.audio.summaryExt.title", { name, count });
  }

  /** M5-4 B-3/M5-5 T-3: ペン=テクスチャ3種 / ブラシ・バケツ=トーンピッカー（2列・大小並び・各自独立記憶） */
  protected override rebuildTexPicker() {
    const head = document.querySelector("#ed-texhead") as HTMLElement | null;
    const tex = document.querySelector("#ed-tex") as HTMLElement | null;
    if (!head || !tex) return;
    tex.innerHTML = "";
    // M11-14: 消しゴムにも同じピッカーを出す（かすり消し）。選択はツールごとに独立記憶
    const toneMode =
      this.tool === "brush"
        ? "brush"
        : this.tool === "fill"
          ? "fill"
          : this.tool === "eraser"
            ? "eraser"
            : null;
    if (toneMode) {
      // M11-24: 見出しは道具名を繰り返さない（選んでいる道具は左の道具列で分かる）。
      // 「ベタ=全部消す」は title へ逃がす（画面に出しっぱなしにしない）
      head.textContent =
        toneMode === "brush" ? t("ed.tone.head.brush.label") : toneMode === "fill" ? t("ed.tone.head.fill.label") : t("ed.tone.head.eraser.label");
      head.title = toneMode === "eraser" ? t("ed.tone.head.eraser.title") : "";
      tex.classList.add("tonegrid");
      // ★V165 (D-2): かすり消しは「見えているのに何ができるか分からない」（意見シート#2/#3）。
      //  補足を `head.title` に逃がしていたので**マウスを乗せないと読めず**、ペンタブでは事実上
      //  読めなかった。見出しは太らせずに、一覧の先頭へ**小さな1行**として出す（title も残す）。
      //  **名前（「かすり消し」）は変えない**——3DS の作法に馴染んだ語（要件 D-2）
      if (toneMode === "eraser") this.appendToneNote(tex, t("ed.tone.head.eraser.hint"));
      const getId = () =>
        toneMode === "brush"
          ? this.brushToneId
          : toneMode === "fill"
            ? this.fillToneId
            : this.eraserToneId;
      const setId = (id: string) => this.setToneIdFor(toneMode, id); // ★V214: どの道具の枠に書くかはコア
      // M11-19→M11-24: グループの区切り。**文字は出さない**（「ざこメモの柄／メモアニマの柄」は削除・
      // 作者指摘）。並び・id・タイルは一切変えない。斜め格子（diag-grid）の下に細い線を1本だけ引いて、
      // 3DS 由来の柄と本アプリで足した柄の切れ目だけ残す（先頭には引かない＝上に何も無いので不要）。
      // 2列グリッドの行またぎを起こさないよう区切りは 1行ぶち抜き（.tone-sep・grid-column: 1 / -1）。
      // 選択の付け外しは .tone-btn を querySelectorAll しているので、区切りが混ざっても壊れない
      const sep = () => {
        const s = document.createElement("div");
        s.className = "tone-sep";
        tex.appendChild(s);
      };
      // M16 (D-1): 「🔀 コマでずらす」トグル（トーン欄の先頭に1行ぶち抜きで）。既定オフ・settings に記憶。
      // 📌全コマ共通レイヤーは1バッファなので揺れない旨を title に書く（仕様）
      this.appendDitherRow(tex);
      // M12-1c-2: ループ変数は tone（`t` は翻訳関数。M12-1b の TEXTURES と同じ作法）
      for (const tone of R.TONE_TILES) {
        const d = document.createElement("button");
        // M11-14b: 大/小のペアを**同じ行**に揃えるため、ペアを持たない柄（ベタ・斜め格子）は
        // 2列ぶちぬきにする。REQ §9 の並びをそのまま2列に流すと、ベタ（1個）と
        // ベタ抜き系（3個）が奇数なので、以降のペアが全部行をまたいでしまう。
        // ベタ抜きドット/（疎）は同グループの2個で1行に収まる
        const wide = tone.tile === null || tone.id === "diag-grid";
        d.className =
          "tone-btn" + (wide ? " tone-wide" : "") + (tone.id === getId() ? " on" : "");
        d.title = t(tone.nameKey);
        // スウォッチ: **横長**（8×8タイル × 横6 × 縦2 リピート）→ CSS ×2 pixelated。
        // V158 (L-3): 32×32 の正方形から **48×16** へ。柄は 8×8 の繰り返しなので、
        // 横 6 回・縦 2 回も見えれば十分に見分けられる（正方形は縦に 4 回ぶん無駄に高かった）。
        // チップの高さが 78px → 46px になり、22種＋マイ柄のスクロール量がほぼ半分になる。
        // 2列ぶちぬきの柄は従来どおり 72×16（高さがそろって行が乱れない）
        const cv = document.createElement("canvas");
        cv.width = wide ? 72 : 48;
        cv.height = 16;
        const ctx = cv.getContext("2d")!;
        // V158 (C-2): 配色から読む（夜の紙では地が暗く・柄が明るくなって、そのまま見分けられる）
        ctx.fillStyle = uiColor("--panel", "#ffffff");
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = uiColor("--ink", "#2c2621");
        for (let y = 0; y < cv.height; y++)
          for (let x = 0; x < cv.width; x++)
            if (!tone.tile || R.toneAt(tone.tile, x, y)) ctx.fillRect(x, y, 1, 1);
        d.appendChild(cv);
        d.addEventListener("click", () => {
          setId(tone.id);
          tex.querySelectorAll(".tone-btn").forEach((e) => e.classList.remove("on"));
          d.classList.add("on");
        });
        tex.appendChild(d);
        if (tone.id === "diag-grid") sep(); // 斜め格子の下に区切り線（文字なし）
      }
      // M17: 末尾に「マイ柄」節（登録があるときだけ）
      this.appendCustomToneSection(tex, toneMode, getId, setId);
    } else {
      head.textContent = t("ed.pen.kind.label");
      tex.classList.remove("tonegrid");
      // M12-1b: ループ変数は tx（`t` は翻訳関数）
      for (const tx of TEXTURES) {
        const d = document.createElement("button");
        // M17: マイ柄を選んでいる間はどの texture も押された表示にしない
        d.className = "tx" + (tx.key === this.texture && !this.penToneId ? " on" : "");
        d.title = t(tx.labelKey);
        d.replaceChildren(icon(tx.icon)); // V171: 線画アイコン（currentColor）
        d.addEventListener("click", () => {
          this.pickPenTexture(tx.key); // ★V214: 中身はコア
          tex.querySelectorAll(".tx, .tone-btn").forEach((e) => e.classList.remove("on"));
          d.classList.add("on");
        });
        tex.appendChild(d);
      }
      // M17: ペンの「種類」にもマイ柄（REQ §2-2 対象経路: ペン）
      this.appendCustomToneSection(
        tex,
        "pen",
        () => this.penToneId,
        (id) => {
          this.penToneId = id;
        }
      );
    }
    // M14 (S-3): 折りたたみ状態を反映（head.textContent を書き直したので折りたたみマークも付け直す）
    this.applyToneFold();
  }

  /** M16 (D-1): 「🔀 コマでずらす」トグル行（1行ぶち抜き）。トーン欄の先頭と、M17 でペンの「マイ柄」節にも出す
   *（ペン＋マイ柄にもシフトが効くので、ペン側からも見える・切れるように） */
  /** V165 (D-1/D-2): トーン一覧の中に出す**小さな説明の1行**（グリッド1行ぶち抜き）。
   *  `.tone-dither`（🔀 の行）と同じ器の作り方で、畳んでも残る（説明は畳んで隠す物ではない）。 */
  private appendToneNote(tex: HTMLElement, text: string) {
    const p = document.createElement("p");
    p.className = "tone-note";
    p.textContent = text;
    tex.appendChild(p);
  }

  private appendDitherRow(tex: HTMLElement) {
    const row = document.createElement("div");
    row.className = "tone-dither";
    const sw = document.createElement("div");
    sw.className = "sw2" + (this.ditherFrameShift ? " on" : "");
    const lab = document.createElement("span");
    lab.className = "tog";
    setIconLabel(lab, "transform", t("ed.tone.ditherShift.label")); // V171: 🔀 → transform
    row.title = t("ed.tone.ditherShift.title");
    row.appendChild(sw);
    row.appendChild(lab);
    row.addEventListener("click", () => {
      this.toggleDitherFrameShift(); // ★V214: 中身と設定への知らせはコア
      sw.classList.toggle("on", this.ditherFrameShift);
    });
    tex.appendChild(row);
  }

  // ================= M17: マイ柄（カスタムトーン） =================
  /** トーン一覧／ペンの種類の末尾に「マイ柄」節を足す。登録が無ければ何も出さない。
   *  チップ: 32×32 バッキングに柄をタイル敷き（透明は市松）→ CSS ×2 pixelated（既存トーンチップと同じ倍率）。
   *  クリック＝選択／右クリック＝確認つき削除。かすり消し以外には「🎨 登録した色で塗る」トグルも出す */
  private appendCustomToneSection(
    tex: HTMLElement,
    kind: "pen" | "brush" | "fill" | "eraser",
    getId: () => string,
    setId: (id: string) => void
  ) {
    const empty = this.customTones.length === 0;
    const head = document.createElement("div");
    // ★V165 (D-1): 空のときは `empty` を付ける。一覧を畳んでいると
    //  `.tex.collapsed .tone-custom-head { display:none }` で見出しが消えるが、
    //  **畳みは既定**なので、それだと「マイ柄」という**探している名前**が画面から消えてしまう
    //（説明だけ出ても、探している語が無ければ見つけたことにならない）。空のときだけ残す
    head.className = "tone-custom-head" + (empty ? " empty" : "");
    head.textContent = t("ed.tone.custom.head.label");
    tex.appendChild(head);
    // ★V165 (D-1): **1つも登録していない人にも節を出す**（作者決定）。
    //  以前はここが `if (this.customTones.length === 0) return;` で、登録が無い人には
    //  「マイ柄」という節そのものが画面に存在しなかった＝**探しても無いものは見つからない**
    //  （意見シート: 30分探して未発見）。空のときだけ「どうすれば増えるか」を1行出す。
    //  ★増えたあとは**この行が消えて従来の見た目に戻る**（画面を無駄に太らせない・要件 D-1）。
    //  🔀 と 🎨 のトグルは**登録があるときだけ**——柄が1つも無い状態では効き目が無く、
    //  ペンの「種類」欄に今まで無かった行を増やしてしまう（＝既定の見た目が変わる）
    if (empty) {
      this.appendToneNote(tex, t("ed.tone.custom.empty.hint", { btn: t("ed.sel.registerTone.btn") }));
      return;
    }
    // ペンの種類欄にはトーン欄先頭の🔀が無いので、マイ柄節に出す（ペン＋マイ柄にもシフトが効く）
    if (kind === "pen") this.appendDitherRow(tex);
    if (kind !== "eraser") {
      // かすり消しは常に形だけなのでトグルを出さない
      const row = document.createElement("div");
      row.className = "tone-colormode";
      const sw = document.createElement("div");
      sw.className = "sw2" + (this.customToneColor ? " on" : "");
      const lab = document.createElement("span");
      lab.className = "tog";
      setIconLabel(lab, "palette", t("ed.tone.custom.colorMode.label")); // V171: 🎨 → palette
      row.appendChild(sw);
      row.appendChild(lab);
      row.addEventListener("click", () => {
        this.toggleCustomToneColor(); // ★V214: 中身と設定への知らせはコア
        sw.classList.toggle("on", this.customToneColor);
      });
      tex.appendChild(row);
    }
    this.customTones.forEach((ct, n) => {
      const key = CT.customToneKey(ct.id);
      const d = document.createElement("button");
      d.className = "tone-btn custom" + (key === getId() ? " on" : "");
      d.title = t("ed.tone.custom.chip.title", { n: n + 1 });
      const cv = document.createElement("canvas");
      cv.width = CUSTOM_CHIP_PX;
      cv.height = CUSTOM_CHIP_PX;
      const ctx = cv.getContext("2d")!;
      // 市松（透明の見え方）→ 柄をタイル敷き（w,h 周期でそのまま繰り返す＝塗ったときの見え方）
      for (let y = 0; y < CUSTOM_CHIP_PX; y++)
        for (let x = 0; x < CUSTOM_CHIP_PX; x++) {
          ctx.fillStyle = (((x / CUSTOM_CHIP_CHECKER) | 0) + ((y / CUSTOM_CHIP_CHECKER) | 0)) & 1 ? "#ddd" : "#fff";
          ctx.fillRect(x, y, 1, 1);
          const c = ct.colors[(y % ct.h) * ct.w + (x % ct.w)];
          if (c) {
            ctx.fillStyle = c;
            ctx.fillRect(x, y, 1, 1);
          }
        }
      d.appendChild(cv);
      d.addEventListener("click", () => {
        setId(key);
        tex.querySelectorAll(".tone-btn, .tx").forEach((e) => e.classList.remove("on"));
        d.classList.add("on");
      });
      d.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.deleteCustomTone(ct.id);
      });
      tex.appendChild(d);
    });
  }

  /** M14 (S-3): 「種類/トーン」一覧の開閉を DOM へ反映する。閉＝現在の種類（.on）だけ1行表示（CSS 側で
   *  .tex.collapsed の非選択を隠す）。ヘッダ末尾に開閉マーク（▾/▸）を付け直す（textContent で消えるため毎回）。 */
  private applyToneFold() {
    const head = document.querySelector("#ed-texhead") as HTMLElement | null;
    const tex = document.querySelector("#ed-tex") as HTMLElement | null;
    if (tex) tex.classList.toggle("collapsed", !this.toneOpen);
    if (head) {
      let mark = head.querySelector(".foldmark") as HTMLElement | null;
      if (!mark) {
        mark = document.createElement("span");
        mark.className = "foldmark";
        head.appendChild(mark);
      }
      mark.replaceChildren(icon(this.toneOpen ? "chev-down" : "chev-right")); // V171: ▾/▸ → chevron
    }
  }

  /** M11-2: 太さピッカーの選択表示を現在の penSize に合わせ直す（DOMは作り直さない） */
  /** ★V214 (M-2b-1a): 変形の取っ手・回転の輪・歪みの四隅の当たり（キャンバスのドット）。PC は前の値のまま（6・12・8） */
  protected override xformHitSizes(): XformHitSizes {
    return Editor.XFORM_HIT_SIZES;
  }
  private static readonly XFORM_HIT_SIZES: XformHitSizes = { hit: 6, ring: 12, corner: 8 };

  /** ★V214: 取り消しとやり直しのボタンの有効・無効（前は bindHeader の history.onchange の中・字は同じ） */
  protected override undoRedoShown() {
    ($("#ed-undo") as HTMLButtonElement).disabled = !this.history.canUndo;
    ($("#ed-redo") as HTMLButtonElement).disabled = !this.history.canRedo;
  }

  protected override refreshSizePicker() {
    const host = document.querySelector("#ed-sizes");
    if (!host) return;
    host.querySelectorAll(".sz").forEach((el, i) => {
      el.classList.toggle("on", PEN_SIZES[i] === this.penSize);
    });
  }

  /** M11-11: ツールオプション（確定/キャンセル等）が画面外だと気づけないので、はみ出していれば見せる。
   *  M14 (S-3): #ed-toolopts を**パネル最上部**へ移したので、下だけでなく**上**にも隠れ得る。
   *  パネルを下までスクロールした状態で変形/文字に切り替えると、確定/キャンセルが折り返し線の上に来る。
   *  上に隠れていれば上へ、下にはみ出していれば下へ寄せる（収まっていれば何もしない）。 */
  private revealToolOptions() {
    const side = document.querySelector("#ed-side") as HTMLElement | null;
    const host = document.querySelector("#ed-toolopts") as HTMLElement | null;
    if (!side || !host || !host.firstChild) return;
    const sr = side.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    if (hr.top < sr.top - 1) host.scrollIntoView({ block: "start" });
    else if (hr.bottom > sr.bottom + 1) host.scrollIntoView({ block: "end" });
  }

  protected override updateToolButtons() {
    document.querySelectorAll("#ed-tools .tool").forEach((el) => {
      el.classList.toggle("on", (el as HTMLElement).dataset.tool === this.tool);
    });
    // ★V209 (A-122): ツールが替わった所（setTool・貼り付けと画像の配置で変形に入る・endTransform で抜ける）で、枠と 1 階を一緒に決め直す
    //（setTool を通らない所もここは通る。変形を抜けたら今のツールのカーソルへ・キーでツールを替えた直後もポインタの下に枠）
    if (this.tool !== "transform") this.applyCanvasCursor();
    this.syncCursorFrame();
  }

  private buildSidePanel() {
    const host = $("#ed-side");
    // M14 (S-3): 並びを刷新。①ツールの形式・オプション（最上部）→②サイズ→③種類/トーン（折りたたみ）
    // →④色→⑤レイヤー→⑥線の太さ→⑦オニオン→⑧描き心地。各ブロックの中身のロジックは触らず DOM 順序だけ変更
    // ★V158 (L-1): 右パネルを**上下2段**にする。
    //
    //  これまでは1本の縦スクロールに全部を縦積みしていたので、ツール設定が長い道具
    //  （変形・範囲選択・トーン・文字）を選ぶと**レイヤーが下へ押し出されて画面から消えて**いた。
    //  「ごちゃつく」「レイヤーが遠い」「常に表示しておきたい」は全部この1つの症状。
    //
    //  上段＝道具まわり（中でスクロール）／下段＝レイヤー（**常に見えている**）。
    //  **中身のロジックと id は1つも変えていない**——動かすのは入れ物と並びだけ。
    host.innerHTML = `
      <div class="side-sec side-top" id="ed-side-top">
      <div class="side-sechead">
        <!-- V158（独立レビューの指摘③）: ここは**上段の中身の名前**。ed.panel.foldTools.title
             （＝「道具列を畳む」・左の道具列を畳むボタンの説明）を借りていたので、
             畳んだあとに「道具列を畳む」だけが残って別の操作に見えていた -->
        <span>${t("ed.side.tools.label")}</span>
        <button class="minibtn sfold" id="ed-sfold-top" type="button">${iconHtml("chev-up")}</button>
      </div>
      <div class="side-secbody" id="ed-side-topbody">
      <div id="ed-toolopts"></div>
      <!-- ★V164 (U-2): オニオンを**上段の先頭付近**へ移した（道具オプションの直後）。
           前は「線の太さ」の下＝上段の中ほどにあり、**上段は中でスクロールする**ので
           狭い画面では初期表示で見えず、「機能があるのに30分探して見つからない」の主因だった
           （意見シート#2/#3）。どの道具でも使う表示設定で、太さ・種類・色より切り替えが多い。
           行は2本: 段数（切/1/2/3・従来のまま）と U-1 の向き（前のコマ/両方/次のコマ） -->
      <h3>${t("ed.onion.head.label")}</h3>
      <div class="oni" id="ed-onion"></div>
      <div class="oni" id="ed-oniondir"></div>
      <h3>${t("ed.pen.size.label")}</h3><div class="sizes" id="ed-sizes"></div>
      <h3 id="ed-texhead" class="foldhead">${t("ed.pen.kind.label")}</h3><div class="tex" id="ed-tex"></div>
      <!-- ★V215 (A-124): 色まわり（見出し・帯・フルカラー・よく使う色）は下の「色の段」へ移した。紙の色はここに残す（D-1） -->
      <div class="row"><span class="tog">${t("ed.color.paper.label")}</span><div id="ed-paperpal" class="pal" style="flex:1"></div></div>
      <!-- V164 (U-2): V158 の記述ミスを訂正。**ここはまだ上段（道具）の中**——
           下段（レイヤー）が始まるのは #ed-side-bot から。線の太さ〜作品の大きさも
           全部この #ed-side-topbody の中にある -->
      <h3>${t("ed.linew.head.label")}</h3>
      <div class="selacts" id="ed-linew">
        <button class="minibtn" id="ed-lw-thicken">${iconLabelHtml("line-thicken", t("ed.linew.thicken.btn"))}</button>
        <button class="minibtn" id="ed-lw-thin">${iconLabelHtml("line-thin", t("ed.linew.thin.btn"))}</button>
      </div>
      <h3>${t("ed.feel.head.label")}</h3>
      <div class="row"><span class="tog">${t("ed.feel.stabilizer.label")}</span><div class="sw2 on" id="ed-tog-stab"></div></div>
      <div class="row"><span class="tog">${t("ed.feel.pressure.label")}</span><div class="sw2 on" id="ed-tog-press"></div></div>
      <div class="row"><span class="tog">${t("ed.feel.grid.label")}</span><div class="sw2 on" id="ed-tog-grid"></div></div>
      <!-- V154 (W-2): 作品の大きさ。**実体を数える**（掛け算ではない）・履歴は別行 -->
      <h3 id="ed-szhead">${t("ed.size.head.label")}</h3>
      <div class="szmeter" id="ed-szmeter"></div>
      <!-- ★V197 (A-101): 上段のスクロールの下端のぼかし（飾り・クリックは素通し）。
           下端で切れて真ん中が隠れた色見本が、すぐ下の仕切りの下に潜っているように見えていた
           （重なりではない＝V197 報告 §1 の数字）。かならず**中身の最後**に置く（sticky で下端に貼り付き、
           一番下までスクロールすると最後の要素の下の空き地に収まる） -->
      <div class="side-fade" aria-hidden="true"></div>
      </div>
      <!-- ★V215 (A-124・REQ_color_section §2-1): 色の段。上段（#ed-side-top）の中・道具のスクロール（#ed-side-topbody）の外・
           その下（仕切りのすぐ上）＝**いつも見える**。中身は前の色まわりそのまま（id・イベント・処理は 1 つも変えていない）。
           帯とよく使う色は見える段数に上限があり（fitColorRows）、超えたら**その中だけ**で行ごとにスクロールする。
           見出しの行: 今の見出しの字・［整理］（A-125）・畳む（道具の段を畳んでもこの段は見えたまま）。
           ［整理］は字ではなくアイコン（trash）にした: 右の列の幅 220 で、長い見出し（es「Color (color completo)」など）と字のボタンが
           1 行に入らない（C-6・v215_ui の実測）。字（§5-3）は説明と読み上げの名前（aria-label）に入れる -->
      <div class="side-col" id="ed-side-col">
      <div class="side-sechead side-colhead">
        <h3 id="ed-colhead">${t("ed.color.head.palette.label")}</h3>
        <button class="minibtn" id="ed-pal-tidy" type="button">${iconHtml("trash")}</button>
        <button class="minibtn sfold" id="ed-sfold-col" type="button">${iconHtml("chev-down")}</button>
      </div>
      <div class="side-colbody" id="ed-side-colbody">
      <div class="pal pal-rows" id="ed-pal"></div>
      <div class="row" style="margin-top:2px">
        <span class="tog">${t("ed.color.fullcolor.label")}</span><div class="sw2" id="ed-fullcolor"></div>
        <input type="color" id="ed-colorpick" value="#141414" style="width:40px;height:28px;border:3px solid var(--ink);border-radius:8px;padding:0;background:#fff" hidden />
      </div>
      <!-- ★V164 (U-3): よく使う色の棚。上の「色」帯（＝作品の colorTable 全色）とは**別物**で、
           こちらは**自分で登録した色だけ**・**設定に保存**（作品をまたいで残る道具箱）。
           フルカラーでは colorTable が際限なく増えて色見本の壁になるので、その逃げ場 -->
      <!-- ★V215: 見出しと［＋ いまの色］を 1 行に並べた（色の段の高さを詰めて、最小の窓でも道具の段を残す） -->
      <div class="side-favrow">
      <h3 id="ed-favhead">${t("ed.color.fav.head.label")}</h3>
      <div class="selacts" id="ed-favacts">
        <button class="minibtn" id="ed-fav-toggle">${t("ed.color.fav.add.btn")}</button>
      </div>
      </div>
      <div class="pal pal-rows" id="ed-favpal"></div>
      </div>
      </div>
      </div>
      <div class="ed-vsplit" id="ed-side-vsplit"></div>
      <div class="side-sec side-bot" id="ed-side-bot">
      <!-- 見出しにレイヤーの操作ボタンを寄せる（旧 h3 と二重に持たない＝**1行ぶん節約**して、
           狭い画面でもレイヤーが3行見えるようにする） -->
      <div class="side-sechead">
        <span>${t("ed.layer.head.label")}</span>
        <button class="minibtn" id="ed-layer-add">＋</button>
        <button class="minibtn" id="ed-folder-add">${iconHtml("folder")}</button>
        <button class="minibtn" id="ed-layer-del">${iconHtml("trash")}</button>
        <button class="minibtn" id="ed-layer-merge">${iconLabelHtml("merge-down", t("ed.layer.mergeDown.btn"))}</button>
        <button class="minibtn sfold" id="ed-sfold-bot" type="button">${iconHtml("chev-down")}</button>
      </div>
      <div class="side-secbody" id="ed-side-botbody">
      <div id="ed-layers"></div>
      <!-- M11-15: レイヤーのコピー＆ペースト（コマ1枚ぶん・レイヤー専用の控え） -->
      <div class="selacts" id="ed-layerclip">
        <button class="minibtn" id="ed-lc-copy">${iconLabelHtml("copy-to-layer", t("ed.layerclip.copy.btn"))}</button>
        <button class="minibtn" id="ed-lc-paste">${iconLabelHtml("clipboard", t("ed.layerclip.paste.btn"))}</button>
        <button class="minibtn" id="ed-lc-paste-over">${iconLabelHtml("clipboard", t("ed.layerclip.pasteOver.btn"))}</button>
        <button class="minibtn" id="ed-lc-paste-new">${iconLabelHtml("clipboard", t("ed.layerclip.pasteNew.btn"))}</button>
        <button class="minibtn" id="ed-lc-paste-all">${iconLabelHtml("clipboard", t("ed.layerclip.pasteAll.btn"))}</button>
      </div>
      </div>
      </div>
    `;
    // V158 (L-1): 段の畳みボタン（見出しは畳んでも残るので、そこから戻せる）。★V215: 色の段（col）も同じ形
    for (const which of ["top", "bot", "col"] as const) {
      const b = document.getElementById(`ed-sfold-${which}`);
      if (b) b.onclick = () => this.setSideFold(which, !this.sideFold[which]);
    }
    this.refreshSideFoldButtons();
    // ★V215 (A-125): ［整理］は押したらコアの手続きを呼ぶだけ（調べる・確かめる・消す・知らせるはコア）
    $("#ed-pal-tidy").addEventListener("click", () => void this.tidyPaletteColors());
    $("#ed-pal-tidy").setAttribute("aria-label", t("ed.color.tidy.btn"));
    // ★V215 (A-124): 帯とよく使う色の見える段数を、上段の高さ（窓・比率・畳み・幅）に合わせて決め直す
    this.colorRowsObs?.disconnect();
    this.colorRowsObs = null;
    if (typeof ResizeObserver !== "undefined") {
      this.colorRowsObs = new ResizeObserver(() => this.fitColorRows());
      this.colorRowsObs.observe($("#ed-side-top"));
    }
    for (const id of ["ed-pal", "ed-favpal"]) {
      const el = document.getElementById(id);
      el?.addEventListener("scroll", () => this.markColorRowsMore(el), { passive: true });
    }
    $("#ed-szhead").title = t("ed.size.head.title");
    // M14 (S-3): 「種類/トーン」ヘッダで一覧を開閉（閉じると現在の種類だけ1行表示）。状態は settings に記憶
    $("#ed-texhead").addEventListener("click", () => {
      this.toneOpen = !this.toneOpen;
      this.applyToneFold();
      this.cb.onToneOpenChange?.(this.toneOpen);
    });
    // R-2 案1: 属性はテンプレートに埋めず、組んだあとにプロパティで入れる
    //（訳文に " が入っても属性が割れない。DOM の形・表示は上のテンプレートのまま）
    for (const { sel, titleKey } of [
      // V158 (L-1): 上下の境界の説明も**組んだあとに**入れる（訳文に " が入っても属性が割れない）
      { sel: "#ed-side-vsplit", titleKey: "ed.side.split.title" },
      { sel: "#ed-pal-tidy", titleKey: "ed.color.tidy.title" }, // ★V215 (A-125)
      { sel: "#ed-folder-add", titleKey: "ed.layer.folderAdd.title" },
      { sel: "#ed-layer-merge", titleKey: "ed.layer.mergeDown.title" },
      { sel: "#ed-lc-copy", titleKey: "ed.layerclip.copy.title" },
      { sel: "#ed-lc-paste", titleKey: "ed.layerclip.paste.title" },
      { sel: "#ed-lc-paste-over", titleKey: "ed.layerclip.pasteOver.title" },
      { sel: "#ed-lc-paste-new", titleKey: "ed.layerclip.pasteNew.title" },
      { sel: "#ed-lc-paste-all", titleKey: "ed.layerclip.pasteAll.title" },
      { sel: "#ed-lw-thicken", titleKey: "ed.linew.thicken.title" },
      { sel: "#ed-lw-thin", titleKey: "ed.linew.thin.title" },
    ] as const) {
      const el = host.querySelector(sel) as HTMLElement | null;
      if (el) el.title = t(titleKey);
    }
    // 太さ
    const sizes = $("#ed-sizes");
    for (const s of PEN_SIZES) {
      const d = document.createElement("button");
      d.className = "sz" + (s === this.penSize ? " on" : "");
      d.innerHTML = `<i style="width:${Math.min(18, s + 2)}px;height:${Math.min(18, s + 2)}px"></i>`;
      d.title = t("ed.pen.sizePick.title", { n: s });
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
    fc.addEventListener("click", async () => {
      // ★V214: 確かめる条件と切り替えはコアの toggleFullcolor（断ったら false）。ここは見た目だけ
      if (!(await this.toggleFullcolor())) return;
      fc.classList.toggle("on", this.project.colorMode === "fullcolor");
      $("#ed-colorpick").hidden = this.project.colorMode !== "fullcolor";
      $("#ed-colhead").textContent =
        this.project.colorMode === "fullcolor"
          ? t("ed.color.head.fullcolor.label")
          : t("ed.color.head.palette.label");
    });
    ($("#ed-colorpick") as HTMLInputElement).addEventListener("input", (e) => {
      this.selectColor((e.target as HTMLInputElement).value); // ★V214: 中身はコア
    });
    // レイヤー操作
    $("#ed-layer-add").addEventListener("click", () => this.addLayer());
    $("#ed-folder-add").addEventListener("click", () => this.addFolder());
    $("#ed-layer-del").addEventListener("click", () => void this.deleteLayer());
    // M11-15: レイヤーのコピー＆ペースト
    $("#ed-lc-copy").addEventListener("click", () => void this.copyLayerFrame());
    $("#ed-lc-paste").addEventListener("click", () => void this.pasteLayerFrame());
    $("#ed-lc-paste-over").addEventListener("click", () => void this.pasteLayerOverFrame());
    $("#ed-lc-paste-new").addEventListener("click", () => this.pasteLayerToNew());
    $("#ed-lc-paste-all").addEventListener("click", () => void this.pasteLayerAllFrames());
    this.updateLayerClipButtons();
    // M11-19: 線を太らせる／細らせる（ランチャー・コマンドと同じ実体）
    $("#ed-lw-thicken").addEventListener("click", () => this.morphActiveLayer("thicken"));
    $("#ed-lw-thin").addEventListener("click", () => this.morphActiveLayer("thin"));
    // M3.8: ▲▼はDnD（挿入線）で代替・撤去
    $("#ed-layer-merge").addEventListener("click", () => void this.mergeLayerDown());
    this.rebuildLayers();
    // オニオン（段数）
    const oni = $("#ed-onion");
    [t("ed.onion.off.btn"), "1", "2", "3"].forEach((label, lv) => {
      const d = document.createElement("button");
      d.className = "lv" + (lv === this.onionLevel ? " on" : "");
      d.textContent = label;
      d.addEventListener("click", () => {
        oni.querySelectorAll(".lv").forEach((e) => e.classList.remove("on"));
        d.classList.add("on");
        this.setOnionLevel(lv); // ★V214: 中身はコア
      });
      oni.appendChild(d);
    });
    // V164 (U-1): オニオンの向き。既存の `.oni`/`.lv` をそのまま使う（新しい CSS は足さない）。
    // ★文言は「前のコマ／次のコマ」＝タイムラインの ed.tl.prev/next.title と**同じ言葉**にした。
    //  「前だけ／後だけ」は「前へ向かって」とも読めて逆の意味に取れる（レビューの観点）
    const dirs = $("#ed-oniondir");
    for (const it of [
      { dir: "prev", labelKey: "ed.onion.dirPrev.btn", titleKey: "ed.onion.dirPrev.title" },
      { dir: "both", labelKey: "ed.onion.dirBoth.btn", titleKey: "ed.onion.dirBoth.title" },
      { dir: "next", labelKey: "ed.onion.dirNext.btn", titleKey: "ed.onion.dirNext.title" },
    ] as const) {
      const d = document.createElement("button");
      d.className = "lv" + (it.dir === this.onionDir ? " on" : "");
      d.textContent = t(it.labelKey);
      d.title = t(it.titleKey); // R-2: 属性はプロパティ代入（訳文に " が入っても割れない）
      d.addEventListener("click", () => {
        dirs.querySelectorAll(".lv").forEach((e) => e.classList.remove("on"));
        d.classList.add("on");
        this.setOnionDir(it.dir); // ★V214: 中身はコア
      });
      dirs.appendChild(d);
    }
    // V164 (U-3): よく使う色の棚
    $("#ed-favhead").title = t("ed.color.fav.head.title");
    $("#ed-fav-toggle").addEventListener("click", () => this.toggleFavoriteColor());
    this.rebuildFavPalette();
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
    this.updateSizeMeter(); // V154 (W-2): 組み直したら中身を入れる
  } // 384 MiB の 50%
  private audioPanelEl: HTMLElement | null = null;
  private audioPanelClose: (() => void) | null = null;
  /** M11-6: 波形（`#ap-wave`）のドラッグを畳む手（`audioPanelClose` と同じ流儀）。
   *  キャンバス側と同じく「接触が途切れたら畳む」を通すために外から呼べるようにする */
  private audioWaveEndDrag: (() => void) | null = null;

  /** A-2: 波形＋コマ目盛＋試し再生の大パネル。
   *  M5-1: BGM側は従来どおり作業コピー（適用までプロジェクトに触らない）。
   *  SE側（トラック・コマ配置）は**即時反映＋Undo履歴**（handoff §6 の規則）。 */
  private async openAudioPanel() {
    // V154b (W-9): **「保存中に音楽タブ触った」が報告の一節**。重い処理の最中は開かない
    if (this.busyKind) return;
    if (this.audioPanelEl) return;
    if (this.playing) this.stopPlayback();
    // ★V209 (A-121): 音の窓を開くと ⏸ した位置（何周目か）も捨てる（SE の続きも試し再生を止めるときに捨てる＝今と同じ）
    this.playPaused = null;
    this.playEnded = null;
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
    // ★V209 (A-121): コマは経過時間から決める（エディタの ▶・ライブラリと同じ時計 `PlayClock`）。BGM と SE は音の時計で予約する。
    //  鳴らし方は作業コピー w の「書き出す長さ」で決める（曲の長さの形は曲を最後まで流してアニメを繰り返し、曲の終わりで頭から）。
    //  試し再生は作品の「ループ」を見ずにいつも繰り返す（今と同じ）
    let trialClock: PlayClock | null = null;
    /** V209 (R-15): 試し再生の世代（音の用意を待つ間に押し直されたら、待っていた始め方は捨てる） */
    let trialGen = 0;
    /** V209: 音の用意を待っている間（ボタンは「止める」の見た目） */
    let trialStarting = false;
    /** V209: 待っている間の始め方が ⏸ からの続きなら、その位置（待つ間に止められたら戻す） */
    let trialPending: PlayPaused | null = null;
    let trialFrame = 0;
    // M6-4 P-5: 再生ヘッド（V209: 絵と同じ時計で動かす）
    let playheadRaf = 0;
    // M6-5 Q-2: 停止位置マーカー（次の再生開始・パネル閉でクリア）
    let stopMarkT: number | null = null;
    // M6-6 R-5: 一時停止位置（V209: 描き終わっていた所。null=一時停止中でない）
    let trialPaused: PlayPaused | null = null;
    const normTrim = () => {
      const dur = buffer?.duration ?? 0;
      const ts = Math.max(0, Math.min(w.trimStartMs / 1000, Math.max(0, dur - 0.05)));
      let te = w.trimEndMs != null ? Math.min(w.trimEndMs / 1000, dur) : dur;
      if (te <= ts) te = dur;
      return { ts, te };
    };
    /** M5-1（独立レビューの指摘#2）: 試し再生も速度連動 rate を適用（通常再生・書き出しと一致させる） */
    const trialRate = () => bgmPlaybackRate(proj.speedIndex, w.baseSpeedIndex);
    /** V209: 試し再生の BGM（窓で作業中の値。トリムを変えると、次に頭から鳴らすときから効く＝毎回読む） */
    const trialPlan = (): BgmPlan | null => {
      if (!buffer || w.muted) return null;
      const { ts, te } = normTrim();
      if (!(te > ts)) return null;
      return { buf: buffer, trimStart: ts, trimEnd: te, rate: trialRate(), volume: w.volume };
    };
    /** V209: 再生ヘッドの換算（ミュート中も動かす） */
    const headTrim = () => {
      const { ts, te } = normTrim();
      return { trimStart: ts, trimEnd: te, rate: trialRate() };
    };
    const trialActive = () => trialClock != null || trialStarting;
    const setTrialButton = (playing: boolean) => {
      const b = box.querySelector("#ap-trial") as HTMLButtonElement | null;
      if (b) setIconLabel(b, playing ? "stop" : "play", playing ? t("ed.audio.trial.stop.btn") : t("ed.audio.trial.play.btn")); // V171
    };
    const stopTrial = () => {
      trialGen++; // V209: 待っている始め方も捨てる
      trialStarting = false;
      trialPending = null;
      trialPaused = null; // R-5: 完全停止（再開位置は持ち越さない）
      const clock = trialClock;
      trialClock = null;
      if (clock) {
        // Q-2: どこまで聴いたか分かるよう、停止位置に薄いマーカーを残す
        stopMarkT = clock.songPos(headTrim());
        clock.stop();
        cancelAnimationFrame(playheadRaf);
        drawWave(); // ヘッドを消してマーカーを描く
      }
      self.audioPreview.stopBgm();
      self.audioPreview.stopSe(); // M11-1: 試し再生で発火したSEも止める
      setTrialButton(false);
    };
    /** V192 (R-5): 音の窓のプレビューの出す大きさ（枠・dpr が変わったら apFitWatch が捨てる） */
    let apFit: DisplayFit | null = null;
    const drawTrialFrame = () => {
      const cv = box.querySelector("#ap-mini") as HTMLCanvasElement | null;
      if (!cv) return;
      // V156 (P-1): 試し再生は音声パネル独自のループで、**エディタ本体と同じ Project 実体**の
      // 全コマを順に合成する。眠っているコマをそのまま渡すと `render.ts` の
      // `if (!lb) continue` で**エラーも出さずに白紙**が出る。起こしてから描き直す
      //（読みで起こすので、掃除が拾い直すときの費用はゼロ）
      const tf = proj.frames[trialFrame];
      if (self.sleepOn && tf && frameHasAsleep(tf)) {
        void wakeFrame(proj, tf, "read").then(() => {
          if (self.mounted && proj.frames[trialFrame] === tf) drawTrialFrame();
        });
        return;
      }
      // V192 (R-5): 枠（.ap-big）の実画素で——小さければ面積平均・大きければ整数倍（CSS で引き伸ばさない）
      if (!apFit) {
        const wrap = box.querySelector("#ap-mini-box");
        apFit = wrap ? fitFor(wrap) : null;
      }
      if (!apFit) return;
      presentFit(cv, rgbaOf(compositeFrame(proj, trialFrame)), W, H, apFit);
      // M11-19: 透明の紙は薄い市松（M11-16 のミニ・フィルムと同じ・データには触れない）
      cv.classList.toggle("paper-clear", proj.frames[trialFrame]?.paper === 0);
    };
    const startHeadRaf = () => {
      const tickHead = () => {
        if (!trialClock) return;
        drawWave();
        playheadRaf = requestAnimationFrame(tickHead);
      };
      playheadRaf = requestAnimationFrame(tickHead);
    };
    /** V209: 試し再生を t0（繰り返しの頭から・秒）から始める。音の用意（ensureAudioRunning・SE のデコード）を待ってから */
    const runTrial = async (t0: number, from: PlayPaused | null) => {
      const gen = ++trialGen;
      trialStarting = true;
      trialPending = from;
      setTrialButton(true);
      // M5-1: 試し再生でも配置SEをコマ発火（プロジェクトの生きた配置を参照）
      const se = self.usedSeTracks();
      if (trialPlan() || se.length > 0) {
        // V172 (G-2): interrupted（WebKit）も拾う。V209: SE だけでも待つ
        try {
          await ensureAudioRunning(getAudioCtx());
        } catch {
          /* 無音で続行 */
        }
        if (se.length > 0) await self.audioPreview.prepareSe(se);
      }
      if (gen !== trialGen || !self.audioPanelEl) return; // 待っている間に止められた・押し直された
      trialStarting = false;
      trialPending = null;
      const host: PlayHost = {
        shape: () => ({ fps, frameCount, loop: true }),
        show: (i) => {
          trialFrame = i;
          drawTrialFrame();
        },
        ended: () => stopTrial(),
        reshape: () => stopTrial(),
        seAt: (i) => {
          const a = proj.audio;
          const ids = proj.frames[i]?.se;
          if (!a || !ids) return [];
          const out: { buf: AudioBuffer; track: SeTrack }[] = [];
          for (const id of ids) {
            const tr = a.se.find((s) => s.id === id);
            const b = tr && !tr.muted ? self.audioPreview.seBuffer(tr) : undefined;
            if (tr && b) out.push({ buf: b, track: tr });
          }
          return out;
        },
        bgm: trialPlan,
      };
      const clock = new PlayClock(host, self.audioPreview);
      trialClock = clock;
      stopMarkT = null;
      const plan = trialPlan();
      clock.start({ t0, songMode: w.syncMode === "animToAudio" && !!plan, wantAudio: !!plan || se.length > 0, resume: !!from });
      startHeadRaf();
    };
    const startTrial = () => {
      stopTrial();
      stopMarkT = null; // Q-2: 再生開始で停止位置マーカーをクリア
      trialFrame = 0;
      drawTrialFrame();
      void runTrial(0, null);
    };
    // R-5: 一時停止（位置マーカーを残す）⇄ 同位置から再開。コマ位置(trialFrame)も維持する
    const pauseTrial = () => {
      if (trialStarting) {
        // V209 (R-15): 待っている間の ⏸ は、始める前のまま（続きの位置も戻す）
        trialGen++;
        trialStarting = false;
        trialPaused = trialPending;
        trialPending = null;
        setTrialButton(false);
        return;
      }
      const clock = trialClock;
      if (!clock) return;
      trialClock = null;
      trialGen++;
      // M11-1: 一時停止でSEも止める（本再生の⏸と同じ扱い）
      // M11-9: 止めるだけでなく「どこまで鳴ったか」を畳む＝再開で続きから鳴る
      // ★V209: 位置は描き終わっている所。表示をそのコマへ進めてから畳む（clock.pause の中）
      const p = clock.pause();
      trialPaused = p;
      cancelAnimationFrame(playheadRaf);
      stopMarkT = clock.songPos(headTrim(), p.t); // 一時停止中はQ-2マーカーと同じ見た目で位置を示す
      drawWave();
      setTrialButton(false);
    };
    const resumeTrial = () => {
      const p = trialPaused;
      if (trialActive() || !p) return;
      trialPaused = null;
      stopMarkT = null;
      drawTrialFrame();
      // M11-9: 一時停止で畳んだSEを続きから鳴らし、そのぶんは開始コマで重ねて鳴らさない（PlayClock が resumeSe を呼ぶ）
      const same = p.fps === fps && p.frameCount === frameCount && p.frame === trialFrame;
      void runTrial(same ? p.t : trialFrame / fps, same ? p : null);
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
          vd >= dur - 1e-9
            ? t("ed.audio.zoom.fit.label")
            : t("ed.audio.zoom.window.label", { sec: vd >= 10 ? vd.toFixed(0) : vd.toFixed(1) });
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
      ctx2.fillStyle = uiColorA("--ink-rgb", 0.12, "44, 38, 33");
      const tsX = Math.max(0, xOf(ts));
      const teX = Math.min(W2, xOf(te));
      if (tsX > 0) ctx2.fillRect(0, RULER_H, tsX, H2 - RULER_H);
      if (teX < W2) ctx2.fillRect(teX, RULER_H, W2 - teX, H2 - RULER_H);
      // 波形（1pxごとに min/max）
      const ch = buffer.getChannelData(0);
      const rate = buffer.sampleRate;
      const mid = RULER_H + (H2 - RULER_H) / 2;
      const amp = (H2 - RULER_H) / 2 - 2;
      ctx2.strokeStyle = uiColor("--blue", "#1fa2ff");
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
      ctx2.fillStyle = uiColor("--paper", "#fbefd6");
      ctx2.fillRect(0, 0, W2, RULER_H);
      // P-5: 試し再生中は現在コマをルーラー上でハイライト
      if (trialClock) {
        const fx0 = xOf(ts + trialFrame / fps);
        const fx1 = xOf(ts + (trialFrame + 1) / fps);
        if (fx1 > 0 && fx0 < W2) {
          ctx2.fillStyle = uiColorA("--orange-rgb", 0.4, "240, 122, 26");
          ctx2.fillRect(fx0, 0, fx1 - fx0, RULER_H);
        }
      }
      ctx2.strokeStyle = uiColor("--ink", "#2c2621");
      ctx2.fillStyle = uiColor("--ink", "#2c2621");
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
      handle(ts, uiColor("--orange", "#f07a1a"));
      if (w.trimEndMs != null || te < dur) handle(te, uiColor("--red", "#ff4b4b"));
      // 情報
      ctx2.fillStyle = uiColor("--ink-soft", "#7a6f60");
      ctx2.fillText(
        t("ed.audio.wave.info.label", {
          src: dur.toFixed(2),
          anim: (frameCount / fps).toFixed(2),
          count: frameCount,
          fps,
        }),
        6,
        H2 - 6
      );
      // Q-2: 停止位置マーカー（ヘッドと同色の半透明・非再生時のみ）
      if (stopMarkT != null && !trialClock) {
        const x = xOf(stopMarkT);
        if (x >= 0 && x <= W2) {
          ctx2.strokeStyle = uiColor("--playhead", "#e0218a") + "73";
          ctx2.lineWidth = 2;
          ctx2.beginPath();
          ctx2.moveTo(x + 0.5, 0);
          ctx2.lineTo(x + 0.5, H2);
          ctx2.stroke();
          ctx2.lineWidth = 1;
        }
      }
      // P-5: 再生ヘッド（トリム終端で止め、表示窓の外なら描かない）
      // M5-1: 経過実時間×rate=音源秒（速度連動と一致）。★V209 (A-121): 絵と同じ時計（聞こえている所）で動かす
      if (trialClock) {
        let t = trialClock.songPos(headTrim()) ?? ts;
        if (t > te) t = te;
        const x = xOf(t);
        if (x >= 0 && x <= W2) {
          ctx2.strokeStyle = uiColor("--playhead", "#e0218a");
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
      // M12-1b-2: この文字列は **innerHTML** へ入るので、ユーザーのデータ（音声ファイル名）は escHtml を通す。
      // 「差し替え」＋「・速度連動の基準」の連結もやめ、状態ごとの完全文にした（訳で語順を変えられる）
      const statusText =
        w.deleted || !w.bytes
          ? t("ed.audio.status.none.label")
          : w.source === "kwz"
            ? t("ed.audio.status.kwz.label", { fps: baseFps })
            : w.name
              ? t("ed.audio.status.replacedName.label", { name: escHtml(w.name), fps: baseFps })
              : t("ed.audio.status.replaced.label", { fps: baseFps });
      if (!w.bytes || w.deleted) {
        box.innerHTML = `
          <p class="modal-msg"><b>${iconHtml("audio")} ${t("ed.audio.panel.label")}</b>　${statusText}</p>
          <div class="modal-field">
            <button class="btn blue" id="ap-load">${iconLabelHtml("audio-file", t("ed.audio.load.btn"))}</button>
          </div>
          <div id="ap-se"></div>
          <div class="modal-actions">
            <span style="flex:1"></span>
            <button class="btn primary" id="ap-apply">${t("ed.audio.apply.btn")}</button>
            <button class="btn" id="ap-cancel">${t("common.cancel.btn")}</button>
          </div>`;
      } else {
        box.innerHTML = `
          <p class="modal-msg"><b>${iconHtml("audio")} ${t("ed.audio.panelEdit.label")}</b>　${statusText}</p>
          <!-- M5-5 T-1: 広幅レイアウト（プレビュー左＋SE右・波形は全幅が主役） -->
          <div class="ap-top">
            <div class="ap-big" id="ap-mini-box"><canvas id="ap-mini" width="0" height="0"></canvas></div>
            <div id="ap-se"></div>
          </div>
          <canvas id="ap-wave" width="1440" height="170" class="ap-wave"></canvas>
          <!-- M5-3 S-2: 高さは常時確保（出現/消滅でパネル寸法がガタつかないよう visibility で切替） -->
          <div class="ap-scroll" id="ap-scroll" style="visibility:hidden"><div></div></div>
          <div class="modal-field"><span>${t("ed.audio.zoom.label")}</span>
            <span id="ap-zoom"></span>
            <span id="ap-zoomv" style="font-weight:700;font-size:12px;width:86px">${t("ed.audio.zoom.fit.label")}</span>
            <button class="minibtn ok" id="ap-trial">${iconLabelHtml("play", t("ed.audio.trial.play.btn"))}</button>
          </div>
          <div class="modal-field">
            <span>${t("ed.audio.trimStart.label")}</span><input id="ap-start" type="number" min="0" step="0.001" style="width:100px"> ${t("ed.audio.trim.sec.label")}
            <span>${t("ed.audio.trimEnd.label")}</span><input id="ap-end" type="number" min="0" step="0.001" style="width:100px"> ${t("ed.audio.trim.sec.label")}
          </div>
          <div class="modal-field"><span>${t("ed.audio.volume.label")}</span>
            <span id="ap-vol"></span>
            <span id="ap-volv" style="font-weight:700;font-size:12px;width:44px">${Math.round(w.volume * 100)}%</span>
            <span class="tog">${t("ed.audio.mute.label")}</span><div class="sw2${w.muted ? " on" : ""}" id="ap-mute"></div>
          </div>
          <div class="modal-actions">
            <button class="minibtn" id="ap-load">${iconLabelHtml("audio-file", t("ed.audio.replace.btn"))}</button>
            <button class="minibtn" id="ap-del">${iconLabelHtml("trash", t("ed.audio.delete.btn"))}</button>
            <span style="flex:1"></span>
            <button class="btn primary" id="ap-apply">${t("ed.audio.apply.btn")}</button>
            <button class="btn" id="ap-cancel">${t("common.cancel.btn")}</button>
          </div>`;
      }
      // R-2 案1: 属性はテンプレートに埋めず、組んだあとにプロパティで入れる
      const endInput = box.querySelector("#ap-end") as HTMLInputElement | null;
      if (endInput) endInput.placeholder = t("ed.audio.trimEnd.placeholder");
      // V192 (R-5): 枠（.ap-big）は div・中の canvas は実画素で描く。案内とクリックは枠に（縁の余白を押しても効く）
      const miniCv = box.querySelector("#ap-mini-box") as HTMLElement | null;
      if (miniCv) miniCv.title = t("ed.audio.preview.title");
      apFit = null;
      self.apFitWatch?.();
      // 閉じたあと（音声の読み込みの最中に閉じた等）に組み立て直しが走っても、見張りを残さない
      self.apFitWatch = miniCv && self.audioPanelEl === back ? watchFit(miniCv, () => ((apFit = null), drawTrialFrame())) : null;
      bind();
      renderSeSection();
      syncInputs();
      syncZoomUI();
      drawTrialFrame();
    };

    const bind = () => {
      box.querySelector("#ap-load")?.addEventListener("click", async () => {
        // V154b (W-7): 読み込み中の再入を止める（動画からの抽出は数十秒かかることがある）
        if (self.busyKind) return;
        const sel = await self.cb.pickAudioFile(); // V172: ダイアログだけ（読まない）
        if (!sel) return;
        // V172 (G-1b・件 1): ダイアログを閉じた**直後**から入口を閉じ（W-7/W-9）、
        // 読む→デコードを `runWithBusy` 1 本で覆う（箱は 1 枚・遅延は既定の 450ms）。
        // 以前は読み終わってから beginBusy していたので、Mac では読んでいる間「固まった」に見えた。
        // 表示は runWithBusy に任せ、beginBusy は入口の閉鎖だけ（showBusyAfterDelay は使わない＝二重にならない）
        self.beginBusy("audio");
        let done = false;
        try {
          await runWithBusy("audio.load", t("ed.busy.audio.label"), async () => {
            const picked = await self.cb.readAudioFile(sel);
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
            done = true;
            // V154b (W-8): 波形にするデコードは長い曲で数秒かかる。同じ箱の中で続ける（W-9: その間は編集を受け付けない）
            try {
              buffer = await decodeAudio(w.bytes);
            } catch {
              self.cb.toast(t("ed.audio.decodeFailed.toast"));
            }
          });
        } finally {
          self.endBusy();
        }
        if (done) render();
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
        if (w.muted) self.audioPreview.stopBgm(); // V209: 予約した BGM ごと（次の頭出しはミュートを読んで鳴らさない）
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
            if (trialClock) self.audioPreview.setBgmVolume(w.volume); // V209: 予約した BGM のノードにも
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
        if (trialActive()) stopTrial();
        else startTrial(); // 一時停止中でもボタンは頭出しから（クリック再開はプレビュー側）
      });
      // R-5: 大プレビューのクリックで再生⇄一時停止（再開は同位置から）
      box.querySelector("#ap-mini-box")?.addEventListener("click", () => {
        if (trialActive()) pauseTrial();
        else if (trialPaused != null) resumeTrial();
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
            self.cb.toast(t("ed.audio.trimEndInvalid.toast"));
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
        // V181: Mac は ⌘＋スクロールでも（`primaryMod`）。トラックパッドのピンチが ctrlKey のホイールで来るなら今までどおり
        cv.addEventListener(
          "wheel",
          (e) => {
            if (!buffer) return;
            e.preventDefault();
            const { v0, vd } = view();
            if (primaryMod(e)) {
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
        self.updateSizeMeter(); // V154 (W-2 ③): BGM のバイト列もメモリに載る
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
      head.innerHTML = `<b>${t("ed.audio.se.head.label")}</b><span class="hintline">${
        selFrames.length > 1
          ? t("ed.audio.se.targetRange.hint", {
              from: selFrames[0] + 1,
              to: selFrames[selFrames.length - 1] + 1,
              count: selFrames.length,
            })
          : t("ed.audio.se.target.hint", { frame: self.frameIndex + 1 })
      }</span>`;
      host.appendChild(head);
      const mkRow = (se1: SeTrack) => {
        const row = document.createElement("div");
        row.className = "ap-se-row";
        const nm = document.createElement("span");
        nm.className = "nm";
        setIconLabel(nm, "audio", se1.name); // V171: ♪ → audio
        nm.title = t("ed.audio.se.rename.title");
        nm.addEventListener("dblclick", async () => {
          const v = await self.cb.prompt(t("ed.audio.se.rename.msg"), se1.name);
          if (v) self.renameSeTrack(se1.id, v);
        });
        let volBefore: number | null = null;
        const vol = createSlider({
          min: 0,
          max: 100,
          value: Math.round(se1.volume * 100),
          className: "lay-op",
          title: t("ed.audio.se.volume.title"),
          onDown: () => (volBefore = se1.volume),
          onInput: (v) => {
            se1.volume = v / 100;
            self.dirty = true;
          },
          onChange: () => {
            if (volBefore != null && volBefore !== se1.volume)
              self.pushSeVolumeHistory(se1.id, volBefore, se1.volume);
            volBefore = null;
          },
        });
        const mute = document.createElement("div");
        mute.className = "sw2" + (se1.muted ? " on" : "");
        mute.title = t("ed.audio.se.mute.title");
        mute.addEventListener("click", () => self.toggleSeMute(se1.id));
        const listen = document.createElement("button");
        listen.className = "minibtn";
        listen.replaceChildren(icon("listen")); // V171
        listen.title = t("ed.audio.se.listen.title");
        listen.addEventListener("click", () => self.audioPreview.fireSe(se1));
        const place = document.createElement("button");
        const placedAll =
          selFrames.length > 0 && selFrames.every((i) => proj.frames[i]?.se?.includes(se1.id));
        place.className = "minibtn" + (placedAll ? " ok" : "");
        setIconLabel(place, "se-place", placedAll ? t("ed.audio.se.placeActive.btn") : t("ed.audio.se.place.btn")); // V171: 🎯 → se-place
        place.title =
          t("ed.audio.se.place.title");
        place.addEventListener("click", () => self.toggleSePlacement(se1.id, selFrames));
        const del = document.createElement("button");
        del.className = "minibtn";
        del.replaceChildren(icon("trash")); // V171
        del.title = t("ed.audio.se.delete.title");
        del.addEventListener("click", () => self.deleteSeTrack(se1.id));
        row.append(nm, vol.root, mute, listen, place, del);
        return row;
      };
      for (const t of se) host.appendChild(mkRow(t));
      // 既定4行分の空きを見せる（うごメモ準拠の見た目・追加は無制限）
      for (let i = se.length; i < 4; i++) {
        const empty = document.createElement("div");
        empty.className = "ap-se-row empty";
        empty.innerHTML = `<span class="nm">${t("ed.audio.se.empty.label")}</span>`;
        const add = document.createElement("button");
        add.className = "minibtn";
        add.textContent = t("ed.audio.se.addEmpty.btn");
        add.addEventListener("click", () => void addSe());
        empty.appendChild(add);
        host.appendChild(empty);
      }
      const addRow = document.createElement("div");
      addRow.className = "ap-se-add";
      const addBtn = document.createElement("button");
      addBtn.className = "minibtn ok";
      addBtn.textContent = t("ed.audio.se.add.btn");
      addBtn.addEventListener("click", () => void addSe());
      addRow.appendChild(addBtn);
      host.appendChild(addRow);
    };
    const addSe = async () => {
      if (self.busyKind) return; // V154b (W-7)
      const sel = await self.cb.pickAudioFile(); // V172: ダイアログだけ（読まない）
      if (!sel) return;
      // V172 (G-1b): ダイアログを閉じた直後から入口を閉じ、読み→追加を箱 1 枚で（BGM 読み込みと同じ形）
      self.beginBusy("audio");
      try {
        await runWithBusy("audio.load", t("ed.busy.audio.label"), async () => {
          const picked = await self.cb.readAudioFile(sel);
          if (!picked) return;
          self.addSeTrack(picked);
        });
      } finally {
        self.endBusy();
      }
    };
    // パネルが開いている間、SE操作（Undo含む）でセクションを再描画する
    this.seSectionRefresh = renderSeSection;
    this.waveRedraw = drawWave; // V158 (C-3): 配色が変わったら描き直す

    const close = () => {
      stopTrial();
      this.apFitWatch?.(); // V192 (R-5)
      this.apFitWatch = null;
      this.seSectionRefresh = null;
      this.waveRedraw = null;
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
      // V154b (W-8): ここも長い曲では待たされる。同じ「読み込み中です」を出す
      this.beginBusy("audio");
      try {
        this.showBusyAfterDelay(t("ed.busy.audio.label"));
        buffer = await decodeAudio(w.bytes);
      } catch {
        this.cb.toast(t("ed.audio.waveDecodeFailed.toast"));
      } finally {
        this.endBusy();
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
          // V216b (A-134・C-29): 範囲の頭より前のコマの SE（曲が主でないとき、まだ鳴っているものを途中から鳴らす）
          preRangeSe: p.frames.slice(0, lo).map((f) => (f.se && f.se.length > 0 ? [...f.se] : undefined)),
        });
      },
    };
  }
  /** V158 (C-3): 音声パネルの波形を描き直す口（配色を切り替えたとき用）。
   *  パネルを開いていないときは null＝何もしない。 */
  private waveRedraw: (() => void) | null = null;

  /** V157 (D-2 / U-4): このコマだけの表示色の目印（コマの帯の細い帯）。付いていなければ null。
   *  「付けた本人が後から分からなくなる」を防ぐための目印（作者判断で採用）。
   *  色は付いているうちの1つを使う（複数レイヤーに付いていても行は1本＝混雑させない） */
  private filmColorMark(i: number): HTMLElement | null {
    const fcs = this.project.frames[i]?.layerColors;
    const first = fcs ? Object.values(fcs)[0] : undefined;
    if (!first) return null;
    const bar = document.createElement("i");
    bar.className = "fc-mark";
    bar.style.background = first;
    bar.title = t("ed.frameColor.mark.title", { n: Object.keys(fcs!).length });
    return bar;
  }

  /** V205 (A-113): 1 コマだけ、コマの帯の色の目印を今の色に直す（帯を作り直さない＝1 コマの上書きの貼り付けと、その取り消し・やり直し） */
  protected override updateFilmColorMark(i: number) {
    document.querySelectorAll(`#ed-film .fr[data-idx="${i}"]`).forEach((el) => {
      el.querySelector(".fc-mark")?.remove();
      const bar = this.filmColorMark(i);
      if (bar) el.appendChild(bar);
    });
  }

  /** フィルムの ♪ マーク（SE配置のあるコマ）を更新 */
  protected override updateFilmSeMarks() {
    document.querySelectorAll("#ed-film .fr").forEach((el) => {
      const i = Number((el as HTMLElement).dataset.idx);
      const has = !Number.isNaN(i) && !!this.project.frames[i]?.se?.length;
      el.classList.toggle("hasse", has);
    });
  }

  protected override rebuildPalette() {
    const pal = $("#ed-pal");
    pal.innerHTML = "";
    // ★V195 (A-99): 帯から消した色は空き番号（""）として残る＝帯には出さない。消したあと同じ色をまた使うと
    //  新しい番号で足されるので、取り消しで空きが戻ると同じ hex が 2 つの番号に並ぶことがある——帯には 1 つだけ出す
    //  （どちらを選んでも `ensureColor` は先の番号を使う＝描く結果は同じ）
    const shown = new Set<string>();
    const colors = this.project.colorTable.slice(1).filter((hex) => {
      if (!hex || shown.has(hex)) return false;
      shown.add(hex);
      return true;
    });
    colors.forEach((hex) => {
      const d = document.createElement("button");
      d.className = "sw" + (hex === this.colorHex ? " on" : "");
      d.style.background = hex;
      d.title = t("ed.color.swatch.title", { hex }); // V195 (A-99): 「右クリックで消す」を足した（今までは hex だけ）
      d.addEventListener("click", () => this.selectColor(hex)); // ★V214
      // V195 (A-99): 右クリック → 調べて → 確認 → 消す（マイ柄の右クリック削除 `deleteCustomTone` と同じ流儀）。
      //  透明と紙の色の列には付けない（消せない色）
      d.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.deletePaletteColor(hex);
      });
      pal.appendChild(d);
    });
    // 透明（＝消し色）
    const tp = document.createElement("button");
    tp.className = "sw tp" + (this.colorHex === "" ? " on" : "");
    tp.title = t("ed.color.transparent.title");
    tp.addEventListener("click", () => this.selectColor("")); // ★V214
    pal.appendChild(tp);
    // 紙色ボタン列。M11-14b: 既定パレットと同じうごメモ3Dの6色（白先頭＝既定紙色）。
    // 水色 #06aeff は #0038ce に置き換え（UGO_COLORS 定数そのものは不変）
    const pp = $("#ed-paperpal");
    pp.innerHTML = "";
    for (const hex of [
      UGO_COLORS.white,
      UGO_COLORS.black,
      UGO_COLORS.red,
      UGO3D_BLUE,
      UGO_COLORS.yellow,
      UGO_COLORS.green,
    ]) {
      const d = document.createElement("button");
      d.className = "sw sm";
      d.style.background = hex;
      d.title = t("ed.color.paper.swatch.title", { hex });
      d.addEventListener("click", () => this.setPaper(hex));
      pp.appendChild(d);
    }
    // M11-16: 透明の紙（paper=0）。パレットの透明ボタン `.sw.tp` と同じ見た目の流儀。
    // 用途は透過素材の書き出し（APNG・PNG連番）。編集画面では市松で表示する
    const ptp = document.createElement("button");
    ptp.className = "sw sm tp";
    ptp.title = t("ed.color.paper.transparent.title");
    ptp.addEventListener("click", () => this.setPaper(""));
    pp.appendChild(ptp);
    // V164 (U-3): よく使う色の棚も同じ瞬間に塗り直す（選択中の枠と登録ボタンの文言）。
    // 色の変更は必ずこの関数を通る＝棚の見た目が現在色と食い違うことがない
    this.rebuildFavPalette();
    // M11-12: 浮動テキストのプレビューは現在の色で描いているので、色が変わったら描き直す
    //（色の変更は必ずここを通る＝スポイト・カラーピッカー・パレット・透明のすべて）
    if (this.textDraft) this.redrawOverlay();
  }

  // ---------------- V164 (U-3): よく使う色の棚 ----------------



  /** 棚の描き直し（色見本＋登録ボタンの文言・有効/無効）。DOM が無い場面では何もしない */
  protected override rebuildFavPalette() {
    const pal = document.getElementById("ed-favpal");
    const btn = document.getElementById("ed-fav-toggle") as HTMLButtonElement | null;
    if (!pal || !btn) return;
    const now = this.favoriteHexNow();
    pal.innerHTML = "";
    for (const hex of this.favoriteColors) {
      const d = document.createElement("button");
      d.className = "sw" + (hex === now ? " on" : "");
      d.style.background = hex;
      d.title = t("ed.color.fav.swatch.title", { hex });
      d.addEventListener("click", () => this.selectColor(hex)); // ★V214: 上の帯と棚の両方が塗り直る（選択枠が2つ点くことはない）
      pal.appendChild(d);
    }
    const registered = now != null && this.favoriteColors.includes(now);
    btn.textContent = registered ? t("ed.color.fav.remove.btn") : t("ed.color.fav.add.btn");
    // 透明（消し色）は棚に入れられない。押せないことが見て分かるよう無効にし、理由は title に
    btn.disabled = now == null;
    btn.title = now == null ? t("ed.color.fav.needColor.title") : t("ed.color.fav.toggle.title");
    this.fitColorRows(); // ★V215 (A-124): 色の数が変わると要る段数が変わる（見た目だけ・作品には触らない）
  }

  // ---------------- V215 (A-124): 色の段の見える段数 ----------------

  /** 帯（#ed-pal）とよく使う色（#ed-favpal）の見える段数の上限（D-2: 帯は 3 段＝8 列で 24 色・棚は 2 段＝16 色） */
  private static readonly COLOR_ROWS_MAX = { pal: 3, fav: 2 } as const;
  /** 道具の段に少なくとも残す高さ（1 行ぶん・レイヤーの 1 行と同じ 34px）。これに下端のぼかし（見本 1 つぶん）を足して見る */
  private static readonly TOOLS_MIN_PX = 34;
  /** 上段の大きさを見張る（窓・比率・幅が変わったら段数を決め直す） */
  private colorRowsObs: ResizeObserver | null = null;

  /** ★V215 (A-124・REQ_color_section §2-1 の 3・5・6・7): 帯とよく使う色の見える段数を決める（CSS の `--rows`）。
   *  枠の高さは行の高さちょうど（`.pal-rows`）で行ごとに吸い付く＝真ん中が切れた見本は止まった所では見えない（V197 と同じ性質）。
   *  まず両方 1 段（棚が空なら 0）を置き、上段に道具の段が 1 行ぶん（TOOLS_MIN_PX＋ぼかし）残る範囲で、帯を 3 段まで・棚を 2 段まで増やす。
   *  1 段ずつでも道具の段が残らない（窓が低い・上段の比率が小さい）ときは 1 段のまま（残らない形＝tight は報告書の数）。
   *  色の段を畳んでいるとき・画面に出ていないときは何もしない（ひらいたときに applyLayout から呼ぶ） */
  private fitColorRows() {
    if (!this.mounted || this.sideFold.col) return;
    const top = document.getElementById("ed-side-top");
    const col = document.getElementById("ed-side-col");
    const body = document.getElementById("ed-side-topbody");
    const pal = document.getElementById("ed-pal");
    const fav = document.getElementById("ed-favpal");
    if (!top || !col || !body || !pal || !fav) return;
    const topH = top.getBoundingClientRect().height;
    if (!(topH > 0) || !(col.clientWidth > 0)) return;
    const cs = getComputedStyle(top);
    const cols = Number(cs.getPropertyValue("--pal-cols")) || 8;
    const gap = parseFloat(cs.getPropertyValue("--pal-gap")) || 5;
    const secGap = parseFloat(cs.rowGap) || 0;
    const ccs = getComputedStyle(col);
    const cw = col.clientWidth - (parseFloat(ccs.paddingLeft) || 0) - (parseFloat(ccs.paddingRight) || 0);
    const sw = (cw - (cols - 1) * gap) / cols;
    const rowsH = (k: number) => (k > 0 ? k * sw + (k - 1) * gap : 0);
    // 枠は上下 4px の余白と -4px の外側の余白で、置き場の高さには中身（行）のぶんだけ効く
    const boxH = (e: HTMLElement) => Math.max(0, e.getBoundingClientRect().height - 8);
    const head = top.firstElementChild as HTMLElement | null;
    const headH = head ? head.getBoundingClientRect().height : 0;
    const colOther = col.scrollHeight - boxH(pal) - boxH(fav);
    // 道具の段は、下端のぼかし（.side-fade・見本 1 つぶん）の上に 1 行ぶんが見えるだけ残す
    const avail = topH - headH - 2 * secGap - colOther - Editor.TOOLS_MIN_PX - sw;
    const needPal = Math.max(1, Math.ceil(pal.children.length / cols));
    const needFav = Math.ceil(fav.children.length / cols);
    let nPal = 1;
    let nFav = needFav > 0 ? 1 : 0;
    const fits = (a: number, b: number) => rowsH(a) + rowsH(b) <= avail + 0.5;
    while (nPal < Math.min(Editor.COLOR_ROWS_MAX.pal, needPal) && fits(nPal + 1, nFav)) nPal++;
    while (nFav < Math.min(Editor.COLOR_ROWS_MAX.fav, needFav) && fits(nPal, nFav + 1)) nFav++;
    pal.style.setProperty("--rows", String(nPal));
    fav.style.setProperty("--rows", String(Math.max(1, nFav)));
    this.markColorRowsMore(pal);
    this.markColorRowsMore(fav);
  }

  /** 枠の上・下に続きがあるかの印（スクロールバーは出さないので、端の線で知らせる） */
  private markColorRowsMore(el: HTMLElement) {
    el.classList.toggle("more-up", el.scrollTop > 1);
    el.classList.toggle("more-down", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }


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
    // V208 (A-120): 入る先のフォルダを薄く塗った行
    document
      .querySelectorAll("#ed-layers .lay-dropzone")
      .forEach((x) => x.classList.remove("lay-dropzone"));
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
    /** V208 (A-120): ゴーストの 2 行目（入る先） */
    ghostDest: HTMLElement | null;
    target: RowDropPlan | null;
    hoverFolder: string | null;
    hoverTimer: number | null;
    onMove: (e: PointerEvent) => void;
    onUp: (e: PointerEvent) => void;
    /** V208 (A-120): 最後のポインタの位置（一覧を流している間に入る先を測り直す） */
    lastX: number;
    lastY: number;
    /** V208 (A-120): 端で流している requestAnimationFrame（流していなければ null） */
    scrollRaf: number | null;
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
      ghostDest: null,
      target: null,
      hoverFolder: null,
      hoverTimer: null,
      onMove,
      onUp,
      lastX: e.clientX,
      lastY: e.clientY,
      scrollRaf: null,
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
      if (this.grabRowForDrag(d.id, d.kind)) {
        // ★V214: 選びを替えるのはコアの grabRowForDrag（選択の外の行から掴んだとき）。ここは行の見た目だけ
        this.displayRows.forEach((r) => {
          r.el.classList.toggle("sel", this.selectedNodeIds.has(r.id));
          if (r.kind === "layer") r.el.classList.toggle("active", r.id === this.activeLayerId);
        });
        // M11-19: ここは rebuildLayers を通らずに activeLayerId が変わる唯一の経路なので、
        // 貼り付けボタンの貼り先名もここで追従させる（移動が成立すればあとで rebuildLayers がもう一度呼ぶ＝無害）
        this.updateLayerClipButtons();
      }
      const order = this.displayRows.map((r) => r.id);
      this.dragNodes = topNodesOf(this.project, [...this.selectedNodeIds]).sort(
        (a, b) => order.indexOf(a) - order.indexOf(b)
      );
      // ゴースト（掴んでいる中身の表示）
      const g = document.createElement("div");
      g.className = "drag-ghost lay-drag-ghost";
      const name =
        d.kind === "folder"
          ? (this.folderById(d.id)?.name ?? "")
          : this.project.layerDefs.find((l) => l.id === d.id)?.name ?? "";
      const n = this.dragNodes.length;
      // V208 (A-120): 1 行目（掴んでいる物）と 2 行目（入る先）を子の要素に分ける。フィルムのコマ・ライブラリのカードの
      // ゴースト（同じ .drag-ghost）は変えない
      const head = document.createElement("div");
      head.className = "lay-drag-ghost-head";
      // textContent なので escHtml は通さない（レイヤー名・フォルダ名はユーザーのデータ）
      head.textContent = n > 1 ? t("ed.layer.dragGhostMulti.label", { name, count: n - 1 }) : name;
      if (d.kind === "folder") head.prepend(icon("folder")); // V171: 📁 → folder（文字の前に SVG）
      const dest = document.createElement("div");
      dest.className = "lay-drag-ghost-dest";
      dest.hidden = true;
      g.append(head, dest);
      document.body.appendChild(g);
      d.ghost = g;
      d.ghostDest = dest;
    }
    if (d.ghost) {
      d.ghost.style.left = `${ev.clientX + 14}px`;
      d.ghost.style.top = `${ev.clientY + 16}px`;
    }
    d.lastX = ev.clientX;
    d.lastY = ev.clientY;
    this.refreshRowDragTarget();
    this.updateRowDragScroll(); // V208 (A-120): 一覧の端で流す
  }

  /** V208 (A-120): 今のポインタの位置で入る先を測り直して見せる（ポインタが動いたときと、一覧が流れたとき） */
  private refreshRowDragTarget() {
    const d = this.rowDrag;
    if (!d || !d.active) return;
    const plan = this.hitTestRowDrag(d.lastX, d.lastY);
    d.target = plan;
    if (!plan) {
      this.clearDndUi();
      d.ghost?.classList.add("invalid");
      if (d.ghostDest) d.ghostDest.hidden = true;
      this.setDragHoverFolder(null);
      return;
    }
    d.ghost?.classList.remove("invalid");
    this.showRowIndicator(plan); // 入る先の段の字下げで線を引く・入る先のフォルダを塗る
    if (d.ghostDest) this.fillDropLabel(d.ghostDest, plan);
    // 折りたたみフォルダに1秒ホバーで自動展開（中の一番下へ＝フォルダの行の下半分のときだけ）
    const hoverId =
      plan.view.kind === "into" && plan.folder && this.folderById(plan.folder)?.collapsed ? plan.folder : null;
    this.setDragHoverFolder(hoverId);
  }

  /**
   * V208 (A-120): ゴーストの 2 行目に入る先を出す。フォルダの名前（利用者のデータ）は textContent で入れ、
   * 名前の所だけを省略記号で切る（ja は名前が先なので、全体を切ると「の中の一番下へ」の方が消える）
   */
  private fillDropLabel(el: HTMLElement, plan: RowDropPlan) {
    const MARK = "\u2063\u2063";
    const text =
      plan.label === "out"
        ? t("ed.layer.dropOut.label")
        : plan.label === "inEnd"
          ? t("ed.layer.dropInEnd.label", { name: MARK })
          : t("ed.layer.dropIn.label", { name: MARK });
    const at = text.indexOf(MARK);
    const parts: HTMLElement[] = [];
    const span = (cls: string, s: string) => {
      const x = document.createElement("span");
      x.className = cls;
      x.textContent = s;
      parts.push(x);
    };
    if (at < 0) span("lay-drag-ghost-fix", text);
    else {
      if (at > 0) span("lay-drag-ghost-fix", text.slice(0, at));
      span("lay-drag-ghost-name", this.folderById(plan.folder)?.name ?? "");
      if (at + MARK.length < text.length) span("lay-drag-ghost-fix", text.slice(at + MARK.length));
    }
    el.replaceChildren(...parts);
    el.hidden = false;
  }

  /** V208 (A-120): 一覧の端で流す（requestAnimationFrame・流れている間も入る先を測り直す・ドラッグが終わると止まる） */
  private updateRowDragScroll() {
    const d = this.rowDrag;
    if (!d || !d.active || d.scrollRaf != null || typeof requestAnimationFrame !== "function") return;
    const tick = () => {
      const dd = this.rowDrag;
      if (!dd || dd !== d) return;
      dd.scrollRaf = null;
      const box = document.querySelector("#ed-side-botbody") as HTMLElement | null;
      if (!box) return;
      const br = box.getBoundingClientRect();
      const step = dragScrollStep(dd.lastY, br.top, br.bottom);
      if (step === 0) return;
      const before = box.scrollTop;
      box.scrollTop = before + step;
      if (box.scrollTop !== before) this.refreshRowDragTarget();
      dd.scrollRaf = requestAnimationFrame(tick);
    };
    d.scrollRaf = requestAnimationFrame(tick);
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
        if (this.rowDrag) this.openFolderForDrop(folderId); // ★V214: 開くのはコア（自前ドラッグなので再構築してもドラッグは継続できる）
      }, 1000);
    }
  }

  /**
   * 画面座標 → 入る先（null＝パネルの外・スクロールの枠の外・循環で不可）。
   * V208 (A-120): 上下の位置だけで決める（X は左右の範囲の確かめにだけ使う）。決め方は layerTree.ts の dropTargetAt。
   * 当たり判定はスクロールの枠（#ed-side-botbody）の中で見えている所だけ（隠れた行に当てない）。
   */
  private hitTestRowDrag(x: number, y: number): RowDropPlan | null {
    const host = document.querySelector("#ed-layers") as HTMLElement | null;
    const box = document.querySelector("#ed-side-botbody") as HTMLElement | null;
    const ids = this.dragNodes ?? [];
    if (!host || ids.length === 0) return null;
    const hr = host.getBoundingClientRect();
    if (x < hr.left - 12 || x > hr.right + 12) return null; // パネル外=ドロップなし（キャンセル）
    const br = box ? box.getBoundingClientRect() : hr;
    if (y < br.top || y > br.bottom) return null; // 枠の上端より上・下端より下＝入る先なし
    const rows = this.displayRows;
    let hit: RowDropHit = { kind: "end" }; // 最後の行より下の空き地（#ed-layerclip の上も）
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].el.getBoundingClientRect();
      if (y < r.top) {
        hit = { kind: "gap", index: i }; // 行間（マージン）の隙間 = この行の上
        break;
      }
      if (y <= r.bottom) {
        hit = { kind: "row", index: i, half: y - r.top < r.height / 2 ? "upper" : "lower" };
        break;
      }
    }
    return dropTargetAt(this.project, rows, hit, ids);
  }

  /** 入る先を見せる: 挿入線（入る先の段の字下げ）か、中の一番下へのフォルダの枠。入る先のフォルダは中身ごと薄く塗る */
  private showRowIndicator(plan: RowDropPlan) {
    this.clearDndUi();
    if (plan.folder) {
      for (const r of this.displayRows) {
        const chain = ancestorChain(this.project, r.kind === "folder" ? r.id : r.parent);
        if (chain.includes(plan.folder)) r.el.classList.add("lay-dropzone");
      }
    }
    if (!this.insLineEl) return;
    if (plan.view.kind === "into") {
      this.displayRows[plan.view.rowIdx]?.el.classList.add("droptarget");
      return;
    }
    this.insLineEl.style.marginLeft = `${plan.view.depth * 14}px`;
    // 挿入線: 落としたあとに掴んだ物が出る所（rows[gap] の上・末尾は最後の行の下）
    const gi = plan.view.gap;
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
    if (wasActive && !cancelled && target && ids) this.performTreeMove(ids, target.target);
  }

  /** ドラッグの後片付け（移動はしない）。Escや浮遊状態リセットからも呼ぶ */
  private cancelRowDrag() {
    const d = this.rowDrag;
    if (!d) return;
    window.removeEventListener("pointermove", d.onMove);
    window.removeEventListener("pointerup", d.onUp);
    window.removeEventListener("pointercancel", d.onUp);
    if (d.hoverTimer != null) clearTimeout(d.hoverTimer);
    if (d.scrollRaf != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(d.scrollRaf); // V208 (A-120)
    d.ghost?.remove();
    this.clearDndUi();
    this.rowDrag = null;
    this.dragNodes = null;
  }

  /** 行クリックの選択更新（click=単独 / Ctrl=トグル / Shift=表示リスト範囲） */
  private updateSelection(id: string, kind: "layer" | "folder", ev: MouseEvent) {
    // M3.9 H-2: ドラッグ直後に発火する click では選択を変えない
    if (this.suppressRowClick) {
      this.suppressRowClick = false;
      return;
    }
    // ★V214 (M-2b-1a): 選び方（単独・Ctrl／⌘でトグル・Shift で範囲・フォルダの選択）はコアの selectLayerRow。
    //  範囲は今の一覧の並び（displayRows）で決める
    this.selectLayerRow(
      id,
      kind,
      { ctrlOrMeta: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey, primary: primaryMod(ev) },
      this.displayRows.map((r) => r.id)
    );
  }

  protected override rebuildLayers() {
    const _t0 = perfNow();
    const host = $("#ed-layers");
    host.innerHTML = "";
    this.displayRows = [];
    super.rebuildLayers(); // ★V214: 選択の手入れ（pruneSelection）はコアの既定の中身（同じ位置で呼ぶ＝前と同じ）

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
      col.replaceChildren(icon(f.collapsed ? "chev-right" : "chev-down")); // V171
      col.title = t("ed.layer.folderCollapse.title");
      col.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleFolderCollapsed(f); // ★V214: 中身はコア
      });
      const eye = document.createElement("span");
      eye.className = "eye";
      eye.replaceChildren(icon(f.visible ? "eye" : "eye-off")); // V171: 状態ペア eye / eye-off
      eye.style.opacity = f.visible ? "1" : "0.35";
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleFolderVisible(f); // ★V214: 関所と中身はコア
      });
      const nm = document.createElement("span");
      nm.className = "nm";
      setIconLabel(nm, "folder", f.name); // V171: 📁 → folder
      nm.title = t("ed.layer.rename.title");
      nm.addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const v = await this.cb.prompt(t("ed.layer.folderName.msg"), f.name);
        this.renameFolder(f, v); // ★V214: 聞いた値を受け取るのはコア（空なら何もしない）
      });
      // M6-5 Q-1/Q-6: 共通スライダー部品（行DnDに乗っ取られない・端まで一致）
      let opBefore: number | null = null;
      const op = createSlider({
        min: 0,
        max: 100,
        value: Math.round(f.opacity * 100),
        className: "lay-op",
        title: t("ed.layer.folderOpacity.title"),
        onDown: () => (opBefore = f.opacity),
        onInput: (v) => this.setFolderOpacityLive(f, v), // ★V214: 中身はコア
        onChange: () => {
          this.commitFolderOpacity(f, opBefore); // ★V214: 履歴を積むのはコア（変わっていなければ積まない）
          opBefore = null;
        },
      });
      // V157 (D-1): フォルダの 🔒。押すと中身すべてが実効ロックになる
      const flk = document.createElement("span");
      const fLockedBySelf = f.locked === true;
      const fLockedByParent = ancestorLocked(this.project, f.parent);
      flk.className =
        "eye lay-lock" + (fLockedBySelf ? " on" : "") + (fLockedByParent ? " byparent" : "");
      // V157（独立レビュー §5）: **オフは 🔓**。閉じた鍵を薄く出すと
      // 「全部にロックが掛かっている」と一瞬読める（👁/🚫 と同じく字を変えて分ける）
      flk.replaceChildren(icon(fLockedBySelf || fLockedByParent ? "lock" : "unlock")); // V171: 状態ペア lock / unlock
      flk.style.opacity = fLockedBySelf ? "1" : fLockedByParent ? "0.25" : "0.35";
      flk.title = fLockedByParent
        ? t("ed.layer.lock.byFolder.title")
        : fLockedBySelf
          ? t("ed.layer.folderLock.on.title")
          : t("ed.layer.folderLock.off.title");
      flk.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleFolderLock(f.id);
      });
      const del = document.createElement("button");
      del.className = "minibtn";
      del.replaceChildren(icon("trash")); // V171
      del.title = t("ed.layer.folderDelete.title");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.deleteFolder(f.id);
      });
      row.appendChild(col);
      row.appendChild(eye);
      row.appendChild(flk);
      row.appendChild(nm);
      row.appendChild(op.root);
      row.appendChild(del);
      if (fLockedBySelf || fLockedByParent) row.classList.add("locked");
      row.addEventListener("click", (e) => {
        if (this.xformGuard()) return;
        this.updateSelection(f.id, "folder", e);
      });
      bindRowDnd(row, f.id, "folder");
      host.appendChild(row);
      this.displayRows.push({ kind: "folder", id: f.id, el: row, parent: f.parent, phys: -1 });
    };

    // M11-20: クリッピングの土台と実効可視（合成側 render.ts と**同じ関数**で解決＝UI と描画が食い違わない）
    const clipBases = clipBaseMap(this.project);
    const effStates = effectiveLayerStates(this.project);
    const nameOf = (id: string) => this.project.layerDefs.find((l) => l.id === id)?.name ?? "";

    // 上→下で表示（配列は下→上）。並びは layerTree.ts の layerDisplayRows が決める（V208 A-120・ドラッグの
    // 入る先の決め方と同じ並び）: 同一フォルダの子は連続配置の不変条件を前提に、各レイヤーの祖先チェーンに沿って
    // フォルダ見出しを挿入し、空のフォルダは親の中身の一番下に出す・たたんだフォルダの中は出さない
    for (const ent of layerDisplayRows(this.project)) {
      if (ent.kind === "folder") {
        const f = this.folderById(ent.id);
        if (f) makeFolderRow(f, ent.depth);
        continue;
      }
      const i = ent.phys;
      const ld = this.project.layerDefs[i];
      const depth = ent.depth;
      const clipOn = ld.clip === true;
      const baseId = clipOn ? (clipBases.get(ld.id) ?? null) : null;
      const baseShown = baseId ? (effStates.get(baseId)?.visible ?? true) : false;
      const row = document.createElement("div");
      row.className =
        "lay" +
        (ld.visible ? " on" : "") +
        (this.selectedNodeIds.has(ld.id) ? " sel" : "") +
        (ld.id === this.activeLayerId ? " active" : "") +
        (clipOn ? " clipped" : "");
      // clip 中の行は 12px 引っ込めて「土台にぶら下がっている」見た目（クリスタの左帯＋インデント）
      row.style.marginLeft = `${depth * 14 + (clipOn ? 12 : 0)}px`;
      // M11-20: クリッピングのトグル（👁 の右隣・クリスタの「下のレイヤーでクリッピング」）
      const cm = document.createElement("span");
      cm.className = "eye lay-clipmask" + (clipOn ? " on" : "") + (clipOn && !baseShown ? " nobase" : "");
      cm.textContent = "⤵";
      // M11-24: 仕組みの説明（データはそのまま・はみ出して描ける）は落とし、何が起きるかだけ残す
      cm.title = !clipOn
        ? t("ed.layer.clip.off.title")
        : !baseId
          ? t("ed.layer.clip.noBase.title")
          : !baseShown
            ? t("ed.layer.clip.baseHidden.title", { name: nameOf(baseId) })
            : t("ed.layer.clip.on.title", { name: nameOf(baseId) });
      cm.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.xformGuard()) return; // E-4
        this.toggleLayerClipping(ld.id);
      });
      const eye = document.createElement("span");
      eye.className = "eye";
      eye.replaceChildren(icon(ld.visible ? "eye" : "eye-off")); // V171: 状態ペア eye / eye-off
      eye.style.opacity = ld.visible ? "1" : "0.35";
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleLayerVisible(ld); // ★V214: 関所と中身はコア
      });
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = ld.name;
      nm.title = t("ed.layer.rename.title");
      nm.addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const v = await this.cb.prompt(t("ed.layer.name.msg"), ld.name);
        this.renameLayer(ld, v); // ★V214: 聞いた値を受け取るのはコア（空なら何もしない）
      });
      // M6-5 Q-1/Q-6: 共通スライダー部品（行DnDに乗っ取られない・端まで一致）
      const op = createSlider({
        min: 10,
        max: 100,
        value: Math.round(ld.opacity * 100),
        className: "lay-op",
        title: t("ed.layer.opacity.title"),
        onInput: (v) => this.setLayerOpacityLive(ld, v), // ★V214: 中身はコア
      });
      // M15 (K-1): 📌 全コマ共通トグル（クリップの隣）。フォルダには付けない＝レイヤー行だけ
      const pin = document.createElement("span");
      pin.className = "eye lay-shared" + (ld.shared === true ? " on" : "");
      pin.replaceChildren(icon("pin")); // V171
      pin.style.opacity = ld.shared === true ? "1" : "0.35";
      pin.title = ld.shared === true ? t("ed.layer.shared.on.title") : t("ed.layer.shared.off.title");
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.xformGuard()) return;
        void this.toggleLayerShared(ld.id);
      });
      // V157 (D-1): レイヤーの 🔒（📌 の右）。親フォルダが🔒のときは**押せない**（グレー）——
      // 押せてしまうと「解除したのに描けない」が起きる（要件の継承ルール）
      const lockedBySelf = ld.locked === true;
      const lockedByParent = ancestorLocked(this.project, ld.parent);
      const lk = document.createElement("span");
      lk.className =
        "eye lay-lock" + (lockedBySelf ? " on" : "") + (lockedByParent ? " byparent" : "");
      // V157（独立レビュー §5）: オフは 🔓（上のフォルダ行と同じ理由）
      lk.replaceChildren(icon(lockedBySelf || lockedByParent ? "lock" : "unlock")); // V171: 状態ペア lock / unlock
      lk.style.opacity = lockedBySelf ? "1" : lockedByParent ? "0.25" : "0.35";
      lk.title = lockedByParent
        ? t("ed.layer.lock.byFolder.title")
        : lockedBySelf
          ? t("ed.layer.lock.on.title")
          : t("ed.layer.lock.off.title");
      lk.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleLayerLock(ld.id);
      });
      // M15 (K-2): レイヤーカラーの色チップ（不透明度スライダーの右）。未設定＝枠だけ
      const chip = document.createElement("span");
      chip.className = "lay-colorchip" + (ld.displayColor ? " on" : "");
      if (ld.displayColor) chip.style.background = ld.displayColor;
      // V157（独立レビュー §2）: 押すと**適用先を選ぶダイアログ**が開く。
      // 「解除」「表示」と書くと、押した瞬間に効くように読める（画面と実際の食い違い）
      chip.title = ld.displayColor
        ? t("ed.layer.displayColor.on.title", { color: ld.displayColor })
        : t("ed.layer.displayColor.off.title");
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.chooseLayerColorScope(ld.id); // V157 (D-2): 適用先を選ばせる
      });
      row.appendChild(eye);
      row.appendChild(cm);
      row.appendChild(pin);
      row.appendChild(lk);
      row.appendChild(nm);
      row.appendChild(op.root);
      row.appendChild(chip);
      // V157 (D-1): 行そのものに印を付ける。**👁オフ（アイコンが薄くなるだけ）と見分ける**ため、
      // ロックは行の左に帯を出す（独立レビューの観点「👁オフと取り違えないか」）
      if (lockedBySelf || lockedByParent) row.classList.add("locked");
      row.addEventListener("click", (e) => {
        if (this.xformGuard()) return; // E-4: 変形対象レイヤーの切替を防ぐ
        this.updateSelection(ld.id, "layer", e);
      });
      bindRowDnd(row, ld.id, "layer");
      host.appendChild(row);
      this.displayRows.push({ kind: "layer", id: ld.id, el: row, parent: ld.parent, phys: i });
    }
    // M11-19: 貼り付けボタンの「貼り先」表示をアクティブレイヤーに追従させる（レイヤー選択・改名・追加削除は
    // すべてここを通る。例外は行ドラッグ確定時の updateRowDrag＝あちらでも呼ぶ）
    this.updateLayerClipButtons();
    perfDone("layers.rebuild", _t0);
  }

  // ================= M14 (S-1): ツール形式の単一ソース =================
  // ツールごとの「形式（排他ボタン群）」定義はここ**1箇所**。サイドパネルの #ed-toolopts と
  // 形式ストリップの両方がこれを読んで同じボタンを作る（受け入れ §7: grep で1箇所）。
  // active は組み立て時のスナップショット（形式が変わるたびに buildToolOptions / rebuildStrip で組み直す）。
  private toolFormatGroups(tool: Tool): FormatGroup[] {
    switch (tool) {
      case "fill":
        return [
          {
            key: "format", variant: "oni",
            items: [
              { id: "bucket", labelKey: "ed.fill.bucket.btn", icon: "fill", active: this.fillMode === "bucket",
                select: () => this.setFillMode("bucket") },
              { id: "enclose", labelKey: "ed.fill.enclose.btn", icon: "fill-enclose", active: this.fillMode === "enclose",
                select: () => this.setFillMode("enclose") },
            ],
          },
          {
            key: "ref", labelKey: "ed.fill.ref.label", variant: "oni",
            items: [
              { id: "self", labelKey: "ed.fill.refSelf.btn", active: !this.fillRefAll,
                select: () => this.setFillRefAll(false) },
              { id: "all", labelKey: "ed.fill.refAll.btn", titleKey: "ed.fill.refAll.title", active: this.fillRefAll,
                select: () => this.setFillRefAll(true) },
            ],
          },
        ];
      case "shape":
        // ★i18n キーは静的リテラルで持つ（テンプレート合成すると検査の未使用判定に引っかかる・M12 の教訓）
        return [
          {
            key: "kind", variant: "oni",
            items: [
              { id: "line", labelKey: "ed.shape.line.btn", active: this.shapeKind === "line",
                select: () => this.setShapeKind("line") },
              { id: "rect", labelKey: "ed.shape.rect.btn", icon: "shape-rect", active: this.shapeKind === "rect",
                select: () => this.setShapeKind("rect") },
              { id: "ellipse", labelKey: "ed.shape.ellipse.btn", icon: "shape-ellipse", active: this.shapeKind === "ellipse",
                select: () => this.setShapeKind("ellipse") },
            ],
          },
        ];
      case "warp":
        return [
          {
            key: "mode", variant: "oni", panelChunk: 2,
            items: [
              { id: "push", labelKey: "ed.warp.push.btn", icon: "warp-push", active: this.warpMode === "push",
                select: () => this.selectWarpMode("push") },
              { id: "bulge", labelKey: "ed.warp.bulge.btn", icon: "warp-bulge", active: this.warpMode === "bulge",
                select: () => this.selectWarpMode("bulge") },
              { id: "pinch", labelKey: "ed.warp.pinch.btn", icon: "warp-pinch", active: this.warpMode === "pinch",
                select: () => this.selectWarpMode("pinch") },
              { id: "corner", labelKey: "ed.warp.corner.btn", icon: "warp-corner", active: this.warpMode === "corner",
                select: () => this.selectWarpMode("corner") },
            ],
          },
        ];
      case "select":
        return [
          {
            key: "kind", variant: "oni",
            items: [
              { id: "rect", labelKey: "ed.sel.rect.btn", icon: "select", active: this.selectKind === "rect",
                select: () => this.setSelectKind("rect") },
              { id: "lasso", labelKey: "ed.sel.lasso.btn", icon: "select-lasso", active: this.selectKind === "lasso",
                select: () => this.setSelectKind("lasso") },
              { id: "auto", labelKey: "ed.sel.auto.btn", icon: "select-auto", active: this.selectKind === "auto",
                select: () => this.setSelectKind("auto") },
            ],
          },
          {
            key: "ref", labelKey: "ed.sel.ref.label", variant: "oni", visible: this.selectKind === "auto",
            items: [
              { id: "self", labelKey: "ed.sel.refSel.btn", active: !this.selectRefAll,
                select: () => this.setSelectRefAll(false) },
              { id: "all", labelKey: "ed.sel.refAll.btn", active: this.selectRefAll,
                select: () => this.setSelectRefAll(true) },
            ],
          },
          {
            // M17: 「柄として登録」（動作ボタン・押された表示は持たない）。単一ソースなのでパネルとストリップの両方に出る
            key: "register", variant: "oni",
            items: [
              { id: "register", labelKey: "ed.sel.registerTone.btn", active: false,
                select: () => { void this.registerCustomTone(); } },
            ],
          },
        ];
      case "pen":
      case "brush":
      case "eraser": {
        const cur = this.sizeByTool[this.sizeSlot(tool)];
        return [
          {
            key: "size", variant: "sizes",
            items: PEN_SIZES.map((s) => ({
              id: String(s), active: cur === s, titleKey: undefined,
              makeInner: (btn) => {
                const i = document.createElement("i");
                const px = Math.min(18, s + 2);
                i.style.width = `${px}px`;
                i.style.height = `${px}px`;
                btn.appendChild(i);
                btn.title = t("ed.pen.sizePick.title", { n: s });
              },
              select: () => this.pickPenSizeFormat(s),
            })),
          },
        ];
      }
      case "text":
        return [
          {
            key: "font", variant: "oni",
            items: FONTS.map((f) => ({
              id: f.key, labelKey: f.labelKey, active: this.textFamily === f.key,
              select: () => this.setTextFamily(f.key, "format"),
            })),
          },
        ];
      case "transform":
        return [
          {
            key: "flip", variant: "oni",
            items: [
              { id: "fliph", labelKey: "ed.xform.flipH.btn", icon: "flip-h", active: this.xform.flipH,
                select: () => this.toggleXformFlip("h") },
              { id: "flipv", labelKey: "ed.xform.flipV.btn", icon: "flip-v", active: this.xform.flipV,
                select: () => this.toggleXformFlip("v") },
            ],
          },
        ];
      default:
        // move / hand / eyedrop はストリップも形式も持たない
        return [];
    }
  }

  /** M14 (S-1): FormatItem 1つからボタンを作る（.lv=形式 / .sz=サイズ）。クリックの実処理は clickFor で差し替え可能
   *  （パネルは it.select 直呼び・ストリップは「必要なら setTool してから select」を挟む） */
  private makeFormatButton(
    it: FormatItem,
    cls: "lv" | "sz",
    clickFor: (it: FormatItem) => () => void
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = cls + (it.active ? " on" : "");
    b.dataset.fid = it.id;
    if (it.disabled) b.disabled = true;
    if (it.makeInner) it.makeInner(b);
    else if (it.labelKey && it.icon) setIconLabel(b, it.icon, t(it.labelKey)); // V171: アイコン＋文字
    else if (it.labelKey) b.textContent = t(it.labelKey);
    if (it.titleKey) b.title = t(it.titleKey);
    const run = clickFor(it);
    b.addEventListener("click", () => {
      if (b.disabled) return;
      run();
    });
    return b;
  }

  /** M14 (S-1): FormatGroup[] を DOM に起こす。ctx="panel" は従来の見た目（参照ラベル付き行・歪みは2段）、
   *  ctx="strip" は常に1行の横並び。clickFor で「押されたときの処理」を注入する（単一ソースの肝）。 */
  private renderFormatGroups(
    groups: FormatGroup[],
    ctx: "panel" | "strip",
    clickFor: (it: FormatItem) => () => void
  ): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      if (g.visible === false) continue;
      if (g.variant === "sizes") {
        const row = document.createElement("div");
        row.className = "sizes";
        for (const it of g.items) row.appendChild(this.makeFormatButton(it, "sz", clickFor));
        frag.appendChild(row);
        continue;
      }
      const chunk = ctx === "panel" && g.panelChunk ? g.panelChunk : g.items.length || 1;
      const rows: HTMLElement[] = [];
      for (let i = 0; i < g.items.length; i += chunk) {
        const oni = document.createElement("div");
        oni.className = "oni";
        if (rows.length > 0) oni.style.marginTop = "5px";
        for (const it of g.items.slice(i, i + chunk)) oni.appendChild(this.makeFormatButton(it, "lv", clickFor));
        rows.push(oni);
      }
      if (rows.length === 0) continue;
      if (g.labelKey && ctx === "panel") {
        // パネルでは「参照」等のラベルを左に添えた1行（従来の見た目）
        const row = document.createElement("div");
        row.className = "row";
        const lab = document.createElement("span");
        lab.className = "tog";
        lab.textContent = t(g.labelKey);
        row.appendChild(lab);
        rows[0].style.flex = "1";
        row.appendChild(rows[0]);
        frag.appendChild(row);
        for (let i = 1; i < rows.length; i++) frag.appendChild(rows[i]);
      } else {
        for (const r of rows) frag.appendChild(r);
      }
    }
    return frag;
  }

  /** M14 (S-1): 形式が変わったあとにパネルの #ed-toolopts と（開いていれば）ストリップを組み直す。
   *  select クロージャは this.tool が対象ツールに一致している前提（ストリップ側で先に setTool 済み）。 */
  protected override afterFormatChange() {
    this.buildToolOptions();
    if (this.stripOpenFor) this.rebuildStrip();
  }

  // ================= M14 (S-1): 形式ストリップ（ツールボタン横の一時オーバーレイ） =================
  /** そのツールに形式ストリップを出すか（＝形式定義が1つでもある）。
   *  画像・音声・複写・手のひら・スポイト・移動は toolFormatGroups が空なので false */
  private toolHasStrip(tool: Tool): boolean {
    return this.toolFormatGroups(tool).length > 0;
  }

  /** ツールボタンにホバー配線（150ms 遅延で開く・離れたら猶予後に畳む） */
  private attachToolStrip(btn: HTMLElement, tool: Tool) {
    btn.addEventListener("pointerenter", () => {
      if (this.stripCloseTimer !== null) {
        clearTimeout(this.stripCloseTimer);
        this.stripCloseTimer = null;
      }
      if (this.stripOpenTimer !== null) clearTimeout(this.stripOpenTimer);
      this.stripOpenTimer = window.setTimeout(() => {
        this.stripOpenTimer = null;
        this.openStrip(tool, btn);
      }, STRIP_HOVER_MS);
    });
    btn.addEventListener("pointerleave", () => {
      if (this.stripOpenTimer !== null) {
        clearTimeout(this.stripOpenTimer);
        this.stripOpenTimer = null;
      }
      this.scheduleStripClose();
    });
  }

  private scheduleStripClose() {
    if (this.stripCloseTimer !== null) clearTimeout(this.stripCloseTimer);
    this.stripCloseTimer = window.setTimeout(() => {
      this.stripCloseTimer = null;
      this.closeStrip();
    }, STRIP_CLOSE_MS);
  }

  /** 形式ストリップを開く（ツールボタンの右横）。**描画ストローク中は出さない**。 */
  private openStrip(tool: Tool, anchor: HTMLElement) {
    if (this.pointerDown) return; // ストローク中は出さない
    if (!this.toolHasStrip(tool)) {
      this.closeStrip();
      return;
    }
    this.stripOpenFor = tool;
    this.stripAnchor = anchor;
    this.renderStrip();
  }

  /** 形式変更後などに中身を組み直す（開いていなければ何もしない） */
  private rebuildStrip() {
    if (this.stripOpenFor && this.stripAnchor) this.renderStrip();
  }

  private renderStrip() {
    const tool = this.stripOpenFor;
    const anchor = this.stripAnchor;
    if (!tool || !anchor) return;
    if (!this.stripEl) {
      const el = document.createElement("div");
      el.className = "toolstrip";
      // ストリップの上にいる間は畳まない（ボタン→ストリップへ渡る隙間で消えないように）
      el.addEventListener("pointerenter", () => {
        if (this.stripCloseTimer !== null) {
          clearTimeout(this.stripCloseTimer);
          this.stripCloseTimer = null;
        }
      });
      el.addEventListener("pointerleave", () => this.scheduleStripClose());
      document.body.appendChild(el);
      this.stripEl = el;
    }
    const el = this.stripEl;
    el.innerHTML = "";
    // ストリップのクリック: 対象ツールでなければ先に切り替えてから形式を適用（select は this.tool 前提）
    const stripClick = (it: FormatItem) => () => {
      if (this.tool !== tool) this.setTool(tool);
      it.select();
    };
    el.appendChild(this.renderFormatGroups(this.toolFormatGroups(tool), "strip", stripClick));
    // 位置決め（ボタンの右横・画面内へクランプ）。measure のため一度隠して置く
    const r = anchor.getBoundingClientRect();
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    const ew = el.offsetWidth;
    const eh = el.offsetHeight;
    let left = r.right + 6;
    if (left + ew > window.innerWidth - 4) left = Math.max(4, r.left - ew - 6); // 右に入らなければ左へ
    let top = r.top;
    if (top + eh > window.innerHeight - 4) top = Math.max(4, window.innerHeight - 4 - eh);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  }

  private closeStrip() {
    if (this.stripOpenTimer !== null) {
      clearTimeout(this.stripOpenTimer);
      this.stripOpenTimer = null;
    }
    if (this.stripCloseTimer !== null) {
      clearTimeout(this.stripCloseTimer);
      this.stripCloseTimer = null;
    }
    if (this.stripEl) {
      this.stripEl.remove();
      this.stripEl = null;
    }
    this.stripOpenFor = null;
    this.stripAnchor = null;
  }

  protected override buildToolOptions() {
    const host = $("#ed-toolopts");
    host.innerHTML = "";
    // M14 (S-1): パネル側のクリックは it.select 直呼び（this.tool は既に対象ツール）
    const panelClick = (it: FormatItem) => it.select;
    if (this.tool === "fill") {
      // M14 (S-1): 形式（バケツ/囲い塗り）＋参照はツール形式の単一ソースから生成（ストリップと共通）
      host.innerHTML = `<h3>${t("ed.fill.head.label")}</h3>`;
      host.appendChild(this.renderFormatGroups(this.toolFormatGroups("fill"), "panel", panelClick));
    } else if (this.tool === "shape") {
      // M14 (S-1): 形式（直線/四角/丸）は単一ソースから。塗りつぶしトグルはこのツール固有の追加UI
      host.innerHTML = `<h3>${t("ed.shape.head.label")}</h3>`;
      host.appendChild(this.renderFormatGroups(this.toolFormatGroups("shape"), "panel", panelClick));
      const fillRow = document.createElement("div");
      fillRow.className = "row";
      fillRow.innerHTML = `<span class="tog">${t("ed.shape.fill.label")}</span><div class="sw2${this.shapeFill ? " on" : ""}" id="ed-shapefill"></div>`;
      host.appendChild(fillRow);
      $("#ed-shapefill").addEventListener("click", () => {
        this.shapeFill = !this.shapeFill;
        this.buildToolOptions();
      });
      // V158 (L-4): Shift で正円・正方形（**機能は前からある**）。使い方が画面のどこにも
      // 書いていなかったので、形式のすぐ下に1行だけ添える
      const hint = document.createElement("p");
      hint.className = "opt-hint";
      hint.textContent = t("ed.shape.shiftHint.hint");
      host.appendChild(hint);
    } else if (this.tool === "text") {
      // M10-1c: 書体 → サイズ（書体連動）→ 太さ の順。選択肢は fonts.ts のテーブルから組む
      const def = fontDef(this.textFamily);
      // M11-12: 浮動テキストがあるときだけ入力欄と確定/取消を使える状態にする
      const drafting = !!this.textDraft;
      host.innerHTML = `<h3>${t("ed.text.head.label")}</h3>
        <div class="row"><span class="tog">${t("ed.text.font.label")}</span>
          <select id="ed-textfont">${FONTS.map(
            (f) => `<option value="${f.key}"${f.key === this.textFamily ? " selected" : ""}>${t(f.labelKey)}</option>`
          ).join("")}</select></div>
        <div class="row"><span class="tog">${t("ed.text.size.label")}</span>
          <select id="ed-textsize">${def.sizes
            .map((s) => `<option value="${s}"${s === this.textSize ? " selected" : ""}>${s}px</option>`)
            .join("")}</select></div>
        ${
          // M10-15: 太字を持つ書体だけ行を出す（手ブレ補正と同型＝スイッチ右端寄せ）。
          // 太字なし書体では行ごと非表示（M10-1c の「薄く残す」設計は作者判断で廃止）
          def.hasBold
            ? `<div class="row"><span class="tog">${t("ed.text.bold.label")}</span>
          <div class="sw2${this.textBold ? " on" : ""}" id="ed-textbold"></div></div>`
            : ""
        }
        <div class="row"><span class="tog">${t("ed.text.dir.label")}</span>
          <div class="oni" style="flex:1" id="ed-textdir">
            <button type="button" class="lv${this.textVertical ? "" : " on"}" data-v="h">${t("ed.text.dirH.btn")}</button>
            <button type="button" class="lv${this.textVertical ? " on" : ""}" data-v="v">${t("ed.text.dirV.btn")}</button>
          </div></div>
        <textarea id="ed-textinput" class="tinput" rows="3" spellcheck="false"
          ${drafting ? "" : "disabled"}></textarea>
        <div class="selacts">
          <button class="minibtn ok" id="ed-text-ok"${drafting ? "" : " disabled"}>${iconLabelHtml("check", t("ed.common.commit.btn"))}</button>
          <button class="minibtn" id="ed-text-cancel"${drafting ? "" : " disabled"}>${iconLabelHtml("close", t("ed.text.cancel.btn"))}</button>
        </div>
        <p class="hintline" id="ed-text-hint">${
          drafting ? t("ed.text.draftingHint.hint") : t("ed.text.idleHint.hint")
        }</p>`;
      // R-2 案1: 属性はテンプレートに埋めず、組んだあとにプロパティで入れる
      //（訳文に " が入っても属性が割れない。DOM の形は上のテンプレートのまま＝見た目は不変）
      ($("#ed-textinput") as HTMLTextAreaElement).placeholder = drafting
        ? t("ed.text.input.placeholder")
        : t("ed.text.inputIdle.placeholder");
      $("#ed-text-hint").title = drafting ? t("ed.text.draftingHint.title") : t("ed.text.idleHint.title");
      // ★V214: 書体・大きさ・太字・縦書きの中身はコア（setTextFamily ほか）
      $("#ed-textfont").addEventListener("change", (e) => {
        this.setTextFamily((e.target as HTMLSelectElement).value as FontKey, "options");
      });
      $("#ed-textsize").addEventListener("change", (e) => {
        this.setTextSize(Number((e.target as HTMLSelectElement).value));
      });
      // M10-15: 行は hasBold の書体でしか描かない — 存在するときだけリスナを張る
      document.querySelector("#ed-textbold")?.addEventListener("click", () => {
        this.toggleTextBold();
      });
      // M10-11: 向き（横書き／縦書き）。既存の .oni + .lv だけで組む（新規CSSなし）
      host.querySelectorAll("#ed-textdir .lv").forEach((b) =>
        b.addEventListener("click", () => {
          const v = (b as HTMLElement).dataset.v === "v";
          this.setTextVertical(v);
        })
      );
      // M11-12: 複数行の入力欄。打つたびにプレビューを作り直す（間引きなし・実測で不要と判断）
      {
        const ta = $("#ed-textinput") as HTMLTextAreaElement;
        ta.value = this.textDraft?.text ?? "";
        ta.addEventListener("input", () => this.setTextDraftText(ta.value)); // ★V214: 中身はコア
        // Escape と Ctrl+Enter は**入力欄の中でも**効かせる。window 側の onKeyDown は
        // isTextEntry() で早期 return するので、ここで受けないとどちらも届かない。
        // それ以外（Enter=改行 / 矢印=カーソル移動 / P=「P」）はブラウザ既定のまま通す
        ta.addEventListener("keydown", (e) => {
          if (e.isComposing || e.keyCode === 229) return; // IME 変換中は触らない
          if (e.code === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.cancelTextDraft();
          } else if ((e.code === "Enter" || e.code === "NumpadEnter") && primaryMod(e)) {
            // V181: Mac は ⌘Enter でも確定（`primaryMod`＝Ctrl か、Mac なら ⌘ も）
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
      // M10-2c: 四隅は半径・強さが意味を持たない。行は残して disabled にする（消すとパネル高が跳ねる）
      const isCorner = this.warpMode === "corner";
      const warpHint = isCorner
        ? t("ed.warp.cornerHint.hint")
        : this.warpMode === "bulge"
          ? t("ed.warp.bulgeHint.hint")
          : this.warpMode === "pinch"
            ? t("ed.warp.pinchHint.hint")
            : t("ed.warp.pushHint.hint");
      host.innerHTML = `<h3>${t("ed.warp.head.label")}</h3>
        <div id="ed-warpmode"></div>
        <div class="row"><span class="tog">${t("ed.warp.radius.label")} <b id="ed-warpr-v">${this.warpRadius}</b>px</span><div id="ed-warpr" style="flex:1"></div></div>
        <div class="row"><span class="tog">${t("ed.warp.strength.label")} <b id="ed-warps-v">${this.warpStrength}</b>%</span><div id="ed-warps" style="flex:1"></div></div>
        <p class="hintline">${warpHint}</p>${
          isCorner
            ? `<div class="selacts">
        <button class="minibtn ok" id="ed-corner-ok">${iconLabelHtml("check", t("ed.common.commit.btn"))}</button>
        <button class="minibtn" id="ed-corner-cancel">${iconLabelHtml("close", t("ed.common.cancelMark.btn"))}</button>
      </div>`
            : ""
        }`;
      // M14 (S-1): 4形式（押す/ふくらませ/へこませ/四隅）は単一ソースから。
      // M11-2: 4つを1本の .oni に並べると幅が足りずはみ出すので、パネルは2個ずつ2段（panelChunk:2）
      $("#ed-warpmode").appendChild(this.renderFormatGroups(this.toolFormatGroups("warp"), "panel", panelClick));
      if (isCorner) {
        host
          .querySelector("#ed-corner-ok")
          ?.addEventListener("click", () => void this.commitCornerWarp());
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
      // M14 (S-1/S-4): 形式（矩形/自由/✨自動）＋参照は単一ソースから。範囲（つながり/全体）と
      // マスク表示・選択操作はこのツール固有の追加UI。「🪣 今の色で塗る」ボタンは廃止（塗りツールで代替）
      host.innerHTML = `<h3>${t("ed.sel.head.label")}</h3>
      <div id="ed-selformats"></div>
      ${
        this.selectKind === "auto"
          ? `<div class="row"><span class="tog">${t("ed.sel.scope.label")}</span><div class="oni" style="flex:1" id="ed-selscope">
          <button class="lv${this.selectAutoGlobal ? "" : " on"}" data-v="conn">${t("ed.sel.scopeConn.btn")}</button>
          <button class="lv${this.selectAutoGlobal ? " on" : ""}" data-v="global">${t("ed.sel.scopeGlobal.btn")}</button>
        </div></div>`
          : ""
      }
      <div class="row"><div class="sw2${this.selMaskShow ? " on" : ""}" id="ed-sel-mask"></div><span class="tog">${t("ed.sel.maskShow.label")}</span></div>
      <div class="selacts">
        <button class="minibtn" id="ed-sel-copy">${t("ed.sel.copy.btn")}</button>
        <button class="minibtn" id="ed-sel-cut">${t("ed.sel.cut.btn")}</button>
        <button class="minibtn" id="ed-sel-paste">${t("ed.sel.paste.btn")}</button>
        <button class="minibtn" id="ed-sel-del">${t("ed.sel.delete.btn")}</button>
        <button class="minibtn" id="ed-sel-none">${t("ed.sel.deselect.btn")}</button>
      </div>
      <p class="hintline">${
        this.selectKind === "auto"
          ? t("ed.sel.auto.hint")
          : t("ed.sel.drag.hint")
      }</p>`;
      // M14 (S-1): 形式（種別）＋参照（✨自動のときだけ表示）を単一ソースから差し込む
      $("#ed-selformats").appendChild(this.renderFormatGroups(this.toolFormatGroups("select"), "panel", panelClick));
      $("#ed-sel-mask").addEventListener("click", () => {
        this.selMaskShow = !this.selMaskShow;
        $("#ed-sel-mask").classList.toggle("on", this.selMaskShow);
        this.cb.onSelMaskShowChange?.(this.selMaskShow); // 変えた瞬間に settings.json へ
        this.redrawOverlay();
      });
      // M10-19: 範囲（つながり/全体）は auto 専用の追加UI（形式ストリップには出さない）
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
      $("#ed-sel-none").addEventListener("click", () => this.deselect()); // ★V214: 中身はコア
    } else if (this.tool === "transform") {
      // M11-11: 数値の行は畳める（変形の状態には一切触らない・見た目だけ）
      const fold = this.xformNumFold;
      host.innerHTML = `<h3>${t("ed.xform.head.label")}</h3>
      <div class="selacts">
        <button class="minibtn" id="ed-x-fold">${
          fold ? iconLabelHtml("chev-right", t("ed.xform.numsOpen.btn")) : iconLabelHtml("chev-down", t("ed.xform.numsClose.btn"))
        }</button>
        <button class="minibtn" id="ed-x-peek">${iconLabelHtml("eye", t("ed.xform.peek.btn"))}</button>
      </div>
      <div id="ed-x-nums"${fold ? " hidden" : ""}>
        <div class="row"><span class="tog">${t("ed.xform.angle.label")}</span><input type="number" id="ed-x-angle" value="${Math.round(
          (this.xform.angle * 180) / Math.PI
        )}" step="1" style="width:64px"> °
          <div class="sw2${this.snap15 ? " on" : ""}" id="ed-x-snap"></div><span class="tog">${t("ed.xform.snap15.label")}</span></div>
        <div class="row"><span class="tog">${t("ed.xform.scale.label")}</span>
          <span class="tog">${t("ed.xform.scaleW.label")}</span><input type="number" id="ed-x-scalex" value="${(
            this.xform.sx * 100
          ).toFixed(0)}" step="1" style="width:48px">%
          <span class="tog">${t("ed.xform.scaleH.label")}</span><input type="number" id="ed-x-scaley" value="${(
            this.xform.sy * 100
          ).toFixed(0)}" step="1" style="width:48px">%</div>
        <div id="ed-x-flip"></div>
      </div>
      <div class="selacts">
        <button class="minibtn ok" id="ed-x-ok">${iconLabelHtml("check", t("ed.common.commit.btn"))}</button>
        <button class="minibtn" id="ed-x-cancel">${iconLabelHtml("close", t("ed.common.cancelMark.btn"))}</button>
      </div>`;
      // R-2 案1: 属性はプロパティで
      for (const { sel, titleKey } of [
        { sel: "#ed-x-fold", titleKey: "ed.xform.numsFold.title" },
        { sel: "#ed-x-peek", titleKey: "ed.xform.peek.title" },
        { sel: "#ed-x-snap", titleKey: "ed.xform.snap15.title" },
      ] as const) {
        const el = host.querySelector(sel) as HTMLElement | null;
        if (el) el.title = t(titleKey);
      }
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
        $("#ed-x-ok").addEventListener("click", () => void this.commitTransform());
        $("#ed-x-cancel").addEventListener("click", () => {
          this.cancelTransformAndReturn(); // ★V214
        });
        return;
      }
      $("#ed-x-angle").addEventListener("input", (e) => this.setXformAngleInput((e.target as HTMLInputElement).value)); // ★V214
      // M13-2b (T-3): 横と縦を別々に。数値欄は**中心基準**（従来の等比と同じ流儀。対辺を止めるのは辺ハンドルのドラッグ）
      $("#ed-x-scalex").addEventListener("input", (e) => this.setXformScaleInput("x", (e.target as HTMLInputElement).value)); // ★V214
      $("#ed-x-scaley").addEventListener("input", (e) => this.setXformScaleInput("y", (e.target as HTMLInputElement).value)); // ★V214
      $("#ed-x-snap").addEventListener("click", () => {
        this.snap15 = !this.snap15;
        this.buildToolOptions();
      });
      // M14 (S-1): 反転（H/V）は単一ソースから（ストリップと共通・現在の反転状態が押された表示で分かる）
      $("#ed-x-flip").appendChild(this.renderFormatGroups(this.toolFormatGroups("transform"), "panel", panelClick));
      $("#ed-x-ok").addEventListener("click", () => void this.commitTransform());
      $("#ed-x-cancel").addEventListener("click", () => {
        this.cancelTransformAndReturn(); // ★V214
      });
    } else if (this.tool === "eraser") {
      // ★V178 (A-72・決-3 ①): 「全レイヤー」の切り替え。形は描き味の切り替え（`bindTog` / `ed-tog-stab`）と
      //  同じ `sw2`。**覚えない**（既定オフ・設定に書かない）。規則（👁 と 🔒）は画面に 1 行で出す
      //  （ペンではツールチップを出しにくいので、説明は見えるところに置く）
      host.innerHTML = `<h3>${t("ed.eraser.head.label")}</h3>
        <div class="row"><span class="tog">${t("ed.eraser.allLayers.label")}</span><div class="sw2${
          this.eraseAllLayers ? " on" : ""
        }" id="ed-tog-eraseall"></div></div>
        <p class="opt-hint" id="ed-eraseall-hint"></p>`;
      $("#ed-eraseall-hint").textContent = t(Editor.ERASE_ALL_TEXT.hint.msgKey);
      const sw = $("#ed-tog-eraseall");
      sw.addEventListener("click", () => {
        this.setEraseAllLayers(!this.eraseAllLayers);
        sw.classList.toggle("on", this.eraseAllLayers);
      });
    }
  }
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
      <button class="ic" id="ed-first">${iconHtml("skip-first")}</button>
      <button class="ic" id="ed-prev">${iconHtml("prev")}</button>
      <button class="ic play" id="ed-play">${iconHtml("play")}</button>
      <button class="ic" id="ed-next">${iconHtml("next")}</button>
      <button class="ic" id="ed-last">${iconHtml("skip-last")}</button>
      <button class="ic${this.project.loop ? " onb" : ""}" id="ed-loop">${iconHtml("loop")}</button>
      <span class="t" style="margin-left:4px">${t("ed.tl.head.label")}</span>
      <span class="sp"></span>
      <span class="speed">${t("ed.tl.speed.label")} <select id="ed-speed">${FPS_TABLE.map(
        (f, i) =>
          // M10-11: 表記を原作準拠の 0〜10 に（FPS_TABLE は添字0=0.2fps で元から原作の並び）。
          // value は従来どおり添字なので、保存値・速度連動 rate・書き出し fps は一切変わらない
          `<option value="${i}"${i === this.project.speedIndex ? " selected" : ""}>${t("ed.tl.speedOption.label", { n: i, fps: f })}</option>`
      ).join("")}</select></span>
      <button class="hb" id="ed-addframe">${t("ed.tl.addFrame.btn")}</button>
      <!-- V164 (U-4): まとめて追加。**「＋ ついか」は1枚のまま**（既定の挙動は変えない）で、
           枚数を決めて足したいときだけこちら。ゆらゆらと同じ「ボタン→小窓」の作法なので、
           隠し操作にならず（要件 U-4）押し間違えても Ctrl+Z 一回で全部戻る -->
      <button class="hb" id="ed-addframes">${t("ed.tl.addFrames.btn")}</button>
      <button class="hb" id="ed-dupframe">${iconLabelHtml("copy-to-layer", t("ed.tl.dupFrame.btn"))}</button>
      <button class="hb" id="ed-wobble">${t("ed.tl.wobble.btn")}</button>
      <button class="hb" id="ed-copypage">${iconLabelHtml("copyprev", t("ed.tl.copyFrames.btn"))}</button>
      <button class="hb" id="ed-pastepage" disabled>${iconLabelHtml("clipboard", t("ed.tl.pasteFrames.btn"))}</button>
      <button class="hb danger" id="ed-delframe">${iconLabelHtml("trash", t("ed.tl.delFrame.btn"))}</button>
      <button class="ic tl-ic" id="ed-tlmore" hidden>…</button>
      <button class="ic tl-ic" id="ed-fold-tl">${iconHtml("chev-down")}</button>
    `;
    // R-2 案1: 属性はテンプレートに埋めず、組んだあとにプロパティで入れる
    for (const { sel, titleKey } of [
      { sel: "#ed-first", titleKey: "ed.tl.first.title" },
      { sel: "#ed-prev", titleKey: "ed.tl.prev.title" },
      { sel: "#ed-play", titleKey: "ed.tl.play.title" },
      { sel: "#ed-next", titleKey: "ed.tl.next.title" },
      { sel: "#ed-last", titleKey: "ed.tl.last.title" },
      { sel: "#ed-loop", titleKey: "ed.tl.loop.title" },
      { sel: "#ed-addframes", titleKey: "ed.tl.addFrames.title" },
      { sel: "#ed-dupframe", titleKey: "ed.tl.dupFrame.title" },
      { sel: "#ed-wobble", titleKey: "ed.tl.wobble.title" },
      { sel: "#ed-copypage", titleKey: "ed.tl.copyFrames.title" },
      { sel: "#ed-pastepage", titleKey: "ed.tl.pasteFrames.title" },
      { sel: "#ed-tlmore", titleKey: "ed.tl.more.title" },
      { sel: "#ed-fold-tl", titleKey: "ed.panel.foldTl.title" },
    ] as const) {
      const el = head.querySelector(sel) as HTMLElement | null;
      if (el) el.title = t(titleKey);
    }
    // M11-18: 見出しの子要素の**元の並び順**（全部）と、そのうち「…」へ送れるもの。
    // 余白（.sp）・見出し文字（.t）・「…」・畳むは送らない（reflowTlHead は元の順序を丸ごと組み直す）
    this.closeTlMore();
    this.tlHeadOrder = [...head.children] as HTMLElement[];
    this.tlHeadItems = this.tlHeadOrder.filter(
      (el) =>
        !el.classList.contains("sp") &&
        !el.classList.contains("t") &&
        el.id !== "ed-tlmore" &&
        el.id !== "ed-fold-tl"
    );
    let pop = document.getElementById("ed-tlmore-pop");
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "ed-tlmore-pop";
      pop.className = "tl-more-pop";
      pop.hidden = true;
      // 中のボタンを押したらメニューは閉じる（ボタン自身の click が先に走る＝バブリング順）
      pop.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) this.closeTlMore();
      });
      $("#screen-editor").appendChild(pop);
    } else {
      pop.innerHTML = ""; // 前の作品の要素（別 DOM）を残さない
    }
    $("#ed-tlmore").addEventListener("click", () => this.toggleTlMore());
    $("#ed-first").addEventListener("click", () => this.gotoFrame(0));
    $("#ed-prev").addEventListener("click", () => this.gotoFrame(this.frameIndex - 1));
    $("#ed-next").addEventListener("click", () => this.gotoFrame(this.frameIndex + 1));
    $("#ed-last").addEventListener("click", () =>
      this.gotoFrame(this.project.frames.length - 1)
    );
    $("#ed-play").addEventListener("click", () => this.togglePlayback());
    $("#ed-loop").addEventListener("click", () => {
      this.toggleLoop(); // ★V214: 中身はコア
      $("#ed-loop").classList.toggle("onb", this.project.loop);
    });
    $("#ed-speed").addEventListener("change", (e) => {
      this.setSpeedIndex(Number((e.target as HTMLSelectElement).value)); // ★V214: 中身はコア
    });
    $("#ed-addframe").addEventListener("click", () => void this.addFrame(false));
    $("#ed-addframes").addEventListener("click", () => void this.onAddFramesClick());
    $("#ed-dupframe").addEventListener("click", () => void this.addFrame(true));
    $("#ed-wobble").addEventListener("click", () => void this.onWobbleClick());
    $("#ed-copypage").addEventListener("click", () => void this.copySelectedFrames());
    $("#ed-pastepage").addEventListener("click", () => void this.pasteFrames());
    $("#ed-delframe").addEventListener("click", () => void this.deleteFrame());
    this.updatePasteButton();
    this.rebuildFilm();
  }

  private async onWobbleClick(): Promise<void> {
    if (this.xformGuard()) return; // 変形中は止める（既存の流儀）
    if (!this.project.frames[this.frameIndex]) return;
    const opt = await this.openWobbleDialog();
    if (!opt) return;
    // ★V213 (M-2a): 作る計算はコア（applyWobble）。ダイアログは画面（PC）
    await this.applyWobble(opt);
  }

  /** ゆらゆらの設定ダイアログ。`EditorCallbacks` は増やさず、
   *  `openAudioPanel` と同じく `modal-back` + `modal-box` を自前で組む。
   *  ★V204 (A-111): 強さは 1〜10 のバー（弱・中・強のラジオは無くした）。上に見本（今のコマの合成で 元 → 差分1 → … を
   *  作品の速さで繰り返す・4fps より遅い作品は 4fps・音は鳴らさない）。枚数・強さ・種類・対象はアプリを閉じるまで覚える。
   *  見本のぶん広いので `.wb-box` を足した（styles.css。.modal-box の規則は触らず max-width だけ打ち消す・M10-3 の
   *  「CSS を足さない」は REQ §2-3 で外した）。見本は 1 枚ずつ作って合成の RGBA だけを持つ（コマの写しを抱え続けない）。
   *  変えたら作り直す（1 枚ごとに譲り、その間に変わったら最後の値で作り直す）。タイマーと作りかけは close() で止める */
  private openWobbleDialog(): Promise<{
    count: number;
    kind: WobbleKind;
    strength: WobbleStrength;
    /** M11-20: 対象。all=全レイヤー（従来どおり・既定）／active=選択中のレイヤーだけ */
    target: "all" | "active";
  } | null> {
    // M11-20: 「選択中のレイヤーだけ」の行に、いま対象になるレイヤー名を出す（何が揺れるか迷わせない）。
    // 長い名前は M11-19 の貼り付けボタンと同じくコードポイント 12 字＋…（label は nowrap で、
    // ダイアログを突き抜けないように。フル名は title に）
    // ★V205 (A-114・REQ §2-2): 対象は wobbleTargetLayerIds（見本・［つくる］と同じ関数）。レイヤー 1 枚＝描いているレイヤーの名前（今のまま）・
    //  フォルダ 1 つ＝フォルダの名前と中の枚数・2 つ以上＝枚数（どれも 📌 を除いた数）
    const wt = this.wobbleTargets();
    const activeFull = wt.name;
    const activeCps = [...activeFull];
    const activeName = activeCps.length > 12 ? `${activeCps.slice(0, 12).join("")}…` : activeFull;
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // label は innerHTML へ入るので**名前は esc() を通す**（ユーザーのデータ・フォルダ名も）。
    // title は**プロパティ代入**なので esc は不要（付けると &lt; が字として見える）
    const targetLabel =
      wt.kind === "folder"
        ? t("ed.wobble.targetFolder.label", { name: esc(activeName) })
        : wt.kind === "multi"
          ? t("ed.wobble.targetMulti.label", { count: wt.ids.length })
          : activeName
            ? t("ed.wobble.targetActiveNamed.label", { name: esc(activeName) })
            : t("ed.wobble.targetActive.label");
    const targetTitle =
      wt.kind === "folder"
        ? t("ed.wobble.targetFolder.title", { name: activeFull, count: wt.ids.length })
        : wt.kind === "multi"
          ? t("ed.wobble.targetMulti.title", { count: wt.ids.length })
          : activeFull
            ? t("ed.wobble.targetActiveNamed.title", { name: activeFull })
            : undefined;
    // V204: 前の値（アプリを閉じるまで）
    const last = Editor.wobbleLast;
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "modal-back";
      const box = document.createElement("div");
      box.className = "modal-box wb-box";
      back.appendChild(box);
      // R-2 案1: title は属性に埋めず、組んだあとにプロパティで入れる（訳文に " が入っても割れない）。
      // 付ける先・付ける順番は元と同じ（style の次に title）なので DOM の形は変わらない
      const pendingTitles: { name: string; v: string; title: string }[] = [];
      const radios = (
        name: string,
        items: { v: string; label: string; title?: string }[],
        def: string
      ) =>
        items
          .map((it) => {
            if (it.title) pendingTitles.push({ name, v: it.v, title: it.title });
            return `<label style="margin-right:14px;white-space:nowrap"><input type="radio" name="${name}" value="${it.v}"${
              it.v === def ? " checked" : ""
            }> ${it.label}</label>`;
          })
          .join("");
      box.innerHTML = `<p class="modal-msg">${t("ed.wobble.dialog.label")}</p>
        <div class="wb-prev" id="wb-prev"><canvas id="wb-preview" width="320" height="240"></canvas></div>
        <div class="modal-msg" style="text-align:left">
          <div style="margin-bottom:8px">${t("ed.wobble.count.label")} ${radios("wb-n", [
            { v: "2", label: t("ed.wobble.count2.label") },
            { v: "3", label: t("ed.wobble.count3.label") },
            { v: "4", label: t("ed.wobble.count4.label") },
          ], String(last.count))}</div>
          <div class="wb-srow" id="wb-srow"><span>${t("ed.wobble.strength.label")}</span><span class="wb-sval" id="wb-s-val"></span></div>
          <div style="margin-bottom:8px">${t("ed.wobble.kind.label")} ${radios("wb-k", [
            { v: "line", label: t("ed.wobble.kindLine.label") },
            { v: "whole", label: t("ed.wobble.kindWhole.label") },
          ], last.kind)}</div>
          <div>${t("ed.wobble.target.label")} ${radios("wb-t", [
            { v: "all", label: t("ed.wobble.targetAll.label") },
            { v: "active", label: targetLabel, title: targetTitle },
          ], last.target)}</div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="wb-cancel">${t("common.cancel.btn")}</button>
          <button class="btn primary" id="wb-ok">${t("ed.wobble.ok.btn")}</button>
        </div>`;
      for (const p of pendingTitles) {
        const label = box.querySelector(`input[name="${p.name}"][value="${p.v}"]`)?.closest("label") as HTMLElement | null;
        if (label) label.title = p.title;
      }
      // V204 (A-111・REQ §2-2): 強さのバー（1〜10・右に今の数）。説明は title と読み上げ（aria-label）に
      const sVal = box.querySelector("#wb-s-val") as HTMLElement;
      const sTitle = t("ed.wobble.strength.title");
      const slider = createSlider({
        min: WOBBLE_STRENGTH_MIN,
        max: WOBBLE_STRENGTH_MAX,
        step: 1,
        value: last.strength,
        title: sTitle,
        className: "wb-slider",
        onInput: (v) => {
          sVal.textContent = String(v);
          kick();
        },
      });
      slider.root.querySelector("input")?.setAttribute("aria-label", sTitle);
      sVal.textContent = String(slider.value());
      (box.querySelector("#wb-srow") as HTMLElement).insertBefore(slider.root, sVal);
      const prevBox = box.querySelector("#wb-prev") as HTMLElement;
      prevBox.title = t("ed.wobble.preview.title");
      const cv = box.querySelector("#wb-preview") as HTMLCanvasElement;
      document.body.appendChild(back);

      let done = false;
      const val = (name: string) =>
        (box.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement)
          .value;
      const readOpts = () => ({
        count: Number(val("wb-n")),
        kind: val("wb-k") as WobbleKind,
        strength: Math.max(WOBBLE_STRENGTH_MIN, Math.min(WOBBLE_STRENGTH_MAX, slider.value())) as WobbleStrength,
        target: (val("wb-t") === "active" ? "active" : "all") as "all" | "active",
      });

      // ---------------- V204 (A-111・REQ §2-3): 見本 ----------------
      // 中身は今のコマの合成（compositeFrame＝紙・表示・不透明度は編集画面と同じ。オニオン・格子なし）。
      // 差分は［つくる］と同じ関数（buildWobbleFrame）・同じシード（wobbleSeed）・同じ範囲と対象で 1 枚ずつ作り、
      // 合成の RGBA（320×240）だけを持つ。出し方は小さいプレビューと同じ fitFor＋presentFit（整数倍・fill は使わない）
      const proj = this.project;
      const cur = proj.frames[this.frameIndex];
      const fps = Math.max(4, FPS_TABLE[proj.speedIndex] ?? 8);
      const orig = compositeFrame(proj, this.frameIndex);
      const mask = this.selMask ?? null;
      // V205 (A-114): 「選択中」は開いたときに決めた対象（wt）の集まり。0 枚（［つくる］は断る）なら空の集まり＝元の絵のまま見せる
      //  （null は全レイヤーの意味なので渡さない）
      const activeSet: ReadonlySet<string> = new Set(wt.ids);
      const field = new WarpField();
      let fit: DisplayFit | null = null;
      let shown = 0;
      const paint = () => {
        if (done) return;
        const fr = this.wobblePreview?.frames ?? [orig];
        if (!fit) fit = fitFor(prevBox);
        if (!fit) return;
        presentFit(cv, rgbaOf(fr[shown % fr.length]), W, H, fit);
      };
      // 透明の紙は薄い市松（小さいプレビューと同じ・データには触れない）
      cv.classList.toggle("paper-clear", cur?.paper === 0);
      let gen = 0;
      let building = false;
      const build = async () => {
        if (building || !cur) return;
        building = true;
        try {
          for (;;) {
            const my = gen;
            const o = readOpts();
            const t0 = perfNow();
            const seed = this.wobbleSeed(o.kind, o.strength);
            const frames: Uint32Array[] = [orig];
            for (let k = 0; k < o.count - 1; k++) {
              // 1 枚ごとに譲る（バーを動かしている間に固まらない）。譲っている間に変わったら最後の値で作り直す
              await yieldToInput();
              if (done || my !== gen) break;
              const nf = buildWobbleFrame(proj, cur, k, o.kind, o.strength, seed, mask, o.target === "active" ? activeSet : null, field);
              frames.push(compositeFrame({ ...proj, frames: [nf] }, 0));
            }
            if (done) return;
            if (my !== gen) continue;
            this.wobblePreview = { ...o, seed, fps, frames, ms: perfNow() - t0 };
            shown = 0;
            paint();
            return;
          }
        } finally {
          building = false;
        }
      };
      const kick = () => {
        gen++;
        void build();
      };
      const timer = window.setInterval(() => {
        shown++;
        paint();
      }, 1000 / fps);
      const close = (
        r: {
          count: number;
          kind: WobbleKind;
          strength: WobbleStrength;
          target: "all" | "active";
        } | null
      ) => {
        if (done) return;
        // V204: 閉じ方によらず今の値を覚える（つくる・キャンセル・Esc・背景・離脱）
        Editor.wobbleLast = readOpts();
        done = true;
        gen++;
        window.clearInterval(timer);
        this.wobblePreview = null;
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
      const pick = () => close(readOpts());
      (box.querySelector("#wb-ok") as HTMLElement).addEventListener("click", pick);
      (box.querySelector("#wb-cancel") as HTMLElement).addEventListener(
        "click",
        () => close(null)
      );
      // V204: 枚数・種類・対象を変えたら見本を作り直す（バーは onInput から）
      box.addEventListener("change", (e) => {
        if ((e.target as HTMLInputElement | null)?.type === "radio") kick();
      });
      // M10-11: ペンで即閉じしないよう pointerdown に（main.ts の modal() と同じ理由）
      back.addEventListener("pointerdown", (e) => {
        if (e.target === back) close(null);
      });
      (box.querySelector("#wb-ok") as HTMLElement).focus();
      paint();
      kick();
    });
  }

  protected override updatePasteButton() {
    const b = document.querySelector("#ed-pastepage") as HTMLButtonElement | null;
    if (b) b.disabled = !Editor.frameClip;
  }

  protected override rebuildFilm() {
    const _t0 = perfNow();
    const film = $("#ed-film");
    film.innerHTML = "";
    // F-0対策: サムネは可視分のみ遅延描画。
    // 320×240 を全コマ分確保すると数百コマで canvas メモリ上限を超え、
    // メインキャンバスの描画が白紙化する（WebView2 実機で確認された症状）。
    // V192 (R-3): 前は 80×60 の縮小 canvas を描いたら持ち続けていた。いまは枠の実画素で描くので、
    // **見えなくなったら手放し、見えたらまた描く**（メモリは見えている枚数ぶんだけ）
    this.filmObserver?.disconnect();
    this.filmVisible.clear();
    this.filmFit = null; // 1 枚の大きさは作り直した帯で測り直す
    this.filmObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const cv = (e.target as HTMLElement).querySelector("canvas");
          if (!cv) continue;
          if (!e.isIntersecting) {
            this.filmVisible.delete(cv);
            this.filmPainted.delete(cv);
            releaseCanvas(cv);
            continue;
          }
          this.filmVisible.add(cv);
          const idx = Number((e.target as HTMLElement).dataset.idx);
          if (!Number.isNaN(idx) && this.filmPainted.get(cv) !== fitKey(this.filmFitNow())) this.paintFilmThumb(idx, cv);
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
      // V192 (R-3): 描くまで 0×0（大きさは見えたときに枠の実画素で決める）
      cv.width = 0;
      cv.height = 0;
      fr.appendChild(no);
      fr.appendChild(cv);
      // V157 (D-2 / U-4): このコマだけの表示色が付いていたら、細い帯を出す（V205: 作り方は filmColorMark に移した＝1 コマだけ直す道と同じ）
      const bar = this.filmColorMark(i);
      if (bar) fr.appendChild(bar);
      fr.addEventListener("click", (e) => {
        // M11-7: 並べ替えで掴んだあとの click ではコマを切り替えない
        if (this.suppressFrameClick) return;
        this.clickFrame(i, e.shiftKey); // ★V214: コマの範囲の起点と移るのはコア
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
    add.title = t("ed.tl.addLast.title");
    // M11-14: フィルム末尾の「＋」は**常に最後尾**へ（うごメモ仕様）。
    // ヘッダの「＋ ついか」とショートカットは従来どおり選択中の次
    add.addEventListener("click", () => void this.addFrame(false, true));
    film.appendChild(add);
    this.updateBadge();
    this.updateFilmSeMarks(); // M5-1: SE配置マーク
    perfDone("film.rebuild", _t0);
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
      // ★V195 (A-97): 再生中に並べ替えを始めたら**先に止める**（gotoFrame と同じ止め方）。
      //  クリックで終わるときは click → gotoFrame が止めるので、ここは「掴んだ」と決まった瞬間だけ
      if (this.playing) this.stopPlayback();
      const g = document.createElement("div");
      g.className = "drag-ghost"; // 既存クラス（レイヤー行・カードと共用）
      g.textContent = t("ed.tl.dragGhost.label", { n: d.from + 1 });
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
    void this.reorderFrame(from, to); // 履歴（コマ並べ替え）も xformGuard も既存のまま
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

  /** V156 (P-1): 眠っているコマのサムネを、起こして描いて**また眠らせる**。
   *  読みで起こすので、片付けは只（圧縮し直しは起きない）。 */
  private async paintFilmThumbAwake(i: number, el: HTMLCanvasElement): Promise<void> {
    const fr = this.project.frames[i];
    if (!fr) return;
    await wakeFrame(this.project, fr, "read");
    if (!this.mounted || this.project.frames[i] !== fr) return; // 間にコマが動いた
    this.paintFilmThumb(i, el);
    // ★V216b (A-128): 片づけを止めている間（重い操作・元に戻す／やり直しが読みで起こした面を使っている間）は眠らせ直さない
    if (!this.inSleepWindow(i) && !this.sweepHeld()) await sleepFrame(this.project, fr, this.sharedLayerIds(), true);
  }

  protected override paintFilmThumb(i: number, cv?: HTMLCanvasElement) {
    const film = $("#ed-film");
    const el =
      cv ??
      (film.querySelector(`.fr[data-idx="${i}"] canvas`) as HTMLCanvasElement | null);
    if (!el) return;
    // V192 (R-3・F-0): 見えていない（前後 200px の外）サムネは描かない＝バッキングを持たない。
    // 見えたときに filmObserver が描く（描き直しの印だけ消しておく）
    if (!this.filmVisible.has(el)) {
      this.filmPainted.delete(el);
      return;
    }
    // V156 (P-1): 眠っているコマのサムネは、そのまま合成すると**エラーも出さずに白紙**になる
    //（`render.ts` の `if (!lb) continue`）。起こしてから描き、窓の外なら**すぐ片付ける**
    const fr = this.project.frames[i];
    if (this.sleepOn && fr && frameHasAsleep(fr)) {
      void this.paintFilmThumbAwake(i, el);
      return;
    }
    // V192 (R-3): 合成（320×240）→ 枠の実画素へ**面積平均**（光の量で混ぜる）。前の「80×60 へ最近傍 → CSS で引き伸ばし」は
    // 4 ドットおきに拾うので、1 ドットおきの柄（一松柄）の片方の色しか残らなかった
    const fit = this.filmFitNow();
    if (!fit) return;
    presentFit(el, rgbaOf(compositeFrame(this.project, i, this.filmComposite)), W, H, fit);
    this.filmPainted.set(el, fitKey(fit));
    // M11-16: 透明の紙は canvas の背景で薄い市松にする（データには触れない・実色の紙と見分けるため）
    el.classList.toggle("paper-clear", this.project.frames[i]?.paper === 0);
  }

  /** V192 (R-3): コマ一覧の 1 枚の出す大きさ（どのコマも同じ枠）。枠・dpr が変わったら refitFilm が捨てる */
  private filmFitNow(): DisplayFit | null {
    if (this.filmFit) return this.filmFit;
    const fr = document.querySelector("#ed-film .fr");
    this.filmFit = fr ? fitFor(fr) : null;
    return this.filmFit;
  }

  /** V192 (R-3): 帯の大きさか dpr が変わった → 見えているサムネのうち大きさが違うものだけ描き直す
   *  （見えていないものは手放してある＝見えたときに今の大きさで描く）。
   *  タイムラインの高さをドラッグしている間は ResizeObserver が毎フレーム鳴る。そのたびに見えている全部を
   *  描き直す（眠っているコマは起こし直しも）と重いので、**止まってから 1 回だけ**描き直す。それまでは前の大きさの
   *  まま枠の真ん中に出る。大きさの見積りはすぐ捨てる＝その間の編集・見えてきたサムネは新しい大きさで描かれる */
  private refitFilmTimer: number | null = null;
  private refitFilm() {
    this.filmFit = null;
    if (this.refitFilmTimer != null) window.clearTimeout(this.refitFilmTimer);
    this.refitFilmTimer = window.setTimeout(() => {
      this.refitFilmTimer = null;
      if (this.mounted) this.refitFilmNow();
    }, 120);
  }

  private refitFilmNow() {
    this.filmFit = null;
    const key = fitKey(this.filmFitNow());
    if (!key) return; // 帯が見えていない（0×0）
    for (const cv of [...this.filmVisible]) {
      if (this.filmPainted.get(cv) === key) continue;
      const idx = Number((cv.parentElement as HTMLElement | null)?.dataset.idx);
      if (!Number.isNaN(idx)) this.paintFilmThumb(idx, cv);
    }
  }

  protected override updateFilmSelection() {
    document.querySelectorAll("#ed-film .fr").forEach((el) => {
      const idx = Number((el as HTMLElement).dataset.idx);
      el.classList.toggle("on", idx === this.frameIndex);
      el.classList.toggle(
        "rangesel",
        this.rangeSel != null && idx >= this.rangeSel.a && idx <= this.rangeSel.b
      );
    });
    this.updateBadge();
    this.syncPasteRangeLabel(); // V199 (A-105): 「貼り付け → コマ 3〜8」を範囲に追従させる
  }

  private updateBadge() {
    $("#ed-badge").textContent = t("ed.view.badge.label", { frame: this.frameIndex + 1, total: this.project.frames.length });
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
    $("#ed-export").onclick = async () => {
      if (this.busyKind) return; // V154b (W-7): 重い処理の最中は開かない
      if (this.xformGuard()) return; // E-4
      // V161 (A): 書き出しは保存完了を待つ（同じ作品を書き出しと保存が同時に読まない）
      await this.waitForSave();
      if (this.playing) this.stopPlayback();
      // ★V168 (E-3): **ここで全コマを起こさない。** V163 は「眠ったまま書き出すと白紙」を
      //  入口で全レイヤーを読みで起こすことで塞いだが、目安の 10.8 倍の作品
      //  （56,860面）ではそれが**論理サイズ 4.1GB を生で展開する見積りなしの確保**になる
      //  （8/31 の落ち方と同じ形）。白紙防止は `projectSource`（frameSource.ts）が
      //  **読む直前に起こし、読み終えたら眠らせ直す**ことで守る。不変条件は同じ・守り方だけ変えた
      this.cb.openExport(
        projectSource(this.project),
        exportBaseName(this.fileBase, this.project.meta.title, untitledTitle()), // V199 (A-106): いまのファイルの名前
        this.rangeSel,
        this.buildExportAudioSource(),
        (m) => this.setBgmSyncMode(m) // ★V214: 中身はコア
      );
    };
    // M11-11: いま見ているコマ1枚を画像で保存（アニメの書き出しとは別の導線）
    $("#ed-imgexport").onclick = async () => {
      if (this.xformGuard()) return; // 変形/歪みの未確定があるときは先に確定させる
      await this.waitForSave(); // V161（独立レビューの指摘④）: 書き出し系はどれも保存完了を待つ
      if (this.playing) this.stopPlayback();
      // V163: いま見ているコマは窓の中でほぼ必ず起きているが、眠っていたら白紙が出る
      // （compositeFrame は眠りを知らない）ので、1コマだけ読みで起こす（数十ms）
      {
        const fr = this.project.frames[this.frameIndex];
        if (this.sleepOn && fr && frameHasAsleep(fr)) await wakeFrame(this.project, fr, "read");
      }
      this.cb.openImageExport?.(
        this.project,
        this.frameIndex,
        exportBaseName(this.fileBase, this.project.meta.title, untitledTitle()) // V199 (A-106): いまのファイルの名前
      );
    };
    // ★V214 (M-2b-1a): 履歴が動いたときの手続き（ボタン〔undoRedoShown〕→ 大きさと履歴の予算の数え直し）はコアの historyChanged。
    //  つなぐのも開いたときに 1 回呼ぶのも前と同じ所
    this.bindHistory();
    this.historyChanged();
    // V158 (L-2): 左上の「このコマの絵を消す」。**🌀 と同じ `clearFrame()` を呼ぶだけ**
    //（確認の設定・選択範囲の扱い・Undo の粒度を二重に持たない＝実装を分けない）
    $("#ed-clearframe").onclick = () => void this.clearFrame();
    // 表示操作
    $("#ed-view-rot").onclick = () => {
      this.viewRot = (this.viewRot + 90) % 360;
      this.applyViewChange(); // V195 (A-98): パンの間は余白を置き直す
    };
    $("#ed-view-flip").onclick = () => {
      this.viewFlipH = !this.viewFlipH;
      this.applyViewChange();
    };
    $("#ed-zoom-in").onclick = () => this.adjustZoom(+1);
    $("#ed-zoom-out").onclick = () => this.adjustZoom(-1);
    $("#ed-mini").onclick = () => this.togglePreviewLarge();
    // M11-16: HUD をまとめて隠す/出す（M11-13 の 🖼＝ミニ単独トグルを置き換え・統合）。
    // ボタンは .cvright（隠す対象の外）にあるので、隠しても戻せる
    $("#ed-mini-toggle").onclick = () => this.toggleHudHidden();
  }

  // ---------------- M11-16: HUD の非表示（自動＋まとめトグル） ----------------
  //
  // 表示への反映は **applyHud() 1つ**に集約する（M11-5 の endPointerSession・M11-13 の
  // applyMiniHidden と同じ作法）。ストロークの自動非表示は「消えたまま戻らない」が最頻の事故なので、
  // ストロークのあらゆる終了経路（pointerup / pointercancel / blur / endPointerSession）が
  // 同じ setStrokeHud(false) を通る。四隅変形の muteFloatingOverlays（opacity/pointer-events）は
  // 別物・無改変で、こちらは CSS クラス（見た目だけ・当たり判定は奪わない）なので衝突しない。

  /** 大画面（`swapped`）との入れ替え。**隠している間は何も起きない**（トーストも出さない）。
   *  小窓のクリックとコマンドの両方がここを通る（M11-13 の規則を引き継ぐ） */
  private togglePreviewLarge() {
    // M11-21: 「表示しない」の間は大画面切替の入口も無し（ミニは hidden で click 自体届かないが構造的にも閉じる）
    if (this.miniDock === "off") return;
    // M11-18: 収納ミニは HUD の隠す対象外（見えている）ので、隠している間でも大画面切替が効く。
    // フロート時は従来どおり無反応
    if (this.hudHidden && this.miniDock !== "timeline") return;
    this.previewLarge = !this.previewLarge;
    $("#ed-stage").classList.toggle("swapped", this.previewLarge);
    // M11-18: 大画面は「ミニが stage の中にある」前提の CSS（.stage.swapped .mini）なので、
    // 収納中でも大画面の間はミニを stage へ戻す。置き場の決定は applyHud（1関数集約）
    this.applyHud();
    this.applyZoom();
  }

  /** まとめて隠す／出すを切り替えて設定へ保存する。
   *  大画面のまま隠すと**キャンバスが小窓のまま取り残される**ので、先に大画面を解除する（M11-13） */
  private toggleHudHidden() {
    const next = !this.hudHidden;
    if (next && this.previewLarge) {
      this.previewLarge = false;
      $("#ed-stage").classList.remove("swapped");
      this.applyZoom();
    }
    this.hudHidden = next;
    this.applyHud();
    this.cb.onHudHiddenChange?.(this.hudHidden);
  }

  /** ストローク中の自動非表示を立てる/戻す。**戻し側は少し遅らせる**（連続ストロークで
   *  HUD が点滅しないように）。立てる側は即時＝描き始めた瞬間に消える。
   *  戻しの遅延中に次のストロークが始まったら、タイマーを捨てて消えたままにする */
  private setStrokeHud(on: boolean) {
    if (this.hudRestoreTimer != null) {
      clearTimeout(this.hudRestoreTimer);
      this.hudRestoreTimer = null;
    }
    if (on) {
      if (!this.hudStroke) {
        this.hudStroke = true;
        this.applyHud();
      }
      return;
    }
    if (!this.hudStroke) return;
    this.hudRestoreTimer = window.setTimeout(() => {
      this.hudRestoreTimer = null;
      this.hudStroke = false;
      this.applyHud();
    }, Editor.HUD_RESTORE_MS);
  }

  /** M11-18: いまミニが**タイムラインに収納されている**か（設定が timeline で、大画面中でない）。
   *  大画面（swapped）の間は CSS の都合でフロート位置（stage の中）へ戻す */
  private miniDocked(): boolean {
    return this.miniDock === "timeline" && !this.previewLarge;
  }

  /** ミニが見えている（描き直す価値がある）か。
   *  - フロート: hudHidden でなければ見えている
   *  - 収納: hudHidden の対象外だが、**タイムラインが畳まれていれば見えない**（合成を走らせない・M11-13 の趣旨）
   *  - 大画面（swapped）: 収納から入った場合 hudHidden でも大画面ミニは見せる（隠すとキャンバスが小窓のまま
   *    取り残されるので、そこだけ hudHidden より優先） */
  private miniShown(): boolean {
    // M11-21: 「表示しない」は何があっても描かない（renderCanvas / applyHud / applyLayout の paintMini が全部止まる）
    if (this.miniDock === "off") return false;
    if (this.previewLarge) return true;
    if (this.miniDocked()) return !this.isCollapsed("tl");
    return !this.hudHidden;
  }

  /** 状態を DOM へ反映する（復元・トグル・ストロークの共通経路）。
   *  - miniDock（M11-18）: ミニ要素そのものを **stage ⇄ タイムラインの置き場（#ed-mini-slot）へ移す**
   *    （要素は同一＝canvas・click（大画面切替）・muteFloatingOverlays の対象は変わらない）
   *  - hudHidden（トグル）: ミニ・バッジ・倍率を **hidden**。V195 (A-98b): `.cvright` は**残したうえで**
   *    `hud-collapsed` で隠す／出すのボタン以外を畳む（列ごと消すと戻す手段が無くなる）。**収納ミニは対象外**
   *  - hudStroke（描画中）: 4つ全部を **薄く**（.hud-stroke クラス・見た目だけ）。**収納ミニは対象外**
   *  出したときは**ミニをその場で描き直す** — 隠している間は renderCanvas がミニを更新しないため */
  private applyHud() {
    const mini = document.querySelector("#ed-mini") as HTMLElement | null;
    const badge = document.querySelector("#ed-badge") as HTMLElement | null;
    const zoom = document.querySelector("#ed-zoominfo") as HTMLElement | null;
    const right = document.querySelector(".cvright") as HTMLElement | null;
    const btn = document.querySelector("#ed-mini-toggle") as HTMLElement | null;
    const dock = this.miniDocked();
    const off = this.miniDock === "off"; // M11-21: 表示しない
    // 置き場（stage の最後の子＝従来の DOM 位置／収納スロット）
    if (mini) {
      const slot = document.querySelector("#ed-mini-slot") as HTMLElement | null;
      const stage = document.querySelector("#ed-stage") as HTMLElement | null;
      // off のときは stage 側へ戻して hidden にする＝slot が :empty になり、CSS の
      // `.tl-mini-slot:empty { display:none }` で slot ごと消えてフィルムが左端まで使える
      if (dock && slot && mini.parentElement !== slot) slot.appendChild(mini);
      else if (!dock && stage && mini.parentElement !== stage) stage.appendChild(mini);
      mini.classList.toggle("docked", dock);
      // hidden は「フロートで hudHidden」のときだけ。収納中は対象外。**大画面の間は隠さない**
      //（収納から hudHidden のまま大画面に入る経路がある。隠すとキャンバスが小窓のまま取り残される＝
      //  レビュー指摘）。フロートでは hudHidden && previewLarge は到達しない（toggleHudHidden が先に解除・
      //  togglePreviewLarge は hudHidden で早期 return）ので従来と同じ。
      // M11-21: off は常に hidden・薄化（hud-stroke）の対象外
      mini.hidden = off || (this.hudHidden && !dock && !this.previewLarge);
      mini.classList.toggle("hud-stroke", this.hudStroke && !dock && !off);
    }
    for (const el of [badge, zoom]) if (el) el.hidden = this.hudHidden;
    // ★V195 (A-98b): 右上のボタン列（回転・反転・拡大・縮小・集中）も畳み、「隠す／出す」1 つだけ残す。
    //  **クラスで畳む**（hidden 属性・インラインには触れない）＝四隅変形の muteFloatingOverlays が列に付ける
    //  インラインの pointer-events / opacity とぶつからない（変形の間に隠す／出すをしても、抜けたら押せる）。
    //  キーでの拡大・回転・反転はボタンを通らない（adjustZoom・clickUi は要素が隠れていても動く）
    right?.classList.toggle("hud-collapsed", this.hudHidden);
    for (const el of [badge, zoom, right]) el?.classList.toggle("hud-stroke", this.hudStroke);
    if (btn) {
      btn.classList.toggle("onb", this.hudHidden); // 隠している間は色を変える（既存の .ic.onb）
      // 収納中／表示しないときはミニは対象外なので文言も「表示情報」だけにする
      // M12-1b-2: 断片（{what}を出す/隠す）の連結をやめ、4通りの完全文にした
      btn.title =
        this.miniDock === "float"
          ? this.hudHidden
            ? t("ed.mini.hudToggleShowAll.title")
            : t("ed.mini.hudToggleHideAll.title")
          : this.hudHidden
            ? t("ed.mini.hudToggleShowInfo.title")
            : t("ed.mini.hudToggleHideInfo.title");
    }
    if (this.miniShown()) this.paintMini();
  }

  /** ミニプレビューだけを描き直す（オニオン無し・renderCanvas と同じ内容）。
   *  V192 (R-4): 枠（.mini）の実画素で——小さい窓（幅 150px）は面積平均・大画面（swapped）と収納は整数倍 */
  private paintMini() {
    const mini = document.querySelector("#ed-mini-canvas") as HTMLCanvasElement | null;
    if (!mini) return;
    if (!this.miniFit) {
      const box = document.querySelector("#ed-mini");
      this.miniFit = box ? fitFor(box) : null;
    }
    const fit = this.miniFit;
    if (!fit) return; // 隠している（0×0）→ 出したときに miniFitWatch が描く
    presentFit(mini, rgbaOf(compositeFrame(this.project, this.frameIndex, this.miniComposite)), W, H, fit);
    // M11-16: 透明の紙は薄い市松（データには触れない）
    mini.classList.toggle("paper-clear", this.project.frames[this.frameIndex]?.paper === 0);
  }

  // ---------------- M11-17: スプリッター（パネル寸法） ----------------

  /** settings.json の `layout` から復元する。**何が入っていても起動する**（項目ごとに既定へ倒す・clamp）。
   *  mount() より前に呼ばれ、mount() の applyLayout() で DOM へ反映される */
  restoreLayout(v: unknown) {
    this.layout = sanitizeLayout(v);
  }

  /** M11-18: settings.json の `miniDock` から復元（"float"/"off" 以外はすべて既定＝収納）。
   *  ⚙ 設定で変えたときも main.ts がこれを呼ぶ（エディタが開いていれば即反映） */
  restoreMiniDock(v: unknown) {
    this.miniDock = sanitizeMiniDock(v);
    if (!this.mounted) return;
    // M11-21: 大画面のまま「表示しない」にするとキャンバスが小窓のまま取り残されるので先に解除
    //（toggleHudHidden と同じ作法。現状 ⚙ はライブラリ画面からしか開けないので保険）
    if (this.miniDock === "off" && this.previewLarge) {
      this.previewLarge = false;
      $("#ed-stage").classList.remove("swapped");
      this.applyZoom();
    }
    this.applyHud();
  }

  /** M11-18: settings.json の `collapsed` から復元（true 以外は開いている）。mount() の applyLayout() で反映 */
  restoreCollapsed(v: unknown) {
    this.collapsed = sanitizeCollapsed(v);
  }

  /** M13-2a (A-2): settings.json の `selMask` から復元。V208 (A-119): **`true` のときだけオン**（キーが無い・false はオフ。
   *  キーは変えない＝書くのは今どおり押した瞬間だけ。キーが無いときの意味は作者の決定で変えた） */
  restoreSelMaskShow(v: unknown) {
    this.selMaskShow = v === true;
    if (this.mounted) this.redrawOverlay();
  }



  /** M14 (S-3): settings.json の `toneOpen` から復元。**`true` のときだけ開く**（既定=閉・追加のみ）。
   *  ⚙ の設定ではなくパネルのヘッダで開閉するので、mount 前の復元で足りる（buildSidePanel が読む） */
  restoreToneOpen(v: unknown) {
    this.toneOpen = v === true;
  }









  /** いま実際に畳まれているか（個別状態 or 集中） */
  private isCollapsed(key: CollapseKey): boolean {
    return this.focusActive || this.collapsed[key];
  }

  /** 3つの寸法を CSS 変数へ（DOM への反映はここ1つ）。grid が変わると #ed-stage の ResizeObserver が
   *  applyZoom＋renderCanvas を呼ぶので、キャンバスの整数倍表示はここでは触らない。
   *  M11-18: 畳んでいるパネルは変数を COLLAPSED_PX（つまみ幅）にし、.ed-main に c-tools/c-side/c-tl を
   *  付ける（layout の値そのものは触らない＝復帰で元の幅/高さ）。そのスプリッターは disabled */
  private applyLayout() {
    const main = document.querySelector(".ed-main") as HTMLElement | null;
    if (!main) return;
    const cT = this.isCollapsed("tools");
    const cS = this.isCollapsed("side");
    const cL = this.isCollapsed("tl");
    main.style.setProperty("--ed-tools-w", `${cT ? COLLAPSED_PX : this.layout.toolsW}px`);
    main.style.setProperty("--ed-side-w", `${cS ? COLLAPSED_PX : this.layout.sideW}px`);
    main.style.setProperty("--ed-tl-h", `${cL ? COLLAPSED_PX : this.layout.tlH}px`);
    // V158 (L-1): 右パネルの上下比。段を畳んでいるときは相手を目いっぱいにする
    const side = document.getElementById("ed-side");
    if (side) {
      side.style.setProperty("--ed-side-top", `${this.layout.sideTop}%`);
      side.classList.toggle("fold-top", this.sideFold.top);
      side.classList.toggle("fold-bot", this.sideFold.bot);
      side.classList.toggle("fold-col", this.sideFold.col); // ★V215 (A-124)
      this.fitColorRows(); // 窓・比率・畳みが変わったら色の段の段数を決め直す（ResizeObserver より先に・同じ拍で）
    }
    document
      .getElementById("ed-side-vsplit")
      ?.classList.toggle("disabled", cS || this.sideFold.top || this.sideFold.bot);
    main.classList.toggle("c-tools", cT);
    main.classList.toggle("c-side", cS);
    main.classList.toggle("c-tl", cL);
    document.getElementById("ed-split-tools")?.classList.toggle("disabled", cT);
    document.getElementById("ed-split-side")?.classList.toggle("disabled", cS);
    document.getElementById("ed-split-tl")?.classList.toggle("disabled", cL);
    const fb = document.getElementById("ed-focus-toggle");
    if (fb) {
      fb.classList.toggle("onb", this.focusActive);
      fb.title = this.focusActive
        ? t("ed.panel.focusOff.title")
        : t("ed.panel.focusOn.title");
    }
    if (cL) this.closeTlMore(); // 畳んだ見出しのメニューは開いたままにしない
    this.publishTlHeadHeight();
    this.reflowTlHead();
    // 畳んでいる間は収納ミニを描かない（miniShown）ので、開いた瞬間に描き直す
    if (this.tlWasCollapsed && !cL && this.mounted && this.miniShown()) this.paintMini();
    this.tlWasCollapsed = cL;
  }

  // ---------------- M11-18: 畳む（3パネル）とキャンバス集中 ----------------

  /** 畳むボタン（.ed-fold）とつまみ（.ed-tab）を3パネルに用意する。buildToolsPanel / buildSidePanel は
   *  innerHTML を作り直すので、mount のたびに（build の後で）呼び直す。つまみはカード直下の最後の子＝
   *  畳んだとき CSS が中身を消してもこれだけ残る */
  private bindPanelFolds() {
    // V171: 山形（chevron）のアイコンは呼び出し側が id で指定する（◂ ▸ ▴ ▾ は i18n から剥がした）
    const mk = (cls: string, id: string, title: string, text: string, iconId: IconId, onClick: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.id = id;
      b.title = title;
      setIconLabel(b, iconId, text);
      b.addEventListener("click", onClick);
      return b;
    };
    // 道具列: 畳むボタンは先頭行（2列組でも1行を占める）・つまみは最後
    const tools = $("#ed-tools");
    tools.querySelectorAll(".ed-fold, .ed-tab").forEach((e) => e.remove());
    tools.prepend(
      mk("ed-fold", "ed-fold-tools", t("ed.panel.foldTools.title"), t("ed.panel.foldTools.btn"), "chev-left", () => this.setCollapsed("tools", true))
    );
    tools.appendChild(
      mk("ed-tab v", "ed-tab-tools", t("ed.panel.tabTools.title"), t("ed.panel.tabTools.btn"), "chev-right", () => this.setCollapsed("tools", false))
    );
    // 右パネル: 畳むボタンは先頭行の右端・つまみは最後
    const side = $("#ed-side");
    side.querySelectorAll(".ed-fold-row, .ed-tab").forEach((e) => e.remove());
    const row = document.createElement("div");
    row.className = "ed-fold-row";
    row.appendChild(
      mk("ed-fold", "ed-fold-side", t("ed.panel.foldSide.title"), t("ed.panel.foldSide.btn"), "chev-right", () => this.setCollapsed("side", true))
    );
    side.prepend(row);
    side.appendChild(
      mk("ed-tab v", "ed-tab-side", t("ed.panel.tabSide.title"), t("ed.panel.tabSide.btn"), "chev-left", () => this.setCollapsed("side", false))
    );
    // タイムライン: 畳むボタンは見出しの右端（buildTimeline が作る #ed-fold-tl）・つまみは最後
    const tl = $("#ed-timeline");
    tl.querySelectorAll(":scope > .ed-tab").forEach((e) => e.remove());
    tl.appendChild(
      mk("ed-tab h", "ed-tab-tl", t("ed.panel.tabTl.title"), t("ed.panel.tabTl.btn"), "chev-up", () =>
        this.setCollapsed("tl", false)
      )
    );
    const foldTl = document.getElementById("ed-fold-tl");
    if (foldTl) foldTl.onclick = () => this.setCollapsed("tl", true);
    const focus = document.getElementById("ed-focus-toggle");
    if (focus) focus.onclick = () => this.toggleFocus();
  }

  /** つまみ・畳むボタンからの個別操作。**集中中なら**、いま見えている状態（全部畳み）を個別状態の
   *  新しい基準にして復元スナップショットは捨てる（REQ §3: 2重管理の食い違い防止）。集中フラグ自体は
   *  ボタン/コマンドで下ろすまで残す＝そのとき復元するものが無いので何も動かない（「二重に動かない」） */
  private setCollapsed(key: CollapseKey, v: boolean) {
    if (this.focusActive && this.focusSnap) {
      this.collapsed = { tools: true, side: true, tl: true };
      this.focusSnap = null;
    }
    if (this.collapsed[key] === v && !this.focusActive) return;
    this.collapsed[key] = v;
    if (this.focusActive) {
      // 個別に開いた分は集中の上書きから外れる＝集中は「残りのパネルを畳んだまま」の状態へ
      // （effective = focusActive || collapsed[key] のままだと開けないので、フラグを下ろして
      //   個別状態だけで表現する。ボタンの点灯は消え、次に押せば再び発動）
      this.focusActive = false;
    }
    this.finishSplitDrag(false);
    this.applyLayout();
    this.cb.onCollapsedChange?.({ ...this.collapsed });
  }

  /** キャンバス集中: 発動＝3パネル一括畳み（個別状態は focusSnap に控える）／解除＝控えへ戻す。
   *  保存しない（個別状態は発動前と同じなので保存も不要） */
  private toggleFocus() {
    if (!this.focusActive) {
      this.focusSnap = { ...this.collapsed };
      this.focusActive = true;
    } else {
      if (this.focusSnap) this.collapsed = { ...this.focusSnap };
      this.focusSnap = null;
      this.focusActive = false;
    }
    this.finishSplitDrag(false);
    this.applyLayout();
  }

  // ---------------- M11-18: タイムライン見出しの「…」（あふれメニュー） ----------------

  /** 見出しの幅に入りきらないボタンを**後ろから**「…」メニューへ送る（見出しは常に1行）。
   *  幅が変わるたびに呼ばれる（headObs）。要素は移動するだけ＝id・listener・disabled はそのまま。
   *  測定は「全部戻してから scrollWidth > clientWidth の間、末尾から1つずつ送る」＝順序が保たれ、
   *  「…」ボタン自身の幅も込みで判定できる（1つでも送るときは「…」を出してから測る） */
  private reflowTlHead() {
    const head = document.getElementById("ed-tlhead");
    const pop = document.getElementById("ed-tlmore-pop");
    const more = document.getElementById("ed-tlmore");
    if (!head || !pop || !more || this.tlHeadItems.length === 0) return;
    if (this.isCollapsed("tl") || head.clientWidth === 0) return; // 畳み中・未レイアウトは触らない
    // 1) 全部を見出しへ戻す＝**元の並び順を丸ごと組み直す**（先頭から順に appendChild すると、
    //    pop に居た要素も含めて元の順に並ぶ。「…」の手前へまとめて差し込むと ⏮◀▶ が見出し文字の後ろへ
    //    移ってしまう＝レビュー指摘）
    for (const el of this.tlHeadOrder) head.appendChild(el);
    more.hidden = true;
    const fits = () => head.scrollWidth <= head.clientWidth + 1;
    if (!fits()) {
      more.hidden = false;
      // 2) 末尾から1つずつ送る（pop の中は元の順序になるよう先頭へ差し込む）
      for (let i = this.tlHeadItems.length - 1; i >= 0 && !fits(); i--) {
        pop.prepend(this.tlHeadItems[i]);
      }
    }
    if (pop.childElementCount === 0) {
      more.hidden = true;
      this.closeTlMore();
    } else if (this.tlMoreClose) {
      this.positionTlMore(); // 開いたままなら位置だけ追従
    }
  }

  private toggleTlMore() {
    if (this.tlMoreClose) this.closeTlMore();
    else this.openTlMore();
  }

  /** 「…」の上へ開く（position:fixed）。閉じ方: 外側の pointerdown（capture）／Esc（capture・エディタの
   *  ショートカットへ渡さない）／ウィンドウ resize・blur／中のボタンを押した／unmount・畳み */
  private openTlMore() {
    const pop = document.getElementById("ed-tlmore-pop");
    const more = document.getElementById("ed-tlmore");
    if (!pop || !more || pop.childElementCount === 0) return;
    pop.hidden = false;
    more.classList.add("onb");
    this.positionTlMore();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (pop.contains(t) || more.contains(t))) return;
      this.closeTlMore();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.closeTlMore();
    };
    const onAway = () => this.closeTlMore();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onAway);
    window.addEventListener("blur", onAway);
    this.tlMoreClose = () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("blur", onAway);
      pop.hidden = true;
      more.classList.remove("onb");
    };
  }

  private closeTlMore() {
    const fn = this.tlMoreClose;
    this.tlMoreClose = null;
    fn?.();
  }

  /** 「…」ボタンの真上に右揃えで（上に入らなければ下へ）。画面内に収める */
  private positionTlMore() {
    const pop = document.getElementById("ed-tlmore-pop");
    const more = document.getElementById("ed-tlmore");
    if (!pop || !more || pop.hidden) return;
    const r = more.getBoundingClientRect();
    const w = pop.offsetWidth || 160;
    const h = pop.offsetHeight || 40;
    let left = Math.round(r.right - w);
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    let top = Math.round(r.top - 6 - h);
    if (top < 8) top = Math.min(window.innerHeight - h - 8, Math.round(r.bottom + 6));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  /** タイムライン見出し（#ed-tlhead）の実高を CSS 変数 --ed-tlhead-h として公開する。フィルムのサムネの
   *  伸びの上限（styles.css .fr）がこれを使う。見出しはステージ幅で1行/2行に折り返すので、
   *  スプリッター操作・ウィンドウ resize のたびに measure し直す（ResizeObserver＝headObs） */
  private publishTlHeadHeight() {
    const main = document.querySelector(".ed-main") as HTMLElement | null;
    const head = document.querySelector("#ed-tlhead") as HTMLElement | null;
    if (!main || !head) return;
    const h = Math.ceil(head.getBoundingClientRect().height);
    if (h > 0) main.style.setProperty("--ed-tlhead-h", `${h}px`);
  }

  /** ドラッグ中の動的な上限: 静的レンジに加えて「キャンバス領域が潰れない」ぶんだけ狭める。
   *  横: stage が最低 360px（1倍 320＋余白 40）残るように。縦: stage が最低 280px（240＋40）残るように。
   *  .ed-main の実寸が取れないとき（0）は静的レンジだけ */
  private clampLayoutLive(key: LayoutKey, v: number): number {
    let val = clampLayoutValue(key, v);
    const main = document.querySelector(".ed-main") as HTMLElement | null;
    if (!main) return val;
    const SPLIT = 10;
    const PAD = 20; // .ed-main padding 10×2
    // V158 (L-1・独立レビューの指摘①): `sideTop` は**％**なので、px を前提にした下の分岐へ入れてはいけない。
    // 入れると `floor = min(minHere, startVal, …)` の「掴んだ値より下げない」規則がそのまま効いて、
    // **境界を上へ動かせなくなる**（レイヤーを広げようとドラッグしても戻らない＝壊れて見える）。
    // ここでの動的な上限は「下段が最低の高さ（--ed-side-bot-min ＝ 168px）を保てるところまで」。
    if (key === "sideTop") {
      const side = document.getElementById("ed-side");
      const h = side?.clientHeight ?? 0;
      if (h > 0) {
        const BOT_MIN = 168; // .side-bot の min-height と同じ
        const maxPct = ((h - SPLIT - BOT_MIN) / h) * 100;
        val = Math.max(LAYOUT_RANGE[key][0], Math.min(val, maxPct));
      }
      return Math.round(val);
    }
    if (key === "toolsW" || key === "sideW") {
      const w = main.clientWidth;
      if (w > 0) {
        const other = key === "toolsW" ? this.layout.sideW : this.layout.toolsW;
        const maxHere = w - PAD - SPLIT * 2 - other - 360;
        val = Math.max(LAYOUT_RANGE[key][0], Math.min(val, maxHere));
      }
    } else {
      const h = main.clientHeight;
      if (h > 0) {
        const maxHere = h - PAD - SPLIT - 280;
        val = Math.max(LAYOUT_RANGE[key][0], Math.min(val, maxHere));
      }
      // 下限も実測から: 見出し行が折り返して2行になっていると（stage が狭いとき）、静的な 148 では
      // フィルム帯が潰れてサムネ1段が入らない。見出しの実高＋余白6＋帯の padding 8＋サムネ 58.5＋
      // カードの padding 14＋枠 6 を下限にする（見出しが1行なら 130.5 → 静的下限 148 のまま）。
      // ただし**掴んだ時点の値より上へは押し上げない**（既定 148 が既にこの下限を割っている
      // 1280×800 では「縮めようと掴んだら伸びる」になってしまう。その場合は縮まないだけ。
      // 副作用として、見出し2行のときは 149〜(下限−1) の帯（どれもサムネが帯に収まらない値）へは
      // ドラッグでは入れない＝ダブルクリックで 148 へ戻す。M11_17_report §6）
      const head = document.querySelector("#ed-tlhead") as HTMLElement | null;
      if (head) {
        const minHere = Math.ceil(head.getBoundingClientRect().height + 6 + 8 + 58.5 + 14 + 6);
        const floor = Math.min(minHere, this.splitDrag?.startVal ?? minHere, LAYOUT_RANGE[key][1]);
        val = Math.max(val, floor);
      }
    }
    return Math.round(val);
  }

  /** 3本のバーへ pointerdown / dblclick を配線する。mount のたびに呼ばれるので addEventListener でなく
   *  プロパティ代入（二重登録しない）。**touch-action: none は CSS 側で最初から**（.ed-split） */
  private bindSplitters() {
    const bind = (id: string, key: LayoutKey) => {
      const el = document.getElementById(id) as HTMLElement | null;
      if (!el) return;
      el.onpointerdown = (e) => this.startSplitDrag(e, key, el);
      el.ondblclick = (e) => {
        e.preventDefault();
        this.resetLayoutValue(key);
      };
      // 保険: ネイティブのドラッグ/選択が始まると pointermove を奪われる（M11-3 の実害）
      el.ondragstart = (e) => e.preventDefault();
    };
    bind("ed-split-tools", "toolsW");
    bind("ed-split-side", "sideW");
    bind("ed-split-tl", "tlH");
    // V158 (L-1): 右パネルの上下境界。**既存の仕組みにそのまま乗せる**ので、
    // ドラッグ・ダブルクリックで既定へ・Esc で取り消し・blur で確定・settings への保存が
    // 1行も書かずに付いてくる（横幅の境界とまったく同じ作法）
    bind("ed-side-vsplit", "sideTop");
  }

  /** ダブルクリック: その境界だけ既定値へ（誤ドラッグからの1発復帰）。変わったときだけ保存 */
  private resetLayoutValue(key: LayoutKey) {
    if (this.splitDisabled(key)) return; // M11-18: 畳んでいる間は無効
    this.finishSplitDrag(false); // 万一ドラッグ中なら畳んでから
    if (this.layout[key] === LAYOUT_DEFAULT[key]) return;
    this.layout[key] = LAYOUT_DEFAULT[key];
    this.applyLayout();
    this.cb.onLayoutChange?.({ ...this.layout });
  }

  /** M11-18: そのスプリッターが担当するパネルが畳まれているか（畳み中は掴めない・dblclick も無効） */
  private splitDisabled(key: LayoutKey): boolean {
    // V158 (L-1): 上下の境界は「右パネルが畳まれている」ときに加えて、
    // **どちらかの段を畳んでいるとき**も掴めない（畳んだ相手を引き伸ばしている最中なので）
    if (key === "sideTop") return this.isCollapsed("side") || this.sideFold.top || this.sideFold.bot;
    return this.isCollapsed(key === "toolsW" ? "tools" : key === "sideW" ? "side" : "tl");
  }

  private startSplitDrag(e: PointerEvent, key: LayoutKey, el: HTMLElement) {
    if (e.button !== 0) return; // 右/中ボタンでは掴まない（ペンの長押し右クリック化も含む）
    if (this.splitDrag) return;
    if (this.splitDisabled(key)) return; // M11-18: 畳んでいる間は無効（CSS の pointer-events:none の保険）
    e.preventDefault();
    // 掴んだポインタ以外（別の指・別のペン）のイベントは無視する（frameDrag と同じ）
    const mine = (ev: PointerEvent) => this.splitDrag?.pointerId === ev.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      // M11-5 の自己修復と同じ: ボタンが離れているのに move が来る＝up を取りこぼした → ここで畳む
      if (ev.buttons === 0) {
        this.finishSplitDrag(true);
        return;
      }
      this.updateSplitDrag(ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      // pointerup も pointercancel も「いまの位置で確定」。パネル寸法は途中値でも害が無く、
      // 巻き戻すと（ペンの接触が切れただけで）作者の意図した位置が失われる方が困る
      this.finishSplitDrag(true);
    };
    const onBlur = () => this.finishSplitDrag(true);
    this.splitDrag = {
      key,
      el,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startVal: this.layout[key],
      onMove,
      onUp,
      onBlur,
    };
    el.classList.add("on");
    // バーが掴めていれば、ウィンドウの外へ出ても move/up が届く（frameDrag は無捕捉だが、
    // スプリッターは細いので捕捉した方が「外れて止まる」が起きない）
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 合成イベント等で捕捉できなくても window リスナーで続行できる */
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onBlur);
  }

  private updateSplitDrag(ev: PointerEvent) {
    const d = this.splitDrag;
    if (!d) return;
    let raw: number;
    if (d.key === "toolsW") raw = d.startVal + (ev.clientX - d.startX);
    else if (d.key === "sideW") raw = d.startVal - (ev.clientX - d.startX);
    else if (d.key === "sideTop") {
      // V158 (L-1): % なので、動いた px を**その時のパネル高**で割って足す
      // （下へ引くと上段が広がる＝他の縦境界と手ざわりを揃える）
      const h = document.getElementById("ed-side")?.clientHeight || 1;
      raw = d.startVal + ((ev.clientY - d.startY) / h) * 100;
    } else raw = d.startVal - (ev.clientY - d.startY);
    const v = this.clampLayoutLive(d.key, raw);
    if (v === this.layout[d.key]) return;
    this.layout[d.key] = v;
    this.applyLayout(); // 見た目はリアルタイム。保存は finish のときだけ
  }

  /** ドラッグの終わり方はこの1経路（pointerup / pointercancel / blur / unmount / mount / Esc）。
   *  save=true なら、開始時から値が変わっていれば settings へ保存する */
  private finishSplitDrag(save: boolean) {
    const d = this.splitDrag;
    if (!d) return;
    window.removeEventListener("pointermove", d.onMove);
    window.removeEventListener("pointerup", d.onUp);
    window.removeEventListener("pointercancel", d.onUp);
    window.removeEventListener("blur", d.onBlur);
    try {
      d.el.releasePointerCapture(d.pointerId);
    } catch {
      /* すでに解放済み */
    }
    d.el.classList.remove("on");
    this.splitDrag = null;
    if (save && this.layout[d.key] !== d.startVal) this.cb.onLayoutChange?.({ ...this.layout });
  }

  /** Esc: 掴んだまま開始時の値へ戻して終わる（保存しない） */
  private cancelSplitDrag() {
    const d = this.splitDrag;
    if (!d) return;
    this.layout[d.key] = d.startVal;
    this.applyLayout();
    this.finishSplitDrag(false);
  }

  /** V154b (W-8): 少し待ってから進捗を出す（一瞬で終わる処理ではチラつかせない） */
  private showBusyAfterDelay(msg: string) {
    if (!this.busyKind || this.busyTimer || this.busyHide) return;
    this.busyTimer = window.setTimeout(() => {
      this.busyTimer = 0;
      if (!this.busyKind) return; // もう終わっていた
      this.busyHide = this.cb.busy?.(msg) ?? null;
    }, Editor.BUSY_DELAY_MS);
  }

  /** V154b (W-7): 重い処理の入口（保存・別名保存・書き出し）のボタンを、
   *  走っている間だけ押せなくする。**押せないことが見て分かる**のが要点で、
   *  実際の防御は `busyKind` の判定のほう（ボタン以外の経路もあるため）。 */
  private updateBusyButtons() {
    const busy = this.busyKind !== "";
    for (const sel of ["#ed-save", "#ed-saveas", "#ed-export"]) {
      const b = document.querySelector(sel) as HTMLButtonElement | null;
      if (b) b.disabled = busy;
    }
  }

  /** V154 (W-6): 保存を確定させずに失敗を伝える。**控えは一切捨てない**。 */
  private reportSaveBroken(where: string, reason: string, err?: unknown): false {
    this.cb.appendLog?.(`[V154 W-6] save not committed (${where}): ${reason}`);
    // V154b (W-10): 送ってもらえれば原因が分かる、と**その場で**伝える。
    // 独立レビュー（優先度 中）: 例外で落ちた保存はトーストだけで、**控えが残っていることも
    // ログのことも伝わっていなかった**。いちばん普通に起きる失敗（書き込めない等）なので、
    // そこにも同じ知らせを出す（文面だけ「読み戻したら壊れていた」と分ける）
    const head = err === undefined
      ? t("ed.file.saveBroken.msg")
      : t("ed.file.saveFailed.msg", { err: errText(err) });
    const msg = head + "\n" + t("ed.log.sendHint.msg");
    if (this.cb.notice) void this.cb.notice(msg);
    else this.cb.toast(msg);
    return false; // dirty は true のまま／オートセーブも残したまま
  }

  /** V199 (A-106): いまの作品の名前（ファイルがあればその名前・無ければ題名か「無題」） */
  titleNow(): string {
    return displayTitle(this.fileBase, this.project.meta.title, untitledTitle());
  }

  /** V199 (A-106): 編集画面の左上（#ed-title）を、いまの作品の名前にする（開いたとき・保存できたとき）。
   *  長い名前は CSS の省略（`.h-title` の ellipsis）＝ライブラリの表示と同じ。全文は title で見える */
  private refreshTitle() {
    const el = document.querySelector("#ed-title") as HTMLElement | null;
    if (!el) return;
    const name = this.titleNow();
    setIconLabel(el, "pen", name); // V171: ✏ → pen（線画）
    el.title = name;
  }

  /** @param explicit V201: 明示の「別名で保存」（saveAs からだけ渡す）。保存の種類は部品へ明示で渡す
   *   （askSaveTarget だけでは分からない＝新規メモ・オートセーブからの復元・ドロップから編集も保存先を選ぶ） */
  async save(explicit?: "saveAs", redirect?: { album: string; baseName: string }): Promise<boolean> {
    // V154b (W-7) → V161 (A): 飛行中の保存要求は、捨てずに**1件だけ予約**する。
    // 保存中も描けるようになった＝「描いてからもう一度 Ctrl+S」が普通に起きる。
    // 捨てると「押したのに最新の絵が保存されていない」になる。連打しても予約は1件
    //（完了後に**そのときの最新の姿**で1回だけ走り直す）。W-7 が恐れたメモリの山は
    // 立たない——予約は「あとでもう一度」であって、二本目のエンコードを並走させない
    if (this.saveInFlight) {
      this.saveQueued = true;
      return this.saveInFlight;
    }
    if (this.saveBlocked()) return false; // ★V214: 重い処理の最中・変形の途中（関所）の判断はコアの saveBlocked（順は前と同じ）
    // ★V216b (A-126): 保存先を決めて、同じ名前の作品が在れば**書く前に**確かめる（キャンセル＝何も変えない）
    //  確かめている間（空きを聞く・画面を出す）に来た保存は、予約に回す（2 本目を並べない）。キャンセルなら予約も捨てる
    if (this.savePlanning) {
      this.saveQueued = true;
      return false;
    }
    this.savePlanning = true;
    let plan: Awaited<ReturnType<Editor["planSaveTarget"]>>;
    try {
      plan = await this.planSaveTarget(explicit, redirect);
    } finally {
      this.savePlanning = false;
    }
    if (!plan) {
      this.saveQueued = false;
      return false;
    }
    const kind: SaveKind = plan.kind;
    if (plan.picked) {
      // 確かめが済んでから保存先を替える（キャンセルでは保存先も ID も替わらない＝要件 §2-1 の 3）
      this.saveCtx = plan.ctx;
      // ★V201 (P-1): 別名で保存は、保存先が替わった**この時点**で新しい作品の ID を入れる（版は 0 から＝次に書くと 1）。
      //  このあと写しの見積りで断られても・書けなくても、新しい保存先には新しい ID（ID と版を保存先に結び付ける）
      if (kind === "saveAs") bindNewWorkId(this.project);
    }
    // V161 (A): ここから先は**背景**で走る。編集ロックはかけない（W-9 は保存では外した・要件）。
    // 中央の「保存中です」も出さない——右下の控えめなピルに変えた（描いている手を止めない）
    // V216b: 「置き換えてよい」は確かめたこの宛先とこの 1 回の書き込みだけ（予約した次の保存へ持ち越さない）
    const job = this.runBackgroundSave(kind, plan.replace);
    this.saveInFlight = job;
    let ok = false;
    try {
      ok = await job;
    } finally {
      this.saveInFlight = null;
      this.updateSavePill(false);
      // V216b: 書く所の確かめで［別の名前で保存］→ 保存先を選ぶ画面を開き直す（予約は捨てる＝画面が 2 つ出ない）
      if (this.saveRedirect) this.saveQueued = false;
      // W-7 の進化: 予約が入っていれば、**そのときの最新の姿**でもう一度（1件だけ）。
      // setTimeout で1拍置くのは、この finally の中から save() を再入させないため
      if (this.saveQueued && this.mounted) {
        this.saveQueued = false;
        setTimeout(() => void this.save(), 0);
      }
    }
    const re = this.saveRedirect;
    this.saveRedirect = null;
    if (re && this.mounted) return this.save(explicit, re);
    return ok;
  }

  /** ★V216b (A-126・要件 §2-1 の 2〜6): 保存先を決める。選ぶ画面を出すときは出し、宛先に同じ名前の作品（か控え）が在れば
   *  ［別の名前で保存］［置き換える］［キャンセル］を聞く。**何も変えない**（保存先を替えるのは呼び出し側＝確かめが済んでから）。
   *  null＝キャンセル。`picked`＝保存先を選び直した（saveCtx を替える）。`replace`＝［置き換える］を選んだ */
  private async planSaveTarget(
    explicit: "saveAs" | undefined,
    redirect: { album: string; baseName: string } | undefined
  ): Promise<{ ctx: EditorSaveContext; kind: SaveKind; picked: boolean; replace: boolean } | null> {
    let pick = !!redirect || this.askSaveTarget || !this.saveCtx;
    let ctx: EditorSaveContext | null = this.saveCtx;
    let kind: SaveKind = "overwrite";
    // F-4: 既存アルバムのピッカー（＋新規フォルダ作成）で保存先を選ぶ
    // M12-D: 保存済みのアルバムがあればそれ、無ければ **null（おまかせ）**。
    // 以前は既定名の文字列を作って渡し、受け側が文字列比較していた
    let defAlbum = redirect?.album ?? this.saveCtx?.album ?? null;
    // V199 (A-106): 保存先が未定のとき（ドロップで開いた等）も、名前の分かるファイルならその名前
    let defName =
      redirect?.baseName ??
      this.saveCtx?.baseName ??
      exportBaseName(this.fileBase, this.project.meta.title, untitledTitle());
    for (;;) {
      if (pick) {
        // 名前の既定は main.ts の画面が空いている名前にする（§2-1 の 6）
        const picked = await this.cb.pickSaveTarget(defAlbum, defName);
        if (!picked) return null;
        ctx = { libRoot: this.saveCtx?.libRoot ?? "", album: picked.album, baseName: picked.baseName };
        kind = explicit === "saveAs" ? "saveAs" : "first";
      }
      const target = ctx!;
      const st = await this.saveTargetStatusOf(target);
      if (st === "taken" || st === "reserved") {
        const c = await this.askSameName(target, st);
        if (c === "replace") return { ctx: target, kind, picked: pick, replace: true };
        if (c === "other") {
          // 同じアルバム・空いている名前の案（`名前 (2)`〜）で選ぶ画面を開き直す
          pick = true;
          defAlbum = target.album;
          defName = target.baseName;
          continue;
        }
        return null;
      }
      return { ctx: target, kind, picked: pick, replace: false };
    }
  }

  /** V216b: 宛先の空き（口が無い・失敗は "free" とみなして進む＝書く所で Rust が置き換えずに断り、もう一度確かめる） */
  private async saveTargetStatusOf(ctx: EditorSaveContext): Promise<SaveTargetStatus> {
    if (!this.cb.saveTargetStatus) return "free";
    try {
      return await this.cb.saveTargetStatus(ctx, this.workFile?.path ?? null);
    } catch {
      return "free";
    }
  }

  /** V216b (要件 §5): 同じ名前の確かめ。在る＝［別の名前で保存］［置き換える］／控えだけ＝［別の名前で保存］だけ。
   *  背景を押した・キャンセル＝null（聞けない呼び出し側では置き換えない＝null） */
  private async askSameName(ctx: EditorSaveContext, st: "taken" | "reserved"): Promise<"other" | "replace" | null> {
    if (!this.cb.choose) return null;
    const name = savedFileBase(ctx.baseName);
    const options =
      st === "taken"
        ? [t("ed.save.exists.other.btn"), t("ed.save.exists.replace.btn")]
        : [t("ed.save.exists.other.btn")];
    const msg = st === "taken" ? t("ed.save.exists.msg", { name }) : t("ed.save.reserved.msg", { name });
    const i = await this.cb.choose(msg, options);
    return i === 0 ? "other" : i === 1 && st === "taken" ? "replace" : null;
  }

  /** V161 (A/B): 背景保存の本体。
   *
   *  ★スナップショットは `worker.postMessage` の structured clone がその場で取る——
   *   postMessage は**同期的に**全体を写し取るので、それ以後の編集はこの保存に混ざらない
   *  （V160 S-2 で実証: 眠り控えの z は生成後不変・破棄は参照の付け替えなので clone は安全。
   *   起きている生バッファと音声データは clone がコピーする）。
   *
   *  ★形式は **PV6 だけ**（V197 (A-103)・作者決定 2026-10-07）: Worker が完成品（68.7MB 級）を1回で返す
   *   ＝V161-B の Rust 側 gzip（チャンク集積）は V163 で撤去済み。V163 の旧形式（PV5・`saveCtx.legacy` の
   *   "gzip" モード）は V197 でなくした。書き込みは Rust の `pclib::save_project`（tmp→.bak→rename→照合＝W-1 不変）。
   *
   *  ★検証（C・要件の裁定）: 書く前の重複検証は落とし、**ディスクから読み戻す側だけ**残す
   *  （W-6 の魂＝「書けたものが読めるか」。Rust 側の byte 照合はその手前で従来どおり効いている） */
  private async runBackgroundSave(kind: SaveKind, replaceConfirmed = false): Promise<boolean> {
    const t0 = performance.now();
    const ctx = this.saveCtx!;
    // V216b: 書く所の確かめでキャンセル／［別の名前で保存］を選んだ（知らせを出さずに抜ける）
    let declined = false;
    // V216b: 書いたファイルの大きさと更新時刻（書いた直後に引いて、書けて確かめも通ったらその作品のファイルに控える）
    let writtenStamp: { size: number; mtimeUs: number } | null = null;
    try {
      const worker = this.ensureSaveWorker();
      const seq = ++this.saveSeq;
      // ★V201 (M-1a): 手順そのもの（書く値をそろえる → 基準点 → 写し → サムネ → 書く → 読み戻し → 途中の描き足しの判断）は
      //  共通の部品 `saveWork`（saveCore.ts）へ移した。ここに残すのは編集画面にしかない所（眠らせの待ち・段の表示・
      //  dirty と editEpoch・オートセーブの世代・左上の名前・トースト）と、それを部品へ渡す口だけ
      // ★V168 (S-1〜S-3): **写す前に見積もり、大きければ掃除を待ち、それでも大きければ断る。**
      //  2026-09-02: 56,860面（実際に使っている量 2.6GB）の写しが Chromium の実効上限 約2GiB を超え、
      //  `Data cannot be cloned, out of memory.` で失敗した。写しは確保である。
      //  見積りは部品の `prepare` の口＝**基準点より前**なので、基準点→写しに await 無しの約束は破らない。
      //  編集は止めない（V161-A）——掃除は描いている合間に只のものだけ進む。
      //  ピルはこの時点から出す（待ちが長いときに「押したのに何も出ない」を作らない）
      this.updateSavePill(true);
      const r = await saveWork({
        project: this.project,
        kind,
        baseName: ctx.baseName,
        // サムネのコマは見積りを待ったあとのいまのコマ（待っている間にコマを移ったら移った先＝V201 の前と同じ）
        currentFrame: () => this.frameIndex,
        // 断ったら reportSnapshotTooBig が知らせ・ログ済み。dirty は残る
        prepare: async () => (await this.prepareSnapshot()) !== null,
        // ★基準点: 部品がここで編集の回数を控える（dirty 漏斗の editEpoch）
        markEdits: () => {
          const epoch0 = this.editEpoch;
          return () => this.editEpoch !== epoch0;
        },
        // 写しは Worker への postMessage の structured clone（部品の encodeViaWorker がリスナーを先に張る）
        encode: (p) => encodeViaWorker(worker, seq, p),
        afterSnapshot: () => {
          this.setSavePhase("save"); // V168: 写しに入った＝ピルは従来の「保存中」へ
          this.updateSavePill(true);
        },
        // サムネは写しの直後に、いまの作品から描く（部品が写しのあとに呼ぶ）
        thumb: async (p) => {
          const blob = await frameToPngBlob(p, p.thumbFrame ?? 0);
          const thumb = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
          return thumb;
        },
        // ★V216b (A-126 §2-1 の 5): 書く所（Rust）でも置き換えない。確かめのあとに同じ名前ができていたら「在る」と断られるので、
        //  もう一度確かめる。［置き換える］は写しを作り直さずに同じ中身で書き直す。［別の名前で保存］・キャンセルは何も書かずに抜ける
        //  （保存先と ID は替わったまま＝V201 の決まり・その作品のファイルは替えない）
        write: async (w) => {
          let replace = replaceConfirmed;
          for (;;) {
            try {
              const path = await this.cb.saveProject(ctx, w.data, w.thumb, {
                workFile: this.workFile?.path ?? null,
                replace,
              });
              writtenStamp = await this.readWorkFileStamp(path);
              return { path };
            } catch (e) {
              const kindHit = saveExistsKind(e);
              if (!kindHit) throw e;
              this.saveAsking = true;
              let c: Awaited<ReturnType<Editor["askSameName"]>>;
              try {
                c = await this.askSameName(ctx, kindHit);
              } finally {
                this.saveAsking = false;
              }
              if (c === "replace" && !replace) {
                replace = true;
                continue;
              }
              declined = true;
              if (c === "other") this.saveRedirect = { album: ctx.album, baseName: ctx.baseName };
              throw new Error("save declined");
            }
          }
        },
        // V154 (W-6): 読み戻せなければ（口が無い・巨大すぎて読めない）部品が検査を省いて通す
        readBack: this.cb.readSavedFile ? (w) => this.cb.readSavedFile!(w.path) : undefined,
        onCommitted: (w) => {
          this.askSaveTarget = false;
          // ★V216b (A-126): その作品のファイル＝書いたファイル（Rust が返したパス）。次からはここへの上書きは確かめない
          this.workFile = { path: w.path, size: writtenStamp?.size ?? null, mtimeUs: writtenStamp?.mtimeUs ?? null };
          // ★V199 (A-106): いまのファイル＝書いたファイル。別名で保存したら左上も**すぐ**新しい名前に
          this.fileBase = baseFromSavedPath(w.path) ?? savedFileBase(ctx.baseName);
          this.refreshTitle();
        },
        onSettled: async () => {
          // 保存中に編集が無かった＝ファイルは最新。従来どおり確定する
          this.dirty = false;
          // 進行中の古いオートセーブが保存後に復活しないよう世代を進めてから消す
          await this.invalidateAutosave();
        },
        log: (line) => void this.cb.appendLog?.(line),
      });
      if (!r.ok) {
        if (r.stage === "refused") return false; // 断った（知らせ・ログ済み。dirty は残る）
        return this.reportSaveBroken(r.stage, r.reason);
      }
      const path = r.written.path;
      this.cb.appendLog?.(
        `[V161] save ok frames=${r.frames} fmt=pv6 ms=${Math.round(
          performance.now() - t0
        )}`
      );
      // 独立レビューの指摘③: 保存中に描いた人が「いまの絵まで保存された」と誤解しないよう、文言を分ける（どちらかは部品が決める）
      this.cb.toast(
        r.notice === "saved"
          ? t("ed.file.saved.toast", { path })
          : t("ed.file.savedPartial.toast", { path })
      );
      this.cb.onSaved(path);
      return true;
    } catch (e) {
      if (declined) return false; // V216b: 書く所の確かめで書かないことを選んだ（知らせない・未保存の印は残る）
      return this.reportSaveBroken("exception", String(e), e);
    } finally {
      // V159 (G-1): 保存にかかった時間（保存先ピッカーを待った時間は `t0` の位置ゆえ入らない）。
      // 失敗しても測る——「失敗するまでに何秒待たされたか」も知りたい。
      // ★V168: この時間は**掃除の待ち（prepare）を含む**（§1-i-2: 報告書に「何を含む時間か」）
      perfDone("save", t0);
      this.savePhase = ""; // V168: 段階を畳む（次の保存は "" から始まる）
    }
  }

  /** V216b (A-126): 書いたファイルの大きさと更新時刻（オートセーブの印）。分からなければ null（印を書かない＝戻すと「無い」） */
  private async readWorkFileStamp(path: string): Promise<{ size: number; mtimeUs: number } | null> {
    if (!this.cb.workFileStamp) return null;
    try {
      return await this.cb.workFileStamp(path);
    } catch {
      return null;
    }
  }

  /** V161 (A): 保存が終わるまで待つ（その間だけ中央表示）。
   *  **閉じる・別のメモへ移る・書き出しを始める前に必ず呼ぶ**（要件 A）。
   *  予約（saveQueued）は取り消す——ここから先は画面を離れる操作で、予約の中身
   * （保存中に描いた分）が未保存でも dirty が残っているので、離脱確認が必ず拾う。 */
  async waitForSave(): Promise<void> {
    if (!this.saveInFlight) return;
    this.saveQueued = false;
    // ★V216b（第三者レビュー）: 書く所の確かめを出している間は、中央の表示（モーダル）を重ねない（重ねると確かめが押せず、保存が終わらない）。
    //  確かめに答えると保存が終わるので、ここは待つだけ
    if (this.saveAsking) {
      await this.saveInFlight.catch(() => {});
      return;
    }
    // V168 (S-2): 掃除待ちの最中なら**同じ段階の文言**を出す（固まって見せない・文言の源は1つ）。
    // ★独立レビューの指摘（中）: ここはモーダル（背面に触れない）なので「描き続けられます」とは言わない
    //  ＝`savePhaseText("central")`。中央表示の文字は `renderSavePhase` が段階と進みに合わせて書き換える
    const hide = this.cb.busy?.(this.savePhaseText("central"));
    // 箱は次のタスクで DOM に入るので、1拍おいてから「これは保存の段階表示」と印を付ける
    setTimeout(() => {
      const msg = document.querySelector(".busy-box .busy-msg") as HTMLElement | null;
      if (msg && this.saveInFlight) {
        msg.dataset.savePhase = "1";
        this.renderSavePhase();
      }
    }, 0);
    try {
      await this.saveInFlight.catch(() => {});
    } finally {
      hide?.();
    }
  }

  /** V168 (S-2): 段階を変えて、出ている表示を揃える。 */
  private setSavePhase(ph: "" | "prepare" | "save"): void {
    this.savePhase = ph;
    this.renderSavePhase();
  }

  /** V168 (S-2): 掃除待ちの進みが止まって見えているか（描き続けている間は只のものしか片づかない）。
   *  ★独立レビューの指摘（中）: 「そのまま描き続けられます」だけだと、数字が止まったときに固まったと誤解される。
   *  数秒進まなかったら「手を離した合間に片づけが進みます」へ切り替える。 */
  private savePrepStalled = false;
  /** V168: 進みが止まったと見なすまでの時間（ms）。掃除は1コマ数十 ms なので、3 秒動かなければ描いている最中 */
  private static readonly SAVE_PREP_STALL_MS = 3000;

  /** V168 (S-2): **ピルと中央表示の文言はここ1つから**（源は1つ）。
   *  @param where "pill"=右下（触れる・描ける）／"central"=`waitForSave` のモーダル（**触れない**）。
   *  ★独立レビューの指摘（中）: 中央表示はモーダルで背面が遮られるので「描き続けられます」と言ってはいけない。
   *   同じ関数の中で出し分ける＝文言の置き場は1つのまま。 */
  private savePhaseText(where: "pill" | "central" = "pill"): string {
    if (this.savePhase !== "prepare") return where === "central" ? t("ed.save.wait.label") : t("ed.save.bg.label");
    const v = { n: this.savePrep.n, total: this.savePrep.total };
    if (where === "central") return t("ed.save.prepareWait.msg", v);
    return this.savePrepStalled ? t("ed.save.prepareStalled.msg", v) : t("ed.save.prepare.msg", v);
  }

  /** V168 (S-2): ピル（右下）と、出ていれば中央表示（`waitForSave`）の文字を今の段階に揃える。 */
  private renderSavePhase(): void {
    const span = document.querySelector("#ed-savepill span") as HTMLElement | null;
    if (span) span.textContent = this.savePhaseText("pill");
    const msg = document.querySelector(".busy-box .busy-msg[data-save-phase]") as HTMLElement | null;
    if (msg) msg.textContent = this.savePhaseText("central");
  }

  /** V161 (A): 保存 Worker（遅延生成）。 */
  private ensureSaveWorker(): Worker {
    if (!this.saveWorker) {
      this.saveWorker = new Worker(new URL("./saveWorker.ts", import.meta.url), {
        type: "module",
      });
    }
    return this.saveWorker;
  }

  /** V161 (A): 右下の保存ピル。300ms 遅れて出す（一瞬で終わる小さい作品でチラつかせない）。 */
  private updateSavePill(on: boolean) {
    const el = document.getElementById("ed-savepill");
    if (!el) return;
    if (on) {
      if (this.savePillTimer) return;
      this.savePillTimer = window.setTimeout(() => {
        this.savePillTimer = 0;
        if (this.saveInFlight) {
          this.renderSavePhase(); // V168: 段階に合った文言で出す（掃除待ちなら「保存の準備…」）
          el.hidden = false;
        }
      }, 300);
    } else {
      if (this.savePillTimer) {
        clearTimeout(this.savePillTimer);
        this.savePillTimer = 0;
      }
      el.hidden = true;
    }
  }

  /** 別名保存（M3.3-A）: ピッカーを強制して save() へ。以降の保存は新ファイルへ向く。
   *  ピッカーをキャンセルした場合は元のフラグへ戻す（次の Ctrl+S が別名扱いにならないように） */
  async saveAs() {
    // V161（独立レビューの指摘①）: 飛行中に押すと `save()` が予約へ回し、**ピッカーを出さないまま
    // いつもの保存先に保存**されてしまう（利用者は「別名で保存した」と思っている）。
    // 先に飛行中の保存を待つ（そのときだけ中央表示が出る＝閉じるときと同じ見え方）
    await this.waitForSave();
    const prev = this.askSaveTarget;
    this.askSaveTarget = true;
    const ok = await this.save("saveAs");
    if (!ok) this.askSaveTarget = prev;
  }

  // ---------------- キャンバス表示 ----------------

  private applyZoom() {
    if (!this.mounted) return;
    // ★V195 (A-98): 倍率・回転・反転・窓の大きさを変える**前に**、窓の真ん中に見えている絵の点を控える
    //  （置き直したあとも同じ点を真ん中に置く＝見ていた場所が飛ばない）
    const anchor = this.panAnchorNow();
    const stage = $("#ed-stage");
    const wrap = $("#ed-cvwrap");
    const availW = stage.clientWidth - 40;
    const availH = stage.clientHeight - 40;
    // V195b: 全体表示の倍率は stagePan.fitZoom（式は今までと同じ）。余白を付けるかの境目（panNeeded）も同じ物差し
    const z = this.zoomMode === "fit" ? fitZoom(availW, availH, this.viewRot) : this.zoomMode;
    wrap.style.width = `${W * z}px`;
    wrap.style.height = `${H * z}px`;
    // V195 (A-98): 回転の transform を先に当ててから余白を置く（置くときに古い回転のはみ出しを読まない）
    this.applyViewTransform();
    // V195 (A-98)・V195b: 見た目の絵が窓からはみ出す倍率のときだけ、絵の周りに窓の半分ずつの余白
    this.layoutPan(z, anchor, availW, availH);
    setIconLabel($("#ed-zoominfo"), "zoom", t("ed.view.zoominfo.label", { zoom: `${z}.0` })); // V171: 🔍 → zoom
    // E-2/M3.10 G-1: ピクセル格子（1ドット≥8pxで表示・実測ピッチで再描画）
    this.updateGridOverlay(z);
    // M12-C: カーソル層も同じ寸法で取り直す（格子と同じ集約点に乗せる）。
    // 指紋を捨ててから描き直すので、ズーム後に古い大きさの輪が残らない
    // ★V209 (A-122): 最後のポインタの位置から引き直す（拡大縮小・回転反転のあと、ポインタを動かさなくても枠はポインタの下に）
    this.syncCursorFrame();
    // M13-2b (T-6): 変形・四隅の枠とハンドルの層も同じ寸法で取り直す（ぼけない・ずれない）
    this.paintUiOverlay();
    // V208 (A-119): 範囲選択の線の層も同じ寸法で取り直す（線は格子と同じ式で物理 px に丸める）
    this.paintSelectionUi();
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

  // ---------------- M12-C: カーソル（1階＝CSS / 2階＝#ed-cursor レイヤー） ----------------

  /** M12-C: キャンバスから出たらカーソル層を消す（点が置き去りにならないように） */
  private cursorLeaveHandler = (ev?: Event) => {
    const e = ev as PointerEvent | undefined;
    this.cursorDot = null;
    // ★V209 (A-122): 外枠から出たら引き直す位置も無い。ただし、ポインタはまだ外枠の上で、上に出た別の要素（変形のモードの札など）へ
    //  移っただけのときは位置を残す（その札が消えたあと、変形を Enter で抜けた直後などに枠をポインタの下へ出し直すため）
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    const r = e && wrap ? wrap.getBoundingClientRect() : null;
    const inside = !!r && !!e && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
    if (!inside) this.cursorClient = null;
    this.cancelCursorFrame();
    this.clearCursorLayer();
  };

  /** M12-C: 予約した rAF を畳む */
  private cancelCursorFrame() {
    if (this.cursorRaf != null) {
      cancelAnimationFrame(this.cursorRaf);
      this.cursorRaf = null;
    }
  }

  /** M12-C: 設定を受け取って反映する（`restoreMiniDock` と同じ流儀）。 */
  restoreCursor(v: unknown) {
    this.cursorCfg = sanitizeCursor(v);
    // 2階が両方 OFF なら **ホバーの経路に一切入らない**（M11-24 と同じ早期 return に戻す）
    this.cursorLive = this.cursorCfg.ring || this.cursorCfg.cell;
    if (!this.mounted) return;
    this.applyCanvasCursor();
    this.cursorPainted = "";
    if (!this.cursorLive) {
      this.cursorDot = null;
      this.cancelCursorFrame();
      this.clearCursorLayer();
    } else {
      this.syncCursorFrame(); // ★V209 (A-122): 最後のポインタの位置から（設定を変えた直後もポインタの下に枠と none）
    }
  }

  /** M12-C: 1階。`#ed-canvas` の cursor を今のツールと設定から決める。
   *  `null`（手のひら・変形）のときは**代入しない**＝既存の見た目のまま。 */
  private applyCanvasCursor() {
    const cv = document.querySelector("#ed-canvas") as HTMLElement | null;
    if (!cv) return;
    const s = cursorFor(this.tool, this.cursorCfg.style);
    // M12-G: `null` は「触らない」＝変形のように**当たり判定ごとに変わる**もの。
    // ここで空にすると、ホバーで決まったカーソルを消してしまう
    if (s !== null) cv.style.cursor = s;
  }

  /** M12-G: 手のひら・変形の**動的なカーソル**を `#ed-canvas` にも出す。
   *
   *  従来は `#ed-cvwrap` にしか代入しておらず、`#ed-canvas { cursor: crosshair }` が
   *  継承に勝つので**枠の 4px にしか出ていなかった**（M12-C §2-a の実測で判明）。
   *  M11-24 で変形の当たり判定を直したのに、それを伝える手がかりが見えていなかった。
   *
   *  **`#ed-cvwrap` への代入は残したまま**、キャンバスへの代入を足している
   *  （枠の 4px の見え方を v1.2.0 から変えないため）。
   *  値は `xformHitTest` の返り値をそのまま流すだけで、**判定も文字列も触らない**。 */
  private setCanvasCursor(value: string) {
    const cv = document.querySelector("#ed-canvas") as HTMLElement | null;
    if (!cv) return;
    cv.style.cursor = canvasCursorFor(value, this.cursorCfg.style);
  }

  /** M12-C: ポインタの位置を覚えて、**1フレームに1回だけ**描き直す。
   *  ドット位置が前フレームと同じなら `clearRect` すらしない（ホバーは元々ただの早期 return
   *  だった経路なので、足したぶんがそのまま新規コストになる）。 */
  private trackCursor(e: PointerEvent) {
    const pt = this.clientToPixel(e.clientX, e.clientY);
    if (this.cursorDot && this.cursorDot.x === pt.x && this.cursorDot.y === pt.y) return;
    this.cursorDot = pt;
    if (this.cursorRaf != null) return; // すでにこのフレームぶんは予約済み
    this.cursorRaf = requestAnimationFrame(() => {
      this.cursorRaf = null;
      this.paintCursorLayer();
    });
  }

  private clearCursorLayer() {
    // ★V209 (A-122): 枠を消すところで 1 階も戻す（枠を消すのと点に戻すのを同じ所で＝何も見えない瞬間を作らない）
    this.setFrameCursor(false);
    const cv = document.querySelector("#ed-cursor") as HTMLCanvasElement | null;
    if (!cv || cv.hidden) return;
    cv.hidden = true;
    this.cursorPainted = "";
  }

  /** ★V209 (A-122): いま 1 階を none にしているか（枠を出している間だけ真） */
  private frameCursorOn = false;
  /** ★V209 (A-122): 最後のポインタの位置（クライアント座標）。枠を出し直すときに引き直す（パン・拡大縮小・スクロール・回転・反転・
   *  変形の確定・Space を離したあと、ポインタを動かさなくても枠がポインタの下に出る）。外枠から出たら null */
  private cursorClient: { x: number; y: number } | null = null;

  /** ★V209 (A-122・REQ §2 (2)): 1 階の決まりは 1 つ——**枠を出している間は none、出していない間は none でない**。
   *  枠を出すのと点を消すのを同じ所で、枠を消すのと点に戻すのを同じ所で行う。
   *  描いている間（#ed-cvwrap が掴んでいる間）は掴んだ要素のカーソルが出るので、#ed-cvwrap も none にする。
   *  ⚙ の形が「十字」「矢印」の人は none にしない（枠だけ新しい形）。
   *  **戻すのは枠を出していた状態から消すときだけ**（消す道を通るたびに外枠を書き直すと、変形のドラッグ中に
   *  beginTransformDrag が入れた当たり判定のカーソルを消す）。戻し先は updatePanCursor と同じ決め方 */
  private setFrameCursor(on: boolean) {
    const cv = document.querySelector("#ed-canvas") as HTMLElement | null;
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (on && this.cursorCfg.style === "dot") {
      if (cv && cv.style.cursor !== "none") cv.style.cursor = "none";
      if (wrap && wrap.style.cursor !== "none") wrap.style.cursor = "none";
      this.frameCursorOn = true;
      return;
    }
    if (!this.frameCursorOn) return;
    this.frameCursorOn = false;
    const panning = !!this.panState;
    const hand = this.tool === "hand" || this.spaceHeld;
    if (wrap) wrap.style.cursor = panCursorFor(panning, hand);
    if (this.tool === "transform" || this.xformActive) {
      // 変形に入った（貼り付け・画像の配置・ツールの切り替え）: キャンバスが none なら、その位置の当たり判定のカーソルに
      //（当たらなければ空＝CSS の十字）。以後、変形中は外枠に触らない（frameCursorOn は偽のまま）
      if (cv && cv.style.cursor === "none") this.setCanvasCursor(this.cursorDot && this.floatBuf ? this.xformHitTest(this.cursorDot).cursor : "");
      return;
    }
    if (panning) this.setCanvasCursor("grabbing");
    else if (hand) this.setCanvasCursor("grab");
    else this.applyCanvasCursor();
  }

  /** ★V209 (A-122): 枠と 1 階をその場で決め直す。最後のポインタの位置から引き直して描く（引き直せなければ枠を出さずに 1 階を戻す）。
   *  Space の押す・離す・blur（updatePanCursor）・ツールの替わり（updateToolButtons＝setTool・貼り付け・画像の配置・endTransform）・
   *  restoreCursor・拡大縮小と回転反転（applyZoom）・スクロールから呼ぶ */
  private syncCursorFrame() {
    if (!this.mounted) return;
    const c = this.cursorClient;
    this.cursorDot = c ? this.clientToPixel(c.x, c.y) : null;
    this.cursorPainted = "";
    this.paintCursorLayer();
  }

  /** M12-C: 2階の描画。**ここから `redrawOverlay()` を絶対に呼ばない**
   *  （選択範囲があると 320×240=76,800 回のループ＋ImageData 生成が走るため）。
   *
   *  バッキングの確保も1ドットの物理px幅も `updateGridOverlay` と**同じ式**にしてあるので、
   *  ドット枠は格子の線とピッタリ重なる（半ドットずれない）。 */
  private paintCursorLayer() {
    const cv = document.querySelector("#ed-cursor") as HTMLCanvasElement | null;
    const canvas = document.querySelector("#ed-canvas") as HTMLCanvasElement | null;
    if (!cv || !canvas) return;
    const dot = this.cursorDot;
    const show =
      this.cursorLive &&
      !!dot &&
      !cursorLayerHidden(this.tool) &&
      // ★V209 (A-122): Space を押している間（押した瞬間から）・パン中は枠を出さない（手のひらのカーソルを none で上書きしない）
      !this.spaceHeld &&
      !this.panState &&
      dot.x >= 0 &&
      dot.y >= 0 &&
      dot.x < W &&
      dot.y < H;
    if (!show) {
      this.clearCursorLayer();
      return;
    }
    // ★V209 (A-122): 枠は**実際に塗る太さ**で描く（ブラシは 3 より細く塗らない＝penOptions と同じ）
    const size = paintedSize(this.tool, this.penSize);
    const ring = this.cursorCfg.ring && hasRing(this.tool);
    // ★V178 (A-72・決-3 ②): 全レイヤー消しゴムのときだけ、枠の外側にもう 1 組（二重線）。
    //  太さの枠はそのまま＝消える範囲は変わらない。輪を切っている設定なら二重線も出さない（輪の飾りなので）
    const dbl = ring && this.eraseAllOn();
    // ★V209 (A-122): 乗っているドットの枠は、同じ位置に新しい枠を描いているとき（輪オンのペン・消しゴムで塗る太さが 1）だけ出さない
    const cell = this.cursorCfg.cell && !(ring && size === 1);
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    if (!cssW || !cssH) {
      this.clearCursorLayer();
      return;
    }
    // ★V209 (A-122): 枠を出す所で 1 階を none に（同じ所＝何も見えない瞬間を作らない）
    this.setFrameCursor(ring);
    // 同じ絵をもう一度描かない（位置・太さ・ツール・寸法が全部同じなら何もしない）
    const key = `${dot!.x},${dot!.y},${size},${ring ? 1 : 0}${dbl ? "d" : ""},${cell ? 1 : 0},${cssW}x${cssH}`;
    if (key === this.cursorPainted && !cv.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    cv.hidden = false;
    ctx.clearRect(0, 0, pw, ph);
    const px = (cssW * dpr) / W; // 1ドットの物理px幅（updateGridOverlay と同じ）
    const py = (cssH * dpr) / H;
    const L = (dx: number) => Math.round((dot!.x + dx) * px);
    const T = (dy: number) => Math.round((dot!.y + dy) * py);
    // ★V209 (A-122): ペン先の枠: 塗られるドットの集まりの**外側**に、内側が黒・外側が白の 2 本線（中は何も描かない・位置で色を変えない）。
    //  全レイヤー消しゴムは、さらに外側に間を空けてもう 1 組（外側の組を先に描く＝中を空ける描き方で内側の枠を消さない）
    if (ring) {
      const lw = frameLineWidth(dpr);
      // 輪との間隔（物理 px）。細い線 2 組が離れて見える最小限（dpr 1 で 3px の隙間・V178 と同じ）
      const g = dbl ? Math.max(3, Math.round(3 * dpr)) : null;
      for (const op of cursorFrameOps(size, L, T, lw, g)) {
        if (op.kind === "fill") {
          ctx.fillStyle = op.color;
          for (const r of op.rects) ctx.fillRect(r.x, r.y, r.w, r.h);
        } else for (const r of op.rects) ctx.clearRect(r.x, r.y, r.w, r.h);
      }
    }
    // ドット枠: カーソル直下の1ドットを囲む（格子と同じ Math.round(i*px) の位置に乗る・ドットの内側の縁＝枠の中を空けたあとに描く）
    if (cell) {
      const x0 = L(0), x1 = L(1), y0 = T(0), y1 = T(1);
      ctx.fillStyle = antColor(dot!.x, dot!.y);
      ctx.fillRect(x0, y0, x1 - x0, 1);
      ctx.fillRect(x0, y1 - 1, x1 - x0, 1);
      ctx.fillRect(x0, y0, 1, y1 - y0);
      ctx.fillRect(x1 - 1, y0, 1, y1 - y0);
    }
    this.cursorPainted = key;
  }

  /** ★V195 (A-98): いま窓の真ん中に見えている絵の点（絵の座標・小数）。
   *  パンしている（全体表示でない・大画面でない）ときは、**最後に置いた形とスクロール位置だけ**から出す
   *  （DOM の矩形は読まない＝回転を変えた直後・大画面へ切り替えた直後でも、置いたときの形で正しく読める）。
   *  大画面のあいだは入る前に控えた点。全体表示は絵が真ん中にあるので null（＝絵の真ん中）。 */
  private panAnchorNow(): { x: number; y: number } | null {
    if (this.panGeom) {
      const sc = document.querySelector("#ed-scroll") as HTMLElement | null;
      if (sc) return anchorAt(this.panGeom, sc.scrollLeft, sc.scrollTop);
    }
    return this.panHeld;
  }

  /** ★V195 (A-98・REQ-006): 拡大して**見た目の絵が窓からはみ出すとき**は、**絵のどの点でも（四隅を含めて）
   *  窓の真ん中まで動かせる・それより外へは動かない**。形の計算は `stagePan.ts`（純関数・スモークが総当たりで見る）。
   *
   *  ★V195b（作者決定 2026-10-04「収まる大きさは元の形」）: V195 は「全体表示でないとき」だったので、＋ で一度
   *  拡大すると − で窓に収まる倍率まで戻しても余白付きのままだった。いまは**全体表示で選ばれる倍率より大きいとき
   *  だけ**（`panNeeded`＝全体表示の倍率と同じ物差し `availW/H`）。収まる倍率は全体表示と同じ今までの形。
   *  収まる → はみ出すでは絵の真ん中を窓の真ん中に（控えた点が無い＝`anchor` が null）、はみ出す → 収まるでは
   *  今までの形へ。窓の大きさ・回転・大画面の往復で入れ替わるときも同じ（どれも applyZoom を通る）。
   *
   *  - スクロールの中身は変形しない箱 `#ed-cvpan`（見た目の絵＋窓の幅・高さ）。絵の箱 `#ed-cvwrap` は
   *    `.stage-scroll.pan` の間だけ absolute で箱の真ん中に置く（回転の transform が範囲を崩さない）
   *  - 手のひら・Space・スクロールバー・ホイールはどれも `#ed-scroll` のスクロールなので、全部が同じ範囲
   *  - 余白は `#ed-cvwrap` の外＝押しても描かれない（絵の外は今どおり何も起きない）・背景は今の斜線のまま
   *  - 全体表示と大画面（swapped）は今の形のまま（`.pan` を外し、インラインの位置も消す） */
  private layoutPan(z: number, anchor: { x: number; y: number } | null, availW: number, availH: number) {
    const sc = document.querySelector("#ed-scroll") as HTMLElement | null;
    const sizer = document.querySelector("#ed-cvpan") as HTMLElement | null;
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (!sc || !sizer || !wrap) return;
    const pan = this.zoomMode !== "fit" && !this.previewLarge && panNeeded(z, availW, availH, this.viewRot);
    if (!pan) {
      sc.classList.remove("pan");
      sizer.style.width = "";
      sizer.style.height = "";
      wrap.style.left = "";
      wrap.style.top = "";
      this.panGeom = null;
      // 大画面のあいだは、入る前に見ていた点を控えておく（戻ってまだはみ出すなら同じ点を真ん中へ）。
      // 収まる形・全体表示では捨てる（`anchor` はパンしていなければ null）
      this.panHeld = this.previewLarge && this.zoomMode !== "fit" ? anchor : null;
      return;
    }
    sc.classList.add("pan");
    const border = wrap.clientLeft || 0; // 枠線（.cvwrap の 4px）。回転前の箱の左上を決めるのに使う
    const place = () => {
      const lay = panLayout(sc.clientWidth, sc.clientHeight, z, this.viewRot, this.viewFlipH, border);
      sizer.style.width = `${lay.sizerW}px`;
      sizer.style.height = `${lay.sizerH}px`;
      wrap.style.left = `${lay.wrapLeft}px`;
      wrap.style.top = `${lay.wrapTop}px`;
      return lay.geom;
    };
    let g = place();
    // スクロールバーが出る／消えると窓（clientWidth/Height）が変わる。パンの間は縦横とも必ず出るので、
    // 1 回置いてから測り直し、変わっていれば置き直す（2 回目で決まる）
    if (sc.clientWidth !== g.viewW || sc.clientHeight !== g.viewH) g = place();
    this.panGeom = g;
    this.panHeld = null;
    // 控えた点を真ん中へ（全体表示から来たときは絵の真ん中＝全体表示では絵が真ん中にあるので見た目が飛ばない）
    const s = scrollFor(g, anchor ?? { x: W / 2, y: H / 2 });
    sc.scrollLeft = s.left;
    sc.scrollTop = s.top;
  }

  /** V195 (A-98): 表示の回転・反転のあと。パンしている間は余白の形（見た目の幅と高さ）が変わるので置き直す
   *  （窓の真ん中の点はそのまま）。全体表示・大画面は今どおり transform だけ。
   *  V195b: 数字の倍率では、回転で見た目の幅と高さが入れ替わって「収まる／はみ出す」が変わり得るので、
   *  パンしていなくても置き直す（applyZoom が決める）。全体表示は今どおり（倍率を計算し直さない） */
  private applyViewChange() {
    if (this.zoomMode !== "fit" && !this.previewLarge) this.applyZoom();
    else this.applyViewTransform();
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

  /** クライアント座標 → キャンバスドット座標（表示回転/反転の逆写像）。**ドットに落とした整数**。
   *  M3.10 G-1: wrap 矩形は枠線4pxを含みドット領域とズレるため、canvas 自身の矩形で写像する。
   *
   *  ★A-70: 中身は `clientToPixelF` の `Math.floor` **だけ**。写像の式をここに持たないこと
   *  （2つに書き分けると、カーソル表示と描線で座標がズレる。しかも誰も気づけない）。 */
  private clientToPixel(cx: number, cy: number): { x: number; y: number } {
    const p = this.clientToPixelF(cx, cy);
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  /** クライアント座標 → キャンバスドット座標（**小数のまま**）。
   *
   *  ★A-70: ブラシの線が階段状になる真因は「量子化が2段」あったこと。
   *  ① ここ（旧 `clientToPixel`）で `Math.floor` して入力の時点で段が付く
   *  ② そのうえ描線側が関節ごとに `Math.round` して `lastPt` を整数で持ち回る
   *  → 丸め誤差が**関節のたびに入り直す**ので、段が 2,3,2,3… と不揃いになる。
   *  直線ツールが揃って見えるのは、始点から終点まで**1本**で引くから（同じラスタライザ）。
   *
   *  そこで**描線の経路だけ**がこの小数版を使い、`lastPt` / `smoothPt` を小数のまま持つ。
   *  **丸めるのは打点の瞬間だけ**——`raster.ts` の `strokeSegment` が既に内部で
   *  `Math.round` しているので、`raster.ts` は1行も変えなくてよい。 */
  private clientToPixelF(cx: number, cy: number): { x: number; y: number } {
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
    return { x: u * W, y: v * H };
  }

  override renderCanvas() {
    // ★V214 (M-2b-1a): 眠ったコマを起こす・1px の線の仮・オニオンを決めて絵を作るのはコアの renderWork。
    //  ここは見せる処理だけ（コアが 1px の仮を打ったまま呼ぶ＝本体とミニに仮の点が出る・例外でも仮は戻る）
    this.renderWork((composite) => {
        const cv = $("#ed-canvas") as unknown as HTMLCanvasElement;
        presentToCanvas(composite, cv);
        // M11-16: 透明の紙は合成バッファでは alpha=0（何も焼かない）。市松は**表示層**＝canvas 要素の
        // 背景で出す（.paper-clear の CSS）。紙が実色ならクラスを外して従来の白背景（見えない）
        cv.classList.toggle("paper-clear", this.project.frames[this.frameIndex]?.paper === 0);
        // ミニプレビュー（オニオン無し）。M11-13: 隠している間は合成そのものを走らせない
        //（compositeFrame は全レイヤーを毎回合成するので、描画1回ぶんまるごと省ける）
        if (this.miniShown()) this.paintMini(); // M11-18: 収納ミニは hudHidden でも見えている
    });
  }

  private overlayCtx(): CanvasRenderingContext2D {
    const cv = $("#ed-overlay") as unknown as HTMLCanvasElement;
    return cv.getContext("2d")!;
  }

  override redrawOverlay() {
    const ctx = this.overlayCtx();
    ctx.clearRect(0, 0, W, H);
    // V208 (A-119): 選択の境目の線は画面解像度の層（#ed-sel-ui・paintSelectionUi）へ移した（作者の決定 2026-10-24
    //  ＝ドットより細い線。縁のドットを白黒で塗る M10-22 の形はやめた＝縁の絵を隠さない）。ここに残るのは
    //  「色を付ける」がオンのときの中の色だけ
    if (this.selMask && !this.xformActive && this.selMaskShow) {
      const img = ctx.createImageData(W, H);
      // M13-2a (A-2) → V208: 選んだ**全部の**ドット（縁も）に半透明の単色を置く。
      // オーバーレイの ImageData に書くだけで索引には触れない
      const [mr, mg, mb, ma] = SEL_MASK_RGBA;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!this.selMask[i]) continue;
          img.data[i * 4] = mr;
          img.data[i * 4 + 1] = mg;
          img.data[i * 4 + 2] = mb;
          img.data[i * 4 + 3] = ma;
        }
      ctx.putImageData(img, 0, 0);
    }
    // 変形プレビュー
    if (this.xformActive && this.floatBuf) {
      this.drawTransformPreview(ctx);
    }
    // M10-2c → M13-2b (T-6): 四隅変形の枠とハンドルは画面解像度の層（`paintUiOverlay`）へ移した
    // M11-12: 浮動テキスト（実際のドット＋外接する薄い枠。選択範囲では切らない）
    if (this.textDraft) this.drawTextDraftPreview(ctx);
    // V208 (A-119): 自由選択と囲い塗りの軌跡（囲んでいる途中の線）は画面解像度の層へ移した（paintSelectionUi・
    //  ペンについてくる細い線。320×240 のここに引くと 1 ドットの太さのぼけた線になる）
    // M11-8 P-3: 選択の状態が変わる経路はすべてここを通るので、ランチャーもここで更新する
    this.refreshSelectionLauncher();
    // V208 (A-119): 同じ理由で、範囲選択の線の層もここで整える。★M13-2b の「redrawOverlay の中から画面解像度の層の
    //  描画を呼ばない」の**ただ 1 つの例外**（作者の決定 2026-10-24・REQ_selection_outline）。境目の線を作り直すのは
    //  マスクの実体が替わったときだけ・出す／消す／点線のタイマー／描き直しは、呼ばれるたびに条件を見て決める
    this.paintSelectionUi();
  }

  /**
   * V208 (A-119): 範囲選択の線の層（#ed-sel-ui・画面解像度）を描く**ただ 1 つの関数**。
   * 選んだあとの境目の線（白の線の上に黒の破線・動かす）と、囲んでいる途中の線（投げ縄・囲い塗り）を今の状態から両方描く。
   * 出すか（層がある・寸法がある・選択がある・xformActive でない・出さない場面でない）は呼ばれるたびに決め、描く物が
   * 無ければ隠してバッキングを小さくし、点線のタイマーも止める（タイマーの 1 回ごとにもここを通る）。
   * 呼ぶのは redrawOverlay（最後の 1 行）・囲んでいる途中の pointermove（1 回につき 1 回）・点線のタイマー・applyZoom・
   * 出さない場面に入るとき（previewSelectRect・redrawSelMovePreview）・redrawOverlay を通らずに selMask を null にする所
   * （作品を替えるとき・endTransform）。renderCanvas も redrawOverlay も呼ばない。
   */
  protected override paintSelectionUi(): void {
    const cv = document.querySelector("#ed-sel-ui") as HTMLCanvasElement | null;
    const canvas = document.querySelector("#ed-canvas") as HTMLCanvasElement | null;
    // 層が DOM にあり、寸法が 0 でないときだけ描く（Node の検査の台の偽の document はどんな字にも要素を返し、
    // 寸法は 0・isConnected が無い＝ここで止まる。タイマーもここより先でしか始めない）
    const live =
      !!cv && !!canvas && cv.isConnected === true && canvas.offsetWidth > 0 && canvas.offsetHeight > 0;
    const outline = live ? this.selUiOutlineNow() : null;
    const trail = this.lassoPts.length > 1 ? this.lassoPts : this.enclosePts.length > 1 ? this.enclosePts : null;
    if (!live || !canvas || !cv || (!outline && !trail)) {
      this.stopSelUiTimer();
      if (cv && cv.isConnected === true && !cv.hidden) {
        // 隠すときはバッキングを小さくする（大きいズームでは 1 枚が約 79MB）。控えの絵も捨てる
        cv.hidden = true;
        cv.width = 1;
        cv.height = 1;
      }
      this.selUiCache = null;
      this.selUiCacheKey = "";
      return;
    }
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    cv.hidden = false;
    ctx.clearRect(0, 0, pw, ph);
    // 1 ドットの物理 px（格子 updateGridOverlay と同じ式）・線の太さは 1 CSS px 相当を物理 px に丸める
    const px = (cssW * dpr) / W;
    const py = (cssH * dpr) / H;
    const lw = Math.max(1, Math.round(dpr));
    if (outline) {
      const key = `${pw}x${ph}:${outline.dx},${outline.dy}`;
      if (!this.selUiPath || this.selUiPathKey !== key) {
        this.selUiPath = this.selOutlinePath(outline.o, outline.dx, outline.dy, pw, ph, px, py, lw);
        this.selUiPathKey = key;
        this.selUiCacheKey = "";
      }
      const still = outline.o.edges > SEL_UI_ANIM_MAX_EDGES;
      if (!still) this.strokeSelOutline(ctx, this.selUiPath, lw, dpr);
      else {
        // 辺が多すぎる形（市松に近い✨など）は点線を止めたまま、描いた絵を控えて貼る（囲んでいる途中の
        // pointermove のたびに 15 万本の辺を描き直さない）。控えは 1 枚だけ（大きいズームでは 1 枚が約 79MB）
        const ckey = `${key}:${this.selUiPhase}`;
        let cache = this.selUiCache;
        if (!cache || this.selUiCacheKey !== ckey) {
          cache = cache ?? document.createElement("canvas");
          cache.width = pw;
          cache.height = ph;
          const cctx = cache.getContext("2d");
          if (cctx) this.strokeSelOutline(cctx, this.selUiPath, lw, dpr);
          this.selUiCache = cache;
          this.selUiCacheKey = ckey;
        }
        ctx.drawImage(cache, 0, 0);
      }
    } else if (this.selUiCache) {
      this.selUiCache = null; // 境目の線が無くなったら控えも捨てる
      this.selUiCacheKey = "";
    }
    if (trail) this.strokeSelTrail(ctx, trail, px, py, lw, dpr);
    // 点線を動かすのは境目の線が出ているときだけ（辺が多すぎるとき・視差効果を減らす設定のときは止めたまま）
    if (outline && outline.o.edges <= SEL_UI_ANIM_MAX_EDGES && !this.reducedMotionNow()) this.startSelUiTimer();
    else this.stopSelUiTimer();
  }

  /** V208 (A-119): 今出す境目の線（null＝出さない）。作り直すのはマスクの実体が替わったときだけ。
   *  枠だけを動かすドラッグの間は、掴んだときのマスクの線をずらして描く（動くたびに作り直さない） */
  private selUiOutlineNow(): { o: SelOutline; dx: number; dy: number } | null {
    if (!this.selMask || this.xformActive || this.selUiHidden()) return null;
    const drag = this.selMaskDrag;
    const src = drag ? drag.base : this.selMask;
    if (src !== this.selUiSrc || !this.selUiOutline) {
      this.selUiSrc = src;
      this.selUiOutline = selectionOutline(src, W, H);
      this.selUiPath = null;
    }
    if (this.selUiOutline.edges === 0) return null;
    return { o: this.selUiOutline, dx: drag ? drag.dx : 0, dy: drag ? drag.dy : 0 };
  }

  /** V208 (A-119): 今その間は線を出さない場面か（場面が終わっていたら印を捨てる） */
  private selUiHidden(): boolean {
    const h = this.selUiHideFor;
    if (h === "rect" && this.tool === "select" && this.shapeStart) return true;
    if (h === "selmove" && this.dragMode === "selmove") return true;
    this.selUiHideFor = null;
    return false;
  }

  /** V208 (A-119): 線を出さない場面に入る（矩形選択のドラッグ・移動ツールで範囲の絵を動かす）。今の線をここで消す */
  private hideSelectionUiFor(scene: "rect" | "selmove"): void {
    if (this.selUiHideFor === scene) return;
    this.selUiHideFor = scene;
    this.paintSelectionUi();
  }

  /** V208 (A-119): 境目の線の Path2D（物理 px）。頂点は格子と同じ式 Math.round(i × 1 ドットの物理 px) に丸め、
   *  線はそこから lw 物理 px の幅（格子の 1 物理 px の線に重なる）。右端・下端の辺（i = W・H）は層の外に出るので内側に寄せる */
  private selOutlinePath(
    o: SelOutline,
    dx: number,
    dy: number,
    pw: number,
    ph: number,
    px: number,
    py: number,
    lw: number
  ): Path2D {
    const half = lw / 2;
    const X = (i: number) => (i === W ? pw - lw : Math.round(i * px)) + half;
    const Y = (j: number) => (j === H ? ph - lw : Math.round(j * py)) + half;
    const path = new Path2D();
    const { pts, loops } = o;
    // closePath は使わない（Chromium では輪の数の 2 乗で遅くなる＝市松で 4 秒）。輪は最初の辺の真ん中から始めて
    // 真ん中で終える＝角はどれも線のつなぎ目（miter）になり、切れ目は辺の途中（butt どうしが突き合わさる）
    for (let k = 0; k + 1 < loops.length; k++) {
      const s = loops[k];
      const e = loops[k + 1];
      if (e - s < 2) continue;
      const x0 = X(pts[2 * s] + dx);
      const y0 = Y(pts[2 * s + 1] + dy);
      const mx = (x0 + X(pts[2 * s + 2] + dx)) / 2;
      const my = (y0 + Y(pts[2 * s + 3] + dy)) / 2;
      path.moveTo(mx, my);
      for (let q = s + 1; q < e; q++) path.lineTo(X(pts[2 * q] + dx), Y(pts[2 * q + 1] + dy));
      path.lineTo(x0, y0);
      path.lineTo(mx, my);
    }
    return path;
  }

  /** V208 (A-119): 境目の線（白の線の上に黒の破線 4・4 CSS px を重ねる・破線の位置は selUiPhase でずらす） */
  private strokeSelOutline(ctx: CanvasRenderingContext2D, path: Path2D, lw: number, dpr: number): void {
    ctx.save();
    ctx.lineWidth = lw;
    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";
    ctx.strokeStyle = SEL_UI_PAPER;
    ctx.stroke(path);
    ctx.strokeStyle = SEL_UI_INK;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.lineDashOffset = -this.selUiPhase * dpr;
    ctx.stroke(path);
    ctx.restore();
  }

  /** V208 (A-119): 囲んでいる途中の線（ペンについてくる細い線: 1 CSS px 相当の黒・まわりに白の縁取り。今の点から始点へ
   *  戻る「閉じる所」は細い点線）。点そのものに線を引く（+0.5 しない＝選ばれる範囲と半ドットずれない） */
  private strokeSelTrail(
    ctx: CanvasRenderingContext2D,
    pts: { x: number; y: number }[],
    px: number,
    py: number,
    lw: number,
    dpr: number
  ): void {
    const path = new Path2D();
    path.moveTo(pts[0].x * px, pts[0].y * py);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x * px, pts[i].y * py);
    const last = pts[pts.length - 1];
    const close = new Path2D();
    close.moveTo(last.x * px, last.y * py);
    close.lineTo(pts[0].x * px, pts[0].y * py);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = SEL_UI_PAPER;
    ctx.lineWidth = lw * 3;
    ctx.stroke(path);
    ctx.strokeStyle = SEL_UI_INK;
    ctx.lineWidth = lw;
    ctx.stroke(path);
    ctx.lineCap = "butt";
    ctx.strokeStyle = SEL_UI_PAPER;
    ctx.stroke(close);
    ctx.strokeStyle = SEL_UI_INK;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.stroke(close);
    ctx.restore();
  }

  /** V208 (A-119): OS の「視差効果を減らす」。始めるとき・1 回ごとに読むだけ（変わったことを知らせる口は付けない） */
  private reducedMotionNow(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /** V208 (A-119): 点線のタイマー。1 回ごとに paintSelectionUi を通して出す条件を見直す（外れていたらそこで止まる） */
  private startSelUiTimer(): void {
    if (this.selUiTimer != null) return;
    this.selUiTimer = window.setTimeout(this.selUiTick, SEL_UI_TICK_MS);
  }

  private selUiTick = () => {
    this.selUiTimer = null;
    this.selUiPhase = (this.selUiPhase + 1) % 8;
    this.paintSelectionUi();
  };

  private stopSelUiTimer(): void {
    if (this.selUiTimer == null) return;
    window.clearTimeout(this.selUiTimer);
    this.selUiTimer = null;
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

  /** 変形プレビューの**絵だけ**を 320×240 のオーバーレイへ描く（ドット粒度で見えるのが正しい）。
   *  M13-2b (T-6): 枠・ハンドル・回転ノブは**画面解像度の層**（`paintUiOverlay`）へ移した。
   *  M13-2b (T-2): N 枚ぶんの float を**同じ Transform**でレイヤー順（下→上）に重ねる。
   *  中心は全 float で共通（同じマスクで切り出してあるので ox/oy/w/h が同じ） */
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
    for (const L of this.xformLayers) {
      // 単色キャンバスは float が変わらない間は使い回す（20枚でも毎 move に作り直さない）
      if (!L.cv) L.cv = this.floatToCanvas(L.float);
      ctx.drawImage(L.cv, -L.float.w / 2, -L.float.h / 2);
    }
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
      // ★V166 (C): Alt の見分けに要る3つ。`altD>altU` で止まっていれば **keyup が来ていない**（候補1）、
      //  釣り合っているのに `alt=1` が続くなら **掴まれたまま**（候補2）。`fix` は自己修復が効いた回数
      `alt=${this.altHeld ? 1 : 0} altD=${this.altDownCount} altU=${this.altUpCount} ` +
      `altFix=${this.altFixCount} ` +
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
      // V169 (A-3): dp=（defaultPrevented）。Alt 単独の既定動作を止めているのに固まる報告が来たら、
      // 「止めているのに入った（dp=1）」か「そもそも止まっていない（dp=0）」がこの1語で分かる
      `[inputlog] ${e.type} key=${named ? e.key : "*"} code=${named ? e.code : "*"} ` +
        `repeat=${e.repeat ? 1 : 0} dp=${e.defaultPrevented ? 1 : 0} mod=${mod} ` +
        this.stateLine()
    );
    this.flushInputLogSoon();
  };
  /** M11-5: ウィンドウのフォーカス出入りの診断ログ（フラグ時のみ登録される） */
  private winLogHandler = (e: Event) => {
    this.inputLogBuf.push(`[inputlog] win:${e.type} ${this.stateLine()}`);
    this.flushInputLogSoon();
  };

  protected override flushInputLogSoon() {
    if (this.inputLogTimer != null) return;
    this.inputLogTimer = window.setTimeout(() => {
      this.inputLogTimer = null;
      const lines = this.inputLogBuf.splice(0);
      if (lines.length) this.cb.appendLog?.(lines.join("\n"));
    }, 400);
  }

  /** E-1: 手のひら/Spaceパンのカーソル表示 */
  private updatePanCursor(grabbing = false) {
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (!wrap) return;
    const panning = !!this.panState || grabbing;
    const hand = this.tool === "hand" || this.spaceHeld;
    // A-21: 外枠のカーソルは純関数で決める（capture 中は外枠のカーソルが出るので、ここが正しくないと
    // ペンで掴んだ瞬間に "grab" が残る）。setTool からも呼んで、手のひら→ペンの切替でも畳む
    wrap.style.cursor = panCursorFor(panning, hand);
    // M12-G: キャンバスの上にも出す（従来は枠の 4px にしか出ていなかった）。
    // 手のひら／Space パン以外のときは**今のツールのカーソルへ戻す**（空にすると点が消える）
    if (panning) this.setCanvasCursor("grabbing");
    else if (hand) this.setCanvasCursor("grab");
    else this.applyCanvasCursor();
    // ★V209 (A-122): Space の押す・離す・blur・パンの始めと終わりで、枠と 1 階を一緒に決め直す
    //（押した瞬間に枠を消して手のひら・離した瞬間にポインタの下へ枠。今まではカーソル層を描き直していなかった）
    this.frameCursorOn = false; // いま外枠とキャンバスに書いた値が戻し先そのもの
    this.syncCursorFrame();
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
    // ★V191 (A-89・レビュー指摘): ふつうは onPointerUp が漏斗（endLine1px）を通って状態は空になっている。残っているのは
    //  onPointerUp が漏斗より前に抜けたとき（重い処理の最中＝busyKind の関所）か、終端の控えが無いとき＝そのなぞりは
    //  履歴も積まれていない。1 枚の経路の仮の 1 画素は**打たずに捨てる**（次に押したとき、そのとき選んでいるコマ・
    //  レイヤーへ履歴の外に打たない）。全レイヤーの束の分は beginBusy が先に確定している（束の守りは endLine1px の中）
    this.dropStaleLine1px();
    this.pointerDown = false;
    this.strokeTone = null; // M17: up が来ないまま畳んだときも解決済みトーンを残さない
    if (this.panState) {
      this.panState = null;
      this.updatePanCursor();
    }
    this.releaseCapture();
  }

  /** V159 (G-1): 「描き始め」の計測だけを受け持つ薄い皮。中身は下の `onPointerDownInner`。
   *
   *  測るのは**ストロークが実際に始まったときだけ**（`pointerDown` が立ったとき）。
   *  道具の割り当てコマンドや「再生中に触れて止めた」は描き始めではないので数えない。
   *  1ストロークに1回しか通らない＝**描画ループの中では測っていない**（要件の壊すなリスト）。 */
  private onPointerDown(e: PointerEvent) {
    const _t0 = perfNow();
    try {
      this.onPointerDownInner(e);
    } finally {
      if (this.pointerDown) perfDone("draw.first", _t0);
    }
  }

  private onPointerDownInner(e: PointerEvent) {
    // V154b (W-9): 重い処理の最中は描かない。`#screen-editor.ed-busy` の
    // `pointer-events:none` で普通は届かないが、**ポインタ捕捉中は届いてしまう**
    // （捕捉はヒットテストを上書きする）ので、ここでも止める
    if (this.busyKind) return;
    // M16 (K-4): 修飾キー＋クリックの割り当てを**最優先**で見る（右/中クリックの割り当ても効くよう
    // 右ボタンガードより前）。ただし: 再生中は「触れたら止めるだけ」を優先／Space パン中は見ない／
    // **範囲選択ツール中の Shift/Alt＋左クリックはマスク加減算が優先**（M13-2a）。素の左クリック（無修飾
    // button=0）は割り当て不可なので pointerCommandFor は null＝ここは素通りして従来の描画へ進む
    if (!this.playing && !this.spaceHeld) {
      const pcmd = this.pointerCommandFor(e);
      if (pcmd && !(this.tool === "select" && e.button === 0 && (e.shiftKey || e.altKey))) {
        e.preventDefault();
        this.runPointerCommand(pcmd, e); // 描画は始めない（pointerDown も立てない）
        return;
      }
    }
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
    // ★V213 (M-2a): 前のなぞりの後始末の網（全レイヤーの束・1px の仮）はコア（strokeSettle）
    this.strokeSettle();
    this.shiftHeld = e.shiftKey; // M10-7: pointer 側の modifier を真実として同期
    this.syncAltFromEvent(e.altKey, "pointerdown"); // V166 (C): Alt も同じ作法で同期する
    this.closeStrip(); // M14 (S-1): キャンバスへ触れたら（描き始め）形式ストリップは畳む
    // ★V157 (D-1)・★V178 (A-72): ロック中のレイヤー・全レイヤーの束が作れないときは描かせない。**捕捉する前に**戻る
    //（掴みっぱなしを作らない）。決めるのはコア（strokeLocked）。Space のパンは描かないので見ない
    if (!this.spaceHeld && this.strokeLocked()) return;
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
    // ★V213 (M-2a): 描き始めはコア（サンプルの画素への落とし方・道具ごとの始め方）。PC は画面の続きだけ
    const r = this.strokeStart(this.sampleOf(e));
    if (r === "xform") {
      // R-2: ドラッグ開始直後にモードラベルを表示（ペンでhoverが取れない環境でも判別できる）
      this.showXformModeLabel(this.dragMode, e.clientX, e.clientY);
    } else if (r === "textDrag") {
      // 入力欄からフォーカスを外す。ここを外さないと onKeyDown が isTextEntry で
      // 早期 return し続けるので、**矢印キーでの微調整が一生できない**
      //（入力欄にフォーカスがある間はカーソル移動が優先＝REQ の要求。
      //   打ち直したくなったら入力欄をクリックすれば戻れる）
      (document.querySelector("#ed-textinput") as HTMLTextAreaElement | null)?.blur();
    } else if (r === "picked") {
      // M10-21b: スポイトで拾ったら、この接触の move/up を素通しにする（pointerDown はコアが下ろした）
      this.lastPointerEvent = null;
      this.releaseCapture(e.pointerId); // M11-5: 解放は1箇所に集約（掴んだ id も忘れる）
    }
  }

  private onPointerMove(e: PointerEvent) {
    // V154b (W-9): 重い処理の最中は描かない。`#screen-editor.ed-busy` の
    // `pointer-events:none` で普通は届かないが、**ポインタ捕捉中は届いてしまう**
    // （捕捉はヒットテストを上書きする）ので、ここでも止める
    if (this.busyKind) return;
    // M11-6: 掴んでいるポインタ以外の移動は無視する（ペンで描いている最中に
    // 手のひらが触れて線が飛ぶのを防ぐ）。**down 側には入れない** —
    // 取りこぼしたキャプチャを次の pointerdown で畳んで直すのが M11-5 の復帰経路で、
    // そのとき届く down は別 id になり得るため、弾くと直した症状が戻る。
    // ※ この判定は下の「buttons===0 で畳む」自己修復より**前**にある。つまり
    //   取りこぼしからの復帰は「同じポインタの移動 / 次の pointerdown / blur」で起こり、
    //   **別のポインタを動かすだけでは起こらない**。ここを緩めると、描いている最中に
    //   別のポインタがホバーしただけでストロークが終わってしまうため、この順序を選んでいる
    if (this.capturedPointerId !== null && e.pointerId !== this.capturedPointerId) return;
    // ★V209 (A-122): 最後のポインタの位置（枠を出し直すときに引き直す）。パン中・変形中のホバーの早い return より前で覚える
    this.cursorClient = { x: e.clientX, y: e.clientY };
    this.shiftHeld = e.shiftKey; // M10-7: pointer 側の modifier を真実として同期
    // ★V166 (C): **ここがいちばん効く。** 描いている最中に Alt の状態が食い違ったら
    //  （keyup が届かなかった／ドライバが掴んだまま）、動かした時点でイベント側へ合わせて直す
    this.syncAltFromEvent(e.altKey, "pointermove");
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
    // M12-C: カーソル層の追従。**描いている最中も通る**（太さが分かる価値はストローク中にもある）。
    // 2階が両方 OFF なら `cursorLive` が false で、この行は真偽値1つの判定で終わる＝
    // ホバーは M11-24 と同じく下の早期 return まで素通りする。
    // getCoalescedEvents() は**使わない**（カーソルは最後の1点だけでよい。描線側だけが使う）
    if (this.cursorLive) this.trackCursor(e);
    if (!this.pointerDown) return;
    const events =
      "getCoalescedEvents" in e ? (e as any).getCoalescedEvents() as PointerEvent[] : [e];
    let trailMoved = false; // V208 (A-119): 囲んでいる途中の線を、ループの外で 1 回だけ描き直す
    for (const ev of events) {
      // ★V213 (M-2a): 1 点ずつコアへ（画素への落とし方・道具ごとの描き方はコア）
      const r = this.strokeMoveOne(this.sampleOf(ev));
      if (r === "xform") this.showXformModeLabel(this.dragMode, ev.clientX, ev.clientY); // R-2: ラベル追従
      else if (r === "trail") trailMoved = true;
    }
    this.strokeMoveDone(trailMoved);
  }

  /** M10-2c: 四隅ハンドルはキャンバスの隅ちょうどに出るが、×2 以上のズームでは
   *  そこに表示切替ボタン列（`.cvright`）とミニプレビュー（`#ed-mini`）が重なっていて、
   *  **右上と右下のハンドルが物理的に掴めない**（実機で確認）。
   *  四隅モードの間だけ pointer-events を切り、抜けるときに元の値へ必ず戻す。
   *  styles.css は触らない制約（§3.7-8）があるのでインラインで行う。 */
  protected override muteFloatingOverlays(on: boolean): void {
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

  /**
   * M13-2b (T-6): **UI 装飾専用の画面解像度オーバーレイ**（`#ed-overlay-ui`）。
   *
   * `#ed-overlay` は 320×240 のキャンバスを CSS で拡大表示しているので、そこに引いた
   * `lineWidth = 1` は**1ドット＝ズーム倍の画面ピクセル**になる（×8 なら 8px の太線）。
   * ここは `#ed-grid` / `#ed-cursor` と同じく**バッキングを表示サイズ×devicePixelRatio で確保**し、
   * 線は物理 px で引く＝ズームしても 1px 相当のまま。
   *
   * 描くのは **変形の枠・8ハンドル・回転ノブ／四隅モードの枠・8ハンドル** だけ。
   * ドット粒度のもの（M13-2a の色マスク・変形プレビューの絵）は従来の 320×240 に残す。
   * 選択の境目の線（旧マーチングアンツ）と囲んでいる途中の線は、V208 (A-119) で別の画面解像度の層
   * （`#ed-sel-ui`・`paintSelectionUi`）へ移した（作者の決定 2026-10-24＝ドットより細い線。ここには同居させない）。
   *
   * `redrawOverlay()` の中からは呼ばない（M12-C の「2階の描画」規約と同じ分離）。変形・四隅の状態が
   * 変わる各所と `applyZoom()`（寸法の変化）から直接呼ぶ。描く物が無ければ hidden にする。
   */
  protected override paintUiOverlay(): void {
    const cv = document.querySelector("#ed-overlay-ui") as HTMLCanvasElement | null;
    const canvas = document.querySelector("#ed-canvas") as HTMLCanvasElement | null;
    if (!cv || !canvas) return;
    const showXform = this.xformActive && !!this.floatBuf;
    const showCorner = this.cornerActive && this.cornerPts.length === 4;
    if (!showXform && !showCorner) {
      if (!cv.hidden) {
        cv.hidden = true;
        cv.getContext("2d")?.clearRect(0, 0, cv.width, cv.height);
      }
      return;
    }
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    cv.hidden = false;
    ctx.clearRect(0, 0, pw, ph);
    // ドット座標 → 物理 px（`paintCursorLayer` と同じ式。四隅の点は格子の交点に乗る）
    const px = (cssW * dpr) / W;
    const py = (cssH * dpr) / H;
    const X = (x: number) => x * px;
    const Y = (y: number) => y * py;
    const LINE = 1 * dpr; // 1 CSS px
    const HS = 3.5 * dpr; // ハンドルの□の半径（7 CSS px）
    const square = (x: number, y: number, fill: string, stroke: string, angle = 0) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = LINE;
      ctx.fillRect(-HS, -HS, HS * 2, HS * 2);
      ctx.strokeRect(-HS, -HS, HS * 2, HS * 2);
      ctx.restore();
    };

    if (showXform) {
      const f = this.floatBuf!;
      const t = this.xform;
      const cx = f.ox + f.w / 2 + t.tx;
      const cy = f.oy + f.h / 2 + t.ty;
      const hw = Math.abs((f.w / 2) * t.sx);
      const hh = Math.abs((f.h / 2) * t.sy);
      // 枠（回転した矩形）
      ctx.save();
      ctx.translate(X(cx), Y(cy));
      ctx.rotate(t.angle);
      ctx.scale(px, py); // 以降はドット単位で書けるが、線幅は物理 px に戻す
      ctx.strokeStyle = uiColor("--orange", "#f07a1a");
      ctx.lineWidth = LINE / Math.max(px, py);
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
      ctx.restore();
      // ハンドル（四隅4・辺の中央4・回転ノブ）。M11-11: 画面の外へ出たものは内側へ寄せて**塗りつぶし**で描く
      //（キャンバス領域の外は描いても掴めない。この処理は画面解像度でも必要＝REQ §6-4）
      const hs = this.xformHandleWorld();
      const knob = this.clampedHandle(hs[4].x, hs[4].y) ?? hs[4];
      ctx.save();
      ctx.strokeStyle = uiColor("--orange", "#f07a1a");
      ctx.lineWidth = LINE;
      ctx.beginPath();
      ctx.moveTo(X(hs[5].x), Y(hs[5].y));
      ctx.lineTo(X(knob.x), Y(knob.y));
      ctx.stroke();
      ctx.restore();
      for (let i = 0; i < hs.length; i++) {
        const cl = this.clampedHandle(hs[i].x, hs[i].y);
        const p = cl ?? hs[i];
        // 枠と縁は配色の橙（明るい #f07a1a／夜の紙 #ff9f4a・どちらも紙の上で見える）。
        // ただし**つまみの地は白のまま**——ここは作品の絵の上で、絵の色は配色を変えても
        // 変わらない。地を配色に追随させると、夜の紙で「白い紙の上に濃い茶のつまみ」に
        // なってしまう（見えなくはないが、明るい配色と別物の見え方になる）
        square(X(p.x), Y(p.y), cl ? uiColor("--orange", "#f07a1a") : "#ffffff", uiColor("--orange", "#f07a1a"), t.angle);
      }
    }

    if (showCorner) {
      const p = this.cornerPts;
      ctx.save();
      // V158 (C-2): ここは**作品の絵の上**に描くプレビュー。配色を変えても作品の色は変わらないので、
      // 配色に追随させると逆に見えにくくなる（夜の紙のクリーム色は、白い紙の上でほぼ消える）。据え置きが正しい
      ctx.strokeStyle = "rgba(44,38,33,.85)";
      ctx.lineWidth = LINE;
      ctx.beginPath();
      ctx.moveTo(X(p[0].x), Y(p[0].y));
      for (let i = 1; i < 4; i++) ctx.lineTo(X(p[i].x), Y(p[i].y));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      for (const q of this.cornerHandles()) square(X(q.x), Y(q.y), "#ffffff", "rgba(44,38,33,.85)");
    }
  }

  private onPointerUp(e: PointerEvent) {
    // V154b (W-9): 重い処理の最中は描かない。`#screen-editor.ed-busy` の
    // `pointer-events:none` で普通は届かないが、**ポインタ捕捉中は届いてしまう**
    // （捕捉はヒットテストを上書きする）ので、ここでも止める
    if (this.busyKind) return;
    // M11-6: 掴んでいるポインタ以外の up では、描きかけのストロークを切らない
    //（2本目の指を離しただけでペンの線が終わってしまうのを防ぐ）
    if (this.capturedPointerId !== null && e.pointerId !== this.capturedPointerId) return;
    // M11-5: 掴んだままにしない（pointerup/pointercancel の暗黙解放に頼らず必ず解放する）。
    // pointerDown が立っていなくても解放だけは通す
    this.lastPointerEvent = null;
    this.releaseCapture(e.pointerId);
    this.strokeTone = null; // M17: ストロークの解決済みトーンは離したら捨てる（次は pointerdown で解決し直す）
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
    // ★V213 (M-2a): 確定はコア（1px の仮・全レイヤーの束・道具ごとの確定）
    this.strokeFinish(this.sampleOf(e));
  }

  protected override previewShape(a: { x: number; y: number }, b: { x: number; y: number }) {
    const ctx = this.overlayCtx();
    ctx.clearRect(0, 0, W, H);
    // V158 (C-2): ここは**作品の絵の上**に描くプレビュー。配色を変えても作品の色は変わらないので、
    // 配色に追随させると逆に見えにくくなる（明るい絵の上で明るい線になる）。据え置きが正しい
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

  protected override previewSelectRect(a: { x: number; y: number }, b: { x: number; y: number }) {
    this.hideSelectionUiFor("rect"); // V208 (A-119): ドラッグの間は選択の線も出さない（離すと redrawOverlay で戻る）
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

  protected override redrawSelMovePreview() {
    this.hideSelectionUiFor("selmove"); // V208 (A-119): 絵を動かしている間は選択の線も出さない（離すと redrawOverlay で戻る）
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

  // ---------------- M11-8 P-3: 選択範囲ランチャー ----------------
  // 選択範囲の下に浮かぶバー。#ed-cvwrap は表示回転/反転の CSS transform を持つので、
  // その**外側**の #ed-stage に置く（変形モードラベルと同じ作法）。

  /** ボタンの定義。M11-9 P-5 で並び順とアイコンを確定:
   *  「範囲をいじる」3つ ｜ 「絵をどうにかする」4つ ｜ 解除（末尾＝誤爆しにくい位置）。
   *  sep:true の直前に細い区切り線を1本入れる */
  // V171: `icon` は絵文字の文字列からアイコン id へ（⬛⬜→select-invert・⊕→select-expand・⊖→select-contract・
  // 🧽→eraser・◉/◎→line-thicken/line-thin・✂→cut-to-layer・⧉→copy-to-layer・⤢→transform・✕→close）
  private static readonly SEL_OPS: { op: string; icon: IconId; title: string; sep?: boolean }[] = [
    { op: "invert", icon: "select-invert", title: t("ed.sel.invert.title") },
    { op: "expand", icon: "select-expand", title: t("ed.sel.expand.title") },
    { op: "contract", icon: "select-contract", title: t("ed.sel.contract.title") },
    { op: "erase", icon: "eraser", title: t("ed.sel.erase.title"), sep: true },
    // M11-19: 線を太らせる／細らせる（範囲内だけ）。サイドパネルのボタン・コマンドと同じ実体
    { op: "thicken", icon: "line-thicken", title: t("ed.linew.thicken.launcher.title") },
    { op: "thin", icon: "line-thin", title: t("ed.linew.thin.launcher.title") },
    { op: "cut-layer", icon: "cut-to-layer", title: t("ed.sel.cutToLayer.title") },
    { op: "copy-layer", icon: "copy-to-layer", title: t("ed.sel.copyToLayer.title") },
    { op: "transform", icon: "transform", title: t("ed.sel.toTransform.title") },
    { op: "deselect", icon: "close", title: t("ed.sel.deselect.title"), sep: true },
  ];

  private launcherEl: HTMLElement | null = null;

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
      b.replaceChildren(icon(o.icon)); // V171: 線画アイコン
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
  protected override refreshSelectionLauncher() {
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

  protected override updateXformBadge() {
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

  /** M6-6 R-2: 変形モードラベル（「⤡ 拡縮」「⟳ 回転」をカーソル追従で表示）。
   *  ペン入力ではOSのペンポインタが優先されCSSカーソルが見えないため、カーソルに頼らない補助。
   *  回転で歪まないよう #ed-stage（cvwrap の transform の外）に置く。 */
  private xmodeLabelEl: HTMLElement | null = null;
  private showXformModeLabel(mode: string, clientX: number, clientY: number) {
    // M13-2b (T-3): 辺ハンドル（scalex / scaley）も「拡縮」のラベルでよい（新しいキーは足さない）
    const text =
      mode === "scale" || mode === "scalex" || mode === "scaley"
        ? t("ed.xform.mode.scale.label")
        : mode === "rotate"
          ? t("ed.xform.mode.rotate.label")
          : "";
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
    this.setCanvasCursor(hit.cursor); // M12-G: 四隅=リサイズ / 外側=grab / 枠内=move をキャンバス上にも
    this.showXformModeLabel(hit.mode, e.clientX, e.clientY);
  }

  /** M11-13/16: settings.json の `hudHidden` から復元する。**true 以外はすべて既定（表示）へ倒す**
   *  — 項目なし・null・文字列・数値など、何が入っていても起動する。旧 `miniHidden` は読まない（読み捨て） */
  restoreHudHidden(v: unknown) {
    this.hudHidden = v === true;
  }



  /** 入力欄へフォーカスを移し、末尾にカーソルを置く */
  protected override focusTextInput() {
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

  /** M16 (K-4): pointerdown が修飾キー＋クリックの割り当てに一致すればそのコマンドIDを返す。
   *  素の左クリック（無修飾 button=0）は割り当て不可＝ keyLookup に無いので null（＝描画へ素通し）。 */
  private pointerCommandFor(e: PointerEvent): CommandId | null {
    const ids = this.keyLookup.get(pointerEventKey(e));
    return ids && ids.length ? ids[0] : null;
  }

  /** M16 (K-4): 修飾キー＋クリックのコマンドを実行（描画は始めない）。スポイトは**その場で1回拾うだけ**。 */
  private runPointerCommand(id: CommandId, e: PointerEvent) {
    if (id === "edit.pickColor") {
      if (this.playing) this.stopPlayback();
      // ★V167 (K-3): **押した組み合わせを名指しして知らせる**（「Alt＋クリックで色を拾いました」）。
      //  2026-09-02 の事故は、まさにこの経路が無音で走っていて気づけなかった
      this.pickColorAt(this.clientToPixel(e.clientX, e.clientY), "pointer", keyLabel(bindingFromPointer(e)));
      return;
    }
    this.lastPointerEvent = e; // 位置を要するコマンドの保険
    this.runCommand(id);
  }

  /** V199: いまボタンに出している範囲（"a-b"・無ければ ""）。範囲が変わったときだけ描き直す（再生中に毎コマ触らない） */
  private pasteRangeKey = "";
  /** V199: 貼り付けボタンの「→ コマ a〜b」を、タイムラインの範囲に追従させる */
  protected override syncPasteRangeLabel() {
    const r = pasteRange(this.rangeSel, this.project.frames.length);
    if ((r ? `${r.a}-${r.b}` : "") !== this.pasteRangeKey) this.updateLayerClipButtons();
  }

  /** 貼り付け系ボタンの有効/無効を控えの有無に合わせる。
   *  M11-19: 「貼り付け」ボタンには**今の貼り先（アクティブレイヤー名）**を出す（レイヤー切替に追従＝
   *  rebuildLayers からも呼ばれる）。長い名前は 8 文字＋…に省略。
   *  V199 (A-105): タイムラインで 2 コマ以上を選んでいれば「貼り付け → コマ a〜b」、
   *  フォルダの控えなら「貼り付け → {フォルダ名}」（何を選んでいても貼り先は控えた同じレイヤー）。
   *  V203 (A-109): 「重ね貼り」は、表示・有効と無効・貼り先の決め方を「貼り付け」と同じにする（文だけ違う） */
  protected override updateLayerClipButtons() {
    const clip = this.layerClip;
    const on = !!clip;
    for (const sel of ["#ed-lc-paste", "#ed-lc-paste-over", "#ed-lc-paste-new", "#ed-lc-paste-all"]) {
      const b = document.querySelector(sel) as HTMLButtonElement | null;
      if (b) b.disabled = !on;
    }
    const range = pasteRange(this.rangeSel, this.project.frames.length);
    this.pasteRangeKey = range ? `${range.a}-${range.b}` : "";
    const paste = document.querySelector("#ed-lc-paste") as HTMLButtonElement | null;
    const over = document.querySelector("#ed-lc-paste-over") as HTMLButtonElement | null;
    if (!paste || !over) return;
    // 判定も切り出しもコードポイント単位（絵文字名で「…」だけ付かないように）
    const shortOf = (full: string) => {
      const cps = [...full];
      return cps.length > 8 ? `${cps.slice(0, 8).join("")}…` : full;
    };
    if (range) {
      const from = range.a + 1;
      const to = range.b + 1;
      setIconLabel(paste, "clipboard", t("ed.layerclip.pasteToFrames.btn", { from, to }));
      paste.title = t("ed.layerclip.pasteToFrames.title", { from, to, count: range.b - range.a + 1 });
      setIconLabel(over, "clipboard", t("ed.layerclip.pasteOverToFrames.btn", { from, to }));
      over.title = t("ed.layerclip.pasteOverToFrames.title", { from, to, count: range.b - range.a + 1 });
      return;
    }
    if (clip?.kind === "folder") {
      const name = this.folderById(clip.folderId)?.name ?? clip.name;
      setIconLabel(paste, "clipboard", t("ed.layerclip.pasteTo.btn", { layerShort: shortOf(name) }));
      paste.title = t("ed.layerclip.pasteToFolder.title", { folder: name, count: clip.items.length });
      setIconLabel(over, "clipboard", t("ed.layerclip.pasteOverTo.btn", { layerShort: shortOf(name) }));
      over.title = t("ed.layerclip.pasteOverToFolder.title", { folder: name, count: clip.items.length });
      return;
    }
    const ld = this.project.layerDefs.find((l) => l.id === this.activeLayerId);
    const full = ld?.name ?? "";
    setIconLabel(paste, "clipboard", ld ? t("ed.layerclip.pasteTo.btn", { layerShort: shortOf(full) }) : t("ed.layerclip.paste.btn")); // V171
    paste.title = ld
      ? t("ed.layerclip.pasteTo.title", { layer: full })
      : t("ed.layerclip.paste.title");
    setIconLabel(over, "clipboard", ld ? t("ed.layerclip.pasteOverTo.btn", { layerShort: shortOf(full) }) : t("ed.layerclip.pasteOver.btn"));
    over.title = ld
      ? t("ed.layerclip.pasteOverTo.title", { layer: full })
      : t("ed.layerclip.pasteOver.title");
  }

  /** M11-19: 貼り付けボタン列（#ed-layerclip）が見えていなければ見える位置へスクロール
   *  （revealToolOptions と同じ流儀・スムーズにしない） */
  protected override revealLayerClip() {
    const side = document.querySelector("#ed-side") as HTMLElement | null;
    const host = document.querySelector("#ed-layerclip") as HTMLElement | null;
    if (!side || !host) return;
    const sr = side.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    if (hr.bottom > sr.bottom + 1 || hr.top < sr.top - 1) host.scrollIntoView({ block: "nearest" });
  }

  /** V164 (U-4): まとめて追加のダイアログ。`openWobbleDialog` と同じ作法
   *（`EditorCallbacks` を増やさず `modal-back`+`modal-box` を自前で組む・新しい CSS は足さない）。 */
  private openAddFramesDialog(): Promise<{ count: number; duplicate: boolean } | null> {
    const max = ADD_FRAMES_MAX;
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "modal-back";
      const box = document.createElement("div");
      box.className = "modal-box";
      back.appendChild(box);
      box.innerHTML = `<p class="modal-msg">${t("ed.tl.addFrames.dialog.label")}</p>
        <div class="modal-field">
          <span>${t("ed.tl.addFrames.count.label")}</span>
          <input class="tinput" id="af-n" type="number" min="1" max="${max}" step="1" value="5" style="width:90px" />
          <span class="tog">${t("ed.tl.addFrames.range.hint", { max })}</span>
        </div>
        <label class="confirm-skip"><input type="checkbox" id="af-dup"> <span>${t("ed.tl.addFrames.dup.label")}</span></label>
        <div class="modal-actions">
          <button class="btn" id="af-cancel">${t("common.cancel.btn")}</button>
          <button class="btn primary" id="af-ok">${t("ed.tl.addFrames.ok.btn")}</button>
        </div>`;
      document.body.appendChild(back);
      const input = box.querySelector("#af-n") as HTMLInputElement;
      // ★上限への丸めを**押す前に目で見せる**（独立レビュー V164 指摘②）。1000 と打ったら
      //  その場で 100 になるので、「頼んだ数と足された数が黙って食い違う」が起きない。
      //  入力中は直さない（"10" を打つ途中の "1" を潰さないため）＝確定した瞬間だけ
      input.addEventListener("change", () => {
        const raw = Math.floor(Number(input.value));
        if (Number.isFinite(raw)) input.value = String(Math.max(1, Math.min(max, raw)));
        else input.value = "1";
      });
      let done = false;
      const close = (r: { count: number; duplicate: boolean } | null) => {
        if (done) return;
        done = true;
        this.modalDepth--;
        this.addFramesDialogClose = null;
        window.removeEventListener("keydown", onKey, true);
        back.remove();
        resolve(r);
      };
      this.addFramesDialogClose = () => close(null);
      // ダイアログ中はエディタのショートカットを通さない（openWobbleDialog と同じ理由・P-8）
      const onKey = (e: KeyboardEvent) => {
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
      const pick = () =>
        // 丸めは `addFrames`（＝`clampAddFrames`）が必ず行うので、ここは生の値を渡すだけ。
        // 誤って 1000 と打っても上限までにしかならず、そのことはトーストで知らされる
        close({
          count: Number(input.value),
          duplicate: (box.querySelector("#af-dup") as HTMLInputElement).checked,
        });
      (box.querySelector("#af-ok") as HTMLElement).addEventListener("click", pick);
      (box.querySelector("#af-cancel") as HTMLElement).addEventListener("click", () => close(null));
      // M10-11: ペンで即閉じしないよう pointerdown に（main.ts の modal() と同じ理由）
      back.addEventListener("pointerdown", (e) => {
        if (e.target === back) close(null);
      });
      input.focus();
      input.select();
    });
  }

  private async onAddFramesClick(): Promise<void> {
    if (this.xformGuard()) return;
    if (!this.project.frames[this.frameIndex]) return;
    const opt = await this.openAddFramesDialog();
    if (!opt) return;
    await this.addFrames(opt.count, opt.duplicate);
  }

  /** M11-2: ダイアログ（確認・保存先ピッカー・音声パネル等）が開いているか。
   *  `modalDepth` はゆらゆらダイアログしか増やさないため、main.ts の `modal()` が作る
   *  `.modal-back` の実在も見る。**再生トグルを裏で走らせないための番人**（レビュー検出） */
  private dialogOpen(): boolean {
    // V154b (W-9): **重い処理の最中もここに含める**。進捗が出るまでの 450ms も含めて、
    // ショートカット（Ctrl+S の連打・道具切り替え・再生）を一切通さない。
    // 「譲るかどうか」を調べて直すより、そもそも触れなくするほうが確実（要件 W-9）
    return this.busyKind !== "" || this.modalDepth > 0 || !!document.querySelector(".modal-back");
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

  /** キー → コマンドID列の引き当て表（キー1打ごとに線形探索しない）。
   *  M11-15: 道具どうしは同じキーを共有できるので値は配列（通常は1件） */
  private keyLookup = new Map<string, CommandId[]>();
  /** V158 (L-1): 畳みボタンの説明。**動的キーは `*Key` のプロパティで持つ**
   *  （`t(cond ? "a" : "b")` と書くと `m1201_i18n_check` の使用検査が沈黙する・V157 で踏んだ穴） */
  private static readonly SIDE_FOLD_TITLE = {
    fold: { msgKey: "ed.side.fold.title" },
    expand: { msgKey: "ed.side.expand.title" },
    // ★V215 (A-124): 色の段を畳むときの説明（ひらくときは上の expand をそのまま使う）
    colFold: { msgKey: "ed.side.colFold.title" },
  } as const;

  /** V158 (L-1): 右パネルの段を畳む／開く。**両方は畳まない**（畳むとき相手を必ず開く）ので、
   *  「全部畳んで何も出せない」が起きない。畳んだ段の見出しは残るので、そこを押せば戻せる。 */
  private setSideFold(which: "top" | "bot" | "col", v: boolean) {
    if (this.sideFold[which] === v) return;
    this.sideFold[which] = v;
    // ★V215: 色の段の畳みは top・bot とは別に覚える（相手を開く決まりは top・bot の間だけ）
    if (v && which !== "col") this.sideFold[which === "top" ? "bot" : "top"] = false;
    this.finishSplitDrag(false);
    this.applyLayout();
    this.refreshSideFoldButtons();
    this.cb.onSideFoldChange?.({ ...this.sideFold });
  }

  /** 畳みボタンの見た目（矢印と説明）を状態に合わせる。 */
  private refreshSideFoldButtons() {
    for (const which of ["top", "bot", "col"] as const) {
      const b = document.getElementById(`ed-sfold-${which}`);
      if (!b) continue;
      const folded = this.sideFold[which];
      // ★V215: 色の段は下段と同じ向き（畳むと見出しが下＝仕切りのすぐ上へ寄る）
      b.replaceChildren(icon(folded ? (which === "top" ? "chev-down" : "chev-up") : which === "top" ? "chev-up" : "chev-down")); // V171
      b.title = t(Editor.SIDE_FOLD_TITLE[folded ? "expand" : which === "col" ? "colFold" : "fold"].msgKey);
      b.classList.toggle("onb", folded);
    }
  }

  /** V158 (L-1): 右パネルの段ごとの畳み状態（mount で settings から復元） */
  private sideFold: SideFold = { ...SIDE_FOLD_DEFAULT };
  /** mount 前に settings から渡された値（`restoreSideFold`。⚙ はライブラリ画面からしか
   *  開けないので、他の復元と同じく mount 前で足りる） */
  private sideFoldPending: SideFold | null = null;

  /** V158 (C-3): 配色が切り替わったとき、**canvas に描いている UI**を描き直す。
   *  CSS 変数はブラウザが勝手に反映するが、canvas は一度描いた絵がそのまま残るので、
   *  こちらから描き直させる必要がある（波形・変形の枠・トーンのスウォッチ）。
   *  エディタを開いていなければ何もしない。 */
  refreshThemeColors() {
    if (!this.mounted) return;
    this.rebuildTexPicker(); // トーンのスウォッチは作り直しで塗り直る
    this.renderCanvas();
    this.redrawOverlay();
    this.waveRedraw?.();
  }

  /** V158 (L-1): settings.json の `sideFold` から復元（追加のみ・壊れた値は既定へ）。 */
  restoreSideFold(v: unknown) {
    this.sideFoldPending = sanitizeSideFold(v);
    if (this.mounted) {
      this.sideFold = { ...this.sideFoldPending };
      this.applyLayout();
      this.refreshSideFoldButtons();
    }
  }

  /** V157 (D-3): コマンドごとの「最後に走った時刻」。同一コマンドの二重発火を捨てるために持つ。
   *  コマンド数は数十なので、増え続けることはない（`clear` も要らない） */
  private lastCommandAt = new Map<CommandId, number>();
  /** V157 (D-3): 同じコマンドがこの時間内に2回来たら2回目を捨てる。
   *  人間の押し直しは 50ms では届かず、ドライバの二重送信は 1〜2ms で来る（A-27 の報告） */
  // ================= V165 (D-4): 修飾キーの単体タップ =================
  //
  // ★なぜ「離したとき」か
  //   押した時に確定させると **Ctrl が先に発火して Ctrl+○○ が一切割り当てられなくなる**。
  //   離した時なら「間に別のキー／ポインタ操作が挟まったか」で組み合わせと区別できる。
  //   `main.ts` の「修飾キー単体は待ち続ける」（＝押した時は確定しない）は**そのまま残っている**。
  //
  // ★発動する条件（全部そろったときだけ。1つでも欠けたら候補を捨てる）
  //   1. 修飾キー（Ctrl / Shift / Alt）の keydown で候補が立つ（`e.repeat` は候補を捨てる）。
  //      V183 (A-82): その keydown で**ほかの修飾キーが押されていない**こと（イベントのフラグで見る・Win / ⌘ も数える）。
  //      以前は 2 つ目の修飾キーで候補を捨てたあと、3 つ目で新しい候補が立った（⇧＋⌥ を押したまま Ctrl をトンで発動）
  //   2. その間に**他のキーが押されない**（＝組み合わせではない）
  //   3. その間に**ポインタが下りない**（＝描いていない・ボタンを押していない）
  //   4. **同じ修飾キー**の keyup が MOD_TAP_MS 以内に来る
  //   5. 離した時点で mounted・ダイアログなし・文字入力中でない・ポインタが下りていない
  //   ペンタブのサイドスイッチが「押しっぱなしで送り続ける」設定のときは 1 か 4 で落ちる
  //  （＝発動しない。誤爆するより発動しないほうが安全・要件 §1 D-4 ⚠4）
  //
  // ★`preventDefault` は**一切しない**。Alt を止めると Alt＋クリックのスポイト（M16 K-4）や
  //   OS 側の挙動に手を入れることになる。ここは keyup を**見ているだけ**
  /** 立っている候補を見張る状態機械（条件としきい値は `keymap.ts` の1か所） */
  private modTap = new ModTapWatcher();

  /** V165 (D-4): keydown 側。候補を立てる／壊す（**発動はしない**）。
   *
   *  ★独立レビューの指摘①: **候補を立てる時点**で「描いている最中か」を見る。
   *   ここを keyup 側だけで見ていると、**描きながらサイドスイッチで Alt を押し、
   *   ペンを先に離してから Alt を離す**と、離した時点では `pointerDown` が false なので
   *   発動してしまう（ペンタブでいちばん起こりやすい誤爆）。 */
  private trackModTapDown(e: KeyboardEvent) {
    this.modTap.down(e.key, {
      repeat: e.repeat,
      blocked:
        !this.mounted ||
        this.pointerDown ||
        this.dialogOpen() ||
        this.isTextEntry(e.target) ||
        e.isComposing ||
        e.keyCode === 229,
      mods: e, // V183 (A-82): ほかの修飾キーが押されていたら候補にしない（判定は keymap.ts の tapCandidateOf）
    });
  }

  /** V165 (D-4): ポインタが下りたら候補を捨てる（描いている最中・ボタン操作中は判定しない）。
   *  window の capture で拾うので、キャンバスでも右パネルでも同じように効く */
  private modTapPointerHandler = () => {
    this.modTap.cancel();
  };

  /** V165 (D-4): keyup 側。条件がそろっていれば割り当てを実行する */
  private handleModTapUp(e: KeyboardEvent) {
    const key = this.modTap.up(e.key);
    if (!key) return;
    // 離した時点の門番（Space の単押しと同じ並び）＋描画中は判定しない
    if (!this.mounted || this.dialogOpen() || this.isTextEntry(e.target) || this.pointerDown) return;
    const ids = this.keyLookup.get(tapEventKey(key));
    if (!ids || ids.length === 0) return; // ★既定では何も割り当てていない＝ここで必ず抜ける
    // 独立レビューの指摘③: 道具どうしの同キー巡回は**押したときと同じ規則**で選ぶ（先頭固定にしない）
    const id = this.pickCommandFromIds(ids);
    // 独立レビューの指摘④: 「押している間だけ」の操作はタップでは動かさない（透かしが戻らなくなる）。
    // 設定画面でも割り当てを断っているので、ここは保存データを手で書いた場合の保険
    if (isHoldOnlyCommand(id)) return;
    // ★V157 (D-3) の二重発火防御（A-27）を**そのまま通す**。ドライバが keyup を2回送っても
    //  50ms 以内の2回目は捨てる（弱めない・要件の壊すなリスト）
    const now = performance.now();
    const prev = this.lastCommandAt.get(id);
    if (prev !== undefined && now - prev < Editor.DOUBLE_FIRE_MS) return;
    this.lastCommandAt.set(id, now);
    this.endArrowSession();
    this.runCommand(id);
  }

  /** V181（独立レビュー 1 回目・中）: 一致した打鍵を**押しっぱなしのくり返しだから走らせない**とき、Mac でだけ既定の動きを止める。
   *  WKWebView はページが止めなかった ⌘ のキーを既定のメニュー（Edit の Copy / Cut / Paste…）へ回し、メニューに無い
   *  ⌘S などは警告音になる。一致した以上はアプリのキーなので、走らせなくても止める（⌘C を押しっぱなしにしても
   *  2 回目以降がメニューの Copy にならない）。**Windows は今までどおり止めない**（1 か所も変えない） */
  private swallowRepeatOnMac(e: KeyboardEvent): void {
    if (isMacPlatform()) e.preventDefault();
  }

  /** M11-15: 同じキーを複数の道具が共有しているときの選び方（末尾→先頭へ循環）。
   *  V165 (D-4・独立レビューの指摘③): 押したとき（`onKeyDown`）とタップとで**同じ規則**を使うため関数にした */
  private pickCommandFromIds(ids: CommandId[]): CommandId {
    if (ids.length <= 1) return ids[0];
    const curId = `tool.${this.tool}`;
    const at = ids.indexOf(curId as CommandId);
    return at >= 0 ? ids[(at + 1) % ids.length] : ids[0];
  }

  private static readonly DOUBLE_FIRE_MS = 50;
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
    // ★V214 (M-2b-1a): 先頭の全レイヤーの束の確定（どのコマンドでも）と、作品と描く状態だけで決まるコマンドはコアの runCoreCommand。
    //  受け取ったらここで終わり。残りはファイル・書き出し・表示・ダイアログ・最後のポインタの位置を使うもの
    if (this.runCoreCommand(id)) return;
    switch (id) {
      // M16 (K-4): 主にポインタ割り当て（Alt＋クリック）用。キーに割り当てられたときは直近のカーソル位置で拾う
      case "edit.pickColor":
        if (this.lastPointerEvent)
          this.pickColorAt(
          this.clientToPixel(this.lastPointerEvent.clientX, this.lastPointerEvent.clientY),
          "key"
        );
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
      case "frame.wobble":
        void this.onWobbleClick();
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
      case "view.miniToggle":
        // M11-16: id は据え置き（旧プリセットに保存された割り当てがそのまま新トグルを動かす）。
        // 中身は「HUD をまとめて隠す/出す」に置き換わった
        this.toggleHudHidden();
        break;
      case "view.focusToggle":
        this.toggleFocus(); // M11-18: キャンバス集中（ボタンと同じ入口）
        break;
    }
  }

  // ---------------- M11-10: 矢印キーの1ドット移動（移動セッション） ----------------
  // ★V214 (M-2b-1a): セッション（arrowKind・たまった量・800ms の自動確定・確定と取り消し）はコア（editorCore.ts）へ移した。
  /** Shift＋矢印の移動量（仮の値・REQ 未決7） */
  private static readonly ARROW_BIG_STEP = 10;

  /** 矢印キー（割り当て対象外・モードで意味が変わる固定キー）。★V214: 中身（どの枝で何を動かすか）はコアの nudgeArrow。
   *  キーの照合と Shift で 10 はここ（キーボードの事情）。受け取ったときだけ既定の動きを止める（前と同じ） */
  private handleArrowKey(e: KeyboardEvent) {
    const step = e.shiftKey ? Editor.ARROW_BIG_STEP : 1;
    const dx = e.code === "ArrowLeft" ? -step : e.code === "ArrowRight" ? step : 0;
    const dy = e.code === "ArrowUp" ? -step : e.code === "ArrowDown" ? step : 0;
    if (this.nudgeArrow(dx, dy)) e.preventDefault();
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
    // ★V178 (A-72): エディタのキー処理へ進むキーが来たら、全レイヤーの束を**どの分岐より先に**確定して終える。
    //  ショートカットの表を通らない固定のキー（Backspace の選択消去・Enter でフォーカスのあるボタンを押す…）も、ここなら先に通る。
    //  修飾キーと Space（描きながら押さえて使う）と、押しっぱなしのくり返しでは終えない。ダイアログ・文字入力欄・IME 変換中の
    //  キーはエディタの操作ではないので上の関所で抜ける（そこから作品が変わっても、履歴を積む直前の網＝EditorHistory が拾う）
    //  ★V214: 確定そのものはコアの settleEraseAll（どのキーで確定するかはここ＝キーボードの事情）
    if (!e.repeat && !Editor.HELD_WHILE_DRAWING.has(e.key)) this.settleEraseAll();

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
      // M14 (S-1): 形式ストリップが出ているときは、まずそれを畳む（他の Esc の意味より先）
      if (this.stripOpenFor) {
        this.closeStrip();
        return;
      }
      if (this.rowDrag) {
        // M3.9 H-2: レイヤードラッグ中の Esc はドラッグだけキャンセル
        this.cancelRowDrag();
        return;
      }
      if (this.frameDrag) {
        this.cancelFrameDrag(); // M11-7: コマの並べ替え中も同じ（並びは動かさない）
        return;
      }
      if (this.splitDrag) {
        this.cancelSplitDrag(); // M11-17: スプリッター中の Esc は掴む前の寸法へ戻して終わる
        return;
      }
      // ★V214 (M-2b-1a): ここから先（文字の下書き→矢印の移動→選択の枠の移動→レイヤーの移動は、それだけ取り消して戻る／
      //  最後に変形と四隅を取り消し、選択も外す）はコアの escapeKey（作品に効く所・取り消す順は前と同じ）
      this.escapeKey();
      return;
    }
    if (e.code.startsWith("Arrow")) {
      this.handleArrowKey(e);
      return;
    }
    if (e.code === "Backspace") {
      // 従来から Delete と2つある（Delete 側は割り当て可能・こちらは固定）。
      // M11-15: 選択範囲があるときの選択消去は**固定の最優先**のまま。選択が無いときだけ
      // 下の割り当て（キー → コマンド）へ流す＝Backspace に「このコマを消す」等を当てられる。
      // 未割り当てなら keyLookup に無いので何も起きない（従来と同じ）
      // ★V214: 中身（選択を消す）はコアの backspaceKey。受け取ったときだけ既定の動きを止める（前と同じ）
      if (this.backspaceKey(e.repeat)) {
        e.preventDefault();
        return;
      }
      // 選択が無い → 割り当てへフォールスルー
    }
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      // ★V214: 文字の確定（Ctrl／⌘＋Enter）→ 変形 → 四隅 → 矢印の移動の確定はコアの enterKey（確定する順は前と同じ）
      if (this.enterKey(primaryMod(e))) {
        e.preventDefault();
        return;
      }
      // M11-2: ボタンにフォーカスがあるときはブラウザ既定の「Enter でそのボタンを押す」を
      // 優先する（二重発火を避ける）。この判定は Enter/Space にだけ要る
      if ((e.target as HTMLElement | null)?.closest?.("button, a")) return;
      // 以降は割り当て（既定では play.toggle＝再生サブキー）へ流す
    }

    // ---- 割り当て（キー → コマンドID → 実行） ----
    const ids = this.keyLookup.get(eventKey(e));
    if (!ids || ids.length === 0) return;
    // M11-15: 道具の同キー巡回。今のツールがそのキーの巡回グループに含まれていれば次へ
    //（末尾→先頭へ循環）、含まれていなければ定義順の先頭へ。**キーリピートでは巡回しない**
    let id: CommandId = ids[0];
    if (ids.length > 1) {
      if (e.repeat) return this.swallowRepeatOnMac(e);
      id = this.pickCommandFromIds(ids); // V165: タップ側と同じ規則（`pickCommandFromIds`）
    }
    // ツール切替などはキーリピートで連続実行しない（Undo/Redo・コマ移動・ズームは従来どおり連続）
    if (e.repeat && !Editor.REPEATABLE.has(id)) return this.swallowRepeatOnMac(e);
    e.preventDefault();
    // ★V157 (D-3): 二重発火の防御（A-27）。**押しっぱなしのリピートではない**イベントに限り、
    // 同じコマンドが 50ms 以内にもう一度来たら2回目を捨てる。
    // ドライバやペンのユーティリティがキーを2回送ってくることがあり、Undo が2手戻る等が起きる。
    // `e.repeat === true` は対象外＝巻き戻し連打・ズーム連打は従来どおり効く。
    // 人間が同じキーを 50ms 以内に押し直すのは実質不可能なので、正当な操作は落ちない
    if (!e.repeat) {
      const now = performance.now();
      const prev = this.lastCommandAt.get(id);
      if (prev !== undefined && now - prev < Editor.DOUBLE_FIRE_MS) return;
      this.lastCommandAt.set(id, now);
    }
    // M11-11: 「押している間だけ」のコマンド用に、いま押されている物理キーを渡す
    this.peekPendingCode = e.code;
    // M11-10: 別の操作を始めたら、矢印キーの移動セッションは確定する
    this.endArrowSession();
    this.runCommand(id);
  }


  // ================= ★V213 (M-2a): コアの画面の口（フック）の上書き =================
  // 前はコアへ移したメソッドの中にあった画面の行。呼ばれる時と順番は前と同じ（コアのその行の位置から呼ばれる）

  /** コアの `pointerDown` の書き込み口から呼ばれる（前は setter の中にあった 1 行） */
  protected override pointerDownChanged(v: boolean): void {
    // 手のひら/Space のパンは「描いている」わけではないので薄くしない（倍率表示を見ながら動かせる）。
    // panState は pointerDown=true より前に立つ（onPointerDown のパン分岐）ので、ここで判定できる
    this.setStrokeHud(v && !this.panState);
  }

  /** 太さ・全レイヤーの消しゴムが変わったので、カーソルの輪を描き直す（前はコアへ移した 2 か所の 2 行） */
  protected override repaintCursor(): void {
    this.cursorPainted = "";
    this.paintCursorLayer();
  }

  /** 図形・選択の移動・変形の下書きの層を消す（前は `this.overlayCtx().clearRect(0, 0, W, H)` の 1 行） */
  protected override clearOverlay(): void {
    this.overlayCtx().clearRect(0, 0, W, H);
  }

  /** setTool の途中（道具を替えた直後・変形や四隅を始める前）: 前の道具のストリップを畳み、太さの表示を合わせる */
  protected override toolChanging(t: Tool): void {
    // M14 (S-1): 別ツールへ切り替えたら、前のツール用に開いていたストリップは畳む
    if (this.stripOpenFor && this.stripOpenFor !== t) this.closeStrip();
    // M11-2: 太さの実体は sizeByTool なので、ここは表示（.sz の on）を合わせるだけ
    this.refreshSizePicker();
  }

  /** setTool の終わり: 道具の列・オプション・カーソルを今の道具に合わせる */
  protected override toolChanged(): void {
    this.updateToolButtons();
    this.buildToolOptions();
    this.rebuildTexPicker(); // M5-4: ペン⇄ブラシでピッカー切替（各自の選択を記憶）
    this.redrawOverlay();
    // M12-C: 1階（CSS の cursor）と2階（輪・枠）をツールに合わせ直す。
    // ここは既にある redrawOverlay の直後で、ホバー経路とは無関係（頻度はツール切替のときだけ）
    this.applyCanvasCursor();
    // A-21: 手のひら/Space パンで `#ed-cvwrap` に残った grab/grabbing を、切り替えた道具に合わせて畳む。
    // ペンで pointerdown すると外枠が setPointerCapture でカーソルの決定権を握るので、
    // canvas 側だけ直しても掴んだ瞬間に外枠の grab が出てしまう（capture の仕様）
    this.updatePanCursor();
    this.cursorPainted = "";
    this.paintCursorLayer();
    this.revealToolOptions();
  }

  /** 束の確定（finishEraseAllNow）が押している接触を終えた: 終端の控えを捨てて捕捉を放す */
  protected override pointerReleased(): void {
    this.lastPointerEvent = null;
    this.releaseCapture();
  }

  /** 重い処理に入った（busyKind はコアが立てた）: ポインタを止める（キーは dialogOpen() が見る）。**遅延なしで即座に**——
   *  進捗が出るまでの 450ms に触られたら、そこで混ざったものが保存される */
  protected override busyStarted(): void {
    document.querySelector("#screen-editor")?.classList.add("ed-busy");
    this.updateBusyButtons();
  }

  /** 重い処理から出る直前（busyKind を下ろす前）: 遅れて出す進捗の待ちと、出ている進捗を畳む */
  protected override busyClosing(): void {
    if (this.busyTimer) {
      clearTimeout(this.busyTimer);
      this.busyTimer = 0;
    }
    this.busyHide?.();
    this.busyHide = null;
  }

  /** 重い処理から出た（busyKind を下ろしたあと）: ポインタとボタンを戻す */
  protected override busyEnded(): void {
    document.querySelector("#screen-editor")?.classList.remove("ed-busy");
    this.updateBusyButtons();
  }

  /** 再生の ▶／⏸ のボタン */
  protected override playStateShown(playing: boolean): void {
    if (playing) {
      $("#ed-play").replaceChildren(icon("pause")); // V171: 状態ペア play / pause
      return;
    }
    const btn = document.querySelector("#ed-play");
    if (btn) btn.replaceChildren(icon("play")); // V171
  }

  /** 変形を抜けた: モードの札を消し、外枠のカーソルを空に・キャンバスは今のツールのカーソルへ */
  protected override xformCursorReset(): void {
    this.hideXformModeLabel(); // R-2
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (wrap) wrap.style.cursor = "";
    // M12-G: 変形を抜けたらキャンバスは**今のツールのカーソル**へ戻す（空にはしない）
    this.applyCanvasCursor();
  }

  /** 変形の取っ手を掴んだ: 掴んだ瞬間からモードが分かるようカーソルも更新（回転中は grabbing） */
  protected override xformDragCursor(cursor: string): void {
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (wrap) wrap.style.cursor = cursor;
    this.setCanvasCursor(cursor); // M12-G
  }

  /** 変形の取っ手を離した: モードの札を消し、カーソルをいまの当たりに合わせる */
  protected override xformDragEnded(pt: { x: number; y: number }): void {
    this.hideXformModeLabel(); // R-2: ペンを離したらラベルを消す（hover環境では次のmoveで再表示）
    const wrap = document.querySelector("#ed-cvwrap") as HTMLElement | null;
    if (wrap) wrap.style.cursor = this.xformHitTest(pt).cursor;
    this.setCanvasCursor(this.xformHitTest(pt).cursor); // M12-G: キャンバス上にも
  }

  /** 進みが止まったと見なす基準の時刻と、それを見るタイマー（`savePrepShow` の中だけ） */
  private savePrepLastAt = 0;
  private savePrepStallTimer = 0;
  /** 保存の前の片付け（コアの prepareSnapshot）の進み具合を「保存の準備…」に出す（前は prepareSnapshot の中） */
  protected override savePrepShow(stage: "begin" | "moved" | "pass" | "end" | "save", prog: { n: number; total: number } | null): void {
    switch (stage) {
      case "begin":
        if (prog) this.savePrep = { n: prog.n, total: prog.total };
        this.setSavePhase("prepare");
        this.savePrepLastAt = performance.now();
        this.savePrepStalled = false;
        // ★独立レビューの指摘（中）: 描き続けていると掃除は只のものしか進まず、数字が止まる。
        //  3 秒動かなければ「手を離した合間に片づけが進みます」の文言へ切り替える（1 秒ごとに見る）
        this.savePrepStallTimer = window.setInterval(() => {
          const stalled = performance.now() - this.savePrepLastAt > Editor.SAVE_PREP_STALL_MS;
          if (stalled !== this.savePrepStalled) {
            this.savePrepStalled = stalled;
            this.renderSavePhase();
          }
        }, 1000);
        return;
      case "moved":
        if (prog) this.savePrep = { n: prog.n, total: prog.total };
        this.savePrepLastAt = performance.now();
        this.savePrepStalled = false;
        this.renderSavePhase();
        return;
      case "pass":
        if (prog) this.savePrep = { n: prog.n, total: prog.total };
        this.renderSavePhase();
        return;
      case "end":
        clearInterval(this.savePrepStallTimer);
        this.savePrepStalled = false;
        return;
      case "save":
        this.setSavePhase("save");
        return;
    }
  }

  /** 重い処理の前に 1 拍譲る（始まったら返ってこない同期の処理でも、「受け付けた・押せなくなった」は必ず見える） */
  protected override heavyYield(): Promise<void> {
    return yieldToPaint();
  }

  /** 重い処理の「◯◯しています」の箱と計測（`ui/busy.ts` の漏斗） */
  protected override heavyBox<T>(op: PerfOp, msg: string, fn: () => Promise<T>, delayMs: number): Promise<T> {
    return runWithBusy(op, msg, fn, delayMs);
  }

  /** 画面の出来事 → コアのサンプル。x・y は `clientToPixelF`（拡大・回転・左右反転の逆写像）の結果そのもの。
   *  `pointerType` は渡さない（描いた結果を入力の種類で変えない） */
  private sampleOf(e: PointerEvent): StrokeSample {
    const p = this.clientToPixelF(e.clientX, e.clientY);
    return { x: p.x, y: p.y, pressure: e.pressure, button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
  }

  /** ★V213 (M-2a): メーターの中身と、大きさの帯が上がったときの知らせ（前は updateSizeMeter の後ろ半分。
   *  眠りの始まりと履歴の予算はコアの updateSizeMeter が決めて、ここへ数を渡す） */
  protected override paintSizeMeter(proj: number, real: number, _t0: number): void {
    const host = document.querySelector("#ed-szmeter") as HTMLElement | null;
    if (!host) return;
    // ★V214 (M-2b-1a): 段の決め方（と性能の口が読む面数）はコアの sizeVerdict。段が上がったときのログと知らせはコアの noticeSizeLevel
    const { hist, total, level, faces } = this.sizeVerdict(proj);
    host.className = "szmeter lv-" + level;
    const row = (label: string, n: number, cls = "") =>
      `<div class="szrow ${cls}"><span>${label}</span><b>${formatSize(n)}</b></div>`;
    // V154b: **面数（レイヤー×コマ）**。バイト数より分かりやすい（作者の指示）。
    //
    // V155（独立レビュー §1・優先度 高）: 出す数字は同じだが、**言葉を変えた**。
    // V154b では「開ける上限 約5,242面」「保存できても開き直せません」と書いていた。
    // 分割読み込みにした今、それは**嘘**になる（21,960面の再現データが実際に開く）。
    // 「画面が示すことと実際に起きることが食い違う」＝要件が名指しで避けろと言っている形。
    // いまは同じ数字を**重くなる目安**として出し、「分けると軽い」で終える（脅さない）
    const faceMax = loadWallFaces(this.project.indexBits === 16 ? 16 : 8);
    const overWall = faces > faceMax;
    host.innerHTML =
      row(t("ed.size.project.label"), proj) +
      // V156（独立レビュー §5・優先度 高）: 「200回戻れる」と読んで危ない操作を試した人が、
      // 実際には減っていることにボタンが灰色になるまで気づけなかった。**いま何回戻れるか**を出す
      row(t("ed.size.history.steps.label", { n: this.history.undoDepth }), hist) +
      row(t("ed.size.total.label"), total, "tot") +
      // V156 (P-1): 眠りが効いている作品だけ、**実際に使っている量**をもう1行出す。
      // 上の3行は論理サイズ（＝作品の大きさの目安）のままで、意味は変えていない。
      // V156（独立レビュー §2）: 片付けの最中はそれが分かるようにする（27 秒かかるので、
      // 数字が動いていること自体が「壊れていない」の合図になる）
      (this.sleepOn
        ? row(this.sweeping ? t("ed.size.real.busy.label") : t("ed.size.real.label"), real)
        : "") +
      `<p class="sznote${overWall ? " adv" : ""}">${t("ed.size.faces.msg", {
        n: faces.toLocaleString(),
        max: faceMax.toLocaleString(),
      })}</p>` +
      // 目安を超えている＝開くのも保存も重い。**開けなくなるとは言わない**（V155）
      (overWall ? `<p class="sznote adv">${t("ed.size.overWall.msg")}</p>` : "") +
      // 「統合したのに『元に戻す』が減らない」を**説明なしで**分かるようにする1行（要件 §2-W-2）
      `<p class="sznote">${t("ed.size.history.msg")}</p>` +
      // V156（独立レビュー §5）: 200 回という約束と「自動で減る」の関係を、**約束のそばに**書く
      `<p class="sznote">${t("ed.size.undo.msg")}</p>` +
      // V156（独立レビュー §1・優先度 高）: 同じ箱に**論理サイズ**と**実メモリ**が並ぶので、
      // 「どっちが本当のメモリなのか」が分からなくなる。眠りが効いているときだけ1行で分ける
      (this.sleepOn ? `<p class="sznote">${t("ed.size.twoNumbers.msg")}</p>` : "") +
      (level === "ok" ? "" : `<p class="sznote adv">${t(Editor.SIZE_ADVICE[level].msgKey)}</p>`);
    // 右パネルは縦に長い＝**下端のメーターは画面の高さによっては見えない**（900×540 で実測: 内容 943px /
    // 見える高さ 458px）。色が付いても気づかない人がいるので、**帯が上がったときだけ一度知らせる**。
    // 失われた 500〜600コマの作品はちょうど「注意」の帯（132〜264MB）だった＝ここで黙っていると
    // 今回の事故と同じことが起きる（独立レビューの指摘・優先度 高）。
    // 1つの作品で最大2回（注意で1回・警告に上がってもう1回）・小さい作品では絶対に出ない・
    // 閉じるだけで何も起きない（止めない）
    this.noticeSizeLevel(level, proj, hist, total);
    // V159 (G-1): メーターは全コマを走査する（面数・実メモリ）。**呼ばれる回数が多い場所**なので、
    // ここが 50ms を超えて何度も出るなら、それ自体が「操作が重い」の一因
    perfDone("meter.update", _t0);
  }}



