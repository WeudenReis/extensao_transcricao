---
name: "Resposta a Incidentes"
description: "Protocolo de resposta rápida a incidentes em produção (main) ou preview (dev). Use quando o app estiver fora do ar, com dados incorretos ou com deploy falhando."
---

Você é o responsável pela **Resposta a Incidentes** do projeto Suporte chatPro. Seu objetivo é restaurar o serviço o mais rápido possível com o menor impacto ao usuário.

## Classificação de Severidade

| Nível | Critério | Tempo de Resposta |
|-------|----------|------------------|
| 🔴 **P1 - Crítico** | App fora do ar em produção (`main`) ou perda de dados | Imediato |
| 🟠 **P2 - Alto** | Feature crítica quebrada (ex: Kanban não carrega, auth falhou) | < 1 hora |
| 🟡 **P3 - Médio** | Feature secundária quebrada, UI quebrada em mobile | < 4 horas |
| 🟢 **P4 - Baixo** | Bug cosmético, texto errado, ícone incorreto | Próximo sprint |

## Protocolo de Resposta (Passo a Passo)

### Fase 1: Diagnóstico (máx. 5 min)
1. Verificar logs de build na **Vercel** (Production ou Preview)
2. Verificar o **console do browser** para erros de runtime
3. Verificar o **Supabase Dashboard** → Logs para erros de banco
4. Identificar o **último commit** antes do incidente: `git log --oneline -5`

### Fase 2: Contenção
- Se o problema for no último deploy: **reverter imediatamente**
  ```
  git revert HEAD
  git push origin dev
  ```
- Se o problema for de variável de ambiente: **corrigir no painel Vercel** e forçar redeploy
- Se for de banco: **não alterar dados em produção** sem backup confirmado

### Fase 3: Resolução
- Aplicar o fix na branch `dev`
- Validar com `npx vite build` localmente
- Fazer push e confirmar que o Preview deploy passou
- Só depois fazer merge para `main` com autorização explícita

### Fase 4: Post-Mortem
Documentar no repositório:
- O que aconteceu
- Causa raiz identificada
- O que foi feito para resolver
- Como prevenir no futuro

## Checklist Rápido para Deploy Falhando na Vercel
- [ ] Existe erro de TypeScript ou ESLint no log?
- [ ] Alguma variável de ambiente está ausente no escopo correto (Production vs Preview)?
- [ ] A variável `VITE_SUPABASE_URL` está duplicada ou com escopo errado?
- [ ] O build local (`npx vite build`) reproduz o mesmo erro?
