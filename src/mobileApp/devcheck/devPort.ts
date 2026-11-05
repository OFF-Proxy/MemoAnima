// V211 (M-1b・要件 §6-5): 確かめ画面（開発用）が呼ぶ命令の口。ビルドの印（__MOBILE_DEVCHECK__）の中だけで読み込まれる。
//
// - `mobile_dev_*`: 試験用のライブラリ・故障を起こす口・記録（Rust は feature `mobile-devcheck` の中だけ。故障は試験用のライブラリでだけ
//   通る＝命令の側でも断る）
// - PC の命令（mobile_app.rs の登録の表に出したものだけ）: 場所（libRoot）は、そのたびに `mobile_library_root` で受け取ったものを渡す
//   （覚えない・保存しない＝決-4。試験用のライブラリを開いている間は試験用の場所が返る）
// - ★試験用のライブラリを開いている間は、PC の `append_log`・`save_settings` を呼ばない（本物の app_config_dir に書くため）
import { invoke } from "@tauri-apps/api/core";

export interface DevState {
  testLibrary: boolean;
  faults: { noSpace: boolean; stopAt: string };
}

export type FaultKind = "no-space" | "stop-after-temp" | "stop-after-evac" | "memory";

export const dev = {
  state: () => invoke<DevState>("mobile_dev_state"),
  openTestLibrary: () => invoke<null>("mobile_dev_open_test_library"),
  closeTestLibrary: () => invoke<null>("mobile_dev_close_test_library"),
  fault: (kind: FaultKind, on: boolean) => invoke<null>("mobile_dev_fault", { args: { kind, on } }),
  log: (line: string) => invoke<null>("mobile_dev_log", { args: { line } }),
  logTail: () => invoke<string[]>("mobile_dev_log_tail"),
};

/** scan_library の 1 件（PC の LibraryView・欄は snake_case のまま） */
export interface LibraryView {
  kind: string;
  hash: string;
  album: string;
  name: string;
  ext: string;
  size: number;
  path: string;
  thumb_path: string | null;
  order: number;
  sorted_at: number;
}

/** list_recoverable の 1 件（PC の RecoverableView） */
export interface RecoverableView {
  album: string;
  name: string;
  rel_path: string;
  bak_size: number;
  bak_at: number;
  tmp_files: [string, number][];
}

export const pc = {
  listAlbums: (libRoot: string) => invoke<string[]>("list_albums", { libRoot }),
  scanLibrary: (libRoot: string) => invoke<LibraryView[]>("scan_library", { libRoot }),
  listRecoverable: (libRoot: string) => invoke<RecoverableView[]>("list_recoverable", { libRoot }),
  recoverProject: (libRoot: string, relPath: string) => invoke<string>("recover_project", { libRoot, relPath }),
  deleteNote: (libRoot: string, album: string, name: string) => invoke<null>("delete_note", { libRoot, hash: "", album, name }),
  deleteAlbum: (libRoot: string, name: string) => invoke<null>("delete_album", { libRoot, name }),
  /** サムネ（.memoanima.png）を読む（生のバイト列）。大きさの門番つき */
  readThumb: (path: string) => invoke<ArrayBuffer>("read_file_raw", { path, maxBytes: 4 * 1024 * 1024 }),
};
