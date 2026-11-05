// ★V213 (M-2a): バイト数の表示。前は exporter.ts にあった（描く操作のコアが書き出しの部品を引かないよう、ここへ移した。
//  exporter.ts は同じ名前で出し直す＝PC の出力は同じ）

/** M11-23: バイト数の表示（見積もり用・GB/MB） */
export function formatBytes(n: number): string {
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  return `${Math.round(n / (1024 * 1024))}MB`;
}

// ★V214 (M-2b-1a): formatSize も exporter.ts から移した（字は同じ。exporter.ts は同じ名前で出し直す）
/** V154: 小さい値も読める表示（KB/MB/GB）。
 *  `formatBytes` は書き出しの見積もり用で 1MB 未満が全部「0MB」になる。
 *  作品の大きさメーターや復元の一覧は**小さい作品でも意味のある数字**を出したいので、
 *  1MB 未満は KB で出す（見積もり側の表示は変えない＝既存の画面は1文字も動かない）。 */
export function formatSize(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return formatBytes(n);
}
