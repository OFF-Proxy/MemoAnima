// M3.3 ページ・クリップボード スモークテスト（純関数部・Node実行）
// AC-B-2/4/6/8 のデータ層検証: 単ページ内容一致・範囲順序・クロスメモ色再マップ（昇格込み）・レイヤー数差

import {
  newProject,
  ensureColor,
  PIXELS,
  newLayerId,
  makeEmptyFrame,
  DEFAULT_PALETTE,
} from "../src/editor/model";
import { compositeFrame } from "../src/editor/render";
import { makeClip, buildFramesFromClip } from "../src/editor/frameClip";
// M12-1c-2: 文言の pin が言語に左右されないよう ja に固定する（pin の文字列は変えていない）
import { setLang } from "../src/i18n";
setLang("ja");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}

// ---- AC-B-2/6: 同一構成メモ間の単ページ移送で見た目完全一致 ----
{
  const src = newProject("clip-src");
  const red = ensureColor(src, "#ff1717");
  const blue = ensureColor(src, "#06aeff");
  const [l1, l2, l3] = src.layerDefs.map((l) => l.id);
  const f = src.frames[0];
  for (let i = 0; i < 500; i++) f.layers[l1][i] = red;
  for (let i = 400; i < 900; i++) f.layers[l2][i] = blue;
  for (let i = 800; i < 1000; i++) f.layers[l3][i] = red;
  f.paper = ensureColor(src, "#ffe600");
  const srcPix = compositeFrame(src, 0).slice();

  const dst = newProject("clip-dst");
  const clip = makeClip(src, [0]);
  const [built] = buildFramesFromClip(dst, clip);
  dst.frames[0] = built;
  const dstPix = compositeFrame(dst, 0);
  let same = true;
  for (let i = 0; i < PIXELS; i++)
    if (srcPix[i] !== dstPix[i]) {
      same = false;
      break;
    }
  check("B-2/6 単ページ移送の見た目一致", same);
}

// ---- AC-B-6: 16bit(255超索引)メモ → 8bit新規メモへの貼り付けで色化けなし・必要昇格 ----
{
  const src = newProject("clip-16");
  for (let i = 0; i < 300; i++)
    ensureColor(src, `#${((i * 4093 + 0x202020) & 0xffffff).toString(16).padStart(6, "0")}`);
  check("B-6 前提: srcは16bit", src.indexBits === 16);
  const lid = src.layerDefs[2].id;
  const hi = src.colorTable.length - 1; // 255超の索引
  check("B-6 前提: 高索引>255", hi > 255);
  const f = src.frames[0];
  for (let i = 0; i < 200; i++) f.layers[lid][i] = hi;
  const srcPix = compositeFrame(src, 0).slice();

  const dst = newProject("clip-16-dst"); // 8bit・既定パレット（M11-14b で6色）
  const clip = makeClip(src, [0]);
  const [built] = buildFramesFromClip(dst, clip);
  dst.frames[0] = built;
  const dstPix = compositeFrame(dst, 0);
  let same = true;
  for (let i = 0; i < PIXELS; i++)
    if (srcPix[i] !== dstPix[i]) {
      same = false;
      break;
    }
  check("B-6 高索引の色再マップ一致（truncateなし）", same);
  // 使用色は1色だけ → 既定パレット＋透明＋1色 なので昇格しない（未使用色でパレットを汚さない）。
  // M11-14 で決め打ちの 16 をやめて相対で数える形にした（M11-14b で既定6色→期待値 8）
  const expectColors = DEFAULT_PALETTE.length + 2; // +透明 +貼り付けた1色
  check(
    "B-6 未使用色を持ち込まない",
    dst.indexBits === 8 && dst.colorTable.length === expectColors,
    `bits=${dst.indexBits} colors=${dst.colorTable.length}（期待 ${expectColors}）`
  );
}

// ---- 昇格が必要なケース: 250色使用クリップ → 既に250色ある8bitメモ ----
{
  const src = newProject("clip-many");
  const lid = src.layerDefs[0].id;
  const f = src.frames[0];
  for (let i = 0; i < 240; i++) {
    const c = ensureColor(src, `#${((i * 5077 + 0x101010) & 0xffffff).toString(16).padStart(6, "0")}`);
    f.layers[lid][i] = c;
  }
  const srcPix = compositeFrame(src, 0).slice();
  const dst = newProject("clip-many-dst");
  for (let i = 0; i < 230; i++)
    ensureColor(dst, `#${((i * 6553 + 0x303030) & 0xffffff).toString(16).padStart(6, "0")}`);
  check("前提: dstは8bitで240色級", dst.indexBits === 8);
  const [built] = buildFramesFromClip(dst, makeClip(src, [0]));
  dst.frames[0] = built;
  check("B-6 マージで16bit昇格", dst.indexBits === 16);
  const dstPix = compositeFrame(dst, 0);
  let same = true;
  for (let i = 0; i < PIXELS; i++)
    if (srcPix[i] !== dstPix[i]) {
      same = false;
      break;
    }
  check("B-6 昇格マージ後も見た目一致", same);
}

// ---- AC-B-4: 範囲コピーの順序保持 ----
{
  const src = newProject("clip-range");
  const lid = src.layerDefs[0].id;
  const black = ensureColor(src, "#141414");
  // コマ0..4 に「i番目のピクセルに印」を付ける
  for (let i = 1; i < 5; i++) src.frames.push(makeEmptyFrame(src, src.frames[0].paper));
  src.frames.forEach((f, i) => {
    f.layers[lid][i * 10] = black;
  });
  const clip = makeClip(src, [1, 2, 3]);
  const dst = newProject("clip-range-dst");
  const built = buildFramesFromClip(dst, clip);
  check("B-4 枚数一致", built.length === 3);
  const lidD = dst.layerDefs[0].id;
  const ok =
    built[0].layers[lidD][10] !== 0 &&
    built[1].layers[lidD][20] !== 0 &&
    built[2].layers[lidD][30] !== 0 &&
    built[0].layers[lidD][20] === 0;
  check("B-4 範囲の順序保持", ok);
}

// ---- AC-B-8: レイヤー数差（クリップ5層 → 3層メモ: 余剰を最上位へ焼き込み） ----
{
  const src = newProject("clip-5layer");
  // 2層追加して5層に
  for (let k = 0; k < 2; k++) {
    const id = newLayerId(src);
    src.layerDefs.push({ id, name: `追加${k}`, visible: true, opacity: 1 });
    for (const f of src.frames) f.layers[id] = new Uint8Array(PIXELS);
  }
  const ids = src.layerDefs.map((l) => l.id);
  const g = ensureColor(src, "#008232");
  const r = ensureColor(src, "#ff1717");
  const f = src.frames[0];
  f.layers[ids[3]][100] = g; // 4層目
  f.layers[ids[4]][200] = r; // 5層目（最上位）
  const dst = newProject("clip-3layer"); // 3層
  const [built] = buildFramesFromClip(dst, makeClip(src, [0]));
  const topId = dst.layerDefs[dst.layerDefs.length - 1].id;
  const gD = dst.colorTable.indexOf("#008232");
  const rD = dst.colorTable.indexOf("#ff1717");
  check(
    "B-8 余剰レイヤーの内容が最上位へ",
    built.layers[topId][100] === gD && built.layers[topId][200] === rD,
    `got ${built.layers[topId][100]},${built.layers[topId][200]} want ${gD},${rD}`
  );
}

// ---- クリップの独立性（コピー後に元を編集してもクリップ不変） ----
{
  const src = newProject("clip-indep");
  const lid = src.layerDefs[0].id;
  const black = ensureColor(src, "#141414");
  src.frames[0].layers[lid][0] = black;
  const clip = makeClip(src, [0]);
  src.frames[0].layers[lid][0] = 0; // 元を消す
  check("独立性: クリップは元編集の影響を受けない", clip.frames[0].layers[0][0] !== 0);
}

// ---- M11-16: 透明の紙（paper=0）はページ・クリップを通っても透明のまま（白に化けない・色を登録しない） ----
{
  const src = newProject("clip-tp");
  const lid = src.layerDefs[0].id;
  const black = ensureColor(src, "#141414");
  for (let i = 0; i < 100; i++) src.frames[0].layers[lid][i] = black;
  src.frames[0].paper = 0;
  const clip = makeClip(src, [0]);
  check("M11-16 クリップは透明の紙を \"\" で持つ", clip.frames[0].paperHex === "");
  const dst = newProject("clip-tp-dst");
  const colorsBefore = dst.colorTable.length;
  const [built] = buildFramesFromClip(dst, clip);
  check("M11-16 貼り付け先でも paper=0（白に化けない）", built.paper === 0, `paper=${built.paper}`);
  check(
    "M11-16 透明の紙は色を登録しない（黒だけ増える or 既存）",
    dst.colorTable.length <= colorsBefore + 1,
    `${colorsBefore} → ${dst.colorTable.length}`
  );
  dst.frames[0] = built;
  const pix = compositeFrame(dst, 0);
  let alpha0 = 0;
  for (let i = 0; i < PIXELS; i++) if ((pix[i] >>> 24) === 0) alpha0++;
  check("M11-16 合成の紙部分は alpha=0", alpha0 === PIXELS - 100, `alpha0=${alpha0}`);
  // 実色の紙は従来どおり再マップされる
  src.frames[0].paper = ensureColor(src, "#ffe600");
  const clip2 = makeClip(src, [0]);
  const [built2] = buildFramesFromClip(dst, clip2);
  check("M11-16 実色の紙は従来どおり", dst.colorTable[built2.paper] === "#ffe600");
}
console.log(`m33 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
