# Dois pedidos: cancelar/reagendar, e a fila de convites

**Data:** 08/09/2026 · Junto do pedido de listagem (`PARA-O-DEV-listar-reunioes.md`),
são as três coisas da extensão que dependem de vocês. As outras quatro do
mesmo pacote já subiram — só estas precisam de mão aí.

---

## 1. Cancelar e reagendar pela extensão

### O problema

A extensão só CRIA. Se o cliente pede pra mudar o horário — que é o pedido
mais comum depois de marcar —, o atendente sai do chatPro, abre o painel, acha
a reunião e mexe lá. E o fluxo dele estava na conversa.

Pior: a nossa fila de convites **não fica sabendo** (é o item 2 abaixo), então
o convite antigo continua marcado pra sair no horário velho.

### O que existe

O teu doc do Recall diz que os dois já existem no painel:

> "`PATCH` reagenda e cancela, `DELETE` apaga"

Se for só expor no conjunto `/api/ext/agenda/*`, que a extensão já usa e já
autentica, o trabalho do meu lado é uma tela.

### O que eu precisaria

```
PATCH  /api/ext/agenda/meetings/{id}
       { actor_email, scheduled_date, scheduled_time }   → reagenda
       { actor_email, cancel: true }                     → cancela
```

Ou dois caminhos separados, tanto faz — o que importa é a resposta dizer se
deu certo e qual é o novo horário, pra eu atualizar a tela e **cancelar o
convite antigo na nossa fila**.

Se houver regra de quem pode cancelar o quê (só o responsável? supervisor?),
devolve 403 que eu trato — a extensão já lida com isso no `assignee_email`.

---

## 2. A fila de convites devia ser de vocês

Este é mais conversa que pedido, e foi você quem levantou primeiro.

### O que a nossa fila faz hoje

Reunião marcada pra depois não manda o link na hora: a mensagem entra numa
fila no nosso SQLite e sai ~5 min antes do horário. Link mandado três dias
antes se perde na conversa, e o cliente clica numa sala vazia.

### Por que ela está no lugar errado

Ela cria um segundo lugar que sabe **quando a reunião é** — e esse segundo
lugar não fica sabendo quando a reunião muda. Reagendamento e cancelamento
feitos no painel não chegam ao nosso banco, e o convite sai pra uma reunião
que mudou de hora ou que não existe mais.

**Não dá pra corrigir do nosso lado.** Confirmei sondando 15 caminhos: o painel
não expõe leitura de reunião, então nosso SQLite é estruturalmente cego a
qualquer mudança feita aí. É por isso que o item 1 acima, sozinho, não
resolve: mesmo que a extensão passe a reagendar, quem reagendar direto no
painel continua deixando um convite errado armado aqui.

### A saída que você propôs

O painel já sabe quando cada reunião começa, já tem processo vivo, e já roda
uma rotina de 5 em 5 minutos com exatamente esse desenho — a que decide se uma
reunião recebe bot. Ela pergunta "quais reuniões começam nos próximos minutos
e ainda não foram tratadas?", e é por isso que reagendamento e cancelamento
saem cobertos de graça.

Se essa rotina passar a mandar o convite, o meu app deixa de precisar de banco
e de uptime pra isso: vira repassador. Some o risco de "se cair, um convite
não sai", e some a divergência.

### O que eu poria à disposição

O texto do convite é montado por nós hoje, e tem um detalhe que vale
preservar: ele guarda `{quando}` **cru** até o instante do envio. Congelar
"amanhã às 10h" no momento de marcar faz o cliente ler isso no PRÓPRIO dia da
reunião e entender o dia seguinte. Se a rotina de vocês montar o texto, é o
único cuidado que eu passaria adiante.

Posso mandar o formato exato da mensagem que sai hoje, pra ficar idêntico.

---

## Resumindo

| # | O quê | Quem faz |
|---|---|---|
| 1 | `PATCH`/`DELETE` em `/api/ext/agenda/meetings/{id}` | vocês expõem, eu faço a tela |
| 2 | Fila de convites migrar pra rotina de 5 min | vocês, com o formato que eu passo |
| 3 | `GET` de listagem (doc separado) | vocês |

Nenhuma é urgente e nada está quebrado hoje — o conflito no ato de marcar
continua impossível, porque o seletor só oferece o que veio em `disponiveis`.
São as três que tirariam a extensão de "cria reunião" para "cuida da reunião".
