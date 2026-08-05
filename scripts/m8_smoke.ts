// M8-1 スモーク: 画像変換エンジンの共有化回帰ゲート
// 1) 決定的な合成画像を生成し、共有モジュール（convertToProject）を直接呼んだ結果と、
//    photo2memo CLI（子プロセス）が書いた .memoanima のロード結果が **完全一致** すること
//    （= GUI とCLIが同一設定→同一出力である根拠。両者は同じモジュールを使う）
// 2) 変換の不変条件: v5往復一致・indexBits自動・透明余白(contain)・tone2色・fps丸め
// 実行: npx tsx scripts/m8_smoke.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { PNG } from "pngjs";
import { W, H, PIXELS, FPS_TABLE } from "../src/editor/model";
import { projectFromBytes, projectToBytes } from "../src/editor/serialize";
import {
  DEFAULT_CONVERT,
  convertToProject,
  type ConvertOptions,
  type SourceImage,
} from "../src/editor/imageConvert";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG: ${name} ${detail}`);
  }
}

// 決定的な合成テスト画像（グラデ＋図形。乱数不使用）
function synthImage(w: number, h: number, variant: number): SourceImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 255) / w;
      data[i + 1] = (y * 255) / h;
      data[i + 2] = ((x + y + variant * 40) * 255) / (w + h);
      data[i + 3] = 255;
      // 図形: 円と縞（輪郭・トーンの検証に使う）
      const dx = x - w / 2,
        dy = y - h / 2;
      if (dx * dx + dy * dy < (h / 4) ** 2) {
        data[i] = 240;
        data[i + 1] = 60 + variant * 30;
        data[i + 2] = 60;
      }
      if (x % 24 < 4) {
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 30;
      }
    }
  return { w, h, data };
}

function writeSynthPng(file: string, img: SourceImage) {
  const png = new PNG({ width: img.w, height: img.h });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

function projectsIdentical(a: any, b: any): { same: boolean; why: string } {
  if (a.frames.length !== b.frames.length) return { same: false, why: "frames" };
  if (a.colorTable.join() !== b.colorTable.join()) return { same: false, why: "colorTable" };
  if (a.indexBits !== b.indexBits) return { same: false, why: "indexBits" };
  if (a.speedIndex !== b.speedIndex) return { same: false, why: "speedIndex" };
  if (a.loop !== b.loop) return { same: false, why: "loop" };
  for (let f = 0; f < a.frames.length; f++) {
    if (a.frames[f].paper !== b.frames[f].paper) return { same: false, why: `paper@${f}` };
    const ba = a.frames[f].layers["L1"];
    const bb = b.frames[f].layers["L1"];
    for (let i = 0; i < PIXELS; i++)
      if (ba[i] !== bb[i]) return { same: false, why: `pixel@${f}:${i}` };
  }
  return { same: true, why: "" };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m8smoke-"));
  const img1 = synthImage(640, 480, 0);
  const img2 = synthImage(640, 480, 1);
  const png1 = path.join(tmp, "a.png");
  const png2 = path.join(tmp, "b.png");
  writeSynthPng(png1, img1);
  writeSynthPng(png2, img2);
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");

  // ---- (1) CLI vs 共有モジュール: 同一設定→同一出力 ----
  const cases: { name: string; args: string[]; opts: Partial<ConvertOptions>; multi?: boolean }[] = [
    { name: "color-auto-fs", args: [], opts: {} },
    { name: "color-ugo-ordered", args: ["--palette", "ugo", "--dither", "ordered"], opts: { palette: "ugo", dither: "ordered" } },
    { name: "tone-t35-a80", args: ["--mode", "tone", "--threshold", "35", "--dither-amt", "80", "--ink", "#ff1717"], opts: { mode: "tone", threshold: 35, ditherAmt: 80, ink: "#ff1717" } },
    { name: "lineart-e70-invert", args: ["--mode", "lineart", "--edge", "70", "--invert"], opts: { mode: "lineart", edge: 70, invert: true } },
    { name: "multi-contain-bc", args: ["--fit", "contain", "--brightness", "10", "--contrast", "20", "--fps", "6"], opts: { fit: "contain", brightness: 10, contrast: 20, fps: 6 }, multi: true },
  ];
  for (const c of cases) {
    const outFile = path.join(tmp, `${c.name}.memoanima`);
    const inputs = c.multi ? [png1, png2] : [png1];
    execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", path.join(repo, "scripts", "photo2memo.ts"), ...inputs, "-o", outFile, "--title", c.name, ...c.args],
      { cwd: repo, stdio: "pipe", shell: process.platform === "win32" }
    );
    const cliProject = await projectFromBytes(new Uint8Array(fs.readFileSync(outFile)));
    const modProject = convertToProject(c.multi ? [img1, img2] : [img1], {
      ...DEFAULT_CONVERT,
      ...c.opts,
      title: c.name,
    });
    const r = projectsIdentical(cliProject, modProject);
    check(`CLI一致:${c.name}`, r.same, r.why);
  }

  // ---- (2) 変換の不変条件 ----
  const o = { ...DEFAULT_CONVERT, title: "t" };

  // v5往復一致（モジュール出力をシリアライズ往復）
  const p = convertToProject([img1], o);
  const rt = await projectFromBytes(await projectToBytes(p));
  check("v5往復一致", projectsIdentical(p, rt).same);

  // contain の余白が透明(index0)＝紙が透ける
  const pc = convertToProject([{ w: 100, h: 100, data: synthImage(100, 100, 0).data }], {
    ...o,
    fit: "contain",
  });
  const buf = pc.frames[0].layers["L1"];
  check("contain余白=透明", buf[0] === 0 && buf[PIXELS - 1] === 0);
  // 中央は不透明
  check("contain中央=描画", buf[(H / 2) * W + W / 2] !== 0);

  // tone は 紙+インク の2色のみ
  const pt = convertToProject([img1], { ...o, mode: "tone" });
  check("tone=2色", pt.colorTable.length - 1 === 2, `got ${pt.colorTable.length - 1}`);

  // fps 丸め（fps=7 → 6 or 8 の最近傍=6）
  const pf = convertToProject([img1, img2], { ...o, fps: 7 });
  check("fps最近傍丸め", FPS_TABLE[pf.speedIndex] === 6, `got ${FPS_TABLE[pf.speedIndex]}`);

  // 8bit（auto24色）・ページ数
  check("indexBits=8(24色)", p.indexBits === 8 && p.colorTable.length - 1 <= 25);
  check("複数ページ", pf.frames.length === 2 && pf.loop === true);

  // 320×240固定（フレームバッファ長）
  check("320x240固定", p.frames[0].layers["L1"].length === W * H);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`m8 smoke: pass=${pass} fail=${fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
