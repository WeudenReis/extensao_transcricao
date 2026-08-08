<#
  Supervisor do servidor de reunioes do chatPro.

  Compila, sobe o servidor e o reinicia se ele cair. Feito pra rodar ESCONDIDO
  (sem janela), o que traz duas exigencias que o .bat anterior nao atendia:

  1. Nada de `timeout` nem `pause` — os dois precisam de console e falham
     silenciosamente quando nao ha um. Era por isso que o supervisor morria
     logo apos iniciar pela pasta Inicializar.
  2. TUDO vai pra um arquivo de log. Processo escondido sem log e impossivel
     de diagnosticar: fica de pe, nao serve nada, e nao ha onde olhar.

  Uso manual (com janela, pra ver o que acontece):
    powershell -ExecutionPolicy Bypass -File supervisor.ps1
#>

$ErrorActionPreference = 'Continue'

# O Node escreve UTF-8; o PowerShell 5.1 le como ANSI e transforma cada acento
# em tres simbolos no log. Sem isto, "transcrição" vira "transcrição" e o log
# fica desagradavel justamente na hora em que alguem precisa dele.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

$pastaServer = Split-Path -Parent $PSScriptRoot
Set-Location $pastaServer

$pastaLog = Join-Path $pastaServer 'data'
if (-not (Test-Path $pastaLog)) { New-Item -ItemType Directory -Path $pastaLog | Out-Null }
$log = Join-Path $pastaLog 'servidor.log'

function Escrever([string]$msg) {
  $linha = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $linha
  Add-Content -Path $log -Value $linha -Encoding UTF8
}

# O log cresce pra sempre se ninguem cortar. 5 MB e o suficiente pra investigar
# qualquer coisa recente.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
  Move-Item $log "$log.antigo" -Force
}

Escrever "=== supervisor iniciado (pasta: $pastaServer) ==="

if (-not (Test-Path (Join-Path $pastaServer 'node_modules'))) {
  Escrever 'node_modules ausente — instalando dependencias (pode demorar)...'
  & npm install 2>&1 | ForEach-Object { Escrever "npm: $_" }
}

while ($true) {
  # Compilar SEMPRE, e nao so na primeira vez: um dist desatualizado faz o
  # servidor servir codigo velho, e as rotas novas respondem 404 sem pista
  # nenhuma do motivo. Ja custou tempo neste projeto.
  Escrever 'compilando...'
  $saidaBuild = & npm run build 2>&1
  if ($LASTEXITCODE -ne 0) {
    Escrever "ERRO ao compilar (exit $LASTEXITCODE):"
    $saidaBuild | Select-Object -Last 20 | ForEach-Object { Escrever "  $_" }
    Escrever 'tentando de novo em 30 s — corrija o erro e ele sobe sozinho.'
    Start-Sleep -Seconds 30
    continue
  }

  Escrever 'subindo o servidor...'
  # Roda em primeiro plano DESTE processo: a linha seguinte so executa quando
  # o node sai, que e exatamente o gatilho de reinicio que queremos.
  & node dist/index.js 2>&1 | ForEach-Object { Escrever $_ }

  Escrever "servidor encerrou (exit $LASTEXITCODE). Reiniciando em 5 s..."
  Start-Sleep -Seconds 5
}
