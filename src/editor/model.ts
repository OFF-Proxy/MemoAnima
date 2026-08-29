// メモアニマ (MemoAnima) エディタ データモデル（M3）
// 絶対不変: 320×240 ドットバッファ / nearest-neighbor 整数倍表示 / パラパラの作法。
// 拡張可: レイヤー数（実質無制限）・色（既定パレット＋任意フルカラー、colorTable 最大256色）。
// インポートした .kwz は3層・各層2色・紙色の構造を色indexレベルで忠実に保持する。

import { layerBaseName } from "../i18n/defaults";
// V156 (P-1): 眠り（圧縮控え）の型だけを借りる。実体は sleep.ts（あちらが model を使うので
// **型だけの import**にして循環を作らない）
import type { SleepEntry } from "./sleep";
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

/** うごメモ3D／.kwz の青（flipnote.js の KWZ globalPalette[5] と同一値 [0,56,206]）。
 *  インポートした青作品の色と一致する。UGO_COLORS の水色 #06aeff とは別の値（M11-14） */
export const UGO3D_BLUE = "#0038ce";

/** 既定パレット（新規作品・.kwz インポートの種）。
 *  M11-14b: **うごメモ3Dの6色のみ**（作者判断「既定から色が多くごちゃごちゃしている」）。
 *  以前の「レトロ寄り拡張色」は既定から外した（画像取り込みの「レトロ14色」は
 *  RETRO_PALETTE として独立に残す＝あちらの意味を変えないため）。
 *  並びは 黒・白・赤・青・黄・緑（REQ_M11_14_batch.md §8） */
export const DEFAULT_PALETTE: string[] = [
  UGO_COLORS.black,
  UGO_COLORS.white,
  UGO_COLORS.red,
  UGO3D_BLUE,
  UGO_COLORS.yellow,
  UGO_COLORS.green,
];

/** 画像取り込み（M8）の「レトロ14色」モード用。M11-14b で既定パレットから分離したが、
 *  **中身は M11-14 以前の DEFAULT_PALETTE と同一**（うごメモ6色＋レトロ拡張8色）。
 *  ここを変えると写真のドット化結果が変わるので、既定パレットとは独立に据え置く */
export const RETRO_PALETTE: string[] = [
  UGO_COLORS.black,
  UGO_COLORS.white,
  UGO_COLORS.red,
  UGO_COLORS.yellow,
  UGO_COLORS.green,
  UGO_COLORS.blue,
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
 *  バッファ参照を取り直すこと（色解決→バッファ取得の順序を守る）。
 *
 *  M15: **バッファの同一性を保存する**。共通レイヤー（LayerDef.shared）は全コマが同一の
 *  Uint8Array 実体を参照しているので、コマ×レイヤーで**個別に**新品へ差し替えると
 *  共有が「コマごとに別実体」に分裂する。旧→新の対応表（`Map`）で、同じ元実体には
 *  同じ新実体を割り当てることで、昇格後も共有が保たれる。 */
export function promoteTo16(p: Project): void {
  if (p.indexBits === 16) return;
  const remap = new Map<IndexBuf, Uint16Array>();
  for (const f of p.frames) {
    for (const id of Object.keys(f.layers)) {
      const src = f.layers[id];
      let dst = remap.get(src);
      if (!dst) {
        dst = new Uint16Array(PIXELS);
        dst.set(src); // 値をそのままコピー（昇格は完全可逆）
        remap.set(src, dst);
      }
      f.layers[id] = dst;
    }
    // V156 (P-1): **眠っているぶんは起こさない。**控えは 8bit のまま持っておき、
    // 起こすときに広げる（`bytesToIndexBuf` が from=8/to=16 で値を保存して広げる）。
    // これで 1,098コマ×20レイヤーの昇格が「起きているぶんだけ」で済む
    //（起こすと 1.57 GiB → 3.14 GiB の山が立つ。そこが P-1 と正面衝突する所だった）。
    //
    // ただし「起きていて控えもある」ものは、控えが 8bit・中身が 16bit になって
    // 指紋が合わなくなる。**控えを捨てる**（次に眠るとき 16bit で圧縮し直す）。
    // 昇格は一方向で一度きりなので、この作り直しは背景で1回起きるだけ
    if (f.sleep) {
      for (const id of Object.keys(f.sleep)) if (f.layers[id]) delete f.sleep[id];
      if (Object.keys(f.sleep).length === 0) delete f.sleep;
    }
  }
  p.indexBits = 16;
}

/** M15 (K-1): 共通レイヤー（`shared:true`）の不変条件を再確立する。
 *  各共通レイヤーについて、全コマが**同一の1バッファ**（先頭コマの実体）を参照するように張り直す。
 *  コマの追加・複製・削除・並べ替え・16bit 昇格などでバッファ参照が枝分かれし得るので、
 *  コマ構造が変わる各所と読み込み直後に呼ぶ。共通でないレイヤーには一切触れない。
 *  ★索引の複製・混色はしない（参照代入だけ）。先頭コマにバッファが無ければ確保して canonical にする。 */
export function relinkShared(p: Project): void {
  if (!p.frames.length) return;
  for (const ld of p.layerDefs) {
    if (ld.shared !== true) continue;
    let canonical = p.frames[0].layers[ld.id];
    if (!canonical) {
      canonical = allocIndexBuf(p);
      p.frames[0].layers[ld.id] = canonical;
    }
    for (const f of p.frames) {
      f.layers[ld.id] = canonical;
      // V156 (P-1): 📌 は**眠らせない**（全コマで見えていて実体は1つ＝眠らせる意味が無い）。
      // 万一この id の控えが残っていたら、実体を張り直した今それは古い。捨てる
      if (f.sleep?.[ld.id]) {
        delete f.sleep[ld.id];
        if (Object.keys(f.sleep).length === 0) delete f.sleep;
      }
    }
  }
}

export interface LayerDef {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1（PC拡張。1=うごメモ準拠） */
  opacity: number;
  /** M3.7: 所属フォルダ id（未指定=ルート） */
  parent?: string;
  /** M11-20: 下のレイヤーでクリッピング（クリスタ準拠・省略=false）。
   *  true のレイヤーの画素は「土台」（clipBaseMap で解決）の同じ画素が非0のときだけ表示される。
   *  **表示時のマスクだけ**でバッファは全画素そのまま。保存形式は PROJECT_VERSION=5 のまま
   *  任意キーとして書く（M10-14 thumbFrame の前例。旧ビルドは未知キーとして素通し） */
  clip?: boolean;
  /** M15 (K-1): 全コマ共通レイヤー（📌）。true のとき、このレイヤーは全コマが**同一のバッファ**を
   *  参照する（どのコマで描いても全コマに反映）。保存形式は PROJECT_VERSION=5 のまま任意キー
   *  （clip の前例）。旧ビルドは未知キーとして無視し、「全コマに同じ絵があるレイヤー」として開ける。
   *  フォルダには付けない。取り込み（kwz/ppm）レイヤーには付かない。 */
  shared?: true;
  /** V157 (D-1): レイヤーロック 🔒。true のとき**絵のデータを変える操作**を受け付けない
   *  （描画・塗り・変形・統合・削除・範囲の消去/塗り）。**通す**のは 👁表示切替・名前・並べ替え・
   *  不透明度・レイヤーカラー・ロック解除——クリスタと同じ「絵は変わらない操作」の線引き。
   *
   *  保存形式は `PROJECT_VERSION = 5` のまま任意キー（`clip` / `shared` / `displayColor` の前例）。
   *  **旧ビルドは未知キーとして素通しし、ロックの無い作品として開ける**（絵は完全に同じ）。
   *  実効ロック（自分 OR 祖先フォルダ）は `effectiveLayerStates` が解決する。 */
  locked?: true;
  /** M15 (K-2): レイヤーカラー（表示色）。"#RRGGBB"。設定中は、このレイヤーの**不透明ピクセル全部**が
   *  この色で合成される（画面・サムネ・書き出し）。**索引データは1ドットも変えない**＝解除で元に戻る。
   *  塗り・✨自動選択の境界判定（flattenIndexFrame）には効かせない（表示だけ）。任意キー。 */
  displayColor?: string;
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
  /** V157 (D-1): フォルダのロック 🔒。中身すべてが**実効ロック**になる（子の個別 `locked` は書き換えない）。
   *  親を解除すると、自分に `locked` が付いている子だけロックが残る。任意キー・旧ビルドは素通し。 */
  locked?: true;
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
  /** V157 (D-2): **このコマだけ**のレイヤー表示色（layerId → "#RRGGBB"）。
   *
   *  `LayerDef.displayColor`（レイヤー全体の既定）より**こちらが優先**の2段構え。
   *  `se` と同じ「コマ側に任意キーを持つ」作法で、`PROJECT_VERSION = 5` のまま。
   *  **索引（`IndexBuf`）は1ビットも変わらない**——表示のときに色を差し替えるだけなので、
   *  解除すればレイヤー既定へ完全に戻る（M15 K-2 の原則をそのまま引き継ぐ）。
   *
   *  ★ここは**画素ではない**ので、V156 の圧縮控え（`sleep`）には入らない。
   *  眠っているコマにも普通に付けられるし、眠らせ直しても消えない（`v157_smoke` §5 が検査）。 */
  layerColors?: Record<string, string>;
  /** V156 (P-1): 眠っているレイヤーの gzip 控え。**メモリ上の持ち方だけの話で、保存形式は変わらない**
   *  （`PROJECT_VERSION = 5` のまま。`encodeProject` は起きていても眠っていても同じ JSON を書く）。
   *
   *  不変条件（`sleep.ts` の冒頭に全文）:
   *    `layers[id]` がある ⟺ 起きている ／ `sleep[id]` がある ⟺ 圧縮控えを持っている
   *  両方あるのは「起きていて控えも生きている」＝眠らせるのが只、という状態。 */
  sleep?: Record<string, SleepEntry>;
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
): Map<string, { visible: boolean; opacity: number; locked: boolean }> {
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
  // V157 (D-1): `locked` も同じ流儀で祖先まで OR する（実効可視が AND なのと対になる）
  const folderEff = new Map<string, { visible: boolean; opacity: number; locked: boolean }>();
  const ROOT = { visible: true, opacity: 1, locked: false };
  const resolve = (id: string): { visible: boolean; opacity: number; locked: boolean } => {
    const cached = folderEff.get(id);
    if (cached) return cached;
    const f = byId.get(id);
    if (!f) return ROOT;
    const parId = safeParent.get(id);
    const par = parId ? resolve(parId) : ROOT;
    const eff = {
      visible: f.visible && par.visible,
      opacity: f.opacity * par.opacity,
      locked: f.locked === true || par.locked,
    };
    folderEff.set(id, eff);
    return eff;
  };
  const out = new Map<string, { visible: boolean; opacity: number; locked: boolean }>();
  for (const ld of p.layerDefs) {
    const par = ld.parent && byId.has(ld.parent) ? resolve(ld.parent) : ROOT;
    out.set(ld.id, {
      visible: ld.visible && par.visible,
      opacity: ld.opacity * par.opacity,
      locked: ld.locked === true || par.locked,
    });
  }
  return out;
}

/** V157 (D-1): その親チェーンに🔒が1つでもあるか（**自分の `locked` は含めない**）。
 *
 *  UI で「親が🔒のとき、子の🔒トグルをグレーにする」判定に使う。
 *  自分を含めてしまうと「自分で掛けたロックを自分で外せない」になる。
 *  存在しない親・循環は `effectiveLayerStates` と同じくそこで打ち切る（ルート扱い）。 */
export function ancestorLocked(p: Project, parentId: string | undefined): boolean {
  const byId = new Map((p.folders ?? []).map((f) => [f.id, f]));
  const seen = new Set<string>();
  let cur = parentId;
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const f = byId.get(cur)!;
    if (f.locked === true) return true;
    cur = f.parent;
  }
  return false;
}


/** M11-20: クリッピングのあるレイヤーが 1 枚でもあるか（無ければ合成側は clip の処理を丸ごと飛ばす＝
 *  clip なし作品のホットパスを 1 命令も変えないための門番） */
export function hasClipLayers(p: Project): boolean {
  for (const ld of p.layerDefs) if (ld.clip === true) return true;
  return false;
}

/**
 * M11-20: クリッピングの「土台」を解決する（クリスタ準拠・REQ_M11_20 §1）。
 * 戻り値は **clip=true のレイヤーだけ**を鍵にした Map（値 = 土台レイヤー id・土台なしは null）。
 * - 土台 = そのレイヤーから**下方向**に連続する clip レイヤー群を飛ばした、最初の非 clip レイヤー
 *   （連続する clip 群は同じ土台を共有）
 * - 判定は **layerDefs の構造順（配列は下→上）**。コマ固有の描画順（frames[].order）は見ない
 * - **同じ親（同じフォルダ）内のレイヤーだけ**を候補にする（フォルダ境界を跨がない）。
 *   親の異なるレイヤー（子フォルダのブロック等）が間に挟まっていても、それは飛ばして
 *   同じ親の直下の非 clip レイヤーを土台にする（フォルダ自体を土台にする機能は今回なし）
 * - 存在しないフォルダを親に持つレイヤーはルート扱い（effectiveLayerStates と同じ健全化）
 * - 「土台が非表示なら clip 群も非表示」の判定は呼び出し側（effectiveLayerStates の実効可視で見る）
 * 走査は 1 パス O(レイヤー数)。順序が非連続な壊れたファイルでも落ちない。
 */
export function clipBaseMap(p: Project): Map<string, string | null> {
  const folderIds = new Set((p.folders ?? []).map((f) => f.id));
  const lastNonClip = new Map<string, string>(); // 親キー → その親で最後に見た非 clip レイヤー id
  const out = new Map<string, string | null>();
  for (const ld of p.layerDefs) {
    const key = ld.parent && folderIds.has(ld.parent) ? ld.parent : "";
    if (ld.clip === true) out.set(ld.id, lastNonClip.get(key) ?? null);
    else lastNonClip.set(key, ld.id);
  }
  return out;
}

/**
 * M3.7: フォルダ構造の健全化（読み込み時・設定時）。
 * 存在しない親・循環参照は parent を外してルートへ隔離（絵は必ず開ける）。
 */
export function sanitizeFolders(p: Project): void {
  const folders = p.folders ?? [];
  // V157 (D-1): フォルダの `locked` も true のみ有効（`LayerDef.locked` と同じ作法）。
  // 壊れた値で「解除できないロック」が生まれないようにキーごと落とす
  for (const f of folders as unknown[]) {
    if (f && typeof f === "object" && "locked" in f && (f as LayerFolder).locked !== true) {
      delete (f as { locked?: unknown }).locked;
    }
  }
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
    p.layerDefs.push({ id: newLayerId(p), name: `${layerBaseName()}${name}`, visible: true, opacity: 1 });
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
      // V156: 幅を変えた＝控えは古い（`promoteTo16` と同じ理由）
      if (f.sleep?.[id]) {
        delete f.sleep[id];
        if (Object.keys(f.sleep).length === 0) delete f.sleep;
      }
    }
  }
  // 眠っているぶんは触らない（控えは自分の幅を覚えていて、起こすときに広がる）
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

/** V154 (W-2): いま**メモリに載っている**作品の量（バイト）。
 *
 *  ★掛け算（コマ数 × レイヤー数 × 76.8KB）では**間違える**。数えるのは実体:
 *  - 📌 全コマ共通レイヤー（`shared`）は全コマが**同じ1バッファ**を指す（`relinkShared`）。
 *    掛け算だと 700 コマで 700 倍に見積もってしまう
 *  - `Set` に入れてから合計するので、参照が枝分かれしているぶんだけ正しく増える
 *  - 音声（BGM・効果音）も**同じメモリに載っている**ので足す（要件 §2-b ③）
 *
 *  ここに**履歴は入らない**（履歴は `History.totalBytes()`。表示は別の行に出す＝
 *  「統合したのに減らない」の理由が見えるように）。 */
export function projectBytes(p: Project): number {
  const seen = new Set<ArrayBufferView>();
  let total = 0;
  const add = (b: ArrayBufferView | null | undefined) => {
    if (!b || seen.has(b)) return;
    seen.add(b);
    total += b.byteLength;
  };
  // V156 (P-1・条件4): **論理サイズのまま**返す。眠っているレイヤーも「生なら何バイトか」で数える。
  //
  // ここは表示だけの数字ではない。`editor.ts` の**フルカラー切替の警告**と
  // **16bit 昇格の知らせ**が、この値をしきい値と比べて出す/出さないを決めている（＝門番）。
  // 圧縮後の小さい数字を返すと、大きい作品でその警告2つが**黙る**——メーターの見た目より重い。
  const unit = PIXELS * ((p.indexBits === 16 ? 16 : 8) / 8);
  for (const f of p.frames) {
    for (const b of Object.values(f.layers)) add(b);
    // 眠っているぶん（起きている同名レイヤーがあれば上で数え済み）
    if (f.sleep) for (const id of Object.keys(f.sleep)) if (!f.layers[id]) total += unit;
  }
  add(p.audio?.bgm?.data);
  for (const s of p.audio?.se ?? []) add(s.data);
  return total;
}

/** V154b: **読み込みの壁**（生バッファのバイト数）。
 *
 *  `serialize.ts` の `projectFromBytes` は JSON 全体を**1本の文字列**にしてから `JSON.parse` する。
 *  V8（Chromium／WebView2）の文字列上限は **536,870,888 文字**（実測）で、
 *  レイヤーは base64（4/3 倍）で書かれるので、生バッファがこの数を超えると**開けなくなる**:
 *
 *      536,870,888 ÷ (4/3) = 402,653,166 バイト = 384.0 MiB
 *
 *  base64 が一律 4/3 なので、**8bit でも 16bit でも同じ 384 MiB**（面数の上限は変わる）。
 *  JSON の骨組み（キー名・カンマ）のぶん、実際の壁はもう少し手前にある。
 *
 *  ★V155 で読み込みを分割にしたので、**これはもう「開けない壁」ではない**
 *  （2.10 GiB の作品が実際に開く）。いまは「このあたりから重い」という**目安**として、
 *  メーターのしきい値と面数の表示に使っている。名前は履歴として残す。 */
export const LOAD_WALL_BYTES = 402_653_166;

/** V154b: V8（Chromium／WebView2）の**文字列の上限**。実測 536,870,888 文字。
 *  V154b までは `projectFromBytes` が JSON 全体を1本の文字列にしていたので、
 *  展開後がこれを超えたら開けなかった。**V155 で分割読み込みにしたので、この壁は無い。**
 *  `LOAD_WALL_BYTES` はこれを base64 の 4/3 で割った生バッファぶんの言い換え。 */
export const MAX_JSON_CHARS = 536_870_888;

/** V154b: いまのビット幅で「あと何面まで開けるか」。
 *  面＝**レイヤー×コマ**（1コマ1レイヤーぶんの索引バッファ）。
 *  8bit なら 5,242 面／16bit なら 2,621 面。バイト数より**壁に直結していて分かりやすい**。 */
export function loadWallFaces(indexBits: 8 | 16): number {
  return Math.floor(LOAD_WALL_BYTES / (PIXELS * (indexBits === 16 ? 2 : 1)));
}

/** V154b: いまの作品の面数（**保存したときに JSON へ並ぶ数**）。
 *
 *  📌 全コマ共通レイヤーはメモリ上は1つの実体だが、**保存の JSON にはコマごとに書かれる**
 *  （`encodeProject` は `Object.entries(f.layers)` を毎コマ回す）。壁に効くのはそちらなので、
 *  ここは実体ではなく**エントリの数**を数える（`projectBytes` とは数え方が違う。意図的）。 */
export function projectFaces(p: Project): number {
  let n = 0;
  // V156 (P-1): 眠っているレイヤーも数える（面数は保存の JSON に並ぶ数＝眠りとは無関係）
  for (const f of p.frames) {
    n += Object.keys(f.layers).length;
    if (f.sleep) for (const id of Object.keys(f.sleep)) if (!f.layers[id]) n++;
  }
  return n;
}
