import { Router, type Request, type Response, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, MeetingRow } from '../db.js';
import { RecallApiError, type RecallClient } from '../recall/client.js';
import type { ChatproClient } from '../chatpro/client.js';
import { normalizeMeetingCode } from '../google/meet.js';
import {
  AVISO_PAINEL_INCERTO,
  entregarAoChatproComTrava,
  entregarAoPainel,
  lerTranscriptSalvo,
  painelPrecisaConfirmacao,
  type OpcoesEntrega,
} from '../pipeline/recallQueue.js';
import { criarReuniao } from '../recall/criarReuniao.js';
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
  atendenteEmail: string | null;
  tipo: string | null;
  palavras: string[];
  /** pendente | enviado | falhou | incerto — entrega ao painel de reuniões. */
  painelStatus: string | null;
  /** A reunião nasceu no painel? Sem isso não há pra onde mandar. */
  temPainel: boolean;
  error: string | null;
  createdAt: string;
  temTranscript: boolean;
}

/** JSON de palavras estragado não pode derrubar a listagem. */
function lerPalavras(json: string | null): string[] {
  if (!json) return [];
  try {
    const bruto: unknown = JSON.parse(json);
    return Array.isArray(bruto) ? bruto.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
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
    // Fluxo comercial: quem responde pela reunião, o tipo dela e o que a
    // transcrição revelou. O painel exibe os três.
    atendenteEmail: row.atendente_email,
    tipo: row.tipo,
    palavras: lerPalavras(row.palavras_json),
    // Entrega da transcrição ao painel. Precisa aparecer na tela: 'incerto'
    // (timeout no POST, sem saber se chegou) não se resolve sozinho e o único
    // sinal era um log.warn — o supervisor via "enviado ao chatPro ✓" e
    // concluía que estava tudo entregue, com a transcrição pendurada.
    painelStatus: row.painel_status,
    temPainel: Boolean(row.painel_meeting_id),
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
  /**
   * O que a entrega manual usa (resumo por IA, link, painel de reuniões).
   * Ausente = entrega só o comentário no chatPro, sem subir nada pro painel.
   */
  entrega?: OpcoesEntrega | undefined;
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

export function createMeetingsRouter(deps: MeetingsRouterDeps): Router {
  const { db, recall, chatpro, botName } = deps;
  const opcoesEntrega = deps.entrega ?? {};
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

      // Dedup, pré-gravação e metadata vivem no serviço: o webhook do chatPro
      // cria reunião pelo MESMO caminho, e as garantias precisam valer nos dois.
      const r = await criarReuniao(
        { db, recall, botName },
        {
          meetingUrl: parsed.data.meetingUrl,
          sessionId: parsed.data.sessionId ?? null,
          origem: 'api',
        }
      );

      if (!r.ok) {
        res.status(r.status).json({
          error:
            r.status === 503 ? 'Recall.ai não configurado.' : 'Falha ao criar o bot no Recall.ai.',
          detail: r.erro,
          ...(r.hint ? { hint: r.hint } : {}),
          ...(r.meeting ? { meeting: resumirReuniao(r.meeting) } : {}),
        });
        return;
      }
      res
        .status(r.criada ? 201 : 200)
        .json({ meeting: resumirReuniao(r.meeting), ...(r.criada ? {} : { jaExistia: true }) });
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
    // Reenvio SÓ pro painel, sem passar pelo chatPro.
    //
    // Existe porque o caminho anterior era inalcançável no caso mais comum: se
    // o comentário no chatPro já saiu (chatpro_status='sent') e o POST do
    // painel deu timeout, o botão de envio fica desabilitado — e a transcrição,
    // que é o entregável do produto lá, nunca subia. O único sinal era um
    // log.warn a cada passada do worker.
    '/api/meetings/:id/send-painel',
    assincrono<ParamsId>(async (req, res) => {
      const meeting = db.getMeeting(req.params.id);
      if (!meeting) {
        res.status(404).json({ error: 'Reunião não encontrada.' });
        return;
      }
      if (!meeting.painel_meeting_id) {
        res.status(409).json({
          error: 'Essa reunião não nasceu no painel — não há pra onde mandar a transcrição.',
        });
        return;
      }
      const salvo = lerTranscriptSalvo(meeting.transcript_json);
      if (!salvo || salvo.falas.length === 0) {
        res.status(409).json({ error: 'Reunião ainda sem transcrição.' });
        return;
      }

      // A confirmação explícita é o que separa "reenviar o que falhou" de
      // "gravar a transcrição do cliente em dobro". Só o operador que conferiu
      // no painel pode mandar `forcar=true`.
      const forcar = req.query.forcar === 'true';
      if (painelPrecisaConfirmacao(meeting) && !forcar) {
        res.status(409).json({
          error: 'A entrega anterior ficou incerta.',
          detail:
            'O painel pode já ter salvo esta transcrição e só a resposta ter se perdido. ' +
            'Confira lá; se não estiver, repita com ?forcar=true.',
          precisaConfirmar: true,
        });
        return;
      }

      const estado = await entregarAoPainel(db, meeting, salvo, {
        ...opcoesEntrega,
        forcarPainel: forcar,
      });
      log.info(`reenvio ao painel da reunião ${meeting.id}: ${estado}`);
      const depois = db.getMeeting(meeting.id);
      res.status(estado === 'falhou' ? 502 : 200).json({
        estado,
        painelStatus: depois?.painel_status ?? null,
      });
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
      // Reenvio CONSCIENTE ao painel. Quando a entrega anterior ficou 'incerto'
      // (timeout: o painel pode ter salvo e só a resposta ter se perdido),
      // repetir o POST grava a transcrição do cliente em dobro lá — a API do
      // painel não tem Idempotency-Key e não dá pra desfazer daqui. Então o
      // reenvio ao painel só acontece com `?forcar=true`, que é o operador
      // dizendo "conferi no painel, pode mandar". Sem isso, o botão continua
      // reenviando o comentário ao chatPro e o painel fica de fora.
      const forcar = req.query.forcar === 'true';
      if (forcar && painelPrecisaConfirmacao(meeting)) {
        log.warn(
          `reenvio FORÇADO da transcrição da reunião ${meeting.id} ao painel — ` +
            'estava incerta e alguém confirmou pela interface.'
        );
      }
      const resultado = await entregarAoChatproComTrava(db, chatpro, meeting, {
        ...opcoesEntrega,
        forcarPainel: forcar,
      });
      log.info(`envio manual ao chatPro da reunião ${meeting.id}: ${resultado.status}`);

      // O estado do painel é lido DEPOIS da entrega: é o que diz se a
      // transcrição está confirmada lá, se ficou em dúvida ou se nem foi.
      const depois = db.getMeeting(meeting.id);
      const incerto = depois !== undefined && painelPrecisaConfirmacao(depois);
      // 'skipped-no-url' não é erro: é o modo dev, sem CHATPRO_API_URL.
      res.status(resultado.status === 'failed' ? 502 : 200).json({
        ...resultado,
        painelStatus: depois?.painel_status ?? null,
        // O aviso é o que impede o clique automático de virar duplicidade:
        // quem for reenviar precisa ler que ela PODE já estar no painel.
        ...(incerto ? { aviso: AVISO_PAINEL_INCERTO, painelPrecisaConfirmacao: true } : {}),
      });
    })
  );

  return router;
}
