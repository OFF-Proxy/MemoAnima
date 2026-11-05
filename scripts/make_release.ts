// M7-3 P-2: BOOTH配布用の生成（一発再現）
//   実行: npx tsx scripts/make_release.ts [--skip-build] [--dry-run]
//   出力: dist-release/MemoAnima_v<version>_win64.zip     ポータブル版（**アプリからの更新は不可**）
//         dist-release/MemoAnima_<version>_x64-setup.exe  U-1: NSIS インストーラ（perUser）
//         dist-release/MemoAnima_<version>_x64-setup.exe.sig ＋ latest.json  U-1: updater の配信物
//   --dry-run: **何も書かずに同梱物の一覧だけ**出す。ビルドを飛ばし、LICENSES.txt は
//              一時フォルダへ出すので **dist-release/ を1バイトも触らない**（M12-4 §2）
// ※ PowerShell 版ではなく node 版にしている（常駐セキュリティソフトが .ps1 を検疫した実績があるため）
//
// V175: `--with-mac <フォルダ>`（REQ_mac_signing_and_update.md §2・§10-5）。**この指定があるときだけ**
//   latest.json に darwin-aarch64 / darwin-x86_64 を足す。**指定が無ければ出力は v1.9.5 と 1 バイトも違わない**。
//   フォルダには Mac で作った .app.tar.gz を**ちょうど 1 つ**だけ置く（.sig があれば止まる＝Mac の使い捨て鍵の
//   署名を持ち込ませない・中の Info.plist の版が違えば止まる）。dist-release/ に
//   <製品名>_<版>_universal.app.tar.gz として写し、**Windows の本物の鍵**で署名し、tauri.conf.json の公開鍵で
//   確かめてから（R-15）feed に入れる。feed は書く前と書いたあと読み直して §2「明示」の 8 項目を検査する。
//   門番・署名・R-15・明示の検査は、どれも dist-release/ へ写す前にある＝**検査で止まったときは何も増えない**。
//   最後の写す段（zip → LICENSES → NSIS → Mac → latest.json）の書き込みそのものが失敗したときは途中物が残り得るが、
//   latest.json は最後に写す（写した先が食い違えば消す）ので、配る feed が半端になることはない。
//   `--dry-run --with-mac`: Mac の部分は本物の鍵で最後まで通し、**一時フォルダに書く**（dist-release/ に触らない）。
//   Windows の署名は仮の文字列のまま。出てきた一時フォルダを Mac のリハーサルへ運ぶ（§10-3）
//
// U-1（U1-A / U1-D）でここが変わった:
//   1. `npx tauri build --no-bundle` の **`--no-bundle` を外した**。設定上 NSIS は元から対象
//      （`bundle.targets: "all"`）で、作られていなかった理由はこのフラグだけだった
//   2. **A-5 の自己検査**を入れた（下の `preflight` と `checkExeBytes`）。
//      `--skip-build` で素ビルドの exe が混ざる事故を、規律ではなく仕組みで止める
//   3. updater の配信物（`.sig` と `latest.json`）を作る。**署名鍵が無いと最初で止まる**
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
// V175: feed の組み立て・検査・署名の確かめは 1 か所（mac_update.ts）に集めた。Mac のリハーサルと出す日の check-live も同じ関数を通る
import {
  DRY_RUN_WINDOWS_SIGNATURE,
  assertReleaseSignature,
  buildFeed,
  commitStaged,
  inspectMacDir,
  installMacStaged,
  makeTauriSigner,
  prepareMacRelease,
  signingEnvProblem,
  signingEnvSummary,
  stageFeed,
  stagingDir,
  type MacStaged,
  type StagedFeed,
} from "./mac_update.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** M12-4: 中身の確認だけしたいとき。ビルドもせず zip も書かない（`--skip-build` を含む） */
const dryRun = process.argv.includes("--dry-run");
const skipBuild = dryRun || process.argv.includes("--skip-build");
/** V175: Mac の .app.tar.gz を置いたフォルダ。**`--with-mac` が無ければ null＝darwin は組み立てない**（REQ §2 の漏斗） */
const macDir: string | null = (() => {
  // `--with-mac=<フォルダ>` と打つと下の indexOf に当たらず**黙って既定の道**になる。打ち間違いは止める
  if (process.argv.some((a) => a.startsWith("--with-mac") && a !== "--with-mac")) {
    throw new Error("--with-mac とフォルダのあいだは空白で区切ってください（--with-mac=… の形は読みません）");
  }
  const at = process.argv.indexOf("--with-mac");
  if (at < 0) return null;
  const v = process.argv[at + 1] ?? "";
  if (v === "" || v.startsWith("--")) throw new Error("--with-mac のあとに .app.tar.gz を置いたフォルダを書いてください");
  return path.resolve(v);
})();

const conf = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")
);
const version: string = conf.version;
const product: string = conf.productName;
const zipName = `${product}_v${version}_win64.zip`;
/** U-1: 配信物の置き場（GitHub Releases のタグ）。`latest.json` の url に使う */
const DOWNLOAD_BASE = `https://github.com/OFF-Proxy/MemoAnima/releases/download/v${version}`;

// ---------------- A-5: 自己検査 ----------------
//
// 由来: v1.3.0 の出荷前の独立レビュー（台帳 A-5）。
// v1.3.0 の直前に `scripts/m1121_export_check.mts` へ絶対パスが残っていたのを、
// 「走査したあとにファイルが増え、誰も測り直していなかった」ために両者とも見落とした。
// **宣言ではなく、出荷のたびに毎回測る**のがここの役目。
//
// 2段に分けている:
//   `preflight()`    … ビルドの**前**。設定と文書だけで判定できるもの
//                      （3分のビルドが終わってから「README の版が違います」と言われても遅い）
//   `checkExeBytes()` … **zip を書く直前**。REQ §9 の指定どおりの位置
//                      （`--skip-build` で素ビルドの exe を拾う事故は、ここでしか捕まらない）
// **どちらか一方でも落ちれば dist-release/ には1バイトも書かれない。**

/** 文字列をそのまま当てる正規表現に変える（正規表現の記号は無効化する）。
 *  大文字小文字を無視するかは**呼ぶ側が決める**（下の作業フォルダ名の注を参照） */
const reOf = (s: string, flags = "i") => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

/**
 * exe のバイト列に**混ざってはいけない**もの。見つけたら throw して**出荷を止める**。
 *
 * U-1b (A-17): **具体的な文字列を書かず、実行時に導出する。**
 * U-1 では「ユーザー名」「旧ブランドのフォルダ名」を literal で書いていたが、このファイル自体が
 * `PUBLIC_REPO_allowlist.md` §B-4 の**公開対象**なので、同じ文書 §D の検査
 * （検査2=ユーザー名 / 検査4=ツール名 / 検査6=旧ブランド）に**自分で引っかかっていた**。
 * `m1121_export_check.mts` と同じ失敗の再発——あちらは「あとから増えたファイル」、
 * こちらは「リストに載っているファイルの中身が変わった」側。
 * 導出にすると literal が消えるうえ、**誰がビルドしても・どのフォルダ名でも**その環境の値で
 * 検査が効くので、検査としても強くなる。
 */
const FORBIDDEN: (readonly [string, RegExp])[] = [
  // 絶対パス（`--remap-path-prefix` が効いていれば出ない＝効いていないことの検出でもある）
  ["C:\\Users の絶対パス", /C:[\\/]Users/i],
  // 一時フォルダのパス（検証ハーネスの作業場所を含む。ツール名を書かない＝より広く捕まえる）
  ["一時フォルダのパス", /[\\/]Temp[\\/]/i],
];
{
  // ビルドした人の Windows ユーザー名。panic の位置情報やデバッグ情報に紛れ込む。
  // 3文字未満は使わない（`aa` のような短い名前は exe の無関係なバイト列に必ず当たる）
  const who = os.userInfo().username;
  if (who.length >= 3) FORBIDDEN.push(["ビルドした人の Windows ユーザー名", reOf(who)]);
  // 作業フォルダ名＝旧ブランド。exe に焼き付いていたら remap 漏れ。
  // **公開コピーはフォルダ名が製品名と同じ**なので、そのときは当てない
  // （exe には製品名が必ず入っている＝全ビルドが誤検知で止まる）。
  // **大文字小文字は区別する**（U-1b のカナリアで判明）: 小文字は crate 名・
  // 恒久対応の旧拡張子・ライブラリ索引のファイル名・旧識別子からの移行経路として
  // **正当に exe へ焼き付いている**（互換の要となる不変の内部識別子＝変更禁止）。
  // 無視すると**正常なビルドが全部止まる**。ここで捕まえたいのは**ブランドとしての綴り**のほう
  const folder = path.basename(root);
  if (folder !== product) FORBIDDEN.push([`作業フォルダ名（${folder}）`, reOf(folder, "")]);
}

/** 版数を表題に書いた配布文書。`tauri.conf.json` の version と**一致していること**
 *  （V190: `README_mac.txt` は zip に入れない＝Mac の .dmg と並べて BOOTH / Release に付ける。ここで見るのは版だけ） */
const VERSIONED_DOCS = ["release-assets/README.txt", "release-assets/README_en.txt", "release-assets/README_mac.txt"];

function preflight() {
  console.log("== A-5 自己検査（ビルド前） ==");

  // (1) U-1: updater の公開鍵が空のまま出荷しない。
  //     空の pubkey で配ると**その版の利用者は以後どの更新も検証できない**。
  //     鍵は実質ローテーション不可（旧クライアントは新しい公開鍵を知らない）なので、
  //     一度でも空のまま出すと、その人たちは手動での再インストールしか道が無くなる
  const pubkey: string = conf.plugins?.updater?.pubkey ?? "";
  if (!pubkey.trim()) {
    throw new Error(
      "A-5 自己検査で止めました: tauri.conf.json の plugins.updater.pubkey が空です\n" +
        "  → `npm run tauri signer generate -- -w <保管先>/memoanima-updater.key` で鍵を作り、\n" +
        "     公開鍵を tauri.conf.json へ、秘密鍵を TAURI_SIGNING_PRIVATE_KEY へ入れてください。\n" +
        "  ★ 秘密鍵は失うと以後の更新を一切配れません。作ったその場で2箇所以上へ保管してください"
    );
  }
  console.log(`  updater の公開鍵あり（${pubkey.length} 文字）`);

  // (2) 署名鍵が環境にあるか。無いまま build すると、**3分ビルドしたあとの最後**に
  //     tauri が「A public key has been found, but no private key」で落ちる（実測）
  if (!skipBuild && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error(
      "A-5 自己検査で止めました: 環境変数 TAURI_SIGNING_PRIVATE_KEY がありません\n" +
        "  → updater の配信物（.sig）に署名できません。ビルドの最後で落ちるので、ここで止めています"
    );
  }

  // (3) tauri.conf.json の version と配布文書の版が一致するか。
  //     見るのは**冒頭の表題だけ**——本文には「v1.2.0 以前で開くと…」のように
  //     **過去の版に触れる正当な記述**があり、全部を一致させると README が書けなくなる。
  //     表題は「その配布物が何の版か」を名乗る場所なので、ここが合っていれば取り違えは起きない
  const HEAD_LINES = 5;
  for (const rel of VERSIONED_DOCS) {
    const head = fs.readFileSync(path.join(root, rel), "utf8").split("\n").slice(0, HEAD_LINES);
    const found = [...new Set(head.join("\n").match(/v\d+\.\d+\.\d+/g) ?? [])];
    if (found.length === 0) {
      throw new Error(
        `A-5 自己検査で止めました: ${rel} の冒頭 ${HEAD_LINES} 行に版数（v1.2.3 の形）がありません`
      );
    }
    const wrong = found.filter((v) => v !== `v${version}`);
    if (wrong.length) {
      throw new Error(
        `A-5 自己検査で止めました: ${rel} の表題の版数が tauri.conf.json と違います\n` +
          `  tauri.conf.json: v${version}\n  ${rel}: ${wrong.join(" / ")}`
      );
    }
    console.log(`  ${rel} の表題が v${version} と一致`);
  }

  // (4) V154: **更新のお知らせが空のまま出荷しない。**
  //     `latest.json` の `notes` は README.txt の「■ v<version> で…」の節から作る。
  //     見出しの版数を上げ忘れたり、節を2つに分けたりすると**黙って空になり**、
  //     全利用者の更新ダイアログが白紙で出る（V153 で出荷寸前まで気づかなかった穴）。
  //     ビルドの3分を待たずに、ここで止める。
  const notes = buildNotes();
  if (!notes.trim()) {
    throw new Error(
      `A-5 自己検査で止めました: release-assets/README.txt に「■ v${version} で…」の節がありません\n` +
        "  → 更新のお知らせ（latest.json の notes）が空になります。\n" +
        "     前の版の見出しを今の版へ**付け替えて**ください（節を2つに分けると、前の版の項目は載りません）"
    );
  }
  // (4b) V217: **更新のお知らせを長くしすぎない**（上限 NOTES_MAX 文字・`[...notes].length` で数える）。
  //     更新の窓を描くのは**今入っている古い版**。v1.9.5 以前の窓はお知らせを改行せず、高さの上限も無いまま
  //     真ん中に置くので、長いと最小の窓（900×540）で［今すぐ更新］が画面の外へ出る（v1.9.5 の styles.css で
  //     組んで測った: 約 950 文字で窓の上が画面の外へ）。v2.0.0 の窓は直っているが、古い版から直接上げる人がいる間は要る。
  const NOTES_MAX = 900;
  if ([...notes].length > NOTES_MAX) {
    throw new Error(
      `A-5 自己検査で止めました: 更新のお知らせ（latest.json の notes）が ${[...notes].length} 文字で、上限 ${NOTES_MAX} 文字を超えています\n` +
        "  → v1.9.5 以前の更新の窓はお知らせを改行せず、高さの上限も無いので、長いと最小の窓（900×540）で\n" +
        "     ［今すぐ更新］が画面の外へ出ます。README.txt の「■ v<版> で変わったこと」の節を短くしてください\n" +
        "     （詳しい内容は見出しが「■ v<版> で」で始まらない別の節に書けば、notes には入りません）"
    );
  }
  console.log(`  README.txt に「■ v${version} で…」の節あり（notes ${[...notes].length} 文字）`);

  // (5) V154: 英語版にも今の版の節があるか。**notes には使わない**が、同梱の README_en.txt に
  //     前の版の見出ししか無いと、英語の利用者には「何が変わったのか」が届かない。
  //     見出しの形は `== FIXED IN v1.5.4 ==` / `== NEW IN v1.5.4 ==`（語は自由・版だけ見る）
  const enHasSection = fs
    .readFileSync(path.join(root, "release-assets", "README_en.txt"), "utf8")
    .split("\n")
    .some((l) => l.startsWith("== ") && l.includes(`v${version}`));
  if (!enHasSection) {
    throw new Error(
      `A-5 自己検査で止めました: release-assets/README_en.txt に v${version} の節（「== … v${version} …==」）がありません\n` +
        "  → 日本語版と同じく、前の版の見出しを今の版へ付け替えてください"
    );
  }
  console.log(`  README_en.txt に v${version} の節あり`);

  // (6) V175: --with-mac の材料。**3 分のビルドを待たずに**ここで落とす（--dry-run でも鍵が無ければ止まる）
  if (macDir !== null) {
    const problem = signingEnvProblem();
    if (problem) throw new Error(`A-5 自己検査で止めました（--with-mac）: ${problem}`);
    console.log(`  ${signingEnvSummary()}`);
    const mac = inspectMacDir(macDir, version);
    console.log(`  Mac の配信物: ${mac.tarFile}（Info.plist の版 ${mac.app.version} が tauri.conf.json と一致・.sig なし）`);
  }
}

function checkExeBytes(exe: Buffer) {
  console.log("== A-5 自己検査（zip を書く直前） ==");
  // latin1 で読むのは、UTF-16LE で埋まっている文字列も拾えるようにするため
  // （`o\0f\0f\0o\0f\0` は latin1 では `o.f.f.o.f` で、素の検索では見つからない）。
  // そこで **latin1 と「ヌルを抜いた形」の両方**に当てる
  const latin1 = exe.toString("latin1");
  const utf16 = latin1.replace(/\0/g, "");
  for (const [label, re] of FORBIDDEN) {
    for (const [what, hay] of [
      ["1バイト文字列", latin1],
      ["UTF-16 文字列", utf16],
    ] as const) {
      const m = hay.match(re);
      if (m) {
        const at = hay.indexOf(m[0]);
        const around = hay.slice(Math.max(0, at - 40), at + 60).replace(/[^\x20-\x7e]/g, ".");
        throw new Error(
          `A-5 自己検査で止めました: exe の${what}に「${label}」が入っています\n` +
            `  一致: ${JSON.stringify(m[0])}\n  周辺: ${JSON.stringify(around)}\n` +
            `  → RUSTFLAGS の --remap-path-prefix が効いているか、\n` +
            `     --skip-build で素ビルドの exe を拾っていないかを確認してください`
        );
      }
    }
  }
  console.log(`  exe に禁止文字列なし（${FORBIDDEN.length} パターン × 2 形式 / ${exe.length} バイト）`);
}

// ★ 何かを作る前に、設定と文書だけで分かることを先に落とす
preflight();

// 1) リリースビルド（U1-A: **NSIS インストーラも作る**ので --no-bundle を外した）
if (!skipBuild) {
  console.log("== tauri build ==");
  // 個人情報監査: panic位置情報などに埋まる絶対パス（ホームディレクトリ）を除去する
  const rustflags = `--remap-path-prefix=${os.homedir()}=~`;
  // U-1: updater の配信物（署名つき）を作る。**tauri.conf.json には置いていない**——
  // 置くと署名鍵の無い環境で `npm run tauri:build` が最後に必ず落ちる（実測）。
  // 配信物が要るのはリリースのときだけなので、ここで足す
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memoanima-cfg-")), "updater.json");
  fs.writeFileSync(cfg, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }), "utf8");
  execSync(`npx tauri build --config "${cfg}"`, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, RUSTFLAGS: rustflags },
  });
}
const exePath = path.join(root, "src-tauri", "target", "release", `${product}.exe`);
if (!fs.existsSync(exePath)) {
  throw new Error(`exe が見つかりません: ${exePath}（先にビルドしてください）`);
}

// V175 (--with-mac): Mac の配信物を **出力先に触る前に**一時フォルダで写し・署名し・R-15 で確かめる。
// ここで落ちれば LICENSES.txt も zip も作られない。★公開鍵は tauri.conf.json からだけ読む（引数・環境変数の口を作らない）
const updaterPubkey: string = conf.plugins.updater.pubkey;
let macStaged: MacStaged | null = null;
if (macDir !== null) {
  console.log("== Mac の配信物（--with-mac・REQ §2 の漏斗） ==");
  macStaged = prepareMacRelease({ macDir, version, product, pubkey: updaterPubkey, sign: makeTauriSigner() });
}

// 2) LICENSES.txt を自動生成
console.log("== LICENSES.txt 生成 ==");
// M12-4: --dry-run のときだけ一時フォルダへ出す。dist-release/ の既存物に指1本触れないため
const outDir = dryRun
  ? fs.mkdtempSync(path.join(os.tmpdir(), "memoanima-dryrun-"))
  : path.join(root, "dist-release");
fs.mkdirSync(outDir, { recursive: true });
// V175: 本番は一時フォルダに作り、確かめが全部通ってから dist-release/ へ写す（下の 7）。
// 途中で止まっても dist-release/ に半端な物を残さない（--dry-run は元から一時フォルダ）
const licensesDir = dryRun ? outDir : stagingDir("memoanima-licenses-");
execSync(`npx tsx scripts/make_licenses.ts "${path.join(licensesDir, "LICENSES.txt")}"`, {
  cwd: root,
  stdio: "inherit",
});

// 3) zip 化（README はテンプレを同梱。M12-4: 日本語版と英語版の2枚）
const exe = fs.readFileSync(exePath);
const files: Record<string, Uint8Array> = {
  [`${product}.exe`]: exe,
  "README.txt": fs.readFileSync(path.join(root, "release-assets", "README.txt")),
  "README_en.txt": fs.readFileSync(path.join(root, "release-assets", "README_en.txt")),
  "LICENSES.txt": fs.readFileSync(path.join(licensesDir, "LICENSES.txt")),
};

/**
 * U-1: 更新のお知らせ（`latest.json` の `notes`）を README.txt から抜く。
 *
 * 変更点は `release-assets/README.txt` の「■ v<version> で…」の節をそのまま使う。
 * 見出しの行の**次の行**から、次の「■ 」の行の**直前**まで。
 *
 * V153: 見出しの語を **「で」までしか固定しない**。以前は「で増えたこと」決め打ちで、
 * 不具合修正の回に「■ v1.5.3 で**直した**こと」と書いた瞬間、**更新のお知らせの本文が
 * 黙って空になった**。節の始まりは版で固定されているので、後ろの語は自由にしてよい。
 *
 * V154: ここを**行で読む**形に変えた（正規表現をやめた）。理由は2つ:
 *   - 版数のエスケープや `(?=...)` を書き間違えても**誰も気づけない**（空になるだけ）
 *   - 旧実装は**次に「■ 」の行があること**が条件で、その節がファイル末尾だと空になった。
 *     いまは末尾までを本文として拾う（**白紙になる方向へは倒さない**）
 * 改行は `\r\n` を `\n` に均してから読む（JSON に `\r` を持ち込まない）。
 */
function buildNotes(): string {
  const readme = fs
    .readFileSync(path.join(root, "release-assets", "README.txt"), "utf8")
    .replace(/\r\n?/g, "\n");
  const lines = readme.split("\n");
  const head = `■ v${version} で`;
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("■ ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

/** V154: 更新ダイアログに出る本文を**そのまま見せる**。空なら理由を添えて警告する。
 *  `--dry-run` と本番の両方から呼ぶので、**出荷のたびに必ず1回は目に入る**
 *  （V153 では、この処理が署名済みビルドの後ろにしか無く、出荷直前まで誰も見ていなかった）。 */
function showNotes(notes: string) {
  console.log(
    `== latest.json の notes（アプリの更新のお知らせに出る本文・${[...notes].length} 文字） ==`
  );
  if (!notes) {
    console.log(
      `⚠ **空です**。release-assets/README.txt に「■ v${version} で…」の節がありません` +
        "（見出しの版数を確認してください）。このまま出すと全利用者の更新ダイアログが白紙になります。"
    );
    return;
  }
  for (const line of notes.split("\n")) console.log(`  │ ${line}`);
}

// 4) 結果の確認表示（--dry-run はここで打ち切り＝zip を書かない）
const show = () => {
  for (const [name, data] of Object.entries(files)) {
    console.log(`${String(data.length).padStart(12)}  ${name}`);
  }
  console.log(`同梱物: ${Object.keys(files).length} ファイル`);
};
if (dryRun) {
  console.log(`== --dry-run: ${zipName} に入る予定の中身（zip は書きません） ==`);
  show();
  // V154: **`latest.json` を実際に組み立てて一時フォルダへ書く**（署名と URL は仮の文字列）。
  // 本番と同じ `buildNotes()` を通すので、「見出しの版数を間違えて notes が空」を
  // **署名済みビルドを待たずに**捕まえられる。dist-release/ には触れない（一時フォルダのみ）。
  const previewNotes = buildNotes();
  showNotes(previewNotes);
  // V175: 組み立ては本番と同じ buildFeed。Windows の署名だけは仮の文字列（検査は「仮」と分かる形で通す）
  const preview = buildFeed({
    version,
    notes: previewNotes,
    pubDate: new Date().toISOString(),
    windows: { signature: DRY_RUN_WINDOWS_SIGNATURE, url: `${DOWNLOAD_BASE}/${product}_${version}_x64-setup.exe` },
    mac: macStaged ? { signature: macStaged.signature, url: `${DOWNLOAD_BASE}/${macStaged.tarName}` } : undefined,
  });
  const staged = stageFeed(preview, {
    version,
    withMac: macStaged !== null,
    placeholderWindowsSignature: DRY_RUN_WINDOWS_SIGNATURE,
  });
  if (macStaged) installMacStaged(macStaged, outDir);
  commitStaged(staged.file, outDir, "latest.json");
  const previewPath = path.join(outDir, "latest.json");
  console.log(`（latest.json のプレビュー: ${previewPath}）`);
  console.log(`（LICENSES.txt の出力先は一時フォルダ: ${outDir}）`);
  if (macStaged) {
    console.log("== Mac のリハーサルへ運ぶもの（REQ §10-3 の 2・この一時フォルダの 3 つ） ==");
    for (const n of ["latest.json", macStaged.tarName, `${macStaged.tarName}.sig`]) {
      console.log(`${String(fs.statSync(path.join(outDir, n)).size).padStart(12)}  ${n}`);
    }
    console.log(`  場所: ${outDir}`);
    console.log("  ⚠ この latest.json の Windows の署名は仮の文字列です。配信には使えません（リハーサル専用）");
  }
  process.exit(0);
}

// ★ zip を書く直前。ここで止まれば dist-release/ には zip が増えない
checkExeBytes(exe);

// 5) U1-A: NSIS インストーラと updater の配信物を dist-release/ へ集める。
//    **新しいビルド系は作らない**——`tauri build` が bundle/nsis/ へ置いたものを拾うだけ。
//    MSI（bundle/msi/）は**わざと拾わない**: 既定で管理者権限が要り、perUser 一択という
//    U-1 の前提（tauri#7184）と食い違うため。配るのは NSIS だけ
//    V175: ここでは**読むだけ**にした。写すのは feed の検査が通って zip を書いたあと（下の 7）
const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
const nsisNames: string[] = [];
let sigText = "";
let setupName = "";
if (fs.existsSync(nsisDir)) {
  for (const name of fs.readdirSync(nsisDir)) {
    // 前回のビルドの成果物が残っていることがあるので、**この版のものだけ**拾う
    if (!name.includes(version)) continue;
    if (!/\.(exe|sig)$/i.test(name)) continue;
    nsisNames.push(name);
    if (/-setup\.exe$/i.test(name)) setupName = name;
    if (/\.sig$/i.test(name)) sigText = fs.readFileSync(path.join(nsisDir, name), "utf8").trim();
  }
}

// 6) U-1: updater の feed（`latest.json`）。**tauri は作ってくれない**ので、ここで組み立てる。
//    これを GitHub Releases に置き、memoanima.com の Worker がそのまま返す（プロキシ）
//    V175: **zip を書く前に**組み立てて検査する（REQ §2「明示」・書いたあとの読み直しは一時フォルダで）。
//    Windows の署名も R-15 で確かめる（出力は変えない）。1 つでも落ちれば、zip もインストーラも
//    Mac の配信物も latest.json も dist-release/ に増えない
let stagedFeed: StagedFeed | null = null;
if (setupName && sigText) {
  console.log("== R-15 配る署名を tauri.conf.json の公開鍵で確かめる ==");
  // V207: 信頼コメントの版も出す版（tauri.conf.json の version）と同じか（tauri build は CLI 2.12 から必ず版を入れる）
  assertReleaseSignature(path.join(nsisDir, setupName), sigText, updaterPubkey, setupName, version, "Windows のインストーラ");
  // 節の始まりは版で固定されているので、後ろの語（増えたこと／直したこと）は自由でよい。
  // V153: 空のまま出すと**全利用者の更新ダイアログが白紙**になる。黙って進まない
  const notes = buildNotes();
  showNotes(notes);
  const feed = buildFeed({
    version,
    notes,
    pubDate: new Date().toISOString(),
    windows: { signature: sigText, url: `${DOWNLOAD_BASE}/${setupName}` },
    mac: macStaged ? { signature: macStaged.signature, url: `${DOWNLOAD_BASE}/${macStaged.tarName}` } : undefined,
  });
  stagedFeed = stageFeed(feed, { version, withMac: macStaged !== null });
} else if (macStaged) {
  // 片方だけの feed を作らない（Windows の項目が無い feed は、Windows 全利用者の更新を止める）
  throw new Error(
    "--with-mac で止めました: Windows のインストーラと .sig（bundle/nsis/）が見つからないので feed を作れません（何も書いていません）"
  );
}

const zipped = zipSync(files, { level: 9 });
const zipPath = path.join(outDir, zipName);
fs.writeFileSync(zipPath, zipped);

// 7) V175: 確かめ終わったものだけを dist-release/ へ写す
commitStaged(path.join(licensesDir, "LICENSES.txt"), outDir, "LICENSES.txt");
const collected: string[] = [];
for (const name of nsisNames) {
  fs.copyFileSync(path.join(nsisDir, name), path.join(outDir, name));
  collected.push(name);
}
if (macStaged) collected.push(...installMacStaged(macStaged, outDir));
if (stagedFeed) collected.push(commitStaged(stagedFeed.file, outDir, "latest.json"));

console.log(`== 完成: ${zipPath} (${(zipped.length / 1024 / 1024).toFixed(1)} MB) ==`);
show();
if (collected.length) {
  console.log(`== インストーラと updater の配信物（U1-A / U1-B） ==`);
  for (const n of collected) {
    console.log(`${String(fs.statSync(path.join(outDir, n)).size).padStart(12)}  ${n}`);
  }
  if (macStaged) {
    // REQ §10-5: Release に足す添付は .app.tar.gz だけ。その .sig は添付しない（中身は latest.json に入っている）
    console.log(`※ ${macStaged.tarName}.sig は Release に添付しません（中身は latest.json に入っています・REQ §10-5）`);
  }
} else {
  console.log(
    "※ NSIS の成果物が見つかりません（bundle/nsis/）。--skip-build で古い exe を拾っていないか確認してください"
  );
}
