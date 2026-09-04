// V166（重い操作の漏斗）の回帰ゲート。引数不要:
//   npx tsx scripts/v166_smoke.ts
//
// ★この回でいちばん怖いのは3つ:
//   ① **漏斗の外に重い操作が置かれる**（＝今回の事故がそのまま再発する）
//      → 検査2 が「層2 の操作は全部 `runHeavy` を通っている」ことを操作名の一覧で全数確認する。
//        ここが**わざと1つ外すと赤くなる**箇所（受け入れ基準4）。実証は検査2z が自分で行う
//   ② **飲ませてはいけないものを飲ませる**（保存が入口を閉じると V161-A「保存中も描ける」が死ぬ）
//      → 検査3 が `busyKind` に "save" が入らないこと・保存経路が `runHeavy` を通らないことを固定
//   ③ **確保する前に断る**が抜ける（見積もりを足しても、呼ばれていなければ意味がない）
//      → 検査4 が確保経路ごとに `allowFrameAlloc` の呼び出しを確かめ、
//        検査5 が見積もりの算数そのもの（純関数）を直接叩く
//
// 1. `PerfOp` と漏斗の一覧が一致する（待たせる対象＝数える対象）
// 2. ★層2 の操作が全部 `runHeavy` を通っている ＋ 2z わざと外すと赤くなることの実証
// 3. ★飲ませてはいけないもの（保存・眠らせ）が漏斗に入っていない
// 4. 確保の前に見積もる（`allowFrameAlloc` が確保経路の手前にある）
// 5. 見積もりの算数（純関数を直接叩く・反証つき）
// 6. 例外でも入口が開く（`finally`）・メーターを中で数え直さない（D）・確保失敗で止まる（E）
// 7. C（Alt）の自己修復と計測の配線
// 8. i18n（新しい文言が7言語ぜんぶにある）
import fs from "node:fs";
import path from "node:path";
import {
  HEAVY_ALLOC_MAX_BYTES,
  frameBytes,
  checkFrameAlloc,
  isAllocFailure,
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
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const edRaw = read("src/editor/editor.ts");
const perf = read("src/perf.ts");
const busy = read("src/ui/busy.ts");
const css = read("src/styles.css");

// ★V165 の反省: 検査の正規表現が**自分のコメント**（旧コードを引用した説明）に当たると、
//  実装を消しても緑のままになる。行コメントを落としてから見る（下の `stripped` 反証つき）。
const ed = edRaw.replace(/^[ \t]*\/\/.*$/gm, "");
check(
  "0 反証: コメントを落とすと中身が変わる（＝この前処理が効いている）",
  ed.length < edRaw.length && ed !== edRaw
);

// ================= 1. 待たせる対象＝数える対象 =================
// 漏斗を通す操作は `runHeavy("<op>", …)` の形で書く。その `<op>` は `PerfOp` に無ければ
// 型エラーになるが、**逆（PerfOp にあるのに誰も通していない）は型では捕まらない**ので、ここで見る。
const funnelOps = [...ed.matchAll(/runHeavy\(\s*"([a-z.]+)"/g)].map((m) => m[1]);
{
  check("1 runHeavy の呼び出しが1つ以上ある", funnelOps.length > 0, `${funnelOps.length}件`);
  const perfOps = new Set([...perf.matchAll(/^\s*\|\s*"([a-z.]+)"/gm)].map((m) => m[1]));
  for (const op of new Set(funnelOps))
    check(`1 漏斗の操作名 "${op}" が PerfOp にある`, perfOps.has(op));
  // W-10 の線: ログに書ける操作名は列挙されたものだけ（好きな文字列を渡せない作り）
  check(
    "1 ★runHeavy に変数の操作名を渡していない（W-10: 作品名が混ざる道を作らない）",
    !/runHeavy\(\s*[A-Za-z_$]/.test(ed)
  );
}

// ================= 2. ★層2 の操作が全部 runHeavy を通っている =================
//
// ★ここが「網」。要件 §1 の表の操作を**入口の関数名**で挙げ、その関数の本体に
//  `runHeavy(` があることを見る。1つ外すと、その行が NG になる（実証は 2z）。
//
// ⚠ 表のうち2つは**意図して外してある**（検査3 が「外れていること」を固定している）:
//   「コマでずらす」＝トグル1つで画素も確保も動かない／「眠らせ（sweep）」＝描きながら裏で進む設計
const LAYER2: { fn: string; why: string }[] = [
  { fn: "copySelectedFrames", why: "コマのコピー" },
  { fn: "pasteFrames", why: "貼り付け（今回の事故）" },
  { fn: "addFrame", why: "コマ追加・複製" },
  { fn: "addFrames", why: "まとめて追加（V164 U-4）" },
  { fn: "deleteFrame", why: "コマ削除" },
  { fn: "reorderFrame", why: "コマ並べ替え" },
  { fn: "deleteLayer", why: "レイヤー削除" },
  { fn: "deleteFolder", why: "フォルダごと削除" },
  { fn: "mergeLayerDown", why: "レイヤー統合" },
  { fn: "pasteLayerAllFrames", why: "全コマへレイヤー貼り付け" },
  { fn: "toggleLayerShared", why: "全コマ共通の切り替え" },
  { fn: "toggleLayerDisplayColor", why: "レイヤーカラー（全コマ）" },
  { fn: "commitTransform", why: "変形の確定" },
  { fn: "commitCornerWarp", why: "歪みの確定" },
  { fn: "placeConvertedFrames", why: "連番画像のまとめて取り込み" },
];

/** 関数名から本体（次の同じ深さのメソッドまで）をざっくり切り出す。
 *  ★入口の関数だけを見る＝`…Inner` 側に `runHeavy` があっても通さない。 */
function bodyOf(src: string, fn: string): string | null {
  const m = new RegExp(
    // `runHeavy<T>(…)` のような総称も拾う（`<…>` は任意）
    `\\n  (?:private |protected |public )?(?:async )?${fn}\\s*(?:<[^>]{0,60}>)?\\s*(?:\\([^)]*\\)|\\([\\s\\S]{0,400}?\\))\\s*(?::[^{]{0,120})?\\{`
  ).exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = src.indexOf("\n  }", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

/** 層2 の1件を判定する（2z がこれを「壊した写し」に対して呼び直す） */
function layer2Ok(src: string, fn: string): boolean {
  const body = bodyOf(src, fn);
  return body !== null && /runHeavy\(/.test(body);
}

for (const { fn, why } of LAYER2)
  check(`2 ★${why}（${fn}）が漏斗を通っている`, layer2Ok(ed, fn), bodyOf(ed, fn) === null ? "関数が見つからない" : "本体に runHeavy が無い");

// ---- 2z. ★わざと外すと赤くなることの実証（受け入れ基準4） ----
// 「検査が効いている」と書くだけでは、検査が壊れていても気づけない。
// 実際に1つ**漏斗から外した写し**を作り、この検査が NG を出すことをここで示す。
{
  const victim = "pasteFrames"; // 今回の事故そのもの＝いちばん外してはいけない1つ
  const body = bodyOf(ed, victim);
  const broken = body === null ? ed : ed.replace(body, body.replace(/runHeavy\(/g, "notAFunnel("));
  check(
    "2z ★わざと漏斗から外すと、検査2 が赤くなる（網が効いていることの実証）",
    layer2Ok(ed, victim) && !layer2Ok(broken, victim),
    `本物=${layer2Ok(ed, victim)} 壊した写し=${layer2Ok(broken, victim)}`
  );
  // 反証の反証: 関係のない関数を壊しても、その関数だけが赤くなる（検査が全体に効いていない、を排除）
  check(
    "2z 壊していない操作は緑のまま（巻き添えで落ちていない）",
    layer2Ok(broken, "mergeLayerDown")
  );
}

// ================= 3. ★飲ませてはいけないもの =================
{
  // ①保存: 入口を閉じない（V161-A「保存中も描ける」・壊すなリスト）
  check(
    "3 ★busyKind に \"save\" を立てる呼び出しが無い（保存は入口を閉じない）",
    !/beginBusy\(\s*"save"\s*\)/.test(ed)
  );
  const saveBody = bodyOf(ed, "runBackgroundSave") ?? bodyOf(ed, "save") ?? "";
  check("3 ★保存の本体が runHeavy を通らない", !/runHeavy\(/.test(saveBody));
  // V161-A の魂そのもの: 保存は背景で走り、**編集ロックをかけない**
  check(
    "3 ★保存中も描ける仕組み（背景保存）が残っている",
    /private async runBackgroundSave\(\): Promise<boolean>/.test(ed) &&
      /this\.saveInFlight = job;/.test(ed)
  );
  check(
    "3 ★保存が W-9 の編集ロックを掛けないことがコードに書いてある",
    /編集ロックはかけない/.test(edRaw)
  );
  // ②眠らせ: 裏で進む（入口を閉じたら描けなくなる）。多重起動の防止は元からある `sweeping`
  const sweep = bodyOf(ed, "sweepSleep") ?? "";
  check("3 ★眠らせ（sweep）は漏斗を通さない（描きながら進む設計）", sweep !== "" && !/runHeavy\(/.test(sweep));
  // V168: `sweepSleep` は1周の Promise を返す包み（`sweepJob`）になったので、`return Promise.resolve();` も許す。
  // 見張りたいのは「多重起動を `sweeping` が止めている」ことで、戻り値の形ではない
  check("3 眠らせの多重起動は sweeping が止めている", /if \(this\.sweeping \|\| !this\.sleepOn\) return(?: Promise\.resolve\(\))?;/.test(ed));
  check("3 「コマでずらす」は PerfOp にも漏斗にも入っていない", !/frame\.dither/.test(perf) && !/frame\.dither/.test(ed));
  // ③スポイト: Alt＋クリックは従来どおり（壊すなリスト）
  check("3 ★Alt＋クリックのスポイト割り当てが残っている", /"edit\.pickColor": \{ code: "", button: 0, alt: true \}/.test(read("src/keymap.ts")));
}

// ================= 4. 確保の前に見積もる =================
{
  // 見積もりを通す確保経路（コマを新しく作る／写す経路）と、その手前の `allowFrameAlloc`
  const GUARDED: { fn: string; why: string }[] = [
    { fn: "pasteFramesBody", why: "貼り付け（単ページ・複数ページの両方）" },
    { fn: "addFrameInner", why: "コマ追加・複製" },
    { fn: "addFramesInner", why: "まとめて追加" },
    { fn: "placeConvertedFramesInner", why: "連番画像" },
  ];
  for (const { fn, why } of GUARDED) {
    const body = bodyOf(ed, fn);
    check(`4 ${why}（${fn}）が確保の前に見積もる`, body !== null && /allowFrameAlloc\(/.test(body));
  }
  // ★単ページ経路にも要る（要件 §2-B の名指し）。複数ページ側と**2か所**あることを見る
  const paste = bodyOf(ed, "pasteFramesBody") ?? "";
  const n = (paste.match(/allowFrameAlloc\(/g) ?? []).length;
  check("4 ★貼り付けは単ページと複数ページの両方で見積もる（2か所）", n >= 2, `${n}か所`);
  // 断り文句は「入りません」ではなく**何コマなら入るか**
  check("4 ★断り文句が「あと何コマ入るか」を渡している", /tooManyFrames\.msg", \{ max: r\.maxFrames \}/.test(ed));
  check("4 見積もりは確保せずに答える（純関数を呼ぶだけ）", /checkFrameAlloc\(frames, this\.project\.layerDefs\.length/.test(ed));
  // 1コマも入らないときに「約0コマまで貼れます」と言わない（助言になっていないため）
  check("4 ★1コマも入らないときは減らす助言に切り替える", /r\.maxFrames > 0[\s\S]{0,140}?ed\.heavy\.outOfMemory\.msg/.test(ed));

  // ★全コマに効くレイヤー操作も同じ形で落ちる（「全コマ × N枚」の控え）。
  //  コマ数の上限（65,535）はここでも役に立たないので、同じ見積もりを通す
  const BUF_GUARDED: { fn: string; why: string }[] = [
    { fn: "deleteLayerInner", why: "レイヤー削除（全コマ×1枚）" },
    { fn: "mergeLayerDownInner", why: "レイヤー統合（全コマ×2枚）" },
    { fn: "toggleLayerSharedInner", why: "全コマ共通の切り替え（全コマ×1枚）" },
    { fn: "pasteLayerAllFramesInner", why: "全コマへレイヤー貼り付け" },
    { fn: "deleteFolderWithContents", why: "フォルダごと削除（全コマ×枚数）" },
  ];
  for (const { fn, why } of BUF_GUARDED) {
    const body = bodyOf(ed, fn);
    check(`4 ★${why}（${fn}）が確保の前に見積もる`, body !== null && /allowBufferAlloc\(/.test(body));
  }
  // ★見積もりは**起こすより先**でなければ意味が薄い（起こす側も確保する）
  for (const { fn } of BUF_GUARDED) {
    const body = bodyOf(ed, fn) ?? "";
    const iGuard = body.indexOf("allowBufferAlloc(");
    const iWake = body.indexOf("wakeLayersAllFrames(");
    check(
      `4 ${fn}: 見積もりが起こす処理より先`,
      iGuard >= 0 && (iWake < 0 || iGuard < iWake),
      `guard=${iGuard} wake=${iWake}`
    );
  }
}

// ================= 5. 見積もりの算数（純関数を直接叩く） =================
{
  // 事故の実寸: 1,098コマ × 20レイヤー × 76,800 = 1,686,528,000 バイト（約1.69GB）
  const perFrame20 = frameBytes(20, 8);
  check("5 1コマ20レイヤー8bit = 1,536,000 バイト", perFrame20 === 1536000, String(perFrame20));
  check("5 16bit は倍になる", frameBytes(20, 16) === perFrame20 * 2);
  const crash = checkFrameAlloc(1098, 20, 8);
  check("5 ★事故の実寸（1,098コマ×20レイヤー）は断られる", !crash.ok, `${crash.needBytes} バイト`);
  check("5 ★そのとき「何コマなら入るか」が出る", crash.maxFrames > 0 && crash.maxFrames < 1098, String(crash.maxFrames));
  check(
    "5 maxFrames は上限を超えない（境界: ちょうど入る枚数は通り、+1 は断られる）",
    checkFrameAlloc(crash.maxFrames, 20, 8).ok && !checkFrameAlloc(crash.maxFrames + 1, 20, 8).ok
  );
  // 反証: 小さい作品は通る（＝断り一辺倒になっていない＝「小さい作品の体感」を守る）
  check("5 反証: 3レイヤーの作品に100コマは通る", checkFrameAlloc(100, 3, 8).ok);
  check("5 反証: 1コマ貼り付けはどんな作品でも通る", checkFrameAlloc(1, 20, 16).ok);
  // 予算を下げると（E: 確保に失敗したあと）同じ操作が断られる
  check("5 ★予算を下げると同じ操作が断られる（E の効き）", !checkFrameAlloc(100, 3, 8, 1024).ok);
  check("5 上限は 512MiB", HEAVY_ALLOC_MAX_BYTES === 512 * 1024 * 1024);
  // 変な入力で例外を投げない（0レイヤー・負数）
  check("5 レイヤー0枚でも割り算で壊れない", checkFrameAlloc(5, 0, 8).ok);
  check("5 負のコマ数は0として扱う", checkFrameAlloc(-5, 20, 8).needBytes === 0);

  // E: 確保失敗の見分け（名前ではなく文面で見る）
  check("5 ★実際の事故の例外を確保失敗と判定する", isAllocFailure(new RangeError("Array buffer allocation failed")));
  check("5 Invalid typed array length も確保失敗", isAllocFailure(new RangeError("Invalid typed array length")));
  check("5 ★反証: 無関係な RangeError は確保失敗としない", !isAllocFailure(new RangeError("index out of range")));
  check("5 反証: 普通のエラーは確保失敗としない", !isAllocFailure(new Error("save failed")));
}

// ================= 6. finally / メーター / 確保失敗 =================
{
  const rh = bodyOf(ed, "runHeavy") ?? "";
  check("6 runHeavy が見つかる", rh !== "");
  check("6 ★どの抜け方でも入口を開ける（finally で endBusy）", /finally \{[\s\S]{0,400}?this\.endBusy\(\);/.test(rh));
  check("6 ★実行中は受け付けない（連打が原理的に起きない）", /if \(this\.busyKind\) return undefined;/.test(rh));
  check("6 表示は共通の実装に委ねる（仕組みを2つに増やさない）", /runWithBusy\(op, msg,/.test(rh));
  check("6 ★50ms を超えたら出す（PERF_MIN_MS と同じ値）", /HEAVY_BUSY_DELAY_MS = PERF_MIN_MS/.test(ed));
  check("6 busy.ts が遅延を引数で受ける（表示の実装は1つ）", /delayMs: number = BUSY_DELAY_MS/.test(busy) && /\}, delayMs\)/.test(busy));
  // D: メーターを重い操作の中で数え直さない
  const meter = bodyOf(ed, "updateSizeMeter") ?? "";
  check("6 ★メーターは重い操作の中では数えず予約する（D）", /if \(this\.busyKind === "heavy"\) \{[\s\S]{0,120}?this\.meterPending = true;[\s\S]{0,40}?return;/.test(meter));
  check("6 ★予約したぶんは終わってから1回だけ数える", /this\.meterPending = false;[\s\S]{0,60}?this\.updateSizeMeter\(\);/.test(rh));
  // E: 確保に失敗したら1回目で止める
  check("6 ★確保失敗を見分けて天井を下げる（E）", /isAllocFailure\(e\)/.test(rh) && /this\.heavyAllocBudget = Math\.max\(/.test(rh));
  check("6 ★確保失敗を利用者に伝える", /ed\.heavy\.outOfMemory\.msg/.test(ed));
  check("6 確保失敗をログに残す（W-10: 数値と決まった語だけ）", /\[V166\] alloc failed op=\$\{op\}/.test(edRaw));
  check("6 ★確保失敗以外の例外は握り潰さない", /throw e;/.test(rh));
  // 見た目でも無効に（属性ではなく class ＝復元し忘れが起きない）
  check("6 ★重い操作の間はボタンが無効に見える", /#screen-editor\.ed-busy button/.test(css));
  check("6 入口の閉鎖は最初から効く（pointer-events: none）", /#screen-editor\.ed-busy \{\s*\n\s*pointer-events: none;/.test(css));
}

// ================= 7. C（Alt）の自己修復と計測 =================
{
  check("7 ★イベントの altKey に合わせる関数がある", /private syncAltFromEvent\(altKey: boolean, where: string\)/.test(ed));
  const down = bodyOf(ed, "onPointerDownInner") ?? "";
  const move = bodyOf(ed, "onPointerMoveInner") ?? bodyOf(ed, "onPointerMove") ?? "";
  check("7 ★押した時に同期する", /syncAltFromEvent\(e\.altKey, "pointerdown"\)/.test(ed));
  check("7 ★動かした時に同期する（描いている最中に直る）", /syncAltFromEvent\(e\.altKey, "pointermove"\)/.test(ed));
  void down; void move;
  check("7 ★blur で修飾キーの状態を落とす", /blurHandler = \(\) => \{[\s\S]{0,900}?this\.altHeld = false;/.test(ed));
  check("7 ★候補1と候補2を見分ける数がログに出る", /altD=\$\{this\.altDownCount\} altU=\$\{this\.altUpCount\}/.test(edRaw));
  check("7 自己修復した回数も出る", /altFix=\$\{this\.altFixCount\}/.test(edRaw));
  check("7 ★普通のログにも兆候が出る（?inputlog なしで気づける）", /\[V166 C\] alt mismatch fixed/.test(edRaw));
  check("7 ★同じ知らせを何度も出さない（ログを埋めない）", /if \(this\.altFixCount === 1\)/.test(ed));
  // 壊すなリスト: Alt を止めていない（スポイトと OS 側の挙動に手を入れない）
  check(
    "7 ★Alt の keydown を preventDefault していない（スポイトを殺さない）",
    !/e\.key === "Alt"[\s\S]{0,200}?preventDefault/.test(ed)
  );
}

// ================= 8. i18n（7言語） =================
{
  const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
  const KEYS = [...edRaw.matchAll(/t\("(ed\.heavy\.[A-Za-z.]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(KEYS)];
  check("8 新しい文言のキーを拾えている", uniq.length >= 13, `${uniq.length}件`);
  for (const lang of LANGS) {
    const dict = read(`src/i18n/${lang}.ts`);
    const missing = uniq.filter((k) => !dict.includes(`"${k}"`));
    check(`8 ${lang} に全部ある`, missing.length === 0, missing.join(","));
  }
  // 断り文句の差し込み（{max}）が全言語にある＝「何コマ入るか」が消えていない
  for (const lang of LANGS) {
    const dict = read(`src/i18n/${lang}.ts`);
    const line = dict.split("\n").find((l) => l.includes('"ed.heavy.tooManyFrames.msg"')) ?? "";
    check(`8 ★${lang} の断り文句に {max} が入っている`, line.includes("{max}"));
  }
}

// ================= 9. Codex レビューで見つかった穴（塞いだまま保つ） =================
//
// ★どれも「見積もりを足したのに、確保のほうが先に起きていた」という同じ形の見落とし。
//  一度塞いでも、あとから `await` を1つ動かすだけで簡単に戻るので、順序を機械で固定する。
{
  // 高②: コピー側にも見積もりが要る（makeClip は貼り付けと同じ量を確保する）
  const copy = bodyOf(ed, "copySelectedFramesInner") ?? "";
  const iCopyGuard = copy.search(/allowBytes\(\s*need|clipCopyBytes\(/);
  const iWake = copy.indexOf("wakeFrame(");
  const iMake = copy.indexOf("makeClip(");
  check("9 ★コピーが写し取る量を見積もる（高②）", iCopyGuard >= 0);
  check(
    "9 ★コピーの見積もりが「起こす」「写し取る」より先",
    iCopyGuard >= 0 && iCopyGuard < iWake && iCopyGuard < iMake,
    `guard=${iCopyGuard} wake=${iWake} make=${iMake}`
  );

  // 高③: 展開（unpackClip）より先に断る
  const paste = bodyOf(ed, "pasteFramesInner") ?? "";
  const iUnpackGuard = paste.search(/allowBytes\(\s*\n?\s*clipUnpackedBytes\(/);
  const iUnpack = paste.indexOf("await unpackClip(");
  check("9 ★展開後の量を見積もる（高③）", iUnpackGuard >= 0);
  check(
    "9 ★その見積もりが unpackClip より先",
    iUnpackGuard >= 0 && iUnpackGuard < iUnpack,
    `guard=${iUnpackGuard} unpack=${iUnpack}`
  );

  // 高①: 開いたら必ず畳み直す（漏斗の外で走らせない）
  check("9 ★unpack したら finally で必ず畳み直す（高①）", /finally \{[\s\S]{0,160}?await packClip\(clip\);/.test(paste));
  check("9 ★投げっぱなしの packClip が残っていない", !/void packClip\(/.test(ed));

  // 高④: 16bit 昇格を織り込む（持ち込む色数を渡している）
  check("9 ★昇格を織り込んだ幅で見積もる（高④）", /estimateBits\(this\.project\.colorTable\.length, incomingColors, curBits\)/.test(ed));
  check("9 ★昇格ぶんの作り直しも予算から引く", /promotionExtraBytes\(this\.awakeFaceCount\(\)/.test(ed));
  check("9 ★貼り付けは持ち込む色数を渡す", /allowFrameAlloc\(4, clip\.palette\.length/.test(ed) && /allowFrameAlloc\(n, clip\.palette\.length/.test(ed));
  check("9 ★連番画像も持ち込む色数を渡す", /allowFrameAlloc\(n, src\.colorTable\.length/.test(ed));

  // 高⑤: 起こすぶんも予算に入れる／確認前の走査は read
  check("9 ★起こす面数を予算に足す（高⑤）", /const wake = wakeLayerIds\.length \? this\.asleepFaces\(wakeLayerIds\) : 0;/.test(ed));
  const scan = bodyOf(ed, "sharedScanOthersDiffer") ?? "";
  check(
    "9 ★確認より前の走査は \"read\"（控えを捨てない）",
    /wakeLayersAllFrames\(this\.project, \[id\], "read"\)/.test(scan),
    scan.slice(0, 0)
  );
  // 全コマ操作は起こす対象の id を必ず渡す（渡し忘れると wake 分が 0 に見える）
  for (const fn of ["deleteLayerInner", "mergeLayerDownInner", "toggleLayerSharedInner", "pasteLayerAllFramesInner", "deleteFolderWithContents"]) {
    const body = bodyOf(ed, fn) ?? "";
    check(`9 ${fn}: 起こす対象の id を見積もりへ渡している`, /allowBufferAlloc\([^)]*,\s*"[a-zA-Z.]+",\s*[^)]+\)/.test(body));
  }

  // 中: 同期処理でも「押せなくなった見た目」は描かれる（1拍譲る）
  const rh2 = bodyOf(ed, "runHeavy") ?? "";
  const iYield = rh2.indexOf("await yieldToPaint();");
  const iRun = rh2.indexOf("runWithBusy(op, msg,");
  check("9 ★中身を始める前に1拍譲る（同期処理でも見た目が描かれる）", iYield >= 0 && iYield < iRun);
  // ★隠れた窓で setTimeout が1秒にクランプされる罠（実測で踏んだ）。MessageChannel で避ける
  check("9 ★その1拍は setTimeout ではない（隠れた窓で1秒に伸びる）", /export function yieldToPaint/.test(busy) && /new MessageChannel\(\)/.test(busy));
  check("9 ★runHeavy が setTimeout で譲っていない", !/await new Promise\(\(r\) => setTimeout\(r, 0\)\);/.test(rh2));

  // 中: 連番画像の例外がダイアログの try/catch に届く
  check("9 ★onPlaceFrames を await する", /await editorCtx\.onPlaceFrames\(proj, transparentPaper\)/.test(read("src/main.ts")));

  // 低: 保存を型で締め出す／ログの操作名が中立
  check("9 ★busyKind の型から \"save\" を消した（方針を型で守る）", /private busyKind: "" \| "audio" \| "export" \| "heavy" = "";/.test(ed));
  check("9 ★beginBusy も \"save\" を受け取れない", /private beginBusy\(kind: "audio" \| "export" \| "heavy"\)/.test(ed));
  check("9 ログの操作名が固定の \"paste\" ではない", /\$\{where\} refused/.test(edRaw) && !/\[V166\] paste refused/.test(edRaw));
}

console.log(`v166 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
