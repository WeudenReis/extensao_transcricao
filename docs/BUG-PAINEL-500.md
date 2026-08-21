# ~~`POST /api/ext/agenda/meetings` → 500 em toda tentativa~~ — RESOLVIDO

> **21/08/2026: corrigido pelo dev do painel.** O mesmo payload que dava 500
> agora responde **201** com link do Meet. Verificado contra produção.
>
> O histórico abaixo fica registrado porque o método de investigação vale — foi
> ele que isolou o caminho de sucesso como único ponto quebrado.


> Para quem cuida do `painel-reunioes.chatpro.com.br`.
> Reproduzido em **18/08/2026, 23h15 UTC**, contra produção, com o
> `EXT_AGENDA_TOKEN` — na versão que responde `uptime: 2061s` no healthcheck.

## O sintoma

```
HTTP 500
{"error":"Erro ao criar reunião."}
```

**A validação passa.** Não é 422: o corpo está correto. O erro acontece depois,
na criação em si.

## O que já foi descartado — cada linha é uma tentativa real

| Variável testada | Valores | Resultado |
|---|---|---|
| Usuário (`actor_email`) | `weuden.filho@` (n2), `anna.souza@` (vendedor) | 500 nos dois |
| Tipo | `cs`, `migracao`, `apresentacao` | 500 nos três |
| Data | +1 dia útil, +3 dias, +20 dias | 500 em todas |
| Horário | 09:00, 11:00, 15:00, 16:00, 17:00 (todos confirmados livres) | 500 em todos |
| `client_type` | `base`, `prospect` | 500 nos dois |
| Payload | **idêntico ao exemplo da collection** | 500 |

O último é o que fecha a questão do nosso lado: o corpo abaixo é o exemplo
`POST meetings — apresentação` da collection de vocês, com o próximo dia útil e
o primeiro horário que o `available-slots` devolveu como livre.

## Reprodução

```bash
# 1. confirma que o horário está livre
curl -s -H "Authorization: Bearer $EXT_AGENDA_TOKEN" \
  "https://painel-reunioes.chatpro.com.br/api/ext/agenda/available-slots?type=apresentacao&date=2026-08-19&actor_email=anna.souza@chatpro.com.br"
# → {"available_slots":["09:00","10:00",...],"max_date":"2026-11-16"}

# 2. marca no primeiro horário livre
curl -s -X POST https://painel-reunioes.chatpro.com.br/api/ext/agenda/meetings \
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
# → HTTP 500 {"error":"Erro ao criar reunião."}
```

## O que FUNCIONA, com o mesmo token e no mesmo minuto

| Endpoint | Resultado |
|---|---|
| `GET /api/healthcheck` | `{"ok":true}`, Supabase em 275 ms |
| `GET /api/ext/agenda/me` | devolve `actor` + `capabilities` |
| `GET /api/ext/agenda/available-slots` | 7 a 9 horários por dia, `max_date` +3 meses |
| `GET /api/retaguarda/vendedores` | 11 vendedores ativos |
| `POST /api/retaguarda/migracao/link` | **201** — criou o checklist e devolveu a razão social |

As validações do próprio endpoint também respondem certo, o que mostra que a
rota está viva e o token vale:

| Tentativa | Resposta |
|---|---|
| CS sem `cs_reason` | **422** com o enum completo |
| Migração sem `vendedor_email` | **422** pedindo o campo |
| Migração sem checklist | **422** "Gere o link do onboarding antes" |
| `assignee_email` sendo n2 | **403** "Só supervisor pode escolher" |
| `oficial_plan` inválido | **422** com as quatro opções |

Ou seja: **só o caminho de sucesso falha.** Tudo que recusa, recusa
corretamente.

## Hipótese

O `POST /api/retaguarda/migracao/link` — que também escreve — **funciona**. O
que o `POST /meetings` faz a mais é criar o evento no Google Calendar, gerar o
Meet, mandar o `.ics` e avisar no Slack.

E o `/api/healthcheck` cobre **só `app` e `supabase`**. Se a credencial do
Google (ou do Slack) estiver faltando ou vencida no `.env.production`, o
healthcheck continua verde e a criação de reunião falha exatamente assim.

Vale conferir nesta ordem:

1. O log do servidor no instante de uma tentativa — é o único lugar onde a
   causa existe hoje.
2. As credenciais do Google Calendar no `.env.production` da VM.
3. Se o `lib/google/meet.ts` consegue criar um espaço isolado, fora do fluxo de
   reunião.

## Dois pedidos pequenos, independentes do bug

**O corpo do 500 não diz nada.** `{"error":"Erro ao criar reunião."}` é a
mesma resposta para credencial vencida, cota do Google, Slack fora e erro de
banco. Um `code` ou o `error.message` no corpo economizaria toda esta
investigação.

**O 422 de campo desconhecido vem com `details: {}` vazio.** Descobrimos quais
campos existem por tentativa e erro, um a um — `cc_emails`, `observacoes`,
`oficial_legado` e mais nove. Dizer qual campo sobrou resolveria em uma
requisição.

## Enquanto isso, o atendimento não para

A extensão detecta o 5xx e cria a reunião por conta própria (link pelo Google
Calendar do atendente), manda pro cliente e avisa **na tela, em vermelho**, que
a reunião **não** ficou registrada no painel e precisa ser lançada manualmente.

Recusa de negócio (4xx) **não** entra nesse desvio — aí a regra é de vocês e
contorná-la seria errado.
