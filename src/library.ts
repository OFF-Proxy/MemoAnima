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
import { FrameSource, ExportAudioSource, noteSource, projectSource, formatSize } from "./editor/exporter";
import { AudioPreview, pcmS16ToWav, bgmPlaybackRate, renderExportMix } from "./editor/audio";
import type { BgmTrack } from "./editor/model";
import { t, getLang } from "./i18n";
import { errText } from "./ui/errText";
import { collabAlbumName, defaultAlbumName, newAlbumName } from "./i18n/defaults";

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

/** V154 (W-1): 保存の途中で終了した跡（`<作品>.bak` だけが残っている状態）。
 *  Rust の `pclib::RecoverableView` と同じ形（serde 既定＝snake_case のまま） */
export type RecoverableView = {
  album: string;
  name: string;
  rel_path: string;
  bak_size: number;
  bak_at: number;
  tmp_files: [string, number][];
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
  /** V154: ボタンの語を指定できる（`main.ts` の `confirmDialog` は元から対応している）。
   *  復元の提案は「はい/いいえ」だと**押した結果が想像できない**（Codex レビュー指摘・優先度 高） */
  confirm: (msg: string, labels?: { yes: string; no: string }) => Promise<boolean>;
  prompt: (msg: string, def: string) => Promise<string | null>;
  toast: (msg: string) => void;
  /** V154b (W-10): 節目のログ（`memoanima.log`）。**作品名・パスは書かない** */
  appendLog?: (text: string) => void;
  /** M10-20: 並び順の変更を設定へ保存する（文字設定と同じ「変えた瞬間に保存」の流儀） */
  onShelfSortChange?: (v: "manual" | "name" | "date") => void;
  /** M11-3: アルバム選択ダイアログ（「📁 移動」の代替導線）。null=キャンセル */
  pickAlbum?: (albums: string[], current: string, title: string) => Promise<string | null>;
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
        // M11-3: ドラッグ中の Esc はドラッグだけ取り消す（rowDrag と同じ作法）
        if (e.key === "Escape" && this.cardDrag) {
          e.preventDefault();
          this.cancelCardDrag();
          return;
        }
        // M11-10: モーダル（確認・設定・進捗）が開いている間は発火しない
        //（エディタ側は M11-7 で塞いだが、ライブラリ側は素通りしていた）
        if (document.querySelector(".modal-back")) return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if ((e.target as HTMLElement).isContentEditable) return;
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Delete" && this.selected) {
          e.preventDefault();
          void this.deleteSelected();
        }
        // M11-10: Space はホームでも再生／一時停止（作品未選択なら何も起きない）。
        // 長押しの手のひらはエディタだけの作法なので、こちらは単純なトグル。
        // ボタンにフォーカスがあるときはブラウザ既定（Space でそのボタンを押す）を優先する
        if (e.code === "Space" && !(e.target as HTMLElement | null)?.closest?.("button, a")) {
          e.preventDefault();
          if (!e.repeat) this.togglePreviewPlayback();
        }
        // M11-17: ←/→ でコマ送り（押しっぱなしの repeat も通す＝連続送り）。上の門番（画面表示中・
        // モーダル無し・入力欄でない）を通ったあとだけ。修飾キー付き（Alt+← は WebView の「戻る」等）と
        // カードのドラッグ中は触らない。作品未選択なら何も起きない（stepPreviewFrame 側で判定）
        if (
          (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          !this.cardDrag
        ) {
          e.preventDefault();
          this.stepPreviewFrame(e.key === "ArrowRight" ? 1 : -1);
        }
      });
    }
    // M11-4: 外部（エクスプローラー等）での変更に追随する。ウィンドウへ戻ってきたら
    // **軽量な指紋**（library_stamp）だけ取り、変化があったときにフル再スキャンする。
    // ライブラリ画面を見ているときだけ（編集中に一覧が動くのは事故のもと）
    if (!this.focusBound) {
      this.focusBound = true;
      window.addEventListener("focus", () => void this.checkExternalChanges());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void this.checkExternalChanges();
      });
    }
    await this.refresh();
    // V154 (W-1): 一覧を出したあとで「保存の途中で止まった作品」を拾って尋ねる
    //（一覧より先に出すと、何の画面か分からないまま質問される）
    await this.checkRecoverable();
  }

  /** V154 (W-1): 保存の窓（本体→控え→書き込み確定）で終了した跡を拾い、**戻すかどうか尋ねる**。
   *
   *  - 勝手には戻さない・**「あとで」を選んでも控えは消さない**（次に開いたらまた尋ねる＝取り逃がさない）
   *  - 本体が在るものは Rust 側が候補に入れない（上書きの危険がそもそも無い）
   *  - 尋ねるのは**1セッションに1回**（refresh のたびに出すと、断ったのに何度も出て邪魔になる） */
  private recoverAsked = false;
  private async checkRecoverable() {
    if (this.recoverAsked || !this.libRoot) return;
    this.recoverAsked = true;
    let list: RecoverableView[] = [];
    try {
      list = await invoke<RecoverableView[]>("list_recoverable", { libRoot: this.libRoot });
    } catch {
      return; // 拾えなくてもライブラリは普通に使える（提案が出ないだけ）
    }
    if (list.length === 0) return;
    const shown = list.slice(0, 5);
    const lines = shown.map((r) =>
      t("lib.recover.item.msg", {
        name: r.name,
        album: r.album || t("lib.recover.rootAlbum.label"),
        size: formatSize(r.bak_size),
      })
    );
    if (list.length > shown.length)
      lines.push(t("lib.recover.more.msg", { count: list.length - shown.length }));
    // 保存途中の `.tmp` が残っているものがあれば一言添える。**中身が欠けている可能性がある**ので
    // 自動では戻さない（Codex レビュー指摘: 画面に出ないと「新しいほうがあるのに」を見落とす）
    if (list.some((r) => r.tmp_files.length > 0)) lines.push(t("lib.recover.tmp.msg"));
    const ok = await this.cb.confirm(
      t("lib.recover.ask.msg", { count: list.length }) + "\n\n" + lines.join("\n"),
      { yes: t("lib.recover.yes.btn"), no: t("lib.recover.no.btn") }
    );
    if (!ok) return; // 控えはそのまま残す（消さない）
    let done = 0;
    const failed: string[] = [];
    for (const r of list) {
      try {
        await invoke<string>("recover_project", { libRoot: this.libRoot, relPath: r.rel_path });
        done++;
      } catch {
        failed.push(r.name);
      }
    }
    await this.refresh();
    // V154b (W-10): 復元は「何が起きたか」を追うときの節目。**件数だけ**書く（名前は書かない）
    this.cb.appendLog?.(`[V154b] recover done=${done} failed=${failed.length}`);
    this.cb.toast(
      failed.length === 0
        ? t("lib.recover.done.toast", { count: done })
        : t("lib.recover.partial.toast", { count: done, failed: failed.join(" / ") })
    );
  }

  suspend() {
    this.stopPreview();
    try {
      this.player?.pause();
    } catch {
      /* noop */
    }
  }

  /** 一覧を取り直して描き直す。戻り値: 成功したか（失敗時はエラートースト済み） */
  async refresh(): Promise<boolean> {
    try {
      const [items, albums] = await Promise.all([
        invoke<LibraryView[]>("scan_library", { libRoot: this.libRoot }),
        invoke<string[]>("list_albums", { libRoot: this.libRoot }),
      ]);
      this.items = items;
      this.albums = albums;
      const prevAlbum = this.currentAlbum;
      if (!this.currentAlbum || !albums.includes(this.currentAlbum)) {
        this.currentAlbum = albums[0] ?? "";
      }
      // M11-4: renderShelf は棚を作り直す＝スクロール位置が先頭へ飛ぶ（M3.4/L-2 で
      // 避けてきた挙動）。フォーカス復帰で勝手に再スキャンするようになったぶん、
      // 同じアルバムを描き直すときは位置を戻す
      const grid = $("#shelf-grid") as HTMLElement;
      const top = grid.scrollTop;
      this.renderAlbums();
      this.renderShelf();
      if (this.currentAlbum === prevAlbum) grid.scrollTop = top;
      // M11-4: いま見えている状態＝この指紋、として基準を更新する
      this.lastStamp = await invoke<string>("library_stamp", { libRoot: this.libRoot }).catch(
        () => this.lastStamp
      );
      return true;
    } catch (e) {
      this.cb.toast(t("lib.loadError.toast", { err: errText(e) })); // V154b: Error: を出さない
      return false;
    }
  }

  // ---------------- M11-4: 外部変更への追随 ----------------

  /** フォーカス復帰の検知を1回だけ張ったか */
  private focusBound = false;
  /** 直近に見た指紋（library_stamp）。null=未取得 */
  private lastStamp: string | null = null;
  /** 指紋チェックの最終時刻（連続発火の抑制） */
  private stampCheckedAt = 0;
  /** 指紋チェック〜再スキャンが進行中か（多重起動の抑制） */
  private stampBusy = false;
  /** 指紋チェックの最小間隔（ms）。フォーカスと visibilitychange が連続で来るため */
  private static readonly STAMP_MIN_INTERVAL = 400;

  /** M11-4: 外部変更があれば一覧を更新する。`force` で間隔制限を無視。
   *  戻り値: 再スキャンしたか */
  async checkExternalChanges(force = false): Promise<boolean> {
    if (!this.libRoot) return false;
    // エディタを開いている間は走らせない（編集中に一覧が動かない・重い処理も挟まない）
    if ($("#screen-library").hidden) return false;
    // 取り込み中も走らせない。`scan_library` は取り込みと同じロックを取るので、
    // ここで待つと取り込みが終わるまでウィンドウが固まる（中断ボタンも効かなくなる）
    if (!$("#import-footer").hidden) return false;
    // 実行中の再入を止める（フォーカス往復で refresh が積み上がるのを防ぐ）
    if (this.stampBusy) return false;
    const now = performance.now();
    if (!force && now - this.stampCheckedAt < LibraryScreen.STAMP_MIN_INTERVAL) return false;
    this.stampBusy = true;
    try {
      let stamp: string;
      try {
        stamp = await invoke<string>("library_stamp", { libRoot: this.libRoot });
      } catch {
        return false; // 取得できない（フォルダが無い等）ときは何もしない
      }
      if (this.lastStamp === null) {
        this.lastStamp = stamp;
        return false;
      }
      if (stamp === this.lastStamp) return false;
      const okRefresh = await this.refresh(); // 成功時は refresh の中で lastStamp も更新される
      // 読み込みに失敗したときも見た指紋は覚えておく（フォーカスのたびに同じエラーを
      // 出し続けないため。復帰したいときは 🔄 更新ボタンがある）
      if (!okRefresh) this.lastStamp = stamp;
      return okRefresh;
    } finally {
      this.stampBusy = false;
      this.stampCheckedAt = performance.now(); // 完了時刻を基準に間隔を測る
    }
  }

  /** M11-4: 古いパスで操作が失敗したとき用。一覧を更新して同じ作品を探し直す（1回だけ）。
   *  `item` が null なら呼び出し側は利用者向けの案内を出す（内部パスは見せない）。
   *  `refreshed` は実際に一覧を取り直したか（文言を実態に合わせるため） */
  private async ensureFresh(
    it: LibraryView
  ): Promise<{ item: LibraryView | null; refreshed: boolean }> {
    const before = this.items; // 更新前のスナップショット（refresh は配列ごと差し替える）
    const refreshed = await this.checkExternalChanges(true);
    if (it.kind === "note") {
      // .kwz/.ppm は索引が内容ハッシュで持っているので取り違えようがない
      const item = this.items.find((i) => i.kind === "note" && i.hash === it.hash) ?? null;
      return { item, refreshed };
    }
    const same = this.items.find(
      (i) => i.kind === "project" && i.album === it.album && i.name === it.name
    );
    if (same) return { item: same, refreshed };
    // 外部で別アルバムへ移された可能性。ただし **名前だけで拾ってはいけない**
    // （別アルバムに同名の作品があると、そちらを削除/移動してしまう＝作品の喪失）。
    // 「移動された」と言えるのは、更新前には無かった場所に、同名・同サイズの作品が
    // ちょうど1件だけ現れたとき。ひとつでも怪しければ拾わない（案内を出して何もしない）
    const appeared = this.items.filter(
      (i) =>
        i.kind === "project" &&
        i.name === it.name &&
        i.size === it.size &&
        !before.some((b) => b.kind === "project" && b.album === i.album && b.name === i.name)
    );
    return { item: appeared.length === 1 ? appeared[0] : null, refreshed };
  }

  /** M11-4: 「移動または削除された」旨の案内（内部パスは出さない。詳細はログへ） */
  private notifyGone(refreshed: boolean, e?: unknown) {
    if (e !== undefined) console.error("[M11-4] 作品が見つかりません:", e);
    this.cb.toast(refreshed ? t("lib.gone.refreshed.toast") : t("lib.gone.notFound.toast"));
  }

  // ---------------- ヘッダー ----------------

  private bindHeader() {
    $("#lib-import").onclick = () => this.importFolder();
    $("#lib-open-file").onclick = () => this.openSingleFile();
    $("#lib-new-note").onclick = () =>
      this.cb.newNote(this.currentAlbum || defaultAlbumName());
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
    // M11-4: 手動の「🔄 更新」（自動検知が効かない場面の逃げ道）。既存クラス・1個だけ作る
    if (!document.querySelector("#lib-reload")) {
      const btn = document.createElement("button");
      btn.className = "minibtn";
      btn.id = "lib-reload";
      btn.type = "button";
      btn.textContent = "🔄";
      btn.title = t("lib.reload.title");
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          // 失敗時は refresh 自身がエラーを出すので、成功したときだけ知らせる
          if (await this.refresh()) this.cb.toast(t("lib.reload.done.toast"));
        } finally {
          btn.disabled = false;
        }
      };
      sortSel.parentElement?.insertBefore(btn, sortSel);
    }
    // A-14-1: ツールチップは**毎回入れ直す**。上のブロックは「1個だけ作る」ためのもので、
    // 言語を切り替えたときは既にボタンがあるので中へ入らず、**title だけ古い言語のまま残っていた**
    // （L-2 で6言語すべてで再現。ja 起動→zh で日本語のまま／zh 起動→ja で英語のまま）
    const reloadBtn = document.querySelector("#lib-reload") as HTMLElement | null;
    if (reloadBtn) reloadBtn.title = t("lib.reload.title");
  }

  private bindAlbumOps() {
    $("#album-add").onclick = async () => {
      // 第2引数（既定名）は**アルバム名になるユーザーのデータ**なので訳さない（master §5）
      const name = await this.cb.prompt(t("lib.album.add.msg"), newAlbumName());
      if (!name) return;
      try {
        await invoke("create_album", { libRoot: this.libRoot, name });
        await this.refresh();
      } catch (e) {
        this.cb.toast(errText(e)); // V155 (A-33)
      }
    };
    $("#album-rename").onclick = async () => {
      if (!this.currentAlbum) return;
      const name = await this.cb.prompt(t("lib.album.rename.msg"), this.currentAlbum);
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
        this.cb.toast(errText(e)); // V155 (A-33)
      }
    };
    $("#album-delete").onclick = async () => {
      if (!this.currentAlbum) return;
      // M11-1: 削除できる条件が「空のフォルダ」から「作品が入っていない」に変わり、
      // アプリが作ったサムネ（.memoanima.png 等）は一緒に消える。同意を取る文言が
      // 実際の挙動と食い違わないようにする
      const ok = await this.cb.confirm(
        t("lib.album.delete.msg", { album: this.currentAlbum })
      );
      if (!ok) return;
      try {
        await invoke("delete_album", { libRoot: this.libRoot, name: this.currentAlbum });
        this.currentAlbum = "";
        await this.refresh();
      } catch (e) {
        this.cb.toast(errText(e)); // V155 (A-33)
      }
    };
  }

  // ---------------- 取り込み ----------------

  private async importFolder() {
    const src = await open({
      directory: true,
      multiple: false,
      title: t("lib.import.pick.title"),
    });
    if (!src || typeof src !== "string") return;
    const footer = $("#import-footer");
    footer.hidden = false;
    $("#import-label").textContent = t("imp.progress.label");
    try {
      const res = await invoke<any>("import_flipnotes", {
        srcRoot: src,
        libRoot: this.libRoot,
      });
      // M12-1c-1: 「完了: …」＋「/ 失敗 …件」の連結をやめ、状態ごとの完全文にした
      const msg = res.cancelled
        ? t("lib.import.cancelled.toast", { imported: res.imported })
        : res.failed
          ? t("lib.import.doneWithFailed.toast", {
              imported: res.imported,
              skipped: res.skipped,
              failed: res.failed,
            })
          : t("lib.import.done.toast", { imported: res.imported, skipped: res.skipped });
      this.cb.toast(msg);
    } catch (e) {
      this.cb.toast(t("lib.import.error.toast", { err: errText(e) }));
    } finally {
      footer.hidden = true;
      await this.refresh();
    }
  }

  private updateProgress(p: ImportProgress) {
    const footer = $("#import-footer");
    footer.hidden = false;
    $("#import-label").textContent = t("lib.import.progress.label", {
      album: p.album,
      skipped: p.skipped,
    });
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
        title: t("lib.openFile.pick.title"),
        filters: [{ name: t("lib.openFile.filter.label"), extensions: ["kwz", "ppm"] }],
      });
      if (!sel || typeof sel !== "string") return;
      path = sel;
    }
    // 第2引数（既定名）は**アルバム名になるユーザーのデータ**なので訳さない（master §5）
    const album = await this.cb.prompt(t("lib.openFile.album.msg"), collabAlbumName());
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
      else this.cb.toast(t("lib.openFile.imported.toast", { path: destPath }));
    } catch (e) {
      this.cb.toast(t("lib.import.error.toast", { err: errText(e) }));
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
      // M11-3: HTML5 DnD（dragover/drop）は実 exe では動かない（Tauri の dragDropEnabled が
      // OS の drag&drop を握るため）。ドロップ先の判定は pointer ドラッグ側の
      // hitTestCardDrag が dataset.album を見て行う
      row.dataset.album = album;
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
    // M12-3: 照合規則は**いまの表示言語**に合わせる。"ja" 固定だと ñ / ç / ã の入る
    // es / pt-BR で並びが直感と食い違う（ñ が n の後ろに来ない等）。
    // ja のときは getLang() が "ja" を返すので、日本語の並びは1件も変わらない
    const collate = getLang();
    if (this.shelfSort === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, collate));
    } else if (this.shelfSort === "date") {
      list = [...list].sort(
        (a, b) => b.sorted_at - a.sorted_at || a.name.localeCompare(b.name, collate)
      );
    }
    return list;
  }

  private renderShelf() {
    const grid = $("#shelf-grid");
    grid.innerHTML = "";
    const list = this.shelfItems();
    $("#shelf-title").textContent = this.search
      ? t("lib.shelf.searching.label", { query: this.search })
      : this.currentAlbum || t("lib.shelf.noAlbum.label");
    $("#shelf-count").textContent = t("lib.shelf.count.label", { count: list.length });
    for (const it of list) {
      const card = document.createElement("div");
      card.className =
        "thumb" + (this.selected && this.selected.path === it.path ? " active" : "");
      const pic = document.createElement("div");
      pic.className = "pic";
      const img = document.createElement("img");
      img.alt = it.name;
      // M11-3: <img> は既定でネイティブのドラッグ対象。放置すると画像ドラッグが始まって
      // 以降の pointermove を奪い、pointer ドラッグが「掴めているのに動かない」状態になる
      //（実 exe でサムネが表示された作品だけ再現した。dev では気づけない類の不具合）
      img.draggable = false;
      pic.appendChild(img);
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = (it.kind === "project" ? "📝 " : "") + it.name;
      card.dataset.path = it.path; // L-2: 選択ハイライトの差分更新用
      // 並べ替えキー: ノート=h:<hash> / プロジェクト=p:<rel_path>（両方永続化）
      card.dataset.orderkey = this.orderKey(it);
      card.appendChild(pic);
      card.appendChild(cap);
      card.onclick = () => {
        // M11-3: ドラッグ直後の click では選択を変えない（rowDrag の suppressRowClick と同じ）
        if (this.suppressCardClick) {
          this.suppressCardClick = false;
          return;
        }
        void this.select(it);
      };
      card.ondblclick = () => this.edit(it);
      // M11-3: HTML5 DnD は実 exe で動かないため pointer ドラッグへ置換（手本: editor.ts rowDrag）
      card.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        this.startCardDrag(e, it);
      });
      // ネイティブのドラッグ（画像・テキスト選択）が始まると pointermove が止まるので塞ぐ
      card.addEventListener("dragstart", (e) => e.preventDefault());
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
      this.cb.toast(errText(e)); // V155 (A-33)
    }
  }

  // ---------------- M11-3: カードの pointer ドラッグ（実 exe で動く方式） ----------------
  // Tauri の dragDropEnabled=true では WebView 内の HTML5 DnD（dragstart/dragover/drop）が
  // 動かない（OS の drag&drop を Tauri 側が握るため）。dev（素のブラウザ）でだけ動いて
  // 実 exe で 🚫 になっていた原因がこれ。editor.ts の rowDrag と同じ流儀で作り直す
  //（pointerdown → 距離しきい値でドラッグ開始 → pointerup で確定 / Esc・pointercancel で取消）。
  // 副次効果としてペン（液タブ）でも確実に掴める。
  private cardDrag: {
    it: LibraryView;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    ghost: HTMLElement | null;
    target: { kind: "album"; album: string } | { kind: "card"; key: string } | null;
    onMove: (e: PointerEvent) => void;
    onUp: (e: PointerEvent) => void;
    onBlur: () => void;
  } | null = null;
  /** ドラッグ確定後の click で選択を変えないための抑止（rowDrag の suppressRowClick と同じ） */
  private suppressCardClick = false;
  /** 掴んだと判定する移動距離（px）。時間条件は付けない（ペンでもマウスでも素直） */
  private static readonly CARD_DRAG_THRESHOLD = 6;

  private startCardDrag(e: PointerEvent, it: LibraryView) {
    if (this.cardDrag) return;
    this.suppressCardClick = false;
    // 掴んだポインタ以外（別の指・別のペン）のイベントは無視する
    const mine = (ev: PointerEvent) => this.cardDrag?.pointerId === ev.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (mine(ev)) this.updateCardDrag(ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      // pointercancel（タッチのスクロール引き継ぎ等）は「何も起きない」で終わる
      if (ev.type === "pointercancel") this.cancelCardDrag();
      else void this.finishCardDrag();
    };
    const onBlur = () => this.cancelCardDrag(); // ウィンドウ外へ出た場合の保険
    this.cardDrag = {
      it,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      ghost: null,
      target: null,
      onMove,
      onUp,
      onBlur,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onBlur);
  }

  /** パスからカード要素を引く（パスに \ や " が入るので属性セレクタは使わない） */
  private cardEl(path: string): HTMLElement | null {
    return (
      ([...document.querySelectorAll("#shelf-grid .thumb")] as HTMLElement[]).find(
        (el) => el.dataset.path === path
      ) ?? null
    );
  }

  private clearCardDropUi() {
    document
      .querySelectorAll("#albums-list .album.drop")
      .forEach((el) => el.classList.remove("drop"));
    document
      .querySelectorAll("#shelf-grid .thumb")
      .forEach((el) => ((el as HTMLElement).style.outline = ""));
  }

  private hitTestCardDrag(x: number, y: number) {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    const album = el.closest("#albums-list .album") as HTMLElement | null;
    if (album?.dataset.album) return { kind: "album" as const, album: album.dataset.album };
    const card = el.closest("#shelf-grid .thumb") as HTMLElement | null;
    if (card?.dataset.orderkey) return { kind: "card" as const, key: card.dataset.orderkey };
    return null;
  }

  private updateCardDrag(ev: PointerEvent) {
    const d = this.cardDrag;
    if (!d) return;
    if (!d.active) {
      if (
        Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) <
        LibraryScreen.CARD_DRAG_THRESHOLD
      )
        return; // しきい値未満はクリック/ダブルクリックのまま（従来の操作を壊さない）
      d.active = true;
      this.suppressCardClick = true;
      const g = document.createElement("div");
      g.className = "drag-ghost"; // 既存クラス（エディタのレイヤードラッグと共用）
      g.textContent = (d.it.kind === "project" ? "📝 " : "") + d.it.name;
      document.body.appendChild(g);
      d.ghost = g;
      const src = this.cardEl(d.it.path);
      if (src) src.style.opacity = "0.4"; // 掴んでいる元カードを薄く（styles.css は触らない）
    }
    if (d.ghost) {
      d.ghost.style.left = `${ev.clientX + 14}px`;
      d.ghost.style.top = `${ev.clientY + 16}px`;
    }
    const hit = this.hitTestCardDrag(ev.clientX, ev.clientY);
    this.clearCardDropUi();
    let valid = false;
    if (hit?.kind === "album") {
      valid = hit.album !== d.it.album;
      if (valid) {
        const row = ([...document.querySelectorAll("#albums-list .album")] as HTMLElement[]).find(
          (el) => el.dataset.album === hit.album
        );
        row?.classList.add("drop"); // 既存の .album.drop（緑）をそのまま流用
      }
    } else if (hit?.kind === "card") {
      // M10-20: 並び替えは「手動」モードのときだけ（名前順/日付順では order を壊さない）。
      // 検索中は棚がアルバム横断リストになり、そのまま順序を書くと**他アルバムの並び**まで
      // 書き換わるため受け付けない（M11-3 レビュー検出・従来からの穴）
      valid = this.shelfSort === "manual" && !this.search && hit.key !== this.orderKey(d.it);
      if (valid) {
        const card = ([...document.querySelectorAll("#shelf-grid .thumb")] as HTMLElement[]).find(
          (el) => el.dataset.orderkey === hit.key
        );
        // .thumb 用のドロップ先クラスは既存に無いため、レイヤーの .lay.droptarget と
        // 同じ見た目をインラインで当てる（styles.css は不変）
        if (card) card.style.outline = "3px dashed var(--green)";
      }
    }
    d.target = valid ? hit : null;
    d.ghost?.classList.toggle("invalid", !valid);
  }

  private async finishCardDrag() {
    const d = this.cardDrag;
    if (!d) return;
    const { it, active, target } = d;
    this.endCardDrag();
    if (!active) return;
    if (!target) {
      // 掴んだが有効なドロップ先が無かった＝ただのクリックとして扱う（掴んだ作品を選ぶ）。
      // これが無いと「6px 以上動かして同じ場所で離す」と選択が変わらない
      //（rowDrag はドラッグ確定時にその場で選択を切り替えて同じ効果を出している）
      void this.select(it);
      return;
    }
    if (target.kind === "album") await this.moveItemTo(it, target.album);
    else await this.reorder(this.orderKey(it), target.key);
  }

  /** Esc / pointercancel / ウィンドウ外 → 何も起きない状態へ戻す */
  cancelCardDrag() {
    this.endCardDrag();
  }

  private endCardDrag() {
    const d = this.cardDrag;
    if (!d) return;
    window.removeEventListener("pointermove", d.onMove);
    window.removeEventListener("pointerup", d.onUp);
    window.removeEventListener("pointercancel", d.onUp);
    window.removeEventListener("blur", d.onBlur);
    d.ghost?.remove();
    const src = this.cardEl(d.it.path);
    if (src) src.style.opacity = "";
    this.clearCardDropUi();
    this.cardDrag = null;
  }

  /** M11-3: 作品を別アルバムへ移動（note=move_note / project=move_project）。
   *  移動後は移動先アルバムを開いて対象を選択する（見失わせない） */
  async moveItemTo(it: LibraryView, album: string, retried = false): Promise<void> {
    if (!album || it.album === album) return;
    try {
      let newPath: string | null = null;
      if (it.kind === "note") {
        await invoke("move_note", { libRoot: this.libRoot, hash: it.hash, destAlbum: album });
      } else {
        newPath = await invoke<string>("move_project", {
          libRoot: this.libRoot,
          album: it.album,
          name: it.name,
          destAlbum: album,
        });
      }
      this.currentAlbum = album; // refresh 内の再描画で移動先が開く（二度描きしない）
      await this.refresh();
      const moved =
        it.kind === "note"
          ? this.items.find((i) => i.hash === it.hash && i.album === album)
          : this.items.find((i) => i.path === newPath);
      if (moved) await this.select(moved);
      this.cb.toast(t("lib.move.done.toast", { album }));
    } catch (e) {
      // M11-4: 外部で移動された等でパスが古いときは、一覧を更新して1回だけやり直す
      if (retried) {
        console.error("[M11-4] 移動に失敗:", e);
        this.cb.toast(t("lib.move.failed.toast"));
        return;
      }
      const { item: fresh, refreshed } = await this.ensureFresh(it);
      if (!fresh) {
        this.notifyGone(refreshed, e);
        return;
      }
      if (fresh.album === album) {
        // 外部で既に移動先へ動いていた＝もう目的は達成されている
        this.currentAlbum = album;
        this.renderAlbums();
        this.renderShelf();
        await this.select(fresh);
        this.cb.toast(t("lib.move.already.toast", { album }));
        return;
      }
      await this.moveItemTo(fresh, album, true);
    }
  }

  /** M11-3: 「📁 移動」ボタン（ドラッグ以外の導線。アルバムが多いときはこちらが確実） */
  private async moveSelectedWithPicker() {
    const it = this.selected;
    if (!it) return;
    if (!this.cb.pickAlbum) {
      this.cb.toast(t("lib.move.noPicker.toast"));
      return;
    }
    const album = await this.cb.pickAlbum(this.albums, it.album, t("lib.move.pick.title", { name: it.name }));
    if (!album) return;
    await this.moveItemTo(it, album);
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
          t("lib.meta.frames.label", { count: note?.frameCount ?? "?" }),
          `${note?.framerate ?? "?"} fps`,
        ]);
        this.drawNoteFrame();
        p.play();
        this.updatePlayButton(); // M11-18: 再生中なのに ▶ のままだった（M11-17 取りこぼし#1）
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
          t("app.name.label"),
          "320 × 240",
          t("lib.meta.frames.label", { count: this.previewProject.frames.length }),
          `${FPS_TABLE[this.previewProject.speedIndex]} fps`,
        ]);
        this.drawPreview();
        this.startPreview();
      }
    } catch (e) {
      // V154b: `Error: ` を出さない（中身だけ）。文言は serialize が決めている
      this.showLoadError(errText(e));
    }
  }

  /** V154b: 開けなかった理由を**プレビューの帯に出す**（消えないので読み返せる）。
   *
   *  以前は同じ文言が「帯」と「トースト」の2か所に出ていた。トーストは 3.2 秒で消えるうえ、
   *  長い文だと省略記号で切られるので、**残るほうの帯に一本化**する。
   *  ここは選択したときのプレビュー失敗と、開こうとして失敗したとき（`main.ts`）の共通の出口。 */
  showLoadError(msg: string) {
    this.renderMeta([t("lib.meta.loadError.label", { err: msg })]);
    // 失敗の文は長い（「…ファイルは壊れていません（中身: 約2.1GB／…）」）。
    // チップは既定で縮まない（flex の min-width:auto）ので、**この1つだけ折り返せる**ようにする
    ($("#stage-meta").firstElementChild as HTMLElement | null)?.classList.add("wrap");
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
    edit.textContent = t("lib.chip.edit.btn");
    edit.onclick = () => this.selected && this.edit(this.selected);
    host.appendChild(edit);
    const exp = document.createElement("button");
    exp.className = "chip export";
    exp.textContent = t("lib.chip.export.btn");
    exp.onclick = () => this.exportSelected();
    host.appendChild(exp);
    // M11-3: ドラッグ以外の移動導線（アルバムが多いとスクロールしながらのドラッグは厳しい）
    const mv = document.createElement("button");
    mv.className = "chip";
    mv.textContent = t("lib.chip.move.btn");
    mv.title = t("lib.chip.move.title");
    mv.onclick = () => void this.moveSelectedWithPicker();
    host.appendChild(mv);
    const del = document.createElement("button");
    del.className = "chip danger";
    del.textContent = t("lib.chip.delete.btn");
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
        this.cb.toast(t("lib.export.notReady.toast"));
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
        this.cb.toast(t("lib.export.notReady.toast"));
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
    const ok = await this.cb.confirm(t("lib.delete.confirm.msg", { name: it.name }));
    if (!ok) return;
    try {
      await invoke("delete_note", {
        libRoot: this.libRoot,
        hash: it.kind === "note" ? it.hash : "",
        album: it.album,
        name: it.name,
      });
      await this.afterDelete();
    } catch (e) {
      // M11-4: 外部で移動された等でパスが古いときは、一覧を更新して1回だけやり直す
      const { item: fresh, refreshed } = await this.ensureFresh(it);
      if (!fresh) {
        this.notifyGone(refreshed, e);
        return;
      }
      try {
        await invoke("delete_note", {
          libRoot: this.libRoot,
          hash: fresh.kind === "note" ? fresh.hash : "",
          album: fresh.album,
          name: fresh.name,
        });
        await this.afterDelete();
      } catch (e2) {
        console.error("[M11-4] 削除に失敗（1回目）:", e, "（再試行）:", e2);
        this.cb.toast(
          refreshed ? t("lib.delete.failedRefreshed.toast") : t("lib.delete.failed.toast")
        );
      }
    }
  }

  /** 削除に成功したあとの後始末（選択解除・ステージ停止・一覧更新）。
   *  M11-4: 再試行で成功した場合もここを通す（消えた作品が鳴り続けないように） */
  private async afterDelete() {
    this.selected = null;
    // 進行中のサムネ遅延生成キューを破棄（削除済みハッシュの再生成防止。
    // Rust側でも索引に無いハッシュの save_thumb は拒否される）
    this.thumbQueue.length = 0;
    // ステージ表示を停止・クリア
    this.suspend();
    this.previewProject = null;
    $("#stage-title").textContent = t("lib.stage.empty.label");
    $("#stage-author").textContent = "";
    $("#stage-meta").innerHTML = "";
    ($("#preview-host") as unknown as HTMLCanvasElement).hidden = true;
    $("#player-host").hidden = true;
    await this.refresh();
    this.cb.toast(t("lib.delete.done.toast"));
  }

  private edit(it: LibraryView) {
    void this.editChecked(it);
  }

  /** M11-4: 開く前に外部変更を拾い直す（古いパスのまま開いて内部エラーを見せない） */
  private async editChecked(it: LibraryView) {
    const { item: fresh, refreshed } = await this.ensureFresh(it);
    if (!fresh) {
      this.notifyGone(refreshed);
      return;
    }
    this.suspend();
    if (fresh.kind === "project") this.cb.openEditorWithProject(fresh);
    else this.cb.openEditorWithNote(fresh);
  }

  // 再生コントロール（ビューア）
  bindTransport() {
    $("#tp-restart").onclick = () => this.restartPreview();
    $("#tp-play").onclick = () => this.togglePreviewPlayback();
    // M11-17: ◀▶ コマ送り（←/→ キーと同じ入口）
    $("#tp-prev").onclick = () => this.stepPreviewFrame(-1);
    $("#tp-next").onclick = () => this.stepPreviewFrame(1);
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

  /** M11-10: プレビューの再生／一時停止（▶ ボタンと Space の共通の入口）。
   *  作品を選んでいないときは何も起きない */
  togglePreviewPlayback() {
    if (this.selected?.kind === "project") {
      if (this.previewPlaying) this.stopPreview();
      else this.startPreview();
    } else if (this.player) {
      this.player.paused ? this.player.play() : this.player.pause();
    }
    this.updatePlayButton();
  }

  /** M11-19: ⏮ 先頭へ。**再生中なら先に一時停止**してから先頭へ（◀▶ のコマ送りと同じ規則・M11-17 取りこぼし#4）。
   *  停止中は従来どおり先頭へ移動するだけ。.memoanima / .kwz の両方 */
  restartPreview() {
    if (!this.selected) return;
    if (this.selected.kind === "project") {
      if (!this.previewProject) return;
      if (this.previewPlaying) this.stopPreview();
      this.previewFrame = 0;
      this.drawPreview();
    } else if (this.player) {
      const p = this.player as any;
      try {
        if (!p.note) return;
        if (!p.paused) p.pause();
        p.setCurrentFrame(0);
        if (p._hasEnded) p._hasEnded = false; // stepPreviewFrame と同じ（先頭から再生を再開できるように）
      } catch {
        /* ノート未ロード等 */
      }
    }
    this.updatePlayButton();
  }

  /** M11-17: コマ送り（←/→ キーと ◀▶ ボタンの共通の入口）。
   *  - 再生中なら**先に一時停止**してから 1コマ動く（停止中はそのまま動く）
   *  - 端はループ（最後→先頭・先頭→最後）
   *  - .memoanima: previewFrame＋drawPreview だけ（firePreviewSe は呼ばない＝SE 無音。BGM は stopPreview で止まる）
   *  - .kwz/.ppm: flipnote.js Player の pause()＋setCurrentFrame()（clamp 式なので巻き戻しは自前で計算。
   *    描画は既存の "frameupdate" 購読 → drawNoteFrame。setCurrentFrame は音に触れない）
   *  作品を選んでいないときは何も起きない */
  stepPreviewFrame(dir: 1 | -1) {
    if (!this.selected) return;
    if (this.selected.kind === "project") {
      const pp = this.previewProject;
      if (!pp || pp.frames.length === 0) return;
      if (this.previewPlaying) this.stopPreview();
      const n = pp.frames.length;
      this.previewFrame = (((this.previewFrame + dir) % n) + n) % n;
      this.drawPreview();
    } else if (this.player) {
      const p = this.player as any;
      try {
        if (!p.note) return;
        if (!p.paused) p.pause();
        const n: number = p.frameCount ?? 0;
        if (!(n > 0)) return;
        const cur = Math.max(0, Math.min(n - 1, Number(p.currentFrame ?? 0) || 0));
        p.setCurrentFrame((((cur + dir) % n) + n) % n);
        // ループ無しの作品が最後まで再生されて止まっていると Player は _hasEnded=true を持ち、
        // 次の play() で先頭（0秒）へ巻き戻す（Player.mjs play()）。送った位置から再生を再開できるよう
        // に、シークが通ったらこのフラグを下ろす（.memoanima 側の startPreview と同じ挙動に揃える）
        if (p._hasEnded) p._hasEnded = false;
      } catch {
        /* ノート未ロード等。何も起きないだけでよい */
      }
    }
    this.updatePlayButton();
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
    // M11-16: 透明の紙は canvas の背景で薄い市松にする（データには触れない・実色の紙と見分けるため）
    cv.classList.toggle("paper-clear", this.previewProject.frames[this.previewFrame]?.paper === 0);
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
