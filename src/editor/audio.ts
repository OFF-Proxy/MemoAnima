// M6-2 音声サブシステム → M5-1 で複数トラック（BGM+SE）対応に拡張
// - kwz由来PCM の WAV 化（.animemo 埋め込み用）
// - プレビュー再生（BGM=速度連動 playbackRate・SE=コマ発火。エディタ/ライブラリ共用）
// - MP4書き出し用の最終ミックス（OfflineAudioContext で1本にレンダリング）
//   ミックスの尺・SE時刻・rate の計算は純関数 computeMixPlan に分離（m5_smoke で機械検証）

import { FPS_TABLE, type BgmTrack, type SeTrack } from "./model";
import type { ExportAudio } from "./exporter";
import { t } from "../i18n";

/** Int16 PCM → WAV バイト列（44byteヘッダ＋PCM・16bit）。channels>1 はインターリーブ済みを渡す */
export function pcmS16ToWav(
  pcm: Int16Array,
  sampleRate: number,
  channels: number
): Uint8Array {
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true); // fmt チャンクサイズ
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true); // byteRate
  v.setUint16(32, channels * 2, true); // blockAlign
  v.setUint16(34, 16, true); // bits
  writeStr(36, "data");
  v.setUint32(40, dataSize, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** ファイル拡張子から mime（対応: mp3/wav/ogg） */
export function mimeFromExt(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    default:
      return null;
  }
}

/** バイト列をデコードして AudioBuffer を得る（duration算出＆プレビュー用） */
export async function decodeAudio(bytes: Uint8Array): Promise<AudioBuffer> {
  const ctx = sharedCtx();
  // decodeAudioData はバッファを破壊し得るためコピーを渡す
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return await ctx.decodeAudioData(ab);
}

let _ctx: AudioContext | null = null;
function sharedCtx(): AudioContext {
  if (!_ctx) _ctx = new AudioContext();
  return _ctx;
}

/** 共有 AudioContext（波形パネルの試し再生などで使用） */
export function getAudioCtx(): AudioContext {
  return sharedCtx();
}

/** BGM の再生レート（速度連動・原作準拠のピッチ変化）。異常値は 1 に落とす */
export function bgmPlaybackRate(speedIndex: number, baseSpeedIndex: number): number {
  const cur = FPS_TABLE[speedIndex];
  const base = FPS_TABLE[baseSpeedIndex];
  if (!cur || !base || !isFinite(cur / base) || cur / base <= 0) return 1;
  return cur / base;
}

/** BGM のトリム正規化（プレビュー/書き出し共通規則。M6-2 踏襲） */
export function normalizeTrim(
  durSec: number,
  trimStartMs: number,
  trimEndMs: number | null
): { trimStartSec: number; trimEndSec: number; usableSec: number } {
  const trimStartSec = Math.max(0, Math.min(trimStartMs / 1000, Math.max(0, durSec - 0.05)));
  let trimEndSec = trimEndMs != null ? Math.min(trimEndMs / 1000, durSec) : durSec;
  if (trimEndSec <= trimStartSec) trimEndSec = durSec;
  return { trimStartSec, trimEndSec, usableSec: Math.max(0, trimEndSec - trimStartSec) };
}

/** M11-9: 発火中のSEノード1つ。一時停止で「どこまで鳴ったか」を出すため、
 *  素材（buf）・トラック（音量/ミュートを再開時に読む）・0秒地点（startedAt）を持つ */
interface SeNode {
  node: AudioBufferSourceNode;
  gain: GainNode;
  buf: AudioBuffer;
  track: SeTrack | null;
  /** ctx.currentTime 基準の「このSEの 0秒地点」。途中から鳴らした場合は offset を引いてある */
  startedAt: number;
}

/**
 * .animemo プレビューの音声再生（エディタ／ライブラリで各1インスタンス）。
 * 完全なフレーム精度同期は不要（開始タイミングを合わせる程度・handoff §6）。
 */
export class AudioPreview {
  private cacheFor: BgmTrack | null = null;
  private buffer: AudioBuffer | null = null;
  private node: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** start/stop の競合ガード（decode await 中の stop 後に遅延再生しない） */
  private seq = 0;
  /** restart 用に直近の再生パラメータを保持 */
  private lastTrack: BgmTrack | null = null;
  private lastRate = 1;
  /** M5-1: SE の decode キャッシュ（トラック実体キー。invalidate でクリア） */
  private seCache = new Map<SeTrack, AudioBuffer>();
  /** M11-1: 発火中のSEノード。SEは多重発火するので単一参照ではなく集合で持つ。
   *  playSeBuffer で登録し、onended（自然終了・stopSe 由来の両方）で登録解除する。
   *  これが無いと発火済みSEを止める手段が無く、一時停止しても最後まで鳴り切っていた */
  private seNodes = new Set<SeNode>();
  /** M11-1: SEの停止世代。decode 待ちの間に stopSe() が走ったらその発火は捨てる
   *  （BGM の seq と同じ考え方。SE専用にして BGM の start/stop とは干渉させない） */
  private seEpoch = 0;
  /** M11-9: 一時停止で畳んだSEの「続き」。resumeSe() で offset から鳴らし直す。
   *  stopSe()（＝完全な停止）では捨てる＝続きは残さない */
  private sePaused: { buf: AudioBuffer; track: SeTrack | null; offset: number }[] = [];

  /** トラック変更（差し替え/削除/適用）時に呼ぶ */
  invalidate() {
    this.stop();
    this.cacheFor = null;
    this.buffer = null;
    this.lastTrack = null;
    this.seCache.clear();
  }

  /**
   * BGM再生開始。startFrameSec = 再生開始フレームの位置（アニメ時間・秒）。
   * rate = FPS_TABLE[現在speedIndex]/FPS_TABLE[baseSpeedIndex]（M5-1 速度連動・ピッチも変わる）。
   * M6-3 統一仕様: 音は**ワンショット**（トリム区間を1回）。アニメがループで先頭に
   * 戻るたびに呼び出し側が restart() を呼び、頭出しから鳴り直す（モード共通・書き出し不変）。
   */
  async start(track: BgmTrack | null | undefined, startFrameSec: number, rate = 1) {
    // M11-9: 鳴っているSEは止めるが、**畳んだ続き（sePaused）には触れない**。
    // ループ折り返しの restart() で前の周回を切る挙動（M11-1）はそのまま、
    // かつ ⏸→▶ の再開で startPlayback → start() → resumeSe() の順に呼べるようにするため
    this.stopBgm();
    this.killLiveSe();
    this.lastTrack = track ?? null;
    this.lastRate = rate;
    if (!track || track.muted) return;
    const mySeq = ++this.seq;
    try {
      const ctx = sharedCtx();
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      if (this.cacheFor !== track || !this.buffer) {
        const buf = await decodeAudio(track.data);
        if (mySeq !== this.seq) return; // decode 中に stop/再start された
        this.buffer = buf;
        this.cacheFor = track;
      }
      if (mySeq !== this.seq) return;
      const { trimStartSec, trimEndSec, usableSec } = normalizeTrim(
        this.buffer.duration,
        track.trimStartMs,
        track.trimEndMs
      );
      if (usableSec <= 0) return;
      const node = ctx.createBufferSource();
      node.buffer = this.buffer;
      node.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, track.volume));
      node.connect(gain);
      gain.connect(ctx.destination);
      // アニメ時間 startFrameSec ぶん進んだ位置 = バッファ時間では rate 倍進む
      const offset = trimStartSec + Math.min(usableSec, Math.max(0, startFrameSec * rate));
      node.start(0, offset, Math.max(0, trimEndSec - offset));
      this.node = node;
      this.gain = gain;
    } catch {
      // デコード不可・自動再生制限などは無音で続行（プレビューは補助機能）
    }
  }

  /** A-1: アニメが先頭へループした瞬間に呼ぶ（stop→頭出しから再スタート。decode/rateは使い回し） */
  restart() {
    // M11-1: BGMがある場合は start() の先頭の stop() が SE もまとめて止める。
    // BGMが無い作品はここで早期 return するため SE が止まらず、周回ごとに重なっていた
    // （BGMの有無で折り返しの挙動が変わらないように、明示的に止める）
    if (!this.lastTrack) {
      this.stopSe();
      return;
    }
    void this.start(this.lastTrack, 0, this.lastRate);
  }

  stop() {
    this.stopBgm();
    // M11-1: 発火済みSEも一緒に止める（BGMだけ止めても効果音が鳴り切ってしまう症状の修正）
    // M11-9: 完全な停止なので「続き」も捨てる
    this.stopSe();
  }

  /** BGM だけ止める（SEには触れない） */
  private stopBgm() {
    this.seq++;
    try {
      this.node?.stop();
    } catch {
      /* noop */
    }
    try {
      this.node?.disconnect();
      this.gain?.disconnect();
    } catch {
      /* noop */
    }
    this.node = null;
    this.gain = null;
  }

  /** M11-1: 鳴っているSEノードを止める（BGMにも「続き」にも触れない）。
   *  seEpoch を進めるので、decode 待ちだった発火もここで捨てられる */
  private killLiveSe() {
    this.seEpoch++;
    // stop() 由来の onended が集合を触るので、反復はコピーに対して行う
    const fired = [...this.seNodes];
    this.seNodes.clear();
    for (const e of fired) {
      try {
        e.node.stop();
      } catch {
        /* noop */
      }
      try {
        e.node.disconnect();
        e.gain.disconnect();
      } catch {
        /* noop */
      }
    }
    return fired;
  }

  /** M11-1: 発火中のSEを全部止める（BGMには触れない）。
   *  停止・コマ移動・SEの編集・パネルを閉じる・エディタを離れる、から呼ぶ。stop() からも呼ばれる。
   *  M11-9: **続きは捨てる**（一時停止したいときは pauseSe() を使う） */
  stopSe() {
    this.killLiveSe();
    this.sePaused = [];
  }

  /** M11-9: 一時停止。鳴っているSEを「どこまで鳴ったか」つきで畳む。
   *  resumeSe() を呼ぶまで音は止まったまま。stopSe() を挟むと続きは捨てられる */
  pauseSe() {
    const ctx = _ctx;
    const fired = this.killLiveSe();
    if (!ctx) return;
    for (const e of fired) {
      // 経過時間 = いまの時刻 - このノードの「0秒地点」。start(0, offset) で始めたものは
      // startedAt に offset を引いた値を入れてあるので、**繰り返しても累積しない**
      const played = ctx.currentTime - e.startedAt;
      if (!isFinite(played) || played < 0) continue;
      if (played >= e.buf.duration) continue; // 鳴り終わっている＝続きは無い
      this.sePaused.push({ buf: e.buf, track: e.track, offset: played });
    }
  }

  /** M11-9: 一時停止したSEを続きから鳴らす。**続きから鳴らしたトラックの id** を返す
   *  （呼び出し側が「開始コマのSE」を二重に鳴らさないために使う）。
   *  音量・ミュートは**再開時点の**トラックの値を読む */
  resumeSe(): string[] {
    const pending = this.sePaused;
    this.sePaused = [];
    const ids: string[] = [];
    for (const p of pending) {
      if (p.offset >= p.buf.duration) continue; // 長さを超えていたら鳴らさない
      if (p.track?.muted) continue; // 一時停止中にミュートされた
      this.playSeBuffer(p.buf, p.track, p.offset);
      if (p.track) ids.push(p.track.id);
    }
    return ids;
  }

  /** M11-9: 畳んである「続き」だけを捨てる（鳴っている音には触れない）。
   *  SEの編集（差し替え・削除・ミュート・配置換え）から呼ぶ＝消えた音源の続きが後から鳴らないように */
  discardPausedSe() {
    this.sePaused = [];
  }

  /** M11-9: 一時停止（⏸）。BGM は止める（▶ で現在のコマ位置から鳴り直す＝従来どおり）。
   *  SE だけ「続き」を残す。再開側は start() のあとに resumeSe() を呼ぶ */
  pause() {
    this.stopBgm();
    this.pauseSe();
  }

  /** M5-1: SE の decode キャッシュを温める（再生開始時に呼ぶと初回発火が遅れない） */
  async prepareSe(tracks: SeTrack[]) {
    for (const t of tracks) {
      if (this.seCache.has(t)) continue;
      try {
        const buf = await decodeAudio(t.data);
        this.seCache.set(t, buf);
      } catch {
        /* 壊れたSEは鳴らさないだけ（プレビューは補助機能） */
      }
    }
  }

  /** M5-1: SE を即時発火（使い捨てノード・多重可・volume/muted 反映）。
   *  未デコードなら非同期デコード後に発火（初回のみわずかに遅れ得る・以後キャッシュ） */
  fireSe(track: SeTrack) {
    if (track.muted) return;
    const cached = this.seCache.get(track);
    if (cached) {
      this.playSeBuffer(cached, track);
      return;
    }
    const myEpoch = this.seEpoch;
    void decodeAudio(track.data)
      .then((buf) => {
        this.seCache.set(track, buf);
        // M11-1: decode 待ちの間に停止（一時停止など）されていたら、もう鳴らさない
        if (myEpoch !== this.seEpoch) return;
        if (!track.muted) this.playSeBuffer(buf, track);
      })
      .catch(() => {});
  }

  /** SE を1回鳴らす。offset>0 なら途中から（M11-9 の一時停止からの再開）。
   *  SE は速度連動しない（playbackRate は既定の 1 のまま＝既存仕様） */
  private playSeBuffer(buf: AudioBuffer, track: SeTrack | null, offset = 0) {
    try {
      const ctx = sharedCtx();
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, track ? track.volume : 1));
      node.connect(gain);
      gain.connect(ctx.destination);
      // M11-1: 停止できるよう集合で保持する（登録は start 成功後＝例外時に集合へ残さない）
      // M11-9: 一時停止で「どこまで鳴ったか」を出せるよう、素材と 0秒地点も持たせる。
      // startedAt から offset を引いておくので、一時停止と再開を繰り返しても経過が累積しない
      const entry: SeNode = {
        node,
        gain,
        buf,
        track,
        startedAt: ctx.currentTime - offset,
      };
      node.onended = () => {
        this.seNodes.delete(entry); // stopSe 由来の終了でも安全（delete は冪等）
        try {
          node.disconnect();
          gain.disconnect();
        } catch {
          /* noop */
        }
      };
      node.start(0, Math.max(0, Math.min(offset, buf.duration)));
      this.seNodes.add(entry);
    } catch {
      /* noop */
    }
  }
}

// ---------------- M5-1: MP4 書き出し用の最終ミックス ----------------

/** ミックス仕様（書き出し範囲適用済み。frameSe は範囲先頭起点） */
export interface ExportMixSpec {
  bgm: BgmTrack | null;
  se: SeTrack[];
  /** 書き出す各コマの SE id 群（undefined=なし）。長さ=書き出しコマ数 */
  frameSe: (string[] | undefined)[];
  fps: number;
  /** 現在の速度段階（BGM rate 算出用） */
  speedIndex: number;
  syncMode: "audioToAnim" | "animToAudio";
  /** M10-11: 書き出し範囲の先頭コマが**作品先頭から何秒か**（アニメ時間軸）。全範囲なら 0。
   *  これが無いと範囲書き出しで BGM が常に曲の頭から鳴る（SE は frameSe が
   *  範囲先頭起点なので元から正しい）。**必須**にして全呼び出し元で明示する。 */
  rangeStartSec: number;
}

/** ミックスの実行計画（時刻・尺・rate）。レンダと独立の純関数＝m5_smoke で機械検証する */
export interface MixPlan {
  outDurSec: number;
  /** null=BGMなし（無い/ミュート/デコード不能） */
  bgm: {
    rate: number;
    trimStartSec: number;
    trimEndSec: number;
    usableSec: number;
    /** audioToAnim=尺までループ / animToAudio=1回 */
    loop: boolean;
    volume: number;
    /** M10-11: 音源のどこから鳴らし始めるか（バッファ時間・秒）。
     *  範囲書き出しで「全体を書き出して切り取ったもの」と同じ音にするための開始位置。 */
    offsetSec: number;
  } | null;
  /** SE発火イベント（seトラックid・出力時刻）。animToAudio でアニメが n 周する場合は毎周分 */
  seEvents: { id: string; atSec: number }[];
}

/**
 * ミックス計画を立てる（純関数）。bgmDurSec は BGM 音源のデコード済み全長（無ければ null）。
 * 尺の規則は M6-2 踏襲: audioToAnim=アニメ尺 / animToAudio=（トリム後の曲尺）/rate。
 */
export function computeMixPlan(
  spec: ExportMixSpec,
  bgmDurSec: number | null,
  decodedSeIds: Set<string>
): MixPlan {
  const fps = spec.fps > 0 ? spec.fps : 8;
  const frameCount = spec.frameSe.length;
  const animDurSec = Math.max(0.05, frameCount / fps);
  let bgm: MixPlan["bgm"] = null;
  if (spec.bgm && !spec.bgm.muted && bgmDurSec != null && bgmDurSec > 0) {
    const rate = bgmPlaybackRate(spec.speedIndex, spec.bgm.baseSpeedIndex);
    const { trimStartSec, trimEndSec, usableSec } = normalizeTrim(
      bgmDurSec,
      spec.bgm.trimStartMs,
      spec.bgm.trimEndMs
    );
    if (usableSec > 0) {
      const loop = spec.syncMode === "audioToAnim";
      // M10-11: 範囲書き出しの開始位置。
      // audioToAnim は書き出し全体で BGM がトリム区間をループしているので、
      // 範囲先頭までに進んだバッファ時間 (rangeStartSec * rate) を usableSec で
      // 剰余する（範囲先頭が2周目以降に当たっても正しい位置になる）。
      // animToAudio は曲がマスターで範囲はコマ側の都合なので、音は動かさない。
      // どちらも rangeStartSec = 0 なら offsetSec = trimStartSec ＝ 従来と完全一致。
      const offsetSec = loop
        ? trimStartSec + ((Math.max(0, spec.rangeStartSec) * rate) % usableSec)
        : trimStartSec;
      bgm = {
        rate,
        trimStartSec,
        trimEndSec,
        usableSec,
        loop,
        volume: Math.max(0, Math.min(1, spec.bgm.volume)),
        offsetSec,
      };
    }
  }
  // 出力尺: animToAudio かつ BGMあり → 曲（トリム後を rate 再生した実時間）。それ以外はアニメ尺
  const outDurSec =
    spec.syncMode === "animToAudio" && bgm
      ? Math.max(0.05, bgm.usableSec / bgm.rate)
      : animDurSec;
  // SEイベント: コマ時刻 = i/fps（範囲先頭起点）。animToAudio でアニメが繰り返す場合は毎周
  const seById = new Map(spec.se.map((s) => [s.id, s]));
  const loops = spec.syncMode === "animToAudio" ? Math.ceil(outDurSec / animDurSec) : 1;
  const seEvents: { id: string; atSec: number }[] = [];
  for (let k = 0; k < loops; k++) {
    for (let i = 0; i < frameCount; i++) {
      const ids = spec.frameSe[i];
      if (!ids) continue;
      const at = k * animDurSec + i / fps;
      if (at >= outDurSec - 1e-6) continue;
      for (const id of ids) {
        const t = seById.get(id);
        if (!t || t.muted || !decodedSeIds.has(id)) continue;
        seEvents.push({ id, atSec: at });
      }
    }
  }
  return { outDurSec, bgm, seEvents };
}

const MIX_SAMPLE_RATE = 48000;
/** レンダ尺の上限（Codex指摘#3: 長尺 animToAudio の Float32 レンダバッファ＋WAV の
 *  同時保持でメモリが膨らむため）。20分 ≒ 48000Hz×2ch×4byte×1200s ≒ 460MB が実用上限 */
export const MAX_MIX_DURATION_SEC = 1200;

/** AudioBuffer（レンダ結果）→ 16bit ステレオ WAV */
function audioBufferToWav(buf: AudioBuffer): Uint8Array {
  const ch = Math.min(2, buf.numberOfChannels) as 1 | 2;
  const n = buf.length;
  const out = new Int16Array(n * ch);
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, src[i]));
      out[i * ch + c] = (v < 0 ? v * 32768 : v * 32767) | 0;
    }
  }
  return pcmS16ToWav(out, buf.sampleRate, ch);
}

/**
 * 最終ミックスを OfflineAudioContext で1本にレンダリングする（MP4書き出し用）。
 * 可聴トラックが何もなければ null（呼び出し側は従来の無音経路へ）。
 */
export async function renderExportMix(spec: ExportMixSpec): Promise<ExportAudio | null> {
  // デコード（壊れたトラックはスキップ＝隔離）
  let bgmBuf: AudioBuffer | null = null;
  if (spec.bgm && !spec.bgm.muted) {
    try {
      bgmBuf = await decodeAudio(spec.bgm.data);
    } catch {
      bgmBuf = null;
    }
  }
  // 使う（配置があり非ミュートの）SEだけデコード
  const usedIds = new Set<string>();
  for (const ids of spec.frameSe) for (const id of ids ?? []) usedIds.add(id);
  const seBufs = new Map<string, AudioBuffer>();
  for (const t of spec.se) {
    if (t.muted || !usedIds.has(t.id)) continue;
    try {
      seBufs.set(t.id, await decodeAudio(t.data));
    } catch {
      /* 壊れたSEはスキップ */
    }
  }
  const plan = computeMixPlan(spec, bgmBuf ? bgmBuf.duration : null, new Set(seBufs.keys()));
  if (!plan.bgm && plan.seEvents.length === 0) return null; // 全ミュート/音なし → 無音経路
  if (plan.outDurSec > MAX_MIX_DURATION_SEC) {
    throw new Error(
      t("ed.audio.mixTooLong.msg", {
        min: Math.round(plan.outDurSec / 60),
        max: MAX_MIX_DURATION_SEC / 60,
      })
    );
  }
  const ctx = new OfflineAudioContext(
    2,
    Math.max(1, Math.ceil(plan.outDurSec * MIX_SAMPLE_RATE)),
    MIX_SAMPLE_RATE
  );
  if (plan.bgm && bgmBuf) {
    const node = ctx.createBufferSource();
    node.buffer = bgmBuf;
    node.playbackRate.value = plan.bgm.rate;
    const gain = ctx.createGain();
    gain.gain.value = plan.bgm.volume;
    node.connect(gain);
    gain.connect(ctx.destination);
    if (plan.bgm.loop) {
      // audioToAnim: トリム区間をループして尺まで（レンダ長で自然に打ち切り）
      node.loop = true;
      node.loopStart = plan.bgm.trimStartSec;
      node.loopEnd = plan.bgm.trimEndSec;
      // M10-11: 範囲書き出しでは曲の頭ではなく「範囲先頭に対応する位置」から鳴らす
      node.start(0, plan.bgm.offsetSec);
    } else {
      // animToAudio: 1回だけ（offset/duration はバッファ時間）
      node.start(0, plan.bgm.trimStartSec, plan.bgm.usableSec);
    }
  }
  for (const ev of plan.seEvents) {
    const buf = seBufs.get(ev.id);
    const track = spec.se.find((s) => s.id === ev.id);
    if (!buf || !track) continue;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, track.volume));
    node.connect(gain);
    gain.connect(ctx.destination);
    node.start(ev.atSec);
  }
  const rendered = await ctx.startRendering();
  return {
    wav: audioBufferToWav(rendered),
    durationSec: plan.outDurSec,
    syncMode: spec.syncMode,
  };
}
