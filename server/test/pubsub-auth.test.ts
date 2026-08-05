import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Db } from '../src/db.js';
import { VoreoClient } from '../src/voreo/client.js';
import { TranscriptPipeline } from '../src/pipeline/transcript.js';
import { EventQueueWorker } from '../src/pipeline/eventQueue.js';
import { createPubSubRouter, EVENT_TRANSCRIPT_FILE_GENERATED } from '../src/routes/pubsub.js';
import type { TokenVerifier } from '../src/routes/pubsub.js';
import { makeMeetStub } from './helpers.js';

const SERVICE_ACCOUNT = 'pubsub-pusher@projeto.iam.gserviceaccount.com';
const AUDIENCE = 'https://backend.example/webhooks/pubsub';

function pushBody(): unknown {
  return {
    message: {
      data: Buffer.from(
        JSON.stringify({ transcript: { name: 'conferenceRecords/rec1/transcripts/t1' } }),
        'utf8'
      ).toString('base64'),
      attributes: { 'ce-type': EVENT_TRANSCRIPT_FILE_GENERATED },
      messageId: 'msg-1',
    },
    subscription: 'projects/p/subscriptions/s',
  };
}

interface TestApp {
  baseUrl: string;
  db: Db;
}

const servers: Server[] = [];

async function makeApp(options: {
  audience: string | undefined;
  serviceAccount: string | undefined;
  allowInsecure: boolean;
  verifier?: TokenVerifier;
}): Promise<TestApp> {
  const db = new Db(':memory:');
  const voreo = new VoreoClient({ db, webhookUrl: undefined, apiKey: undefined });
  const pipeline = new TranscriptPipeline({ db, meet: makeMeetStub(), voreo });
  const eventQueue = new EventQueueWorker({ db, pipeline });

  const app = express();
  app.use(express.json());
  app.use(
    createPubSubRouter({
      eventQueue,
      audience: options.audience,
      serviceAccount: options.serviceAccount,
      allowInsecure: options.allowInsecure,
      verifier: options.verifier,
    })
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, db };
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        })
    )
  );
});

function post(baseUrl: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/webhooks/pubsub`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('autenticação do webhook Pub/Sub', () => {
  it('sem audience e sem ALLOW_INSECURE_PUBSUB rejeita com 403 e nada é enfileirado', async () => {
    const { baseUrl, db } = await makeApp({
      audience: undefined,
      serviceAccount: undefined,
      allowInsecure: false,
    });
    const res = await post(baseUrl, pushBody());
    expect(res.status).toBe(403);
    expect(db.countEventQueue()).toEqual({ pending: 0, noLink: 0, dead: 0, done: 0 });
  });

  it('sem audience mas com ALLOW_INSECURE_PUBSUB=true aceita (modo dev) e enfileira', async () => {
    const { baseUrl, db } = await makeApp({
      audience: undefined,
      serviceAccount: undefined,
      allowInsecure: true,
    });
    const res = await post(baseUrl, pushBody());
    expect(res.status).toBe(204);
    expect(db.countEventQueue().pending).toBe(1);
  });

  it('com audience configurada exige o header Authorization (401 sem Bearer)', async () => {
    const { baseUrl, db } = await makeApp({
      audience: AUDIENCE,
      serviceAccount: undefined,
      allowInsecure: false,
    });
    const res = await post(baseUrl, pushBody());
    expect(res.status).toBe(401);
    expect(db.countEventQueue().pending).toBe(0);
  });

  it('aceita OIDC válido do service account esperado (email + email_verified)', async () => {
    const verifier: TokenVerifier = {
      verify: () => Promise.resolve({ email: SERVICE_ACCOUNT, emailVerified: true }),
    };
    const { baseUrl, db } = await makeApp({
      audience: AUDIENCE,
      serviceAccount: SERVICE_ACCOUNT,
      allowInsecure: false,
      verifier,
    });
    const res = await post(baseUrl, pushBody(), 'token-valido');
    expect(res.status).toBe(204);
    expect(db.countEventQueue().pending).toBe(1);
  });

  it('rejeita OIDC de outro principal quando PUBSUB_SERVICE_ACCOUNT está setada', async () => {
    const verifier: TokenVerifier = {
      verify: () => Promise.resolve({ email: 'intruso@gmail.com', emailVerified: true }),
    };
    const { baseUrl, db } = await makeApp({
      audience: AUDIENCE,
      serviceAccount: SERVICE_ACCOUNT,
      allowInsecure: false,
      verifier,
    });
    const res = await post(baseUrl, pushBody(), 'token-de-intruso');
    expect(res.status).toBe(403);
    expect(db.countEventQueue().pending).toBe(0);
  });

  it('rejeita OIDC com email não verificado', async () => {
    const verifier: TokenVerifier = {
      verify: () => Promise.resolve({ email: SERVICE_ACCOUNT, emailVerified: false }),
    };
    const { baseUrl, db } = await makeApp({
      audience: AUDIENCE,
      serviceAccount: SERVICE_ACCOUNT,
      allowInsecure: false,
      verifier,
    });
    const res = await post(baseUrl, pushBody(), 'token-sem-verified');
    expect(res.status).toBe(403);
    expect(db.countEventQueue().pending).toBe(0);
  });

  it('rejeita quando a verificação do token lança (assinatura/audience inválida)', async () => {
    const verifier: TokenVerifier = {
      verify: () => Promise.reject(new Error('audience mismatch')),
    };
    const { baseUrl, db } = await makeApp({
      audience: AUDIENCE,
      serviceAccount: SERVICE_ACCOUNT,
      allowInsecure: false,
      verifier,
    });
    const res = await post(baseUrl, pushBody(), 'token-invalido');
    expect(res.status).toBe(403);
    expect(db.countEventQueue().pending).toBe(0);
  });

  it('ack-a push malformado (204) sem enfileirar, pra evitar loop de redelivery', async () => {
    const { baseUrl, db } = await makeApp({
      audience: undefined,
      serviceAccount: undefined,
      allowInsecure: true,
    });
    const res = await post(baseUrl, { foo: 'bar' });
    expect(res.status).toBe(204);
    expect(db.countEventQueue()).toEqual({ pending: 0, noLink: 0, dead: 0, done: 0 });
  });
});
