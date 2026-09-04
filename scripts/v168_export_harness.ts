// V168: 書き出しの「1コマずつ起こす」を再現データで**実際に動かして**測る（受け入れ基準 6・7・8・9）。
//   npx tsx scripts/v168_export_harness.ts <vite の URL（?editor&proj=… 込み）>
//
// ★画素の反証（基準8）: **直す前の状態**（＝全コマを起こしてから書き出す・V163 の形）で作った
//   PNG-zip と、**直した後**（眠ったまま・読む直前に起こす）で作った PNG-zip を、
//   zip の**中身（PNG 1枚ずつ）**でバイト比較する。zip 自体は fflate が現在時刻を mtime に書くので
//   丸ごとは比べない。同じ Chrome・同じ画素なら canvas の PNG エンコードは決定的＝バイト一致が期待値。
//   「新コードの中で状態を変えて比べる」形だが、直す前のコードは frameSource.ts の中身が
//   compositeFrame 直呼びだった（= 全コマ起きていれば同じ関数）ので、比較としては同値。
// ★基準9: 「押してから保存ダイアログが出るまで」＝ 直す前は**全コマ起こし**が入口に居た。
//   直す前の入口コスト（全コマ起こしの所要）と、直した後の入口コスト（起こさない＝0）を同じページで測る。
// ★基準7: 書き出し中の実メモリ。タスクマネージャは vite では見られないので `performance.memory` の
//   JS ヒープと、`awakeBytes`（起きている生バッファ）を書き出し中に 250ms ごとに記録する。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:5199/?editor&proj=http://127.0.0.1:8765/";
const RANGE = Number(process.env.V168_RANGE ?? 300);

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("Chrome が見つかりません");
  process.exit(2);
}
const PORT = 9337;
const profile = path.join(process.env.TEMP ?? ".", `v168-export-${PORT}`);
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-background-timer-throttling", "--js-flags=--max-old-space-size=8192", url],
  { stdio: "ignore" }
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function targetWs(): Promise<string> {
  for (let i = 0; i < 80; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === "page" && t.url.includes("localhost"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* まだ */
    }
    await sleep(250);
  }
  throw new Error("CDP の口が開かない");
}
const ws = new WebSocket(await targetWs());
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String((ev as MessageEvent).data)) as { id?: number; result?: unknown };
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)!(m.result);
    pending.delete(m.id);
  }
});
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const myId = ++id;
  return new Promise((res) => {
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}
async function evalJs(expr: string, timeoutMs = 900000): Promise<any> {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r?.result?.value;
}
await send("Page.enable");
await send("Runtime.enable");

const opened = await evalJs(`(async () => {
  for (let i = 0; i < 1200; i++) { const ed = window.__animemo?.editor; if (ed?.project?.frames?.length >= 1000 && ed.mounted) break; await new Promise(r => setTimeout(r, 100)); }
  const ed = window.__animemo.editor; const sleep = await import('/src/editor/sleep.ts');
  return { frames: ed.project.frames.length, layers: ed.project.layerDefs.length, asleepFaces: sleep.asleepCount(ed.project), awakeMB: Math.round(sleep.awakeBytes(ed.project) / 1048576) };
})()`);
console.log("open:", JSON.stringify(opened));

// ---- 共通: PNG-zip を書き出して、中身（PNG ごと）のハッシュ列を返す ----
const EXPORT_FN = `
async function exportPngEntries(ed, a, b, tag) {
  const ex = await import('/src/editor/exporter.ts');
  const fsrc = await import('/src/editor/frameSource.ts');
  const sleep = await import('/src/editor/sleep.ts');
  const src = fsrc.withRange(fsrc.projectSource(ed.project), a, b);
  const mem = []; const t0 = performance.now();
  const sampler = setInterval(() => mem.push({ t: Math.round(performance.now() - t0), heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576), awakeMB: Math.round(sleep.awakeBytes(ed.project) / 1048576) }), 250);
  const blob = await ex.exportPngZip(src, { format: 'pngzip', scale: 1, whiteBg: true, cancel: { cancelled: false }, onProgress: () => {}, audio: null, loopCount: 1 });
  clearInterval(sampler);
  const ms = Math.round(performance.now() - t0);
  // zip の中身の比較は Node 側（fflate）で行う。ここは bytes を base64 で返すだけ
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { tag, ms, zipB64: btoa(bin), mem, peakHeapMB: Math.max(...mem.map(m => m.heapMB), 0), peakAwakeMB: Math.max(...mem.map(m => m.awakeMB), 0) };
}`;
/** Node 側: zip を開いて PNG ごとのハッシュと大きさを出す（fflate は本体の依存） */
async function entriesOf(zipB64: string): Promise<{ count: number; hashes: string[]; minPng: number; maxPng: number }> {
  const { unzipSync } = await import("fflate");
  const { createHash } = await import("node:crypto");
  const zip = unzipSync(new Uint8Array(Buffer.from(zipB64, "base64")));
  const names = Object.keys(zip).filter((n) => n.endsWith(".png")).sort();
  const hashes = names.map((n) => createHash("sha256").update(zip[n]).digest("hex"));
  const sizes = names.map((n) => zip[n].length);
  return { count: names.length, hashes, minPng: Math.min(...sizes), maxPng: Math.max(...sizes) };
}

// ---- ① 直した後（眠ったまま・供給元が読む直前に起こす）: 入口コストは 0 ----
const lazy = await evalJs(`(async () => { ${EXPORT_FN}
  const ed = window.__animemo.editor; const sleep = await import('/src/editor/sleep.ts');
  const before = { asleepFaces: sleep.asleepCount(ed.project), awakeMB: Math.round(sleep.awakeBytes(ed.project) / 1048576) };
  const r = await exportPngEntries(ed, 0, ${RANGE - 1}, 'lazy');
  await new Promise(r => setTimeout(r, 300));
  const after = { asleepFaces: sleep.asleepCount(ed.project), awakeMB: Math.round(sleep.awakeBytes(ed.project) / 1048576) };
  return { ...r, before, after, entryMs: 0 };
})()`);
console.log("lazy:", JSON.stringify({ ...lazy, zipB64: undefined, mem: undefined }));

// ---- ② 直す前の状態（全コマを起こしてから書き出す＝V163 の入口）: 入口コスト＝全コマ起こしの所要 ----
const eager = await evalJs(`(async () => { ${EXPORT_FN}
  const ed = window.__animemo.editor; const sleep = await import('/src/editor/sleep.ts');
  const t0 = performance.now();
  await sleep.wakeLayersAllFrames(ed.project, ed.project.layerDefs.map(d => d.id), 'read'); // 直す前の入口そのもの
  const entryMs = Math.round(performance.now() - t0);
  const awakeMBAfterWake = Math.round(sleep.awakeBytes(ed.project) / 1048576);
  const r = await exportPngEntries(ed, 0, ${RANGE - 1}, 'eager');
  return { ...r, entryMs, awakeMBAfterWake };
})()`);
console.log("eager:", JSON.stringify({ ...eager, zipB64: undefined, mem: undefined }));

// ---- ③ 比較（zip の中身を Node で開く） ----
const L = await entriesOf(lazy.zipB64);
const E = await entriesOf(eager.zipB64);
let same = 0;
for (let i = 0; i < Math.min(L.hashes.length, E.hashes.length); i++) if (L.hashes[i] === E.hashes[i]) same++;
const identical = L.count === E.count && L.count === RANGE && same === L.count;
console.log(`\nPNG-zip の中身: ${same}/${L.count} 枚がバイト一致（lazy vs eager・SHA-256）`);
console.log(`入口コスト: 直す前=${eager.entryMs}ms（全コマ起こし・起きている量 ${eager.awakeMBAfterWake}MB）／直した後=0ms`);
console.log(`書き出し本体: 直す前=${eager.ms}ms／直した後=${lazy.ms}ms（${RANGE}コマ・PNG-zip ×1）`);
console.log(`メモリ: 直した後の書き出し中 起きている量の最大=${lazy.peakAwakeMB}MB（開始時 ${lazy.before.awakeMB}MB・終了後 ${lazy.after.awakeMB}MB）／JS ヒープ最大=${lazy.peakHeapMB}MB`);
console.log(`白紙が無い: 最小 PNG=${L.minPng}B 最大=${L.maxPng}B（眠っていたコマの出力が紙だけなら極端に小さくなる）`);

ws.close();
chrome.kill();
await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ok = identical && lazy.entryMs + lazy.ms <= eager.entryMs + eager.ms;
console.log(ok ? "\nv168 export harness: OK" : "\nv168 export harness: NG");
process.exit(ok ? 0 : 1);
