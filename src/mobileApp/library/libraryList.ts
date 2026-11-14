// V221 (M-2b-2・指示書 ■3 の D-9): 仮の一覧と、初めての保存のアルバムの札の一覧を取る**1 つの部品**。
//
// ★V224 (M-2c・V211b の F2): Rust が場所を決めるライブラリの命令（`mobile_library_list`）だけを呼ぶ。場所（パス）を JS で持たない・
//  受け取らない（試験用のライブラリを開いている間は、Rust が試験用の側を見る）。PC の命令（`list_albums`・`scan_library`）は
//  モバイルの登録の表から外した（scripts/v224_smoke.ts [R][J]）。
// ★画面はこのファイルの関数だけを呼ぶ（M-2c のライブラリの画面も同じ口）。
// ★確かめ画面の部品（devcheck/devPort.ts）は印の無いビルドに入らないので、ここから読まない。
import type { LibraryWork, MobilePort } from "../../mobile/port";

export type { LibraryWork } from "../../mobile/port";

export interface LibraryListing {
  albums: string[];
  works: LibraryWork[];
}

/** アルバムの一覧（名前の並びは Rust の順のまま） */
export async function listAlbums(port: MobilePort): Promise<string[]> {
  return (await port.libraryList()).albums;
}

/** アルバムと作品の一覧（作品は .memoanima・.animemo だけ＝L-2） */
export async function listLibrary(port: MobilePort): Promise<LibraryListing> {
  const l = await port.libraryList();
  return { albums: l.albums, works: l.works };
}
