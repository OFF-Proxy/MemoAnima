// アニメモ エディタ データモデル（M3）
// 絶対不変: 320×240 ドットバッファ / nearest-neighbor 整数倍表示 / パラパラの作法。
// 拡張可: レイヤー数（実質無制限）・色（既定パレット＋任意フルカラー、colorTable 最大256色）。
// インポートした .kwz は3層・各層2色・紙色の構造を色indexレベルで忠実に保持する。

export const W = 320;
export const H = 240;
export const PIXELS = W * H;

/** うごメモ3D 再生速度 11段階（fps） */
export const FPS_TABLE = [0.2, 0.5, 1, 2, 4, 6, 8, 12, 20, 24, 30];

/** うごメモ6色（不変・インポート忠実性の核） */
export const UGO_COLORS = {
  white: "#ffffff",
  black: "#141414",
  red: "#ff1717",
  yellow: "#ffe600",
  green: "#008232",
  blue: "#06aeff",
} as const;

/** 既定パレット: うごメモ6色 ＋ レトロ寄り拡張色 */
export const DEFAULT_PALETTE: string[] = [
  UGO_COLORS.black,
  UGO_COLORS.white,
  UGO_COLORS.red,
  UGO_COLORS.yellow,
  UGO_COLORS.green,
  UGO_COLORS.blue,
  // レトロ拡張
  "#ff7f27", // オレンジ
  "#ff9ec8", // ピンク
  "#8b5cf6", // むらさき
  "#8b5a2b", // ちゃいろ
  "#9aa4b2", // はいいろ
  "#a8e6ff", // みずいろ
  "#b6f0a2", // きみどり
  "#fbefd6", // クリーム
];

export type PenTexture =
  | "solid"
  | "dot"
  | "rough"
  | "spray"
  | "sand"
  | "halftone";

// ---- N-2: 16bitパレット自動昇格（方式A） ----

/** レイヤーの索引バッファ（0=透明, 1..=colorTable index）。幅はプロジェクトの indexBits に従う */
export type IndexBuf = Uint8Array | Uint16Array;

export const MAX_PALETTE_8 = 256; // index 0 は透明予約
export const MAX_PALETTE_16 = 65536;

/** 現在の幅で PIXELS 長の索引バッファを新規確保 */
export function allocIndexBuf(p: Project): IndexBuf {
  return p.indexBits === 16 ? new Uint16Array(PIXELS) : new Uint8Array(PIXELS);
}

/** 索引バッファを同じ幅で複製（履歴/ストローク前後スナップショット用）。
 *  ※ src の幅を保つ。live 側が既に昇格済み(16bit)なら .set() が値を保って取り込む。 */
export function copyIndexBuf(src: IndexBuf): IndexBuf {
  return src instanceof Uint16Array ? new Uint16Array(src) : new Uint8Array(src);
}

/** 8bit→16bit へプロジェクト全体を一度だけ昇格（可逆・値保存）。既に16bitなら何もしない。
 *  注意: 全フレームのレイヤーバッファを差し替えるため、呼び出し後は保持していた
 *  バッファ参照を取り直すこと（色解決→バッファ取得の順序を守る）。 */
export function promoteTo16(p: Project): void {
  if (p.indexBits === 16) return;
  for (const f of p.frames) {
    for (const id of Object.keys(f.layers)) {
      const src = f.layers[id];
      const dst = new Uint16Array(PIXELS);
      dst.set(src); // 値をそのままコピー（昇格は完全可逆）
      f.layers[id] = dst;
    }
  }
  p.indexBits = 16;
}

export interface LayerDef {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1（PC拡張。1=うごメモ準拠） */
  opacity: number;
  /** M3.7: 所属フォルダ id（未指定=ルート） */
  parent?: string;
}

/** M3.7: レイヤーフォルダ（組織化レイヤー・ネスト対応）。
 *  描画順は従来どおり layerDefs の平坦順（フォルダは順序に関与しない）。
 *  実効可視/不透明度 = レイヤー自身 × 祖先フォルダ全部の積。 */
export interface LayerFolder {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  /** UI折りたたみ（保存対象・描画不変） */
  collapsed: boolean;
  /** 親フォルダ id（ネスト・未指定=ルート） */
  parent?: string;
}

export interface Frame {
  /** colorTable の index（0は透明＝使用不可、紙は必ず実色） */
  paper: number;
  /** layerId -> IndexBuf(PIXELS) colorTable index（0=透明・8/16bit索引） */
  layers: Record<string, IndexBuf>;
  /**
   * このコマ固有の描画順（layerId 下→上）。KWZ は3D奥行きでコマごとに順序が変わるため、
   * インポート忠実性のために保持する。未設定なら layerDefs の順。
   * エディタでレイヤーを並べ替えると全コマで標準化（クリア）される。
   */
  order?: string[];
  /** M5-1: このコマで鳴らす SeTrack id 群（コマ側に持つ＝複製/削除/並べ替え/クリップに自然追従） */
  se?: string[];
}

/** M5-1: BGMトラック（旧 AudioTrack の後継。保存形式 v5・速度連動基準つき） */
export interface BgmTrack {
  source: "kwz" | "external" | "mic";
  /** "audio/wav" | "audio/mpeg" | "audio/ogg" */
  mime: string;
  /** 埋め込みバイト列（kwz由来=WAV / 外部=元ファイルbytes） */
  data: Uint8Array;
  muted: boolean;
  /** 0..1 */
  volume: number;
  /** 頭出し（開始オフセット・ms） */
  trimStartMs: number;
  /** 終わり（ms。null=音源の最後まで） */
  trimEndMs: number | null;
  /** 長さ合わせ（U-3 既定 audioToAnim=音をアニメに合わせる） */
  syncMode: "audioToAnim" | "animToAudio";
  /** BGMを付けた時点の速度段階（FPS_TABLE index）。
   *  再生 rate = FPS_TABLE[現在speedIndex] / FPS_TABLE[baseSpeedIndex]（ピッチ連動=原作準拠） */
  baseSpeedIndex: number;
  /** 表示用のファイル名（external のみ・任意） */
  name?: string;
}

/** M5-1: 効果音トラック（コマに配置して鳴らす。スロット無制限） */
export interface SeTrack {
  /** "S1".. （nextSeId カウンタで採番。Frame.se から参照） */
  id: string;
  name: string;
  source: "kwz" | "external" | "mic";
  mime: string;
  data: Uint8Array;
  /** 0..1 */
  volume: number;
  muted: boolean;
}

/** M5-1: プロジェクトの音声一式（v5）。audio 自体が null = 音なし */
export interface ProjectAudio {
  bgm: BgmTrack | null;
  se: SeTrack[];
}

export interface ProjectMeta {
  title: string;
  /** 取り込み元 .kwz/.ppm の情報（合作・由来の記録） */
  source?: { name?: string; hash?: string; format?: string };
  createdAt?: string;
  modifiedAt?: string;
}

export interface Project {
  version: 1;
  width: typeof W;
  height: typeof H;
  /** hex色（'#rrggbb'）。index 0 は透明の予約枠（空文字） */
  colorTable: string[];
  /** 索引バッファの幅（8=最大256色 / 16=最大65,536色。257色目で自動昇格・単調増加） */
  indexBits: 8 | 16;
  /** 下→上の順 */
  layerDefs: LayerDef[];
  frames: Frame[];
  /** FPS_TABLE の index */
  speedIndex: number;
  loop: boolean;
  colorMode: "palette" | "fullcolor";
  nextLayerId: number;
  /** M5-1: SEトラック採番カウンタ（nextLayerId とは独立） */
  nextSeId?: number;
  meta: ProjectMeta;
  /** 音声（M5-1 で {bgm, se} に刷新）。null/undefined=音声なし */
  audio?: ProjectAudio | null;
  /** M3.7: レイヤーフォルダ（空/undefined=フォルダなし） */
  folders?: LayerFolder[];
  /** M10-14: サムネイルに使うコマ（うごメモ3D準拠）。手動保存時のみ更新・
   *  オートセーブでは既存値を維持する。undefined=未設定（先頭コマ扱い） */
  thumbFrame?: number;
}

/** hex → 32bit RGBA（リトルエンディアン ImageData 用: r | g<<8 | b<<16 | a<<24） */
export function hexToU32(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r | (g << 8) | (b << 16) | (0xff << 24)) >>> 0;
}

export function buildLut(colorTable: string[]): Uint32Array {
  const lut = new Uint32Array(colorTable.length);
  for (let i = 1; i < colorTable.length; i++) {
    if (colorTable[i]) lut[i] = hexToU32(colorTable[i]);
  }
  return lut;
}

/** 色をテーブルに登録して index を返す（既存なら再利用）。
 *  8bitで257色目に達したらプロジェクト全体を16bitへ自動昇格（可逆）。
 *  16bitで65,536に達した場合のみ最近傍色フォールバック（実用上ほぼ到達しない）。
 *  昇格の検知は呼び出し側が前後の p.indexBits を比較する。 */
export function ensureColor(p: Project, hex: string): number {
  hex = hex.toLowerCase();
  const found = p.colorTable.indexOf(hex);
  if (found > 0) return found;
  if (p.indexBits === 8 && p.colorTable.length >= MAX_PALETTE_8) {
    promoteTo16(p); // 上限が 65,536 に広がる
  }
  if (p.colorTable.length >= MAX_PALETTE_16) {
    // 最終手段: 最も近い既存色にフォールバック
    let best = 1;
    let bestD = Infinity;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    for (let i = 1; i < p.colorTable.length; i++) {
      const c = p.colorTable[i];
      const dr = r - parseInt(c.slice(1, 3), 16);
      const dg = g - parseInt(c.slice(3, 5), 16);
      const db = b - parseInt(c.slice(5, 7), 16);
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
  p.colorTable.push(hex);
  return p.colorTable.length - 1;
}

export function newLayerId(p: Project): string {
  return `L${p.nextLayerId++}`;
}

export function newFolderId(p: Project): string {
  return `F${p.nextLayerId++}`;
}

/** M5-1: SEトラック id 採番（"S1"..） */
export function newSeId(p: Project): string {
  if (!p.nextSeId || p.nextSeId < 1) p.nextSeId = 1;
  return `S${p.nextSeId++}`;
}

/**
 * M3.7: レイヤー実効状態（可視=祖先すべて可視 / 不透明度=祖先の積）を一括計算。
 * 壊れた parent（存在しないid・循環）はルート扱い（描画を止めない）。
 */
export function effectiveLayerStates(
  p: Project
): Map<string, { visible: boolean; opacity: number }> {
  const folders = p.folders ?? [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  // 先に親参照を健全化した写しを作る（存在しない親・循環に関与するフォルダは
  // **ルート扱い**にする。循環の一部だけ適用される中途半端を避ける — Codexレビュー指摘）
  const safeParent = new Map<string, string | undefined>();
  for (const f of folders) {
    let parent = f.parent && byId.has(f.parent) ? f.parent : undefined;
    if (parent) {
      // f から祖先をたどって循環していないか確認
      const seen = new Set<string>([f.id]);
      let cur: string | undefined = parent;
      while (cur) {
        if (seen.has(cur)) {
          parent = undefined; // 循環に関与 → ルート扱い
          break;
        }
        seen.add(cur);
        cur = byId.get(cur)?.parent && byId.has(byId.get(cur)!.parent!)
          ? byId.get(cur)!.parent
          : undefined;
      }
    }
    safeParent.set(f.id, parent);
  }
  // フォルダ自身の実効値（健全化済み親のみ辿る）
  const folderEff = new Map<string, { visible: boolean; opacity: number }>();
  const resolve = (id: string): { visible: boolean; opacity: number } => {
    const cached = folderEff.get(id);
    if (cached) return cached;
    const f = byId.get(id);
    if (!f) return { visible: true, opacity: 1 };
    const parId = safeParent.get(id);
    const par = parId ? resolve(parId) : { visible: true, opacity: 1 };
    const eff = { visible: f.visible && par.visible, opacity: f.opacity * par.opacity };
    folderEff.set(id, eff);
    return eff;
  };
  const out = new Map<string, { visible: boolean; opacity: number }>();
  for (const ld of p.layerDefs) {
    const par =
      ld.parent && byId.has(ld.parent) ? resolve(ld.parent) : { visible: true, opacity: 1 };
    out.set(ld.id, {
      visible: ld.visible && par.visible,
      opacity: ld.opacity * par.opacity,
    });
  }
  return out;
}

/**
 * M3.7: フォルダ構造の健全化（読み込み時・設定時）。
 * 存在しない親・循環参照は parent を外してルートへ隔離（絵は必ず開ける）。
 */
export function sanitizeFolders(p: Project): void {
  const folders = p.folders ?? [];
  const ids = new Set(folders.map((f) => f.id));
  // 存在しない親を除去
  for (const f of folders) if (f.parent && !ids.has(f.parent)) f.parent = undefined;
  for (const ld of p.layerDefs) if (ld.parent && !ids.has(ld.parent)) ld.parent = undefined;
  // 循環検出 → 見つけたノードの parent を切る
  for (const f of folders) {
    const seen = new Set<string>();
    let cur: LayerFolder | undefined = f;
    while (cur?.parent) {
      if (seen.has(cur.id)) {
        cur.parent = undefined;
        break;
      }
      seen.add(cur.id);
      cur = folders.find((x) => x.id === cur!.parent);
      if (cur && seen.has(cur.id)) {
        cur.parent = undefined;
        break;
      }
    }
  }
}

/**
 * M5-1: 音声一式の健全化（ロード後・取込後に必ず通す）。
 * - 壊れた bgm/se（データ欠損・型不正）は隔離（絵は必ず開ける）
 * - Frame.se の未知 id・重複を除去（空になったら undefined）
 * - bgm も se も無ければ audio 自体を null に正規化
 * - nextSeId を既存 id と衝突しない値へ引き上げ
 */
export function sanitizeAudio(p: Project): void {
  const clamp01 = (v: unknown, def: number) =>
    typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : def;
  const a = p.audio;
  if (a) {
    if (a.bgm) {
      const b = a.bgm;
      if (!(b.data instanceof Uint8Array) || b.data.length === 0) {
        a.bgm = null;
      } else {
        b.volume = clamp01(b.volume, 1);
        b.muted = b.muted === true;
        b.trimStartMs =
          typeof b.trimStartMs === "number" && isFinite(b.trimStartMs)
            ? Math.max(0, b.trimStartMs)
            : 0;
        if (typeof b.trimEndMs !== "number" || !isFinite(b.trimEndMs)) b.trimEndMs = null;
        b.syncMode = b.syncMode === "animToAudio" ? "animToAudio" : "audioToAnim";
        b.baseSpeedIndex =
          typeof b.baseSpeedIndex === "number" &&
          b.baseSpeedIndex >= 0 &&
          b.baseSpeedIndex < FPS_TABLE.length
            ? Math.round(b.baseSpeedIndex)
            : p.speedIndex;
      }
    }
    const seenIds = new Set<string>();
    a.se = (Array.isArray(a.se) ? a.se : []).filter((s) => {
      if (
        !s ||
        typeof s.id !== "string" ||
        !(s.data instanceof Uint8Array) ||
        s.data.length === 0 ||
        seenIds.has(s.id)
      )
        return false;
      seenIds.add(s.id);
      s.name = typeof s.name === "string" && s.name ? s.name : s.id;
      s.volume = clamp01(s.volume, 1);
      s.muted = s.muted === true;
      return true;
    });
    if (!a.bgm && a.se.length === 0) p.audio = null;
  }
  const valid = new Set((p.audio?.se ?? []).map((s) => s.id));
  for (const f of p.frames) {
    if (!f.se) continue;
    const filtered = [...new Set(f.se)].filter((id) => valid.has(id));
    f.se = filtered.length > 0 ? filtered : undefined;
  }
  let maxN = 0;
  for (const s of p.audio?.se ?? []) {
    const m = /^S(\d+)$/.exec(s.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  if (!p.nextSeId || p.nextSeId <= maxN) p.nextSeId = maxN + 1;
}

export function makeEmptyFrame(p: Project, paper: number): Frame {
  const layers: Record<string, IndexBuf> = {};
  for (const ld of p.layerDefs) layers[ld.id] = allocIndexBuf(p);
  return { paper, layers };
}

/** 新規プロジェクト（うごメモ3D準拠の初期状態: 3層・既定パレット・白紙） */
export function newProject(title: string): Project {
  const p: Project = {
    version: 1,
    width: W,
    height: H,
    colorTable: ["", ...DEFAULT_PALETTE],
    indexBits: 8,
    layerDefs: [],
    frames: [],
    speedIndex: 6, // 8fps
    loop: true,
    colorMode: "palette",
    nextLayerId: 1,
    meta: { title, createdAt: new Date().toISOString() },
    audio: null,
    folders: [],
  };
  // うごメモ準拠: C(下) / B / A(上)
  for (const name of ["C", "B", "A"]) {
    p.layerDefs.push({ id: newLayerId(p), name: `レイヤー${name}`, visible: true, opacity: 1 });
  }
  const paper = ensureColor(p, UGO_COLORS.white);
  p.frames.push(makeEmptyFrame(p, paper));
  return p;
}

/** フレームのレイヤーバッファ幅をプロジェクトの indexBits に合わせる（widening のみ・値保存）。
 *  Undo/Redo でプロジェクト外に出ていたフレームを戻すとき、外にいる間に16bit昇格が
 *  起きていると 8bit バッファが混入するため、復帰直前に必ずこれを通す（Codexレビュー指摘）。 */
export function conformFrameWidth(p: Project, f: Frame): void {
  if (p.indexBits !== 16) return;
  for (const id of Object.keys(f.layers)) {
    const buf = f.layers[id];
    if (buf instanceof Uint8Array) {
      const wide = new Uint16Array(PIXELS);
      wide.set(buf);
      f.layers[id] = wide;
    }
  }
}

/** フレームの複製（バッファもコピー・幅維持。M5-1: SE配置も複製） */
export function cloneFrame(f: Frame): Frame {
  const layers: Record<string, IndexBuf> = {};
  for (const [k, v] of Object.entries(f.layers)) layers[k] = copyIndexBuf(v);
  return {
    paper: f.paper,
    layers,
    order: f.order ? [...f.order] : undefined,
    se: f.se && f.se.length > 0 ? [...f.se] : undefined,
  };
}
