// V174: Mac の署名・公証・staple を **ビルドから検査まで 1 本**で通す（REQ §4 [4-b]）。
//   実行（Mac の作業用ユーザーで）: npx tsx scripts/mac_build.ts [--skip-build | --rehearsal-old | --rehearsal-reject]
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
//
// V175: `--rehearsal-old`（REQ §10-3 の 3）＝ Mac の中だけで更新を通すリハーサルの「古い版の役」を作る。
//   普段との違いは一時 config の 2 つだけ: **版が 1 つ小さい**（mac_update.ts の rehearsalOldVersion）と、
//   **更新の確認先が 127.0.0.1 だけ**（＋ http で受けるための dangerousInsecureTransportProtocol）。
//   公開鍵はそのまま（本物の鍵の署名だけを受ける）。tauri.conf.json は 1 行も変えない。
//   署名・公証・検査は普段と同じ。成果物（.app と .dmg）は **dist-rehearsal/ へ移して**普段の置き場から外し、
//   この回の .app.tar.gz と .sig は**必ず消す**（古い版の役は配らない）。
//
// V207: `--rehearsal-reject`（REQ_tauri_2_12.md §5 の T-7 ②）＝ 更新の「版の確かめ」が効いていることを見る「断る役」を作る。
//   作りは `--rehearsal-old` と同じ（版が 1 つ小さい・確認先は 127.0.0.1 だけ・前検査・後始末も同じ）で、違いは 2 つだけ:
//   ① 一時 config の updater に **pubkey だけ**を足す（使い捨ての鍵の公開鍵。`rejectTempConfig`）
//   ② 置き場は **dist-rehearsal-reject/**（dist-rehearsal/ は消さない・触らない）
//   公開鍵は**決まった場所のファイル**（`REJECT_PUBKEY_FILE`・scripts/mac_update_reject.ts の prepare が作る）からだけ読む。
//   秘密鍵は読まない。環境変数や引数から公開鍵を受け取る口は作らない。tauri.conf.json の本物の公開鍵と同じなら止める。
//   普段と `--rehearsal-old` の一時 config（`tempConfig`）は 1 文字も変えていない。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REHEARSAL_FEED_URL, SIGNER_ENV_NAMES, parseMinisignPublicKey, rehearsalOldVersion } from "./mac_update.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const product: string = conf.productName;
const skipBuild = process.argv.includes("--skip-build");
/** V207: 版の確かめを見る「断る役」を作る（古い版の役と同じ作りで、pubkey だけ使い捨ての鍵・置き場も分ける） */
const rehearsalReject = process.argv.includes("--rehearsal-reject");
/** V175: リハーサルの「古い版の役」を作る（普段の配る物とは置き場を分ける）。V207: 断る役も古い版の役の 1 つ */
const rehearsalOld = process.argv.includes("--rehearsal-old") || rehearsalReject;
/** 古い版の役の置き場（.gitignore 済み・配らない） */
const rehearsalDir = path.join(root, "dist-rehearsal");
/** V207: 断る役の置き場（.gitignore 済み・配らない・dist-rehearsal/ とは別） */
const rejectDir = path.join(root, "dist-rehearsal-reject");

/** V207: 断る役の使い捨ての鍵の置き場（開発用ユーザーのホームの、リポの外・フォルダは 700）。作るのは mac_update_reject.ts の prepare */
export const REJECT_KEY_DIR = path.join(os.homedir(), "memoanima-reject-key");
/** 秘密鍵（600）。★mac_build.ts はこれを**読まない**（署名は mac_update_reject.ts だけ） */
export const REJECT_KEY_FILE = path.join(REJECT_KEY_DIR, "reject.key");
/** 公開鍵（tauri signer generate が書く `<秘密鍵>.pub`）。mac_build.ts が読むのはこれだけ */
export const REJECT_PUBKEY_FILE = `${REJECT_KEY_FILE}.pub`;

/**
 * ビルドに渡す一時 config（`--config`）。tauri.conf.json に**重ねる**だけ（配列は置き換え・オブジェクトは足し合わせ）。
 *  - 普段: `createUpdaterArtifacts` だけ（V174 から不変。置くと鍵の無い環境のビルドが最後に落ちる＝U-1 の実測）
 *  - 古い版の役: それに**版**と、updater の**確認先を 127.0.0.1 だけ**にしたものと、http で受ける許可を足す。
 *    pubkey と windows は書かない＝tauri.conf.json のまま（本物の鍵の署名しか受けない）
 * ★`v175_smoke.ts` [S-9] が**実際に呼んで**中身を確かめる（export しているのはそのため）
 */
export function tempConfig(rehearsal: boolean): Record<string, unknown> {
  if (!rehearsal) return { bundle: { createUpdaterArtifacts: true } };
  return {
    version: rehearsalOldVersion(conf.version),
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { endpoints: [REHEARSAL_FEED_URL], dangerousInsecureTransportProtocol: true } },
  };
}

/** V207: 公開鍵が tauri.conf.json の本物と同じなら投げる（字が同じ・鍵の番号が同じ、のどちらでも）。形が違っても投げる */
export function assertNotRealPubkey(pubkey: string): void {
  const real: string = conf.plugins.updater.pubkey;
  const pk = parseMinisignPublicKey(pubkey);
  if (pubkey.trim() === real.trim() || pk.keyId.equals(parseMinisignPublicKey(real).keyId)) {
    throw new Error("★断る役の公開鍵が tauri.conf.json の本物と同じです（本物の鍵の署名を受ける役になります）。止めました");
  }
}

/**
 * V207: 断る役の一時 config。**古い版の役（tempConfig(true)）に、updater の pubkey だけを足した形**
 * （版・確認先・http の許可は古い版の役と同じ）。本物の公開鍵なら投げる。
 * ★`v207_smoke.ts` [R] が実際に呼んで中身を確かめる（export しているのはそのため）
 */
export function rejectTempConfig(pubkey: string): Record<string, unknown> {
  assertNotRealPubkey(pubkey);
  const c = tempConfig(true) as { version: string; bundle: unknown; plugins: { updater: Record<string, unknown> } };
  return { version: c.version, bundle: c.bundle, plugins: { updater: { ...c.plugins.updater, pubkey } } };
}

/** V207: 断る役の公開鍵を決まった場所のファイルから読む（秘密鍵は読まない）。無い・形が違う・本物と同じなら投げる */
export function readRejectPubkey(file: string = REJECT_PUBKEY_FILE): string {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error("断る役の公開鍵がありません（先に npx tsx scripts/mac_update_reject.ts prepare で使い捨ての鍵の組を作ってください）");
  }
  const pubkey = fs.readFileSync(file, "utf8").trim();
  assertNotRealPubkey(pubkey);
  return pubkey;
}

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
export type Captured = { code: number; text: string };

/** 外部コマンドを**必ず pipe で**受ける。返した中身は判定と伏せ字だけが読む。
 *  ⚠ 標準入力は `ignore`。対話を求めるコマンドはここで**止まらずに落ちる**ので、
 *   プロンプトを出させない手当て（`CI`）は呼ぶ側が渡すこと
 *  V175: リハーサルの配り手（mac_update_rehearsal.ts）も**この漏斗を通す**ので export した */
export function capture(cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Captured {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (r.error) return { code: -1, text: String(r.error.message) };
  return { code: r.status ?? -1, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** V207: tauri（build・signer generate）の子に渡す環境。親の鍵の環境変数 6 つ（mac_update.ts の SIGNER_ENV_NAMES・
 *  大小だけ違う名前も）を外してから、渡すものだけを入れる。tauri build が鍵として読むのは
 *  TAURI_SIGNING_PRIVATE_KEY と _PASSWORD の 2 つだけ（CLI 2.12.4 の src/bundle.rs）だが、残りの 4 つも子に渡さない。
 *  外すのは undefined で上書きする形（spawn は undefined の欄を子に渡さない）＝capture の重ね方でも効く */
export function tauriChildEnv(extra: NodeJS.ProcessEnv, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...parent };
  const names: readonly string[] = SIGNER_ENV_NAMES;
  for (const n of names) e[n] = undefined;
  for (const k of Object.keys(parent)) if (names.includes(k.toUpperCase())) e[k] = undefined;
  for (const [k, v] of Object.entries(extra)) e[k] = v;
  return e;
}

export function hasMarker(c: Captured, marker: string): boolean {
  return c.text.includes(marker);
}

/** V175 (V174 の持ち越し [S-13]): 公証が通ったか。**終了コードだけで決めない**——
 *  `notarytool` は審査が `Invalid` でも終了コード 0 を返し得る。`status: Accepted` を見る
 *  （`v175_smoke.ts` [S-10] が偽の返事を渡して確かめる） */
export function notaryAccepted(c: Captured): boolean {
  return c.code === 0 && hasMarker(c, "status: Accepted");
}

/** 落ちたときに出してよい行だけを拾う。**判定に必要な語を含む行**に限り、伏せ字を通してから返す。
 *  ⚠ ここを通さずに出力を画面へ出す道は作らないこと（`v174_smoke.ts` [S-6] が固定している） */
export function safeLines(c: Captured): string[] {
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
  if (rehearsalReject) {
    if (process.argv.includes("--rehearsal-old")) throw new Error("--rehearsal-reject と --rehearsal-old は一緒に使えません（どちらか 1 つの役を作ります）");
    readRejectPubkey();
    console.log("  ★断る役: 公開鍵は使い捨ての鍵（~/memoanima-reject-key の .pub・本物と違う）・置き場は dist-rehearsal-reject/");
  }
  if (rehearsalOld) {
    if (skipBuild) throw new Error("--rehearsal-old と --skip-build は一緒に使えません（古い版の役は必ずその場でビルドします）");
    console.log(
      `  ★リハーサルの古い版の役: 版 ${rehearsalOldVersion(conf.version)}（tauri.conf.json は ${conf.version}）・更新の確認先は 127.0.0.1 だけ`
    );
    // 普段のビルドの配信物が残っていると、この回が作り直して最後に消す＝運ぶ前なら失われる。黙って進まない
    const left = findOne(path.join(bundleDir, "macos"), ".app.tar.gz");
    if (left.found > 0) {
      throw new Error(
        "普段のビルドの配信物（.app.tar.gz）が置き場に残っています。--rehearsal-old はこれを作り直して最後に消します\n" +
          "  → Windows へ運び終えていれば、置き場ごと消してからもう一度実行してください:\n" +
          "     rm -rf src-tauri/target/universal-apple-darwin/release/bundle"
      );
    }
  }
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
  const r = capture("npm", ["run", "tauri", "--", "signer", "generate", "-w", keyPath, "--password", ""], tauriChildEnv({
    CI: "true",
  }));
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
    //  ここを短い別名にすると**見張りの網から外れる**（リリース前の独立レビューで実証された穴）
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
  fs.writeFileSync(cfg, JSON.stringify(rehearsalReject ? rejectTempConfig(readRejectPubkey()) : tempConfig(rehearsalOld)), "utf8");
  const env: NodeJS.ProcessEnv = tauriChildEnv({
    // 個人情報監査: panic の位置情報などに埋まるホームの絶対パスを消す（R-8）
    RUSTFLAGS: `--remap-path-prefix=${os.homedir()}=~`,
    TAURI_SIGNING_PRIVATE_KEY: keyText,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  });
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
  if (!notaryAccepted(sub)) {
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

// ---------------- V175: 古い版の役を分ける（--rehearsal-old） ----------------
//
// ★古い版の役は**配らない**。確認先が 127.0.0.1 の .app が普段の置き場に残ると、次に配る物と取り違え得る。
//  だから成果物は dist-rehearsal/ へ**移し**（写すのではない＝置き場には残らない）、配信物（.app.tar.gz）は消す。
//  make_release.ts --with-mac も中の版が違えば止まる（二重の網）。

/** `dir` の下（入れ子の奥まで）で `suffix` で終わるファイル */
export function listFilesEndingWith(dir: string, suffix: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.name.endsWith(".app")) walk(p);
      else if (e.isFile() && e.name.endsWith(suffix)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 古い版の役の配信物を消す（★この回の .app.tar.gz は配らない）。消した本数を返す */
export function removeRehearsalTarballs(dir: string): number {
  let n = 0;
  for (const p of listFilesEndingWith(dir, ".app.tar.gz")) {
    try {
      fs.unlinkSync(p);
      n++;
    } catch {
      // 消せなかったものは呼ぶ側の確かめが拾って赤にする
    }
  }
  return n;
}

/** .app の Info.plist の版（読めなければ ""） */
function appVersion(appPath: string): string {
  try {
    const xml = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** 同じボリュームなら rename（署名も公証のチケットもそのまま）。違えば ditto で写してから元を消す */
function moveInto(src: string, dst: string) {
  try {
    fs.renameSync(src, dst);
  } catch {
    const r = capture("ditto", [src, dst]);
    if (r.code !== 0) throw new Error("古い版の役を dist-rehearsal/ へ移せませんでした");
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** 古い版の役（版が rehearsalOldVersion のもの**だけ**）を dist-rehearsal/ へ移す。普段のビルドの物は動かさない。
 *  V207: 断る役は dist-rehearsal-reject/ へ（dist-rehearsal/ は消さない） */
function separateRehearsal() {
  const outDir = rehearsalReject ? rejectDir : rehearsalDir;
  const outName = rehearsalReject ? "dist-rehearsal-reject/" : "dist-rehearsal/";
  console.log(`== 古い版の役を ${outName} へ分ける（配らない・REQ §10-3） ==`);
  const old = rehearsalOldVersion(conf.version);
  const appPath = path.join(bundleDir, "macos", `${product}.app`);
  const dmgDir = path.join(bundleDir, "dmg");
  const dmgs = fs.existsSync(dmgDir) ? fs.readdirSync(dmgDir).filter((n) => n.endsWith(".dmg") && n.includes(`_${old}_`)) : [];
  const appIsOld = fs.existsSync(appPath) && appVersion(appPath) === old;
  if (!appIsOld && dmgs.length === 0) {
    judge(`古い版の役（版 ${old}）の .app と .dmg が置き場にあります`, false);
    return;
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (appIsOld) {
    const dst = path.join(outDir, `${product}.app`);
    moveInto(appPath, dst);
    const vf = capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", dst]);
    judge(`${outName} の .app も署名の検証が通ります（移しても壊れていない）`, vf.code === 0, vf);
    const st = capture("xcrun", ["stapler", "validate", dst]);
    judge(`${outName} の .app にも公証のチケットがあります`, st.code === 0, st);
  } else judge(`古い版の役（版 ${old}）の .app が置き場にあります`, false);
  for (const n of dmgs) {
    const dst = path.join(outDir, n);
    moveInto(path.join(dmgDir, n), dst);
    const st = capture("xcrun", ["stapler", "validate", dst]);
    judge(`${outName} の .dmg（${n}）にも公証のチケットがあります`, st.code === 0, st);
  }
  if (dmgs.length !== 1) judge(`古い版の役の .dmg がちょうど 1 つ（いま ${dmgs.length} 個）`, false);
}

// ---------------- 本体 ----------------
async function main() {
  console.log(`== V174: Mac の署名・公証ビルド（${product}）${rehearsalReject ? "・V207 断る役（版の確かめを見る）" : rehearsalOld ? "・V175 リハーサルの古い版の役" : ""} ==`);
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
      // V175: どの版を検査しているのかを先に確かめる（--skip-build で古い版の役を拾っていないか）
      const want = rehearsalOld ? rehearsalOldVersion(conf.version) : conf.version;
      judge(`成果物の .app の版（Info.plist）が ${want}`, appVersion(appPath) === want);
      verifyApp(appPath);
      verifyNoPrivatePaths(appPath);
    }
    // V175: 古い版の役は版の入った名前で選ぶ（普段のビルドの .dmg が残っていても取り違えない）
    const dmg = findOne(path.join(bundleDir, "dmg"), rehearsalOld ? `_${rehearsalOldVersion(conf.version)}_universal.dmg` : ".dmg");
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
    if (rehearsalOld) {
      // V175: 古い版の役は配らない。成果物は dist-rehearsal/ へ移し、この回の配信物は消す（例外のあとでも）。
      // R-11 の消し込み（上の素の文）より**後ろ**に置き、ここで何が起きても消し込みは済んでいる形にした
      try {
        try {
          separateRehearsal();
        } catch (e) {
          judge(`古い版の役を dist-rehearsal/ へ分けられました（${scrub(e instanceof Error ? e.message : String(e))}）`, false);
        }
        console.log("== 古い版の役の配信物（.app.tar.gz）の消し込み ==");
        const gone = removeRehearsalTarballs(bundleDir);
        console.log(`  古い版の役の .app.tar.gz を ${gone} 本消しました`);
        judge("置き場に古い版の役の .app.tar.gz が 1 本も残っていません", listFilesEndingWith(bundleDir, ".app.tar.gz").length === 0);
      } catch (e) {
        judge(`古い版の役の後始末が最後まで通りました（${scrub(e instanceof Error ? e.message : String(e))}）`, false);
      }
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
  } else if (rehearsalReject) {
    console.log(`== 緑: 断る役（版 ${rehearsalOldVersion(conf.version)}・公開鍵は使い捨ての鍵）を dist-rehearsal-reject/ に作りました（配らない） ==`);
    console.log("   次: 別名で /Applications に置く（ditto は前の物に重ねるので、先に消す）:");
    console.log("       rm -rf /Applications/MemoAnima-rehearsal-reject.app");
    console.log("       ditto dist-rehearsal-reject/MemoAnima.app /Applications/MemoAnima-rehearsal-reject.app");
    console.log("   ⚠ /Applications/MemoAnima.app（本物）と MemoAnima-rehearsal.app（① の役）には置かない・上書きしない");
  } else if (rehearsalOld) {
    console.log(`== 緑: 古い版の役（版 ${rehearsalOldVersion(conf.version)}）を dist-rehearsal/ に作りました（配らない） ==`);
    console.log("   次: 別名で /Applications に置く（ditto は前の物に重ねるので、先に消す）:");
    console.log("       rm -rf /Applications/MemoAnima-rehearsal.app");
    console.log("       ditto dist-rehearsal/MemoAnima.app /Applications/MemoAnima-rehearsal.app");
    console.log("   ⚠ /Applications/MemoAnima.app（本物）には置かない・上書きしない（REQ §10-3 の P-0）");
  } else {
    console.log("== 緑: R-1 / R-2 / R-3 / R-5 / R-8 / R-11 / R-12 がすべて通りました ==");
    console.log("   次: .dmg を Release へ（R-4 は quarantine を消さずに別の入口で確かめます）");
  }
}

/** ★`npx tsx scripts/mac_build.ts` と打たれたときだけ走る。
 *
 *  読み込んだだけでは何もしない形にしてあるのは、回帰ゲート（`v174_smoke.ts`）が
 *  **この中の関数を実際に動かして**確かめられるようにするため。
 *  字面だけの検査は、書き方を少し変えるだけで抜けられる——リリース前の独立レビューが
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
