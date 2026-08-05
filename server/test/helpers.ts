import type { MeetApi } from '../src/google/meet.js';

/** Stub completo de MeetApi: todo método não sobrescrito rejeita com erro claro. */
export function makeMeetStub(overrides: Partial<MeetApi> = {}): MeetApi {
  const naoEsperado =
    (metodo: string) => (): Promise<never> =>
      Promise.reject(new Error(`método não esperado no teste: ${metodo}`));
  return {
    getSpaceByMeetingCode: naoEsperado('getSpaceByMeetingCode'),
    getSpace: naoEsperado('getSpace'),
    createSpaceWithTranscription: naoEsperado('createSpaceWithTranscription'),
    patchSpaceTranscription: naoEsperado('patchSpaceTranscription'),
    getConferenceRecord: naoEsperado('getConferenceRecord'),
    listConferenceRecordsBySpace: naoEsperado('listConferenceRecordsBySpace'),
    listTranscripts: naoEsperado('listTranscripts'),
    getTranscript: naoEsperado('getTranscript'),
    listAllTranscriptEntries: naoEsperado('listAllTranscriptEntries'),
    listAllParticipants: naoEsperado('listAllParticipants'),
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
