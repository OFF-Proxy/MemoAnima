// V202 (M-1a・要件 docs/REQ_mobile_m1_base.md §4-4・A4・A5): モバイルの**開いた作品ごとのセッション**の部品
// （画面と Tauri に触らない・DOM を読まない・`@tauri-apps` を import しない＝Rust の命令は `MobilePort` の口で受ける）。
//
// ★持つもの: セッションの番号（作品の ID とは別の乱数。復元したら同じ番号を使い続ける）・保存先（アルバムと名前）・保存元の指紋・
//  もとの版・列（保存・オートセーブ・破棄を 1 つずつ順に）。作品の ID と版は作品の中（`meta.workId`・`meta.rev`）が正で、ここは
//  saveCore.ts の `stampForSave`（`saveWork` の中）・`bindNewWorkId`・`readWorkId`・`readRev` を通してだけ触る
//  （欄の名前は baseRev・sourceFingerprint＝v201 [F-1] の数える `.rev`・`.workId`・`.thumbFrame` への書き込みに当たらない）
// ★保存の流れ（指示 §3）:
//   - まだ保存していない → 初めての保存（名前とアルバムを聞く＝needs: "first"）
//   - 上書き: 保存の前に再開（退避の記録）→ 指紋で確かめる上書き。指紋が違う → 別の名前で保存してもらう（明示の別名で保存と同じ扱い＝
//     保存先が決まった時点で bindNewWorkId・版 1）。保存先に作品が無い → 同じ ID か同じ指紋の作品を探し、1 つで指紋も同じならそこへ書いて
//     保存先を直す。1 つでも指紋が違えば、指紋が違うときと同じ。0 か 2 つ以上・アルバムが無い → 保存先を聞く（元のアルバムと名前を入れて
//     おく）。元の場所に黙って作り直さない。聞いて書くときは新しく保存（置き換えない）で、ID はそのまま（同じ作品の続き）
//   - 旧拡張子の作品（X.animemo）: 隣の X.memoanima を新しく保存で作る（X.animemo は自分なので数えない）。ID はそのまま
//   - 作品の ID を替えるのは、明示の別名で保存と、指紋が違って別の名前で保存するときの 2 つだけ
//   - ★保存が成功したら、手元の版・もとの版・保存元の指紋を、書いた版と書いた中身の指紋の組に**1 度に**揃える（saveWork の onCommitted）。
//     揃える前の組でオートセーブを書かない（列の中で揃えてから次の便）。保存の途中で描き足していたら（settled: false）、すぐオートセーブを
//     書き直す（同じ便の中で＝揃えた組で）。書く版は手元の版＋1（stampForSave のまま）
//   - ★readBack の口を必ず渡す（モバイルの読む命令で）。無いと saveWork は開けるかの確かめを黙って省き、確定でオートセーブを消す
// ★世代: 便を始めるとき（写す前）に Rust から世代を受け取り、書き込みと消すことの両方に付ける（Rust は古い世代を断る）
// ★消すのは、このセッション自身のオートセーブだけで、要件 §4-4 の 6 の 3 つのときだけ（保存が確定したとき・保存しないで戻る・提案で破棄）
import { autosaveWork, bindNewWorkId, encodeOnThisThread, readRev, readWorkId, saveWork, type AutosaveOutcome, type SaveKind, type SaveWriteResult } from "../editor/saveCore";
import type { Project } from "../editor/model";
import { isRefusal, MobileRefusal, type Fingerprint, type MobilePort, type ResumeItem, type SaveResult, type SessionEntry } from "./port";
import { foldName, isFingerprint, isSessionId, newSessionId, sameFingerprint } from "./names";

/** 保存先（アルバムと実のファイル名） */
export interface WorkTarget {
  album: string;
  name: string;
}

/** オートセーブの中の印（contract.json の types.AutosaveMeta。絶対パスは入れない＝決-4） */
export interface AutosaveStamp {
  title: string;
  album: string | null;
  name: string | null;
  workId: string | null;
  baseRev: number;
  sourceFingerprint: Fingerprint | null;
  unsaved: boolean;
  savedAt: string;
}

export interface SessionOptions {
  /** 保存の写し（既定は encodeOnThisThread＝その場で structuredClone）。保存の Worker が使える入口は encodeViaWorker を渡す */
  encode?: (p: Project) => Promise<Uint8Array | null>;
  /** サムネ（PNG）。既定は空（Rust はサムネを書かない） */
  thumb?: (p: Project) => Promise<Uint8Array>;
  /** いま開いているコマ（見積りを待ったあとに呼ばれる＝V201 §11 の 7） */
  currentFrame?: () => number;
  /** 写す前の見積り（V168。false＝断った） */
  prepare?: () => Promise<boolean>;
  /** オートセーブの PV6 の間に入力へ譲る口 */
  yieldNow?: () => Promise<void>;
  /** オートセーブを途中で捨てるか（呼び出し側の基準） */
  autosaveAborted?: () => boolean;
  /** 書いた時刻（ISO 8601） */
  now?: () => string;
  log?: (line: string) => void;
}

export type SaveRequest =
  /** 上書き保存（まだ保存していなければ needs: "first"） */
  | { kind: "overwrite" }
  /** 初めての保存（名前とアルバムを聞いた） */
  | { kind: "first"; album: string; name: string }
  /** 明示の別名で保存・指紋が違って別の名前で保存（新しい ID・版 1） */
  | { kind: "saveAs"; album: string; name: string }
  /** 保存先が無くて聞いた先へ（新しく保存・ID はそのまま） */
  | { kind: "relocate"; album: string; name: string };

export type SaveOutcome =
  | {
      ok: true;
      target: WorkTarget;
      rev: number;
      fingerprint: Fingerprint;
      notice: "saved" | "savedPartial";
      oursMoved: boolean;
      keptCopies: string[];
      recordLeft: boolean;
      resumed: ResumeItem[];
    }
  /** まだ保存していない → 名前とアルバムを聞いて `first` */
  | { ok: false; needs: "first" }
  /** 指紋が違う（外で中身が変わった）→ 別の名前を聞いて `saveAs` */
  | { ok: false; needs: "saveAs"; reason: "fingerprint-mismatch"; suggest: WorkTarget }
  /** 保存先が無い・見つけた先が決まらない・旧拡張子の隣の名前が使われている → 保存先を聞いて `relocate` */
  | { ok: false; needs: "target"; reason: "target-missing" | "album-missing" | "ambiguous" | "name-taken"; suggest: WorkTarget | null }
  /** そのほかの決まった断り（名前が使われている・長すぎる・空きが無い・片付かない記録 等） */
  | { ok: false; refused: string }
  /** 写す前の見積りで断った・写しが返らない・読み戻したものが開けない（saveWork の断り） */
  | { ok: false; stage: "refused" | "encode" | "read-back"; reason: string };

/** 書く口の戻り（saveWork の SaveWriteResult を広げた形・型だけ） */
interface MobileWritten extends SaveWriteResult {
  result: SaveResult;
}

const LEGACY_RE = /\.animemo$/i;
const EXT_RE = /\.(memoanima|animemo)$/i;

/** 作品のファイル名から拡張子を外した名前 */
export function baseOfName(name: string): string {
  return name.replace(EXT_RE, "");
}

/** ★開いた作品ごとのセッション */
export class MobileWorkSession {
  /** セッションの番号（オートセーブのファイル 1 つ） */
  readonly session: string;
  readonly project: Project;
  /** 保存先（null＝まだ保存していない） */
  target: WorkTarget | null;
  /** 保存元の指紋（null＝まだ保存していない） */
  sourceFingerprint: Fingerprint | null;
  /** もとの版（開いた・最後に保存した版） */
  baseRev: number;
  /** 保存していない編集があるか（保存が確定したら下ろす） */
  dirty: boolean;
  private readonly port: MobilePort;
  private readonly opts: SessionOptions;
  private editEpoch = 0;
  /** 保存が確定した回数（onCommitted で増える。別名で保存が確定しなかったかを見る） */
  private commits = 0;
  /** ★列（保存・オートセーブ・破棄を 1 つずつ順に） */
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    port: MobilePort,
    project: Project,
    session: string,
    target: WorkTarget | null,
    fp: Fingerprint | null,
    baseRev: number,
    dirty: boolean,
    opts: SessionOptions
  ) {
    this.port = port;
    this.project = project;
    this.session = session;
    this.target = target;
    this.sourceFingerprint = fp;
    this.baseRev = baseRev;
    this.dirty = dirty;
    this.opts = opts;
  }

  /** ライブラリから作品を開いた（読む命令が返した指紋＝保存元の指紋）。新しい番号 */
  static openWork(port: MobilePort, project: Project, src: { album: string; name: string; fingerprint: Fingerprint }, opts: SessionOptions = {}): MobileWorkSession {
    return new MobileWorkSession(port, project, newSessionId(), { album: src.album, name: src.name }, src.fingerprint, readRev(project), false, opts);
  }

  /** 新規メモ（まだ保存していない）。新しい番号 */
  static newWork(port: MobilePort, project: Project, opts: SessionOptions = {}): MobileWorkSession {
    return new MobileWorkSession(port, project, newSessionId(), null, null, 0, true, opts);
  }

  /** ★オートセーブから復元した（**同じ番号を使い続ける**）。印の保存先・指紋・もとの版を受け継ぐ（崩れた値は無いものとして）。
   *  列の最初に世代の床を取る（読み込み直しの前の部品の遅れた書き込み・消すことを、まだ書いていなくても Rust が断れるように。
   *  第三者レビュー D-L1）。取れなくても復元はそのまま（次の書き込みが床を上げる） */
  static restore(port: MobilePort, project: Project, entry: { session: string; meta: Record<string, unknown> }, opts: SessionOptions = {}): MobileWorkSession {
    if (!isSessionId(entry.session)) throw new MobileRefusal("bad-session");
    const st = readStamp(entry.meta);
    const rev = Number.isSafeInteger(st.baseRev) && st.baseRev >= 0 ? st.baseRev : readRev(project);
    const s = new MobileWorkSession(port, project, entry.session, st.target, st.target ? st.sourceFingerprint : null, rev, true, opts);
    void s.enqueue(() => s.claimFloor());
    return s;
  }

  /** 世代を受け取って床を上げる（ファイルには触らない） */
  private async claimFloor(): Promise<void> {
    try {
      await this.port.autosaveClaim(this.session, await this.port.autosaveNextGen());
    } catch (e) {
      this.opts.log?.(`[V202] autosave claim failed: ${e instanceof MobileRefusal ? e.code : "error"}`);
    }
  }

  /** 編集があった（保存の途中で描き足されたかの判断にも使う） */
  noteEdit(): void {
    this.editEpoch++;
    this.dirty = true;
  }

  /** 印（書く直前に作る） */
  stamp(): AutosaveStamp {
    return {
      // 題名の正はファイルの名前（A-106）。保存先が無いときだけ作品の中の題名（PC の editor の titleNow と同じ扱い）
      title: this.target ? baseOfName(this.target.name) : String(this.project.meta.title ?? ""),
      album: this.target?.album ?? null,
      name: this.target?.name ?? null,
      workId: readWorkId(this.project),
      baseRev: this.baseRev,
      sourceFingerprint: this.sourceFingerprint,
      unsaved: this.sourceFingerprint === null,
      savedAt: this.opts.now?.() ?? new Date().toISOString(),
    };
  }

  /** ★列に並べる（前の便が終わってから。失敗しても列は止めない） */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => {});
    return run;
  }

  /** ★オートセーブ（列に並べる） */
  autosave(): Promise<AutosaveOutcome> {
    return this.enqueue(() => this.autosaveNow());
  }

  /** 列の中で書く（便を始めるとき＝写す前に世代を受け取る） */
  private async autosaveNow(): Promise<AutosaveOutcome> {
    const gen = await this.port.autosaveNextGen();
    try {
      return await autosaveWork({
        project: this.project,
        yieldNow: this.opts.yieldNow,
        aborted: () => this.opts.autosaveAborted?.() ?? false,
        // 列の中なので、保存・破棄と重ならない（遅れて届いた古い便は Rust が世代で断る）
        stillCurrent: () => true,
        meta: () => this.stamp() as unknown as Record<string, unknown>,
        write: (w) => this.port.autosaveWrite(this.session, gen, w.meta, w.data),
        log: this.opts.log,
      });
    } catch (e) {
      if (isRefusal(e, "stale-generation")) return "stale";
      throw e;
    }
  }

  /** このセッション自身のオートセーブを消す（世代を受け取ってから） */
  private async deleteOwnAutosave(): Promise<void> {
    const gen = await this.port.autosaveNextGen();
    try {
      await this.port.autosaveDelete(this.session, gen);
    } catch (e) {
      if (!isRefusal(e, "stale-generation")) throw e;
    }
  }

  /** ★「保存しないで戻る」・提案で「破棄する」を選んで確かめた（このセッションの分だけ消す） */
  discard(): Promise<void> {
    return this.enqueue(() => this.deleteOwnAutosave());
  }

  /** ★保存（列に並べる） */
  save(req: SaveRequest): Promise<SaveOutcome> {
    return this.enqueue(() => this.saveNow(req));
  }

  private async saveNow(req: SaveRequest): Promise<SaveOutcome> {
    if (req.kind === "first" || req.kind === "relocate") {
      return this.writeNew(req.album, req.name, null, "first", []);
    }
    if (req.kind === "saveAs") {
      // ★別名で保存: 保存先が決まった時点で新しい ID（版は 0 から＝書くと 1）
      bindNewWorkId(this.project);
      const seq = this.commits;
      try {
        return await this.writeNew(req.album, req.name, null, "saveAs", []);
      } finally {
        // ★確定しなかった（断られた・書けなかった・確かめで落ちた・書く口の応答が失われた）: 作品はもう新しい ID なので、
        //  前の保存先へは書かない。まだ保存していない作品に戻す（次の保存は初めての保存＝名前とアルバムを聞く。第三者レビュー D-M1）
        if (this.commits === seq) {
          // その ID のファイルを置いたかどうかは分からない（読み戻しで落ちた・応答だけが失われた）ので、同じ ID を 2 つのファイルに
          //  書かないよう、ID をもう一度替える（明示の別名で保存の続き。独立レビューの指摘の境界）
          bindNewWorkId(this.project);
          this.target = null;
          this.sourceFingerprint = null;
          this.baseRev = readRev(this.project);
        }
      }
    }
    const target = this.target;
    const src = this.sourceFingerprint;
    if (!target || !src) return { ok: false, needs: "first" };
    // 保存の前に、止まっていた保全を続ける（同じ保存先に片付かない記録があれば、上書きの命令が中で再開してから断る）。
    // 再開そのものが失敗しても保存は試す（上書きの命令が同じ保存先の記録を鍵の中で確かめ直す）
    let resumed: ResumeItem[] = [];
    try {
      resumed = await this.port.resume();
    } catch (e) {
      this.opts.log?.(`[V202] resume before save failed: ${e instanceof MobileRefusal ? e.code : "error"}`);
    }
    if (LEGACY_RE.test(target.name)) {
      // 旧拡張子の作品: 隣の X.memoanima を新しく保存で作る（X.animemo は自分なので数えない）。ID はそのまま
      const r = await this.writeNew(target.album, baseOfName(target.name), target.name, "first", resumed);
      if (!r.ok && "refused" in r && r.refused === "name-taken") return { ok: false, needs: "target", reason: "name-taken", suggest: target };
      return r;
    }
    return this.overwriteAt(target, src, resumed, true);
  }

  /** 上書き（指紋で確かめる）。保存先が無ければ探して、1 つで指紋も同じならそこへ（1 回だけ） */
  private async overwriteAt(at: WorkTarget, src: Fingerprint, resumed: ResumeItem[], mayFind: boolean): Promise<SaveOutcome> {
    try {
      return await this.run("overwrite", baseOfName(at.name), resumed, (w) =>
        this.port.saveOverwrite({ album: at.album, name: at.name, sourceFingerprint: src, data: w.data, thumb: w.thumb })
      );
    } catch (e) {
      if (!(e instanceof MobileRefusal)) throw e;
      if (e.code === "fingerprint-mismatch") return { ok: false, needs: "saveAs", reason: "fingerprint-mismatch", suggest: at };
      if (e.code === "album-missing") return { ok: false, needs: "target", reason: "album-missing", suggest: at };
      if (e.code !== "target-missing") return { ok: false, refused: e.code };
      if (!mayFind) return { ok: false, needs: "target", reason: "target-missing", suggest: at };
      // 保存先に作品が無い（ファイル App で移した・名前を変えた・消した）→ 同じ ID か同じ指紋の作品を探す
      //  （探す命令の断りも結果で返す＝例外で save() の外へ出さない。第三者レビュー D-L7）
      let found: Awaited<ReturnType<MobilePort["findWorks"]>>;
      try {
        found = await this.port.findWorks({ workId: readWorkId(this.project), fingerprint: src });
      } catch (f) {
        if (f instanceof MobileRefusal) return { ok: false, refused: f.code };
        throw f;
      }
      if (found.length === 1) {
        if (!found[0].fingerprintMatch) return { ok: false, needs: "saveAs", reason: "fingerprint-mismatch", suggest: at };
        return this.overwriteAt({ album: found[0].album, name: found[0].name }, src, resumed, false);
      }
      return { ok: false, needs: "target", reason: found.length === 0 ? "target-missing" : "ambiguous", suggest: at };
    }
  }

  /** 新しく保存（置き換えない） */
  private async writeNew(album: string, name: string, selfName: string | null, kind: SaveKind, resumed: ResumeItem[]): Promise<SaveOutcome> {
    try {
      return await this.run(kind, name, resumed, (w) => this.port.saveNew({ album, name, selfName, data: w.data, thumb: w.thumb }));
    } catch (e) {
      if (e instanceof MobileRefusal) return { ok: false, refused: e.code };
      throw e;
    }
  }

  /** ★saveCore の saveWork を通す（readBack の口を必ず渡す・onCommitted で 1 度に揃える・途中で描き足していたらすぐオートセーブ） */
  private async run(
    kind: SaveKind,
    baseName: string,
    resumed: ResumeItem[],
    write: (w: { data: Uint8Array; thumb: Uint8Array }) => Promise<SaveResult>
  ): Promise<SaveOutcome> {
    const p = this.project;
    let readBackWhy: string | null = null;
    const r = await saveWork<MobileWritten>({
      project: p,
      kind,
      baseName,
      currentFrame: () => this.opts.currentFrame?.() ?? 0,
      prepare: this.opts.prepare,
      markEdits: () => {
        const e0 = this.editEpoch;
        return () => this.editEpoch !== e0;
      },
      encode: (q) => (this.opts.encode ?? encodeOnThisThread)(q),
      thumb: (q) => this.opts.thumb?.(q) ?? Promise.resolve(new Uint8Array(0)),
      write: async (w) => {
        const result = await write(w);
        return { path: result.name, result };
      },
      // ★必ず渡す（モバイルの読む命令で）。無いと開けないファイルを正にして、良い写し（オートセーブ）を消す。
      //  ★読む命令が断ったら（保存先が無い・読めない等）確かめで落とす＝確定しない（saveCore は口の例外を「確かめられなかったので
      //  省く」に倒す＝PC の決まり。ここで空のバイト列を返して「開けない」の側にする）。大きすぎて読めないときだけは PC と同じく
      //  確かめを省く（独立レビュー F2）
      //  ★読み戻した中身が、いま書いた中身か（指紋で）。置いたあと読み戻すまでの間に外で置き換えられていたら、ファイルは自分の分では
      //  ない＝確定しない（オートセーブを残し、dirty も残す。確定すると、自分の分がディスクのどこにも無いままオートセーブを消す）
      readBack: async (w) => {
        try {
          const got = await this.port.readWork(w.result.album, w.result.name);
          if (!sameFingerprint(got.fingerprint, w.result.fingerprint)) {
            readBackWhy = "replaced-after-write";
            return new Uint8Array(0);
          }
          return got.data;
        } catch (e) {
          if (isRefusal(e, "too-large")) {
            // 大きすぎて読めない: 開けるかの確かめは PC と同じく省く。ただし置いた所の中身がいま書いた中身かは、探す命令（指紋だけ＝
            //  大きさが同じファイルだけを Rust が読む）で確かめる（外で大きいファイルに置き換えられていたら確定しない。独立レビュー 2 回目 F3）
            if (await this.placedIsOurs(w.result)) return null;
            readBackWhy = "replaced-after-write";
            return new Uint8Array(0);
          }
          readBackWhy = `read-refused:${e instanceof MobileRefusal ? e.code : "error"}`;
          return new Uint8Array(0);
        }
      },
      // ★書いた版と書いた中身の指紋の組に 1 度に揃える（保存先も）
      onCommitted: (w) => {
        this.target = { album: w.result.album, name: w.result.name };
        this.sourceFingerprint = w.result.fingerprint;
        this.baseRev = readRev(p);
        this.commits++;
      },
      // 保存の途中で描き足していない＝ファイルが最新: dirty を下ろし、このセッションのオートセーブを消す
      // （消せなくても保存は成功のまま＝残ったオートセーブは指紋が合わないので、復元しても黙って上書きしない）
      onSettled: async () => {
        this.dirty = false;
        try {
          await this.deleteOwnAutosave();
        } catch (e) {
          this.opts.log?.(`[V202] autosave delete after save failed: ${e instanceof MobileRefusal ? e.code : "error"}`);
        }
      },
      log: this.opts.log,
    });
    if (!r.ok) {
      if (r.stage === "refused") return { ok: false, stage: "refused", reason: "" };
      return { ok: false, stage: r.stage, reason: r.stage === "read-back" && readBackWhy ? readBackWhy : r.reason };
    }
    // ★保存の途中で描き足していた → すぐオートセーブを書き直す（同じ便の中＝揃えた組で）。書けなくても保存は成功のまま。
    //  確定のあと、このセッションのオートセーブを消している間に描き足した分も（settled は消す前に決まる＝知らせが savedPartial。独立レビュー F3）
    if (!r.settled || r.notice === "savedPartial") {
      try {
        await this.autosaveNow();
      } catch (e) {
        this.opts.log?.(`[V202] autosave after partial save failed: ${e instanceof MobileRefusal ? e.code : "error"}`);
      }
    }
    const res = r.written.result;
    return {
      ok: true,
      target: { album: res.album, name: res.name },
      rev: this.baseRev,
      fingerprint: res.fingerprint,
      notice: r.notice,
      oursMoved: res.oursMoved,
      keptCopies: res.keptCopies,
      recordLeft: res.recordLeft,
      resumed,
    };
  }

  /** 置いた所（Rust が返したアルバムと名前）の中身が、いま書いた中身か（探す命令で指紋だけを見る。探せなければ「違う」の側） */
  private async placedIsOurs(r: SaveResult): Promise<boolean> {
    try {
      const found = await this.port.findWorks({ workId: null, fingerprint: r.fingerprint });
      return found.some((f) => f.fingerprintMatch && f.album === r.album && f.name === r.name);
    } catch {
      return false;
    }
  }
}

/** オートセーブの印を読む（崩れた値は無いものとして） */
export function readStamp(meta0: unknown): { target: WorkTarget | null; sourceFingerprint: Fingerprint | null; baseRev: number; workId: string | null; savedAt: string } {
  // 印が JSON の物でない（null・配列など）ときは空の印として読む（一覧・提案・復元で落ちない。Rust も物でない印は出さない＝独立レビュー F4）
  const meta = (meta0 !== null && typeof meta0 === "object" && !Array.isArray(meta0) ? meta0 : {}) as Record<string, unknown>;
  const album = meta.album;
  const name = meta.name;
  const target = typeof album === "string" && typeof name === "string" && album !== "" && name !== "" ? { album, name } : null;
  const fp = isFingerprint(meta.sourceFingerprint) ? meta.sourceFingerprint : null;
  const rev = typeof meta.baseRev === "number" && Number.isSafeInteger(meta.baseRev) && meta.baseRev >= 0 ? meta.baseRev : -1;
  return { target, sourceFingerprint: fp, baseRev: rev, workId: typeof meta.workId === "string" ? meta.workId : null, savedAt: typeof meta.savedAt === "string" ? meta.savedAt : "" };
}

/** 新しい順（書いた時刻・同じなら番号） */
function newestFirst(a: SessionEntry, b: SessionEntry): number {
  const ta = readStamp(a.meta).savedAt;
  const tb = readStamp(b.meta).savedAt;
  if (ta !== tb) return ta < tb ? 1 : -1;
  return a.session < b.session ? -1 : a.session > b.session ? 1 : 0;
}

/** ★作品を開くときの候補: 保存先（アルバムと名前・大小と NFC を無視）か作品の ID のどちらかが合うもの全部・新しい順 */
export function candidatesFor(entries: SessionEntry[], work: { album: string; name: string; workId: string | null }): SessionEntry[] {
  const ka = foldName(work.album);
  const kn = foldName(work.name);
  return entries
    .filter((e) => {
      const st = readStamp(e.meta);
      const sameTarget = !!st.target && foldName(st.target.album) === ka && foldName(st.target.name) === kn;
      const sameId = work.workId !== null && st.workId === work.workId;
      return sameTarget || sameId;
    })
    .sort(newestFirst);
}

/** ★起動したときの提案の並び（新しい順） */
export function proposals(entries: SessionEntry[]): SessionEntry[] {
  return [...entries].sort(newestFirst);
}
