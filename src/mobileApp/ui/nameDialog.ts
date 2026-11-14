// V223 (M-2b-3b-1・UI §5-5・§6-12・指示書 ■3 の F-2): 名前の欄の島（「名前を変える」）。
//
// ★iOS の WebView は頁の `prompt` を出さない（WKUIDelegate の入力の窓が無い）ので、モバイルの画面は `prompt`・`confirm`・`alert` を使わない。
//  名前は、確認の島（dialogs.ts）に欄を 1 つ置いたこの島で聞く。レイヤーとフォルダ（V223）と、作品とアルバム（M-2c）で同じ部品を使えるように、
//  題・欄の上の見出し・断りの文・決めるボタンの字を渡す形にしてある。
// ★欄が空（空白だけ）なら決めるボタンは押せない。キーボードが出たら、島をキーボードの上に残った所の真ん中へ寄せる（初めての保存と同じ＝UI §5-16）。
//  地を押したら［やめる］と同じ。
import { mt } from "../i18n";
import { h, txt } from "./dom";
import { openDialog } from "./dialogs";

export interface NameAsk {
  /** 題（「名前を変える」） */
  title: string;
  /** 欄の上の見出し（「レイヤー名」「フォルダ名」）。読み上げの名前にも使う */
  label: string;
  /** 今の名前 */
  value: string;
  /** 決めるボタンの字（「変える」） */
  okLabel: string;
  /** 欄の下の断りの文（作品とアルバムの「同じ名前があると変えられません」。無ければ出さない） */
  note?: string;
  /** その名前を断るか（同じ名前がある など。断るときは文を返す・よければ null） */
  refuse?(name: string): string | null;
}

/** ★決まり（v223 [N]）: 空（空白だけ）なら決められない */
export function nameOk(value: string): boolean {
  return value.trim() !== "";
}

/** 決めたときに返す値（前後の空白を落とす）・決められなければ null */
export function nameResult(value: string, refuse?: (name: string) => string | null): string | null {
  if (!nameOk(value)) return null;
  const v = value.trim();
  return refuse?.(v) ? null : v;
}

/** ソフトウェアキーボードが出たら、島をキーボードの上に残った所の真ん中へ（欄のある島で使う）。返り値は片付け */
export function keepAboveKeyboard(inside: HTMLElement): () => void {
  const vv = window.visualViewport;
  const onVv = () => {
    const scrim = inside.closest(".mb-scrim") as HTMLElement | null;
    const dlg = inside.closest(".mb-dialog") as HTMLElement | null;
    if (!scrim || !vv || !dlg) return;
    const kb = Math.max(0, window.innerHeight - vv.height);
    scrim.style.paddingBottom = kb > 80 ? `${kb}px` : "";
    dlg.classList.toggle("mb-kb", kb > 80);
    window.scrollTo(0, 0);
  };
  vv?.addEventListener("resize", onVv);
  return () => vv?.removeEventListener("resize", onVv);
}

/** 名前を聞く。決めたら名前（前後の空白を落とした字）・やめたら null */
export function askName(ask: NameAsk): Promise<string | null> {
  const body = h("div", "mb-namebody");
  const input = document.createElement("input");
  input.className = "mb-name";
  input.type = "text";
  input.value = ask.value;
  input.ariaLabel = ask.label;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("enterkeyhint", "done");
  const err = txt("mb-save-err", "");
  body.append(txt("mb-sub", ask.label), input);
  if (ask.note) body.append(txt("mb-save-note", ask.note));
  body.append(err);
  const off = keepAboveKeyboard(body);
  const invalid = () => nameResult(input.value, ask.refuse) === null;
  return openDialog<boolean>({
    title: ask.title,
    body: [body],
    cls: "mb-namebox",
    dismiss: false,
    buttons: [
      { label: mt("mb.cancel.btn"), value: false },
      { label: ask.okLabel, value: true, kind: "go", disabled: invalid },
    ],
    onReady: (close, box) => {
      const refresh = () => {
        err.textContent = nameOk(input.value) ? (ask.refuse?.(input.value.trim()) ?? "") : "";
        (box as HTMLElement & { mbRefresh?: () => void }).mbRefresh?.();
      };
      input.addEventListener("input", refresh);
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return; // 変換の確定の Enter では決めない（PC と同じ）
        e.preventDefault();
        if (!invalid()) close(true);
      });
      // 今の名前が入り、末尾にカーソル
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    },
  }).then((r) => {
    off();
    return r.value ? nameResult(input.value, ask.refuse) : null;
  });
}
