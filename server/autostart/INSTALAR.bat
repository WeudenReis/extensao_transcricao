@echo off
rem ===========================================================================
rem  chatPro Reunioes - inicio automatico
rem
rem  De DOIS CLIQUES neste arquivo, uma vez so.
rem
rem  Faz o servidor subir junto com o Windows, rodando escondido, e voltar
rem  sozinho se cair. NAO precisa de administrador.
rem
rem  Como funciona: cria um atalho na pasta Inicializar do seu usuario.
rem  (Nao usa .vbs, que antivirus bloqueiam, nem Agendador de Tarefas, que
rem   pediria elevacao.)
rem
rem  Sem acentos neste arquivo de proposito: .bat e lido como ANSI.
rem ===========================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
pause
