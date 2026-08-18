# API de agendamento para a extensão

Como uma extensão de navegador marca reunião no Painel de Implantação & CS e
devolve a transcrição quando a reunião termina.

Base: `https://<painel>/api/ext/agenda`

---

## 1. Visão geral

Quatro rotas:

| Rota | Para quê |
|---|---|
| `GET /me` | Quem o painel entende que está usando a extensão e o que esse papel pode agendar |
| `GET /available-slots` | Horários livres de um dia, por tipo |
| `POST /meetings` | Cria a reunião |
| `POST /meetings/<id>/transcript` | Anexa a transcrição depois que a reunião acaba |

O fluxo normal é: `me` uma vez ao abrir → `available-slots` quando o usuário
escolhe um dia → `POST /meetings` → (a reunião acontece) → `POST .../transcript`.

Todas respondem JSON e aceitam preflight `OPTIONS`. Os erros vêm em português no
campo `error`, com o status HTTP correspondente.

---

## 2. Autenticação

Duas formas, e a diferença entre elas é real:

### 2.1. Token compartilhado + `actor_email` (modo inicial)

```
Authorization: Bearer <EXT_AGENDA_TOKEN>
```

…e o e-mail do usuário logado no corpo (ou na query, nos GETs):

```json
{ "actor_email": "fulano@chatpro.com.br", "...": "..." }
```

O painel resolve esse e-mail para um usuário ativo e aplica as permissões dele.
**O e-mail é uma alegação, não uma prova**: quem tiver o token pode agendar em
nome de qualquer pessoa. É aceitável porque o token não sai do service worker da
extensão e toda chamada fica registrada, mas é o motivo de existir a forma 2.2.

E-mail que não resolve para ninguém ativo → **422**.

### 2.2. Token pessoal (recomendado quando der)

```
Authorization: Bearer cpx_<prefixo>_<segredo>
```

Gerado por cada pessoa em **Perfil → Extensão de navegador** no painel. É único
por usuário, revogável individualmente e morre junto com o desligamento dela.
Quando vem um desses, `actor_email` é **ignorado** — a identidade vem do token.

A resposta de toda rota traz `identity_source` (`"token"` ou `"email"`) dizendo
por qual caminho a chamada entrou.

### Erros de autenticação

| Status | Quando |
|---|---|
| 401 | Token ausente ou inválido |
| 422 | `actor_email` ausente ou não corresponde a usuário ativo |
| 503 | `EXT_AGENDA_TOKEN` não configurado no servidor |

---

## 3. Quem pode agendar o quê

A régua é a mesma da tela do painel:

| Papel | Apresentação | Implantação / CS / Migração |
|---|---|---|
| `vendedor` | marca **para si** | entra na **distribuição** (round-robin) |
| `implantador` | — | marca **para si** |
| `cs` / `n2` | — | marca **para si** |
| `supervisor` | escolhe o vendedor ou deixa distribuir | escolhe o responsável ou deixa distribuir |
| `suporte`, `marketing`, `financeiro` | — | — |

Cruzamento de papel segue as flags do painel: um CS só pega implantação se tiver
`can_receive_implantacao`; um implantador só pega CS com `can_receive_cs`.

**Só supervisor manda `assignee_email`.** Para qualquer outro papel isso é
**403**, e não um silencioso "caiu na distribuição" — o usuário precisa saber que
o pedido dele não foi atendido.

Consulte tudo isso em `GET /me` em vez de deduzir pelo papel: a resposta já traz
`assignment` (`self` | `round_robin` | `explicit`) por tipo, que é o que muda o
texto do botão ("Marcar para mim" x "Marcar").

---

## 4. `GET /me`

```
GET /api/ext/agenda/me?actor_email=fulano@chatpro.com.br
Authorization: Bearer <token>
```

```json
{
  "actor": { "id": "uuid", "name": "Fulano", "email": "fulano@chatpro.com.br", "role": "vendedor" },
  "identity_source": "email",
  "capabilities": [
    { "type": "apresentacao", "allowed": true,  "assignment": "self",        "can_choose_assignee": false, "reason": null },
    { "type": "implantacao",  "allowed": true,  "assignment": "round_robin", "can_choose_assignee": false, "reason": null },
    { "type": "cs",           "allowed": true,  "assignment": "round_robin", "can_choose_assignee": false, "reason": null },
    { "type": "migracao",     "allowed": true,  "assignment": "round_robin", "can_choose_assignee": false, "reason": null }
  ]
}
```

---

## 5. `GET /available-slots`

```
GET /api/ext/agenda/available-slots?type=apresentacao&date=2026-08-20&actor_email=...
```

| Parâmetro | Obrigatório | Valores |
|---|---|---|
| `type` | sim | `apresentacao` · `implantacao` · `cs` · `migracao` |
| `date` | sim | `YYYY-MM-DD` |
| `client_type` | só em `migracao` | `base` · `prospect` |
| `actor_email` | no modo 2.1 | e-mail do usuário |

```json
{
  "type": "apresentacao",
  "date": "2026-08-20",
  "client_type": null,
  "available_slots": ["09:00", "10:00", "11:00", "14:00"],
  "blocked_slots": ["15:00"],
  "max_date": "2026-11-12"
}
```

`max_date` é o horizonte que o `POST` aceita — não ofereça calendário além dele.

A grade de **apresentação** sai da agenda dos vendedores com folga de 1h por
vendedor; a dos demais tipos, do pool de condutores disponíveis. Fim de semana e
feriado voltam vazios.

> A grade é uma **fotografia**. Entre a consulta e o POST alguém pode ocupar o
> horário — por isso o POST pode responder 409 num horário que veio nesta lista.
> Trate o 409 recarregando a grade, não como erro fatal.

---

## 6. `POST /meetings`

Data e hora vão **locais (BR)**, separadas. O servidor deriva o instante em UTC.

### Campos comuns a todos os tipos

| Campo | Obrigatório | Observação |
|---|---|---|
| `type` | sim | `apresentacao` · `implantacao` · `cs` · `migracao` |
| `actor_email` | no modo 2.1 | quem está agendando |
| `client_name` | sim | |
| `company_name` | sim | |
| `phone` | sim | aceita máscara; validado por DDD + número |
| `client_type` | sim | `base` · `prospect` (ignorado em apresentação, que é sempre `prospect`) |
| `scheduled_date` | sim | `YYYY-MM-DD` |
| `scheduled_time` | sim | `HH:MM` 24h |
| `client_email` | não | sem ele não sai e-mail de confirmação nem convite `.ics` |
| `vendedor_email` | não (sim em migração) | dono da venda |
| `assignee_email` | não | **só supervisor** |
| `skip_email` | não | `true` não envia confirmação ao cliente |
| `chatpro_session_id` | não | conversa do chatPro de onde a reunião foi marcada — ver abaixo |
| `transcript` | não | ver §7 |
| `transcript_language` | não | `pt-BR` |

> **`chatpro_session_id` amarra a reunião ao atendimento.** É o `<uuid>` que
> aparece na URL `/chat/<uuid>` do chatPro. Sem ele o painel só conhece essa
> ligação quando alguém dispara um template pela tela — o que não acontece na
> maioria das conversas —, e o resumo da reunião não tem para onde voltar
> quando a transcrição fica pronta. Mande sempre que a extensão souber qual
> conversa está aberta.
>
> Valor malformado é **ignorado**, nunca recusado: id de conversa é metadado
> dentro do corpo de um agendamento, e não pode custar a reunião.

### Por tipo

- **`apresentacao`** — `cnpj` e `instance_code` opcionais.
- **`implantacao`** — `provedor` (`starter` · `cloud_api` · `api_disparos`)
  obrigatório; `cnpj`, `instance_code`, `test_status` opcionais.
- **`cs`** — `provedor` e `cs_reason` obrigatórios; `cs_plan` opcional.
- **`migracao`** — `cnpj`, `instance_code` e `vendedor_email` obrigatórios;
  `oficial_plan` e `migration_intake_id` opcionais.

> **Migração exige checklist de onboarding ativo** para o CNPJ. Sem ele a
> resposta é **422** pedindo que o link seja gerado antes. Não é validação
> burocrática: o checklist é o que o implantador lê para conduzir a migração.

### Exemplo

```bash
curl -X POST https://<painel>/api/ext/agenda/meetings \
  -H "Authorization: Bearer $EXT_AGENDA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "apresentacao",
    "actor_email": "vendedor@chatpro.com.br",
    "client_name": "João Silva",
    "company_name": "Silva Comércio",
    "phone": "(11) 99999-9999",
    "client_type": "prospect",
    "scheduled_date": "2026-08-20",
    "scheduled_time": "14:00",
    "client_email": "joao@silva.com.br"
  }'
```

### Resposta (201)

```json
{
  "id": "uuid-da-reuniao",
  "type": "apresentacao",
  "scheduled_at": "2026-08-20T17:00:00.000Z",
  "scheduled_date": "2026-08-20",
  "scheduled_time": "14:00",
  "client_name": "João Silva",
  "responsavel": { "id": "uuid", "name": "Vendedor", "role": "vendedor" },
  "vendedor": { "id": "uuid", "name": "Vendedor" },
  "meet_link": "https://meet.google.com/xxx-yyyy-zzz",
  "migration_intake_id": null,
  "chatpro_session_id": null,
  "assignment_mode": "self",
  "identity_source": "email",
  "transcript_saved": false
}
```

Guarde o `id`: é ele que identifica a reunião na hora de mandar a transcrição.

### Erros

| Status | Motivo |
|---|---|
| 400 | JSON malformado |
| 401 / 503 | ver §2 |
| 403 | papel não pode criar esse tipo, ou tentou escolher responsável sem ser supervisor |
| 409 | ninguém disponível no horário · horário bloqueado na agenda · slot ocupado agora mesmo · apresentação a menos de 1h de outra do mesmo vendedor |
| 422 | payload inválido · horário no passado sem direito a registro retroativo · vendedor/responsável inexistente · migração sem checklist ativo |

O que acontece depois da criação (link do Meet, e-mail com `.ics`, evento na
agenda do vendedor, aviso no Slack para o responsável) é **best-effort**: nada
disso derruba a reunião nem muda o 201. Um e-mail que falhou não é motivo para
reenviar o POST — isso criaria uma reunião duplicada.

---

## 7. Transcrição

### Depois da reunião (caminho normal)

```bash
curl -X POST https://<painel>/api/ext/agenda/meetings/<id>/transcript \
  -H "Authorization: Bearer $EXT_AGENDA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "actor_email": "vendedor@chatpro.com.br",
    "text": "Vendedor: bom dia, tudo bem?\n\nCliente: tudo ótimo...",
    "language_code": "pt-BR",
    "started_at": "2026-08-20T17:00:00-03:00",
    "ended_at": "2026-08-20T17:48:00-03:00"
  }'
```

- **Formato do `text`**: texto corrido, até 500 mil caracteres. Se você souber
  quem falou, mande no formato `Falante: fala`, com **linha em branco entre as
  falas** — nesse formato o painel extrai participação por falante e destaca
  menções a preço, risco, concorrência e próximos passos. Sem isso o texto ainda
  é guardado e pesquisável, só sem a separação por participante.
- **Reenviar substitui.** Uma transcrição de integração por reunião: se a
  primeira tentativa falhou no meio, é só repetir.
- **Quem pode**: supervisor, ou quem é parte da reunião (responsável ou
  vendedor). Qualquer outro → 403.

Resposta 201:

```json
{
  "meeting_id": "uuid",
  "client_name": "João Silva",
  "transcript_name": "api/uuid",
  "chars": 18422,
  "origin": "api"
}
```

### Junto da criação (só registro retroativo)

`POST /meetings` aceita `transcript` no corpo, mas isso só faz sentido quando a
reunião **já aconteceu** e está sendo lançada agora — no fluxo normal ela ainda
vai acontecer e não há texto nenhum. O campo `transcript_saved` na resposta diz
se o texto foi salvo; se vier `false`, mande de novo pelo endpoint de
transcrição.

O mesmo par `transcript` / `transcript_language` também existe em
`POST /api/retaguarda/meetings` (a API server-to-server do CRM).

### Onde isso aparece

Na aba **Transcrição** da reunião no painel, com busca, copiar e baixar, marcada
como "Enviada pela integração" para não se confundir com a transcrição nativa do
Google Meet.

---

## 8. Registro retroativo

Horário no passado é aceito quando a pessoa tem direito a ele: **supervisor**
sempre, e **condutor** na própria reunião. Vendedor não registra implantação/CS/
migração no passado, e reunião que caiu na distribuição também não — sortear
responsável para algo que já aconteceu atribuiria a alguém que não estava lá.

---

## 9. Configuração

No servidor do painel:

```env
EXT_AGENDA_TOKEN=            # 32+ bytes — openssl rand -base64 32
EXTENSION_ALLOWED_ORIGINS=   # opcional: CSV de origens. Vazio = qualquer chrome-extension://
```

Sem `EXT_AGENDA_TOKEN` o modo compartilhado responde **503** (fail-closed); o
token pessoal continua funcionando, porque não depende dessa variável. O CORS é
defesa em profundidade: a barreira real
é o token, e as chamadas devem sair do **service worker** da extensão, nunca do
content script (desde o Chrome 85 o `fetch` de content script conta como
requisição da página e cai em CORS).

Toda chamada fica registrada em `ext_agenda_audit` — endpoint, resultado, quem
alegou ser quem, por qual caminho de identidade, IP e reunião criada.
