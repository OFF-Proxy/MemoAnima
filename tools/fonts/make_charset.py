# M10-1a P-2: サブセット文字集合 tools/fonts/subset_charset.txt を生成する
#
#   python tools/fonts/make_charset.py
#
# 収録範囲（HANDOFF_M10_1a.md P-2）:
#   - ASCII 印字可能      U+0020〜U+007E
#   - ひらがな全          U+3041〜U+309F
#   - カタカナ全          U+30A0〜U+30FF
#   - 全角英数・記号      U+FF01〜U+FF5E
#   - 日本語約物          U+3000〜U+303F
#   - 常用漢字 2,136 字   Unicode 公式 Unihan の kJoyoKanji（値 "2010"）
#
# 常用漢字の出典を Unihan にしたのは、文化庁の常用漢字表(2010)を Unicode Consortium が
# 機械可読な形で保持している一次データだから。件数が 2,136 ちょうどになることを
# 検証に使える（ズレたら異常として落とす）。
# kJoyoKanji には値が "U+XXXX" のエントリが4件あるが、これは旧字体から常用漢字form への
# 参照であって常用漢字そのものではないので除外する（参照先は "2010" 側に入っている）。
import io
import os
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(HERE, "download")
UNIHAN_URL = "https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip"
UNIHAN_ZIP = os.path.join(DL, "Unihan.zip")
OUT = os.path.join(HERE, "subset_charset.txt")


def fetch_unihan() -> bytes:
    """Unihan_OtherMappings.txt の中身を返す（zip が無ければ取得する＝ビルド時のみ通信）"""
    os.makedirs(DL, exist_ok=True)
    if not os.path.exists(UNIHAN_ZIP):
        print(f"  GET {UNIHAN_URL}")
        urllib.request.urlretrieve(UNIHAN_URL, UNIHAN_ZIP)
    with zipfile.ZipFile(UNIHAN_ZIP) as z:
        return z.read("Unihan_OtherMappings.txt")


def joyo_kanji() -> list:
    text = fetch_unihan().decode("utf-8")
    out = []
    for line in text.splitlines():
        if line.startswith("#") or "\tkJoyoKanji\t" not in line:
            continue
        cp, _, val = line.split("\t")[:3]
        if val.strip() != "2010":
            continue  # 旧字体からの参照（U+XXXX）は常用漢字本体ではない
        out.append(chr(int(cp[2:], 16)))
    return out


def main() -> int:
    chars = []
    chars += [chr(c) for c in range(0x0020, 0x007E + 1)]  # ASCII 印字可能
    chars += [chr(c) for c in range(0x3000, 0x303F + 1)]  # 日本語約物
    chars += [chr(c) for c in range(0x3041, 0x309F + 1)]  # ひらがな
    chars += [chr(c) for c in range(0x30A0, 0x30FF + 1)]  # カタカナ
    chars += [chr(c) for c in range(0xFF01, 0xFF5E + 1)]  # 全角英数・記号

    joyo = joyo_kanji()
    if len(joyo) != 2136:
        print(f"FATAL: 常用漢字が {len(joyo)} 字（期待 2136）。Unihan の形式が変わった可能性がある。", file=sys.stderr)
        return 1
    chars += joyo

    # 重複除去（順序は保つ＝差分を読みやすくするため）
    seen = set()
    uniq = [c for c in chars if not (c in seen or seen.add(c))]

    # 1行80文字で折り返す（pyftsubset --text-file は改行を無視するので見やすさ優先）
    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        for i in range(0, len(uniq), 80):
            f.write("".join(uniq[i : i + 80]) + "\n")

    print(f"charset written: {OUT}")
    print(f"  ASCII/約物/かな/カナ/全角 = {len(uniq) - len(joyo)} 字")
    print(f"  常用漢字                  = {len(joyo)} 字")
    print(f"  合計（重複除去後）        = {len(uniq)} 字")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
