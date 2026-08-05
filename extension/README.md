# chatPro Meet Transcripts

Extensão Chrome (Manifest V3) que vincula a conversa ativa do chatPro com a
reunião do Google Meet e envia o vínculo para o backend local — que depois
junta a transcrição do Meet e manda para a Voreo.

Distribuição local, fora das lojas: instala-se via "Carregar sem compactação".

## Instalação em 5 passos

1. Abra o Chrome e acesse `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação**.
4. Escolha esta pasta (`extension/` — a que contém o `manifest.json`).
5. Pronto! O ícone verde da chatPro aparece na barra. Fixe-o clicando no
   alfinete para acompanhar o status.

## Como usar

- Abra uma conversa no chatPro (`app.chatpro.com.br`) — a extensão captura o
  session id sozinha (badge ✓ verde no ícone).
- Entre na reunião do Google Meet. Se o vínculo automático estiver ativo
  (padrão), a extensão vincula sessão ↔ reunião e envia ao backend.
- No popup você acompanha a sessão ativa, a reunião detectada e o status do
  último vínculo (Enviado ✓ / Pendente). Vínculos pendentes são reenviados
  automaticamente a cada minuto.
- O botão **Vincular agora** cria o vínculo manualmente quando precisar.
- Em **Configurar backend** você troca o endereço do backend local
  (padrão: `http://localhost:3333`).

## Como atualizar

1. Substitua os arquivos desta pasta pela versão nova (ou faça `git pull`).
2. Em `chrome://extensions`, clique no botão **Atualizar** (ícone de seta
   circular) no card da extensão — ou no botão global "Atualizar".
3. Se algo parecer estranho, remova a extensão e repita a instalação.

## Fontes (opcional)

O popup usa **Paytone One** (títulos) e **Space Grotesk** (textos), a
identidade da chatPro. Como a CSP de extensões não permite Google Fonts via
CDN, os arquivos precisam ser locais. Sem eles, o popup funciona normalmente
com a fonte do sistema.

Para ativar: siga o passo a passo em `popup/fonts/README.txt`.

## Empacotamento (opcional)

Para gerar um .zip de distribuição:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

O pacote sai em `dist/chatpro-meet-transcripts-v{versão}.zip`.
Os ícones podem ser regenerados com `scripts\make-icons.ps1`.
