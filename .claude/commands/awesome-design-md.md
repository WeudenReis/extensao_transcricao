---
description: Busca o DESIGN.md de uma marca via voltagent/awesome-design-md e aplica como source of truth visual. Uso: /awesome-design-md stripe (ou apple, vercel, linear, notion, etc.)
---

# awesome-design-md — protocolo de fetch + aplicação

1. Leia o protocolo da skill base em `.agents/skills/awesome-design-md/SKILL.md`.

2. **Marca solicitada:** $ARGUMENTS

   Se vazio, peça ao usuário antes de prosseguir. Marcas conhecidas no repo:
   - **AI/LLM:** claude, cohere, elevenlabs, mistral, ollama, voltagent, xai
   - **Dev tools:** cursor, expo, lovable, raycast, vercel, warp
   - **Backend/DevOps:** clickhouse, mongodb, posthog, supabase, sentry
   - **Productivity/SaaS:** cal, linear, notion, resend, zapier
   - **Design/Creative:** figma, framer, webflow
   - **Fintech:** binance, coinbase, stripe, revolut
   - **E-commerce:** airbnb, nike, shopify
   - **Media:** apple, spotify, uber, spacex

3. Faça `WebFetch` na URL raw do DESIGN.md:
   ```
   https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/<marca>/DESIGN.md
   ```
   Cache do WebFetch é 15min — re-fetch se demorou mais.

4. Extraia e apresente em formato estruturado:
   - **Visual Theme** — vibe geral em 1-2 linhas
   - **Color Palette** — todos os hex com semantic name
   - **Typography** — fontes + pesos + tracking + scale
   - **Component Stylings** — botões, modais, cards (se mencionados)
   - **Layout Principles** — spacing, hierarquia, grid

5. **Antes de aplicar** ao chatPro:

   ⚠️ **Verificar conflitos com governanças locais** (sempre rode esta etapa):
   - `CLAUDE.md` marca identidade chatPro (`#25D066` verde + Paytone One) como **OBRIGATÓRIO**
   - Constituição chatpro-microcopy define intent tokens semânticos da marca
   - Aplicação total da paleta de outra marca **viola** essas regras

   **Caminhos válidos:**
   - **Hybrid** — extrai patterns estruturais (typography scale, spacing, focus rings, signature moves) preservando a paleta chatPro. Recomendado por default.
   - **Brand replacement** — só com aprovação explícita do usuário E atualização precondicional do `CLAUDE.md`.

6. Apresente plano de aplicação e **aguarde aprovação** antes de tocar código (a não ser que o usuário tenha autorizado expansão direta no comando).
