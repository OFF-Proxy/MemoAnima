// V221 (M-2b-2・要件 §5-2 の 1・4・指示書 ■2(6)(7)・■3 の D-10): 描く画面と、作品のセッション・オートセーブの時計・保存の段取りのつなぎ。
//
// ★決まり（行き先・順番・取りやめ・捨てる条件）は saveFlow.ts（画面を持たない・v221 [A][B] が見る）。ここは呼ぶだけ。
// ★時計の口は確かめ画面と同じ順: 保存の前に holdUntil・確定したら settledAt・線を引き終えたら strokeEnded・閉じる前に flushForClose。
// ★オートセーブを消す `discard()` を呼ぶのは 2 か所だけ: ［保存しないで戻る］（先に時計の stop）と、起動したときの提案の［破棄する］（devList.ts）。
// ★ログには作品名・パス・作品の中身を書かない（W-10）。決まった英字と数だけ。
import type { CoreCallbacks } from "../../editor/core/editorCore";
import type { MobilePort } from "../../mobile/port";
import { baseOfName, type MobileWorkSession, type SaveRequest } from "../../mobile/session";
import { foldName } from "../../mobile/names";
import { mergeEditorHiddenConfirms } from "../../galleryEntry";
import { defaultAlbumName } from "../../i18n/defaults";
import { t } from "../../i18n";
import { mt } from "../i18n";
import { AutosaveClock, type ClockWriteResult } from "../autosaveClock";
import type { SessionWire } from "../workOps";
import { MobileEditor } from "./mobileEditor";
import { AutosaveGate, clockBusy, routeSaveOutcome, runSaveWithClock, suspendSequence } from "./saveFlow";
import { askLeave, askSaveTarget } from "../ui/saveDialog";
import { chooseBox, confirmBox, confirmSkippableBox, noticeBox, openDialog, setQuiet, toast } from "../ui/dialogs";
import { listLibrary, type LibraryListing } from "../library/libraryList";
import { readMobileSettings, keyPresetFrom } from "../settings/model";
import { applyAppSetting } from "../settings/apply";
import { openSettings, type SettingsHandle } from "../settings/settingsScreen";

/** モバイルだけの設定のキー（`mobile` で始める＝決-17） */
export const MOBILE_KEYS = { fingerDraw: "mobileFingerDraw", penDevice: "mobilePenDevice" } as const;

export interface WorkScreenDeps {
  port: MobilePort;
  root: HTMLElement;
  /** 読んだ設定（PC と同じキーと値の形・モバイルだけは mobile で始める） */
  settings: Record<string, unknown>;
  /** 新規メモのアルバム（仮の一覧で選んでいたアルバム） */
  albumHint: string;
  /** セッションと描く画面のつなぎ（workOps の SessionWire・セッションを作ったときに渡したもの） */
  wire: SessionWire;
  /** 閉じた（ライブラリへ戻った） */
  closed(): void;
  log(line: string): void;
  /** ★V225 (S-5): アプリの版（設定の画面。描く画面から開いた 4 区分では出さない） */
  version?: string;
}

export class WorkScreen {
  readonly editor = new MobileEditor();
  readonly clock: AutosaveClock;
  readonly gate: AutosaveGate;
  private saving = false;
  private closedOnce = false;

  constructor(private deps: WorkScreenDeps, readonly session: MobileWorkSession) {
    const ed = this.editor;
    this.gate = new AutosaveGate({
      blocked: () => ed.mbAutosaveBlocked(),
      mark: () => ed.mbAutosaveMark(),
      changedSince: (m) => ed.mbChangedSince(m),
      workForBackground: () => ed.workForBackground(),
      project: () => session.project,
      backgroundMark: () => ed.mbBackgroundMark(),
      backgroundChangedSince: (m) => ed.mbBackgroundChangedSince(m),
    });
    this.clock = new AutosaveClock({
      busy: () => clockBusy(ed.mbAutosaveBlocked(), ed.mbDrawingNow()),
      finishStroke: () => ed.mbInterrupt(),
      write: async (reason) => this.writeAutosave(reason),
      onEvent: (ev, reason, result) => deps.log(ev === "begin" ? `[V221] autosave-begin reason=${reason}` : `[V221] autosave-end reason=${reason} result=${result}`),
    });
    deps.wire.prepare = () => ed.mbPrepareSnapshot();
    deps.wire.autosaveStart = () => this.gate.startFor("partial")();
  }

  /** 時計の便（セッションの列へ。取りやめた便は "skipped"＝書いていない結果で解く） */
  private async writeAutosave(reason: string): Promise<ClockWriteResult> {
    const r = await this.session.autosave({ start: this.gate.startFor(reason) });
    return r;
  }

  /** ★開く */
  open(): void {
    const d = this.deps;
    const s = d.settings;
    const ed = this.editor;
    // 設定から（PC と同じ既定・壊れた値は既定へ）
    ed.restoreTextSettings(s.text as never);
    ed.restoreFrameDeleteConfirm(s.frameDeleteConfirm);
    ed.restoreDitherFrameShift(s.ditherFrameShift);
    ed.restoreCustomTones(s.customTones);
    ed.restoreCustomToneColor(s.customToneColor);
    ed.restoreOnion(s.onionLevel, s.onionDir);
    ed.restoreFavoriteColors(s.favoriteColors);
    ed.restoreHiddenConfirms(s.hiddenConfirms);
    const fingerDraw = typeof s[MOBILE_KEYS.fingerDraw] === "boolean" ? (s[MOBILE_KEYS.fingerDraw] as boolean) : null;
    const penDevice = s[MOBILE_KEYS.penDevice] === true;
    // ★V225 (S-1): モバイルの設定（入力・コマを変えるときの動き・利き手）とキーボードの割り当て（PC のキー keys）を読んで渡す
    const ms = readMobileSettings(s);
    ed.mbSetKeyPreset(keyPresetFrom(s));
    setQuiet(() => ed.mbDrawingNow());
    d.log("[V221] open begin");
    ed.mbOpen(d.root, this.session.project, this.callbacks(), {
      edited: () => {
        this.session.noteEdit();
        this.clock.noteEdit();
      },
      drawingChanged: () => undefined,
      strokeEnded: () => this.clock.strokeEnded(),
      save: () => void this.save("overwrite", false),
      saveAs: () => void this.save("saveAs", false),
      back: () => void this.back(),
      penDeviceDetected: () => this.penDeviceDetected(fingerDraw),
      log: (l) => d.log(l),
      saving: () => this.saving,
      settings: () => this.openSettings(),
    }, { fingerDraw, penDevice, fourFingerTap: true, settings: ms });
    ed.mbTitleText = this.title();
    // 復元した作品（保存していない編集が残っている）は、開いたときから戻るときの確認が出る（dirty の setter が編集の印を通す）
    if (this.restored) ed.dirty = true;
    this.clock.start();
    d.log("[V221] open end");
  }

  /** オートセーブから復元した作品か（開く前に入れる） */
  restored = false;

  /** 左上・その他のメニューの名前（ファイルの名前が正・A-106） */
  title(): string {
    // 決め方はセッションの印と同じ（保存先があればファイルの名前・無ければ作品の題名＝session.stamp の title）
    return this.session.stamp().title;
  }

  /** コアへのアプリの知らせ（UI §5-9・§6-12 の形）・設定の口（PC と同じキー） */
  private callbacks(): CoreCallbacks {
    const d = this.deps;
    const merge = (values: Record<string, unknown>) => {
      Object.assign(d.settings, values);
      d.port.settingsMerge(values).catch((e) => d.log(`[V221] settings-merge refused ${e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "error"}`));
    };
    return {
      toast: (m) => toast(m),
      confirm: (m) => confirmBox(m),
      confirmSkippable: (m) => confirmSkippableBox(m),
      choose: (m, o) => chooseBox(m, o),
      notice: (m) => noticeBox(m),
      appendLog: (l) => d.log(l),
      onCustomTonesChange: (list) => merge({ customTones: list }),
      onFavoriteColorsChange: (list) => merge({ favoriteColors: list }),
      onOnionChange: (level, dir) => merge({ onionLevel: level, onionDir: dir }),
      // hiddenConfirms は画面の側で混ぜてから渡す（PC の main.ts と同じ＝エディタの 3 つ以外を落とさない）
      onHiddenConfirmsChange: (ids) => merge({ hiddenConfirms: mergeEditorHiddenConfirms(d.settings.hiddenConfirms, ids) }),
      onTextSettingsChange: (tx) => merge({ text: tx }),
      onSelMaskShowChange: (show) => merge({ selMask: show }),
      onDitherFrameShiftChange: (on) => merge({ ditherFrameShift: on }),
      onCustomToneColorChange: (on) => merge({ customToneColor: on }),
    };
  }

  /** ペンを初めて受けた（利用者が「指で描く」を選んでいなければ 1 回だけ知らせる・選んだあとは勝手に変えない） */
  private penDeviceDetected(fingerDraw: boolean | null): void {
    const d = this.deps;
    if (d.settings[MOBILE_KEYS.penDevice] === true) return;
    d.settings[MOBILE_KEYS.penDevice] = true;
    d.port.settingsMerge({ [MOBILE_KEYS.penDevice]: true }).catch(() => d.log("[V221] settings-merge refused pen"));
    if (fingerDraw === null) toast(mt("mb.pen.fingerOff.toast"));
  }

  // =====================================================================================
  // ★V225 (A-1・指示書 ■3 の S-3): 描く画面から開く設定（4 区分）。作品は開いたまま（閉じない・保存しない）
  // =====================================================================================

  private settingsUi: SettingsHandle | null = null;
  /** 設定の画面が出ているか（その間は、キーボードのコマンドを描く画面に効かせない・Android の戻るは設定を閉じる） */
  settingsShown(): boolean {
    return this.settingsUi !== null;
  }
  closeSettings(): void {
    this.settingsUi?.close();
  }
  /** 確かめ画面の印のビルド: 出ている設定の画面（7 言語の数えが区分を替える） */
  settingsHandle(): SettingsHandle | null {
    return this.settingsUi;
  }

  /** 開く前に、描きかけの線は確定し、変形の途中なら開かない（コアの xformGuard と同じ知らせ）。値を変えたら、すぐ設定に書いて描く画面へ当てる */
  openSettings(): void {
    const d = this.deps;
    const ed = this.editor;
    if (this.saving || this.closedOnce || this.settingsUi) return;
    ed.mbInterrupt();
    if (ed.mbSettingsBlocked()) return;
    ed.mbOtherOperation();
    ed.mbSetModal(true);
    this.settingsUi = openSettings({
      from: "editor",
      raw: d.settings,
      version: d.version ?? "",
      merge: (values) => {
        d.port.settingsMerge(values).catch((e) => d.log(`[V225] settings-merge refused ${e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "error"}`));
      },
      applied: (c, now) => {
        applyAppSetting(c, now);
        ed.mbApplySettings(now);
        if (c.id === "theme") ed.mbThemeChanged();
        if (c.id === "keys") ed.mbSetKeyPreset(keyPresetFrom(d.settings));
        if (c.id === "confirm") ed.restoreHiddenConfirms(d.settings.hiddenConfirms);
        if (c.id === "frameDeleteConfirm") ed.restoreFrameDeleteConfirm(d.settings.frameDeleteConfirm);
      },
      closed: () => {
        this.settingsUi = null;
        ed.mbSetModal(false);
      },
    });
  }

  // =====================================================================================
  // 保存（D-10）
  // =====================================================================================

  /** ★保存（上書き・別名で）。fromLeave＝［保存して戻る］から。ok を返したときだけ true */
  async save(kind: "overwrite" | "saveAs", fromLeave: boolean): Promise<boolean> {
    const ed = this.editor;
    if (this.saving) return false;
    if (ed.mbSaveBlocked()) return false; // PC と同じ関所（重い処理の最中・変形の途中は確定か取り消しが先）
    ed.mbInterrupt();
    ed.mbCloseAll();
    ed.mbOtherOperation();
    let listing: LibraryListing | null = null;
    const list = async () => (listing ??= await listLibrary(this.deps.port).catch(() => ({ albums: [], works: [] })));
    let req: SaveRequest | null = { kind: "overwrite" };
    if (kind === "saveAs") req = await this.askTarget("saveAs", null, null, fromLeave, false, await list());
    let nameTaken = false;
    while (req) {
      this.saving = true;
      ed.mbSyncSaveBtn();
      let out;
      try {
        const r0 = req;
        out = await runSaveWithClock(this.clock, this.gate, () => this.session.save(r0));
      } finally {
        this.saving = false;
        ed.mbSyncSaveBtn();
      }
      this.deps.log(`[V221] save kind=${req.kind} ok=${out.ok}${"refused" in out ? ` refused=${out.refused}` : ""}${"stage" in out ? ` stage=${out.stage}` : ""}${"needs" in out ? ` needs=${out.needs}` : ""}`);
      const route = routeSaveOutcome(out, { fromLeave, sessionDirtyAfter: this.session.dirty });
      switch (route.kind) {
        case "done":
          // 保存が確定して、その間に描き足していなければ、コアの dirty も下ろす（PC の onSettled と同じ）
          if (route.lowerDirty) ed.dirty = false;
          ed.mbTitleText = this.title();
          toast(mt(route.toastKey));
          return true;
        case "ask": {
          listing = null;
          req = await this.askTarget(route.mode, route.suggest, route.msgKey, fromLeave, false, await list());
          continue;
        }
        case "nameTaken": {
          nameTaken = true;
          const last = req.kind === "overwrite" ? null : req;
          listing = null;
          req = await this.askTarget(req.kind === "saveAs" ? "saveAs" : req.kind === "relocate" ? "relocate" : "first", last ? { album: last.album, name: last.name } : null, null, fromLeave, nameTaken, await list());
          continue;
        }
        case "noSpace": {
          const r = await openDialog({
            title: mt("mb.save.noSpace.title"),
            titleIcon: "warn",
            body: [mt("mb.save.noSpace.msg")],
            buttons: [
              { label: t("common.close.btn"), value: false },
              { label: mt("mb.save.retry.btn"), value: true, kind: "go" },
            ],
          });
          if (!r.value) return false;
          continue;
        }
        case "failed": {
          const r = await openDialog({
            title: mt("mb.save.failed.title"),
            titleIcon: "warn",
            body: [mt("mb.save.failed.msg"), mt("mb.save.reason.label", { reason: mt(route.reasonKey) })],
            buttons: [
              { label: t("common.close.btn"), value: false },
              { label: mt("mb.save.retry.btn"), value: true, kind: "go" },
            ],
          });
          if (!r.value) return false;
          continue;
        }
        case "reported":
          return false;
      }
    }
    return false;
  }

  /** 保存先を聞く（初めて・別名で・選び直す）。決めたら保存の頼み・やめたら null */
  private async askTarget(
    mode: "first" | "saveAs" | "relocate",
    suggest: { album: string; name: string } | null,
    msgKey: Parameters<typeof askSaveTarget>[0]["msgKey"],
    fromLeave: boolean,
    nameTaken: boolean,
    listing: LibraryListing
  ): Promise<SaveRequest | null> {
    const port = this.deps.port;
    const albums = listing.albums;
    const hint = suggest?.album ?? this.session.target?.album ?? this.deps.albumHint;
    const album = albums.includes(hint) ? hint : albums[0] ?? defaultAlbumName();
    const name = suggest ? baseOfName(suggest.name) : this.title();
    const works = listing.works;
    const res = await askSaveTarget({
      mode,
      name,
      album,
      albums,
      fromLeave,
      msgKey,
      nameTaken,
      taken: (a, n) => works.some((w) => foldName(w.album) === foldName(a) && foldName(baseOfName(w.name)) === foldName(n)),
      createAlbum: async () => {
        const base = defaultAlbumName();
        for (let i = 1; i < 50; i++) {
          const nm = i === 1 ? base : `${base} (${i})`;
          if (albums.some((a) => foldName(a) === foldName(nm))) continue;
          try {
            const made = await port.createAlbum(nm);
            toast(mt("mb.save.albumMade.toast", { album: made.album }));
            return made.album;
          } catch (e) {
            if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "name-taken") continue;
            this.deps.log("[V221] create-album refused");
            return null;
          }
        }
        return null;
      },
    });
    if (!res) return null;
    if (mode === "first") return { kind: "first", album: res.album, name: res.name };
    if (mode === "saveAs") return { kind: "saveAs", album: res.album, name: res.name };
    return { kind: "relocate", album: res.album, name: res.name };
  }

  // =====================================================================================
  // 戻る（UI §5-17）
  // =====================================================================================

  /** ★戻る（保存している間は何もしない・変形の途中は関所） */
  async back(): Promise<void> {
    const ed = this.editor;
    if (this.saving) return;
    if (ed.mbLeaveBlocked()) return;
    ed.mbInterrupt();
    ed.mbCloseAll();
    ed.mbOtherOperation();
    if (!ed.dirty) {
      await this.close(false);
      return;
    }
    const c = await askLeave();
    if (c === "cancel") return;
    if (c === "save") {
      // ［保存して戻る］は、保存が ok を返したときだけ戻る（そうでなければ描く画面に残る）
      if (await this.save("overwrite", true)) await this.close(false);
      return;
    }
    // ★V221b（独立レビューの指摘・高）: 「保存しないで戻ります」は、閉じられたときだけ（消すのに失敗したら描く画面に残る）
    if (await this.close(true)) toast(mt("mb.leave.discarded.toast"));
  }

  /** ★閉じる。discard＝保存しないで戻る（先に時計を止めてからオートセーブを消す）。そうでなければオートセーブを書き切ってから
   *  （書き切れなかったら閉じずに描く画面に残り、お知らせ） */
  async close(discard: boolean): Promise<boolean> {
    if (this.closedOnce) return true;
    const ed = this.editor;
    ed.mbInterrupt();
    if (discard) {
      this.clock.stop();
      try {
        await this.session.discard();
      } catch {
        // ★V221b（独立レビューの指摘・高）: 消せなかった＝オートセーブは残っている。閉じずに描く画面に残り、時計を戻す
        //  （止めたままだと、このあとの描き足しが一度もオートセーブされず、止められたら失われる）
        this.clock.start();
        this.deps.log("[V221b] discard failed");
        toast(mt("mb.close.discardFailed.toast"));
        return false;
      }
    } else {
      if (!(await this.clock.flushForClose())) {
        toast(mt("mb.close.notFlushed.toast"));
        return false;
      }
      this.clock.stop();
    }
    this.closedOnce = true;
    this.settingsUi?.close();
    ed.mbClose();
    this.deps.wire.prepare = null;
    this.deps.wire.autosaveStart = null;
    this.deps.closed();
    return true;
  }

  // =====================================================================================
  // 裏に回る（D-3）
  // =====================================================================================

  /** ★裏に回った: ① 振り分け層の interrupt → ② コアの otherOperationStarted → ③ 時計の suspend（workForBackground の姿で書く） */
  async suspend(from: string): Promise<ClockWriteResult | "closed"> {
    if (this.closedOnce) return "closed";
    const ed = this.editor;
    const r = await suspendSequence({
      interrupt: () => ed.mbInterrupt(),
      otherOperationStarted: () => ed.mbOtherOperation(),
      suspendClock: () => this.clock.suspend(),
    });
    this.deps.log(`[V221] suspend from=${from} result=${r}`);
    return r;
  }
}
