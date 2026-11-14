// V226 (D-M1-7・UI §5-17・指示書 ■3 の B-1・B-2): Android の戻るボタンで「開いているものを先に閉じる順」の決まり（画面を持たない）。
//
// ★押すたびに、上から順に 1 つだけ閉じて、受けたことにする。DOM・Tauri を読まない（画面が今の姿と手を渡す）。
//  scripts/v226_smoke.ts [B] が、開いているものの組み合わせごとに動かす。
// ★描く画面（B-1）: 箱（確認・お知らせ・選ばせる・名前・小窓）→［やめる］と同じ ／ 設定の画面 → 閉じる ／
//  描いている途中・変形の途中・重い処理の間 → 何もしない ／ 一時的に開くもの（その他のメニュー・まとめたボタンの一覧・長押しの帯・ツールの帯）→ 閉じる ／
//  パネル（横・縦）→ 閉じる ／ 広げたタイムラインの島 → 閉じる ／ どれも無ければ画面の［戻る］と同じ道。
// ★ライブラリ（B-2）: 箱 →［やめる］／開いている途中 → 何もしない ／ 全画面 → やめる ／ 設定の画面 → 閉じる ／ 浮かぶもの → 閉じる ／
//  どれも無ければ受けない（＝裏へ回す）。

/** 箱を外から閉じた結果（ui/dialogs.ts の closeTopDialog）。"kept"＝出ているが閉じない（「やめる」を決められない箱） */
export type DialogClose = "none" | "closed" | "kept";

/** 描く画面の「戻るボタンで 1 つ閉じる」口（MobileEditor.mbBackClose）の答え。
 *  "busy"＝描いている途中・変形の途中・重い処理の間（何もしない）・"closed"＝1 つ閉じた・"none"＝閉じるものが無い */
export type EditorClose = "busy" | "closed" | "none";

export interface EditorBackDeps {
  /** 一番上の箱を［やめる］で閉じる */
  closeDialog(): DialogClose;
  /** 設定の画面が出ているか・閉じる */
  settingsShown(): boolean;
  closeSettings(): void;
  /** 描く画面で開いているものを 1 つ閉じる */
  closeOne(): EditorClose;
  /** 画面の［戻る］と同じ道（保存していない変更があれば確認）。終わったら解ける */
  leave(): Promise<void>;
}

/** 何をしたか（検査と記録。作品名・パスは入らない） */
export type EditorBackStep = "dialog" | "dialog-kept" | "settings" | "busy" | "closed" | "leave" | "leaving";

/** 描く画面の戻るボタンの手を作る。いつも「受けた」を返す（描く画面から裏へは回さない＝V224 の A-4 と同じ）。
 *  ★［戻る］の道（leave）は待たない: 待つと、その道が出した確認（保存していない変更）を、次の戻るボタンで閉じられない
 *   （BackRouter は前の手が終わるまで次の押しを受けない）。代わりに、道が終わるまでの押しは「箱があれば閉じる・無ければ何もしない」。 */
export function makeEditorBack(d: EditorBackDeps): { press(): EditorBackStep; leaving(): boolean } {
  let leaving = false;
  const press = (): EditorBackStep => {
    const dlg = d.closeDialog();
    if (dlg === "closed") return "dialog";
    if (dlg === "kept") return "dialog-kept";
    if (leaving) return "leaving"; // ［戻る］の道の途中（保存・閉じる）
    if (d.settingsShown()) {
      d.closeSettings();
      return "settings";
    }
    const c = d.closeOne();
    if (c === "busy") return "busy";
    if (c === "closed") return "closed";
    leaving = true;
    void d
      .leave()
      .catch(() => {})
      .finally(() => {
        leaving = false;
      });
    return "leave";
  };
  return { press, leaving: () => leaving };
}

/** 描く画面の中で、どれを閉じるか（MobileEditor.mbBackClose が今の姿を渡す） */
export interface EditorOpenThings {
  /** 指やペンが触れている（線・運んでいる途中）・2 本指のジェスチャーの途中 */
  touching: boolean;
  /** 変形・四隅の途中 */
  transforming: boolean;
  /** 重い処理（保存・開く・まとめて足す など）の間 */
  heavy: boolean;
  /** その他のメニュー・まとめたボタンの一覧・コマを長押しの帯・ツールの帯 */
  transient: boolean;
  /** パネル（横・縦） */
  panel: boolean;
  /** 広げたタイムラインの島 */
  island: boolean;
}

export type EditorCloseTarget = "busy" | "transient" | "panel" | "island" | "none";

/** ★B-1 の 3・4 と「何もしない」の間: 上に見えている物から 1 つ */
export function editorCloseTarget(s: EditorOpenThings): EditorCloseTarget {
  if (s.touching || s.transforming || s.heavy) return "busy";
  if (s.transient) return "transient";
  if (s.panel) return "panel";
  if (s.island) return "island";
  return "none";
}

export interface LibraryBackDeps {
  closeDialog(): DialogClose;
  /** 描く画面を開いている（描く画面の手が先に受けるので、ここへは来ないはず。来たら受けたことにする） */
  editing(): boolean;
  /** 全画面で見ている・やめる */
  theater(): boolean;
  closeTheater(): void;
  settingsShown(): boolean;
  closeSettings(): void;
  /** 浮かぶもの（移動の一覧・その他・並び順・アルバムの一覧） */
  popShown(): boolean;
  closePop(): void;
  /** 開いている途中（「開いています」）・消している・動かしている途中 */
  busy(): boolean;
}

export type LibraryBackStep = "dialog" | "dialog-kept" | "editing" | "theater" | "settings" | "pop" | "busy" | "pass";

/** ライブラリの戻るボタンの手を作る。"pass" のときだけ受けない（＝裏へ回す） */
export function libraryBack(d: LibraryBackDeps): LibraryBackStep {
  const dlg = d.closeDialog();
  if (dlg === "closed") return "dialog";
  if (dlg === "kept") return "dialog-kept";
  if (d.editing()) return "editing";
  if (d.busy()) return "busy";
  if (d.theater()) {
    d.closeTheater();
    return "theater";
  }
  if (d.settingsShown()) {
    d.closeSettings();
    return "settings";
  }
  if (d.popShown()) {
    d.closePop();
    return "pop";
  }
  return "pass";
}
