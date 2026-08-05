import type { Db } from '../db.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Adapter da Voreo (plataforma externa de análise de reunião).
 *
 * O contrato da Voreo ainda não existe — este client é o ponto ÚNICO a ajustar
 * quando ele for definido (formato do payload, header de auth, endpoint).
 *
 * Comportamento:
 * - POST VOREO_WEBHOOK_URL com Authorization: Bearer VOREO_API_KEY
 * - Falhou? Entra na voreo_queue com backoff exponencial (worker a cada 30 s,
 *   máx 8 tentativas; depois marca 'failed' e mantém a linha pra inspeção).
 * - VOREO_WEBHOOK_URL vazio? Loga payload RESUMIDO e marca 'skipped-no-url'
 *   (modo dev — nunca logamos o transcript inteiro).
 */

const log = createLogger('voreo');

export const MAX_ATTEMPTS = 8;
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
export const WORKER_INTERVAL_MS = 30_000;

/**
 * Backoff exponencial: 30s, 60s, 120s, 240s… com teto de 30 min.
 * `attemptsMade` = quantas tentativas já foram feitas (>= 1).
 */
export function computeBackoffMs(attemptsMade: number): number {
  const exponent = Math.max(0, attemptsMade - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

export interface VoreoPayload {
  sessionId: string;
  meetingCode: string;
  conferenceRecord: string;
  startTime: string | undefined;
  endTime: string | undefined;
  participants: { name: string }[];
  transcript: {
    speaker: string;
    text: string;
    startTime: string | undefined;
    endTime: string | undefined;
  }[];
  docsExportUri: string | undefined;
  source: 'chatpro-meet-extension';
}

/** Item persistido na fila: payload + transcript de origem (pra atualizar status). */
export interface VoreoDelivery {
  transcriptName: string;
  payload: VoreoPayload;
}

export interface VoreoClientOptions {
  db: Db;
  webhookUrl: string | undefined;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  /** Injetável nos testes para controlar o relógio. */
  now?: () => Date;
}

export class VoreoClient {
  private readonly db: Db;
  private readonly webhookUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => Date;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: VoreoClientOptions) {
    this.db = options.db;
    this.webhookUrl = options.webhookUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowFn = options.now ?? (() => new Date());
  }

  private now(): Date {
    return this.nowFn();
  }

  /** Entrega imediata; em falha, agenda retry na fila. */
  async deliver(item: VoreoDelivery): Promise<void> {
    if (!this.webhookUrl) {
      log.info(
        `VOREO_WEBHOOK_URL vazio — envio pulado (modo dev). ` +
          this.summarize(item.payload)
      );
      this.db.markTranscriptStatus(item.transcriptName, 'skipped-no-url', this.now().toISOString());
      return;
    }
    try {
      await this.post(item.payload);
      this.db.markTranscriptStatus(item.transcriptName, 'sent', this.now().toISOString());
      log.info(`enviado à Voreo: ${this.summarize(item.payload)}`);
    } catch (err) {
      const nextAttemptAt = new Date(this.now().getTime() + computeBackoffMs(1)).toISOString();
      this.db.enqueueVoreo({
        payloadJson: JSON.stringify(item),
        attempts: 1,
        nextAttemptAt,
        lastError: errorMessage(err),
      });
      this.db.markTranscriptStatus(item.transcriptName, 'queued', null);
      log.warn(
        `envio à Voreo falhou (tentativa 1/${MAX_ATTEMPTS}) — reagendado para ${nextAttemptAt}: ${errorMessage(err)}`
      );
    }
  }

  /** Uma passada do worker: tenta os itens vencidos da fila. */
  async processQueueOnce(): Promise<void> {
    const due = this.db.dueVoreoItems(this.now().toISOString(), 10);
    for (const row of due) {
      let item: VoreoDelivery;
      try {
        item = JSON.parse(row.payload_json) as VoreoDelivery;
      } catch {
        log.error(`item ${row.id} da fila com JSON inválido — descartando.`);
        this.db.removeVoreoItem(row.id);
        continue;
      }

      if (!this.webhookUrl) {
        log.info(`VOREO_WEBHOOK_URL vazio — descartando item ${row.id} da fila (modo dev).`);
        this.db.removeVoreoItem(row.id);
        this.db.markTranscriptStatus(item.transcriptName, 'skipped-no-url', this.now().toISOString());
        continue;
      }

      try {
        await this.post(item.payload);
        this.db.removeVoreoItem(row.id);
        this.db.markTranscriptStatus(item.transcriptName, 'sent', this.now().toISOString());
        log.info(`retry ok (tentativa ${row.attempts + 1}): ${this.summarize(item.payload)}`);
      } catch (err) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.db.recordVoreoAttempt(row.id, attempts, null, errorMessage(err));
          this.db.markTranscriptStatus(item.transcriptName, 'failed', null);
          log.error(
            `desistindo do envio à Voreo após ${attempts} tentativas (transcript ${item.transcriptName}): ${errorMessage(err)}`
          );
        } else {
          const nextAttemptAt = new Date(
            this.now().getTime() + computeBackoffMs(attempts)
          ).toISOString();
          this.db.recordVoreoAttempt(row.id, attempts, nextAttemptAt, errorMessage(err));
          log.warn(
            `retry falhou (tentativa ${attempts}/${MAX_ATTEMPTS}) — próxima em ${nextAttemptAt}: ${errorMessage(err)}`
          );
        }
      }
    }
  }

  startWorker(intervalMs: number = WORKER_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processQueueOnce().catch((err: unknown) => {
        log.error('worker da fila Voreo falhou', err);
      });
    }, intervalMs);
    this.timer.unref();
    log.info(`worker da fila iniciado (a cada ${Math.round(intervalMs / 1000)} s).`);
  }

  stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  queueDepth(): { pending: number; dead: number } {
    return this.db.countVoreoQueue();
  }

  isConfigured(): boolean {
    return this.webhookUrl !== undefined;
  }

  private async post(payload: VoreoPayload): Promise<void> {
    if (!this.webhookUrl) throw new Error('VOREO_WEBHOOK_URL não configurada.');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetchImpl(this.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Voreo respondeu HTTP ${response.status}`);
    }
  }

  /** Resumo seguro pra log — NUNCA o transcript inteiro. */
  private summarize(payload: VoreoPayload): string {
    return (
      `sessão ${payload.sessionId}, meet ${payload.meetingCode}, ` +
      `${payload.transcript.length} entries, ${payload.participants.length} participantes`
    );
  }
}
