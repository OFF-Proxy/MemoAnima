// V157: レイヤーロック 🔒（D-1）とコマ単位レイヤーカラー（D-2）の回帰ゲート。引数不要:
//   npx tsx scripts/v157_smoke.ts
//
// ★この回でいちばん怖いのは2つ:
//   ① 任意キーを足したせいで**旧ビルド（v1.5.6）が開けなくなる**こと
//   ② コマ単位の色を**眠っているコマ**に付けたとき、静かに効かない／消えること（V156 条件5 の隣）
//
// 1. locked が保存 → 読み込みで残る／壊れた値はキーごと落ちる
// 2. 実効ロック＝自分 OR 祖先（フォルダ）／`ancestorLocked` は自分を含めない
// 3. 複数レイヤー操作（moveTargetLayerIds）が実効ロックを除外する
// 4. コマ単位の色: 指定したコマだけ変わる／索引は1ビットも変わらない／解除で完全復帰
// 5. ★睡眠サイクル＋色（眠っているコマに色 → 眠らせ直し → 起こす → 保存 → 読込）
// 6. 色もロックも無い作品は、保存の本文に新しいキーが1文字も出ない
// 7. 旧ビルド互換（軽い版）: 新しいキーを**知らない読み手**に見せても絵が完全一致
//    ※ v1.5.6 の**実コード**で読ませる検証は `docs/handoff/V157_report.md` §2（使い捨てで実施）
import {
  newProject,
  makeEmptyFrame,
  allocIndexBuf,
  effectiveLayerStates,
  ancestorLocked,
  PIXELS,
  type Project,
} from "../src/editor/model";
import { projectToBytes, projectFromBytes } from "../src/editor/serialize";
import { compositeFrame } from "../src/editor/render";
import { moveTargetLayerIds } from "../src/editor/layerTree";
import { wakeFrame, sleepFrame, asleepCount } from "../src/editor/sleep";

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
  const p = newProject("V157");
  p.layerDefs = [];
  for (let i = 0; i < layers; i++)
    p.layerDefs.push({ id: `L${i + 1}`, name: `L${i + 1}`, visible: true, opacity: 1 });
  p.frames = [];
  for (let f = 0; f < frames; f++) {
    const fr = makeEmptyFrame(p, 0);
    fr.layers = {};
    // レイヤーごとに**違う場所**へ置く（同じ絵にすると上のレイヤーが下を完全に覆い、
    // 「下のレイヤーの色を変えても見た目が変わらない」＝検査が何も見なくなる）
    p.layerDefs.forEach((ld, li) => {
      const b = allocIndexBuf(p);
      for (let k = (f * 7 + seed + li * 11) % 53; k < PIXELS; k += 53) b[k] = ((k + f + li) % 6) + 1;
      fr.layers[ld.id] = b;
    });
    p.frames.push(fr);
  }
  return p;
}

const gunzipText = async (b: Uint8Array) =>
  new TextDecoder().decode(
    new Uint8Array(
      await new Response(
        new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
      ).arrayBuffer()
    )
  );

const sameU32 = (a: Uint32Array, b: Uint32Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 全コマ・全レイヤーの索引が1バイトも違わないか */
async function sameIndex(a: Project, b: Project): Promise<boolean> {
  if (a.frames.length !== b.frames.length) return false;
  for (let i = 0; i < a.frames.length; i++) {
    await wakeFrame(a, a.frames[i], "read");
    await wakeFrame(b, b.frames[i], "read");
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

const main = async () => {
  // ---------------- 1. locked の往復と健全化 ----------------
  {
    const p = make(3, 3);
    p.layerDefs[1].locked = true;
    p.folders = [{ id: "F1", name: "f", visible: true, opacity: 1, collapsed: false, locked: true }];
    p.layerDefs[2].parent = "F1";
    const q = await projectFromBytes(await projectToBytes(p));
    check("1: レイヤーの 🔒 が保存 → 読み込みで残る", q.layerDefs[1].locked === true);
    check("1: フォルダの 🔒 が保存 → 読み込みで残る", q.folders?.[0]?.locked === true);
    check("1: 版は 5 のまま", true); // 下の 7 で本文から直接確かめる

    // 壊れた値（true 以外）はキーごと落ちる＝「解除できないロック」を作らない
    const text = await gunzipText(await projectToBytes(p));
    const broken = text
      .replace('"locked":true', '"locked":"yes"')
      .replace('"locked":true', '"locked":1');
    const gz = new Uint8Array(
      await new Response(
        new Blob([new TextEncoder().encode(broken) as BlobPart])
          .stream()
          .pipeThrough(new CompressionStream("gzip"))
      ).arrayBuffer()
    );
    const r = await projectFromBytes(gz);
    const anyLocked =
      r.layerDefs.some((l) => "locked" in l) || (r.folders ?? []).some((f) => "locked" in f);
    check("1: 壊れた locked はキーごと落ちる（解除できないロックを作らない）", !anyLocked);
  }

  // ---------------- 2. 実効ロック（自分 OR 祖先） ----------------
  {
    const p = make(2, 4);
    p.folders = [
      { id: "F1", name: "親", visible: true, opacity: 1, collapsed: false },
      { id: "F2", name: "子", visible: true, opacity: 1, collapsed: false, parent: "F1" },
    ];
    p.layerDefs[0].parent = "F1";
    p.layerDefs[1].parent = "F2";
    p.layerDefs[2].locked = true; // 自分だけロック（フォルダの外）
    let eff = effectiveLayerStates(p);
    check("2: 素の状態ではどれもロックされていない", eff.get("L1")?.locked === false);
    check("2: 自分の 🔒 は効く", eff.get("L3")?.locked === true);

    p.folders[0].locked = true; // 親をロック
    eff = effectiveLayerStates(p);
    check("2: 親フォルダの 🔒 が直下に効く", eff.get("L1")?.locked === true);
    check("2: 親フォルダの 🔒 が**孫**にも効く（ネスト）", eff.get("L2")?.locked === true);
    check("2: 無関係なレイヤーには効かない", eff.get("L4")?.locked === false);
    check("2: 子の個別 locked は書き換えられていない", p.layerDefs[1].locked === undefined);

    check("2: ancestorLocked は自分を含めない（自分の🔒は外せる）", ancestorLocked(p, p.layerDefs[2].parent) === false);
    check("2: ancestorLocked が親の🔒を見る", ancestorLocked(p, "F2") === true);

    p.folders[0].locked = undefined as unknown as true;
    delete p.folders[0].locked;
    eff = effectiveLayerStates(p);
    check("2: 親を解除すると中身のロックも消える", eff.get("L1")?.locked === false);
    check("2: 個別の🔒だけが残る", eff.get("L3")?.locked === true);
  }

  // ---------------- 3. 複数レイヤー操作が実効ロックを除外 ----------------
  {
    const p = make(2, 3);
    const all = ["L1", "L2", "L3"];
    check(
      "3: ロックが無ければ3枚とも対象（既存の挙動を1ミリも変えない）",
      moveTargetLayerIds(p, all, "L1", 0).join() === "L1,L2,L3"
    );
    p.layerDefs[1].locked = true;
    check(
      "3: 🔒 を1枚混ぜると、その1枚だけ対象から外れる",
      moveTargetLayerIds(p, all, "L1", 0).join() === "L1,L3"
    );
    p.layerDefs[1].visible = false;
    check(
      "3: 実効可視の除外は従来どおり（併用しても壊れない）",
      moveTargetLayerIds(p, all, "L1", 0).join() === "L1,L3"
    );
  }

  // ---------------- 4. コマ単位の色 ----------------
  {
    const p = make(5, 2, 2);
    const out0 = compositeFrame(p, 2, undefined, { onion: 0 });
    const base0 = new Uint32Array(out0); // 付ける前のコマ2
    const other0 = new Uint32Array(compositeFrame(p, 3, undefined, { onion: 0 }));
    const idxBefore = Array.from(p.frames[2].layers.L1);

    p.frames[2].layerColors = { L1: "#ff00ff" };
    const after2 = new Uint32Array(compositeFrame(p, 2, undefined, { onion: 0 }));
    const after3 = new Uint32Array(compositeFrame(p, 3, undefined, { onion: 0 }));
    check("4: 指定したコマは見た目が変わる", !sameU32(base0, after2));
    check("4: 指定していないコマは1画素も変わらない", sameU32(other0, after3));
    let idxSame = true;
    for (let i = 0; i < idxBefore.length; i++)
      if (p.frames[2].layers.L1[i] !== idxBefore[i]) { idxSame = false; break; }
    check("4: ★索引（IndexBuf）は1ビットも変わらない", idxSame);

    delete p.frames[2].layerColors;
    check("4: 解除で完全に元へ戻る", sameU32(base0, new Uint32Array(compositeFrame(p, 2, undefined, { onion: 0 }))));

    // レイヤー既定との2段構え（コマ側が勝つ）
    p.layerDefs[0].displayColor = "#00ff00";
    const layerOnly = new Uint32Array(compositeFrame(p, 2, undefined, { onion: 0 }));
    p.frames[2].layerColors = { L1: "#ff00ff" };
    const frameWins = new Uint32Array(compositeFrame(p, 2, undefined, { onion: 0 }));
    check("4: コマ側の指定がレイヤー既定より優先される", !sameU32(layerOnly, frameWins));
    delete p.frames[2].layerColors;
    check("4: コマ側を外すとレイヤー既定へ戻る", sameU32(layerOnly, new Uint32Array(compositeFrame(p, 2, undefined, { onion: 0 }))));

    // 往復
    p.frames[1].layerColors = { L2: "#123456" };
    p.frames[2].layerColors = { L1: "#ff00ff" };
    const q = await projectFromBytes(await projectToBytes(p));
    check("4: 保存 → 読み込みで色が残る", q.frames[2].layerColors?.L1 === "#ff00ff" && q.frames[1].layerColors?.L2 === "#123456");
    check("4: 色を付けていないコマにはキーが無い", q.frames[0].layerColors === undefined);
    check("4: 索引も往復で一致", await sameIndex(p, q));

    // 壊れた色は落ちる
    const text = await gunzipText(await projectToBytes(p));
    const bad = text.replace('"#ff00ff"', '"red"');
    const gz = new Uint8Array(
      await new Response(
        new Blob([new TextEncoder().encode(bad) as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
      ).arrayBuffer()
    );
    const r = await projectFromBytes(gz);
    check("4: 壊れた色（#RRGGBB でない）は落ちる", r.frames[2].layerColors?.L1 === undefined);
    check("4: 同じコマの正しい色は残る", r.frames[1].layerColors?.L2 === "#123456");
  }

  // ---------------- 5. ★睡眠サイクル＋色（V156 条件5 の隣） ----------------
  //  眠っているコマに色を付けても、(a) 静かに飛ばされない (b) 眠らせ直しても消えない
  //  (c) 絵（索引）も壊れない——の3つを1本で見る。
  //  色は**画素ではない**ので圧縮控え（sleep）には入らない＝控えを捨てる必要はないが、
  //  「`f.layers` を見て絞ると眠っているコマだけ飛ばされる」事故は起こり得る。そこを塞ぐ検査。
  {
    const p = make(40, 2, 3);
    const FAR = 31;
    const before = new Uint32Array(compositeFrame(p, FAR, undefined, { onion: 0 }));
    const idxBefore = Array.from(p.frames[FAR].layers.L1);

    for (const f of p.frames) await sleepFrame(p, f);
    check("5: 下ごしらえ（全部眠っている）", asleepCount(p) === 80, `${asleepCount(p)}`);
    check("5: 眠っているコマにも layers のキーは無い", p.frames[FAR].layers.L1 === undefined);

    // ★眠っているコマに色を付ける（editor の applyFrameLayerColor と同じ触り方＝frames[i] を直に）
    const f = p.frames[FAR];
    if (!f.layerColors) f.layerColors = {};
    f.layerColors.L1 = "#ff00ff";
    check("5: 眠ったまま色が付く（起こさずに済む）", asleepCount(p) === 80 && !!p.frames[FAR].layerColors?.L1);

    // 眠らせ直す → 起こす
    await sleepFrame(p, p.frames[FAR]);
    await wakeFrame(p, p.frames[FAR], "read");
    check("5: 眠らせ直して起こしても色が残る", p.frames[FAR].layerColors?.L1 === "#ff00ff");
    let idxSame = true;
    for (let i = 0; i < idxBefore.length; i++)
      if (p.frames[FAR].layers.L1[i] !== idxBefore[i]) { idxSame = false; break; }
    check("5: 同じく絵（索引）も1バイトも変わっていない", idxSame);
    check("5: 見た目は変わっている（色が効いている）", !sameU32(before, new Uint32Array(compositeFrame(p, FAR, undefined, { onion: 0 }))));

    // 保存 → 読み込み
    for (const fr of p.frames) await sleepFrame(p, fr);
    const q = await projectFromBytes(await projectToBytes(p));
    check("5: ★眠り → 保存 → 読込 で色が残る", q.frames[FAR].layerColors?.L1 === "#ff00ff");
    check("5: ★同じく絵も一致", await sameIndex(p, q));
    // 色を外すと完全復帰
    delete q.frames[FAR].layerColors;
    await wakeFrame(q, q.frames[FAR], "read");
    check("5: 色を外すと見た目が元へ戻る", sameU32(before, new Uint32Array(compositeFrame(q, FAR, undefined, { onion: 0 }))));
  }

  // ---------------- 6. 使っていない作品には新しいキーが出ない ----------------
  {
    const text = await gunzipText(await projectToBytes(make(4, 2, 5)));
    check("6: locked が本文に出ない", !text.includes('"locked"'));
    check("6: layerColors が本文に出ない", !text.includes('"layerColors"'));
    check("6: 版は 5 のまま", text.includes('"version":5'));
  }

  // ---------------- 7. 旧ビルド互換（新しいキーを知らない読み手） ----------------
  //  旧ビルドは `locked` / `layerColors` を**知らないキーとして読み飛ばす**。
  //  その状況を「本文から新しいキーを消したもの」で作り、**絵が1バイトも違わない**ことを見る。
  //  （v1.5.6 の実コードで読ませる検証は報告書 §2。あちらは使い捨てのスクリプトで実施）
  {
    const p = make(4, 2, 9);
    p.layerDefs[0].locked = true;
    p.folders = [{ id: "F1", name: "f", visible: true, opacity: 1, collapsed: false, locked: true }];
    p.frames[1].layerColors = { L1: "#ff00ff" };
    p.frames[2].layerColors = { L2: "#00ffff" };
    const gz = await projectToBytes(p);
    const text = await gunzipText(gz);
    check("7: 版は 5 のまま（旧ビルドが版で撥ねない）", text.includes('"version":5'));

    // 新しいキーを丸ごと落とす＝「知らないので読み飛ばした」状態
    const stripped = text
      .replace(/,"locked":true/g, "")
      .replace(/"locked":true,/g, "")
      .replace(/,"layerColors":\{[^}]*\}/g, "");
    check("7: 下ごしらえ（新しいキーが消えている）",
      !stripped.includes('"locked"') && !stripped.includes('"layerColors"'));
    const oldGz = new Uint8Array(
      await new Response(
        new Blob([new TextEncoder().encode(stripped) as BlobPart])
          .stream()
          .pipeThrough(new CompressionStream("gzip"))
      ).arrayBuffer()
    );
    const oldSide = await projectFromBytes(oldGz);
    const newSide = await projectFromBytes(gz);
    check("7: 知らないキーを外しても開ける", oldSide.frames.length === 4);
    check("7: ★絵（索引）が完全に一致", await sameIndex(oldSide, newSide));
    check("7: ロックは無視される（旧ビルドの見え方）", oldSide.layerDefs[0].locked === undefined);
    check("7: コマの色も無視される", oldSide.frames[1].layerColors === undefined);
    // 色を知らない側の合成＝新しい側から色を外した合成と一致する
    for (const f of newSide.frames) delete f.layerColors;
    let same = true;
    for (let i = 0; i < 4; i++) {
      const a = new Uint32Array(compositeFrame(oldSide, i, undefined, { onion: 0 }));
      const b = new Uint32Array(compositeFrame(newSide, i, undefined, { onion: 0 }));
      if (!sameU32(a, b)) { same = false; break; }
    }
    check("7: ★合成結果も完全に一致（色を出さないだけ）", same);
  }

  console.log(`v157 smoke: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
};

void main();
