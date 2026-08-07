# Pendências — Recall.ai + chatPro

> Bom dia. A integração com o chatPro está **feita**, contra a API real deles
> (chatPro Chat). O que sobrou aqui não é código: é o que só você pode fazer,
> porque depende de conta, painel ou de uma informação que eu não tenho.
>
> Branch: **`recall-ai`**. A `main` continua com as extensões, intacta.
> · Integração chatPro: [docs/INTEGRACAO-CHATPRO.md](docs/INTEGRACAO-CHATPRO.md)
> · Setup do Recall: [docs/SETUP-RECALL.md](docs/SETUP-RECALL.md)
> · Arquitetura: [ARQUITETURA-RECALL.md](ARQUITETURA-RECALL.md)

## O botão de reunião está pronto

Está na barra do chatPro, ao lado de "transferir". Um clique faz tudo:

1. cria o link do Meet **na agenda do atendente** (conta pessoal @gmail serve)
2. manda o link pro cliente (`sparks.chatpro.com.br/messages/sendMessage`)
3. põe o bot de gravação na sala
4. abre a reunião numa aba nova

Testei o clique inteiro contra o servidor rodando: `HTTP 201`, mensagem entregue,
bot criado, e — ao fim da reunião — a transcrição voltou como comentário na mesma
conversa. Acentuação conferida (`João Ação Coração` chega intacto).

**Sobre o design:** o chatPro não tem classe nem `data-attribute` estável no DOM.
Em vez de chutar cores, o botão **clona** um dos botões que já estão na barra e
troca só o ícone e o texto — herda fonte, espaçamento, hover e os dois temas de
graça, e continua certo se vocês mudarem o CSS. Obrigado pelo `chatpro-alert`:
foi ele que me mostrou que heurística é o caminho ali.

**O que falta você fazer:** conectar sua conta Google pelo popup da extensão
(item 6 abaixo). As credenciais do chatPro já estão configuradas (item 7).

> O rótulo ficou **"reunião"**, como você pediu — encaixa com os vizinhos
> ("transferir", "etiquetas", "agendar", "finalizar"), todos minúsculos e de uma
> palavra só.

## E o gatilho automático, pra quem preferir colar o link

Você tinha pedido, lá atrás, "menos botões possível, tudo automático". Lendo a
doc do chatPro encontrei o encaixe: o evento **`sent_message`** traz o texto da
mensagem, o **`session_id`** e o **`instance_id`** no mesmo payload.

Então o fluxo virou isto — e o atendente **não aperta nada**:

```
Atendente manda o link do Meet na conversa (como já faz)
   → chatPro nos avisa
   → mandamos o bot pra sala
   → reunião acaba, Recall entrega a transcrição
   → ela vira um COMENTÁRIO na mesma conversa do chatPro
```

Testei o caminho inteiro contra o servidor rodando: **7/7**. O comentário caiu
na conversa certa, com as falas separadas por pessoa.

Falta você cadastrar a URL do webhook no chatPro — está no item 8.

---

## 🔴 1. Rotacione a chave da API (faça primeiro)

A chave `6c04bc...c47a7` foi colada no chat, então tem que ser tratada como
exposta. No dashboard do Recall (região **us-west-2**): gere uma nova, coloque
em `server/.env` e revogue a antiga.

Ela dá acesso a gravar e ler transcrição de reunião — dado de cliente.

Eu **não** deixei a chave em nenhum arquivo do projeto (conferi o repositório
inteiro antes de commitar).

---

## ✅ 2. `PANEL_TOKEN` — já configurei

Gerei um token e coloquei no seu `server/.env`, na variável `PANEL_TOKEN`. Ele
começa com `chatpro-recall-` pra você reconhecer de relance.

Pra ver o valor:

```
findstr PANEL_TOKEN server\.env
```

Abra o painel assim, uma vez só (depois ele guarda num cookie de 7 dias):

```
http://localhost:3333/?token=COLE_O_TOKEN_AQUI
```

Testei com o servidor rodando: sem token dá **401**, com token dá **200**, e o
webhook do Recall continua entrando sem token (como tem que ser).

> O valor **não** está escrito em nenhum arquivo versionado — só no `.env`, que
> o Git ignora. Seu `.env` anterior está salvo em
> `server/.env.backup-antes-recall` (também fora do Git).

<details>
<summary>Por que isso importa (e como gerar outro)</summary>

O Recall só precisa alcançar `/webhooks/recall`, mas o túnel publica o servidor
inteiro. Sem tranca, quem descobrisse a URL do túnel listaria as reuniões,
baixaria a transcrição de todas (com nome e e-mail dos participantes) e ainda
criaria bots na sua conta, que são cobrados por hora.

Pra gerar outro token a qualquer momento:

```
node -e "console.log('chatpro-recall-'+require('crypto').randomBytes(12).toString('hex'))"
```

Troque no `.env` e reinicie o servidor. O prefixo é só pra você reconhecer; a
segurança está na parte aleatória.

Só `/webhooks/*` fica livre, porque o Recall se autentica pela assinatura
dele. Todo o resto — painel, API e a ingestão antiga de captura — exige token.
</details>

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

## 🔴 6. Conectar sua conta Google (e criar o OAuth Client)

O link do Meet é criado na agenda de quem clica. Pra isso, duas coisas:

**No Google Cloud** — se ainda não tem, crie um OAuth Client tipo *Web
application* e cadastre este callback nele:

```
http://localhost:3333/oauth/google/callback
```

No `.env`: `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. O escopo pedido é
`calendar.events` — é o que faz funcionar em **conta pessoal @gmail** (o Meet
REST API v2 exigiria Workspace, que foi o que derrubou o caminho antigo).

**Na extensão** — cada pessoa abre o popup, põe o endereço do servidor e o
`PANEL_TOKEN`, e clica em **Conectar conta Google**. O refresh token fica
cifrado no servidor, nunca no navegador.

---

## ✅ 7. `sendMessage` — contrato confirmado e configurado

Você me mandou a página da doc e ela resolveu a dúvida — e mostrou um erro meu:
**`provider` é obrigatório** e eu não estava mandando. Do jeito que estava, toda
mensagem teria voltado 400 e o cliente nunca receberia o link. Corrigido.

Contrato em uso agora (`POST sparks.chatpro.com.br/messages/sendMessage`):

| campo | |
|---|---|
| `sessionId` | obrigatório |
| `instanceId` | obrigatório |
| `message` | obrigatório |
| `provider` | **obrigatório** — `whatsapp` (configurável em `CHATPRO_PROVIDER`) |
| `userId` | opcional — mandamos quando temos |

Já preenchi no seu `.env` com o que você passou:

```
CHATPRO_INSTANCE_ID=chatpro-fz5qbe2haz
CHATPRO_INSTANCE_TOKEN=(o token do chat que você mandou)
CHATPRO_USER_ID=5awdAxsbrnYBuvi5KEzQWSTLh0r1
CHATPRO_PROVIDER=whatsapp
AUTO_SEND_CHATPRO=true
```

O `CHATPRO_USER_ID` eu descobri chamando `/users/getAllInstanceUsers` com o seu
token — é o **💬 Suporte chatPro® - Weuden**. É a conta a que o comentário da
transcrição fica vinculado; se preferir outra, troque no `.env`.

De quebra isso **validou o token**: a chamada voltou 201 com os 57 usuários da
instância.

## 🟡 8. Ligar o gatilho no chatPro

Você me liberou a decidir, então fui pelo caminho que recomendei: **o chatPro
chama o nosso endpoint** quando o atendente abre a reunião. É o único que não
volta a depender de algo rodando na máquina de cada pessoa — que era justamente
o problema que te fez pedir o Recall.

Deixei o endpoint pronto pra ser chamado por máquina, e escrevi o contrato
inteiro em **[docs/INTEGRACAO-CHATPRO.md](docs/INTEGRACAO-CHATPRO.md)** — é o
documento pra entregar pra quem for mexer no chatPro.

O que fiz pra isso funcionar sem dor:

- **Chamar duas vezes dá o mesmo resultado que uma.** Retry, timeout e duplo
  clique acontecem; agora, se já existe bot naquela sala, devolvemos o que
  existe (`200` + `jaExistia: true`) em vez de mandar um segundo robô pra
  reunião do cliente e cobrar outra hora.
- **O `sessionId` pode chegar depois.** Se a segunda chamada trouxer a sessão
  que a primeira não tinha, ela é amarrada sem criar nada novo.
- **Reunião encerrada não bloqueia** uma nova na mesma sala.

Falta só o lado de lá: fazer o chatPro chamar. Se quiser, eu escrevo esse
trecho também — só preciso de acesso ao código do chatPro.

## 🟡 9. Bot autenticado (tira a sala de espera)

Hoje o bot entra como convidado anônimo, então **alguém precisa admitir ele**.
Se ninguém admitir, não grava — e isso é manipulável, que é justo o que você
queria evitar.

A solução é um **bot autenticado**: uma conta Google dedicada, com o login
guardado no Recall. Aí ele entra direto. Precisa de uma conta pra isso, por isso
não fiz.

---

## ⚪ 10. Coisas menores que ficaram

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
