# Setup GCP — Meet REST API + Workspace Events + Pub/Sub

Passo a passo pra deixar o Google Cloud pronto pro backend (`server/`).
Faça tudo com uma conta **administradora do Google Workspace** (ou peça pro
admin) — o consent screen será do tipo **Interno**.

> **⚠ Requisito de licença**: transcrição automática do Meet exige edição
> Google Workspace elegível — **Business Standard ou superior** (ou add-on
> Gemini). **Conta pessoal @gmail NÃO gera transcript**, mesmo com a API
> configurada. Sem a licença certa o pipeline nunca recebe
> `transcript.v2.fileGenerated`.

## 1. Criar o projeto

1. Acesse https://console.cloud.google.com/ e crie um projeto
   (ex.: `chatpro-meet-transcricao`). Anote o **Project ID**.
2. Selecione o projeto no seletor do topo.

Ou via CLI:

```bash
gcloud projects create chatpro-meet-transcricao
gcloud config set project chatpro-meet-transcricao
```

## 2. Ativar as APIs

Em **APIs & Services → Library**, ative:

- **Google Meet REST API**
- **Google Workspace Events API**
- **Cloud Pub/Sub API**

Via CLI:

```bash
gcloud services enable meet.googleapis.com \
  workspaceevents.googleapis.com \
  pubsub.googleapis.com
```

## 3. OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. Tipo de usuário: **Interno** (Workspace) — evita verificação do Google e
   restringe às contas do domínio.
3. Preencha nome do app (ex.: "chatPro Meet Transcrição") e e-mail de suporte.
4. Escopos: pode deixar em branco aqui — o backend pede em runtime:
   - `https://www.googleapis.com/auth/meetings.space.settings`
   - `https://www.googleapis.com/auth/meetings.space.readonly`
   - `openid`, `email`

## 4. OAuth Client ID

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URI: `http://localhost:3333/oauth/callback`
   (exatamente igual ao `GOOGLE_REDIRECT_URI` do `.env`).
4. Copie **Client ID** e **Client Secret** pro `server/.env`
   (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

## 5. Tópico Pub/Sub + permissão pro Meet publicar

```bash
gcloud pubsub topics create meet-events

gcloud pubsub topics add-iam-policy-binding meet-events \
  --member='serviceAccount:meet-api-event-push@system.gserviceaccount.com' \
  --role='roles/pubsub.publisher'
```

O segundo comando é **obrigatório**: é essa service account do Google que
publica os eventos do Meet no seu tópico. Sem o grant, a subscription do
Workspace Events falha ao ser criada.

No `.env`: `GOOGLE_PUBSUB_TOPIC=projects/SEU_PROJETO/topics/meet-events`.

## 6. Expor o backend (dev) e criar a push subscription

O Pub/Sub precisa alcançar seu backend por **HTTPS público**. Em dev, use um
túnel:

```bash
# opção A — ngrok
ngrok http 3333

# opção B — cloudflared
cloudflared tunnel --url http://localhost:3333
```

Anote a URL pública (ex.: `https://abc123.ngrok-free.app`). Depois crie a
push subscription apontando pro webhook, **com OIDC token**:

```bash
# service account que assina o OIDC token do push
gcloud iam service-accounts create pubsub-pusher \
  --display-name="Pub/Sub push OIDC"

gcloud pubsub subscriptions create meet-events-push \
  --topic=meet-events \
  --push-endpoint=https://abc123.ngrok-free.app/webhooks/pubsub \
  --push-auth-service-account=pubsub-pusher@SEU_PROJETO.iam.gserviceaccount.com \
  --push-auth-token-audience=https://abc123.ngrok-free.app/webhooks/pubsub
```

No `.env`:

```
PUBSUB_VERIFICATION_AUDIENCE=https://abc123.ngrok-free.app/webhooks/pubsub
PUBSUB_SERVICE_ACCOUNT=pubsub-pusher@SEU_PROJETO.iam.gserviceaccount.com
```

O backend valida o `Authorization: Bearer <OIDC>` de cada push contra essa
audience (via `google-auth-library`) **e**, com `PUBSUB_SERVICE_ACCOUNT`
setada, exige que o token pertença exatamente ao service account da push
subscription (claims `email` + `email_verified`) — sem isso, qualquer
identity token do Google com a audience certa passaria.

Se `PUBSUB_VERIFICATION_AUDIENCE` ficar **vazia**, o webhook **rejeita todo
push com 403**. Para testar sem OIDC (ex.: `curl` local antes de configurar o
túnel), sete `ALLOW_INSECURE_PUBSUB=true` no `.env` — **somente em
desenvolvimento**; o backend loga warning enquanto estiver assim.

> **Túnel caiu / URL mudou?** Atualize o `--push-endpoint` e o
> `--push-auth-token-audience` da subscription
> (`gcloud pubsub subscriptions update meet-events-push --push-endpoint=… --push-auth-token-audience=…`)
> e o `PUBSUB_VERIFICATION_AUDIENCE` do `.env`. ngrok gratuito muda a URL a
> cada restart — pra estabilidade use cloudflared com túnel nomeado ou um
> domínio próprio.

## 7. Subscription do Workspace Events (automática)

Quem cria/renova a subscription de eventos do Meet é o **próprio backend**
(`src/google/events.ts`), no boot e a cada 6 h, usando o OAuth do usuário:

- `targetResource`: `//cloudidentity.googleapis.com/users/me` (todos os Meets
  do usuário conectado)
- `eventTypes`: `google.workspace.meet.transcript.v2.fileGenerated`,
  `google.workspace.meet.conference.v2.ended`
- `notificationEndpoint.pubsubTopic`: o tópico do passo 5
- `payloadOptions.includeResource: false` (o pipeline busca o recurso na API)

Subscriptions **expiram** — o backend renova com
`PATCH subscriptions/{id}?updateMask=ttl` antes do fim. Confira em
`GET /api/status` se ela está ativa.

## 8. Checklist final

- [ ] Meet REST API, Workspace Events API e Pub/Sub API ativas
- [ ] Consent screen interno configurado
- [ ] OAuth Client (web) com redirect `http://localhost:3333/oauth/callback`
- [ ] Tópico `meet-events` criado com grant pro
      `meet-api-event-push@system.gserviceaccount.com`
- [ ] Push subscription com OIDC apontando pro túnel público
- [ ] `.env` preenchido (client id/secret, tópico, audience,
      `PUBSUB_SERVICE_ACCOUNT`; `ALLOW_INSECURE_PUBSUB` **não** setada)
- [ ] Conta usada nas reuniões tem **Business Standard+ / Gemini**
