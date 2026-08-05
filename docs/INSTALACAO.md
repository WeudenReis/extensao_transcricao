# Instalação e uso — extensão + backend (guia do usuário final)

Guia ponta a ponta: instalar a extensão no Chrome, subir o backend, conectar
o Google e testar o fluxo completo até o payload chegar na Voreo.

## 1. Instalar a extensão (Load unpacked)

A extensão é distribuída **fora da Chrome Web Store** — instala-se em modo
desenvolvedor:

1. Baixe/clone a pasta do projeto e localize a pasta `extension/`.
2. Abra o Chrome e vá em `chrome://extensions` (cole na barra de endereço).
3. Ligue o **Modo do desenvolvedor** (chave no canto superior direito).
4. Clique em **Carregar sem compactação** (Load unpacked).
5. Selecione a pasta `extension/` do projeto e confirme.
6. A extensão aparece na lista — fixe o ícone dela na barra (ícone de puzzle
   → alfinete) pra acompanhar o status.

> O Chrome pode avisar sobre extensões em modo desenvolvedor ao reiniciar —
> é esperado pra extensões fora da loja; basta manter.
>
> **Pra atualizar** depois de baixar uma versão nova: `chrome://extensions` →
> botão **↻ Atualizar** (ou remova e carregue de novo).

## 2. Rodar o backend

Pré-requisitos: **Node.js 20+** e o setup GCP feito
([docs/SETUP-GCP.md](./SETUP-GCP.md)).

```bash
cd server
npm install
copy .env.example .env   # (Linux/macOS: cp .env.example .env)
# edite o .env com os valores do GCP
npm run dev
```

Deve aparecer `servidor ouvindo em http://localhost:3333`. Confira:
http://localhost:3333/api/health → `{"ok":true}`.

## 3. Conectar o Google (uma vez)

1. Com o backend rodando, abra **http://localhost:3333/oauth/start**.
2. Entre com a conta **Workspace** que fará as reuniões (precisa de licença
   Business Standard+ / Gemini — conta @gmail pessoal não gera transcrição).
3. Aceite as permissões. A página final confirma: "Google conectado ✔".
4. Confira em http://localhost:3333/api/status →
   `"googleConnected": true` e, em alguns segundos, a subscription de
   eventos listada.

## 4. Testar o fluxo ponta a ponta

1. **Abrir a conversa no chatPro** — acesse `app.chatpro.com.br` e abra a
   conversa do cliente. A extensão captura o session id da URL (confira no
   popup da extensão: "sessão ativa").
2. **Criar o Meet com transcrição garantida** — chame:

   ```bash
   curl -X POST http://localhost:3333/api/spaces
   ```

   A resposta traz `meetingUri` e `meetingCode`. Abra o `meetingUri` e envie
   pro cliente. *(Alternativa: use um Meet já existente — com a aba do Meet
   aberta, a extensão vincula sozinha, ou use o botão "Vincular manualmente"
   do popup, que chama `POST /api/links`.)*
3. **Conferir o vínculo** — http://localhost:3333/api/links deve listar
   `{sessionId, meetingCode}` da conversa + reunião.
4. **Fazer a call** — realize a reunião normalmente. A transcrição liga
   sozinha (space criado com `autoTranscriptionGeneration: "ON"`). Fale por
   pelo menos alguns minutos pra gerar conteúdo.
5. **Encerrar e aguardar** — ao encerrar a call, o Google gera o arquivo de
   transcrição (pode levar alguns minutos). O evento
   `transcript.v2.fileGenerated` chega no backend via Pub/Sub — acompanhe o
   log do `npm run dev`:

   ```
   [routes/pubsub] evento fileGenerated: conferenceRecords/…/transcripts/…
   [pipeline] transcript …: N entries, M participantes, sessão … — enviando à Voreo.
   [voreo] enviado à Voreo: sessão …, meet …, N entries, M participantes
   ```

6. **Payload na Voreo** — com `VOREO_WEBHOOK_URL` configurada, o payload
   `{sessionId, transcript, metadados}` é entregue com retry automático.
   Sem a URL (dev), o log mostra o resumo e o status fica
   `skipped-no-url` — confira em http://localhost:3333/api/status.

## Problemas comuns

| Sintoma | Causa provável / correção |
| --- | --- |
| `googleConnected: false` no /api/status | Refaça http://localhost:3333/oauth/start |
| Evento nunca chega no backend | Túnel (ngrok/cloudflared) caiu ou push subscription com endpoint desatualizado — veja o passo 6 do SETUP-GCP |
| Reunião aconteceu mas não há transcript | Conta sem licença elegível (Business Standard+/Gemini) ou reunião criada fora do space com transcrição ON |
| Log: `nenhum vínculo sessionId↔meet` | O vínculo não foi criado antes/durante a call — vincule manualmente e aguarde o fallback do `conference.ended`, ou confira `POST /api/links` |
| Payload não chega na Voreo | Veja `queuePending`/`queueDead` no /api/status — a fila retenta com backoff (máx 8 vezes) |
