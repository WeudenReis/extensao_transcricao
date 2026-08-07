import { Router, type Request, type Response, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, MeetingRow } from '../db.js';
import { RecallApiError, type RecallClient } from '../recall/client.js';
import type { ChatproClient } from '../chatpro/client.js';
import { normalizeMeetingCode } from '../google/meet.js';
import { entregarAoChatpro, lerTranscriptSalvo } from '../pipeline/recallQueue.js';
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
  sessionId: z.string().uuid('sessionId deve ser um UUID (o id da sessão do chatPro).').nullish(),
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

/**
 * Express 4 NÃO encaminha rejeição de handler async pro middleware de erro: a
 * promise rejeita, ninguém responde e a requisição fica pendurada até o cliente
 * desistir — no painel, o botão trava em "Enviando…" pra sempre. Todo handler
 * async daqui passa por este embrulho.
 */
function assincrono<P extends Record<string, string>>(
  handler: (req: Request<P>, res: Response) => Promise<void>
): RequestHandler<P> {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** Rotas com `:id` na URL — evita `string | undefined` em req.params.id. */
type ParamsId = { id: string };

/**
 * Por quanto tempo uma reunião em andamento "segura" o código do Meet contra
 * um segundo bot. 12 h cobre qualquer reunião real com folga, e evita que uma
 * linha travada em 'created' bloqueie a mesma sala no dia seguinte.
 */
export const JANELA_DEDUP_MS = 12 * 60 * 60 * 1000;

export function createMeetingsRouter(deps: MeetingsRouterDeps): Router {
  const { db, recall, chatpro, botName } = deps;
  const router = Router();

  // Sem CORS de propósito. O painel é servido por este mesmo servidor (mesma
  // origem, não precisa), e um Allow-Origin '*' aqui deixaria QUALQUER site
  // aberto no navegador ler a transcrição das reuniões via fetch pra
  // localhost. Transcrição é dado sensível de cliente (LGPD).

  router.post(
    '/api/meetings',
    assincrono(async (req, res) => {
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
      const meetingCode = normalizeMeetingCode(meetingUrl) || null;

      // Já tem bot nesta chamada? Devolve o que existe em vez de mandar outro.
      // Este endpoint é feito pra ser chamado por máquina (o chatPro), então
      // repetição é ESPERADA: retry, timeout, duplo clique do atendente. Cada
      // bot a mais é um robô a mais aparecendo pro cliente e uma hora a mais
      // cobrada. Chamar duas vezes tem que dar o mesmo resultado que uma.
      if (meetingCode) {
        const desde = new Date(Date.now() - JANELA_DEDUP_MS).toISOString();
        const emAndamento = db.findActiveMeetingByCode(meetingCode, desde);
        if (emAndamento) {
          // Aproveita pra amarrar a sessão, se ela só veio agora.
          if (sessionId && !emAndamento.session_id) {
            db.setMeetingSessionId(emAndamento.id, sessionId);
          }
          const atual = db.getMeeting(emAndamento.id) ?? emAndamento;
          log.info(
            `POST /api/meetings repetido pra ${meetingCode} — devolvendo a reunião ` +
              `${atual.id} (${atual.status}) sem criar outro bot.`
          );
          res.status(200).json({ meeting: resumirReuniao(atual), jaExistia: true });
          return;
        }
      }

      // A reunião é gravada ANTES de chamar o Recall, e o id dela viaja em
      // metadata.meeting_id. Motivo: se o createBot estourar o timeout de 20 s
      // DEPOIS que o Recall já criou o bot, o bot entra na reunião do cliente e
      // grava — e sem esta linha no banco não haveria nada pra casar com os
      // webhooks dele. Assim, o primeiro webhook reencontra a reunião pelo
      // metadata e amarra o bot_id.
      const meetingId = randomUUID();
      let meeting = db.createMeeting({
        id: meetingId,
        botId: null,
        sessionId,
        meetingUrl,
        meetingCode,
        botName,
        status: 'created',
      });

      try {
        const bot = await recall.createBot({
          meetingUrl,
          botName,
          meetingId,
          sessionId: sessionId ?? undefined,
        });
        db.setMeetingBotId(meetingId, bot.id);
        meeting = db.getMeeting(meetingId) ?? meeting;
        log.info(
          `reunião ${meetingId} criada: bot ${bot.id}, meet ${meetingCode ?? '?'}, ` +
            `sessão ${sessionId ?? '(sem vínculo)'}.`
        );
        res.status(201).json({ meeting: resumirReuniao(meeting) });
      } catch (err) {
        // A reunião fica registrada como 'failed'. Se o bot existir mesmo assim
        // (timeout com o bot já criado), o webhook a reabre pelo metadata.
        db.updateMeetingStatus(meetingId, 'failed', 'falha ao criar o bot no Recall.ai');
        if (err instanceof RecallApiError) {
          log.error(`falha ao criar bot no Recall (HTTP ${err.status})`, err);
          res.status(502).json({
            error: 'Falha ao criar o bot no Recall.ai.',
            detail: err.message,
            ...(err.timedOut
              ? {
                  hint:
                    'O Recall demorou demais pra responder. O bot PODE ter entrado na reunião ' +
                    'mesmo assim — confira a lista antes de tentar de novo, pra não colocar dois.',
                }
              : {}),
            ...(err.status === 401 || err.status === 403
              ? {
                  hint: 'RECALL_API_KEY inválida ou de outra região — confira RECALL_REGION.',
                }
              : {}),
          });
          return;
        }
        throw err;
      }
    })
  );

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

  router.post(
    '/api/meetings/:id/leave',
    assincrono<ParamsId>(async (req, res) => {
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
    })
  );

  router.post(
    '/api/meetings/:id/send-chatpro',
    assincrono<ParamsId>(async (req, res) => {
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
    })
  );

  return router;
}
