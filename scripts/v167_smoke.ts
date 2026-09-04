// V167（同じ修飾キーの取り合いを断つ）の回帰ゲート。引数不要:
//   npx tsx scripts/v167_smoke.ts
//
// ★この回でいちばん怖いのは2つ:
//   ① **道具どうしの同キー巡回（M11-15）を巻き添えで殺す**
//      衝突判定を広げる回なので、広げすぎると「共存できる」規則が消える。
//      → 検査3 が全道具ペアで共存を確かめ、**3z がわざと壊して赤くなること**を実証する
//   ② **Alt＋クリックのスポイト（M16 K-4）自体を殺す**
//      K-1 は「同じキーに2役を持たせるな」であって、スポイトを消す機能ではない。
//      → 検査4 が既定プリセットに残っていることを固定
//
// 1. 取り合いの判定（純関数を全組み合わせで叩く・反証つき）
// 2. findConflict が取り合いを拾う（順序どちらでも）／既存の衝突判定を壊していない
// 3. ★道具どうしの同キー巡回は今までどおり共存できる ＋ 3z わざと壊すと赤くなる実証
// 4. 壊すなリスト（Alt＋クリックのスポイト・タップ機能そのもの）
// 5. K-2 の印（modifierClashMates）
// 6. K-3 スポイトの知らせと間引き（純関数・反証つき）
// 7. 配線の走査（断り文句の差し替え・印の描画・ログ・スポイトの経路）
// 8. i18n（7言語・差し込みの名前）
import fs from "node:fs";
import path from "node:path";
import {
  COMMANDS,
  BUILTIN_PRESETS,
  bindingKey,
  findConflict,
  modifierClash,
  modifierClashMates,
  modifierClashPartners,
  modLabel,
  sharedToolMates,
  activePreset,
  sanitizeKeysSettings,
  type KeyBinding,
  type CommandId,
  type Preset,
  type TapMod,
} from "../src/keymap";
import { shouldNoticePick, PICK_NOTICE_GAP_MS, TOAST_LIFETIME_MS } from "../src/editor/prefs";

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

const MODS: TapMod[] = ["Control", "Shift", "Alt"];
/** その修飾キー1つだけ＋クリック（＝取り合いになる形） */
const soloPtr = (m: TapMod, button: 0 | 1 | 2 = 0): KeyBinding => ({
  code: "",
  button,
  ...(m === "Control" ? { ctrl: true } : m === "Shift" ? { shift: true } : { alt: true }),
});
const tap = (m: TapMod): KeyBinding => ({ code: "", tap: m });

// ================= 1. 取り合いの判定（純関数） =================
{
  // ★事故そのもの: Alt（タップ）× Alt＋クリック
  check("1 ★Alt（タップ）と Alt＋クリックは取り合う（今回の事故）", modifierClash(tap("Alt"), soloPtr("Alt")) === "Alt");
  check("1 ★逆順でも同じ", modifierClash(soloPtr("Alt"), tap("Alt")) === "Alt");
  // 基準3: Alt だけの特別扱いにしない
  for (const m of MODS) {
    check(`1 ${modLabel(m)} でも取り合う（Alt だけの特別扱いにしない）`, modifierClash(tap(m), soloPtr(m)) === m);
    for (const btn of [0, 1, 2] as const)
      check(`1 ${modLabel(m)}＋ボタン${btn} でも取り合う`, modifierClash(tap(m), soloPtr(m, btn)) === m);
  }
  // ---- 反証（広げすぎていないこと） ----
  for (const m of MODS)
    for (const o of MODS)
      if (m !== o)
        check(
          `1 反証: ${modLabel(m)}（タップ）と ${modLabel(o)}＋クリックは取り合わない`,
          modifierClash(tap(m), soloPtr(o)) === null
        );
  // Ctrl+Alt＋クリックは Alt 単体のタップでは発動しない＝取り合わない
  const ctrlAltPtr: KeyBinding = { code: "", button: 0, ctrl: true, alt: true };
  check("1 ★反証: Ctrl+Alt＋クリックは Alt のタップと取り合わない", modifierClash(tap("Alt"), ctrlAltPtr) === null);
  // 素のクリック（修飾なし）とも取り合わない
  check("1 反証: 修飾なしのクリックとは取り合わない", modifierClash(tap("Alt"), { code: "", button: 0 }) === null);
  // キーボードの組み合わせ（Alt+P）は指が別＝ペンを置いても発動しない
  check("1 ★反証: Alt+P（キーボード）とは取り合わない", modifierClash(tap("Alt"), { code: "KeyP", alt: true }) === null);
  // タップ同士・ポインタ同士は modifierClash の担当ではない（字面比較が拾う）
  check("1 反証: タップ同士は modifierClash では拾わない（字面が一致するため）", modifierClash(tap("Alt"), tap("Alt")) === null);
  check("1 反証: ポインタ同士は modifierClash では拾わない", modifierClash(soloPtr("Alt"), soloPtr("Alt")) === null);
  check("1 その字面同士はちゃんと一致する（従来の判定が拾う）", bindingKey(tap("Alt")) === bindingKey(tap("Alt")) && bindingKey(soloPtr("Alt")) === bindingKey(soloPtr("Alt")));
  check("1 タップと＋クリックの字面は今も重ならない（V165 の前提は保たれている）", bindingKey(tap("Alt")) !== bindingKey(soloPtr("Alt")));
}

// ================= 2. findConflict が取り合いを拾う =================
function presetWith(bindings: Record<string, KeyBinding>): Preset {
  return { id: "test", name: "t", bindings: bindings as Preset["bindings"] };
}
{
  // 基準1: Alt＋クリックがスポイトのまま、Alt のタップを登録しようとすると断られる
  const p1 = presetWith({ "edit.pickColor": soloPtr("Alt") });
  check(
    "2 ★スポイトが Alt＋クリックのとき、Alt のタップは断られる（基準1）",
    findConflict(p1, tap("Alt"), "edit.undo") === "edit.pickColor"
  );
  // 基準2: 逆順（先にタップを入れてから ＋クリックを入れる）
  const p2 = presetWith({ "edit.undo": tap("Alt") });
  check(
    "2 ★先に Alt のタップがあるとき、Alt＋クリックは断られる（基準2）",
    findConflict(p2, soloPtr("Alt"), "edit.pickColor") === "edit.undo"
  );
  // 基準3: Shift・Ctrl も同じ
  for (const m of MODS) {
    const pm = presetWith({ "edit.pickColor": soloPtr(m) });
    check(`2 ${modLabel(m)} でも断られる`, findConflict(pm, tap(m), "edit.undo") === "edit.pickColor");
  }
  // 反証: 取り合わない組み合わせは通る（断り一辺倒になっていない）
  const p3 = presetWith({ "edit.pickColor": soloPtr("Alt") });
  check("2 反証: Shift のタップは通る（別のキー）", findConflict(p3, tap("Shift"), "edit.undo") === null);
  check("2 反証: Alt+P（キーボード）は通る", findConflict(p3, { code: "KeyP", alt: true }, "edit.undo") === null);
  // 従来の「字面が同じ」衝突は今までどおり
  const p4 = presetWith({ "edit.undo": { code: "KeyZ", ctrl: true } });
  check("2 従来の衝突（同じ字面）は今までどおり拾う", findConflict(p4, { code: "KeyZ", ctrl: true }, "edit.redo") === "edit.undo");
  check("2 自分自身は衝突にしない", findConflict(p4, { code: "KeyZ", ctrl: true }, "edit.undo") === null);
}

// ================= 3. ★道具どうしの同キー巡回は壊れていない（基準4） =================
const TOOLS = COMMANDS.filter((c) => c.id.startsWith("tool.")).map((c) => c.id as CommandId);
/** 判定関数を差し替えられる形にして、3z が「壊した版」を同じ検査に掛けられるようにする */
function toolCoexistOk(fc: typeof findConflict): boolean {
  if (TOOLS.length < 2) return false;
  const [a, b] = TOOLS;
  const key: KeyBinding = { code: "KeyQ" };
  const p = presetWith({ [a]: key });
  return fc(p, key, b) === null; // 道具どうしは衝突しない＝共存できる
}
{
  check("3 道具コマンドが2つ以上ある（この検査が成立する）", TOOLS.length >= 2, `${TOOLS.length}件`);
  check("3 ★道具どうしは同じキーで共存できる（M11-15・基準4）", toolCoexistOk(findConflict));
  // 全ペアで確かめる（1組だけ通って安心しない）
  let coex = 0;
  for (const a of TOOLS)
    for (const b of TOOLS) {
      if (a === b) continue;
      const key: KeyBinding = { code: "KeyQ" };
      if (findConflict(presetWith({ [a]: key }), key, b) === null) coex++;
    }
  check("3 ★全道具ペアで共存できる", coex === TOOLS.length * (TOOLS.length - 1), `${coex}/${TOOLS.length * (TOOLS.length - 1)}`);
  // 道具どうしでも「取り合い」は免除しない（ペンを置いた瞬間に取られるのは道具でも同じ）
  const [ta, tb] = TOOLS;
  check(
    "3 ★道具どうしでも修飾キーの取り合いは免除しない",
    findConflict(presetWith({ [ta]: soloPtr("Alt") }), tap("Alt"), tb) === ta
  );
  // 道具以外が絡む従来の衝突は今までどおり
  check(
    "3 道具と道具以外は従来どおり衝突",
    findConflict(presetWith({ [ta]: { code: "KeyQ" } }), { code: "KeyQ" }, "edit.undo") === ta
  );
  // sharedToolMates（画面の🔁表示）も従来どおり
  const shared = presetWith({ [ta]: { code: "KeyQ" }, [tb]: { code: "KeyQ" } });
  check("3 🔁「同キー共有中」の一覧は従来どおり出る", sharedToolMates(shared, ta).includes(tb));
}

// ---- 3z. ★わざと壊すと赤くなることの実証（基準4 の網が効いていること） ----
{
  // 「共存できる」規則を落とした版（＝V167 で広げすぎたときに起きる壊れ方）
  const broken: typeof findConflict = (preset, b, exceptId) => {
    const key = bindingKey(b);
    for (const [id, cur] of Object.entries(preset.bindings)) {
      if (!cur || id === exceptId) continue;
      if (bindingKey(cur as KeyBinding) !== key && modifierClash(b, cur as KeyBinding) === null) continue;
      return id as CommandId; // ★道具どうしの免除を**わざと外した**
    }
    return null;
  };
  check(
    "3z ★共存の規則を外すと検査3 が赤くなる（網が効いていることの実証）",
    toolCoexistOk(findConflict) && !toolCoexistOk(broken),
    `本物=${toolCoexistOk(findConflict)} 壊した版=${toolCoexistOk(broken)}`
  );
}

// ================= 4. 壊すなリスト =================
{
  const km = read("src/keymap.ts");
  check("4 ★Alt＋クリックのスポイトが既定に残っている（基準8）", /"edit\.pickColor": \{ code: "", button: 0, alt: true \}/.test(km));
  // 既定プリセットは**タップを1つも持たない**（V165 の約束）＝既定では取り合いが起きない
  for (const p of BUILTIN_PRESETS) {
    const taps = Object.values(p.bindings).filter((b) => b && (b as KeyBinding).tap);
    check(`4 組み込み「${p.id}」はタップを持たない＝既定では取り合いが起きない`, taps.length === 0);
    // 既定プリセットの中に取り合いが1組も無いことを全数で確かめる
    let clashes = 0;
    for (const id of Object.keys(p.bindings)) clashes += modifierClashMates(p, id as CommandId).length;
    check(`4 ★組み込み「${p.id}」に取り合いが1組も無い`, clashes === 0, `${clashes}件`);
  }
  // 保存が無い状態（＝新規の利用者）でも同じ
  const fresh = activePreset(sanitizeKeysSettings(undefined));
  let freshClashes = 0;
  for (const id of Object.keys(fresh.bindings)) freshClashes += modifierClashMates(fresh, id as CommandId).length;
  check("4 ★保存が無い状態でも取り合いはゼロ", freshClashes === 0, `${freshClashes}件`);
}

// ================= 5. K-2 の印（すでに二重の設定） =================
{
  // 作者の実際の設定を再現する（元に戻す＝Alt タップ／色を拾う＝Alt＋クリック）
  const authors = presetWith({ "edit.undo": tap("Alt"), "edit.pickColor": soloPtr("Alt") });
  check("5 ★作者の設定で「元に戻す」側に印が出る", modifierClashMates(authors, "edit.undo").includes("edit.pickColor"));
  check("5 ★「色を拾う」側にも印が出る（片方だけに出ない）", modifierClashMates(authors, "edit.pickColor").includes("edit.undo"));
  // 反証: 取り合っていない設定には印が出ない
  const okPreset = presetWith({ "edit.undo": tap("Shift"), "edit.pickColor": soloPtr("Alt") });
  check("5 反証: 取り合っていなければ印は出ない", modifierClashMates(okPreset, "edit.undo").length === 0);
  // ★黙って外さない: 判定関数は preset を読むだけ（書き換えない）
  const before = JSON.stringify(authors.bindings);
  modifierClashMates(authors, "edit.undo");
  modifierClashMates(authors, "edit.pickColor");
  check("5 ★印を出しても割り当ては変わらない（黙って外さない・基準5）", JSON.stringify(authors.bindings) === before);
}

// ================= 6. K-3 スポイトの知らせと間引き =================
{
  check("6 色が変わったら知らせる", shouldNoticePick("tool", "#111111", "#222222", -Infinity, 1000));
  check("6 ★自分で選んだ経路（道具）は、同じ色を拾っても知らせない", !shouldNoticePick("tool", "#222222", "#222222", -Infinity, 1000));
  check("6 キー経由も同じ（自分で選んだ経路）", !shouldNoticePick("key", "#222222", "#222222", -Infinity, 1000));
  // ★ここが今回の要点。事故は「色が変わらないまま黙って食われる」ことがあり得る
  check(
    "6 ★頼んでいない経路（Alt＋クリック）は、色が変わらなくても知らせる",
    shouldNoticePick("pointer", "#222222", "#222222", -Infinity, 1000)
  );
  check("6 ★直前の知らせから間が空いていなければ知らせない", !shouldNoticePick("tool", "#111111", "#222222", 1000, 1000 + PICK_NOTICE_GAP_MS - 1));
  check("6 ★時間の間引きはポインタ経路にも効く（言いっぱなしにしない）", !shouldNoticePick("pointer", "#111111", "#222222", 1000, 1000 + PICK_NOTICE_GAP_MS - 1));
  check("6 間が空けば知らせる（境界ちょうど）", shouldNoticePick("tool", "#111111", "#222222", 1000, 1000 + PICK_NOTICE_GAP_MS));
  check("6 未設定（\"\"）から拾ったら知らせる", shouldNoticePick("tool", "", "#222222", -Infinity, 0));
  // ★Codex 指摘（中）で 1200ms から上げた。トーストは 3200ms 残って**積み上がる**ので、
  //  間引きが寿命より短いと画面に2〜3個居座る。**同時に1つより多く出ない**ことを値で保証する
  check("6 ★間引きはトーストの寿命以上（積み上がらない）", PICK_NOTICE_GAP_MS >= TOAST_LIFETIME_MS, `gap=${PICK_NOTICE_GAP_MS} life=${TOAST_LIFETIME_MS}`);
  check("6 トーストの寿命の写しが main.ts と合っている", TOAST_LIFETIME_MS === 3200 && /\}, 3200\);/.test(read("src/main.ts")));
  // ★連続で拾う人の身になった検査（基準6「連続で拾っても邪魔にならない」）。
  //  数を決め打ちせず、**守りたい性質**を確かめる: 知らせは必ず `PICK_NOTICE_GAP_MS` 以上あく。
  //  0.2秒おきに10回（＝1.8秒ぶん）拾うと、10回ではなく2回に減る
  {
    const at: number[] = [];
    let last = -Infinity;
    let prev = "";
    for (let i = 0; i < 10; i++) {
      const now = i * 200;
      const next = `#${String(i).repeat(6)}`; // 毎回違う色（＝色の条件では止まらない）
      if (shouldNoticePick("pointer", prev, next, last, now)) {
        at.push(now);
        last = now;
      }
      prev = next;
    }
    check("6 ★0.2秒おきに10回拾っても知らせは大きく減る（基準6）", at.length <= 2, `${at.length}回 at=${at.join(",")}`);
    const gaps = at.slice(1).map((v, i) => v - at[i]);
    check("6 ★知らせどうしは必ず 1200ms 以上あく", gaps.every((g) => g >= PICK_NOTICE_GAP_MS), gaps.join(","));
  }
  // 反証: 十分に間を空ければ毎回出る（間引きが強すぎて永久に出ない、ではない）
  {
    let shown = 0;
    let last = -Infinity;
    let prev = "";
    for (let i = 0; i < 5; i++) {
      const now = i * 5000;
      const next = `#${String(i).repeat(6)}`;
      if (shouldNoticePick("tool", prev, next, last, now)) {
        shown++;
        last = now;
      }
      prev = next;
    }
    check("6 反証: 5秒おきならその都度出る（間引きが強すぎて永久に出ない、ではない）", shown === 5, `${shown}回`);
  }
}

// ================= 7. 配線の走査 =================
{
  const mainTs = read("src/main.ts");
  const edRaw = read("src/editor/editor.ts");
  const ed = edRaw.replace(/^[ \t]*\/\/.*$/gm, ""); // 自分のコメントに当たらないように（V165 の反省）
  const css = read("src/styles.css");

  // K-1: 取り合いのときだけ文面を差し替える（流れは既存の「置き換えますか？」のまま）
  check("7 ★取り合い専用の文面へ差し替えている", /const clash = other \? modifierClash\(b, other as KeyBinding\) : null;/.test(mainTs));
  check("7 ★理由が読める文面を使う", /keys\.conflict\.modifier\.msg/.test(mainTs));
  check("7 従来の文面も残っている（取り合い以外は今までどおり）", /keys\.conflict\.replace\.msg/.test(mainTs));
  check("7 ★新しい断り方を作っていない（既存の confirmDialog に乗せる）", /const ok = await confirmDialog\(msg\);/.test(mainTs));

  // K-2: 行の印
  check("7 ★行に印を出す（km-clash）", /row\.classList\.add\("km-clash"\)/.test(mainTs));
  check("7 ★印に理由を添える", /keys\.row\.clash\.msg/.test(mainTs));
  check("7 印の見た目がある（🔁 とは別色）", /\.km-row\.km-clash/.test(css) && /\.km-clash-note/.test(css));
  check("7 ★黙って外していない（印の描画で delete していない）", !/km-clash[\s\S]{0,600}?delete cur\.bindings/.test(mainTs));

  // K-3: スポイトの知らせ
  check("7 ★スポイトの知らせは1か所（pickColorAt）に集約", /private noticePick\(/.test(ed) && /this\.noticePick\(prevHex, via, keys\);/.test(ed));
  check("7 ★間引きの規則は純関数（prefs.ts）に置く", /shouldNoticePick\(via, prevHex, next, this\.lastPickNoticeAt, performance\.now\(\)\)/.test(ed));
  check("7 ★Alt＋クリック経路は押した組み合わせを名指しする", /"pointer", keyLabel\(bindingFromPointer\(e\)\)/.test(ed));
  check("7 スポイト道具の経路も知らせる（既定の via=\"tool\"）", /private pickColorAt\(pt: \{ x: number; y: number \}, via: "tool" \| "pointer" \| "key" = "tool"/.test(ed));
  check("7 ★ツールを切り替えない性質は変えていない（M16 K-4）", /if \(id === "edit\.pickColor"\) \{[\s\S]{0,320}?return;/.test(ed) && !/if \(id === "edit\.pickColor"\) \{[\s\S]{0,320}?setTool/.test(ed));

  // K-4: ログ
  check("7 ★V166 の自己修復のログを残している", /\[V166 C\] alt mismatch fixed/.test(edRaw));
  check("7 ★釣り合わないまま終わったら1行残す", /\[V167 C\] alt unbalanced down=/.test(edRaw));
  check("7 釣り合っているときは書かない", /if \(this\.altDownCount !== this\.altUpCount\) \{/.test(ed));
  check("7 ログに作品名・パスを書いていない（W-10: 数値と決まった語だけ）", /alt unbalanced down=\$\{this\.altDownCount\} up=\$\{this\.altUpCount\} fix=\$\{this\.altFixCount\}/.test(edRaw));

  // V166 の漏斗・自己修復に触っていない（壊すなリスト）
  check("7 V166 の自己修復（イベントに合わせる）が残っている", /syncAltFromEvent\(e\.altKey, "pointermove"\)/.test(ed));
  check("7 V166 の漏斗が残っている", /async runHeavy<T>\(/.test(ed));
}

// ================= 8. i18n（7言語） =================
{
  const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
  const KEYS = ["keys.conflict.modifier.msg", "keys.row.clash.msg", "ed.pick.done.toast", "ed.pick.byKeys.toast"];
  // 差し込みの名前は**呼ぶ側と辞書で一致していないと画面に `{mod}` がそのまま出る**（型では捕まらない）
  const NEEDED: Record<string, string[]> = {
    "keys.conflict.modifier.msg": ["{mod}", "{cmd}", "{otherKey}", "{key}"],
    "keys.row.clash.msg": ["{mod}", "{names}"],
    "ed.pick.done.toast": ["{color}"],
    "ed.pick.byKeys.toast": ["{keys}", "{color}"],
  };
  for (const lang of LANGS) {
    const dict = read(`src/i18n/${lang}.ts`);
    for (const k of KEYS) {
      const line = dict.split("\n").find((l) => l.includes(`"${k}"`));
      check(`8 ${lang} に ${k} がある`, !!line);
      if (!line) continue;
      const missing = NEEDED[k].filter((ph) => !line.includes(ph));
      check(`8 ★${lang} ${k} の差し込みが揃っている`, missing.length === 0, missing.join(","));
    }
  }
}

// ================= 8b. Codex 指摘への対応（塞いだまま保つ） =================
{
  const ed = read("src/editor/editor.ts").replace(/^[ \t]*\/\/.*$/gm, "");
  const mainTs = read("src/main.ts");
  // 中②: 透明を拾ったとき「（）」にならない
  check("8b ★透明を拾っても空欄にならない（Codex 中②）", /next === "" \? t\("ed\.color\.transparent\.title"\)/.test(ed));
  check("8b その言い方は既存のものを借りている", /"ed\.color\.transparent\.title"/.test(read("src/i18n/ja.ts")));
  // 低④: 取り合う相手が複数でも全部消す
  check("8b ★取り合いの相手を全部挙げる（Codex 低④）", /clashAll = modifierClashPartners\(currentPreset\(\), b, cmd\);/.test(mainTs));
  check("8b ★取り合いは全部消す（1つだけ消して残さない）", /if \(clashAll\.length\) for \(const id of clashAll\) delete cur\.bindings\[id\];/.test(mainTs));
  check("8b 取り合い以外は従来どおり1つだけ消す", /else if \(conflict\) delete cur\.bindings\[conflict\];/.test(mainTs));
  // 相手が3つある設定でも全部返る
  const many = presetWith({
    "edit.pickColor": soloPtr("Alt", 0),
    "edit.copy": soloPtr("Alt", 1),
    "edit.paste": soloPtr("Alt", 2),
    "edit.redo": { code: "KeyY", ctrl: true },
  });
  const partners = modifierClashPartners(many, tap("Alt"), "edit.undo");
  check("8b ★取り合う相手が3つあれば3つとも返る", partners.length === 3, partners.join(","));
  check("8b 取り合わないものは含まれない", !partners.includes("edit.redo" as CommandId));
}

// ================= 9. ★広げすぎていないことの総当たり =================
//
// 検査1〜3 は「こう書いたらこう判定される」を1件ずつ確かめている。だが今回の変更は
// **既存の判定を広げる**もので、いちばん怖いのは「気づかないうちに別の組み合わせまで
// 断るようになる」こと。手で並べた例では、並べ忘れた組み合わせを見逃す。
//
// そこで、**既定プリセットの全コマンド × あり得る割り当ての全組み合わせ**で
// V167 前（字面比較だけ）と後の判定差を数え、
//   ・新たに「通す」ようになったものが**1件も無い**（＝守りが緩んでいない）
//   ・新たに「断る」ようになったものが**すべて `modifierClash` で説明できる**
// ことを確かめる。説明できない差が1件でも出たら赤。
{
  /** V167 前の判定を再現（字面比較だけ・道具どうしは共存） */
  const oldFindConflict = (preset: Preset, b: KeyBinding, exceptId?: CommandId): CommandId | null => {
    const key = bindingKey(b);
    const isTool = (id: string) => id.startsWith("tool.");
    for (const [id, cur] of Object.entries(preset.bindings)) {
      if (!cur || id === exceptId) continue;
      if (bindingKey(cur as KeyBinding) !== key) continue;
      if (exceptId && isTool(exceptId) && isTool(id)) continue;
      return id as CommandId;
    }
    return null;
  };

  const CAND: KeyBinding[] = [];
  for (const m of MODS) CAND.push(tap(m));
  for (const m of MODS) for (const btn of [0, 1, 2] as const) CAND.push(soloPtr(m, btn));
  CAND.push({ code: "", button: 0, ctrl: true, alt: true });   // 修飾2つ＋クリック
  CAND.push({ code: "", button: 0, shift: true, alt: true });
  for (const code of ["KeyZ", "KeyP", "KeyI", "Delete", "Enter"])
    for (const mods of [{}, { ctrl: true }, { shift: true }, { alt: true }, { ctrl: true, shift: true }])
      CAND.push({ code, ...mods });

  let newlyRefused = 0;
  let newlyAllowed = 0;
  let unexplained = 0;
  for (const preset of BUILTIN_PRESETS)
    for (const cmd of Object.keys(preset.bindings) as CommandId[])
      for (const b of CAND) {
        const before = oldFindConflict(preset, b, cmd);
        const after = findConflict(preset, b, cmd);
        if (before === after) continue;
        if (before === null && after !== null) {
          newlyRefused++;
          if (modifierClash(b, preset.bindings[after] as KeyBinding) === null) unexplained++;
        } else {
          newlyAllowed++;
        }
      }
  check("9 ★新たに「通す」ようになった判定が1件も無い（守りが緩んでいない）", newlyAllowed === 0, `${newlyAllowed}件`);
  check("9 ★新たに断る判定はすべて「取り合い」で説明できる", unexplained === 0, `説明できない差 ${unexplained}件`);
  check("9 実際に判定が変わった組み合わせがある（この総当たりが空振りしていない）", newlyRefused > 0, `${newlyRefused}件`);
}

console.log(`v167 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
