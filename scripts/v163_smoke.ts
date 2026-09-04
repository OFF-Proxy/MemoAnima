// V163 (A-40): 保存形式 PV6 の回帰ゲート。引数不要:
//   npx tsx scripts/v163_smoke.ts
//
// ★この回でいちばん怖いのは3つ:
//   ① 可逆が壊れる（絵・音・骨組みのどれかが落ちる）→ 検査1〜6 で全画素・音バイト・骨組みを突き合わせ
//   ② 旧ビルドが「きれいに断れない」形（ヘッダのキー順崩れ）→ 検査7 で**キー順を破って赤**を実証
//   ③ 検証（W-6 後継）が素通しする → 検査8 で**故意破損3種**（塊1バイト・ヘッダ1バイト・トレーラ長）が赤
import fs from "node:fs";
import path from "node:path";
import {
  newProject,
  makeEmptyFrame,
  allocIndexBuf,
  PIXELS,
  type Project,
} from "../src/editor/model";
import {
  projectToBytes,
  projectFromBytes,
  verifySavedBytes,
  PROJECT_VERSION,
  PV5_VERSION,
} from "../src/editor/serialize";
import {
  encodePV6,
  isPV6,
  verifyPV6,
  assertPv6HeaderOrder,
  crc32,
  PV6_EAGER_MAX_RAW,
} from "../src/editor/pv6";
import { wakeFrame, sleepFrame, frameHasAsleep, asleepCount } from "../src/editor/sleep";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}

const root = path.resolve(import.meta.dirname, "..");

const gunzip = async (b: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
    ).arrayBuffer()
  );

function make(frames: number, layers: number, seed = 7): Project {
  const p = newProject("V163");
  p.layerDefs = [];
  for (let i = 0; i < layers; i++)
    p.layerDefs.push({ id: `L${i + 1}`, name: `L${i + 1}`, visible: true, opacity: 1 });
  p.frames = [];
  for (let f = 0; f < frames; f++) {
    const fr = makeEmptyFrame(p, 0);
    fr.layers = {};
    p.layerDefs.forEach((ld, li) => {
      const b = allocIndexBuf(p);
      for (let k = (f * 7 + seed + li * 11) % 53; k < PIXELS; k += 53) b[k] = ((k + f + li) % 6) + 1;
      fr.layers[ld.id] = b;
    });
    p.frames.push(fr);
  }
  return p;
}

function diffPixels(a: Project, b: Project): number {
  let diff = 0;
  if (a.frames.length !== b.frames.length) return -1;
  for (let i = 0; i < a.frames.length; i++) {
    const ids = new Set([...Object.keys(a.frames[i].layers), ...Object.keys(b.frames[i].layers)]);
    for (const id of ids) {
      const x = a.frames[i].layers[id];
      const y = b.frames[i].layers[id];
      if (!x || !y) return -1;
      for (let k = 0; k < PIXELS; k++) if (x[k] !== y[k]) diff++;
    }
  }
  return diff;
}

/** 遅延読みの姿でも比べられるよう、全コマを起こしてから突き合わせる */
async function wakeAll(p: Project): Promise<void> {
  for (const f of p.frames) await wakeFrame(p, f, "read");
}

// ================= 1. 基本の往復（eager・骨組み・音） =================
{
  const p = make(6, 3);
  p.speedIndex = 4;
  p.loop = false;
  p.thumbFrame = 2;
  p.frames[1].order = ["L3", "L1", "L2"];
  p.frames[2].se = ["S1"];
  p.frames[3].layerColors = { L1: "#ff0000" };
  p.frames[4].paper = 0;
  const audioBytes = new Uint8Array(1000);
  for (let i = 0; i < audioBytes.length; i++) audioBytes[i] = (i * 31) & 0xff;
  p.audio = {
    bgm: {
      source: "external",
      mime: "audio/mpeg",
      data: audioBytes,
      muted: false,
      volume: 0.8,
      trimStartMs: 10,
      trimEndMs: 900,
      syncMode: "animToAudio",
      baseSpeedIndex: 4,
      name: "b",
    },
    se: [
      { id: "S1", name: "s", source: "external", mime: "audio/wav", data: audioBytes.slice(0, 64), volume: 1, muted: false },
    ],
  };
  p.nextSeId = 2;
  const r = (await encodePV6(p))!;
  check("1 isPV6 が PV6 を判定する", isPV6(r.bytes));
  check("1 isPV6 が PV5 を false と言う", !isPV6(await projectToBytes(make(1, 1))));
  const q = await projectFromBytes(r.bytes);
  check("1 小さい作品は全部起きて開く（眠りゼロ）", asleepCount(q) === 0);
  check("1 ★全画素一致", diffPixels(p, q) === 0);
  check(
    "1 骨組み一致（speed/loop/thumb/order/se/layerColors/紙）",
    q.speedIndex === 4 &&
      q.loop === false &&
      q.thumbFrame === 2 &&
      q.frames[1].order?.join() === "L3,L1,L2" &&
      q.frames[2].se?.join() === "S1" &&
      q.frames[3].layerColors?.L1 === "#ff0000" &&
      q.frames[4].paper === 0
  );
  const qa = q.audio?.bgm;
  check(
    "1 ★音声（BGM/SE）のバイト列と設定が完全一致",
    !!qa &&
      qa.data.length === audioBytes.length &&
      qa.data.every((v, i) => v === audioBytes[i]) &&
      qa.volume === 0.8 &&
      qa.trimEndMs === 900 &&
      qa.syncMode === "animToAudio" &&
      q.audio!.se[0].data.length === 64 &&
      q.nextSeId === 2
  );
  // W-6 後継: 正しいファイルは tier1 / 1.5 / 2 とも緑
  for (const tier of [1, 1.5, 2] as const) {
    const v = await verifyPV6(r.bytes, p.frames.length, tier);
    check(`1 verifyPV6 tier${tier} が緑`, v.ok, v.reason);
  }
  check("1 verifySavedBytes も PV6 を振り分けて緑", (await verifySavedBytes(r.bytes, p.frames.length)).ok);
}

// ================= 2. 16bit（昇格した作品） =================
{
  const p = make(3, 2);
  p.indexBits = 16;
  p.colorTable = ["", "#141414", "#ffffff"];
  for (let c = 0; c < 300; c++) p.colorTable.push(`#${(c * 40000 + 123456).toString(16).padStart(6, "0").slice(0, 6)}`);
  for (const f of p.frames) {
    for (const id of Object.keys(f.layers)) {
      const wide = new Uint16Array(PIXELS);
      wide.set(f.layers[id]);
      wide[100] = 280; // 256 超の索引（8bit に切り詰めると壊れる値）
      f.layers[id] = wide;
    }
  }
  const r = (await encodePV6(p))!;
  const q = await projectFromBytes(r.bytes);
  check("2 16bit: 全画素一致・読み側も 16bit", diffPixels(p, q) === 0 && q.indexBits === 16 && q.frames[0].layers.L1[100] === 280);
}

// ================= 2b. indexBits のズレ防御（Codex V163 指摘①） =================
{
  // p.indexBits が 8 のまま、起きている Uint16Array と眠り控え bits:16 が混ざった状態。
  // ヘッダを 8 のまま書くと「8bit ヘッダ＋16bit 塊」の自分で読めないファイルになる
  const p = make(4, 2);
  p.colorTable = ["", "#141414", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00"];
  const wide = new Uint16Array(PIXELS);
  wide.set(p.frames[1].layers.L1);
  wide[77] = 300;
  p.frames[1].layers.L1 = wide; // 起きている16bit（indexBits は 8 のまま＝ズレ）
  await sleepFrame(p, p.frames[2]); // 8bit のまま眠らせる
  const r = (await encodePV6(p))!;
  const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
  const headerLen = dv.getUint32(r.bytes.length - 8, true);
  const headJson = new TextDecoder().decode(
    new Uint8Array(
      await new Response(
        new Blob([r.bytes.subarray(0, headerLen) as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
      ).arrayBuffer()
    )
  );
  check("2b ★ズレた indexBits=8 でも 16bit バッファがあればヘッダは 16", headJson.includes('"indexBits":16'));
  const q = await projectFromBytes(r.bytes);
  await wakeAll(q);
  await wakeAll(p);
  check("2b ズレ状態の roundtrip も 0差・値300 保持", diffPixels(p, q) === 0 && q.frames[1].layers.L1[77] === 300 && q.indexBits === 16);
}

// ================= 3. 📌 共通レイヤー（A-34: 1回書き・同一実体の復元） =================
{
  const p = make(40, 1);
  p.layerDefs.unshift({ id: "BG", name: "bg", visible: true, opacity: 1, shared: true });
  const bg = allocIndexBuf(p);
  for (let k = 0; k < PIXELS; k += 3) bg[k] = (k % 6) + 1;
  for (const f of p.frames) f.layers.BG = bg; // 全コマ同一実体（relinkShared 後の姿）
  const r = (await encodePV6(p))!;
  check("3 ★📌 は塊1個（40コマでも1回しか書かれない）", r.stats.blobCount === 41, `${r.stats.blobCount}`);
  const q = await projectFromBytes(r.bytes);
  check("3 全画素一致", diffPixels(p, q) === 0);
  check(
    "3 ★同一実体が復元される（relinkShared が構造的に満たされる）",
    q.frames.every((f) => f.layers.BG === q.frames[0].layers.BG) && q.layerDefs[0].shared === true
  );
}

// ================= 4. 遅延読み（大きい作品）＋眠り状態からの保存 =================
{
  // 論理 32MiB 以上（PV6_EAGER_MAX_RAW）: 30コマ×15レイヤー＝450面 ≈ 34.6MB
  const p = make(30, 15);
  p.thumbFrame = 20;
  const need = Math.ceil(PV6_EAGER_MAX_RAW / PIXELS);
  check("4 検査データが遅延しきい値を超えている（前提）", 30 * 15 >= need, `${30 * 15} < ${need}`);
  const r = (await encodePV6(p))!;
  const q = await projectFromBytes(r.bytes);
  check("4 大きい作品は眠って開く", asleepCount(q) > 0, `${asleepCount(q)}`);
  check(
    "4 窓（0..3）とサムネのコマ（20）は起きている",
    !frameHasAsleep(q.frames[0]) && !frameHasAsleep(q.frames[3]) && !frameHasAsleep(q.frames[20]) && frameHasAsleep(q.frames[10])
  );
  await wakeAll(q);
  check("4 ★起こすと全画素一致", diffPixels(p, q) === 0);

  // 眠り状態から書く（控えの z をそのまま写す＝再圧縮ゼロの経路）
  for (const f of q.frames) await sleepFrame(q, f);
  const r2 = (await encodePV6(q))!;
  check("4 ★眠り状態の保存は控えを再利用する（reusedSleepZ > 0）", r2.stats.reusedSleepZ > 0, JSON.stringify(r2.stats));
  const q2 = await projectFromBytes(r2.bytes);
  await wakeAll(q2);
  check("4 眠り経由でも全画素一致", diffPixels(p, q2) === 0);
}

// ================= 5. PV5 → PV6 → PV5（旧形式書き出し・作者決定②の土台） =================
{
  const p = make(8, 2, 13);
  const audio = new Uint8Array(512).map((_, i) => (i * 7) & 0xff);
  p.audio = {
    bgm: { source: "kwz", mime: "audio/wav", data: audio, muted: false, volume: 1, trimStartMs: 0, trimEndMs: null, syncMode: "audioToAnim", baseSpeedIndex: 6 },
    se: [],
  };
  const pv5a = await projectToBytes(p);
  const viaPv5 = await projectFromBytes(pv5a);
  const pv6 = (await encodePV6(viaPv5))!.bytes;
  const viaPv6 = await projectFromBytes(pv6);
  await wakeAll(viaPv6);
  const pv5b = await projectToBytes(viaPv6); // 旧形式で書き出す
  const back = await projectFromBytes(pv5b);
  check("5 ★PV5→PV6→PV5 で全画素一致", diffPixels(p, back) === 0);
  check("5 ★音声バイト列も完全一致", !!back.audio?.bgm && back.audio.bgm.data.every((v, i) => v === audio[i]));
  const doc = JSON.parse(new TextDecoder().decode(await gunzip(pv5b))) as { version: number };
  check("5 旧形式の書き手は version 5 のまま", doc.version === PV5_VERSION && PROJECT_VERSION === 6);
}

// ================= 6. ヘッダのキー順（互換の要）＋旧ビルドの断り方 =================
{
  const p = make(2, 1);
  const r = (await encodePV6(p))!;
  // トレーラからヘッダ長を取り、ヘッダ JSON を取り出す
  const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
  const headerLen = dv.getUint32(r.bytes.length - 8, true);
  const headJson = new TextDecoder().decode(await gunzip(r.bytes.subarray(0, headerLen)));
  check(
    "6 ★キー順: magic/version/width/height が先頭",
    headJson.startsWith('{"magic":"ANIMEMO","version":6,"width":320,"height":240,')
  );
  check("6 ★キー順: blobs は frames の後", headJson.indexOf('"blobs":[') > headJson.indexOf('"frames":['));
  // 旧ビルドの earlyCheck 相当: `"frames":[` までを JSON.parse → version 6 が**読める**（きれいに断れる形）
  const cut = headJson.indexOf('"frames":[');
  const early = JSON.parse(headJson.slice(0, cut + '"frames":['.length) + "]}") as { version: number };
  check("6 ★旧ビルドの earlyCheck が version 6 を読める（断り文言の前提）", early.version === 6);

  // ★キー順を故意に破ると赤（assertPv6HeaderOrder が守っている）
  const reordered = JSON.stringify({ magic: "ANIMEMO", width: 320, height: 240, version: 6 });
  let threw = false;
  try {
    assertPv6HeaderOrder(reordered);
  } catch {
    threw = true;
  }
  check("6 ★キー順を破ると assertPv6HeaderOrder が赤", threw);
  // 破った順では earlyCheck 相当の prefix-parse が version に届かない（＝守る理由の実証）
  check("6 破った順は接頭辞に version が無い", !reordered.startsWith('{"magic":"ANIMEMO","version":'));
  // 書き手が毎回この検査を通していること（ソース走査）
  const pv6src = fs.readFileSync(path.join(root, "src/editor/pv6.ts"), "utf8");
  check("6 encodePV6 が assertPv6HeaderOrder を呼ぶ", /assertPv6HeaderOrder\(headJson\);/.test(pv6src));
  check("6 トレーラ u32 の上限を明示的に断る（黙って丸めない）", /U32_MAX/.test(pv6src) && /section too large for u32/.test(pv6src));
}

// ================= 7. 故意破損3種＋αで赤（W-6 後継が素通ししない） =================
{
  const p = make(10, 3);
  const good = (await encodePV6(p))!.bytes;
  const flip = (at: number): Uint8Array => {
    const b = good.slice();
    b[at] ^= 0x01;
    return b;
  };
  const dv = new DataView(good.buffer, good.byteOffset, good.byteLength);
  const headerLen = dv.getUint32(good.length - 8, true);

  // ① 塊の中身1バイト（gzip の CRC は展開しないと分からない＝tier1 は素通し・tier1.5 が捕まえる）
  const blobFlip = flip(headerLen + 100);
  check("7 ★塊1バイトの化け: tier1 は素通し（ISIZE 無傷のため）", (await verifyPV6(blobFlip, 10, 1)).ok);
  check("7 ★塊1バイトの化け: tier1.5 で赤（CRC32 走査）", !(await verifyPV6(blobFlip, 10, 1.5)).ok);
  check("7 塊1バイトの化け: verifySavedBytes（既定 tier1.5）でも赤", !(await verifySavedBytes(blobFlip, 10)).ok);

  // ② ヘッダ1バイト（ヘッダ gzip の CRC が捕まえる）
  check("7 ★ヘッダ1バイトの化けで赤", !(await verifyPV6(flip(50), 10, 1.5)).ok);

  // ③ トレーラの長さ（headerGzLen を書き換え）
  const trailerBad = good.slice();
  new DataView(trailerBad.buffer).setUint32(good.length - 8, headerLen + 8, true);
  check("7 ★トレーラ長の改ざんで赤", !(await verifyPV6(trailerBad, 10, 1)).ok);

  // ★読み込み時にも塊表の構造検査が効く（Codex V163 指摘③: 壊れた塊を眠り控えに
  //   入れてしまうと、あとでコマ移動や書き出しのときに初めて落ちる）。
  //   最後の塊の ISIZE（＝ファイル末尾側）を書き換えても **開く時点で**断られる
  {
    const isizeBad = good.slice();
    isizeBad[good.length - 17] ^= 0x01; // トレーラ直前＝最終塊の ISIZE 内の1バイト
    let threwAtLoad = false;
    try {
      await projectFromBytes(isizeBad);
    } catch {
      threwAtLoad = true;
    }
    check("7 ★壊れた塊は読み込み時点で断られる（眠り控えに紛れない）", threwAtLoad);
  }

  // ＋α: 切り詰め・コマ数不一致・トレーラ magic 破壊（PV6 と認識されなくなる）
  check("7 切り詰めで赤", !(await verifyPV6(good.slice(0, good.length - 100), 10, 1)).ok);
  check("7 コマ数不一致で赤", !(await verifyPV6(good, 11, 1)).ok);
  check("7 トレーラ magic を壊すと isPV6=false（旧経路に流れ、gzip 末尾の壊れとして検出される）", !isPV6(flip(good.length - 12)));

  // crc32 の自己検査（IEEE テストベクタ "123456789" → 0xCBF43926）
  check("7 crc32 が IEEE ベクタと一致", crc32(new TextEncoder().encode("123456789")) === 0xcbf43926);
  // slice-by-8 の境界処理: 4バイト境界に揃っていない subarray でもコピーと同じ値
  {
    const base = new Uint8Array(1000).map((_, i) => (i * 131 + 7) & 0xff);
    let ok = true;
    for (const [s, e] of [[1, 998], [3, 995], [2, 20], [5, 11], [0, 7]] as const) {
      const view = base.subarray(s, e);
      if (crc32(view) !== crc32(view.slice())) ok = false;
    }
    check("7 crc32 が非整列 subarray でもコピーと同値（slice-by-8 の境界）", ok);
  }
}

// ================= 8. PV6 コンテナの新しい版（v7）は文言で断る =================
{
  // ヘッダの version だけ 7 に書き換えた PV6 を手組みする（gzip し直してトレーラを付け替える）
  const p = make(2, 1);
  const good = (await encodePV6(p))!.bytes;
  const dv = new DataView(good.buffer, good.byteOffset, good.byteLength);
  const headerLen = dv.getUint32(good.length - 8, true);
  const blobLen = dv.getUint32(good.length - 4, true);
  const headJson = new TextDecoder().decode(await gunzip(good.subarray(0, headerLen)));
  const bumped = headJson.replace('"version":6', '"version":7');
  const gz = new Uint8Array(
    await new Response(
      new Blob([new TextEncoder().encode(bumped) as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer()
  );
  const out = new Uint8Array(gz.length + blobLen + 16);
  out.set(gz, 0);
  out.set(good.subarray(headerLen, headerLen + blobLen), gz.length);
  out.set(new TextEncoder().encode("AMPV6END"), gz.length + blobLen);
  const odv = new DataView(out.buffer);
  odv.setUint32(out.length - 8, gz.length, true);
  odv.setUint32(out.length - 4, blobLen, true);
  let msg = "";
  try {
    await projectFromBytes(out);
  } catch (e) {
    msg = String((e as Error).message ?? e);
  }
  check("8 PV6 の新しい版（v7）は「新しいバージョン」の文言で断る", msg.includes("7") && /新しいバージョン|newer|更新/.test(msg), msg.slice(0, 60));
}

// ================= 9. 配線の走査（保存・オートセーブ・書き出し・プレビュー） =================
{
  const ed = fs.readFileSync(path.join(root, "src/editor/editor.ts"), "utf8");
  const lib = fs.readFileSync(path.join(root, "src/library.ts"), "utf8");
  const ser = fs.readFileSync(path.join(root, "src/editor/serialize.ts"), "utf8");
  const wk = fs.readFileSync(path.join(root, "src/editor/saveWorker.ts"), "utf8");
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");

  check("9 projectFromBytes が isPV6 で振り分ける", /if \(isPV6\(bytes\)\) \{[\s\S]{0,200}?decodePv6\(/.test(ser));
  check("9 verifySavedBytes が PV6 を振り分ける", /if \(isPV6\(bytes\)\) return verifyPV6\(bytes, expectFrames, 1\.5\);/.test(ser));
  check("9 保存 Worker の既定は pv6（旧形式チェック時のみ gzip）", /mode: ctx\.legacy \? "gzip" : "pv6"/.test(ed));
  check("9 オートセーブは encodePV6（中断可能）", /await import\("\.\/pv6"\)/.test(ed) && /await encodePV6\(this\.project, \{/.test(ed));
  check("9 オートセーブの書く前検証は verifySavedBytes（PV6 も振り分けが効く）", /okAuto = await verifySavedBytes/.test(ed));
  // ★V168 (E-4): 検査9 の2本を置き換えた。
  //  以前は「書き出しの入口で全コマを起こす」を不変条件にしていたが、それは
  //  目安の 10.8 倍の作品で**論理サイズ 4.1GB をそのまま生で展開する見積りなしの確保**になる。
  //  守りたいのは「眠ったコマでも白紙にならない」であって、「全部起こす」ではない。
  //  **不変条件は残し、守り方だけを変える**（読む直前に起こす）。
  {
    // (2z) 供給元は眠ったコマでも白紙を返さない: 眠らせた作品で getFrameRgba の結果が、
    //      起きている状態の合成と**全画素一致**する
    const { projectSource } = await import("../src/editor/frameSource");
    const { compositeFrame } = await import("../src/editor/render");
    const p = make(6, 3, 11);
    // 起きている状態の合成を先に控える（これが正）
    const truth = Array.from({ length: p.frames.length }, (_, i) =>
      new Uint8ClampedArray(compositeFrame(p, i).buffer.slice(0, PIXELS * 4))
    );
    // 全コマを眠らせる（読みでなく書き→控えなし→圧縮）。窓の外を模す
    for (const f of p.frames) await sleepFrame(p, f);
    const asleepAll = p.frames.every((f) => frameHasAsleep(f));
    const src = projectSource(p);
    let same = 0;
    for (let i = 0; i < p.frames.length; i++) {
      const got = await src.getFrameRgba(i);
      let eq = got.length === truth[i].length;
      if (eq) for (let k = 0; k < got.length; k++) if (got[k] !== truth[i][k]) { eq = false; break; }
      if (eq) same++;
    }
    // 反証（同じ1本の中で）: 眠ったまま compositeFrame を直に呼ぶと白紙になる＝この検査が空振りしていない
    const q = make(2, 3, 11);
    const before = new Uint8ClampedArray(compositeFrame(q, 0).buffer.slice(0, PIXELS * 4));
    for (const f of q.frames) await sleepFrame(q, f);
    const blank = new Uint8ClampedArray(compositeFrame(q, 0).buffer.slice(0, PIXELS * 4));
    let differs = false;
    for (let k = 0; k < before.length; k++) if (before[k] !== blank[k]) { differs = true; break; }
    check(
      "9 ★書き出しの供給元は眠ったコマでも白紙を返さない（起きている合成と全画素一致・2z・反証つき）",
      asleepAll && same === p.frames.length && differs,
      `眠らせた=${asleepAll} 一致=${same}/${p.frames.length} 直合成は白紙=${differs}`
    );
  }
  // 書き出しの入口に全コマ起こしが**無い**（走査・editor と library）。入口で起こすと見積りなしの確保になる
  check(
    "9 ★書き出しの入口（editor／library）で全コマを起こしていない",
    !/#ed-export"\)\.onclick = async[\s\S]{0,1600}?wakeLayersAllFrames\(/.test(ed) &&
      !/exportSelected\(\)[\s\S]{0,3000}?wakeLayersAllFrames\(/.test(lib)
  );
  check("9 ライブラリのプレビューが眠ったコマを起こしてから描く", /drawPreview\(\) \{[\s\S]{0,700}?frameHasAsleep\(cur\)/.test(lib));
  check("9 プレビューの先回り（起こす）と後片付け（只で眠らす）がある", /prewakePreview\(\) \{[\s\S]{0,900}?sleepFrame\(/.test(lib));
  check("9 エディタ mount は眠りが残っていれば sleepOn を立てる", /projectBytes\(project\) >= Editor\.SLEEP_MIN_BYTES \|\| asleepCount\(project\) > 0/.test(ed));
  check("9 1コマ画像保存も眠りを起こす", /#ed-imgexport"\)\.onclick = async[\s\S]{0,900}?wakeFrame\(this\.project, fr, "read"\)/.test(ed));
  check("9 保存先ピッカーに形式チェックがある（旧形式書き出し・作者決定②）", /ps-legacy/.test(main) && /common\.saveTarget\.legacy\.msg/.test(main));
  check("9 形式はコンテキストに覚える（Ctrl+S で黙って新形式に化けない）", /legacy: picked\.legacy/.test(ed));
  // Codex V163 指摘②: 記憶は settings に永続化（再起動・開き直し・オートセーブ復元でも化けない）
  check("9 ★形式の記憶は settings に永続化（保存時に記録）", /rememberLegacyTarget\(c\.album, c\.baseName, c\.legacy === true\)/.test(main));
  check("9 ★開くときに legacy を復元する", /legacy: isLegacyTarget\(item\.album, stripExt\(item\.name\)\)/.test(main));
  check("9 ★オートセーブ復元でも legacy を復元する", /legacy: isLegacyTarget\(String\(meta\.album\), String\(meta\.baseName\)\)/.test(main));
}

console.log(`v163 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
