// M3.7 レイヤーフォルダ スモークテスト（データ層）
// AC-F2(実効値)/F4(v4往復)/F5(旧互換・v5拒否・壊れparent隔離)/order独立 の機械検証

import {
  newProject,
  ensureColor,
  effectiveLayerStates,
  sanitizeFolders,
  allocIndexBuf,
  PIXELS,
} from "../src/editor/model";
import {
  moveNodes,
  wouldCycle,
  topNodesOf,
  checkContiguity,
  folderLayerIndices,
  moveTargetLayerIds,
} from "../src/editor/layerTree";
import { compositeFrame } from "../src/editor/render";
import { projectToBytes, projectFromBytes } from "../src/editor/serialize";
import { setLang } from "../src/i18n";

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

// ---- AC-F2: 実効可視/不透明度（ネスト・祖先の積） ----
{
  const p = newProject("f");
  const [l1, l2, l3] = p.layerDefs.map((l) => l.id);
  p.folders = [
    { id: "FA", name: "A", visible: true, opacity: 0.5, collapsed: false },
    { id: "FB", name: "B", visible: true, opacity: 0.5, collapsed: false, parent: "FA" },
  ];
  p.layerDefs[0].parent = "FB"; // l1 ∈ FA/FB
  p.layerDefs[1].parent = "FA"; // l2 ∈ FA
  const eff = effectiveLayerStates(p);
  check("F2 ネスト積: 0.5*0.5", Math.abs(eff.get(l1)!.opacity - 0.25) < 1e-9);
  check("F2 単段積: 0.5", Math.abs(eff.get(l2)!.opacity - 0.5) < 1e-9);
  check("F2 ルートは1", Math.abs(eff.get(l3)!.opacity - 1) < 1e-9);
  // 祖先 visible=false で子孫全滅
  p.folders[0].visible = false;
  const eff2 = effectiveLayerStates(p);
  check(
    "F2 祖先OFFで子孫非表示",
    !eff2.get(l1)!.visible && !eff2.get(l2)!.visible && eff2.get(l3)!.visible
  );
  // 合成にも反映（FA非表示の l1/l2 のドットは出ない）
  const black = ensureColor(p, "#141414");
  p.frames[0].layers[l1][0] = black;
  p.frames[0].layers[l2][1] = black;
  p.frames[0].layers[l3][2] = black;
  const pix = compositeFrame(p, 0);
  check(
    "F2 合成反映（祖先OFF）",
    (pix[0] & 0xffffff) === 0xffffff &&
      (pix[1] & 0xffffff) === 0xffffff &&
      (pix[2] & 0xffffff) !== 0xffffff
  );
}

// ---- AC-F4: v4 round-trip（所属・順序・折りたたみ・可視/不透明度） ----
{
  const p = newProject("v4");
  p.folders = [
    { id: "FA", name: "外", visible: true, opacity: 0.8, collapsed: true },
    { id: "FB", name: "内", visible: false, opacity: 0.6, collapsed: false, parent: "FA" },
  ];
  p.layerDefs[2].parent = "FB";
  p.layerDefs[1].parent = "FA";
  const p2 = await projectFromBytes(await projectToBytes(p));
  check(
    "F4 folders往復",
    JSON.stringify(p2.folders) === JSON.stringify(p.folders),
    JSON.stringify(p2.folders)
  );
  check(
    "F4 parent往復",
    p2.layerDefs[2].parent === "FB" && p2.layerDefs[1].parent === "FA" && !p2.layerDefs[0].parent
  );
  // フォルダなしなら doc から省略される
  const q = newProject("nof");
  const bytes = await projectToBytes(q);
  const ds = new DecompressionStream("gzip");
  const json = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(
        await new Response(
          new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds)
        ).arrayBuffer()
      )
    )
  );
  check("F4 空foldersは省略・version>=4", json.folders === undefined && json.version >= 4);
}

// ---- AC-F5: v1〜v3 互換・v5拒否・壊れたparent隔離 ----
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
    speedIndex: 6,
    loop: true,
    colorMode: "palette",
    nextLayerId: 2,
    meta: { title: "old" },
    frames: [{ paper: 1, layers: { L1: b64 } }],
  };
  for (const v of [1, 2, 3]) {
    const p = await projectFromBytes(await gzipJson({ ...base, version: v }));
    check(`F5 v${v}: folders=[]・全ルート`, (p.folders ?? []).length === 0 && !p.layerDefs[0].parent);
  }
  let rejected = false;
  try {
    // M5-1 で v5 が正当になったため、未来バージョンは v6 で検証
    await projectFromBytes(await gzipJson({ ...base, version: 6 }));
  } catch (e) {
    rejected = String(e).includes("アプリを更新");
  }
  check("F5 v6拒否", rejected);
  // 壊れた parent（存在しないid）と循環 → 隔離して絵は開ける
  const broken = await projectFromBytes(
    await gzipJson({
      ...base,
      version: 4,
      layerDefs: [{ id: "L1", name: "A", visible: true, opacity: 1, parent: "GHOST" }],
      folders: [
        { id: "FA", name: "a", visible: true, opacity: 1, collapsed: false, parent: "FB" },
        { id: "FB", name: "b", visible: true, opacity: 1, collapsed: false, parent: "FA" },
      ],
    })
  );
  check("F5 壊れparent隔離（レイヤー）", broken.layerDefs[0].parent === undefined);
  const cycleBroken =
    broken.folders!.some((f) => f.parent === undefined) &&
    effectiveLayerStates(broken).get("L1") !== undefined;
  check("F5 循環隔離・実効値計算が落ちない", cycleBroken);
}

// ---- 描画順との独立: parent変更で layerDefs順・frames[].order 不変 ----
{
  const p = newProject("ord");
  p.frames[0].order = [...p.layerDefs.map((l) => l.id)].reverse();
  const orderBefore = [...p.frames[0].order];
  const defsBefore = p.layerDefs.map((l) => l.id).join();
  p.folders = [{ id: "FA", name: "A", visible: true, opacity: 1, collapsed: false }];
  p.layerDefs[1].parent = "FA";
  sanitizeFolders(p);
  check(
    "order独立: parent変更でorder/defs順不変",
    p.frames[0].order!.join() === orderBefore.join() &&
      p.layerDefs.map((l) => l.id).join() === defsBefore
  );
}

// ---- M3.8 AC-LA-5: DnD移動（layerTree.moveNodes）の並べ替え/所属変更/複数移動 ----
{
  const ids = (p: ReturnType<typeof newProject>) => p.layerDefs.map((l) => l.id).join();
  // 呼び出し側の作法をエミュレート: changedPhys のときだけ order 標準化
  const applyOrderRule = (p: ReturnType<typeof newProject>, changed: boolean) => {
    if (changed) for (const f of p.frames) f.order = undefined;
  };

  // (1) 行間gap: 最下位レイヤーを最上位へ → 物理順変化・order標準化・連続性維持
  {
    const p = newProject("dnd1");
    const [l1] = p.layerDefs.map((l) => l.id);
    p.frames[0].order = [...p.layerDefs.map((l) => l.id)].reverse();
    const r = moveNodes(p, [l1], { type: "gap", parent: undefined, phys: 3 });
    applyOrderRule(p, r.changedPhys);
    check(
      "LA5-1 gap並べ替え: 順序・order標準化",
      r.ok && r.changedPhys && ids(p).endsWith(l1) && p.frames[0].order === undefined
    );
    check("LA5-1 連続性", checkContiguity(p));
  }

  // (2) 所属変更のみ（物理順不変）→ frames[].order を保持
  {
    const p = newProject("dnd2");
    const [l1, l2, l3] = p.layerDefs.map((l) => l.id);
    p.folders = [{ id: "FA", name: "A", visible: true, opacity: 1, collapsed: false }];
    p.layerDefs[1].parent = "FA";
    p.layerDefs[2].parent = "FA";
    const custom = [l3, l2, l1];
    p.frames[0].order = [...custom];
    const before = ids(p);
    const r = moveNodes(p, [l1], { type: "into", folder: "FA" }); // 直下ブロックの末尾へ＝物理不変
    applyOrderRule(p, r.changedPhys);
    check(
      "LA5-2 所属変更のみ: 物理順不変・order保持",
      r.ok &&
        !r.changedPhys &&
        ids(p) === before &&
        p.layerDefs[0].parent === "FA" &&
        p.frames[0].order!.join() === custom.join()
    );
    check("LA5-2 連続性", checkContiguity(p));
  }

  // (3) フォルダ行ドロップ: 末尾の子（表示最下位）として挿入
  {
    const p = newProject("dnd3");
    const [l1, l2, l3] = p.layerDefs.map((l) => l.id);
    p.folders = [{ id: "FA", name: "A", visible: true, opacity: 1, collapsed: false }];
    p.layerDefs[0].parent = "FA";
    p.layerDefs[1].parent = "FA";
    const r = moveNodes(p, [l3], { type: "into", folder: "FA" });
    applyOrderRule(p, r.changedPhys);
    check(
      "LA5-3 フォルダへ: 末尾の子・連続性",
      r.ok &&
        r.changedPhys &&
        ids(p) === [l3, l1, l2].join() &&
        p.layerDefs.every((l) => l.parent === "FA") &&
        checkContiguity(p)
    );
  }

  // (4) 複数選択（飛び飛び）をまとめてフォルダへ → 相対順維持・連続性
  {
    const p = newProject("dnd4");
    p.layerDefs.push(
      { id: "L4", name: "D", visible: true, opacity: 1 },
      { id: "L5", name: "E", visible: true, opacity: 1 }
    );
    const [l1, , l3] = p.layerDefs.map((l) => l.id);
    p.folders = [{ id: "FA", name: "A", visible: true, opacity: 1, collapsed: false }];
    p.layerDefs[2].parent = "FA"; // l3 ∈ FA
    const r = moveNodes(p, [l1, "L4"], { type: "into", folder: "FA" });
    applyOrderRule(p, r.changedPhys);
    const fa = folderLayerIndices(p, "FA").map((i) => p.layerDefs[i].id);
    check(
      "LA5-4 複数移動: 相対順維持（l1がL4の下）・全員FA・連続性",
      r.ok &&
        fa.join() === [l1, "L4", l3].join() &&
        p.layerDefs.find((l) => l.id === l1)!.parent === "FA" &&
        p.layerDefs.find((l) => l.id === "L4")!.parent === "FA" &&
        checkContiguity(p)
    );
  }

  // (5) フォルダごとネストへ移動（空フォルダへ=物理不変）＋トップノードのdedup
  {
    const p = newProject("dnd5");
    const [, l2, l3] = p.layerDefs.map((l) => l.id);
    p.folders = [
      { id: "FA", name: "A", visible: true, opacity: 1, collapsed: false },
      { id: "FB", name: "B", visible: true, opacity: 1, collapsed: false },
    ];
    p.layerDefs[1].parent = "FA";
    p.layerDefs[2].parent = "FA";
    const before = ids(p);
    check("LA5-5 topNodes dedup（FA選択中の子は除外）", topNodesOf(p, ["FA", l2]).join() === "FA");
    const r = moveNodes(p, ["FA", l2], { type: "into", folder: "FB" });
    applyOrderRule(p, r.changedPhys);
    const fb = folderLayerIndices(p, "FB").map((i) => p.layerDefs[i].id);
    check(
      "LA5-5 フォルダごと移動: 空フォルダへ=物理不変・ネスト維持",
      r.ok &&
        !r.changedPhys &&
        ids(p) === before &&
        p.folders.find((f) => f.id === "FA")!.parent === "FB" &&
        fb.join() === [l2, l3].join() &&
        p.layerDefs[1].parent === "FA" && // 内部構造は不変
        checkContiguity(p)
    );
  }

  // (6) 循環禁止 & (7) フォルダの子の間への gap 挿入
  {
    const p = newProject("dnd6");
    const [l1] = p.layerDefs.map((l) => l.id);
    p.folders = [
      { id: "FA", name: "A", visible: true, opacity: 1, collapsed: false },
      { id: "FB", name: "B", visible: true, opacity: 1, collapsed: false, parent: "FA" },
    ];
    p.layerDefs[1].parent = "FA";
    p.layerDefs[2].parent = "FB";
    check("LA5-6 循環判定", wouldCycle(p, ["FA"], "FB") && !wouldCycle(p, ["FB"], undefined));
    const r = moveNodes(p, ["FA"], { type: "into", folder: "FB" });
    check("LA5-6 循環moveは失敗", !r.ok);
    // gap: FAの子(l2)とFBブロックの間へ l1 を挿す → l1 は FA の子になる
    const r2 = moveNodes(p, [l1], { type: "gap", parent: "FA", phys: 2 });
    applyOrderRule(p, r2.changedPhys);
    check(
      "LA5-7 子の間へgap挿入: parent=FA・連続性",
      r2.ok &&
        r2.changedPhys &&
        p.layerDefs.find((l) => l.id === l1)!.parent === "FA" &&
        checkContiguity(p)
    );
  }
}

// ---------------- M13-1: フォルダ末尾への差し込み（gap の parent が候補B のとき） ----------------
// 同じ隙間でも、ドラッグ中の X で「フォルダの内／外」に分かれる。X の判定は UI 側（editor.ts）だが、
// **解決後の DropTarget をデータ層が正しく処理できるか**（＝連続ブロックが崩れないか）をここで固定する。
// phys は従来の計算のまま（不変条件2）。変わるのは parent だけ、という前提の検証でもある。
{
  // 物理配置（index 0 が表示上いちばん下）: [l1(ルート), l2(FA), l3(FA)]
  const build = () => {
    const p = newProject("m13tail");
    const [l1, l2, l3] = p.layerDefs.map((l) => l.id);
    p.folders = [{ id: "FA", name: "A", visible: true, opacity: 1, collapsed: false }];
    p.layerDefs[1].parent = "FA";
    p.layerDefs[2].parent = "FA";
    return { p, l1, l2, l3 };
  };
  // 隙間は「FA の最下位の子（index 1）」と「l1（index 0）」の間 → phys = 0 + 1 = 1
  const PHYS_AT_FA_TAIL = 1;

  // (a) 候補B を選んだ場合＝フォルダの末尾の子として入る
  {
    const { p, l1 } = build();
    const r = moveNodes(p, [l1], { type: "gap", parent: "FA", phys: PHYS_AT_FA_TAIL });
    const inFA = folderLayerIndices(p, "FA");
    check(
      "M13-1 gap→フォルダ末尾: parent=FA・連続性",
      r.ok && p.layerDefs.find((l) => l.id === l1)!.parent === "FA" && checkContiguity(p)
    );
    check("M13-1 gap→フォルダ末尾: FA の子が3枚", inFA.length === 3);
    check(
      "M13-1 gap→フォルダ末尾: 末尾の子＝物理最小（表示上いちばん下）",
      p.layerDefs[inFA[0]].id === l1
    );
  }

  // (b) 候補A を選んだ場合＝従来どおりフォルダの外（同じ phys でも parent だけが違う）
  {
    const { p, l1, l2 } = build();
    const r = moveNodes(p, [l2], { type: "gap", parent: undefined, phys: PHYS_AT_FA_TAIL });
    check(
      "M13-1 gap→フォルダ外: parent=ルート・連続性",
      r.ok && p.layerDefs.find((l) => l.id === l2)!.parent === undefined && checkContiguity(p)
    );
    check("M13-1 gap→フォルダ外: FA の子が1枚に減る", folderLayerIndices(p, "FA").length === 1);
    void l1;
  }

  // (c) 折りたたみ中のフォルダでも同じ（collapsed はデータ層の移動に影響しない）
  {
    const { p, l1 } = build();
    p.folders[0].collapsed = true;
    const r = moveNodes(p, [l1], { type: "gap", parent: "FA", phys: PHYS_AT_FA_TAIL });
    check(
      "M13-1 折りたたみ中でも末尾差し込みが成立",
      r.ok && p.layerDefs.find((l) => l.id === l1)!.parent === "FA" && checkContiguity(p)
    );
  }

  // (d) 循環禁止は候補を確定させたあとも生きている
  {
    const { p } = build();
    p.folders.push({ id: "FB", name: "B", visible: true, opacity: 1, collapsed: false });
    p.folders[1].parent = "FA";
    check("M13-1 循環禁止が生きている", wouldCycle(p, ["FA"], "FB"));
  }
}

// ---------------- M13-1: 移動対象の決め方（純関数）----------------
// 展開（ネスト込み）・重複除去・非表示除外の3点を機械で確かめる。
// ここが UI 状態に触らない純関数になっているので、実機を起動せずに検証できる。
{
  //   ルート: l1
  //   FA: l2, l3, FB
  //     FB: l4
  const build = () => {
    const p = newProject("m13move");
    const [l1, l2, l3] = p.layerDefs.map((l) => l.id);
    p.folders = [
      { id: "FA", name: "A", visible: true, opacity: 1, collapsed: false },
      { id: "FB", name: "B", visible: true, opacity: 1, collapsed: false, parent: "FA" },
    ];
    p.layerDefs[1].parent = "FA";
    p.layerDefs[2].parent = "FA";
    // FB の中に1枚足す（ネストの展開を見るため）
    const l4 = `L${p.nextLayerId++}`;
    p.layerDefs.push({ id: l4, name: "D", visible: true, opacity: 1, parent: "FB" });
    p.frames[0].layers[l4] = allocIndexBuf(p, PIXELS);
    return { p, l1, l2, l3, l4 };
  };

  {
    const { p, l1 } = build();
    check("M13-1 対象: 未選択なら activeLayerId 1枚（従来の挙動）",
      JSON.stringify(moveTargetLayerIds(p, [], l1, 0)) === JSON.stringify([l1]));
  }
  {
    const { p, l2, l3, l4 } = build();
    const got = moveTargetLayerIds(p, ["FA"], null, 0).sort();
    check("M13-1 対象: フォルダはネスト込みで展開（孫まで）",
      JSON.stringify(got) === JSON.stringify([l2, l3, l4].sort()));
  }
  {
    const { p, l2, l3, l4 } = build();
    // 混在選択: FA とその中の l2 を同時に選ぶ → l2 が2回入ってはいけない（移動量が2倍になる）
    const got = moveTargetLayerIds(p, ["FA", l2], null, 0);
    check("M13-1 対象: 混在選択でも重複しない",
      got.length === new Set(got).size && got.length === 3 &&
        JSON.stringify([...got].sort()) === JSON.stringify([l2, l3, l4].sort()));
  }
  {
    const { p, l2, l3, l4 } = build();
    p.layerDefs.find((l) => l.id === l3)!.visible = false;
    const got = moveTargetLayerIds(p, ["FA"], null, 0).sort();
    check("M13-1 対象: 非表示のレイヤーだけ除かれる",
      JSON.stringify(got) === JSON.stringify([l2, l4].sort()));
  }
  {
    const { p } = build();
    p.folders[0].visible = false; // FA ごと非表示 → 中身は実効可視 false
    check("M13-1 対象: フォルダごと非表示なら0件（呼び出し側がトースト）",
      moveTargetLayerIds(p, ["FA"], null, 0).length === 0);
  }
  {
    const { p, l2, l3, l4 } = build();
    p.folders[1].visible = false; // FB だけ非表示 → 孫の l4 が落ちる
    const got = moveTargetLayerIds(p, ["FA"], null, 0).sort();
    check("M13-1 対象: ネストしたフォルダの非表示も効く（effectiveLayerStates 経由）",
      JSON.stringify(got) === JSON.stringify([l2, l3].sort()) && !got.includes(l4));
  }
  {
    const { p, l1, l2 } = build();
    delete p.frames[0].layers[l2]; // そのコマにバッファが無い
    const got = moveTargetLayerIds(p, [l1, l2], null, 0);
    check("M13-1 対象: そのコマにバッファが無いものを除く",
      JSON.stringify(got) === JSON.stringify([l1]));
  }
}

console.log(`m37 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
