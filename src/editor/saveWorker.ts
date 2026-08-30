// V161 (A): 保存の Worker。**エンコードと圧縮をメインスレッドから追い出す**ための1枚。
//
// ★受け取る project は postMessage の structured clone ＝ **その瞬間のスナップショット**。
//   メインスレッドで以後どれだけ編集しても、ここにある姿は変わらない（V160 S-2 で実証済み:
//   眠り控えの z は生成後不変・破棄は参照の付け替えなので、clone に写った z も安全。
//   V163: PV6 遅延読みの z はファイルバッファへのビューだが、clone は下敷きの
//   ArrayBuffer ごと1回で写すので、ビューのまま正しく届く）。
//
// ★2つのモード（V163 で chunks モード＝Rust 側 gzip 用のチャンク供給は撤去した）:
//   - "pv6" : 現行形式（V163・二部構成）。眠り控えの塊はそのまま写すので、掃除が済んだ
//     大きい作品では**再圧縮ゼロ**（V162 実測 0.5s）。完成品を1回で返す
//   - "gzip": 旧形式（PV5）。旧バージョンのアプリでも開ける形で書き出すときに使う。
//     出力バイト列は v1.5.9 の保存と同一（projectToBytes）
//
// Worker 内で使えることは V160 で確認済み: CompressionStream / DecompressionStream /
// Uint8Array.toBase64（serialize.ts / pv6.ts が全部この中から呼ぶ）。
// i18n は import 時に DOM を触らない（navigator は typeof ガード済み）ので import しても安全。
import { projectToBytes } from "./serialize";
import { encodePV6 } from "./pv6";
import type { Project } from "./model";

interface EncodeRequest {
  kind: "encode";
  seq: number;
  mode: "pv6" | "gzip";
  project: Project;
}

self.onmessage = async (ev: MessageEvent<EncodeRequest>) => {
  const d = ev.data;
  if (d?.kind !== "encode") return;
  try {
    let bytes: Uint8Array;
    if (d.mode === "gzip") {
      bytes = await projectToBytes(d.project);
    } else {
      // opts なし＝中断しない（スナップショットは clone 済みでメインスレッドを塞がない）
      const r = await encodePV6(d.project);
      if (!r) throw new Error("encodePV6 returned null without abort opts");
      bytes = r.bytes;
    }
    // 転送（コピーしない）。以後この Worker は bytes に触らない
    (self as unknown as Worker).postMessage({ kind: "done", seq: d.seq, bytes }, [
      bytes.buffer,
    ]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ kind: "error", seq: d.seq, message: String(e) });
  }
};
