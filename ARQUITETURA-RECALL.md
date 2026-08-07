# Arquitetura — Integração Recall.ai × chatPro

> Branch `recall-ai`. Substitui as extensões de captura por um **bot server-side**
> que entra na reunião, grava e transcreve. Escrito em 06/08/2026.

## Por que trocar as extensões pelo Recall.ai

O caminho anterior (extensão capturando áudio/legenda no navegador) esbarrou em
três muros que **não têm solução limpa** no navegador:

| Problema | Extensão | Recall.ai |
|---|---|---|
| Áudio do cliente vinha mudo (bug do Chrome com WebRTC remoto) | recorrente | não existe — grava no servidor |
| Zero-clique impossível (Chrome exige gesto pro `tabCapture`) | bloqueado | bot entra sozinho |
| Atendente podia desligar a captura | mitigável, nunca resolvido | **impossível** — roda fora da máquina dele |
| Transcrição repetida / incompleta (painel de legenda) | recorrente | transcript estruturado por participante |
| Instalar/manter em N máquinas | fricção alta | **nada instalado** |

Custo: o Recall.ai é pago por hora de gravação, e o bot **aparece como
participante** na chamada — o que, do ponto de vista de LGPD, é uma vantagem: o
consentimento fica evidente para o cliente.

## Visão geral do fluxo

```
chatPro (atendente abre conversa)                 Google Meet
   │  sessionId (uuid)                                 ▲
   │                                                   │ bot entra
   ▼                                                   │
┌─────────────────────────────────────────────────────────────┐
│  BACKEND (server/, Node 20 + TS + Express + SQLite)         │
│                                                             │
│  1. POST /api/meetings                                      │
│     { meetingUrl, sessionId } → cria bot no Recall.ai       │
│     guarda o vínculo bot_id ↔ sessionId                     │
│                                                             │
│  2. POST /webhooks/recall   ← Recall.ai (assinado)          │
│     bot.joining_call / in_call_recording / call_ended /     │
│     done / fatal          → atualiza estado da reunião      │
│     transcript.done       → dispara o passo 3               │
│                                                             │
│  3. Busca o transcript (GET /api/v1/bot/{id}) → download_url│
│     → normaliza (participante + falas + tempos)             │
│                                                             │
│  4. Entrega ao chatPro (e/ou Voreo) com o sessionId         │
└─────────────────────────────────────────────────────────────┘
```

## Fatos confirmados da API (verificados em 06/08/2026)

- **Base URL por região:** `https://{regiao}.recall.ai/api/v1/`
  Regiões: `us-east-1`, **`us-west-2` (pay-as-you-go — a nossa)**, `eu-central-1`, `ap-northeast-1`.
- **Auth:** header `Authorization: Token {RECALL_API_KEY}`.
  ✅ Chave testada contra `GET /api/v1/bot/` → HTTP 200 (workspace vazio).
- **Criar bot:** `POST /api/v1/bot`
  ```json
  {
    "meeting_url": "https://meet.google.com/abc-defg-hij",
    "bot_name": "chatPro (gravando)",
    "recording_config": { "transcript": { "provider": { "recallai_streaming": {} } } },
    "metadata": { "session_id": "<uuid do chatPro>" }
  }
  ```
  > `metadata` é o truque central: o Recall devolve esse objeto em **todo**
  > webhook, então o vínculo com o chatPro nunca se perde.
- **Buscar transcript:** `GET /api/v1/bot/{id}` →
  `recordings[0].media_shortcuts.transcript.data.download_url` (link temporário).
- **Formato do transcript** (o que resolve a diarização):
  ```json
  [{ "participant": { "id": 1, "name": "Michael", "is_host": false, "email": null },
     "language_code": "pt-BR",
     "words": [{ "text": "olá",
                 "start_timestamp": { "absolute": "...", "relative": 12.3 },
                 "end_timestamp":   { "absolute": "...", "relative": 12.8 } }] }]
  ```
  Cada bloco já vem **por participante** — nada de heurística de nome, nada de
  texto repetido. É o oposto do que sofremos com a legenda.

### Webhooks

Dois grupos, ambos configurados no dashboard da região:

**Estado do bot** — `bot.joining_call`, `bot.in_waiting_room`,
`bot.in_call_not_recording`, `bot.recording_permission_allowed` / `_denied`,
`bot.in_call_recording`, `bot.call_ended`, `bot.done`, `bot.fatal`.

**Artefatos** — `transcript.processing` / **`transcript.done`** / `transcript.failed`,
`recording.done`, etc. (é preciso **assinar cada evento** no dashboard).

Payload comum:
```json
{ "event": "transcript.done",
  "data": { "data": { "code": "done", "sub_code": null, "updated_at": "..." },
            "transcript": { "id": "...", "metadata": {} },
            "recording":  { "id": "...", "metadata": {} },
            "bot":        { "id": "...", "metadata": { "session_id": "..." } } } }
```

**Assinatura (Svix):** headers `webhook-id`, `webhook-timestamp`,
`webhook-signature`; segredo começa com `whsec_`. Verificação:
HMAC-SHA256 sobre `{id}.{timestamp}.{corpo}`, comparado com `timingSafeEqual`.
⚠️ O segredo **precisa ser criado no dashboard**, senão os headers não vêm.

**Regras de resposta:** responder **2xx em até 15s**; retenta por 24h; endpoint
que falha 5 dias seguidos é desativado. → Por isso: **gravar o evento e responder
na hora**, processar depois (mesmo padrão da `event_queue` que já usamos).

### Google Meet — restrições que importam

- Bot **não autenticado** entra como anônimo e **precisa ser admitido** por
  alguém da chamada (sala de espera).
- Bot **autenticado** (login Google) evita a sala de espera, mas ainda respeita a
  configuração do host.
- **Não suporta** breakout rooms nem livestream.

> Consequência prática: no começo, **alguém precisa admitir o bot**. Isso é
> visível e auditável (diferente de "esqueci de ligar a gravação"). Se virar
> atrito, o passo seguinte é configurar bot autenticado.

## Modelo de dados (novo, isolado do que já existe)

```sql
meetings (
  id TEXT PRIMARY KEY,        -- uuid nosso
  bot_id TEXT UNIQUE,         -- id do bot no Recall
  session_id TEXT,            -- sessão do chatPro (pode chegar depois)
  meeting_url TEXT NOT NULL,
  meeting_code TEXT,
  status TEXT NOT NULL,       -- created|joining|waiting_room|recording|ended|done|failed
  bot_name TEXT,
  started_at TEXT, ended_at TEXT,
  transcript_json TEXT,       -- normalizado
  duration_seconds INTEGER,
  chatpro_status TEXT,        -- pending|sent|failed|skipped-no-url
  error TEXT, created_at TEXT NOT NULL
)

recall_events (                -- fila durável (responder rápido, processar depois)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT UNIQUE,      -- dedup de reentrega
  event TEXT NOT NULL, bot_id TEXT, payload_json TEXT NOT NULL,
  status TEXT NOT NULL,        -- pending|done|dead
  attempts INTEGER DEFAULT 0, next_attempt_at TEXT,
  created_at TEXT NOT NULL, last_error TEXT
)
```

## Estrutura de arquivos

```
server/src/recall/
  client.ts      cliente da API (createBot, getBot, leaveCall, downloadTranscript)
  types.ts       tipos do payload e do transcript
  verify.ts      verificação da assinatura Svix
  transcript.ts  normaliza words[] → falas legíveis por participante
server/src/routes/
  meetings.ts    POST /api/meetings, GET /api/meetings, GET /api/meetings/:id
  recallHook.ts  POST /webhooks/recall (assina → enfileira → 2xx)
server/src/pipeline/
  recallQueue.ts worker da fila (backoff), busca transcript e entrega
server/src/chatpro/
  client.ts      entrega da transcrição ao chatPro (adapter)
```

## Decisões de projeto

1. **`metadata.session_id` no bot** — o vínculo com o chatPro viaja junto com o
   bot e volta em todo webhook. Elimina a adivinhação de "qual conversa era" que
   nos deu problema na extensão (vínculo automático por janela de 4h).
2. **Webhook responde 2xx imediato** e enfileira. O limite de 15s do Recall não
   permite processar inline; e a fila durável já provou valor aqui.
3. **Dedup por `webhook-id`** — reentrega é esperada (retenta por 24h).
4. **Adapter do chatPro** isolado em um arquivo, como fizemos com a Voreo: quando
   o contrato real existir, muda só ali.
5. **Não mexer no código das extensões** — fica intacto em `main` como fallback.

## O que continua pendente de você

- Criar o **segredo de webhook** no dashboard do Recall (região us-west-2) e
  assinar os eventos `bot.*` e `transcript.*`.
- Expor o backend com **HTTPS público** (túnel/hospedagem) e cadastrar a URL
  `/webhooks/recall` no dashboard.
- Contrato real da **API do chatPro** (endpoint + auth) para a entrega final.
- Decidir sobre **bot autenticado** (evita sala de espera).
