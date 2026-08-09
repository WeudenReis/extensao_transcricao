import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { RecallClient } from '../src/recall/client.js';
import { ChatproClient } from '../src/chatpro/client.js';
import {
  RecallQueueWorker,
  computeRecallBackoffMs,
  entregarAoChatpro,
  lerTranscriptSalvo,
  RECALL_BASE_BACKOFF_MS,
  RECALL_MAX_BACKOFF_MS,
  RECALL_MAX_ATTEMPTS,
  MEETING_AUSENTE_MAX_AGE_MS,
} from '../src/pipeline/recallQueue.js';
import { jsonResponse } from './helpers.js';

/**
 * Worker da fila de webhooks do Recall. Relógio e `fetch` injetados —
 * nada de rede real nem de espera de verdade.
 */

const API_KEY = 'chave-de-teste-123';
const BOT_ID = 'bot-abc-123';
const MEETING_ID = 'reuniao-1';
const MEETING_URL = 'https://meet.google.com/abc-defg-hij';
const SESSION_ID = '3f2b4c1a-9d8e-4f00-b111-222233334444';
const DOWNLOAD_URL = 'https://storage.exemplo/transcript.json?assinatura=xyz';

/** Bloco de transcript como o Recall entrega: já separado por participante. */
const TRANSCRIPT_BRUTO = [
  {
    participant: { id: 1, name: 'Maria Atendente', is_host: true, email: 'maria@exemplo.com' },
    language_code: 'pt-BR',
    words: [
      { text: 'bom', start_timestamp: { relative: 1.0 }, end_timestamp: { relative: 1.2 } },
      { text: 'dia.', start_timestamp: { relative: 1.2 }, end_timestamp: { relative: 1.6 } },
    ],
  },
  {
    participant: { id: 2, name: 'Cliente', is_host: false, email: null },
    language_code: 'pt-BR',
    words: [
      { text: 'bom', start_timestamp: { relative: 3.0 }, end_timestamp: { relative: 3.2 } },
      { text: 'dia!', start_timestamp: { relative: 3.2 }, end_timestamp: { relative: 3.8 } },
    ],
  },
];

function payloadWebhook(event: string, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event,
    data: {
      data: { code: event.split('.')[1] ?? event, sub_code: null, ...extras },
      bot: { id: BOT_ID, metadata: { session_id: SESSION_ID } },
    },
  });
}

describe('backoff exponencial da fila do Recall', () => {
  it('dobra a partir de 30 s com teto de 15 min', () => {
    expect(computeRecallBackoffMs(1)).toBe(RECALL_BASE_BACKOFF_MS);
    expect(computeRecallBackoffMs(2)).toBe(RECALL_BASE_BACKOFF_MS * 2);
    expect(computeRecallBackoffMs(4)).toBe(RECALL_BASE_BACKOFF_MS * 8);
    expect(computeRecallBackoffMs(20)).toBe(RECALL_MAX_BACKOFF_MS);
  });
});

describe('worker da fila do Recall', () => {
  let db: Db;
  let clock: Date;
  let respostas: Response[];
  let urlsChamadas: string[];

  beforeEach(() => {
    db = new Db(':memory:');
    clock = new Date('2026-08-06T13:00:00.000Z');
    respostas = [];
    urlsChamadas = [];
  });

  function avancar(ms: number): void {
    clock = new Date(clock.getTime() + ms);
  }

  const fetchImpl: typeof fetch = (input) => {
    urlsChamadas.push(String(input));
    const resposta = respostas.shift();
    if (!resposta) return Promise.reject(new Error('resposta não preparada no teste'));
    return Promise.resolve(resposta);
  };

  function makeWorker(options: {
    autoSendChatpro?: boolean;
    chatproUrl?: string;
    semApiKey?: boolean;
  } = {}): RecallQueueWorker {
    return new RecallQueueWorker({
      db,
      recall: options.semApiKey ? undefined : new RecallClient({ apiKey: API_KEY, fetchImpl }),
      chatpro: new ChatproClient({
        // chatproUrl no teste = "chatPro configurado". As três variáveis andam
        // juntas: sem qualquer uma delas a entrega é pulada.
        baseUrl: options.chatproUrl,
        instanceToken: options.chatproUrl ? 'token-de-teste' : undefined,
        instanceId: options.chatproUrl ? 'chatpro-teste' : undefined,
        userId: options.chatproUrl ? 'user-teste' : undefined,
        fetchImpl,
      }),
      autoSendChatpro: options.autoSendChatpro ?? false,
      now: () => clock,
    });
  }

  function criarReuniao(sessionId: string | null = SESSION_ID): void {
    db.createMeeting({
      id: MEETING_ID,
      botId: BOT_ID,
      sessionId,
      meetingUrl: MEETING_URL,
      meetingCode: 'abc-defg-hij',
      botName: 'chatPro (gravando)',
      createdAt: clock.toISOString(),
    });
  }

  function enfileirar(worker: RecallQueueWorker, event: string, webhookId = event): number {
    return worker.enqueueFromWebhook({
      event,
      botId: BOT_ID,
      payloadJson: payloadWebhook(event),
      webhookId,
    }).id;
  }

  it('mapeia cada evento de estado do bot para o status da reunião', async () => {
    const esperado: [string, string][] = [
      ['bot.joining_call', 'joining'],
      ['bot.in_waiting_room', 'waiting_room'],
      ['bot.in_call_recording', 'recording'],
      ['bot.call_ended', 'ended'],
      ['bot.done', 'done'],
    ];
    criarReuniao();
    const worker = makeWorker();

    for (const [event, status] of esperado) {
      const id = enfileirar(worker, event);
      await worker.processOnce();
      expect(db.getMeeting(MEETING_ID)?.status, `evento ${event}`).toBe(status);
      expect(db.getRecallEvent(id)?.status).toBe('done');
    }

    // 'recording' e 'ended' carimbam os horários (idempotente na reentrega).
    expect(db.getMeeting(MEETING_ID)?.started_at).not.toBeNull();
    expect(db.getMeeting(MEETING_ID)?.ended_at).not.toBeNull();
  });

  it('bot.fatal vira failed com o sub_code no erro', async () => {
    criarReuniao();
    const worker = makeWorker();
    worker.enqueueFromWebhook({
      event: 'bot.fatal',
      botId: BOT_ID,
      payloadJson: payloadWebhook('bot.fatal', { sub_code: 'meeting_not_found' }),
      webhookId: 'msg_fatal',
    });

    await worker.processOnce();

    const meeting = db.getMeeting(MEETING_ID);
    expect(meeting?.status).toBe('failed');
    expect(meeting?.error).toContain('meeting_not_found');
  });

  it('transcript.failed vira failed', async () => {
    criarReuniao();
    const worker = makeWorker();
    enfileirar(worker, 'transcript.failed');

    await worker.processOnce();

    expect(db.getMeeting(MEETING_ID)?.status).toBe('failed');
  });

  it('evento atrasado NÃO derruba uma reunião que já tem transcrição salva', async () => {
    criarReuniao();
    const worker = makeWorker();
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
    ];
    enfileirar(worker, 'transcript.done', 'msg_done');
    await worker.processOnce();
    expect(db.getMeeting(MEETING_ID)?.status).toBe('done');

    // O Svix reentrega por 24 h: um bot.call_ended que ficou preso na fila
    // chega DEPOIS da transcrição pronta. Sem guarda, a reunião regrediria.
    const atrasado = enfileirar(worker, 'bot.call_ended', 'msg_atrasado');
    await worker.processOnce();

    expect(db.getMeeting(MEETING_ID)?.status).toBe('done');
    expect(db.getRecallEvent(atrasado)?.status).toBe('done');
  });

  it('transcript.failed atrasado não apaga uma transcrição já entregue', async () => {
    criarReuniao();
    const worker = makeWorker();
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
    ];
    enfileirar(worker, 'transcript.done', 'msg_done');
    await worker.processOnce();

    enfileirar(worker, 'transcript.failed', 'msg_failed_atrasado');
    await worker.processOnce();

    // Sem a guarda, o painel diria "a reunião falhou, não há transcrição" —
    // com a transcrição intacta no banco.
    const meeting = db.getMeeting(MEETING_ID);
    expect(meeting?.status).toBe('done');
    expect(meeting?.error).toBeNull();
    expect(lerTranscriptSalvo(meeting?.transcript_json ?? null)?.falas).toHaveLength(2);
  });

  it('transcript vazio retenta em vez de virar sucesso em branco', async () => {
    criarReuniao();
    const worker = makeWorker({ autoSendChatpro: true, chatproUrl: 'https://chatpro.exemplo/api' });
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse([]), // arquivo ainda sendo escrito do lado do Recall
    ];
    const id = enfileirar(worker, 'transcript.done', 'msg_vazio');
    await worker.processOnce();

    // Nada entregue ao chatPro, e o evento continua na fila pra tentar de novo.
    expect(db.getRecallEvent(id)?.status).toBe('pending');
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).not.toBe('sent');
    expect(urlsChamadas).toHaveLength(2);

    // Na tentativa seguinte o conteúdo já está lá.
    avancar(computeRecallBackoffMs(1) + 1000);
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
      jsonResponse({ ok: true }),
    ];
    await worker.processOnce();

    expect(db.getRecallEvent(id)?.status).toBe('done');
    expect(lerTranscriptSalvo(db.getMeeting(MEETING_ID)?.transcript_json ?? null)?.falas).toHaveLength(2);
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('sent');
  });

  it('reencontra a reunião pelo metadata quando o createBot perdeu a resposta', async () => {
    // Cenário real: o POST /api/meetings gravou a reunião, chamou o Recall, e o
    // timeout estourou DEPOIS de o bot ter sido criado. A reunião existe, mas
    // sem bot_id — e o webhook só sabe o bot_id.
    db.createMeeting({
      id: MEETING_ID,
      botId: null,
      sessionId: null,
      meetingUrl: MEETING_URL,
      meetingCode: 'abc-defg-hij',
      botName: 'chatPro (gravando)',
      status: 'failed',
      createdAt: clock.toISOString(),
    });
    const worker = makeWorker();
    worker.enqueueFromWebhook({
      event: 'bot.in_call_recording',
      botId: BOT_ID,
      payloadJson: JSON.stringify({
        event: 'bot.in_call_recording',
        data: {
          data: {},
          bot: { id: BOT_ID, metadata: { meeting_id: MEETING_ID, session_id: SESSION_ID } },
        },
      }),
      webhookId: 'msg_reencontro',
    });

    await worker.processOnce();

    const meeting = db.getMeeting(MEETING_ID);
    expect(meeting?.bot_id).toBe(BOT_ID); // amarrado pelo metadata
    expect(meeting?.session_id).toBe(SESSION_ID);
    expect(meeting?.status).toBe('recording'); // o bot estava gravando de verdade
  });

  it('reunião que terminou SEM gravar vira aviso na conversa', async () => {
    // É o buraco que motivou o projeto: se ninguém admite o bot da sala de
    // espera, a conversa acontece e não fica registro. Antes falhava calado.
    criarReuniao();
    const worker = makeWorker({ chatproUrl: 'https://chatpro.exemplo' });
    respostas = [jsonResponse({ ok: true }, 201)]; // o addComments do aviso

    enfileirar(worker, 'bot.in_waiting_room', 'msg_espera');
    await worker.processOnce();
    enfileirar(worker, 'bot.call_ended', 'msg_fim');
    await worker.processOnce();

    const m = db.getMeeting(MEETING_ID);
    expect(m?.status).toBe('ended');
    expect(m?.chatpro_status).toBe('aviso-enviado');
    expect(urlsChamadas.at(-1)).toContain('/messages/addComments');
  });

  it('não avisa duas vezes quando um webhook atrasado reentra', async () => {
    criarReuniao();
    const worker = makeWorker({ chatproUrl: 'https://chatpro.exemplo' });
    respostas = [jsonResponse({ ok: true }, 201)];

    enfileirar(worker, 'bot.call_ended', 'msg_fim');
    await worker.processOnce();
    const depoisDoPrimeiro = urlsChamadas.length;

    enfileirar(worker, 'bot.done', 'msg_done_atrasado');
    await worker.processOnce();

    // Nenhuma chamada nova: o carimbo 'aviso-enviado' segura a repetição.
    expect(urlsChamadas).toHaveLength(depoisDoPrimeiro);
  });

  it('reunião QUE GRAVOU não recebe aviso nenhum', async () => {
    criarReuniao();
    const worker = makeWorker({ chatproUrl: 'https://chatpro.exemplo' });
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
    ];
    enfileirar(worker, 'transcript.done', 'msg_done');
    await worker.processOnce();
    const antes = urlsChamadas.length;

    enfileirar(worker, 'bot.done', 'msg_bot_done');
    await worker.processOnce();

    expect(urlsChamadas).toHaveLength(antes);
  });

  it('evento informativo (transcript.processing) encerra sem mexer no status', async () => {
    criarReuniao();
    db.updateMeetingStatus(MEETING_ID, 'recording');
    const worker = makeWorker();
    const id = enfileirar(worker, 'transcript.processing');

    await worker.processOnce();

    expect(db.getMeeting(MEETING_ID)?.status).toBe('recording');
    expect(db.getRecallEvent(id)?.status).toBe('done');
  });

  it('transcript.done baixa, normaliza e salva a transcrição', async () => {
    criarReuniao();
    const worker = makeWorker();
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [
          { id: 'rec-1', media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } },
        ],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
    ];
    const id = enfileirar(worker, 'transcript.done');

    await worker.processOnce();

    expect(urlsChamadas).toEqual([
      `https://us-west-2.recall.ai/api/v1/bot/${BOT_ID}`,
      DOWNLOAD_URL,
    ]);
    const meeting = db.getMeeting(MEETING_ID);
    expect(meeting?.status).toBe('done');
    expect(meeting?.duration_seconds).toBe(4);
    const salvo = lerTranscriptSalvo(meeting?.transcript_json ?? null);
    expect(salvo?.falas.map((f) => f.speaker)).toEqual(['Maria Atendente', 'Cliente']);
    expect(salvo?.falas[0]?.text).toBe('bom dia.');
    expect(salvo?.participantes).toHaveLength(2);
    expect(db.getRecallEvent(id)?.status).toBe('done');
  });

  it('com AUTO_SEND_CHATPRO desligado, a transcrição fica pending pro botão do painel', async () => {
    criarReuniao();
    const worker = makeWorker({ autoSendChatpro: false });
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
    ];
    enfileirar(worker, 'transcript.done');

    await worker.processOnce();

    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('pending');
    // Só as duas chamadas do Recall — nada foi entregue ao chatPro.
    expect(urlsChamadas).toHaveLength(2);
  });

  it('com AUTO_SEND_CHATPRO ligado, entrega e carimba o chatpro_status', async () => {
    criarReuniao();
    const worker = makeWorker({ autoSendChatpro: true, chatproUrl: 'https://chatpro.exemplo/api' });
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
      jsonResponse({ ok: true }),
    ];
    enfileirar(worker, 'transcript.done');

    await worker.processOnce();

    expect(urlsChamadas[2]).toBe('https://chatpro.exemplo/api/messages/addComments');
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('sent');
  });

  it('um segundo transcript.done NÃO baixa de novo nem duplica a entrega no chatPro', async () => {
    criarReuniao();
    const worker = makeWorker({ autoSendChatpro: true, chatproUrl: 'https://chatpro.exemplo/api' });
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
      jsonResponse({ ok: true }),
    ];
    enfileirar(worker, 'transcript.done', 'msg_primeiro');
    await worker.processOnce();
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('sent');
    const chamadasNaPrimeira = urlsChamadas.length;

    // O Recall reemite o evento com OUTRO webhook-id: o UNIQUE não deduplica,
    // então quem tem de segurar é a guarda de idempotência do worker.
    const segundo = enfileirar(worker, 'transcript.done', 'msg_segundo');
    await worker.processOnce();

    expect(db.getRecallEvent(segundo)?.status).toBe('done');
    // Nenhuma chamada nova: nem re-download, nem segunda entrega ao chatPro.
    expect(urlsChamadas).toHaveLength(chamadasNaPrimeira);
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('sent');
  });

  it('transcript.done repetido REENTREGA quando a entrega anterior falhou', async () => {
    criarReuniao();
    const worker = makeWorker({ autoSendChatpro: true, chatproUrl: 'https://chatpro.exemplo/api' });
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
      new Response('indisponível', { status: 503 }), // chatPro fora do ar
    ];
    enfileirar(worker, 'transcript.done', 'msg_primeiro');
    await worker.processOnce();
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('failed');

    respostas = [jsonResponse({ ok: true })];
    enfileirar(worker, 'transcript.done', 'msg_segundo');
    await worker.processOnce();

    // Não rebaixou o transcript, mas tentou a entrega de novo — e deu certo.
    expect(urlsChamadas.at(-1)).toBe('https://chatpro.exemplo/api/messages/addComments');
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('sent');
  });

  it('falha transitória (HTTP 500) retenta com backoff e depois conclui', async () => {
    criarReuniao();
    const worker = makeWorker();
    respostas = [new Response('erro interno', { status: 500 })];
    const id = enfileirar(worker, 'transcript.done');

    await worker.processOnce();

    const aposFalha = db.getRecallEvent(id);
    expect(aposFalha?.status).toBe('pending');
    expect(aposFalha?.attempts).toBe(1);
    expect(aposFalha?.next_attempt_at).toBe(
      new Date(clock.getTime() + RECALL_BASE_BACKOFF_MS).toISOString()
    );

    // Antes do horário marcado, nada acontece.
    await worker.processOnce();
    expect(db.getRecallEvent(id)?.attempts).toBe(1);

    // Passado o backoff, o Recall voltou → conclui.
    avancar(RECALL_BASE_BACKOFF_MS + 1000);
    respostas = [
      jsonResponse({
        id: BOT_ID,
        recordings: [{ media_shortcuts: { transcript: { data: { download_url: DOWNLOAD_URL } } } }],
      }),
      jsonResponse(TRANSCRIPT_BRUTO),
    ];
    await worker.processOnce();

    expect(db.getRecallEvent(id)?.status).toBe('done');
    expect(db.getMeeting(MEETING_ID)?.status).toBe('done');
  });

  it('4xx definitivo do Recall mata o evento na hora (retentar não mudaria nada)', async () => {
    criarReuniao();
    const worker = makeWorker();
    respostas = [new Response('{"detail":"Not found."}', { status: 404 })];
    const id = enfileirar(worker, 'transcript.done');

    await worker.processOnce();

    expect(db.getRecallEvent(id)?.status).toBe('dead');
    expect(db.getRecallEvent(id)?.last_error).toContain('404');
  });

  it('transcript.done sem download_url ainda pronto retenta (não perde o transcript)', async () => {
    criarReuniao();
    const worker = makeWorker();
    respostas = [jsonResponse({ id: BOT_ID, recordings: [] })];
    const id = enfileirar(worker, 'transcript.done');

    await worker.processOnce();

    expect(db.getRecallEvent(id)?.status).toBe('pending');
    expect(db.getRecallEvent(id)?.last_error).toContain('download_url');
  });

  it('reunião ainda não gravada fica pending (corrida) e só depois de 10 min vira dead', async () => {
    const worker = makeWorker(); // sem criarReuniao(): o webhook chegou primeiro
    const id = enfileirar(worker, 'bot.in_call_recording');

    await worker.processOnce();
    expect(db.getRecallEvent(id)?.status).toBe('pending');
    expect(db.getRecallEvent(id)?.last_error).toContain(BOT_ID);

    // A reunião aparece dentro da janela → processa normalmente.
    avancar(RECALL_BASE_BACKOFF_MS + 1000);
    criarReuniao();
    await worker.processOnce();
    expect(db.getRecallEvent(id)?.status).toBe('done');
    expect(db.getMeeting(MEETING_ID)?.status).toBe('recording');
  });

  it('reunião que nunca aparece vira dead com motivo claro depois da janela', async () => {
    const worker = makeWorker();
    const id = enfileirar(worker, 'bot.in_call_recording');

    await worker.processOnce();
    expect(db.getRecallEvent(id)?.status).toBe('pending');

    avancar(MEETING_AUSENTE_MAX_AGE_MS + 60_000);
    await worker.processOnce();

    expect(db.getRecallEvent(id)?.status).toBe('dead');
    expect(db.getRecallEvent(id)?.last_error).toContain('bot criado fora deste servidor');
  });

  it('desiste depois do máximo de tentativas', async () => {
    criarReuniao();
    const worker = makeWorker();
    const id = enfileirar(worker, 'transcript.done');
    db.recordRecallEventFailure(id, RECALL_MAX_ATTEMPTS - 1, clock.toISOString(), 'HTTP 500');
    respostas = [new Response('erro interno', { status: 500 })];

    await worker.processOnce();

    expect(db.getRecallEvent(id)?.status).toBe('dead');
    expect(db.countRecallEvents().dead).toBe(1);
  });

  it('preenche session_id da reunião quando o vínculo vem no metadata do webhook', async () => {
    criarReuniao(null); // bot criado sem sessão conhecida
    const worker = makeWorker();
    enfileirar(worker, 'bot.joining_call');

    await worker.processOnce();

    expect(db.getMeeting(MEETING_ID)?.session_id).toBe(SESSION_ID);
  });

  it('não sobrescreve um session_id já gravado', async () => {
    criarReuniao('11111111-2222-3333-4444-555555555555');
    const worker = makeWorker();
    enfileirar(worker, 'bot.joining_call');

    await worker.processOnce();

    expect(db.getMeeting(MEETING_ID)?.session_id).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('transcript.done sem RECALL_API_KEY morre com motivo claro (retentar não resolve)', async () => {
    criarReuniao();
    const worker = makeWorker({ semApiKey: true });
    const id = enfileirar(worker, 'transcript.done');

    await worker.processOnce();

    expect(db.getRecallEvent(id)?.status).toBe('dead');
    expect(db.getRecallEvent(id)?.last_error).toContain('RECALL_API_KEY');
  });

  it('reentrega já processada não reprocessa (status done sai da fila)', async () => {
    criarReuniao();
    const worker = makeWorker();
    worker.enqueueFromWebhook({
      event: 'bot.in_call_recording',
      botId: BOT_ID,
      payloadJson: payloadWebhook('bot.in_call_recording'),
      webhookId: 'msg_1',
    });
    await worker.processOnce();

    const repetido = worker.enqueueFromWebhook({
      event: 'bot.in_call_recording',
      botId: BOT_ID,
      payloadJson: payloadWebhook('bot.in_call_recording'),
      webhookId: 'msg_1',
    });

    expect(repetido.created).toBe(false);
    expect(db.countRecallEvents()).toEqual({ pending: 0, done: 1, dead: 0 });
  });

  it('queueDepth reflete a fila', async () => {
    criarReuniao();
    const worker = makeWorker();
    enfileirar(worker, 'bot.joining_call');
    expect(worker.queueDepth()).toEqual({ pending: 1, done: 0, dead: 0 });
    await worker.processOnce();
    expect(worker.queueDepth()).toEqual({ pending: 0, done: 1, dead: 0 });
  });
});

describe('entrega ao chatPro a partir da reunião salva', () => {
  it('sem transcrição salva devolve failed sem tocar a rede', async () => {
    const db = new Db(':memory:');
    const meeting = db.createMeeting({
      id: MEETING_ID,
      botId: BOT_ID,
      sessionId: SESSION_ID,
      meetingUrl: MEETING_URL,
      meetingCode: 'abc-defg-hij',
      botName: 'chatPro (gravando)',
    });
    const chatpro = new ChatproClient({
      baseUrl: 'https://chatpro.exemplo',
      instanceToken: 'token-de-teste',
      instanceId: 'chatpro-teste',
      userId: 'user-teste',
      fetchImpl: () => Promise.reject(new Error('não deveria chamar a rede')),
    });

    const resultado = await entregarAoChatpro(db, chatpro, meeting);

    expect(resultado).toMatchObject({ ok: false, status: 'failed' });
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('pending');
  });
});

describe('leitura do transcript salvo', () => {
  it('devolve null pra ausente ou ilegível, e listas vazias pra formato inesperado', () => {
    expect(lerTranscriptSalvo(null)).toBeNull();
    expect(lerTranscriptSalvo('{quebrado')).toBeNull();
    expect(lerTranscriptSalvo('[]')).toBeNull();
    expect(lerTranscriptSalvo('{}')).toEqual({ falas: [], participantes: [] });
  });
});
