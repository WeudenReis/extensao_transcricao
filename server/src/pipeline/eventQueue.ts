import type { Db, EventQueueRow } from '../db.js';
import type { TranscriptPipeline } from './transcript.js';
import type { DecodedPushMessage } from '../routes/pubsub.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Fila DURÁVEL de eventos do Workspace Events (tabela event_queue).
 *
 * Por que existe: o webhook ack-a o push com 2xx (Pub/Sub não reentrega
 * depois disso). Se o processamento fosse só em memória, um 500/429
 * transitório da Meet API perderia o transcript PARA SEMPRE. Aqui o webhook
 * apenas INSERE o evento na fila (síncrono, rápido) antes do 204, e o worker
 * processa com retry:
 *
 * - falha transitória → backoff exponencial 30 s → ~1 h, máx 10 tentativas → dead
 * - sem vínculo sessionId↔meet → status no-link, retenta a cada 10 min por
 *   até 48 h → dead; um POST /api/links novo reativa na hora (pending, agora)
 * - sucesso/duplicado → done
 */

const log = createLogger('pipeline/eventQueue');

export const EVENT_TRANSCRIPT_FILE_GENERATED = 'google.workspace.meet.transcript.v2.fileGenerated';
export const EVENT_CONFERENCE_ENDED = 'google.workspace.meet.conference.v2.ended';

export const EVENT_MAX_ATTEMPTS = 10;
export const EVENT_BASE_BACKOFF_MS = 30_000;
export const EVENT_MAX_BACKOFF_MS = 60 * 60_000; // ~1 h
export const NO_LINK_RETRY_MS = 10 * 60_000; // 10 min
export const NO_LINK_MAX_AGE_MS = 48 * 60 * 60_000; // 48 h
export const ENDED_RECHECK_DELAY_MS = 2 * 60_000; // fallback do conference.ended
export const EVENT_WORKER_INTERVAL_MS = 30_000;

/** Backoff exponencial: 30 s, 60 s, 120 s… teto de 1 h. */
export function computeEventBackoffMs(attemptsMade: number): number {
  const exponent = Math.max(0, attemptsMade - 1);
  return Math.min(EVENT_BASE_BACKOFF_MS * 2 ** exponent, EVENT_MAX_BACKOFF_MS);
}

/**
 * Extrai o resource name do payload decodificado do CloudEvent, ex.:
 * { transcript: { name: "conferenceRecords/X/transcripts/Y" } }
 * { conferenceRecord: { name: "conferenceRecords/X" } }
 */
export function extractResourceName(
  payload: Record<string, unknown>,
  key: 'transcript' | 'conferenceRecord'
): string | undefined {
  const container = payload[key];
  if (container !== null && typeof container === 'object' && 'name' in container) {
    const name = (container as { name: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return undefined;
}

export interface EventQueueWorkerOptions {
  db: Db;
  pipeline: TranscriptPipeline;
  /** Injetável nos testes para controlar o relógio. */
  now?: () => Date;
}

export class EventQueueWorker {
  private readonly db: Db;
  private readonly pipeline: TranscriptPipeline;
  private readonly nowFn: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private processing = false;

  constructor(options: EventQueueWorkerOptions) {
    this.db = options.db;
    this.pipeline = options.pipeline;
    this.nowFn = options.now ?? (() => new Date());
  }

  private now(): Date {
    return this.nowFn();
  }

  /**
   * Chamado pelo webhook APÓS validar o push: insere na fila durável.
   * Devolve true se um evento processável foi enfileirado (ou já existia).
   * Lança em erro de banco — o webhook responde 5xx e o Pub/Sub reentrega.
   */
  enqueueFromPush(decoded: DecodedPushMessage): boolean {
    const nowIso = this.now().toISOString();
    switch (decoded.ceType) {
      case EVENT_TRANSCRIPT_FILE_GENERATED: {
        const name = extractResourceName(decoded.payload, 'transcript');
        if (!name) {
          log.warn(`fileGenerated sem transcript.name (messageId=${decoded.messageId ?? '?'}).`);
          return false;
        }
        const result = this.db.enqueueEvent({
          ceType: decoded.ceType,
          resourceName: name,
          payloadJson: JSON.stringify(decoded.payload),
          nextAttemptAt: nowIso,
          createdAt: nowIso,
        });
        log.info(
          result.created
            ? `evento fileGenerated enfileirado (#${result.id}): ${name}`
            : `evento fileGenerated já ativo na fila (#${result.id}): ${name}`
        );
        return true;
      }
      case EVENT_CONFERENCE_ENDED: {
        const name = extractResourceName(decoded.payload, 'conferenceRecord');
        if (!name) {
          log.warn(`conference.ended sem conferenceRecord.name (messageId=${decoded.messageId ?? '?'}).`);
          return false;
        }
        // Fallback: re-checa transcripts 2 min depois do fim da conferência.
        const nextAttemptAt = new Date(this.now().getTime() + ENDED_RECHECK_DELAY_MS).toISOString();
        const result = this.db.enqueueEvent({
          ceType: decoded.ceType,
          resourceName: name,
          payloadJson: JSON.stringify(decoded.payload),
          nextAttemptAt,
          createdAt: nowIso,
        });
        log.info(
          result.created
            ? `evento conference.ended enfileirado (#${result.id}): ${name} (re-checagem ${nextAttemptAt})`
            : `evento conference.ended já ativo na fila (#${result.id}): ${name}`
        );
        return true;
      }
      default:
        log.debug(`evento ignorado (não enfileirado): ce-type=${decoded.ceType ?? '(ausente)'}.`);
        return false;
    }
  }

  /** Dispara uma passada do worker fora do intervalo (ex.: logo após um push). */
  poke(): void {
    setImmediate(() => {
      this.processOnce().catch((err: unknown) => {
        log.error('passada avulsa do worker de eventos falhou', err);
      });
    });
  }

  /** Uma passada do worker: processa eventos vencidos (pending/no-link). */
  async processOnce(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const due = this.db.dueEvents(this.now().toISOString(), 10);
      for (const row of due) {
        await this.processRow(row);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processRow(row: EventQueueRow): Promise<void> {
    try {
      if (
        row.ce_type !== EVENT_TRANSCRIPT_FILE_GENERATED &&
        row.ce_type !== EVENT_CONFERENCE_ENDED
      ) {
        this.db.markEventDead(row.id, `ce-type não suportado: ${row.ce_type}`);
        return;
      }

      const result =
        row.ce_type === EVENT_TRANSCRIPT_FILE_GENERATED
          ? await this.pipeline.handleTranscriptFileGenerated(row.resource_name)
          : await this.pipeline.handleConferenceEnded(row.resource_name);

      switch (result.outcome) {
        case 'done':
          this.db.markEventDone(row.id);
          return;
        case 'no-link': {
          const ageMs = this.now().getTime() - Date.parse(row.created_at);
          if (ageMs > NO_LINK_MAX_AGE_MS) {
            this.db.markEventDead(row.id, 'sem vínculo sessionId↔meet após 48 h');
            log.error(
              `evento #${row.id} (${row.resource_name}) morto: nenhum vínculo apareceu em 48 h.`
            );
            return;
          }
          const nextAttemptAt = new Date(this.now().getTime() + NO_LINK_RETRY_MS).toISOString();
          this.db.markEventNoLink(row.id, result.spaceName, nextAttemptAt);
          log.info(
            `evento #${row.id} sem vínculo — retenta às ${nextAttemptAt} (ou na hora, se o vínculo chegar).`
          );
          return;
        }
        case 'retry':
          this.fail(row, result.reason);
          return;
      }
    } catch (err) {
      // Erro transitório (Meet API 500/429, rede…) → backoff.
      this.fail(row, errorMessage(err));
    }
  }

  private fail(row: EventQueueRow, reason: string): void {
    const attempts = row.attempts + 1;
    if (attempts >= EVENT_MAX_ATTEMPTS) {
      this.db.markEventDead(row.id, reason, attempts);
      log.error(
        `evento #${row.id} (${row.ce_type} ${row.resource_name}) morto após ${attempts} tentativas: ${reason}`
      );
      return;
    }
    const nextAttemptAt = new Date(
      this.now().getTime() + computeEventBackoffMs(attempts)
    ).toISOString();
    this.db.recordEventFailure(row.id, attempts, nextAttemptAt, reason);
    log.warn(
      `evento #${row.id} falhou (tentativa ${attempts}/${EVENT_MAX_ATTEMPTS}) — próxima em ${nextAttemptAt}: ${reason}`
    );
  }

  startWorker(intervalMs: number = EVENT_WORKER_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processOnce().catch((err: unknown) => {
        log.error('worker da fila de eventos falhou', err);
      });
    }, intervalMs);
    this.timer.unref();
    log.info(`worker da fila de eventos iniciado (a cada ${Math.round(intervalMs / 1000)} s).`);
  }

  stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  queueDepth(): { pending: number; noLink: number; dead: number; done: number } {
    return this.db.countEventQueue();
  }
}
