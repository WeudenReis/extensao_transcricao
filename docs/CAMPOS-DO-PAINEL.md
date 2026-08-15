# Campos aceitos por `POST /api/ext/agenda/meetings`

> Mapeado em 14/08/2026 contra a API de produção, por tentativa e erro.
> O schema é **estrito**: um campo desconhecido derruba o pedido inteiro com
> `422 {"error":"Dados inválidos.","details":{}}` — sem dizer qual campo.
>
> Como ler: enquanto o bug do 500 existir, **`500` = o campo passou pela
> validação** e a requisição morreu depois; **`422` = o campo não existe**.

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
