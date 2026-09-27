// V173 (A-65): クラウド経由で受け取ると、作品ファイルの名前の末尾に `.gz` が付くことがある
// （転送側が gzip 圧縮を「中身」ではなく「名前」に記録してしまう）。PV6 の器は先頭が `1f 8b`＝
// gzip に見えるため、これが起きるのは **`.memoanima` / `.animemo` だけ**（`.kwz` は索引の行から出るので無事）。
//
// ★中身は 1 バイトも変わっていない。**名前だけの問題**なので、名前を扱う純関数をここに 1 か所置く。
//  ここに置いた理由: `main.ts` / `library.ts` は Tauri の API を import していて Node から叩けない。
//  「`foo.memoanima.gz` を取り込むと `foo.memoanima.gz.memoanima` になる」は**名前の付け替えを 1 手抜かした**
//  だけで起きる（`save_project_impl` は「`.memoanima` で終わらなければ足す」作り）ので、
//  ここを `scripts/v173_smoke.ts` が Node で直接叩いて固定する（[S-10]）。

/** クラウドが付ける拡張子。 */
const GZ_SUFFIX = ".gz";

/** 作品の拡張子（`PROJECT_EXT` / `PROJECT_EXT_LEGACY` と同じ 2 つ。**意味は変えない**）。 */
const PROJECT_EXTS = [".memoanima", ".animemo"] as const;

/** 末尾の `.gz` を 1 つだけ外す（大文字小文字は無視）。`.gz` で終わらなければそのまま返す。 */
export function stripGzSuffix(name: string): string {
  return name.toLowerCase().endsWith(GZ_SUFFIX) ? name.slice(0, -GZ_SUFFIX.length) : name;
}

/** `.gz` を外したうえで、作品の拡張子（`.memoanima` / `.animemo`）で終わるか。
 *
 *  ★**ふつうの `.gz` / `.tar.gz` を通さない**ための判定（R-8）。ドロップされたファイルが
 *  gzip に見えるだけで取り込みを始めると、副作用が大きい。 */
export function isProjectLikeName(name: string): boolean {
  const lower = stripGzSuffix(name).toLowerCase();
  return PROJECT_EXTS.some((e) => lower.endsWith(e));
}

/** V173 (W-10): 取り込みの失敗をログへ書く**前に**、パスと作品名を落とす。
 *  Rust の失敗の文には取り込み元のフルパスが混ざり得る（例:「取り込み元が見つかりません: <フルパス>」）
 *  ＝**利用者名と作品名がログに残る**。
 *
 *  ★Codex 指摘（優先度 高）: 語（空白区切り）だけを見る形だと、**名前に空白がある作品**で
 *   `C:\Users\me\作品 1.memoanima` → `<path> 1.memoanima` となり、**名前の断片が残った**。
 *   そこで「分かっているパスを**先に完全一致で**消す」→「残りを保険で落とす」の 2 段にした。
 *   ここに置いたのは、**この漏れ方そのものを Node で叩く**ため（`v173_smoke` [S-15]）。
 *
 *  @param known この失敗に関係するパス（分かっているものを渡す）。
 *    `.memoanima` / `.animemo`（`.gz` 付きも）は**ファイル名ごと**消す（名前＝作品名なので）。
 *    `.kwz` / `.ppm` は**フォルダだけ**消してファイル名は残す
 *    ——3DS の kwz は英数字のハッシュ名で作品名ではなく、どれが失敗したかを知る手掛かりになる（要件 §2 W-10）。 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** V173b: `k` を「区切り文字の書き方が違っても」「大文字小文字が違っても」消す。
 *
 *  ★Codex 指摘（優先度 高）: 完全一致だけだと、`known` が `C:\Users\John Doe\…` なのに
 *   理由の中が `C:/Users/John Doe/…`（区切りが逆）のとき**素通りし**、そのあとの保険が
 *   空白で止まるので `<path> Doe/My Album/<file>` のように**利用者名とフォルダ名の断片が残る**。 */
function blotOut(s: string, k: string, repl: string): string {
  const variants = new Set([k, k.replace(/\\/g, "/"), k.replace(/\//g, "\\")]);
  for (const v of variants) {
    if (!v) continue;
    s = s.replace(new RegExp(escapeRe(v), "gi"), repl);
  }
  return s;
}

export function importLogSafe(detail: string, known: string[] = []): string {
  let s = detail;
  for (const k of known) {
    if (!k) continue;
    const base = k.split(/[\\/]/).pop() ?? k;
    if (isProjectLikeName(base)) {
      s = blotOut(s, k, "<file>");
      if (base) s = blotOut(s, base, "<file>");
    } else {
      s = blotOut(s, k, base); // フォルダだけ落とす（ファイル名は残す）
    }
  }
  // ★V173b（Codex 指摘・高）: **作品ファイルへのパスは空白をまたいで**落とす。
  //  下の保険はどれも空白で止まるので、`C:/Users/John Doe/My Album/Secret Work.memoanima` のように
  //  **パスの途中に空白がある**と断片が残っていた。始まりは「パスらしい印」に限る＝日本語の説明文を飲み込まない。
  //  終わりは作品の拡張子（最短一致）。
  //  ⚠ **後読み（`(?<=…)`）は使わない**——この行は Mac（JavaScriptCore）でも走る。代わりに
  //   「ドライブ文字・UNC」と「行頭や区切りのあとの `/` `./` `../`」を 2 本に分け、後者は前の 1 文字を戻す
  s = s
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'）」]*?\.(?:memoanima|animemo)(?:\.gz)?/gi, "<file>")
    .replace(
      /(^|[\s"'（「:：])\.{0,2}[\\/][^\r\n"'）」]*?\.(?:memoanima|animemo)(?:\.gz)?/gi,
      "$1<file>"
    );
  // 保険（分かっていないパスが混ざったとき）。`mp3/wav` のような語まで潰さないよう、
  // ドライブ文字・UNC・区切りが `\`・スラッシュ 2 つ以上、のときだけ落とす
  s = s
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, "<path>")
    .replace(/\\\\[^\s"']+/g, "<path>")
    .replace(/\S*\\\S*/g, "<path>")
    // POSIX の絶対パスは「**語の先頭が `/`** で、もう 1 つ `/` がある」ときだけ
    //（`mp3/wav/ogg` のような語まで潰さないため）
    .replace(/(^|\s)\/[^\s"']*\/[^\s"']*/g, "$1<path>");
  // 最後の網: それでも残った作品ファイルの名前
  return s.replace(/[^\s"'()]*\.(?:memoanima|animemo)(?:\.gz)?/gi, "<file>");
}

/** V173b: ログの頭に付けてよい**ファイル名**（`.kwz` / `.ppm` だけ）。無ければ空文字。
 *
 *  ★Codex 指摘（優先度 低）: 解析ライブラリには `ArrayBuffer` を渡すので、失敗の理由に
 *   **ファイル名が入らない**。壊れた `.kwz` が複数あると、ログはどれも同じ 1 行になり
 *   「どれが失敗したか」が分からない。3DS の kwz は英数字のハッシュ名で**作品名ではない**ので、
 *   ここだけは名前を書いてよい（要件 §2 W-10）。`.memoanima` は名前＝作品名なので**付けない**。 */
export function logSafeFileLabel(p: string): string {
  const base = (p.split(/[\\/]/).pop() ?? "").trim();
  return /\.(?:kwz|ppm)$/i.test(base) ? base : "";
}

/** ドロップ取り込みで使う「保存名の素」。**先に `.gz` を外してから**拡張子を落とす。
 *
 *  `foo.memoanima.gz` → `foo`（`foo.memoanima` にすると、保存側が `.memoanima` を足して
 *  **`foo.memoanima.gz.memoanima`** になる＝R-7 が見ているのはここ）。 */
export function importBaseName(fname: string): string {
  return stripGzSuffix(fname).replace(/\.[^.]+$/, "");
}
