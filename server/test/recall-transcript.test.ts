import { describe, it, expect } from 'vitest';
import {
  normalizarTranscript,
  type RecallTranscriptEntry,
} from '../src/recall/transcript.js';

function palavra(text: string, ini: number, fim: number) {
  return {
    text,
    start_timestamp: { absolute: null, relative: ini },
    end_timestamp: { absolute: null, relative: fim },
  };
}

describe('normalização do transcript do Recall.ai', () => {
  it('junta palavras do mesmo participante numa fala legível', () => {
    const bruto: RecallTranscriptEntry[] = [
      {
        participant: { id: 1, name: 'Weuden', is_host: true },
        language_code: 'pt-BR',
        words: [palavra('bom', 0, 0.3), palavra('dia', 0.3, 0.6)],
      },
    ];
    const r = normalizarTranscript(bruto);
    expect(r.falas).toHaveLength(1);
    expect(r.falas[0]?.text).toBe('bom dia');
    expect(r.falas[0]?.speaker).toBe('Weuden');
    expect(r.falas[0]?.isHost).toBe(true);
  });

  it('separa em falas diferentes quando há pausa longa', () => {
    const bruto: RecallTranscriptEntry[] = [
      {
        participant: { id: 1, name: 'Weuden' },
        words: [
          palavra('oi', 0, 0.4),
          palavra('tudo', 0.5, 0.8),
          // pausa de 5s
          palavra('voltei', 6, 6.4),
        ],
      },
    ];
    const r = normalizarTranscript(bruto);
    expect(r.falas).toHaveLength(2);
    expect(r.falas[0]?.text).toBe('oi tudo');
    expect(r.falas[1]?.text).toBe('voltei');
  });

  it('ordena as falas pela linha do tempo, mesmo vindo separadas por pessoa', () => {
    const bruto: RecallTranscriptEntry[] = [
      {
        participant: { id: 1, name: 'Atendente' },
        words: [palavra('primeiro', 0, 0.5), palavra('terceiro', 10, 10.5)],
      },
      {
        participant: { id: 2, name: 'Cliente' },
        words: [palavra('segundo', 5, 5.5)],
      },
    ];
    const r = normalizarTranscript(bruto);
    expect(r.falas.map((f) => f.text)).toEqual(['primeiro', 'segundo', 'terceiro']);
    expect(r.falas.map((f) => f.speaker)).toEqual(['Atendente', 'Cliente', 'Atendente']);
  });

  it('NÃO repete texto (o problema que tínhamos com a legenda do Meet)', () => {
    const bruto: RecallTranscriptEntry[] = [
      {
        participant: { id: 1, name: 'Michael' },
        words: [
          palavra('não', 0, 0.3),
          palavra('tem', 0.3, 0.6),
          palavra('opção.', 0.6, 1.0),
          palavra('tem', 2.8, 3.0),
          palavra('sim.', 3.0, 3.3),
        ],
      },
    ];
    const r = normalizarTranscript(bruto);
    const juntos = r.falas.map((f) => f.text).join(' | ');
    expect(juntos).toBe('não tem opção. | tem sim.');
    // Nenhuma fala pode conter a anterior inteira dentro de si.
    for (let i = 1; i < r.falas.length; i++) {
      expect(r.falas[i]?.text.includes(r.falas[i - 1]?.text ?? '')).toBe(false);
    }
  });

  it('lista os participantes uma única vez', () => {
    const bruto: RecallTranscriptEntry[] = [
      { participant: { id: 1, name: 'A', is_host: true }, words: [palavra('x', 0, 1)] },
      { participant: { id: 2, name: 'B', email: 'b@x.com' }, words: [palavra('y', 2, 3)] },
    ];
    const r = normalizarTranscript(bruto);
    expect(r.participantes.map((p) => p.nome)).toEqual(['A', 'B']);
    expect(r.participantes[0]?.isHost).toBe(true);
    expect(r.participantes[1]?.email).toBe('b@x.com');
  });

  it('dá um rótulo estável a quem está sem nome', () => {
    const bruto: RecallTranscriptEntry[] = [
      { participant: { id: 7, name: null }, words: [palavra('alô', 0, 0.5)] },
    ];
    const r = normalizarTranscript(bruto);
    expect(r.falas[0]?.speaker).toBe('Participante 7');
  });

  it('aguenta transcript vazio ou nulo sem quebrar', () => {
    expect(normalizarTranscript([]).falas).toEqual([]);
    expect(normalizarTranscript(null).falas).toEqual([]);
    expect(normalizarTranscript(undefined).duracaoSegundos).toBe(0);
  });

  it('calcula a duração pelo fim da última fala', () => {
    const bruto: RecallTranscriptEntry[] = [
      { participant: { id: 1, name: 'A' }, words: [palavra('fim', 100, 102.4)] },
    ];
    expect(normalizarTranscript(bruto).duracaoSegundos).toBe(102);
  });
});
