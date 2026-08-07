# Integração com o chatPro

> Este documento é pra quem vai mexer no **lado do chatPro**. Do nosso lado já
> está tudo pronto — são duas conversas: nós recebemos "comece a gravar" e
> devolvemos a transcrição quando ela fica pronta.

```
   chatPro                          este servidor                    Recall.ai
      │                                   │                              │
      │ 1. POST /api/meetings ───────────►│                              │
      │    {meetingUrl, sessionId}        │─── cria o bot ──────────────►│
      │◄─────────── {meeting} ────────────│                              │
      │                                   │                              │
      │                                   │◄── webhooks (bot entrou,     │
      │                                   │    gravando, terminou…)      │
      │                                   │                              │
      │◄── 2. POST no seu endpoint ───────│◄── transcript.done ──────────│
      │       {sessionId, transcript}     │                              │
```

---

## 1. Mandar o bot entrar na reunião

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

| Campo | Obrigatório | O que é |
|---|---|---|
| `meetingUrl` | sim | URL da reunião. Só aceita `https://meet.google.com/...` |
| `sessionId` | não | UUID da conversa do chatPro. É o que amarra a transcrição à conversa certa |

O `sessionId` é opcional porque nem sempre ele existe na hora de criar a
reunião. Se vier depois, mande de novo — a segunda chamada amarra a sessão sem
criar outro bot (veja abaixo).

### Respostas

| Código | Quando | O que fazer |
|---|---|---|
| `201` | bot criado | nada, deu certo |
| `200` | **já havia bot nessa sala** — devolve o existente, com `jaExistia: true` | nada, deu certo |
| `400` | `meetingUrl` não é do Meet | corrigir a URL |
| `401` | falta o `PANEL_TOKEN` | conferir o header |
| `502` | o Recall recusou ou não respondeu | ver abaixo |
| `503` | `RECALL_API_KEY` não configurada no servidor | é configuração nossa |

```json
{
  "meeting": {
    "id": "uuid da reunião aqui",
    "botId": "id do bot no Recall",
    "sessionId": "78562bd7-...",
    "meetingCode": "abc-defg-hij",
    "status": "created",
    "chatproStatus": "pending",
    "temTranscript": false
  }
}
```

### Pode chamar quantas vezes quiser

**Chamar duas vezes dá o mesmo resultado que uma.** Se já existe um bot naquela
sala e a reunião ainda está em andamento, devolvemos o que existe com
`jaExistia: true` em vez de mandar um segundo robô.

Isso é de propósito: retry, timeout e duplo clique do atendente acontecem, e
cada bot a mais é um participante-robô a mais aparecendo pro cliente — além de
mais uma hora cobrada pelo Recall.

A janela é de 12 h e só vale pra reunião **em andamento**. Reunião encerrada não
bloqueia uma nova na mesma sala.

### Sobre o 502

Um `502` **não garante** que o bot não entrou: se o Recall demorar mais de 20 s
pra responder, ele pode ter criado o bot mesmo assim. Nesse caso a resposta vem
com um `hint` avisando.

Você não precisa tratar isso — nós tratamos. A reunião fica registrada e o
primeiro webhook do bot reencontra ela sozinho. **Mas não repita a chamada em
loop**: se o bot entrou, a repetição cai no caso `200` acima; se não entrou, uma
nova tentativa depois de alguns segundos resolve.

---

## 2. Receber a transcrição

Quando a reunião termina e o Recall entrega a transcrição, nós chamamos **um
endpoint seu**. Configure em `server/.env`:

```
CHATPRO_API_URL=https://.../onde/receber
CHATPRO_API_KEY=...            # vai como Authorization: Bearer
AUTO_SEND_CHATPRO=true         # vazio = fica esperando alguém apertar o botão no painel
```

Nós mandamos `POST` com este corpo:

```json
{
  "sessionId": "78562bd7-3d56-47ae-9d4f-25dd80e6b024",
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "meetingCode": "abc-defg-hij",
  "startedAt": "2026-08-06T13:00:00.000Z",
  "endedAt": "2026-08-06T13:34:00.000Z",
  "durationSeconds": 2040,
  "participants": [
    { "nome": "Maria Atendente", "isHost": true,  "email": "maria@empresa.com" },
    { "nome": "João Cliente",    "isHost": false, "email": null }
  ],
  "transcript": [
    { "speaker": "Maria Atendente", "text": "bom dia, tudo bem?", "startMs": 1000,  "endMs": 3200, "isHost": true },
    { "speaker": "João Cliente",    "text": "tudo, e você?",      "startMs": 3800,  "endMs": 5100, "isHost": false }
  ],
  "source": "recall-ai"
}
```

Notas sobre o formato:

- `transcript` vem **em ordem cronológica**, misturando os participantes como na
  conversa real (o Recall entrega separado por pessoa; nós reordenamos).
- `speaker` é o nome como aparece no Meet. Quem não tem nome vira
  `Participante {n}` — nunca `null`.
- `isHost` marca quem abriu a reunião. Normalmente é o atendente.
- `sessionId` pode vir `null` se ninguém amarrou a conversa. A transcrição não
  se perde: ela fica no painel esperando.

**Qualquer resposta 2xx** conta como entregue. Se der erro, marcamos como
`failed` e a transcrição fica no painel pra reenvio manual — nada é descartado.

> **Este formato é uma proposta.** Se o chatPro precisar de outro, é só dizer:
> a mudança é em um arquivo só (`server/src/chatpro/client.ts`), foi feito
> justamente pra isso.

---

## Onde disparar do lado do chatPro

O gatilho natural é **quando o atendente abre a reunião** — o mesmo momento em
que o chatPro já sabe o `sessionId` da conversa e a URL do Meet.

Se o chatPro gera a URL do Meet, chame logo depois de gerar. Se o atendente cola
uma URL existente, chame quando ele confirmar.

Não precisa esperar ninguém entrar: o bot fica na sala de espera até ser
admitido.

⚠️ **Alguém precisa admitir o bot.** Hoje ele entra como convidado anônimo. Pra
ele entrar direto é preciso configurar um bot autenticado com uma conta Google
dedicada — está na lista de pendências.

---

## Consultar sem esperar o webhook

Se o chatPro quiser mostrar o andamento:

**`GET /api/meetings/{id}`** (com o `Authorization: Bearer {PANEL_TOKEN}`)

Devolve o mesmo objeto do `POST`, mais `falas` e `participantes` quando já
houver transcrição.

Os `status` possíveis, na ordem em que acontecem:

| status | significa |
|---|---|
| `created` | bot criado, ainda não entrou |
| `joining` | entrando na chamada |
| `waiting_room` | **na sala de espera — alguém precisa admitir** |
| `recording` | gravando |
| `ended` | chamada encerrada, transcrição sendo processada |
| `done` | transcrição pronta |
| `failed` | deu errado (o motivo fica no campo `error`) |

E o `chatproStatus`, que é o andamento da entrega pra vocês:

| chatproStatus | significa |
|---|---|
| `pending` | esperando envio |
| `sent` | entregue |
| `failed` | tentamos e falhou — dá pra reenviar pelo painel |
| `skipped-no-url` | `CHATPRO_API_URL` não está configurada |
