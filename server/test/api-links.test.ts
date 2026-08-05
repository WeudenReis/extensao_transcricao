import { describe, it, expect } from 'vitest';
import { linkBodySchema } from '../src/routes/api.js';
import { normalizeMeetingCode } from '../src/google/meet.js';

const SESSION_ID = '3f2b4c1a-9d8e-4f00-b111-222233334444';

describe('validação zod de POST /api/links', () => {
  it('aceita corpo válido e aplica source padrão "extension"', () => {
    const resultado = linkBodySchema.safeParse({
      sessionId: SESSION_ID,
      meetingCode: 'abc-defg-hij',
    });
    expect(resultado.success).toBe(true);
    if (resultado.success) {
      expect(resultado.data.sessionId).toBe(SESSION_ID);
      expect(resultado.data.meetingCode).toBe('abc-defg-hij');
      expect(resultado.data.source).toBe('extension');
    }
  });

  it('normaliza meetingCode vindo como URL completa do Meet', () => {
    const resultado = linkBodySchema.safeParse({
      sessionId: SESSION_ID,
      meetingCode: 'https://meet.google.com/abc-defg-hij?authuser=0',
      source: 'manual',
    });
    expect(resultado.success).toBe(true);
    if (resultado.success) {
      expect(resultado.data.meetingCode).toBe('abc-defg-hij');
      expect(resultado.data.source).toBe('manual');
    }
  });

  it('aceita source "auto" (vínculo automático da extensão — fluxo padrão)', () => {
    const resultado = linkBodySchema.safeParse({
      sessionId: SESSION_ID,
      meetingCode: 'abc-defg-hij',
      source: 'auto',
    });
    expect(resultado.success).toBe(true);
    if (resultado.success) {
      expect(resultado.data.source).toBe('auto');
    }
  });

  it('rejeita sessionId que não é UUID', () => {
    const resultado = linkBodySchema.safeParse({
      sessionId: 'nao-e-uuid',
      meetingCode: 'abc-defg-hij',
    });
    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      expect(resultado.error.issues.some((i) => i.path.includes('sessionId'))).toBe(true);
    }
  });

  it('rejeita corpo sem meetingCode', () => {
    const resultado = linkBodySchema.safeParse({ sessionId: SESSION_ID });
    expect(resultado.success).toBe(false);
  });

  it('rejeita source fora do enum', () => {
    const resultado = linkBodySchema.safeParse({
      sessionId: SESSION_ID,
      meetingCode: 'abc-defg-hij',
      source: 'telepatia',
    });
    expect(resultado.success).toBe(false);
  });
});

describe('normalizeMeetingCode', () => {
  it('mantém código já normalizado', () => {
    expect(normalizeMeetingCode('abc-defg-hij')).toBe('abc-defg-hij');
  });

  it('extrai o código de uma URL do Meet', () => {
    expect(normalizeMeetingCode('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij');
  });

  it('remove query string, barra final e baixa a caixa', () => {
    expect(normalizeMeetingCode('ABC-DEFG-HIJ/?hs=190')).toBe('abc-defg-hij');
  });
});
