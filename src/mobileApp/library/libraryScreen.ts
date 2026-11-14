// V225 (M-2c・UI §6・指示書 ■2 の部B・■3 の L): モバイルのライブラリの画面（起動するとここ＝PC と同じ）。
//
// ★置き方・倍率・並び順・検索・選択の持ち越しは rules.ts（画面を持たない）。再生は preview.ts（PC の段取りの写し）。ここは並べて、つなぐだけ。
// ★一覧は port.libraryList()（Rust が場所を決める・JS はパスを持たない）。外で変わったかは port.libraryStamp() を、前に出てきたときと
//  描く画面から戻ったときに見て、変わっていれば取り直す（L-2）。
// ★流れ（起動したときの提案・開く前に聞く・「開いています」・開けなかったときの確認・描く画面を開く／閉じる）は、仮の一覧
//  （devlist/devList.ts・V221〜V224）の呼ぶ口と順をそのまま移した（L-10）。文と形だけ替えた。
// ★作品を消しても、オートセーブは消さない（M-1 §4-4 の 6）。消す道（autosaveDelete）は、起動の提案の［破棄する］の 1 か所だけ（今までと同じ）。
// ★まだ使えないボタン（取り込む・書き出し・投稿・ギャラリー）は押せない札（押すと「これからの版で」）。
// ★押すのは ui/globalInput.ts（離したときに押したことにする）。長押しと運ぶ・送るは ui/tap.ts の部品（V223 の F-1）。pointerType を読まない。
// ★色は変数だけ（screens.css）。画面の大きさは view/screen.ts の 1 か所から。
import type { MobilePort, SessionEntry, LibraryWork, RecoverableItem } from "../../mobile/port";
import { isRefusal } from "../../mobile/port";
import { candidatesFor, proposals, readStamp, type MobileWorkSession } from "../../mobile/session";
import { readWorkId } from "../../editor/saveCore";
import { isAllocFailure } from "../../editor/prefs";
import { formatSize } from "../../editor/core/formatBytes";
import { frameToPngBlob } from "../../editor/render";
import type { Project } from "../../editor/model";
import { getLang, t } from "../../i18n";
import { mt } from "../i18n";
import { newSession, openSession, readProject, restoreSession, type OpsHooks, type SessionWire } from "../workOps";
import { WorkScreen } from "../editor/workScreen";
import { watchLifecycle } from "../lifecycle";
import { closeTopDialog, dialogOpen, openDialog, setDialogLayer, toast } from "../ui/dialogs";
import { askName } from "../ui/nameDialog";
import { registerBack } from "../android/backButton";
import { libraryBack, makeEditorBack } from "../android/backRules";
import { bindAct, btn, h, icon, txt } from "../ui/dom";
import { bindHold, bindScroll, bindTrack, scrollBoxOf } from "../ui/tap";
import { installGlobalInput } from "../ui/globalInput";
import type { MobileIconId } from "../../mobile/icons";
import { screenSize } from "../view/screen";
import { applyAppSetting } from "../settings/apply";
import { mergeFor, readMobileSettings, type SettingChange } from "../settings/model";
import { openSettings, screensHost, soonBtn, type SettingsHandle } from "../settings/settingsScreen";
import { listLibrary, type LibraryListing } from "./libraryList";
import { LibraryPreview } from "./preview";
import {
  albumCounts,
  albumNameTaken,
  carrySelection,
  displayName,
  frameAt,
  libraryLayout,
  libraryStats,
  shelfItems,
  theaterLayout,
  workNameTaken,
  THEATER_HIDE_MS,
  type LibraryLayout,
  type Selection,
  type ShelfSort,
} from "./rules";

export interface LibraryDeps {
  port: MobilePort;
  /** 描く画面を置く根（#app） */
  root: HTMLElement;
  /** 読んだ設定（変えたら、ここにも写す） */
  settings: Record<string, unknown>;
  version: string;
  log(line: string): void;
  /** 確かめ画面から入ったときの戻る先（確かめ画面の印のビルドだけ） */
  exit?: () => void;
  /** 確かめ画面の印のビルドだけ: 描く画面を開いたとき（数えと記録の道具を付ける） */
  editorOpened?: (screen: WorkScreen) => void;
}

type Pop = "move" | "more" | "sort" | "albums" | "work" | null;
type WorkRef = { album: string; name: string };
const keyOf = (w: WorkRef) => `${w.album}\u0000${w.name}`;

let deps: LibraryDeps;
let listing: LibraryListing = { albums: [], works: [] };
let stamp: string | null = null;
let sel: Selection = { album: "", work: null };
let search = "";
let sort: ShelfSort = "manual";
let folded = false;
let pop: Pop = null;
/** 長押しのメニューを出している作品（棚の札から） */
let popWork: WorkRef | null = null;
let theater = false;
let theaterBarTimer: ReturnType<typeof setTimeout> | null = null;
let screen: WorkScreen | null = null;
let settingsUi: SettingsHandle | null = null;
let busy = false;
let root: HTMLElement | null = null;
let E: Record<string, HTMLElement> = {};
let layout: LibraryLayout | null = null;
let unBackLib: (() => void) | null = null;
let loadSeq = 0;
/** いま再生に読んでいる作品・読めなかった作品（大きすぎる・読めない＝サムネと名前だけを出す） */
let loaded: WorkRef | null = null;
let loadFailed: { ref: WorkRef; tooLarge: boolean } | null = null;
/** 運んでいる途中（長押しから動かしている作品） */
let dragging: { ref: WorkRef; ghost: HTMLElement; over: string | null; openedPicker: boolean; moved: boolean } | null = null;
const wire: SessionWire = { prepare: null, autosaveStart: null };
/** サムネ（オブジェクト URL・無ければ null）と、ヘッダから読んだコマの数（PV6 だけ・無ければ null） */
const thumbs = new Map<string, string | null>();
const peeks = new Map<string, number | null>();
let thumbSeq = 0;
let shelfList: LibraryWork[] = [];
let thumbTimer: ReturnType<typeof setTimeout> | null = null;

const preview = new LibraryPreview({
  canvas: () => (theater ? (E.theaterCanvas as HTMLCanvasElement | undefined) : (E.canvas as HTMLCanvasElement | undefined)) ?? null,
  changed: () => syncTransport(),
});

function hooks(): OpsHooks {
  return {
    currentFrame: () => screen?.editor.mbFrameIndex() ?? 0,
    timing: () => undefined,
    log: (l) => deps.log(l),
    wire,
  };
}

function refusalCode(e: unknown): string {
  return e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : "error";
}

// =====================================================================================
// 一覧を取る・選ぶ
// =====================================================================================

/** 一覧を取り直して描く（prefer＝そのあと選んでおく作品） */
async function refresh(prefer?: WorkRef | null): Promise<void> {
  try {
    listing = await listLibrary(deps.port);
  } catch (e) {
    deps.log(`[V225] library-list refused ${refusalCode(e)}`);
    listing = { albums: [], works: [] };
  }
  stamp = await deps.port.libraryStamp().catch(() => null);
  const before = sel.work;
  sel = carrySelection(sel, listing.albums, listing.works, prefer ?? null);
  // 無くなった作品のサムネとヘッダの控えは捨てる
  const live = new Set(listing.works.map(keyOf));
  for (const k of [...thumbs.keys()]) {
    if (live.has(k)) continue;
    const u = thumbs.get(k);
    if (u) URL.revokeObjectURL(u);
    thumbs.delete(k);
    peeks.delete(k);
  }
  render();
  if (!sel.work) dropPreview();
  else if (busy || screen) return; // 開いている途中は読まない（戻ったときに取り直す）
  else if (loadFailed && keyOf(loadFailed.ref) === keyOf(sel.work) && before && keyOf(before) === keyOf(sel.work)) syncStage(); // 読めなかった作品は、選び替えるまで読み直さない
  else if (!before || keyOf(before) !== keyOf(sel.work) || !loaded || keyOf(loaded) !== keyOf(sel.work)) void loadPreview(sel.work);
}

/** 外で変わったか（前に出てきたとき・描く画面から戻ったとき）。変わっていれば取り直す */
async function refreshIfChanged(prefer?: WorkRef | null): Promise<void> {
  const now = await deps.port.libraryStamp().catch(() => null);
  if (prefer || now === null || now !== stamp) await refresh(prefer);
}

function workOf(ref: WorkRef | null): LibraryWork | null {
  return ref ? (listing.works.find((w) => w.album === ref.album && w.name === ref.name) ?? null) : null;
}

function dropPreview(): void {
  loadSeq++;
  preview.drop();
  loaded = null;
  loadFailed = null;
  syncStage();
}

/** ★選んだ作品を再生のために読む（選び替えたら、前の読み込みと再生は止める）。読めなければサムネと名前だけ（L-4） */
async function loadPreview(ref: WorkRef): Promise<void> {
  const seq = ++loadSeq;
  preview.drop();
  loaded = null;
  loadFailed = null;
  syncStage();
  let project: Project;
  try {
    project = (await readProject(deps.port, ref.album, ref.name, hooks())).project;
  } catch (e) {
    if (seq !== loadSeq) return;
    const tooLarge = isRefusal(e, "too-large") || isAllocFailure(e);
    deps.log(`[V225] preview-read failed ${tooLarge ? "too-large" : isRefusal(e) ? refusalCode(e) : "unreadable"}`);
    loadFailed = { ref, tooLarge };
    syncStage();
    return;
  }
  if (seq !== loadSeq || screen) return; // 選び替えた・描く画面を開いた＝読んだ作品は使わずに捨てる
  loaded = ref;
  preview.show(project);
  syncStage();
  // サムネが無い作品は、読めたときに作って書く（一覧のためだけに作品を丸ごと読まない＝L-5）
  if (workOf(ref) && !workOf(ref)!.thumb && thumbs.get(keyOf(ref)) == null) void makeThumb(ref);
}

/** サムネを作って書く。大きい作品は開いた時点でコマが眠っている＝起こしてから描く（眠ったままだと紙だけの絵を書いてしまう） */
async function makeThumb(ref: WorkRef): Promise<void> {
  try {
    const blob = await preview.thumbBlob((pp, i) => frameToPngBlob(pp, i));
    if (!blob || !loaded || keyOf(loaded) !== keyOf(ref)) return;
    const png = new Uint8Array(await blob.arrayBuffer());
    await deps.port.thumbWrite(ref.album, ref.name, png);
    const w = workOf(ref);
    if (w) w.thumb = true;
    thumbs.set(keyOf(ref), URL.createObjectURL(blob));
    paintThumbs();
  } catch (e) {
    deps.log(`[V225] thumb-write refused ${refusalCode(e)}`);
  }
}

function selectAlbum(a: string): void {
  if (!listing.albums.includes(a)) return;
  closePop();
  if (sel.album === a && !search) return;
  sel = { album: a, work: sel.work };
  render();
}

function selectWork(ref: WorkRef): void {
  if (busy || screen) return; // 開いている途中・描く画面の間は、選び替えない（2 つの作品を同時に読まない＝L-4）
  closePop();
  if (sel.work && keyOf(sel.work) === keyOf(ref) && loaded && keyOf(loaded) === keyOf(ref)) return;
  sel = { album: search ? sel.album : ref.album, work: ref };
  renderOps(); // 名前・アルバム・押せる／押せないは、選んだ作品で決まる
  renderShelf();
  syncStage();
  void loadPreview(ref);
}

// =====================================================================================
// 画面を組む
// =====================================================================================

const iconBtn = (cls: string, name: string, ic: MobileIconId, act: () => void, size = 22) => btn(cls, name, act, icon(ic, size));

function build(): void {
  const r = h("div", "mb-app mb-lib mb-ui");
  root?.remove();
  root = r;
  E = {};
  // 上の帯
  E.search = document.createElement("input");
  const si = E.search as HTMLInputElement;
  si.className = "mb-lib-search";
  si.type = "search";
  si.placeholder = t("lib.search.placeholder");
  si.ariaLabel = t("lib.search.placeholder");
  si.value = search;
  si.setAttribute("autocomplete", "off");
  si.setAttribute("autocapitalize", "off");
  si.setAttribute("enterkeyhint", "search");
  si.addEventListener("input", () => {
    search = si.value;
    renderShelf();
  });
  si.addEventListener("keydown", (e) => {
    if (e.key === "Enter") si.blur();
  });
  const tabs = h("div", "mb-lib-tabs", h("span", "mb-lib-tab mb-on", icon("project", 20), txt("", mt("mb.lib.tab.library.btn"))), soonBtn("mb-lib-tab", mt("mb.lib.tab.gallery.btn"), icon("heart", 20), txt("", mt("mb.lib.tab.gallery.btn"))));
  const mark = h("span", "mb-lib-mark");
  mark.setAttribute("aria-hidden", "true");
  E.top = h(
    "div",
    "mb-topbar mb-lib-top",
    deps.exit ? btn("mb-lib-devexit", "dev", () => leaveToDev(), txt("", "dev")) : null,
    mark,
    txt("mb-lib-word", t("app.name.label")),
    tabs,
    h("label", "mb-lib-searchbox", icon("zoom", 20), si),
    h("span", "mb-lib-spacer"),
    soonBtn("mb-lib-import", mt("mb.lib.import.btn"), icon("import", 22), txt("", mt("mb.lib.import.btn"))),
    btn("mb-lib-new", t("lib.newNote.btn"), () => void openNew(), icon("pen", 22), txt("", t("lib.newNote.btn"))),
    iconBtn("mb-lib-gear", t("lib.settings.title"), "gear", () => openLibrarySettings(), 24)
  );
  // アルバムの列（出しているとき）
  E.albumRows = h("div", "mb-lib-albumrows");
  E.albums = h(
    "div",
    "mb-card mb-lib-albums",
    h("div", "mb-lib-albumhead", txt("mb-lib-sub", t("lib.albums.label")), btn("mb-lib-foldbtn", mt("mb.lib.fold.title"), () => setFolded(true), icon("fold", 20), txt("", mt("mb.lib.fold.btn")))),
    E.albumRows,
    albumOps(),
    txt("mb-lib-hint", mt("mb.lib.dnd.msg"))
  );
  // 再生
  const cv = document.createElement("canvas");
  cv.width = 320;
  cv.height = 240;
  cv.className = "mb-lib-canvas";
  E.canvas = cv;
  E.thumbBig = document.createElement("img");
  E.thumbBig.className = "mb-lib-bigthumb";
  (E.thumbBig as HTMLImageElement).alt = "";
  E.playMark = h("span", "mb-lib-playmark", icon("play", 44));
  E.stageNote = txt("mb-lib-stagenote", "");
  E.preview = h("div", "mb-lib-preview", cv, E.thumbBig, E.playMark, E.stageNote);
  E.preview.setAttribute("role", "button");
  bindAct(E.preview, () => {
    if (pop) closePop();
    else preview.toggle();
  });
  // 操作
  E.ops = h("div", "mb-card mb-lib-ops");
  // 棚
  E.shelfHead = h("div", "mb-lib-shelfhead");
  E.grid = h("div", "mb-lib-grid");
  E.shelf = h("div", "mb-card mb-lib-shelf", E.shelfHead, E.grid);
  // 浮かぶもの（移動先・その他・並び順・アルバムの一覧・作品のメニュー）
  E.pop = h("div", "mb-lib-pop");
  E.pop.hidden = true;
  // 案内（狭・低・幅の足りない中＝決-20）
  E.guide = h("div", "mb-narrow mb-lib-guide", h("div", "mb-narrow-box", icon("warn", 28), txt("mb-narrow-title", mt("mb.narrow.head.title")), txt("mb-narrow-msg", mt("mb.narrow.msg"))));
  E.guide.hidden = true;
  r.append(E.top, E.albums, E.preview, E.ops, E.shelf, E.pop, E.guide);
  // 外を押すと、浮かぶものを閉じる
  r.addEventListener("pointerdown", (e) => {
    if (!pop) return;
    const tg = e.target as Element | null;
    if (tg?.closest(".mb-lib-pop, [data-pop-anchor]")) return;
    closePop();
  });
  screensHost().append(r);
}

function albumOps(): HTMLElement {
  const count = albumCounts(listing.albums, listing.works).get(sel.album) ?? 0;
  const del = btn(`mb-lib-aop${count > 0 ? " mb-dim" : ""}`, mt("mb.lib.album.delete.title"), () => void deleteAlbum(), icon("trash", 18), txt("", mt("mb.lib.delete.btn")));
  return h(
    "div",
    "mb-lib-albumops",
    btn("mb-lib-aop", t("lib.album.add.title"), () => void addAlbum(), icon("add", 18), txt("", mt("mb.lib.album.add.btn"))),
    btn("mb-lib-aop", t("lib.album.rename.title"), () => void renameAlbum(), icon("pen", 18), txt("", mt("mb.lib.album.rename.btn"))),
    del
  );
}

function albumRow(a: string, count: number): HTMLElement {
  const row = btn(`mb-lib-album${a === sel.album ? " mb-on" : ""}`, a, () => selectAlbum(a), txt("mb-lib-albumname", a), txt("mb-lib-count mb-num", String(count)));
  row.dataset.album = a;
  return row;
}

/** 置き方を決めて、部品の位置と大きさを当てる（画面の大きさが変わったとき・たたむ／出す） */
function place(): void {
  if (!root) return;
  const { w, h: hh } = screenSize();
  const dpr = window.devicePixelRatio || 1;
  layout = libraryLayout(w, hh, dpr, folded);
  E.guide.hidden = !!layout;
  for (const k of ["albums", "preview", "ops", "shelf"]) E[k].style.visibility = layout ? "" : "hidden";
  if (!layout) return;
  const L = layout;
  root.dataset.shape = L.kind;
  root.classList.toggle("mb-folded", L.folded);
  root.classList.toggle("mb-tight", L.spacing.tight);
  root.classList.toggle("mb-ops-2", L.opsRows === 2);
  root.classList.toggle("mb-ops-narrow", L.ops.w < 560);
  root.classList.toggle("mb-top-narrow", w < 800);
  root.style.setProperty("--lib-topbar", `${L.spacing.topBar}px`);
  const put = (el: HTMLElement, r: { x: number; y: number; w: number; h: number } | null) => {
    el.hidden = !r;
    if (!r) return;
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  };
  put(E.albums, L.albums);
  put(E.preview, L.preview);
  put(E.ops, L.ops);
  put(E.shelf, L.shelf);
  E.grid.style.setProperty("--cols", String(L.kind === "medium" ? L.columns : 2));
  if (theater) placeTheater();
}

function render(): void {
  if (!root) build();
  place();
  renderAlbums();
  renderOps();
  renderShelf();
  syncStage();
}

function renderAlbums(): void {
  const counts = albumCounts(listing.albums, listing.works);
  const rows = E.albumRows;
  const top = rows.scrollTop;
  rows.replaceChildren(...listing.albums.map((a) => albumRow(a, counts.get(a) ?? 0)));
  const box = scrollBoxOf(rows, "y");
  rows.querySelectorAll<HTMLElement>(".mb-lib-album").forEach((el) => bindScroll(el, box, "y"));
  rows.scrollTop = top;
  // 選んでいる行が見える位置まで送っておく（U-19）
  const on = rows.querySelector<HTMLElement>(".mb-lib-album.mb-on");
  if (on && (on.offsetTop < rows.scrollTop || on.offsetTop + on.offsetHeight > rows.scrollTop + rows.clientHeight)) rows.scrollTop = Math.max(0, on.offsetTop - 8);
  const ops = E.albums.querySelector(".mb-lib-albumops");
  ops?.replaceWith(albumOps());
  requestAnimationFrame(fitAlbumOps);
}

/** アルバムの下の 3 つの札: 字が入らない言語では、印を外して字だけにする（切らない・はみ出さない） */
function fitAlbumOps(): void {
  root?.querySelectorAll<HTMLElement>(".mb-lib-albumops, .mb-lib-pop .mb-lib-albumops").forEach((row) => {
    row.classList.remove("mb-noicon");
    if ([...row.querySelectorAll<HTMLElement>(".mb-lib-aop")].some((b) => b.scrollWidth > b.clientWidth + 1)) row.classList.add("mb-noicon");
  });
}

/** 操作の島（再生の段・作品の段・操作の段。たたんだ形と縦は 2 段） */
function renderOps(): void {
  const w = workOf(sel.work);
  const two = !!layout && layout.opsRows === 2;
  const el = E.ops;
  const round = (name: string, ic: MobileIconId, act: () => void, cls = "") => iconBtn(`mb-lib-round ${cls}`, name, ic, act);
  E.playBtn = round(mt("mb.lib.play.title"), "play", () => preview.toggle(), "mb-lib-play");
  E.loopBtn = round(t("ed.tl.loop.title"), "loop", () => preview.toggleLoop());
  E.soundBtn = round(mt("mb.lib.sound.title"), "listen", () => preview.toggleMute());
  E.seekFill = h("span", "mb-lib-seekfill");
  E.seekKnob = h("span", "mb-lib-seekknob");
  E.seek = h("div", "mb-lib-seek", h("span", "mb-lib-seektrack", E.seekFill), E.seekKnob);
  E.seek.setAttribute("role", "slider");
  bindSeek(E.seek);
  E.pos = txt("mb-lib-pos mb-num", "");
  const transport = h(
    "div",
    "mb-lib-transport",
    round(mt("mb.lib.first.title"), "skip-first", () => preview.seek(0)),
    round(t("ed.tl.prev.title"), "prev", () => preview.step(-1)),
    E.playBtn,
    round(t("ed.tl.next.title"), "next", () => preview.step(1)),
    E.loopBtn,
    E.seek,
    E.pos,
    E.soundBtn,
    round(mt("mb.lib.theater.title"), "focus", () => setTheater(true))
  );
  const name = txt("mb-lib-name", w ? displayName(w.name) : "");
  E.chips = h("span", "mb-lib-chips");
  const actions = h(
    "div",
    "mb-lib-actions",
    btn("mb-lib-act mb-lib-edit", mt("mb.lib.edit.btn"), () => void editSelected(), icon("pen", 20), txt("", mt("mb.lib.edit.btn"))),
    soonBtn("mb-lib-act mb-lib-export", t("ed.export.btn"), icon("export", 20), txt("", t("ed.export.btn"))),
    popBtn("mb-lib-act", t("lib.chip.move.title"), "move", icon("folder-open", 20), txt("", mt("mb.lib.move.btn"))),
    soonBtn("mb-lib-act", mt("mb.lib.post.btn"), icon("post", 20), txt("", mt("mb.lib.post.btn"))),
    popBtn("mb-lib-act mb-lib-morebtn", mt("mb.lib.more.title"), "more", icon("more", 22))
  );
  el.classList.toggle("mb-none", !w);
  if (two) {
    el.replaceChildren(transport, h("div", "mb-lib-row2", name, E.chips, h("span", "mb-lib-spacer"), actions));
  } else {
    const albumTag = h("span", "mb-lib-albumtag", icon("folder", 16), txt("", w ? w.album : ""));
    el.replaceChildren(transport, h("div", "mb-lib-titleblock", h("div", "mb-lib-titleline", name, w ? albumTag : null), E.chips), actions);
  }
  syncTransport();
}

/** 浮かぶものを開くボタン（開いている間は黄） */
function popBtn(cls: string, name: string, which: Exclude<Pop, null>, ...kids: (Node | null)[]): HTMLElement {
  const b = btn(`${cls}${pop === which ? " mb-open" : ""}`, name, () => togglePop(which), ...kids);
  b.setAttribute("data-pop-anchor", which);
  return b;
}

/** 再生の段の今（ボタンの印・つまみ・数・札）。止めている間は、呼ばれたときだけ書く */
function syncTransport(): void {
  if (!root || !E.playBtn) return;
  const total = preview.frameCount();
  const at = preview.frameIndex();
  const playing = preview.isPlaying();
  for (const b of [E.playBtn, E.theaterPlay].filter(Boolean)) {
    b.replaceChildren(icon(playing ? "pause" : "play", 22));
    b.ariaLabel = playing ? mt("mb.lib.pause.title") : mt("mb.lib.play.title");
  }
  for (const b of [E.loopBtn, E.theaterLoop].filter(Boolean)) {
    b.classList.toggle("mb-on", preview.loop());
    b.setAttribute("aria-pressed", preview.loop() ? "true" : "false");
  }
  for (const b of [E.soundBtn, E.theaterSound].filter(Boolean)) {
    b.replaceChildren(icon(preview.isMuted() ? "sound-off" : "listen", 22));
    b.classList.toggle("mb-dim", !preview.hasSound());
    b.setAttribute("aria-pressed", preview.isMuted() ? "true" : "false");
  }
  const ratio = total > 1 ? at / (total - 1) : 0;
  for (const [seek, fill, knob] of [
    [E.seek, E.seekFill, E.seekKnob],
    [E.theaterSeek, E.theaterSeekFill, E.theaterSeekKnob],
  ]) {
    if (!seek) continue;
    fill.style.width = `${ratio * 100}%`;
    knob.style.left = `${ratio * 100}%`;
    seek.ariaLabel = mt("mb.lib.seek.title", { n: total ? at + 1 : 0, total });
    seek.setAttribute("aria-valuemin", "1");
    seek.setAttribute("aria-valuemax", String(Math.max(1, total)));
    seek.setAttribute("aria-valuenow", String(total ? at + 1 : 0));
  }
  const pos = total ? `${at + 1} / ${total}` : "";
  if (E.pos) E.pos.textContent = pos;
  if (E.theaterPos) E.theaterPos.textContent = pos;
  E.playMark.hidden = playing || !loaded;
  // 札（メモアニマ｜320 × 240｜12コマ｜6 fps。たたんだ形は コマ と fps だけ）
  if (E.chips) {
    const w = workOf(sel.work);
    const chips: HTMLElement[] = [];
    const two = !!layout && layout.opsRows === 2;
    if (w && !two) chips.push(txt("mb-lib-chip mb-lib-chip-app", mt("mb.lib.chip.app.label")), txt("mb-lib-chip mb-num", "320 × 240"));
    const frames = total || (w ? (peeks.get(keyOf(w)) ?? 0) : 0);
    if (w && frames) chips.push(txt("mb-lib-chip mb-num", mt("mb.more.frames.label", { count: frames })));
    if (w && preview.fps()) chips.push(txt("mb-lib-chip mb-num", mt("mb.lib.chip.fps.label", { fps: preview.fps() })));
    E.chips.replaceChildren(...chips);
  }
  if (theater) theaterTouched(false);
}

/** 再生の場所（読んだ絵・読んでいる間と読めなかったときはサムネ・何も選んでいないとき） */
function syncStage(): void {
  if (!root) return;
  const w = workOf(sel.work);
  const showing = !!loaded && !!w && keyOf(loaded) === keyOf(w);
  E.canvas.hidden = !showing;
  const big = E.thumbBig as HTMLImageElement;
  const url = w ? thumbs.get(keyOf(w)) : null;
  big.hidden = showing || !url;
  if (url && big.src !== url) big.src = url;
  E.playMark.hidden = !showing || preview.isPlaying();
  const failed = !!loadFailed && !!w && keyOf(loadFailed.ref) === keyOf(w);
  E.stageNote.hidden = !failed;
  E.stageNote.textContent = failed ? (loadFailed!.tooLarge ? mt("mb.open.tooLarge.title") : mt("mb.open.failed.title")) : "";
  E.preview.classList.toggle("mb-empty", !w);
  if (theater && !showing) setTheater(false);
}

function bindSeek(el: HTMLElement): void {
  const at = (x: number) => {
    const r = el.getBoundingClientRect();
    const pad = 14;
    preview.seek(frameAt((x - r.left - pad) / Math.max(1, r.width - pad * 2), preview.frameCount()));
  };
  let was = false;
  bindTrack(el, {
    start: (x) => {
      was = preview.isPlaying();
      if (was) preview.stop(true);
      preview.setDragging(true);
      at(x);
    },
    move: (x) => at(x),
    end: () => {
      preview.setDragging(false);
      if (was) void preview.start();
      was = false;
    },
  });
}

// ---------------- 棚 ----------------

function sortLabel(s: ShelfSort): string {
  return s === "name" ? t("lib.sort.name.label") : s === "date" ? t("lib.sort.date.label") : mt("mb.lib.sort.manual.label");
}

function renderShelf(): void {
  if (!root) return;
  const counts = albumCounts(listing.albums, listing.works);
  const list = shelfItems(listing.works, sel.album, search, sort, getLang());
  const sortBtn = popBtn("mb-lib-sortbtn", mt("mb.lib.sort.title", { mode: sortLabel(sort) }), "sort", icon("sort", 22));
  const count = txt("mb-lib-sub mb-num", t("lib.shelf.count.label", { count: list.length }));
  const head = E.shelfHead;
  const useButton = !layout || layout.folded;
  if (useButton) {
    const ab = popBtn("mb-lib-albumbtn", mt("mb.lib.albumPick.title", { album: sel.album }), "albums", icon("folder-open", 22), txt("mb-lib-albumname", search ? t("lib.shelf.searching.label", { query: search.trim() }) : sel.album), count, icon(pop === "albums" ? "chev-up" : "chev-down", 18));
    head.replaceChildren(ab, sortBtn);
  } else {
    head.replaceChildren(h("div", "mb-lib-shelftitle", txt("mb-lib-albumtitle", search ? t("lib.shelf.searching.label", { query: search.trim() }) : sel.album || t("lib.shelf.noAlbum.label")), count), sortBtn);
  }
  const grid = E.grid;
  const top = grid.scrollTop;
  if (list.length === 0) {
    grid.replaceChildren(search ? h("div", "mb-lib-emptybox", txt("mb-lib-emptytitle", mt("mb.lib.empty.title"))) : h("div", "mb-lib-emptybox", txt("mb-lib-emptytitle", mt("mb.lib.empty.title")), (counts.size > 1 ? txt("mb-lib-emptymsg", mt("mb.lib.empty.msg")) : null)));
  } else {
    const box = scrollBoxOf(grid, "y");
    grid.replaceChildren(
      ...list.map((w) => {
        const ref = { album: w.album, name: w.name };
        const img = document.createElement("img");
        img.className = "mb-lib-thumb";
        img.alt = "";
        img.hidden = true;
        const pic = h("span", "mb-lib-pic", img, txt("mb-lib-picname", displayName(w.name)));
        const card = btn(`mb-lib-card${sel.work && keyOf(sel.work) === keyOf(ref) ? " mb-on" : ""}`, displayName(w.name), () => selectWork(ref), pic, h("span", "mb-lib-cardname", txt("", displayName(w.name)), txt("mb-lib-cardframes mb-num", "")));
        card.dataset.key = keyOf(ref);
        bindScroll(card, box, "y");
        bindHold(card, {
          hold: (x, y) => dragStart(ref, x, y),
          drag: (x, y) => dragMove(x, y),
          drop: (x, y, cancelled) => dragEnd(x, y, cancelled),
        });
        return card;
      })
    );
  }
  grid.scrollTop = top;
  paintThumbs();
  shelfList = list;
  if (!grid.dataset.watch) {
    // 送ったら、見えるようになった札の分を読む（少し待ってから＝送っている間は読まない）
    grid.dataset.watch = "1";
    grid.addEventListener("scroll", () => {
      if (thumbTimer) clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => {
        thumbTimer = null;
        void loadThumbs(shelfList);
      }, 140);
    });
  }
  void loadThumbs(list);
}

/** いま棚に見えている札（上下に 1 段ぶんの余裕）の作品 */
function visibleKeys(): Set<string> {
  const out = new Set<string>();
  const g = E.grid?.getBoundingClientRect();
  if (!g) return out;
  E.grid.querySelectorAll<HTMLElement>(".mb-lib-card").forEach((card) => {
    const r = card.getBoundingClientRect();
    if (r.bottom >= g.top - r.height && r.top <= g.bottom + r.height) out.add(card.dataset.key ?? "");
  });
  return out;
}

/** いまの棚の札に、控えたサムネとコマの数を当てる */
function paintThumbs(): void {
  E.grid?.querySelectorAll<HTMLElement>(".mb-lib-card").forEach((card) => {
    const k = card.dataset.key ?? "";
    const url = thumbs.get(k);
    const img = card.querySelector<HTMLImageElement>(".mb-lib-thumb");
    if (img) {
      img.hidden = !url;
      if (url && img.src !== url) img.src = url;
    }
    card.classList.toggle("mb-nothumb", !url);
    const fr = card.querySelector<HTMLElement>(".mb-lib-cardframes");
    const n = peeks.get(k);
    if (fr) fr.textContent = n ? mt("mb.more.frames.label", { count: n }) : "";
  });
  syncStage();
}

/** サムネ（ある作品だけ）とコマの数（棚が広いとき＝たたんだ形と縦）を、**棚に見えている札の分だけ**読む（L-5） */
async function loadThumbs(list: LibraryWork[]): Promise<void> {
  const seq = ++thumbSeq;
  const wantPeek = !layout || layout.folded;
  const seen = visibleKeys();
  for (const w of list) {
    if (seq !== thumbSeq) return;
    const k = keyOf(w);
    if (!seen.has(k)) continue;
    if (w.thumb && !thumbs.has(k)) {
      try {
        const png = await deps.port.thumbRead(w.album, w.name);
        if (!thumbs.has(k)) thumbs.set(k, URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" })));
      } catch {
        thumbs.set(k, null);
      }
      if (seq === thumbSeq) paintThumbs();
    }
    if (wantPeek && !peeks.has(k)) {
      const p = await deps.port.workPeek(w.album, w.name).catch(() => null);
      peeks.set(k, p?.frames ?? null);
      if (seq === thumbSeq) paintThumbs();
    }
  }
}

// ---------------- 浮かぶもの ----------------

function closePop(): void {
  if (!pop) return;
  pop = null;
  popWork = null;
  E.pop.hidden = true;
  E.pop.replaceChildren();
  renderOps();
  renderShelf();
}

function togglePop(which: Exclude<Pop, null>): void {
  if (pop === which) {
    closePop();
    return;
  }
  openPop(which);
}

function menuRow(label: string, ic: MobileIconId | null, act: (() => void) | null, cls = "", tail: HTMLElement | null = null): HTMLElement {
  const kids = [ic ? icon(ic, 20) : null, txt("mb-lib-rowlabel", label), tail];
  return act
    ? btn(`mb-lib-menurow ${cls}`, label, () => {
        closePop();
        act();
      }, ...kids)
    : soonBtn(`mb-lib-menurow ${cls}`, label, ...kids);
}

function openPop(which: Exclude<Pop, null>, anchorEl?: HTMLElement): void {
  pop = which;
  const el = E.pop;
  el.className = `mb-lib-pop mb-lib-pop-${which}`;
  const counts = albumCounts(listing.albums, listing.works);
  const target = which === "work" ? popWork : sel.work;
  if (which === "move") {
    const from = target?.album ?? sel.album;
    const rows = listing.albums.filter((a) => a !== from).map((a) => menuRow(a, null, () => void moveWork(target, a), "mb-lib-albumpick", txt("mb-lib-count mb-num", String(counts.get(a) ?? 0))));
    el.replaceChildren(txt("mb-lib-pophead", mt("mb.lib.moveTo.title")), h("div", "mb-lib-poprows", ...(rows.length ? rows : [txt("mb-lib-hint", t("lib.moveTo.noAlbums.toast"))])));
  } else if (which === "more") {
    el.replaceChildren(menuRow(mt("mb.lib.rename.btn"), "pen", () => void renameWork(target)), menuRow(mt("mb.lib.delete.btn"), "trash", () => void deleteWork(target), "mb-warn-text"));
  } else if (which === "work") {
    el.replaceChildren(
      menuRow(mt("mb.lib.edit.btn"), "pen", () => void editWork(target)),
      menuRow(t("ed.export.btn"), "export", null),
      menuRow(mt("mb.lib.move.btn"), "folder-open", () => {
        popWork = target;
        openPop("move", anchorEl);
      }),
      menuRow(mt("mb.lib.post.btn"), "post", null),
      menuRow(mt("mb.lib.rename.btn"), "pen", () => void renameWork(target)),
      menuRow(mt("mb.lib.delete.btn"), "trash", () => void deleteWork(target), "mb-warn-text")
    );
  } else if (which === "sort") {
    el.replaceChildren(
      ...(["manual", "name", "date"] as const).map((s) =>
        menuRow(sortLabel(s), s === sort ? "check" : null, () => setSort(s), s === sort ? "mb-on" : "")
      )
    );
  } else {
    // アルバムを選ぶ一覧（たたんでいるとき・縦）
    const rows = h("div", "mb-lib-albumrows mb-lib-poprows", ...listing.albums.map((a) => albumRow(a, counts.get(a) ?? 0)));
    const head = h("div", "mb-lib-albumhead", txt("mb-lib-sub", t("lib.albums.label")), layout?.kind === "wide" ? btn("mb-lib-foldbtn", mt("mb.lib.unfold.title"), () => setFolded(false), icon("unfold", 20), txt("", mt("mb.lib.unfold.btn"))) : null);
    el.replaceChildren(head, rows, albumOps());
    requestAnimationFrame(fitAlbumOps);
  }
  el.hidden = false;
  renderOps();
  renderShelf();
  positionPop(which, anchorEl);
  if (which === "albums") {
    const on = el.querySelector<HTMLElement>(".mb-lib-album.mb-on");
    const rows = el.querySelector<HTMLElement>(".mb-lib-albumrows");
    if (on && rows) rows.scrollTop = Math.max(0, on.offsetTop - rows.offsetTop - 8);
  }
}

/** 浮かぶものの位置: 押したボタンのすぐ上（移動先・その他）か、すぐ下（並び順・アルバムの一覧）。画面の内に収める */
function positionPop(which: Exclude<Pop, null>, anchorEl?: HTMLElement): void {
  const el = E.pop;
  const { w, h: hh } = screenSize();
  const anchor = anchorEl ?? root?.querySelector<HTMLElement>(`[data-pop-anchor="${which === "work" ? "more" : which}"]`) ?? null;
  const r = anchor?.getBoundingClientRect();
  if (!r) return;
  el.style.maxHeight = "";
  const below = which === "sort" || which === "albums" || (which === "work" && r.top < hh / 2) || (which === "move" && !!anchorEl && r.top < hh / 2);
  const pw = el.offsetWidth;
  let left = which === "sort" ? r.right - pw : which === "albums" ? r.left : r.left;
  left = Math.max(8, Math.min(w - pw - 8, left));
  el.style.left = `${left}px`;
  if (below) {
    el.style.top = `${r.bottom + 8}px`;
    el.style.bottom = "auto";
    el.style.maxHeight = `${hh - r.bottom - 8 - 22}px`;
  } else {
    el.style.top = "auto";
    el.style.bottom = `${hh - r.top + 8}px`;
    el.style.maxHeight = `${r.top - 8 - 68}px`;
  }
}

function setSort(s: ShelfSort): void {
  if (sort === s) return;
  sort = s;
  writeSetting({ id: "shelfSort", value: s });
  renderShelf();
}

function setFolded(v: boolean): void {
  closePop();
  if (folded === v) return;
  folded = v;
  writeSetting({ id: "albumsFolded", value: v });
  root?.classList.add("mb-folding");
  render();
  setTimeout(() => root?.classList.remove("mb-folding"), 360);
}

function writeSetting(c: SettingChange): void {
  const values = mergeFor(deps.settings, c);
  if (Object.keys(values).length === 0) return;
  Object.assign(deps.settings, values);
  deps.port.settingsMerge(values).catch((e) => deps.log(`[V225] settings-merge refused ${refusalCode(e)}`));
}

// ---------------- 全画面で見る ----------------

function setTheater(on: boolean): void {
  if (theater === on) return;
  if (on && !loaded) return;
  closePop();
  theater = on;
  if (theaterBarTimer) clearTimeout(theaterBarTimer);
  theaterBarTimer = null;
  if (!on) {
    E.theater?.remove();
    for (const k of ["theater", "theaterCanvas", "theaterBar", "theaterPlay", "theaterLoop", "theaterSound", "theaterSeek", "theaterSeekFill", "theaterSeekKnob", "theaterPos", "theaterClose"]) delete E[k];
    preview.draw();
    syncTransport();
    return;
  }
  const cv = document.createElement("canvas");
  cv.width = 320;
  cv.height = 240;
  cv.className = "mb-lib-canvas";
  E.theaterCanvas = cv;
  const pic = h("div", "mb-lib-theaterpic", cv);
  const round = (name: string, ic: MobileIconId, act: () => void, cls = "") => iconBtn(`mb-lib-round ${cls}`, name, ic, act);
  E.theaterPlay = round(mt("mb.lib.play.title"), "play", () => preview.toggle(), "mb-lib-play");
  E.theaterLoop = round(t("ed.tl.loop.title"), "loop", () => preview.toggleLoop());
  E.theaterSound = round(mt("mb.lib.sound.title"), "listen", () => preview.toggleMute());
  E.theaterSeekFill = h("span", "mb-lib-seekfill");
  E.theaterSeekKnob = h("span", "mb-lib-seekknob");
  E.theaterSeek = h("div", "mb-lib-seek", h("span", "mb-lib-seektrack", E.theaterSeekFill), E.theaterSeekKnob);
  E.theaterSeek.setAttribute("role", "slider");
  bindSeek(E.theaterSeek);
  E.theaterPos = txt("mb-lib-pos mb-num", "");
  const w = workOf(sel.work);
  E.theaterBar = h(
    "div",
    "mb-lib-theaterbar",
    txt("mb-lib-name", w ? displayName(w.name) : ""),
    round(mt("mb.lib.first.title"), "skip-first", () => preview.seek(0)),
    round(t("ed.tl.prev.title"), "prev", () => preview.step(-1)),
    E.theaterPlay,
    round(t("ed.tl.next.title"), "next", () => preview.step(1)),
    E.theaterLoop,
    E.theaterSeek,
    E.theaterPos,
    E.theaterSound
  );
  E.theaterClose = iconBtn("mb-lib-theaterclose", mt("mb.lib.theater.close.title"), "close", () => setTheater(false), 24);
  E.theater = h("div", "mb-lib-theater", pic, E.theaterBar, E.theaterClose);
  bindAct(pic, () => {
    // 帯が隠れているときに画面を押したら、帯を出すだけ（再生は切り替えない）
    if (E.theaterBar.classList.contains("mb-hide")) theaterTouched(true);
    else preview.toggle();
  });
  E.theater.addEventListener("pointerdown", () => theaterTouched(true), true);
  root?.append(E.theater);
  placeTheater();
  preview.draw();
  syncTransport();
}

function placeTheater(): void {
  if (!E.theater) return;
  const { w, h: hh } = screenSize();
  const L = theaterLayout(w, hh, window.devicePixelRatio || 1);
  if (!L) {
    setTheater(false);
    return;
  }
  const pic = E.theater.querySelector<HTMLElement>(".mb-lib-theaterpic")!;
  pic.style.left = `${L.pic.x}px`;
  pic.style.top = `${L.pic.y}px`;
  pic.style.width = `${L.pic.w}px`;
  pic.style.height = `${L.pic.h}px`;
  const bar = E.theaterBar;
  bar.style.left = `${L.bar.x}px`;
  bar.style.top = `${L.bar.y}px`;
  bar.style.width = `${L.bar.w}px`;
  E.theater.classList.toggle("mb-overlay", L.overlay);
  theaterTouched(true);
}

/** 帯を絵に重ねる端末では、再生中に 3 秒触らなければ帯を隠す（押すと出る＝U-24）。touched＝いま触った */
function theaterTouched(touched: boolean): void {
  if (!E.theaterBar) return;
  const overlay = E.theater.classList.contains("mb-overlay");
  if (touched) E.theaterBar.classList.remove("mb-hide");
  if (theaterBarTimer && (touched || !preview.isPlaying() || !overlay)) {
    clearTimeout(theaterBarTimer);
    theaterBarTimer = null;
  }
  if (!overlay || !preview.isPlaying()) {
    E.theaterBar.classList.remove("mb-hide");
    return;
  }
  if (!theaterBarTimer)
    theaterBarTimer = setTimeout(() => {
      theaterBarTimer = null;
      if (theater && preview.isPlaying()) E.theaterBar?.classList.add("mb-hide");
    }, THEATER_HIDE_MS);
}

// =====================================================================================
// 長押しから運ぶ（アルバムへ移す）・長押しして離す（メニュー）
// =====================================================================================

function dragStart(ref: WorkRef, x: number, y: number): void {
  if (dragging || busy) return;
  closePop();
  const ghost = h("div", "mb-lib-ghost", txt("", displayName(ref.name)));
  root?.append(ghost);
  dragging = { ref, ghost, over: null, openedPicker: false, moved: false };
  root?.classList.add("mb-dragging");
  root?.querySelector<HTMLElement>(`.mb-lib-card[data-key="${CSS.escape(keyOf(ref))}"]`)?.classList.add("mb-held");
  moveGhost(x, y);
}

function moveGhost(x: number, y: number): void {
  if (!dragging) return;
  dragging.ghost.style.left = `${x}px`;
  dragging.ghost.style.top = `${y}px`;
}

function dragMove(x: number, y: number): void {
  const d = dragging;
  if (!d) return;
  d.moved = true;
  // アルバムの行が見えていない形（たたんでいる・縦）では、動かし始めたらアルバムの一覧を出す
  if (!d.openedPicker && (!layout || layout.folded) && pop !== "albums") {
    d.openedPicker = true;
    openPop("albums");
    root?.classList.add("mb-dragging");
  }
  moveGhost(x, y);
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".mb-lib-album") ?? null;
  const over = hit && hit.dataset.album && hit.dataset.album !== d.ref.album ? hit.dataset.album : null;
  if (over !== d.over) {
    root?.querySelectorAll(".mb-lib-album.mb-drop").forEach((el) => el.classList.remove("mb-drop"));
    if (hit && over) hit.classList.add("mb-drop");
    d.over = over;
  }
  // 行の列の端に近づいたら送る
  const rows = (pop === "albums" ? E.pop.querySelector<HTMLElement>(".mb-lib-albumrows") : E.albumRows) ?? null;
  if (rows) {
    const r = rows.getBoundingClientRect();
    if (x >= r.left && x <= r.right) {
      if (y < r.top + 36 && y > r.top - 20) rows.scrollTop -= 12;
      else if (y > r.bottom - 36 && y < r.bottom + 20) rows.scrollTop += 12;
    }
  }
}

function dragEnd(_x: number, _y: number, cancelled: boolean): void {
  const d = dragging;
  if (!d) return;
  dragging = null;
  d.ghost.remove();
  root?.classList.remove("mb-dragging");
  root?.querySelectorAll(".mb-drop, .mb-held").forEach((el) => el.classList.remove("mb-drop", "mb-held"));
  const moved = d.moved;
  if (d.openedPicker && pop === "albums") closePop();
  if (cancelled) return;
  if (d.over) {
    void moveWork(d.ref, d.over);
    return;
  }
  if (!moved) {
    // 長押しして離した＝その作品のメニュー
    popWork = d.ref;
    const card = root?.querySelector<HTMLElement>(`.mb-lib-card[data-key="${CSS.escape(keyOf(d.ref))}"]`) ?? undefined;
    openPop("work", card);
  }
}

// =====================================================================================
// 作品とアルバムの操作
// =====================================================================================

async function moveWork(ref: WorkRef | null, dest: string): Promise<void> {
  if (!ref || busy || ref.album === dest) return;
  busy = true;
  try {
    if (sel.work && keyOf(sel.work) === keyOf(ref)) dropPreview();
    const placed = await deps.port.moveWork(ref.album, ref.name, dest);
    toast(t("lib.move.done.toast", { album: placed.album }));
    // いまのアルバムの棚に残る（アルバムは替えない）。移した作品は棚から無くなるので、選択は外れる
    await refresh(null);
  } catch (e) {
    deps.log(`[V225] move-work refused ${refusalCode(e)}`);
    toast(isRefusal(e, "name-taken") ? mt("mb.save.nameTaken.msg") : t("lib.move.failed.toast"));
    await refresh(null);
  } finally {
    busy = false;
  }
}

async function renameWork(ref: WorkRef | null): Promise<void> {
  if (!ref || busy) return;
  let current = displayName(ref.name);
  for (;;) {
    const name = await askName({
      title: mt("mb.lib.rename.title"),
      label: mt("mb.save.name.label"),
      value: current,
      okLabel: mt("mb.rename.ok.btn"),
      note: mt("mb.lib.rename.note.msg"),
      refuse: (n) => (workNameTaken(listing.works, ref.album, ref.name, n) ? mt("mb.save.nameTaken.msg") : null),
    });
    if (name === null || name === displayName(ref.name)) return;
    busy = true;
    try {
      const wasSel = !!sel.work && keyOf(sel.work) === keyOf(ref);
      if (wasSel) dropPreview();
      const placed = await deps.port.renameWork(ref.album, ref.name, name);
      await refresh(wasSel ? { album: placed.album, name: placed.name } : null);
      return;
    } catch (e) {
      deps.log(`[V225] rename-work refused ${refusalCode(e)}`);
      await refresh(null);
      if (isRefusal(e, "name-taken")) {
        // 画面の側で見たあとに外で置かれた: 断りの文を出して島を開き直す
        toast(mt("mb.save.nameTaken.msg"));
        current = name;
        continue;
      }
      toast(isRefusal(e, "bad-name") || isRefusal(e, "name-too-long") ? mt("mb.save.reason.name.msg") : mt("mb.lib.failed.toast"));
      return;
    } finally {
      busy = false;
    }
  }
}

async function deleteWork(ref: WorkRef | null): Promise<void> {
  if (!ref || busy) return;
  const ok = await openDialog({
    title: mt("mb.lib.delete.title", { name: displayName(ref.name) }),
    body: [mt("mb.lib.delete.msg")],
    dismiss: false,
    buttons: [
      { label: mt("mb.cancel.btn"), value: false },
      { label: mt("mb.lib.delete.btn"), value: true, kind: "warn" },
    ],
  });
  if (!ok.value) return;
  busy = true;
  try {
    // 消す前に、この作品の保存先か ID を指すオートセーブ（保存していない編集）が残っているかを見ておく（消さない＝M-1 §4-4 の 6）
    const entries = await deps.port.autosaveList().catch(() => [] as SessionEntry[]);
    const peek = await deps.port.workPeek(ref.album, ref.name).catch(() => null);
    const kept = candidatesFor(entries, { album: ref.album, name: ref.name, workId: peek?.workId ?? null }).length > 0;
    if (sel.work && keyOf(sel.work) === keyOf(ref)) dropPreview();
    await deps.port.deleteWork(ref.album, ref.name);
    toast(kept ? mt("mb.lib.delete.autosaveKept.toast") : t("lib.delete.done.toast"));
  } catch (e) {
    deps.log(`[V225] delete-work refused ${refusalCode(e)}`);
    toast(t("lib.delete.failed.toast"));
  } finally {
    busy = false;
  }
  await refresh(null);
}

async function addAlbum(): Promise<void> {
  if (busy) return;
  closePop();
  const name = await askName({
    title: t("lib.album.add.msg"),
    label: mt("mb.lib.album.name.label"),
    value: "",
    okLabel: mt("mb.lib.album.add.btn"),
    refuse: (n) => (albumNameTaken(listing.albums, null, n) ? mt("mb.lib.album.taken.msg") : null),
  });
  if (name === null) return;
  busy = true;
  try {
    const made = await deps.port.createAlbum(name);
    sel = { album: made.album, work: sel.work };
  } catch (e) {
    deps.log(`[V225] create-album refused ${refusalCode(e)}`);
    toast(isRefusal(e, "name-taken") ? mt("mb.lib.album.taken.msg") : isRefusal(e, "bad-name") || isRefusal(e, "name-too-long") ? mt("mb.save.reason.name.msg") : mt("mb.lib.failed.toast"));
  } finally {
    busy = false;
  }
  await refresh(null);
}

async function renameAlbum(): Promise<void> {
  const a = sel.album;
  if (busy || !a) return;
  closePop();
  const name = await askName({
    title: t("lib.album.rename.msg"),
    label: mt("mb.lib.album.name.label"),
    value: a,
    okLabel: mt("mb.rename.ok.btn"),
    refuse: (n) => (albumNameTaken(listing.albums, a, n) ? mt("mb.lib.album.taken.msg") : null),
  });
  if (name === null || name === a) return;
  busy = true;
  const keep = sel.work;
  try {
    if (keep && keep.album === a) dropPreview();
    const placed = await deps.port.renameAlbum(a, name);
    sel = { album: placed.album, work: keep && keep.album === a ? { album: placed.album, name: keep.name } : keep };
    // 名前が変わったアルバムのサムネの控えは、鍵が変わるので捨てる
    for (const k of [...thumbs.keys()]) if (k.startsWith(`${a}\u0000`)) {
      const u = thumbs.get(k);
      if (u) URL.revokeObjectURL(u);
      thumbs.delete(k);
      peeks.delete(k);
    }
  } catch (e) {
    deps.log(`[V225] rename-album refused ${refusalCode(e)}`);
    toast(isRefusal(e, "name-taken") ? mt("mb.lib.album.taken.msg") : isRefusal(e, "bad-name") || isRefusal(e, "name-too-long") ? mt("mb.save.reason.name.msg") : mt("mb.lib.failed.toast"));
  } finally {
    busy = false;
  }
  await refresh(sel.work);
}

async function deleteAlbum(): Promise<void> {
  const a = sel.album;
  if (busy || !a) return;
  // 作品が入っているアルバムは消せない（薄く出し、押すと理由＝U-21）
  if ((albumCounts(listing.albums, listing.works).get(a) ?? 0) > 0) {
    toast(mt("mb.lib.album.notEmpty.toast"));
    return;
  }
  closePop();
  const ok = await openDialog({
    title: t("lib.album.delete.msg", { album: a }),
    dismiss: false,
    buttons: [
      { label: mt("mb.cancel.btn"), value: false },
      { label: mt("mb.lib.delete.btn"), value: true, kind: "warn" },
    ],
  });
  if (!ok.value) return;
  busy = true;
  try {
    await deps.port.deleteAlbum(a);
    toast(t("lib.delete.done.toast"));
  } catch (e) {
    deps.log(`[V225] delete-album refused ${refusalCode(e)}`);
    toast(isRefusal(e, "album-not-empty") ? mt("mb.lib.album.notEmpty.toast") : isRefusal(e, "album-has-files") ? mt("mb.lib.album.hasFiles.toast") : t("lib.delete.failed.toast"));
  } finally {
    busy = false;
  }
  await refresh(null);
}

// =====================================================================================
// 描く画面へ（仮の一覧〔V221〜V224〕の流れをそのまま移した＝呼ぶ口と順は同じ）
// =====================================================================================

/** 「開いています」（1 秒より長くかかるときだけ・UI §6-10: サムネ・「開いています（12コマ）」・進み具合の帯） */
function openingBox(ref: WorkRef | null): () => void {
  let box: HTMLElement | null = null;
  const timer = setTimeout(() => {
    const url = ref ? thumbs.get(keyOf(ref)) : null;
    const n = ref ? peeks.get(keyOf(ref)) : null;
    const pic = h("span", "mb-opening-pic");
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      pic.append(img);
    }
    const label = n ? t("ed.busy.loading.frames.label", { n }) : t("ed.busy.loading.label");
    box = h("div", "mb-scrim mb-ui", h("div", "mb-dialog mb-busybox mb-opening", pic, txt("mb-dialog-title", label), h("div", "mb-progress", h("span", "mb-progress-bar"))));
    box.setAttribute("role", "status");
    document.getElementById("mb-layer")?.append(box);
  }, 1000);
  return () => {
    clearTimeout(timer);
    box?.remove();
  };
}

async function openFailed(tooLarge: boolean, size: number): Promise<void> {
  await openDialog({
    title: tooLarge ? mt("mb.open.tooLarge.title") : mt("mb.open.failed.title"),
    titleIcon: "warn",
    body: [tooLarge ? mt("mb.open.tooLarge.msg", { size: formatSize(size) }) : t("lib.open.unreadable.msg")],
    buttons: [{ label: t("common.close.btn"), value: true }],
  });
}

async function openNew(): Promise<void> {
  if (screen || busy) return;
  closePop();
  dropPreview(); // 描く画面を開く前に、再生のために読んだ作品を手放す（2 つを同時に持たない）
  start(newSession(deps.port, hooks()), false);
}

function editSelected(): Promise<void> {
  return editWork(sel.work);
}

async function editWork(ref: WorkRef | null): Promise<void> {
  const w = workOf(ref);
  if (!ref || !w) return;
  await openWork(ref.album, ref.name, w.size);
}

/** その言語の月日と時分（開く前に聞く候補の札） */
function editTime(iso: unknown): string {
  const d = new Date(typeof iso === "string" || typeof iso === "number" ? iso : NaN);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(getLang(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

async function openWork(a: string, name: string, size: number): Promise<void> {
  if (screen || busy) return;
  closePop();
  busy = true;
  const ref = { album: a, name };
  sel = { album: search ? sel.album : a, work: ref };
  dropPreview(); // 描く画面を開く前に手放す
  const done = openingBox(ref);
  let got: Awaited<ReturnType<typeof readProject>>;
  try {
    got = await readProject(deps.port, a, name, hooks());
  } catch (e) {
    done();
    const tooLarge = isRefusal(e, "too-large") || isAllocFailure(e);
    deps.log(`[V221] open failed ${isRefusal(e, "too-large") ? "too-large" : isAllocFailure(e) ? "memory" : "unreadable"}`);
    try {
      await openFailed(tooLarge, size);
    } finally {
      busy = false;
    }
    // ★開けなかった作品を、再生のためにもう一度丸ごと読まない（L-4）。サムネと名前だけの形にする
    loadFailed = { ref, tooLarge };
    syncStage();
    return;
  }
  done();
  // ★busy は、描く画面を開く（start）か、やめるまで下ろさない（その間に別の作品を選んで読ませない・二重に開かせない）
  try {
    await openRead(ref, got);
  } finally {
    busy = false;
  }
}

/** 読めた作品を開く（候補が残っていれば先に聞く）。busy は呼ぶ側が持つ */
async function openRead(ref: WorkRef, got: Awaited<ReturnType<typeof readProject>>): Promise<void> {
  const entries = await deps.port.autosaveList().catch(() => [] as SessionEntry[]);
  const cands = candidatesFor(entries, { album: got.rw.album, name: got.rw.name, workId: readWorkId(got.project) });
  if (cands.length > 0) {
    // ★候補が残っている作品を開くときは先に聞く（M-1 §4-4 の 4。候補は新しい順）
    const r = await openDialog<number | "saved" | "cancel">({
      title: mt("mb.lib.openAsk.title"),
      titleIcon: "restore",
      body: [mt("mb.lib.openAsk.msg"), ...(cands.length > 1 ? [] : [txt("mb-chipname", mt("mb.lib.openAsk.item.label", { time: editTime(readStamp(cands[0].meta).savedAt) }))])],
      vertical: true,
      dismiss: "cancel",
      buttons: [
        ...cands.map((c, i) => ({
          label: cands.length > 1 ? `${mt("mb.lib.openAsk.restore.title")} — ${mt("mb.lib.openAsk.item.label", { time: editTime(readStamp(c.meta).savedAt) })}` : mt("mb.lib.openAsk.restore.title"),
          value: i as number | "saved" | "cancel",
          kind: (i === 0 ? "go" : "plain") as "go" | "plain",
        })),
        { label: mt("mb.lib.openAsk.saved.title"), value: "saved" },
        { label: mt("mb.cancel.btn"), value: "cancel" },
      ],
    });
    if (r.value === "cancel") {
      busy = false; // やめた＝ライブラリに戻る（選んだ作品を再生のために読み直す）
      void loadPreview(ref);
      return;
    }
    if (r.value === "saved") start(openSession(deps.port, got.project, got.rw, hooks()), false);
    else await restore(cands[r.value]);
    return;
  }
  start(openSession(deps.port, got.project, got.rw, hooks()), false);
}

async function restore(e: SessionEntry): Promise<void> {
  const done = openingBox(null);
  let s: MobileWorkSession | null = null;
  try {
    s = await restoreSession(deps.port, e, hooks());
  } catch (err) {
    done();
    await openFailed(isAllocFailure(err), 0);
    return;
  }
  done();
  if (!s) {
    await openFailed(false, 0);
    return;
  }
  dropPreview();
  start(s, true);
}

function start(s: MobileWorkSession, restored: boolean): void {
  if (screen) {
    // ★V226（独立レビューの指摘・高）: 描く画面がもう開いている。黙って置き換えない（前の画面の時計とセッションが残る）。オートセーブは消さない
    deps.log("[V226] start refused: editor already open");
    return;
  }
  dropPreview();
  if (theater) setTheater(false);
  settingsUi?.close();
  if (root) root.hidden = true;
  const host = h("div", "");
  deps.root.replaceChildren(host);
  deps.root.className = "";
  // ★Android の戻るボタン＝画面の［戻る］と同じ道（V224 の A-4 を引き継いだ）。確認やお知らせの箱が出ている間は何もしない（受けたことにする）。
  //  設定の画面が出ていれば、先に設定を閉じる。描く画面を閉じたら外す（ライブラリでは、ライブラリの手に戻る）。iOS では何もしない
  // ★V226 (B-1): 開いているものを先に 1 つ閉じる（箱 → 設定 → 一時的に開くもの → パネル → 島 → ［戻る］の道。順は android/backRules.ts）
  const editorBack = makeEditorBack({
    closeDialog: closeTopDialog,
    settingsShown: () => screen?.settingsShown() === true,
    closeSettings: () => screen?.closeSettings(),
    closeOne: () => screen?.editor.mbBackClose() ?? "busy",
    leave: async () => {
      await screen?.back();
    },
  });
  const unBack = registerBack(() => {
    editorBack.press();
    return true;
  });
  const sc = new WorkScreen(
    {
      port: deps.port,
      root: host,
      settings: deps.settings,
      albumHint: sel.album,
      version: deps.version,
      wire,
      closed: () => {
        unBack();
        const target = sc.session.target;
        screen = null;
        // 描いて保存した作品のサムネとコマの数は変わっているので、控えを捨てて読み直す
        if (target) {
          const k = keyOf({ album: target.album, name: target.name });
          const u = thumbs.get(k);
          if (u) URL.revokeObjectURL(u);
          thumbs.delete(k);
          peeks.delete(k);
        }
        deps.root.replaceChildren();
        // 設定は描く画面で変わっているかもしれない（並び順とたたむは変わらないが、読み直して揃える）
        readPrefs();
        if (root) root.hidden = false;
        render();
        // ★戻る先はライブラリ（その作品を選んだまま・一覧は取り直す）
        void refresh(target ? { album: target.album, name: target.name } : null);
      },
      log: (l) => deps.log(l),
    },
    s
  );
  screen = sc;
  sc.restored = restored;
  sc.open();
  deps.editorOpened?.(sc);
}

/** ★起動したときの復元の提案（新しい順に 1 つずつ・PC の 3 つのボタン。［破棄する］は確かめてから） */
async function propose(): Promise<void> {
  const list = proposals(await deps.port.autosaveList().catch(() => [] as SessionEntry[]));
  for (const e of list) {
    if (screen) return;
    const title = String(readStamp(e.meta).target ? readStamp(e.meta).target!.name.replace(/\.(memoanima|animemo)$/i, "") : e.meta.title ?? "");
    const r = await openDialog<"restore" | "later" | "discard">({
      title: t("lib.autosave.restore.label"),
      titleIcon: "restore",
      body: [mt("mb.restore.found.msg"), txt("mb-chipname", title)],
      vertical: true,
      buttons: [
        { label: t("lib.autosave.restore.btn"), value: "restore", kind: "go" },
        { label: t("lib.autosave.later.btn"), value: "later" },
        { label: t("lib.autosave.discard.btn"), value: "discard", kind: "warn" },
      ],
    });
    if (r.value === "restore") {
      // 復元して開いたら、残りは次に起動したときに出す（M-1 §4-4 の 8）
      // ★V226（独立レビューの指摘・高）: 読んでいる間は busy（その間に［新規メモ］や別の作品を開かせない＝描く画面を 2 つ作らない）
      if (screen || busy) return;
      busy = true;
      try {
        await restore(e);
      } finally {
        busy = false;
      }
      return;
    }
    if (r.value === "discard") {
      const ok = await openDialog({
        title: t("lib.autosave.discardConfirm.msg"),
        buttons: [
          { label: mt("mb.cancel.btn"), value: false },
          { label: t("lib.autosave.discard.btn"), value: true, kind: "warn" },
        ],
      });
      if (ok.value) {
        // ★オートセーブを消す道はここだけ（起動したときの提案の［破棄する］・確かめてから）。ほかは描く画面のセッションの中
        await deps.port.autosaveDelete(e.session, await deps.port.autosaveNextGen()).catch(() => deps.log("[V221] proposal-discard refused"));
      }
    }
  }
}

/** ★控えから戻す提案（L-11・PC と同じ文）。保存の途中で止まって、本体が無いのに控えがある作品 */
async function proposeRecover(): Promise<void> {
  if (screen) return;
  const items = await deps.port.recoverableList().catch(() => [] as RecoverableItem[]);
  if (items.length === 0 || screen) return;
  const lines = items.slice(0, 5).map((it) => t("lib.recover.item.msg", { name: displayName(it.name), album: it.album, size: formatSize(it.bakSize) }));
  if (items.length > 5) lines.push(t("lib.recover.more.msg", { count: items.length - 5 }));
  const r = await openDialog({
    title: t("lib.recover.ask.msg", { count: items.length }),
    body: lines.map((l) => txt("mb-dialog-body", l)),
    vertical: true,
    buttons: [
      { label: t("lib.recover.yes.btn"), value: true, kind: "go" },
      { label: t("lib.recover.no.btn"), value: false },
    ],
  });
  if (!r.value || busy || screen) return;
  let ok = 0;
  let failed = 0;
  busy = true; // 戻している間は、開く・選ぶ・消すを受けない
  try {
    for (const it of items) {
      try {
        await deps.port.recover(it.album, it.name);
        ok++;
      } catch (e) {
        failed++;
        deps.log(`[V225] recover refused ${refusalCode(e)}`);
      }
    }
  } finally {
    busy = false;
  }
  toast(failed ? t("lib.recover.partial.toast", { count: ok, failed }) : t("lib.recover.done.toast", { count: ok }));
  await refresh(null);
}

// =====================================================================================
// 設定・入口
// =====================================================================================

function readPrefs(): void {
  const ms = readMobileSettings(deps.settings);
  sort = ms.shelfSort;
  folded = ms.albumsFolded;
}

function openLibrarySettings(): void {
  if (settingsUi || screen || busy) return;
  closePop();
  preview.stop(true);
  if (root) root.inert = true;
  const open = (section?: Parameters<typeof openSettings>[0]["section"]) => {
    settingsUi = openSettings({
      from: "library",
      raw: deps.settings,
      version: deps.version,
      stats: libraryStats(listing.albums, listing.works),
      section,
      merge: (values) => {
        deps.port.settingsMerge(values).catch((e) => deps.log(`[V225] settings-merge refused ${refusalCode(e)}`));
      },
      applied: (c, now) => {
        applyAppSetting(c, now);
        if (c.id === "lang") {
          // 表示言語を替えたら、設定の画面とライブラリを組み直す（S-4）
          settingsUi?.rebuild();
          const hidden = root?.inert ?? false;
          build();
          if (root) root.inert = hidden;
          render();
          preview.draw(); // 組み直した canvas へ、いまのコマを描き直す
        }
      },
      closed: () => {
        settingsUi = null;
        if (root) root.inert = false;
        readPrefs();
        render();
      },
    });
  };
  open();
}

function leaveToDev(): void {
  if (screen || busy) return;
  dropPreview();
  settingsUi?.close();
  unBackLib?.();
  unBackLib = null;
  root?.remove();
  root = null;
  deps.exit?.();
}

/** 層（お知らせ・確認）を body に置く（描く画面の根の外＝ui/globalInput.ts が押す） */
export function ensureLayer(): HTMLElement {
  let layer = document.getElementById("mb-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "mb-layer";
    document.body.append(layer);
  }
  setDialogLayer(layer);
  installGlobalInput();
  return layer;
}

let lifeOn = false;

/** ★起動するとライブラリ（PC と同じ）。提案 → ライブラリ */
export async function startLibrary(d: LibraryDeps): Promise<void> {
  deps = d;
  ensureLayer();
  readPrefs();
  d.root.replaceChildren();
  if (!lifeOn) {
    lifeOn = true;
    await watchLifecycle({
      suspend: (from) => {
        if (screen) void screen.suspend(from);
        else preview.stop(true);
      },
      resume: () => {
        // 前に出てきた: 外（ファイル App など）で変わっていれば取り直す（iOS では visibilitychange が来ないので、Tauri の知らせで）
        if (!screen && root) void refreshIfChanged();
      },
    });
    window.addEventListener("resize", () => {
      if (!root || screen) return;
      closePop();
      place();
      renderOps();
      renderShelf();
    });
    // ハードウェアキーボード: Esc で、全画面 → 浮かぶもの の順に閉じる（設定と確認の箱は、それぞれが先に受ける）
    window.addEventListener("keydown", (e) => {
      if (e.code !== "Escape" || e.repeat || !root || screen || settingsUi || dialogOpen()) return;
      if (theater) setTheater(false);
      else if (pop) closePop();
    });
  }
  // ★Android の戻るボタン（V224 の A-4・L-13）: 全画面で見ている間は全画面をやめる・設定の画面が出ていれば設定を閉じる・
  //  浮かぶものを閉じる・どれでもなければ受けない（＝裏へ回す）。描く画面を開いている間は、描く画面の手が先に受ける
  unBackLib?.();
  // ★V226 (B-2): 箱 →［やめる］・開いている途中 → 何もしない・全画面 → 設定 → 浮かぶもの の順に 1 つ閉じる（順は android/backRules.ts）
  unBackLib = registerBack(
    () =>
      libraryBack({
        closeDialog: closeTopDialog,
        editing: () => screen !== null,
        busy: () => busy,
        theater: () => theater,
        closeTheater: () => setTheater(false),
        settingsShown: () => settingsUi !== null,
        closeSettings: () => settingsUi?.close(),
        popShown: () => pop !== null,
        closePop,
      }) !== "pass"
  );
  await refresh(null);
  await propose();
  await proposeRecover();
}

/** 確かめ画面と検査: いま開いている描く画面 */
export function currentScreen(): WorkScreen | null {
  return screen;
}

/** 確かめ画面の印のビルド: ライブラリの今（部品の矩形・倍率・描き直しの数・選択） */
export function libraryDebug(): string {
  if (!root) return "none";
  const rect = (el: HTMLElement | undefined) => {
    if (!el || el.hidden) return "-";
    const r = el.getBoundingClientRect();
    return `${Math.round(r.left * 2) / 2},${Math.round(r.top * 2) / 2},${Math.round(r.width * 2) / 2}x${Math.round(r.height * 2) / 2}`;
  };
  const s = screenSize();
  return `win=${s.w}x${s.h} shape=${layout?.kind ?? "guide"} folded=${folded ? 1 : 0} tight=${layout?.spacing.tight ? 1 : 0} scale=${layout?.scale ?? 0} rows=${layout?.opsRows ?? 0} albums=${rect(E.albums)} preview=${rect(E.preview)} ops=${rect(E.ops)} shelf=${rect(E.shelf)} paints=${preview.paints} awake=${preview.awakeCount()} playing=${preview.isPlaying() ? 1 : 0} works=${listing.works.length} sel=${sel.work ? 1 : 0} sort=${sort}`;
}

/** 確かめ画面の印のビルド: 数え（7 言語・端末の大きさ）のための口。印の無いビルドは呼ばない（＝出力に入らない） */
export function libraryDev(): {
  rebuild(): void;
  fold(v: boolean): void;
  pop(which: "move" | "more" | "sort" | "albums" | null): void;
  settings(): SettingsHandle | null;
  closeSettings(): void;
  root(): HTMLElement | null;
} {
  return {
    rebuild: () => {
      build();
      render();
      preview.draw();
    },
    fold: (v) => setFolded(v),
    pop: (which) => {
      closePop();
      if (which) openPop(which);
    },
    settings: () => {
      if (!settingsUi) openLibrarySettings();
      return settingsUi;
    },
    closeSettings: () => settingsUi?.close(),
    root: () => root,
  };
}
