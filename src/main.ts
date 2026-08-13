// アニメモ（AniMemo）フロントエンド エントリ（M3）
// 画面: ライブラリ（3カラム閲覧） ⇄ エディタ（ドット等倍）
// M0レガシーのフォルダ閲覧はM3で撤去（REQ v1.7 D-22）。

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { runGuide, GuideStep } from "./guide";
import { LibraryScreen, LibraryView } from "./library";
import { Editor, EditorSaveContext } from "./editor/editor";
import { newProject, UGO_COLORS, W, H, type Project } from "./editor/model";
import { importFlipnote } from "./editor/kwzImport";
import { projectFromBytes, projectToBytes } from "./editor/serialize";
import { frameToPngBlob, frameToImageBlob } from "./editor/render";
import {
  DEFAULT_CONVERT,
  convertToProject,
  frameToRgba,
  type ConvertOptions,
  type SourceImage,
} from "./editor/imageConvert";
import { createSlider } from "./ui/slider";
import {
  FrameSource,
  ExportFormat,
  ExportAudioSource,
  FORMAT_INFO,
  runExport,
  withRange,
} from "./editor/exporter";
import { mimeFromExt } from "./editor/audio";
// M11-10: ショートカット（コマンド定義・プリセット・キーの引き当て）
import {
  BUILTIN_PRESETS,
  COMMANDS,
  COMMAND_GROUPS,
  MAX_USER_PRESETS,
  activePreset,
  bindingFromEvent,
  defaultKeysSettings,
  findConflict,
  keyLabel,
  newPresetId,
  nextPresetName,
  reservedReason,
  sanitizeKeysSettings,
  type CommandId,
  type KeyBinding,
  type KeysSettings,
  type Preset,
} from "./keymap";

/** M7-2b: ディスプレイ設定（settings.json に永続化・起動時復元） */
type DisplaySettings = {
  mode?: "windowed" | "fullscreen" | "borderless";
  /** ウィンドウモード時のサイズ。"max"=画面に合わせる（最大化） */
  size?: [number, number] | "max";
};

type Settings = {
  libraryDir?: string;
  lastAlbum?: string;
  /** M7-2: 初回ガイド完了フラグ */
  guideDone?: boolean;
  /** M7-2b: ディスプレイ設定 */
  display?: DisplaySettings;
  /** M10-1c: 文字ツールの書体・サイズ・太さ（プロジェクトではなくアプリ設定側に置く。
   *  要件定義書 §7 のとおり PROJECT_VERSION は上げない） */
  text?: { family?: string; size?: number; bold?: boolean };
  /** M10-20: サムネ棚の並び順（省略・不正値は "manual"＝従来） */
  shelfSort?: "manual" | "name" | "date";
  /** M11-10: ショートカットの割り当て（追加のみ・壊れていても既定で起動する） */
  keys?: KeysSettings;
};

/** M7-2b: クレジット（後で差し替えやすいよう**この定数1箇所**に集約）。
 *  ★本名不使用（厳守・M7-2b改訂）: 配布物のどこにも本名を入れない。作者表記は「アルカナ (arcana)」のみ */
const CREDITS: string[] = [
  "企画・ディレクション・絵: アルカナ (arcana)（X: @Arcana_Proxy）",
  "素材や作品はこちら → BOOTH: https://shitamatsuge-com.booth.pm/",
  "開発: アルカナ (arcana)",
  "使用OSS: flipnote.js / ffmpeg.wasm / gif.js / UPNG.js / fflate / Tauri / PixiJS ほか",
  "本体は GNU GPL v3 以降で公開: https://github.com/OFF-Proxy/MemoAnima",
  "（ライセンス詳細は同梱の LICENSES.txt を参照）",
];

/** app_info の結果（設定メニューのバージョン表示に使い回す） */
let appInfoCache: { name: string; version: string; milestone: string } | null = null;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

let settings: Settings = {};
const library = new LibraryScreen();
const editor = new Editor();
let editorOpen = false;
/** M11-10: ショートカットの割り当て（settings.keys を正規化したもの） */
let keys: KeysSettings = defaultKeysSettings();

/** M11-10: いま有効な割り当てをエディタへ渡す（起動時・プリセット切替・変更のたび） */
function applyKeys() {
  editor.applyKeyPreset(activePreset(keys));
}

/** M11-10: 割り当てを settings.json へ保存する（失敗しても操作は続行できる） */
function saveKeys() {
  settings.keys = keys;
  invoke("save_settings", { settings }).catch(() => {});
}

// 開発用: ブラウザ検証からエディタ内部状態へアクセスするためのフック（本番ビルドでは無効）
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__animemo = { editor, library };
  void import("./editor/exporter").then((m) => {
    ((window as unknown as Record<string, unknown>).__animemo as Record<string, unknown>).exporter = m;
  });
  void import("./editor/audio").then((m) => {
    ((window as unknown as Record<string, unknown>).__animemo as Record<string, unknown>).audio = m;
  });
  // M8-1/2: 実機検証用（ネイティブのファイル選択を経ずに調整モーダルを開く）
  ((window as unknown as Record<string, unknown>).__animemo as Record<string, unknown>).imageImport =
    (paths: string[]) => openImageImportFlow(paths);
  ((window as unknown as Record<string, unknown>).__animemo as Record<string, unknown>).imageImportEditor =
    (path: string) => openImageImportFlowForEditor(path);
  // M10-14: ドロップ経路の実機検証用（onDragDropEvent と同じ handleDroppedPaths を通す）
  ((window as unknown as Record<string, unknown>).__animemo as Record<string, unknown>).dropFiles =
    (paths: string[]) => handleDroppedPaths(paths);
  // M11-11: 1コマ画像書き出しの検証用（ネイティブの保存ダイアログを経ずに Blob だけ作る）
  ((window as unknown as Record<string, unknown>).__animemo as Record<string, unknown>).imageBlob =
    frameToImageBlob;
}

// ---------------- モーダル / トースト ----------------

function toast(msg: string) {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/** M11-10: `build` の第2引数 `onClose` に後始末を登録できる（window に張ったリスナー等）。
 *  **どの閉じ方でも必ず呼ばれる**（ボタン・背景タップ・Escape）。既存の呼び出しは第2引数を
 *  使わないだけなので影響しない — window リスナーを張る画面が「閉じても外れない」事故を防ぐため */
function modal(
  build: (close: (v: any) => void, onClose: (fn: () => void) => void) => HTMLElement
): Promise<any> {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    const back = document.createElement("div");
    back.className = "modal-back";
    let cleanup: (() => void) | null = null;
    const close = (v: any) => {
      const fn = cleanup;
      cleanup = null;
      try {
        fn?.();
      } catch {
        /* 後始末の失敗で閉じられなくならないように */
      }
      back.remove();
      resolve(v);
    };
    const box = build(close, (fn) => {
      cleanup = fn;
    });
    box.classList.add("modal-box");
    back.appendChild(box);
    // M10-11: 背景タップで閉じる判定は **pointerdown**。mousedown だと Windows のペンで
    // パネルが即座に閉じる（ペンは長押し右クリック判定のため、マウス互換イベントを
    // ペンを離す瞬間まで遅延発行する。タップ→pointerdown でパネルが開く→離した瞬間に
    // 遅延 mousedown が背景へ届いて閉じてしまう）。pointer イベントは遅延しない。
    back.addEventListener("pointerdown", (e) => {
      if (e.target === back) close(null);
    });
    root.appendChild(back);
  });
}

// ---------------- M7-1 R-A: グローバル例外ハンドラ＋ローカルログ ----------------

/** エラーをローカルログへ（app_config_dir/logs/memoanima.log・送信機能なし）。失敗は握りつぶす */
function logError(kind: string, detail: string) {
  const line = `[${new Date().toISOString()}] [${kind}] ${detail}`;
  invoke("append_log", { text: line }).catch(() => {});
}

let errorDialogOpen = false;

/** 未捕捉エラーのダイアログ（白画面のまま死なない・詳細コピー可） */
function showErrorDialog(detail: string) {
  if (errorDialogOpen) return; // 連鎖エラーで多重表示しない
  if (!document.getElementById("modal-root")) return; // DOM構築前はログのみ
  errorDialogOpen = true;
  void modal((close) => {
    const box = document.createElement("div");
    box.innerHTML = `
      <p class="modal-msg"><b>⚠ 予期しないエラーが起きました</b><br>
      作業内容はオートセーブで保護されています。続行できない場合はアプリを再起動してください。</p>
      <pre class="err-detail"></pre>
      <div class="modal-actions">
        <button class="btn" id="err-copy">📋 詳細をコピー</button>
        <span style="flex:1"></span>
        <button class="btn primary" id="err-close">閉じる</button>
      </div>`;
    (box.querySelector(".err-detail") as HTMLElement).textContent = detail;
    (box.querySelector("#err-copy") as HTMLElement).addEventListener("click", () => {
      navigator.clipboard?.writeText(detail).then(
        () => toast("コピーしました"),
        () => toast("コピーに失敗しました")
      );
    });
    (box.querySelector("#err-close") as HTMLElement).addEventListener("click", () => {
      errorDialogOpen = false;
      close(null);
    });
    return box;
  }).then(() => {
    errorDialogOpen = false;
  });
}

window.addEventListener("error", (e) => {
  const detail = `${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}\n${(e.error as Error | undefined)?.stack ?? ""}`;
  logError("error", detail);
  showErrorDialog(detail);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason as unknown;
  const detail =
    r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r);
  logError("unhandledrejection", detail);
  showErrorDialog(detail);
});

function confirmDialog(msg: string): Promise<boolean> {
  return modal((close) => {
    const box = document.createElement("div");
    box.innerHTML = `<p class="modal-msg"></p>
      <div class="modal-actions">
        <button class="btn primary" data-v="1">はい</button>
        <button class="btn" data-v="0">いいえ</button>
      </div>`;
    (box.querySelector(".modal-msg") as HTMLElement).textContent = msg;
    box.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => close(b.dataset.v === "1"))
    );
    return box;
  }).then((v) => !!v);
}

function promptDialog(msg: string, def: string): Promise<string | null> {
  return modal((close) => {
    const box = document.createElement("div");
    box.innerHTML = `<p class="modal-msg"></p>
      <input class="modal-input" type="text" />
      <div class="modal-actions">
        <button class="btn primary" data-v="ok">OK</button>
        <button class="btn" data-v="cancel">キャンセル</button>
      </div>`;
    (box.querySelector(".modal-msg") as HTMLElement).textContent = msg;
    const input = box.querySelector(".modal-input") as HTMLInputElement;
    input.value = def;
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
    const ok = () => close(input.value.trim() || null);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok();
      if (e.key === "Escape") close(null);
    });
    (box.querySelector('[data-v="ok"]') as HTMLElement).addEventListener("click", ok);
    (box.querySelector('[data-v="cancel"]') as HTMLElement).addEventListener(
      "click",
      () => close(null)
    );
    return box;
  });
}

// ---------------- M6-1: エクスポート ----------------

/** Blob をユーザー選択パスへチャンク分割で書き出す（大容量対応） */
async function saveBlobToPath(path: string, blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 4 * 1024 * 1024;
  if (bytes.length === 0) {
    await invoke("export_write", { path, data: [], first: true });
    return;
  }
  for (let off = 0; off < bytes.length; off += CHUNK) {
    await invoke("export_write", {
      path,
      data: Array.from(bytes.subarray(off, off + CHUNK)),
      first: off === 0,
    });
  }
}

/** M10-7: 音声だけ抜き出す対象（動画＋AAC）。mp3/wav/ogg は従来経路のまま */
const EXTRACT_EXTS = ["m4a", "mp4", "mov", "webm", "mkv"];
/** M10-7: 抽出にかける入力の上限。**読み込む前に** Rust 側の metadata で判定する
 *  （読んでから捨てる形だと 1.1GB のファイルでアプリごと落ちた。572MB は成功） */
const EXTRACT_MAX_MB = 512;

/** M6-2: 音声ファイル（mp3/wav/ogg）を選んで読み込む。
 *  M10-7: 動画（mp4/mov/webm/mkv）と m4a も選べる。選ばれたら同梱 ffmpeg で
 *  音声だけを MP3 192kbps に抽出し、以降は mp3 を選んだ場合と同じ流れに乗せる。 */
async function pickAudioFile(): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
  const sel = await open({
    multiple: false,
    title: "音声・動画ファイルを選択（動画は音声だけ取り込みます）",
    filters: [
      { name: "音声", extensions: ["mp3", "wav", "ogg", "m4a"] },
      { name: "動画（音声を取り込み）", extensions: ["mp4", "mov", "webm", "mkv"] },
    ],
  });
  if (!sel || typeof sel !== "string") return null;
  const name = sel.split(/[\\/]/).pop() ?? "audio";
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  /** 埋め込みサイズのガード（.animemo 肥大・デコード/転送のメモリ対策）。
   *  抽出経路も同じガードを通す（192kbps なら 64MB ≒ 46分で実質かからないが経路は統一） */
  const sizeGuard = async (len: number): Promise<boolean> => {
    const mb = len / 1024 / 1024;
    if (mb > 64) {
      toast(`音声が大きすぎます（${mb.toFixed(0)}MB）。64MB以下のファイルを選んでください`);
      return false;
    }
    if (mb > 16) {
      return await confirmDialog(
        `音声が大きめです（${mb.toFixed(0)}MB）。プロジェクトファイルに埋め込まれるためファイルが肥大し、` +
          `保存・読み込みが重くなる場合があります。続行しますか？`
      );
    }
    return true;
  };

  // ---- M10-7: 動画 / m4a → 音声だけ抽出 ----
  if (EXTRACT_EXTS.includes(ext)) {
    let src: Uint8Array;
    try {
      // 生バイナリで受ける（Vec<u8> の JSON 配列では数百MBの動画は扱えない）。
      // サイズ判定は Rust 側で**読み込む前に**行う（読んでから捨てると 1GB 級で落ちる）
      const raw = await invoke<ArrayBuffer | Uint8Array | number[]>("read_file_raw", {
        path: sel,
        maxBytes: EXTRACT_MAX_MB * 1024 * 1024,
      });
      src =
        raw instanceof Uint8Array
          ? raw
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : new Uint8Array(raw as number[]);
    } catch (e) {
      const m = /TOO_LARGE:(\d+)/.exec(String(e));
      if (m) {
        const mb = Number(m[1]) / 1024 / 1024;
        toast(
          `動画が大きすぎます（${mb.toFixed(0)}MB）。${EXTRACT_MAX_MB}MB以下のファイルにしてください`
        );
        return null;
      }
      logError("audio", `動画の読み込みに失敗: ${e}`);
      toast(`ファイルを読み込めませんでした: ${e}`);
      return null;
    }
    toast("動画から音声を取り出しています…");
    let mp3: Uint8Array | null = null;
    try {
      const { extractAudioToMp3 } = await import("./editor/exporter");
      mp3 = await extractAudioToMp3(src, ext);
    } catch (e) {
      // 例外は上へ投げない（呼び出し元は null=キャンセルとして扱う）
      logError("audio", `音声抽出で例外: ${e}`);
      mp3 = null;
    }
    if (!mp3) {
      toast("この動画から音声を取り出せませんでした（音声トラックが無いか、未対応の形式です）");
      return null;
    }
    if (!(await sizeGuard(mp3.byteLength))) return null;
    return {
      bytes: mp3,
      mime: "audio/mpeg",
      name: name.replace(/\.[^.]+$/, "") + ".mp3",
    };
  }

  // ---- 既存経路（mp3 / wav / ogg）----
  // 判定の順序も内容も従来どおり（mimeFromExt → read_file_bytes → 64MB/16MB ガード）。
  // ガードだけ抽出経路と共有する sizeGuard に括り出してある（しきい値・文言・戻り値は同一）
  const mime = mimeFromExt(sel);
  if (!mime) {
    toast("対応形式は mp3 / wav / ogg / m4a と動画（mp4 / mov / webm / mkv）です");
    return null;
  }
  const bytes = await invoke<number[]>("read_file_bytes", { path: sel });
  if (!(await sizeGuard(bytes.length))) return null;
  return { bytes: new Uint8Array(bytes), mime, name };
}

/** エクスポートダイアログ（形式・倍率・範囲 → 進捗＋キャンセル → 保存）。
 *  M5-1: audioSrc=ExportAudioSource（範囲・モード確定後に最終ミックスをレンダして受け取る）。
 *  M6-4 P-6: MP4＋音声ありのとき「書き出す長さ」を選択（onSyncModeChange で呼び出し元へ書き戻し） */
function openExportDialog(
  source: FrameSource,
  baseName: string,
  defaultRange?: { a: number; b: number } | null,
  audioSrc?: ExportAudioSource | null,
  onSyncModeChange?: (m: "audioToAnim" | "animToAudio") => void
) {
  let running = false;
  return modal((close) => {
    const box = document.createElement("div");
    const fmtButtons = (Object.keys(FORMAT_INFO) as ExportFormat[])
      .map(
        (f) =>
          `<button type="button" class="lv${f === "mp4" ? " on" : ""}" data-f="${f}">${FORMAT_INFO[f].label}</button>`
      )
      .join("");
    const scaleButtons = [1, 2, 3, 4]
      .map(
        (n) =>
          `<button type="button" class="lv${n === 1 ? " on" : ""}" data-n="${n}">×${n}</button>`
      )
      .join("");
    box.innerHTML = `
      <p class="modal-msg"><b>⬇ 書き出し</b>　全${source.count}コマ・${source.fps}fps</p>
      <div class="modal-field"><span>形式</span><div class="oni" id="ex-fmt" style="flex:1;flex-wrap:wrap">${fmtButtons}</div></div>
      <p class="modal-path" id="ex-note"></p>
      <div class="modal-field"><span>倍率</span><div class="oni" id="ex-scale" style="flex:1">${scaleButtons}</div></div>
      <div class="modal-field"><span>背景</span>
        <div class="sw2" id="ex-whitebg"></div>
        <span style="font-weight:700;font-size:12px">背景を白にする</span>
      </div>
      <p class="modal-path">透過部分を白で塗ります（3DS本体の書き出しと同じ）。APNG で透過を残したい場合は OFF に。</p>
      <div class="modal-field"><span>範囲</span>
        <label style="font-weight:700;font-size:12px"><input type="radio" name="ex-range" value="all" checked> 全体</label>
        <label style="font-weight:700;font-size:12px"><input type="radio" name="ex-range" value="part"> 範囲</label>
        <input id="ex-a" type="number" min="1" max="${source.count}" value="${(defaultRange?.a ?? 0) + 1}" style="width:70px" disabled>
        〜
        <input id="ex-b" type="number" min="1" max="${source.count}" value="${(defaultRange?.b ?? source.count - 1) + 1}" style="width:70px" disabled>
      </div>
      <div id="ex-len-wrap" hidden>
        <div class="modal-field"><span>書き出す長さ</span>
          <div class="oni" style="flex:1;flex-wrap:wrap">
            <button type="button" class="lv" data-l="audioToAnim">アニメの長さで書き出す</button>
            <button type="button" class="lv" data-l="animToAudio">曲の長さで書き出す</button>
          </div>
        </div>
        <p class="modal-path" id="ex-len-note"></p>
      </div>
      <div id="ex-progress" hidden>
        <div class="bar"><i id="ex-bar" style="width:0%"></i></div>
        <p class="modal-path" id="ex-phase"></p>
      </div>
      <div class="modal-actions">
        <button class="btn primary" id="ex-go">書き出し</button>
        <button class="btn" id="ex-close">閉じる</button>
      </div>`;
    // 実行中は背面クリックで閉じない（modal共通ハンドラより先に capture で止める）
    // M10-17: modal() の閉じ判定は M10-11 で pointerdown 化済み — 止める側もそれに追従
    setTimeout(() => {
      const back = box.parentElement;
      back?.addEventListener(
        "pointerdown",
        (e) => {
          if (running && e.target === back) e.stopImmediatePropagation();
        },
        { capture: true }
      );
    }, 0);

    let format: ExportFormat = "mp4";
    let scale = 1;
    // M10-13: 「背景を白にする」。デフォルトは形式ごと（mp4/gif=ON・apng/pngzip=OFF）。
    // 形式を切り替えたら**その形式のデフォルトへリセット**する（APNG に切り替えたのに
    // 白が乗ったままで透過が失われる事故の防止。直前の操作より予測可能性を優先）
    const WHITEBG_DEFAULT: Record<ExportFormat, boolean> = {
      mp4: true,
      gif: true,
      apng: false,
      pngzip: false,
    };
    let whiteBg = WHITEBG_DEFAULT[format];
    const whiteBgEl = box.querySelector("#ex-whitebg") as HTMLElement;
    const syncWhiteBgUI = () => whiteBgEl.classList.toggle("on", whiteBg);
    whiteBgEl.addEventListener("click", () => {
      if (running) return;
      whiteBg = !whiteBg;
      syncWhiteBgUI();
    });
    syncWhiteBgUI();
    const noteEl = box.querySelector("#ex-note") as HTMLElement;
    const hasAudio = !!audioSrc && audioSrc.has && !audioSrc.allMuted;
    // P-6: 「書き出す長さ」（旧・調整パネルの長さ合わせ）。初期値は BGM の syncMode
    let syncMode: "audioToAnim" | "animToAudio" = audioSrc?.syncMode ?? "audioToAnim";
    const lenWrap = box.querySelector("#ex-len-wrap") as HTMLElement;
    const lenNote = box.querySelector("#ex-len-note") as HTMLElement;
    const updateLenUI = () => {
      lenWrap.hidden = !(format === "mp4" && hasAudio);
      box.querySelectorAll("[data-l]").forEach((b) =>
        b.classList.toggle("on", (b as HTMLElement).dataset.l === syncMode)
      );
      lenNote.textContent =
        syncMode === "animToAudio"
          ? "曲の長さに合わせてアニメをループします"
          : "音はアニメの長さに合わせてトリム/ループします";
    };
    box.querySelectorAll("[data-l]").forEach((b) =>
      b.addEventListener("click", () => {
        if (running) return;
        syncMode = (b as HTMLElement).dataset.l as "audioToAnim" | "animToAudio";
        onSyncModeChange?.(syncMode); // 次回も記憶（エディタ側で dirty）
        updateLenUI();
      })
    );
    const updateNote = () => {
      if (format === "mp4") {
        noteEl.textContent = hasAudio
          ? "音声付きで書き出します（BGM＋配置SEをミックス）"
          : audioSrc?.has && audioSrc.allMuted
            ? "音声はミュート中のため無音で書き出します"
            : "この作品に音声はありません（無音）";
      } else {
        noteEl.textContent =
          FORMAT_INFO[format].note ?? (hasAudio ? "この形式は無音です（音声はMP4のみ）" : "");
      }
      updateLenUI();
    };
    updateNote();
    box.querySelectorAll("#ex-fmt .lv").forEach((b) =>
      b.addEventListener("click", () => {
        if (running) return;
        format = (b as HTMLElement).dataset.f as ExportFormat;
        box.querySelectorAll("#ex-fmt .lv").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        whiteBg = WHITEBG_DEFAULT[format]; // M10-13: 形式のデフォルトへリセット
        syncWhiteBgUI();
        updateNote();
      })
    );
    box.querySelectorAll("#ex-scale .lv").forEach((b) =>
      b.addEventListener("click", () => {
        if (running) return;
        scale = Number((b as HTMLElement).dataset.n);
        box.querySelectorAll("#ex-scale .lv").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
      })
    );
    const aIn = box.querySelector("#ex-a") as HTMLInputElement;
    const bIn = box.querySelector("#ex-b") as HTMLInputElement;
    box.querySelectorAll('input[name="ex-range"]').forEach((r) =>
      r.addEventListener("change", () => {
        const part =
          (box.querySelector('input[name="ex-range"]:checked') as HTMLInputElement)
            .value === "part";
        aIn.disabled = !part;
        bIn.disabled = !part;
      })
    );
    if (defaultRange) {
      (box.querySelector('input[name="ex-range"][value="part"]') as HTMLInputElement).checked = true;
      aIn.disabled = false;
      bIn.disabled = false;
    }

    const cancel = { cancelled: false };
    const closeBtn = box.querySelector("#ex-close") as HTMLButtonElement;
    closeBtn.addEventListener("click", () => {
      if (running) {
        cancel.cancelled = true;
        closeBtn.disabled = true;
        closeBtn.textContent = "中断中…";
      } else {
        close(null);
      }
    });

    (box.querySelector("#ex-go") as HTMLButtonElement).addEventListener("click", async () => {
      if (running) return;
      running = true;
      const goBtn = box.querySelector("#ex-go") as HTMLButtonElement;
      goBtn.disabled = true;
      closeBtn.textContent = "キャンセル";
      const progress = box.querySelector("#ex-progress") as HTMLElement;
      progress.hidden = false;
      const bar = box.querySelector("#ex-bar") as HTMLElement;
      const phaseEl = box.querySelector("#ex-phase") as HTMLElement;
      try {
        const part =
          (box.querySelector('input[name="ex-range"]:checked') as HTMLInputElement)
            .value === "part";
        let src = source;
        let rangeSel: { a: number; b: number } | null = null;
        if (part) {
          const a = Math.max(1, Math.min(source.count, Number(aIn.value) || 1)) - 1;
          const b = Math.max(1, Math.min(source.count, Number(bIn.value) || source.count)) - 1;
          src = withRange(source, a, b);
          rangeSel = { a, b };
        }
        // M5-1: MP4 かつ音声ありなら最終ミックス（BGM＋SE）を1本レンダして mux へ渡す
        let exportAudio = null;
        if (format === "mp4" && hasAudio && audioSrc) {
          phaseEl.textContent = "音声ミックスを準備中…";
          progress.hidden = false;
          try {
            exportAudio = await audioSrc.build(rangeSel, syncMode);
          } catch (err) {
            toast(`音声のミックスに失敗したため無音で書き出します: ${err}`);
            exportAudio = null;
          }
        }
        const blob = await runExport(src, {
          format,
          scale,
          cancel,
          audio: exportAudio,
          whiteBg,
          onProgress: (done, total, phase) => {
            bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
            phaseEl.textContent = `${phase}… ${Math.min(done, total).toFixed(0)} / ${total}`;
          },
        });
        if (!blob || cancel.cancelled) {
          toast("書き出しを中断しました");
          close(null);
          return;
        }
        const info = FORMAT_INFO[format];
        const path = await save({
          title: "書き出し先を選択",
          defaultPath: `${baseName}.${info.ext}`,
          filters: [{ name: info.label, extensions: [info.ext] }],
        });
        if (!path || typeof path !== "string") {
          toast("保存先が選択されなかったため破棄しました");
          close(null);
          return;
        }
        phaseEl.textContent = "ファイルへ書き込み中…";
        await saveBlobToPath(path, blob);
        toast(`書き出しました: ${path}`);
        close(true);
      } catch (e) {
        toast(`書き出しに失敗: ${e}`);
        running = false;
        goBtn.disabled = false;
        closeBtn.disabled = false;
        closeBtn.textContent = "閉じる";
        progress.hidden = true;
      }
    });
    return box;
  });
}

/** M11-11: いま見ているコマ1枚を画像で保存する。
 *  **アニメの書き出し（openExportDialog）とは別のダイアログ**にしている。あちらは
 *  範囲・音声・長さ合わせ・進捗という「動画/連番のための UI」で構成されていて、
 *  1枚書き出しには要らないものばかり。同じ箱に入れると半分を隠すことになり分かりにくい。 */
function openImageExportDialog(p: Project, frameIndex: number, baseName: string) {
  return modal((close) => {
    const box = document.createElement("div");
    const scaleButtons = [1, 2, 4, 8]
      .map(
        (n) =>
          `<button type="button" class="lv${n === 1 ? " on" : ""}" data-n="${n}">×${n}</button>`
      )
      .join("");
    box.innerHTML = `
      <p class="modal-msg"><b>🖼 画像で保存</b>　いま見ているコマ（${frameIndex + 1}コマ目）だけを1枚の画像にします</p>
      <div class="modal-field"><span>形式</span>
        <div class="oni" id="ie-fmt" style="flex:1">
          <button type="button" class="lv on" data-f="png">PNG</button>
          <button type="button" class="lv" data-f="jpeg">JPEG</button>
        </div>
      </div>
      <div class="modal-field"><span>大きさ</span><div class="oni" id="ie-scale" style="flex:1">${scaleButtons}</div></div>
      <div class="modal-field" id="ie-tr-row"><span>背景</span>
        <div class="sw2" id="ie-transparent"></div>
        <span style="font-weight:700;font-size:12px">背景を透明にする（PNG のみ）</span>
      </div>
      <p class="modal-path" id="ie-note"></p>
      <div class="modal-actions">
        <button class="btn primary" id="ie-go">保存…</button>
        <button class="btn" id="ie-close">閉じる</button>
      </div>`;
    let format: "png" | "jpeg" = "png";
    let scale = 1;
    let transparent = false;
    const noteEl = box.querySelector("#ie-note") as HTMLElement;
    const trRow = box.querySelector("#ie-tr-row") as HTMLElement;
    const trEl = box.querySelector("#ie-transparent") as HTMLElement;
    const goBtn = box.querySelector("#ie-go") as HTMLButtonElement;
    const sync = () => {
      box
        .querySelectorAll("#ie-fmt .lv")
        .forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.f === format));
      box
        .querySelectorAll("#ie-scale .lv")
        .forEach((b) => b.classList.toggle("on", Number((b as HTMLElement).dataset.n) === scale));
      trEl.classList.toggle("on", transparent && format === "png");
      trRow.hidden = format !== "png"; // JPEG は透過を持てないので行ごと隠す
      noteEl.textContent =
        `${W * scale}×${H * scale} ピクセルで保存します（ドット等倍の拡大・なましなし）。` +
        (format === "png"
          ? transparent
            ? "紙の色は入らず、描いた所だけが残ります。"
            : "紙の色ごと保存します。"
          : "JPEG は透明を持てないため、紙の色ごと保存します。");
    };
    box.querySelectorAll("#ie-fmt .lv").forEach((b) =>
      b.addEventListener("click", () => {
        format = (b as HTMLElement).dataset.f as "png" | "jpeg";
        sync();
      })
    );
    box.querySelectorAll("#ie-scale .lv").forEach((b) =>
      b.addEventListener("click", () => {
        scale = Number((b as HTMLElement).dataset.n);
        sync();
      })
    );
    trEl.addEventListener("click", () => {
      transparent = !transparent;
      sync();
    });
    (box.querySelector("#ie-close") as HTMLElement).addEventListener("click", () => close(null));
    goBtn.addEventListener("click", async () => {
      goBtn.disabled = true;
      try {
        const ext = format === "png" ? "png" : "jpg";
        // 既定のファイル名は「作品名_p03」＝あとから見てどのコマか分かる形
        const defName = `${baseName}_p${String(frameIndex + 1).padStart(3, "0")}.${ext}`;
        const path = await save({
          title: "画像の保存先を選択",
          defaultPath: defName,
          filters: [{ name: format === "png" ? "PNG 画像" : "JPEG 画像", extensions: [ext] }],
        });
        if (!path || typeof path !== "string") {
          toast("保存先が選択されなかったため中止しました");
          goBtn.disabled = false;
          return;
        }
        noteEl.textContent = "画像を作っています…";
        const blob = await frameToImageBlob(p, frameIndex, {
          scale,
          type: format === "png" ? "image/png" : "image/jpeg",
          transparent,
        });
        if (!blob) throw new Error("画像を作れませんでした");
        await saveBlobToPath(path, blob);
        toast(`保存しました: ${path}`);
        close(true);
      } catch (e) {
        toast(`画像の保存に失敗: ${e}`);
        goBtn.disabled = false;
        sync();
      }
    });
    sync();
    return box;
  });
}

// ---------------- 画面切替 ----------------

function showLibrary() {
  if (editorOpen) {
    editor.unmount();
    editorOpen = false;
  }
  $("#screen-editor").hidden = true;
  $("#screen-library").hidden = false;
  library.refresh();
}

/** M11-3: 移動先アルバムのピッカー（「📁 移動」用）。保存先ピッカーの簡易版で、
 *  ドラッグが使えない/使いにくい場面の代替導線。null=キャンセル */
async function pickAlbum(
  albums: string[],
  current: string,
  title: string
): Promise<string | null> {
  // 今いるアルバムは選んでも何も起きないので候補から外す（押しても無反応、を作らない）
  const list = albums.filter((a) => a !== current);
  if (list.length === 0) {
    toast("移動先になる別のアルバムがありません（先にアルバムを作ってください）");
    return null;
  }
  return modal((close) => {
    const box = document.createElement("div");
    box.innerHTML = `
      <p class="modal-msg"><b>📁 移動先を選ぶ</b><br><span id="pa-title"></span></p>
      <div class="modal-field"><span>アルバム</span>
        <select id="pa-album">${list.map(() => `<option></option>`).join("")}</select>
      </div>
      <div class="modal-actions">
        <button class="btn primary" id="pa-ok">移動</button>
        <button class="btn" id="pa-cancel">キャンセル</button>
      </div>`;
    (box.querySelector("#pa-title") as HTMLElement).textContent = title;
    const sel = box.querySelector("#pa-album") as HTMLSelectElement;
    // option の textContent は（保存先ピッカーと同じく）エスケープのため後から代入
    Array.from(sel.options).forEach((o, i) => {
      o.textContent = list[i];
      o.value = list[i];
    });
    sel.value = list[0];
    (box.querySelector("#pa-ok") as HTMLElement).addEventListener("click", () =>
      close(sel.value)
    );
    (box.querySelector("#pa-cancel") as HTMLElement).addEventListener("click", () => close(null));
    return box;
  });
}

/** F-4: 保存先ピッカー（既存アルバム一覧＋新規フォルダ作成＋ファイル名＋保存先パス表示） */
async function pickSaveTarget(
  defaultAlbum: string,
  defaultName: string
): Promise<{ album: string; baseName: string } | null> {
  let albums: string[] = [];
  try {
    albums = await invoke<string[]>("list_albums", { libRoot: settings.libraryDir });
  } catch {
    /* Tauri外（dev）では空 */
  }
  const def =
    defaultAlbum === "未分類" && settings.lastAlbum && albums.includes(settings.lastAlbum)
      ? settings.lastAlbum
      : defaultAlbum;
  if (!albums.includes(def)) albums.unshift(def);
  return modal((close) => {
    const box = document.createElement("div");
    box.innerHTML = `
      <p class="modal-msg"><b>💾 保存先を選ぶ</b></p>
      <div class="modal-field"><span>アルバム</span>
        <select id="ps-album">${albums
          .map((a) => `<option${a === def ? " selected" : ""}></option>`)
          .join("")}</select>
        <button class="minibtn" id="ps-newalbum" type="button">＋ 新規フォルダ</button>
      </div>
      <div class="modal-field"><span>ファイル名</span><input id="ps-name" type="text" /></div>
      <p class="modal-path" id="ps-path"></p>
      <div class="modal-actions">
        <button class="btn primary" id="ps-ok">保存</button>
        <button class="btn" id="ps-cancel">キャンセル</button>
      </div>`;
    const sel = box.querySelector("#ps-album") as HTMLSelectElement;
    // option の textContent はエスケープのため後から代入
    Array.from(sel.options).forEach((o, i) => {
      o.textContent = albums[i];
      o.value = albums[i];
    });
    const nameInput = box.querySelector("#ps-name") as HTMLInputElement;
    nameInput.value = defaultName;
    const pathEl = box.querySelector("#ps-path") as HTMLElement;
    const updatePath = () => {
      const nm = (nameInput.value.trim() || defaultName).replace(/\.(memoanima|animemo)$/i, "");
      pathEl.textContent = `保存先: ${settings.libraryDir ?? ""}\\${sel.value}\\${nm}.memoanima`;
    };
    sel.addEventListener("change", updatePath);
    nameInput.addEventListener("input", updatePath);
    updatePath();
    (box.querySelector("#ps-newalbum") as HTMLElement).addEventListener("click", async () => {
      const name = await promptDialog("新しいフォルダ名", "新しいアルバム");
      if (!name) return;
      try {
        const created = await invoke<string>("create_album", {
          libRoot: settings.libraryDir,
          name,
        });
        const o = document.createElement("option");
        o.value = created;
        o.textContent = created;
        sel.appendChild(o);
        sel.value = created;
        updatePath();
      } catch (e) {
        toast(String(e));
      }
    });
    (box.querySelector("#ps-ok") as HTMLElement).addEventListener("click", () => {
      const baseName = (nameInput.value.trim() || defaultName).replace(/\.(memoanima|animemo)$/i, "");
      close({ album: sel.value, baseName });
    });
    (box.querySelector("#ps-cancel") as HTMLElement).addEventListener("click", () =>
      close(null)
    );
    return box;
  });
}

// ---------------- M8-1: 📷 画像を取り込む（さつえいGUI） ----------------

/** 画像ファイル→RGBA（canvasデコード・長辺4096超は事前縮小=メモリ保護） */
async function decodeImageFile(path: string): Promise<SourceImage> {
  const bytes = await invoke<number[]>("read_file_bytes", { path });
  const blob = new Blob([new Uint8Array(bytes)]);
  const bmp = await createImageBitmap(blob);
  const MAXSIDE = 4096;
  const scale = Math.min(1, MAXSIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  return { w, h, data };
}

/** ライブラリ経路（新規メモとして取り込む）。
 *  M8-2b でライブラリ画面の📷ボタンを撤去したため **UIからは到達しない**（写真機能はエディタ専用）。
 *  モーダル共用部ごと残置＝ボタン1行の再追加で復活できる（指示書 M8-2b の方針）。
 *  現状の到達経路は DEV 限定フック `__animemo.imageImport` のみ（本番ビルドでは削除される）。 */
async function openImageImportFlow(paths?: string[]) {
  if (!settings.libraryDir) {
    toast("先にライブラリフォルダを設定してください（⚙）");
    return;
  }
  let sel: string[] | string | null = paths ?? null;
  if (!sel) {
    sel = await open({
      multiple: true,
      title: "取り込む画像を選択（複数=ページ送りのアニメ背景）",
      filters: [{ name: "画像 (png/jpg)", extensions: ["png", "jpg", "jpeg"] }],
    });
  }
  if (!sel) return;
  const files = Array.isArray(sel) ? sel : [sel];
  if (!files.length) return;
  const images: SourceImage[] = [];
  for (const f of files) {
    try {
      images.push(await decodeImageFile(f));
    } catch (e) {
      toast(`読み込めませんでした: ${f.split(/[\\/]/).pop()}（${e}）`);
    }
  }
  if (!images.length) return;
  const defaultTitle = stripExt(files[0].split(/[\\/]/).pop() ?? "画像取り込み");
  await openImageImportDialog(images, defaultTitle);
}

/** M8-2: エディタ📷入口（1枚のみ → 調整 → 現在ページへ浮動配置） */
async function openImageImportFlowForEditor(path?: string) {
  let sel: string | string[] | null = path ?? null;
  if (!sel) {
    sel = await open({
      multiple: false,
      title: "このページに配置する画像を選択（1枚）",
      filters: [{ name: "画像 (png/jpg)", extensions: ["png", "jpg", "jpeg"] }],
    });
  }
  if (!sel || typeof sel !== "string") return;
  let image: SourceImage;
  try {
    image = await decodeImageFile(sel);
  } catch (e) {
    toast(`読み込めませんでした: ${sel.split(/[\\/]/).pop()}（${e}）`);
    return;
  }
  const info = editor.placementInfo();
  await openImageImportDialog([image], stripExt(sel.split(/[\\/]/).pop() ?? "画像"), {
    layerName: info.layerName,
    frameNo: info.frameNo,
    onPlace: (proj, transparentPaper) => editor.placeConvertedImage(proj, transparentPaper),
  });
}

/** M8-2: エディタから開いたときの文脈（「このページに配置」モード） */
interface EditorImportCtx {
  layerName: string;
  frameNo: number;
  onPlace: (proj: ReturnType<typeof convertToProject>, transparentPaper: boolean) => void;
}

/** 調整モーダル（リアルタイムプレビュー＋モードタブ3つ・ライブラリ/エディタ共用）。
 *  ライブラリ: F-4ピッカー → 新規メモ保存 ／ エディタ(editorCtx): 現在ページへ浮動配置 */
function openImageImportDialog(
  images: SourceImage[],
  defaultTitle: string,
  editorCtx?: EditorImportCtx
) {
  const o: ConvertOptions = { ...DEFAULT_CONVERT, title: defaultTitle };
  let page = 0;
  let busy = false;
  let transparentPaper = true; // M8-2: 紙色を透過（既定ON）
  return modal((close) => {
    const box = document.createElement("div");
    box.classList.add("imgimp-box");
    const inkSwatches = Object.values(UGO_COLORS);
    const paperSwatches = ["#ffffff", "#fbefd6", "#9aa4b2", "#141414"];
    const fpsChoices = [1, 2, 4, 6, 8, 12];
    const headNote = editorCtx
      ? `配置先: いま選択中のレイヤー「${escapeHtml(editorCtx.layerName)}」（コマ ${editorCtx.frameNo}）`
      : `${images.length}枚 → ${images.length}ページ${images.length > 1 ? "（アニメ背景）" : ""}`;
    box.innerHTML = `
      <p class="modal-msg"><b>📷 画像を取り込む</b>　${headNote}</p>
      ${editorCtx ? `<p class="modal-path">複数ページのアニメ背景にしたいときは、ライブラリ画面の📷（新規メモとして取り込み→ページコピー）を使ってください。</p>` : ""}
      <div class="imgimp">
        <div class="imgimp-left">
          <canvas id="ii-cv" width="${W}" height="${H}"></canvas>
          <div class="imgimp-pager" id="ii-pager" ${images.length > 1 ? "" : "hidden"}>
            <button class="minibtn" id="ii-prev" type="button">◀</button>
            <span id="ii-pageno">1 / ${images.length}</span>
            <button class="minibtn" id="ii-next" type="button">▶</button>
          </div>
        </div>
        <div class="imgimp-right">
          <div class="modal-field"><span>モード</span><div class="oni" id="ii-mode" style="flex:1">
            <button type="button" class="lv on" data-m="color">カラー</button>
            <button type="button" class="lv" data-m="tone">トーン（さつえい）</button>
            <button type="button" class="lv" data-m="lineart">線画</button>
          </div></div>
          <div id="ii-sec-color">
            <div class="modal-field"><span>パレット</span><div class="oni" id="ii-pal" style="flex:1">
              <button type="button" class="lv on" data-p="auto">おまかせ</button>
              <button type="button" class="lv" data-p="ugo">うごメモ6色</button>
              <button type="button" class="lv" data-p="retro">レトロ14色</button>
            </div></div>
            <div class="modal-field" id="ii-colors-row"><span>色数 <b id="ii-colors-v">${o.colors}</b></span><div class="ii-sl" id="ii-colors"></div></div>
            <div class="modal-field"><span>ディザ</span><div class="oni" id="ii-dither" style="flex:1">
              <button type="button" class="lv on" data-d="fs">なめらか</button>
              <button type="button" class="lv" data-d="ordered">網点</button>
              <button type="button" class="lv" data-d="none">なし</button>
            </div></div>
          </div>
          <div id="ii-sec-tone" hidden>
            <div class="modal-field"><span>しきい値 <b id="ii-thr-v">${o.threshold}</b></span><div class="ii-sl" id="ii-thr"></div></div>
            <div class="modal-field"><span>ディザ量 <b id="ii-amt-v">${o.ditherAmt}</b></span><div class="ii-sl" id="ii-amt"></div></div>
          </div>
          <div id="ii-sec-line" hidden>
            <div class="modal-field"><span>輪郭の強さ <b id="ii-edge-v">${o.edge}</b></span><div class="ii-sl" id="ii-edge"></div></div>
          </div>
          <div id="ii-inkrow" hidden>
            <div class="modal-field"><span>インク色</span><div class="ii-swatches" id="ii-ink">
              ${inkSwatches.map((c) => `<button type="button" class="ii-sw${c === o.ink ? " on" : ""}" data-c="${c}" style="background:${c}"></button>`).join("")}
              <input type="color" id="ii-ink-custom" value="${o.ink}" title="好きな色">
            </div></div>
            <div class="modal-field"><span>反転</span><button type="button" class="lv" id="ii-invert">◱ 明暗反転</button></div>
          </div>
          <div class="modal-field"><span>明るさ <b id="ii-br-v">0</b></span><div class="ii-sl" id="ii-br"></div></div>
          <div class="modal-field"><span>コントラスト <b id="ii-ct-v">0</b></span><div class="ii-sl" id="ii-ct"></div></div>
          <div class="modal-field"><span>おさめ方</span><div class="oni" id="ii-fit" style="flex:1">
            <button type="button" class="lv on" data-f="cover">画面いっぱい</button>
            <button type="button" class="lv" data-f="contain">全体を入れる（余白=紙）</button>
          </div></div>
          <div class="modal-field"><span>紙の色</span><div class="ii-swatches" id="ii-paper">
            ${paperSwatches.map((c) => `<button type="button" class="ii-sw${c === o.paper ? " on" : ""}" data-c="${c}" style="background:${c}"></button>`).join("")}
            <input type="color" id="ii-paper-custom" value="${o.paper}" title="好きな色">
          </div></div>
          <div class="modal-field" ${images.length > 1 ? "" : "hidden"}><span>速さ</span><div class="oni" id="ii-fps" style="flex:1">
            ${fpsChoices.map((f) => `<button type="button" class="lv${f === o.fps ? " on" : ""}" data-fps="${f}">${f}fps</button>`).join("")}
          </div></div>
          ${editorCtx ? `<div class="modal-field"><span>紙色を透過</span><button type="button" class="lv on" id="ii-transparent" title="紙色の画素を透明にして、いまの絵の上に重ねられるようにする">ON（絵の上に重ねる）</button></div>` : ""}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn primary" id="ii-ok">${editorCtx ? "このページに配置" : "取り込む"}</button>
        <button class="btn" id="ii-cancel">キャンセル</button>
      </div>`;

    const q = <T extends HTMLElement = HTMLElement>(s: string) =>
      box.querySelector(s) as T;
    const cv = q<HTMLCanvasElement>("#ii-cv");
    const cctx = cv.getContext("2d")!;

    // ---- リアルタイムプレビュー（100ms debounce） ----
    let timer: number | undefined;
    const render = () => {
      const proj = convertToProject(images, o);
      const rgba = frameToRgba(proj, Math.min(page, proj.frames.length - 1));
      cctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
      q("#ii-pageno").textContent = `${page + 1} / ${images.length}`;
    };
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = window.setTimeout(render, 100);
    };

    // ---- モードタブ・セクション表示 ----
    const syncSections = () => {
      q("#ii-sec-color").hidden = o.mode !== "color";
      q("#ii-sec-tone").hidden = o.mode !== "tone";
      q("#ii-sec-line").hidden = o.mode !== "lineart";
      q("#ii-inkrow").hidden = o.mode === "color";
      q("#ii-colors-row").hidden = o.palette !== "auto";
    };
    const bindGroup = (sel: string, attr: string, fn: (v: string) => void) => {
      q(sel)
        .querySelectorAll<HTMLButtonElement>(".lv")
        .forEach((b) =>
          b.addEventListener("click", () => {
            q(sel).querySelectorAll(".lv").forEach((x) => x.classList.remove("on"));
            b.classList.add("on");
            fn(b.dataset[attr]!);
            syncSections();
            schedule();
          })
        );
    };
    bindGroup("#ii-mode", "m", (v) => (o.mode = v as ConvertOptions["mode"]));
    bindGroup("#ii-pal", "p", (v) => (o.palette = v as ConvertOptions["palette"]));
    bindGroup("#ii-dither", "d", (v) => (o.dither = v as ConvertOptions["dither"]));
    bindGroup("#ii-fit", "f", (v) => (o.fit = v as ConvertOptions["fit"]));
    bindGroup("#ii-fps", "fps", (v) => (o.fps = Number(v)));

    // ---- スライダー（共通部品） ----
    const addSlider = (
      host: string,
      valEl: string,
      min: number,
      max: number,
      value: number,
      fn: (v: number) => void
    ) => {
      const s = createSlider({
        min,
        max,
        value,
        onInput: (v) => {
          q(valEl).textContent = String(v);
          fn(v);
          schedule();
        },
      });
      s.root.style.flex = "1";
      q(host).appendChild(s.root);
    };
    addSlider("#ii-colors", "#ii-colors-v", 8, 64, o.colors, (v) => (o.colors = v));
    addSlider("#ii-thr", "#ii-thr-v", 0, 100, o.threshold, (v) => (o.threshold = v));
    addSlider("#ii-amt", "#ii-amt-v", 0, 100, o.ditherAmt, (v) => (o.ditherAmt = v));
    addSlider("#ii-edge", "#ii-edge-v", 0, 100, o.edge, (v) => (o.edge = v));
    addSlider("#ii-br", "#ii-br-v", -100, 100, o.brightness, (v) => (o.brightness = v));
    addSlider("#ii-ct", "#ii-ct-v", -100, 100, o.contrast, (v) => (o.contrast = v));

    // ---- 色スウォッチ（インク/紙） ----
    const bindSwatches = (host: string, custom: string, fn: (c: string) => void) => {
      q(host)
        .querySelectorAll<HTMLButtonElement>(".ii-sw")
        .forEach((b) =>
          b.addEventListener("click", () => {
            q(host).querySelectorAll(".ii-sw").forEach((x) => x.classList.remove("on"));
            b.classList.add("on");
            fn(b.dataset.c!);
            schedule();
          })
        );
      q<HTMLInputElement>(custom).addEventListener("input", (e) => {
        q(host).querySelectorAll(".ii-sw").forEach((x) => x.classList.remove("on"));
        fn((e.target as HTMLInputElement).value);
        schedule();
      });
    };
    bindSwatches("#ii-ink", "#ii-ink-custom", (c) => (o.ink = c));
    bindSwatches("#ii-paper", "#ii-paper-custom", (c) => (o.paper = c));

    q("#ii-invert").addEventListener("click", () => {
      o.invert = !o.invert;
      q("#ii-invert").classList.toggle("on", o.invert);
      schedule();
    });

    // M8-2: 紙色を透過（エディタ文脈のみ・配置時に適用。プレビューは紙色表示のまま）
    if (editorCtx) {
      q("#ii-transparent").addEventListener("click", () => {
        transparentPaper = !transparentPaper;
        q("#ii-transparent").classList.toggle("on", transparentPaper);
        q("#ii-transparent").textContent = transparentPaper
          ? "ON（絵の上に重ねる）"
          : "OFF（背景として敷く）";
      });
    }

    // ---- ページ送り ----
    q("#ii-prev").addEventListener("click", () => {
      page = (page - 1 + images.length) % images.length;
      render();
    });
    q("#ii-next").addEventListener("click", () => {
      page = (page + 1) % images.length;
      render();
    });

    // ---- 取り込む → エディタ: 現在ページへ浮動配置 ／ ライブラリ: F-4ピッカー → 新規メモ ----
    q("#ii-ok").addEventListener("click", async () => {
      if (busy) return;
      if (editorCtx) {
        busy = true;
        try {
          const proj = convertToProject([images[0]], o);
          close(true);
          editorCtx.onPlace(proj, transparentPaper);
        } catch (e) {
          toast(`配置に失敗: ${e}`);
          busy = false;
        }
        return;
      }
      const target = await pickSaveTarget("未分類", o.title || defaultTitle);
      if (!target) return;
      busy = true;
      (q("#ii-ok") as HTMLButtonElement).disabled = true;
      try {
        const proj = convertToProject(images, { ...o, title: target.baseName });
        const bytes = await projectToBytes(proj);
        // サムネ（1ページ目・320×240 PNG）
        const tcv = document.createElement("canvas");
        tcv.width = W;
        tcv.height = H;
        tcv
          .getContext("2d")!
          .putImageData(new ImageData(new Uint8ClampedArray(frameToRgba(proj, 0)), W, H), 0, 0);
        const thumbBlob = await new Promise<Blob | null>((r) => tcv.toBlob(r, "image/png"));
        const thumb = thumbBlob ? new Uint8Array(await thumbBlob.arrayBuffer()) : new Uint8Array();
        // M10-23: number[] JSON をやめ raw ボディで送る（保存系3経路の統一）
        await invoke<string>(
          "save_project_raw",
          packRawSave(
            { libRoot: settings.libraryDir, album: target.album, name: target.baseName },
            [bytes, thumb]
          )
        );
        settings.lastAlbum = target.album;
        invoke("save_settings", { settings }).catch(() => {});
        toast(`取り込みました: ${target.album} / ${target.baseName}.memoanima`);
        close(true);
        library.refresh();
      } catch (e) {
        toast(`取り込みに失敗: ${e}`);
        busy = false;
        (q("#ii-ok") as HTMLButtonElement).disabled = false;
      }
    });
    q("#ii-cancel").addEventListener("click", () => close(null));

    syncSections();
    render();
    return box;
  });
}

/** M10-23: 保存系 IPC の raw ボディ封筒を組む。number[] JSON（1バイト→数文字）を
 *  IPC に通すと 300ページ級で invoke だけで約0.7秒メインスレッドを塞ぐ実測だったため、
 *  Tauri v2 の raw ボディ（invoke に Uint8Array を渡す）で送る。
 *  形式: [u32 metaLen LE][meta JSON utf8]（[u32 partLen LE][part] × n）。
 *  封じ込め・原子的置換・サニタイズは Rust 側の既存実装をそのまま使う（解析後に委譲）。 */
function packRawSave(meta: Record<string, unknown>, parts: Uint8Array[]): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  // u32 長接頭辞の折り返し（≥4GiB で setUint32 が下位32bitに丸まる）を決定的に遮断
  //（現実の .memoanima では到達しない理論値ガード — レビュー指摘）
  for (const p of [metaBytes, ...parts]) {
    if (p.length > 0xffffffff) throw new Error("保存データが大きすぎます");
  }
  let total = 4 + metaBytes.length;
  for (const p of parts) total += 4 + p.length;
  const body = new Uint8Array(total);
  const dv = new DataView(body.buffer);
  let o = 0;
  dv.setUint32(o, metaBytes.length, true);
  o += 4;
  body.set(metaBytes, o);
  o += metaBytes.length;
  for (const p of parts) {
    dv.setUint32(o, p.length, true);
    o += 4;
    body.set(p, o);
    o += p.length;
  }
  return body;
}

function showEditor(
  project: ReturnType<typeof newProject>,
  ctx: EditorSaveContext | null,
  opts: { askSaveTarget?: boolean } = {}
) {
  // M11-6: 二重 mount を構造的に不可能にする。ウィンドウへのドロップ →「編集」は
  // showLibrary() を通らずにここへ来るため、mount() が二重に走り、
  // autosaveTimer（15秒間隔）と ResizeObserver が二重化していた。
  // ※ 未保存の確認は呼び出し側の責任（キャンセルされたら開かないため。
  //   editor.confirmLeave() を通すこと）
  if (editorOpen) {
    editor.unmount();
    editorOpen = false;
  }
  library.suspend();
  $("#screen-library").hidden = true;
  $("#screen-editor").hidden = false;
  editorOpen = true;
  // M10-1c: 文字ツールの書体・サイズ・太さを settings.json から復元（不正値は既定へ）
  editor.restoreTextSettings(settings.text);
  editor.mount(
    project,
    ctx,
    {
      onExit: () => showLibrary(),
      onSaved: () => {
        /* ライブラリへ戻ったときに refresh される */
      },
      // M8-2: 📷 このページに配置
      importImage: () => void openImageImportFlowForEditor(),
      // M10-1c: 文字設定は変えた瞬間に保存する（display と同じ流儀）
      onTextSettingsChange: (t) => {
        settings.text = t;
        invoke("save_settings", { settings }).catch(() => {});
      },
      saveProject: async (c, data, thumb) => {
        const libRoot = c.libRoot || settings.libraryDir!;
        c.libRoot = libRoot;
        // M10-23: number[] JSON をやめ raw ボディで送る（保存処理そのものは Rust 側の
        // 既存 pclib::save_project がそのまま担う）
        const path = await invoke<string>(
          "save_project_raw",
          packRawSave({ libRoot, album: c.album, name: c.baseName }, [data, thumb])
        );
        // 最後に使ったアルバムを記憶（次回ピッカーの既定に）
        settings.lastAlbum = c.album;
        invoke("save_settings", { settings }).catch(() => {});
        return path;
      },
      pickSaveTarget,
      autosave: async (data, meta) => {
        // M10-23: raw ボディ（AMAS1 の組み立て・原子的置換は Rust 側の既存実装のまま）
        await invoke("save_autosave_raw", packRawSave(meta, [data]));
      },
      clearAutosave: async () => {
        await invoke("clear_autosave");
      },
      openExport: (source, baseName, defaultRange, audio, onSyncModeChange) =>
        void openExportDialog(source, baseName, defaultRange, audio, onSyncModeChange),
      // M11-11: 1コマだけの画像書き出し（アニメの書き出しとは別ダイアログ）
      openImageExport: (proj, frameIndex, baseName) =>
        void openImageExportDialog(proj, frameIndex, baseName),
      pickAudioFile,
      confirm: confirmDialog,
      prompt: promptDialog,
      toast,
      // M10-21: 入力診断ログ（editor がフラグ時のみ呼ぶ。ローカルの memoanima.log へ）
      appendLog: (text: string) =>
        invoke("append_log", { text: `[${new Date().toISOString()}]\n${text}` }).catch(() => {}),
    },
    opts
  );
}

// ---------------- エディタ入口 ----------------

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

async function openEditorWithNote(item: LibraryView) {
  try {
    toast("読み込み中…");
    const bytes = await invoke<number[]>("read_file_bytes", { path: item.path });
    const { project } = await importFlipnote(
      new Uint8Array(bytes).buffer,
      item.name
    );
    showEditor(project, {
      libRoot: settings.libraryDir!,
      album: item.album,
      baseName: stripExt(item.name),
    });
  } catch (e) {
    toast(`開けませんでした: ${e}`);
  }
}

async function openEditorWithProject(item: LibraryView) {
  try {
    const bytes = await invoke<number[]>("read_file_bytes", { path: item.path });
    const project = await projectFromBytes(new Uint8Array(bytes));
    showEditor(project, {
      libRoot: settings.libraryDir!,
      album: item.album,
      baseName: stripExt(item.name),
    });
  } catch (e) {
    toast(`開けませんでした: ${e}`);
  }
}

function newNote(album: string) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
  const project = newProject(`新規メモ ${stamp}`);
  // F-4: 新規メモは初回保存時に必ず保存先ピッカーを出す（既定=開いていたアルバム）
  showEditor(
    project,
    {
      libRoot: settings.libraryDir!,
      album,
      baseName: `memo-${stamp}`,
    },
    { askSaveTarget: true }
  );
}

/** F-3: 起動時にオートセーブがあれば復元を提案する */
async function checkAutosave() {
  let payload: { meta: any; data: number[]; path: string } | null = null;
  try {
    payload = await invoke("load_autosave");
  } catch {
    return;
  }
  if (!payload) return;
  const title = payload.meta?.title ?? "無題";
  // 3値: "restore" / "discard" / null（背面クリック等）。
  // null では絶対に消さない（誤クリックで唯一の復元データを失わない — Codexレビュー指摘#5）
  const choice = await modal((close) => {
    const box = document.createElement("div");
    box.innerHTML = `
      <p class="modal-msg"><b>🛟 前回の編集を復元しますか？</b><br>
      保存されていない編集データが見つかりました:「<span id="as-title"></span>」<br>
      <span class="modal-path"></span></p>
      <div class="modal-actions">
        <button class="btn primary" data-v="restore">復元して開く</button>
        <button class="btn" data-v="discard">破棄する</button>
        <button class="btn" data-v="">あとで</button>
      </div>`;
    (box.querySelector("#as-title") as HTMLElement).textContent = title;
    (box.querySelector(".modal-path") as HTMLElement).textContent =
      `場所: ${payload!.path}`;
    box.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => close(b.dataset.v || null))
    );
    return box;
  });
  if (choice === "discard") {
    const sure = await confirmDialog("復元データを完全に破棄します。よろしいですか？");
    if (sure) await invoke("clear_autosave").catch(() => {});
    return;
  }
  if (choice !== "restore") return; // 「あとで」/背面クリック → 何もしない（次回起動時に再提示）
  try {
    const project = await projectFromBytes(new Uint8Array(payload.data));
    const meta = payload.meta ?? {};
    // ライブラリフォルダが当時と違う場合は保存先を信用せず、ピッカーを必ず出す
    // （別ライブラリの同名ファイルへの上書きを防ぐ — Codexレビュー指摘#2）
    const libMatches = !meta.libRoot || meta.libRoot === settings.libraryDir;
    const ctx =
      meta.album && meta.baseName && libMatches
        ? {
            libRoot: settings.libraryDir!,
            album: String(meta.album),
            baseName: String(meta.baseName),
          }
        : null;
    showEditor(project, ctx, {
      askSaveTarget: ctx == null ? true : (meta.askSaveTarget ?? false),
    });
    editor.dirty = true; // 復元直後から未保存扱い（オートセーブ継続）
  } catch (e) {
    toast(`復元に失敗しました: ${e}`);
  }
}

// ---------------- M7-2b: ディスプレイ設定・設定メニュー ----------------

/** 表示モード/サイズを適用（破損値は既定へ＝M7-1の回復方針）。
 *  M7-2d: 失敗は無言にしない——notify 時はエラートーストを出し false を返す
 *  （呼び出し元がUIモード表示を実状態へ戻す）。drag-region 等のDOM切替は**API成功後のみ** */
async function applyDisplaySettings(d?: DisplaySettings, notify = false): Promise<boolean> {
  const mode =
    d?.mode === "fullscreen" || d?.mode === "borderless" ? d.mode : "windowed";
  const size: [number, number] | "max" | null =
    d?.size === "max"
      ? "max"
      : Array.isArray(d?.size) &&
          d.size.length === 2 &&
          d.size.every((n) => typeof n === "number" && n >= 640 && n <= 8192)
        ? [d.size[0], d.size[1]]
        : null;
  try {
    const win = getCurrentWindow();
    if (mode === "fullscreen") {
      await win.setDecorations(true);
      await win.setFullscreen(true);
    } else if (mode === "borderless") {
      await win.setFullscreen(false);
      await win.setDecorations(false);
      await win.maximize();
    } else {
      await win.setFullscreen(false);
      await win.setDecorations(true);
      if (size === "max") {
        await win.maximize();
      } else if (size) {
        await win.unmaximize();
        await win.setSize(new LogicalSize(size[0], size[1]));
      }
    }
    // ボーダーレス中は枠が無くドラッグ移動できないため、ヘッダーを掴めるようにする
    // （ボタン類は子要素なのでクリックはそのまま効く）。⚙も常に開ける＝詰みなし。
    // M7-2d: 権限が整った今は「API成功後のみ」切り替えるのが正（無言のUI先行を廃止）
    document.querySelectorAll(".topbar, .edbar").forEach((el) => {
      if (mode === "borderless") el.setAttribute("data-tauri-drag-region", "");
      else el.removeAttribute("data-tauri-drag-region");
    });
    return true;
  } catch (e) {
    logError("display", `ディスプレイ設定の適用に失敗: ${e}`);
    if (notify) toast(`ディスプレイ設定の適用に失敗: ${e}`);
    return false;
  }
}

/** M7-2b: ⚙ 設定メニュー（エクスプローラー直結を廃止し、ここから各設定へ） */
async function openSettingsMenu() {
  await modal((close, onClose) => {
    const box = document.createElement("div");
    box.className = "settings-menu";
    const curMode = settings.display?.mode ?? "windowed";
    const curSize =
      settings.display?.size === "max"
        ? "max"
        : Array.isArray(settings.display?.size)
          ? settings.display!.size.join("x")
          : "1280x800";
    const ver = appInfoCache?.version ?? "?";
    box.innerHTML = `
      <p class="modal-msg"><b>⚙ 設定</b></p>
      <div class="set-sec">
        <b>📁 ライブラリフォルダ</b>
        <p class="modal-path" id="set-dir-path"></p>
        <button class="minibtn" id="set-dir">変更…</button>
      </div>
      <div class="set-sec">
        <b>🖥 ディスプレイ設定</b>
        <div class="modal-field"><span>モード</span>
          <div class="oni" style="flex:1" id="set-modes">
            <button type="button" class="lv" data-mode="windowed">ウィンドウ</button>
            <button type="button" class="lv" data-mode="fullscreen">フルスクリーン</button>
            <button type="button" class="lv" data-mode="borderless">ボーダーレス</button>
          </div>
        </div>
        <div class="modal-field"><span>サイズ</span>
          <div class="oni" style="flex:1" id="set-sizes">
            <button type="button" class="lv" data-size="1280x800">1280×800</button>
            <button type="button" class="lv" data-size="1600x900">1600×900</button>
            <button type="button" class="lv" data-size="1920x1080">1920×1080</button>
            <button type="button" class="lv" data-size="max">画面に合わせる</button>
          </div>
        </div>
        <p class="hintline" id="set-size-hint">サイズはウィンドウモードのときに使えます</p>
      </div>
      <div class="set-sec">
        <b>⌨ ショートカットキー</b>
        <p class="modal-path" id="set-keys-cur"></p>
        <button class="minibtn" id="set-keys">割り当てを見る・変える…</button>
      </div>
      <div class="set-sec">
        <button class="minibtn" id="set-guide">🛟 ガイドをもう一度見る</button>
      </div>
      <div class="set-sec">
        <b>ℹ バージョン情報</b>
        <p class="modal-path">メモアニマ (MemoAnima) v${ver}<br>作者: アルカナ (arcana)&nbsp;&nbsp;X: @Arcana_Proxy</p>
        <div class="legal-note">
          <p>本ソフトは個人制作の非公式・非営利ファンツールです。任天堂株式会社およびその関連会社とは一切関係がなく、許諾・後援・提携を受けたものではありません。</p>
          <p>本ソフトが扱うのは、利用者ご自身が作成した作品データです。ゲームソフトを動作させる機能はありません。暗号の解除も行いません。第三者の作品をインターネット等から取得・配信する機能もありません。読み込めるのは、お手元のPCにあるファイルだけです。任天堂株式会社が権利を有するプログラム・画像・音声・データ・鍵等は含まれていません。</p>
          <p>「ニンテンドー3DS」「うごくメモ帳」「Flipnote Studio」は任天堂株式会社の商標または登録商標です。対応形式の説明目的でのみ言及しています。</p>
          <p>本アプリはインターネット通信を一切行いません。</p>
          <p>本ソフト本体のソースコードは GNU GPL v3 以降で公開しています（入手先: https://github.com/OFF-Proxy/MemoAnima）。同梱フォントは対象外で、それぞれのライセンスに従います。あなたが作成した作品にこのライセンスは及びません。</p>
          <p>権利に関するお問い合わせ → aru.oribo@gmail.com ／ X @Arcana_Proxy</p>
        </div>
        <p class="credits">${CREDITS.map((c) => escapeHtml(c)).join("<br>")}</p>
      </div>
      <div class="modal-actions">
        <button class="btn" id="set-quit">🚪 アプリを終了</button>
        <span style="flex:1"></span>
        <button class="btn primary" id="set-close">閉じる</button>
      </div>`;
    (box.querySelector("#set-dir-path") as HTMLElement).textContent =
      settings.libraryDir ?? "（未設定）";
    const syncButtons = () => {
      const mode = settings.display?.mode ?? "windowed";
      box.querySelectorAll("#set-modes .lv").forEach((b) =>
        b.classList.toggle("on", (b as HTMLElement).dataset.mode === mode)
      );
      const sizeKey =
        settings.display?.size === "max"
          ? "max"
          : Array.isArray(settings.display?.size)
            ? settings.display!.size.join("x")
            : "1280x800";
      const sizesEnabled = mode === "windowed";
      box.querySelectorAll("#set-sizes .lv").forEach((b) => {
        b.classList.toggle("on", sizesEnabled && (b as HTMLElement).dataset.size === sizeKey);
        (b as HTMLButtonElement).disabled = !sizesEnabled;
      });
      (box.querySelector("#set-size-hint") as HTMLElement).hidden = sizesEnabled;
    };
    void curMode;
    void curSize;
    syncButtons();
    // M7-2d: 適用に失敗したら設定を元へ戻してUI表示も実状態と同期（無言失敗の廃止）。
    // 保存は成功時のみ（効かないモードを永続化しない）
    const changeDisplay = async (next: DisplaySettings) => {
      const prev = settings.display;
      settings.display = next;
      const ok = await applyDisplaySettings(next, true);
      if (!ok) {
        settings.display = prev;
      } else {
        invoke("save_settings", { settings }).catch(() => {});
      }
      syncButtons();
    };
    box.querySelectorAll("#set-modes .lv").forEach((b) =>
      b.addEventListener("click", () => {
        const mode = (b as HTMLElement).dataset.mode as DisplaySettings["mode"];
        void changeDisplay({ ...(settings.display ?? {}), mode });
      })
    );
    box.querySelectorAll("#set-sizes .lv").forEach((b) =>
      b.addEventListener("click", () => {
        const key = (b as HTMLElement).dataset.size!;
        const size: DisplaySettings["size"] =
          key === "max" ? "max" : (key.split("x").map(Number) as [number, number]);
        void changeDisplay({ ...(settings.display ?? {}), mode: "windowed", size });
      })
    );
    (box.querySelector("#set-dir") as HTMLElement).addEventListener("click", async () => {
      close(null);
      if (await chooseLibraryDir()) {
        await library.mount(settings.libraryDir!, libraryCallbacks);
        toast(`ライブラリ: ${settings.libraryDir}`);
      }
    });
    (box.querySelector("#set-keys-cur") as HTMLElement).textContent =
      `いま使っている組み合わせ: ${activePreset(keys).name}`;
    (box.querySelector("#set-keys") as HTMLElement).addEventListener("click", () => {
      close(null);
      void openKeymapSettings();
    });
    (box.querySelector("#set-guide") as HTMLElement).addEventListener("click", () => {
      close(null);
      void startGuideFlow(true);
    });
    (box.querySelector("#set-quit") as HTMLElement).addEventListener("click", async () => {
      if (editorOpen && editor.dirty) {
        const ok = await confirmDialog(
          "保存していない変更があります。破棄してアプリを終了しますか？"
        );
        if (!ok) return;
      }
      close(null);
      try {
        await getCurrentWindow().close();
      } catch {
        window.close();
      }
    });
    (box.querySelector("#set-close") as HTMLElement).addEventListener("click", () =>
      close(null)
    );
    // Esc で閉じる（外クリックは modal() 既存挙動）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    // M11-10: 閉じ方によらず必ず外す（ボタンや背景タップで閉じたときに残っていた）
    onClose(() => window.removeEventListener("keydown", onKey, true));
    return box;
  });
}

// ---------------- M11-10: ショートカットの設定画面 ----------------

/** いま選んでいるプリセット（組み込みは編集不可） */
function currentPreset(): Preset {
  return activePreset(keys);
}

/** 組み込みを選んでいる状態で編集しようとしたときの誘導。複製したら true */
async function ensureEditablePreset(): Promise<boolean> {
  const cur = currentPreset();
  if (!cur.builtin) return true;
  const ok = await confirmDialog(
    `「${cur.name}」は組み込みのため編集できません。複製して編集しますか？`
  );
  if (!ok) return false;
  return duplicateCurrentPreset();
}

/** 今のプリセットを複製して、それを有効にする */
async function duplicateCurrentPreset(): Promise<boolean> {
  if (keys.presets.length >= MAX_USER_PRESETS) {
    await confirmDialog(
      `自分で作れる組み合わせは ${MAX_USER_PRESETS} 組までです。どれかを削除してから作ってください。`
    );
    return false;
  }
  const cur = currentPreset();
  const id = newPresetId(keys.presets);
  const name = nextPresetName([...BUILTIN_PRESETS, ...keys.presets]);
  keys.presets.push({ id, name, bindings: structuredClone(cur.bindings) });
  keys.activeId = id;
  applyKeys();
  saveKeys();
  return true;
}

/** 次に押されたキーの組み合わせを1つ受け取る（Escape で取消＝null）。
 *  戻り値の `cancel` を呼ぶと**待ちを打ち切ってリスナーを外す**（画面を閉じたときに必ず呼ぶこと。
 *  外し忘れると、閉じたあとの打鍵を capture で食べてしまう） */
function captureKey(): { promise: Promise<KeyBinding | null>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<KeyBinding | null>((resolve) => {
    const finish = (v: KeyBinding | null) => {
      window.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      // 修飾キー単体は待ち続ける（Ctrl だけ押した状態で確定させない）
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return;
      e.preventDefault();
      e.stopPropagation();
      finish(e.code === "Escape" ? null : bindingFromEvent(e));
    };
    cancel = () => finish(null);
    window.addEventListener("keydown", onKey, true);
  });
  return { promise, cancel };
}

async function openKeymapSettings() {
  await modal((close, onClose) => {
    const box = document.createElement("div");
    box.className = "settings-menu keymap-menu";
    box.innerHTML = `
      <p class="modal-msg"><b>⌨ ショートカットキー</b></p>
      <div class="set-sec">
        <div class="modal-field"><span>組み合わせ</span>
          <select id="km-preset" style="flex:1"></select>
        </div>
        <div class="km-ops">
          <button class="minibtn" id="km-dup">複製して新規</button>
          <button class="minibtn" id="km-rename">名前を変更</button>
          <button class="minibtn danger" id="km-del">削除</button>
        </div>
        <p class="hintline" id="km-note"></p>
      </div>
      <div class="km-list" id="km-list"></div>
      <div class="modal-actions">
        <span style="flex:1"></span>
        <button class="btn primary" id="km-close">閉じる</button>
      </div>`;
    const listEl = box.querySelector("#km-list") as HTMLElement;
    const selEl = box.querySelector("#km-preset") as HTMLSelectElement;
    const noteEl = box.querySelector("#km-note") as HTMLElement;
    let capturing = false;
    /** キー入力待ちを打ち切る関数（画面を閉じるときに必ず呼ぶ） */
    let cancelCapture: (() => void) | null = null;

    const render = () => {
      const cur = currentPreset();
      const all = [...BUILTIN_PRESETS, ...keys.presets];
      selEl.innerHTML = all
        .map(
          (p) =>
            `<option value="${escapeHtml(p.id)}"${p.id === cur.id ? " selected" : ""}>${escapeHtml(
              p.name
            )}${p.builtin ? "（組み込み）" : ""}</option>`
        )
        .join("");
      noteEl.textContent = cur.builtin
        ? "組み込みの組み合わせは編集できません。変更するときは「複製して新規」を押してください。"
        : "行の「変更」を押して、割り当てたいキーを押してください（Esc で取消）。";
      (box.querySelector("#km-rename") as HTMLButtonElement).disabled = !!cur.builtin;
      (box.querySelector("#km-del") as HTMLButtonElement).disabled = !!cur.builtin;
      listEl.innerHTML = "";
      for (const group of COMMAND_GROUPS) {
        const h = document.createElement("div");
        h.className = "km-group";
        h.textContent = group;
        listEl.appendChild(h);
        for (const c of COMMANDS.filter((x) => x.group === group)) {
          const b = cur.bindings[c.id as CommandId];
          const row = document.createElement("div");
          row.className = "km-row";
          row.dataset.cmd = c.id;
          const label = keyLabel(b);
          row.innerHTML = `
            <span class="km-name">${escapeHtml(c.label)}${
              (c as { note?: string }).note
                ? `<em>${escapeHtml((c as { note?: string }).note!)}</em>`
                : ""
            }</span>
            <span class="km-key${label ? "" : " none"}">${escapeHtml(label || "未割り当て")}</span>
            <button class="minibtn km-set">変更</button>
            <button class="minibtn km-clr"${label ? "" : " disabled"}>消す</button>`;
          listEl.appendChild(row);
        }
      }
    };

    const setBinding = async (cmd: CommandId, b: KeyBinding | null) => {
      // 予約キーは**プリセットに関係なく**断る（複製へ誘導する前に判定する。
      // でないと「複製しますか？→ はい →（複製された）→ でもそのキーは使えません」になる）
      if (b) {
        const reserved = reservedReason(b.code);
        if (reserved) {
          await confirmDialog(reserved);
          render();
          return;
        }
      }
      if (!(await ensureEditablePreset())) {
        render();
        return;
      }
      const cur = currentPreset(); // 複製後の実体を取り直す
      if (b) {
        const conflict = findConflict(cur, b, cmd);
        if (conflict) {
          const other = COMMANDS.find((c) => c.id === conflict);
          const ok = await confirmDialog(
            `${keyLabel(b)} は「${other?.label ?? conflict}」に割り当てられています。置き換えますか？`
          );
          if (!ok) {
            render();
            return;
          }
          delete cur.bindings[conflict];
        }
        cur.bindings[cmd] = b;
      } else {
        delete cur.bindings[cmd];
      }
      applyKeys();
      saveKeys();
      render();
    };

    listEl.addEventListener("click", (ev) => {
      const el = ev.target as HTMLElement;
      const row = el.closest(".km-row") as HTMLElement | null;
      if (!row) return;
      const cmd = row.dataset.cmd as CommandId;
      if (el.classList.contains("km-clr")) {
        void setBinding(cmd, null);
        return;
      }
      if (!el.classList.contains("km-set") || capturing) return;
      capturing = true;
      const keyEl = row.querySelector(".km-key") as HTMLElement;
      const prev = keyEl.textContent;
      keyEl.textContent = "キーを押してください…";
      keyEl.classList.add("waiting");
      const cap = captureKey();
      cancelCapture = cap.cancel;
      void cap.promise.then(async (b) => {
        cancelCapture = null;
        capturing = false;
        keyEl.classList.remove("waiting");
        if (!b) {
          keyEl.textContent = prev;
          return;
        }
        await setBinding(cmd, b);
      });
    });

    selEl.addEventListener("change", () => {
      keys.activeId = selEl.value;
      applyKeys();
      saveKeys();
      render();
    });
    (box.querySelector("#km-dup") as HTMLElement).addEventListener("click", () => {
      void duplicateCurrentPreset().then((ok) => {
        if (ok) render();
      });
    });
    (box.querySelector("#km-rename") as HTMLElement).addEventListener("click", () => {
      const cur = currentPreset();
      if (cur.builtin) return;
      void promptDialog("組み合わせの名前", cur.name).then((v) => {
        if (!v) return;
        cur.name = v.slice(0, 40);
        saveKeys();
        render();
      });
    });
    (box.querySelector("#km-del") as HTMLElement).addEventListener("click", () => {
      const cur = currentPreset();
      if (cur.builtin) return;
      void confirmDialog(`「${cur.name}」を削除しますか？`).then((ok) => {
        if (!ok) return;
        keys.presets = keys.presets.filter((p) => p.id !== cur.id);
        keys.activeId = "standard";
        applyKeys();
        saveKeys();
        render();
      });
    });
    (box.querySelector("#km-close") as HTMLElement).addEventListener("click", () => close(null));
    // 設定画面自体のキー操作は割り当ての対象外として常に効く（キー取得中は取得側が優先）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !capturing) {
        e.stopPropagation();
        close(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    // **どの閉じ方でも**キー入力待ちと Escape 監視を必ず外す（閉じたあとの打鍵を食べないように）
    onClose(() => {
      cancelCapture?.();
      cancelCapture = null;
      capturing = false;
      window.removeEventListener("keydown", onKey, true);
    });
    render();
    return box;
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------- M7-2: 初回ガイド ----------------

/** ガイド本編（中立文言・M7-1準拠。対象が無い画面では文字のみで成立） */
function guideSteps(): GuideStep[] {
  return [
    {
      title: "メモアニマへようこそ！",
      text: "3DSのお絵かきアニメ作品をPCで編集・書き出しできる、非公式・非営利のファンツールです。元のデータは読み取りのみで、絶対に書き換えません。",
    },
    {
      title: "ライブラリフォルダ",
      text: "作品のコピーを保存するPC上のフォルダを決めます（SDカード自体は選ばないでください）。⚙設定の「ライブラリフォルダ」からいつでも変更できます。",
      target: "#lib-change-dir",
    },
    {
      title: "3DS作品の取り込み",
      text: "SDカードの保存フォルダ（private → …3DS → app → JKZJ）、またはそのコピーを選ぶと、作品がライブラリへコピーされます。元のファイルはそのまま残ります。",
      target: "#lib-import",
    },
    {
      title: "編集",
      text: "作品をダブルクリックすると編集画面が開きます。ペン・ブラシ（トーン）・レイヤー・♪音声は左右のパネルにあります。",
      target: "#shelf-grid",
    },
    {
      title: "書き出し",
      text: "MP4 / GIF / APNG / PNG連番で書き出せます。作品を選んで「⬇ 書き出し」、または編集画面の右上からどうぞ。完成したらここから！",
      target: "#stage-meta .chip.export",
    },
  ];
}

let guideRunning = false;

/** ガイド再生（manual=設定メニューからの再表示）。完了/スキップで guideDone を保存 */
async function startGuideFlow(manual: boolean) {
  if (guideRunning) return;
  guideRunning = true;
  try {
    await runGuide(guideSteps());
  } finally {
    guideRunning = false;
  }
  if (!settings.guideDone) {
    settings.guideDone = true;
    invoke("save_settings", { settings }).catch(() => {});
  }
  void manual;
}

// ---------------- 起動 ----------------

async function chooseLibraryDir(): Promise<boolean> {
  // M10-6: ここが無防備だと、失敗が「ボタンが効かない」としか見えず詰む。
  // ダイアログの失敗と設定保存の失敗は別物なので、catch も分ける。
  let dir: string | string[] | null;
  try {
    dir = await open({
      directory: true,
      multiple: false,
      title: "PCライブラリの保存先フォルダを選択",
    });
  } catch (e) {
    logError("library", `フォルダ選択ダイアログを開けませんでした: ${e}`);
    toast(`フォルダを選べませんでした: ${e}`);
    return false;
  }
  if (!dir || typeof dir !== "string") return false;
  settings.libraryDir = dir;
  try {
    await invoke("save_settings", { settings });
  } catch (e) {
    // 保存だけ失敗した場合、settings.libraryDir は**戻さない**。
    // 戻すとようこそ画面から先に進めなくなる（＝詰む）。
    // このセッションは動くが次回起動時に選び直しになる、と伝えるだけにする。
    logError("library", `ライブラリ設定の保存に失敗: ${e}`);
    toast(`設定を保存できませんでした。次回起動時にもう一度選んでください: ${e}`);
  }
  return true;
}

async function firstRunGate(): Promise<void> {
  while (!settings.libraryDir) {
    await modal((close) => {
      const box = document.createElement("div");
      box.innerHTML = `
        <p class="modal-msg"><b>ようこそ メモアニマへ！</b><br>
        まず、メモライブラリの保存場所（PCの好きなフォルダ）を選んでください。<br>
        取り込んだ作品と、あなたの新しい作品はここに保存されます。</p>
        <div class="modal-actions"><button class="btn primary">📁 フォルダを選ぶ</button></div>`;
      (box.querySelector("button") as HTMLElement).addEventListener("click", async () => {
        if (await chooseLibraryDir()) close(true);
      });
      return box;
    });
  }
}

/** M10-14: ドロップされた .memoanima/.animemo の受け取り方を選ぶ（複数でもダイアログは1回） */
function projectDropDialog(paths: string[]): Promise<"import" | "edit" | null> {
  const fname = paths[0].split(/[\\/]/).pop() ?? paths[0];
  const msg =
    paths.length === 1
      ? `「${fname}」をどうしますか？`
      : `${paths.length}件の作品ファイルをどうしますか？`;
  return modal((close) => {
    const box = document.createElement("div");
    box.innerHTML = `<p class="modal-msg"></p>
      <div class="modal-actions">
        <button class="btn primary" data-v="import">📥 今のアルバムに取り込む</button>
        <button class="btn" data-v="edit">✏ すぐ編集で開く</button>
        <button class="btn" data-v="cancel">キャンセル</button>
      </div>`;
    (box.querySelector(".modal-msg") as HTMLElement).textContent = msg;
    box.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () =>
        close(b.dataset.v === "cancel" ? null : b.dataset.v)
      )
    );
    // 既定フォーカスは「取り込む」（Enter で最短経路）
    setTimeout(() => (box.querySelector(".primary") as HTMLButtonElement)?.focus(), 0);
    return box;
  });
}

/** M10-16: 取り込み中フラグ（多重実行ガード。実行中の追加ドロップはトーストで無視） */
let importRunning = false;

/** M10-16: raw IPC で読む（number[] JSON を廃止）。.memoanima としてあり得ない
 *  巨大ファイルは読み込む**前に** Rust 側で弾く（M10-7 の TOO_LARGE 方式・512MB） */
const IMPORT_MAX_BYTES = 512 * 1024 * 1024;
async function readProjectRaw(path: string): Promise<Uint8Array> {
  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>("read_file_raw", {
    path,
    maxBytes: IMPORT_MAX_BYTES,
  });
  return raw instanceof Uint8Array
    ? raw
    : raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw as number[]);
}

/** M10-16: 取り込み進捗モーダル。実行中は背景クリック（capture で先取り）でも
 *  Escape（modal() は元々 Esc を持たない）でも閉じない。閉じるのは finish() だけ。 */
function openImportProgressModal(total: number): {
  setStage: (fileIdx: number, name: string, stage: 0 | 1 | 2) => void;
  finish: () => void;
  cancelRequested: () => boolean;
} {
  const STAGE_LABEL = ["読み込み中…", "確認中…", "保存中…"] as const;
  let closeFn: ((v: unknown) => void) | null = null;
  let cancel = false;
  void modal((close) => {
    closeFn = close;
    const box = document.createElement("div");
    box.innerHTML = `<p class="modal-msg"><b>📥 取り込み中…</b></p>
      <div class="bar"><i id="ip-bar" style="width:0%"></i></div>
      <p class="modal-path" id="ip-text"></p>
      <div class="modal-actions">
        <button class="btn" id="ip-cancel">キャンセル</button>
      </div>`;
    // 実行中は背面クリックで閉じない（modal 共通の pointerdown ハンドラより先に capture で止める）
    setTimeout(() => {
      const back = box.parentElement;
      back?.addEventListener(
        "pointerdown",
        (e) => {
          if (e.target === back) e.stopImmediatePropagation();
        },
        { capture: true }
      );
    }, 0);
    box.querySelector("#ip-cancel")!.addEventListener("click", () => {
      cancel = true;
      (box.querySelector("#ip-cancel") as HTMLButtonElement).disabled = true;
      const t = box.querySelector("#ip-text") as HTMLElement | null;
      if (t) t.textContent = "キャンセル中…（現在のファイルの完了を待っています）";
    });
    return box;
  });
  return {
    setStage(fileIdx, name, stage) {
      if (cancel) return; // 「キャンセル中…」表示を維持
      const bar = document.querySelector("#ip-bar") as HTMLElement | null;
      const t = document.querySelector("#ip-text") as HTMLElement | null;
      // 全体進捗 = (完了ファイル数×3 + 段階) / (総数×3)
      const pct = Math.round(((fileIdx * 3 + stage) / (total * 3)) * 100);
      if (bar) bar.style.width = `${pct}%`;
      if (t) t.textContent = `${fileIdx + 1} / ${total} 件目: ${name}（${STAGE_LABEL[stage]}）`;
    },
    finish() {
      closeFn?.(null);
    },
    cancelRequested: () => cancel,
  };
}

/** M10-14: ドロップ取り込み。元ファイルを**そのまま**（再シリアライズせず）現在のアルバムへ。
 *  M10-16: バイト列を IPC に通さない — 読みは read_file_raw、保存は import_project_file
 *  （Rust 側で src_path から直接コピー）。IPC に乗るのはサムネPNGだけ。
 *  元ファイルは読むだけ（移動・削除・書き込みしない）。
 *  同名衝突は pclib 側が**上書き**のため、ここで「名前 (2)」方式に回避する。 */
async function importDroppedProjects(paths: string[]) {
  const libRoot = settings.libraryDir;
  if (!libRoot) {
    toast("先にライブラリフォルダを設定してください（⚙）");
    return;
  }
  const album = library.currentAlbum || settings.lastAlbum || "未分類";
  // 衝突チェック用に、対象アルバムの既存プロジェクト名（拡張子抜き・小文字）を集める
  //（編集中は library.items が古い可能性があるので必ず取り直す）
  const used = new Set<string>();
  try {
    const items = await invoke<LibraryView[]>("scan_library", { libRoot });
    for (const it of items) {
      if (it.kind === "project" && it.album === album) used.add(stripExt(it.name).toLowerCase());
    }
  } catch {
    /* 索引が読めなくても取り込み自体は試みる（import_project_fileは原子的） */
  }
  importRunning = true;
  const prog = openImportProgressModal(paths.length);
  let okCount = 0;
  let cancelled = false;
  let lastPath: string | null = null;
  try {
    for (let i = 0; i < paths.length; i++) {
      // キャンセルは「現在のファイルの完了を待ってから」＝ループ先頭でのみ判定（ファイル単位で原子的）
      if (prog.cancelRequested()) {
        cancelled = true;
        break;
      }
      const p = paths[i];
      const fname = p.split(/[\\/]/).pop() ?? p;
      try {
        prog.setStage(i, fname, 0); // 読み込み中…
        const bytes = await readProjectRaw(p);
        prog.setStage(i, fname, 1); // 確認中…（パース検証＋サムネ描画）
        const project = await projectFromBytes(bytes);
        const blob = await frameToPngBlob(project, project.thumbFrame ?? 0);
        const thumb = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
        // 「名前 (2)」方式（同時ドロップ内の衝突も used に積んで回避）
        const base = stripExt(fname) || "無題";
        let name = base;
        for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} (${k})`;
        used.add(name.toLowerCase());
        prog.setStage(i, fname, 2); // 保存中…（Rust が src_path から直接コピー）
        lastPath = await invoke<string>("import_project_file", {
          libRoot,
          album,
          name,
          srcPath: p,
          thumbPng: Array.from(thumb),
        });
        okCount++;
        if (paths.length === 1) toast(`取り込みました: ${album} / ${name}.memoanima`);
      } catch {
        toast("このファイルは開けませんでした");
      }
    }
  } finally {
    prog.finish();
    importRunning = false;
  }
  if (cancelled) toast(`${paths.length}件中${okCount}件を取り込みました（中断）`);
  else if (paths.length > 1 && okCount > 0) toast(`${okCount}件を取り込みました`);
  if (okCount === 0) return;
  if (editorOpen) return; // 編集中は裏で取り込むだけ（画面を離れない。戻ったとき refresh される）
  await library.refresh();
  // 取り込んだ作品（最後の1件）を選択状態にしてプレビューを見せる
  const it =
    library.items.find((i) => i.path === lastPath) ??
    library.items.find((i) => i.kind === "project" && i.album === album && lastPath != null && lastPath.endsWith(i.name));
  if (it) {
    await library.select(it);
    document
      .querySelector<HTMLElement>(`#shelf-grid .thumb[data-path="${CSS.escape(it.path)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }
}

/** ドロップ処理の本体（onDragDropEvent から呼ぶ。DEV検証フックも同じ経路を通す） */
async function handleDroppedPaths(paths: string[]) {
  // M10-16: 取り込み実行中の追加ドロップは無視（ダイアログも出さない・フラグ1本）
  if (importRunning) {
    toast("取り込み中です。完了までお待ちください");
    return;
  }
  // M10-14: .kwz/.ppm は従来どおり即取り込み、.memoanima/.animemo は選択ダイアログへ
  const projPaths: string[] = [];
  const notePaths: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (lower.endsWith(".kwz") || lower.endsWith(".ppm")) notePaths.push(p);
    else if (lower.endsWith(".memoanima") || lower.endsWith(".animemo")) projPaths.push(p);
  }
  if (notePaths.length > 0) {
    // M11-6: この経路は `showLibrary()` を直に呼んでいて、**未保存の確認が無かった**
    //（編集中に .kwz を1つドロップすると、確認なしにライブラリへ戻って変更が消える）。
    // ⟵もどる／ドロップ→「編集」と同じ後始末を通す。キャンセルなら何もせずに戻る。
    // ※ .kwz/.ppm を含むときだけ聞く（.memoanima だけのドロップで二重に聞かないため）
    if (editorOpen) {
      const ok = await editor.confirmLeave(
        "編集中の作品に、保存していない変更があります。破棄して、ドロップされた作品を取り込みますか？"
      );
      if (!ok) return;
      showLibrary();
    }
    for (const p of notePaths) await library.openSingleFile(p);
  }
  if (projPaths.length === 0) return;
  const choice = await projectDropDialog(projPaths);
  if (choice === "import") {
    await importDroppedProjects(projPaths);
  } else if (choice === "edit") {
    // 従来挙動（M10-14 以前の即編集）。複数は先頭の1件のみ
    if (projPaths.length > 1) toast("複数のため最初の1件のみ開きました");
    try {
      // M10-16: こちらも raw 読み（number[] JSON をやめる）
      // M11-6: 先に読む（開けないファイルのために未保存の確認をさせない）
      const project = await projectFromBytes(await readProjectRaw(projPaths[0]));
      // M11-6: 編集中なら ⟵もどる と同じ後始末を通す。キャンセルされたら**何もしない**
      //（ドロップされた作品は開かず、編集中の作品もそのまま）
      if (
        editorOpen &&
        !(await editor.confirmLeave(
          "編集中の作品に、保存していない変更があります。破棄して、ドロップされた作品を開きますか？"
        ))
      ) {
        return;
      }
      showEditor(project, null);
    } catch (e) {
      toast(`開けませんでした: ${e}`);
    }
  }
}

/** M10-19: ペン長押し（Windows では右クリック扱い）で WebView2 の標準コンテキストメニュー
 *（「名前を付けて画像を保存」等）が出て描画の邪魔になるため、アプリ全体で抑止する。
 *  テキスト入力系だけは除外して右クリック貼り付けを残す。 */
function setupContextMenuBlock() {
  window.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable='true']")) return;
    e.preventDefault();
  });
}

/** M11-7 P-4: ドロップ購読の解除関数。ライブラリを選び直すと `setupFileDrop()` が
 *  もう一度呼ばれるため、保持していないと購読が積み上がり、**1回のドロップで
 *  取り込みが2回走る**（同じ操作を2回して壊れない＝守る③） */
let fileDropUnlisten: (() => void) | null = null;

async function setupFileDrop() {
  try {
    // 前の購読を必ず解除してから張り直す（二重登録の防止）
    fileDropUnlisten?.();
    fileDropUnlisten = null;
    fileDropUnlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      await handleDroppedPaths((event.payload as any).paths ?? []);
    });
  } catch {
    // ドロップ未対応環境では無視
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  // M5-4: トーンパターン検証ページ（devフック ?tones）
  // 320×240等倍相当（1canvas画素=1CSSpx）のスウォッチを全柄ぶん並べ、3DS実機写真と見比べる
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("tones")) {
    const { TONE_TILES, toneAt } = await import("./editor/raster");
    document.body.innerHTML = `<div style="padding:16px;background:#fbefd6">
      <h2 style="margin:0 0 4px">トーンパターン検証（等倍）</h2>
      <p style="margin:0 0 12px;font-size:12px">各スウォッチは 96×96 実画素（1画素=1px・320×240等倍と同スケール）。3DS写真と見比べる。</p>
      <div id="tones" style="display:flex;flex-wrap:wrap;gap:14px"></div></div>`;
    const host = document.getElementById("tones")!;
    for (const t of TONE_TILES) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "text-align:center;font-size:11px;font-weight:700";
      const cv = document.createElement("canvas");
      cv.width = 96;
      cv.height = 96;
      cv.style.cssText = "width:96px;height:96px;border:1px solid #2c2621;background:#fff;display:block;margin:0 auto 4px";
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 96, 96);
      ctx.fillStyle = "#2c2621";
      for (let y = 0; y < 96; y++)
        for (let x = 0; x < 96; x++)
          if (!t.tile || toneAt(t.tile, x, y)) ctx.fillRect(x, y, 1, 1);
      wrap.appendChild(cv);
      wrap.appendChild(document.createTextNode(t.name));
      host.appendChild(wrap);
    }
    return;
  }
  // M10-2a: 変位マップエンジンの検証ページ（devフック ?warp）
  // 受け入れ基準4〜7を機械的に判定する。とくに「色indexの閉包」は
  // 索引に補間が混ざっていないことの証明なので、ここが FAIL したら実装が壊れている。
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("warp")) {
    const { WarpField, applyWarp, isConvexQuad } = await import("./editor/warp");
    const { W: WW, H: HH, PIXELS } = await import("./editor/model");
    const results: { name: string; pass: boolean; detail: string }[] = [];
    const add = (name: string, pass: boolean, detail: string) =>
      results.push({ name, pass, detail });

    // 決定的な入力（乱数は使わない＝再実行で同じ結果になるように）
    const mkSrc = () => {
      const b = new Uint8Array(PIXELS);
      for (let i = 0; i < PIXELS; i++) b[i] = (i * 7 + ((i / WW) | 0) * 13) % 251;
      return b;
    };
    const src = mkSrc();
    const dst = new Uint8Array(PIXELS);

    // M10-4 P-1-1: 色index閉包テスト**専用**の入力。値を3つだけに絞ることで、
    // 補間（平均）が起きた瞬間に集合外の値が現れるようにする。
    // mkSrc() は `% 251` なので 0..250 の全251値が出てしまい、平均もまた集合内に落ちる
    // ＝ 閉包テストが原理的に落ちない（補間を検出できない）。それを塞ぐための入力。
    // {1,2,3} のような密な小集合は平均が集合内に入りうるので使わない。
    const CLOSURE_VALUES = [0, 37, 211] as const; // 2値の平均は 19 / 124 / 106 で3つとも集合外
    const mkSparseSrc = () => {
      const b = new Uint8Array(PIXELS);
      for (let y = 0; y < HH; y++)
        for (let x = 0; x < WW; x++) b[y * WW + x] = CLOSURE_VALUES[(x + y) % 3];
      return b;
    };
    const sparse = mkSparseSrc();
    /** このテストが「補間を検出できる」ことの証明。わざと平均を取った出力には
     *  必ず集合外の値が現れる — これが 0 なら、テスト自体が壊れている */
    const countMutantOut = (b: Uint8Array, inSet: Set<number>) => {
      let n = 0;
      for (let i = 1; i < PIXELS; i++)
        if (!inSet.has(Math.round((b[i] + b[i - 1]) / 2))) n++;
      return n;
    };

    // ① 色indexの閉包: 出力の値集合 ⊆ 入力の値集合 ∪ {0}
    // 入力は**疎な3値**（M10-5 P-1）。密な入力だと平均も集合内に落ちて検出できない
    {
      const inSet = new Set<number>(sparse);
      inSet.add(0);
      const fields: { label: string; f: InstanceType<typeof WarpField> }[] = [];
      const liq = new WarpField();
      for (let k = 0; k < 40; k++)
        liq.addLiquify(40 + k * 5, 60 + ((k * 11) % 100), 6, -4, 30, 80);
      fields.push({ label: "液状化40回", f: liq });
      const big = new WarpField();
      for (let k = 0; k < 12; k++) big.addLiquify(160, 120, 25, 18, 90, 100);
      fields.push({ label: "大きく押し出し", f: big });
      let bad = 0;
      let sample = "";
      for (const { label, f } of fields) {
        applyWarp(sparse, dst, f, null);
        for (let i = 0; i < PIXELS; i++) {
          if (!inSet.has(dst[i])) {
            bad++;
            if (!sample) sample = `${label}: 値 ${dst[i]} @${i}`;
          }
        }
      }
      const mutantOut = countMutantOut(sparse, inSet);
      add(
        "① 色indexの閉包（補間が起きていない証明）",
        bad === 0 && mutantOut > 0,
        `入力に無い値 ${bad} 画素（液状化40回・大きく押し出し）／ 平均を取る参照実装なら ${mutantOut} 画素が集合外＝検出能力あり${
          sample ? ` (${sample})` : ""
        }`
      );
    }

    // ② 範囲外は 0（紙色や黒で埋まらない）
    // 注意: 320×240 では +200px ずらしても (320-200)×(240-200)=4,800 画素が範囲内に残る。
    // 「全画素0」を見るには W/H 以上ずらす必要がある。あわせて部分ずらしでも
    // 「範囲外→0・範囲内→正しくサンプル」が成り立つことを見る（こちらが §3.7-3 の本質）。
    {
      const full = new WarpField();
      full.dx.fill(WW);
      full.dy.fill(HH);
      applyWarp(src, dst, full, null);
      let nz = 0;
      for (let i = 0; i < PIXELS; i++) if (dst[i] !== 0) nz++;
      add(
        "② 範囲外は0（全画素が範囲外になるずらし）",
        nz === 0,
        nz === 0 ? "全画素0" : `0でない画素が ${nz}`
      );

      const part = new WarpField();
      part.dx.fill(200);
      part.dy.fill(200);
      applyWarp(src, dst, part, null);
      let badOob = 0;
      let badIn = 0;
      let inRange = 0;
      for (let y = 0; y < HH; y++)
        for (let x = 0; x < WW; x++) {
          const i = y * WW + x;
          const sx = x - 200;
          const sy = y - 200;
          if (sx < 0 || sx >= WW || sy < 0 || sy >= HH) {
            if (dst[i] !== 0) badOob++;
          } else {
            inRange++;
            if (dst[i] !== src[sy * WW + sx]) badIn++;
          }
        }
      add(
        "②' 部分ずらし（範囲外→0・範囲内→正しくサンプル）",
        badOob === 0 && badIn === 0,
        `範囲内 ${inRange} 画素 / 範囲外の誤り ${badOob} / 範囲内の誤り ${badIn}`
      );
    }

    // ③ マスク外不変
    {
      const mask = new Uint8Array(PIXELS);
      for (let y = 60; y < 180; y++) for (let x = 80; x < 240; x++) mask[y * WW + x] = 1;
      const f = new WarpField();
      f.setRegionWeight(mask, 3);
      for (let k = 0; k < 20; k++) f.addLiquify(160, 120, 20, 15, 60, 100);
      applyWarp(src, dst, f, mask);
      let bad = 0;
      for (let i = 0; i < PIXELS; i++) if (!mask[i] && dst[i] !== src[i]) bad++;
      add("③ マスク外不変", bad === 0, bad === 0 ? "マスク外は全画素一致" : `${bad} 画素が変化`);
    }

    // ④ 恒等（全0の場）
    {
      const f = new WarpField();
      applyWarp(src, dst, f, null);
      let bad = 0;
      for (let i = 0; i < PIXELS; i++) if (dst[i] !== src[i]) bad++;
      add("④ 恒等（全0の場）", bad === 0, bad === 0 ? "src と完全一致" : `${bad} 画素が不一致`);
      add("　 isIdentity()", f.isIdentity(), String(f.isIdentity()));
    }

    // ⑤ レイヤー間の一致（同じ場なら、どの src でもサンプル元座標が同じ）
    {
      const src2 = new Uint8Array(PIXELS);
      for (let i = 0; i < PIXELS; i++) src2[i] = (i % 3) + 1;
      const f = new WarpField();
      for (let k = 0; k < 15; k++) f.addLiquify(120 + k * 3, 90, 8, 5, 40, 70);
      const d1 = new Uint8Array(PIXELS);
      const d2 = new Uint8Array(PIXELS);
      applyWarp(src, d1, f, null);
      applyWarp(src2, d2, f, null);
      // 同じ場ならサンプル元座標は同じ → d1[i] が src のどこから来たかを逆算して照合
      let bad = 0;
      for (let y = 0; y < HH; y++)
        for (let x = 0; x < WW; x++) {
          const i = y * WW + x;
          const sx = Math.round(x - f.dx[i]);
          const sy = Math.round(y - f.dy[i]);
          const oob = sx < 0 || sx >= WW || sy < 0 || sy >= HH;
          const e1 = oob ? 0 : src[sy * WW + sx];
          const e2 = oob ? 0 : src2[sy * WW + sx];
          if (d1[i] !== e1 || d2[i] !== e2) bad++;
        }
      add("⑤ レイヤー間の一致", bad === 0, bad === 0 ? "2つのsrcで同一の写像" : `${bad} 画素が不一致`);
    }

    // ⑥ 魚眼の色index閉包（単発／連続10段階 × ふくらみ／へこみ）
    // 入力は**疎な3値**（M10-4 P-1-1）。密な入力だと平均も集合内に落ちて検出できない
    {
      const inSet = new Set<number>(sparse);
      inSet.add(0);
      let bad = 0;
      let sample = "";
      for (const [label, s, times] of [
        ["bulge単発", 80, 1],
        ["bulge×10", 80, 10],
        ["pinch単発", -80, 1],
        ["pinch×10", -80, 10],
      ] as [string, number, number][]) {
        const f = new WarpField();
        for (let k = 0; k < times; k++) f.addFisheye(160, 120, 60, s);
        applyWarp(sparse, dst, f, null);
        for (let i = 0; i < PIXELS; i++)
          if (!inSet.has(dst[i])) {
            bad++;
            if (!sample) sample = `${label}: 値 ${dst[i]}`;
          }
      }
      const mutantOut = countMutantOut(sparse, inSet);
      add(
        "⑥ 魚眼の色index閉包",
        bad === 0 && mutantOut > 0,
        `入力に無い値 ${bad} 画素（4パターン）／ 平均を取る参照実装なら ${mutantOut} 画素が集合外＝検出能力あり${
          sample ? ` (${sample})` : ""
        }`
      );
    }

    // ⑦ 円の外は動かない
    {
      const f = new WarpField();
      f.addFisheye(160, 120, 60, 80);
      applyWarp(src, dst, f, null);
      let movedOutside = 0;
      let diffOutside = 0;
      for (let y = 0; y < HH; y++)
        for (let x = 0; x < WW; x++) {
          const i = y * WW + x;
          if (Math.hypot(x - 160, y - 120) < 60) continue;
          if (f.dx[i] !== 0 || f.dy[i] !== 0) movedOutside++;
          if (dst[i] !== src[i]) diffOutside++;
        }
      add(
        "⑦ 円の外は動かない",
        movedOutside === 0 && diffOutside === 0,
        `変位のある画素 ${movedOutside} / srcと異なる画素 ${diffOutside}`
      );
    }

    // ⑧ 30回連続でも反転しない（行き過ぎ止め）
    {
      const f = new WarpField();
      for (let k = 0; k < 30; k++) f.addFisheye(160, 120, 60, 100);
      let over = 0;
      let maxOver = 0;
      for (let y = 0; y < HH; y++)
        for (let x = 0; x < WW; x++) {
          const i = y * WW + x;
          const ddx = x - 160;
          const ddy = y - 120;
          const r = Math.hypot(ddx, ddy);
          if (r < 0.5 || r >= 60) continue;
          const radial = (f.dx[i] * ddx) / r + (f.dy[i] * ddy) / r;
          if (radial > r + 1e-3) {
            over++;
            maxOver = Math.max(maxOver, radial - r);
          }
        }
      // 閉包の判定だけ**疎な3値**を使う（M10-5 P-1）。
      // 上の over は変位場 f だけを見ていて入力画像とは無関係なので、差し替えの影響を受けない
      applyWarp(sparse, dst, f, null);
      const inSet = new Set<number>(sparse);
      inSet.add(0);
      let bad = 0;
      for (let i = 0; i < PIXELS; i++) if (!inSet.has(dst[i])) bad++;
      const mutantOut = countMutantOut(sparse, inSet);
      add(
        "⑧ 30回連続でも反転しない",
        over === 0 && bad === 0 && mutantOut > 0,
        `径方向が r を超えた画素 ${over}（最大超過 ${maxOver.toFixed(3)}px）/ 閉包違反 ${bad}／ 参照実装なら ${mutantOut} 画素が集合外`
      );
    }

    // ⑨ ふくらみとへこみが逆向き（符号の関係だけを見る）
    {
      const fb = new WarpField();
      fb.addFisheye(160, 120, 60, 80);
      const fp = new WarpField();
      fp.addFisheye(160, 120, 60, -80);
      // 中心から r=30 の位置（右方向）
      const i = 120 * WW + 190;
      const radB = fb.dx[i];
      const radP = fp.dx[i];
      add(
        "⑨ ふくらみ／へこみが逆向き",
        radB > 0 && radP < 0,
        `r=30 の径方向変位 bulge=${radB.toFixed(2)} / pinch=${radP.toFixed(2)}`
      );
    }

    // ⑩ マスク外不変（魚眼版）＋ マスク内は実際に変化していること
    {
      const mask = new Uint8Array(PIXELS);
      for (let y = 60; y < 180; y++) for (let x = 80; x < 240; x++) mask[y * WW + x] = 1;
      const f = new WarpField();
      f.setRegionWeight(mask, 3);
      for (let k = 0; k < 10; k++) f.addFisheye(160, 120, 60, 80);
      applyWarp(src, dst, f, mask);
      let outBad = 0;
      let inChanged = 0;
      for (let i = 0; i < PIXELS; i++) {
        if (!mask[i]) {
          if (dst[i] !== src[i]) outBad++;
        } else if (dst[i] !== src[i]) inChanged++;
      }
      add(
        "⑩ マスク外不変（魚眼）",
        outBad === 0 && inChanged > 0,
        `マスク外の変化 ${outBad} / マスク内の変化 ${inChanged}`
      );
    }

    // ⑪ applyWarp 単体の実測時間（ms/レイヤー）
    {
      const f = new WarpField();
      for (let k = 0; k < 10; k++) f.addFisheye(160, 120, 60, 80);
      const bench = (m: Uint8Array | null) => {
        for (let k = 0; k < 3; k++) applyWarp(src, dst, f, m); // ウォームアップ
        const t0 = performance.now();
        const N = 30;
        for (let k = 0; k < N; k++) applyWarp(src, dst, f, m);
        return (performance.now() - t0) / N;
      };
      const mask = new Uint8Array(PIXELS);
      for (let y = 60; y < 180; y++) for (let x = 80; x < 240; x++) mask[y * WW + x] = 1;
      const noMask = bench(null);
      const withMask = bench(mask);
      add(
        "⑪ applyWarp 単体の実測",
        noMask <= 20,
        `マスクなし ${noMask.toFixed(2)} ms/レイヤー / マスクあり ${withMask.toFixed(2)} ms/レイヤー（判定: マスクなし ≤ 20ms）`
      );
      (window as unknown as Record<string, unknown>).__warpBench = {
        noMaskMs: +noMask.toFixed(3),
        withMaskMs: +withMask.toFixed(3),
      };
    }

    // ---- M10-2c: 射影変換（四隅変形）----
    const FULL_RECT = { x0: 0, y0: 0, x1: WW, y1: HH };
    /** 上辺を狭めた台形（左上→右上→右下→左下） */
    const TRAPEZOID = [
      { x: 80, y: 0 },
      { x: 240, y: 0 },
      { x: WW - 1, y: HH - 1 },
      { x: 0, y: HH - 1 },
    ];
    /** ねじれ気味の一般四角形（凸は保つ） */
    const GENERAL = [
      { x: 30, y: 20 },
      { x: 300, y: 60 },
      { x: 260, y: 230 },
      { x: 10, y: 190 },
    ];
    /** 縞模様の入力（一様塗りだと「変化なし」と「正しく動いた」が区別できない） */
    const striped = new Uint8Array(PIXELS);
    for (let y = 0; y < HH; y++)
      for (let x = 0; x < WW; x++)
        striped[y * WW + x] = (x % 8 < 4 ? 1 : 2) + (y % 10 < 5 ? 0 : 2);

    // ⑫ 恒等な四隅（四角形＝元矩形）で全画素一致
    // 浮動小数の誤差で 1px ずれると全画素がずれるので、写像の実装が正しいことの一番強いテスト
    {
      const f = new WarpField();
      const ok = f.setHomography(
        [
          { x: 0, y: 0 },
          { x: WW, y: 0 },
          { x: WW, y: HH },
          { x: 0, y: HH },
        ],
        FULL_RECT
      );
      applyWarp(src, dst, f, null);
      let bad = 0;
      for (let i = 0; i < PIXELS; i++) if (dst[i] !== src[i]) bad++;
      add(
        "⑫ 恒等な四隅で全画素一致",
        ok && bad === 0,
        ok ? (bad === 0 ? "差分0画素" : `差分 ${bad} 画素`) : "setHomography が false"
      );
    }

    // ⑬ 射影変換の色 index 閉包（§3.7-2）
    // 入力は**疎な3値**（M10-4 P-1-1）。密な入力だと平均も集合内に落ちて検出できない
    {
      const inSet = new Set<number>(sparse);
      inSet.add(0);
      let bad = 0;
      let sample = "";
      for (const [label, quad] of [
        ["台形", TRAPEZOID],
        ["一般四角形", GENERAL],
      ] as const) {
        const f = new WarpField();
        f.setHomography(quad, FULL_RECT);
        applyWarp(sparse, dst, f, null);
        for (let i = 0; i < PIXELS; i++)
          if (!inSet.has(dst[i])) {
            bad++;
            if (!sample) sample = `${label}: 値 ${dst[i]} @${i}`;
          }
      }
      const mutantOut = countMutantOut(sparse, inSet);
      add(
        "⑬ 射影変換の色index閉包（補間が起きていない証明）",
        bad === 0 && mutantOut > 0,
        `入力に無い値 ${bad} 画素（台形・一般四角形）／ 平均を取る参照実装なら ${mutantOut} 画素が集合外＝検出能力あり${
          sample ? ` (${sample})` : ""
        }`
      );
    }

    // ⑭ 四角形の外は透明（紙色や黒で埋まらない）（§3.7-3）
    {
      const f = new WarpField();
      f.setHomography(TRAPEZOID, FULL_RECT);
      applyWarp(src, dst, f, null);
      // 各辺からの符号付き距離で「明らかに外側」（2px 以上外）だけを判定対象にする。
      // 境界1画素は ±0.5 の丸めで内外どちらにも転びうるので数えない
      const sd = (x: number, y: number) => {
        let m = Infinity;
        for (let i = 0; i < 4; i++) {
          const a = TRAPEZOID[i];
          const b = TRAPEZOID[(i + 1) % 4];
          const ex = b.x - a.x;
          const ey = b.y - a.y;
          const len = Math.hypot(ex, ey) || 1;
          // 画面座標（y下向き）でこの並びは cross > 0 が内側
          m = Math.min(m, (ex * (y - a.y) - ey * (x - a.x)) / len);
        }
        return m; // 正=内側 / 負=外側
      };
      let outside = 0;
      let outNonZero = 0;
      let insideNonZero = 0;
      for (let y = 0; y < HH; y++)
        for (let x = 0; x < WW; x++) {
          const d = sd(x, y);
          const i = y * WW + x;
          if (d < -2) {
            outside++;
            if (dst[i] !== 0) outNonZero++;
          } else if (d > 2 && dst[i] !== 0) insideNonZero++;
        }
      add(
        "⑭ 四角形の外は透明（0）",
        outNonZero === 0 && outside > 0 && insideNonZero > 0,
        `外側 ${outside} 画素中 0でないもの ${outNonZero} / 内側で0でない画素 ${insideNonZero}`
      );
    }

    // ⑮ 非凸を弾き、場が1画素も変わらない
    {
      const f = new WarpField();
      f.setHomography(TRAPEZOID, FULL_RECT); // 何か入った状態から始める
      const bx = Float32Array.from(f.dx);
      const by = Float32Array.from(f.dy);
      // 右上と右下を入れ替えた並び＝自己交差
      const bowtie = [TRAPEZOID[0], TRAPEZOID[2], TRAPEZOID[1], TRAPEZOID[3]];
      const conv = isConvexQuad(bowtie);
      const ret = f.setHomography(bowtie, FULL_RECT);
      let diff = 0;
      for (let i = 0; i < PIXELS; i++)
        if (f.dx[i] !== bx[i] || f.dy[i] !== by[i]) diff++;
      add(
        "⑮ 非凸を弾く（場が1画素も変わらない）",
        conv === false && ret === false && diff === 0,
        `isConvexQuad=${conv} / setHomography=${ret} / 場の差分 ${diff} 画素`
      );
    }

    // ⑯ 直線が直線に写る（射影変換の定義）。逆写像で確認する。許容 0.5px
    // 台形だけだと水平線が水平線に写るので自明に通ってしまう。
    // 元の像が軸に平行にならない一般四角形も併せて見る
    {
      const cases: { label: string; quad: typeof TRAPEZOID; ys: number; xs: number[] }[] = [
        { label: "台形", quad: TRAPEZOID, ys: 120, xs: [60, 160, 260] },
        { label: "一般四角形", quad: GENERAL, ys: 120, xs: [60, 150, 240] },
      ];
      let worst = 0;
      const detail: string[] = [];
      for (const c of cases) {
        const f = new WarpField();
        f.setHomography(c.quad, FULL_RECT);
        const pts = c.xs.map((x) => {
          const i = c.ys * WW + x;
          return { u: x - f.dx[i], v: c.ys - f.dy[i] };
        });
        const [p1, p2, p3] = pts;
        const cross =
          (p2.u - p1.u) * (p3.v - p1.v) - (p2.v - p1.v) * (p3.u - p1.u);
        const base = Math.hypot(p2.u - p1.u, p2.v - p1.v) || 1;
        const dev = Math.abs(cross) / base; // p3 の直線 p1p2 からの距離（px）
        if (dev > worst) worst = dev;
        detail.push(
          `${c.label} ずれ ${dev.toFixed(4)}px [${pts
            .map((p) => `(${p.u.toFixed(1)},${p.v.toFixed(1)})`)
            .join(" ")}]`
        );
      }
      add("⑯ 直線が直線に写る（許容 0.5px）", worst <= 0.5, detail.join(" / "));
    }

    // ⑰ マスク外不変・マスク内は実際に変化（§3.7-4）。縞模様の入力で判定
    {
      const f = new WarpField();
      f.setHomography(TRAPEZOID, FULL_RECT);
      const mask = new Uint8Array(PIXELS);
      for (let y = 60; y < 180; y++) for (let x = 80; x < 240; x++) mask[y * WW + x] = 1;
      const out = new Uint8Array(PIXELS);
      applyWarp(striped, out, f, mask);
      let outBad = 0;
      let inChanged = 0;
      for (let i = 0; i < PIXELS; i++) {
        if (!mask[i]) {
          if (out[i] !== striped[i]) outBad++;
        } else if (out[i] !== striped[i]) inChanged++;
      }
      add(
        "⑰ マスク外不変（射影変換）",
        outBad === 0 && inChanged > 0,
        `マスク外の変化 ${outBad} / マスク内の変化 ${inChanged}`
      );
    }

    // ⑱ setHomography 単体の実測時間と、レイヤー10枚を想定した1フレーム分の合計
    {
      const f = new WarpField();
      for (let k = 0; k < 3; k++) f.setHomography(GENERAL, FULL_RECT); // ウォームアップ
      const N = 30;
      const t0 = performance.now();
      for (let k = 0; k < N; k++) f.setHomography(GENERAL, FULL_RECT);
      const setMs = (performance.now() - t0) / N;
      const bench = (window as unknown as Record<string, { noMaskMs: number }>)
        .__warpBench;
      const applyMs = bench?.noMaskMs ?? 0;
      const total10 = setMs + applyMs * 10;
      add(
        "⑱ setHomography の実測（レイヤー10枚の1フレーム合計）",
        total10 <= 16,
        `setHomography ${setMs.toFixed(2)} ms/回 ＋ applyWarp ${applyMs.toFixed(
          2
        )} ms×10 ＝ ${total10.toFixed(2)} ms（判定: ≤16ms=60fps）`
      );
      (window as unknown as Record<string, unknown>).__warpBench = {
        ...(bench ?? {}),
        setHomographyMs: +setMs.toFixed(3),
        total10LayersMs: +total10.toFixed(3),
      };
    }

    const allPass = results.every((r) => r.pass);
    document.body.innerHTML = `<div style="padding:16px;font:13px monospace;background:#fff">
      <h2 style="margin:0 0 10px">変位マップエンジン検証（?warp）</h2>
      <p style="font-size:16px;font-weight:700;color:${allPass ? "#0a7" : "#c00"}">
        ${allPass ? "ALL PASS" : "FAIL あり"}</p>
      <table style="border-collapse:collapse">${results
        .map(
          (r) =>
            `<tr><td style="padding:3px 10px;border-bottom:1px solid #eee;color:${
              r.pass ? "#0a7" : "#c00"
            };font-weight:700">${r.pass ? "PASS" : "FAIL"}</td>
             <td style="padding:3px 10px;border-bottom:1px solid #eee">${r.name}</td>
             <td style="padding:3px 10px;border-bottom:1px solid #eee;color:#666">${r.detail}</td></tr>`
        )
        .join("")}</table></div>`;
    (window as unknown as Record<string, unknown>).__warp = { allPass, results };
    return;
  }
  // M10-3: ゆらゆら差分の検証ページ（devフック ?wobble）
  // ①決定性 ②枚ごとに異なる ③色index閉包 ④原本不変 ⑤レイヤー間の一致
  // ⑥振幅の上限 ⑦弱でも動く ⑧実測時間
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("wobble")) {
    const { WarpField, applyWarp } = await import("./editor/warp");
    const { W: WW, H: HH, PIXELS } = await import("./editor/model");
    const { WOBBLE_TABLE } = await import("./editor/editor");
    const results: { name: string; pass: boolean; detail: string }[] = [];
    const add = (name: string, pass: boolean, detail: string) =>
      results.push({ name, pass, detail });

    // ?warp と同じ決定的な入力（乱数は使わない）
    const mkSrc = () => {
      const b = new Uint8Array(PIXELS);
      for (let i = 0; i < PIXELS; i++) b[i] = (i * 7 + ((i / WW) | 0) * 13) % 251;
      return b;
    };
    const src = mkSrc();
    // M10-4 P-1-1: 色index閉包テスト**専用**の疎な入力。mkSrc() は `% 251` で
    // 0..250 の全251値が出るため、平均もまた集合内に落ちて閉包テストが原理的に落ちない。
    // 値を3つに絞ると、2値の平均（19 / 124 / 106）が3つとも集合外になり補間を検出できる
    const CLOSURE_VALUES = [0, 37, 211] as const;
    const sparse = (() => {
      const b = new Uint8Array(PIXELS);
      for (let y = 0; y < HH; y++)
        for (let x = 0; x < WW; x++) b[y * WW + x] = CLOSURE_VALUES[(x + y) % 3];
      return b;
    })();
    /** テストが「補間を検出できる」ことの証明。0 ならテスト自体が壊れている */
    const countMutantOut = (b: Uint8Array, inSet: Set<number>) => {
      let n = 0;
      for (let i = 1; i < PIXELS; i++)
        if (!inSet.has(Math.round((b[i] + b[i - 1]) / 2))) n++;
      return n;
    };
    const SEED = 0x12345678;
    /** 実際の生成と同じシード派生（editor.buildWobbleFrames と同じ式） */
    const seedsFor = (k: number) => {
      const s = (SEED + Math.imul(k + 1, 0x9e3779b9)) >>> 0;
      return [s, (s ^ 0x6d2b79f5) >>> 0] as const;
    };
    const ALL: { label: string; kind: "line" | "whole"; s: 0 | 1 | 2 }[] = [];
    for (const kind of ["line", "whole"] as const)
      for (const s of [0, 1, 2] as const)
        ALL.push({ label: `${kind === "line" ? "線" : "全体"}/${["弱", "中", "強"][s]}`, kind, s });

    // ① 決定性: 同じシード・波長・振幅で2回作って1要素の違いもないこと
    {
      const { L, A } = WOBBLE_TABLE.whole[1];
      const [sx, sy] = seedsFor(0);
      const f1 = new WarpField();
      const f2 = new WarpField();
      f1.setValueNoise(sx, sy, L, A);
      f2.setValueNoise(sx, sy, L, A);
      let bad = 0;
      for (let i = 0; i < PIXELS; i++)
        if (f1.dx[i] !== f2.dx[i] || f1.dy[i] !== f2.dy[i]) bad++;
      // dx と dy が別シードであることも確認（同じだと斜めにずれるだけになる）
      let same = 0;
      for (let i = 0; i < PIXELS; i++) if (f1.dx[i] === f1.dy[i]) same++;
      add(
        "① 決定性（同じシードで完全一致）",
        bad === 0 && same < PIXELS * 0.01,
        `2回の差 ${bad} 要素 / dx===dy の画素 ${same}（別シードの証明・全 ${PIXELS} 中）`
      );
    }

    // ② 枚ごとに異なる: k=0,1,2 を同じ src に当てて、どの2枚も 30% 以上違うこと
    {
      let worst = 1;
      let worstLabel = "";
      const detail: string[] = [];
      for (const c of ALL) {
        const { L, A } = WOBBLE_TABLE[c.kind][c.s];
        const outs: Uint8Array[] = [];
        for (let k = 0; k < 3; k++) {
          const [sx, sy] = seedsFor(k);
          const f = new WarpField();
          f.setValueNoise(sx, sy, L, A);
          const o = new Uint8Array(PIXELS);
          applyWarp(src, o, f, null);
          outs.push(o);
        }
        let mn = 1;
        for (let a = 0; a < 3; a++)
          for (let b = a + 1; b < 3; b++) {
            let d = 0;
            for (let i = 0; i < PIXELS; i++) if (outs[a][i] !== outs[b][i]) d++;
            mn = Math.min(mn, d / PIXELS);
          }
        detail.push(`${c.label} ${(mn * 100).toFixed(1)}%`);
        if (mn < worst) {
          worst = mn;
          worstLabel = c.label;
        }
      }
      add(
        "② 枚ごとに異なる（最小の組で30%以上）",
        worst >= 0.3,
        `最小 ${(worst * 100).toFixed(1)}% (${worstLabel}) — ${detail.join(" / ")}`
      );
    }

    // ③ 色index閉包: 元に無い index が現れないこと
    // 入力は**疎な3値**（M10-4 P-1-1）。密な入力だと平均も集合内に落ちて検出できない
    {
      const inSet = new Set<number>(sparse);
      inSet.add(0);
      let bad = 0;
      let sample = "";
      for (const c of ALL) {
        const { L, A } = WOBBLE_TABLE[c.kind][c.s];
        const [sx, sy] = seedsFor(1);
        const f = new WarpField();
        f.setValueNoise(sx, sy, L, A);
        const o = new Uint8Array(PIXELS);
        applyWarp(sparse, o, f, null);
        for (let i = 0; i < PIXELS; i++)
          if (!inSet.has(o[i])) {
            bad++;
            if (!sample) sample = `${c.label}: 値 ${o[i]} @${i}`;
          }
      }
      const mutantOut = countMutantOut(sparse, inSet);
      add(
        "③ 色index閉包（補間が起きていない証明）",
        bad === 0 && mutantOut > 0,
        `入力に無い値 ${bad} 画素（6設定）／ 平均を取る参照実装なら ${mutantOut} 画素が集合外＝検出能力あり${
          sample ? ` (${sample})` : ""
        }`
      );
    }

    // ④ 原本不変: 3レイヤー分 applyWarp したあと src が1画素も変わらないこと
    {
      const srcs = [mkSrc(), mkSrc(), mkSrc()];
      const keep = srcs.map((b) => Uint8Array.from(b));
      const { L, A } = WOBBLE_TABLE.whole[2];
      const [sx, sy] = seedsFor(0);
      const f = new WarpField();
      f.setValueNoise(sx, sy, L, A);
      let changedOut = 0;
      for (let n = 0; n < 3; n++) {
        const o = new Uint8Array(PIXELS);
        applyWarp(srcs[n], o, f, null);
        for (let i = 0; i < PIXELS; i++) if (o[i] !== srcs[n][i]) changedOut++;
      }
      let srcBad = 0;
      for (let n = 0; n < 3; n++)
        for (let i = 0; i < PIXELS; i++) if (srcs[n][i] !== keep[n][i]) srcBad++;
      add(
        "④ 原本不変（適用元が1画素も変わらない）",
        srcBad === 0 && changedOut > 0,
        `原本の変化 ${srcBad} 画素 / 出力の変化 ${changedOut} 画素`
      );
    }

    // ⑤ レイヤー間の一致（M10-4 P-1-2: ?warp ⑤ と同じ「逆算照合」の形に揃える）。
    // 同じ入力同士を比べても「同じ処理なら同じ結果」しか言えないので、
    // **中身の違う2枚**（密／疎）に同じ場を当て、サンプル元座標を逆算して照合する
    {
      const a = mkSrc();
      const b = sparse;
      const { L, A } = WOBBLE_TABLE.line[1];
      const [sx, sy] = seedsFor(2);
      const f = new WarpField();
      f.setValueNoise(sx, sy, L, A);
      const oa = new Uint8Array(PIXELS);
      const ob = new Uint8Array(PIXELS);
      applyWarp(a, oa, f, null);
      applyWarp(b, ob, f, null);
      let bad = 0;
      for (let y = 0; y < HH; y++)
        for (let x = 0; x < WW; x++) {
          const i = y * WW + x;
          const px = Math.round(x - f.dx[i]);
          const py = Math.round(y - f.dy[i]);
          const oob = px < 0 || px >= WW || py < 0 || py >= HH;
          const ea = oob ? 0 : a[py * WW + px];
          const eb = oob ? 0 : b[py * WW + px];
          if (oa[i] !== ea || ob[i] !== eb) bad++;
        }
      add(
        "⑤ レイヤー間の一致（サンプル元座標の逆算照合）",
        bad === 0,
        bad === 0 ? "中身の違う2枚とも同一の写像" : `${bad} 画素が不一致`
      );
    }

    // ⑥ 振幅の上限: 全画素で |dx| <= A かつ |dy| <= A（値ノイズが -1..1 に収まる証明）
    {
      let over = 0;
      let worst = 0;
      const detail: string[] = [];
      for (const c of ALL) {
        const { L, A } = WOBBLE_TABLE[c.kind][c.s];
        const [sx, sy] = seedsFor(0);
        const f = new WarpField();
        f.setValueNoise(sx, sy, L, A);
        let mx = 0;
        for (let i = 0; i < PIXELS; i++) {
          const ax = Math.abs(f.dx[i]);
          const ay = Math.abs(f.dy[i]);
          if (ax > mx) mx = ax;
          if (ay > mx) mx = ay;
          // 浮動小数の丸めぶんだけ許容
          if (ax > A + 1e-5 || ay > A + 1e-5) over++;
        }
        if (mx / A > worst) worst = mx / A;
        detail.push(`${c.label} 最大 ${mx.toFixed(3)}/${A}`);
      }
      add(
        "⑥ 振幅の上限を超えない",
        over === 0,
        `超過 ${over} 画素（最大到達率 ${(worst * 100).toFixed(1)}%）— ${detail.join(" / ")}`
      );
    }

    // ⑦ 弱でも動く: 「線がふるえる・弱」で round が 0 でない画素が 10% 以上
    {
      const { L, A } = WOBBLE_TABLE.line[0];
      const detail: string[] = [];
      let worst = 1;
      for (let k = 0; k < 3; k++) {
        const [sx, sy] = seedsFor(k);
        const f = new WarpField();
        f.setValueNoise(sx, sy, L, A);
        let moved = 0;
        for (let i = 0; i < PIXELS; i++)
          if (Math.round(f.dx[i]) !== 0 || Math.round(f.dy[i]) !== 0) moved++;
        const r = moved / PIXELS;
        if (r < worst) worst = r;
        detail.push(`${k + 1}枚目 ${(r * 100).toFixed(1)}%`);
      }
      add(
        `⑦ 弱でも動く（線/弱 L=${L} A=${A}・10%以上）`,
        worst >= 0.1,
        `最小 ${(worst * 100).toFixed(1)}% — ${detail.join(" / ")}`
      );
    }

    // ⑧ 実測時間（ウォームアップ3回を除いた30回平均）
    {
      const { L, A } = WOBBLE_TABLE.whole[1];
      const [sx, sy] = seedsFor(0);
      const f = new WarpField();
      const dst = new Uint8Array(PIXELS);
      const bench = (fn: () => void) => {
        for (let k = 0; k < 3; k++) fn();
        const N = 30;
        const t0 = performance.now();
        for (let k = 0; k < N; k++) fn();
        return (performance.now() - t0) / N;
      };
      const noiseMs = bench(() => f.setValueNoise(sx, sy, L, A));
      const applyMs = bench(() => applyWarp(src, dst, f, null));
      const oneFrameOneLayer = noiseMs + applyMs; // 1コマ1レイヤー
      const total = 3 * (noiseMs + applyMs * 3); // 3レイヤー × 3枚
      add(
        "⑧ 実測時間（3レイヤー×3枚の合計）",
        total <= 60,
        `setValueNoise ${noiseMs.toFixed(2)} ms ／ applyWarp ${applyMs.toFixed(
          2
        )} ms ／ 1コマ1レイヤー ${oneFrameOneLayer.toFixed(
          2
        )} ms ／ **3レイヤー×3枚 合計 ${total.toFixed(2)} ms**`
      );
      (window as unknown as Record<string, unknown>).__wobbleBench = {
        setValueNoiseMs: +noiseMs.toFixed(3),
        applyWarpMs: +applyMs.toFixed(3),
        oneFrameOneLayerMs: +oneFrameOneLayer.toFixed(3),
        total3x3Ms: +total.toFixed(3),
      };
    }

    const allPass = results.every((r) => r.pass);
    document.body.innerHTML = `<div style="padding:16px;font:13px monospace;background:#fff">
      <h2 style="margin:0 0 10px">ゆらゆら差分の検証（?wobble）</h2>
      <p style="font-size:16px;font-weight:700;color:${allPass ? "#0a7" : "#c00"}">
        ${allPass ? "ALL PASS" : "FAIL あり"}</p>
      <table style="border-collapse:collapse">${results
        .map(
          (r) =>
            `<tr><td style="padding:3px 10px;border-bottom:1px solid #eee;color:${
              r.pass ? "#0a7" : "#c00"
            };font-weight:700">${r.pass ? "PASS" : "FAIL"}</td>
             <td style="padding:3px 10px;border-bottom:1px solid #eee">${r.name}</td>
             <td style="padding:3px 10px;border-bottom:1px solid #eee;color:#666">${r.detail}</td></tr>`
        )
        .join("")}</table></div>`;
    (window as unknown as Record<string, unknown>).__wobble = { allPass, results };
    return;
  }
  // M10-11: 縦書き検証ページ（devフック ?vtext）
  // ① 横書きが M10-10 と1画素も変わらないこと（旧実装のコピーと突き合わせ）
  // ②〜⑧ 縦書きの積み方・回転・句読点位置・クリップ
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("vtext")) {
    const R = await import("./editor/raster");
    const { FONTS, fontDef, ensureFontsLoaded } = await import("./editor/fonts");
    const { W: WW, H: HH } = await import("./editor/model");
    await ensureFontsLoaded();
    const results: { name: string; pass: boolean; detail: string }[] = [];
    const add = (name: string, pass: boolean, detail: string) =>
      results.push({ name, pass, detail });

    // ---- M10-10 時点の textToMask を完全複製（横書きの同値比較用）----
    const oldTextToMask = (
      text: string,
      px: number,
      opts: { family: any; bold: boolean }
    ): { w: number; h: number; data: Uint8Array } | null => {
      const def = fontDef(opts.family);
      const bold = def.hasBold && opts.bold;
      const oversample = def.kind === "outline" ? 3 : 1;
      const renderPx = px * oversample;
      const fontStr = `${bold ? "bold " : ""}${renderPx}px "${def.cssFamily}"`;
      const probe = document.createElement("canvas").getContext("2d")!;
      probe.font = fontStr;
      const m = probe.measureText(text);
      const w = Math.min(WW, Math.ceil(m.width / oversample) + 2);
      const h = Math.min(HH, Math.ceil(px * 1.35) + 2);
      if (w <= 2 || text.length === 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = w * oversample;
      canvas.height = h * oversample;
      const c2 = canvas.getContext("2d")!;
      c2.font = fontStr;
      c2.textBaseline = "top";
      c2.fillStyle = "#000";
      c2.fillText(text, oversample, oversample);
      const img = c2.getImageData(0, 0, canvas.width, canvas.height).data;
      const data = new Uint8Array(w * h);
      if (oversample === 1) {
        for (let i = 0; i < w * h; i++) data[i] = img[i * 4 + 3] > 128 ? 1 : 0;
        return { w, h, data };
      }
      const sw = canvas.width;
      const area = oversample * oversample;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0;
          for (let oy = 0; oy < oversample; oy++)
            for (let ox = 0; ox < oversample; ox++)
              sum += img[((y * oversample + oy) * sw + x * oversample + ox) * 4 + 3];
          data[y * w + x] = sum / area >= 128 ? 1 : 0;
        }
      }
      return { w, h, data };
    };

    /** マスク内の指定行範囲のインク外接矩形 */
    const bbox = (
      msk: { w: number; h: number; data: Uint8Array },
      y0 = 0,
      y1 = msk.h
    ) => {
      let mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1, n = 0;
      for (let y = Math.max(0, y0); y < Math.min(msk.h, y1); y++)
        for (let x = 0; x < msk.w; x++)
          if (msk.data[y * msk.w + x]) {
            n++;
            if (x < mnx) mnx = x;
            if (x > mxx) mxx = x;
            if (y < mny) mny = y;
            if (y > mxy) mxy = y;
          }
      return n === 0
        ? null
        : { x: mnx, y: mny, w: mxx - mnx + 1, h: mxy - mny + 1, n, cx: (mnx + mxx) / 2, cy: (mny + mxy) / 2 };
    };

    // ① 横書きが M10-10 と一致
    //    M11-12 でクランプ（Math.min(W/H, …)）を廃止したので、**旧実装が切っていた範囲の中で**
    //    1画素も変わらないことを確認する（切られていたケース数も数値で残す＝これが直った不具合）
    {
      const TEXTS = ["あいうえお", "スピード", "（テスト）", "ABC123", "こんにちは、世界。", "？！", "Aa1"];
      let cases = 0, diffCases = 0, diffPixels = 0, wasClipped = 0, sample = "";
      for (const f of FONTS) {
        for (const size of f.sizes) {
          for (const bold of [false, true]) {
            for (const t of TEXTS) {
              const o = oldTextToMask(t, size, { family: f.key, bold });
              const nw = R.textToMask(t, size, { family: f.key, bold });
              cases++;
              if (!o || !nw) {
                if (!!o !== !!nw) { diffCases++; if (!sample) sample = `${f.key}/${size}/${t}: null不一致`; }
                continue;
              }
              if (nw.w > o.w || nw.h > o.h) wasClipped++; // 旧実装がここで文字を捨てていた
              let d = 0;
              if (nw.w < o.w || nw.h < o.h) d = -1; // 新しい方が小さいのは異常
              else
                for (let y = 0; y < o.h; y++)
                  for (let x = 0; x < o.w; x++)
                    if (o.data[y * o.w + x] !== nw.data[y * nw.w + x]) d++;
              if (d !== 0) {
                diffCases++;
                diffPixels += Math.max(0, d);
                if (!sample) sample = `${f.key}/${size}/bold=${bold}/"${t}"`;
              }
            }
          }
        }
      }
      add(
        "① 横書きが M10-10 と1画素も変わらない（旧マスクの範囲内で比較）",
        diffCases === 0,
        `ケース ${cases} / 差のあったケース ${diffCases} / 差分画素 ${diffPixels}` +
          ` / 旧実装が切り落としていたケース ${wasClipped}${sample ? ` (${sample})` : ""}`
      );
    }

    const FAM = "maru" as const;
    const PX = 24;
    const V = (t: string, px = PX, family: any = FAM, bold = false) =>
      R.textToMask(t, px, { family, bold, vertical: true })!;

    // ② 縦に積まれる（1列・上から下）
    {
      const m = V("あいうえお");
      const cells: (ReturnType<typeof bbox>)[] = [];
      for (let k = 0; k < 5; k++) cells.push(bbox(m, 1 + k * PX, 1 + (k + 1) * PX));
      const allInk = cells.every((c) => c && c.n > 0);
      const descending = cells.every((c, i) => i === 0 || (c && cells[i - 1] && c!.cy > cells[i - 1]!.cy));
      add(
        "② 縦書き「あいうえお」が1列・上から下に5文字",
        m.w === PX + 2 && m.h === PX * 5 + 2 && allInk && descending,
        `w=${m.w}(期待${PX + 2}) h=${m.h}(期待${PX * 5 + 2}) / 各セルにインク=${allInk} / 中心が下がる=${descending}`
      );
    }

    /** 横書き単体の縦横比と、縦書きセルの縦横比を比べて回転を判定 */
    const rotated = (ch: string) => {
      const hm = R.textToMask(ch, PX, { family: FAM, bold: false });
      const hb = hm ? bbox(hm) : null;
      const vm = V(ch);
      const vb = bbox(vm, 1, 1 + PX);
      if (!hb || !vb) return null;
      const hr = hb.w / hb.h;
      const vr = vb.w / vb.h;
      return { hr: +hr.toFixed(3), vr: +vr.toFixed(3), isRotated: Math.abs(vr - 1 / hr) < Math.abs(vr - hr) };
    };

    // ③ 長音「ー」が回転
    {
      const r = rotated("ー");
      add("③ 「ー」が90°回転（縦棒になる）", !!r?.isRotated, r ? `横比=${r.hr} 縦比=${r.vr} → 回転=${r.isRotated}` : "測定不能");
    }
    // ④ 括弧が回転
    {
      const a = rotated("（"), b = rotated("」");
      add(
        "④ 括弧「（」「」」が回転",
        !!a?.isRotated && !!b?.isRotated,
        `（: 横比=${a?.hr} 縦比=${a?.vr} 回転=${a?.isRotated} ／ 」: 回転=${b?.isRotated}`
      );
    }
    // ⑤ 半角英数が回転・セル内に収まる
    {
      const m = V("ABC123");
      let inCell = true;
      const rots: boolean[] = [];
      for (const ch of ["A", "1"]) rots.push(!!rotated(ch)?.isRotated);
      for (let k = 0; k < 6; k++) {
        const b = bbox(m, 1 + k * PX, 1 + (k + 1) * PX);
        if (!b) { inCell = false; break; }
        if (b.x < 0 || b.x + b.w > m.w) inCell = false;
      }
      add(
        "⑤ 半角英数が回転し、各セル内に収まる",
        rots.every(Boolean) && inCell && m.h === PX * 6 + 2,
        `A・1 の回転=${JSON.stringify(rots)} / 全6セルが枠内=${inCell} / h=${m.h}`
      );
    }
    // ⑥ 句読点が右上寄り・回転しない
    {
      const m = V("こんにちは、世界。");
      const idx = [..."こんにちは、世界。"];
      const kutenCells = idx.map((c, i) => ({ c, i })).filter((o) => o.c === "、" || o.c === "。");
      const half = PX / 2;
      const res = kutenCells.map((o) => {
        const b = bbox(m, 1 + o.i * PX, 1 + (o.i + 1) * PX)!;
        const cellCx = 1 + half, cellCy = 1 + o.i * PX + half;
        return { c: o.c, right: b.cx > cellCx, top: b.cy < cellCy, cx: +b.cx.toFixed(1), cy: +b.cy.toFixed(1) };
      });
      const r = rotated("、");
      add(
        "⑥ 句読点が右上寄り・回転しない",
        res.every((o) => o.right && o.top) && r?.isRotated === false,
        `${res.map((o) => `${o.c}:右=${o.right} 上=${o.top}`).join(" / ")} ／ 「、」回転=${r?.isRotated}`
      );
    }
    // ⑦ ？！が回転しない
    {
      const q = rotated("？"), e = rotated("！");
      add(
        "⑦ 「？」「！」は回転しない",
        q?.isRotated === false && e?.isRotated === false,
        `？: 横比=${q?.hr} 縦比=${q?.vr} 回転=${q?.isRotated} ／ ！: 回転=${e?.isRotated}`
      );
    }
    // ⑧ M11-12: 240px を超える長文が**切られない**（旧実装は下端でクリップしていた）
    {
      let err = "";
      let m: { w: number; h: number; data: Uint8Array } | null = null;
      const N = 40;
      try {
        m = R.textToMask("あ".repeat(N), PX, { family: FAM, bold: false, vertical: true });
      } catch (e) {
        err = String(e);
      }
      add(
        "⑧ 240px を超える長文が切られない（M11-12 でクランプ廃止・例外なし）",
        !err && !!m && m.h === PX * N + 2 && m.w === PX + 2,
        err
          ? `例外: ${err}`
          : `h=${m?.h}（期待 ${PX * N + 2}・旧実装は ${HH} で切っていた）/ w=${m?.w}`
      );
    }

    // ---- M11-12: 改行と、はみ出しの保持 ----

    /** マスク a の y0 から h 行と、マスク b の y1 から h 行が同じか（幅は狭い方に合わせる） */
    const bandEq = (
      a: { w: number; h: number; data: Uint8Array },
      ay0: number,
      b: { w: number; h: number; data: Uint8Array },
      by0: number,
      h: number
    ) => {
      const w = Math.min(a.w, b.w);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (a.data[(ay0 + y) * a.w + x] !== b.data[(by0 + y) * b.w + x]) return false;
      return true;
    };
    /** マスクの列 [x0, x0+w) を切り出す */
    const colBand = (m: { w: number; h: number; data: Uint8Array }, x0: number, w: number) => {
      const d = new Uint8Array(w * m.h);
      for (let y = 0; y < m.h; y++)
        for (let x = 0; x < w; x++) d[y * w + x] = m.data[y * m.w + x0 + x] ?? 0;
      return { w, h: m.h, data: d };
    };
    const LH = Math.ceil(PX * 1.35); // 行送り

    // ⑨ 横書きの改行: 行が下へ・各行は1行だけで作ったものと同じ
    {
      const two = R.textToMask("あ\nい", PX, { family: FAM, bold: false })!;
      const a1 = R.textToMask("あ", PX, { family: FAM, bold: false })!;
      const b1 = R.textToMask("い", PX, { family: FAM, bold: false })!;
      const okH = two.h === LH * 2 + 2;
      const row1 = bandEq(two, 1, a1, 1, LH);
      const row2 = bandEq(two, 1 + LH, b1, 1, LH);
      add(
        "⑨ 横書きの改行: 行が下へ進み、各行は1行だけのときと同じ",
        okH && row1 && row2,
        `h=${two.h}（期待 ${LH * 2 + 2}）/ 1行目一致=${row1} / 2行目一致=${row2}`
      );
    }
    // ⑩ 縦書きの改行: 列が**左へ**進む（1列目が一番右）
    {
      const two = R.textToMask("あ\nい", PX, { family: FAM, bold: false, vertical: true })!;
      const a1 = V("あ");
      const b1 = V("い");
      const okW = two.w === PX * 2 + 2 && two.h === PX + 2;
      // 右の列（x = 1+PX 〜）が1列目「あ」・左の列（x = 1 〜）が2列目「い」
      const right = colBand(two, 1 + PX, PX);
      const left = colBand(two, 0, PX + 1);
      const rightIsFirst = bandEq(right, 0, colBand(a1, 1, PX), 0, two.h);
      const leftIsSecond = bandEq(left, 0, b1, 0, two.h);
      add(
        "⑩ 縦書きの改行: 列が左へ進む（1列目が一番右）",
        okW && rightIsFirst && leftIsSecond,
        `w=${two.w}(期待${PX * 2 + 2}) h=${two.h}(期待${PX + 2}) / 右列=1列目 ${rightIsFirst} / 左列=2列目 ${leftIsSecond}`
      );
    }
    // ⑪ 空行も1行ぶんの高さを取る
    {
      const m = R.textToMask("あ\n\nあ", PX, { family: FAM, bold: false })!;
      const mid = bbox(m, 1 + LH, 1 + LH * 2);
      const bottom = bbox(m, 1 + LH * 2, 1 + LH * 3);
      add(
        "⑪ 空行も1行ぶんの高さを取る（3行ぶんの高さ・真ん中は空）",
        m.h === LH * 3 + 2 && mid === null && bottom !== null,
        `h=${m.h}（期待 ${LH * 3 + 2}）/ 2行目のインク=${mid ? mid.n : 0} / 3行目のインク=${bottom ? bottom.n : 0}`
      );
    }
    // ⑫ 320px を超える長文が切られない（はみ出しの保持）
    {
      const t = "あ".repeat(30); // 24px × 30 = 720px 相当
      const m = R.textToMask(t, PX, { family: FAM, bold: false })!;
      const last = bbox(m, 0, m.h);
      add(
        "⑫ キャンバス幅を超える横書きが切られない",
        m.w > WW && !!last && last.x + last.w > WW,
        `w=${m.w}（キャンバス ${WW}）/ インクの右端=${last ? last.x + last.w : -1}`
      );
    }

    const allPass = results.every((r) => r.pass);
    // 見た目の確認用に縦書きサンプルを 1画素=3px で描く
    const draw = (t: string) => {
      const m = R.textToMask(t, PX, { family: FAM, bold: false, vertical: true });
      if (!m) return "<span>（生成なし）</span>";
      const s = 3;
      const cv = document.createElement("canvas");
      cv.width = m.w * s;
      cv.height = m.h * s;
      const c = cv.getContext("2d")!;
      c.fillStyle = "#fff";
      c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = "#111";
      for (let y = 0; y < m.h; y++)
        for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x]) c.fillRect(x * s, y * s, s, s);
      return `<figure style="margin:0 14px 0 0;display:inline-block;vertical-align:top">
        <img src="${cv.toDataURL()}" style="image-rendering:pixelated;border:1px solid #ccc">
        <figcaption style="font:11px monospace;text-align:center">${t}</figcaption></figure>`;
    };
    document.body.innerHTML = `<div style="padding:16px;font:13px monospace;background:#fff">
      <h2 style="margin:0 0 10px">縦書き検証（?vtext）</h2>
      <p style="font-size:16px;font-weight:700;color:${allPass ? "#0a7" : "#c00"}">
        ${allPass ? "ALL PASS" : "FAIL あり"}</p>
      <table style="border-collapse:collapse;margin-bottom:16px">${results
        .map(
          (r) =>
            `<tr><td style="padding:3px 10px;border-bottom:1px solid #eee;color:${
              r.pass ? "#0a7" : "#c00"
            };font-weight:700">${r.pass ? "PASS" : "FAIL"}</td>
             <td style="padding:3px 10px;border-bottom:1px solid #eee">${r.name}</td>
             <td style="padding:3px 10px;border-bottom:1px solid #eee;color:#666">${r.detail}</td></tr>`
        )
        .join("")}</table>
      <div>${["あいうえお", "スピード", "（テスト）", "ABC123", "こんにちは、世界。", "？！"].map(draw).join("")}</div></div>`;
    (window as unknown as Record<string, unknown>).__vtext = { allPass, results };
    return;
  }
  // M10-1c: 文字マスク検証ページ（devフック ?textmask）
  // 5書体×各サイズを textToMask に通し、1画素=1px で並べる。
  // 参照ビットマップ（tools/fonts/verify_text_mask.ts の出力 JSON）を
  // ?textmask&ref=/path.json で渡すと、差分画素数を数値で出す。
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("textmask")) {
    const R = await import("./editor/raster");
    const { FONTS, ensureFontsLoaded } = await import("./editor/fonts");
    const SAMPLE = "あいうえお アイウエオ 漢字 ABC 123";
    document.body.innerHTML = `<div style="padding:16px;background:#fff">
      <h2 style="margin:0 0 4px">文字マスク検証（1画素=1px 等倍）</h2>
      <p style="margin:0 0 12px;font-size:12px">見本: ${SAMPLE}　／　dot系=alpha&gt;128・outline系=3倍レンダ→3×3平均→&gt;=128</p>
      <div id="tm"></div></div>`;
    const host = document.getElementById("tm")!;
    await ensureFontsLoaded();
    // 参照 JSON（任意）。±1px の平行移動を許容して最小差分を求める
    const refUrl = new URLSearchParams(location.search).get("ref");
    let refs: Record<string, { w: number; h: number; bits: string }> | null = null;
    if (refUrl) {
      try {
        refs = (await (await fetch(refUrl)).json()).refs;
      } catch {
        /* 参照なしでも描画だけは出す */
      }
    }
    // 許容する平行移動量。Skia(参照生成) と DirectWrite(WebView2) で textBaseline="top" の
    // 原点解釈が違い、**そのズレは em サイズに比例する**（美咲で 8px→1px / 16px→2px / 24px→3px）。
    // 固定 ±1px だと大きいサイズで一致しなくなるので、サイズに比例させる。
    // 平行移動だけで diff=0 になること自体が「設計グリッドが無傷」であることの証拠。
    const shiftRange = (px: number) => Math.max(1, Math.round(px / 8) + 1);
    const bestDiff = (
      mask: { w: number; h: number; data: Uint8Array },
      ref: { w: number; h: number; bits: string },
      px: number
    ) => {
      const RANGE = shiftRange(px);
      let best = Infinity;
      let at = "";
      for (let dy = -RANGE; dy <= RANGE; dy++) {
        for (let dx = -RANGE; dx <= RANGE; dx++) {
          let d = 0;
          for (let y = 0; y < ref.h; y++) {
            for (let x = 0; x < ref.w; x++) {
              const sx = x + dx;
              const sy = y + dy;
              const v =
                sx >= 0 && sx < mask.w && sy >= 0 && sy < mask.h ? mask.data[sy * mask.w + sx] : 0;
              if (v !== Number(ref.bits[y * ref.w + x])) d++;
            }
          }
          if (d < best) {
            best = d;
            at = `dx=${dx},dy=${dy}`;
          }
        }
      }
      return { best, at };
    };
    const results: Record<string, unknown> = {};
    for (const f of FONTS) {
      for (const px of f.sizes) {
        const mask = R.textToMask(SAMPLE, px, { family: f.key, bold: false });
        const row = document.createElement("div");
        row.style.cssText = "margin:0 0 10px;font:11px monospace";
        let note = "";
        if (mask && refs && refs[`${f.key}@${px}`]) {
          const r = bestDiff(mask, refs[`${f.key}@${px}`], px);
          const chars = [...SAMPLE].filter((c) => c !== " ").length;
          note = `　diff=${r.best} (${r.at}) / 1文字あたり ${(r.best / chars).toFixed(2)} 画素`;
          results[`${f.key}@${px}`] = { diff: r.best, at: r.at, perChar: r.best / chars };
        }
        row.textContent = `${f.label} ${px}px${note}`;
        host.appendChild(row);
        if (mask) {
          const cv = document.createElement("canvas");
          cv.width = mask.w;
          cv.height = mask.h;
          cv.style.cssText = "display:block;border:1px solid #ccc;background:#fff;margin:2px 0 0";
          const c = cv.getContext("2d")!;
          c.fillStyle = "#000";
          for (let y = 0; y < mask.h; y++)
            for (let x = 0; x < mask.w; x++)
              if (mask.data[y * mask.w + x]) c.fillRect(x, y, 1, 1);
          host.appendChild(cv);
        }
      }
    }
    (window as unknown as Record<string, unknown>).__textmask = results;
    return;
  }
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("editor")) {
    // 開発用: Tauriなしでエディタを確認する（?editor / ?editor&kwz=/xxx.kwz でインポート経路）
    const kwzUrl = new URLSearchParams(location.search).get("kwz");
    if (kwzUrl) {
      const buf = await (await fetch(kwzUrl)).arrayBuffer();
      const { project } = await importFlipnote(buf, kwzUrl);
      showEditor(project, null);
    } else {
      showEditor(newProject("デザイン確認"), null);
    }
    return;
  }
  // M10-19: 本番のどの起動経路（初回ガイド・ライブラリ消失の空状態含む）でも必ず効くよう
  // 早期に設置（DEV 専用の ?warp 等の検証ページは対象外でよい）
  setupContextMenuBlock();
  try {
    const info = await invoke<{ name: string; version: string; milestone: string }>(
      "app_info"
    );
    appInfoCache = info;
    // ヘッダーはバージョンのみ（非公式・非営利の表明は設定→バージョン情報と README.txt に集約）
    $("#app-meta").textContent = `v${info.version}`;
  } catch {
    /* noop */
  }
  try {
    settings = await invoke<Settings>("load_settings");
  } catch {
    settings = {};
  }
  // M10-20: 並び順を設定から復元（項目なし・不正値は "manual"＝従来挙動）
  library.shelfSort =
    settings.shelfSort === "name" || settings.shelfSort === "date"
      ? settings.shelfSort
      : "manual";
  // M7-1 R-A: settings.json 破損回復（.broken 退避済み・既定値で起動）の案内
  if ((settings as Record<string, unknown>).__recovered) {
    delete (settings as Record<string, unknown>).__recovered;
    logError("recovery", "settings.json が破損していたため初期化（settings.json.broken へ退避）");
    await modal((close) => {
      const box = document.createElement("div");
      box.innerHTML = `
        <p class="modal-msg"><b>設定を初期化しました</b><br>
        設定ファイルが壊れていたため、初期状態で起動しました（元のファイルは settings.json.broken に退避）。<br>
        ライブラリフォルダを選び直してください。取り込み済みの作品ファイルはそのまま残っています。</p>
        <div class="modal-actions"><button class="btn primary">OK</button></div>`;
      (box.querySelector("button") as HTMLElement).addEventListener("click", () => close(null));
      return box;
    });
  }
  // M11-10: ショートカットの割り当てを復元（壊れた項目だけ捨てて既定へ）
  keys = sanitizeKeysSettings(settings.keys);
  applyKeys();
  // M7-2b: ⚙ = 設定メニュー（エクスプローラー直結を廃止。フォルダ変更はメニュー内へ移設）
  $("#lib-change-dir").addEventListener("click", () => void openSettingsMenu());
  // M7-2b: ディスプレイ設定の復元（破損値は既定へ）
  await applyDisplaySettings(settings.display);
  await firstRunGate();
  // M7-1 R-A: ライブラリフォルダ消失（USB抜き・改名）→ 設定は保持し、選び直しの空状態
  const dirOk = await invoke<boolean>("dir_exists", { path: settings.libraryDir! }).catch(
    () => true // チェック自体の失敗は従来経路に任せる
  );
  if (!dirOk) {
    showMissingLibraryState();
    return;
  }
  // M7-1 R-A: 索引破損 → .broken 退避＋ディスク再構築（取り込み済みファイルは無事）
  const indexRecovered = await invoke<boolean>("library_health", {
    libRoot: settings.libraryDir!,
  }).catch(() => false);
  if (indexRecovered) {
    logError(
      "recovery",
      `索引が破損していたため再構築（${settings.libraryDir}/animemo-library.json.broken へ退避）`
    );
    toast("ライブラリ索引を再構築しました（取り込み済みのファイルは無事です）");
  }
  await library.mount(settings.libraryDir!, libraryCallbacks);
  library.bindTransport();
  await setupFileDrop();
  // M7-2: 初回ガイド（画面が揃ってから。完了/スキップで guideDone 保存・以後は出ない）
  if (!settings.guideDone) await startGuideFlow(false);
  await checkAutosave();
});

/** M7-1 R-A: ライブラリフォルダが見つからないときの空状態（設定は消さない・選び直しで復帰） */
function showMissingLibraryState() {
  const shelf = $("#shelf-grid");
  const albums = $("#albums-list");
  const title = $("#shelf-title");
  if (title) title.textContent = "フォルダが見つかりません";
  if (albums) albums.innerHTML = "";
  if (shelf) {
    shelf.innerHTML = "";
    const box = document.createElement("div");
    box.className = "lib-missing";
    box.innerHTML = `
      <p><b>ライブラリフォルダが見つかりません</b></p>
      <p class="hintline">${settings.libraryDir ?? ""}</p>
      <p class="hintline">USBメモリを抜いた・フォルダ名を変えた場合は、元に戻してアプリを再起動するか、下のボタンで選び直してください（設定は保持されています）。</p>
      <button class="btn primary" id="lib-missing-pick">📁 フォルダを選び直す</button>`;
    shelf.appendChild(box);
    (box.querySelector("#lib-missing-pick") as HTMLElement).addEventListener("click", async () => {
      if (await chooseLibraryDir()) {
        await library.mount(settings.libraryDir!, libraryCallbacks);
        library.bindTransport();
        await setupFileDrop();
        await checkAutosave();
        toast(`ライブラリ: ${settings.libraryDir}`);
      }
    });
  }
}

const libraryCallbacks = {
  openEditorWithNote,
  openEditorWithProject,
  newNote,
  openExport: (source: FrameSource, baseName: string, audio?: ExportAudioSource | null) =>
    void openExportDialog(source, baseName, null, audio),
  confirm: confirmDialog,
  prompt: promptDialog,
  toast,
  // M10-20: 並び順は変えた瞬間に保存（文字設定と同じ流儀）
  onShelfSortChange: (v: "manual" | "name" | "date") => {
    settings.shelfSort = v;
    invoke("save_settings", { settings }).catch(() => {});
  },
  // M11-3: 「📁 移動」の移動先ピッカー（保存先ピッカーと同じ modal() の流儀）
  pickAlbum,
};
