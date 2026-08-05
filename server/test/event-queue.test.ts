import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { TranscriptPipeline } from '../src/pipeline/transcript.js';
import {
  EventQueueWorker,
  computeEventBackoffMs,
  EVENT_BASE_BACKOFF_MS,
  EVENT_MAX_BACKOFF_MS,
  EVENT_MAX_ATTEMPTS,
  NO_LINK_RETRY_MS,
  ENDED_RECHECK_DELAY_MS,
  EVENT_TRANSCRIPT_FILE_GENERATED,
  EVENT_CONFERENCE_ENDED,
} from '../src/pipeline/eventQueue.js';
import { VoreoClient } from '../src/voreo/client.js';
import type { DecodedPushMessage } from '../src/routes/pubsub.js';
import type { MeetApi } from '../src/google/meet.js';
import { makeMeetStub } from './helpers.js';

const SESSION_ID = '3f2b4c1a-9d8e-4f00-b111-222233334444';
const SPACE = 'spaces/space-abc';
const CODE = 'abc-defg-hij';
const CONFERENCE = 'conferenceRecords/rec1';
const TRANSCRIPT = 'conferenceRecords/rec1/transcripts/t1';

function decoded(ceType: string, payload: Record<string, unknown>): DecodedPushMessage {
  return {
    ceType,
    payload,
    attributes: { 'ce-type': ceType },
    messageId: 'msg-1',
    publishTime: undefined,
    subscription: undefined,
  };
}

const fileGeneratedPush = (): DecodedPushMessage =>
  decoded(EVENT_TRANSCRIPT_FILE_GENERATED, { transcript: { name: TRANSCRIPT } });

const endedPush = (): DecodedPushMessage =>
  decoded(EVENT_CONFERENCE_ENDED, { conferenceRecord: { name: CONFERENCE } });

/** Stub de Meet com o caminho feliz completo do pipeline. */
function happyMeet(overrides: Partial<MeetApi> = {}): MeetApi {
  return makeMeetStub({
    getConferenceRecord: () =>
      Promise.resolve({
        name: CONFERENCE,
        space: SPACE,
        startTime: '2026-08-05T13:00:00Z',
        endTime: '2026-08-05T13:30:00Z',
      }),
    getSpace: () => Promise.resolve({ name: SPACE, meetingCode: CODE }),
    getTranscript: () =>
      Promise.resolve({ name: TRANSCRIPT, docsDestination: { exportUri: 'https://docs.google.com/x' } }),
    listAllTranscriptEntries: () =>
      Promise.resolve([{ participant: `${CONFERENCE}/participants/p1`, text: 'Olá!' }]),
    listAllParticipants: () =>
      Promise.resolve([
        { name: `${CONFERENCE}/participants/p1`, signedinUser: { displayName: 'Maria Atendente' } },
      ]),
    ...overrides,
  });
}

describe('backoff exponencial da fila de eventos', () => {
  it('dobra a partir de 30 s com teto de 1 h', () => {
    expect(computeEventBackoffMs(1)).toBe(EVENT_BASE_BACKOFF_MS);
    expect(computeEventBackoffMs(2)).toBe(EVENT_BASE_BACKOFF_MS * 2);
    expect(computeEventBackoffMs(5)).toBe(EVENT_BASE_BACKOFF_MS * 16);
    expect(computeEventBackoffMs(20)).toBe(EVENT_MAX_BACKOFF_MS);
  });
});

describe('fila durável de eventos', () => {
  let db: Db;
  let clock: Date;

  beforeEach(() => {
    db = new Db(':memory:');
    clock = new Date('2026-08-05T12:00:00.000Z');
  });

  function makeWorker(meet: MeetApi): EventQueueWorker {
    const voreo = new VoreoClient({ db, webhookUrl: undefined, apiKey: undefined, now: () => clock });
    const pipeline = new TranscriptPipeline({ db, meet, voreo });
    return new EventQueueWorker({ db, pipeline, now: () => clock });
  }

  function avancar(ms: number): void {
    clock = new Date(clock.getTime() + ms);
  }

  it('falha transitória da Meet API → retry com backoff → sucesso (evento não se perde)', async () => {
    let falhasRestantes = 1;
    const meet = happyMeet({
      getConferenceRecord: () => {
        if (falhasRestantes > 0) {
          falhasRestantes -= 1;
          return Promise.reject(new Error('Meet API respondeu HTTP 500'));
        }
        return Promise.resolve({ name: CONFERENCE, space: SPACE });
      },
    });
    db.upsertLink({ sessionId: SESSION_ID, meetingCode: CODE, spaceName: SPACE, source: 'auto' });
    const worker = makeWorker(meet);

    expect(worker.enqueueFromPush(fileGeneratedPush())).toBe(true);
    expect(db.countEventQueue().pending).toBe(1);

    // 1ª passada: Meet API fora → evento continua pending com backoff.
    await worker.processOnce();
    const aposFalha = db.getEvent(1);
    expect(aposFalha?.status).toBe('pending');
    expect(aposFalha?.attempts).toBe(1);
    expect(aposFalha?.last_error).toContain('HTTP 500');
    expect(aposFalha?.next_attempt_at).toBe(
      new Date(clock.getTime() + EVENT_BASE_BACKOFF_MS).toISOString()
    );

    // Antes do horário: nada acontece.
    await worker.processOnce();
    expect(db.getEvent(1)?.attempts).toBe(1);

    // Depois do backoff: Meet API voltou → processa até o fim.
    avancar(EVENT_BASE_BACKOFF_MS + 1000);
    await worker.processOnce();
    expect(db.getEvent(1)?.status).toBe('done');
    expect(db.getTranscriptSent(TRANSCRIPT)?.voreo_status).toBe('skipped-no-url');
    expect(db.getTranscriptSent(TRANSCRIPT)?.session_id).toBe(SESSION_ID);
  });

  it('evento sem vínculo fica no-link e é reprocessado quando o vínculo chega', async () => {
    const worker = makeWorker(happyMeet());

    worker.enqueueFromPush(fileGeneratedPush());
    await worker.processOnce();

    // Sem link → no-link, com o space anotado e retry em 10 min.
    const semLink = db.getEvent(1);
    expect(semLink?.status).toBe('no-link');
    expect(semLink?.space_name).toBe(SPACE);
    expect(semLink?.next_attempt_at).toBe(new Date(clock.getTime() + NO_LINK_RETRY_MS).toISOString());
    expect(db.countEventQueue().noLink).toBe(1);

    // Vínculo chega (o que o POST /api/links faz): reativa pra AGORA.
    db.upsertLink({ sessionId: SESSION_ID, meetingCode: CODE, spaceName: SPACE, source: 'auto' });
    const reativados = db.reactivateNoLinkEvents(SPACE, clock.toISOString());
    expect(reativados).toBe(1);
    expect(db.getEvent(1)?.status).toBe('pending');

    await worker.processOnce();
    expect(db.getEvent(1)?.status).toBe('done');
    expect(db.getTranscriptSent(TRANSCRIPT)?.session_id).toBe(SESSION_ID);
    expect(db.getTranscriptSent(TRANSCRIPT)?.voreo_status).toBe('skipped-no-url');
  });

  it('no-link vira dead depois de 48 h sem vínculo', async () => {
    const worker = makeWorker(happyMeet());
    worker.enqueueFromPush(fileGeneratedPush());
    await worker.processOnce();
    expect(db.getEvent(1)?.status).toBe('no-link');

    avancar(49 * 60 * 60 * 1000); // 49 h
    await worker.processOnce();
    expect(db.getEvent(1)?.status).toBe('dead');
    expect(db.getEvent(1)?.last_error).toContain('48 h');
  });

  it('atinge o máximo de tentativas em falha persistente e vira dead', async () => {
    const meet = makeMeetStub({
      getConferenceRecord: () => Promise.reject(new Error('Meet API respondeu HTTP 500')),
    });
    const worker = makeWorker(meet);
    worker.enqueueFromPush(fileGeneratedPush());
    // Simula 9 falhas anteriores; a próxima é a décima.
    db.recordEventFailure(1, EVENT_MAX_ATTEMPTS - 1, clock.toISOString(), 'HTTP 500');

    await worker.processOnce();
    expect(db.getEvent(1)?.status).toBe('dead');
    expect(db.countEventQueue().dead).toBe(1);

    // Não retenta mais.
    avancar(24 * 60 * 60 * 1000);
    await worker.processOnce();
    expect(db.getEvent(1)?.attempts).toBe(EVENT_MAX_ATTEMPTS);
  });

  it('conference.ended: agenda re-checagem em 2 min e retenta até o transcript aparecer', async () => {
    let listadas = 0;
    const meet = happyMeet({
      listTranscripts: () => {
        listadas += 1;
        return Promise.resolve(listadas === 1 ? [] : [{ name: TRANSCRIPT }]);
      },
    });
    db.upsertLink({ sessionId: SESSION_ID, meetingCode: CODE, spaceName: SPACE, source: 'auto' });
    const worker = makeWorker(meet);

    worker.enqueueFromPush(endedPush());
    expect(db.getEvent(1)?.next_attempt_at).toBe(
      new Date(clock.getTime() + ENDED_RECHECK_DELAY_MS).toISOString()
    );

    // Ainda dentro dos 2 min: não processa.
    await worker.processOnce();
    expect(listadas).toBe(0);

    // 1ª re-checagem: sem transcripts ainda → retry com backoff.
    avancar(ENDED_RECHECK_DELAY_MS + 1000);
    await worker.processOnce();
    expect(db.getEvent(1)?.status).toBe('pending');
    expect(db.getEvent(1)?.attempts).toBe(1);

    // 2ª re-checagem: transcript apareceu → pipeline completo → done.
    avancar(EVENT_BASE_BACKOFF_MS + 1000);
    await worker.processOnce();
    expect(db.getEvent(1)?.status).toBe('done');
    expect(db.getTranscriptSent(TRANSCRIPT)?.voreo_status).toBe('skipped-no-url');
  });

  it('deduplica eventos ativos do mesmo recurso (redelivery do Pub/Sub)', () => {
    const worker = makeWorker(happyMeet());
    worker.enqueueFromPush(fileGeneratedPush());
    worker.enqueueFromPush(fileGeneratedPush());
    expect(db.countEventQueue().pending).toBe(1);
  });
});
