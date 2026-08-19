// M12-1c-2 / M12-D: **アプリが自動で付ける名前**（既定名）を1箇所に集める。
//
// 作者決定（2026-08-18）:
//   **新しく作られるものの既定名は、作った時点の UI 言語で付ける。**
//   英語 UI なら `Unsorted` / `Untitled` / `Layer 1` のように作られ、**以後その名前で固定**される
//   （ユーザーのデータなので、後から言語を変えても名前は変わらない）。
//
// ---- なぜ「定数」ではなく「関数」なのか（**ここが要**）----
// `export const X = t("…")` にすると **module 読み込み時の言語**で値が固まる。
// 言語は `applyI18n` / `setLang` で後から決まるので、定数にした瞬間この仕組みは無効になる。
// **必ず関数のまま**にして、使うところでその都度呼ぶこと。
// `scripts/m1201_i18n_check.ts` の**検査8**が、module 直下での `t()` 評価を機械的に止める。
//
// ---- 使うときの約束 ----
// - **保存された名前とこの戻り値を比較しない。** 保存済みの名前は「作られた時の言語」なので、
//   いまの UI 言語の既定名と一致する保証がない。
//   M12-D で最後の比較箇所（`pickSaveTarget`）を潰したので、**いま比較している所は1つも無い**。
//   「既定でよい」を表したいときは**文字列ではなく `null` を渡す**（pickSaveTarget がその形）。
// - **保存済みの名前は書き換えない**（マイグレーションしない）。既存ユーザーのアルバム `未分類` は
//   そのまま `未分類`。フォルダの実名なので、変えるとライブラリが壊れる。

import { t } from "./index";

/** 既定のアルバム名（ライブラリ直下の実フォルダ名になる・索引の `album` に入る） */
export function defaultAlbumName(): string {
  return t("defaults.album.label");
}

/** 「＋ アルバムを作成」の入力欄に最初から入っている名前 */
export function newAlbumName(): string {
  return t("defaults.newAlbum.label");
}

/** 単発 .kwz/.ppm を受け取るときの既定アルバム名（合作の受け取り） */
export function collabAlbumName(): string {
  return t("defaults.collabAlbum.label");
}

/** 題名のない作品の表示名・保存名 */
export function untitledTitle(): string {
  return t("defaults.untitled.label");
}

/** 新規レイヤーの既定名（`レイヤー1` のように連番が付く。作品ファイルへ保存される） */
export function layerBaseName(): string {
  return t("defaults.layer.label");
}

/** 新規フォルダの既定名（`フォルダ1` のように連番が付く。作品ファイルへ保存される） */
export function folderBaseName(): string {
  return t("defaults.folder.label");
}

/** 画像取り込みが作るレイヤーの名前 */
export function imageLayerName(): string {
  return t("defaults.imageLayer.label");
}

/** 画像から作った作品の既定の題名 */
export function imageProjectTitle(): string {
  return t("defaults.imageProject.label");
}

/** ショートカットの組み合わせ（プリセット）の既定名の頭。`カスタムA` のように英字が付く */
export function customPresetBaseName(): string {
  return t("defaults.customPreset.label");
}
