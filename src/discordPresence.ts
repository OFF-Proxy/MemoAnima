// V193 (A-95): Discord にプレイ状況を表示する（docs/REQ_discord_rpc.md）——フロント側の決まりだけを置く純関数。
//
// Discord に渡す中身は Rust（src-tauri/src/discord.rs）が組む。フロントが渡せるのは
// 「オンか」と「固定の 1 文（UI の言語）」の 2 つだけ。**作品・アルバム・パスを受け取る口が無い**
// （引数は設定だけで、その中の discordPresence しか読まない）。
// V193b: 初回の知らせ（discordNoticeDue）は外した（作者決定 2026-10-04・本体で案内しない）。旧キー discordNoticeShown は読まない。
// `scripts/v193_smoke.ts` [S-1] が、作品名やパスの入った設定を渡して出てくるものを確かめる。
import { t } from "./i18n";

/** `*Key: "…"`＝i18n 検査4 が辞書との突き合わせに拾う形（変数で引くキーの規約） */
const KEYS = { detailsKey: "set.discord.details.msg" } as const;

/** Discord に出す 1 文（details）のキー。全言語とも固定の文（作品の情報を差し込まない） */
export const DISCORD_DETAILS_KEY = KEYS.detailsKey;

/** 読むのはこれだけ（Settings 全体をそのまま渡してよい） */
type PresenceSettings = { discordPresence?: unknown };

/** ⚙「Discord にプレイ状況を表示する」。**未設定・壊れた値＝オン**（`updateCheck` と同じ `!== false` の作法） */
export function discordPresenceEnabled(s: PresenceSettings): boolean {
  return s.discordPresence !== false;
}

/** `discord_presence_set` に渡す引数（**これが全部**） */
export function discordPresenceArgs(s: PresenceSettings): { enabled: boolean; details: string } {
  return { enabled: discordPresenceEnabled(s), details: t(DISCORD_DETAILS_KEY) };
}
