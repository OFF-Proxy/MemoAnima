// ★V213 (M-2a・docs/REQ_mobile_m2_editor.md): 描く操作のコア（画面を持たない部品）。
//
// 作品・画素・履歴・眠り（大きい作品のメモリの扱い）に触るもの、描いた結果を決めるものはここ（決-3）。
// 画面を組む・置く・見せるものは、これを受け継ぐ画面の側（PC は src/editor/editor.ts の `Editor`、
// M-2b のモバイルは同じくこれを受け継ぐ描く画面）。コアは `document`・`window` を触らない
// （v213_smoke [N] の網: DOM の語・`pointerType`・画面と書き出しの部品の import が無い・コアだけの束に入らない）。
//
// ■ 描く入力（モバイルの画面が呼ぶ。PC は同じ片を自分の順番で呼ぶ＝下の「ポインタ」の節）
//   strokeBegin(s) / strokeMove(samples) / strokeEnd(s) / strokeCancel() / modifiersChanged(m)
//   s は StrokeSample（x・y はキャンバスの画素の座標の小数＝画素 n が [n, n+1)・pressure・button・shift・alt・ctrl・meta）。
//   `Math.floor` と線に渡す半画素ずらしはコアの中（samplePixel / sampleStrokePt）。`pointerType` は受け取らない。
//   strokeCancel は押してからの変化を押す前に戻す（履歴は積まない・積んでいたら取り除く）。PC は呼ばない（決-6）。
//   ★V214: strokeCancel は結果を返す（"none"・"restored"・"asleep"＝眠っていて戻せない＝何も変えない）。使い道は長押しのスポイト（決-14）。
//   strokeEnd は「この接触で履歴が積まれたか」を返す（手のひらの線は確定して、積まれていれば取り消す）。
//
// ■ 画面の口（フック）。コアの中では何もしない。画面の側が上書きする（名前は PC の今の名前のまま＝決-4）
//   呼ぶ時                                           PC（Editor）がすること
//   renderCanvas()           作品の絵が変わった・コマを移った    キャンバスを描き直す（眠ったコマは起こしてから）
//   paintFilmThumb(i)        コマ i の絵が変わった              フィルムのサムネを塗り直す
//   rebuildFilm()            コマの数・並び・色の目印が変わった  タイムラインのフィルムを組み直す
//   rebuildLayers()          レイヤー・フォルダが変わった        レイヤーの一覧を組み直す
//                            ★V214: コアの既定の中身は選択の手入れ（pruneSelection）。上書きするときは、組み直す前に super.rebuildLayers() を呼ぶ
//   rebuildPalette() / rebuildFavPalette()  色の表・お気に入りが変わった  パレットを組み直す
//   rebuildTexPicker()       マイ柄を足した・消した              種類の一覧を組み直す
//   buildToolOptions() / updateToolButtons() / afterFormatChange()  道具・形式が変わった  道具のオプション・列・ストリップ
//   paintUiOverlay() / paintSelectionUi() / redrawOverlay()  変形の枠・選択の線・下書きが変わった  重ねる層を描き直す
//   redrawSelMovePreview() / previewShape(a, b) / previewSelectRect(a, b)  ドラッグ中の下書き  下書きの層に描く
//   clearOverlay()           下書きを消す                       下書きの層を消す
//   refreshSelectionLauncher()  選択が変わった                 選択の小窓を出す・動かす・隠す
//   updateFilmSeMarks() / updateFilmSelection() / updateFilmColorMark(i)  効果音・選んだコマ・色の目印  フィルムの印
//   updateAudioToolButton()  効果音が変わった                   音声の道具のボタン
//   updateXformBadge() / muteFloatingOverlays(on)  変形・四隅の始めと終わり  変形中の札・浮いている UI を薄く
//   xformCursorReset() / xformDragCursor(c) / xformDragEnded(pt)  変形の終わり・取っ手を掴む・離す  カーソルとモードの札
//   updateLayerClipButtons() / updatePasteButton() / syncPasteRangeLabel() / revealLayerClip()  控えが変わった  貼り付けのボタン
//   focusTextInput()         文字の下書きを始めた               入力欄にフォーカス
//   flushInputLogSoon()      入力の診断ログに 1 行足した          少し待って書き出す（?inputlog のときだけ）
//   （★V214: endArrowSession はフックでなくコアのメソッドになった＝1 ドット動かすの確定。PC は上書きしない）
//   pointerDownChanged(down) 押している印が変わった             HUD を薄くする／戻す（パンの最中を除く）
//   pointerReleased()        束の確定が押している接触を終えた   終端の控えを捨てて捕捉を放す
//   repaintCursor()          太さ・全レイヤーの消しゴムが変わった  カーソルの輪を描き直す
//   toolChanging(t) / toolChanged()  setTool の途中と終わり     ストリップ・太さの表示／道具の列・オプション・カーソル
//   busyStarted() / busyClosing() / busyEnded()  重い処理の入口と出口  ボタンとポインタを止める・進捗を畳む・戻す
//   heavyYield() / heavyBox(op, msg, fn, delay)  重い処理の中身の前と周り  1 拍譲って描かせる／「◯◯しています」の箱と計測
//   playStateShown(playing)  再生を始めた・止めた               ▶／⏸ のボタン
//   paintSizeMeter(proj, real, t0)  作品の大きさを数え直した    大きさのメーターと、帯が上がったときの知らせ
//   savePrepShow(stage, prog)  保存の前の片付けの進み具合        「保存の準備…」の表示
//   ★V214 で足したフック:
//   refreshSizePicker()      コマンドで太さを替えた             太さの段の印
//   undoRedoShown()          履歴が動いた（historyChanged の頭）  取り消しとやり直しのボタンの有効・無効
//   showWaitBadge(on)        眠ったコマを起こすのが 150ms を超えた・起こし終えた  待ちの札
//   xformHitSizes()          変形の当たりを測る                 当たりの大きさ（キャンバスのドット）を返す（PC は 6・12・8）
//   workEdited()             dirty = true のたび（すでに立っていても）  ★PC は上書きしない（モバイルだけ・セッションと時計の noteEdit）
//
// ■ ★V214 (M-2b-1a) で PC から分けた口（モバイルの描く画面も同じものを呼ぶ。PC は前と同じ順で呼ぶ）
//   開く・閉じる: openWorkStart → openWorkReset → openWorkPlayAndFloat → openWorkSelection → openWorkPointer → openWorkNotice →
//     openWorkClean → openWorkSweepSoon ／ closeWorkStart → closeWorkSleep → closeWorkPending → closeWorkWarp → closeWorkEnd
//   絵を描き直す: renderWork(present)（眠ったコマを起こす・1px の仮を打ったまま present を呼ぶ・オニオン）
//   コマンド: runCoreCommand(id)（先頭で全レイヤーの束を確定・受け取ったかを返す）
//   決まったキー: escapeKey()・enterKey(primary)・backspaceKey(repeat)・settleEraseAll()／1 ドット動かす: nudgeArrow(dx, dy)・
//     endArrowSession()・cancelArrowSession()（800ms の自動確定）／別の操作を始めた: otherOperationStarted()
//   履歴が動いた: bindHistory()・historyChanged()／大きさ: sizeVerdict(proj)・noticeSizeLevel(…)
//   オートセーブ: autosaveBlocked()・autosaveMark()・autosaveChangedSince(mark)（PC の便の印・書き出し中・時計の世代は入れない）
//   裏に回ったときの姿: workForBackground()（★PC は呼ばない）／保存と戻る前の関所: saveBlocked()・leaveBlocked()
//   パネルとタイムライン: toggleFolderCollapsed・toggleFolderVisible・renameFolder・setFolderOpacityLive・commitFolderOpacity・
//     toggleLayerVisible・renameLayer・setLayerOpacityLive・selectLayerRow・grabRowForDrag・openFolderForDrop・setFillMode ほか形式・
//     setTextFamily ほか文字・deselect・setXformAngleInput・setXformScaleInput・cancelTransformAndReturn・toggleFullcolor・selectColor・
//     setOnionLevel・setOnionDir・setToneIdFor・pickPenTexture・toggleDitherFrameShift・toggleCustomToneColor・toggleLoop・
//     setSpeedIndex・clickFrame・setBgmSyncMode・restore*（settings からの復元）
//   ★V215 (A-125): 使っていない色をまとめて消す＝tidyPaletteColors()（調べる・確かめる・消す・取り消しに積むは全部ここ。画面はボタンから呼ぶだけ）
//
// ■ アプリへの知らせ（`cb`＝CoreCallbacks。PC の EditorCallbacks はこれを広げる）
//   toast・confirm・confirmSkippable・choose・notice・appendLog（何を聞くか・知らせるかはコアが決め、出すのは画面）
//   onCustomTonesChange・onFavoriteColorsChange・onOnionChange・onHiddenConfirmsChange（人の好みが変わった＝設定へ保存）
//
// ■ PC に残したもの（§4-2・★V214 で上の口を分けたあと）: 画面を組む・置く・ダイアログを組む・画面の出来事（ポインタの捕捉・Space と手のひらのパン・
//   修飾キー＋クリックのコマンド・右クリックの決まり・ホイール・カーソルとモードの札・取りこぼしの自己修復・入力の診断ログ）・
//   表示の変換（clientToPixelF）・キーボードとコマンドの表（決-10）・保存とオートセーブの段取り（決-11）・PC の設定の読み書き。

import { Project, LayerDef, LayerFolder, IndexBuf, W, H, PIXELS, FPS_TABLE, PenTexture, ensureColor, allocIndexBuf, copyIndexBuf, promoteTo16, newLayerId, newFolderId, makeEmptyFrame, cloneFrame, conformFrameWidth, UGO_COLORS, DEFAULT_PALETTE, effectiveLayerStates, ancestorLocked, relinkShared, projectBytes, newSeId, sanitizeAudio, projectFaces, loadWallFaces, LOAD_WALL_BYTES } from "../model";
import { flattenIndexFrame, compositeFrame, type OnionDir } from "../render";
import { playStartFrame } from "../playStart";
import { PlayClock, startTimeOf, type PlayHost, type PlayPaused, type BgmPlan } from "../playClock";
import { colorSlots, scanColorUse, colorDeleteVerdict, scanAllColorUse, allColorVerdict } from "../colorUsage";
import { normalizeFavColor, sanitizeOnionLevel, sanitizeOnionDir, sanitizeFavoriteColors, FAVORITE_COLORS_MAX, clampAddFrames, HEAVY_ALLOC_MAX_BYTES, checkFrameAlloc, isAllocFailure, estimateBits, promotionExtraBytes, shouldNoticePick, snapshotBytes, saveSnapshotPlan, saveSnapshotAllowed, SAVE_SNAPSHOT_MAX_BYTES, type SnapshotEstimate } from "../prefs";
import { History, bufferChangeEntry, entryBytes, multiBufferChangeEntry, NO_COLOR_REFS, type HistoryEntry, type HistoryMark } from "../history";
import { WarpField, applyWarp, isConvexQuad } from "../warp";
import { buildWobbleFrames, type WobbleKind, type WobbleStrength, type WobbleTarget, wobbleSeedBase } from "../wobble";
import * as R from "../raster";
import { trailStayedNearStart } from "../selOutline";
import * as L1 from "../line1px";
import * as CT from "../customTone";
import { FrameClip, makeClip, buildFramesFromClip, packClip, unpackClip, clipBytes, clipCopyBytes, clipUnpackedBytes } from "../frameClip";
import { wakeFrame, sleepFrame, invalidateFrame, awakeBytes, sleepBytes, dropLayer, wakeLayersAllFrames, wakeLayer, frameHasAsleep, setStaleSleepLogger, asleepCount } from "../sleep";
import { type LayerClip, type FolderClip, type TouchedFace, type PastePlan, recheckPastePlan, copyLayerClip, copyFolderClip, clipBuffers, planLayerPaste, applyLayerPaste, undoLayerPaste, redoLayerPaste, applyLayerOverlay, redoLayerOverlay, clipHasInk, folderPasteNewAnchor, planFolderPasteNew, orderWithPasted, pasteRange, pasteKind, copyKind } from "../layerClip";
import { formatBytes, formatSize } from "./formatBytes";
import { AudioPreview, bgmPlaybackRate, normalizeTrim } from "../audio";
import type { SeTrack, ProjectAudio, Frame } from "../model";
import { t } from "../../i18n";
import { perfNow, perfDone, setPerfContext, PERF_MIN_MS, type PerfOp } from "../../perf";
import { folderBaseName, layerBaseName } from "../../i18n/defaults";
import { moveNodes, moveTargetLayerIds as computeMoveTargetLayerIds, eraseAllTargets, wobbleTargetLayerIds, type WobbleTargets, DropTarget } from "../layerTree";
import { DEFAULT_TEXT, ensureFontsLoaded, fontDef, nearestSize, sanitizeTextSettings, type FontKey } from "../fonts";


/** M10-1c: 文字ツールの設定（settings.json に永続化する） */
export interface TextSettings {
  family: FontKey;
  size: number;
  bold: boolean;
  /** M10-11: 縦書き。旧 settings.json に無ければ false */
  vertical: boolean;
}

export type Tool =
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

export type ShapeKind = "line" | "rect" | "ellipse";
// M14 (S-2): 塗りツールの形式。bucket=従来のバケツ塗り / enclose=囲い塗り（ドラッグで囲んだ内側）
export type FillMode = "bucket" | "enclose";

/** M10-2a: 歪みの方式。M10-2a で動くのは push のみ（残りは M10-2b/2c） */
export type WarpMode = "push" | "bulge" | "pinch" | "corner";
// M14 (S-2): 囲い塗りで「これ未満の面積は誤タッチ」とみなして何もしない画素数のしきい値
export const ENCLOSE_MIN_PX = 8;
// M16 (D-1): 「コマでずらす」1コマあたりのトーン参照座標オフセット（斜め (+1,+1)/コマ）。定数化
export const DITHER_SHIFT_STEP = 1;

/** M10-23: メインスレッドを一瞬手放して、待っている入力イベントを先に処理させる。
 *  scheduler.yield（入力優先の正式API・Chromium 129+）があればそれを、無ければ
 *  MessageChannel のマクロタスク（setTimeout と違い 4ms クランプが無い）で代替する。
 *  オートセーブの分割エンコードがチャンク間で呼ぶ。 */
export function yieldToInput(): Promise<void> {
  const sch = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sch?.yield === "function") return sch.yield();
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}
/** V208 (A-119): 投げ縄・囲い塗りの点を足す間隔（前の点からの距離・ドット）。2 ドットおきはやめた（A-70 と同じ考え） */
export const TRAIL_STEP = 0.3;

/** ★V214: ペンの太さの段（前は editor.ts の上の段・字は同じ。コマンドの太さの上下がコアへ来たので移した） */
export const PEN_SIZES = [1, 2, 3, 5, 8, 12];

/** M6-6 R-2: 回転ゾーンのカーソルは標準 grab に変更。
 *  SVGカスタムカーソルは実機（WebView2＋ペンタブ）で表示されない/判別できないため撤去し、
 *  カーソル非依存の視覚補助（モードラベル .xmode-label）を併設する。 */
export const ROTATE_CURSOR = "grab";

/** ★V178 (A-72): 全レイヤー消しゴムの 1 ストロークぶんの状態。 */
export interface EraseAllStroke {
  /** なぞった作品。確定のときに作品が替わっていたら積まない（別の作品の履歴を汚さない） */
  project: Project;
  /** なぞり始めたコマ。**Frame オブジェクトで持つ**＝確定・取り消しは必ずこのコマへ戻る
   *  （表示中のコマ番号で引くと、コマを移ってからの Ctrl+Z が別のコマへ書き戻す） */
  frame: Frame;
  /** 対象のレイヤー id（下→上。規則は layerTree.ts の `eraseAllTargets`） */
  ids: string[];
  /** なぞる前の写し（対象ぶん） */
  before: Record<string, IndexBuf>;
  /** ★距離の位相（`dashAcc`）は**レイヤーごと**に持つ。同じものを枚数ぶん回すと、1 本の線分で位相が
   *  枚数ぶん進み、点線の穴の位置がレイヤーごとにずれる（要件 §3-2）。いまの消しゴムは solid で
   *  位相を消費しないが、種類が増えたときに黙って壊れないよう、形を先に揃えておく */
  dash: Record<string, { d: number }>;
  /** 📌 の id（消したら全コマの絵が変わる＝フィルムを全部塗り直す） */
  shared: Set<string>;
}

/** ★V178 (A-72・最後の網): 積む直前に 1 つだけ口を持つ履歴。
 *  全レイヤーの束より**先に**別の操作の履歴が積まれると、Ctrl+Z を続けても元の絵に戻らない。
 *  入口（コマンド・重い処理・↶↷・UI を押した時点・キー）で畳めなかった経路（知られていない経路・これから足す機能）でも、
 *  積む直前に束を確定すれば**履歴の順序（消しゴム → その操作）だけは必ず守れる** */
export class EditorHistory extends History {
  constructor(private readonly beforePush: () => void) {
    super();
  }
  push(entry: HistoryEntry) {
    this.beforePush();
    super.push(entry);
  }
}

/** ★V213 (M-2a): 描く入力の 1 点（サンプル）。PC は画面の出来事から、モバイルは自分の画面の座標から作る。
 *  x・y はキャンバスの画素の座標（小数・画素 n が [n, n+1) を占める＝PC の `clientToPixelF` と同じ決まり）。
 *  `pointerType` と画面の座標は入れない（描いた結果を入力の種類で変えない＝親 §6-9） */
export interface StrokeSample {
  x: number;
  y: number;
  /** 0〜1（取れないときは 0.5 を渡す＝筆圧で太さを変えない） */
  pressure: number;
  /** 0=主ボタン（ペン先・指）・2=副ボタン */
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/** ★V214 (§5-1 の 1): オートセーブの書き始めの印（autosaveMark）。中は履歴の変更カウンタ */
export interface AutosaveMark {
  readonly hist0: number;
}

/** ★V214 (§5-1 の 1): 変形の取っ手の当たり（キャンバスのドット）。hit＝四隅・辺・つまみの□の半径／ring＝枠の外側の回転の輪の幅／
 *  corner＝歪みの四隅（8 ハンドル）を掴む半径。**判定の順と決まりは変えない**（枠が小さいときに取っ手が重なるのは作者の決定どおり仕様
 *  ＝REQ_M13_2b_transform.md §6-1 の 4。しきい値で逃げる決まりは足さない）。つまみの位置の 12 と寄せる余白の 6 は当たりではない */
export interface XformHitSizes {
  hit: number;
  ring: number;
  corner: number;
}

/** ★V213 (決-6): やめる口の控え（strokeBegin で取り、strokeEnd・strokeCancel で捨てる） */
interface StrokeCancelSnap {
  project: Project;
  frameIndex: number;
  /** 押した時点のそのコマの全レイヤー */
  bufs: Record<string, IndexBuf>;
  selMask: Uint8Array | null;
  floatBuf: R.FloatBuf | null;
  /** 変形の値（変形の取っ手・選択の移動のずらした量） */
  xform: R.Transform;
  cornerPts: { x: number; y: number }[] | null;
  /** 履歴の並び（エントリの参照）と位置（★V214: history.ts の口で取る・戻す） */
  hist: HistoryMark;
  colorHex: string;
  tool: Tool;
  prevTool: Tool;
  dirty: boolean;
}


/** コアの操作が使うアプリへの知らせ（PC の `EditorCallbacks` はこれを広げる） */
export interface CoreCallbacks {
  /** V151 (E-8): 「次回から表示しない」チェックつき確認。ok=はい／skip=チェックが入っていた
   *  （skip を覚えるのは editor 側の confirmWithSkip。未実装の呼び出し側では confirm と同じに扱う） */
  confirmSkippable?: (msg: string) => Promise<{ ok: boolean; skip: boolean }>;
  /** V151 (E-8): 非表示にした確認の一覧が変わったら settings.json へ保存する（⚙ でいつでも戻せる） */
  onHiddenConfirmsChange?: (ids: string[]) => void;
  /** ★V214: 前は PC の EditorCallbacks（コアの手続きが使う）。M10-1c: 文字ツールの書体・サイズ・太さが変わったら settings.json へ保存する
   *  （変えた瞬間だけ。文字を置くたびには呼ばない） */
  onTextSettingsChange?: (t: TextSettings) => void;
  /** ★V214: 前は PC の EditorCallbacks（コアの手続きが使う）。M13-2a (A-2): 選択範囲の色付け表示のトグルが変わったら settings.json へ保存する（同じ流儀） */
  onSelMaskShowChange?: (show: boolean) => void;
  /** ★V214: 前は PC の EditorCallbacks（コアの手続きが使う）。M16 (D-1): トーンの「コマでずらす」トグルが変わったら settings.json へ保存する（同じ流儀） */
  onDitherFrameShiftChange?: (on: boolean) => void;
  /** ★V214: 前は PC の EditorCallbacks（コアの手続きが使う）。M17: 「🎨 登録した色で塗る」トグルが変わったら settings.json へ保存する */
  onCustomToneColorChange?: (on: boolean) => void;
  /** M17: マイ柄の一覧が変わったら（登録・削除）settings.json へ保存する。履歴には積まない */
  onCustomTonesChange?: (list: CT.CustomTone[]) => void;
  /** V164 (U-1): オニオンの段数と向きが変わったら settings.json へ保存する（同じ流儀）。
   *  作品ではなく**人の好み**なので settings 側（作品ファイルは1バイトも変わらない） */
  onOnionChange?: (level: number, dir: OnionDir) => void;
  /** V164 (U-3): よく使う色の棚が変わったら settings.json へ保存する（マイ柄と同じ流儀） */
  onFavoriteColorsChange?: (list: string[]) => void;
  confirm: (msg: string) => Promise<boolean>;
  /** V157 (D-2): 選択肢から1つ選ばせる（`null` = やめる）。レイヤーカラーの適用先など、
   *  「はい/いいえ」では足りない場面用。未実装なら呼び出し側が従来の動きへ落ちる */
  choose?: (msg: string, options: string[]) => Promise<number | null>;
  /** V154 (W-3): 「読んで閉じるだけ」の知らせ（ボタンは1つ）。選ばせる場面ではないので confirm と分ける。
   *  未実装の呼び出し側ではトーストに落ちる（editor 側で `?.` して分岐する） */
  notice?: (msg: string) => Promise<void>;
  toast: (msg: string) => void;
  /** M10-21: 入力診断ログ（ローカルの memoanima.log へ）。`?inputlog` か
   *  VITE_INPUTLOG=1 ビルドでのみ editor から呼ばれる。通常は一切呼ばれない */
  /** M10-21 → V154b (W-10): `app_config_dir/logs/memoanima.log` へ1行足す。
   *
   *  もとは `?inputlog` のときだけ使う入力診断用だったが、V154 以降は
   *  **常時オンの節目のログ**（保存の成否・検証の失敗・復元・16bit 昇格・大きさの警告・起動）
   *  も同じ流し先を使う。**作品名・パス・作品の中身は書かない**——「送ってください」と
   *  頼む前提のものなので、個人が分かるものを入れない（Rust 側でも `<user>` に伏せる）。 */
  appendLog?: (text: string) => void;
}

/** ★V213: CB＝アプリへの知らせ（PC は EditorCallbacks）・CV＝画面がプレビューを持つキャンバスの型
 *  （コアは中身を見ずに持ち回るだけ。PC は HTMLCanvasElement。コアのファイルに画面の型を書かないため） */
export class EditorCore<CB extends CoreCallbacks = CoreCallbacks, CV = unknown> {
  project!: Project;
  cb!: CB;

  frameIndex = 0;
  activeLayerId = "";
  tool: Tool = "pen";
  prevTool: Tool = "pen";
  shapeKind: ShapeKind = "line";
  shapeFill = false;
  selectKind: "rect" | "lasso" | "auto" = "rect";
  /** M10-21: 入力診断ログの有効フラグ（mount 時に判定。通常起動では false のまま） */
  protected inputLog = false;
  protected inputLogBuf: string[] = [];
  /** M10-19: 自動選択（✨）の参照（false=選択中のレイヤー / true=全レイヤー）。セッションのみ。
   *  M13-2a: false 側の意味を「このレイヤー1枚」から「**選択中のレイヤーの合成**」へ広げた
   *  （解決規則は M13-1 の `moveTargetLayerIds()` と同じ＝レイヤーを1枚だけ選んでいるときは描いているレイヤー＝ゆらゆらと同じ・V206 A-115）。
   *  boolean はそのまま＝設定の移行なし */
  selectRefAll = false;
  /** M13-2a (A-1): 範囲選択の合成方法。**ドラッグ開始時の修飾キーで決めて**、離すまで変えない
   *  （Shift=足す／Alt=引く／無し=置き換え） */
  protected selMod: "replace" | "add" | "sub" = "replace";
  /** M13-2a (A-4): コマを消すときに確認を出すか（既定オン＝従来どおり・settings.json へ永続化）。
   *  効くのは**コマの削除の確認だけ**。レイヤー・フォルダの削除の確認には触れない */
  frameDeleteConfirm = true;
  /** V151 (E-8): 「次回から表示しない」で非表示にした確認の id 集合（settings.hiddenConfirms）。
   *  対象は3つだけ: "clearFrame"（キャンバスの消す）/ "layerDelete" / "folderDelete"（作者決定）。
   *  📌全コマ共通の統一確認は対象外＝毎回出す */
  protected hiddenConfirms = new Set<string>();
  /** M10-19: 自動選択の範囲（false=つながり=4方向連結 / true=画面全体の同添字） */
  selectAutoGlobal = false;
  /** M10-19: バケツ塗りの参照（false=このレイヤー（既定・従来） / true=全レイヤー）。セッションのみ */
  fillRefAll = false;
  /** ★V178 (A-72): 消しゴムの「全レイヤー」。オンのとき、なぞったところが**そのコマの見えているレイヤー
   *  すべて**から消える（対象の規則は layerTree.ts の `eraseAllTargets`）。
   *  **覚えない**＝settings に書かない（アプリを開き直すと必ずオフ・上の `fillRefAll` と同じ「セッションのみ」）。
   *  *知らないうちにオンのまま* が、この道具でいちばん怖いから（要件 §3-4）。切り替えは `setEraseAllLayers` だけを通す */
  protected eraseAllLayers = false;
  /** M14 (S-2): 塗りツールの形式（bucket=従来のバケツ / enclose=囲い塗り）。セッションのみ・既定はバケツ */
  protected fillMode: FillMode = "bucket";
  /** M14 (S-2): 囲い塗りのドラッグ軌跡（自由選択の lassoPts と同じ流儀・別枠で持つ） */
  protected enclosePts: { x: number; y: number }[] = [];
  /** M16 (D-1): トーンを「コマでずらす」か（既定=オフ・settings.json へ永続化）。オンで描くと
   *  コマ番号ぶんトーン参照座標が斜めにずれて焼かれる＝再生で点が揺れる。オフは従来と完全一致 */
  protected ditherFrameShift = false;
  colorHex: string = UGO_COLORS.black;
  /** M11-2: ツールごとの太さ（ペン/ブラシ/消しゴムが各自の値を覚える）。
   *  図形などはペンの値を流用する（＝独立サイズを持たせない・従来どおり）。
   *  永続化はしない（従来の penSize と同じくセッション内のみ） */
  protected sizeByTool: Record<"pen" | "brush" | "eraser", number> = {
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
    // M12-C: 太さが変わったら輪も描き直す。**ここが唯一の書き込み口**なので、
    // ピッカーのクリックもショートカットも同じように反映される。
    // ポインタが動かないと直らない（＝太さを変えても輪が古いまま）のを防ぐ
    this.repaintCursor(); // ★V213: 輪を描き直すのは画面（PC）
  }
  texture: PenTexture = "solid";
  /** M5-4: ブラシのトーンパターン（ペンの texture とは独立に記憶。既定=網点大） */
  brushToneId = "halftone-l";
  /** M5-5 T-3: バケツ塗りのトーン（ブラシとは独立に記憶。既定=ベタ） */
  fillToneId = "solid";
  /** M11-14: かすり消し（消しゴムのトーン）。ブラシ・バケツと同じく**独立に記憶**し、
   *  既定はベタ＝従来どおりの全消し。ブラシと共有すると、ブラシの既定（網点大）のせいで
   *  **消しゴムが最初からかすれてしまい**「ベタ時は従来どおり」が初期状態で成立しない */
  eraserToneId = "solid";
  /** M17: ペンの「種類」でマイ柄を選んでいるときの id（"custom:<n>"）。""＝従来どおり texture で描く */
  penToneId = "";
  /** M17: 登録済みのマイ柄（settings.customTones から復元・登録順）。履歴には積まない */
  protected customTones: CT.CustomTone[] = [];
  /** M17: 「🎨 登録した色で塗る」（既定オン・settings）。オフ＝非透明画素を形として現在色で塗る */
  protected customToneColor = true;
  /** M17: ストローク中に使う解決済みトーン（pointerdown で**バッファ取得より先に**一括解決し、
   *  move では再解決しない＝ストローク中に 16bit 昇格が起きてバッファ参照が死ぬのを防ぐ） */
  protected strokeTone: { kind: "pen" | "brush" | "eraser"; tone: R.ToneTile | null; colorTile: R.ColorTile | null } | null = null;
  onionLevel = 0;
  /** V164 (U-1): 透かす向き（前のコマだけ／両方／次のコマだけ）。**既定は "both"＝v1.6.0 と同じ絵**。
   *  段数（`onionLevel`）とは独立した軸で、どちらも settings に保存する（人の好みなので作品には入れない）。 */
  onionDir: OnionDir = "both";
  /** V164 (U-3): よく使う色の棚（`settings.favoriteColors` から復元・登録順・"#RRGGBB"）。
   *  **作品ではなく設定**＝作品をまたいで使える道具箱。履歴には積まない（マイ柄と同じ流儀） */
  protected favoriteColors: string[] = [];
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
  protected textDraft: {
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
  protected textDraftCache: {
    key: string;
    mask: { w: number; h: number; data: Uint8Array } | null;
    cv: CV | null;
    cvColor: string;
  } | null = null;
  /** 浮動テキストを掴んでいる位置（掴んだ点と左上の差） */
  protected textDrag: { ox: number; oy: number } | null = null;
  /** M11-15: レイヤー専用クリップボード（アクティブレイヤーの現在コマの索引バッファ1枚）。
   *  選択範囲のクリップボード（frameClip / edit.copy）とは**別枠**で互いに上書きしない。
   *  値は colorTable の添字なので**同じ作品の編集セッション内でのみ有効**＝`mount()` で必ず破棄
   *（別作品へ持ち出すと色化けする。破棄は `clearLayerClip()` 1箇所に集約）
   *  ★V199 (A-105): フォルダを選んでいるときは**フォルダの中の全部**を、レイヤーの id ごとに控える（`layerClip.ts`） */
  protected layerClip: LayerClip | null = null;
  /** V199 (A-105): Ctrl+V（edit.paste）が貼るほう＝**最後にコピーしたほう**（範囲のコピー／レイヤーのコピー）。
   *  範囲のコピー（`Editor.clipboard`）はアプリ全体・レイヤーの控えは作品ごとなので、決めるのは `pasteKind()` */
  protected lastCopy: "sel" | "layer" | null = null;

  // 再生
  playing = false;
  /** ★V209 (A-121): 再生の時計（経過時間からコマを決める・音の時計で BGM と SE を予約する）。再生中だけ持つ */
  playClock: PlayClock | null = null;
  /** V209: ▶ の世代。音の用意を待つ間に ⏸ や ▶ が押されたら、待っていた始め方は捨てる（動く再生は 1 つ・R-15） */
  private playGen = 0;
  /** V209: ⏸ した位置（描き終わっていた所）。▶ のときの速さ・コマ数・コマが同じときだけ、そこから続ける。
   *  何周目かを捨てる操作（コマを動かす・コマの追加や削除・⏸ でない止まり方・音の窓を開く）で捨てる */
  protected playPaused: PlayPaused | null = null;
  /** V209: 「曲の長さで書き出す」の形でループしない作品が曲の終わりで止まった（そのコマから動かさずに ▶ は頭から） */
  protected playEnded: { frame: number } | null = null;

  // ★V178 (A-72): 積む直前に全レイヤーの束を確定する（EditorHistory の説明）
  history = new EditorHistory(() => {
    if (this.eraseAllStroke) this.finishEraseAllNow();
  });
  /** ライブラリ未保存の変更があるか。true をセットするとオートセーブ対象にもなる */
  protected _dirty = false;
  protected autosavePending = false;
  /** V154b (W-7/W-8/W-9): いま走っている重い処理（""＝走っていない）。
   *
   *  **これ1つで3つを同時に satisfies する**:
   *   - W-7: 入口を閉じる（飛行中の呼び出しは**黙って捨てる**。キューに積まない）
   *   - W-8: 進捗を出す（少し遅らせて出す＝一瞬で終わる保存ではチラつかない）
   *   - W-9: 編集を受け付けない（`dialogOpen()` に混ぜてキーを止め、
   *     `#screen-editor.ed-busy` でポインタを止める）
   *
   *  オートセーブの `autosaveInFlight` と同じ流儀（あちらは自分の周期を見送るだけなので別枠）。 */
  /** V154b: 重い処理が走っているか（空＝走っていない）。V166: 漏斗（`runHeavy`）が使う "heavy" を追加。
   *  ★**"save" を型から消した**（独立レビューの指摘・低）。保存は入口を閉じない（V161-A・壊すなリスト）——
   *   コメントで方針を書くだけでは、いつか誰かが保存の種別を足して書けてしまう。
   *   型から消せば**書いた瞬間にコンパイルが落ちる**＝方針が機械で守られる */
  protected busyKind: "" | "audio" | "export" | "heavy" = "";
  /** dirty 漏斗を通った回数。スナップショット時点と比べて「保存中に編集があったか」を
   *  判定する（あれば dirty を残す＝「保存しました」がすべてを含むとは限らない）。 */
  protected editEpoch = 0;

  get dirty(): boolean {
    return this._dirty;
  }
  set dirty(v: boolean) {
    this._dirty = v;
    if (v) this.autosavePending = true;
    // V161 (A): 「何か変わった」の回数。背景保存が、スナップショットのあとに
    // 編集があったか（＝dirty を落としてよいか）をこの数字で判定する。
    // 経路の数え上げではなく**この漏斗1か所**（§1-g・V156 と同じ作法）
    if (v) this.editEpoch++;
    // ★V214 (§5-1 の 1): 編集の印のフック。**dirty = true のたび**（すでに立っていても）呼ぶ。PC は上書きしない（モバイルだけ）。
    //  ⚠ setter を通らない `_dirty` への代入（やめる口が押す前の印へ戻す所・PC の mount の始め）では呼ばれない
    if (v) this.workEdited();
    // ★V156 (P-1・条件5): 何かが変わった＝**いま見ているコマの圧縮控えは古い**。捨てる。
    //
    //  条件5「書きで起こしたコマの控えは必ず捨てる」を、**書いた経路を数え上げずに**満たすための要。
    //  `dirty` はこのアプリの「何か変わった」の合図で、代入は 41 箇所あるが**すべてこの1か所を通る**
    //  （`pointerDown` と同じ、既にあるこのファイルの作法）。絵を変えない変更（題名・速度・音）でも
    //  控えを捨てるが、いま見ているコマは窓の中で当分眠らないので、無駄はほぼゼロ。
    //
    //  窓の**外**を書き換える操作（全コマ一括）はこれでは足りないので、そちらは
    //  `wakeAllForWrite()` で明示的に起こす。さらに漏れても `sleep.ts` の指紋の網が拾う。
    if (v && this.sleepOn) {
      const f = this.project.frames[this.frameIndex];
      if (f) invalidateFrame(f);
    }
  }

  // ---------------- V157 (D-1): レイヤーロック 🔒 ----------------
  /** 絵のデータを**自分で**書き換える道具（＝ロック中は入口で弾く）。
   *
   *  `transform` と `move` は入っていない——あちらは対象を `moveTargetLayerIds()` で解決し、
   *  そこで実効ロックを除外済み（🔒を1枚混ぜて掴んでも、その1枚だけ動かない）。
   *  ここで弾くと「ロックしていない他のレイヤーまで動かせない」になってしまう。 */
  protected static readonly PIXEL_TOOLS = new Set<Tool>([
    "pen",
    "eraser",
    "brush",
    "fill",
    "shape",
    "text",
    "warp",
  ]);
  /** 最後にロックのトーストを出した時刻（連打で溢れさせないための間引き） */
  private lastLockToastAt = 0;
  /** V157: ロックの知らせ。**動的キーは `*Key` のプロパティで持つ**
   *  （`SIZE_ADVICE` と同じ作法。`t(cond ? "a" : "b")` と書くと `m1201_i18n_check` の
   *   使用検査が**沈黙して未使用キー扱い**になる——実際にこの回で1度踏んだ） */
  private static readonly LOCK_TOAST = {
    self: { msgKey: "ed.layer.locked.toast" },
    byFolder: { msgKey: "ed.layer.lockedByFolder.toast" },
  } as const;
  /** V157 (D-2): レイヤーカラーの適用先ボタン。上と同じ理由で `*Key` に置く */
  private static readonly COLOR_SCOPE = {
    applyOne: { msgKey: "ed.layer.color.applyOne.btn" },
    applyFrames: { msgKey: "ed.layer.color.applyFrames.btn" },
    clearOne: { msgKey: "ed.layer.color.clearOne.btn" },
    clearFrames: { msgKey: "ed.layer.color.clearFrames.btn" },
  } as const;

  /** V157 (D-1): 実効ロック（自分の 🔒 OR 祖先フォルダの 🔒）。 */
  private isLayerLocked(id: string): boolean {
    return effectiveLayerStates(this.project).get(id)?.locked === true;
  }

  /** V157 (D-1): これから絵を変える操作の入口で呼ぶ。
   *  ロック中なら**トーストを出して** true を返す（＝呼び出し側は何もせず戻る）。
   *
   *  作者決定「黙って弾かない」。ただし描こうとするたびに出すと**うるさい**ので、
   *  1.5 秒に1回までに間引く（ペンを何度も当てる／線を引き続ける場面で溢れない）。 */
  protected lockGuard(id = this.activeLayerId): boolean {
    if (!this.isLayerLocked(id)) return false;
    const now = performance.now();
    // V157（独立レビュー §4）: 間引きは**トーストが消えるまで**（3.2秒）。
    // 1.5 秒だと、消える前に次が積み上がって同じ知らせが重なって見える
    if (now - this.lastLockToastAt >= 3400) {
      this.lastLockToastAt = now;
      // V157（独立レビュー §3・優先度 中）: **どちらの🔒で止まっているかを言う。**
      // 親フォルダのロックなのに「このレイヤーはロック中です」と言われると、
      // 子の🔒は薄くて押せない＝「外せないのに描けない」と迷子になる
      const ld = this.project.layerDefs.find((l) => l.id === id);
      const byParent = !!ld && ld.locked !== true && ancestorLocked(this.project, ld.parent);
      this.cb.toast(t(EditorCore.LOCK_TOAST[byParent ? "byFolder" : "self"].msgKey));
    }
    return true;
  }

  /** V157 (D-1): レイヤーの 🔒 を切り替える（履歴に積む）。
   *  親フォルダが🔒のときは切り替えさせない——切り替えられると
   *  「解除したのに描けない」が起きる（要件の継承ルール）。 */
  protected toggleLayerLock(id: string) {
    if (this.xformGuard()) return;
    const ld = this.project.layerDefs.find((l) => l.id === id);
    if (!ld) return;
    if (ancestorLocked(this.project, ld.parent)) {
      this.cb.toast(t("ed.layer.lockedByFolder.toast"));
      return;
    }
    const before = ld.locked === true;
    const self = this;
    const set = (v: boolean) => {
      const l = self.project.layerDefs.find((x) => x.id === id);
      if (!l) return;
      if (v) l.locked = true;
      else delete l.locked;
      self.dirty = true;
      self.rebuildLayers();
    };
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: before ? "ロック解除" : "ロック",
      bytes: 64, // クロージャが持つのは id と真偽値だけ（画素は1バイトも抱えない）
      undo: () => set(before),
      redo: () => set(!before),
    });
    const _t0 = perfNow();
    set(!before);
    perfDone("layer.lock", _t0);
  }

  /** V157 (D-1): フォルダの 🔒 を切り替える（中身すべてが実効ロックになる）。 */
  protected toggleFolderLock(fid: string) {
    if (this.xformGuard()) return;
    const f = this.folderById(fid);
    if (!f) return;
    if (ancestorLocked(this.project, f.parent)) {
      this.cb.toast(t("ed.layer.lockedByFolder.toast"));
      return;
    }
    const before = f.locked === true;
    const self = this;
    const set = (v: boolean) => {
      const cur = self.folderById(fid);
      if (!cur) return;
      if (v) cur.locked = true;
      else delete cur.locked;
      self.dirty = true;
      self.rebuildLayers();
    };
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: before ? "フォルダのロック解除" : "フォルダのロック",
      bytes: 64,
      undo: () => set(before),
      redo: () => set(!before),
    });
    set(!before);
  }

  // ---------------- V178 (A-72): 全レイヤー消しゴム ----------------
  /** V178: いま「全レイヤー」で消すか（道具が消しゴムで、切り替えがオン） */
  protected eraseAllOn(): boolean {
    return this.tool === "eraser" && this.eraseAllLayers;
  }

  /** V178: 知らせと説明の文言。**動的キーは `*Key` で持つ**（`LOCK_TOAST` と同じ作法・検査が沈黙しないように） */
  protected static readonly ERASE_ALL_TEXT = {
    none: { msgKey: "ed.eraser.allLayers.none.toast" },
    wait: { msgKey: "ed.eraser.allLayers.wait.toast" },
    hint: { msgKey: "ed.eraser.allLayers.hint" },
  } as const;

  /** V178: 「全レイヤー」を切り替える。**覚えない**（設定に書く口を呼ばない）。
   *  カーソルの二重線を描き直し、オンにしたとき窓がまだ眠っていれば起こしておく（§3-5）。
   *  起こす入口は `renderCanvas` の 1 つだけ——同じコマを 2 か所から同時に起こすと、後から起きたほうが
   *  `f.layers[id]` を差し替え、その間に描いた線が消える */
  protected setEraseAllLayers(on: boolean) {
    this.eraseAllLayers = on;
    this.repaintCursor(); // ★V213: 輪を描き直すのは画面（PC）
    if (on && this.sleepOn && !this.frameReady()) this.renderCanvas();
  }

  /** V178: 全レイヤー消しゴムの関所。**描けないとき true**（呼び出し側は何もせず戻る＝`lockGuard` と同じ形）。
   *  いまのレイヤーの 🔒 では止めない——🔒 のレイヤーは対象から外れるだけ（移動・変形と同じ線引き）。
   *   ① 対象のうち、まだ眠っているものがある → 描かない（半分だけ消えた状態を作らない・§3-5）
   *   ② 対象が 0 枚（全部 🔒／全部非表示）→ 描かない
   *  どちらもトーストで知らせる（`lockGuard` と同じ 3.4 秒の間引き） */
  protected eraseAllGuard(): boolean {
    const { ids, asleep } = eraseAllTargets(this.project, this.frameIndex);
    if (asleep.length > 0) {
      this.eraseAllToast("wait");
      // 窓（表示中＋前後3）を起こすのは renderCanvas の入口だけ。起きたら次のストロークから効く
      if (this.sleepOn && !this.frameReady()) this.renderCanvas();
      return true;
    }
    if (ids.length === 0) {
      this.eraseAllToast("none");
      return true;
    }
    return false;
  }

  private eraseAllToast(kind: "none" | "wait") {
    const now = performance.now();
    if (now - this.lastEraseAllToastAt < 3400) return;
    this.lastEraseAllToastAt = now;
    this.cb.toast(t(EditorCore.ERASE_ALL_TEXT[kind].msgKey));
  }

  /** V178: 全レイヤーのストロークを始める。対象ごとに写しと位相を用意し、📌 が入っていれば
   *  **その作品で最初の 1 回だけ**知らせる（決-1: 確認ダイアログは出さない＝描き味を止めない）。
   *  関所（`eraseAllGuard`）を通ったあとに呼ぶ。対象が 0 枚でも束は返す＝1 枚の経路へは落とさない */
  protected beginEraseAll(): EraseAllStroke | null {
    const frame = this.project.frames[this.frameIndex];
    if (!frame) return null;
    const { ids } = eraseAllTargets(this.project, this.frameIndex);
    const pinnedIds = this.sharedLayerIds();
    const st: EraseAllStroke = { project: this.project, frame, ids, before: {}, dash: {}, shared: new Set() };
    for (const id of ids) {
      st.before[id] = copyIndexBuf(frame.layers[id]);
      st.dash[id] = { d: 0 };
      if (pinnedIds.has(id)) st.shared.add(id);
    }
    if (st.shared.size > 0 && !this.eraseAllPinNoticed.has(this.project)) {
      this.eraseAllPinNoticed.add(this.project);
      this.cb.toast(t("ed.eraser.allLayers.pinned.toast"));
    }
    this.eraseAllStroke = st;
    return st;
  }

  /** V178: 押した瞬間の打点を、対象のレイヤーぜんぶに打つ（座標は整数の pt＝A-70 の約束どおり）。
   *  `stamp` は位相を使わない（点線の間引きは `strokeSegment` の側）ので、ここでは dashAcc を替えない */
  protected eraseAllStamp(st: EraseAllStroke, x: number, y: number, o: R.PenOptions) {
    for (const id of st.ids) {
      const buf = st.frame.layers[id];
      if (!buf) continue;
      R.stamp(buf, x, y, o);
    }
  }

  /** V178: 線分を、対象のレイヤーぜんぶに引く。座標（lastPt / smoothPt）は全レイヤー共通の 1 組。
   *  ★位相（dashAcc）だけは**レイヤーごと**に差し替える（同じ o を枚数ぶん回すと位相が枚数ぶん進む）。
   *  `seed` と `toneShift` はコマ単位なので共有してよい */
  protected eraseAllSegment(
    st: EraseAllStroke,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    o: R.PenOptions
  ) {
    for (const id of st.ids) {
      const buf = st.frame.layers[id];
      if (!buf) continue;
      o.dashAcc = st.dash[id];
      R.strokeSegment(buf, x0, y0, x1, y1, o);
    }
  }

  // ---------------- V191 (A-89): 1px の線（描く前に決める） ----------------
  /** ★V191: 太さ 1 の線分を 1px の道（`line1px.ts`）で打つ。いちばん新しい画素は「仮」にして、まだ描かない。
   *  状態が無ければ（押した瞬間が太さ 1 でなかった／筆圧で太い線分を挟んだ）、線分の始点＝もう描いてある画素から始め直す。
   *  `all` があれば、確定した画素を対象のレイヤーぜんぶに打つ */
  protected line1pxSegment(x0: number, y0: number, x1: number, y1: number, o: R.PenOptions, buf: IndexBuf | null, all: EraseAllStroke | null): void {
    if (!this.line1px) this.line1px = { st: L1.line1pxBegin(Math.round(x0), Math.round(y0)), all };
    L1.line1pxSegment(this.line1px.st, x0, y0, x1, y1, o, (x, y, s, po) => this.line1pxPlot(x, y, s, po, buf, all));
  }

  /** ★V191: 確定した 1 画素を打つ。1 枚なら `plot1px`、全レイヤーなら対象ぜんぶに（`eraseAllSegment` と同じく、
   *  点線の位相 dashAcc だけはレイヤーごとに差し替える）。打つかどうかの判定は `stamp` のまま */
  private line1pxPlot(x: number, y: number, s: number, o: R.PenOptions, buf: IndexBuf | null, all: EraseAllStroke | null): void {
    if (all) {
      for (const id of all.ids) {
        const b = all.frame.layers[id];
        if (!b) continue;
        o.dashAcc = all.dash[id];
        L1.plot1px(b, x, y, s, o);
      }
    } else if (buf) L1.plot1px(buf, x, y, s, o);
  }

  /** ★V191 (A-89): **描き終わりの漏斗。** 1px の線の「仮」の画素（ペン先の 1 画素）を打って、状態を空にする。
   *
   *  なぞりが終わる道は全部ここを通す: pointerup（`onPointerUp`・**いまの道具に関係なく・束の確定と履歴より前**）／
   *  全レイヤーの束を途中で確定するとき（`finishEraseAllNow`・`commitEraseAll` より前）／pointerup が来ないまま畳んだとき
   *  （`endPointerSession` は `onPointerUp` を呼ぶので同じ道。⚠ ただし重い処理の最中は onPointerUp が漏斗より前で抜けるので、
   *  そのなぞりの 1 枚の経路の仮は `dropStaleLine1px` が打たずに捨てる＝そのなぞりは履歴も積まれていない）／
   *  筆圧で太い線分に替わるとき（`onPointerMove`）／次に押した時点の網（`onPointerDownInner`・束の網より前）。
   *  漏れると**線の最後の 1 画素が消える**・取り消しの束に入らない（v191_smoke [S-4]・[S-11]）。
   *  仮は、その画素を作ったときの打ち方で打つ（途中で道具が替わっても前の色で打つ＝束をペンの色で塗らない）。
   *  全レイヤーの束がもう確定していたら打たない（履歴の外へ書かない） */
  protected endLine1px(): void {
    const cur = this.line1px;
    if (!cur) return;
    const shown = this.line1pxShown(true); // ★V209 (A-122): 見せていた仮の 1 ドット（捨てる道で画面に残さない）
    this.line1px = null;
    const all = cur.all;
    if (all && all !== this.eraseAllStroke) {
      if (shown && this.mounted) this.renderCanvas(); // 打たずに捨てる道（束がもう確定していた）: 見せていた 1 ドットを消す
      return;
    }
    const buf = all ? null : this.activeBuffer();
    if (L1.line1pxEnd(cur.st, (x, y, s, o) => this.line1pxPlot(x, y, s, o, buf, all))) this.renderCanvas();
  }

  /** ★V191 (A-89・レビュー指摘): pointerup を最後まで通らずに終わったなぞりの、**1 枚の経路の**仮の 1 画素を打たずに捨てる。
   *  そのなぞりは履歴も積まれていないので、あとで打つと「そのとき選んでいるコマ・レイヤー（🔒 でも）」へ履歴の外に書いてしまう。
   *  呼ぶのは endPointerSession（onPointerUp のあと）と pointerdown の網だけ。束の分は触らない（endLine1px の守りが見る） */
  protected dropStaleLine1px(): void {
    if (this.line1px && !this.line1px.all) {
      const shown = this.line1pxShown(true); // ★V209 (A-122): 見せていた仮の 1 ドットを画面に残さない（珍しい道なので合成が 1 回増えてよい）
      this.line1px = null;
      if (shown && this.mounted) this.renderCanvas();
    }
  }

  /** ★V209 (A-122・REQ_cursor_frame §2 (3)): 描いている途中の仮の 1 ドット（ペン先）を、いま絵に見せるか。
   *  条件は描き終わりに打つとき（`line1pxEnd`）と同じ＋押している間だけ・全レイヤーの束はまだ確定していないときだけ。
   *  discard: 捨てる道で「前に見せていたかもしれないか」を聞くとき（離したあと・束がもう確定したあとに呼ばれるので、
   *  押しているかも、束がまだ確定していないかも見ない＝独立レビューの指摘: 古い束を捨てる道で描き直されなかった） */
  private line1pxShown(discard = false): boolean {
    const cur = this.line1px;
    if (!cur || (!discard && !this.pointerDown)) return false;
    const st = cur.st;
    if (!st.hasB || !st.bo || (st.bx === st.ax && st.by === st.ay)) return false;
    return discard || !cur.all || cur.all === this.eraseAllStroke;
  }

  /** ★V209 (A-122): 仮の 1 ドットを**合成のときだけ**打つ（見せるだけ）。戻す手を返す（打たなければ null）。
   *
   *  打ち方は描き終わり（`line1pxEnd` → `line1pxPlot` → `plot1px`）と同じ＝トーンやマイ柄で抜けるドット・選択範囲の外は打たない・
   *  消しゴムは消したあと（下のレイヤー・紙・透明の紙の市松）が見える。点線は `plot1px` と同じ判定を、**位相の写し**（{ d: 今の値 }・
   *  全レイヤーはレイヤーごとの写し）に対して行う＝本物の位相（this.dashAcc・all.dash[id]）を進めない。st.bo も書き換えない
   *  （st.bo.dashAcc は本物の位相を指している）。控えは 1 ドット×対象のレイヤーの数で、合成のあと必ず元の値に戻す
   *  （IndexBuf・取り消しの記録・保存・書き出し・点線の位相は今と同じ＝描き終わったときのバイト列が今と同じ） */
  protected peekLine1px(): (() => void) | null {
    if (!this.line1pxShown()) return null;
    const cur = this.line1px!;
    const st = cur.st;
    const x = st.bx;
    const y = st.by;
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const s = Math.hypot(st.bx - st.ax, st.by - st.ay);
    const bo = st.bo!;
    const i = y * W + x;
    const saved: { buf: IndexBuf; v: number }[] = [];
    const plot = (buf: IndexBuf, dash: { d: number } | undefined) => {
      saved.push({ buf, v: buf[i] });
      L1.plot1px(buf, x, y, s, { ...bo, dashAcc: dash ? { d: dash.d } : undefined });
    };
    try {
      const all = cur.all;
      if (all) {
        for (const id of all.ids) {
          const b = all.frame.layers[id];
          if (b) plot(b, all.dash[id]);
        }
      } else {
        const buf = this.activeBuffer();
        if (buf) plot(buf, bo.dashAcc);
      }
    } catch (e) {
      for (let k = saved.length - 1; k >= 0; k--) saved[k].buf[i] = saved[k].v;
      throw e;
    }
    if (saved.length === 0) return null;
    return () => {
      for (let k = saved.length - 1; k >= 0; k--) saved[k].buf[i] = saved[k].v;
    };
  }

  /** ★V178 (A-72・独立レビューの指摘 2〜3 回目・高): 全レイヤーの束を、**作品に別の変更が入る前に**確定して終える。
   *
   *  描いている最中でもキーやもう 1 本のポインタは効く（`onKeyDown` に `pointerDown` の関所は無い）。コマの削除・
   *  取り消し・コマ移動・重い処理が束より**先に**走ると、その履歴が「消したあと」の絵を抱えてしまい、
   *  **Ctrl+Z しても元の絵に戻らない**（独立レビュー 実測: コマ削除 → Ctrl+Z で 93 画素が消えたまま）。
   *  だから入口——キー（`onKeyDown`・ダイアログ／文字入力欄／IME の関所のあと）・コマンド（`runCommand`）・重い処理（`beginBusy`）・↶↷（`handleUndo` /
   *  `handleRedo`）・UI を押した時点（`uiPointerHandler`）——で先にここを通し、入口を通らない経路は
   *  **ほかの履歴を積む直前**（`EditorHistory`）で拾う（最後の網）。
   *  押している最中なら、そのストロークはここで終わる（残りのなぞりは次に押すまで描かない＝座標は触らない） */
  protected finishEraseAllNow(): void {
    if (!this.eraseAllStroke) return;
    // 1px の線の仮の 1 画素を、束に入れてから確定する（v191_smoke [S-4] (f)・[S-11]）
    this.endLine1px(); // ★V191 (A-89): 描き終わりの漏斗（束の確定）
    this.commitEraseAll();
    if (this.pointerDown) {
      // pointerup と同じ後始末（押していない・終端の控えなし・解決済みトーンなし・捕捉なし）
      this.pointerDown = false;
      this.strokeTone = null;
      this.pointerReleased(); // ★V213: 終端の控えを捨てて捕捉を放す（画面・PC）
    }
  }

  /** V178: 全レイヤーのストロークを確定する。**歪みの確定と同じ形**——1 画素でも変わったレイヤーだけ
   *  before/after を積み、`multiBufferChangeEntry` を **1 つだけ** push する（ひとなぞり＝ Ctrl+Z 1 回）。
   *
   *  ★歪みの形から 2 つだけ変えた（どちらも、歪みの形のままだと壊れると V178 の調べで実測した所）:
   *   ① 戻し先は **Frame オブジェクト**で引く。歪みは「Ctrl+Z を押した時点で表示中のコマ」で引くので、
   *      コマを移ってから Ctrl+Z すると**別のコマへ書き戻す**（`pushBufferHistory`・変形・「消す」と同じ持ち方）
   *   ② 取り消し・やり直しの前に、そのコマを**書きで起こす**（`prepare`）。大きい作品で窓の外へ出て眠った
   *      コマは `frame.layers[id]` が無く、起こさないと Ctrl+Z が**黙って空振り**する */
  protected commitEraseAll() {
    const st = this.eraseAllStroke;
    this.eraseAllStroke = null;
    if (!st) return;
    // 作品が替わっていたら積まない（別の作品の履歴を汚さない）。★なぞったコマが作品から外れていても、
    // 同じ作品なら積む——外したのは**いま積まれようとしている操作**（コマの削除など・EditorHistory の網）で、
    // 束が先に積まれれば、その操作の取り消しでコマが戻ったあと、束の取り消しで元の絵に戻る
    if (st.project !== this.project) return;
    const frame = st.frame;
    const beforeDiff: Record<string, IndexBuf> = {};
    const afterDiff: Record<string, IndexBuf> = {};
    let pinned = false;
    for (const id of st.ids) {
      const b = st.before[id];
      const a = frame.layers[id];
      if (!b || !a) continue;
      let differs = false;
      for (let i = 0; i < b.length; i++) {
        if (b[i] !== a[i]) {
          differs = true;
          break;
        }
      }
      if (!differs) continue; // 1 画素も変わっていないレイヤーは積まない（メモリ・§3-3）
      beforeDiff[id] = b;
      afterDiff[id] = copyIndexBuf(a);
      if (st.shared.has(id)) pinned = true;
    }
    if (Object.keys(afterDiff).length === 0) return; // 1 枚も変わっていなければ履歴を積まない
    const self = this;
    // 📌 は全コマの絵が変わる＝フィルムを全部塗り直す（§3-4b・全コマが変わったことに気づける唯一の目印）。
    // 塗り直しは rebuildFilm（見えている分だけ遅延で描く＝F-0 の流儀・全コマ貼り付けと同じ）
    const repaint = () => {
      if (pinned) self.rebuildFilm();
      else {
        const fi = self.project.frames.indexOf(frame);
        if (fi >= 0) self.paintFilmThumb(fi);
      }
    };
    const onApply = () => {
      // Undo/Redo もデータ変更なので dirty（＝オートセーブ対象）にする
      self.dirty = true;
      self.renderCanvas();
      repaint();
    };
    const entry = multiBufferChangeEntry(
      "消しゴム（全レイヤー）",
      (id) => frame.layers[id] ?? null,
      beforeDiff,
      afterDiff,
      onApply
    );
    entry.prepare = () => wakeFrame(self.project, frame, "write");
    this.history.push(entry);
    // 書いたコマの圧縮控えは古い。dirty の漏斗は「表示中のコマ」だけを見るので、ここは名指しで捨てる
    if (this.sleepOn) invalidateFrame(frame);
    this.dirty = true;
    this.renderCanvas();
    repaint();
  }

  // ---------------- V156 (P-1): 眠り ----------------
  /** 眠りを効かせるしきい値。**これ未満の作品はいままでと完全に同じ経路**を通る
   *  （スパイク実測: 50コマ×3レイヤーで減らせるのは 11 MiB しかなく、遅くなる理由だけが残る）。 */
  protected static readonly SLEEP_MIN_BYTES = 32 * 1024 * 1024;
  /** 窓の半径。オニオンは UI が 切/1/2/3 の4択で最大3（`compositeFrame` が frameIndex±k を読む）。
   *  **常に ±3 を起こしておく**——オニオンを 0→3 に切り替えた瞬間に6コマ起こすと引っかかるので、
   *  段数に追従させない。20レイヤーでも 7コマ＝10.3 MiB で、効き目にはまったく影響しない。 */
  private static readonly SLEEP_WINDOW = 3;
  /** この作品で眠りを効かせるか（mount のときに大きさで決める） */
  protected sleepOn = false;
  /** 裏で眠らせる作業が走っているか */
  protected sweeping = false;
  /** V168 (S-2): いま走っている掃除の1周（`sweepSleep` の Promise）。保存の待ちが**同じ周を待つ**ために持つ */
  private sweepJob: Promise<void> | null = null;
  /** ★V216b (A-128・要件 §2-4): 片づけを止めている数（重い操作 `runHeavy` と元に戻す／やり直し `applyHistory` の間）。
   *  0 でない間は周を始めず（`sweepSleep`・`nudgeSweep`）、走っている周も次のコマへ進まずに抜ける。再生中の只の片付け（`evictBehind`）も止める */
  private sweepHold = 0;
  /** V216b (A-128): 止めている間に片づけを頼まれたか（nudgeSweep） */
  private sweepWanted = false;
  /** V168 (S-2): 掃除が進んだときに呼ぶ口（保存の待ちがピルの数字を更新する）。メーターと同じ間引き点で呼ぶ */
  private sweepProgressCb: (() => void) | null = null;
  /** 次に見にいくコマ（掃除の巡回位置） */
  protected sweepCursor = 0;
  /** 掃除中にメーターを更新した時刻（走査が重いので 0.5 秒に1回まで） */
  private lastSweepMeterAt = 0;

  /** V156: 📌 全コマ共通レイヤーの id（眠らせない＝全コマで見えていて実体は1つ） */
  protected sharedLayerIds(): Set<string> {
    const s = new Set<string>();
    for (const ld of this.project.layerDefs) if (ld.shared === true) s.add(ld.id);
    return s;
  }

  /** V156: そのコマは窓の中か（表示中＋オニオンが読む前後） */
  protected inSleepWindow(i: number): boolean {
    return Math.abs(i - this.frameIndex) <= EditorCore.SLEEP_WINDOW;
  }

  /** V156: 描くのに要るコマ（表示中＋前後3）が全部起きているか。 */
  protected frameReady(): boolean {
    if (!this.sleepOn) return true;
    const lo = Math.max(0, this.frameIndex - EditorCore.SLEEP_WINDOW);
    const hi = Math.min(this.project.frames.length - 1, this.frameIndex + EditorCore.SLEEP_WINDOW);
    for (let i = lo; i <= hi; i++) {
      const f = this.project.frames[i];
      if (!f?.sleep) continue;
      for (const id of Object.keys(f.sleep)) if (!f.layers[id]) return false;
    }
    return true;
  }

  /** V156: 窓（表示中＋前後3）を起こす。**書きで起こす**——ここは利用者が描く場所なので、
   *  控えを残すと「描いた絵が次に眠るとき古い控えで上書きされる」（条件5）。 */
  protected async ensureSleepWindow(): Promise<void> {
    if (!this.sleepOn) return;
    // 再生中は**読みで**起こす（条件2）。控えを残しておけば、窓から出るときの片付けが只になり、
    // 1周の再生で 25 秒ぶんの再圧縮が走るのを防げる。再生中はキャンバスに触れると
    // 再生が止まる（`stopPlayback`）ので、読みで起こしたコマに描かれることはない。
    // 止まったあとに描けば `dirty` のセッターが控えを捨てる（条件5）。
    const mode = this.playing ? "read" : "write";
    const lo = Math.max(0, this.frameIndex - EditorCore.SLEEP_WINDOW);
    const hi = Math.min(this.project.frames.length - 1, this.frameIndex + EditorCore.SLEEP_WINDOW);
    const jobs: Promise<void>[] = [];
    for (let i = lo; i <= hi; i++) {
      const f = this.project.frames[i];
      if (f) jobs.push(wakeFrame(this.project, f, mode));
    }
    await Promise.all(jobs);
  }

  /** V156: 窓の外を少しずつ眠らせる（条件1: 先に全部圧縮しない）。
   *
   *  スパイク実測で 1,091 コマの圧縮は **25.6 秒**。読み込みと直列にすると
   *  V155 で 11 秒にした「開く速さ」が 36 秒に戻ってしまう。だから**開いたあと**、
   *  1コマずつ・合間にメインスレッドを譲りながら片付ける。
   *  描いている間・再生中は**触らない**（体感に漏らさない）。 */
  private sweepSleep(): Promise<void> {
    if (this.sweeping || !this.sleepOn || this.sweepHold > 0) return Promise.resolve();
    // V168 (S-2): 1周の Promise を `sweepJob` に持つ。保存の待ちは**走っている周を待ち**、
    // 終わったら条件を見直して次の周を頼む（多重起動はしない＝`sweeping` は従来どおり）
    const job = this.sweepSleepPass().finally(() => {
      if (this.sweepJob === job) this.sweepJob = null;
    });
    this.sweepJob = job;
    return job;
  }

  /** V168: 掃除の**1周**。`sweepSleep` から呼ぶ（外からは呼ばない）。 */
  private async sweepSleepPass(): Promise<void> {
    this.sweeping = true;
    const keep = this.sharedLayerIds();
    try {
      let scanned = 0;
      const total = this.project.frames.length;
      // V216b (A-128): 止める印が立ったら次のコマへ進まない（今のコマの圧縮が終わったところで抜ける＝止める側がこの周を待つ）
      while (this.mounted && this.sleepOn && this.sweepHold === 0 && scanned < total) {
        // 描いている間・再生中・変形中は「**只で片付くもの**」しか触らない。
        // 圧縮は 1コマ 20 レイヤーで数十 ms かかるので、ここで走らせると描き味に出る。
        // 逆に「控えが生きている生を手放すだけ」は費用ゼロなので、再生中でも進めてよい
        //（進めないと、1周の再生で全コマが生に戻ってしまう）。
        const freeOnly = this.pointerDown || this.playing || this.xformActive;
        const i = this.sweepCursor % Math.max(1, this.project.frames.length);
        this.sweepCursor = i + 1;
        scanned++;
        const f = this.project.frames[i];
        if (!f || this.inSleepWindow(i)) continue;
        if (Object.keys(f.layers).length === 0) continue; // もう眠っている
        if ((await sleepFrame(this.project, f, keep, freeOnly)) > 0 && !freeOnly) {
          // 1コマ圧縮したらメインスレッドを譲る（描き味に出さない）
          await new Promise((r) => setTimeout(r, 0));
          // V156（独立レビュー）: **メーターの「実際に使っている量」を追従させる。**
          // 片付けは 27 秒かけて進むのに、メーターは再描画や履歴の動きがあるまで
          // 更新されない＝**画面が古い数字を出したまま**になっていた。
          // 数える処理は全コマを走査するので、0.5 秒に1回までに絞る
          //（この行が動くこと自体が「いま片付けている」の合図にもなる）
          const now = performance.now();
          if (now - this.lastSweepMeterAt > 500) {
            this.lastSweepMeterAt = now;
            this.updateSizeMeter();
            this.sweepProgressCb?.(); // V168 (S-2): 保存の待ちがピルの「片づけ中 n/N」を進める
          }
        }
      }
    } finally {
      this.sweeping = false;
      // 終わったところで必ず1回そろえる（途中の間引きで最後の数字が古いまま残らないように）
      if (this.mounted) this.updateSizeMeter();
    }
  }

  /** V156: 窓の後ろに出ていったコマを只で片付ける（再生中の1コマぶん）。 */
  private async evictBehind(center: number): Promise<void> {
    if (!this.sleepOn || this.sweepHold > 0) return; // V216b (A-128): 止めている間は読みで起こした面を眠らせ直さない
    const i = center - EditorCore.SLEEP_WINDOW - 1;
    const f = this.project.frames[i];
    if (!f) return;
    await sleepFrame(this.project, f, this.sharedLayerIds(), true /* 只で片付くものだけ */);
  }

  /** V156: 掃除をうながす（コマ移動・編集・時間経過のたびに軽く呼ぶ）。 */
  protected nudgeSweep(): void {
    if (this.sweepHold > 0) {
      // V216b (A-128): 止めている間に頼まれた片づけは、止める印が全部外れたところで 1 回だけ（releaseSweep）
      this.sweepWanted = true;
      return;
    }
    if (!this.sleepOn || this.sweeping) return;
    void this.sweepSleep();
  }

  /** ★V216b (A-128): 片づけを止めて、走っている周（`sweepJob`）が終わるのを待つ。**必ず `releaseSweep` と対で**（finally で）。
   *  周が走っていなければ null を返す＝呼び出し側は待たない（小さい作品・眠りの無い作品は 1 拍も増えない）。印は呼んだその場で立つ */
  protected holdSweep(): Promise<void> | null {
    this.sweepHold++;
    const job = this.sweepJob;
    return job ? job.catch(() => {}) : null;
  }

  /** ★V216b (A-128): 片づけを止めているか。入口の外で「読みで起こした面を只で眠らせ直す」所（フィルムのサムネ・再生の窓の外）が、
   *  止めている間（重い操作が読みで起こした面を使っている間）は眠らせ直さないために見る */
  protected sweepHeld(): boolean {
    return this.sweepHold > 0;
  }

  /** V216b (A-128): 止める印を 1 つ外す。全部外れたら、止めている間に頼まれた片づけがあればここで 1 回うながす
   *  （頼まれていなければ何もしない＝止める前と同じ時に片づけが進む） */
  protected releaseSweep(): void {
    if (this.sweepHold > 0) this.sweepHold--;
    if (this.sweepHold === 0 && this.sweepWanted) {
      this.sweepWanted = false;
      this.nudgeSweep();
    }
  }

  // ストローク中
  protected strokeBefore: IndexBuf | null = null;
  protected strokeSeed = 1;
  protected dashAcc = { d: 0 };
  /** ★V178 (A-72): 進行中の全レイヤーのストローク（pointerdown で作り、pointerup で確定して捨てる）。
   *  null なら 1 枚の経路（従来どおり） */
  protected eraseAllStroke: EraseAllStroke | null = null;
  /** ★V191 (A-89): 1px の線の「1 画素遅らせて決める」状態。太さ 1 の線分を打っている間だけ持つ（null＝打っていない）。
   *  `all` は全レイヤーの束に打っているときの束（座標は全レイヤー共通の 1 組＝状態もなぞりに 1 つ）。
   *  なぞりが終わる道は全部 `endLine1px`（描き終わりの漏斗）を通り、そこで仮の画素を打って捨てる */
  protected line1px: { st: L1.Line1px; all: EraseAllStroke | null } | null = null;
  /** V178 (決-1): 「📌 は全コマから消える」を知らせた作品。**作品（Project）ごと**に 1 回
   *  （mount でのリセットに頼らない＝別の作品を開けば自然に出し直す。弱い参照なので閉じた作品を抱え込まない） */
  private eraseAllPinNoticed = new WeakSet<Project>();
  /** V178: 「消せるレイヤーがない／準備中」の間引き（`lockGuard` と同じ 3.4 秒）。
   *  -Infinity で始める＝起動した直後の 1 回目も必ず出す */
  private lastEraseAllToastAt = -Infinity;
  protected lastPt: { x: number; y: number } | null = null;
  protected smoothPt: { x: number; y: number } | null = null;
  private _pointerDown = false;
  /** 接触中フラグ。M11-16: **書き込みを1箇所に集約**し、立つ瞬間に HUD を薄く・下りる瞬間に
   *  戻す（setStrokeHud）。pointerup / pointercancel / blur→endPointerSession / スポイトの早期解放 /
   *  mount のリセット…どこから下ろしても必ずここを通るので「消えたまま戻らない」が起きない */
  protected get pointerDown(): boolean {
    return this._pointerDown;
  }
  protected set pointerDown(v: boolean) {
    if (this._pointerDown === v) return;
    this._pointerDown = v;
    this.pointerDownChanged(v); // ★V213: HUD を薄くする／戻すのは画面（PC・パンの最中を除く）
  }
  protected shapeStart: { x: number; y: number } | null = null;
  /** M10-7: 図形ドラッグ中の**生の**終点（拘束前）。Shift の押下/解放を
   *  マウスを動かさずに即反映するため、拘束前の座標を保持しておく必要がある */
  protected shapeLastPt: { x: number; y: number } | null = null;
  /** M10-7: Shift の押下状態。pointer イベントの `shiftKey` を真実として毎回同期し、
   *  keydown/keyup でも更新する（ウィンドウ非フォーカス中の押下を取りこぼさないため） */
  protected shiftHeld = false;
  // 歪み（M10-2a）。パラメータは既存の流儀に合わせて永続化しない（penSize 等と同じ）
  protected warpMode: WarpMode = "push";
  protected warpRadius = 24;
  protected warpStrength = 50;
  protected warpField: WarpField | null = null;
  /** ストローク開始時の全レイヤースナップショット（layerId -> IndexBuf）。適用元は常にこれ */
  protected warpBefore: Record<string, IndexBuf> | null = null;
  protected warpLastPt: { x: number; y: number } | null = null;
  /** M10-2b: 魚眼の中心。**ストローク開始位置で固定**する（追従させない）。
   *  中心が動くと場が複数中心の重ね合わせになって魚眼でなくなり、液状化の亜種になる。
   *  また行き過ぎ止めは「変位が径方向である」ことを前提にしているので、前提が崩れる。 */
  protected warpCenter: { x: number; y: number } | null = null;
  /** M10-2b: 押しっぱなし連続適用のタイマー */
  private warpTimer: ReturnType<typeof setTimeout> | null = null;
  // M10-2c: 四隅変形。**transform とは独立した状態機械**にする（REQ §3.5）。
  // transform は xformCutDone / selMoveBefore / cancelSelectionMove と絡んでいるので、
  // 射影変換をそこへ差し込むと M5-3 → M5-5 系の退行を再演する。
  // M13-2b (T-2): transform は「N 枚を**同じ1枚のマスク**で切り出した float の集合」（`xformLayers`）になった。
  // `floatBuf` は幾何の基準（[0] と同寸）として残している。四隅が独立であることは変わらない
  protected cornerActive = false;
  /** 変形後の四隅（左上→右上→右下→左下）。ドット座標 */
  protected cornerPts: { x: number; y: number }[] = [];
  /** 変形前の矩形（選択範囲があればその外接矩形、なければキャンバス全体） */
  private cornerRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private cornerBefore: Record<string, IndexBuf> | null = null;
  /** 掴んでいるハンドルの index。M13-2b (T-1): 0..3=四隅 / 4..7=辺の中央。null = 掴んでいない */
  protected cornerDrag: number | null = null;
  /** M13-2b (T-1): ドラッグ開始時の4点とポインタ。辺ハンドルは**開始時からの差分**で毎回作り直す */
  protected cornerDragBase: { pts: { x: number; y: number }[]; start: { x: number; y: number } } | null = null;
  protected lassoPts: { x: number; y: number }[] = [];

  // 選択・変形
  protected selMask: Uint8Array | null = null;
  /** 変形の**幾何の基準**になる float（枠・ハンドル・当たり判定・回転中心はこれで決まる）。
   *  M13-2b: 複数レイヤーのときは `xformLayers[0].float` を指す。全レイヤーの float は
   *  **同じ1枚のマスク**で切り出すので ox/oy/w/h が全部一致し、どれを基準にしても同じ（REQ §4） */
  protected floatBuf: R.FloatBuf | null = null;
  /** M13-2b (T-2): 変形の対象レイヤー N 枚ぶん。`float` は同じマスクで切り出した浮動、`before` は切り出す前の
   *  スナップショット（取消・履歴の before）。**絵の無いレイヤーも持ち回る**（確定時のレイヤー集合を
   *  開始時と一致させ、履歴の対称性を保つため・REQ §6-2）。`cv` はプレビュー用の単色キャンバスのキャッシュ
   *  （float は変形中に変わらないので1回作れば足りる＝20枚でも追従が遅れない） */
  protected xformLayers: { id: string; float: R.FloatBuf; before: IndexBuf; cv?: CV }[] = [];
  protected xform: R.Transform = {
    tx: 0,
    ty: 0,
    angle: 0,
    sx: 1,
    sy: 1,
    flipH: false,
    flipV: false,
  };
  protected xformActive = false;
  // M11-8: selmask=選択枠だけの移動（P-1） / layermove=レイヤーの絵の移動（P-2）
  // M13-2b (T-3): scalex / scaley ＝ 辺ハンドルで片方向だけ伸ばす（掴んだ辺だけが動き、対辺は止まる）
  protected dragMode:
    | ""
    | "move"
    | "scale"
    | "scalex"
    | "scaley"
    | "rotate"
    | "selmove"
    | "selmask"
    | "layermove" = "";
  private dragStart: { x: number; y: number } | null = null;
  private dragBase: R.Transform | null = null;
  /** M13-2b (T-3): 掴んだ辺がローカル軸のどちら側か（+1 / -1）。対辺を止める補正に使う */
  private dragSide = 1;
  private static clipboard: R.FloatBuf | null = null;
  /** M3.3: ページ／複数ページ・クリップボード（アプリ全体・クロスメモ保持） */
  protected static frameClip: FrameClip | null = null;
  /** フィルムの範囲選択（Shift+クリック）。コマ構造変更でリセット */
  protected rangeAnchor: number | null = null;
  protected rangeSel: { a: number; b: number } | null = null;
  protected mounted = false;

  /** 範囲選択から柄を登録する（選択オプション／ストリップの「柄として登録」）。
   *  settings にだけ保存（履歴外・トーストで知らせる）。32×32 超は左上を切り出し、全透明は拒否、
   *  上限 12 で満杯なら「一番古い（登録順の先頭）を消して登録しますか？」 */
  protected async registerCustomTone() {
    if (this.xformGuard()) return;
    if (!this.selMask) {
      this.cb.toast(t("ed.sel.needSelection.toast"));
      return;
    }
    const buf = this.activeBuffer();
    if (!buf) {
      this.cb.toast(t("ed.common.needLayer.toast"));
      return;
    }
    const cap = CT.captureCustomTone(buf, this.selMask, this.project.colorTable, CT.CUSTOM_TONE_MAX_SIZE);
    if (!cap) {
      this.cb.toast(t("ed.tone.custom.empty.toast"));
      return;
    }
    if (this.customTones.length >= CT.CUSTOM_TONE_MAX_COUNT) {
      const ok = await this.cb.confirm(t("ed.tone.custom.full.msg"));
      if (!ok) return;
      this.customTones.shift(); // 登録順の先頭＝一番古い
      this.pruneToneIds();
    }
    this.customTones.push({ id: CT.nextCustomToneId(this.customTones), w: cap.w, h: cap.h, colors: cap.colors });
    this.saveCustomTones();
    this.cb.toast(
      cap.cropped ? t("ed.tone.custom.cropped.toast", { w: cap.w, h: cap.h }) : t("ed.tone.custom.registered.toast")
    );
    this.rebuildTexPicker();
  }

  /** 右クリック→確認つき削除（settings のみ・履歴外）。選んでいた柄が消えたらベタへ戻す */
  protected async deleteCustomTone(id: number) {
    const ok = await this.cb.confirm(t("ed.tone.custom.delete.msg"));
    if (!ok) return;
    this.customTones = this.customTones.filter((c) => c.id !== id);
    this.pruneToneIds();
    this.saveCustomTones();
    this.cb.toast(t("ed.tone.custom.deleted.toast"));
    this.rebuildTexPicker();
  }

  /** 消えたマイ柄を指している道具のトーン選択を既定へ戻す（ブラシ/バケツ/消しゴム=ベタ・ペン=texture） */
  private pruneToneIds() {
    const alive = (key: string) => {
      const cid = CT.parseCustomToneKey(key);
      return cid === null || this.customTones.some((c) => c.id === cid);
    };
    if (!alive(this.brushToneId)) this.brushToneId = "solid";
    if (!alive(this.fillToneId)) this.fillToneId = "solid";
    if (!alive(this.eraserToneId)) this.eraserToneId = "solid";
    if (!alive(this.penToneId)) this.penToneId = "";
  }

  private saveCustomTones() {
    this.cb.onCustomTonesChange?.(this.customTones.map((c) => ({ ...c, colors: [...c.colors] })));
  }

  /** M11-2: そのツールが太さを記憶する枠。ペン/ブラシ/消しゴムは各自、
   *  それ以外（図形など）はペンの枠を共有する */
  protected sizeSlot(t: Tool): "pen" | "brush" | "eraser" {
    return t === "brush" ? "brush" : t === "eraser" ? "eraser" : "pen";
  }

  protected setTool(t: Tool) {
    const _t0 = perfNow();
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
    // M17: ストローク中に道具が変わったら、前の道具用に解決した色タイルは捨てる（次の move は新しい道具で解決）
    this.strokeTone = null;
    this.toolChanging(t); // ★V213: ストリップを畳む・太さの表示を合わせる（画面・PC）
    if (t === "transform") this.beginTransform();
    // M10-2c: 歪みへ戻ってきたときにモードが corner のままなら再開する
    // （これが無いとハンドルの出ていない死んだモードになる）
    if (t === "warp" && this.warpMode === "corner" && !this.cornerActive)
      this.beginCornerWarp();
    this.toolChanged(); // ★V213: 道具の列・オプション・カーソルを合わせる（画面・PC）
    perfDone("tool.switch", _t0);
  }

  // ---------------- V154 (W-2/W-3/W-4): 作品の大きさ ----------------

  /** しきい値。**環境で変えない**（要件 §2-W-2）。
   *  搭載メモリを見て変えると「同じ作品なのに人によって違う警告が出る」＝説明できない挙動になり、
   *  「あの人は大丈夫だったのに」で相談が噛み合わなくなる。`sysinfo` 等の依存も足さない。
   *
   *  V154b（作者の訂正・2026-08-28）: **壁（`LOAD_WALL_BYTES` = 384 MiB）から逆算する**。
   *  以前の 256/512 MiB は仮置きで、**512 MiB は壁の向こう側**だった——
   *  警告が出るより先に「保存はできるのに開けない」に落ちてしまう。
   *  いまは 384 MiB の **50% で注意・75% で警告**（＝壁に当たる前に必ず声がかかる）。 */
  protected static readonly SIZE_CAUTION = 192 * 1024 * 1024; // 384 MiB の 75%
  /** 履歴に許すバイト数の下限・上限（W-4） */
  /** V156 (P-2): 下限を 16 → **64 MiB**。
   *  ペン1手は before/after 2枚＝**153,600 B（8bit）／307,200 B（16bit）**なので、
   *  64 MiB あれば 16bit でも 218 手・8bit なら 437 手が確実に残る（要件の 200 手を下限だけで賄う）。
   *  16 MiB だった頃は、大きい作品でここに張り付いて **8bit 109 手・16bit 54 手**しか戻れなかった。 */
  private static readonly HIST_BUDGET_MIN = 64 * 1024 * 1024;
  /** V156 (P-2): 上限。**下の式では `SIZE_CAUTION`(192 MiB) を超えられない**ので、
   *  256 MiB は一度も効かない死に定数だった（V156 スパイクの指摘）。実際の天井に合わせる。 */
  private static readonly HIST_BUDGET_MAX = 192 * 1024 * 1024;
  /** 16bit 昇格の案内は**1つの作品につき1回**（毎回出すと邪魔・要件「止まらないこと」） */
  protected promoteNoticed = false;

  /** V154: メーターの3行を書き、履歴の予算（W-4）を作品の大きさに合わせる。
   *  呼ぶ場所は「絵の量が変わり得た直後」だけ（ストローク中は呼ばない）。 */
  protected updateSizeMeter() {
    // ★V166 (D): **重い操作の最中は数え直さない。**
    //  事故のログで `meter.update` が **12.7秒**（7,687コマ×20レイヤー＝153,740面）かかっていた。
    //  貼り付け1回ごとに全コマ・全レイヤーを4通り数え直す（論理サイズ・実サイズ・面数・履歴）ので、
    //  **貼り付けそのものより数え直しのほうが支配的**だった。
    //  漏斗の中では予約だけして、`runHeavy` の後始末で**1回だけ**数える。
    //  ⚠ V154 W-2 の「掛け算ではなく実体を数える」は弱めていない——**回数を減らしただけ**
    if (this.busyKind === "heavy") {
      this.meterPending = true;
      return;
    }
    const _t0 = perfNow();
    // W-4: 作品が大きいほど履歴に許す量を減らす（＝戻せる回数が自動で減る）。
    // 小さい作品では上限に張り付く＝64件の従来どおり（体感を変えない）
    const proj = projectBytes(this.project);
    // V156 (P-1): 実メモリ（起きている生バッファ＋眠っている圧縮控え）。
    // **表示の数字（proj）は論理サイズのまま**——あちらは門番の入力なので変えない（条件4）。
    // V156 (P-1): **育った作品にも効かせる。**開いたときは小さくても、コマを足していけば
    // しきい値を越える（連番挿入・ページ挿入・ゆらゆら）。ここは絵の量が変わった直後に
    // 呼ばれる場所なので、越えた時点で眠りを始める（一度 true にしたら下げない＝往復しない）
    if (!this.sleepOn && proj >= EditorCore.SLEEP_MIN_BYTES) {
      this.sleepOn = true;
      setStaleSleepLogger((detail) => this.cb.appendLog?.(`[V156] ${detail}`));
      this.nudgeSweep();
    }
    const real = this.sleepOn ? awakeBytes(this.project) + sleepBytes(this.project) : proj;
    // V156 (P-2): 予算の基準を**実サイズ**にする。論理サイズのままだと、大きい作品は
    // 眠って実際は軽くなっているのに永遠に下限へ張り付く（再現データで 115 MiB＝785手が出せない）
    this.history.budgetBytes = Math.max(
      EditorCore.HIST_BUDGET_MIN,
      Math.min(EditorCore.HIST_BUDGET_MAX, EditorCore.SIZE_CAUTION - real)
    );
    this.paintSizeMeter(proj, real, _t0); // ★V213: メーターの中身と大きさの知らせは画面（PC が上書き）
  }

  /** ★V214: 警告の段（384 MiB の 75%。前は PC の static・字は同じ） */
  protected static readonly SIZE_WARN = 288 * 1024 * 1024;
  /** 注意/警告のときに足す助言。**動的キーは `*Key` のプロパティで持つ**
   *  （`m1201_i18n_check` の検査4 がこの形だけを拾える。文字列を組み立てると検査が沈黙する） */
  protected static readonly SIZE_ADVICE = {
    caution: { msgKey: "ed.size.caution.msg" },
    warn: { msgKey: "ed.size.warn.msg" },
  } as const;
  /** 大きさの知らせを出した帯（"" =まだ出していない）。帯が上がったときだけ出す */
  protected sizeNoticedLevel: "" | "caution" | "warn" = "";
  /** V159 (G-1): 直近にメーターが数えた面数。性能ログの文脈にだけ使う（表示には使わない）。 */
  protected lastFaces = 0;

  /** ★V214 (M-2b-1a): 大きさの段（前は PC の paintSizeMeter の中・字は同じ）。履歴の合計・作品と合わせた量・段・面数を返す。
   *  面数は性能ログの文脈（lastFaces）にも置く（ここでしか数えない） */
  protected sizeVerdict(proj: number): { hist: number; total: number; level: "ok" | "caution" | "warn"; faces: number } {
    const hist = this.history.totalBytes();
    const total = proj + hist;
    const level: "ok" | "caution" | "warn" =
      total >= EditorCore.SIZE_WARN ? "warn" : total >= EditorCore.SIZE_CAUTION ? "caution" : "ok";
    const faces = projectFaces(this.project);
    this.lastFaces = faces; // V159 (G-1): 性能ログの文脈に使う（ここでしか数えない）
    return { hist, total, level, faces };
  }

  /** ★V214 (M-2b-1a): 段が上がったときのログと知らせ（前は PC の paintSizeMeter の後ろ・字は同じ）。
   *  1 つの作品で最大 2 回（注意で 1 回・警告に上がってもう 1 回）・小さい作品では出ない・閉じるだけで何も起きない */
  protected noticeSizeLevel(level: "ok" | "caution" | "warn", proj: number, hist: number, total: number): void {
    if (level !== "ok" && this.sizeNoticedLevel !== "warn" && this.sizeNoticedLevel !== level) {
      this.sizeNoticedLevel = level;
      this.cb.appendLog?.(
        `[V154b] size ${level} project=${proj} history=${hist} total=${total} ` +
          `faces=${projectFaces(this.project)}/${loadWallFaces(
            this.project.indexBits === 16 ? 16 : 8
          )} wall=${LOAD_WALL_BYTES}`
      );
      // 数字は本文に混ぜず、**いまの合計**を頭に添える（訳文を増やさずに現在値を見せる）
      const head = `${t("ed.size.total.label")} ${formatSize(total)}`;
      void this.cb.notice?.(head + "\n\n" + t(EditorCore.SIZE_ADVICE[level].msgKey));
    }
  }

  /** V154 (W-3): 16bit 昇格＝**メモリの使用量が倍**になり、色を減らしても戻らない一方通行
   *  （`editor.ts` の promoteTo16 は片道）。**小さい作品ではこれまでどおりトーストだけ**。
   *  大きい作品のときだけ、いまの量を添えて**作品につき一度**知らせる（止めはしない）。 */
  private noticePromote16() {
    const proj = projectBytes(this.project);
    if (this.promoteNoticed || proj < EditorCore.SIZE_CAUTION || !this.cb.notice) {
      this.cb.toast(t("ed.color.promote16.toast")); // 従来どおり（小さい作品の体感を変えない）
      return;
    }
    this.promoteNoticed = true;
    this.cb.appendLog?.(`[V154b] promote16 bytes=${proj}`);
    // ここに来た時点で昇格は済んでいる＝`proj` は**倍になったあと**の量
    void this.cb.notice(t("ed.color.promote16.big.msg", { size: formatBytes(proj) }));
  }

  // ---------------- 音声UI（M6-3: 波形調整パネル） ----------------

  protected audioPreview = new AudioPreview();

  // ---------------- M5-1: SEトラック・コマ配置の操作（Undo対応） ----------------

  /** 音声パネルが開いている間だけ設定される SEセクション再描画フック */
  protected seSectionRefresh: (() => void) | null = null;

  /** SE配置の対象コマ（フィルム範囲選択中は範囲・それ以外は現在コマ） */
  protected selectedFrameIndices(): number[] {
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
    this.updateSizeMeter(); // V154 (W-2 ③): 音声もメモリに載っている
  }

  private seById(id: string): SeTrack | undefined {
    return this.project.audio?.se.find((s) => s.id === id);
  }

  /** SEトラック追加（外部ファイル。M5-2でマイク録音を追加予定） */
  protected addSeTrack(picked: { bytes: Uint8Array; mime: string; name: string }) {
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
    // V154 (W-2 ③): 取り消すと、この音源のバイト列は履歴のクロージャだけが持つ（独立レビューの指摘）
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: "SE追加",
      bytesIfUndone: entryBytes(track),
      undo: revert,
      redo: apply,
    });
    apply();
  }

  /** SEトラック削除（全コマの配置も外す。Undoで配置ごと復元） */
  protected deleteSeTrack(id: string) {
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
    // V154 (W-2 ③): 消した効果音のバイト列も履歴が抱えたまま（戻せばプロジェクト側へ帰る）
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: "SE削除",
      bytesIfApplied: entryBytes(track),
      undo: revert,
      redo: apply,
    });
    apply();
  }

  /** 音量変更の履歴（スライダーの確定時に呼ぶ。値は既に反映済み） */
  protected pushSeVolumeHistory(id: string, from: number, to: number) {
    const self = this;
    this.dirty = true;
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
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

  protected toggleSeMute(id: string) {
    const t = this.seById(id);
    if (!t) return;
    const self = this;
    const apply = () => {
      const cur = self.seById(id);
      if (cur) cur.muted = !cur.muted;
      self.afterSeChange();
    };
    this.history.push({ colorRefs: NO_COLOR_REFS, label: "SEミュート", undo: apply, redo: apply });
    apply();
  }

  protected renameSeTrack(id: string, name: string) {
    const t = this.seById(id);
    if (!t || t.name === name) return;
    const from = t.name;
    const self = this;
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
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
  protected toggleSePlacement(id: string, frames: number[]) {
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
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: add ? "SE配置" : "SE配置解除",
      undo: () => applyTo(!add),
      redo: () => applyTo(add),
    });
    applyTo(add);
  }

  // ---------------- V195 (A-99): 上の色の帯から色を消す ----------------

  /** ★V195 (A-99・REQ-009): 帯の色を右クリックしたとき。
   *
   *  ① **使っているかを先に調べる**（全コマ・全レイヤー・眠っているコマ・紙・取り消しの記録・コピー中の絵）。
   *    使っていれば消さずに「この色は ◯ コマで使っています」等を知らせる（消せない色に確認を出さない）。
   *    調べるのは重い操作の漏斗（runHeavy）の中＝大きい作品でも固めない・その間はほかの操作を受け付けない
   *  ② 使っていなければ**確かめてから**消す。消すのは**空き番号にするだけ**（colorTable[k] = ""）＝画素は 1 つも変えない
   *  ③ 1 回の操作として取り消しに積む（Ctrl+Z で帯に戻る・Ctrl+Y でまた消える）
   *  判断と数え方は `colorUsage.ts`（純関数・v195_smoke が本物の Editor で確かめる） */
  protected async deletePaletteColor(hex: string) {
    if (this.busyKind || this.pointerDown) return;
    // ★矢印キーの移動の途中（移動前の絵を番号のまま `layerDrag.before` 等に持ち、800ms 後のタイマーで確定する）を
    //  **先に確定する**。マウスの右クリックは押した時点で uiPointerHandler が確定させるが、キーボードから右クリックの
    //  メニューを出したとき（Shift+F10・メニューキー）はそこを通らない＝調べたあとでタイマーが「移動前の絵」を履歴に
    //  積み、Ctrl+Z で消した番号の画素が戻ってくる（V195 のコミット前レビューの指摘）。gotoFrame と同じ形
    this.endArrowSession();
    if (this.xformGuard()) return; // 変形中の浮いた絵（番号のまま）を抱えたまま空けない
    const project = this.project;
    const slots = colorSlots(project, hex);
    if (slots.length === 0) return;
    // 履歴の変更カウンタは**調べる直前**に取る（入口の beginBusy が残りの束を確定したあと＝それは調べる中に入る）。
    // 調べている間・確認を閉じるまでに 1 つでも動いたら、調べた結果は古い＝消さない
    let gen = -1;
    const use = await this.runHeavy("color.scan", t("ed.heavy.colorScan.msg"), () => {
      gen = this.history.mutations;
      return scanColorUse(
        project,
        slots,
        {
          history: this.history.entriesForScan(),
          // V199 (A-105): フォルダの控えは中の全部の絵（clipBuffers）
          clips: [EditorCore.clipboard?.data ?? null, ...clipBuffers(this.layerClip)],
        },
        yieldToInput
      );
    });
    if (!use || this.project !== project || !this.mounted) return; // 入口が閉じていた／作品が替わった
    if (this.history.mutations !== gen) return; // 調べている間に履歴が動いた（キーもポインタも止まっているので普通は起きない）
    const verdict = colorDeleteVerdict(use);
    if (verdict === "frames") {
      this.cb.toast(t("ed.color.usedFrames.toast", { n: use.frames }));
      return;
    }
    if (verdict === "history") {
      this.cb.toast(t("ed.color.usedHistory.toast"));
      return;
    }
    if (verdict === "clip") {
      this.cb.toast(t("ed.color.usedClip.toast"));
      return;
    }
    const ok = await this.cb.confirm(t("ed.color.delete.msg", { hex }));
    if (!ok) return;
    // 調べてから確認を閉じるまでに作品が変わっていたら、調べた結果は古い＝消さない（確認の間は操作できないので保険）
    if (this.project !== project || this.history.mutations !== gen || !this.mounted) return;
    if (slots.some((k) => (project.colorTable[k] ?? "").toLowerCase() !== hex.toLowerCase())) return;
    const self = this;
    const set = (toEmpty: boolean) => {
      for (const k of slots) project.colorTable[k] = toEmpty ? "" : hex;
      self.dirty = true;
      self.rebuildPalette();
    };
    this.history.push({
      label: "色を消す",
      colorRefs: NO_COLOR_REFS, // 抱えているのは hex の文字列だけ（画素はゼロ）
      undo: () => set(false),
      redo: () => set(true),
    });
    set(true);
    this.cb.toast(t("ed.color.deleted.toast"));
  }

  /** ★V215 (A-125・REQ_color_section §2-2): 使っていない色を**まとめて**帯から消す（［整理］）。
   *
   *  入口と順番は `deletePaletteColor`（A-99）と同じ。違うのは全部の色を 1 回で調べること（`scanAllColorUse`）だけで、
   *  色ごとの判断は A-99 の右クリックと同じになる（`allColorVerdict`・v215_smoke [P] が総当たりで見る）。
   *  ① 候補＝帯の色（同じ hex の番号は大文字小文字を区別せずにまとめて 1 色・空き番号と 0 は入れない）のうち、
   *    どのコマ・レイヤー・紙でも使っていない色。**既定の 6 色（DEFAULT_PALETTE）といま選んでいる色は入れない**（D-4・D-5）
   *  ② 候補のうち、取り消しの記録かコピー中の絵で使っている色は残す（{m}）。記録に申告の無いものがあれば**候補を全部残す**（網）
   *  ③ 確認のあとで、作品・history.mutations・mounted・消す番号の字が調べた時のままかを見直し、1 つでも違えば消さない
   *  ④ 消すのは**空き番号にするだけ**（画素も番号の数も変えない・16bit は 16bit のまま）。**1 つの取り消しで全部戻る**。
   *    戻すときは番号ごとに元の字（大文字小文字も）を書き戻す */
  protected async tidyPaletteColors() {
    if (this.busyKind || this.pointerDown) return;
    // A-99 と同じ: 矢印キーの移動の途中を先に確定し、変形中の浮いた絵（番号のまま）を抱えたまま空けない
    this.endArrowSession();
    if (this.xformGuard()) return;
    const project = this.project;
    let gen = -1;
    const use = await this.runHeavy("color.scan", t("ed.heavy.colorTidy.msg"), () => {
      gen = this.history.mutations;
      return scanAllColorUse(
        project,
        {
          history: this.history.entriesForScan(),
          clips: [EditorCore.clipboard?.data ?? null, ...clipBuffers(this.layerClip)],
        },
        yieldToInput
      );
    });
    if (!use || this.project !== project || !this.mounted) return;
    if (this.history.mutations !== gen) return;
    // 帯の色を hex（小文字）でまとめる。並びは帯と同じ（先に出た番号の順）
    const groups = new Map<string, number[]>();
    for (let k = 1; k < project.colorTable.length; k++) {
      const h = (project.colorTable[k] ?? "").toLowerCase();
      if (!h) continue;
      const g = groups.get(h);
      if (g) g.push(k);
      else groups.set(h, [k]);
    }
    const keep = new Set<string>(DEFAULT_PALETTE.map((h) => h.toLowerCase()));
    if (this.colorHex) keep.add(this.colorHex.toLowerCase());
    const candidates: { hex: string; slots: number[]; ok: boolean }[] = [];
    for (const [h, slots] of groups) {
      if (keep.has(h)) continue;
      const v = allColorVerdict(use, slots);
      if (v === "frames") continue; // 使っている
      candidates.push({ hex: h, slots, ok: v === "ok" });
    }
    if (candidates.length === 0) {
      this.cb.toast(t("ed.color.tidy.none.toast"));
      return;
    }
    const removable = candidates.filter((c) => c.ok);
    const m = candidates.length - removable.length; // 申告の無い記録があるときは allColorVerdict が全部 "history"＝候補を全部残す
    if (removable.length === 0) {
      this.cb.toast(t("ed.color.tidy.keptOnly.toast", { m }));
      return;
    }
    const n = removable.length;
    let msg = t("ed.color.tidy.confirm.msg", { n });
    if (m > 0) msg += "\n" + t("ed.color.tidy.confirmKeep.msg", { m });
    const ok = await this.cb.confirm(msg);
    if (!ok) return;
    // 調べてから確認を閉じるまでに作品・記録が変わっていたら、調べた結果は古い＝消さない（A-99 と同じ）
    if (this.project !== project || this.history.mutations !== gen || !this.mounted) return;
    const ks: number[] = [];
    const orig: string[] = [];
    for (const c of removable)
      for (const k of c.slots) {
        ks.push(k);
        orig.push(project.colorTable[k] ?? "");
      }
    // 消す番号の字が、調べた時の色のままか（A-99 と同じ: 1 つでも違えば消さない）
    for (const c of removable) if (c.slots.some((k) => (project.colorTable[k] ?? "").toLowerCase() !== c.hex)) return;
    const self = this;
    const set = (toEmpty: boolean) => {
      for (let i = 0; i < ks.length; i++) project.colorTable[ks[i]] = toEmpty ? "" : orig[i];
      self.dirty = true;
      self.rebuildPalette();
    };
    this.history.push({
      label: "使っていない色をまとめて消す",
      colorRefs: NO_COLOR_REFS, // 抱えているのは hex の文字列だけ（画素はゼロ）
      undo: () => set(false),
      redo: () => set(true),
    });
    set(true);
    this.cb.toast(t("ed.color.tidy.done.toast", { n }));
  }

  /** 棚に入れられる色か（透明＝`""` は色ではないので入れられない） */
  protected favoriteHexNow(): string | null {
    return normalizeFavColor(this.colorHex);
  }

  /** いまの色を登録／登録済みなら外す（ボタン1つで両方＝要件 U-3 の「登録／解除」） */
  protected toggleFavoriteColor() {
    const hex = this.favoriteHexNow();
    if (!hex) return; // 透明のときはボタン自体が無効
    const at = this.favoriteColors.indexOf(hex);
    if (at >= 0) {
      this.favoriteColors.splice(at, 1);
    } else {
      if (this.favoriteColors.length >= FAVORITE_COLORS_MAX) {
        this.cb.toast(t("ed.color.fav.full.toast", { max: FAVORITE_COLORS_MAX }));
        return;
      }
      this.favoriteColors.push(hex);
    }
    // マイ柄と同じ流儀: 変えた瞬間に settings へ（履歴には積まない＝作品の Undo とは無関係）
    this.cb.onFavoriteColorsChange?.([...this.favoriteColors]);
    this.rebuildFavPalette();
  }

  /** V164 (U-1): オニオンの段数と向きを settings へ（変えた瞬間に保存＝マイ柄・配色と同じ流儀） */
  protected saveOnion() {
    this.cb.onOnionChange?.(this.onionLevel, this.onionDir);
  }

  // ---------------- M3.7: レイヤーツリー（フォルダ・ネスト対応） ----------------

  /** 選択中フォルダ（新規作成先・フォルダ操作の対象） */
  protected selectedFolderId: string | null = null;
  /** M3.8: 複数選択（レイヤー/フォルダの node id。描画対象 activeLayerId は従来どおり1枚） */
  protected selectedNodeIds = new Set<string>();

  protected folderById(id: string | undefined): LayerFolder | undefined {
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

  private restoreStructure(s: ReturnType<EditorCore["captureStructure"]>) {
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
  protected pushStructure(label: string, mutate: () => void) {
    const before = this.captureStructure();
    mutate();
    const after = this.captureStructure();
    const self = this;
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
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
  protected addFolder() {
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
        name: `${folderBaseName()}${folders.length + 1}`,
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
  protected async deleteFolder(id: string) {
    if (this.xformGuard()) return;
    const folder = this.folderById(id);
    if (!folder) return;
    // V151 (E-8): 「次回から表示しない」対象の1つ（id: folderDelete）。省くのは**この1段目だけ**。
    // 2段目（中身も削除するか）は yes/no どちらも先へ進む「選択」なので、非表示にしても従来どおり出る
    const ok = await this.confirmWithSkip("folderDelete", t("ed.layer.folderDeleteConfirm.msg", { name: folder.name }));
    if (!ok) return;
    const memberIdx = this.folderLayerIndices(id);
    const withContents =
      memberIdx.length > 0 &&
      (await this.cb.confirm(
        t("ed.layer.folderDeleteContents.msg", { count: memberIdx.length })
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
      this.cb.toast(t("ed.layer.deleteAllBlocked.toast"));
      return;
    }
    // ★V166 (層2): 中身ごと削除は「レイヤー削除の N 枚ぶん」＝いちばん重い経路のひとつ。
    //  2段の確認はどちらも漏斗の外（＝待ち時間に箱を出さない）
    await this.runHeavy("layer.del", t("ed.heavy.delLayer.msg"), () =>
      this.deleteFolderWithContents(id, memberIdx)
    );
  }

  private async deleteFolderWithContents(id: string, memberIdx: number[]) {
    const structBefore = this.captureStructure();
    const removedIds = memberIdx.map((i) => this.project.layerDefs[i].id);
    // V166 (B): 控えは「全コマ × 消すレイヤーの枚数」＝この回でいちばん大きくなり得る確保
    if (!this.allowBufferAlloc(this.project.frames.length * removedIds.length, "folder.del", removedIds)) return;
    // ★V156 (P-1): 全コマの画素を控えるので、消す対象のレイヤーだけ先に起こす
    await wakeLayersAllFrames(this.project, removedIds, "write");
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
        for (const lid of removedIds) dropLayer(f, lid); // V156: 眠りぶんも
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
      colorRefs: () => ({ bufs: savedBuffers.flatMap((m) => Object.values(m)) }), // V195 (A-99)
      label: "フォルダごと削除",
      // V156 (P-1): 巻き戻しは全コマへバッファを配り直す。眠っていると取りこぼすので先に起こす
      prepare: () => wakeLayersAllFrames(self.project, removedIds, "write"),
      bytes: entryBytes(savedBuffers), // V154 (W-2): 中身のレイヤーを全コマぶん抱える
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
  protected pruneSelection() {
    const alive = new Set<string>([
      ...this.project.layerDefs.map((l) => l.id),
      ...(this.project.folders ?? []).map((f) => f.id),
    ]);
    for (const id of [...this.selectedNodeIds])
      if (!alive.has(id)) this.selectedNodeIds.delete(id);
    if (this.selectedNodeIds.size === 0 && this.activeLayerId)
      this.selectedNodeIds.add(this.activeLayerId);
  }

  /** DnD確定: 選択トップノード群を target へ（履歴1件・変化なしなら履歴を積まない） */
  protected performTreeMove(ids: string[], target: DropTarget) {
    if (this.xformGuard()) return;
    const before = this.captureStructure();
    const res = moveNodes(this.project, ids, target);
    if (!res.ok) {
      if (res.error) this.cb.toast(res.error);
      return;
    }
    if (res.changedPhys && this.clearFrameOrders())
      this.cb.toast(t("ed.layer.frameOrderNormalized.toast"));
    const after = this.captureStructure();
    if (JSON.stringify(after) === JSON.stringify(before)) {
      this.afterLayerChange();
      return; // 実質変化なし（同じ場所へドロップ等）
    }
    const self = this;
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: "レイヤー移動",
      undo: () => self.restoreStructure(before),
      redo: () => self.restoreStructure(after),
    });
    const _t0 = perfNow();
    this.afterLayerChange();
    perfDone("layer.move", _t0);
  }

  /** M14 (S-1): 歪みモードの切替（旧 #ed-warpmode のクリック処理と同一）。四隅の開始/取消もここで面倒を見る */
  protected selectWarpMode(m: WarpMode) {
    if (this.warpMode === m) return;
    if (this.cornerActive) this.cancelCornerWarp(); // 四隅から抜けるときは未確定の変形を取り消す
    this.warpMode = m;
    if (m === "corner") this.beginCornerWarp();
    this.afterFormatChange();
  }
  protected snap15 = false;

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
   * 本体は wobble.ts の純関数（M11-20 で切り出し）。ここは「現在コマ・選択範囲」を渡す薄い殻。
   *
   * `seedBase` を**引数で受け取る**のは意図的。内部で `hashCurrentFrame()` を呼ぶと
   * `?wobble` から固定シードを渡して決定性を検証できなくなる。ハッシュは呼び出し側の仕事。
   * `targetLayerId`（M11-20）: null=全レイヤー（従来）／id=そのレイヤーだけ歪め、他は複製のまま
   * V205 (A-114): id の集まり（選んだレイヤーやフォルダの中）も渡せる（空の集まりはどれも揺らさない＝null とは違う）
   */
  private buildWobbleFrames(
    count: number, // 2 | 3 | 4（原本を含めた総枚数）
    kind: WobbleKind,
    strength: WobbleStrength,
    seedBase: number,
    targetLayerId: WobbleTarget = null
  ): Frame[] {
    const cur = this.project.frames[this.frameIndex];
    if (!cur) return [];
    // M11-8 P-4（REQ 表D）: 選択範囲があるときは**範囲内だけ**を揺らす（歪みツールと揃える）。
    // 全コマ共通の場（field）は変えず、適用時にマスクで弾く
    return buildWobbleFrames(
      this.project,
      cur,
      count,
      kind,
      strength,
      seedBase,
      this.selMask ?? null,
      targetLayerId
    );
  }

  /** V204 (A-111・REQ §2-2): ゆらゆらのシード（見本と［つくる］の両方がここを通る）。式は wobble.ts の wobbleSeedBase */
  protected wobbleSeed(kind: WobbleKind, strength: WobbleStrength): number {
    return wobbleSeedBase(this.hashCurrentFrame(), this.project.frames.length, this.frameIndex, kind, strength);
  }

  /** V205 (A-114): ゆらゆらの「選択中」の対象（ダイアログの表示・見本・［つくる］の 3 か所がここを通る） */
  protected wobbleTargets(): WobbleTargets {
    return wobbleTargetLayerIds(this.project, this.selectedNodeIds, this.activeLayerId);
  }

  protected onWobbleApply(
    opt: { count: number; kind: WobbleKind; strength: WobbleStrength; target: "all" | "active" },
    target: ReadonlySet<string> | null,
    wt: WobbleTargets,
    willWarn: boolean
  ) {
    // ★V204 (A-111): シードは見本と同じ 1 つの式（wobbleSeed）。対象種別は混ぜない＝
    // 単体モードの対象レイヤーは全レイヤーモードの同じレイヤーとビット同一（機械検証できる不変条件）。
    // 見本の絵は使い回さない（押した時点の値でここで作る＝見本が前の値のままでも、押した値の絵になる）
    const seedBase = this.wobbleSeed(opt.kind, opt.strength);
    const newFrames = this.buildWobbleFrames(
      opt.count,
      opt.kind,
      opt.strength,
      seedBase,
      target
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
    // V154 (W-2): 取り消したコマは履歴が抱える（同上）
    this.history.push({
      colorRefs: () => ({ frames: newFrames }), // V195 (A-99)
      label: "ゆらゆら差分",
      bytesIfUndone: entryBytes(newFrames),
      undo: revert,
      redo: apply,
    });
    apply();
    if (willWarn)
      this.cb.toast(t("ed.common.manyFrames.toast"));
    // 速度ヒント。**速度は勝手に変えない。** トーストが2連続で重なって読めないので、
    // 生成枚数のトーストにヒントを混ぜて1つにまとめる（P-9-2 の許容範囲）
    const fps = FPS_TABLE[this.project.speedIndex] ?? 8;
    // M12-1b-2（監査 #44）: 断片（「…」だけ ）の連結をやめ、対象×fps ヒントの**完全文4キー**にした
    // V205 (A-114): フォルダや 2 つ以上を選んだときの完全文 2 キーを足した（{count} はできたコマの枚数＝今の 4 つと同じ）
    this.cb.toast(
      target
        ? wt.kind === "layer"
          ? fps >= 12
            ? t("ed.wobble.doneLayerFpsHint.toast", { name: wt.name, count: newFrames.length })
            : t("ed.wobble.doneLayer.toast", { name: wt.name, count: newFrames.length })
          : fps >= 12
            ? t("ed.wobble.doneSelectedFpsHint.toast", { count: newFrames.length })
            : t("ed.wobble.doneSelected.toast", { count: newFrames.length })
        : fps >= 12
          ? t("ed.wobble.doneFpsHint.toast", { count: newFrames.length })
          : t("ed.wobble.done.toast", { count: newFrames.length })
    );
  }

  /** V151 (E-8): 「次回から表示しない」チェックつき確認の唯一の入口。
   *  - 非表示に設定済み（hiddenConfirms に id がある）→ ダイアログを出さず true
   *  - 「はい」＋チェック → 以後非表示にして settings へ（⚙ の「確認ダイアログ」節でいつでも戻せる）
   *  - 「いいえ」ならチェックされていても**覚えない**（キャンセルで非表示になる事故を防ぐ）
   *  - confirmSkippable が未配線（旧ホスト）なら従来の confirm と同じに動く */
  private async confirmWithSkip(id: "clearFrame" | "layerDelete" | "folderDelete", msg: string): Promise<boolean> {
    if (this.hiddenConfirms.has(id)) return true;
    if (!this.cb.confirmSkippable) return this.cb.confirm(msg);
    const r = await this.cb.confirmSkippable(msg);
    if (r.ok && r.skip) {
      this.hiddenConfirms.add(id);
      this.cb.onHiddenConfirmsChange?.([...this.hiddenConfirms]);
    }
    return r.ok;
  }

  // ---------------- 保存 ----------------

  /** 保存。成功時 true / キャンセル・失敗時 false（saveAs のフラグ復元に使う） */
  // V201 (M-1a): 保存したファイルを読み戻して確かめる所（V154 W-6 の verifySavedFile）は、共通の部品
  //  （saveCore.ts の verifyWritten）へ移した。読み戻す口は `cb.readSavedFile` のまま渡す

  // ================= V166 (層1): 重い操作の漏斗 =================
  //
  // ★なぜ要るか（2026-08-31 の事故）
  //   1,000コマ規模のコマを貼り付け連打 → `Array buffer allocation failed` を8回出しながら
  //   操作を受け付け続け、最後に WebView ごと落ちた。原因は**貼り付けが「重い処理」として
  //   扱われていなかった**こと——入口の閉鎖も表示も無く、**連打できた**。
  //   ログには 11〜25秒の停止が `busy=no` で何度も残っていた（＝何も出さずに固まっていた）。
  //
  // ★この関数が唯一の入口（§1-g 層1）
  //   1. **入口を閉じる**（実行中は同じ操作も他の重い操作も受け付けない＝連打が原理的に起きない）
  //   2. **ボタンを見た目でも無効に**する（`updateBusyButtons`）
  //   3. `PERF_MIN_MS`（50ms）を過ぎたら「◯◯しています」を出す（一瞬で終わる操作では出さない）
  //   4. **`finally` で必ず解放**する（例外で閉じっぱなしにしない）
  //   5. 終わってから**メーターを1回だけ**数え直す（D: 操作の最中に 12.7 秒かけて数え直さない）
  //   6. 確保に失敗したら**そこで天井を下げる**（E: 2回目以降を同じ形で失敗させない）
  //
  // ★表示の仕組みは増やさない: 中身は `ui/busy.ts` の `runWithBusy` に委ねる
  //  （ライブラリ・ホームと**同じ1つの実装**。こちらはそれに「入口の閉鎖」を足しているだけ）。
  //
  // ⚠ **保存はここを通さない**（V161-A の「保存中も描ける」を殺すため・壊すなリスト）。
  //   保存は `runBackgroundSave` が自前で持つ（入口を閉じない・右下の小さなピルだけ）。

  /** V166: 重い操作と判定する表示遅延（ms）。`PERF_MIN_MS` と同じ値にしてあるので、
   *  **長タスクとして記録される区間には必ず表示が出ている**（ログの `busy=no` が消える）。 */
  private static readonly HEAVY_BUSY_DELAY_MS = PERF_MIN_MS;

  /** V166 (E): 1回の重い操作に許す確保量。確保に失敗したら**その場で下げる**
   *  （＝以後その先へは伸ばさない。undo や削除で実際に減れば、また入るようになる）。 */
  private heavyAllocBudget = HEAVY_ALLOC_MAX_BYTES;

  /** V166 (D): 重い操作の最中にメーターの数え直しを頼まれたか（終わってから1回だけ実行する） */
  private meterPending = false;

  /** V166 (層1): **重い操作はすべてこれを通る。**
   *
   *  @param op   `PerfOp`（＝待たせる対象と数える対象を同じ一覧にする・要件 層2）
   *  @param msg  「◯◯しています」の訳文
   *  @returns    `fn` の戻り値。**入口が閉じていて実行しなかったときは `undefined`**
   */
  async runHeavy<T>(op: PerfOp, msg: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    // ★連打が原理的に起きない: 走っている間は同じ操作も他の重い操作も受け付けない。
    //  黙って捨てる（ボタンは無効になっているので、届くのはキー経由だけ）
    if (this.busyKind) return undefined;
    this.beginBusy("heavy");
    // ★V216b (A-128): 中身を始める前に裏の片づけを止めて、走っている周を待つ（起こした面を書く前に眠らされない・
    //  圧縮の途中のコマに書いたあとで古い控えに戻されない）。どの抜け方でも finally で外す
    const holding = this.holdSweep();
    try {
      if (holding) await holding;
      // ★V166（独立レビューの指摘・優先度中）: **1回だけ画面に描かせてから**中身を始める。
      //  重い処理の多くは**同期**（貼り付けの組み立て・統合の焼き込み）で、始まったら
      //  イベントループが返ってこない＝`beginBusy` で付けた「押せない見た目」が
      //  **描かれないまま固まる**。ここで1拍譲ると、少なくとも
      //  「受け付けた・押せなくなった」ことは必ず見える。
      //  ⚠ 同期処理の最中に「◯◯しています」の箱を**出すことはできない**（タイマーが動けない）。
      //   それには操作そのものを刻む必要があり、この回の範囲を超える（報告書に明記）。
      await this.heavyYield(); // ★V213: 1 拍譲って描かせるのは画面（PC）
      return await this.heavyBox(op, msg, async () => fn(), EditorCore.HEAVY_BUSY_DELAY_MS);
    } catch (e) {
      // V166 (E): 確保に失敗したら**1回目でそこを天井にする**。
      // 事故のログでは `unhandledrejection` を8回出しながら操作を受け付け続けていた
      if (isAllocFailure(e)) {
        const real = this.sleepOn
          ? awakeBytes(this.project) + sleepBytes(this.project)
          : projectBytes(this.project);
        this.heavyAllocBudget = Math.max(0, Math.min(this.heavyAllocBudget, Math.floor(real / 8)));
        this.cb.appendLog?.(`[V166] alloc failed op=${op} budget=${this.heavyAllocBudget}`);
        if (this.cb.notice) void this.cb.notice(t("ed.heavy.outOfMemory.msg"));
        else this.cb.toast(t("ed.heavy.outOfMemory.msg"));
        return undefined;
      }
      // それ以外の例外は握り潰さない（呼び出し側／既存の unhandledrejection の網へ）
      throw e;
    } finally {
      this.releaseSweep(); // V216b (A-128)
      // ★どの抜け方でも必ず入口を開ける（基準5: わざと投げても次の操作ができる）
      this.endBusy();
      // V166 (D): 溜めておいたメーターの数え直しを**ここで1回だけ**
      if (this.meterPending) {
        this.meterPending = false;
        this.updateSizeMeter();
      }
    }
  }

  /** V166: いま起きている「面」の数（コマ×レイヤーで実体があるもの）。
   *  昇格（`promoteTo16`）が既存バッファを作り直すぶんの見積もりに使う。 */
  private awakeFaceCount(): number {
    let n = 0;
    for (const f of this.project.frames) n += Object.keys(f.layers).length;
    return n;
  }

  /** V166 (独立レビューの指摘⑤): 指定レイヤーのうち**まだ眠っている面**の数。
   *  `wakeLayersAllFrames` がこれから展開する＝確保する枚数そのもの。 */
  private asleepFaces(layerIds: string[]): number {
    let n = 0;
    for (const f of this.project.frames) {
      if (!f.sleep) continue;
      for (const id of layerIds) if (f.sleep[id] && !f.layers[id]) n++;
    }
    return n;
  }

  /** V166 (B): 「これから n コマ確保してよいか」を聞く。だめなら**断り文句を出して false**。
   *  丸めと上限は `prefs.ts` の純関数（スモークが直接叩ける）。
   *
   *  @param incomingColors 持ち込む色数の上限（クリップの palette 長など）。
   *    ★独立レビューの指摘④: これを渡さないと**16bit 昇格を見落として実確保量を半分に見積もる**。
   *    0 を渡すのは「新しい色が1つも増えない」と分かっている操作だけ（コマ複製・空コマ追加）。
   *  @param where ログに出す操作名（決められた語だけ・W-10） */
  protected allowFrameAlloc(frames: number, incomingColors = 0, where = "paste"): boolean {
    const curBits: 8 | 16 = this.project.indexBits === 16 ? 16 : 8;
    // ★昇格が起こり得るなら 16bit で見積もる（安全側にしか外れない）
    const bits = estimateBits(this.project.colorTable.length, incomingColors, curBits);
    const extra = promotionExtraBytes(this.awakeFaceCount(), bits === 16 && curBits === 8);
    // 昇格ぶんの追加確保は予算から先に引く（＝そのぶん入るコマ数が減る）
    const budget = Math.max(0, this.heavyAllocBudget - extra);
    const r = checkFrameAlloc(frames, this.project.layerDefs.length, bits, budget);
    if (r.ok) return true;
    // ★「入りません」ではなく**何コマなら入るか**を言う（要件 §2-B）。
    //  ただし**1コマも入らない**ときに「約0コマまで貼り付けられます」と言うのは
    //  日本語として壊れているし、助言にもなっていない。そこだけは
    //  「減らすか、保存して開き直す」と言う（＝E の文面と同じ助言）
    const msg =
      r.maxFrames > 0
        ? t("ed.heavy.tooManyFrames.msg", { max: r.maxFrames })
        : t("ed.heavy.outOfMemory.msg");
    if (this.cb.notice) void this.cb.notice(msg);
    else this.cb.toast(msg);
    // 独立レビューの指摘（低）: どの操作で断ったのかを書く（前は全部 `paste refused` だった）
    this.cb.appendLog?.(
      `[V166] ${where} refused need=${r.needBytes} budget=${budget} bits=${bits} maxFrames=${r.maxFrames}`
    );
    return false;
  }

  /** V166 (独立レビューの指摘・優先度高②③): **バイト数そのもの**で通す/断るを決める入口。
   *  「コマ数 × レイヤー数」で表せない確保（クリップの写し取り・展開）に使う。
   *
   *  @param perFrameBytes 分かるなら1コマあたりのバイト数。渡すと断り文句が
   *    **「あと約◯コマまで」**になる（要件 §2-B）。0 なら「減らしてください」だけを言う。
   *    ★ここを足したのは、展開の見積もり（高③）を先に置いた結果、
   *     **何コマ入るかを言う道が塞がれてしまった**のに気づいたため。
   *     断るのが先でも、言うことの質は落とさない。 */
  private allowBytes(needBytes: number, where: string, perFrameBytes = 0): boolean {
    if (needBytes <= this.heavyAllocBudget) return true;
    const maxFrames = perFrameBytes > 0 ? Math.floor(this.heavyAllocBudget / perFrameBytes) : 0;
    const msg =
      maxFrames > 0
        ? t("ed.heavy.tooManyFrames.msg", { max: maxFrames })
        : t("ed.heavy.outOfMemory.msg");
    if (this.cb.notice) void this.cb.notice(msg);
    else this.cb.toast(msg);
    this.cb.appendLog?.(
      `[V166] ${where} refused need=${needBytes} budget=${this.heavyAllocBudget} maxFrames=${maxFrames}`
    );
    return false;
  }

  /** V166 (B): 「1レイヤーぶんのバッファを n 枚」確保してよいか。
   *
   *  ★コマを増やす操作だけでなく、**全コマに効くレイヤー操作**も同じ形で落ちる:
   *   レイヤー統合は「全コマ × 2枚」の控えを取るので、7,687コマなら **1.18 GB**——
   *   貼り付けと同じ確保量になる。コマ数の上限（65,535）はここでも1つも役に立たない。
   *  ★断り文句は「減らすか、保存して開き直す」（＝この確保のほとんどは**元に戻す**用の控えで、
   *   開き直せば履歴が空になって実際に入るようになる）。「あと何コマ」は意味を持たないので言わない。 */
  private allowBufferAlloc(count: number, where: string, wakeLayerIds: string[] = []): boolean {
    const bits: 8 | 16 = this.project.indexBits === 16 ? 16 : 8;
    // ★V166（独立レビューの指摘・優先度高⑤）: **起こすぶんも確保**である。
    //  見落としていた: これらの操作は控えを取る前に `wakeLayersAllFrames` で
    //  眠っているコマを展開する。控えだけ数えて起こすぶんを数えないと、
    //  実際の確保量を半分近く見落とす（眠っている作品ほどズレる）。
    const wake = wakeLayerIds.length ? this.asleepFaces(wakeLayerIds) : 0;
    const r = checkFrameAlloc(count + wake, 1, bits, this.heavyAllocBudget);
    if (r.ok) return true;
    if (this.cb.notice) void this.cb.notice(t("ed.heavy.outOfMemory.msg"));
    else this.cb.toast(t("ed.heavy.outOfMemory.msg"));
    this.cb.appendLog?.(
      `[V166] ${where} refused need=${r.needBytes} budget=${this.heavyAllocBudget}`
    );
    return false;
  }

  // ---------------- V154b (W-7/W-8/W-9): 重い処理は1本だけ ----------------

  /** V154b: 重い処理に入る。**入口を閉じてから**呼ぶこと（`busyKind` が空でないときは呼ばない）。
   *  ロック（W-7/W-9）は**この瞬間から**効く。進捗（W-8）は `showBusyAfterDelay` で別に出す
   *  ——保存先ピッカーのように「利用者を待っている時間」に進捗を出さないため。
   *  V166: 表示は `runHeavy`（＝`runWithBusy`）へ寄せたので、ここは**入口の閉鎖だけ**を持つ。 */
  protected beginBusy(kind: "audio" | "export" | "heavy") {
    // ★V178 (A-72・独立レビュー 2 回目): 重い処理が作品を変える前に、全レイヤーの束を確定して終える。
    //  busyKind を立てるのはここだけ＝重い処理の最中に束が残ることは無くなる（pointerup の関所で取りこぼさない）
    if (this.eraseAllStroke) this.finishEraseAllNow();
    this.busyKind = kind;
    this.busyStarted(); // ★V213: ポインタとボタンを止める（画面・PC）
  }

  /** V154b: 重い処理から出る。**どの経路でも必ず呼ぶ**（finally で呼ぶこと）。 */
  protected endBusy() {
    this.busyClosing(); // ★V213: 遅れて出す進捗の待ちと、出ている進捗を畳む（画面・PC）
    this.busyKind = "";
    this.busyEnded(); // ★V213: ポインタとボタンを戻す（画面・PC）
  }

  // ================= V168 (S): 保存の写しを、写す前に見積もる・待つ・断る =================
  //
  // ★事故（2026-09-02・実機）: 56,860面（実際に使っている量 2.6GB）の Ctrl+S が
  //   `Data cannot be cloned, out of memory.`。写し（structured clone）は 1本の連続バッファに
  //   直列化され、実効上限は約 2GiB。貼り付け直後は貼ったコマが生のまま（掃除が追いつく前）なので太る。
  //   掃除が済めば写しはファイル並み（約 0.2GB）＝**眠らせが追いついているかで通ったり落ちたりする**。
  //
  // ★作者決定: 「眠らせを待ってから写す ＋ 写す前の門番」
  //   - 見積り（純関数 `snapshotBytes`）が soft（512MiB）を超えていたら、**基準点より前**で掃除を待つ
  //   - 待っても max（1.5GiB）を超えていたら**断る**（例外にしない・W-6 と同じ道で知らせる）
  //   - 編集は止めない（V161-A）。掃除は描いている合間に只のものだけ進む＝待ちは延びるが描ける
  //   - v161 検査5（基準点→postMessage に await 無し）は破らない（待ちは基準点の**前**）

  /** V168 (S-2): 掃除の1周を待つ（走っている周があればそれを待つ。無ければ1周頼む）。 */
  private sweepPass(): Promise<void> {
    if (this.sweepJob) return this.sweepJob;
    return this.sweepSleep();
  }

  /** V168 (S-2): 掃除の進み具合を1回の走査で数える。
   *  @returns n=片づいたコマ数（📌 以外が全部眠っている）／total=全コマ／
   *           outside=**窓の外**でまだ起きているコマ数（0 ならこれ以上は減らない） */
  private sweepProgress(keep: Set<string>): { n: number; total: number; outside: number } {
    let n = 0;
    let outside = 0;
    const frames = this.project.frames;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      let awake = false;
      for (const id of Object.keys(f.layers)) if (!keep.has(id)) { awake = true; break; }
      if (!awake) n++;
      else if (!this.inSleepWindow(i)) outside++;
    }
    return { n, total: frames.length, outside };
  }

  /** V168 (S-1〜S-3): 写す前の見積り → 待ち → 門番。
   *  @returns 写してよい見積り。**断ったときは null**（知らせとログは済ませてある）。 */
  protected async prepareSnapshot(): Promise<{ est: SnapshotEstimate; waited: number; swept: number } | null> {
    const t0 = performance.now();
    const est0 = snapshotBytes(this.project);
    let est = est0;
    const plan = saveSnapshotPlan(est.est);
    let swept = 0;
    if (plan === "sweep" && this.sleepOn) {
      const keep = this.sharedLayerIds();
      let prog = this.sweepProgress(keep);
      const startN = prog.n;
      // ★V213 (M-2a): 「保存の準備…」の表示（数字・止まって見えるときの文言）は画面（PC の savePrepShow）
      this.savePrepShow("begin", prog);
      this.sweepProgressCb = () => {
        prog = this.sweepProgress(keep);
        this.savePrepShow("moved", prog);
      };
      try {
        // ★1周（scanned === total）ごとに条件を見直す。無限には回さない:
        //  (a) est ≤ soft になった (b) 窓の外に起きているコマが無くなった（＝これ以上は減らない）
        //  (c) 画面を離れた——のどれかで抜ける。進みが無かった周（描いている最中は只のものしか
        //  片づかない）は少し間を空ける＝CPU を回し続けない
        for (;;) {
          if (!this.mounted) break;
          if (saveSnapshotPlan(est.est) === "clone") break;
          if (prog.outside === 0) break;
          const before = prog.n;
          await this.sweepPass();
          prog = this.sweepProgress(keep);
          this.savePrepShow("pass", prog);
          est = snapshotBytes(this.project);
          if (prog.n <= before) await new Promise((r) => setTimeout(r, 250));
        }
      } finally {
        this.sweepProgressCb = null;
        this.savePrepShow("end", prog);
      }
      swept = Math.max(0, prog.n - startN);
    }
    const waited = Math.round(performance.now() - t0);
    // S-4: 数値と決まった語だけ（W-10）
    this.cb.appendLog?.(
      `[V168] save prepare est=${est0.est} awake=${est0.awake} sleep=${est0.sleep} audio=${est0.audio} ` +
        `faces=${est0.faces} plan=${plan} waited=${waited}ms swept=${swept} est2=${est.est}`
    );
    this.savePrepShow("save", null);
    if (!saveSnapshotAllowed(est.est)) {
      this.cb.appendLog?.(`[V168] save refused est=${est.est} max=${SAVE_SNAPSHOT_MAX_BYTES}`);
      this.reportSnapshotTooBig(est.est);
      return null;
    }
    return { est, waited, swept };
  }

  /** V168 (S-3): 断る。**何が・いくつ・どうすれば**を1文に。例外にしない（作品は消えていない）。 */
  private reportSnapshotTooBig(est: number): false {
    const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
    const msg =
      t("ed.save.tooBig.msg", { est: gb(est), max: gb(SAVE_SNAPSHOT_MAX_BYTES) }) +
      "\n" +
      t("ed.log.sendHint.msg");
    if (this.cb.notice) void this.cb.notice(msg);
    else this.cb.toast(msg);
    return false; // dirty は true のまま／オートセーブも残したまま（W-6 と同じ）
  }

  // ---------------- ページ／複数ページ・クリップボード（M3.3-B） ----------------

  /** 選択中のコマ（単一 or Shift範囲）をアプリ全体クリップボードへ（非破壊・履歴なし）
   *  V166 (層2): **漏斗を通す。** 1,000コマの範囲コピーは全コマの写し取り＋圧縮で数秒かかる。 */
  async copySelectedFrames() {
    await this.runHeavy("frame.copy", t("ed.heavy.copy.msg"), () => this.copySelectedFramesInner());
  }

  private async copySelectedFramesInner() {
    // 変形/選択移動の浮動中は、切り出されたピクセルが本体に無く欠損コピーになる
    // M10-2c: 四隅変形中は未確定のプレビューをそのままコピーしてしまうので同様に止める
    if (this.xformActive || this.floatBuf || this.cornerActive) {
      this.cb.toast(t("ed.frameclip.xformGuard.toast"));
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
    // ★★V166（独立レビューの指摘・優先度高②）: **コピー側にも見積もりが要る。**
    //  見落としていた: `makeClip` は「選んだコマ × そのコマのレイヤー数」を `copyIndexBuf` する。
    //  1,098コマ×20レイヤーなら **1.57GB**——**貼り付けとまったく同じ量**を、
    //  コピーを押した時点で確保しに行く。事故は貼り付けで出たが、
    //  **コピーでも同じ形で落ちる**（起こす処理もそのぶん展開するので、起こすより先に断る）。
    {
      const need = clipCopyBytes(this.project, idxs);
      if (!this.allowBytes(need, "frame.copy", Math.round(need / Math.max(1, idxs.length)))) return;
    }
    // ★V156 (P-1): 選ばれたコマが眠っていると `makeClip` の `?? allocIndexBuf(p)` が
    // **空バッファを写し取る**（＝真っ白なコマがコピーされる）。読みで起こしてから写す
    if (this.sleepOn) {
      for (const i of idxs) {
        const f = this.project.frames[i];
        if (f) await wakeFrame(this.project, f, "read");
      }
    }
    EditorCore.frameClip = makeClip(this.project, idxs);
    // V156 (P-5): 畳んで持つ。**捨てない**（メモをまたぐ貼り付けは仕様）——
    // 圧縮するだけなので機能はそのまま、抱える量が 20〜30 分の1 になる
    await packClip(EditorCore.frameClip);
    this.updatePasteButton();
    if (this.sleepOn) this.nudgeSweep(); // 起こしたぶんを片付け直す
    // 大きな範囲は保持サイズも明示（静的保持のため）
    const bytes = clipBytes(EditorCore.frameClip);
    const mb = Math.round(bytes / 1024 / 1024);
    const large = bytes > 20 * 1024 * 1024;
    this.cb.toast(
      idxs.length === 1
        ? t("ed.tl.copiedOne.toast")
        : large
          ? t("ed.tl.copiedMultiLarge.toast", { count: idxs.length, mb })
          : t("ed.tl.copiedMulti.toast", { count: idxs.length })
    );
  }

  /** はりつけ: 1枚=現在ページに上書き（うごメモ準拠）／複数=現在コマの後ろに挿入（総集編）
   *
   *  ★V166: **2026-08-31 に落ちたのはここ。** 1,098コマ×20レイヤー（約1.69GB）を
   *  確保しようとして `Array buffer allocation failed`、そのまま連打できたので8回繰り返し、
   *  WebView ごと落ちた。いまは (1) 漏斗で入口が閉じる (2) 確保の前に見積もって断る。 */
  async pasteFrames() {
    await this.runHeavy("frame.paste", t("ed.heavy.paste.msg"), () => this.pasteFramesInner());
  }

  private async pasteFramesInner() {
    const clip = EditorCore.frameClip;
    if (!clip || clip.frames.length === 0) {
      this.cb.toast(t("ed.tl.clipEmpty.toast"));
      return;
    }
    if (this.xformGuard()) return; // E-4: copy側と統一（暗黙キャンセルしない）
    // ★★V166（独立レビューの指摘・優先度高③）: **展開より先に断る。**
    //  見落としていた: `unpackClip` は畳んだクリップを**全部生バッファへ展開する**ので、
    //  1,098コマ×20レイヤーなら**見積もりに来る前に 1.57GB を確保**していた
    //  ——断る意味が無かった。開いたら何バイトになるかは畳んだ側の枚数と幅で分かる
    if (
      !this.allowBytes(
        clipUnpackedBytes(clip),
        "frame.paste.unpack",
        Math.round(clipUnpackedBytes(clip) / Math.max(1, clip.frames.length))
      )
    )
      return;
    // ★独立レビューの指摘・優先度高①: `unpack` したら**必ず**畳み直す。
    //  以前は末尾で `void packClip(clip)` としていたので、漏斗が閉じたあとに再圧縮が走り、
    //  連打防止・予算・例外捕捉の**外**でクリップを書き換え続けていた
    await unpackClip(clip); // V156 (P-5): 畳んであるので開いてから使う
    try {
      await this.pasteFramesBody(clip);
    } finally {
      await packClip(clip); // 使い終わったらまた畳む（static なので抱えっぱなしにしない）
    }
  }

  private async pasteFramesBody(clip: FrameClip) {
    const self = this;
    const bitsBefore = this.project.indexBits;

    if (clip.frames.length === 1) {
      // --- 単ページ: 現在ページに上書き ---
      const frame = this.project.frames[this.frameIndex];
      if (!frame) return;
      // ★V166 (B): 単ページ経路も見積もる（要件 §2-B「単ページ経路にも」）。
      //  **1コマの上書きでも「4コマぶん」を新しく確保する**——数えるとこうなる:
      //   ① `beforeLayers`（全レイヤーぶんの写し・履歴が持ち続ける）
      //   ② `buildFramesFromClip` が組む `built`（全レイヤーぶん）
      //   ③ `afterLayers`（全レイヤーぶんの写し・履歴が持ち続ける）
      //   ④ `restore()` の中で1枚ずつ張り替える `nb = allocIndexBuf`（全レイヤーぶん）
      //  ★**少なく見積もらないこと**が要点。少なく見ると「断るべきものを通す」＝事故が戻る
      //  （V205: ①③④ は 📌 を除いたレイヤーぶんになった〔② の built は今も全部のレイヤーぶん〕が、見積もりは今の数のまま＝📌 も数える多めの側＝安全側）
      if (!this.allowFrameAlloc(4, clip.palette.length, "frame.paste")) return;
      // ★V205 (A-116): 📌（全コマ共通）のレイヤーは差し替えない（複数コマの挿入と同じ＝📌 の位置に来た絵は捨て、
      //  📌 は全コマ同じ実体のまま）。前は全部のレイヤーを新しいバッファに差し替え、relinkShared も呼ばないので、
      //  そのコマだけ 📌 が別の実体になっていた（次に張り直すと 1 コマ目なら全コマが貼った絵に・2 コマ目以降なら貼った絵が消える。
      //  張り直す前に保存すると、開き直したときに 📌 が外れる）。前と後の写し・restore はこの id だけ
      const layerIds = this.project.layerDefs.filter((l) => l.shared !== true).map((l) => l.id);
      // before 退避（色再マップ＝昇格の前に取得。widening は undo 側の alloc+set が担保）
      const beforeLayers: Record<string, IndexBuf> = {};
      for (const id of layerIds)
        beforeLayers[id] = copyIndexBuf(frame.layers[id] ?? allocIndexBuf(this.project));
      const beforePaper = frame.paper;
      const beforeOrder = frame.order ? [...frame.order] : undefined;
      // M5-1（独立レビューの指摘#1）: SE配置も上書き対象（コピー元の配置を貼る・Undoで元の配置へ戻す）
      const beforeSe = frame.se ? [...frame.se] : undefined;
      // V205 (A-113): このコマだけのレイヤーの表示色も上書きの対象（貼ったコマの色に・Undo で貼る前の色へ）
      const beforeColors = frame.layerColors ? { ...frame.layerColors } : undefined;
      // 色再マップ→構築（昇格し得る。関数内で「色解決→確保」順を保証）
      const [built] = buildFramesFromClip(this.project, clip);
      const afterLayers: Record<string, IndexBuf> = {};
      for (const id of layerIds)
        afterLayers[id] = copyIndexBuf(built.layers[id] ?? allocIndexBuf(this.project));
      const afterPaper = built.paper;
      const afterSe = built.se ? [...built.se] : undefined; // 貼り付け先に存在するidのみ（filter済み）
      // V205 (A-113): 貼った色は位置で付いている（buildFramesFromClip）。📌 は差し替えないので、📌 に付いていたこのコマの色はそのまま残す
      const afterColors: Record<string, string> = { ...(built.layerColors ?? {}) };
      for (const ld of this.project.layerDefs)
        if (ld.shared === true && beforeColors?.[ld.id]) afterColors[ld.id] = beforeColors[ld.id];
      const restore = (
        layers: Record<string, IndexBuf>,
        paper: number,
        order: string[] | undefined,
        se: string[] | undefined,
        colors: Record<string, string> | undefined
      ) => {
        for (const id of layerIds) {
          const nb = allocIndexBuf(self.project);
          nb.set(layers[id]);
          frame.layers[id] = nb;
        }
        frame.paper = paper;
        frame.order = order ? [...order] : undefined;
        frame.se = se && se.length > 0 ? [...se] : undefined;
        // V205 (A-113): 表示色は**毎回写しを入れる**（履歴が持つオブジェクトをそのまま入れると、貼ったあとでこのコマの色を変えたとき
        //  〔applyFrameLayerColor はその場で書き換える〕に履歴の中身まで変わる）。無ければキーごと消す
        if (colors && Object.keys(colors).length > 0) frame.layerColors = { ...colors };
        else delete frame.layerColors;
        // ★昇格をまたぐ undo/redo の幅不整合防止（M3.3 ハンドオフ指定）
        conformFrameWidth(self.project, frame);
        self.afterStructuralChange();
        self.updateFilmSeMarks();
        self.updateFilmColorMark(self.project.frames.indexOf(frame)); // V205: コマの帯の色の目印も
        self.redrawOverlay();
      };
      this.history.push({
        colorRefs: () => ({ bufs: [...Object.values(beforeLayers), ...Object.values(afterLayers)], papers: [beforePaper, afterPaper] }), // V195 (A-99)
        label: "ページ貼り付け",
        bytes: entryBytes(beforeLayers, afterLayers), // V154 (W-2)
        undo: () => restore(beforeLayers, beforePaper, beforeOrder, beforeSe, beforeColors),
        redo: () => restore(afterLayers, afterPaper, undefined, afterSe, afterColors),
      });
      restore(afterLayers, afterPaper, undefined, afterSe, afterColors);
      if (bitsBefore === 8 && this.project.indexBits === 16) {
        this.noticePromote16(); // V154 (W-3)
      }
      this.cb.toast(t("ed.frameclip.pastedOne.toast"));
      return; // V166: 畳み直しは呼び出し元の finally（独立レビューの指摘①）
    }

    // --- 複数ページ: 現在コマの後ろに挿入 ---
    const n = clip.frames.length;
    if (this.project.frames.length + n > 65535) {
      this.cb.toast(t("ed.tl.pasteLimit.toast"));
      return;
    }
    // ★V166 (B): **確保する前に**見積もる。ここが事故の急所だった
    //  ——今までの防御は「65,535コマを超えるか」だけで、**1回で確保する量**を見ていなかった。
    //  4,393コマの作品に 1,098コマを貼る操作はコマ数の上限にまったく触れないまま
    //  1.69GB を確保しに行き、確保の途中で落ちた。
    if (!this.allowFrameAlloc(n, clip.palette.length, "frame.paste")) return;
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
    // V154 (W-2): 取り消したコマは履歴が抱える（同上）
    this.history.push({
      colorRefs: () => ({ frames: newFrames }), // V195 (A-99)
      label: "ページ挿入",
      bytesIfUndone: entryBytes(newFrames),
      undo: revert,
      redo: apply,
    });
    apply();
    if (bitsBefore === 8 && this.project.indexBits === 16) {
      this.noticePromote16(); // V154 (W-3)
    }
    this.cb.toast(t("ed.tl.insertedMulti.toast", { count: n }));
    // V166: 畳み直しは呼び出し元の finally（独立レビューの指摘①）
  }

  /** M11-11: 変形ハンドルのキャンバス座標。
   *  M13-2b (T-3): 8ハンドル化。[0..3]=四隅, [4]=回転ノブ, [5]=上辺中央, [6]=右辺中央, [7]=下辺中央, [8]=左辺中央 */
  protected xformHandleWorld(): { x: number; y: number }[] {
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
    return [
      w(-hw, -hh),
      w(hw, -hh),
      w(hw, hh),
      w(-hw, hh),
      w(0, -hh - 12),
      w(0, -hh),
      w(hw, 0),
      w(0, hh),
      w(-hw, 0),
    ];
  }

  /** M11-11: キャンバスの外へ出たハンドルを内側へ寄せた位置。外に出ていなければ null */
  protected clampedHandle(wx: number, wy: number): { x: number; y: number } | null {
    const M = 6; // 端からの余白（ドット）。□の半径 2 より大きくして枠線に潜らせない
    const x = Math.max(M, Math.min(W - M, wx));
    const y = Math.max(M, Math.min(H - M, wy));
    return x === wx && y === wy ? null : { x, y };
  }

  protected activeBuffer(): IndexBuf | null {
    const f = this.project.frames[this.frameIndex];
    if (!f) return null;
    return f.layers[this.activeLayerId] ?? null;
  }

  /** 色を索引に解決する。257色目で16bitへ自動昇格（トースト1回）。
   *  ※ 昇格は全レイヤーバッファを差し替えるため、必ず「色解決 → バッファ取得」の順で使うこと。 */
  protected currentColorIndex(): number {
    if (this.colorHex === "") return 0;
    return this.resolveColorIndex(this.colorHex);
  }

  /** 任意の "#rrggbb" を colorTable の索引へ解決する（無ければ登録。257 色目で 16bit 昇格→トースト）。
   *  M17: マイ柄の各色もここを通す（currentColorIndex と同じ規則・同じトースト）。
   *  ★昇格でバッファが差し替わるので、呼んだ後に activeBuffer() を取り直すこと */
  private resolveColorIndex(hex: string): number {
    const bitsBefore = this.project.indexBits;
    const lenBefore = this.project.colorTable.length;
    const idx = ensureColor(this.project, hex);
    if (bitsBefore === 8 && this.project.indexBits === 16) {
      this.noticePromote16(); // V154 (W-3)
      this.dirty = true;
    } else if (lenBefore >= 65536 && this.project.colorTable[idx] !== hex.toLowerCase()) {
      this.cb.toast(t("ed.color.paletteFull.toast"));
    }
    return idx;
  }

  /** M17: 道具ごとのトーン選択 id を「描画エンジンに渡す形」へ解決する。
   *  - 既存トーン: `{tone, colorTile:null}`（従来どおり）
   *  - マイ柄: `{tone:null, colorTile}`。かすり消しは常に形だけ（全部 0）。🎨オン＝登録色を**全色一括解決**、
   *    オフ＝形として現在色。消えたマイ柄を指していたらベタ（tone null）扱い
   *  ★色を解決する（昇格し得る）ので、**この戻り値を得てから** activeBuffer() を取ること */
  protected resolveToneFor(kind: "pen" | "brush" | "fill" | "eraser"): {
    tone: R.ToneTile | null;
    colorTile: R.ColorTile | null;
  } {
    const id =
      kind === "pen" ? this.penToneId : kind === "brush" ? this.brushToneId : kind === "fill" ? this.fillToneId : this.eraserToneId;
    const cid = CT.parseCustomToneKey(id);
    if (cid !== null) {
      const ct = this.customTones.find((c) => c.id === cid);
      if (ct) {
        if (kind === "eraser") return { tone: null, colorTile: CT.buildColorTile(ct, { color: 0 }) };
        if (this.customToneColor)
          return { tone: null, colorTile: CT.buildColorTile(ct, { resolve: (hex) => this.resolveColorIndex(hex) }) };
        return { tone: null, colorTile: CT.buildColorTile(ct, { color: this.currentColorIndex() }) };
      }
      return { tone: null, colorTile: null }; // 消えたマイ柄＝ベタ
    }
    return { tone: kind === "pen" ? null : (R.toneById(id)?.tile ?? null), colorTile: null };
  }

  protected penOptions(pressure: number): R.PenOptions {
    let size = this.penSize;
    if (this.pressureEnabled && pressure > 0 && pressure !== 0.5) {
      size = Math.max(1, Math.round(this.penSize * (0.4 + pressure * 1.2)));
    }
    let texture = this.texture;
    let tone: R.ToneTile | null | undefined;
    let colorTile: R.ColorTile | null = null;
    let color: number;
    // M17: トーンの解決は「ストローク中は pointerdown で一括解決した strokeTone」を使う（move で再解決しない）。
    // ストローク外（図形の penOptions(0.5) 等）は従来どおりその場で解決。
    // strokeTone は**同じ道具のときだけ**使う（ストローク中にショートカットで道具が変わったら、前の道具の
    // 色タイルを流用しない＝消しゴムが色を塗る事故の防止。setTool でも捨てる）
    const sel = (kind: "pen" | "brush" | "eraser") =>
      this.strokeTone && this.strokeTone.kind === kind ? this.strokeTone : this.resolveToneFor(kind);
    if (this.tool === "eraser") {
      // 消しゴムは色を解決しない（未使用色の登録＝不要な16bit昇格を避ける）
      color = 0;
      texture = "solid";
      // M11-14: かすり消し — ベタ以外のトーンを選んでいたら、柄に当たる画素だけを
      // 透明(0)にする（柄はキャンバス座標固定＝なぞり直しても位相が揃う）。
      // ベタ（tile=null）なら tone を渡さない＝従来の全消しとビット単位で同じ経路
      // M17: マイ柄なら colorTile（全部 0＝形で消す）。既存トーンは従来どおり tone
      const s = sel("eraser");
      tone = s.tone;
      colorTile = s.colorTile;
    } else {
      color = this.currentColorIndex();
      if (this.tool === "brush") {
        // M5-4: ブラシ=うごメモ準拠トーンパターン（座標固定）。ベタ(tile=null)は solid で全塗り
        texture = "solid";
        const s = sel("brush");
        tone = s.tone;
        colorTile = s.colorTile;
        size = Math.max(size, 3);
      } else if (this.tool === "pen" && this.penToneId) {
        // M17: ペンの「種類」でマイ柄を選んでいるとき（"" なら従来どおり texture＝この分岐に入らない）。
        // texture は solid に落とす（点線 "dot" は strokeSegment 側で stamp を間引くので、残すと柄が途切れる）
        texture = "solid";
        colorTile = sel("pen").colorTile;
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
      // M16 (D-1): コマ間シフト（トグルオフや tone なしのときは 0＝従来どおり）
      toneShift: this.toneShiftForDraw(),
      // M17: マイ柄（未使用なら undefined＝従来どおり）
      colorTile: colorTile ?? undefined,
    };
  }

  /** M16 (D-1): いま描くコマのトーン参照座標オフセット。トグルオフなら 0（＝従来と完全一致）。
   *  オンなら **コマ番号 × 斜め定数**（両軸に同量足す＝斜め (+1,+1)/コマ・タイル周期は toneAt 側で折返し）。
   *  📌全コマ共通レイヤーは全コマが1バッファなので f が変わっても同じ画素＝揺れない（仕様・title に明記）。 */
  protected toneShiftForDraw(): number {
    return this.ditherFrameShift ? this.frameIndex * DITHER_SHIFT_STEP : 0;
  }

  /** M10-2a: 変位場を現在のコマの全レイヤーへ適用してプレビューする。
   *  適用元は常に warpBefore（ストローク開始時のスナップショット）で、
   *  直前の適用結果には**絶対に**再適用しない（最近傍サンプルの誤差が積み上がってドットが溶ける）。 */
  protected applyWarpPreview(): void {
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

  /** 四隅モードに入る（transform が setTool で即開始するのと同じ流儀）。
   *
   *  M13-2b (T-1) で**適用先と枠が変わった**（既存の振る舞いの変更・REQ §6-1）:
   *   - 適用先: 全レイヤー（非表示も含む） → **選択中レイヤーだけ**（M13-1 の純関数で解決・非表示は除外）
   *   - 枠    : 選択範囲なしのとき キャンバス全体 → **対象レイヤーの描かれた部分の外接矩形**
   *            （選択範囲ありは従来どおり選択範囲の外接矩形）
   *   - 絵が無ければ `ed.xform.nothingToTransform.toast`（従来は全体の枠が出ていた） */
  private beginCornerWarp(): void {
    if (this.cornerActive) return;
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    const tg = this.transformTargets();
    if (!tg) {
      this.cb.toast(t("ed.xform.nothingToTransform.toast"));
      return;
    }
    // `transformTargets()` のマスク＝選択範囲があればそれ、無ければ対象の合成の非透明画素。
    // その外接矩形が枠になる（選択した部分だけを台形にしたいときに、四隅が絵の近くに出るほうが操作しやすい）
    const bb = R.maskBBox(tg.mask)!;
    const x0 = bb.x;
    const y0 = bb.y;
    const x1 = bb.x + bb.w;
    const y1 = bb.y + bb.h;
    this.cornerRect = { x0, y0, x1, y1 };
    this.cornerPts = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    // 適用元は常にこのスナップショット。**対象レイヤーだけ**を持つ＝それ以外は1画素も触らない
    const snap: Record<string, IndexBuf> = {};
    for (const id of tg.ids) {
      const b = f.layers[id];
      if (b) snap[id] = copyIndexBuf(b);
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
    this.paintUiOverlay();
  }

  /** 四隅から場を作り直して**対象レイヤー**へ適用する。退化していたら何もしない（直前の絵が残る）。
   *  適用元は常に `cornerBefore`（開始時のスナップショット）。直前の適用結果へは再適用しない */
  protected updateCornerPreview(): void {
    if (!this.cornerActive || !this.warpField || !this.cornerBefore || !this.cornerRect)
      return;
    if (!this.warpField.setHomography(this.cornerPts, this.cornerRect)) return;
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    // M13-2b (T-1): cornerBefore に入っているレイヤー＝対象だけ（それ以外は触らない）
    for (const id of Object.keys(this.cornerBefore)) {
      const src = this.cornerBefore[id];
      const dst = f.layers[id];
      if (src && dst) applyWarp(src, dst, this.warpField, this.selMask);
    }
    this.renderCanvas();
    this.redrawOverlay();
    this.paintUiOverlay();
  }

  /** M13-2b (T-1): 四隅モードの8ハンドルの位置。[0..3]=四隅（`cornerPts` そのもの）、[4..7]=辺の中央
   *  （辺 i は点 i と点 (i+1)%4 を結ぶ）。**内部の点は4つのまま**（射影変換は4点で決まる） */
  protected cornerHandles(): { x: number; y: number }[] {
    const p = this.cornerPts;
    if (p.length !== 4) return [];
    const mids = p.map((a, i) => {
      const b = p[(i + 1) % 4];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    });
    return [...p, ...mids];
  }

  /**
   * M13-2b (T-1): 掴んだハンドル `idx` をポインタ `pt` へ動かしたときの新しい4点。
   *  - 四隅（0..3）: その1点をポインタへ（従来どおり。キャンバス内にクランプ）
   *  - 辺（4..7）  : ドラッグ量を**その辺の法線へ射影**し、両端2点へ同じだけ足す＝辺が平行に動く。
   *                  辺の方向の成分は捨てる（せん断は四隅で。REQ §8-1 暫定案）
   *  `base` はドラッグ開始時の4点、`start` はそのときのポインタ。**開始時からの差分で毎回作り直す**
   *  （前回の位置に足し込んでいくと、辺の法線がずれていって平行でなくなる）。
   *  非凸になる／キャンバスの外へ出る結果は null（＝受け付けない・直前の位置に留まる）
   */
  protected cornerTrial(
    idx: number,
    base: { x: number; y: number }[],
    start: { x: number; y: number },
    pt: { x: number; y: number }
  ): { x: number; y: number }[] | null {
    let trial: { x: number; y: number }[];
    if (idx < 4) {
      const nx = Math.max(0, Math.min(W, pt.x));
      const ny = Math.max(0, Math.min(H, pt.y));
      trial = base.map((p, i) => (i === idx ? { x: nx, y: ny } : p));
    } else {
      const a = idx - 4;
      const b = (a + 1) % 4;
      const ex = base[b].x - base[a].x;
      const ey = base[b].y - base[a].y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-6) return null;
      // 法線（辺に垂直な単位ベクトル）。向きはどちらでもよい＝射影で符号が決まる
      const nx = -ey / len;
      const ny = ex / len;
      const d = (pt.x - start.x) * nx + (pt.y - start.y) * ny;
      const mx = d * nx;
      const my = d * ny;
      trial = base.map((p, i) => (i === a || i === b ? { x: p.x + mx, y: p.y + my } : p));
      if (trial.some((p) => p.x < 0 || p.x > W || p.y < 0 || p.y > H)) return null;
      // 辺を対辺の**向こう側**まで押し込むと、四角形は凸のまま**裏返る**（`isConvexQuad` は向きを見ない）。
      // そのまま通すと絵が鏡映になるので、符号付き面積の符号が変わる移動も受け付けない
      const area = (q: { x: number; y: number }[]) =>
        q.reduce((s, p, i) => s + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0);
      if (Math.sign(area(trial)) !== Math.sign(area(base))) return null;
    }
    // 非凸になる移動は**受け付けない**。受け付けると消失線が矩形の内側に入り、
    // 分母 w が 0 を跨いで写像が発散する（絵が壊れて Esc しか復帰手段が無くなる）
    return isConvexQuad(trial) ? trial : null;
  }

  /** Enter=確定。ここで初めて履歴に積む（それまでは1件も積まない） */
  /** V166 (層2): 四隅の歪みの確定。対象レイヤーぶんの全画素比較＋控えが動く。 */
  protected async commitCornerWarp(): Promise<void> {
    await this.runHeavy("warp.commit", t("ed.heavy.warp.msg"), () => this.commitCornerWarpInner());
  }

  private commitCornerWarpInner(): void {
    const before = this.cornerBefore;
    const f = this.project.frames[this.frameIndex];
    if (!before || !f) {
      this.endCornerWarp();
      return;
    }
    // **変化のあったレイヤーだけ** before/after を積む（M10-2a と同じ流儀）。
    // M13-2b (T-1): 見るのは対象（before に入っているレイヤー）だけ
    const bd: Record<string, IndexBuf> = {};
    const ad: Record<string, IndexBuf> = {};
    let changed = false;
    for (const id of Object.keys(before)) {
      const b = before[id];
      const a = f.layers[id];
      if (!b || !a) continue;
      let diff = false;
      for (let i = 0; i < PIXELS; i++)
        if (a[i] !== b[i]) {
          diff = true;
          break;
        }
      if (!diff) continue;
      bd[id] = b;
      ad[id] = copyIndexBuf(a);
      changed = true;
    }
    if (changed) {
      // frameIndex は**キャプチャした値**で引く（確定後にコマが移動しても正しいコマへ戻すため）
      const fi = this.frameIndex;
      const cornerEntry = multiBufferChangeEntry(
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
      );
      // ★V180 (A-78 ②): 取り消し・やり直しの前に、そのコマを**書きで起こす**（V178 の全レイヤー消しゴムと同じ形）。
      //  大きい作品で窓の外へ出て眠ったコマは `layers[id]` が無く、起こさないと Ctrl+Z が黙って空振りする。
      //  コマ番号で持つので、そのコマが無ければ何もしない（例外を投げない）
      cornerEntry.prepare = () => {
        const fr = this.project.frames[fi];
        return fr ? wakeFrame(this.project, fr, "write") : Promise.resolve();
      };
      this.history.push(cornerEntry);
      // M10-23 レビュー検出の既存バグ: 確定時に dirty を立てておらず、四隅変形だけでは
      // オートセーブも終了警告も働かなかった（歪みストローク確定と同じ流儀に揃える）
      this.dirty = true;
    }
    this.endCornerWarp();
    this.paintFilmThumb(this.frameIndex);
  }

  /** Esc=取消。全画素をスナップショットへ完全復元し、履歴は1件も積まない。
   *  `silent` は unmount 経由用（DOM が消えかけているので UI 更新を呼ばない） */
  protected cancelCornerWarp(silent = false): void {
    const before = this.cornerBefore;
    const f = this.project.frames[this.frameIndex];
    if (before && f)
      for (const id of Object.keys(before)) {
        const b = before[id];
        const a = f.layers[id];
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
    this.cornerDragBase = null;
    this.warpField = null;
    this.muteFloatingOverlays(false);
    if (!silent) this.paintUiOverlay(); // M13-2b (T-6): 枠・ハンドルの層を消す
    // 確定/取消のあとモードを「押す」へ戻す。`endTransform` が tool を pen へ戻すのと同じ流儀。
    // 戻さないと warpMode==="corner" のまま cornerActive===false という**死んだモード**が残り、
    // 同じボタンをもう一度押しても（next===warpMode で早期 return するので）何も起きなくなる
    if (this.warpMode === "corner") this.warpMode = "push";
    if (silent) return;
    this.updateXformBadge();
    this.buildToolOptions();
    this.redrawOverlay();
  }

  /** M10-2b: 魚眼を1段階かけてプレビューする。符号はモードが決める（P-5） */
  protected stepFisheye(): void {
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
  protected scheduleFisheyeRepeat(delayMs: number): void {
    this.clearFisheyeRepeat();
    this.warpTimer = setTimeout(() => {
      this.warpTimer = null;
      // タイマー側でも状態を毎回見る二重ガード（後始末が1つ漏れても暴走しない）
      if (!this.pointerDown || this.tool !== "warp" || !this.warpField) return;
      if (this.warpMode !== "bulge" && this.warpMode !== "pinch") return;
      this.stepFisheye();
      this.scheduleFisheyeRepeat(90);
    }, delayMs);
  }

  protected clearFisheyeRepeat(): void {
    if (this.warpTimer !== null) {
      clearTimeout(this.warpTimer);
      this.warpTimer = null;
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
  protected shapeEnd(b: { x: number; y: number }): { x: number; y: number } {
    if (!this.shiftHeld || !this.shapeStart) return b;
    return this.constrainShapeEnd(this.shapeStart, b, this.shapeKind);
  }

  /** M10-7: ドラッグ中に Shift が押された/離されたときだけプレビューを引き直す。
   *  図形ツールでドラッグ中でなければ**何もしない**（他の Shift 機能に干渉しない） */
  protected refreshShapePreview(): void {
    if (this.tool !== "shape" || !this.pointerDown) return;
    if (!this.shapeStart || !this.shapeLastPt) return;
    this.previewShape(this.shapeStart, this.shapeEnd(this.shapeLastPt));
  }

  // ---------------- 選択の移動/コピー ----------------

  private selMoveBefore: IndexBuf | null = null;

  // ---------------- M11-8 P-1: 選択範囲（枠）だけの移動 ----------------
  // 選択範囲ツールで範囲内をドラッグしても**絵は動かさない**。動くのは点線の枠だけ。
  // 枠は画面外へ出てよい（`base` + dx/dy を保持し、見えている分だけを selMask に materialize
  // するので、外へ出して戻せば形が復活する）。完全に外へ出たまま離したら解除する。
  protected selMaskDrag: {
    start: { x: number; y: number };
    /** 掴んだ時点のマスク（これを平行移動して毎回作り直す） */
    base: Uint8Array;
    /** 履歴用の before */
    before: Uint8Array;
    dx: number;
    dy: number;
  } | null = null;

  protected beginSelMaskMove(pt: { x: number; y: number }) {
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

  protected updateSelMaskMove(pt: { x: number; y: number }) {
    const d = this.selMaskDrag;
    if (!d) return;
    d.dx = pt.x - d.start.x;
    d.dy = pt.y - d.start.y;
    this.selMask = this.shiftedMask(d.base, d.dx, d.dy);
    this.redrawOverlay();
  }

  /** M11-8: ドラッグ中の Escape ＝この移動だけ取り消す（掴んだ時点の枠へ戻す・履歴は積まない） */
  protected cancelSelMaskMove() {
    const d = this.selMaskDrag;
    if (!d) return;
    this.selMaskDrag = null;
    this.dragMode = "";
    this.selMask = d.before;
    this.redrawOverlay();
  }

  protected commitSelMaskMove() {
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
  protected layerDrag: {
    start: { x: number; y: number };
    ids: string[];
    before: Record<string, IndexBuf>;
    /** 掴んだ時点のコマ。ドラッグ中に表示コマが変わっても**掴んだコマだけ**を書き換える */
    frameIdx: number;
    dx: number;
    dy: number;
  } | null = null;

  /**
   * M13-1: いま動かす対象のレイヤー id。
   * 判定そのものは `layerTree.ts` の純関数（`m37_smoke` が展開・重複除去・非表示除外を検証する）。
   * ここは UI 状態を渡すだけの薄い橋。**対象は掴んだ時点で確定**する
   *（ドラッグ中に選択を変えても対象は変わらない＝表示コマを変えても掴んだコマだけ書き換える既存の流儀と揃える）。
   */
  private moveTargetLayerIds(): string[] {
    return computeMoveTargetLayerIds(
      this.project,
      this.selectedNodeIds,
      this.activeLayerId,
      this.frameIndex
    );
  }

  protected beginLayerMove(pt: { x: number; y: number }) {
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    // 純関数側で「そのコマにバッファが無いもの」まで落としているので、ここでの再フィルタは不要
    const ids = this.moveTargetLayerIds();
    if (ids.length === 0) {
      this.cb.toast(t("ed.layer.move.noTarget.toast"));
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

  protected updateLayerMove(pt: { x: number; y: number }) {
    const d = this.layerDrag;
    if (!d) return;
    d.dx = pt.x - d.start.x;
    d.dy = pt.y - d.start.y;
    this.applyLayerMove(d.dx, d.dy);
    this.renderCanvas();
  }

  /** M11-8: ドラッグ中の Escape ＝この移動だけ取り消す（掴んだ時点の絵へ戻す・履歴は積まない） */
  protected cancelLayerMove() {
    const d = this.layerDrag;
    if (!d) return;
    this.applyLayerMove(0, 0);
    this.layerDrag = null;
    this.dragMode = "";
    this.renderCanvas();
    this.paintFilmThumb(d.frameIdx);
    this.refreshSelectionLauncher();
  }

  protected commitLayerMove() {
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
    const moveEntry = multiBufferChangeEntry(
      "レイヤーの移動",
      (id) => this.project.frames[frameIdx]?.layers[id] ?? null,
      d.before,
      after,
      () => {
        // ★V180（指示からの追加・独立レビュー 1 回目の穴から見つけた漏れ）: Undo/Redo もデータ変更なので dirty（M10-23 と同じ）。
        //  これだけ立てていなかったので、保存した直後にレイヤーの移動を取り消しても未保存の印が立たず、
        //  オートセーブも終了時の確認も働かなかった（Node 実測: 取り消し・やり直しのあと dirty=false のまま）
        this.dirty = true;
        this.renderCanvas();
        this.redrawOverlay();
        this.paintFilmThumb(frameIdx);
      }
    );
    // ★V180 (A-78 ②): 取り消し・やり直しの前に、そのコマを書きで起こす（眠っていると黙って空振りする）。
    //  コマ番号で持つので、そのコマが無ければ何もしない（例外を投げない）
    moveEntry.prepare = () => {
      const fr = this.project.frames[frameIdx];
      return fr ? wakeFrame(this.project, fr, "write") : Promise.resolve();
    };
    this.history.push(moveEntry);
    this.dirty = true;
    this.renderCanvas();
    this.paintFilmThumb(frameIdx);
    this.refreshSelectionLauncher();
  }

  protected beginSelectionMove(pt: { x: number; y: number }) {
    if (this.lockGuard()) return; // V157 (D-1)
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

  protected updateSelectionMove(pt: { x: number; y: number }) {
    if (!this.dragStart) return;
    this.xform.tx = pt.x - this.dragStart.x;
    this.xform.ty = pt.y - this.dragStart.y;
    this.redrawSelMovePreview();
  }

  protected commitSelectionMove() {
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
    this.clearOverlay();
    this.renderCanvas();
    this.redrawOverlay();
    this.paintFilmThumb(this.frameIndex);
  }

  protected copySelection(cut: boolean) {
    // V157 (D-1): **コピーは通す**（絵は変わらない）。切り取りだけロックで弾く
    if (cut && this.lockGuard()) return;
    const buf = this.activeBuffer();
    if (!buf || !this.selMask) {
      this.cb.toast(t("ed.sel.needSelection.toast"));
      return;
    }
    const before = cut ? copyIndexBuf(buf) : null;
    const f = R.extractFloat(buf, this.selMask, cut);
    if (!f) return;
    EditorCore.clipboard = f;
    this.lastCopy = "sel"; // V199 (A-105): Ctrl+V は最後にコピーしたほう（切り取りも範囲のコピー）
    if (cut && before) {
      // M10-22: マスク自体は切り取りで変化しないが、undo/redo でその時点の選択状態へ
      // 揃うように（時系列の一貫性）バッファと同じ1エントリに束ねる
      const selNow = this.selMask ? this.selMask.slice() : null;
      this.pushBufferHistory("切り取り", buf, before, { before: selNow, after: selNow });
      this.renderCanvas();
      this.paintFilmThumb(this.frameIndex);
    }
    this.cb.toast(cut ? t("ed.sel.cut.done.toast") : t("ed.sel.copy.done.toast"));
  }

  protected pasteClipboard() {
    if (!EditorCore.clipboard) {
      this.cb.toast(t("ed.sel.paste.empty.toast"));
      return;
    }
    // 16bitプロジェクト由来のクリップボード（索引255超を含み得る）を8bitプロジェクトへ
    // 貼る場合は、truncate を避けるため先にプロジェクトを昇格させる
    if (
      EditorCore.clipboard.data instanceof Uint16Array &&
      this.project.indexBits === 8 &&
      EditorCore.clipboard.data.some((v) => v > 255)
    ) {
      promoteTo16(this.project);
      this.noticePromote16(); // V154 (W-3)
      this.dirty = true;
    }
    // 貼り付け → 変形モードで位置決め
    this.floatBuf = {
      ...EditorCore.clipboard,
      data: copyIndexBuf(EditorCore.clipboard.data),
    };
    this.selMask = null;
    this.xform = { tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, flipH: false, flipV: false };
    this.xformInitial = { ...this.xform }; // L-B
    this.xformActive = true;
    this.xformBefore = copyIndexBuf(this.activeBuffer()!);
    this.xformCutDone = false;
    // M13-2b: 貼り付けは従来どおり**アクティブ1枚**（REQ §3「貼り付けの複数レイヤー化はしない」）
    this.xformLayers = [{ id: this.activeLayerId, float: this.floatBuf, before: this.xformBefore }];
    this.tool = "transform";
    this.updateToolButtons();
    this.buildToolOptions();
    this.redrawOverlay();
    this.paintUiOverlay();
  }

  // ---------------- M8-2: 📷 画像配置（変換結果→浮動→変形経路を流用） ----------------

  /** モーダルの「配置先: …」表示用（アクティブレイヤー名＋現在コマ番号） */
  placementInfo(): { layerName: string; frameNo: number } {
    const ld = this.project.layerDefs.find((l) => l.id === this.activeLayerId);
    return { layerName: ld?.name ?? t("ed.img.place.noLayerName.label"), frameNo: this.frameIndex + 1 };
  }

  /** 変換済み1ページ（imageConvert の出力 Project）をアクティブレイヤーへ浮動配置する。
   *  色索引の不変条件（N-2/M3.3 の作法）:
   *  ①使用色の ensureColor を**全部先に**済ませる（途中で16bit昇格し得るため）
   *  ②昇格後の幅で allocIndexBuf → remap 書き込み
   *  ③あとは pasteClipboard と同一の浮動＋変形モード（Enter焼き込み/Esc/Undo規則は既存のまま） */
  placeConvertedImage(src: Project, transparentPaper: boolean) {
    const active = this.activeBuffer();
    if (!active) {
      this.cb.toast(t("ed.img.place.noLayer.toast"));
      return;
    }
    if (this.xformActive) {
      this.cb.toast(t("ed.img.place.xformBusy.toast"));
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
      this.noticePromote16(); // V154 (W-3)
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
    this.xformLayers = [{ id: this.activeLayerId, float: this.floatBuf, before: this.xformBefore }]; // M13-2b: 1枚
    this.tool = "transform";
    this.updateToolButtons();
    this.buildToolOptions();
    this.redrawOverlay();
    this.paintUiOverlay();
    this.cb.toast(t("ed.img.place.done.toast"));
  }

  /** V151 (M8-3): 変換済み複数コマ（imageConvert の出力 Project）を**今のコマの後ろへ挿入**する（連番一括）。
   *  - 色索引の不変条件は placeConvertedImage と同じ: ①全コマの使用色を ensureColor で**全部先に**解決
   *    （途中で16bit昇格し得る）→ ②昇格後の幅で確保・remap。パレットは src が全コマ共通（convertToProject の既定）
   *  - 挿入・履歴・上限ガードは pasteFrames の複数ページ挿入と同じ作法（Undo 1回で N コマ全部戻る）
   *  - 変形は通さない（「おさめ方」に従った自動配置のまま焼く）。挿入されるコマは通常のコマと同一バイト */
  async placeConvertedFrames(src: Project, transparentPaper: boolean) {
    // V166 (層2): 連番一括は N コマぶんを一度に確保する＝貼り付けと同じ重さ
    await this.runHeavy("image.frames", t("ed.heavy.imageFrames.msg"), () =>
      this.placeConvertedFramesInner(src, transparentPaper)
    );
  }

  private placeConvertedFramesInner(src: Project, transparentPaper: boolean) {
    const active = this.activeBuffer();
    if (!active) {
      this.cb.toast(t("ed.img.place.noLayer.toast"));
      return;
    }
    if (this.xformActive) {
      this.cb.toast(t("ed.img.place.xformBusy.toast"));
      return;
    }
    const ld = this.project.layerDefs.find((l) => l.id === this.activeLayerId);
    if (ld?.shared === true) {
      // 📌全コマ共通レイヤーは全コマが1バッファ＝コマごとに違う絵を持てない。
      // 挿入後の relinkShared で絵が黙って消えるので、先に断る
      this.cb.toast(t("ed.img.place.sharedBlocked.toast"));
      return;
    }
    const n = src.frames.length;
    if (this.project.frames.length + n > 65535) {
      this.cb.toast(t("ed.tl.pasteLimit.toast")); // pasteFrames と同じ上限ガード
      return;
    }
    // V166 (B): pasteFrames と同じ見積もり。★連番画像は**元画像のパレットを丸ごと持ち込む**ので、
    //  16bit 昇格が起こり得る（独立レビューの指摘④）。持ち込む色数を渡して幅を決めさせる
    if (!this.allowFrameAlloc(n, src.colorTable.length, "image.frames")) return;
    if (this.playing) this.stopPlayback();
    // ① 全コマの使用色を一括解決（透過ONなら紙色一致の画素は登録しない＝パレット汚染防止・1枚版と同じ規則）
    const paperHex = (src.colorTable[src.frames[0].paper] || "#ffffff").toLowerCase();
    const used = new Set<number>();
    for (const f of src.frames) {
      const b = f.layers["L1"];
      for (let i = 0; i < PIXELS; i++) if (b[i] > 0) used.add(b[i] as number);
    }
    const bitsBefore = this.project.indexBits;
    const map = new Map<number, number>();
    for (const si of used) {
      const hex = src.colorTable[si].toLowerCase();
      if (transparentPaper && hex === paperHex) continue;
      map.set(si, ensureColor(this.project, hex));
    }
    let paperIdx = 0;
    if (!transparentPaper) paperIdx = ensureColor(this.project, paperHex);
    if (bitsBefore === 8 && this.project.indexBits === 16) {
      this.noticePromote16(); // V154 (W-3)
      this.dirty = true;
    }
    // ② 昇格後の幅で新コマを組む（紙は今のコマを継承・アクティブレイヤーへ remap・他レイヤーは空）
    const curPaper = this.project.frames[this.frameIndex]?.paper ?? 1;
    const activeId = this.activeLayerId;
    const newFrames = src.frames.map((sf) => {
      const nf = makeEmptyFrame(this.project, curPaper);
      const data = nf.layers[activeId] ?? allocIndexBuf(this.project);
      const sb = sf.layers["L1"];
      for (let i = 0; i < PIXELS; i++) {
        const si = sb[i] as number;
        if (si > 0) data[i] = map.get(si) ?? 0;
        else data[i] = paperIdx; // 透過ONは 0 のまま＝紙が透ける（1枚版と同じ）
      }
      nf.layers[activeId] = data;
      return nf;
    });
    // ③ 挿入（pasteFrames の複数ページ挿入と同じ履歴単位・redo は昇格跨ぎを正規化）
    const at = this.frameIndex + 1;
    const self = this;
    const apply = () => {
      for (const f of newFrames) conformFrameWidth(self.project, f);
      self.project.frames.splice(at, 0, ...newFrames);
      self.frameIndex = at; // 挿入した最初のコマへ移動
      self.afterFrameStructureChange();
    };
    const revert = () => {
      self.project.frames.splice(at, n);
      self.frameIndex = Math.min(at - 1, self.project.frames.length - 1);
      self.afterFrameStructureChange();
    };
    // V154 (W-2): 取り消したコマは履歴が抱える（同上）
    this.history.push({
      colorRefs: () => ({ frames: newFrames }), // V195 (A-99)
      label: "連番挿入",
      bytesIfUndone: entryBytes(newFrames),
      undo: revert,
      redo: apply,
    });
    apply();
    this.cb.toast(t("ed.tl.insertedMulti.toast", { count: n }));
  }

  /** 選択範囲の中を消す。**選択は維持する**（M11-9 P-3）。
   *  Delete / Backspace・側パネルの「削除」・ランチャーの「消去」の3つの入口が
   *  同じ結果になるよう、実体はこの1つだけにしてある。
   *  M10-22 では「画素の削除とマスク解除を1エントリに束ねる」形だったが、
   *  解除しなくなったので履歴には**画素の変化だけ**を積む */
  /**
   * M13-2a (A-1): 新しく作った範囲 `next` を、ドラッグ開始時の修飾キー（`selMod`）に従って
   * いまの選択へ合成する。矩形・自由・自動の**3つがすべてここを通る**。
   *   replace … 置き換え（従来どおり）
   *   add     … 和（`|`）
   *   sub     … 差（`& ~`）
   * 結果が全0なら**選択解除として扱う**（既存の流儀。1px の見えない選択で clip が全描画を封じる事故の防止）。
   * 履歴は従来どおり `pushSelectionHistory(before, after)` の1エントリ＝Undo 1回で前の範囲へ戻る。
   * `Uint8Array` の 0/1 を触るだけで索引バッファには一切触れない。
   */
  protected applySelectionResult(kind: "auto" | "drag", next: Uint8Array) {
    const before = this.selMask ? this.selMask.slice() : null;
    let out = next;
    if (this.selMod !== "replace" && this.selMask) {
      out = new Uint8Array(PIXELS);
      const cur = this.selMask;
      if (this.selMod === "add") {
        for (let i = 0; i < PIXELS; i++) out[i] = cur[i] | next[i];
      } else {
        for (let i = 0; i < PIXELS; i++) out[i] = cur[i] & (next[i] ^ 1);
      }
    } else if (this.selMod === "sub") {
      // 何も選んでいない所から引く＝引く相手が無い。選択は無いまま（履歴にも積まない）
      return;
    }
    const empty = !out.some((v) => v !== 0);
    this.selMask = empty ? null : out;
    // 変化が無いなら履歴に積まない（同じ範囲を足し直した等）
    if (before && !empty && before.length === out.length && before.every((v, i) => v === out[i])) return;
    if (!before && empty) return;
    // 履歴ラベルは画面に出ない内部識別子（検査5 が `pushSelectionHistory` の第1引数として見逃す形に置く）
    this.pushSelectionHistory(kind === "auto" ? "自動選択" : "範囲選択", before, empty ? null : out.slice());
    if (empty && before) this.cb.toast(t("ed.sel.becameEmpty.toast"));
  }

  /**
   * M13-2a (A-1): 自動選択の参照「選択中」＝選択中のレイヤーを合成した索引バッファ。
   * 対象の解決は M13-1 の純関数（`moveTargetLayerIds`）と同じ規則＝フォルダは展開・重複は除去・
   * 実効可視が false は除外・レイヤーを1枚だけ選んでいるとき（何も選んでいないときも）は描いているレイヤー（`activeLayerId`）
   * ＝ゆらゆらと同じ（V206・A-115）。0件（描いているレイヤーが隠れている・🔒 など）なら `activeBuffer()`。
   * 合成は「レイヤー順（下→上）で非0が勝つ」だけ。クリッピングは見ない＝**1枚だけなら
   * 従来の `activeBuffer()` とビット単位で同じ**（既存の流儀を変えない）。
   * 値は索引のコピーだけ。色計算・補間・平均・ブレンドはしない（IndexBuf の掟）。
   */
  protected flattenSelectedLayers(): IndexBuf | null {
    const ids = this.moveTargetLayerIds();
    const frame = this.project.frames[this.frameIndex];
    if (!frame) return null;
    if (ids.length === 1) return frame.layers[ids[0]] ?? null;
    if (ids.length === 0) return this.activeBuffer();
    const want = new Set(ids);
    const out = allocIndexBuf(this.project);
    for (const ld of this.project.layerDefs) {
      if (!want.has(ld.id)) continue;
      const lb = frame.layers[ld.id];
      if (!lb) continue;
      for (let i = 0; i < PIXELS; i++) if (lb[i] !== 0) out[i] = lb[i];
    }
    return out;
  }

  /**
   * M13-2a (A-3): 選択範囲を**いまの色**で塗る。この回の目玉。
   *  - 対象は**アクティブレイヤー1枚**（既存の塗りツールと同じ流儀。複数レイヤーには塗らない）
   *  - 選択マスクの立っている位置へ**現在の色の索引を書き込むだけ**（補間・平均・ブレンドはしない）
   *  - 現在の色が「透明」（`colorHex === ""` → 索引0）なら、範囲が消える（`ed.sel.erase` と同じ結果でよい）
   *  - ⚠ **色の解決を先に、バッファの取得を後に**（257色目で16bitへ昇格すると全バッファが差し替わる）
   *  - 履歴1エントリ。変化ゼロなら積まない（`deleteSelection` と同じ作法）
   */
  /** M14 (S-4): A-3（v1.4.2）の「選択マスクを現在色で塗る」エンジンを一般化したもの。
   *  「🪣 今の色で塗る」ボタンは M14 で廃止したが、この塗り込みエンジンは**囲い塗り（S-2）が使う**ので残す。
   *  - `mask`: 塗る範囲（0/1）。囲い塗りは lassoMask、選択塗りは selMask を渡す
   *  - `tone`: トーン柄（null=ベタ）。バケツと同じく**キャンバス座標固定**で toneAt 判定（＝同座標で同柄）
   *  - 現在色が透明（index 0）なら消える（消し囲い）。索引の置き換えのみ・中間色は作らない。Undo 1回。
   *  色解決（currentColorIndex）は 257 色目で 16bit 昇格しバッファを差し替え得るので**先に解決**する（A-3 と同じ注意）。 */
  protected fillMaskWithCurrentColor(
    mask: Uint8Array,
    sel: { tone: R.ToneTile | null; colorTile: R.ColorTile | null },
    toneShift = 0
  ) {
    if (this.xformGuard()) return;
    if (this.playing) this.stopPlayback();
    // ★順序: sel（マイ柄の全色）は呼び出し側が解決済み → 現在色を解決 → それからバッファ（昇格で差し替わるため）
    const color = this.currentColorIndex(); // 昇格し得るので先に解決（バケツ・A-3 と同じ順）
    const buf = this.activeBuffer();
    if (!buf) return;
    if (sel.colorTile) {
      // M17: マイ柄（色タイル）。変化ゼロなら履歴に積まない（従来と同じ作法）
      const before = copyIndexBuf(buf);
      if (!CT.applyColorTile(buf, mask, sel.colorTile, toneShift)) return;
      this.pushBufferHistory("囲い塗り", buf, before);
      this.renderCanvas();
      this.redrawOverlay();
      this.paintFilmThumb(this.frameIndex);
      return;
    }
    const tone = sel.tone;
    const hit = (i: number): boolean =>
      mask[i] !== 0 && (!tone || R.toneAt(tone, i % W, (i / W) | 0, toneShift)); // M16 (D-1): コマ間シフト
    let changed = false;
    for (let i = 0; i < PIXELS; i++) {
      if (hit(i) && buf[i] !== color) {
        changed = true;
        break;
      }
    }
    if (!changed) return; // 変化ゼロは履歴に積まない（deleteSelection と同じ作法）
    const before = copyIndexBuf(buf);
    for (let i = 0; i < PIXELS; i++) if (hit(i)) buf[i] = color;
    this.pushBufferHistory("囲い塗り", buf, before); // 履歴ラベル（画面に出ない内部識別子・検査5 除外）
    this.renderCanvas();
    this.redrawOverlay();
    this.paintFilmThumb(this.frameIndex);
  }

  protected deleteSelection() {
    if (this.lockGuard()) return; // V157 (D-1)
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

  /** M11-19: 線を太らせる／細らせる（1px モルフォロジー）。**3つの入口（ランチャー・サイドパネル・
   *  コマンド）の唯一の実体**。対象はアクティブレイヤーの現在コマ、選択範囲があれば範囲内だけ
   *  （入口によらず同じ規則）。規則は raster.ts thickenIndex / thinIndex（色番号コピーと透明化だけ）。
   *  undo 1回（pushBufferHistory）・**変化ゼロは履歴に積まない**（deleteSelection と同じ作法） */
  protected morphActiveLayer(kind: "thicken" | "thin") {
    if (this.xformGuard()) return; // 変形/歪み/浮動の未確定は先に確定させる（他の編集と同じ）
    if (this.playing) this.stopPlayback();
    const buf = this.activeBuffer();
    if (!buf) {
      this.cb.toast(t("ed.common.needLayer.toast"));
      return;
    }
    const before = copyIndexBuf(buf); // src（読むだけ）。live の buf を dst にする
    const t0 = performance.now();
    const changed =
      kind === "thicken"
        ? R.thickenIndex(before, buf, this.selMask)
        : R.thinIndex(before, buf, this.selMask);
    const ms = performance.now() - t0;
    if (this.inputLog) {
      this.inputLogBuf.push(`[inputlog] morph ${kind} changed=${changed} ${ms.toFixed(2)}ms`);
      this.flushInputLogSoon();
    }
    if (changed === 0) {
      this.cb.toast(
        kind === "thicken" ? t("ed.linew.thicken.none.toast") : t("ed.linew.thin.none.toast")
      );
      return;
    }
    this.pushBufferHistory(kind === "thicken" ? "太らせる" : "細らせる", buf, before);
    this.renderCanvas();
    this.paintFilmThumb(this.frameIndex);
  }
  /** 外接矩形のキャッシュ（マスクの実体が変わったときだけ再計算＝毎回の全画素走査を避ける） */
  private selBBoxCache: {
    mask: Uint8Array;
    box: { x: number; y: number; w: number; h: number } | null;
  } | null = null;

  protected selBBox(): { x: number; y: number; w: number; h: number } | null {
    if (!this.selMask) return null;
    if (this.selBBoxCache && this.selBBoxCache.mask === this.selMask) return this.selBBoxCache.box;
    const box = R.maskBBox(this.selMask);
    this.selBBoxCache = { mask: this.selMask, box };
    return box;
  }

  /** ランチャーの8操作。すべて1操作＝履歴1エントリ */
  protected selOp(op: string) {
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
      case "thicken":
        this.morphActiveLayer("thicken"); // M11-19: 範囲内だけ太らせる（3入口共通の実体）
        break;
      case "thin":
        this.morphActiveLayer("thin");
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
    if (empty) this.cb.toast(t("ed.sel.becameEmpty.toast"));
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
      this.cb.toast(t("ed.sel.toLayer.noContent.toast"));
      return;
    }
    const id = newLayerId(this.project);
    // 「1つ上」＝ソースレイヤーの直上。親は**ソースと同じフォルダ**（REQ）
    const parent = this.project.layerDefs[idx].parent;
    const def: LayerDef = {
      id,
      name: `${layerBaseName()}${this.project.layerDefs.length + 1}`, // addLayer と同じ規則
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
      // M11-20 レビュー: 閉じ込めた def は「作成直後の雛形」として扱い、**コピー**を挿入する。
      // 同一オブジェクトを入れると、履歴（clip トグル＝id 解決で配列内の実体を書く）と restoreStructure
      //（配列をクローンに差し替える）を跨いだとき、孤児になった def が古い clip/parent を抱えたまま
      // redo で復活してしまう（addLayer / pasteLayerToNew も同じ）
      self.project.layerDefs.splice(insertAt, 0, { ...def });
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
        dropLayer(f, id); // V156: 眠っているぶん（f.sleep）も一緒に消す
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
      colorRefs: () => ({ bufs: [beforeSrc] }) /* mask は 0/1（色ではない）なので入れない */, // V195 (A-99)
      label: cut ? "切り取って新規レイヤー" : "コピーして新規レイヤー",
      bytes: entryBytes(beforeSrc, mask), // V154 (W-2)
      // ★V180 (A-78 ②・指示からの追加): 元のレイヤーが眠っていると `s` が無く、取り消しでは切り取った絵が
      //  元へ戻らないまま新しいレイヤーだけ外れて**絵が消え**、やり直しでは新しいレイヤーが空になる（Node 実測）。
      //  取り消し・やり直しの前にそのコマを書きで起こす。コマ番号で持つので、そのコマが無ければ何もしない
      prepare: () => {
        const fr = self.project.frames[frameIdx];
        return fr ? wakeFrame(self.project, fr, "write") : Promise.resolve();
      },
      undo: revert,
      redo: apply,
    });
    apply();
    this.cb.toast(cut ? t("ed.sel.cutToLayer.done.toast") : t("ed.sel.copyToLayer.done.toast"));
  }

  // ---------------- 変形 ----------------

  private xformBefore: IndexBuf | null = null;
  private xformCutDone = false;
  /** M3.8 L-B: 変形モード開始時のパラメータ（Ctrl+Zリセットの戻し先） */
  private xformInitial: R.Transform | null = null;

  /** M3.8 L-B: Ctrl+Z / ↶。変形・浮動中はグローバル履歴に絶対に通さない */
  protected handleUndo() {
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
        this.paintUiOverlay();
        this.buildToolOptions(); // 数値表示更新
        this.cb.toast(t("ed.xform.reset.toast"));
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
        this.updateCornerPreview(); // 中で paintUiOverlay も呼ぶ
        this.cb.toast(t("ed.xform.corner.reset.toast"));
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
    // ★V178 (A-72・独立レビュー 3 回目): ↶ ボタンは runCommand を通らない（フォーカスのあるボタンをキーで押しても来る）。
    //  描きかけの束を**先に**確定する——でないと前の操作のほうが巻き戻り、あとで束を取り消すと巻き戻したはずのものが戻る。
    //  peek より前に置く（いま確定した束が、この取り消しの対象になる）
    if (this.eraseAllStroke) this.finishEraseAllNow();
    this.queueHistory("undo");
  }

  /** M3.8 L-B: Ctrl+Y / ↷。変形・浮動中は無効 */
  protected handleRedo() {
    if (this.xformActive || this.floatBuf || this.cornerActive) {
      this.cb.toast(t("ed.xform.noRedo.toast"));
      return;
    }
    // ★V178 (A-72・独立レビュー 3 回目): ↷ も同じ。描きかけの束を先に確定する（新しい操作が積まれるので、やり直しは空になる）
    if (this.eraseAllStroke) this.finishEraseAllNow();
    this.queueHistory("redo");
  }

  /** ★V180 (A-78 [D]): 取り消し・やり直しの**列**。前の 1 回（眠ったコマを起こす `prepare` の待ちを含む）が
   *  済むまで次を走らせず、どのエントリを待つかは**走る直前**に引く。
   *
   *  以前は押した瞬間に `peekUndo()` で引いてから `await prepare` していたので、Ctrl+Z の押しっぱなしで 2 回が
   *  同じ瞬間に入ると、2 回とも一番上のエントリの `prepare`（同じコマを 2 か所から起こす）を待ち、2 回目の
   *  `undo()` はその下のエントリを**起こさずに**走らせていた。V180 の [S-6] で実測: 眠ったコマ 2 つが**両方とも**
   *  戻らない（上のコマは、あとから起き終わった古い控えが戻した絵を上書きし、下のコマは空振り）。
   *  この回の前から prepare を持っていた全レイヤー消しゴム（V178）でも同じ形だった。
   *
   *  失敗した 1 回は列を止めない（`release` は finally）。拒否はこれまでどおり投げっぱなし（main.ts の
   *  unhandledrejection の網がログに残す）。眠りの無い小さい作品では `prepare` がマイクロタスクで済むので、
   *  次のキー入力より前に終わる（結果はこの回の前と 1 画素も変わらない＝[S-4]） */
  private historyQueue: Promise<void> = Promise.resolve();
  private queueHistory(dir: "undo" | "redo"): void {
    const prev = this.historyQueue;
    let release!: () => void;
    this.historyQueue = new Promise<void>((r) => (release = r));
    void prev.then(async () => {
      try {
        // V216b（第三者レビュー）: どのエントリかは片づけを待ったあとで引く（待つ間に積まれた操作と食い違わない）
        if (dir === "undo") await this.applyHistory(() => this.history.undo(), () => this.history.peekUndo());
        else await this.applyHistory(() => this.history.redo(), () => this.history.peekRedo());
      } finally {
        release();
      }
    });
  }

  /** M11-8: 履歴の適用中は「コマ構造の変更＝選択解除」を働かせない
   *（undo/redo が復元したマスクを afterFrameStructureChange が消してしまわないように） */
  private applyingHistory = false;
  /** @param peek どのエントリか（★V216b: 関数なら片づけを待ったあとで引く。前からのエントリを直に渡す形も受ける） */
  private async applyHistory(run: () => void, peek?: (() => HistoryEntry | null | undefined) | HistoryEntry | null) {
    // ★V216b (A-128): 起こす（prepare）前に裏の片づけを止めて、走っている周を待つ（起こしたコマが書く前に眠らされない）。
    //  どの抜け方でも finally で外す
    const holding = this.holdSweep();
    try {
      if (holding) await holding;
      const entry = typeof peek === "function" ? peek() : peek;
      // V156 (P-1): 全コマの画素を触るエントリは、眠っているコマを**起こしてから**動かす。
      // 起こさずに走らせると `f.layers[id] ?? allocIndexBuf(p)` が空バッファを掴んで、
      // 元に戻したはずの絵が白紙になる（＝静かな喪失）。`prepare` を持たないエントリは素通り
      if (entry?.prepare) await entry.prepare();
      this.applyingHistory = true;
      try {
        run();
      } finally {
        this.applyingHistory = false;
      }
    } finally {
      this.releaseSweep();
    }
    this.refreshSelectionLauncher();
  }

  /** M3.8 L-B: 選択移動の浮動をキャンセルして元位置に戻す（履歴には触れない） */
  protected cancelSelectionMove() {
    const buf = this.activeBuffer();
    if (buf && this.selMoveBefore) buf.set(this.selMoveBefore);
    this.selMoveBefore = null;
    this.floatBuf = null;
    this.dragMode = "";
    this.clearOverlay();
    this.renderCanvas();
    this.redrawOverlay();
  }

  /** E-4: 変形/浮動中は他操作をロック（true=ブロックした）。
   *
   *  M11-12: 「別のことを始める」入口はほぼすべてここを通っている（コマ移動・レイヤー切替・
   *  保存・書き出し・画像で保存・エディタを離れる・クリップボード・消す…）。浮動テキストは
   *  **ブロックではなく確定**なので、判定の前にここで焼き切る。確定後は textDraft が
   *  null になるので、以降の判定は従来どおり。**確定経路を1箇所に集約する**ための配置 */
  protected xformGuard(): boolean {
    if (this.textDraft) this.commitTextDraft();
    if (this.xformActive || this.floatBuf || this.cornerActive) {
      this.cb.toast(t("ed.xform.guard.toast"));
      return true;
    }
    return false;
  }

  /**
   * M13-2b (T-2): 変形の対象レイヤーと**共通マスク1枚**を決める（REQ §6-2 の手順 1〜2）。
   *   対象   … M13-1 の純関数（展開・重複除去・実効可視で非表示を除外・レイヤーを1枚だけ選んでいるか空なら activeLayerId
   *            ＝描いているレイヤー。ゆらゆらと同じ・V206 A-115）
   *   マスク … 選択範囲があればそれ。無ければ対象レイヤーの**合成**の非透明画素
   * 戻り値は layerDefs の順（下→上）。対象が0件・マスクが空なら null。
   * 1枚だけ選んでいれば、従来の「アクティブ1枚の非透明画素」とビット単位で同じマスクになる。
   */
  private transformTargets(): { ids: string[]; mask: Uint8Array } | null {
    const frame = this.project.frames[this.frameIndex];
    if (!frame) return null;
    const want = new Set(this.moveTargetLayerIds());
    const ids = this.project.layerDefs.map((l) => l.id).filter((id) => want.has(id) && !!frame.layers[id]);
    if (ids.length === 0) return null;
    let mask = this.selMask;
    if (!mask) {
      // 0/1 マスク。索引ではないので Uint8Array のまま（16bit 化しない）
      mask = new Uint8Array(PIXELS);
      for (const id of ids) {
        const b = frame.layers[id];
        for (let i = 0; i < PIXELS; i++) if (b[i] !== 0) mask[i] = 1;
      }
    }
    if (!R.maskBBox(mask)) return null;
    return { ids, mask };
  }

  private beginTransform() {
    if (this.xformActive) return;
    const frame = this.project.frames[this.frameIndex];
    if (!frame) return;
    // M13-2b (T-2): 対象 N 枚を**同じマスク**で切り出す。extractFloat は bbox を**マスク**から決めるので
    // 全 float の ox/oy/w/h が一致し、回転・拡縮の中心が共通になる（raster.ts には触らない・REQ §4）。
    // マスクの空判定を**切り出す前**に済ませるので、失敗時にバッファは1画素も動いていない
    const tg = this.transformTargets();
    if (!tg) {
      this.cb.toast(t("ed.xform.nothingToTransform.toast"));
      this.tool = this.prevTool;
      this.updateToolButtons();
      return;
    }
    this.xformLayers = [];
    for (const id of tg.ids) {
      const buf = frame.layers[id];
      const before = copyIndexBuf(buf);
      const float = R.extractFloat(buf, tg.mask, true);
      if (!float) continue; // マスクは空でないと確かめてあるので来ない（型の都合）
      this.xformLayers.push({ id, float, before });
    }
    // 幾何の基準は**アクティブレイヤーの float**（無ければ先頭）。寸法は全部同じなのでどれでも同じ
    const primary = this.xformLayers.find((l) => l.id === this.activeLayerId) ?? this.xformLayers[0];
    this.floatBuf = primary.float;
    this.xformBefore = primary.before;
    this.xformCutDone = true;
    this.xform = { tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, flipH: false, flipV: false };
    this.xformInitial = { ...this.xform }; // L-B: Ctrl+Zリセットの戻し先
    this.xformActive = true;
    this.updateXformBadge();
    this.renderCanvas();
    this.redrawOverlay();
    this.paintUiOverlay();
  }

  /** M6-5 Q-4: 変形ハンドルの2段ヒットテスト（発注者確定仕様）。
   *  四隅の□（±6ドット）=拡縮 / 上辺中央の棒付き□=回転（残置・共存） /
   *  **枠の内側=移動** / **枠の外側 12 ドットのリング=回転** / それ以外=何もしない。
   *  単位はキャンバスのドット（表示倍率に応じて描画ハンドルと相似にスケール）。
   *  座標は枠のローカル系（逆回転）で判定するので、回転後も□の位置と一致する。
   *
   *  M11-24: **回転を枠の外側だけに限定**した。以前は「四隅からの距離 ≤ 6+20」だけで見ていたので
   *  枠の内側にも回転が効き、52×52 ドット以下の枠は中心まで 26 ドット圏内＝**全域が回転で移動できず**、
   *  大きい枠でも四隅付近の内側が回転になっていた（作者の実使用フィードバック）。
   *  判定順も「枠内の移動」を回転リングより先にして、内側が回転に飲まれないようにしている。 */
  protected xformHitTest(pt: { x: number; y: number }): {
    mode: "" | "move" | "scale" | "scalex" | "scaley" | "rotate";
    cursor: string;
    /** M13-2b (T-3): 辺ハンドルのとき、掴んだ辺がローカル軸の +側か −側か */
    side?: 1 | -1;
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
    // ★V214 (§5-1 の 1): 当たりの大きさは画面の側が決める（xformHitSizes・PC は 6・12）。判定の順と決まりは変えない
    const { hit: HIT, ring: RING } = this.xformHitSizes(); // HIT: □の当たり半径（ドット）／RING: M11-24: **枠の外側**の回転ゾーン幅（ドット）
    // M13-2b (T-3): 辺ハンドルのカーソル。回転後のグローバル方位で ↔ / ↕ を選ぶ
    const edgeCursor = (axisAngle: number) => {
      const deg = ((((axisAngle * 180) / Math.PI) % 180) + 180) % 180;
      return deg < 45 || deg >= 135 ? "ew-resize" : "ns-resize";
    };
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
    // M13-2b (T-3): 辺の中央の□＝その方向だけ伸ばす（上下＝scaley・左右＝scalex）
    if (Math.hypot(lx, ly + hh) <= HIT) return { mode: "scaley", cursor: edgeCursor(t.angle + Math.PI / 2), side: -1 };
    if (Math.hypot(lx, ly - hh) <= HIT) return { mode: "scaley", cursor: edgeCursor(t.angle + Math.PI / 2), side: 1 };
    if (Math.hypot(lx - hw, ly) <= HIT) return { mode: "scalex", cursor: edgeCursor(t.angle), side: 1 };
    if (Math.hypot(lx + hw, ly) <= HIT) return { mode: "scalex", cursor: edgeCursor(t.angle), side: -1 };
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
      for (let i = 0; i < hs.length; i++) {
        const cl = this.clampedHandle(hs[i].x, hs[i].y);
        if (!cl) continue;
        if (Math.hypot(pt.x - cl.x, pt.y - cl.y) > HIT) continue;
        if (i === 4) return { mode: "rotate", cursor: ROTATE_CURSOR };
        if (i === 5) return { mode: "scaley", cursor: edgeCursor(t.angle + Math.PI / 2), side: -1 };
        if (i === 6) return { mode: "scalex", cursor: edgeCursor(t.angle), side: 1 };
        if (i === 7) return { mode: "scaley", cursor: edgeCursor(t.angle + Math.PI / 2), side: 1 };
        if (i === 8) return { mode: "scalex", cursor: edgeCursor(t.angle), side: -1 };
        const c = locals[i];
        const ga = Math.atan2(c[1], c[0]) + t.angle;
        const deg = ((((ga * 180) / Math.PI) % 180) + 180) % 180;
        return { mode: "scale", cursor: deg < 90 ? "nwse-resize" : "nesw-resize" };
      }
    }
    // M11-24: 枠の内側は常に移動（四隅の□・棒付き□・寄せたハンドルは上で処理済み）
    if (Math.abs(lx) <= hw && Math.abs(ly) <= hh)
      return { mode: "move", cursor: "move" };
    // 枠の外側リング＝回転。枠（矩形）からの距離で測るので、辺の外も角の外も同じ 12 ドット
    const ox = Math.max(0, Math.abs(lx) - hw);
    const oy = Math.max(0, Math.abs(ly) - hh);
    if (Math.hypot(ox, oy) <= RING) return { mode: "rotate", cursor: ROTATE_CURSOR };
    return { mode: "", cursor: "" };
  }

  protected beginTransformDrag(pt: { x: number; y: number }) {
    if (!this.floatBuf) return;
    this.dragStart = pt;
    this.dragBase = { ...this.xform };
    // Q-4: ヒットしない場所からのドラッグは何もしない（意図しないモード切替の防止）
    const hit = this.xformHitTest(pt);
    this.dragMode = hit.mode || "";
    this.dragSide = hit.side ?? 1; // M13-2b (T-3)
    // R-2: 掴んだ瞬間からモードが分かるようカーソルも更新（回転中は grabbing）
    this.xformDragCursor(hit.mode === "rotate" ? "grabbing" : hit.cursor); // ★V213: カーソルは画面（PC）
  }

  protected updateTransformDrag(pt: { x: number; y: number }, shiftKey = false) {
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
    } else if (this.dragMode === "scalex" || this.dragMode === "scaley") {
      // M13-2b (T-3): 辺ハンドル＝その軸だけ伸ばす。ポインタの**ローカル座標**（回転後の軸）で
      // 掴んだ辺の位置を決め、**対辺が動かないように中心をずらす**（REQ §9: 中心基準で k 倍すると
      // 対辺は半幅×(k−1) だけ外へ動くので、ローカル軸でその量だけ tx/ty を戻す）
      const b = this.dragBase;
      const cos = Math.cos(b.angle);
      const sin = Math.sin(b.angle);
      const dx = pt.x - cx;
      const dy = pt.y - cy;
      const isX = this.dragMode === "scalex";
      // ポインタの、掴んだ軸方向のローカル座標（符号つき）
      const l = isX ? dx * cos + dy * sin : -dx * sin + dy * cos;
      const half0 = (isX ? f.w / 2 : f.h / 2) * Math.abs(isX ? b.sx : b.sy);
      const s = this.dragSide;
      // 掴んだ辺をポインタ l へ、**対辺（ローカル −s·half0）は固定**。新しい辺の長さは
      // ポインタと対辺の距離 (s·l + half0) なので、半幅はその半分。対辺を越えたら最小幅で止める
      //（反転は別の操作）。※「中心からの距離 s·l」を半幅にすると辺がポインタの2倍動く（実機で判明）
      const half1 = Math.max(half0 * 0.05, 1, (s * l + half0) / 2);
      const k = half1 / Math.max(1e-6, half0);
      if (isX) this.xform.sx = Math.max(0.05, Math.abs(b.sx) * k);
      else this.xform.sy = Math.max(0.05, Math.abs(b.sy) * k);
      // 対辺を止める: 中心を掴んだ側へ (half1 − half0) だけ寄せる（ローカル軸を世界へ戻す）
      const d = s * (half1 - half0);
      if (isX) {
        this.xform.tx = b.tx + d * cos;
        this.xform.ty = b.ty + d * sin;
      } else {
        this.xform.tx = b.tx - d * sin;
        this.xform.ty = b.ty + d * cos;
      }
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
    this.paintUiOverlay(); // M13-2b (T-6): 枠・ハンドルは画面解像度の層
  }

  /** V166 (層2): 変形の焼き込み。M13-2b で**N枚のレイヤーへ同時に**当たるようになったので、
   *  レイヤーの多い作品では一度の Enter で N×76,800 画素を書き換える。 */
  protected async commitTransform() {
    await this.runHeavy("xform.commit", t("ed.heavy.xform.msg"), () => this.commitTransformInner());
  }

  private commitTransformInner() {
    const frame = this.project.frames[this.frameIndex];
    if (!frame || !this.floatBuf || this.xformLayers.length === 0) return;
    // M13-2b (T-2): **1つの Transform を全 float に当てて** N 枚へ焼き込む（REQ §6-2 手順4）。
    // 中心は全 float で共通（同じマスクで切り出したので ox/oy/w/h が同じ）
    const before: Record<string, IndexBuf> = {};
    const after: Record<string, IndexBuf> = {};
    for (const L of this.xformLayers) {
      const buf = frame.layers[L.id];
      if (!buf) continue;
      R.blitFloatTransformed(buf, L.float, this.xform);
      before[L.id] = L.before;
      after[L.id] = copyIndexBuf(buf);
    }
    // M10-22: 変形確定は endTransform で selMask が消えるため、画素とマスク解除を
    // 1エントリに束ねる（選択なし変形では before/after とも null＝実質従来どおり）。
    // M13-2b: N 枚ぶんを**1エントリ**に（手順5）。1枚のときも同じ経路＝中身は従来と同じ before/after。
    // 実体は id で適用時に解決する＝構造 undo/redo でバッファが再生成されても正しい実体へ戻る
    const self = this;
    const base = multiBufferChangeEntry(
      "変形",
      (id) => frame.layers[id] ?? null,
      before,
      after,
      () => {
        self.dirty = true;
        self.renderCanvas();
        const fi = self.project.frames.indexOf(frame);
        if (fi >= 0) self.paintFilmThumb(fi);
      }
    );
    // ★V180 (A-78 ②): 取り消し・やり直しの前に、そのコマを書きで起こす（pushWithSelection が包むエントリへ運ぶ）
    base.prepare = () => wakeFrame(this.project, frame, "write");
    this.pushWithSelection(base, frame, {
      before: this.selMask ? this.selMask.slice() : null,
      after: null,
    });
    this.endTransform();
    this.paintFilmThumb(this.frameIndex);
  }

  protected cancelTransform() {
    // M13-2b (T-2): 切り出した N 枚すべてをスナップショットへ戻す。貼り付け・画像配置（cutDone=false）は
    // 元のバッファに触れていないので何もしない（従来どおり）
    const frame = this.project.frames[this.frameIndex];
    if (frame && this.xformCutDone)
      for (const L of this.xformLayers) frame.layers[L.id]?.set(L.before);
    this.endTransform();
  }

  private endTransform() {
    this.xformActive = false;
    this.xformInitial = null; // L-B
    this.updateXformBadge();
    this.xformCursorReset(); // ★V213: モードの札を消し、カーソルを今の道具へ（画面・PC）
    this.xformBefore = null;
    this.xformCutDone = false;
    this.floatBuf = null;
    this.xformLayers = [];
    this.selMask = null;
    this.clearOverlay();
    this.paintUiOverlay(); // M13-2b (T-6): 枠・ハンドルの層を消す
    this.paintSelectionUi(); // V208 (A-119): redrawOverlay を通らないので、選択の線の層もここで整える
    this.renderCanvas();
    if (this.tool === "transform") {
      this.tool = "pen";
      this.updateToolButtons();
      this.buildToolOptions();
    }
  }

  /**
   * M13-2b: バッファ書き換えのエントリ `base` に**選択マスクの復元**を束ねて1エントリで積む
   * （`pushBufferHistory` の合成エントリと同じ形。マスク復元の「そのコマを表示中のときだけ」規則も同じ）。
   */
  private pushWithSelection(
    base: HistoryEntry,
    frame: Frame,
    sel: { before: Uint8Array | null; after: Uint8Array | null }
  ) {
    const self = this;
    const onFrame = () => self.project.frames[self.frameIndex] === frame;
    const selBefore = sel.before;
    const selAfter = sel.after;
    this.history.push({
      colorRefs: base.colorRefs, // V195 (A-99)
      label: base.label,
      // ★V156 (P-2): **申告漏れその1**。ここは `base` を包んだ**新しいエントリ**を作るので、
      //  `base.bytes`（ストロークの before/after ＝ 8bit で 153,600 B）が**運ばれずに落ちていた**。
      //  範囲選択を伴う操作は全部ここを通るので、いちばん重い操作だけが予算をすり抜けていた。
      //  選択マスク（`Uint8Array(PIXELS)` ×2）もこのクロージャが抱えるので一緒に数える
      bytes: (base.bytes ?? 0) + entryBytes(selBefore, selAfter),
      bytesIfUndone: base.bytesIfUndone,
      bytesIfApplied: base.bytesIfApplied,
      prepare: base.prepare,
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
    this.dirty = true;
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
  protected async beginTextDraft(pt: { x: number; y: number }) {
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
  protected textDraftMask(): { w: number; h: number; data: Uint8Array } | null {
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
  protected textDraftOrigin(d: NonNullable<EditorCore["textDraft"]>): { x: number; y: number } {
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
  protected cancelTextDraft() {
    if (!this.textDraft) return;
    this.textDraft = null;
    this.textDrag = null;
    this.textDraftCache = null;
    this.buildToolOptions();
    this.redrawOverlay();
  }

  /** 書体・サイズ・太さ・向きの変更を浮動テキストへ反映する（**位置は変えない**） */
  protected syncTextDraftStyle() {
    if (!this.textDraft) return;
    this.textDraft.family = this.textFamily;
    this.textDraft.size = this.textSize;
    this.textDraft.bold = this.textBold;
    this.textDraft.vertical = this.textVertical;
  }

  /** M16 (K-4): 色を拾うだけ（**ツールは切り替えない**）。スポイト tool と Alt＋クリックの共通の実体。 */
  /** V167 (K-3): 直前に「色を拾いました」を出した時刻（間引き用）。 */
  private lastPickNoticeAt = -Infinity;

  /** V167 (K-3): 拾ったことを知らせる。**規則は `prefs.ts` の `shouldNoticePick` 1か所**。
   *  @param via `"pointer"` なら「Alt＋クリックで」と**押した組み合わせを名指しする**
   *    ——事故のときに「なぜ色が変わったか」が分かるのが目的なので、そこが要点。 */
  private noticePick(prevHex: string, via: "tool" | "pointer" | "key", keys: string) {
    const next = this.colorHex || "";
    if (!shouldNoticePick(via, prevHex, next, this.lastPickNoticeAt, performance.now())) return;
    this.lastPickNoticeAt = performance.now();
    // ★独立レビューの指摘（中）: 透明の紙を拾うと `colorHex` は **`""`**。そのまま出すと
    //  「色を拾いました（）」という**壊れて見える**知らせになる。事故を伝えるための
    //  知らせがそれでは本末転倒なので、既存の「透明（消す）」の言い方を借りる
    const color = next === "" ? t("ed.color.transparent.title") : next.toUpperCase();
    this.cb.toast(
      via === "pointer"
        ? t("ed.pick.byKeys.toast", { keys, color })
        : t("ed.pick.done.toast", { color })
    );
  }

  protected pickColorAt(pt: { x: number; y: number }, via: "tool" | "pointer" | "key" = "tool", keys = "") {
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    // V167 (K-3): 変わったかどうかで知らせるので、拾う前の色を控える
    const prevHex = this.colorHex || "";
    const i = pt.y * W + pt.x;
    // 上のレイヤーから順に
    for (let L = this.project.layerDefs.length - 1; L >= 0; L--) {
      const ld = this.project.layerDefs[L];
      if (!ld.visible) continue;
      const v = f.layers[ld.id]?.[i] ?? 0;
      if (v !== 0) {
        this.colorHex = this.project.colorTable[v];
        this.rebuildPalette();
        this.logPick(pt, `layer=${ld.id} idx=${v}`);
        this.noticePick(prevHex, via, keys);
        return;
      }
    }
    this.colorHex = this.project.colorTable[f.paper];
    this.rebuildPalette();
    this.logPick(pt, "paper");
    this.noticePick(prevHex, via, keys);
  }

  /** スポイト tool の1回ぶん: 色を拾って**元のツールへ戻す**（従来の挙動）。 */
  protected pickColor(pt: { x: number; y: number }) {
    this.pickColorAt(pt);
    this.setTool(this.prevTool === "eyedrop" ? "pen" : this.prevTool);
  }

  /** M10-21: pickColor 到達と解決色の診断ログ（フラグ時のみ。通常は即 return） */
  private logPick(pt: { x: number; y: number }, src: string) {
    if (!this.inputLog) return;
    this.inputLogBuf.push(
      `[inputlog] pickColor (${pt.x},${pt.y}) ${src} -> ${this.colorHex || "(?)"} tool→${this.tool}`
    );
    this.flushInputLogSoon();
  }

  /** 紙色を変える。M11-16: `hex === ""` は**透明の紙**（paper=0）。透明は colorTable の
   *  予約添字 0 を直接使い、`ensureColor` を通さない（色を登録しない＝16bit 昇格も起きない） */
  protected setPaper(hex: string) {
    const f = this.project.frames[this.frameIndex];
    if (!f) return;
    const oldPaper = f.paper;
    let newPaper: number;
    if (hex === "") {
      newPaper = 0;
    } else {
      const bitsBefore = this.project.indexBits;
      newPaper = ensureColor(this.project, hex);
      if (bitsBefore === 8 && this.project.indexBits === 16) {
        this.noticePromote16(); // V154 (W-3)
      }
    }
    if (oldPaper === newPaper) return;
    const fi = this.frameIndex;
    const self = this;
    this.history.push({
      colorRefs: () => ({ papers: [oldPaper, newPaper] }), // V195 (A-99)
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

  protected copyPrevFrame() {
    if (this.frameIndex === 0) {
      this.cb.toast(t("ed.tl.copyPrev.noSource.toast"));
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
      colorRefs: () => ({ bufs: [...Object.values(beforeLayers), ...Object.values(afterLayers)], papers: [beforePaper, afterPaper] }), // V195 (A-99)
      label: "複写",
      bytes: entryBytes(beforeLayers, afterLayers), // V154 (W-2)
      // ★V180 (A-78 ②・指示からの追加): そのコマが眠っていると `f.layers[k]?.set(v)` が黙って空振りする
      //  （Node 実測: 履歴は戻るのに 3 枚とも複写した絵のまま）。取り消し・やり直しの前に書きで起こす。
      //  コマ番号で持つので、そのコマが無ければ何もしない
      prepare: () => {
        const fr = self.project.frames[fi];
        return fr ? wakeFrame(self.project, fr, "write") : Promise.resolve();
      },
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
    this.cb.toast(t("ed.tl.copyPrev.done.toast"));
  }

  /** M11-2: 「消す」は**選択中のレイヤーだけ**を対象にする（従来はページ全体だった）。
   *  - フォルダ選択中は配下の全レイヤー（ネスト含む・再帰）。**レイヤー構造は残す**
   *  - 選択範囲があるときは範囲内だけ（M10-22 のクリップ方針と揃える）
   *  - **非表示レイヤーも消す**（表示状態は対象判定に使わない。「見えないから残った」ほうが事故）
   *  - Undo は multiBufferChangeEntry で1エントリ（フォルダで何枚消しても Ctrl+Z 1回） */
  protected async clearFrame() {
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
      this.cb.toast(folder ? t("ed.tl.clearFrame.emptyFolder.toast") : t("ed.tl.clearFrame.noLayer.toast"));
      return;
    }
    // M12-1b-2（監査 #58）: 文の途中へ断片（{scope}）を差し込むのをやめ、
    // フォルダ×全/範囲・レイヤー×全/範囲の**完全文4キー**にした（語順が変わる言語でも訳せる）
    const hasSel = !!this.selMask;
    // V151 (E-8): 「次回から表示しない」対象の1つ（id: clearFrame・4文面で1確認）
    const ok = await this.confirmWithSkip(
      "clearFrame",
      folder
        ? hasSel
          ? t("ed.tl.clearFrame.folderSel.msg", { folder: folder.name, count: targets.length })
          : t("ed.tl.clearFrame.folderAll.msg", { folder: folder.name, count: targets.length })
        : hasSel
          ? t("ed.tl.clearFrame.layerSel.msg", { layer: targets[0].name })
          : t("ed.tl.clearFrame.layerAll.msg", { layer: targets[0].name })
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
      this.cb.toast(t("ed.tl.clearFrame.nothing.toast"));
      return;
    }
    // バッファ実体は構造 undo/redo で作り直され得るので、Frame オブジェクト起点で適用時に解決する
    const self = this;
    const clearEntry = multiBufferChangeEntry(
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
    );
    // ★V180 (A-78 ②): 取り消し・やり直しの前に、そのコマを書きで起こす（眠っていると黙って空振りする）
    clearEntry.prepare = () => wakeFrame(this.project, frame, "write");
    this.history.push(clearEntry);
    // afterStructuralChange は「今表示中のコマ」のサムネを塗るが、対象は確認ダイアログ前に
    // 捉えたコマなので、ここは対象コマのサムネを塗る（矢印キー等でコマが動いていても整合）
    this.dirty = true;
    this.renderCanvas();
    const fi = this.project.frames.indexOf(frame);
    if (fi >= 0) this.paintFilmThumb(fi);
  }

  // ---------------- レイヤー操作 ----------------

  // ---------------- M11-15: レイヤーのコピー＆ペースト（コマ1枚ぶん） ----------------
  //  ★V199 (A-105・docs/REQ_layer_copy_v1.md): フォルダごと（中の全部をレイヤーの id ごとに控える）・
  //   タイムラインで選んだコマの範囲へ・範囲選択が無いときの Ctrl+C／Ctrl+V・貼り付けがロックを見る。
  //   「何を・どこへ」の決まりは `layerClip.ts`（純関数）。ここは確認・知らせ・履歴・眠っている面を起こすだけ

  /** クリップボードを捨てる。**破棄はここ1箇所**（mount から呼ぶ＝作品を跨がない） */
  protected clearLayerClip() {
    this.layerClip = null;
    this.updateLayerClipButtons();
  }

  /** 控えが無いときの案内（全貼り付け経路で共通） */
  private requireLayerClip(): LayerClip | null {
    if (!this.layerClip) {
      this.cb.toast(t("ed.layerclip.noClip.toast"));
      return null;
    }
    return this.layerClip;
  }

  /** 選んでいるレイヤーの名前（確認の文に入れる） */
  private activeLayerName(): string {
    return this.project.layerDefs.find((l) => l.id === this.activeLayerId)?.name ?? layerBaseName();
  }

  /** 選んでいるレイヤー（V199: フォルダを選んでいれば**フォルダの中の全部**＝中のフォルダの中も・非表示も）の、
   *  いまのコマの絵を控えへコピーする（プロジェクトには触れない）。
   *  V157 (D-1): コピーはロック中でも通す（絵は変わらない） */
  protected async copyLayerFrame() {
    if (this.xformGuard()) return; // 変形中の切り出し済みバッファをコピーしない
    const p = this.project;
    const fi = this.frameIndex;
    const fr = p.frames[fi];
    if (!fr) return;
    // V199: いまのコマが眠っていたら読みで起こす（起こさないとバッファが無く、黙って控えそこねる）
    if (frameHasAsleep(fr)) {
      await wakeFrame(p, fr, "read");
      if (this.project !== p || !this.mounted || this.frameIndex !== fi) return;
    }
    const folder = this.selectedFolderId ? this.folderById(this.selectedFolderId) : undefined;
    let clip: LayerClip | null;
    if (folder) {
      clip = copyFolderClip(p, fi, folder.id);
      if (!clip) return;
      if (clip.items.length === 0) {
        this.cb.toast(t("ed.layerclip.folderEmpty.toast", { folder: folder.name }));
        return;
      }
    } else {
      clip = copyLayerClip(p, fi, this.activeLayerId);
      if (!clip) return;
    }
    this.layerClip = clip;
    this.lastCopy = "layer"; // V199: Ctrl+V は最後にコピーしたほう
    this.updateLayerClipButtons();
    this.revealLayerClip(); // M11-19: 貼り付けボタン列が画面外に押し出されていても見えるように
    if (clip.kind === "folder")
      this.cb.toast(t("ed.layerclip.copiedFolder.toast", { folder: clip.name, count: clip.items.length, frame: fi + 1 }));
    else this.cb.toast(t("ed.layerclip.copied.toast", { layer: clip.name, frame: fi + 1 }));
  }

  /** 控えを**置き換え**で書き込む（8/16bit 整合: dst が 16bit・src が 8bit でも .set は値を保つ。
   *  逆＝dst 8bit・src 16bit は起きない — コピー後にプロジェクトが降格することは無い） */
  private static writeClipInto(dst: IndexBuf, src: IndexBuf) {
    dst.set(src as unknown as ArrayLike<number>);
  }

  /** V199 (A-105・§2-5): 貼り先を決める。書ける面が 1 つも無ければ**知らせて null**。
   *  - レイヤーの控え: 選んでいるレイヤーがロック中なら、描くときと同じロックの知らせ
   *  - フォルダの控え: 全部消えていれば「もうありません」、ロック中が混じっていれば飛ばした枚数 */
  private layerPastePlan(clip: LayerClip): PastePlan | null {
    const plan = planLayerPaste(this.project, clip, this.activeLayerId, (id) => this.isLayerLocked(id));
    if (plan.writes.length > 0) return plan;
    if (clip.kind === "layer") {
      if (plan.locked) this.lockGuard(this.activeLayerId);
      return null;
    }
    if (plan.locked === 0) this.cb.toast(t("ed.layerclip.allGone.toast"));
    else this.toastPasteSkipped(plan);
    return null;
  }

  /** V199 (A-105・§2-2・§2-5): 飛ばした枚数を言う（消えたレイヤー・ロック中のレイヤー） */
  private toastPasteSkipped(plan: PastePlan) {
    if (plan.missing && plan.locked)
      this.cb.toast(t("ed.layerclip.skipBoth.toast", { missing: plan.missing, locked: plan.locked }));
    else if (plan.missing) this.cb.toast(t("ed.layerclip.skipMissing.toast", { count: plan.missing }));
    else if (plan.locked) this.cb.toast(t("ed.layerclip.skipLocked.toast", { count: plan.locked }));
  }

  /** V199: 貼り付けのあとのサムネ（1 コマならそのコマだけ・全コマならフィルムを作り直す＝可視分だけ遅延描画） */
  private refreshPastedThumbs(faces: readonly TouchedFace[], mode: "one" | "range" | "all") {
    // 📌 全コマ共通レイヤーに書いたら全コマの絵が変わる＝フィルムを作り直す（触ったコマだけでは足りない）
    const sharedHit = faces.some((x) => this.project.layerDefs.find((l) => l.id === x.layerId)?.shared === true);
    if (mode === "all" || sharedHit) {
      this.rebuildFilm();
      return;
    }
    for (const f of new Set(faces.map((x) => x.frame))) {
      const fi = this.project.frames.indexOf(f);
      if (fi >= 0) this.paintFilmThumb(fi);
    }
  }

  /** V199 (A-105): 貼った面を**履歴 1 エントリ**に積む（取り消し 1 回で全部戻る）。
   *  コマの実体と id で**その時に**解決する（構造の取り消しでバッファが作り直されても正しい実体へ）。
   *  控えの絵は写しを持つ（やり直すときに控えが替わっていても同じ絵が入るように＝M11-15 の clipCopy と同じ）。
   *  V203 (A-109): 重ね貼り（over）のやり直しは、書く前の絵の写しと控えの写しから**重ねたあとの絵**を作り直す
   *  （重ねたあとの絵は持たない＝抱える量・色の参照は差し替えと同じ） */
  private pushLayerPasteHistory(touched: readonly TouchedFace[], mode: "one" | "range" | "all", over = false) {
    const copies = new Map<IndexBuf, IndexBuf>();
    const faces: TouchedFace[] = touched.map((x) => {
      let c = copies.get(x.src);
      if (!c) {
        c = copyIndexBuf(x.src);
        copies.set(x.src, c);
      }
      return { ...x, src: c };
    });
    const srcs = [...copies.values()];
    const self = this;
    const after = () => {
      self.dirty = true;
      self.renderCanvas();
      self.refreshPastedThumbs(faces, mode);
    };
    this.history.push({
      colorRefs: () => ({ bufs: [...faces.map((x) => x.before), ...srcs] }), // V195 (A-99)
      label: over
        ? mode === "all" ? "全コマへレイヤー重ね貼り" : mode === "range" ? "範囲へレイヤー重ね貼り" : "レイヤー重ね貼り"
        : mode === "all" ? "全コマへレイヤー貼り付け" : mode === "range" ? "範囲へレイヤー貼り付け" : "レイヤー貼り付け",
      // V154 (W-2): 変わった面ぶんの before と控えの写しを抱える（どちらの状態でも）
      bytes: entryBytes(faces.map((x) => x.before), srcs),
      // ★V180 (A-78 ②): 取り消し・やり直しの前に、触った面を書きで起こす（眠っていると黙って空振りする）
      prepare: async () => {
        const byFrame = new Map<Frame, string[]>();
        for (const x of faces) byFrame.set(x.frame, [...(byFrame.get(x.frame) ?? []), x.layerId]);
        for (const [f, ids] of byFrame) await Promise.all(ids.map((id) => wakeLayer(self.project, f, id, "write")));
      },
      undo: () => {
        undoLayerPaste(faces);
        after();
      },
      redo: () => {
        if (over) redoLayerOverlay(faces);
        else redoLayerPaste(faces);
        after();
      },
    });
  }

  /** V199 (A-105): 控えを `idxs` のコマへ貼る本体（このコマ・選んだ範囲・全コマで共通）。
   *  1 画素も変わらなければ履歴に積まない（同じ絵を同じ所へ貼った）。
   *  V203 (A-109): `over` なら**重ねる**（控えの描いてある画素だけ）。貼り先・ロック・見積もり・起こす・確かめ直しは同じ道 */
  private async pasteLayerClipInto(clip: LayerClip, idxs: readonly number[], mode: "one" | "range" | "all", over = false) {
    const p = this.project;
    let plan = this.layerPastePlan(clip);
    if (!plan) return;
    const frames = idxs.map((i) => p.frames[i]).filter((f): f is Frame => !!f);
    const ids = plan.writes.map((w) => w.layerId);
    // V166 (B): 控えは「変わる面」×1 枚＝最大でコマ数×レイヤー数。起こすぶんも数える（1 コマは只に近いので見ない）
    if (mode !== "one" && !this.allowBufferAlloc(frames.length * ids.length, "layer.allFrames", ids)) return;
    // ★V180 の作法: これから書く面（コマ × レイヤー）を**書きで**起こす（起こさないとバッファが無く、黙って飛ばす）。
    //  全コマなら `wakeLayersAllFrames`（関わるレイヤーだけ・V168 の一覧＝見積もりは上の 1 行）、範囲・1 コマならそのコマのそのレイヤーだけ
    if (frames.length === p.frames.length) await wakeLayersAllFrames(p, ids, "write");
    else for (const f of frames) await Promise.all(ids.map((id) => wakeLayer(p, f, id, "write")));
    if (this.project !== p || !this.mounted) return;
    // 起こしている間にレイヤーが消えた・ロックされたかもしれない＝確かめ直す。貼り先は決めたときのまま
    //（選んでいるレイヤーがその間に替わっても、起こしていない別のレイヤーへは書かない・知らせは最初の 1 回で済んでいる）
    plan = recheckPastePlan(p, plan, (id) => this.isLayerLocked(id));
    const t0 = performance.now();
    const touched = over ? applyLayerOverlay(frames, plan.writes) : applyLayerPaste(frames, plan.writes);
    if (touched.length === 0) {
      if (over) this.cb.toast(mode === "all" ? t("ed.layerclip.overSameAll.toast") : t("ed.layerclip.overSame.toast"));
      else this.cb.toast(mode === "all" ? t("ed.layerclip.sameAll.toast") : t("ed.layerclip.same.toast"));
      this.toastPasteSkipped(plan);
      return;
    }
    this.pushLayerPasteHistory(touched, mode, over);
    this.dirty = true;
    this.renderCanvas();
    this.refreshPastedThumbs(touched, mode);
    const nFrames = new Set(touched.map((x) => x.frame)).size;
    if (mode === "range")
      this.cb.toast(over ? t("ed.layerclip.pasteOverRangeDone.toast", { count: nFrames }) : t("ed.layerclip.pasteRangeDone.toast", { count: nFrames }));
    if (mode === "all") {
      // 100コマ級でも数十msで終わる見込みだが、念のため長いときは時間も添える（M11-15 から）
      const name = clip.kind === "folder" ? clip.name : this.activeLayerName();
      const ms = Math.round(performance.now() - t0);
      if (over)
        this.cb.toast(
          ms >= 500
            ? t("ed.layerclip.pasteOverAllDoneSlow.toast", { count: nFrames, layer: name, ms })
            : t("ed.layerclip.pasteOverAllDone.toast", { count: nFrames, layer: name })
        );
      else
        this.cb.toast(
          ms >= 500
            ? t("ed.layerclip.pasteAllDoneSlow.toast", { count: nFrames, layer: name, ms })
            : t("ed.layerclip.pasteAllDone.toast", { count: nFrames, layer: name })
        );
    }
    this.toastPasteSkipped(plan);
  }

  /** ① 貼り付け（「貼り付け」ボタン・layer.paste・最後にレイヤーをコピーしたときの Ctrl+V）。
   *  - レイヤーの控え → 選んでいるレイヤーのいまのコマ（丸ごと差し替え）
   *  - V199: フォルダの控え → **控えた同じレイヤー**それぞれのいまのコマ（ほかのレイヤー＝背景などは触らない）
   *  - V199: タイムラインで 2 コマ以上を選んでいれば、選んだコマ全部へ（入る前にコマ数を言う確認）
   *  取り消しは 1 回で全部戻る。ロック中のレイヤーには書かない */
  protected async pasteLayerFrame() {
    if (this.xformGuard()) return; // E-4
    const clip = this.requireLayerClip();
    if (!clip) return;
    const range = pasteRange(this.rangeSel, this.project.frames.length);
    if (!range) {
      await this.pasteLayerClipInto(clip, [this.frameIndex], "one");
      return;
    }
    // 確認の前に、書ける所があるかを見る（ロック中・消えたレイヤーだけなら確認を出さずに知らせる）
    const plan = this.layerPastePlan(clip);
    if (!plan) return;
    const count = range.b - range.a + 1;
    const ok = await this.cb.confirm(
      clip.kind === "folder"
        ? t("ed.layerclip.pasteRangeFolder.msg", { from: range.a + 1, to: range.b + 1, count, folder: clip.name, layers: plan.writes.length })
        : t("ed.layerclip.pasteRange.msg", { from: range.a + 1, to: range.b + 1, count, layer: this.activeLayerName() })
    );
    if (!ok) return;
    const idxs: number[] = [];
    for (let i = range.a; i <= range.b; i++) idxs.push(i);
    // ★V166 (層2): 確認は漏斗の外・書き込みだけを中に入れる（全コマへと同じ）
    // 待つ間の文は「選んだコマに反映しています」（全コマへの「全コマに反映しています」ではない）
    await this.runHeavy("layer.allFrames", t("ed.heavy.layerRange.msg"), () => this.pasteLayerClipInto(clip, idxs, "range"));
  }

  /** V203 (A-109・docs/REQ_layer_overlay_paste.md): 重ね貼り（「重ね貼り」ボタン・layer.pasteOver）。
   *  控えの**描いてある画素（索引が 0 でない画素）だけ**を貼り先へ書き、0 の所は貼り先の絵のまま
   *  （範囲選択の確定と同じ重なり方）。貼り先の決め方・飛ばす決まり・眠っている面・📌・取り消し 1 回は
   *  「貼り付け」と同じ（同じ pasteLayerClipInto を通る）。Ctrl+V（edit.paste）からは呼ばない（今のまま差し替え）。
   *  - タイムラインで 2 コマ以上を選んでいれば、選んだコマ全部へ（入る前に重ねる文の確認）
   *  - 控えに何も描かれていなければ、ロック中・消えたレイヤーの知らせより先に知らせて何もしない（確認も出さない） */
  protected async pasteLayerOverFrame() {
    if (this.xformGuard()) return; // E-4
    const clip = this.requireLayerClip();
    if (!clip) return;
    if (!clipHasInk(clip)) {
      this.cb.toast(t("ed.layerclip.overEmpty.toast"));
      return;
    }
    const range = pasteRange(this.rangeSel, this.project.frames.length);
    if (!range) {
      await this.pasteLayerClipInto(clip, [this.frameIndex], "one", true);
      return;
    }
    // 確認の前に、書ける所があるかを見る（ロック中・消えたレイヤーだけなら確認を出さずに知らせる＝貼り付けと同じ）
    const plan = this.layerPastePlan(clip);
    if (!plan) return;
    const count = range.b - range.a + 1;
    const ok = await this.cb.confirm(
      clip.kind === "folder"
        ? t("ed.layerclip.pasteOverRangeFolder.msg", { from: range.a + 1, to: range.b + 1, count, folder: clip.name, layers: plan.writes.length })
        : t("ed.layerclip.pasteOverRange.msg", { from: range.a + 1, to: range.b + 1, count, layer: this.activeLayerName() })
    );
    if (!ok) return;
    const idxs: number[] = [];
    for (let i = range.a; i <= range.b; i++) idxs.push(i);
    // ★V166 (層2): 確認は漏斗の外・書き込みだけを中に入れる（貼り付けの範囲と同じ）
    await this.runHeavy("layer.allFrames", t("ed.heavy.layerRange.msg"), () => this.pasteLayerClipInto(clip, idxs, "range", true));
  }

  /** ③ 新規レイヤーを作ってそこへ（addLayer と同じ規則で作成 → 貼り付け。**履歴1エントリ**）。
   *  V199 (A-105): フォルダの控えなら**新しいフォルダ**と同じ並びのレイヤーを作る（`pasteFolderToNew`）。
   *  どちらも絵を入れるのは**いまのコマだけ**（範囲は見ない）。ロック中のフォルダの中には作らない */
  protected pasteLayerToNew() {
    if (this.xformGuard()) return; // E-4
    const clip = this.requireLayerClip();
    if (!clip) return;
    if (clip.kind === "folder") {
      this.pasteFolderToNew(clip);
      return;
    }
    const id = newLayerId(this.project);
    const idx = this.project.layerDefs.findIndex((l) => l.id === this.activeLayerId);
    // addLayer と同じ: 選択中フォルダの中 or 選択レイヤーと同じ親・選択レイヤーの直上
    const selFolder = this.selectedFolderId ? this.folderById(this.selectedFolderId) : undefined;
    const def: LayerDef = {
      id,
      name: `${layerBaseName()}${this.project.layerDefs.length + 1}`,
      visible: true,
      opacity: 1,
      parent: selFolder
        ? selFolder.id
        : this.project.layerDefs.find((l) => l.id === this.activeLayerId)?.parent,
    };
    // ★V199 (§2-5): ロック中のフォルダの中に作ると、絵を入れた先がロック中のレイヤーになる＝書かない
    if (ancestorLocked(this.project, def.parent)) {
      this.cb.toast(t("ed.layer.lockedByFolder.toast"));
      return;
    }
    let insertAt = idx >= 0 ? idx + 1 : this.project.layerDefs.length;
    if (selFolder) {
      const members = this.folderLayerIndices(selFolder.id);
      if (members.length > 0) insertAt = members[members.length - 1] + 1;
    }
    const frameIdx = this.frameIndex;
    const prevActive = this.activeLayerId;
    const clipCopy = copyIndexBuf(clip.buf); // redo 時に控えが変わっていても同じ絵が入るように
    const clipColor = clip.frameColor; // V216b (A-132)
    const self = this;
    const apply = () => {
      // M11-20 レビュー: def は雛形＝コピーを挿入（理由は「選択→新規レイヤー」の apply と同じ）
      self.project.layerDefs.splice(insertAt, 0, { ...def });
      for (const f of self.project.frames) {
        f.layers[id] = allocIndexBuf(self.project);
        if (f.order) f.order.push(id); // コマ固有描画順があれば最上位に追加（addLayer と同じ）
      }
      const fr = self.project.frames[frameIdx];
      const d = fr?.layers[id];
      if (d) EditorCore.writeClipInto(d, clipCopy);
      // ★V216b (A-132): このコマだけの表示色も運ぶ（入る位置は今のまま）
      if (fr && clipColor) (fr.layerColors ??= {})[id] = clipColor;
      self.activeLayerId = id;
      self.afterLayerChange();
      self.paintFilmThumb(frameIdx);
    };
    const revert = () => {
      const i = self.project.layerDefs.findIndex((l) => l.id === id);
      if (i >= 0) self.project.layerDefs.splice(i, 1);
      for (const f of self.project.frames) {
        dropLayer(f, id); // V156: 眠っているぶん（f.sleep）も一緒に消す
        if (f.order) f.order = f.order.filter((x) => x !== id);
        EditorCore.dropFrameColor(f, id); // V216b (A-132)
      }
      self.activeLayerId = self.project.layerDefs.some((l) => l.id === prevActive)
        ? prevActive
        : (self.project.layerDefs[self.project.layerDefs.length - 1]?.id ?? "");
      self.afterLayerChange();
      self.paintFilmThumb(frameIdx);
    };
    this.history.push({
      colorRefs: () => ({ bufs: [clipCopy] }), // V195 (A-99)
      label: "新規レイヤーへ貼り付け",
      bytes: entryBytes(clipCopy), // V154 (W-2)
      undo: revert,
      redo: apply,
    });
    apply();
  }

  /** V216b (A-132): 取り消しで消したレイヤーの「このコマだけの表示色」を外す（空になったら印ごと） */
  private static dropFrameColor(f: Frame, id: string): void {
    if (!f.layerColors || !(id in f.layerColors)) return;
    delete f.layerColors[id];
    if (Object.keys(f.layerColors).length === 0) delete f.layerColors;
  }

  /** V199 (A-105・§2-2): フォルダの控えの「新規レイヤーへ」。**新しいフォルダ**を 1 つ作り、その中に
   *  控えと同じ並び（中のフォルダも同じ入れ子・名前は元のまま）の新しいレイヤーを作って、いまのコマにだけ絵を入れる。
   *  置き場所は元のフォルダのすぐ上（同じ親）。元のフォルダが無い・空なら、ふつうのレイヤーの追加と同じ所。
   *  **履歴1エントリ**（取り消しでフォルダもレイヤーも消える） */
  private pasteFolderToNew(clip: FolderClip) {
    const p = this.project;
    const idx = p.layerDefs.findIndex((l) => l.id === this.activeLayerId);
    const selFolder = this.selectedFolderId ? this.folderById(this.selectedFolderId) : undefined;
    let fbInsert = idx >= 0 ? idx + 1 : p.layerDefs.length;
    if (selFolder) {
      const members = this.folderLayerIndices(selFolder.id);
      if (members.length > 0) fbInsert = members[members.length - 1] + 1;
    }
    const anchor = folderPasteNewAnchor(p, clip, {
      parent: selFolder ? selFolder.id : p.layerDefs[idx]?.parent,
      insertAt: fbInsert,
    });
    if (ancestorLocked(p, anchor.parent)) {
      this.cb.toast(t("ed.layer.lockedByFolder.toast"));
      return;
    }
    // V166 (B): 新しいレイヤーを全コマぶん確保する（枚数 × コマ数）
    if (!this.allowBufferAlloc(p.frames.length * clip.items.length, "layer.add")) return;
    const plan = planFolderPasteNew(clip, anchor, () => newLayerId(p), () => newFolderId(p));
    const frameIdx = this.frameIndex;
    const prevActive = this.activeLayerId;
    const prevSelFolder = this.selectedFolderId;
    const copies = plan.bufs.map((b) => copyIndexBuf(b)); // redo 時に控えが変わっていても同じ絵が入るように
    const self = this;
    const apply = () => {
      const folders = (self.project.folders ??= []);
      for (const f of plan.folders) folders.push({ ...f });
      self.project.layerDefs.splice(plan.insertAt, 0, ...plan.defs.map((d) => ({ ...d })));
      const fr = self.project.frames[frameIdx];
      for (const f of self.project.frames) {
        for (const d of plan.defs) {
          f.layers[d.id] = allocIndexBuf(self.project);
          // コマ固有描画順があれば最上位に（addLayer と同じ・下から上の順のまま）。★V216b (A-132): 貼るコマは下で入れ直す
          if (f.order && f !== fr) f.order.push(d.id);
        }
      }
      if (fr) {
        plan.defs.forEach((d, i) => {
          const dst = fr.layers[d.id];
          if (dst) EditorCore.writeClipInto(dst, copies[i]);
          // ★V216b (A-132): このコマだけの表示色を新しい id に写す
          const c = plan.frameColors[i];
          if (c) (fr.layerColors ??= {})[d.id] = c;
        });
        // ★V216b (A-132): このコマの描画順では、それぞれ元のすぐ上に入れる（元を隠すと合成が貼る前と同じ）
        if (fr.order) fr.order = orderWithPasted(fr.order, plan);
      }
      self.activeLayerId = plan.defs[plan.defs.length - 1]?.id ?? self.activeLayerId;
      self.selectedFolderId = plan.rootId; // addFolder と同じ: 作ったフォルダを選ぶ
      self.afterLayerChange();
      self.paintFilmThumb(frameIdx);
    };
    const revert = () => {
      const ids = new Set(plan.defs.map((d) => d.id));
      const fids = new Set(plan.folders.map((f) => f.id));
      self.project.layerDefs = self.project.layerDefs.filter((l) => !ids.has(l.id));
      for (const f of self.project.frames) {
        for (const id of ids) {
          dropLayer(f, id); // V156: 眠っているぶんも一緒に消す
          EditorCore.dropFrameColor(f, id); // V216b (A-132)
        }
        if (f.order) f.order = f.order.filter((x) => !ids.has(x));
      }
      self.project.folders = (self.project.folders ?? []).filter((f) => !fids.has(f.id));
      self.activeLayerId = self.project.layerDefs.some((l) => l.id === prevActive)
        ? prevActive
        : (self.project.layerDefs[self.project.layerDefs.length - 1]?.id ?? "");
      self.selectedFolderId = prevSelFolder && self.folderById(prevSelFolder) ? prevSelFolder : null;
      self.afterLayerChange();
      self.paintFilmThumb(frameIdx);
    };
    this.history.push({
      colorRefs: () => ({ bufs: copies }), // V195 (A-99)
      label: "新規フォルダへ貼り付け",
      bytes: entryBytes(copies), // V154 (W-2)
      undo: revert,
      redo: apply,
    });
    apply();
  }

  /** ④ 全コマの選んだレイヤーへ一括（ID・サイン用。**履歴1エントリ**＝undo 1回で全コマ戻る）。
   *  before は**変化のあったコマだけ**控える（既に同じ絵のコマは触らない＝メモリと時間の節約）。
   *  V199 (A-105): フォルダの控えなら、控えた同じレイヤーの全コマ。ロック中のレイヤーには書かない。
   *  V203 (A-109): コマが 2 つ以上なら、重ねるか差し替えるかを選ばせる（cb.choose。並びは［重ねる］［差し替える］＝
   *  画面では右寄せの［重ねる］［差し替える］［キャンセル］で、［差し替える］が今の［はい］と同じ右から 2 番目に来る・
   *  先頭の［重ねる］が強調＝影響の小さいほうを先頭にする V157 と同じ流儀）。cb.choose が無い呼び出し側では
   *  今の確認（差し替え）に落とす。コマが 1 つなら今と同じく確認なしで差し替える */
  protected async pasteLayerAllFrames() {
    if (this.xformGuard()) return; // E-4
    const clip = this.requireLayerClip();
    if (!clip) return;
    const plan = this.layerPastePlan(clip);
    if (!plan) return;
    const n = this.project.frames.length;
    let over = false;
    if (n > 1) {
      if (this.cb.choose) {
        // 文は頭（レイヤー用・フォルダ用）と続き（共通の 3 行）に分けて改行でつなぐ（1 つのキーだと字数の上限を超える）
        const head =
          clip.kind === "folder"
            ? t("ed.layerclip.pasteAllHeadFolder.msg", { count: n, folder: clip.name, layers: plan.writes.length })
            : t("ed.layerclip.pasteAllHead.msg", { count: n, layer: this.activeLayerName() });
        const pick = await this.cb.choose(head + "\n" + t("ed.layerclip.pasteAllChoose.msg"), [
          t("ed.layerclip.chooseOver.btn"),
          t("ed.layerclip.chooseReplace.btn"),
        ]);
        if (pick !== 0 && pick !== 1) return; // キャンセル・背景のタップ
        over = pick === 0;
      } else {
        const ok = await this.cb.confirm(
          clip.kind === "folder"
            ? t("ed.layerclip.pasteAllFolder.msg", { count: n, folder: clip.name, layers: plan.writes.length })
            : t("ed.layerclip.pasteAll.msg", { count: n, layer: this.activeLayerName() })
        );
        if (!ok) return;
      }
    }
    // 控えに何も描かれていなければ、重ねても何も変わらない（差し替えは空の絵で消す操作として意味があるので選ぶ画面は出す）
    if (over && !clipHasInk(clip)) {
      this.cb.toast(t("ed.layerclip.overEmpty.toast"));
      return;
    }
    const idxs = this.project.frames.map((_, i) => i);
    // ★V166 (層2): 確認は漏斗の外・全コマへの書き込みだけを中に入れる
    if (over) await this.runHeavy("layer.allFrames", t("ed.heavy.layerAll.msg"), () => this.pasteLayerClipInto(clip, idxs, "all", true));
    else await this.runHeavy("layer.allFrames", t("ed.heavy.layerAll.msg"), () => this.pasteLayerClipInto(clip, idxs, "all"));
  }

  protected addLayer() {
    if (this.xformGuard()) return; // E-4
    const id = newLayerId(this.project);
    const idx = this.project.layerDefs.findIndex((l) => l.id === this.activeLayerId);
    // M3.7: 選択中フォルダ（実在するもののみ）の中 or 選択レイヤーと同じ親に作成
    // （独立レビューの指摘#2/#3: stale な selectedFolderId を parent に採用しない・
    //  フォルダ内作成時は既存ブロック末尾へ挿入して連続性を守る）
    const selFolder = this.selectedFolderId
      ? this.folderById(this.selectedFolderId)
      : undefined;
    const def: LayerDef = {
      id,
      name: `${layerBaseName()}${this.project.layerDefs.length + 1}`,
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
    // ★V206 (A-117): 取り消しで描いているレイヤーを前のレイヤーへ戻す（新規レイヤーへ貼り付け・範囲を新規レイヤーへ・フォルダを新規レイヤーへと同じ形）
    const prevActive = this.activeLayerId;
    const apply = () => {
      // M11-20 レビュー: def は雛形＝コピーを挿入（理由は「選択→新規レイヤー」の apply と同じ）
      self.project.layerDefs.splice(insertAt, 0, { ...def });
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
        dropLayer(f, id); // V156: 眠っているぶん（f.sleep）も一緒に消す
        if (f.order) f.order = f.order.filter((x) => x !== id);
      }
      if (self.activeLayerId === id)
        self.activeLayerId = self.project.layerDefs.some((l) => l.id === prevActive)
          ? prevActive
          : (self.project.layerDefs[self.project.layerDefs.length - 1]?.id ?? "");
      self.afterLayerChange();
    };
    this.history.push({ colorRefs: NO_COLOR_REFS, label: "レイヤー追加", undo: revert, redo: apply });
    const _t0 = perfNow();
    apply();
    perfDone("layer.add", _t0);
  }

  protected async deleteLayer() {
    if (this.xformGuard()) return; // E-4
    if (this.project.layerDefs.length <= 1) {
      this.cb.toast(t("ed.layer.deleteLastBlocked.toast"));
      return;
    }
    const idx = this.project.layerDefs.findIndex((l) => l.id === this.activeLayerId);
    if (idx < 0) return;
    const def = this.project.layerDefs[idx];
    if (this.lockGuard(def.id)) return; // V157 (D-1): ロック中のレイヤーは消させない
    // V151 (E-8): 「次回から表示しない」対象の1つ（id: layerDelete）
    const ok = await this.confirmWithSkip("layerDelete", t("ed.layer.delete.msg", { layer: def.name }));
    if (!ok) return;
    // ★V166 (層2): ここから先が重い（全コマを起こして全コマぶんの画素を控える＝
    //  1,000コマなら 76MB の写しが動く）。確認は漏斗の外・作業だけを中に入れる
    await this.runHeavy("layer.del", t("ed.heavy.delLayer.msg"), () =>
      this.deleteLayerInner(def, idx)
    );
  }

  private async deleteLayerInner(def: LayerDef, idx: number) {
    // V166 (B): 控えは「全コマ × 1枚」。確保する前に見積もる
    if (!this.allowBufferAlloc(this.project.frames.length, "layer.del", [def.id])) return;
    // ★V156 (P-1): 下の `saved` が全コマの画素を控えるので、先に起こす（このレイヤーだけ）
    await wakeLayersAllFrames(this.project, [def.id], "write");
    const saved: IndexBuf[] = this.project.frames.map((f) =>
      copyIndexBuf(f.layers[def.id] ?? allocIndexBuf(this.project))
    );
    const savedOrders = this.project.frames.map((f) => (f.order ? [...f.order] : undefined));
    const self = this;
    const apply = () => {
      const i = self.project.layerDefs.findIndex((l) => l.id === def.id);
      if (i >= 0) self.project.layerDefs.splice(i, 1);
      for (const f of self.project.frames) {
        dropLayer(f, def.id); // V156: 眠りぶんも
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
    // V154 (W-2 ②): 消したレイヤーの実体は**履歴が抱えたまま**なので申告する
    //（「削除したのに減らない」の正体。ここを黙っているとメーターが嘘をつく）
    this.history.push({
      colorRefs: () => ({ bufs: saved }), // V195 (A-99)
      label: "レイヤー削除",
      bytes: entryBytes(saved),
      // V156 (P-1): 巻き戻しは全コマへバッファを配り直す（起こしてからでないと取りこぼす）
      prepare: () => wakeLayersAllFrames(self.project, [def.id], "write"),
      undo: revert,
      redo: apply,
    });
    apply(); // V166: 計測は漏斗が持つ（`layer.del`）
  }

  /**
   * M15 (K-1): レイヤーの「全コマ共通」を切り替える。
   *  ON: いま見ているコマの絵で全コマを統一する。**他のコマに絵があって内容が違うときだけ**確認する
   *      （空 or 同一なら黙って ON）。以後どのコマで描いても全コマに反映（全コマが同一バッファを参照）。
   *  OFF: 各コマが**自分のコピー**を持つ（見た目は変わらない）。
   *  履歴は1エントリ: ON/OFF フラグ ＋ 全コマのこのレイヤーの before バッファ（copy）を持ち、Undo で完全復元。
   *  ★索引の複製だけ（混色なし）。フォルダには出さない（レイヤー行だけ）。
   */
  protected async toggleLayerShared(id: string) {
    if (this.xformGuard()) return;
    const ld = this.project.layerDefs.find((l) => l.id === id);
    if (!ld) return;
    const turningOn = ld.shared !== true;
    // ★V166 (層2): この操作は**重い区間が確認をはさんで2つある**（前＝全コマの見比べ／
    //  後＝全コマへの配り直し）。確認は待ち時間なので**どちらの漏斗にも入れない**
    if (turningOn) {
      const scan = await this.runHeavy("layer.allFrames", t("ed.heavy.layerAll.msg"), () =>
        this.sharedScanOthersDiffer(id)
      );
      if (scan === undefined || scan === null) return; // 入口が閉じていた／現在コマに実体が無い
      // 他コマに「今と違う絵」があるときだけ確認（空 or 同一なら黙って ON）
      if (scan && !(await this.cb.confirm(t("ed.layer.shared.replace.msg")))) return;
    }
    await this.runHeavy("layer.allFrames", t("ed.heavy.layerAll.msg"), () =>
      this.toggleLayerSharedInner(id, turningOn)
    );
  }

  /** V166: 「他のコマに今と違う絵があるか」だけを見る（全コマ走査＝重い側）。
   *  現在コマに実体が無ければ `null`（呼び出し側は中止する）。 */
  private async sharedScanOthersDiffer(id: string): Promise<boolean | null> {
    // V166 (B): 走査も全コマを展開する＝確保する。先に見積もる
    if (!this.allowBufferAlloc(0, "layer.sharedScan", [id])) return null;
    // ★V156 (P-1): 全コマの画素を現在コマと比べるので、**このレイヤーだけ**先に起こす。
    //  ★V166（独立レビューの指摘⑤）: ここは **"read"**。以前は "write" だったが、
    //   これは**確認ダイアログの前の見比べ**で、利用者が「いいえ」を押せば何も変えない。
    //   "write" は `invalidateFrame` で**圧縮控えを捨てる**ので、取り消した場合でも
    //   眠り控えだけが失われ、次の掃除で圧縮し直す無駄が出ていた（絵は変わらない）
    await wakeLayersAllFrames(this.project, [id], "read");
    const frames = this.project.frames;
    const cur = frames[this.frameIndex]?.layers[id];
    if (!cur) return null;
    for (let fi = 0; fi < frames.length; fi++) {
      if (fi === this.frameIndex) continue;
      const b = frames[fi].layers[id];
      if (!b) continue;
      let empty = true;
      let same = true;
      for (let i = 0; i < PIXELS; i++) {
        if (b[i] !== 0) empty = false;
        if (b[i] !== cur[i]) same = false;
        if (!empty && !same) break;
      }
      if (!empty && !same) return true;
    }
    return false;
  }

  private async toggleLayerSharedInner(id: string, turningOn: boolean) {
    const ld = this.project.layerDefs.find((l) => l.id === id);
    if (!ld) return;
    // ★V166 (B): 控えは「全コマ × 1枚」。**起こすより先に**見積もる——
    //  起こす処理そのものが全コマぶんを展開する（＝確保する）ので、
    //  そのあとで断っても「断る前に確保してしまった」ことになる
    if (!this.allowBufferAlloc(this.project.frames.length, "layer.shared", [id])) return;
    // ★V156 (P-1): OFF は全コマへコピーを配る。全コマの中身が要るので先に起こす
    // （ON 側は走査ですでに起きているが、`wakeLayersAllFrames` は起きているコマを素通りする）
    await wakeLayersAllFrames(this.project, [id], "write");
    const frames = this.project.frames;
    // 履歴: 全コマの before バッファ（copy）＋ 元の shared 状態
    const beforeBufs = frames.map((f) => copyIndexBuf(f.layers[id] ?? allocIndexBuf(this.project)));
    const wasShared = ld.shared === true;
    const curFrame = this.frameIndex;
    const self = this;
    const apply = () => {
      const p = self.project;
      const ldNow = p.layerDefs.find((l) => l.id === id);
      if (!ldNow) return;
      if (turningOn) {
        ldNow.shared = true;
        // いま見ているコマの絵を canonical にして全コマへ同一参照
        const canonical = copyIndexBuf(p.frames[curFrame]?.layers[id] ?? allocIndexBuf(p));
        for (const f of p.frames) f.layers[id] = canonical;
      } else {
        delete ldNow.shared;
        // 各コマに独立コピーを持たせる（現状は全コマ同一参照なので、同じ内容の別実体に分ける）
        const src = p.frames[0]?.layers[id] ?? allocIndexBuf(p);
        for (const f of p.frames) f.layers[id] = copyIndexBuf(src);
      }
      self.dirty = true;
      self.afterLayerChange();
      self.rebuildFilm();
    };
    const revert = () => {
      const p = self.project;
      const ldNow = p.layerDefs.find((l) => l.id === id);
      if (!ldNow) return;
      if (wasShared) ldNow.shared = true; else delete ldNow.shared;
      p.frames.forEach((f, fi) => {
        const nb = allocIndexBuf(p);
        nb.set(beforeBufs[fi]);
        f.layers[id] = nb;
      });
      // wasShared のときは全コマ同一参照へ張り直す（relinkShared と同じ不変条件）
      relinkShared(p);
      self.dirty = true;
      self.afterLayerChange();
      self.rebuildFilm();
    };
    this.history.push({
      colorRefs: () => ({ bufs: beforeBufs }), // V195 (A-99)
      label: turningOn ? "全コマ共通ON" : "全コマ共通OFF",
      // V156 (P-2): **申告漏れその2**。`revert` は 全コマぶんの `copyIndexBuf`（beforeBufs）を
      // クロージャで抱えているのに `bytes` が無く、1,098コマなら **80 MiB** が予算から見えていなかった
      bytes: entryBytes(beforeBufs),
      // V156 (P-1): apply/revert とも全コマの画素を読み書きする
      prepare: () => wakeLayersAllFrames(self.project, [id], "write"),
      undo: revert,
      redo: apply,
    });
    apply();
  }

  /**
   * M15 (K-2): レイヤーカラー（表示色）を切り替える。未設定→いまの色を設定・設定中→解除。
   *  絵の索引は1ドットも変えない（合成時に置換するだけ）。履歴は可視トグルと同じ流儀
   *  （id で解決する軽いエントリ・afterLayerChange で即追従）。 */
  /** V157 (D-2): レイヤーカラーの色チップを押したとき。
   *
   *  **適用先を押す前に選ばせる**（要件: 「全コマ」か「選択中のコマ」かを操作の時点で分かること）。
   *  誤爆すると全コマの色が変わる操作なので、既定を勝手に決めない。
   *  すでに色が付いている側は「外す」に文言が変わる＝これまでのチップの押し味（トグル）と同じ。 */
  protected async chooseLayerColorScope(id: string) {
    if (this.xformGuard()) return;
    const ld = this.project.layerDefs.find((l) => l.id === id);
    if (!ld) return;
    const sel = this.selectedFrameIndices();
    const hasLayerColor = !!ld.displayColor;
    const withColor = sel.filter((i) => this.project.frames[i]?.layerColors?.[id]).length;
    const allSelHave = sel.length > 0 && withColor === sel.length;
    const optAll = hasLayerColor
      ? t("ed.layer.color.clearAll.btn")
      : t("ed.layer.color.applyAll.btn");
    // V157（独立レビュー §1・優先度 高）: **どのコマなのかを文言で言い切る。**
    // 「{n} コマに付ける」だけだと「選んでいるコマ」なのか「いまのコマ」なのか分からない。
    // コマを選んでいないときは `selectedFrameIndices()` が現在コマ1つを返すので、
    // そこは「このコマだけ」と**言い方を変える**（「1 コマに付ける」は読みにくい）
    const one = sel.length === 1;
    const scopeKey = allSelHave
      ? one
        ? "clearOne"
        : "clearFrames"
      : one
        ? "applyOne"
        : "applyFrames";
    const optSel = t(EditorCore.COLOR_SCOPE[scopeKey].msgKey, { n: sel.length });
    // V157（独立レビュー §1）: **狭いほう（このコマ／選んだコマ）を先頭＝primary にする。**
    // 先頭が推奨に見えるので、影響の大きい「全コマ」を勧める並びにしない
    const pick = this.cb.choose
      ? await this.cb.choose(t("ed.layer.color.scope.msg", { layer: ld.name }), [optSel, optAll])
      : 1;
    if (pick === null || pick === undefined) return;
    if (pick === 1) await this.toggleLayerDisplayColor(id);
    else this.applyFrameLayerColor(id, sel, allSelHave ? undefined : this.colorHex || UGO_COLORS.black);
  }

  /** V157 (D-2): **選択中のコマだけ**にレイヤーの表示色を付ける／外す（履歴1エントリ）。
   *
   *  ★索引（`IndexBuf`）には1ビットも触らない。`frames[i].layerColors` という
   *  コマ側の任意キーを足す/消すだけなので、外せばレイヤー既定へ完全に戻る。
   *
   *  ★V156 の眠りとの関係: ここが触るのは**画素ではない**ので、圧縮控え（`sleep`）は
   *  古くならない（控えに入っているのは索引バイト列だけ）。眠っているコマにもそのまま付く——
   *  `f.layers` を一切見ずに `frames[i]` を直に触るのがその要（`f.layers[id]` の有無で
   *  絞ると、眠っているコマだけ**静かに飛ばされる**）。`v157_smoke` §5 が睡眠サイクルで確かめる。 */
  private applyFrameLayerColor(id: string, frames: number[], color: string | undefined) {
    if (frames.length === 0) return;
    const self = this;
    // 元の値を控える（undo で「元から付いていた色」まで正しく戻す）
    const before = frames.map((i) => self.project.frames[i]?.layerColors?.[id]);
    const set = (vals: (string | undefined)[]) => {
      frames.forEach((fi, k) => {
        const f = self.project.frames[fi];
        if (!f) return;
        const v = vals[k];
        if (v) {
          if (!f.layerColors) f.layerColors = {};
          f.layerColors[id] = v;
        } else if (f.layerColors) {
          delete f.layerColors[id];
          if (Object.keys(f.layerColors).length === 0) delete f.layerColors;
        }
      });
      self.dirty = true;
      self.renderCanvas();
      self.rebuildFilm();
    };
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: color ? "コマのレイヤーカラー" : "コマのレイヤーカラー解除",
      // 抱えているのは色の文字列だけ（画素はゼロ）。コマ数ぶんの目安を申告する
      bytes: frames.length * 16,
      undo: () => set(before),
      redo: () => set(frames.map(() => color)),
    });
    set(frames.map(() => color));
    this.cb.toast(
      color
        ? t("ed.frameColor.applied.toast", { n: frames.length })
        : t("ed.frameColor.cleared.toast", { n: frames.length })
    );
  }

  /** V166 (層2): レイヤーカラーは**全コマの見た目**が変わる＝`rebuildFilm` が全コマぶん走る。
   *  画素は1つも書き換えないので確保の見積もりは要らないが、時間は作品の大きさに比例する。 */
  private async toggleLayerDisplayColor(id: string) {
    await this.runHeavy("layer.allFrames", t("ed.heavy.layerAll.msg"), () =>
      this.toggleLayerDisplayColorInner(id)
    );
  }

  private toggleLayerDisplayColorInner(id: string) {
    if (this.xformGuard()) return;
    const ld = this.project.layerDefs.find((l) => l.id === id);
    if (!ld) return;
    const before = ld.displayColor;
    // 現在の色（透明のときは黒に倒す＝透明を表示色にはできない。索引0は「透明」の予約）
    const after = before ? undefined : (this.colorHex || UGO_COLORS.black);
    const self = this;
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: before ? "レイヤーカラー解除" : "レイヤーカラー",
      undo() {
        const l = self.project.layerDefs.find((x) => x.id === id);
        if (!l) return;
        if (before) l.displayColor = before; else delete l.displayColor;
        self.dirty = true;
        self.afterLayerChange();
        self.rebuildFilm();
      },
      redo() {
        const l = self.project.layerDefs.find((x) => x.id === id);
        if (!l) return;
        if (after) l.displayColor = after; else delete l.displayColor;
        self.dirty = true;
        self.afterLayerChange();
        self.rebuildFilm();
      },
    });
    if (after) ld.displayColor = after; else delete ld.displayColor;
    this.dirty = true;
    this.afterLayerChange();
    this.rebuildFilm();
  }

  protected async mergeLayerDown() {
    if (this.xformGuard()) return; // E-4
    const idx = this.project.layerDefs.findIndex((l) => l.id === this.activeLayerId);
    if (idx <= 0) {
      this.cb.toast(t("ed.layer.mergeNoTarget.toast"));
      return;
    }
    const top = this.project.layerDefs[idx];
    const bottom = this.project.layerDefs[idx - 1];
    // M15 (K-1): 共通レイヤーを含む結合は禁止（片方が全コマ共通だと、統合先が
    // 「あるコマだけ違う」状態になり共有の意味が壊れる）。共通を解除してから結合する
    // V157 (D-1): 統合は**両方の絵**を変える。どちらかがロック中なら弾く
    if (this.lockGuard(top.id) || this.lockGuard(bottom.id)) return;
    if (top.shared === true || bottom.shared === true) {
      this.cb.toast(t("ed.layer.mergeSharedBlocked.toast"));
      return;
    }
    // ★V166 (層2): ここから先が重い（全コマ×2枚の控え＝1,000コマなら 153MB）
    await this.runHeavy("layer.merge", t("ed.heavy.mergeLayer.msg"), () =>
      this.mergeLayerDownInner(top, bottom, idx)
    );
  }

  private async mergeLayerDownInner(top: LayerDef, bottom: LayerDef, idx: number) {
    // V166 (B): 控えは「全コマ × 2枚」。7,687コマなら 1.18GB＝貼り付けと同じ確保量
    if (!this.allowBufferAlloc(this.project.frames.length * 2, "layer.merge", [top.id, bottom.id])) return;
    // ★V156 (P-1): 下の2つの控えが全コマの画素を読むので、関わる2枚だけ先に起こす
    // （起こさないと `?? allocIndexBuf(p)` が空バッファを掴んで、統合で絵が消える）
    await wakeLayersAllFrames(this.project, [top.id, bottom.id], "write");
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
        dropLayer(f, top.id); // V156: 眠りぶんも
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
    // V154 (W-2): **統合しても履歴が統合前の実体を握っている**（要件 §2-W-2 の欠陥②）。
    // ここを申告することで「作品」は減っても「元に戻す」が減らないことが数字に出る
    this.history.push({
      colorRefs: () => ({ bufs: [...savedTop, ...savedBottom] }), // V195 (A-99)
      label: "レイヤー統合",
      // V156 (P-1): apply（＝redo）は全コマで top を bottom へ焼き込み、revert は全コマへ
      // 書き戻す。どちらも中身が要るので、関わる2枚だけ全コマで起こしてから動かす
      prepare: () => wakeLayersAllFrames(self.project, [top.id, bottom.id], "write"),
      bytes: entryBytes(savedTop, savedBottom),
      undo: revert,
      redo: apply,
    });
    apply();
  }

  // ---------------- コマ操作 ----------------

  /** @param atEnd M11-14: true=常に最後尾へ追加（フィルム末尾の「＋」＝うごメモ仕様）。
   *  false=選択中のコマの次（ヘッダの「＋ ついか」・複製・ショートカット＝従来どおり）。
   *  上限ガード・履歴・afterFrameStructureChange は同じ経路を通る */
  /** V166 (層2): コマの追加・複製も漏斗を通す。1枚でも**複製は全レイヤーぶんの写し**なので、
   *  レイヤーの多い作品では一瞬で終わらない（＝50ms を超えれば表示が出る）。 */
  protected async addFrame(duplicate: boolean, atEnd = false) {
    await this.runHeavy("frame.add", t("ed.heavy.addFrame.msg"), () =>
      this.addFrameInner(duplicate, atEnd)
    );
  }

  private addFrameInner(duplicate: boolean, atEnd = false) {
    if (this.xformGuard()) return; // E-4
    if (this.project.frames.length >= 65535) {
      this.cb.toast(t("ed.tl.addFrame.limit.toast"));
      return;
    }
    if (this.project.frames.length >= 2000) {
      this.cb.toast(t("ed.common.manyFrames.toast"));
    }
    // V166 (B): 1枚でも確保の前に見積もる。複製も空コマも**新しい色は増えない**ので昇格しない
    if (!this.allowFrameAlloc(1, 0, "frame.add")) return;
    const at = atEnd ? this.project.frames.length : this.frameIndex + 1;
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
    // V154 (W-2): 取り消すと、このコマの実体は履歴のクロージャだけが持つ（独立レビューの指摘）
    this.history.push({
      colorRefs: () => ({ frames: [nf] }), // V195 (A-99)
      label: duplicate ? "コマ複製" : "コマ追加",
      bytesIfUndone: entryBytes(nf),
      undo: revert,
      redo: apply,
    });
    // V166: 計測は漏斗（`runHeavy`→`runWithBusy`）が持つので、ここでは測らない
    // ——同じ操作が `frame.add` として2行出ると、ログの合計が実際の倍になる
    apply();
  }

  // ---------------- V164 (U-4): コマをまとめて追加 ----------------

  /** V164 (U-4): いまのコマの後ろへ N 枚まとめて足す。**履歴は1エントリ**（Ctrl+Z 一回で全部戻る）。
   *
   *  ★V156 の眠りは起こさない。空コマは新しく作るだけ・複製はいま見ているコマ（＝窓の中で
   *   必ず起きている）を写すだけなので、遠くのコマに触れる経路が1つも無い。 */
  protected async addFrames(count: number, duplicate: boolean) {
    await this.runHeavy("frame.addMany", t("ed.heavy.addFrames.msg"), () =>
      this.addFramesInner(count, duplicate)
    );
  }

  private addFramesInner(count: number, duplicate: boolean) {
    if (this.xformGuard()) return; // E-4
    const total = this.project.frames.length;
    if (total >= 65535) {
      this.cb.toast(t("ed.tl.addFrame.limit.toast"));
      return;
    }
    // ★枚数の丸めは `prefs.ts` の1か所（上限を超えるぶんは「超えないところまで」で止めて
    //  **知らせる**。途中まで入って黙って終わるのが最悪＝要件 U-4）
    const { n, clamped } = clampAddFrames(count, total);
    if (n <= 0) {
      this.cb.toast(t("ed.tl.addFrame.limit.toast"));
      return;
    }
    const at = this.frameIndex + 1;
    // ★取り消したときに**押す前のコマへ戻る**ために覚えておく（独立レビュー V164 指摘①）。
    //  `Math.min(this.frameIndex, …)` で戻すと、追加後の位置（＝最大100コマ先）に
    //  居座ってしまい、「誤って足した→取り消した」人が遠くへ飛ばされる
    const beforeIndex = this.frameIndex;
    const cur = this.project.frames[this.frameIndex];
    if (!cur) return;
    // V166 (B): 確保の前に見積もる。まとめて追加も新しい色は増えない
    if (!this.allowFrameAlloc(n, 0, "frame.addMany")) return;
    const added: Frame[] = [];
    for (let i = 0; i < n; i++)
      added.push(duplicate ? cloneFrame(cur) : makeEmptyFrame(this.project, cur.paper));
    const self = this;
    const apply = () => {
      // redo 時に 16bit 昇格を跨いでいる可能性があるので正規化（ゆらゆら・はりつけと同じ）
      for (const f of added) conformFrameWidth(self.project, f);
      self.project.frames.splice(at, 0, ...added);
      self.frameIndex = at + added.length - 1; // 足した最後のコマへ（＋ついかと同じ「増えた先に居る」）
      self.afterFrameStructureChange();
    };
    const revert = () => {
      self.project.frames.splice(at, added.length);
      // 押す前に見ていたコマへ戻す（クランプは念のため。構造が変わっていても範囲外にしない）
      self.frameIndex = Math.max(0, Math.min(beforeIndex, self.project.frames.length - 1));
      self.afterFrameStructureChange();
    };
    // V154 (W-2): 取り消すと、足したコマの実体は履歴のクロージャだけが持つ（N 枚ぶんの合計）
    this.history.push({
      colorRefs: () => ({ frames: added }), // V195 (A-99)
      label: duplicate ? "コマ複製（まとめて）" : "コマ追加（まとめて）",
      bytesIfUndone: entryBytes(added),
      undo: revert,
      redo: apply,
    });
    apply(); // V166: 計測は漏斗が持つ（`frame.addMany`）
    if (clamped) this.cb.toast(t("ed.tl.addFrames.clamped.toast", { count: n }));
    else this.cb.toast(t("ed.tl.addFrames.done.toast", { count: n }));
    // 既存の注意はそのまま通す（2,000 コマ超え）
    if (this.project.frames.length >= 2000) this.cb.toast(t("ed.common.manyFrames.toast"));
  }

  /** V166 (層2): まとめて削除は範囲ぶんの実体を履歴へ移す（＝コマ数ぶんの写しが動く）。
   *
   *  ★**確認ダイアログは漏斗の外**に置いてある。中に入れると
   *  「利用者が読んでいる時間」に『けしています』の箱が重なって出る（V154b W-8 と同じ理由）。
   *  漏斗が包むのは**実際に動いている区間だけ**。 */
  protected async deleteFrame() {
    if (this.xformGuard()) return; // E-4
    const total = this.project.frames.length;
    if (total <= 1) {
      this.cb.toast(t("ed.tl.deleteFrame.lastBlocked.toast"));
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
      this.cb.toast(t("ed.tl.deleteFrame.allBlocked.toast"));
      return;
    }
    // M13-2a (A-4): ⚙「コマを消すときに確認する」がオフなら確認を省く。**ダイアログを呼ぶ側は消さない**
    //（オン＝従来どおり）。上の「最後の1枚」「全部」の制止は設定に関係なく生きる。
    // 1枚の削除には元から確認が無い（Undo で戻せるため）ので、この設定が効くのは範囲削除だけ
    if (count > 1 && this.frameDeleteConfirm) {
      const ok = await this.cb.confirm(
        t("ed.tl.deleteFrame.range.msg", { count, from: at + 1, to: end + 1 })
      );
      if (!ok) return;
      // 確認の間にコマ構造が変わっていたら中止（ダイアログ中の変更は無いはずだが保険）
      if (this.project.frames.length !== total) return;
    }
    // ★ここから先が「実際に動く区間」＝漏斗の中
    await this.runHeavy("frame.del", t("ed.heavy.delFrame.msg"), () =>
      this.deleteFrameInner(at, count)
    );
  }

  private deleteFrameInner(at: number, count: number) {
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
    // V154 (W-2): 消したコマは履歴が丸ごと抱えている（600コマ削除なら 138MB がここに残る）。
    // Undo で戻すと実体はプロジェクト側へ帰るので、そのときは数えない（`bytesIfApplied`）
    this.history.push({
      colorRefs: () => ({ frames: removed }), // V195 (A-99)
      label: count > 1 ? `コマ削除（${count}枚）` : "コマ削除",
      bytesIfApplied: entryBytes(removed),
      undo: revert,
      redo: apply,
    });
    apply(); // V166: 計測は漏斗が持つ（`frame.del`）
  }

  /** V166 (層2): 並べ替えそのものは splice 1回だが、そのあとの
   *  `afterFrameStructureChange`（フィルムの作り直し・メーター）が大作品では重い。 */
  protected async reorderFrame(from: number, to: number) {
    if (from === to) return;
    if (this.xformGuard()) return; // E-4
    await this.runHeavy("frame.reorder", t("ed.heavy.reorder.msg"), () =>
      this.reorderFrameInner(from, to)
    );
  }

  private reorderFrameInner(from: number, to: number) {
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
    this.history.push({ colorRefs: NO_COLOR_REFS, label: "コマ並べ替え", undo: revert, redo: apply });
    apply(); // V166: 計測は漏斗が持つ（`frame.reorder`）
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
    // ★V195 (A-97・BUG-004): **再生中にコマへ移ったら、先に再生を止める**（⏸ ではなく停止＝BGM も SE も止まり、
    //  続きは捨てる）。止まり方はキャンバスに触れたとき（M11-9 P-2）と同じでトーストも出さない。
    //  今までは `frameIndex` を書き換えるだけで再生のタイマーと BGM が走り続け、絵だけ飛んで音は流れ続けた。
    //  ★入口はここ 1 か所（タイムラインのコマ・Shift＋クリック・◀▶・⏮⏭・←→ キー・frame.prev/next が全部ここを通る）。
    //  呼び出し元ごとに書かない＝足した入口が漏れない。範囲外（先頭で ◀）でも止める＝押した合図は必ず返す
    if (this.playing) this.stopPlayback();
    if (i < 0 || i >= this.project.frames.length) return;
    // M11-10: コマが動く前に、矢印キーの移動セッションを確定する（下のドラッグ判定より先。
    // セッションは layerDrag / selMaskDrag を使うので、確定させてから通す）
    this.endArrowSession();
    if (this.xformGuard()) return; // E-4: 変形中はコマ移動をブロック
    // M11-8: ドラッグ中にコマが変わると、掴んだコマ以外の絵を壊す/選択が宙に浮く
    if (this.pointerDown || this.layerDrag || this.selMaskDrag) return;
    const _t0 = perfNow();
    this.clearSelectionOnFrameMove();
    // M11-1: 別の位置へ飛んだら、前の位置で鳴り始めたSEは止める（BGMには触れない。
    // 再生ループはここを通らず frameIndex を直接進めるので、通常再生のSEは切れない）
    this.audioPreview.stopSe();
    // ★V209 (A-121): コマを動かしたら、⏸ した位置（何周目か）と「曲の終わりで止まった」も捨てる（▶ はそのコマの 1 周目から）
    this.playPaused = null;
    this.playEnded = null;
    this.frameIndex = i;
    this.renderCanvas();
    this.redrawOverlay();
    this.updateFilmSelection();
    this.seSectionRefresh?.(); // M5-1: 音声パネルの「配置先」表示を追従
    // V156 (P-1): 動いた先で窓が変わった＝窓から出たコマを片付ける（軽く促すだけ）
    this.nudgeSweep();
    perfDone("frame.goto", _t0);
  }

  // ---------------- 再生 ----------------

  togglePlayback() {
    // M11-2: ストローク中（ペンが接地したまま）に再生を始めると、コマが進んだ先で
    // 描き続けたストロークが「開始コマの before」で履歴に積まれ、Ctrl+Z が別コマを
    // 壊す（レビュー検出）。キー操作から呼ばれ得るようになったので入口で塞ぐ
    if (this.pointerDown) return;
    if (!this.playing && this.xformGuard()) return; // E-4
    // M11-9 P-1: ⏸ は「一時停止」＝SEは続きから鳴らせるように畳む（▶ で続きから）
    if (this.playing) {
      this.stopPlayback(true);
      return;
    }
    // ★V195 (A-96・BUG-003): ループしない作品で**最後のコマにいるときの ▶ は先頭から**。
    //  ループしない再生は終端で止まり、`frameIndex` は最後のコマのまま残る。そこから始めると
    //  最後のコマを 1 回出して終端で止まっていた。先頭へは `gotoFrame` で移る＝SE の続き（⏸ で畳んだ分）を捨て、
    //  選択を解き、眠っているコマを起こす道も今までのコマ移動と同じ。BGM は startPlayback が
    //  `frameIndex / fps`（＝0 秒）から頭出しする。判断は `playStartFrame`（ライブラリの再生 2 か所と同じ 1 つ）
    //
    //  ★V209 (A-121): 「曲の長さで書き出す」で BGM がある形（アニメは曲の間繰り返す）では、この決まりを使わない
    //  （2 周目以降の最後のコマで ⏸→▶ すると先頭に戻ってしまう）。曲の終わりで止まったあと、コマを動かさずに ▶ なら頭から
    const song = this.songModeWanted();
    const at = song
      ? this.playEnded && this.playEnded.frame === this.frameIndex
        ? 0
        : this.frameIndex
      : playStartFrame(this.frameIndex, this.project.frames.length, this.project.loop);
    if (at !== this.frameIndex) this.gotoFrame(at);
    void this.startPlayback();
  }

  /** ★V209 (A-121): 「曲の長さで書き出す」で BGM がある形か（その時点の「BGM があってミュートでない」で決める。
   *  デコードできなかったら、始めたあとで BGM なしとして続ける＝始めたコマは変えない） */
  private songModeWanted(): boolean {
    const b = this.project.audio?.bgm;
    return !!b && !b.muted && b.syncMode === "animToAudio";
  }

  /** M5-1: 配置して非ミュートのSE（▶ の前にデコードを待つもの） */
  protected usedSeTracks(): SeTrack[] {
    const a = this.project.audio;
    if (!a || a.se.length === 0) return [];
    const used = new Set<string>();
    for (const f of this.project.frames) for (const id of f.se ?? []) used.add(id);
    return a.se.filter((s) => !s.muted && used.has(s.id));
  }

  /** V209 (A-121・R-11): 数える入口（検査用）。控えのあるレイヤーが起きているコマの数（ライブラリの previewAwakeCount と同じ数え方） */
  playAwakeCount(): number {
    let n = 0;
    for (const f of this.project.frames) {
      if (!f.sleep) continue;
      for (const id of Object.keys(f.sleep)) {
        if (f.layers[id]) {
          n++;
          break;
        }
      }
    }
    return n;
  }

  protected async startPlayback() {
    if (this.playing) return;
    const _t0 = perfNow();
    const gen = ++this.playGen; // ★V209 (R-15): この ▶ の世代
    this.playing = true;
    // M11-8 P-4（REQ 表E）: 再生はコマを進めるので選択を解除する
    //（再生ループは gotoFrame を通らず frameIndex を直接進めるため、ここで1回だけ）
    this.clearSelectionOnFrameMove();
    this.playStateShown(true); // ★V213: ▶ を ⏸ に（画面・PC）
    const proj = this.project;
    const n = proj.frames.length;
    if (this.frameIndex >= n) this.frameIndex = Math.max(0, n - 1); // コマ数が減って今のコマが無くなったら最後のコマ
    const fps = FPS_TABLE[proj.speedIndex] || 8;
    // M6-2/3: BGMプレビュー。M5-1: 速度連動 rate（ピッチも変わる=原作準拠）＋SEのコマ発火
    const a = proj.audio ?? null;
    const track = a?.bgm ?? null;
    const rate = track ? bgmPlaybackRate(proj.speedIndex, track.baseSpeedIndex) : 1;
    // ★V209: 始める位置は待つ前に決める。⏸ した位置は、速さ・コマ数・コマが ⏸ したときと同じときだけ使う（違えばそのコマの頭＝1 周目から）
    const song = this.songModeWanted();
    const paused = this.playPaused;
    const resume = !!paused && paused.fps === fps && paused.frameCount === n && paused.frame === this.frameIndex;
    const t0 = resume && paused ? paused.t : startTimeOf({ fps, frameCount: n }, this.frameIndex);
    const se = this.usedSeTracks();
    // ★V157 (D-4): **音の用意を待ってからコマを進め始める**（A-28・Culoe さんの報告）。
    //
    //  これまでは `void audioPreview.start(...)` と投げっぱなしにして、その直後に
    //  コマ送りのタイマーを張っていた。`start()` の中は初回だけ `decodeAudioData` を待つので、
    //  **その間コマだけ進み、音が遅れて始まる**。2周目からはバッファがキャッシュされていて
    //  ほぼ 0ms で鳴るので合ってくる——「最初はズレて、ループを重ねると合う」の正体。
    //
    //  実測（Chromium・実作品の BGM 2.1MiB / 55 秒）: 初回 decode **174.9ms**
    //    → 8fps で 1.4 コマ・24fps で 4.2 コマ・30fps で 5.2 コマぶん絵が先行
    //    2周目以降は 0.2ms（ズレ ほぼ 0）
    //
    //  待つと再生の開始が初回だけ 0.2 秒ほど遅れるが、**ズレたまま流れるより良い**
    //  （同じ音源なら2回目からは待ちもゼロ）。
    //  エディタの再生も同じ形（ライブラリのプレビューだけ直しても、こちらが残る）。
    //  ★V209: SE だけの作品でも待つ（ensureAudioRunning と SE のデコード）
    const prep = await this.audioPreview.preparePlay(track, se);
    if (gen !== this.playGen || !this.playing) return; // 待っている間に止められた・始め直された
    this.playPaused = null;
    this.playEnded = null;
    let plan: BgmPlan | null = null;
    if (track && prep.bgm) {
      const { trimStartSec, trimEndSec, usableSec } = normalizeTrim(prep.bgm.duration, track.trimStartMs, track.trimEndMs);
      if (usableSec > 0) plan = { buf: prep.bgm, trimStart: trimStartSec, trimEnd: trimEndSec, rate, volume: track.volume };
    }
    const host: PlayHost = {
      shape: () => ({ fps: FPS_TABLE[this.project.speedIndex] || 8, frameCount: this.project.frames.length, loop: this.project.loop }),
      show: (i) => this.showPlayFrame(i),
      ended: () => {
        const at = this.frameIndex;
        this.stopPlayback();
        if (song && plan) this.playEnded = { frame: at };
      },
      reshape: () => {
        // 速さ・コマ数が変わった＝今のコマから始め直す（曲は 1 周目のそのコマの位置）
        this.stopPlayback();
        void this.startPlayback();
      },
      seAt: (i) => {
        const ids = this.project.frames[i]?.se;
        const au = this.project.audio;
        if (!ids || !au) return [];
        const out: { buf: AudioBuffer; track: SeTrack }[] = [];
        for (const id of ids) {
          const t = au.se.find((s) => s.id === id);
          const buf = t && !t.muted ? this.audioPreview.seBuffer(t) : undefined;
          if (t && buf) out.push({ buf, track: t });
        }
        return out;
      },
      bgm: () => plan,
    };
    const clock = new PlayClock(host, this.audioPreview);
    this.playClock = clock;
    clock.start({ t0, songMode: song && !!plan, wantAudio: !!plan || se.length > 0, resume });
    // V159 (G-1): ▶ を押してから**最初のコマが動き出すまで**。V157 (D-4) で音の用意を
    // 待つようにしたので、ここが伸びていれば「押しても始まらない」の正体はデコード
    perfDone("play.start", _t0);
  }

  /** ★V209 (A-121): 時計がコマを変えた（遅れたらコマを飛ばす）。描くのはコマが変わったときだけ */
  private showPlayFrame(i: number) {
    const prev = this.frameIndex;
    const n = this.project.frames.length;
    this.frameIndex = i;
    this.renderCanvas();
    this.updateFilmSelection();
    // V156 (P-1): 再生は窓が全コマを通り抜ける。**出ていったコマをその場で片付ける**
    //（読みで起こしてあるので只＝生を手放すだけ）。ここを掃除の巡回に任せると、
    // 1周するころには全コマが生に戻ってしまう。
    // ★V209 (R-11): コマを飛ばしたら、通り過ぎたコマをまとめて片付ける（1 つ進むたびに 4 つ後ろを 1 枚、を飛んだぶん全部）
    if (!this.playing || n <= 0) return;
    const steps = Math.min(n, (((i - prev) % n) + n) % n);
    if (steps > n / 2 && n > 2) {
      // 大きく飛んだ（後ろへ戻った・見えていない間から追いついた）: 通り過ぎたとは限らないので 1 枚ずつ片付けず、窓の外だけを片付ける
      this.trimPlayWindow();
      return;
    }
    for (let k = 1; k <= steps; k++) void this.evictBehind((prev + k) % n);
    if (steps > 1) this.trimPlayWindow();
  }

  /** ★V209 (A-121・R-11): 再生中、窓（今のコマ ±SLEEP_WINDOW）の外で、控えのあるレイヤーが起きているコマを**只で**片付ける。
   *  コマを飛ばしたとき・起こし終わりが追い越されたときに呼ぶ（1 つずつ進めば evictBehind だけで足りる）。圧縮はしない（只で片付くものだけ） */
  protected trimPlayWindow() {
    if (!this.sleepOn || !this.playing || this.sweepHold > 0) return; // V216b (A-128): 止めている間は眠らせ直さない
    const lo = this.frameIndex - EditorCore.SLEEP_WINDOW;
    const hi = this.frameIndex + EditorCore.SLEEP_WINDOW;
    const keep = this.sharedLayerIds();
    this.project.frames.forEach((f, i) => {
      if ((i >= lo && i <= hi) || !f.sleep) return;
      for (const id of Object.keys(f.sleep)) {
        if (f.layers[id]) {
          void sleepFrame(this.project, f, keep, true /* 只で片付くものだけ */);
          return;
        }
      }
    });
  }

  /** pause=true は ⏸（あとで ▶ で続きから）。それ以外の停止経路（画面を離れる・書き出し・
   *  キャンバスに触れた・ループしない作品が終端に達した等）は**続きを捨てる**（M11-9 P-1） */
  protected stopPlayback(pause = false) {
    this.playGen++; // ★V209 (R-15): 音の用意を待っている ▶ を古くする
    this.playing = false;
    const clock = this.playClock;
    this.playClock = null;
    if (pause) {
      // ★V209 (A-121): ⏸ の位置は描き終わっている所（currentTime）。表示をそのコマへ進めてから SE を畳む（M11-9）。
      //  待っている間の ⏸ は、位置も畳んだ続きも始める前のまま（▶ でまた同じ所から）
      if (clock) this.playPaused = clock.pause();
      this.audioPreview.pause();
    } else {
      clock?.stop();
      this.audioPreview.stop();
      this.playPaused = null; // ⏸ でない止まり方は何周目かも捨てる
      this.playEnded = null;
    }
    this.playStateShown(false); // ★V213: ⏸ を ▶ に（画面・PC）
    if (this.mounted) this.renderCanvas();
    this.refreshSelectionLauncher();
  }

  // ---------------- 共通 ----------------

  protected pushBufferHistory(
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
    // ★V180 (A-78 ②): 描画・塗り・図形・文字・選択の移動／切り取り／消去…**ほぼ全部の 1 枚の操作**がここを通る。
    //  取り消し・やり直しの前に、そのコマを書きで起こす（大きい作品で窓の外へ出て眠ったコマは `layers[id]` が
    //  無く、起こさないと Ctrl+Z が黙って空振りする＝V178 の実測で 123 画素が消えたまま）。V178 と同じ形
    base.prepare = () => wakeFrame(self.project, frame, "write");
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
        colorRefs: base.colorRefs, // V195 (A-99)
        label,
        // V154 (W-2): base（バッファのスナップショット）を包むので、その申告を引き継ぐ
        //（マスクは 0/1 の Uint8Array・76.8KB に対して十分小さいが、同じ流儀で足す）
        bytes: (base.bytes ?? 0) + entryBytes(selBefore, selAfter),
        // ★V180 (A-78 ②): 包んだエントリにも起こす準備を運ぶ（pushWithSelection と同じ。運ばないと選択の移動・
        //  切り取りだけ眠ったコマで空振りする）
        prepare: base.prepare,
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
  protected pushSelectionHistory(
    label: string,
    before: Uint8Array | null,
    after: Uint8Array | null
  ) {
    const self = this;
    const frame = this.project.frames[this.frameIndex];
    const onFrame = () => self.project.frames[self.frameIndex] === frame;
    this.history.push({
      colorRefs: NO_COLOR_REFS /* 選択マスクだけ（0/1 は色ではない） */, // V195 (A-99)
      label,
      // ★V156 (P-2): **申告漏れその3**。before/after の選択マスク（`Uint8Array(PIXELS)` ×2＝
      //  最大 153,600 B）をクロージャが抱えているのに `bytes` が無かった
      bytes: entryBytes(before, after),
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

  protected afterLayerChange() {
    this.dirty = true;
    this.rebuildLayers();
    this.renderCanvas();
    this.paintFilmThumb(this.frameIndex);
    this.updateSizeMeter(); // V154 (W-2): レイヤーの増減で実体の数が変わる
  }

  /** M11-20: レイヤーのクリッピング on/off。**履歴に積む（undo 1回）**。
   *  フォルダ不透明度（rebuildLayers 内）と同じ「id 解決型」のエントリ＝restoreStructure でオブジェクトが
   *  差し替わっても id で引き直すので安全・他の属性（visible 等）を巻き戻さない。
   *  表示側は afterLayerChange（行の再構築＋本体＋ミニ＋現コマのフィルムサムネ）で即追従。
   *  バッファは触らない（clip は表示時のマスクだけ・REQ_M11_20 §1） */
  protected toggleLayerClipping(id: string) {
    const ld = this.project.layerDefs.find((l) => l.id === id);
    if (!ld) return;
    const to = ld.clip !== true;
    const apply = (v: boolean) => {
      const l = this.project.layerDefs.find((x) => x.id === id);
      if (!l) return;
      if (v) l.clip = true;
      else delete l.clip; // false は「キーなし」で表す（保存ファイルにも書かない）
      this.afterLayerChange();
    };
    this.history.push({
      colorRefs: NO_COLOR_REFS, // V195 (A-99)
      label: to ? "クリッピング ON" : "クリッピング OFF",
      undo: () => apply(!to),
      redo: () => apply(to),
    });
    apply(to);
  }

  private afterFrameStructureChange() {
    this.dirty = true;
    // M15 (K-1): コマの追加・複製・削除・並べ替え・挿入でバッファ参照が枝分かれし得るので、
    // 共通レイヤーを全コマ同一参照へ張り直す（共通でないレイヤーには触れない・参照代入のみ）
    relinkShared(this.project);
    // コマの追加/削除/並べ替え/挿入で範囲選択はインデックスがずれるためリセット
    this.rangeSel = null;
    this.rangeAnchor = null;
    this.syncPasteRangeLabel(); // V199 (A-105): 貼り付けボタンの「→ コマ a〜b」も外す
    // M11-9: コマ構造が変わったら、鳴っているSEと畳んだ「続き」を捨てる（gotoFrame と同じ扱い。
    // 消えたコマに置かれていた音が鳴り続けたり、あとから続きが鳴ったりしないように）
    this.audioPreview.stopSe();
    // ★V209 (A-121・REQ §2 (6)): 再生中にコマ数が変わったら（元に戻す・やり直すを含む）、今のコマから始め直したのと同じにする
    //  （曲は 1 周目のそのコマの位置・今のコマが無くなったら最後のコマ）。止まっている間なら ⏸ した位置（何周目か）を捨てる
    this.playPaused = null;
    this.playEnded = null;
    if (this.playing) {
      this.stopPlayback();
      void this.startPlayback();
    }
    // M11-8 P-4（REQ 表E）: コマの追加・削除・並べ替えは「コマの移動」を伴うので選択を解除する。
    // ここは undo/redo のクロージャからも呼ばれるため、履歴の適用中だけは触らない
    //（pushSelectionHistory が復元したマスクを直後に消してしまわないように）
    if (!this.applyingHistory) this.clearSelectionOnFrameMove();
    this.rebuildFilm();
    this.renderCanvas();
    this.redrawOverlay();
    this.updateSizeMeter(); // V154 (W-2): コマの増減で実体の数が変わる
  }

  protected refreshAll() {
    this.rebuildLayers();
    this.rebuildPalette();
    this.rebuildFilm();
    this.renderCanvas();
    this.redrawOverlay();
  }

  // ================= ★V213 (M-2a): 描く入力の口（サンプル） =================
  // PC の Editor は画面の出来事（onPointerDown / Move / Up）を受けて、下の**片**（strokeSettle・strokeLocked・
  // strokeStart・strokeMoveOne・strokeMoveDone・strokeFinish）を**この回の前と同じ順番**で呼ぶ
  // （関所 → 捕捉 → パン → 描き始め。捕捉とパンは PC の仕事なので、片の間に PC が挟まる）。
  // モバイルの画面は、片を同じ順で束ねた strokeBegin / strokeMove / strokeEnd を呼ぶ（捕捉もパンも無い）。
  // サンプルの x・y は `clientToPixelF` の結果そのもの（画素 n が [n, n+1) を占める小数）。
  // `Math.floor` と、線に渡す半画素ずらしはここ（コア）で行う。`pointerType` は受け取らない（親 §6-9）。

  /** サンプルの画素（`Math.floor`）。前の `clientToPixel` と同じ計算 */
  protected samplePixel(s: StrokeSample): { x: number; y: number } {
    return { x: Math.floor(s.x), y: Math.floor(s.y) };
  }

  /** 線に渡す座標（半画素ずらす）。前の `clientToStrokePt` と同じ計算。
   *  ★なぜ半画素引くのか: サンプルは「画素 n が [n, n+1) を占める」座標系（＝`Math.floor` で画素に落ちる）。
   *  `raster.ts` の `strokeSegment` / `stamp` は `Math.round` で画素に落とす＝「画素 n が [n−0.5, n+0.5) を占める」座標系。
   *  半画素引けば `Math.round` の結果が `Math.floor` と一致し、カーソルの指す画素と描かれる画素が揃う */
  protected sampleStrokePt(s: StrokeSample): { x: number; y: number } {
    return { x: s.x - 0.5, y: s.y - 0.5 };
  }

  /** 押す前の後始末（前のなぞりが最後まで通っていなかったときの網）。PC は再生の関所と自己修復のあとに呼ぶ */
  protected strokeSettle(): void {
    // ★V178 (A-72・独立レビューの指摘): 網。全レイヤーの束が確定されないまま残っていたら（入口で畳み、ほかの履歴を積む直前にも
    //  確定するので、知られている経路では起きない）、**次のストロークの pointermove が古い束（古いコマ）へ描く**ので、
    //  ここで必ず確定してから始める
    // ★V191 (A-89): 網。前のなぞりの 1px の仮が残っていたら、そのなぞりは pointerup を最後まで通っていない。
    //  1 枚の経路の分は打たずに捨て（dropStaleLine1px・いま選んでいるコマ・レイヤーへ履歴の外に打たない）、
    //  束の分は束がまだ残っていれば束の確定より先に打つ（束に入る＝Ctrl+Z 1 回で戻る）
    this.dropStaleLine1px();
    this.endLine1px();
    if (this.eraseAllStroke) this.commitEraseAll(); // 取りこぼした束を先に確定（次の 1 枚の経路を乗っ取らせない）
  }

  /** 描けないとき true（ロック中のレイヤー・全レイヤーの束が作れない）。トーストはここで出る。
   *  ★V157 (D-1): ロック中のレイヤーには描かせない。PC は**捕捉する前に**呼ぶ（掴みっぱなしを作らない）。
   *  変形の途中（`xformActive`）は素通し——始められた時点でロックされていないと分かっているし、
   *  ここで止めると確定できずに宙に浮く。
   *  ★V178 (A-72): 全レイヤー消しゴムは「いまのレイヤー」の 🔒 ではなく**対象の束**で決める
   *  （🔒 のレイヤーは対象から外れるだけ＝移動・変形の `moveTargetLayerIds` と同じ線引き）。
   *  PC は Space のパンの最中なら呼ばない（パンは描かない） */
  protected strokeLocked(): boolean {
    return (
      !this.xformActive &&
      EditorCore.PIXEL_TOOLS.has(this.tool) &&
      (this.eraseAllOn() ? this.eraseAllGuard() : this.lockGuard())
    );
  }

  /** 描き始め（押した点）。`pointerDown` を立てて、道具ごとに始める。
   *  戻り値は PC が続けてする画面の仕事の印（変形の取っ手を掴んだ・スポイトで拾った・文字を掴んだ） */
  protected strokeStart(s: StrokeSample): "" | "xform" | "picked" | "textDrag" {
    const pt = this.samplePixel(s);
    this.pointerDown = true;

    if (this.xformActive && this.floatBuf) {
      this.beginTransformDrag(pt);
      return "xform";
    }

    switch (this.tool) {
      case "pen":
      case "brush":
      case "eraser": {
        // 色解決（penOptions→currentColorIndex）が16bit昇格でバッファを差し替えることが
        // あるため、必ずオプション解決後にバッファを取り直す
        // M17: マイ柄はここで**全色を一括解決**して strokeTone に固定（move では再解決しない）。
        // この順序（解決→penOptions→activeBuffer）が 257 色目を跨ぐストロークの安全の要
        this.strokeTone = { kind: this.tool, ...this.resolveToneFor(this.tool) };
        const o = this.penOptions(s.pressure);
        // ★V178 (A-72): 全レイヤー消しゴムは「対象の束」へ打つ。オフなら multi=false＝ここから下は
        //  従来の 1 枚の経路と同じ文の並び。束が作れないときも 1 枚の経路へは落とさない（buf2 は null のまま）
        const multi = this.eraseAllOn();
        const all = multi ? this.beginEraseAll() : null;
        const buf2 = multi ? null : this.activeBuffer();
        if (!all && !buf2) return "";
        this.strokeBefore = buf2 ? copyIndexBuf(buf2) : null;
        this.strokeSeed = (Math.random() * 1e9) | 0;
        this.dashAcc = { d: 0 };
        o.seed = this.strokeSeed;
        o.dashAcc = this.dashAcc;
        // ★A-70: 描線の経路だけ**小数のまま**持つ（関節ごとの丸め誤差を無くす）。
        //  ⚠ 最初の打点は**従来どおり整数の `pt`**（＝`floor`）で打つ。小数を丸め直すと
        //   カーソルの指す画素と 1 ドットずれる（独立レビューの指摘）
        const ptF = this.sampleStrokePt(s);
        this.smoothPt = { x: ptF.x, y: ptF.y };
        this.lastPt = { x: ptF.x, y: ptF.y };
        if (buf2) R.stamp(buf2, pt.x, pt.y, o);
        else if (all) this.eraseAllStamp(all, pt.x, pt.y, o);
        // ★V191 (A-89): 太さ 1 なら、この打点（整数の pt＝round(lastPt) と同じ画素）を「確定した直前の画素」として
        //  1px の道を始める。押した瞬間の打点そのものは今のまま
        this.line1px = L1.uses1px(o) ? { st: L1.line1pxBegin(pt.x, pt.y), all } : null;
        this.renderCanvas();
        break;
      }
      case "fill": {
        // M14 (S-2): 囲い塗り — ドラッグで軌跡を集め、離した瞬間に内側を塗る（確定は strokeFinish）。
        // ここでは軌跡の起点を置くだけ（バケツのような即時 flood はしない）
        if (this.fillMode === "enclose") {
          this.enclosePts = [{ x: s.x, y: s.y }]; // V208 (A-119): 小数のまま
          break;
        }
        // M17: マイ柄なら先に**全色を一括解決**（昇格し得る）。既存トーンは従来どおり tile を引くだけ
        const fillSel = this.resolveToneFor("fill");
        const color = this.currentColorIndex(); // 昇格し得るので先に解決
        const buf2 = this.activeBuffer();
        if (!buf2) return "";
        const before = copyIndexBuf(buf2);
        // M10-19: 全レイヤー参照 — 領域判定は平坦化した参照バッファ・塗るのは編集レイヤーだけ
        //（平坦化は色解決＝昇格の後に作る。ref 省略時は従来経路そのまま）
        const ref = this.fillRefAll
          ? flattenIndexFrame(this.project, this.frameIndex)
          : undefined;
        if (fillSel.colorTile) {
          // M17: マイ柄のバケツ（領域確定は従来と同じ規則・塗り込みは色タイル）
          CT.floodFillColorTile(buf2, pt.x, pt.y, fillSel.colorTile, ref, this.selMask ?? undefined, this.toneShiftForDraw());
        } else {
          // M5-5 T-3: トーン塗り（座標固定＝ブラシのトーンと柄が繋がる）。ベタ=従来どおり
          // M10-22: 選択中は clip=0 を壁として範囲内だけ塗る
          R.floodFill(
            buf2,
            pt.x,
            pt.y,
            color,
            fillSel.tone,
            ref,
            this.selMask ?? undefined,
            this.toneShiftForDraw() // M16 (D-1): コマ間シフト（オフ時 0＝従来どおり）
          );
        }
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
          return "textDrag";
        }
        void this.beginTextDraft(pt);
        break;
      }
      case "eyedrop": {
        this.pickColor(pt);
        // M10-21b: pick 後の同一接触では何も起きないようにする。pickColor → setTool で
        // ツールが pen 等へ切り替わったまま pointerDown が立っていると、接触が続く同じペンが
        // 「拾った色のストローク」を描いてしまう（実走ログ 1012–1015 行の実害）。
        // pointerDown を下ろし、この接触の move/up を素通しにする（PC はキャプチャも解放する）
        this.pointerDown = false;
        return "picked";
      }
      case "move": {
        // M11-8 P-2: 選択範囲があれば「範囲の中の絵だけ」、無ければレイヤー（フォルダなら中身全部）
        if (this.selMask) this.beginSelectionMove(pt);
        else this.beginLayerMove(pt);
        break;
      }
      case "select": {
        // M13-2a (A-1): 合成方法は**押した瞬間の修飾キー**で決める（途中で押し変えても変わらない）。
        // Shift は図形ツールの拘束（`tool === "shape"` の分岐）とは別の経路＝衝突しない
        this.selMod = s.shift ? "add" : s.alt ? "sub" : "replace";
        if (this.selMod === "replace" && this.selMask && this.selMask[pt.y * W + pt.x]) {
          // M11-8 P-1: 範囲内のドラッグは**枠だけ**が動く（絵は動かない）。
          // 絵を動かすのは移動ツール（上の case "move"）。
          // M13-2a: 足す／引くのときは枠を動かさず、新しい範囲を描き始める
          this.beginSelMaskMove(pt);
        } else if (this.selectKind === "auto") {
          // M10-19: ✨自動 — クリックで即マスク生成。
          // 生成した selMask の下流（点線・移動・コピー・削除・変形）は既存のまま
          // M13-2a: 参照の「選択中」は、選択中のレイヤー（フォルダは展開・非表示は除外）の合成。
          // 1枚だけ選んでいれば従来の `activeBuffer()` と同じ結果になる
          const ref = this.selectRefAll
            ? flattenIndexFrame(this.project, this.frameIndex)
            : this.flattenSelectedLayers();
          if (!ref) return "";
          this.applySelectionResult("auto", R.autoSelectMask(ref, pt.x, pt.y, this.selectAutoGlobal));
        } else if (this.selectKind === "rect") {
          this.shapeStart = pt;
        } else {
          this.lassoPts = [{ x: s.x, y: s.y }]; // V208 (A-119): 小数のまま
        }
        break;
      }
      case "warp": {
        if (this.warpMode === "corner") {
          // M10-2c: 四隅はモード開始時に場を用意済み。ここではハンドルを掴むだけ
          if (!this.cornerActive) break;
          // 一番近いハンドルを掴む。しきい値はドット単位で ±8
          // （transform の四隅は ±6。四隅同士が近づいたときに取り違えないよう少し大きめ）。
          // M13-2b (T-1): 8ハンドル（四隅4＋辺の中央4）。枠が小さくて重なるときは**近いほう**が勝つ＝仕様
          //（当たり判定のしきい値で逃げる実装は入れない・REQ §6-1-4）
          let best = -1;
          const cornerHit = this.xformHitSizes().corner; // ★V214: 画面の側が決める（PC は 8）
          let bestD = cornerHit * cornerHit + 1;
          const hs = this.cornerHandles();
          for (let i = 0; i < hs.length; i++) {
            const hdx = hs[i].x - pt.x;
            const hdy = hs[i].y - pt.y;
            const d2 = hdx * hdx + hdy * hdy;
            if (d2 < bestD) {
              bestD = d2;
              best = i;
            }
          }
          this.cornerDrag = best >= 0 ? best : null;
          this.cornerDragBase =
            best >= 0 ? { pts: this.cornerPts.map((p) => ({ ...p })), start: { x: pt.x, y: pt.y } } : null;
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
    return "";
  }

  /** 動いた点 1 つ（PC は coalesced の 1 点ずつ呼ぶ）。戻り値: "xform"＝変形の取っ手を動かした（PC はモードの札を追従）・
   *  "trail"＝囲んでいる途中の線を伸ばした（strokeMoveDone で 1 回だけ描き直す） */
  protected strokeMoveOne(s: StrokeSample): "" | "xform" | "trail" {
    const pt = this.samplePixel(s);
    if (this.xformActive && this.dragMode) {
      this.updateTransformDrag(pt, s.shift);
      return "xform";
    }
    switch (this.tool) {
      case "pen":
      case "brush":
      case "eraser": {
        // ★V178 (A-72): 全レイヤーのストロークは対象の束へ（null なら従来の 1 枚の経路そのまま）
        const all = this.eraseAllStroke;
        const buf = all ? null : this.activeBuffer();
        if ((!all && !buf) || !this.lastPt) break;
        // ★A-70: この経路だけ**小数のまま**受け取る（`pt` は整数版で、他の道具が使う）。
        //  丸めるのは打点の瞬間だけ＝`strokeSegment` の中（`raster.ts` は触らない）
        const ptF = this.sampleStrokePt(s);
        let tx = ptF.x;
        let ty = ptF.y;
        if (this.stabilizer && this.smoothPt) {
          // 手ブレ補正: EMA（OFF でも掛けないだけ＝3DS 準拠の生座標という約束はそのまま。
          // ★A-70 で外したのは「丸め」であって EMA ではない。係数 0.35 も変えていない）
          this.smoothPt.x += (ptF.x - this.smoothPt.x) * 0.35;
          this.smoothPt.y += (ptF.y - this.smoothPt.y) * 0.35;
          tx = this.smoothPt.x;
          ty = this.smoothPt.y;
        }
        // ★V191 (A-89): 太さ 1 の線分は 1px の道（描く前に決める・`line1pxSegment`）。それ以外は今までどおり
        //  strokeSegment。筆圧で太さが 1 以外になったら、仮の画素を打って状態を空にしてから（漏斗）今までの道で描き、
        //  また太さ 1 の線分が来たら、その線分の始点から始め直す
        if (buf) {
          const o = this.penOptions(s.pressure);
          if (L1.uses1px(o)) this.line1pxSegment(this.lastPt.x, this.lastPt.y, tx, ty, o, buf, null);
          else {
            this.endLine1px();
            R.strokeSegment(buf, this.lastPt.x, this.lastPt.y, tx, ty, o);
          }
        } else if (all && this.tool === "eraser") {
          // ★V178: 途中でショートカットが道具を変えたら、束にはもう描かない（penOptions が新しい道具の
          //  色を返す＝ペンの色で全レイヤーを塗る事故になる）。確定は strokeFinish（道具に関係なく）
          const o = this.penOptions(s.pressure);
          if (L1.uses1px(o)) this.line1pxSegment(this.lastPt.x, this.lastPt.y, tx, ty, o, null, all);
          else {
            this.endLine1px();
            this.eraseAllSegment(all, this.lastPt.x, this.lastPt.y, tx, ty, o);
          }
        }
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
      case "fill": {
        // M14 (S-2): 囲い塗りの軌跡を伸ばす。V208 (A-119): 自由選択と同じく小数の点を TRAIL_STEP おきに
        //  （線は画面解像度の層だけ・まとめて 1 回。選択はまだ変わらないので redrawOverlay は呼ばない）
        if (this.fillMode === "enclose" && this.enclosePts.length) {
          const pf = { x: s.x, y: s.y };
          const last = this.enclosePts[this.enclosePts.length - 1];
          if (Math.hypot(pf.x - last.x, pf.y - last.y) >= TRAIL_STEP) this.enclosePts.push(pf);
          return "trail";
        }
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
          // V208 (A-119): 点は小数のまま（A-70 と同じ考え）・前の点から TRAIL_STEP ドット離れたら足す。
          //  線は画面解像度の層だけ（まとめて 1 回・選択はまだ変わらないので redrawOverlay は呼ばない）
          const pf = { x: s.x, y: s.y };
          const last = this.lassoPts[this.lassoPts.length - 1];
          if (Math.hypot(pf.x - last.x, pf.y - last.y) >= TRAIL_STEP) this.lassoPts.push(pf);
          return "trail";
        }
        break;
      }
      case "warp": {
        // coalesced の各点では**場に加算するだけ**。適用はまとめて1回だけ（strokeMoveDone）。
        // レイヤー10枚なら1適用で 768K 画素のループになるので、点ごとに適用すると詰まる
        if (this.warpMode === "corner") {
          // M10-2c: 掴んでいるハンドルの位置を更新するだけ。適用はまとめて1回。
          // M13-2b (T-1): 四隅＝その1点／辺＝両端2点を法線方向へ（`cornerTrial`）。
          // キャンバスの外へ出す移動・非凸になる移動は受け付けない（直前の位置に留まる）
          if (this.cornerDrag === null || !this.cornerDragBase) break;
          const trial = this.cornerTrial(this.cornerDrag, this.cornerDragBase.pts, this.cornerDragBase.start, pt);
          if (!trial) break;
          if (trial.every((p, i2) => p.x === this.cornerPts[i2].x && p.y === this.cornerPts[i2].y)) break;
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
    return "";
  }

  /** 動いた点をまとめて受けたあと 1 回だけ（囲みの線の描き直し・歪みの適用・描き直し） */
  protected strokeMoveDone(trailMoved: boolean): void {
    if (trailMoved) this.paintSelectionUi(); // V208 (A-119)
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

  /** 離した（`pointerDown` を下ろしたあと）。道具ごとに確定する */
  protected strokeFinish(s: StrokeSample): void {
    // ★V191 (A-89): 1px の線の仮の 1 画素（ペン先）を、いまの道具に関係なく**ここで**打つ。束の確定（commitEraseAll）と
    //  1 枚の履歴（pushBufferHistory）より**前**——後ろだと最後の 1 画素が取り消しの束に入らない（v191_smoke [S-4]・[S-11]）
    this.endLine1px(); // ★V191 (A-89): 描き終わりの漏斗（pointerup）
    // ★V178 (A-72): 全レイヤーのストロークは、いまの道具に関係なく**ここで**確定する
    //  （途中でショートカットが道具を変えても、消した分を履歴に積まずに取り残さない）
    if (this.eraseAllStroke) this.commitEraseAll();
    const pt = this.samplePixel(s);

    if (this.xformActive && this.dragMode) {
      this.dragMode = "";
      this.xformDragEnded(pt); // PC: モードの札を消す・カーソルを当たりに合わせる
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
          this.cornerDragBase = null;
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
        // ストローク1回＝履歴1エントリ。実体は適用時に解決する（構造undo対策）。
        // ★V180 (A-78 ①): 戻し先は**歪ませたコマ**（Frame オブジェクト `f`）で引く。以前は適用時の
        //  `this.frameIndex`＝Ctrl+Z を押した時点で見ているコマで引いていたので、コマを移ってから取り消すと
        //  **別のコマへ書き戻していた**（V178 の実測: コマ 5 の 6,800 画素がコマ 0 の絵で上書き）。
        //  `pushBufferHistory`・変形・「消す」・全レイヤー消しゴムと同じ持ち方
        const warpEntry = multiBufferChangeEntry(
          "歪み",
          (layerId) => f.layers[layerId] ?? null,
          beforeDiff,
          afterDiff,
          () => {
            // M10-23: Undo/Redo もデータ変更なので dirty にする（四隅変形と同じ）
            this.dirty = true;
            this.renderCanvas();
            // ★V180: 塗り直すのも歪ませたコマのサムネ（見ているコマではない）
            const fi = this.project.frames.indexOf(f);
            if (fi >= 0) this.paintFilmThumb(fi);
          }
        );
        // ★V180 (A-78 ②): 取り消し・やり直しの前に、そのコマを書きで起こす（眠っていると黙って空振りする）
        warpEntry.prepare = () => wakeFrame(this.project, f, "write");
        this.history.push(warpEntry);
        this.dirty = true;
        this.renderCanvas();
        this.paintFilmThumb(this.frameIndex);
        break;
      }
      case "fill": {
        // M14 (S-2): 囲い塗りの確定。「軌跡＋始点終点を結んだ閉じ」の内側を、現在色（トーン選択中は柄）で塗る。
        // 実装は自由選択のマスク生成（lassoMask=多角形→走査線）＋ A-3 の塗り込みエンジンの合成（新規ラスタライザなし）
        if (this.fillMode === "enclose") {
          const pts = this.enclosePts;
          this.enclosePts = [];
          if (pts.length >= 3) {
            const mask = R.lassoMask(pts); // 始点と終点は自動で結ばれる（(i+1)%n）
            // 選択範囲があればその中だけ（範囲外は1ドットも変えない）
            if (this.selMask) for (let i = 0; i < PIXELS; i++) if (!this.selMask[i]) mask[i] = 0;
            let cnt = 0;
            for (let i = 0; i < PIXELS; i++) if (mask[i]) cnt++;
            // 極小の囲いは何もしない（誤タッチ対策・トーストも出さない）
            // M17: マイ柄なら resolveToneFor が全色を一括解決（昇格し得る）→ fillMaskWithCurrentColor 内でバッファ取得の順
            if (cnt >= ENCLOSE_MIN_PX) this.fillMaskWithCurrentColor(mask, this.resolveToneFor("fill"), this.toneShiftForDraw());
          }
          // ドラッグ中の破線プレビューは**必ず**消す。fillMaskWithCurrentColor は「変化ゼロ」だと
          // 早期 return して redrawOverlay を呼ばない（同じ色で二度囲う・透明で空領域を囲う等）ので、
          // ここで無条件に描き直す（enclosePts は空にした後なので軌跡は消える・二度描画は無害）
          this.redrawOverlay();
        }
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
        this.clearOverlay();
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
          if (this.shapeStart.x === pt.x && this.shapeStart.y === pt.y) {
            // ドラッグなしの素クリック＝選択解除（1pxの見えない選択が clip で
            // 全描画を無音で封じる事故の防止。マーキー系ツールの標準挙動でもある）。
            // M13-2a: 足す／引くの素クリックは「何も足さない／引かない」＝何もしない
            if (this.selMod === "replace") {
              const selBefore = this.selMask ? this.selMask.slice() : null;
              if (selBefore) this.pushSelectionHistory("選択解除", selBefore, null);
              this.selMask = null;
            }
          } else {
            // M10-22: 選択の作成・置換を履歴へ（applySelectionResult の中で before=直前のマスク）
            this.applySelectionResult("drag", R.rectMask(this.shapeStart.x, this.shapeStart.y, pt.x, pt.y));
          }
          this.shapeStart = null;
          this.redrawOverlay();
        } else if (
          this.selectKind === "lasso" &&
          this.lassoPts.length > 2 &&
          // V208 (A-119): 点を細かく取るので、ペンの揺れだけで点が 3 つ以上になる。始点から 1 ドット以上離れたことが
          //  無ければ、今までの「点が 2 つ以下」と同じ（下の else＝選択も履歴も変えない）
          !trailStayedNearStart(this.lassoPts, 1)
        ) {
          const lm = R.lassoMask(this.lassoPts);
          if (lm.some((v) => v !== 0)) {
            this.applySelectionResult("drag", lm);
          } else if (this.selMod === "replace") {
            // 囲めていない軌跡（面積ゼロ）＝選択解除（全0マスクはアンツが1画素も
            // 出ず、clip で描けない原因が見えなくなるため選択として扱わない）
            const selBefore = this.selMask ? this.selMask.slice() : null;
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

  // ---------------- 束ねた口（モバイルの画面が呼ぶ。PC は呼ばない＝片を自分の順で呼ぶ） ----------------

  /** 束ねた口の自己修復で使う、最後のサンプル（PC の `lastPointerEvent` と同じ役） */
  private lastSample: StrokeSample | null = null;

  /** 押した。PC の onPointerDown と同じ順番: 重い処理の関所 → 再生中なら止めて描かない → 前の接触の自己修復 →
   *  後始末の網 → 修飾キー → ロックの関所 → 描き始め */
  strokeBegin(s: StrokeSample): void {
    if (this.busyKind) return;
    // M11-9 P-2: 再生中に触れたら**再生を止める**。ただし**その接触では描かない**（描きたければもう一度触れる）
    if (this.playing) {
      this.stopPlayback();
      return;
    }
    // M11-5: 前の接触が離さないまま終わっていたら、ここで畳んでから始める（最後の位置で離したことにする）
    if (this.pointerDown) {
      const last = this.lastSample;
      if (last) this.strokeEnd(last);
      this.dropStaleLine1px();
      this.pointerDown = false;
      this.strokeTone = null;
    }
    this.strokeUndoSnap = null;
    this.strokeSettle();
    this.shiftHeld = s.shift;
    if (this.strokeLocked()) return;
    this.strokeUndoSnap = this.takeStrokeSnap();
    this.lastSample = s;
    this.strokeStart(s);
  }

  /** 動いた（1 回の出来事でまとめて届いた点を古い順に）。PC の onPointerMove と同じ: 押していなければ何もしない */
  strokeMove(samples: readonly StrokeSample[]): void {
    if (this.busyKind) return;
    const tail = samples[samples.length - 1];
    if (!tail) return;
    this.shiftHeld = tail.shift; // M10-7: pointer 側の modifier を真実として同期
    if (!this.pointerDown) return;
    this.lastSample = tail;
    let trailMoved = false;
    for (const s of samples) if (this.strokeMoveOne(s) === "trail") trailMoved = true;
    this.strokeMoveDone(trailMoved);
  }

  /** 離した。PC の onPointerUp と同じ: 解決済みのトーンは捨てる → 押していなければ何もしない → 確定。
   *  ★V214 (§5-1 の 1・§5-5 の 6): 戻り値＝**この接触で履歴が積まれたか**（押してから離すまでで測る。バケツと自動選択は
   *  押した瞬間に積む＝それも入る）。ロックしたレイヤー・動かしていない移動・変形の取っ手・何も変わらなかった歪みなど、
   *  確定しても積まない道では false（そのまま取り消すと、前の別の操作を消してしまう）。同じ値を lastStrokePushed にも置く */
  strokeEnd(s: StrokeSample): boolean {
    if (this.busyKind) return false;
    const snap = this.strokeUndoSnap;
    this.lastStrokePushed = false;
    this.lastSample = null;
    this.strokeUndoSnap = null;
    this.strokeTone = null; // M17: ストロークの解決済みトーンは離したら捨てる（次は押したときに解決し直す）
    if (!this.pointerDown) return false;
    // M10-7: 確定時の拘束は**離した瞬間の** Shift 状態で決める
    this.shiftHeld = s.shift;
    this.pointerDown = false;
    this.strokeFinish(s);
    this.lastStrokePushed = !!snap && snap.project === this.project && this.history.pushedSince(snap.hist);
    return this.lastStrokePushed;
  }

  /** ★V214: 最後に strokeEnd で離した接触で履歴が積まれたか（strokeEnd の戻り値と同じ） */
  lastStrokePushed = false;

  /** 修飾キーだけが変わった（描いている途中に Shift を押す・離すなど。PC のキーボードとモバイルの画面のボタン）。
   *  M10-7: 図形の Shift 拘束を**動かさずに**即反映する（図形でドラッグ中でなければ何もしない） */
  modifiersChanged(m: { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean }): void {
    if (m.shift === this.shiftHeld) return;
    this.shiftHeld = m.shift;
    this.refreshShapePreview();
  }

  // ---------------- ★V213 (決-6): やめる口 ----------------

  /** やめる口の控え（strokeBegin で取り、strokeEnd・strokeCancel で捨てる）。null＝この接触は控えていない */
  private strokeUndoSnap: StrokeCancelSnap | null = null;

  /** ★V213 (決-6) → ★V214 (決-14): やめた。押してからこの接触で作品・選択・色・道具に起きた変化を押す前に戻す。履歴は積まない
   *  （積んでいたら取り除く）。モバイルの振り分け層が**長押しのスポイト**で呼ぶ（押した所に付いた点を消してから色を拾う。
   *  消さないと自分の点の色を拾い、取り消しの列にも点が残る）。手のひらと分かった指の線にはこれを使わない——
   *  確定して（strokeEnd）、その接触で履歴が積まれていれば（strokeEnd の戻り値・lastStrokePushed）取り消す（親 §6-2）。
   *  ★PC は呼ばない（PC の動きは変えない）。
   *  戻り値（★V214）:
   *   - "none"     何もしなかった: 控えが無い（押していない・束ねた口で押していない・ロックで描かなかった）・重い処理の最中・
   *                変形の途中で取っ手を掴んでいない・文字の下書きの途中・再生中・作品が替わった
   *   - "restored" 押す前に戻した
   *   - "asleep"   そのコマ（の押した時点のレイヤー）が眠っていて画素を戻せない。**画素も履歴も描きかけも何も変えない**
   *                （呼んだ側は、確定して〔strokeEnd〕、その接触で積まれていれば取り消す＝§5-7） */
  strokeCancel(): "none" | "restored" | "asleep" {
    const snap = this.strokeUndoSnap;
    if (!snap) return "none";
    if (this.busyKind || this.playing) return "none";
    if (this.textDraft || snap.tool === "text") return "none";
    if (this.xformActive && !this.dragMode) return "none";
    if (snap.project !== this.project) {
      this.strokeUndoSnap = null;
      return "none";
    }
    // ★V214: 戻す先のバッファが揃っているかを、何かを変える前に見る（眠ったレイヤーは f.layers に無い＝黙って空振りしていた）
    const f0 = this.project.frames[snap.frameIndex];
    if (!f0 || Object.keys(snap.bufs).some((id) => !f0.layers[id])) return "asleep";
    this.strokeUndoSnap = null;
    this.lastSample = null;
    // 描きかけを捨てる（打たない・確定しない）
    this.clearFisheyeRepeat();
    this.line1px = null;
    this.eraseAllStroke = null;
    this.strokeBefore = null;
    this.strokeTone = null;
    this.lastPt = null;
    this.smoothPt = null;
    this.shapeStart = null;
    this.shapeLastPt = null;
    this.lassoPts = [];
    this.enclosePts = [];
    this.warpField = null;
    this.warpBefore = null;
    this.warpLastPt = null;
    this.warpCenter = null;
    this.cornerDrag = null;
    this.cornerDragBase = null;
    this.textDrag = null;
    this.selMaskDrag = null;
    this.layerDrag = null;
    this.selMoveBefore = null;
    this.dragStart = null;
    this.dragBase = null;
    this.dragMode = "";
    this.pointerDown = false;
    // 画素: そのコマの全レイヤーを押す前へ（16bit へ昇格していても値で写す＝幅は今のまま）
    const f = f0;
    for (const [id, b] of Object.entries(snap.bufs)) f.layers[id].set(b);
    // 選択・浮いている絵・変形の値・四隅
    this.selMask = snap.selMask;
    this.floatBuf = snap.floatBuf;
    this.xform = snap.xform;
    if (snap.cornerPts) this.cornerPts = snap.cornerPts;
    // 履歴: 押す前の並びへ（この接触で積んだものを取り除く。やり直しの側も押す前に戻る）。★V214: history.ts の口で
    this.history.restoreMark(snap.hist);
    // 色と道具（スポイトが変えたもの）
    this.colorHex = snap.colorHex;
    if (this.tool !== snap.tool) this.setTool(snap.tool);
    this.prevTool = snap.prevTool;
    this._dirty = snap.dirty;
    this.clearOverlay();
    this.renderCanvas();
    this.redrawOverlay();
    this.paintUiOverlay();
    this.paintFilmThumb(snap.frameIndex);
    this.refreshSelectionLauncher();
    return "restored";
  }

  /** やめる口の控え。押した時点のコマの全レイヤー・選択・浮いている絵・変形の値・履歴の並び・色・道具 */
  private takeStrokeSnap(): StrokeCancelSnap | null {
    const f = this.project.frames[this.frameIndex];
    if (!f) return null;
    const bufs: Record<string, IndexBuf> = {};
    for (const [id, b] of Object.entries(f.layers)) bufs[id] = copyIndexBuf(b);
    return {
      project: this.project,
      frameIndex: this.frameIndex,
      bufs,
      selMask: this.selMask ? this.selMask.slice() : null,
      floatBuf: this.floatBuf,
      xform: { ...this.xform },
      cornerPts: this.cornerActive ? this.cornerPts.map((p) => ({ ...p })) : null,
      hist: this.history.mark(),
      colorHex: this.colorHex,
      tool: this.tool,
      prevTool: this.prevTool,
      dirty: this._dirty,
    };
  }

  /** ★V214 (M-2b-1a): Esc の単押しが作品に効く所（前は PC の onKeyDown の中・字は同じ）。取り消す順: 文字の下書き → 矢印の移動 →
   *  選択の枠の移動 → レイヤーの移動は、それだけ取り消して戻る。どれでもなければ、変形と四隅を取り消し（選択を外すより先に）、選択も外す。
   *  PC の形式の帯を畳む・行とコマの並べ替えと仕切りのドラッグを止めるのは、この前に画面の側で */
  protected escapeKey(): void {
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

  /** ★V214: Backspace の単押し（選択があるときの選択の消去・固定の最優先）。受け取ったかを返す（選択が無ければ受け取らない＝
   *  画面の側が割り当てへ流す）。押しっぱなしのくり返しでは消さない（M11-9）が、受け取りはする（前と同じ） */
  protected backspaceKey(repeat: boolean): boolean {
    if (this.selMask) {
      // M11-9: 押しっぱなしのキーリピートで履歴を空エントリで埋めない
      if (!repeat) {
        this.endArrowSession(); // M11-10: 消す前に移動を確定（別の操作）
        this.deleteSelection();
      }
      return true;
    }
    return false;
  }

  /** ★V214: Enter の単押しが作品に効く所（文字の確定〔primary＝Ctrl／Mac は ⌘〕→ 変形 → 四隅を確定 → 矢印の移動を確定）。
   *  受け取ったかを返す（画面の側がそれで既定の動きを止める）。受け取らなければ画面の側がボタンの Enter と割り当てへ流す */
  protected enterKey(primary: boolean): boolean {
    // M11-12: Ctrl+Enter=浮動テキストの確定（入力欄の外にフォーカスがある場合。
    // 入力欄の中では、そちらの keydown が同じことをする）。V181: Mac は ⌘Enter でも（`primaryMod`）
    if (this.textDraft && primary) {
      this.commitTextDraft();
      return true;
    }
    // E-4: Enter=変形確定（変形中・四隅変形中は確定が優先）
    if (this.xformActive) {
      void this.commitTransform();
      return true;
    }
    if (this.cornerActive) {
      void this.commitCornerWarp();
      return true;
    }
    // M11-10: 矢印キーでの移動セッションの明示的な確定
    if (this.arrowKind) {
      this.endArrowSession();
      return true;
    }
    return false;
  }

  /** M3.8: Shift範囲選択の起点（最後に普通クリックした node）（★V214: 前は PC のフィールド・行の選択がコアへ来た） */
  protected selAnchorId: string | null = null;
  /** 合成のバッファ（★V214: 前は PC のフィールド・字は同じ） */
  protected composite = new Uint32Array(PIXELS);
  /** 起こし直しの世代（追い越しで古い結果を描かないための番号）（★V214: 前は PC のフィールド） */
  protected wakeGen = 0;

  /** ★V214 (M-2b-1a): 絵を描き直す中身（前は PC の renderCanvas の上書き・字は同じ）。眠ったコマを起こしてから描く・1px の線の仮を打つ・
   *  オニオンの重ね方を決めて絵を作る。**見せる処理（present）は、1px の仮を打ったまま呼ぶ**（PC はキャンバスへ出す・紙の市松・ミニ。
   *  ミニにも仮の点が出る）。present が例外を投げても仮は必ず戻す（finally）。起こしている間の待ちの印は showWaitBadge（画面） */
  protected renderWork(present: (composite: Uint32Array) => void): void {
    // ★V156 (P-1): 描くのに要るコマ（表示中＋オニオンが読む前後3）がまだ眠っていたら、
    //   **前の絵を消さずに**起こしてから描き直す。
    //
    //   ここを入口の1か所にしてあるので、`frameIndex` を直に動かす経路（コマの挿入・削除・
    //   並べ替え・undo の中の12箇所）を1つも書き換えずに済む。白い一瞬も作らない——
    //   起きるまでの十数 ms は前のコマが出たままで、揃ったら差し替わる。
    //   `wakeGen` は追い越し対策（速く連打したとき、古い起こし結果で描き戻さない）。
    if (this.sleepOn && !this.frameReady()) {
      const gen = ++this.wakeGen;
      // V156（独立レビュー §4・優先度 中）: 前の絵を残すので白紙にはならないが、
      // タイムラインの選択だけ先に進むので「押せていない」「違うコマを見ている」に見える余地がある。
      // **目に見える長さ（150ms）を超えたときだけ**小さな札を出す。
      // 中央の重い表示（W-8）も操作ロックもしない——ふつうは 30ms 台で終わるので、出ないのが既定
      const badgeTimer = setTimeout(() => {
        if (gen === this.wakeGen) this.showWaitBadge(true);
      }, 150);
      void this.ensureSleepWindow().then(() => {
        clearTimeout(badgeTimer);
        // ★V209 (A-121・R-11): 再生中は、起こし終わるまでにコマが先へ進んでいることがある（コマを飛ばすと起こしが追い越される）。
        //  窓の外で起きたままのコマを只で片付ける（追い越された起こしで、起きているコマが増え続けないように）
        if (this.mounted && this.playing) this.trimPlayWindow();
        if (this.mounted && gen === this.wakeGen) {
          this.showWaitBadge(false);
          this.renderCanvas();
        }
      });
      return;
    }
    // ★V209 (A-122): 1px の描きかけの仮の 1 ドットを、合成のときだけ打って見せる（finally で必ず元に戻す・見せるだけ）。
    //  本体の合成とミニプレビューを同じ try の中に入れる（ミニプレビューは本体と同じ絵・フィルムの小さな絵には出さない）
    const unpeek = this.peekLine1px();
    try {
      compositeFrame(this.project, this.frameIndex, this.composite, {
        onion: this.playing ? 0 : this.onionLevel,
        // V164 (U-1): 向き。再生中は段数が 0 なので向きは効かない（再生中に描かない挙動は不変）
        onionDir: this.onionDir,
      });
      present(this.composite); // ★V214: 見せる処理（画面）。1px の仮を打ったまま呼ぶ
    } finally {
      unpeek?.();
    }
  }

  // ================= ★V214 (M-2b-1a): パネルとタイムラインの手続き（前は PC の画面の組み立ての中のイベント・字は同じ） =================
  // 画面の側は部品を作り・置き・見せ、押されたらここを呼ぶ。ダイアログで聞くのは画面の側で、聞いた値を受け取る。

  /** フォルダを畳む／開く（前は PC の rebuildLayers の中・字は同じ）。f は一覧を組んだときのフォルダ（id で引くなら folderById） */
  protected toggleFolderCollapsed(f: LayerFolder): void {
    f.collapsed = !f.collapsed;
    this.dirty = true;
    this.rebuildLayers();
  }

  /** フォルダの表示（👁）を切り替える。変形の途中は関所が先（取り消しは構造の履歴 1 つ） */
  protected toggleFolderVisible(f: LayerFolder): void {
    if (this.xformGuard()) return;
    this.pushStructure("フォルダ表示切替", () => {
      f.visible = !f.visible;
    });
  }

  /** フォルダの名前を変える（聞くのは画面の側）。空・取り消し（null）なら何もしない */
  protected renameFolder(f: LayerFolder, v: string | null): void {
    if (v)
      this.pushStructure("フォルダ名変更", () => {
        f.name = v;
      });
  }

  /** フォルダの不透明度を動かしている途中（v は 0〜100）。履歴は離したとき（commitFolderOpacity） */
  protected setFolderOpacityLive(f: LayerFolder, v: number): void {
    f.opacity = v / 100;
    this.renderCanvas();
    this.dirty = true;
  }

  /** フォルダの不透明度を離した。動かす前（from）と違えば履歴を 1 つ積む（from が null なら何もしない） */
  protected commitFolderOpacity(f: LayerFolder, opBefore: number | null): void {
    if (opBefore != null && opBefore !== f.opacity) {
      const from = opBefore;
      const to = f.opacity;
      const fid = f.id;
      const self = this;
      // 構造系Undoで folders 配列が clone に差し替わるため、
      // オブジェクト参照でなく id で適用時に解決する（独立レビューの指摘#5）
      this.history.push({
        colorRefs: NO_COLOR_REFS, // V195 (A-99)
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
  }

  /** レイヤーの表示（👁）を切り替える。変形の途中は関所が先 */
  protected toggleLayerVisible(ld: LayerDef): void {
    if (this.xformGuard()) return; // E-4
    ld.visible = !ld.visible;
    this.rebuildLayers();
    this.renderCanvas();
    // M10-23 レビュー検出の既存バグ: visible は保存対象なのに dirty を立てておらず、
    // 可視切替だけではオートセーブも終了警告も働かなかった（不透明度・名前と同じ流儀）
    this.dirty = true;
  }

  /** レイヤーの名前を変える（聞くのは画面の側）。空・取り消し（null）なら何もしない */
  protected renameLayer(ld: LayerDef, v: string | null): void {
    if (v) {
      ld.name = v;
      this.rebuildLayers();
      this.dirty = true;
    }
  }

  /** レイヤーの不透明度（v は 10〜100。履歴は積まない＝前と同じ） */
  protected setLayerOpacityLive(ld: LayerDef, v: number): void {
    ld.opacity = v / 100;
    this.renderCanvas();
    this.dirty = true;
  }

  /** 行を押したときの選び方（前は PC の updateSelection の中）。click=単独 / Ctrl・⌘=トグル / Shift=表示の並び（order）の範囲。
   *  フォルダは修飾キーなしで押すと「選んだフォルダ」を切り替える（V181: Mac の ⌘＋クリックも Ctrl＋クリックと同じ＝primary） */
  protected selectLayerRow(
    id: string,
    kind: "layer" | "folder",
    m: { ctrlOrMeta: boolean; shift: boolean; primary: boolean },
    order: readonly string[]
  ): void {
    if (m.ctrlOrMeta) {
      if (this.selectedNodeIds.has(id)) this.selectedNodeIds.delete(id);
      else {
        this.selectedNodeIds.add(id);
        if (kind === "layer") this.activeLayerId = id;
      }
      this.selAnchorId = id;
    } else if (m.shift && this.selAnchorId) {
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
    // V181: Mac の ⌘＋クリックも Ctrl＋クリックと同じ（上のトグルは以前から ctrl と meta の両方を見ている）
    if (kind === "folder" && !m.shift && !m.primary)
      this.selectedFolderId = this.selectedFolderId === id ? null : id;
    this.rebuildLayers();
  }

  /** 行を掴んでドラッグが始まった（前は PC の updateRowDrag の中）。選択の外の行から掴んだら単独選択に切り替える（替えたら true） */
  protected grabRowForDrag(id: string, kind: "layer" | "folder"): boolean {
    if (this.selectedNodeIds.has(id)) return false;
    this.selectedNodeIds = new Set([id]);
    this.selAnchorId = id;
    if (kind === "layer") this.activeLayerId = id;
    return true;
  }

  /** ドラッグ中に畳んだフォルダの上で待ったら開く（前は PC の setDragHoverFolder のタイマーの中）。畳んでいなければ何もしない */
  protected openFolderForDrop(folderId: string): void {
    const f = this.folderById(folderId);
    if (f && f.collapsed) {
      f.collapsed = false;
      this.dirty = true;
      this.rebuildLayers(); // 自前ドラッグなので再構築してもドラッグは継続できる
    }
  }

  /** ★形式（前は PC の toolFormatGroups の select の中・字は同じ）。どれも形式を替えて afterFormatChange（画面の側が組み直す） */
  protected setFillMode(m: FillMode): void {
    this.fillMode = m;
    this.enclosePts = [];
    this.afterFormatChange();
  }
  protected setFillRefAll(v: boolean): void {
    this.fillRefAll = v;
    this.afterFormatChange();
  }
  protected setShapeKind(k: ShapeKind): void {
    this.shapeKind = k;
    this.afterFormatChange();
  }
  protected setSelectKind(k: "rect" | "lasso" | "auto"): void {
    this.selectKind = k;
    this.afterFormatChange();
  }
  protected setSelectRefAll(v: boolean): void {
    this.selectRefAll = v;
    this.afterFormatChange();
  }
  /** 太さ（形式の帯・道具のオプションの太さの段）。setter が「今のツールの枠」へ書く */
  protected pickPenSizeFormat(s: number): void {
    this.penSize = s;
    this.refreshSizePicker();
    this.afterFormatChange();
  }
  /** 変形の左右・上下反転 */
  protected toggleXformFlip(axis: "h" | "v"): void {
    if (axis === "h") this.xform.flipH = !this.xform.flipH;
    else this.xform.flipV = !this.xform.flipV;
    this.afterFormatChange();
    this.redrawOverlay();
  }

  /** 文字の書体を替える（大きさを書体の段へ寄せる・太字の無い書体は太字を外す・下書きへ即反映）。
   *  via: "format"＝形式の帯（afterFormatChange）／"options"＝道具のオプションの選び（buildToolOptions）。前と同じ順で組み直す */
  protected setTextFamily(key: FontKey, via: "format" | "options"): void {
    this.textFamily = key;
    const d = fontDef(this.textFamily);
    // 直前のサイズが新候補にあれば維持し、無ければ最も近い値へ
    this.textSize = nearestSize(d, this.textSize);
    if (!d.hasBold) this.textBold = false;
    this.syncTextDraftStyle(); // M11-12: 浮動テキストへ即反映（位置は変えない）
    if (via === "format") this.afterFormatChange();
    else this.buildToolOptions();
    this.redrawOverlay();
    this.cb.onTextSettingsChange?.(this.textSettings());
  }
  /** 文字の大きさ */
  protected setTextSize(n: number): void {
    this.textSize = n;
    this.syncTextDraftStyle();
    this.redrawOverlay();
    this.cb.onTextSettingsChange?.(this.textSettings());
  }
  /** 文字の太字 */
  protected toggleTextBold(): void {
    if (!fontDef(this.textFamily).hasBold) return; // 最終防衛線（行が無いので実質不要）
    this.textBold = !this.textBold;
    this.syncTextDraftStyle();
    this.buildToolOptions();
    this.redrawOverlay();
    this.cb.onTextSettingsChange?.(this.textSettings());
  }
  /** 文字の縦書き */
  protected setTextVertical(v: boolean): void {
    if (v === this.textVertical) return;
    this.textVertical = v;
    this.syncTextDraftStyle();
    this.buildToolOptions();
    this.redrawOverlay();
    this.cb.onTextSettingsChange?.(this.textSettings());
  }
  /** 文字の下書きの中身（入力欄の字）。下書きが無ければ何もしない */
  protected setTextDraftText(s: string): void {
    if (!this.textDraft) return;
    this.textDraft.text = s;
    this.redrawOverlay();
  }

  /** 選択を外す（選択の履歴を 1 つ積む）。選択が無くても重ねる層は描き直す（前と同じ） */
  protected deselect(): void {
    // M10-22: 解除も履歴へ（選択が無いときは何も積まない）
    if (this.selMask) this.pushSelectionHistory("選択解除", this.selMask.slice(), null);
    this.selMask = null;
    this.redrawOverlay();
  }

  /** 変形の角度の数値欄（度・字のまま受け取る。読めなければ 0） */
  protected setXformAngleInput(value: string): void {
    this.xform.angle =
      ((Number(value) || 0) * Math.PI) / 180;
    this.redrawOverlay();
    this.paintUiOverlay();
  }
  /** 変形の横・縦の倍率の数値欄（% の字のまま受け取る。読めなければ 100・1% より小さくしない） */
  protected setXformScaleInput(axis: "x" | "y", value: string): void {
    if (axis === "x") this.xform.sx = Math.max(1, Number(value) || 100) / 100;
    else this.xform.sy = Math.max(1, Number(value) || 100) / 100;
    this.redrawOverlay();
    this.paintUiOverlay();
  }

  /** 変形を取り消して、前の道具へ戻る（変形から入ったときはペン） */
  protected cancelTransformAndReturn(): void {
    this.cancelTransform();
    this.setTool(this.prevTool === "transform" ? "pen" : this.prevTool);
  }

  /** フルカラーとパレットを切り替える（未保存の印も立てる）。V154 (W-3): 大きい作品でフルカラーを**入れる直前**だけ、
   *  これから起きることを見せる（cb.confirm）。ここが「257色目でメモリが倍になる」への入口＝止められる最後の地点（小さい作品では出ない）。
   *  断ったら false（何も変えない） */
  protected async toggleFullcolor(): Promise<boolean> {
    if (
      this.project.colorMode === "palette" &&
      this.project.indexBits === 8 &&
      projectBytes(this.project) >= EditorCore.SIZE_CAUTION
    ) {
      const now = projectBytes(this.project);
      const ok = await this.cb.confirm(
        t("ed.color.fullcolor.big.msg", { size: formatBytes(now), after: formatBytes(now * 2) })
      );
      if (!ok) return false;
    }
    this.project.colorMode =
      this.project.colorMode === "palette" ? "fullcolor" : "palette";
    this.dirty = true;
    return true;
  }

  /** 描く色を選ぶ（パレット・透明・よく使う色・色の選び）。"" は透明 */
  protected selectColor(hex: string): void {
    this.colorHex = hex;
    this.rebuildPalette();
  }

  /** オニオンの段数（0＝切・1〜3）。設定に保存して描き直す */
  protected setOnionLevel(lv: number): void {
    this.onionLevel = lv;
    this.saveOnion(); // V164 (U-1): 段数も設定に保存（向きと揃える）
    this.renderCanvas();
  }
  /** V164 (U-1): オニオンの向き。設定に保存して描き直す */
  protected setOnionDir(dir: OnionDir): void {
    this.onionDir = dir;
    this.saveOnion();
    this.renderCanvas();
  }

  /** トーンを選ぶ（ブラシ・塗り・かすり消しの、それぞれの枠） */
  protected setToneIdFor(toneMode: "brush" | "fill" | "eraser", id: string): void {
    if (toneMode === "brush") this.brushToneId = id;
    else if (toneMode === "fill") this.fillToneId = id;
    else this.eraserToneId = id;
  }
  /** ペンの種類を選ぶ（M17: texture を選んだらマイ柄は解除） */
  protected pickPenTexture(key: PenTexture): void {
    this.texture = key;
    this.penToneId = ""; // M17: texture を選んだらマイ柄は解除
  }
  /** M16 (D-1): トーンの「コマでずらす」。設定へ知らせる */
  protected toggleDitherFrameShift(): void {
    this.ditherFrameShift = !this.ditherFrameShift;
    this.cb.onDitherFrameShiftChange?.(this.ditherFrameShift);
  }
  /** M17: 「登録した色で塗る」。設定へ知らせる */
  protected toggleCustomToneColor(): void {
    this.customToneColor = !this.customToneColor;
    this.cb.onCustomToneColorChange?.(this.customToneColor);
  }

  /** ループ再生 */
  protected toggleLoop(): void {
    this.project.loop = !this.project.loop;
    this.dirty = true;
  }
  /** 速さ（FPS_TABLE の段）。再生中なら新しい速さで鳴らし直す */
  protected setSpeedIndex(n: number): void {
    this.project.speedIndex = n;
    this.dirty = true;
    if (this.playing) {
      this.stopPlayback();
      this.startPlayback();
    }
  }

  /** コマを押した（Shift＝起点〔rangeAnchor〕からの範囲を選ぶ・なし＝範囲を外して起点にする）。そのコマへ移る */
  protected clickFrame(i: number, shift: boolean): void {
    if (shift) {
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
  }

  /** P-6: 書き出しダイアログでの「書き出す長さ」選択を記憶（値の書き戻しのみ）。同じなら何もしない */
  protected setBgmSyncMode(m: NonNullable<ProjectAudio["bgm"]>["syncMode"]): void {
    const b = this.project.audio?.bgm;
    if (b && b.syncMode !== m) {
      b.syncMode = m;
      this.dirty = true;
    }
  }

  // ---- settings からの復元（★V214: 前は PC・字は同じ。値の直し〔sanitize〕を含む） ----
  /** V164: settings から復元（mount 前でよい。`buildSidePanel` が読む）。
   *  健全化は `prefs.ts` の純関数（壊れた要素だけ捨てる＝スモークが見張っている） */
  restoreFavoriteColors(v: unknown) {
    this.favoriteColors = sanitizeFavoriteColors(v);
  }
  /** V164 (U-1): settings から復元。**壊れた値・未設定はすべて既定へ倒す**
   *  （段数 0＝切／向き "both"＝v1.6.0 と同じ絵）。判定は `prefs.ts` の純関数 */
  restoreOnion(level: unknown, dir: unknown) {
    this.onionLevel = sanitizeOnionLevel(level);
    this.onionDir = sanitizeOnionDir(dir);
  }
  /** M13-2a (A-4): settings.json の `frameDeleteConfirm` から復元。**`false` 以外はすべてオン**
   *  （既定オン＝従来どおり確認が出る・追加のみ）。⚙ はライブラリ画面からしか開けないので mount 前の復元で足りる */
  restoreFrameDeleteConfirm(v: unknown) {
    this.frameDeleteConfirm = v !== false;
  }
  /** M16 (D-1): settings.json の `ditherFrameShift` から復元。**`true` のときだけオン**（既定=オフ・追加のみ）。
   *  ⚙ ではなくトーン欄のトグルで切り替えるので、mount 前の復元で足りる（rebuildTexPicker が読む） */
  restoreDitherFrameShift(v: unknown) {
    this.ditherFrameShift = v === true;
  }
  /** V151 (E-8): settings.json の `hiddenConfirms` から復元。知らない id は捨てる（追加のみ・旧 settings は []） */
  restoreHiddenConfirms(v: unknown) {
    this.hiddenConfirms = new Set(
      Array.isArray(v) ? v.filter((x): x is string => x === "clearFrame" || x === "layerDelete" || x === "folderDelete") : []
    );
  }
  /** M17: settings.json の `customTones` から復元（壊れた要素だけ捨てる・上限12・旧 settings は []）。
   *  mount 前の復元で足りる（rebuildTexPicker が読む） */
  restoreCustomTones(v: unknown) {
    this.customTones = CT.sanitizeCustomTones(v);
  }
  /** M17: settings.json の `customToneColor` から復元。**`false` 以外はオン**（既定オン・追加のみ） */
  restoreCustomToneColor(v: unknown) {
    this.customToneColor = v !== false;
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
  // ================= ★V214 (M-2b-1a): 作品を開く・閉じる（前は PC の mount / unmount の中・字と順は同じ） =================
  // 画面の側は、自分の行（画面を組む・リスナー・保存の段取り・PC のオートセーブの時計）を挟みながら、ここを前と同じ順に呼ぶ。
  // 口が 1 つでないのは、間に挟まる画面の行の順番を保つため（例: 押している印のフックはパンの状態を読む）。
  // 開く: openWorkStart → openWorkReset → openWorkPlayAndFloat → openWorkSelection → openWorkPointer → （refreshAll）→
  //       openWorkNotice → openWorkClean → openWorkSweepSoon
  // 閉じる: closeWorkStart → closeWorkSleep → closeWorkPending（画面の選択の小窓を隠すより前）→ closeWorkWarp → closeWorkEnd

  /** 作品を受け取る・共通レイヤーを張り直す・眠りを効かせるか決める */
  protected openWorkStart(project: Project): void {
    this.project = project;
    // M15 (K-1): 共通レイヤーの不変条件（全コマが同一バッファを参照）を読み込み直後に確立する。
    // serialize は「差があれば shared を外す」までを済ませているので、残った shared は張り直すだけ
    relinkShared(project);
    // ★V156 (P-1): この作品で眠りを効かせるか。**小さい作品はいままでと完全に同じ経路**
    //（スパイク実測: 50コマ×3レイヤーで減らせるのは 11 MiB しかなく、遅くなる理由だけが残る）。
    // 開いた直後は全部起きている——条件1「先に全部圧縮しない」ので、
    // 片付けは `nudgeSweep()` が背景で少しずつ進める
    // V163: PV6 の遅延読みは**眠り控えを持った姿**で届く。論理サイズがしきい値を割っていても
    // 眠っているコマがあるなら sleepOn を立てる（立てないと renderCanvas が起こさず白紙になる）。
    // 通常は projectFromBytes 側のしきい値（PV6_EAGER_MAX_RAW）と揃っているので保険の側
    this.sleepOn =
      projectBytes(project) >= EditorCore.SLEEP_MIN_BYTES || asleepCount(project) > 0;
    this.sweepCursor = 0;
    // 数え漏れを拾ったときの記録（W-10 の常時ログへ。名前もパスも出さない）
    setStaleSleepLogger(
      this.sleepOn
        ? (detail) => this.cb.appendLog?.(`[V156] ${detail}`)
        : null
    );
  }

  /** アプリへの知らせ・位置・履歴・未保存の印・開いた印・性能の口・作品ごとの知らせ・描きかけの束と 1px の仮 */
  protected openWorkReset(project: Project, cb: CB): void {
    this.cb = cb;
    this.frameIndex = 0;
    this.activeLayerId = project.layerDefs[project.layerDefs.length - 1]?.id ?? "";
    this.history.clear();
    this.dirty = false;
    this.mounted = true;
    // V159 (G-1): ログの1行ごとに添える「作品の大きさ」を教える口をつなぐ。
    // **ここで数え直さない**——面数は全コマ走査なので、メーターが数えた値（`lastFaces`）を返すだけ。
    // 少し古い値でも「大きい作品なのか」を読むには十分で、測るために遅くするほうが害が大きい
    setPerfContext(() => ({
      f: this.project.frames.length,
      l: this.project.layerDefs.length,
      s: this.lastFaces,
    }));
    // V154: 知らせは「作品につき1回」＝別の作品を開いたら出し直す（Editor は使い回される）
    this.promoteNoticed = false;
    this.sizeNoticedLevel = "";
    // V178 (A-72): 描きかけの束を持ち越さない（📌 の知らせは作品ごとの WeakSet なので、ここで戻さなくてよい）。
    //（「全レイヤー」の切り替え自体は `fillRefAll` と同じくアプリを閉じるまで残る＝設定には書かない）
    this.eraseAllStroke = null;
    this.line1px = null; // ★V191 (A-89): 1px の線の仮も持ち越さない（別の作品へ打たない）
  }

  /** 再生と時計・選択（と選択の線）・浮いた絵・変形 */
  protected openWorkPlayAndFloat(): void {
    this.playing = false;
    this.playClock?.stop(); // ★V209 (A-121): 時計も ⏸ した位置も持ち越さない
    this.playClock = null;
    this.playPaused = null;
    this.playEnded = null;
    this.selMask = null;
    this.paintSelectionUi(); // V208 (A-119): redrawOverlay を通らないので、選択の線をここで消す
    this.floatBuf = null;
    this.xformLayers = []; // M13-2b
    this.xformActive = false;
  }

  /** コマの範囲・フォルダとレイヤーの選択・レイヤーの控え */
  protected openWorkSelection(): void {
    // 範囲選択も前のメモを持ち越さない（古いインデックスでのコピー/クラッシュ防止）
    this.rangeSel = null;
    this.rangeAnchor = null;
    // フォルダ選択も持ち越さない（別プロジェクトの dangling parent 防止・独立レビューの指摘#3）
    this.selectedFolderId = null;
    // M11-19 レビュー検出の既存バグ: 複数選択（selectedNodeIds/selAnchorId）も持ち越されていた。
    // 新規メモはレイヤー id が毎回同じなので、前の作品で選んでいた行が次の作品でも「選択中」のまま残り、
    // 行ドラッグの「選択外の行から掴んだら単独選択に切替」が効かなかった（起動直後＝空集合と同じにする）
    this.selectedNodeIds = new Set();
    this.selAnchorId = null;
    // M11-15: レイヤー専用クリップボードは**作品を跨がない**（値は colorTable の添字＝別作品では色化け）。
    // 破棄は clearLayerClip() 1箇所（ボタンはこの後 buildSidePanel が作り直すので、
    // ここでの無効化は空振りしてよい）
    this.clearLayerClip();
  }

  /** 押している印を下ろす（前の接触を持ち越さない） */
  protected openWorkPointer(): void {
    this.pointerDown = false;
  }

  /** M15 (K-1): 旧版で共通レイヤーが編集され、コマ間に差があったため共通を外して開いたときの一言 */
  protected openWorkNotice(): void {
    // M15 (K-1): 旧版で共通レイヤーが編集され、コマ間に差があったため共通を外して開いた場合に一言。
    // serialize が付けた一時フラグを読んで消す（settings の __recovered と同じ運用）
    if ((this.project as { __sharedConflict?: boolean }).__sharedConflict) {
      delete (this.project as { __sharedConflict?: boolean }).__sharedConflict;
      this.cb.toast(t("ed.layer.sharedConflict.toast"));
    }
  }

  /** 未保存の印と便の印を下ろす（dirty の setter を通らない＝編集の印のフックも呼ばない） */
  protected openWorkClean(): void {
    this._dirty = false;
    this.autosavePending = false;
  }

  /** V156 (P-1・条件1): **開いたあと**に少しずつ眠らせる。読み込みには一切足さない
   *（全部圧縮すると 25.6 秒かかる＝V155 で 11 秒にした「開く速さ」が台無しになる）。
   * 少し待ってから始める＝開いた直後の描き出しに重なりにくくする */
  protected openWorkSweepSoon(): void {
    if (this.sleepOn) setTimeout(() => this.nudgeSweep(), 600);
  }

  /** 閉じる: 再生を止めて履歴を捨てる */
  protected closeWorkStart(): void {
    this.stopPlayback();
    // ★V156 (P-5): 履歴を捨てる。**いままで捨てていなかった**——`history.clear()` は
    // `mount` の中にしか無く、ライブラリ画面へ戻っても直前の作品の履歴が抱える生 IndexBuf
    //（予算いっぱいなら数十〜百 MiB）が次に開くまで居座っていた。
    // すぐ下で warpField を「1.5MB を保持し続けないように」と null にしているのに、
    // その 100 倍を放置していた（V156 スパイクの副産物）。mount 側の clear はそのまま残す
    this.history.clear();
  }

  /** 閉じる: 性能の口・眠り・待ちの印・ログの口を外す */
  protected closeWorkSleep(): void {
    // V159 (G-1): 作品の大きさを教える口も外す（閉じたあとの行に前の作品の数字を残さない）
    setPerfContext(null);
    // V156 (P-1): 裏の片付けを止める。ログの口も外す（別の作品に持ち越さない）
    this.sleepOn = false;
    this.showWaitBadge(false); // 出しっぱなしで画面を離れない
    setStaleSleepLogger(null);
  }

  /** 閉じる: 未確定のもの（矢印の移動・文字の下書き）を確定する。**画面のフックを呼ぶ**ので、画面の側は選択の小窓を隠すより前に呼ぶ。
   *  変形は片付けない（戻る前の関所 leaveBlocked に頼る） */
  protected closeWorkPending(): void {
    // M11-10: 矢印キーの移動セッションを持ったまま画面を離れない（確定してから閉じる）
    this.endArrowSession();
    // M11-12: 浮動テキストも同じ（保険。⟵もどる等の通常経路では xformGuard で既に焼けている）。
    // DOM が消えかけているので silent（UI 更新なし）で呼ぶ
    this.commitTextDraft(true);
  }

  /** 閉じる: 魚眼の連続を止める・四隅を取り消す・歪みの場と音の試聴を捨てる */
  protected closeWorkWarp(): void {
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
  }

  /** 閉じる: 開いた印を下ろす（最後） */
  protected closeWorkEnd(): void {
    this.mounted = false;
  }

  /** ★V214 (M-2b-1a): オートセーブを書き始めない、作品の側の条件（前は PC の runAutosave の入口・字は同じ）。
   *  閉じた・重い処理の最中・押している・変形の途中・浮いた絵・四隅の途中。**PC の便の印（autosavePending）・書き出し中・
   *  前の便や保存の飛行中は入れない**（画面の側が自分で足す）。
   *  変形/選択の浮動中はレイヤーから切り出したピクセルがプロジェクト外にあるためスナップショットが欠損する（独立レビューの指摘#6） */
  protected autosaveBlocked(): boolean {
    return (
      !this.mounted ||
      // V154b (W-7): **手動保存・音声の読み込み・書き出しの最中は見送る。**
      // 手動保存が譲るようになった（W-8）ので、15秒タイマーがそのすき間に割り込み得る。
      // 割り込むと本体2つぶんのメモリを同時に積む＝この回で潰している事故そのもの
      this.busyKind !== "" ||
      this.pointerDown ||
      this.xformActive ||
      !!this.floatBuf ||
      // M10-2c: 四隅変形は確定するまで何秒でも未確定のプレビューが置かれたままになる。
      // ここを塞がないと、確定していない絵がそのまま保存される
      this.cornerActive
    );
  }

  /** ★V214 (M-2b-1a): オートセーブの書き始めの印（履歴の変更カウンタ）。書いている途中で捨てるかは autosaveChangedSince で見る */
  protected autosaveMark(): AutosaveMark {
    // 変更は必ず dirty→autosavePending か history.mutations に現れる
    //（bufferChangeEntry の onApply / afterFrameStructureChange 等が dirty を立てる）
    return { hist0: this.history.mutations };
  }

  /** ★V214 (M-2b-1a): 書き始めの印からの変化（前は PC の runAutosave の aborted の中・字は同じ）。true＝その便は捨てる。
   *  閉じた・履歴が変わった・押した・変形・浮いた絵・四隅。**PC の便の印（autosavePending）と時計の世代は入れない**
   *  （autosavePending は書く直前に PC が下ろす印なので、入れるとモバイルではいつも捨てる）。モバイルはセッションの autosaveAborted に渡す */
  protected autosaveChangedSince(mark: AutosaveMark): boolean {
    return (
      !this.mounted ||
      this.history.mutations !== mark.hist0 ||
      this.pointerDown ||
      this.xformActive ||
      !!this.floatBuf ||
      this.cornerActive
    );
  }

  /** ★V214 (M-2b-1a): 保存しない判断（前は PC の save の入口・順は同じ）。重い処理の最中は弾く → 変形の途中は関所（xformGuard）が先 */
  protected saveBlocked(): boolean {
    if (this.busyKind) return true; // 音声読み込み・書き出しの最中は従来どおり弾く
    if (this.xformGuard()) return true; // E-4
    return false;
  }

  /** ★V214 (M-2b-1a): 戻らない判断（前は PC の confirmLeave の中）。変形の途中は確定／取り消しが先（関所）。
   *  飛行中の保存を待つのは画面の側（この前） */
  protected leaveBlocked(): boolean {
    return this.xformGuard(); // E-4: 変形中は確定/取消が先
  }

  /** ★V214 (M-2b-1a): 履歴が動いたときの手続き（前は PC の bindHeader の history.onchange の中・字は同じ）。
   *  取り消しとやり直しのボタンの有効・無効（undoRedoShown・画面）→ 大きさと履歴の予算の数え直し（updateSizeMeter） */
  protected historyChanged(): void {
    this.undoRedoShown();
    this.updateSizeMeter(); // V154 (W-2): 履歴が動いたら「元に戻す」の行も動く
  }

  /** ★V214: 履歴の知らせを historyChanged へつなぐ（開いたときに画面の側が呼ぶ。そのあと 1 回 historyChanged を呼ぶのも画面の側） */
  protected bindHistory(): void {
    this.history.onchange = () => this.historyChanged();
  }

  /** ★V214: 全レイヤーの束を確定して終える（コマンドの先頭・キーを押したとき）。束が無ければ何もしない */
  protected settleEraseAll(): void {
    if (this.eraseAllStroke) this.finishEraseAllNow();
  }

  /** ★V214: 別の操作を始めた（PC は画面のどこかを押したとき＝capture でどのボタンより先）。矢印の移動と全レイヤーの束を確定する
   *  （前は PC の uiPointerHandler の中・字は同じ） */
  protected otherOperationStarted(): void {
    if (this.mounted) this.endArrowSession();
    // ★V178 (A-72・独立レビュー 3 回目): 描いている最中に**もう 1 本のポインタ**（ペンを置いたままマウス等）で
    //  ボタンを押すと、そのボタンの処理が束より先に作品を変える（↶↷・消す・コマの追加…）。
    //  ここは capture 段階で**どのボタンの処理より先**に走る漏斗なので、ここで束を確定して終える
    if (this.mounted && this.eraseAllStroke) this.finishEraseAllNow();
  }

  /** ★V214 (M-2b-1a): コマンドの中身のうち、作品と描く状態だけで決まるもの（前は PC の runCommand の中・字は同じ）。受け取ったかを返す。
   *  ★先頭で全レイヤーの束を確定する＝**どのコマンドでも**（受け取らない PC だけのコマンド〔保存・表示〕でも。前と同じ）。
   *  ファイル・書き出し・表示・ダイアログを開く・最後のポインタの位置を使うものは画面の側（PC の runCommand） */
  protected runCoreCommand(id: string): boolean {
    // ★V178 (A-72・独立レビュー 2 回目): コマンドが作品を変える前に、全レイヤーの束を確定して終える（finishEraseAllNow）
    if (this.eraseAllStroke) this.finishEraseAllNow();
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
        return true;
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
        return true;
      }
      case "pen.size1":
      case "pen.size2":
      case "pen.size3":
      case "pen.size4":
      case "pen.size5":
      case "pen.size6":
        this.penSize = PEN_SIZES[Number(id.slice(8)) - 1];
        this.refreshSizePicker();
        return true;
      // 編集
      case "edit.undo":
        this.handleUndo();
        return true;
      case "edit.redo":
        this.handleRedo();
        return true;
      case "edit.copy":
        // ★V199 (A-105・§2-4): 範囲選択があれば今までどおり範囲のコピー、無ければレイヤー（フォルダ）のコピー
        if (copyKind(!!this.selMask) === "sel") this.copySelection(false);
        else void this.copyLayerFrame();
        return true;
      case "edit.cut":
        this.copySelection(true);
        return true;
      case "edit.paste":
        // ★V199 (A-105・§2-4): **最後にコピーしたほう**を貼る（範囲＝浮かせた貼り付け／レイヤー・フォルダ＝丸ごと差し替え）
        if (pasteKind(this.lastCopy, !!this.layerClip) === "layer") void this.pasteLayerFrame();
        else this.pasteClipboard();
        return true;
      case "edit.deleteSelection":
        if (this.selMask) this.deleteSelection();
        return true;
      case "edit.copyPrev":
        this.copyPrevFrame();
        return true;
      case "edit.clearFrame":
        void this.clearFrame();
        return true;
      // M11-19: 線を太らせる／細らせる（非 repeatable＝キーリピートでは1回だけ）
      case "edit.thicken":
        this.morphActiveLayer("thicken");
        return true;
      case "edit.thin":
        this.morphActiveLayer("thin");
        return true;
      // M11-15: レイヤーのコピー＆ペースト
      case "layer.copy":
        void this.copyLayerFrame();
        return true;
      case "layer.paste":
        void this.pasteLayerFrame();
        return true;
      case "layer.pasteOver":
        void this.pasteLayerOverFrame();
        return true;
      case "layer.pasteNew":
        this.pasteLayerToNew();
        return true;
      case "layer.pasteAll":
        void this.pasteLayerAllFrames();
        return true;
      // コマ
      case "frame.prev":
        this.gotoFrame(this.frameIndex - 1);
        return true;
      case "frame.next":
        this.gotoFrame(this.frameIndex + 1);
        return true;
      case "frame.add":
        void this.addFrame(false);
        return true;
      case "frame.duplicate":
        void this.addFrame(true);
        return true;
      case "frame.delete":
        void this.deleteFrame();
        return true;
      case "frame.copyPage":
        void this.copySelectedFrames();
        return true;
      case "frame.pastePage":
        void this.pasteFrames();
        return true;
      // 再生・表示
      case "play.toggle":
        this.togglePlayback();
        return true;
    }
    return false;
  }

  // ---------------- M11-10: 矢印キーの1ドット移動（移動セッション）・★V214 で PC から移した ----------------
  // キーボードには「離す」が無いので、ドラッグと違ってセッションを持たざるを得ない。
  // 確定は **endArrowSession() 1つ**に集約し、あらゆる離脱経路から必ず呼ぶ
  //（M11-5 の endPointerSession と同じ作法）。加えて 800ms の自動確定で状態を長く残さない。

  /** 進行中の移動セッションの種類（""＝無し） */
  protected arrowKind: "" | "layer" | "selmask" | "selmove" = "";
  protected arrowDx = 0;
  protected arrowDy = 0;
  protected arrowTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最後の矢印キーからこの時間が経ったら自動で確定する（仮の値・REQ 未決6） */
  protected static readonly ARROW_COMMIT_MS = 800;

  /** 移動セッションを確定する（履歴は1エントリ）。セッションが無ければ何もしない */
  protected endArrowSession() {
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
  protected cancelArrowSession() {
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

  protected scheduleArrowCommit() {
    if (this.arrowTimer != null) clearTimeout(this.arrowTimer);
    this.arrowTimer = setTimeout(() => {
      this.arrowTimer = null;
      this.endArrowSession();
    }, EditorCore.ARROW_COMMIT_MS);
  }

  /** ★V214 (§5-1 の 1): 1 ドット動かす（PC の矢印キー・モバイルの帯の上下左右が同じものを使う）。dx・dy はキャンバスのドット
   *  （Shift で 10 にするのは画面の側）。戻り値＝受け取ったか（PC はこれで `preventDefault` を決める＝前と同じ。
   *  コマ送りの枝と ↑↓ は受け取らない）。前は PC の handleArrowKey の中身 */
  protected nudgeArrow(dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return false;
    // ① 変形モード中: 平行移動量を ±1 するだけ（確定は既存の Enter / 取消は Esc）。
    //    何回押しても履歴は確定時の1つ
    if (this.xformActive && this.floatBuf) {
      this.xform.tx += dx;
      this.xform.ty += dy;
      this.redrawOverlay();
      this.paintUiOverlay(); // ★V216b (A-127): 枠とハンドルの層も動いた先へ（ドラッグ・数値の入力と同じ）
      this.buildToolOptions(); // 数値表示を追従
      return true;
    }
    // ①'' 浮動テキスト中: 位置（パラメータの x/y）を動かすだけ。確定は Ctrl+Enter / 取消は Esc
    //     なので、何回押しても履歴は確定時の1つ。
    //     **入力欄にフォーカスがある間はここへ来ない**（onKeyDown が isTextEntry で早期 return
    //     する＝文字カーソルの移動が優先。REQ の要求どおり）
    if (this.textDraft) {
      this.textDraft.x += dx;
      this.textDraft.y += dy;
      this.redrawOverlay();
      return true;
    }
    // ①' 四隅変形中: 4点をまとめて平行移動する（形は変えずに位置だけ動かす）。
    //     確定/取消は既存のまま（Enter / Esc）なので、履歴はやはり確定時の1つ
    if (this.cornerActive) {
      this.cornerPts = this.cornerPts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      this.updateCornerPreview();
      return true;
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
        if (!started) return true;
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
      return true;
    }
    // ④ それ以外は従来どおり前後のコマ（↑↓ は従来どおり何もしない）
    if (dx < 0) this.gotoFrame(this.frameIndex - 1);
    else if (dx > 0) this.gotoFrame(this.frameIndex + 1);
    return false;
  }

  /** ★V214 (§5-1 の 1・§5-2 の 1): 裏に回ったときに書く姿。浮いた絵・変形・選択の移動・四隅の途中なら、**浮かせる前の姿**の作品を返す
   *  （いまの作品とレイヤーのバッファには触らない＝差し替えた入れ物で返す。差し替えたコマ・レイヤーの表は新しい入れ物、ほかは同じ参照）。
   *  途中でなければ、いまの作品をそのまま返す。★PC は呼ばない（モバイルのオートセーブが裏に回る直前に使う）。
   *  - 変形（切り出した N 枚）: 対象のレイヤーを、切り出す前の控え（xformLayers[].before）に。貼り付け・画像の配置は元のバッファに
   *    触れていない＝そのまま
   *  - 選択の移動（ドラッグ・矢印）: アクティブなレイヤーを selMoveBefore に
   *  - 四隅: 対象のレイヤーを cornerBefore に（途中の絵はレイヤーに書かれている）
   *  ★📌（全コマ共通）のレイヤーは全コマが同じ実体を指す（relinkShared）。浮かせたバッファと**同じ実体を指す全コマ**を、
   *   1 つの浮かせる前の控えで差し替える（そのコマだけだと、ほかのコマに穴が残り、読み込んだときに共通が外れる） */
  workForBackground(): Project {
    const p = this.project;
    const f = p.frames[this.frameIndex];
    if (!f) return p;
    const repl = new Map<string, IndexBuf>();
    if (this.xformActive && this.floatBuf) {
      if (this.xformCutDone) for (const L of this.xformLayers) repl.set(L.id, L.before);
    } else if (this.dragMode === "selmove" && this.floatBuf && this.selMoveBefore) {
      repl.set(this.activeLayerId, this.selMoveBefore);
    } else if (this.arrowKind === "selmove" && this.floatBuf && this.selMoveBefore) {
      repl.set(this.activeLayerId, this.selMoveBefore);
    }
    if (this.cornerActive && this.cornerBefore) for (const [id, b] of Object.entries(this.cornerBefore)) repl.set(id, b);
    if (repl.size === 0) return p;
    // 差し替える実体（いまのコマのそのレイヤーのバッファ）→ 控え。同じ実体を指すコマを全部差し替える
    const byBuf = new Map<IndexBuf, { id: string; before: IndexBuf }>();
    for (const [id, before] of repl) {
      const cur = f.layers[id];
      if (cur) byBuf.set(cur, { id, before });
    }
    if (byBuf.size === 0) return p;
    const frames = p.frames.map((fr) => {
      let layers: Frame["layers"] | null = null;
      let sleep: Frame["sleep"] = fr.sleep;
      for (const [cur, { id, before }] of byBuf) {
        if (fr.layers[id] !== cur) continue;
        layers ??= { ...fr.layers };
        layers[id] = before;
        // 起きているレイヤーの圧縮控えは古い（差し替えた絵と食い違う）ので、入れ物の側だけ外す
        if (sleep && sleep[id]) {
          sleep = { ...sleep };
          delete sleep[id];
        }
      }
      if (!layers) return fr;
      return fr.sleep === undefined ? { ...fr, layers } : { ...fr, layers, sleep };
    });
    return { ...p, frames };
  }

  /** ★V213 (M-2a): ゆらゆらを作る（前は onWobbleClick のダイアログのあと）。opt はダイアログの答え */
  async applyWobble(opt: { count: number; kind: WobbleKind; strength: WobbleStrength; target: "all" | "active" }): Promise<void> {
    // ★V205 (A-114・REQ_wobble_targets §2-1・§2-3): 「選択中」の対象は layerTree.ts の wobbleTargetLayerIds で決める
    //  （ダイアログの表示・見本と同じ関数。モーダルの間は選択が変わらない＝開いたときと同じ答え）。
    //  レイヤー 1 枚なら描いているレイヤー・フォルダならその中・2 つ以上なら和（👁 で隠したものと 🔒 も・📌 は除く）。
    //  揺らせるレイヤーが 0 枚（📌 だけ・空のフォルダ・「全レイヤー」でも全部 📌）なら、知らせて作らない（A-112）
    const wt = this.wobbleTargets();
    const target: ReadonlySet<string> | null = opt.target === "active" ? new Set(wt.ids) : null;
    const movable = target ? target.size : this.project.layerDefs.filter((l) => l.shared !== true).length;
    if (movable === 0) {
      this.cb.toast(t("ed.wobble.noTarget.toast"));
      return;
    }
    const n = opt.count - 1;
    if (this.project.frames.length + n > 65535) {
      this.cb.toast(t("ed.wobble.limitExceeded.toast"));
      return;
    }
    const willWarn = this.project.frames.length + n >= 2000;
    // ★V166 (層2/B): 小窓（＝利用者を待っている時間）は漏斗の外。
    //  実際に作る区間だけを包む。ゆらゆらは最大100枚を**一度に**作るので見積もりも要る
    // ゆらゆらは既存のコマをずらして作る＝新しい色は増えない
    if (!this.allowFrameAlloc(opt.count, 0, "frame.wobble")) return;
    await this.runHeavy("frame.wobble", t("ed.heavy.wobble.msg"), () =>
      this.onWobbleApply(opt, target, wt, willWarn)
    );
  }

  // ================= 画面の口（フック）の既定＝何もしない（PC の Editor が上書きする） =================
  /** ★V214: レイヤーの一覧を組み直す前に、選択を手入れする（消えた id を外し、空ならアクティブなレイヤーを選ぶ＝pruneSelection）。
   *  画面の側は上書きして、**組み直す前に super.rebuildLayers() を呼ぶ**（PC は前と同じ位置で呼ぶ） */
  protected rebuildLayers(): void {
    this.pruneSelection();
  }
  protected renderCanvas(): void {}
  protected rebuildFilm(): void {}
  protected paintFilmThumb(_i: number): void {}
  protected rebuildTexPicker(): void {}
  protected updateAudioToolButton(): void {}
  protected updateFilmSeMarks(): void {}
  protected rebuildPalette(): void {}
  protected rebuildFavPalette(): void {}
  protected afterFormatChange(): void {}
  protected updatePasteButton(): void {}
  protected updateFilmColorMark(_i: number): void {}
  protected redrawOverlay(): void {}
  protected muteFloatingOverlays(_on: boolean): void {}
  protected updateXformBadge(): void {}
  protected buildToolOptions(): void {}
  protected paintUiOverlay(): void {}
  protected previewShape(_a: { x: number; y: number }, _b: { x: number; y: number }): void {}
  protected refreshSelectionLauncher(): void {}
  protected redrawSelMovePreview(): void {}
  protected updateToolButtons(): void {}
  protected flushInputLogSoon(): void {}
  protected paintSelectionUi(): void {}
  protected focusTextInput(): void {}
  protected updateLayerClipButtons(): void {}
  protected revealLayerClip(): void {}
  protected updateFilmSelection(): void {}
  protected syncPasteRangeLabel(): void {}
  protected previewSelectRect(_a: { x: number; y: number }, _b: { x: number; y: number }): void {}
  protected pointerDownChanged(_down: boolean): void {}
  protected repaintCursor(): void {}
  protected refreshSizePicker(): void {}
  protected undoRedoShown(): void {}
  protected showWaitBadge(_on: boolean): void {}
  protected clearOverlay(): void {}
  protected toolChanging(_t: Tool): void {}
  protected toolChanged(): void {}
  protected pointerReleased(): void {}
  protected busyStarted(): void {}
  protected busyClosing(): void {}
  protected busyEnded(): void {}
  protected playStateShown(_playing: boolean): void {}
  protected xformCursorReset(): void {}
  protected xformDragCursor(_cursor: string): void {}
  protected xformDragEnded(_pt: { x: number; y: number }): void {}
  protected paintSizeMeter(_proj: number, _real: number, _t0: number): void {}
  protected savePrepShow(_stage: "begin" | "moved" | "pass" | "end" | "save", _prog: { n: number; total: number } | null): void {}
  protected heavyYield(): Promise<void> {
    return Promise.resolve();
  }
  /** ★V214: 編集の印（dirty = true のたび・すでに立っていても）。PC は上書きしない（モバイルのセッションと時計の noteEdit） */
  protected workEdited(): void {}
  /** ★V214: 変形の取っ手・回転の輪・歪みの四隅を掴む当たりの大きさ（キャンバスのドット）。既定は PC と同じ値 */
  protected xformHitSizes(): XformHitSizes {
    return { hit: 6, ring: 12, corner: 8 };
  }
  protected heavyBox<T>(_op: PerfOp, _msg: string, fn: () => Promise<T>, _delayMs: number): Promise<T> {
    return fn();
  }
}
