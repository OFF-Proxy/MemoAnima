// M11-10: ショートカットキー体系（コマンド定義・プリセット・キーの引き当て）
//
// 設計の要点:
// - キーの識別は **e.code（物理キー位置）** を正とする。日本語配列/US配列の違いや、
//   左手デバイスが送るスキャンコードで割り当てがずれないため。表示は読みやすい名前へ変換する。
// - 「キー → コマンドID」は**引き当て表（Map）**を先に作る。キー1打ごとに線形探索しない。
// - Space と矢印キー・Escape・Backspace は**予約キー**。割り当ての対象にせず、
//   従来どおり editor.ts の固定の分岐が受ける（Space の長押し＝手のひらは M11-2 のまま）。
// - このファイルは editor / library / main のどこからでも使う（画面をまたぐ設定なので src 直下）。
//
// M12-1c-1（i18n）: **識別子と表示名を分けた**。
//   - `group` は `"tools"` のような **ASCII の識別子**（コードが比較に使う値）。以前は `"道具"` という
//     日本語がそのまま識別子で、`isToolCommand()` と main.ts が literal で比較していた＝
//     表示名を訳した瞬間に判定が壊れる形だった。
//   - 画面に出る文字は **`labelKey` / `noteKey` / `nameKey`（`*Key: "…"` の規約）** で辞書を引く。
//     この形にしておくと `scripts/m1201_i18n_check.ts` の検査4 が動的キーを見られる。
//   - 文字列を返す関数（`reservedReason` / `bindingCaveat` / `codeLabel`）は**関数の中で `t()` を呼ぶ**。
//     「キーを返して呼び出し側で訳す」形にすると、キーが検査から見えなくなるため。
import { t } from "./i18n";
import { customPresetBaseName } from "./i18n/defaults";

export interface KeyBinding {
  /** KeyboardEvent.code（"KeyP" / "BracketLeft" / "Delete" …）。
   *  M16 (K-4): **ポインタ割り当てのときは "" **（button 側が実体）。追加のみ＝旧データは code だけ持つ */
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** M16 (K-4): 修飾キー＋クリックのポインタ割り当て（0=左 / 1=中 / 2=右）。
   *  **素の左クリック（無修飾 button=0）は割り当て不可**（描画と衝突・sanitize で弾く）。未指定＝キーボード割り当て */
  button?: 0 | 1 | 2;
}

/** 設定画面の分類（**識別子**。表示名は COMMAND_GROUPS の labelKey で引く） */
export type CommandGroupId = "tools" | "penSize" | "edit" | "file" | "frame" | "playView";

export interface CommandDef {
  id: string;
  /** 表示名の辞書キー（M12-1c-1: 旧 `label`） */
  labelKey: string;
  /** 設定画面での分類（この順に並べる）。**識別子**であって表示名ではない */
  group: CommandGroupId;
  /** 押しっぱなしのキーリピートで繰り返してよいか（既定 false＝1回だけ） */
  repeatable?: boolean;
  /** 備考（設定画面の行に小さく出す）の辞書キー（M12-1c-1: 旧 `note`） */
  noteKey?: string;
}

/** M11-10: キーを割り当てられる操作の母集合。
 *  **既存のボタンにキーを付けるだけ**で、新しい機能は1つも作らない。
 *  （オニオンや紙色のように「押すたびに状態が巡る」形の操作は、既存 UI に
 *   その動きが無いので入れていない＝新機能になってしまうため） */
export const COMMANDS = [
  // ---- 道具 ----
  { id: "tool.pen", labelKey: "keys.cmd.toolPen.label", group: "tools" },
  { id: "tool.brush", labelKey: "keys.cmd.toolBrush.label", group: "tools" },
  { id: "tool.eraser", labelKey: "keys.cmd.toolEraser.label", group: "tools" },
  { id: "tool.fill", labelKey: "keys.cmd.toolFill.label", group: "tools" },
  { id: "tool.shape", labelKey: "keys.cmd.toolShape.label", group: "tools" },
  { id: "tool.text", labelKey: "keys.cmd.toolText.label", group: "tools" },
  { id: "tool.eyedrop", labelKey: "keys.cmd.toolEyedrop.label", group: "tools" },
  { id: "tool.hand", labelKey: "keys.cmd.toolHand.label", group: "tools" },
  { id: "tool.move", labelKey: "keys.cmd.toolMove.label", group: "tools" },
  { id: "tool.select", labelKey: "keys.cmd.toolSelect.label", group: "tools" },
  { id: "tool.transform", labelKey: "keys.cmd.toolTransform.label", group: "tools" },
  { id: "tool.warp", labelKey: "keys.cmd.toolWarp.label", group: "tools" },
  // ---- ペンの太さ ----
  { id: "pen.sizeDown", labelKey: "keys.cmd.penSizeDown.label", group: "penSize", repeatable: true },
  { id: "pen.sizeUp", labelKey: "keys.cmd.penSizeUp.label", group: "penSize", repeatable: true },
  { id: "pen.size1", labelKey: "keys.cmd.penSize1.label", group: "penSize" },
  { id: "pen.size2", labelKey: "keys.cmd.penSize2.label", group: "penSize" },
  { id: "pen.size3", labelKey: "keys.cmd.penSize3.label", group: "penSize" },
  { id: "pen.size4", labelKey: "keys.cmd.penSize4.label", group: "penSize" },
  { id: "pen.size5", labelKey: "keys.cmd.penSize5.label", group: "penSize" },
  { id: "pen.size6", labelKey: "keys.cmd.penSize6.label", group: "penSize" },
  // ---- 編集 ----
  { id: "edit.undo", labelKey: "keys.cmd.editUndo.label", group: "edit", repeatable: true },
  { id: "edit.redo", labelKey: "keys.cmd.editRedo.label", group: "edit", repeatable: true },
  { id: "edit.copy", labelKey: "keys.cmd.editCopy.label", group: "edit" },
  { id: "edit.cut", labelKey: "keys.cmd.editCut.label", group: "edit" },
  { id: "edit.paste", labelKey: "keys.cmd.editPaste.label", group: "edit" },
  {
    id: "edit.deleteSelection",
    labelKey: "keys.cmd.editDeleteSelection.label",
    group: "edit",
    noteKey: "keys.cmd.editDeleteSelection.hint",
  },
  { id: "edit.copyPrev", labelKey: "keys.cmd.editCopyPrev.label", group: "edit" },
  { id: "edit.clearFrame", labelKey: "keys.cmd.editClearFrame.label", group: "edit" },
  // M16 (K-4): 修飾キー＋クリックで色を拾う（スポイト tool と違い**ツールを切り替えない**＝その場で1回拾うだけ）。
  // 既定プリセットで Alt＋クリックに割り当てる（クリスタ準拠）
  { id: "edit.pickColor", labelKey: "keys.cmd.editPickColor.label", group: "edit", noteKey: "keys.cmd.editPickColor.hint" },
  // ---- M11-19: 線を太らせる／細らせる（1ドット）。**repeatable にしない**（押しっぱなしで履歴が暴発するため）----
  {
    id: "edit.thicken",
    labelKey: "keys.cmd.editThicken.label",
    group: "edit",
    noteKey: "keys.cmd.editThicken.hint",
  },
  {
    id: "edit.thin",
    labelKey: "keys.cmd.editThin.label",
    group: "edit",
    noteKey: "keys.cmd.editThin.hint",
  },
  // ---- M11-15: レイヤーのコピー＆ペースト（コマ1枚ぶん・レイヤー専用の控え） ----
  { id: "layer.copy", labelKey: "keys.cmd.layerCopy.label", group: "edit", noteKey: "keys.cmd.layerCopy.hint" },
  { id: "layer.paste", labelKey: "keys.cmd.layerPaste.label", group: "edit", noteKey: "keys.cmd.layerPaste.hint" },
  { id: "layer.pasteNew", labelKey: "keys.cmd.layerPasteNew.label", group: "edit" },
  { id: "layer.pasteAll", labelKey: "keys.cmd.layerPasteAll.label", group: "edit", noteKey: "keys.cmd.layerPasteAll.hint" },
  // ---- ファイル ----
  { id: "file.save", labelKey: "keys.cmd.fileSave.label", group: "file" },
  { id: "file.saveAs", labelKey: "keys.cmd.fileSaveAs.label", group: "file" },
  { id: "file.export", labelKey: "keys.cmd.fileExport.label", group: "file" },
  { id: "file.image", labelKey: "keys.cmd.fileImage.label", group: "file" },
  { id: "file.audio", labelKey: "keys.cmd.fileAudio.label", group: "file" },
  // ---- コマ ----
  { id: "frame.prev", labelKey: "keys.cmd.framePrev.label", group: "frame", repeatable: true, noteKey: "keys.cmd.framePrev.hint" },
  { id: "frame.next", labelKey: "keys.cmd.frameNext.label", group: "frame", repeatable: true, noteKey: "keys.cmd.frameNext.hint" },
  { id: "frame.add", labelKey: "keys.cmd.frameAdd.label", group: "frame" },
  { id: "frame.duplicate", labelKey: "keys.cmd.frameDuplicate.label", group: "frame" },
  { id: "frame.delete", labelKey: "keys.cmd.frameDelete.label", group: "frame" },
  { id: "frame.copyPage", labelKey: "keys.cmd.frameCopyPage.label", group: "frame" },
  { id: "frame.pastePage", labelKey: "keys.cmd.framePastePage.label", group: "frame" },
  { id: "frame.wobble", labelKey: "keys.cmd.frameWobble.label", group: "frame" },
  // ---- 再生・表示 ----
  {
    id: "play.toggle",
    labelKey: "keys.cmd.playToggle.label",
    group: "playView",
    noteKey: "keys.cmd.playToggle.hint",
  },
  { id: "play.loop", labelKey: "keys.cmd.playLoop.label", group: "playView" },
  { id: "view.zoomIn", labelKey: "keys.cmd.viewZoomIn.label", group: "playView", repeatable: true },
  { id: "view.zoomOut", labelKey: "keys.cmd.viewZoomOut.label", group: "playView", repeatable: true },
  { id: "view.rotate", labelKey: "keys.cmd.viewRotate.label", group: "playView" },
  { id: "view.flip", labelKey: "keys.cmd.viewFlip.label", group: "playView" },
  {
    id: "xform.peek",
    labelKey: "keys.cmd.xformPeek.label",
    group: "playView",
    noteKey: "keys.cmd.xformPeek.hint",
  },
  {
    // M11-16: 中身は「HUD をまとめて隠す/出す」に置き換わったが、**id は据え置き**
    //（旧プリセットに保存された割り当てが、そのまま新しいトグルを動かす＝移行処理不要）
    id: "view.miniToggle",
    labelKey: "keys.cmd.viewMiniToggle.label",
    group: "playView",
    noteKey: "keys.cmd.viewMiniToggle.hint",
  },
  {
    // M11-18: キャンバス集中（3パネルを一括で畳む／畳む前へ戻す）。既定は未割り当て（Tab は既定にしない）
    id: "view.focusToggle",
    labelKey: "keys.cmd.viewFocusToggle.label",
    group: "playView",
    noteKey: "keys.cmd.viewFocusToggle.hint",
  },
] as const satisfies readonly CommandDef[];

export type CommandId = (typeof COMMANDS)[number]["id"];

/** 設定画面の分類。**id は識別子（保存も比較もこれ）／labelKey は見出しの辞書キー**。
 *  M12-1c-1 以前は `["道具", …]` という日本語の配列で、識別子と表示名が同じ文字列だった */
export const COMMAND_GROUPS: readonly { id: CommandGroupId; labelKey: string }[] = [
  { id: "tools", labelKey: "keys.group.tools.label" },
  { id: "penSize", labelKey: "keys.group.penSize.label" },
  { id: "edit", labelKey: "keys.group.edit.label" },
  { id: "file", labelKey: "keys.group.file.label" },
  { id: "frame", labelKey: "keys.group.frame.label" },
  { id: "playView", labelKey: "keys.group.playView.label" },
];

/** 「道具」グループの識別子（main.ts が巡回の説明を出す判定に使う） */
export const TOOL_GROUP: CommandGroupId = "tools";

/** 割り当ての対象にしない予約キー（editor.ts の固定の分岐が受ける）。
 *  Space=再生/手のひら・矢印=コマ移動/1ドット移動・Escape=段階的な取り消し。
 *  M11-15: Backspace は予約から**外した**（割り当て可能）。ただし選択範囲があるときの
 *  「選択範囲の消去」は onKeyDown の固定分岐が**最優先**のまま＝割り当てが効くのは選択が無いときだけ */
export const RESERVED_CODES = new Set([
  "Space",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Escape",
  "Tab",
]);

/** M12-1c-1: **キーではなく訳文を返す**。キーを返して呼び出し側で `t()` すると、
 *  そのキーが検査4（参照キーの実在チェック）から見えなくなるため */
export function reservedReason(code: string): string | null {
  switch (code) {
    case "Space":
      return t("keys.reserved.space.msg");
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown":
      return t("keys.reserved.arrow.msg");
    case "Escape":
      return t("keys.reserved.escape.msg");
    case "Tab":
      return t("keys.reserved.tab.msg");
    default:
      return null;
  }
}

/** M11-15: 割り当てはできるが、条件つきで先に別の動作が走るキーの案内（設定画面で見せる） */
export function bindingCaveat(code: string): string | null {
  if (code === "Backspace") return t("keys.caveat.backspace.msg");
  return null;
}

/** テンキーの Enter は本体の Enter と同じ扱いにする（従来 e.key で見ていたので同じ挙動だった） */
function normCode(code: string): string {
  return code === "NumpadEnter" ? "Enter" : code;
}

/** 引き当て表のキー（修飾キー込みの正規化文字列）。
 *  Windows キー（metaKey）は **Ctrl とは別物**として扱う（M11-5 の「Win+H で手のひらにしない」と同じ考え方。
 *  折り畳むと Win+Z が Ctrl+Z と一致して元に戻ってしまう）。割り当て側は meta を持てないので、
 *  Win を押しながらの打鍵は**どのコマンドにも一致しない**＝従来どおり何も起きない */
export function bindingKey(b: KeyBinding): string {
  const mods = `${b.ctrl ? "C" : ""}${b.shift ? "S" : ""}${b.alt ? "A" : ""}`;
  // M16 (K-4): ポインタ割り当ては `…|B0/B1/B2`。code（"KeyP" 等）とは字面が重ならない＝キーボードと衝突しない
  if (b.button !== undefined) return `${mods}|B${b.button}`;
  return `${mods}|${normCode(b.code)}`;
}

/** KeyboardEvent から引き当て表のキーを作る */
export function eventKey(e: KeyboardEvent): string {
  return `${e.ctrlKey ? "C" : ""}${e.shiftKey ? "S" : ""}${e.altKey ? "A" : ""}${
    e.metaKey ? "M" : ""
  }|${normCode(e.code)}`;
}

/** M16 (K-4): pointerdown から引き当て表のキーを作る（ポインタ割り当ての照合用）。
 *  meta（Win）は割り当て側が持てないので M を混ぜて**わざと一致させない**（eventKey と同じ考え方）。 */
export function pointerEventKey(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  button: number;
}): string {
  return `${e.ctrlKey ? "C" : ""}${e.shiftKey ? "S" : ""}${e.altKey ? "A" : ""}${
    e.metaKey ? "M" : ""
  }|B${e.button}`;
}

/** KeyboardEvent → KeyBinding（設定画面のキー取得用）。Windows キーは無視する（登録できない） */
export function bindingFromEvent(e: KeyboardEvent): KeyBinding {
  const b: KeyBinding = { code: normCode(e.code) };
  if (e.ctrlKey) b.ctrl = true;
  if (e.shiftKey) b.shift = true;
  if (e.altKey) b.alt = true;
  return b;
}

/** M16 (K-4): PointerEvent → KeyBinding（設定画面の修飾キー＋クリック取得用）。
 *  code は "" にして button を実体にする。**素の左クリック（無修飾 button=0）は呼び出し側が渡さない**（弾く）。 */
export function bindingFromPointer(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  button: number;
}): KeyBinding {
  const b: KeyBinding = { code: "", button: (e.button === 1 ? 1 : e.button === 2 ? 2 : 0) as 0 | 1 | 2 };
  if (e.ctrlKey) b.ctrl = true;
  if (e.shiftKey) b.shift = true;
  if (e.altKey) b.alt = true;
  return b;
}

/** e.code → 表示名（"KeyQ" → "Q"）。
 *  M12-1c-1: 記号・英数はキーの**刻印そのもの**なので訳さない（どの言語でも `[` は `[`）。
 *  訳すのは「テンキー」という**語**だけ＝ `{key}` に刻印を差し込む1本のキーで賄う。 */
export function codeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return t("keys.code.numpad.label", { key: code.slice(6) });
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  const NUMPAD: Record<string, string> = {
    NumpadEnter: "Enter",
    NumpadAdd: "+",
    NumpadSubtract: "-",
    NumpadMultiply: "*",
    NumpadDivide: "/",
    NumpadDecimal: ".",
  };
  if (NUMPAD[code]) return t("keys.code.numpad.label", { key: NUMPAD[code] });
  const map: Record<string, string> = {
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: ":",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Minus: "-",
    Equal: "^",
    Backquote: "@",
    IntlRo: "＿",
    IntlYen: "¥",
    Delete: "Delete",
    Backspace: "Backspace",
    Enter: "Enter",
    Space: "Space",
    Escape: "Esc",
    Tab: "Tab",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
  };
  return map[code] ?? code;
}

/** M16 (K-4): ポインタボタンの表示名（0=クリック / 1=中クリック / 2=右クリック）。訳文は辞書から */
function pointerLabel(button: 0 | 1 | 2): string {
  return button === 1
    ? t("keys.pointer.mid.label")
    : button === 2
      ? t("keys.pointer.right.label")
      : t("keys.pointer.left.label");
}

export function keyLabel(b: KeyBinding | null | undefined): string {
  if (!b) return "";
  const mods = [b.ctrl ? "Ctrl" : "", b.shift ? "Shift" : "", b.alt ? "Alt" : ""].filter(Boolean);
  // M16 (K-4): ポインタ割り当ては「Alt＋クリック」等（末尾がボタン名）
  const last = b.button !== undefined ? pointerLabel(b.button) : codeLabel(b.code);
  return [...mods, last].join("+");
}

export type Bindings = Partial<Record<CommandId, KeyBinding>>;

export interface Preset {
  id: string;
  /** 表示名。**ユーザー定義プリセットではユーザーのデータ**（改名できる・settings.json に保存される）。
   *  組み込みは nameKey 側を使うので、ここは辞書を引く前のフォールバックでしかない */
  name: string;
  /** M12-1c-1: 組み込みプリセットの表示名の辞書キー。
   *  組み込みは `sanitizeKeysSettings` が id ごと弾く＝**保存されない**ので訳してよい。
   *  ユーザー定義には付かない（＝ name が正） */
  nameKey?: string;
  bindings: Bindings;
  /** 組み込み（編集不可） */
  builtin?: boolean;
}

/** プリセットの表示名。組み込みは辞書から、ユーザー定義は保存された名前をそのまま。
 *  **保存されるユーザーデータは訳さない**（master §5）ので、この関数が唯一の分岐点 */
export function presetName(p: Preset): string {
  return p.nameKey ? t(p.nameKey) : p.name;
}

/** 組み込み「標準」。既存16個のキーはそのまま＋道具と太さを追加 */
const STANDARD: Bindings = {
  "tool.pen": { code: "KeyP" },
  "tool.eraser": { code: "KeyE" },
  "tool.brush": { code: "KeyB" },
  "tool.fill": { code: "KeyG" },
  "tool.shape": { code: "KeyU" },
  "tool.text": { code: "KeyT" },
  "tool.eyedrop": { code: "KeyI" },
  "tool.hand": { code: "KeyH" },
  "tool.move": { code: "KeyK" },
  "tool.select": { code: "KeyM" },
  "tool.transform": { code: "KeyV" },
  "tool.warp": { code: "KeyW" },
  "pen.sizeDown": { code: "BracketLeft" },
  "pen.sizeUp": { code: "BracketRight" },
  // M11-11: 変形中に下の絵を透かす（押している間だけ）。空いているキーを既定に置く
  "xform.peek": { code: "KeyQ" },
  // ここから下は M11-9 以前からある16個（挙動も既定も変えない）
  "edit.undo": { code: "KeyZ", ctrl: true },
  "edit.redo": { code: "KeyY", ctrl: true },
  "edit.copy": { code: "KeyC", ctrl: true },
  "edit.cut": { code: "KeyX", ctrl: true },
  "edit.paste": { code: "KeyV", ctrl: true },
  "edit.deleteSelection": { code: "Delete" },
  "file.save": { code: "KeyS", ctrl: true },
  "file.saveAs": { code: "KeyS", ctrl: true, shift: true },
  "frame.copyPage": { code: "KeyC", ctrl: true, shift: true },
  "frame.pastePage": { code: "KeyV", ctrl: true, shift: true },
  "play.toggle": { code: "Enter" },
  // M16 (K-4): Alt＋クリックでスポイト（クリスタ準拠）。組み込み既定にだけ入れる（ユーザー保存済みには足さない）
  "edit.pickColor": { code: "", button: 0, alt: true },
};

/** 組み込み「左手向け」。左手が届く範囲（QWER/ASDF/ZXCV）に道具を集約する。
 *  Ctrl 系の固定キーはこのプリセットでも生きている（Z 単独はその追加） */
const LEFTY: Bindings = {
  "tool.eyedrop": { code: "KeyQ" },
  "tool.pen": { code: "KeyW" },
  "tool.eraser": { code: "KeyE" },
  "tool.brush": { code: "KeyR" },
  "tool.select": { code: "KeyA" },
  "tool.shape": { code: "KeyS" },
  "tool.fill": { code: "KeyD" },
  "tool.text": { code: "KeyF" },
  "edit.undo": { code: "KeyZ" },
  "tool.transform": { code: "KeyX" },
  "tool.warp": { code: "KeyC" },
  "tool.hand": { code: "KeyV" },
  "pen.sizeDown": { code: "KeyT" },
  "pen.sizeUp": { code: "KeyG" },
  // 固定キーぶん（標準と同じ）
  "edit.redo": { code: "KeyY", ctrl: true },
  "edit.copy": { code: "KeyC", ctrl: true },
  "edit.cut": { code: "KeyX", ctrl: true },
  "edit.paste": { code: "KeyV", ctrl: true },
  "edit.deleteSelection": { code: "Delete" },
  "file.save": { code: "KeyS", ctrl: true },
  "file.saveAs": { code: "KeyS", ctrl: true, shift: true },
  "frame.copyPage": { code: "KeyC", ctrl: true, shift: true },
  "frame.pastePage": { code: "KeyV", ctrl: true, shift: true },
  "play.toggle": { code: "Enter" },
  // M16 (K-4): Alt＋クリックでスポイト（クリスタ準拠）。組み込み既定にだけ入れる
  "edit.pickColor": { code: "", button: 0, alt: true },
};

export const BUILTIN_PRESETS: Preset[] = [
  { id: "standard", name: "standard", nameKey: "keys.preset.standard.label", bindings: STANDARD, builtin: true },
  { id: "lefty", name: "lefty", nameKey: "keys.preset.lefty.label", bindings: LEFTY, builtin: true },
];

export const MAX_USER_PRESETS = 8;

export interface KeysSettings {
  activeId: string;
  /** ユーザー定義のみ（組み込みは保存しない） */
  presets: Preset[];
}

export function defaultKeysSettings(): KeysSettings {
  return { activeId: "standard", presets: [] };
}

const COMMAND_IDS = new Set<string>(COMMANDS.map((c) => c.id));

function sanitizeBinding(v: unknown): KeyBinding | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ctrl = o.ctrl === true;
  const shift = o.shift === true;
  const alt = o.alt === true;
  // M16 (K-4): ポインタ割り当て（button が 0/1/2）。**素の左クリック（無修飾 button=0）は拒否**
  //（描画と衝突するため受け付けない。中/右クリックは無修飾でも描画と衝突しないので可）
  if (o.button === 0 || o.button === 1 || o.button === 2) {
    if (o.button === 0 && !ctrl && !shift && !alt) return null;
    const b: KeyBinding = { code: "", button: o.button };
    if (ctrl) b.ctrl = true;
    if (shift) b.shift = true;
    if (alt) b.alt = true;
    return b;
  }
  if (typeof o.code !== "string" || !o.code || o.code.length > 32) return null;
  if (RESERVED_CODES.has(o.code)) return null; // 予約キーは読み込み時にも受け付けない
  const b: KeyBinding = { code: o.code };
  if (ctrl) b.ctrl = true;
  if (shift) b.shift = true;
  if (alt) b.alt = true;
  return b;
}

/** settings.json の keys を正規化する。**壊れた項目だけ捨てて既定へ**（全体は捨てない） */
export function sanitizeKeysSettings(raw: unknown): KeysSettings {
  const out = defaultKeysSettings();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  const presets: Preset[] = [];
  if (Array.isArray(o.presets)) {
    for (const p of o.presets) {
      if (!p || typeof p !== "object") continue;
      const po = p as Record<string, unknown>;
      const id = typeof po.id === "string" && po.id ? po.id.slice(0, 64) : "";
      if (!id || id === "standard" || id === "lefty") continue; // 組み込みidは奪わせない
      if (presets.some((x) => x.id === id)) continue;
      const name =
        typeof po.name === "string" && po.name.trim() ? po.name.trim().slice(0, 40) : customPresetBaseName();
      const bindings: Bindings = {};
      const rawB = po.bindings;
      if (rawB && typeof rawB === "object") {
        // 同じキーが2つのコマンドに入っている保存データ（手で書き換えた場合）は、
        // 先に出てきたほうだけ残す＝あとは未割り当て（REQ「同じキーに2つは割り当てられない」）。
        // M11-15: ただし**道具どうし**は同キーを共有してよい（巡回）ので、そのキーの先客が
        // 全部道具で、今回も道具なら通す
        const used = new Map<string, string[]>(); // key → そのキーを持つコマンドID
        for (const [k, v] of Object.entries(rawB as Record<string, unknown>)) {
          if (!COMMAND_IDS.has(k)) continue; // 知らないコマンドは捨てる
          const b = sanitizeBinding(v);
          if (!b) continue;
          const bk = bindingKey(b);
          const owners = used.get(bk);
          if (owners) {
            if (!(isToolCommand(k) && owners.every(isToolCommand))) continue;
            owners.push(k);
          } else used.set(bk, [k]);
          bindings[k as CommandId] = b;
        }
      }
      // 旧案の playSubKey を読めるようにしておく（bindings 側が正）
      if (!bindings["play.toggle"]) {
        const sub = sanitizeBinding(po.playSubKey);
        if (sub) bindings["play.toggle"] = sub;
      }
      presets.push({ id, name, bindings });
      if (presets.length >= MAX_USER_PRESETS) break;
    }
  }
  out.presets = presets;
  const active = typeof o.activeId === "string" ? o.activeId : "";
  out.activeId =
    active && (active === "standard" || active === "lefty" || presets.some((p) => p.id === active))
      ? active
      : "standard";
  return out;
}

/** 有効なプリセットを取り出す（見つからなければ「標準」） */
export function activePreset(keys: KeysSettings): Preset {
  const all = [...BUILTIN_PRESETS, ...keys.presets];
  return all.find((p) => p.id === keys.activeId) ?? BUILTIN_PRESETS[0];
}

/** M11-10: M11-9 以前からある固定キー。**どのプリセットでも生きている**（REQ「Ctrl+Z 等の固定キーは
 *  このプリセットでも生きている。Z 単独はその追加」）。プリセット側に同じキーの割り当てがあれば
 *  そちらが勝つので、「Ctrl+Z を別のコマンドに割り当て直す」こともできる。
 *  Enter / Escape / Space / ←→ / Backspace は onKeyDown の固定の分岐が受けるのでここには要らない */
const LEGACY_BINDINGS: { id: CommandId; b: KeyBinding }[] = [
  { id: "edit.undo", b: { code: "KeyZ", ctrl: true } },
  { id: "edit.redo", b: { code: "KeyY", ctrl: true } },
  { id: "edit.copy", b: { code: "KeyC", ctrl: true } },
  { id: "edit.cut", b: { code: "KeyX", ctrl: true } },
  { id: "edit.paste", b: { code: "KeyV", ctrl: true } },
  { id: "edit.deleteSelection", b: { code: "Delete" } },
  { id: "file.save", b: { code: "KeyS", ctrl: true } },
  { id: "file.saveAs", b: { code: "KeyS", ctrl: true, shift: true } },
  { id: "frame.copyPage", b: { code: "KeyC", ctrl: true, shift: true } },
  { id: "frame.pastePage", b: { code: "KeyV", ctrl: true, shift: true } },
  { id: "tool.hand", b: { code: "KeyH" } },
];

/** 「道具」グループのコマンドか（M11-15: 同キー巡回の対象）。
 *  M12-1c-1: 比較先は**識別子** TOOL_GROUP（旧: 表示名の "道具" と同じ文字列だった） */
export function isToolCommand(id: string): boolean {
  return COMMANDS.some((c) => c.id === id && c.group === TOOL_GROUP);
}

/** コマンドの表示名（動的キーを引く唯一の口） */
export function commandLabel(id: string): string {
  const c = COMMANDS.find((x) => x.id === id);
  return c ? t(c.labelKey) : id;
}

/** COMMANDS の定義順（巡回順・設定順に依存しない） */
const COMMAND_ORDER = new Map<string, number>(COMMANDS.map((c, i) => [c.id, i]));

/** キー → コマンドID**列**の引き当て表を作る（キー1打ごとに探索しない）。
 *
 *  M11-15: 値を1つから**配列**にした。「道具」グループのコマンド同士に限り同じキーを
 *  共有でき（押すたびに巡回）、その場合は配列に複数入る。**巡回順は COMMANDS の定義順**
 *  で固定（設定した順序に依存しない＝予測可能）。道具以外は従来どおり1つだけ
 *  （設定画面が衝突を防ぐので通常は1つ。万一2つ入っていれば後勝ち＝従来の Map.set と同じ） */
export function buildLookup(preset: Preset): Map<string, CommandId[]> {
  const m = new Map<string, CommandId[]>();
  const put = (key: string, id: CommandId) => {
    const cur = m.get(key);
    if (!cur) {
      m.set(key, [id]);
      return;
    }
    if (isToolCommand(id) && cur.every(isToolCommand)) {
      if (!cur.includes(id)) {
        cur.push(id);
        cur.sort((a, b) => (COMMAND_ORDER.get(a) ?? 0) - (COMMAND_ORDER.get(b) ?? 0));
      }
      return;
    }
    // 道具以外が絡むときは上書き（従来どおり後勝ち）
    m.set(key, [id]);
  };
  // 先に固定キーを入れ、プリセット側で同じキーが使われていれば上書きさせる
  for (const l of LEGACY_BINDINGS) put(bindingKey(l.b), l.id);
  for (const [id, b] of Object.entries(preset.bindings)) {
    if (!b) continue;
    if (RESERVED_CODES.has(b.code)) continue;
    put(bindingKey(b as KeyBinding), id as CommandId);
  }
  return m;
}

/** そのプリセットで、この割り当てを既に使っているコマンド（衝突検出）。
 *  M11-15: **道具同士は衝突ではない**（同キー巡回で共存する）ので null を返す。
 *  道具どうし以外（片方でも道具以外）は従来どおり衝突として返す */
export function findConflict(
  preset: Preset,
  b: KeyBinding,
  exceptId?: CommandId
): CommandId | null {
  const key = bindingKey(b);
  for (const [id, cur] of Object.entries(preset.bindings)) {
    if (!cur || id === exceptId) continue;
    if (bindingKey(cur as KeyBinding) !== key) continue;
    if (exceptId && isToolCommand(exceptId) && isToolCommand(id)) continue; // 共存できる
    return id as CommandId;
  }
  return null;
}

/** M11-15: そのプリセットで、この道具コマンドと同じキーを共有している道具（自分を除く・定義順）。
 *  設定画面の「同キー共有中」表示に使う */
export function sharedToolMates(preset: Preset, id: CommandId): CommandId[] {
  const b = preset.bindings[id];
  if (!b || !isToolCommand(id)) return [];
  const key = bindingKey(b);
  return Object.entries(preset.bindings)
    .filter(([oid, ob]) => oid !== id && !!ob && isToolCommand(oid) && bindingKey(ob as KeyBinding) === key)
    .map(([oid]) => oid as CommandId)
    .sort((x, y) => (COMMAND_ORDER.get(x) ?? 0) - (COMMAND_ORDER.get(y) ?? 0));
}

/** 「カスタムA」「カスタムB」… の次の名前。
 *  M12-1c-1: **翻訳しない**。この文字列はユーザーが改名でき、`settings.json` の
 *  `keys.presets[].name` に**保存される**＝ユーザーのデータ（master §5）。
 *  訳してしまうと、言語を切り替えたときに保存済みの名前と食い違う。
 *  既存の 無題 / 未分類 / レイヤー / フォルダ と同じ扱いで、検査5 の ALLOW_LITERALS に載せている */
export function nextPresetName(existing: Preset[]): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const ch of letters) {
    const name = `${customPresetBaseName()}${ch}`;
    if (!existing.some((p) => p.name === name)) return name;
  }
  return customPresetBaseName();
}

export function newPresetId(existing: Preset[]): string {
  let n = 1;
  for (;;) {
    const id = `user${n}`;
    if (!existing.some((p) => p.id === id)) return id;
    n++;
  }
}
