// V171: src/icons/*.svg（86 個・Cowork の成果物・触らない）を **ビルド前に** TS の文字列へ束ねる。
//   npx tsx scripts/gen_icons.ts   → src/icons/_bundle.ts（生成物・手で直さない）
//
// なぜ Vite の `?raw` import ではなく生成物か:
//   Node の smoke（m1201 / v16x…）が `src/i18n` を import し、i18n から `tHtml` 経由でアイコンに届く。
//   `?raw` は Vite だけが解決できるので、Node からの import が壊れる。生成した TS なら Node でも Vite でも同じ実体。
//   実行時に fetch しない（オフライン完結・不変条件 4）のはどちらでも同じ。
//
// 生成物の形: `ICON_IDS`（as const・icons.json の id 順）／`ICON_INNER: Record<IconId, string>`（<svg> の**中身**だけ）。
// ルートの属性（viewBox / fill / stroke / stroke-width / linecap / linejoin）は icons.json と同じ値を `icon()` が付ける＝
// SVG 側の属性が揺れても画面は統一される。中身（path）は1文字も変えない。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "src", "icons");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "icons.json"), "utf8")) as {
  grid: number;
  strokeWidth: number;
  icons: { id: string; name: string; emoji: string; group: string }[];
};
const ids = manifest.icons.map((i) => i.id);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, "")).sort();
const missing = ids.filter((id) => !files.includes(id));
const extra = files.filter((f) => !ids.includes(f));
if (missing.length || extra.length) {
  console.error(`icons.json と svg が一致しない: 無い=${missing.join(",")} 余分=${extra.join(",")}`);
  process.exit(1);
}
const inner: Record<string, string> = {};
for (const id of ids) {
  const svg = fs.readFileSync(path.join(dir, `${id}.svg`), "utf8");
  const m = /<svg\b[^>]*>([\s\S]*?)<\/svg>\s*$/.exec(svg);
  if (!m) { console.error(`${id}.svg: <svg> が見つからない`); process.exit(1); }
  if (!/viewBox="0 0 20 20"/.test(svg)) { console.error(`${id}.svg: viewBox が 0 0 20 20 ではない`); process.exit(1); }
  if (/#[0-9a-fA-F]{3,8}\b/.test(m[1])) { console.error(`${id}.svg: path に色の直書きがある`); process.exit(1); }
  // 改行・インデントを畳む（中身の path は不変）
  inner[id] = m[1].replace(/\s*\n\s*/g, "").trim();
}
const out = [
  "// ★生成物（scripts/gen_icons.ts）。手で直さない。src/icons/*.svg を直したら `npx tsx scripts/gen_icons.ts` で作り直す。",
  `// 元: src/icons/icons.json（${ids.length} 個・grid ${manifest.grid}・stroke ${manifest.strokeWidth}）`,
  `export const ICON_GRID = ${manifest.grid};`,
  `export const ICON_STROKE = ${manifest.strokeWidth};`,
  `export const ICON_IDS = ${JSON.stringify(ids)} as const;`,
  "export type IconId = (typeof ICON_IDS)[number];",
  "/** <svg> の中身（path 等）だけ。ルート属性は icon() が付ける */",
  "export const ICON_INNER: Record<IconId, string> = {",
  ...ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(inner[id])},`),
  "};",
  "",
].join("\n");
const outPath = path.join(dir, "_bundle.ts");
const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
if (prev !== out) {
  fs.writeFileSync(outPath, out);
  console.log(`wrote ${path.relative(root, outPath)} (${ids.length} icons, ${out.length} bytes)`);
} else {
  console.log(`up to date: ${path.relative(root, outPath)} (${ids.length} icons)`);
}
