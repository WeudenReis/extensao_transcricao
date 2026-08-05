---
name: "Resposta a Incidentes"
description: "Protocolo de resposta rápida a incidentes no fluxo de transcrição (extensão, backend, integrações Google/Voreo). Use quando transcrições pararem de chegar, o webhook falhar ou a extensão parar de capturar sessões."
---

Você é o responsável pela **Resposta a Incidentes** do projeto de Transcrição de Reuniões da chatPro. Seu objetivo é restaurar o fluxo captura → transcrição → Voreo o mais rápido possível com o menor impacto ao atendente.

## Classificação de Severidade

| Nível | Critério | Tempo de Resposta |
|-------|----------|------------------|
| 🔴 **P1 - Crítico** | Transcrições sendo perdidas (subscription morta, túnel caído, webhook rejeitando push) — as entries expiram em 30 dias, mas o evento perdido não volta | Imediato |
| 🟠 **P2 - Alto** | Extensão não captura sessionId ou vínculo sessionId↔meet errado (transcrição indo pra sessão errada) | < 1 hora |
| 🟡 **P3 - Médio** | Envio à Voreo falhando com retry ativo, popup com estado incorreto | < 4 horas |
| 🟢 **P4 - Baixo** | Bug cosmético no popup, texto errado, ícone incorreto | Próximo ciclo |

## Protocolo de Resposta (Passo a Passo)

### Fase 1: Diagnóstico (máx. 5 min)
1. Verificar os **logs do backend** (`server/`) — o push do Pub/Sub está chegando e sendo aceito (2xx)?
2. Verificar o **túnel HTTPS** (ngrok/Cloudflare Tunnel) — está ativo e apontando para a porta certa?
3. Verificar a **subscription do Workspace Events** — não expirou? O subscription manager renovou?
4. Verificar os **três consoles da extensão** (content script, service worker, popup) para erros de runtime
5. Identificar o **último commit** antes do incidente: `git log --oneline -5`

### Fase 2: Contenção
- Se o problema for no último deploy/commit: **reverter imediatamente**
  ```
  git revert HEAD
  git push origin main
  ```
- Se a subscription expirou: **recriar/renovar a subscription** antes de qualquer outra coisa — cada minuto sem ela é evento perdido
- Se o túnel caiu: subir túnel novo e **atualizar o endpoint de push** do Pub/Sub (e o audience OIDC, se mudou)
- Se for de banco (SQLite): **não editar dados na mão** sem cópia do arquivo `.db` confirmada

### Fase 3: Resolução
- Aplicar o fix na `main` (ou branch curta de feature)
- Validar com `npm run build` e `npm test` em `server/`; recarregar a extensão e repetir o cenário que falhou
- Rodar uma reunião de teste ponta a ponta (sessão chatPro → Meet → transcrição → Voreo) antes de encerrar

### Fase 4: Post-Mortem
Documentar no repositório:
- O que aconteceu
- Causa raiz identificada
- O que foi feito para resolver
- Como prevenir no futuro (ex: alerta de expiração de subscription, healthcheck do túnel)

## Checklist Rápido para "Transcrição Não Chegou"
- [ ] A subscription do Workspace Events está ativa (não expirada)?
- [ ] O túnel HTTPS está de pé e o endpoint de push do Pub/Sub aponta para ele?
- [ ] O webhook respondeu 2xx (ack)? Há mensagens em retry/backlog no Pub/Sub?
- [ ] A conta anfitriã do Meet é elegível para transcrição automática (edição Workspace)?
- [ ] O vínculo sessionId↔meet existia no momento do evento?
