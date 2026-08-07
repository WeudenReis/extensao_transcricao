import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, MeetingRow } from '../db.js';
import { RecallApiError, type RecallClient } from '../recall/client.js';
import type { ChatproClient } from '../chatpro/client.js';
import { normalizeMeetingCode } from '../google/meet.js';
import { entregarAoChatpro, lerTranscriptSalvo } from '../pipeline/recallQueue.js';
import { apiCors } from './api.js';
import { createLogger } from '../log.js';

/**
 * Reuniões gravadas pelo bot do Recall.ai:
 *
 *   POST /api/meetings                   → cria o bot e o manda entrar na call
 *   GET  /api/meetings                   → lista (leve, sem transcrição)
 *   GET  /api/meetings/:id               → detalhe com falas e participantes
 *   POST /api/meetings/:id/leave         → tira o bot da chamada
 *   POST /api/meetings/:id/send-chatpro  → entrega manual da transcrição
 *
 * O `sessionId` do chatPro viaja em `metadata.session_id` do bot e volta em
 * TODO webhook — é assim que a transcrição reencontra a conversa certa.
 */

const log = createLogger('routes/meetings');

/**
 * Só URL de reunião do Google Meet. Nada de "qualquer https": mandar uma URL
 * arbitrária pro Recall gastaria hora de bot num lugar que não é nosso.
 */
const MEET_URL = /^https:\/\/meet\.google\.com\/[A-Za-z0-9-]{3,}\/?(\?[^\s]*)?$/;

export const criarReuniaoSchema = z.object({
  meetingUrl: z
    .string({ required_error: 'meetingUrl é obrigatório.' })
    .trim()
    .regex(
      MEET_URL,
      'meetingUrl deve ser a URL da reunião no Google Meet (ex.: https://meet.google.com/abc-defg-hij).'
    ),
  sessionId: z
    .string()
    .uuid('sessionId deve ser um UUID (o id da sessão do chatPro).')
    .nullish(),
});

export type CriarReuniaoBody = z.infer<typeof criarReuniaoSchema>;

/** Reunião como a API devolve — sem o transcript, que é pesado e sensível. */
export interface ResumoReuniao {
  id: string;
  botId: string | null;
  sessionId: string | null;
  meetingUrl: string;
  meetingCode: string | null;
  status: string;
  botName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  chatproStatus: string | null;
  error: string | null;
  createdAt: string;
  temTranscript: boolean;
}

export function resumirReuniao(row: MeetingRow): ResumoReuniao {
  return {
    id: row.id,
    botId: row.bot_id,
    sessionId: row.session_id,
    meetingUrl: row.meeting_url,
    meetingCode: row.meeting_code,
    status: row.status,
    botName: row.bot_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    chatproStatus: row.chatpro_status,
    error: row.error,
    createdAt: row.created_at,
    temTranscript: Boolean(row.transcript_json),
  };
}

export interface MeetingsRouterDeps {
  db: Db;
  /** undefined quando RECALL_API_KEY não está configurada. */
  recall: RecallClient | undefined;
  chatpro: ChatproClient;
  /** RECALL_BOT_NAME — como o bot aparece na lista de participantes. */
  botName: string;
}

const SEM_API_KEY = {
  error: 'Recall.ai não configurado.',
  detail:
    'RECALL_API_KEY está vazia — sem ela o servidor não consegue criar o bot que entra na reunião.',
  hint: 'Preencha RECALL_API_KEY no server/.env (chave da região us-west-2) e reinicie o servidor.',
};

export function createMeetingsRouter(deps: MeetingsRouterDeps): Router {
  const { db, recall, chatpro, botName } = deps;
  const router = Router();

  // CORS igual ao resto de /api/* — a extensão e o painel podem estar em outra origem.
  router.use('/api/meetings', apiCors);

  router.post('/api/meetings', async (req, res) => {
    const parsed = criarReuniaoSchema.safeParse(req.body);
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
    if (!recall) {
      log.warn('POST /api/meetings recusado: RECALL_API_KEY não configurada.');
      res.status(503).json(SEM_API_KEY);
      return;
    }

    const { meetingUrl } = parsed.data;
    const sessionId = parsed.data.sessionId ?? null;

    try {
      const bot = await recall.createBot({
        meetingUrl,
        botName,
        sessionId: sessionId ?? undefined,
      });
      const meetingCode = normalizeMeetingCode(meetingUrl) || null;
      const meeting = db.createMeeting({
        id: randomUUID(),
        botId: bot.id,
        sessionId,
        meetingUrl,
        meetingCode,
        botName,
        status: 'created',
      });
      log.info(
        `reunião ${meeting.id} criada: bot ${bot.id}, meet ${meetingCode ?? '?'}, ` +
          `sessão ${sessionId ?? '(sem vínculo)'}.`
      );
      res.status(201).json({ meeting: resumirReuniao(meeting) });
    } catch (err) {
      if (err instanceof RecallApiError) {
        log.error(`falha ao criar bot no Recall (HTTP ${err.status})`, err);
        res.status(502).json({
          error: 'Falha ao criar o bot no Recall.ai.',
          detail: err.message,
          ...(err.status === 401 || err.status === 403
            ? { hint: 'RECALL_API_KEY inválida ou de outra região — confira RECALL_REGION.' }
            : {}),
        });
        return;
      }
      throw err;
    }
  });

  router.get('/api/meetings', (req, res) => {
    const limite = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limite) ? Math.min(Math.max(limite, 1), 200) : 50;
    res.json({ meetings: db.listMeetings(limit).map(resumirReuniao) });
  });

  router.get('/api/meetings/:id', (req, res) => {
    const meeting = db.getMeeting(req.params.id);
    if (!meeting) {
      res.status(404).json({ error: 'Reunião não encontrada.' });
      return;
    }
    const salvo = lerTranscriptSalvo(meeting.transcript_json);
    res.json({
      meeting: {
        ...resumirReuniao(meeting),
        falas: salvo?.falas ?? [],
        participantes: salvo?.participantes ?? [],
      },
    });
  });

  router.post('/api/meetings/:id/leave', async (req, res) => {
    const meeting = db.getMeeting(req.params.id);
    if (!meeting) {
      res.status(404).json({ error: 'Reunião não encontrada.' });
      return;
    }
    if (!recall) {
      res.status(503).json(SEM_API_KEY);
      return;
    }
    if (!meeting.bot_id) {
      res.status(409).json({ error: 'Reunião sem bot associado — nada a encerrar.' });
      return;
    }
    try {
      await recall.leaveCall(meeting.bot_id);
      log.info(`saída do bot ${meeting.bot_id} pedida (reunião ${meeting.id}).`);
      // O estado final vem pelo webhook bot.call_ended — não forçamos aqui.
      res.json({ ok: true, meeting: resumirReuniao(meeting) });
    } catch (err) {
      if (err instanceof RecallApiError) {
        log.error(`falha ao tirar o bot da chamada (HTTP ${err.status})`, err);
        res.status(502).json({
          error: 'Falha ao tirar o bot da chamada.',
          detail: err.message,
        });
        return;
      }
      throw err;
    }
  });

  router.post('/api/meetings/:id/send-chatpro', async (req, res) => {
    const meeting = db.getMeeting(req.params.id);
    if (!meeting) {
      res.status(404).json({ error: 'Reunião não encontrada.' });
      return;
    }
    if (!meeting.transcript_json) {
      res.status(409).json({
        error: 'Reunião ainda sem transcrição — aguarde o transcript.done do Recall.',
      });
      return;
    }
    const resultado = await entregarAoChatpro(db, chatpro, meeting);
    log.info(`envio manual ao chatPro da reunião ${meeting.id}: ${resultado.status}`);
    // 'skipped-no-url' não é erro: é o modo dev, sem CHATPRO_API_URL.
    res.status(resultado.status === 'failed' ? 502 : 200).json(resultado);
  });

  return router;
}
