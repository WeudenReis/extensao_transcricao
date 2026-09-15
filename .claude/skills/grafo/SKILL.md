---
name: grafo
description: >
  Cérebro visual do código (Graphify) para entender uma função grande, medir o
  impacto de uma mudança e ver como uma parte chega em outra, gastando uma
  fração dos tokens de ler o arquivo. Use antes de ler com sed uma função
  longa, e antes de mudar a assinatura de algo usado em vários lugares.
---

# Grafo — quando vale e quando não vale

Sempre por `node scripts/grafo.mjs`: ele regenera o grafo antes se o código
mudou (~6 s). Nunca `graphify` direto, nunca `/graphify .` — ver Segurança.

## Use o grafo

| Pergunta | Comando | Medido em 15/09/2026 |
|---|---|---|
| O que esta função grande contém e chama? | `explain "passoDados"` | 2 mil chars contra 35 mil de ler a função |
| O que quebra se eu mudar isto? | `affected "PainelClient"` | 15 dependentes em 1,5 mil chars, uma chamada |
| Como A chega em B? | `path "main" "PainelClient"` | 1 salto, `main()` chama direto |
| Onde está o centro do sistema? | `god-nodes` | — |

Depois do `explain`, leia com `sed -n` **só o trecho** que ele apontou — a
linha de cada conexão vem na saída. É isso que evita abrir o arquivo inteiro.

## Use grep, não o grafo

- **Achar todos os usos antes de editar.** O grafo diz qual FUNÇÃO usa, mas
  mostra UMA linha por ligação. `formatarTelefone` tem 3 usos em
  `fluxo-reuniao.js` (L1957, L1984, L2266). O `explain` mostrou 2, porque
  `passoDados` usa duas vezes e só a L1957 aparece. Pra editar, a fonte é
  `grep -n "formatarTelefone"` **sem o parêntese**. Com `formatarTelefone(`
  some a L1957, que passa a função como valor.
- **Achar um texto** (mensagem, nome de campo, string). grep saiu mais
  barato: 523 chars contra 918.

## Não use

- **`query`** (pergunta em linguagem natural). "como o CNPJ preenche a razão
  social" trouxe `.preencherSessionId()` e `RecallQueueWorker`: casa pedaço de
  palavra, não sentido. O `grafo.mjs` nem aceita esse comando.

## Segurança

O grafo é gerado numa pasta limpa, só com código, sem LLM. **Nunca** rode
`graphify install`, `graphify claude install` nem `/graphify .` aqui:

- a skill oficial roda o pipeline completo na raiz, fora da pasta limpa. Ali
  os `.md` de `docs/` vão pra um LLM.
- o `claude install` escreve no CLAUDE.md e instala um hook PreToolUse, que
  intercepta as ferramentas do Claude Code — mudança de comportamento que
  ninguém pediu.

## Limites

- **Nomes repetidos.** Há 4 `client.ts` (painel, chatpro, recall, voreo).
  `explain "client.ts"` responde `Ambiguous` e lista os quatro caminhos. Refaça
  com `explain "server/src/painel/client.ts::client.ts"`.
- **Extensão e servidor não se ligam.** Eles conversam por HTTP, e pedido HTTP
  não vira aresta. `path "passoDados" "PainelClient"` responde "No directed
  path found", mas a ligação existe: o `pedir()` passa pelo service worker e
  chega numa rota. Pra atravessar essa fronteira, siga o `tipo` da mensagem com
  grep.
- **Grupos instáveis.** O agrupamento muda entre execuções: 42, 50 e 63 grupos
  medidos. Nós e conexões não mudam, então não compare número de grupos.
