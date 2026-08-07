import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { Db } from '../src/db.js';
import { RecallClient } from '../src/recall/client.js';
import {
  createChatproHookRouter,
  acharLinkDoMeet,
  lerEvento,
  TETO_BOTS_JANELA,
} from '../src/routes/chatproHook.js';
import { jsonResponse } from './helpers.js';

/**
 * Webhook do chatPro: link do Meet na conversa → bot na sala, sem botão.
 *
 * Este endpoint cria bots que são COBRADOS POR HORA e o chatPro não assina os
 * webhooks dele, então o segredo no caminho é a única barreira — boa parte dos
 * testes aqui é sobre isso.
 */

const SEGREDO = 'segredo-do-webhook-chatpro-123';
const SESSION = '78562bd7-3d56-47ae-9d4f-25dd80e6b024';
const INSTANCE = 'chatpro-fz5qbe2haz';
const BOT_ID = 'bot-criado-123';

const servidores: Server[] = [];
afterEach(() => {
  for (const s of servidores.splice(0)) s.close();
});

interface AppDeTeste {
  baseUrl: string;
  db: Db;
  chamadasRecall: string[];
  /** Roda as tarefas que o webhook agendou pra depois do 200. */
  correrPendentes: () => Promise<void>;
}

async function montarApp(
  options: {
    secret?: string | undefined;
    autoStart?: boolean;
    semApiKey?: boolean;
    aceitarDoCliente?: boolean;
  } = {}
): Promise<AppDeTeste> {
  const db = new Db(':memory:');
  const chamadasRecall: string[] = [];
  const fetchImpl = ((url: string | URL | Request): Promise<Response> => {
    chamadasRecall.push(String(url));
    return Promise.resolve(jsonResponse({ id: BOT_ID }));
  }) as typeof fetch;

  const pendentes: (() => Promise<void>)[] = [];

  const app = express();
  app.use(express.json());
  app.use(
    createChatproHookRouter({
      db,
      recall: options.semApiKey ? undefined : new RecallClient({ apiKey: 'k', fetchImpl }),
      botName: 'chatPro (gravando)',
      secret: 'secret' in options ? options.secret : SEGREDO,
      autoStart: options.autoStart ?? true,
      aceitarDoCliente: options.aceitarDoCliente ?? false,
      agendar: (t) => pendentes.push(t),
    })
  );
  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.' });
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servidores.push(server);
  const addr = server.address();
  const porta = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${porta}`,
    db,
    chamadasRecall,
    correrPendentes: async () => {
      for (const t of pendentes.splice(0)) await t();
    },
  };
}

function eventoMensagem(mensagem: string, over: Record<string, unknown> = {}): unknown {
  return {
    event: 'sent_message',
    event_ts: '2026-08-07T02:19:40.301222',
    message_data: {
      from_me: true,
      id: 'msg-1',
      instance_id: INSTANCE,
      message: mensagem,
      number: '5562999999999@s.whatsapp.net',
      session_id: SESSION,
      type: 'send_message',
      ...over,
    },
  };
}

function postar(base: string, segredo: string, corpo: unknown): Promise<Response> {
  return fetch(`${base}/webhooks/chatpro/${segredo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

describe('detecção do link do Meet', () => {
  it('acha o link no meio de uma frase', () => {
    expect(acharLinkDoMeet('Bom dia! Segue a sala: https://meet.google.com/abc-defg-hij até já')).toBe(
      'https://meet.google.com/abc-defg-hij'
    );
  });

  it('normaliza maiúsculas e ignora o que vem depois', () => {
    expect(acharLinkDoMeet('https://meet.google.com/ABC-DEFG-HIJ?authuser=0')).toBe(
      'https://meet.google.com/abc-defg-hij'
    );
  });

  it('não confunde com outros links do Meet nem com texto solto', () => {
    expect(acharLinkDoMeet('entre em https://meet.google.com/ e crie a sala')).toBeNull();
    expect(acharLinkDoMeet('https://meet.google.com/landing')).toBeNull();
    expect(acharLinkDoMeet('vamos conversar amanhã?')).toBeNull();
    expect(acharLinkDoMeet('')).toBeNull();
  });
});

describe('leitura do payload', () => {
  it('extrai texto, sessão e instância', () => {
    const e = lerEvento(eventoMensagem('oi'));
    expect(e).toMatchObject({
      event: 'sent_message',
      message: 'oi',
      sessionId: SESSION,
      instanceId: INSTANCE,
      fromMe: true,
    });
  });

  it('aguenta payload torto sem quebrar', () => {
    expect(lerEvento(null)).toBeNull();
    expect(lerEvento({})).toBeNull();
    expect(lerEvento('texto')).toBeNull();
    expect(lerEvento({ event: 'sent_message' })).toMatchObject({ message: '', sessionId: null });
  });
});

describe('segurança do endpoint', () => {
  it('segredo errado responde 404 e NÃO cria bot', async () => {
    const app = await montarApp();

    const res = await postar(app.baseUrl, 'segredo-errado-mas-do-tamanho', eventoMensagem(
      'https://meet.google.com/abc-defg-hij'
    ));
    await app.correrPendentes();

    expect(res.status).toBe(404);
    expect(app.chamadasRecall).toHaveLength(0);
    expect(app.db.listMeetings()).toHaveLength(0);
  });

  it('prefixo do segredo não passa', async () => {
    const app = await montarApp();
    const res = await postar(app.baseUrl, SEGREDO.slice(0, 10), eventoMensagem('oi'));
    expect(res.status).toBe(404);
  });

  it('sem CHATPRO_WEBHOOK_SECRET a rota nem existe', async () => {
    const app = await montarApp({ secret: undefined });

    const res = await postar(app.baseUrl, 'qualquer-coisa', eventoMensagem(
      'https://meet.google.com/abc-defg-hij'
    ));

    expect(res.status).toBe(404);
    expect(app.chamadasRecall).toHaveLength(0);
  });
});

describe('disparo automático do bot', () => {
  it('link do Meet na conversa manda o bot, com a sessão amarrada', async () => {
    const app = await montarApp();

    const res = await postar(
      app.baseUrl,
      SEGREDO,
      eventoMensagem('Segue a sala: https://meet.google.com/abc-defg-hij')
    );
    expect(res.status).toBe(200);

    await app.correrPendentes();

    const reunioes = app.db.listMeetings();
    expect(reunioes).toHaveLength(1);
    expect(reunioes[0]).toMatchObject({
      bot_id: BOT_ID,
      session_id: SESSION,
      meeting_code: 'abc-defg-hij',
      chatpro_instance_id: INSTANCE,
    });
  });

  it('responde 200 ANTES de falar com o Recall', async () => {
    const app = await montarApp();

    const res = await postar(
      app.baseUrl,
      SEGREDO,
      eventoMensagem('https://meet.google.com/abc-defg-hij')
    );

    // O 200 já voltou e nada foi chamado ainda: o chatPro não espera o Recall.
    expect(res.status).toBe(200);
    expect(app.chamadasRecall).toHaveLength(0);

    await app.correrPendentes();
    expect(app.chamadasRecall).toHaveLength(1);
  });

  it('link mandado PELO CLIENTE é ignorado por padrão', async () => {
    // O gatilho é TEXTO de mensagem, e num WhatsApp de atendimento quem escreve
    // pode ser qualquer estranho. Aceitar do cliente entregaria a criação de um
    // recurso COBRADO POR HORA a quem tiver o número da empresa.
    const app = await montarApp();

    await postar(
      app.baseUrl,
      SEGREDO,
      eventoMensagem('https://meet.google.com/abc-defg-hij', { from_me: false })
    );
    await app.correrPendentes();

    expect(app.chamadasRecall).toHaveLength(0);
    expect(app.db.listMeetings()).toHaveLength(0);
  });

  it('link do cliente vale quando explicitamente liberado', async () => {
    const app = await montarApp({ aceitarDoCliente: true });

    await postar(
      app.baseUrl,
      SEGREDO,
      eventoMensagem('https://meet.google.com/abc-defg-hij', { from_me: false })
    );
    await app.correrPendentes();

    expect(app.db.listMeetings()).toHaveLength(1);
  });

  it('teto de criação segura uma rajada de links diferentes', async () => {
    const app = await montarApp();

    // Cada link com código diferente escapa do dedup — é assim que uma rajada
    // viraria uma rajada de bots cobrados. O teto é a última defesa.
    const codigos = ['aaa-bbbb-ccc', 'aaa-bbbb-ccd', 'aaa-bbbb-cce', 'aaa-bbbb-ccf',
      'aaa-bbbb-ccg', 'aaa-bbbb-cch', 'aaa-bbbb-cci', 'aaa-bbbb-ccj',
      'aaa-bbbb-cck', 'aaa-bbbb-ccl', 'aaa-bbbb-ccm', 'aaa-bbbb-ccn'];
    for (const c of codigos) {
      await postar(app.baseUrl, SEGREDO, eventoMensagem(`https://meet.google.com/${c}`));
    }
    await app.correrPendentes();

    expect(app.chamadasRecall.length).toBeLessThanOrEqual(TETO_BOTS_JANELA);
    expect(app.chamadasRecall.length).toBe(TETO_BOTS_JANELA);
  });

  it('a mesma sala repetida na conversa não põe um segundo bot', async () => {
    const app = await montarApp();
    const corpo = eventoMensagem('https://meet.google.com/abc-defg-hij');

    await postar(app.baseUrl, SEGREDO, corpo);
    await app.correrPendentes();
    await postar(app.baseUrl, SEGREDO, corpo);
    await app.correrPendentes();

    expect(app.chamadasRecall).toHaveLength(1);
    expect(app.db.listMeetings()).toHaveLength(1);
  });

  it('mensagem sem link é ignorada em silêncio', async () => {
    const app = await montarApp();

    const res = await postar(app.baseUrl, SEGREDO, eventoMensagem('bom dia, tudo certo?'));
    await app.correrPendentes();

    expect(res.status).toBe(200);
    expect(app.chamadasRecall).toHaveLength(0);
  });

  it('evento que não é de mensagem é aceito e ignorado', async () => {
    const app = await montarApp();

    const res = await postar(app.baseUrl, SEGREDO, {
      event: 'opened_session',
      session_data: { id: SESSION, instance_id: INSTANCE },
    });

    // 200 de propósito: um 4xx faria o chatPro reentregar sem parar.
    expect(res.status).toBe(200);
    expect(app.chamadasRecall).toHaveLength(0);
  });

  it('link sem session_id não vira bot — a transcrição não teria onde ir', async () => {
    const app = await montarApp();

    await postar(
      app.baseUrl,
      SEGREDO,
      eventoMensagem('https://meet.google.com/abc-defg-hij', { session_id: null })
    );
    await app.correrPendentes();

    expect(app.chamadasRecall).toHaveLength(0);
  });

  it('CHATPRO_AUTO_START_BOT=false só observa', async () => {
    const app = await montarApp({ autoStart: false });

    const res = await postar(
      app.baseUrl,
      SEGREDO,
      eventoMensagem('https://meet.google.com/abc-defg-hij')
    );
    await app.correrPendentes();

    expect(res.status).toBe(200);
    expect(app.chamadasRecall).toHaveLength(0);
    expect(app.db.listMeetings()).toHaveLength(0);
  });

  it('sem RECALL_API_KEY responde 200 mas registra a falha, sem derrubar nada', async () => {
    const app = await montarApp({ semApiKey: true });

    const res = await postar(
      app.baseUrl,
      SEGREDO,
      eventoMensagem('https://meet.google.com/abc-defg-hij')
    );
    expect(res.status).toBe(200);

    // A tarefa em segundo plano não pode lançar (derrubaria o processo).
    await expect(app.correrPendentes()).resolves.toBeUndefined();
  });
});
