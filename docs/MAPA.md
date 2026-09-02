# Mapa do repositório

> Gerado por `node scripts/gerar-mapa.mjs`. **Não edite à mão** — rode de novo.
>
> Serve pra responder "onde fica X" sem varrer o repositório com grep. Cada
> busca traz linhas que entram no contexto e não saem mais; este índice é
> lido uma vez.

## server/src

| Arquivo | O que resolve | Exporta |
|---|---|---|
| `server/src/chatpro/client.ts` (577) | Entrega da transcrição ao **chatPro Chat** (produto de conversas — não confundir com a "chatPro API", que é a de instâncias/WhatsApp). | MAX_TENTATIVAS, MAX_CARACTERES_COMENTARIO, backoffMs, ChatproPayload, ResultadoEntrega, PROVIDERS +7 |
| `server/src/chatpro/etiquetas.ts` (218) | Etiquetas automáticas no chatPro depois que a reunião termina. | SituacaoReuniao, SITUACOES_REUNIAO, EtiquetadorOptions, ResultadoEtiquetas, Etiquetador |
| `server/src/config.ts` (409) | Carrega e valida as variáveis de ambiente com zod. | ehHostLocal, painelUrlProtegeOToken, Config, ConfigError, faltamNoChatpro, recallConfigWarnings +1 |
| `server/src/crypto.ts` (56) | Cifra segredos (refresh token do Google) com AES-256-GCM. | encryptSecret, decryptSecret |
| `server/src/db.ts` (1690) | Persistência em SQLite (better-sqlite3) com migrations inline. | LinkRow, TranscriptSentRow, GoogleTokensRow, SubscriptionRow, VoreoQueueRow, CaptureStatus +15 |
| `server/src/google/auth.ts` (218) | OAuth2 Authorization Code do Google. | GOOGLE_SCOPES, GoogleAuthOptions, GoogleAuth, createOAuthRouter |
| `server/src/google/contas.ts` (224) | Conta Google de CADA atendente. | ESCOPOS_AGENDA, ContasGoogleOptions, ContasGoogle, ContaNaoConectada, ContaGoogleExpirada |
| `server/src/google/events.ts` (275) | Google Workspace Events API (https://workspaceevents.googleapis.com/v1). | EVENTS_API_BASE_URL, MEET_EVENT_TYPES, USER_TARGET_RESOURCE, WorkspaceSubscription, EventsApiError, EventsClientOptions +3 |
| `server/src/google/meet.ts` (274) | Client tipado da Google Meet REST API v2 (https://meet.googleapis.com/v2). | MEET_API_BASE_URL, SpaceConfig, MeetSpace, ConferenceRecord, Transcript, TranscriptEntry +6 |
| `server/src/google/meetLink.ts` (203) | Cria um link do Google Meet. | CALENDAR_BASE, MeetLinkError, MeetCriado, CriarMeetOptions, extrairMeetUrl, criarLinkDoMeet |
| `server/src/index.ts` (328) | Bootstrap: Express + rotas + tarefas de startup (diretório do DB garantido no construtor do Db; renovação de subscription no boot, após o OAuth conectar e a cad | — |
| `server/src/log.ts` (60) | Logger simples com prefixo de módulo e níveis. | LogLevel, setLogLevel, Logger, errorMessage, createLogger |
| `server/src/painel/client.ts` (1613) | Cliente do PAINEL DE REUNIÕES (a plataforma comercial da empresa). | PAINEL_TIMEOUT_MS, INTERVALO_AVISO_CONFIG_MS, PAINEL_TIMEOUT_CLIQUE_MS, TIPOS_REUNIAO, TipoReuniao, ehTipoReuniao +28 |
| `server/src/palavras/motor.ts` (270) | Motor de palavras-chave SEM IA — só código. | TopicoDetectado, normalizarTexto, detectarTopicos, MetaComentario, formatarComentarioPalavras |
| `server/src/palavras/topicos.ts` (141) | Dicionário de TÓPICOS do domínio chatPro (atendimento via WhatsApp). | TopicoDominio, TOPICOS |
| `server/src/pipeline/audioTranscript.ts` (400) | Transforma os chunks de áudio de uma captura em transcrição. | MergedEntry, Gap, Coverage, labelRemote, labelMic, mergeTracks +3 |
| `server/src/pipeline/enviosAgendados.ts` (166) | Worker dos ENVIOS AGENDADOS (tabela envios_agendados). | ENVIOS_WORKER_INTERVAL_MS, JANELA_PERDIDA_MS, ResumoPassada, EnviosAgendadosWorkerOptions, EnviosAgendadosWorker |
| `server/src/pipeline/eventQueue.ts` (245) | Fila DURÁVEL de eventos do Workspace Events (tabela event_queue). | EVENT_TRANSCRIPT_FILE_GENERATED, EVENT_CONFERENCE_ENDED, EVENT_MAX_ATTEMPTS, EVENT_BASE_BACKOFF_MS, EVENT_MAX_BACKOFF_MS, NO_LINK_RETRY_MS +7 |
| `server/src/pipeline/purge.ts` (60) | Expurgo LGPD: áudio bruto é dado sensível de cliente. | PurgeDeps, purgeOldCaptureAudio, startCapturePurgeJob |
| `server/src/pipeline/recallQueue.ts` (858) | Fila DURÁVEL dos webhooks do Recall.ai (tabela recall_events). | RECALL_MAX_ATTEMPTS, RECALL_BASE_BACKOFF_MS, RECALL_MAX_BACKOFF_MS, RECALL_WORKER_INTERVAL_MS, MEETING_AUSENTE_MAX_AGE_MS, RECALL_LOTE +21 |
| `server/src/pipeline/reconciliar.ts` (163) | Rede de segurança: PERGUNTA ao Recall o que aconteceu, em vez de esperar o webhook contar. | ResultadoReconciliacao, ReconciliarDeps, reconciliar, resumirReconciliacao |
| `server/src/pipeline/transcript.ts` (226) | Pipeline principal: do evento `transcript.v2.fileGenerated` até o payload pronto pra Voreo. | conferenceRecordFromTranscriptName, buildParticipantNameMap, AssembledEntry, assembleTranscript, TranscriptPipelineDeps, PipelineOutcome +1 |
| `server/src/recall/client.ts` (261) | Cliente da API do Recall.ai. | RECALL_TIMEOUT_MS, RecallApiError, RecallClientOptions, CreateBotInput, RecallClient |
| `server/src/recall/criarReuniao.ts` (359) | Colocar o bot numa reunião — o caminho ÚNICO. | JANELA_DEDUP_MS, JANELA_SEM_BOT_MS, ANTECEDENCIA_MINIMA_JOIN_AT_MS, TOLERANCIA_MESMO_HORARIO_MS, CriarReuniaoEntrada, ResultadoCriacao +3 |
| `server/src/recall/transcript.ts` (145) | Normaliza o transcript do Recall.ai para o formato que o painel e o chatPro consomem. | RecallTranscriptEntry, Fala, TranscriptNormalizado, normalizarTranscript |
| `server/src/recall/types.ts` (127) | Tipos da API do Recall.ai (bot que entra na reunião, grava e transcreve). | RECALL_REGIONS, RecallRegion, recallBaseUrl, RecallMetadata, RecallTranscriptShortcut, RecallMediaShortcuts +8 |
| `server/src/recall/verify.ts` (121) | Verificação da assinatura dos webhooks do Recall.ai (padrão Svix). | ResultadoVerificacao, EntradaVerificacao, verificarAssinatura, podeAceitar |
| `server/src/resumo/extrativo.ts` (117) | Resumo SEM IA nenhuma — só código. | resumoExtrativo |
| `server/src/resumo/gemini.ts` (95) | Resumo pelo **Gemini**, no free tier do Google. | GEMINI_MODELO_PADRAO, GerarComGeminiOptions, gerarComGemini |
| `server/src/resumo/index.ts` (314) | Resumo da reunião por IA (API da Anthropic). | ANTHROPIC_MESSAGES_URL, ANTHROPIC_VERSION, MODELO_PADRAO, RESUMO_TIMEOUT_MS, PROVEDORES_RESUMO, ProvedorResumo +5 |
| `server/src/resumo/prompt.ts` (170) | Montagem do prompt e o recorte da transcrição que cabe nele. | ORCAMENTO_CARACTERES, ParticipanteResumo, RecorteTranscricao, recortarTranscricao, SYSTEM_PROMPT, DadosDoPrompt +2 |
| `server/src/resumo/schema.ts` (69) | Contrato do JSON que pedimos ao modelo e a limpeza aplicada em cima dele. | ResumoReuniao, resumoSchema, normalizarResumo |
| `server/src/routes/api.ts` (173) | API consumida pela extensão Chrome e pelo atendente: - POST /api/links   → vínculo sessionId(chatPro) ↔ meetingCode(Meet) - GET  /api/links   → lista os vínculo | apiCors, linkBodySchema, LinkBody, ApiRouterDeps, createApiRouter |
| `server/src/routes/capture.ts` (220) | Ingest da captura de áudio feita pela extensão. | CaptureRouterDeps, createCaptureRouter |
| `server/src/routes/chatproHook.ts` (242) | Webhook do chatPro Chat: **POST /webhooks/chatpro/{segredo}** É o que torna a gravação automática. | MEET_NO_TEXTO, TETO_BOTS_JANELA, JANELA_TETO_MS, DadosMensagem, lerEvento, acharLinkDoMeet +2 |
| `server/src/routes/meetings.ts` (372) | Reuniões gravadas pelo bot do Recall.ai: POST /api/meetings                   → cria o bot e o manda entrar na call GET  /api/meetings                   → lista | criarReuniaoSchema, CriarReuniaoBody, ResumoReuniao, resumirReuniao, MeetingsRouterDeps, createMeetingsRouter |
| `server/src/routes/painelAuth.ts` (177) | Tranca do painel e das rotas de leitura. | COOKIE_TOKEN, ehCaminhoLivre, tokenConfere, extrairToken, criarPainelAuth |
| `server/src/routes/painelInterno.ts` (323) | Consultas ao painel interno que a EXTENSÃO precisa fazer: GET /api/painel/vendedores        → seletor de vendedor (apresentação agendada) GET /api/painel/onboar | PainelInternoRouterDeps, createPainelInternoRouter |
| `server/src/routes/pubsub.ts` (202) | Endpoint push do Cloud Pub/Sub (Workspace Events → tópico → push aqui). | DecodedPushMessage, decodePubSubPush, OidcTokenInfo, TokenVerifier, GoogleOidcVerifier, PubSubRouterDeps +1 |
| `server/src/routes/recallHook.ts` (127) | Webhook do Recall.ai: POST /webhooks/recall Regras do fornecedor: responder 2xx em até 15 s, reentrega por 24 h, endpoint que falha 5 dias seguidos é DESATIVADO | WebhookAnalisado, analisarCorpoWebhook, RecallHookRouterDeps, createRecallHookRouter |
| `server/src/routes/reunioes.ts` (1002) | O botão "Entrar na reunião" do chatPro. | montarResumo, FUSO, MAX_DIAS_AGENDAMENTO, ANTECEDENCIA_CONVITE_MS, TIPOS_REUNIAO, TipoReuniao +11 |
| `server/src/routes/review.ts` (118) | Painel de revisão local: o atendente/admin VÊ a transcrição (e ouve o áudio) ANTES de enviar pra Voreo. | ReviewRouterDeps, createReviewRouter |
| `server/src/routes/reviewPage.ts` (1672) | HTML do painel (servido em GET /). | reviewPageHtml |
| `server/src/stt/assemblyai.ts` (111) | Provedor AssemblyAI (alternativa mais barata). | AssemblyAiProvider |
| `server/src/stt/decode.ts` (156) | Decodifica um arquivo de áudio (webm/opus) para PCM mono 16 kHz float32, usando o ffmpeg baixado pelo pacote ffmpeg-static (sem instalação manual). | decodeToPcm16kMono, SAMPLE_RATE, decodeChunksToPcm, medirVolume, writeWav |
| `server/src/stt/deepgram.ts` (127) | Provedor Deepgram (padrão). | DeepgramProvider |
| `server/src/stt/index.ts` (72) | Monta o provedor de STT a partir da config. | createSttProvider |
| `server/src/stt/local.ts` (158) | Transcrição 100% LOCAL e GRATUITA com Whisper via transformers.js. | cleanText, isHallucination, LocalWhisperProvider |
| `server/src/stt/types.ts` (36) | Contrato provider-agnóstico de Speech-to-Text. | SttEntry, SttResult, SttInput, SttProvider |
| `server/src/stt/vad.ts` (183) | Detecção de fala (VAD) — a proteção mais importante contra alucinação. | SAMPLE_RATE, Segmento, ResultadoVad, detectarFala, extrairFala, temFala +2 |
| `server/src/stt/whisper.ts` (75) | Provedor compatível com a API OpenAI /audio/transcriptions. | WhisperProvider |
| `server/src/voreo/client.ts` (209) | Adapter da Voreo (plataforma externa de análise de reunião). | MAX_ATTEMPTS, BASE_BACKOFF_MS, MAX_BACKOFF_MS, WORKER_INTERVAL_MS, computeBackoffMs, VoreoPayload +3 |

## extension/content

| Arquivo | O que resolve | Exporta |
|---|---|---|
| `extension/content/aba-reuniao.js` (498) | A aba "Reunião" — o painel do Copiloto, feito do mesmo material. | __cpmAba |
| `extension/content/atendente.js` (349) | Quem é o atendente que está usando o chatPro agora. | __cpmAtendente |
| `extension/content/botao-reuniao.js` (659) | Botão "reunião" na barra do chatPro. | __cpmDiag |
| `extension/content/fluxo-reuniao.js` (2542) | O fluxo de marcar reunião, passo a passo, dentro da aba lateral. | __cpmFluxo |

## extension/background

| Arquivo | O que resolve | Exporta |
|---|---|---|
| `extension/background/service-worker.js` (336) | Service worker da extensão — a ponte entre o botão no chatPro e o backend. | — |

## scripts

| Arquivo | O que resolve | Exporta |
|---|---|---|
| `scripts/configurar-segredo.mjs` (160) | Grava o signing secret do Recall no server/.env, reinicia o servidor e confere a assinatura de ponta a ponta — tudo num comando. | — |
| `scripts/gerar-id-extensao.mjs` (57) | Gera um par de chaves e fixa o ID da extensão no manifest.json. | — |
| `scripts/gerar-mapa.mjs` (108) | Gera `docs/MAPA.md` — o índice do repositório. | — |
| `scripts/recuperar.mjs` (106) | Pergunta ao Recall o que aconteceu com as reuniões que ficaram paradas, e recupera as transcrições que o webhook não trouxe. | — |
| `scripts/testar-painel.mjs` (611) | Descobre, em segundos, se uma URL é mesmo a API do painel de reuniões. | — |
| `scripts/testar.mjs` (317) | Diagnóstico e teste da integração, em camadas. | — |

---

63 arquivos indexados.
