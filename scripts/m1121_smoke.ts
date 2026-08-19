// M11-21 スモーク: ①書き出し色（PNG の sRGB/gAMA チャンク付与・MP4 の ffmpeg 引数の pin）②miniDock "off" の正規化
// 引数不要:  npx tsx scripts/m1121_smoke.ts
// ※ 実ファイルのデコード比較（形式×素材の表）は scripts/m1121_export_check.mts（tauri:dev の WebView が要る）

import { PNG } from "pngjs";
import UPNG from "upng-js";
// M12-1c-2: 文言の pin が言語に左右されないよう ja に固定する（pin の文字列は変えていない）
import { setLang } from "../src/i18n";
setLang("ja");
// exporter.ts（と editor.ts）は gif.js（ブラウザ前提・self 参照）を静的 import するので self を敷いてから動的 import
(globalThis as unknown as { self: unknown }).self = globalThis;
const { withSrgbChunks, mp4ExecArgs, MP4_COLOR_VF, MP4_COLOR_TAGS } = await import("../src/editor/exporter");
const { sanitizeMiniDock } = await import("../src/editor/editor");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name} ${detail}`);
  }
}
const chunkNames = (b: Uint8Array): string[] => {
  const out: string[] = [];
  let o = 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (o + 12 <= b.length) {
    const len = dv.getUint32(o);
    const t = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    out.push(t);
    if (t === "IEND") break;
    o += 12 + len;
  }
  return out;
};
const readGama = (b: Uint8Array): number | null => {
  let o = 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (o + 12 <= b.length) {
    const len = dv.getUint32(o);
    const t = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (t === "gAMA") return dv.getUint32(o + 8);
    if (t === "IEND") break;
    o += 12 + len;
  }
  return null;
};

// ---------- ① PNG チャンク ----------
{
  // pngjs で色チャンク無しの RGBA PNG を作る（Chromium canvas.toBlob の出力と同じチャンク構成 IHDR/IDAT/IEND）
  const png = new PNG({ width: 320, height: 240 });
  for (let i = 0; i < 320 * 240; i++) {
    png.data[i * 4] = i & 255; png.data[i * 4 + 1] = (i >> 8) & 255; png.data[i * 4 + 2] = 77; png.data[i * 4 + 3] = i % 7 === 0 ? 0 : 255;
  }
  const raw = new Uint8Array(PNG.sync.write(png));
  check("①前提: pngjs 出力に色チャンクなし", !chunkNames(raw).includes("sRGB") && !chunkNames(raw).includes("gAMA"), chunkNames(raw).join(","));
  const tagged = withSrgbChunks(raw);
  const names = chunkNames(tagged);
  check("① sRGB→gAMA が IHDR の直後に入る", names[0] === "IHDR" && names[1] === "sRGB" && names[2] === "gAMA", names.join(","));
  check("① gAMA=45455・sRGB intent=1", readGama(tagged) === 45455 && tagged[8 + 25 + 8] === 1);
  // CRC が正しい（pngjs は CRC 不一致で例外）＋画素は不変
  let decoded: PNG | null = null;
  try { decoded = PNG.sync.read(Buffer.from(tagged), { checkCRC: true } as never); } catch (e) { check("① CRC 検証で例外", false, String(e)); }
  check("① 付与後も pngjs でデコードでき（CRC OK）画素が全バイト一致", !!decoded && Buffer.compare(decoded!.data, png.data) === 0);
  check("① サイズ差は sRGB(13)+gAMA(16)=29 バイトぴったり", tagged.length === raw.length + 13 + 16, `${tagged.length - raw.length}`);
  check("① 冪等（もう一度通しても変わらない）", Buffer.compare(Buffer.from(withSrgbChunks(tagged)), Buffer.from(tagged)) === 0);
  // UPNG（APNG）: sRGB は既にある → gAMA だけがその直後に入る
  const f0 = new Uint8Array(320 * 240 * 4).fill(255);
  const f1 = new Uint8Array(320 * 240 * 4).fill(0);
  for (let i = 0; i < 320 * 240 * 4; i += 4) f1[i + 3] = 255;
  const apng = new Uint8Array(UPNG.encode([f0.buffer, f1.buffer], 320, 240, 0, [125, 125]));
  const an = chunkNames(apng);
  check("①前提: UPNG は sRGB を書き gAMA を書かない", an[1] === "sRGB" && !an.includes("gAMA"), an.join(","));
  const apngT = withSrgbChunks(apng);
  const an2 = chunkNames(apngT);
  check("① APNG: gAMA が sRGB の直後に 1 個だけ入る（sRGB は増えない）", an2[1] === "sRGB" && an2[2] === "gAMA" && an2.filter((n) => n === "sRGB").length === 1 && an2.filter((n) => n === "gAMA").length === 1, an2.join(","));
  const dec = UPNG.decode(apngT.buffer.slice(apngT.byteOffset, apngT.byteOffset + apngT.byteLength));
  const frames = UPNG.toRGBA8(dec);
  check("① APNG: 付与後もデコードでき 2 コマの画素が一致", frames.length === 2 && Buffer.compare(Buffer.from(frames[0]), Buffer.from(f0.buffer)) === 0 && Buffer.compare(Buffer.from(frames[1]), Buffer.from(f1.buffer)) === 0);
  // PNG でないバイト列はそのまま
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
  check("① PNG 署名でなければ無変更（同一オブジェクト）", withSrgbChunks(junk) === junk);
  // レビュー保険: 手組みのチャンクを差し込んだ PNG での挙動（現行の入力＝canvas/UPNG では到達しない）
  const mkChunk = (t: string, data: number[]) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(t, 4, "latin1"); Buffer.from(data).copy(b, 8); b.writeUInt32BE(0, 8 + data.length); return b; };
  const sig = raw.subarray(0, 8), ihdr = raw.subarray(8, 33), rest = raw.subarray(33);
  const withIccp = new Uint8Array(Buffer.concat([Buffer.from(sig), Buffer.from(ihdr), mkChunk("iCCP", [0x61, 0, 0, 0x78, 0x9c, 3, 0, 0, 0, 0, 1]), Buffer.from(rest)]));
  check("① iCCP がある PNG には何も足さない（sRGB と共存不可）", withSrgbChunks(withIccp) === withIccp);
  const broken = new Uint8Array(raw); broken[8] = 0xff; broken[9] = 0xff; // IHDR の length を壊す
  check("① チャンク長が壊れた PNG は触らずそのまま返す（例外にしない）", withSrgbChunks(broken) === broken);
  const actlFirst = new Uint8Array(Buffer.concat([Buffer.from(sig), Buffer.from(ihdr), mkChunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]), mkChunk("sRGB", [1]), Buffer.from(rest)]));
  const af = chunkNames(withSrgbChunks(actlFirst));
  check("① acTL の後ろに sRGB がある PNG でも sRGB は二重にならず gAMA だけ足す", af.filter((n) => n === "sRGB").length === 1 && af.filter((n) => n === "gAMA").length === 1 && af.indexOf("gAMA") === af.indexOf("sRGB") + 1, af.join(","));
}

// ---------- ① MP4 引数（色以外は M5-1/M6-1 と同一） ----------
{
  const OLD_NOAUDIO = ["-framerate", "8", "-i", "f%04d.png", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart", "out.mp4"];
  const OLD_A2A = ["-framerate", "8", "-i", "f%04d.png", "-i", "mix.wav", "-t", "0.375", "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "out.mp4"];
  const OLD_LOOP = ["-stream_loop", "-1", "-framerate", "8", "-i", "f%04d.png", "-i", "mix.wav", "-t", "1.000", "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "out.mp4"];
  const stripColor = (a: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "-vf" && a[i + 1] === MP4_COLOR_VF) { i++; continue; }
      if (MP4_COLOR_TAGS.includes(a[i]) && i % 1 === 0 && ["-colorspace", "-color_primaries", "-color_trc", "-color_range"].includes(a[i])) { i++; continue; }
      out.push(a[i]);
    }
    return out;
  };
  const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const na = mp4ExecArgs(8, null);
  const a2a = mp4ExecArgs(8, { durationSec: 0.375, syncMode: "audioToAnim" });
  const loop = mp4ExecArgs(8, { durationSec: 1, syncMode: "animToAudio" });
  check("① 無音: 色引数を抜くと M6-1 の引数列と完全一致", eq(stripColor(na), OLD_NOAUDIO), JSON.stringify(stripColor(na)));
  check("① 音声(audioToAnim): 色引数を抜くと M5-1 の引数列と完全一致", eq(stripColor(a2a), OLD_A2A), JSON.stringify(stripColor(a2a)));
  check("① 音声(animToAudio): 色引数を抜くと M5-1 の引数列と完全一致（-stream_loop 先頭）", eq(stripColor(loop), OLD_LOOP), JSON.stringify(stripColor(loop)));
  const hasColor = (a: string[]) => a.includes("-vf") && a[a.indexOf("-vf") + 1] === "scale=out_color_matrix=bt709:out_range=tv" && a.includes("-colorspace") && a[a.indexOf("-colorspace") + 1] === "bt709" && a[a.indexOf("-color_primaries") + 1] === "bt709" && a[a.indexOf("-color_trc") + 1] === "bt709" && a[a.indexOf("-color_range") + 1] === "tv" && a.indexOf("-vf") < a.indexOf("-pix_fmt");
  check("① 3経路とも BT.709 変換（-vf scale…bt709:tv が -pix_fmt より前）＋4タグが入る", hasColor(na) && hasColor(a2a) && hasColor(loop));
  check("① 分数 fps はそのまま文字列化", mp4ExecArgs(0.2, null)[1] === "0.2" && mp4ExecArgs(24, null)[1] === "24");
}

// ---------- ② miniDock ----------
{
  check("② sanitizeMiniDock: off/float/timeline はそのまま", sanitizeMiniDock("off") === "off" && sanitizeMiniDock("float") === "float" && sanitizeMiniDock("timeline") === "timeline");
  check("② sanitizeMiniDock: 未知・壊れた値は既定（収納）", ["OFF", "none", "", 1, null, undefined, {}, true, "hidden"].every((v) => sanitizeMiniDock(v) === "timeline"));
}

console.log(`m1121 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
