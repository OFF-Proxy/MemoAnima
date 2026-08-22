// M7-3 P-2: BOOTH配布用の生成（一発再現）
//   実行: npx tsx scripts/make_release.ts [--skip-build] [--dry-run]
//   出力: dist-release/MemoAnima_v<version>_win64.zip     ポータブル版（**アプリからの更新は不可**）
//         dist-release/MemoAnima_<version>_x64-setup.exe  U-1: NSIS インストーラ（perUser）
//         dist-release/MemoAnima_<version>_x64-setup.exe.sig ＋ latest.json  U-1: updater の配信物
//   --dry-run: **何も書かずに同梱物の一覧だけ**出す。ビルドを飛ばし、LICENSES.txt は
//              一時フォルダへ出すので **dist-release/ を1バイトも触らない**（M12-4 §2）
// ※ PowerShell 版ではなく node 版にしている（常駐セキュリティソフトが .ps1 を検疫した実績があるため）
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** M12-4: 中身の確認だけしたいとき。ビルドもせず zip も書かない（`--skip-build` を含む） */
const dryRun = process.argv.includes("--dry-run");
const skipBuild = dryRun || process.argv.includes("--skip-build");

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
// 由来: `docs/handoff/CODEX_review_v1_3_0.md` / `docs/BACKLOG_v1_3_1.md` A-5。
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

/** 版数を表題に書いた配布文書。`tauri.conf.json` の version と**一致していること** */
const VERSIONED_DOCS = ["release-assets/README.txt", "release-assets/README_en.txt"];

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

// 2) LICENSES.txt を自動生成
console.log("== LICENSES.txt 生成 ==");
// M12-4: --dry-run のときだけ一時フォルダへ出す。dist-release/ の既存物に指1本触れないため
const outDir = dryRun
  ? fs.mkdtempSync(path.join(os.tmpdir(), "memoanima-dryrun-"))
  : path.join(root, "dist-release");
fs.mkdirSync(outDir, { recursive: true });
execSync(`npx tsx scripts/make_licenses.ts "${path.join(outDir, "LICENSES.txt")}"`, {
  cwd: root,
  stdio: "inherit",
});

// 3) zip 化（README はテンプレを同梱。M12-4: 日本語版と英語版の2枚）
const exe = fs.readFileSync(exePath);
const files: Record<string, Uint8Array> = {
  [`${product}.exe`]: exe,
  "README.txt": fs.readFileSync(path.join(root, "release-assets", "README.txt")),
  "README_en.txt": fs.readFileSync(path.join(root, "release-assets", "README_en.txt")),
  "LICENSES.txt": fs.readFileSync(path.join(outDir, "LICENSES.txt")),
};

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
  console.log(`（LICENSES.txt の出力先は一時フォルダ: ${outDir}）`);
  process.exit(0);
}

// ★ zip を書く直前。ここで止まれば dist-release/ には zip が増えない
checkExeBytes(exe);

const zipped = zipSync(files, { level: 9 });
const zipPath = path.join(outDir, zipName);
fs.writeFileSync(zipPath, zipped);

// 5) U1-A: NSIS インストーラと updater の配信物を dist-release/ へ集める。
//    **新しいビルド系は作らない**——`tauri build` が bundle/nsis/ へ置いたものを拾うだけ。
//    MSI（bundle/msi/）は**わざと拾わない**: 既定で管理者権限が要り、perUser 一択という
//    U-1 の前提（tauri#7184）と食い違うため。配るのは NSIS だけ
const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
const collected: string[] = [];
let sigText = "";
let setupName = "";
if (fs.existsSync(nsisDir)) {
  for (const name of fs.readdirSync(nsisDir)) {
    // 前回のビルドの成果物が残っていることがあるので、**この版のものだけ**拾う
    if (!name.includes(version)) continue;
    if (!/\.(exe|sig)$/i.test(name)) continue;
    fs.copyFileSync(path.join(nsisDir, name), path.join(outDir, name));
    collected.push(name);
    if (/-setup\.exe$/i.test(name)) setupName = name;
    if (/\.sig$/i.test(name)) sigText = fs.readFileSync(path.join(nsisDir, name), "utf8").trim();
  }
}

// 6) U-1: updater の feed（`latest.json`）。**tauri は作ってくれない**ので、ここで組み立てる。
//    これを GitHub Releases に置き、memoanima.com の Worker がそのまま返す（プロキシ）
if (setupName && sigText) {
  // 変更点は README.txt の「■ v<version> で増えたこと」の節をそのまま使う
  //（更新ダイアログに出る本文。無ければ空でよい＝ダイアログ側が畳む）
  const readme = fs.readFileSync(path.join(root, "release-assets", "README.txt"), "utf8");
  const m = readme.match(new RegExp(`^■ v${version.replace(/\./g, "\\.")} で増えたこと[^\\n]*\\n([\\s\\S]*?)(?=\\n■ )`, "m"));
  const notes = (m?.[1] ?? "").trim();
  const feed = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": { signature: sigText, url: `${DOWNLOAD_BASE}/${setupName}` },
    },
  };
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(feed, null, 2), "utf8");
  collected.push("latest.json");
}

console.log(`== 完成: ${zipPath} (${(zipped.length / 1024 / 1024).toFixed(1)} MB) ==`);
show();
if (collected.length) {
  console.log(`== インストーラと updater の配信物（U1-A / U1-B） ==`);
  for (const n of collected) {
    console.log(`${String(fs.statSync(path.join(outDir, n)).size).padStart(12)}  ${n}`);
  }
} else {
  console.log(
    "※ NSIS の成果物が見つかりません（bundle/nsis/）。--skip-build で古い exe を拾っていないか確認してください"
  );
}
