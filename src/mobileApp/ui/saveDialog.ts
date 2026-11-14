// V221 (M-2b-2・UI §5-16・§5-17・指示書 ■3 の D-10): 初めての保存（名前とアルバム）と、戻るときの確認。
//
// ★題は PC の「保存先を選ぶ」（`common.saveTarget.dialog.title`）。PC の同じ画面から名前とアルバムだけを残した形。
//  同じ画面を、初めての保存・別名で保存（その他から・外で書き換えられていたとき）・保存先を選び直す（保存先が決まらないとき）で使う。
// ★名前が空なら［保存］を押せない（薄くする・aria-disabled）。同じアルバムに同じ名前があるときは保存せずにその文を出す（上書きしない）。
// ★キーボードが出ても隠れない: 島をキーボードの上に残った所の真ん中へ移し（0.26s）、説明の一文を畳み、アルバムの札を 1 行の横スクロールにする。
import { t } from "../../i18n";
import { mt, type MbKey } from "../i18n";
import { defaultAlbumName } from "../../i18n/defaults";
import { foldName } from "../../mobile/names";
import { h, btn, icon, txt } from "./dom";
import { openDialog } from "./dialogs";

export interface SaveAskInput {
  /** 初めて／別名で／選び直す */
  mode: "first" | "saveAs" | "relocate";
  /** 名前の欄に初めに入れる名前（拡張子なし） */
  name: string;
  /** 選んでおくアルバム */
  album: string;
  albums: string[];
  /** 戻るときの確認から来た（決めるボタンが［保存して戻る］） */
  fromLeave: boolean;
  /** 上に出す説明（外で書き換えられていた・保存先が決まらない） */
  msgKey: MbKey | null;
  /** 同じ名前がある（前に断られた） */
  nameTaken?: boolean;
  /** アルバムを作る（作った名前を返す・作れなければ null） */
  createAlbum(): Promise<string | null>;
  /** 同じアルバムに同じ名前の作品があるか（拡張子なしの名前で） */
  taken(album: string, name: string): boolean;
}

export type SaveAskResult = { album: string; name: string } | null;

/** 保存先を聞く。決めたら { album, name }（名前は拡張子なし）・やめたら null */
export function askSaveTarget(inp: SaveAskInput): Promise<SaveAskResult> {
  return new Promise((resolve) => {
    let album = inp.album || inp.albums[0] || defaultAlbumName();
    const albums = inp.albums.length ? [...inp.albums] : [album];
    const box = h("div", "mb-savebody");
    const lead = txt("mb-save-lead mb-dialog-body", inp.mode === "first" ? mt("mb.save.first.msg") : "");
    if (inp.msgKey) lead.textContent = mt(inp.msgKey);
    const nameLabel = txt("mb-sub", mt("mb.save.name.label"));
    const name = document.createElement("input");
    name.className = "mb-name";
    name.type = "text";
    name.value = inp.name;
    name.placeholder = mt("mb.save.name.placeholder");
    name.ariaLabel = mt("mb.save.name.label");
    name.setAttribute("autocomplete", "off");
    name.setAttribute("autocapitalize", "off");
    name.setAttribute("enterkeyhint", "done");
    const albumRow = h("div", "mb-albums");
    const note = txt("mb-save-note", "");
    const err = txt("mb-save-err", inp.nameTaken ? mt("mb.save.nameTaken.msg") : "");
    const drawAlbums = () => {
      albumRow.replaceChildren();
      for (const a of albums) {
        albumRow.append(
          btn(`mb-album${a === album ? " mb-on" : ""}`, a, () => {
            album = a;
            drawAlbums();
            update();
          }, txt("", a))
        );
      }
      albumRow.append(
        btn("mb-album mb-album-new", mt("mb.save.newAlbum.btn"), () => {
          void inp.createAlbum().then((made) => {
            if (!made) return;
            if (!albums.includes(made)) albums.push(made);
            album = made;
            drawAlbums();
            update();
          });
        }, icon("add", 18), txt("", mt("mb.save.newAlbum.btn")))
      );
    };
    const update = () => {
      const empty = name.value.trim() === "";
      note.textContent = empty ? mt("mb.save.needName.msg") : mt("mb.save.into.msg", { album });
      if (!empty && inp.taken(album, name.value.trim())) err.textContent = mt("mb.save.nameTaken.msg");
      else if (!inp.nameTaken || empty) err.textContent = "";
      (box.closest(".mb-dialog") as (HTMLElement & { mbRefresh?: () => void }) | null)?.mbRefresh?.();
    };
    name.addEventListener("input", () => {
      inp.nameTaken = false;
      update();
    });
    name.addEventListener("focus", () => name.select());
    drawAlbums();
    box.append(lead, nameLabel, name, albumRow, note, err);
    // キーボード: 島を残った所の真ん中へ（visualViewport）・一文を畳む・アルバムを 1 行に
    const vv = window.visualViewport;
    const onVv = () => {
      const scrim = box.closest(".mb-scrim") as HTMLElement | null;
      const dlg = box.closest(".mb-dialog") as HTMLElement | null;
      if (!scrim || !vv || !dlg) return;
      const kb = Math.max(0, window.innerHeight - vv.height);
      scrim.style.paddingBottom = kb > 80 ? `${kb}px` : "";
      dlg.classList.toggle("mb-kb", kb > 80);
      window.scrollTo(0, 0);
    };
    vv?.addEventListener("resize", onVv);
    const goLabel = inp.fromLeave ? mt("mb.leave.save.btn") : t("common.save.btn");
    const invalid = () => name.value.trim() === "" || inp.taken(album, name.value.trim());
    void openDialog<"go" | "cancel">({
      title: t("common.saveTarget.dialog.title"),
      titleIcon: "save",
      body: [box],
      cls: "mb-savebox",
      buttons: [
        { label: t("ed.common.cancelMark.btn"), value: "cancel" },
        { label: goLabel, value: "go", kind: "go", iconId: "save", disabled: invalid },
      ],
    }).then((r) => {
      vv?.removeEventListener("resize", onVv);
      if (r.value !== "go") resolve(null);
      else resolve({ album, name: name.value.trim() });
    });
    update();
  });
}

/** 名前が同じか（大小と NFC を無視・Rust の比べ方と同じ foldName） */
export function sameName(a: string, b: string): boolean {
  return foldName(a) === foldName(b);
}

export type LeaveChoice = "save" | "discard" | "cancel";

/** 戻るときの確認（3 つ・縦に並べる） */
export async function askLeave(): Promise<LeaveChoice> {
  const r = await openDialog<LeaveChoice>({
    title: mt("mb.leave.head.title"),
    titleIcon: "warn",
    body: [mt("mb.leave.ask.msg")],
    vertical: true,
    buttons: [
      { label: mt("mb.leave.save.btn"), value: "save", kind: "go", iconId: "save" },
      { label: mt("mb.leave.discard.btn"), value: "discard", kind: "warn" },
      { label: t("ed.common.cancelMark.btn"), value: "cancel" },
    ],
  });
  return r.value;
}
