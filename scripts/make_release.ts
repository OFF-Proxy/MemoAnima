// M7-3 P-2: BOOTH配布用ポータブルzipの生成（一発再現）
//   実行: npx tsx scripts/make_release.ts [--skip-build] [--dry-run]
//   出力: dist-release/MemoAnima_v<version>_win64.zip
//         （exe + README.txt + README_en.txt + LICENSES.txt の4ファイル）
//   --dry-run: **何も書かずに同梱物の一覧だけ**出す。ビルドを飛ばし、LICENSES.txt は
//              一時フォルダへ出すので **dist-release/ を1バイトも触らない**（M12-4 §2）
// ※ PowerShell 版ではなく node 版にしている（常駐セキュリティソフトが .ps1 を検疫した実績があるため）
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

// 1) リリースビルド（ポータブル配布なので NSIS/MSI バンドルは作らない）
if (!skipBuild) {
  console.log("== tauri build (--no-bundle) ==");
  // 個人情報監査: panic位置情報などに埋まる絶対パス（ホームディレクトリ）を除去する
  const rustflags = `--remap-path-prefix=${os.homedir()}=~`;
  execSync("npx tauri build --no-bundle", {
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
const files: Record<string, Uint8Array> = {
  [`${product}.exe`]: fs.readFileSync(exePath),
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
const zipped = zipSync(files, { level: 9 });
const zipPath = path.join(outDir, zipName);
fs.writeFileSync(zipPath, zipped);

console.log(`== 完成: ${zipPath} (${(zipped.length / 1024 / 1024).toFixed(1)} MB) ==`);
show();
