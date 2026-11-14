// V225 (M-2c・指示書 ■2 の B-5): 確かめ画面の印のビルドだけの道具（7 言語の数え・描き直しの数・倍率と大きさを替える口・
// 本物のタッチの記録・合成のキーとホイール）。仮の一覧（devlist/devList.ts・V221〜V224）から移した。
//
// ★印の無いビルドには入らない（確かめ画面〔devcheck/screen.ts〕だけが読み込み、ライブラリへは口〔editorOpened〕で渡す）。
// ★開発用（日本語の直書き・見た目は問わない）。i18n の検査 5 は devcheck/ を名指しで外している。
// ★記録には作品名・パス・作品の中身を書かない（W-10）。
import type { WorkScreen } from "../editor/workScreen";
import { mbDevSetScreen } from "../editor/mobileEditor";
import { currentScreen, libraryDebug, libraryDev } from "../library/libraryScreen";
import { setScreenOverride } from "../view/screen";
import { hitLines, measureHits } from "./hitSize";

export interface DevToolsDeps {
  log(line: string): void;
}
let deps: DevToolsDeps = { log: () => undefined };

/** 描く画面を開いたときに付ける（確かめ画面がライブラリの editorOpened に渡す） */
export function attachDevTools(sc: WorkScreen, d: DevToolsDeps): void {
  deps = d;
  devRepaintMeter(sc);
}

/** ライブラリの今を記録へ（部品の矩形・倍率・描き直しの数） */
export function logLibrary(d: DevToolsDeps): void {
  const parts = libraryDebug().split(" ");
  for (let i = 0; i < parts.length; i += 3) d.log(`[V225 dev] library ${parts.slice(i, i + 3).join(" ")}`);
}

/** ライブラリに付ける小さな開発用のボタン（7 言語の数え・端末の大きさの表）。確かめ画面がライブラリを開いたあとに呼ぶ */
export function attachLibraryDev(d: DevToolsDeps): void {
  (window as unknown as { __mbHits?: (min?: number) => string[] }).__mbHits = (min) => devHits(d, min);
  // ★V226 (T-3): 倍率の表を外（CDP・debug のビルド）から読む口（今の部品の矩形と倍率・はみ出しの数え）。値は数だけ（名前を返さない）
  (window as unknown as { __mbDev?: unknown }).__mbDev = {
    lib: () => libraryDebug(),
    ed: () => {
      const sc = currentScreen();
      return sc ? `win=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} ${sc.editor.mbDebugLayout()}` : "none";
    },
    overflow: (sel: string) => countOverflow(sel).length,
  };
  document.getElementById("v225-libdev")?.remove();
  const box = document.createElement("div");
  box.id = "v225-libdev";
  box.setAttribute("style", "position:fixed;left:60px;top:0;display:flex;gap:2px;z-index:60;opacity:.5");
  const add = (name: string, act: () => void) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.ariaLabel = `v225-${name}`;
    b.setAttribute("data-own-input", "");
    b.setAttribute("style", "font:9px monospace;padding:2px;margin:0");
    b.addEventListener("click", act);
    box.append(b);
  };
  // ★V226 (H-1): 押せるものの当たりを数える（今の画面に見えているもの全部・48dp に足りないものを記録へ）
  add("hits", () => devHits(d));
  add("liblangs", () => void devLibrarySweep(d));
  add("libsizes", () => void devLibrarySizes(d));
  document.body.append(box);
}

/** ★V226 (H-1): 今の画面の押せるものの当たりを数えて記録へ（種類と大きさだけ・名前は書かない）。外（CDP）からも呼べるように口を置く */
export function devHits(d: DevToolsDeps, min = 48): string[] {
  // 開発用のボタン（画面の上と下に重なる小さい箱）は、数える間だけ隠す（印なしのビルドには無い）
  const dev = [...document.querySelectorAll('[id^="v221-"], [id^="v222-"], [id^="v225-"], [id^="v226-"]')] as HTMLElement[];
  const shown = dev.map((e) => e.style.display);
  dev.forEach((e) => (e.style.display = "none"));
  const lines = hitLines(measureHits(document.body, min));
  dev.forEach((e, i) => (e.style.display = shown[i]));
  for (const l of lines) d.log(`[V226 dev] hits ${l}`.slice(0, 180));
  doneTag("v226-hits-done", lines[0]);
  return lines;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));
/** 部品が動き終わるまで（screens.css の 0.32 秒） */
const settled = () => new Promise((r) => setTimeout(r, 420));

/** 文字が切れた・はみ出した要素を数える（送れる入れ物は外す） */
function countOverflow(sel: string): string[] {
  const items: string[] = [];
  const SCROLLERS = ["mb-set-navbox", "mb-lib-albumrows", "mb-lib-grid", "mb-set-body", "mb-lib-pop", "mb-lib-shelfbody"];
  document.querySelectorAll(sel).forEach((el) => {
    const e = el as HTMLElement;
    if (e.tagName === "svg" || e.closest("svg") || e.tagName === "INPUT" || e.tagName === "CANVAS") return;
    const st = getComputedStyle(e);
    if (st.overflowY === "auto" || st.overflowY === "scroll" || st.overflowX === "auto" || SCROLLERS.some((c) => e.classList.contains(c))) return;
    if (st.textOverflow === "ellipsis" && (e.classList.contains("mb-lib-name") || e.parentElement?.classList.contains("mb-lib-cardname") || e.classList.contains("mb-lib-albumname"))) return; // 作品とアルバムの名前は … で切る（利用者の字）
    if (e.classList.contains("mb-lib-chips")) return; // 2 段の形の札は、入るだけ出す
    const ow = e.scrollWidth - e.clientWidth;
    if (ow > 1 && e.clientWidth > 0) items.push(`${String(e.className).split(" ")[0] || `${String(e.parentElement?.className ?? "").split(" ")[0]}>${e.tagName.toLowerCase()}`}:w+${ow}`);
  });
  return items;
}

function doneTag(name: string, text: string): void {
  document.getElementById(name)?.remove();
  const done = document.createElement("div");
  done.id = name;
  done.ariaLabel = `${name} ${text}`;
  done.textContent = text;
  done.setAttribute("style", "position:fixed;left:200px;top:2px;font:10px monospace;z-index:60;opacity:.6;pointer-events:none");
  document.body.append(done);
}

/** 7 言語の数え（ライブラリ: 出した形・たたんだ形・浮かぶもの 3 つ／設定: ライブラリから開いた区分の全部） */
async function devLibrarySweep(d: DevToolsDeps): Promise<void> {
  const { LANGS, setLang, getLang } = await import("../../i18n");
  const { sectionsFor, sectionEnabled } = await import("../settings/model");
  const lib = libraryDev();
  const lang0 = getLang();
  const lines: string[] = [];
  for (const l of LANGS) {
    setLang(l);
    const res: [string, string[]][] = [];
    lib.rebuild();
    for (const f of [false, true]) {
      lib.fold(f);
      await settled();
      res.push([f ? "folded" : "open", countOverflow(".mb-lib *")]);
      for (const p of f ? (["albums", "sort"] as const) : (["move", "more", "sort"] as const)) {
        lib.pop(p);
        await nextFrame();
        res.push([`${f ? "folded-" : ""}pop-${p}`, countOverflow(".mb-lib-pop, .mb-lib-pop *")]);
        lib.pop(null);
      }
    }
    lib.fold(false);
    const st = lib.settings();
    await nextFrame();
    for (const sec of sectionsFor("library")) {
      if (!sectionEnabled(sec)) continue;
      st?.show(sec);
      await nextFrame();
      res.push([`set-${sec}`, countOverflow("#mb-screens *")]);
    }
    lib.closeSettings();
    await nextFrame();
    const total = res.reduce((a, r) => a + r[1].length, 0);
    lines.push(`${l}:${total}`);
    d.log(`[V225 dev] liblangs ${l} total=${total} states=${res.length}`);
    for (const [state, items] of res) for (const it of items) d.log(`[V225 dev] liblangs ${l} ${state} ${it}`.slice(0, 180));
  }
  setLang(lang0);
  lib.rebuild();
  doneTag("v225-liblangs-done", lines.join(" "));
}

/** 端末の大きさの表（■4 の表）: 大きさを差し替えて、倍率・段・部品の矩形を記録へ */
async function devLibrarySizes(d: DevToolsDeps): Promise<void> {
  const lib = libraryDev();
  const SIZES: [string, number, number][] = [
    ["pro11", 1194, 834], ["pro11p", 834, 1194], ["air11", 1180, 820], ["air11p", 820, 1180], ["gen9", 1080, 810], ["gen9p", 810, 1080],
    ["mini", 1133, 744], ["minip", 744, 1133], ["pro13", 1366, 1024], ["pro13p", 1024, 1366],
  ];
  const out: string[] = [];
  for (const [name, w, hh] of SIZES) {
    for (const f of [false, true]) {
      setScreenOverride({ w, h: hh });
      const r = lib.root();
      if (r) Object.assign(r.style, { right: "auto", bottom: "auto", width: `${w}px`, height: `${hh}px` });
      lib.fold(f);
      window.dispatchEvent(new Event("resize"));
      await settled();
      const over = countOverflow(".mb-lib *");
      const dbg = libraryDebug().split(" ").filter((p) => /^(shape|folded|tight|scale|rows|albums|preview|ops|shelf)=/.test(p)).join(" ");
      d.log(`[V225 dev] libsizes ${name} ${dbg} over=${over.length}`.slice(0, 240));
      for (const it of over) d.log(`[V225 dev] libsizes ${name} f=${f ? 1 : 0} ${it}`.slice(0, 160));
      out.push(`${name}${f ? "f" : ""}:${over.length}`);
    }
  }
  setScreenOverride(null);
  const r = lib.root();
  if (r) Object.assign(r.style, { right: "", bottom: "", width: "", height: "" });
  lib.fold(false);
  window.dispatchEvent(new Event("resize"));
  doneTag("v225-libsizes-done", out.join(" "));
}

/** 確かめ画面の印のビルドだけ: 7 言語の数え（■6・C9）。言語ごとに画面を組み直し、主な状態と確認（初めての保存・戻るときの確認・
 *  起動したときの提案）で、文字が切れた・はみ出した要素と横スクロールを数えてログへ（v221-langs の札で終わりを知らせる） */
async function devLangSweep(sc: WorkScreen): Promise<void> {
  const { LANGS, setLang, getLang, t: tt } = await import("../../i18n");
  const { askSaveTarget, askLeave } = await import("../ui/saveDialog");
  const lang0 = getLang();
  const lines: string[] = [];
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  const countLayer = (state: string, sel = "#mb-layer *") => {
    const items: string[] = [];
    document.querySelectorAll(sel).forEach((el) => {
      const e = el as HTMLElement;
      if (e.tagName === "svg" || e.closest("svg")) return;
      const ow = e.scrollWidth - e.clientWidth;
      if (ow > 1 && e.clientWidth > 0 && !e.classList.contains("mb-albums") && !e.classList.contains("mb-set-navbox")) {
        const right = e.getBoundingClientRect().right;
        const kid = [...e.querySelectorAll("*")].find((k) => k.getBoundingClientRect().right > right + 1) as HTMLElement | undefined;
        items.push(`${String(e.className).split(" ")[0]}:w+${ow}<${kid ? `${kid.tagName.toLowerCase()}.${String(kid.className).split(" ")[0]}` : "?"}`);
      }
    });
    return { state, n: items.length, items };
  };
  const cancel = () => {
    const bs = [...document.querySelectorAll("#mb-layer .mb-dlg-btn")] as HTMLElement[];
    const b = bs.find((x) => !x.classList.contains("mb-go") && !x.classList.contains("mb-warn")) ?? bs[bs.length - 1];
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  };
  for (const l of LANGS) {
    setLang(l);
    sc.editor.mbDevRebuild();
    await frame();
    const res = sc.editor.mbDevOverflow();
    void askSaveTarget({ mode: "first", name: tt("lib.newNote.name.label", { stamp: "20261108-1200" }), album: "A", albums: ["A", "B"], fromLeave: true, msgKey: null, createAlbum: async () => null, taken: () => false });
    await frame();
    res.push(countLayer("save-first"));
    cancel();
    await frame();
    void askLeave();
    await frame();
    res.push(countLayer("leave"));
    cancel();
    await frame();
    // ★V223 (■6): 名前を変える島・まとめて足す・ゆらゆらの小窓
    for (const k of ["rename", "addFrames", "wobble"] as const) {
      sc.editor.mbDevAsk(k);
      await frame();
      res.push(countLayer(k));
      cancel();
      await frame();
    }
    // ★V225 (■6): 設定の画面（描く画面から開いた 4 区分）。言語ごとに開き直して、区分ごとに数える
    sc.openSettings();
    await frame();
    for (const sec of ["display", "feel", "gesture", "confirm"] as const) {
      sc.settingsHandle()?.show(sec);
      await frame();
      res.push(countLayer(`set-${sec}`, "#mb-screens *"));
    }
    sc.closeSettings();
    await frame();
    const total = res.reduce((a, r) => a + r.n, 0);
    lines.push(`${l}:${total}`);
    deps.log(`[V221 dev] langs ${l} total=${total}`);
    for (const r of res) for (const it of r.items) deps.log(`[V221 dev] langs ${l} ${r.state} ${it}`.slice(0, 180));
  }
  setLang(lang0);
  sc.editor.mbDevRebuild();
  const done = document.createElement("div");
  done.ariaLabel = `v221-langs-done ${lines.join(" ")}`;
  done.textContent = lines.join(" ");
  done.setAttribute("style", "position:fixed;left:4px;top:2px;font:10px monospace;z-index:60;opacity:.6");
  document.body.append(done);
}

/** 確かめ画面の印のビルドだけ: 描き直しの数（絵・重ねる層）。UI テストが読む（aria-label） */
function devRepaintMeter(sc: WorkScreen): void {
  const el = document.createElement("div");
  el.id = "v221-repaints";
  el.setAttribute("style", "position:fixed;right:4px;top:2px;font:10px monospace;opacity:.6;pointer-events:none;z-index:60");
  document.body.append(el);
  // 倍率の写し（■6）: ×8・×12.5・×32・90°・元へ（小さな開発用のボタン・印のビルドだけ）
  const zb = document.createElement("div");
  zb.id = "v221-devbar"; // ★V226: 当たりを数える間は隠す（下の帯の上に重なる）
  zb.className = "mb-ui"; // 描く画面の振り分け層が ui として通す（描かない）
  // ★V222: 下の帯のホームバーの空き（下 20）に置く（縦のファイルの島と重ねない）
  zb.setAttribute("style", "position:fixed;left:120px;bottom:1px;display:flex;gap:2px;z-index:60;opacity:.5");
  const lb = document.createElement("button");
  lb.textContent = "langs";
  lb.ariaLabel = "v221-langs";
  lb.setAttribute("style", "font:9px monospace;padding:2px;margin:0");
  lb.addEventListener("click", () => void devLangSweep(sc));
  zb.append(lb);
  // 言語を切り替える（es の写し・■6）
  for (const lang of ["ja", "es"] as const) {
    const b = document.createElement("button");
    b.textContent = lang;
    b.ariaLabel = `v221-lang-${lang}`;
    b.setAttribute("style", "font:9px monospace;padding:2px;margin:0");
    b.addEventListener("click", () =>
      void import("../../i18n").then(({ setLang }) => {
        setLang(lang);
        sc.editor.mbDevRebuild();
      })
    );
    zb.append(b);
  }
  for (const [lab, sc, rot] of [["z8", 8, 0], ["z12", 12.5, 0], ["z32", 32, 0], ["r90", 3, 90], ["z0", 3, 0]] as const) {
    const b = document.createElement("button");
    b.textContent = lab;
    b.ariaLabel = `v221-${lab}`;
    b.setAttribute("style", "font:9px monospace;padding:2px;margin:0");
    b.addEventListener("click", () => sc && sc > 0 && currentScreen()?.editor.mbDevZoom(sc, rot));
    zb.append(b);
  }
  // ★V222 (■6): 部品の矩形を記録へ書く（UI テストが名前で探すと止まるので、記録から読む）と、描く画面が読む大きさを替える（区分の切り替え・案内）
  const lay = document.createElement("button");
  lay.textContent = "lay";
  lay.ariaLabel = "v222-lay";
  lay.setAttribute("style", "font:9px monospace;padding:2px;margin:0");
  lay.addEventListener("click", () => {
    // 記録の 1 行は短く切られるので、部品ごとに分けて書く
    const parts = `win=${window.innerWidth}x${window.innerHeight} ${sc.editor.mbDebugLayout()}`.split(" ");
    for (let i = 0; i < parts.length; i += 3) deps.log(`[V222 dev] layout ${parts.slice(i, i + 3).join(" ")}`);
  });
  zb.append(lay);
  for (const [lab, w, hh] of [["s743", 743, 1133], ["s790", 790, 834], ["s560", 560, 800], ["s1000", 1000, 480], ["k810", 1080, 810], ["k744", 1133, 744], ["k730", 1194, 730], ["k720", 1194, 720], ["s0", 0, 0]] as const) {
    const b = document.createElement("button");
    b.textContent = lab;
    b.ariaLabel = `v222-${lab}`;
    b.setAttribute("style", "font:9px monospace;padding:2px;margin:0");
    b.addEventListener("click", () => mbDevSetScreen(w || null, hh || null));
    zb.append(b);
  }
  // ★V225 (■6・C16): キーボードとホイールのつなぎを WebKit の中で見る（★合成の出来事＝本物のキーではない。本物のキーボードとトラックパッドは
  //  協力者の iPad で見る）。1 つずつ送って、そのあとのツール・再生・倍率を記録へ
  const synth = document.createElement("button");
  synth.textContent = "keys";
  synth.ariaLabel = "v225-keys";
  synth.setAttribute("style", "font:9px monospace;padding:2px;margin:0");
  synth.addEventListener("click", () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const key = (type: string, code: string, k: string, o: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent(type, { code, key: k, bubbles: true, cancelable: true, ...o }));
    const tap = async (code: string, k: string, o: KeyboardEventInit = {}, hold = 30) => {
      key("keydown", code, k, o);
      await wait(hold);
      key("keyup", code, k, o);
      await wait(120);
      deps.log(`[V225 dev] synth ${code}${o.metaKey ? "+meta" : ""}${o.shiftKey ? "+shift" : ""} tool=${sc.editor.mbDevTool()} ${sc.editor.mbDevKeyState()} settings=${sc.settingsShown() ? 1 : 0}`);
    };
    void (async () => {
      await tap("KeyB", "b");
      await tap("KeyE", "e");
      await tap("KeyH", "h");
      await tap("KeyP", "p");
      await tap("BracketRight", "]");
      await tap("BracketLeft", "[");
      await tap("Space", " ");
      await tap("Space", " ");
      await tap("Space", " ", {}, 400);
      await tap("Equal", "=", { metaKey: true });
      await wait(300);
      await tap("Minus", "-", { metaKey: true });
      await wait(300);
      await tap("Comma", ",", { metaKey: true });
      await tap("KeyB", "b");
      await tap("Escape", "Escape");
      await tap("KeyB", "b");
      // ホイール: ⌘（Ctrl）＋スクロールで拡大 → 0.22 秒で寄る → 2 本指のスクロールで動かす → 寄る
      const cv = document.querySelector(".mb-stage") as HTMLElement;
      const wheel = (o: WheelEventInit) => cv.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 600, clientY: 380, ...o }));
      for (let i = 0; i < 6; i++) wheel({ ctrlKey: true, deltaY: -10 });
      deps.log(`[V225 dev] synth wheel-zoom live ${sc.editor.mbDevKeyState()}`);
      await wait(500);
      deps.log(`[V225 dev] synth wheel-zoom settled ${sc.editor.mbDevKeyState()}`);
      for (let i = 0; i < 4; i++) wheel({ deltaX: 20, deltaY: 30 });
      await wait(500);
      deps.log(`[V225 dev] synth wheel-pan settled ${sc.editor.mbDevKeyState()}`);
      for (let i = 0; i < 12; i++) wheel({ ctrlKey: true, deltaY: 30 });
      await wait(500);
      deps.log(`[V225 dev] synth wheel-out settled ${sc.editor.mbDevKeyState()}`);
      for (let i = 0; i < 4; i++) wheel({ deltaX: 20, deltaY: 30 });
      await wait(500);
      deps.log(`[V225 dev] synth wheel-pan-at-fit ${sc.editor.mbDevKeyState()}`);
      const done = document.createElement("div");
      done.ariaLabel = "v225-keys-done";
      done.setAttribute("style", "position:fixed;left:4px;top:14px;font:10px monospace;z-index:60;opacity:.6");
      done.textContent = "keys-done";
      document.body.append(done);
    })();
  });
  zb.append(synth);
  document.body.append(zb);
  // ★V223 (■6): 本物のタッチの記録（1 回の接触ごとに、出来事の数と列・取り上げられたか・入れ物の送りを記録へ 1 行。作品の中身は書かない）
  const ptr = new Map<number, { seq: string; n: Record<string, number>; x0: number; y0: number }>();
  const onPtr = (e: PointerEvent) => {
    const k = e.type === "pointerdown" ? "d" : e.type === "pointermove" ? "m" : e.type === "pointerup" ? "u" : "c";
    let r = ptr.get(e.pointerId);
    if (k === "d" || !r) {
      r = { seq: "", n: { d: 0, m: 0, u: 0, c: 0 }, x0: Math.round(e.clientX), y0: Math.round(e.clientY) };
      ptr.set(e.pointerId, r);
    }
    r.n[k]++;
    if (r.seq.length < 40 && !(k === "m" && r.seq.endsWith("mmm"))) r.seq += k;
    if (k !== "u" && k !== "c") return;
    ptr.delete(e.pointerId);
    const line = `ptr down=${r.x0},${r.y0} end=${Math.round(e.clientX)},${Math.round(e.clientY)} d=${r.n.d} m=${r.n.m} u=${r.n.u} cancel=${r.n.c} seq=${r.seq}`;
    setTimeout(() => {
      if (currentScreen() !== sc) return;
      deps.log(`[V223 dev] ${line}`);
      deps.log(`[V223 dev] after ${sc.editor.mbDebugTouch()}`);
    }, 900);
  };
  for (const ty of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) window.addEventListener(ty, onPtr as EventListener, true);
  // ★V225 (■6・C16): ハードウェアキーボードの記録（どの code で来たか・修飾キー。打った字そのものは決まった英数字と記号だけ）と、
  //  ペンのダブルタップの受け口が付いているか
  const onKey = (e: KeyboardEvent) => {
    if (e.type !== "keydown") return;
    // 入力欄（名前の欄など）に打っている間は書かない（打った字＝作品名が記録に残る＝W-10）
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.isContentEditable)) return;
    const safe = (x: string) => (/^[A-Za-z0-9]{1,20}$/.test(x) ? x : x.length === 1 ? `U${x.charCodeAt(0).toString(16)}` : "other");
    deps.log(`[V225 dev] key code=${safe(e.code)} key=${safe(e.key)} c=${e.ctrlKey ? 1 : 0} m=${e.metaKey ? 1 : 0} s=${e.shiftKey ? 1 : 0} a=${e.altKey ? 1 : 0} rep=${e.repeat ? 1 : 0} tool=${sc.editor.mbDevTool()}`);
  };
  window.addEventListener("keydown", onKey, true);
  deps.log(`[V225 dev] pencil-attached=${sc.editor.mbPencilAttached() ? 1 : 0}`);
  const tick = () => {
    if (currentScreen() !== sc) {
      window.removeEventListener("keydown", onKey, true);
      el.remove();
      zb.remove();
      for (const ty of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) window.removeEventListener(ty, onPtr as EventListener, true);
      return;
    }
    const st = sc.editor.mbStats;
    el.textContent = `r${st.repaints} o${st.overlayPaints}`;
    el.ariaLabel = `v221-repaints ${st.repaints} ${st.overlayPaints} win=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} ${sc.editor.mbDebugLayout()}`;
    setTimeout(tick, 500);
  };
  tick();
}
