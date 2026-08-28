// V155 (L-1): 読み込みの分割化の回帰スモーク（引数不要: npx tsx scripts/v155_smoke.ts）
//
// ★この回の合否は作者の再現データ（87.2 MiB・21,960面）で確かめるが、あれは手元にしか無い。
//   ここでは**壁を自分で越える作品を作って**、誰の環境でも同じことを確かめられるようにする。
//
// 壁: V8 の文字列上限 536,870,888 文字 ÷ base64 の 4/3 = 402,653,166 B（生バッファ 384.0 MiB）
//     ＝ 8bit なら 5,242 面／16bit なら 2,621 面。**ここを越えると旧実装は開けなかった。**
//
// 1. **壁を越える作品が開ける**（5,300面・展開後の JSON が 512 MiB 超）＝この回の本体
// 2. 開いた中身が正しい（コマ数・面数・絵のバイト）
// 3. 小さい作品も従来どおり開ける（コマ1つ／2つ／多め）
// 4. 区切り `{"paper":` は**レイヤー名やタイトルに同じ字面が入っていても**壊れない
// 5. マルチバイト文字がチャンク境界にかかっても壊れない
// 6. 音声つき（ヘッダが大きい作品）でも開ける
// 7. 壊れたファイルは「壊れている」と言う（大きすぎる、とは言わない）
// 8. **切り分けが、チャンクの切れ目に左右されない**（あらゆる切れ方を総当たり）
import {
  newProject,
  makeEmptyFrame,
  allocIndexBuf,
  projectFaces,
  projectBytes,
  loadWallFaces,
  MAX_JSON_CHARS,
  type Project,
} from "../src/editor/model";
import { projectToBytes, projectFromBytes, createDocSplitter } from "../src/editor/serialize";

// serialize.ts の切り分けが使う字面（あちらは非公開なので、同じものをここに置く）
const FRAME_HEAD_S = '{"paper":';
const FRAMES_KEY_S = '"frames":[';

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " — " + detail : ""}`);
  }
}

/** コマごとに1ドットだけ変えた作品（gzip が効きすぎて壁の検証にならないのを防ぐ） */
function makeProject(frames: number, layers: number, title = "V155"): Project {
  const p = newProject(title);
  p.layerDefs = [];
  for (let i = 0; i < layers; i++)
    p.layerDefs.push({ id: `L${i + 1}`, name: `L${i + 1}`, visible: true, opacity: 1 });
  p.frames = [];
  for (let f = 0; f < frames; f++) {
    const fr = makeEmptyFrame(p, 0);
    fr.layers = {};
    for (const ld of p.layerDefs) fr.layers[ld.id] = allocIndexBuf(p);
    fr.layers[p.layerDefs[0].id][f % 76800] = (f % 7) + 1;
    p.frames.push(fr);
  }
  return p;
}

/** 2つの作品の絵が1バイトも違わないか（m3_smoke の roundtrip と同じ流儀） */
function sameArt(a: Project, b: Project): boolean {
  if (a.frames.length !== b.frames.length) return false;
  for (let fi = 0; fi < a.frames.length; fi++) {
    if (a.frames[fi].paper !== b.frames[fi].paper) return false;
    const ka = Object.keys(a.frames[fi].layers);
    const kb = Object.keys(b.frames[fi].layers);
    if (ka.length !== kb.length) return false;
    for (const id of ka) {
      const x = a.frames[fi].layers[id];
      const y = b.frames[fi].layers[id];
      if (!y || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    }
  }
  return true;
}

const main = async () => {
  // ---------------- 1〜2. 壁を越える作品（この回の本体） ----------------
  {
    const faces = loadWallFaces(8) + 58; // 5,300面（壁 5,242 の向こう側）
    const layers = 4;
    const frames = Math.ceil(faces / layers); // 1,325コマ × 4レイヤー = 5,300面
    const p = makeProject(frames, layers, "壁越え");
    const raw = projectBytes(p);
    const t0 = Date.now();
    const bytes = await projectToBytes(p);
    const saveMs = Date.now() - t0;
    const t1 = Date.now();
    let loaded: Project | null = null;
    let err = "";
    try {
      loaded = await projectFromBytes(bytes);
    } catch (e) {
      err = String((e as Error).message);
    }
    const loadMs = Date.now() - t1;
    check("1: **壁を越える作品が開ける**（旧実装はここで落ちていた）", loaded !== null, err);
    if (loaded) {
      check("2: コマ数が合う", loaded.frames.length === frames, `${loaded.frames.length}/${frames}`);
      check("2: 面数が合う", projectFaces(loaded) === faces, `${projectFaces(loaded)}/${faces}`);
      check("2: 絵が1バイトも違わない", sameArt(p, loaded));
      check("2: メーターの値が一致", projectBytes(loaded) === raw);
    }
    // 展開後の JSON が本当に上限を超えているか（＝壁のこちら側で試していないこと）の裏取り
    const jsonChars = Math.ceil((raw * 4) / 3);
    check(
      "1: 展開後の JSON が V8 の上限を超えている（＝本当に壁の向こう）",
      jsonChars > MAX_JSON_CHARS,
      `${(jsonChars / 1024 / 1024).toFixed(0)}MB > ${(MAX_JSON_CHARS / 1024 / 1024).toFixed(0)}MB`
    );
    console.log(
      `  参考: ${frames}コマ×${layers}レイヤー＝${faces}面 / 生 ${(raw / 1024 / 1024).toFixed(0)}MB / ` +
        `JSON 約${(jsonChars / 1024 / 1024).toFixed(0)}MB / 圧縮 ${(bytes.length / 1024 / 1024).toFixed(1)}MB / ` +
        `保存 ${saveMs}ms・読み込み ${loadMs}ms`
    );
  }

  // ---------------- 3. 小さい作品（境界の数） ----------------
  for (const n of [1, 2, 3, 37]) {
    const p = makeProject(n, 2);
    const bytes = await projectToBytes(p);
    const q = await projectFromBytes(bytes);
    check(`3: ${n}コマの作品が開ける`, q.frames.length === n && sameArt(p, q), `${q.frames.length}`);
  }

  // ---------------- 4. 区切りの字面が名前に入っていても壊れない ----------------
  {
    // JSON は文字列中の `"` を `\"` に escape するので、この字面はコマの頭にしか現れない
    const p = makeProject(5, 2, '{"paper": を含む題名');
    p.layerDefs[0].name = '{"paper":';
    p.meta.source = { name: '{"paper":0,"layers":{}}.kwz' };
    const q = await projectFromBytes(await projectToBytes(p));
    check("4: 名前に `{\"paper\":` が入っても 5 コマ", q.frames.length === 5 && sameArt(p, q), `${q.frames.length}`);
    check("4: 題名もそのまま戻る", q.meta.title === '{"paper": を含む題名', q.meta.title);
    check("4: レイヤー名もそのまま戻る", q.layerDefs[0].name === '{"paper":', q.layerDefs[0].name);
  }

  // ---------------- 5. マルチバイトがチャンク境界をまたぐ ----------------
  {
    // 題名を長くしてヘッダを膨らませ、境界の位置をずらしながら何度も試す
    for (const pad of [0, 1, 2, 3]) {
      const p = makeProject(3, 2, "あ".repeat(30000 + pad) + "🐸");
      const q = await projectFromBytes(await projectToBytes(p));
      if (q.meta.title !== p.meta.title || q.frames.length !== 3) {
        check(`5: 長い日本語の題名（pad=${pad}）`, false, `${q.frames.length}コマ / 題名一致=${q.meta.title === p.meta.title}`);
        break;
      }
      if (pad === 3) check("5: 長い日本語＋絵文字の題名でも壊れない（境界を4通りずらして確認）", true);
    }
  }

  // ---------------- 6. 音声つき（ヘッダが大きい） ----------------
  {
    const p = makeProject(4, 2, "音つき");
    const data = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff; // 圧縮で消えないように
    p.audio = {
      bgm: {
        source: "external",
        mime: "audio/mpeg",
        data,
        muted: false,
        volume: 1,
        trimStartMs: 0,
        trimEndMs: null,
        syncMode: "audioToAnim",
        baseSpeedIndex: 4,
        name: "bgm.mp3",
      },
      se: [],
    };
    const q = await projectFromBytes(await projectToBytes(p));
    check(
      "6: 音声（3MB）を積んだ作品が開ける＝ヘッダが大きくても平気",
      q.frames.length === 4 && (q.audio?.bgm?.data.length ?? 0) === data.length,
      `${q.audio?.bgm?.data.length ?? 0}`
    );
    let audioSame = true;
    const got = q.audio!.bgm!.data;
    for (let i = 0; i < data.length; i++) if (data[i] !== got[i]) { audioSame = false; break; }
    check("6: 音声のバイトも一致", audioSame);
  }

  // ---------------- 7. 壊れているものは壊れていると言う ----------------
  {
    const bytes = await projectToBytes(makeProject(4, 2));
    const bad = bytes.slice();
    bad[Math.floor(bad.length / 2)] ^= 0xff;
    let msg = "";
    try {
      await projectFromBytes(bad);
    } catch (e) {
      msg = String((e as Error).message);
    }
    check("7: 壊れたファイルは「壊れている」と言う", msg.includes("壊れて"), msg);
    check("7: 「大きすぎて」とは言わない", !msg.includes("大きすぎて"), msg);
    check("7: 空のメッセージにならない", msg.length > 10, `"${msg}"`);
  }


  // ---------------- 8. 切れ目に左右されない（この回の一番きわどい所） ----------------
  //
  //  最初の実装は「コマの頭がチャンクの末尾 8 文字以内に来る」と、同じ頭を二度数えて
  //  コマを途中でぶつ切りにしていた。起きる確率は 1 コマあたり 1 万分の 1 程度で、
  //  **87MB の再現データでも 5,300 面のスモークでも、たまたま通ってしまっていた**
  //  （実際に見つけたのは m62_smoke ＝ 音声つきの実作品 16 本のうち 1 本）。
  //
  //  切れ目を作るのは `DecompressionStream` なので、こちらからは選べない。
  //  だから切り分けだけを関数（`createDocSplitter`）にして、ここで
  //  **あらゆる切れ方**を総当たりで当てる。運任せにしない。
  {
    // 本物と同じ形の JSON を、実際に保存して作る（手で組むと形がずれる）
    const p = makeProject(4, 2, "切れ目");
    const gz = await projectToBytes(p);
    const text = new TextDecoder().decode(
      new Uint8Array(
        await new Response(
          new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
        ).arrayBuffer()
      )
    );
    // まず一括（切れ目なし）で正解を取る
    const whole: string[] = [];
    const sp0 = createDocSplitter((f) => whole.push(f));
    sp0.push(text);
    const want = sp0.end();
    check("8: 一括で切ると 4 コマ", whole.length === 4, `${whole.length}`);
    check(
      "8: 一括の head+tail がコマ抜きの JSON になる",
      (JSON.parse(want.head + want.tail) as { frames: unknown[] }).frames.length === 0
    );

    /** 与えられた切れ目でテキストを流し、一括のときと同じ結果になるか */
    const feed = (cut: (i: number) => number): string => {
      const got: string[] = [];
      const sp = createDocSplitter((f) => got.push(f));
      let i = 0;
      for (let n = 0; i < text.length; n++) {
        const to = Math.min(text.length, Math.max(i + 1, cut(n)));
        sp.push(text.slice(i, to));
        i = to;
      }
      sp.push("");
      const end = sp.end();
      if (got.length !== whole.length) return `コマ数 ${got.length}≠${whole.length}`;
      for (let k = 0; k < got.length; k++)
        if (got[k] !== whole[k]) return `コマ${k}の中身が違う（${got[k].length}≠${whole[k].length}文字）`;
      if (end.head !== want.head) return "head が違う";
      if (end.tail !== want.tail) return "tail が違う";
      return "";
    };

    // (a) 1文字ずつ（考えうる最悪の刻み）
    check("8: 1文字ずつ流しても同じ", feed((n) => n + 1) === "", feed((n) => n + 1));

    // (b) コマの頭 `{"paper":` を**1文字ずつずらしてまたぐ**切れ方を総当たり
    //     ＝ 直前の実装が壊れていた形そのもの
    const heads: number[] = [];
    for (let at = text.indexOf(FRAME_HEAD_S); at >= 0; at = text.indexOf(FRAME_HEAD_S, at + 1))
      heads.push(at);
    check("8: コマの頭が 4 つ見つかる", heads.length === 4, `${heads.length}`);
    let ngStraddle = "";
    for (const at of heads) {
      for (let off = -FRAME_HEAD_S.length; off <= FRAME_HEAD_S.length; off++) {
        const cutAt = at + off;
        if (cutAt <= 0 || cutAt >= text.length) continue;
        const r = feed((n) => (n === 0 ? cutAt : text.length));
        if (r) {
          ngStraddle = `頭 ${at} を ${off} でまたぐと ${r}`;
          break;
        }
      }
      if (ngStraddle) break;
    }
    check("8: コマの頭をまたぐ切れ方（前後9文字を総当たり）でも同じ", !ngStraddle, ngStraddle);

    // (c) 一定の刻みを総当たり（1〜300 と、頭の直前で切れる大きさ）
    let ngStep = "";
    for (let step = 1; step <= 300; step++) {
      const r = feed((n) => (n + 1) * step);
      if (r) {
        ngStep = `刻み ${step} で ${r}`;
        break;
      }
    }
    check("8: 刻み 1〜300 の総当たりでも同じ", !ngStep, ngStep);

    // (d) `"frames":[` をまたぐ切れ方（ヘッダ側の持ち越し）
    const fk = text.indexOf(FRAMES_KEY_S);
    let ngHead = "";
    for (let off = -FRAMES_KEY_S.length; off <= FRAMES_KEY_S.length; off++) {
      const cutAt = fk + off;
      if (cutAt <= 0 || cutAt >= text.length) continue;
      const r = feed((n) => (n === 0 ? cutAt : text.length));
      if (r) {
        ngHead = `"frames":[ を ${off} でまたぐと ${r}`;
        break;
      }
    }
    check('8: `"frames":[` をまたぐ切れ方でも同じ', !ngHead, ngHead);
  }

  console.log(`v155 smoke: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
};

void main();
