# Backup de contexto — troca de conta do Claude (15/09/2026)

Na conta nova, abra este projeto e peça: **"leia o CLAUDE.md e o
docs/BACKUP-CONTEXTO-CLAUDE.md antes de qualquer coisa"**.

Este repositório é **PÚBLICO**. Por isso não há aqui nenhuma credencial, IP de
servidor ou id de instância. Tudo isso fica em `server/.env`, no PC, fora do Git.

## Onde está tudo

| O quê | Onde |
|---|---|
| Código | branch `main`; `recall-ai` é espelho: `git branch -f recall-ai main && git push origin recall-ai` |
| Versão atual | **v3.21.0** (tag), 586 testes verdes |
| Servidor hospedado | https://painel-reunioes.chatpro.com.br/extensao/ |
| Publicar no servidor | push da tag `vX.Y.Z`, depois `ssh extapp@<ip-da-VM> vX.Y.Z` (IP fora do repositório) |
| Mapa dos arquivos | `docs/MAPA.md` (`node scripts/gerar-mapa.mjs`) |
| Ligações do código | `node scripts/grafo.mjs explain X` (regras em `.claude/skills/grafo`) |
| API do painel | `docs/CAMPOS-DO-PAINEL.md`, ler ANTES de sondar |
| Pedidos ao dev do painel | `docs/PARA-O-DEV-*.md` |

## O que já funciona

- **Aba "Reunião" dentro do chatPro**, no layout do Copiloto. Usa o design
  system do próprio chatPro e não tem estilo próprio.
- **Marcar reunião:**
  - Agora ou Agendar, com tipo, atendente, distribuição e palavras-chave.
  - Campos obrigatórios com caixa vermelha. O contato da conversa preenche
    sozinho, e o CNPJ vem antes da razão social.
- **Agenda:** calendário mensal, vista Semana e a agenda do PAINEL, com marcação
  em volta dos horários.
- **Mensagem ao cliente:** o resumo vira a mensagem, e há a opção de não enviar
  nada. Busca de histórico por cliente e últimas reuniões.
- **Onboarding:** plano Oficial na migração e gerar o link de onboarding pela aba.
- **v3.21.0:**
  - comentário interno na conversa ao marcar;
  - lembrete do atendente pela fila `envios_agendados`, com `so_comentario`;
  - cadastro reaproveitado pelo CNPJ;
  - aviso de convite que não chegou.
- **Servidor:**
  - `GET /api/painel/prontidao` diz o que falta pra operar;
  - roda atrás do proxy do painel;
  - `scripts/empacotar.ps1 -Producao` gera a extensão já configurada.
- **Gravação:** é do PAINEL, não nossa (`GRAVACAO_PELO_PAINEL=true`). O Recall.ai
  está parqueado.

## Pendências

As pendências que valem são as desta página. O `PENDENCIAS.md` da raiz é de
05/08/2026 e cobre o caminho antigo (Google Meet API + Voreo), abandonado.

**Com você:**
1. Pegar com o dev o `PANEL_TOKEN` do servidor hospedado.
2. Confirmar que as credenciais `CHATPRO_*` foram pro servidor hospedado.
3. Depois dos dois: apontar o `backendUrl` pra
   `https://painel-reunioes.chatpro.com.br/extensao`, gerar o pacote com
   `-Producao` e distribuir. **O zip de produção carrega credencial:** não vai
   pro Git nem pra lugar público.
4. Recall: antes de religar, rotacionar a chave, que passou pelo chat.

**Com o dev do painel** (`docs/PARA-O-DEV-cancelar-e-fila.md` e
`docs/PARA-O-DEV-listar-reunioes.md`):
- cancelar/reagendar, listar reuniões e migrar a fila de convites pro painel;
- distribuição n2, tipo "Verificação", observações/CC.

Tudo isso depende dele porque a reunião mora no banco do painel, e o nosso token
não tem GET/PATCH/DELETE de reunião (15 caminhos sondados). Existe um paliativo,
**não implementado**: reconsultar `available-slots` antes de mandar o convite.
Ele pega cancelamento, mas não pega reagendamento.

## Regras que o código não mostra

**Segurança e LGPD**
- Nunca logar a transcrição inteira. CNPJ, telefone e razão social aparecem no
  máximo com os 4 últimos dígitos.
- Nunca versionar `.env`, `*.db` ou o zip de produção.
- Nunca mandar header `Authorization` pra host de terceiro.
- **POST no painel cria reunião REAL.**
  - Scripts de investigação só leem.
  - Em teste, use `skip_email: true` e nome com `(TESTE)`.
  - Nunca teste PATCH/DELETE às cegas.
- O segredo de assinatura do Recall nunca é colado no chat.
- Graphify só por `scripts/grafo.mjs` (pasta limpa, sem LLM). Nunca
  `graphify install`, `graphify claude install` nem `/graphify .`.

**Código**
- Nenhuma cor literal em `extension/content`: só os tokens do chatPro
  (`hsl(var(--gray-80))`, `--cpm-evento`), que trocam de tema sozinhos.
- O CSS mora em template literal, e uma crase quebra o arquivo inteiro. Rode
  `node scripts/checar-css.mjs`.
- Campo novo enviado por `pedir()` precisa ser lido no handler do service
  worker. Rode `node scripts/checar-mensagens.mjs`.
- `garantirColuna(...)` só depois do `CREATE TABLE` da tabela, senão centenas de
  testes falham.
- Teste com data "futura" usa 2099. Data próxima vira passado e o teste quebra.
- Sem heredoc de shell pra escrever código com escapes.
- **Express 4** não captura rejeição de handler async; use o `assincrono()`.
- O `express.raw()` do webhook do Recall vem ANTES do `express.json()` global.
- `npx prettier` sem config troca aspas simples por duplas no arquivo inteiro.

**Comunicação**
- Mensagem pronta pra encaminhar nunca afirma como feito um passo que depende de
  ação manual. Use o condicional ou um marcador visível `>>> CONFIRME <<<`.
- Commits em Conventional Commits em português. Nunca `git push --force`.

## Contratos externos (resumo)

- **chatPro Chat** (não é a "chatPro API" de WhatsApp). Contrato completo em
  `docs/INTEGRACAO-CHATPRO.md`:
  - base `https://sparks.chatpro.com.br`, header `instance-token`, corpo em
    camelCase;
  - `POST /messages/addComments` para comentário interno;
  - `POST /messages/sendMessage`: **`provider` é obrigatório**, sem ele dá 400
    e o cliente não recebe nada;
  - `POST /users/getAllInstanceUsers` traz o id do atendente;
  - os webhooks do chatPro não são assinados, então o segredo vai no caminho da
    URL;
  - doc: `https://chatpro.readme.io/llms.txt`.
- **Painel:** `available-slots` devolve `disponiveis` e `bloqueados`. Detalhes em
  `docs/CAMPOS-DO-PAINEL.md`.
- **Recall.ai:**
  - não há plano grátis mensal: 5 h de crédito uma vez só, depois US$ 0,65/h;
  - o programa de startup cai pra US$ 0,25/h;
  - detalhes em `docs/CUSTO-RECALL.md`.
