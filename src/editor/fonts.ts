// M10-1c: 文字ツールの書体テーブルと、同梱フォントの明示ロード。
//
// **ここが書体定義の唯一の置き場所**。raster.ts のラスタライズも editor.ts の UI も
// このテーブルから組み立てる（2箇所に書き分けると必ずズレる）。
//
// サイズ候補が書体ごとに違うのは、ドット系が「設計グリッドの整数倍でのみ
// ピクセルパーフェクトになる」ため（美咲=8px設計 / PixelMplus12=12px設計）。
// 全書体共通のサイズ表は使えない。

export type FontKey =
  | "misaki"
  | "pixel12"
  | "maru"
  | "pop"
  | "mincho"
  // A-71（V176）で追加した5書体。**既存の後ろに足す**（並びと既定値は変えない）
  | "kaku"
  | "dot16"
  | "tegaki"
  | "shippori"
  | "reggae";

export interface FontDef {
  key: FontKey;
  /** ツールオプションに出す表示名 */
  /** M12-1c-2: 表示名の辞書キー（旧 label）。書体名は画面の選択肢に出る */
  labelKey: string;
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
  { key: "misaki", labelKey: "ed.text.font.misaki.label", cssFamily: "MA Misaki", kind: "dot", sizes: [8, 16, 24, 32, 40, 48], hasBold: false },
  { key: "pixel12", labelKey: "ed.text.font.pixel12.label", cssFamily: "MA Pixel12", kind: "dot", sizes: [12, 24, 36, 48], hasBold: true },
  { key: "maru", labelKey: "ed.text.font.maru.label", cssFamily: "MA Maru", kind: "outline", sizes: [8, 10, 12, 16, 20, 24, 32, 48], hasBold: true },
  // pop / mincho から 8px・10px を落としているのは、2値化後に潰れて判読できないため
  // （要件定義書 §2.4 の推奨 12〜48px に合わせる）
  { key: "pop", labelKey: "ed.text.font.pop.label", cssFamily: "MA Pop", kind: "outline", sizes: [12, 16, 20, 24, 32, 48], hasBold: false },
  { key: "mincho", labelKey: "ed.text.font.mincho.label", cssFamily: "MA Mincho", kind: "outline", sizes: [12, 16, 20, 24, 32, 48], hasBold: false },
  // ---- A-71（V176）で追加した5書体 ----
  // ★sizes は**実際に焼いて**決めた（推測で書かない）。画数の多い常用漢字を1字ずつ
  //   2値化し、「字の中の白い穴」が 48px に対して何割残るかを既存の同梱書体と比べている。
  //   すべて hasBold: false ＝ 太字を同梱しない（true にすると合成ボールドでグリッドが壊れる）。
  { key: "kaku", labelKey: "ed.text.font.kaku.label", cssFamily: "MA Kaku", kind: "outline", sizes: [12, 16, 20, 24, 32, 48], hasBold: false },
  // ★DotGothic16 は **outline** 扱い（作者決定 2026-09-22）。
  //   名前と見た目から「16px 設計のドット書体」と決めて入れたが、実測すると設計グリッドが無い:
  //   16px で焼くと中間調 82%（美咲は 0%）・原本の座標の 99.6% が 16px 格子から外れている
  //   （`verify_outlines` は 2535/2535 一致＝サブセットのせいではなく、原本がそういう書体）。
  //   dot 扱い（等倍＋単純閾値）に得は無いので、3倍で描いて平均する outline に切り替えた。
  //   → 16 の整数倍という縛りも外れるので、焼き直して読めるサイズを決め直してある。
  //   表示名も「ドット（大）」→「ドット風」にした（ピクセルパーフェクトではないため）。
  { key: "dot16", labelKey: "ed.text.font.dot16.label", cssFamily: "MA Dot16", kind: "outline", sizes: [12, 16, 20, 24, 32, 48], hasBold: false },
  // Yomogi は細い鉛筆書き。12px は画数の多い字が線ごと消えるので落とした
  { key: "tegaki", labelKey: "ed.text.font.tegaki.label", cssFamily: "MA Tegaki", kind: "outline", sizes: [16, 20, 24, 32, 48], hasBold: false },
  // ★Shippori Mincho は横画が髪の毛のように細い**正統派の明朝**。12px と 16px では
  //   横画が閾値で丸ごと消え、字の骨格が残らなかった（同じ役目の mincho より明確に悪い）ので落とした
  { key: "shippori", labelKey: "ed.text.font.shippori.label", cssFamily: "MA Shippori", kind: "outline", sizes: [20, 24, 32, 48], hasBold: false },
  // ★Reggae One は装飾だが、12px でも同じ役目の pop（Dela Gothic One・出荷済み）より
  //   はっきり読める（pop は 12px で真っ黒の塊になる）ので 12px を残した
  { key: "reggae", labelKey: "ed.text.font.reggae.label", cssFamily: "MA Reggae", kind: "outline", sizes: [12, 16, 20, 24, 32, 48], hasBold: false },
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
