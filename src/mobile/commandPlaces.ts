// V220 (M-2b-1b・要件 docs/REQ_mobile_ui_v1.md §7・U-15・docs/REQ_mobile_m2_editor.md §5-1 の 3): **PC のコマンドのモバイルの置き場**。
//
// ★漏斗: 置き場は**この表 1 か所**で持つ（UI §7 の「漏斗・明示・網」）。`keymap.ts` の `COMMANDS`（59）の全部に、広・中・狭の置き場と、
//  出さないときの理由を持つ。網は scripts/v220_smoke.ts [P]（表と COMMANDS を突き合わせる・1 件消しても 1 件足しても赤）。
// ★置き場は「どこに（PlaceId）」と「いつから（Milestone＝その置き場ができる回）」の組で持つ（例: 書き出しは、右の列で M-4 から）。
//  M-2b-2 の横（広）の描く画面・M-2b-3 の縦（中）と広げたタイムラインとハードウェアキーボード・M-3 のスマホ（狭）・M-4 の取り込みと
//  書き出しと音声。中身は UI §7-1 の表のとおり。
// ★ハードウェアキーボードの列は手で書き写さない: PC の割り当て（`BUILTIN_PRESETS` の標準と左手向け）から作る（[`keyboardBindings`]）。
//  iPad のキーボードで使えるのは M-2b-3 から（D-M2-2・PC の表と割り当てをそのまま使う）。
// ★画面の札（名前）は持たない（辞書の `labelKey` は COMMANDS にある）。キーの表記（Ctrl・⌘・Shift＋ など）も札として書かない（U-12）。
//  置き場の名前は ASCII の識別子だけ（画面の部品の名前は M-2b-2 以降の画面の回が決める）。
import { BUILTIN_PRESETS, COMMANDS, type CommandId, type KeyBinding } from "../keymap";

/** 置き場ができる回（REQ_mobile_m2_editor.md §5-0・親§12） */
export type Milestone = "M-2b-2" | "M-2b-3" | "M-3" | "M-4" | "M-5";

/** 置き場（UI §5〜§7 の部品。名前は仮の識別子） */
export type PlaceId =
  // 描く画面の部品
  | "leftColumn" // 左の列（広・ツール 11）
  | "toolRow" // ツールの段（中）
  | "toolRowGroup" // ツールの段のまとめたボタン（中・移動・範囲選択・変形・歪み＝§5-11）
  | "toolList" // 下の帯のツールの札 → ツールの一覧（狭）
  | "rightColumn" // 右の列（広・保存・書き出し・その他・太さ・色・レイヤー・ツールの設定・表示）
  | "rightColumnSize" // 右の列「太さ」（広）
  | "topRow" // 上の段（中・元に戻す・やり直し・太さ）
  | "bottomBar" // 下の帯（取り消し・やり直し・再生・透かす・前後・コマの帯・＋・数・複写・ツールを隠す）
  | "bottomBarSize" // 下の帯「太さ」（狭）
  | "fileIsland" // ファイルの島（中）
  | "topRightSave" // 右上の保存（狭）
  | "frameIsland" // コマの島（狭）
  | "selectBar" // 範囲選択の帯（広）
  | "selectGroupList" // まとめたボタンの一覧（範囲選択・中）
  | "selectSheet" // 範囲選択の帯（シート・狭）
  | "transformBar" // 変形の帯
  | "frameLongPressBar" // コマを長押しの帯
  | "timelineExpanded" // 広げたタイムライン（§5-7）
  | "timelineHead" // 広げたタイムラインの頭
  | "moreMenu" // その他のメニュー
  | "toolOptions" // ツールの設定
  | "toolOptionsSheet" // ツールの設定（シート・狭）
  | "layerMenu" // レイヤーのメニュー（いまの行をもう一度押す）
  | "displayPanel" // 表示のパネル（回転を 0° に戻す・左右反転・ミニプレビュー・大きさを戻す）
  | "zoomBadge" // 倍率の札（狭・押すと fit）
  | "filmSwipe" // コマの帯をすべらせる
  // ジェスチャー（UI §5-8・親§6-3）
  | "gestureTap2"
  | "gestureTap3"
  | "gestureTap4"
  | "gesturePinch"
  | "gestureTwist"
  | "gestureLongPress"
  | "trackpad" // トラックパッドとマウス（ピンチ・2 本指のスクロール＝M-2b-3）
  // ライブラリ
  | "libraryGear";

/** 1 つの置き場 */
export interface Place {
  at: PlaceId;
  since: Milestone;
}

/** モバイルの画面に出さない理由 */
export type NoPlaceReason =
  | "twoFingerPan" // 置かない（2 本指で動かす＝DU-1 は A）
  | "keyboardOnly" // ハードウェアキーボードだけ（画面は太さの 6 つを直接押す）
  | "notOnNarrow"; // 狭では出さない（UI §5-5）

/** 区分ごとの置き場（置き場が 1 つも無いときは理由） */
export type Slot = { places: readonly Place[] } | { none: NoPlaceReason };

export interface CommandPlace {
  id: CommandId;
  wide: Slot;
  medium: Slot;
  narrow: Slot;
}

// ---- 書き方の手伝い（表を短くするだけ） ----
const W = "M-2b-2" as const; // 横（広）の描く画面
const M = "M-2b-3" as const; // 縦（中）・広げたタイムライン・設定・ハードウェアキーボード・トラックパッド
const N = "M-3" as const; // スマホ（狭）
const p = (...xs: [PlaceId, Milestone][]): Slot => ({ places: xs.map(([at, since]) => ({ at, since })) });
const none = (r: NoPlaceReason): Slot => ({ none: r });
/** 3 つの区分で同じ部品（できる回は区分の回） */
const all = (at: PlaceId): Pick<CommandPlace, "wide" | "medium" | "narrow"> => ({ wide: p([at, W]), medium: p([at, M]), narrow: p([at, N]) });
/** 3 つの区分で同じ部品・同じ回（区分の回より遅い機能＝書き出し・取り込み・音声） */
const allAt = (at: PlaceId, since: Milestone): Pick<CommandPlace, "wide" | "medium" | "narrow"> => ({
  wide: p([at, since]),
  medium: p([at, since]),
  narrow: p([at, since]),
});

/** ツール 11（UI §7-1 の 1 行目） */
const tool = (id: CommandId, grouped: boolean): CommandPlace => ({
  id,
  wide: p(["leftColumn", W]),
  medium: p([grouped ? "toolRowGroup" : "toolRow", M]),
  narrow: p(["toolList", N]),
});
/** 太さの 6 つ */
const size = (id: CommandId): CommandPlace => ({ id, wide: p(["rightColumnSize", W]), medium: p(["topRow", M]), narrow: p(["bottomBarSize", N]) });
/** 範囲選択の帯の 4 つ */
const sel = (id: CommandId): CommandPlace => ({ id, wide: p(["selectBar", W]), medium: p(["selectGroupList", M]), narrow: p(["selectSheet", N]) });
/** 広げたタイムラインとコマを長押しの帯（複製・さくじょ・コピー・はりつけ） */
const frameOp = (id: CommandId): CommandPlace => ({
  id,
  wide: p(["timelineExpanded", M], ["frameLongPressBar", W]),
  medium: p(["timelineExpanded", M], ["frameLongPressBar", M]),
  narrow: p(["timelineExpanded", N], ["frameLongPressBar", N]),
});

/** ★置き場の表（UI §7-1・`COMMANDS` の 59 と同じ並び） */
export const COMMAND_PLACES: readonly CommandPlace[] = [
  tool("tool.pen", false),
  tool("tool.brush", false),
  tool("tool.eraser", false),
  tool("tool.fill", false),
  tool("tool.shape", false),
  tool("tool.text", false),
  tool("tool.eyedrop", false),
  // 手のひらは置かない（2 本指で動かす＝DU-1 は A）
  { id: "tool.hand", wide: none("twoFingerPan"), medium: none("twoFingerPan"), narrow: none("twoFingerPan") },
  tool("tool.move", true),
  tool("tool.select", true),
  tool("tool.transform", true),
  tool("tool.warp", true),
  // 太さ: 1 段ずつ変えるのはキーボードだけ（画面は 6 つを直接押す）
  { id: "pen.sizeDown", wide: none("keyboardOnly"), medium: none("keyboardOnly"), narrow: none("keyboardOnly") },
  { id: "pen.sizeUp", wide: none("keyboardOnly"), medium: none("keyboardOnly"), narrow: none("keyboardOnly") },
  size("pen.size1"),
  size("pen.size2"),
  size("pen.size3"),
  size("pen.size4"),
  size("pen.size5"),
  size("pen.size6"),
  // 元に戻す・やり直し: 帯（中は上の段）と 2 本指・3 本指のタップ
  { id: "edit.undo", wide: p(["bottomBar", W], ["gestureTap2", W]), medium: p(["topRow", M], ["gestureTap2", M]), narrow: p(["bottomBar", N], ["gestureTap2", N]) },
  { id: "edit.redo", wide: p(["bottomBar", W], ["gestureTap3", W]), medium: p(["topRow", M], ["gestureTap3", M]), narrow: p(["bottomBar", N], ["gestureTap3", N]) },
  sel("edit.copy"),
  sel("edit.cut"),
  sel("edit.paste"),
  sel("edit.deleteSelection"),
  // 複写: 横は下の帯・縦とスマホはコマを長押しの帯
  { id: "edit.copyPrev", wide: p(["bottomBar", W]), medium: p(["frameLongPressBar", M]), narrow: p(["frameLongPressBar", N]) },
  { id: "edit.clearFrame", ...all("moreMenu") },
  // 修飾キー＋クリックで 1 回拾う → 長押しのスポイト（親§6-3）
  { id: "edit.pickColor", ...all("gestureLongPress") },
  { id: "edit.thicken", wide: p(["toolOptions", W]), medium: p(["toolOptions", M]), narrow: p(["toolOptionsSheet", N]) },
  { id: "edit.thin", wide: p(["toolOptions", W]), medium: p(["toolOptions", M]), narrow: p(["toolOptionsSheet", N]) },
  // レイヤーのコピーと貼り付け（重ね貼りも＝A-109）: レイヤーのメニュー
  { id: "layer.copy", ...all("layerMenu") },
  { id: "layer.paste", ...all("layerMenu") },
  { id: "layer.pasteOver", ...all("layerMenu") },
  { id: "layer.pasteNew", ...all("layerMenu") },
  { id: "layer.pasteAll", ...all("layerMenu") },
  // ファイル
  { id: "file.save", wide: p(["rightColumn", W]), medium: p(["fileIsland", M]), narrow: p(["topRightSave", N]) },
  { id: "file.saveAs", ...all("moreMenu") },
  { id: "file.export", wide: p(["rightColumn", "M-4"]), medium: p(["fileIsland", "M-4"]), narrow: p(["moreMenu", "M-4"]) },
  { id: "file.image", ...allAt("moreMenu", "M-4") },
  { id: "file.audio", ...allAt("moreMenu", "M-4") },
  // 設定: 描く画面のその他（M-2b-3 で設定の画面）・ライブラリの歯車（M-2c 以降のライブラリの画面）
  { id: "app.settings", wide: p(["moreMenu", M], ["libraryGear", M]), medium: p(["moreMenu", M], ["libraryGear", M]), narrow: p(["moreMenu", N], ["libraryGear", N]) },
  // コマ
  { id: "frame.prev", wide: p(["bottomBar", W], ["filmSwipe", W]), medium: p(["bottomBar", M], ["filmSwipe", M]), narrow: p(["frameIsland", N]) },
  { id: "frame.next", wide: p(["bottomBar", W], ["filmSwipe", W]), medium: p(["bottomBar", M], ["filmSwipe", M]), narrow: p(["frameIsland", N]) },
  { id: "frame.add", wide: p(["bottomBar", W], ["timelineExpanded", M]), medium: p(["bottomBar", M]), narrow: p(["frameIsland", N]) },
  frameOp("frame.duplicate"),
  frameOp("frame.delete"),
  frameOp("frame.copyPage"),
  frameOp("frame.pastePage"),
  { id: "frame.wobble", wide: p(["timelineExpanded", M]), medium: p(["timelineExpanded", M]), narrow: p(["timelineExpanded", N]) },
  // 再生と表示
  { id: "play.toggle", wide: p(["bottomBar", W]), medium: p(["bottomBar", M]), narrow: p(["frameIsland", N]) },
  { id: "play.loop", wide: p(["timelineHead", M]), medium: p(["timelineHead", M]), narrow: p(["timelineHead", N]) },
  {
    id: "view.zoomIn",
    wide: p(["gesturePinch", W], ["trackpad", M], ["displayPanel", W]),
    medium: p(["gesturePinch", M], ["trackpad", M], ["displayPanel", M]),
    narrow: p(["gesturePinch", N], ["zoomBadge", N]),
  },
  {
    id: "view.zoomOut",
    wide: p(["gesturePinch", W], ["trackpad", M], ["displayPanel", W]),
    medium: p(["gesturePinch", M], ["trackpad", M], ["displayPanel", M]),
    narrow: p(["gesturePinch", N], ["zoomBadge", N]),
  },
  { id: "view.rotate", wide: p(["gestureTwist", W], ["displayPanel", W]), medium: p(["gestureTwist", M], ["displayPanel", M]), narrow: p(["gestureTwist", N], ["displayPanel", N]) },
  { id: "view.flip", ...all("displayPanel") },
  { id: "xform.peek", ...all("transformBar") },
  { id: "view.miniToggle", wide: p(["displayPanel", W]), medium: p(["displayPanel", M]), narrow: none("notOnNarrow") },
  // キャンバスに集中 → ツールを隠す（下の帯の右端と 4 本指のタップ。スマホのボタンの置き場はスマホのシートのモックで決める）
  { id: "view.focusToggle", wide: p(["bottomBar", W], ["gestureTap4", W]), medium: p(["bottomBar", M], ["gestureTap4", M]), narrow: p(["gestureTap4", N]) },
];

/** ハードウェアキーボードの列（iPad のキーボードは M-2b-3 から）: PC の組み込みの割り当て（標準・左手向け）から作る */
export const KEYBOARD_SINCE: Milestone = "M-2b-3";

export interface KeyboardBindings {
  standard: KeyBinding | null;
  lefty: KeyBinding | null;
}

/** そのコマンドの PC の割り当て（標準・左手向け）。割り当てが無ければ null（手で書き写さない＝BUILTIN_PRESETS を読む） */
export function keyboardBindings(id: CommandId): KeyboardBindings {
  const of = (pid: string): KeyBinding | null => BUILTIN_PRESETS.find((x) => x.id === pid)?.bindings[id] ?? null;
  return { standard: of("standard"), lefty: of("lefty") };
}

/** 置き場の表の id（並び）と COMMANDS の id（並び）。網の検査が使う */
export function placeIds(): string[] {
  return COMMAND_PLACES.map((c) => c.id);
}
export function commandIds(): string[] {
  return COMMANDS.map((c) => c.id);
}
