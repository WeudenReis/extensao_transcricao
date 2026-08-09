import { createLogger } from '../log.js';
import {
  recallBaseUrl,
  type RecallBot,
  type RecallRegion,
  type RecallTranscript,
} from './types.js';

/**
 * Cliente da API do Recall.ai.
 *
 * - Auth: header `Authorization: Token {RECALL_API_KEY}`.
 * - Timeout de 20 s por requisição (AbortController) — o webhook do Recall exige
 *   resposta em 15 s, então nada aqui pode ficar pendurado indefinidamente.
 * - Erro tipado `RecallApiError` com status + trecho do corpo.
 *
 * REGRAS DE LOG (inegociáveis):
 * - a API key NUNCA aparece em log, mensagem de erro ou payload;
 * - o transcript NUNCA é logado (LGPD) — só a contagem de blocos;
 * - o `download_url` é um link ASSINADO: logamos só se existe, nunca o valor.
 */

const log = createLogger('recall');

export const RECALL_TIMEOUT_MS = 20_000;

/** Quantos caracteres do corpo do erro guardamos (o suficiente pra diagnosticar). */
const ERROR_BODY_LIMIT = 500;

export class RecallApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    /** true quando a requisição estourou o timeout (status 0). */
    readonly timedOut: boolean = false
  ) {
    super(message);
    this.name = 'RecallApiError';
  }
}

export interface RecallClientOptions {
  apiKey: string;
  region?: RecallRegion;
  /** Injetável nos testes — nunca rede real na suíte. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Sobrescreve a base derivada da região (testes/ambientes). */
  baseUrl?: string;
}

export interface CreateBotInput {
  meetingUrl: string;
  botName: string;
  /**
   * Id da linha em `meetings`, gravada ANTES desta chamada. Vai em
   * `metadata.meeting_id` e volta em todo webhook — é o que permite reencontrar
   * a reunião se a resposta do createBot se perder (timeout) e o bot existir
   * mesmo assim.
   */
  meetingId: string;
  /** Vai em `metadata.session_id` e volta em todo webhook. */
  sessionId?: string | undefined;
  /**
   * Horário em que o bot deve entrar na sala (`join_at`). Sem isto o Recall
   * manda o bot na hora — que é o clique normal do atendente.
   *
   * Quem decide se vale a pena agendar é o `criarReuniao`: o Recall pede
   * antecedência mínima, e um `join_at` quase colado no agora só adiaria a
   * entrada sem ganho nenhum.
   */
  joinAt?: Date | undefined;
}

export class RecallClient {
  private readonly apiKey: string;
  private readonly region: RecallRegion;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RecallClientOptions) {
    this.apiKey = options.apiKey;
    this.region = options.region ?? 'us-west-2';
    this.baseUrl = (options.baseUrl ?? recallBaseUrl(this.region)).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? RECALL_TIMEOUT_MS;
  }

  /** Cria o bot e o manda entrar na reunião. */
  async createBot(input: CreateBotInput): Promise<RecallBot> {
    const body: Record<string, unknown> = {
      meeting_url: input.meetingUrl,
      bot_name: input.botName,
      /**
       * Quando o bot vai embora sozinho. Deixar no padrão é arriscado por dois
       * motivos: bot esquecido numa sala CUSTA POR HORA, e bot que fica depois
       * do fim pode acabar gravando a reunião seguinte na mesma sala — que
       * seria a conversa de outro cliente indo parar no atendimento errado.
       */
      automatic_leave: {
        // Sai 2 s depois que todo mundo saiu. É o padrão do Recall e é o que
        // impede o bot de atravessar pra próxima reunião da mesma sala.
        everyone_left_timeout: 2,
        // Ninguém admitiu em 5 min? Não vão admitir. O padrão é 20 min, e são
        // 20 min de bot parado sendo cobrado.
        waiting_room_timeout: 300,
        // Entrou mas ninguém apareceu.
        noone_joined_timeout: 300,
        // Teto duro: reunião nenhuma passa disso, e uma sala que ficou aberta
        // por engano não vira uma fatura de dias.
        in_call_recording_timeout: 4 * 60 * 60,
      },
      recording_config: {
        transcript: { provider: { recallai_streaming: {} } },
      },
    };
    // Bot agendado: o Recall guarda o pedido e manda o bot no horário. O campo
    // é ISO 8601 — mandar o Date cru viraria um objeto vazio no JSON.
    if (input.joinAt) body.join_at = input.joinAt.toISOString();

    // O metadata volta em TODO webhook — é por ele que a transcrição
    // reencontra a reunião e a conversa do chatPro.
    const metadata: Record<string, string> = { meeting_id: input.meetingId };
    if (input.sessionId) metadata.session_id = input.sessionId;
    body.metadata = metadata;

    const bot = await this.request<RecallBot>('POST', 'bot', body);
    // Sem `id` não há como casar webhook nenhum. O better-sqlite3 aceitaria
    // `undefined` e gravaria NULL em silêncio, e a reunião ficaria "Criada"
    // pra sempre — melhor falhar aqui, com motivo legível.
    if (typeof bot?.id !== 'string' || bot.id === '') {
      throw new RecallApiError(
        'O Recall respondeu sem o id do bot — resposta em formato inesperado.',
        200,
        JSON.stringify(bot).slice(0, 500)
      );
    }
    log.info(
      `bot ${bot.id} criado (região ${this.region})` +
        (input.joinAt ? `, entra em ${input.joinAt.toISOString()}` : '')
    );
    return bot;
  }

  async getBot(botId: string): Promise<RecallBot> {
    return this.request<RecallBot>('GET', `bot/${encodeURIComponent(botId)}`);
  }

  /** Tira o bot da chamada (encerra a gravação sem esperar a reunião acabar). */
  async leaveCall(botId: string): Promise<void> {
    await this.request<unknown>('POST', `bot/${encodeURIComponent(botId)}/leave_call/`, {});
    log.info(`bot ${botId} saiu da chamada a pedido`);
  }

  /**
   * Link temporário do transcript, extraído de
   * `recordings[0].media_shortcuts.transcript.data.download_url`.
   * Devolve null quando a gravação ainda não tem transcript pronto.
   */
  async getTranscriptDownloadUrl(botId: string): Promise<string | null> {
    const bot = await this.getBot(botId);
    const url = bot.recordings?.[0]?.media_shortcuts?.transcript?.data?.download_url;
    const found = typeof url === 'string' && url !== '' ? url : null;
    log.debug(`bot ${botId}: transcript ${found ? 'disponível' : 'ainda sem download_url'}`);
    return found;
  }

  /**
   * Baixa o JSON do transcript. A URL já vem assinada — mandar a API key junto
   * seria vazá-la pro storage, então esta chamada vai SEM header de auth.
   */
  async downloadTranscript(url: string): Promise<RecallTranscript[]> {
    const response = await this.send('GET', url, undefined, {});
    if (!response.ok) {
      throw new RecallApiError(
        `Download do transcript respondeu HTTP ${response.status}`,
        response.status,
        await this.safeBody(response)
      );
    }
    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) {
      throw new RecallApiError('Transcript baixado não é uma lista de blocos.', 0, '');
    }
    log.info(`transcript baixado: ${parsed.length} blocos`);
    return parsed as RecallTranscript[];
  }

  // ─── interno ──────────────────────────────────────────────────────────────

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/${path}`;
    const headers: Record<string, string> = {
      Authorization: `Token ${this.apiKey}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.send(method, url, body, headers);
    if (!response.ok) {
      const detail = await this.safeBody(response);
      throw new RecallApiError(
        `Recall API ${method} /${path} respondeu HTTP ${response.status}`,
        response.status,
        detail
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.trim() === '') return undefined as T;
    return JSON.parse(text) as T;
  }

  /** fetch com timeout; converte abort/erro de rede em RecallApiError. */
  private async send(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    headers: Record<string, string>
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new RecallApiError(
          `Recall API ${method} não respondeu em ${Math.round(this.timeoutMs / 1000)} s (timeout).`,
          0,
          '',
          true
        );
      }
      // Falha de rede (DNS, conexão recusada…) — a mensagem do fetch nunca traz a key.
      throw new RecallApiError(
        `Recall API ${method} falhou: ${err instanceof Error ? err.message : String(err)}`,
        0,
        ''
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Corpo do erro, truncado e à prova de stream já consumido. */
  private async safeBody(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.slice(0, ERROR_BODY_LIMIT);
    } catch {
      return '';
    }
  }
}
