// V164（見つかる・選べるの回）の回帰ゲート。引数不要:
//   npx tsx scripts/v164_smoke.ts
//
// ★この回でいちばん怖いのは3つ:
//   ① 既定の絵が変わること（4件とも「増えるだけ」が要件）→ 検査1 で**画素の一致**を固定
//   ② 向きが効かない／逆に効くこと → 検査2 で「前だけ」に後ろの残像が1画素も無いことを実証
//   ③ 壊れた settings で落ちること → 検査3・4 で既定へ倒れることを固定
//
// 1. 既定の絵: onionDir を渡さない＝"both"＝**v1.6.0 と1画素も違わない**
// 2. 向き: prev/next が「片側だけ」を通す（反証つき＝反対側の絵と混ざっていない）
// 3. オニオンの設定の丸め（範囲外・型違い・未設定は既定へ）
// 4. よく使う色の棚の丸め（壊れた要素だけ落ちる・重複・上限48）
// 5. コマN枚の丸め（空欄・0・負数・小数・1000・上限際）
// 6. 配線の走査（置き場所・保存の流儀・眠りを起こしていないこと）
import fs from "node:fs";
import path from "node:path";
import {
  newProject,
  makeEmptyFrame,
  allocIndexBuf,
  PIXELS,
  type Project,
} from "../src/editor/model";
import { compositeFrame } from "../src/editor/render";
import {
  sanitizeOnionLevel,
  sanitizeOnionDir,
  sanitizeFavoriteColors,
  normalizeFavColor,
  FAVORITE_COLORS_MAX,
  ADD_FRAMES_MAX,
  clampAddFrames,
} from "../src/editor/prefs";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}

const root = path.resolve(import.meta.dirname, "..");

const same = (a: Uint32Array, b: Uint32Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const diffCount = (a: Uint32Array, b: Uint32Array) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

/** 3コマの作品。真ん中(1)を見ている想定で、0 と 2 に**別々の絵**を置く */
function make3(): Project {
  const p = newProject("V164");
  p.frames = [];
  for (let i = 0; i < 3; i++) {
    const f = makeEmptyFrame(p, 1); // paper=1（既定パレットの先頭色）
    p.frames.push(f);
  }
  const id = p.layerDefs[0].id;
  // コマ0（前）: 左半分に色2 ／ コマ2（次）: 右半分に色3 ／ コマ1（現在）: 空
  for (let y = 0; y < 240; y++) {
    for (let x = 0; x < 160; x++) p.frames[0].layers[id][y * 320 + x] = 2;
    for (let x = 160; x < 320; x++) p.frames[2].layers[id][y * 320 + x] = 3;
  }
  return p;
}

// ================= 1. 既定の絵が変わらない（★最重要） =================
{
  const p = make3();
  for (const onion of [0, 1, 2, 3]) {
    const legacy = compositeFrame(p, 1, undefined, { onion }); // 向きを**渡さない**＝旧呼び出し
    const both = compositeFrame(p, 1, undefined, { onion, onionDir: "both" });
    check(`1 ★onionDir 未指定 ＝ "both"（段数${onion}・v1.6.0 と同じ絵）`, same(legacy, both));
  }
  // オニオン0（切）はどの向きでも同じ絵（向きは段数が0なら効かない＝再生中の挙動の前提）
  const off = compositeFrame(p, 1, undefined, { onion: 0 });
  for (const dir of ["prev", "both", "next"] as const)
    check(`1 段数0（切）は向き "${dir}" でも同じ絵`, same(off, compositeFrame(p, 1, undefined, { onion: 0, onionDir: dir })));
}

// ================= 2. 向きが効く（★反証つき） =================
{
  const p = make3();
  const both = compositeFrame(p, 1, undefined, { onion: 1, onionDir: "both" });
  const prev = compositeFrame(p, 1, undefined, { onion: 1, onionDir: "prev" });
  const next = compositeFrame(p, 1, undefined, { onion: 1, onionDir: "next" });
  const none = compositeFrame(p, 1, undefined, { onion: 0 });

  // ★「前だけ」＝**次のコマが無いのと同じ絵**（後ろの残像が1画素も出ない）。
  //  次のコマを空にした作品で同じ段数を描いたものと突き合わせる＝直接の証明
  const pNoNext = make3();
  pNoNext.frames[2].layers[pNoNext.layerDefs[0].id] = allocIndexBuf(pNoNext); // 次コマを空に
  const prevRef = compositeFrame(pNoNext, 1, undefined, { onion: 1, onionDir: "both" });
  check("2 ★「前のコマ」で次コマの残像が1画素も出ない", same(prev, prevRef), `${diffCount(prev, prevRef)} 画素`);

  const pNoPrev = make3();
  pNoPrev.frames[0].layers[pNoPrev.layerDefs[0].id] = allocIndexBuf(pNoPrev); // 前コマを空に
  const nextRef = compositeFrame(pNoPrev, 1, undefined, { onion: 1, onionDir: "both" });
  check("2 ★「次のコマ」で前コマの残像が1画素も出ない", same(next, nextRef), `${diffCount(next, nextRef)} 画素`);

  // 反証: 3つの向きは互いに**別の絵**（＝そもそも向きが効いている。全部同じなら上の一致は無意味）
  check("2 反証: prev と next は別の絵", !same(prev, next));
  check("2 反証: prev と both は別の絵", !same(prev, both));
  check("2 反証: next と both は別の絵", !same(next, both));
  check("2 反証: どの向きもオニオン切とは別の絵", !same(prev, none) && !same(next, none) && !same(both, none));
  // 左半分＝前コマの絵・右半分＝次コマの絵。向きごとにどちら側が変わるかを画素で確かめる
  const half = (buf: Uint32Array, side: "L" | "R") => {
    let n = 0;
    for (let y = 0; y < 240; y++)
      for (let x = side === "L" ? 0 : 160; x < (side === "L" ? 160 : 320); x++)
        if (buf[y * 320 + x] !== none[y * 320 + x]) n++;
    return n;
  };
  check("2 「前のコマ」は左半分だけが変わる", half(prev, "L") > 0 && half(prev, "R") === 0, `L=${half(prev, "L")} R=${half(prev, "R")}`);
  check("2 「次のコマ」は右半分だけが変わる", half(next, "R") > 0 && half(next, "L") === 0, `L=${half(next, "L")} R=${half(next, "R")}`);
  check("2 「両方」は左右とも変わる", half(both, "L") > 0 && half(both, "R") > 0);
  // 端のコマ（前が無い・次が無い）でも落ちない
  check("2 先頭コマで「前のコマ」は素の絵と同じ", same(compositeFrame(p, 0, undefined, { onion: 3, onionDir: "prev" }), compositeFrame(p, 0, undefined, { onion: 0 })));
  check("2 最終コマで「次のコマ」は素の絵と同じ", same(compositeFrame(p, 2, undefined, { onion: 3, onionDir: "next" }), compositeFrame(p, 2, undefined, { onion: 0 })));
}

// ================= 3. オニオンの設定の丸め（壊れた settings で既定へ） =================
{
  for (const [v, want] of [[0, 0], [1, 1], [3, 3], [4, 0], [-1, 0], [1.5, 0], ["2", 0], [null, 0], [undefined, 0], [NaN, 0]] as const)
    check(`3 段数 ${JSON.stringify(v)} → ${want}`, sanitizeOnionLevel(v) === want);
  for (const [v, want] of [["prev", "prev"], ["next", "next"], ["both", "both"], ["Prev", "both"], ["", "both"], [0, "both"], [null, "both"], [undefined, "both"], [{}, "both"]] as const)
    check(`3 向き ${JSON.stringify(v)} → ${want}`, sanitizeOnionDir(v) === want);
}

// ================= 4. よく使う色の棚の丸め =================
{
  check("4 配列でない → []", sanitizeFavoriteColors("#ff0000").length === 0 && sanitizeFavoriteColors(null).length === 0 && sanitizeFavoriteColors({ 0: "#ff0000" }).length === 0);
  check("4 未設定 → []", sanitizeFavoriteColors(undefined).length === 0);
  // ★壊れた要素**だけ**落ちて、正しい要素は残る（全部捨てない＝設定破損で挙動を変えない）
  const mixed = sanitizeFavoriteColors(["#ff0000", "red", 123, null, "#GGGGGG", "#00ff00", "#abc", { hex: "#0000ff" }, "#0000FF"]);
  check("4 ★壊れた要素だけ落ちる", mixed.join(",") === "#ff0000,#00ff00,#0000ff", mixed.join(","));
  check("4 大文字は小文字へ寄る（二重に並ばない）", sanitizeFavoriteColors(["#AABBCC", "#aabbcc"]).length === 1);
  const many = sanitizeFavoriteColors(
    Array.from({ length: FAVORITE_COLORS_MAX + 20 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`)
  );
  check(`4 上限 ${FAVORITE_COLORS_MAX} で打ち切る`, many.length === FAVORITE_COLORS_MAX);
  check("4 上限ちょうどは全部残る", sanitizeFavoriteColors(many).length === FAVORITE_COLORS_MAX);
  // 色1つの丸め（透明＝"" は棚に入れられない）
  check("4 透明（\"\"）は棚に入れられない", normalizeFavColor("") === null);
  check("4 #RRGGBB だけ通る", normalizeFavColor("#Ff00aB") === "#ff00ab" && normalizeFavColor("#f00") === null && normalizeFavColor(12) === null);
}

// ================= 5. コマN枚の丸め（誤爆しない） =================
{
  const c = (want: unknown, total = 10) => clampAddFrames(want, total);
  check("5 ふつうの入力はそのまま", c(5).n === 5 && !c(5).clamped);
  check("5 空欄・NaN・文字は1枚", c("").n === 1 && c(NaN).n === 1 && c("abc").n === 1);
  check("5 0・負数は1枚", c(0).n === 1 && c(-99).n === 1);
  check("5 小数は切り捨て", c(3.9).n === 3);
  check(`5 ★1000 と打っても上限 ${ADD_FRAMES_MAX} 枚まで`, c(1000).n === ADD_FRAMES_MAX);
  check(`5 上限ちょうどは clamped にしない`, c(ADD_FRAMES_MAX).n === ADD_FRAMES_MAX && !c(ADD_FRAMES_MAX).clamped);
  // ★65,535 の際で止まって「知らせる」ための clamped
  check("5 ★作品の上限際は入るぶんだけ＋clamped", c(50, 65500).n === 35 && c(50, 65500).clamped);
  check("5 ★上限に達していたら 0 枚（呼ぶ側が上限のトーストを出す）", c(5, 65535).n === 0 && c(5, 65535).clamped);
  check("5 上限を1枚だけ超える要求", c(2, 65534).n === 1 && c(2, 65534).clamped);
  // Codex V164 指摘②: `clamped` は**作品の上限（65,535）に当たったときだけ**。
  // 1回の上限（100）への丸めは小窓が先に見せるので、ここでは false（契約を検査で固定する）
  check("5 ★clamped は 65,535 に当たったときだけ（100 への丸めでは立たない）", !c(1000).clamped && c(1000).n === ADD_FRAMES_MAX);
}

// ================= 6. 配線の走査 =================
{
  const ed = fs.readFileSync(path.join(root, "src/editor/editor.ts"), "utf8");
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const render = fs.readFileSync(path.join(root, "src/editor/render.ts"), "utf8");

  // U-2: ★オニオンが上段の**先頭付近**（道具オプションの直後）にある＝スクロールせずに見える。
  // 「太さ」「色」より前に来ていることをテンプレートの並びで固定する
  const iTool = ed.indexOf('<div id="ed-toolopts"></div>');
  const iOnion = ed.indexOf('<div class="oni" id="ed-onion">');
  const iSize = ed.indexOf('<div class="sizes" id="ed-sizes">');
  const iPal = ed.indexOf('<div class="pal" id="ed-pal">');
  check("6 ★オニオンが道具オプションの直後（上段の先頭付近）", iTool >= 0 && iOnion > iTool && iOnion < iSize, `tool=${iTool} onion=${iOnion} size=${iSize}`);
  check("6 ★オニオンが「太さ」「色」より前にある", iOnion < iSize && iOnion < iPal);
  check("6 向きの帯がオニオンの隣にある", ed.indexOf('id="ed-oniondir"') > iOnion);
  // V158 の記述ミス（「ここまでが上段」）が直っている
  check("6 V158 の誤ったコメントが残っていない", !ed.includes("ここまでが上段（道具）。以降が下段（レイヤー）"));
  // V158 の骨格（上段＝道具／下段＝レイヤー常設）は維持
  check("6 2段の骨格は維持（ed-side-top / ed-side-bot）", ed.includes('id="ed-side-top"') && ed.includes('id="ed-side-bot"') && ed.includes('id="ed-layers"'));

  // U-1: 描画は向きで行を通すだけ・色と再生中の挙動は不変
  check("6 render が向きで前後の行を分ける", /wantPrev && frameIndex - k >= 0/.test(render) && /wantNext && frameIndex \+ k < p\.frames\.length/.test(render));
  check("6 オニオンの色は現行のまま（前=赤 0xff3b3b / 後=青 0x1fa2ff）", /0xff, 0x3b, 0x3b/.test(render) && /0x1f, 0xa2, 0xff/.test(render));
  check("6 再生中はオニオンを描かない（this.playing ? 0 :）", /onion: this\.playing \? 0 : this\.onionLevel/.test(ed));

  // U-1/U-3: 設定に保存する流儀（変えた瞬間に保存・作品には入れない）
  check("6 オニオンは settings へ（onOnionChange）", /onOnionChange\?\.\(this\.onionLevel, this\.onionDir\)/.test(ed) && /settings\.onionLevel = level;/.test(main) && /settings\.onionDir = dir;/.test(main));
  check("6 色の棚は settings へ（onFavoriteColorsChange）", /onFavoriteColorsChange\?\.\(\[\.\.\.this\.favoriteColors\]\)/.test(ed) && /settings\.favoriteColors = list;/.test(main));
  check("6 起動時に復元する（restoreOnion / restoreFavoriteColors）", /editor\.restoreOnion\(settings\.onionLevel, settings\.onionDir\)/.test(main) && /editor\.restoreFavoriteColors\(settings\.favoriteColors\)/.test(main));
  check("6 既存パレット帯（#ed-pal）は残っている", /id="ed-pal"/.test(ed) && /rebuildPalette\(\)/.test(ed));
  check("6 色の棚は別の帯（#ed-favpal・登録ボタン）", /id="ed-favpal"/.test(ed) && /id="ed-fav-toggle"/.test(ed));

  // U-4: 履歴1エントリ・既定の「＋ ついか」は1枚のまま
  check("6 ★まとめて追加は履歴1エントリ（bytesIfUndone は合計）", /label: duplicate \? "コマ複製（まとめて）" : "コマ追加（まとめて）",[\s\S]{0,80}?bytesIfUndone: entryBytes\(added\)/.test(ed));
  // V166: 漏斗を通したので `addFrame` が async になり、呼び出しに `void` が付いた。
  // この検査が見張りたいのは**「＋ ついか」が1枚の道（addFrame）を呼ぶこと**——
  // まとめて追加（`addFrames`）に化けていないこと——なので、`void` は許して中身を固定する
  check("6 「＋ ついか」は1枚のまま（addFrame(false)）", /#ed-addframe"\)\.addEventListener\("click", \(\) => (?:void )?this\.addFrame\(false\)\)/.test(ed));
  check("6 まとめて追加はボタン→小窓（隠し操作ではない）", /id="ed-addframes"/.test(ed) && /onAddFramesClick/.test(ed));
  check("6 2,000 コマ超の注意はそのまま通る", /ed\.common\.manyFrames\.toast/.test(ed));
  check("6 65,535 の上限のトーストを通る", /ed\.tl\.addFrame\.limit\.toast/.test(ed));
  check("6 ダイアログの閉じ手を unmount で畳む", /this\.addFramesDialogClose\?\.\(\)/.test(ed));
  // Codex V164 指摘①: 取り消したら**押す前のコマ**へ戻る（追加後の位置＝最大100コマ先に居座らない）
  check(
    "6 ★取り消しで押す前のコマへ戻る（beforeIndex を覚えている）",
    /const beforeIndex = this\.frameIndex;/.test(ed) &&
      /self\.frameIndex = Math\.max\(0, Math\.min\(beforeIndex, self\.project\.frames\.length - 1\)\)/.test(ed)
  );
  // Codex V164 指摘②: 上限への丸めを**押す前に**入力欄で見せる
  check("6 ★枚数の入力欄が確定時に 1〜上限へ丸まる", /input\.addEventListener\("change"[\s\S]{0,260}?Math\.max\(1, Math\.min\(max, raw\)\)/.test(ed));
  // Codex V164 指摘③: en/es/pt-BR の「1 frames」を避ける（数を末尾に置く形）
  for (const lang of ["en", "es", "pt-BR"] as const) {
    const dict = fs.readFileSync(path.join(root, `src/i18n/${lang}.ts`), "utf8");
    const m = dict.match(/"ed\.tl\.addFrames\.done\.toast": "([^"]*)"/);
    check(`6 ${lang} の追加トーストが単複に引きずられない`, !!m && /: \{count\}$/.test(m[1]), m?.[1] ?? "見つからない");
  }

  // ★V156 の眠り: 表示だけの回なので**起こす経路を足していない**
  const v164Wake = /addFrames\([\s\S]{0,2000}?(wakeFrame|wakeLayersAllFrames)\(/.test(ed);
  check("6 ★まとめて追加は眠りコマを起こさない", !v164Wake);
  check("6 ★色の棚・オニオンも眠りに触れない", !/rebuildFavPalette\(\)[\s\S]{0,1200}?wakeFrame\(/.test(ed));
}

console.log(`v164 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
