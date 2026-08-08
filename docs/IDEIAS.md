# Ideias de features

Tudo aqui está ancorado em endpoint que **existe** na documentação do chatPro
Chat ou em dado que **já temos** no banco. Nada é chute sobre o que a API
poderia fazer.

Ordenado por **valor ÷ esforço**. As três primeiras eu faria antes de qualquer
outra coisa.

---

## 🥇 As três que mais mudam o dia a dia

### 1. Resumo no topo, transcrição embaixo

**Problema:** ninguém lê 40 minutos de transcrição. Hoje entregamos o texto
completo — o atendente rola, desiste, e o valor se perde.

**Proposta:** o comentário passa a começar assim:

```
📄 Reunião de 34 min · Maria e João

O QUE FICOU COMBINADO
• Enviar proposta revisada até sexta
• Cliente vai validar com o sócio
• Reunião de fechamento na semana que vem

PONTOS DE ATENÇÃO
• Cliente citou concorrente com preço 20% menor

[transcrição completa nas partes seguintes]
```

**Como:** a transcrição já está normalizada em `recall/transcript.ts`. Passa por
um LLM antes de montar o comentário. Como vocês já usam Claude, a API da
Anthropic encaixa direto (`claude-sonnet-5` dá conta e é barato pra esse volume).

**Esforço:** baixo — um módulo novo e um passo a mais no `chatpro/client.ts`.
**Risco:** custo por reunião (centavos) e a chance de o resumo errar. Mitigação:
o texto completo continua logo abaixo, então dá sempre pra conferir.

---

### 2. Etiqueta automática na conversa

**Problema:** não dá pra filtrar, contar nem cobrar nada sobre reuniões. Elas
somem no meio das conversas.

**Proposta:** ao terminar, o lead recebe etiqueta conforme o que aconteceu:

| situação | etiqueta |
|---|---|
| gravou e transcreveu | `Reunião realizada` |
| bot não foi admitido | `Reunião sem gravação` |
| reunião com mais de 30 min | `Reunião longa` |

**Como:** `POST /tags/assignLabel` com o `lead_id`. Já temos o `session_id`; o
`lead_id` vem de `getSessionById` (o campo está lá — confirmei na resposta real).

**Esforço:** baixo. Precisa criar as etiquetas uma vez (`tags/create`) e guardar
os ids no `.env`.

**Ganho escondido:** com `tags/listLeadsByTag` vocês passam a ter relatório de
reuniões sem construir relatório nenhum.

---

### 3. Alerta de reunião NÃO gravada

**Problema:** este é o motivo original do projeto. O bot entra como convidado
anônimo e **alguém precisa admitir**. Se ninguém admitir, a reunião acontece e
não fica registro — que é exatamente o buraco que a gravação deveria fechar.
Hoje isso falha em silêncio.

**Proposta:** quando o bot fica em `waiting_room` e a reunião termina sem
gravação, postar um comentário visível:

```
⚠️ Esta reunião não foi gravada — o bot ficou na sala de espera.
```

E marcar a conversa com a etiqueta do item 2.

**Como:** já temos os estados (`waiting_room` → `ended` sem passar por
`recording`). É uma regra no `recallQueue.ts`.

**Esforço:** muito baixo. **Valor:** alto — transforma uma falha invisível em
algo que a supervisão vê.

---

## 🥈 Vale a pena depois

### 4. Agendar reunião pra depois

Hoje o botão cria uma reunião **agora**. Um segundo botão (ou um menu no
mesmo) criaria pra uma data/hora, mandando ao cliente:

> Reunião marcada para quinta, 14h: https://meet.google.com/...

**Como:** o mesmo `criarLinkDoMeet`, só mudando `start`/`end` do evento no
Calendar — e aí o convite entra de verdade na agenda do atendente. O bot do
Recall aceita `join_at` pra entrar sozinho na hora marcada.

**Esforço:** médio (UI de data no content script é a parte chata).

---

### 5. Encerrar o atendimento depois da reunião

Se a reunião resolveu o caso, o atendente encerra na mão. Dá pra oferecer um
"Finalizar atendimento" no aviso que aparece ao fim.

**Como:** `sessions/finish` + um dos "motivos de finalização" já cadastrados
(`endings/list`).

**Esforço:** baixo. **Cuidado:** encerrar sozinho seria intrusivo — tem que ser
uma escolha explícita.

---

### 6. Resposta rápida com o link

Criar um shortcut (`shortcuts/create`) que qualquer atendente dispara digitando
`/reuniao` na caixa de mensagem, sem depender do botão da extensão.

**Por que importa:** é o caminho pra quem estiver no **celular**, onde a
extensão não existe.

**Esforço:** baixo, mas exige que o shortcut chame nosso backend — precisa
confirmar com o chatPro se resposta rápida aceita webhook. Se não aceitar, a
alternativa é o gatilho por link que já funciona.

---

### 7. Busca na transcrição

O painel lista reuniões mas não procura dentro delas. "Onde o cliente falou de
preço?" hoje não tem resposta.

**Como:** SQLite tem FTS5 embutido — dá pra indexar `transcript_json` sem
dependência nova.

**Esforço:** médio. **Valor:** cresce com o tempo, junto com o acervo.

---

## 🥉 Projetos maiores

### 8. Painel de supervisão

Uma tela com: reuniões da semana, quantas foram gravadas, quais não, quem está
usando. Fecha o ciclo do requisito "não pode ser manipulável" — hoje temos o
dado, mas ninguém olha.

### 9. Bot autenticado

Uma conta Google dedicada, logada no Recall, entra **sem sala de espera**. Mata
o item 3 na raiz em vez de só avisar. Precisa de uma conta e configuração no
painel do Recall.

### 10. Vídeo da reunião

O Recall entrega a gravação em vídeo, não só o texto. Dá pra guardar e pôr o
link no comentário. **Cuidado com LGPD:** vídeo é bem mais sensível que texto e
precisa de política de retenção antes.

### 11. Nota de qualidade do atendimento

Era a ideia original da Voreo: pontuar a chamada (o atendente seguiu o script?
fez as perguntas certas?). Com a transcrição diarizada, é um LLM com uma rubrica.

**Cuidado:** avaliar pessoa por IA mexe com confiança do time. Precisa ser
combinado antes, não imposto.

### 12. NPS depois da reunião

A sessão do chatPro tem campos `nps`, `nps_grade` e `waiting_nps`. Existe
máquina de NPS lá dentro. Vale perguntar ao suporte como dispará-la por API —
não achei o endpoint na documentação pública.

---

## O que eu NÃO faria

**Transcrever em tempo real durante a chamada.** O Recall suporta, mas o ganho é
pequeno perto da complexidade (streaming, estado parcial, UI ao vivo) e ninguém
lê transcrição enquanto conversa.

**Bot em toda reunião automaticamente.** Tentador, mas cada bot é cobrado por
hora e o consentimento fica confuso. Melhor continuar explícito.

**Migrar o SQLite pra Postgres agora.** Só faria sentido se fossem hospedar no
Render. Com túnel ou VM, é trabalho sem retorno.

---

## Sugestão de ordem

```
1. Alerta de reunião não gravada   ← menor esforço, fecha o buraco do requisito original
2. Etiqueta automática             ← destrava relatório sem construir relatório
3. Resumo por IA                   ← é o que faz o time realmente usar
   ────────── colher feedback aqui ──────────
4. Agendar reunião
5. Busca na transcrição
6. Painel de supervisão
```

As três primeiras somadas dão menos trabalho que a integração que já está
pronta, e é onde está a maior parte do valor que ainda não foi colhido.
