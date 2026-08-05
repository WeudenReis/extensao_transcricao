import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { GoogleAuth } from '../google/auth.js';
import type { MeetApi } from '../google/meet.js';
import { normalizeMeetingCode, MeetApiError } from '../google/meet.js';
import type { VoreoClient } from '../voreo/client.js';
import type { EventQueueWorker } from '../pipeline/eventQueue.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * API consumida pela extensão Chrome e pelo atendente:
 *
 * - POST /api/links   → vínculo sessionId(chatPro) ↔ meetingCode(Meet)
 * - GET  /api/links   → lista os vínculos
 * - POST /api/spaces  → cria space do Meet com transcrição automática ON
 * - GET  /api/health  → liveness
 * - GET  /api/status  → auth Google, subscription, fila Voreo
 */

const log = createLogger('routes/api');

/**
 * CORS apenas para /api/* — a extensão pode apontar pra um backend fora do
 * host_permissions do manifest (VPS/túnel), e o fetch do service worker sofre
 * preflight. Sem credenciais → Allow-Origin * é seguro aqui.
 * NÃO aplicar em /webhooks/* nem /oauth/*.
 */
export const apiCors: RequestHandler = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
};

export const linkBodySchema = z.object({
  sessionId: z.string().uuid('sessionId deve ser um UUID (o id da sessão do chatPro).'),
  meetingCode: z
    .string({ required_error: 'meetingCode é obrigatório.' })
    .min(3, 'meetingCode deve ter ao menos 3 caracteres.')
    .transform(normalizeMeetingCode)
    .refine((code) => code.length >= 3, 'meetingCode inválido após normalização.'),
  // 'auto' = vínculo automático feito pela extensão (fluxo padrão).
  source: z.enum(['auto', 'extension', 'manual', 'api']).default('extension'),
});

export type LinkBody = z.infer<typeof linkBodySchema>;

export interface ApiRouterDeps {
  db: Db;
  meet: MeetApi;
  auth: GoogleAuth;
  voreo: VoreoClient;
  eventQueue: EventQueueWorker;
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const { db, meet, auth, voreo, eventQueue } = deps;
  const router = Router();
  const startedAt = Date.now();

  router.use('/api', apiCors);

  router.post('/api/links', async (req, res) => {
    const parsed = linkBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Corpo inválido.',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }
    const { sessionId, meetingCode, source } = parsed.data;

    // Best-effort: resolve o space name já no vínculo (facilita o pipeline).
    let spaceName: string | null = null;
    try {
      const space = await meet.getSpaceByMeetingCode(meetingCode);
      spaceName = space.name ?? null;
    } catch (err) {
      const detail =
        err instanceof MeetApiError ? `HTTP ${err.status}` : errorMessage(err);
      log.warn(`não resolvi space p/ meetingCode ${meetingCode} (${detail}) — seguindo sem.`);
    }

    const link = db.upsertLink({ sessionId, meetingCode, spaceName, source });
    log.info(`vínculo salvo: sessão ${sessionId} ↔ meet ${meetingCode} (source=${source}).`);

    // Vínculo novo pode destravar eventos que chegaram antes dele (no-link):
    // reativa e cutuca o worker pra reprocessar agora.
    const reactivated = db.reactivateNoLinkEvents(spaceName, new Date().toISOString());
    if (reactivated > 0) {
      log.info(`${reactivated} evento(s) no-link reativado(s) após o novo vínculo.`);
      eventQueue.poke();
    }

    res.status(201).json({ link });
  });

  router.get('/api/links', (_req, res) => {
    res.json({ links: db.listLinks() });
  });

  router.post('/api/spaces', async (_req, res) => {
    try {
      const space = await meet.createSpaceWithTranscription();
      log.info(`space criado: ${space.name ?? '?'} (${space.meetingCode ?? '?'}).`);
      res.status(201).json({
        name: space.name,
        meetingCode: space.meetingCode,
        meetingUri: space.meetingUri,
        transcription: 'ON',
      });
    } catch (err) {
      log.error('falha ao criar space', err);
      const status = err instanceof MeetApiError && err.status === 401 ? 401 : 502;
      res.status(status).json({
        error: 'Falha ao criar space no Meet.',
        detail: errorMessage(err),
        hint: auth.isConnected()
          ? 'Verifique os escopos/permissões da conta Google conectada.'
          : 'Google não conectado — abra /oauth/start primeiro.',
      });
    }
  });

  router.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  router.get('/api/status', (_req, res) => {
    const queue = voreo.queueDepth();
    const events = eventQueue.queueDepth();
    res.json({
      googleConnected: auth.isConnected(),
      subscriptions: db.listSubscriptionRows(),
      events: {
        pending: events.pending,
        noLink: events.noLink,
        dead: events.dead,
        done: events.done,
      },
      voreo: {
        configured: voreo.isConfigured(),
        queuePending: queue.pending,
        queueDead: queue.dead,
      },
    });
  });

  return router;
}
