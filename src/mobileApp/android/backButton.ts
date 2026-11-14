// V224 (D-M1-7 のうちこの回の分・REQ_mobile_m2_editor.md §5-4・指示書 ■3 の A-4): Android の戻るボタンを受ける**画面を持たない部品**。
//
// ★画面が「戻るを受ける手」を登録する。押されたら、いちばん新しく登録した手を呼ぶ。手は「受けた（true）／受けない（false）」を返す。
//  登録が無い・手が受けない・手が失敗したときは、Activity を壊さずに裏へ回す（ホームへ出たときと同じ。戻ってくると同じ画面）。
// ★押しが重なったとき（前の手がまだ終わっていない）は、新しい押しを受けたことにして何もしない（確認の上にもう 1 つ確認を出さない）。
// ★開いている帯・パネル・メニューを先に閉じる順は V226。ここは口だけ（手が受けた／受けないを返せる形）。
// ★Tauri と DOM を読まない（つなぐのは androidGlue.ts）。scripts/v224_smoke.ts [B] が偽の口で動かす

/** 戻るを受ける手。true＝受けた（裏へ回さない）・false＝受けない（裏へ回す） */
export type BackHandler = () => boolean | Promise<boolean>;

export interface BackRouterDeps {
  /** Activity を壊さずに裏へ回す */
  moveToBack: () => Promise<void>;
  /** 記録（作品名・パスを渡さない） */
  log?: (line: string) => void;
}

export class BackRouter {
  private readonly d: BackRouterDeps;
  private readonly stack: { id: number; h: BackHandler }[] = [];
  private seq = 0;
  private inflight = false;

  constructor(d: BackRouterDeps) {
    this.d = d;
  }

  /** 手を登録する。返す関数で外す（外すのは登録した本人だけ・何度呼んでもよい） */
  register(h: BackHandler): () => void {
    const id = ++this.seq;
    this.stack.push({ id, h });
    return () => {
      const i = this.stack.findIndex((x) => x.id === id);
      if (i >= 0) this.stack.splice(i, 1);
    };
  }

  /** 登録している手の数（検査と記録） */
  size(): number {
    return this.stack.length;
  }

  /** 戻るボタンが押された。結果: "handled"（手が受けた）・"back"（裏へ回した）・"busy"（前の押しの途中＝何もしない） */
  async press(): Promise<"handled" | "back" | "busy"> {
    if (this.inflight) return "busy";
    this.inflight = true;
    try {
      const top = this.stack[this.stack.length - 1];
      let took = false;
      if (top) {
        try {
          took = (await top.h()) === true;
        } catch {
          this.d.log?.("[V224] back handler failed");
          took = false;
        }
      }
      if (took) return "handled";
      await this.d.moveToBack().catch(() => this.d.log?.("[V224] move-to-back refused"));
      return "back";
    } finally {
      this.inflight = false;
    }
  }
}

// ---- いま受けている BackRouter（Android で androidGlue.ts が置く。iOS・確かめ画面では無い＝登録は何もしない） ----

let current: BackRouter | null = null;

/** androidGlue.ts が置く（受け始めたとき） */
export function setBackRouter(r: BackRouter | null): void {
  current = r;
}

/** 画面が戻るを受ける手を登録する（受けていなければ何もしない）。返す関数で外す */
export function registerBack(h: BackHandler): () => void {
  return current ? current.register(h) : () => {};
}
