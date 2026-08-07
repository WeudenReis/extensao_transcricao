import { Router, raw } from 'express';
import type { RecallQueueWorker } from '../pipeline/recallQueue.js';
import { extrairBotId, extrairEvento } from '../pipeline/recallQueue.js';
import { podeAceitar } from '../recall/verify.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Webhook do Recall.ai: POST /webhooks/recall
 *
 * Regras do fornecedor: responder 2xx em até 15 s, reentrega por 24 h, endpoint
 * que falha 5 dias seguidos é DESATIVADO. Por isso o fluxo é:
 *
 *   assinatura → enfileira → 200 na hora → só então cutuca o worker
 *
 * Corpo CRU obrigatório: a assinatura Svix é HMAC sobre os bytes exatos que
 * chegaram. Um express.json() antes daqui reserializaria o corpo e QUALQUER
 * diferença (espaço, ordem de chave) derrubaria a verificação — por isso esta
 * rota traz o próprio express.raw() e é registrada ANTES do json() global.
 *
 * Nada do corpo vai para o log: o payload carrega metadados do cliente.
 */

const log = createLogger('routes/recallHook');

/** 5 MB: o payload do webhook é pequeno; o teto é só anti-abuso. */
const LIMITE_CORPO = '5mb';

export interface WebhookAnalisado {
  event: string;
  botId: string | null;
  /** Corpo cru, guardado como veio (é o que o worker reprocessa). */
  payloadJson: string;
}

/**
 * Lê o corpo cru do webhook. Devolve null quando não é JSON de objeto ou não
 * tem `event` — casos em que reentregar não resolveria nada.
 */
export function analisarCorpoWebhook(cru: string): WebhookAnalisado | null {
  let json: unknown;
  try {
    json = JSON.parse(cru);
  } catch {
    return null;
  }
  const event = extrairEvento(json);
  if (!event) return null;
  return { event, botId: extrairBotId(json) ?? null, payloadJson: cru };
}

export interface RecallHookRouterDeps {
  worker: RecallQueueWorker;
  /** RECALL_WEBHOOK_SECRET (whsec_…) criado no dashboard da região. */
  secret: string | undefined;
  /** ALLOW_INSECURE_RECALL=true — aceitar sem assinatura (APENAS dev). */
  allowInsecure: boolean;
}

export function createRecallHookRouter(deps: RecallHookRouterDeps): Router {
  const { worker, secret, allowInsecure } = deps;
  const router = Router();

  // Sem apiCors de propósito: webhook não é chamado por navegador.
  router.post(
    '/webhooks/recall',
    // type '*/*' de propósito: a rota é exclusiva do webhook, e amarrar em
    // 'application/json' faria um Content-Type inesperado chegar com req.body
    // vazio — o que viraria 403 em TODO webhook, em silêncio.
    raw({ type: '*/*', limit: LIMITE_CORPO }),
    (req, res) => {
      const cru: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const webhookId = cabecalho(req.headers['webhook-id']);

      // 1. Assinatura primeiro — nada é lido do corpo antes disso.
      const veredito = podeAceitar({
        secret: secret ?? '',
        webhookId,
        webhookTimestamp: cabecalho(req.headers['webhook-timestamp']),
        webhookSignature: cabecalho(req.headers['webhook-signature']),
        body: cru,
        permitirInseguro: allowInsecure,
      });
      if (!veredito.ok) {
        log.warn(`webhook recusado: ${veredito.motivo}.`);
        res.status(403).json({ error: 'Assinatura do webhook inválida.' });
        return;
      }

      // 2. Corpo malformado: 200 mesmo assim. Um 4xx aqui só faria o Recall
      //    reentregar por 24 h um payload que nunca vai ficar bom.
      const analisado = analisarCorpoWebhook(cru.toString('utf8'));
      if (!analisado) {
        log.warn('corpo do webhook malformado ou sem "event" — aceito e descartado.');
        res.status(200).json({ ok: true, ignorado: true });
        return;
      }

      // 3. Fila durável ANTES de responder; falha de gravação → 500 (reentrega).
      let enfileirado: { id: number; created: boolean };
      try {
        enfileirado = worker.enqueueFromWebhook({
          event: analisado.event,
          botId: analisado.botId,
          payloadJson: analisado.payloadJson,
          webhookId: webhookId ?? null,
        });
      } catch (err) {
        log.error('falha ao gravar webhook do Recall na fila durável', err);
        res.status(500).json({ error: 'Falha ao persistir o evento.', detail: errorMessage(err) });
        return;
      }

      // 4. Responde IMEDIATAMENTE e só depois trabalha (limite de 15 s).
      res.status(200).json({ ok: true, enfileirado: enfileirado.created });
      if (enfileirado.created) worker.poke();
    }
  );

  return router;
}

/** Header pode vir como array quando repetido — fica com o primeiro. */
function cabecalho(valor: string | string[] | undefined): string | undefined {
  if (Array.isArray(valor)) return valor[0];
  return valor;
}
