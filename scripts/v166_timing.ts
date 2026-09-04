// V166: 漏斗の「50ms を超えたら出す／一瞬では出さない」を実測する（受け入れ基準3）。
//   npx tsx scripts/v166_timing.ts <vite の URL>
//
// ★なぜ専用の駆け出しが要るか
//   背景タブの Chrome は `setTimeout` を**1秒までクランプ**する。埋め込みブラウザの
//   ペインが隠れていると 50ms のつもりが 1000ms になり、**製品ではなく計測が狂う**。
//   ここでは headless Chrome の**前面タブ**で測り、`visibilityState` も一緒に出して
//   「見えている状態で測った」ことを数字と一緒に残す。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:5199/?editor";
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("Chrome が見つかりません");
  process.exit(2);
}

const PORT = 9334;
const profile = path.join(process.env.TEMP ?? ".", `v166-timing-${PORT}`);
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
    // ★背景タブのタイマー抑制を切る（隠れていない前提で測るため）
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
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
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await sleep(2500);

const out = await evalJs(`(async () => {
  const ed = window.__animemo.editor;
  const busy = await import('/src/ui/busy.ts');
  const shown = [];
  busy.setBusyImpl((msg) => { shown.push({ msg, at: performance.now() }); return () => {}; });
  const r = { visibility: document.visibilityState };

  // ★カナリア: vite は編集のたびに \`?t=…\` 付きの URL で配るので、動的 import が
  //  **editor が使っているのと別の実体**になることがある（そうなると箱は永久に出ず、
  //  「製品が壊れている」ように見える）。先に1回、確かに同じ実体かを確かめる。
  //  ここが false なら測定を信用してはいけない＝サーバを再起動して測り直す
  {
    shown.length = 0;
    await ed.runHeavy("frame.paste", "カナリア", async () => { await new Promise(x => setTimeout(x, 200)); });
    r.moduleShared = shown.length > 0;
    if (!r.moduleShared) return r;   // 測っても意味が無いので、ここで返す
  }

  // ① 一瞬で終わる操作では出さない（小さい作品でチラつかない）
  shown.length = 0;
  await ed.runHeavy("frame.add", "はやい", () => {});
  r.fast_shown = shown.length;

  // ② 50ms を超える非同期の操作では出す（3回測る）
  r.async_delaysMs = [];
  for (let k = 0; k < 3; k++) {
    shown.length = 0;
    const t0 = performance.now();
    await ed.runHeavy("frame.paste", "おそい", async () => { await new Promise(x => setTimeout(x, 300)); });
    r.async_delaysMs.push(shown.length ? Math.round(shown[0].at - t0) : null);
  }

  // ③ ★同期で塞ぐ操作では箱を出せない（正直な限界・Codex 指摘）。
  //    ただし「押せなくなった見た目」は塞ぐ前に描かれている
  shown.length = 0;
  let lockedBeforeBlocking = null;
  await ed.runHeavy("layer.merge", "おそい同期", () => {
    lockedBeforeBlocking = document.querySelector('#screen-editor')?.classList.contains('ed-busy');
    const end = performance.now() + 300; while (performance.now() < end) {}
  });
  r.sync_boxShown = shown.length > 0;
  r.sync_lockedBeforeBlocking = lockedBeforeBlocking;
  return r;
})()`);

console.log(JSON.stringify(out, null, 2));

ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* 使用中なら残る */
}

// 判定（報告書に載せる形にそろえる）
const ok =
  out.visibility === "visible" &&
  out.moduleShared === true &&
  out.fast_shown === 0 &&
  out.async_delaysMs.every((d: number | null) => d !== null && d < 200) &&
  out.sync_boxShown === false &&
  out.sync_lockedBeforeBlocking === true;
console.log(ok ? "\nv166 timing: OK" : "\nv166 timing: NG");
process.exit(ok ? 0 : 1);
