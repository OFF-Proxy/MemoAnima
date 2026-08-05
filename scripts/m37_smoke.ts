// M3.7 レイヤーフォルダ スモークテスト（データ層）
// AC-F2(実効値)/F4(v4往復)/F5(旧互換・v5拒否・壊れparent隔離)/order独立 の機械検証

import {
  newProject,
  ensureColor,
  effectiveLayerStates,
  sanitizeFolders,
  PIXELS,
} from "../src/editor/model";
import {
  moveNodes,
  wouldCycle,
  topNodesOf,
  checkContiguity,
  folderLayerIndices,
} from "../src/editor/layerTree";
import { compositeFrame } from "../src/editor/render";
import { projectToBytes, projectFromBytes } from "../src/editor/serialize";

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

console.log(`m37 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
