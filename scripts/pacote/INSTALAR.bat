@echo off
chcp 65001 >nul
title chatPro Transcricao - Instalador
cd /d "%~dp0"

echo ============================================================
echo   chatPro Transcricao - Instalador
echo ============================================================
echo.

rem 1) Precisa do Node.js.
where node >nul 2>nul
if errorlevel 1 (
  echo [!] O Node.js nao esta instalado - ele e necessario.
  echo     Vou abrir a pagina de download. Instale a versao "LTS",
  echo     reinicie o computador e rode este instalador de novo.
  echo.
  pause
  start "" "https://nodejs.org/pt-br/download"
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODEV=%%v
echo [ok] Node.js encontrado: %NODEV%
echo.

rem 1.5) Sem o .env o servidor sobe, o botao aparece, e nada funciona - o
rem      painel recusa toda chamada. Avisar AGORA, e nao depois de tres
rem      minutos compilando, e a diferenca entre um susto e um retrabalho.
if not exist "server\.env" (
  echo [!] Falta o arquivo de configuracao:  server\.env
  echo.
  echo     Peca ele ao Weuden e coloque dentro da pasta "server",
  echo     depois rode este instalador de novo.
  echo.
  echo     Sem ele o botao Reuniao aparece mas nao marca nada.
  echo.
  pause
  exit /b 1
)
echo [ok] Arquivo de configuracao encontrado.
echo.

rem 2) Instala as dependencias do servidor (demora alguns minutos na 1a vez).
rem --omit=optional corta 267 MB: Whisper (@xenova 45MB), onnxruntime (92MB),
rem ffmpeg-static (80MB) e sharp (50MB). Sao restos do fluxo antigo, em que a
rem transcricao rodava na maquina do atendente. Hoje quem grava e transcreve
rem e o PAINEL - nada disso e carregado. Os dois imports que usam esses
rem pacotes sao dinamicos e avisam sozinhos se um dia faltarem.
echo [..] Instalando dependencias do servidor...
pushd server
call npm install --omit=optional
if errorlevel 1 (
  echo.
  echo [X] Falha ao instalar dependencias.
  echo     Dica: instale a versao LTS do Node.js ^(nao a mais nova^).
  popd
  pause
  exit /b 1
)

echo [..] Compilando...
call npm run build
if errorlevel 1 (
  echo [X] Falha ao compilar.
  popd
  pause
  exit /b 1
)
popd

echo.
echo [..] Configurando o servidor para iniciar sozinho com o Windows...
cscript //nologo "server\autostart\INSTALAR-inicializacao-automatica.vbs" >nul 2>nul

echo.
echo [ok] Servidor instalado e iniciado!
echo.
echo ============================================================
echo   FALTA 1 PASSO - instalar a extensao no Chrome:
echo ============================================================
echo   1) Abra o Chrome e digite:  chrome://extensions
echo   2) Ligue o "Modo do desenvolvedor" (canto superior direito)
echo   3) Clique em "Carregar sem compactacao"
echo   4) Escolha a pasta:  %~dp0extension
echo ============================================================
echo.
echo Abrindo a tela de extensoes do Chrome...
timeout /t 4 /nobreak >nul
start "" "chrome://extensions"
echo.
echo Pronto! Pode fechar esta janela.
pause
