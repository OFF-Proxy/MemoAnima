// V154: データ保護（作品の大きさメーター・履歴の量・予算）の回帰スモーク
//（引数不要: npx tsx scripts/v154_smoke.ts）
//
// ★Rust 側（`.bak` を残す・孤児の復元・索引が行を落とさない・削除で残骸も消す）は
//   `cargo run --example v154_smoke` が受け持つ。こちらは**フロントの数え方**だけを見る。
//
// 1. projectBytes が**実体を数える**（掛け算ではない）: コマ数×レイヤー数×76.8KB と一致
// 2. 📌 全コマ共通レイヤー（shared）は**何コマあっても 76.8KB**（掛け算だと 700 倍に間違える）
// 3. 16bit 昇格でちょうど2倍（一方通行＝色を減らしても戻らない、を数字で示せる）
// 4. 音声（BGM・SE）のバイト列もメーターに入る（要件 §2-b ③）
// 5. entryBytes が**同じ実体を1回だけ**数える（共通レイヤーの二重計上を防ぐ）
// 6. bufferChangeEntry / multiBufferChangeEntry が bytes を自動で申告する
// 7. **統合しても「元に戻す」は減らない**（作品だけ減る）＝メーターが嘘をつかない
// 8. 履歴の予算（W-4）: 大きい作品では古いエントリから捨てる・**最低1件は残す**
// 9. 小さい作品では予算が効かない（64件の従来どおり＝体感を変えない）
// 10. 読み込みの壁（384 MiB）としきい値の関係・面数の数え方（V154b の訂正）
import {
  PIXELS,
  allocIndexBuf,
  copyIndexBuf,
  newProject,
  makeEmptyFrame,
  promoteTo16,
  projectBytes,
  projectFaces,
  loadWallFaces,
  LOAD_WALL_BYTES,
  relinkShared,
  type Project,
  type IndexBuf,
} from "../src/editor/model";
import { History, entryBytes, bufferChangeEntry, multiBufferChangeEntry } from "../src/editor/history";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " " + detail : ""}`);
  }
}

const KB = 1024;
/** 8bit の1レイヤー1コマ＝320×240＝76,800 バイト */
const ONE = PIXELS;

/** レイヤー数・コマ数を指定して作る（中身は空でよい＝数えるのは実体の大きさだけ） */
function makeProject(frames: number, layers: number): Project {
  const p = newProject("V154");
  p.layerDefs = [];
  for (let i = 0; i < layers; i++)
    p.layerDefs.push({ id: `L${i + 1}`, name: `L${i + 1}`, visible: true, opacity: 1 });
  p.frames = [];
  for (let f = 0; f < frames; f++) {
    const fr = makeEmptyFrame(p, 0);
    fr.layers = {};
    for (const ld of p.layerDefs) fr.layers[ld.id] = allocIndexBuf(p);
    p.frames.push(fr);
  }
  return p;
}

// ---------------- 1. 実体を数える ----------------
{
  const p = makeProject(600, 3);
  check("1: 600コマ×3レイヤー = 138.2MB", projectBytes(p) === 600 * 3 * ONE, `${projectBytes(p)}`);
  const p2 = makeProject(50, 3);
  check("1: 50コマ×3レイヤー = 11.5MB", projectBytes(p2) === 50 * 3 * ONE);
}

// ---------------- 1-b. 要件 §1 の表と突き合わせる（700コマ・3レイヤー） ----------------
{
  const p = makeProject(700, 3);
  // 8bit: 700 × 3 × 76,800 = 161,280,000 バイト（153.8 MiB）
  check("1-b: 700コマ×3レイヤー(8bit) = 161,280,000 バイト", projectBytes(p) === 161_280_000);
  promoteTo16(p);
  // 16bit: 322,560,000 バイト（307.6 MiB）＝要件 §1 の表と一致
  check("1-b: 16bit で 322,560,000 バイト（要件の表 307.6MiB）", projectBytes(p) === 322_560_000);
  check("1-b: MiB 換算が要件の表と一致", Math.round((322_560_000 / 1024 / KB) * 10) / 10 === 307.6);
}

// ---------------- 2. 📌 共通レイヤーは1枚ぶん ----------------
{
  const p = makeProject(600, 3);
  const before = projectBytes(p);
  // 4枚目を「全コマ共通」で足す（実装と同じ: 定義に shared を立てて relinkShared）
  p.layerDefs.push({ id: "S1", name: "共通", visible: true, opacity: 1, shared: true });
  relinkShared(p);
  const after = projectBytes(p);
  check(
    "2: 📌 を1枚足しても 76.8KB しか増えない（600コマぶんにならない）",
    after - before === ONE,
    `+${after - before} バイト（掛け算なら +${600 * ONE}）`
  );
  // 普通のレイヤーなら 600 コマぶん増える（対照）
  p.layerDefs.push({ id: "N1", name: "普通", visible: true, opacity: 1 });
  for (const f of p.frames) f.layers["N1"] = allocIndexBuf(p);
  check("2: 普通のレイヤーは 600 コマぶん増える", projectBytes(p) - after === 600 * ONE);
}

// ---------------- 3. 16bit 昇格でちょうど2倍 ----------------
{
  const p = makeProject(100, 3);
  const before = projectBytes(p);
  promoteTo16(p);
  check("3: 16bit 昇格でちょうど2倍", projectBytes(p) === before * 2, `${before} → ${projectBytes(p)}`);
  const shared = makeProject(100, 1);
  shared.layerDefs[0].shared = true;
  relinkShared(shared);
  const sb = projectBytes(shared);
  promoteTo16(shared);
  check("3: 共通レイヤーは昇格しても1枚のまま（分裂しない）", projectBytes(shared) === sb * 2);
}

// ---------------- 4. 音声もメーターに入る ----------------
{
  const p = makeProject(10, 1);
  const base = projectBytes(p);
  p.audio = {
    bgm: {
      source: "external",
      mime: "audio/mpeg",
      data: new Uint8Array(3 * 1024 * 1024),
      muted: false,
      volume: 1,
      trimStartMs: 0,
      trimEndMs: null,
      syncMode: "audioToAnim",
      baseSpeedIndex: 4,
    },
    se: [
      { id: "S1", name: "se1", source: "external", mime: "audio/wav", data: new Uint8Array(512 * KB), volume: 1, muted: false },
      { id: "S2", name: "se2", source: "external", mime: "audio/wav", data: new Uint8Array(256 * KB), volume: 1, muted: false },
    ],
  };
  check(
    "4: BGM 3MB ＋ SE 0.75MB が足される",
    projectBytes(p) === base + 3 * 1024 * KB + 512 * KB + 256 * KB,
    `${projectBytes(p) - base}`
  );
}

// ---------------- 5. entryBytes は同じ実体を1回だけ ----------------
{
  const p = makeProject(3, 1);
  const b = p.frames[0].layers["L1"];
  check("5: 同じバッファを2回渡しても1回ぶん", entryBytes(b, b) === ONE);
  check("5: 配列・レコード・入れ子を混ぜて数えられる", entryBytes([b], { a: b }, { layers: { x: b } }) === ONE);
  const c = copyIndexBuf(b);
  check("5: 別実体は別に数える", entryBytes(b, c) === ONE * 2);
  check("5: バッファ以外は 0", entryBytes(null, undefined, 1, "x", { a: 1 }) === 0);
}

// ---------------- 6. 標準エントリが bytes を自動申告 ----------------
{
  const p = makeProject(1, 2);
  const live = p.frames[0].layers["L1"] as IndexBuf;
  const before = copyIndexBuf(live);
  live[0] = 1;
  const after = copyIndexBuf(live);
  const e = bufferChangeEntry("線", () => live, before, after);
  check("6: bufferChangeEntry は before+after を申告", e.bytes === ONE * 2, `${e.bytes}`);
  const m = multiBufferChangeEntry(
    "歪み",
    (id) => p.frames[0].layers[id] ?? null,
    { L1: copyIndexBuf(live), L2: copyIndexBuf(p.frames[0].layers["L2"]) },
    { L1: copyIndexBuf(live), L2: copyIndexBuf(p.frames[0].layers["L2"]) }
  );
  check("6: multiBufferChangeEntry は4枚ぶん", m.bytes === ONE * 4, `${m.bytes}`);
}

// ---------------- 7. 統合しても「元に戻す」は減らない ----------------
{
  const p = makeProject(200, 3); // 46.1MB
  const h = new History();
  const projBefore = projectBytes(p);
  // レイヤー統合と同じ形: 消える上レイヤーと、書き換わる下レイヤーの控えを全コマぶん抱える
  const savedTop = p.frames.map((f) => copyIndexBuf(f.layers["L3"]));
  const savedBottom = p.frames.map((f) => copyIndexBuf(f.layers["L2"]));
  h.push({ label: "レイヤー統合", bytes: entryBytes(savedTop, savedBottom), undo: () => {}, redo: () => {} });
  for (const f of p.frames) delete f.layers["L3"]; // apply（統合）
  p.layerDefs = p.layerDefs.filter((l) => l.id !== "L3");
  const projAfter = projectBytes(p);
  check("7: 統合で「作品」は 200コマぶん減る", projBefore - projAfter === 200 * ONE, `${projBefore - projAfter}`);
  check("7: 「元に戻す」は減らない（控えを握ったまま）", h.totalBytes() === 200 * ONE * 2, `${h.totalBytes()}`);
  check(
    "7: 合計はほとんど減らない＝メーターが嘘をつかない",
    projAfter + h.totalBytes() > projBefore,
    `${projBefore} → ${projAfter + h.totalBytes()}`
  );
}

// ---------------- 7-b. 状態で持ち主が変わる実体（Codex レビュー対応） ----------------
{
  // 「コマ挿入」を取り消すと、コマの実体は**履歴のクロージャだけ**が持つ。
  // 申告しないと `作品` も `元に戻す` も減って「軽くなった」と誤解させる（＝メーターが無いより危険）
  const h = new History();
  const inserted = 100 * ONE; // 100コマ×1レイヤーぶん
  h.push({ label: "ページ挿入", bytesIfUndone: inserted, undo: () => {}, redo: () => {} });
  check("7-b: 適用済みの挿入は数えない（プロジェクト側にあるので二重にしない）", h.totalBytes() === 0);
  h.undo();
  check("7-b: 取り消した挿入は数える（履歴が抱えている）", h.totalBytes() === inserted);
  h.redo();
  check("7-b: やり直したら また 0", h.totalBytes() === 0);

  // 削除はその逆
  const h2 = new History();
  h2.push({ label: "コマ削除", bytesIfApplied: inserted, undo: () => {}, redo: () => {} });
  check("7-b: 適用済みの削除は数える（履歴が抱えている）", h2.totalBytes() === inserted);
  h2.undo();
  check("7-b: 取り消した削除は数えない（プロジェクトへ帰った）", h2.totalBytes() === 0);

  // スナップショット型（before/after のコピー）は状態によらず抱えたまま
  const h3 = new History();
  h3.push({ label: "線", bytes: ONE * 2, undo: () => {}, redo: () => {} });
  const applied = h3.totalBytes();
  h3.undo();
  check("7-b: スナップショット型は状態によらず同じ", applied === ONE * 2 && h3.totalBytes() === ONE * 2);
}

// ---------------- 8. 履歴の予算（W-4） ----------------
{
  const h = new History();
  h.budgetBytes = 10 * ONE; // 10枚ぶん
  for (let i = 0; i < 30; i++)
    h.push({ label: `s${i}`, bytes: ONE, undo: () => {}, redo: () => {} });
  check("8: 予算ぶんだけ残る（古いほうから捨てる）", h.totalBytes() <= 10 * ONE, `${h.totalBytes() / ONE}枚`);
  check("8: 捨てても Undo はできる", h.canUndo);
  // 1件で予算を超える巨大エントリでも、直前の操作は戻せる
  const h2 = new History();
  h2.budgetBytes = ONE;
  h2.push({ label: "巨大", bytes: 1000 * ONE, undo: () => {}, redo: () => {} });
  check("8: 1件で予算超過でも**最低1件は残す**", h2.canUndo && h2.totalBytes() === 1000 * ONE);
}

// ---------------- 9. 小さい作品では予算が効かない ----------------
{
  // editor.ts と同じ式（V154b: SIZE_CAUTION=192MiB＝壁 384MiB の 50% / 下限16MiB / 上限256MiB）
  const CAUTION = 192 * 1024 * KB,
    MIN = 16 * 1024 * KB,
    MAX = 256 * 1024 * KB;
  const budget = (p: Project) => Math.max(MIN, Math.min(MAX, CAUTION - projectBytes(p)));
  const small = makeProject(50, 3); // 11.5MB
  const h = new History();
  h.budgetBytes = budget(small);
  // 64件（履歴の上限）ぶん積んでも予算に当たらない＝従来どおりの手触り
  for (let i = 0; i < 64; i++) h.push({ label: `s${i}`, bytes: ONE * 2, undo: () => {}, redo: () => {} });
  check(
    "9: 50コマの作品では 64件ぶん積んでも予算に当たらない",
    h.totalBytes() === 64 * ONE * 2 && h.totalBytes() < h.budgetBytes,
    `${Math.round(h.totalBytes() / 1024 / KB)}MB < ${Math.round(h.budgetBytes / 1024 / KB)}MB`
  );
  const big = makeProject(700, 3); // 161.3MB
  check("9: 大きい作品では予算が縮む", budget(big) < budget(small), `${Math.round(budget(big) / 1024 / KB)}MB`);
  const huge = makeProject(1200, 3); // 276.5MB（注意しきい値を超える）
  check("9: しきい値を超えたら下限 16MB", budget(huge) === MIN);
}

// ---------------- 10. 読み込みの壁（V154b・作者の訂正） ----------------
{
  // 壁は V8 の文字列上限 536,870,888 文字を base64 の 4/3 で割ったもの＝384.0 MiB。
  // base64 が一律 4/3 なので**ビット幅によらず同じバイト数**（面数の上限だけが変わる）
  check("10: 壁は 402,653,166 B = 384.0 MiB", LOAD_WALL_BYTES === 402_653_166);
  check(
    "10: MiB 換算がちょうど 384.0",
    Math.round((LOAD_WALL_BYTES / 1024 / KB) * 10) / 10 === 384.0,
    `${LOAD_WALL_BYTES / 1024 / KB}`
  );
  check("10: 8bit の面数上限 5,242", loadWallFaces(8) === 5242);
  check("10: 16bit の面数上限 2,621", loadWallFaces(16) === 2621);
  // しきい値は壁の内側にある（**警告より先に開けなくなる**ことが無い）
  const CAUTION = 192 * 1024 * KB,
    WARN = 288 * 1024 * KB;
  check("10: 注意は壁の 50%", CAUTION * 2 === 384 * 1024 * KB);
  check("10: 警告は壁の 75%", WARN * 4 === 3 * 384 * 1024 * KB);
  check("10: 警告 < 壁（旧しきい値 512MiB は壁の向こうだった）", WARN < LOAD_WALL_BYTES);
  check("10: 旧しきい値は壁の外だったことを記録", 512 * 1024 * KB > LOAD_WALL_BYTES);

  // 面数は**保存の JSON に並ぶ数**＝コマごとのレイヤー数の合計。
  // 📌 全コマ共通レイヤーはメモリでは1つでも、JSON にはコマごとに書かれる（数え方が違う）
  const p = makeProject(100, 3);
  check("10: 面数 = 100コマ×3レイヤー = 300", projectFaces(p) === 300);
  p.layerDefs.push({ id: "S1", name: "共通", visible: true, opacity: 1, shared: true });
  relinkShared(p);
  check(
    "10: 📌 は実体1つでも**面数は100増える**（JSON にはコマごとに並ぶ）",
    projectFaces(p) === 400 && projectBytes(p) === (300 + 1) * ONE,
    `faces=${projectFaces(p)} bytes=${projectBytes(p) / ONE}面ぶん`
  );

  // 再現データ（1,098コマ × 20レイヤー・8bit）は上限の 4.2 倍
  const faces = 1098 * 20;
  check("10: 再現データは 21,960 面", faces === 21960);
  check(
    "10: 再現データは 8bit の上限を超える（＝開けない）",
    faces > loadWallFaces(8),
    `${faces} > ${loadWallFaces(8)}（${(faces / loadWallFaces(8)).toFixed(1)} 倍）`
  );
}

console.log(`v154 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
