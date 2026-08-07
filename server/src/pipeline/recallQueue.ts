import type { Db, MeetingRow, MeetingStatus, RecallEventRow } from '../db.js';
import { RecallApiError, type RecallClient } from '../recall/client.js';
import type { ChatproClient, ResultadoEntrega } from '../chatpro/client.js';
import { normalizarTranscript, type Fala } from '../recall/transcript.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Fila DURÁVEL dos webhooks do Recall.ai (tabela recall_events).
 *
 * Por que existe: o Recall exige 2xx em até 15 s e desativa endpoints que
 * falham por 5 dias. Processar inline (baixar transcript, entregar ao chatPro)
 * não cabe nesse orçamento. Então o webhook só GRAVA o evento e responde; aqui
 * o trabalho acontece com retry:
 *
 * - falha transitória (5xx/429/timeout) → backoff 30 s → 15 min, máx 8 → dead
 * - 4xx definitivo do Recall → dead na hora (retentar não muda nada)
 * - reunião ainda não gravada (corrida entre POST /api/meetings e o webhook)
 *   → segue pending; só depois de ~10 min vira dead
 *
 * Mesmo desenho da event_queue do Pub/Sub, que já provou valor aqui.
 */

const log = createLogger('pipeline/recallQueue');

export const RECALL_MAX_ATTEMPTS = 8;
export const RECALL_BASE_BACKOFF_MS = 30_000;
export const RECALL_MAX_BACKOFF_MS = 15 * 60_000;
export const RECALL_WORKER_INTERVAL_MS = 15_000;
/** Depois disso, webhook cujo bot não existe aqui é abandonado. */
export const MEETING_AUSENTE_MAX_AGE_MS = 10 * 60_000;
/** Quantos eventos vencidos processamos por passada. */
export const RECALL_LOTE = 10;

export const EVENTO_TRANSCRIPT_DONE = 'transcript.done';

/** Evento do Recall → estado da reunião. O que não está aqui é só informativo. */
export const STATUS_POR_EVENTO: Readonly<Record<string, MeetingStatus>> = {
  'bot.joining_call': 'joining',
  'bot.in_waiting_room': 'waiting_room',
  'bot.in_call_recording': 'recording',
  'bot.call_ended': 'ended',
  'bot.done': 'done',
  'bot.fatal': 'failed',
  'transcript.failed': 'failed',
};

/** Backoff exponencial: 30 s, 60 s, 120 s… teto de 15 min. */
export function computeRecallBackoffMs(tentativasFeitas: number): number {
  const expoente = Math.max(0, tentativasFeitas - 1);
  return Math.min(RECALL_BASE_BACKOFF_MS * 2 ** expoente, RECALL_MAX_BACKOFF_MS);
}

// ─── Leitura defensiva do payload ────────────────────────────────────────────
// O corpo vem de fora e não temos garantia de forma: nada de cast cego.

function objeto(valor: unknown): Record<string, unknown> | undefined {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined;
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor !== '' ? valor : undefined;
}

/** `event` — o que aconteceu (bot.in_call_recording, transcript.done…). */
export function extrairEvento(payload: unknown): string | undefined {
  return texto(objeto(payload)?.event);
}

/** `data.bot.id` — o único elo entre o webhook e a nossa tabela meetings. */
export function extrairBotId(payload: unknown): string | undefined {
  const bot = objeto(objeto(objeto(payload)?.data)?.bot);
  return texto(bot?.id);
}

/** `data.bot.metadata.session_id` — o vínculo com a conversa do chatPro. */
export function extrairSessionId(payload: unknown): string | undefined {
  const metadata = objeto(objeto(objeto(objeto(payload)?.data)?.bot)?.metadata);
  return texto(metadata?.session_id);
}

/** `data.data.sub_code` — o porquê de um bot.fatal / transcript.failed. */
export function extrairSubCode(payload: unknown): string | undefined {
  const dados = objeto(objeto(objeto(payload)?.data)?.data);
  return texto(dados?.sub_code);
}

// ─── Transcript salvo ────────────────────────────────────────────────────────

export interface TranscriptSalvo {
  falas: Fala[];
  participantes: { nome: string; isHost: boolean; email: string | null }[];
}

/**
 * Lê o `transcript_json` da reunião (o que o worker gravou). Devolve null
 * quando ainda não há transcript — nunca lança, pra um JSON estragado não
 * derrubar uma rota.
 */
export function lerTranscriptSalvo(transcriptJson: string | null): TranscriptSalvo | null {
  if (!transcriptJson) return null;
  let bruto: unknown;
  try {
    bruto = JSON.parse(transcriptJson);
  } catch {
    log.warn('transcript_json ilegível no banco — tratando como ausente.');
    return null;
  }
  const raiz = objeto(bruto);
  if (!raiz) return null;
  return {
    falas: Array.isArray(raiz.falas) ? (raiz.falas as Fala[]) : [],
    participantes: Array.isArray(raiz.participantes)
      ? (raiz.participantes as TranscriptSalvo['participantes'])
      : [],
  };
}

/**
 * Entrega a transcrição já salva ao chatPro e carimba o `chatpro_status`.
 * Usada tanto pelo envio automático (AUTO_SEND_CHATPRO) quanto pelo botão
 * do painel — o resultado precisa ser idêntico nos dois caminhos.
 */
export async function entregarAoChatpro(
  db: Db,
  chatpro: ChatproClient,
  meeting: MeetingRow
): Promise<ResultadoEntrega> {
  const salvo = lerTranscriptSalvo(meeting.transcript_json);
  if (!salvo) {
    return { ok: false, status: 'failed', motivo: 'reunião ainda sem transcrição salva' };
  }
  const resultado = await chatpro.enviar({
    sessionId: meeting.session_id,
    meetingUrl: meeting.meeting_url,
    meetingCode: meeting.meeting_code,
    startedAt: meeting.started_at,
    endedAt: meeting.ended_at,
    durationSeconds: meeting.duration_seconds ?? 0,
    participants: salvo.participantes,
    transcript: salvo.falas,
    source: 'recall-ai',
  });
  db.setMeetingChatproStatus(meeting.id, resultado.status);
  return resultado;
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export interface RecallQueueWorkerOptions {
  db: Db;
  /** undefined quando RECALL_API_KEY não está configurada (modo dev). */
  recall: RecallClient | undefined;
  chatpro: ChatproClient;
  /** AUTO_SEND_CHATPRO — false deixa a entrega para o botão do painel. */
  autoSendChatpro: boolean;
  /** Injetável nos testes para controlar o relógio. */
  now?: () => Date;
}

/** O que o webhook entrega pra fila (corpo cru preservado como veio). */
export interface WebhookEnfileiravel {
  event: string;
  botId: string | null;
  payloadJson: string;
  /** Header `webhook-id` do Svix — é ele que deduplica a reentrega. */
  webhookId: string | null;
}

export class RecallQueueWorker {
  private readonly db: Db;
  private readonly recall: RecallClient | undefined;
  private readonly chatpro: ChatproClient;
  private readonly autoSendChatpro: boolean;
  private readonly nowFn: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private processing = false;

  constructor(options: RecallQueueWorkerOptions) {
    this.db = options.db;
    this.recall = options.recall;
    this.chatpro = options.chatpro;
    this.autoSendChatpro = options.autoSendChatpro;
    this.nowFn = options.now ?? ((): Date => new Date());
  }

  private now(): Date {
    return this.nowFn();
  }

  /**
   * Chamado pelo webhook DEPOIS de conferir a assinatura: grava na fila.
   * Lança em erro de banco — aí o endpoint responde 5xx e o Recall reentrega.
   */
  enqueueFromWebhook(entrada: WebhookEnfileiravel): { id: number; created: boolean } {
    const agoraIso = this.now().toISOString();
    const resultado = this.db.enqueueRecallEvent({
      webhookId: entrada.webhookId,
      event: entrada.event,
      botId: entrada.botId,
      payloadJson: entrada.payloadJson,
      nextAttemptAt: agoraIso,
      createdAt: agoraIso,
    });
    const bot = entrada.botId ?? '(sem bot)';
    log.info(
      resultado.created
        ? `webhook ${entrada.event} enfileirado (#${resultado.id}), bot ${bot}`
        : `webhook ${entrada.event} já estava na fila (#${resultado.id}) — reentrega ignorada`
    );
    return resultado;
  }

  /** Dispara uma passada fora do intervalo (ex.: logo após responder o webhook). */
  poke(): void {
    setImmediate(() => {
      this.processOnce().catch((err: unknown) => {
        log.error('passada avulsa do worker do Recall falhou', err);
      });
    });
  }

  /** Retoma o que ficou pendente de antes do restart. */
  resumePending(): void {
    const { pending } = this.db.countRecallEvents();
    if (pending === 0) return;
    log.info(`${pending} webhook(s) do Recall pendente(s) — retomando após o boot.`);
    this.poke();
  }

  async processOnce(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const vencidos = this.db.dueRecallEvents(this.now().toISOString(), RECALL_LOTE);
      for (const row of vencidos) {
        await this.processRow(row);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processRow(row: RecallEventRow): Promise<void> {
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        // Não deveria acontecer (o endpoint só enfileira JSON válido).
        this.db.markRecallEventDead(row.id, 'payload_json ilegível');
        log.error(`evento #${row.id} morto: payload_json ilegível.`);
        return;
      }

      const botId = row.bot_id ?? extrairBotId(payload) ?? null;
      const meeting = botId ? this.db.getMeetingByBotId(botId) : undefined;

      // O vínculo com o chatPro pode chegar depois da criação do bot.
      if (meeting) this.preencherSessionId(meeting, payload);

      const status = STATUS_POR_EVENTO[row.event];
      const acionavel = row.event === EVENTO_TRANSCRIPT_DONE || status !== undefined;
      if (!acionavel) {
        // transcript.processing, recording.done, bot.in_call_not_recording…:
        // informativos, não mudam nosso estado. Encerram sem retentar.
        this.db.markRecallEventDone(row.id);
        log.debug(`evento #${row.id} (${row.event}) sem efeito de estado — encerrado.`);
        return;
      }

      if (!botId) {
        this.db.markRecallEventDead(row.id, `webhook ${row.event} sem data.bot.id`);
        log.error(`evento #${row.id} morto: ${row.event} chegou sem data.bot.id.`);
        return;
      }

      if (!meeting) {
        this.semReuniao(row, botId);
        return;
      }

      if (row.event === EVENTO_TRANSCRIPT_DONE) {
        await this.processarTranscriptDone(row, meeting, botId);
        return;
      }

      // Aqui `status` é sempre definido: `acionavel` já garantiu isso.
      if (status) this.aplicarStatus(row, meeting, status, payload);
    } catch (err) {
      if (err instanceof RecallApiError && !ehTransitorio(err)) {
        this.db.markRecallEventDead(row.id, `Recall recusou de forma definitiva: ${err.message}`);
        log.error(`evento #${row.id} (${row.event}) morto — HTTP ${err.status} do Recall.`);
        return;
      }
      this.fail(row, errorMessage(err));
    }
  }

  /** bot.* / transcript.failed → só mexe no estado da reunião. */
  private aplicarStatus(
    row: RecallEventRow,
    meeting: MeetingRow,
    status: MeetingStatus,
    payload: unknown
  ): void {
    let motivo: string | null = null;
    if (status === 'failed') {
      const subCode = extrairSubCode(payload);
      motivo = subCode ? `${row.event}: ${subCode}` : row.event;
    }
    this.db.updateMeetingStatus(meeting.id, status, motivo);
    this.db.markRecallEventDone(row.id);
    log.info(`reunião ${meeting.id} → ${status}${motivo ? ` (${motivo})` : ` (${row.event})`}`);
  }

  /** transcript.done → baixa, normaliza, grava e (se configurado) entrega. */
  private async processarTranscriptDone(
    row: RecallEventRow,
    meeting: MeetingRow,
    botId: string
  ): Promise<void> {
    // Idempotência. O mesmo transcript.done pode voltar a ser processado: se o
    // servidor cair entre a entrega e o markDone, a linha continua 'pending' e
    // é retomada no boot; e o Recall pode reemitir o evento com outro
    // webhook-id (aí o UNIQUE do webhook_id não deduplica). Sem esta guarda,
    // baixaríamos de novo e a transcrição chegaria DUPLICADA na conversa do
    // chatPro — exatamente o tipo de duplicidade que já apareceu neste projeto.
    if (meeting.transcript_json) {
      log.info(
        `reunião ${meeting.id} já tem transcrição salva — evento #${row.id} não rebaixa nada.`
      );
      if (meeting.chatpro_status !== 'sent') await this.entregar(meeting.id);
      this.db.markRecallEventDone(row.id);
      return;
    }

    if (!this.recall) {
      this.db.markRecallEventDead(
        row.id,
        'RECALL_API_KEY não configurada — sem ela não dá pra baixar o transcript.'
      );
      log.error(`evento #${row.id} morto: transcript.done sem RECALL_API_KEY configurada.`);
      return;
    }

    const url = await this.recall.getTranscriptDownloadUrl(botId);
    if (!url) {
      // Acontece: o webhook chega um instante antes do link ficar disponível.
      this.fail(row, 'transcript.done recebido, mas o download_url ainda não apareceu');
      return;
    }

    const bruto = await this.recall.downloadTranscript(url);
    const normalizado = normalizarTranscript(bruto);
    this.db.setMeetingTranscript({
      id: meeting.id,
      transcriptJson: JSON.stringify({
        falas: normalizado.falas,
        participantes: normalizado.participantes,
      }),
      durationSeconds: normalizado.duracaoSegundos,
    });
    this.db.updateMeetingStatus(meeting.id, 'done');
    log.info(
      `reunião ${meeting.id}: transcrição salva ` +
        `(${normalizado.falas.length} falas, ${normalizado.duracaoSegundos}s).`
    );

    await this.entregar(meeting.id);
    this.db.markRecallEventDone(row.id);
  }

  /** Entrega ao chatPro — ou deixa 'pending' pro botão do painel. */
  private async entregar(meetingId: string): Promise<void> {
    if (!this.autoSendChatpro) {
      this.db.setMeetingChatproStatus(meetingId, 'pending');
      log.info(
        `AUTO_SEND_CHATPRO desligado — reunião ${meetingId} aguarda envio manual pelo painel.`
      );
      return;
    }
    // Relê a linha: precisa do transcript e dos horários recém-gravados.
    const atual = this.db.getMeeting(meetingId);
    if (!atual) return;
    const resultado = await entregarAoChatpro(this.db, this.chatpro, atual);
    if (!resultado.ok && resultado.status === 'failed') {
      log.warn(`entrega automática ao chatPro falhou (reunião ${meetingId}) — reenvie pelo painel.`);
    }
  }

  /** Preenche session_id quando o webhook trouxe o vínculo e a reunião não tem. */
  private preencherSessionId(meeting: MeetingRow, payload: unknown): void {
    if (meeting.session_id) return;
    const sessionId = extrairSessionId(payload);
    if (!sessionId) return;
    this.db.setMeetingSessionId(meeting.id, sessionId);
    log.info(`reunião ${meeting.id} vinculada à sessão ${sessionId} (veio no metadata do webhook).`);
  }

  /**
   * Webhook cujo bot ainda não tem reunião gravada. NÃO é para morrer: o
   * POST /api/meetings pode ter demorado a commitar. Depois de ~10 min, aí sim
   * desistimos (bot criado fora deste servidor, ou banco recriado).
   */
  private semReuniao(row: RecallEventRow, botId: string): void {
    const idadeMs = this.now().getTime() - Date.parse(row.created_at);
    if (idadeMs > MEETING_AUSENTE_MAX_AGE_MS) {
      const motivo =
        `nenhuma reunião com bot_id ${botId} apareceu em ` +
        `${Math.round(MEETING_AUSENTE_MAX_AGE_MS / 60_000)} min — bot criado fora deste servidor?`;
      this.db.markRecallEventDead(row.id, motivo);
      log.error(`evento #${row.id} (${row.event}) morto: ${motivo}`);
      return;
    }
    this.fail(row, `reunião do bot ${botId} ainda não gravada — aguardando`);
  }

  /** Falha transitória: continua pending, com backoff; no limite vira dead. */
  private fail(row: RecallEventRow, motivo: string): void {
    const tentativas = row.attempts + 1;
    if (tentativas >= RECALL_MAX_ATTEMPTS) {
      this.db.markRecallEventDead(row.id, motivo, tentativas);
      log.error(`evento #${row.id} (${row.event}) morto após ${tentativas} tentativas: ${motivo}`);
      return;
    }
    const proxima = new Date(
      this.now().getTime() + computeRecallBackoffMs(tentativas)
    ).toISOString();
    this.db.recordRecallEventFailure(row.id, tentativas, proxima, motivo);
    log.warn(
      `evento #${row.id} (${row.event}) falhou ` +
        `(tentativa ${tentativas}/${RECALL_MAX_ATTEMPTS}) — próxima em ${proxima}: ${motivo}`
    );
  }

  startWorker(intervalMs: number = RECALL_WORKER_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processOnce().catch((err: unknown) => {
        log.error('worker da fila do Recall falhou', err);
      });
    }, intervalMs);
    this.timer.unref();
    log.info(`worker da fila do Recall iniciado (a cada ${Math.round(intervalMs / 1000)} s).`);
  }

  stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  queueDepth(): { pending: number; done: number; dead: number } {
    return this.db.countRecallEvents();
  }
}

/**
 * Vale retentar? Indisponibilidade (5xx), throttling (429), timeout e falha de
 * rede (status 0) passam; 4xx é decisão do Recall e não muda com o tempo.
 */
function ehTransitorio(err: unknown): boolean {
  if (err instanceof RecallApiError) {
    return err.timedOut || err.status === 0 || err.status === 429 || err.status >= 500;
  }
  return true;
}
