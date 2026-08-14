import { randomUUID } from 'node:crypto';
import type { Db, MeetingRow } from '../db.js';
import { RecallApiError, type RecallClient } from './client.js';
import { normalizeMeetingCode } from '../google/meet.js';
import { createLogger } from '../log.js';

/**
 * Colocar o bot numa reunião — o caminho ÚNICO.
 *
 * Três lugares chamam isto: a rota `POST /api/meetings`, o botão do painel e o
 * webhook do chatPro (que dispara sozinho ao ver um link do Meet na conversa).
 * Se cada um tivesse a própria lógica, a proteção contra bot duplicado valeria
 * só em alguns deles — e essa foi exatamente a forma do bug que já apareceu
 * neste projeto (uma correção feita só em um dos caminhos).
 *
 * Duas garantias que moram aqui:
 *
 * 1. **A reunião é gravada ANTES de chamar o Recall**, e o id dela viaja em
 *    `metadata.meeting_id`. Se a resposta se perder no timeout com o bot já
 *    criado, o primeiro webhook reencontra a linha e amarra o bot_id.
 * 2. **Chamar de novo não põe um segundo bot** na mesma sala enquanto a
 *    reunião estiver viva.
 */

const log = createLogger('recall/criarReuniao');

/**
 * Por quanto tempo uma reunião viva "segura" o código do Meet contra um
 * segundo bot. 12 h cobre qualquer reunião real e evita que uma linha travada
 * em 'created' bloqueie a mesma sala no dia seguinte.
 */
export const JANELA_DEDUP_MS = 12 * 60 * 60 * 1000;

/**
 * Janela menor pra reunião que ainda NÃO tem bot_id. Cobre o duplo clique e o
 * retry (que é o que o dedup precisa segurar) sem deixar uma linha presa em
 * 'created' bloquear a mesma sala pelas 12 h inteiras.
 */
export const JANELA_SEM_BOT_MS = 15 * 60_000;

/**
 * Antecedência mínima pro `join_at` do Recall (a doc deles recomenda ~10 min).
 * Com menos que isso o pedido agendado vira um pedido normal: o bot entra
 * agora. Adiar a entrada por 3 min só criaria uma janela em que a reunião já
 * começou e o bot ainda não chegou.
 */
export const ANTECEDENCIA_MINIMA_JOIN_AT_MS = 10 * 60_000;

/**
 * Quanto dois horários podem diferir e ainda serem "a mesma reunião". Cobre o
 * duplo clique e o retry (que chegam com o mesmo horário marcado) sem confundir
 * a reunião das 14 h com a das 16 h na mesma sala.
 */
export const TOLERANCIA_MESMO_HORARIO_MS = 5 * 60_000;

/**
 * Prefixo da nota que guarda o horário marcado na reunião.
 *
 * Por que na nota e não numa coluna: o dedup é o único que lê esse horário, e a
 * coluna de nota já é usada assim em 'created' (ver o caminho do timeout, logo
 * abaixo). O formato é `agendada para <ISO> — <texto pra pessoa>`: máquina lê o
 * começo, o painel mostra a frase inteira.
 */
const NOTA_AGENDADA = 'agendada para ';

export interface CriarReuniaoEntrada {
  meetingUrl: string;
  sessionId: string | null;
  /** Instância do chatPro dona da conversa (quando veio pelo webhook). */
  chatproInstanceId?: string | null;
  /** De onde veio o pedido — só pra log. */
  origem: 'api' | 'chatpro-webhook';
  /**
   * Reunião marcada pra depois: horário em que o bot deve entrar na sala. Sem
   * isto o bot entra agora, que é o caminho de sempre.
   */
  joinAt?: Date | null;
  /**
   * E-mail do RESPONSÁVEL pela reunião — a rota já resolveu quem é
   * (distribuição do painel interno, vendedor escolhido ou quem marcou).
   * Fica na coluna de atribuição do painel de reuniões.
   */
  atendenteEmail?: string | null;
  /** apresentacao | migracao | implantacao | cs. */
  tipo?: string | null;
  /** { nome, cnpj, instancia, telefone } quando o tipo exige. */
  clienteJson?: string | null;
  /** Id da reunião no painel — destino da transcrição no fim. */
  painelMeetingId?: string | null;
}

export type ResultadoCriacao =
  | { ok: true; criada: true; meeting: MeetingRow }
  /** Já havia bot nessa sala; devolvemos o que existe. */
  | { ok: true; criada: false; meeting: MeetingRow }
  | {
      ok: false;
      meeting: MeetingRow | null;
      erro: string;
      status: number;
      hint?: string;
      /** Timeout: o bot PODE ter entrado mesmo assim. */
      talvezCriado: boolean;
    };

export interface CriarReuniaoDeps {
  db: Db;
  /** undefined quando RECALL_API_KEY não está configurada. */
  recall: RecallClient | undefined;
  botName: string;
  now?: () => number;
}

export async function criarReuniao(
  deps: CriarReuniaoDeps,
  entrada: CriarReuniaoEntrada
): Promise<ResultadoCriacao> {
  const { db, recall, botName } = deps;
  const agora = deps.now?.() ?? Date.now();

  if (!recall) {
    return {
      ok: false,
      meeting: null,
      status: 503,
      erro: 'RECALL_API_KEY está vazia — sem ela o servidor não cria o bot que entra na reunião.',
      hint: 'Preencha RECALL_API_KEY no server/.env (chave da região us-west-2) e reinicie.',
      talvezCriado: false,
    };
  }

  const meetingCode = normalizeMeetingCode(entrada.meetingUrl) || null;
  const marcado = entrada.joinAt ? entrada.joinAt.getTime() : null;
  const agendarNoRecall = marcado !== null && marcado - agora >= ANTECEDENCIA_MINIMA_JOIN_AT_MS;
  if (marcado !== null && !agendarNoRecall) {
    log.info(
      `pedido marcado pra ${new Date(marcado).toISOString()}, a menos de ` +
        `${Math.round(ANTECEDENCIA_MINIMA_JOIN_AT_MS / 60_000)} min daqui — vai SEM join_at, ` +
        'o bot entra agora (é o que o Recall recomenda pra antecedência curta).'
    );
  }

  // Já tem bot vivo nessa sala? Este endpoint é chamado por máquina (o chatPro),
  // então repetição é esperada — e cada bot a mais é um robô a mais aparecendo
  // pro cliente e outra hora cobrada.
  //
  // MAS: "mesma sala" só é o mesmo atendimento se for a MESMA sessão. Sala
  // reaproveitada (link pessoal, evento recorrente, reagendamento) pode servir
  // dois clientes no mesmo dia. Tratar isso como duplicata seria o pior dos
  // erros possíveis aqui: o bot da conversa A gravaria a reunião do cliente B,
  // e a transcrição de B iria parar no atendimento de A.
  //
  // E "mesma sala" também só é o mesmo atendimento se for o MESMO HORÁRIO:
  // marcar as 14 h e as 16 h no mesmo link são dois compromissos.
  //
  // A comparação olha só a reunião viva MAIS RECENTE da sala. Com duas marcadas
  // ao mesmo tempo no mesmo link, um pedido repetido da mais antiga escaparia —
  // e tudo bem: cada pedido pela rota gera um link novo, então sala repetida já
  // é exceção, e duas marcadas na mesma sala é exceção da exceção.
  if (meetingCode) {
    const desde = new Date(agora - JANELA_DEDUP_MS).toISOString();
    const semBotDesde = new Date(agora - JANELA_SEM_BOT_MS).toISOString();
    const viva = db.findActiveMeetingByCode(meetingCode, desde, semBotDesde);

    if (viva && !mesmoMomento(marcado, horarioMarcado(viva))) {
      // Mesma sala, HORÁRIOS diferentes: são duas reuniões, cada uma com o seu
      // bot. Engolir a segunda como duplicata deixaria o atendente com um
      // "marcado!" na tela e nenhum bot no horário combinado. E o bot da
      // primeira continua de pé — ele tem hora marcada e ainda vai acontecer.
      log.info(
        `sala ${meetingCode} já tem a reunião ${viva.id} (${descreverMomento(horarioMarcado(viva))}) ` +
          `e chegou pedido ${descreverMomento(marcado)} — reuniões diferentes, criando outro bot.`
      );
    } else if (viva) {
      const mesmaConversa =
        // Sem sessão dos dois lados, ou sessões iguais: é a mesma coisa.
        !entrada.sessionId || !viva.session_id || entrada.sessionId === viva.session_id;

      if (mesmaConversa) {
        enriquecer(db, viva, entrada);
        const atual = db.getMeeting(viva.id) ?? viva;
        log.info(
          `pedido repetido pra ${meetingCode} (${entrada.origem}) — reunião ${atual.id} ` +
            `já está ${atual.status}, sem criar outro bot.`
        );
        return { ok: true, criada: false, meeting: atual };
      }

      // Sala repetida, conversa DIFERENTE. Tira o bot antigo antes de pôr o
      // novo: dois bots na mesma sala gravariam a mesma coisa e cada
      // transcrição iria pra uma conversa, misturando os dois clientes.
      log.warn(
        `sala ${meetingCode} reaproveitada: já havia a reunião ${viva.id} ` +
          `(sessão ${viva.session_id}) e chegou pedido da sessão ${entrada.sessionId}. ` +
          `Encerrando o bot anterior antes de criar o novo.`
      );
      if (viva.bot_id) {
        try {
          await recall.leaveCall(viva.bot_id);
        } catch (err) {
          // Não impede o novo: o bot antigo pode já ter saído sozinho
          // (everyone_left_timeout) e aí o leave_call devolve erro.
          log.warn(`não deu pra tirar o bot ${viva.bot_id}: ${String(err)}`);
        }
      }
      db.updateMeetingStatus(
        viva.id,
        'ended',
        'sala reaproveitada por outra conversa — bot encerrado'
      );
      // A sala agora pertence a outra conversa. Convite pendente da reunião
      // antiga viraria o pior caso possível: dois clientes diferentes entrando
      // na MESMA chamada, com a transcrição indo pro atendimento errado.
      // Aqui o cancelamento é ato explícito — o worker não adivinha por status.
      const cancelados = db.cancelarEnviosDaReuniao(viva.id);
      if (cancelados > 0) {
        log.warn(
          `reunião ${viva.id} perdeu a sala: ${cancelados} convite(s) pendente(s) cancelado(s).`
        );
      }
    }
  }

  const meetingId = randomUUID();
  const meeting = db.createMeeting({
    id: meetingId,
    botId: null,
    sessionId: entrada.sessionId,
    meetingUrl: entrada.meetingUrl,
    meetingCode,
    botName,
    chatproInstanceId: entrada.chatproInstanceId ?? null,
    atendenteEmail: entrada.atendenteEmail ?? null,
    tipo: entrada.tipo ?? null,
    clienteJson: entrada.clienteJson ?? null,
    painelMeetingId: entrada.painelMeetingId ?? null,
    status: 'created',
  });

  // A nota é gravada ANTES do Recall: é ela que diz ao próximo pedido que esta
  // sala já tem hora marcada. Se a chamada estourar o timeout com o bot criado,
  // o horário não pode ter se perdido.
  const nota =
    marcado === null
      ? null
      : NOTA_AGENDADA +
        new Date(marcado).toISOString() +
        (agendarNoRecall ? ' — o bot entra sozinho no horário' : ' — falta pouco, o bot entra agora');
  if (nota) db.updateMeetingStatus(meetingId, 'created', nota);

  try {
    const bot = await recall.createBot({
      meetingUrl: entrada.meetingUrl,
      botName,
      meetingId,
      sessionId: entrada.sessionId ?? undefined,
      ...(agendarNoRecall && marcado !== null ? { joinAt: new Date(marcado) } : {}),
    });
    db.setMeetingBotId(meetingId, bot.id);
    log.info(
      `reunião ${meetingId} criada (${entrada.origem}): bot ${bot.id}, ` +
        `meet ${meetingCode ?? '?'}, sessão ${entrada.sessionId ?? '(sem vínculo)'}, ` +
        `${descreverMomento(marcado)}.`
    );
    return { ok: true, criada: true, meeting: db.getMeeting(meetingId) ?? meeting };
  } catch (err) {
    const apiErr = err instanceof RecallApiError ? err : null;
    const detalhe = apiErr ? apiErr.message : String(err);

    // Só marca falha se a reunião AINDA está em 'created'. No timeout, o bot
    // pode ter sido criado e o webhook já ter avançado a reunião pra 'joining'
    // ou 'recording' enquanto estávamos aqui — sobrescrever com 'failed'
    // apagaria um estado verdadeiro e carimbaria ended_at pra sempre.
    const atual = db.getMeeting(meetingId);
    if (atual?.status === 'created') {
      if (apiErr?.timedOut) {
        // Timeout NÃO vira 'failed': o bot pode estar entrando na sala agora.
        // Deixar em 'created' também mantém o dedup segurando um segundo bot.
        // A nota do agendamento vai na frente porque o dedup lê ela daqui — sem
        // isso, o retry acharia que é outro horário e poria um segundo bot.
        db.updateMeetingStatus(
          meetingId,
          'created',
          `${nota ? `${nota} | ` : ''}o Recall não respondeu a tempo; o bot pode ter entrado assim mesmo: ${detalhe}`.slice(
            0,
            300
          )
        );
      } else {
        db.updateMeetingStatus(meetingId, 'failed', `falha ao criar o bot: ${detalhe}`.slice(0, 300));
      }
    }
    log.error(`falha ao criar bot no Recall (${entrada.origem})`, err);

    return {
      ok: false,
      meeting: db.getMeeting(meetingId) ?? meeting,
      status: 502,
      erro: detalhe,
      talvezCriado: apiErr?.timedOut === true,
      ...(apiErr?.timedOut
        ? {
            hint:
              'O Recall demorou demais pra responder. O bot PODE ter entrado na reunião mesmo ' +
              'assim — confira a lista antes de tentar de novo, pra não colocar dois.',
          }
        : {}),
      ...(apiErr?.status === 401 || apiErr?.status === 403
        ? { hint: 'RECALL_API_KEY inválida ou de outra região — confira RECALL_REGION.' }
        : {}),
    };
  }
}

/**
 * Horário marcado de uma reunião já gravada, lido da nota. `null` quando ela é
 * uma reunião pra agora — que é o caso da esmagadora maioria.
 */
export function horarioMarcado(meeting: MeetingRow): number | null {
  if (!meeting.error?.startsWith(NOTA_AGENDADA)) return null;
  const iso = meeting.error.slice(NOTA_AGENDADA.length).split(' ')[0] ?? '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * O pedido que chegou e a reunião viva apontam pro mesmo momento?
 *
 * Pedido SEM horário ("quero agora") casa com qualquer reunião viva na sala —
 * inclusive uma marcada pra depois. É de propósito: o link que acabamos de
 * mandar pro cliente volta como `sent_message` no webhook do chatPro e chega
 * aqui como um pedido pra agora. Tratar esse eco como reunião nova poria um bot
 * numa sala vazia, cobrado por hora, na frente do cliente.
 */
function mesmoMomento(pedido: number | null, viva: number | null): boolean {
  if (pedido === null) return true;
  if (viva === null) return false;
  return Math.abs(pedido - viva) <= TOLERANCIA_MESMO_HORARIO_MS;
}

/** Só pra log ficar legível. */
function descreverMomento(momento: number | null): string {
  return momento === null ? 'pra agora' : `pra ${new Date(momento).toISOString()}`;
}

/** Aproveita o pedido repetido pra preencher o que faltava na reunião viva. */
function enriquecer(db: Db, meeting: MeetingRow, entrada: CriarReuniaoEntrada): void {
  if (entrada.sessionId && !meeting.session_id) {
    db.setMeetingSessionId(meeting.id, entrada.sessionId);
  }
  if (entrada.chatproInstanceId && !meeting.chatpro_instance_id) {
    db.setMeetingChatproInstance(meeting.id, entrada.chatproInstanceId);
  }
}
