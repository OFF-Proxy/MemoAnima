// M12-1a: i18n の機械チェック（引数不要:  npx tsx scripts/m1201_i18n_check.ts）
//
// 設計は docs/REQ_M12_i18n_master.md §3-f。この回（M12-1a）で有効にするのは 3/4/5 で、
// 1（キー集合の一致）と 2（プレースホルダの一致）は **枠だけ作って M12-2 で有効化**する
// （いまは en.ts が空なので、比較しても全キーが「未訳」になるだけで意味がない）。
//
//   1. キー集合の一致（5言語）        … 枠のみ・en が空でないときだけ実行
//   2. プレースホルダ {..} の一致      … 枠のみ（同上）
//   3. 文字数の上限 × 言語別係数        … **ja で有効**。超過は警告一覧。`.modal` 系だけエラー
//   4. 未使用キーの検出                 … **有効**（削除はしない・一覧のみ）
//   5. ハードコード残りの検出           … **有効**（対象は index.html と src/main.ts のみ）
import { readFileSync } from "node:fs";
import ts from "typescript";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p: string) => readFileSync(`${REPO}/${p}`, "utf8");

let pass = 0;
let fail = 0;
const warnings: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? ` ${detail}` : ""}`);
  }
}

// ---------------- 対象ファイル ----------------
const mainSrc = read("src/main.ts");
const htmlSrc = read("index.html");
const editorSrc = read("src/editor/editor.ts"); // M12-1b から検査対象
const jaSrc = read("src/i18n/ja.ts");

/** キー化を終えたファイル。**ここに足すと検査4・5・6・7 の対象になる**。
 *  M12-1c-2 で残り全部を足した＝**フロントの日本語はこの一覧と main.ts / editor.ts / index.html に閉じている**。
 *  新しくファイルを作って画面に文字を出すときは、ここへ足すこと（足さないと検査が沈黙する）。 */
const KEYED_FILES: readonly (readonly [string, string])[] = [
  // M12-1c-1
  ["src/library.ts", read("src/library.ts")],
  ["src/guide.ts", read("src/guide.ts")],
  ["src/keymap.ts", read("src/keymap.ts")],
  // M12-1c-2
  ["src/i18n/defaults.ts", read("src/i18n/defaults.ts")],
  ["src/editor/raster.ts", read("src/editor/raster.ts")],
  ["src/editor/exporter.ts", read("src/editor/exporter.ts")],
  ["src/editor/audio.ts", read("src/editor/audio.ts")],
  ["src/editor/model.ts", read("src/editor/model.ts")],
  ["src/editor/serialize.ts", read("src/editor/serialize.ts")],
  ["src/editor/kwzImport.ts", read("src/editor/kwzImport.ts")],
  ["src/editor/frameClip.ts", read("src/editor/frameClip.ts")],
  ["src/editor/wobble.ts", read("src/editor/wobble.ts")],
  ["src/editor/imageConvert.ts", read("src/editor/imageConvert.ts")],
  ["src/editor/layerTree.ts", read("src/editor/layerTree.ts")],
  ["src/editor/warp.ts", read("src/editor/warp.ts")],
  ["src/editor/render.ts", read("src/editor/render.ts")],
  ["src/editor/history.ts", read("src/editor/history.ts")],
  ["src/editor/fonts.ts", read("src/editor/fonts.ts")],
  ["src/ui/slider.ts", read("src/ui/slider.ts")],
  // M12-C: 新しく作ったファイルは**ここへ足さないと検査が沈黙する**（M12-1b-2 で踏んだ穴）。
  // 中身は純関数だけで画面文言は持たないが、後から足されたときに気づけるように載せておく
  ["src/editor/cursor.ts", read("src/editor/cursor.ts")],
];

/** 検査4・6・7 が舐めるソース一式（main / editor ＋ キー化済みファイル） */
const SCANNED: readonly (readonly [string, string])[] = [
  ["src/main.ts", mainSrc],
  ["src/editor/editor.ts", editorSrc],
  ...KEYED_FILES,
];

/** ja.ts の "キー": "値" を読む（辞書は素直な1行1エントリで書く決まり） */
function parseDict(src: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of src.matchAll(/^\s*"([^"]+)":\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)) {
    m.set(r[1], JSON.parse(r[2]) as string);
  }
  return m;
}
const ja = parseDict(jaSrc);
check("ja.ts が読める（1行1エントリ）", ja.size > 100, `${ja.size} キー`);

// M12-3: 5言語ぶん読む。検査1・2（キー集合／プレースホルダ）と検査3（言語別の字数）で使う。
// ブロックの外に出しておく（下の検査3 から見えるように）
const TRANSLATIONS: readonly (readonly [string, string])[] = [
  ["en", "src/i18n/en.ts"],
  ["es", "src/i18n/es.ts"],
  ["pt-BR", "src/i18n/pt-BR.ts"],
  ["ko", "src/i18n/ko.ts"],
];
const DICTS_BY_LANG = new Map<string, Map<string, string>>(
  TRANSLATIONS.map(([lang, path]) => [lang, parseDict(read(path))])
);
const en = DICTS_BY_LANG.get("en")!;

// ---------------- 1・2: 各言語と ja の突き合わせ（M12-2 で en・M12-3 で5言語） ----------------
{
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
  const missingLangs: string[] = [];
  const badPh: string[] = [];
  for (const [lang] of TRANSLATIONS) {
    const d = DICTS_BY_LANG.get(lang)!;
    if (d.size === 0) {
      console.log(`… 検査1・2 は ${lang}.ts が空のため skip`);
      continue;
    }
    const missing = [...ja.keys()].filter((k) => !d.has(k) && !k.endsWith("_one"));
    const extra = [...d.keys()].filter((k) => !ja.has(k));
    if (missing.length || extra.length) missingLangs.push(`${lang}(不足${missing.length}/余分${extra.length})`);
    const bad = [...d.entries()].filter(([k, v]) => ja.has(k) && ph(v) !== ph(ja.get(k)!));
    if (bad.length) badPh.push(`${lang}: ${bad.map(([k]) => k).join(" ")}`);
  }
  check(
    `検査1: 全言語のキー集合が ja と一致（${TRANSLATIONS.map(([l]) => l).join(" / ")}）`,
    missingLangs.length === 0,
    missingLangs.join(" ")
  );
  check("検査2: 全言語のプレースホルダの集合が ja と一致", badPh.length === 0, badPh.join(" / "));
}

// ---------------- 3: 文字数の上限（ja）＝ベースライン方式（M12-1b） ----------------
// 上限は docs/UI_TEXT_guide.md の決まり4 のまま**緩めない**。
// 緩めると「不要な文字が多い・ツールとしてのかっこ悪さ」への歯止め（M11-24 で作者から出た指摘）が
// 実装に引きずられて意味を失う。代わりに:
//   - キー化で辞書へ移した**既存の文言**の超過は「既知の例外」として下の OVER_BASELINE に固定する
//     （＝直す候補であって許可ではない。M12-2 の訳文で見直す）
//   - **ベースラインに無いキーが超過したらエラー**。＝これから足す文言は指針を守らないと落ちる
const LIMIT: Record<string, number> = { btn: 12, label: 16, hint: 30, title: 60, msg: 120, toast: 60, placeholder: 16 };

/** 個別の上限（短くできない性質のもの）。ベースラインと違い「この長さは妥当」という意味 */
const LIMIT_OVERRIDE: Record<string, number> = {
  "ed.spec.label": 46, // エディタ上部の仕様1行（320×240 …）。仕様なので削れない
  "set.legal.scope.msg": 163, // 法務文（非営利・非公式の説明）
  "set.legal.license.msg": 135, // 法務文（GPL の入手先）
};

/**
 * 既知の超過（＝キー化した時点で既に画面に出ていた文言）。
 * **増やすときは「既存の日本語を辞書へ移した」場合だけ**。新しく書いた文言は入れないこと。
 */
/**
 * M12-2: en の既知超過（＝字数の目安は超えるが、**英語の実画面で収まっていることを確かめた**もの）。
 *
 * 作った順番が大事: 先にベースラインを作ると「入っているから良し」になって、見ないまま通ってしまう。
 * ここは **23（エディタ）＋28（ホーム）＋11（補足）カットを ja/en で撮り、
 * 「辞書の文字がはみ出す」件数が 0 件**であることを確認したあとに固定した。
 *
 * 増やすときも同じ順番で（実画面 → 収まらないものは訳を短く → 残りだけここへ）。
 */
/**
 * M12-3: es / pt-BR / ko の既知超過。**es → pt-BR → ko の順に実画面を見てから**登録した
 * （es が最長＝中央値 ja の 2.1 倍・英語より2割長い。そこで収まれば下2つはほぼ通る）。
 *
 * en と同じ順番を踏んでいる: 23（エディタ）＋28（ホーム）カットを3言語で撮り直し、
 * さらに **M12-2 で「OS のファイル選択のせいで測れない」と書いた面**（エディタ📷／ライブラリ📷／
 * ドロップ受け取り／取り込み進捗モーダル／SD 取り込みのフッタ／ライブラリ消失の空状態）を
 * DEV フックと MutationObserver で開いて測り直した。**どの言語でもはみ出し 0 件**。
 * それを確かめたあとで、字数の目安だけを超えているものをここへ載せている。
 */
const OVER_BASELINE_ES = new Set<string>([
  // --- ホーム・取り込み（3 件） ---
  "imp.cancelling.label", // 37字 / 上限 33
  "lib.missing.hint", // 67字 / 上限 63
  "lib.import.progress.label", // 42字 / 上限 33
  // --- ショートカット設定（10 件） ---
  "keys.assign.hint", // 76字 / 上限 63
  "keys.preset.builtin.hint", // 88字 / 上限 63
  "keys.row.sharedMates.label", // 58字 / 上限 33
  "keys.toolCycle.hint", // 75字 / 上限 63
  "keys.toolCycle.title", // 146字 / 上限 126
  "keys.cmd.editThicken.hint", // 100字 / 上限 63
  "keys.cmd.editThin.hint", // 100字 / 上限 63
  "keys.cmd.layerPasteAll.label", // 39字 / 上限 33
  "keys.cmd.viewMiniToggle.hint", // 149字 / 上限 63
  "keys.cmd.viewFocusToggle.hint", // 145字 / 上限 63
  // --- 書き出し（3 件） ---
  "export.image.jpegNoAlpha.hint", // 74字 / 上限 63
  "export.whiteBg.hint", // 71字 / 上限 63
  "export.phase.encoderInit.label", // 46字 / 上限 33
  // --- 設定・法的表記（1 件） ---
  "set.legal.scope.msg", // 396字 / 上限 342
  // --- エディタ（12 件） ---
  "ed.audio.load.btn", // 29字 / 上限 25
  "ed.audio.se.add.btn", // 29字 / 上限 25
  "ed.audio.status.kwz.label", // 39字 / 上限 33
  "ed.audio.status.replacedName.label", // 37字 / 上限 33
  "ed.audio.wave.info.label", // 65字 / 上限 33
  "ed.xform.badge.label", // 44字 / 上限 33
  "ed.xform.head.label", // 39字 / 上限 33
  "ed.sel.auto.hint", // 75字 / 上限 63
  "ed.sel.drag.hint", // 71字 / 上限 63
  "ed.warp.bulgeHint.hint", // 66字 / 上限 63
  "ed.warp.cornerHint.hint", // 65字 / 上限 63
  "ed.warp.pushHint.hint", // 84字 / 上限 63
]);

const OVER_BASELINE_PT = new Set<string>([
  // --- ホーム・取り込み（3 件） ---
  "imp.cancelling.label", // 34字 / 上限 32
  "lib.missing.hint", // 64字 / 上限 60
  "lib.import.progress.label", // 41字 / 上限 32
  // --- ショートカット設定（10 件） ---
  "keys.assign.hint", // 84字 / 上限 60
  "keys.preset.builtin.hint", // 92字 / 上限 60
  "keys.row.sharedMates.label", // 59字 / 上限 32
  "keys.toolCycle.hint", // 73字 / 上限 60
  "keys.toolCycle.title", // 140字 / 上限 120
  "keys.cmd.editThicken.hint", // 89字 / 上限 60
  "keys.cmd.editThin.hint", // 89字 / 上限 60
  "keys.cmd.layerPasteAll.label", // 36字 / 上限 32
  "keys.cmd.viewMiniToggle.hint", // 138字 / 上限 60
  "keys.cmd.viewFocusToggle.hint", // 131字 / 上限 60
  // --- 書き出し（3 件） ---
  "export.image.jpegNoAlpha.hint", // 66字 / 上限 60
  "export.whiteBg.hint", // 87字 / 上限 60
  "export.phase.encoderInit.label", // 42字 / 上限 32
  // --- 設定・法的表記（1 件） ---
  "set.legal.scope.msg", // 384字 / 上限 326
  // --- エディタ（9 件） ---
  "ed.audio.status.kwz.label", // 35字 / 上限 32
  "ed.audio.status.replacedName.label", // 37字 / 上限 32
  "ed.audio.wave.info.label", // 61字 / 上限 32
  "ed.xform.badge.label", // 44字 / 上限 32
  "ed.sel.auto.hint", // 72字 / 上限 60
  "ed.sel.drag.hint", // 67字 / 上限 60
  "ed.warp.bulgeHint.hint", // 69字 / 上限 60
  "ed.warp.pinchHint.hint", // 63字 / 上限 60
  "ed.warp.pushHint.hint", // 70字 / 上限 60
]);

const OVER_BASELINE_KO = new Set<string>([
  // --- ホーム・取り込み（9 件） ---
  "common.saveTarget.path.hint", // 37字 / 上限 33
  "guide.welcome.label", // 18字 / 上限 17
  "imp.cancelling.label", // 19字 / 上限 17
  "imp.progress.hint", // 38字 / 上限 33
  "lib.firstRun.label", // 18字 / 上限 17
  "lib.import.btn", // 19字 / 上限 13
  "lib.missing.hint", // 34字 / 上限 33
  "lib.import.progress.label", // 33字 / 上限 17
  "lib.openFile.filter.label", // 21字 / 上限 17
  // --- ショートカット設定（9 件） ---
  "keys.assign.hint", // 38字 / 上限 33
  "keys.preset.builtin.hint", // 43字 / 上限 33
  "keys.row.sharedMates.label", // 29字 / 上限 17
  "keys.toolCycle.title", // 67字 / 上限 66
  "keys.cmd.editThicken.hint", // 43字 / 上限 33
  "keys.cmd.editThin.hint", // 43字 / 上限 33
  "keys.cmd.layerPasteAll.label", // 19字 / 上限 17
  "keys.cmd.viewMiniToggle.hint", // 60字 / 上限 33
  "keys.cmd.viewFocusToggle.hint", // 61字 / 上限 33
  // --- 書き出し（1 件） ---
  "export.whiteBg.hint", // 36字 / 上限 33
  // --- 画像取り込み（1 件） ---
  "img.dialog.target.hint", // 34字 / 上限 33
  // --- 設定・法的表記（2 件） ---
  "set.legal.license.msg", // 157字 / 上限 148
  "set.legal.scope.msg", // 200字 / 上限 179
  // --- エディタ（14 件） ---
  "ed.audio.se.add.btn", // 17字 / 上限 13
  "ed.audio.status.kwz.label", // 28字 / 上限 17
  "ed.audio.status.replaced.label", // 21字 / 上限 17
  "ed.audio.status.replacedName.label", // 29字 / 上限 17
  "ed.audio.wave.info.label", // 50字 / 上限 17
  "ed.spec.label", // 51字 / 上限 50
  "ed.view.badge.label", // 21字 / 上限 17
  "ed.view.zoominfo.label", // 27字 / 上限 17
  "ed.xform.badge.label", // 25字 / 上限 17
  "ed.feel.head.label", // 19字 / 上限 17
  "ed.layerclip.pasteTo.btn", // 21字 / 上限 13
  "ed.sel.drag.hint", // 34字 / 上限 33
  "ed.text.draftingHint.title", // 68字 / 上限 66
  "ed.warp.pushHint.hint", // 36字 / 上限 33
]);

const OVER_BASELINE_EN = new Set<string>([
  // --- ホーム・取り込み（7 件） ---
  "imp.cancelling.label", // 33字 / 上限 28
  "lib.chooseDir.label", // 32字 / 上限 28
  "lib.drop.import.btn", // 24字 / 上限 21
  "lib.import.btn", // 24字 / 上限 21
  "lib.missing.hint", // 57字 / 上限 54
  "lib.missing.label", // 29字 / 上限 28
  "lib.import.progress.label", // 40字 / 上限 28
  // --- ショートカット設定（11 件） ---
  "keys.assign.hint", // 69字 / 上限 54
  "keys.preset.builtin.hint", // 76字 / 上限 54
  "keys.row.sharedMates.label", // 45字 / 上限 28
  "keys.toolCycle.title", // 121字 / 上限 108
  "keys.cmd.editThicken.hint", // 96字 / 上限 54
  "keys.cmd.editThin.hint", // 96字 / 上限 54
  "keys.cmd.layerPaste.label", // 29字 / 上限 28
  "keys.cmd.layerPasteAll.label", // 31字 / 上限 28
  "keys.cmd.viewMiniToggle.hint", // 131字 / 上限 54
  "keys.cmd.viewFocusToggle.label", // 33字 / 上限 28
  "keys.cmd.viewFocusToggle.hint", // 145字 / 上限 54
  // --- 書き出し（4 件） ---
  "export.image.jpegNoAlpha.hint", // 62字 / 上限 54
  "export.image.transparent.label", // 33字 / 上限 28
  "export.whiteBg.hint", // 73字 / 上限 54
  "export.phase.encoderInit.label", // 37字 / 上限 28
  // --- 画像取り込み（3 件） ---
  "img.dialog.target.hint", // 56字 / 上限 54
  "img.fit.contain.btn", // 28字 / 上限 21
  "img.transparent.on.btn", // 22字 / 上限 21
  // --- 設定（3 件） ---
  "set.keys.btn", // 24字 / 上限 21
  "set.legal.license.msg", // 257字 / 上限 243
  "set.legal.scope.msg", // 356字 / 上限 293
  // --- 音声パネル（6 件） ---
  "ed.audio.load.btn", // 26字 / 上限 21
  "ed.audio.se.add.btn", // 26字 / 上限 21
  "ed.audio.status.kwz.label", // 47字 / 上限 28
  "ed.audio.status.replaced.label", // 35字 / 上限 28
  "ed.audio.status.replacedName.label", // 44字 / 上限 28
  "ed.audio.wave.info.label", // 62字 / 上限 28
  // --- エディタ（3 件） ---
  "ed.spec.label", // 87字 / 上限 82
  "ed.view.zoominfo.label", // 33字 / 上限 28
  "ed.layerclip.pasteTo.btn", // 22字 / 上限 21
  // --- 変形（2 件） ---
  "ed.xform.badge.label", // 41字 / 上限 28
  "ed.xform.head.label", // 36字 / 上限 28
  // --- 範囲選択（2 件） ---
  "ed.sel.auto.hint", // 72字 / 上限 54
  "ed.sel.drag.hint", // 73字 / 上限 54
  // --- 歪み（4 件） ---
  "ed.warp.bulgeHint.hint", // 58字 / 上限 54
  "ed.warp.cornerHint.hint", // 56字 / 上限 54
  "ed.warp.pinchHint.hint", // 61字 / 上限 54
  "ed.warp.pushHint.hint", // 78字 / 上限 54
]);

const OVER_BASELINE = new Set<string>([
  // --- M12-1a（index.html / main.ts）17 件 ---
  "common.saveTarget.path.hint",
  "lib.chooseDir.label",
  "lib.drop.import.btn",
  "lib.import.btn",
  "lib.missing.hint",
  "lib.missing.label",
  "imp.cancelling.label",
  "imp.progress.hint",
  "ed.save.btn",
  "ed.xform.badge.label",
  "img.dialog.target.hint",
  "set.about.author.label",
  "set.about.version.label",
  "set.keys.current.label",
  "keys.assign.hint",
  "keys.preset.builtin.hint",
  "keys.row.sharedMates.label",
  // --- M12-1b-1（editor.ts から辞書へ移した既存の日本語）8 件 ---
  // どれも**画面に出ていた文言をそのまま移しただけ**（新しく書いた文言はここに入れない）。
  // 短くする提案は M12-2（訳文）で見直す
  "ed.audio.load.btn", // 🎵 BGMを読み込む（音声・動画）
  "ed.audio.se.add.btn", // ＋ SEを追加（音声・動画）
  "ed.feel.head.label", // 描き味（PC拡張・OFFで3DS準拠）
  "ed.text.draftingHint.hint", // 確定するまで何度でも直せます…
  "ed.text.draftingHint.title", // 確定は Ctrl+Enter か ✔／取り消しは Esc。…
  "ed.warp.cornerHint.hint", // 四隅をドラッグして台形にできます。…
  "ed.warp.pushHint.hint", // ドラッグした向きに絵が引っ張られます。…
  // --- M12-1b-2（editor.ts の残り。**変数を含む文**なので長さは差し込み後の見た目に近い）6 件 ---
  // どれも eeab0d7 の画面にそのまま出ていた文言。`{…}` はプレースホルダで、
  // 文字数はプレースホルダ名込みで数えている（実際の表示はもう少し長い/短い）
  "ed.audio.wave.info.label", // 音源 {src}s / アニメ {anim}s（{count}コマ・{fps}fps）
  "ed.layer.dragGhostMulti.label", // {name} ほか{count}件
  "ed.view.badge.label", // コマ {frame} / {total}
  "ed.view.zoominfo.label", // 🔍 320×240 を {zoom}.0倍表示（ドット等倍）
  "ed.wobble.targetActiveNamed.label", // 選択中のレイヤーだけ（{name}）
  "ed.layerclip.pasteTo.btn", // 📋 貼り付け → {layerShort}
  // 音声パネルの状態行。eeab0d7 では「差し替え(名)」＋「・速度連動の基準: Nfps」の**連結**で出していた。
  // 連結をやめて完全文にしたので1キーが長くなった（画面に出ている文字列は1文字も変わっていない）
  "ed.audio.status.kwz.label", // 元の音（3DS作品由来）・速度連動の基準: {fps}fps
  "ed.audio.status.replaced.label", // 差し替え・速度連動の基準: {fps}fps
  "ed.audio.status.replacedName.label", // 差し替え（{name}）・速度連動の基準: {fps}fps
  // --- M12-1c-1（keymap.ts / library.ts から辞書へ移した既存の日本語）7 件 ---
  // どれも f7c5f73 の画面にそのまま出ていた文言。ショートカット設定の note は
  // 「どの条件で効くか」を書いた注記なので短くしにくい（M12-2 の訳文で見直す）
  "keys.cmd.editThicken.hint", // 選んでいるレイヤーのこのコマ。選択範囲があれば範囲内だけ。既定では未割り当て
  "keys.cmd.editThin.hint", // 同上
  "keys.cmd.viewMiniToggle.hint", // 小窓・コマ番号・倍率をまとめて。既定では未割り当て。…
  "keys.cmd.viewFocusToggle.label", // キャンバスに集中（パネルをまとめて畳む／戻す）
  "keys.cmd.viewFocusToggle.hint", // 既定では未割り当て。キャンバス右上の ⛶ ボタンでも…
  "lib.import.progress.label", // 📥 取り込み中… {album}（スキップ {skipped}）
  "lib.openFile.filter.label", // 3DS作品 (.kwz/.ppm) ＝ ファイルダイアログのフィルタ名
  // --- M12-1c-2（exporter.ts から辞書へ移した既存の日本語）1 件 ---
  "export.phase.encoderInit.label", // エンコーダ準備中（初回は時間がかかります）＝進捗フェーズの表示名
]);

{
  const over: { key: string; len: number; lim: number }[] = [];
  for (const [k, v] of ja) {
    const kind = k.split(".").pop()!;
    const lim = LIMIT_OVERRIDE[k] ?? LIMIT[kind];
    if (!lim) continue;
    const len = [...v].length;
    if (len > lim) over.push({ key: k, len, lim });
  }
  const known = over.filter((o) => OVER_BASELINE.has(o.key));
  const fresh = over.filter((o) => !OVER_BASELINE.has(o.key));
  warnings.push(...known.map((o) => `文字数超過（既知・直す候補）: ${o.key} ${o.len}字（上限 ${o.lim}）`));
  for (const o of fresh) console.log(`NG 文字数超過（ベースライン外）: ${o.key} ${o.len}字（上限 ${o.lim}）`);
  check(
    "検査3: ベースライン外の文字数超過が無い（新しい文言は UI_TEXT_guide の上限を守る）",
    fresh.length === 0,
    `既知 ${known.length} 件 / 新規超過 ${fresh.length} 件 / 全 ${ja.size} キー`
  );
  // ベースラインに載せたのに実際は超過していないキー（＝直った or 消えた）は掃除の合図
  const stale = [...OVER_BASELINE].filter((k) => !over.some((o) => o.key === k));
  warnings.push(...stale.map((k) => `ベースラインの残骸（もう超過していない）: ${k}`));

  // ---- M12-2: en も同じ流儀で見る（言語別の係数・master §4） ----
  // ラテン文字は1字が細いので、日本語と同じ字数上限では厳しすぎる。係数は **en ×1.8**
  //（es / pt-BR ×1.7 ／ ko ×1.1 は M12-3 で足す）。上限は切り捨て。
  //
  // **ベースラインは「英語の実画面を見て、壊れていないことを確かめたあと」に作った**。
  // 先に作ると「入っているから良し」になり、見ないまま通ってしまう。
  // M12-2 では 23（エディタ）＋28（ホーム）＋11（補足）カットを ja/en で撮り、
  // 「辞書の文字がはみ出す」件数が **0 件**であることを確認したうえで、ここに固定している。
  // M12-3: 係数は **852キーの ja 比を実測して改訂**した（GLOSSARY 決まり6）。
  // 旧値（es / pt-BR ×1.7）は勘の数字で、実測は es 2.09 / pt-BR 2.00 だった。
  // en 1.82 と ko 1.00 は元の 1.8 / 1.1 とほぼ一致したので据え置き。
  const LANG_FACTOR: Record<string, number> = { en: 1.8, es: 2.1, "pt-BR": 2.0, ko: 1.1 };
  const BASELINES: Record<string, Set<string>> = {
    en: OVER_BASELINE_EN,
    es: OVER_BASELINE_ES,
    "pt-BR": OVER_BASELINE_PT,
    ko: OVER_BASELINE_KO,
  };
  for (const [lang] of TRANSLATIONS) {
    const d = DICTS_BY_LANG.get(lang)!;
    if (d.size === 0) continue;
    const factor = LANG_FACTOR[lang];
    const baseline = BASELINES[lang];
    const over: { key: string; len: number; lim: number }[] = [];
    for (const [k, v] of d) {
      const kind = k.split(".").pop()!;
      const base = LIMIT_OVERRIDE[k] ?? LIMIT[kind];
      if (!base) continue;
      const lim = Math.floor(base * factor);
      const len = [...v].length;
      if (len > lim) over.push({ key: k, len, lim });
    }
    const known = over.filter((o) => baseline.has(o.key));
    const fresh = over.filter((o) => !baseline.has(o.key));
    warnings.push(
      ...known.map((o) => `${lang} 文字数超過（既知・実画面では収まる）: ${o.key} ${o.len}字（上限 ${o.lim}）`)
    );
    for (const o of fresh) console.log(`NG ${lang} 文字数超過（ベースライン外）: ${o.key} ${o.len}字（上限 ${o.lim}）`);
    check(
      `検査3-${lang}: ベースライン外の文字数超過が無い（上限＝ja の上限×${factor}）`,
      fresh.length === 0,
      `既知 ${known.length} 件 / 新規超過 ${fresh.length} 件 / 全 ${d.size} キー`
    );
    const stale = [...baseline].filter((k) => !over.some((o) => o.key === k));
    warnings.push(...stale.map((k) => `${lang} ベースラインの残骸（もう超過していない）: ${k}`));
  }
}

// ---------------- 3-b: 値が空のキーが無い（ja は「正」なので空を許さない） ----------------
// M12-1b: lookup() は空文字を**有効な訳**として扱うようにした（「この言語では出さない」を表現できる）。
// その代わり、うっかりの空欄は source 側で落とす。
{
  const empty = [...ja.entries()].filter(([, v]) => v === "");
  check("検査3-b: ja に空の値が無い", empty.length === 0, empty.map(([k]) => k).join(" "));
}

// ---------------- 4: 未使用キー ----------------
{
  const used = new Set<string>();
  // M12-1b-2（R-2）: **AST で集める**。正規表現だと**コメントの中の文字列まで拾ってしまう**
  //（この検査の説明コメント自身が `Key: "…"` を含んでいて、`…` を参照キーとして誤検出した）。
  // 拾う形は2つだけ:
  //   (a) `t("キー")`      … 直書き
  //   (b) `*Key: "キー"`   … **動的キーの規約**。`t(tx.labelKey)` のように変数で引くキーは
  //       呼び出し側からは見えないので、**`*Key: "…"` という名前のプロパティ**で持つ
  //       （例 `labelKey: "ed.pen.tex.solid.title"`）。こうしておけば辞書に無ければ
  //       「参照キーの欠落」で落ち、未使用キーの誤警告も出ない。
  //   **この形から外れた動的キーは検査から見えない**（規約を外れたら検査も守れない）
  for (const [name, src] of SCANNED) {

    const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      // (a) t("キー", …)
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t" &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        used.add((node.arguments[0] as ts.StringLiteral).text);
      }
      // (b) 名前が Key で終わるプロパティ = 動的キー
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        /Key$/.test(node.name.text) &&
        ts.isStringLiteral(node.initializer)
      ) {
        used.add(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const m of htmlSrc.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.add(m[1]);
  used.add("app.title"); // applyI18n が document.title に使う
  const unused = [...ja.keys()].filter((k) => !used.has(k));
  const missing = [...used].filter((k) => !ja.has(k));
  warnings.push(...unused.map((k) => `未使用キー: ${k}`));
  check("検査4: 参照しているキーがすべて辞書にある", missing.length === 0, missing.join(" "));
  check("検査4: 未使用キーを数えた（一覧は警告へ）", true, `未使用 ${unused.length} / 使用 ${used.size}`);
}

// ---------------- 5: ハードコード残りの検出（この回の完了判定） ----------------
const JP = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

/** 許可リスト（増やすときは**理由をここに書く**）
 *
 *  **M12-D で既定名の9種を外した**（`未分類` / `新しいアルバム` / `合作` / `無題` / `レイヤー` /
 *  `フォルダ` / `背景` / `画像取り込み` / `カスタム`）。作者決定「新しく作られるものの既定名は
 *  作った時点の UI 言語で付ける」に従い `src/i18n/defaults.ts` が `t("defaults.…")` を引くようになり、
 *  ソースに literal が残らなくなったため。**M12-1c-1 で外した "道具" と同じ筋**で、
 *  「許可リストから外せた＝設計が正しくなった」という関係になっている。
 *
 *  残っているのは CREDITS 配列（作者名・URL・OSS 名。master §5 で翻訳しない）と、
 *  下の1件だけ。
 */
const ALLOW_LITERALS = [
  // M8-2: エディタ内の画像取り込みが作る作品の既定題名。`imageProjectTitle()` とは**別の短い名前**で、
  // main.ts のこの1箇所にしか無い（defaults.ts へ寄せるほどの共有が無い）。保存名になるので訳さない
  "画像",
];

/**
 * M12-1c-2: **そのファイルの中だけ**で許す literal。
 * 全体の `ALLOW_LITERALS` に入れると他のファイルでも素通りしてしまうものを、
 * 「ここは画面に出ない」と分かっている場所に限って通す。
 */
const ALLOW_BY_FILE: Record<string, string[]> = {
  // トーンの `group` は**画面に出ない内部のグループ識別子**（大/小のペアを束ねるだけ）。
  // ピッカーが出すのは `nameKey` 側だけ（editor.ts の `d.title = t(tone.nameKey)`）で、
  // group を読むのは配布物外の MCP（`mcp/tools.ts` の list_tones）だけ。
  // P-0「トーンの定義（タイル・並び・id）は不変。触るのは name だけ」に従い**値を変えていない**。
  // ASCII 識別子へ寄せるのは M12-2 以降の候補（変えると MCP の出力が変わるので単独の回で）。
  "src/editor/raster.ts": [
    "ベタ", "整列ドット", "横線", "縦線", "市松", "ベタ抜き", "斜め格子",
    "ドット疎", "網点", "斜め網掛け", "格子", "クロスドット",
    // 文字ツールの禁則処理に使う**約物の文字クラス**。表示文字列ではなくデータ
    "ー〜～…‥―（）()「」『』【】［］[]｛｝{}〈〉《》−-＝=＿_",
  ],
};

/** import.meta.env.DEV のブロック（製品ビルドから丸ごと消える検証ページ）と CREDITS 配列の行範囲 */
function skipRanges(src: string): [number, number][] {
  const lines = src.split("\n");
  const rs: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^const CREDITS/.test(lines[i])) {
      let j = i;
      while (j < lines.length && !/^\];/.test(lines[j])) j++;
      rs.push([i + 1, j + 1]);
      i = j;
      continue;
    }
    if (!/import\.meta\.env\.DEV/.test(lines[i])) continue;
    let depth = 0, started = false, j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") depth--;
      }
      if (started && depth <= 0) break;
    }
    rs.push([i + 1, j + 1]);
    i = j;
  }
  return rs;
}

/**
 * TS の**コンパイラの scanner** で日本語文字列を拾う（M12-1b）。
 * 自前の字句解析は正規表現リテラル（`editor.ts:3918` の `/"/g`）で同期を失い、
 * それ以降のコードを文字列と誤認する＝**検出漏れの温床**だったので AST に置き換えた。
 */
/**
 * M12-2: **その行だけ**日本語のハードコードを見逃す目印。
 *
 *   const LANG_NAMES = { ja: "日本語", en: "English" }; // i18n-exempt: 理由
 *
 * 表示言語のボタンは**翻訳してはいけない**（知らない言語にしてしまった人が自分の言語を
 * 見つけて戻れる必要がある。`REQ_M12_2 §2-b`）。かといって無条件の除外リストに入れると、
 * 将来うっかり書いた日本語まで通ってしまう。**行単位**にして、目印の無い行は今までどおり落とす。
 */
function exemptLines(src: string): Set<number> {
  const out = new Set<number>();
  src.split("\n").forEach((line, i) => {
    if (/\/\/\s*i18n-exempt:/.test(line)) out.add(i + 1);
  });
  return out;
}

function jaLiterals(file: string, src: string): { line: number; text: string; internal: boolean }[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: { line: number; text: string; internal: boolean }[] = [];
  /** 画面に出ない「内部識別子」か（履歴ラベル＝History.label は描画されない） */
  const INTERNAL_FIRST_ARG = new Set([
    "pushStructure",
    "bufferChangeEntry",
    "multiBufferChangeEntry",
    "pushBufferHistory",
    "pushSelectionHistory",
    "replaceSelection",
  ]);
  const isInternal = (node: ts.Node): boolean => {
    let n: ts.Node = node;
    // 連結・テンプレート・括弧・三項は登る（代入 = は登らない）
    while (
      n.parent &&
      (ts.isTemplateExpression(n.parent) ||
        ts.isTemplateSpan(n.parent) ||
        ts.isParenthesizedExpression(n.parent) ||
        ts.isConditionalExpression(n.parent) ||
        (ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken))
    )
      n = n.parent;
    const p = n.parent;
    if (!p) return false;
    if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "label" && ts.isObjectLiteralExpression(p.parent)) {
      const props = p.parent.properties.map((x) => x.name?.getText(sf));
      return props.includes("undo") && props.includes("redo"); // 履歴エントリの label
    }
    if (ts.isCallExpression(p)) {
      const full = p.expression.getText(sf);
      // M12-1c-1: console.* は**開発者向けのログ**で画面には出ない（library.ts の "[M11-4] …" 等）。
      // 引数の位置を問わず内部扱いにする
      if (/^console\./.test(full)) return true;
      const callee = full.split(".").pop() ?? "";
      return INTERNAL_FIRST_ARG.has(callee) && p.arguments.indexOf(n as ts.Expression) === 0;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // テンプレート内の HTML コメントは画面に出ない
      const text = node.text.replace(/<!--[\s\S]*?-->/g, "");
      if (JP.test(text)) {
        out.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          text: node.text.trim(),
          internal: isInternal(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

{
  const skip = skipRanges(mainSrc);
  const hits = jaLiterals("src/main.ts", mainSrc)
    .filter((h) => !skip.some(([a, b]) => h.line >= a && h.line <= b))
    .filter((h) => !h.internal)
    .filter((h) => !ALLOW_LITERALS.includes(h.text))
    .filter((h) => !exemptLines(mainSrc).has(h.line)); // M12-2: `// i18n-exempt:` の行だけ
  for (const h of hits) console.log(`  ハードコード src/main.ts:${h.line}  ${JSON.stringify(h.text.slice(0, 80))}`);
  check("検査5: src/main.ts に日本語のハードコードが無い（DEV検証ページ・CREDITS・名前定数を除く）", hits.length === 0, `${hits.length} 件`);

  // M12-1b: editor.ts。履歴ラベル（画面に出ない内部識別子）と名前になる語は除く。
  // M12-1b-2: キー化が終わったので **fail 判定**（0 件でなければ落ちる）。
  // 以後 editor.ts に日本語を直書きすると、このゲートが止める
  const edHits = jaLiterals("src/editor/editor.ts", editorSrc)
    .filter((h) => !h.internal)
    .filter((h) => !ALLOW_LITERALS.includes(h.text))
    .filter((h) => !exemptLines(editorSrc).has(h.line));
  for (const h of edHits) console.log(`  ハードコード src/editor/editor.ts:${h.line}  ${JSON.stringify(h.text.slice(0, 80))}`);
  check(
    "検査5: src/editor/editor.ts に日本語のハードコードが無い（履歴ラベル・名前定数を除く）",
    edHits.length === 0,
    `${edHits.length} 件`
  );

  // M12-1c-1: ホーム画面まわりの3ファイルも **fail 判定**で対象に加えた。
  // 以後この3ファイルに日本語を直書きすると落ちる（M12-1c-2 でさらに対象を増やす）
  for (const [name, src] of KEYED_FILES) {
    const perFile = ALLOW_BY_FILE[name] ?? [];
    const hs = jaLiterals(name, src)
      .filter((h) => !h.internal)
      .filter((h) => !ALLOW_LITERALS.includes(h.text))
      .filter((h) => !perFile.includes(h.text))
      .filter((h) => !exemptLines(src).has(h.line));
    for (const h of hs) console.log(`  ハードコード ${name}:${h.line}  ${JSON.stringify(h.text.slice(0, 80))}`);
    check(`検査5: ${name} に日本語のハードコードが無い`, hs.length === 0, `${hs.length} 件`);
  }

  // index.html: コメントを除いたテキストノードと属性値
  const noComment = htmlSrc.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const htmlHits: string[] = [];
  for (const m of noComment.matchAll(/\s([a-zA-Z-]+)="([^"]*)"/g)) if (JP.test(m[2])) htmlHits.push(`${m[1]}="${m[2]}"`);
  for (const m of noComment.matchAll(/>([^<]+)</g)) if (JP.test(m[1])) htmlHits.push(`text:${m[1].trim()}`);
  for (const h of htmlHits) console.log(`  ハードコード index.html  ${h.slice(0, 80)}`);
  check("検査5: index.html に日本語のハードコードが無い", htmlHits.length === 0, `${htmlHits.length} 件`);
}

// ---------------- 8: module 直下で t() を評価していない（M12-D） ----------------
// `export const X = t("…")` のように**トップレベルで訳文を取ると、module 読み込み時の言語で固まる**。
// 言語が決まるのは `applyI18n` / `setLang` のあとなので、その定数はずっと初期言語のままになる。
//   - 既定名（defaults.ts）を定数にしていたら「作った時の UI 言語で付ける」が丸ごと効かなくなる
//   - 実際 M12-1c-2 では `const DEFAULT_ALBUM = defaultAlbumName()` を main.ts に置いてしまい、
//     M12-D で消した。**同型の事故を機械的に止める**のがこの検査
// 見るのは「module 直下の文」だけ。関数の中・クラスのメソッド・コールバックの中は**呼び出し時に
// 評価される**ので対象外（そこが正しい使い方）。
{
  /** i18n の訳を取る関数（別名 import も拾う） */
  const TRANSLATORS = new Set(["t", "tr"]);
  /** defaults.ts の既定名も同じ理由でトップレベル評価してはいけない */
  const DEFAULT_GETTERS = /^(defaultAlbumName|newAlbumName|collabAlbumName|untitledTitle|layerBaseName|folderBaseName|imageLayerName|imageProjectTitle|customPresetBaseName)$/;
  const bad: string[] = [];
  for (const [name, src] of SCANNED) {
    const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    /** その式の中に t(...) / 既定名ゲッターの**呼び出し**があるか（関数の中身には入らない） */
    const callsTranslator = (node: ts.Node): boolean => {
      let found = false;
      const walk = (n: ts.Node) => {
        if (found) return;
        // 関数・クラスの内側は「呼び出し時に評価される」ので追わない
        if (
          ts.isFunctionDeclaration(n) ||
          ts.isFunctionExpression(n) ||
          ts.isArrowFunction(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isClassDeclaration(n) ||
          ts.isClassExpression(n) ||
          ts.isGetAccessorDeclaration(n)
        )
          return;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const fn = n.expression.text;
          if (TRANSLATORS.has(fn) || DEFAULT_GETTERS.test(fn)) {
            found = true;
            return;
          }
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(node, walk);
      return found;
    };
    for (const st of sf.statements) {
      // 対象は module 直下の「変数宣言」と「式文」だけ（import/型/関数宣言は評価されない）
      const target =
        ts.isVariableStatement(st) || ts.isExpressionStatement(st) ? st : null;
      if (!target) continue;
      if (!callsTranslator(target)) continue;
      const line = sf.getLineAndCharacterOfPosition(target.getStart(sf)).line + 1;
      bad.push(`${name}:${line} ${target.getText(sf).split("\n")[0].slice(0, 70)}`);
    }
  }
  for (const b of bad) console.log(`  module 直下で訳を取っている ${b}`);
  check(
    "検査8: module 直下で t() / 既定名を評価していない（読み込み時の言語で固まる）",
    bad.length === 0,
    `${bad.length} 件`
  );
}

// ---------------- 6: 属性へ ${...} を埋めていない（R-2 案1 のガード・M12-1b-2） ----------------
// 訳文に `"` が入ると属性が割れて DOM が壊れる。いまの日本語に `"` が無いので動いているだけ＝
// **M12-2 で訳文を入れた瞬間に踏む**ので、テンプレートの段階で禁じる。
// 属性は「DOM を組んだあとに el.title = t(...) とプロパティで入れる」（案1）。
// 見るのは「**訳文が**属性値へ入る」形だけ。データ（色・数値・キー名）を属性へ差すのは従来どおり安全
// （`value="${hex}"` など。訳者が触らないので `"` が混ざらない）。
{
  const ATTRS = ["title", "placeholder", "alt", "aria-label"];
  const bad: string[] = [];
  for (const [name, src] of SCANNED) {

    const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isTemplateSpan(node)) {
        const lit = node.parent.head === undefined ? null : null; // 型のため（未使用）
        void lit;
        // 直前の文字列断片（head か 前の span の literal）の末尾が `attr="` で終わっていれば属性値の中
        const tpl = node.parent as ts.TemplateExpression;
        const idx = tpl.templateSpans.indexOf(node);
        const prevText = idx === 0 ? tpl.head.text : tpl.templateSpans[idx - 1].literal.text;
        const tail = prevText.slice(-60);
        const attr = ATTRS.find((a) => new RegExp(`\\b${a}\\s*=\\s*"[^"]*$`).test(tail));
        if (attr && /\bt\(/.test(node.expression.getText(sf))) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          bad.push(`${name}:${line} ${attr}="\${…t(…)…}"`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const b of bad) console.log(`  属性へ訳文を埋め込み ${b}`);
  check(
    "検査6: 訳文を属性へ埋め込んでいない（訳文の \" で属性が割れる・R-2 案1 のガード）",
    bad.length === 0,
    `${bad.length} 件`
  );
}

// ---------------- 7: 呼び出しの引数と値のプレースホルダが一致する（M12-1b-2） ----------------
// M12-1b-2 のスクショ比較で 2 件見つけた:
//   - 値が `コマ {frame} / {total}` なのに呼び出しは `{ n, total }` → 画面に **{frame} がそのまま出た**
//   - 値が `… {zoom}.0倍表示` で呼び出しも `${z}.0` → **2.0.0倍表示**
// どちらも型では防げず、スモークにも出ない（画面を撮って初めて見える）。ここで静的に落とす。
// 見るのは `t("キー", { … })` の**その場に書いたオブジェクト**だけ（変数を渡す形は skip）。
{
  const bad: string[] = [];
  for (const [name, src] of SCANNED) {

    const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t" &&
        node.arguments.length >= 2 &&
        ts.isStringLiteral(node.arguments[0]) &&
        ts.isObjectLiteralExpression(node.arguments[1])
      ) {
        const key = (node.arguments[0] as ts.StringLiteral).text;
        const value = ja.get(key);
        if (value !== undefined) {
          const want = new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
          const got = new Set<string>();
          let spread = false;
          for (const p of (node.arguments[1] as ts.ObjectLiteralExpression).properties) {
            if (ts.isSpreadAssignment(p)) spread = true;
            else if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) got.add(p.name.text);
          }
          if (!spread) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            const missing = [...want].filter((w) => !got.has(w));
            const extra = [...got].filter((g) => !want.has(g));
            if (missing.length) bad.push(`${name}:${line} ${key} 値の {${missing.join("},{")}} に渡す値が無い`);
            if (extra.length) bad.push(`${name}:${line} ${key} 渡した ${extra.join(",")} が値に無い`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const b of bad) console.log(`  プレースホルダ不一致 ${b}`);
  check("検査7: t(キー, {…}) の引数と値の {…} が一致する", bad.length === 0, `${bad.length} 件`);
}

// ---------------- 追加: 辞書の値に HTML タグを入れない ----------------
{
  const withTag = [...ja.entries()].filter(([, v]) => /<[a-zA-Z/!]/.test(v));
  check("辞書の値に HTML タグが無い（テンプレートへ差し込むため）", withTag.length === 0, withTag.map(([k]) => k).join(" "));
}

// ---------------- 追加: キー命名の規約 ----------------
{
  const KINDS = new Set(["btn", "label", "hint", "title", "msg", "toast", "placeholder"]);
  const bad = [...ja.keys()].filter((k) => {
    const parts = k.split(".");
    return parts.length < 2 || !KINDS.has(parts[parts.length - 1]);
  });
  warnings.push(...bad.map((k) => `用途語が無いキー: ${k}`));
  check("キーが「画面.部品.用途」の形（用途語で終わる）", bad.length === 0, bad.slice(0, 8).join(" "));
}

console.log(`\n--- 警告 ${warnings.length} 件（この回では直さない・報告書に載せる）---`);
for (const w of warnings) console.log(`  ${w}`);
console.log(`\nm1201 i18n check: pass=${pass} fail=${fail} warn=${warnings.length}`);
process.exit(fail === 0 ? 0 : 1);
