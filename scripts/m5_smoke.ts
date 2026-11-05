// M5-1 サウンド基盤 スモークテスト（データ層・Node実行）
// 1) v5 round-trip（bgm/se/配置/baseSpeedIndex/nextSeId 完全復元）
// 2) v3/v4 旧audio→bgm 可逆マイグレーション・v6拒否・壊れデータ隔離
// 3) .kwz 分離取込（実データ: トラック本数・コマ配置・PCM長・baseSpeedIndex）
// 4) computeMixPlan（尺・SE時刻・速度rate・ミュート/トリム規則）
// 5) frameClip の SE規則（同一メモ=保持／別メモ=未知SEは外れる）・cloneFrame/sanitizeAudio
// 6) .ppm の効果音の置き場所（合成・ライブラリ不要。期待は書いた旗のバイトから）
//  ※ 3) と 6) の効果音の置き場所の期待は、取り込み（getSoundEffectFlags の鍵 1〜4）と**別の口**から作る（V200 報告書 §7-1）
//
// 実行: npx tsx scripts/m5_smoke.ts <ライブラリパス（.kwz検証用・省略可）>

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  newProject,
  cloneFrame,
  sanitizeAudio,
  FPS_TABLE,
  PIXELS,
  SeTrack,
  BgmTrack,
} from "../src/editor/model";
import { projectToBytes, projectFromBytes, PROJECT_VERSION, PV5_VERSION } from "../src/editor/serialize";
import { computeMixPlan, ExportMixSpec, pcmS16ToWav } from "../src/editor/audio";
import { makeClip, buildFramesFromClip } from "../src/editor/frameClip";
import { setLang } from "../src/i18n";
// V176b: ログにライブラリのパスと作品名を出さないための伏せ字（src/library.ts と同じ道具）
import { importLogSafe, logSafeFileLabel } from "../src/gzname";

// M12-1a: 文言を pin しているので表示言語を ja に固定する（既定は環境依存の detectLang）
setLang("ja");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}

async function gzipJson(doc: unknown): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const blob = new Blob([new TextEncoder().encode(JSON.stringify(doc)) as unknown as BlobPart]);
  return new Uint8Array(await new Response(blob.stream().pipeThrough(cs)).arrayBuffer());
}

const wavBytes = (n: number) => pcmS16ToWav(new Int16Array(n).fill(1000), 16364, 1);

const mkBgm = (over: Partial<BgmTrack> = {}): BgmTrack => ({
  source: "external",
  mime: "audio/wav",
  data: wavBytes(16364),
  muted: false,
  volume: 0.8,
  trimStartMs: 100,
  trimEndMs: 900,
  syncMode: "audioToAnim",
  baseSpeedIndex: 6,
  name: "bgm.wav",
  ...over,
});
const mkSe = (id: string, over: Partial<SeTrack> = {}): SeTrack => ({
  id,
  name: `SE-${id}`,
  source: "external",
  mime: "audio/wav",
  data: wavBytes(4000),
  volume: 0.5,
  muted: false,
  ...over,
});

// ---- (1) v5 round-trip ----
{
  const p = newProject("v5rt");
  p.frames.push(cloneFrame(p.frames[0]), cloneFrame(p.frames[0]));
  p.audio = { bgm: mkBgm({ baseSpeedIndex: 4 }), se: [mkSe("S1"), mkSe("S2", { muted: true })] };
  p.nextSeId = 3;
  p.frames[0].se = ["S1"];
  p.frames[2].se = ["S1", "S2"];
  const p2 = await projectFromBytes(await projectToBytes(p));
  const b = p2.audio?.bgm;
  check(
    "v5 bgm往復（全フィールド）",
    !!b &&
      b.source === "external" &&
      b.volume === 0.8 &&
      b.trimStartMs === 100 &&
      b.trimEndMs === 900 &&
      b.baseSpeedIndex === 4 &&
      b.name === "bgm.wav" &&
      Buffer.compare(Buffer.from(b.data), Buffer.from(p.audio!.bgm!.data)) === 0
  );
  check(
    "v5 se往復（2本・meta・bytes）",
    p2.audio?.se.length === 2 &&
      p2.audio.se[0].id === "S1" &&
      p2.audio.se[1].muted === true &&
      p2.audio.se[1].volume === 0.5 &&
      Buffer.compare(Buffer.from(p2.audio.se[0].data), Buffer.from(p.audio!.se[0].data)) === 0
  );
  check(
    "v5 配置往復＋nextSeId",
    p2.frames[0].se?.join() === "S1" &&
      p2.frames[1].se === undefined &&
      p2.frames[2].se?.join() === "S1,S2" &&
      p2.nextSeId === 3
  );
  // V163: 旧形式の書き手（projectToBytes）は 5 のまま・現行形式（PV6）は 6
  check("v5 version定数（旧形式の書き手）", PV5_VERSION === 5);
  check("現行形式は v6", PROJECT_VERSION === 6);
}

// ---- (2) v3/v4 移行・v6拒否・壊れデータ隔離 ----
{
  const layer = new Uint8Array(PIXELS);
  const b64 = ((): string => {
    let bin = "";
    for (let i = 0; i < layer.length; i += 0x8000)
      bin += String.fromCharCode(...layer.subarray(i, i + 0x8000));
    return btoa(bin);
  })();
  const base = {
    magic: "ANIMEMO",
    width: 320,
    height: 240,
    colorTable: ["", "#141414"],
    layerDefs: [{ id: "L1", name: "A", visible: true, opacity: 1 }],
    speedIndex: 7,
    loop: true,
    colorMode: "palette",
    nextLayerId: 2,
    meta: { title: "old" },
    frames: [{ paper: 1, layers: { L1: b64 } }],
  };
  const oldAudio = {
    source: "kwz-original",
    mime: "audio/wav",
    data: Buffer.from(wavBytes(1000)).toString("base64"),
    muted: false,
    volume: 0.7,
    trimStartMs: 50,
    trimEndMs: 500,
    syncMode: "animToAudio",
    name: undefined,
  };
  for (const v of [3, 4]) {
    const p = await projectFromBytes(await gzipJson({ ...base, version: v, audio: oldAudio }));
    const b = p.audio?.bgm;
    check(
      `v${v} 旧audio→bgm可逆移行`,
      !!b &&
        b.source === "kwz" && // "kwz-original"→"kwz"
        b.volume === 0.7 &&
        b.trimStartMs === 50 &&
        b.trimEndMs === 500 &&
        b.syncMode === "animToAudio" &&
        b.baseSpeedIndex === 7 && // doc.speedIndex
        p.audio!.se.length === 0
    );
  }
  // v1/v2 は audio なし
  const p12 = await projectFromBytes(await gzipJson({ ...base, version: 1 }));
  check("v1 audioなし", p12.audio == null);
  // v6 拒否
  let rejected = false;
  try {
    await projectFromBytes(await gzipJson({ ...base, version: 6 }));
  } catch (e) {
    rejected = String(e).includes("アプリを更新");
  }
  check("v6拒否", rejected);
  // 壊れデータ隔離: bgm.data不正・se一部不正・frame.se未知id → 絵は開ける
  const broken = await projectFromBytes(
    await gzipJson({
      ...base,
      version: 5,
      audio: {
        bgm: { ...oldAudio, data: 12345 }, // 型不正
        se: [
          { id: "S1", name: "ok", source: "external", mime: "audio/wav", data: Buffer.from(wavBytes(100)).toString("base64"), volume: 1, muted: false },
          { id: "S2", name: "bad", source: "external", mime: "audio/wav", data: 999, volume: 1, muted: false },
        ],
      },
      frames: [{ paper: 1, layers: { L1: b64 }, se: ["S1", "S2", "GHOST", "S1"] }],
    })
  );
  check(
    "壊れデータ隔離（bgm不正=null・se不正除外・未知/重複id除去・絵は開く）",
    broken.frames.length === 1 &&
      broken.audio?.bgm == null &&
      broken.audio?.se.length === 1 &&
      broken.frames[0].se?.join() === "S1"
  );
  check("隔離後の nextSeId 健全化（S1超え）", (broken.nextSeId ?? 0) >= 2);
}

// ---- (4) computeMixPlan ----
{
  const spec = (over: Partial<ExportMixSpec> = {}): ExportMixSpec => ({
    bgm: mkBgm({ trimStartMs: 0, trimEndMs: null, baseSpeedIndex: 6 }),
    se: [mkSe("S1"), mkSe("S2", { muted: true })],
    frameSe: [["S1"], undefined, ["S1", "S2"], undefined],
    fps: 8,
    speedIndex: 6,
    syncMode: "audioToAnim",
    // M10-11: 既定は 0（＝全範囲）。既存ケースの期待値は 0 のとき従来と完全一致する
    rangeStartSec: 0,
    ...over,
  });
  const dec = new Set(["S1", "S2"]);
  // audioToAnim: 尺=アニメ・BGMは繰り返さない（V209 A-121）・SEはコマ時刻（muted除外）
  {
    const plan = computeMixPlan(spec(), 10, dec);
    check(
      "plan audioToAnim: 尺=アニメ・BGMは繰り返さない（V209 A-121・loop は偽）・rate=1",
      Math.abs(plan.outDurSec - 4 / 8) < 1e-9 &&
        plan.bgm?.loop === false &&
        plan.bgm.rate === 1
    );
    check(
      "plan SEイベント: 非ミュートのみ・コマ時刻",
      plan.seEvents.length === 2 &&
        plan.seEvents[0].id === "S1" &&
        Math.abs(plan.seEvents[0].atSec - 0) < 1e-9 &&
        Math.abs(plan.seEvents[1].atSec - 2 / 8) < 1e-9
    );
  }
  // 速度連動: speedIndex=8(20fps) / base=6(8fps) → rate=2.5・SE時刻は新fps基準
  {
    const plan = computeMixPlan(spec({ fps: 20, speedIndex: 8 }), 10, dec);
    check(
      "plan 速度連動: rate=FPS[8]/FPS[6]=2.5・SEは新コマ時刻",
      Math.abs(plan.bgm!.rate - FPS_TABLE[8] / FPS_TABLE[6]) < 1e-9 &&
        Math.abs(plan.seEvents[1].atSec - 2 / 20) < 1e-9
    );
  }
  // animToAudio: 尺=トリム後を rate 再生した実時間・SEは毎周・尺超え除外
  {
    const plan = computeMixPlan(
      spec({
        syncMode: "animToAudio",
        bgm: mkBgm({ trimStartMs: 1000, trimEndMs: 3000, baseSpeedIndex: 6 }),
        speedIndex: 8,
        fps: 20,
      }),
      10,
      dec
    );
    const rate = FPS_TABLE[8] / FPS_TABLE[6];
    const expectDur = 2 / rate; // (3000-1000)ms / rate
    const animDur = 4 / 20;
    check("plan animToAudio: 尺=usable/rate", Math.abs(plan.outDurSec - expectDur) < 1e-9);
    const loops = Math.ceil(expectDur / animDur);
    const expected = [];
    for (let k = 0; k < loops; k++)
      for (const i of [0, 2]) {
        const at = k * animDur + i / 20;
        if (at < expectDur - 1e-6) expected.push(at);
      }
    check(
      "plan animToAudio: SE毎周配置・尺超え除外",
      plan.seEvents.length === expected.length &&
        plan.seEvents.every((e, i) => Math.abs(e.atSec - expected[i]) < 1e-9)
    );
    check("plan animToAudio: BGMはループしない", plan.bgm?.loop === false);
  }
  // 全ミュート/BGMなし
  {
    const plan = computeMixPlan(
      spec({ bgm: mkBgm({ muted: true }), se: [mkSe("S1", { muted: true })] }),
      10,
      dec
    );
    check("plan 全ミュート→無音（bgm=null・SE 0件）", plan.bgm === null && plan.seEvents.length === 0);
    const plan2 = computeMixPlan(spec({ bgm: null, syncMode: "animToAudio" }), null, dec);
    check("plan BGMなし animToAudio→尺=アニメ", Math.abs(plan2.outDurSec - 0.5) < 1e-9);
  }
  // トリム異常値の正規化（end<=start → 最後まで）
  {
    const plan = computeMixPlan(
      spec({ bgm: mkBgm({ trimStartMs: 5000, trimEndMs: 4000 }) }),
      10,
      dec
    );
    check(
      "plan トリム正規化: end<=start→最後まで",
      !!plan.bgm && Math.abs(plan.bgm.trimEndSec - 10) < 1e-9 && plan.bgm.trimStartSec === 5
    );
  }

  // ---- M10-11: rangeStartSec（範囲書き出しの BGM 開始位置）----
  // 回帰: rangeStartSec=0 なら offsetSec は必ず trimStartSec（従来と完全一致）
  {
    const cases: [string, Partial<ExportMixSpec>, number][] = [
      ["既定", {}, 0],
      ["トリムあり", { bgm: mkBgm({ trimStartMs: 1500, trimEndMs: 4500 }) }, 1.5],
      ["速度連動", { fps: 20, speedIndex: 8 }, 0],
      [
        "animToAudio",
        { syncMode: "animToAudio", bgm: mkBgm({ trimStartMs: 2000, trimEndMs: 6000 }) },
        2,
      ],
    ];
    let ok = true;
    for (const [, over, want] of cases) {
      const plan = computeMixPlan(spec(over), 10, dec);
      if (!plan.bgm || Math.abs(plan.bgm.offsetSec - want) > 1e-9) ok = false;
    }
    check("plan rangeStartSec=0 → offsetSec=trimStartSec（回帰・4条件）", ok);
  }
  // 範囲中間から開始（1周目内）: offsetSec = trimStart + rangeStartSec*rate
  {
    const plan = computeMixPlan(
      spec({ bgm: mkBgm({ trimStartMs: 1000, trimEndMs: 9000 }), rangeStartSec: 2.5 }),
      10,
      dec
    );
    // trimStart=1 / usable=8 / rate=1 → 1 + (2.5 % 8) = 3.5
    check(
      "plan 範囲中間開始（1周目内）: offsetSec=trimStart+rangeStartSec*rate",
      !!plan.bgm && Math.abs(plan.bgm.offsetSec - 3.5) < 1e-9
    );
  }
  // 短い BGM ＋ 範囲先頭が曲の終わりより後ろ: V209 (A-121) から剰余しない＝トリムの終わりに留める（無音）
  {
    const plan = computeMixPlan(
      spec({ bgm: mkBgm({ trimStartMs: 0, trimEndMs: 3000 }), rangeStartSec: 7 }),
      10,
      dec
    );
    // trimStart=0 / trimEnd=3 / rate=1 → min(3, 0 + 7) = 3（鳴らす長さ 0 の無音・計画の bgm は null にしない）
    check(
      "plan 範囲先頭が曲より後ろ: 剰余しない・offsetSec=trimEndSec（usable=3s・range=7s → 3s）・bgm は null でない",
      !!plan.bgm && Math.abs(plan.bgm.offsetSec - 3) < 1e-9 && plan.bgm.loop === false
    );
  }
  // 速度連動 rate が掛かること（rate=2.5 → バッファ時間は 2.5 倍進む）
  {
    const plan = computeMixPlan(
      spec({
        bgm: mkBgm({ trimStartMs: 0, trimEndMs: 10000, baseSpeedIndex: 6 }),
        fps: 20,
        speedIndex: 8,
        rangeStartSec: 2,
      }),
      10,
      dec
    );
    const rate = FPS_TABLE[8] / FPS_TABLE[6]; // 2.5
    check(
      "plan rangeStartSec に rate が掛かる（2s × 2.5 = 5s）",
      !!plan.bgm && Math.abs(plan.bgm.offsetSec - 2 * rate) < 1e-9 &&
        Math.abs(plan.bgm.offsetSec - 5) < 1e-9
    );
  }
  // animToAudio は rangeStartSec を与えても動かない
  {
    const plan = computeMixPlan(
      spec({
        syncMode: "animToAudio",
        bgm: mkBgm({ trimStartMs: 1000, trimEndMs: 5000 }),
        rangeStartSec: 3,
      }),
      10,
      dec
    );
    check(
      "plan animToAudio: rangeStartSec を無視して offsetSec=trimStartSec",
      !!plan.bgm && Math.abs(plan.bgm.offsetSec - 1) < 1e-9 && plan.bgm.loop === false
    );
  }
  // 負値・巨大値でも破綻しない
  {
    const a = computeMixPlan(spec({ rangeStartSec: -5 }), 10, dec);
    const b = computeMixPlan(spec({ rangeStartSec: 1e6 }), 10, dec);
    check(
      "plan rangeStartSec の異常値（負/巨大）でもトリムの中（V209: 巨大な値はトリムの終わりに留める＝上限は <=）",
      !!a.bgm && a.bgm.offsetSec === a.bgm.trimStartSec &&
        !!b.bgm && b.bgm.offsetSec >= b.bgm.trimStartSec &&
        b.bgm.offsetSec <= b.bgm.trimStartSec + b.bgm.usableSec &&
        Math.abs(b.bgm.offsetSec - b.bgm.trimEndSec) < 1e-9
    );
  }
}

// ---- (5) frameClip の SE規則・cloneFrame・sanitizeAudio ----
{
  const p = newProject("clip");
  p.audio = { bgm: null, se: [mkSe("S1"), mkSe("S2")] };
  p.frames[0].se = ["S1", "S2"];
  const clip = makeClip(p, [0]);
  check("clip: SE配置を写し取る", clip.frames[0].se?.join() === "S1,S2");
  // 同一メモ相当（同じ id が存在）→ 保持
  const same = buildFramesFromClip(p, clip);
  check("clip 同一メモ貼り付け: SE保持", same[0].se?.join() === "S1,S2");
  // 別メモ（S2 が無い）→ S2 だけ外れる
  const q = newProject("other");
  q.audio = { bgm: null, se: [mkSe("S1")] };
  const other = buildFramesFromClip(q, clip);
  check("clip 別メモ貼り付け: 未知SEが外れる", other[0].se?.join() === "S1");
  // SEが全く無いメモ → undefined
  const r = newProject("none");
  const none = buildFramesFromClip(r, clip);
  check("clip 音なしメモ貼り付け: se=undefined", none[0].se === undefined);
  // cloneFrame は se を複製（独立配列）
  const c = cloneFrame(p.frames[0]);
  c.se!.push("S9");
  check("cloneFrame: se複製が独立", p.frames[0].se!.length === 2 && c.se!.length === 3);
  // sanitizeAudio: audio=null なら frame.se は全部剥がれる
  const s = newProject("san");
  s.frames[0].se = ["S1"];
  sanitizeAudio(s);
  check("sanitizeAudio: audioなし→配置除去", s.frames[0].se === undefined);
}

// ---- (3) .kwz 分離取込（実データ・引数でライブラリパス指定時のみ） ----
const libRoot = process.argv[2];
if (libRoot) {
  const { importFlipnote } = await import("../src/editor/kwzImport");
  const { parse } = await import("flipnote.js");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const fp = join(dir, name);
      if (statSync(fp).isDirectory()) walk(fp);
      else if (name.endsWith(".kwz")) files.push(fp);
    }
  })(libRoot);
  let seSample = 0;
  let bgmSample = 0;
  // V176b: 実データのライブラリには**開けない .kwz** が混ざり得る（0 バイト・途中で切れた・読めない）。
  //  以前はここで例外がそのまま上がり、**この先の検査ごとプロセスが死んでいた**。
  //  ⚠ **黙って continue しない**——開けなかったものは下で **NG として数えて理由を出す**。
  //  ⚠ 理由の文にはパスが混ざり得るので `importLogSafe` を通す（W-10 と同じ作法）。
  //  `.kwz` の名前は 3DS が付ける英数字のハッシュ＝作品名ではないので、**名前だけは出してよい**。
  const unreadable: string[] = [];
  let scanned = 0;
  // 効果音の置き場所: 期待は**取り込みと別の口**から作る（下の「kwz SE配置」）。
  //  ⚠ 空振りにしない: SE1〜SE4 のどれも「置くべきコマ」に 1 回は当たるまで見る（当たらなければ赤）
  const placedBySlot = [0, 0, 0, 0, 0]; // [1]〜[4] = SE1〜SE4 の置くべきコマの数
  let placementWorks = 0;
  let placementBad = 0;
  let oracleDisagree = 0;
  const slotsCovered = () => [1, 2, 3, 4].every((n) => placedBySlot[n] > 0);
  for (const f of files) {
    if (seSample >= 3 && bgmSample >= 3 && slotsCovered()) break;
    scanned++;
    // ★try で囲むのは「**開く**」ところだけ。この下の照合まで囲むと、こちら側が壊れたときに
    //  「開けなかった」として数えてしまい、本物の不具合が 1 行の注記に化ける
    let opened: {
      note: any;
      project: Awaited<ReturnType<typeof importFlipnote>>["project"];
      hasBgm: boolean;
      seSlots: number[];
    } | null = null;
    try {
      const nodeBuf = readFileSync(f);
      const ab = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
      const note: any = await parse(ab.slice(0));
      const hasBgm = note.hasAudioTrack?.(0) === true;
      const seSlots = [1, 2, 3, 4].filter((n) => note.hasAudioTrack?.(n) === true);
      // 音の無い作品はここでは用が無い（開けてはいるので NG ではない）
      if (!hasBgm && seSlots.length === 0) continue;
      const { project } = await importFlipnote(ab.slice(0), f);
      opened = { note, project, hasBgm, seSlots };
    } catch (e) {
      let size = -1;
      try {
        size = statSync(f).size;
      } catch {
        /* 走っている最中に消えた等。大きさは分からないが、開けなかったことは記録する */
      }
      const why =
        size === 0 ? "中身が空" : importLogSafe(String((e as Error)?.message ?? e), [f]);
      unreadable.push(
        `${logSafeFileLabel(f) || "(名前不明)"}: ${why}（${size < 0 ? "大きさ不明" : `${size} バイト`}）`
      );
    }
    if (!opened) continue;
    const { note, project, hasBgm, seSlots } = opened;
    const a = project.audio;
    if (hasBgm) {
      bgmSample++;
      const rate = note.sampleRate ?? 16364;
      const pcmLen = (note.getAudioTrackPcm(0, rate) as Int16Array).length;
      check(
        `kwz BGM分離: WAV長一致・base=取込速度 (${f.split(/[\\/]/).pop()})`,
        !!a?.bgm &&
          a.bgm.source === "kwz" &&
          a.bgm.data.length === 44 + pcmLen * 2 &&
          a.bgm.baseSpeedIndex === project.speedIndex
      );
    }
    if (seSlots.length > 0) {
      seSample++;
      check(
        `kwz SE分離: トラック本数一致 (${f.split(/[\\/]/).pop()})`,
        a?.se.length === seSlots.length &&
          seSlots.every((n, i) => a!.se[i].name === `SE${n}`)
      );
      // ★期待は flipnote.js の isSoundEffectUsedOnFrame(トラック 1〜4, コマ) から作り、decodeSoundFlags()（0〜3 の配列）と
      //  全コマで食い違わないことも見る（正そのものの確かめ）。取り込み（kwzImport.ts）が読むのは getSoundEffectFlags()
      //  （コマごとに **1〜4 を鍵にしたオブジェクト**）なので、ここはそれと別の口。
      //  前は期待を getSoundEffectFlags() の `[n - 1]` で作っていた＝取り込みと同じ思い込みで、SE1 がどこにも置かれず
      //  SE2〜SE4 が 1 つ前の効果音のコマに置かれていても緑だった（V200 報告書 §7-1）。見るのも最初の 1 作品だけだった
      placementWorks++;
      const dec: boolean[][] = note.decodeSoundFlags();
      let firstBad = "";
      for (let fi = 0; fi < project.frames.length; fi++) {
        const used = (n: number) => note.isSoundEffectUsedOnFrame(n, fi) === true;
        for (const n of [1, 2, 3, 4]) if (used(n) !== (dec[fi]?.[n - 1] === true)) oracleDisagree++;
        const expected = seSlots.filter(used);
        for (const n of expected) placedBySlot[n]++;
        const want = expected.map((n) => a!.se[seSlots.indexOf(n)].id);
        const actual = project.frames[fi].se ?? [];
        if (!firstBad && want.join() !== actual.join()) {
          const nameOf = (id: string) => a!.se.find((s) => s.id === id)?.name ?? id;
          firstBad = `コマ ${fi}: 期待 [${expected.map((n) => `SE${n}`)}] 実際 [${actual.map(nameOf)}]`;
        }
      }
      if (firstBad) {
        placementBad++;
        console.log(`  placement mismatch (${f.split(/[\\/]/).pop()}) ${firstBad}`);
      }
    }
  }
  console.log(`kwz sampled: bgm=${bgmSample} se=${seSample} (${files.length} files scanned)`);
  if (seSample > 0) {
    console.log(
      `kwz SE配置: ${placementWorks} 作品を全コマ照合・置くべきコマ SE1=${placedBySlot[1]} SE2=${placedBySlot[2]} SE3=${placedBySlot[3]} SE4=${placedBySlot[4]}`
    );
    check(
      "kwz SE配置: 見た作品の全コマで flipnote.js の isSoundEffectUsedOnFrame と一致（取り込みと別の口）",
      placementWorks === seSample && placementBad === 0,
      `${placementBad}/${placementWorks} 作品で食い違い`
    );
    check("kwz SE配置の正: isSoundEffectUsedOnFrame と decodeSoundFlags が全コマで一致", oracleDisagree === 0, `${oracleDisagree} か所`);
    check(
      "kwz SE配置: SE1〜SE4 のどれも置くべきコマに 1 回以上当たった（空振りでない）",
      slotsCovered(),
      `SE1..SE4=${placedBySlot.slice(1).join(",")}`
    );
  }
  // ★0 件でも必ず出す（出さないと「見ていない」のか「無かった」のか読む側に分からない）
  console.log(`開けなかった .kwz: ${unreadable.length} 件 / 見た ${scanned} 件中${unreadable.length ? "（NG）" : ""}`);
  for (const u of unreadable) console.log(`  - ${u}`);
  check("開けない .kwz が 0 件", unreadable.length === 0, `${unreadable.length} 件`);
  if (seSample === 0) console.log("  ⚠ SEありの .kwz が見つからなかったため配置検証はスキップ");
} else {
  console.log("（.kwz 分離取込の実データ検証はライブラリパス引数を付けて実行）");
}

// ---- (6) .ppm の効果音の置き場所（合成・ライブラリ不要） ----
// 作者のライブラリに .ppm は無いので合成する。期待は**書いた旗のバイト**から作る（flipnote.js の口にも頼らない）。
// .ppm の効果音は SE1〜SE3 だけ（getSoundEffectFlags() の鍵 4 は常に false）
/** 合成の DSi .ppm（効果音の検査用・絵は空）。書き方は v200_smoke の makePpm と同じ（flipnote.js の PpmParser の
 *  読み方どおり。署名は 0 で埋める＝読み手は確かめない）。flag(f) はコマ f の旗のバイト（bit0=SE1・bit1=SE2・bit2=SE3） */
function makeSePpm(frames: number, se: [number, number, number], flag: (f: number) => number): ArrayBuffer {
  const frameLen = 1 + 2 * (192 / 4); // 頭の 1 バイト＋2 層の行の種類（2 ビット × 192 行・全部 0＝空の行）
  const offTable = frames * 4;
  const frameDataLength = 8 + offTable + frames * frameLen;
  const flagsAt = 0x6a0 + frameDataLength;
  let soundAt = flagsAt + frames;
  if (soundAt % 4) soundAt += 4 - (soundAt % 4);
  const soundLen = se[0] + se[1] + se[2];
  const b = new Uint8Array(soundAt + 32 + soundLen + 0x80 + 0x10);
  const dv = new DataView(b.buffer);
  b.set([0x50, 0x41, 0x52, 0x41], 0); // "PARA"
  dv.setUint32(4, frameDataLength, true);
  dv.setUint32(8, soundLen, true);
  dv.setUint16(12, frames - 1, true);
  dv.setUint16(14, 0x24, true);
  dv.setUint16(0x6a0, offTable, true);
  for (let f = 0; f < frames; f++) {
    dv.setUint32(0x6a8 + f * 4, f * frameLen, true);
    b[0x6a8 + offTable + f * frameLen] = 0x80 | (1 << 1) | (1 << 3); // キーフレーム・紙 0・ペンは 2 層とも 1
  }
  for (let f = 0; f < frames; f++) b[flagsAt + f] = flag(f);
  dv.setUint32(soundAt, 0, true); // BGM なし
  dv.setUint32(soundAt + 4, se[0], true);
  dv.setUint32(soundAt + 8, se[1], true);
  dv.setUint32(soundAt + 12, se[2], true);
  b[soundAt + 16] = 8 - 5; // 速さ 5
  b[soundAt + 17] = 8 - 5;
  for (let k = soundAt + 32; k < soundAt + 32 + soundLen; k++) b[k] = (k * 37) & 0xff; // 音の中身は何でもよい
  return b.buffer;
}
{
  const { importFlipnote } = await import("../src/editor/kwzImport");
  const { parse } = await import("flipnote.js");
  // SE1＝コマ 0,3,6,9・SE2＝1,5,9・SE3＝2,7（コマ 9 は SE1 と SE2 の 2 つ）
  const FLAG = (f: number) => (f % 3 === 0 ? 1 : 0) | (f % 4 === 1 ? 2 : 0) | (f % 5 === 2 ? 4 : 0);
  const bit = (f: number, n: number) => ((FLAG(f) >> (n - 1)) & 1) === 1;
  const cases: { label: string; se: [number, number, number] }[] = [
    { label: "SE1〜SE3 あり", se: [400, 300, 200] },
    { label: "SE2 の音が無い（旗だけ立つ）", se: [400, 0, 200] },
  ];
  for (const c of cases) {
    const ab = makeSePpm(12, c.se, FLAG);
    const have = c.se.map((n) => n > 0);
    // 材料の確かめ: 書いた旗のとおりに flipnote.js が読む（.ppm に SE4 は無い）
    const note: any = await parse(ab.slice(0));
    let readOk =
      note.format === "PPM" &&
      note.frameCount === 12 &&
      [1, 2, 3].every((n) => note.hasAudioTrack(n) === have[n - 1]) &&
      !note.hasAudioTrack(4);
    for (let f = 0; f < 12; f++)
      for (const n of [1, 2, 3, 4]) if (note.isSoundEffectUsedOnFrame(n, f) !== (n <= 3 && bit(f, n))) readOk = false;
    check(`ppm 材料: 合成 .ppm（${c.label}）の旗を flipnote.js が書いたとおりに読む（SE4 は無い）`, readOk);
    const { project } = await importFlipnote(ab.slice(0), "se.ppm");
    const tracks = project.audio?.se ?? [];
    const nameOf = (id: string) => tracks.find((t) => t.id === id)?.name ?? id;
    let bad = "";
    for (let f = 0; f < 12; f++) {
      const expected = [1, 2, 3].filter((n) => have[n - 1] && bit(f, n));
      const want = expected.map((n) => tracks.find((t) => t.name === `SE${n}`)?.id ?? `SE${n}?`);
      const actual = project.frames[f].se ?? [];
      if (!bad && want.join() !== actual.join())
        bad = `コマ ${f}: 期待 [${expected.map((n) => `SE${n}`)}] 実際 [${actual.map(nameOf)}]`;
    }
    check(
      `ppm SE配置（${c.label}）: 書いた旗のとおり（SE1＝0,3,6,9・SE2＝1,5,9・SE3＝2,7）`,
      tracks.length === have.filter(Boolean).length && bad === "",
      bad
    );
  }
}

console.log(`m5 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
