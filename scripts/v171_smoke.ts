// V171（絵文字を自作の線画アイコンに置き換える）の回帰ゲート。引数不要:
//   npx tsx scripts/v171_smoke.ts
//
// ★この回でいちばん怖いのは3つ:
//   ① **7言語のどれかに絵文字が残る**（ja だけ直すと言語切替で絵文字が戻る）→ 検査1（7言語・許可はキー名で列挙）
//   ② **文中参照 `{icon:xxx}` が言語で違う**（訳文ごとに絵が違う／id の typo）→ 検査4（7言語で同じ集合・全部 icons.json）
//   ③ **HTML の入口を作る**（tHtml が `<` を通す）→ 検査9
//
// 1. 7言語の i18n の値に対象絵文字（icons.json ＋ 付録 A 追加分）が残っていない（許可: キー名で）
// 2. src/**/*.ts（i18n・icons 除く・コメント除外）に `icon: "絵文字"` / `textContent = "絵文字"` の形が無い
// 3. src/icons/*.svg が 86 個で icons.json の id と一致・viewBox 0 0 20 20・path に色なし・stroke-width 1.8
// 4. `{icon:xxx}` の id 集合が 7言語で同じ・全部 icons.json にある
// 5. index.html の data-icon が全部 icons.json にある
// 6. 反証 1z: ja の1キーに絵文字を戻した写しは検査1 が赤
// 7. 反証 3z: SVG を1つ消した写し（一覧）は検査3 が赤
// 8. 反証 4z: en の {icon:gear} を {icon:settings} に変えた写しは検査4 が赤
// 9. tHtml の escape: `<b>x</b>{icon:gear}` → `<b>` は escape され svg だけが要素になる
// 10. 器: _bundle.ts が svg と一致（生成物が古くない）・IconId は id から型で作る・実行時 fetch なし
import fs from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"] as const;
const manifest = JSON.parse(read("src/icons/icons.json")) as { icons: { id: string; emoji: string }[] };
const IDS = manifest.icons.map((i) => i.id);
const ID_SET = new Set(IDS);

// 対象の文字: icons.json の emoji ＋ 付録 A の追加分（複数文字の絵文字「⬛⬜」は分解して1文字ずつ）
const EXTRA = ["★", "✎", "⏭", "🔓", "🔊", "📝", "🚫", "◀", "▲", "▼", "↶", "↷"];
const TARGET = [...new Set([...manifest.icons.flatMap((i) => [...i.emoji]), ...EXTRA])].filter((c) => c.trim());
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TARGET_RE = new RegExp(`(${TARGET.map(esc).join("|")})`, "gu");

// 許可（**キー名で**列挙。文字で丸ごと許可しない）: 「A → B」の文章記号・「─ 編集 ─」の罫線・矢印キーの表示名
const ALLOW_KEYS: Record<string, string[]> = {
  "lib.tp.next.title": ["→"],
  "lib.tp.prev.title": ["←"],
  "img.dialog.pages.hint": ["→"],
  "img.dialog.frames.hint": ["→"],
  "set.legal.contact.msg": ["→"],
  "set.update.found.msg": ["→"],
  "keys.toolCycle.toast": ["→"],
  "keys.toolCycle.arrow.label": ["→"],
  "guide.import.msg": ["→"],
  "ed.color.fullcolor.big.msg": ["→"],
  "lib.import.pick.title": ["→"],
  "keys.cmd.framePrev.hint": ["←"],
  "keys.cmd.frameNext.hint": ["→"],
  "ed.layerclip.pasteTo.btn": ["→"], // 「貼り付け → {layerShort}」の文章記号（先頭の 📋 は剥がす）
};

/** 辞書ファイルから key → value（1行1キーの形だけ・複数行の値は無い） */
function dict(lang: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of read(`src/i18n/${lang}.ts`).split("\n")) {
    const r = /^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/.exec(line);
    if (r) m.set(r[1], r[2]);
  }
  return m;
}
function leftovers(d: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of d) {
    const hits = [...new Set([...v.matchAll(TARGET_RE)].map((x) => x[1]))];
    const bad = hits.filter((h) => !(ALLOW_KEYS[k] ?? []).includes(h));
    if (bad.length) out.push(`${k}[${bad.join("")}]`);
  }
  return out;
}

// ================= 1. 7言語に絵文字が残っていない =================
const DICTS = new Map<string, Map<string, string>>();
for (const l of LANGS) DICTS.set(l, dict(l));
for (const l of LANGS) {
  const d = DICTS.get(l)!;
  check(`1 ${l}: キーが読めている（1000 以上）`, d.size >= 1000, `size=${d.size}`);
  const left = leftovers(d);
  check(`1 ★${l}: 対象の絵文字が値に残っていない（許可はキー名で）`, left.length === 0, `${left.length} 件: ${left.slice(0, 8).join(" ")}`);
}
check("1 許可リストのキーは全部 ja に実在する（消えたキーを許可し続けない）", Object.keys(ALLOW_KEYS).every((k) => DICTS.get("ja")!.has(k)), Object.keys(ALLOW_KEYS).filter((k) => !DICTS.get("ja")!.has(k)).join(","));

// ================= 2. src の直書き =================
function listTs(dir: string, skip: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (!skip.test(ent.name)) walk(p); }
      else if (/\.ts$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(path.relative(root, p).replace(/\\/g, "/"));
    }
  };
  walk(path.join(root, dir));
  return out;
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/[^\n"'`]*$/gm, "");
{
  const bad: string[] = [];
  for (const f of listTs("src", /^(i18n|icons)$/)) {
    const src = strip(read(f));
    src.split("\n").forEach((ln, i) => {
      // `icon: "…"` / `textContent = "…"` / `textContent = x ? "…" : "…"` の形で対象文字を直に書いている
      const forms = [/icon:\s*"([^"]*)"/g, /textContent\s*=\s*[^;\n]*?"([^"]*)"/g];
      for (const re of forms) for (const m of ln.matchAll(re)) if (TARGET_RE.test(m[1])) { bad.push(`${f}:${i + 1}: ${ln.trim().slice(0, 80)}`); TARGET_RE.lastIndex = 0; }
    });
  }
  check("2 ★src/**/*.ts に `icon: \"絵文字\"` / `textContent = \"絵文字\"` の形が残っていない", bad.length === 0, `${bad.length} 件: ${bad.slice(0, 5).join(" | ")}`);
  // innerHTML のテンプレートに直書きされた対象文字（`"▲"` のような文字列リテラル全体を見る）
  const bad2: string[] = [];
  for (const f of listTs("src", /^(i18n|icons)$/)) {
    const src = strip(read(f));
    src.split("\n").forEach((ln, i) => {
      // 付録 B: keymap.ts の方向キーの**表示名**（ArrowRight: "→" 等）は文字が正しい＝対象外
      if (f === "src/keymap.ts" && /Arrow(Left|Right|Up|Down):\s*"/.test(ln)) return;
      for (const m of ln.matchAll(/"([^"\\]*)"/g)) if (m[1].length <= 3 && TARGET_RE.test(m[1])) { bad2.push(`${f}:${i + 1}: ${ln.trim().slice(0, 80)}`); TARGET_RE.lastIndex = 0; }
    });
  }
  check("2 対象文字だけの短い文字列リテラル（\"▲\" 等）が残っていない", bad2.length === 0, `${bad2.length} 件: ${bad2.slice(0, 5).join(" | ")}`);
}

// ================= 3. SVG の素材 =================
const svgCheck = (files: string[]): { ok: boolean; why: string } => {
  const ids = files.map((f) => f.replace(/\.svg$/, "")).sort();
  if (ids.length !== 86) return { ok: false, why: `svg=${ids.length}` };
  if (JSON.stringify(ids) !== JSON.stringify([...IDS].sort())) return { ok: false, why: "id 集合が違う" };
  for (const f of files) {
    const s = read(`src/icons/${f}`);
    if (!/viewBox="0 0 20 20"/.test(s)) return { ok: false, why: `${f}: viewBox` };
    const inner = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(s)?.[1] ?? "";
    if (/#[0-9a-fA-F]{3,8}\b/.test(inner)) return { ok: false, why: `${f}: path に色` };
    if (!/<svg\b[^>]*stroke-width="1.8"/.test(s)) return { ok: false, why: `${f}: stroke-width` };
    if (!/<svg\b[^>]*stroke="currentColor"/.test(s)) return { ok: false, why: `${f}: currentColor` };
  }
  return { ok: true, why: "" };
};
const SVG_FILES = fs.readdirSync(path.join(root, "src/icons")).filter((f) => f.endsWith(".svg"));
{
  const r = svgCheck(SVG_FILES);
  check("3 ★svg が 86 個・icons.json の id と一致・viewBox 0 0 20 20・path に色なし・stroke-width 1.8", r.ok, r.why);
  check("3 icons.json の id は重複なし・英小文字とハイフンだけ", new Set(IDS).size === IDS.length && IDS.every((i) => /^[a-z0-9-]+$/.test(i)));
}

// ================= 4. {icon:xxx} は 7言語で同じ集合・全部 icons.json =================
const placeholders = (d: Map<string, string>): Map<string, Set<string>> => {
  const m = new Map<string, Set<string>>();
  for (const [k, v] of d) { const s = new Set([...v.matchAll(/\{icon:([a-z0-9-]+)\}/g)].map((x) => x[1])); if (s.size) m.set(k, s); }
  return m;
};
const phEqual = (dicts: Map<string, Map<string, string>>): { ok: boolean; why: string } => {
  const ref = placeholders(dicts.get("ja")!);
  for (const l of LANGS) {
    const p = placeholders(dicts.get(l)!);
    if (p.size !== ref.size) return { ok: false, why: `${l}: キー数 ${p.size} ≠ ja ${ref.size}` };
    for (const [k, s] of ref) { const q = p.get(k); if (!q || JSON.stringify([...q].sort()) !== JSON.stringify([...s].sort())) return { ok: false, why: `${l}: ${k} = ${q ? [...q].join(",") : "無し"} ≠ ja ${[...s].join(",")}` }; }
    for (const s of p.values()) for (const id of s) if (!ID_SET.has(id)) return { ok: false, why: `${l}: 未知の id ${id}` };
  }
  return { ok: true, why: "" };
};
{
  const r = phEqual(DICTS);
  check("4 ★{icon:xxx} の id 集合が 7言語で同じ・全部 icons.json にある", r.ok, r.why);
  const n = placeholders(DICTS.get("ja")!).size;
  check("4 文中参照を持つキーがある（0 なら置換が進んでいない）", n >= 10, `ja: ${n} キー`);
}

// ================= 5. index.html の data-icon =================
{
  const html = read("index.html").replace(/<!--[\s\S]*?-->/g, "");
  const vals = [...html.matchAll(/data-icon="([^"]*)"/g)].map((m) => m[1]);
  const bad = vals.filter((v) => !ID_SET.has(v));
  check("5 ★index.html の data-icon が全部 icons.json にある", vals.length >= 10 && bad.length === 0, `n=${vals.length} 未知=${bad.join(",")}`);
  const left = [...html.matchAll(TARGET_RE)].map((m) => m[1]);
  check("5 index.html に対象の絵文字が残っていない（コメント除く）", left.length === 0, left.join(""));
  // Codex 指摘（低）: CSS の `content: "♪"` の再混入は見張っていなかった。擬似要素の content に対象文字が無いことも固定
  const css = read("src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const cssBad = [...css.matchAll(/content:\s*"([^"]*)"/g)].map((m) => m[1]).filter((v) => TARGET_RE.test(v) && (TARGET_RE.lastIndex = 0) === 0);
  check("5 styles.css の content: に対象の絵文字が無い（♪ は mask に置き換えた）", cssBad.length === 0, cssBad.join(","));
}

// ================= 6-8. 反証 =================
{
  const ja = new Map(DICTS.get("ja")!);
  ja.set("ed.save.btn", "💾 " + (ja.get("ed.save.btn") ?? ""));
  check("6 ★1z 反証: ja の1キーに絵文字を戻した写しは検査1 が赤", leftovers(DICTS.get("ja")!).length === 0 && leftovers(ja).length === 1);
  check("7 ★3z 反証: SVG を1つ消した一覧は検査3 が赤", svgCheck(SVG_FILES).ok && !svgCheck(SVG_FILES.slice(1)).ok);
  const en = new Map(DICTS.get("en")!);
  let changed = false;
  for (const [k, v] of en) if (v.includes("{icon:gear}")) { en.set(k, v.replace("{icon:gear}", "{icon:settings}")); changed = true; break; }
  const forged = new Map(DICTS); forged.set("en", en);
  check("8 ★4z 反証: en の {icon:gear} を {icon:settings} に変えた写しは検査4 が赤", phEqual(DICTS).ok && changed && !phEqual(forged).ok);
}

// ================= 9. tHtml の escape（XSS の網） =================
{
  const { iconizeText, tHtml, isIconId } = await import("../src/icons/index");
  const out = iconizeText("<b>x</b>{icon:gear} & \"q\"");
  check("9 ★`<b>` は escape され、{icon:gear} だけが <svg> になる", /^&lt;b&gt;x&lt;\/b&gt;<svg [^>]*class="icon icon-gear/.test(out) && /<\/svg> &amp; &quot;q&quot;$/.test(out), out.slice(0, 80));
  check("9 未知の id は文字のまま（escape される）", iconizeText("{icon:nope}") === "{icon:nope}" && !isIconId("nope"));
  check("9 svg に path の色が無く currentColor（stroke）を継承する", /stroke="currentColor"/.test(out) && !/#[0-9a-fA-F]{3,8}/.test(out));
  check("9 tHtml は t() と同じ引数で HTML を返す（差し込み {name} も効く）", typeof tHtml === "function" && /<svg/.test(tHtml("set.update.check.hint")));
}

// ================= 10. 器 =================
{
  const bundle = read("src/icons/_bundle.ts");
  const ids = JSON.parse(/export const ICON_IDS = (\[[\s\S]*?\]) as const;/.exec(bundle)?.[1] ?? "[]") as string[];
  check("10 _bundle.ts の id が icons.json と一致（生成物が古くない）", JSON.stringify(ids) === JSON.stringify(IDS));
  let stale = 0;
  for (const id of ids) {
    const svg = read(`src/icons/${id}.svg`);
    const inner = (/<svg\b[^>]*>([\s\S]*?)<\/svg>/.exec(svg)?.[1] ?? "").replace(/\s*\n\s*/g, "").trim();
    const b = /"(?:[^"\\]|\\.)*"/.exec(bundle.slice(bundle.indexOf(`  ${JSON.stringify(id)}: `) + `  ${JSON.stringify(id)}: `.length))?.[0] ?? "";
    if (JSON.parse(b) !== inner) stale++;
  }
  check("10 ★_bundle.ts の中身が svg と1文字も違わない（path は不変）", stale === 0, `${stale} 個が古い`);
  check("10 IconId は id から型で作る（as const）", /export type IconId = \(typeof ICON_IDS\)\[number\];/.test(bundle));
  const idx = read("src/icons/index.ts");
  check("10 実行時に fetch しない（オフライン完結）", !/fetch\(|XMLHttpRequest|import\.meta\.url/.test(idx));
  // 自分のコメントに当たらないよう、コメントを落としてから見る（V165/V167 の反省）
  check("10 <img> にしない（インライン svg・currentColor）", !/createElement\("img"\)|<img\b/.test(strip(idx)) && /createElementNS\(SVG_NS, "svg"\)/.test(idx));
}

console.log(`v171 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
