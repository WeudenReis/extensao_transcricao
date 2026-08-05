import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import {
  VoreoClient,
  computeBackoffMs,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_ATTEMPTS,
} from '../src/voreo/client.js';
import type { VoreoDelivery, VoreoPayload } from '../src/voreo/client.js';

const TRANSCRIPT = 'conferenceRecords/rec1/transcripts/t1';

function makePayload(): VoreoPayload {
  return {
    sessionId: '3f2b4c1a-9d8e-4f00-b111-222233334444',
    meetingCode: 'abc-defg-hij',
    conferenceRecord: 'conferenceRecords/rec1',
    startTime: '2026-08-05T13:00:00Z',
    endTime: '2026-08-05T13:30:00Z',
    participants: [{ name: 'Maria Atendente' }],
    transcript: [
      { speaker: 'Maria Atendente', text: 'Bom dia!', startTime: undefined, endTime: undefined },
    ],
    docsExportUri: undefined,
    source: 'chatpro-meet-extension',
  };
}

describe('backoff exponencial da fila Voreo', () => {
  it('dobra a cada tentativa a partir de 30 s', () => {
    expect(computeBackoffMs(1)).toBe(BASE_BACKOFF_MS); // 30 s
    expect(computeBackoffMs(2)).toBe(BASE_BACKOFF_MS * 2); // 60 s
    expect(computeBackoffMs(3)).toBe(BASE_BACKOFF_MS * 4); // 120 s
    expect(computeBackoffMs(4)).toBe(BASE_BACKOFF_MS * 8); // 240 s
  });

  it('respeita o teto de 30 minutos', () => {
    expect(computeBackoffMs(10)).toBe(MAX_BACKOFF_MS);
    expect(computeBackoffMs(50)).toBe(MAX_BACKOFF_MS);
  });
});

describe('fila Voreo (retry com backoff)', () => {
  let db: Db;
  let clock: Date;
  let shouldFail: boolean;
  let postsFeitos: number;

  const fetchFake: typeof fetch = () => {
    postsFeitos += 1;
    return Promise.resolve(
      shouldFail ? new Response('erro interno', { status: 500 }) : new Response('{}', { status: 200 })
    );
  };

  beforeEach(() => {
    db = new Db(':memory:');
    clock = new Date('2026-08-05T12:00:00.000Z');
    shouldFail = true;
    postsFeitos = 0;
    db.recordTranscriptSent({
      conferenceRecord: 'conferenceRecords/rec1',
      transcriptName: TRANSCRIPT,
      sessionId: '3f2b4c1a-9d8e-4f00-b111-222233334444',
      status: 'queued',
      payloadJson: null,
    });
  });

  function makeClient(): VoreoClient {
    return new VoreoClient({
      db,
      webhookUrl: 'https://voreo.example/webhook',
      apiKey: 'chave-teste',
      fetchImpl: fetchFake,
      now: () => clock,
    });
  }

  function avancarRelogio(ms: number): void {
    clock = new Date(clock.getTime() + ms);
  }

  it('enfileira com backoff quando o primeiro envio falha e envia no retry', async () => {
    const voreo = makeClient();
    await voreo.deliver({ transcriptName: TRANSCRIPT, payload: makePayload() });

    // Falhou → 1 tentativa feita, item na fila com next_attempt_at = agora + 30 s.
    expect(postsFeitos).toBe(1);
    expect(db.countVoreoQueue()).toEqual({ pending: 1, dead: 0 });
    expect(db.getTranscriptSent(TRANSCRIPT)?.voreo_status).toBe('queued');
    const item = db.dueVoreoItems(new Date(clock.getTime() + BASE_BACKOFF_MS).toISOString(), 10)[0];
    expect(item?.attempts).toBe(1);
    expect(item?.next_attempt_at).toBe(new Date(clock.getTime() + BASE_BACKOFF_MS).toISOString());

    // Antes do horário agendado, o worker não pega nada.
    await voreo.processQueueOnce();
    expect(postsFeitos).toBe(1);

    // Passou o backoff, ainda falhando → attempts=2, próximo em +60 s.
    avancarRelogio(BASE_BACKOFF_MS + 1000);
    await voreo.processQueueOnce();
    expect(postsFeitos).toBe(2);
    const aposRetry = db.dueVoreoItems(
      new Date(clock.getTime() + MAX_BACKOFF_MS).toISOString(),
      10
    )[0];
    expect(aposRetry?.attempts).toBe(2);
    expect(aposRetry?.last_error).toContain('HTTP 500');

    // Voreo volta → envia e limpa a fila.
    shouldFail = false;
    avancarRelogio(computeBackoffMs(2) + 1000);
    await voreo.processQueueOnce();
    expect(postsFeitos).toBe(3);
    expect(db.countVoreoQueue()).toEqual({ pending: 0, dead: 0 });
    expect(db.getTranscriptSent(TRANSCRIPT)?.voreo_status).toBe('sent');
    expect(db.getTranscriptSent(TRANSCRIPT)?.sent_to_voreo_at).toBe(clock.toISOString());
  });

  it('marca como failed e para de tentar após o máximo de tentativas', async () => {
    const delivery: VoreoDelivery = { transcriptName: TRANSCRIPT, payload: makePayload() };
    db.enqueueVoreo({
      payloadJson: JSON.stringify(delivery),
      attempts: MAX_ATTEMPTS - 1,
      nextAttemptAt: clock.toISOString(),
      lastError: 'HTTP 500',
    });

    const voreo = makeClient();
    await voreo.processQueueOnce();

    expect(postsFeitos).toBe(1);
    // Item vira "dead" (next_attempt_at NULL) e o transcript fica failed.
    expect(db.countVoreoQueue()).toEqual({ pending: 0, dead: 1 });
    expect(db.getTranscriptSent(TRANSCRIPT)?.voreo_status).toBe('failed');

    // Rodadas seguintes não tentam de novo.
    avancarRelogio(60 * 60 * 1000);
    await voreo.processQueueOnce();
    expect(postsFeitos).toBe(1);
  });

  it('sem VOREO_WEBHOOK_URL marca skipped-no-url sem tocar na rede (modo dev)', async () => {
    const voreo = new VoreoClient({
      db,
      webhookUrl: undefined,
      apiKey: undefined,
      fetchImpl: fetchFake,
      now: () => clock,
    });
    await voreo.deliver({ transcriptName: TRANSCRIPT, payload: makePayload() });

    expect(postsFeitos).toBe(0);
    expect(db.countVoreoQueue()).toEqual({ pending: 0, dead: 0 });
    expect(db.getTranscriptSent(TRANSCRIPT)?.voreo_status).toBe('skipped-no-url');
  });
});
