// V199 (A-106): 作品の名前の決まり（純関数・DOM に触らない）。要件 docs/REQ_title_filename.md
//
// ★作品の名前の正は**ファイル名**（ライブラリに出ている名前）。利用者が触れる名前はそれ 1 つ。
//   編集画面の左上・書き出しの既定の名前・別名で保存の既定の名前は、いま開いているファイルの名前（拡張子なし）から作る。
//   まだ保存していない新しいメモ（ファイルが無い）は今までどおり、作品の中の題名 `meta.title` か「無題」。
// ★保存するときは `meta.title` を**いまのファイル名にそろえて**書く（欄は前からある・保存形式は変えない）。
//   保存の書き先の名前は Rust の `pclib::save_project_impl` が決める（使えない文字を `_` に・末尾の . と空白を落とす・
//   拡張子を付け替える）。`savedFileBase` はその**同じ決め方**を写したもの。ずれていないことは
//   `pclib::v199_tests` の表（V199_NAME_CASES）を v199_smoke [T-1] が両側で突き合わせて見張る。
// ★M-1a（共通の部品の切り出し）でモバイルと共有する予定の決まり。ここは画面の文言を持たない。

/** 保存したときにディスクに書かれるファイルの名前（拡張子なし）。`pclib::save_project_impl` と同じ決め方:
 *  - Windows で使えない文字（`< > : " / \ | ? *`・制御文字）は `_`
 *  - 末尾の `.` と空白を落とす。空になったら `_`
 *  - 旧拡張子 `.animemo` は `.memoanima` に付け替える（どちらの拡張子も名前には含めない） */
export function savedFileBase(name: string): string {
  let s = "";
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    s += '<>:"/\\|?*'.includes(ch) || c < 0x20 ? "_" : ch;
  }
  s = s.replace(/[. ]+$/, "");
  if (s === "" || s === "." || s === "..") s = "_";
  const lower = s.toLowerCase();
  if (lower.endsWith(".animemo")) return s.slice(0, -".animemo".length);
  if (lower.endsWith(".memoanima")) return s.slice(0, -".memoanima".length);
  return s;
}

/** 保存が返したパス（`save_project` の戻り値＝書いたファイルの絶対パス）からファイルの名前（拡張子なし）。
 *  形が違えば null（呼び出し側は `savedFileBase` の値を使う） */
export function baseFromSavedPath(path: string): string | null {
  const last = path.split(/[\\/]/).pop() ?? "";
  const m = /^(.*)\.memoanima$/i.exec(last);
  return m && m[1] !== "" ? m[1] : null;
}

/** 編集画面の左上に出す名前。ファイルがあればファイルの名前、無ければ `meta.title` か「無題」 */
export function displayTitle(fileBase: string | null, metaTitle: string | undefined, untitled: string): string {
  return fileBase || metaTitle || untitled; // 空の名前（「.memoanima」だけのファイル）は無いのと同じ
}

/** 書き出し（アニメ・1 コマの画像）の既定のファイル名のもと。
 *  ファイルの名前はすでに拡張子なしなので**そのまま**（「あと3日.v2」の「.v2」を落とさない）。
 *  保存していない作品は今までどおり `meta.title`（.kwz の名前なら拡張子を落とす）か「無題」 */
export function exportBaseName(fileBase: string | null, metaTitle: string | undefined, untitled: string): string {
  return fileBase || (metaTitle || untitled).replace(/\.[^.]+$/, "");
}

/** オートセーブの復元の知らせに出す名前。保存先（アルバムとファイルの名前）が分かっていて、
 *  まだ保存先を選んでいない新しいメモでなければ、ファイルの名前（V199 より前のオートセーブも同じ＝題名が古くても名前は合う）。
 *  そうでなければ書いてある題名か「無題」 */
export function autosaveNoticeTitle(meta: Record<string, unknown> | null | undefined, untitled: string): string {
  const m = meta ?? {};
  if (typeof m.album === "string" && m.album && typeof m.baseName === "string" && m.baseName && m.askSaveTarget !== true)
    return m.baseName;
  return typeof m.title === "string" && m.title ? m.title : untitled;
}
