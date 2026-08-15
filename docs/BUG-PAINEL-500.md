# `POST /api/ext/agenda/meetings` devolve 500 em toda tentativa

> Para quem cuida do `painel-reunioes.chatpro.com.br`.
> Testado em 14/08/2026 contra produção, com o `EXT_AGENDA_TOKEN`.

## O sintoma

Toda tentativa de criar reunião responde:

```
HTTP 500
{"error":"Erro ao criar reunião."}
```

A **validação passa** (não é 422 — os campos estão certos). O erro acontece
depois, na criação em si.

## O que já foi descartado

Cada linha abaixo é uma tentativa real, com a resposta que veio:

| Tentativa | Resposta |
|---|---|
| CS, 03/09 17:00, `client_type: base` | 500 |
| CS, 17/08 09:00 (outro dia e hora) | 500 |
| CS, `client_type: prospect` | 500 |
| CS com `cnpj` + `instance_code` | 500 |
| CS sem `cs_reason` | **422** — pediu o enum (validação viva) |
| Migração sem `vendedor_email` | **422** — pediu o campo |
| Migração sem checklist | **422** — "Gere o link do onboarding antes" |
| Migração **com** checklist ativo | 500 |
| `assignee_email` sendo n2 | **403** — "Só supervisor pode escolher" |

Ou seja: **as validações todas funcionam.** O 500 só aparece quando o pedido
está completo e correto — que é justamente o caminho de produção.

## O que funciona na mesma API, com o mesmo token

| Endpoint | Resultado |
|---|---|
| `GET /api/healthcheck` | `{"ok":true}`, Supabase em 55 ms |
| `GET /api/ext/agenda/me` | devolve `actor` + `capabilities` |
| `GET /api/ext/agenda/available-slots` | 7 a 9 horários por dia, `max_date` +3 meses |
| `GET /api/retaguarda/vendedores` | 11 vendedores ativos |
| `POST /api/retaguarda/migracao/link` | **201**, criou o checklist e devolveu a razão social |

O `POST` da retaguarda **funciona**. Só o `POST` de reunião falha — o que
sugere algo no caminho específico dele (distribuição? criação do evento no
Calendar? geração do Meet? notificação do Slack?), não infraestrutura.

## Como reproduzir

```bash
curl -X POST https://painel-reunioes.chatpro.com.br/api/ext/agenda/meetings \
  -H "Authorization: Bearer $EXT_AGENDA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"cs",
    "actor_email":"weuden.filho@chatpro.com.br",
    "client_name":"TESTE (APAGAR)",
    "company_name":"chatPro Teste",
    "phone":"(62) 99999-8888",
    "client_type":"base",
    "provedor":"starter",
    "cs_reason":"duvidas",
    "scheduled_date":"2026-09-03",
    "scheduled_time":"17:00",
    "skip_email":true
  }'
```

## O que ajudaria

O corpo do 500 não diz nada além de "Erro ao criar reunião." — **o log do
servidor é o único lugar onde a causa existe.** Um `error.message` ou um código
no corpo já resolveria o diagnóstico daqui.

## Sobre o `skip_email`

Todos os testes acima usaram `"skip_email": true` e nomearam o cliente como
`TESTE (APAGAR)`, seguindo a orientação do README da collection. **Nenhuma
reunião foi criada** (todas falharam), então não há nada a limpar do lado de
vocês — exceto **um checklist de migração** que foi gerado no caminho:

```
CNPJ 11.222.333/0001-81 · id e7bf0af1-5d7d-4901-9632-a5c3ebb65802
```

Esse é o CNPJ de teste do próprio environment do Postman de vocês, mas se
quiserem limpar, é esse.

## Enquanto isso

A extensão está pronta e validada até o `POST`: identifica o atendente, lê as
capacidades do `/me`, mostra só os tipos que o papel permite, carrega a grade
real de horários e monta o corpo correto por tipo. O `POST` é o único passo que
não completa — e ele depende de vocês.
