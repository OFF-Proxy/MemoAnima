# M10-1a P-1: 同梱フォントを一次配布元から取得する（ビルド時のみ・アプリ実行時は一切通信しない）
#
#   powershell -ExecutionPolicy Bypass -File tools/fonts/fetch_fonts.ps1
#
# 取得物は tools/fonts/download/（.gitignore 済み・再取得可能）に置き、
# SHA-256 と取得元 URL を tools/fonts/MANIFEST.txt に記録する。
# ライセンス条文は tools/fonts/licenses/ に保存する（OFL 1.1 第2条・追跡対象）。
# ミラーやフォントまとめサイトは使わない（改変版を掴まないため）。
#
# この後の手順:
#   python tools/fonts/make_charset.py     # 文字集合（常用漢字は Unicode Unihan 由来）
#   python tools/fonts/subset.py           # → assets/fonts/*.woff2
#   npx tsx tools/fonts/make_sample_sheet.ts  # 見本シート＋中間調の数値検証
$ErrorActionPreference = "Stop"
$toolDir = $PSScriptRoot
$dl = Join-Path $toolDir "download"
$licDir = Join-Path $toolDir "licenses"
New-Item -ItemType Directory -Force $dl, $licDir | Out-Null

# --- フォント本体（一次配布元のみ） ---
$sources = @(
    @{ Url = "https://littlelimit.net/arc/misaki/misaki_ttf_2021-05-05.zip";                            File = "misaki_ttf_2021-05-05.zip" }
    @{ Url = "https://github.com/itouhiro/PixelMplus/releases/download/v1.0.0/PixelMplus-20130602.zip"; File = "PixelMplus-20130602.zip" }
    @{ Url = "https://github.com/googlefonts/zen-marugothic/raw/main/fonts/ttf/ZenMaruGothic-Regular.ttf"; File = "ZenMaruGothic-Regular.ttf" }
    @{ Url = "https://github.com/googlefonts/zen-marugothic/raw/main/fonts/ttf/ZenMaruGothic-Bold.ttf";    File = "ZenMaruGothic-Bold.ttf" }
    @{ Url = "https://github.com/syakuzen/DelaGothic/raw/master/fonts/ttf/DelaGothicOne-Regular.ttf";      File = "DelaGothicOne-Regular.ttf" }
    @{ Url = "https://github.com/googlefonts/zen-antique/raw/main/fonts/ttf/ZenAntique-Regular.ttf";       File = "ZenAntique-Regular.ttf" }
)

# --- OFL 条文（各リポジトリの一次情報） ---
$licenses = @(
    @{ Url = "https://github.com/googlefonts/zen-marugothic/raw/main/OFL.txt"; File = "OFL-1.1_ZenMaruGothic.txt" }
    @{ Url = "https://github.com/syakuzen/DelaGothic/raw/master/OFL.txt";      File = "OFL-1.1_DelaGothicOne.txt" }
    @{ Url = "https://github.com/googlefonts/zen-antique/raw/main/OFL.txt";    File = "OFL-1.1_ZenAntique.txt" }
)

function Get-Remote($url, $dest) {
    if (Test-Path $dest) { Write-Host ("  skip (取得済み): " + (Split-Path -Leaf $dest)); return }
    Write-Host ("  GET " + $url)
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -MaximumRedirection 10
}

Write-Host "== フォント本体の取得 =="
foreach ($s in $sources) { Get-Remote $s.Url (Join-Path $dl $s.File) }

Write-Host "== OFL 条文の取得 =="
foreach ($l in $licenses) { Get-Remote $l.Url (Join-Path $licDir $l.File) }

Write-Host "== ZIP の展開 =="
foreach ($z in @("misaki_ttf_2021-05-05.zip", "PixelMplus-20130602.zip")) {
    $zp = Join-Path $dl $z
    $out = Join-Path $dl ([IO.Path]::GetFileNameWithoutExtension($z))
    if (Test-Path $out) { Remove-Item -Recurse -Force $out }
    Expand-Archive -Path $zp -DestinationPath $out -Force
    Write-Host ("  展開: " + $z)
}

# M+ FONT LICENSE と美咲の同梱文書は ZIP の中にあるので取り出す
Write-Host "== ZIP 同梱のライセンス条文を取り出し =="
$mplusDir = Join-Path $dl "PixelMplus-20130602/PixelMplus-20130602/mplus_bitmap_fonts"
Copy-Item (Join-Path $mplusDir "LICENSE_E") (Join-Path $licDir "M+_FONT_LICENSE_E.txt") -Force
Copy-Item (Join-Path $mplusDir "LICENSE_J") (Join-Path $licDir "M+_FONT_LICENSE_J.txt") -Force
Copy-Item (Join-Path $dl "misaki_ttf_2021-05-05/misaki.txt") (Join-Path $licDir "misaki_readme_ja.txt") -Force

Write-Host "== MANIFEST.txt の生成 =="
python (Join-Path $toolDir "write_manifest.py")
Write-Host "== 完了 =="
