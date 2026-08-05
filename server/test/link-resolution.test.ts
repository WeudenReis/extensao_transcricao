import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db.js';
import { TranscriptPipeline } from '../src/pipeline/transcript.js';
import { VoreoClient } from '../src/voreo/client.js';
import { makeMeetStub } from './helpers.js';

const SESSION_ID = '3f2b4c1a-9d8e-4f00-b111-222233334444';
const SPACE = 'spaces/space-abc';
const CODE = 'abc-defg-hij';

describe('resolução de vínculo sessionId↔meet', () => {
  let db: Db;

  beforeEach(() => {
    db = new Db(':memory:');
  });

  function makePipeline(meet = makeMeetStub()): TranscriptPipeline {
    const voreo = new VoreoClient({ db, webhookUrl: undefined, apiKey: undefined });
    return new TranscriptPipeline({ db, meet, voreo });
  }

  it('encontra o vínculo direto pelo space_name', async () => {
    db.upsertLink({ sessionId: SESSION_ID, meetingCode: CODE, spaceName: SPACE, source: 'extension' });
    const pipeline = makePipeline(); // nenhum método do Meet deve ser chamado

    const link = await pipeline.resolveLink(SPACE);

    expect(link).toBeDefined();
    expect(link?.session_id).toBe(SESSION_ID);
    expect(link?.space_name).toBe(SPACE);
  });

  it('resolve pelo meeting_code via spaces.get e persiste o space_name no vínculo', async () => {
    db.upsertLink({ sessionId: SESSION_ID, meetingCode: CODE, spaceName: null, source: 'extension' });
    const meet = makeMeetStub({
      getSpace: (spaceName) => {
        expect(spaceName).toBe(SPACE);
        return Promise.resolve({ name: SPACE, meetingCode: CODE });
      },
    });
    const pipeline = makePipeline(meet);

    const link = await pipeline.resolveLink(SPACE);

    expect(link?.session_id).toBe(SESSION_ID);
    expect(link?.space_name).toBe(SPACE);
    // Persistiu: próxima resolução acha direto pelo space_name.
    expect(db.findLinkBySpaceName(SPACE)?.session_id).toBe(SESSION_ID);
  });

  it('normaliza o meetingCode devolvido pelo spaces.get antes de comparar', async () => {
    db.upsertLink({ sessionId: SESSION_ID, meetingCode: CODE, spaceName: null, source: 'manual' });
    const meet = makeMeetStub({
      getSpace: () => Promise.resolve({ name: SPACE, meetingCode: 'ABC-DEFG-HIJ' }),
    });
    const pipeline = makePipeline(meet);

    const link = await pipeline.resolveLink(SPACE);

    expect(link?.session_id).toBe(SESSION_ID);
  });

  it('devolve undefined quando não há vínculo nem por space nem por código', async () => {
    const meet = makeMeetStub({
      getSpace: () => Promise.resolve({ name: SPACE, meetingCode: 'zzz-zzzz-zzz' }),
    });
    const pipeline = makePipeline(meet);

    const link = await pipeline.resolveLink(SPACE);

    expect(link).toBeUndefined();
  });

  it('devolve undefined (sem lançar) quando o spaces.get falha', async () => {
    const meet = makeMeetStub({
      getSpace: () => Promise.reject(new Error('HTTP 403')),
    });
    const pipeline = makePipeline(meet);

    const link = await pipeline.resolveLink(SPACE);

    expect(link).toBeUndefined();
  });
});
