/** V154b: 例外を**利用者に見せる文字列**にする。
 *
 *  `String(e)` や `${e}` は `Error` の `toString()` を呼ぶので **`Error: ` が頭に付く**。
 *  それを「読み込みエラー: {err}」のような文へ差し込むと
 *
 *      読み込みエラー: Error: この作品はこの版では大きすぎて開けません。…
 *
 *  となり、「エラー」が2回続いて、**肝心の「ファイルは壊れていません」が埋もれる**。
 *  画面に出すのは**中身だけ**にする（ログには従来どおり `String(e)` を使ってよい——
 *  あちらは型名が手がかりになる）。 */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
