# Collection do Postman — Agendamento

Três arquivos nesta pasta:

| Arquivo | O que é |
|---|---|
| `painel-agendamento.postman_collection.json` | A collection: 23 requests em 4 pastas |
| `painel-local.postman_environment.json` | Environment apontando para `localhost:3000` |
| `painel-producao.postman_environment.json` | Environment apontando para produção |

---

## Passo 1 — Importar

No Postman: **Import** → arraste os **três** arquivos de uma vez → **Import**.

Aparecem uma collection ("Painel Implantação & CS — Agendamento") e dois
environments.

## Passo 2 — Escolher o ambiente

Canto superior direito, no seletor: **Painel — LOCAL**.

> Comece pelo local. Os endpoints criam reunião **de verdade**: geram link do
> Meet, mandam e-mail para o cliente, avisam o responsável no Slack e ocupam
> agenda. Produção só quando o fluxo já estiver claro.

## Passo 3 — Preencher os segredos

Clique no nome do environment → aba **Environments** → preencha:

| Variável | Onde encontrar |
|---|---|
| `extAgendaToken` | `EXT_AGENDA_TOKEN` no `.env.local` do painel |
| `retaguardaToken` | `RETAGUARDA_INBOUND_TOKEN` no `.env.local` (só para a pasta 2) |
| `actorEmail` | e-mail de um usuário **real e ativo** do painel |
| `vendedorEmail` | e-mail de um vendedor ativo (o request `GET vendedores` preenche sozinho) |

**Não commite os tokens.** Os arquivos deste diretório vão para o git com os
campos de segredo **vazios**; mantenha assim.

### Sobre o `actorEmail`

É a variável que mais muda o resultado. Ela diz **em nome de quem** a extensão
está agendando, e o **papel** dessa pessoa decide o que a API permite:

| Papel do `actorEmail` | Apresentação | Implantação / CS / Migração |
|---|---|---|
| `vendedor` | marca para si | cai na distribuição |
| `implantador` | 403 | marca para si |
| `cs` / `n2` | 403 | marca para si |
| `supervisor` | escolhe ou distribui | escolhe ou distribui |

Se algo der 403 e você não entender por quê, rode o request **`GET me`**: ele
responde exatamente o que aquele usuário pode fazer.

## Passo 4 — Rodar a pasta "0. Comece por aqui"

Três requests, de cima para baixo:

1. **O painel está no ar?** — prova que `baseUrl` está certo
2. **Meu token vale? Quem eu sou?** — prova o token e mostra suas permissões
3. **Tem horário livre amanhã?** — prova a grade, e já guarda o primeiro horário livre em `{{hora}}`

Passaram os três? O resto da collection funciona.

---

## O que a collection faz sozinha

- **`{{dataUtil}}`** — recalculado a cada request: o próximo dia útil, pulando
  sábado e domingo. Você nunca digita data.
- **`{{dataOntem}}`** — para o exemplo de registro retroativo.
- **`{{meetingId}}`** — preenchido automaticamente pelo último `POST /meetings`
  que deu 201. Por isso o request de transcrição já aponta para a reunião que
  você acabou de criar, sem copiar id à mão.
- **`{{hora}}`** — atualizado com o primeiro horário livre quando você consulta
  a grade.
- **Console** — cada request escreve em português o que aconteceu. Abra com
  `Ctrl+Alt+C` (ou **View → Show Postman Console**) e deixe aberto.

## Ordem sugerida para conhecer o fluxo inteiro

```
0. Comece por aqui          (os três)
2. GET vendedores           → preenche vendedorEmail
2. POST migracao/link       → cria o checklist que a migração exige
1. GET available-slots      → vê os horários
1. POST meetings            → cria a reunião (guarda o meetingId)
1. POST transcript          → manda o texto da reunião
3. Erros de propósito       → entende cada código de erro antes de encontrá-lo
```

## Dicas para não incomodar ninguém no teste

- `"skip_email": true` em todo corpo de teste (já está nos exemplos).
- Deixe `clienteEmail` vazio.
- Nomeie os clientes com `(TESTE)` — os exemplos já fazem isso — para achar e
  apagar depois.
- Evite horário comercial cheio: a reunião aparece na agenda de alguém de verdade.

## Referência completa

O contrato campo a campo está em [`../api-extensao-agenda.md`](../api-extensao-agenda.md)
(extensão) e [`../api-retaguarda-inbound.md`](../api-retaguarda-inbound.md) (CRM).
As descrições dentro de cada request da collection são um resumo mastigado
desses dois documentos.
