// V208 (A-119): 範囲選択の境目の線（純関数・DOM に触らない・画面文言なし）。
//
// 作者の決定（2026-10-24・REQ_selection_outline §0）: 選んだあとの線は、**選んだドットの境目に沿った細い点線**
// （ドットそのものは塗らない＝絵を隠さない）。ここは「どこに線を引くか」だけを決める。描くのは editor.ts の
// 画面解像度の層（#ed-sel-ui）で、色も向こうが持つ。raster.ts（選ぶドットの決め方）は変えない。
//
// 境目＝選んだドットと、選んでいないドット（とキャンバスの外）が接する辺。頂点はドットの角（格子の交点・
// 0..w × 0..h の整数）。辺は「選んだ側を右に見て」向きを付ける（画面の座標は y が下向き＝時計回り）。
// 1 本の辺の終点からは、右・まっすぐ・左の順に続きを探す＝斜めに接する 2 ドットは別の輪になる。
// まっすぐ続く所は点を足さない（角の頂点だけを持つ）。

/** 境目の線の集まり。輪 k の頂点は pts[2*loops[k] ..< 2*loops[k+1]]（x, y の組・閉じた輪で最後の点から最初の点へ戻る） */
export interface SelOutline {
  pts: Int32Array;
  loops: Int32Array;
  /** 辺の数（長さ 1 の辺で数えた線の長さの合計）＝選んだドットの外向きの辺の数 */
  edges: number;
}

// 向き: 0=東(+x) 1=南(+y) 2=西(-x) 3=北(-y)
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** mask（w×h・0 以外が選んだドット）の境目を、閉じた線の集まりにする */
export function selectionOutline(mask: ArrayLike<number>, w: number, h: number): SelOutline {
  const V = w + 1;
  const sel = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] !== 0;
  // 頂点 (x, y) から向き d へ出る境目の辺があるか
  const has = (x: number, y: number, d: number): boolean => {
    switch (d) {
      case 0: // 東: ドット (x, y) の上の辺（上が選んでいない）
        return sel(x, y) && !sel(x, y - 1);
      case 1: // 南: ドット (x-1, y) の右の辺
        return sel(x - 1, y) && !sel(x, y);
      case 2: // 西: ドット (x-1, y-1) の下の辺
        return sel(x - 1, y - 1) && !sel(x - 1, y);
      default: // 北: ドット (x, y-1) の左の辺
        return sel(x, y - 1) && !sel(x - 1, y - 1);
    }
  };
  const used = new Uint8Array(V * (h + 1)); // 頂点ごとに、たどった向きのビット
  const pts: number[] = [];
  const loops: number[] = [0];
  let edges = 0;
  // 始点は各ドットの上の辺（東向き）。どの輪にも東向きの辺は必ずある（いちばん上の行の辺）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!sel(x, y) || sel(x, y - 1)) continue;
      if (used[y * V + x] & 1) continue;
      let cx = x;
      let cy = y;
      let d = 0;
      let prevD = -1;
      for (;;) {
        used[cy * V + cx] |= 1 << d;
        if (d !== prevD) pts.push(cx, cy); // 角だけを点にする
        prevD = d;
        cx += DX[d];
        cy += DY[d];
        edges++;
        // 次の向き: 右・まっすぐ・左（戻る向きは境目の上では来ない）
        const r = (d + 1) & 3;
        const l = (d + 3) & 3;
        const nd = has(cx, cy, r) ? r : has(cx, cy, d) ? d : l;
        if (cx === x && cy === y && nd === 0) {
          // 始点に戻った。最初の点が直線の途中（始点に入る辺も東向き）なら、その点は角ではない
          if (prevD === 0) {
            const s = loops[loops.length - 1];
            pts.splice(2 * s, 2);
          }
          break;
        }
        d = nd;
      }
      loops.push(pts.length / 2);
    }
  }
  return { pts: Int32Array.from(pts), loops: Int32Array.from(loops), edges };
}

/**
 * V208 (A-119): 押してほとんど動かさずに離したか（ペンの揺れ）。始点から dist ドット以上離れた点が 1 つも無ければ真。
 * 投げ縄の点を細かく取るようにしたので、揺れだけで点が 3 つ以上になる。真のときは今までの「点が 2 つ以下」と同じ扱い
 * （選択も履歴も変えない）にする
 */
export function trailStayedNearStart(pts: readonly { x: number; y: number }[], dist = 1): boolean {
  if (pts.length === 0) return true;
  const s = pts[0];
  return !pts.some((p) => Math.hypot(p.x - s.x, p.y - s.y) >= dist);
}
