# Tasks — Integração Recall.ai × chatPro (branch `recall-ai`)

Ordem de execução e critério de pronto. Detalhes técnicos em `ARQUITETURA-RECALL.md`.

## Bloco 1 — Fundação

- [ ] **T1. Config e envs** (`server/src/config.ts`, `.env.example`)
  `RECALL_API_KEY`, `RECALL_REGION` (default `us-west-2`), `RECALL_WEBHOOK_SECRET`,
  `RECALL_BOT_NAME` (default `chatPro (gravando)`), `PUBLIC_BASE_URL`,
  `CHATPRO_API_URL`, `CHATPRO_API_KEY`, `AUTO_SEND_CHATPRO`.
  *Pronto quando:* servidor sobe sem nenhuma delas (modo dev) e avisa no log o que falta.

- [ ] **T2. Tabelas** (`server/src/db.ts`): `meetings` e `recall_events` + métodos.
  *Pronto quando:* migrations rodam em banco novo e existente, sem quebrar as tabelas atuais.

- [ ] **T3. Cliente da API** (`server/src/recall/client.ts` + `types.ts`)
  `createBot`, `getBot`, `leaveCall`, `downloadTranscript`. Timeout, erro tipado
  (`RecallApiError` com status), **nunca logar a API key**.
  *Pronto quando:* testes com `fetch` injetado cobrem sucesso, 4xx e timeout.

## Bloco 2 — Entrada e webhooks

- [ ] **T4. Rotas de reunião** (`server/src/routes/meetings.ts`)
  `POST /api/meetings {meetingUrl, sessionId?}` → cria bot com
  `metadata.session_id` → grava em `meetings`.
  `GET /api/meetings` (lista), `GET /api/meetings/:id` (detalhe + transcript),
  `POST /api/meetings/:id/leave` (tira o bot da call).
  Validar `meetingUrl` com zod (aceitar só URL de Meet).
  *Pronto quando:* zod recusa URL inválida e o vínculo é gravado.

- [ ] **T5. Verificação de assinatura** (`server/src/recall/verify.ts`)
  Svix: `webhook-id`, `webhook-timestamp`, `webhook-signature`; segredo `whsec_`;
  HMAC-SHA256 de `{id}.{ts}.{corpo}`; `timingSafeEqual`; rejeitar timestamp
  velho (>5 min) contra replay. Precisa do **corpo cru** (`express.raw`).
  *Pronto quando:* teste valida assinatura boa, recusa adulterada e recusa antiga.

- [ ] **T6. Endpoint do webhook** (`server/src/routes/recallHook.ts`)
  `POST /webhooks/recall`: verifica → **enfileira** → responde 2xx (limite de 15s
  do Recall). Dedup por `webhook-id`. Sem segredo configurado: 403, salvo
  `ALLOW_INSECURE_RECALL=true` (só dev, com warning).
  *Pronto quando:* payload duplicado não gera trabalho dobrado.

## Bloco 3 — Processamento

- [ ] **T7. Worker da fila** (`server/src/pipeline/recallQueue.ts`)
  Backoff exponencial, máx tentativas → `dead`, retomada no boot.
  - `bot.*` → atualiza `meetings.status`
  - `transcript.done` → busca bot, baixa transcript, normaliza, grava
  - `bot.fatal` / `transcript.failed` → status `failed` + motivo
  *Pronto quando:* falha transitória retenta e sucesso não reprocessa.

- [ ] **T8. Normalizador** (`server/src/recall/transcript.ts`)
  `words[]` → falas legíveis: agrupar por participante, quebrar em frases quando
  houver pausa (> ~1,5s) ou pontuação, manter `startMs`/`endMs`, marcar host.
  Saída no mesmo formato do painel: `{speaker, text, startMs, endMs}`.
  *Pronto quando:* testes cobrem pausa, troca de falante e lista vazia.

- [ ] **T9. Adapter do chatPro** (`server/src/chatpro/client.ts`)
  `POST {CHATPRO_API_URL}` com `{sessionId, meetingUrl, startedAt, endedAt,
  participants, transcript[], source:'recall-ai'}`. Sem URL → `skipped-no-url`
  (modo dev, sem rede). Retry com backoff. Envio automático só com
  `AUTO_SEND_CHATPRO=true`; senão, botão no painel.
  *Pronto quando:* modo dev não toca a rede e o retry é testado.

## Bloco 4 — Interface e fechamento

- [ ] **T10. Painel** (`reviewPage.ts`): aba/seção das reuniões do Recall —
  status do bot ao vivo, transcrição com nomes reais, copiar tudo, paginação,
  botão "Enviar pro chatPro", campo pra colar a URL do Meet e chamar o bot.

- [ ] **T11. Wiring** (`server/src/index.ts`): registrar rotas e worker;
  `express.raw` **só** em `/webhooks/recall` (antes do `express.json`).

- [ ] **T12. Testes + docs**: suíte verde; `docs/SETUP-RECALL.md` (criar segredo,
  assinar eventos, cadastrar URL, admitir o bot) e atualizar `PENDENCIAS.md`.

## Fora de escopo agora

- Bot autenticado no Google (evita sala de espera) — depende de conta dedicada.
- Transcrição em tempo real (websocket) — hoje é pós-reunião, que basta.
- Não mexer nas extensões: seguem intactas em `main`.
