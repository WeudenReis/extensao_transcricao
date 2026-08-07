# Setup do Recall.ai (o que só você pode fazer)

> O código já está pronto. Aqui estão os passos que dependem de conta/painel.
> Região do nosso workspace: **us-west-2** (pay-as-you-go).

## 1. Chave de API ✅ (validada)

A chave que você me passou foi testada contra a API real: criou um bot
(HTTP 201) e o removeu (HTTP 200). Ela vai no `server/.env`:

```
RECALL_API_KEY=cole-aqui-a-chave-do-dashboard
RECALL_REGION=us-west-2
```

> ⚠️ **Rotacione essa chave.** Ela foi colada no chat, então precisa ser
> considerada exposta. No dashboard do Recall: gere uma nova, coloque no `.env`
> e revogue a antiga. A chave dá acesso a gravar e ler transcrições de
> reuniões — não pode ir para o Git nem para o pacote de distribuição
> (o `.gitignore` já bloqueia o `.env`).

## 2. Deixar o backend acessível por HTTPS

O Recall.ai precisa alcançar o seu servidor para entregar os webhooks. Em
desenvolvimento, use um túnel:

```
cloudflared tunnel --url http://localhost:3333
```

Copie a URL gerada (`https://algo.trycloudflare.com`) e coloque no `.env`:

```
PUBLIC_BASE_URL=https://algo.trycloudflare.com
```

> A URL do túnel muda a cada reinício. Em produção, use um domínio fixo.

## 3. Criar o segredo de webhook (obrigatório)

Sem isso o Recall **não envia** os headers de assinatura, e o nosso endpoint
recusa tudo com 403 (proteção contra alguém injetar transcrição falsa).

1. Dashboard do Recall (região us-west-2) → **Webhooks**
2. Crie o **workspace signing secret** — ele começa com `whsec_`
3. No `.env`:
   ```
   RECALL_WEBHOOK_SECRET=whsec_...
   ```

## 4. Cadastrar o endpoint e assinar os eventos

No mesmo painel, adicione o endpoint:

```
{PUBLIC_BASE_URL}/webhooks/recall
```

E **marque estes eventos** (é preciso assinar um a um):

**Estado do bot**
- `bot.joining_call`
- `bot.in_waiting_room`
- `bot.in_call_recording`
- `bot.call_ended`
- `bot.done`
- `bot.fatal`

**Transcrição**
- `transcript.done` ← é este que dispara a entrega
- `transcript.failed`

## 5. Testar

Com o backend rodando:

```
curl -X POST http://localhost:3333/api/meetings ^
  -H "Content-Type: application/json" ^
  -d "{\"meetingUrl\":\"https://meet.google.com/abc-defg-hij\"}"
```

O bot deve aparecer na reunião em segundos.

⚠️ **Alguém precisa admitir o bot** na sala de espera (ele entra como convidado
anônimo). Isso é esperado. Para evitar, é preciso configurar um **bot
autenticado** com uma conta Google dedicada — fica para depois.

Acompanhe em `http://localhost:3333` (aba de reuniões).

## 6. Entrega ao chatPro

Quando você tiver o contrato da API do chatPro:

```
CHATPRO_API_URL=https://.../endpoint
CHATPRO_API_KEY=...
AUTO_SEND_CHATPRO=true     # deixe vazio pra revisar antes de enviar
```

Sem `CHATPRO_API_URL`, a transcrição fica marcada como `skipped-no-url` e
aguarda no painel — nada se perde.

## Custo

O Recall.ai cobra por **hora de gravação**. Confira o preço no painel antes de
usar em volume — cada bot em reunião conta.
