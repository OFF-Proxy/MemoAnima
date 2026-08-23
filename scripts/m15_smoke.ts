// M15: レイヤー拡張の回帰スモーク（引数不要:  npx tsx scripts/m15_smoke.ts）
//
// 1. displayColor 無しの合成が従来とピクセル一致（tint 分岐の既定側が元の経路と同じ）
// 2. displayColor 設定で、そのレイヤーの不透明画素だけが表示色になる（索引データは不変）
// 3. displayColor の RGBA が colorTable の色（hexToU32/buildLut）と同じ並び
// 4. displayColor / shared 無しの保存が round-trip でバイト一致・JSON にキーが混ざらない
// 5. shared / displayColor キーが保存→読込で残る／壊れた値は落ちる
// 6. 旧版で共通レイヤーのコマ間に差 → 読込で shared が外れ __sharedConflict が立つ
// 7. promoteTo16 が共有バッファの同一性を保つ（分裂しない）／非共有は従来どおり別実体
// 8. relinkShared が全コマを1バッファへ張り直す
// 9. panCursorFor（A-21）: panning→grabbing / hand→grab / それ以外→""
import { W, H, PIXELS, buildLut, promoteTo16, relinkShared, allocIndexBuf, type Project, type IndexBuf } from "../src/editor/model";
import { compositeFrame } from "../src/editor/render";
import { projectToBytes, projectFromBytes } from "../src/editor/serialize";
import { panCursorFor } from "../src/editor/cursor";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else { fail++; console.log(`NG ${name}${detail ? " " + detail : ""}`); }
}

/** 最小プロジェクト（palette・2レイヤー・1コマ）。L1=黒の四角, L2=赤の四角（重なりなし） */
function makeProject(frameCount = 1): Project {
  const colorTable = ["", "#141414", "#ff0000", "#0038ce"]; // 1=黒 2=赤 3=青
  const layerDefs = [
    { id: "L1", name: "L1", visible: true, opacity: 1 },
    { id: "L2", name: "L2", visible: true, opacity: 1 },
  ];
  const frames = [];
  for (let n = 0; n < frameCount; n++) {
    const l1 = new Uint8Array(PIXELS);
    const l2 = new Uint8Array(PIXELS);
    for (let y = 40; y < 70; y++) for (let x = 40; x < 70; x++) l1[y * W + x] = 1;
    for (let y = 100; y < 130; y++) for (let x = 140; x < 170; x++) l2[y * W + x] = 2;
    frames.push({ paper: 1, layers: { L1: l1, L2: l2 } as Record<string, IndexBuf> });
  }
  return {
    version: 1, width: W, height: H, colorTable, indexBits: 8, layerDefs, frames,
    speedIndex: 6, loop: true, colorMode: "palette", nextLayerId: 1000,
    meta: { title: "m15" }, audio: null,
  } as Project;
}
const u32 = (hex: string) => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
};

// ---- 1. displayColor 無しの合成（tint 分岐の既定側）が「素直な lut 合成」と一致 ----
{
  const p = makeProject();
  const got = compositeFrame(p, 0);
  // 期待: 手計算の合成（紙=1, L1=1, L2=2 を lut で）
  const lut = buildLut(p.colorTable);
  const want = new Uint32Array(PIXELS).fill(lut[1]);
  const f = p.frames[0];
  for (let i = 0; i < PIXELS; i++) { if (f.layers.L1[i]) want[i] = lut[f.layers.L1[i]]; }
  for (let i = 0; i < PIXELS; i++) { if (f.layers.L2[i]) want[i] = lut[f.layers.L2[i]]; }
  check("1: displayColor 無しの合成が素直な lut 合成とピクセル一致", got.every((v, i) => v === want[i]));
}

// ---- 2. displayColor 設定で不透明画素だけ表示色に・索引は不変 ----
{
  const p = makeProject();
  p.layerDefs[0].displayColor = "#00ff00"; // L1 を緑で表示
  const before = new Uint8Array(p.frames[0].layers.L1); // 索引スナップショット
  const got = compositeFrame(p, 0);
  const green = u32("#00ff00");
  const lut = buildLut(p.colorTable);
  let l1green = true, l2intact = true, dataIntact = true;
  const f = p.frames[0];
  for (let i = 0; i < PIXELS; i++) {
    if (f.layers.L1[i] && !f.layers.L2[i]) { if (got[i] !== green) l1green = false; }
    if (f.layers.L2[i]) { if (got[i] !== lut[2]) l2intact = false; }
    if (f.layers.L1[i] !== before[i]) dataIntact = false;
  }
  check("2: displayColor 設定で L1 の不透明画素が表示色になる", l1green);
  check("2: displayColor 未設定の L2 は元の色のまま", l2intact);
  check("2: 索引データ（バッファ）は1ドットも変わらない", dataIntact);
}

// ---- 3. RGBA の並び ----
{
  const lut = buildLut(["", "#12ab5f"]);
  check("3: displayColor の RGBA 並びが colorTable と同じ（0xAABBGGRR）", lut[1] === u32("#12ab5f"));
}

// ---- 4. キー無し保存の round-trip バイト一致・JSON にキー混入なし ----
{
  (async () => {
    const { gunzipSync } = await import("fflate");
    // makeProject() は nextSeId 等の任意フィールドを持たない（＝ロード時に既定で補完される）。
    // 「新ビルドが書いたファイル」を基準にするため、一度ロードして既定を確定させたものを a とする。
    const p1 = await projectFromBytes(await projectToBytes(makeProject(2)));
    const a = await projectToBytes(p1);
    const p2 = await projectFromBytes(a);
    const b = await projectToBytes(p2);
    // meta.modifiedAt は保存のたびに現在時刻で打たれる（M15 以前からの仕様）。ここだけ正規化して比べる
    const norm = (bytes: Uint8Array) =>
      new TextDecoder().decode(gunzipSync(bytes)).replace(/"modifiedAt":"[^"]*"/g, '"modifiedAt":"X"');
    check("4: キー無しの保存が round-trip で一致（modifiedAt を除き完全一致）", norm(a) === norm(b));
    const json = new TextDecoder().decode(gunzipSync(a));
    check("4: キー無しファイルの JSON に shared/displayColor が入っていない", !json.includes('"shared"') && !json.includes('"displayColor"'));
    await stage2();
  })();
}

async function stage2() {
  // ---- 5. キーが残る・壊れた値は落ちる ----
  {
    const p = makeProject(2);
    p.layerDefs[0].shared = true;
    p.layerDefs[1].displayColor = "#a0b0c0";
    (p.layerDefs[0] as { displayColor?: unknown }).displayColor = "not-a-color"; // 壊れた値 → 落ちる
    const back = await projectFromBytes(await projectToBytes(p));
    check("5: 有効な shared キーが残る", back.layerDefs[0].shared === true);
    check("5: 有効な displayColor キーが残る", back.layerDefs[1].displayColor === "#a0b0c0");
    check("5: 壊れた displayColor は落ちる", back.layerDefs[0].displayColor === undefined);
  }

  // ---- 6. 旧版でコマ間に差 → 読込で shared 解除＋フラグ ----
  {
    const p = makeProject(3);
    p.layerDefs[0].shared = true;
    // 保存は各コマ独立に書かれる。1コマだけ絵を変える（＝旧版で編集された想定）
    const bytes = await projectToBytes(p);
    const doc = JSON.parse(new TextDecoder().decode((await import("fflate")).gunzipSync(bytes)));
    // frames[1] の L1 を別内容に差し替えて再エンコード（旧版編集のシミュレート）
    // 手軽に: p の frames[1].L1 に1ドット足して保存し直す
    p.frames[1].layers.L1[0] = 1;
    const back = await projectFromBytes(await projectToBytes(p));
    check("6: コマ間に差があると shared が外れる", back.layerDefs[0].shared === undefined);
    check("6: __sharedConflict フラグが立つ", (back as { __sharedConflict?: boolean }).__sharedConflict === true);
    void doc;
  }
  {
    // 差が無ければ shared は健在・フラグは立たない
    const p = makeProject(3);
    p.layerDefs[0].shared = true;
    relinkShared(p); // 全コマ同一内容
    const back = await projectFromBytes(await projectToBytes(p));
    check("6: 差が無ければ shared は健在", back.layerDefs[0].shared === true);
    check("6: 差が無ければフラグは立たない", (back as { __sharedConflict?: boolean }).__sharedConflict === undefined);
  }

  // ---- 7. promoteTo16 が共有の同一性を保つ ----
  {
    const p = makeProject(3);
    p.layerDefs[0].shared = true;
    relinkShared(p);
    check("7(前提): 共有レイヤーは全コマ同一実体", p.frames[0].layers.L1 === p.frames[1].layers.L1 && p.frames[1].layers.L1 === p.frames[2].layers.L1);
    check("7(前提): 非共有は別実体", p.frames[0].layers.L2 !== p.frames[1].layers.L2);
    promoteTo16(p);
    check("7: 16bit 昇格後も共有は同一実体（分裂しない）", p.frames[0].layers.L1 === p.frames[1].layers.L1 && p.frames[1].layers.L1 === p.frames[2].layers.L1);
    check("7: 昇格後は Uint16Array", p.frames[0].layers.L1 instanceof Uint16Array);
    check("7: 非共有は昇格後も別実体", p.frames[0].layers.L2 !== p.frames[1].layers.L2);
  }

  // ---- 8. relinkShared ----
  {
    const p = makeProject(3);
    p.layerDefs[0].shared = true;
    // わざと別実体にしてから relink
    p.frames[1].layers.L1 = allocIndexBuf(p);
    p.frames[2].layers.L1 = allocIndexBuf(p);
    relinkShared(p);
    check("8: relinkShared で全コマが1バッファへ", p.frames[0].layers.L1 === p.frames[1].layers.L1 && p.frames[1].layers.L1 === p.frames[2].layers.L1);
  }

  // ---- 9. panCursorFor（A-21） ----
  check("9: パン中は grabbing", panCursorFor(true, false) === "grabbing" && panCursorFor(true, true) === "grabbing");
  check("9: 手のひらは grab", panCursorFor(false, true) === "grab");
  check("9: それ以外は空（外枠のカーソル指定を外す）", panCursorFor(false, false) === "");

  console.log(`m15 smoke: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
