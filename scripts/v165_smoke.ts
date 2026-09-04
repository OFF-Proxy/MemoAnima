// V165（見つかる残り＋キーの回）の回帰ゲート。引数不要:
//   npx tsx scripts/v165_smoke.ts
//
// ★この回でいちばん怖いのは2つ:
//   ① **Ctrl+○○ が割り当てられなくなる**（D-4 の存在理由が、それを壊さないこと）
//      → 検査2 で「単体タップの表キーが既存のどれとも衝突しない」ことを全数で確かめ、
//        検査3 で Alt＋クリック（M16 K-4）と Alt タップが**別の引き当て**になることを示す
//   ② 既定の挙動が変わること（D-4 は割り当てない限り何も起きない）
//      → 検査1 で既定プリセットに tap 割り当てが1つも無いことを固定
//
// 1. 既定は無変更（tap の割り当てゼロ・引き当て表に |T… が現れない）
// 2. 表キーの衝突なし（tap × 全 code / 全ポインタ）＋ 反証（tap 同士は正しく一致する）
// 3. sanitize（未知の tap 値・壊れた設定で落ちず、その1件だけ捨てる）
// 4. keyLabel（「Alt（タップ）」）
// 5. 配線の走査（D-1〜D-4 の実装がある・壊すなリストが生きている）
import fs from "node:fs";
import path from "node:path";
import {
  COMMANDS,
  BUILTIN_PRESETS,
  RESERVED_CODES,
  bindingKey,
  buildLookup,
  eventKey,
  pointerEventKey,
  tapEventKey,
  isTapMod,
  keyLabel,
  sanitizeKeysSettings,
  activePreset,
  ModTapWatcher,
  MOD_TAP_MS,
  isHoldOnlyCommand,
  type KeyBinding,
  type TapMod,
} from "../src/keymap";

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
const TAPS: TapMod[] = ["Control", "Shift", "Alt"];

// ================= 1. 既定は無変更（オプトイン） =================
{
  for (const p of BUILTIN_PRESETS) {
    const taps = Object.values(p.bindings).filter((b) => b && (b as KeyBinding).tap);
    check(`1 ★組み込み「${p.id}」に単体タップの割り当てが無い（既定では何も起きない）`, taps.length === 0);
    const lookup = buildLookup(p);
    const tapKeys = [...lookup.keys()].filter((k) => k.startsWith("|T"));
    check(`1 ★「${p.id}」の引き当て表に |T… が現れない`, tapKeys.length === 0, tapKeys.join(","));
  }
  // 既定の settings（保存が無い状態）でも同じ
  const fresh = sanitizeKeysSettings(undefined);
  const lookup = buildLookup(activePreset(fresh));
  check("1 保存が無い状態でも tap の割り当てはゼロ", [...lookup.keys()].every((k) => !k.startsWith("|T")));
}

// ================= 2. ★表キーが既存のどれとも衝突しない（Ctrl+○○ を壊さない） =================
{
  const tapKeys = TAPS.map((k) => tapEventKey(k));
  check("2 tap の表キーは3つとも別物", new Set(tapKeys).size === 3, tapKeys.join(","));
  // 全コマンド × 主要な code × 修飾の全組み合わせで、tap の表キーと**一度も**衝突しない
  const CODES = [
    "KeyS", "KeyZ", "KeyY", "KeyC", "KeyV", "KeyX", "KeyH", "KeyA", "Comma", "Delete",
    "ArrowLeft", "F1", "Numpad0", "BracketLeft", "IntlYen",
  ];
  let clashes = 0;
  let cases = 0;
  for (const code of CODES) {
    for (const ctrl of [false, true])
      for (const shift of [false, true])
        for (const alt of [false, true]) {
          const b: KeyBinding = { code };
          if (ctrl) b.ctrl = true;
          if (shift) b.shift = true;
          if (alt) b.alt = true;
          cases++;
          if (tapKeys.includes(bindingKey(b))) clashes++;
        }
  }
  check(`2 ★キーボード割り当て ${cases} 通りが tap と衝突しない`, clashes === 0, `${clashes} 件`);
  // ポインタ割り当て（M16 K-4・Alt＋クリックのスポイトを含む）とも衝突しない
  let pClash = 0;
  for (const button of [0, 1, 2] as const)
    for (const ctrl of [false, true])
      for (const shift of [false, true])
        for (const alt of [false, true]) {
          const b: KeyBinding = { code: "", button };
          if (ctrl) b.ctrl = true;
          if (shift) b.shift = true;
          if (alt) b.alt = true;
          if (tapKeys.includes(bindingKey(b))) pClash++;
        }
  check("2 ★ポインタ割り当て 24 通りが tap と衝突しない", pClash === 0, `${pClash} 件`);
  // 実イベントの引き当て: Ctrl+S の keydown は tap の表キーにならない（＝Ctrl+S は今までどおり）
  const ctrlS = eventKey({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "KeyS" } as KeyboardEvent);
  check("2 ★Ctrl+S の引き当てキーは従来のまま", ctrlS === "C|KeyS" && !tapKeys.includes(ctrlS), ctrlS);
  // ★反証: tap の表キー同士はちゃんと一致する（上の「衝突しない」が空振りでない証明）
  check("2 反証: bindingKey({tap:'Alt'}) は tapEventKey('Alt') と一致", bindingKey({ code: "", tap: "Alt" }) === tapEventKey("Alt"));
  check("2 反証: 別の修飾のタップは別のキー", bindingKey({ code: "", tap: "Alt" }) !== bindingKey({ code: "", tap: "Control" }));
  // isTapMod
  check("3 isTapMod は Ctrl/Shift/Alt だけ", TAPS.every(isTapMod) && !isTapMod("Meta") && !isTapMod("a") && !isTapMod(""));
}

// ================= 3. Alt＋クリックのスポイト（M16 K-4）と混ざらない =================
{
  const eyedrop: KeyBinding = { code: "", button: 0, alt: true };
  const altTap: KeyBinding = { code: "", tap: "Alt" };
  check("3 ★Alt＋クリックと Alt タップは別の引き当て", bindingKey(eyedrop) !== bindingKey(altTap), `${bindingKey(eyedrop)} / ${bindingKey(altTap)}`);
  // pointerdown（Alt＋左クリック）の実イベントは従来どおりポインタ側に当たる
  const pk = pointerEventKey({ ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, button: 0 });
  check("3 ★Alt＋クリックの実イベントは従来のキー（A|B0）", pk === "A|B0" && pk === bindingKey(eyedrop), pk);
  // 両方を同じプリセットに入れても共存する（別コマンドとして引ける）
  const preset = {
    id: "t", name: "t",
    bindings: { "edit.pickColor": eyedrop, "edit.undo": altTap } as Record<string, KeyBinding>,
  };
  const lookup = buildLookup(preset as unknown as Parameters<typeof buildLookup>[0]);
  check("3 ★同じプリセットで Alt＋クリックと Alt タップが共存する",
    lookup.get("A|B0")?.[0] === "edit.pickColor" && lookup.get(tapEventKey("Alt"))?.[0] === "edit.undo");
}

// ================= 4. sanitize（壊れた設定で落ちず、その1件だけ捨てる） =================
{
  const mk = (bindings: Record<string, unknown>) => ({
    activeId: "u1",
    presets: [{ id: "u1", name: "u", bindings }],
  });
  // 正しい tap は残る
  const ok = sanitizeKeysSettings(mk({ "edit.undo": { code: "", tap: "Alt" } }));
  check("4 正しい tap は読める", ok.presets[0].bindings["edit.undo"]?.tap === "Alt");
  // ★未知の tap 値・型違いは**その1件だけ**捨てて、他の割り当ては生きる
  const broken = sanitizeKeysSettings(
    mk({
      "edit.undo": { code: "", tap: "Meta" },      // 知らない修飾
      "edit.redo": { code: "", tap: 7 },            // 型違い
      "edit.copy": { code: "", tap: "alt" },        // 大小違い
      "file.save": { code: "KeyS", ctrl: true },    // 普通の割り当て（生き残るべき）
    })
  );
  check("4 ★未知の tap は捨てる", !broken.presets[0].bindings["edit.undo"] && !broken.presets[0].bindings["edit.redo"] && !broken.presets[0].bindings["edit.copy"]);
  check("4 ★壊れた項目があっても Ctrl+S は生き残る", broken.presets[0].bindings["file.save"]?.code === "KeyS");
  // tap は修飾フラグを持たない形に正規化される（それ自体が修飾キー）
  const norm = sanitizeKeysSettings(mk({ "edit.undo": { code: "KeyZ", tap: "Shift", ctrl: true } }));
  const b = norm.presets[0].bindings["edit.undo"];
  check("4 tap は code/修飾を落として正規化される", b?.tap === "Shift" && b?.code === "" && !b?.ctrl);
  // 落ちない（未知のキーが丸ごと混ざった設定）
  const weird = sanitizeKeysSettings({ activeId: 5, presets: "no", extra: { tap: "Alt" } });
  check("4 ★壊れた keys 全体でも落ちず既定へ", weird.activeId === "standard" && weird.presets.length === 0);
  // 予約キーの扱いは従来どおり（tap は予約と無関係）
  check("4 予約キーの規則は不変", RESERVED_CODES.has("Space") && COMMANDS.length > 0);
}

// ================= 4b. ModTapWatcher（Codex 指摘①⑤の本体・時計を差し替えて全条件を叩く） =================
{
  let now = 0;
  const w = new ModTapWatcher(() => now);
  const tap = (key: string, held: number, opts: { repeat?: boolean; blocked?: boolean } = {}) => {
    w.down(key, opts);
    now += held;
    return w.up(key);
  };
  check("4b ふつうのタップは発動する", tap("Alt", 100) === "Alt");
  check(`4b しきい値ちょうど（${MOD_TAP_MS}ms）は発動する`, tap("Alt", MOD_TAP_MS) === "Alt");
  check("4b しきい値を超えたら発動しない", tap("Alt", MOD_TAP_MS + 1) === null);
  check("4b ★押しっぱなし（repeat）は候補にしない", tap("Alt", 10, { repeat: true }) === null);
  check("4b ★描画中など blocked のときは候補にしない（Codex 指摘①）", tap("Alt", 10, { blocked: true }) === null);
  // ★Codex 指摘①の本体: 描画中に押して、ペンを離してから修飾キーを離す
  {
    const v = new ModTapWatcher(() => now);
    v.down("Alt", { blocked: true }); // 描いている最中に押した
    now += 50;
    v.cancel(); // （ポインタが上がっても候補は戻らない）
    now += 50;
    check("4b ★描きながら押した修飾キーは、ペンを先に離しても発動しない", v.up("Alt") === null);
  }
  {
    const v = new ModTapWatcher(() => now);
    v.down("Alt");
    v.down("KeyS"); // 組み合わせ
    check("4b 他のキーが挟まると発動しない", v.up("Alt") === null);
  }
  {
    const v = new ModTapWatcher(() => now);
    v.down("Control");
    v.down("Alt"); // 2つ目の修飾キー
    check("4b 2つ目の修飾キーで候補が壊れる", v.up("Alt") === null && v.up("Control") === null);
  }
  {
    const v = new ModTapWatcher(() => now);
    v.down("Alt");
    v.cancel(); // pointerdown / blur
    check("4b ★cancel（ポインタ・blur）で発動しない", v.up("Alt") === null);
  }
  {
    const v = new ModTapWatcher(() => now);
    v.down("Alt");
    check("4b 違う修飾キーの keyup では発動しない", v.up("Shift") === null);
    check("4b 判定は1回きり（候補は畳まれる）", v.up("Alt") === null);
  }
  check("4b Meta（Windows キー）は候補にならない", tap("Meta", 10) === null);
  check("4b pending は候補の有無を返す", (() => { const v = new ModTapWatcher(() => now); v.down("Shift"); const p = v.pending; v.cancel(); return p === "Shift" && v.pending === null; })());
}

// ================= 4c. 押しっぱなし専用の操作はタップに割り当てない（Codex 指摘④） =================
{
  check("4c ★xform.peek は hold 専用として印が付いている", isHoldOnlyCommand("xform.peek"));
  check("4c ふつうの操作は hold 専用ではない", !isHoldOnlyCommand("edit.undo") && !isHoldOnlyCommand("tool.pen"));
  // 反証: 印が全部に付いているわけではない（走査が空振りしていない）
  check("4c 反証: hold 専用は1つだけ", COMMANDS.filter((c) => isHoldOnlyCommand(c.id)).length === 1);
}

// ================= 5. keyLabel =================
{
  // t() は辞書が読めない環境では [key] を返すことがあるので、**キー名が入っていること**だけ見る
  const lab = keyLabel({ code: "", tap: "Alt" });
  check("5 タップの表示に Alt が入る", lab.includes("Alt") || lab.includes("keys.tap.label"), lab);
  // Codex 指摘⑦: KeyboardEvent.key は "Control" だが、画面と案内文の表記は "Ctrl"
  const ctrlLab = keyLabel({ code: "", tap: "Control" });
  check("5 ★Control のタップは「Ctrl」と出す（Control とは出さない）", ctrlLab.includes("Ctrl") && !ctrlLab.includes("Control"), ctrlLab);
  check("5 従来の表示は不変（Ctrl+S）", keyLabel({ code: "KeyS", ctrl: true }) === "Ctrl+S");
  check("5 従来の表示は不変（Alt＋クリック系は button 側）", keyLabel({ code: "", button: 1, alt: true }).startsWith("Alt+"));
}

// ================= 6. 配線の走査 =================
{
  const ed = fs.readFileSync(path.join(root, "src/editor/editor.ts"), "utf8");
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const km = fs.readFileSync(path.join(root, "src/keymap.ts"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");

  // D-1: 空でも節を出す（`length === 0` の早期 return が**消えている**）。
  // ★行コメントを落としてから見る——**この検査の説明文そのものに当たってしまう**ため
  //（コード中の解説が「以前はこう書いてあった」と旧コードを引用している）
  const edCode = ed.replace(/^[ \t]*\/\/.*$/gm, "");
  check("6 ★マイ柄は登録ゼロでも節を出す", !/if \(this\.customTones\.length === 0\) return;/.test(edCode));
  // 反証: コメントを落とす前は当たる＝この走査が空振りしていない
  check("6 反証: コメント除去の前後で結果が変わる（走査が効いている）", /if \(this\.customTones\.length === 0\) return;/.test(ed));
  check("6 ★空のときは増やし方の1行を出す", /ed\.tone\.custom\.empty\.hint/.test(ed));
  check("6 空の案内はボタン名を辞書から差し込む（二重管理しない）", /ed\.tone\.custom\.empty\.hint", \{ btn: t\("ed\.sel\.registerTone\.btn"\) \}/.test(ed));
  check("6 登録があるときは従来どおり（🔀/🎨 は空のときに出さない）", /this\.appendToneNote\(tex, t\("ed\.tone\.custom\.empty\.hint"[\s\S]{0,120}?return;/.test(ed));

  // D-2: かすり消しの説明が画面に出る（title も残っている）
  check("6 ★かすり消しの説明を一覧に出す", /toneMode === "eraser"\) this\.appendToneNote\(tex, t\("ed\.tone\.head\.eraser\.hint"\)\)/.test(ed));
  check("6 従来の title も残っている", /head\.title = toneMode === "eraser" \? t\("ed\.tone\.head\.eraser\.title"\)/.test(ed));
  check("6 「かすり消し」の名前は変えていない", /ed\.tone\.head\.eraser\.label/.test(ed));
  check("6 説明の器は CSS 1クラスだけ（.tone-note）", /\.tex \.tone-note \{/.test(css));

  // D-3: 組み込みで「変更」→ 確認を挟まない
  check("6 ★組み込みの確認ダイアログを挟まない", !/keys\.preset\.builtin\.msg/.test(main));
  check("6 ★自動で複製して事後に知らせる", /if \(!\(await duplicateCurrentPreset\(\)\)\) return false;[\s\S]{0,200}?keys\.preset\.autoCopied\.toast/.test(main));
  check("6 上限に達したときの断りは残っている", /keys\.preset\.max\.msg/.test(main));

  // D-4: 「待ち続ける」を消していない・離したときの道を足した
  check("6 ★『修飾キー単体は待ち続ける』が残っている", /修飾キー単体は待ち続ける/.test(main));
  check("6 ★設定画面に keyup の道を足した", /window\.addEventListener\("keyup", onKeyUp, true\)/.test(main) && /window\.removeEventListener\("keyup", onKeyUp, true\)/.test(main));
  // 条件としきい値の中身は `ModTapWatcher`（検査4b が直接叩く）。ここは**配線**だけを見る
  check("6 ★blur で候補を捨てる（Alt+Tab の誤爆を防ぐ）", /blurHandler = \(\) => \{[\s\S]{0,400}?this\.modTap\.cancel\(\);/.test(ed));
  check("6 ★ポインタが下りたら候補を捨てる", /modTapPointerHandler[\s\S]{0,140}?this\.modTap\.cancel\(\);/.test(ed));
  check("6 ★押しっぱなし（repeat）を状態機械へ渡している", /this\.modTap\.down\(e\.key, \{\s*\n?\s*repeat: e\.repeat,/.test(ed));
  check("6 keyup で判定する（押した時ではない）", /handleModTapUp\(e: KeyboardEvent\) \{[\s\S]{0,80}?this\.modTap\.up\(e\.key\)/.test(ed));
  check("6 ★描画中・ダイアログ中・文字入力中は発動しない", /!this\.mounted \|\| this\.dialogOpen\(\) \|\| this\.isTextEntry\(e\.target\) \|\| this\.pointerDown/.test(ed));
  check("6 ★A-27 の二重発火防御を通す", /handleModTapUp[\s\S]{0,900}?Editor\.DOUBLE_FIRE_MS/.test(ed));
  check("6 ★タップ経路で preventDefault しない（Alt＋クリックのスポイトを殺さない）",
    !/handleModTapUp\(e: KeyboardEvent\)[\s\S]{0,900}?preventDefault/.test(ed));
  check("6 listener は unmount で外す", /removeEventListener\("pointerdown", this\.modTapPointerHandler, true\)/.test(ed));
  check("6 tap は bindingKey で最初に見る（修飾と混ざらない）", /if \(b\.tap\) return tapEventKey\(b\.tap\);/.test(km));
  check("6 設定画面に単体タップの案内が常設されている", /km-tapnote/.test(main) && /keys\.tap\.msg/.test(main));

  // ---- Codex 指摘の対応（再発防止） ----
  // ①: 候補を立てる時点で「描いている最中か」を見る
  check(
    "6 ★候補を立てる時点で描画中・ダイアログ・文字入力・IME を見る（Codex ①）",
    /this\.modTap\.down\(e\.key, \{[\s\S]{0,320}?this\.pointerDown[\s\S]{0,200}?this\.dialogOpen\(\)[\s\S]{0,200}?this\.isTextEntry\(e\.target\)[\s\S]{0,120}?e\.isComposing/.test(ed)
  );
  // ②: 衝突の確認は複製より先（キャンセルしても組み合わせだけ残らない）
  const iConflict = main.indexOf("conflict = findConflict(currentPreset(), b, cmd);");
  const iEnsure = main.indexOf("if (!(await ensureEditablePreset()))");
  check("6 ★衝突の確認が自動複製より先（Codex ②）", iConflict > 0 && iEnsure > iConflict, `conflict=${iConflict} ensure=${iEnsure}`);
  // ③: タップも道具巡回の規則を通る（先頭固定にしない）
  check("6 ★タップも道具の同キー巡回を通る（Codex ③）", /const id = this\.pickCommandFromIds\(ids\);/.test(ed) && /private pickCommandFromIds/.test(ed));
  check("6 押したときの巡回も同じ関数を使う", /id = this\.pickCommandFromIds\(ids\); \/\/ V165/.test(ed));
  // ④: hold 専用はタップに割り当てない（設定画面で断る・実行側でも保険）
  check("6 ★設定画面が hold 専用のタップ割り当てを断る（Codex ④）", /if \(b\.tap && isHoldOnlyCommand\(cmd\)\)/.test(main) && /keys\.tap\.holdOnly\.msg/.test(main));
  check("6 実行側にも保険がある", /if \(isHoldOnlyCommand\(id\)\) return;/.test(ed));
  // ⑤: ホーム画面でもタップが効く
  check("6 ★ホーム画面にもタップの道がある（Codex ⑤）", /const homeKeyUpHandler = /.test(main) && /window\.addEventListener\("keyup", homeKeyUpHandler\)/.test(main));
  check("6 ホームの候補も blur とポインタで捨てる", /window\.addEventListener\("blur", homeModTapCancel\)/.test(main) && /window\.addEventListener\("pointerdown", homeModTapCancel, true\)/.test(main));
  // ⑥: 設定画面の取得中も blur で候補を捨てる
  check("6 ★割り当て待ち中も blur で候補を捨てる（Codex ⑥）", /window\.addEventListener\("blur", onBlur\)/.test(main) && /window\.removeEventListener\("blur", onBlur\)/.test(main));
  // しきい値は1か所（keymap.ts）だけに置く
  check("6 ★しきい値の定数は keymap.ts の1か所", /export const MOD_TAP_MS = 250;/.test(km) && !/MOD_TAP_CAPTURE_MS/.test(main));
  check("6 editor も keymap の値を使う（自前の 250 を持たない）", !/MOD_TAP_MS = 250/.test(ed));
}

console.log(`v165 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
