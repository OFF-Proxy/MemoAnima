// M7-2 初回ガイド（吹き出し式・スキップ可・暗幕＋切り抜きハイライト）
// - 対象要素が無い画面状態でも文字のみで成立（要素依存で壊れない）
// - 背面操作は暗幕でブロック（誤操作防止）・Esc=スキップ
// - 文言は M7-1 の中立表記に準拠（うごメモ/Flipnote 等は使わない）

export interface GuideStep {
  title: string;
  text: string;
  /** ハイライト対象の CSS セレクタ（無い/見つからない場合は中央に文字のみ） */
  target?: string;
}

/**
 * ガイドを再生する。完了（はじめる）でもスキップでも resolve する。
 * 呼び出し側は resolve 後に settings.guideDone を保存する。
 */
export function runGuide(steps: GuideStep[]): Promise<void> {
  return new Promise((resolve) => {
    let idx = 0;
    const root = document.createElement("div");
    root.className = "guide-root";
    document.body.appendChild(root);

    const finish = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", render);
      root.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      // ガイド中のキーは背面へ通さない（Esc=スキップ）
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    const next = () => {
      if (idx >= steps.length - 1) finish();
      else {
        idx++;
        render();
      }
    };
    const prev = () => {
      if (idx > 0) {
        idx--;
        render();
      }
    };

    const render = () => {
      const step = steps[idx];
      root.innerHTML = "";
      // 対象要素（可視のもののみ有効）
      let rect: DOMRect | null = null;
      if (step.target) {
        const el = document.querySelector(step.target) as HTMLElement | null;
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) rect = r;
        }
      }
      // 暗幕: ハイライトあり=切り抜き（巨大box-shadow）/ なし=全面
      if (rect) {
        const hl = document.createElement("div");
        hl.className = "guide-hl";
        const pad = 6;
        hl.style.left = `${rect.left - pad}px`;
        hl.style.top = `${rect.top - pad}px`;
        hl.style.width = `${rect.width + pad * 2}px`;
        hl.style.height = `${rect.height + pad * 2}px`;
        root.appendChild(hl);
      } else {
        root.classList.add("nofocus");
      }
      if (rect) root.classList.remove("nofocus");
      // 吹き出し
      const bubble = document.createElement("div");
      bubble.className = "guide-bubble";
      const isFirst = idx === 0;
      const isLast = idx === steps.length - 1;
      bubble.innerHTML = `
        <div class="g-step">${idx + 1} / ${steps.length}</div>
        <h4></h4>
        <p></p>
        <div class="g-actions">
          <button class="minibtn" data-g="skip">スキップ</button>
          <span style="flex:1"></span>
          ${isFirst ? "" : '<button class="minibtn" data-g="prev">← 戻る</button>'}
          <button class="btn primary" data-g="next">${
            isLast ? "はじめる" : isFirst ? "ガイドを見る →" : "次へ →"
          }</button>
        </div>`;
      (bubble.querySelector("h4") as HTMLElement).textContent = step.title;
      (bubble.querySelector("p") as HTMLElement).textContent = step.text;
      bubble.querySelector('[data-g="skip"]')?.addEventListener("click", finish);
      bubble.querySelector('[data-g="prev"]')?.addEventListener("click", prev);
      bubble.querySelector('[data-g="next"]')?.addEventListener("click", next);
      root.appendChild(bubble);
      // 配置: 対象の下（入らなければ上）・なければ中央。低解像度でも画面内にクランプ
      const bw = Math.min(420, window.innerWidth - 24);
      bubble.style.width = `${bw}px`;
      // いったん配置してから実測でクランプ
      let left: number;
      let top: number;
      const bh = () => bubble.getBoundingClientRect().height;
      if (rect) {
        left = rect.left + rect.width / 2 - bw / 2;
        top = rect.bottom + 16;
        bubble.style.left = `${left}px`;
        bubble.style.top = `${top}px`;
        if (top + bh() > window.innerHeight - 12) top = Math.max(12, rect.top - bh() - 16);
      } else {
        bubble.style.left = "0px";
        bubble.style.top = "0px";
        left = window.innerWidth / 2 - bw / 2;
        top = Math.max(12, window.innerHeight / 2 - bh() / 2);
      }
      left = Math.max(12, Math.min(left, window.innerWidth - bw - 12));
      top = Math.max(12, Math.min(top, window.innerHeight - bh() - 12));
      bubble.style.left = `${left}px`;
      bubble.style.top = `${top}px`;
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", render);
    render();
  });
}
