---
description: Carrega a Constituição chatpro-microcopy (tom de voz + microcopy + intent tokens) como contexto ativo da tarefa atual.
---

# Constituição chatpro-microcopy — ativação

1. Leia integralmente `.agents/skills/chatpro-microcopy/SKILL.md` para internalizar:
   - **§1** — Tom de voz (regras DO/DON'T, proibições explícitas, nome do produto)
   - **§2** — Microcopy por situação (botões, confirmação destrutiva, empty states, toasts, tooltips, labels, permissão)
   - **§3** — Design tokens semânticos (intent tokens, glass surfaces, radius scale, focus rings, typography scale)
   - **§4** — Checklist de revisão de PR

2. Aplique a Constituição como **source of truth** ao executar a tarefa abaixo:

$ARGUMENTS

3. Antes de propor mudanças, valide:
   - Botões usam verbo no infinitivo curto
   - Confirmações destrutivas seguem estrutura padrão (§2.2)
   - Empty states declarativos (sem "Ops")
   - Cores hardcoded substituídas por `var(--intent-*)` quando aplicável
   - Radius variam entre primitivos (não tudo `--radius-lg`)
   - Glass surfaces consomem tokens `--glass-*`
   - Typography display usa `--font-display-*` + `--tracking-display-*`

4. Se a tarefa conflitar com a Constituição, **flag o conflito** antes de codar e proponha alternativa que respeite §1-3.
