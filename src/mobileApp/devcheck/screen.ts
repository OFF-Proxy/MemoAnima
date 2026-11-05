// V211 (M-1b・要件 §6-5・決-6): 確かめ画面（開発用・日本語だけ・見た目は問わない）。ビルドの印（__MOBILE_DEVCHECK__）の中だけで読み込まれる。
//
// できること: OS の判定とアプリの版／アルバムの一覧・作る・名前を変える・削除／作品の一覧（サムネ）・名前を変える・移す・削除／
// 新規メモ・開く（オートセーブが残っていれば先に聞く）／今のコマの絵・コマを送る・1 色のペン（共通の raster.ts）／保存（初めての保存・
// 上書き・別名）・保存しないで戻る／オートセーブの状態（最後に書いた時刻）・残っているオートセーブの一覧と提案／復元の候補（控え）／
// 大きい作品を作る／メモリを使い切る（D4）／空きが無いふり（D3）／保存の途中で止める（D2）／裏に回った・戻った・書き始めた・書き終えた
// 時刻の記録（画面に出してコピーできる・送らない）／開くと保存にかかった時間と、保存の間に画面が止まった時間。
//
// ★故障を起こす操作は、試験用のライブラリを開いているときだけ押せる（Rust の命令の側でも断る）。試験用のライブラリを開いているかは、
//  画面を出すたびに Rust に聞く（ここでは覚えない・localStorage などに場所も状態も書かない）。
// ★断りの文はそのまま出さない（決まった値ならその値・それ以外は「できなかった（詳しくはログ）」＝W-10・V202 §12 の 18）。
// ★i18n の検査の一覧（m1201 の SCANNED）には入れない（日本語だけの開発用の画面）。
import { compositeFrame, presentToCanvas } from "../../editor/render";
import { allocIndexBuf, ensureColor, makeEmptyFrame, newLayerId, PIXELS, UGO_COLORS, W, H, type Project } from "../../editor/model";
import { strokeSegment, type PenOptions } from "../../editor/raster";
import { readWorkId } from "../../editor/saveCore";
import { candidatesFor, proposals, readStamp, type MobileWorkSession, type SaveOutcome } from "../../mobile/session";
import type { MobilePort, SessionEntry } from "../../mobile/port";
import { AutosaveClock } from "../autosaveClock";
import { watchLifecycle } from "../lifecycle";
import { newSession, openSession, readProject, restoreSession, timedPort, type OpsHooks, type Timing } from "../workOps";
import { prepareLibrary, refusalText, type BootResult } from "../app";
import { dev, pc, type DevState, type LibraryView, type RecoverableView } from "./devPort";

// ---------------- 小さな部品 ----------------

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k === "disabled") (el as HTMLButtonElement).disabled = Boolean(v);
    else if (k === "value") (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function btn(label: string, onclick: () => unknown, opts: { disabled?: boolean; id?: string; aria?: string } = {}): HTMLElement {
  // aria-label: 同じ字のボタンが並ぶ所（作品ごと・アルバムごと）で、外から名前で押せるように（シミュレーターの UI テスト）
  return h("button", { onclick: () => void run(onclick), disabled: opts.disabled, "data-id": opts.id ?? label, "aria-label": opts.aria }, label);
}

/** 押したときの失敗は画面の上に出す（文はそのまま出さない） */
async function run(f: () => unknown): Promise<void> {
  try {
    await f();
  } catch (e) {
    notice(`できなかった: ${refusalText(e) === "error" ? "（詳しくはログ）" : refusalText(e)}`);
  }
}

function fmtTime(ms: number | null): string {
  if (ms === null) return "（まだ）";
  const d = new Date(ms);
  return `${d.toLocaleTimeString("ja-JP", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

// ---------------- 状態 ----------------

let boot: BootResult;
let port: MobilePort;
let root: HTMLElement;
let devState: DevState = { testLibrary: false, faults: { noSpace: false, stopAt: "" } };
let libRoot = "";
let albums: string[] = [];
let works: LibraryView[] = [];
let recoverable: RecoverableView[] = [];
let entries: SessionEntry[] = [];
const thumbUrls = new Map<string, string>();

let session: MobileWorkSession | null = null;
let frame = 0;
let drawing: { last: { x: number; y: number } | null } | null = null;
let clock: AutosaveClock | null = null;
let lastSave: string = "";

/** 起動したときの提案の並び（新しい順）と、いま出している番号（null＝出さない） */
let proposalList: SessionEntry[] = [];
let proposalAt: number | null = null;
/** 作品を開くときに先に聞く（候補がある） */
let openAsk: { album: string; name: string; project: Project; rw: Awaited<ReturnType<typeof readProject>>["rw"]; cands: SessionEntry[] } | null = null;
/** 保存先を聞く（初めての保存・別名・指紋が違う・保存先が無い） */
let saveAsk: { kind: "first" | "saveAs" | "relocate"; why: string; album: string; name: string } | null = null;
/** 2 回押す確かめ（破棄・削除） */
let confirming: string | null = null;

const timings: string[] = [];
const life: string[] = [];
let noticeText = "";
let stallMax = 0;

function notice(s: string): void {
  noticeText = s;
  render();
}

function timing(t: Timing): void {
  timings.unshift(`${fmtTime(Date.now())} ${t.label} ${t.ms.toFixed(0)} ms`);
  timings.length = Math.min(timings.length, 40);
}

/** 記録（画面と Rust の lifecycle.log。決まった文だけ・作品名やパスを書かない） */
function lc(event: string): void {
  const line = `${new Date().toISOString()} ${event}`;
  life.unshift(line);
  life.length = Math.min(life.length, 300);
  void dev.log(line).catch(() => {});
}

function opsHooks(): OpsHooks {
  return {
    currentFrame: () => frame,
    timing,
    log: (line) => lc(`log ${line}`),
  };
}

// ---------------- 読み直し ----------------

async function refresh(): Promise<void> {
  devState = await dev.state();
  libRoot = await port.libraryRoot();
  albums = await pc.listAlbums(libRoot).catch(() => []);
  works = (await pc.scanLibrary(libRoot).catch(() => [])).filter((w) => w.kind === "project");
  recoverable = await pc.listRecoverable(libRoot).catch(() => []);
  entries = await port.autosaveList().catch(() => []);
  for (const u of thumbUrls.values()) URL.revokeObjectURL(u);
  thumbUrls.clear();
  for (const w of works) {
    if (!w.thumb_path) continue;
    try {
      const buf = await pc.readThumb(w.thumb_path);
      thumbUrls.set(`${w.album}/${w.name}`, URL.createObjectURL(new Blob([buf], { type: "image/png" })));
    } catch {
      /* サムネが無い・読めない */
    }
  }
  render();
}

/** ライブラリを開く: 作り終える・止まっていた保全を続ける（mobile_resume）→ 読み直す（ファイル App の変更も反映） */
async function openLibrary(): Promise<void> {
  const r = await prepareLibrary(port);
  lc(`library-open init=${"error" in r.init ? r.init.error : r.init.steps.join("+") || "none"} resume=${"error" in r.resumed ? r.resumed.error : r.resumed.map((x) => x.outcome).join("+") || "none"}`);
  bootLines = describeBoot(r.init, r.resumed);
  await refresh();
}

let bootLines: string[] = [];
function describeBoot(init: BootResult["init"], resumed: BootResult["resumed"]): string[] {
  return [
    `ライブラリ: ${"error" in init ? `できなかった（${init.error}）` : `${init.ready ? "作り終えている" : "まだ"}・この回にしたこと: ${init.steps.join("・") || "なし"}`}`,
    `保全の続き: ${"error" in resumed ? `できなかった（${resumed.error}）` : resumed.length === 0 ? "なし" : resumed.map((x) => `${x.album}/${x.name}→${x.outcome}`).join("、")}`,
  ];
}

// ---------------- 作品のセッション ----------------

function attach(s: MobileWorkSession): void {
  session = s;
  frame = Math.min(s.project.thumbFrame ?? 0, s.project.frames.length - 1);
  clock?.stop();
  clock = new AutosaveClock({
    busy: () => drawing !== null,
    finishStroke: () => {
      if (drawing) {
        drawing = null;
        lc("stroke-finished-by-suspend");
      }
    },
    write: async () => (session ? session.autosave() : "skipped"),
    onEvent: (ev, reason, result) => lc(ev === "begin" ? `autosave-begin reason=${reason}` : `autosave-end reason=${reason} result=${result}`),
  });
  if (s.dirty) clock.noteEdit();
  clock.start();
}

function edited(): void {
  session?.noteEdit();
  clock?.noteEdit();
}

async function closeSession(discard: boolean): Promise<void> {
  if (!session) return;
  const c = clock;
  if (discard) {
    clock = null;
    // ★先に時計を止める（消している間に 2 秒・15 秒・裏に回る知らせで書かれると、消したオートセーブが戻る＝第三者レビュー M1）
    c?.stop();
    await session.discard();
  } else {
    // ★書き切れなかったら閉じない（時計と作品を手放すと、書けなかった編集が消える＝V211b F1）
    if (c && !(await c.flushForClose())) return notice("オートセーブを書けなかったので閉じなかった。保存するか、もう一度閉じる");
    clock = null;
    c?.stop();
  }
  session = null;
  saveAsk = null;
  await refresh();
}

async function newMemo(): Promise<void> {
  if (session) return notice("先に作品を閉じる");
  attach(newSession(port, opsHooks()));
  lc("new-memo");
  render();
}

async function openWork(album: string, name: string): Promise<void> {
  if (session) return notice("先に作品を閉じる");
  const t0 = performance.now();
  const { rw, project } = await readProject(port, album, name, opsHooks());
  timing({ label: "開く（合計）", ms: performance.now() - t0 });
  entries = await port.autosaveList();
  const cands = candidatesFor(entries, { album: rw.album, name: rw.name, workId: readWorkId(project) });
  if (cands.length > 0) {
    openAsk = { album: rw.album, name: rw.name, project, rw, cands };
    render();
    return;
  }
  attach(openSession(port, project, rw, opsHooks()));
  lc("open-work");
  render();
}

async function restoreEntry(e: SessionEntry): Promise<void> {
  const t0 = performance.now();
  const s = await restoreSession(port, e, opsHooks());
  timing({ label: "復元（合計）", ms: performance.now() - t0 });
  if (!s) return notice("オートセーブが読めない");
  attach(s);
  lc("restore");
}

// ---------------- 保存 ----------------

/** 保存の間に画面が止まった最長（requestAnimationFrame の間隔で見る） */
async function withStallMeter<T>(f: () => Promise<T>): Promise<T> {
  let alive = true;
  let last = performance.now();
  stallMax = 0;
  const tick = () => {
    const t = performance.now();
    stallMax = Math.max(stallMax, t - last);
    last = t;
    if (alive) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    return await f();
  } finally {
    alive = false;
    stallMax = Math.max(stallMax, performance.now() - last);
    timing({ label: "保存の間に画面が止まった最長", ms: stallMax });
  }
}

async function doSave(req: Parameters<MobileWorkSession["save"]>[0]): Promise<void> {
  const s = session;
  if (!s) return;
  const e0 = clock?.currentEpoch() ?? 0;
  const t0 = performance.now();
  lc(`save-begin kind=${req.kind}`);
  // ★保存の便が終わって settledAt を呼ぶまで、オートセーブを書かない（保存が消したオートセーブを古い写しで書き戻さない＝第三者レビュー M2）
  const done = (async () => {
    const out = await s.save(req);
    if (out.ok && out.notice === "saved") clock?.settledAt(e0);
    return out;
  })();
  clock?.holdUntil(done);
  const r: SaveOutcome = await withStallMeter(() => done);
  timing({ label: `保存（合計・${req.kind}）`, ms: performance.now() - t0 });
  lc(`save-end ok=${r.ok}`);
  if (r.ok) {
    saveAsk = null;
    lastSave = `保存した: ${r.target.album}/${r.target.name}・版 ${r.rev}${r.notice === "savedPartial" ? "（途中で描き足した分はオートセーブ）" : ""}${r.keptCopies.length ? `・別の名前で残した ${r.keptCopies.length} 件` : ""}${r.oursMoved ? "・自分の分は別の名前" : ""}`;
    await refresh();
    return;
  }
  if ("needs" in r) {
    const sug = "suggest" in r ? r.suggest : null;
    const why =
      r.needs === "first" ? "まだ保存していない" : r.needs === "saveAs" ? "外で中身が変わった（指紋が違う）。別の名前で保存する" : `保存先を聞く（${r.reason}）`;
    saveAsk = {
      kind: r.needs === "first" ? "first" : r.needs === "saveAs" ? "saveAs" : "relocate",
      why,
      album: sug?.album ?? albums[0] ?? "",
      name: sug ? sug.name.replace(/\.(memoanima|animemo)$/i, "") : "",
    };
    render();
    return;
  }
  if ("refused" in r) return notice(`保存しなかった: ${r.refused}`);
  notice(`保存できなかった: ${r.stage}${r.reason && /^[a-z:-]+$/.test(r.reason) ? `（${r.reason}）` : "（詳しくはログ）"}`);
}

// ---------------- 描く ----------------

function penColor(p: Project): number {
  return ensureColor(p, UGO_COLORS.black);
}

function topLayerBuf(p: Project) {
  const f = p.frames[frame];
  const top = p.layerDefs[p.layerDefs.length - 1];
  return f.layers[top.id];
}

function pen(p: Project): PenOptions {
  return { size: 2, color: penColor(p), texture: "solid", seed: 0 };
}

/** そのコマの全レイヤーで、描いてある（0 でない）点の数 */
function inkCount(p: Project, f: number): number {
  let n = 0;
  const fr = p.frames[f];
  if (!fr) return 0;
  for (const b of Object.values(fr.layers)) for (let i = 0; i < b.length; i++) if (b[i] !== 0) n++;
  return n;
}

function drawCanvas(): void {
  const c = document.getElementById("cv") as HTMLCanvasElement | null;
  if (!c || !session) return;
  presentToCanvas(compositeFrame(session.project, frame), c);
}

function canvasPoint(c: HTMLCanvasElement, e: PointerEvent): { x: number; y: number } {
  const r = c.getBoundingClientRect();
  return { x: Math.round(((e.clientX - r.left) / r.width) * W), y: Math.round(((e.clientY - r.top) / r.height) * H) };
}

function wireCanvas(c: HTMLCanvasElement): void {
  c.addEventListener("pointerdown", (e) => {
    if (!session) return;
    c.setPointerCapture(e.pointerId);
    drawing = { last: canvasPoint(c, e) };
    edited();
    const p = session.project;
    const pt = drawing.last!;
    strokeSegment(topLayerBuf(p), pt.x, pt.y, pt.x, pt.y, pen(p));
    drawCanvas();
  });
  c.addEventListener("pointermove", (e) => {
    if (!session || !drawing?.last) return;
    const pt = canvasPoint(c, e);
    const p = session.project;
    strokeSegment(topLayerBuf(p), drawing.last.x, drawing.last.y, pt.x, pt.y, pen(p));
    drawing.last = pt;
    drawCanvas();
  });
  const end = () => {
    if (!drawing) return;
    drawing = null;
    clock?.strokeEnded();
    lc("stroke-end");
    render();
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
}

/** 印の中だけの「線を 1 本足す」（シミュレーターで手を使わずに回す） */
function addLine(): void {
  if (!session) return;
  const p = session.project;
  edited();
  const r = () => Math.floor(Math.random() * W);
  const y = () => Math.floor(Math.random() * H);
  strokeSegment(topLayerBuf(p), r(), y(), r(), y(), pen(p));
  clock?.strokeEnded();
  lc("line-added");
  render();
}

/** 大きい作品を作る（コマとレイヤーを増やす・中身は縮まないように乱れた点） */
function makeBig(framesWanted: number, layersWanted: number): void {
  if (!session) return;
  const p = session.project;
  while (p.layerDefs.length < layersWanted) {
    const id = newLayerId(p);
    p.layerDefs.push({ id, name: `L${p.layerDefs.length + 1}`, visible: true, opacity: 1 });
    for (const f of p.frames) f.layers[id] = allocIndexBuf(p);
  }
  const paper = p.frames[0]?.paper ?? 1;
  const colors = [penColor(p), ensureColor(p, UGO_COLORS.red), ensureColor(p, UGO_COLORS.blue)];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  while (p.frames.length < framesWanted) {
    const f = makeEmptyFrame(p, paper);
    for (const id of Object.keys(f.layers)) {
      const b = f.layers[id];
      for (let i = 0; i < PIXELS; i++) {
        const v = rnd();
        if ((v & 7) === 0) b[i] = colors[(v >>> 8) % colors.length];
      }
    }
    p.frames.push(f);
  }
  edited();
  clock?.strokeEnded();
  lc(`big-made frames=${p.frames.length} layers=${p.layerDefs.length}`);
}

// ---------------- 故障（試験用のライブラリだけ） ----------------

async function fillMemory(): Promise<void> {
  await dev.fault("memory", true); // 試験用のライブラリでなければ Rust が断る（ここで止まる）
  lc("memory-fill-begin");
  const hold: Uint8Array[] = [];
  for (;;) {
    const b = new Uint8Array(64 * 1024 * 1024);
    for (let i = 0; i < b.length; i += 4096) b[i] = 1;
    hold.push(b);
    if (hold.length % 4 === 0) lc(`memory-fill ${hold.length * 64} MiB`);
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------------- 画面 ----------------

function section(title: string, ...kids: Child[]): HTMLElement {
  return h("section", { style: "border-top:1px solid #ccc;padding:8px 0" }, h("h3", { style: "margin:4px 0;font-size:15px" }, title), ...kids);
}

function input(id: string, value: string, placeholder = "", aria?: string): HTMLInputElement {
  return h("input", { id, value, placeholder, "aria-label": aria, style: "width:12em;font-size:16px" }) as HTMLInputElement;
}

function val(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
}


function twoStep(key: string, label: string, act: () => Promise<void>, disabled = false, aria?: string): HTMLElement {
  if (disabled) return btn(label, () => {}, { disabled: true, id: key, aria });
  if (confirming === key)
    return h("span", {}, btn(`本当に${label}`, async () => {
      confirming = null;
      await act();
    }, { aria: aria ? `本当に${aria}` : undefined }), btn("やめる", () => {
      confirming = null;
      render();
    }));
  return btn(label, () => {
    confirming = key;
    render();
  }, { aria });
}

function render(): void {
  const s = session;
  const t = devState.testLibrary;
  root.replaceChildren(
    h("div", { style: "padding:calc(8px + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left));font:14px -apple-system,sans-serif" },
      h("h2", { style: "margin:4px 0;font-size:17px" }, "メモアニマ 確かめ画面（開発用）"),
      h("div", {}, `OS: ${boot.info.os}・版: ${boot.info.version}`),
      h("div", { style: t ? "color:#b00;font-weight:bold" : "" }, `ライブラリ: ${t ? "試験用（作者の作品は入っていない）" : "本物"}`),
      h("div", {}, ...bootLines.map((l) => h("div", { style: "font-size:12px;color:#555" }, l))),
      noticeText ? h("div", { style: "background:#ffd;padding:4px", "data-id": "notice" }, noticeText, " ", btn("消す", () => notice(""))) : null,
      // 提案（起動したとき・読み込み直したとき）
      proposalAt !== null && proposalList[proposalAt]
        ? section(`残っているオートセーブ（${proposalAt + 1}/${proposalList.length}・新しい順）`, proposalView(proposalList[proposalAt]))
        : null,
      openAsk ? section("この作品にはオートセーブが残っている", openAskView()) : null,
      section("ライブラリ",
        h("div", {},
          s ? null : btn(t ? "本物のライブラリに戻す" : "試験用のライブラリを開く", async () => {
            if (t) await dev.closeTestLibrary();
            else await dev.openTestLibrary();
            // 前のライブラリで聞いていたこと・提案は持ち越さない（第三者レビュー L2）
            openAsk = null;
            saveAsk = null;
            proposalList = [];
            proposalAt = null;
            lc(t ? "test-library-close" : "test-library-open");
            await openLibrary();
          }),
          btn("ライブラリを開き直す", () => openLibrary())),
        h("div", {}, input("newAlbum", "", "アルバムの名前"), btn("アルバムを作る", async () => {
          await port.createAlbum(val("newAlbum"));
          await refresh();
        })),
        ...albums.map((a) => albumView(a))),
      section("新規メモ・開いている作品", s ? editorView(s) : btn("新規メモ", newMemo)),
      section("オートセーブ（残っているもの）",
        h("div", {}, `最後に書いた時刻: ${fmtTime(clock?.lastWrittenAt ?? null)}・書いていない編集: ${clock?.pending() ? "ある" : "ない"}`),
        btn("提案を出す", () => {
          proposalList = proposals(entries);
          proposalAt = proposalList.length ? 0 : null;
          render();
        }),
        ...entries.map((e) => {
          const st = readStamp(e.meta);
          return h("div", { style: "font-size:12px" }, `${st.savedAt}・${st.target ? `${st.target.album}/${st.target.name}` : "まだ保存していない"}・版 ${st.baseRev}・${e.from}${s && s.session === e.session ? "（開いている）" : ""}`);
        })),
      section("復元の候補（控え）",
        ...recoverable.map((r) => h("div", { style: "font-size:12px" }, `${r.album}/${r.name}・控え ${r.bak_size} B・一時ファイル ${r.tmp_files.length}`, " ", btn("控えから戻す", async () => {
          await pc.recoverProject(libRoot, r.rel_path);
          await refresh();
        })))),
      section("故障を起こす（試験用のライブラリだけ）",
        h("div", {}, t ? "" : "試験用のライブラリを開くと押せる"),
        btn(`空きが無いふり: ${devState.faults.noSpace ? "入" : "切"}`, async () => {
          await dev.fault("no-space", !devState.faults.noSpace);
          await refresh();
        }, { disabled: !t, id: "fault-no-space" }),
        btn("次の保存を一時ファイルのあとで止める", async () => {
          await dev.fault("stop-after-temp", true);
          lc("fault-armed stop-after-temp");
          await refresh();
        }, { disabled: !t, id: "fault-stop-temp" }),
        btn("次の上書きを控えへ移したあとで止める", async () => {
          await dev.fault("stop-after-evac", true);
          lc("fault-armed stop-after-evac");
          await refresh();
        }, { disabled: !t, id: "fault-stop-evac" }),
        twoStep("memory", "メモリを使い切る", fillMemory, !t),
        h("div", { style: "font-size:12px" }, `止める: ${devState.faults.stopAt || "なし"}`)),
      section("時間", h("div", {}, lastSave), ...timings.slice(0, 20).map((x) => h("div", { style: "font-size:12px" }, x))),
      section("記録（送らない）",
        btn("記録を読み直す", async () => {
          const tail = await dev.logTail();
          (document.getElementById("lifelog") as HTMLTextAreaElement).value = tail.slice().reverse().join("\n");
        }),
        btn("記録をコピー", async () => {
          const ta = document.getElementById("lifelog") as HTMLTextAreaElement;
          ta.select();
          try {
            await navigator.clipboard.writeText(ta.value);
          } catch {
            document.execCommand("copy");
          }
        }),
        h("textarea", { id: "lifelog", readonly: "readonly", style: "width:100%;height:12em;font-size:11px;user-select:text;-webkit-user-select:text" }, life.join("\n")))
    )
  );
  const c = document.getElementById("cv") as HTMLCanvasElement | null;
  if (c) {
    wireCanvas(c);
    drawCanvas();
  }
}

function albumView(a: string): HTMLElement {
  const inAlbum = works.filter((w) => w.album === a);
  const key = `album:${a}`;
  return h("div", { style: "margin:6px 0;padding:4px;background:#f6f6f6" },
    h("div", {}, h("b", {}, a), ` （${inAlbum.length} 作品）`),
    h("div", {}, input(`ren-${key}`, "", "新しい名前", `アルバムの新しい名前:${a}`), btn("アルバムの名前を変える", async () => {
      await port.renameAlbum(a, val(`ren-${key}`));
      await refresh();
    }, { aria: `アルバムの名前を変える:${a}` }), twoStep(key, "アルバムを削除", async () => {
      await pc.deleteAlbum(libRoot, a);
      await refresh();
    }, false, `アルバムを削除:${a}`)),
    ...inAlbum.map((w) => workView(w)));
}

function workView(w: LibraryView): HTMLElement {
  const key = `${w.album}/${w.name}`;
  const url = thumbUrls.get(key);
  return h("div", { style: "display:flex;gap:6px;align-items:center;margin:4px 0" },
    url ? h("img", { src: url, style: "width:80px;height:60px;image-rendering:pixelated;border:1px solid #999" }) : h("div", { style: "width:80px;height:60px;border:1px dashed #999;font-size:10px" }, "サムネなし"),
    h("div", {},
      h("div", {}, `${w.name}（${w.size} B）`),
      btn("開く", () => openWork(w.album, w.name), { disabled: !!session, aria: `開く:${key}` }),
      input(`wren-${key}`, "", "新しい名前", `作品の新しい名前:${key}`),
      btn("名前を変える", async () => {
        await port.renameWork(w.album, w.name, val(`wren-${key}`));
        await refresh();
      }, { aria: `名前を変える:${key}` }),
      // 移す先はアルバムごとのボタン（選ぶ部品より外から押しやすい）
      ...albums.filter((a) => a !== w.album).map((a) =>
        btn(`→${a}へ移す`, async () => {
          await port.moveWork(w.album, w.name, a);
          await refresh();
        }, { aria: `移す:${key}→${a}` })),
      twoStep(`work:${key}`, "削除", async () => {
        await pc.deleteNote(libRoot, w.album, w.name);
        await refresh();
      }, false, `削除:${key}`)));
}

function editorView(s: MobileWorkSession): HTMLElement {
  const p = s.project;
  return h("div", {},
    h("div", {}, `保存先: ${s.target ? `${s.target.album}/${s.target.name}` : "まだ保存していない"}・版 ${s.baseRev}・保存していない編集: ${s.dirty ? "ある" : "ない"}`),
    // 復元したときに線が戻ったかを数で見る（このコマの全レイヤーの描いてある点の数・コマ数）
    h("div", { "data-id": "ink" }, `このコマの点: ${inkCount(p, frame)}・コマ数: ${p.frames.length}`),
    h("canvas", { id: "cv", width: W, height: H, style: "width:100%;max-width:640px;image-rendering:pixelated;border:1px solid #333;touch-action:none;display:block" }),
    h("div", {},
      btn("前のコマ", () => {
        frame = Math.max(0, frame - 1);
        render();
      }),
      ` コマ ${frame + 1}/${p.frames.length} `,
      btn("次のコマ", () => {
        frame = Math.min(p.frames.length - 1, frame + 1);
        render();
      }),
      btn("コマを足す", () => {
        p.frames.splice(frame + 1, 0, makeEmptyFrame(p, p.frames[frame].paper));
        frame++;
        edited();
        clock?.strokeEnded();
        render();
      }),
      btn("線を1本足す", addLine, { id: "add-line" })),
    h("div", {},
      btn("保存", () => doSave({ kind: "overwrite" }), { id: "save" }),
      btn("別名で保存", () => {
        saveAsk = { kind: "saveAs", why: "別名で保存", album: s.target?.album ?? albums[0] ?? "", name: "" };
        render();
      }),
      twoStep("discard", "保存しないで戻る", () => closeSession(true)),
      btn("閉じる（オートセーブは残す）", () => closeSession(false))),
    saveAsk
      ? h("div", { style: "background:#eef;padding:4px" },
          h("div", {}, saveAsk.why),
          input("saveAlbum", saveAsk.album, "アルバム", "保存先のアルバム"),
          input("saveName", saveAsk.name, "名前", "保存先の名前"),
          btn(saveAsk.kind === "first" ? "初めての保存" : saveAsk.kind === "saveAs" ? "この名前で保存" : "ここへ保存", () =>
            doSave({ kind: saveAsk!.kind, album: val("saveAlbum"), name: val("saveName") })),
          btn("やめる", () => {
            saveAsk = null;
            render();
          }))
      : null,
    h("div", {},
      input("bigFrames", "200", "コマ"),
      input("bigLayers", "3", "レイヤー"),
      btn("大きい作品を作る", () => {
        // 打ち間違いで端末のメモリを使い切らないように上限を置く（メモリを使い切るのは別のボタン＝試験用のライブラリだけ）
        makeBig(Math.min(3000, Math.max(1, Number(val("bigFrames")) || 1)), Math.min(16, Math.max(1, Number(val("bigLayers")) || 1)));
        render();
      })));
}

function proposalView(e: SessionEntry): HTMLElement {
  const st = readStamp(e.meta);
  const next = () => {
    proposalAt = proposalAt !== null && proposalAt + 1 < proposalList.length ? proposalAt + 1 : null;
    render();
  };
  return h("div", {},
    h("div", {}, `${String(e.meta.title ?? "")}・${st.target ? `${st.target.album}/${st.target.name}` : "まだ保存していない"}・${st.savedAt}`),
    btn("復元して開く", async () => {
      if (session) return notice("先に作品を閉じる");
      // ★復元して開いたら、残りは次に起動したときに出す（§4-4 の 8）
      proposalAt = null;
      await restoreEntry(e);
      await refresh();
    }, { id: "proposal-restore" }),
    btn("あとで", () => {
      lc("proposal-later");
      next();
    }, { id: "proposal-later" }),
    twoStep(`drop:${e.session}`, "破棄する", async () => {
      await port.autosaveDelete(e.session, await port.autosaveNextGen());
      lc("proposal-discard");
      proposalList.splice(proposalAt!, 1);
      if (proposalAt! >= proposalList.length) proposalAt = proposalList.length ? proposalList.length - 1 : null;
      await refresh();
    }));
}

function openAskView(): HTMLElement {
  const a = openAsk!;
  return h("div", {},
    ...a.cands.map((c) => {
      const st = readStamp(c.meta);
      return h("div", {}, `${st.savedAt}・版 ${st.baseRev}`, " ", btn("これを復元して開く", async () => {
        openAsk = null;
        await restoreEntry(c);
        await refresh();
      }, { aria: `これを復元して開く:${a.cands.indexOf(c) + 1}` }));
    }),
    btn("保存した版を開く（候補は残す）", () => {
      attach(openSession(port, a.project, a.rw, opsHooks()));
      openAsk = null;
      lc("open-work-saved-version");
      render();
    }),
    btn("やめる", () => {
      openAsk = null;
      render();
    }));
}

// ---------------- 入口 ----------------

export async function startDevcheck(el: HTMLElement, b: BootResult): Promise<void> {
  boot = b;
  root = el;
  port = timedPort(b.port, timing);
  // 長押しのメニュー・文字の選択・ダブルタップの拡大を止める（キャンバスは touch-action:none）
  const st = document.createElement("style");
  st.textContent = "body{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;touch-action:manipulation}button,select,input{font-size:15px;margin:2px;touch-action:manipulation}";
  document.head.append(st);
  bootLines = describeBoot(b.init, b.resumed);
  lc(`start os=${b.info.os}`);
  await watchLifecycle({
    suspend: (from) => {
      lc(`suspended from=${from}`);
      if (clock) void clock.suspend();
    },
    resume: (from) => {
      lc(`resumed from=${from}`);
      // 戻ったら、ライブラリを開き直す（止まっていた保全を続け・ファイル App での変更を読み直す）
      void openLibrary().catch(() => {});
    },
  });
  await refresh();
  // ★起動したとき（WebView が読み込み直されたときも）: 残っているオートセーブを新しい順に 1 つずつ提案する
  proposalList = proposals(entries);
  proposalAt = proposalList.length ? 0 : null;
  render();
}
