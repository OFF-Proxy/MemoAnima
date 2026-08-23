// M17: マイ柄（カスタムトーン）の回帰スモーク（引数不要: npx tsx scripts/m17_smoke.ts）
//
//   1. ★マイ柄未使用の描画（stamp / strokeSegment / floodFill）が「従来の規則」とピクセル一致
//      （colorTile 未指定・null のどちらも従来経路＝tone/texture の規則そのもの）
//   2. captureCustomTone: 外接矩形×マスク内の見えている画素・RGB 保存・33×40→左上 32×32＋cropped・全透明は null
//   3. buildColorTile: 🎨色モード＝色ごとに1回だけ解決／形だけ＝全部現在色／透明は -1
//   4. colorTileAt: 非正方形タイルの折返し＋🔀コマ間シフト (0,0)/(1,1)/(2,2)
//   5. applyColorTile / floodFillColorTile: マスク内だけ・透明は触らない・clip は壁・ref 参照
//   6. ★257 色目を跨ぐ順序: 「全色一括解決 → バッファ取得」なら正しく塗れる／逆順だと保持参照が死ぬ（カナリア）
//   7. sanitizeCustomTones: 旧 settings→[]・壊れた要素だけ捨てる・上限 12・id 振り直し
import { W, H, PIXELS, newProject, ensureColor, type IndexBuf } from "../src/editor/model";
import { stamp, strokeSegment, floodFill, toneAt, toneById, colorTileAt, rectMask, lassoMask, type PenOptions } from "../src/editor/raster";
import {
  captureCustomTone,
  buildColorTile,
  applyColorTile,
  floodFillColorTile,
  sanitizeCustomTones,
  customToneKey,
  parseCustomToneKey,
  nextCustomToneId,
  CUSTOM_TONE_MAX_COUNT,
} from "../src/editor/customTone";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " " + detail : ""}`);
  }
}
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const popcount = (b: ArrayLike<number>) => {
  let c = 0;
  for (let i = 0; i < b.length; i++) if (b[i]) c++;
  return c;
};

// ================= 1. 未使用時のピクセル一致 =================
{
  const tile = toneById("dot-grid-l")!.tile!;
  // (a) ベタ（solid）の stamp: 半径内の全画素が color
  const base: PenOptions = { size: 5, color: 3, texture: "solid", seed: 1 };
  const a = new Uint8Array(PIXELS) as IndexBuf;
  stamp(a, 100, 100, base);
  const b = new Uint8Array(PIXELS) as IndexBuf;
  stamp(b, 100, 100, { ...base, colorTile: null }); // null も未使用
  check("1a: colorTile:null は未指定と一致（solid stamp）", same(a, b));
  // 従来規則（円形判定）の独立計算
  const ref = new Uint8Array(PIXELS);
  const r = 2.5, ri = 3;
  for (let dy = -ri; dy <= ri; dy++)
    for (let dx = -ri; dx <= ri; dx++) if (dx * dx + dy * dy <= r * r) ref[(100 + dy) * W + 100 + dx] = 3;
  check("1a: solid stamp が従来規則（円）と一致", same(a, ref));

  // (b) トーン stamp: toneAt が true の画素だけ（座標固定）
  const c = new Uint8Array(PIXELS) as IndexBuf;
  stamp(c, 100, 100, { ...base, tone: tile });
  const refT = new Uint8Array(PIXELS);
  for (let i = 0; i < PIXELS; i++) if (ref[i] && toneAt(tile, i % W, (i / W) | 0)) refT[i] = 3;
  check("1b: tone stamp が従来規則（円∧toneAt）と一致", same(c, refT));
  const c2 = new Uint8Array(PIXELS) as IndexBuf;
  stamp(c2, 100, 100, { ...base, tone: tile, colorTile: undefined });
  check("1b: colorTile:undefined 明示でも一致", same(c, c2));

  // (c) strokeSegment（線）: colorTile 有無で一致
  const d1 = new Uint8Array(PIXELS) as IndexBuf;
  const d2 = new Uint8Array(PIXELS) as IndexBuf;
  strokeSegment(d1, 20, 20, 120, 60, { ...base, dashAcc: { d: 0 } });
  strokeSegment(d2, 20, 20, 120, 60, { ...base, dashAcc: { d: 0 }, colorTile: null });
  check("1c: strokeSegment が colorTile:null でも一致", same(d1, d2) && popcount(d1) > 100);

  // (d) floodFill（tone）: 従来どおり toneAt（m14 と同じ固定）
  const e = new Uint8Array(PIXELS) as IndexBuf;
  floodFill(e, 10, 10, 7, tile, undefined, undefined);
  let okE = true;
  for (let i = 0; i < PIXELS; i++) if ((e[i] === 7) !== toneAt(tile, i % W, (i / W) | 0)) { okE = false; break; }
  check("1d: floodFill(tone) が toneAt と一致（従来どおり）", okE);
}

// ================= 2. captureCustomTone =================
{
  const colorTable = ["", "#141414", "#ff0000", "#0038ce"];
  // 2色チェッカー 4×4 を (10,10) に置き、矩形選択で登録
  const buf = new Uint8Array(PIXELS) as IndexBuf;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) buf[(10 + y) * W + 10 + x] = (x + y) & 1 ? 2 : 3;
  const mask = rectMask(10, 10, 13, 13);
  const cap = captureCustomTone(buf, mask, colorTable)!;
  check("2: 4×4 チェッカーを登録（寸法）", !!cap && cap.w === 4 && cap.h === 4 && cap.cropped === false);
  check("2: 色は RGB（索引ではない）", cap.colors[0] === "#0038ce" && cap.colors[1] === "#ff0000");
  check("2: colors 長さ = w*h", cap.colors.length === 16 && cap.colors.every((c) => c === "#ff0000" || c === "#0038ce"));

  // マスク外・透明画素は ""（自由選択＝菱形でチェッカーの外周が透明になる）
  const lm = lassoMask([{ x: 12, y: 9 }, { x: 16, y: 12 }, { x: 12, y: 15 }, { x: 8, y: 12 }]);
  const cap2 = captureCustomTone(buf, lm, colorTable)!;
  check("2: 自由選択の外接矩形で切り出し", !!cap2 && cap2.w >= 4 && cap2.h >= 4);
  check("2: マスク外は透明（\"\"）", cap2.colors.some((c) => c === "") && cap2.colors.some((c) => c !== ""));

  // 33×40 → 左上 32×32 ＋ cropped
  const big = new Uint8Array(PIXELS) as IndexBuf;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 33; x++) big[(50 + y) * W + 50 + x] = 1;
  const capBig = captureCustomTone(big, rectMask(50, 50, 82, 89), colorTable)!;
  check("2: 33×40 の選択 → 32×32 に切り出し＋cropped", !!capBig && capBig.w === 32 && capBig.h === 32 && capBig.cropped === true);
  check("2: 切り出しは左上（全部 #141414）", capBig.colors.every((c) => c === "#141414"));

  // 片軸だけ超過（40×10）→ 32×10 に切り出し（軸ごとに独立）
  const wide = new Uint8Array(PIXELS) as IndexBuf;
  for (let y = 0; y < 10; y++) for (let x = 0; x < 40; x++) wide[(100 + y) * W + 100 + x] = 1;
  const capWide = captureCustomTone(wide, rectMask(100, 100, 139, 109), colorTable)!;
  check("2: 40×10 の選択 → 32×10（軸ごとに切る）＋cropped", !!capWide && capWide.w === 32 && capWide.h === 10 && capWide.cropped === true);
  // 左上の窓に絵が無い（40×40 の選択で絵は右下 8×8 だけ）→ 最初に見えている画素を左上にした窓へずらして登録（拒否しない）
  const corner = new Uint8Array(PIXELS) as IndexBuf;
  for (let y = 32; y < 40; y++) for (let x = 32; x < 40; x++) corner[(150 + y) * W + 150 + x] = 2;
  const capCorner = captureCustomTone(corner, rectMask(150, 150, 189, 189), colorTable)!;
  check("2: 左上の窓に絵が無くても拒否せず、絵を含む窓で登録（cropped）", !!capCorner && capCorner.cropped === true && capCorner.colors.some((c) => c === "#ff0000"));
  // 全透明（選択はあるが見えている画素なし）は null
  const empty = new Uint8Array(PIXELS) as IndexBuf;
  check("2: 全透明は拒否（null）", captureCustomTone(empty, rectMask(0, 0, 9, 9), colorTable) === null);
  // 選択なし（マスク全0）も null
  check("2: 選択なしは null", captureCustomTone(buf, new Uint8Array(PIXELS), colorTable) === null);
}

// ================= 3. buildColorTile =================
{
  const ct = { w: 2, h: 2, colors: ["#ff0000", "", "#00ff00", "#ff0000"] };
  const calls: string[] = [];
  const table = new Map<string, number>([["#ff0000", 5], ["#00ff00", 9]]);
  const tileC = buildColorTile(ct, { resolve: (hex) => { calls.push(hex); return table.get(hex)!; } });
  check("3: 🎨色モード＝索引に解決・透明は -1", tileC.idx[0] === 5 && tileC.idx[1] === -1 && tileC.idx[2] === 9 && tileC.idx[3] === 5);
  check("3: 同じ色は1回だけ解決（#ff0000 が2画素でも resolve 1回）", calls.length === 2 && calls.includes("#ff0000") && calls.includes("#00ff00"));
  const tileS = buildColorTile(ct, { color: 4 });
  check("3: 形だけモード＝非透明は全部現在色・透明は -1", tileS.idx[0] === 4 && tileS.idx[1] === -1 && tileS.idx[2] === 4 && tileS.idx[3] === 4);
  const tileE = buildColorTile(ct, { color: 0 });
  check("3: かすり消し＝形で 0（消す）", tileE.idx[0] === 0 && tileE.idx[1] === -1);
}

// ================= 4. colorTileAt（折返し＋🔀シフト） =================
{
  // 3×2（非正方形）: idx = [1,2,3, 4,5,6]
  const ct = { w: 3, h: 2, idx: Int32Array.from([1, 2, 3, 4, 5, 6]) };
  check("4: (0,0)=1 (2,0)=3 (0,1)=4", colorTileAt(ct, 0, 0) === 1 && colorTileAt(ct, 2, 0) === 3 && colorTileAt(ct, 0, 1) === 4);
  check("4: 幅で折返し (3,0)=1 (4,1)=5", colorTileAt(ct, 3, 0) === 1 && colorTileAt(ct, 4, 1) === 5);
  check("4: 高さで折返し (0,2)=1", colorTileAt(ct, 0, 2) === 1);
  // shift=f は (x+f,y+f) 参照 → 3コマで (0,0)/(1,1)/(2,2)
  let ok = true;
  for (const f of [0, 1, 2])
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 6; x++) if (colorTileAt(ct, x, y, f) !== colorTileAt(ct, x + f, y + f, 0)) ok = false;
  check("4: 🔀 shift=f が (x+f,y+f) 参照（3コマ (0,0)/(1,1)/(2,2)）", ok);
  check("4: shift=1 で frame0 と違う（揺れる）", colorTileAt(ct, 0, 0, 1) === 5 && colorTileAt(ct, 0, 0, 0) === 1);
}

// ================= 5. applyColorTile / floodFillColorTile =================
{
  const ct = { w: 2, h: 2, idx: Int32Array.from([7, -1, -1, 8]) }; // チェッカーの半分は透明
  const buf = new Uint8Array(PIXELS).fill(1) as IndexBuf;
  const mask = rectMask(0, 0, 3, 3); // 4×4
  const changed = applyColorTile(buf, mask, ct);
  check("5: applyColorTile 変化あり", changed === true);
  check("5: (0,0)=7 (1,1)=8 (2,0)=7", buf[0] === 7 && buf[1 * W + 1] === 8 && buf[2] === 7);
  check("5: 透明(-1)の画素は元のまま（1）", buf[1] === 1 && buf[W] === 1);
  check("5: マスク外は不変", buf[4] === 1 && buf[4 * W] === 1);
  check("5: 再適用は変化なし（false）", applyColorTile(buf, mask, ct) === false);

  // floodFillColorTile: 領域（同添字・4近傍）だけ／clip は壁／ref 参照
  const b2 = new Uint8Array(PIXELS) as IndexBuf; // 全部 0（透明）の領域
  for (let x = 0; x < W; x++) b2[50 * W + x] = 3; // y=50 に壁（添字3）
  const ok2 = floodFillColorTile(b2, 10, 10, ct);
  check("5: floodFillColorTile が塗った", ok2 === true);
  check("5: 壁の上側だけ（y<50 は柄・y>50 は 0 のまま）", b2[0] === 7 && b2[60 * W] === 0 && b2[50 * W + 10] === 3);
  // clip（選択範囲）は壁
  const b3 = new Uint8Array(PIXELS) as IndexBuf;
  const clip = rectMask(0, 0, 9, 9);
  floodFillColorTile(b3, 2, 2, ct, undefined, clip);
  check("5: clip 外は 1 ドットも変わらない", b3[0] === 7 && b3[10] === 0 && b3[10 * W] === 0);
  // ref 参照: 判定は ref・塗るのは buf
  const refBuf = new Uint8Array(PIXELS) as IndexBuf;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x >= 20) refBuf[y * W + x] = 9; // x>=20 は別添字
  const b4 = new Uint8Array(PIXELS) as IndexBuf;
  floodFillColorTile(b4, 0, 0, ct, refBuf);
  check("5: ref 参照＝ref の領域（x<20）だけ buf に塗る", b4[0] === 7 && b4[18] === 7 && b4[22] === 0);
}

// ================= 6. ★257 色目を跨ぐ順序（16bit 昇格） =================
{
  // 250 色を登録した 8bit プロジェクト → 10 色のマイ柄を「全色一括解決 → バッファ取得」で塗る
  const p = newProject("m17");
  for (let i = 0; p.colorTable.length < 250; i++) ensureColor(p, "#" + (0x100000 + i * 0x1010).toString(16).padStart(6, "0"));
  check("6(前提): 8bit・パレット 250 色（あと 6 で 256）", p.indexBits === 8 && p.colorTable.length === 250);
  const colors: string[] = [];
  for (let i = 0; i < 10; i++) colors.push("#" + (0x800000 + i * 0x0101).toString(16).padStart(6, "0")); // 未登録の 10 色
  const ct = { w: 10, h: 1, colors };
  const layerId = p.layerDefs[0].id;
  const stale = p.frames[0].layers[layerId]; // ★逆順（先にバッファを掴む）のシミュレーション
  // 正しい順序: 解決 → バッファ
  const tile = buildColorTile(ct, { resolve: (hex) => ensureColor(p, hex) });
  const fresh = p.frames[0].layers[layerId];
  check("6: 全色一括解決で 257 色目を跨ぎ 16bit へ昇格", p.indexBits === 16 && fresh instanceof Uint16Array);
  check("6: 昇格でバッファが差し替わる（先に掴んだ参照は死ぬ＝カナリア）", stale !== fresh && stale instanceof Uint8Array);
  check("6: 解決済み索引は 256 以上を含む（8bit では持てない値）", Array.from(tile.idx).some((v) => v >= 256));
  // 昇格後のバッファへ塗る → 索引が正しく載る（矩形マスクで 10×10 を全部）
  applyColorTile(fresh, rectMask(0, 0, 9, 9), tile);
  let okPaint = true;
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++) {
      const want = colorTileAt(tile, x, y);
      if (want >= 0 && fresh[y * W + x] !== want) okPaint = false;
    }
  check("6: 昇格後のバッファに全色が正しく載る（10色・索引一致）", okPaint);
  // stamp 経路も昇格後バッファに 256 以上の索引を書ける（Uint16）
  // タイル列 0〜5 は昇格前に 250〜255 を取り、列 6〜9 が 256〜259（昇格後）。列 8 の画素で確認
  stamp(fresh, 108, 100, { size: 5, color: 1, texture: "solid", seed: 0, colorTile: tile });
  check("6: stamp 経路でも昇格後バッファへ 256 以上の索引が載る", fresh[100 * W + 108] === colorTileAt(tile, 108, 100) && fresh[100 * W + 108] >= 256);
  // 逆順の実害: stale に書いても fresh には反映されない（＝見えない・履歴も狂う）
  stale[0] = 99;
  check("6: 古い参照へ書いても現在のバッファは変わらない（順序を守る理由）", fresh[0] !== 99);
  // 色→RGB の往復: 別パレットでも同じ RGB が出る（colorTable[idx] が登録 RGB）
  check("6: 解決先の colorTable が登録 RGB と一致（別パレットでも同色）", colors.every((hex, i) => p.colorTable[tile.idx[i]] === hex));
}

// ================= 7. sanitizeCustomTones =================
{
  check("7: 旧 settings（キー無し）→ []", sanitizeCustomTones(undefined).length === 0);
  check("7: 非配列 → []", sanitizeCustomTones({ a: 1 }).length === 0);
  const raw = [
    { id: 3, w: 2, h: 1, colors: ["#ff0000", ""] }, // OK
    { id: 3, w: 1, h: 1, colors: ["#00ff00"] }, // id 重複 → 振り直し
    { w: 1, h: 1, colors: ["#0000ff"] }, // id 無し → 振り直し
    { id: 9, w: 33, h: 1, colors: new Array(33).fill("#ff0000") }, // 33 は上限超 → 捨てる
    { id: 10, w: 1, h: 1, colors: [""] }, // 全透明 → 捨てる
    { id: 11, w: 2, h: 1, colors: ["#ff0000"] }, // 長さ不一致 → 捨てる
    { id: 12, w: 1, h: 1, colors: ["red"] }, // 色の形式が違う → 捨てる
    "junk",
  ];
  const out = sanitizeCustomTones(raw);
  check("7: 壊れた要素だけ捨てる（3個残る）", out.length === 3, `got ${out.length}`);
  check("7: id が重複しない", new Set(out.map((c) => c.id)).size === out.length);
  check("7: 先頭の id=3 は保持", out[0].id === 3 && out[0].colors[0] === "#ff0000");
  // 上限 12
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i, w: 1, h: 1, colors: ["#123456"] }));
  check("7: 上限 12 で切る", sanitizeCustomTones(many).length === CUSTOM_TONE_MAX_COUNT);
  // key 往復
  check("7: customToneKey/parse 往復", parseCustomToneKey(customToneKey(42)) === 42 && parseCustomToneKey("solid") === null && parseCustomToneKey("custom:x") === null);
  check("7: nextCustomToneId は最大+1（消しても詰めない）", nextCustomToneId([{ id: 0, w: 1, h: 1, colors: ["#000000"] }, { id: 7, w: 1, h: 1, colors: ["#000000"] }]) === 8 && nextCustomToneId([]) === 0);
}

console.log(`m17 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
