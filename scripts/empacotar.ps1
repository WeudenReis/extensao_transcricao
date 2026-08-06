# Gera o pacote de distribuicao (ZIP) pra mandar pra outras pessoas.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\empacotar.ps1
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$nome = 'chatpro-transcricao'
$dist = Join-Path $raiz 'dist'
$stage = Join-Path $dist $nome

Write-Host 'Montando o pacote de distribuicao...' -ForegroundColor Cyan
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 1) Extensao (pronta pra "Load unpacked")
Copy-Item (Join-Path $raiz 'extension') (Join-Path $stage 'extension') -Recurse

# 2) Servidor - SEM node_modules, dist e dados locais (leve).
$serverDst = Join-Path $stage 'server'
New-Item -ItemType Directory -Path $serverDst -Force | Out-Null
Get-ChildItem (Join-Path $raiz 'server') -Force |
  Where-Object { $_.Name -notin @('node_modules', 'dist', 'data', '.env', 'smoke-out.log', 'smoke-err.log') } |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $serverDst $_.Name) -Recurse -Force }

# 3) Instalador + guia na raiz do pacote.
Copy-Item (Join-Path $PSScriptRoot 'pacote\INSTALAR.bat') $stage
Copy-Item (Join-Path $PSScriptRoot 'pacote\LEIA-ME.txt') $stage

# 4) Zipar.
$versao = (Get-Content (Join-Path $raiz 'extension\manifest.json') -Raw | ConvertFrom-Json).version
$zip = Join-Path $dist "$nome-v$versao.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Pronto: $zip ($mb MB)" -ForegroundColor Green
Write-Host 'Mande esse ZIP para a pessoa. Ela extrai e da dois cliques no INSTALAR.bat.'
