// V161 (A): 保存の Worker。**エンコードと圧縮をメインスレッドから追い出す**ための1枚。
//
// ★受け取る project は postMessage の structured clone ＝ **その瞬間のスナップショット**。
//   メインスレッドで以後どれだけ編集しても、ここにある姿は変わらない（V160 S-2 で実証済み:
//   眠り控えの z は生成後不変・破棄は参照の付け替えなので、clone に写った z も安全。
//   V163: PV6 遅延読みの z はファイルバッファへのビューだが、clone は下敷きの
//   ArrayBuffer ごと1回で写すので、ビューのまま正しく届く）。
//
// ★書くのは **PV6（現行形式・V163・二部構成）だけ**。眠り控えの塊はそのまま写すので、掃除が済んだ
//   大きい作品では**再圧縮ゼロ**（V162 実測 0.5s）。完成品を1回で返す。
//   V163 の gzip モード（旧形式 PV5＝projectToBytes）は V197 (A-103・作者決定 2026-10-07) でなくした。
//   要求に形式の指定が付いていても**見ない**（v197_smoke [B-5] が gzip を指定しても PV6 になることを確かめる）。
//
// Worker 内で使えることは V160 で確認済み: CompressionStream / DecompressionStream /
// Uint8Array.toBase64（serialize.ts / pv6.ts が全部この中から呼ぶ）。
// i18n は import 時に DOM を触らない（navigator は typeof ガード済み）ので import しても安全。
import { encodePV6 } from "./pv6";
import type { Project } from "./model";

interface EncodeRequest {
  kind: "encode";
  seq: number;
  project: Project;
}

self.onmessage = async (ev: MessageEvent<EncodeRequest>) => {
  const d = ev.data;
  if (d?.kind !== "encode") return;
  try {
    // opts なし＝中断しない（スナップショットは clone 済みでメインスレッドを塞がない）
    const r = await encodePV6(d.project);
    if (!r) throw new Error("encodePV6 returned null without abort opts");
    const bytes = r.bytes;
    // 転送（コピーしない）。以後この Worker は bytes に触らない
    (self as unknown as Worker).postMessage({ kind: "done", seq: d.seq, bytes }, [
      bytes.buffer,
    ]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ kind: "error", seq: d.seq, message: String(e) });
  }
};
