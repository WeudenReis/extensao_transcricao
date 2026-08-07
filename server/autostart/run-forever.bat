@echo off
rem Supervisor do servidor de reunioes do chatPro.
rem Sobe o backend e o reinicia automaticamente se ele cair.
title chatPro Reunioes (servidor)
cd /d "%~dp0.."

if not exist node_modules\ (
  echo Instalando dependencias pela primeira vez... isso pode demorar alguns minutos.
  call npm install
)

rem O build fica DENTRO do loop de proposito. Fora dele, encerrar o node so
rem reiniciava o binario antigo: quem quisesse aplicar codigo novo tinha que
rem descobrir que precisava matar o supervisor tambem. Ja custou tempo duas
rem vezes aqui. Compilar leva poucos segundos e garante que o que esta rodando
rem e o que esta no fonte.
:loop
echo Compilando...
call npm run build
if errorlevel 1 (
  echo.
  echo ERRO ao compilar. Tentando de novo em 15 segundos...
  echo Corrija o erro acima; o servidor sobe sozinho quando compilar.
  timeout /t 15 /nobreak >nul
  goto loop
)

node dist\index.js
echo Servidor encerrou. Reiniciando em 5 segundos... (feche esta janela para parar)
timeout /t 5 /nobreak >nul
goto loop
