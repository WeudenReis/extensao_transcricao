# O que falta do lado do painel

> Atualizado em 19/08/2026, depois da sua resposta em `recall-gravacao.md`.
> Do lado da extensão está tudo pronto e no ar — o que segue depende de vocês.

## Antes de tudo: o que já foi feito

Do seu lado, o ciclo inteiro da gravação — cron que cria o bot, webhook com
Svix, download da transcrição, comentário no chatPro e o alerta de "acabou sem
gravar". A escolha do cron em vez de gancho no POST resolveu por construção as
duas armadilhas que eu tinha listado; era um problema melhor resolvido do que o
que eu propus.

Do nosso lado, desde a sua resposta:

- **`chatpro_session_id` vai em todo `POST /meetings`** — é o elo que faz o
  resumo voltar pro atendimento certo. Como você pediu, mandamos sempre.
- **A nossa gravação foi desligada** (`GRAVACAO_PELO_PAINEL=true`). Nenhum bot
  sai daqui, e a fila do Recall não roda. Nada foi removido: é variável de
  ambiente, reversível em um restart.
- Formulário completo por tipo (`cs_reason`, `vendedor_email`, `oficial_plan`,
  `provedor`), CNPJ puxando razão social, grade de dias com contagem de vagas.

---

## 1. BLOQUEANTE — `POST /api/ext/agenda/meetings` responde 500

Enquanto isso durar, **nenhuma reunião marcada pela extensão chega ao painel.**

```
HTTP 500
{"error":"Erro ao criar reunião."}
```

### O que já foi descartado

Testado contra produção, cada linha é uma tentativa real:

| Variável | Valores testados | Resultado |
|---|---|---|
| `actor_email` | n2 e vendedor | 500 nos dois |
| `type` | `cs`, `migracao`, `apresentacao` | 500 nos três |
| Data | +1 dia útil, +3, +20 dias | 500 em todas |
| Horário | 5 horários confirmados livres no `available-slots` | 500 em todos |
| `client_type` | `base`, `prospect` | 500 nos dois |
| Payload | **idêntico ao exemplo da sua collection** | 500 |

### O que funciona, com o mesmo token e no mesmo minuto

`GET /me`, `GET /available-slots`, `GET /retaguarda/vendedores` — e, o mais
relevante, **`POST /api/retaguarda/migracao/link` responde 201** e cria o
checklist. Ou seja: escrita funciona; é este endpoint específico que falha.

As validações do próprio endpoint também respondem certo (422 com o enum de
`cs_reason`, 403 do `assignee_email`, 422 do checklist de migração). **Só o
caminho de sucesso falha.**

### Hipótese

O que o `POST /meetings` faz a mais que o `migracao/link` é criar o evento no
Google Calendar, gerar o Meet, mandar o `.ics` e avisar no Slack.

E o `/api/healthcheck` cobre **só `app` e `supabase`** — não cobre o Google. Uma
credencial faltando ou vencida no `.env.production` deixa o healthcheck verde e
produz exatamente este 500.

Ordem sugerida: **o log do servidor no instante de uma tentativa** (é o único
lugar onde a causa existe hoje), depois as credenciais do Google na VM, depois
o `lib/google/meet.ts` isolado.

### Reprodução

```bash
curl -X POST https://painel-reunioes.chatpro.com.br/api/ext/agenda/meetings \
  -H "Authorization: Bearer $EXT_AGENDA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"apresentacao",
    "actor_email":"anna.souza@chatpro.com.br",
    "client_name":"João Silva (TESTE)",
    "company_name":"Silva Comércio",
    "phone":"(11) 99999-9999",
    "client_type":"prospect",
    "scheduled_date":"2026-08-19",
    "scheduled_time":"09:00",
    "skip_email":true
  }'
```

---

## 2. Ligar a gravação — e um vão a evitar

**Neste momento ninguém está gravando.** Nós desligamos (pra não colocar dois
bots na mesma sala) e o painel ainda não ligou. Se o intervalo for longo, as
reuniões desse período ficam sem transcrição e sem registro nenhum.

Duas saídas, e a escolha é sua:

- **Avisar quando for ligar** — a gente religa do nosso lado até lá e desliga no
  mesmo dia. Vale se a ativação demorar.
- **Ligar logo** — mais simples, se for questão de dias.

O checklist é o seu, de `recall-gravacao.md`:

1. Rodar a migration `20260816120000_recall_gravacao.sql`
2. `RECALL_API_KEY` e `RECALL_WEBHOOK_SECRET` no `.env.production` da VM
3. Cadastrar `https://painel-reunioes.chatpro.com.br/api/webhooks/recall` no
   Recall e liberar o caminho no Cloudflare
4. Ligar o timer na VM (`chatpro-recall.timer`)
5. `/settings > Gravação`: switch, tipos e a decisão sobre o comentário

Sobre o custo: sua correção está certa — 422 reuniões em julho dá **~US$
274/mês**, não os US$ 154 que minha conta assumia. Vale pedir o **programa de
startup do Recall** (US$ 0,25/h nas primeiras 10.000 h) antes de liberar pro
time; corta pela metade.

---

## 3. Dois pedidos pequenos, independentes

Não bloqueiam nada, mas economizariam bastante tempo:

**O corpo do 500 não diz nada.** `{"error":"Erro ao criar reunião."}` é a mesma
resposta para credencial vencida, cota do Google, Slack fora e erro de banco. Um
`code` ou o `error.message` teria evitado toda a investigação acima.

**O 422 de campo desconhecido vem com `details: {}` vazio.** Descobrimos quais
campos existem testando um a um — `cc_emails`, `observacoes`, `oficial_legado`
e mais nove. Dizer qual campo sobrou resolveria em uma requisição.

---

## 4. Quando fizer sentido (sem pressa)

Já sabemos que não é pra agora; fica registrado pra não se perder:

| O que | Situação hoje |
|---|---|
| Tipo `verificacao` | Existe na tela do painel, não na API (`type` só aceita os quatro) |
| Campo do "Migração de Oficial antigo" | 12 nomes testados, todos 422 — é o que dispensaria o checklist |
| `observacoes` / `notes` | Recusados pelo schema |
| CC (`cc_emails`, `cc_email`, `email_cc`) | Recusados pelo schema |

---

## Enquanto o 500 durar

A extensão detecta o 5xx e cria a reunião por conta própria (link pelo Google
Calendar do atendente), manda pro cliente pelo WhatsApp e avisa **na tela, em
vermelho**, que a reunião **não** ficou registrada no painel e precisa ser
lançada manualmente.

Recusa de negócio (4xx) **não** entra nesse desvio — aí a regra é de vocês, e
contorná-la seria errado.

O atendimento não para. Mas cada reunião desse período é um lançamento manual
depois.
