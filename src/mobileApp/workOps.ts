// V211 (M-1b・要件 §6-3): 作品を開く・新規メモ・オートセーブから復元するときの組み立てと、MobileWorkSession に渡す口。
//
// ★SessionOptions には、写し（保存の Worker＝encodeViaWorker）・いまのコマ（値でなく口）・見積り（大きい作品）・サムネ（PNG）・入力へ譲る口を
//  必ず渡す（V201 §11 の 7・8、V202 §12 の 10。既定の encodeOnThisThread は主スレッドで写すので、大きい作品で画面が止まる）。
// ★開く道は生のバイト列（mobile_read_work）。読む前の大きさの門番は Rust の定数（PC の値のまま）。
// ★時間を測る（読む・組み立て・写す・書く・確かめる）。確かめ画面に出す（M-0 の S-8 の代わり）。
import { encodeViaWorker, type WorkerLike } from "../editor/saveCore";
import { newProject, type Project } from "../editor/model";
import { projectFromBytes } from "../editor/serialize";
import { frameToPngBlob } from "../editor/render";
import { saveSnapshotAllowed, snapshotBytes } from "../editor/prefs";
import { untitledTitle } from "../i18n/defaults";
import { MobileWorkSession, type SessionOptions } from "../mobile/session";
import type { MobilePort, SessionEntry } from "../mobile/port";

/** 測った時間（ms） */
export interface Timing {
  label: string;
  ms: number;
}

let worker: Worker | null = null;
let seq = 0;

function saveWorker(): WorkerLike {
  if (!worker) worker = new Worker(new URL("../editor/saveWorker.ts", import.meta.url), { type: "module" });
  return worker;
}

/** 入力へ譲る（オートセーブの PV6 の間） */
function yieldNow(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export interface OpsHooks {
  /** いま開いているコマ */
  currentFrame: () => number;
  /** 時間を記録する */
  timing: (t: Timing) => void;
  log: (line: string) => void;
}

/** MobileWorkSession に渡す口（写し・サムネ・いまのコマ・見積り・譲る口） */
export function sessionOptions(h: OpsHooks): SessionOptions {
  return {
    encode: async (p) => {
      const t0 = performance.now();
      const r = await encodeViaWorker(saveWorker(), ++seq, p);
      h.timing({ label: "写す（PV6）", ms: performance.now() - t0 });
      return r;
    },
    thumb: async (p) => {
      const blob = await frameToPngBlob(p, p.thumbFrame ?? 0);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
    },
    currentFrame: h.currentFrame,
    // 写す前の見積り（PC の V168 と同じ上限）。超えたら断る（例外にしない）
    prepare: async () => saveSnapshotAllowed(snapshotBytes(p0()).est),
    yieldNow,
    log: h.log,
  };
  // 見積りは、そのとき開いている作品で（セッションを作ったあとに入れる）
  function p0(): Project {
    return current ?? newProject("");
  }
}

/** 見積りに使う、いま開いている作品（セッションを作るたびに入れる） */
let current: Project | null = null;
function track(s: MobileWorkSession): MobileWorkSession {
  current = s.project;
  return s;
}

/** 読む命令を時間つきで（読む・組み立て） */
export async function readProject(port: MobilePort, album: string, name: string, h: OpsHooks) {
  const t0 = performance.now();
  const rw = await port.readWork(album, name);
  const t1 = performance.now();
  h.timing({ label: "読む（Rust→JS）", ms: t1 - t0 });
  const project = await projectFromBytes(rw.data);
  h.timing({ label: "組み立て", ms: performance.now() - t1 });
  return { rw, project };
}

/** ライブラリから開く（読む命令が返した指紋＝保存元の指紋） */
export function openSession(port: MobilePort, project: Project, rw: { album: string; name: string; fingerprint: { sha256: string; size: number } }, h: OpsHooks): MobileWorkSession {
  return track(MobileWorkSession.openWork(port, project, { album: rw.album, name: rw.name, fingerprint: rw.fingerprint }, sessionOptions(h)));
}

/** 新規メモ */
export function newSession(port: MobilePort, h: OpsHooks): MobileWorkSession {
  return track(MobileWorkSession.newWork(port, newProject(untitledTitle()), sessionOptions(h)));
}

/** オートセーブから復元（同じ番号を使い続ける） */
export async function restoreSession(port: MobilePort, entry: SessionEntry, h: OpsHooks): Promise<MobileWorkSession | null> {
  const t0 = performance.now();
  const sr = await port.autosaveRead(entry.session);
  if (!sr) return null;
  const t1 = performance.now();
  h.timing({ label: "読む（オートセーブ）", ms: t1 - t0 });
  const project = await projectFromBytes(sr.data);
  h.timing({ label: "組み立て", ms: performance.now() - t1 });
  return track(MobileWorkSession.restore(port, project, { session: sr.session, meta: sr.meta }, sessionOptions(h)));
}

/** 時間を測る口（書く・確かめるを分けて測る）。部品の口を包むだけで、渡す中身は変えない */
export function timedPort(port: MobilePort, timing: (t: Timing) => void): MobilePort {
  const wrap = <A extends unknown[], R>(label: string, f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const t0 = performance.now();
      try {
        return await f(...a);
      } finally {
        timing({ label, ms: performance.now() - t0 });
      }
    };
  return {
    ...port,
    saveNew: wrap("書く（新しく保存・Rust）", port.saveNew),
    saveOverwrite: wrap("書く（上書き・Rust）", port.saveOverwrite),
    readWork: wrap("読む（確かめ・Rust）", port.readWork),
    autosaveWrite: wrap("オートセーブを書く（Rust）", port.autosaveWrite),
  };
}
