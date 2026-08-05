---
name: chatpro-microcopy
description: Constituição de microcopy, tom de voz e design tokens semânticos dos produtos chatPro — neste repositório, a extensão Chrome de transcrição de reuniões (popup e mensagens ao atendente). Aplicar em qualquer texto de UI (botões, modais, toasts, empty states, tooltips, alertas) e em qualquer componente que use cores semânticas (destrutivas, informativas, de marca). Cruza com a skill UI/UX Pro Max para garantir consistência visual + verbal.
---

# Constituição de Identidade chatPro

Documento normativo. Toda nova tela ou refatoração (popup da extensão incluído) deve passar por esta rubrica antes de ir pra `main`.

---

## 1. Tom de voz

**Princípio:** Simples, Prático e Intuitivo. Conversa de colega de equipe, não de manual técnico nem de marketing.

### 1.1. Regras gerais

| ✅ Faça | ❌ Evite |
|---------|---------|
| Voz ativa, sujeito explícito | Voz passiva sem agente ("foi processado") |
| Frases curtas (≤ 14 palavras) | Períodos longos com subordinadas |
| Verbos no infinitivo em ações | "Você pode clicar aqui para…" |
| Português brasileiro padrão | Pronomes neutros ("todes", "elu") |
| Gênero masculino genérico | Construções com "@" ou "x" |
| Declarativo e direto | Marketing-ese, hype, exclamações |
| Termos do domínio do usuário | Jargão técnico vazio ("solução", "experiência") |

### 1.2. Proibições explícitas

- **Sem emojis** em UI textual (exceto ícones via `<Icon>`).
- **Sem exclamações** ("Pronto!", "Sucesso!", "Atenção!"). Pontuação neutra.
- **Sem "Ops" / "Oh não" / "Que pena"** — empty states não pedem desculpa.
- **Sem "Clique aqui"** — o botão é o link.
- **Sem "Por favor"** — é uma ferramenta de trabalho, não atendimento.
- **Sem reticências decorativas** ("Carregando..." vira "Carregando", a menos que seja indicador de progresso).

### 1.3. Nome do produto

Sempre **chatPro** (c minúsculo, P maiúsculo). Nunca "ChatPro", "Chat Pro", "CHATPRO".

---

## 2. Microcopy por situação

### 2.1. Botões de ação

Verbo no infinitivo, ≤ 2 palavras quando possível.

| ✅ | ❌ |
|----|----|
| Restaurar | Restaurar agora |
| Excluir | Deletar este item |
| Salvar | Salvar alterações |
| Cancelar | Não, voltar |
| Atualizar | Atualizar este link |

### 2.2. Confirmação destrutiva

Estrutura fixa: **Verbo no título** + **frase de irreversibilidade** + **lista do que será afetado** + **input de confirmação se for em massa ou crítico**.

```
Título:           Excluir permanentemente
Linha 1:          Esta ação não pode ser desfeita.
Linha 2 (opc.):   {N} transcrições serão removidas.
Lista (≤ 5):      · {título} · {título} ...
Input crítico:    Digite DELETAR para confirmar
Botão:            Excluir permanentemente (vermelho)
Cancelar:         Cancelar (neutro)
```

Sem alarmismo. A irreversibilidade é o único alarme; o resto é informação.

### 2.3. Empty states

Estrutura: **Substantivo + estado** em uma frase.

| ✅ | ❌ |
|----|----|
| Nenhuma sessão detectada | Ops! Você ainda não abriu nenhuma conversa. |
| Nenhuma transcrição enviada ainda | Que bom! Nenhuma transcrição foi enviada. |
| Nenhum resultado para a busca | Não encontramos nada que corresponda à sua busca |

Permitido (mas opcional) adicionar **uma frase de orientação** se o estado é frequentemente confundido:
> *Nenhuma transcrição enviada ainda. Transcrições enviadas para análise aparecem aqui.*

### 2.4. Toasts e feedback assíncrono

| Situação | Texto |
|----------|-------|
| Sucesso de ação | `{Substantivo} restaurado` (não "Restaurado com sucesso!") |
| Falha recuperável | `Falha ao {ação}. Tente novamente.` |
| Falha bloqueante | `Falha ao {ação}: {motivo curto}` |
| Loading curto | `Carregando` |
| Loading prolongado (≥ 3s) | `Carregando {recurso}...` (reticências OK aqui) |

### 2.5. Tooltips

Frase substantiva que descreve **o quê**, nunca **o como**.

| ✅ | ❌ |
|----|----|
| Reenviar transcrição | Clique para reenviar esta transcrição |
| Excluir permanentemente | Apagar de vez (ação irreversível!) |
| Vincular sessão | Aplicar o vínculo desta reunião com a sessão |
| Alterar ordenação | Mudar como os itens são ordenados |

### 2.6. Labels e placeholders

- **Labels**: substantivo curto, sem dois-pontos: `Título`, `Buscar`, `Categoria`.
- **Placeholders**: exemplo concreto ou pista (`https://...`, `Buscar no histórico...`). Não duplicar o label.

### 2.7. Permissão negada

Mensagem direta + responsável.

| ✅ | ❌ |
|----|----|
| Apenas administradores podem excluir transcrições | Você não tem permissão para realizar esta ação |
| Sem acesso a este departamento | Permissão negada — entre em contato com o suporte |

### 2.8. Confirmações leves (não destrutivas)

Use ação inline em vez de modal. Ex: desfazer um vínculo de sessão → desfazer via toast com botão "Desfazer", **não** um confirm() modal.

---

## 3. Design tokens semânticos

Os tokens primitivos (cores brutas) vivem no CSS do popup da extensão (`extension/popup/`). Esta camada adiciona **intent tokens** (semânticos) que dizem **para que servem** as cores, não **quais são**.

### 3.1. Hierarquia em camadas

```
Primitivo  →  --priority-high: #ef5c48
Semântico  →  --intent-destructive: var(--priority-high)
Componente →  .btn-delete { color: var(--intent-destructive); }
```

Sempre que possível, consumir semântico (`--intent-destructive`) e nunca primitivo (`#ef5c48`) em código de componente. Se um token semântico precisar mudar de cor, muda em um lugar só.

### 3.2. Tabela de intents

| Token | Cor primitiva | Uso |
|-------|---------------|-----|
| `--intent-destructive` | `var(--priority-high)` `#ef5c48` | Excluir, remover, alertas críticos |
| `--intent-destructive-bg` | `rgba(239,92,72,0.16)` | Fundo de chip/btn destrutivo |
| `--intent-destructive-border` | `rgba(239,92,72,0.32)` | Borda de chip/btn destrutivo |
| `--intent-info` | `var(--accent)` `#579dff` | Editar, listas, informação neutra |
| `--intent-info-bg` | `rgba(87,157,255,0.16)` | Fundo de chip/btn de edição |
| `--intent-info-border` | `rgba(87,157,255,0.32)` | Borda de chip/btn de edição |
| `--intent-warn` | `var(--priority-medium)` | Atenção média, prioridade média |
| `--intent-success` | `var(--priority-low)` `#4bce97` | Confirmação, prioridade baixa |
| `--intent-brand` | `var(--cp-green)` `#25D066` | CTA primário, restaurar, ações de marca |
| `--intent-brand-bg` | `var(--cp-green-bg)` | Fundo de chip/btn de marca |
| `--intent-brand-border` | `var(--cp-green-border)` | Borda de chip/btn de marca |
| `--intent-muted` | `var(--text-muted)` `#596773` | Estados desabilitados, "sem prioridade" |

### 3.3. Glass tokens (camada SaaS Premium)

| Token | Valor | Uso |
|-------|-------|-----|
| `--glass-panel` | `rgba(20,28,38,0.72)` | Fundo de painéis flutuantes (sidebar, drawer) |
| `--glass-panel-strong` | `rgba(20,28,38,0.92)` | Fundo de modais centrados (alta opacidade) |
| `--glass-blur` | `blur(16px) saturate(140%)` | Filtro padrão de glassmorphism |
| `--glass-blur-strong` | `blur(20px) saturate(140%)` | Filtro de modais sobre overlay escuro |
| `--glass-border` | `1px solid rgba(255,255,255,0.05)` | Borda translúcida padrão |
| `--glass-shadow` | `0 16px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04)` | Sombra de painel + highlight superior |

### 3.4. Radius scale

| Token | Valor | Uso |
|-------|-------|-----|
| `--radius-xs` | `6px` | Ícones pequenos, tags |
| `--radius-sm` | `8px` | Botões, inputs |
| `--radius-md` | `9px` | Linhas de log, chips médios |
| `--radius-lg` | `12px` | Cards, dropdowns |
| `--radius-xl` | `14px` | Painéis principais, modais |
| `--radius-pill` | `9999px` | Count badges, chips de filtro **(NUNCA botões/cards/modais)** |

> **Anti-AI-slop:** evitar usar o mesmo radius em tudo. Hierarquia visual exige variação proposital — botão `sm`, card `lg`, modal `xl`. Pill é exceção semântica reservada a contadores e chips.

### 3.5. Motion tokens (Wave 2.1 — Apple Hybrid)

| Token | Valor | Uso |
|-------|-------|-----|
| `--motion-press-scale` | `0.95` | Press feedback universal em botões/CTAs interativos (canônico Apple) |
| `--motion-tight-tracking` | `-0.025em` | Letter-spacing de títulos ≥18px (colunas, displays). NUNCA em body copy |
| `--motion-glass-blur` | `blur(20px) saturate(180%)` | Filtro de barras flutuantes/sticky (headers e barras de status do popup) |
| `--shadow-lift` | `0 3px 30px rgba(0,0,0,0.22), inset 0 1px 0 rgba(36,255,114,0.04)` | "chatPro Lift" — elevação única para surfaces flutuantes (one shadow rule) |

**Regras obrigatórias de uso:**

1. **`prefers-reduced-motion`:** toda `transform: scale()` em interação **DEVE** vir com guard `@media (prefers-reduced-motion: no-preference)` no CSS. WCAG 2.3.3 (AAA).
2. **Letter-spacing tight:** reservado a títulos ≥18px. Em body copy degrada legibilidade — palavras longas em PT-BR (`responsável`, `aprovação`) comprimem desconfortavelmente.
3. **Backdrop-filter:** **DEVE** ter fallback `@supports not (backdrop-filter: blur(20px))` com fundo sólido `--glass-panel-strong`. iOS Safari < 14 e Android WebView pré-2022 podem renderizar transparente sem blur, deixando barras ilegíveis sobre cards coloridos.
4. **Shadow-lift:** apenas em surfaces explicitamente "elevadas" (modais, dropdowns, sticky bars). Surfaces flat (botões, inputs, tags, cards inline) seguem regra Apple "no shadow".

**Origem da calibração:** Apple `DESIGN.md` (signature moves §7) — *forma e movimento*, NÃO cor/tipografia. Hybrid: Apple aporta proporção e gestos; chatPro mantém `#25D066`, Paytone One e o fundo dark (#1d2125/#22272b) como source-of-truth de identidade.

---

## 4. Aplicação na revisão de código

Antes de aprovar PR, conferir:

1. ✅ Todo texto visível ao usuário passou pela rubrica de microcopy?
2. ✅ Botões usam verbo no infinitivo curto?
3. ✅ Confirmações destrutivas seguem a estrutura padrão (§2.2)?
4. ✅ Cores hardcoded foram substituídas por intents semânticos onde aplicável?
5. ✅ Radius variam entre primitivos diferentes (não tudo `--radius-lg`)?
6. ✅ Glass surfaces usam os tokens `--glass-*`?

---

## 5. Histórico

| Versão | Data | Mudança |
|--------|------|---------|
| 1.0 | 2026-05-07 | Constituição inicial — tom de voz, microcopy, intent tokens, glass tokens, radius scale |
| 1.1 | 2026-05-08 | Wave 2.1 (Apple Hybrid) — adiciona `--radius-pill` à §3.4 + nova §3.5 Motion tokens (`--motion-press-scale`, `--motion-tight-tracking`, `--motion-glass-blur`, `--shadow-lift`). Press scale canônico Apple = `0.95` (substitui `0.97` da POC). Patch retroativo da POC `8037740` previsto na Fase 2 do rollout. |
| 1.2 | 2026-08-05 | Adaptação de contexto para o projeto de extensão de transcrição (exemplos Kanban → sessões/transcrições, `dev` → `main`, `src/styles.css` → `extension/popup/`). Miolo de marca inalterado. |
