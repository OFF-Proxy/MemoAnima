// V225 (M-2b-3b-2・親§6-7・D-M2-3・C17・指示書 ■3 の P): ペンのダブルタップ（Apple Pencil）の JS の口と、何をするかの決まり。
//
// ★受け取るのはネイティブの側（src-tauri/ios-extra/MAPencilTap.m が WKWebView に UIPencilInteraction を付け、たたかれたら
//  OS の設定を決まった英字で `window.__mbPencilTap(字)` に渡す）。ここは、その字から何をするかを決めるだけ。
// ★OS の設定に従う: 「消しゴムへ切り替え」＝今のツール ⇄ 消しゴム／「前のツールへ」＝前のツール／「カラーパレット」＝色のパネルを開く。
//  「無視」と、それ以外の値（新しい OS で足された値）は何もしない。描いている途中と、確認の箱・設定の画面が出ている間は何もしない。
// ★設定の行（ペンのダブルタップ）は、受け取れると分かってから出す（UI §6-11）。それまでは「端末の設定に従う」で効かせる。
// ★Android・PC では何も起きない（口を置くだけ・呼ぶものが無い）。pointerType を読まない。

/** ネイティブが渡す字 */
export type PencilTapAction = "ignore" | "switchEraser" | "switchPrevious" | "showColorPalette" | "other";

/** 描く画面の今 */
export interface PencilTapState {
  tool: string;
  /** 前に持っていたツール（無ければ null） */
  prevTool: string | null;
  /** 消しゴムに切り替える前のツール（消しゴムから戻る先。無ければ null） */
  beforeEraser: string | null;
  /** 描いている途中 */
  drawing: boolean;
  /** 確認の箱・設定の画面・案内・重い処理の最中 */
  blocked: boolean;
}

/** すること（null＝何もしない） */
export type PencilTapDo = { kind: "tool"; tool: string } | { kind: "colorPanel" } | null;

/** ★決まり（scripts/v225_smoke.ts が見る） */
export function pencilTapDo(action: string, s: PencilTapState): PencilTapDo {
  if (s.drawing || s.blocked) return null;
  switch (action) {
    case "switchEraser":
      if (s.tool === "eraser") return { kind: "tool", tool: s.beforeEraser && s.beforeEraser !== "eraser" ? s.beforeEraser : "pen" };
      return { kind: "tool", tool: "eraser" };
    case "switchPrevious":
      return s.prevTool && s.prevTool !== s.tool ? { kind: "tool", tool: s.prevTool } : null;
    case "showColorPalette":
      return { kind: "colorPanel" };
    default:
      return null; // 「無視」と、知らない値
  }
}

type PencilWindow = { __mbPencilTap?: ((action: string) => void) | null; __mbPencilAttached?: boolean };

/** 口を置く（描く画面を開いたとき）。返り値は片付け（閉じたとき） */
export function installPencilTap(handler: (action: string) => void): () => void {
  const w = window as unknown as PencilWindow;
  const fn = (action: string) => handler(String(action));
  w.__mbPencilTap = fn;
  return () => {
    if (w.__mbPencilTap === fn) w.__mbPencilTap = null;
  };
}

/** ネイティブの受け口が付いているか（確かめ画面の印のビルドが出す） */
export function pencilTapAttached(): boolean {
  return (window as unknown as PencilWindow).__mbPencilAttached === true;
}
