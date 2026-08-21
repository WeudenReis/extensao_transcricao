# Distribuição não está acontecendo para o papel `n2`

**Data:** 21/08/2026 · **Status:** aguardando o painel

Primeiro: **o 500 do `POST /meetings` acabou.** Confirmado hoje, HTTP 201, com
link do Meet gerado. E o `details` do 422 agora vem preenchido — obrigado, era
exatamente o que faltava pra depurar. Detalhe sobre isso no fim.

---

## O que está acontecendo

Toda reunião marcada pela extensão fica com quem marcou, em vez de ser
distribuída.

## De onde vem a decisão

Não é a extensão que escolhe. Ela lê o `assignment` que o próprio
`GET /api/ext/agenda/me` declara, **antes de qualquer POST**, e obedece.

E o painel declara `self` para o papel `n2`:

```
GET /api/ext/agenda/me?actor_email=...

weuden.filho@chatpro.com.br      papel n2         cs=self          migracao=self
anna.souza@chatpro.com.br        papel vendedor   cs=round_robin   migracao=round_robin
cleyton.caetano@chatpro.com.br   papel vendedor   cs=round_robin   migracao=round_robin
maria.luz@chatpro.com.br         papel vendedor   cs=round_robin   migracao=round_robin
```

Os `vendedor` recebem `round_robin` e a extensão mostra "entra na distribuição".
O `n2` recebe `self` nos dois tipos que ele pode marcar — e aí a extensão mostra
"fica com você", porque foi isso que o painel respondeu.

## A prova de que não é a extensão

Este `POST` foi disparado por script, **sem `assignee_email`**, sem passar por
nenhum código nosso:

```json
{
  "type": "cs",
  "actor_email": "weuden.filho@chatpro.com.br",
  "client_type": "prospect",
  "provedor": "starter",
  "cs_reason": "duvidas",
  "scheduled_date": "2026-08-24",
  "scheduled_time": "17:00",
  "skip_email": true
}
```

Resposta 201:

```json
{
  "id": "5b9bc5d3-3f93-4ad9-b4fa-bdf6fa601a84",
  "assignment_mode": "self",
  "responsavel": { "name": "Weuden Filho", "role": "n2" }
}
```

Sem nenhuma sugestão de responsável no corpo, o painel decidiu `self` sozinho.

## O pedido

Se reunião marcada por `n2` também deve entrar no rodízio, o ajuste é na regra
de papel do painel: `n2` precisa declarar `round_robin` em `cs` e `migracao`, do
mesmo jeito que `vendedor` já declara.

Não precisa mexer em contrato nem avisar a extensão: ela já trata `self`,
`round_robin` e `explicit`, e passa a mostrar "entra na distribuição" no mesmo
instante em que o `/me` mudar. Nada pra reimplantar do nosso lado.

---

## Duas coisas menores, já que o assunto é o schema

**1. Um `422` com `details` vazio significa "campo desconhecido".** Descobrimos
hoje e vale documentar, porque é o único erro que não se explica sozinho:

| Resposta | Significado |
|---|---|
| `details: { "campo": [...] }` | o campo existe, o valor está errado |
| `details: {}` (vazio) | tem uma chave que o schema não conhece |

Se der pra nomear a chave recusada no `details`, ajuda muito — foi um erro que
já custou horas aqui antes de você preencher o `details`.

**2. Continuam fora do schema** (confirmado hoje, cada um dá `422` com `details`
vazio): `observacoes`, `notes`, `cc_emails`, `cc_email` e o tipo `verificacao`.
Nada urgente — só pra registrar que seguem pendentes.

---

## Limpeza

O teste de hoje criou **uma reunião de verdade** na agenda, que precisa ser
cancelada pelo painel (não achei endpoint de cancelamento na API):

- `5b9bc5d3-3f93-4ad9-b4fa-bdf6fa601a84` — 24/08/2026 às 17:00, responsável
  Weuden Filho, cliente "(TESTE) Nao atender". O cliente **não** foi notificado
  (`skip_email: true`).
