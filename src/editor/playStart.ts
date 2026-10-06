// V195 (A-96・Discord BUG-003): ▶ を押したとき、どのコマから再生を始めるか。
//
// ★決まり（再生の 3 か所で 1 つ・要件 REQ_discord_tickets_1004 §1）
//   **ループしない作品で、最後のコマにいるときに ▶ を押したら、先頭から再生する。**
//   それ以外の位置からは今どおりその位置から。1 コマだけの作品・ループする作品は今どおり。
//
//   使う所: ライブラリの .memoanima（`togglePreviewPlayback`）・ライブラリの .kwz/.ppm（同じ入口・
//   flipnote.js の Player）・編集画面（`togglePlayback`）。判断はここ 1 つにして、3 か所はこれを呼ぶだけ
//   （書き分けると 1 か所だけ直り忘れる。`scripts/v195_smoke.ts` が 3 か所とも本物の入口で確かめる）。
//
//   ⚠ 再生が終端で止まると、表示は最後のコマのまま残る（.memoanima の `previewFrame`・編集画面の
//   `frameIndex`）。そこから ▶ を押すと「最後のコマを 1 回出してすぐ終端」で止まっていたのが BUG-003。

/** ▶ を押したときに再生を始めるコマ。`cur` から始めるなら `cur` をそのまま返す。 */
export function playStartFrame(cur: number, count: number, loop: boolean): number {
  if (!loop && count > 1 && cur === count - 1) return 0;
  return cur;
}
