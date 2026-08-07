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

export interface CriarReuniaoEntrada {
  meetingUrl: string;
  sessionId: string | null;
  /** Instância do chatPro dona da conversa (quando veio pelo webhook). */
  chatproInstanceId?: string | null;
  /** De onde veio o pedido — só pra log. */
  origem: 'api' | 'chatpro-webhook';
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

  // Já tem bot vivo nessa sala? Devolve o que existe. Este endpoint é chamado
  // por máquina (o chatPro), então repetição é esperada — e cada bot a mais é
  // um robô a mais aparecendo pro cliente e outra hora cobrada.
  if (meetingCode) {
    const desde = new Date(agora - JANELA_DEDUP_MS).toISOString();
    const semBotDesde = new Date(agora - JANELA_SEM_BOT_MS).toISOString();
    const viva = db.findActiveMeetingByCode(meetingCode, desde, semBotDesde);
    if (viva) {
      enriquecer(db, viva, entrada);
      const atual = db.getMeeting(viva.id) ?? viva;
      log.info(
        `pedido repetido pra ${meetingCode} (${entrada.origem}) — reunião ${atual.id} ` +
          `já está ${atual.status}, sem criar outro bot.`
      );
      return { ok: true, criada: false, meeting: atual };
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
    status: 'created',
  });

  try {
    const bot = await recall.createBot({
      meetingUrl: entrada.meetingUrl,
      botName,
      meetingId,
      sessionId: entrada.sessionId ?? undefined,
    });
    db.setMeetingBotId(meetingId, bot.id);
    log.info(
      `reunião ${meetingId} criada (${entrada.origem}): bot ${bot.id}, ` +
        `meet ${meetingCode ?? '?'}, sessão ${entrada.sessionId ?? '(sem vínculo)'}.`
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
        db.updateMeetingStatus(
          meetingId,
          'created',
          `o Recall não respondeu a tempo; o bot pode ter entrado assim mesmo: ${detalhe}`.slice(0, 300)
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

/** Aproveita o pedido repetido pra preencher o que faltava na reunião viva. */
function enriquecer(db: Db, meeting: MeetingRow, entrada: CriarReuniaoEntrada): void {
  if (entrada.sessionId && !meeting.session_id) {
    db.setMeetingSessionId(meeting.id, entrada.sessionId);
  }
  if (entrada.chatproInstanceId && !meeting.chatpro_instance_id) {
    db.setMeetingChatproInstance(meeting.id, entrada.chatproInstanceId);
  }
}
