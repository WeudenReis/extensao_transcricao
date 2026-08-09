<#
  Mantém o túnel público de pé — é por ele que o Recall.ai alcança o servidor
  pra entregar os webhooks. Sem túnel, o bot grava e a transcrição nunca volta.

  Roda em paralelo ao supervisor do servidor, com o mesmo desenho: escondido,
  tudo no log, reinicia sozinho.

  DOIS MODOS, e a diferença importa:

  - NOMEADO (recomendado): se existir `.cloudflared/<nome>.json`, o túnel sobe
    amarrado ao domínio fixo. A URL nunca muda e o endpoint cadastrado no
    Recall continua valendo pra sempre.

  - RÁPIDO (o que dá pra fazer sem login): a URL é sorteada a cada subida.
    Funciona pra testar, mas quando o túnel cai e volta, o endereço muda e o
    endpoint no painel do Recall passa a apontar pro vazio. Por isso, aqui, a
    URL nova é gravada em `data/tunel-url.txt` e escrita no log com destaque —
    senão a pessoa só descobre quando a transcrição não chega.
#>

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$pastaServer = Split-Path -Parent $PSScriptRoot
$pastaLog = Join-Path $pastaServer 'data'
if (-not (Test-Path $pastaLog)) { New-Item -ItemType Directory -Path $pastaLog | Out-Null }
$log = Join-Path $pastaLog 'tunel.log'
$arquivoUrl = Join-Path $pastaLog 'tunel-url.txt'

function Escrever([string]$msg) {
  $linha = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $linha
  Add-Content -Path $log -Value $linha -Encoding UTF8
}

if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
  Move-Item $log "$log.antigo" -Force
}

# O cloudflared pode estar no PATH ou instalado pelo winget.
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
  foreach ($p in @(
      "$env:ProgramFiles\cloudflared\cloudflared.exe",
      "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
      "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) {
    if (Test-Path $p) { $cloudflared = $p; break }
  }
}
if (-not $cloudflared) {
  Escrever 'cloudflared nao encontrado. Instale com: winget install Cloudflare.cloudflared'
  Escrever 'Sem tunel, o Recall nao alcanca o servidor e a transcricao nao volta.'
  exit 1
}

$nomeTunel = $env:CLOUDFLARE_TUNNEL_NOME
Escrever "=== tunel iniciado (cloudflared: $cloudflared) ==="

while ($true) {
  $urlVista = $null

  if ($nomeTunel) {
    Escrever "subindo tunel NOMEADO '$nomeTunel' (URL fixa)..."
    & $cloudflared tunnel run --url http://localhost:3333 $nomeTunel 2>&1 |
      ForEach-Object { Escrever $_ }
  } else {
    Escrever 'subindo tunel RAPIDO (a URL muda a cada subida)...'
    & $cloudflared tunnel --url http://localhost:3333 --no-autoupdate 2>&1 | ForEach-Object {
      $linha = "$_"
      Escrever $linha
      if (-not $urlVista -and $linha -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        $urlVista = $Matches[0]
        Set-Content -Path $arquivoUrl -Value $urlVista -Encoding UTF8
        Escrever ''
        Escrever '################################################################'
        Escrever "#  URL NOVA: $urlVista"
        Escrever '#'
        Escrever '#  ATUALIZE no painel do Recall (Edit no endpoint existente):'
        Escrever "#  $urlVista/webhooks/recall"
        Escrever '#'
        Escrever '#  Sem isso o Recall entrega no endereco velho e a'
        Escrever '#  transcricao nao volta. Tunel nomeado acaba com isso.'
        Escrever '################################################################'
        Escrever ''
      }
    }
  }

  Escrever 'tunel caiu. Subindo de novo em 10 s...'
  Start-Sleep -Seconds 10
}
