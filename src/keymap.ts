// M11-10: ショートカットキー体系（コマンド定義・プリセット・キーの引き当て）
//
// 設計の要点:
// - キーの識別は **e.code（物理キー位置）** を正とする。日本語配列/US配列の違いや、
//   左手デバイスが送るスキャンコードで割り当てがずれないため。表示は読みやすい名前へ変換する。
// - 「キー → コマンドID」は**引き当て表（Map）**を先に作る。キー1打ごとに線形探索しない。
// - Space と矢印キー・Escape・Backspace は**予約キー**。割り当ての対象にせず、
//   従来どおり editor.ts の固定の分岐が受ける（Space の長押し＝手のひらは M11-2 のまま）。
// - このファイルは editor / library / main のどこからでも使う（画面をまたぐ設定なので src 直下）。

export interface KeyBinding {
  /** KeyboardEvent.code（"KeyP" / "BracketLeft" / "Delete" …） */
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface CommandDef {
  id: string;
  label: string;
  /** 設定画面での分類（この順に並べる） */
  group: string;
  /** 押しっぱなしのキーリピートで繰り返してよいか（既定 false＝1回だけ） */
  repeatable?: boolean;
  /** 備考（設定画面の行に小さく出す） */
  note?: string;
}

/** M11-10: キーを割り当てられる操作の母集合。
 *  **既存のボタンにキーを付けるだけ**で、新しい機能は1つも作らない。
 *  （オニオンや紙色のように「押すたびに状態が巡る」形の操作は、既存 UI に
 *   その動きが無いので入れていない＝新機能になってしまうため） */
export const COMMANDS = [
  // ---- 道具 ----
  { id: "tool.pen", label: "ペン", group: "道具" },
  { id: "tool.brush", label: "ブラシ", group: "道具" },
  { id: "tool.eraser", label: "消しゴム", group: "道具" },
  { id: "tool.fill", label: "塗り（バケツ）", group: "道具" },
  { id: "tool.shape", label: "図形", group: "道具" },
  { id: "tool.text", label: "文字", group: "道具" },
  { id: "tool.eyedrop", label: "スポイト", group: "道具" },
  { id: "tool.hand", label: "手のひら", group: "道具" },
  { id: "tool.move", label: "移動", group: "道具" },
  { id: "tool.select", label: "範囲選択", group: "道具" },
  { id: "tool.transform", label: "変形", group: "道具" },
  { id: "tool.warp", label: "歪み", group: "道具" },
  // ---- ペンの太さ ----
  { id: "pen.sizeDown", label: "1段細く", group: "ペンの太さ", repeatable: true },
  { id: "pen.sizeUp", label: "1段太く", group: "ペンの太さ", repeatable: true },
  { id: "pen.size1", label: "太さ 1", group: "ペンの太さ" },
  { id: "pen.size2", label: "太さ 2", group: "ペンの太さ" },
  { id: "pen.size3", label: "太さ 3", group: "ペンの太さ" },
  { id: "pen.size4", label: "太さ 5", group: "ペンの太さ" },
  { id: "pen.size5", label: "太さ 8", group: "ペンの太さ" },
  { id: "pen.size6", label: "太さ 12", group: "ペンの太さ" },
  // ---- 編集 ----
  { id: "edit.undo", label: "元に戻す", group: "編集", repeatable: true },
  { id: "edit.redo", label: "やり直し", group: "編集", repeatable: true },
  { id: "edit.copy", label: "コピー（選択範囲）", group: "編集" },
  { id: "edit.cut", label: "切り取り（選択範囲）", group: "編集" },
  { id: "edit.paste", label: "貼り付け（選択範囲）", group: "編集" },
  {
    id: "edit.deleteSelection",
    label: "選択範囲を消去",
    group: "編集",
    note: "Backspace でも常に消せます",
  },
  { id: "edit.copyPrev", label: "前のコマを複写", group: "編集" },
  { id: "edit.clearFrame", label: "このコマを消す", group: "編集" },
  // ---- ファイル ----
  { id: "file.save", label: "保存", group: "ファイル" },
  { id: "file.saveAs", label: "別名で保存", group: "ファイル" },
  { id: "file.export", label: "書き出し", group: "ファイル" },
  { id: "file.image", label: "画像を取り込む", group: "ファイル" },
  { id: "file.audio", label: "音声パネル", group: "ファイル" },
  // ---- コマ ----
  { id: "frame.prev", label: "前のコマ", group: "コマ", repeatable: true, note: "← でも常に移動できます" },
  { id: "frame.next", label: "次のコマ", group: "コマ", repeatable: true, note: "→ でも常に移動できます" },
  { id: "frame.add", label: "コマを追加", group: "コマ" },
  { id: "frame.duplicate", label: "コマを複製", group: "コマ" },
  { id: "frame.delete", label: "コマを削除", group: "コマ" },
  { id: "frame.copyPage", label: "コマをコピー", group: "コマ" },
  { id: "frame.pastePage", label: "コマを貼り付け", group: "コマ" },
  { id: "frame.wobble", label: "ゆらゆら差分を作る", group: "コマ" },
  // ---- 再生・表示 ----
  {
    id: "play.toggle",
    label: "再生／一時停止（サブキー）",
    group: "再生・表示",
    note: "Space は固定で常に効きます",
  },
  { id: "play.loop", label: "ループの切り替え", group: "再生・表示" },
  { id: "view.zoomIn", label: "ズーム＋", group: "再生・表示", repeatable: true },
  { id: "view.zoomOut", label: "ズーム−", group: "再生・表示", repeatable: true },
  { id: "view.rotate", label: "表示を回転", group: "再生・表示" },
  { id: "view.flip", label: "表示を左右反転", group: "再生・表示" },
  {
    id: "xform.peek",
    label: "変形中に下の絵を透かす",
    group: "再生・表示",
    note: "押している間だけ薄くなります",
  },
] as const satisfies readonly CommandDef[];

export type CommandId = (typeof COMMANDS)[number]["id"];

export const COMMAND_GROUPS = ["道具", "ペンの太さ", "編集", "ファイル", "コマ", "再生・表示"];

/** 割り当ての対象にしない予約キー（editor.ts の固定の分岐が受ける）。
 *  Space=再生/手のひら・矢印=コマ移動/1ドット移動・Escape=段階的な取り消し・
 *  Backspace=選択範囲の消去（Delete と同じ・従来から2つある） */
export const RESERVED_CODES = new Set([
  "Space",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Escape",
  "Backspace",
  "Tab",
]);

export function reservedReason(code: string): string | null {
  switch (code) {
    case "Space":
      return "Space は再生／一時停止と手のひらで使うため、割り当てできません。";
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown":
      return "矢印キーはコマ移動と1ドット移動で使うため、割り当てできません。";
    case "Escape":
      return "Escape は取り消しで使うため、割り当てできません。";
    case "Backspace":
      return "Backspace は選択範囲の消去で使うため、割り当てできません。";
    case "Tab":
      return "Tab は画面の移動で使うため、割り当てできません。";
    default:
      return null;
  }
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
  return `${b.ctrl ? "C" : ""}${b.shift ? "S" : ""}${b.alt ? "A" : ""}|${normCode(b.code)}`;
}

/** KeyboardEvent から引き当て表のキーを作る */
export function eventKey(e: KeyboardEvent): string {
  return `${e.ctrlKey ? "C" : ""}${e.shiftKey ? "S" : ""}${e.altKey ? "A" : ""}${
    e.metaKey ? "M" : ""
  }|${normCode(e.code)}`;
}

/** KeyboardEvent → KeyBinding（設定画面のキー取得用）。Windows キーは無視する（登録できない） */
export function bindingFromEvent(e: KeyboardEvent): KeyBinding {
  const b: KeyBinding = { code: normCode(e.code) };
  if (e.ctrlKey) b.ctrl = true;
  if (e.shiftKey) b.shift = true;
  if (e.altKey) b.alt = true;
  return b;
}

/** e.code → 表示名（"KeyQ" → "Q"） */
export function codeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `テンキー${code.slice(6)}`;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
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
    NumpadEnter: "テンキーEnter",
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
    NumpadAdd: "テンキー+",
    NumpadSubtract: "テンキー-",
    NumpadMultiply: "テンキー*",
    NumpadDivide: "テンキー/",
    NumpadDecimal: "テンキー.",
  };
  return map[code] ?? code;
}

export function keyLabel(b: KeyBinding | null | undefined): string {
  if (!b) return "";
  const mods = [b.ctrl ? "Ctrl" : "", b.shift ? "Shift" : "", b.alt ? "Alt" : ""].filter(Boolean);
  return [...mods, codeLabel(b.code)].join("+");
}

export type Bindings = Partial<Record<CommandId, KeyBinding>>;

export interface Preset {
  id: string;
  name: string;
  bindings: Bindings;
  /** 組み込み（編集不可） */
  builtin?: boolean;
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
};

export const BUILTIN_PRESETS: Preset[] = [
  { id: "standard", name: "標準", bindings: STANDARD, builtin: true },
  { id: "lefty", name: "左手向け", bindings: LEFTY, builtin: true },
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
  if (typeof o.code !== "string" || !o.code || o.code.length > 32) return null;
  if (RESERVED_CODES.has(o.code)) return null; // 予約キーは読み込み時にも受け付けない
  const b: KeyBinding = { code: o.code };
  if (o.ctrl === true) b.ctrl = true;
  if (o.shift === true) b.shift = true;
  if (o.alt === true) b.alt = true;
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
        typeof po.name === "string" && po.name.trim() ? po.name.trim().slice(0, 40) : "カスタム";
      const bindings: Bindings = {};
      const rawB = po.bindings;
      if (rawB && typeof rawB === "object") {
        // 同じキーが2つのコマンドに入っている保存データ（手で書き換えた場合）は、
        // 先に出てきたほうだけ残す＝あとは未割り当て（REQ「同じキーに2つは割り当てられない」）
        const used = new Set<string>();
        for (const [k, v] of Object.entries(rawB as Record<string, unknown>)) {
          if (!COMMAND_IDS.has(k)) continue; // 知らないコマンドは捨てる
          const b = sanitizeBinding(v);
          if (!b) continue;
          const bk = bindingKey(b);
          if (used.has(bk)) continue;
          used.add(bk);
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

/** キー → コマンドID の引き当て表を作る（キー1打ごとに探索しない） */
export function buildLookup(preset: Preset): Map<string, CommandId> {
  const m = new Map<string, CommandId>();
  // 先に固定キーを入れ、プリセット側で同じキーが使われていれば上書きさせる
  for (const l of LEGACY_BINDINGS) m.set(bindingKey(l.b), l.id);
  for (const [id, b] of Object.entries(preset.bindings)) {
    if (!b) continue;
    if (RESERVED_CODES.has(b.code)) continue;
    m.set(bindingKey(b as KeyBinding), id as CommandId);
  }
  return m;
}

/** そのプリセットで、この割り当てを既に使っているコマンド（衝突検出） */
export function findConflict(
  preset: Preset,
  b: KeyBinding,
  exceptId?: CommandId
): CommandId | null {
  const key = bindingKey(b);
  for (const [id, cur] of Object.entries(preset.bindings)) {
    if (!cur || id === exceptId) continue;
    if (bindingKey(cur as KeyBinding) === key) return id as CommandId;
  }
  return null;
}

/** 「カスタムA」「カスタムB」… の次の名前 */
export function nextPresetName(existing: Preset[]): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const ch of letters) {
    const name = `カスタム${ch}`;
    if (!existing.some((p) => p.name === name)) return name;
  }
  return "カスタム";
}

export function newPresetId(existing: Preset[]): string {
  let n = 1;
  for (;;) {
    const id = `user${n}`;
    if (!existing.some((p) => p.id === id)) return id;
    n++;
  }
}
