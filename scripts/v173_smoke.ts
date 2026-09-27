// V173（取り込みの失敗を記録する ＋ クラウド経由の改名「.gz」からの復帰）の回帰ゲート。引数不要:
//   npx tsx scripts/v173_smoke.ts
//
// ★この回でいちばん怖いのは3つ:
//   ① **失敗が黙って消える道が戻る**——`res.errors` を誰も読まない・catch に束縛が無い。
//      作者の Mac で「.kwz が一部開けない」を 2 回ログに取って、取り込みの失敗の行が **1 行も無かった**のがこれ
//      → [S-1][S-2][S-3] が 4 か所を一覧で固定。反証 1z が「束縛を外した写し」を赤にする
//   ② **改名（元に戻せない操作）が、条件を1つ落としたまま走る**——上書きしてしまえば作品は戻らない
//      → [S-6] が `exists()` の分岐を、[S-9] が「.gz で終わる・対の実体が無い・先頭 1f 8b」の3条件を固定。反証 3z
//   ③ **`.gz` を「消してよい付属物」に足してしまう**——作品 0 件に見えるアルバムと一緒に消える
//      → [S-5] が `is_app_sidecar` に `.gz` が**無い**ことを固定。反証 2z
//
// [S-1]  src/** に res.errors を読む箇所がある
// [S-2]  importDroppedProjects の catch が束縛付きで、その中に logError がある
// [S-3]  失敗を扱う 4 か所すべてに logError("import" がある（場所を一覧で固定）
// [S-4]  probe_project_file がファイル全体を読んでいない（read_to_end を使わない）
// [S-5]  ★is_app_sidecar に .gz が入っていない（delete_album の安全性）
// [S-6]  fix_renamed_projects に上書きしない分岐がある（exists チェック）
// [S-7]  i18n 7 ファイルのキー数一致・新キーが 7 言語そろっている
// [S-8]  反証 1z/2z/3z
// [S-9]  scan_renamed_projects の 3 条件（.gz サフィックス・対の実体なし・先頭 1f 8b）
// [S-10] 名前の付け替えを Node で叩く（foo.memoanima.gz → foo。**foo.memoanima.gz.memoanima にならない**）
// [S-11] handleDroppedPaths は gzip だけでは通さない（名前に .memoanima/.animemo が要る）
// [S-12] 3 本の Rust コマンドが invoke_handler に登録されている
// [S-13] 壊すなリスト: is_project_ext / is_work_file / PROJECT_EXT の意味を変えていない
// [S-14] 走査（scan_library）は従来どおり拡張子で判定（中身を覗きにいかない）
import fs from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
/** 行コメント・ブロックコメントを落とす（自分の説明文に検査が当たらないように） */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/[^\n"'`]*$/gm, "");
/** Rust の行コメント（`///` と `//`）を落とす */
const stripRs = (s: string) => s.replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/[^\n"]*$/gm, "");

const mainRaw = read("src/main.ts");
const main = strip(mainRaw);
const libRaw = read("src/library.ts");
const libTs = strip(libRaw);
const pclibRaw = read("src-tauri/src/pclib.rs");
const pclib = stripRs(pclibRaw);
const librs = stripRs(read("src-tauri/src/lib.rs"));

const LANGS = ["ja", "en", "es", "ko", "pt-BR", "zh-Hans", "zh-Hant"];
const keysOf = (src: string): string[] => [...src.matchAll(/^\s+"([a-zA-Z0-9.\-_]+)":/gm)].map((m) => m[1]);

/** TS の top-level 関数／メソッドの本体（`name(` から、同じ字下げの行頭 `}` まで）。
 *
 *  ⚠ V173b で見つけた穴: 字下げを `\s*` で取ると**改行まで飲む**ので、定義の前に空行がある
 *   top-level 関数（`async function openEditorWithNote(`）で `indent` が `"\n\n"` になり、
 *   終わりの目印が見つからず**本体がファイル末尾まで広がる**＝検査が黙る。横の空白だけを取る。 */
function fnBody(src: string, name: string): string {
  const re = new RegExp(`\\n([ \\t]*)(?:export )?(?:private |public )?(?:async )?(?:function )?${name}\\s*\\([^)]*\\)[^{]*\\{`);
  const m = re.exec(src);
  if (!m) return "";
  const indent = m[1];
  const start = m.index + m[0].length;
  const end = src.indexOf(`\n${indent}}`, start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}
/** Rust の関数本体（`fn name(` から次の行頭 `}` まで） */
function rsFn(src: string, name: string): string {
  const re = new RegExp(`\\n(?:pub )?fn ${name}\\s*[（(]`);
  const m = re.exec(src);
  if (!m) return "";
  const start = m.index + m[0].length;
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

// ================= [S-1] res.errors を読む箇所がある =================
const checkS1 = (src: string): number =>
  [...src.matchAll(/\b(?:res|result)\.errors\b/g)].length;
{
  const n = checkS1(libTs) + checkS1(main);
  check("[S-1] ★一括取り込みの res.errors を読む箇所がある（0 件なら A-66 の逆戻り）", n > 0, `${n} 件`);
  // 読んだだけで捨てていないこと: 同じ関数の中で logError まで届いている
  const b = fnBody(libTs, "importFolder");
  check("[S-1] importFolder の中で errors を 1 件 1 行ログへ流している", b !== "" && /\.errors\b/.test(b) && /logError(?:\?\.)?\("import"/.test(b), b === "" ? "importFolder が見つからない" : "");
}

// ================= [S-2] importDroppedProjects の catch は束縛付き =================
// ★「失敗を扱う catch」だけを見る。同じ関数にある**索引が読めないときの catch**（黙って続けるのが正しい・
//  トーストもログも出さない）は対象外。代わりに「**束縛の無い catch が失敗を握り潰していない**」
//  ——束縛なしの catch にトーストやログがあれば赤——を足して、抜け道を塞ぐ。
const catchBlocks = (b: string): { bound: boolean; body: string }[] => {
  const out: { bound: boolean; body: string }[] = [];
  const re = /\}\s*catch\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\)\s*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(b))) {
    // 対応する `}` まで（この本体の中の括弧の釣り合いで数える）
    let depth = 1;
    let i = re.lastIndex;
    for (; i < b.length && depth > 0; i++) {
      if (b[i] === "{") depth++;
      else if (b[i] === "}") depth--;
    }
    out.push({ bound: !!m[1], body: b.slice(re.lastIndex, i - 1) });
  }
  return out;
};
const checkS2 = (src: string): { ok: boolean; why: string } => {
  const b = fnBody(src, "importDroppedProjects");
  if (b === "") return { ok: false, why: "importDroppedProjects が見つからない" };
  const blocks = catchBlocks(b);
  if (blocks.length === 0) return { ok: false, why: "catch が見つからない" };
  // 束縛の無い catch が「失敗を握り潰して」いない（トーストもログも出していない）
  const silent = blocks.find((c) => !c.bound && (/toast\(/.test(c.body) || /logError/.test(c.body)));
  if (silent) return { ok: false, why: "★束縛の無い catch が失敗を扱っている（理由が残らない）" };
  // 失敗を扱う catch は束縛付きで、ログと理由つきトーストの両方を持つ
  const handler = blocks.find((c) => c.bound && /err\.file\.open\.detail\.toast/.test(c.body));
  if (!handler) return { ok: false, why: "理由つきトースト（err.file.open.detail.toast）を出す束縛付き catch が無い" };
  if (!/logError(?:\?\.)?\("import"/.test(handler.body))
    return { ok: false, why: 'その catch の中に logError("import" が無い' };
  return { ok: true, why: "" };
};
{
  const r = checkS2(main);
  check("[S-2] ★importDroppedProjects の catch が束縛付きで、logError と理由つきトーストがある", r.ok, r.why);
}

// ================= [S-3] 失敗を扱う 4 か所すべてに logError("import" =================
{
  const SITES: { file: string; fn: string; src: string }[] = [
    { file: "src/library.ts", fn: "importFolder", src: libTs },
    { file: "src/library.ts", fn: "openSingleFile", src: libTs },
    { file: "src/main.ts", fn: "importDroppedProjects", src: main },
    { file: "src/main.ts", fn: "handleDroppedPaths", src: main },
  ];
  const missing: string[] = [];
  for (const s of SITES) {
    const b = fnBody(s.src, s.fn);
    if (b === "" || !/logError(?:\?\.)?\("import"/.test(b)) missing.push(`${s.file}:${s.fn}`);
  }
  check("[S-3] ★失敗を扱う 4 か所すべてに logError(\"import\" がある（減ったら赤）", missing.length === 0, `無い: ${missing.join(", ")}`);
  // 走査が空振りしていない
  const total = [...libTs.matchAll(/logError(?:\?\.)?\("import"/g)].length + [...main.matchAll(/logError(?:\?\.)?\("import"/g)].length;
  check("[S-3] logError(\"import\" の総数が 4 以上", total >= 4, `${total} 件`);
}

// ================= [S-4] probe_project_file は全部読まない =================
const checkS4 = (src: string): { ok: boolean; why: string } => {
  const b = rsFn(src, "probe_project_file");
  if (b === "") return { ok: false, why: "probe_project_file が見つからない" };
  if (/read_to_end|fs::read\s*\(/.test(b)) return { ok: false, why: "ファイル全体を読んでいる" };
  if (!/read_exact/.test(b)) return { ok: false, why: "先頭・末尾を read_exact で読んでいない" };
  if (!/SeekFrom::End/.test(b)) return { ok: false, why: "末尾へ seek していない" };
  return { ok: true, why: "" };
};
{
  const r = checkS4(pclib);
  check("[S-4] ★probe_project_file はファイル全体を読まない（先頭 2B と末尾 16B だけ）", r.ok, r.why);
  const b = rsFn(pclib, "probe_project_file");
  check("[S-4] gzip の magic（1f 8b）と PV6 のトレーラ（AMPV6END）を見ている", /0x1f/.test(b) && /0x8b/.test(b) && /AMPV6END/.test(b));
};

// ================= [S-5] ★is_app_sidecar に .gz が無い =================
const checkS5 = (src: string): { ok: boolean; why: string } => {
  const b = rsFn(src, "is_app_sidecar");
  if (b === "") return { ok: false, why: "is_app_sidecar が見つからない" };
  if (/\.gz|gz"/.test(b)) return { ok: false, why: "★.gz が入っている（作品 0 件のアルバムと一緒に消える）" };
  return { ok: true, why: "" };
};
{
  const r = checkS5(pclib);
  check("[S-5] ★is_app_sidecar に .gz が入っていない（delete_album の安全性・R-10）", r.ok, r.why);
  // 付属物の一覧そのものが変わっていない（PNG サイドカーと OS のごみだけ）
  const b = rsFn(pclib, "is_app_sidecar");
  check("[S-5] 付属物の一覧は従来どおり（サイドカー PNG・thumbs.db・desktop.ini・.ds_store）", /PROJECT_EXT\}\.png/.test(b) && /thumbs\.db/.test(b) && /desktop\.ini/.test(b) && /\.ds_store/.test(b));
}

// ================= [S-6] fix_renamed_projects は上書きしない =================
const checkS6 = (src: string): { ok: boolean; why: string } => {
  const b = rsFn(src, "fix_renamed_projects");
  if (b === "") return { ok: false, why: "fix_renamed_projects が見つからない" };
  if (!/path_taken\(/.test(b)) return { ok: false, why: "★宛先の門番（path_taken）が無い（上書きし得る）" };
  if (!/skipped/.test(b)) return { ok: false, why: "飛ばした件数を数えていない" };
  // ★Codex 指摘（高）: `fs::rename` は宛先が在っても**黙って置き換える**（Windows も Unix も）。
  //  アプリ内のロックは同期クライアントやエクスプローラーには効かないので、
  //  「見てから改名するまで」の隙で上書きし得る。**宛先が在れば必ず失敗する** hard_link で行う
  if (/fs::rename/.test(b)) return { ok: false, why: "★fs::rename を使っている（宛先を黙って置き換える）" };
  if (!/fs::hard_link/.test(b)) return { ok: false, why: "★原子的に失敗する手順（hard_link）で改名していない" };
  if (!/AlreadyExists/.test(b)) return { ok: false, why: "宛先が在ったときを skipped として数えていない" };
  if (!/fs::remove_file/.test(b)) return { ok: false, why: "古い名前（.gz）を外していない" };
  // 1 件ごとに独立（途中で失敗しても抜けない＝errors に積んで続ける）
  if (/return Err/.test(b.slice(b.indexOf("for ")))) return { ok: false, why: "途中で抜けている（1 件ごとに独立でない）" };
  return { ok: true, why: "" };
};
{
  const r = checkS6(pclib);
  check("[S-6] ★fix_renamed_projects は同名があれば飛ばす（上書きしない）・1 件ごとに独立", r.ok, r.why);
}

// ================= [S-7] i18n 7 ファイル =================
{
  const NEW_KEYS = [
    "lib.gz.found.msg",
    "lib.gz.fix.btn",
    "lib.gz.later.btn",
    "lib.gz.done.toast",
    "lib.gz.skipped.toast",
    "lib.import.failedDetail.msg",
    "lib.import.failedItem.msg",
    "lib.import.failedMore.msg",
  ];
  const counts: number[] = [];
  const missing: string[] = [];
  for (const l of LANGS) {
    const ks = keysOf(read(`src/i18n/${l}.ts`));
    counts.push(ks.length);
    for (const k of NEW_KEYS) if (!ks.includes(k)) missing.push(`${l}:${k}`);
  }
  check("[S-7] ★新キーが 7 言語そろっている", missing.length === 0, `無い: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " …" : ""}`);
  check("[S-7] 7 ファイルのキー数が一致", new Set(counts).size === 1, counts.join("/"));
}

// ================= [S-8] 反証（z） =================
{
  // 1z: **失敗を扱う catch** から束縛を外した写し（importDroppedProjects の中だけを書き換える）
  const body1 = fnBody(main, "importDroppedProjects");
  const z1 = main.replace(body1, body1.replace(/\}\s*catch\s*\(\s*e\s*\)\s*\{/, "} catch {"));
  check("[S-8] 1z: 失敗を扱う catch の束縛を外した写しは [S-2] が赤", body1 !== "" && z1 !== main && !checkS2(z1).ok);
  // 1z': ログだけ落とした写しも赤（束縛が残っていても、理由が残らなければ意味が無い）
  const z1b = main.replace(body1, body1.replace(/logError\("import", `drop: [^`]*`\);\n/, ""));
  check("[S-8] 1z': catch から logError だけ落とした写しも [S-2] が赤", z1b !== main && !checkS2(z1b).ok);
  // 2z: is_app_sidecar に .gz を足した写し
  const sidecar = rsFn(pclib, "is_app_sidecar");
  const z2 = pclib.replace(sidecar, sidecar + '\n        || lower.ends_with(".gz")');
  check("[S-8] 2z: is_app_sidecar に .gz を足した写しは [S-5] が赤", sidecar !== "" && !checkS5(z2).ok);
  // 3z: 上書きの門番を外した写し
  const fixb = rsFn(pclib, "fix_renamed_projects");
  const z3 = pclib.replace(fixb, fixb.replace(/path_taken\(/g, "is_never_true("));
  check("[S-8] 3z: 上書きの門番（path_taken）を外した写しは [S-6] が赤", fixb !== "" && !checkS6(z3).ok);
  // 3z': hard_link（宛先が在れば必ず失敗する）を fs::rename に戻した写し＝**黙って上書きし得る形**
  const z3b = pclib.replace(fixb, fixb.replace(/fs::hard_link/g, "fs::rename"));
  check("[S-8] 3z': hard_link を fs::rename に戻した写しは [S-6] が赤", fixb !== "" && !checkS6(z3b).ok);
}

// ================= [S-9] scan_renamed_projects の 3 条件 =================
{
  const scan = rsFn(pclib, "scan_renamed_projects");
  const fix = rsFn(pclib, "fix_renamed_projects");
  check("[S-9] scan_renamed_projects がある", scan !== "");
  // ★3 条件は **1 か所**（for_each_renamed）にあり、探す側と直す側の**両方がそこを通る**
  //  ——条件が 2 か所に分かれると、片方だけ緩めたときに誰も気づけない
  const each = rsFn(pclib, "for_each_renamed");
  check("[S-9] 候補の条件は 1 か所（for_each_renamed）にある", each !== "");
  check("[S-9] 探す側と直す側の両方がその 1 か所を通る", /for_each_renamed\(/.test(scan) && /for_each_renamed\(/.test(fix));
  if (each !== "") {
    check("[S-9] 条件① 名前が .memoanima.gz / .animemo.gz で終わる（大小無視）", /gz_renamed_target\(/.test(each));
    check("[S-9] ★条件② .gz を外した名前が**使われていない**ものだけ（壊れたリンクも「ある」扱い）", /path_taken\(/.test(each));
    check("[S-9] ★条件③ 先頭 2 バイトが 1f 8b（中身は読まない）", /is_gzip_magic\(/.test(each));
  }
  const g = rsFn(pclib, "gz_renamed_target");
  check("[S-9] 対象の判定は 1 か所（gz_renamed_target）で、.png.gz は対象外", g !== "" && /PROJECT_EXT/.test(g) && /PROJECT_EXT_LEGACY/.test(g) && !/png/.test(g));
  const magic = rsFn(pclib, "is_gzip_magic");
  check("[S-9] is_gzip_magic は 2 バイトだけ読む（ファイル全体を読まない）", magic !== "" && /\[0u8; 2\]/.test(magic) && !/read_to_end|fs::read\s*\(/.test(magic));
}

// ================= [S-10] 名前の付け替えを Node で叩く（R-7 の根拠） =================
// ★動的 import: **この検査を先に書いて赤を見る**ため（モジュールがまだ無くても走り切る）
type GzMod = {
  stripGzSuffix: (s: string) => string;
  importBaseName: (s: string) => string;
  isProjectLikeName: (s: string) => boolean;
  importLogSafe: (s: string, known?: string[]) => string;
};
const gz: GzMod | null = await import("../src/gzname")
  .then((m) => m as unknown as GzMod)
  .catch(() => null);
if (!gz) {
  check("[S-10] src/gzname.ts（.gz の名前を扱う純関数）がある", false, "モジュールが無い");
} else {
  const { stripGzSuffix, importBaseName, isProjectLikeName } = gz;
  check("[S-10] stripGzSuffix: foo.memoanima.gz → foo.memoanima", stripGzSuffix("foo.memoanima.gz") === "foo.memoanima");
  check("[S-10] stripGzSuffix: 大文字の .GZ も外す", stripGzSuffix("foo.memoanima.GZ") === "foo.memoanima");
  check("[S-10] stripGzSuffix: .gz でないものは触らない", stripGzSuffix("foo.memoanima") === "foo.memoanima" && stripGzSuffix("foo.tar.gz") === "foo.tar");
  check("[S-10] ★importBaseName: foo.memoanima.gz → foo（これが foo.memoanima だと foo.memoanima.gz.memoanima になる）", importBaseName("foo.memoanima.gz") === "foo");
  check("[S-10] importBaseName: 従来の .memoanima は変わらない", importBaseName("foo.memoanima") === "foo" && importBaseName("旧作.animemo") === "旧作");
  check("[S-10] importBaseName: 名前に点が複数あっても最後の 1 つだけ落とす", importBaseName("a.b.c.memoanima.gz") === "a.b.c");
  check("[S-10] isProjectLikeName: .gz を外して判定する", isProjectLikeName("foo.memoanima.gz") && isProjectLikeName("foo.animemo.gz") && isProjectLikeName("foo.MEMOANIMA") );
  check("[S-10] ★isProjectLikeName: ふつうの .gz は通さない（R-8）", !isProjectLikeName("something.tar.gz") && !isProjectLikeName("archive.gz") && !isProjectLikeName("photo.png.gz"));
  // 呼び出し側が使っている（純関数だけ直しても意味が無い）
  check("[S-10] importDroppedProjects が importBaseName を使っている", /importBaseName\(/.test(fnBody(main, "importDroppedProjects")));

  // ============= [S-15] ログの伏せ字を Node で叩く（W-10・Codex 指摘 高②の再発防止） =============
  const { importLogSafe } = gz;
  // ★Codex が見つけた漏れ方: **名前に空白がある作品**だと、語単位の伏せ字では断片が残った
  //   `C:\Users\me\作品 1.memoanima` → `<path> 1.memoanima`（「作品」は消えるが「1.memoanima」が残る）
  const leaky = "取り込み元が見つかりません: C:\\Users\\me\\作品 1.memoanima";
  const safe = importLogSafe(leaky, ["C:\\Users\\me\\作品 1.memoanima"]);
  check("[S-15] ★空白を含む作品名が 1 文字も残らない（分かっているパスは完全一致で先に消す）",
    !safe.includes("作品") && !safe.includes("1.memoanima") && !safe.includes("me") && safe.includes("<file>"), safe);
  // known を渡し忘れても、最後の網で作品ファイルの名前は落ちる
  const safe2 = importLogSafe(leaky);
  check("[S-15] known を渡し忘れても .memoanima の語は残らない", !safe2.includes(".memoanima"), safe2);
  // `.kwz` / `.ppm` は**ファイル名を残す**（どれが失敗したかの手掛かり・W-10 で許されている）
  const kwz = importLogSafe("読み込み失敗: C:\\Users\\me\\3DS\\ABCD1234.kwz", ["C:\\Users\\me\\3DS\\ABCD1234.kwz"]);
  check("[S-15] .kwz はファイル名が残り、フォルダは消える", kwz.includes("ABCD1234.kwz") && !kwz.includes("Users") && !kwz.includes("me"), kwz);
  // 保険の伏せ字が診断文を壊しすぎない（`mp3/wav` のような語は残す）
  check("[S-15] `mp3/wav` のような語は潰さない", importLogSafe("対応していない形式です: mp3/wav/ogg のみ").includes("mp3/wav/ogg"));
  // パスは known を渡さなくても落ちる（ドライブ文字・UNC・POSIX）
  check("[S-15] 分かっていないパスも落ちる（C:\\ / \\\\server / /Users）",
    !importLogSafe("x: C:\\Users\\me\\a.txt").includes("me") &&
    !importLogSafe("x: \\\\server\\share\\a.txt").includes("server") &&
    !importLogSafe("x: /Users/me/a.txt").includes("me"));
  // 呼び出し側が known を渡している（渡さないと空白入りの名前が残る＝高②の再発）
  const dropBody = fnBody(main, "importDroppedProjects");
  const handleBody = fnBody(main, "handleDroppedPaths");
  check("[S-15] ★呼び出し側が known（分かっているパス）を渡している",
    /importLogSafe\(errText\(e\), \[p, fname\]\)/.test(dropBody) &&
    /importLogSafe\(errText\(e\), \[p, fname\]\)/.test(handleBody) &&
    /importLogSafe\(detail, known/.test(main),
    "main.ts の呼び出しに known が無い");
}

// ================= [S-11] gzip だけでは通さない =================
{
  const b = fnBody(main, "handleDroppedPaths");
  check("[S-11] handleDroppedPaths が probe_project_file を使う", b !== "" && /probe_project_file/.test(b));
  check("[S-11] ★gzip だけでは通さない（pv6 か、gzip かつ作品らしい名前）", b !== "" && /\bpv6\b/.test(b) && /isProjectLikeName\(/.test(b));
  // 「gzip なら通す」だけの分岐が無い
  check("[S-11] `gzip` 単独で projPaths へ積む分岐が無い", b !== "" && !/if\s*\(\s*(?:pr\.|probe\.)?gzip\s*\)\s*\{?\s*projPaths\.push/.test(b));
}

// ================= [S-12] コマンド登録 =================
{
  const h = /invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/.exec(librs)?.[1] ?? "";
  for (const c of ["scan_renamed_projects", "fix_renamed_projects", "probe_project_file"])
    check(`[S-12] ${c} が invoke_handler に登録されている`, new RegExp(`\\b${c}\\b`).test(h));
}

// ================= [S-13] 壊すなリスト =================
{
  const ext = rsFn(pclib, "is_project_ext");
  check("[S-13] is_project_ext の意味を変えていない（memoanima / animemo の 2 つだけ）", /eq_ignore_ascii_case\(PROJECT_EXT\)/.test(ext) && /eq_ignore_ascii_case\(PROJECT_EXT_LEGACY\)/.test(ext) && !/gz/.test(ext));
  const work = rsFn(pclib, "is_work_file");
  check("[S-13] is_work_file の意味を変えていない（拡張子で判定・.gz を含めない）", /extension\(\)/.test(work) && /is_project_ext/.test(work) && /kwz/.test(work) && /ppm/.test(work) && !/gz/.test(work));
  check("[S-13] PROJECT_EXT / PROJECT_EXT_LEGACY の値は不変", /const PROJECT_EXT: &str = "memoanima";/.test(pclib) && /const PROJECT_EXT_LEGACY: &str = "animemo";/.test(pclib));
  for (const f of ["src/editor/serialize.ts", "src/editor/pv6.ts", "src/editor/raster.ts"]) {
    check(`[S-13] ${f} に .gz の判定を持ち込んでいない`, !/\.gz\b/.test(strip(read(f))));
  }
}

// ================= [S-14] 走査は従来どおり拡張子で =================
{
  const b = rsFn(pclib, "scan_library");
  check("[S-14] scan_library は拡張子で判定（is_project_ext）", b !== "" && /is_project_ext/.test(b));
  check("[S-14] ★scan_library は中身を覗きにいかない（probe / magic を呼ばない）", b !== "" && !/probe_project_file|is_gzip_magic/.test(b));
}

console.log(`\nv173 smoke: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
