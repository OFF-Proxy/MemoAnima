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
 *  ★独立レビューの指摘（優先度 高）: 語（空白区切り）だけを見る形だと、**名前に空白がある作品**で
 *   `D:\Users\me\作品 1.memoanima` → `<path> 1.memoanima` となり、**名前の断片が残った**。
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
 *  ★独立レビューの指摘（優先度 高）: 完全一致だけだと、`known` が `D:\Users\John Doe\…` なのに
 *   理由の中が `D:/Users/John Doe/…`（区切りが逆）のとき**素通りし**、そのあとの保険が
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
    } else if (isNoteName(base)) {
      // ★V216b (A-133): .kwz／.ppm は 3DS が付ける名前の形のときだけ名前を残す。改名したもの（作品名が入りうる）は拡張子だけ
      const label = logSafeFileLabel(base);
      s = blotOut(s, k, label);
      if (label !== base) s = blotOut(s, base, label);
    } else {
      s = blotOut(s, k, base); // フォルダだけ落とす（ファイル名は残す）
    }
  }
  // ★V173b（独立レビューの指摘・高）: **作品ファイルへのパスは空白をまたいで**落とす。
  //  下の保険はどれも空白で止まるので、`D:/Users/John Doe/My Album/Secret Work.memoanima` のように
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
 *  ★独立レビューの指摘（優先度 低）: 解析ライブラリには `ArrayBuffer` を渡すので、失敗の理由に
 *   **ファイル名が入らない**。壊れた `.kwz` が複数あると、ログはどれも同じ 1 行になり
 *   「どれが失敗したか」が分からない。3DS の kwz は英数字のハッシュ名で**作品名ではない**ので、
 *   ここだけは名前を書いてよい（要件 §2 W-10）。`.memoanima` は名前＝作品名なので**付けない**。 */
export function logSafeFileLabel(p: string): string {
  const base = (p.split(/[\\/]/).pop() ?? "").trim();
  const m = /^(.*)\.(kwz|ppm)$/i.exec(base);
  if (!m) return "";
  // ★V216b (A-133・C-27): 名前を残すのは 3DS が付ける名前の形のときだけ（拡張子の前で見る）。ほか（改名したもの）は拡張子だけ
  const ext = m[2].toLowerCase() as "kwz" | "ppm";
  return isDsNoteStem(m[1], ext) ? base : `*.${ext}`;
}

/** ★V216b (A-133): 3DS が付ける名前の形（flipnote.js の `REGEX_KWZ_FILENAME`・`REGEX_PPM_FILENAME`・`REGEX_PPM_LOCAL_FILENAME` と同じ）。
 *  拡張子の前の部分で見る。大文字と小文字も同じ決まり（kwz は小文字・ppm は大文字の 16 進）＝違えば「3DS の形ではない」 */
export const DS_KWZ_STEM = /^[0-5a-z]{28}$/;
export const DS_PPM_STEM = /^[0-9A-F]{6}_[0-9A-F]{13}_[0-9]{3}$/;
export const DS_PPM_LOCAL_STEM = /^[0-9A-Z]{1}[0-9A-F]{5}_[0-9A-F]{13}_[0-9]{3}$/;

function isDsNoteStem(stem: string, ext: "kwz" | "ppm"): boolean {
  return ext === "kwz" ? DS_KWZ_STEM.test(stem) : DS_PPM_STEM.test(stem) || DS_PPM_LOCAL_STEM.test(stem);
}

/** V216b: .kwz／.ppm のファイル名か（拡張子だけを見る） */
function isNoteName(base: string): boolean {
  return /\.(?:kwz|ppm)$/i.test(base);
}

/** ★V216b (A-133): SD の取り込みの失敗の 1 行（Rust の `"<ファイル名>: <理由>"`）をログに書ける形にする。
 *  名前は `logSafeFileLabel` を通す（3DS の形のときだけ残す）。名前と理由を切り分けられない形は名前ごと出さない（`-`） */
export function bulkImportErrorLogSafe(e: string): string {
  const m = /^(.*\.(?:kwz|ppm)): ([\s\S]*)$/i.exec(e);
  if (!m) return "-";
  return `${logSafeFileLabel(m[1])}: ${m[2]}`;
}

/** ドロップ取り込みで使う「保存名の素」。**先に `.gz` を外してから**拡張子を落とす。
 *
 *  `foo.memoanima.gz` → `foo`（`foo.memoanima` にすると、保存側が `.memoanima` を足して
 *  **`foo.memoanima.gz.memoanima`** になる＝R-7 が見ているのはここ）。 */
export function importBaseName(fname: string): string {
  return stripGzSuffix(fname).replace(/\.[^.]+$/, "");
}
