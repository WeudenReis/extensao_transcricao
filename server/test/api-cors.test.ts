import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Db } from '../src/db.js';
import { GoogleAuth } from '../src/google/auth.js';
import { VoreoClient } from '../src/voreo/client.js';
import { TranscriptPipeline } from '../src/pipeline/transcript.js';
import { EventQueueWorker } from '../src/pipeline/eventQueue.js';
import { createApiRouter } from '../src/routes/api.js';
import { makeMeetStub } from './helpers.js';

describe('CORS restrito a /api/*', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const db = new Db(':memory:');
    const auth = new GoogleAuth({
      clientId: 'client-teste',
      clientSecret: 'secret-teste',
      redirectUri: 'http://localhost:3333/oauth/callback',
      tokenEncryptionKey: 'chave-teste',
      db,
    });
    const meet = makeMeetStub();
    const voreo = new VoreoClient({ db, webhookUrl: undefined, apiKey: undefined });
    const pipeline = new TranscriptPipeline({ db, meet, voreo });
    const eventQueue = new EventQueueWorker({ db, pipeline });

    const app = express();
    app.use(express.json());
    app.use(createApiRouter({ db, meet, auth, voreo, eventQueue }));
    // Rota fora de /api pra provar que o CORS NÃO vaza pra webhooks.
    app.post('/webhooks/ping', (_req, res) => {
      res.status(204).end();
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('responde o preflight OPTIONS de /api/* com 204 e os headers CORS', async () => {
    const res = await fetch(`${baseUrl}/api/links`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'chrome-extension://abcdef',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-methods')).toContain('OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('inclui Access-Control-Allow-Origin nas respostas normais de /api/*', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('NÃO aplica CORS fora de /api (ex.: /webhooks/*)', async () => {
    const res = await fetch(`${baseUrl}/webhooks/ping`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
