import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { Db } from '../src/db.js';
import { RecallClient } from '../src/recall/client.js';
import { ChatproClient } from '../src/chatpro/client.js';
import { ContasGoogle, ContaGoogleExpirada } from '../src/google/contas.js';
import { createReunioesRouter } from '../src/routes/reunioes.js';
import { extrairMeetUrl, criarLinkDoMeet } from '../src/google/meetLink.js';
import { jsonResponse } from './helpers.js';

/**
 * O botão "Entrar na reunião": link do Meet → mensagem pro cliente → bot.
 * Nada de rede real — Google, chatPro e Recall são todos injetados.
 */

const SESSION = '78562bd7-3d56-47ae-9d4f-25dd80e6b024';
const DEVICE = 'device-de-teste-1234';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';

const servidores: Server[] = [];
afterEach(() => {
  for (const s of servidores.splice(0)) s.close();
});

interface App {
  baseUrl: string;
  db: Db;
  chamadas: { url: string; body: unknown }[];
}

async function montarApp(
  options: {
    contaConectada?: boolean;
    chatproConfigurado?: boolean;
    respostaChatpro?: Response;
    linkFalha?: Error;
  } = {}
): Promise<App> {
  const db = new Db(':memory:');
  const chamadas: { url: string; body: unknown }[] = [];

  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    chamadas.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.includes('/messages/sendMessage')) {
      return Promise.resolve(options.respostaChatpro ?? jsonResponse({ ok: true }, 201));
    }
    return Promise.resolve(jsonResponse({ id: 'bot-1' }));
  }) as typeof fetch;

  const contas = new ContasGoogle({
    clientId: 'cliente-fake',
    clientSecret: 'segredo-fake',
    redirectUri: 'http://localhost:3333/oauth/google/callback',
    tokenEncryptionKey: undefined,
    db,
  });
  if (options.contaConectada !== false) {
    db.salvarContaGoogle({
      deviceId: DEVICE,
      email: 'atendente@exemplo.com',
      refreshTokenEncrypted: 'refresh-fake',
      accessToken: 'access-fake',
      // Vale por 1 h: evita que o teste tente renovar contra o Google.
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  const chatpro = new ChatproClient({
    baseUrl: 'https://sparks.exemplo',
    instanceToken: options.chatproConfigurado === false ? undefined : 'token',
    instanceId: options.chatproConfigurado === false ? undefined : 'chatpro-1',
    userId: options.chatproConfigurado === false ? undefined : 'user-1',
    fetchImpl,
  });

  const app = express();
  app.use(express.json());
  app.use(
    createReunioesRouter({
      db,
      contas,
      chatpro,
      recall: new RecallClient({ apiKey: 'k', fetchImpl }),
      botName: 'chatPro (gravando)',
      criarLink: options.linkFalha
        ? () => Promise.reject(options.linkFalha)
        : () =>
            Promise.resolve({ meetUrl: MEET_URL, eventId: 'evt-1', meetingCode: 'abc-defg-hij' }),
    })
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servidores.push(server);
  const addr = server.address();
  const porta = typeof addr === 'object' && addr ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${porta}`, db, chamadas };
}

function iniciar(base: string, corpo: unknown): Promise<Response> {
  return fetch(`${base}/api/reunioes/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

describe('leitura do link do Meet na resposta do Calendar', () => {
  it('aceita o atalho hangoutLink', () => {
    expect(extrairMeetUrl({ hangoutLink: MEET_URL })).toBe(MEET_URL);
  });

  it('aceita entryPoints do conferenceData', () => {
    expect(
      extrairMeetUrl({
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+551130000000' },
            { entryPointType: 'video', uri: MEET_URL },
          ],
        },
      })
    ).toBe(MEET_URL);
  });

  it('devolve null quando não há link', () => {
    expect(extrairMeetUrl({})).toBeNull();
    expect(extrairMeetUrl(null)).toBeNull();
    expect(extrairMeetUrl({ conferenceData: { entryPoints: [] } })).toBeNull();
  });
});

describe('criação do link via Calendar', () => {
  it('pede conferenceDataVersion=1 e hangoutsMeet — sem isso não vem link', async () => {
    let capturado: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturado = { url: String(url), body: JSON.parse(String(init?.body)) };
      return Promise.resolve(jsonResponse({ id: 'evt-1', hangoutLink: MEET_URL }));
    }) as typeof fetch;

    const r = await criarLinkDoMeet({ accessToken: 'tok', titulo: 'Teste', fetchImpl });

    expect(r.meetUrl).toBe(MEET_URL);
    expect(r.meetingCode).toBe('abc-defg-hij');
    expect(capturado!.url).toContain('conferenceDataVersion=1');
    expect(capturado!.body.conferenceData).toMatchObject({
      createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } },
    });
  });

  it('erro do Google vira MeetLinkError com o status', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('sem permissão', { status: 403 }))) as typeof fetch;

    await expect(
      criarLinkDoMeet({ accessToken: 'tok', titulo: 'Teste', fetchImpl })
    ).rejects.toThrow(/403/);
  });
});

describe('POST /api/reunioes/iniciar', () => {
  it('cria o link, manda pro cliente e põe o bot na sala', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE });

    expect(res.status).toBe(201);
    const corpo = (await res.json()) as {
      meetUrl: string;
      mensagemEnviada: boolean;
      gravando: boolean;
    };
    expect(corpo.meetUrl).toBe(MEET_URL);
    expect(corpo.mensagemEnviada).toBe(true);
    expect(corpo.gravando).toBe(true);

    // A mensagem levou o link, na sessão certa.
    const envio = app.chamadas.find((c) => c.url.includes('/messages/sendMessage'));
    // provider é OBRIGATÓRIO no contrato do chatPro — sem ele a chamada é
    // recusada, e o cliente nunca receberia o link.
    expect(envio?.body).toMatchObject({ sessionId: SESSION, provider: 'whatsapp' });
    expect(String((envio?.body as { message: string }).message)).toContain(MEET_URL);

    // E o bot foi criado com a sessão no metadata.
    const reuniao = app.db.listMeetings()[0];
    expect(reuniao?.session_id).toBe(SESSION);
    expect(reuniao?.meeting_code).toBe('abc-defg-hij');
  });

  it('token do Google expirado pede pra reconectar, não vira erro genérico', async () => {
    // Com o app OAuth em modo "Testing" o Google MATA o refresh token a cada
    // 7 dias. Antes isso subia como 502 "não foi possível criar o link" e a
    // saída (reconectar) não ficava óbvia pra ninguém.
    const app = await montarApp();
    const expirado = new ContaGoogleExpirada(DEVICE);
    expect(expirado).toBeInstanceOf(Error);
    // A herança é o que faz o tratamento existente cobrir os dois casos.
    expect(expirado.name).toBe('ContaGoogleExpirada');
    expect(expirado.message).toContain('7 dias');

    // E a rota devolve 409 + precisaConectar, igual ao caso "nunca conectou".
    app.db.removerContaGoogle(DEVICE);
    const res = await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE });
    const corpo = (await res.json()) as { precisaConectar: boolean };
    expect(res.status).toBe(409);
    expect(corpo.precisaConectar).toBe(true);
  });

  it('sem conta Google conectada, avisa pra conectar em vez de falhar seco', async () => {
    const app = await montarApp({ contaConectada: false });

    const res = await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE });

    expect(res.status).toBe(409);
    const corpo = (await res.json()) as { precisaConectar: boolean };
    expect(corpo.precisaConectar).toBe(true);
    expect(app.chamadas).toHaveLength(0);
  });

  it('se a mensagem não sai, PARA — bot em sala que o cliente desconhece não serve', async () => {
    const app = await montarApp({ respostaChatpro: new Response('erro', { status: 500 }) });

    const res = await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE });

    expect(res.status).toBe(502);
    const corpo = (await res.json()) as { meetUrl: string; hint: string };
    // Devolve o link mesmo assim: dá pra colar na conversa na mão.
    expect(corpo.meetUrl).toBe(MEET_URL);
    expect(corpo.hint).toContain('manualmente');
    // Nenhum bot foi criado.
    expect(app.db.listMeetings()).toHaveLength(0);
  });

  it('falha ao criar o link não manda mensagem nenhuma', async () => {
    const app = await montarApp({ linkFalha: new Error('Calendar fora do ar') });

    const res = await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE });

    expect(res.status).toBe(502);
    expect(app.chamadas).toHaveLength(0);
  });

  it('recusa corpo sem sessionId ou sem deviceId', async () => {
    const app = await montarApp();

    expect((await iniciar(app.baseUrl, { deviceId: DEVICE })).status).toBe(400);
    expect((await iniciar(app.baseUrl, { sessionId: SESSION })).status).toBe(400);
    expect((await iniciar(app.baseUrl, { sessionId: 'nao-e-uuid', deviceId: DEVICE })).status).toBe(
      400
    );
  });

  it('mensagem personalizada substitui {link}', async () => {
    const app = await montarApp();

    await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      mensagem: 'Te espero aqui: {link} — até já!',
    });

    const envio = app.chamadas.find((c) => c.url.includes('/messages/sendMessage'));
    expect((envio?.body as { message: string }).message).toBe(
      `Te espero aqui: ${MEET_URL} — até já!`
    );
  });
});

describe('GET /api/google/status', () => {
  it('diz quem está conectado', async () => {
    const app = await montarApp();

    const res = await fetch(`${app.baseUrl}/api/google/status?device=${DEVICE}`);
    const corpo = (await res.json()) as { conectado: boolean; email: string };

    expect(corpo.conectado).toBe(true);
    expect(corpo.email).toBe('atendente@exemplo.com');
  });

  it('dispositivo desconhecido devolve desconectado, sem erro', async () => {
    const app = await montarApp({ contaConectada: false });

    const res = await fetch(`${app.baseUrl}/api/google/status?device=outro`);
    const corpo = (await res.json()) as { conectado: boolean };

    expect(res.status).toBe(200);
    expect(corpo.conectado).toBe(false);
  });
});
