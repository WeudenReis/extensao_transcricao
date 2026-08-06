' Dê dois cliques para DESLIGAR a inicialização automática e parar o servidor.
Option Explicit
Dim sh, fso, startup, launcher
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

startup = sh.SpecialFolders("Startup")
launcher = startup & "\chatpro-transcricao.vbs"
If fso.FileExists(launcher) Then fso.DeleteFile(launcher)

' Encerra o(s) processo(s) node do servidor.
sh.Run "taskkill /IM node.exe /F", 0, True

MsgBox "Inicializacao automatica removida e servidor parado." & vbCrLf & _
       "Observacao: isso encerra todos os processos Node do computador.", 64, "chatPro Transcricao"
