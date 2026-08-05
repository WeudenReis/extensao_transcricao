# TASKS — Extensão chatPro × Meet × Voreo

> Bloco de notas de tasks gerado em 05/08/2026 (execução noturna autônoma).
> Objetivo: extensão Chrome (instalação local, fora das lojas) que captura o **session id do chatPro**,
> vincula ao **Meet** feito com o cliente daquela sessão, extrai a **transcrição via Meet REST API v2**
> e envia **session id + transcrição** para a **Voreo** analisar a reunião.

## Fluxo do produto

```
chatPro (session id) ──► Meet com o cliente ──► transcrição automática (Meet REST API v2)
        │                                              │
        └────────────── vínculo sessionId ↔ meet ──────┘
                                │
                                ▼
                        Voreo (análise da reunião)
```

## Descobertas da pesquisa (base das tasks)

### Meet REST API v2 (`https://meet.googleapis.com`)
- `spaces.create` / `spaces.patch` — configurar `config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration: "ON"` (escopo `meetings.space.settings`). Transcrição liga sozinha quando a reunião começa.
- `conferenceRecords.list` (filtro por `space.name`) → `conferenceRecords/{id}`
- `conferenceRecords.transcripts.list` → `.../transcripts/{id}` (tem `docsDestination.exportUri` + `document` = Google Docs gerado)
- `conferenceRecords.transcripts.entries.list` → falas estruturadas (participante, texto, startTime/endTime). **Entries somem 30 dias após a reunião** — buscar logo.
- `spaces.get` aceita `spaces/{meetingCode}` — é assim que converte o código da URL do Meet (xxx-yyyy-zzz) em space name.
- Requisito de conta: transcrição automática exige edição Workspace elegível (Business Standard+ / Gemini). Conta pessoal @gmail não gera transcript.

### Workspace Events API + Cloud Pub/Sub (webhooks)
- Eventos Meet: `conference.v2.started/ended`, `participant.v2.joined/left`, `recording.v2.*`, **`transcript.v2.started/ended/fileGenerated`**.
- `targetResource`: `//meet.googleapis.com/spaces/{space}` ou `//cloudidentity.googleapis.com/users/{user}` (todos os meets do usuário dono).
- Endpoint de notificação = tópico Pub/Sub `projects/{proj}/topics/{topic}`; conceder `roles/pubsub.publisher` a `meet-api-event-push@system.gserviceaccount.com`.
- Pub/Sub entrega por **push subscription** para o nosso webhook HTTPS. Assinaturas expiram — renovar via `subscriptions.patch`.
- Gatilho principal do pipeline: **`transcript.v2.fileGenerated`** → buscar entries → montar payload → enviar pra Voreo.

### Captura do session id (chatPro)
- URL: `https://app.chatpro.com.br/chat/{uuid}` → regex na `window.location.href`.
- DOM (fallback/confirmação): `section.session-cards` → card `.card--active` → `href` do link contém o uuid.
- Não está em localStorage/sessionStorage/cookies — URL + DOM são as fontes.
- Precisa reagir a troca de conversa **sem reload**: `MutationObserver` no sidebar + `chrome.tabs.onUpdated` no service worker.

---

## TASK 1 — Estrutura do repo e agents ✅ (base importada)
- [x] Agents copiados do suportetrelado (commit 1eb9bbb)
- [ ] Personalizar `.agents/skills/*` para o domínio (extensão MV3 + Meet API + Pub/Sub + Voreo)
- [ ] Criar `CLAUDE.md` próprio do projeto

## TASK 2 — Extensão Chrome MV3 (`extension/`)
- [ ] `manifest.json` MV3: `content_scripts` (chatPro + meet.google.com), `permissions`: `tabs`, `storage`, `alarms`; `host_permissions` para os dois domínios + backend local
- [ ] `content/chatpro.js`: extrai session id da URL (regex uuid) com fallback `.card--active` no DOM; `MutationObserver` em `section.session-cards` para troca de conversa sem reload; envia `{sessionId, capturedAt}` ao service worker
- [ ] `content/meet.js`: extrai meeting code de `meet.google.com/xxx-yyyy-zzz`; detecta entrada/saída da chamada; envia ao service worker
- [ ] `background/service-worker.js`: estado central em `chrome.storage.local`; `chrome.tabs.onUpdated` + `chrome.tabs.onActivated` para reler URL a cada troca de aba; faz o **vínculo sessionId ↔ meetingCode** (último session ativo quando o Meet abre); POST do vínculo pro backend
- [ ] `popup/`: UI seguindo o Manual de Marca chatPro — verde #25D066 (CTA), hover #1BAD53, neon #24FF72, dark #1d2125/#22272b/#2c333a, cinzas #D1D1D5/#E6E5E8/#F1F0F2, Paytone One (títulos) + Space Grotesk (texto), escrever sempre "chatPro". Mostra: session ativa, meet vinculado, status da transcrição, botão "Vincular manualmente"
- [ ] Ícones da extensão nas cores chatPro (16/32/48/128 px)
- [ ] Sem build step — JS puro, instalável via "Load unpacked"

## TASK 3 — Backend Node/TS (`server/`)
- [ ] Bootstrap: Node 20 + TypeScript estrito + Express (ou Fastify), `.env.example`, scripts npm
- [ ] OAuth2 Google (Authorization Code + refresh token persistido): escopos `meetings.space.settings`, `meetings.space.readonly`, `workspace.events` (subscriptions)
- [ ] `POST /api/spaces` — cria/patcheia space com `autoTranscriptionGeneration: "ON"` e devolve `meetingUri` (link já com transcrição garantida para usar com o cliente)
- [ ] `POST /api/links` — recebe da extensão `{sessionId, meetingCode}` e persiste (SQLite via better-sqlite3 ou JSON store)
- [ ] Setup Workspace Events: criar subscription (`targetResource` = user dono, `eventTypes` = `transcript.v2.fileGenerated`, `conference.v2.ended`), renovação automática antes de expirar (cron/setInterval + `subscriptions.patch`)
- [ ] `POST /webhooks/pubsub` — endpoint push do Pub/Sub: valida token OIDC do push, decodifica base64, roteia por `ce-type`
- [ ] Pipeline no `transcript.v2.fileGenerated`: `transcripts.entries.list` (paginação completa) → montar transcript estruturado `[{speaker, text, startTime, endTime}]` → resolver sessionId pelo vínculo (conferenceRecord → space → meetingCode) → montar payload Voreo
- [ ] `VoreoClient` — adapter limpo: `VOREO_WEBHOOK_URL` + `VOREO_API_KEY` via env; payload `{sessionId, meetingCode, conferenceRecord, startTime, endTime, participants, transcript, docsExportUri}`; retry com backoff; fila local se Voreo estiver fora
- [ ] Logs estruturados com prefixo de módulo, erros nunca silenciosos

## TASK 4 — Infra GCP (documentar, não dá pra executar sem credenciais)
- [ ] `docs/SETUP-GCP.md`: criar projeto, ativar Meet API + Workspace Events API + Pub/Sub, OAuth consent screen (interno), criar client id, criar tópico, grant `meet-api-event-push@system.gserviceaccount.com` como publisher, criar push subscription apontando pro backend (ngrok/Cloudflare Tunnel em dev)

## TASK 5 — Distribuição local (fora das lojas)
- [ ] `docs/INSTALACAO.md`: passo a passo com prints textuais — `chrome://extensions` → Developer mode → Load unpacked → pasta `extension/`; como atualizar; aviso de que o Chrome pede confirmação de dev mode
- [ ] Script `scripts/package.ps1` que zipa a pasta `extension/` para mandar pra galera

## TASK 6 — QA
- [ ] Testes unitários do parser de session id (regex + DOM) e do assembler de transcript
- [ ] Checklist manual: troca de aba, troca de conversa sem reload, Meet aberto antes/depois do chatPro, dois Meets seguidos

## TASK 7 — Pendências pro Weuden (PENDENCIAS.md)
- [ ] Tudo que depender de credencial real, conta Workspace, contrato da Voreo, teste em Meet real
