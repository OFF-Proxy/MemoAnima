// V168: 保存の「見積り → 掃除を待つ → 写す／断る」を、再現データで**実際に動かして**測る（受け入れ基準 1・2・3・12）。
//   npx tsx scripts/v168_save_harness.ts <vite の URL（?editor&proj=… 込み）> <出力フォルダ>
//
// ★Tauri 無し（vite）なので、Rust の書き込みには届かない＝**ファイルには一切書かれない**（P-0）。
//   見たいのは写す前の段階（見積り・待ち・ピル・門番・postMessage の瞬間の姿）なので、それで足りる。
//   `cb.saveProject` は差し替えて「ハーネス: ディスク無し」で止める（写しの後ろで止まる）。
//
// 手順:
//   ① 再現データ（1,098コマ×20L・PV6）を開く → 掃除が追いつくのを待たずに
//   ② 349コマの範囲コピー → 貼り付け ×N（V166 の天井いっぱい＝実機の再現手順と同じ）
//   ③ Ctrl+S 相当（`save()`）。ピルの文言を 100ms ごとに記録・**待ちの間に線を引く**
//   ④ `worker.postMessage` の瞬間に「待ちの間に引いた線が project に入っているか」を見る（基準2）
//   ⑤ ログ `[V168] save prepare …` を回収（基準12）
//   ⑥ 別シナリオ: 眠りを切って（`sleepOn=false`）生のまま 2.6GB 級にし、**断られる**ことと文言を見る（基準4 の実機側）
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:5199/?editor&proj=http://127.0.0.1:8765/";
const outDir = process.argv[3] ?? "docs/shots/v168";
const PASTES = Number(process.env.V168_PASTES ?? 3);

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("Chrome が見つかりません");
  process.exit(2);
}
const PORT = 9336;
const profile = path.join(process.env.TEMP ?? ".", `v168-save-${PORT}`);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    // 2.6GB 級を扱うので、描画プロセスの上限を実機に近づける（既定は 4GB 前後で環境依存）
    "--js-flags=--max-old-space-size=8192",
    url,
  ],
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
async function evalJs(expr: string, timeoutMs = 600000): Promise<any> {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r?.result?.value;
}
async function shot(name: string) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, name);
  fs.writeFileSync(p, Buffer.from(s.data, "base64"));
  console.log("撮影:", p);
}
await send("Page.enable");
await send("Runtime.enable");

// ---- ① 開く（PV6 遅延読み＝ほぼ全コマが眠っている） ----
const opened = await evalJs(`(async () => {
  const t0 = performance.now();
  for (let i = 0; i < 1200; i++) {
    const ed = window.__animemo?.editor;
    if (ed?.project?.frames?.length >= 1000 && ed.mounted) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const ed = window.__animemo.editor;
  return { frames: ed.project.frames.length, layers: ed.project.layerDefs.length, sleepOn: ed.sleepOn, openMs: Math.round(performance.now() - t0) };
})()`);
console.log("open:", JSON.stringify(opened));
if (!opened || opened.frames < 1000) {
  console.error("NG: 再現データが開けていない");
  process.exit(1);
}

// ---- ② 貼り付けで太らせる（V166 の天井 349 コマ × N 回） ----
const grown = await evalJs(`(async () => {
  const ed = window.__animemo.editor;
  const km = await import('/src/keymap.ts');
  ed.applyKeyPreset(km.BUILTIN_PRESETS[0]);
  // 349 = 512MiB / (20×76,800)。V166 の allowFrameAlloc がちょうど通す枚数
  const before = ed.project.frames.length;
  ed.rangeSel = { a: 0, b: 348 };
  await ed.copySelectedFrames();
  const pastes = ${PASTES};
  for (let k = 0; k < pastes; k++) { ed.frameIndex = ed.project.frames.length - 1; await ed.pasteFrames(); }
  const sleep = await import('/src/editor/sleep.ts');
  const prefs = await import('/src/editor/prefs.ts');
  const est = prefs.snapshotBytes(ed.project);
  return { before, after: ed.project.frames.length, awake: sleep.awakeBytes(ed.project), sleepB: sleep.sleepBytes(ed.project), est: est.est, plan: prefs.saveSnapshotPlan(est.est), allowed: prefs.saveSnapshotAllowed(est.est),
           heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) };
})()`);
console.log("grown:", JSON.stringify(grown));

// ---- ③〜⑤ 保存: 待ちの間に線を引き、postMessage の瞬間の姿とログを回収 ----
const saved = await evalJs(`(async () => {
  const ed = window.__animemo.editor;
  const logs = []; const pill = []; const phases = [];
  const origLog = ed.cb.appendLog; ed.cb.appendLog = (s) => { if (/\\[V168\\]|\\[V161\\]|\\[V154/.test(s)) logs.push(s); origLog?.(s); };
  ed.cb.saveProject = async () => { throw new Error("harness: no disk"); };
  const origNotice = ed.cb.notice; // ⑥（断りのダイアログを撮る）のために、あとで必ず戻す
  ed.cb.notice = async (m) => { logs.push("NOTICE: " + m.replace(/\\s+/g, " ").slice(0, 200)); };
  window.__v168restoreNotice = () => { ed.cb.notice = origNotice; };
  ed.saveCtx = { libRoot: "", album: "h", baseName: "h", legacy: false }; ed.askSaveTarget = false;
  // postMessage の瞬間を捕まえる（写しの基準点）
  const worker = ed.ensureSaveWorker();
  const origPost = worker.postMessage.bind(worker);
  let atPost = null;
  worker.postMessage = (m, ...rest) => {
    if (m?.kind === "encode") {
      const f = ed.project.frames[ed.frameIndex]; const lid = ed.project.layerDefs[ed.project.layerDefs.length - 1].id;
      const b = f.layers[lid]; let ink = 0; if (b) for (let i = 0; i < b.length; i++) if (b[i] !== 0) ink++;
      atPost = { t: performance.now(), inkOnCurrentTopLayer: ink, epoch: ed.editEpoch, phase: ed.savePhase };
    }
    return origPost(m, ...rest);
  };
  const t0 = performance.now();
  const job = ed.save();
  // ピル・段階を 100ms ごとに記録
  let drewAt = null; let inkAfterDraw = 0;
  const wrap = document.querySelector('#ed-cvwrap'); const rect = wrap.getBoundingClientRect(); const zoom = rect.width / 320;
  const at = (x, y) => ({ clientX: rect.left + (x + 0.5) * zoom, clientY: rect.top + (y + 0.5) * zoom });
  const timer = setInterval(() => {
    const el = document.getElementById('ed-savepill');
    const txt = el && !el.hidden ? (el.querySelector('span')?.textContent ?? '') : '';
    if (pill[pill.length - 1] !== txt) pill.push(txt);
    if (phases[phases.length - 1] !== ed.savePhase) phases.push(ed.savePhase);
    // ★待ちの最中（prepare）に1本だけ線を引く（基準2: 待ちの間も描ける・その線が写しに入る）
    if (ed.savePhase === 'prepare' && drewAt === null) {
      drewAt = performance.now();
      wrap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'pen', button: 0, buttons: 1, isPrimary: true, ...at(100, 100) }));
      wrap.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'pen', buttons: 1, isPrimary: true, ...at(140, 140) }));
      wrap.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'pen', button: 0, buttons: 0, isPrimary: true, ...at(140, 140) }));
      const f = ed.project.frames[ed.frameIndex]; const lid = ed.project.layerDefs[ed.project.layerDefs.length - 1].id;
      const b = f.layers[lid]; if (b) for (let i = 0; i < b.length; i++) if (b[i] !== 0) inkAfterDraw++;
    }
  }, 100);
  let ok = null; try { ok = await job; } catch (e) { ok = 'threw:' + e; }
  clearInterval(timer);
  worker.postMessage = origPost; ed.cb.appendLog = origLog;
  return { result: ok, totalMs: Math.round(performance.now() - t0), pill, phases, logs, atPost, drewAt: drewAt === null ? null : Math.round(drewAt - t0), inkAfterDraw,
           strokeInSnapshot: atPost ? atPost.inkOnCurrentTopLayer >= inkAfterDraw && inkAfterDraw > 0 : null,
           heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) };
})()`);
console.log("save:", JSON.stringify(saved, null, 2));

// ---- ピルのスクリーンショット（掃除待ちを再現して撮る: 2回目の保存を prepare 中に撮る） ----
{
  const shotState = await evalJs(`(async () => {
    const ed = window.__animemo.editor;
    // もう一度太らせて（1回）、保存を始め、prepare の間に撮る
    ed.rangeSel = { a: 0, b: 348 }; await ed.copySelectedFrames(); ed.frameIndex = ed.project.frames.length - 1; await ed.pasteFrames();
    const job = ed.save();
    for (let i = 0; i < 300; i++) { if (ed.savePhase === 'prepare' && !document.getElementById('ed-savepill').hidden) break; await new Promise(r => setTimeout(r, 50)); }
    // 貼り付けで出たメーターの注意（V154 W-3）は閉じてから撮る（撮りたいのはピル）
    document.querySelectorAll('.modal-back button').forEach(b => b.click());
    await new Promise(r => setTimeout(r, 400));
    window.__v168job = job;
    return { phase: ed.savePhase, pill: document.getElementById('ed-savepill')?.querySelector('span')?.textContent ?? '' , frames: ed.project.frames.length };
  })()`);
  console.log("pill:", JSON.stringify(shotState));
  await shot("save-prepare-pill.png");
  // 待ちの最中に「閉じる」相当（waitForSave）→ 中央表示も同じ段階文言
  const central = await evalJs(`(async () => {
    const ed = window.__animemo.editor;
    const p = ed.waitForSave();
    await new Promise(r => setTimeout(r, 300));
    const msg = document.querySelector('.busy-box .busy-msg');
    const txt = msg ? msg.textContent : null;
    return { centralText: txt, phase: ed.savePhase };
  })()`);
  console.log("central:", JSON.stringify(central));
  await shot("save-prepare-central.png");
  await evalJs(`(async () => { try { await window.__v168job; } catch {} ; return 1; })()`);
}

// ---- ⑥ 門番: 眠りを切って生のまま 2.6GB 級 → 断られる（文言と、失敗しないこと） ----
const refused = await evalJs(`(async () => {
  const ed = window.__animemo.editor;
  const sleep = await import('/src/editor/sleep.ts');
  const prefs = await import('/src/editor/prefs.ts');
  // 全部起こす（読み）→ 眠りを切る＝掃除が絶対に追いつかない状態（＝門番だけが守る場面）
  await sleep.wakeLayersAllFrames(ed.project, ed.project.layerDefs.map(d => d.id), 'read');
  ed.sleepOn = false;
  const est = prefs.snapshotBytes(ed.project);
  const logs = []; const origLog = ed.cb.appendLog; ed.cb.appendLog = (s) => { if (/\\[V168\\]/.test(s)) logs.push(s); origLog?.(s); };
  // 撮りたいのは**本物の断りのダイアログ**なので notice を元に戻す。先に残っている小窓（メーターの注意）を閉じる
  window.__v168restoreNotice?.();
  document.querySelectorAll('.modal-back button').forEach(b => b.click());
  await new Promise(r => setTimeout(r, 300));
  const worker = ed.ensureSaveWorker(); let posted = false; const origPost = worker.postMessage.bind(worker); worker.postMessage = (m, ...r) => { if (m?.kind === 'encode') posted = true; return origPost(m, ...r); };
  const t0 = performance.now();
  let result = null; try { result = await ed.save(); } catch (e) { result = 'threw:' + e; }
  worker.postMessage = origPost; ed.cb.appendLog = origLog;
  await new Promise(r => setTimeout(r, 300));
  const back = document.querySelector('.modal-back');
  const noticeText = back ? back.innerText.replace(/\\s+/g, ' ').trim() : null;
  return { estGB: (est.est / 1073741824).toFixed(2), awakeGB: (est.awake / 1073741824).toFixed(2), result, posted, ms: Math.round(performance.now() - t0), logs, noticeText, dirtyStill: ed.dirty };
})()`);
console.log("refused:", JSON.stringify(refused, null, 2));
await shot("save-refused.png");

ws.close();
chrome.kill();
await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 使用中なら残る */ }
const ok =
  saved?.strokeInSnapshot === true &&
  Array.isArray(saved?.pill) && saved.pill.some((s: string) => /保存の準備|Preparing/.test(s)) &&
  saved.logs.some((s: string) => /\[V168\] save prepare/.test(s)) &&
  refused?.posted === false && refused?.result === false && /\[V168\] save refused/.test(refused.logs.join("\n"));
console.log(ok ? "\nv168 save harness: OK" : "\nv168 save harness: NG");
process.exit(ok ? 0 : 1);
