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

/** V169 (B-3): Rust の門番（`read_file_raw` の `max_bytes`）が返す `TOO_LARGE:<実サイズ>` から
 *  バイト数を取り出す。**門番に当たった失敗だけ** `number`、それ以外（読み込み失敗・壊れている等）は `null`
 *  ＝呼ぶ側は `null` なら従来の文言をそのまま出す（他の失敗の文言は変えない）。
 *  `Error: ` の頭が付いていても拾う（`String(e)` 経由の文字列でも同じ答え）。DOM 非依存＝Node の smoke が直接叩く。 */
export function tooLargeBytes(msg: string): number | null {
  const m = /TOO_LARGE:(\d+)/.exec(msg);
  return m ? Number(m[1]) : null;
}
