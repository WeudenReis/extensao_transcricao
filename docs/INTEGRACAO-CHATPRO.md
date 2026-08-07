# Integração com o chatPro Chat

> **Produto: chatPro Chat** (o de conversas/atendimentos) — não a "chatPro API",
> que é de instâncias e WhatsApp. São bases e autenticações diferentes.
>
> - Base: `https://sparks.chatpro.com.br`
> - Autenticação: header **`instance-token`**
> - Token: `app.chatpro.com.br` → Configurações → Desenvolvedor

## Dois jeitos de começar uma reunião

**1. O botão da extensão (principal).** O atendente clica em
**reunião** na barra do chatPro:

```
  Clique
    → cria o link do Meet na agenda DO ATENDENTE (Calendar API, conta pessoal serve)
    → POST sparks.chatpro.com.br/messages/sendMessage  (o cliente recebe o link)
    → cria o bot do Recall na sala
    → abre a reunião numa aba nova
```

Tudo isso é um `POST /api/reunioes/iniciar { sessionId, deviceId }`.

A ordem importa: se o link falhar, nada acontece; se a **mensagem** falhar, a
gente **para** e devolve o link pro atendente colar na mão — bot numa sala que o
cliente não conhece não ajuda ninguém.

**2. Link colado na conversa (automático).** Se o atendente preferir colar um
link do Meet direto no chat, o webhook pega e manda o bot do mesmo jeito.

O resto do documento descreve esse segundo caminho e a volta da transcrição.

---

## O fluxo automático, de ponta a ponta

O atendente **não aperta nada**. Ele manda o link do Meet na conversa, como já
faria, e o resto acontece sozinho:

```
  Atendente manda o link na conversa do chatPro
              │
              ▼
  chatPro dispara `sent_message` ──────► POST /webhooks/chatpro/{segredo}
              │                                    │
              │                          lê o link + session_id + instance_id
              │                                    ▼
              │                          cria o bot no Recall.ai
              │                          (metadata leva session_id e meeting_id)
              ▼                                    │
  Bot entra, grava, reunião acaba ◄────────────────┘
              │
              ▼
  Recall manda `transcript.done` ───────► POST /webhooks/recall
                                                   │
                                          baixa e normaliza a transcrição
                                                   ▼
                                    POST sparks.chatpro.com.br/messages/addComments
                                                   │
                                                   ▼
                              a transcrição aparece como COMENTÁRIO
                              na MESMA conversa do chatPro
```

O `session_id` que chega no webhook viaja no `metadata` do bot e volta em todo
evento do Recall. É por isso que a transcrição nunca cai na conversa errada.

---

## 1. Gatilho: link do Meet na conversa

O chatPro precisa chamar:

```
POST {PUBLIC_BASE_URL}/webhooks/chatpro/{CHATPRO_WEBHOOK_SECRET}
```

**Por que o segredo vai na URL:** o chatPro não assina os webhooks dele (o
Recall assina, com Svix). Sem nenhuma prova de origem, este endpoint deixaria
qualquer um disparar bots na sua conta — e bot é cobrado por hora. O segredo no
caminho é o que o chatPro consegue guardar, então é o que dá pra usar.

Sem `CHATPRO_WEBHOOK_SECRET` no `.env`, **a rota nem existe** e o disparo
automático fica desligado.

### O que é aceito

| Evento | O que fazemos |
|---|---|
| `sent_message` com link do Meet | manda o bot |
| `received_message` com link do Meet | **ignorado** (veja abaixo) |
| mensagem sem link | 200, ignorado |
| `opened_session`, `closed_session`, … | 200, ignorado |

**Por que link mandado pelo cliente é ignorado.** O gatilho aqui é *texto de
mensagem*, e num WhatsApp de atendimento quem escreve pode ser qualquer estranho
que tenha o número da empresa. Aceitar do cliente entregaria a criação de um
recurso **cobrado por hora** a quem quiser. Se você precisar disso mesmo assim,
ligue `CHATPRO_ACEITAR_LINK_DO_CLIENTE=true`.

**Teto de segurança.** No máximo 10 bots a cada 10 minutos por esta rota. Uma
rajada de links diferentes escaparia do dedup (cada código é único), então o teto
é a última defesa contra a fatura. Ao bater o teto, o servidor registra em nível
de erro no log e continua respondendo 200.

Sempre respondemos **200**, mesmo ignorando — um 4xx faria o chatPro reentregar
sem parar.

O link tem que ter o formato `https://meet.google.com/xxx-yyyy-zzz`. Um
`meet.google.com/` solto não conta.

### Respondemos antes de criar o bot

O 200 sai na hora; a criação do bot acontece logo depois, em segundo plano.
Criar envolve falar com o Recall e leva segundos — não dá pra segurar o webhook
do chatPro esperando isso.

Se a criação falhar, a reunião aparece como **`failed`** no painel com o motivo,
e dá pra reenviar de lá. Nada falha em silêncio.

### Mandar o mesmo link duas vezes não põe dois bots

Se já existe bot naquela sala e a reunião está viva (janela de 12 h), nada novo
é criado. Vale pro webhook e pra API — os dois passam pelo mesmo código.

---

## 2. Entrega: a transcrição vira comentário

Quando a reunião acaba e o Recall entrega a transcrição, chamamos:

```http
POST https://sparks.chatpro.com.br/messages/addComments
instance-token: {CHATPRO_INSTANCE_TOKEN}
Content-Type: application/json

{
  "instanceId": "chatpro-1234567890",
  "sessionId":  "78562bd7-3d56-47ae-9d4f-25dd80e6b024",
  "userId":     "uuid-do-usuario",
  "message":    "📄 *Transcrição da reunião* — 34 min\n..."
}
```

O `instanceId` sai do próprio webhook (`message_data.instance_id`) quando a
reunião veio por ali; senão, do `CHATPRO_INSTANCE_ID` do `.env`.

### Como o comentário fica

```
📄 *Transcrição da reunião* — 34 min
Maria Atendente · João Cliente
https://meet.google.com/abc-defg-hij

[00:01] *Maria Atendente:* bom dia, tudo bem?
[00:04] *João Cliente:* tudo, e você?
[00:09] *Maria Atendente:* queria te mostrar a proposta
```

### Transcrição longa vira várias partes

Um comentário é um campo de texto só, e reunião de 40 minutos não cabe. A
transcrição é fatiada em partes de até 3.500 caracteres, numeradas
(`(parte 2/5)`). Nunca cortamos uma fala no meio.

**Se a entrega falhar no meio**, guardamos quantas partes entraram e o reenvio
continua da parte seguinte — em vez de republicar o que já está na conversa.
Transcrição duplicada já foi problema real neste projeto.

---

## 3. O que configurar

```
# Entrega
CHATPRO_BASE_URL=https://sparks.chatpro.com.br
CHATPRO_INSTANCE_TOKEN=      # Configurações → Desenvolvedor
CHATPRO_INSTANCE_ID=         # formato chatpro-xxxxxxxxxx
CHATPRO_USER_ID=             # ver get_all_users_by_instance
AUTO_SEND_CHATPRO=true       # vazio = espera você apertar o botão no painel

# Gatilho automático
CHATPRO_WEBHOOK_SECRET=      # já gerado no seu .env
CHATPRO_AUTO_START_BOT=      # 'false' desliga só o disparo
CHATPRO_ACEITAR_LINK_DO_CLIENTE=   # 'true' aceita link do cliente (não recomendo)

# Botão da extensão (conta Google de cada atendente)
GOOGLE_CLIENT_ID=            # OAuth Client "Web application" do GCP
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI_EXTENSAO=http://localhost:3333/oauth/google/callback
```

O `GOOGLE_REDIRECT_URI_EXTENSAO` precisa estar cadastrado como **Authorized
redirect URI** no mesmo OAuth Client. Escopo pedido: `calendar.events` — é o que
permite criar o link do Meet em **conta pessoal @gmail**.

Faltando qualquer uma das três primeiras, a transcrição **não se perde**: fica
salva, marcada como `skipped-no-url`, esperando no painel.

### Onde cadastrar a URL do webhook

Esta é a única parte que **não consegui confirmar na documentação** deles. O que
sei: a página de configurar webhook que aparece na doc
(`api.chatpro.com.br/painel/ws/endpoint.php?action=alterar_webhook`) é da
**chatPro API Painel**, produto diferente do Chat.

Então, na ordem:

1. Procure em `app.chatpro.com.br` → **Configurações → Desenvolvedor** (mesmo
   lugar do `instance-token`) por um campo de webhook.
2. Se não houver, **pergunte ao suporte do chatPro**: "onde cadastro a URL que
   recebe os eventos `sent_message` e `received_message` do chatPro Chat?"

Enquanto isso não estiver resolvido, tudo funciona pelo disparo manual (painel
ou `POST /api/meetings`).

---

## 4. Disparo manual — se preferir chamar você mesmo

**`POST {SEU_BACKEND}/api/meetings`**

```http
Content-Type: application/json
Authorization: Bearer {PANEL_TOKEN}
```

```json
{
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "sessionId": "78562bd7-3d56-47ae-9d4f-25dd80e6b024"
}
```

| Código | Quando |
|---|---|
| `201` | bot criado |
| `200` | já havia bot nessa sala (`jaExistia: true`) — não é erro |
| `400` | `meetingUrl` não é do Meet |
| `401` | falta o `PANEL_TOKEN` |
| `502` | o Recall recusou ou não respondeu |
| `503` | `RECALL_API_KEY` não configurada |

Um `502` **não garante** que o bot não entrou: se o Recall demorar mais de 20 s,
ele pode ter criado o bot mesmo assim (a resposta traz um `hint` avisando). Você
não precisa tratar — a reunião fica registrada e o primeiro webhook do bot a
reencontra sozinho.

---

## 5. Acompanhar o andamento

**`GET /api/meetings/{id}`** com `Authorization: Bearer {PANEL_TOKEN}`.

| status | significa |
|---|---|
| `created` | bot criado, ainda não entrou |
| `joining` | entrando na chamada |
| `waiting_room` | **na sala de espera — alguém precisa admitir** |
| `recording` | gravando |
| `ended` | chamada encerrada, transcrição processando |
| `done` | transcrição pronta |
| `failed` | deu errado (motivo no campo `error`) |

| chatproStatus | significa |
|---|---|
| `pending` | esperando envio |
| `sent` | comentário postado na conversa |
| `failed` | tentamos e falhou — dá pra reenviar pelo painel |
| `skipped-no-url` | chatPro não configurado |

⚠️ **Alguém precisa admitir o bot** na sala de espera: ele entra como convidado
anônimo. Pra entrar direto é preciso um bot autenticado com uma conta Google
dedicada.
