// V154 (W-6): 「保存したものが読み戻せることを確かめてから確定する」の回帰スモーク
//（引数不要: npx tsx scripts/v154b_smoke.ts）
//
// 事故モデル: 報告者のフォルダに `.bak` が1つも無かった＝**保存は最後まで成功していた**。
// つまり「窓で死んだ」のではなく、**壊れたバイト列が「保存成功」として確定し、
// 正しい版（`.bak` とオートセーブ）をアプリ自身が捨てた**という筋書きが最も合う。
// ここは、その「確定してよいか」の判定（`verifySavedBytes`）だけを見る。
//
// 1. まともに保存したものは通る（コマ数も数えられる）
// 2. 長さ 0 は通らない
// 3. gzip でないものは通らない
// 4. **1バイト化けたら通らない**（gzip の CRC が効く＝これが本命）
// 5. **途中で切れていたら通らない**
// 6. コマ数が期待と違ったら通らない
// 7. 別の gzip（作品ファイルではない）は通らない
// 8. コマ数の数え方が、作品名やレイヤー名に "paper" が入っていても狂わない
// 9. 大きめの作品（300コマ）でも、展開したものを抱えずに数えられる
// 10. 読み込みの分岐（V155: 巨大でも開ける／壊れていれば壊れていると言う／非圧縮の保険）
import { gzipSync } from "fflate";
import { newProject, makeEmptyFrame, allocIndexBuf, type Project } from "../src/editor/model";
import { projectToBytes, projectFromBytes, verifySavedBytes } from "../src/editor/serialize";
import { MAX_JSON_CHARS } from "../src/editor/model";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}

function makeProject(frames: number, layers = 2, title = "V154b"): Project {
  const p = newProject(title);
  p.layerDefs = [];
  for (let i = 0; i < layers; i++)
    p.layerDefs.push({ id: `L${i + 1}`, name: `L${i + 1}`, visible: true, opacity: 1 });
  p.frames = [];
  for (let f = 0; f < frames; f++) {
    const fr = makeEmptyFrame(p, 0);
    fr.layers = {};
    for (const ld of p.layerDefs) fr.layers[ld.id] = allocIndexBuf(p);
    // 絵が全部同じだと gzip が効きすぎるので、コマごとに1ドットだけ変える
    fr.layers[p.layerDefs[0].id][f % 76800] = 1;
    p.frames.push(fr);
  }
  return p;
}

const main = async () => {
  // ---------------- 1. まともなものは通る ----------------
  const p = makeProject(12);
  const good = await projectToBytes(p);
  {
    const r = await verifySavedBytes(good, 12);
    check("1: まともな保存は通る", r.ok, r.reason);
    check("1: コマ数を数えられる", r.frames === 12, `${r.frames}`);
    check("1: 展開後の大きさが取れる", r.rawBytes > 0, `${r.rawBytes}`);
  }

  // ---------------- 2. 長さ 0 ----------------
  for (const [label, v] of [
    ["空配列", new Uint8Array(0)],
    ["null", null],
    ["undefined", undefined],
  ] as const) {
    const r = await verifySavedBytes(v as Uint8Array | null | undefined, 12);
    check(`2: ${label} は通らない`, !r.ok, r.reason);
  }

  // ---------------- 3. gzip ではない ----------------
  {
    const r = await verifySavedBytes(new TextEncoder().encode('{"magic":"ANIMEMO"}'), 12);
    check("3: 非圧縮の JSON は通らない", !r.ok && r.reason.startsWith("not-gzip"), r.reason);
  }

  // ---------------- 4. 1バイト化ける（本命） ----------------
  {
    let broken = 0;
    // 先頭のヘッダ・中ほど・末尾の CRC 付近をそれぞれ壊す
    for (const at of [2, Math.floor(good.length / 2), good.length - 3]) {
      const bad = good.slice();
      bad[at] = bad[at] ^ 0xff;
      const r = await verifySavedBytes(bad, 12);
      if (!r.ok) broken++;
      else console.log(`  （${at} バイト目を壊しても通ってしまった）`);
    }
    check("4: どこを1バイト壊しても通らない", broken === 3, `${broken}/3`);
  }

  // ---------------- 5. 途中で切れている ----------------
  {
    const cuts = [1, Math.floor(good.length / 2), good.length - 1];
    let caught = 0;
    for (const n of cuts) {
      const r = await verifySavedBytes(good.slice(0, n), 12);
      if (!r.ok) caught++;
    }
    check("5: 途中で切れていたら通らない", caught === cuts.length, `${caught}/${cuts.length}`);
  }

  // ---------------- 6. コマ数が違う ----------------
  {
    const r = await verifySavedBytes(good, 13);
    check("6: コマ数が期待と違えば通らない", !r.ok && r.reason.startsWith("frames-mismatch"), r.reason);
    const r2 = await verifySavedBytes(good, -1);
    check("6: 期待値に負数を渡すとコマ数は見ない", r2.ok && r2.frames === 12, r2.reason);
  }

  // ---------------- 7. 別の gzip ----------------
  {
    const other = gzipSync(new TextEncoder().encode('{"hello":"world"}'));
    const r = await verifySavedBytes(other, 12);
    check("7: 作品ファイルでない gzip は通らない", !r.ok && r.reason.startsWith("bad-header"), r.reason);
  }

  // ---------------- 8. 名前に "paper" が入っていても数え方が狂わない ----------------
  {
    const q = makeProject(5, 2, 'paper "paper": の作品');
    q.layerDefs[0].name = '"paper":';
    q.meta.source = { name: '{"paper": 1}.kwz' };
    const bytes = await projectToBytes(q);
    const r = await verifySavedBytes(bytes, 5);
    check("8: 作品名/レイヤー名に paper が入っても 5 コマと数える", r.ok && r.frames === 5, `${r.frames} / ${r.reason}`);
  }

  // ---------------- 9. 大きめの作品（チャンク境界をまたぐ） ----------------
  {
    const big = makeProject(300, 3);
    const bytes = await projectToBytes(big);
    const t0 = Date.now();
    const r = await verifySavedBytes(bytes, 300);
    const ms = Date.now() - t0;
    check("9: 300コマでも数えられる（境界で取りこぼさない）", r.ok && r.frames === 300, `${r.frames} / ${r.reason}`);
    console.log(
      `  参考: 300コマ・3レイヤー → 圧縮 ${(bytes.length / 1024 / 1024).toFixed(1)}MB / ` +
        `展開 ${(r.rawBytes / 1024 / 1024).toFixed(1)}MB / 検証 ${ms}ms`
    );
  }

  // ---------------- 10. 読み込み失敗の文言（V154b・「嘘をつかない」） ----------------
  // 事故: 展開に失敗した catch が gzip の生バイトを JSON 扱いして
  //   `SyntaxError: Unexpected token '�' ... is not valid JSON`
  // になり、**1バイトも壊れていないのに「データが壊れている」としか読めない**画面が出ていた
  {
    // (a) 正常系は不変（まともなファイルはそのまま開ける）
    const p10 = makeProject(3);
    const ok = await projectToBytes(p10);
    const back = await projectFromBytes(ok);
    check("10: 正常な読み込みは変わらない", back.frames.length === 3);

    // (b) gzip の末尾（ISIZE）を書き換えたものは、**展開そのものが失敗する**
    //     ＝「壊れている」と言う。V154b ではここで「大きすぎて」と言っていたが、
    //     それは当時 ISIZE で門番をしていたから。V155 で門番を外したので、
    //     ISIZE の不一致は**素直に gzip の検査に落ちる**（そちらのほうが正しい）。
    //     ★「壁を越える作品が開けること」の検査は scripts/v155_smoke.ts（本物の大きさで作る）
    const huge = ok.slice();
    const n = huge.length;
    const isize = MAX_JSON_CHARS + 1000;
    huge[n - 4] = isize & 0xff;
    huge[n - 3] = (isize >>> 8) & 0xff;
    huge[n - 2] = (isize >>> 16) & 0xff;
    huge[n - 1] = (isize >>> 24) & 0xff;
    let msgH = "";
    try {
      await projectFromBytes(huge);
    } catch (e) {
      msgH = String((e as Error).message);
    }
    check("10: ISIZE を壊したら「壊れている」と言う", msgH.includes("壊れて"), msgH);
    check("10: **メッセージが空にならない**（型で見分ける・V155）", msgH.length > 10, `"${msgH}"`);

    // (c) **本当に壊れている**とき: 「壊れている」と言い、「大きすぎて」とは言わない
    const broken = ok.slice();
    broken[Math.floor(broken.length / 2)] ^= 0xff; // CRC が合わなくなる
    let msg2 = "";
    try {
      await projectFromBytes(broken);
    } catch (e) {
      msg2 = String((e as Error).message);
    }
    check("10: 壊れているときは「壊れている」と言う", msg2.includes("壊れて"), msg2);
    check("10: 大きすぎるときの文言と混ざらない", !msg2.includes("大きすぎて"), msg2);
    check("10: JSON の話（is not valid JSON）を出さない", !/valid JSON|Unexpected token/.test(msg2), msg2);

    // (d) gzip のマジックが無いときだけ、旧・非圧縮の保険が効く（前方互換を壊さない）
    const plain = new TextEncoder().encode(JSON.stringify({ magic: "ANIMEMO", version: 999 }));
    let msg3 = "";
    try {
      await projectFromBytes(plain);
    } catch (e) {
      msg3 = String((e as Error).message);
    }
    check(
      "10: 非圧縮の JSON は素通しして中身で判断する（版が新しい、と言う）",
      msg3.includes("999") || msg3.includes("新しい"),
      msg3
    );
  }

  console.log(`v154b smoke: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
};

void main();
