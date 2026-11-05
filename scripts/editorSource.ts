// ★V213 (M-2a): editor.ts の「描いた結果を決める部分」は src/editor/core/editorCore.ts（`EditorCore`）へ移り、
//  editor.ts の `Editor` はそれを受け継ぐ（字は変えずに移した。PC も使うものは `private` → `protected`・
//  static の読み方は `Editor.` → `EditorCore.`）。
//
//  editor.ts の字や構文木を読んでコードの性質を数える検査は、ここで **editor.ts とコアのファイルの字を順に並べたもの**を読む
//  （見る所を広げるだけ・数え方は変えない＝要件 docs/REQ_mobile_m2_editor.md §4-8）。コアのファイルが無い木（V213 より前の写し）では
//  editor.ts だけを返す＝前の版でも同じ数になる。
import fs from "node:fs";
import path from "node:path";

/** editor.ts のコードが置かれているファイル（この順に並べる） */
export const EDITOR_SOURCE_FILES = ["src/editor/editor.ts", "src/editor/core/editorCore.ts"] as const;

/** editor.ts とコアの字（改行 1 つでつなぐ）。`dir` は木の根（作業ツリー・写し） */
export function readEditorSource(dir: string): string {
  return EDITOR_SOURCE_FILES.filter((f) => fs.existsSync(path.join(dir, f)))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

/** ファイルごと（相対パスと字）。字を書き換える反証が、書き換える字のあるファイルを選ぶのに使う */
export function editorSourceFiles(dir: string): { file: string; text: string }[] {
  return EDITOR_SOURCE_FILES.filter((f) => fs.existsSync(path.join(dir, f))).map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), "utf8") }));
}

/** 書き換える字（`from`）がちょうど 1 回あるファイル（editor.ts かコア）。どちらにも無い・両方にあるときは null */
export function editorFileHaving(dir: string, from: string | RegExp): string | null {
  const hit = editorSourceFiles(dir).filter(({ text }) => (typeof from === "string" ? text.includes(from) : from.test(text)));
  return hit.length === 1 ? hit[0].file : null;
}
