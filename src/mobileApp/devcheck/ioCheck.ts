// V229 (M-4・REQ_mobile_m4_io.md §3-10): 確かめ画面（開発用）の「出し入れ」の入口。印なしのビルド（製品）には入らない
// （screen.ts と同じく、確かめ画面の印のビルドの入口だけが読む）。共通の口（ioPort.ts・exportMobile.ts・mp4Encode.ts）を呼んで動かし、
// 結果を写せる文字で出す（data-id="io-log"）。作品名・パス・URI はログに書かない（名札・種類・大きさ・時間・結果の値だけ）。
//
//  ・能力の判定（倍率ごとの H.264・AAC）
//  ・自動の測り: T-1（作れるか）・T-2（×4・10 秒・音つきの速さ）・T-9（GIF・APNG・PNG 連番が動くか・×8 の見積りの線の近く）・
//    T-4（受け取った音のファイルを decodeAudioData で読めるか）
//  ・書き出し（形式×倍率）→ 共有・保存・捨てる／ライブラリの作品（.memoanima）を渡す
//  ・ファイルを選ぶ・写真を選ぶ・音を選ぶ → 見分ける・取り込む・読む／受け取ったもの（共有・このアプリで開く）／全部書き出す／一時の場所の掃除
import { invoke } from "@tauri-apps/api/core";
import { estimateExport } from "../../editor/exportCore";
import type { FrameSource } from "../../editor/frameSource";
import { pcmS16ToWav } from "../../editor/audio";
import { exportAllName, makeIoPort, type InItem, type IoPort } from "../../mobile/ioPort";
import { runMobileExport, type MobileExportKind } from "../../mobile/io/exportMobile";
import { probeMp4Caps } from "../../mobile/io/mp4Encode";

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const lines: string[] = [];
let logEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let io: IoPort | null = null;
let lastOut: { tag: string; ext: string } | null = null;
const items: InItem[] = [];

function log(s: string): void {
  lines.push(s);
  if (logEl) logEl.textContent = lines.slice(-80).join("\n");
  void invoke("mobile_dev_log", { args: { line: `[V229 io] ${s}` } }).catch(() => undefined);
}
function port(): IoPort {
  if (!io) io = makeIoPort(invoke, /android/i.test(navigator.userAgent) ? "android" : "ios");
  return io;
}
async function guarded(name: string, f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (e) {
    log(`${name}: 失敗 ${(e as { code?: string })?.code ?? String((e as Error)?.message ?? e).slice(0, 80)}`);
  }
}

/** 試しの作品（作者の作品を使わない）: 320×240・コマごとに違う四角 */
export function sampleSource(n: number, fps: number): FrameSource {
  return {
    count: n,
    fps,
    loop: true,
    async getFrameRgba(i: number) {
      const a = new Uint8ClampedArray(320 * 240 * 4).fill(255);
      const x0 = (i * 37) % 280;
      const y0 = (i * 23) % 200;
      for (let y = y0; y < y0 + 40; y++) for (let x = x0; x < x0 + 40; x++) {
        const p = (y * 320 + x) * 4;
        a[p] = (i * 53) % 200;
        a[p + 1] = 80;
        a[p + 2] = 30;
      }
      return a;
    },
  } as FrameSource;
}
function sampleAudio(sec: number) {
  const sr = 48000;
  const n = Math.round(sec * sr);
  const pcm = new Int16Array(n * 2);
  for (let k = 0; k < n; k++) pcm[k * 2] = pcm[k * 2 + 1] = k % 4800 < 144 ? 12000 : Math.round(Math.sin(k / 30) * 3000);
  return { wav: pcmS16ToWav(pcm, sr, 2), durationSec: sec, syncMode: "audioToAnim" as const };
}

async function exportOne(kind: MobileExportKind, scale: number, frames: number, fps: number, withAudio: boolean): Promise<{ tag: string; size: number; ms: number; ext: string }> {
  const t0 = performance.now();
  const r = await runMobileExport(
    { kind, src: sampleSource(frames, fps), scale, whiteBg: true, audio: withAudio ? sampleAudio(frames / fps) : null, cancel: { cancelled: false } },
    (ext) => port().beginOut(ext, `確かめ_${kind}`)
  );
  return { tag: r.tag, size: r.size, ms: performance.now() - t0, ext: r.ext };
}

async function autoMeasure(): Promise<void> {
  const caps = await probeMp4Caps(undefined, { fresh: true });
  log(`T-1 能力: H.264 ×${caps.scales.join("・×") || "なし"}・AAC ${caps.aac ? "○" : "×"}`);
  for (const s of [1, 2, 4, 8]) {
    if (!caps.scales.includes(s as 1)) continue;
    await guarded(`T-1 MP4 ×${s}`, async () => {
      const r = await exportOne("mp4", s, 12, 12, caps.aac);
      log(`T-1 MP4 ×${s}${caps.aac ? "・音" : ""}: ${r.size} B・${r.ms.toFixed(0)} ms`);
      lastOut = { tag: r.tag, ext: r.ext };
    });
  }
  await guarded("T-2", async () => {
    const r = await exportOne("mp4", 4, 120, 12, caps.aac);
    log(`T-2 ×4・10 秒（120 コマ・12fps）${caps.aac ? "・音" : "・音なし（AAC が無い）"}: ${(r.ms / 1000).toFixed(1)} 秒・${r.size} B`);
    lastOut = { tag: r.tag, ext: r.ext };
  });
  for (const [k, s, n] of [["gif", 1, 24], ["gif", 4, 24], ["apng", 2, 24], ["pngzip", 4, 24], ["gif", 8, 12]] as [MobileExportKind, number, number][]) {
    await guarded(`T-9 ${k} ×${s}`, async () => {
      const est = estimateExport({ format: k as "gif", scale: s, frames: n });
      const r = await exportOne(k, s, n, 12, false);
      log(`T-9 ${k} ×${s}・${n} コマ: ${r.size} B・${r.ms.toFixed(0)} ms・見積りのメモリ ${(est.memBytes / 1048576).toFixed(0)} MiB`);
    });
  }
  const mem = (performance as unknown as { memory?: { jsHeapSizeLimit: number } }).memory;
  log(`T-9 JS のヒープの上限: ${mem ? (mem.jsHeapSizeLimit / 1048576).toFixed(0) + " MiB" : "（読めない）"}`);
}

async function decodeAll(): Promise<void> {
  const ctx = new AudioContext();
  for (const it of items) {
    await guarded(`T-4 ${it.tag}`, async () => {
      const sn = await port().sniff(it.tag);
      const bytes = await port().readAll(it.tag, sn.size);
      const ext = (it.name.split(".").pop() ?? "").toLowerCase();
      try {
        const b = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
        log(`T-4 ${ext}（${sn.kind}）: 読めた ${b.duration.toFixed(2)} 秒・${b.sampleRate} Hz・${b.numberOfChannels} ch`);
      } catch (e) {
        log(`T-4 ${ext}（${sn.kind}）: 読めない ${(e as Error)?.name ?? ""}`);
      }
    });
  }
  await ctx.close();
}

async function imageAll(): Promise<void> {
  for (const it of items) {
    await guarded(`T-7 ${it.tag}`, async () => {
      const sn = await port().sniff(it.tag);
      const bytes = await port().readAll(it.tag, sn.size);
      const bm = await createImageBitmap(new Blob([bytes as BlobPart]));
      const cv = new OffscreenCanvas(bm.width, bm.height);
      const cx = cv.getContext("2d")!;
      cx.drawImage(bm, 0, 0);
      const d = cx.getImageData(0, 0, bm.width, bm.height).data;
      let hsh = 0;
      for (let i = 0; i < d.length; i += 4) hsh = (hsh * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0;
      const tl = `${d[0]},${d[1]},${d[2]}`;
      log(`T-7 ${sn.kind}: ${bm.width}×${bm.height}・左上 ${tl}・画素の印 ${hsh.toString(16)}`);
    });
  }
}

function renderList(): void {
  if (!listEl) return;
  listEl.replaceChildren(
    ...items.map((it, i) =>
      h("div", { "data-id": `io-item-${i}` },
        `${i}: ${it.tag}・${it.size} B `,
        h("button", { "data-id": `io-sniff-${i}`, onclick: () => void guarded("見分ける", async () => log(`見分けた ${i}: ${JSON.stringify(await port().sniff(it.tag))}`)) }, "見分ける"),
        h("button", { "data-id": `io-import-${i}`, onclick: () => void guarded("取り込む", async () => {
          const album = (document.querySelector('[data-id="io-album"]') as HTMLInputElement | null)?.value || "";
          const r = await port().importTo(it.tag, album, "取り込んだ作品");
          log(`取り込んだ ${i}: ${r.placed.length} 件（${r.placed.map((p) => p.kind).join(",")}）・飛ばした ${r.skipped}・作ったアルバム ${r.albumsCreated.length}`);
          items.splice(i, 1);
          renderList();
        }) }, "取り込む"),
        h("button", { "data-id": `io-discard-${i}`, onclick: () => void guarded("捨てる", async () => {
          await port().discard(it.tag);
          items.splice(i, 1);
          renderList();
        }) }, "捨てる")
      )
    )
  );
}
function addItems(xs: InItem[], how: string): void {
  items.push(...xs);
  log(`${how}: ${xs.length} 件（${xs.map((x) => `${x.size} B`).join("・")}）`);
  renderList();
}

/** 確かめ画面の「V229 出し入れ」の節の中身 */
export function ioCheckView(): HTMLElement {
  const b = (id: string, label: string, f: () => Promise<unknown>) => h("button", { "data-id": id, onclick: () => void guarded(label, f) }, label);
  logEl = h("pre", { "data-id": "io-log", style: "white-space:pre-wrap;font-size:11px;background:#f4f4f4;max-height:40vh;overflow:auto" }, lines.join("\n"));
  listEl = h("div", { "data-id": "io-items" });
  (globalThis as unknown as { __mbIoInbox?: () => void }).__mbIoInbox = () => void guarded("受け取り", async () => addItems(await port().received(), "受け取った（知らせ）"));
  const view = h("div", {},
    h("div", {},
      b("io-caps", "能力の判定", async () => {
        const c = await probeMp4Caps(undefined, { fresh: true });
        log(`能力: H.264 ×${c.scales.join("・×") || "なし"}・AAC ${c.aac ? "○" : "×"}`);
      }),
      b("io-auto", "自動の測り（T-1・T-2・T-9）", autoMeasure),
      b("io-clean", "一時の場所の掃除", async () => log(`掃除: ${(await port().cleanup(false)).removed} 件`))),
    h("div", {},
      ...(["mp4", "gif", "apng", "pngzip"] as MobileExportKind[]).map((k) =>
        b(`io-export-${k}`, `${k} ×2`, async () => {
          const r = await exportOne(k, 2, 24, 12, k === "mp4");
          lastOut = { tag: r.tag, ext: r.ext };
          log(`書き出した ${k}: ${r.size} B・${r.ms.toFixed(0)} ms`);
        })
      ),
      b("io-share", "共有", async () => lastOut && log(`共有: ${await port().share(lastOut.tag)}`)),
      b("io-save", "保存", async () => lastOut && log(`保存: ${await port().saveAs(lastOut.tag)}`)),
      b("io-out-work", ".memoanima を渡す（一番上の作品）", async () => {
        const list = (await invoke("mobile_library_list")) as { works: { album: string; name: string }[] };
        const w = list.works[0];
        if (!w) return log(".memoanima: 作品が無い");
        lastOut = { tag: await port().outWork(w.album, w.name), ext: "memoanima" };
        log(`.memoanima を一時の場所へ写した: ${lastOut.tag}`);
      })),
    h("div", {},
      b("io-pick-works", "ファイルを選ぶ", async () => addItems(await port().pick("works", true), "選んだ")),
      b("io-pick-photo", "写真を選ぶ", async () => addItems(await port().pick("photo", true), "写真")),
      b("io-pick-audio", "音を選ぶ", async () => addItems(await port().pick("audio", true), "音")),
      b("io-received", "受け取ったもの", async () => addItems(await port().received(), "受け取った")),
      b("io-decode", "音を読む（T-4）", decodeAll),
      b("io-image", "画像を読む（T-7）", imageAll)),
    h("div", {}, "取り込む先のアルバム: ", h("input", { "data-id": "io-album", value: "" })),
    h("div", {},
      b("io-export-all", "全部書き出す", async () => {
        const job = await port().exportAllBegin(exportAllName("メモアニマ_全作品"));
        for (;;) {
          await new Promise((r) => setTimeout(r, 300));
          const s = await port().exportAllStatus(job);
          if (s.state !== "running") {
            log(`全部書き出す: ${s.state}・${s.done}/${s.total} 件・${s.bytes} B・飛ばした ${s.skipped}${s.refusal ? `・${s.refusal}` : ""}`);
            if (s.tag) lastOut = { tag: s.tag, ext: "zip" };
            break;
          }
        }
      }),
      b("io-notes", ".kwz の一覧（D-18）", async () => log(`.kwz・.ppm: ${(await port().libraryNotes()).length} 件`))),
    listEl,
    logEl
  );
  renderList();
  return view;
}
