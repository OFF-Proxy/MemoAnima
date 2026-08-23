// M16: 仕上げ3点の回帰スモーク（引数不要: npx tsx scripts/m16_smoke.ts）
//   D-1 ディザのコマ間シフト / K-4 修飾キー＋クリック / X-1 MP4 ループ書き出し（音声連結）
import { W, PIXELS, type IndexBuf } from "../src/editor/model";
import { toneAt, floodFill, toneById, TONE_TILES } from "../src/editor/raster";
import {
  bindingKey,
  pointerEventKey,
  bindingFromPointer,
  sanitizeKeysSettings,
  buildLookup,
  keyLabel,
  BUILTIN_PRESETS,
  type KeyBinding,
} from "../src/keymap";
import { repeatWav } from "../src/editor/audio";
import { setLang } from "../src/i18n";
setLang("ja");

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`NG ${name}${detail ? " " + detail : ""}`);
  }
}

// ================= D-1: ディザのコマ間シフト =================
{
  const tile = toneById("dot-grid-l")?.tile ?? TONE_TILES.find((x) => x.tile)?.tile ?? null;
  check("D-1(前提): 非ベタのトーン tile がある", !!tile);
  if (tile) {
    // shift 既定 0 は従来と完全一致（4引数のうち第4を省略＝0）
    let same0 = true;
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 24; x++) if (toneAt(tile, x, y) !== toneAt(tile, x, y, 0)) same0 = false;
    check("D-1: shift 省略と shift=0 は完全一致（OFF＝従来どおり）", same0);

    // コマ f のシフトは (x+f, y+f) の参照＝ toneAt(x,y,f) === toneAt(x+f,y+f,0)
    let shiftOk = true;
    for (const f of [0, 1, 2, 5]) {
      for (let y = 0; y < 24; y++)
        for (let x = 0; x < 24; x++)
          if (toneAt(tile, x, y, f) !== toneAt(tile, x + f, y + f, 0)) shiftOk = false;
    }
    check("D-1: shift=f は (x+f,y+f) 参照＝斜め (0,0)/(1,1)/(2,2)…", shiftOk);

    // 3コマで点配置が実際に動く（frame0 と frame1 で少なくとも1画素は違う＝揺れる）
    let moved = false;
    for (let y = 0; y < 24 && !moved; y++)
      for (let x = 0; x < 24; x++) if (toneAt(tile, x, y, 0) !== toneAt(tile, x, y, 1)) { moved = true; break; }
    check("D-1: frame0 と frame1 で点配置が動く（再生で揺れる）", moved);

    // floodFill の toneShift 経路: shift=0 は無指定と一致 / shift=2 は toneAt(x,y,2) と一致
    const a: IndexBuf = new Uint8Array(PIXELS);
    floodFill(a, 5, 5, 7, tile, undefined, undefined); // 無指定（従来）
    const b: IndexBuf = new Uint8Array(PIXELS);
    floodFill(b, 5, 5, 7, tile, undefined, undefined, 0); // shift=0
    check("D-1: floodFill shift 省略 == shift=0（OFF ピクセル一致）", a.every((v, i) => v === b[i]));

    const c: IndexBuf = new Uint8Array(PIXELS);
    floodFill(c, 5, 5, 7, tile, undefined, undefined, 2); // shift=2
    let fillShiftOk = true;
    for (let i = 0; i < PIXELS; i++) {
      const want = toneAt(tile, i % W, (i / W) | 0, 2) ? 7 : 0;
      if (c[i] !== want) { fillShiftOk = false; break; }
    }
    check("D-1: floodFill shift=2 が toneAt(x,y,2) と一致", fillShiftOk);
  }
}

// ================= K-4: 修飾キー＋クリック =================
{
  // bindingKey: ポインタ割り当ては `mods|B<button>`・キーボードは従来 `mods|code`
  check("K-4: bindingKey ポインタ形（Alt+左クリック）", bindingKey({ code: "", button: 0, alt: true }) === "A|B0");
  check("K-4: bindingKey ポインタ形（右クリック無修飾）", bindingKey({ code: "", button: 2 }) === "|B2");
  check("K-4: bindingKey キーボード形は従来どおり", bindingKey({ code: "KeyZ", ctrl: true }) === "C|KeyZ");

  // pointerEventKey が同じ字面を作る（照合できる）
  const pk = pointerEventKey({ ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, button: 0 });
  check("K-4: pointerEventKey(Alt+左) == bindingKey", pk === "A|B0");
  // Win（meta）＋クリックはわざと一致させない
  const pkMeta = pointerEventKey({ ctrlKey: false, shiftKey: false, altKey: true, metaKey: true, button: 0 });
  check("K-4: meta＋クリックは一致しない（M 混入）", pkMeta === "AM|B0" && pkMeta !== "A|B0");

  // bindingFromPointer
  const bp = bindingFromPointer({ ctrlKey: false, shiftKey: false, altKey: true, button: 0 });
  check("K-4: bindingFromPointer(Alt+左)", bp.button === 0 && bp.alt === true && bp.code === "" && !bp.ctrl && !bp.shift);

  // 素の左クリック（無修飾 button=0）は割り当て不可＝ sanitize で落ちる。修飾つき/中/右は通る
  const s = (v: unknown) => sanitizeKeysSettings({ activeId: "user1", presets: [{ id: "user1", name: "X", bindings: { "edit.pickColor": v } }] }).presets[0].bindings["edit.pickColor"];
  check("K-4: 素の左クリック（button0 無修飾）は拒否", s({ code: "", button: 0 }) === undefined);
  check("K-4: Alt＋左クリックは受理", !!s({ code: "", button: 0, alt: true }));
  check("K-4: 右クリック無修飾は受理", !!s({ code: "", button: 2 }));
  check("K-4: 従来のキーボード割り当ては受理（追加のみ・後方互換）", !!s({ code: "KeyP" }));

  // 既定プリセット（標準）に Alt＋クリック＝スポイト（edit.pickColor）が入っている
  const std = BUILTIN_PRESETS.find((p) => p.id === "standard")!;
  const lut = buildLookup(std);
  check("K-4: 標準プリセットで Alt+クリック→edit.pickColor", (lut.get("A|B0") ?? []).includes("edit.pickColor"));
  // 素の左クリック（|B0）には何も割り当たっていない（描画と衝突しない）
  check("K-4: 素の左クリックはどのコマンドにも一致しない", !lut.get("|B0"));

  // 旧 keymap（code だけ）がそのまま読める（追加のみ）
  const old = sanitizeKeysSettings({ activeId: "user1", presets: [{ id: "user1", name: "旧", bindings: { "tool.pen": { code: "KeyP" }, "edit.undo": { code: "KeyZ", ctrl: true } } }] });
  const op = old.presets[0].bindings;
  check("K-4: 旧形式の keymap が保存→読込でそのまま", op["tool.pen"]?.code === "KeyP" && op["edit.undo"]?.ctrl === true && op["edit.undo"]?.code === "KeyZ");

  // keyLabel はポインタ割り当てを「Alt+クリック」と表示する
  const lbl = keyLabel({ code: "", button: 0, alt: true } as KeyBinding);
  check("K-4: keyLabel が Alt+クリック表記", lbl.includes("Alt") && lbl.includes("クリック"), lbl);
}

// ================= X-1: MP4 ループ（音声のサンプル連結） =================
{
  // 44バイトヘッダ + PCM の最小 WAV を手作り
  const mkWav = (pcmBytes: number[]): Uint8Array => {
    const data = new Uint8Array(pcmBytes);
    const out = new Uint8Array(44 + data.length);
    const v = new DataView(out.buffer);
    const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
    ws(0, "RIFF"); v.setUint32(4, 36 + data.length, true); ws(8, "WAVE");
    ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, 48000, true); v.setUint32(28, 48000 * 2 * 2, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, data.length, true); out.set(data, 44);
    return out;
  };
  const wav = mkWav([1, 2, 3, 4, 5, 6, 7, 8]); // 8バイトPCM

  // x1 はそのまま（同一参照＝エンコーダ入力が従来と完全一致）
  check("X-1: repeatWav(wav,1) は同一参照（x1 バイト一致）", repeatWav(wav, 1) === wav);

  const r3 = repeatWav(wav, 3);
  const pcmLen = wav.length - 44;
  check("X-1: 3連結の全長 = 44 + PCM×3", r3.length === 44 + pcmLen * 3);
  const dv = new DataView(r3.buffer);
  check("X-1: data チャンクサイズが PCM×3", dv.getUint32(40, true) === pcmLen * 3);
  check("X-1: RIFF サイズが 36 + PCM×3", dv.getUint32(4, true) === 36 + pcmLen * 3);
  // PCM が「周ごとに頭から」= 同じ1周ぶんの繰り返し（境界に無音・欠落なし）
  let concatOk = true;
  for (let k = 0; k < 3; k++)
    for (let i = 0; i < pcmLen; i++) if (r3[44 + k * pcmLen + i] !== wav[44 + i]) concatOk = false;
  check("X-1: 各周が1周ぶんの同一PCM（頭から・繋ぎ目に欠落なし）", concatOk);
  // ヘッダ（fmt 等）は不変
  let hdrOk = true;
  for (let i = 0; i < 44; i++) if (i !== 4 && i !== 40 && r3[i] !== wav[i]) hdrOk = false;
  check("X-1: ヘッダはサイズ2箇所以外そのまま", hdrOk);
}

console.log(`m16 smoke: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
