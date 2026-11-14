// V225 (M-2b-3b-2・UI §6-11・指示書 ■3 の S-1): モバイルの設定の**決まり**（画面を持たない）。
//
// ★キーの表は 1 か所（SETTING_KEYS）。PC にあるものは PC のキーと値の形のまま（theme・lang・hiddenConfirms・frameDeleteConfirm・keys・shelfSort）。
//  モバイルだけのものは `mobile` で始める（決-17）。既定は「設定が無いときの今の動き」と同じ・不正な値は既定へ。
// ★書くのは変えたキーだけ（設定の口＝port.settingsMerge は、渡した一番上のキーごとに値を丸ごと置き換える）。`keys` は、読んだ `presets` を
//  そのまま残して `activeId` だけ替えたものを渡す。`hiddenConfirms` は、エディタの 3 つ以外（ギャラリーの案内など）を落とさない。
// ★PC が保存していないもの（ピクセル格子・筆圧で太さ・手ブレ補正）は保存しない。
// ★DOM を読まない（scripts/v225_smoke.ts [S] が Node で回す）。
import { sanitizeTheme, type Theme } from "../../ui/theme";
import { BUILTIN_PRESETS, activePreset, sanitizeKeysSettings, type Preset } from "../../keymap";
import { EDITOR_CONFIRM_IDS } from "../../galleryEntry";
import { defaultInputSettings, type InputSettings } from "../input/router";

/** 設定のキー（PC と同じ名前のものは pc: true） */
export const SETTING_KEYS = {
  theme: { key: "theme", pc: true },
  lang: { key: "lang", pc: true },
  hiddenConfirms: { key: "hiddenConfirms", pc: true },
  frameDeleteConfirm: { key: "frameDeleteConfirm", pc: true },
  keys: { key: "keys", pc: true },
  shelfSort: { key: "shelfSort", pc: true },
  hand: { key: "mobileHand", pc: false },
  flipPage: { key: "mobileFlipPage", pc: false },
  fingerDraw: { key: "mobileFingerDraw", pc: false },
  penDevice: { key: "mobilePenDevice", pc: false },
  noFinger: { key: "mobileNoFinger", pc: false },
  pressureCurve: { key: "mobilePressureCurve", pc: false },
  hover: { key: "mobileHover", pc: false },
  gestures: { key: "mobileGestures", pc: false },
  longPressMs: { key: "mobileLongPressMs", pc: false },
  undoBadge: { key: "mobileUndoBadge", pc: false },
  albumsFolded: { key: "mobileAlbumsFolded", pc: false },
} as const;

export type Hand = "right" | "left";
export type ShelfSort = "manual" | "name" | "date";
export type GestureId = "undoTap" | "redoTap" | "twist" | "toolsTap" | "longPress";
export const GESTURE_IDS: readonly GestureId[] = ["undoTap", "redoTap", "twist", "toolsTap", "longPress"];
export const LONG_PRESS_CHOICES: readonly number[] = [300, 500, 800];
export const PRESSURE_CHOICES = ["weak", "standard", "strong"] as const;
export const HOVER_CHOICES = ["ring", "cross", "none"] as const;
/** 確認の 4 つ（PC と同じ。上の 3 つは hiddenConfirms・最後は frameDeleteConfirm） */
export const CONFIRM_IDS = EDITOR_CONFIRM_IDS;

/** 読んだ設定（モバイルの画面が使う形。値は確かめたあと） */
export interface MobileSettings {
  theme: Theme;
  hand: Hand;
  flipPage: boolean;
  /** null＝利用者がまだ選んでいない（ペンを受けたら既定でオフ） */
  fingerDraw: boolean | null;
  penDevice: boolean;
  noFinger: boolean;
  pressureCurve: InputSettings["pressureCurve"];
  hover: InputSettings["hover"];
  gestures: Record<GestureId, boolean>;
  longPressMs: number;
  undoBadge: boolean;
  /** 隠した確認（エディタの 3 つのうち） */
  hiddenConfirms: string[];
  frameDeleteConfirm: boolean;
  /** キーボードの割り当て（組み込みの 2 つのどちらか。利用者のプリセットを選んでいたら、その名前のまま＝PC と同じ割り当てが効く） */
  keysActiveId: string;
  shelfSort: ShelfSort;
  albumsFolded: boolean;
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}
function oneOf<T extends string>(v: unknown, list: readonly T[], def: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : def;
}

/** 読んだ設定（何が入っているか分からない）から、確かめた値へ */
export function readMobileSettings(raw: Record<string, unknown>): MobileSettings {
  const K = SETTING_KEYS;
  const g = (raw[K.gestures.key] && typeof raw[K.gestures.key] === "object" ? raw[K.gestures.key] : {}) as Record<string, unknown>;
  const gestures = {} as Record<GestureId, boolean>;
  for (const id of GESTURE_IDS) gestures[id] = bool(g[id], true);
  const lp = raw[K.longPressMs.key];
  const hidden = Array.isArray(raw[K.hiddenConfirms.key]) ? (raw[K.hiddenConfirms.key] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    theme: sanitizeTheme(raw[K.theme.key]),
    hand: oneOf(raw[K.hand.key], ["right", "left"] as const, "right"),
    flipPage: bool(raw[K.flipPage.key], true),
    fingerDraw: typeof raw[K.fingerDraw.key] === "boolean" ? (raw[K.fingerDraw.key] as boolean) : null,
    penDevice: raw[K.penDevice.key] === true,
    noFinger: bool(raw[K.noFinger.key], false),
    pressureCurve: oneOf(raw[K.pressureCurve.key], PRESSURE_CHOICES, "standard"),
    hover: oneOf(raw[K.hover.key], HOVER_CHOICES, "ring"),
    gestures,
    longPressMs: typeof lp === "number" && LONG_PRESS_CHOICES.includes(lp) ? lp : 500,
    undoBadge: bool(raw[K.undoBadge.key], true),
    hiddenConfirms: hidden.filter((id) => CONFIRM_IDS.includes(id)),
    frameDeleteConfirm: raw[K.frameDeleteConfirm.key] !== false,
    keysActiveId: sanitizeKeysSettings(raw[K.keys.key]).activeId,
    shelfSort: oneOf(raw[K.shelfSort.key], ["manual", "name", "date"] as const, "manual"),
    albumsFolded: bool(raw[K.albumsFolded.key], false),
  };
}

/** 「指で描く」のスイッチに見せる値（選んでいなければ、ペンを受けた端末はオフ・そうでなければオン＝振り分け層と同じ決まり） */
export function fingerDrawShown(s: MobileSettings): boolean {
  return s.fingerDraw ?? !s.penDevice;
}

/** 振り分け層へ渡す形（筆圧で太さは描き味＝コアの側なので、ここでは既定のまま） */
export function inputSettingsFrom(s: MobileSettings): InputSettings {
  const d = defaultInputSettings();
  return {
    ...d,
    fingerDraw: s.fingerDraw,
    noFinger: s.noFinger,
    gestures: { undoTap: s.gestures.undoTap, redoTap: s.gestures.redoTap, toolsTap: s.gestures.toolsTap, twist: s.gestures.twist, longPress: s.gestures.longPress },
    longPressMs: s.longPressMs,
    pressureCurve: s.pressureCurve,
    hover: s.hover,
    undoBadge: s.undoBadge,
  };
}

/** いま効かせるキーの割り当て（PC と同じ決め方） */
export function keyPresetFrom(raw: Record<string, unknown>): Preset {
  return activePreset(sanitizeKeysSettings(raw[SETTING_KEYS.keys.key]));
}

/** 設定の画面で選べる割り当て（組み込みの 2 つ） */
export function keyPresetChoices(): readonly Preset[] {
  return BUILTIN_PRESETS;
}

/** 変えたもの 1 つ（画面の行が出す） */
export type SettingChange =
  | { id: "theme"; value: Theme }
  | { id: "lang"; value: string }
  | { id: "hand"; value: Hand }
  | { id: "flipPage" | "fingerDraw" | "noFinger" | "undoBadge" | "frameDeleteConfirm" | "albumsFolded"; value: boolean }
  | { id: "pressureCurve"; value: InputSettings["pressureCurve"] }
  | { id: "hover"; value: InputSettings["hover"] }
  | { id: "gesture"; gesture: GestureId; value: boolean }
  | { id: "longPressMs"; value: number }
  | { id: "confirm"; confirm: string; value: boolean }
  | { id: "keys"; value: string }
  | { id: "shelfSort"; value: ShelfSort };

/**
 * ★変えたものから、設定の口へ渡す値（変えた一番上のキーだけ）を作る。`raw` は今の設定（読んだもの）。
 *  返した値は、呼ぶ側が `raw` にも写す（Object.assign）＝次の変更が前の変更を落とさない。
 */
export function mergeFor(raw: Record<string, unknown>, c: SettingChange): Record<string, unknown> {
  const K = SETTING_KEYS;
  switch (c.id) {
    case "theme":
      return { [K.theme.key]: sanitizeTheme(c.value) };
    case "lang":
      return { [K.lang.key]: c.value };
    case "hand":
      return { [K.hand.key]: c.value === "left" ? "left" : "right" };
    case "flipPage":
      return { [K.flipPage.key]: c.value };
    case "fingerDraw":
      return { [K.fingerDraw.key]: c.value };
    case "noFinger":
      return { [K.noFinger.key]: c.value };
    case "undoBadge":
      return { [K.undoBadge.key]: c.value };
    case "albumsFolded":
      return { [K.albumsFolded.key]: c.value };
    case "frameDeleteConfirm":
      return { [K.frameDeleteConfirm.key]: c.value };
    case "pressureCurve":
      return { [K.pressureCurve.key]: oneOf(c.value, PRESSURE_CHOICES, "standard") };
    case "hover":
      return { [K.hover.key]: oneOf(c.value, HOVER_CHOICES, "ring") };
    case "longPressMs":
      return { [K.longPressMs.key]: LONG_PRESS_CHOICES.includes(c.value) ? c.value : 500 };
    case "gesture": {
      const cur = readMobileSettings(raw).gestures;
      return { [K.gestures.key]: { ...cur, [c.gesture]: c.value } };
    }
    case "confirm": {
      // オン＝確認を出す（hiddenConfirms に無い）。エディタの 3 つ以外の印は落とさない
      const prev = Array.isArray(raw[K.hiddenConfirms.key]) ? (raw[K.hiddenConfirms.key] as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const set = new Set(prev);
      if (!CONFIRM_IDS.includes(c.confirm)) return {};
      if (c.value) set.delete(c.confirm);
      else set.add(c.confirm);
      return { [K.hiddenConfirms.key]: [...set] };
    }
    case "keys": {
      // presets は読んだまま残し、activeId だけ替える（選べるのは組み込みの 2 つ）
      if (!BUILTIN_PRESETS.some((p) => p.id === c.value)) return {};
      const keys = sanitizeKeysSettings(raw[K.keys.key]);
      const rawKeys = raw[K.keys.key];
      const presets = rawKeys && typeof rawKeys === "object" && Array.isArray((rawKeys as { presets?: unknown }).presets) ? (rawKeys as { presets: unknown[] }).presets : keys.presets;
      return { [K.keys.key]: { activeId: c.value, presets } };
    }
    case "shelfSort":
      return { [K.shelfSort.key]: oneOf(c.value, ["manual", "name", "date"] as const, "manual") };
  }
}

/** 設定の区分 */
export type SectionId = "display" | "feel" | "gesture" | "confirm" | "library" | "sync" | "about";
/** 開いた所（描く画面から＝4 区分・表示言語の行なし／ライブラリから＝全部）＝U-34 */
export function sectionsFor(from: "editor" | "library"): SectionId[] {
  return from === "editor" ? ["display", "feel", "gesture", "confirm"] : ["display", "feel", "gesture", "confirm", "library", "sync", "about"];
}
/** 押して開ける区分か（同期は入口だけ＝押せない札） */
export function sectionEnabled(id: SectionId): boolean {
  return id !== "sync";
}

/** 行の種類（画面は、この表のとおりに並べる。検査は表を見る） */
export type RowKind = "lang" | "seg" | "switch" | "plain" | "preview" | "stats" | "disabled" | "note" | "about";
export interface RowSpec {
  id: string;
  kind: RowKind;
}
export function rowsFor(section: SectionId, from: "editor" | "library"): RowSpec[] {
  switch (section) {
    case "display":
      return [
        ...(from === "library" ? [{ id: "lang", kind: "lang" as const }] : []),
        { id: "theme", kind: "seg" },
        { id: "hand", kind: "seg" },
        { id: "flipPage", kind: "switch" },
      ];
    case "feel":
      // ペンのダブルタップの行は、この回は出さない（S-2）
      return [
        { id: "fingerDraw", kind: "switch" },
        { id: "noFinger", kind: "switch" },
        { id: "pressureCurve", kind: "seg" },
        { id: "pressurePreview", kind: "preview" },
        { id: "hover", kind: "seg" },
        { id: "keys", kind: "seg" },
      ];
    case "gesture":
      return [
        { id: "panPinch", kind: "plain" }, // スイッチなし（U-34）
        { id: "undoTap", kind: "switch" },
        { id: "redoTap", kind: "switch" },
        { id: "twist", kind: "switch" },
        { id: "toolsTap", kind: "switch" },
        { id: "longPress", kind: "switch" },
        { id: "longPressMs", kind: "seg" },
        { id: "undoBadge", kind: "switch" },
      ];
    case "confirm":
      return [
        { id: "clearFrame", kind: "switch" },
        { id: "layerDelete", kind: "switch" },
        { id: "folderDelete", kind: "switch" },
        { id: "frameDeleteConfirm", kind: "switch" },
      ];
    case "library":
      return [
        { id: "stats", kind: "stats" },
        { id: "exportAll", kind: "disabled" },
        { id: "uninstallNote", kind: "note" },
      ];
    case "sync":
      return [];
    case "about":
      return [
        { id: "app", kind: "about" },
        { id: "terms", kind: "disabled" },
        { id: "privacy", kind: "disabled" },
        { id: "external", kind: "disabled" },
        { id: "licenses", kind: "disabled" },
        { id: "guide", kind: "disabled" },
        { id: "disclaimer", kind: "note" },
      ];
  }
}
