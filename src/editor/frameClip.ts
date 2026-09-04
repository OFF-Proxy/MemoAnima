// ページ／複数ページ・クリップボード（M3.3）
// アプリ全体（クロスメモ）で保持するコマのコピー/貼り付けの純関数部。
// 順序厳守（N-2の教訓）: 色解決（ensureColor・16bit昇格し得る）を**すべて終えてから**
// バッファを確保する。この不変条件を関数構造で保証する。

import {
  Project,
  Frame,
  IndexBuf,
  PIXELS,
  ensureColor,
  allocIndexBuf,
  copyIndexBuf,
} from "./model";

export interface FrameClipEntry {
  /** 紙色（hex）。M11-16: **`""` は透明の紙（paper=0）**＝貼り付け先でも 0 に戻す（色解決しない） */
  paperHex: string;
  /** 「下→上」の実効描画順（frame.order 解決済み）で保持 */
  layers: IndexBuf[];
  /** M5-1: SE配置（SeTrack id 群）。貼り付け先に同 id が存在するものだけ残す（REQ確定規則） */
  se?: string[];
  /** V156 (P-5): 畳んであるときの gzip 列（`layers` と入れ替わりで入る） */
  layersZ?: Uint8Array[];
  /** V156 (P-5): 畳んだ中身が 16bit 索引だったか（開くとき同じ幅に戻す） */
  wide?: boolean;
}

export interface FrameClip {
  /** 元プロジェクトの colorTable（index→hex。色再マップ用） */
  palette: string[];
  frames: FrameClipEntry[];
  /** V156 (P-5): 圧縮して畳んであるか（`layers` は空・`layersZ` に入っている）。 */
  packed?: boolean;
}

/** V156 (P-5): クリップを畳む（gzip）。
 *
 *  ★このクリップボードは **static で、メモをまたいで残るのが仕様**
 *  （`SPEC_M3_editor_ui.md` の「アプリ全体・クロスメモ保持」、M3.3 の受け入れ AC-B-5
 *   「別メモの編集に入っても残り、貼り付けできる」）。だから**解放してはいけない**。
 *  代わりに P-1 と同じ圧縮で持つ——機能はそのまま、抱える量が 20〜30 分の1 になる。
 *  全コマ選択でコピーすると、V156 が眠らせて減らしたぶんをこれ1回で打ち消せてしまうので、
 *  ここを畳むのは効き目の要でもある。 */
export async function packClip(clip: FrameClip): Promise<void> {
  if (clip.packed) return;
  for (const e of clip.frames) {
    e.layersZ = [];
    for (const lay of e.layers) {
      const raw = new Uint8Array(lay.buffer, lay.byteOffset, lay.byteLength);
      e.layersZ.push(
        new Uint8Array(
          await new Response(
            new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
          ).arrayBuffer()
        )
      );
      e.wide = lay instanceof Uint16Array;
    }
    e.layers = [];
  }
  clip.packed = true;
}

/** V156 (P-5): 畳んだクリップを開く（貼り付けの直前に呼ぶ）。 */
export async function unpackClip(clip: FrameClip): Promise<void> {
  if (!clip.packed) return;
  for (const e of clip.frames) {
    e.layers = [];
    for (const z of e.layersZ ?? []) {
      const raw = new Uint8Array(
        await new Response(
          new Blob([z as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
        ).arrayBuffer()
      );
      e.layers.push(e.wide ? new Uint16Array(raw.buffer, raw.byteOffset, PIXELS) : raw);
    }
    e.layersZ = undefined;
  }
  clip.packed = false;
}

/** V166 (Codex 指摘・優先度高③): **開く前に**「開いたら何バイトになるか」を答える。
 *
 *  ★なぜ要るか: 貼り付けは `unpackClip` で**クリップ全体を生バッファへ展開してから**
 *   見積もりに来ていた。1,098コマ×20レイヤーなら、断るより先に 1.57GB を確保してしまう
 *   ——**断る意味が無い**。展開は畳んだ側の「枚数」と「幅」だけで量が決まるので、
 *   ここで数えて呼び出し側が展開前に断れるようにする。
 *
 *  畳んでいない（`packed` でない）ときは、いま抱えている生バッファの合計を返す。 */
export function clipUnpackedBytes(clip: FrameClip): number {
  let n = 0;
  for (const e of clip.frames) {
    if (clip.packed) n += (e.layersZ?.length ?? 0) * PIXELS * (e.wide ? 2 : 1);
    else for (const lay of e.layers) n += lay.byteLength;
  }
  return n;
}

/** V166 (Codex 指摘・優先度高②): コピーが写し取る量（`makeClip` が確保する量）。
 *  `makeClip` は「選んだコマ × そのコマの実効レイヤー数」だけ `copyIndexBuf` する。 */
export function clipCopyBytes(p: Project, indices: number[]): number {
  const w = p.indexBits === 16 ? 2 : 1;
  let faces = 0;
  for (const fi of indices) {
    const f = p.frames[fi];
    if (f) faces += effectiveLayerIds(p, f).length;
  }
  return faces * PIXELS * w;
}

/** V156 (P-5): 畳んだ状態で抱えているバイト数（コピー直後のトースト用）。 */
export function clipBytes(clip: FrameClip): number {
  let n = 0;
  for (const e of clip.frames) {
    for (const lay of e.layers) n += lay.byteLength;
    for (const z of e.layersZ ?? []) n += z.byteLength;
  }
  return n;
}

/** コマの実効描画順（下→上）の layerId 列。render.ts と同じ正規化
 *  （order の重複/未知IDは無視・orderに無い既知レイヤーは末尾へ補完） */
export function effectiveLayerIds(p: Project, f: Frame): string[] {
  if (!f.order) return p.layerDefs.map((l) => l.id);
  const seen = new Set<string>();
  const list: string[] = [];
  for (const id of f.order) {
    if (seen.has(id)) continue;
    if (p.layerDefs.some((l) => l.id === id)) {
      list.push(id);
      seen.add(id);
    }
  }
  for (const ld of p.layerDefs) if (!seen.has(ld.id)) list.push(ld.id);
  return list;
}

/** 指定コマ群を非破壊でクリップに写し取る */
export function makeClip(p: Project, indices: number[]): FrameClip {
  const frames: FrameClipEntry[] = indices.map((fi) => {
    const f = p.frames[fi];
    const ids = effectiveLayerIds(p, f);
    return {
      // M11-16: 透明の紙（0）は "" のまま持つ。壊れた添字（colorTable に無い）は従来どおり白へ
      paperHex: f.paper === 0 ? "" : p.colorTable[f.paper] || "#ffffff",
      layers: ids.map((id) => copyIndexBuf(f.layers[id] ?? allocIndexBuf(p))),
      se: f.se && f.se.length > 0 ? [...f.se] : undefined,
    };
  });
  return { palette: [...p.colorTable], frames };
}

/**
 * クリップを貼り付け先プロジェクト p の新しい Frame 群へ変換する。
 * - 使用色だけを p の colorTable へ再マップ（未使用色でパレットを汚さない）。
 *   必要なら ensureColor が 16bit 自動昇格する（昇格検知は呼び出し側が indexBits を比較）。
 * - レイヤー数差: 不足分は透明・余剰分（クリップ側が多い）は最上位へ下→上順に焼き込み。
 * - 返る Frame の layers は現 layerDefs（下→上）に対応。order は undefined（標準順）。
 */
export function buildFramesFromClip(p: Project, clip: FrameClip): Frame[] {
  // 1) 使用色の収集（index 0=透明は除外）
  const used = new Set<number>();
  for (const e of clip.frames) {
    for (const lay of e.layers) {
      for (let i = 0; i < lay.length; i++) {
        const v = lay[i];
        if (v !== 0) used.add(v);
      }
    }
  }
  // 2) 色解決を先に全部済ませる（ここで昇格が起きても、以降の確保は新しい幅になる）
  const remap = new Uint32Array(clip.palette.length);
  for (const idx of used) {
    const hex = clip.palette[idx];
    remap[idx] = hex ? ensureColor(p, hex.toLowerCase()) : 0;
  }
  // M11-16: 透明の紙（""）は予約添字 0 をそのまま使う（ensureColor を通さない＝色を登録しない）
  const paperIdx = clip.frames.map((e) =>
    e.paperHex === "" ? 0 : ensureColor(p, e.paperHex.toLowerCase())
  );
  // 3) バッファ確保と転写（色解決後なので幅は確定済み）
  const defs = p.layerDefs;
  return clip.frames.map((e, fi) => {
    const layers: Record<string, IndexBuf> = {};
    for (let k = 0; k < defs.length; k++) {
      const nb = allocIndexBuf(p);
      const src = e.layers[k];
      if (src) {
        for (let i = 0; i < PIXELS; i++) {
          const v = src[i];
          if (v !== 0) nb[i] = remap[v];
        }
      }
      layers[defs[k].id] = nb;
    }
    // 余剰レイヤー（クリップ側が多い）は最上位へ下→上順に焼き込み（内容を捨てない）
    if (defs.length > 0) {
      const top = layers[defs[defs.length - 1].id];
      for (let k = defs.length; k < e.layers.length; k++) {
        const src = e.layers[k];
        for (let i = 0; i < PIXELS; i++) {
          const v = src[i];
          if (v !== 0) {
            const m = remap[v];
            if (m !== 0) top[i] = m;
          }
        }
      }
    }
    // M5-1: SE配置は貼り付け先に存在する id のみ残す
    // （同一メモ=保持／別メモ=未知SEは自動で外れる。REQ §3 確定規則）
    const validSe = new Set((p.audio?.se ?? []).map((s) => s.id));
    const se = e.se ? [...new Set(e.se)].filter((id) => validSe.has(id)) : [];
    return {
      paper: paperIdx[fi],
      layers,
      order: undefined,
      se: se.length > 0 ? se : undefined,
    };
  });
}
