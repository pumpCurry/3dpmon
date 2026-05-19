# 3dpmon アイコン生成スクリプト
# build/icon-source.png (256x256 以上) から build/icon.ico を生成する
#
# 使い方: powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1
#
# 出力: build/icon.ico (256/128/64/48/32/16 のマルチサイズ ico)

param(
  [string]$SourcePng = "build/icon-source.png",
  [string]$OutIco    = "build/icon.ico"
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $SourcePng)) {
  Write-Error "ソース PNG が見つかりません: $SourcePng"
  exit 1
}

Write-Host "[make-icon] ソース: $SourcePng"

# 各サイズの PNG をメモリ上に作成
$sizes = @(256, 128, 64, 48, 32, 16)
$srcBitmap = [System.Drawing.Image]::FromFile((Resolve-Path $SourcePng))

$pngStreams = @()
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($srcBitmap, 0, 0, $size, $size)
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $pngStreams += @{ Size = $size; Stream = $ms }
}
$srcBitmap.Dispose()

# ICO ファイルフォーマットを構築
# ヘッダ: 0(2byte reserved) + 1(2byte type=icon) + count(2byte)
# 各エントリ: width(1) + height(1) + colorCount(1) + reserved(1) + planes(2) + bpp(2) + size(4) + offset(4)
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out

# ICONDIR
$bw.Write([uint16]0)             # Reserved
$bw.Write([uint16]1)             # Type: 1=Icon
$bw.Write([uint16]$sizes.Count)  # Count

$headerSize = 6 + 16 * $sizes.Count
$dataOffset = $headerSize

# ICONDIRENTRY × N
foreach ($p in $pngStreams) {
  $w = $p.Size
  $h = $p.Size
  if ($p.Size -ge 256) { $w = 0; $h = 0 }
  $bw.Write([byte]$w)             # Width
  $bw.Write([byte]$h)             # Height
  $bw.Write([byte]0)              # ColorCount
  $bw.Write([byte]0)              # Reserved
  $bw.Write([uint16]1)            # Planes
  $bw.Write([uint16]32)           # BitsPerPixel
  $bw.Write([uint32]$p.Stream.Length)  # SizeInBytes
  $bw.Write([uint32]$dataOffset)  # Offset
  $dataOffset += [int]$p.Stream.Length
}

# 各 PNG データを連結
foreach ($p in $pngStreams) {
  $bw.Write($p.Stream.ToArray())
}

# ファイル出力
[System.IO.File]::WriteAllBytes($OutIco, $out.ToArray())
$bw.Dispose()
$out.Dispose()

foreach ($p in $pngStreams) { $p.Stream.Dispose() }

$fileInfo = Get-Item $OutIco
Write-Host "[make-icon] 出力完了: $OutIco ($($fileInfo.Length) bytes, $($sizes.Count) サイズ)"
