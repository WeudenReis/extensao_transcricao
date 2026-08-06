@echo off
rem Supervisor do servidor de transcricao chatPro.
rem Sobe o backend e o reinicia automaticamente se ele cair.
title chatPro Transcricao (servidor)
cd /d "%~dp0.."

if not exist node_modules\ (
  echo Instalando dependencias pela primeira vez... isso pode demorar alguns minutos.
  call npm install
)
if not exist dist\index.js (
  echo Compilando pela primeira vez...
  call npm run build
)

:loop
node dist\index.js
echo Servidor encerrou. Reiniciando em 5 segundos... (feche esta janela para parar)
timeout /t 5 /nobreak >nul
goto loop
