// V221 (M-2b-2・指示書 ■2(6)(7)・■3 の D-3・D-10): 保存・オートセーブ・裏に回るのつなぎの**決まり**（画面を持たない・DOM を読まない）。
//
// 画面（workScreen.ts）はここの関数を呼ぶだけにして、決まりは Node の出来事の列で確かめる（scripts/v221_smoke.ts の [A]・[B]）。
//
// ■ 保存の結果の行き先（D-10・確かめ画面の 285〜299 と同じ分け方）: `routeSaveOutcome`
// ■ 断りの値 → 理由の文（生のエラーの文を画面に出さない）: `REFUSAL_REASON`
// ■ 保存を押したら、列に並んでいてまだ書き始めていないオートセーブの便を取りやめる（V211 の報告 §5）: `AutosaveGate`
//   取りやめた便は "skipped"（書いていない結果）で解く＝時計の書いている途中の印（inflight）が残らない。書き始めた便はそのまま書かせる
// ■ 裏に回るときの順（D-3）: ① 振り分け層の interrupt → ② コアの otherOperationStarted → ③ 時計の suspend: `suspendSequence`
// ■ 裏に回るときの便の印と「捨てる」は、コアの口（★V221b: `backgroundMark`・`backgroundChangedSince`＝決-13・要件書 §5-0）。
//   閉じた・履歴が変わった・押している・印のあとに変形／浮いた絵／四隅／選択の移動／1 ドット動かすが始まったか終わった、で捨てる。
//   印のときから続いているだけなら捨てない（書く姿は workForBackground）。V221 のモバイルの側の一時的な写しはこの回で消した（0）
import type { SaveOutcome, WorkTarget, AutosaveStart } from "../../mobile/session";
import type { MbKey } from "../i18n";

// ---------------- 保存の結果の行き先（D-10） ----------------

export type SaveRoute =
  /** 保存した。lowerDirty＝コアの dirty を下ろす（描き足していない）・leave＝ライブラリへ戻る（［保存して戻る］から来た） */
  | { kind: "done"; toastKey: MbKey; lowerDirty: boolean; leave: boolean }
  /** 名前とアルバムを聞く（初めて・外で書き換えられていた＝別名で・保存先が決まらない＝選び直す） */
  | { kind: "ask"; mode: "first" | "saveAs" | "relocate"; suggest: WorkTarget | null; msgKey: MbKey | null }
  /** 同じアルバムに同じ名前（初めての保存の画面のその文） */
  | { kind: "nameTaken" }
  /** 端末の空きが足りない */
  | { kind: "noSpace" }
  /** 保存できなかった（理由の 1 行） */
  | { kind: "failed"; reasonKey: MbKey }
  /** コアが知らせ済み（写す前の見積りで断った＝コアの reportSnapshotTooBig）。画面は何も足さない */
  | { kind: "reported" };

/** 断りの決まった値 → 理由の文のキー（表に無い値は「思わぬこと」）。name-taken と no-space は別の行き先 */
export const REFUSAL_REASON: Readonly<Record<string, MbKey>> = {
  "bad-name": "mb.save.reason.name.msg",
  "name-too-long": "mb.save.reason.name.msg",
  "pending-record": "mb.save.reason.busy.msg",
  "too-large": "mb.save.reason.tooBig.msg",
  "cross-volume": "mb.save.reason.write.msg",
  "cannot-place": "mb.save.reason.write.msg",
  "verify-failed": "mb.save.reason.read.msg",
  io: "mb.save.reason.write.msg",
  outside: "mb.save.reason.other.msg",
  unsupported: "mb.save.reason.other.msg",
  "bad-request": "mb.save.reason.other.msg",
  "stale-generation": "mb.save.reason.other.msg",
  "bad-session": "mb.save.reason.other.msg",
  "reserved-key": "mb.save.reason.other.msg",
  "album-missing": "mb.save.reason.other.msg",
  "target-missing": "mb.save.reason.other.msg",
  "fingerprint-mismatch": "mb.save.reason.other.msg",
};

/** 写しの段で落ちた（saveWork の stage） → 理由の文 */
export const STAGE_REASON: Readonly<Record<"encode" | "read-back", MbKey>> = {
  encode: "mb.save.reason.copy.msg",
  "read-back": "mb.save.reason.read.msg",
};

/** 断りの値から理由の文（生の文は画面に出さない） */
export function reasonKeyOf(code: string): MbKey {
  return REFUSAL_REASON[code] ?? "mb.save.reason.other.msg";
}

/**
 * ★保存の結果の行き先（D-10）。
 *  - ok → 「保存しました」（［保存して戻る］から来たら「保存しました。ライブラリへ戻ります」と戻る）。描き足していたとき（savedPartial）と、
 *    保存のあとセッションに編集の印が立っているときは dirty を下ろさない
 *  - needs first / saveAs / target → 同じ画面を初めて・別名で・選び直すの形で
 *  - refused: no-space → 空きが足りない・name-taken → 同じ名前・ほか → 保存できなかった（理由は表から）
 *  - stage refused → コアが知らせ済み・encode / read-back → 保存できなかった
 *  ［保存して戻る］は ok のときだけ戻る（ほかの行き先は leave を持たない＝描く画面に残る）
 */
export function routeSaveOutcome(out: SaveOutcome, ctx: { fromLeave: boolean; sessionDirtyAfter: boolean }): SaveRoute {
  if (out.ok) {
    const settled = out.notice === "saved" && !ctx.sessionDirtyAfter;
    return { kind: "done", toastKey: ctx.fromLeave ? "mb.leave.saved.toast" : "mb.save.done.toast", lowerDirty: settled, leave: ctx.fromLeave };
  }
  if ("needs" in out) {
    if (out.needs === "first") return { kind: "ask", mode: "first", suggest: null, msgKey: null };
    if (out.needs === "saveAs") return { kind: "ask", mode: "saveAs", suggest: out.suggest, msgKey: "mb.save.replaced.msg" };
    return { kind: "ask", mode: "relocate", suggest: out.suggest, msgKey: "mb.save.retarget.msg" };
  }
  if ("refused" in out) {
    if (out.refused === "no-space") return { kind: "noSpace" };
    if (out.refused === "name-taken") return { kind: "nameTaken" };
    return { kind: "failed", reasonKey: reasonKeyOf(out.refused) };
  }
  if (out.stage === "refused") return { kind: "reported" };
  return { kind: "failed", reasonKey: STAGE_REASON[out.stage] };
}

// ---------------- オートセーブの便と保存のつなぎ ----------------

/** コアの口（受け継いだクラスが公開の別名で渡す） */
export interface CoreAutosavePort {
  /** 書き始めない条件（コアの autosaveBlocked） */
  blocked(): boolean;
  /** 書き始めの印（コアの autosaveMark） */
  mark(): { hist0: number };
  /** ふだんの便の「捨てる」（コアの autosaveChangedSince） */
  changedSince(m: { hist0: number }): boolean;
  /** 裏に回るときの姿（コアの workForBackground） */
  workForBackground(): AutosaveStart["project"];
  /** いま持っている作品（セッションと同じもの） */
  project(): AutosaveStart["project"];
  /** ★V221b: 裏に回る便の印（コアの backgroundMark）と「捨てる」（コアの backgroundChangedSince）。印の中は見ない */
  backgroundMark(): BackgroundMarkOf;
  backgroundChangedSince(m: BackgroundMarkOf): boolean;
}

/** 裏に回る便の印（コアの BackgroundMark。中は比べるためだけのもの） */
export type BackgroundMarkOf = { readonly hist0: number; readonly sig: readonly unknown[] };

/**
 * ★オートセーブの便の口（セッションの `autosave({ start })` に渡す）と、保存を押したときの取りやめ。
 *  - ふだんの便: 書き始めに印を取り、その便の「捨てる」は `changedSince(印)`（書いている途中に描くと捨てる）
 *  - 裏に回る便（reason "suspend"）: 印は `backgroundMark()`（書く姿 `workForBackground()` を取るのと同じ時）・「捨てる」は `backgroundChangedSince(印)`
 *  - 保存を押した（`saveRequested`）: それより前に並んで、まだ書き始めていない便は、順が来たら書かずに "skipped"
 */
export class AutosaveGate {
  private saveSeq = 0;
  /** 取りやめた便の数（検査と確かめ画面の記録） */
  cancelled = 0;

  constructor(private core: CoreAutosavePort) {}

  /** 保存を押した（列にいる、まだ書き始めていない便を取りやめる） */
  saveRequested(): void {
    this.saveSeq++;
  }

  /** 便の口を作る（時計の write から呼ぶ）。並べた時点の保存の回数を控え、順が来たときに変わっていれば取りやめる */
  startFor(reason: string): () => AutosaveStart | null {
    const seq0 = this.saveSeq;
    const bg = reason === "suspend";
    return () => {
      if (!bg && this.saveSeq !== seq0) {
        this.cancelled++;
        return null;
      }
      if (bg) {
        const bm = this.core.backgroundMark();
        const project = this.core.workForBackground();
        return { project, aborted: () => this.core.backgroundChangedSince(bm) };
      }
      const m = this.core.mark();
      return { project: this.core.project(), aborted: () => this.core.changedSince(m) };
    };
  }
}

/** 時計の busy（書かない間）: コアの書き始めない条件と、振り分け層の「描いている」の両方 */
export function clockBusy(coreBlocked: boolean, drawing: boolean): boolean {
  return coreBlocked || drawing;
}

// ---------------- 裏に回る順（D-3） ----------------

export interface SuspendSteps<R> {
  /** ① 振り分け層: 描いている線をそこまでで確定・ジェスチャーはそこで止める・その接触の残りは捨てる */
  interrupt(): void;
  /** ② コア: 1 ドット動かすのまとめと全レイヤーの束を確定 */
  otherOperationStarted(): void;
  /** ③ 時計: 書いている途中なら待って、変わっていれば書く（このときの便は workForBackground の姿） */
  suspendClock(): Promise<R>;
}

/** ★裏に回る（この順で） */
export async function suspendSequence<R>(s: SuspendSteps<R>): Promise<R> {
  s.interrupt();
  s.otherOperationStarted();
  return s.suspendClock();
}

// ---------------- 保存の便と時計の順（確かめ画面と同じ） ----------------

export interface SaveClockPort {
  currentEpoch(): number;
  holdUntil(p: Promise<unknown>): void;
  settledAt(epoch: number): void;
}

/**
 * ★保存の便（確かめ画面の doSave と同じ順）: 編集の回数を控える → 列の取りやめ → 保存 → 確定して描き足していなければ settledAt。
 *  保存が終わって settledAt を呼ぶまで、時計は書かない（holdUntil）。`settledAt` を外すと、保存が消したオートセーブを古い写しで
 *  書き戻す（M-1 の T1・v221 [A] が見る）
 */
export function runSaveWithClock(clock: SaveClockPort | null, gate: AutosaveGate | null, save: () => Promise<SaveOutcome>): Promise<SaveOutcome> {
  const e0 = clock?.currentEpoch() ?? 0;
  gate?.saveRequested();
  const done = (async () => {
    const out = await save();
    if (out.ok && out.notice === "saved") clock?.settledAt(e0);
    return out;
  })();
  clock?.holdUntil(done);
  return done;
}
