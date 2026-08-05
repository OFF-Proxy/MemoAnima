# M10-1a P-3: 取得した TTF を subset_charset.txt でサブセットし、assets/fonts/ へ WOFF2 出力する
#
#   python tools/fonts/subset.py
#
# 出力名は FontKey（M10-1c で使う）に対応させる:
#   misaki / pixel12 / pixel12-bold / maru / maru-bold / pop / mincho
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


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0
    print("== サブセット化 ==")
    rows = []
    for name, src, is_dot in JOBS:
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

    print(f"\n合計: {total/1024/1024:.2f} MB （上限 6 MB）")
    if total >= 6 * 1024 * 1024:
        print("FATAL: 合計が 6 MB を超えた。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
