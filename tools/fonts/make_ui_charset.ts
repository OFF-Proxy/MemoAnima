// V220 (M-2b-1b・要件 docs/REQ_mobile_ui_v1.md §3-4・docs/REQ_mobile_m2_editor.md §5-1 の 3): **画面用の書体**（ui-maru・ui-maru-bold・
// ui-dot16）の字の集合 `tools/fonts/ui_charset.txt` を、辞書から作る。
//
//   npx tsx tools/fonts/make_ui_charset.ts
//
// ★文字のツールの字の集合（`subset_charset.txt`）と、それを作る `make_charset.py` は変えない・走らせない（12 本を作り直さないため）。
// ★範囲: `src/i18n/` の ja・en・es・pt-BR の**値**に出る字の全部（モバイルは PC の文言を多く使い回すので PC のキーも含める）＋
//  ASCII の印字できる字（U+0020〜U+007E）＋UI §3-4 で挙げた字。3 本とも同じ集合（数字の札にも「コマ」などの字が出るため）。
//  ko・zh-Hans・zh-Hant の字は入れない（OS の書体に任せる＝UI §3-4）。
// ★制御文字（改行・タブ）は落とす。原本に無い字（絵文字・一部の記号）は集合には入れたまま、`subset.py` が作るときに
//  `tools/fonts/ui_missing.txt` に書き出す（その字はモバイルの画面に出さない＝U-12）。
// ★通信しない（辞書を読むだけ）。並びは符号位置の順・1 行に全部（`subset_charset.txt` と同じ形）。
import fs from "node:fs";
import path from "node:path";
import ja from "../../src/i18n/ja";
import en from "../../src/i18n/en";
import es from "../../src/i18n/es";
import ptBR from "../../src/i18n/pt-BR";
// ★V221 (M-2b-2・指示書 ■2(2)(9)): モバイルだけの辞書（src/mobileApp/i18n/）の ja・en・es・pt-BR の値の字も入れる
import mbJa from "../../src/mobileApp/i18n/ja";
import mbEn from "../../src/mobileApp/i18n/en";
import mbEs from "../../src/mobileApp/i18n/es";
import mbPtBR from "../../src/mobileApp/i18n/pt-BR";

const HERE = import.meta.dirname;

/** UI §3-4 で挙げた字（PC の文字のツールのサブセットに無かった 18 字。異体字セレクタ U+FE0F を含む） */
export const UI_EXTRA = "歪矩梱繋°×—…※ℹ←→−─⟳⤡〰️";

/** 字の集合（符号位置の順・重なりなし・制御文字なし） */
export function uiCharset(dicts: Record<string, string>[]): string[] {
  const set = new Set<number>();
  for (let c = 0x20; c <= 0x7e; c++) set.add(c);
  for (const d of dicts) for (const v of Object.values(d)) for (const ch of v) set.add(ch.codePointAt(0)!);
  for (const ch of UI_EXTRA) set.add(ch.codePointAt(0)!);
  return [...set]
    .filter((c) => !(c < 0x20 || (c >= 0x7f && c < 0xa0)))
    .sort((a, b) => a - b)
    .map((c) => String.fromCodePoint(c));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const chars = uiCharset([ja, en, es, ptBR, mbJa, mbEn, mbEs, mbPtBR] as Record<string, string>[]);
  const out = path.join(HERE, "ui_charset.txt");
  fs.writeFileSync(out, chars.join("") + "\n", "utf8");
  console.log(`ui_charset.txt: ${chars.length} 字`);
}
