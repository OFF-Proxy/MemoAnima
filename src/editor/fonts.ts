// M10-1c: 文字ツールの書体テーブルと、同梱フォントの明示ロード。
//
// **ここが書体定義の唯一の置き場所**。raster.ts のラスタライズも editor.ts の UI も
// このテーブルから組み立てる（2箇所に書き分けると必ずズレる）。
//
// サイズ候補が書体ごとに違うのは、ドット系が「設計グリッドの整数倍でのみ
// ピクセルパーフェクトになる」ため（美咲=8px設計 / PixelMplus12=12px設計）。
// 全書体共通のサイズ表は使えない。

export type FontKey = "misaki" | "pixel12" | "maru" | "pop" | "mincho";

export interface FontDef {
  key: FontKey;
  /** ツールオプションに出す表示名 */
  label: string;
  /** styles.css の @font-face と一致させること */
  cssFamily: string;
  /** dot=設計グリッドを持つ（等倍レンダ＋閾値2値化） / outline=3倍レンダ＋3×3平均 */
  kind: "dot" | "outline";
  /** 選べるサイズ（px） */
  sizes: number[];
  /** Bold のウェイトを同梱しているか。false の書体に bold を渡すと
   *  ブラウザが合成ボールドを作ってドットのグリッドを壊すので、必ず落とす */
  hasBold: boolean;
}

export const FONTS: FontDef[] = [
  { key: "misaki", label: "極小ドット（美咲）", cssFamily: "MA Misaki", kind: "dot", sizes: [8, 16, 24, 32, 40, 48], hasBold: false },
  { key: "pixel12", label: "ドット（標準）", cssFamily: "MA Pixel12", kind: "dot", sizes: [12, 24, 36, 48], hasBold: true },
  { key: "maru", label: "丸文字", cssFamily: "MA Maru", kind: "outline", sizes: [8, 10, 12, 16, 20, 24, 32, 48], hasBold: true },
  // pop / mincho から 8px・10px を落としているのは、2値化後に潰れて判読できないため
  // （要件定義書 §2.4 の推奨 12〜48px に合わせる）
  { key: "pop", label: "ポップ（太字）", cssFamily: "MA Pop", kind: "outline", sizes: [12, 16, 20, 24, 32, 48], hasBold: false },
  { key: "mincho", label: "明朝（レトロ）", cssFamily: "MA Mincho", kind: "outline", sizes: [12, 16, 20, 24, 32, 48], hasBold: false },
];

export const DEFAULT_TEXT = { family: "maru" as FontKey, size: 16, bold: true };

export function fontDef(key: FontKey): FontDef {
  return FONTS.find((f) => f.key === key) ?? FONTS[2]; // 既定は maru
}

/** 未知の family / 候補外の size を既定へ落とす（settings.json を手で編集されても落ちないように） */
export function sanitizeTextSettings(v: {
  family?: string;
  size?: number;
  bold?: boolean;
  vertical?: boolean;
} | null | undefined): { family: FontKey; size: number; bold: boolean; vertical: boolean } {
  const known = FONTS.some((f) => f.key === v?.family);
  const family = (known ? v!.family : DEFAULT_TEXT.family) as FontKey;
  const def = fontDef(family);
  const size = def.sizes.includes(Number(v?.size)) ? Number(v!.size) : nearestSize(def, DEFAULT_TEXT.size);
  const bold = def.hasBold ? v?.bold !== false : false;
  // M10-11: 旧 settings.json に項目が無ければ横書き（false）へ落とす
  const vertical = v?.vertical === true;
  return { family, size, bold, vertical };
}

/** 書体を切り替えたとき、直前のサイズが新候補にあれば維持し、無ければ最も近い値を選ぶ */
export function nearestSize(def: FontDef, want: number): number {
  if (def.sizes.includes(want)) return want;
  let best = def.sizes[0];
  for (const s of def.sizes) {
    if (Math.abs(s - want) < Math.abs(best - want)) best = s;
  }
  return best;
}

// ---------------- 明示ロード ----------------

let fontsPromise: Promise<void> | null = null;

/**
 * 同梱フォントを**明示的に**ロードする。
 *
 * @font-face は遅延ロードなので、canvas の ctx.font に family を指定しただけでは
 * ロードが始まらない。さらに document.fonts.ready は「保留中のロードが無ければ即座に解決」
 * するため、一度も要求していないフォントに対しては何も待たない。
 * この対策が無いと**起動直後の1回目の文字置きで measureText の幅がずれる**。
 *
 * 結果はモジュールスコープにキャッシュし、2回目以降は同じ Promise を返す。
 */
export function ensureFontsLoaded(): Promise<void> {
  if (fontsPromise) return fontsPromise;
  const specs: string[] = [];
  for (const f of FONTS) {
    specs.push(`16px "${f.cssFamily}"`);
    // weight ごとに別ファイルなので Bold も別途要求する
    if (f.hasBold) specs.push(`bold 16px "${f.cssFamily}"`);
  }
  fontsPromise = (async () => {
    if (typeof document === "undefined" || !document.fonts) return;
    await Promise.all(
      specs.map((s) => document.fonts.load(s).catch(() => undefined))
    );
    await document.fonts.ready;
  })();
  return fontsPromise;
}
