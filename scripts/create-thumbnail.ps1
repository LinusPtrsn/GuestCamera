param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$ThumbnailPath
)

Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($SourcePath)
try {
  $max = 420
  $ratio = [Math]::Min($max / $source.Width, $max / $source.Height)
  if ($ratio -gt 1) { $ratio = 1 }

  $width = [Math]::Max(1, [int][Math]::Round($source.Width * $ratio))
  $height = [Math]::Max(1, [int][Math]::Round($source.Height * $ratio))
  $bitmap = New-Object System.Drawing.Bitmap $width, $height

  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, $width, $height)
      $bitmap.Save($ThumbnailPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    } finally {
      $graphics.Dispose()
    }
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $source.Dispose()
}
