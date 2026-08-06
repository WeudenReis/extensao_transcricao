' Dê dois cliques neste arquivo UMA vez.
' Ele faz o servidor de transcrição iniciar sozinho toda vez que o PC liga,
' rodando escondido (sem janela preta), e já inicia agora.
Option Explicit
Dim fso, sh, here, bat, startup, launcher, f
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
bat = here & "\run-forever.bat"
startup = sh.SpecialFolders("Startup")
launcher = startup & "\chatpro-transcricao.vbs"

' Cria o atalho de inicialização (roda o .bat oculto no logon).
Set f = fso.CreateTextFile(launcher, True)
f.WriteLine "CreateObject(""WScript.Shell"").Run """" & bat & """, 0, False"
f.Close

' Inicia agora, escondido.
sh.Run """" & bat & """", 0, False

MsgBox "Pronto! O servidor de transcricao ja esta rodando e vai iniciar sozinho toda vez que voce ligar o PC." & vbCrLf & vbCrLf & _
       "Abra http://localhost:3333 para ver as transcricoes." & vbCrLf & vbCrLf & _
       "Para DESLIGAR, rode o arquivo DESINSTALAR-inicializacao.vbs desta pasta.", _
       64, "chatPro Transcricao"
