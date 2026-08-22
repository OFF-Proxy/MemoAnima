// M12-1a: i18n の中核（自前・依存なし）。
// 設計は docs/REQ_M12_i18n_master.md §3 で確定済み。**ここで独自の設計に置き換えない**。
//
//  - 辞書は TS モジュール（`ja.ts` が型の正）。JSON にしない＝同期ずれをコンパイル時に落とすため
//  - キーは「画面.部品.用途」の3段（用途は .btn / .label / .hint / .title / .msg / .toast / .placeholder）
//  - 変数は `{name}` の**名前**で埋める（位置引数は使わない＝語順が言語で変わるため）
//  - 複数形は `Intl.PluralRules`。`{ count }` があり `キー_other` が在るときだけ
//  - フォールバックは **現在言語 → en → ja → `[key]`**（未訳で日本語が出るより英語が出るほうがよい）
//  - 実行時のネットワークなし・i18n ライブラリなし（オフライン完結）
import ja from "./ja";
import en from "./en";
import es from "./es";
import ptBR from "./pt-BR";
import ko from "./ko";
import zhHans from "./zh-Hans";

/** 対応言語（master §0 の5言語 ＋ L-2 で `zh-Hans`）。
 *  **言語を1つ足す作業は、ここと `DICTS` と `detectLang()` の3箇所**（`sanitizeLang` は `LANGS` を見る）。 */
export const LANGS = ["ja", "en", "es", "pt-BR", "ko", "zh-Hans"] as const;
export type Lang = (typeof LANGS)[number];

/** 辞書の型。`ja` のキー集合が正 */
export type Dict = Record<keyof typeof ja, string>;
export type DictKey = keyof Dict;

/** M12-3: 5言語すべてが全キー埋まった（各 `Record<DictKey, string>`＝訳し漏れはコンパイルエラー）。
 *  `LANGS` / `detectLang()` / `sanitizeLang()` は最初から5言語なので、ここへ足すだけで届く。
 *
 *  L-2: `zh-Hans` は**部分辞書**（`Partial<Dict>`）。翻訳が届いた行から順に載る。
 *  未訳キーは `lookup()` が **en → ja** の順に落とすので、1キームも無くても画面は英語で成立する。
 *  この型（`Partial<Record<Lang, Partial<Dict>>>`）は M12-1a から部分辞書を想定している＝**変えない**。 */
const DICTS: Partial<Record<Lang, Partial<Dict>>> = { ja, en, es, "pt-BR": ptBR, ko, "zh-Hans": zhHans };

let current: Lang = "ja";

/** settings.lang の正規化（`sanitizeExportScale` 等と同じ流儀）。不正値・`LANGS` に無い値は undefined。
 *  ＝**設定は追加のみ**。既存の利用者の `settings.lang` は `LANGS` に載ったままなので影響を受けない */
export function sanitizeLang(v: unknown): Lang | undefined {
  return (LANGS as readonly string[]).includes(v as string) ? (v as Lang) : undefined;
}

/**
 * M12-1a: 表示言語の判定（master §3-g）。
 *   settings.lang（正規化して `LANGS` のいずれか） → navigator.language → **既定 en**
 * 追加の依存（tauri-plugin-os）は入れない。WebView2 の navigator.language は OS の表示言語を反映する。
 */
export function detectLang(saved?: unknown): Lang {
  const fromSettings = sanitizeLang(saved);
  if (fromSettings) return fromSettings;
  const nav = (typeof navigator !== "undefined" && navigator.language ? navigator.language : "").toLowerCase();
  if (nav.startsWith("ja")) return "ja";
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("es")) return "es";
  if (nav.startsWith("pt")) return "pt-BR"; // ポルトガル語はブラジル向けを正とする
  // L-2: 中国語は**簡体字だけ**。繁体字圏（zh-Hant / zh-TW / zh-HK / zh-MO）は簡体字へ落とさず
  // 英語のままにする（繁体字は別に足す予定。簡体字を当てるほうが読み手に不親切なため）
  if (nav.startsWith("zh") && !/^zh-(hant|tw|hk|mo)/.test(nav)) return "zh-Hans";
  return "en"; // 判定できないユーザーの多数は海外側なので既定は英語
}

export function setLang(l: Lang) {
  current = l;
}

export function getLang(): Lang {
  return current;
}

/**
 * 生の辞書引き（フォールバック込み）。見つからなければ undefined。
 *
 * M12-1b: **空文字は「有効な訳」として扱う**（`""` でも即 return する）。
 * 理由: 「この言語では何も出さない」を表現する手段が空文字しかない。ここで空を「無い」と見なすと
 * ja へ落ちて**英語の画面に日本語が出る**——未訳より悪い。うっかりの空欄は、辞書側（ja）を
 * `m1201_i18n_check` の「値が空のキーは無い」検査で落とす（source を守るほうが安全）。
 * 部分辞書（`Partial<Dict>`）では未訳キーはそもそも `undefined` なので、この変更で
 * M12-1a の挙動は変わらない（`""` を書いた人が居ないため）。
 */
function lookup(key: string): string | undefined {
  const order: Lang[] = [current, "en", "ja"];
  for (const l of order) {
    const v = (DICTS[l] as Record<string, string> | undefined)?.[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** `{name}` を埋める。値は String() してそのまま差す（HTML は差さない）。
 *  値の型を `unknown` にしているのは、catch した例外（`unknown`）をそのまま渡せるようにするため */
function fill(tpl: string, vars?: Record<string, unknown>): string {
  if (!vars) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  );
}

/**
 * M12-1a: 翻訳。**HTML は返さない**（呼び出し側が textContent / title / placeholder に入れる）。
 * 未知キーでも例外を投げず `[key]` を返す（起動不能にしない）。
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  // 複数形: { count } があり `キー_other` が在るときだけ解決する（master §3-d・乱用しない）
  if (vars && typeof vars.count === "number" && lookup(`${key}_other`) !== undefined) {
    // M12-1b: 以前は `current === "pt-BR" ? "pt-BR" : current` と書いていたが両辺とも同じ＝無意味だった。
    // Lang の値（"ja" / "en" / "es" / "pt-BR" / "ko" / "zh-Hans"）はそのまま BCP-47 として通る
    //（"zh-Hans" は言語＋文字体系の正しい形。地域の "zh-CN" ではない）
    const cat = new Intl.PluralRules(current).select(vars.count);
    const v = lookup(`${key}_${cat}`) ?? lookup(`${key}_other`);
    if (v !== undefined) return fill(v, vars);
  }
  const raw = lookup(key);
  if (raw === undefined) return `[${key}]`;
  return fill(raw, vars);
}

/**
 * M12-1a: 静的 DOM（index.html）へ一括で流し込む（master §3-h）。
 *   data-i18n="key"             → textContent
 *   data-i18n-title="key"       → title
 *   data-i18n-placeholder="key" → placeholder
 * **textContent を使うので、子要素を持つ要素には data-i18n を振らないこと**（子が消える）。
 * 子を持つ要素は、テキストだけの子 `<span>` に切り出してからそこに振る。
 */
export function applyI18n(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const k = el.dataset.i18n;
    if (k) el.textContent = t(k);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const k = el.getAttribute("data-i18n-title");
    if (k) el.title = t(k);
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    const k = el.getAttribute("data-i18n-placeholder");
    if (k) el.placeholder = t(k);
  });
  // <title> と <html lang> も言語に追従させる（起動時・切替時の両方でここを通る）
  if (root === document) {
    document.title = t("app.title");
    document.documentElement.lang = current;
  }
}
