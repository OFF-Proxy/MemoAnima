// V175: Mac のアプリ内更新の部品（REQ_mac_signing_and_update.md §2・§4 [3]・§10）。
//   使うのは make_release.ts（--with-mac）・mac_build.ts（--rehearsal-old）・mac_update_rehearsal.ts・v175_smoke.ts。
//   単体で打つのは 1 つだけ（出す日に・[S-7]）:
//     npx tsx scripts/mac_update.ts check-live
//     npx tsx scripts/mac_update.ts check-live --windows-only   … darwin を足す前の feed（v1.9.5 まで）を見るとき
//
// ★ここに集めた理由: `latest.json` は **Windows 全利用者の更新の入り口**。組み立て・検査・署名の確かめを
//   スクリプトごとに書き分けると、どこか 1 か所だけ緩む。**1 か所に置いて、全員がそれを通る**形にした
//   （make_release も、Mac のリハーサルの配り手も、出す日の check-live も同じ関数で見る）。
//
// ★署名の確かめ（R-15）は `tauri signer` に頼らず、ここで minisign をそのまま確かめる
//   （blake2b-512 → ed25519・鍵の番号・信頼コメントの署名まで）。updater の中身（minisign-verify 0.2.5 の
//   `PublicKey::verify`）と同じ手順。V207: updater 2.13.3 から minisign-verify 0.3 になったが、確かめの手順は同じ
//   （v1.9.5 の利用者の updater 2.10.1 は 0.2.5 のまま＝どちらの利用者もこの手順で通るものだけを配る）。
//   **本物の公開鍵は tauri.conf.json から読む**（make_release・配り手・check-live の
//   どれも、コマンドの引数や環境変数から公開鍵を受け取る口を持たない。関数そのものは検査のために公開鍵を引数で受ける）。
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** tauri.conf.json（版・製品名・updater の公開鍵と配信元）。**読むだけ**（このファイルは書き換えない） */
export function readConf(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
}

// ================= minisign（R-15） =================
//
// 形（tauri の .sig と latest.json の signature はどちらも「下の 4 行を base64 にしたもの」）:
//   untrusted comment: signature from tauri secret key
//   <base64: "ED"(2) + 鍵の番号(8) + 署名(64)>          ← "ED" は blake2b-512 で先に縮めた形（"Ed" は縮めない古い形）
//   trusted comment: timestamp:…\tfile:<ファイル名>\tversion:<版>
//   <base64: 信頼コメントの署名(64) = ed25519(署名 ‖ 信頼コメント)>
// V207: `\tversion:<版>` は CLI 2.12 から（最後の欄に足す＝file: の読み方は前のまま）。`tauri build` は updater の配信物に
//   必ず入れる・`tauri signer sign` は `--app-version <版>` を渡したときだけ入れる（無いと警告だけで、終了コード 0 のまま
//   版の無い署名を書く）。v1.9.5 までの署名（CLI 2.11.4）には版が無い。updater は tauri.conf.json の requireSignedVersion で
//   版の無い署名を断り、版があれば feed の版と比べる（下の signedVersion・R-15 の「信頼コメントの版＝出す版」）
// 公開鍵（tauri.conf.json の plugins.updater.pubkey）は:
//   untrusted comment: minisign public key: <鍵の番号を 16 進で>
//   <base64: "Ed"(2) + 鍵の番号(8) + 公開鍵(32)>

/** ed25519 の生の公開鍵（32 バイト）を Node の鍵にする前置き（SPKI の DER の頭） */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** base64 として**そのまま**読めるか。前後の空白も許さない（updater の base64 STANDARD と同じく、空白があれば読めない） */
const b64Strict = (s: string): Buffer | null => {
  const t = s;
  if (t === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  const b = Buffer.from(t, "base64");
  return b.toString("base64") === t ? b : null;
};

/** 鍵の番号を minisign と同じ書き方（8 バイトを逆順の 16 進・大文字）にする */
const keyIdHex = (id: Buffer) => Buffer.from(id).reverse().toString("hex").toUpperCase();

export type MinisignPublicKey = { keyId: Buffer; keyIdHex: string; key: Buffer };
export type MinisignSignature = {
  prehashed: boolean;
  keyId: Buffer;
  keyIdHex: string;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
};

/** tauri.conf.json の pubkey（base64 で包んだ minisign の公開鍵）を読む。形が違えば投げる */
export function parseMinisignPublicKey(confPubkey: string): MinisignPublicKey {
  const outer = b64Strict(confPubkey);
  if (!outer) throw new Error("公開鍵が base64 ではありません");
  const lines = outer.toString("utf8").split(/\r?\n/);
  if (!lines[0]?.startsWith("untrusted comment:")) throw new Error("公開鍵の 1 行目が untrusted comment: ではありません");
  const bin = b64Strict(lines[1] ?? "");
  if (!bin || bin.length !== 42) throw new Error("公開鍵の 2 行目が 42 バイトではありません");
  if (bin[0] !== 0x45 || bin[1] !== 0x64) throw new Error("公開鍵の方式が Ed ではありません");
  const keyId = bin.subarray(2, 10);
  // 1 行目に書かれた番号と中身の番号が食い違う公開鍵は、壊れているか差し替えられている
  const said = /minisign public key:?\s*([0-9A-Fa-f]{16})/.exec(lines[0])?.[1]?.toUpperCase();
  if (said !== undefined && said !== keyIdHex(keyId)) throw new Error("公開鍵の 1 行目の番号と中身の番号が違います");
  return { keyId, keyIdHex: keyIdHex(keyId), key: bin.subarray(10, 42) };
}

/** .sig の中身（＝latest.json の signature）を読む。形が違えば投げる */
export function parseMinisignSignature(sigB64: string): MinisignSignature {
  const outer = b64Strict(sigB64);
  if (!outer) throw new Error("署名が base64 ではありません");
  const lines = outer.toString("utf8").split(/\r?\n/);
  if (!lines[0]?.startsWith("untrusted comment:")) throw new Error("署名の 1 行目が untrusted comment: ではありません");
  const bin1 = b64Strict(lines[1] ?? "");
  if (!bin1 || bin1.length !== 74) throw new Error("署名の 2 行目が 74 バイトではありません");
  const tc = lines[2] ?? "";
  if (!tc.startsWith("trusted comment: ")) throw new Error("署名の 3 行目が trusted comment: ではありません");
  const bin2 = b64Strict(lines[3] ?? "");
  if (!bin2 || bin2.length !== 64) throw new Error("署名の 4 行目が 64 バイトではありません");
  let prehashed: boolean;
  if (bin1[0] === 0x45 && bin1[1] === 0x44) prehashed = true; // "ED"
  else if (bin1[0] === 0x45 && bin1[1] === 0x64) prehashed = false; // "Ed"（古い形・updater も受ける）
  else throw new Error("署名の方式が ED / Ed のどちらでもありません");
  const keyId = bin1.subarray(2, 10);
  return {
    prehashed,
    keyId,
    keyIdHex: keyIdHex(keyId),
    signature: bin1.subarray(10, 74),
    trustedComment: tc.slice("trusted comment: ".length),
    globalSignature: bin2,
  };
}

export type VerifyResult =
  | { ok: true; keyIdHex: string; prehashed: boolean; trustedComment: string }
  | { ok: false; why: string };

/**
 * R-15: `data` が `sigB64` の署名どおりで、それが `pubkeyB64` の鍵で作られたものか。**投げない**（理由を返す）。
 * 手順は updater と同じ: 鍵の番号 → blake2b-512 → ed25519 → 信頼コメントの署名。
 * ⚠ 鍵の番号が違うときは、署名の中身を見る前に赤にする（**使い捨て鍵の .sig** はここで捕まる）。
 */
export function verifyMinisign(data: Uint8Array, sigB64: string, pubkeyB64: string): VerifyResult {
  let pk: MinisignPublicKey;
  let sg: MinisignSignature;
  try {
    pk = parseMinisignPublicKey(pubkeyB64);
  } catch (e) {
    return { ok: false, why: `公開鍵を読めません（${(e as Error).message}）` };
  }
  try {
    sg = parseMinisignSignature(sigB64);
  } catch (e) {
    return { ok: false, why: `署名を読めません（${(e as Error).message}）` };
  }
  if (!sg.keyId.equals(pk.keyId)) {
    return { ok: false, why: `鍵の番号が違います（署名は ${sg.keyIdHex} の鍵・公開鍵は ${pk.keyIdHex}）` };
  }
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pk.key]),
    format: "der",
    type: "spki",
  });
  const msg = sg.prehashed ? crypto.createHash("blake2b512").update(data).digest() : Buffer.from(data);
  if (!crypto.verify(null, msg, key, sg.signature)) return { ok: false, why: "中身の署名が合いません（ファイルが違うか、壊れています）" };
  const global = Buffer.concat([sg.signature, Buffer.from(sg.trustedComment, "utf8")]);
  if (!crypto.verify(null, global, key, sg.globalSignature)) return { ok: false, why: "信頼コメントの署名が合いません" };
  return { ok: true, keyIdHex: sg.keyIdHex, prehashed: sg.prehashed, trustedComment: sg.trustedComment };
}

/** 信頼コメントの `file:` の値（tauri は署名したファイルの名前を入れる）。無ければ null */
export function trustedFileName(trustedComment: string): string | null {
  for (const part of trustedComment.split("\t")) if (part.startsWith("file:")) return part.slice("file:".length);
  return null;
}

/**
 * V207: 信頼コメントの `version:` の値（CLI 2.12 から）。無ければ null。
 * **読み方は updater 2.14.0 の `signed_version` と同じ**: タブで割って、`version:` で始まる**最初の**欄
 * （`file:app-version:2.zip` のように別の欄の途中にある字は読まない）。
 * ⚠ 信頼コメントは verifyMinisign で署名を確かめたあとでなければ信じない（呼ぶ側は必ず確かめたあとに渡す）
 */
export function signedVersion(trustedComment: string): string | null {
  for (const part of trustedComment.split("\t")) if (part.startsWith("version:")) return part.slice("version:".length);
  return null;
}

/**
 * V207 (R-15): 信頼コメントの版が出す版と同じか。同じなら null、違えば理由（画面に出す字）。
 * 比べは**字の完全一致**（updater は semver で比べ、頭の v も同じと見る＝こちらのほうが厳しい）。
 * 版が無い署名は止める（tauri.conf.json の requireSignedVersion で、利用者の updater が断る）。
 * `expectVersion` が x.y.z でなければ投げる（版を省く・空の版で通る道を作らない）。
 */
export function signedVersionProblem(trustedComment: string, expectVersion: string): string | null {
  parseVersion(expectVersion);
  const got = signedVersion(trustedComment);
  if (got === null) return "署名に版が入っていません（信頼コメントに version: がありません・利用者の updater が断ります）";
  if (got !== expectVersion) return `署名の版が ${JSON.stringify(got)} で、出す版 ${JSON.stringify(expectVersion)} と違います`;
  return null;
}

/**
 * 配信物と署名の組を R-15 で確かめ、**信頼コメントのファイル名も配る名前と同じ**であることを見る。
 * V207: **信頼コメントの版も出す版（`expectVersion`）と同じ**であることを見る（版が無い・違う署名は止める）。
 *   版は省けない（x.y.z でなければ投げる）。版の比べは verifyMinisign の外に置く（verifyMinisign は v1.9.5 の
 *   版の無い本物の署名も確かめる＝v1.9.5 の利用者が受け入れる形の確かめなので、版を見ない）。
 * 落ちたら投げる（make_release はここで止まる＝dist-release/ に何も増えない）。
 */
export function assertReleaseSignature(file: string, sigB64: string, pubkeyB64: string, expectName: string, expectVersion: string, label: string): void {
  const v = verifyMinisign(fs.readFileSync(file), sigB64, pubkeyB64);
  if (!v.ok) throw new Error(`R-15 で止めました（${label}）: ${v.why}`);
  const named = trustedFileName(v.trustedComment);
  if (named !== expectName) {
    throw new Error(`R-15 で止めました（${label}）: 署名の信頼コメントのファイル名が ${JSON.stringify(named)} で、配る名前 ${JSON.stringify(expectName)} と違います`);
  }
  const vp = signedVersionProblem(v.trustedComment, expectVersion);
  if (vp) throw new Error(`R-15 で止めました（${label}）: ${vp}`);
  console.log(`  OK: R-15 ${label} の署名が tauri.conf.json の公開鍵（${v.keyIdHex}）で通ります（${v.prehashed ? "blake2b-512＋ed25519" : "ed25519"}・信頼コメントも・版 ${expectVersion}）`);
}

// ================= feed（latest.json） =================

export const WINDOWS_KEY = "windows-x86_64";
/** universal の .app.tar.gz 1 本を、この 2 つのキーから**同じ url・同じ signature**で指す（REQ §1） */
export const DARWIN_KEYS = ["darwin-aarch64", "darwin-x86_64"] as const;
/** --dry-run の Windows の署名（ビルドしないので本物は出せない）。v1.9.5 までの dry-run と同じ文字列 */
export const DRY_RUN_WINDOWS_SIGNATURE = "<ビルド後に .sig の中身が入ります（--dry-run では出せません）>";
/** §2「明示」5: 配る url の頭。**make_release の組み立てとは別に**ここで書く（同じ式を共有すると、両方一緒に間違える） */
export const releaseUrlPrefix = (version: string) => `https://github.com/OFF-Proxy/MemoAnima/releases/download/v${version}/`;

export type FeedEntry = { signature: string; url: string };
export type Feed = { version: string; notes: string; pub_date: string; platforms: Record<string, FeedEntry> };

/**
 * feed を組み立てる。**`mac` を渡さなければ v1.9.5 と同じ形**（キーの並びも同じ: version → notes → pub_date →
 * platforms、項目は signature → url）。`mac` を渡したときだけ、Windows の項目の**うしろに** darwin の 2 キーを足す
 * ——だから darwin の 2 キーを取り除くと、渡さなかったときと 1 文字も違わない（[S-3]）。
 */
export function buildFeed(a: { version: string; notes: string; pubDate: string; windows: FeedEntry; mac?: FeedEntry }): Feed {
  const platforms: Record<string, FeedEntry> = {
    [WINDOWS_KEY]: { signature: a.windows.signature, url: a.windows.url },
  };
  if (a.mac) for (const k of DARWIN_KEYS) platforms[k] = { signature: a.mac.signature, url: a.mac.url };
  return { version: a.version, notes: a.notes, pub_date: a.pubDate, platforms };
}

/** 書き出す文字列（v1.9.5 までの `JSON.stringify(feed, null, 2)` と同じ） */
export const feedText = (feed: Feed) => JSON.stringify(feed, null, 2);

export type Check = { name: string; ok: boolean; why?: string; note?: string };
export type FeedExpect = {
  version: string;
  /** darwin の 2 キーがあるはずか（make_release の --with-mac・出す日の check-live） */
  withMac: boolean;
  /** --dry-run のときだけ: Windows の署名は**この仮の文字列**のはず（本物の形の検査は「仮」と書いて通す） */
  placeholderWindowsSignature?: string;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

/** minisign の形か（base64 を開くと untrusted comment: で始まり、4 行の形として読める） */
export function looksLikeMinisign(sig: string): boolean {
  const outer = b64Strict(sig);
  if (!outer || !outer.toString("utf8").startsWith("untrusted comment:")) return false;
  try {
    parseMinisignSignature(sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * §2「明示」の 8 項目（＋顔ぶれ・pub_date の形）。**投げない**——全部の結果を返す。
 * 書く前のオブジェクトにも、書いたあと読み直したものにも同じものを当てる。
 */
export function checkFeed(feed: unknown, ex: FeedExpect): Check[] {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, why?: string, note?: string) => out.push({ name, ok, why, note });
  const f = isObj(feed) ? feed : {};
  const plat = isObj(f.platforms) ? (f.platforms as Record<string, unknown>) : {};
  const keys = Object.keys(plat);
  const entries = keys.map((k) => [k, plat[k]] as const);
  const darwin = DARWIN_KEYS.map((k) => plat[k]).filter((x) => x !== undefined);

  // 1
  const top = isObj(feed) ? Object.keys(feed) : [];
  add(
    "明示 1 最上位のキーが version / notes / pub_date / platforms の 4 つだけ・この順",
    JSON.stringify(top) === JSON.stringify(["version", "notes", "pub_date", "platforms"]),
    `いま ${JSON.stringify(top)}`
  );
  // 2
  add("明示 2 version が tauri.conf.json と一致", f.version === ex.version, `feed ${JSON.stringify(f.version)}・tauri.conf.json ${ex.version}`);
  // 3
  add("明示 3 notes が空でない", nonEmptyStr(f.notes), "notes が空（全利用者の更新の窓が白紙になる）");
  // 4
  const bad4 = entries.filter(([, e]) => !isObj(e) || JSON.stringify(Object.keys(e)) !== JSON.stringify(["signature", "url"]) || !nonEmptyStr(e.signature) || !nonEmptyStr(e.url));
  add(
    "明示 4 すべての項目に signature と url が両方あり、空でない（項目のキーは signature → url だけ）",
    keys.length > 0 && bad4.length === 0,
    keys.length === 0 ? "platforms が空" : `欠けている項目: ${bad4.map(([k]) => k).join(" ")}`
  );
  // 5
  const prefix = releaseUrlPrefix(ex.version);
  const bad5 = entries.filter(([, e]) => !isObj(e) || typeof e.url !== "string" || !e.url.startsWith(prefix) || e.url.length <= prefix.length);
  add(`明示 5 url が ${prefix} で始まる`, keys.length > 0 && bad5.length === 0, `違う項目: ${bad5.map(([k]) => k).join(" ")}`);
  // 6
  if (darwin.length === 0) add("明示 6 darwin の 2 キーは url と signature が互いに完全一致", true, undefined, "darwin なし");
  else {
    const [a, b] = DARWIN_KEYS.map((k) => plat[k]);
    const same =
      isObj(a) && isObj(b) && a.url === b.url && a.signature === b.signature && JSON.stringify(a) === JSON.stringify(b);
    add("明示 6 darwin の 2 キーは url と signature が互いに完全一致", darwin.length === 2 && same, darwin.length !== 2 ? "★片方だけある" : "★2 キーの中身が違う");
  }
  // 7
  if (darwin.length === 0) add("明示 7 darwin の url が .app.tar.gz で終わる", true, undefined, "darwin なし");
  else {
    const bad7 = DARWIN_KEYS.filter((k) => !isObj(plat[k]) || typeof (plat[k] as FeedEntry).url !== "string" || !(plat[k] as FeedEntry).url.endsWith(".app.tar.gz"));
    add("明示 7 darwin の url が .app.tar.gz で終わる", bad7.length === 0, `違う: ${bad7.join(" ")}（updater が受け取れるのは tar.gz だけ）`);
  }
  // 8
  {
    const bad8: string[] = [];
    let provisional = false;
    for (const [k, e] of entries) {
      const sig = isObj(e) ? e.signature : undefined;
      if (k === WINDOWS_KEY && ex.placeholderWindowsSignature !== undefined) {
        // --dry-run: ここだけは本物が出せない。**仮の文字列そのもの**であることを見る（別の何かなら赤）
        if (sig !== ex.placeholderWindowsSignature) bad8.push(`${k}（--dry-run の仮の文字列ではない）`);
        else provisional = true;
        continue;
      }
      if (typeof sig !== "string" || !looksLikeMinisign(sig)) bad8.push(k);
    }
    add(
      "明示 8 signature が minisign の形（untrusted comment: で始まる）",
      keys.length > 0 && bad8.length === 0,
      `違う項目: ${bad8.join(" ")}`,
      provisional ? `${WINDOWS_KEY} は仮（--dry-run の文字列）` : undefined
    );
  }
  // 顔ぶれ（darwin が「あるはずのときだけある」・並びも固定）
  {
    const want = ex.withMac ? [WINDOWS_KEY, ...DARWIN_KEYS] : [WINDOWS_KEY];
    add(
      `顔ぶれ platforms が ${want.join(" / ")}（この順）`,
      JSON.stringify(keys) === JSON.stringify(want),
      `いま ${JSON.stringify(keys)}`
    );
  }
  // 補足: pub_date が updater の読める日時（RFC 3339）か。読めないと**全員の確認がエラーで終わる**
  add(
    "補足 pub_date が RFC 3339 の日時",
    typeof f.pub_date === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(f.pub_date) && !Number.isNaN(Date.parse(f.pub_date)),
    `いま ${JSON.stringify(f.pub_date)}`
  );
  return out;
}

export function printChecks(title: string, checks: Check[]): number {
  console.log(`  ${title}`);
  let ng = 0;
  for (const c of checks) {
    if (c.ok) console.log(`    OK: ${c.name}${c.note ? `（${c.note}）` : ""}`);
    else {
      ng++;
      console.log(`    NG: ${c.name} — ${c.why ?? ""}`);
    }
  }
  return ng;
}

// ================= 一時フォルダで作ってから写す（半端な物を残さない） =================

const tempDirs = new Set<string>();
let exitHooked = false;
/** 一時フォルダを作る。**どの抜け方でも**（例外・process.exit でも）最後に消す */
export function stagingDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(d);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => {
      for (const x of tempDirs) discardStaged(x);
    });
  }
  return d;
}
export function discardStaged(dir: string): void {
  tempDirs.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 一時フォルダが消せなくても、出力先には何も増えていない
  }
}

const sha256 = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

export type StagedFeed = { dir: string; file: string; text: string };

/**
 * §2「明示」: feed を**書く前**に検査し、一時フォルダへ書いて**読み直して**もう一度検査する。
 * 1 つでも落ちたら投げる（出力先には何も書いていない）。通ったものだけを `commitStaged` で写す。
 * `serialize` は検査用の差し込み口（文字コード・改行の事故を作って赤を見るため）。本番は渡さない。
 */
export function stageFeed(feed: Feed, ex: FeedExpect, serialize: (f: Feed) => string = feedText): StagedFeed {
  console.log("== latest.json の検査（REQ §2「明示」・書く前） ==");
  if (printChecks("組み立てたもの", checkFeed(feed, ex)) > 0) throw new Error("§2「明示」で止めました（書く前の検査）。latest.json は書いていません");
  const dir = stagingDir("memoanima-feed-");
  const file = path.join(dir, "latest.json");
  try {
    const text = serialize(feed);
    fs.writeFileSync(file, text, "utf8");
    console.log("== latest.json の検査（書いたあと読み直して） ==");
    const back = fs.readFileSync(file, "utf8");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(back);
    } catch {
      parsed = null;
    }
    const checks = checkFeed(parsed, ex);
    // 書いた文字列と、組み立てたものをそのまま書いた文字列が同じか（化けた・別物を書いた、を捕まえる）
    checks.push({
      name: "読み直したものが組み立てたものと 1 文字も違わない",
      ok: back === text && back === feedText(feed),
      why: "書いた中身が組み立てたものと違う（文字コード・改行・別の書き手）",
    });
    if (printChecks("読み直したもの", checks) > 0) throw new Error("§2「明示」で止めました（読み直しの検査）。latest.json は出力先に写していません");
    return { dir, file, text };
  } catch (e) {
    discardStaged(dir);
    throw e;
  }
}

/** 一時フォルダで確かめた 1 本を出力先へ写し、**写した先を読み直して**同じバイトかを見る。違えば消して投げる */
export function commitStaged(src: string, destDir: string, name: string): string {
  const dest = path.join(destDir, name);
  const want = fs.readFileSync(src);
  fs.copyFileSync(src, dest);
  const got = fs.readFileSync(dest);
  if (!got.equals(want)) {
    try {
      fs.rmSync(dest, { force: true });
    } catch {
      // 消せなくても下で止まる
    }
    throw new Error(`${name} を写した先の中身が違います（写しを消して止めました）`);
  }
  return name;
}

// ================= Mac の配信物（--with-mac） =================

/** フォルダの中のファイルを、入れ子の奥まで（フォルダ自体は返さない・名前は相対） */
export function listFilesDeep(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out;
}

export type TarEntry = { name: string; type: string; data: Buffer };

/** tar を頭から読む（ustar・GNU の長い名前 L・pax の path に対応）。中身の解釈はしない */
export function* tarEntries(tar: Buffer): Generator<TarEntry> {
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  const cstr = (b: Buffer) => {
    const z = b.indexOf(0);
    return b.subarray(0, z < 0 ? b.length : z).toString("utf8");
  };
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) return;
    let name = cstr(h.subarray(0, 100));
    const magic = cstr(h.subarray(257, 263));
    if (magic === "ustar") {
      const prefix = cstr(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    let size = 0;
    if (h[124] & 0x80) for (let i = 125; i < 136; i++) size = size * 256 + h[i];
    else size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("tar の大きさの欄が読めません");
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const start = off + 512;
    if (start + size > tar.length) throw new Error("tar が途中で切れています");
    const data = tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstr(data);
      continue;
    }
    if (type === "x") {
      for (const rec of data.toString("utf8").split("\n")) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === "g" || type === "K") continue;
    const finalName = paxPath ?? longName ?? name;
    longName = null;
    paxPath = null;
    yield { name: finalName, type, data };
  }
}

/** Info.plist（XML）から文字列の値を 1 つ。無ければ null */
export function plistString(xml: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  if (!m) return null;
  return m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

export type AppInTar = { appName: string; version: string; executable: string; executableSha256: string };

/**
 * .app.tar.gz の中の .app を 1 つだけ読む: Info.plist の版（CFBundleShortVersionString）と、
 * 実行ファイル（CFBundleExecutable）の SHA-256。形が違えば投げる。
 */
export function readAppFromTarGz(tarGz: Buffer): AppInTar {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(tarGz);
  } catch {
    throw new Error(".app.tar.gz を gzip として開けません");
  }
  const plists: { app: string; data: Buffer }[] = [];
  const files = new Map<string, Buffer>();
  for (const e of tarEntries(tar)) {
    const n = e.name.replace(/^\.\//, "");
    if (e.type === "0" || e.type === "7") files.set(n, e.data);
    const m = /^([^/]+\.app)\/Contents\/Info\.plist$/.exec(n);
    if (m && (e.type === "0" || e.type === "7")) plists.push({ app: m[1], data: e.data });
  }
  if (plists.length !== 1) throw new Error(`.app.tar.gz の中の .app（Info.plist）がちょうど 1 つではありません（いま ${plists.length} 個）`);
  const { app, data } = plists[0];
  if (data.subarray(0, 6).toString("latin1") === "bplist") throw new Error("Info.plist がバイナリ形式で読めません（tauri の XML 形式ではない）");
  const xml = data.toString("utf8");
  const version = plistString(xml, "CFBundleShortVersionString");
  if (!version) throw new Error("Info.plist に CFBundleShortVersionString がありません");
  const executable = plistString(xml, "CFBundleExecutable");
  if (!executable) throw new Error("Info.plist に CFBundleExecutable がありません");
  const bin = files.get(`${app}/Contents/MacOS/${executable}`);
  if (!bin) throw new Error(".app.tar.gz の中に実行ファイルがありません");
  return { appName: app, version, executable, executableSha256: sha256(bin) };
}

export type MacInput = { tarPath: string; tarFile: string; app: AppInTar };

/**
 * §10-5 の門番: `--with-mac` のフォルダに .app.tar.gz が**ちょうど 1 つ**・**.sig が 1 つも無い**・
 * 中の Info.plist の版が tauri.conf.json と一致。どれか 1 つでも違えば投げる（＝何も作らない）。
 * ⚠ .sig を拒むのは、Mac の**使い捨て鍵の .sig** を Windows へ持ち込ませないため（REQ §4 [3]）。
 *  .app.tar.gz の署名は**必ず Windows の make_release が本物の鍵で作る**。
 */
export function inspectMacDir(dir: string, version: string): MacInput {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("--with-mac のフォルダがありません");
  const all = listFilesDeep(dir);
  const sigs = all.filter((n) => n.toLowerCase().endsWith(".sig"));
  if (sigs.length) {
    throw new Error(
      `★--with-mac のフォルダに .sig が ${sigs.length} 本あります（${sigs.map((s) => path.basename(s)).join(" / ")}）\n` +
        "  → Mac の使い捨て鍵の署名を持ち込まないため止めました。.app.tar.gz だけを置いてください（署名はこのスクリプトが本物の鍵で作ります）"
    );
  }
  const tars = all.filter((n) => n.endsWith(".app.tar.gz"));
  if (tars.length !== 1) {
    throw new Error(`--with-mac のフォルダに .app.tar.gz がちょうど 1 つではありません（いま ${tars.length} 個${tars.length ? `: ${tars.map((t) => path.basename(t)).join(" / ")}` : ""}）`);
  }
  const tarPath = path.join(dir, tars[0]);
  const app = readAppFromTarGz(fs.readFileSync(tarPath));
  if (app.version !== version) {
    throw new Error(
      `★.app.tar.gz の中の Info.plist の版が tauri.conf.json と違います（中 ${app.version}・tauri.conf.json ${version}）\n` +
        "  → 古いビルドか、リハーサルの「古い版の役」を拾っています。この版の mac_build.ts で作った .app.tar.gz を置いてください"
    );
  }
  return { tarPath, tarFile: path.basename(tarPath), app };
}

/** 署名する関数。`file` の署名（.sig の中身＝base64）を返す。失敗は投げる。
 *  V207: `version`（出す版・x.y.z）は**省けない**。信頼コメントに `version:<版>` が入る（CLI 2.12 の --app-version） */
export type Signer = (file: string, version: string) => string;

export type MacStaged = {
  dir: string;
  tarName: string;
  tarPath: string;
  sigPath: string;
  signature: string;
  size: number;
  sha256: string;
};

/**
 * --with-mac の本体（§2 の漏斗・§10-5）。**出力先には何も書かない**——一時フォルダで
 *   ① 門番（inspectMacDir）→ ② `<製品名>_<版>_universal.app.tar.gz` として写す（写しのバイトを確かめる）
 *   → ③ 署名（本番は Windows の本物の鍵）→ ④ R-15（tauri.conf.json の公開鍵で確かめる・信頼コメントの名前も）
 * まで済ませて返す。どこかで落ちたら一時フォルダを消して投げる。写すのは呼ぶ側（`installMacStaged`）。
 */
export function prepareMacRelease(a: { macDir: string; version: string; product: string; pubkey: string; sign: Signer }): MacStaged {
  const input = inspectMacDir(a.macDir, a.version);
  console.log(`  門番: .app.tar.gz がちょうど 1 つ（${input.tarFile}）・.sig なし・Info.plist の版 ${input.app.version} が tauri.conf.json と一致`);
  const tarName = `${a.product}_${a.version}_universal.app.tar.gz`;
  const dir = stagingDir("memoanima-mac-release-");
  try {
    const tarPath = path.join(dir, tarName);
    const srcBytes = fs.readFileSync(input.tarPath);
    fs.writeFileSync(tarPath, srcBytes);
    const copied = fs.readFileSync(tarPath);
    if (!copied.equals(srcBytes)) throw new Error(".app.tar.gz の写しが元と違います");
    // 門番が読んだバイトと写したバイトが同じものか（運び込みの途中で書き換わっていないか）。写したものをもう一度読む
    const again = readAppFromTarGz(copied);
    if (again.version !== input.app.version || again.executableSha256 !== input.app.executableSha256) {
      throw new Error("門番が確かめたあとで .app.tar.gz が変わりました（運び込みの途中かもしれません）。置き直してからもう一度");
    }
    console.log(`  写し: ${tarName}（${copied.length} バイト）`);
    // V207: 出す版（make_release が渡す tauri.conf.json の version）で署名する＝信頼コメントに version:<版>（下の R-15 が同じ版を見る）
    const signature = a.sign(tarPath, a.version).trim();
    if (!signature) throw new Error("署名が空です");
    const sigPath = `${tarPath}.sig`;
    fs.writeFileSync(sigPath, signature, "utf8");
    console.log("  署名: できました（鍵の中身・パスワードは表示しません）");
    assertReleaseSignature(tarPath, signature, a.pubkey, tarName, a.version, "Mac の .app.tar.gz");
    return { dir, tarName, tarPath, sigPath, signature, size: copied.length, sha256: sha256(copied) };
  } catch (e) {
    discardStaged(dir);
    throw e;
  }
}

/** 確かめ終わった Mac の配信物を出力先へ写す（写した先を読み直して同じバイトか見る） */
export function installMacStaged(s: MacStaged, outDir: string): string[] {
  return [commitStaged(s.tarPath, outDir, s.tarName), commitStaged(s.sigPath, outDir, `${s.tarName}.sig`)];
}

// ---------------- 本物の署名（Windows の make_release だけが使う） ----------------
//
// ★鍵の値・パスワード・鍵の場所は**どこにも出さない**。`tauri signer sign` の出力は必ず受け止め、
//  失敗したときも「伏せ字を通した、理由の分かる行」だけを出す。
//  ⚠ `tauri signer sign --help` は環境変数の**値をそのまま表示する**（clap の既定）。help を打たせる道は作らない。
//  ⚠ `TAURI_SIGNING_PRIVATE_KEY` に**ファイルの場所**を入れている人がいる（`tauri build` はそれで通る）。
//   ところが `signer sign` は同じ変数を「鍵の中身」としか読まず、場所だと
//   「failed to decode base64 secret key」で落ちる（V175 で実測）。場所なら `_PATH` に移して渡す。

const SIGN_ENV_KEY = "TAURI_SIGNING_PRIVATE_KEY";
const SIGN_ENV_PATH = "TAURI_SIGNING_PRIVATE_KEY_PATH";
const SIGN_ENV_PASSWORD = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
/**
 * V207: `tauri signer sign` が鍵として読む環境変数の全部（CLI 2.12.4 の src/signer/sign.rs）。新しい名前の 3 つと、
 * 旧い名前の 3 つ（新しい名前が無いときに読む）。旧い名前が混ざる組み合わせでは**`_PATH` が鍵の中身より先に使われ**、
 * 新しい名前の中身と `_PATH` が両方あると CLI は組み合わせを断って落ちる（終了コード 2）。1 つでも親から残すと、
 * 渡したつもりの鍵ではなく別の鍵（本物を含む）で署名されるか、署名が落ち得る。子のプロセスにはいったん全部を外してから、
 * 使う 2 つ（_PATH か鍵の中身・パスワード）だけを入れ直す
 */
export const SIGNER_ENV_NAMES = [
  SIGN_ENV_KEY,
  SIGN_ENV_PATH,
  SIGN_ENV_PASSWORD,
  "TAURI_PRIVATE_KEY",
  "TAURI_PRIVATE_KEY_PATH",
  "TAURI_PRIVATE_KEY_PASSWORD",
] as const;

/** 署名に要る環境変数がそろっているか。そろっていなければ理由（値は入れない）、そろっていれば null */
export function signingEnvProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env[SIGN_ENV_KEY]?.trim()) return `環境変数 ${SIGN_ENV_KEY} がありません（.app.tar.gz に本物の鍵で署名できません）`;
  if (env[SIGN_ENV_PASSWORD] === undefined) {
    return `環境変数 ${SIGN_ENV_PASSWORD} がありません（無いまま署名すると tauri がパスワードの入力を待って止まります）`;
  }
  return null;
}

/** 署名の環境変数の「ある・なし」だけを言う（値も長さも出さない） */
export function signingEnvSummary(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[SIGN_ENV_KEY]?.trim() ?? "";
  const isFile = key !== "" && fs.existsSync(key) && fs.statSync(key).isFile();
  return `updater の署名鍵: あり（${isFile ? "ファイルの場所" : "鍵の中身"}）・パスワード: ${env[SIGN_ENV_PASSWORD] !== undefined ? "あり" : "なし"}`;
}

/** 文字列から、渡した値そのもの（長い順）とホーム・ユーザー名・Windows/Mac のユーザーのパスを伏せる */
export function scrubSecrets(s: string, values: string[]): string {
  const secrets = [...values, os.homedir(), os.userInfo().username]
    .map((v) => (v ?? "").trim())
    .filter((v, i, xs) => v.length >= 3 && xs.indexOf(v) === i)
    .sort((x, y) => y.length - x.length);
  let t = s;
  for (const v of secrets) t = t.split(v).join("<伏せ字>");
  t = t.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/gi, "<伏せ字>");
  t = t.replace(/\/Users\/[^\s/"']+/g, "/Users/<伏せ字>");
  return t;
}

/**
 * 本物の署名器。`tauri signer sign` を **node で直に**呼ぶ（npx を通さない＝シェルを挟まない・引数にパスや秘密を
 * 載せない）。鍵とパスワードは**環境変数でだけ**渡す。
 * V207: 署名には**必ず版を入れる**（`--app-version <版>`）。版は省けない・空や x.y.z でない版は投げる
 *   （CLI は版が無くても警告だけで終了コード 0 のまま版の無い署名を書く＝終了コードでは気づけないので、ここで塞ぐ）。
 *   子のプロセスには、親の鍵の環境変数（SIGNER_ENV_NAMES の 6 つ・旧い名前も）を全部外してから、使う 2 つだけを入れる。
 */
export function makeTauriSigner(env: NodeJS.ProcessEnv = process.env): Signer {
  const problem = signingEnvProblem(env);
  if (problem) throw new Error(problem);
  return (file: string, version: string) => {
    parseVersion(version);
    const key = (env[SIGN_ENV_KEY] ?? "").trim();
    const password = env[SIGN_ENV_PASSWORD] ?? "";
    const child: NodeJS.ProcessEnv = { ...env, CI: "true" };
    // 大文字小文字だけが違う名前（Windows では同じ変数）も外す
    for (const k of Object.keys(child)) if ((SIGNER_ENV_NAMES as readonly string[]).includes(k.toUpperCase())) delete child[k];
    child[SIGN_ENV_PASSWORD] = password;
    if (fs.existsSync(key) && fs.statSync(key).isFile()) child[SIGN_ENV_PATH] = key;
    else child[SIGN_ENV_KEY] = key;
    // node の解決で探す（作業フォルダの写しで動かしても、上の node_modules を見つけられる）
    const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
    const sigFile = `${file}.sig`;
    try {
      fs.rmSync(sigFile, { force: true });
    } catch {
      // 前の .sig が消せなければ下の確かめで赤になる
    }
    const r = spawnSync(process.execPath, [cli, "signer", "sign", "--app-version", version, file], {
      cwd: root,
      env: child,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 180_000,
    });
    if (r.status !== 0 || !fs.existsSync(sigFile)) {
      const said = scrubSecrets(`${r.stdout ?? ""}\n${r.stderr ?? ""}`, [key, password])
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => /password|decode|key|error|failed/i.test(s))
        .slice(0, 3);
      throw new Error(
        `署名できませんでした（tauri signer sign・終了コード ${r.status ?? (r.error ? "起動できない" : "?")}）` +
          (said.length ? `\n${said.map((s) => `  │ ${s}`).join("\n")}` : "")
      );
    }
    return fs.readFileSync(sigFile, "utf8").trim();
  };
}

// ================= Mac のリハーサル（§10-3） =================

/** 古い版の役が更新を確かめに行く先。**127.0.0.1 だけ**（0.0.0.0 にしない＝ほかの機械から届かない） */
export const REHEARSAL_HOST = "127.0.0.1";
/** 古い版の役（mac_build.ts --rehearsal-old）と配り手（mac_update_rehearsal.ts）が同じ値を見る */
export const REHEARSAL_PORT = 47175;
export const REHEARSAL_FEED_URL = `http://${REHEARSAL_HOST}:${REHEARSAL_PORT}/latest.json`;

/** x.y.z だけを読む（pre-release は扱わない＝この製品の版は数字 3 つ） */
export function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`版が x.y.z の形ではありません: ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * 古い版の役の版。**最後の 0 でない数を 1 つ減らす**（1.9.5 → 1.9.4・1.10.0 → 1.9.0・2.0.0 → 1.0.0）。
 * どれも元より必ず小さい（updater は「feed の版 > 今の版」で更新を出す）。0.0.0 は作れないので投げる。
 */
export function rehearsalOldVersion(v: string): string {
  const n = parseVersion(v);
  for (let i = 2; i >= 0; i--) {
    if (n[i] > 0) {
      n[i]--;
      return n.join(".");
    }
  }
  throw new Error("0.0.0 より小さい版は作れません");
}

/**
 * リハーサルの feed: darwin の url の**前半だけ**を 127.0.0.1 に差し替える（ファイル名はそのまま）。
 * signature・version・notes・pub_date・Windows の項目は 1 文字も変えない（`diffExceptDarwinUrl` が見る）。
 */
export function rewriteForRehearsal(feed: Feed, port: number = REHEARSAL_PORT): Feed {
  const copy: Feed = JSON.parse(JSON.stringify(feed));
  for (const k of DARWIN_KEYS) {
    const e = copy.platforms[k];
    if (!e) continue;
    const base = e.url.slice(e.url.lastIndexOf("/") + 1);
    e.url = `http://${REHEARSAL_HOST}:${port}/${base}`;
  }
  return copy;
}

/** 2 つの feed の違いを並べる。darwin の url だけは「ファイル名が同じで、頭が 127.0.0.1 になった」なら違いに数えない */
export function diffExceptDarwinUrl(before: unknown, after: unknown, port: number = REHEARSAL_PORT): string[] {
  const diffs: string[] = [];
  const walk = (a: unknown, b: unknown, at: string[]) => {
    const p = at.join(".");
    const isDarwinUrl = at.length === 3 && at[0] === "platforms" && (DARWIN_KEYS as readonly string[]).includes(at[1]) && at[2] === "url";
    if (isDarwinUrl) {
      const ok =
        typeof a === "string" &&
        typeof b === "string" &&
        a.slice(a.lastIndexOf("/") + 1) === b.slice(b.lastIndexOf("/") + 1) &&
        b === `http://${REHEARSAL_HOST}:${port}/${a.slice(a.lastIndexOf("/") + 1)}`;
      if (!ok) diffs.push(p);
      return;
    }
    if (isObj(a) && isObj(b)) {
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (JSON.stringify(ka) !== JSON.stringify(kb)) diffs.push(`${p || "(最上位)"} のキー`);
      for (const k of ka) if (k in b) walk(a[k], b[k], [...at, k]);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(p || "(最上位)");
  };
  walk(before, after, []);
  return diffs;
}

// ================= check-live（出す日・[S-7]） =================

/**
 * V207: check-live が落とした配信物 1 つの判定（通信なしで試せるように分けた）。R-15（tauri.conf.json の公開鍵）・
 * 信頼コメントのファイル名が url と同じ・**信頼コメントの版が出す版（tauri.conf.json の version）と同じ**。
 * ⚠ v1.9.5 までの feed（版の無い署名）に当てると、版の行が赤になる（v2.0.0 の日までは正しい赤）
 */
export function liveArtifactChecks(bytes: Uint8Array, sig: string, pubkey: string, name: string, version: string): Check[] {
  const out: Check[] = [];
  const v = verifyMinisign(bytes, sig, pubkey);
  out.push({ name: `R-15 落としたもの（${bytes.length} バイト）が tauri.conf.json の公開鍵の署名どおり`, ok: v.ok, why: v.ok ? "" : v.why });
  if (!v.ok) return out;
  out.push({ name: "署名の信頼コメントのファイル名が url と同じ", ok: trustedFileName(v.trustedComment) === name, why: `いま ${trustedFileName(v.trustedComment)}` });
  const vp = signedVersionProblem(v.trustedComment, version);
  out.push({ name: `署名の信頼コメントの版が出す版（${version}）と同じ`, ok: vp === null, why: vp ?? "" });
  return out;
}

async function checkLive(windowsOnly: boolean): Promise<number> {
  const conf = readConf();
  const version: string = conf.version;
  const pubkey: string = conf.plugins?.updater?.pubkey ?? "";
  const endpoints: string[] = conf.plugins?.updater?.endpoints ?? [];
  console.log(`== check-live: 配信中の feed を確かめます（tauri.conf.json の版 ${version}・配信元 ${endpoints.length} つ） ==`);
  let ng = 0;
  const say = (ok: boolean, label: string, why = "") => {
    if (ok) console.log(`  OK: ${label}`);
    else {
      ng++;
      console.log(`  NG: ${label}${why ? ` — ${why}` : ""}`);
    }
  };
  if (endpoints.length !== 2) say(false, "配信元が 2 つ", `いま ${endpoints.length}`);
  const texts: string[] = [];
  const urls = new Map<string, string>(); // url → それを指す platform のキー
  for (const ep of endpoints) {
    console.log(`-- ${ep}`);
    let res: Response;
    try {
      res = await fetch(ep, { redirect: "follow", headers: { "Cache-Control": "no-cache" } });
    } catch (e) {
      say(false, "feed を取れる", String(e));
      continue;
    }
    say(res.status === 200, "feed が HTTP 200（リダイレクトを追って）", `いま ${res.status}`);
    const text = await res.text();
    texts.push(text);
    let feed: unknown = null;
    try {
      feed = JSON.parse(text);
    } catch {
      say(false, "feed が JSON として読める");
      continue;
    }
    say(true, "feed が JSON として読める");
    for (const c of checkFeed(feed, { version, withMac: !windowsOnly })) say(c.ok, `${c.name}${c.note ? `（${c.note}）` : ""}`, c.why);
    const plat = isObj(feed) && isObj((feed as Feed).platforms) ? (feed as Feed).platforms : {};
    say(Object.keys(plat).length === (windowsOnly ? 1 : 3), `platforms が ${windowsOnly ? 1 : 3} 項目`, `いま ${Object.keys(plat).length}`);
    for (const [k, e] of Object.entries(plat)) if (isObj(e) && typeof e.url === "string") urls.set(`${e.url}\n${e.signature}`, k);
  }
  if (texts.length === 2) say(texts[0] === texts[1], "2 つの配信元の feed が 1 文字も違わない", "片方が古い（キャッシュなら数分おいてもう一度）");
  // 各 url を実際に落として、R-15（本物の公開鍵）で確かめる＝**配っているバイト列そのもの**を見る
  for (const [both, k] of urls) {
    const [url, sig] = both.split("\n");
    const name = url.slice(url.lastIndexOf("/") + 1);
    console.log(`-- ${k}: ${name}`);
    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (e) {
      say(false, "url を取れる", String(e));
      continue;
    }
    say(res.status === 200, "url が HTTP 200（リダイレクトを追って）", `いま ${res.status}`);
    if (res.status !== 200) continue;
    const bytes = Buffer.from(await res.arrayBuffer());
    for (const c of liveArtifactChecks(bytes, sig, pubkey, name, version)) say(c.ok, c.name, c.why);
  }
  console.log(ng ? `== 赤: ${ng} 件 ==` : "== 緑: 2 つの配信元の feed と、指している配信物がすべて通りました ==");
  return ng ? 1 : 0;
}

const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const cmd = process.argv[2];
  if (cmd === "check-live") {
    checkLive(process.argv.includes("--windows-only")).then(
      (code) => process.exit(code),
      (e) => {
        console.error(scrubSecrets(String(e instanceof Error ? e.message : e), []));
        process.exit(1);
      }
    );
  } else {
    console.error("使い方: npx tsx scripts/mac_update.ts check-live [--windows-only]");
    process.exit(2);
  }
}
