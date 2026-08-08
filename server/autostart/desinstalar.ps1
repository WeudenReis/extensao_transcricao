<# Remove o início automático e encerra o servidor. #>

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$atalho = Join-Path ([Environment]::GetFolderPath('Startup')) 'chatPro Reunioes.lnk'

Write-Host ''
Write-Host '  chatPro Reuniões — remover início automático' -ForegroundColor Yellow
Write-Host '  ────────────────────────────────────────────'
Write-Host ''

if (Test-Path $atalho) {
  Remove-Item $atalho -Force
  Write-Host '  [ok] Atalho removido da pasta Inicializar.'
} else {
  Write-Host '  O atalho não estava instalado.'
}

$mortos = 0
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'supervisor\.ps1|dist.index\.js' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $mortos++
  }

if ($mortos -gt 0) {
  Write-Host "  [ok] Servidor encerrado ($mortos processo(s))."
} else {
  Write-Host '  O servidor já não estava rodando.'
}

Write-Host ''
Write-Host '  Pronto. Para voltar a usar, rode INSTALAR.bat.'
Write-Host ''
