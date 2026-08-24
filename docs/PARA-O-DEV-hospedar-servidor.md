# Hospedar o servidor da extensão

**Data:** 24/08/2026 · **Pedido:** um lugar com HTTPS público para um app Node

## Por que

Hoje cada atendente instala um servidor Node na própria máquina, e recebe um
`.env` com os tokens do painel dentro. São dez pessoas com o token de produção
no computador, e dez instalações para manter.

Com o servidor hospedado **uma vez**, o atendente só carrega a pasta da extensão
no Chrome. Nada de Node, nada de instalador, nenhum token fora do servidor.

## O que é o app

Um Express em Node 20, sem banco externo — usa SQLite em arquivo local. Cinco
dependências de produção (`express`, `zod`, `better-sqlite3`, `dotenv`,
`google-auth-library`). Repositório:

https://github.com/WeudenReis/extensao_transcricao — pasta `server/`

```bash
cd server
npm install --omit=optional
npm run build
node dist/index.js          # sobe na porta do PORT
```

## O que ele faz

```
Extensão no Chrome
      │
      ▼
  ESTE APP  ──────►  painel-reunioes.chatpro.com.br   (cria a reunião)
      │
      └──────────►  sparks.chatpro.com.br             (manda a mensagem ao cliente)
```

Além de repassar as chamadas, ele guarda a fila dos convites agendados: reunião
marcada para amanhã tem a mensagem enviada ~5 min antes do horário, não na hora
de marcar. Isso precisa de um processo vivo naquele momento — é a parte que a
extensão não consegue fazer sozinha, porque o Chrome pode estar fechado.

## O que eu preciso

**Uma URL HTTPS pública** apontando para esse app. Tanto faz o formato:

- `https://reunioes-ext.chatpro.com.br` (subdomínio), ou
- `https://painel-reunioes.chatpro.com.br/ext/` (prefixo de caminho no domínio
  que já existe, se for mais fácil que criar DNS)

Assim que existir, eu ponho a URL no `host_permissions` do manifest e publico a
versão da extensão que não precisa de instalação nenhuma.

**Importante:** o Chrome bloqueia chamada para qualquer host que não esteja no
manifest. Por isso a URL precisa estar decidida *antes* — não dá para deixar
configurável pelo atendente.

## Variáveis de ambiente

O app lê um `.env`. As que importam para este fluxo:

| Variável | O que é |
|---|---|
| `PORT` | porta do Express |
| `DATABASE_PATH` | caminho do arquivo SQLite (precisa de disco gravável) |
| `PAINEL_API_URL` | `https://painel-reunioes.chatpro.com.br` |
| `PAINEL_EXT_AGENDA_TOKEN` | token de `/api/ext/agenda/*` |
| `PAINEL_RETAGUARDA_TOKEN` | token de `/api/retaguarda/*` |
| `CHATPRO_*` | credenciais do chatPro Chat, para enviar a mensagem |
| `PANEL_TOKEN` | segredo que autentica a extensão contra este app |
| `GRAVACAO_PELO_PAINEL` | `true` — quem grava é o painel, não este app |

Eu passo os valores por canal privado. O `server/.env.example` tem a lista
completa comentada.

## Recursos

Modesto: dezenas de requisições por dia, uma por reunião marcada. O que ele
precisa mesmo é **ficar de pé**, por causa da fila de convites — se cair, um
convite agendado não sai. O app tem `/api/health` para o healthcheck.
