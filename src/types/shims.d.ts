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
