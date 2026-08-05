import type { Db } from '../db.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Google Workspace Events API (https://workspaceevents.googleapis.com/v1).
 *
 * Cria/renova a subscription que faz o Meet publicar eventos
 * (transcript.v2.fileGenerated, conference.v2.ended) no tópico Pub/Sub.
 * Subscriptions expiram — renovamos com PATCH updateMask=ttl no startup
 * e a cada 6 h (agendado no index.ts).
 */

const log = createLogger('google/events');

export const EVENTS_API_BASE_URL = 'https://workspaceevents.googleapis.com/v1';

export const MEET_EVENT_TYPES = [
  'google.workspace.meet.transcript.v2.fileGenerated',
  'google.workspace.meet.conference.v2.ended',
] as const;

/** Todos os Meets do usuário dono do OAuth. */
export const USER_TARGET_RESOURCE = '//cloudidentity.googleapis.com/users/me';

/** Renova quando faltar menos que isso pro expireTime. */
const RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface WorkspaceSubscription {
  name?: string;
  uid?: string;
  targetResource?: string;
  eventTypes?: string[];
  state?: string;
  expireTime?: string;
  ttl?: string;
  notificationEndpoint?: { pubsubTopic?: string };
}

interface Operation {
  name?: string;
  done?: boolean;
  response?: WorkspaceSubscription & { '@type'?: string };
  error?: { code?: number; message?: string };
}

export class EventsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = 'EventsApiError';
  }
}

export interface EventsClientOptions {
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class EventsClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: EventsClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? EVENTS_API_BASE_URL;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { body?: unknown; query?: Record<string, string> } = {}
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new EventsApiError(
        `Workspace Events API ${method} ${path} respondeu HTTP ${response.status}`,
        response.status,
        body
      );
    }
    return (await response.json()) as T;
  }

  /** subscriptions.list exige filter com event_types + target_resource. */
  async listSubscriptions(targetResource: string): Promise<WorkspaceSubscription[]> {
    const filter = `event_types:"${MEET_EVENT_TYPES[0]}" AND target_resource="${targetResource}"`;
    const result = await this.request<{ subscriptions?: WorkspaceSubscription[] }>(
      'GET',
      'subscriptions',
      { query: { filter } }
    );
    return result.subscriptions ?? [];
  }

  async getSubscription(name: string): Promise<WorkspaceSubscription> {
    return this.request<WorkspaceSubscription>('GET', name);
  }

  /** Cria a subscription; devolve o resource quando a operação já vem resolvida. */
  async createSubscription(
    targetResource: string,
    pubsubTopic: string
  ): Promise<WorkspaceSubscription | undefined> {
    const operation = await this.request<Operation>('POST', 'subscriptions', {
      body: {
        targetResource,
        eventTypes: [...MEET_EVENT_TYPES],
        notificationEndpoint: { pubsubTopic },
        payloadOptions: { includeResource: false },
      },
    });
    if (operation.error) {
      throw new Error(
        `Criação da subscription falhou: ${operation.error.message ?? 'erro desconhecido'}`
      );
    }
    return operation.response;
  }

  /**
   * Renova via PATCH subscriptions/{id}?updateMask=ttl.
   * ttl "0s" = usar o TTL máximo permitido pela API.
   */
  async renewSubscription(name: string): Promise<WorkspaceSubscription | undefined> {
    const operation = await this.request<Operation>('PATCH', name, {
      query: { updateMask: 'ttl' },
      body: { ttl: '0s' },
    });
    if (operation.error) {
      throw new Error(
        `Renovação da subscription falhou: ${operation.error.message ?? 'erro desconhecido'}`
      );
    }
    return operation.response;
  }
}

// ─── SubscriptionManager ─────────────────────────────────────────────────────

export interface SubscriptionManagerOptions {
  events: EventsClient;
  db: Db;
  pubsubTopic: string | undefined;
  isAuthConnected: () => boolean;
  targetResource?: string;
}

/**
 * Garante que existe uma subscription ativa e renova antes de expirar.
 * Chamado no startup, a cada 6 h e após o OAuth conectar.
 */
export class SubscriptionManager {
  private readonly events: EventsClient;
  private readonly db: Db;
  private readonly pubsubTopic: string | undefined;
  private readonly isAuthConnected: () => boolean;
  private readonly targetResource: string;

  constructor(options: SubscriptionManagerOptions) {
    this.events = options.events;
    this.db = options.db;
    this.pubsubTopic = options.pubsubTopic;
    this.isAuthConnected = options.isAuthConnected;
    this.targetResource = options.targetResource ?? USER_TARGET_RESOURCE;
  }

  async renewIfExpiring(): Promise<void> {
    if (!this.pubsubTopic) {
      log.warn('GOOGLE_PUBSUB_TOPIC não configurado — subscription de eventos NÃO será criada.');
      return;
    }
    if (!this.isAuthConnected()) {
      log.warn('Google ainda não conectado (abra /oauth/start) — adiando setup da subscription.');
      return;
    }

    try {
      const known = this.db.listSubscriptionRows();
      const first = known[0];
      if (first) {
        await this.checkAndRenew(first.name);
        return;
      }

      // Nada salvo localmente: procura na API antes de criar.
      const existing = await this.events.listSubscriptions(this.targetResource);
      const active = existing.find((s) => s.state !== 'DELETED' && s.name);
      if (active?.name) {
        this.persist(active);
        await this.checkAndRenew(active.name);
        return;
      }

      log.info(`criando subscription (${this.targetResource} → ${this.pubsubTopic})…`);
      const created = await this.events.createSubscription(this.targetResource, this.pubsubTopic);
      if (created?.name) {
        this.persist(created);
        log.info(`subscription criada: ${created.name} (expira ${created.expireTime ?? '?'}).`);
      } else {
        // Operação assíncrona ainda pendente — tenta descobrir na próxima rodada.
        log.info('subscription em criação (operação pendente); verificação na próxima rodada.');
      }
    } catch (err) {
      log.error('falha ao criar/renovar subscription de eventos', err);
    }
  }

  private async checkAndRenew(name: string): Promise<void> {
    let sub: WorkspaceSubscription;
    try {
      sub = await this.events.getSubscription(name);
    } catch (err) {
      if (err instanceof EventsApiError && err.status === 404) {
        log.warn(`subscription ${name} não existe mais — removendo registro e recriando.`);
        this.db.deleteSubscription(name);
        await this.renewIfExpiring();
        return;
      }
      throw err;
    }

    if (sub.state === 'DELETED') {
      this.db.deleteSubscription(name);
      await this.renewIfExpiring();
      return;
    }

    this.persist(sub);
    const msLeft = sub.expireTime ? Date.parse(sub.expireTime) - Date.now() : 0;
    if (msLeft > RENEW_THRESHOLD_MS) {
      log.debug(`subscription ${name} ok (expira em ${Math.round(msLeft / 3_600_000)} h).`);
      return;
    }

    log.info(`subscription ${name} expira em breve — renovando (PATCH updateMask=ttl)…`);
    try {
      const renewed = await this.events.renewSubscription(name);
      if (renewed) this.persist(renewed);
      log.info(`subscription renovada (expira ${renewed?.expireTime ?? '?'}).`);
    } catch (err) {
      log.error(`falha ao renovar subscription ${name}: ${errorMessage(err)}`);
    }
  }

  private persist(sub: WorkspaceSubscription): void {
    if (!sub.name) return;
    this.db.upsertSubscription({
      name: sub.name,
      targetResource: sub.targetResource ?? this.targetResource,
      expireTime: sub.expireTime ?? null,
    });
  }
}
