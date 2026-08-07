import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Db } from '../src/db.js';
import { RecallClient } from '../src/recall/client.js';
import { ChatproClient } from '../src/chatpro/client.js';
import { createMeetingsRouter, criarReuniaoSchema } from '../src/routes/meetings.js';
import { jsonResponse } from './helpers.js';

/**
 * Rotas de reunião do Recall.ai. O `fetch` do cliente é sempre injetado —
 * a suíte NUNCA toca a rede. A chave usada aqui é fictícia.
 */

const API_KEY = 'chave-de-teste-123';
const BOT_ID = 'bot-abc-123';
const MEETING_URL = 'https://meet.google.com/abc-defg-hij';
const SESSION_ID = '3f2b4c1a-9d8e-4f00-b111-222233334444';
const BOT_NAME = 'chatPro (gravando)';

interface Chamada {
  url: string;
  method: string | undefined;
  body: unknown;
}

function fetchGravador(respostas: Response[]): { fetchImpl: typeof fetch; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    chamadas.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const resposta = respostas[i];
    i += 1;
    if (!resposta) return Promise.reject(new Error('resposta não preparada no teste'));
    return Promise.resolve(resposta);
  };
  return { fetchImpl, chamadas };
}

interface AppDeTeste {
  baseUrl: string;
  db: Db;
  chamadas: Chamada[];
}

const servidores: Server[] = [];

async function montarApp(options: {
  respostas?: Response[];
  comApiKey?: boolean;
}): Promise<AppDeTeste> {
  const db = new Db(':memory:');
  const { fetchImpl, chamadas } = fetchGravador(options.respostas ?? []);
  const recall =
    options.comApiKey === false ? undefined : new RecallClient({ apiKey: API_KEY, fetchImpl });
  const chatpro = new ChatproClient({ apiUrl: undefined, apiKey: undefined });

  const app = express();
  app.use(express.json());
  app.use(createMeetingsRouter({ db, recall, chatpro, botName: BOT_NAME }));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servidores.push(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, db, chamadas };
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

function criar(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('validação zod de POST /api/meetings', () => {
  it('aceita URL do Meet com sessionId', () => {
    const r = criarReuniaoSchema.safeParse({ meetingUrl: MEETING_URL, sessionId: SESSION_ID });
    expect(r.success).toBe(true);
  });

  it('aceita URL do Meet com query string e sem sessionId', () => {
    const r = criarReuniaoSchema.safeParse({ meetingUrl: `${MEETING_URL}?authuser=0` });
    expect(r.success).toBe(true);
  });

  it('recusa URL que não é do Google Meet', () => {
    for (const url of [
      'https://zoom.us/j/123456',
      'https://evil.example/meet.google.com/abc-defg-hij',
      'http://meet.google.com/abc-defg-hij',
      'abc-defg-hij',
      'https://meet.google.com/',
    ]) {
      const r = criarReuniaoSchema.safeParse({ meetingUrl: url });
      expect(r.success, `deveria recusar ${url}`).toBe(false);
    }
  });

  it('recusa sessionId que não é UUID', () => {
    const r = criarReuniaoSchema.safeParse({ meetingUrl: MEETING_URL, sessionId: 'nao-e-uuid' });
    expect(r.success).toBe(false);
  });
});

describe('POST /api/meetings', () => {
  it('cria o bot no Recall e grava o vínculo bot ↔ sessão', async () => {
    const { baseUrl, db, chamadas } = await montarApp({
      respostas: [jsonResponse({ id: BOT_ID })],
    });

    const res = await criar(baseUrl, { meetingUrl: MEETING_URL, sessionId: SESSION_ID });
    expect(res.status).toBe(201);
    const corpo = (await res.json()) as { meeting: { id: string; botId: string; status: string } };

    // O sessionId precisa viajar no metadata — é o que volta em todo webhook.
    expect(chamadas[0]?.url).toBe('https://us-west-2.recall.ai/api/v1/bot');
    expect(chamadas[0]?.body).toMatchObject({
      meeting_url: MEETING_URL,
      bot_name: BOT_NAME,
      metadata: { session_id: SESSION_ID },
    });

    const gravada = db.getMeetingByBotId(BOT_ID);
    expect(gravada?.id).toBe(corpo.meeting.id);
    expect(gravada?.session_id).toBe(SESSION_ID);
    expect(gravada?.meeting_code).toBe('abc-defg-hij');
    expect(gravada?.status).toBe('created');
    expect(corpo.meeting.status).toBe('created');
  });

  it('aceita reunião sem sessionId (o vínculo pode chegar pelo webhook depois)', async () => {
    const { baseUrl, db, chamadas } = await montarApp({ respostas: [jsonResponse({ id: BOT_ID })] });

    const res = await criar(baseUrl, { meetingUrl: MEETING_URL });
    expect(res.status).toBe(201);
    const meeting = db.getMeetingByBotId(BOT_ID);
    expect(meeting?.session_id).toBeNull();
    // Sem sessão do chatPro, mas o meeting_id vai sempre — é o que reencontra
    // a reunião caso a resposta do createBot se perca.
    expect(chamadas[0]?.body).toHaveProperty('metadata', { meeting_id: meeting?.id });
  });

  it('responde 400 e não chama o Recall quando a URL não é do Meet', async () => {
    const { baseUrl, db, chamadas } = await montarApp({ respostas: [] });

    const res = await criar(baseUrl, { meetingUrl: 'https://zoom.us/j/123' });
    expect(res.status).toBe(400);
    expect(chamadas).toHaveLength(0);
    expect(db.listMeetings()).toHaveLength(0);
  });

  it('responde 503 com mensagem clara quando RECALL_API_KEY não está configurada', async () => {
    const { baseUrl, db } = await montarApp({ comApiKey: false });

    const res = await criar(baseUrl, { meetingUrl: MEETING_URL });
    expect(res.status).toBe(503);
    const corpo = (await res.json()) as { detail: string; hint: string };
    expect(corpo.detail).toContain('RECALL_API_KEY');
    expect(corpo.hint).toContain('.env');
    expect(db.listMeetings()).toHaveLength(0);
  });

  it('chamada repetida NÃO põe um segundo bot na mesma reunião', async () => {
    // O chatPro chama isto por máquina: retry, timeout e duplo clique são
    // esperados. Dois bots = dois robôs visíveis pro cliente e hora dobrada.
    const { baseUrl, db, chamadas } = await montarApp({
      respostas: [jsonResponse({ id: BOT_ID })],
    });

    const primeira = await criar(baseUrl, { meetingUrl: MEETING_URL });
    expect(primeira.status).toBe(201);

    const segunda = await criar(baseUrl, { meetingUrl: MEETING_URL });
    expect(segunda.status).toBe(200);
    const corpo = (await segunda.json()) as { meeting: { id: string }; jaExistia: boolean };
    expect(corpo.jaExistia).toBe(true);

    // Uma única chamada ao Recall, uma única reunião.
    expect(chamadas).toHaveLength(1);
    expect(db.listMeetings()).toHaveLength(1);
    expect(corpo.meeting.id).toBe(db.listMeetings()[0]?.id);
  });

  it('a repetição aproveita pra amarrar a sessão do chatPro que chegou depois', async () => {
    const { baseUrl, db } = await montarApp({ respostas: [jsonResponse({ id: BOT_ID })] });

    await criar(baseUrl, { meetingUrl: MEETING_URL }); // sem sessão ainda
    expect(db.getMeetingByBotId(BOT_ID)?.session_id).toBeNull();

    await criar(baseUrl, { meetingUrl: MEETING_URL, sessionId: SESSION_ID });

    expect(db.getMeetingByBotId(BOT_ID)?.session_id).toBe(SESSION_ID);
    expect(db.listMeetings()).toHaveLength(1);
  });

  it('reunião já encerrada não bloqueia um bot novo na mesma sala', async () => {
    const { baseUrl, db, chamadas } = await montarApp({
      respostas: [jsonResponse({ id: BOT_ID }), jsonResponse({ id: 'bot-2' })],
    });

    await criar(baseUrl, { meetingUrl: MEETING_URL });
    const primeira = db.listMeetings()[0];
    db.updateMeetingStatus(primeira?.id ?? '', 'done');

    // Mesma sala amanhã (ou nova chamada depois de encerrar): tem que valer.
    const nova = await criar(baseUrl, { meetingUrl: MEETING_URL });

    expect(nova.status).toBe(201);
    expect(chamadas).toHaveLength(2);
    expect(db.listMeetings()).toHaveLength(2);
  });

  it('responde 502 quando o Recall recusa (RecallApiError) e deixa a reunião como failed', async () => {
    const { baseUrl, db } = await montarApp({
      respostas: [new Response('Invalid token.', { status: 401 })],
    });

    const res = await criar(baseUrl, { meetingUrl: MEETING_URL });
    expect(res.status).toBe(502);
    const corpo = (await res.json()) as { detail: string; hint?: string };
    expect(corpo.detail).toContain('401');
    expect(corpo.detail).not.toContain(API_KEY);
    expect(corpo.hint).toContain('RECALL_API_KEY');

    // A linha FICA gravada, marcada como failed. Ela é o ponto de reencontro
    // caso o Recall tenha criado o bot mesmo assim (timeout) — sem ela, os
    // webhooks daquele bot não teriam a que se ligar e a reunião se perderia.
    const reunioes = db.listMeetings();
    expect(reunioes).toHaveLength(1);
    expect(reunioes[0]?.status).toBe('failed');
    expect(reunioes[0]?.bot_id).toBeNull();
  });
});

describe('leitura, saída e entrega manual', () => {
  it('GET /api/meetings lista sem o transcript e o detalhe traz falas e participantes', async () => {
    const { baseUrl, db } = await montarApp({ respostas: [] });
    const meeting = db.createMeeting({
      id: 'reuniao-1',
      botId: BOT_ID,
      sessionId: SESSION_ID,
      meetingUrl: MEETING_URL,
      meetingCode: 'abc-defg-hij',
      botName: BOT_NAME,
    });
    db.setMeetingTranscript({
      id: meeting.id,
      transcriptJson: JSON.stringify({
        falas: [{ speaker: 'Maria', text: 'olá', startMs: 0, endMs: 500, isHost: true }],
        participantes: [{ nome: 'Maria', isHost: true, email: null }],
      }),
      durationSeconds: 12,
    });

    const lista = (await (await fetch(`${baseUrl}/api/meetings`)).json()) as {
      meetings: { id: string; temTranscript: boolean; falas?: unknown }[];
    };
    expect(lista.meetings).toHaveLength(1);
    expect(lista.meetings[0]?.temTranscript).toBe(true);
    expect(lista.meetings[0]).not.toHaveProperty('falas');

    const detalhe = (await (await fetch(`${baseUrl}/api/meetings/reuniao-1`)).json()) as {
      meeting: { falas: { text: string }[]; participantes: { nome: string }[] };
    };
    expect(detalhe.meeting.falas[0]?.text).toBe('olá');
    expect(detalhe.meeting.participantes[0]?.nome).toBe('Maria');
  });

  it('GET /api/meetings/:id responde 404 pra id desconhecido', async () => {
    const { baseUrl } = await montarApp({ respostas: [] });
    const res = await fetch(`${baseUrl}/api/meetings/nao-existe`);
    expect(res.status).toBe(404);
  });

  it('POST /api/meetings/:id/leave chama leave_call do bot', async () => {
    const { baseUrl, db, chamadas } = await montarApp({ respostas: [jsonResponse({}, 200)] });
    db.createMeeting({
      id: 'reuniao-2',
      botId: BOT_ID,
      sessionId: null,
      meetingUrl: MEETING_URL,
      meetingCode: 'abc-defg-hij',
      botName: BOT_NAME,
    });

    const res = await fetch(`${baseUrl}/api/meetings/reuniao-2/leave`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(chamadas[0]?.url).toBe(`https://us-west-2.recall.ai/api/v1/bot/${BOT_ID}/leave_call/`);
  });

  it('POST /api/meetings/:id/send-chatpro exige transcrição salva (409)', async () => {
    const { baseUrl, db } = await montarApp({ respostas: [] });
    db.createMeeting({
      id: 'reuniao-3',
      botId: 'bot-sem-transcript',
      sessionId: null,
      meetingUrl: MEETING_URL,
      meetingCode: 'abc-defg-hij',
      botName: BOT_NAME,
    });

    const res = await fetch(`${baseUrl}/api/meetings/reuniao-3/send-chatpro`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(db.getMeeting('reuniao-3')?.chatpro_status).toBe('pending');
  });

  it('POST /api/meetings/:id/send-chatpro sem CHATPRO_API_URL marca skipped-no-url (modo dev)', async () => {
    const { baseUrl, db } = await montarApp({ respostas: [] });
    db.createMeeting({
      id: 'reuniao-4',
      botId: 'bot-com-transcript',
      sessionId: SESSION_ID,
      meetingUrl: MEETING_URL,
      meetingCode: 'abc-defg-hij',
      botName: BOT_NAME,
    });
    db.setMeetingTranscript({
      id: 'reuniao-4',
      transcriptJson: JSON.stringify({
        falas: [{ speaker: 'Maria', text: 'olá', startMs: 0, endMs: 500 }],
        participantes: [{ nome: 'Maria', isHost: true, email: null }],
      }),
      durationSeconds: 12,
    });

    const res = await fetch(`${baseUrl}/api/meetings/reuniao-4/send-chatpro`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'skipped-no-url' });
    expect(db.getMeeting('reuniao-4')?.chatpro_status).toBe('skipped-no-url');
  });

  it('NÃO libera CORS em /api/meetings — transcrição não pode ser lida de outra origem', async () => {
    const { baseUrl } = await montarApp({ respostas: [] });
    const res = await fetch(`${baseUrl}/api/meetings`, {
      headers: { Origin: 'https://site-qualquer.exemplo' },
    });

    // Sem Allow-Origin, o navegador bloqueia a LEITURA da resposta. Sem isso,
    // qualquer site aberto no navegador do atendente faria fetch pra
    // localhost:3333 e baixaria a transcrição das reuniões dos clientes.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
