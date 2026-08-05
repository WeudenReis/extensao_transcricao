<#
.SYNOPSIS
    Empacota a extensão chatPro Meet Transcripts em um .zip para distribuição.

.DESCRIPTION
    Lê a versão do extension/manifest.json e gera
    dist/chatpro-meet-transcripts-v{versão}.zip com o CONTEÚDO da pasta
    extension/ na raiz do zip (ao descompactar, aponte o "Carregar sem
    compactação" do Chrome para a pasta extraída).

    Compatível com Windows PowerShell 5.1 (usa apenas Compress-Archive).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\package.ps1
#>

$ErrorActionPreference = 'Stop'

# Caminhos relativos a este script (funciona de qualquer diretório)
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionDir = Join-Path $repoRoot 'extension'
$manifestPath = Join-Path $extensionDir 'manifest.json'
$distDir = Join-Path $repoRoot 'dist'

if (-not (Test-Path $manifestPath)) {
    throw "manifest.json não encontrado em $manifestPath"
}

# Lê a versão do manifest (PS 5.1: ConvertFrom-Json retorna PSCustomObject)
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'Campo "version" não encontrado no manifest.json'
}

if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Force $distDir | Out-Null
}

$zipPath = Join-Path $distDir ("chatpro-meet-transcripts-v{0}.zip" -f $version)

# Remove zip anterior da mesma versão (Compress-Archive -Force também
# sobrescreve, mas remover antes evita zips "misturados" em edge cases)
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force -Confirm:$false
}

# "$extensionDir\*" coloca o CONTEÚDO da extensão na raiz do zip —
# manifest.json precisa estar na raiz para o Chrome aceitar a pasta extraída.
Compress-Archive -Path (Join-Path $extensionDir '*') -DestinationPath $zipPath

$sizeKb = [Math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "Pacote gerado: $zipPath ($sizeKb KB)"
