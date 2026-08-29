// V159: 性能ログ（G-1）・マイ柄の見本（G-2）・読み込み中表示の共通入口（G-3）の回帰ゲート。引数不要:
//   npx tsx scripts/v159_smoke.ts
//
// ★この回でいちばん怖いのは1つ。**ログに作品名やパスが混ざること**。
//   このログは「作者が普段の作業で取って Cowork へ送る」前提で作っている。
//   1行でも作品名やフォルダのパスが入れば、送ってもらうこと自体ができなくなる（W-10）。
//   だから 1〜3 で「書ける形」そのものを縛る。
//
// 1. ★ログに出せるのは**列挙された操作名と数値だけ**（形を正規表現で縛る）
// 2. ★呼び出し側が勝手な文字列を渡していない（`perfDone(` / `runWithBusy(` の第1引数を全走査）
// 3. ★文脈が数値でなくても、書かれるのは数値だけ（型を信じずに実行時も確かめる）
// 4. しきい値: 50ms 未満は書かない／50ms 以上は書く
// 5. 計測は溜めてから1回で流す（1操作ごとに IPC しない＝測るために遅くしない）
// 6. G-3 の共通入口: 短い処理では出さない／遅れて出す／どの抜け方でも畳む／入れ子でも1枚
// 7. G-2: マイ柄の見本だけ元の大きさ・組み込みトーンの縮小は維持
import fs from "node:fs";
import path from "node:path";
import {
  perfDone,
  perfNow,
  setPerfSink,
  setPerfContext,
  flush,
  _pendingForTest,
  _resetForTest,
  PERF_MIN_MS,
  PERF_LONG_MS,
} from "../src/perf";
import { runWithBusy, setBusyImpl, busyVisible, BUSY_DELAY_MS, _resetForTest as busyReset } from "../src/ui/busy";

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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `perf.ts` が書ける行の**唯一の形**。ここに当たらない行は出せてはいけない。 */
const LINE_RE =
  /^\[perf\] (?:[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)? ms=\d+(?: f=\d+ l=\d+ s=\d+)?|long ms=\d+ during=[a-z.\-]+ busy=(?:yes|no))$/;

/** `perf.ts` の `PerfOp` に並んでいる操作名（ソースから読む＝二重管理しない）。 */
const OPS = (() => {
  const src = fs.readFileSync(path.join(root, "src/perf.ts"), "utf8");
  const block = src.match(/export type PerfOp =([\s\S]*?);/);
  if (!block) throw new Error("PerfOp が読めない");
  return new Set((block[1].match(/"([a-z.]+)"/g) ?? []).map((x) => x.slice(1, -1)));
})();

// ---------------------------------------------------------------- 1. 行の形
{
  _resetForTest();
  const out: string[] = [];
  setPerfSink((text) => out.push(text));
  setPerfContext(() => ({ f: 1098, l: 20, s: 21960 }));
  perfDone("save", perfNow() - 1234);
  perfDone("frame.goto", perfNow() - 60);
  flush();
  const lines = out.join("\n").split("\n");
  check("1 2行とも書かれた", lines.length === 2, lines.join(" / "));
  check("1 ★どの行も決められた形（操作名と数値だけ）", lines.every((l) => LINE_RE.test(l)), lines.join(" / "));
  check("1 所要msが入る", /save ms=12\d\d/.test(lines[0]), lines[0]);
  check("1 文脈（コマ数・レイヤー数・面数）が入る", lines[0].endsWith(" f=1098 l=20 s=21960"), lines[0]);
  check(
    "1 ★作品名・パスになりうる文字が1つも無い",
    !/[\\/:]|[^\x20-\x7e]/.test(lines.join("")),
    lines.join(" / ")
  );
}

// ---------------------------------------------------------------- 2. 呼び出し側（全走査）
{
  const FILES = [
    "src/editor/editor.ts",
    "src/main.ts",
    "src/library.ts",
    "src/ui/busy.ts",
  ];
  const bad: string[] = [];
  let calls = 0;
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const m of src.matchAll(/\b(?:perfDone|perfSync|perfAsync|runWithBusy)\(\s*([^,\s)]+)/g)) {
      // `op` のような**変数**を渡している呼び方は、そこから何でも書けるので許さない
      const arg = m[1];
      calls++;
      if (arg === "op") continue; // busy.ts が受け取った PerfOp をそのまま渡す1か所（型で縛られている）
      if (!/^"[a-z.]+"$/.test(arg)) {
        bad.push(`${f}: ${arg}`);
        continue;
      }
      if (!OPS.has(arg.slice(1, -1))) bad.push(`${f}: ${arg} は PerfOp に無い`);
    }
  }
  check("2 ★操作名は文字列リテラルで、PerfOp に載っているものだけ", bad.length === 0, bad.join(" / "));
  check("2 呼び出しが実際にある（走査が空振りしていない）", calls >= 15, `${calls} か所`);
}

// ---------------------------------------------------------------- 3. 文脈が壊れていても数値だけ
{
  _resetForTest();
  const out: string[] = [];
  setPerfSink((text) => out.push(text));
  // 型を無視して**作品名を混ぜようとしてみる**（実際にこうは書けないが、書けたとしても漏れない）
  setPerfContext(() => ({ f: "ぼくのメモ" as unknown as number, l: NaN, s: 5 }));
  perfDone("open.project", perfNow() - 200);
  flush();
  check("3 ★型を破っても書かれるのは数値だけ", LINE_RE.test(out[0]), out[0]);
  check("3 数値でない値は 0 になる", out[0].includes(" f=0 l=0 s=5"), out[0]);
}

// ---------------------------------------------------------------- 4. しきい値
{
  _resetForTest();
  const out: string[] = [];
  setPerfSink((text) => out.push(text));
  perfDone("tool.switch", perfNow() - (PERF_MIN_MS - 10)); // 未満
  flush();
  check(`4 ${PERF_MIN_MS}ms 未満は1文字も書かない`, out.length === 0, out.join(" / "));
  perfDone("tool.switch", perfNow() - (PERF_MIN_MS + 10)); // 以上
  flush();
  check(`4 ${PERF_MIN_MS}ms 以上は書く`, out.length === 1 && /tool\.switch ms=\d+/.test(out[0]), out.join(" / "));
  check("4 長タスクのしきい値はしきい値より大きい", PERF_LONG_MS > PERF_MIN_MS);
}

// ---------------------------------------------------------------- 5. まとめて流す
{
  _resetForTest();
  let calls = 0;
  setPerfSink(() => calls++);
  for (let i = 0; i < 5; i++) perfDone("frame.add", perfNow() - 100);
  check("5 溜めている間は流さない（IPC を1操作ごとに撃たない）", calls === 0);
  check("5 溜まっている行は5本", _pendingForTest().length === 5);
  flush();
  check("5 流すのは1回だけ（5行を1本にまとめる）", calls === 1);
  check("5 流したあとは空", _pendingForTest().length === 0);
}

// ---------------------------------------------------------------- 6. G-3 の共通入口
{
  _resetForTest();
  busyReset();
  let shown = 0;
  let hidden = 0;
  setBusyImpl(() => {
    shown++;
    return () => hidden++;
  });

  // ① 一瞬で終わる処理では**出さない**（チラつかない）
  await runWithBusy("open.preview", "…", async () => {});
  check("6 短い処理では出さない（チラつかない）", shown === 0 && !busyVisible());

  // ② 遅延を過ぎたら出て、終わったら畳む
  const slow = runWithBusy("open.project", "…", () => sleep(BUSY_DELAY_MS + 120));
  await sleep(BUSY_DELAY_MS - 100);
  check("6 遅延の途中ではまだ出ない", shown === 0);
  await sleep(200);
  check("6 遅延を過ぎたら出る", shown === 1 && busyVisible());
  await slow;
  check("6 終わったら畳む", hidden === 1 && !busyVisible());

  // ③ 例外でも畳む（出したまま操作不能にしない）
  shown = 0;
  hidden = 0;
  let threw = false;
  try {
    await runWithBusy("open.note", "…", async () => {
      await sleep(BUSY_DELAY_MS + 80);
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  check("6 ★例外でも必ず畳む", threw && shown === 1 && hidden === 1 && !busyVisible());

  // ④ 入れ子でも箱は1枚
  shown = 0;
  hidden = 0;
  await runWithBusy("open.project", "…", async () => {
    await runWithBusy("open.preview", "…", () => sleep(BUSY_DELAY_MS + 80));
    await sleep(60);
  });
  check("6 入れ子でも1枚だけ", shown === 1 && hidden === 1 && !busyVisible());

  // ⑤ 中の値はそのまま返る
  const v = await runWithBusy("open.preview", "…", async () => 42);
  check("6 戻り値をそのまま返す", v === 42);

  // ⑥ ★重なった処理（Codex 指摘①）: A が終わっても B がまだ走っていれば**畳まない**。
  //    棚のメモ A → すぐ B、で「B の読み込み中だけ画面が無表示に戻る」を防ぐ
  shown = 0;
  hidden = 0;
  const a = runWithBusy("open.preview", "…", () => sleep(BUSY_DELAY_MS + 150));
  await sleep(60);
  const b = runWithBusy("open.preview", "…", () => sleep(BUSY_DELAY_MS + 900));
  await sleep(BUSY_DELAY_MS + 200);
  check("6 重なっていても箱は1枚", shown === 1 && busyVisible());
  await a;
  await sleep(80);
  check("6 ★先に始めたほうが終わっても、まだ走っていれば畳まない", busyVisible() && hidden === 0);
  await b;
  await sleep(80);
  check("6 全部終わったら畳む", !busyVisible() && hidden === 1);
}

// ---------------------------------------------------------------- 8. 古い読み込みが画面を乗っ取らない
{
  // Codex 指摘①の後半。棚のクリックは `void this.select(it)` で投げっぱなしなので、
  // 重い A → 軽い B と押すと A が後から終わって B を上書きし得る。世代番号で降ろす。
  const src = fs.readFileSync(path.join(root, "src/library.ts"), "utf8");
  const sel = src.match(/async select\(it: LibraryView\) \{[\s\S]*?\n  \}\n/);
  check("8 select() が読める", !!sel);
  const body = sel?.[0] ?? "";
  const awaits = (body.match(/await /g) ?? []).length;
  const guards = (body.match(/stale\(\)/g) ?? []).length;
  check("8 ★世代番号を採番している", /const seq = \+\+this\.selectSeq;/.test(body));
  check(
    `8 ★await のあとに古さの検査がある（await ${awaits} / 検査 ${guards}）`,
    guards >= 4,
    body.slice(0, 60)
  );
  check(
    "8 ★音を鳴らす直前に検査がある（エディタの裏で鳴り出さない）",
    /if \(stale\(\)\) return;\s*\n\s*const note/.test(body)
  );
  check(
    "8 ★プレビューへ入れる直前に検査がある（新しい選択を上書きしない）",
    /if \(stale\(\)\) return;\s*\n\s*this\.previewProject = proj;/.test(body)
  );
  check(
    "8 ★画面を離れるとき（suspend）に世代を進める",
    /suspend\(\) \{[\s\S]{0,400}?this\.selectSeq\+\+;/.test(src)
  );
}

// ---------------------------------------------------------------- 7. G-2 見本の大きさ
{
  const css = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");
  const rule = (sel: string) => {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
    if (!m) return null;
    const w = m[1].match(/width:\s*(\d+)px/);
    const h = m[1].match(/height:\s*(\d+)px/);
    return w && h ? [Number(w[1]), Number(h[1])] : null;
  };
  const custom = rule(".tone-btn.custom canvas");
  const normal = rule(".tone-btn canvas");
  const wide = rule(".tone-btn.tone-wide canvas");
  check("7 ★マイ柄の見本は 64×64（正方形＝登録時と同じ見え方）", !!custom && custom[0] === 64 && custom[1] === 64, String(custom));
  check("7 組み込みトーンの縮小は維持（96×32）", !!normal && normal[0] === 96 && normal[1] === 32, String(normal));
  check("7 2列ぶちぬきも維持（144×32）", !!wide && wide[0] === 144 && wide[1] === 32, String(wide));
  // マイ柄のバッキングは正方形のまま（CSS だけで戻していることの確認）
  const ts = fs.readFileSync(path.join(root, "src/editor/editor.ts"), "utf8");
  check(
    "7 マイ柄のバッキングは正方形のまま（TS 側は無変更）",
    /cv\.width = CUSTOM_CHIP_PX;\s*\n\s*cv\.height = CUSTOM_CHIP_PX;/.test(ts)
  );
  check(
    "7 マイ柄の規則が組み込みトーンの規則より**後ろ**にある（打ち消せる位置）",
    css.indexOf(".tone-btn.custom canvas") > css.indexOf(".tone-btn canvas")
  );
}

_resetForTest();
busyReset();
console.log(`v159 smoke: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
