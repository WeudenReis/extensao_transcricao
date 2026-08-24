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
# O filtro do .env e por LISTA BRANCA de proposito. Antes ele excluia so o
# nome exato '.env', e um '.env.backup-antes-recall' foi parar dentro do ZIP
# com GOOGLE_CLIENT_SECRET, VOREO_API_KEY, STT_API_KEY e TOKEN_ENCRYPTION_KEY
# la dentro. Lista negra de nomes exatos nao cobre o arquivo que ninguem
# previu; so '.env.example' entra, o resto fica de fora por padrao.
Get-ChildItem (Join-Path $raiz 'server') -Force |
  Where-Object {
    $_.Name -notin @('node_modules', 'dist', 'data', 'smoke-out.log', 'smoke-err.log') -and
    -not ($_.Name -like '.env*' -and $_.Name -ne '.env.example')
  } |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $serverDst $_.Name) -Recurse -Force }

# 3) Instalador + guia na raiz do pacote.
Copy-Item (Join-Path $PSScriptRoot 'pacote\INSTALAR.bat') $stage
Copy-Item (Join-Path $PSScriptRoot 'pacote\LEIA-ME.txt') $stage

# 3.5) TRAVA DE SEGURANCA - confere o que esta montado, nao o que foi filtrado.
#
# O filtro acima ja deveria bastar. Esta checagem existe porque o filtro FALHOU
# uma vez, em silencio, e o ZIP so seria aberto na maquina de outra pessoa - o
# lugar mais caro possivel pra descobrir que vazou segredo. Aqui a montagem
# para antes de existir arquivo pra mandar.
$proibidos = Get-ChildItem $stage -Recurse -Force -File |
  Where-Object {
    ($_.Name -like '.env*' -and $_.Name -ne '.env.example') -or
    $_.Extension -in @('.db', '.sqlite', '.pem', '.key')
  }
if ($proibidos) {
  Write-Host ''
  Write-Host 'ABORTADO: arquivo com segredo entrou no pacote.' -ForegroundColor Red
  $proibidos | ForEach-Object { Write-Host ("  " + $_.FullName.Substring($stage.Length + 1)) -ForegroundColor Red }
  Remove-Item $stage -Recurse -Force
  exit 1
}
Write-Host 'Trava de seguranca: nenhum segredo no pacote.' -ForegroundColor DarkGray

# 4) Zipar.
$versao = (Get-Content (Join-Path $raiz 'extension\manifest.json') -Raw | ConvertFrom-Json).version
$zip = Join-Path $dist "$nome-v$versao.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Pronto: $zip ($mb MB)" -ForegroundColor Green
Write-Host 'Mande esse ZIP para a pessoa. Ela extrai e da dois cliques no INSTALAR.bat.'
