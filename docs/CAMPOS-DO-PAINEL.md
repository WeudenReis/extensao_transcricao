# Campos aceitos por `POST /api/ext/agenda/meetings`

> Mapeado em 14/08/2026 contra a API de produção, por tentativa e erro.
> Revisado em **21/08/2026**, depois da correção do 500 no painel.
>
> O schema é **estrito**: um campo desconhecido derruba o pedido inteiro.
>
> **Como ler a resposta** (a regra mudou — o painel passou a preencher o
> `details` para erro de valor, e isso separa os dois casos):
>
> | Resposta | O que significa |
> |---|---|
> | `201` | o campo existe e foi aceito — **e criou reunião de verdade** |
> | `422` com `details: { "campo": [...] }` | o campo existe; o **valor** está errado |
> | `422` com `details: {}` vazio | tem **chave desconhecida** no corpo |
>
> Cuidado ao sondar: um payload com erro de valor de propósito (hora `99:99`,
> por exemplo) **mascara** a chave desconhecida — o `details` volta preenchido
> só com o erro de valor, e a chave inválida passa despercebida. Pra testar se
> um campo existe, o resto do payload precisa estar **válido**.

## Aceitos

| Campo | Quando | Observação |
|---|---|---|
| `type` | sempre | `implantacao` · `cs` · `migracao` · `apresentacao` |
| `actor_email` | sempre | quem está marcando |
| `client_name` | sempre | |
| `company_name` | sempre | |
| `phone` | sempre | aceita máscara |
| `client_type` | sempre | `base` · `prospect` |
| `scheduled_date` | sempre | `YYYY-MM-DD`, horário local BR |
| `scheduled_time` | sempre | `HH:MM` |
| `provedor` | **cs, implantação** | `starter` · `cloud_api` · `api_disparos` |
| `cs_reason` | **cs** | `treinamento_ia` · `treinamento_chat` · `treinamento_oficial` · `retencao` · `duvidas` |
| `cs_plan` | opcional | |
| `cnpj` | **migração** | |
| `instance_code` | **migração** | |
| `vendedor_email` | **migração** | dono da venda |
| `assignee_email` | só supervisor | 403 para os demais papéis |
| `client_email` | opcional | sem ele não sai e-mail nem `.ics` |
| `skip_email` | opcional | é o "Não enviar email" da tela do painel |

## Recusados (não existem no schema)

| Campo tentado | O que era na tela do painel |
|---|---|
| `cc_emails`, `cc_email`, `email_cc` | "Adicionar email em cópia (CC)" |
| `observacoes`, `notes` | "Observações (opcional)" da Verificação |

## Tipo `verificacao` não existe

```
GET /api/ext/agenda/available-slots?type=verificacao
→ 422 "Parâmetro 'type' deve ser um de: implantacao, cs, migracao, apresentacao."
```

O `/me` também não lista `verificacao` nas `capabilities`, e o
`POST /api/retaguarda/meetings` recusa igual.

A tela "Nova Verificação" existe no painel, então o tipo existe no produto —
só **não está exposto na API de extensão**. Enquanto não estiver, a extensão
não tem como marcar verificação.

## O que a extensão precisa de vocês

1. **Destravar o 500** do `POST /meetings` (ver `BUG-PAINEL-500.md`) — sem isso
   nenhuma reunião é criada por aqui.
2. **Expor `verificacao`** no `/me`, no `available-slots` e no `POST`, com a
   lista de campos que ela exige.
3. **CC e Observações**, se fizerem parte do fluxo — hoje a API não os aceita.
4. Um detalhe menor: o `422` de campo desconhecido vem com `details: {}`
   vazio. Dizer qual campo sobrou economizaria bastante tentativa e erro.

## Enums (confirmados em 21/08/2026 pelo `details` do 422)

O painel devolve as opções válidas na própria mensagem de erro:

| Campo | Valores aceitos |
|---|---|
| `client_type` | `base`, `prospect` |
| `provedor` | `starter`, `cloud_api`, `api_disparos` |

Tudo minúsculo. `"Starter"` com maiúscula e `"novo"` são recusados.

## Ainda fora do schema (reconfirmado em 21/08/2026)

`observacoes`, `notes`, `cc_emails`, `cc_email` e o tipo `verificacao`.
Cada um responde `422` com `details` vazio, em payload válido no resto.
