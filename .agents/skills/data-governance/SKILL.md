---
name: data-governance
description: Política de retenção, ciclo de vida e LGPD para dados do Suporte chatPro. Define como dados de tickets, audit logs e PII de clientes são armazenados, expurgados e respondidos a solicitações de titulares (LGPD/GDPR). Aplicar em qualquer migration que mexa com tabelas de log, em qualquer feature que armazene dados pessoais de cliente final, e em qualquer rotina de purge.
---

# Constituição de Governança de Dados — chatPro

Documento normativo. Cobre retenção, expurgo, LGPD e responsabilidades em dados sensíveis. Complementa `chatpro-microcopy/SKILL.md` (que cobre identidade) e `conselho-especialistas.md` (que cobre decisão arquitetural).

---

## 1. Classificação de dados

| Categoria | Exemplos no chatPro | Sensibilidade |
|-----------|---------------------|---------------|
| **Operacional** | Títulos, prioridades, posições no kanban, etiquetas | Baixa |
| **Comportamental** | `activity_log`, `comments`, `notifications` | Média |
| **PII de funcionário** | Email do membro, nome, avatar, role | Média |
| **PII de cliente final** | Conteúdo de descrição/comentário com dados pessoais do cliente atendido | **Alta — sujeita à LGPD** |
| **Forense** | `deleted_tickets_log`, `deleted_lists_log`, `tickets_description_audit` | **Alta — imutável + restrita a admin** |

A categoria **PII de cliente final** é a mais sensível porque o chatPro frequentemente é usado para suporte a clientes externos. Um ticket pode conter nome completo, telefone, CPF, contexto da conversa — tudo isso é dado pessoal sob LGPD Art. 5º, II.

---

## 2. Política de retenção

### 2.1. Tabelas operacionais (ativas)

Sem TTL. Vivem enquanto o usuário não arquivar/excluir manualmente.

### 2.2. Tabelas arquivadas (`is_archived = true`)

Sem TTL automático **hoje**. Recomendação futura: purga automática de tickets arquivados há mais de **24 meses sem restauração**, com antecipação de 30 dias por email ao admin do departamento.

### 2.3. Tabelas de audit log

| Tabela | Retenção sugerida | Justificativa |
|--------|-------------------|---------------|
| `deleted_tickets_log` | **36 meses** | Janela típica de auditoria SOC 2 + segurança contra exfiltração lenta |
| `deleted_lists_log` | **36 meses** | Idem |
| `tickets_description_audit` | **18 meses** | Recuperação de incidentes operacionais (não-segurança) |

**Estado atual:** sem purge automática. Logs crescem indefinidamente.
**Próximo passo (P2 do épico #1):** implementar `pg_cron` job mensal que delete entradas com `deleted_at < now() - interval '36 months'` em uma transação separada (sem trigger — DELETE direto via service_role).

### 2.4. Backup off-DB

**Estado atual:** confiamos no backup automático do Supabase (PITR para o tier pago).
**Risco aberto** (#10 do Advogado do Diabo, épico #1): se DBA com `service_role` rodar `DROP TABLE deleted_*_log`, a "imutabilidade" some. Ainda não temos réplica externa.

---

## 3. Playbook LGPD — Direito ao Esquecimento

Quando um cliente final (não-funcionário) solicita exclusão de seus dados pessoais conforme LGPD Art. 18, V:

### 3.1. Recebimento da solicitação

Solicitação chega tipicamente via email do DPO ou canal jurídico. Identificar:
- Nome completo do titular
- Documento (CPF/CNPJ se aplicável)
- Email/telefone associado
- Período aproximado da interação com chatPro

### 3.2. Levantamento de impacto (search & purge)

Identificar todos os pontos onde os dados do titular podem aparecer:

```sql
-- Tickets ativos (descricao, comentarios)
SELECT id, title FROM tickets
 WHERE description ILIKE '%TERMO%' OR title ILIKE '%TERMO%';

-- Comments
SELECT id, ticket_id FROM comments WHERE content ILIKE '%TERMO%';

-- Audit logs (PII pode estar dentro do JSONB!)
SELECT id, ticket_data FROM deleted_tickets_log
 WHERE ticket_data::text ILIKE '%TERMO%';

-- Anuncios, etc — qualquer tabela com texto livre
```

**ATENÇÃO:** o `to_jsonb(OLD)` dos triggers de auditoria carrega o ticket inteiro. Se um cliente pediu exclusão hoje e o ticket dele foi excluído permanentemente há 6 meses, os dados ainda estão no `deleted_tickets_log`. Não basta excluir do operacional.

### 3.3. Expurgo

Para PII de cliente final, expurgo deve cobrir:

```sql
-- 1. Operacional
UPDATE tickets
   SET title = '[EXPURGADO LGPD]',
       description = '[EXPURGADO LGPD ' || now()::date || ']'
 WHERE id IN (...);

UPDATE comments
   SET content = '[EXPURGADO LGPD]'
 WHERE id IN (...);

-- 2. Audit log — substituir o JSONB completo por um marker
-- Requer service_role (RLS bloqueia UPDATE em logs imutaveis)
UPDATE deleted_tickets_log
   SET ticket_data = jsonb_build_object(
     '_expunged', true,
     '_expunged_at', now(),
     '_expunged_reason', 'LGPD Art. 18, V'
   )
 WHERE id IN (...);
```

**Importante:** preservar a EXISTÊNCIA do registro de auditoria (não DELETAR), apenas neutralizar o conteúdo PII. Isso mantém a integridade do log forense (há vestígio de que algo existiu) sem violar o direito do titular.

### 3.4. Documentação

Toda operação de expurgo deve ser registrada externamente (planilha do DPO ou tabela `lgpd_expungement_log` se for criada no futuro):
- Data da solicitação
- Data da execução
- IDs/tabelas afetados
- Identificação do executor
- Status (concluído / parcial / negado com justificativa)

---

## 4. Responsabilidades

| Papel | Responsabilidade |
|-------|------------------|
| **DPO da empresa** | Receber solicitação, validar identidade do titular, autorizar expurgo |
| **Admin chatPro** | Identificar dados (queries SQL), executar expurgo via service_role |
| **Engenharia** | Manter ferramentas de search & purge atualizadas, agendar `pg_cron` de TTL |
| **Suporte (operacional)** | Reportar quando suspeitar que um ticket contém dados sensíveis fora do escopo |

---

## 5. Princípios para novas features

Antes de adicionar uma nova tabela ou coluna, perguntar:

1. **Esse campo pode conter PII de cliente final?** Se sim, considerar criptografia em repouso ou hash one-way.
2. **Esse dado precisa viver para sempre?** Se não, definir TTL desde o dia 1.
3. **Em caso de incidente, esse dado seria útil ou seria passivo?** Se é só "talvez útil", reduzir o escopo.
4. **Esse log precisa do payload completo?** Frequentemente um snapshot de campos selecionados resolve com fração do storage.

> **Anti-padrão:** `to_jsonb(OLD)` em triggers de auditoria preserva tudo, inclusive PII. Foi adotado em 033 por simplicidade — em retrospectiva (Conselho, 2026-05-07), seria mais seguro projetar apenas: `id, title, priority, column_id, department_id, created_at, archived_at`. Migrar pra esse modelo é um item P3 do épico #1.

---

## 6. Histórico

| Versão | Data | Mudança |
|--------|------|---------|
| 1.0 | 2026-05-07 | Documento inicial — classificação, retenção, playbook LGPD, responsabilidades, princípios |
