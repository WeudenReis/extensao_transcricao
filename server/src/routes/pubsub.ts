import { Router } from 'express';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import type { EventQueueWorker } from '../pipeline/eventQueue.js';
import {
  EVENT_TRANSCRIPT_FILE_GENERATED,
  EVENT_CONFERENCE_ENDED,
  extractResourceName,
} from '../pipeline/eventQueue.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Endpoint push do Cloud Pub/Sub (Workspace Events → tópico → push aqui).
 *
 * Contrato do push:
 *   POST { message: { data: base64(JSON do CloudEvent), attributes: {"ce-type": ...},
 *          messageId, publishTime }, subscription }
 *
 * Segurança:
 * - Com PUBSUB_VERIFICATION_AUDIENCE: valida o OIDC token (Bearer) contra a
 *   audience e, se PUBSUB_SERVICE_ACCOUNT estiver setada, exige também
 *   email === service account e email_verified === true.
 * - SEM audience: rejeita com 403 — a menos que ALLOW_INSECURE_PUBSUB=true
 *   (modo dev explícito, com warning).
 *
 * Durabilidade: o evento validado é INSERIDO na fila durável (event_queue)
 * ANTES do ack 204; o worker processa com retry/backoff. Falha ao gravar →
 * 500, e o Pub/Sub reentrega.
 */

const log = createLogger('routes/pubsub');

// Re-exports de compatibilidade (constantes/helpers vivem na fila de eventos).
export { EVENT_TRANSCRIPT_FILE_GENERATED, EVENT_CONFERENCE_ENDED, extractResourceName };

// ─── Decodificação (pura, testável) ──────────────────────────────────────────

const pushBodySchema = z.object({
  message: z.object({
    data: z.string().optional(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

export interface DecodedPushMessage {
  ceType: string | undefined;
  payload: Record<string, unknown>;
  attributes: Record<string, string>;
  messageId: string | undefined;
  publishTime: string | undefined;
  subscription: string | undefined;
}

/** base64(JSON do CloudEvent) → objeto; ce-type vem dos attributes. */
export function decodePubSubPush(body: unknown): DecodedPushMessage {
  const parsed = pushBodySchema.parse(body);
  const attributes = parsed.message.attributes ?? {};

  let payload: Record<string, unknown> = {};
  if (parsed.message.data) {
    const text = Buffer.from(parsed.message.data, 'base64').toString('utf8');
    const json: unknown = JSON.parse(text);
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      payload = json as Record<string, unknown>;
    }
  }

  return {
    ceType: attributes['ce-type'],
    payload,
    attributes,
    messageId: parsed.message.messageId,
    publishTime: parsed.message.publishTime,
    subscription: parsed.subscription,
  };
}

// ─── Verificação OIDC ────────────────────────────────────────────────────────

export interface OidcTokenInfo {
  email: string | undefined;
  emailVerified: boolean;
}

export interface TokenVerifier {
  verify(idToken: string, audience: string): Promise<OidcTokenInfo>;
}

export class GoogleOidcVerifier implements TokenVerifier {
  private readonly client = new OAuth2Client();

  async verify(idToken: string, audience: string): Promise<OidcTokenInfo> {
    const ticket = await this.client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    return {
      email: payload?.email,
      emailVerified: payload?.email_verified === true,
    };
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export interface PubSubRouterDeps {
  eventQueue: EventQueueWorker;
  audience: string | undefined;
  /** E-mail do service account configurado na push subscription (OIDC). */
  serviceAccount: string | undefined;
  /** ALLOW_INSECURE_PUBSUB=true — aceitar push sem OIDC (APENAS dev). */
  allowInsecure: boolean;
  verifier?: TokenVerifier;
}

export function createPubSubRouter(deps: PubSubRouterDeps): Router {
  const { eventQueue, audience, serviceAccount, allowInsecure } = deps;
  const verifier = deps.verifier ?? new GoogleOidcVerifier();
  const router = Router();
  let warnedInsecure = false;
  let warnedNoServiceAccount = false;

  router.post('/webhooks/pubsub', async (req, res) => {
    // 1. Autenticação do push (OIDC).
    if (!audience) {
      if (!allowInsecure) {
        log.warn(
          'push rejeitado: PUBSUB_VERIFICATION_AUDIENCE não configurada. ' +
            'Configure a audience da push subscription — ou, APENAS em dev, sete ALLOW_INSECURE_PUBSUB=true.'
        );
        res.status(403).send('Webhook exige validação OIDC (audience não configurada).');
        return;
      }
      if (!warnedInsecure) {
        warnedInsecure = true;
        log.warn(
          'ALLOW_INSECURE_PUBSUB=true — aceitando pushes SEM validação de OIDC. ' +
            'NUNCA use assim em produção.'
        );
      }
    } else {
      const header = req.headers.authorization ?? '';
      const idToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
      if (!idToken) {
        res.status(401).send('Authorization Bearer ausente.');
        return;
      }
      let info: OidcTokenInfo;
      try {
        info = await verifier.verify(idToken, audience);
      } catch (err) {
        log.warn(`OIDC token inválido no push: ${errorMessage(err)}`);
        res.status(403).send('OIDC token inválido.');
        return;
      }
      if (serviceAccount) {
        if (info.email !== serviceAccount || !info.emailVerified) {
          log.warn(
            `push rejeitado: OIDC de ${info.email ?? '(sem email)'} ` +
              `(verified=${String(info.emailVerified)}) não corresponde a PUBSUB_SERVICE_ACCOUNT.`
          );
          res.status(403).send('OIDC token não pertence ao service account esperado.');
          return;
        }
      } else if (!warnedNoServiceAccount) {
        warnedNoServiceAccount = true;
        log.warn(
          'PUBSUB_SERVICE_ACCOUNT não configurado — aceitando qualquer identity token do Google ' +
            'com a audience correta. Configure o e-mail do service account da push subscription.'
        );
      }
    }

    // 2. Decodifica; malformadas são ack-adas (2xx) pra não virar loop de redelivery.
    let decoded: DecodedPushMessage;
    try {
      decoded = decodePubSubPush(req.body);
    } catch (err) {
      log.warn(`push malformado (ack pra evitar redelivery): ${errorMessage(err)}`);
      res.status(204).end();
      return;
    }

    // 3. Durabilidade: grava na fila ANTES do ack; falha de gravação → 500 (redelivery).
    let enqueued: boolean;
    try {
      enqueued = eventQueue.enqueueFromPush(decoded);
    } catch (err) {
      log.error('falha ao gravar evento na fila durável — pedindo redelivery ao Pub/Sub', err);
      res.status(500).send('Falha ao persistir evento.');
      return;
    }

    // 4. Ack imediato; worker processa async (cutucado agora).
    res.status(204).end();
    if (enqueued) eventQueue.poke();
  });

  return router;
}
