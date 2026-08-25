# `.env` da hospedagem — o que mandar

**Como usar:** preencha os valores e mande **por canal privado** para quem
administra a VM. Não commite este arquivo preenchido, não mande em grupo.

O app lê 39 variáveis, mas só uma (`PORT`) é obrigatória no schema. Isso é
justamente o risco que eles apontaram: **o serviço sobe sem as outras e falha só
no caminho que usa cada uma** — o sintoma aparece dias depois, num convite que
não saiu. Por isso a lista abaixo separa por consequência, não por nome.

---

## Já preenchidas por eles — só confira se batem

```env
PORT=3100
HOST=127.0.0.1
DATABASE_PATH=/opt/extensao/data/app.db
PAINEL_API_URL=http://127.0.0.1:3000
GRAVACAO_PELO_PAINEL=true
```

Todas conferidas contra o código: os nomes existem, e o `http://127.0.0.1:3000`
passa na validação de protocolo (host local é exceção à exigência de HTTPS).

---

## ESSENCIAIS — sem estas, o botão não marca reunião

```env
# Painel. São dois tokens diferentes; trocar um pelo outro devolve 401.
PAINEL_EXT_AGENDA_TOKEN=
PAINEL_RETAGUARDA_TOKEN=

# Autentica a extensão contra este app. Mínimo 16 caracteres.
# Vazio = o app fica aberto a quem alcançar a porta.
PANEL_TOKEN=

# chatPro Chat — é por aqui que a mensagem chega ao cliente.
# Sem isto a reunião é criada no painel e o cliente não recebe nada.
CHATPRO_INSTANCE_TOKEN=
CHATPRO_INSTANCE_ID=
CHATPRO_USER_ID=
CHATPRO_PROVIDER=whatsapp
```

**Rotacione os dois tokens do painel antes de enviar** — os valores atuais
passaram por uma conversa com IA e devem ser considerados queimados.

---

## NÃO precisa mandar — são do fluxo antigo

Quem grava e transcreve agora é o painel (`GRAVACAO_PELO_PAINEL=true`). Estas
não são lidas em nenhum caminho que a extensão exercita hoje:

- `RECALL_*` — o bot de gravação. Desligado de propósito: nosso lado e o painel
  ligados poriam dois robôs na mesma sala e dobrariam o custo por hora.
- `STT_*` — transcrição local (Whisper). O instalador nem baixa mais os pacotes.
- `VOREO_*`, `AUTO_SEND_VOREO` — a entrega antiga da transcrição.
- `PUBSUB_*`, `CAPTURE_RETENTION_DAYS` — captura de áudio e Workspace Events.
- `RESUMO_*`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` — resumo por IA de
  transcrição, que agora é do painel.

Mandar em branco é mais seguro do que mandar valor velho: valor velho pode
reativar um caminho que ninguém quer no ar.

---

## Opcionais — decida se quer

```env
# Plano B: se o painel devolver 5xx, a reunião é criada pelo Google Calendar
# em vez de falhar. Sem estas, o plano B simplesmente não existe e o atendente
# vê o erro do painel.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TOKEN_ENCRYPTION_KEY=
```

O plano B exige um fluxo OAuth pelo navegador, que numa máquina sem terminal é
incômodo. **Sugestão: subir sem ele.** Se o painel cair, o atendente marca pelo
painel mesmo — que é onde ele já cairia de volta.

---

## Depois de enviar

Eles instalam e sobem a **tag `v3.7.0`**, já publicada no GitHub. A partir daí a
publicação é sua: `ssh extapp@<ip> v3.7.0`.

Peça o **IP da VM** — sem ele o comando não tem para onde ir.
