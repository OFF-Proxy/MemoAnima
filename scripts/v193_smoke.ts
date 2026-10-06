// V193（A-95・REQ_discord_rpc・Discord にプレイ状況を表示する＝Rich Presence）の回帰ゲート。引数不要:
//   npx tsx scripts/v193_smoke.ts            （--report で表を全部出す＝報告書用）
//
// 決まり（REQ §0〜§3・作者決定 2026-10-04）: 手元の Discord アプリとだけ話す・既定オン・⚙ でいつでもオフ・
// 渡すのは large_image / large_text / details（固定の 1 文）/ timestamps.start だけ・失敗はすべて握りつぶす。
//
// Rust 側（src-tauri/src/discord.rs）は std と serde_json だけで閉じているので、この検査が
// node_modules の下に小さな crate（harness）を作り、`#[path]` で**本物のファイルをそのまま**読み込んで動かす
// （tauri をリンクしない＝速い・作者の設定にもライブラリにも触れない）。相手は Node で立てた**偽の Discord**
// （Windows は名前付きパイプ・Mac は UNIX ソケット。名前は検査ごとに別＝本物の Discord には絶対につながない）。
//
// [S-0] 写しの仕組み: 無改変の写しでは [S-9] が見る検査が全部緑
// [S-1] 渡す中身: (a) JS の discordPresenceArgs に作品名・パス・アルバム名の入った設定を渡しても、出るのは
//       { enabled, details } だけ・details は 7 言語とも t(キー) そのもの (b) 静的: discord_presence_set を
//       呼ぶのは main.ts の 1 か所だけで、引数は `discordPresenceArgs(settings)` だけ・Rust のコマンドは
//       discord::set(enabled, details) へ渡すだけ (c) 純関数（harness）: activity の葉が
//       details / timestamps.start / assets.large_image / assets.large_text の 4 つだけ・パスに見える details は落とす
//       (d) ★偽の Discord が受け取った実際のバイト: 握手は { v, client_id } だけ・SET_ACTIVITY の activity は 4 つの葉だけ
// [S-2] Application ID がコードに 1 か所だけ（定数の定義の行）・値は REQ §0 と同じ
// [S-3] 既定オン: 未設定・undefined・壊れた値 → オン／false だけオフ（⚙ と起動が同じ関数を使う）
// [S-4] つながらない相手: 相手なし・すぐ閉じる・返事しない・ゴミ（長さが巨大／でたらめ／UTF-8 でない／JSON でない）・
//       断られる、のどれでも harness が落ちない（exit 0）・set は 30 ms 以内・shutdown は待つ上限＋α以内。
//       あとから Discord を起動（K-4）・途中で落ちて戻る（K-7）。Rust の単体テスト（cargo test）も全部緑
// [S-5] 静的: mod discord と discord:: の呼び出しは全部 #[cfg(desktop)] の下・setup の中は set_logger だけ・
//       スレッドを立てるのは 1 か所・つなぐのはスレッドの中だけ・本番の間隔は 30 秒（harness で本番の設定を読む）。
//       動かして: オフの間は 1 回もつなぎに来ない／オンの間は間隔ごとに来る
// [S-6] 初回の知らせは出さない（V193b・作者決定 2026-10-04）: 知らせの関数・判定の口・文言のキー（7 言語の辞書も）が無い・
//       ★起動の流れで Discord に触れるのは syncDiscordPresence() の 1 回だけ（AST で拾う）・
//       V193 の旧キー discordNoticeShown は読み捨て（型の 1 行だけ・読まない・書かない）・旧キーがどんな値でも表示と渡すものは同じ
// [S-7] README（日・英）の「通信について」に Discord の段落がある・旧文「1 つだけ」が無い・作品データの約束の段落は
//       V193 の前（1069771）と 1 文字も違わない・幅は既存の段落を超えない。README.md（日英）と ⚙ の set.legal.offline.msg（7 言語）も同じ
// [S-8] 7 言語に新しいキーが全部ある・禁止語なし・i18n 検査が fail=0
// [S-9] ★反証（写しで壊して赤を見る）: ①作品名を details に入れる→[S-1] ①b main.ts で details を差し替える→[S-1]
//       ②ID を 2 か所に書く→[S-2] ③既定をオフにする→[S-3] ④setup の中でつなぐ→[S-5] ④b set() が呼んだ側でつなぐ→[S-5]
//       ⑤オフの間もつなぎ直す→[S-5] ⑥初回の知らせを出す道を戻す→[S-6] ⑥b 起動時に Discord のトーストを出す→[S-6] ⑦ヘッダの長さの上限を外す→[S-4]
//       ⑧終了で上限なく待つ→[S-4] ⑨溜まった命令を 1 つずつ片付ける→[S-4] ⑩受け口の差し替えを release でも読む→[S-5]
//       ⑪握手の期限を「何も来ないとき」だけ見る→[S-4]（単体テスト） ⑫Windows のパイプを security_qos_flags なしで開く→[S-5]
//       ⑬（V196・A-102）読みが閉じを見たら、同じ読みで届いていた返事ごと捨てる→[S-4]（単体テスト）
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}
type V = { ok: boolean; why: string; threw?: boolean };
const ok = (): V => ({ ok: true, why: "" });
const ng = (why: string): V => ({ ok: false, why });
async function safe(fn: () => Promise<V> | V): Promise<V> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, why: `例外: ${String((e as Error)?.message ?? e).slice(0, 300)}`, threw: true };
  }
}
const root = path.resolve(import.meta.dirname, "..");
const REPORT = process.argv.includes("--report");
const log = (s: string) => console.log(s);
const lf = (x: string) => x.replace(/\r\n/g, "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// V193b: 初回の知らせ（set.discord.notice.msg）は外した＝無いことは [S-6] が見る
const NEW_KEYS = ["set.discord.label", "set.discord.hint", "set.discord.details.msg"] as const;
const LANGS = ["ja", "en", "es", "pt-BR", "ko", "zh-Hans", "zh-Hant"] as const;
const BANNED = /うごメモ|うごくメモ帳|Flipnote|フリップノート/i;

// ================= 木（本物・写し） =================
type Tree = { root: string; tag: string; read(rel: string): string; has(rel: string): boolean };
const realTree: Tree = {
  root,
  tag: "real",
  read: (rel) => lf(fs.readFileSync(path.join(root, rel), "utf8")),
  has: (rel) => fs.existsSync(path.join(root, rel)),
};
/** README の比べる基準は **V193 の前のコミットに固定**（V193b で直した）。HEAD にしていると、V193 をコミットした時点で
 *  「節が増えていない」が必ず赤になり、約束の段落の不変もコミット済みの変更を素通りさせる（v192_smoke の BASE と同じ作法） */
const README_BASE = "1069771"; // docs: A-95 の Application ID・V193 の指示書（V193 の直前）
function baseBlob(rel: string): string {
  return lf(execFileSync("git", ["show", `${README_BASE}:${rel}`], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }));
}

// ================= REQ の値（スモークに ID を書かない＝[S-2] の数え方を汚さない） =================
function reqValues(): { appId: string; largeImage: string; largeText: string } {
  const req = realTree.read("docs/REQ_discord_rpc.md");
  const appId = req.match(/Application ID (\d{17,20})/)?.[1];
  const largeImage = req.match(/\| large_image \| `([^`]+)` \|/)?.[1];
  const largeText = req.match(/\| large_text \| 「([^」]+)」/)?.[1];
  if (!appId || !largeImage || !largeText) throw new Error("REQ_discord_rpc.md から ID・large_image・large_text を読めない（窓が壊れた）");
  return { appId, largeImage, largeText };
}

// ================= JS（discordPresence.ts と i18n）を読む =================
type DP = {
  DISCORD_DETAILS_KEY: string;
  discordPresenceEnabled(s: object): boolean;
  discordPresenceArgs(s: object): { enabled: boolean; details: string };
  discordNoticeDue(s: object): boolean;
};
type I18n = { setLang(l: string): void; t(k: string): string };
async function loadJs(T: Tree): Promise<{ dp: DP; i18n: I18n }> {
  const p = path.join(T.root, "src/discordPresence.ts");
  if (!fs.existsSync(p)) throw new Error("src/discordPresence.ts が無い（未実装）");
  const i18n = (await import(pathToFileURL(path.join(T.root, "src/i18n/index.ts")).href)) as I18n;
  const dp = (await import(pathToFileURL(p).href + `?t=${Date.now()}${Math.random()}`)) as DP;
  return { dp, i18n };
}

// ================= Rust の切り出し（文字列・コメントを飛ばして括弧を数える） =================
/** `open` の位置の `{` に対応する `}` の位置。文字列（"…"・r"…"・r#"…"#）とコメントは飛ばす */
function rustMatch(src: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i <= 0) return -1;
      continue;
    }
    if (c === "r" && /[#"]/.test(src[i + 1] ?? "") && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      const m = src.slice(i).match(/^r(#*)"/);
      if (m) {
        const end = src.indexOf(`"${m[1]}`, i + m[0].length);
        if (end < 0) return -1;
        i = end + m[1].length;
        continue;
      }
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === "}" || c === ")" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}
/** `fn name` の本体（{ … }）。無ければ null。`name` の代わりに頭の形（正規表現）も渡せる（同名のメソッドと取り違えない） */
function rustFnBody(src: string, name: string | RegExp): string | null {
  const m = (typeof name === "string" ? new RegExp(`\\bfn ${name}\\b[^{;]*\\{`) : name).exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = rustMatch(src, open);
  return close < 0 ? null : src.slice(open, close + 1);
}
/** テストを除いた本体（`#[cfg(test)]` より前） */
function rustNonTest(src: string): string {
  const i = src.indexOf("#[cfg(test)]");
  return i < 0 ? src : src.slice(0, i);
}
/** `#[cfg(desktop)]` の直後の文・項目の範囲（属性の終わり〜`;` か閉じ括弧）。else の続きも含める */
function cfgDesktopRanges(src: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /#\[cfg\(desktop\)\]/g;
  for (let m; (m = re.exec(src)); ) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 0;
    let end = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        i = src.indexOf("\n", i);
        continue;
      }
      if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
        continue;
      }
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") {
        depth--;
        if (depth < 0) break; // 囲む括弧が閉じた（式の末尾の項目）
        if (depth === 0 && c === "}" && !/^\s*else\b/.test(src.slice(i + 1, i + 20))) {
          end = i + 1;
          break;
        }
      } else if (c === ";" && depth === 0) {
        end = i + 1;
        break;
      } else if (c === "," && depth === 0) {
        end = i;
        break;
      }
    }
    if (end > 0) out.push([start, end]);
  }
  return out;
}
function noLineComments(s: string): string {
  return s.replace(/\/\/[^\n]*/g, "");
}

// ================= harness（本物の discord.rs を #[path] で読む小さな crate） =================
const tmpRoot = path.join(root, "node_modules", ".v193-smoke", String(process.pid));
const cargoTarget = path.join(root, "node_modules", ".v193-cargo-target"); // 速さのため残す（serde_json を毎回作り直さない）
const HARNESS_MAIN = `#[path = "__DISCORD_RS__"]
#[allow(dead_code)]
mod discord;

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn emit(v: Value) {
    let out = std::io::stdout();
    let mut o = out.lock();
    let _ = writeln!(o, "{}", v);
    let _ = o.flush();
}
fn ms(v: &Value, k: &str, d: u64) -> Duration {
    Duration::from_millis(v[k].as_u64().unwrap_or(d))
}

fn main() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let spec: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let t0 = Instant::now();
    match spec["mode"].as_str().unwrap_or("") {
        "defaults" => {
            let c = discord::default_config(Box::new(|_: &str| {}));
            let eps: Vec<String> = c.endpoints.iter().map(|p| p.to_string_lossy().to_string()).collect();
            emit(json!({"app_id": c.app_id, "retry_ms": c.retry.as_millis() as u64, "watch_ms": c.watch.as_millis() as u64,
                "reply_ms": c.reply_timeout.as_millis() as u64, "exit_wait_ms": discord::EXIT_WAIT.as_millis() as u64, "endpoints": eps}));
        }
        "payload" => {
            let d = spec["details"].as_str().unwrap_or("");
            let clean = discord::clean_details(d);
            let a = discord::activity_json(clean.as_deref(), spec["start"].as_u64().unwrap_or(0));
            let app = discord::default_config(Box::new(|_: &str| {})).app_id;
            emit(json!({"clean": clean, "activity": a.clone(), "set": discord::set_activity_payload(Some(a), 4242, 7),
                "clear": discord::set_activity_payload(None, 4242, 8), "handshake": discord::handshake_payload(&app)}));
        }
        _ => {
            let logger: Box<dyn Fn(&str) + Send> = Box::new(move |line: &str| emit(json!({"log": line, "t": t0.elapsed().as_millis() as u64})));
            let mut c = discord::default_config(logger);
            let dirs: Vec<PathBuf> = spec["dirs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(PathBuf::from).collect()).unwrap_or_default();
            c.endpoints = discord::endpoints(spec["prefix"].as_str().unwrap_or("none-"), if dirs.is_empty() { None } else { Some(dirs.as_slice()) });
            c.retry = ms(&spec, "retry_ms", 300);
            c.watch = ms(&spec, "watch_ms", 100);
            c.reply_timeout = ms(&spec, "reply_ms", 400);
            c.start = spec["start"].as_u64().unwrap_or(1_700_000_000);
            let exit_wait = ms(&spec, "exit_wait_ms", 500);
            let p = discord::Presence::spawn(c);
            emit(json!({"ready": true, "pid": std::process::id()}));
            let steps = spec["steps"].as_array().cloned().unwrap_or_default();
            for (i, st) in steps.iter().enumerate() {
                if let Some(n) = st["sleep"].as_u64() {
                    std::thread::sleep(Duration::from_millis(n));
                    continue;
                }
                let t = Instant::now();
                let op;
                if let Some(arr) = st["set"].as_array() {
                    p.set(arr.first().and_then(|x| x.as_bool()).unwrap_or(false), arr.get(1).and_then(|x| x.as_str()).unwrap_or("").to_string());
                    op = "set";
                } else if st["shutdown"].as_bool() == Some(true) {
                    p.shutdown(exit_wait);
                    op = "shutdown";
                } else {
                    continue;
                }
                emit(json!({"step": i, "op": op, "us": t.elapsed().as_micros() as u64, "t": t0.elapsed().as_millis() as u64}));
            }
            emit(json!({"done": true}));
        }
    }
}
`;
const HARNESS_TOML = `[package]
name = "v193-harness"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
serde_json = "1"

[workspace]
`;
function cargoBin(): string {
  const local = path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  return fs.existsSync(local) ? local : "cargo";
}
type Harness = { exe: string; dir: string };
const harnessCache = new Map<string, Harness>();
function buildHarness(T: Tree): Harness {
  const hit = harnessCache.get(T.root);
  if (hit) return hit;
  const rs = path.join(T.root, "src-tauri/src/discord.rs");
  if (!fs.existsSync(rs)) throw new Error("src-tauri/src/discord.rs が無い（未実装）");
  const dir = path.join(tmpRoot, `harness-${T.tag}`);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Cargo.toml"), HARNESS_TOML);
  fs.writeFileSync(path.join(dir, "src/main.rs"), HARNESS_MAIN.replace("__DISCORD_RS__", rs.replace(/\\/g, "/")));
  try {
    execFileSync(cargoBin(), ["build", "--offline", "--quiet"], {
      cwd: dir,
      env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
  } catch (e) {
    const err = String((e as { stderr?: string }).stderr ?? e).split("\n").filter((l) => /error|-->/.test(l)).slice(0, 8).join(" ／ ");
    throw new Error(`harness を作れない: ${err.slice(0, 400)}`);
  }
  const exe = path.join(cargoTarget, "debug", process.platform === "win32" ? "v193-harness.exe" : "v193-harness");
  // 作るたびに同じ名前へ上書きされるので、木ごとの写しを取っておく（あとで別の木を作っても混ざらない）
  const mine = path.join(dir, path.basename(exe).replace("v193-harness", `v193-harness-${T.tag}`));
  fs.copyFileSync(exe, mine);
  const h = { exe: mine, dir };
  harnessCache.set(T.root, h);
  return h;
}
function harnessJson(T: Tree, spec: object): Record<string, unknown> {
  const h = buildHarness(T);
  const out = execFileSync(h.exe, [], { input: JSON.stringify(spec), encoding: "utf8", timeout: 20_000 });
  return JSON.parse(out.trim().split("\n")[0]);
}

type Line = Record<string, unknown> & { at: number };
type Run = { code: number | null; lines: Line[]; stderr: string; timedOut: boolean; t0: number };
function runHarness(T: Tree, spec: object, timeoutMs = 20_000): Promise<Run> {
  const h = buildHarness(T);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(h.exe, [], { stdio: ["pipe", "pipe", "pipe"] });
    const lines: Line[] = [];
    let buf = "";
    let stderr = "";
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const s = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!s) continue;
        try {
          lines.push({ ...(JSON.parse(s) as object), at: Date.now() });
        } catch {
          lines.push({ junk: s, at: Date.now() });
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, lines, stderr, timedOut, t0 });
    });
    child.stdin.end(JSON.stringify(spec));
  });
}

// ================= 偽の Discord（Node の net で名前付きパイプ／UNIX ソケットを立てる） =================
type Behavior = "discord" | "close" | "silent" | "huge" | "random" | "badutf8" | "badjson" | "reject" | "dropOnce" | "flood";
type Frame = { op: number; json: unknown; raw: string; conn: number; at: number };
function frameBytes(op: number, body: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(op, 0);
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}
const frameJson = (op: number, v: unknown) => frameBytes(op, Buffer.from(JSON.stringify(v), "utf8"));
let pipeSeq = 0;
function ipcName(tag: string): { prefix: string; dirs: string[]; addr: (i: number) => string } {
  const prefix = `mav193-${process.pid}-${tag}-${pipeSeq++}-ipc-`;
  if (process.platform === "win32") return { prefix, dirs: [], addr: (i) => `\\\\.\\pipe\\${prefix}${i}` };
  const dir = os.tmpdir();
  return { prefix, dirs: [dir], addr: (i) => path.join(dir, `${prefix}${i}`) };
}
class FakeDiscord {
  conns: number[] = [];
  frames: Frame[] = [];
  private server: net.Server | null = null;
  private socks = new Set<net.Socket>();
  constructor(
    readonly addr: string,
    readonly behavior: Behavior
  ) {}
  start(): Promise<void> {
    if (process.platform !== "win32") fs.rmSync(this.addr, { force: true });
    return new Promise((res, rej) => {
      const srv = net.createServer((s) => this.onConn(s));
      srv.on("error", rej);
      srv.listen(this.addr, () => res());
      this.server = srv;
    });
  }
  private onConn(sock: net.Socket) {
    const id = this.conns.length;
    this.conns.push(Date.now());
    this.socks.add(sock);
    sock.on("close", () => this.socks.delete(sock));
    sock.on("error", () => {});
    if (this.behavior === "close") {
      sock.destroy();
      return;
    }
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readUInt32LE(0);
        const len = buf.readUInt32LE(4);
        if (buf.length < 8 + len) break;
        const raw = buf.subarray(8, 8 + len).toString("utf8");
        buf = buf.subarray(8 + len);
        let json: unknown = null;
        try {
          json = JSON.parse(raw);
        } catch {
          json = { __unparsed: true };
        }
        this.frames.push({ op, json, raw, conn: id, at: Date.now() });
        this.reply(sock, op, json as Record<string, any>, id);
      }
    });
  }
  private reply(sock: net.Socket, op: number, json: Record<string, any>, id: number) {
    const b = this.behavior;
    if (b === "silent") return;
    if (op === 0) {
      if (b === "huge") {
        const h = Buffer.alloc(8);
        h.writeUInt32LE(1, 0);
        h.writeUInt32LE(0xfffffff0, 4); // 4 GiB 近い長さを名乗る（信じて確保すると落ちる）
        sock.write(h);
        return;
      }
      if (b === "random") {
        // 名乗る長さは小さく、中身はでたらめ（決まった種で毎回同じ）
        let x = 0x9e3779b9;
        const body = Buffer.alloc(200);
        for (let i = 0; i < body.length; i++) {
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          body[i] = x & 0xff;
        }
        sock.write(frameBytes(1, body));
        return;
      }
      if (b === "flood") {
        // READY を返さず、正しい形の別の通知を**最初に 16 MB 分まとめて書いておく**（約 54 万通）。
        // 書きかけは OS のパイプ側に積まれ、受け手が読むたびに OS が詰め直す＝JS や負荷の速さに関係なく、
        // 受け手が「何も届いていない」瞬間が数秒は来ない。期限を毎回見ないと、この間ずっと抜けられない相手
        const one = frameJson(1, { cmd: "DISPATCH", evt: "NOISE", data: {} });
        sock.write(Buffer.alloc(one.length * Math.floor((16 << 20) / one.length)).fill(one));
        return;
      }
      if (b === "badutf8") return void sock.write(frameBytes(1, Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0xc3])));
      if (b === "badjson") return void sock.write(frameBytes(1, Buffer.from("{not json", "utf8")));
      if (b === "reject") {
        sock.write(frameJson(2, { code: 4000, message: "Invalid Client ID" }));
        sock.end();
        return;
      }
      sock.write(frameJson(1, { cmd: "DISPATCH", evt: "READY", data: { v: 1, config: {}, user: { id: "0", username: "fake" } }, nonce: null }));
      return;
    }
    if (op === 1 && json?.cmd === "SET_ACTIVITY") {
      sock.write(frameJson(1, { cmd: "SET_ACTIVITY", data: json.args?.activity ?? null, evt: null, nonce: json.nonce ?? null }));
      if (b === "dropOnce" && id === 0 && json.args?.activity) setTimeout(() => sock.destroy(), 250); // 「Discord が落ちた」
      return;
    }
    if (op === 2) sock.end();
  }
  async stop(): Promise<void> {
    for (const s of this.socks) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    if (process.platform !== "win32") fs.rmSync(this.addr, { force: true });
  }
}

// ================= 動かす筋書き =================
const BASE = { retry_ms: 300, watch_ms: 100, reply_ms: 400, exit_wait_ms: 500, start: 1_759_500_000 };
type Scenario = {
  name: string;
  behavior: Behavior | null; // null = 相手なし
  index?: number; // 何番の受け口に立てるか（0〜9）
  lateMs?: number; // あとから立てる（K-4）
  spec?: Partial<typeof BASE>;
  steps: object[];
};
type Result = { sc: Scenario; run: Run; fake: FakeDiscord | null; ipc: ReturnType<typeof ipcName> };
async function play(T: Tree, sc: Scenario): Promise<Result> {
  const ipc = ipcName(sc.name);
  const fake = sc.behavior ? new FakeDiscord(ipc.addr(sc.index ?? 0), sc.behavior) : null;
  if (fake && !sc.lateMs) await fake.start();
  const p = runHarness(T, { ...BASE, ...(sc.spec ?? {}), prefix: ipc.prefix, dirs: ipc.dirs, steps: sc.steps });
  if (fake && sc.lateMs) {
    await sleep(sc.lateMs);
    await fake.start();
  }
  const run = await p;
  if (fake) await fake.stop();
  return { sc, run, fake, ipc };
}
const stepLines = (r: Run) => r.lines.filter((l) => typeof l.step === "number");
const logLines = (r: Run) => r.lines.filter((l) => typeof l.log === "string").map((l) => String(l.log));
/** 共通: 落ちない・時間内・set は 30 ms 以内・shutdown は上限＋300 ms 以内・ログは決まった形だけ */
function commonChecks(res: Result, why: string[], shutdownLimitMs = BASE.exit_wait_ms + 300) {
  const { run, sc } = res;
  if (run.timedOut) why.push(`${sc.name}: 時間切れ（harness が終わらない）`);
  if (run.code !== 0) why.push(`${sc.name}: exit ${run.code}${/panicked/.test(run.stderr) ? "（panic）" : ""} ${run.stderr.slice(0, 160)}`);
  if (!run.lines.some((l) => l.done === true)) why.push(`${sc.name}: 最後まで進まない`);
  for (const l of stepLines(run)) {
    const us = Number(l.us);
    if (l.op === "set" && us > 30_000) why.push(`${sc.name}: set が ${Math.round(us / 1000)} ms 待たせた`);
    if (l.op === "shutdown" && us > shutdownLimitMs * 1000) why.push(`${sc.name}: shutdown が ${Math.round(us / 1000)} ms 待たせた（上限 ${shutdownLimitMs}）`);
  }
  for (const s of logLines(run))
    if (!/^\[discord\] (connected|not connected: [a-z ]+|disconnected: [a-z ]+|closed)$/.test(s)) why.push(`${sc.name}: 決まった形でないログ「${s.slice(0, 80)}」`);
}
function activityLeaves(v: unknown, pre = ""): string[] {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [pre];
  return Object.entries(v as object).flatMap(([k, x]) => activityLeaves(x, pre ? `${pre}.${k}` : k));
}
/** キーの順に依らない比較用の文字列（serde_json はキーを並べ替えて書く） */
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(",")}}`;
}
const ACT_LEAVES =["assets.large_image", "assets.large_text", "details", "timestamps.start"].join(",");

// ================= [S-1] 渡す中身 =================
const SECRETS = ["秘密の作品タイトル", "C:\\Users\\taro\\Pictures\\MemoLib", "マル秘アルバム", "secret_note.memoanima", "/Users/taro/Library"];
async function S1(T: Tree, opts: { dynamic: boolean }): Promise<V> {
  const why: string[] = [];
  // (a) JS の純関数
  const { dp, i18n } = await loadJs(T);
  const st = {
    discordPresence: true,
    libraryDir: SECRETS[1],
    lastAlbum: SECRETS[2],
    legacyTargets: [`${SECRETS[2]}/${SECRETS[0]}`],
    title: SECRETS[0],
    file: SECRETS[3],
    home: SECRETS[4],
  };
  for (const lang of LANGS) {
    i18n.setLang(lang);
    const a = dp.discordPresenceArgs(st);
    const keys = Object.keys(a).sort().join(",");
    if (keys !== "details,enabled") why.push(`${lang}: 引数のキーが ${keys}`);
    const want = i18n.t(dp.DISCORD_DETAILS_KEY);
    if (a.details !== want) why.push(`${lang}: details が t(キー) でない「${String(a.details).slice(0, 60)}」`);
    if (/^\[/.test(want)) why.push(`${lang}: キー ${dp.DISCORD_DETAILS_KEY} が辞書に無い`);
    const js = JSON.stringify(a);
    for (const s of SECRETS) if (js.includes(s) || js.includes(JSON.stringify(s).slice(1, -1))) why.push(`${lang}: 「${s}」が渡る`);
    if (a.enabled !== true) why.push(`${lang}: オンの設定で enabled が ${a.enabled}`);
  }
  i18n.setLang("ja");
  if (dp.DISCORD_DETAILS_KEY !== "set.discord.details.msg") why.push(`DISCORD_DETAILS_KEY が ${dp.DISCORD_DETAILS_KEY}`);
  // (b) 静的: 呼び出し口
  const main = T.read("src/main.ts");
  const sf = ts.createSourceFile("main.ts", main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "discord_presence_set")
      calls.push(n.arguments.slice(1).map((a) => a.getText(sf)).join(", ") + ` [${n.expression.getText(sf)}]`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (calls.length !== 1) why.push(`main.ts の discord_presence_set の呼び出しが ${calls.length} か所（1 か所のはず）`);
  for (const c of calls) if (c !== "discordPresenceArgs(settings) [invoke]") why.push(`呼び出しの引数が「${c}」`);
  if (T === realTree) {
    // ほかのファイルから呼んでいない（src の下を全部見る）
    const others: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        // 呼び出しは文字列リテラルで名前を渡す（コメントの中で名前に触れるだけのものは数えない）
        else if (/\.(ts|html)$/.test(e.name) && rel !== "src/main.ts" && /["'`]discord_presence_set["'`]\s*[,)]/.test(realTree.read(rel))) others.push(rel);
      }
    };
    walk("src");
    if (others.length) why.push(`main.ts 以外が呼んでいる: ${others.join(" ")}`);
  }
  const lib = T.read("src-tauri/src/lib.rs");
  const cmd = rustFnBody(lib, "discord_presence_set");
  if (!cmd) why.push("lib.rs に discord_presence_set が無い");
  else {
    if (!/fn discord_presence_set\(enabled: bool, details: String\)/.test(lib)) why.push("コマンドの引数が (enabled: bool, details: String) でない");
    const calls2 = [...noLineComments(cmd).matchAll(/discord::(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
    if (calls2.join(" ") !== "set(enabled, details)") why.push(`コマンドの中身が ${calls2.join(" ") || "空"}`);
  }
  if (!new RegExp(`generate_handler!\\[[\\s\\S]*\\bdiscord_presence_set\\b[\\s\\S]*\\]`).test(lib)) why.push("generate_handler に discord_presence_set が無い");
  // (c) 純関数（harness）
  const req = reqValues();
  const p = harnessJson(T, { mode: "payload", details: "パラパラアニメを描いています", start: 1759500000 }) as Record<string, any>;
  if (activityLeaves(p.activity).sort().join(",") !== ACT_LEAVES) why.push(`activity の葉が ${activityLeaves(p.activity).sort().join(",")}`);
  if (p.activity?.assets?.large_image !== req.largeImage) why.push(`large_image が ${p.activity?.assets?.large_image}`);
  if (p.activity?.assets?.large_text !== req.largeText) why.push(`large_text が ${p.activity?.assets?.large_text}`);
  if (p.activity?.timestamps?.start !== 1759500000) why.push("timestamps.start が渡した起動時刻でない");
  if (Object.keys(p.set ?? {}).sort().join(",") !== "args,cmd,nonce" || Object.keys(p.set?.args ?? {}).sort().join(",") !== "activity,pid")
    why.push(`SET_ACTIVITY の封筒が ${JSON.stringify(Object.keys(p.set ?? {}))}`);
  if (p.clear?.args?.activity !== null) why.push("表示を消す封筒の activity が null でない");
  if (canon(p.handshake) !== canon({ v: 1, client_id: req.appId })) why.push(`握手が ${JSON.stringify(p.handshake)}`);
  for (const bad of [SECRETS[1], SECRETS[4], "a/b", "x".repeat(400), "\u0007"]) {
    const q = harnessJson(T, { mode: "payload", details: bad, start: 1 }) as Record<string, any>;
    const d = q.activity?.details;
    if (typeof d === "string" && (d.includes("\\") || d.includes("/") || d.length > 128 || /[\u0000-\u001f]/.test(d)))
      why.push(`details の網をすり抜ける「${bad.slice(0, 20)}」→「${String(d).slice(0, 20)}」`);
  }
  // (d) 偽の Discord が受け取った実際のバイト
  if (opts.dynamic) {
    i18n.setLang("ja");
    const dJa = i18n.t(dp.DISCORD_DETAILS_KEY);
    i18n.setLang("en");
    const dEn = i18n.t(dp.DISCORD_DETAILS_KEY);
    i18n.setLang("ja");
    const res = await play(T, {
      name: "bytes",
      behavior: "discord",
      index: 3, // 0〜9 を順に探すことも確かめる
      steps: [{ set: [true, dJa] }, { sleep: 500 }, { set: [true, dEn] }, { sleep: 300 }, { set: [false, dEn] }, { sleep: 300 }, { shutdown: true }],
    });
    commonChecks(res, why);
    const fr = res.fake!.frames;
    const hs = fr.filter((f) => f.op === 0);
    const sets = fr.filter((f) => f.op === 1 && (f.json as any)?.cmd === "SET_ACTIVITY");
    if (hs.length !== 1) why.push(`握手が ${hs.length} 回`);
    for (const h of hs) if (canon(h.json) !== canon({ v: 1, client_id: req.appId })) why.push(`実際の握手が ${h.raw.slice(0, 80)}`);
    const shown = sets.filter((f) => (f.json as any).args?.activity);
    if (shown.length !== 2) why.push(`表示の SET_ACTIVITY が ${shown.length} 回（日→英の 2 回のはず）`);
    for (const f of shown) {
      const a = (f.json as any).args.activity;
      if (activityLeaves(a).sort().join(",") !== ACT_LEAVES) why.push(`実際の activity の葉が ${activityLeaves(a).sort().join(",")}`);
      if (Object.keys(f.json as object).sort().join(",") !== "args,cmd,nonce") why.push(`実際の封筒が ${Object.keys(f.json as object)}`);
      if (Object.keys((f.json as any).args).sort().join(",") !== "activity,pid") why.push(`実際の args が ${Object.keys((f.json as any).args)}`);
    }
    if (shown[0] && (shown[0].json as any).args.activity.details !== dJa) why.push("1 回目の details が日本語の 1 文でない");
    if (shown[1] && (shown[1].json as any).args.activity.details !== dEn) why.push("言語を変えたあとの details が英語の 1 文でない");
    const cleared = sets.filter((f) => (f.json as any).args && (f.json as any).args.activity === null);
    if (cleared.length < 1) why.push("オフで表示を消す SET_ACTIVITY（activity: null）が来ない");
    const all = fr.map((f) => f.raw).join("\n");
    for (const s of SECRETS) if (all.includes(s)) why.push(`偽の Discord に「${s}」が届いた`);
  }
  return why.length ? ng(why.join("／")) : ok();
}

// ================= [S-2] Application ID は 1 か所 =================
function S2(T: Tree): V {
  const why: string[] = [];
  const { appId } = reqValues();
  // 方法が効いていることを既知の陽性で確かめる（REQ には書いてある）
  if (!realTree.read("docs/REQ_discord_rpc.md").includes(appId)) why.push("カナリア: REQ に ID が見つからない（数え方が壊れた）");
  const files: string[] = [];
  const walk = (d: string, re: RegExp) => {
    const abs = path.join(T.root, d);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel, re);
      else if (re.test(e.name)) files.push(rel);
    }
  };
  walk("src", /\.(ts|css|json|html)$/);
  walk("src-tauri/src", /\.rs$/);
  walk("src-tauri/capabilities", /\.json$/);
  for (const f of ["index.html", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "package.json"]) if (fs.existsSync(path.join(T.root, f))) files.push(f);
  if (!files.includes("src-tauri/src/discord.rs")) why.push("discord.rs が無い");
  const hits: string[] = [];
  for (const f of files) {
    const s = lf(fs.readFileSync(path.join(T.root, f), "utf8"));
    s.split("\n").forEach((line, i) => {
      if (line.includes(appId)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  if (hits.length !== 1) why.push(`ID の直書きが ${hits.length} か所: ${hits.map((h) => h.slice(0, 90)).join(" | ")}`);
  else if (!/^src-tauri\/src\/discord\.rs:\d+: (pub )?const DISCORD_APP_ID: &str = "\d+";/.test(hits[0])) why.push(`1 か所だが定数の定義ではない: ${hits[0]}`);
  const rs = T.has("src-tauri/src/discord.rs") ? T.read("src-tauri/src/discord.rs") : "";
  if ((rustNonTest(rs).match(/\bDISCORD_APP_ID\b/g) ?? []).length < 2) why.push("定数を使っている所が無い");
  return why.length ? ng(why.join("／")) : ok();
}

// ================= [S-3] 既定オン =================
async function S3(T: Tree): Promise<V> {
  const why: string[] = [];
  const { dp } = await loadJs(T);
  const cases: [string, object, boolean][] = [
    ["設定なし", {}, true],
    ["undefined", { discordPresence: undefined }, true],
    ["true", { discordPresence: true }, true],
    ["false", { discordPresence: false }, false],
    ['"false"（壊れた値）', { discordPresence: "false" }, true],
    ["0（壊れた値）", { discordPresence: 0 }, true],
    ["null（壊れた値）", { discordPresence: null }, true],
    ['"off"（壊れた値）', { discordPresence: "off" }, true],
    ["{}（壊れた値）", { discordPresence: {} }, true],
  ];
  for (const [name, s, want] of cases) {
    if (dp.discordPresenceEnabled(s) !== want) why.push(`${name} → ${!want}`);
    if (dp.discordPresenceArgs(s).enabled !== want) why.push(`${name} の引数 enabled → ${!want}`);
  }
  const main = T.read("src/main.ts");
  if (!/\n  discordPresence\?: boolean;/.test(main)) why.push("Settings に discordPresence?: boolean が無い");
  if (!/settings\.discordPresence = !discordPresenceEnabled\(settings\);/.test(main)) why.push("⚙ の切り替えが discordPresenceEnabled で反転していない");
  if (!/classList\.toggle\("on", discordPresenceEnabled\(settings\)\)/.test(main)) why.push("⚙ のつまみの見た目が discordPresenceEnabled でない");
  if (/discordPresence\s*(===|!==|==|!=)\s*true/.test(main)) why.push("main.ts が既定オフ側の比較（=== true）を使っている");
  return why.length ? ng(why.join("／")) : ok();
}

// ================= [S-4] つながらない相手 =================
async function S4(T: Tree, which: "all" | "huge" | "silent" | "burst" | "flood" | "unit" = "all"): Promise<V> {
  const why: string[] = [];
  if (which === "unit") {
    cargoTests(T, why);
    return why.length ? ng(why.join("／")) : ok();
  }
  const D = "パラパラアニメを描いています";
  const basic = [{ set: [true, D] }, { sleep: 900 }, { set: [false, D] }, { sleep: 200 }, { set: [true, D] }, { sleep: 300 }, { set: [false, D] }, { shutdown: true }];
  const scs: Scenario[] = [];
  if (which === "all") {
    scs.push({ name: "none", behavior: null, steps: basic });
    scs.push({ name: "close", behavior: "close", steps: basic });
    scs.push({ name: "random", behavior: "random", steps: basic });
    scs.push({ name: "badutf8", behavior: "badutf8", steps: basic });
    scs.push({ name: "badjson", behavior: "badjson", steps: basic });
    scs.push({ name: "reject", behavior: "reject", steps: basic });
  }
  if (which === "all" || which === "huge") scs.push({ name: "huge", behavior: "huge", steps: [{ set: [true, D] }, { sleep: 250 }, { shutdown: true }], spec: { reply_ms: 3000 } });
  if (which === "all" || which === "silent") {
    // 返事しない相手で握手を待っている最中に、オフ・オン・終了。待つ上限（reply_ms）は長くしてある＝終了は上限で切り上げる
    scs.push({ name: "silent", behavior: "silent", spec: { reply_ms: 3000 }, steps: [{ set: [true, D] }, { sleep: 300 }, { set: [false, D] }, { set: [true, D] }, { shutdown: true }] });
  }
  if (which === "all") {
    // 返事しない相手は上限で諦めて、間隔ごとにやり直す
    scs.push({ name: "silentRetry", behavior: "silent", steps: [{ set: [true, D] }, { sleep: 1500 }, { shutdown: true }] });
  }
  if (which === "all" || which === "flood") {
    // READY 以外を流し続ける相手も、返事の上限で諦めて間隔ごとにやり直す（期限を毎回見る・レビュー指摘）
    scs.push({ name: "flood", behavior: "flood", steps: [{ set: [true, D] }, { sleep: 1500 }, { shutdown: true }] });
  }
  const results: Result[] = [];
  for (const sc of scs) {
    const r = await play(T, sc);
    results.push(r);
    commonChecks(r, why);
    const logs = logLines(r.run);
    if (REPORT) log(`  [S-4] ${sc.name}: exit=${r.run.code} conns=${r.fake?.conns.length ?? "-"} steps=${stepLines(r.run).map((l) => `${l.op}:${Math.round(Number(l.us) / 100) / 10}ms`).join(" ")} logs=${logs.join(" | ")}`);
    if (logs.includes("[discord] connected")) why.push(`${sc.name}: つながったことになっている`);
    if (sc.name === "huge" && !logs.includes("[discord] not connected: garbage")) why.push(`huge: 長さが巨大なゴミを即座に断っていない（ログ ${logs.join(" | ") || "なし"}）`);
    if (["badutf8", "badjson"].includes(sc.name) && !logs.includes("[discord] not connected: garbage")) why.push(`${sc.name}: ゴミとして断っていない（${logs.join(" | ")}）`);
    if (sc.name === "reject" && !logs.includes("[discord] not connected: rejected")) why.push(`reject: 断られたと分かっていない（${logs.join(" | ")}）`);
    if (sc.name === "none" && !logs.some((l) => l.startsWith("[discord] not connected"))) why.push("none: つながらなかったログが無い");
    if (sc.name === "none" && logs.filter((l) => l.startsWith("[discord] not connected")).length > 2) why.push(`none: 失敗のログが毎回出る（${logs.length} 行）`);
    if (sc.name === "flood" && ((r.fake?.conns.length ?? 0) < 2 || !logs.includes("[discord] not connected: no reply")))
      why.push(`flood: 流し続ける相手を上限で諦めていない（接続 ${r.fake?.conns.length} 回・ログ ${logs.join(" | ") || "なし"}）`);
    if (sc.name === "silentRetry" && (r.fake?.conns.length ?? 0) < 2) why.push(`silentRetry: 返事しない相手を諦めてやり直していない（${r.fake?.conns.length} 回）`);
  }
  if (which !== "all" && which !== "burst") return why.length ? ng(why.join("／")) : ok();
  // K-4: Discord をあとから起動 → 間隔（300 ms）＋α 以内に表示が出る
  if (which === "all") {
    const r = await play(T, { name: "late", behavior: "discord", lateMs: 700, steps: [{ set: [true, D] }, { sleep: 1600 }, { shutdown: true }] });
    commonChecks(r, why);
    const shown = r.fake!.frames.find((f) => f.op === 1 && (f.json as any)?.args?.activity);
    if (!shown) why.push("late: あとから起動した Discord に表示が出ない");
    else {
      const lag = shown.at - (r.run.t0 + 700);
      if (lag > BASE.retry_ms + 500) why.push(`late: 起動から ${lag} ms かかった（間隔 ${BASE.retry_ms} ms）`);
      if (REPORT) log(`  [S-4] late: Discord を起動してから表示まで ${lag} ms`);
    }
  }
  // 素早く何度も切り替える（⚙ の連打・言語の切り替え）: 溜まった命令は最後の 1 つだけ見る＝押した数だけつなぎ直さない。
  // 最後はオン → 表示が出たまま／最後がオフ → 消える（V193 の開発ビルドの確認で、本物の Discord の遅い返事に列が伸びたのを見て足した）
  {
    const burst = (last: boolean) => [
      { set: [true, D] },
      { sleep: 300 },
      ...Array.from({ length: 40 }, (_, i) => ({ set: [i % 2 === 1, D] })),
      { set: [last, D] },
      { sleep: 600 },
      { shutdown: true },
    ];
    for (const last of [true, false]) {
      const r = await play(T, { name: `burst${last ? "On" : "Off"}`, behavior: "discord", steps: burst(last) });
      commonChecks(r, why);
      const sets = r.fake!.frames.filter((f) => f.op === 1 && (f.json as any)?.cmd === "SET_ACTIVITY");
      // 切り替えを送り終えてから 400 ms の間に届いたものまで（終了のときの「消す」は数えない）
      const lastSetAt = Math.max(...stepLines(r.run).filter((l) => l.op === "set").map((l) => l.at));
      const atEnd = sets.filter((f) => f.at < lastSetAt + 400);
      const lastSet = atEnd[atEnd.length - 1];
      if (r.fake!.conns.length > 5) why.push(`burst${last ? "On" : "Off"}: 40 回の切り替えで ${r.fake!.conns.length} 回つなぎ直した（最後の 1 つだけ見ていない）`);
      if (last && !(lastSet && (lastSet.json as any).args?.activity)) why.push("burstOn: 最後がオンなのに表示が出ていない");
      if (!last && lastSet && (lastSet.json as any).args?.activity) why.push("burstOff: 最後がオフなのに表示が残っている");
      const seq = sets.map((f) => `${f.conn}${(f.json as any).args?.activity ? "+" : "0"}@${f.at - r.run.t0}`).join(" ");
      const stepAt = stepLines(r.run).map((l) => `${l.op}@${l.at - r.run.t0}`).slice(-3).join(" ");
      if (REPORT || why.some((w) => w.startsWith("burst"))) log(`  [S-4] burst${last ? "On" : "Off"}: 接続 ${r.fake!.conns.length} 回・SET_ACTIVITY ${sets.length} 通（${seq}）・最後の行 ${stepAt}`);
    }
  }
  if (which === "burst") return why.length ? ng(why.join("／")) : ok();
  // K-7: 途中で Discord が落ちて戻る → 気づいてつなぎ直し、表示も戻る
  {
    const r = await play(T, { name: "drop", behavior: "dropOnce", steps: [{ set: [true, D] }, { sleep: 1500 }, { shutdown: true }] });
    commonChecks(r, why);
    const logs = logLines(r.run);
    const shown = r.fake!.frames.filter((f) => f.op === 1 && (f.json as any)?.args?.activity);
    if (r.fake!.conns.length < 2 || shown.length < 2) why.push(`drop: 落ちたあとつなぎ直していない（接続 ${r.fake!.conns.length}・表示 ${shown.length}）`);
    if (!logs.some((l) => l.startsWith("[discord] disconnected"))) why.push(`drop: 切れたことに気づいていない（${logs.join(" | ")}）`);
    if (REPORT) log(`  [S-4] drop: 接続 ${r.fake!.conns.length} 回・表示 ${shown.length} 回・ログ ${logs.join(" | ")}`);
  }
  cargoTests(T, why);
  return why.length ? ng(why.join("／")) : ok();
}

/** Rust の単体テスト（discord.rs の #[cfg(test)]: 枠の読み書き・ゴミの総当たり・details の網・activity の葉・握手の期限〔流し続ける相手〕・
 *  V196 (A-102) 返事と閉じが 1 回の読みで同時に届く〔Mac の形・偽のソケットで本物の read_nonblocking を通す〕） */
function cargoTests(T: Tree, why: string[]) {
  {
    const h = buildHarness(T);
    try {
      const out = execFileSync(cargoBin(), ["test", "--offline", "--quiet"], {
        cwd: h.dir,
        env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
      });
      const m = out.match(/test result: ok\. (\d+) passed; 0 failed/);
      if (!m) why.push(`cargo test の結果が読めない: ${out.slice(-200)}`);
      else if (Number(m[1]) < 12) why.push(`cargo test が ${m[1]} 本しかない（12 本のはず・空振り）`);
      else if (REPORT) log(`  [S-4] cargo test: ${m[1]} passed`);
    } catch (e) {
      why.push(`cargo test が赤: ${String((e as { stdout?: string }).stdout ?? e).slice(-300)}`);
    }
  }
}

// ================= [S-5] 静的＋オフの間はつなぎ直さない =================
async function S5(T: Tree, opts: { dynamic: boolean }): Promise<V> {
  const why: string[] = [];
  const lib = T.read("src-tauri/src/lib.rs");
  if (!/#\[cfg\(desktop\)\]\s*\nmod discord;/.test(lib)) why.push("mod discord; が #[cfg(desktop)] の下でない");
  const ranges = cfgDesktopRanges(lib);
  const code = lib.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length)); // 位置を保ったままコメントを消す
  const uses = [...code.matchAll(/\bdiscord::\w+/g)];
  if (uses.length < 4) why.push(`lib.rs の discord:: が ${uses.length} か所（note_start・set_logger・set・shutdown のはず）`);
  for (const u of uses) if (!ranges.some(([a, b]) => u.index! >= a && u.index! < b)) why.push(`#[cfg(desktop)] の外で ${u[0]}（${lib.slice(0, u.index).split("\n").length} 行目）`);
  for (const f of ["note_start", "set_logger", "set", "shutdown"]) if (!uses.some((u) => u[0] === `discord::${f}`)) why.push(`lib.rs が discord::${f} を呼んでいない`);
  // setup の中は set_logger だけ（つなぐもの・スレッドを立てるものを置かない）
  const sm = /\.setup\(\|app\| \{/.exec(code);
  if (!sm) why.push("setup が見つからない（窓が壊れた）");
  else {
    const open = sm.index + sm[0].length - 1;
    const close = rustMatch(code, open);
    const body = close > 0 ? code.slice(open, close + 1) : "";
    if (!body) why.push("setup の本体を切り出せない");
    const inSetup = [...body.matchAll(/\bdiscord::\w+/g)].map((m) => m[0]);
    if (inSetup.join(" ") !== "discord::set_logger") why.push(`setup の中の discord:: が「${inSetup.join(" ") || "なし"}」（set_logger だけのはず）`);
    if (/thread::|Presence::|spawn\(/.test(body)) why.push("setup の中でスレッドを立てている");
  }
  // 終了は .build(...) ＋ .run(|…| RunEvent::Exit)
  if (!/\.build\(tauri::generate_context!\(\)\)/.test(lib)) why.push(".build(generate_context!()) になっていない");
  if (!/RunEvent::Exit/.test(lib)) why.push("RunEvent::Exit を見ていない");
  if (/\.run\(tauri::generate_context!\(\)\)/.test(lib)) why.push("古い .run(generate_context!()) が残っている");
  // discord.rs: スレッドは 1 か所・つなぐのはスレッドの中だけ
  const rs = T.has("src-tauri/src/discord.rs") ? T.read("src-tauri/src/discord.rs") : "";
  const body = noLineComments(rustNonTest(rs));
  const spawns = (body.match(/thread::Builder::new\(\)|thread::spawn\(/g) ?? []).length;
  if (spawns !== 1) why.push(`スレッドを立てる所が ${spawns} か所`);
  const pspawn = rustFnBody(body, "spawn") ?? "";
  if (!/thread::Builder::new\(\)/.test(pspawn)) why.push("スレッドを立てるのが Presence::spawn の中でない");
  if (!/catch_unwind/.test(pspawn)) why.push("スレッドの中の panic を catch_unwind で止めていない");
  const opens = (body.match(/Session::open\(/g) ?? []).length;
  const worker = noLineComments(rustFnBody(body, "worker") ?? "");
  if (opens !== 1 || (worker.match(/Session::open\(/g) ?? []).length !== 1) why.push(`Session::open が worker の中の 1 か所だけでない（全体 ${opens}）`);
  const setFn = rustFnBody(body, /\bpub fn set\(enabled: bool, details: String\)[^{;]*\{/) ?? "";
  if (!setFn) why.push("discord.rs に pub fn set(enabled: bool, details: String) が無い（窓が壊れた）");
  if (!/if enabled/.test(setFn) || !/get_or_init/.test(setFn)) why.push("set() がオンのときだけスレッドを立てる形でない");
  if ((body.match(/get_or_init/g) ?? []).length !== 1) why.push("get_or_init が set() の 1 か所だけでない");
  if (/Session::|sys::open|connect/.test(setFn.replace(/get_or_init\(spawn_default\)/, ""))) why.push("set() が呼んだ側のスレッドでつないでいる");
  if (!/const RETRY_INTERVAL: Duration = Duration::from_secs\(30\);/.test(body)) why.push("RETRY_INTERVAL が 30 秒の定数でない");
  // 受け口の差し替え（検査用）は開発ビルドだけ: 環境変数を読む文が #[cfg(debug_assertions)] の直下にある
  const envUses = [...body.matchAll(/MEMOANIMA_DISCORD_IPC_PREFIX/g)];
  const prefixFn = noLineComments(rustFnBody(body, "ipc_prefix") ?? "");
  if (envUses.length !== 1 || !/#\[cfg\(debug_assertions\)\]\s*\n\s*if let Some\(p\) = std::env::var_os\("MEMOANIMA_DISCORD_IPC_PREFIX"\)/.test(prefixFn))
    why.push("受け口の差し替え（MEMOANIMA_DISCORD_IPC_PREFIX）が #[cfg(debug_assertions)] の下の 1 か所でない（配布物でも読める）");
  if (!/endpoints: endpoints\(&ipc_prefix\(\), None\)/.test(rustFnBody(body, "default_config") ?? "")) why.push("default_config の受け口が ipc_prefix() を通っていない");
  // Windows の名前付きパイプは security_qos_flags(SECURITY_IDENTIFICATION) で開く（相手にこちらの権限を借りさせない・レビュー指摘）
  const winSys = body.slice(body.indexOf("#[cfg(windows)]\nmod sys"), body.indexOf("#[cfg(unix)]\nmod sys"));
  if (!/\.security_qos_flags\(SECURITY_IDENTIFICATION\)/.test(rustFnBody(winSys, "open") ?? "") || !/const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;/.test(winSys))
    why.push("Windows のパイプを security_qos_flags(SECURITY_IDENTIFICATION) で開いていない");
  // 本番の設定を harness で読む（定数の字面ではなく、実際に使われる値）
  const d = harnessJson(T, { mode: "defaults" }) as Record<string, any>;
  if (d.retry_ms !== 30_000) why.push(`本番のつなぎ直しが ${d.retry_ms} ms`);
  if (!(d.exit_wait_ms > 0 && d.exit_wait_ms <= 1000)) why.push(`終了で待つ上限が ${d.exit_wait_ms} ms`);
  if (!(d.reply_ms > 0 && d.reply_ms <= 10_000)) why.push(`返事を待つ上限が ${d.reply_ms} ms`);
  const eps = (d.endpoints as string[]) ?? [];
  const wantEps =
    process.platform === "win32"
      ? Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)
      : null;
  if (wantEps && JSON.stringify(eps) !== JSON.stringify(wantEps)) why.push(`本番の受け口が ${JSON.stringify(eps.slice(0, 2))}…（${eps.length}）`);
  if (!wantEps && (eps.length < 10 || !eps.every((e) => /\/discord-ipc-\d$/.test(e)))) why.push(`本番の受け口が ${JSON.stringify(eps.slice(0, 2))}`);
  if (REPORT) log(`  [S-5] 本番の設定: つなぎ直し ${d.retry_ms} ms・見張り ${d.watch_ms} ms・返事 ${d.reply_ms} ms・終了 ${d.exit_wait_ms} ms・受け口 ${eps.length} 個（${eps[0]} …）`);
  // 動かして: オフの間は 1 回もつなぎに来ない／オンの間は間隔ごとに来る
  if (opts.dynamic) {
    const D = "パラパラアニメを描いています";
    const r = await play(T, { name: "offquiet", behavior: "close", steps: [{ set: [true, D] }, { sleep: 1000 }, { set: [false, D] }, { sleep: 1500 }, { shutdown: true }] });
    commonChecks(r, why);
    const off = stepLines(r.run).find((l) => l.step === 2);
    if (!off) why.push("offquiet: オフの行が無い");
    else {
      const before = r.fake!.conns.filter((t) => t < off.at).length;
      const after = r.fake!.conns.filter((t) => t > off.at + 100).length;
      if (before < 3) why.push(`offquiet: オンの間のつなぎ直しが ${before} 回（間隔 ${BASE.retry_ms} ms・1 秒で 3 回以上のはず）`);
      if (after !== 0) why.push(`offquiet: ★オフの間に ${after} 回つなぎに来た`);
      if (REPORT) log(`  [S-5] offquiet: オンの 1 秒で ${before} 回・オフの 1.5 秒で ${after} 回`);
    }
    // 一度もオンにしなければ、スレッドも接続も無い（偽の Discord に 1 回も来ない）
    const r2 = await play(T, { name: "neveron", behavior: "close", steps: [{ set: [false, D] }, { sleep: 700 }, { shutdown: true }] });
    commonChecks(r2, why);
    if (r2.fake!.conns.length !== 0) why.push(`neveron: オフのまま ${r2.fake!.conns.length} 回つなぎに来た`);
  }
  return why.length ? ng(why.join("／")) : ok();
}

// ================= [S-6] 初回の知らせは出さない（V193b・作者決定 2026-10-04） =================
// 作者:「本体で案内しなくても良い・Discord 側でオフにできるから大丈夫」＝表示は既定オンのまま、アプリの中で知らせる道を外した。
// V193 の旧キー discordNoticeShown（未出荷）は miniHidden と同じ作法で**読み捨て**（型に 1 行残すだけ・読まない・書かない）。
const OLD_NOTICE_KEY = "set.discord.notice.msg";
async function S6(T: Tree): Promise<V> {
  const why: string[] = [];
  const main = T.read("src/main.ts");
  const dpSrc = T.read("src/discordPresence.ts");
  // 名前を数えるのは**コードだけ**（注釈で「外した」と旧い名前に触れるのは数えない）。TS の印字で注釈を落とす
  const codeOnly = (name: string, src: string) =>
    ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  const mainCode = codeOnly("main.ts", main);
  const dpCode = codeOnly("discordPresence.ts", dpSrc);
  // (a) 知らせを出す道が無い（関数・判定の口）
  for (const name of ["discordNoticeOnce", "discordNoticeDue"])
    if (new RegExp(`\\b${name}\\b`).test(mainCode + "\n" + dpCode)) why.push(`${name} が残っている`);
  // (b) ★起動の流れ（DOMContentLoaded の中）で Discord に触れるのは syncDiscordPresence() の 1 回だけ
  //     （知らせのダイアログ・トースト・Discord の文言をここへ戻すと赤。名前や文字列に discord を含むものを全部拾う）
  const sf = ts.createSourceFile("main.ts", main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let startup: ts.Node | null = null;
  const find = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(sf) === "window.addEventListener" &&
      n.arguments.length >= 2 &&
      ts.isStringLiteral(n.arguments[0]) &&
      n.arguments[0].text === "DOMContentLoaded"
    )
      startup = n.arguments[1];
    ts.forEachChild(n, find);
  };
  find(sf);
  if (!startup) why.push("起動の流れ（DOMContentLoaded）が見つからない（窓が壊れた）");
  else {
    const refs: string[] = [];
    const walk = (n: ts.Node) => {
      if ((ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /discord/i.test(n.text)) refs.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(startup);
    if (refs.join(" ") !== "syncDiscordPresence") why.push(`起動の流れで Discord に触れる所が「${refs.join(" ") || "なし"}」（syncDiscordPresence の 1 回だけのはず）`);
    // カナリア: 拾い方が効いている（既知の陽性＝syncDiscordPresence は拾えている）
    if (!refs.includes("syncDiscordPresence")) why.push("カナリア: 起動の syncDiscordPresence() を拾えていない（数え方が壊れた）");
  }
  // (c) 知らせの文言のキーがどこにも無い（src の .ts・index.html・7 言語の辞書）
  const holders: string[] = [];
  const scan = (d: string) => {
    const abs = path.join(T.root, d);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) scan(rel);
      else if (/\.(ts|html)$/.test(e.name) && lf(fs.readFileSync(path.join(T.root, rel), "utf8")).includes(OLD_NOTICE_KEY)) holders.push(rel);
    }
  };
  scan("src");
  if (T.has("index.html") && T.read("index.html").includes(OLD_NOTICE_KEY)) holders.push("index.html");
  if (holders.length) why.push(`${OLD_NOTICE_KEY} が残っている: ${holders.join(" ")}`);
  for (const lang of LANGS) {
    const mod = (await import(pathToFileURL(path.join(T.root, `src/i18n/${lang}.ts`)).href)) as { default: Record<string, string> };
    if (OLD_NOTICE_KEY in mod.default) why.push(`${lang}: 辞書に ${OLD_NOTICE_KEY} が残っている`);
  }
  // (d) 古いキーは読み捨て: 型の 1 行（読み捨ての注記つき）のほかに discordNoticeShown を読む・書く所が無い
  const uses = [...mainCode.matchAll(/discordNoticeShown/g)].length;
  const decl = main.indexOf("\n  discordNoticeShown?: boolean;");
  if (decl < 0) why.push("Settings に旧キー discordNoticeShown?: boolean が無い（知らないキーとして落とさない作法・miniHidden と同じ）");
  else {
    // 直前の /** … */ の中に「読み捨て」がある
    const before = main.slice(Math.max(0, decl - 600), decl);
    const doc = before.slice(before.lastIndexOf("/**"));
    if (!doc.includes("*/") || !doc.includes("読み捨て")) why.push("旧キー discordNoticeShown の型に「読み捨て」の注記が無い");
  }
  if (uses !== 1) why.push(`main.ts の discordNoticeShown が ${uses} か所（型の 1 行だけのはず＝読む・書く所がある）`);
  if (/discordNoticeShown/.test(dpCode)) why.push("discordPresence.ts が旧キー discordNoticeShown を読んでいる");
  // (e) 動かして: 古いキーがどんな値で残っていても、表示のオン/オフと渡すものは変わらない
  const { dp, i18n } = await loadJs(T);
  i18n.setLang("ja");
  for (const old of [undefined, true, false, "x", 0, null]) {
    for (const presence of [undefined, true, false]) {
      const base: Record<string, unknown> = {};
      if (presence !== undefined) base.discordPresence = presence;
      const withOld: Record<string, unknown> = { ...base, discordNoticeShown: old };
      if (dp.discordPresenceEnabled(withOld) !== dp.discordPresenceEnabled(base)) why.push(`旧キー ${String(old)} で表示のオン/オフが変わる（discordPresence=${String(presence)}）`);
      if (JSON.stringify(dp.discordPresenceArgs(withOld)) !== JSON.stringify(dp.discordPresenceArgs(base))) why.push(`旧キー ${String(old)} で渡すものが変わる（discordPresence=${String(presence)}）`);
    }
  }
  if ("discordNoticeDue" in (dp as object)) why.push("discordPresence.ts が discordNoticeDue を export している");
  return why.length ? ng(why.join("／")) : ok();
}

// ================= [S-7] README・README.md・⚙ の法務の 1 文 =================
function sectionOf(text: string, head: RegExp, nextHead: RegExp): string | null {
  const m = head.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const n = nextHead.exec(rest);
  return text.slice(m.index, m.index + m[0].length + (n ? n.index : rest.length));
}
/** 全角を 2 と数える幅 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}
function S7(T: Tree): V {
  const why: string[] = [];
  const PROMISE_JA = /\nあなたが投稿を選んだ作品を除き[^\n]*\n[^\n]*\n[^\n]*変わりません。\n/;
  const PROMISE_EN = /\nApart from animations you choose to publish[^\n]*\n[^\n]*\n[^\n]*on any platform\.\n/;
  for (const [rel, head, next, promise, oldRe, kws, maxW] of [
    ["release-assets/README.txt", /\n■ 通信について\n/, /\n■ /, PROMISE_JA, /自分から通信するのは[\s\S]{0,40}1つだけ/, ["Discord", "歯車のアイコン", "既定でオン", "インターネット", "Discord の設定", "作品の名前", "オフ", "Discord の側でも止められます", "アクティビティのプライバシー"], 0],
    ["release-assets/README_en.txt", /\n== ABOUT NETWORK ACCESS ==\n/, /\n== /, PROMISE_EN, /exactly one thing the app does on its own/, ["Discord", "gear icon", "on by default", "internet", "Discord settings", "names of your animations", "off", "stop it from Discord itself", "Activity Privacy"], 80],
  ] as const) {
    const now = T.read(rel);
    const head0 = baseBlob(rel);
    const sec = sectionOf(now, head, next);
    const sec0 = sectionOf(head0, head, next);
    if (!sec || !sec0) {
      why.push(`${rel}: 節が見つからない（窓が壊れた）`);
      continue;
    }
    if (oldRe.test(sec)) why.push(`${rel}: 旧文（1 つだけ）が残っている`);
    for (const k of kws) if (!sec.includes(k)) why.push(`${rel}: 「${k}」が無い`);
    const p = promise.exec(sec)?.[0];
    const p0 = promise.exec(sec0)?.[0];
    if (!p0) why.push(`${rel}: 基準（V193 の前）の約束の段落を切り出せない（窓が壊れた）`);
    else if (p !== p0) why.push(`${rel}: ★作品データの約束の段落が変わった`);
    // 幅: 日本語は既存の節のいちばん長い行を超えない・英語は 80 桁
    const lim = maxW || Math.max(...sec0.split("\n").map(dispWidth));
    const wide = sec.split("\n").filter((l) => dispWidth(l) > lim);
    if (wide.length) why.push(`${rel}: 幅 ${lim} を超える行 ${wide.length}（${wide[0].slice(0, 30)}…）`);
    if (sec.split("\n").length <= sec0.split("\n").length) why.push(`${rel}: 節が増えていない`);
  }
  // README.md（公開リポの顔・日英 2 節）
  const md = T.read("README.md");
  if (/The one thing the app does on its own/.test(md)) why.push("README.md（英）に旧文が残っている");
  if (/アプリが自分から通信するのは「新しい版が出ているかの確認」だけ/.test(md)) why.push("README.md（日）に旧文が残っている");
  if ((md.match(/Discord/g) ?? []).length < 2) why.push("README.md の日英に Discord の記述が無い");
  return why.length ? ng(why.join("／")) : ok();
}

// ================= [S-8] 7 言語のキー・禁止語・i18n 検査 =================
async function S8(T: Tree): Promise<V> {
  const why: string[] = [];
  for (const lang of LANGS) {
    const mod = (await import(pathToFileURL(path.join(T.root, `src/i18n/${lang}.ts`)).href)) as { default: Record<string, string> };
    const d = mod.default;
    for (const k of NEW_KEYS) {
      const v = d[k];
      if (typeof v !== "string" || v.trim() === "") why.push(`${lang}: ${k} が無い`);
      else if (BANNED.test(v)) why.push(`${lang}: ${k} に禁止語`);
    }
    const det = d["set.discord.details.msg"] ?? "";
    if (det && (det.length < 2 || det.length > 128 || /[\\/]/.test(det))) why.push(`${lang}: details が Discord の決まり（2〜128 字・パス記号なし）に合わない`);
    const legal = d["set.legal.offline.msg"] ?? "";
    if (!legal.includes("Discord")) why.push(`${lang}: set.legal.offline.msg に Discord が無い（「自分から通信するのは更新の確認だけ」のまま）`);
  }
  if (T === realTree) {
    const out = execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/m1201_i18n_check.ts"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
    const m = out.match(/pass=(\d+) fail=(\d+)/);
    if (!m) why.push("i18n 検査の結果が読めない");
    else if (m[2] !== "0") why.push(`i18n 検査 fail=${m[2]}: ${out.split("\n").filter((l) => l.startsWith("NG")).join(" ／ ").slice(0, 300)}`);
    else if (REPORT) log(`  [S-8] i18n 検査: pass=${m[1]} fail=0`);
  }
  return why.length ? ng(why.join("／")) : ok();
}

// ================= 写し（[S-9] 反証） =================
const COPY_FILES = ["src-tauri/src/discord.rs", "src-tauri/src/lib.rs", "src/discordPresence.ts", "src/main.ts", "src/platform.ts", "release-assets/README.txt", "release-assets/README_en.txt", "README.md"];
function copyTree(tag: string, mutate?: (rel: string, s: string) => string): Tree {
  const dir = path.join(tmpRoot, tag);
  const files = [...COPY_FILES, ...fs.readdirSync(path.join(root, "src/i18n")).map((f) => `src/i18n/${f}`)];
  for (const rel of files) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    let s = fs.readFileSync(src, "utf8");
    if (mutate) s = mutate(rel, s);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), s);
  }
  return {
    root: dir,
    tag,
    read: (rel) => lf(fs.readFileSync(path.join(dir, rel), "utf8")),
    has: (rel) => fs.existsSync(path.join(dir, rel)),
  };
}
function mustReplace(s: string, from: string | RegExp, to: string, what: string): string {
  const t = s.replace(from, to);
  if (t === s) throw new Error(`反証の書き換えが当たらない: ${what}`);
  return t;
}

// ================= 走らせる =================
async function main() {
  try {
    const r1 = await safe(() => S1(realTree, { dynamic: true }));
    check("[S-1] 渡す中身（JS の引数・呼び出し口・activity の葉・偽の Discord が受け取ったバイト）", r1.ok, r1.why);
    const r2 = await safe(() => S2(realTree));
    check("[S-2] Application ID はコードに 1 か所（定数の定義）・REQ と同じ値", r2.ok, r2.why);
    const r3 = await safe(() => S3(realTree));
    check("[S-3] 既定オン（未設定・壊れた値＝オン／false だけオフ）", r3.ok, r3.why);
    const r4 = await safe(() => S4(realTree));
    check("[S-4] つながらない相手（相手なし・すぐ閉じる・返事しない・ゴミ・断られる・あとから起動・途中で落ちる）＋ cargo test", r4.ok, r4.why);
    const r5 = await safe(() => S5(realTree, { dynamic: true }));
    check("[S-5] 静的（cfg(desktop)・setup でつながない・スレッド 1 本・30 秒）＋オフの間はつなぎ直さない", r5.ok, r5.why);
    const r6 = await safe(() => S6(realTree));
    check("[S-6] 初回の知らせは出さない（関数・キー・7 言語の文言が無い・起動で触れるのは syncDiscordPresence だけ・旧キーは読み捨て）", r6.ok, r6.why);
    const r7 = await safe(() => S7(realTree));
    check("[S-7] README の通信について（日・英）・README.md・約束の段落は不変", r7.ok, r7.why);
    const r8 = await safe(() => S8(realTree));
    check("[S-8] 7 言語の新キー・禁止語なし・⚙ の法務の 1 文・i18n 検査 fail=0", r8.ok, r8.why);

    // ---- [S-0] 無改変の写し ----
    const z = await (async () => {
      const T = copyTree("plain");
      return [
        await safe(() => S1(T, { dynamic: false })),
        await safe(() => S2(T)),
        await safe(() => S3(T)),
        await safe(() => S4(T, "huge")),
        await safe(() => S4(T, "silent")),
        await safe(() => S5(T, { dynamic: true })),
        await safe(() => S6(T)),
      ];
    })();
    check("[S-0] 無改変の写しでは [S-1][S-2][S-3][S-4][S-5][S-6] が緑", z.every((x) => x.ok), z.map((x) => x.why).filter(Boolean).join("／"));

    // ---- [S-9] 反証 ----
    type Mut = { id: string; what: string; run: (T: Tree) => Promise<V> | V; mut: (rel: string, s: string) => string };
    const appIdNow = (() => {
      try {
        return reqValues().appId;
      } catch {
        return "0";
      }
    })();
    const muts: Mut[] = [
      {
        id: "①",
        what: "作品名（アルバム名）を details に入れる",
        run: (T) => S1(T, { dynamic: false }),
        mut: (rel, s) =>
          rel !== "src/discordPresence.ts"
            ? s
            : mustReplace(s, "details: t(DISCORD_DETAILS_KEY) }", 'details: `${t(DISCORD_DETAILS_KEY)} ${String((s as { lastAlbum?: unknown }).lastAlbum ?? "")}` }', "discordPresenceArgs の details"),
      },
      {
        id: "①b",
        what: "main.ts で details をアルバム名に差し替える",
        run: (T) => S1(T, { dynamic: false }),
        mut: (rel, s) =>
          rel !== "src/main.ts"
            ? s
            : mustReplace(s, 'invoke("discord_presence_set", discordPresenceArgs(settings))', 'invoke("discord_presence_set", { ...discordPresenceArgs(settings), details: settings.lastAlbum ?? "" })', "syncDiscordPresence の invoke"),
      },
      {
        id: "②",
        what: "Application ID を 2 か所に書く（握手に直書き）",
        run: S2,
        mut: (rel, s) => (rel !== "src-tauri/src/discord.rs" ? s : mustReplace(s, 'json!({ "v": 1, "client_id": app_id })', `json!({ "v": 1, "client_id": if app_id.is_empty() { "${appIdNow}" } else { app_id } })`, "handshake_payload")),
      },
      {
        id: "③",
        what: "既定をオフにする（=== true）",
        run: S3,
        mut: (rel, s) => (rel !== "src/discordPresence.ts" ? s : mustReplace(s, "s.discordPresence !== false", "s.discordPresence === true", "discordPresenceEnabled")),
      },
      {
        id: "④",
        what: "setup の中でつなぐ（起動時にその場で set を呼ぶ）",
        run: (T) => S5(T, { dynamic: false }),
        mut: (rel, s) =>
          rel !== "src-tauri/src/lib.rs"
            ? s
            : mustReplace(s, "                discord::set_logger(", "                discord::set(true, String::new());\n                discord::set_logger(", "setup の set_logger"),
      },
      {
        id: "④b",
        what: "set() が呼んだ側のスレッドで先につなぐ",
        run: (T) => S5(T, { dynamic: false }),
        mut: (rel, s) =>
          rel !== "src-tauri/src/discord.rs"
            ? s
            : mustReplace(s, "pub fn set(enabled: bool, details: String) {\n", "pub fn set(enabled: bool, details: String) {\n    let _ = Session::open(&endpoints(IPC_PREFIX, None), DISCORD_APP_ID, REPLY_TIMEOUT);\n", "pub fn set の頭"),
      },
      {
        id: "⑤",
        what: "オフの間もつなぎ直す",
        run: (T) => S5(T, { dynamic: true }),
        mut: (rel, s) => {
          if (rel !== "src-tauri/src/discord.rs") return s;
          let t = mustReplace(s, "let wait = if !enabled {\n            None", "let wait = if !enabled {\n            Some(cfg.retry)", "worker の待ち時間");
          t = mustReplace(t, "        if !enabled {\n            continue;\n        }\n", "", "worker のオフの門");
          return t;
        },
      },
      {
        id: "⑥",
        what: "初回の知らせを出す道を戻す（V193 の discordNoticeOnce と起動の呼び出し）",
        run: S6,
        mut: (rel, s) => {
          if (rel !== "src/main.ts") return s;
          const fn = [
            "async function discordNoticeOnce(): Promise<void> {",
            "  if (!discordPresenceEnabled(settings) || settings.discordNoticeShown === true) return;",
            "  settings.discordNoticeShown = true;",
            '  invoke("save_settings", { settings }).catch(() => {});',
            "  await modal((close) => {",
            '    const box = document.createElement("div");',
            '    box.textContent = t("set.discord.label");',
            '    box.addEventListener("click", () => close(null));',
            "    return box;",
            "  });",
            "}",
            "",
          ].join("\n");
          let t = mustReplace(s, "/** M7-2b: ⚙ 設定メニュー（エクスプローラー直結を廃止し、ここから各設定へ） */\n", fn + "/** M7-2b: ⚙ 設定メニュー（エクスプローラー直結を廃止し、ここから各設定へ） */\n", "関数を戻す");
          t = mustReplace(t, "  if (updateCheckEnabled()) await updateNoticeOnce(); // 初回だけ一言（オフの人には出さない）\n", "  if (updateCheckEnabled()) await updateNoticeOnce(); // 初回だけ一言（オフの人には出さない）\n  await discordNoticeOnce();\n", "起動の呼び出しを戻す");
          return t;
        },
      },
      {
        id: "⑥b",
        what: "旧キーも関数も使わず、起動時に Discord のトーストだけ出す",
        run: S6,
        mut: (rel, s) =>
          rel !== "src/main.ts"
            ? s
            : mustReplace(s, "  if (updateCheckEnabled()) await updateNoticeOnce(); // 初回だけ一言（オフの人には出さない）\n", '  if (updateCheckEnabled()) await updateNoticeOnce(); // 初回だけ一言（オフの人には出さない）\n  toast(t("set.discord.label"));\n', "起動にトーストを足す"),
      },
      {
        id: "⑦",
        what: "ヘッダの長さの上限を外す（名乗った長さを信じて待つ）",
        run: (T) => S4(T, "huge"),
        mut: (rel, s) => (rel !== "src-tauri/src/discord.rs" ? s : mustReplace(s, "    if len > MAX_FRAME {\n        return Err(FrameError::TooLong);\n    }\n", "", "take_frame の上限")),
      },
      {
        id: "⑧",
        what: "終了で上限なく待つ（recv_timeout → recv）",
        run: (T) => S4(T, "silent"),
        mut: (rel, s) => (rel !== "src-tauri/src/discord.rs" ? s : mustReplace(s, "let _ = ack_rx.recv_timeout(wait);", "let _ = (ack_rx.recv(), wait);", "Presence::shutdown")),
      },
      {
        id: "⑨",
        what: "溜まった命令を 1 つずつ片付ける（最後の 1 つだけ見ない）",
        run: (T) => S4(T, "burst"),
        mut: (rel, s) => (rel !== "src-tauri/src/discord.rs" ? s : mustReplace(s, "    while !matches!(m, Cmd::Exit(_)) {", "    while false && !matches!(m, Cmd::Exit(_)) {", "latest のループ")),
      },
      {
        id: "⑩",
        what: "受け口の差し替えを配布物（release）でも読む",
        run: (T) => S5(T, { dynamic: false }),
        mut: (rel, s) => (rel !== "src-tauri/src/discord.rs" ? s : mustReplace(s, "    #[cfg(debug_assertions)]\n    if let Some(p)", "    if let Some(p)", "ipc_prefix の cfg")),
      },
      {
        id: "⑪",
        what: "握手の期限を「何も来ないとき」だけ見る形に戻す",
        // 時間に頼る筋書き（flood）では負荷しだいで受け手が一瞬「何も無い」を見て緑に戻るので、
        // 判断を切り離した wait_ready を「別の通知を返し続ける偽物」で動かす単体テスト（cargo test）で見る
        run: (T) => S4(T, "unit"),
        mut: (rel, s) => {
          if (rel !== "src-tauri/src/discord.rs") return s;
          let t = mustReplace(s, '        if Instant::now() >= deadline {\n            return Err("no reply");\n        }\n', "", "wait_ready の期限");
          t = mustReplace(t, "            None => thread::sleep(Duration::from_millis(20)),", '            None if Instant::now() >= deadline => return Err("no reply"),\n            None => thread::sleep(Duration::from_millis(20)),', "wait_ready の None");
          return t;
        },
      },
      {
        id: "⑫",
        what: "Windows のパイプを security_qos_flags なしで開く",
        run: (T) => S5(T, { dynamic: false }),
        mut: (rel, s) => (rel !== "src-tauri/src/discord.rs" ? s : mustReplace(s, "            .security_qos_flags(SECURITY_IDENTIFICATION)\n", "", "sys::open の qos")),
      },
      {
        id: "⑬",
        what: "読みが閉じを見たら、同じ読みで届いていた返事ごと捨てる（V196・A-102 の前の形）",
        // Mac では断りの返事と閉じが 1 回の読みで同時に届く（Windows では起きず、Linux では閉じが少し遅れて届く）＝筋書きでは赤にならないので、
        // 偽のソケットで本物の read_nonblocking を通す単体テスト（cargo test）で見る
        run: (T) => S4(T, "unit"),
        mut: (rel, s) =>
          rel !== "src-tauri/src/discord.rs"
            ? s
            : mustReplace(
                s,
                "            if self.conn.read_ready(&mut self.buf, MAX_FRAME + 8).is_err() {\n                self.closed = true;\n            }\n",
                '            self.conn.read_ready(&mut self.buf, MAX_FRAME + 8).map_err(|_| "closed")?;\n',
                "Session::next の読み"
              ),
      },
    ];
    for (const m of muts) {
      let r: V;
      try {
        const T = copyTree(`m${muts.indexOf(m)}`, m.mut);
        r = await safe(() => m.run(T));
      } catch (e) {
        r = { ok: true, why: `写しを作れない: ${(e as Error).message}`, threw: true };
      }
      const caught = !r.ok && !r.threw;
      check(`[S-9] 反証${m.id} ${m.what} → 赤`, caught, caught ? "" : `赤にならない（${r.why || "緑のまま"}）`);
      if (REPORT || !caught) log(`  [S-9] ${m.id} ${m.what}: ${caught ? "赤 — " + r.why.slice(0, 200) : "×"}`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    try {
      fs.rmdirSync(path.dirname(tmpRoot));
    } catch {
      /* ほかの pid の写しが残っていれば消さない */
    }
  }
  console.log(`v193_smoke: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
void main();
