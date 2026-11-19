// V227 (X-4): 設定を書く命令を 1 つずつ順に送る（画面の側の決まり）。
//
// ★なぜ: 設定の画面は、行を替えるたびに port.settingsMerge を待たずに投げる（描く画面・ライブラリ・設定の画面の 3 か所）。Rust の命令は
//  lock_lib の中で読み直して足すが、2 つを続けて送ると、どちらが先に lock を取るかは決まらない（Tauri の命令の受け口・Android の
//  JavaScript の口の並びに頼ることになる）。同じキーを素早く 2 回替えたとき、前の値が後に書かれる道を作らない。
// ★やり方: ライブラリが受け取ったポート（描く画面へも同じものを渡す）を包み、settingsMerge だけを前の答えが返ってから送る。
//  書くのは変えたキーだけ（渡された values をそのまま送る）・失敗しても次は送る（失敗は呼んだ側へそのまま返す）。ほかの命令は元のまま。
//  保存のつなぎ（src/mobile/port.ts・session.ts・workScreen.ts）は変えない。
import type { MobilePort } from "../../mobile/port";

export function queueSettingsWrites(port: MobilePort): MobilePort {
  let last: Promise<unknown> = Promise.resolve();
  // settingsMerge だけを差し替えた写し（ほかの命令はそのまま元のポートへ届く・android/devcheck の口と同じく展開の形＝さらに展開しても命令が落ちない）
  return {
    ...port,
    settingsMerge: (values) => {
      const run = last.then(() => port.settingsMerge(values));
      last = run.catch(() => undefined);
      return run;
    },
  };
}
