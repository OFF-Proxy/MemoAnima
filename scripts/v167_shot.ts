// V167: 断り文句（K-1）と、すでに二重の設定への印（K-2）を撮る（報告書の証拠）。
//   npx tsx scripts/v167_shot.ts <vite の URL> <出力フォルダ>
//
// ★依存を足さない: Chrome を `--headless=new --remote-debugging-port` で起こし、
//  CDP を素の WebSocket で叩くだけ（Node 24 に同梱）。V166 の `v166_shot.ts` と同じ作り。
//
// ★手順は**利用者と同じ道**を通す（設定画面を開く → 「変更」を押す → Alt をタップ）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:5199/?editor";
const outDir = process.argv[3] ?? "docs/shots/v167";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("Chrome が見つかりません");
  process.exit(2);
}

const PORT = 9335;
const profile = path.join(process.env.TEMP ?? ".", `v167-chrome-${PORT}`);
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
    url,
  ],
  { stdio: "ignore" }
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
async function evalJs(expr: string): Promise<any> {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
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
await sleep(2600);

// ================= ① K-1: 断り文句 =================
// 既定（スポイト＝Alt＋クリック）のまま、「元に戻す」へ Alt のタップを登録しようとする
const refusal = await evalJs(`(async () => {
  window.__animemo.openKeys();
  await new Promise(r => setTimeout(r, 500));
  const undo = [...document.querySelectorAll('.km-row')].find(r => r.dataset.cmd === 'edit.undo');
  undo.querySelector('.km-set').click();
  await new Promise(r => setTimeout(r, 200));
  undo.scrollIntoView({ block: 'center' });
  // ★keydown と keyup は**同じタスクの中で連続**して送る。
  //  間に await を挟むと、タイマーの粗さで 250ms の「タップ」判定を超えてしまう
  window.dispatchEvent(new KeyboardEvent('keydown', { key:'Alt', code:'AltLeft', bubbles:true, cancelable:true }));
  window.dispatchEvent(new KeyboardEvent('keyup',   { key:'Alt', code:'AltLeft', bubbles:true, cancelable:true }));
  await new Promise(r => setTimeout(r, 500));
  const msgs = [...document.querySelectorAll('.modal-msg')].map(e => e.innerText.replace(/\\s+/g,' ').trim());
  return msgs[msgs.length - 1] || null;
})()`);
console.log("断り文句:", refusal);
if (!refusal || !/Alt/.test(refusal)) {
  console.error("NG: 断り文句が出ていない");
  process.exit(1);
}
await shot("refusal.png");

// ================= ② K-2: すでに二重の設定への印 =================
// K-1 が入った今、この状態は UI からは作れない＝**古い settings.json で開いた人**の状況を作る
const marks = await evalJs(`(async () => {
  [...document.querySelectorAll('.modal-back button')].filter(b => b.offsetParent && /いいえ/.test(b.textContent))[0]?.click();
  await new Promise(r => setTimeout(r, 300));
  [...document.querySelectorAll('.modal-back button')].filter(b => b.offsetParent && /閉じる/.test(b.textContent))[0]?.click();
  await new Promise(r => setTimeout(r, 300));
  const km = await import('/src/keymap.ts');
  km.BUILTIN_PRESETS[0].bindings['edit.undo'] = { code: '', tap: 'Alt' };
  window.__animemo.openKeys();
  await new Promise(r => setTimeout(r, 600));
  const rows = [...document.querySelectorAll('.km-row')];
  const undo = rows.find(r => r.dataset.cmd === 'edit.undo');
  const pick = rows.find(r => r.dataset.cmd === 'edit.pickColor');
  undo.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 200));
  return {
    undoMarked: undo.classList.contains('km-clash'),
    pickMarked: pick.classList.contains('km-clash'),
    undoText: undo.innerText.replace(/\\s+/g,' ').trim(),
    // ★黙って外していないこと（どちらの割り当ても残っている）
    undoStillBound: !/未割り当て/.test(undo.innerText),
    pickStillBound: !/未割り当て/.test(pick.innerText),
  };
})()`);
console.log("印:", JSON.stringify(marks, null, 2));
if (!marks?.undoMarked || !marks?.pickMarked || !marks.undoStillBound || !marks.pickStillBound) {
  console.error("NG: 印が出ていない／黙って外れている");
  process.exit(1);
}
await shot("clash-mark.png");

ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* 使用中なら残る */
}
console.log("\nv167 shot: OK");
process.exit(0);
