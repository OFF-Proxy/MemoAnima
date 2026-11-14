// V225 (M-2c・UI §6-3・§6-6・指示書 ■3 の L-4): ライブラリの再生（選んだ作品を読んで、共通の部品で再生する）。
//
// ★§5-0 の一時的な写し（PC の src/library.ts は Mac の作業では変えられない。次の Windows の作業で共通へ移す）:
//    元: src/library.ts の startPreview・stopPreview・drawPreview・prewakePreview・inPreviewWindow・sleepIfOutside・trimPreviewWindow・
//        songModeWanted・dropPreviewLap（2005〜2217）と、▶ を押したときの始めのコマ（playStartFrame を呼ぶ所）
//    写した所: このファイルの LibraryPreview（start・stop・draw・prewake・inWindow・sleepIfOutside・trimWindow）
//    比べ方: scripts/v225_smoke.ts [L]（時計は共通の PlayClock そのもの・始めの時刻は startTimeOf・始めのコマは playStartFrame・
//            窓の決まり inWindow を PC の本文と同じ入力で比べる）
// ★使う共通の部品: compositeFrame・PlayClock（playClock.ts）・AudioPreview（audio.ts）・wakeFrame／sleepFrame（sleep.ts）。
// ★作品は変えない（履歴・オートセーブ・保存に触らない）。ループと音の切り替えは、読んだ写しの上だけ（保存しない）。
// ★メモリ: 見ていないコマは眠らせる窓で持つ（先 8・後ろ 9）。別の作品を選ぶ・描く画面を開く前に drop() で手放す。
// ★止めている間は時計もタイマーも動かさない（何もしていない間に描き直さない）。
import { FPS_TABLE, type Frame, type Project, type SeTrack } from "../../editor/model";
import { compositeFrame, presentToCanvas } from "../../editor/render";
import { playStartFrame } from "../../editor/playStart";
import { PlayClock, startTimeOf, type BgmPlan, type PlayHost } from "../../editor/playClock";
import { wakeFrame, sleepFrame, frameHasAsleep } from "../../editor/sleep";
import { AudioPreview, bgmPlaybackRate, normalizeTrim } from "../../editor/audio";

/** 先回りして起こすコマの数（PC の PREVIEW_AHEAD） */
export const PREVIEW_AHEAD = 8;

/** ★窓の中か（PC の inPreviewWindow と同じ決まり）: いまのコマの後ろ AHEAD＋1〜先 AHEAD（端はつながる）。小さい作品は全部が中 */
export function inPreviewWindow(i: number, cur: number, n: number): boolean {
  if (n <= PREVIEW_AHEAD * 2 + 2) return true;
  const d = (((i - cur) % n) + n) % n;
  return d <= PREVIEW_AHEAD || d >= n - (PREVIEW_AHEAD + 1);
}

/** 「曲の長さで書き出す」で BGM がある形か（PC の songModeWanted） */
export function songModeWanted(pp: Project): boolean {
  const b = pp.audio?.bgm;
  return !!b && !b.muted && b.syncMode === "animToAudio";
}

/** 控えのあるレイヤーが起きているコマか（PC の awakeWithCopy） */
function awakeWithCopy(f: Frame): boolean {
  if (!f.sleep) return false;
  for (const id of Object.keys(f.sleep)) if (f.layers[id]) return true;
  return false;
}

export interface PreviewView {
  /** 絵を描く canvas（320×240・表示の大きさは CSS）。全画面のときは別の canvas を返す */
  canvas(): HTMLCanvasElement | null;
  /** 再生・コマ・ループ・音が変わった（ボタンとつまみを直す） */
  changed(): void;
}

export class LibraryPreview {
  private pp: Project | null = null;
  private frame = 0;
  private playing = false;
  private gen = 0;
  private clock: PlayClock | null = null;
  private audio = new AudioPreview();
  private muted = false;
  private resume: { pp: Project; frame: number; t: number; fps: number; n: number } | null = null;
  private prewakeAt: { pp: Project; at: number } | null = null;
  /** つまみを引いている間（PC の seekDrag）: 起こすのは 1 つずつ・先回りはしない */
  private dragging = false;
  private seekWaking = false;
  /** 曲の長さの形で、曲の終わりで止まった所（PC の previewEnded）。コマを動かさずに ▶ なら頭から */
  private ended: { pp: Project; frame: number } | null = null;
  /** 描き直した数（検査と確かめ画面: 止めている 1 分間に増えない） */
  paints = 0;

  constructor(private view: PreviewView) {}

  project(): Project | null {
    return this.pp;
  }
  frameIndex(): number {
    return this.frame;
  }
  frameCount(): number {
    return this.pp?.frames.length ?? 0;
  }
  fps(): number {
    return this.pp ? FPS_TABLE[this.pp.speedIndex] || 8 : 0;
  }
  isPlaying(): boolean {
    return this.playing;
  }
  isMuted(): boolean {
    return this.muted;
  }
  loop(): boolean {
    return !!this.pp?.loop;
  }
  hasSound(): boolean {
    const a = this.pp?.audio;
    return !!a && ((!!a.bgm && !a.bgm.muted) || a.se.some((s) => !s.muted));
  }
  /** 起きているコマの数（検査用） */
  awakeCount(): number {
    return this.pp?.frames.filter((f) => awakeWithCopy(f)).length ?? 0;
  }

  /** 作品を入れる（前の再生と作品は手放す）。先頭のコマを描く */
  show(pp: Project): void {
    this.drop();
    this.pp = pp;
    this.frame = 0;
    this.draw();
    this.view.changed();
  }

  /** ★手放す（別の作品を選ぶ・描く画面を開く前・ライブラリを離れる）。再生と音を止め、読んだ作品への参照を捨てる */
  drop(): void {
    this.stop();
    this.audio.invalidate();
    this.pp = null;
    this.frame = 0;
    this.resume = null;
    this.prewakeAt = null;
    this.ended = null;
    this.dragging = false;
    this.seekWaking = false;
  }

  /** つまみを引き始めた／離した（離したら、今の位置の先回りをやり直す） */
  setDragging(on: boolean): void {
    if (this.dragging === on) return;
    this.dragging = on;
    if (!on) {
      this.seekWaking = false;
      this.draw();
    }
  }

  /** ★サムネのための絵（コマが眠っていれば起こしてから。眠ったまま描くと紙だけの絵になる）。作品を替えていたら null */
  async thumbBlob(make: (pp: Project, index: number) => Promise<Blob | null>): Promise<Blob | null> {
    const pp = this.pp;
    if (!pp) return null;
    const i = Math.max(0, Math.min(pp.frames.length - 1, pp.thumbFrame ?? 0));
    const f = pp.frames[i];
    if (!f) return null;
    if (frameHasAsleep(f)) await wakeFrame(pp, f, "read");
    if (this.pp !== pp || frameHasAsleep(f)) return null;
    const blob = await make(pp, i);
    this.sleepIfOutside(pp, i);
    return this.pp === pp ? blob : null;
  }

  /** いまのコマを描く（眠っていれば起こしてから。PC の drawPreview） */
  draw(): void {
    const pp = this.pp;
    if (!pp) return;
    const cur = pp.frames[this.frame];
    if (cur && frameHasAsleep(cur)) {
      const at = this.frame;
      // つまみを引いている間は、起こしている途中なら新しく起こさない（終わったときに今の位置を起こす＝PC の V204）
      if (this.dragging && this.seekWaking) return;
      this.seekWaking = this.dragging;
      void wakeFrame(pp, cur, "read").then(
        () => {
          this.seekWaking = false;
          if (this.pp === pp && this.frame === at) this.draw();
          else {
            this.sleepIfOutside(pp, at);
            if (this.dragging && this.pp === pp) this.draw(); // 待たせていた今の位置を起こす
          }
        },
        () => {
          this.seekWaking = false;
        }
      );
      this.prewake();
      return;
    }
    this.prewake();
    const cv = this.view.canvas();
    if (!cv) return;
    presentToCanvas(compositeFrame(pp, this.frame), cv);
    cv.classList.toggle("mb-paper-clear", pp.frames[this.frame]?.paper === 0);
    this.paints++;
  }

  /** 先回りして起こし、通り過ぎたコマを只で眠らせ直す（PC の prewakePreview） */
  private prewake(): void {
    const pp = this.pp;
    if (!pp) return;
    const n = pp.frames.length;
    for (let k = 1; !this.dragging && k <= PREVIEW_AHEAD; k++) {
      const i = (this.frame + k) % n;
      const f = pp.frames[i];
      if (f && frameHasAsleep(f)) void wakeFrame(pp, f, "read").then(() => this.sleepIfOutside(pp, i), () => undefined);
    }
    if (n <= PREVIEW_AHEAD * 2 + 2) return;
    const behind = pp.frames[(this.frame - PREVIEW_AHEAD - 1 + n) % n];
    if (behind) void sleepFrame(pp, behind, undefined, true);
    const ahead = pp.frames[(this.frame + PREVIEW_AHEAD + 1) % n];
    if (ahead) void sleepFrame(pp, ahead, undefined, true);
    const last = this.prewakeAt;
    this.prewakeAt = { pp, at: this.frame };
    if (last && last.pp === pp && Math.min((this.frame - last.at + n) % n, (last.at - this.frame + n) % n) > 1) this.trimWindow();
  }

  private sleepIfOutside(pp: Project, i: number): void {
    if (this.pp !== pp || inPreviewWindow(i, this.frame, pp.frames.length)) return;
    const f = pp.frames[i];
    if (f) void sleepFrame(pp, f, undefined, true);
  }

  /** 飛んだあと、窓の外で起きているコマを只で眠らせ直す（PC の trimPreviewWindow） */
  private trimWindow(): void {
    const pp = this.pp;
    if (!pp || pp.frames.length <= PREVIEW_AHEAD * 2 + 2) return;
    pp.frames.forEach((f, i) => {
      if (awakeWithCopy(f) && !inPreviewWindow(i, this.frame, pp.frames.length)) void sleepFrame(pp, f, undefined, true);
    });
  }

  /** コマへ飛ぶ（つまみ・先頭へ・前・次）。再生中なら、その位置から続ける */
  seek(i: number): void {
    const pp = this.pp;
    if (!pp) return;
    const n = pp.frames.length;
    const to = Math.max(0, Math.min(n - 1, i));
    const was = this.playing;
    if (was) this.stop();
    this.frame = to;
    this.resume = null;
    this.ended = null;
    this.draw();
    this.view.changed();
    if (was) void this.start();
  }
  step(d: number): void {
    const n = this.frameCount();
    if (n <= 0) return;
    if (this.playing) this.stop(true);
    this.frame = (((this.frame + d) % n) + n) % n;
    this.resume = null;
    this.ended = null;
    this.draw();
    this.view.changed();
  }

  /** ▶ ⇄ 止める（▶ は、ループしない作品の最後のコマなら先頭から＝PC と同じ playStartFrame） */
  toggle(): void {
    const pp = this.pp;
    if (!pp) return;
    if (this.playing) {
      this.stop(true);
      return;
    }
    // 曲の長さの形（アニメは最後のコマのあとも続く）では playStartFrame を使わない。曲の終わりで止まったあと、コマを動かさずに ▶ なら頭から（PC の V209）
    const e = this.ended;
    const from = songModeWanted(pp) ? (e && e.pp === pp && e.frame === this.frame ? 0 : this.frame) : playStartFrame(this.frame, pp.frames.length, pp.loop);
    if (from !== this.frame) {
      this.frame = from;
      this.resume = null;
      this.draw();
    }
    void this.start();
  }

  /** ループ（読んだ写しの上だけ・保存しない。時計が次の周の終わりで効かせる） */
  toggleLoop(): void {
    if (!this.pp) return;
    this.pp.loop = !this.pp.loop;
    this.view.changed();
  }

  /** 音を消す／戻す（ライブラリの中だけ・作品は変えない）。再生中なら、その位置から鳴らし直す */
  toggleMute(): void {
    this.muted = !this.muted;
    const was = this.playing;
    if (was) {
      this.stop(true);
      void this.start();
    }
    this.view.changed();
  }

  /** ★再生を始める（PC の startPreview: 音の用意を待ってからコマを進め始める・世代で古い start を捨てる） */
  async start(): Promise<void> {
    if (!this.pp || this.playing) return;
    const gen = ++this.gen;
    this.playing = true;
    this.view.changed();
    const pp = this.pp;
    const fps = FPS_TABLE[pp.speedIndex] || 8;
    const n = pp.frames.length;
    const bgm = this.muted ? null : (pp.audio?.bgm ?? null);
    const rate = bgm ? bgmPlaybackRate(pp.speedIndex, bgm.baseSpeedIndex) : 1;
    const song = !this.muted && songModeWanted(pp);
    const r = this.resume;
    const resumeOk = song && !!r && r.pp === pp && r.frame === this.frame && r.fps === fps && r.n === n;
    const t0 = resumeOk && r ? r.t : startTimeOf({ fps, frameCount: n }, this.frame);
    let se: SeTrack[] = [];
    if (!this.muted && pp.audio && pp.audio.se.length > 0) {
      const used = new Set<string>();
      for (const f of pp.frames) for (const id of f.se ?? []) used.add(id);
      se = pp.audio.se.filter((s) => !s.muted && used.has(s.id));
    }
    let prep: { bgm: AudioBuffer | null } = { bgm: null };
    try {
      prep = await this.audio.preparePlay(bgm, se);
    } catch {
      prep = { bgm: null }; // 音が用意できなくても、絵は再生する
    }
    if (gen !== this.gen || !this.playing || this.pp !== pp) return;
    this.resume = null;
    let plan: BgmPlan | null = null;
    if (bgm && prep.bgm) {
      const { trimStartSec, trimEndSec, usableSec } = normalizeTrim(prep.bgm.duration, bgm.trimStartMs, bgm.trimEndMs);
      if (usableSec > 0) plan = { buf: prep.bgm, trimStart: trimStartSec, trimEnd: trimEndSec, rate, volume: bgm.volume };
    }
    const muted = this.muted;
    const host: PlayHost = {
      shape: () => ({ fps, frameCount: n, loop: pp.loop }),
      show: (i) => {
        if (this.pp !== pp) return;
        this.frame = i;
        this.draw();
        this.view.changed();
      },
      ended: () => {
        const at = this.frame;
        this.stop();
        if (song && plan) this.ended = { pp, frame: at };
      },
      reshape: () => {
        this.stop();
        void this.start();
      },
      seAt: (i) => {
        const a = pp.audio;
        const ids = pp.frames[i]?.se;
        if (muted || !a || !ids) return [];
        const out: { buf: AudioBuffer; track: SeTrack }[] = [];
        for (const id of ids) {
          const tr = a.se.find((s) => s.id === id);
          const b = tr && !tr.muted ? this.audio.seBuffer(tr) : undefined;
          if (tr && b) out.push({ buf: b, track: tr });
        }
        return out;
      },
      bgm: () => plan,
    };
    const clock = new PlayClock(host, this.audio);
    this.clock = clock;
    clock.start({ t0, songMode: song && !!plan, wantAudio: !!plan || se.length > 0, resume: false });
    this.view.changed();
  }

  /** 止める（pause＝⏸。「曲の長さで書き出す」の形だけ何周目かを覚える＝PC の stopPreview） */
  stop(pause = false): void {
    this.gen++;
    const was = this.playing;
    this.playing = false;
    const clock = this.clock;
    this.clock = null;
    const pp = this.pp;
    if (pause && clock && pp && clock.shape().songSec != null) {
      const s = clock.shape();
      this.resume = { pp, frame: this.frame, t: clock.frameHead(), fps: s.fps, n: s.frameCount };
    } else if (!pause || clock) this.resume = null;
    clock?.stop();
    this.audio.stop();
    if (was) this.view.changed();
  }
}
