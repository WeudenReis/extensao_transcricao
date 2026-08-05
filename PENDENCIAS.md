# PENDÊNCIAS — o que ficou pra você

> Gerado ao fim da execução noturna de 05/08/2026. Tudo que está aqui **depende de coisa externa**
> (credencial, conta, contrato, teste em ambiente real) — o código em si está pronto, buildado e testado.

## 1. Setup do Google Cloud (obrigatório pro pipeline funcionar)

Siga o passo a passo em [docs/SETUP-GCP.md](docs/SETUP-GCP.md). Resumo do que só você pode fazer:

- [ ] Criar o projeto no GCP e ativar as 3 APIs (Meet REST API, Workspace Events API, Cloud Pub/Sub)
- [ ] Configurar a tela de consentimento OAuth (tipo **interno**, precisa de conta Workspace)
- [ ] Criar o OAuth Client ID (web) com redirect `http://localhost:3333/oauth/callback` e preencher `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` no `server/.env`
- [ ] Criar o tópico Pub/Sub e dar permissão de publisher pro `meet-api-event-push@system.gserviceaccount.com`
- [ ] Criar a push subscription apontando pro backend com túnel HTTPS (ngrok/Cloudflare Tunnel) e configurar `PUBSUB_VERIFICATION_AUDIENCE`

## 2. Conta Google Workspace elegível (CRÍTICO)

A transcrição automática do Meet **só funciona em edição Workspace elegível**
(Business Standard+ ou add-on Gemini). Conta @gmail pessoal **não gera transcript** —
o `autoTranscriptionGeneration: "ON"` é aceito mas nada é produzido.
**Verifique qual conta vai ser a anfitriã dos Meets com clientes.**

## 3. Contrato da Voreo

O payload que enviamos hoje é uma proposta nossa (ver `server/src/voreo/client.ts`):
`{sessionId, meetingCode, conferenceRecord, startTime, endTime, participants, transcript[], docsExportUri, source}`.

- [ ] Conseguir da Voreo: URL do webhook + forma de autenticação + formato esperado
- [ ] Preencher `VOREO_WEBHOOK_URL` e `VOREO_API_KEY` no `server/.env`
- [ ] Ajustar o payload em `server/src/voreo/client.ts` se o contrato deles for diferente (é um adapter — só esse arquivo muda)

Enquanto `VOREO_WEBHOOK_URL` estiver vazio, o backend roda em modo dev: loga e marca `skipped-no-url` (nada se perde, fica em `transcripts_sent`).

## 4. Teste ponta a ponta em ambiente real

Não deu pra testar daqui (exige credenciais + Meet real + chatPro logado):

- [ ] Instalar a extensão (guia: [docs/INSTALACAO.md](docs/INSTALACAO.md)) e abrir uma conversa no chatPro → badge ✓ verde deve acender
- [ ] Confirmar que o seletor `.card--active` bate com o DOM real do chatPro em produção (validei com o que você descobriu no inspecionar; se o chatPro mudar o layout, os 5 seletores fallback em `extension/content/chatpro.js` cobrem variações)
- [ ] Fazer um Meet de teste, verificar vínculo no popup ("Enviado ✓") e o transcript chegando no backend após a call
- [ ] Conferir latência: o `transcript.v2.fileGenerated` chega minutos depois do fim da reunião

## 5. Fontes do popup (opcional, cosmético)

O popup usa Paytone One + Space Grotesk com fallback de sistema. Para a tipografia oficial,
baixe os `.woff2` do Google Fonts e coloque em `extension/popup/fonts/` —
os nomes exatos estão em `extension/popup/fonts/README.txt`. Sem eles tudo funciona, só muda a fonte.

## 6. Distribuição pra galera

- [ ] Rodar `scripts/package.ps1` → gera `dist/chatpro-meet-transcripts-v0.1.0.zip`
- [ ] Distribuir o zip + o guia [docs/INSTALACAO.md](docs/INSTALACAO.md) (Load unpacked)
- [ ] Decidir onde o backend vai rodar "de verdade" (hoje: localhost:3333 na sua máquina; para a equipe toda usar, precisa de um servidor/VPS — o endereço é configurável no popup de cada um)

## 7. Endurecer em produção (rápido, mas depende do seu setup)

- [ ] Setar `PUBSUB_SERVICE_ACCOUNT` no `server/.env` (o e-mail do service account usado na push subscription). Sem ela o webhook aceita qualquer token Google com a audience certa — em dev tudo bem, em produção configure.
- [ ] Rate limiting em `/webhooks/pubsub` e `/api/*` — o CLAUDE.md pede, ainda não implementado (baixa prioridade enquanto o backend for localhost; sobe de prioridade se expor numa VPS).

## Decisões que tomei sozinho (reveja se discordar)

1. **Vínculo automático com janela de 4h**: quando um Meet abre, vincula com a última sessão chatPro capturada nas últimas 4 horas. Ajustável em `SESSION_MAX_AGE_MS` no service worker; sempre há o botão "Vincular agora" manual no popup.
2. **Sem `googleapis` (lib gigante)**: clients REST próprios, tipados, com `google-auth-library` só pro OAuth/OIDC. Justificado no `server/README.md`.
3. **SQLite local** (`server/data/app.db`) como storage — zero infra. Se um dia precisar de multiusuário de verdade, trocar o `db.ts`.
4. **Payload mínimo pra Voreo** (LGPD): só o necessário pra análise; transcript nunca vai pra log.
