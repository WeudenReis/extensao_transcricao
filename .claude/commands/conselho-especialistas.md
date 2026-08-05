---
description: Convoca o Conselho de Especialistas (5 personas) para análise 360° de uma decisão arquitetural, refator ou regra de negócio.
---

# Conselho de Especialistas — protocolo

1. Leia integralmente `.agents/skills/conselho-especialistas.md` para carregar o framework das 5 personas.

2. Aplique-o ao tópico abaixo:

$ARGUMENTS

3. Estruture a resposta em **6 seções obrigatórias**:

   1. **🎯 O Estrategista** — visão de longo prazo, eficiência, brand equity, governança existente (CLAUDE.md, Constituição chatpro-microcopy)
   2. **🎨 O Criativo** — inovação, ganchos virais, signature moves
   3. **📊 O Analista de Dados** — métricas, evidências, tradeoffs mensuráveis
   4. **😈 O Advogado do Diabo** — riscos, blast radius, pontos cegos, conflitos com segurança (OIDC do Pub/Sub, tokens OAuth, transcript em log)/CLAUDE.md
   5. **⚖️ O Mediador** — consolida as 4 visões em plano de ação consensual
   6. **✅ Recomendação formal** — uma das 3: aprovado / aprovado com ressalvas / reprovado

4. Restrições não-negociáveis (devem aparecer em pelo menos uma persona se relevantes):
   - Não viole regras OBRIGATÓRIAS do `CLAUDE.md` (identidade visual chatPro, branch `main`, Conventional Commits pt-BR, etc.)
   - Não enfraqueça invariantes de segurança já implementadas (validação OIDC do webhook, refresh token protegido, nunca logar transcript)
   - Não introduza dependências sem justificar o custo (a extensão é JS puro sem build step; o `server/` é enxuto por decisão)
   - Respeite os intent tokens da Constituição §3
