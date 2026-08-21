# CLAUDE.md — Transcrição de Reuniões chatPro

Extensão Chrome (Manifest V3) + backend Node/TS que captura o session id do atendimento no chatPro, configura a transcrição automática do Google Meet, recebe o evento de transcrição pronta via Cloud Pub/Sub e envia o resultado para a plataforma Voreo analisar a reunião.

Distribuição fora das lojas: **Load unpacked** (zip da pasta `extension/` gerado por `scripts/package.ps1`).

## Stack

- **Extensão:** Chrome MV3, JS puro, **sem build step**, sem frameworks. Popup em HTML/CSS/JS vanilla.
- **Backend (`server/`):** Node 20 + TypeScript **estrito** + Express + better-sqlite3.
- **Google:** Meet REST API v2 (`config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration: "ON"`, escopo `meetings.space.settings`), Workspace Events API com push no Cloud Pub/Sub (evento chave `google.workspace.meet.transcript.v2.fileGenerated`), `conferenceRecords.transcripts.entries.list` (**entries somem em 30 dias**).
- **Saída:** VoreoClient envia `{sessionId, transcript, metadados}` — payload mínimo, nada além do necessário.

## Estrutura de Pastas

```
extension/
  manifest.json                 # permissions, host_permissions, matches, service worker
  content/chatpro.js            # captura sessionId: regex em window.location.href
                                #   (https://app.chatpro.com.br/chat/{uuid}), fallback DOM
                                #   section.session-cards → .card--active → href,
                                #   MutationObserver p/ troca de conversa sem reload
  content/meet.js               # content script do Google Meet
  background/service-worker.js  # chrome.tabs.onUpdated, mensageria, estado em chrome.storage
  popup/                        # UI do atendente (identidade visual chatPro)
server/
  src/                          # OAuth Google, /api/spaces, /api/links, /webhooks/pubsub,
                                #   VoreoClient, subscription manager (Workspace Events)
scripts/
  package.ps1                   # gera o zip de distribuição da extensão
```

## Identidade Visual chatPro (OBRIGATÓRIO em qualquer UI)

- **Cores:** Verde Principal `#25D066` (CTAs) · Verde Hover `#1BAD53` · Verde Neon `#24FF72` (brilhos/efeitos) · Preto `#000000` · Cinzas `#D1D1D5` / `#E6E5E8` / `#F1F0F2`.
- **Dark theme:** `#1d2125` (primário) · `#22272b` (secundário) · `#2c333a` (cards).
- **Tipografia:** Paytone One (títulos) · Space Grotesk (subtítulos Bold, textos Regular). Por CSP de extensão: fontes **empacotadas localmente** (`@font-face`) ou fallback de sistema — **nunca CDN**.
- **Nome:** sempre **"chatPro"** (c minúsculo, P maiúsculo). Nunca "ChatPro", "Chat Pro", "CHATPRO".
- **Tom:** Simples, Prático e Intuitivo. Sem jargões técnicos na UI, sem pronomes neutros, sem exclamações em excesso.

## Regras de Git

- **Branch:** `main` (única). Branches curtas de feature são permitidas para mudanças grandes, com merge rápido.
- **Commits:** Conventional Commits **em português** (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`), mensagem clara e contextualizada.
- **NUNCA** `git push --force`. Divergiu do remoto? Investigar e resolver manualmente.
- **NUNCA** versionar `.env`, banco SQLite (`*.db`) ou o zip gerado.
- **Repositório:** https://github.com/WeudenReis/extensao_transcricao

## Variáveis de Ambiente (`server/.env` — nunca no código, nunca no Git)

| Variável | Uso |
|----------|-----|
| `GOOGLE_CLIENT_ID` | OAuth Google (client) |
| `GOOGLE_CLIENT_SECRET` | OAuth Google (secret) |
| `GOOGLE_REDIRECT_URI` | Callback do fluxo OAuth |
| `PUBSUB_VERIFICATION_AUDIENCE` | Audience esperada no token OIDC do push do Pub/Sub |
| `VOREO_WEBHOOK_URL` | Endpoint da Voreo que recebe a transcrição |
| `VOREO_API_KEY` | Autenticação junto à Voreo |
| `PORT` | Porta do Express |
| `DATABASE_PATH` | Caminho do arquivo SQLite |

O `/webhooks/pubsub` precisa de HTTPS público: em local, túnel via ngrok ou Cloudflare Tunnel — ao trocar a URL do túnel, atualizar o endpoint de push da subscription e a audience.

## Checklist Antes de Qualquer Push

1. `npm run build` em `server/` — zero erros de TypeScript.
2. `npm test` em `server/` — Vitest verde.
3. Extensão recarregada em `chrome://extensions` e fluxo básico revalidado (sessionId capturado, vínculo criado).
4. Nenhum secret, `.db` ou log com transcript indo para o commit.

## Problemas Comuns (verificar antes de "debugar" código)

- **Service worker MV3 inativo:** dorme após ~30s e perde variáveis em memória — estado sempre em `chrome.storage`; listeners registrados no topo do arquivo.
- **Content script não injetado:** conferir `matches`/`host_permissions` no `manifest.json` e recarregar a extensão (manifest só é relido no reload).
- **Subscription Pub/Sub expirada:** Workspace Events tem TTL; sem renovação, o evento de transcrição para de chegar em silêncio.
- **403 da Meet API:** escopo OAuth faltando (`meetings.space.settings`) ou edição do Google Workspace da conta sem o recurso.
- **Transcript vazio:** conta anfitriã sem transcrição elegível (edição/config do Workspace) — o `"ON"` no space não garante nada sozinho.
- **Push do Pub/Sub sem ack:** responder 2xx rápido e processar depois; sem ack o Pub/Sub reenvia (duplicatas + backlog).
- **Entries expiradas:** buscas 30+ dias após a reunião voltam vazias — é expurgo do Google, não bug.

## Segurança (inegociável)

- Validar o **token OIDC** de todo push em `/webhooks/pubsub` (assinatura, issuer, audience) antes de processar qualquer coisa.
- Refresh token Google só no SQLite, fora de pasta servida — nunca em log, código ou resposta de API.
- **Nunca logar o transcript inteiro** — transcrição de reunião é dado sensível de cliente (LGPD). Retenção local mínima; para a Voreo, só o payload necessário.
- SQLite sempre com prepared statements; rate limiting no webhook e nas rotas `/api/*`.

## Contexto e Custo (medido neste repositório)

Antes de varrer o repositório com `grep`, leia **`docs/MAPA.md`** — índice
gerado de 63 arquivos com o que cada um resolve e o que exporta. Regerar:
`node scripts/gerar-mapa.mjs`.

Antes de sondar a API do painel por tentativa e erro, leia
**`docs/CAMPOS-DO-PAINEL.md`** — o schema já foi mapeado campo a campo,
inclusive os doze nomes que **não** existem.

Regras que saíram de medição, não de gosto:

| Faça | Em vez de | Por quê |
|---|---|---|
| `npx vitest run --reporter=dot 2>&1 \| tail -4` | a saída inteira | 55 mil chars contra 367 mil |
| `grep -n` + `sed -n 'X,Yp'` | `cat` no arquivo | `fluxo-reuniao.js` tem 104 mil chars |
| `npx tsc --noEmit 2>&1 \| head -5` | a lista completa | os primeiros erros bastam |
| Exigir formato curto do subagente | prosa livre | cada workflow devolveu 600 mil+ tokens |

A suíte roda com `LOG_LEVEL=warn` (`server/vitest.config.ts`): 2.481 das 2.611
linhas de log eram `[INFO]` da aplicação e não diziam se o teste passou. `warn`
e `error` continuam ligados porque há testes que os verificam.

**O que NÃO cortar:** o porquê de uma decisão, o risco identificado, a correção
de uma premissa errada, o resultado real de um teste, e os comentários do
código. Cada comentário longo deste repo corresponde a um bug que já aconteceu.

Skills: `.claude/skills/economia` (contexto) e `.claude/skills/enxuto` (código).

## Protocolos de Skills

| Situação | Skill | Arquivo |
|----------|-------|---------|
| Planejar arquitetura/feature antes de codar | Tech Lead (read-only) | `.agents/skills/tech-lead.md` |
| Popup, content scripts, UI chatPro | Frontend de Extensão MV3 | `.agents/skills/frontend.md` |
| Rotas, integrações Google/Voreo, segurança | Backend & Segurança | `.agents/skills/backend-security.md` |
| Testes Vitest + checklist manual da extensão | QA | `.agents/skills/qa.md` |
| Diagnóstico de falhas (worker, Pub/Sub, 403…) | Debugger | `.agents/skills/debug.md` |
| Empacotar, túnel, git, entrega | DevOps & Deploy | `.agents/skills/deploy.md` |
| Decisão 360° (5 personas) | Conselho de Especialistas | `.agents/skills/conselho-especialistas.md` |
| Texto de UI, tom de voz, tokens semânticos | Constituição de microcopy | `.agents/skills/chatpro-microcopy/SKILL.md` |
| Retenção, LGPD, dados sensíveis (transcrições) | Governança de Dados | `.agents/skills/data-governance/SKILL.md` |
