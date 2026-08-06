import { describe, it, expect } from 'vitest';
import {
  mergeTracks,
  labelRemote,
  labelMic,
  computeCoverage,
  concatChunks,
  type MergedEntry,
} from '../src/pipeline/audioTranscript.js';
import type { SttEntry } from '../src/stt/types.js';
import type { CaptureHeartbeatRow } from '../src/db.js';

function hb(overrides: Partial<CaptureHeartbeatRow>): CaptureHeartbeatRow {
  return {
    id: 0,
    capture_id: 'c1',
    at: '2026-08-05T10:00:00.000Z',
    capturing: 1,
    in_call: 1,
    mic_active: 1,
    remote_tracks: 1,
    bytes_sent: 0,
    ...overrides,
  };
}

describe('rotulagem de falantes', () => {
  it('rotula toda a trilha do microfone como "Atendente"', () => {
    const entries: SttEntry[] = [
      { speaker: 'Falante 1', text: 'oi', startMs: 0, endMs: 500 },
      { speaker: 'Falante 2', text: 'tudo bem', startMs: 600, endMs: 1000 },
    ];
    expect(labelMic(entries).every((e) => e.speaker === 'Atendente')).toBe(true);
  });

  it('quando a trilha remota tem só um falante, rotula como "Cliente"', () => {
    const entries: SttEntry[] = [
      { speaker: 'Falante 1', text: 'alô', startMs: 0, endMs: 500 },
      { speaker: 'Falante 1', text: 'quero saber do pedido', startMs: 600, endMs: 1200 },
    ];
    expect(labelRemote(entries).every((e) => e.speaker === 'Cliente')).toBe(true);
  });

  it('quando a trilha remota tem vários falantes, mantém os rótulos', () => {
    const entries: SttEntry[] = [
      { speaker: 'Falante 1', text: 'a', startMs: 0, endMs: 500 },
      { speaker: 'Falante 2', text: 'b', startMs: 600, endMs: 1000 },
    ];
    const labeled = labelRemote(entries);
    expect(labeled.map((e) => e.speaker)).toEqual(['Falante 1', 'Falante 2']);
  });
});

describe('fusão das trilhas', () => {
  it('ordena atendente e cliente pela linha do tempo', () => {
    const mic: MergedEntry[] = [
      { speaker: 'Atendente', text: 'bom dia', startMs: 0, endMs: 800 },
      { speaker: 'Atendente', text: 'como posso ajudar', startMs: 2000, endMs: 3000 },
    ];
    const remote: MergedEntry[] = [
      { speaker: 'Cliente', text: 'bom dia', startMs: 900, endMs: 1500 },
      { speaker: 'Cliente', text: 'tive um problema', startMs: 3100, endMs: 4000 },
    ];
    const merged = mergeTracks(mic, remote);
    expect(merged.map((e) => e.speaker)).toEqual([
      'Atendente',
      'Cliente',
      'Atendente',
      'Cliente',
    ]);
    expect(merged.map((e) => e.startMs)).toEqual([0, 900, 2000, 3100]);
  });
});

describe('concatenação de chunks', () => {
  it('junta os buffers na ordem recebida', () => {
    const out = concatChunks([Buffer.from([1, 2]), Buffer.from([3]), Buffer.from([4, 5])]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('cobertura anti-adulteração', () => {
  it('cobertura ~100% quando os heartbeats cobrem toda a chamada', () => {
    const start = '2026-08-05T10:00:00.000Z';
    const end = '2026-08-05T10:00:45.000Z';
    const heartbeats = [
      hb({ at: '2026-08-05T10:00:00.000Z' }),
      hb({ at: '2026-08-05T10:00:15.000Z' }),
      hb({ at: '2026-08-05T10:00:30.000Z' }),
      hb({ at: '2026-08-05T10:00:45.000Z' }),
    ];
    const cov = computeCoverage(start, end, heartbeats);
    expect(cov.ratio).toBeGreaterThan(0.95);
    expect(cov.gaps).toHaveLength(0);
  });

  it('detecta gap quando a captura é desligada durante a chamada (inCall=true, capturing=false)', () => {
    const start = '2026-08-05T10:00:00.000Z';
    const end = '2026-08-05T10:00:45.000Z';
    const heartbeats = [
      hb({ at: '2026-08-05T10:00:00.000Z', capturing: 1 }),
      // atendente tentou "burlar": em chamada, mas sem capturar
      hb({ at: '2026-08-05T10:00:15.000Z', capturing: 0, in_call: 1 }),
      hb({ at: '2026-08-05T10:00:30.000Z', capturing: 1 }),
      hb({ at: '2026-08-05T10:00:45.000Z', capturing: 1 }),
    ];
    const cov = computeCoverage(start, end, heartbeats);
    const suspeito = cov.gaps.find((g) => g.reason === 'capturing-off-in-call');
    expect(suspeito).toBeDefined();
    expect(cov.ratio).toBeLessThan(1);
  });

  it('detecta buraco por ausência de heartbeats no meio', () => {
    const start = '2026-08-05T10:00:00.000Z';
    const end = '2026-08-05T10:01:00.000Z';
    const heartbeats = [
      hb({ at: '2026-08-05T10:00:00.000Z' }),
      // salto de 45s sem sinal
      hb({ at: '2026-08-05T10:00:45.000Z' }),
      hb({ at: '2026-08-05T10:01:00.000Z' }),
    ];
    const cov = computeCoverage(start, end, heartbeats);
    expect(cov.gaps.some((g) => g.reason === 'no-heartbeat')).toBe(true);
  });
});
