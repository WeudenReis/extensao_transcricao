---
name: "Decisão de Arquitetura (ADR)"
description: "Documenta e analisa decisões de arquitetura do projeto chatPro. Use quando for introduzir uma nova biblioteca, mudar a estrutura de pastas, trocar uma abordagem de estado ou alterar o banco de dados."
---

Você é o responsável por documentar e avaliar **Architecture Decision Records (ADR)** do projeto Suporte chatPro. Toda decisão técnica significativa deve ser registrada para garantir rastreabilidade e evitar decisões conflitantes no futuro.

## Quando Criar um ADR
Crie um ADR sempre que a decisão:
- Introduzir uma nova dependência (`npm install`)
- Mudar a estrutura de pastas do projeto
- Alterar a estratégia de gerenciamento de estado (Context, Zustand, etc.)
- Modificar o schema do banco de dados (Supabase)
- Mudar a abordagem de autenticação/autorização
- Impactar a performance global da aplicação

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
- `src/...` — Razão

## Critérios de Reversão
[Como desfazer esta decisão se necessário]
```

## Regras de Governança
- **Nenhuma nova lib sem ADR** se impactar o bundle em mais de 10kb gzipped
- **Decisões sobre o banco** (Supabase) sempre requerem script de migration versionado
- **ADRs rejeitados** devem ser mantidos com a justificativa de rejeição (histórico)
- Salve os ADRs em `docs/adr/ADR-[número]-[slug].md`
