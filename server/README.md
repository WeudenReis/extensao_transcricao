# Backend — chatPro × Meet × Voreo

Backend Node 20 + TypeScript estrito que fecha o pipeline:

```
extensão Chrome ──POST /api/links──► vínculo sessionId(chatPro) ↔ meetingCode(Meet)
Meet REST API v2 ◄── spaces com transcrição automática ON (POST /api/spaces)
Workspace Events ──Pub/Sub push──► POST /webhooks/pubsub
transcript.v2.fileGenerated ──► busca entries paginadas ──► payload ──► Voreo
```

## Como rodar

```bash
cd server
npm install
cp .env.example .env    # e preencha (no Windows: copy .env.example .env)
npm run dev             # tsx watch em http://localhost:3333
```

Outros scripts:

- `npm run build` — compila com `tsc` para `dist/` (zero erros TS é requisito)
- `npm start` — roda o build (`node dist/index.js`)
- `npm test` — vitest (`vitest run`)

Pré-requisitos externos: projeto GCP com Meet REST API + Workspace Events API +
Pub/Sub habilitadas e tópico com push subscription — passo a passo em
[`../docs/SETUP-GCP.md`](../docs/SETUP-GCP.md).

## Fluxo OAuth (uma vez)

1. Suba o servidor (`npm run dev`).
2. Abra **http://localhost:3333/oauth/start** no navegador com a conta
   Workspace que fará as reuniões.
3. Aceite os escopos (`meetings.space.settings`, `meetings.space.readonly`,
   `openid email`). O consent usa `access_type=offline` + `prompt=consent`,
   então o Google devolve um **refresh token**, que fica persistido no SQLite
   **cifrado com AES-256-GCM** (`TOKEN_ENCRYPTION_KEY`). Sem a chave, salva em
   texto puro com warning (só para dev).
4. Pronto — o access token é renovado automaticamente daí em diante, e o
   backend cria/renova a subscription do Workspace Events sozinho (no boot,
   logo após o OAuth e a cada 6 h).

## Como o pipeline funciona

1. **Vínculo** — a extensão envia `POST /api/links {sessionId, meetingCode}`.
   O backend tenta resolver o `space_name` na hora (`spaces.get` aceita
   `spaces/{meetingCode}`) — best-effort, sem bloquear o vínculo.
2. **Transcrição garantida** — `POST /api/spaces` cria um space já com
   `autoTranscriptionGeneration: "ON"`; o atendente usa o `meetingUri`
   retornado na call com o cliente.
3. **Evento** — quando o Meet gera o arquivo de transcrição, o Workspace
   Events publica `google.workspace.meet.transcript.v2.fileGenerated` no
   tópico Pub/Sub, que faz push em `POST /webhooks/pubsub`. O endpoint valida
   o OIDC token: audience (`PUBSUB_VERIFICATION_AUDIENCE`) e, com
   `PUBSUB_SERVICE_ACCOUNT` setada, também o e-mail verificado do service
   account da push subscription. **Sem audience configurada o push é
   rejeitado (403)** — exceto com `ALLOW_INSECURE_PUBSUB=true` (só dev).
   O evento validado é gravado na **fila durável** (`event_queue`) antes do
   ack 204; se a gravação falhar o webhook responde 5xx e o Pub/Sub reentrega.
4. **Pipeline** (worker da `event_queue`, a cada 30 s + "poke" após cada
   push) — do nome do transcript: busca o `conferenceRecord` (pega o space),
   resolve o vínculo por `space_name` ou por `meeting_code`, baixa **todas**
   as entries (pageSize 100, paginação completa — entries somem 30 dias
   depois da conferência), resolve `participant → displayName` via
   `conferenceRecords.participants` e monta o payload. Falha transitória da
   Meet API (500/429/rede) → retry com backoff 30 s → ~1 h, máx 10 tentativas
   → `dead`. Evento sem vínculo → `no-link`, retentado a cada 10 min por até
   48 h — e **reativado na hora** quando um `POST /api/links` novo chega.
5. **Fallback** — `conference.v2.ended` entra na fila com re-checagem 2 min
   depois do fim da conferência, caso o `fileGenerated` não tenha chegado;
   sem transcripts ainda, retenta com o mesmo backoff.
6. **Voreo** — `POST VOREO_WEBHOOK_URL` com `Authorization: Bearer
   VOREO_API_KEY`. Falhou? Entra na fila SQLite com backoff exponencial
   (30 s → 60 s → … teto 30 min; worker a cada 30 s; máx 8 tentativas, depois
   `failed`). `VOREO_WEBHOOK_URL` vazio? Loga resumo e marca
   `skipped-no-url` (modo dev).

Payload enviado à Voreo (adapter em `src/voreo/client.ts` — ajustar ali quando
o contrato real da Voreo existir):

```json
{
  "sessionId": "uuid da sessão do chatPro",
  "meetingCode": "abc-defg-hij",
  "conferenceRecord": "conferenceRecords/…",
  "startTime": "…", "endTime": "…",
  "participants": [{ "name": "Maria Atendente" }],
  "transcript": [{ "speaker": "…", "text": "…", "startTime": "…", "endTime": "…" }],
  "docsExportUri": "https://docs.google.com/…",
  "source": "chatpro-meet-extension"
}
```

## Endpoints

| Método | Rota                | Descrição                                                        |
| ------ | ------------------- | ---------------------------------------------------------------- |
| GET    | `/oauth/start`      | Redireciona pro consent do Google (fazer uma vez)                |
| GET    | `/oauth/callback`   | Troca o code e persiste o refresh token cifrado                  |
| POST   | `/api/links`        | `{sessionId (uuid), meetingCode, source?}` — upsert do vínculo   |
| GET    | `/api/links`        | Lista os vínculos                                                |
| POST   | `/api/spaces`       | Cria space com transcrição ON → `{meetingUri, meetingCode}`      |
| GET    | `/api/health`       | Liveness                                                         |
| GET    | `/api/status`       | Auth ok? Subscription ativa? Fila Voreo (pending/dead)?          |
| POST   | `/webhooks/pubsub`  | Push do Cloud Pub/Sub (Workspace Events)                         |

`meetingCode` aceita o código puro (`abc-defg-hij`) ou a URL completa do Meet —
é normalizado no servidor.

## Decisões técnicas

- **`google-auth-library` + `fetch` nativo, sem `googleapis`**: usamos meia
  dúzia de endpoints REST simples do Meet v2 e do Workspace Events. O pacote
  `googleapis` traria dezenas de MB e tipos gerados que não controlamos; com
  fetch os clients ficam ~200 linhas, 100% tipados à mão e fáceis de mockar
  nos testes. O `google-auth-library` continua cuidando do que é difícil:
  OAuth2, refresh de token e validação do OIDC do Pub/Sub.
- **ESM** (`"type": "module"` + `module: NodeNext`): padrão do ecossistema
  atual, funciona direto com tsx, tsc e vitest.
- **better-sqlite3**: síncrono, robusto, com prebuilds pra Windows (validado
  neste ambiente). Migrations inline com `CREATE TABLE IF NOT EXISTS`.
- **Fila Voreo no próprio SQLite** (`voreo_queue`): sobrevive a restart do
  processo, sem dependência extra de broker.
- **Fila durável de eventos** (`event_queue`): o Pub/Sub não reentrega após o
  ack 2xx, então o webhook persiste o evento ANTES de ack-ar; o worker
  processa com retry — um 500 transitório da Meet API não perde transcript, e
  eventos `no-link` esperam o vínculo chegar (até 48 h).
- **CORS liberado apenas em `/api/*`** (sem credenciais): a extensão pode
  apontar pra um backend remoto (VPS/túnel) sem esbarrar no preflight.
  `/webhooks/*` e `/oauth/*` ficam sem CORS.
- **Logs nunca contêm transcript nem tokens** — só contagens, resource names
  e status (`src/log.ts`).

## Estrutura

```
server/
├── src/
│   ├── index.ts            # bootstrap Express + startup tasks
│   ├── config.ts           # env validada com zod (falha cedo)
│   ├── crypto.ts           # AES-256-GCM do refresh token
│   ├── db.ts               # better-sqlite3 + migrations inline
│   ├── log.ts              # logger com prefixo de módulo
│   ├── google/
│   │   ├── auth.ts         # OAuth2 (start/callback/refresh)
│   │   ├── meet.ts         # client tipado da Meet REST API v2
│   │   └── events.ts       # Workspace Events (criar/renovar subscription)
│   ├── pipeline/
│   │   ├── transcript.ts   # evento → entries → payload Voreo
│   │   └── eventQueue.ts   # fila durável de eventos (retry/no-link/dead)
│   ├── routes/
│   │   ├── api.ts          # /api/links, /api/spaces, /api/health, /api/status
│   │   └── pubsub.ts       # /webhooks/pubsub (OIDC + decode + async)
│   └── voreo/
│       └── client.ts       # adapter Voreo + fila com backoff
└── test/                   # vitest (describe/it em português)
```

## Testes

```bash
npm test
```

Cobrem: assembler do transcript com paginação mockada, resolução de vínculo
(por `space_name` e por `meeting_code`), validação zod do `/api/links`,
decodificação do push Pub/Sub (base64 → CloudEvent) e a fila Voreo
(backoff, teto de tentativas, modo dev sem URL).
