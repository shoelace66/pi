param(
	[Parameter(Mandatory = $true)]
	[string]$InputPng,
	[Parameter(Mandatory = $true)]
	[string]$OutputIco
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $InputPng))
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = New-Object System.Collections.Generic.List[byte[]]

try {
	foreach ($size in $sizes) {
		$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
		try {
			$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
			try {
				$graphics.Clear([System.Drawing.Color]::Transparent)
				$graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
				$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
				$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
				$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
				$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
				$graphics.DrawImage($source, 0, 0, $size, $size)
			} finally {
				$graphics.Dispose()
			}
			$stream = New-Object System.IO.MemoryStream
			try {
				$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
				$images.Add($stream.ToArray())
			} finally {
				$stream.Dispose()
			}
		} finally {
			$bitmap.Dispose()
		}
	}
} finally {
	$source.Dispose()
}

$outputDirectory = Split-Path -Parent $OutputIco
if ($outputDirectory) { New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null }
$file = [System.IO.File]::Open($OutputIco, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($file)
try {
	$writer.Write([uint16]0)
	$writer.Write([uint16]1)
	$writer.Write([uint16]$images.Count)
	$offset = 6 + 16 * $images.Count
	for ($index = 0; $index -lt $images.Count; $index++) {
		$size = $sizes[$index]
		$writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
		$writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
		$writer.Write([byte]0)
		$writer.Write([byte]0)
		$writer.Write([uint16]1)
		$writer.Write([uint16]32)
		$writer.Write([uint32]$images[$index].Length)
		$writer.Write([uint32]$offset)
		$offset += $images[$index].Length
	}
	foreach ($image in $images) { $writer.Write($image) }
} finally {
	$writer.Dispose()
	$file.Dispose()
}

Write-Output "Wrote $OutputIco"
