// V202 (M-1a): モバイルの部品が使う形の確かめ（画面と Tauri に触らない・DOM を読まない）。
// ★同じ名前かの比べ方は Rust の `names::fold_key` と同じ（NFC → 小文字 → NFC）。見本は contract.json の formats.foldSame／foldDiffer
//  （v202_smoke [K-3] が両側に同じ見本を通す）
// ★セッションの番号は小文字の hex 32 字（Rust の `sessions::is_session_id` と同じ形）。作るのは JS の部品だけ
//  （`crypto.getRandomValues`＝安全なコンテキストでない WebView でも動く）
import type { Fingerprint } from "./port";

/** 同じ名前かを比べる鍵（大小と NFC を無視） */
export function foldName(s: string): string {
  return s.normalize("NFC").toLowerCase().normalize("NFC");
}

const SESSION_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** セッションの番号の形か */
export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && SESSION_RE.test(v);
}

/** 新しいセッションの番号（作品の ID とは別の乱数） */
export function newSessionId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** 指紋の形か（小文字の hex 64 字と、0 以上の安全な整数の大きさ） */
export function isFingerprint(v: unknown): v is Fingerprint {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return typeof f.sha256 === "string" && SHA256_RE.test(f.sha256) && typeof f.size === "number" && Number.isSafeInteger(f.size) && f.size >= 0;
}

/** 2 つの指紋が同じか */
export function sameFingerprint(a: Fingerprint | null, b: Fingerprint | null): boolean {
  return !!a && !!b && a.sha256 === b.sha256 && a.size === b.size;
}
