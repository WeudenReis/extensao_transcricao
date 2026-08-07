import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
  criarPainelAuth,
  ehCaminhoLivre,
  extrairToken,
  tokenConfere,
  COOKIE_TOKEN,
} from '../src/routes/painelAuth.js';

/**
 * A tranca do painel existe por um motivo concreto: pro Recall entregar os
 * webhooks o servidor precisa estar público, e o túnel publica o app INTEIRO —
 * inclusive as rotas que devolvem transcrição de reunião.
 */

const TOKEN = 'token-de-teste-bem-longo-123';

const servidores: Server[] = [];
afterEach(() => {
  for (const s of servidores.splice(0)) s.close();
});

async function montarApp(token: string | undefined): Promise<string> {
  const app = express();
  app.use(criarPainelAuth(token));
  app.get('/', (_req, res) => {
    res.type('html').send('<p>painel</p>');
  });
  app.get('/api/meetings/:id', (_req, res) => {
    res.json({ falas: [{ speaker: 'Cliente', text: 'segredo do cliente' }] });
  });
  app.post('/webhooks/recall', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/capture/start', (_req, res) => {
    res.json({ ok: true });
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servidores.push(server);
  const addr = server.address();
  const porta = typeof addr === 'object' && addr ? addr.port : 0;
  return `http://127.0.0.1:${porta}`;
}

describe('leitura do token', () => {
  it('aceita Authorization: Bearer', () => {
    expect(extrairToken({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
    expect(extrairToken({ authorization: `bearer ${TOKEN}` })).toBe(TOKEN);
  });

  it('aceita ?token= e o cookie', () => {
    expect(extrairToken({ query: TOKEN })).toBe(TOKEN);
    expect(extrairToken({ cookie: `outro=1; ${COOKIE_TOKEN}=${TOKEN}` })).toBe(TOKEN);
  });

  it('devolve undefined quando não há nada utilizável', () => {
    expect(extrairToken({})).toBeUndefined();
    expect(extrairToken({ authorization: 'Basic abc' })).toBeUndefined();
    expect(extrairToken({ authorization: 'Bearer   ' })).toBeUndefined();
  });

  it('compara sem vazar tempo e sem casar por prefixo', () => {
    expect(tokenConfere(TOKEN, TOKEN)).toBe(true);
    expect(tokenConfere('token-de-teste-bem-longo-124', TOKEN)).toBe(false);
    expect(tokenConfere('token-de', TOKEN)).toBe(false); // prefixo não passa
    expect(tokenConfere('', TOKEN)).toBe(false);
  });
});

describe('caminhos livres', () => {
  it('só webhooks e health ficam livres', () => {
    // Webhook tem assinatura própria (Svix/OIDC); exigir token quebraria a
    // entrega do Recall.
    expect(ehCaminhoLivre('/webhooks/recall')).toBe(true);
    expect(ehCaminhoLivre('/webhooks/chatpro/abc')).toBe(true);
    expect(ehCaminhoLivre('/webhooks/pubsub')).toBe(true);
    expect(ehCaminhoLivre('/api/health')).toBe(true);
  });

  it('/api/capture/* NÃO é livre — aberto no túnel, dava pra forjar transcrição', () => {
    expect(ehCaminhoLivre('/api/capture/start')).toBe(false);
    expect(ehCaminhoLivre('/api/capture/chunk')).toBe(false);
  });

  it('painel e leitura de reunião NÃO são livres', () => {
    expect(ehCaminhoLivre('/')).toBe(false);
    expect(ehCaminhoLivre('/api/meetings')).toBe(false);
    expect(ehCaminhoLivre('/api/meetings/abc')).toBe(false);
    expect(ehCaminhoLivre('/api/captures')).toBe(false);
    // Não pode ser burlado por um caminho que só COMECE parecido.
    expect(ehCaminhoLivre('/api/capturesecreto')).toBe(false);
    expect(ehCaminhoLivre('/webhooksfalso/x')).toBe(false);
  });
});

describe('middleware com PANEL_TOKEN configurado', () => {
  it('recusa a transcrição sem token', async () => {
    const base = await montarApp(TOKEN);
    const res = await fetch(`${base}/api/meetings/abc`);

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('segredo do cliente');
  });

  it('libera com o token certo no header', async () => {
    const base = await montarApp(TOKEN);
    const res = await fetch(`${base}/api/meetings/abc`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('segredo do cliente');
  });

  it('recusa token errado', async () => {
    const base = await montarApp(TOKEN);
    const res = await fetch(`${base}/api/meetings/abc`, {
      headers: { Authorization: 'Bearer token-errado-bem-longo-123' },
    });

    expect(res.status).toBe(401);
  });

  it('entrar pela URL com ?token= grava o cookie pra navegação seguinte', async () => {
    const base = await montarApp(TOKEN);
    const res = await fetch(`${base}/?token=${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(COOKIE_TOKEN);
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('o webhook do Recall continua passando sem token', async () => {
    const base = await montarApp(TOKEN);
    const res = await fetch(`${base}/webhooks/recall`, { method: 'POST' });

    // Se a tranca pegasse aqui, o Recall levaria 401 e reentregaria por 24 h
    // até desativar o endpoint.
    expect(res.status).toBe(200);
  });

  it('a ingestão de captura agora exige token', async () => {
    const base = await montarApp(TOKEN);
    const res = await fetch(`${base}/api/capture/start`, { method: 'POST' });

    expect(res.status).toBe(401);
  });

  it('responde HTML pro navegador e JSON pra chamada de API', async () => {
    const base = await montarApp(TOKEN);

    const navegador = await fetch(`${base}/`, { headers: { Accept: 'text/html' } });
    expect(navegador.headers.get('content-type')).toContain('html');
    expect(await navegador.text()).toContain('PANEL_TOKEN');

    const api = await fetch(`${base}/api/meetings/abc`, { headers: { Accept: 'application/json' } });
    expect(api.headers.get('content-type')).toContain('json');
  });
});

describe('middleware sem PANEL_TOKEN (modo dev)', () => {
  it('deixa tudo passar — o aviso de boot é quem cobra a configuração', async () => {
    const base = await montarApp(undefined);
    const res = await fetch(`${base}/api/meetings/abc`);

    expect(res.status).toBe(200);
  });
});
