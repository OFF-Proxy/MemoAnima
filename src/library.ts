// ライブラリ（閲覧）画面（M3・モック animemo_ui_mockup.html 準拠 / お気に入り→ファイル管理）
// 3カラム: 左=アルバム（実フォルダ） / 中央=大ビューア＋再生コントロール / 右=サムネ棚
// 下=取り込み進捗バー。ファイル管理: メモ移動（DnD）・フォルダ作成/リネーム/削除・並べ替え（DnD）。

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Player, parse } from "flipnote.js";
import { Project, FPS_TABLE } from "./editor/model";
import { compositeFrame, presentToCanvas, frameToPngBlob } from "./editor/render";
import { projectFromBytes } from "./editor/serialize";
import { FrameSource, ExportAudioSource, noteSource, projectSource } from "./editor/exporter";
import { AudioPreview, pcmS16ToWav, bgmPlaybackRate, renderExportMix } from "./editor/audio";
import type { BgmTrack } from "./editor/model";

export type LibraryView = {
  kind: "note" | "project";
  hash: string;
  album: string;
  name: string;
  ext: string;
  size: number;
  path: string;
  thumb_path: string | null;
  order: number;
  /** M10-20: 日付順ソート用の unix 秒（note=取り込み日 / project=最終保存日・失敗は0） */
  sorted_at: number;
};

type ImportProgress = {
  done: number;
  total: number;
  album: string;
  imported: number;
  skipped: number;
};

export interface LibraryCallbacks {
  openEditorWithNote: (item: LibraryView) => void;
  openEditorWithProject: (item: LibraryView) => void;
  newNote: (album: string) => void;
  /** M6-1/2: エクスポートダイアログを開く（M5-1: ミックス生成つき音声ソース） */
  openExport: (source: FrameSource, baseName: string, audio?: ExportAudioSource | null) => void;
  confirm: (msg: string) => Promise<boolean>;
  prompt: (msg: string, def: string) => Promise<string | null>;
  toast: (msg: string) => void;
  /** M10-20: 並び順の変更を設定へ保存する（文字設定と同じ「変えた瞬間に保存」の流儀） */
  onShelfSortChange?: (v: "manual" | "name" | "date") => void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

export class LibraryScreen {
  libRoot = "";
  cb!: LibraryCallbacks;
  items: LibraryView[] = [];
  albums: string[] = [];
  currentAlbum = "";
  selected: LibraryView | null = null;
  search = "";
  /** M10-20: サムネ棚の並び順（manual=従来の order 順。設定から復元・変更時は cb で保存） */
  shelfSort: "manual" | "name" | "date" = "manual";

  private player: Player | null = null;
  private keydownBound = false;
  private unlistenProgress: UnlistenFn | null = null;
  private previewTimer: number | null = null;
  private previewProject: Project | null = null;
  private previewFrame = 0;
  private previewPlaying = false;
  /** ステージの表示モード（note=.kwz/.ppm・映像は自前キャンバス / project=.animemo） */
  private stageMode: "note" | "project" = "note";
  /** M6-2: .animemo プレビューの音声（.kwz は Player が音声担当・現状維持） */
  private audioPreview = new AudioPreview();
  // ノート描画のバッファ再利用（毎フレーム確保しない）
  private noteFrameBuf: Uint32Array | null = null;
  private notePaletteBuf: Uint32Array | null = null;

  async mount(libRoot: string, cb: LibraryCallbacks) {
    this.libRoot = libRoot;
    this.cb = cb;
    this.bindHeader();
    this.bindAlbumOps();
    if (!this.unlistenProgress) {
      this.unlistenProgress = await listen<ImportProgress>("import-progress", (e) =>
        this.updateProgress(e.payload)
      );
    }
    if (!this.keydownBound) {
      this.keydownBound = true;
      window.addEventListener("keydown", (e) => {
        // ライブラリ画面表示中のみ・入力欄以外で Delete → 選択メモ削除（L-1）
        if ($("#screen-library").hidden) return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (e.key === "Delete" && this.selected) {
          e.preventDefault();
          void this.deleteSelected();
        }
      });
    }
    await this.refresh();
  }

  suspend() {
    this.stopPreview();
    try {
      this.player?.pause();
    } catch {
      /* noop */
    }
  }

  async refresh() {
    try {
      const [items, albums] = await Promise.all([
        invoke<LibraryView[]>("scan_library", { libRoot: this.libRoot }),
        invoke<string[]>("list_albums", { libRoot: this.libRoot }),
      ]);
      this.items = items;
      this.albums = albums;
      if (!this.currentAlbum || !albums.includes(this.currentAlbum)) {
        this.currentAlbum = albums[0] ?? "";
      }
      this.renderAlbums();
      this.renderShelf();
    } catch (e) {
      this.cb.toast(`ライブラリ読み込みエラー: ${e}`);
    }
  }

  // ---------------- ヘッダー ----------------

  private bindHeader() {
    $("#lib-import").onclick = () => this.importFolder();
    $("#lib-open-file").onclick = () => this.openSingleFile();
    $("#lib-new-note").onclick = () =>
      this.cb.newNote(this.currentAlbum || "未分類");
    ($("#lib-search") as HTMLInputElement).oninput = (e) => {
      this.search = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderShelf();
    };
    $("#lib-cancel-import").onclick = () => invoke("cancel_import");
    // M10-20: 並び順セレクト（切り替えは再描画のみ・再スキャンしない。選択/プレビューは維持）
    const sortSel = $("#shelf-sort") as HTMLSelectElement;
    sortSel.value = this.shelfSort;
    sortSel.onchange = () => {
      const v = sortSel.value;
      this.shelfSort = v === "name" || v === "date" ? v : "manual";
      this.renderShelf();
      this.cb.onShelfSortChange?.(this.shelfSort);
    };
  }

  private bindAlbumOps() {
    $("#album-add").onclick = async () => {
      const name = await this.cb.prompt("新しいアルバム名", "新しいアルバム");
      if (!name) return;
      try {
        await invoke("create_album", { libRoot: this.libRoot, name });
        await this.refresh();
      } catch (e) {
        this.cb.toast(String(e));
      }
    };
    $("#album-rename").onclick = async () => {
      if (!this.currentAlbum) return;
      const name = await this.cb.prompt("アルバム名を変更", this.currentAlbum);
      if (!name || name === this.currentAlbum) return;
      try {
        await invoke("rename_album", {
          libRoot: this.libRoot,
          old: this.currentAlbum,
          new: name,
        });
        this.currentAlbum = name;
        await this.refresh();
      } catch (e) {
        this.cb.toast(String(e));
      }
    };
    $("#album-delete").onclick = async () => {
      if (!this.currentAlbum) return;
      const ok = await this.cb.confirm(
        `アルバム「${this.currentAlbum}」を削除しますか？（空のフォルダのみ削除できます）`
      );
      if (!ok) return;
      try {
        await invoke("delete_album", { libRoot: this.libRoot, name: this.currentAlbum });
        this.currentAlbum = "";
        await this.refresh();
      } catch (e) {
        this.cb.toast(String(e));
      }
    };
  }

  // ---------------- 取り込み ----------------

  private async importFolder() {
    const src = await open({
      directory: true,
      multiple: false,
      title: "取り込み元フォルダを選択（SDカード内の private → …3DS → app → JKZJ）",
    });
    if (!src || typeof src !== "string") return;
    const footer = $("#import-footer");
    footer.hidden = false;
    $("#import-label").textContent = "📥 取り込み中…";
    try {
      const res = await invoke<any>("import_flipnotes", {
        srcRoot: src,
        libRoot: this.libRoot,
      });
      const msg = res.cancelled
        ? `中断しました（新規 ${res.imported}件まで取り込み済み）`
        : `完了: 新規 ${res.imported}件 / スキップ ${res.skipped}件${res.failed ? ` / 失敗 ${res.failed}件` : ""}`;
      this.cb.toast(msg);
    } catch (e) {
      this.cb.toast(`取り込みエラー: ${e}`);
    } finally {
      footer.hidden = true;
      await this.refresh();
    }
  }

  private updateProgress(p: ImportProgress) {
    const footer = $("#import-footer");
    footer.hidden = false;
    $("#import-label").textContent = `📥 取り込み中… ${p.album}（スキップ ${p.skipped}）`;
    $("#import-count").textContent = `${p.done} / ${p.total}`;
    ($("#import-bar-fill") as HTMLElement).style.width = `${Math.round(
      (p.done / Math.max(1, p.total)) * 100
    )}%`;
  }

  /** 単発 .kwz/.ppm（合作受け取り）: ライブラリへ取り込んで開く */
  async openSingleFile(path?: string) {
    if (!path) {
      const sel = await open({
        multiple: false,
        title: "3DS作品を開く（.kwz / .ppm）",
        filters: [{ name: "3DS作品 (.kwz/.ppm)", extensions: ["kwz", "ppm"] }],
      });
      if (!sel || typeof sel !== "string") return;
      path = sel;
    }
    const album = await this.cb.prompt("取り込み先アルバム", "合作");
    if (album == null) return;
    try {
      const [destPath, hash] = await invoke<[string, string]>("import_single_file", {
        libRoot: this.libRoot,
        srcPath: path,
        album,
      });
      await this.refresh();
      this.currentAlbum = album;
      this.renderAlbums();
      this.renderShelf();
      const item = this.items.find((i) => i.hash === hash);
      if (item) await this.select(item);
      else this.cb.toast(`取り込みました: ${destPath}`);
    } catch (e) {
      this.cb.toast(`取り込みエラー: ${e}`);
    }
  }

  // ---------------- 左: アルバム ----------------

  private renderAlbums() {
    const host = $("#albums-list");
    host.innerHTML = "";
    const counts = new Map<string, number>();
    for (const it of this.items) counts.set(it.album, (counts.get(it.album) ?? 0) + 1);
    for (const album of this.albums) {
      const row = document.createElement("div");
      row.className = "album" + (album === this.currentAlbum ? " active" : "");
      const label = document.createElement("span");
      label.textContent = album;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(counts.get(album) ?? 0);
      row.appendChild(label);
      row.appendChild(n);
      row.onclick = () => {
        this.currentAlbum = album;
        this.renderAlbums();
        this.renderShelf();
      };
      // メモ移動のドロップ先
      row.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes("text/animemo-note")) {
          e.preventDefault();
          row.classList.add("drop");
        }
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        row.classList.remove("drop");
        const hash = e.dataTransfer?.getData("text/animemo-note");
        if (!hash) return;
        try {
          await invoke("move_note", { libRoot: this.libRoot, hash, destAlbum: album });
          this.cb.toast(`「${album}」へ移動しました`);
          await this.refresh();
        } catch (err) {
          this.cb.toast(String(err));
        }
      });
      host.appendChild(row);
    }
  }

  // ---------------- 右: サムネ棚 ----------------

  private shelfItems(): LibraryView[] {
    let list = this.items.filter((i) => i.album === this.currentAlbum);
    if (this.search) {
      list = this.items.filter((i) => i.name.toLowerCase().includes(this.search));
    }
    // M10-20: 並び順の適用。manual は従来どおり Rust の既定ソート（album→order→name）のまま
    // 1件も並びを変えない。name/date は写しをソート（this.items 自体は並べ替えない）
    if (this.shelfSort === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    } else if (this.shelfSort === "date") {
      list = [...list].sort(
        (a, b) => b.sorted_at - a.sorted_at || a.name.localeCompare(b.name, "ja")
      );
    }
    return list;
  }

  private renderShelf() {
    const grid = $("#shelf-grid");
    grid.innerHTML = "";
    const list = this.shelfItems();
    $("#shelf-title").textContent = this.search
      ? `検索: ${this.search}`
      : this.currentAlbum || "（アルバムなし）";
    $("#shelf-count").textContent = `${list.length}作品`;
    for (const it of list) {
      const card = document.createElement("div");
      card.className =
        "thumb" + (this.selected && this.selected.path === it.path ? " active" : "");
      card.draggable = it.kind === "note";
      const pic = document.createElement("div");
      pic.className = "pic";
      const img = document.createElement("img");
      img.alt = it.name;
      pic.appendChild(img);
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = (it.kind === "project" ? "📝 " : "") + it.name;
      card.dataset.path = it.path; // L-2: 選択ハイライトの差分更新用
      card.appendChild(pic);
      card.appendChild(cap);
      card.onclick = () => this.select(it);
      card.ondblclick = () => this.edit(it);
      // 並べ替えキー: ノート=h:<hash> / プロジェクト=p:<rel_path>（両方永続化）
      const orderKey = this.orderKey(it);
      card.draggable = true;
      card.addEventListener("dragstart", (e) => {
        if (it.kind === "note") e.dataTransfer?.setData("text/animemo-note", it.hash);
        e.dataTransfer?.setData("text/animemo-order", orderKey);
      });
      card.addEventListener("dragover", (e) => {
        // M10-20: 並び替えドロップは「手動」モードのときだけ受ける（名前順・日付順では
        // order を誤操作で壊さない。アルバム行へのメモ移動ドロップは従来どおり全モード有効）
        if (this.shelfSort !== "manual") return;
        if (e.dataTransfer?.types.includes("text/animemo-order")) e.preventDefault();
      });
      card.addEventListener("drop", async (e) => {
        if (this.shelfSort !== "manual") return; // M10-20: 念のための二重ガード
        e.preventDefault();
        const fromKey = e.dataTransfer?.getData("text/animemo-order");
        if (!fromKey || fromKey === orderKey) return;
        await this.reorder(fromKey, orderKey);
      });
      grid.appendChild(card);
      this.loadThumb(img, it);
    }
  }

  private orderKey(it: LibraryView): string {
    return it.kind === "note" ? `h:${it.hash}` : `p:${it.album}/${it.name}`;
  }

  private async reorder(fromKey: string, toKey: string) {
    // M10-20: 手動モード以外では order を書かない（shelfItems がソート済み配列を返すため、
    // ここを通すと表示順がそのまま order に焼き付いてしまう）
    if (this.shelfSort !== "manual") return;
    const keys = this.shelfItems().map((i) => this.orderKey(i));
    const fi = keys.indexOf(fromKey);
    const ti = keys.indexOf(toKey);
    if (fi < 0 || ti < 0) return;
    keys.splice(ti, 0, ...keys.splice(fi, 1));
    try {
      await invoke("set_note_order", { libRoot: this.libRoot, hashes: keys });
      await this.refresh();
    } catch (e) {
      this.cb.toast(String(e));
    }
  }

  // サムネイル（遅延・1件ずつ）
  private thumbQueue: (() => Promise<void>)[] = [];
  private thumbRunning = false;

  private enqueueThumb(job: () => Promise<void>) {
    this.thumbQueue.push(job);
    if (!this.thumbRunning) void this.runThumbQueue();
  }

  private async runThumbQueue() {
    this.thumbRunning = true;
    while (this.thumbQueue.length > 0) {
      const job = this.thumbQueue.shift()!;
      try {
        await job();
      } catch {
        /* 1件の失敗で止めない */
      }
    }
    this.thumbRunning = false;
  }

  private loadThumb(img: HTMLImageElement, it: LibraryView) {
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.disconnect();
        this.enqueueThumb(async () => {
          if (it.kind === "project") {
            if (it.thumb_path) {
              try {
                const bytes = await invoke<number[]>("read_file_bytes", {
                  path: it.thumb_path,
                });
                img.src = URL.createObjectURL(
                  new Blob([new Uint8Array(bytes)], { type: "image/png" })
                );
                return;
              } catch {
                // サイドカーが読めない → 下の生成フォールバックへ
              }
            }
            // M10-14: 直置き/受け取りファイルはサイドカーPNGが無い。
            // .kwz 側と同じく、その場で生成して保存規約どおりの場所へ書き戻す
            //（次回からは即表示）。壊れたファイルは握りつぶしてプレースホルダのまま。
            try {
              const bytes = await invoke<number[]>("read_file_bytes", { path: it.path });
              const project = await projectFromBytes(new Uint8Array(bytes));
              const blob = await frameToPngBlob(project, project.thumbFrame ?? 0);
              if (!blob) return;
              img.src = URL.createObjectURL(blob);
              const ab = await blob.arrayBuffer();
              await invoke("save_project_thumb", {
                libRoot: this.libRoot,
                projectPath: it.path,
                png: Array.from(new Uint8Array(ab)),
              }).catch(() => {});
            } catch {
              // パース失敗＝プレースホルダ表示のまま（クラッシュさせない）
            }
            return;
          }
          const cached = await invoke<number[] | null>("load_thumb", {
            libRoot: this.libRoot,
            hash: it.hash,
          });
          if (cached && cached.length > 0) {
            img.src = URL.createObjectURL(
              new Blob([new Uint8Array(cached)], { type: "image/png" })
            );
            return;
          }
          const bytes = await invoke<number[]>("read_file_bytes", { path: it.path });
          const note: any = await parse(new Uint8Array(bytes).buffer);
          const frame = note.thumbFrameIndex ?? 0;
          const w = note.imageWidth;
          const h = note.imageHeight;
          const pixels = note.getFramePixelsRgba(frame);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d")!;
          const imgData = ctx.createImageData(w, h);
          imgData.data.set(
            new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, w * h * 4)
          );
          ctx.putImageData(imgData, 0, 0);
          const blob: Blob | null = await new Promise((res) =>
            canvas.toBlob(res, "image/png")
          );
          if (!blob) return;
          img.src = URL.createObjectURL(blob);
          const ab = await blob.arrayBuffer();
          await invoke("save_thumb", {
            libRoot: this.libRoot,
            hash: it.hash,
            png: Array.from(new Uint8Array(ab)),
          }).catch(() => {});
        });
      }
    });
    obs.observe(img);
  }

  // ---------------- 中央: ビューア ----------------

  private ensurePlayer(): Player {
    if (!this.player) {
      // M3.5: Player は再生制御＋音声のみ（キャンバスは CSS で非表示）。
      // 映像は frameupdate ごとに #preview-host（ネイティブ解像度バッキング）へ自前描画する。
      // 理由: Player 内部は useDpi=true 固定で、OSスケーリング(dpr 1.25等)だと
      // resize(320,240) でもバッキングが 400×300 になり内部補間のボケが焼き込まれるため、
      // 「ネイティブ 320×240 → CSS pixelated の一段スケール」を自前キャンバスで保証する。
      this.player = new Player("#player-host", 320, 240);
      (this.player as any).on?.("frameupdate", () => this.drawNoteFrame());
    }
    return this.player;
  }

  /** 現在フレームをネイティブ解像度で #preview-host に描く（nearest-neighbor はCSSに一任） */
  private drawNoteFrame() {
    if (this.stageMode !== "note" || !this.player) return;
    const note: any = (this.player as any).note;
    if (!note) return;
    const w: number = note.imageWidth;
    const h: number = note.imageHeight;
    const cv = $("#preview-host") as unknown as HTMLCanvasElement;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    if (!this.noteFrameBuf || this.noteFrameBuf.length < w * h)
      this.noteFrameBuf = new Uint32Array(w * h);
    if (!this.notePaletteBuf) this.notePaletteBuf = new Uint32Array(32);
    const frame = Math.max(0, (this.player as any).currentFrame ?? 0);
    const pixels: Uint32Array = note.getFramePixelsRgba(
      frame,
      this.noteFrameBuf,
      this.notePaletteBuf
    );
    const ctx = cv.getContext("2d")!;
    const img = new ImageData(
      new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, w * h * 4),
      w,
      h
    );
    ctx.putImageData(img, 0, 0);
  }

  /** L-2: 選択ハイライトは棚を再構築せずクラス切替のみ（スクロール位置を保つ） */
  private updateShelfSelection() {
    const sel = this.selected?.path ?? null;
    document.querySelectorAll<HTMLElement>("#shelf-grid .thumb").forEach((c) => {
      c.classList.toggle("active", sel != null && c.dataset.path === sel);
    });
  }

  async select(it: LibraryView) {
    this.selected = it;
    this.updateShelfSelection();
    $("#stage-title").textContent = it.name;
    $("#stage-author").textContent = it.album;
    this.stopPreview();
    const previewHost = $("#preview-host") as unknown as HTMLCanvasElement;
    try {
      if (it.kind === "note") {
        this.stageMode = "note";
        previewHost.hidden = false;
        const bytes = await invoke<number[]>("read_file_bytes", { path: it.path });
        const p = this.ensurePlayer();
        await p.load(new Uint8Array(bytes).buffer);
        const note: any = (p as any).note;
        this.renderMeta([
          `${(note?.format ?? it.ext).toString().toUpperCase()}`,
          `${note?.imageWidth ?? "?"} × ${note?.imageHeight ?? "?"}`,
          `${note?.frameCount ?? "?"} コマ`,
          `${note?.framerate ?? "?"} fps`,
        ]);
        this.drawNoteFrame();
        p.play();
      } else {
        this.stageMode = "project";
        previewHost.hidden = false;
        try {
          this.player?.pause();
        } catch {
          /* noop */
        }
        const bytes = await invoke<number[]>("read_file_bytes", { path: it.path });
        this.previewProject = await projectFromBytes(new Uint8Array(bytes));
        this.previewFrame = 0;
        this.renderMeta([
          "メモアニマ",
          "320 × 240",
          `${this.previewProject.frames.length} コマ`,
          `${FPS_TABLE[this.previewProject.speedIndex]} fps`,
        ]);
        this.drawPreview();
        this.startPreview();
      }
    } catch (e) {
      this.renderMeta([`読み込みエラー: ${e}`]);
    }
  }

  private renderMeta(chips: string[]) {
    const host = $("#stage-meta");
    host.innerHTML = "";
    chips.forEach((c, i) => {
      const el = document.createElement("span");
      el.className = "chip" + (i === 0 ? " red" : "");
      el.textContent = c;
      host.appendChild(el);
    });
    const edit = document.createElement("button");
    edit.className = "chip edit";
    edit.textContent = "✏ 編集";
    edit.onclick = () => this.selected && this.edit(this.selected);
    host.appendChild(edit);
    const exp = document.createElement("button");
    exp.className = "chip export";
    exp.textContent = "⬇ 書き出し";
    exp.onclick = () => this.exportSelected();
    host.appendChild(exp);
    const del = document.createElement("button");
    del.className = "chip danger";
    del.textContent = "🗑 削除";
    del.onclick = () => this.selected && this.deleteSelected();
    host.appendChild(del);
  }

  /** M6-1/2: 選択中の作品（.kwz/.animemo）を書き出す（.kwz直接でも元音を載せる） */
  exportSelected() {
    const it = this.selected;
    if (!it) return;
    const baseName = it.name.replace(/\.[^.]+$/, "");
    if (it.kind === "note") {
      const note: any = (this.player as any)?.note;
      if (!note) {
        this.cb.toast("作品の読み込みが終わってから書き出してください");
        return;
      }
      try {
        this.player?.pause();
      } catch {
        /* noop */
      }
      this.updatePlayButton();
      // M6-2/M5-1: .kwz 直接書き出しは元のマスターミックス（BGM+SE込み・原作タイミング）を
      // BGM 1本として載せる（速度変更UIが無い経路なので rate=1 で従来と同一の出力）
      let bgm: BgmTrack | null = null;
      try {
        let hasAudio = false;
        note.soundMeta?.forEach?.((v: { length?: number } | undefined) => {
          if (v && (v.length ?? 0) > 0) hasAudio = true;
        });
        if (hasAudio) {
          const rate: number = note.sampleRate ?? 16364;
          const pcm: Int16Array | null = note.getAudioMasterPcm?.(rate) ?? null;
          if (pcm && pcm.length > 0) {
            bgm = {
              source: "kwz",
              mime: "audio/wav",
              data: pcmS16ToWav(pcm, rate, 1),
              muted: false,
              volume: 1,
              trimStartMs: 0,
              trimEndMs: null,
              syncMode: "audioToAnim",
              baseSpeedIndex: 6,
            };
          }
        }
      } catch {
        bgm = null;
      }
      this.cb.openExport(noteSource(note), baseName, this.audioSourceFor(bgm, null, note.frameCount, note.framerate));
    } else {
      if (!this.previewProject) {
        this.cb.toast("作品の読み込みが終わってから書き出してください");
        return;
      }
      this.stopPreview();
      const pp = this.previewProject;
      this.cb.openExport(
        projectSource(pp),
        baseName,
        this.audioSourceFor(pp.audio?.bgm ?? null, pp, pp.frames.length, FPS_TABLE[pp.speedIndex] || 8)
      );
    }
  }

  /** M5-1: 書き出しダイアログ用の音声ソースを組み立てる。
   *  proj=null（.kwz直）はマスターミックスBGMのみ（rate=1・従来出力と同一）。
   *  proj あり（.animemoプレビュー）は BGM＋配置SEの最終ミックス。 */
  private audioSourceFor(
    bgm: BgmTrack | null,
    proj: Project | null,
    frameCount: number,
    fps: number
  ): ExportAudioSource | null {
    const se = proj?.audio?.se ?? [];
    const anySePlaced = !!proj && proj.frames.some((f) => f.se && f.se.length > 0);
    if (!bgm && !anySePlaced) return null;
    const anySeAudible =
      !!proj &&
      proj.frames.some((f) =>
        f.se?.some((id) => {
          const t = se.find((s) => s.id === id);
          return !!t && !t.muted;
        })
      );
    const audible = (!!bgm && !bgm.muted) || anySeAudible;
    return {
      has: true,
      allMuted: !audible,
      syncMode: bgm?.syncMode ?? "audioToAnim",
      build: async (range, syncMode) => {
        const lo = range ? Math.min(range.a, range.b) : 0;
        const hi = range ? Math.max(range.a, range.b) : frameCount - 1;
        const frameSe: (string[] | undefined)[] = [];
        for (let i = lo; i <= hi; i++) {
          const ids = proj?.frames[i]?.se;
          frameSe.push(ids && ids.length > 0 ? [...ids] : undefined);
        }
        return renderExportMix({
          bgm,
          se,
          frameSe,
          fps,
          // rate = FPS_TABLE[speedIndex]/FPS_TABLE[base]。ライブラリでは速度変更が無いので
          // proj の現在速度（.kwz直は base と同値 → rate=1）
          speedIndex: proj ? proj.speedIndex : bgm?.baseSpeedIndex ?? 6,
          syncMode,
          // M10-11: ライブラリ経路も書き出しダイアログの「範囲」を使えるので
          // （`defaultRange` は初期値の指定にすぎず、範囲UI自体は常に出る）、
          // エディタ側と同じ式で範囲先頭を渡す。全範囲なら lo=0 → 0
          rangeStartSec: lo / (fps > 0 ? fps : 8),
        });
      },
    };
  }

  /** L-1: 選択中のメモ/プロジェクトをライブラリから削除（SD・取り込み元は非接触） */
  async deleteSelected() {
    const it = this.selected;
    if (!it) return;
    const ok = await this.cb.confirm(
      `「${it.name}」を削除しますか？\nライブラリから消えます（元のSDデータには影響しません・再取り込み可能）`
    );
    if (!ok) return;
    try {
      await invoke("delete_note", {
        libRoot: this.libRoot,
        hash: it.kind === "note" ? it.hash : "",
        album: it.album,
        name: it.name,
      });
      this.selected = null;
      // 進行中のサムネ遅延生成キューを破棄（削除済みハッシュの再生成防止。
      // Rust側でも索引に無いハッシュの save_thumb は拒否される）
      this.thumbQueue.length = 0;
      // ステージ表示を停止・クリア
      this.suspend();
      this.previewProject = null;
      $("#stage-title").textContent = "作品を選んでください";
      $("#stage-author").textContent = "";
      $("#stage-meta").innerHTML = "";
      ($("#preview-host") as unknown as HTMLCanvasElement).hidden = true;
      $("#player-host").hidden = true;
      await this.refresh();
      this.cb.toast("削除しました");
    } catch (e) {
      this.cb.toast(`削除に失敗: ${e}`);
    }
  }

  private edit(it: LibraryView) {
    this.suspend();
    if (it.kind === "project") this.cb.openEditorWithProject(it);
    else this.cb.openEditorWithNote(it);
  }

  // 再生コントロール（ビューア）
  bindTransport() {
    $("#tp-restart").onclick = () => {
      if (this.selected?.kind === "project") {
        this.previewFrame = 0;
        this.drawPreview();
      } else {
        try {
          (this.player as any).currentFrame = 0;
        } catch {
          /* noop */
        }
      }
    };
    $("#tp-play").onclick = () => {
      if (this.selected?.kind === "project") {
        if (this.previewPlaying) this.stopPreview();
        else this.startPreview();
      } else if (this.player) {
        this.player.paused ? this.player.play() : this.player.pause();
      }
      this.updatePlayButton();
    };
    $("#tp-loop").onclick = () => {
      const btn = $("#tp-loop");
      if (this.selected?.kind === "project" && this.previewProject) {
        this.previewProject.loop = !this.previewProject.loop;
        btn.classList.toggle("onb", this.previewProject.loop);
      } else if (this.player) {
        try {
          (this.player as any).loop = !(this.player as any).loop;
          btn.classList.toggle("onb", (this.player as any).loop);
        } catch {
          /* noop */
        }
      }
    };
  }

  private updatePlayButton() {
    const playing =
      this.selected?.kind === "project"
        ? this.previewPlaying
        : this.player
          ? !this.player.paused
          : false;
    $("#tp-play").textContent = playing ? "⏸" : "▶";
  }

  private drawPreview() {
    if (!this.previewProject) return;
    const cv = $("#preview-host") as unknown as HTMLCanvasElement;
    // ノート表示（.ppm=256×192等）でバッキングが変わっている可能性があるため 320×240 に戻す
    if (cv.width !== 320 || cv.height !== 240) {
      cv.width = 320;
      cv.height = 240;
    }
    presentToCanvas(compositeFrame(this.previewProject, this.previewFrame), cv);
  }

  /** M5-1: 指定コマの配置SEを発火 */
  private firePreviewSe(i: number) {
    const a = this.previewProject?.audio;
    if (!a || a.se.length === 0) return;
    const ids = this.previewProject!.frames[i]?.se;
    if (!ids) return;
    for (const id of ids) {
      const t = a.se.find((s) => s.id === id);
      if (t) this.audioPreview.fireSe(t);
    }
  }

  private startPreview() {
    if (!this.previewProject || this.previewPlaying) return;
    this.previewPlaying = true;
    const pp = this.previewProject;
    const fps = FPS_TABLE[pp.speedIndex] || 8;
    // M6-2/3: .animemo プレビューの音声同期（アニメのループ毎に頭出しリセット）
    // M5-1: BGM=速度連動rate・SE=コマ発火
    const bgm = pp.audio?.bgm ?? null;
    const rate = bgm ? bgmPlaybackRate(pp.speedIndex, bgm.baseSpeedIndex) : 1;
    void this.audioPreview.start(bgm, this.previewFrame / fps, rate);
    // Codex指摘#3: デコードは「配置済みかつ非ミュート」のSEだけ
    if (pp.audio && pp.audio.se.length > 0) {
      const used = new Set<string>();
      for (const f of pp.frames) for (const id of f.se ?? []) used.add(id);
      void this.audioPreview.prepareSe(pp.audio.se.filter((s) => !s.muted && used.has(s.id)));
    }
    this.firePreviewSe(this.previewFrame);
    this.previewTimer = window.setInterval(() => {
      if (!this.previewProject) return;
      let next = this.previewFrame + 1;
      if (next >= this.previewProject.frames.length) {
        if (this.previewProject.loop) {
          next = 0;
          // A-1: アニメが先頭に戻るたび音も頭出しから鳴り直す（1コマ作品は毎tickラップのため除外）
          if (this.previewProject.frames.length > 1) this.audioPreview.restart();
        } else {
          this.stopPreview();
          return;
        }
      }
      this.previewFrame = next;
      this.firePreviewSe(next);
      this.drawPreview();
    }, 1000 / fps);
    this.updatePlayButton();
  }

  private stopPreview() {
    this.previewPlaying = false;
    this.audioPreview.stop();
    if (this.previewTimer != null) {
      clearInterval(this.previewTimer);
      this.previewTimer = null;
    }
    this.updatePlayButton();
  }
}
