import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Db } from '../src/db.js';

/** Tabelas `meetings` e `recall_events` (integração Recall.ai), em banco de memória. */

const MEETING_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const BOT_ID = 'bot-abc-123';
const SESSION_ID = '3f2b4c1a-9d8e-4f00-b111-222233334444';
const MEETING_URL = 'https://meet.google.com/abc-defg-hij';
const T0 = '2026-08-06T12:00:00.000Z';

describe('fila de webhooks do Recall', () => {
  let db: Db;

  beforeEach(() => {
    db = new Db(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  function enfileirar(webhookId: string | null, nextAttemptAt = T0): { id: number; created: boolean } {
    return db.enqueueRecallEvent({
      webhookId,
      event: 'transcript.done',
      botId: BOT_ID,
      payloadJson: JSON.stringify({ event: 'transcript.done' }),
      nextAttemptAt,
      createdAt: T0,
    });
  }

  it('deduplica por webhook_id (o Recall reentrega por 24 h)', () => {
    const primeiro = enfileirar('msg_2xYz');
    expect(primeiro.created).toBe(true);

    const reentrega = enfileirar('msg_2xYz');
    expect(reentrega.created).toBe(false);
    expect(reentrega.id).toBe(primeiro.id);
    expect(db.countRecallEvents().pending).toBe(1);
  });

  it('sem webhook_id (modo inseguro de dev) cada chegada é um item novo', () => {
    enfileirar(null);
    enfileirar(null);
    expect(db.countRecallEvents().pending).toBe(2);
  });

  it('dueRecallEvents respeita next_attempt_at', () => {
    const futuro = '2026-08-06T12:05:00.000Z';
    const { id } = enfileirar('msg_futuro', futuro);

    expect(db.dueRecallEvents(T0, 10)).toHaveLength(0);
    expect(db.dueRecallEvents(futuro, 10).map((r) => r.id)).toEqual([id]);
    expect(db.dueRecallEvents('2026-08-06T12:06:00.000Z', 10)).toHaveLength(1);
  });

  it('falha transitória reagenda; done e dead saem da fila', () => {
    const { id } = enfileirar('msg_1');

    db.recordRecallEventFailure(id, 1, '2026-08-06T12:00:30.000Z', 'Recall API respondeu HTTP 500');
    const aposFalha = db.getRecallEvent(id);
    expect(aposFalha?.status).toBe('pending');
    expect(aposFalha?.attempts).toBe(1);
    expect(aposFalha?.last_error).toContain('HTTP 500');
    expect(db.dueRecallEvents(T0, 10)).toHaveLength(0);
    expect(db.dueRecallEvents('2026-08-06T12:00:30.000Z', 10)).toHaveLength(1);

    db.markRecallEventDone(id);
    expect(db.getRecallEvent(id)?.status).toBe('done');
    expect(db.getRecallEvent(id)?.next_attempt_at).toBeNull();
    expect(db.dueRecallEvents('2026-08-07T00:00:00.000Z', 10)).toHaveLength(0);

    const outro = enfileirar('msg_2');
    db.markRecallEventDead(outro.id, 'desisti após 8 tentativas', 8);
    expect(db.getRecallEvent(outro.id)?.status).toBe('dead');
    expect(db.getRecallEvent(outro.id)?.attempts).toBe(8);
    expect(db.dueRecallEvents('2026-08-07T00:00:00.000Z', 10)).toHaveLength(0);
    expect(db.countRecallEvents()).toEqual({ pending: 0, done: 1, dead: 1 });
  });

  it('respeita o limite de itens por passada, do mais antigo pro mais novo', () => {
    enfileirar('msg_a', '2026-08-06T12:00:03.000Z');
    enfileirar('msg_b', '2026-08-06T12:00:01.000Z');
    enfileirar('msg_c', '2026-08-06T12:00:02.000Z');

    const due = db.dueRecallEvents('2026-08-06T12:01:00.000Z', 2);
    expect(due.map((r) => r.webhook_id)).toEqual(['msg_b', 'msg_c']);
  });
});

describe('ciclo de vida da reunião', () => {
  let db: Db;

  beforeEach(() => {
    db = new Db(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  function criar(): void {
    db.createMeeting({
      id: MEETING_ID,
      botId: BOT_ID,
      sessionId: SESSION_ID,
      meetingUrl: MEETING_URL,
      meetingCode: 'abc-defg-hij',
      botName: 'chatPro (gravando)',
      createdAt: T0,
    });
  }

  it('created → joining → recording → done, carimbando início e fim', () => {
    criar();
    const nova = db.getMeeting(MEETING_ID);
    expect(nova?.status).toBe('created');
    expect(nova?.chatpro_status).toBe('pending');
    expect(nova?.started_at).toBeNull();
    expect(nova?.ended_at).toBeNull();

    db.updateMeetingStatus(MEETING_ID, 'joining');
    expect(db.getMeeting(MEETING_ID)?.started_at).toBeNull();

    db.updateMeetingStatus(MEETING_ID, 'recording');
    const gravando = db.getMeeting(MEETING_ID);
    expect(gravando?.status).toBe('recording');
    expect(gravando?.started_at).not.toBeNull();

    // Webhook reentregue não pode reescrever o horário de início.
    db.updateMeetingStatus(MEETING_ID, 'recording');
    expect(db.getMeeting(MEETING_ID)?.started_at).toBe(gravando?.started_at);

    db.updateMeetingStatus(MEETING_ID, 'ended');
    const encerrada = db.getMeeting(MEETING_ID);
    expect(encerrada?.ended_at).not.toBeNull();

    db.setMeetingTranscript({
      id: MEETING_ID,
      transcriptJson: JSON.stringify([{ speaker: 'Maria', text: 'olá', startMs: 0, endMs: 500 }]),
      durationSeconds: 1830,
    });
    db.updateMeetingStatus(MEETING_ID, 'done');

    const pronta = db.getMeeting(MEETING_ID);
    expect(pronta?.status).toBe('done');
    expect(pronta?.duration_seconds).toBe(1830);
    expect(pronta?.started_at).toBe(gravando?.started_at);
    expect(pronta?.ended_at).toBe(encerrada?.ended_at);
    expect(JSON.parse(pronta?.transcript_json ?? '[]')).toHaveLength(1);
  });

  it('failed guarda o motivo e o status seguinte limpa o erro', () => {
    criar();
    db.updateMeetingStatus(MEETING_ID, 'failed', 'bot.fatal: meeting_not_found');
    expect(db.getMeeting(MEETING_ID)?.error).toContain('meeting_not_found');

    db.updateMeetingStatus(MEETING_ID, 'recording');
    expect(db.getMeeting(MEETING_ID)?.error).toBeNull();
  });

  it('acha a reunião pelo bot_id (é só isso que o webhook traz)', () => {
    criar();
    expect(db.getMeetingByBotId(BOT_ID)?.id).toBe(MEETING_ID);
    expect(db.getMeetingByBotId('bot-inexistente')).toBeUndefined();
  });

  it('vínculo com o chatPro pode chegar depois e a entrega tem status próprio', () => {
    db.createMeeting({
      id: MEETING_ID,
      botId: BOT_ID,
      sessionId: null,
      meetingUrl: MEETING_URL,
      meetingCode: null,
      botName: null,
      createdAt: T0,
    });
    expect(db.getMeeting(MEETING_ID)?.session_id).toBeNull();

    db.setMeetingSessionId(MEETING_ID, SESSION_ID);
    expect(db.getMeeting(MEETING_ID)?.session_id).toBe(SESSION_ID);

    db.setMeetingChatproStatus(MEETING_ID, 'skipped-no-url');
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('skipped-no-url');
    db.setMeetingChatproStatus(MEETING_ID, 'sent');
    expect(db.getMeeting(MEETING_ID)?.chatpro_status).toBe('sent');
  });

  it('lista da mais recente pra mais antiga, respeitando o limite, e conta por status', () => {
    for (let i = 1; i <= 3; i += 1) {
      db.createMeeting({
        id: `reuniao-${i}`,
        botId: `bot-${i}`,
        sessionId: null,
        meetingUrl: MEETING_URL,
        meetingCode: null,
        botName: null,
        createdAt: `2026-08-06T1${i}:00:00.000Z`,
      });
    }
    db.updateMeetingStatus('reuniao-1', 'done');

    expect(db.listMeetings(2).map((m) => m.id)).toEqual(['reuniao-3', 'reuniao-2']);
    expect(db.countMeetings()).toEqual({ created: 2, done: 1 });
  });

  it('bot_id é único — o mesmo bot não vira duas reuniões', () => {
    criar();
    expect(() =>
      db.createMeeting({
        id: 'outra-reuniao',
        botId: BOT_ID,
        sessionId: null,
        meetingUrl: MEETING_URL,
        meetingCode: null,
        botName: null,
        createdAt: T0,
      })
    ).toThrow(/UNIQUE/i);
  });

  it('não mexe nas tabelas que já existiam (captures segue funcionando)', () => {
    db.createCapture({
      id: 'cap-1',
      sessionId: SESSION_ID,
      meetingCode: 'abc-defg-hij',
      mode: 'audio',
      mimeType: 'audio/webm',
      startedAt: T0,
    });
    expect(db.getCapture('cap-1')?.status).toBe('recording');
    expect(db.listMeetings()).toHaveLength(0);
  });
});
