' Dê dois cliques para DESLIGAR a inicialização automática e parar o servidor.
Option Explicit
Dim sh, fso, startup, launcher
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

startup = sh.SpecialFolders("Startup")
launcher = startup & "\chatpro-transcricao.vbs"
If fso.FileExists(launcher) Then fso.DeleteFile(launcher)

' Encerra APENAS o servidor de transcricao (dist\index.js).
' NUNCA usar "taskkill /IM node.exe" aqui: mataria todo processo Node da
' maquina (servidores de outros projetos, ferramentas, etc).
Dim wmi, procs, p
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(LCase(p.CommandLine), "dist\index.js") > 0 Then p.Terminate()
  End If
Next

MsgBox "Inicializacao automatica removida e servidor de transcricao parado." & vbCrLf & _
       "Outros processos Node da maquina nao foram afetados.", 64, "chatPro Transcricao"
