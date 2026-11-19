// V229 (M-4・REQ_mobile_m4_io.md §3-3 の 4): 出し入れは同時に 1 つ（書き出し・取り込み・全部書き出す）。
// 2 つ目は始めない（呼ぶ側が "busy" で断る＝今の「◯◯しています」と同じ扱い）。
export type IoJob = "export" | "import" | "exportAll";

class IoLock {
  private holder: IoJob | null = null;
  /** 取れたら放す関数を返す。もう誰かが持っていたら null */
  acquire(job: IoJob): (() => void) | null {
    if (this.holder !== null) return null;
    this.holder = job;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.holder = null;
    };
  }
  get busy(): IoJob | null {
    return this.holder;
  }
}

export const ioLock = new IoLock();
