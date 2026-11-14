// V220 (M-2b-1b・要件 docs/REQ_mobile_ui_v1.md §3-5・docs/handoff/V220_icons/README.md): **モバイルの画面のアイコン**を束ねる。
//   npx tsx scripts/gen_mobile_icons.ts   → src/mobile/icons/_bundle.ts（生成物・手で直さない）
//
// ★PC の scripts/gen_icons.ts と同じ形の別の台本・別の出力。PC の src/icons/（SVG・icons.json・_bundle.ts）は変えない・束に入れない
//  （入れると PC の JS に入る）。束はモバイルの部品だけが読む。
// ★一覧は src/mobile/icons/icons.json: `new`（このフォルダの SVG＝docs/handoff/V220_icons/ の素材を 1 字も変えずに置いたもの）と
//  `pc`（PC の src/icons/ の SVG を**読んで写す**だけ）。PC の icons.json の絵文字の欄は持ち込まない。
// ★中身の取り出し方は PC と同じ（<svg> の中身・改行とインデントを畳む）＝PC の形は PC の _bundle.ts の ICON_INNER と字まで同じ。
// ★色の直書き（#xxx）は断る。「透かす」（onion）だけ線の色が変数（var(--red)・var(--blue)）＝素材のとおり。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const mdir = path.join(root, "src", "mobile", "icons");
const pdir = path.join(root, "src", "icons");
const list = JSON.parse(fs.readFileSync(path.join(mdir, "icons.json"), "utf8")) as { new: string[]; pc: string[] };

export function innerOf(svg: string, id: string): string {
  const m = /<svg\b[^>]*>([\s\S]*?)<\/svg>\s*$/.exec(svg);
  if (!m) throw new Error(`${id}.svg: <svg> が見つからない`);
  if (!/viewBox="0 0 20 20"/.test(svg)) throw new Error(`${id}.svg: viewBox が 0 0 20 20 ではない`);
  if (/#[0-9a-fA-F]{3,8}\b/.test(m[1])) throw new Error(`${id}.svg: 中身に色の直書きがある`);
  return m[1].replace(/\s*\n\s*/g, "").trim();
}

const dup = [...list.new, ...list.pc].filter((x, i, a) => a.indexOf(x) !== i);
if (dup.length) {
  console.error(`同じ id が 2 回: ${dup.join(",")}`);
  process.exit(1);
}
const files = fs.readdirSync(mdir).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, "")).sort();
const missing = list.new.filter((id) => !files.includes(id));
const extra = files.filter((f) => !list.new.includes(f));
if (missing.length || extra.length) {
  console.error(`icons.json の new と svg が一致しない: 無い=${missing.join(",")} 余分=${extra.join(",")}`);
  process.exit(1);
}
const inner: Record<string, string> = {};
for (const id of list.new) inner[id] = innerOf(fs.readFileSync(path.join(mdir, `${id}.svg`), "utf8"), id);
for (const id of list.pc) {
  const p = path.join(pdir, `${id}.svg`);
  if (!fs.existsSync(p)) {
    console.error(`PC の形 ${id}.svg が src/icons/ に無い`);
    process.exit(1);
  }
  inner[id] = innerOf(fs.readFileSync(p, "utf8"), id);
}
const ids = [...list.new, ...list.pc];
const out = [
  "// ★生成物（scripts/gen_mobile_icons.ts）。手で直さない。src/mobile/icons/ の SVG か icons.json を直したら作り直す。",
  `// 元: src/mobile/icons/icons.json（新しい形 ${list.new.length}・PC の形 ${list.pc.length}＝PC の src/icons/ から写した）。PC の束（src/icons/_bundle.ts）とは別`,
  `export const MOBILE_NEW_ICON_IDS = ${JSON.stringify(list.new)} as const;`,
  `export const MOBILE_PC_ICON_IDS = ${JSON.stringify(list.pc)} as const;`,
  "export const MOBILE_ICON_IDS = [...MOBILE_NEW_ICON_IDS, ...MOBILE_PC_ICON_IDS] as const;",
  "export type MobileIconId = (typeof MOBILE_ICON_IDS)[number];",
  "/** <svg> の中身（path 等）だけ。ルート属性は mobileIconSvg() が付ける */",
  "export const MOBILE_ICON_INNER: Record<MobileIconId, string> = {",
  ...ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(inner[id])},`),
  "};",
  "",
].join("\n");
const outPath = path.join(mdir, "_bundle.ts");
const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
if (prev !== out) {
  fs.writeFileSync(outPath, out);
  console.log(`wrote ${path.relative(root, outPath)} (${ids.length} icons)`);
} else {
  console.log(`up to date: ${path.relative(root, outPath)} (${ids.length} icons)`);
}
