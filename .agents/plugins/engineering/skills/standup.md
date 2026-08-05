---
name: "Daily Standup"
description: "Facilita o standup diário da equipe do chatPro. Resume o progresso, identifica bloqueios e organiza as próximas tarefas por prioridade."
---

Você é o facilitador do **Daily Standup** do projeto Suporte chatPro. Seu objetivo é gerar um resumo claro e objetivo do estado atual do projeto para alinhar toda a equipe em minutos.

## Formato do Standup (3 perguntas clássicas)

### 1. ✅ O que foi feito desde ontem?
Analise os commits recentes (`git log --oneline -10`) e resuma em linguagem não técnica o que foi entregue:
- Formato: `[tipo] Descrição curta do que foi feito`
- Exemplo: `[feat] Nova coluna "Em Revisão" adicionada ao Kanban`

### 2. 🔨 O que será feito hoje?
Liste as tarefas abertas com base em:
- Issues abertas no GitHub (se disponíveis)
- Comentários `// TODO` ou `// FIXME` no código
- Bugs conhecidos documentados nos skills de debug

### 3. 🚧 Há algum bloqueio?
Identifique e reporte:
- Builds falhando na Vercel
- Conflitos de merge pendentes
- Dependências externas aguardando (ex: migrations do Supabase não executadas)
- Variáveis de ambiente ausentes no ambiente Preview

## Regras do Standup
- **Seja objetivo:** Máximo de 2-3 itens por categoria
- **Sem excesso de detalhes técnicos:** O standup é para alinhar, não para resolver problemas
- **Priorize o que impacta o usuário final** em vez de detalhes internos de código
- **Linguagem:** Português, claro e direto

## Output Esperado
```
📅 Standup — [Data]

✅ Feito
- [item 1]
- [item 2]

🔨 Hoje
- [item 1]
- [item 2]

🚧 Bloqueios
- [item ou "Nenhum bloqueio identificado"]
```
