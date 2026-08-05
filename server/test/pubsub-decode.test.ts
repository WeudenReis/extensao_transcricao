import { describe, it, expect } from 'vitest';
import {
  decodePubSubPush,
  extractResourceName,
  EVENT_TRANSCRIPT_FILE_GENERATED,
  EVENT_CONFERENCE_ENDED,
} from '../src/routes/pubsub.js';

function encodeData(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

describe('decodificação de mensagem Pub/Sub push (base64 → CloudEvent)', () => {
  it('decodifica evento transcript.v2.fileGenerated com ce-type nos attributes', () => {
    const body = {
      message: {
        data: encodeData({
          transcript: { name: 'conferenceRecords/rec1/transcripts/t1' },
        }),
        attributes: {
          'ce-type': EVENT_TRANSCRIPT_FILE_GENERATED,
          'ce-source': '//meet.googleapis.com',
        },
        messageId: 'msg-123',
        publishTime: '2026-08-05T13:37:00Z',
      },
      subscription: 'projects/p/subscriptions/meet-events-push',
    };

    const decodificada = decodePubSubPush(body);

    expect(decodificada.ceType).toBe(EVENT_TRANSCRIPT_FILE_GENERATED);
    expect(decodificada.messageId).toBe('msg-123');
    expect(decodificada.subscription).toBe('projects/p/subscriptions/meet-events-push');
    expect(extractResourceName(decodificada.payload, 'transcript')).toBe(
      'conferenceRecords/rec1/transcripts/t1'
    );
  });

  it('decodifica evento conference.v2.ended com conferenceRecord.name', () => {
    const body = {
      message: {
        data: encodeData({ conferenceRecord: { name: 'conferenceRecords/rec9' } }),
        attributes: { 'ce-type': EVENT_CONFERENCE_ENDED },
      },
    };

    const decodificada = decodePubSubPush(body);

    expect(decodificada.ceType).toBe(EVENT_CONFERENCE_ENDED);
    expect(extractResourceName(decodificada.payload, 'conferenceRecord')).toBe(
      'conferenceRecords/rec9'
    );
    expect(extractResourceName(decodificada.payload, 'transcript')).toBeUndefined();
  });

  it('devolve payload vazio quando message.data está ausente', () => {
    const decodificada = decodePubSubPush({ message: { attributes: { 'ce-type': 'x' } } });
    expect(decodificada.payload).toEqual({});
    expect(decodificada.ceType).toBe('x');
  });

  it('ceType fica undefined sem o attribute ce-type', () => {
    const decodificada = decodePubSubPush({ message: { data: encodeData({}) } });
    expect(decodificada.ceType).toBeUndefined();
  });

  it('lança erro para corpo que não segue o contrato do push', () => {
    expect(() => decodePubSubPush({ foo: 'bar' })).toThrow();
  });

  it('lança erro quando data não é JSON válido', () => {
    const body = {
      message: { data: Buffer.from('isto não é json', 'utf8').toString('base64') },
    };
    expect(() => decodePubSubPush(body)).toThrow();
  });
});
