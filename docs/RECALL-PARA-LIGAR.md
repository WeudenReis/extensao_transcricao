# Recall — o que entregar pro painel ligar a gravação

**Data:** 30/08/2026 · O painel pediu as credenciais do Recall. O lado deles
está **implementado e desligado** (doc `recall-gravacao.md`); falta o que só
você, dono da conta Recall, consegue fazer. São cliques de dashboard — nada de
código, e **nada muda no nosso servidor** (ele está com `GRAVACAO_PELO_PAINEL=true`
e não usa o Recall pra nada).

O dev precisa de **dois valores**, e os dois nascem no dashboard do Recall:

---

## Passo 1 — Trocar a chave da API (não pule)

A chave antiga (começa com `6c04bc69`) passou por uma conversa com IA em agosto
e deve ser considerada queimada. Como ninguém a usa hoje, trocar não quebra nada.

1. Abra: **https://us-west-2.recall.ai/dashboard/developers/api-keys**
   (atenção à região: é `us-west-2`. Na região errada tudo dá 401, que parece
   "chave errada" — já perdemos tempo com isso.)
2. Crie uma chave nova.
3. **Apague a antiga.**
4. Guarde a nova — é o primeiro valor pro dev (`RECALL_API_KEY`).

## Passo 2 — Cadastrar o webhook do painel

1. No mesmo dashboard, seção **Webhooks**.
2. Adicione o endpoint (a URL é do doc do próprio dev):
   ```
   https://painel-reunioes.chatpro.com.br/api/webhooks/recall
   ```
3. Marque os eventos de **bot** e de **transcrição**. O doc dele não lista os
   nomes exatos que o endpoint consome — na dúvida, pergunte a ele quais marcar
   ou marque todos os `bot.*` e `transcript.*`.
4. Copie o segredo de assinatura (`whsec_...`) — é o segundo valor
   (`RECALL_WEBHOOK_SECRET`). O dev já disse: vai direto pro `.env.production`
   da VM, **não passa pelo nosso servidor**.

## Passo 3 — Mandar pro dev, por canal privado

> Segue o que faltava pra ligar a gravação:
>
> RECALL_API_KEY=<a chave nova do passo 1>
> RECALL_WEBHOOK_SECRET=<o whsec do passo 2>
>
> O endpoint já está cadastrado no dashboard do Recall apontando pro
> /api/webhooks/recall de vocês. Lembra de liberar o caminho no Cloudflare,
> como você anotou — senão a Svix leva challenge e desativa o endpoint em
> 5 dias.

---

## Duas decisões que são suas, não do dev

**1. Quais tipos de reunião gravar.** O painel tem seleção por tipo em
`/settings > Gravação` justamente pra reunião interna e evento não engordarem a
conta. Decida os tipos antes de ele ligar o switch.

**2. O custo — com o número corrigido pelo dev.** Ele registrou **422 reuniões
realizadas em julho**, não as ~330 da nossa estimativa. A US$ 0,65/h com
reunião de 1h:

| Cenário | Conta mensal |
|---|---|
| Pay-as-you-go (US$ 0,65/h) | **~US$ 274/mês** |
| Programa de startup (US$ 0,25/h nas primeiras 10.000h) | **~US$ 105/mês** |

O próprio dev sugeriu: **peça o programa de startup ANTES de liberar pro time**
(formulário no site do Recall). Não gravar reunião interna derruba mais ainda.

---

## O que o dev faz depois que receber (lado dele, só pra referência)

Migration da gravação, os dois valores no `.env.production`, liberar o caminho
no Cloudflare, ligar o timer `chatpro-recall.timer` e configurar
`/settings > Gravação`. Está tudo na seção "O que falta para ligar" do doc dele.
