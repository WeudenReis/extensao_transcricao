<#
  Põe o servidor de reuniões pra iniciar junto com o Windows.

  Cria um atalho na pasta Inicializar do usuário. Escolhi esse caminho depois
  de descartar os outros dois:

  - .vbs: bloqueado por vários antivírus e sensível à codificação do arquivo
    (um acento no lugar errado derruba com "unterminated string constant").
  - Agendador de Tarefas: `Register-ScheduledTask` exige elevação.

  A pasta Inicializar não precisa de administrador e é fácil de inspecionar:
  Win+R → shell:startup.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$supervisor = Join-Path $PSScriptRoot 'supervisor.ps1'
$tunel = Join-Path $PSScriptRoot 'tunel.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$atalho = Join-Path $startup 'chatPro Reunioes.lnk'
$atalhoTunel = Join-Path $startup 'chatPro Reunioes - tunel.lnk'

Write-Host ''
Write-Host '  chatPro Reuniões — início automático' -ForegroundColor Green
Write-Host '  ─────────────────────────────────────'
Write-Host ''

if (-not (Test-Path $supervisor)) {
  Write-Host "  ERRO: não achei supervisor.ps1 em $PSScriptRoot" -ForegroundColor Red
  exit 1
}

# ─── Cria o atalho ───────────────────────────────────────────────────────────

$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($atalho)
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisor`""
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.WindowStyle = 7   # minimizado; o -WindowStyle Hidden acima é quem esconde
$lnk.Description = 'Servidor de reuniões do chatPro'
$lnk.Save()

Write-Host "  [ok] Atalho do servidor criado em Inicializar." -ForegroundColor Green

# O túnel é peça separada de propósito: o servidor sozinho atende o botão da
# extensão (localhost), mas o Recall precisa alcançar de fora pra entregar a
# transcrição. Um atalho pra cada, então um pode cair sem levar o outro.
$lnkT = $sh.CreateShortcut($atalhoTunel)
$lnkT.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnkT.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$tunel`""
$lnkT.WorkingDirectory = $PSScriptRoot
$lnkT.WindowStyle = 7
$lnkT.Description = 'Tunel publico do chatPro Reunioes'
$lnkT.Save()
Write-Host "  [ok] Atalho do tunel criado em Inicializar." -ForegroundColor Green

# ─── Encerra o que estiver rodando e sobe de novo ────────────────────────────

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'supervisor\.ps1|run-forever|dist.index\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Write-Host '  Iniciando (a primeira vez compila, leva ~30 s)...'
Start-Process powershell.exe `
  -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$supervisor`"" `
  -WindowStyle Hidden

Start-Process powershell.exe `
  -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$tunel`"" `
  -WindowStyle Hidden

# ─── Confere que subiu de verdade ────────────────────────────────────────────

$ok = $false
foreach ($tentativa in 1..20) {
  Start-Sleep -Seconds 3
  try {
    Invoke-WebRequest 'http://127.0.0.1:3333/api/health' -TimeoutSec 3 -UseBasicParsing | Out-Null
    $ok = $true
    break
  } catch { }
}

Write-Host ''
if ($ok) {
  Write-Host '  [ok] Servidor no ar: http://localhost:3333' -ForegroundColor Green
  Write-Host ''
  Write-Host '   • Não precisa mais abrir o cmd.'
  Write-Host '   • Sobe sozinho toda vez que você entrar no Windows.'
  Write-Host '   • Volta sozinho se cair.'
} else {
  $log = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\servidor.log'
  Write-Host '  [!] Não respondeu em 60 s.' -ForegroundColor Yellow
  Write-Host "      Veja o que aconteceu em: $log"
  if (Test-Path $log) {
    Write-Host ''
    Write-Host '      Últimas linhas:'
    Get-Content $log -Tail 8 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
  }
}

Write-Host ''
$arquivoUrl = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\tunel-url.txt'
foreach ($t in 1..15) {
  Start-Sleep -Seconds 2
  if (Test-Path $arquivoUrl) {
    $u = (Get-Content $arquivoUrl -Raw).Trim()
    if ($u) {
      Write-Host ''
      Write-Host '  URL publica do tunel:' -ForegroundColor Cyan
      Write-Host "    $u"
      Write-Host ''
      Write-Host '  Cadastre no painel do Recall (Edit no endpoint existente):' -ForegroundColor Yellow
      Write-Host "    $u/webhooks/recall"
      break
    }
  }
}

Write-Host ''
Write-Host '  Para desligar, rode DESINSTALAR.bat desta pasta.'
Write-Host ''
