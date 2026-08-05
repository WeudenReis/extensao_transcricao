import { describe, it, expect } from 'vitest';
import { MeetClient } from '../src/google/meet.js';
import {
  assembleTranscript,
  buildParticipantNameMap,
  conferenceRecordFromTranscriptName,
} from '../src/pipeline/transcript.js';
import type { MeetParticipant, TranscriptEntry } from '../src/google/meet.js';
import { jsonResponse } from './helpers.js';

const TRANSCRIPT = 'conferenceRecords/rec1/transcripts/t1';

describe('listAllTranscriptEntries (paginação completa)', () => {
  it('percorre todas as páginas com pageSize=100 e preserva a ordem', async () => {
    const urlsChamadas: string[] = [];
    const fetchFake: typeof fetch = (input) => {
      const url = new URL(String(input));
      urlsChamadas.push(url.toString());
      const pageToken = url.searchParams.get('pageToken');
      if (pageToken === null) {
        return Promise.resolve(
          jsonResponse({
            entries: [
              { participant: 'conferenceRecords/rec1/participants/p1', text: 'Oi, tudo bem?' },
              { participant: 'conferenceRecords/rec1/participants/p2', text: 'Tudo ótimo.' },
            ],
            nextPageToken: 'pagina-2',
          })
        );
      }
      expect(pageToken).toBe('pagina-2');
      return Promise.resolve(
        jsonResponse({
          entries: [
            { participant: 'conferenceRecords/rec1/participants/p1', text: 'Vamos começar.' },
          ],
        })
      );
    };

    const client = new MeetClient({
      getAccessToken: () => Promise.resolve('token-fake'),
      fetchImpl: fetchFake,
    });

    const entries = await client.listAllTranscriptEntries(TRANSCRIPT);

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.text)).toEqual(['Oi, tudo bem?', 'Tudo ótimo.', 'Vamos começar.']);
    expect(urlsChamadas).toHaveLength(2);
    expect(urlsChamadas[0]).toContain(`${TRANSCRIPT}/entries`);
    expect(urlsChamadas[0]).toContain('pageSize=100');
    expect(urlsChamadas[1]).toContain('pageToken=pagina-2');
  });

  it('devolve lista vazia quando o transcript não tem entries', async () => {
    const client = new MeetClient({
      getAccessToken: () => Promise.resolve('token-fake'),
      fetchImpl: () => Promise.resolve(jsonResponse({})),
    });
    const entries = await client.listAllTranscriptEntries(TRANSCRIPT);
    expect(entries).toEqual([]);
  });
});

describe('assembleTranscript (assembler do transcript)', () => {
  const entries: TranscriptEntry[] = [
    {
      participant: 'conferenceRecords/rec1/participants/p1',
      text: 'Bom dia!',
      startTime: '2026-08-05T13:00:00Z',
      endTime: '2026-08-05T13:00:02Z',
      languageCode: 'pt-BR',
    },
    {
      participant: 'conferenceRecords/rec1/participants/p9',
      text: 'Bom dia, vamos lá.',
    },
    { text: 'fala sem participante' },
  ];

  it('resolve participant → displayName quando o participante é conhecido', () => {
    const nomes = new Map([['conferenceRecords/rec1/participants/p1', 'Maria Atendente']]);
    const resultado = assembleTranscript(entries, nomes);
    expect(resultado[0]).toEqual({
      speaker: 'Maria Atendente',
      text: 'Bom dia!',
      startTime: '2026-08-05T13:00:00Z',
      endTime: '2026-08-05T13:00:02Z',
    });
  });

  it('mantém o resource name quando o participante não está no mapa', () => {
    const resultado = assembleTranscript(entries, new Map());
    expect(resultado[1]?.speaker).toBe('conferenceRecords/rec1/participants/p9');
  });

  it('usa "desconhecido" quando a entry não tem participante', () => {
    const resultado = assembleTranscript(entries, new Map());
    expect(resultado[2]?.speaker).toBe('desconhecido');
    expect(resultado[2]?.text).toBe('fala sem participante');
  });
});

describe('buildParticipantNameMap', () => {
  it('extrai displayName de signedinUser, anonymousUser e phoneUser', () => {
    const participantes: MeetParticipant[] = [
      {
        name: 'conferenceRecords/rec1/participants/p1',
        signedinUser: { user: 'users/1', displayName: 'Maria Atendente' },
      },
      {
        name: 'conferenceRecords/rec1/participants/p2',
        anonymousUser: { displayName: 'Cliente (convidado)' },
      },
      {
        name: 'conferenceRecords/rec1/participants/p3',
        phoneUser: { displayName: '+55 11 99999-0000' },
      },
      { name: 'conferenceRecords/rec1/participants/p4' }, // sem displayName → fora do mapa
    ];
    const mapa = buildParticipantNameMap(participantes);
    expect(mapa.get('conferenceRecords/rec1/participants/p1')).toBe('Maria Atendente');
    expect(mapa.get('conferenceRecords/rec1/participants/p2')).toBe('Cliente (convidado)');
    expect(mapa.get('conferenceRecords/rec1/participants/p3')).toBe('+55 11 99999-0000');
    expect(mapa.has('conferenceRecords/rec1/participants/p4')).toBe(false);
  });
});

describe('conferenceRecordFromTranscriptName', () => {
  it('extrai o conferenceRecord do nome do transcript', () => {
    expect(conferenceRecordFromTranscriptName(TRANSCRIPT)).toBe('conferenceRecords/rec1');
  });

  it('lança erro para nome fora do padrão', () => {
    expect(() => conferenceRecordFromTranscriptName('spaces/abc')).toThrow(
      /Nome de transcript inesperado/
    );
  });
});
