import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Db } from '../src/db.js';
import { ChatproClient } from '../src/chatpro/client.js';
import { RecallQueueWorker } from '../src/pipeline/recallQueue.js';
import { createRecallHookRouter, analisarCorpoWebhook } from '../src/routes/recallHook.js';

/**
 * Webhook do Recall: assina → enfileira → 200 imediato.
 * O worker é espionado (poke não roda) pra que o teste observe só o
 * enfileiramento, sem depender do processamento assíncrono.
 */

const SEGREDO = 'whsec_' + Buffer.from('segredo-de-webhook-de-teste').toString('base64');
const BOT_ID = 'bot-abc-123';
const SESSION_ID = '3f2b4c1a-9d8e-4f00-b111-222233334444';

function corpoWebhook(event = 'bot.in_call_recording'): string {
  return JSON.stringify({
    event,
    data: {
      data: { code: 'in_call_recording', sub_code: null, updated_at: '2026-08-06T13:00:00Z' },
      bot: { id: BOT_ID, metadata: { session_id: SESSION_ID } },
    },
  });
}

function assinar(id: string, ts: number, corpo: string): string {
  const chave = Buffer.from(SEGREDO.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', chave).update(`${id}.${ts}.${corpo}`, 'utf8').digest('base64')}`;
}

/** Worker de verdade, mas sem cutucar o processamento durante o teste. */
class WorkerEspiao extends RecallQueueWorker {
  cutucadas = 0;
  override poke(): void {
    this.cutucadas += 1;
  }
}

interface AppDeTeste {
  baseUrl: string;
  db: Db;
  worker: WorkerEspiao;
}

const servidores: Server[] = [];

async function montarApp(options: {
  secret?: string | undefined;
  allowInsecure?: boolean;
}): Promise<AppDeTeste> {
  const db = new Db(':memory:');
  const worker = new WorkerEspiao({
    db,
    recall: undefined,
    chatpro: new ChatproClient({ apiUrl: undefined, apiKey: undefined }),
    autoSendChatpro: false,
  });

  const app = express();
  // Mesma ordem do index.ts: o webhook vem ANTES do json() global.
  app.use(
    createRecallHookRouter({
      worker,
      secret: options.secret,
      allowInsecure: options.allowInsecure ?? false,
    })
  );
  app.use(express.json());

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servidores.push(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, db, worker };
}

afterAll(async () => {
  await Promise.all(
    servidores.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        })
    )
  );
});

function entregar(
  baseUrl: string,
  corpo: string,
  headers: Record<string, string>
): Promise<Response> {
  return fetch(`${baseUrl}/webhooks/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: corpo,
  });
}

/** Headers Svix legítimos para o corpo dado. */
function headersAssinados(corpo: string, id = 'msg_1'): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': assinar(id, ts, corpo),
  };
}

describe('POST /webhooks/recall — assinatura', () => {
  it('recusa com 403 e não enfileira quando a assinatura não confere', async () => {
    const { baseUrl, db } = await montarApp({ secret: SEGREDO });
    const corpo = corpoWebhook();

    const res = await entregar(baseUrl, corpo, {
      'webhook-id': 'msg_1',
      'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
      'webhook-signature': 'v1,assinaturaInventada',
    });

    expect(res.status).toBe(403);
    expect(db.countRecallEvents()).toEqual({ pending: 0, done: 0, dead: 0 });
  });

  it('recusa com 403 quando não há segredo configurado (endpoint aberto seria injeção livre)', async () => {
    const { baseUrl, db } = await montarApp({ secret: undefined });
    const corpo = corpoWebhook();

    const res = await entregar(baseUrl, corpo, headersAssinados(corpo));

    expect(res.status).toBe(403);
    expect(db.countRecallEvents().pending).toBe(0);
  });

  it('recusa 403 quando o corpo foi adulterado depois de assinado', async () => {
    const { baseUrl, db } = await montarApp({ secret: SEGREDO });
    const original = corpoWebhook();
    const headers = headersAssinados(original);
    const adulterado = JSON.stringify({ event: 'transcript.done', data: { bot: { id: 'INVASOR' } } });

    const res = await entregar(baseUrl, adulterado, headers);

    expect(res.status).toBe(403);
    expect(db.countRecallEvents().pending).toBe(0);
  });
});

describe('POST /webhooks/recall — enfileiramento', () => {
  it('assinatura válida responde 200, enfileira e cutuca o worker', async () => {
    const { baseUrl, db, worker } = await montarApp({ secret: SEGREDO });
    const corpo = corpoWebhook();

    const res = await entregar(baseUrl, corpo, headersAssinados(corpo));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enfileirado: true });
    expect(db.countRecallEvents().pending).toBe(1);
    const evento = db.getRecallEvent(1);
    expect(evento?.event).toBe('bot.in_call_recording');
    expect(evento?.bot_id).toBe(BOT_ID);
    expect(evento?.webhook_id).toBe('msg_1');
    // O corpo é guardado CRU (é o que o worker reprocessa).
    expect(evento?.payload_json).toBe(corpo);
    expect(worker.cutucadas).toBe(1);
  });

  it('reentrega do mesmo webhook-id não enfileira duas vezes', async () => {
    const { baseUrl, db, worker } = await montarApp({ secret: SEGREDO });
    const corpo = corpoWebhook();
    const headers = headersAssinados(corpo, 'msg_repetido');

    const primeira = await entregar(baseUrl, corpo, headers);
    const segunda = await entregar(baseUrl, corpo, headers);

    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(await segunda.json()).toEqual({ ok: true, enfileirado: false });
    expect(db.countRecallEvents()).toEqual({ pending: 1, done: 0, dead: 0 });
    // Reentrega não gera trabalho novo.
    expect(worker.cutucadas).toBe(1);
  });

  it('corpo malformado responde 200 (sem loop de reentrega) e não enfileira', async () => {
    const { baseUrl, db, worker } = await montarApp({ secret: SEGREDO });

    for (const corpo of ['isto não é json', '[]', '{"sem":"evento"}']) {
      const res = await entregar(baseUrl, corpo, headersAssinados(corpo));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignorado: true });
    }
    expect(db.countRecallEvents()).toEqual({ pending: 0, done: 0, dead: 0 });
    expect(worker.cutucadas).toBe(0);
  });

  it('ALLOW_INSECURE_RECALL=true aceita sem assinatura (só dev)', async () => {
    const { baseUrl, db } = await montarApp({ secret: undefined, allowInsecure: true });
    const corpo = corpoWebhook('bot.joining_call');

    const res = await entregar(baseUrl, corpo, {});

    expect(res.status).toBe(200);
    expect(db.countRecallEvents().pending).toBe(1);
  });

  it('não devolve headers de CORS (webhook não é chamado por navegador)', async () => {
    const { baseUrl } = await montarApp({ secret: SEGREDO });
    const corpo = corpoWebhook();

    const res = await entregar(baseUrl, corpo, headersAssinados(corpo));

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('análise do corpo cru do webhook', () => {
  it('extrai event e data.bot.id', () => {
    const corpo = corpoWebhook('transcript.done');
    expect(analisarCorpoWebhook(corpo)).toEqual({
      event: 'transcript.done',
      botId: BOT_ID,
      payloadJson: corpo,
    });
  });

  it('aceita webhook sem bot.id (botId nulo) e recusa o que não tem event', () => {
    expect(analisarCorpoWebhook(JSON.stringify({ event: 'recording.done' }))?.botId).toBeNull();
    expect(analisarCorpoWebhook('{}')).toBeNull();
    expect(analisarCorpoWebhook('nada disso')).toBeNull();
  });
});
