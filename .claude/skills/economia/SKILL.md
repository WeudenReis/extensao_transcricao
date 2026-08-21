---
name: economia
description: >
  Modo econômico de contexto para este repositório. Corta tokens em comandos,
  leitura de arquivo e delegação a subagente, SEM cortar a explicação do porquê
  nem os comentários do código — que é o que já provou valor aqui.
  Use quando o usuário pedir "economizar tokens", "modo econômico", "contexto
  curto", ou quando a sessão for longa.
  Adaptado de caveman (JuliusBrussee) e ponytail (DietrichGebert).
---

# Modo econômico — medido neste repositório

O que gasta contexto aqui **não é a prosa da resposta**. É, em ordem:

| Fonte | Medido | Correção |
|---|---|---|
| Saída do `vitest` | 367 mil chars/rodada | já resolvido: `vitest.config.ts` põe `LOG_LEVEL=warn` → 55 mil (**−85%**) |
| Resultado de workflow | 600 mil+ tokens por run | comprimir o retorno do subagente (abaixo) |
| Reler arquivo grande | `fluxo-reuniao.js` = 104 mil chars | `grep -n` + `sed -n 'X,Yp'`, nunca o arquivo inteiro |
| Descobrir contrato de API | dezenas de tentativas | `docs/CAMPOS-DO-PAINEL.md` já tem o mapa — leia antes de sondar |

## Regras de comando

Sempre que houver escolha, prefira a forma que já vem curta:

```bash
npx vitest run --reporter=dot 2>&1 | tail -4      # não a saída inteira
npx vitest run test/arquivo.test.ts                # não a suíte toda
npx tsc --noEmit 2>&1 | head -5                    # os primeiros erros bastam
git log --oneline -3                               # não o log completo
grep -n "alvo" arquivo | head                      # não `cat arquivo`
```

Nunca `cat` num arquivo acima de 300 linhas. Use `grep -n` pra achar a linha e
`sed -n 'inicio,fimp'` pra ler só o trecho.

Antes de sondar a API do painel por tentativa e erro, leia
`docs/CAMPOS-DO-PAINEL.md`: o schema já foi mapeado campo a campo, incluindo os
doze nomes que **não** existem.

## Regras de resposta

Corte: saudação, "vou fazer X" antes de fazer, narração de chamada de
ferramenta, recapitulação do que o usuário acabou de dizer, tabela decorativa,
emoji fora do texto que vai pro WhatsApp do cliente.

**Não corte:** o *porquê* de uma decisão técnica, o risco que você viu, a
correção de uma premissa errada do usuário, nem o resultado real de um teste.
Foi exatamente isso que evitou os erros caros deste projeto — dois bots na mesma
sala, cor fixa quebrando o tema claro, o horário sem fuso, o aviso que nunca
aparecia. Um "ok, feito" no lugar dessas explicações teria custado muito mais
que os tokens economizados.

Nada de "modo caveman": frase curta em português correto. Artigo custa quase
nada e a leitura fica pior sem ele.

## Delegação a subagente

Workflow é o maior gasto isolado deste repositório — cada run devolveu
600 mil+ tokens de relatório. Ao escrever o prompt de um agente, exija o
formato de volta:

```
Reporte em no máximo 15 linhas:
- o que mudou (arquivo:linha, uma linha por mudança)
- o que quebrou e como consertou
- o que NÃO fez e por quê
Sem repetir o enunciado, sem recapitular o contexto, sem listar arquivo que não mudou.
```

Use `schema` no `agent()` sempre que a resposta for estruturada: o objeto
validado é menor e mais confiável que prosa.

## O que NÃO comprimir

Comentário de código continua explicando o **porquê**, como manda o
`CLAUDE.md`. Cada comentário longo deste repo corresponde a um bug que já
aconteceu — encurtá-los devolveria o bug.

Mensagem de commit continua contextualizada. É o histórico que explicou o
desligamento da gravação e o desvio pro plano B.
