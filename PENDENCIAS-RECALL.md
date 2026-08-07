# Pendências — integração Recall.ai

> Bom dia. O código está pronto, compilando e testado, e passou por uma revisão
> adversarial que achou 6 problemas reais — todos já corrigidos (a lista está no
> fim deste arquivo). O que sobrou aqui **não é código**: é o que só você pode
> fazer, porque depende de conta, painel ou de uma informação que eu não tenho.
>
> Branch: **`recall-ai`**. A `main` continua com as extensões, intacta.
> Passo a passo detalhado: [docs/SETUP-RECALL.md](docs/SETUP-RECALL.md).
> Arquitetura: [ARQUITETURA-RECALL.md](ARQUITETURA-RECALL.md).

---

## 🔴 1. Rotacione a chave da API (faça primeiro)

A chave `6c04bc...c47a7` foi colada no chat, então tem que ser tratada como
exposta. No dashboard do Recall (região **us-west-2**): gere uma nova, coloque
em `server/.env` e revogue a antiga.

Ela dá acesso a gravar e ler transcrição de reunião — dado de cliente.

Eu **não** deixei a chave em nenhum arquivo do projeto (conferi o repositório
inteiro antes de commitar).

---

## 🔴 2. Definir o `PANEL_TOKEN` (antes de abrir o túnel)

Isto apareceu numa revisão de segurança depois que o resto já estava pronto, e
é o achado mais sério: **o Recall só precisa alcançar `/webhooks/recall`, mas o
túnel publica o servidor inteiro.** Sem tranca, quem descobrisse a URL do túnel
listaria as reuniões, baixaria a transcrição de todas (com nome e e-mail dos
participantes) e ainda criaria bots na sua conta, que são cobrados por hora.

Já implementei a tranca. Falta você gerar o valor:

```
openssl rand -hex 24
```

```
PANEL_TOKEN=o-valor-gerado
```

Depois abra o painel uma vez com `http://localhost:3333/?token=SEU_TOKEN` — ele
guarda num cookie e não pede de novo.

`/webhooks/*` e `/api/capture/*` continuam livres de propósito: o webhook se
autentica pela assinatura do Recall, e a extensão só escreve.

## 🔴 3. Criar o segredo de webhook

Sem isso, o Recall não manda os headers de assinatura e o nosso endpoint recusa
tudo com 403. Isso é de propósito: sem assinatura, qualquer um que descobrisse a
URL poderia injetar uma transcrição falsa na conversa do cliente.

1. Dashboard do Recall → **Webhooks**
2. Crie o *workspace signing secret* (começa com `whsec_`)
3. `server/.env`: `RECALL_WEBHOOK_SECRET=whsec_...`

## 🔴 4. Deixar o backend acessível por HTTPS

O Recall precisa alcançar o seu servidor de fora. Em teste:

```
cloudflared tunnel --url http://localhost:3333
```

Pegue a URL gerada e ponha em `PUBLIC_BASE_URL`. Em produção, um domínio fixo
(a URL do túnel muda a cada reinício).

## 🔴 5. Cadastrar o endpoint e assinar os eventos

Endpoint: `{PUBLIC_BASE_URL}/webhooks/recall`

Marque **um a um** (o Recall não assina em bloco):

| Estado do bot | Transcrição |
|---|---|
| `bot.joining_call` | `transcript.done` ← é o que dispara a entrega |
| `bot.in_waiting_room` | `transcript.failed` |
| `bot.in_call_recording` | |
| `bot.call_ended` | |
| `bot.done` | |
| `bot.fatal` | |

Se esquecer o `transcript.done`, tudo funciona **menos** a transcrição chegar —
e não dá erro em lugar nenhum. É o esquecimento mais fácil de cometer aqui.

---

## 🟡 6. O contrato da API do chatPro

Essa é a informação que me falta e que eu não consigo descobrir sozinho: **qual
endpoint do chatPro recebe a transcrição, e em que formato.**

Hoje eu mando este JSON:

```json
{
  "sessionId": "uuid da conversa do chatPro",
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "meetingCode": "abc-defg-hij",
  "startedAt": "2026-08-06T13:00:00.000Z",
  "endedAt": "2026-08-06T13:34:00.000Z",
  "durationSeconds": 2040,
  "participants": [{ "nome": "Maria", "isHost": true, "email": "maria@..." }],
  "transcript": [
    { "speaker": "Maria", "text": "bom dia.", "startMs": 1000, "endMs": 1600, "isHost": true }
  ],
  "source": "recall-ai"
}
```

Quando você me passar o formato real, o ajuste é em **um arquivo só**
([server/src/chatpro/client.ts](server/src/chatpro/client.ts)) — foi feito
justamente pra isso.

Enquanto `CHATPRO_API_URL` estiver vazia, nada se perde: a transcrição fica
salva e marcada como `skipped-no-url`, e você envia pelo botão do painel.

## 🟡 7. Decidir: quem chama o bot?

Hoje o bot entra quando alguém faz `POST /api/meetings` (ou clica no painel).
Falta ligar isso no gatilho real do chatPro — quando o atendente abre a reunião.

São dois caminhos, e a escolha é sua:

- **O chatPro chama o nosso endpoint** quando cria a reunião. Mais limpo, mas
  depende de mexer no chatPro.
- **Um script/extensão mínima** detecta o Meet aberto e chama. Não mexe no
  chatPro, mas volta a depender de algo rodando na máquina de cada um — que é
  exatamente o problema que te fez pedir o Recall.

Eu recomendo o primeiro. Se for por ali, me diga e eu faço o endpoint do lado
do chatPro também.

## 🟡 8. Bot autenticado (tira a sala de espera)

Hoje o bot entra como convidado anônimo, então **alguém precisa admitir ele**.
Se ninguém admitir, não grava — e isso é manipulável, que é justo o que você
queria evitar.

A solução é um **bot autenticado**: uma conta Google dedicada, com o login
guardado no Recall. Aí ele entra direto. Precisa de uma conta pra isso, por isso
não fiz.

---

## ⚪ 9. Coisas menores que ficaram

- **Custo:** o Recall cobra por hora de gravação. Confira o preço no painel
  antes de rodar em volume — cada bot em reunião conta. Não coloquei nenhum
  limite de gasto no código.
- **Aviso de gravação:** o bot aparece como participante chamado
  "chatPro (gravando)" (`RECALL_BOT_NAME`). É o que deixa a gravação evidente
  pro cliente. Se o jurídico quiser outro texto, é só trocar essa variável.
- **Retenção:** hoje a transcrição fica no SQLite sem prazo de expurgo. O áudio
  fica com o Recall (a política de retenção é de lá). Vale definir por quanto
  tempo guardamos.
- **Painel:** a aba "Reuniões (bot)" tem lista, detalhe, cópia e envio manual.
  Não tem busca nem filtro por período — dá pra adicionar quando incomodar.

---

## O que a revisão adversarial pegou (já corrigido)

Rodei três revisores independentes em cima do código pronto — segurança, fluxo
e consistência painel↔API. Acharam **seis** problemas reais. Todos corrigidos,
cada um com teste que falha se voltar:

1. **Painel público junto com o túnel** (crítico) — item 2 lá em cima.
2. **Transcript vazio virava sucesso definitivo.** O webhook às vezes chega
   antes de o arquivo estar escrito; salvávamos `[]` como pronto, mandávamos
   uma transcrição em branco pro chatPro e a reunião congelava assim, sem
   volta. Agora vazio é retentado; só depois de 8 tentativas aceitamos que a
   reunião foi mesmo vazia.
3. **Evento atrasado derrubava reunião pronta.** O Svix reentrega por 24 h, e um
   `bot.call_ended` (ou pior, um `transcript.failed`) chegando depois marcava
   como falha uma reunião que já tinha a transcrição salva — o painel diria
   "não há transcrição" com ela intacta no banco.
4. **Bot órfão no timeout.** Se o Recall criasse o bot e a resposta demorasse
   mais de 20 s, o bot entrava na reunião do cliente e gravava, mas não havia
   registro pra casar com os webhooks: a reunião inteira se perdia, e um
   segundo clique colocava um segundo robô na chamada. Agora a reunião é
   gravada **antes** e o id dela viaja no `metadata` — o primeiro webhook
   reencontra e amarra.
5. **Botão travado pra sempre.** Express 4 não captura rejeição em handler
   async: a requisição ficava pendurada sem resposta e o painel travava em
   "Enviando…" sem mostrar erro nenhum.
6. **Resposta sem id do bot virava `bot_id` NULL** em silêncio, e a reunião
   ficava "Criada" eternamente.

## O que eu já validei (não precisa refazer)

Não é teoria — rodei de verdade:

- **API real do Recall:** criei um bot (201), o `metadata` voltou intacto e
  removi ele (200). É esse round-trip do `metadata` que garante que a
  transcrição sempre reencontra a conversa certa do chatPro — o problema que a
  gente tinha com o vínculo por janela de tempo simplesmente não existe aqui.
- **Servidor de verdade, webhook assinado de verdade:** assinatura válida passa,
  corpo adulterado toma 403, sem assinatura toma 403, reentrega do mesmo evento
  não duplica, o worker aplica o estado e **o vínculo com a sessão é preenchido
  sozinho pelo metadata**. Com a tranca ligada, o painel exige token e o webhook
  continua entrando.
- **Sem transcrição duplicada:** tem teste que prova que um `transcript.done`
  repetido não rebaixa nem reentrega — era esse tipo de duplicidade que apareceu
  na extensão.
- **TypeScript estrito sem erro**, suíte completa verde.

## Como rodar

```
cd server
npm install
npm run build
npm start
```

Painel em `http://localhost:3333/?token=SEU_PANEL_TOKEN` → aba
**Reuniões (bot)**.

O servidor sobe mesmo sem nada configurado e **diz no log exatamente o que está
faltando** — é o jeito mais rápido de conferir se o `.env` está completo.
