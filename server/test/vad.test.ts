import { describe, it, expect } from 'vitest';
import { extrairFala, temFala, remapearMs, detectarFala, SAMPLE_RATE } from '../src/stt/vad.js';

/** Ruído de fundo bem baixinho (o que faz o Whisper alucinar). */
function silencioComRuido(segundos: number): Float32Array {
  const a = new Float32Array(SAMPLE_RATE * segundos);
  for (let i = 0; i < a.length; i++) a[i] = (Math.sin(i * 0.001) + Math.sin(i * 0.7)) * 0.0008;
  return a;
}

/** "Fala": tom forte modulado, bem acima do piso de ruído. */
function fala(segundos: number): Float32Array {
  const a = new Float32Array(SAMPLE_RATE * segundos);
  for (let i = 0; i < a.length; i++) {
    const env = 0.5 + 0.5 * Math.sin((i / SAMPLE_RATE) * 8);
    a[i] = Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 220) * 0.25 * env;
  }
  return a;
}

function concat(...partes: Float32Array[]): Float32Array {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of partes) { out.set(p, off); off += p.length; }
  return out;
}

describe('VAD — proteção contra transcrição inventada', () => {
  it('não encontra fala em áudio só com ruído de fundo', () => {
    const r = extrairFala(silencioComRuido(30));
    expect(temFala(r)).toBe(false);
  });

  it('encontra fala quando ela existe de verdade', () => {
    const r = extrairFala(concat(silencioComRuido(10), fala(3), silencioComRuido(10)));
    expect(temFala(r)).toBe(true);
    expect(r.totalFalaMs).toBeGreaterThan(2000);
  });

  it('descarta a maior parte do silêncio (não vai tudo pro Whisper)', () => {
    const original = concat(silencioComRuido(60), fala(4), silencioComRuido(60));
    const r = extrairFala(original);
    // De ~124s sobra só a fala + margens: bem menos que o original.
    expect(r.totalFalaMs).toBeLessThan(15000);
    expect(r.duracaoOriginalMs).toBeGreaterThan(120000);
  });

  it('remapeia o tempo do áudio reduzido para a linha do tempo real', () => {
    const r = extrairFala(concat(silencioComRuido(30), fala(3), silencioComRuido(5)));
    expect(r.mapa.length).toBeGreaterThan(0);
    // O começo da fala reduzida deve cair perto dos 30s reais (menos a margem).
    const real = remapearMs(0, r.mapa);
    expect(real).toBeGreaterThan(28000);
    expect(real).toBeLessThan(31000);
  });

  it('trecho curtíssimo (estalo) não vira fala', () => {
    const estalo = new Float32Array(SAMPLE_RATE * 30);
    for (let i = 1000; i < 1400; i++) estalo[i] = 0.5; // ~25ms de pico
    expect(detectarFala(estalo).length).toBe(0);
  });
});
