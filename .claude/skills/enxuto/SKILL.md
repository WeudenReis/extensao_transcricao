---
name: enxuto
description: >
  Escreve menos código: reusa o que já existe neste repositório antes de criar,
  e recusa abstração especulativa. Use ao escrever, refatorar ou revisar código
  aqui. Adaptado de ponytail (DietrichGebert) com os erros reais deste projeto.
---

# Enxuto — a escada

Pare no primeiro degrau que resolver:

1. **Precisa existir?** Necessidade especulativa: não faça, e diga em uma linha.
2. **Já existe NESTE repositório?** É o degrau que mais falhou aqui — ver abaixo.
3. **A plataforma resolve?** `<input type="date">` antes de datepicker, CSS
   antes de JS, `Intl.DateTimeFormat` antes de formatador próprio.
4. **Dependência já instalada resolve?** Use. Nunca adicione uma nova pro que
   cabe em poucas linhas.
5. **Cabe em uma linha?** Uma linha.
6. **Só então:** o mínimo que funciona.

## O degrau 2 é o que quebra aqui — casos reais

Três vezes neste projeto o mesmo erro custou trabalho:

- **Máscara de CNPJ e telefone duplicada** em `botao-reuniao.js` e
  `fluxo-reuniao.js`. As duas divergiram. Hoje mora só em `fluxo-reuniao.js`.
- **`p.borda`** usado na grade de horários sem existir na paleta — `border: 1px
  solid undefined` faz o CSS descartar a regra inteira, e os botões ficaram sem
  borda com o hover grudado.
- **Regra de CSS do horário escrita duas vezes**, em arquivos diferentes. A
  segunda sobrescrevia a primeira, e dia e horário selecionados ficaram com
  aparências diferentes.

Antes de escrever helper, tipo, máscara, formatador ou regra de CSS:

```bash
grep -rn "nomeProvavel\|conceito" server/src extension/content | head
```

## Onde já existe o que você provavelmente quer

| Precisa de | Já existe em |
|---|---|
| Validar/normalizar CNPJ | `server/src/painel/client.ts` → `validarCnpj`, `normalizarCnpj` |
| Máscara de CNPJ/telefone | `extension/content/fluxo-reuniao.js` |
| Data e hora locais BR | `server/src/routes/reunioes.ts` → `dataHoraLocal`, `formatarQuando` |
| Ler campo de resposta sem cast cego | `objeto()`, `texto()` em `painel/client.ts` |
| Censurar segredo antes do log | `censurar()` em `painel/client.ts` |
| Cor, raio, espaçamento na aba | tokens do chatPro: `hsl(var(--gray-XX))`, `var(--radius-md)` |
| Componente visual da aba | `api.campo`, `api.cartao`, `api.secao`, `api.caixa`, `api.acao` |
| Embrulho de handler async no Express | `assincrono()` em `routes/reunioes.ts` |

## Regras duras deste repositório

**Nunca cor literal** (`rgb()`, `#hex`) em `extension/content/`. As variáveis
`--gray-*` do chatPro invertem entre tema claro e escuro; cor fixa quebra no
claro. Isso já foi bug e foi corrigido.

**Nunca heredoc de shell pra escrever código** com regex ou barra invertida —
as barras somem e corrompem o arquivo. Aconteceu cinco vezes aqui (`\d` virou
`d`, `\.` virou `.`, `\n` virou quebra de linha real). Use as ferramentas de
escrita ou um arquivo `.mjs` separado.

**Comentário explica o PORQUÊ**, não o quê. Não é verbosidade a cortar: cada um
deles corresponde a um bug que já aconteceu.

## Ao revisar

Uma linha por achado, do maior corte pro menor:

```
<tag> <o que cortar>. <substituto>. [caminho]
```

Tags: `apagar:` (código morto), `existe:` (já tem no repo — diga onde),
`plataforma:` (a plataforma já faz), `yagni:` (abstração com um uso só),
`encolher:` (mesma lógica, menos linha).

Nada a cortar: `Já está enxuto.`
