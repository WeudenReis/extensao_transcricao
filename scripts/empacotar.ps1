# Gera o pacote de distribuicao (ZIP).
#
# Dois modos, para dois mundos:
#
#   empacotar.ps1              pacote COMPLETO (extensao + servidor local).
#                              Sem segredo nenhum. E o modo antigo, de quando
#                              cada atendente rodava o proprio servidor.
#
#   empacotar.ps1 -Producao    SO a pasta da extensao, com a URL do servidor
#                              hospedado e o PANEL_TOKEN ja INJETADOS na copia.
#                              O token e lido de server\.env (linha PANEL_TOKEN)
#                              na hora de empacotar - o codigo-fonte nunca o
#                              contem, porque o repositorio e publico no GitHub.
#
# ATENCAO ao modo -Producao: o ZIP resultante CARREGA a credencial. Distribua
# por canal privado (DM, drive restrito). NUNCA anexe em release do GitHub -
# release e publica, e o token iria junto.
param([switch]$Producao)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $raiz 'dist'
$versao = (Get-Content (Join-Path $raiz 'extension\manifest.json') -Raw | ConvertFrom-Json).version

if ($Producao) {
  # ── MODO PRODUCAO: extensao pronta, zero configuracao ──────────────────────

  # 1) O token vem do server\.env. E o MESMO que o painel gerou na VM - quem
  #    garante isso e quem cola o valor la (ver docs). Sem token, nao ha pacote:
  #    um ZIP sem token instalaria uma extensao que responde 401 em tudo.
  $envPath = Join-Path $raiz 'server\.env'
  if (-not (Test-Path $envPath)) {
    Write-Host 'ABORTADO: server\.env nao existe - e de la que o PANEL_TOKEN sai.' -ForegroundColor Red
    exit 1
  }
  $linhaToken = Get-Content $envPath | Where-Object { $_ -match '^PANEL_TOKEN=(.+)$' } | Select-Object -First 1
  if (-not $linhaToken) {
    Write-Host 'ABORTADO: PANEL_TOKEN vazio ou ausente em server\.env.' -ForegroundColor Red
    Write-Host 'Cole ali o token que o painel gerou (linha PANEL_TOKEN=...) e rode de novo.'
    exit 1
  }
  $token = ($linhaToken -split '=', 2)[1].Trim().Trim('"').Trim("'")
  if ($token.Length -lt 16) {
    Write-Host 'ABORTADO: PANEL_TOKEN tem menos de 16 caracteres - nao parece um token.' -ForegroundColor Red
    exit 1
  }
  # Aspas simples no valor quebrariam o JS gerado ('...token...') sem erro de
  # empacotamento - so na maquina do atendente. Barrar aqui e mais barato.
  if ($token.Contains("'") -or $token.Contains('\')) {
    Write-Host "ABORTADO: PANEL_TOKEN contem aspas ou barra invertida - injetaria JS quebrado." -ForegroundColor Red
    exit 1
  }

  $nome = 'chatpro-reunioes-extensao'
  $stage = Join-Path $dist $nome
  Write-Host 'Montando o pacote de PRODUCAO (so a extensao, ja configurada)...' -ForegroundColor Cyan
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  Copy-Item (Join-Path $raiz 'extension') (Join-Path $stage 'extension') -Recurse
  Copy-Item (Join-Path $PSScriptRoot 'pacote\LEIA-ME-producao.txt') (Join-Path $stage 'LEIA-ME.txt')

  # 2) Injecao na COPIA. Os dois marcadores abaixo existem no fonte com este
  #    texto exato; se alguem os mudar, o replace nao casa e o pacote sairia
  #    com localhost/token vazio em silencio - por isso a verificacao depois
  #    do replace ABORTA em vez de avisar.
  $sw = Join-Path $stage 'extension\background\service-worker.js'
  $utf8SemBom = New-Object System.Text.UTF8Encoding($false)
  $texto = [System.IO.File]::ReadAllText($sw)
  $texto = $texto.Replace(
    "backendUrl: 'http://localhost:3333',",
    "backendUrl: 'https://painel-reunioes.chatpro.com.br/extensao',"
  )
  $texto = $texto.Replace("panelToken: '',", "panelToken: '$token',")
  [System.IO.File]::WriteAllText($sw, $texto, $utf8SemBom)

  $conferido = [System.IO.File]::ReadAllText($sw)
  $ok = ($conferido.Contains('painel-reunioes.chatpro.com.br/extensao')) -and
        (-not $conferido.Contains("panelToken: '',")) -and
        ($conferido.Contains($token))
  if (-not $ok) {
    Write-Host 'ABORTADO: a injecao nao casou com os marcadores do service-worker.' -ForegroundColor Red
    Write-Host 'Alguem mudou as linhas backendUrl/panelToken do PADRAO? Ajuste os marcadores.'
    Remove-Item $stage -Recurse -Force
    exit 1
  }
  Write-Host 'Injetado: URL hospedada + PANEL_TOKEN (valor nao exibido).' -ForegroundColor DarkGray

  $zip = Join-Path $dist "$nome-v$versao.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path $stage -DestinationPath $zip -Force
  Remove-Item $stage -Recurse -Force

  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "Pronto: $zip ($mb MB)" -ForegroundColor Green
  Write-Host ''
  Write-Host 'ESTE ZIP CONTEM O PANEL_TOKEN.' -ForegroundColor Yellow
  Write-Host '  - Mande por canal privado (DM, drive restrito).'
  Write-Host '  - NUNCA anexe em release do GitHub: release e publica.'
  Write-Host '  - O atendente so extrai e carrega a pasta extension no Chrome.'
  exit 0
}

# ── MODO COMPLETO (antigo): extensao + servidor local, sem segredos ──────────
$nome = 'chatpro-transcricao'
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
#
# (So no modo completo: o modo -Producao embute o PANEL_TOKEN de proposito.)
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
$zip = Join-Path $dist "$nome-v$versao.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Pronto: $zip ($mb MB)" -ForegroundColor Green
Write-Host 'Mande esse ZIP para a pessoa. Ela extrai e da dois cliques no INSTALAR.bat.'
