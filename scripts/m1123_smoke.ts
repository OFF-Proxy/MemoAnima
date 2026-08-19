// M11-23 スモーク: 書き出しの事前見積もり（メモリ・時間）・危険域の閾値・残り時間の目安（純関数）
// 引数不要:  npx tsx scripts/m1123_smoke.ts
// ※ ダイアログの実機確認は m11_23_a.mjs（実 exe・ペン/マウス）
(globalThis as unknown as { self: unknown }).self = globalThis; // exporter.ts は gif.js（self 参照）を静的 import
// M12-1a: 文言を pin しているので表示言語を ja に固定する（既定は環境依存の detectLang）
import { setLang } from "../src/i18n";
setLang("ja");
const {
  estimateExport,
  HOLDS_ALL_FRAMES,
  RISK_MEMORY_BYTES,
  RISK_SECONDS,
  formatDuration,
  formatBytes,
  createEtaEstimator,
} = await import("../src/editor/exporter");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}
/** 実測に対する相対誤差 */
const near = (est: number, actual: number, tol: number) => Math.abs(est - actual) / actual <= tol;

// ---------- 見積もりの係数が release exe の実測を再現するか（±15%） ----------
// 実測は配布ビルド（src-tauri/target/release/MemoAnima.exe）の実 UI で「書き出し」を押してから進捗 100% まで。
// M11-22 §3 は tauri:dev の実測で 1.5〜4 倍遅く、そのままだと推定が過大になるので release で較正した（M11-23 報告 §3）。
{
  const cases: [string, Parameters<typeof estimateExport>[0], number][] = [
    ["MP4 ×8", { format: "mp4", scale: 8, frames: 100 }, 14.44],
    ["MP4 ×4", { format: "mp4", scale: 4, frames: 100 }, 5.198],
    ["GIF 6色 ×8", { format: "gif", scale: 8, frames: 100, gifColors: 6 }, 6.14],
    ["GIF 6色 ×4", { format: "gif", scale: 4, frames: 100, gifColors: 6 }, 1.797],
    ["GIF 246色 ×8", { format: "gif", scale: 8, frames: 100, gifColors: 246 }, 127.81],
    ["GIF 246色 ×4", { format: "gif", scale: 4, frames: 100, gifColors: 246 }, 32.06],
    ["GIF 246色 ×8・40コマ（コマ数方向の検算）", { format: "gif", scale: 8, frames: 40, gifColors: 246 }, 51.76],
    ["GIF 306色(NeuQuant) ×8", { format: "gif", scale: 8, frames: 100, gifColors: null }, 31.19],
    ["GIF 306色(NeuQuant) ×4", { format: "gif", scale: 4, frames: 100, gifColors: null }, 9.42],
    ["APNG ×8", { format: "apng", scale: 8, frames: 100 }, 6.591],
    ["APNG ×4", { format: "apng", scale: 4, frames: 100 }, 1.925],
    ["PNG連番 ×8", { format: "pngzip", scale: 8, frames: 100 }, 2.636],
    ["PNG連番 ×4", { format: "pngzip", scale: 4, frames: 100 }, 1.813],
  ];
  for (const [name, opt, actual] of cases) {
    const e = estimateExport(opt);
    check(`時間の見積もりが実測と ±15% 以内: ${name}（実測 ${actual}s）`, near(e.seconds, actual, 0.15), `est=${e.seconds.toFixed(1)}s`);
  }
}
// ---------- メモリ（全コマ保持型だけ） ----------
{
  check("全コマ保持は GIF/APNG のみ（MP4・PNG連番は対象外）", HOLDS_ALL_FRAMES.gif && HOLDS_ALL_FRAMES.apng && !HOLDS_ALL_FRAMES.mp4 && !HOLDS_ALL_FRAMES.pngzip);
  const g = estimateExport({ format: "gif", scale: 8, frames: 100, gifColors: 6 });
  // 表示は Windows と同じ数え方（GiB）。1.97×10⁹ バイト = 1.8GiB・実測ピーク +2.3GB(WorkingSet) と桁一致
  check("GIF 100コマ×8 のメモリ = 100×2560×1920×4（1.8GB 表示）・実測ピークと桁一致", g.memBytes === 100 * 2560 * 1920 * 4 && formatBytes(g.memBytes) === "1.8GB" && near(g.memBytes, 2.3 * 1024 ** 3, 0.25), formatBytes(g.memBytes));
  const a = estimateExport({ format: "apng", scale: 8, frames: 100 });
  check("APNG も同じ式（実測 +2.2GB）", a.memBytes === g.memBytes);
  for (const f of ["mp4", "pngzip"] as const) {
    const e = estimateExport({ format: f, scale: 8, frames: 300 });
    check(`${f} は 300コマ×8 でもメモリ 0（保持しない）・メモリ理由で危険にならない`, e.memBytes === 0 && !e.reasons.includes("memory"));
  }
}
// ---------- 危険域の境界 ----------
{
  const risky = (o: Parameters<typeof estimateExport>[0]) => estimateExport(o).risky;
  const g100x8 = estimateExport({ format: "gif", scale: 8, frames: 100, gifColors: 6 });
  check("100コマ×8 GIF（6色）はメモリだけで危険域（1.8GB ≥ 1.5GB・時間は 6 秒）", g100x8.risky && g100x8.reasons.join() === "memory", `${formatBytes(g100x8.memBytes)}/${g100x8.seconds.toFixed(1)}s`);
  check("100コマ×8 APNG も危険域", risky({ format: "apng", scale: 8, frames: 100 }));
  check("10コマ×4 GIF は危険域でない（49MB・0.2秒）", !risky({ format: "gif", scale: 4, frames: 10, gifColors: 6 }));
  check("10コマ×8 GIF は危険域でない（197MB・0.6秒）", !risky({ format: "gif", scale: 8, frames: 10, gifColors: 6 }));
  check("100コマ×8 MP4 は危険域でない（14秒・メモリ対象外）", !risky({ format: "mp4", scale: 8, frames: 100 }));
  check("100コマ×8 PNG連番 は危険域でない（2.6秒）", !risky({ format: "pngzip", scale: 8, frames: 100 }));
  const gif246 = estimateExport({ format: "gif", scale: 8, frames: 100, gifColors: 246 });
  check("100コマ×8 GIF 246色は「メモリ」と「時間」の両方で危険（1.8GB・128秒）", gif246.reasons.includes("memory") && gif246.reasons.includes("time"));
  const gif246x4 = estimateExport({ format: "gif", scale: 4, frames: 100, gifColors: 246 });
  check("100コマ×4 GIF 246色は危険域でない（32秒・492MB＝どちらも閾値未満）", !gif246x4.risky, `${gif246x4.seconds.toFixed(1)}s`);
  const gif200x4 = estimateExport({ format: "gif", scale: 4, frames: 200, gifColors: 246 });
  check("200コマ×4 GIF 246色は時間だけで危険（64秒・メモリ 938MB）", gif200x4.risky && gif200x4.reasons.join() === "time", `${gif200x4.seconds.toFixed(1)}s/${formatBytes(gif200x4.memBytes)}`);
  // ダイアログの代替案（main.ts）は「1段下の倍率」を同じ式で見積もって、そこも危険域なら「確実です」と言わない
  const gif200x8 = estimateExport({ format: "gif", scale: 8, frames: 200, gifColors: 246 });
  check("代替案の判定: 200コマ×8（危険）の1段下 ×4 も危険＝「×4 なら確実です」とは言えない", gif200x8.risky && gif200x4.risky);
  check("代替案の判定: 100コマ×8（危険）の1段下 ×4 は安全＝「×4 なら確実です」と言える", g100x8.risky && !estimateExport({ format: "gif", scale: 4, frames: 100, gifColors: 6 }).risky);
  check("代替案の判定: 200コマ×4（危険）の1段下 ×2 は安全（235MB・16秒）", gif200x4.risky && !estimateExport({ format: "gif", scale: 2, frames: 200, gifColors: 246 }).risky);
  // メモリ閾値のちょうど境界: 76コマ×8 = 1.50GB
  const nAtLimit = Math.ceil(RISK_MEMORY_BYTES / (2560 * 1920 * 4));
  check(`メモリ閾値の境界: ${nAtLimit}コマ×8 で危険・${nAtLimit - 1}コマ×8 では危険でない`, risky({ format: "gif", scale: 8, frames: nAtLimit, gifColors: 6 }) && !risky({ format: "gif", scale: 8, frames: nAtLimit - 1, gifColors: 6 }));
  check("閾値の値（メモリ 1.5GB・時間 60秒）", RISK_MEMORY_BYTES === 1.5 * 1024 ** 3 && RISK_SECONDS === 60);
  // MP4「曲の長さで書き出す」: 映像を曲の尺までループするので、実際にエンコードされるコマ数で見積もる
  {
    const short = estimateExport({ format: "mp4", scale: 8, frames: 24 });
    const looped = estimateExport({ format: "mp4", scale: 8, frames: 24, encodedFrames: 1440 }); // 3分の曲×8fps
    check("MP4 24コマ（3秒）は危険域でない（5秒）", !short.risky && short.encodedFrames === 24, `${short.seconds.toFixed(1)}s`);
    check("同じ作品に3分の曲を付けて「曲の長さで書き出す」と危険域（1440コマぶん＝約3分）", looped.risky && looped.reasons.join() === "time" && looped.encodedFrames === 1440, `${looped.seconds.toFixed(0)}s`);
    check("表示用のコマ数は作品のコマ数のまま（24コマ）・メモリは MP4 なので 0", looped.frames === 24 && looped.memBytes === 0);
    check("encodedFrames は frames を下回らない（未指定・小さい値でも安全）", estimateExport({ format: "gif", scale: 4, frames: 50, encodedFrames: 10, gifColors: 6 }).encodedFrames === 50);
  }
  // 300コマ×8（REQ 背景の「落ちる恐れ」）は 5.9GB
  const big = estimateExport({ format: "gif", scale: 8, frames: 300, gifColors: 6 });
  check("300コマ×8 GIF は 5.9×10⁹ バイト＝5.5GB 表示（REQ 背景の 5〜6GB と一致）・危険域", big.memBytes === 300 * 2560 * 1920 * 4 && formatBytes(big.memBytes) === "5.5GB" && big.risky, formatBytes(big.memBytes));
}
// ---------- 表示の丸め ----------
{
  check("秒の丸めは 5 秒刻み（チカチカしない）", formatDuration(19) === "約20秒" && formatDuration(3) === "約5秒" && formatDuration(44) === "約45秒");
  check("45〜90 秒は「約1分」", formatDuration(50) === "約1分" && formatDuration(89) === "約1分");
  check("分の丸め", formatDuration(267) === "約4分" && formatDuration(600) === "約10分");
  check("負・NaN は空文字", formatDuration(-1) === "" && formatDuration(NaN) === "");
  check("バイト表記", formatBytes(1.97 * 1024 ** 3) === "2.0GB" && formatBytes(49 * 1024 ** 2) === "49MB");
}
// ---------- 残り時間の目安 ----------
{
  // 事前見積もり 19 秒の書き出し相当: フレーム生成（3秒で 0→75）→ GIFエンコード（100→150 を 6 秒）
  const eta = createEtaEstimator(19);
  let t = 0;
  check("最初の呼び出しでは出さない（基準点を取るだけ）", eta.update(0, 200, "フレーム生成", t) === "");
  t += 1000;
  check("開始 1 秒では出さない（不安定区間）", eta.update(12, 200, "フレーム生成", t) === "");
  t += 2000; // 3 秒経過・37% 進捗
  const s1 = eta.update(75, 200, "フレーム生成", t);
  check("3 秒経って十分進んだら出る", s1 !== "", s1);
  const s1b = eta.update(80, 200, "フレーム生成", t + 500);
  check("更新は 3 秒に 1 回（間の呼び出しでは同じ文字列＝乱高下しない）", s1b === s1);
  // フェーズが変わっても表示は消えない（基準は取り直す）
  const s2 = eta.update(100, 200, "GIFエンコード", t + 1000);
  check("フェーズ切替で表示は保たれる", s2 === s1, `${s1}→${s2}`);
  t += 1000 + 6000; // エンコードを 6 秒で 100→150（開始から 10 秒経過）
  const s3 = eta.update(150, 200, "GIFエンコード", t);
  // 実測 6s×(50/50)=6秒 と 下限（19−10=9秒）の大きいほう＝約10秒
  check("エンコード中は実測から出し直す（実測 6 秒と事前見積もりの残り 9 秒の大きいほう＝約10秒）", s3 === "約10秒", s3);
  check("100% まで来たら残り時間は消す（矛盾した表示を残さない）", eta.update(200, 200, "GIFエンコード", t + 6000) === "" && eta.update(200, 200, "完了", t + 6100) === "");
}
{
  // MP4 形の進捗: 「フレーム書き込み」は 0→100（total=101）だが、最後の 1 目盛が x264 エンコード全体
  // （100コマ×8 = 全体 14.4 秒のうち書き込みは 2.6 秒）。**エンコード中に表示が固まらない**ことを見る
  const eta = createEtaEstimator(14.4);
  eta.update(0, 101, "フレーム書き込み", 0);
  const w = eta.update(100, 101, "フレーム書き込み", 2600);
  // 実測だけなら「残り1目盛 = 0.03 秒」。下限（14.4−2.6=11.8 秒）が効いて約10秒
  check("MP4: 書き込みが終わっても「残り 0 秒」にならない（下限が効く）", w === "約10秒", w);
  const p2 = eta.update(100, 101, "MP4エンコード", 3000);
  check("MP4: フェーズ切替で表示は保たれる", p2 === w);
  const e1 = eta.update(100.5, 101, "MP4エンコード", 9000);
  // 6 秒で 0.5 目盛 → 残り 0.5 目盛 = 6 秒（下限は 14.4−9=5.4 秒）
  check("MP4: エンコード中も実測で更新される（1 目盛しか動かなくても固まらない）", e1 === "約5秒", e1);
  const e2 = eta.update(100.9, 101, "MP4エンコード", 21000);
  check("MP4: 進むほど短くなる（単調に減る）", e2 === "約5秒" || e2 === "約10秒", e2);
}
{
  // 短い書き出し（10コマ×4 GIF ≒ 0.2 秒）: 一度も出ない
  const eta = createEtaEstimator(0.8);
  let out = "";
  for (let i = 0; i <= 20; i++) out += eta.update(i, 20, i < 10 ? "フレーム生成" : "GIFエンコード", i * 40);
  check("短い書き出し（0.8 秒相当）では最後まで残り時間を出さない", out === "", out);
}
{
  // 事前見積もりの残り（経過ぶん減らす）を下限にする（GIF はコマ生成が速い＝実測だけだと短く出る）
  const eta = createEtaEstimator(256); // 200コマ・246色・×8 相当（事前見積もり 256 秒）
  eta.update(0, 200, "フレーム生成", 0);
  const s = eta.update(60, 200, "フレーム生成", 4000); // 実測だけなら 4s×(140/60)=9秒
  check("下限は事前見積もり−経過（約9秒ではなく 256−4=252秒＝約4分）", s === "約4分", s);
  const s2 = eta.update(120, 200, "フレーム生成", 130000); // 130 秒経過（実測 130s×80/120=87秒 > 下限 126秒 ではない）
  check("下限は経過とともに減る（130 秒後は 256−130=126 秒＝約2分）", s2 === "約2分", s2);
}
{
  // 進捗が 0 のまま・total=0 でも壊れない
  const eta = createEtaEstimator(10);
  check("total=0 でも例外にならない", eta.update(0, 0, "x", 0) === "" && eta.update(5, 0, "x", 9000) === "");
  const e2 = createEtaEstimator(10);
  e2.update(0, 100, "p", 0);
  check("進捗が動かないときは出さない", e2.update(0, 100, "p", 60000) === "");
}

console.log(`m1123 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
