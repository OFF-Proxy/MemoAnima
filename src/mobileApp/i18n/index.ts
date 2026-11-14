// V221 (M-2b-2・指示書 ■2(2)・■3 の D-1): モバイルだけの辞書を引く口。
//
// ★言語は PC の口（`src/i18n/index.ts` の `getLang()`）を読むだけ（`src/i18n/` は変えない）。引き方も PC と同じ順
//  （いまの言語 → en → ja → `[key]`）。差し込み語は `{name}` を名前で埋める（PC の `t()` と同じ決まり）。
// ★PC の文は PC の `t()` で引く（このファイルは PC のキーを持たない）。
// ★キーは字のまま書く（`mt("mb.…")`。組み立てた文字列で引かない＝i18n の検査4 がキーを見られるように）。
import { getLang, type Lang } from "../../i18n";
import ja, { type MbDict, type MbKey } from "./ja";
import en from "./en";
import es from "./es";
import ptBR from "./pt-BR";
import ko from "./ko";
import zhHans from "./zh-Hans";
import zhHant from "./zh-Hant";

export type { MbKey };

const DICTS: Record<Lang, MbDict> = { ja, en, es, "pt-BR": ptBR, ko, "zh-Hans": zhHans, "zh-Hant": zhHant };

function lookup(key: MbKey): string | undefined {
  for (const l of [getLang(), "en", "ja"] as Lang[]) {
    const v = DICTS[l]?.[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** モバイルの辞書を引く（見つからなければ `[key]`。HTML は返さない＝textContent などに入れる） */
export function mt(key: MbKey, vars?: Record<string, unknown>): string {
  const raw = lookup(key);
  if (raw === undefined) return `[${key}]`;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

/** 検査用: 全部の言語の辞書（m1201 と v221 [I] が読む） */
export const MB_DICTS: Readonly<Record<Lang, MbDict>> = DICTS;
