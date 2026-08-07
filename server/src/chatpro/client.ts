import { createLogger, errorMessage } from '../log.js';
import type { Fala } from '../recall/transcript.js';

/**
 * Entrega da transcrição ao chatPro.
 *
 * O contrato real da API do chatPro ainda não está definido — este arquivo é o
 * ÚNICO ponto a ajustar quando ele existir (mesma estratégia que usamos com a
 * Voreo). Sem CHATPRO_API_URL, roda em modo dev: não toca a rede e marca a
 * entrega como 'skipped-no-url', sem perder nada (o payload fica no banco).
 */

const log = createLogger('chatpro');

export const MAX_TENTATIVAS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const TIMEOUT_MS = 20_000;

export function backoffMs(tentativasFeitas: number): number {
  const expoente = Math.max(0, tentativasFeitas - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** expoente, MAX_BACKOFF_MS);
}

export interface ChatproPayload {
  sessionId: string | null;
  meetingUrl: string;
  meetingCode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  participants: { nome: string; isHost: boolean; email: string | null }[];
  transcript: Fala[];
  source: 'recall-ai';
}

export type ResultadoEntrega =
  | { ok: true; status: 'sent' }
  | { ok: false; status: 'skipped-no-url' | 'failed'; motivo?: string };

export interface ChatproClientOptions {
  apiUrl: string | undefined;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
}

export class ChatproClient {
  private readonly apiUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ChatproClientOptions) {
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  estaConfigurado(): boolean {
    return Boolean(this.apiUrl);
  }

  async enviar(payload: ChatproPayload): Promise<ResultadoEntrega> {
    if (!this.apiUrl) {
      log.info(`CHATPRO_API_URL vazia — entrega pulada (modo dev). ${this.resumir(payload)}`);
      return { ok: false, status: 'skipped-no-url' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const resposta = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resposta.ok) {
        throw new Error(`chatPro respondeu HTTP ${resposta.status}`);
      }
      log.info(`entregue ao chatPro: ${this.resumir(payload)}`);
      return { ok: true, status: 'sent' };
    } catch (err) {
      const motivo = errorMessage(err);
      log.warn(`falha ao entregar ao chatPro: ${motivo}`);
      return { ok: false, status: 'failed', motivo };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resumo seguro pra log — NUNCA o transcript inteiro (dado do cliente). */
  private resumir(p: ChatproPayload): string {
    return (
      `sessão ${p.sessionId ?? '(sem vínculo)'}, meet ${p.meetingCode ?? '?'}, ` +
      `${p.transcript.length} falas, ${p.participants.length} participante(s)`
    );
  }
}
