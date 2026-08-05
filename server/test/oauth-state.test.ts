import { describe, it, expect } from 'vitest';
import { Db } from '../src/db.js';
import { GoogleAuth } from '../src/google/auth.js';

function makeAuth(): GoogleAuth {
  return new GoogleAuth({
    clientId: 'client-teste',
    clientSecret: 'secret-teste',
    redirectUri: 'http://localhost:3333/oauth/callback',
    tokenEncryptionKey: 'chave-teste',
    db: new Db(':memory:'),
  });
}

describe('state anti-CSRF do fluxo OAuth', () => {
  it('inclui um state aleatório na URL de consent', () => {
    const auth = makeAuth();
    const url = new URL(auth.buildAuthUrl());
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gera states diferentes a cada /oauth/start', () => {
    const auth = makeAuth();
    const state1 = new URL(auth.buildAuthUrl()).searchParams.get('state');
    const state2 = new URL(auth.buildAuthUrl()).searchParams.get('state');
    expect(state1).not.toBe(state2);
  });

  it('consome o state uma única vez (replay é rejeitado)', () => {
    const auth = makeAuth();
    const state = new URL(auth.buildAuthUrl()).searchParams.get('state');
    expect(state).toBeTruthy();
    if (!state) return;
    expect(auth.consumeState(state)).toBe(true);
    expect(auth.consumeState(state)).toBe(false);
  });

  it('rejeita state desconhecido (possível CSRF)', () => {
    const auth = makeAuth();
    auth.buildAuthUrl();
    expect(auth.consumeState('state-forjado-pelo-atacante')).toBe(false);
  });
});
