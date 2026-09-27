# M10-1a P-3: 取得した TTF を subset_charset.txt でサブセットし、assets/fonts/ へ WOFF2 出力する
#
#   python tools/fonts/subset.py --only kaku,dot16    # ★その出力名だけ作る（ふだんはこちら）
#   python tools/fonts/subset.py --all                # 全部作り直す（★出荷済みの書体も差し替わる）
#
# ★引数なしでは走らない。「うっかり全部作り直す」が一番損な事故なので、
#   どちらをしたいのかを**必ず明示**させる（Codex 指摘）。
#
# 出力名は FontKey（M10-1c で使う）に対応させる:
#   misaki / pixel12 / pixel12-bold / maru / maru-bold / pop / mincho
#   kaku / dot16 / tegaki / shippori / reggae         （A-71・V176 で追加）
#
# ★--only が要る理由（A-71 でここを踏んだ）:
#   このスクリプトは JOBS を**全部作り直す**。書体を1本足したいだけのときに素で走らせると、
#   **既存の woff2 も作り直される**。fontTools の版が当時と違えばバイト列が変わり、
#   見た目はほぼ同じなので**誰も気づけない**（＝出荷済みの書体が黙って差し替わる）。
#   足すときは必ず `--only` で新しい分だけ作ること。
#   `scripts/v176_smoke.ts` [S-11] が既存 7 本の SHA-256 を固定していて、破ると赤になる。
#
# --no-hinting はドット焼き込みでは無意味に容量を食うヒンティングを落とすため。
# ただしドット系（美咲・PixelMplus）は設計グリッドが崩れると意味がないので、
# サブセット前後で **glyf アウトラインの座標が完全一致すること** を検証する（verify_outlines）。
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DL = os.path.join(HERE, "download")
OUT_DIR = os.path.join(ROOT, "assets", "fonts")
CHARSET = os.path.join(HERE, "subset_charset.txt")

# (出力名, 入力パス, ドット系か)
JOBS = [
    ("misaki", os.path.join(DL, "misaki_ttf_2021-05-05", "misaki_gothic.ttf"), True),
    ("pixel12", os.path.join(DL, "PixelMplus-20130602", "PixelMplus-20130602", "PixelMplus12-Regular.ttf"), True),
    ("pixel12-bold", os.path.join(DL, "PixelMplus-20130602", "PixelMplus-20130602", "PixelMplus12-Bold.ttf"), True),
    ("maru", os.path.join(DL, "ZenMaruGothic-Regular.ttf"), False),
    ("maru-bold", os.path.join(DL, "ZenMaruGothic-Bold.ttf"), False),
    ("pop", os.path.join(DL, "DelaGothicOne-Regular.ttf"), False),
    ("mincho", os.path.join(DL, "ZenAntique-Regular.ttf"), False),
    # A-71（V176）で追加した5書体。dot16 はドット系なので verify_outlines を通す
    ("kaku", os.path.join(DL, "ZenKakuGothicNew-Regular.ttf"), False),
    ("dot16", os.path.join(DL, "DotGothic16-Regular.ttf"), True),
    ("tegaki", os.path.join(DL, "Yomogi-Regular.ttf"), False),
    ("shippori", os.path.join(DL, "ShipporiMincho-Regular.ttf"), False),
    ("reggae", os.path.join(DL, "ReggaeOne-Regular.ttf"), False),
]


def subset_one(name: str, src: str) -> str:
    dst = os.path.join(OUT_DIR, f"{name}.woff2")
    cmd = [
        sys.executable, "-m", "fontTools.subset", src,
        f"--text-file={CHARSET}",
        f"--output-file={dst}",
        "--flavor=woff2",
        "--layout-features=",
        "--no-hinting",
    ]
    subprocess.run(cmd, check=True, cwd=ROOT)
    return dst


def verify_outlines(src: str, dst: str) -> tuple:
    """サブセット前後で、共通するグリフのアウトライン座標が完全一致するか検証する。
    ドット系フォントで --no-hinting がアウトラインを動かしていないことの証拠。"""
    from fontTools.ttLib import TTFont

    a, b = TTFont(src), TTFont(dst)
    ga, gb = a.getGlyphSet(), b.getGlyphSet()
    cmap_a, cmap_b = a.getBestCmap(), b.getBestCmap()
    from fontTools.pens.recordingPen import RecordingPen

    checked = mismatch = 0
    for cp, gname_b in cmap_b.items():
        gname_a = cmap_a.get(cp)
        if gname_a is None:
            continue
        pa, pb = RecordingPen(), RecordingPen()
        ga[gname_a].draw(pa)
        gb[gname_b].draw(pb)
        checked += 1
        if pa.value != pb.value:
            mismatch += 1
    a.close()
    b.close()
    return checked, mismatch


def parse_only(argv: list) -> set:
    """`--only a,b` / `--only=a,b` で作る出力名を絞る。`--all` のときだけ全部作る。

    ★**倒れる向きが大事**（Codex 指摘・重大度 高）。ここは「既存の出荷物を黙って作り直さない」
    ための入口なので、**迷ったら止める**。打ち間違い（`--onyl kaku`）・値なしの `--only`・
    空の `--only=` を黙って「全部作り直す」側に倒すと、足した仕組みの意味が無くなる。
    """
    known = {name for name, _, _ in JOBS}
    want = set()
    all_flag = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--all":
            all_flag = True
        elif a == "--only":
            if i + 1 >= len(argv) or argv[i + 1].startswith("-"):
                print("FATAL: --only に値がありません（例: --only kaku,dot16）", file=sys.stderr)
                raise SystemExit(2)
            want |= {s.strip() for s in argv[i + 1].split(",") if s.strip()}
            i += 1
        elif a.startswith("--only="):
            part = {s.strip() for s in a[len("--only="):].split(",") if s.strip()}
            if not part:
                print("FATAL: --only= の中身が空です（例: --only=kaku,dot16）", file=sys.stderr)
                raise SystemExit(2)
            want |= part
        else:
            print("FATAL: 知らない引数です: " + a, file=sys.stderr)
            print("       使い方: subset.py --all | subset.py --only <出力名,...>", file=sys.stderr)
            raise SystemExit(2)
        i += 1

    unknown = want - known
    if unknown:
        print("FATAL: --only に知らない出力名があります: " + ", ".join(sorted(unknown)), file=sys.stderr)
        print("       選べるのは: " + ", ".join(sorted(known)), file=sys.stderr)
        raise SystemExit(2)
    if want and all_flag:
        print("FATAL: --all と --only は同時に指定できません", file=sys.stderr)
        raise SystemExit(2)
    if not want and not all_flag:
        print("FATAL: 何を作るのか指定してください。", file=sys.stderr)
        print("       既存の woff2 を作り直すと**出荷済みの書体が黙って差し替わります**。", file=sys.stderr)
        print("       足したいものだけ: subset.py --only kaku,dot16", file=sys.stderr)
        print("       本当に全部作り直す: subset.py --all", file=sys.stderr)
        raise SystemExit(2)
    return want


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    only = parse_only(sys.argv[1:])
    total = 0
    if only:
        print("== サブセット化（--only: " + ", ".join(sorted(only)) + "） ==")
        print("   ※ 指定外の woff2 には触りません（既存の出荷物を黙って作り直さないため）")
    else:
        print("== サブセット化（全部作り直します） ==")
    rows = []
    for name, src, is_dot in JOBS:
        if only and name not in only:
            continue
        if not os.path.exists(src):
            print(f"FATAL: 入力が見つかりません: {src}", file=sys.stderr)
            return 1
        dst = subset_one(name, src)
        size = os.path.getsize(dst)
        total += size
        note = ""
        if is_dot:
            checked, mismatch = verify_outlines(src, dst)
            note = f"アウトライン一致 {checked - mismatch}/{checked}"
            if mismatch:
                print(f"FATAL: {name} のアウトラインがサブセットで変化した（{mismatch} グリフ）。設計グリッドが壊れる。", file=sys.stderr)
                return 1
        rows.append((name, os.path.getsize(src), size, note))
        print(f"  {name:<14} {size/1024:8.1f} KB  {note}")

    # ★上限は「この回で作った分」ではなく **assets/fonts に実際に置かれている全部**で測る。
    #  --only のときに作った分だけ足すと、同梱量の見張りが**黙って無効になる**
    shipped = sum(
        os.path.getsize(os.path.join(OUT_DIR, n))
        for n in sorted(os.listdir(OUT_DIR))
        if n.endswith(".woff2")
    )
    print(f"\nこの回で作った分: {total/1024/1024:.2f} MB")
    print(f"同梱の合計      : {shipped/1024/1024:.2f} MB （上限 6 MB）")
    if shipped >= 6 * 1024 * 1024:
        print("FATAL: 同梱の合計が 6 MB を超えた。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
