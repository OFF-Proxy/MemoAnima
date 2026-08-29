// V161 (A): 保存の Worker。**エンコードと圧縮をメインスレッドから追い出す**ための1枚。
//
// ★受け取る project は postMessage の structured clone ＝ **その瞬間のスナップショット**。
//   メインスレッドで以後どれだけ編集しても、ここにある姿は変わらない（V160 S-2 で実証済み:
//   眠り控えの z は生成後不変・破棄は参照の付け替えなので、clone に写った z も安全）。
//
// ★2つのモード（editor が Rust の使えるなしで選ぶ）:
//   - "chunks": gzip **前**の JSON バイト列をチャンクで返す（メインスレッドが Rust へ転送し、
//     Rust の flate2 が圧縮する＝V161-B）。チャンクごとに ack を待つ＝**作り溜めない**
//     （待たずに作ると 2.1GB ぶんのチャンクが postMessage キューに山積みになる）
//   - "gzip": 従来どおり Worker 内の CompressionStream で圧縮し、完成品を1回で返す
//     （Rust が使えない環境の fallback。出力バイト列は v1.5.9 の保存と同一）
//
// Worker 内で使えることは V160 で確認済み: CompressionStream / DecompressionStream /
// Uint8Array.toBase64（serialize.ts が全部この中から呼ぶ）。
// i18n は import 時に DOM を触らない（navigator は typeof ガード済み）ので import しても安全。
import { projectToBytes, encodeProjectRawChunks } from "./serialize";
import type { Project } from "./model";

interface EncodeRequest {
  kind: "encode";
  seq: number;
  mode: "chunks" | "gzip";
  project: Project;
}
interface AckMessage {
  kind: "ack";
  seq: number;
}

let ackWaiter: (() => void) | null = null;

self.onmessage = async (ev: MessageEvent<EncodeRequest | AckMessage>) => {
  const d = ev.data;
  if (d.kind === "ack") {
    ackWaiter?.();
    ackWaiter = null;
    return;
  }
  if (d.kind !== "encode") return;
  try {
    if (d.mode === "gzip") {
      const bytes = await projectToBytes(d.project);
      // 転送（コピーしない）。以後この Worker は bytes に触らない
      (self as unknown as Worker).postMessage({ kind: "done", seq: d.seq, bytes }, [
        bytes.buffer,
      ]);
    } else {
      await encodeProjectRawChunks(d.project, async (chunk) => {
        const acked = new Promise<void>((r) => {
          ackWaiter = r;
        });
        (self as unknown as Worker).postMessage({ kind: "chunk", seq: d.seq, bytes: chunk }, [
          chunk.buffer,
        ]);
        // ★背圧: メインスレッドが Rust へ流し終える（ack が返る）まで次のチャンクを作らない
        await acked;
      });
      (self as unknown as Worker).postMessage({ kind: "done", seq: d.seq });
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({ kind: "error", seq: d.seq, message: String(e) });
  }
};
