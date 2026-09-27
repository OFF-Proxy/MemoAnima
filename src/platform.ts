// V181 (A-25): **Mac と Windows の違いを吸収する唯一の場所**（判定・修飾キーの読み・キーの表記）。
//
// ★作者の決定（2026-09-24・`docs/REQ_mac_cmd_shortcuts.md` v2）
//   G-1 **Mac でだけ ⌘（command）を Ctrl として扱う**（折り畳み）。⌘Z も control+Z も「元に戻す」。
//       保存済みの自分のプリセットもそのまま ⌘ で効く。Mac で ⌘ と control に別々の命令は割り当てられない（それでよい）。
//       **Windows は 1 か所も変えない**（Win キーは今までどおり Ctrl とは別物＝M11-5）
//   G-3 Mac の表記は記号: Ctrl → ⌘・Alt → ⌥・Shift → ⇧（並びは Mac のメニューと同じ ⌃⌥⇧⌘）。
//       **7 言語の辞書は 1 文字も変えず、表示の直前で置き換える**（`i18n/index.ts` の `t()` がここを通す）
//
// ★このファイルは何も import しない（`i18n/index.ts` と `keymap.ts` の両方から使う＝循環させない）。
//   判定は同期で読める `navigator` だけ（割り当て表は同期で作るので、非同期の OS 判定は使えない。
//   `tauri-plugin-os` は入れない方針＝`i18n/index.ts` の `detectLang` と同じ）。
//   検査（Node）は `setMacPlatformForTest` で「Mac のふり／Windows のふり」を注入する（`scripts/v181_smoke.ts`）。

/** 判定に使う navigator の形（検査が作者の実測値をそのまま渡せるよう、型は最小にしてある） */
export interface NavigatorLike {
  platform?: unknown;
  userAgent?: unknown;
}

/** navigator から Mac かどうかを決める（純関数）。
 *
 *  作者の実測（M-1・2026-09-25・MacBook Air の開発ビルド＝WKWebView）:
 *  `navigator.platform` = `MacIntel`・UA に `Macintosh`。Apple シリコンでも WebKit は `MacIntel` を返す（既定）ので
 *  同じ式で拾える。Windows の WebView2 は `Win32`。`platform` を正にして、UA の `Macintosh` を予備にする。
 *
 *  ★Node の navigator（検査）は**動かしている機械の OS を名乗る**（macOS 上の Node は platform=`MacIntel`）。
 *   既存の検査は Windows 版を写す前提で書かれているので、UA が `Node.js/…` のときは判定しない
 *   （＝検査の結果が機械で変わらない。Mac の検査は `setMacPlatformForTest(true)` で注入する）。
 *   アプリが動く WebView の UA が `Node.js/` で始まることは無い。 */
export function detectMacFrom(nav: NavigatorLike | null | undefined): boolean {
  if (!nav) return false;
  const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
  if (ua.startsWith("Node.js/")) return false;
  const platform = typeof nav.platform === "string" ? nav.platform : "";
  return platform.startsWith("Mac") || ua.includes("Macintosh");
}

let forced: boolean | null = null;
let detected: boolean | null = null;

/** V181 [A]: Mac で動いているか。**判定はここだけ**（`v181_smoke` [S-A] が「navigator の platform / userAgent を
 *  読むのはこのファイルだけ」を構文木で見張る）。一度読んだら覚える（navigator は途中で変わらない）。 */
export function isMacPlatform(): boolean {
  if (forced !== null) return forced;
  if (detected === null) detected = detectMacFrom(typeof navigator === "undefined" ? undefined : navigator);
  return detected;
}

/** 検査用: 「Mac のふり」（true）／「Windows のふり」（false）／本来の判定に戻す（null）。
 *  ⚠ 引き当て表（`buildLookup`）は作った時点の判定で固まるので、切り替えたら作り直すこと */
export function setMacPlatformForTest(v: boolean | null): void {
  forced = v;
}

// ================= 修飾キーの読み（G-1 の折り畳み） =================

/** V181 [B]: 「Ctrl か（Mac なら ⌘ も）」。**`ctrlKey` はここでだけ読む**
 *  （例外は理由のある 5 か所だけ＝`v181_smoke` [S-5] が構文木で数えて突き合わせる）。
 *  Windows ではいままでの `e.ctrlKey` と同じ値（Win キーは Ctrl に畳まない＝M11-5）。
 *  ctrl と ⌘ の両方が立っていても true が 1 つ（`eventKey` の "C" も 1 つ）。 */
export function primaryMod(e: { ctrlKey: boolean; metaKey?: boolean }): boolean {
  return Boolean(e.ctrlKey) || (isMacPlatform() && Boolean(e.metaKey));
}

/** V181 [B]: Ctrl に**畳んでいない** meta。Windows の Win キーだけがこれ（Mac の ⌘ は Ctrl に畳んだので常に false）。
 *  照合（`eventKey` の "M"＝わざと一致させない）と登録（Win＋クリックは登録できない）が使う。 */
export function unfoldedMeta(e: { metaKey?: boolean }): boolean {
  return !isMacPlatform() && Boolean(e.metaKey);
}

// ================= キーの表記（G-3） =================

const MOD_SYMBOL: Record<string, string> = { Alt: "⌥", Shift: "⇧", Ctrl: "⌘" };
/** Mac のメニューの並び ⌃⌥⇧⌘（Ctrl は ⌘ に畳むので ⌃ は出ない） */
const MOD_ORDER = ["Alt", "Shift", "Ctrl"];
/** 修飾キーの並び（`Ctrl+Shift`）と、続けば「区切り＋キーの刻印」。
 *  刻印は、キーの名前（Enter・Esc・Delete…・F1〜F12）か、**英数記号 1 文字**（`Z`・`,`）か、`¥ ＿ ← → ↑ ↓`
 *  （`keymap.ts` の `codeLabel` が出す刻印）で、直後に英数字が続かないもの。刻印なら区切りを落として
 *  記号に直接つなぐ（Mac のメニューと同じ `⇧⌘S`）。「クリック」「click」のような**語**が続くときは区切りを残す
 *  （`⌥＋クリック`・`⇧+click`＝元の文の区切りのまま）。 */
const CHAIN_RE =
  /\b((?:Ctrl|Alt|Shift)(?:[+＋](?:Ctrl|Alt|Shift))*)\b(?:[+＋]((?:Backspace|PageDown|PageUp|Escape|Delete|Insert|Enter|Space|Home|End|Tab|Esc|F1[0-2]|F[1-9])(?![A-Za-z0-9])|[!-~](?![A-Za-z0-9])|[¥＿←→↑↓]))?/g;
const HAS_MOD_WORD = /\b(?:Ctrl|Alt|Shift)\b/;

/** V181 [D]: 文中のキーの表記を Mac の形へ（純関数・**判定を見ない**）。
 *  `元に戻す (Ctrl+Z)` → `元に戻す (⌘Z)`／`Ctrl+Shift+S` → `⇧⌘S`／`Alt＋クリック` → `⌥＋クリック`／
 *  `既定 Ctrl+,` → `既定 ⌘,`／`Ctrl / Shift / Alt は` → `⌘ / ⇧ / ⌥ は`。
 *  ⚠ Ctrl / Alt / Shift 以外のキーの名前（Enter・Delete・Backspace・Esc…）は**この回では触らない**。 */
export function macKeyNotation(text: string): string {
  if (!HAS_MOD_WORD.test(text)) return text;
  return text.replace(CHAIN_RE, (_m: string, chain: string, cap: string | undefined) => {
    const mods = new Set(chain.split(/[+＋]/));
    const sym = MOD_ORDER.filter((m) => mods.has(m))
      .map((m) => MOD_SYMBOL[m])
      .join("");
    return cap === undefined ? sym : sym + cap;
  });
}

/** V181 [D]: **表示の直前の 1 関数**。Mac のときだけキーの表記を記号へ（Windows は素通し＝1 文字も変わらない）。
 *  生成する表記（`keymap.ts` の `keyLabel`・タップの表記・`modLabel`）もこれを通す＝辞書の文言と同じ規則。 */
export function platformKeys(text: string): string {
  return isMacPlatform() ? macKeyNotation(text) : text;
}

/** 辞書のキーのうち、訳文の「Ctrl」「Alt」「Shift」が**キーの名前ではない**もの（Mac でも置き換えない）。
 *  - `ed.tone.ditherShift.label`: en の「Shift per frame」＝コマごとに**ずらす**（トーンの設定）。Shift キーではない
 *  辞書に語を足したら `v181_smoke` [S-3] の件数の表が赤になる→キーの名前でなければここへ足す。 */
export const NON_KEY_WORD_DICT_KEYS: ReadonlySet<string> = new Set(["ed.tone.ditherShift.label"]);

/** V181 [D]: 辞書の訳文を表示へ渡す直前に通す（`t()` が呼ぶ）。**{…} を埋める前の訳文**に当てるので、
 *  差し込む値（利用者が付けた名前など）は置き換えない。 */
export function platformKeysForDict(dictKey: string, text: string): string {
  if (!isMacPlatform() || NON_KEY_WORD_DICT_KEYS.has(dictKey)) return text;
  return macKeyNotation(text);
}
