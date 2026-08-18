# Gravação de reunião por bot (Recall.ai) — o lado do painel

> Resposta ao `PARA-O-DEV-DO-PAINEL.md`.
> **Estado: implementado e desligado.** Falta a chave do Recall, o cadastro do
> webhook e a decisão de quais reuniões gravar.

---

## Em uma frase

As quatro peças que faltavam existem no painel. O bot é criado, os webhooks são
recebidos e verificados, a transcrição é baixada e guardada junto com todas as
outras, e o resumo volta para a conversa do chatPro. Nada disso liga sozinho:
a integração nasce dormente e o interruptor está em `/settings > Gravação`.

## Por que este caminho, e não a transcrição nativa do Meet

O painel já sabia buscar transcrição direto da Meet API — é o `origin='meet'`
que existe desde julho. Ela exige **Google Workspace Business Standard ou
superior**, e a maior parte das contas do time não tem. Os dois caminhos
convivem: onde o plano cobre, a transcrição continua vindo de graça pelo cron do
Meet; onde não cobre, entra o bot. Chegam na mesma tabela e aparecem na mesma
aba.

---

## O que mudou em relação à sua proposta

Uma coisa só, e é a que muda a integração do seu lado: **o bot não é criado no
POST que cria a reunião.**

Neste painel a reunião nasce em **cinco caminhos** (interno, extensão, link
público do suporte, link de apresentação, Retaguarda inbound) e muda em outros
dois (`PATCH` reagenda e cancela, `DELETE` apaga). Pendurar a chamada ao Recall
em sete pontos são sete chances de um deles esquecer — e o esquecimento não
aparece em lugar nenhum: a reunião é criada normalmente, só não é gravada.

Em vez disso, um cron roda **a cada 5 minutos** e pergunta ao banco *quais
reuniões começam nos próximos minutos e ainda não têm bot*. As consequências:

| | Sua proposta | Como ficou |
|---|---|---|
| Bot criado | no POST da reunião | pelo cron, ~15 min antes |
| Reunião reagendada | precisa de gancho no PATCH | o bot antigo é apagado e outro nasce na hora nova, sozinho |
| Reunião cancelada | precisa de gancho | idem |
| "Grave a reunião ANTES de chamar o Recall" | cuidado a tomar | impossível violar: é a reunião que dispara |
| "`join_at` só com ~10 min ou mais" | cuidado a tomar | abaixo disso o bot é mandado entrar **agora**, automaticamente |

As duas armadilhas que você marcou como "já custaram caro" deixaram de existir
por construção. Não é mérito de desenho — é que o problema mudou de forma
quando a origem virou uma consulta em vez de um gancho.

O resto seguiu o que você escreveu, incluindo as três regras que doem: 2xx
rápido, idempotência, e status que não regride.

---

## O que existe agora

### 1. Criação do bot — `lib/recall/scheduler.ts`

Cria com `metadata: { meeting_id, session_id }`. O `meeting_id` é o elo que você
apontou como a peça mais importante, e ele é usado nos dois sentidos: o webhook
acha a reunião por ele **mesmo quando a linha local não existe** — o caso do
`POST /bot` que estourou o timeout com o bot já criado do outro lado.

Um índice parcial no banco garante **no máximo um bot vivo por reunião**. Se
duas passagens do cron se cruzarem, a segunda perde o insert e o bot recém-criado
é apagado imediatamente, em vez de ficar órfão gravando.

### 2. Webhook — `POST /api/webhooks/recall`

- Assinatura **Svix** verificada sobre o corpo cru (`request.text()` antes de
  qualquer `json()`), HMAC-SHA256 sobre `{id}.{timestamp}.{corpo}`, com
  tolerância de 5 minutos nos dois sentidos e suporte a múltiplas assinaturas no
  mesmo header (rotação de segredo).
- **Grava e responde.** A rota não baixa nada: insere na fila
  `recall_webhook_events` e devolve 200. É o que mantém a resposta muito abaixo
  dos 15 segundos — e evita que uma reunião longa comece a contar os 5 dias que
  levam à desativação do endpoint.
- **Idempotência pelo `webhook-id`**, que é coluna única. A reentrega do mesmo
  evento não cria segunda linha, então a transcrição não é baixada duas vezes
  nem o comentário postado duas vezes.
- Evento assinado mas irreconhecível responde **200**, não erro: devolver erro
  faria o Recall reentregar para sempre algo que o painel nunca vai processar.
  Falha ao *gravar* responde 500 — aí a reentrega é a única chance de recuperar.

A rota já está fora do middleware de autenticação (`api/webhooks/` é bypass
existente), então não houve nada a mexer ali.

### 3. Transcrição — `lib/recall/transcript.ts` + `salvar.ts`

- **Vazio não é sucesso.** `[]` vira reagendamento com backoff exponencial
  (30 s → 15 min, teto de 10 tentativas ≈ 2 h), nunca "processado". Você tinha
  razão sobre o congelamento: o evento não volta, e a transcrição não pode ser
  pedida de novo por iniciativa nossa.
- A leitura das falas é tolerante a `speaker` / `participant.name` /
  `speaker_name` e a `words[].text` / `words[].word`, porque a API já mudou esse
  aninhamento e um parser estrito devolveria vazio para um payload bom — que é
  indistinguível de "o bot não gravou".
- O texto vai para o formato `Falante: fala` (blocos separados por linha em
  branco), que é o que o extrator de sinais do painel já sabe desmontar.
  Falas seguidas da mesma pessoa viram um bloco só: o Recall corta por pausa de
  respiração, e sem juntar a "contagem de falas" mediria a cadência da pessoa em
  vez do revezamento da conversa.
- Guardado gzipado no bucket `meeting-transcripts` (franquia própria de 1 GB),
  com só o índice no Postgres — o banco está no plano free de 500 MB e o painel
  inteiro ocupa ~10 MB.
- `origin='recall'`, distinto de `'api'`: a linha de API é texto corrido e a UI
  esconde a contagem de falas nela. A do bot tem falas, e escondê-las faria a
  tela mostrar "0 falas", que é como ela indica transcrição quebrada.

### 4. Alerta de "acabou sem gravar"

Seu número — **8 de 17 bots nunca gravaram** — virou uma regra explícita. O que
prova gravação é o carimbo `recording_started_at`, escrito só no
`bot.in_call_recording`. Reunião que terminou sem ele notifica o responsável
(in-app + Slack), uma vez só.

É aqui que a monotonia de status importa de verdade: um `bot.in_waiting_room`
atrasado sobrescrevendo `gravando` faria esse alerta disparar para uma reunião
que gravou perfeitamente. Os status têm peso e só andam para frente.

### 5. Comentário no chatPro

Reaproveita o que o painel já tinha: `chatpro_config` guarda endpoint, headers e
template interpolável, editáveis pelo supervisor. O miolo saiu da rota
autenticada para `lib/chatpro/comment.ts`, porque quem posta agora é um cron e
não há sessão — mas é a **mesma** função, para o template editado na tela não
divergir do que o robô usa.

O comentário leva participação por falante, contagem de sinais por categoria e
até 6 falas citadas — **nunca a transcrição inteira**, como você definiu. Cada
achado vem com a fala ao lado de propósito: os sinais não interpretam, e
"não vou cancelar" conta como menção a cancelamento.

Sobre o `provider`: sua observação está certa e vale para o `sendMessage`. Aqui
o caminho é `addComments`, que não pede `provider`. Mas o painel **tem** o bug
que você descreveu, em `app/api/chatpro/send-message/route.ts:86` e
`lib/chatpro-webhook/process.ts:396` — os dois fixam `whatsapp`. Está anotado
como conserto separado; obrigado por localizar.

### 6. Um freio que não estava na proposta

Bot `agendado` cujo horário passou de **6 horas** sem nenhum webhook é dado por
perdido (`sem_retorno_do_recall`). É o único conserto para a falha mais
silenciosa possível: se o endpoint estiver quebrado — ou tiver sido desativado
pelo Recall depois dos 5 dias —, as linhas ficariam `agendado` para sempre e o
índice de "um bot vivo por reunião" impediria qualquer tentativa nova.

O contador `bots_perdidos` na saída do cron é o sintoma a observar. Vários
seguidos = o webhook parou de chegar.

---

## Respostas às suas quatro perguntas

**1. Onde cadastrar o endpoint.**

```
https://painel-reunioes.chatpro.com.br/api/webhooks/recall
```

O `whsec_...` vai em `RECALL_WEBHOOK_SECRET` no `.env.production` da VM. Não
precisa passar por você.

Um detalhe operacional do nosso lado: o painel está atrás de Cloudflare. O
caminho precisa ser liberado de bot protection, senão a Svix leva challenge e
desativa o endpoint em 5 dias — vamos cuidar disso ao ligar.

**2. Como o painel quer receber o `session_id`.**

Campo novo no `POST /api/ext/agenda/meetings`:

```json
{ "chatpro_session_id": "<uuid da conversa>" }
```

Já está no ar e documentado em `docs/api-extensao-agenda.md`. Grava em
`meetings.chatpro_session_id`, que é a coluna que o painel já usava para achar a
conversa. **Mande sempre que souber qual conversa está aberta** — é ele que faz
o resumo voltar para o atendimento certo.

Valor malformado é ignorado, nunca recusado: id de conversa é metadado dentro do
corpo de um agendamento e não pode custar a reunião.

**3. Quem paga o Recall.**

Decisão do time, mas com um número corrigido: o painel registrou **422 reuniões
realizadas em julho**, não as ~330 que "5 atendentes × 3/dia" assume. A US$
0,65/h com reunião de 1 h isso dá **~US$ 274/mês**, não US$ 154.

Por isso `/settings > Gravação` tem seleção **por tipo de reunião** em vez de um
liga-desliga: reunião interna da equipe e evento não precisam virar registro, e
são elas que engordariam a conta sem servir a ninguém.

Vale pedir o programa de startup antes de liberar para o time.

**4. Usuário de teste.**

O `POST /meetings` aceita `skip_email: true`, então dá para testar sem mandar
e-mail a ninguém. Ainda assim a reunião entra na agenda de alguém — vamos criar
um profile `implantador` inativo para o time e passar o `actor_email`.

---

## Sobre a sala de espera — uma alternativa mais barata

Você propõe uma conta Google dedicada e autenticada. Antes disso vale tentar uma
linha de código que já é nossa: é o painel que cria o espaço do Meet
(`lib/google/meet.ts`), e ele hoje manda `{}` — ou seja, `accessType` no padrão,
que é exatamente o que faz convidado bater na porta. A Meet API v2 aceita
`config.accessType: "OPEN"` na criação.

O custo dessa escolha é real e é do time, não técnico: qualquer um com o link
entra sem ser admitido. Para reunião com cliente costuma ser desejável, mas
precisa ser decidido, não deduzido — por isso **não** foi implementado.

---

## O que falta para ligar

1. Rodar a migration `20260816120000_recall_gravacao.sql`.
2. `RECALL_API_KEY` e `RECALL_WEBHOOK_SECRET` no `.env.production` da VM.
3. Cadastrar o endpoint no painel do Recall e liberá-lo no Cloudflare.
4. Ligar o timer na VM (units versionadas em `deploy/systemd/`):
   ```bash
   sudo cp /home/deploy/app/deploy/systemd/chatpro-recall.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now chatpro-recall.timer
   systemctl list-timers chatpro-recall.timer
   ```
5. `/settings > Gravação`: ligar o switch, escolher os tipos, decidir sobre o
   comentário no chatPro.

Enquanto (2) e (5) não acontecerem, nada é criado e o painel funciona igual ao
de hoje.

## Onde olhar quando algo estiver estranho

| Sintoma | Onde |
|---|---|
| Nenhum bot aparece | saída do cron: `ativa: false` diz que o switch ou a chave faltam |
| Bot criado e nada volta | `bots_perdidos > 0` por várias passagens = webhook não está chegando |
| Transcrição não aparece | `eventos_reagendados` — o Recall ainda está fechando o arquivo |
| Reunião "sem gravação" | `meeting_recordings.error_code` diz se foi sala de espera ou falha do bot |

Log: `journalctl -u chatpro-recall.service -n 50 --no-pager`.

---

## Arquivos

| Arquivo | O que resolve |
|---|---|
| `supabase/migrations/20260816120000_recall_gravacao.sql` | config, registro do bot, fila |
| `lib/recall/client.ts` | cliente do Recall (criar, baixar, apagar, sair) |
| `lib/recall/webhook.ts` | assinatura Svix + leitura tolerante do evento |
| `lib/recall/status.ts` | ordem dos status; o que impede a regressão |
| `lib/recall/scheduler.ts` | quando criar, cancelar e desistir do bot |
| `lib/recall/process.ts` | fila, backoff, alerta de não-gravação |
| `lib/recall/transcript.ts` | normalização das falas |
| `lib/recall/salvar.ts` | bucket + índice, `origin='recall'` |
| `lib/recall/resumo.ts` | o comentário (resumo + palavras-chave, sem IA) |
| `lib/chatpro/comment.ts` | poster de comentário sem sessão |
| `app/api/webhooks/recall/route.ts` | o endpoint |
| `app/api/cron/recall/route.ts` + `scripts/recall.sh` | o motor |
| `components/settings/GravacaoConfigPanel.tsx` | `/settings > Gravação` |
