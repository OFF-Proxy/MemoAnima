// V202 (M-1a): モバイルの部品へ渡す**本物の** Tauri の invoke。`@tauri-apps/api` を読むのはモバイルの部品の中でここだけ
// （v202_smoke [C-1] が構文木で見る）。PC の入口（main.ts・editor.ts・library.ts・kwzBatch.ts）からはたどれない。
// 命令をアプリに登録する（run() へつなぐ）のは M-1b（src-tauri/src/pclib/mobile/commands.rs の handler）
// V212 (M-1c): Android は分けて送る・受け取る口（androidPort.ts）。iOS は今の口（生のボディと ArrayBuffer）のまま
import { invoke } from "@tauri-apps/api/core";
import { makeAndroidPort } from "./androidPort";
import { makeMobilePort, type MobilePort } from "./port";

export function tauriMobilePort(os?: string): MobilePort {
  if (os === "android") return makeAndroidPort((cmd, args) => invoke(cmd, args));
  return makeMobilePort((cmd, args) => invoke(cmd, args));
}
