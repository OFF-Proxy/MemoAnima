// 型定義の無い依存のシム（M6-1）

declare module "gif.js" {
  interface GifOptions {
    workers?: number;
    quality?: number;
    width?: number;
    height?: number;
    repeat?: number; // 0=無限, -1=1回
    workerScript?: string;
    background?: string;
    /** M11-22: 固定パレット（r,g,b,… の平坦配列・最大 256 色＝768 要素）。渡すと NeuQuant を通らず
     *  線形最近傍で索引化（パレット内の色は完全一致）・全コマ同一パレット。true は「1コマ目で学習して
     *  共有」の別モード（未使用） */
    globalPalette?: number[] | boolean;
  }
  interface AddFrameOptions {
    delay?: number; // ms（内部でセンチ秒に丸め）
    copy?: boolean;
  }
  export default class GIF {
    constructor(options: GifOptions);
    addFrame(
      image: CanvasRenderingContext2D | HTMLCanvasElement | ImageData,
      options?: AddFrameOptions
    ): void;
    on(event: "finished", cb: (blob: Blob) => void): void;
    on(event: "progress", cb: (p: number) => void): void;
    render(): void;
    abort(): void;
  }
}

declare module "upng-js" {
  const UPNG: {
    /** imgs: RGBA ArrayBuffer列, cnum: 0=ロスレス, dels: 各フレームms */
    encode(
      imgs: ArrayBuffer[],
      w: number,
      h: number,
      cnum: number,
      dels?: number[]
    ): ArrayBuffer;
    decode(buf: ArrayBuffer): { width: number; height: number; frames: unknown[] };
    toRGBA8(img: unknown): ArrayBuffer[];
  };
  export default UPNG;
}

declare module "*?url" {
  const url: string;
  export default url;
}
