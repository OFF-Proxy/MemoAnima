// M7-3 P-2 / M9-1b: LICENSES.txt 自動生成
// - npm 実行時依存（package.json dependencies）: node_modules から名前/バージョン/ライセンス種別＋LICENSE全文
// - Rust クレート: cargo metadata からライセンス準拠表記の一覧（GPL v2 / Apache-2.0 / MIT 全文は末尾に1回掲載）
// - ffmpeg.wasm コア（FFmpeg + x264 = GPL v2+）: GPL v2 §3(b) の**書面によるオファー**を掲載
// ライセンス全文は scripts/licenses/*.txt に同梱（**ビルド時にネットワークへ取りに行かない**）
// 実行: npx tsx scripts/make_licenses.ts [出力パス]（既定 dist-release/LICENSES.txt）
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.resolve(process.argv[2] ?? path.join(root, "dist-release", "LICENSES.txt"));

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const deps: string[] = Object.keys(pkg.dependencies ?? {}).sort();

/** リポジトリ同梱のライセンス全文を読む（ネットワーク不使用・ビルド再現性のため） */
function readBundledLicense(name: string): string {
  const p = path.join(root, "scripts", "licenses", `${name}.txt`);
  if (!fs.existsSync(p)) {
    console.error(
      `FATAL: ライセンス全文が見つかりません: ${p}\n` +
        `LICENSES.txt には全文の同梱が必要です（ネットワークからは取得しません）。`
    );
    process.exit(1);
  }
  return fs.readFileSync(p, "utf8").replace(/\s+$/, "");
}

/** M10-1b: 同梱フォントのライセンス条文を tools/fonts/licenses/ の**取得したままの実物**から読む
 *  （要件定義書 §2.4 の記述を転記するのではなく、一次配布元の文面をそのまま載せる） */
function readFontLicense(name: string): string {
  const p = path.join(root, "tools", "fonts", "licenses", name);
  if (!fs.existsSync(p)) {
    console.error(
      `FATAL: フォントのライセンス条文が見つかりません: ${p}\n` +
        `tools/fonts/fetch_fonts.ps1 で取得してください。`
    );
    process.exit(1);
  }
  // BOM を落として末尾の空白を整える（文面そのものは一切書き換えない）
  return fs.readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\s+$/, "");
}

// M9-1b P-2: 書面オファーは「配布したバイナリに対応するソース」を約束するものなので、
// バージョンがずれると約束が成立しない。手書き定数にせず node_modules の実物から読む。
const ffmpegCoreVer: string | null = (() => {
  try {
    return (
      JSON.parse(
        fs.readFileSync(
          path.join(root, "node_modules", "@ffmpeg", "core", "package.json"),
          "utf8"
        )
      ).version as string
    ) || null;
  } catch {
    return null;
  }
})();
if (!ffmpegCoreVer) {
  console.error(
    "FATAL: @ffmpeg/core のバージョンを特定できません。GPL 書面オファーにはバージョンの明記が必須です。"
  );
  process.exit(1);
}

function readLicenseText(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const cand = fs
    .readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
    .sort();
  for (const f of cand) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) return fs.readFileSync(p, "utf8").trim();
  }
  return null;
}

const sections: string[] = [];
sections.push(
  `メモアニマ (MemoAnima) — 同梱オープンソースソフトウェア ライセンス一覧
生成: scripts/make_licenses.ts（自動生成。手で編集しない）
=====================================================================

本アプリは以下のオープンソースソフトウェアを含みます。各ソフトウェアの
著作権は各権利者に帰属します。`
);

// ---- M10-4: 配布物全体の実効ライセンス ----
sections.push(`=====================================================================
【配布物全体のライセンス】GNU GPL v3 以降
=====================================================================
メモアニマ (MemoAnima) 本体のソースコードは、GNU General Public License
version 3 以降（GPL-3.0-or-later）のもとで公開されています。
  ソースコード: https://github.com/OFF-Proxy/MemoAnima

本配布物は全体としても GNU GPL v3 の条件で頒布されます。

理由: 本配布物には、GPL が適用されるコンポーネント（@ffmpeg/core =
FFmpeg + x264、GPL v2 以降）と、Apache License 2.0 のみで提供される
コンポーネントが同居しています。Apache-2.0 の特許終了条項は GPL v2 とは
両立しませんが GPL v3 とは両立するため、両方を含む配布物として成立する
のは GPL v3 の側だけです。

適用範囲について:
- 同梱フォント（美咲ゴシック / PixelMplus / その他）は、この適用範囲の
  **外**です。本体とは独立した著作物が同じ配布物に収められているだけの
  「単なる集積」であり、それぞれ SIL Open Font License 1.1 または
  M+ FONT LICENSE に従います。詳細は本ファイルのフォントの節を参照。
- 利用者が本ソフトウェアを使って作成した作品（絵・アニメ・書き出した
  ファイル）には、このライセンスは**及びません**。作品は作成した本人の
  ものです。

The source code of MemoAnima itself is released under the GNU General
Public License version 3 or later. The distribution as a whole is
conveyed under the terms of the GNU GPL v3. Bundled fonts are separate
works aggregated with the program and remain under their own licenses
(SIL OFL 1.1 / M+ FONT LICENSE). Works created by users with this
program are not covered by this license.`);

// ---- 特記: ffmpeg.wasm (GPL v2+ / §3(b) 書面オファー) ----
sections.push(`=====================================================================
【特記】ffmpeg.wasm コア（@ffmpeg/core）について
=====================================================================
動画（MP4/GIF/APNG）変換には ffmpeg.wasm を使用しています。
同梱している @ffmpeg/core の WebAssembly バイナリは FFmpeg（LGPL v2.1+ /
一部 GPL コンポーネント）に加えて H.264 エンコーダ x264（GPL v2+）を含む
ビルドのため、このコンポーネントには GNU GPL v2 以降が適用されます。

同梱バージョン: @ffmpeg/core ${ffmpegCoreVer}

- 上流プロジェクト（ビルド手順を含む）:
  https://github.com/ffmpegwasm/ffmpeg.wasm
- FFmpeg:  https://ffmpeg.org/  (LGPL v2.1+ / 一部 GPL)
- x264:    https://www.videolan.org/developers/x264.html  (GPL v2+)

ffmpeg.wasm コアは改変せず、そのまま同梱しています。

---------------------------------------------------------------------
■ 対応ソースコードの入手方法（GNU GPL v3 第6条(d)）
---------------------------------------------------------------------
本配布物に含まれる GPL 対象物に対応するソースコードは、下記の場所から
誰でも**無償で**入手できます。

  メモアニマ本体: https://github.com/OFF-Proxy/MemoAnima
  @ffmpeg/core:   https://github.com/ffmpegwasm/ffmpeg.wasm
                  （同梱バージョン ${ffmpegCoreVer} に対応するもの）

---------------------------------------------------------------------
■ ソースコード提供の申し出
　（GNU GPL v3 第6条(b) および GNU GPL v2 第3条(b) に基づく）
---------------------------------------------------------------------
上記の入手方法に加えて、書面による申し出も併せて行います。

本配布物の頒布者は、本配布物を受け取ったいかなる第三者に対しても、
本配布物の頒布日から3年間、**本配布物に含まれる GPL 対象物すべて
（メモアニマ本体の実行ファイル、および同梱の @ffmpeg/core バイナリ）**
に対応する完全な機械可読形式のソースコード一式を提供することを、
ここに申し出ます。

本体には GNU GPL v3 第6条(b) が、@ffmpeg/core（GPL v2 以降）には
GNU GPL v2 第3条(b) が、それぞれ適用されます。

提供にかかる費用は、ソースコードの受け渡しに実際に要する費用を
超えない額とします。オンラインでの受け渡しの場合は無償です。

ご請求は下記までお願いします。
  メール: aru.oribo@gmail.com
  X（DM）: @Arcana_Proxy

なお、同一のソースコードは上記の各リポジトリからも入手できますが、
本申し出はそれらの提供状況にかかわらず有効です。

We hereby offer, to any third party who receives this distribution, a
complete machine-readable copy of the Corresponding Source for all
GPL-covered material contained in this distribution — namely the
MemoAnima executable itself and the bundled @ffmpeg/core binary — on a
medium customarily used for software interchange. This offer is made
under Section 6(b) of the GNU General Public License version 3 (for
MemoAnima itself) and under Section 3(b) of the GNU General Public
License version 2 (for @ffmpeg/core, which is GPL v2 or later). It is
valid for three (3) years from the date of distribution, for a charge
no more than the cost of physically performing source conveying.
The same source is also available at no charge from
https://github.com/OFF-Proxy/MemoAnima and
https://github.com/ffmpegwasm/ffmpeg.wasm .
Requests: aru.oribo@gmail.com (email) or X DM @Arcana_Proxy

GPL v2 の全文は本ファイル末尾に掲載しています。`);

// ---- npm deps ----
sections.push(`=====================================================================
JavaScript ライブラリ（実行時依存）
=====================================================================`);
for (const name of deps) {
  const dir = path.join(root, "node_modules", name);
  let meta: any = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    /* noop */
  }
  const lic = meta.license ?? "（package.json に記載なし）";
  const ver = meta.version ?? "?";
  const text = readLicenseText(dir);
  sections.push(
    `---------------------------------------------------------------------
${name} v${ver} — ライセンス: ${lic}
---------------------------------------------------------------------
${text ?? `（パッケージに LICENSE ファイル同梱なし。ライセンス種別: ${lic}。全文は末尾の標準ライセンス本文を参照）`}`
  );
}

// ---- Rust crates ----
sections.push(`=====================================================================
Rust クレート（バックエンド・cargo metadata より自動抽出）
=====================================================================
以下のクレートを exe にリンクしています（名前 / バージョン / ライセンス）。
MIT / Apache-2.0 / GPL v2 の本文は末尾に1回だけ掲載します。`);
/** M9-1b P-3-2: Apache-2.0 単独（デュアルでない）のクレート。全文同梱の要否判定に使う */
let apacheOnly: string[] = [];
try {
  const metaJson = execSync(
    `"${process.env.USERPROFILE}\\.cargo\\bin\\cargo.exe" metadata --format-version 1 --manifest-path src-tauri/Cargo.toml`,
    { cwd: root, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }
  );
  const meta = JSON.parse(metaJson);
  // M9-1b P-4: 自クレート名は Cargo.toml の [package] name から読む
  // （ハードコードだと、クレート名を変えたときに黙って自分自身が一覧に載る）
  const cargoToml = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
  const ownName = cargoToml.match(/^\s*\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  if (!ownName) {
    console.warn(
      "WARN: src-tauri/Cargo.toml から [package] name を読めませんでした。自クレートが一覧に混入する可能性があります。"
    );
  }
  const own = new Set(ownName ? [ownName] : []);
  const pkgs = meta.packages as any[];
  const kept = pkgs.filter((p) => !own.has(p.name));
  if (kept.length === pkgs.length) {
    console.warn(
      `WARN: 自クレートが除外されていません（name=${ownName ?? "不明"}）。src-tauri/Cargo.toml の package.name を確認してください。`
    );
  }
  apacheOnly = [
    ...new Set(
      kept
        .filter((p) => (p.license ?? "").trim() === "Apache-2.0")
        .map((p) => `${p.name} ${p.version}`)
    ),
  ].sort();
  const lines = kept
    .map((p) => `${p.name} ${p.version} — ${p.license ?? "(不明)"}`)
    .sort();
  sections.push([...new Set(lines)].join("\n"));
} catch (e) {
  sections.push(`（cargo metadata の実行に失敗: ${e}）`);
}

// ---- 標準ライセンス本文（MIT / Apache-2.0 / GPLv2 参照） ----
sections.push(`=====================================================================
標準ライセンス本文
=====================================================================

--- The MIT License (MIT) ---

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

--- Apache License 2.0 ---

"MIT OR Apache-2.0" のようなデュアルライセンスのクレートについては MIT を
選択して利用しています。以下は Apache-2.0 単独（デュアルでない）で提供されて
いるクレートで、これらのために本文を全文掲載します。
${
  apacheOnly.length
    ? apacheOnly.map((n) => `  - ${n}`).join("\n")
    : "  （make_licenses.ts 実行時点では、Apache-2.0 単独のクレートは存在しません）"
}

${readBundledLicense("Apache-2.0")}

--- GNU General Public License v3 (メモアニマ本体および配布物全体に適用) ---

メモアニマ本体のソースコードは GNU GPL v3 以降で公開されています。
完全なソースコードは https://github.com/OFF-Proxy/MemoAnima から無償で
入手できるほか、本ファイル冒頭の「ソースコード提供の申し出」に記載の
連絡先へご請求いただけます。

${readBundledLicense("GPL-3.0")}

--- GNU General Public License v2 (ffmpeg.wasm コアに適用) ---

同梱の @ffmpeg/core バイナリの完全なソースコードは、本ファイル冒頭の
「ソースコード提供の申し出」に記載の連絡先へご請求いただけます。
上流プロジェクト https://github.com/ffmpegwasm/ffmpeg.wasm からも
入手できます。

${readBundledLicense("GPL-2.0")}`);

// ---- 同梱フォント（M10-1b） ----
// 既存の節の**後ろ**に足す。既存の節の順序・内容は動かさない。
{
  // ファイル名・書体名・権利表記・一次配布元。権利表記は各配布物の実物から転記している。
  const FONT_FILES = [
    ["misaki.woff2", "美咲ゴシック", "Copyright(C) 2002-2021 Num Kadoma", "https://littlelimit.net/misaki.htm"],
    ["pixel12.woff2", "PixelMplus12 Regular", "Copyright (C) 2002-2013 M+ FONTS PROJECT", "https://github.com/itouhiro/PixelMplus"],
    ["pixel12-bold.woff2", "PixelMplus12 Bold", "Copyright (C) 2002-2013 M+ FONTS PROJECT", "https://github.com/itouhiro/PixelMplus"],
    ["maru.woff2", "Zen Maru Gothic Regular", "", "https://github.com/googlefonts/zen-marugothic"],
    ["maru-bold.woff2", "Zen Maru Gothic Bold", "", "https://github.com/googlefonts/zen-marugothic"],
    ["pop.woff2", "Dela Gothic One", "", "https://github.com/syakuzen/DelaGothic"],
    ["mincho.woff2", "Zen Antique", "", "https://github.com/googlefonts/zen-antique"],
  ];

  // OFL 3書体の copyright 行は、保存した OFL.txt の1行目をそのまま使う
  const oflCopyright = [
    "OFL-1.1_ZenMaruGothic.txt",
    "OFL-1.1_DelaGothicOne.txt",
    "OFL-1.1_ZenAntique.txt",
  ].map((f) => readFontLicense(f).split("\n")[0].trim());

  // OFL 1.1 の条文本体は3書体で完全に同一なので、1回だけ掲載する
  // （copyright 行だけが書体ごとに違う。差は末尾改行の有無のみであることを確認済み）
  const oflRef = readFontLicense("OFL-1.1_ZenMaruGothic.txt");
  const oflBody = oflRef.slice(oflRef.indexOf("This Font Software is licensed")).trim();

  sections.push(`=====================================================================
同梱フォント
=====================================================================
本アプリは、文字ツールで使用する日本語フォントを同梱しています（assets/fonts/）。
いずれも**必要な文字だけを取り出したサブセット版**で、元の書体データを一部のみ
含む改変版です。各書体の権利は各権利者に帰属します。

  ファイル               書体                       配布元
  ---------------------  -------------------------  --------------------------------
${FONT_FILES.map(
  ([file, name, , url]) => `  ${String(file).padEnd(21)}${String(name).padEnd(27)}${url}`
).join("\n")}

---------------------------------------------------------------------
■ SIL Open Font License 1.1 が適用される書体
---------------------------------------------------------------------
  - Zen Maru Gothic Regular / Bold  (maru.woff2 / maru-bold.woff2)
  - Dela Gothic One                 (pop.woff2)
  - Zen Antique                     (mincho.woff2)

各書体の著作権表示（配布元の OFL.txt 記載のまま）:

${oflCopyright.map((c) => `  ${c}`).join("\n")}

${oflBody}

---------------------------------------------------------------------
■ M+ FONT LICENSE が適用される書体
---------------------------------------------------------------------
  - 美咲ゴシック                    (misaki.woff2)
  - PixelMplus12 Regular / Bold     (pixel12.woff2 / pixel12-bold.woff2)

${readFontLicense("M+_FONT_LICENSE_E.txt")}

${readFontLicense("M+_FONT_LICENSE_J.txt")}

美咲フォントは同一の許諾条件で配布されています（配布物 misaki.txt の
「ライセンス」節より、原文のまま）:

  Copyright(C) 2002-2021 Num Kadoma

  These fonts are free softwares.
  Unlimited permission is granted to use, copy, and distribute it, with or
  without modification, either commercially and noncommercially.
  THESE FONTS ARE PROVIDED "AS IS" WITHOUT WARRANTY.

  これらのフォントはフリー（自由な）ソフトウエアです。
  あらゆる改変の有無に関わらず、また商業的な利用であっても、自由にご利用、
  複製、再配布することができますが、全て無保証とさせていただきます。

---------------------------------------------------------------------
■ 同梱フォントについての注記
---------------------------------------------------------------------
1. 同梱しているフォントファイルは、いずれも**サブセット化した改変版**です。
   アプリで使う文字（ASCII・かな・カタカナ・約物・常用漢字）だけを残し、
   それ以外のグリフを取り除いています。元の書体データそのものではありません。

2. 上記 SIL OFL 1.1 の3書体は、**著作権表示に Reserved Font Name（予約フォント名）の
   宣言がありません**。配布元の OFL.txt を確認したうえで同梱しています。
   したがって OFL 1.1 第3条の改名義務は発生せず、サブセット版を元の名称のまま
   同梱しています。

3. **このフォントを使って作った作品には、OFL は及びません。** OFL 1.1 第5条の
   後段が明示しているとおり、フォントで組んだ文書・画像・作品そのものは
   ライセンスの対象外です。本アプリで文字を入れて描いた作品は、利用者ご自身の
   ものであり、自由に扱っていただけます。

Note on the bundled fonts (English summary):
   The bundled font files are subsetted (modified) versions containing only the
   glyphs this application needs. None of the three OFL fonts above declares a
   Reserved Font Name in its copyright statement, so the renaming requirement of
   OFL 1.1 clause 3 does not apply. As stated in clause 5 of the OFL, documents
   and artwork created with these fonts are NOT covered by the license.`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, sections.join("\n\n") + "\n", "utf8");
console.log(`LICENSES written: ${outPath} (${fs.statSync(outPath).size} bytes)`);
