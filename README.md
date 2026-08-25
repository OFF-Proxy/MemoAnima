# MemoAnima (メモアニマ)

**English** | [日本語](#日本語)

A Windows tool for importing the flipbook animations you made on a Nintendo 3DS (`.kwz` / `.ppm`), editing them with a pen tablet, and exporting to **MP4 / GIF / APNG / a PNG sequence**. Everything runs on your PC.

> ⚠️ This is an unofficial, non-commercial fan tool made by one person. It has no connection to Nintendo Co., Ltd. or its affiliates, and is not licensed, sponsored, endorsed or otherwise approved by them.
>
> - It works with **animation data you created yourself**. **It cannot run game software, and it does not break any encryption.** 3DS animation files (`.kwz` / `.ppm`) are only read from your own device — there is no feature for obtaining or distributing them over the internet.
> - It contains **no** programs, images, sounds, fonts, data or keys owned by Nintendo Co., Ltd.
> - "Nintendo 3DS", "Flipnote Studio" and related names are trademarks or registered trademarks of Nintendo Co., Ltd. They are mentioned only to explain which file formats and environments are supported.

## What it does (v1.5.2)

- **7 languages**: Japanese, English, Spanish, Portuguese (Brazil), Korean, Chinese (Simplified) and Chinese (Traditional). It follows your Windows display language on first launch, and you can change it from the settings at any time — the change takes effect without a restart.
- **Import**: recursively scans the save folder read-only and copies into your PC library (the originals are never modified). Duplicates are skipped by SHA-256, and the album structure is preserved. Single `.kwz` / `.ppm` files shared with you are supported too.
- **Editor**: a 320×240 canvas at 1:1 pixels. Pen (6 sizes × textures) / brush (21 tone patterns) / eraser / fill / shapes / text / eyedropper / selection / move / transform (rotate, scale, flip) / copy-previous / paper colour / onion skin. Stabilizer and pressure toggles. Unlimited layers with nestable folders. Undo/redo and a 15-second autosave.
- **Selection**: box, lasso and auto. The bar under the selection gives you invert / grow / shrink / erase / cut to a new layer / copy to a new layer / transform / deselect. Arrow keys nudge by one pixel (Shift by ten).
- **Keyboard shortcuts**: 56 commands can be reassigned (2 built-in sets plus up to 8 of your own). Matching is by physical key position (`e.code`).
- **Colour**: a default palette plus full colour. The 8-bit index buffer is **promoted to 16-bit automatically at the 257th colour** (up to 65,536, lossless).
- **Faithful import**: verified pixel-for-pixel against 41 real animations (3 layers, 6 colours, paper colour and per-frame draw order all preserved).
- **Sound**: music plus effects (multiple tracks, placed per frame, tied to playback speed). The audio in the imported file is separated out and loaded too. Replacement accepts mp3 / wav / ogg.
- **Image import**: the 📷 button turns a photo into pixels and places it on the current frame (colour quantisation, two-tone screentone, or line art, with a live preview).
- **Text**: 5 fonts. Size and weight follow the font. Horizontal or vertical. **You can keep editing until you apply it** — line breaks, font and size changes, moving it around, and it is never clipped at the canvas edge.
- **Warp**: push (liquify), bulge and pinch, and free transform by dragging the four corners (projective). Works inside a selection only, if there is one.
- **Wobble frames**: generate a few slightly shifted copies of one frame and insert them right after it (count, strength and type are selectable). The same input always gives the same result.
- **Cursor**: choose dot, cross or arrow, with an optional ring showing the area your nib would paint and an optional box around the single pixel under the cursor.
- **Export**: MP4 (with audio) / GIF / APNG / a zipped PNG sequence. Integer upscaling ×1 / 2 / 4 / 8 (nearest, default ×4). A single frame can be saved as PNG / JPEG (the same ×1 / 2 / 4 / 8; PNG can keep the background transparent).
- **Works offline**: drawing, editing and exporting need no network (ffmpeg.wasm is bundled). The one thing the app does on its own is check whether a newer version exists — once, at startup, by reading a small file at a fixed address; nothing about you is sent, and the comparison happens on your machine. You can turn that off in the gear menu, and turning it off limits nothing else. Nothing is ever downloaded until you say so, and if the network is unreachable the app stays silent and keeps working.
- **In-app update**: when a newer version is found, the app offers to install it. Windows closes the app while the installer runs, so it asks first.

Distribution is an NSIS installer (per-user, no administrator rights) plus a portable zip for BOOTH (`MemoAnima.exe` + `README.txt` + `README_en.txt` + `LICENSES.txt`). **The portable zip cannot update itself from inside the app** — settings, library and autosave live in `%APPDATA%\com.arcana.memoanima` either way, so moving from the zip to the installer keeps everything.

## Built with

- **Tauri v2** (produces the .exe)
- **Rust** backend: scanning the save folder, managing the PC library, atomic file I/O
- **TypeScript + Vite** frontend, **flipnote.js** (parsing and playing `.kwz` / `.ppm`)
- Audio: Web Audio API — Export: ffmpeg.wasm (bundled)

## Development

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install) (rustup)
- Windows: WebView2 (normally present on Win10/11) / [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Run and build
```bash
npm install
npm run tauri:dev      # dev run (the first Rust dependency build takes a few minutes)
npm run build          # frontend typecheck + build
npm run tauri:build    # build the .exe
```

### Checks
```bash
npx tsx scripts/m3_smoke.ts <path to a library>   # import fidelity + save-format roundtrip
npx tsx scripts/m8_smoke.ts                       # image conversion (GUI ↔ CLI output match)
npx tsx scripts/m1201_i18n_check.ts               # translation gates (keys, placeholders, lengths, hardcoded text)
```
When touching the save format or rendering, run every smoke in `scripts/` (`m3` / `n2` / `m33` / `m37` / `m5` / `m62` / `m8`).

### Building the distributable
```bash
npx tsx scripts/make_release.ts   # dist-release/MemoAnima_v<version>_win64.zip
```

## Handling private data (important)

**Do not commit imported personal animation files** (`*.kwz` / `*.ppm`) to the repository (they are already in `.gitignore`). Test images placed at the repository root (`*.jpg` / `*.png`) are ignored for the same reason.

## Licence and credits

- Author: arcana (X: [@Arcana_Proxy](https://x.com/Arcana_Proxy))
- **The source code of the application is published under the GNU General Public License v3 or later (GPL-3.0-or-later).** The full text is in [`LICENSE`](LICENSE) at the repository root. Source: https://github.com/OFF-Proxy/MemoAnima
- **The bundled fonts are not covered by the application's licence.** They are distributed under the SIL Open Font License 1.1 / M+ FONT LICENSE and are merely aggregated into the same distribution. Each font's terms are listed in `LICENSES.txt` inside the distributable.
- **The GPL does not extend to what you create with this software.** The drawings, animations and exported files are yours, and this licence places no restriction on them.
- Dependencies (flipnote.js and others) are used under their own licences; `LICENSES.txt` ships with the distributable. The ffmpeg.wasm core used for video conversion (which includes FFmpeg and x264) is covered by the GPL.
- This project is an unofficial, non-commercial fan tool — see the notice at the top.

---

<a id="日本語"></a>

[English](#memoanima-メモアニマ) | **日本語**

## メモアニマ (MemoAnima)

ニンテンドー3DSで作ったお絵かきアニメ作品（`.kwz` / `.ppm`）をPCに取り込み、ペンタブ・液タブで編集して **MP4 / GIF / APNG / PNG連番** に書き出せる Windows 向けツール（PC完結型）。

> ⚠️ 本ソフトは個人制作の非公式・非営利ファンツールです。任天堂株式会社およびその関連会社とは一切関係がなく、許諾・後援・提携・推奨を受けたものではありません。
>
> - 扱うのは **利用者ご自身が作成した作品データ**です。**ゲームソフトを動作させる機能はありません。暗号の解除も行いません。** 3DS の作品ファイル（`.kwz` / `.ppm`）は、お手元の端末にあるものを読み込むだけで、インターネット経由で取得・配信する機能はありません。
> - 任天堂株式会社が権利を有するプログラム・画像・音声・フォント・データ・鍵等は **一切同梱していません**。
> - 「ニンテンドー3DS」「うごくメモ帳」「Flipnote Studio」は任天堂株式会社の商標または登録商標です。対応形式・動作環境の説明目的でのみ言及しています。

## できること（v1.5.2）

- **7言語対応**: 日本語／英語／スペイン語／ポルトガル語（ブラジル）／韓国語／中国語（簡体字）／中国語（繁体字）。初回は Windows の表示言語に合わせて開き、⚙ からいつでも変更できます（**再起動なしで反映**）。
- **カーソル**: 編集中のカーソルを点／十字／矢印から選択。いま置いたら塗られる範囲を示す輪と、カーソルが乗っている1ドットの枠をそれぞれ切り替えられます。
- **取り込み**: 保存フォルダを read-only で再帰スキャンし、PCライブラリへ独立コピー（元データは不変）。SHA-256 で重複回避、アルバム構成を保持。単発の `.kwz` / `.ppm` の受け取り（合作）にも対応。
- **エディタ**: 320×240 のドット等倍キャンバス。ペン（6サイズ×テクスチャ）／ブラシ（トーン21種）／消しゴム／塗り／図形／文字／スポイト／範囲選択／移動／変形（回転・拡縮・反転）／複写／紙色／オニオンスキン。手ブレ補正・筆圧トグル。レイヤー無制限＋フォルダ（ネスト可）。Undo/Redo・15秒オートセーブ。
- **選択範囲**: 矩形・自由・自動。選択の下に出る操作バーから反転／拡張／縮小／消去／切り取って新規レイヤー／コピーして新規レイヤー／変形／解除。矢印キーで1ドット単位の移動（Shift で10ドット）。
- **ショートカットキー**: 56コマンドの割り当てを変更可能（組み込み2種＋自作8組まで）。判定は物理キー位置（`e.code`）。
- **色**: 既定パレット＋フルカラー。索引 8bit から **257色目で16bitへ自動昇格**（最大65,536色・可逆）。
- **忠実インポート**: 実データ41作品でピクセル完全一致を検証済み（3層・6色・紙色・コマ固有の描画順を保持）。
- **サウンド**: BGM＋SE（複数トラック・コマ単位配置・速度連動）。取り込み元の音声も分離して読み込み。差し替えは mp3 / wav / ogg。
- **画像取り込み**: 編集画面の📷から写真をドット化して現在のページへ配置（カラー量子化／2値トーン／輪郭線画・リアルタイムプレビュー）。
- **テキスト**: 5書体（美咲ゴシック／PixelMplus12／丸ゴシック／ポップ／明朝）から選択。書体に応じたサイズ・太さ。横書き／縦書き。**確定するまで何度でも直せる**（改行・書体やサイズの変更・移動。キャンバスからはみ出しても切れない）。
- **歪み**: 液状化（押す）／魚眼（ふくらませ・へこませ）／四隅をつまんでの自由変形（射影変換）。範囲選択の中だけにも効く。
- **ゆらゆら差分**: 1コマから少し揺れた差分を数枚生成して直後に挿入（枚数・強さ・種類を選択）。同じ入力なら同じ結果。
- **書き出し**: MP4（音声付き）／GIF／APNG／PNG連番zip。整数倍アップスケール ×1／2／4／8（nearest・既定 ×4）。1コマだけを PNG / JPEG で保存（同じく ×1／2／4／8・PNG は背景の透過を選択可）。
- **オフラインで動く**: 描画・編集・書き出しにネットワークは要りません（ffmpeg.wasm も同梱）。アプリが自分から通信するのは「新しい版が出ているかの確認」だけで、起動時に一度、決まったアドレスから「最新版はどれか」を書いた小さなファイルを読むだけです（あなたの情報は送りません。新旧の判断は手元で行います）。⚙ からいつでもオフにでき、オフにしても他の機能は一切制限されません。見つかっても押していただくまでダウンロードはせず、通信できないときは何も出さずにそのまま使えます。
- **アプリ内アップデート**: 新しい版が見つかると、その場で更新できます。更新中は Windows がアプリを一度閉じるので、必ず先に確認します。

配布形態は NSIS インストーラ（perUser・管理者権限なし）と、BOOTH 向けのポータブル zip（`MemoAnima.exe` ＋ `README.txt` ＋ `README_en.txt` ＋ `LICENSES.txt`）。**ポータブル zip はアプリからの更新ができません**。設定・ライブラリ・オートセーブはどちらも `%APPDATA%\com.arcana.memoanima` にあるので、zip からインストーラ版へ移ってもそのまま引き継がれます。

## 技術構成

- **Tauri v2**（.exe化）
- **Rust** バックエンド: 保存フォルダのスキャン・PCライブラリ管理・原子的なファイルI/O
- **TypeScript + Vite** フロント、**flipnote.js**（`.kwz` / `.ppm` の解析・再生）
- 音声: Web Audio API ／ 書き出し: ffmpeg.wasm（同梱）

## 開発セットアップ

### 前提ツール
- [Node.js](https://nodejs.org/)（LTS）
- [Rust](https://www.rust-lang.org/tools/install)（rustup）
- Windows: WebView2（Win10/11 は通常搭載）／[Tauri前提条件](https://v2.tauri.app/start/prerequisites/)

### 起動・ビルド
```bash
npm install
npm run tauri:dev      # 開発起動（初回はRustの依存ビルドで数分かかります）
npm run build          # フロントの型チェック＋ビルド
npm run tauri:build    # .exe ビルド
```

### 検証
```bash
npx tsx scripts/m3_smoke.ts <ライブラリのパス>   # 取り込み忠実性＋保存形式の往復
npx tsx scripts/m8_smoke.ts                      # 画像変換（GUI↔CLI の出力一致）
```
保存形式や描画に触れる変更のときは、`scripts/` のスモークを全系統流してください（`m3` / `n2` / `m33` / `m37` / `m5` / `m62` / `m8`）。

### 配布物の生成
```bash
npx tsx scripts/make_release.ts   # dist-release/MemoAnima_v<version>_win64.zip
```

## 秘密情報の扱い（重要）

取り込んだ個人の作品ファイル（`*.kwz` / `*.ppm`）は **リポジトリにコミットしない**でください（`.gitignore` 済み）。
リポジトリ直下に置いたテスト用の画像（`*.jpg` / `*.png`）も同様に ignore しています。

## ライセンス / クレジット

- 作者: アルカナ (arcana)（X: @Arcana_Proxy）
- **本体のソースコードは GNU General Public License v3 以降（GPL-3.0-or-later）で公開しています。**
  全文はリポジトリ直下の [`LICENSE`](LICENSE) を参照してください。
  ソースコードの入手先: https://github.com/OFF-Proxy/MemoAnima
- **同梱フォントは本体のライセンスの対象外です。** それぞれ SIL Open Font License 1.1 /
  M+ FONT LICENSE のもとで配布されており、本体と同じ配布物に収められているだけの「単なる集積」です。
  各フォントの条件は配布物の `LICENSES.txt` に記載しています。
- **利用者がこのソフトで作成した作品には GPL は及びません。** 描いた絵・アニメ・書き出したファイルは
  すべて作成した本人のもので、このライセンスによる制約を受けません。
- 依存 OSS（flipnote.js ほか）のライセンスに従います。配布物には `LICENSES.txt` を同梱しています。
  動画変換に使う ffmpeg.wasm のコア（FFmpeg + x264 を含む）には GPL が適用されます。
- 本プロジェクトは非公式・非営利のファンツールです（冒頭の注意書きを参照）。
