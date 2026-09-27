// V174: Mac の署名・公証・staple を **ビルドから検査まで 1 本**で通す（REQ §4 [4-b]）。
//   実行（Mac の作業用ユーザーで）: npx tsx scripts/mac_build.ts [--skip-build]
//   出力: src-tauri/target/universal-apple-darwin/release/bundle/{dmg,macos}/
//
// ★このファイルがある理由は「手で打たせない」こと。
//   `codesign` も `spctl` も、**出力に署名の名義（本名）が出る**（Authority= / origin=）。
//   手で打つと、その出力を報告書やログに貼らない運用を「気をつける」で守ることになる。
//   そこで**漏斗**にした: 外部コマンドは全部 pipe で受け、画面に出せるのは
//   「伏せ字を通した行」か「OK / NG の判定」だけ。生の出力はどこにも流さない。
//   ⚠ 名義・Key ID・Issuer ID は**このファイルに 1 文字も書かない**。環境変数からだけ読む
//   （`make_release.ts` が A-17 で踏んだ穴と同じ形＝**公開されるファイルに literal を書かない**）。
//
// ★もう 1 つの役目は「使い捨て鍵の `.sig` を外に出さないこと」。
//   この機械には updater の**本物の鍵を置かない**（REQ §0-b の案 B）。ビルドはその場で作った
//   使い捨て鍵で通し、出てくる `.sig` は**必ず捨てる**。混ざったまま配ると、
//   全利用者の Mac で更新の検証が落ちる——しかも落ちたことがこちらから見えない。
//   だから消し込みは `finally` に置いてある（途中で例外が出ても必ず通る）。
//
// 検査するもの（REQ §5-A）:
//   R-1  .app が Developer ID で署名されている（＋ universal の両アーキで検証が通る）
//   R-2  公証のチケットが貼られている（stapler validate）
//   R-3  Gatekeeper が通る（accepted ＋ source=Notarized Developer ID）
//   R-5  .dmg 自体も R-2・R-3
//   R-8  実行ファイルに私的なパス（ホーム）が残っていない（--remap-path-prefix が Mac でも効くか）
//   R-11 成果物の置き場に .sig が 1 本も無い
//   R-12 .app.tar.gz が **staple 済みの .app** から作られている（★この回でいちばん知りたい未知）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const product: string = conf.productName;
const skipBuild = process.argv.includes("--skip-build");

const TARGET = "universal-apple-darwin";
const bundleDir = path.join(root, "src-tauri", "target", TARGET, "release", "bundle");
/** 署名の名義が出る行の目印。★コロンのあとに名前は**書かない**（ここに書いた瞬間に公開物へ載る） */
const AUTHORITY_MARK = "Authority=Developer ID Application:";
const MASK = "<伏せ字>";

/** 署名・公証に要る環境変数。★値はどこにも出さない（「あり（N 文字）」だけ） */
const ENV_NAMES = [
  "APPLE_SIGNING_IDENTITY",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
] as const;

// ---------------- 伏せ字 ----------------
//
// ⚠ **完全一致で先に消す**のが要（V163 の教訓）。語単位の正規表現から始めると、
//  空白を含む値の**断片が残る**。まず「値そのもの」を長い順に消し、そのあとで
//  「形」に当てる（Authority= / origin= / /Users/…）。
const SECRETS: string[] = [];
{
  for (const n of ENV_NAMES) {
    const v = process.env[n];
    if (v && v.trim().length >= 4) SECRETS.push(v.trim());
  }
  const home = os.homedir();
  if (home.length >= 4) SECRETS.push(home);
  const who = os.userInfo().username;
  if (who.length >= 3) SECRETS.push(who);
  SECRETS.sort((a, b) => b.length - a.length);
}

/** 画面に出す前に必ず通す。値そのもの → 形、の順で伏せる。
 *  ★`v174_smoke.ts` が**実際に動かして**「名義が消えること」を確かめる（export しているのはそのため） */
export function scrub(s: string): string {
  let t = s;
  for (const sec of SECRETS) t = t.split(sec).join(MASK);
  t = t.replace(/(Developer ID Application:)[^\n]*/g, `$1 ${MASK}`);
  t = t.replace(/(origin=)[^\n]*/g, `$1${MASK}`);
  t = t.replace(/(TeamIdentifier=)\S+/g, `$1${MASK}`);
  t = t.replace(/\/Users\/[^\s/"']+/g, `/Users/${MASK}`);
  return t;
}

// ---------------- 外部コマンド ----------------
type Captured = { code: number; text: string };

/** 外部コマンドを**必ず pipe で**受ける。返した中身は判定と伏せ字だけが読む。
 *  ⚠ 標準入力は `ignore`。対話を求めるコマンドはここで**止まらずに落ちる**ので、
 *   プロンプトを出させない手当て（`CI`）は呼ぶ側が渡すこと */
function capture(cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Captured {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (r.error) return { code: -1, text: String(r.error.message) };
  return { code: r.status ?? -1, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function hasMarker(c: Captured, marker: string): boolean {
  return c.text.includes(marker);
}

/** 落ちたときに出してよい行だけを拾う。**判定に必要な語を含む行**に限り、伏せ字を通してから返す。
 *  ⚠ ここを通さずに出力を画面へ出す道は作らないこと（`v174_smoke.ts` [S-6] が固定している） */
function safeLines(c: Captured): string[] {
  const KEEP = [
    /Authority=/,
    /TeamIdentifier=/,
    /^Identifier=/m,
    /^Format=/m,
    /not signed/,
    /invalid/,
    /rejected/,
    /accepted/,
    /source=/,
    /origin=/,
    /does not/,
    /No such file/,
    /[Ee]rror/,
    /ticket/,
    /staple/,
    /valid/,
    // 公証（notarytool）の返事。`status: Invalid` と提出 id だけ拾う。
    // ⚠ 提出 id は**でたらめな UUID で、個人を指す情報ではない**。落ちたときに
    //  `xcrun notarytool log <id>` で理由を引けるので、ここだけは通す
    /[Ss]tatus:/,
    /^id: [0-9a-f-]{36}$/m,
  ];
  return scrub(c.text)
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "" && KEEP.some((re) => re.test(s)))
    .slice(0, 20);
}

// ---------------- 判定の集計 ----------------
let ngCount = 0;
function judge(label: string, good: boolean, c?: Captured) {
  if (good) {
    console.log(`  OK: ${label}`);
    return;
  }
  ngCount++;
  console.log(`  NG: ${label}`);
  if (c) for (const s of safeLines(c)) console.log(`      │ ${s}`);
}

// ---------------- 前検査（ビルドの前に落とす） ----------------
function preflight() {
  console.log("== 前検査（ビルドの前に落とす） ==");
  if (process.platform !== "darwin") {
    throw new Error(
      `この回のビルドは macOS でしか通りません（いまの OS: ${process.platform}）\n` +
        "  → 借りている Mac の**作業用の macOS ユーザー**でログインしてから実行してください。\n" +
        "     署名の証明書と公証の鍵は、そのユーザーのキーチェーン／ホームの中だけにあります"
    );
  }
  for (const n of ENV_NAMES) {
    const v = process.env[n];
    if (!v || !v.trim()) {
      throw new Error(
        `環境変数 ${n} がありません\n` +
          "  → シェルで export してから実行してください（★ファイルに書かない・画面に出さない）"
      );
    }
    // ★値は出さない。そろっているかだけ
    console.log(`  ${n}: あり（${v.trim().length} 文字）`);
  }
  const keyPath = process.env.APPLE_API_KEY_PATH as string;
  if (!fs.existsSync(keyPath)) {
    throw new Error("APPLE_API_KEY_PATH の先にファイルがありません（場所はここには出しません）");
  }
  const st = fs.statSync(keyPath);
  if (!st.isFile()) throw new Error("APPLE_API_KEY_PATH がファイルではありません");
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `公証の鍵の権限が 600 ではありません（いま ${mode.toString(8)}）\n` +
        "  → chmod 600 で直してから実行してください（フォルダは 700）"
    );
  }
  console.log("  公証の鍵: 実在・権限 600");
  console.log(`  製品名: ${product} ／ ターゲット: ${TARGET}`);
}

// ---------------- 使い捨ての updater 署名鍵 ----------------
//
// ★この経路では**必ず使い捨てを作る**。環境に鍵が入っていても使わない。
//  本物の鍵は Windows に置いたままにする（REQ §0-b・他人の機械で本物を使わせない）。
//  鍵の中身を画面に出すコマンドは書かない。
function makeThrowawayKey(dir: string): string {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    console.log("  ⚠ 環境に updater の署名鍵がありますが、この経路では**使いません**（使い捨てを作ります）");
  }
  const keyPath = path.join(dir, "throwaway.key");
  // ⚠ `CI` を立てて呼ぶ。立てないと、`--password ""`（空文字）が途中で落ちたときに
  //  tauri が**パスワードの入力を待つ**。標準入力は閉じてあるので、そこで固まるか分かりにくく落ちる。
  //  CI のワークフローが無事なのは、ランナーに `CI=true` が最初から入っているためで、
  //  作者の Mac には無い——**同じ形で動かすために、ここで明示的に渡す**
  const r = capture("npm", ["run", "tauri", "--", "signer", "generate", "-w", keyPath, "--password", ""], {
    CI: "true",
  });
  if (r.code !== 0 || !fs.existsSync(keyPath)) {
    for (const s of safeLines(r)) console.log(`      │ ${s}`);
    throw new Error("使い捨ての updater 署名鍵を作れませんでした");
  }
  console.log("  使い捨ての updater 署名鍵を作りました（中身は表示しません・この回の .sig は最後に捨てます）");
  return fs.readFileSync(keyPath, "utf8");
}

// ---------------- ビルド ----------------
function runStreaming(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    // ★素通しにしない。1 行ずつ伏せ字を通してから出す
    //  （バンドラは署名のときに名義をそのまま出すことがある）
    // ⚠ 受け取る名前は `line` にしておくこと。回帰ゲートは「生出力らしい名前」を見張っていて、
    //  ここを短い別名にすると**見張りの網から外れる**（Codex のリリース前レビューで実証された穴）
    const pump = (s: NodeJS.ReadableStream | null) => {
      if (s) readline.createInterface({ input: s }).on("line", (line) => console.log(`  │ ${scrub(line)}`));
    };
    pump(child.stdout);
    pump(child.stderr);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
}

async function build(tmp: string) {
  console.log("== ビルド（universal・署名＋公証＋staple はバンドラが行う） ==");
  const keyText = makeThrowawayKey(tmp);
  // ⚠ createUpdaterArtifacts は tauri.conf.json に置かない。
  //  置くと**鍵の無い環境の `npm run tauri:build` が最後に必ず落ちる**（U-1 の実測）
  const cfg = path.join(tmp, "updater.json");
  fs.writeFileSync(cfg, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }), "utf8");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // 個人情報監査: panic の位置情報などに埋まるホームの絶対パスを消す（R-8）
    RUSTFLAGS: `--remap-path-prefix=${os.homedir()}=~`,
    TAURI_SIGNING_PRIVATE_KEY: keyText,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  };
  console.log("  公証は Apple の返事待ちで数分〜かかります（混んでいると長引きます）");
  const code = await runStreaming("npm", ["run", "tauri:build", "--", "--target", TARGET, "--config", cfg], env);
  if (code !== 0) throw new Error(`ビルドが失敗しました（終了コード ${code}）`);
}

// ---------------- 後検査 ----------------
/** 成果物を 1 つだけ選ぶ。0 個でも 2 個以上でも**赤にしたい**ので、件数も返す
 *  （前のビルドの古い版が残っていると 2 個になる＝どちらを検査したのか分からない状態で緑にしない） */
function findOne(dir: string, suffix: string): { path: string; found: number } {
  if (!fs.existsSync(dir)) return { path: "", found: 0 };
  const hit = fs.readdirSync(dir).filter((n) => n.endsWith(suffix));
  return { path: hit.length === 1 ? path.join(dir, hit[0]) : "", found: hit.length };
}

function verifyApp(appPath: string) {
  const cs = capture("codesign", ["-dv", "--verbose=4", appPath]);
  judge("R-1 .app が Developer ID で署名されています", hasMarker(cs, AUTHORITY_MARK), cs);
  const vf = capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  judge("R-1b 署名の検証が通ります（universal の両アーキテクチャ）", vf.code === 0, vf);
  const st = capture("xcrun", ["stapler", "validate", appPath]);
  judge("R-2 公証のチケットが貼られています（.app）", st.code === 0, st);
  const sp = capture("spctl", ["-a", "-vvv", "-t", "exec", appPath]);
  judge(
    "R-3 Gatekeeper が通ります（accepted ＋ 公証済みの Developer ID）",
    sp.code === 0 && hasMarker(sp, "accepted") && hasMarker(sp, "source=Notarized Developer ID"),
    sp
  );
}

/** ★`.dmg` を**容れ物として**公証して staple する（R-5）。
 *
 *  実機の 1 回目で R-5 だけが赤だった。原因は設定ではなく **Tauri の段取り**:
 *  バンドラは `.app` を zip にして公証へ出し、`.app` に staple してから **そのあとに `.dmg` を作る**。
 *  つまり `.dmg` は「公証済みのアプリを入れた容れ物」ではあるが、**容れ物そのものは Apple に出していない**。
 *  だから `spctl` が `source=Unnotarized Developer ID` と言う（署名はされていて、提出だけが無い）。
 *
 *  ⚠ **利用者の体験は無傷**（R-4 は緑）。出荷ブロッカーではない。
 *   それでも緑にするのは、**いつも赤い検査は「赤」の意味を壊す**から
 *   ——仕様だからと赤を残すと、次の本物の赤が読み飛ばされる。
 *
 *  ★`--skip-build` でも通る（既にある `.dmg` を公証し直せる＝30 分のビルドを待たずに R-5 を緑にできる）。 */
function notarizeDmg(dmgPath: string) {
  console.log("== .dmg を公証して staple する（R-5） ==");
  console.log("  Apple へ提出して返事を待ちます（数分〜。混んでいると長引きます）…");
  const sub = capture("xcrun", [
    "notarytool",
    "submit",
    dmgPath,
    // ★値は環境変数から。このファイルに literal を持たない
    "--key",
    process.env.APPLE_API_KEY_PATH as string,
    "--key-id",
    process.env.APPLE_API_KEY as string,
    "--issuer",
    process.env.APPLE_API_ISSUER as string,
    "--wait",
  ]);
  // ⚠ 終了コードだけでは足りない。提出そのものが通っても、審査が `Invalid` で返ることがある
  if (sub.code !== 0 || !hasMarker(sub, "status: Accepted")) {
    for (const s of safeLines(sub)) console.log(`      │ ${s}`);
    throw new Error(
      ".dmg の公証が通りませんでした（R-5）\n" +
        "  → 上の status と id を見てください。理由は `xcrun notarytool log <id> --key … --key-id … --issuer …` で引けます"
    );
  }
  console.log("  OK: .dmg の公証が通りました（status: Accepted）");
  const st = capture("xcrun", ["stapler", "staple", dmgPath]);
  if (st.code !== 0) {
    for (const s of safeLines(st)) console.log(`      │ ${s}`);
    throw new Error(".dmg に公証チケットを貼れませんでした（stapler staple・R-5）");
  }
  console.log("  OK: .dmg に公証チケットを貼りました");
}

function verifyDmg(dmgPath: string) {
  const st = capture("xcrun", ["stapler", "validate", dmgPath]);
  judge("R-5 公証のチケットが貼られています（.dmg）", st.code === 0, st);
  // ⚠ ディスクイメージは実行物ではないので `-t exec` ではなく `-t open` で見る
  const sp = capture("spctl", ["-a", "-vvv", "-t", "open", "--context", "context:primary-signature", dmgPath]);
  judge(
    "R-5 Gatekeeper が通ります（.dmg・accepted ＋ 公証済みの Developer ID）",
    sp.code === 0 && hasMarker(sp, "accepted") && hasMarker(sp, "source=Notarized Developer ID"),
    sp
  );
}

/** R-8: 成果物に私的なパスが残っていないか。★一致した文字列そのものは**出さない**（種類だけ）。
 *
 *  ⚠ 探すものは `make_release.ts` の A-17 と同じく**実行時に導出**する（literal を持たない）。
 *  ⚠ バイト列は **Buffer のまま**探す。universal の実行ファイルは 2 アーキ分あって大きいので、
 *   文字列に起こすと同じ大きさをもう 1 つ抱えることになる。 */
function verifyNoPrivatePaths(appPath: string) {
  const FORBIDDEN: (readonly [string, string])[] = [["ホームの絶対パス", "/Users/"]];
  const home = os.homedir();
  if (home.length >= 4) FORBIDDEN.push(["ビルドした人のホーム", home]);
  const who = os.userInfo().username;
  if (who.length >= 3) FORBIDDEN.push(["ビルドした人のユーザー名", who]);

  const bin = path.join(appPath, "Contents", "MacOS", product);
  if (!fs.existsSync(bin)) {
    judge("R-8 実行ファイルが見つかります", false);
    return;
  }
  const bytes = fs.readFileSync(bin);
  const hits = FORBIDDEN.filter(([, needle]) => bytes.includes(needle, 0, "latin1")).map(([label]) => label);
  judge(`R-8 実行ファイルに私的なパスが入っていません（${FORBIDDEN.length} パターン）`, hits.length === 0);
  if (hits.length) {
    console.log(`      → 見つかった種類: ${hits.join(" / ")}（中身は出しません）`);
    console.log("      → RUSTFLAGS の --remap-path-prefix が Mac でも効いているか確かめてください");
  }
}

/** R-12: 配信物が **staple 済みの .app** から作られているか（REQ §3-1・この回でいちばん知りたい未知）。
 *  ★通らなければ赤にして止める。その場で直さず、**事実を報告書に書く** */
function verifyTarball(tarPath: string, tmp: string) {
  const ex = path.join(tmp, "tarcheck");
  fs.mkdirSync(ex, { recursive: true });
  const t = capture("tar", ["-xzf", tarPath, "-C", ex]);
  if (t.code !== 0) {
    judge("R-12 配信物を展開できます", false, t);
    return;
  }
  const apps = fs.readdirSync(ex).filter((n) => n.endsWith(".app"));
  if (apps.length !== 1) {
    judge(`R-12 展開した中に .app が 1 つあります（いま ${apps.length} 個）`, false);
    return;
  }
  const st = capture("xcrun", ["stapler", "validate", path.join(ex, apps[0])]);
  judge("R-12 ★配信物は staple 済みの .app から作られています", st.code === 0, st);
  if (st.code !== 0) {
    console.log("      → ★staple より前に配信物が作られている証拠です（REQ §3-1）。");
    console.log("         この回では直さず、事実として報告書に書いてください（作り直す段を足すかは、事実を見てから決めます）");
  }
}

// ---------------- 使い捨て鍵の .sig の消し込み（R-11） ----------------
//
// ★配る feed に混ざると**全利用者の Mac で更新の検証が落ちる**（使い捨て鍵で署名されているため）。
//  本物の署名は Windows 側で改めて行う（REQ §0-b の案 B）。
export function listSignatures(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".sig")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function removeThrowawaySignatures(dir: string): number {
  let n = 0;
  for (const p of listSignatures(dir)) {
    try {
      fs.unlinkSync(p);
      n++;
    } catch {
      // 消せなかったものは下の assertNoSignatures が拾って赤にする
    }
  }
  return n;
}

export function assertNoSignatures(dir: string): string[] {
  return listSignatures(dir);
}

// ---------------- 本体 ----------------
async function main() {
  console.log(`== V174: Mac の署名・公証ビルド（${product}） ==`);
  preflight();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memoanima-mac-"));
  try {
    if (skipBuild) console.log("== --skip-build: 前のビルドの成果物をそのまま検査します ==");
    else await build(tmp);

    console.log("== 後検査（生の出力は流しません・判定だけ出します） ==");
    const appPath = path.join(bundleDir, "macos", `${product}.app`);
    if (!fs.existsSync(appPath)) {
      judge("成果物の .app が見つかります", false);
    } else {
      verifyApp(appPath);
      verifyNoPrivatePaths(appPath);
    }
    const dmg = findOne(path.join(bundleDir, "dmg"), ".dmg");
    if (dmg.path === "") judge(`成果物の .dmg が 1 つ見つかります（いま ${dmg.found} 個）`, false);
    else {
      // ⚠ 順番が命。**公証して staple してから**でないと、R-5 は必ず赤になる
      notarizeDmg(dmg.path);
      verifyDmg(dmg.path);
    }

    const tar = findOne(path.join(bundleDir, "macos"), ".app.tar.gz");
    if (tar.path === "") judge(`配信物（.app.tar.gz）が 1 つ見つかります（いま ${tar.found} 個）`, false);
    else verifyTarball(tar.path, tmp);
  } finally {
    // ★途中で例外が出ても、ここは必ず通る（消し忘れる経路を作らない）
    console.log("== 使い捨て鍵の署名の消し込み（R-11） ==");
    const removed = removeThrowawaySignatures(bundleDir);
    console.log(`  使い捨て鍵の署名を ${removed} 本消しました`);
    const left = assertNoSignatures(bundleDir);
    if (left.length) {
      console.log(`  NG: 成果物の置き場に署名が ${left.length} 本残っています（配る前に必ず消してください）`);
      process.exitCode = 1;
    } else {
      console.log("  OK: R-11 成果物の置き場に署名は 1 本も残っていません");
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 一時フォルダが消せなくても検査の結果は変わらない
    }
  }

  console.log("");
  if (ngCount || process.exitCode === 1) {
    console.log(`== 赤: 通らなかった検査が ${ngCount} 件あります ==`);
    process.exitCode = 1;
  } else {
    console.log("== 緑: R-1 / R-2 / R-3 / R-5 / R-8 / R-11 / R-12 がすべて通りました ==");
    console.log("   次: .dmg を Release へ（R-4 は quarantine を消さずに別の入口で確かめます）");
  }
}

/** ★`npx tsx scripts/mac_build.ts` と打たれたときだけ走る。
 *
 *  読み込んだだけでは何もしない形にしてあるのは、回帰ゲート（`v174_smoke.ts`）が
 *  **この中の関数を実際に動かして**確かめられるようにするため。
 *  字面だけの検査は、書き方を少し変えるだけで抜けられる——Codex のリリース前レビューが
 *  `.sig` の消し込みと生出力の見張りについて **10 通りの抜け道**を実証した。
 *  「消したことにする」「別の名前に移してから出す」は、**動かしてみないと捕まらない**。 */
const isEntry =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((e) => {
    // ★例外の本文にもパスが混ざり得るので、必ず伏せ字を通してから出す
    console.error(scrub(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
