// V166: 断り文句のスクリーンショットを撮る（報告書の証拠）。
//   npx tsx scripts/v166_shot.ts <vite の URL> <出力 png>
//
// ★依存を足さない: Chrome を `--headless=new --remote-debugging-port` で起こし、
//  CDP（DevTools プロトコル）を素の WebSocket で叩くだけ（Node 24 に同梱）。
//
// 手順は**利用者と同じ道**を通す:
//   レイヤーを20枚 → コマを増やす → 範囲コピー → 貼り付け → 断られる → 撮る
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:5199/?editor";
const outPng = process.argv[3] ?? "docs/shots/v166/refusal.png";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("Chrome が見つかりません");
  process.exit(2);
}

const PORT = 9333;
const profile = path.join(process.env.TEMP ?? ".", `v166-chrome-${PORT}`);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,800",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    url,
  ],
  { stdio: "ignore", detached: false }
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function targetWs(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = list.find((t) => t.type === "page" && t.url.includes("localhost"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* まだ立ち上がっていない */
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

/** ページの中で式を評価する（await 可） */
async function evalJs(expr: string): Promise<any> {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await sleep(2500); // vite の初回変換を待つ

// ---- 利用者と同じ道で「断られる状態」を作る ----
const state = await evalJs(`(async () => {
  const ed = window.__animemo.editor;
  while (ed.project.layerDefs.length < 20) ed.addLayer();
  for (let i = 0; i < 40; i++) await ed.addFrame(false);
  // 実経路の貼り付けで 164 コマまで増やす（41 → 82 → 164）
  for (let i = 0; i < 2; i++) {
    ed.rangeSel = { a: 0, b: ed.project.frames.length - 1 };
    await ed.copySelectedFrames();
    await ed.pasteFrames();
  }
  // ★コピーは**普通の上限のまま**（コピーも見積もりを通るので、先に下げるとコピーが断られる）
  ed.rangeSel = { a: 0, b: ed.project.frames.length - 1 };
  await ed.copySelectedFrames();
  // サイズ注意の小窓が出ていたら閉じる（撮りたいのは断り文句のほう）
  document.querySelectorAll('.modal-back button').forEach(b => b.click());
  await new Promise(r => setTimeout(r, 300));
  // ★ここで確保の上限を「100コマぶん」に下げる＝**確保に一度失敗したあと（E）と同じ状態**。
  //   1GB を実際に確保せずに、貼り付けの断り文句を出すため
  //   （通す/断るを決めるのは本物の allowFrameAlloc → checkFrameAlloc）
  ed.heavyAllocBudget = 100 * 20 * 320 * 240;
  const before = ed.project.frames.length;
  await ed.pasteFrames();
  await new Promise(r => setTimeout(r, 400));
  const back = document.querySelector('.modal-back');
  return { before, after: ed.project.frames.length,
           text: back ? back.innerText.replace(/\\s+/g, ' ').trim() : null };
})()`);
console.log("状態:", JSON.stringify(state, null, 2));
if (!state?.text) {
  console.error("NG: 断り文句が出ていない");
  process.exit(1);
}
if (state.before !== state.after) {
  console.error("NG: 断ったのにコマが増えている");
  process.exit(1);
}

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.mkdirSync(path.dirname(outPng), { recursive: true });
fs.writeFileSync(outPng, Buffer.from(shot.data, "base64"));
console.log(`撮影: ${outPng}`);

ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* 使用中なら残る（次回上書き） */
}
process.exit(0);
