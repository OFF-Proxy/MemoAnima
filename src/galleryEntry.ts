// V198 (A-104): 本体にギャラリーへの入口を置く（docs/REQ_gallery_entry_v1.md v1.2）——決まりだけを置く純関数。
//
// 入口は 3 つ: E-1 ライブラリの「ギャラリー」ボタン（常設・設定に関係なく使える）／
// E-2 書き出しのあとのトーストに 1 行＋ボタン（S-1 でオフ・「次回から表示しない」で止まる）／
// E-3 初回ガイドの「さいきん増えたこと」の先頭の 1 文（main.ts の guideSteps）。
// **エディタの画面とメニューには何も足さない**（要件 §3）。開くのは利用者がボタンを押したときだけ。
// 通信は増やさない: URL とフォルダを OS に渡すだけ（ブラウザ・ファイラーが開く）。
// `scripts/v198_smoke.ts` が、URL がこの定数の 1 か所だけにあること・設定の読み書きの形を確かめる。

/** ギャラリーの根。★ここ 1 か所だけに書く。**何も付けない**（`?from=` 等・作品名・パス＝D-2「利用状況を送らない」） */
export const GALLERY_URL = "https://gallery.memoanima.com/";
/** 投稿画面（E-2 の「投稿画面を開く」） */
export const GALLERY_POST_URL = GALLERY_URL + "post";

/** E-2 の「次回から表示しない」を覚える id（settings.hiddenConfirms・V151 の確認と同じ形） */
export const GALLERY_HIDE_ID = "galleryAfterExport";

/** エディタが持っている確認の id（editor.restoreHiddenConfirms が知っている 3 つ）。
 *  エディタは一覧を書き戻すとき**自分の 3 つだけ**を返す＝それ以外（GALLERY_HIDE_ID）を落とさないために使う */
export const EDITOR_CONFIRM_IDS: readonly string[] = ["clearFrame", "layerDelete", "folderDelete"];

/** 読み書きするのはこの 2 つだけ（Settings 全体をそのまま渡してよい） */
export type GallerySettings = { galleryGuide?: boolean; hiddenConfirms?: string[] };

function hiddenList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** S-1 のスイッチの見た目＝E-2 の 1 行を出すか。**未設定＝オン**（`discordPresence` と同じ `!== false`）。
 *  「次回から表示しない」を押したあとはオフに見える（2 つのスイッチで同じ 1 行を出し入れしない） */
export function galleryGuideShown(s: { galleryGuide?: unknown; hiddenConfirms?: unknown }): boolean {
  return s.galleryGuide !== false && !hiddenList(s.hiddenConfirms).includes(GALLERY_HIDE_ID);
}

/** S-1 を押したとき。オン→オフは `galleryGuide: false` だけ。
 *  オフ→オンは「次回から表示しない」も解く（要件 A-4「S-1 をオフ→オンで戻る」）。ほかの確認の id には触らない */
export function toggleGalleryGuide(s: GallerySettings): void {
  if (galleryGuideShown(s)) {
    s.galleryGuide = false;
    return;
  }
  s.galleryGuide = true;
  const rest = hiddenList(s.hiddenConfirms).filter((id) => id !== GALLERY_HIDE_ID);
  if (s.hiddenConfirms !== undefined || rest.length) s.hiddenConfirms = rest;
}

/** E-2 の「次回から表示しない」。ほかの確認の id は残す */
export function hideGalleryAfterExport(s: GallerySettings): void {
  const cur = hiddenList(s.hiddenConfirms);
  if (!cur.includes(GALLERY_HIDE_ID)) cur.push(GALLERY_HIDE_ID);
  s.hiddenConfirms = cur;
}

/** エディタが「次回から表示しない」の一覧を書き戻すとき（onHiddenConfirmsChange）。
 *  エディタが渡すのは自分の 3 つだけなので、**それ以外の id は前の設定から引き継ぐ**
 *  （そのまま代入すると、エディタで確認を 1 つ隠しただけで E-2 の「次回から表示しない」が消えて案内が戻る） */
export function mergeEditorHiddenConfirms(prev: unknown, editorIds: readonly string[]): string[] {
  const keep = hiddenList(prev).filter((id) => !EDITOR_CONFIRM_IDS.includes(id));
  const mine = editorIds.filter((id) => EDITOR_CONFIRM_IDS.includes(id));
  return [...new Set([...mine, ...keep])];
}

/** ログの 1 行から URL を落とす（W-10: 開けなかった理由は書くが、URL・パスは書かない）。
 *  plugin-opener の断りの文（「Not allowed to open url …」）は URL をそのまま含むため */
export function scrubUrls(s: string): string {
  return s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
}
