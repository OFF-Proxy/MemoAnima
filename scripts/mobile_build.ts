// V211 (M-1b・要件 docs/REQ_mobile_m1_base.md §6-1): モバイルのビルドと、配るファイルの走査（依存なし・Node だけ）。
// 下見の spike/tools/build-mobile.mjs（V184c）を製品の形に移したもの。V212（M-1c）で `android-init`・`android` を足した。
//
//   npx tsx scripts/mobile_build.ts ios-init                       … `tauri ios init`（src-tauri/gen/apple を作る・XcodeGen を PATH に）
//   npx tsx scripts/mobile_build.ts ios <ビルド番号> [--devcheck] [--sim]
//        … iOS のビルド（--sim はシミュレーター向けの .app・無ければ TestFlight 用の .ipa）→ Info.plist の値 → この回のビルドか → 走査
//        --devcheck は確かめ画面（開発用）の印を立てる（Rust の feature `mobile-devcheck` と、画面の __MOBILE_DEVCHECK__ を両方）
//   npx tsx scripts/mobile_build.ts scan <file|folder> [--devcheck|--no-devcheck]
//        … 走査だけ（.ipa・.app のフォルダ）。--no-devcheck は「確かめ画面の目印が 0 件」も見る（--devcheck は「目印に当たる」＝陽性の対照）
//   npx tsx scripts/mobile_build.ts scan --selftest                … 走査が効いていることの自己点検（既知の陽性と陰性）
//   npx tsx scripts/mobile_build.ts android-init                   … `tauri android init`（src-tauri/gen/android を作る）→ アイコンを入れる
//   npx tsx scripts/mobile_build.ts android <versionCode> [--devcheck] [--debug]
//        … Android の APK（x86_64＋aarch64）→ release は試験の鍵（ホームの下の .memoanima-test-keys・使い捨て）で署名 → apksigner verify →
//          Manifest の値 → .so の記号 → 走査（APK のファイル全体・項目の名前と中身・dist-mobile）。できた APK はホームの下の MemoAnima-apk に
//   npx tsx scripts/mobile_build.ts android-check <apk> <versionCode> [--devcheck] [--debug] … できた APK を確かめ直す
//   ★Android: JAVA_HOME・ANDROID_HOME・NDK_HOME は台本が見つけて子のプロセスにだけ渡す。remap と Tauri のリンクの指定は CARGO_ENCODED_RUSTFLAGS
//    で一緒に（RUSTFLAGS は消す）。Windows では jniLibs のシンボリックリンクに開発者モードが要る
//
// ★作者のパスを焼き付けない: `--remap-path-prefix=<ホーム>=~` を **CARGO_ENCODED_RUSTFLAGS** で渡す（RUSTFLAGS は消す）。Tauri の CLI は
//  xcodebuild を環境変数を消して走らせ、Xcode の中の cargo には `CARGO_*`・`RUST_*`・`TAURI*` などだけを渡す＝RUSTFLAGS は届かない（V184c）。
// ★ビルド番号（CFBundleVersion）は `--config` の bundle.iOS.bundleVersion で入れて、できたものの中で確かめる（`--build-number` は 4 つ組に
//  なるので使わない）。TestFlight は同じ番号を受け付けない＝上げるたびに 1 つ上げる。
// ★App Store 用の書き出しは、記号表（Symbols/）に Swift・Objective-C のソースの絶対パスを入れる → ExportOptions.plist の uploadSymbols＝NO。
// ★`tauri ios init` のアイコンはひな形 → src-tauri/icons/ios のメモアニマの絵で Assets.xcassets を上書きする（PC のアイコンは触らない）。
// ★走査: 全部展開して、ホームの絶対パス 3 形（大小を問わない）とユーザー名（大小を区別）を、UTF-16 の形・入れ子の zip も含めて探す。
//  探す字はこのファイルに書かない（実行時に導出）・見つかった字そのものは出さない（make_release.ts・mac_build.ts と同じ判断）。
// ★確かめ画面の目印は Rust の側（印の中だけの命令の名前）。画面のファイル（dist-mobile/）は実行ファイルの中で縮めて入る（Tauri の既定の
//  compression）ので、画面の字では見えない。
// ★チームの ID は APPLE_DEVELOPMENT_TEAM（無ければキーチェーンの開発用の証明書から導出）。画面にもファイルにも出さない。
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

/** 期待する値（tauri.conf.json・tauri.ios.conf.json と同じ。ずれたら止まる） */
export const IOS_EXPECT = {
  bundleId: "com.arcana.memoanima",
  minimumOs: "18.2",
};

/** 確かめ画面の目印（Rust の命令の名前・印の中だけ） */
export const DEVCHECK_MARKERS = ["mobile_dev_open_test_library", "mobile_dev_fault"];
/** 確かめ画面の目印（画面の側＝dist-mobile の JS） */
export const DEVCHECK_JS_MARKERS = ["mobile_dev_open_test_library", "startDevcheck"];

type Needle = { label: string; n: string; exact: boolean };

/** 探すもの。ホームは 3 つの書き方（\ / \\）で大小を問わない＋ユーザー名は大小を区別 */
export function needles(home = os.homedir(), user = os.userInfo().username): Needle[] {
  const list: Needle[] = [];
  const add = (label: string, s: string, exact: boolean) => {
    const n = exact ? s : s.toLowerCase();
    if (s && s.length >= 3 && !list.some((x) => x.n === n)) list.push({ label, n, exact });
  };
  add("ホームの絶対パス（\\ 区切り）", home.replace(/\//g, "\\"), false);
  add("ホームの絶対パス（/ 区切り）", home.replace(/\\/g, "/"), false);
  add("ホームの絶対パス（\\\\ 区切り）", home.replace(/[\\/]/g, "\\\\"), false);
  // JSON の書き方（/ を \/ にする）でも探す（第三者レビュー L4）
  add("ホームの絶対パス（JSON の \\/ 区切り）", home.replace(/[\\/]/g, "\\/"), false);
  add("ビルドした人のユーザー名（大小を区別）", user, true);
  return list;
}

/** zip（.ipa・.apk）の全部の項目（store と deflate）。V212: フォルダの項目も中身を空で返す（名前を走査するため＝F4） */
export function* zipEntries(buf: Buffer): Generator<{ name: string; data: Buffer }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip の終わりの印が無い");
  const n = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  if (n === 0xffff || cd === 0xffffffff) throw new Error("zip64 は未対応");
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("中央ディレクトリが壊れている");
    const method = buf.readUInt16LE(cd + 10);
    const csize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.toString("utf8", cd + 46, cd + 46 + nameLen);
    cd += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) {
      yield { name, data: Buffer.alloc(0) };
      continue;
    }
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`圧縮の方式 ${method} は未対応（項目 ${k + 1}）`);
    yield { name, data };
  }
}

export interface Hit {
  label: string;
  where: string;
}

/** 画面の字（dist-mobile）に入っている、公開の X のアカウント（設定の「権利に関するお問い合わせ」・7 言語の辞書）。ユーザー名と同じ綴りに
 *  なるので、ユーザー名を探すときだけ、この形（@<名前>_Proxy）を先に外す。名前はここに書かない（実行時に導出）。ほかの所の名前は今までどおり当たる */
export const PUBLIC_HANDLE = (user: string) => `@${user}_Proxy`;

/** V212 (F5): 中の zip をここまでの深さで展開する（.ipa・.apk の項目＝1 段目。それより深い zip は「見ていない」として赤） */
export const ZIP_MAX_DEPTH = 4;
/** 「見ていない」の印（hits に入る＝走査は通らない） */
export const UNSCANNED = "見ていない（";

/** V212 (F4): 項目の名前を調べる（名前にだけユーザー名やホームのパスがあっても当たる）。中身の展開はしない */
export function scanName(where: string, name: string, list: Needle[], hits: Hit[], allow: string[] = []): void {
  scanBytes(`${where}（項目の名前）`, Buffer.from(name, "utf8"), list, hits, ZIP_MAX_DEPTH + 1, allow, false);
}

/** 1 つのバイト列を調べる（中の zip も展開して）。allow は、探す前に外す公開の字（ユーザー名の針だけに効く）。
 *  V212: 中の zip の項目の名前も見る（F4）・深さを超えた zip と展開できなかった zip は「見ていない」として hits に足す（F5・黙って通さない）。
 *  nested=false は中を開かない（ファイル全体のバイト・項目の名前を見るとき） */
export function scanBytes(where: string, data: Buffer, list: Needle[], hits: Hit[], depth = 0, allow: string[] = [], nested = true): void {
  let raw = data.toString("latin1");
  const rawAll = raw;
  for (const a of allow) raw = raw.split(Buffer.from(a, "utf8").toString("latin1")).join("");
  const lower = rawAll.toLowerCase();
  for (const { label, n, exact } of list) {
    const hay = exact ? raw : lower;
    // ★針は UTF-8 のバイト列にしてから比べる（日本語などのホーム・ユーザー名でも当たる）。UTF-16 は LE と BE の両方（第三者レビュー L4）
    const u8 = Buffer.from(n, "utf8").toString("latin1");
    const le = Buffer.from(n, "utf16le");
    const be = Buffer.from(le).swap16();
    if (hay.includes(u8)) hits.push({ label, where });
    else if (hay.includes(le.toString("latin1")) || hay.includes(be.toString("latin1"))) hits.push({ label: `${label}（UTF-16）`, where });
  }
  if (nested && data.length > 4 && data.readUInt32LE(0) === 0x04034b50) {
    if (depth >= ZIP_MAX_DEPTH) {
      hits.push({ label: `${UNSCANNED}深さ ${ZIP_MAX_DEPTH} を超えた zip）`, where });
      return;
    }
    try {
      // 先に全部の項目を取り出す（途中で壊れていたら、どこまで見たかに関わらず「見ていない」）
      const entries = [...zipEntries(data)];
      for (const e of entries) {
        scanName(`${where} > ${e.name}`, e.name, list, hits, allow);
        scanBytes(`${where} > ${e.name}`, e.data, list, hits, depth + 1, allow);
      }
    } catch {
      // 中の zip として読めない（壊れている・zip64・知らない圧縮）。生のバイトは上で調べたが、中は見ていない＝赤
      hits.push({ label: `${UNSCANNED}展開できなかった zip）`, where });
    }
  }
}

/** V212: 配るファイル（.ipa・.apk・.aab）を調べる。項目の名前（F4）と中身（中の zip も・F5）と、ファイル全体のバイト（APK の v2・v3 の
 *  署名は zip の項目の外にある）。走査（scanTarget）と自己点検が同じこの道を通る */
export function scanArchive(label: string, buf: Buffer, list: Needle[], hits: Hit[], allow: string[] = []): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  for (const e of zipEntries(buf)) {
    entries++;
    bytes += e.data.length;
    scanName(e.name, e.name, list, hits, allow);
    scanBytes(e.name, e.data, list, hits, 0, allow);
  }
  scanBytes(`${label}（ファイル全体）`, buf, list, hits, 0, allow, false);
  return { entries, bytes };
}

/** 調べる中身（.ipa は展開・フォルダは全部のファイル） */
function* contents(target: string): Generator<{ name: string; data: Buffer }> {
  const st = statSync(target);
  if (st.isDirectory()) {
    const walk = function* (d: string): Generator<{ name: string; data: Buffer }> {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        const s = statSync(p);
        if (s.isDirectory()) yield* walk(p);
        else if (s.isFile()) yield { name: path.relative(target, p).split(path.sep).join("/"), data: readFileSync(p) };
      }
    };
    yield* walk(target);
  } else {
    yield* zipEntries(readFileSync(target));
  }
}

/** 走査。devcheck: true＝目印に当たること（陽性の対照）・false＝目印が 0 件・null＝見ない */
export function scanTarget(target: string, devcheck: boolean | null, markerList: string[] = DEVCHECK_MARKERS, allow: string[] = []): boolean {
  const list = needles();
  const markers: Needle[] = markerList.map((m) => ({ label: `確かめ画面の目印（${m}）`, n: m, exact: true }));
  const hits: Hit[] = [];
  const markerHits: Hit[] = [];
  let entries = 0;
  let bytes = 0;
  const st = statSync(target);
  if (st.isFile()) {
    // V212: .ipa・.apk・.aab は項目の名前・中身・ファイル全体を見る（scanArchive・自己点検と同じ道）
    const buf = readFileSync(target);
    ({ entries, bytes } = scanArchive(path.basename(target), buf, list, hits, allow));
    if (devcheck !== null) for (const e of zipEntries(buf)) scanBytes(e.name, e.data, markers, markerHits);
  } else {
    for (const e of contents(target)) {
      entries++;
      bytes += e.data.length;
      scanName(e.name, e.name, list, hits, allow);
      scanBytes(e.name, e.data, list, hits, 0, allow);
      if (devcheck !== null) scanBytes(e.name, e.data, markers, markerHits);
    }
  }
  const sha = st.isFile() ? createHash("sha256").update(readFileSync(target)).digest("hex") : "（フォルダ）";
  console.log(`走査: ${path.basename(target)} / ${st.isFile() ? `${st.size} バイト` : "フォルダ"} / SHA-256 ${sha}`);
  console.log(`  項目 ${entries} 個（展開して ${bytes} バイト）× 探すもの ${list.length} 種（＋UTF-16 の形）`);
  let ok = true;
  if (hits.length) {
    console.log(`  ✗ 見つかった: ${hits.length} 件（文字列は出さない）`);
    for (const x of hits.slice(0, 40)) console.log(`    - ${x.label} … ${x.where}`);
    ok = false;
  } else console.log("  ○ 0 件（ホームの絶対パス 3 形・ユーザー名・項目の名前・ファイル全体・見ていない zip なし）");
  if (devcheck === true) {
    const all = markerList.every((m) => markerHits.some((x) => x.label.includes(m)));
    console.log(`  確かめ画面の目印（陽性の対照・印あり）: ${all ? "○ 当たった" : "✗ 当たらない"}`);
    ok &&= all;
  } else if (devcheck === false) {
    console.log(`  確かめ画面の目印（印なし）: ${markerHits.length === 0 ? "○ 0 件" : `✗ ${markerHits.length} 件`}`);
    ok &&= markerHits.length === 0;
  }
  return ok;
}

/** 自己点検用の zip を作る */
export function makeZip(files: [string, Buffer, 0 | 8][], gap: Buffer = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const cds: Buffer[] = [];
  let off = 0;
  for (const [name, content, method] of files) {
    const nb = Buffer.from(name);
    const body = method === 8 ? deflateRawSync(content) : content;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, body);
    cds.push(ch, nb);
    off += lh.length + nb.length + body.length;
  }
  const cd = Buffer.concat(cds);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(files.length, 8);
  e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(off + gap.length, 16);
  // gap: 項目と中央ディレクトリの間に置くバイト（APK の署名の塊の位置。自己点検だけが使う）
  return Buffer.concat([...locals, gap, cd, e]);
}

/** 既知の陽性と陰性で、走査が効いていることを示す */
export function selftest(home = os.homedir(), user = os.userInfo().username): boolean {
  const list = needles(home, user);
  const pad = Buffer.alloc(5000, 0x41);
  const scan = (zip: Buffer) => {
    const hits: Hit[] = [];
    scanArchive("x.zip", zip, list, hits);
    return hits;
  };
  let ok = true;
  const say = (what: string, pass: boolean) => {
    console.log(`  ${what}: ${pass ? "○" : "✗"}`);
    ok &&= pass;
  };
  for (const { label, n, exact } of list) {
    const planted = Buffer.concat([pad, Buffer.from(`panic at ${exact ? n : n.toUpperCase()}\\src\\x.rs`, "latin1"), pad]);
    say(`既知の陽性（${label}・deflate）`, scan(makeZip([["Payload/x.app/x", planted, 8], ["a.txt", pad, 0]])).some((x) => x.label === label));
  }
  const first = list[0];
  say(`既知の陽性（UTF-16・${first.label}）`, scan(makeZip([["x.bin", Buffer.concat([pad, Buffer.from(first.n, "utf16le"), pad]), 8]])).some((x) => x.label === `${first.label}（UTF-16）`));
  const nested = makeZip([["inner.zip", makeZip([["y.so", Buffer.concat([pad, Buffer.from(first.n, "latin1")]), 8]]), 0]]);
  say(`既知の陽性（入れ子の zip・${first.label}）`, scan(nested).some((x) => x.label === first.label));
  // V212 (F4): 項目の名前にだけユーザー名・ホームのパスがある（中身は無関係）
  const userNeedle = list.find((x) => x.exact)!;
  say("既知の陽性（項目の名前にだけユーザー名・F4）", scan(makeZip([[`Payload/${user}.app/x`, pad, 8]])).some((x) => x.label === userNeedle.label && x.where.includes("項目の名前")));
  const slash = list.find((x) => x.label.includes("/ 区切り"))!;
  say("既知の陽性（入れ子の zip の項目の名前にだけホームのパス・F4）", scan(makeZip([["inner.zip", makeZip([[`${home.replace(/\\/g, "/")}/y.so`, pad, 8]]), 0]])).some((x) => x.label === slash.label && x.where.includes("項目の名前")));
  // V212 (F5): 3 段の deflate の zip に包んだホームのパス（V211b の再現）は当たる・深さを超えた zip と展開できない zip は「見ていない」で赤
  const wrap = (inner: Buffer, depth: number): Buffer => (depth === 0 ? inner : wrap(makeZip([[`l${depth}.zip`, inner, 8]]), depth - 1));
  const leaf = makeZip([["y.so", Buffer.concat([pad, Buffer.from(first.n, "latin1")]), 8]]);
  say("既知の陽性（3 段の deflate の zip の中のホームのパス・F5）", scan(wrap(leaf, 2)).some((x) => x.label === first.label));
  const deep = scan(wrap(leaf, ZIP_MAX_DEPTH + 1));
  say(`既知の陽性（深さ ${ZIP_MAX_DEPTH} を超えた zip は「見ていない」・F5）`, deep.some((x) => x.label.startsWith(UNSCANNED)));
  const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x7a)]);
  say("既知の陽性（展開できない中の zip は「見ていない」・F5）", scan(makeZip([["bad.zip", broken, 0]])).some((x) => x.label.startsWith(UNSCANNED)));
  // V212: zip の項目の外（APK の v2・v3 の署名の塊の位置＝項目と中央ディレクトリの間）のホームのパスは、ファイル全体のバイトで当たる
  say("既知の陽性（項目の外のバイト＝APK の署名の塊の位置）", scan(makeZip([["a.txt", pad, 0]], Buffer.concat([pad, Buffer.from(first.n, "latin1"), pad]))).some((x) => x.label === first.label && x.where.includes("ファイル全体")));
  say(`既知の陽性（UTF-16 BE・${first.label}）`, scan(makeZip([["x.bin", Buffer.concat([pad, Buffer.from(first.n, "utf16le").swap16(), pad]), 8]])).some((x) => x.label === `${first.label}（UTF-16）`));
  {
    // 日本語のホームとユーザー名（UTF-8 で入る）でも当たる
    const jl = needles("/Users/ユーザー", "ユーザー");
    const hits: Hit[] = [];
    for (const e of zipEntries(makeZip([["x", Buffer.concat([pad, Buffer.from("at /Users/ユーザー/src", "utf8")]), 8]]))) scanBytes(e.name, e.data, jl, hits);
    say("既知の陽性（日本語のホーム・UTF-8）", hits.length >= 2);
  }
  {
    // 公開の X のアカウントの形は、画面の字の走査で外す（陰性）。同じファイルのほかの所の名前は当たる（陽性）
    const al = [PUBLIC_HANDLE(user)];
    const h1: Hit[] = [];
    scanBytes("a.js", Buffer.from(`お問い合わせ → X ${PUBLIC_HANDLE(user)}`, "utf8"), list, h1, 0, al);
    const h2: Hit[] = [];
    scanBytes("a.js", Buffer.from(`X ${PUBLIC_HANDLE(user)} / build by ${user}`, "utf8"), list, h2, 0, al);
    say("陰性（公開の X のアカウントの形だけ）・陽性（同じ字の中のほかの所）", h1.length === 0 && h2.some((x) => x.label.includes("ユーザー名")));
  }
  say("陰性（remap のあとの形 ~/src/x.rs だけ）", scan(makeZip([["x.so", pad, 8], ["a.txt", Buffer.from("~/src/x.rs"), 0]])).length === 0);
  if (user.toLowerCase() !== user) {
    say("陰性（ユーザー名を小文字にした形＝識別子の綴り）", scan(makeZip([["Info.plist", Buffer.from(`com.${user.toLowerCase()}.memoanima`), 8]])).length === 0);
  } else console.log("  陰性（ユーザー名を小文字にした形）: ユーザー名が全部小文字なので試さない");
  // 確かめ画面の目印（陽性と陰性）
  const mk: Needle[] = DEVCHECK_MARKERS.map((m) => ({ label: m, n: m, exact: true }));
  const mh = (b: Buffer) => {
    const hits: Hit[] = [];
    for (const e of zipEntries(b)) scanBytes(e.name, e.data, mk, hits);
    return hits.length;
  };
  say("目印の陽性", mh(makeZip([["x", Buffer.from(DEVCHECK_MARKERS.join(" ")), 8]])) === DEVCHECK_MARKERS.length);
  say("目印の陰性", mh(makeZip([["x", Buffer.from("mobile_save_new mobile_resume"), 8]])) === 0);
  console.log(ok ? "自己点検: ○" : "自己点検: ✗");
  return ok;
}

// ---------------- iOS ----------------

/** チームの ID（APPLE_DEVELOPMENT_TEAM か、キーチェーンの開発用の証明書の OU）。出さない */
function teamId(): string {
  if (process.env.APPLE_DEVELOPMENT_TEAM) return process.env.APPLE_DEVELOPMENT_TEAM;
  const pem = spawnSync("security", ["find-certificate", "-a", "-c", "Apple Development", "-p"], { encoding: "utf8" }).stdout ?? "";
  const first = pem.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n";
  const subj = spawnSync("openssl", ["x509", "-noout", "-subject", "-nameopt", "multiline"], { input: first, encoding: "utf8" }).stdout ?? "";
  const m = /organizationalUnitName\s*=\s*([A-Z0-9]{10})/.exec(subj);
  if (!m) {
    console.error("チームの ID が分からない（APPLE_DEVELOPMENT_TEAM を渡す）");
    process.exit(1);
  }
  return m[1];
}

/** 子の出力からチームの ID とホームを伏せて流す */
function runMasked(cmd: string, a: string[], env: NodeJS.ProcessEnv, team: string): number {
  const r = spawnSync(cmd, a, { cwd: root, env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const mask = (s: string) => s.split(team).join("<TEAM>").split(os.homedir()).join("~");
  process.stdout.write(mask(r.stdout ?? "").split("\n").slice(-60).join("\n"));
  process.stderr.write(mask(r.stderr ?? "").split("\n").slice(-60).join("\n"));
  return r.status ?? 1;
}

function newest(dir: string, re: RegExp, wantDir: boolean): string | null {
  if (!existsSync(dir)) return null;
  let best: { p: string; t: number } | null = null;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      const st = statSync(p);
      if (re.test(n) && st.isDirectory() === wantDir && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
      if (st.isDirectory() && !(wantDir && re.test(n))) walk(p);
    }
  };
  walk(dir);
  return (best as { p: string } | null)?.p ?? null;
}

/** Info.plist（.ipa の中か .app のフォルダ）を JSON で読む（macOS の plutil） */
function infoPlist(target: string): Record<string, unknown> | null {
  let data: Buffer | null = null;
  if (statSync(target).isDirectory()) data = readFileSync(path.join(target, "Info.plist"));
  else for (const e of zipEntries(readFileSync(target))) if (/^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name)) data = e.data;
  if (!data) return null;
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: data });
  return r.status === 0 ? JSON.parse(r.stdout.toString("utf8")) : null;
}

/** Info.plist の値を確かめる（Bundle ID・版・ビルド番号・最低の OS・ファイル App・暗号・1 つの窓） */
export function checkInfo(info: Record<string, unknown>, buildNumber: string, version: string): string[] {
  const bad: string[] = [];
  const want = (k: string, v: unknown) => {
    if (JSON.stringify(info[k]) !== JSON.stringify(v)) bad.push(`${k} が ${JSON.stringify(info[k])}（期待 ${JSON.stringify(v)}）`);
  };
  want("CFBundleIdentifier", IOS_EXPECT.bundleId);
  want("CFBundleShortVersionString", version);
  want("CFBundleVersion", buildNumber);
  want("MinimumOSVersion", IOS_EXPECT.minimumOs);
  want("UIFileSharingEnabled", true);
  want("LSSupportsOpeningDocumentsInPlace", true);
  want("ITSAppUsesNonExemptEncryption", false);
  // 1 つの窓（決-7）: シーンを使う形なら 2 つ目の窓を開けない印・使わない形なら 2 つ目の窓は開けない（既定）
  const scene = info.UIApplicationSceneManifest as Record<string, unknown> | undefined;
  if (scene && scene.UIApplicationSupportsMultipleScenes !== false) bad.push("UIApplicationSupportsMultipleScenes が false でない");
  if ("UIRequiresFullScreen" in info) bad.push("UIRequiresFullScreen がある（他のアプリと並べられなくなる）");
  return bad;
}

function buildIos(buildNumber: string, devcheck: boolean, sim: boolean): void {
  const team = teamId();
  const gen = path.join(root, "src-tauri", "gen", "apple");
  if (!existsSync(gen)) {
    console.error("src-tauri/gen/apple が無い（先に ios-init）");
    process.exit(1);
  }
  if (!sim) {
    const exportOptions = path.join(gen, "ExportOptions.plist");
    if (spawnSync("plutil", ["-replace", "uploadSymbols", "-bool", "NO", exportOptions]).status !== 0) {
      console.error("ExportOptions.plist に uploadSymbols=NO を入れられない");
      process.exit(1);
    }
  }
  const iconSrc = path.join(root, "src-tauri", "icons", "ios");
  const iconDst = path.join(gen, "Assets.xcassets", "AppIcon.appiconset");
  const icons = readdirSync(iconSrc).filter((n) => n.endsWith(".png"));
  for (const n of icons) copyFileSync(path.join(iconSrc, n), path.join(iconDst, n));
  console.log(`アイコン: src-tauri/icons/ios の ${icons.length} 枚を Assets.xcassets に入れた`);
  const env: NodeJS.ProcessEnv = { ...process.env, APPLE_DEVELOPMENT_TEAM: team, CARGO_ENCODED_RUSTFLAGS: `--remap-path-prefix=${os.homedir()}=~` };
  delete env.RUSTFLAGS;
  if (devcheck) env.MEMOANIMA_MOBILE_DEVCHECK = "1";
  else delete env.MEMOANIMA_MOBILE_DEVCHECK;
  const config = JSON.stringify({ bundle: { iOS: { bundleVersion: buildNumber } } });
  const a = ["tauri", "ios", "build", "--ci", "--config", config];
  if (sim) a.push("--target", "aarch64-sim");
  else a.push("--export-method", "app-store-connect");
  if (devcheck) a.push("--features", "mobile-devcheck");
  console.log(`== npx tauri ios build（${sim ? "シミュレーター" : "TestFlight 用"}・ビルド番号 ${buildNumber}・確かめ画面の印 ${devcheck ? "あり" : "なし"}・remap は CARGO_ENCODED_RUSTFLAGS）==`);
  const started = Date.now();
  const status = runMasked("npx", a, env, team);
  if (status !== 0) {
    console.error(`ビルドが失敗しました（終了コード ${status}）`);
    process.exit(1);
  }
  const out = sim ? newest(path.join(gen, "build"), /\.app$/, true) : newest(path.join(gen, "build"), /\.ipa$/, false);
  if (!out || statSync(sim ? path.join(out, "Info.plist") : out).mtimeMs < started) {
    console.error(out ? "できたものが古い（この回のビルドで作られていない）" : "できたものが見つからない");
    process.exit(1);
  }
  console.log(`できたもの: ${path.relative(root, out)}`);
  const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version as string;
  const info = infoPlist(out);
  if (!info) {
    console.error("Info.plist が読めない");
    process.exit(3);
  }
  const bad = checkInfo(info, buildNumber, version);
  console.log(`  Bundle ID ${String(info.CFBundleIdentifier)}・版 ${String(info.CFBundleShortVersionString)}・ビルド番号 ${String(info.CFBundleVersion)}・最低の iOS ${String(info.MinimumOSVersion)}・UIDeviceFamily ${JSON.stringify(info.UIDeviceFamily)}`);
  if (bad.length) {
    for (const b of bad) console.error(`  ✗ ${b}`);
    process.exit(3);
  }
  if (!scanTarget(out, devcheck)) process.exit(2);
  // ★画面のファイル（dist-mobile）は実行ファイルの中で縮めて入るので、組み立てる前の形で同じ走査をする（ホームのパス・確かめ画面の目印＝
  //  第三者レビュー M3。印なしのビルドに画面の側の確かめ画面が入っていないことも見る）
  console.log("画面のファイル（dist-mobile・実行ファイルの中で縮めて入る）:");
  if (!scanTarget(path.join(root, "dist-mobile"), devcheck, DEVCHECK_JS_MARKERS, [PUBLIC_HANDLE(os.userInfo().username)])) process.exit(2);
}

function iosInit(): void {
  const team = teamId();
  const env: NodeJS.ProcessEnv = { ...process.env, APPLE_DEVELOPMENT_TEAM: team };
  console.log("== npx tauri ios init --ci（XcodeGen を PATH に置いてから）==");
  process.exit(runMasked("npx", ["tauri", "ios", "init", "--ci"], env, team));
}

// ---------------- Android（V212・M-1c） ----------------

/** 期待する値（tauri.conf.json・tauri.android.conf.json と同じ。ずれたら止まる）。版は tauri.conf.json から・versionCode は引数から */
export const ANDROID_EXPECT = {
  packageName: "com.arcana.memoanima",
  minSdk: 29,
  /** 対象の API の下限（ひな形〔CLI 2.12.4〕は 37。36 以上ならよい＝要件 §6-1） */
  targetSdkAtLeast: 36,
  /** 1 つの作業（決-7）: android:launchMode の値（standard=0・singleTop=1・singleTask=2・singleInstance=3） */
  launchMode: 2,
};

/** ★Tauri の CLI（cargo-mobile2 0.22.5）が CARGO_TARGET_<triple>_RUSTFLAGS で渡す Android のリンクの指定（CLI 2.12.4 の実行ファイルの中の字で
 *  確かめた）。CARGO_ENCODED_RUSTFLAGS はそれより優先されるので、一緒に入れないと落ちる（M-0 §13-3 の ⚠） */
export const ANDROID_LINK_ARGS = ["-Clink-arg=-landroid", "-Clink-arg=-llog", "-Clink-arg=-lOpenSLES"];

/** Android のビルドに渡す CARGO_ENCODED_RUSTFLAGS（区切りは 0x1f）。ホームは \ と / の両方の形で ~ に置き換える＋リンクの指定 */
export function androidRustflags(home = os.homedir()): string {
  const forms = [...new Set([home, home.replace(/\\/g, "/")])];
  return [...forms.map((h) => `--remap-path-prefix=${h}=~`), ...ANDROID_LINK_ARGS].join("\x1f");
}

/** 版の番号で比べて一番新しいフォルダ（NDK・Build-Tools） */
function newestVersionDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const key = (n: string) => n.split(/[.-]/).map((x) => Number(x) || 0);
  const names = readdirSync(dir).filter((n) => /^\d/.test(n) && statSync(path.join(dir, n)).isDirectory());
  names.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (ka[i] ?? 0) - (kb[i] ?? 0);
    return 0;
  });
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

interface AndroidTools {
  java: string;
  sdk: string;
  ndk: string;
  buildTools: string;
  env: NodeJS.ProcessEnv;
}

/** ★JAVA_HOME・ANDROID_HOME・NDK_HOME を見つけて、**子のプロセスにだけ**渡す（Windows の環境変数とレジストリは書かない）。
 *  Android Studio の jbr・%LOCALAPPDATA%\Android\Sdk・その下の ndk の一番新しい版を、環境変数（ProgramFiles・LOCALAPPDATA・HOME）から組む。
 *  パスはこのファイルに書かない。見つからなければ止める（作者に聞く） */
export function androidTools(): AndroidTools {
  const e = process.env;
  const exe = process.platform === "win32" ? ".exe" : "";
  const ok = (p: string | undefined, probe: string): p is string => !!p && existsSync(path.join(p, probe));
  const javaCands = [e.JAVA_HOME, e.ProgramFiles && path.join(e.ProgramFiles, "Android", "Android Studio", "jbr"), process.platform === "darwin" ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home" : undefined];
  const sdkCands = [e.ANDROID_HOME, e.ANDROID_SDK_ROOT, e.LOCALAPPDATA && path.join(e.LOCALAPPDATA, "Android", "Sdk"), e.HOME && path.join(e.HOME, process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk")];
  const java = javaCands.find((p) => ok(p || undefined, path.join("bin", `java${exe}`))) || undefined;
  const sdk = sdkCands.find((p) => ok(p || undefined, "platform-tools")) || undefined;
  const ndk = ok(e.NDK_HOME, "source.properties") ? e.NDK_HOME : sdk ? newestVersionDir(path.join(sdk, "ndk")) ?? undefined : undefined;
  const buildTools = sdk ? newestVersionDir(path.join(sdk, "build-tools")) ?? undefined : undefined;
  if (!java || !sdk || !ndk || !buildTools) {
    const missing = [!java && "Android Studio の jbr（JAVA_HOME）", !sdk && "Android SDK（ANDROID_HOME）", !ndk && "NDK（NDK_HOME）", !buildTools && "Build-Tools"].filter(Boolean);
    console.error(`見つからない: ${missing.join("・")}（Android Studio で入れたか、作者に聞く）`);
    process.exit(1);
  }
  const env: NodeJS.ProcessEnv = { ...e, JAVA_HOME: java, ANDROID_HOME: sdk, NDK_HOME: ndk };
  // 子の PATH の先頭に jbr の bin（Gradle と keytool が同じ Java を使う）
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [path.join(java, "bin"), env[pathKey] ?? ""].join(path.delimiter);
  return { java, sdk, ndk, buildTools, env };
}

/** 道具の版を出す（パスは出さない＝NDK と Build-Tools は版の番号だけ） */
function describeTools(t: AndroidTools): void {
  const jv = spawnSync(path.join(t.java, "bin", "java"), ["-version"], { encoding: "utf8" });
  console.log(`  Java: ${(jv.stderr || jv.stdout || "").split("\n")[0].trim()}`);
  console.log(`  NDK: ${path.basename(t.ndk)}・Build-Tools: ${path.basename(t.buildTools)}`);
}

/** 子の出力からホームを伏せて流す（最後の 60 行）。Windows の npx は .cmd なので shell を通す（引数に空白を含めない） */
function runAndroid(cmd: string, a: string[], env: NodeJS.ProcessEnv, cwd = root): number {
  const r = spawnSync(cmd, a, { cwd, env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, shell: process.platform === "win32" });
  const h = os.homedir();
  // \ ・ / ・ \\（JSON や Rust の Debug の形）の 3 つの書き方を伏せる
  const mask = (s: string) => [h, h.replace(/\\/g, "/"), h.replace(/\\/g, "\\\\")].reduce((acc, f) => acc.split(f).join("~"), s);
  process.stdout.write(mask(r.stdout ?? "").split("\n").slice(-60).join("\n"));
  process.stderr.write(mask(r.stderr ?? "").split("\n").slice(-60).join("\n"));
  return r.status ?? 1;
}

/** ★`tauri android init` のあとで台本が直す所（gen/android はコミットしないので、毎回ここで同じものにする）。
 *  アイコン（src-tauri/icons/android のメモアニマの絵で、ひな形の Tauri のロゴを上書き）。それ以外のひな形の値は変えない
 *  （targetSdk 37・launchMode singleTask・allowBackup はひな形のまま＝確かめるだけ） */
export function androidPostInit(gen = path.join(root, "src-tauri", "gen", "android")): string[] {
  const res = path.join(gen, "app", "src", "main", "res");
  const src = path.join(root, "src-tauri", "icons", "android");
  const done: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = path.relative(src, p);
        const to = path.join(res, rel);
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(p, to);
        done.push(rel.split(path.sep).join("/"));
      }
    }
  };
  walk(src);
  return done;
}

/** ひな形の値を読む（app/build.gradle.kts の targetSdk・compileSdk・minSdk と AndroidManifest.xml の launchMode・allowBackup・権限） */
export function androidTemplateFacts(gen = path.join(root, "src-tauri", "gen", "android")): Record<string, string | null> {
  const gradle = readFileSync(path.join(gen, "app", "build.gradle.kts"), "utf8");
  const manifest = readFileSync(path.join(gen, "app", "src", "main", "AndroidManifest.xml"), "utf8");
  const g = (re: RegExp) => re.exec(gradle)?.[1] ?? null;
  const m = (re: RegExp) => re.exec(manifest)?.[1] ?? null;
  return {
    compileSdk: g(/compileSdk\s*=\s*(\d+)/),
    targetSdk: g(/targetSdk\s*=\s*(\d+)/),
    minSdk: g(/minSdk\s*=\s*(\d+)/),
    launchMode: m(/android:launchMode="([^"]+)"/),
    allowBackup: m(/android:allowBackup="([^"]+)"/),
    permissions: [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((x) => x[1]).join(",") || null,
  };
}

function androidInit(): void {
  const t = androidTools();
  describeTools(t);
  console.log("== npx tauri android init --ci --skip-targets-install（JAVA_HOME・ANDROID_HOME・NDK_HOME は子のプロセスにだけ）==");
  const st = runAndroid("npx", ["tauri", "android", "init", "--ci", "--skip-targets-install"], t.env);
  if (st !== 0) process.exit(st);
  const icons = androidPostInit();
  console.log(`\nアイコン: src-tauri/icons/android の ${icons.length} 個を res/ に入れた`);
  console.log(`ひな形: ${JSON.stringify(androidTemplateFacts())}`);
}

/** APK の Manifest（aapt2 dump badging と xmltree）から読んだ値 */
export interface ApkManifest {
  packageName: string | null;
  versionCode: string | null;
  versionName: string | null;
  minSdk: number | null;
  targetSdk: number | null;
  launchMode: number | null;
  permissions: string[];
  allowBackup: string | null;
  nativeCode: string[];
}

/** aapt2 の出力を読む（純関数・検査が見本で叩く） */
export function parseApkManifest(badging: string, xmltree: string): ApkManifest {
  const pk = /^package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/m.exec(badging);
  const num = (re: RegExp) => {
    const m = re.exec(badging);
    return m ? Number(m[1]) : null;
  };
  // launchMode は最初の activity のもの（Tauri のひな形は MainActivity の 1 つだけ）
  const act = xmltree.indexOf("E: activity");
  // 属性の頭は aapt2 の版で `android:` か名前空間の URL（36.0.0 は URL）
  const ns = "A: (?:android|http://schemas\\.android\\.com/apk/res/android):";
  const lm = act >= 0 ? new RegExp(`${ns}launchMode\\([^)]*\\)=(\\d+)`).exec(xmltree.slice(act)) : null;
  const ab = new RegExp(`${ns}allowBackup\\([^)]*\\)=(?:\\(type 0x12\\))?0x(\\w+)`).exec(xmltree);
  return {
    packageName: pk?.[1] ?? null,
    versionCode: pk?.[2] ?? null,
    versionName: pk?.[3] ?? null,
    minSdk: num(/^(?:sdkVersion|minSdkVersion):'(\d+)'/m),
    targetSdk: num(/^targetSdkVersion:'(\d+)'/m),
    launchMode: lm ? Number(lm[1]) : null,
    permissions: [...badging.matchAll(/^uses-permission: name='([^']+)'/gm)].map((m) => m[1]),
    allowBackup: ab ? (/^0+$/.test(ab[1]) ? "false" : "true") : null,
    nativeCode: (/^native-code: (.*)$/m.exec(badging)?.[1] ?? "").split(/\s+/).map((x) => x.replace(/'/g, "")).filter(Boolean),
  };
}

/** Manifest の値を確かめる（package・版・versionCode・最小と対象の API・1 つの作業・x86_64 と arm64 が入っているか） */
export function checkApkManifest(m: ApkManifest, versionCode: string, version: string, minSdk = ANDROID_EXPECT.minSdk): string[] {
  const bad: string[] = [];
  if (m.packageName !== ANDROID_EXPECT.packageName) bad.push(`package が ${m.packageName}（期待 ${ANDROID_EXPECT.packageName}）`);
  if (m.versionName !== version) bad.push(`versionName が ${m.versionName}（期待 ${version}）`);
  if (m.versionCode !== versionCode) bad.push(`versionCode が ${m.versionCode}（期待 ${versionCode}）`);
  if (m.minSdk !== minSdk) bad.push(`minSdk が ${m.minSdk}（期待 ${minSdk}）`);
  if (m.targetSdk === null || m.targetSdk < ANDROID_EXPECT.targetSdkAtLeast) bad.push(`targetSdk が ${m.targetSdk}（期待 ${ANDROID_EXPECT.targetSdkAtLeast} 以上）`);
  if (m.launchMode !== ANDROID_EXPECT.launchMode) bad.push(`launchMode が ${m.launchMode}（期待 ${ANDROID_EXPECT.launchMode}＝singleTask）`);
  if (!m.nativeCode.includes("x86_64")) bad.push(`native-code に x86_64 が無い（${m.nativeCode.join(" ")}）`);
  if (!m.nativeCode.includes("arm64-v8a")) bad.push(`native-code に arm64-v8a が無い（${m.nativeCode.join(" ")}）`);
  return bad;
}

/** 試験の鍵の置き場（リポジトリの外・ホームの下）。使い捨て＝Google Play に出す鍵ではない */
function testKeyDir(): string {
  return path.join(os.homedir(), ".memoanima-test-keys");
}

/** 試験の鍵のパスワード（環境変数 MEMOANIMA_TEST_KEY_PASS か、鍵の隣のファイル）。出さない */
function testKeyPass(): string {
  if (process.env.MEMOANIMA_TEST_KEY_PASS) return process.env.MEMOANIMA_TEST_KEY_PASS;
  const f = path.join(testKeyDir(), "memoanima-test.pass");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

/** 試験の鍵を作る（無ければ）。名義は CN=MemoAnima Test。パスワードは乱数で、鍵の隣のファイルにだけ置く（環境変数で keytool に渡す） */
function ensureTestKey(t: AndroidTools): string {
  const dir = testKeyDir();
  const ks = path.join(dir, "memoanima-test.jks");
  if (existsSync(ks)) return ks;
  mkdirSync(dir, { recursive: true });
  const pass = testKeyPass() || randomBytes(24).toString("base64url");
  if (!process.env.MEMOANIMA_TEST_KEY_PASS) writeFileSync(path.join(dir, "memoanima-test.pass"), pass, { mode: 0o600 });
  const env = { ...t.env, MEMOANIMA_TEST_KEY_PASS: pass };
  const r = spawnSync(
    path.join(t.java, "bin", "keytool"),
    ["-genkeypair", "-keystore", ks, "-alias", "memoanima-test", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=MemoAnima Test", "-storepass:env", "MEMOANIMA_TEST_KEY_PASS", "-keypass:env", "MEMOANIMA_TEST_KEY_PASS"],
    { env, encoding: "utf8" }
  );
  if (r.status !== 0) {
    console.error("試験の鍵を作れなかった");
    process.exit(1);
  }
  console.log("試験の鍵を作った（ホームの下の .memoanima-test-keys・名義 CN=MemoAnima Test・パスワードは出さない）");
  return ks;
}

/** Build-Tools の道具（Windows は apksigner だけ .bat・ほかは .exe） */
function buildTool(t: AndroidTools, n: string): string {
  return path.join(t.buildTools, process.platform === "win32" ? (n === "apksigner" ? `${n}.bat` : `${n}.exe`) : n);
}

function buildAndroid(versionCode: string, devcheck: boolean, debug: boolean): void {
  const t = androidTools();
  describeTools(t);
  const gen = path.join(root, "src-tauri", "gen", "android");
  if (!existsSync(gen)) {
    console.error("src-tauri/gen/android が無い（先に android-init）");
    process.exit(1);
  }
  const icons = androidPostInit(gen);
  console.log(`アイコン: src-tauri/icons/android の ${icons.length} 個を res/ に入れた`);
  const env: NodeJS.ProcessEnv = { ...t.env, CARGO_ENCODED_RUSTFLAGS: androidRustflags() };
  delete env.RUSTFLAGS;
  if (devcheck) env.MEMOANIMA_MOBILE_DEVCHECK = "1";
  else delete env.MEMOANIMA_MOBILE_DEVCHECK;
  // versionCode は設定のファイルで渡す（shell を通すので JSON を引数に書かない）。ファイルは使い捨て
  const cfgDir = mkdtempSync(path.join(os.tmpdir(), "memoanima-android-"));
  const cfg = path.join(cfgDir, "versioncode.json");
  writeFileSync(cfg, JSON.stringify({ bundle: { android: { versionCode: Number(versionCode) } } }));
  // エミュレーター（x86_64）と配る形（arm64）を 1 つの APK に入れる
  const a = ["tauri", "android", "build", "--ci", "--apk", "--config", cfg, "--target", "x86_64", "--target", "aarch64"];
  if (debug) a.push("--debug");
  if (devcheck) a.push("--features", "mobile-devcheck");
  console.log(`== npx tauri android build（${debug ? "debug" : "release"}・versionCode ${versionCode}・x86_64＋aarch64・確かめ画面の印 ${devcheck ? "あり" : "なし"}・remap とリンクの指定は CARGO_ENCODED_RUSTFLAGS）==`);
  const started = Date.now();
  const status = runAndroid("npx", a, env);
  rmSync(cfgDir, { recursive: true, force: true });
  if (status !== 0) {
    console.error(`ビルドが失敗しました（終了コード ${status}）`);
    process.exit(1);
  }
  const built = newest(path.join(gen, "app", "build", "outputs", "apk"), /\.apk$/, false);
  if (!built || statSync(built).mtimeMs < started) {
    console.error(built ? "できたものが古い（この回のビルドで作られていない）" : "できたものが見つからない");
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version as string;
  const dest = path.join(os.homedir(), "MemoAnima-apk");
  mkdirSync(dest, { recursive: true });
  const out = path.join(dest, `MemoAnima-${version}-vc${versionCode}${devcheck ? "-devcheck" : ""}${debug ? "-debug" : ""}.apk`);
  if (debug) copyFileSync(built, out);
  else {
    // release: リポジトリの外の試験の鍵で署名（パスワードは環境変数で apksigner に渡す・出さない）
    const ks = ensureTestKey(t);
    const senv = { ...t.env, MEMOANIMA_TEST_KEY_PASS: testKeyPass() };
    const aligned = `${out}.aligned`;
    if (spawnSync(buildTool(t, "zipalign"), ["-f", "-p", "4", built, aligned], { encoding: "utf8" }).status !== 0) {
      console.error("zipalign が失敗した");
      process.exit(1);
    }
    const sg = spawnSync(buildTool(t, "apksigner"), ["sign", "--ks", ks, "--ks-key-alias", "memoanima-test", "--ks-pass", "env:MEMOANIMA_TEST_KEY_PASS", "--key-pass", "env:MEMOANIMA_TEST_KEY_PASS", "--out", out, aligned], { env: senv, encoding: "utf8", shell: process.platform === "win32" });
    rmSync(aligned, { force: true });
    if (sg.status !== 0) {
      console.error("apksigner sign が失敗した");
      process.exit(1);
    }
  }
  console.log(`できたもの: ~/${path.relative(os.homedir(), out).split(path.sep).join("/")}`);
  checkApk(t, out, versionCode, devcheck, debug);
}

/** できた APK を確かめる（署名・Manifest・.so の記号・走査）。`android-check` からも呼ぶ */
function checkApk(t: AndroidTools, out: string, versionCode: string, devcheck: boolean, debug: boolean): void {
  const version = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version as string;
  // 署名の確かめ（release だけ・名義は出す＝本名を入れていないこと）
  if (!debug) {
    const v = spawnSync(buildTool(t, "apksigner"), ["verify", "--verbose", "--print-certs", out], { env: t.env, encoding: "utf8", shell: process.platform === "win32" });
    const lines = (v.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => /^Verified using|certificate DN|^Number of signers/.test(l));
    for (const l of lines) console.log(`  ${l}`);
    if (v.status !== 0 || !lines.some((l) => /certificate DN: CN=MemoAnima Test$/.test(l))) {
      console.error("  ✗ apksigner verify が通らない・名義が CN=MemoAnima Test でない");
      process.exit(3);
    }
  }
  // Manifest
  const badging = spawnSync(buildTool(t, "aapt2"), ["dump", "badging", out], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout ?? "";
  const xml = spawnSync(buildTool(t, "aapt2"), ["dump", "xmltree", "--file", "AndroidManifest.xml", out], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout ?? "";
  const mf = parseApkManifest(badging, xml);
  console.log(`  Manifest: ${JSON.stringify(mf)}`);
  const minSdk = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.android.conf.json"), "utf8")).bundle.android.minSdkVersion as number;
  const bad = checkApkManifest(mf, versionCode, version, minSdk);
  if (bad.length) {
    for (const b of bad) console.error(`  ✗ ${b}`);
    process.exit(3);
  }
  // .so の未定義の記号（API 30 からの bionic の関数が残っていないか＝最小の API 29 の端末で読み込めるか）と、リンクの指定（NEEDED）
  checkSo(t, out, minSdk);
  if (!scanTarget(out, debug ? null : devcheck)) process.exit(2);
  console.log("画面のファイル（dist-mobile・APK の中で縮めて入る）:");
  if (!scanTarget(path.join(root, "dist-mobile"), devcheck, DEVCHECK_JS_MARKERS, [PUBLIC_HANDLE(os.userInfo().username)])) process.exit(2);
}

/** bionic で API 30 から入った関数（最小の API が 29 なら .so の未定義の記号に残してはいけない） */
export const BIONIC_API30 = ["renameat2"];

/** llvm-readelf --dyn-syms の出力から未定義の記号を拾う（純関数） */
export function undefinedSymbols(dynSyms: string): string[] {
  const out: string[] = [];
  for (const l of dynSyms.split("\n")) {
    const m = /\sUND\s+(\S+)\s*$/.exec(l);
    if (m) out.push(m[1].replace(/@.*$/, ""));
  }
  return out;
}

function checkSo(t: AndroidTools, apk: string, minSdk: number): void {
  const prebuilt = path.join(t.ndk, "toolchains", "llvm", "prebuilt");
  const host = existsSync(prebuilt) ? readdirSync(prebuilt)[0] : "";
  const readelf = path.join(prebuilt, host, "bin", `llvm-readelf${process.platform === "win32" ? ".exe" : ""}`);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "memoanima-so-"));
  try {
    let seen = 0;
    for (const e of zipEntries(readFileSync(apk))) {
      const m = /^lib\/([^/]+)\/(libanimemo_lib\.so)$/.exec(e.name);
      if (!m) continue;
      seen++;
      const f = path.join(tmp, `${m[1]}.so`);
      writeFileSync(f, e.data);
      const und = undefinedSymbols(spawnSync(readelf, ["--dyn-syms", "--wide", f], { encoding: "utf8", maxBuffer: 256 << 20 }).stdout ?? "");
      const needed = [...(spawnSync(readelf, ["-d", f], { encoding: "utf8" }).stdout ?? "").matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((x) => x[1]);
      const late = BIONIC_API30.filter((s) => und.includes(s));
      console.log(`  ${m[1]}: 未定義の記号 ${und.length} 個・API 30 からの関数 ${late.length ? late.join(",") : "なし"}・NEEDED ${needed.join(",")}`);
      if (und.length === 0) {
        console.error("  ✗ 未定義の記号が 1 つも読めない（llvm-readelf が動いていない）");
        process.exit(3);
      }
      if (minSdk < 30 && late.length) {
        console.error(`  ✗ 最小の API が ${minSdk} なのに、API 30 からの関数（${late.join(",")}）を未定義の記号に持つ（API 29 の端末で読み込めない）`);
        process.exit(3);
      }
    }
    if (seen === 0) {
      console.error("  ✗ APK に libanimemo_lib.so が無い");
      process.exit(3);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(): void {
  const [cmd, arg] = args;
  const flag = (f: string) => args.includes(f);
  if (cmd === "ios-init") return iosInit();
  if (cmd === "ios") {
    if (!/^[1-9]\d{0,8}$/.test(arg ?? "")) {
      console.log("usage: npx tsx scripts/mobile_build.ts ios <ビルド番号> [--devcheck] [--sim]（番号は 1 以上の整数・上げるたびに 1 つ上げる）");
      process.exit(1);
    }
    return buildIos(arg, flag("--devcheck"), flag("--sim"));
  }
  if (cmd === "android-init") return androidInit();
  if (cmd === "android") {
    if (!/^[1-9]\d{0,8}$/.test(arg ?? "")) {
      console.log("usage: npx tsx scripts/mobile_build.ts android <versionCode> [--devcheck] [--debug]（1 以上の整数・上げるたびに 1 つ上げる）");
      process.exit(1);
    }
    return buildAndroid(arg, flag("--devcheck"), flag("--debug"));
  }
  if (cmd === "android-check" && arg && /^[1-9]\d{0,8}$/.test(args[2] ?? "")) {
    // できた APK を確かめ直す（ビルドし直さずに）: android-check <apk> <versionCode> [--devcheck] [--debug]
    const t = androidTools();
    return checkApk(t, path.resolve(arg), args[2], flag("--devcheck"), flag("--debug"));
  }
  if (cmd === "scan" && arg === "--selftest") process.exit(selftest() ? 0 : 1);
  if (cmd === "scan" && arg) {
    const t = path.resolve(arg);
    // .ipa と .app は Rust の目印・画面のフォルダ（dist-mobile）は画面の目印
    const front = statSync(t).isDirectory() && !t.endsWith(".app");
    process.exit(scanTarget(t, flag("--devcheck") ? true : flag("--no-devcheck") ? false : null, front ? DEVCHECK_JS_MARKERS : DEVCHECK_MARKERS, front ? [PUBLIC_HANDLE(os.userInfo().username)] : []) ? 0 : 2);
  }
  console.log("usage: ios-init | ios <ビルド番号> [--devcheck] [--sim] | android-init | android <versionCode> [--devcheck] [--debug] | scan <file|folder> [--devcheck|--no-devcheck] | scan --selftest");
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
