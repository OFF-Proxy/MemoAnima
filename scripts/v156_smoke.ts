// V156 (P-1): 眠り（見えていないコマを圧縮して持つ）の回帰ゲート。引数不要:
//   npx tsx scripts/v156_smoke.ts
//
// ★この回でいちばん危険なのは「編集が静かに消える」こと（要件 §1 P-1 の条件5）。
//   だから検査の中心は**睡眠サイクル検査**——遠くのコマを編集 → 眠らせる → 起こす →
//   保存 → 読み込みで、1画素も変わっていないこと。
//
// 1. 圧縮→展開が可逆（8bit / 16bit）
// 2. 論理サイズ（面数・メーター）が眠っても変わらない ＝ 門番2つが黙らない
// 3. 保存が**全コマを起こさない**／眠っていても**保存バイト列が同じ**
// 4. ★睡眠サイクル検査（条件5）
// 5. ★網が効く: 書いた経路を数え漏らしても**絵は失われない**（＋ログに出る）
// 6. ★検査そのものが効いている: 網を壊すと 5 が赤くなる
// 7. 16bit 昇格が眠っているコマを起こさない・値が保たれる
// 8. 📌 全コマ共通レイヤーは眠らない
// 9. A-35: コマ数が合わないファイルはうるさく失敗する
// 10. P-2: Undo 200手 ＋ バイト予算（申告のあるエントリが予算どおりに削れる）
import {
  newProject,
  makeEmptyFrame,
  allocIndexBuf,
  promoteTo16,
  projectBytes,
  projectFaces,
  relinkShared,
  PIXELS,
  type IndexBuf,
  type Project,
} from "../src/editor/model";
import { projectToBytes, projectFromBytes, createFrameHeadCounter } from "../src/editor/serialize";
import { History, bufferChangeEntry, entryBytes } from "../src/editor/history";
import {
  wakeFrame,
  wakeLayer,
  sleepFrame,
  sleepLayer,
  invalidateLayer,
  asleepCount,
  awakeBytes,
  sleepBytes,
  fingerprint,
  setStaleSleepLogger,
} from "../src/editor/sleep";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}

function make(frames: number, layers: number, seed = 1): Project {
  const p = newProject("V156");
  p.layerDefs = [];
  for (let i = 0; i < layers; i++)
    p.layerDefs.push({ id: `L${i + 1}`, name: `L${i + 1}`, visible: true, opacity: 1 });
  p.frames = [];
  for (let f = 0; f < frames; f++) {
    const fr = makeEmptyFrame(p, 0);
    fr.layers = {};
    for (const ld of p.layerDefs) {
      const b = allocIndexBuf(p);
      // コマごと・レイヤーごとに違う絵（gzip が効きすぎて検査にならないのを防ぐ）
      for (let k = (f * 7 + seed) % 53; k < PIXELS; k += 53) b[k] = ((k + f) % 6) + 1;
      fr.layers[ld.id] = b;
    }
    p.frames.push(fr);
  }
  return p;
}

/** 2つの作品の絵が1バイトも違わないか（眠っているぶんは起こしてから比べる） */
async function sameArt(a: Project, b: Project): Promise<boolean> {
  if (a.frames.length !== b.frames.length) return false;
  for (let i = 0; i < a.frames.length; i++) {
    await wakeFrame(a, a.frames[i], "read");
    await wakeFrame(b, b.frames[i], "read");
    if (a.frames[i].paper !== b.frames[i].paper) return false;
    const ka = Object.keys(a.frames[i].layers).sort();
    const kb = Object.keys(b.frames[i].layers).sort();
    if (ka.join() !== kb.join()) return false;
    for (const id of ka) {
      const x = a.frames[i].layers[id];
      const y = b.frames[i].layers[id];
      if (!y || x.length !== y.length) return false;
      for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
    }
  }
  return true;
}

const eqBytes = (x: Uint8Array, y: Uint8Array) => {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

const main = async () => {
  // ---------------- 1. 可逆 ----------------
  for (const bits of [8, 16] as const) {
    const p = make(6, 3);
    if (bits === 16) promoteTo16(p);
    const before: Record<string, number[]> = {};
    for (let i = 0; i < p.frames.length; i++)
      for (const id of Object.keys(p.frames[i].layers))
        before[`${i}/${id}`] = Array.from(p.frames[i].layers[id]);
    for (const f of p.frames) await sleepFrame(p, f);
    check(`1(${bits}bit): 全部眠った`, asleepCount(p) === 18, `${asleepCount(p)}`);
    check(`1(${bits}bit): 生バッファが残っていない`, awakeBytes(p) === 0, `${awakeBytes(p)}`);
    for (const f of p.frames) await wakeFrame(p, f, "read");
    let ok = true;
    for (const [k, v] of Object.entries(before)) {
      const [fi, id] = k.split("/");
      const buf = p.frames[Number(fi)].layers[id];
      if (!buf || buf.length !== v.length) { ok = false; break; }
      for (let i = 0; i < v.length; i++) if (buf[i] !== v[i]) { ok = false; break; }
      if (!ok) break;
    }
    check(`1(${bits}bit): 圧縮→展開が1バイトも違わない`, ok);
  }

  // ---------------- 2. 論理サイズ（門番の入力）が変わらない ----------------
  {
    const p = make(40, 4);
    const bytes0 = projectBytes(p);
    const faces0 = projectFaces(p);
    for (const f of p.frames) await sleepFrame(p, f);
    check("2: メーターの数字が眠っても変わらない（＝門番が黙らない）", projectBytes(p) === bytes0, `${projectBytes(p)} / ${bytes0}`);
    check("2: 面数が眠っても変わらない", projectFaces(p) === faces0, `${projectFaces(p)} / ${faces0}`);
    check("2: 実メモリは実際に減っている", awakeBytes(p) === 0 && sleepBytes(p) < bytes0 / 5,
      `圧縮後 ${sleepBytes(p)} / 論理 ${bytes0}`);
  }

  // ---------------- 3. 保存が全コマを起こさない・バイト列が同じ ----------------
  {
    const p1 = make(20, 3, 2);
    const p2 = make(20, 3, 2);
    // 作った時刻も揃える（`newProject` が現在時刻を入れるので、揃えないと本文が1文字違う）
    p1.meta.createdAt = p2.meta.createdAt = "2026-08-29T00:00:00.000Z";
    const awake = await projectToBytes(p1); // 全部起きたまま保存
    for (const f of p2.frames) await sleepFrame(p2, f);
    const before = asleepCount(p2);
    const slept = await projectToBytes(p2); // 全部眠ったまま保存
    check("3: 保存しても眠ったまま（全コマを起こさない）", asleepCount(p2) === before, `${asleepCount(p2)} / ${before}`);
    check("3: 保存中に生バッファを溜めない", awakeBytes(p2) === 0, `${awakeBytes(p2)}`);
    // modifiedAt だけは保存のたびに変わるので、そこだけ伏せて**中身をまるごと**比べる
    const text = async (b: Uint8Array) =>
      new TextDecoder()
        .decode(
          new Uint8Array(
            await new Response(
              new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
            ).arrayBuffer()
          )
        )
        .replace(/"modifiedAt":"[^"]*"/, '"modifiedAt":"-"');
    const ta = await text(awake);
    const tb = await text(slept);
    check("3: ★眠っていても保存した中身が1文字も違わない", ta === tb,
      ta.length === tb.length ? "長さは同じだが中身が違う" : `長さ ${ta.length} / ${tb.length}`);
    const q = await projectFromBytes(slept);
    check("3: 眠ったまま保存したものが読み戻せる", q.frames.length === 20 && (await sameArt(p1, q)));
  }

  // ---------------- 4. ★睡眠サイクル検査（条件5） ----------------
  {
    const p = make(60, 3, 3);
    const FAR = 47; // 「遠くのコマ」
    // 全部眠らせる
    for (const f of p.frames) await sleepFrame(p, f);
    check("4: 下ごしらえ（全部眠っている）", asleepCount(p) === 180, `${asleepCount(p)}`);

    // 遠くのコマを**編集する**（＝書きで起こす。控えは捨てられるはず）
    const buf = await wakeLayer(p, p.frames[FAR], "L2", "write");
    check("4: 書きで起こすと控えが捨てられている", !p.frames[FAR].sleep?.L2);
    for (let k = 0; k < PIXELS; k += 3) buf![k] = 5; // 目立つ編集
    const edited = Array.from(buf!);

    // 眠らせる → 起こす
    await sleepFrame(p, p.frames[FAR]);
    check("4: 編集したコマが眠った", !p.frames[FAR].layers.L2 && !!p.frames[FAR].sleep?.L2);
    await wakeFrame(p, p.frames[FAR], "read");
    const back = p.frames[FAR].layers.L2;
    let same = back.length === edited.length;
    if (same) for (let i = 0; i < edited.length; i++) if (back[i] !== edited[i]) { same = false; break; }
    check("4: 眠らせて起こしても編集が残っている", same);

    // 保存 → 読み込み
    for (const f of p.frames) await sleepFrame(p, f);
    const q = await projectFromBytes(await projectToBytes(p));
    const got = q.frames[FAR].layers.L2;
    let same2 = got.length === edited.length;
    if (same2) for (let i = 0; i < edited.length; i++) if (got[i] !== edited[i]) { same2 = false; break; }
    check("4: ★編集 → 眠り → 起こし → 保存 → 読込 でピクセル一致", same2);
  }

  // ---------------- 5. ★網（数え漏らしても絵は失われない） ----------------
  //  「書きで起こす」を通さずに（＝経路の数え漏れを模して）読みで起こしたバッファへ書く。
  //  控えは古いままだが、眠らせるときの指紋の突き合わせが気づいて圧縮し直すはず。
  {
    const p = make(10, 2, 4);
    for (const f of p.frames) await sleepFrame(p, f);
    let logged = 0;
    setStaleSleepLogger(() => logged++);
    const buf = await wakeLayer(p, p.frames[5], "L1", "read"); // ← わざと read
    check("5: 読みで起こすと控えが残る（条件2）", !!p.frames[5].sleep?.L1);
    for (let k = 0; k < PIXELS; k += 11) buf![k] = 4; // ★数え漏れの模擬（invalidate を呼ばない）
    const edited = Array.from(buf!);
    await sleepFrame(p, p.frames[5]);
    check("5: 網が気づいてログに出す", logged === 1, `${logged}`);
    await wakeFrame(p, p.frames[5], "read");
    const back = p.frames[5].layers.L1;
    let same = true;
    for (let i = 0; i < edited.length; i++) if (back[i] !== edited[i]) { same = false; break; }
    check("5: ★数え漏れがあっても編集は失われない", same);
    setStaleSleepLogger(null);
  }

  // ---------------- 6. ★検査が効いていること（網を外すと 5 が赤くなる） ----------------
  //  「網が無かったら本当に消えるのか」を、同じ手順で**網を通さずに**再現する。
  //  ここが「消える」と出なければ、5 の合格には意味が無い（v155 §8 と同じ流儀）。
  {
    const p = make(10, 2, 4);
    for (const f of p.frames) await sleepFrame(p, f);
    const buf = await wakeLayer(p, p.frames[5], "L1", "read");
    const original = Array.from(buf!);
    for (let k = 0; k < PIXELS; k += 11) buf![k] = 4;
    // 網を外した眠らせ方＝「控えがあるならそのまま信じて捨てる」
    delete p.frames[5].layers.L1;
    p.frames[5].sleep!.L1.live = null;
    await wakeFrame(p, p.frames[5], "read");
    const back = p.frames[5].layers.L1;
    let revertedToOld = true;
    for (let i = 0; i < original.length; i++) if (back[i] !== original[i]) { revertedToOld = false; break; }
    check("6: ★網を外すと編集は本当に消える（＝検査 5 に意味がある）", revertedToOld,
      revertedToOld ? "" : "網を外しても消えなかった＝検査 5 が何も守っていない");
  }

  // ---------------- 7. 16bit 昇格が眠っているコマを起こさない ----------------
  {
    const p = make(12, 2, 5);
    const want: number[][] = [];
    for (const f of p.frames) want.push(Array.from(f.layers.L1));
    for (const f of p.frames) await sleepFrame(p, f);
    const asleepBefore = asleepCount(p);
    promoteTo16(p);
    check("7: 昇格しても眠ったまま（起こさない）", asleepCount(p) === asleepBefore, `${asleepCount(p)} / ${asleepBefore}`);
    check("7: 昇格後も生バッファが増えていない", awakeBytes(p) === 0, `${awakeBytes(p)}`);
    let ok = true;
    for (let i = 0; i < p.frames.length; i++) {
      const b = await wakeLayer(p, p.frames[i], "L1", "read");
      if (!(b instanceof Uint16Array)) { ok = false; break; }
      for (let k = 0; k < want[i].length; k++) if (b[k] !== want[i][k]) { ok = false; break; }
      if (!ok) break;
    }
    check("7: 起こすと 16bit になっていて、値も同じ（昇格は可逆）", ok);
    const q = await projectFromBytes(await projectToBytes(p));
    check("7: 昇格＋眠りの状態で保存 → 読込ができる", q.indexBits === 16 && q.frames.length === 12);
    check("7: その中身も一致", await sameArt(p, q));
  }

  // ---------------- 8. 📌 は眠らない ----------------
  {
    const p = make(15, 3, 6);
    p.layerDefs[1].shared = true;
    relinkShared(p);
    const shared = new Set(p.layerDefs.filter((l) => l.shared).map((l) => l.id));
    for (const f of p.frames) await sleepFrame(p, f, shared);
    let sharedAsleep = 0;
    for (const f of p.frames) if (!f.layers.L2) sharedAsleep++;
    check("8: 📌 は眠っていない（全コマで起きたまま）", sharedAsleep === 0, `${sharedAsleep}`);
    check("8: それ以外は眠っている", asleepCount(p) === 15 * 2, `${asleepCount(p)}`);
    // 実体が1つのままであること（📌 の不変条件）
    const first = p.frames[0].layers.L2;
    let sameRef = true;
    for (const f of p.frames) if (f.layers.L2 !== first) { sameRef = false; break; }
    check("8: 📌 の実体は全コマで1つのまま", sameRef);
    const q = await projectFromBytes(await projectToBytes(p));
    check("8: 眠り＋📌 で保存 → 読込ができる", q.frames.length === 15);
    check("8: その中身も一致", await sameArt(p, q));
  }

  // ---------------- 9. A-35: コマ数の突き合わせ ----------------
  //  読み込みは「切り分けが吐いたコマ数」と「別実装で数えた頭の数」を突き合わせる。
  //  片方（数え上げ）はここで**切れ目を総当たり**して正しさを固める。
  //  もう片方（切り分け）は v155_smoke §8 が同じ総当たりで見ている。
  {
    const p = make(5, 2, 7);
    const gz = await projectToBytes(p);
    const text = new TextDecoder().decode(
      new Uint8Array(
        await new Response(
          new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
        ).arrayBuffer()
      )
    );
    const trueCount = text.split('{"paper":').length - 1;
    check("9: 下ごしらえ（本文に頭が5つある）", trueCount === 5, `${trueCount}`);

    const feed = (cut: (n: number) => number): number => {
      const c = createFrameHeadCounter();
      let i = 0;
      for (let n = 0; i < text.length; n++) {
        const to = Math.min(text.length, Math.max(i + 1, cut(n)));
        c.push(text.slice(i, to));
        i = to;
      }
      return c.count();
    };
    check("9: 一括で数えて 5", feed(() => text.length) === 5, `${feed(() => text.length)}`);
    check("9: 1文字ずつ流しても 5", feed((n) => n + 1) === 5, `${feed((n) => n + 1)}`);
    let ngStep = 0;
    for (let step = 1; step <= 300; step++) if (feed((n) => (n + 1) * step) !== 5) { ngStep = step; break; }
    check("9: 刻み 1〜300 の総当たりでも 5", ngStep === 0, `刻み ${ngStep} で外れた`);
    // 頭をまたぐ切れ方（V155 で実際に踏んだ形）
    let ngAt = -1;
    for (let at = text.indexOf('{"paper":'); at >= 0; at = text.indexOf('{"paper":', at + 1))
      for (let off = -9; off <= 9; off++) {
        const cutAt = at + off;
        if (cutAt <= 0 || cutAt >= text.length) continue;
        if (feed((n) => (n === 0 ? cutAt : text.length)) !== 5) { ngAt = cutAt; break; }
      }
    check("9: 頭をまたぐ切れ方（前後9文字を総当たり）でも 5", ngAt < 0, `位置 ${ngAt}`);

    // 突き合わせが**通る**こと（誤検知しない）＝正常なファイルは普通に開く
    const q = await projectFromBytes(gz);
    check("9: 正常なファイルは突き合わせを通って開く", q.frames.length === 5, `${q.frames.length}`);
  }

  // ---------------- 10. P-2: Undo 200手 ＋ バイト予算 ----------------
  //  ペン1手は `bufferChangeEntry` の before/after 2枚。
  //    8bit  : 76,800 × 2 = 153,600 B
  //    16bit : 153,600 × 2 = 307,200 B
  //  予算の下限は 64 MiB（editor.ts の HIST_BUDGET_MIN）。ここでは History 単体で確かめる。
  {
    const MiB = 1024 * 1024;
    const strokes = (bits: 8 | 16, budget: number, times: number) => {
      const h = new History();
      h.budgetBytes = budget;
      const unit = bits === 8 ? new Uint8Array(PIXELS) : new Uint16Array(PIXELS);
      for (let i = 0; i < times; i++) {
        const before = bits === 8 ? new Uint8Array(PIXELS) : new Uint16Array(PIXELS);
        const after = bits === 8 ? new Uint8Array(PIXELS) : new Uint16Array(PIXELS);
        h.push(bufferChangeEntry("ペン", () => unit, before, after));
      }
      let n = 0;
      while (h.canUndo) { h.undo(); n++; }
      return n;
    };
    check("10: 1手のバイト数（8bit 153,600 / 16bit 307,200）",
      entryBytes(new Uint8Array(PIXELS), new Uint8Array(PIXELS)) === 153600 &&
      entryBytes(new Uint16Array(PIXELS), new Uint16Array(PIXELS)) === 307200);

    // 件数の上限そのもの（MAX_ENTRIES = 200）
    const many = strokes(8, 0 /* 予算なし */, 500);
    check("10: 件数の上限が 200 手になっている（旧 64）", many === 200, `${many}`);

    // 下限 64 MiB なら 200 手が**予算でも**残る（8bit / 16bit とも）
    const b8 = strokes(8, 64 * MiB, 200);
    const b16 = strokes(16, 64 * MiB, 200);
    check("10: 予算 64 MiB で 8bit 200 手が残る", b8 === 200, `${b8}`);
    check("10: ★予算 64 MiB で **16bit でも** 200 手が残る（58.6 MiB < 64 MiB）", b16 === 200, `${b16}`);

    // 予算のほうが先に効く形（大きい作品の実サイズ基準＝115 MiB でも件数上限 200 が先）
    const b115 = strokes(8, 115 * MiB, 500);
    check("10: 予算 115 MiB でも件数上限の 200 手で止まる", b115 === 200, `${b115}`);

    // 予算が厳しいときは**古いほうから**削れて、最低1件は残る
    const tiny = strokes(8, 1 * MiB, 50);
    check("10: 予算が足りないと古い順に削れる（最低1件は残す）", tiny >= 1 && tiny < 50, `${tiny}`);
  }

  console.log(`v156 smoke: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
};

void main();
