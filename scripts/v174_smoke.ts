// V174（Mac の署名・公証・staple）の回帰ゲート。引数不要:
//   npx tsx scripts/v174_smoke.ts
//
// ★この回は**アプリの中身を 1 行も変えない**。だから守るのは「触っていないこと」と
//   「新しく足した 1 本（scripts/mac_build.ts）が秘密を漏らさないこと」の 2 つだけ。
//   この回でいちばん怖いのは 3 つ:
//   ① **名義（本名）が公開リポに入る**——署名の名義は本名なので、`tauri.conf.json` に
//      `signingIdentity` を書いた瞬間、あるいは `mac_build.ts` に literal を書いた瞬間に公開物へ載る。
//      `make_release.ts` が A-17 で踏んだ穴と同じ形（**公開されるファイルに literal を書かない**）
//      → [S-1]・[S-5]。`codesign` / `spctl` の**生出力にも名義が出る**ので、流さないことを [S-6] が固定
//   ② **使い捨て鍵の `.sig` が配布物に混ざる**——`latest.json` に入ると**全利用者の Mac で
//      更新の検証が落ちる**。しかも落ちたことがこちらから見えない → [S-7] が消し込みの経路を固定
//   ③ **V175 の仕事を先にやってしまう**——`latest.json` は Windows 全利用者の更新の入り口。
//      この回で darwin を足すと、Mac で転んだときに「署名が悪いのか feed が悪いのか」を
//      切り分けられなくなる（REQ §0-c-1） → [S-2]・[S-3]・[S-4]
//
// [S-1] tauri.conf.json に signingIdentity が無い（＝名義は環境変数だけで通す）
// [S-2] tauri.conf.json に createUpdaterArtifacts が無い（一時 config の --config で足す・U-1 の実測）
// [S-3] plugins.updater（endpoints / pubkey / windows.installMode）が v1.8.0 と一字一句同じ
// [S-4] make_release.ts が作る feed の platforms のキーが windows-x86_64 だけ（darwin は V175）
// [S-5] mac_build.ts が名義・Key ID・Issuer ID を直書きしていない（環境変数からのみ読む）
// [S-6] mac_build.ts が外部コマンドの生出力を標準出力へ流さない（伏せ字か判定だけ）
// [S-7] mac_build.ts が使い捨て鍵の .sig を消す（消さずに終わる経路が無い）
// [S-11] mac_build.ts が .dmg を**容れ物として**公証して staple する段を持つ（実機 1 回目の R-5 赤）
// [S-12] その段が verifyDmg より**前**にある（順番が逆だと R-5 は必ず赤になる）
// [S-8] 反証: 上の検査が**わざと壊すと赤くなる**ことを、その場で写しを作って確かめる
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const readIf = (p: string) =>
  fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), "utf8") : "";

const CONF = "src-tauri/tauri.conf.json";
const REL = "scripts/make_release.ts";
const MAC = "scripts/mac_build.ts";
const SMOKE = "scripts/v174_smoke.ts";
const confRaw = readIf(CONF);
const relRaw = readIf(REL);
const macRaw = readIf(MAC);

// ⚠ 切り出しが空振りしたら**赤**にする（窓が壊れると検査は黙る＝いちばん損な壊れ方）
check(`[S-0] ${CONF} を読めた`, confRaw !== "");
check(`[S-0] ${REL} を読めた`, relRaw !== "");
check(`[S-0] ${MAC} を読めた`, macRaw !== "", "未実装（この回で新設する）");

type V = { ok: boolean; why: string };
const ok = (): V => ({ ok: true, why: "" });
const ng = (why: string): V => ({ ok: false, why });

/** `callee(…)` の実引数を **1 つずつ**取り出す。
 *
 *  ⚠ 素朴な括弧数えは **2 通りで黙って素通りする**（Codex のリリース前レビューで実証）:
 *   ① `console.log (x)` のように**括弧の前に空白**があると、`callee + "("` では見つからない
 *   ② `console.log(")", 生出力)` のように**文字列の中に括弧**があると、そこで閉じたと誤解して
 *      **2 つめ以降の引数を見ない**（＝広く取るどころか、狭く取って見逃す）
 *  なので、文字列・テンプレート・コメントを飛ばしながら数え、**最上位のカンマで分ける**。 */
function callArgList(src: string, callee: string): string[][] {
  const out: string[][] = [];
  const head = new RegExp(`(?:^|[^\\w$.])${callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
  for (let m = head.exec(src); m; m = head.exec(src)) {
    let d = 1;
    let i = m.index + m[0].length;
    let arg = "";
    const args: string[] = [];
    for (; i < src.length && d > 0; i++) {
      const c = src[i];
      // 文字列・テンプレートは丸ごと飛ばす（中の括弧・カンマに騙されない）
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        let j = i + 1;
        for (; j < src.length; j++) {
          if (src[j] === "\\") j++;
          else if (src[j] === q) break;
        }
        arg += src.slice(i, j + 1);
        i = j;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") {
        d--;
        if (d === 0) break;
      }
      if (c === "," && d === 1) {
        args.push(arg);
        arg = "";
        continue;
      }
      arg += c;
    }
    args.push(arg);
    out.push(args.map((a) => a.trim()).filter((a) => a !== ""));
    head.lastIndex = i;
  }
  return out;
}

/** `head` で始まるブロックを、`{` と `}` の対応で丸ごと取り出す。見つからなければ "" */
function block(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") {
      d--;
      if (d === 0) return src.slice(open, j + 1);
    }
  }
  return "";
}

/** ソースの中の文字列リテラル（ダブル/シングル/テンプレート）だけを集める */
function literals(src: string): string[] {
  return [
    ...(src.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []),
    ...(src.match(/'(?:[^'\\\n]|\\.)*'/g) ?? []),
    ...(src.match(/`(?:[^`\\]|\\.)*`/g) ?? []),
  ];
}

// ================= [S-1] signingIdentity が無い =================
// 署名の名義は**本名**。書いた瞬間に公開リポの設定ファイルへ名義が入る（REQ §4 [4]）。
// 署名は環境変数 APPLE_SIGNING_IDENTITY だけで通す
const checkS1 = (src: string): V => {
  if (src === "") return ng("設定を読めない");
  if (/signingIdentity/.test(src)) return ng("★signingIdentity が書かれている（名義が公開物に入る）");
  let conf: Record<string, any>;
  try {
    conf = JSON.parse(src);
  } catch {
    return ng("JSON として読めない");
  }
  if (conf?.bundle?.macOS?.signingIdentity !== undefined) return ng("★bundle.macOS.signingIdentity がある");
  return ok();
};
{
  const v = checkS1(confRaw);
  check("[S-1] tauri.conf.json に signingIdentity が無い（名義は環境変数だけ）", v.ok, v.why);
  const conf = confRaw ? JSON.parse(confRaw) : {};
  check("[S-1b] bundle.macOS の節そのものが無い（この回では触らない）", conf?.bundle?.macOS === undefined);
}

// ================= [S-2] createUpdaterArtifacts が無い =================
// 置くと**鍵の無い環境の `npm run tauri:build` が最後に必ず落ちる**（U-1 の実測）。
// CI（mac-smoke.yml）と本番（make_release.ts）と同じく、一時 config の --config で足す
const checkS2 = (src: string): V => {
  if (src === "") return ng("設定を読めない");
  if (/createUpdaterArtifacts/.test(src))
    return ng("★createUpdaterArtifacts が書かれている（鍵の無い環境のビルドが落ちる）");
  return ok();
};
{
  const v = checkS2(confRaw);
  check("[S-2] tauri.conf.json に createUpdaterArtifacts が無い（一時 config で足す）", v.ok, v.why);
  check(
    "[S-2b] mac_build.ts が一時 config で createUpdaterArtifacts を足している",
    /createUpdaterArtifacts/.test(macRaw) && /--config/.test(macRaw)
  );
}

// ================= [S-3] plugins.updater が v1.8.0 と一字一句同じ =================
// ここは **Windows 全利用者の更新の入り口**。Mac の都合で 1 文字でも動かさない。
// 期待値はすべて**公開されている値**（配布中の tauri.conf.json に載っているもの）
const EXPECT_UPDATER = {
  endpoints: [
    "https://memoanima.com/updates/latest.json",
    "https://github.com/OFF-Proxy/MemoAnima/releases/latest/download/latest.json",
  ],
  pubkey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDlEQjYzMzYwRjZDMUMxQzAKUldUQXdjSDJZRE8yblV5MzBrZ2xGUEJ0TWI5SUtxd3BQSDgxMlhCYkZjQkZvL3hVYlhBcUJMMTIK",
  windows: { installMode: "passive" },
};
const checkS3 = (src: string): V => {
  if (src === "") return ng("設定を読めない");
  let conf: Record<string, any>;
  try {
    conf = JSON.parse(src);
  } catch {
    return ng("JSON として読めない");
  }
  const u = conf?.plugins?.updater;
  if (!u) return ng("★plugins.updater が無い");
  // JSON.stringify は**書いた順**を保つので、これで「値」と「キーの並び」を同時に見られる
  if (JSON.stringify(u) !== JSON.stringify(EXPECT_UPDATER)) return ng("★v1.8.0 と一字一句同じではない");
  return ok();
};
{
  const v = checkS3(confRaw);
  check("[S-3] plugins.updater が v1.8.0 と一字一句同じ（endpoints / pubkey / windows.installMode）", v.ok, v.why);
  const conf = confRaw ? JSON.parse(confRaw) : {};
  check(
    "[S-3b] plugins.updater のキーの並びも同じ",
    JSON.stringify(Object.keys(conf?.plugins?.updater ?? {})) === JSON.stringify(Object.keys(EXPECT_UPDATER))
  );
}

// ================= [S-4] feed の platforms は windows-x86_64 だけ =================
// darwin を足すのは V175。この回で足すと、Mac で更新が転んだときに
// 「署名が悪いのか feed が悪いのか」を切り分けられない（REQ §0-c-1）
const checkS4 = (src: string): V => {
  if (src === "") return ng("make_release.ts を読めない");
  const blocks: string[] = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf("platforms: {", i);
    if (at < 0) break;
    const b = block(src.slice(at), "platforms: {");
    if (b === "") return ng("platforms のブロックを切り出せない（検査が黙る）");
    blocks.push(b);
    i = at + b.length;
  }
  // ⚠ 空振り（0 件）は**赤**。make_release.ts の書き方が変わって検査が素通りする形を塞ぐ
  if (blocks.length < 2)
    return ng(`platforms のブロックが ${blocks.length} 件しか無い（--dry-run 用と本番用の 2 件あるはず）`);
  for (const b of blocks) {
    const keys = [...b.matchAll(/"([^"]+)"\s*:\s*\{/g)].map((m) => m[1]);
    if (JSON.stringify(keys) !== JSON.stringify(["windows-x86_64"]))
      return ng(`★platforms のキーが ${JSON.stringify(keys)}`);
  }
  return ok();
};
{
  const v = checkS4(relRaw);
  check("[S-4] make_release.ts の feed の platforms は windows-x86_64 だけ（darwin は V175）", v.ok, v.why);
  check("[S-4b] make_release.ts に --with-mac / darwin の字面が無い（V175 を先走っていない）", !/--with-mac|darwin/.test(relRaw));
}

// ================= [S-5] mac_build.ts に名義・Key ID・Issuer ID の直書きが無い =================
// `make_release.ts` が A-17 で踏んだ穴と同じ形——**公開されるファイルに literal を書かない**。
// 値は環境変数からだけ読み、既定値（`?? "…"` / `|| "…"`）も置かない
const ENV_NAMES = ["APPLE_SIGNING_IDENTITY", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"];
const checkS5 = (src: string): V => {
  if (src === "") return ng("mac_build.ts を読めない");
  const lits = literals(src);
  // Issuer ID は UUID の形
  if (lits.some((l) => /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/.test(l)))
    return ng("★UUID の形の literal がある（Issuer ID の直書き）");
  // Key ID は 10 桁の英数大文字（数字を 1 つ以上含む）
  if (lits.some((l) => /\b(?=[A-Z0-9]*\d)[A-Z0-9]{10}\b/.test(l))) return ng("★Key ID の形の literal がある");
  // 名義（`Developer ID Application:` の**あと**に名前が続く literal）
  if (lits.some((l) => /Developer ID Application:\s+[A-Za-z]/.test(l))) return ng("★署名の名義が直書きされている");
  // 既定値を置いていない（環境に無ければ**止める**のが正しい）
  for (const n of ENV_NAMES) {
    const re = new RegExp(`${n}[^\\n]*(\\?\\?|\\|\\|)\\s*["'\`]`);
    if (re.test(src)) return ng(`★${n} に既定値の literal がある`);
  }
  return ok();
};
{
  const v = checkS5(macRaw);
  check("[S-5] mac_build.ts に名義・Key ID・Issuer ID の直書きが無い（環境変数からのみ読む）", v.ok, v.why);
  const smokeRaw = readIf(SMOKE);
  // §D 検査2（ユーザー名・実パス）。公開対象になる 2 本に作者の環境が残っていないこと
  for (const [label, src] of [
    [MAC, macRaw],
    [SMOKE, smokeRaw],
  ] as const)
    check(`[S-5b] ${label} に Windows の実パスの直書きが無い（§D 検査2）`, !/C:[\\/]Users/i.test(src));
  // §D 検査6（旧ブランド・**大小を区別する**）。A-17 と同じく literal を書かず、作業フォルダ名から導出する
  //  ——公開コピーはフォルダ名が製品名と同じなので、そのときは当てない
  const conf = confRaw ? JSON.parse(confRaw) : {};
  const folder = path.basename(root);
  if (folder !== conf.productName) {
    for (const [label, src] of [
      [MAC, macRaw],
      [SMOKE, smokeRaw],
    ] as const)
      check(`[S-5c] ${label} に旧ブランドの綴りが無い（§D 検査6・大小を区別）`, src !== "" && !src.includes(folder));
  }
}

// ================= [S-6] 生出力を標準出力へ流さない =================
// `codesign` も `spctl` も、**出力に名義が出る**（Authority= / origin=）。
// 「気をつける」で守らず、**漏斗**にする: 外部コマンドは全部 pipe で受け、
// 画面に出せるのは「伏せ字を通した行」か「判定だけ」
const RAW_IDS = /\.text\b|\braw\b|\bstdout\b|\bstderr\b|\bline\b/;
const SAFE = /scrub\(|safeLines\(/;
const checkS6 = (src: string): V => {
  if (src === "") return ng("mac_build.ts を読めない");
  // (a) 生出力を console へ渡していない。★**引数 1 つずつ**見る
  //  （`console.log(scrub("定数"), 生出力)` は、引数をまとめて見ると `scrub(` があるので素通りした）
  const callees = [
    "console.log",
    "console.error",
    "console.warn",
    "console.info",
    "console.debug",
    "process.stdout.write",
    "process.stderr.write",
  ];
  let seen = 0;
  for (const c of callees)
    for (const call of callArgList(src, c)) {
      seen++;
      for (const a of call) if (RAW_IDS.test(a) && !SAFE.test(a)) return ng(`★生出力を ${c} に渡している`);
    }
  // ⚠ 空振り（1 件も拾えない）は赤。書き方が変わって検査が素通りする形を塞ぐ
  if (seen === 0) return ng("console の呼び出しを 1 件も拾えない（検査が黙る）");
  // (b) 外部コマンドの受け口が**必ず pipe**であること。
  //
  //  ⚠ はじめは `inherit` という**字面だけ**を禁じていたが、同じ「素通し」は別の書き方でも書ける
  //   （`stdio: ["ignore", 1, 2]` の数値のファイル記述子／`stdio: ["ignore", process.stdout, process.stderr]`）。
  //   Cowork の反証で 3 通りが緑のまま通った。**禁止の言葉を並べる限り、書き方の数だけ穴が空く**。
  //   → **許す形を 1 つだけ決めて、数を合わせる**。`spawn` / `spawnSync` の呼び出しの数と、
  //     `stdio: ["ignore", "pipe", "pipe"]` の数が**一致しなければ赤**。
  //   ⚠ したがって、新しく外部コマンドを足すときは**この形をそのまま書くこと**（書き方を変えると赤くなる）。
  if (/["']inherit["']/.test(src)) return ng("★stdio が inherit（生出力が素通しで画面に出る）");
  {
    const spawnSites = [...src.matchAll(/\bspawn(?:Sync)?\s*\(/g)].length;
    const piped = [...src.matchAll(/stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/g)].length;
    // ⚠ 空振り（0 件）は赤。書き方が変わって検査が素通りする形を塞ぐ
    if (spawnSites === 0) return ng("spawn の呼び出しを 1 件も拾えない（検査が黙る）");
    if (piped !== spawnSites)
      return ng(`★外部コマンドの受け口が pipe でないものがある（spawn ${spawnSites} 件 / pipe ${piped} 件）`);
  }
  // (c) ★生出力を**別の名前に移していない**。移されると (a) の見張りをすり抜ける
  //  （`const message = r.text; console.log(message);` が素通りした）
  for (const m of src.matchAll(/(?:const|let|var)\s+[\w$]+\s*=\s*([^;\n]+)/g))
    if (/\.text\b/.test(m[1]) && !SAFE.test(m[1]) && !/\.includes\(/.test(m[1]))
      return ng("★生出力を別の名前に移している（伏せ字の外へ持ち出せる）");
  if (/(?:const|let|var)\s*\{[^}\n]*\btext\b[^}\n]*\}/.test(src))
    return ng("★生出力を分割代入で取り出している");
  // (d) ★ビルドの流し込みも伏せ字を通している。**ここが最後に残った穴**だった——
  //  受け取る変数を短い別名にすると (a) の見張り（生出力らしい名前）から外れて素通りした。
  //  バンドラは署名のときに名義をそのまま出すことがあるので、ここは素通しにできない
  const onCalls = callArgList(src, ".on");
  const lineHandlers = onCalls.filter((a) => a[0] === '"line"');
  if (lineHandlers.length === 0) return ng("1 行ずつ受け取る処理を見つけられない（検査が黙る）");
  for (const h of lineHandlers)
    if (!SAFE.test(h[1] ?? "")) return ng("★ビルドの流し込みが伏せ字を通っていない");
  return ok();
};
{
  const v = checkS6(macRaw);
  check("[S-6] mac_build.ts が生出力を標準出力へ流さない（伏せ字か判定だけ）", v.ok, v.why);
  check(
    "[S-6b] 伏せ字は完全一致で先に消してから、形の伏せ字を当てている",
    /\.split\(sec\)\.join\(|replaceAll\(sec/.test(macRaw) && /Developer ID Application:/.test(macRaw)
  );
  check("[S-6c] 前検査は値を出さず「あり（N 文字）」だけを出す", /\.length\} 文字/.test(macRaw));
}

// ================= [S-7] 使い捨て鍵の .sig を消す =================
// ★`latest.json` に混ざると**全利用者の Mac で更新の検証が落ちる**。
// 途中で例外が出ても消えるように、消し込みは finally に置く
const checkS7 = (src: string): V => {
  if (src === "") return ng("mac_build.ts を読めない");
  if (!/function removeThrowawaySignatures\s*\(/.test(src)) return ng("★removeThrowawaySignatures が無い");
  if (!/function assertNoSignatures\s*\(/.test(src)) return ng("★assertNoSignatures（消し残りの確認）が無い");
  const fin = block(src, "} finally ");
  if (fin === "") return ng("★finally ブロックが無い（例外で消し忘れる経路ができる）");
  // ★**素の文**であること。`false ? removeThrowawaySignatures(dir) : 0` のように
  //  呼んだ字面だけ残して実際には呼ばない形が素通りした（Codex の指摘）
  if (!/const removed = removeThrowawaySignatures\(bundleDir\);/.test(fin))
    return ng("★finally で消していない（呼び出しが素の文になっていない）");
  if (!/const left = assertNoSignatures\(bundleDir\);/.test(fin))
    return ng("★finally で消し残りを確かめていない（呼び出しが素の文になっていない）");
  if (!/process\.exitCode = 1/.test(fin)) return ng("★消し残りがあっても赤にならない");
  // ★あとから 0 に戻す道を作らない（`process.exitCode = 0` を足すと赤が緑に化けた）
  if (/process\.exitCode\s*=\s*0/.test(src)) return ng("★process.exitCode を 0 に戻している（赤が緑に化ける）");
  return ok();
};
{
  const v = checkS7(macRaw);
  check("[S-7] mac_build.ts が使い捨て鍵の .sig を消す（消さずに終わる経路が無い）", v.ok, v.why);
  check(
    "[S-7b] 使い捨て鍵を必ずその場で作る（環境の本物を使う分岐が無い）",
    /TAURI_SIGNING_PRIVATE_KEY:/.test(macRaw) &&
      !/TAURI_SIGNING_PRIVATE_KEY\s*\|\||process\.env\.TAURI_SIGNING_PRIVATE_KEY\s*\?\?/.test(macRaw)
  );
  check("[S-7c] .app.tar.gz を展開して staple を確かめる（REQ §3-1）", /stapler/.test(macRaw) && /app\.tar\.gz/.test(macRaw));
}

// ================= [S-11][S-12] .dmg を公証して staple する段 =================
//
// 実機 1 回目で **R-5 だけが赤**だった。原因は設定ではなく **Tauri の段取り**——
// `.app` を zip にして公証へ出し、`.app` に staple してから、**そのあとに `.dmg` を作る**。
// つまり `.dmg` は「公証済みのアプリを入れた容れ物」だが、**容れ物そのものは Apple に出していない**
// （`spctl` が `source=Unnotarized Developer ID` と言うのはこれ。署名はされていて、提出だけが無い）。
// ⚠ 利用者の体験は無傷（R-4 は緑）。出荷ブロッカーではない。
//  それでも緑にするのは、**いつも赤い検査は「赤」の意味を壊す**から。
//  仕様だからと赤を残すと、次の本物の赤が読み飛ばされる。
const DMG_STEPS = ['"notarytool"', '"submit"', '"--wait"', '"stapler"', '"staple"'];
const checkS11 = (src: string): V => {
  if (src === "") return ng("mac_build.ts を読めない");
  const b = block(src, "function notarizeDmg(");
  if (b === "") return ng("★.dmg を公証する段（notarizeDmg）が無い");
  // ⚠ 字面は**引用符ごと**当てる（`"staple"` を `staple` で探すと `"stapler"` に当たって黙る）
  for (const w of DMG_STEPS) if (!b.includes(w)) return ng(`★公証の段に ${w} が無い`);
  return ok();
};
const checkS12 = (src: string): V => {
  if (src === "") return ng("mac_build.ts を読めない");
  const m = block(src, "async function main(");
  if (m === "") return ng("main を切り出せない（検査が黙る）");
  const at = m.indexOf("notarizeDmg(");
  const vf = m.indexOf("verifyDmg(");
  if (at < 0) return ng("★main が notarizeDmg を呼んでいない（.dmg が公証されないまま検査される）");
  if (vf < 0) return ng("main が verifyDmg を呼んでいない（検査が黙る）");
  if (at > vf) return ng("★公証の段が verifyDmg より後ろにある（R-5 は必ず赤になる）");
  return ok();
};
{
  const v11 = checkS11(macRaw);
  check("[S-11] mac_build.ts が .dmg を公証して staple する段を持つ", v11.ok, v11.why);
  const v12 = checkS12(macRaw);
  check("[S-12] その段が verifyDmg より前に呼ばれている", v12.ok, v12.why);
  // --skip-build でも通ること（既にある .dmg を公証し直せる＝30 分のビルドを待たない）
  const m = block(macRaw, "async function main(");
  check(
    "[S-11b] 公証の段は --skip-build の分岐の外にある（既にある .dmg も公証し直せる）",
    m !== "" && m.indexOf("notarizeDmg(") > m.indexOf("if (skipBuild)")
  );
  check("[S-11c] 公証の鍵は環境変数から渡している（値の直書きが無い）", /process\.env\.APPLE_API_KEY_PATH/.test(macRaw) && /process\.env\.APPLE_API_ISSUER/.test(macRaw));
}

// ================= [S-10] ★字面ではなく、実際に動かして確かめる =================
//
// Codex のリリース前レビューが、[S-6]・[S-7] の**字面の検査**を **10 通り**の書き換えで
// すり抜けられることを実証した（「消したことにする」「別の名前に移してから出す」など）。
// 字面の穴は上で塞いだが、**いちばん大事な 2 つ（名義を伏せる／.sig を消す）は動かして**確かめる。
// `mac_build.ts` は読み込んだだけでは何もしない（`isEntry` の分岐）ので、ここから呼べる。
{
  // ⚠ 伏せ字の材料は**読み込みのときに**環境変数から作られる。import より前に置くこと
  const FAKE_IDENTITY = "Developer ID Application: SIGNING-IDENTITY-PLACEHOLDER (TEAMID0000)";
  process.env.APPLE_SIGNING_IDENTITY = FAKE_IDENTITY;
  const mac = await import("./mac_build.ts");

  // (1) 伏せ字 — 名義が画面に出る形を実際に通す
  for (const s of [
    `Authority=${FAKE_IDENTITY}`,
    `origin=${FAKE_IDENTITY}`,
    `spctl: accepted\nsource=Notarized Developer ID\norigin=${FAKE_IDENTITY}`,
  ]) {
    const out = mac.scrub(s);
    check("[S-10] ★伏せ字を通すと名義が残らない", !out.includes("SIGNING-IDENTITY-PLACEHOLDER"), JSON.stringify(out).slice(0, 120));
  }
  check(
    "[S-10] 伏せ字は判定に要る語を消さない（accepted / source=）",
    mac.scrub("accepted\nsource=Notarized Developer ID").includes("source=Notarized Developer ID")
  );
  check("[S-10] 伏せ字はホームの絶対パスを消す", !mac.scrub("/Users/somebody/work/x").includes("somebody"));

  // (2) .sig の消し込み — **本当に消えるか**を一時フォルダで叩く（「消したことにする」を捕まえる）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v174-sig-"));
  fs.mkdirSync(path.join(tmp, "macos"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "dmg"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "macos", "x.app.tar.gz.sig"), "dummy");
  fs.writeFileSync(path.join(tmp, "macos", "x.app.tar.gz"), "keep");
  fs.writeFileSync(path.join(tmp, "dmg", "y.dmg"), "keep");
  check("[S-10] 消す前に .sig を 1 本見つける", mac.listSignatures(tmp).length === 1);
  const removed = mac.removeThrowawaySignatures(tmp);
  check(
    "[S-10] ★removeThrowawaySignatures が実際に .sig を消す",
    removed === 1 && !fs.existsSync(path.join(tmp, "macos", "x.app.tar.gz.sig"))
  );
  check(
    "[S-10] ★.sig 以外は消さない（配信物と .dmg は残る）",
    fs.existsSync(path.join(tmp, "macos", "x.app.tar.gz")) && fs.existsSync(path.join(tmp, "dmg", "y.dmg"))
  );
  check("[S-10] ★assertNoSignatures が消し残り 0 を返す", mac.assertNoSignatures(tmp).length === 0);
  // 入れ子の奥（走査を止められていないか）
  fs.mkdirSync(path.join(tmp, "macos", "deep", "er"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "macos", "deep", "er", "z.sig"), "dummy");
  check("[S-10] ★入れ子の奥の .sig も見つける", mac.assertNoSignatures(tmp).length === 1);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ================= [S-8] 反証（わざと壊して赤くなることを見る） =================
{
  // 1z: signingIdentity を足す
  const conf1 = confRaw ? JSON.parse(confRaw) : {};
  conf1.bundle = { ...conf1.bundle, macOS: { signingIdentity: "-" } };
  check("[S-8] 反証 1z: signingIdentity を足した写しは [S-1] が赤", !checkS1(JSON.stringify(conf1, null, 2)).ok);

  // 2z: createUpdaterArtifacts を足す
  const conf2 = confRaw ? JSON.parse(confRaw) : {};
  conf2.bundle = { ...conf2.bundle, createUpdaterArtifacts: true };
  check("[S-8] 反証 2z: createUpdaterArtifacts を足した写しは [S-2] が赤", !checkS2(JSON.stringify(conf2, null, 2)).ok);

  // 3z: pubkey を 1 文字だけ変える
  const conf3 = confRaw ? JSON.parse(confRaw) : {};
  const pk: string = conf3?.plugins?.updater?.pubkey ?? "";
  conf3.plugins.updater.pubkey = (pk[0] === "d" ? "D" : "d") + pk.slice(1);
  check("[S-8] 反証 3z: pubkey を 1 文字変えた写しは [S-3] が赤", !checkS3(JSON.stringify(conf3, null, 2)).ok);
  // 並べ替えただけでも赤（一字一句＝キーの並びも含む）
  const conf3b = confRaw ? JSON.parse(confRaw) : {};
  const u = conf3b.plugins.updater;
  conf3b.plugins.updater = { pubkey: u.pubkey, endpoints: u.endpoints, windows: u.windows };
  check("[S-8] 反証 3z': キーを並べ替えただけの写しも [S-3] が赤", !checkS3(JSON.stringify(conf3b, null, 2)).ok);

  // 4z: feed に darwin を足す
  const rel4 = relRaw.replace(
    /"windows-x86_64"\s*:\s*\{/,
    '"darwin-aarch64": { signature: "x", url: "y" },\n      "windows-x86_64": {'
  );
  check("[S-8] 反証 4z: feed に darwin を足した写しは [S-4] が赤", relRaw !== rel4 && !checkS4(rel4).ok);

  // 5z: 名義・Key ID・Issuer ID をそれぞれ直書きする
  const mutIssuer = macRaw + '\nconst x = "69a6de80-1234-47e3-e053-5b8c7c11a4d1";\n';
  const mutKeyId = macRaw + '\nconst y = "A1B2C3D4E5";\n';
  const mutName = macRaw + '\nconst z = "Developer ID Application: Taro Yamada (ABCDE12345)";\n';
  check("[S-8] 反証 5z-1: Issuer ID を直書きした写しは [S-5] が赤", macRaw !== "" && !checkS5(mutIssuer).ok);
  check("[S-8] 反証 5z-2: Key ID を直書きした写しは [S-5] が赤", macRaw !== "" && !checkS5(mutKeyId).ok);
  check("[S-8] 反証 5z-3: 署名の名義を直書きした写しは [S-5] が赤", macRaw !== "" && !checkS5(mutName).ok);

  // 6z: 生出力を console.log に渡す／stdio を inherit にする
  const mutEcho = macRaw + "\nconsole.log(r.text);\n";
  const mutInherit = macRaw + '\nconst opts = { stdio: "inherit" };\n';
  check("[S-8] 反証 6z-1: console.log(生出力) を足した写しは [S-6] が赤", macRaw !== "" && !checkS6(mutEcho).ok);
  check("[S-8] 反証 6z-2: stdio を inherit にした写しは [S-6] が赤", macRaw !== "" && !checkS6(mutInherit).ok);

  // 7z: finally から消し込みを外す
  const fin = block(macRaw, "} finally ");
  const mutNoClean = fin === "" ? macRaw : macRaw.replace(fin, fin.replace(/removeThrowawaySignatures\(/g, "noop("));
  check(
    "[S-8] 反証 7z: finally の消し込みを外した写しは [S-7] が赤",
    macRaw !== "" && mutNoClean !== macRaw && !checkS7(mutNoClean).ok
  );

  // ★Codex のリリース前レビューが見つけた抜け道。**当時はこの 8 通りが全部素通り（緑）だった**。
  //  同じ形が二度と通らないよう、反証として毎回走らせる
  const BYPASS_S6: [string, string][] = [
    ["括弧の前に空白を入れる", macRaw + "\nconsole.log (cs.text);\n"],
    ["伏せ字と並べて渡す", macRaw + '\nconsole.log(scrub("定数"), cs.text);\n'],
    ["文字列の中の括弧で隠す", macRaw + '\nconsole.log(")", cs.text);\n'],
    ["別の名前に移してから出す", macRaw + "\nconst message = cs.text;\nconsole.log(message);\n"],
    ["分割代入で取り出す", macRaw + "\nconst { text } = cs;\nconsole.log(text);\n"],
    // ★最後に残った穴。受け取る名前を短い別名にすると「生出力らしい名前」の網から外れた
    ["流し込みから伏せ字を外す", macRaw.replace("console.log(`  │ ${scrub(line)}`)", "console.log(`  │ ${line}`)")],
    // ★Cowork の反証（12〜14 個目）。`inherit` の字面を避けるだけで同じ「素通し」が書けた
    //  → 禁止の言葉を並べるのをやめ、**許す形と数を合わせる**ようにした（checkS6 の (b)）
    [
      "受け口を数値のファイル記述子にする",
      macRaw.replace('stdio: ["ignore", "pipe", "pipe"]', 'stdio: ["ignore", 1, 2]'),
    ],
    [
      "受け口に process.stdout をそのまま繋ぐ",
      macRaw.replace('stdio: ["ignore", "pipe", "pipe"]', 'stdio: ["ignore", process.stdout, process.stderr]'),
    ],
    [
      "流し込み側の受け口だけ差し替える",
      macRaw.replace(
        '{ cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }',
        '{ cwd: root, env, stdio: ["ignore", 1, 2] }'
      ),
    ],
  ];
  // ⚠ 写しが元と同じ（＝書き換えが当たらなかった）ときも**赤**にする。反証が黙るのを防ぐ
  for (const [why, mut] of BYPASS_S6)
    check(`[S-8] 反証 6z★（Codex）${why} も [S-6] が赤`, macRaw !== "" && mut !== macRaw && !checkS6(mut).ok);

  // ★実機 1 回目の R-5（.dmg が公証されていなかった）を直した段を、二度と外せないようにする
  const mutNoNotary = macRaw.replace('"notarytool"', '"echo"');
  check("[S-8] 反証 11z-1: 公証の段を外した写しは [S-11] が赤", macRaw !== "" && mutNoNotary !== macRaw && !checkS11(mutNoNotary).ok);
  const mutNoStaple = macRaw.replace('"staple", dmgPath', '"validate", dmgPath');
  check("[S-8] 反証 11z-2: staple を外した写しは [S-11] が赤", macRaw !== "" && mutNoStaple !== macRaw && !checkS11(mutNoStaple).ok);
  const mutSwapped = macRaw.replace(
    "      notarizeDmg(dmg.path);\n      verifyDmg(dmg.path);",
    "      verifyDmg(dmg.path);\n      notarizeDmg(dmg.path);"
  );
  check("[S-8] 反証 12z: 公証を verifyDmg の後ろへ動かした写しは [S-12] が赤", macRaw !== "" && mutSwapped !== macRaw && !checkS12(mutSwapped).ok);

  const BYPASS_S7: [string, string][] = [
    [
      "三項で「呼んだことにする」",
      macRaw.replace(
        "const removed = removeThrowawaySignatures(bundleDir);",
        "const removed = false ? removeThrowawaySignatures(bundleDir) : 0;"
      ),
    ],
    [
      "消し残りの確認だけ抜く",
      macRaw.replace(
        "const left = assertNoSignatures(bundleDir);",
        "const left = false ? assertNoSignatures(bundleDir) : [];"
      ),
    ],
    ["あとで exitCode を 0 に戻す", macRaw + "\nprocess.exitCode = 0;\n"],
  ];
  for (const [why, mut] of BYPASS_S7)
    check(`[S-8] 反証 7z★（Codex）${why} も [S-7] が赤`, macRaw !== "" && mut !== macRaw && !checkS7(mut).ok);
}

// ================= [S-9] 触っていないことの確認（この回の一行は「中身を変えない」） =================
{
  // アプリの中身に手を入れていれば、この回の前提が崩れている。**字面ではなく git で見る**のは
  // 報告書の `git diff --stat` の役目。ここでは「新しい 2 本がアプリを巻き込んでいない」ことだけ固定する
  check("[S-9] mac_build.ts は src/ を import していない（アプリの中身に触らない）", !/from\s+["']\.\.\/src\//.test(macRaw));
  check("[S-9] v174_smoke.ts は src/ を import していない", !/from\s+["']\.\.\/src\//.test(readIf(SMOKE)));
  check("[S-9] mac_build.ts が tauri.conf.json を書き換えない", macRaw !== "" && !/writeFileSync\([^)]*tauri\.conf\.json/.test(macRaw));
  check("[S-9] mac_build.ts が latest.json に触らない", macRaw !== "" && !/latest\.json/.test(macRaw));
}

console.log(`\nv174 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
