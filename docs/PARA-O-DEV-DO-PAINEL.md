# Gravação de reuniões dentro do painel — o que precisa existir aí

> Para quem cuida do `painel-reunioes.chatpro.com.br`.
> Escrito por quem construiu a extensão do chatPro que fala com essa API.

## Em uma frase

A extensão do chatPro já marca reuniões no painel (`POST /api/ext/agenda/meetings`)
e já funciona. Falta a outra ponta: **um bot entrar na reunião, gravar, e a
transcrição voltar pro registro dela**. Hoje isso roda num servidor Node
separado, na máquina de um atendente. A proposta é o painel absorver esse
pedaço — some o servidor extra, some o túnel, e a transcrição nasce onde ela
já deveria morar.

## O que já está funcionando (não precisa mexer)

Validado contra a API de vocês em 14/08/2026:

| Endpoint | Resultado |
|---|---|
| `GET /api/healthcheck` | `{"ok":true,...,"supabase":{"latencyMs":55}}` |
| `GET /api/ext/agenda/me?actor_email=` | devolve `actor` + `capabilities` |
| `GET /api/ext/agenda/available-slots` | 9 horários no dia testado, `max_date` 3 meses |
| `GET /api/retaguarda/vendedores` | 11 vendedores ativos |

A extensão desenha o formulário a partir do `/me` — só oferece os tipos com
`allowed: true` e já avisa o atendente se a reunião vai ficar com ele
(`assignment: "self"`) ou entrar na distribuição (`round_robin`).

---

## O que falta: quatro peças

### 1. Criar o bot quando a reunião é marcada

Depois de gerar o `meet_link`, chamar o Recall.ai:

```http
POST https://us-west-2.recall.ai/api/v1/bot
Authorization: Token <RECALL_API_KEY>
Content-Type: application/json

{
  "meeting_url": "<o meet_link que vocês acabaram de gerar>",
  "bot_name": "chatPro (gravando)",
  "join_at": "2026-08-20T17:00:00Z",        // só pra reunião futura; omita pra entrar agora
  "metadata": {
    "meeting_id": "<id da reunião no painel>",
    "session_id": "<id da conversa do chatPro, se houver>"
  },
  "automatic_leave": { "everyone_left_timeout": 120 }
}
```

**O `metadata` é a peça mais importante desta integração.** O Recall devolve ele
inteiro em *todo* webhook — é o único elo entre o evento que chega e a reunião
de vocês. Sem isso, a transcrição chega sem dono.

Devolve `{ "id": "<bot_id>" }`. Guardem esse id na reunião.

Duas armadilhas que já custaram caro aqui:

- **Grave a reunião ANTES de chamar o Recall.** Se o `POST /bot` estourar o
  timeout com o bot já criado do outro lado, o primeiro webhook precisa achar
  a linha por `metadata.meeting_id`. Sem isso, bot órfão gravando e ninguém
  recebendo.
- **`join_at` só com ~10 min de antecedência ou mais.** Com menos, mande sem
  `join_at` (o bot entra agora) — adiar por 3 minutos abre uma janela em que a
  reunião começou e o bot ainda não chegou.

### 2. Receber os webhooks do Recall

Um endpoint público, por exemplo `POST /api/webhooks/recall`.

**Assinatura Svix** (o Recall usa Svix): headers `webhook-id`,
`webhook-timestamp`, `webhook-signature`. O HMAC-SHA256 é sobre
`{id}.{timestamp}.{corpo-cru}`, com o segredo `whsec_...` do painel de webhooks
do Recall. **Precisa do corpo CRU** — se o framework já parseou pra JSON, a
assinatura não confere. Em Next.js isso significa ler o `request.text()` antes
de qualquer `json()`.

Eventos que importam:

| Evento | O que fazer |
|---|---|
| `bot.joining_call` | status → entrando |
| `bot.in_waiting_room` | status → sala de espera (**ver alerta abaixo**) |
| `bot.in_call_recording` | status → gravando, carimba o início |
| `bot.call_ended` | status → encerrada, carimba o fim |
| `bot.done` | fim do ciclo do bot |
| `bot.fatal` | falhou (`data.data.sub_code` diz o motivo) |
| `transcript.done` | **baixar a transcrição** |
| `transcript.failed` | falhou |

**Regras que o Recall impõe, e que doem se ignoradas:**

- Responder **2xx em até 15 segundos**. Baixar a transcrição não cabe nesse
  orçamento. Grave o evento numa fila e responda; processe depois.
- Endpoint que falha por 5 dias seguidos é **desativado** por eles.
- Reentrega é normal: o mesmo evento chega **duas vezes**, e **fora de ordem**.
  Precisa ser idempotente, e o status não pode regredir (um
  `in_waiting_room` atrasado não pode sobrescrever `in_call_recording`).

### 3. Baixar e guardar a transcrição

No `transcript.done`, `GET /api/v1/bot/{bot_id}/transcript` no Recall.

Duas coisas aprendidas na marra:

- **Transcrição vazia não é sucesso.** Vem `[]` quando o arquivo ainda não
  populou do lado deles. Se tratarem vazio como pronto, a reunião congela nesse
  estado pra sempre. Só considere entregue com pelo menos uma fala.
- **Reunião que acabou sem gravar merece aviso.** Nos nossos testes, **8 de 17
  bots nunca gravaram** — ficaram na sala de espera esperando alguém admitir.
  Sem um alerta, ninguém descobre até procurar a transcrição e não achar.

### 4. O comentário na conversa do chatPro

Quando a transcrição fica pronta, postar um resumo na conversa:

```http
POST https://sparks.chatpro.com.br/messages/addComments
instance-token: <CHATPRO_INSTANCE_TOKEN>

{ "instanceId": "chatpro-xxxxxxxxxx", "sessionId": "<uuid>", "userId": "<id do atendente>", "message": "..." }
```

Detalhe que não está óbvio na doc: **`provider` é obrigatório no
`sendMessage` e é por conversa** (`whatsapp` | `facebook` | `instagram` |
`cloud`) — leia de `/sessions/getSessionById` em vez de fixar. Fixar `whatsapp`
nos deu `400 Provider está errado!` numa sessão que era `cloud`.

O comentário leva **só o resumo e as palavras-chave**, nunca a transcrição
inteira — decisão de produto de vocês. E não finaliza o atendimento.

---

## O que eu já tenho pronto e posso passar

Tudo em `github.com/WeudenReis/extensao_transcricao`, branch `recall-ai`,
TypeScript, ~450 testes:

| Arquivo | O que resolve |
|---|---|
| `server/src/recall/client.ts` | cliente do Recall (criar bot, transcrição, leave) |
| `server/src/recall/criarReuniao.ts` | criação com dedup — mesmo link não vira dois bots |
| `server/src/routes/recallHook.ts` | verificação da assinatura Svix |
| `server/src/pipeline/recallQueue.ts` | fila durável, backoff 30 s→15 min, idempotência |
| `server/src/recall/transcript.ts` | normalização das falas |
| `server/src/palavras/` | palavras-chave **sem IA** (dicionário + regex) |
| `server/src/chatpro/client.ts` | chatPro Chat, com o `provider` por sessão |
| `server/src/pipeline/reconciliar.ts` | recupera transcrição perdida perguntando ao Recall |

O `recallQueue.ts` e o `criarReuniao.ts` são os que valem mais: cada guarda ali
corresponde a um problema que já aconteceu (transcrição duplicada, bot órfão
após timeout, status regredindo por evento fora de ordem, sala reaproveitada
por duas conversas diferentes).

---

## O que preciso de você

1. **Onde cadastro o endpoint do Recall** quando ele existir — e o signing
   secret `whsec_...` fica **no painel**, não comigo.
2. **Como o painel quer receber o `session_id` do chatPro.** Hoje a extensão
   sabe qual conversa está aberta. O `POST /meetings` não tem esse campo — vale
   adicionar, porque é ele que amarra a reunião ao atendimento.
3. **Confirmar quem paga o Recall.** Não há plano gratuito recorrente: são 5 h
   de crédito único e depois **US$ 0,65/h** (0,50 gravação + 0,15 transcrição).
   Para 5 atendentes × 3 reuniões/dia dá ~US$ 154/mês. Existe programa de
   startup que derruba pra US$ 0,25/h nas primeiras 10.000 h — vale pedir antes
   de liberar pro time.
4. **Um usuário de teste no painel** cujo `actor_email` eu possa usar sem
   marcar reunião de verdade na agenda de alguém.

## Uma coisa que vale decidir cedo

O bot entra na reunião como convidado e **depende de alguém admitir** — foi o
que fez 8 dos nossos 17 testes não gravarem nada. A solução é um **bot
autenticado**: uma conta Google dedicada da organização, cujo login o Recall
guarda. Aí ele entra direto. Sem isso, "a reunião não foi gravada" vai ser um
chamado recorrente.
