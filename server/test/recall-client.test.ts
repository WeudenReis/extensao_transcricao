import { describe, it, expect } from 'vitest';
import { RecallClient, RecallApiError } from '../src/recall/client.js';
import type { RecallBot } from '../src/recall/types.js';
import { jsonResponse } from './helpers.js';

/**
 * Cliente do Recall.ai — `fetch` sempre injetado, NUNCA rede real.
 * A chave usada aqui é fictícia.
 */

const API_KEY = 'chave-de-teste-123';
const BOT_ID = 'bot-abc-123';
const MEETING_URL = 'https://meet.google.com/abc-defg-hij';
const SESSION_ID = '3f2b4c1a-9d8e-4f00-b111-222233334444';

interface Chamada {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** fetch falso que registra o que foi chamado e devolve as respostas na ordem. */
function fetchGravador(respostas: Response[]): { fetchImpl: typeof fetch; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    chamadas.push({
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const resposta = respostas[i];
    i += 1;
    if (!resposta) return Promise.reject(new Error('resposta não preparada no teste'));
    return Promise.resolve(resposta);
  };
  return { fetchImpl, chamadas };
}

function botComTranscript(downloadUrl: string | null): RecallBot {
  return {
    id: BOT_ID,
    recordings: [
      {
        id: 'rec-1',
        media_shortcuts: {
          transcript: {
            id: 'tr-1',
            status: { code: 'done' },
            data: downloadUrl === null ? null : { download_url: downloadUrl },
          },
        },
      },
    ],
  };
}

describe('RecallClient — criação do bot', () => {
  it('manda body e headers corretos para POST /api/v1/bot', async () => {
    const { fetchImpl, chamadas } = fetchGravador([jsonResponse({ id: BOT_ID })]);
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    const bot = await client.createBot({
      meetingUrl: MEETING_URL,
      botName: 'chatPro (gravando)',
      sessionId: SESSION_ID,
    });

    expect(bot.id).toBe(BOT_ID);
    expect(chamadas).toHaveLength(1);
    const chamada = chamadas[0];
    expect(chamada?.url).toBe('https://us-west-2.recall.ai/api/v1/bot');
    expect(chamada?.method).toBe('POST');
    expect(chamada?.headers.authorization).toBe(`Token ${API_KEY}`);
    expect(chamada?.headers['content-type']).toBe('application/json');
    expect(chamada?.body).toEqual({
      meeting_url: MEETING_URL,
      bot_name: 'chatPro (gravando)',
      recording_config: { transcript: { provider: { recallai_streaming: {} } } },
      metadata: { session_id: SESSION_ID },
    });
  });

  it('sem sessionId, ainda manda meeting_id (o vínculo do chatPro chega depois)', async () => {
    const { fetchImpl, chamadas } = fetchGravador([jsonResponse({ id: BOT_ID })]);
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    await client.createBot({
      meetingUrl: MEETING_URL,
      botName: 'chatPro (gravando)',
      meetingId: 'reuniao-xyz',
    });

    // meeting_id é obrigatório: é ele que reencontra a reunião se a resposta
    // desta chamada se perder no timeout e o bot existir mesmo assim.
    expect(chamadas[0]?.body).toHaveProperty('metadata', { meeting_id: 'reuniao-xyz' });
  });

  it('rejeita resposta sem id do bot em vez de gravar bot_id nulo', async () => {
    // O Recall devolvendo uma lista paginada, um envelope de erro com 200, ou
    // qualquer coisa fora do contrato: sem id não há como casar webhook nenhum.
    const { fetchImpl } = fetchGravador([jsonResponse({ count: 0, results: [] })]);
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    await expect(
      client.createBot({ meetingUrl: MEETING_URL, botName: 'bot', meetingId: 'r1' })
    ).rejects.toThrow(/sem o id do bot/i);
  });

  it('respeita a região configurada na base da URL', async () => {
    const { fetchImpl, chamadas } = fetchGravador([jsonResponse({ id: BOT_ID })]);
    const client = new RecallClient({ apiKey: API_KEY, region: 'eu-central-1', fetchImpl });

    await client.createBot({ meetingUrl: MEETING_URL, botName: 'bot' });

    expect(chamadas[0]?.url).toBe('https://eu-central-1.recall.ai/api/v1/bot');
  });
});

describe('RecallClient — transcript', () => {
  it('extrai recordings[0].media_shortcuts.transcript.data.download_url', async () => {
    const { fetchImpl, chamadas } = fetchGravador([
      jsonResponse(botComTranscript('https://storage.exemplo/transcript.json?assinatura=xyz')),
    ]);
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    const url = await client.getTranscriptDownloadUrl(BOT_ID);

    expect(url).toBe('https://storage.exemplo/transcript.json?assinatura=xyz');
    expect(chamadas[0]?.url).toBe(`https://us-west-2.recall.ai/api/v1/bot/${BOT_ID}`);
    expect(chamadas[0]?.method).toBe('GET');
  });

  it('devolve null quando o transcript ainda não está pronto', async () => {
    const semData = fetchGravador([jsonResponse(botComTranscript(null))]);
    const semRecording = fetchGravador([jsonResponse({ id: BOT_ID, recordings: [] })]);
    const semCampo = fetchGravador([jsonResponse({ id: BOT_ID })]);

    for (const g of [semData, semRecording, semCampo]) {
      const client = new RecallClient({ apiKey: API_KEY, fetchImpl: g.fetchImpl });
      await expect(client.getTranscriptDownloadUrl(BOT_ID)).resolves.toBeNull();
    }
  });

  it('baixa o transcript SEM mandar a API key (a URL já vem assinada)', async () => {
    const blocos = [
      {
        participant: { id: 1, name: 'Maria Atendente', is_host: true, email: null },
        language_code: 'pt-BR',
        words: [
          {
            text: 'olá',
            start_timestamp: { absolute: '2026-08-06T13:00:12.300Z', relative: 12.3 },
            end_timestamp: { absolute: '2026-08-06T13:00:12.800Z', relative: 12.8 },
          },
        ],
      },
    ];
    const { fetchImpl, chamadas } = fetchGravador([jsonResponse(blocos)]);
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    const baixado = await client.downloadTranscript('https://storage.exemplo/t.json?assinatura=xyz');

    expect(baixado).toHaveLength(1);
    expect(baixado[0]?.participant?.name).toBe('Maria Atendente');
    expect(baixado[0]?.words?.[0]?.text).toBe('olá');
    expect(chamadas[0]?.headers.authorization).toBeUndefined();
  });
});

describe('RecallClient — saída da chamada', () => {
  it('leave_call usa POST no caminho com barra final', async () => {
    const { fetchImpl, chamadas } = fetchGravador([jsonResponse({}, 200)]);
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    await client.leaveCall(BOT_ID);

    expect(chamadas[0]?.url).toBe(`https://us-west-2.recall.ai/api/v1/bot/${BOT_ID}/leave_call/`);
    expect(chamadas[0]?.method).toBe('POST');
    expect(chamadas[0]?.headers.authorization).toBe(`Token ${API_KEY}`);
  });
});

describe('RecallClient — erros', () => {
  it('4xx vira RecallApiError com status e trecho do corpo', async () => {
    const { fetchImpl } = fetchGravador([
      new Response('{"detail":"Not found."}', { status: 404 }),
    ]);
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    const err = await client.getBot(BOT_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecallApiError);
    const recallErr = err as RecallApiError;
    expect(recallErr.status).toBe(404);
    expect(recallErr.body).toContain('Not found.');
    expect(recallErr.timedOut).toBe(false);
    // A chave nunca pode vazar na mensagem do erro.
    expect(recallErr.message).not.toContain(API_KEY);
  });

  it('401 do createBot também vira RecallApiError (chave inválida)', async () => {
    const { fetchImpl } = fetchGravador([new Response('Invalid token.', { status: 401 })]);
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    const err = await client
      .createBot({ meetingUrl: MEETING_URL, botName: 'bot' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecallApiError);
    expect((err as RecallApiError).status).toBe(401);
  });

  it('timeout aborta a requisição e vira RecallApiError com timedOut', async () => {
    // fetch que nunca responde: só rejeita quando o AbortController dispara.
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortErr = new Error('The operation was aborted.');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl, timeoutMs: 20 });

    const err = await client.getBot(BOT_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecallApiError);
    const recallErr = err as RecallApiError;
    expect(recallErr.timedOut).toBe(true);
    expect(recallErr.status).toBe(0);
    expect(recallErr.message).toContain('timeout');
  });

  it('falha de rede vira RecallApiError sem marcar timeout', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const client = new RecallClient({ apiKey: API_KEY, fetchImpl });

    const err = await client.getBot(BOT_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecallApiError);
    expect((err as RecallApiError).timedOut).toBe(false);
    expect((err as RecallApiError).status).toBe(0);
  });
});
