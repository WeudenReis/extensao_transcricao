---
name: data-governance
description: Política de retenção, ciclo de vida e LGPD para dados do projeto de transcrição de reuniões da chatPro. Define como vínculos de sessão, transcrições, tokens OAuth e logs são armazenados, expurgados e respondidos a solicitações de titulares (LGPD/GDPR). Aplicar em qualquer mudança de schema do SQLite, em qualquer feature que armazene ou trafegue dados pessoais de cliente final, e em qualquer rotina de purge.
---

# Constituição de Governança de Dados — chatPro

Documento normativo. Cobre retenção, expurgo, LGPD e responsabilidades em dados sensíveis. Complementa `chatpro-microcopy/SKILL.md` (que cobre identidade) e `conselho-especialistas.md` (que cobre decisão arquitetural).

> **NOTA CENTRAL DESTE PROJETO:** transcrição de reunião é **dado sensível de cliente final**. Uma transcrição carrega nome, contexto comercial, possivelmente CPF, telefone e detalhes da vida do cliente atendido — tudo dado pessoal sob LGPD Art. 5º, II. Regras derivadas: **minimizar retenção** (guardar transcrição local só o tempo necessário para garantir a entrega), **enviar para a Voreo só o necessário** ({sessionId, transcript, metadados essenciais} — nada de emails de participantes ou IDs internos do Google) e **nunca logar o conteúdo** da transcrição.

---

## 1. Classificação de dados

| Categoria | Exemplos neste projeto | Sensibilidade |
|-----------|------------------------|---------------|
| **Operacional** | sessionId capturado, spaceId/meetingCode do Meet, estado do vínculo | Baixa |
| **Comportamental** | Logs de eventos recebidos (messageId, timestamps, status de processamento) | Média |
| **Credencial** | Refresh/access token OAuth Google, VOREO_API_KEY | **Alta — comprometimento = acesso a reuniões** |
| **PII de cliente final** | Conteúdo da transcrição (entries), nomes de participantes | **Alta — sujeita à LGPD** |
| **Forense** | Registro de envios à Voreo (o quê, quando, para qual sessionId — sem conteúdo) | Média — imutável |

A categoria **PII de cliente final** é a mais sensível: o atendente faz reunião com cliente externo e a transcrição captura a conversa inteira. Diferente de um campo de formulário, aqui a PII chega em bloco e sem filtro.

---

## 2. Política de retenção

### 2.1. Dados operacionais (vínculos sessionId↔meet)

Sem TTL rígido, mas expurgo recomendado após confirmação de entrega à Voreo + janela de segurança (**90 dias**). Vínculo sem transcrição associada há mais de 30 dias é lixo (as entries do Google já expiraram) — pode ser removido.

### 2.2. Transcrições persistidas localmente (SQLite)

A transcrição local existe por um único motivo: garantir a entrega à Voreo mesmo com falha transitória (as entries do Google somem em **30 dias**, então a busca precisa ser imediata e persistida). Depois disso:

| Estado | Retenção | Ação |
|--------|----------|------|
| Enviada à Voreo com sucesso confirmado | **7 dias** | Purge do conteúdo; manter só o registro forense (sem transcript) |
| Falha de envio (retry em andamento) | Até resolver, máx. **30 dias** | Escalar manualmente se o retry esgotar |
| Órfã (sem vínculo de sessão resolvido) | **30 dias** | Purge total + log do descarte |

**Estado atual:** purge automático ainda não implementado. Enquanto não existir, o purge é manual e deve ser rodado a cada ciclo de manutenção.

### 2.3. Credenciais

| Dado | Regra |
|------|-------|
| Refresh token Google | Só no SQLite (arquivo fora de pasta servida), nunca em log/commit; revogar no Google ao desativar a integração |
| Tokens de acesso | Memória/curta duração; nunca persistir além do necessário |
| VOREO_API_KEY e demais secrets | Somente em `.env` (fora do Git) |

### 2.4. Backup

**Estado atual:** o banco é um arquivo SQLite local (`DATABASE_PATH`). Backup, se feito, herda a mesma sensibilidade do banco: se contém transcrições não expurgadas, o backup também contém — aplicar a mesma janela de retenção ao backup.
**Risco aberto:** backup esquecido em máquina local é o caminho mais provável de vazamento retroativo. Preferir backup apenas de schema + dados operacionais, sem a tabela de transcrições.

---

## 3. Playbook LGPD — Direito ao Esquecimento

Quando um cliente final solicita exclusão de seus dados pessoais conforme LGPD Art. 18, V:

### 3.1. Recebimento da solicitação

Solicitação chega tipicamente via DPO ou canal jurídico. Identificar:
- Nome completo do titular
- Email/telefone associado
- sessionId(s) do chatPro em que foi atendido (buscar com o time de atendimento)
- Período aproximado das reuniões

### 3.2. Levantamento de impacto (search & purge)

Identificar todos os pontos onde os dados do titular podem aparecer:

```sql
-- Transcrições locais ainda retidas (SQLite)
SELECT id, session_id, created_at FROM transcripts
 WHERE transcript LIKE '%TERMO%';

-- Vínculos da(s) sessão(ões) do titular
SELECT * FROM links WHERE session_id IN (...);

-- Registro forense de envios (não contém transcript, mas confirma o que foi enviado)
SELECT * FROM delivery_log WHERE session_id IN (...);
```

**ATENÇÃO — o dado saiu do nosso perímetro:** a transcrição foi enviada à **Voreo** e pode ainda existir como transcrição/gravação no **Google Workspace** da conta anfitriã. O expurgo local NÃO encerra a solicitação: é obrigatório acionar o fluxo de exclusão da Voreo (via responsável pela plataforma) e verificar os artefatos do Meet (Drive da conta anfitriã).

### 3.3. Expurgo

```sql
-- 1. Neutralizar o conteúdo local, preservando o vestígio forense
UPDATE transcripts
   SET transcript = '[EXPURGADO LGPD ' || date('now') || ']'
 WHERE id IN (...);
```

**Importante:** preservar a EXISTÊNCIA do registro (não DELETAR a linha), apenas neutralizar o conteúdo PII. Isso mantém a integridade do rastro (há vestígio de que algo existiu e foi expurgado) sem violar o direito do titular.

### 3.4. Documentação

Toda operação de expurgo deve ser registrada externamente (planilha do DPO):
- Data da solicitação e da execução
- sessionIds/tabelas afetados + confirmação do expurgo na Voreo e no Workspace
- Identificação do executor
- Status (concluído / parcial / negado com justificativa)

---

## 4. Responsabilidades

| Papel | Responsabilidade |
|-------|------------------|
| **DPO da empresa** | Receber solicitação, validar identidade do titular, autorizar expurgo |
| **Responsável pelo backend** | Localizar dados (queries SQLite), executar expurgo local, acionar expurgo na Voreo |
| **Admin Google Workspace** | Remover transcrições/gravações residuais no Drive/Meet da conta anfitriã |
| **Atendente (operacional)** | Reportar quando suspeitar que uma reunião capturou dados sensíveis fora do escopo |

---

## 5. Princípios para novas features

Antes de adicionar uma nova tabela, coluna ou campo em payload, perguntar:

1. **Esse campo pode conter PII de cliente final?** Se sim, considerar não armazenar, truncar ou criptografar em repouso.
2. **Esse dado precisa viver para sempre?** Se não, definir TTL desde o dia 1.
3. **Em caso de incidente, esse dado seria útil ou seria passivo?** Se é só "talvez útil", reduzir o escopo.
4. **Esse log/payload precisa do conteúdo completo?** Frequentemente `sessionId + contagem de entries + timestamps` resolve com fração do risco. Nunca logar transcript; nunca enviar à Voreo além do payload mínimo.

> **Anti-padrão:** persistir a resposta bruta das APIs do Google (entries completas com participantes, emails e IDs internos) "por garantia". Projete apenas os campos necessários para montar o transcript e o vínculo — o resto é passivo de LGPD sem valor operacional.

---

## 6. Histórico

| Versão | Data | Mudança |
|--------|------|---------|
| 1.0 | 2026-05-07 | Documento inicial — classificação, retenção, playbook LGPD, responsabilidades, princípios |
| 1.1 | 2026-08-05 | Adaptação ao projeto de transcrição de reuniões — Supabase/tickets → SQLite/transcrições, nota central sobre transcrição como dado sensível, expurgo estendido a Voreo e Google Workspace |
