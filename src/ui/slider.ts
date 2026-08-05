// M6-5 Q-1: 共通スライダー部品。
// UAのrange描画は「見た目のトラック」と「つまみ移動域」が一致せず端に隙間が出るため、
// トラック/つまみを自前DOMで描き、つまみ位置を calc((値/最大) * (100% - つまみ幅)) で厳密に置く。
// 操作は透明な <input type=range> を全面に重ねて任せる（キーボード/ホイール/アクセシビリティ維持）。
// つまみ幅と input 側の appearance:none つまみ幅を一致させ、ポインタ位置→値の写像も見た目と一致させる。
// M6-5 Q-6: draggable な祖先行（レイヤー/フォルダDnD）の HTML5 ドラッグに乗っ取られないよう、
// pointerdown で伝播を止め・祖先の draggable を一時 false にし・dragstart を抑止する（部品内蔵で再発防止）。

export interface SliderHandle {
  /** 置き場所に追加する要素 */
  root: HTMLElement;
  /** 現在値（input.value と同期） */
  value(): number;
  /** プログラム側からの値更新（イベントは発火しない） */
  set(v: number): void;
}

export interface SliderOpts {
  min: number;
  max: number;
  value: number;
  step?: number;
  title?: string;
  /** 追加クラス（幅指定など。例: "lay-op"） */
  className?: string;
  /** ドラッグ中連続 */
  onInput?: (v: number) => void;
  /** 確定時（Undo履歴用など） */
  onChange?: (v: number) => void;
  /** つまみを掴んだ時（変更前値の記録用など） */
  onDown?: () => void;
}

/** つまみの総幅(px)。styles.css の .uisl-thumb / .uisl input のつまみ幅と必ず一致させること */
export const SLIDER_THUMB_W = 20;

export function createSlider(o: SliderOpts): SliderHandle {
  const root = document.createElement("div");
  root.className = "uisl" + (o.className ? ` ${o.className}` : "");
  if (o.title) root.title = o.title;

  const track = document.createElement("div");
  track.className = "uisl-track";
  const thumb = document.createElement("div");
  thumb.className = "uisl-thumb";

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(o.min);
  input.max = String(o.max);
  if (o.step != null) input.step = String(o.step);
  input.value = String(o.value);

  root.appendChild(track);
  root.appendChild(thumb);
  root.appendChild(input);

  const span = o.max - o.min || 1;
  const sync = () =>
    root.style.setProperty("--f", String((Number(input.value) - o.min) / span));
  sync();

  input.addEventListener("input", () => {
    sync();
    o.onInput?.(Number(input.value));
  });
  input.addEventListener("change", () => o.onChange?.(Number(input.value)));

  // Q-6: 行クリック（レイヤー選択等）・行DnDへの波及を止める
  root.addEventListener("click", (e) => e.stopPropagation());
  root.addEventListener("dragstart", (e) => e.preventDefault());
  root.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    o.onDown?.();
    const host = root.closest('[draggable="true"]') as HTMLElement | null;
    if (host) {
      host.draggable = false;
      const restore = () => {
        host.draggable = true;
        window.removeEventListener("pointerup", restore);
        window.removeEventListener("pointercancel", restore);
      };
      window.addEventListener("pointerup", restore);
      window.addEventListener("pointercancel", restore);
    }
  });

  return {
    root,
    value: () => Number(input.value),
    set(v: number) {
      const nv = String(Math.max(o.min, Math.min(o.max, v)));
      if (input.value !== nv) {
        input.value = nv;
        sync();
      }
    },
  };
}
