# Captura de áudio + transcrição (conta pessoal @gmail)

Este é o caminho que **funciona em conta Google pessoal** — não depende da Meet REST
API v2 nem de licença Workspace, e não depende da legenda do Meet.

## Por que existe

A Meet REST API só gera transcrição em contas Workspace Business Standard+/Gemini.
A abordagem antiga (ler a legenda) é manipulável: basta desligar a legenda. Aqui
capturamos o **áudio** direto no navegador, uma camada abaixo da interface.

## Como funciona (visão geral)

```
Meet (aba do Chrome)
  ├─ meet-tap.js (world MAIN)   intercepta o áudio:
  │    • RTCPeerConnection → vozes remotas (o cliente)
  │    • getUserMedia → clone do microfone (independente do mute)
  │    grava 2 trilhas separadas (mic / remote) em pedaços de 5s
  │        │ postMessage (ArrayBuffer)
  │        ▼
  └─ meet.js (isolado) → POST /api/capture/chunk (backend)
                              │
backend (server/)             ▼
  routes/capture.ts   grava os chunks em disco
  pipeline/audioTranscript.ts   ao /stop: concatena → STT → funde trilhas →
                                calcula cobertura → grava
  routes/review.ts    painel http://localhost:3333 pra você REVISAR
                      e enviar pra Voreo (botão)
```

Por que **duas trilhas separadas**: o microfone é o Atendente, o remoto é o Cliente.
Separá-las dá "quem falou o quê" sem depender de diarização — e ainda usamos
diarização na trilha remota caso haja mais de um cliente na sala.

## Por que resiste a mute e legenda

- **Mute:** o botão de mudo do Meet seta `enabled=false` na track de microfone *do
  Meet*. Nós gravamos uma **clone** com `enabled` próprio, forçado `true`. Mutar
  silencia para os participantes, mas a captura continua.
- **Legenda:** nunca dependemos dela. Ligar/desligar legenda não afeta nada.

## O serviço de STT (Speech-to-Text)

STT converte o áudio em texto. É um serviço externo (ou local). Escolha via `STT_PROVIDER`
no `server/.env`:

| Provedor | Como | Custo aprox. (com diarização) | Observação |
|----------|------|-------------------------------|------------|
| **deepgram** (padrão) | chave em https://console.deepgram.com | ~US$ 0,41/h | pt-BR ótimo, crédito grátis pra testar |
| assemblyai | chave em https://assemblyai.com | ~US$ 0,15–0,27/h | mais barato |
| whisper | servidor local compatível com OpenAI (`STT_BASE_URL`) | sem custo/min | exige GPU pra ficar rápido |
| none | — | grátis | grava o áudio mas **não transcreve** (modo dev) |

### Configurar o Deepgram (recomendado pra começar)

1. Crie conta em https://console.deepgram.com (tem crédito inicial, sem cartão pra testar).
2. Crie uma API Key.
3. No `server/.env`: `STT_PROVIDER=deepgram` e `STT_API_KEY=<sua-chave>`.
4. Reinicie o backend. Pronto — as próximas capturas já vêm com texto.

Sem chave, o sistema **ainda grava o áudio** e você consegue ouvir no painel — só não
transcreve. Assim dá pra confirmar que a captura funciona antes de gastar com STT.

## Cobertura (métrica anti-adulteração)

Cada captura tem uma **cobertura** (0–100%): comparamos a duração da chamada (pelos
heartbeats a cada 15s) com o tempo efetivamente capturado. Se alguém interromper a
captura no meio, aparece um **gap** no painel:

- `capturing-off-in-call` — estava em chamada mas a captura parou (suspeito).
- `no-heartbeat` — ficamos sem sinal por mais de 20s.

Cobertura baixa = revisar o que aconteceu naquele intervalo.

## Onde vejo a transcrição

No painel local: **http://localhost:3333** (com o backend rodando). Lista as capturas;
clique numa pra ver a transcrição (Atendente em verde, Cliente em neon), ouvir o áudio
das duas trilhas, ver a cobertura e os gaps, e clicar **"Enviar pra Voreo"**.

A transcrição fica pronta **depois que a chamada encerra** (não é ao vivo).

## Envio pra Voreo é opt-in

Por padrão (`AUTO_SEND_VOREO` vazio) **nada vai pra Voreo automaticamente** — você
revisa e envia pelo botão. Para enviar automático ao terminar, `AUTO_SEND_VOREO=true`.

## Consentimento (LGPD) — leia

Gravar a chamada é legítimo para qualidade/compliance, mas o **cliente precisa ser
avisado**. A extensão já mostra um banner "esta reunião está sendo gravada" na tela,
e o certo é dizer no começo da call: *"esta conversa é gravada para fins de qualidade."*
O áudio bruto é apagado automaticamente após `CAPTURE_RETENTION_DAYS` dias (padrão 7);
o texto é mantido.
