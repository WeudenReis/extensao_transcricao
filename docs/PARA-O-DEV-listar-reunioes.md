# Pedido: um jeito de LISTAR as reuniões

**Data:** 04/09/2026 · **Impacto:** a agenda da extensão mostra horário ocupado
sem conseguir dizer de quem é.

## O que já funciona

A extensão tem uma agenda (Mês e Semana) e ela **já enxerga os horários
ocupados de vocês** — através do `available-slots`, que devolve `bloqueados`
por dia. Então a parte que evita conflito está resolvida: quem olha a semana vê
"No painel: 09:00 14:00" nos horários que vocês já têm.

E o conflito no ato de marcar nunca dependeu disso: o seletor de horário só
oferece o que veio em `disponiveis`.

## O que falta

`bloqueados` diz **que** há compromisso, não **qual**. Então a agenda mostra
duas coisas com pesos muito diferentes:

- reunião marcada pela extensão → "14h30 · Bianca Ferreira · SADDI E SANTOS"
- reunião criada direto no painel → "No painel: 14:30"

O atendente que olha a semana não consegue saber se aquele 14:30 é uma reunião
dele que ele esqueceu, ou de outra pessoa, ou um bloqueio de agenda.

## O que eu procurei antes de pedir

Sondei 15 caminhos, com os dois tokens, só GET (nada de escrita):

```
405  /api/ext/agenda/meetings              (existe, mas só POST)
404  /api/ext/agenda/my-meetings
404  /api/ext/agenda/reunioes
404  /api/ext/agenda/agenda
404  /api/ext/agenda/calendar
404  /api/ext/agenda/schedule
404  /api/ext/agenda/events
404  /api/ext/agenda/list
404  /api/ext/agenda/upcoming
404  /api/ext/agenda/busy
404  /api/ext/agenda/me/meetings
404  /api/ext/agenda/meetings/{id}
307  /api/retaguarda/reunioes              (redireciona pro /login)
307  /api/retaguarda/agenda                (idem)
405  /api/retaguarda/meetings              (existe, não aceita GET)
```

`OPTIONS` em `/api/ext/agenda/meetings` devolve 204 sem cabeçalho `Allow`,
então não dá pra descobrir os métodos por aí.

Os dois **405** me deixaram em dúvida: as rotas existem e recusam GET. Se
alguma delas aceita POST com filtro e devolve lista, é só me dizer o corpo —
não testei POST às cegas de propósito, porque num endpoint de reuniões um POST
pode criar coisa de verdade.

## O pedido

Algo assim, no conjunto `/api/ext/agenda/*` que a extensão já usa:

```
GET /api/ext/agenda/meetings?actor_email=...&from=2026-09-01&to=2026-09-30
```

devolvendo o mínimo pra desenhar um cartão:

```json
{ "meetings": [
  { "id": "...", "type": "cs", "scheduled_at": "2026-09-04T17:30:00Z",
    "client_name": "...", "company_name": "...",
    "responsavel": { "name": "...", "email": "..." },
    "chatpro_session_id": "..." }
]}
```

O `chatpro_session_id` é o que fecha o ciclo: com ele o cartão leva o atendente
de volta à **conversa** de onde a reunião saiu, que é o destino de todo clique
na nossa agenda hoje.

Filtrar por `actor_email` já resolve o caso principal ("minha agenda"). Um
intervalo de datas evita puxar o histórico inteiro — a tela mostra um mês ou
uma semana por vez.

**Sem urgência.** A extensão funciona hoje e não marca em cima de nada; isso é
qualidade de leitura da agenda, não correção de bug. Se for simples, ótimo; se
não, a gente segue com o `available-slots`.
