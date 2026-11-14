// V211 (M-1b・要件 §6-5): 確かめ画面（開発用）が呼ぶ命令の口。ビルドの印（__MOBILE_DEVCHECK__）の中だけで読み込まれる。
//
// - `mobile_dev_*`: 試験用のライブラリ・故障を起こす口・記録（Rust は feature `mobile-devcheck` の中だけ。故障は試験用のライブラリでだけ
//   通る＝命令の側でも断る）
// - ★V224 (V211b の F2): 一覧・サムネ・削除・控えから戻すは、Rust が場所を決めるライブラリの命令（MobilePort の libraryList ほか）で。
//   PC の命令（list_albums・scan_library・list_recoverable・recover_project・delete_note・delete_album・read_file_raw）は、
//   モバイルの登録の表から外した＝ここからも呼ばない（JS は場所〔パス〕を持たない）
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
