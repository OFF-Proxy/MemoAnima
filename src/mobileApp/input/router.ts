// V220 (M-2b-1b・要件 docs/REQ_mobile_m2_editor.md §5-5・§5-7・決-14〜決-16・C3・親 docs/REQ_mobile_v1.md §6): **入力の振り分け層**。
//
// 描く画面の全部の接触（Pointer Events の形の素のオブジェクト）を、ボタン・コマの帯・パネルより**先に**受け取り（§5-5 の 2）、1 つずつ
// 「描く（コアの口へ）」「ジェスチャー」「ボタンやパネルへ通す」「捨てる」に分ける。画面につなぐのは M-2b-2。
//
// ★画面を持たない: DOM を読まない・`window` の時計を使わない。時刻は出来事の `timeStamp` と、画面が呼ぶ `tick(now)` だけ
//  （検査は止めて進める）。押した所の下が何か（絵／ボタン・パネル・コマの帯）と、画面の座標から絵の画素への直し（PC の `clientToPixelF` と
//  同じ決まり＝画素 n が [n, n+1) を占める）は、画面が渡す関数（[`RouterEnv`]）で受ける。
// ★`pointerType` を読むのは、この部品の中の**1 つの関数 [`contactKind`] だけ**（I8・親§6-9）。コアには渡さない。描いた結果を
//  `pointerType` で変えない（同じサンプルなら、ペンでも指でもマウスでも同じ線）。網は scripts/v220_smoke.ts [D] が構文木で見る。
// ★仮の数（§5-5 の表・D-M2-5 で協力者の iPad を見て決める）は 1 か所 [`INPUT_TUNING`]。
// ★設定（指で描く・指を使わない・ジェスチャーごとのオンとオフ・長押しの時間・筆圧で太さと効き方・ホバーの形・取り消しの小さな表示）は
//  受け取る値（[`InputSettings`]）。保存は M-2b-3。
//
// 決まり（§5-5 の番号）:
//  1 読むのは 1 か所（contactKind）                     9  筆圧は線ごとに最初の 30 点で決める・曲線は 3 段・0 より大きい値
//  2 画面の全部を先に見る（handle の戻り値で画面へ）       10 coalesced の点を全部・predicted は仮の線（確定に使わない）
//  3 ペンは触れた瞬間から描く・ペンの間と離して 300ms は指を全部捨てる  11 ホバーの輪（ペンが浮いている間）
//  4 ペンを使う端末（指で描くの既定をオフ・1 回お知らせ）    12 修飾キー（サンプルと modifiersChanged）
//  5 指で描くときは 150ms 控える（2 本目でジェスチャー・控えを捨てる）  13 描いている印
//  6 手のひら（確定 → 積まれていれば 1 回取り消す → ペンを描き始める・表示を戻す）  14 取り上げられたら確定・残りは捨てる
//  7 指を使わない（2 本指で動かす・ピンチだけ効く）         15 マウスは押した瞬間から描く（4・3・長押しには数えない）
//  8 ジェスチャー（タップ・動かす・拡大・回転・長押しのスポイト）
//  §5-7 裏に回る・閉じる・替える間の接触は捨てる／重い処理の最中は描く口とボタンに回さない
import type { EditorCore, StrokeSample, Tool } from "../../editor/core/editorCore";

/** ★仮の数（§5-5 の表）。ここ 1 か所 */
export const INPUT_TUNING = {
  /** 指で描くときに待つ時間（親§6-1） */
  fingerHoldMs: 150,
  /** ペンを離してから指を使わない時間（親§6-2） */
  penQuietMs: 300,
  /** タップ: 置いてから全部の指が離れるまで（親§6-3） */
  tapMs: 250,
  /** タップ: どの指の動きもこの中（pt＝画面の座標） */
  tapSlopPt: 10,
  /** 長押しのスポイト: 動きがこの中のまま設定の時間がたつ（pt） */
  longPressSlopPt: 10,
  /** ひねり始め（度・UI §4-1） */
  twistStartDeg: 15,
  /** 筆圧を見る点の数（親§6-4） */
  pressureProbe: 30,
  /** 筆圧の曲線の最小の値（0 はコアで「筆圧なし」と同じ扱い＝そこだけ選んだ太さに戻る。0 より大きくする＝決-16）。
   *  0.01 でコアの係数は 0.4 + 0.01 × 1.2 = 0.412（一番弱い所の太さ）＝曲線の 0 と見分けのつく一番小さい所 */
  pressureMin: 0.01,
  /** 筆圧の曲線（標準）: ふつうの筆圧 0.35 で選んだ太さ（0.5）・0.7 以上で 1（§5-5 の 9） */
  pressurePivotIn: 0.35,
  pressurePivotOut: 0.5,
  pressureFullIn: 0.7,
} as const;

/** 長押しのスポイトが効くツール（§5-5 の 8。移動・範囲選択・変形・歪み・文字・スポイトは、押して止まるのがふつうの操作なので効かない） */
export const LONG_PRESS_TOOLS: readonly Tool[] = ["pen", "brush", "eraser", "fill", "shape"];

/** 受け取る設定（保存は M-2b-3） */
export interface InputSettings {
  /** 指で描く。null＝利用者がまだ選んでいない（ペンを使う端末と分かったら既定でオフ＝§5-5 の 4） */
  fingerDraw: boolean | null;
  /** 指を使わない（キャンバスの上の指。2 本指で動かす・ピンチだけ効く＝DU-14 は暫定 A） */
  noFinger: boolean;
  /** ジェスチャーごとのオンとオフ（2 本指で動かす・ピンチは切れない） */
  gestures: { undoTap: boolean; redoTap: boolean; toolsTap: boolean; twist: boolean; longPress: boolean };
  /** 長押しの時間（ms・設定で 300・500・800） */
  longPressMs: number;
  /** 筆圧で太さ（オフなら いつも 0.5＝PC と同じ） */
  pressure: boolean;
  /** 筆圧の効き方 */
  pressureCurve: "weak" | "standard" | "strong";
  /** ホバーの形 */
  hover: "ring" | "cross" | "none";
  /** 取り消し・やり直しの小さな表示 */
  undoBadge: boolean;
}

export function defaultInputSettings(): InputSettings {
  return {
    fingerDraw: null,
    noFinger: false,
    gestures: { undoTap: true, redoTap: true, toolsTap: true, twist: true, longPress: true },
    longPressMs: 500,
    pressure: true,
    pressureCurve: "standard",
    hover: "ring",
    undoBadge: true,
  };
}

/** 点（`getCoalescedEvents()`・`getPredictedEvents()` の 1 つ） */
export interface RawPoint {
  clientX: number;
  clientY: number;
  pressure: number;
}

/** 受け取る出来事（Pointer Events の形の素のオブジェクト。本物の PointerEvent をそのまま渡せる） */
export interface RawPointerEvent extends RawPoint {
  /** "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "pointerleave"（画面の外へ出た） */
  type: string;
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  timeStamp: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  getCoalescedEvents?: () => readonly RawPoint[];
  getPredictedEvents?: () => readonly RawPoint[];
}

/** 押した所の下 */
export type HitKind = "canvas" | "ui";

/** 画面の状態（§5-7） */
export interface RouterState {
  /** 裏に回っている */
  background: boolean;
  /** 作品を閉じている／替えている間 */
  switching: boolean;
  /** 重い処理の最中（「◯◯しています」） */
  busy: boolean;
  /** いまのツール（長押しのスポイトが効くか） */
  tool: Tool;
  /** ★V225 (指示書 ■3 の K): 1 本の接触で絵を動かす間（ハードウェアキーボードの Space を押している・手のひらのツール＝PC と同じ）。
   *  その間、キャンバスの上の 1 本の接触（ペン・指・マウス）は描かずに絵を動かす */
  pan?: boolean;
}

/** 画面が渡す口 */
export interface RouterEnv {
  hitTest(clientX: number, clientY: number): HitKind;
  /** 画面の座標 → 絵の画素の座標（小数・画素 n が [n, n+1)） */
  toPixel(clientX: number, clientY: number): { x: number; y: number };
  state(): RouterState;
  settings(): InputSettings;
}

/** ★コアの描く口（替え玉も同じ型＝コアの口がずれたら型の確かめで落ちる） */
export type CoreStrokePort = Pick<EditorCore, "strokeBegin" | "strokeMove" | "strokeEnd" | "strokeCancel" | "modifiersChanged">;

/** 描く画面の側（コアの口のほかに要るもの） */
export interface RouterSink extends CoreStrokePort {
  /** 取り消し 1 回（手のひらの線・2 本指のタップ）。終わるまで待てる形（コアの取り消しは列で後から走る＝待たずにペンを描き始めると、
   *  押した瞬間に積むバケツや自動選択のほうを取り消す） */
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
  /** その場の色を 1 回拾う（長押しのスポイト。画素の整数の座標） */
  pickColor(pt: { x: number; y: number }): void;
}

/** ジェスチャーの知らせ（倍率と寄せ方は view/zoom.ts） */
export interface GestureUpdate {
  /** start: 2 本目が触れた／move: 指が動いた／end: 指が離れた・取り上げられた（そこまでで止めて寄る）／revert: 手のひら＝動く前に戻す */
  phase: "start" | "move" | "end" | "revert";
  /** 2 本の指の真ん中（画面の座標） */
  center: { x: number; y: number };
  /** 始めからの動き（画面の座標） */
  pan: { dx: number; dy: number };
  /** 始めからの拡大（指の間の長さの比） */
  scale: number;
  /** 回転（度・ひねり始めの 15° を超えてから・切っていれば 0） */
  rotationDeg: number;
}

/** 描く画面に知らせる所（替え玉は記録するだけ） */
export interface RouterView {
  /** ボタン・パネルに通していた接触を取り消す（手のひら・取り上げ）。画面はその接触で押したことにしない */
  uiCancel(pointerId: number): void;
  gesture(g: GestureUpdate): void;
  /** 4 本指のタップ＝ツールを隠す／表示する */
  toggleTools(): void;
  /** 描いている印（この間は飾りの動きを出さない・オートセーブの「書かない間」） */
  drawingChanged(drawing: boolean): void;
  /** ペンを使う端末と分かった（指で描くの既定をオフにした＝その場で 1 回お知らせ） */
  penDeviceDetected(): void;
  /** 取り消し・やり直しの小さな表示 */
  undoBadge(kind: "undo" | "redo"): void;
  /** ホバーの輪（画素の座標・null で消す）。形は設定 */
  hover(pt: { x: number; y: number } | null, style: "ring" | "cross"): void;
  /** 予測の仮の線（確定の線には使わない・次の出来事で消す＝null） */
  predicted(samples: readonly StrokeSample[] | null): void;
}

/** 戻り値: "ui"＝画面のボタン・パネルへそのまま通す／"consumed"＝振り分け層が受けた（画面は止める）／"dropped"＝捨てた（画面は止める） */
export type Routed = "ui" | "consumed" | "dropped";

type Kind = "pen" | "finger" | "mouse";

/** ★`pointerType` を読む**ただ 1 つの関数**（I8）。分からない種類は指として扱う（ペンの扱い〔待たない・手のひらを捨てる〕を勝手に与えない） */
export function contactKind(e: { pointerType: string }): Kind {
  const t = e.pointerType;
  if (t === "pen") return "pen";
  if (t === "mouse") return "mouse";
  return "finger";
}

/** 筆圧の曲線（§5-5 の 9）。0.35 で 0.5 を通る直線で、標準は 0.7 で 1・弱めと強めは傾きを 0.5 倍・1.5 倍。いつも [pressureMin, 1] */
export function pressureCurve(p: number, curve: InputSettings["pressureCurve"]): number {
  const T = INPUT_TUNING;
  const slope = ((1 - T.pressurePivotOut) / (T.pressureFullIn - T.pressurePivotIn)) * (curve === "weak" ? 0.5 : curve === "strong" ? 1.5 : 1);
  const v = T.pressurePivotOut + (p - T.pressurePivotIn) * slope;
  return Math.min(1, Math.max(T.pressureMin, v));
}

/** 1 本の線の筆圧の判定（線ごと・持ち越さない） */
class PressureJudge {
  private seen = new Set<number>();
  private n = 0;
  usable = false;
  /** 点を 1 つ見て、使えるかを返す（最初の pressureProbe 点で 2 種類以上に割れたら、そこから使う） */
  see(p: number): boolean {
    if (this.usable) return true;
    if (this.n >= INPUT_TUNING.pressureProbe) return false;
    this.n++;
    this.seen.add(p);
    if (this.seen.size >= 2) this.usable = true;
    return this.usable;
  }
}

type Role =
  | "stroke" // 描く口に回している
  | "pending" // 指で描く: 150ms 控えている
  | "idle" // キャンバスの上の 1 本の指（描かない・2 本目が来ればジェスチャー）
  | "gesture"
  | "pan" // ★V225: 1 本の接触で絵を動かしている（Space・手のひら）
  | "ui" // ボタン・パネルへ通している
  | "ignored"; // 捨てる（離すまで）

interface Contact {
  id: number;
  kind: Kind;
  role: Role;
  t0: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  /** 始めからの動きの最大（pt） */
  moved: number;
  /** 指で描く: 控えた点 */
  held: StrokeSample[];
  /** 描く口に回した最後のサンプル */
  last: StrokeSample | null;
  judge: PressureJudge;
  /** 長押しのスポイトが効く接触か（押した時点のツールで決める） */
  longPressArmed: boolean;
}

interface Gesture {
  ids: number[];
  maxFingers: number;
  t0: number;
  /** 動き・拡大がタップの外へ出た */
  moved: boolean;
  startCenter: { x: number; y: number };
  startDist: number;
  startAngle: number;
  /** ひねり始めを超えたときの角度のずれ（0＝まだ回っていない） */
  twistOffset: number;
  twisting: boolean;
  last: GestureUpdate | null;
}

/** ペンの描き始めを、手のひらの取り消しが終わるまで待たせている間の控え */
interface PenWait {
  id: number;
  samples: StrokeSample[];
  end: StrokeSample | null;
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

/** ★入力の振り分け層 */
export class InputRouter {
  private contacts = new Map<number, Contact>();
  /** いまペンが触れている接触 */
  private penId: number | null = null;
  /** 最後にペンを離した時刻 */
  private penUpAt = -Infinity;
  /** 描く口に回している接触（1 つだけ） */
  private strokeId: number | null = null;
  private gestureState: Gesture | null = null;
  private penWait: PenWait | null = null;
  /** ペンを受けた（ペンを使う端末） */
  private penDevice: boolean;
  private drawing = false;
  /** 予測の仮の線を出している */
  private predictedShown = false;
  /** 待ちの数（検査が idle() で待つ） */
  private waits: Promise<void>[] = [];

  constructor(
    private env: RouterEnv,
    private sink: RouterSink,
    private view: RouterView,
    opts?: { penDevice?: boolean }
  ) {
    this.penDevice = !!opts?.penDevice;
  }

  /** ペンを使う端末と分かっているか（画面が保存するなら M-2b-3） */
  isPenDevice(): boolean {
    return this.penDevice;
  }

  /** 描いている（振り分け層が描く口に回した接触がある） */
  isDrawing(): boolean {
    return this.drawing;
  }

  /** 待ち（手のひらの取り消し）が全部終わるまで（検査用） */
  async idle(): Promise<void> {
    while (this.waits.length) {
      const w = this.waits.splice(0);
      await Promise.all(w);
    }
  }

  /** いまの「指で描く」（利用者が選んでいなければ、ペンを使う端末ではオフ） */
  private fingerDraws(s: InputSettings): boolean {
    if (s.noFinger) return false;
    return s.fingerDraw ?? !this.penDevice;
  }

  private setDrawing(on: boolean) {
    if (this.drawing === on) return;
    this.drawing = on;
    this.view.drawingChanged(on);
  }

  private clearPredicted() {
    if (this.predictedShown) {
      this.predictedShown = false;
      this.view.predicted(null);
    }
  }

  /** 出来事の点（coalesced も）を位置と始めからの動きの最大へ入れる */
  private track(c: Contact, e: RawPointerEvent) {
    for (const p of this.pointsOf(e)) {
      c.x = p.clientX;
      c.y = p.clientY;
      c.moved = Math.max(c.moved, dist(c.x, c.y, c.x0, c.y0));
    }
  }

  /** ジェスチャーの動きがタップの外へ出たか（指の動き・指の間の長さの変化） */
  private gestureMovedBy(c: Contact, g: Gesture, u: GestureUpdate) {
    if (c.moved > INPUT_TUNING.tapSlopPt || Math.abs(u.scale - 1) * g.startDist > INPUT_TUNING.tapSlopPt) g.moved = true;
  }

  /** 画面の座標の点 → サンプル（筆圧は線ごとの判定と曲線） */
  private sampleOf(c: Contact, pt: RawPoint, e: RawPointerEvent, judgeIt: boolean): StrokeSample {
    const s = this.env.settings();
    const px = this.env.toPixel(pt.clientX, pt.clientY);
    let pressure = 0.5;
    if (s.pressure) {
      const usable = judgeIt ? c.judge.see(pt.pressure) : c.judge.usable;
      if (usable) pressure = pressureCurve(pt.pressure, s.pressureCurve);
    }
    return { x: px.x, y: px.y, pressure, button: 0, shift: !!e.shiftKey, alt: !!e.altKey, ctrl: !!e.ctrlKey, meta: !!e.metaKey };
  }

  /** 出来事の点（coalesced を全部。無ければその出来事の点） */
  private pointsOf(e: RawPointerEvent): RawPoint[] {
    const co = e.getCoalescedEvents?.() ?? [];
    return co.length ? [...co] : [e];
  }

  /** ★出来事を 1 つ受ける。戻り値で、画面がボタン・パネルへ通すかを決める（§5-5 の 2） */
  handle(e: RawPointerEvent): Routed {
    // ★V220（独立レビューの指摘）: 出来事の座標を先に動きへ入れてから時計を進める（長押しの期限に来た出来事が遠くへ動いていたら、
    //  スポイトにしない）。離す出来事の座標も入れる（離す瞬間だけに来た動きでタップにしない）
    const known = this.contacts.get(e.pointerId);
    if (known && (e.type === "pointermove" || e.type === "pointerup")) this.track(known, e);
    this.runTimers(e.timeStamp);
    switch (e.type) {
      case "pointerdown":
        return this.down(e);
      case "pointermove":
        return this.move(e);
      case "pointerup":
        return this.up(e, false);
      case "pointercancel":
      case "pointerleave":
        return this.up(e, true);
      default:
        return "dropped";
    }
  }

  /** 時計（画面が rAF などで呼ぶ）。控えの 150ms・長押しの時間を進める */
  tick(now: number): void {
    this.runTimers(now);
  }

  /** ハードウェアキーボードの修飾キーが変わった（§5-5 の 12）。描いている間だけコアへ */
  keyboardModifiers(m: { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean }): void {
    if (this.strokeId !== null && !this.penWait) this.sink.modifiersChanged(m);
  }

  /** ★裏に回る・作品を閉じる・替える（§5-5 の 14・§5-7）: 描いている線をそこまでで確定し、ジェスチャーはそこまでで止め、
   *  いまの接触の残りは全部捨てる */
  interrupt(): void {
    for (const c of [...this.contacts.values()]) this.takeAway(c);
    this.flushPenWaitAsEnded();
  }

  // ---------------- 押した ----------------

  private down(e: RawPointerEvent): Routed {
    const kind = contactKind(e);
    const st = this.env.state();
    const s = this.env.settings();
    // 同じ番号の古い接触（離した知らせが来なかった）は取り上げたことにする
    const stale = this.contacts.get(e.pointerId);
    if (stale) this.takeAway(stale);
    const c: Contact = {
      id: e.pointerId,
      kind,
      role: "ignored",
      t0: e.timeStamp,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: 0,
      held: [],
      last: null,
      judge: new PressureJudge(),
      longPressArmed: false,
    };
    this.contacts.set(c.id, c);
    // ペンが触れている間は、どこに触れていても（重い処理の最中でも）指を使わない（§5-5 の 3）
    if (kind === "pen") this.penId = c.id;
    // §5-7: 裏に回る・閉じる・替える間・重い処理の最中は、描く口にもボタンにも回さない。
    //  ★V220（独立レビューの指摘）: その間でもペンが触れたら、先に置いていた手のひらは捨てる（ボタンに通していた指を取り消す。
    //  描いていた指の線は確定する＝重い処理の最中はコアが受けないので積まれない）
    if (st.background || st.switching || st.busy) {
      if (kind === "pen") void this.rejectPalms();
      return "dropped";
    }
    const hit = this.env.hitTest(e.clientX, e.clientY);

    // ★V225 (K): Space を押している間・手のひらのツールの間は、キャンバスの上の 1 本の接触で絵を動かす（描かない）。
    //  ペンが触れている間と離して 300ms の指は、ここでも捨てる（§5-5 の 3）。描いている途中・ジェスチャーの途中は今までの決まり
    if (st.pan && hit === "canvas" && kind === "finger" && this.panId !== null && !this.gestureState) {
      // 動かしている指に 2 本目の指が足された＝2 本指のジェスチャーへ（動かしていたのがペンやマウスなら、指は捨てる）
      const pc = this.contacts.get(this.panId);
      if (!pc || pc.kind !== "finger" || this.penId !== null) return "dropped";
      this.endPan(pc);
      this.startGesture([pc, c], pc.t0);
      return "consumed";
    }
    // 「指を使わない」のときの指は、ここでは動かさない（下の決まり＝1 本目は使わず、2 本目でジェスチャー。§5-5 の 7・第三者レビューの指摘 5）
    if (st.pan && hit === "canvas" && e.button === 0 && this.strokeId === null && !this.penWait && !this.gestureState && !(kind === "finger" && s.noFinger)) {
      if (kind === "finger" && (this.penId !== null || e.timeStamp - this.penUpAt < INPUT_TUNING.penQuietMs)) return "dropped";
      if (kind === "pen") {
        // 指で動かしていた所へペンが触れた＝その指は手のひら（動く前に戻す）。ペンが続けて動かす（第三者レビューの指摘 1）
        void this.rejectPalms();
        this.view.hover(null, "ring");
      }
      if (this.panId !== null) return "dropped"; // もう 1 本が動かしている（マウスなど）
      c.role = "pan";
      this.panId = c.id;
      this.view.gesture({ ...this.panAt(c), phase: "start" });
      return "consumed";
    }

    if (kind === "pen") {
      // §5-5 の 4: ペンを使う端末
      if (!this.penDevice) {
        this.penDevice = true;
        if (s.fingerDraw === null) this.view.penDeviceDetected();
      }
      // §5-5 の 6: ペンが触れた瞬間に残っている指は手のひら
      const undo = this.rejectPalms();
      this.view.hover(null, "ring");
      if (hit === "ui") {
        c.role = "ui";
        return "ui";
      }
      if (e.button !== 0) return "dropped"; // 側ボタンを押したままの接触は描く口に回さない（使い方は M-2b-4・D-M2-3）
      if (this.strokeId !== null || this.penWait) return "dropped"; // マウスで描いている途中などは 1 本だけ
      c.role = "stroke";
      c.longPressArmed = s.gestures.longPress && LONG_PRESS_TOOLS.includes(st.tool);
      this.strokeId = c.id;
      this.setDrawing(true);
      const first = this.sampleOf(c, e, e, true);
      c.last = first;
      if (undo) {
        // 取り消しが終わるまで描き始めを待たせる（逆の順だと、押した瞬間に積むバケツ・自動選択のほうを取り消す）
        this.penWait = { id: c.id, samples: [first], end: null };
        const w = Promise.resolve(undo).then(() => this.flushPenWait());
        this.waits.push(w);
        return "consumed";
      }
      this.sink.strokeBegin(first);
      return "consumed";
    }

    if (kind === "mouse") {
      // §5-5 の 15: マウスは押した瞬間から描く。ペンを使う端末・手のひら・長押しには数えない
      if (hit === "ui") {
        c.role = "ui";
        return "ui";
      }
      if (e.button !== 0) return "dropped"; // 右ボタンなどは描く口に回さない（側ボタンの扱いは M-2b-4）
      if (this.strokeId !== null || this.penWait) return "dropped";
      c.role = "stroke";
      this.strokeId = c.id;
      this.setDrawing(true);
      const first = this.sampleOf(c, e, e, true);
      c.last = first;
      this.sink.strokeBegin(first);
      return "consumed";
    }

    // ---- 指 ----
    // §5-5 の 3: ペンが触れている間と、離れてから 300ms は、指を全部捨てる（キャンバスにもボタンにも）
    if (this.penId !== null || e.timeStamp - this.penUpAt < INPUT_TUNING.penQuietMs) return "dropped";
    // 指で描いている間は、ほかの指を捨てる（§5-5 の 5）
    if (this.strokeId !== null || this.penWait) return "dropped";
    if (hit === "ui") {
      c.role = "ui";
      return "ui";
    }
    // キャンバスの上の指
    const g = this.gestureState;
    if (g) {
      // ジェスチャーの途中に足された指
      c.role = "gesture";
      g.ids.push(c.id);
      g.maxFingers = Math.max(g.maxFingers, this.liveGestureCount());
      return "consumed";
    }
    const others = [...this.contacts.values()].filter((o) => o.id !== c.id && (o.role === "pending" || o.role === "idle"));
    if (others.length) {
      // 2 本目: ジェスチャー（控えた点は捨てる＝線を残さない・取り消しの列に入らない）
      this.startGesture([...others, c], Math.min(...others.map((o) => o.t0)));
      return "consumed";
    }
    if (this.fingerDraws(s)) {
      c.role = "pending";
      c.longPressArmed = s.gestures.longPress && LONG_PRESS_TOOLS.includes(st.tool);
      c.held.push(this.sampleOf(c, e, e, true));
      return "consumed";
    }
    c.role = "idle";
    return "consumed";
  }

  /** 手のひらを捨てる。指の線が履歴を積んでいたら、その取り消しの待ちを返す */
  private rejectPalms(): void | Promise<void> | null {
    let undo: void | Promise<void> | null = null;
    for (const c of [...this.contacts.values()]) {
      if (c.kind !== "finger") continue;
      switch (c.role) {
        case "stroke": {
          // 確定 → その接触で積まれていれば 1 回取り消す（積まれていなければ何もしない＝前の別の操作を消さない）
          const pushed = this.sink.strokeEnd(c.last ?? c.held[0]);
          this.clearPredicted();
          this.strokeId = null;
          this.setDrawing(false);
          if (pushed) undo = this.sink.undo() ?? Promise.resolve();
          break;
        }
        case "pending":
          c.held = []; // 控えを捨てるだけ
          break;
        case "gesture":
          break; // 下でまとめて表示を戻す
        case "pan":
          // ★V225（第三者レビューの指摘 1）: 絵を動かしていた指も手のひら＝動く前に戻す（§5-5 の 6）。取り残すと、次から動かせなくなる
          if (this.panId === c.id) {
            this.panId = null;
            this.view.gesture({ ...this.panAt(c), phase: "revert" });
          }
          break;
        case "ui":
          this.view.uiCancel(c.id);
          break;
      }
      c.role = "ignored";
    }
    if (this.gestureState) {
      const g = this.gestureState;
      this.gestureState = null;
      this.view.gesture({ ...(g.last ?? this.gestureAt(g)), phase: "revert" });
    }
    return undo;
  }

  /** ★V225 (K): 1 本の接触で絵を動かす（動きだけ・拡大と回転は無い）。離したら、そこまでの表示で止めて寄る（2 本指と同じ決まり） */
  private panId: number | null = null;
  private panAt(c: Contact): GestureUpdate {
    return { phase: "move", center: { x: c.x, y: c.y }, pan: { dx: c.x - c.x0, dy: c.y - c.y0 }, scale: 1, rotationDeg: 0 };
  }
  private endPan(c: Contact) {
    if (this.panId !== c.id) return;
    this.panId = null;
    this.view.gesture({ ...this.panAt(c), phase: "end" });
  }

  private liveGestureCount(): number {
    const g = this.gestureState;
    if (!g) return 0;
    return g.ids.filter((id) => this.contacts.get(id)?.role === "gesture").length;
  }

  private startGesture(cs: Contact[], t0: number) {
    for (const c of cs) {
      c.role = "gesture";
      c.held = [];
    }
    const [a, b] = cs;
    const g: Gesture = {
      ids: cs.map((c) => c.id),
      maxFingers: cs.length,
      t0,
      moved: cs.some((c) => c.moved > INPUT_TUNING.tapSlopPt),
      startCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      startDist: Math.max(1, dist(a.x, a.y, b.x, b.y)),
      startAngle: Math.atan2(b.y - a.y, b.x - a.x),
      twistOffset: 0,
      twisting: false,
      last: null,
    };
    this.gestureState = g;
    const u = this.gestureAt(g);
    g.last = u;
    this.view.gesture({ ...u, phase: "start" });
  }

  /** いまの 2 本（最初の 2 本のうち触れているもの）の形 */
  private gestureAt(g: Gesture): GestureUpdate {
    const live = g.ids.map((id) => this.contacts.get(id)).filter((c): c is Contact => !!c && c.role === "gesture");
    if (live.length < 2) return g.last ?? { phase: "move", center: g.startCenter, pan: { dx: 0, dy: 0 }, scale: 1, rotationDeg: 0 };
    const [a, b] = live;
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = Math.max(1, dist(a.x, a.y, b.x, b.y)) / g.startDist;
    const s = this.env.settings();
    let rot = 0;
    const raw = ((Math.atan2(b.y - a.y, b.x - a.x) - g.startAngle) * 180) / Math.PI;
    const ang = ((raw + 540) % 360) - 180;
    if (!s.noFinger && s.gestures.twist) {
      if (!g.twisting && Math.abs(ang) > INPUT_TUNING.twistStartDeg) {
        g.twisting = true;
        g.twistOffset = Math.sign(ang) * INPUT_TUNING.twistStartDeg;
      }
      if (g.twisting) rot = ang - g.twistOffset;
    }
    return { phase: "move", center, pan: { dx: center.x - g.startCenter.x, dy: center.y - g.startCenter.y }, scale, rotationDeg: rot };
  }

  // ---------------- 動いた ----------------

  private move(e: RawPointerEvent): Routed {
    const c = this.contacts.get(e.pointerId);
    if (!c) {
      // ペンが浮いている（§5-5 の 11）
      if (contactKind(e) === "pen" && e.buttons === 0) {
        const s = this.env.settings();
        if (s.hover !== "none" && this.env.hitTest(e.clientX, e.clientY) === "canvas") this.view.hover(this.env.toPixel(e.clientX, e.clientY), s.hover);
        else this.view.hover(null, "ring");
        return "consumed";
      }
      return "dropped";
    }
    const pts = this.pointsOf(e);
    for (const p of pts) {
      c.x = p.clientX;
      c.y = p.clientY;
      c.moved = Math.max(c.moved, dist(c.x, c.y, c.x0, c.y0));
    }
    switch (c.role) {
      case "ui":
        return "ui";
      case "ignored":
        return "dropped";
      case "idle":
        return "consumed";
      case "pan":
        this.view.gesture(this.panAt(c));
        return "consumed";
      case "pending": {
        for (const p of pts) c.held.push(this.sampleOf(c, p, e, true));
        // 控えの時間を過ぎていれば描き始める（時計が呼ばれていなくても出来事の時刻で）
        if (e.timeStamp - c.t0 >= INPUT_TUNING.fingerHoldMs) this.startFingerStroke(c);
        return "consumed";
      }
      case "gesture": {
        const g = this.gestureState;
        if (!g) return "consumed";
        const u = this.gestureAt(g);
        this.gestureMovedBy(c, g, u);
        g.last = u;
        this.view.gesture(u);
        return "consumed";
      }
      case "stroke": {
        if (this.penWait && this.penWait.id === c.id) {
          for (const p of pts) this.penWait.samples.push(this.sampleOf(c, p, e, true));
          c.last = this.penWait.samples[this.penWait.samples.length - 1];
          return "consumed";
        }
        const samples = pts.map((p) => this.sampleOf(c, p, e, true));
        c.last = samples[samples.length - 1];
        this.sink.strokeMove(samples);
        // §5-5 の 10: 予測の点は仮の線だけ（確定の線に使わない）
        const pr = e.getPredictedEvents?.() ?? [];
        if (pr.length) {
          this.predictedShown = true;
          this.view.predicted(pr.map((p) => this.sampleOf(c, p, e, false)));
        } else this.clearPredicted();
        return "consumed";
      }
    }
  }

  /** 指で描く: 控えた点から描き始める */
  private startFingerStroke(c: Contact) {
    if (c.role !== "pending") return;
    c.role = "stroke";
    this.strokeId = c.id;
    this.setDrawing(true);
    const [first, ...rest] = c.held;
    c.held = [];
    c.last = rest.length ? rest[rest.length - 1] : first;
    this.sink.strokeBegin(first);
    if (rest.length) this.sink.strokeMove(rest);
  }

  // ---------------- 離した・取り上げられた ----------------

  private up(e: RawPointerEvent, takenAway: boolean): Routed {
    const c = this.contacts.get(e.pointerId);
    if (!c) {
      if (e.type === "pointerleave" && contactKind(e) === "pen") this.view.hover(null, "ring");
      return "dropped";
    }
    if (c.kind === "pen" && this.penId === c.id) {
      this.penId = null;
      this.penUpAt = e.timeStamp;
    }
    let out: Routed = "consumed";
    switch (c.role) {
      case "ui":
        if (takenAway) this.view.uiCancel(c.id);
        out = takenAway ? "dropped" : "ui";
        break;
      case "ignored":
        out = "dropped";
        break;
      case "idle":
        break;
      case "pan":
        this.endPan(c);
        break;
      case "pending": {
        if (takenAway) break; // 取り上げられた控えは描かない
        // 150ms より前に離した＝控えた点で描く（点を打つ）
        const end = c.held[c.held.length - 1];
        this.startFingerStroke(c);
        this.endStroke(c, end);
        break;
      }
      case "gesture": {
        const g = this.gestureState;
        if (g && !takenAway) this.gestureMovedBy(c, g, this.gestureAt(g));
        this.gestureFingerUp(c, takenAway, e.timeStamp);
        break;
      }
      case "stroke": {
        if (this.penWait && this.penWait.id === c.id) {
          this.penWait.end = c.last;
          break;
        }
        // 離した点（筆圧は離す瞬間の 0 を使わず、最後の点のまま）。取り上げられたら最後の点で
        const at = takenAway || !c.last ? c.last : { ...this.sampleOf(c, e, e, false), pressure: c.last.pressure };
        if (at) this.endStroke(c, at);
        break;
      }
    }
    c.role = "ignored";
    this.contacts.delete(c.id);
    return out;
  }

  private endStroke(c: Contact, end: StrokeSample) {
    if (this.strokeId !== c.id) return;
    this.clearPredicted();
    this.sink.strokeEnd(end);
    this.strokeId = null;
    this.setDrawing(false);
  }

  private gestureFingerUp(c: Contact, takenAway: boolean, t: number) {
    const g = this.gestureState;
    c.role = "ignored";
    if (!g) return;
    if (takenAway) g.moved = true; // 取り上げられたらタップにしない
    // 指が残っていれば、全部が離れるまで待つ（タップは全部の指が離れたときに決める）
    if (g.ids.some((id) => id !== c.id && this.contacts.get(id)?.role === "gesture")) return;
    // 全部の指が離れた
    this.gestureState = null;
    this.view.gesture({ ...(g.last ?? this.gestureAt(g)), phase: "end" });
    if (g.moved || t - g.t0 > INPUT_TUNING.tapMs) return;
    const s = this.env.settings();
    if (s.noFinger) return;
    if (g.maxFingers === 2 && s.gestures.undoTap) {
      void this.sink.undo();
      if (s.undoBadge) this.view.undoBadge("undo");
    } else if (g.maxFingers === 3 && s.gestures.redoTap) {
      void this.sink.redo();
      if (s.undoBadge) this.view.undoBadge("redo");
    } else if (g.maxFingers === 4 && s.gestures.toolsTap) this.view.toggleTools();
  }

  /** 取り上げる（§5-5 の 14）: 線はそこまでで確定・ジェスチャーはそこまでで止める・ボタンは押したことにしない・残りは捨てる */
  private takeAway(c: Contact) {
    switch (c.role) {
      case "stroke":
        if (this.penWait && this.penWait.id === c.id) this.penWait.end = c.last;
        else if (c.last) this.endStroke(c, c.last);
        break;
      case "pending":
        c.held = [];
        break;
      case "gesture":
        this.gestureFingerUp(c, true, Infinity);
        break;
      case "ui":
        this.view.uiCancel(c.id);
        break;
      case "pan":
        this.endPan(c);
        break;
    }
    if (c.kind === "pen" && this.penId === c.id) this.penId = null;
    c.role = "ignored";
    this.contacts.delete(c.id);
  }

  // ---------------- 手のひらの取り消しの待ち ----------------

  private flushPenWait() {
    const w = this.penWait;
    if (!w) return;
    this.penWait = null;
    const [first, ...rest] = w.samples;
    this.sink.strokeBegin(first);
    if (rest.length) this.sink.strokeMove(rest);
    const c = this.contacts.get(w.id);
    if (w.end || !c || c.role !== "stroke") {
      this.sink.strokeEnd(w.end ?? w.samples[w.samples.length - 1]);
      this.strokeId = null;
      this.setDrawing(false);
    }
  }

  private flushPenWaitAsEnded() {
    // 裏に回るときに待ちが残っていれば、描き始めはせず控えを捨てる（取り消しはもう走っている）
    if (this.penWait) {
      this.penWait = null;
      this.strokeId = null;
      this.setDrawing(false);
    }
  }

  // ---------------- 時計 ----------------

  private runTimers(now: number) {
    const s = this.env.settings();
    for (const c of [...this.contacts.values()]) {
      // 指で描く: 控えの時間を過ぎた
      if (c.role === "pending" && now - c.t0 >= INPUT_TUNING.fingerHoldMs) this.startFingerStroke(c);
      // 長押しのスポイト（ペン・指で描くときの指。マウスは数えない＝§5-5 の 15）
      if (
        c.role === "stroke" &&
        c.longPressArmed &&
        c.kind !== "mouse" &&
        this.strokeId === c.id &&
        !this.penWait &&
        s.gestures.longPress &&
        now - c.t0 >= s.longPressMs &&
        c.moved <= INPUT_TUNING.longPressSlopPt
      ) {
        this.longPress(c);
      }
    }
  }

  /** ★長押しのスポイト（決-14・§5-7）: その接触の線をやめる口で消してから、その場の色を 1 回拾う。そのあと離すまでは使わない */
  private longPress(c: Contact) {
    const at = c.last ?? c.held[0];
    const pt = { x: Math.min(319, Math.max(0, Math.floor(at.x))), y: Math.min(239, Math.max(0, Math.floor(at.y))) };
    this.clearPredicted();
    const r = this.sink.strokeCancel();
    let wait: void | Promise<void> = undefined;
    if (r === "asleep") {
      // 戻せなかった（そのコマが眠った）: 確定して、その接触で積まれていれば取り消す（積まれていなければ何もしない）
      const pushed = this.sink.strokeEnd(at);
      if (pushed) wait = this.sink.undo() ?? undefined;
    }
    this.strokeId = null;
    this.setDrawing(false);
    c.role = "ignored";
    if (wait) {
      const w = Promise.resolve(wait).then(() => this.sink.pickColor(pt));
      this.waits.push(w);
    } else this.sink.pickColor(pt);
  }
}
