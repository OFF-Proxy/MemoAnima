// M11-20 スモーク: ①クリッピング（土台規則・合成・flatten・オニオン・保存形式）②ゆらゆらのレイヤー単体適用
// 引数不要:  npx tsx scripts/m1120_smoke.ts
//
// ①の要点:
//  - clipBaseMap: 下方向に連続する clip 群を飛ばした最初の非 clip（構造順・同じ親内のみ・子フォルダのブロックは飛ばす）
//  - compositeFrame / flattenIndexFrame / オニオン: clip 画素は土台の同じ画素が非0の所だけ。土台なし／土台非表示 → 出ない
//  - clip なし作品は合成結果が「clip を知らない参照実装」とビット同一（＋性能は別スクリプトで比較）
//  - serialize: clip:true は往復で残る・非 boolean は false（キー消滅）・PROJECT_VERSION=5・旧 version の doc に clip があっても読める
// ②の要点:
//  - buildWobbleFrames(target=null) は M10-3 当時の実装（ここに参照実装として複写）とビット同一
//  - target=レイヤー id: 対象レイヤーは全レイヤーモードの同じレイヤーとビット同一・他レイヤーは元コマとビット同一
//  - 決定性（同じ入力→同じ結果）・SE 落ち・paper/order 複製

import {
  newProject,
  ensureColor,
  clipBaseMap,
  hasClipLayers,
  effectiveLayerStates,
  cloneFrame,
  makeEmptyFrame,
  newLayerId,
  buildLut,
  PIXELS,
  W,
  Project,
  Frame,
  IndexBuf,
  LayerDef,
} from "../src/editor/model";
import { compositeFrame, flattenIndexFrame } from "../src/editor/render";
import { projectToBytes, projectFromBytes, PROJECT_VERSION, PV5_VERSION } from "../src/editor/serialize";
import { buildWobbleFrames, WOBBLE_TABLE, WobbleKind, WobbleStrength } from "../src/editor/wobble";
import { WarpField, applyWarp } from "../src/editor/warp";
// M12-1c-2: 文言の pin が言語に左右されないよう ja に固定する（pin の文字列は変えていない）
import { setLang } from "../src/i18n";
setLang("ja");
// exporter.ts は gif.js（ブラウザ前提・`self` を参照）を静的 import するので、Node では self を敷いてから動的 import
(globalThis as unknown as { self: unknown }).self = globalThis;
const { projectSource } = await import("../src/editor/exporter");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}
const eqBuf = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const at = (x: number, y: number) => y * W + x;
const rect = (buf: IndexBuf, x0: number, y0: number, x1: number, y1: number, v: number) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) buf[at(x, y)] = v;
};
const rgb = (px: Uint32Array, x: number, y: number) => px[at(x, y)] & 0xffffff;
const hex2rgb = (hex: string) =>
  parseInt(hex.slice(1, 3), 16) | (parseInt(hex.slice(3, 5), 16) << 8) | (parseInt(hex.slice(5, 7), 16) << 16);

async function gzipJson(doc: unknown): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const blob = new Blob([new TextEncoder().encode(JSON.stringify(doc)) as unknown as BlobPart]);
  return new Uint8Array(await new Response(blob.stream().pipeThrough(cs)).arrayBuffer());
}
const addLayer = (p: Project, name: string, parent?: string, clip?: boolean): LayerDef => {
  const ld: LayerDef = { id: newLayerId(p), name, visible: true, opacity: 1 };
  if (parent) ld.parent = parent;
  if (clip) ld.clip = true;
  p.layerDefs.push(ld);
  for (const f of p.frames) f.layers[ld.id] = new Uint8Array(PIXELS);
  return ld;
};

// ================= ① clipBaseMap（土台規則） =================
{
  const p = newProject("rules");
  const [C, B, A] = p.layerDefs; // 下→上: C, B, A
  B.clip = true;
  let m = clipBaseMap(p);
  check("①規則 B(clip) の土台は直下の C", m.get(B.id) === C.id && !m.has(A.id) && !m.has(C.id));
  A.clip = true;
  m = clipBaseMap(p);
  check("①規則 連続 clip（B,A）は同じ土台 C を共有", m.get(B.id) === C.id && m.get(A.id) === C.id);
  C.clip = true;
  m = clipBaseMap(p);
  check("①規則 最下層 C(clip) は土台なし（null）", m.get(C.id) === null && m.get(B.id) === null && m.get(A.id) === null);
  delete C.clip;
  delete B.clip;
  m = clipBaseMap(p);
  check("①規則 [C, B, A(clip)] → A の土台は B（連続 clip でない）", m.get(A.id) === B.id);
  check("①規則 hasClipLayers", hasClipLayers(p) === true);
  delete A.clip;
  check("①規則 hasClipLayers（全 off）", hasClipLayers(p) === false && clipBaseMap(p).size === 0);
  // フォルダ: 下→上 [a(F), b(G), c(G), d(F), x(root), y(root,clip)]（G は F の子）
  const q = newProject("folders");
  q.layerDefs = [];
  q.frames = [{ paper: 1, layers: {} }];
  q.folders = [
    { id: "F", name: "F", visible: true, opacity: 1, collapsed: false },
    { id: "G", name: "G", visible: true, opacity: 1, collapsed: false, parent: "F" },
  ];
  const a = addLayer(q, "a", "F");
  const b = addLayer(q, "b", "G");
  const c = addLayer(q, "c", "G", true);
  const d = addLayer(q, "d", "F", true);
  const x = addLayer(q, "x");
  const y = addLayer(q, "y", undefined, true);
  m = clipBaseMap(q);
  check("①規則 同じフォルダ内: c(G,clip) の土台は b(G)", m.get(c.id) === b.id);
  check("①規則 子フォルダのブロックを飛ばして同じ親の直下へ: d(F,clip) の土台は a(F)（b/c は G）", m.get(d.id) === a.id);
  check("①規則 ルート: y(clip) の土台は x（フォルダ F の中身は跨がない＝土台にしない）", m.get(y.id) === x.id);
  b.clip = true;
  m = clipBaseMap(q);
  check("①規則 フォルダ最下層 b(G,clip) は土台なし（F の a へは跨がない）", m.get(b.id) === null && m.get(c.id) === null);
  delete b.clip;
  // 存在しないフォルダを親に持つ → ルート扱い（effectiveLayerStates と同じ）
  const z = addLayer(q, "z", "NOPE", true);
  m = clipBaseMap(q);
  check("①規則 存在しない親はルート扱い: z(clip) の土台は直下のルート非 clip（y は clip なので飛ばして x）", m.get(z.id) === x.id);
  q.layerDefs.pop();
}

// ================= ① 合成（compositeFrame / flatten / オニオン） =================
{
  const p = newProject("comp");
  const [C, B, A] = p.layerDefs; // C=線画（土台）, B=色（clip）, A=最上位
  const black = ensureColor(p, "#141414");
  const red = ensureColor(p, "#ff2a2a");
  const blue = ensureColor(p, "#1fa2ff");
  const f = p.frames[0];
  // 土台 C: 四角い線画（枠だけ）: x 100..140, y 100..130 の枠線 2px
  rect(f.layers[C.id], 100, 100, 140, 130, black);
  rect(f.layers[C.id], 102, 102, 138, 128, 0);
  // 色 B: 大きく塗る（はみ出す）: x 90..150, y 90..140
  rect(f.layers[B.id], 90, 90, 150, 140, red);
  const paperRgb = hex2rgb(p.colorTable[f.paper]);
  // clip off: 全部見える
  let px = compositeFrame(p, 0);
  check("①合成 clip off: はみ出しが見える（(95,95)=赤）", rgb(px, 95, 95) === hex2rgb("#ff2a2a"));
  // clip on
  B.clip = true;
  px = compositeFrame(p, 0);
  check("①合成 clip on: 線画の上（(100,100)）は赤＝B が C の上に描かれる", rgb(px, 100, 100) === hex2rgb("#ff2a2a"));
  check("①合成 clip on: 線画の外（(95,95)）は紙色＝はみ出しが消える", rgb(px, 95, 95) === paperRgb);
  check("①合成 clip on: 枠の内側（(120,115)・C は 0）も紙色", rgb(px, 120, 115) === paperRgb);
  // データ不変
  check("①合成 clip はマスクだけ＝B のバッファは全画素そのまま", f.layers[B.id][at(95, 95)] === red);
  // 土台を非表示 → B も消える
  C.visible = false;
  px = compositeFrame(p, 0);
  check("①合成 土台非表示 → clip 群も消える（(100,100) 紙色）", rgb(px, 100, 100) === paperRgb);
  C.visible = true;
  // 連続 clip: A も clip にして青で全面 → C の枠の上だけ青（B の上に A）
  A.clip = true;
  rect(f.layers[A.id], 0, 0, 319, 239, blue);
  px = compositeFrame(p, 0);
  check("①合成 連続 clip（B,A）は同じ土台 C: 枠上 (100,100) は青・枠外 (10,10) は紙色", rgb(px, 100, 100) === hex2rgb("#1fa2ff") && rgb(px, 10, 10) === paperRgb);
  // 最下層 clip → 非表示（C を clip に）
  C.clip = true;
  px = compositeFrame(p, 0);
  check("①合成 最下層 C(clip) は表示されない（(100,101) 枠線が消えて紙色）", rgb(px, 100, 101) === paperRgb);
  delete C.clip;
  // 不透明度 0.5 の clip レイヤー: マスク内だけブレンド・マスク外は紙のまま
  rect(f.layers[A.id], 0, 0, 319, 239, 0);
  A.opacity = 0.5;
  rect(f.layers[A.id], 90, 90, 150, 140, blue);
  px = compositeFrame(p, 0);
  const inside = rgb(px, 100, 100);
  check("①合成 不透明度 0.5 の clip: 枠外 (95,95) は紙色のまま・枠上は青と赤の中間", rgb(px, 95, 95) === paperRgb && inside !== hex2rgb("#1fa2ff") && inside !== hex2rgb("#ff2a2a"));
  A.opacity = 1;
  rect(f.layers[A.id], 0, 0, 319, 239, 0);
  delete A.clip;
  // 透明紙 × clip
  f.paper = 0;
  px = compositeFrame(p, 0);
  check("①合成 透明紙: 枠外は 0（透明）・枠上は赤", px[at(95, 95)] === 0 && rgb(px, 100, 100) === hex2rgb("#ff2a2a"));
  f.paper = ensureColor(p, "#ffffff");
  // 書き出し全形式（MP4/GIF/APNG/PNG連番）は exporter の FrameSource（projectSource().getFrameRgba）を通る＝
  // 編集画面と同じ compositeFrame の結果がそのまま出る（枠外は紙・枠上は赤）
  {
    const src = projectSource(p);
    const rgba = src.getFrameRgba(0);
    const px = (x: number, y: number) => rgba[at(x, y) * 4] | (rgba[at(x, y) * 4 + 1] << 8) | (rgba[at(x, y) * 4 + 2] << 16);
    check("①書き出し FrameSource.getFrameRgba: 枠外 (95,95) 紙色・枠上 (100,100) 赤（clip 適用後）", px(95, 95) === paperRgb && px(100, 100) === hex2rgb("#ff2a2a"));
  }
  // flattenIndexFrame: clip 適用後
  const flat = flattenIndexFrame(p, 0);
  check("①flatten clip 適用後: 枠外 (95,95) は 0・枠上 (100,100) は赤の添字", flat[at(95, 95)] === 0 && flat[at(100, 100)] === red);
  // order（コマ固有描画順）: 土台は構造順で決まる（順序が変わっても B は C の枠外に出ない）
  f.order = [B.id, C.id, A.id]; // B を先に描く
  px = compositeFrame(p, 0);
  check("①合成 order で B が先に描かれても土台は構造順の C＝枠外 (95,95) は紙色・枠上は C が上書きして黒", rgb(px, 95, 95) === paperRgb && rgb(px, 100, 100) === hex2rgb("#141414"));
  f.order = undefined;
  // オニオン: 隣のコマの clip レイヤーもその土台でマスク
  const g = cloneFrame(f);
  rect(g.layers[B.id], 0, 0, 319, 239, 0);
  rect(g.layers[C.id], 0, 0, 319, 239, 0);
  rect(g.layers[C.id], 200, 200, 210, 210, black); // 隣コマの土台は右下だけ
  rect(g.layers[B.id], 0, 0, 319, 239, red); // 隣コマの clip レイヤーは全面
  p.frames.push(g);
  // 現在コマ 1（g）を見ながらオニオンで 0 を透かす → 0 の B は C の枠上だけ・現在コマの B は右下だけ
  const on = compositeFrame(p, 1, undefined, { onion: 1 });
  check("①オニオン 前コマの clip 画素は前コマの土台でマスク（(50,50) は紙色・(100,100) は薄赤）", rgb(on, 50, 50) === paperRgb && rgb(on, 100, 100) !== paperRgb);
  check("①オニオン 現在コマの clip も土台どおり（(205,205) 赤・(30,30) 紙色）", rgb(on, 205, 205) === hex2rgb("#ff2a2a") && rgb(on, 30, 30) === paperRgb);
  p.frames.pop();
}

// ================= ① clip なし作品は参照実装とビット同一（M11-19 以前の compositeFrame を複写） =================
{
  const refComposite = (p: Project, frameIndex: number): Uint32Array => {
    const lut = buildLut(p.colorTable);
    const buf = new Uint32Array(PIXELS);
    const frame = p.frames[frameIndex];
    if (frame.paper === 0) buf.fill(0);
    else buf.fill(lut[frame.paper] || 0xffffffff);
    const eff = effectiveLayerStates(p);
    let defs = p.layerDefs;
    if (frame.order) {
      const seen = new Set<string>();
      const list: typeof p.layerDefs = [];
      for (const id of frame.order) {
        if (seen.has(id)) continue;
        const ld = p.layerDefs.find((l) => l.id === id);
        if (ld) {
          list.push(ld);
          seen.add(id);
        }
      }
      for (const ld of p.layerDefs) if (!seen.has(ld.id)) list.push(ld);
      defs = list;
    }
    for (const ld of defs) {
      const e = eff.get(ld.id) ?? { visible: ld.visible, opacity: ld.opacity };
      if (!e.visible) continue;
      const lb = frame.layers[ld.id];
      if (!lb) continue;
      if (e.opacity >= 1) {
        for (let i = 0; i < PIXELS; i++) if (lb[i] !== 0) buf[i] = lut[lb[i]];
      } else if (e.opacity > 0) {
        for (let i = 0; i < PIXELS; i++) {
          const v = lb[i];
          if (v === 0) continue;
          const rgba = lut[v];
          const dst = buf[i];
          const a = e.opacity;
          const r = (((rgba & 0xff) * a + (dst & 0xff) * (1 - a)) | 0);
          const g = ((((rgba >> 8) & 0xff) * a + ((dst >> 8) & 0xff) * (1 - a)) | 0);
          const b = ((((rgba >> 16) & 0xff) * a + ((dst >> 16) & 0xff) * (1 - a)) | 0);
          buf[i] = (r | (g << 8) | (b << 16) | (0xff << 24)) >>> 0;
        }
      }
    }
    return buf;
  };
  // 乱数っぽい絵（決定的）を 3 レイヤー・不透明度混在・order あり/なしで
  const p = newProject("noclip");
  const cols = ["#141414", "#ff2a2a", "#1fa2ff", "#22b573", "#f07a1a"].map((h) => ensureColor(p, h));
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (const ld of p.layerDefs)
    for (let i = 0; i < PIXELS; i++) if (rnd() < 0.3) p.frames[0].layers[ld.id][i] = cols[(rnd() * cols.length) | 0];
  p.layerDefs[1].opacity = 0.5;
  p.folders = [{ id: "F", name: "F", visible: true, opacity: 0.7, collapsed: false }];
  p.layerDefs[2].parent = "F";
  check("①同一 clip なし: 参照実装とビット同一（不透明度・フォルダ積）", eqBuf(compositeFrame(p, 0), refComposite(p, 0)));
  p.frames[0].order = [p.layerDefs[2].id, p.layerDefs[0].id, p.layerDefs[1].id];
  check("①同一 clip なし: order あり", eqBuf(compositeFrame(p, 0), refComposite(p, 0)));
  p.frames[0].paper = 0;
  check("①同一 clip なし: 透明紙", eqBuf(compositeFrame(p, 0), refComposite(p, 0)));
}

// ================= ① serialize（任意キー・PV5・正規化・旧 doc） =================
await (async () => {
  // V163: 旧形式の書き手（projectToBytes）は 5 のまま。現行形式（PV6・pv6.ts）は 6
  check("①旧形式の書き手 PV5_VERSION は 5 のまま", PV5_VERSION === 5);
  check("①現行形式 PROJECT_VERSION は 6", PROJECT_VERSION === 6);
  const p = newProject("ser");
  p.layerDefs[1].clip = true;
  const bytes = await projectToBytes(p);
  const q = await projectFromBytes(bytes);
  check("①保存 clip:true は往復で残る（他は無し）", q.layerDefs[1].clip === true && !("clip" in q.layerDefs[0]) && !("clip" in q.layerDefs[2]));
  // 手組み doc: 非 boolean → false（キー消滅）・旧 version(4) の doc に clip があっても読める
  const raw = JSON.parse(new TextDecoder().decode(await new Response(new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()));
  const broken = JSON.parse(JSON.stringify(raw));
  broken.layerDefs[0].clip = "yes";
  broken.layerDefs[1].clip = 1;
  broken.layerDefs[2].clip = false;
  const r1 = await projectFromBytes(await gzipJson(broken));
  check("①保存 非 boolean（'yes'/1）と false はキー消滅＝false 扱い", r1.layerDefs.every((l) => !("clip" in l)));
  const old = JSON.parse(JSON.stringify(raw));
  old.version = 4;
  old.layerDefs[2].clip = true;
  const r2 = await projectFromBytes(await gzipJson(old));
  check("①保存 旧 version(4) の doc に clip があっても読めて反映される", r2.layerDefs[2].clip === true && r2.layerDefs[1].clip === true);
  // 「旧ビルド相当」= 素通しの読み書き: JSON.parse → そのまま JSON.stringify で clip キーが残る（serialize の layerDefs 素通しの写し）
  const passthrough = JSON.parse(JSON.stringify({ layerDefs: raw.layerDefs })).layerDefs;
  check("①保存 旧ビルド相当（layerDefs 素通し）で clip キーが残る", passthrough[1].clip === true);
  // 保存されるキーは clip:true だけ（false は書かない）
  check("①保存 doc に clip:false は書かれない", !("clip" in raw.layerDefs[0]) && raw.layerDefs[1].clip === true);
})();

// ================= ② ゆらゆら =================
{
  // M10-3 当時（editor.ts 内）の実装を**そのまま**複写した参照実装（全レイヤー）
  const refBuild = (p: Project, cur: Frame, count: number, kind: WobbleKind, strength: WobbleStrength, seedBase: number, clip: Uint8Array | null): Frame[] => {
    const { L, A } = WOBBLE_TABLE[kind][strength];
    const field = new WarpField();
    const out: Frame[] = [];
    for (let k = 0; k < count - 1; k++) {
      const seedK = (seedBase + Math.imul(k + 1, 0x9e3779b9)) >>> 0;
      field.setValueNoise(seedK, (seedK ^ 0x6d2b79f5) >>> 0, L, A);
      const nf = cloneFrame(cur);
      nf.se = undefined;
      for (const ld of p.layerDefs) {
        const src = cur.layers[ld.id];
        const dst = nf.layers[ld.id];
        if (src && dst) applyWarp(src, dst, field, clip);
      }
      out.push(nf);
    }
    return out;
  };
  const p = newProject("wobble");
  const cols = ["#141414", "#ff2a2a", "#1fa2ff"].map((h) => ensureColor(p, h));
  let s = 777;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const cur = p.frames[0];
  p.layerDefs.forEach((ld, li) => {
    const b = cur.layers[ld.id];
    for (let i = 0; i < PIXELS; i++) if (rnd() < 0.15) b[i] = cols[li];
    rect(b, 40 + li * 30, 60, 60 + li * 30, 90, cols[li]);
  });
  cur.se = ["S1", "S2"];
  cur.order = [p.layerDefs[2].id, p.layerDefs[0].id, p.layerDefs[1].id];
  const mask = new Uint8Array(PIXELS);
  rect(mask, 20, 20, 200, 160, 1);
  const framesEq = (a: Frame[], b: Frame[]) =>
    a.length === b.length && a.every((fa, i) => p.layerDefs.every((ld) => eqBuf(fa.layers[ld.id], b[i].layers[ld.id])) && fa.paper === b[i].paper);
  let allSame = true;
  let deterministic = true;
  let targetSame = true;
  let othersUnchanged = true;
  let sourceUntouched = true;
  const srcCopy = cloneFrame(cur);
  const kinds: WobbleKind[] = ["line", "whole"];
  const strengths: WobbleStrength[] = [0, 1, 2];
  for (const kind of kinds)
    for (const st of strengths)
      for (const count of [2, 3, 4])
        for (const m of [null, mask])
          for (const seed of [0x12345678, 0, 0xdeadbeef]) {
            const ref = refBuild(p, cur, count, kind, st, seed, m);
            const now = buildWobbleFrames(p, cur, count, kind, st, seed, m, null);
            if (!framesEq(ref, now)) allSame = false;
            const again = buildWobbleFrames(p, cur, count, kind, st, seed, m, null);
            if (!framesEq(now, again)) deterministic = false;
            for (const t of p.layerDefs) {
              const one = buildWobbleFrames(p, cur, count, kind, st, seed, m, t.id);
              const one2 = buildWobbleFrames(p, cur, count, kind, st, seed, m, t.id);
              if (!framesEq(one, one2)) deterministic = false;
              one.forEach((fo, i) => {
                if (!eqBuf(fo.layers[t.id], now[i].layers[t.id])) targetSame = false;
                for (const o of p.layerDefs)
                  if (o.id !== t.id && !eqBuf(fo.layers[o.id], cur.layers[o.id])) othersUnchanged = false;
                if (fo.se !== undefined || fo.paper !== cur.paper || !fo.order || fo.order.join() !== cur.order!.join()) othersUnchanged = false;
              });
            }
            for (const ld of p.layerDefs) if (!eqBuf(cur.layers[ld.id], srcCopy.layers[ld.id])) sourceUntouched = false;
          }
  check("②全レイヤー: M10-3 の参照実装とビット同一（2種類×3強さ×3枚数×マスク有無×3シード）", allSame);
  check("②決定性: 同じ入力で同じ結果（全レイヤー／単体とも）", deterministic);
  check("②単体: 対象レイヤーは全レイヤーモードの同じレイヤーとビット同一", targetSame);
  check("②単体: 他レイヤーは元コマとビット同一・SE 落ち・paper/order 複製", othersUnchanged);
  check("②原本のコマは一切変わらない", sourceUntouched);
  // 差分の存在（対象レイヤーは実際に動いている＝「何も起きない」でない）
  const one = buildWobbleFrames(p, cur, 3, "whole", 2, 0x12345678, null, p.layerDefs[0].id);
  let moved = 0;
  for (let i = 0; i < PIXELS; i++) if (one[0].layers[p.layerDefs[0].id][i] !== cur.layers[p.layerDefs[0].id][i]) moved++;
  check("②単体: 対象レイヤーの画素は実際に動く（>0）", moved > 0, `moved=${moved}`);
  // 存在しない id → 何も揺れない（複製だけ）
  const none = buildWobbleFrames(p, cur, 2, "line", 1, 1, null, "NOPE");
  check("②単体: 未知の対象 id なら全レイヤーが複製のまま", p.layerDefs.every((ld) => eqBuf(none[0].layers[ld.id], cur.layers[ld.id])));
}

// ================= 性能（参考値・別スクリプトで旧ツリーと比較） =================
{
  const p = newProject("perf");
  const black = ensureColor(p, "#141414");
  for (const ld of p.layerDefs) rect(p.frames[0].layers[ld.id], 20, 20, 300, 220, black);
  const out = new Uint32Array(PIXELS);
  for (let i = 0; i < 20; i++) compositeFrame(p, 0, out);
  const t0 = performance.now();
  const N = 300;
  for (let i = 0; i < N; i++) compositeFrame(p, 0, out);
  const noClip = (performance.now() - t0) / N;
  p.layerDefs[1].clip = true;
  for (let i = 0; i < 20; i++) compositeFrame(p, 0, out);
  const t1 = performance.now();
  for (let i = 0; i < N; i++) compositeFrame(p, 0, out);
  const withClip = (performance.now() - t1) / N;
  console.log(`perf compositeFrame 3層全面: clipなし ${noClip.toFixed(3)} ms/回, clip1枚 ${withClip.toFixed(3)} ms/回`);
  check("性能 clip あり合成も同じ桁（< 3 倍）", withClip < noClip * 3 + 0.5, `${noClip.toFixed(3)} vs ${withClip.toFixed(3)}`);
}

console.log(`m1120 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
