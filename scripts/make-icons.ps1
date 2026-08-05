<#
.SYNOPSIS
    Gera os ícones da extensão chatPro Meet Transcripts (16/32/48/128 px).

.DESCRIPTION
    Desenha um quadrado arredondado verde chatPro (#25D066) com um "c" branco
    centralizado, usando System.Drawing (disponível no Windows PowerShell 5.1
    sem nenhuma dependência externa). Salva os PNGs em extension/icons/.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
#>

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

# Pasta de destino: <repo>/extension/icons (relativa a este script)
$repoRoot = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $repoRoot 'extension\icons'
if (-not (Test-Path $iconsDir)) {
    New-Item -ItemType Directory -Force $iconsDir | Out-Null
}

# Verde principal chatPro
$green = [System.Drawing.Color]::FromArgb(255, 0x25, 0xD0, 0x66)
$white = [System.Drawing.Color]::White

function New-RoundedRectPath {
    param(
        [System.Drawing.RectangleF]$Rect,
        [float]$Radius
    )
    # GraphicsPath com 4 arcos: retângulo de cantos arredondados
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
    $path.AddArc($Rect.Right - $d, $Rect.Y, $d, $d, 270, 90)
    $path.AddArc($Rect.Right - $d, $Rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($Rect.X, $Rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-Icon {
    param(
        [int]$Size,
        [string]$OutFile
    )

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $g.Clear([System.Drawing.Color]::Transparent)

        # Quadrado arredondado verde ocupando o canvas todo
        $radius = [Math]::Max(2, [float]$Size * 0.22)
        $rect = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
        $path = New-RoundedRectPath -Rect $rect -Radius $radius
        $brush = New-Object System.Drawing.SolidBrush($green)
        $g.FillPath($brush, $path)
        $brush.Dispose()
        $path.Dispose()

        # "c" branco centralizado (c minúsculo, como em "chatPro")
        $fontSize = [float]($Size * 0.62)
        $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $textBrush = New-Object System.Drawing.SolidBrush($white)
        $format = New-Object System.Drawing.StringFormat
        $format.Alignment = [System.Drawing.StringAlignment]::Center
        $format.LineAlignment = [System.Drawing.StringAlignment]::Center
        # Pequeno ajuste vertical: o "c" minúsculo fica visualmente baixo
        $layout = New-Object System.Drawing.RectangleF(0, (-$Size * 0.06), $Size, $Size)
        $g.DrawString('c', $font, $textBrush, $layout, $format)
        $format.Dispose()
        $textBrush.Dispose()
        $font.Dispose()

        $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host "OK  $OutFile"
    }
    finally {
        $g.Dispose()
        $bmp.Dispose()
    }
}

foreach ($size in 16, 32, 48, 128) {
    $out = Join-Path $iconsDir ("icon{0}.png" -f $size)
    New-Icon -Size $size -OutFile $out
}

Write-Host "Ícones gerados em $iconsDir"
