// V212 (M-1c・要件 docs/REQ_mobile_m1_base.md §6-3・D-M1-3): **Android の口**。作品とオートセーブのバイト列を、invoke に生のバイト列でも
// 数の配列でも渡さない。
//
// ★Android の invoke はいつも postMessage（Tauri 2.12.5 の ipc-protocol.js）で、`Uint8Array` の引数は `Array.from` で JSON の数の配列になる
//  （Rust には InvokeBody::Json で届き、生のボディを受ける書く命令は断る）。読む命令の戻り（生のバイト列）は、1 回分を丸ごと Java の byte[] に
//  写す（wry の android/binding.rs）＝大きい作品は Java のヒープを超えうる（エミュレーターで 210MB の作品が OutOfMemoryError でアプリごと落ちた）。
// ★書く: 生のボディの封筒（`packRawBody`＝iOS・PC と同じ並び）を 4MiB 以下に分けて base64 の文字列で順に送り、そろったら Rust が今の 1 段へ
//  渡す（`mobile_chunk_*`）。読む: Rust が今の 1 段で作った封筒を 4MiB 以下の切れ端で受け取る（`mobile_read_*`）。
// ★`@tauri-apps/api` はここでも読まない（invoke を受け取る形）。invoke は makeAndroidPort の引数だけで、呼ぶときは命令の名前を文字で直に書く
//  （v202_smoke [K-2] の決まり＝名前を替えて PC の命令を呼ぶ道を作らない）。iOS と PC の口（port.ts の makeMobilePort）は変えない。
//  ほかの命令（引数が JSON の物だけ）は makeMobilePort のものをそのまま使う
import { readAutosaveEnvelope } from "../editor/saveCore";
import { makeMobilePort, MobileRefusal, packRawBody, REFUSALS, type Fingerprint, type InvokeLike, type MobilePort, type RefusalCode, type SaveResult } from "./port";

/** 1 回に送る・受け取る大きさ（Rust の chunks::CHUNK_MAX と同じ 4MiB） */
export const ANDROID_CHUNK = 4 * 1024 * 1024;

/** 決まった値の断りは MobileRefusal に（port.ts の asRefusal と同じ） */
async function call<T>(p: Promise<unknown>): Promise<T> {
  try {
    return (await p) as T;
  } catch (e) {
    if (typeof e === "string" && (REFUSALS as readonly string[]).includes(e)) throw new MobileRefusal(e as RefusalCode);
    throw e;
  }
}

/** base64（標準の字・`=` の詰め）。大きい塊は 32KiB ずつ文字にする（引数の数の上限を超えない） */
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

type ChunkKind = "saveNew" | "saveOverwrite" | "autosave";

/** ★Android の口。書く 3 つ・読む 2 つを分けて送る・受け取る道に差し替え、ほかは makeMobilePort のまま */
export function makeAndroidPort(invoke: InvokeLike): MobilePort {
  const base = makeMobilePort(invoke);

  /** 封筒を分けて送る（そろえるまで。受け取りの命令は呼ぶ側が文字で書く）。途中で失敗したら送りをやめる（Rust の置き場から消す） */
  const upload = async (kind: ChunkKind, body: Uint8Array, ids: { session?: string; gen?: number } = {}): Promise<string> => {
    const up = await call<string>(invoke("mobile_chunk_begin", { args: { kind, total: body.length, ...ids } }));
    try {
      for (let i = 0, k = 0; i < body.length; i += ANDROID_CHUNK, k++) {
        await call<null>(invoke("mobile_chunk_put", { args: { upload: up, index: k, data: toBase64(body.subarray(i, i + ANDROID_CHUNK)) } }));
      }
    } catch (e) {
      await call<null>(invoke("mobile_chunk_abort", { args: { upload: up } })).catch(() => undefined);
      throw e;
    }
    return up;
  };

  /** ★今の 1 段が作った封筒を 4MiB 以下の切れ端で受け取る（終わったら Rust のメモリを放す） */
  const download = async (args: Record<string, unknown>): Promise<Uint8Array> => {
    const h = await call<{ download: string; size: number }>(invoke("mobile_read_begin", { args }));
    try {
      const out = new Uint8Array(h.size);
      for (let off = 0; off < h.size; off += ANDROID_CHUNK) {
        const len = Math.min(ANDROID_CHUNK, h.size - off);
        const part = await call<ArrayBuffer | Uint8Array | number[]>(invoke("mobile_read_slice", { args: { download: h.download, offset: off, len } }));
        const b = part instanceof Uint8Array ? part : part instanceof ArrayBuffer ? new Uint8Array(part) : Uint8Array.from(part);
        if (b.length !== len) throw new MobileRefusal("io");
        out.set(b, off);
      }
      return out;
    } finally {
      await call<null>(invoke("mobile_read_end", { args: { download: h.download } })).catch(() => undefined);
    }
  };

  return {
    ...base,
    saveNew: async (w) => {
      const up = await upload("saveNew", packRawBody({ album: w.album, name: w.name, selfName: w.selfName }, [w.data, w.thumb]));
      return call<SaveResult>(invoke("mobile_chunk_save_new", { args: { upload: up } }));
    },
    saveOverwrite: async (w) => {
      const up = await upload("saveOverwrite", packRawBody({ album: w.album, name: w.name, sourceFingerprint: w.sourceFingerprint }, [w.data, w.thumb]));
      return call<SaveResult>(invoke("mobile_chunk_save_overwrite", { args: { upload: up } }));
    },
    autosaveWrite: async (session, gen, meta, data) => {
      const up = await upload("autosave", packRawBody({ session, gen, meta }, [data]), { session, gen });
      await call<null>(invoke("mobile_chunk_autosave_write", { args: { upload: up } }));
    },
    readWork: async (album, name) => {
      const env = readAutosaveEnvelope(await download({ kind: "work", album, name }));
      if (!env) throw new MobileRefusal("io");
      return { data: env.data, fingerprint: env.meta.fingerprint as Fingerprint, album: String(env.meta.album), name: env.path };
    },
    autosaveRead: async (session) => {
      const env = readAutosaveEnvelope(await download({ kind: "autosave", session }));
      return env ? { session: env.path, meta: env.meta, data: env.data } : null;
    },
  };
}
