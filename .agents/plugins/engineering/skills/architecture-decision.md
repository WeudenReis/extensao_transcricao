---
name: "Decisão de Arquitetura (ADR)"
description: "Documenta e analisa decisões de arquitetura do projeto chatPro. Use quando for introduzir uma nova biblioteca, mudar a estrutura de pastas, trocar uma abordagem de estado ou alterar o banco de dados."
---

Você é o responsável por documentar e avaliar **Architecture Decision Records (ADR)** do projeto de Transcrição de Reuniões da chatPro. Toda decisão técnica significativa deve ser registrada para garantir rastreabilidade e evitar decisões conflitantes no futuro.

## Quando Criar um ADR
Crie um ADR sempre que a decisão:
- Introduzir uma nova dependência no `server/` (`npm install`) ou qualquer biblioteca na extensão
- Mudar a estrutura de pastas do projeto (`extension/` ou `server/`)
- Alterar a estratégia de estado/mensageria da extensão (`chrome.storage`, formato das mensagens runtime)
- Modificar o schema do banco de dados (SQLite / better-sqlite3)
- Mudar a abordagem de autenticação/autorização (OAuth Google, validação OIDC do Pub/Sub) ou os escopos solicitados
- Alterar o contrato com APIs externas (Meet REST v2, Workspace Events, Pub/Sub, Voreo)

## Template de ADR

```markdown
# ADR-[número]: [Título Curto da Decisão]

**Data:** [YYYY-MM-DD]
**Status:** Proposta | Aceita | Rejeitada | Depreciada
**Autor:** [Nome]

## Contexto
[Descreva o problema ou situação que motivou esta decisão]

## Decisão
[Descreva claramente o que foi decidido]

## Alternativas Consideradas
| Alternativa | Prós | Contras |
|-------------|------|---------|
| Opção A | ... | ... |
| Opção B | ... | ... |

## Consequências
### Positivas
- [resultado positivo 1]

### Negativas / Trade-offs
- [trade-off 1]

## Arquivos Afetados
- `extension/...` ou `server/src/...` — Razão

## Critérios de Reversão
[Como desfazer esta decisão se necessário]
```

## Regras de Governança
- **Nenhuma nova lib na extensão sem ADR** — a extensão é JS puro sem build step; qualquer dependência vendorizada precisa de justificativa forte
- **Decisões sobre o banco** (SQLite) sempre requerem script/rotina de migração versionada no `server/`
- **ADRs rejeitados** devem ser mantidos com a justificativa de rejeição (histórico)
- Salve os ADRs em `docs/adr/ADR-[número]-[slug].md`
