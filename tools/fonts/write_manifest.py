# M10-1a P-1: 取得物の SHA-256 と取得元 URL を tools/fonts/MANIFEST.txt に記録する
#
#   python tools/fonts/write_manifest.py
#
# 「後から同じものを取り直せる」状態を作るのが目的（GPL ソース保管と同じ考え方）。
import hashlib
import os
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DL = os.path.join(HERE, "download")
ASSETS = os.path.join(ROOT, "assets", "fonts")

# (配布名, 取得元URL, ダウンロード物からの相対パス, サブセット後の出力名)
ENTRIES = [
    ("美咲ゴシック Regular",
     "https://littlelimit.net/arc/misaki/misaki_ttf_2021-05-05.zip",
     "misaki_ttf_2021-05-05/misaki_gothic.ttf", "misaki.woff2"),
    ("PixelMplus12 Regular",
     "https://github.com/itouhiro/PixelMplus/releases/download/v1.0.0/PixelMplus-20130602.zip",
     "PixelMplus-20130602/PixelMplus-20130602/PixelMplus12-Regular.ttf", "pixel12.woff2"),
    ("PixelMplus12 Bold",
     "https://github.com/itouhiro/PixelMplus/releases/download/v1.0.0/PixelMplus-20130602.zip",
     "PixelMplus-20130602/PixelMplus-20130602/PixelMplus12-Bold.ttf", "pixel12-bold.woff2"),
    ("Zen Maru Gothic Regular",
     "https://github.com/googlefonts/zen-marugothic/raw/main/fonts/ttf/ZenMaruGothic-Regular.ttf",
     "ZenMaruGothic-Regular.ttf", "maru.woff2"),
    ("Zen Maru Gothic Bold",
     "https://github.com/googlefonts/zen-marugothic/raw/main/fonts/ttf/ZenMaruGothic-Bold.ttf",
     "ZenMaruGothic-Bold.ttf", "maru-bold.woff2"),
    ("Dela Gothic One Regular",
     "https://github.com/syakuzen/DelaGothic/raw/master/fonts/ttf/DelaGothicOne-Regular.ttf",
     "DelaGothicOne-Regular.ttf", "pop.woff2"),
    ("Zen Antique Regular",
     "https://github.com/googlefonts/zen-antique/raw/main/fonts/ttf/ZenAntique-Regular.ttf",
     "ZenAntique-Regular.ttf", "mincho.woff2"),
]

ARCHIVES = [
    ("misaki_ttf_2021-05-05.zip",
     "https://littlelimit.net/arc/misaki/misaki_ttf_2021-05-05.zip"),
    ("PixelMplus-20130602.zip",
     "https://github.com/itouhiro/PixelMplus/releases/download/v1.0.0/PixelMplus-20130602.zip"),
]

LICENSES = [
    ("OFL-1.1_ZenMaruGothic.txt", "https://github.com/googlefonts/zen-marugothic/raw/main/OFL.txt"),
    ("OFL-1.1_DelaGothicOne.txt", "https://github.com/syakuzen/DelaGothic/raw/master/OFL.txt"),
    ("OFL-1.1_ZenAntique.txt", "https://github.com/googlefonts/zen-antique/raw/main/OFL.txt"),
    ("M+_FONT_LICENSE_E.txt", "PixelMplus-20130602.zip 内 mplus_bitmap_fonts/LICENSE_E"),
    ("M+_FONT_LICENSE_J.txt", "PixelMplus-20130602.zip 内 mplus_bitmap_fonts/LICENSE_J"),
    ("misaki_readme_ja.txt", "misaki_ttf_2021-05-05.zip 内 misaki.txt（ライセンス条項を含む同梱文書）"),
]


def sha256(p: str) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    lines = []
    w = lines.append
    w("メモアニマ 同梱フォント MANIFEST")
    w("生成: tools/fonts/write_manifest.py / " + date.today().isoformat())
    w("")
    w("後から同一物を取り直せるようにするための記録。すべて一次配布元から取得している")
    w("（ミラー・フォントまとめサイトは使わない）。取得は tools/fonts/fetch_fonts.ps1。")
    w("")
    w("=" * 78)
    w("■ 配布アーカイブ（取得したままのもの）")
    w("=" * 78)
    for name, url in ARCHIVES:
        p = os.path.join(DL, name)
        if not os.path.exists(p):
            continue
        w(name)
        w("  URL    : " + url)
        w("  size   : {:,} bytes".format(os.path.getsize(p)))
        w("  sha256 : " + sha256(p))
        w("")
    w("=" * 78)
    w("■ フォント原本（サブセット前）と assets/fonts への出力（サブセット後）")
    w("=" * 78)
    for label, url, rel, out in ENTRIES:
        src = os.path.join(DL, rel.replace("/", os.sep))
        dst = os.path.join(ASSETS, out)
        w(label)
        w("  URL       : " + url)
        if os.path.exists(src):
            w("  原本      : download/" + rel)
            w("    size    : {:,} bytes".format(os.path.getsize(src)))
            w("    sha256  : " + sha256(src))
        if os.path.exists(dst):
            w("  サブセット: assets/fonts/" + out)
            w("    size    : {:,} bytes".format(os.path.getsize(dst)))
            w("    sha256  : " + sha256(dst))
        w("")
    w("=" * 78)
    w("■ ライセンス条文（tools/fonts/licenses/）")
    w("=" * 78)
    for name, src in LICENSES:
        p = os.path.join(HERE, "licenses", name)
        if not os.path.exists(p):
            continue
        w(name)
        w("  出典   : " + src)
        w("  sha256 : " + sha256(p))
        w("")
    w("=" * 78)
    w("■ サブセット条件")
    w("=" * 78)
    cs = os.path.join(HERE, "subset_charset.txt")
    if os.path.exists(cs):
        text = open(cs, encoding="utf-8").read().replace("\n", "")
        w("文字集合 : tools/fonts/subset_charset.txt（{} 字・うち常用漢字 2,136 字）".format(len(text)))
        w("  sha256 : " + sha256(cs))
    w("コマンド : python tools/fonts/subset.py")
    w("           （pyftsubset --flavor=woff2 --layout-features= --no-hinting）")

    out_path = os.path.join(HERE, "MANIFEST.txt")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print("manifest written: " + out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
