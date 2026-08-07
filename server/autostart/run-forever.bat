@echo off
rem Supervisor do servidor de reunioes do chatPro.
rem Sobe o backend e o reinicia automaticamente se ele cair.
title chatPro Reunioes (servidor)
cd /d "%~dp0.."

if not exist node_modules\ (
  echo Instalando dependencias pela primeira vez... isso pode demorar alguns minutos.
  call npm install
)

rem SEMPRE recompila antes de subir. Antes isso so acontecia se dist\ nao
rem existisse, e um dist desatualizado fazia o servidor rodar codigo velho:
rem as rotas novas respondiam 404 sem nenhuma pista do motivo.
echo Compilando...
call npm run build
if errorlevel 1 (
  echo.
  echo ERRO ao compilar. O servidor NAO subiu. Veja a mensagem acima.
  pause
  exit /b 1
)

:loop
node dist\index.js
echo Servidor encerrou. Reiniciando em 5 segundos... (feche esta janela para parar)
timeout /t 5 /nobreak >nul
goto loop
