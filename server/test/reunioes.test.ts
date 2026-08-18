import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { Db } from '../src/db.js';
import { RecallClient } from '../src/recall/client.js';
import { ChatproClient } from '../src/chatpro/client.js';
import { PainelClient } from '../src/painel/client.js';
import { ContasGoogle, ContaGoogleExpirada } from '../src/google/contas.js';
import {
  createReunioesRouter,
  formatarQuando,
  ANTECEDENCIA_CONVITE_MS,
} from '../src/routes/reunioes.js';
import {
  extrairMeetUrl,
  criarLinkDoMeet,
  type CriarMeetOptions,
} from '../src/google/meetLink.js';
import { criarReuniao } from '../src/recall/criarReuniao.js';
import { jsonResponse } from './helpers.js';

/**
 * O botão "Entrar na reunião": link do Meet → mensagem pro cliente → bot.
 * Nada de rede real — Google, chatPro e Recall são todos injetados.
 */

const SESSION = '78562bd7-3d56-47ae-9d4f-25dd80e6b024';
const OUTRA_SESSION = 'f1a2b3c4-d5e6-47ae-9d4f-25dd80e6b024';
const DEVICE = 'device-de-teste-1234';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const MINUTO = 60_000;

/** ISO de daqui a N minutos — as reuniões marcadas são sempre no futuro. */
function daquiA(minutos: number): string {
  return new Date(Date.now() + minutos * MINUTO).toISOString();
}

const servidores: Server[] = [];
afterEach(() => {
  for (const s of servidores.splice(0)) s.close();
});

interface App {
  baseUrl: string;
  db: Db;
  chamadas: { url: string; body: unknown }[];
  /** O que a rota pediu ao Google — é aqui que o horário marcado aparece. */
  linkOpcoes: CriarMeetOptions[];
}

async function montarApp(
  options: {
    contaConectada?: boolean;
    chatproConfigurado?: boolean;
    respostaChatpro?: Response;
    linkFalha?: Error;
    /** Painel interno comercial fora do ar: TODAS as chamadas dele falham. */
    painelIndisponivel?: boolean;
    /** Liga o painel: aí é ELE quem cria a reunião e gera o link do Meet. */
    comPainel?: boolean;
    /** O POST do painel nunca responde — simula o timeout de 15 s. */
    painelTravaNoPost?: boolean;
    /** O painel responde 500 no POST — é o que acontece em produção hoje. */
    painelQuebradoNoPost?: boolean;
    /** O painel RECUSA por regra de negócio (403, 422): não é pra contornar. */
    painelRecusa?: number;
  } = {}
): Promise<App> {
  const db = new Db(':memory:');
  const chamadas: { url: string; body: unknown }[] = [];
  const linkOpcoes: CriarMeetOptions[] = [];

  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    chamadas.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.includes('painel.exemplo')) {
      if (options.painelIndisponivel) {
        return Promise.resolve(new Response('fora do ar', { status: 503 }));
      }
      if (u.includes('/api/ext/agenda/meetings')) {
        if (options.painelQuebradoNoPost) {
          return Promise.resolve(jsonResponse({ error: 'Erro ao criar reunião.' }, 500));
        }
        if (options.painelRecusa) {
          return Promise.resolve(
            jsonResponse({ error: 'Só supervisor pode escolher o responsável' }, options.painelRecusa)
          );
        }
        if (options.painelTravaNoPost) {
          // Nunca responde — e respeita o abort, como o fetch de verdade faz.
          // Um stub que ignora o signal deixaria o teste pendurado em vez de
          // exercitar o caminho do timeout.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        }
        return Promise.resolve(
          jsonResponse(
            {
              id: 'reuniao-no-painel-1',
              meet_link: MEET_URL,
              assignment_mode: 'round_robin',
              responsavel: { email: 'distribuido@time.com', name: 'Distribuído' },
            },
            201
          )
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }, 201));
    }
    if (u.includes('/messages/sendMessage')) {
      return Promise.resolve(options.respostaChatpro ?? jsonResponse({ ok: true }, 201));
    }
    return Promise.resolve(jsonResponse({ id: 'bot-1' }));
  }) as typeof fetch;

  // Por padrão o painel fica DESLIGADO: a maioria destes testes cobre o plano
  // B (link pelo Google Calendar), que é o caminho quando não há painel.
  const painel = new PainelClient({
    baseUrl: options.comPainel || options.painelIndisponivel ? 'https://painel.exemplo' : undefined,
    extAgendaToken: options.comPainel || options.painelIndisponivel ? 'token-agenda' : undefined,
    fetchImpl,
    timeoutMs: 200,
  });

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
      painel,
      recall: new RecallClient({ apiKey: 'k', fetchImpl }),
      botName: 'chatPro (gravando)',
      criarLink: (opcoes: CriarMeetOptions) => {
        linkOpcoes.push(opcoes);
        return options.linkFalha
          ? Promise.reject(options.linkFalha)
          : Promise.resolve({ meetUrl: MEET_URL, eventId: 'evt-1', meetingCode: 'abc-defg-hij' });
      },
    })
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servidores.push(server);
  const addr = server.address();
  const porta = typeof addr === 'object' && addr ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${porta}`, db, chamadas, linkOpcoes };
}

/** Recall de mentira: guarda o corpo de cada createBot pra inspeção. */
function montarRecall(): { recall: RecallClient; bots: Record<string, unknown>[] } {
  const bots: Record<string, unknown>[] = [];
  let n = 0;
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/bot')) {
      bots.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      n += 1;
      return Promise.resolve(jsonResponse({ id: `bot-${n}` }));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  }) as typeof fetch;
  return { recall: new RecallClient({ apiKey: 'k', fetchImpl }), bots };
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

  it('sem `inicio`, o evento continua nascendo agora', async () => {
    const agora = new Date('2026-08-21T17:00:00.000Z');
    let corpo: Record<string, { dateTime: string }> = {};
    const fetchImpl = ((_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      corpo = JSON.parse(String(init?.body)) as Record<string, { dateTime: string }>;
      return Promise.resolve(jsonResponse({ id: 'evt-1', hangoutLink: MEET_URL }));
    }) as typeof fetch;

    await criarLinkDoMeet({ accessToken: 'tok', titulo: 'Teste', fetchImpl, agora: () => agora });

    expect(corpo.start?.dateTime).toBe(agora.toISOString());
    // Uma hora de duração nominal, como sempre.
    expect(corpo.end?.dateTime).toBe('2026-08-21T18:00:00.000Z');
  });

  it('com `inicio` e `duracaoMinutos`, o evento cai no horário marcado', async () => {
    const agora = new Date('2026-08-21T17:00:00.000Z');
    const inicio = new Date('2026-08-24T14:30:00.000Z');
    let corpo: Record<string, unknown> = {};
    const fetchImpl = ((_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      corpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(jsonResponse({ id: 'evt-1', hangoutLink: MEET_URL }));
    }) as typeof fetch;

    await criarLinkDoMeet({
      accessToken: 'tok',
      titulo: 'Teste',
      inicio,
      duracaoMinutos: 30,
      fetchImpl,
      agora: () => agora,
    });

    expect((corpo.start as { dateTime: string }).dateTime).toBe(inicio.toISOString());
    expect((corpo.end as { dateTime: string }).dateTime).toBe('2026-08-24T15:00:00.000Z');
    // Compromisso futuro sem lembrete é reunião perdida.
    expect(corpo.reminders).toMatchObject({
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 10 }],
    });
  });

  it('duração fora de faixa cai no padrão em vez de gerar evento absurdo', async () => {
    const agora = new Date('2026-08-21T17:00:00.000Z');
    const corpos: Record<string, { dateTime: string }>[] = [];
    const fetchImpl = ((_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      corpos.push(JSON.parse(String(init?.body)) as Record<string, { dateTime: string }>);
      return Promise.resolve(jsonResponse({ id: 'evt-1', hangoutLink: MEET_URL }));
    }) as typeof fetch;
    const base = { accessToken: 'tok', titulo: 'Teste', fetchImpl, agora: () => agora };

    await criarLinkDoMeet({ ...base, duracaoMinutos: 0 });
    await criarLinkDoMeet({ ...base, duracaoMinutos: Number.NaN });
    await criarLinkDoMeet({ ...base, duracaoMinutos: 60 * 24 * 30 });

    expect(corpos[0]?.end?.dateTime).toBe('2026-08-21T18:00:00.000Z');
    expect(corpos[1]?.end?.dateTime).toBe('2026-08-21T18:00:00.000Z');
    // Teto de 12 h: evento de um mês na agenda de quem clicou seria ruído.
    expect(corpos[2]?.end?.dateTime).toBe('2026-08-22T05:00:00.000Z');
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

  it('manda automatic_leave pro bot não ficar preso na sala', async () => {
    const app = await montarApp();
    await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE });

    const bot = app.chamadas.find((c) => c.url.includes('/bot'));
    const corpo = bot?.body as { automatic_leave?: Record<string, number> };
    // Sem isto, um bot esquecido cobra por hora e pode atravessar pra próxima
    // reunião da mesma sala — gravando o cliente errado.
    expect(corpo.automatic_leave?.everyone_left_timeout).toBe(2);
    expect(corpo.automatic_leave?.waiting_room_timeout).toBe(300);
    expect(corpo.automatic_leave?.in_call_recording_timeout).toBe(14400);
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

/** A fila de convites agendados que ainda está 'pendente'. */
function filaDeConvites(db: Db) {
  return db.enviosVencidos(daquiA(365 * 24 * 60), 100);
}

describe('POST /api/reunioes/iniciar com `quando` (reunião marcada)', () => {
  it('marca o evento na hora, agenda o convite pra 5 min antes e agenda o bot', async () => {
    const app = await montarApp();
    const quando = daquiA(3 * 24 * 60);

    const res = await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE, quando });

    expect(res.status).toBe(201);
    const corpo = (await res.json()) as {
      agendadaPara: string;
      quandoTexto: string;
      mensagemEnviada: boolean;
      conviteAgendadoPara: string;
    };
    expect(corpo.agendadaPara).toBe(quando);

    // 1. O evento do Google nasce no horário marcado, não em cima do clique.
    expect(app.linkOpcoes[0]?.inicio?.toISOString()).toBe(quando);

    // 2. NADA sai pro cliente agora: link mandado três dias antes se perde na
    //    conversa. O convite entra na fila durável pra sair 5 min antes.
    expect(corpo.mensagemEnviada).toBe(false);
    expect(app.chamadas.some((c) => c.url.includes('/messages/sendMessage'))).toBe(false);
    expect(corpo.conviteAgendadoPara).toBe(
      new Date(Date.parse(quando) - ANTECEDENCIA_CONVITE_MS).toISOString()
    );
    const fila = filaDeConvites(app.db);
    expect(fila).toHaveLength(1);
    expect(fila[0]?.enviar_em).toBe(corpo.conviteAgendadoPara);
    expect(fila[0]?.session_id).toBe(SESSION);
    // O link já vai resolvido, mas o {quando} fica CRU de propósito: quem
    // resolve é o worker, no instante do envio. Congelar aqui mandaria
    // "amanhã às 10h" pro cliente no próprio dia da reunião.
    expect(fila[0]?.message).toContain('Reunião marcada para');
    expect(fila[0]?.message).toContain('{quando}');
    expect(fila[0]?.message).toContain(MEET_URL);
    // O horário da REUNIÃO viaja junto — é a partir dele que o worker escreve
    // "hoje às 10h" na hora certa.
    expect(fila[0]?.reuniao_em).toBe(new Date(quando).toISOString());
    // E aponta pra reunião criada — é o que cancela o convite se ela for
    // desmarcada (a sala reaproveitada faz isso explicitamente).
    expect(fila[0]?.meeting_id).toBe(app.db.listMeetings()[0]?.id);

    // 3. O bot fica agendado no Recall, em ISO 8601.
    const bot = app.chamadas.find((c) => c.url.endsWith('/bot'));
    expect((bot?.body as { join_at?: string }).join_at).toBe(quando);
  });

  it('faltando menos de 10 min, vai sem join_at — e o convite sai já', async () => {
    // O Recall pede antecedência pro bot agendado. Adiar a entrada em 4 min só
    // criaria uma janela com a reunião rolando e o bot fora dela.
    const app = await montarApp();
    const antes = Date.now();

    await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE, quando: daquiA(4) });

    const bot = app.chamadas.find((c) => c.url.endsWith('/bot'));
    expect((bot?.body as { join_at?: string }).join_at).toBeUndefined();

    // "5 min antes" já passou (a reunião é daqui a 4): o convite vence AGORA —
    // o worker manda na primeira passada, não depois da reunião começar.
    const fila = filaDeConvites(app.db);
    const enviarEm = Date.parse(fila[0]?.enviar_em ?? '');
    expect(enviarEm).toBeGreaterThanOrEqual(antes);
    expect(enviarEm).toBeLessThanOrEqual(Date.now());
  });

  it('recusa horário no passado com motivo legível', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      quando: daquiA(-5),
    });

    expect(res.status).toBe(400);
    const corpo = (await res.json()) as { issues: { message: string }[] };
    expect(corpo.issues[0]?.message).toContain('já passou');
    // Nada de link criado nem mensagem enviada pro cliente.
    expect(app.chamadas).toHaveLength(0);
    expect(app.linkOpcoes).toHaveLength(0);
  });

  it('recusa além de 90 dias', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      quando: daquiA(91 * 24 * 60),
    });

    expect(res.status).toBe(400);
    const corpo = (await res.json()) as { issues: { message: string }[] };
    expect(corpo.issues[0]?.message).toContain('90 dias');
  });

  it('recusa data sem fuso — "14:00" de quem? viraria 11 h pro cliente', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      quando: '2026-08-21T14:00',
    });

    expect(res.status).toBe(400);
  });

  it('mensagem personalizada também recebe {quando} — já pronta na fila', async () => {
    const app = await montarApp();
    const quando = daquiA(2 * 24 * 60);

    await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      quando,
      mensagem: 'Fechado para {quando}. Link: {link}',
    });

    // Só o {link} é resolvido aqui. O {quando} sobrevive cru até o envio —
    // é o worker que sabe se, naquele momento, a reunião é "hoje" ou "amanhã".
    expect(filaDeConvites(app.db)[0]?.message).toBe(
      `Fechado para {quando}. Link: ${MEET_URL}`
    );
  });
});

describe('fluxo do time comercial (tipo, atendente, cliente, responsável)', () => {
  const CNPJ_VALIDO = '11.222.333/0001-81';
  const cliente = {
    nome: 'Padaria Real',
    cnpj: CNPJ_VALIDO,
    instancia: 'chatpro-abc123',
    telefone: '+5511999998888',
  };

  it('implantação sem os dados do cliente é 400 com mensagem clara', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'implantacao',
    });

    expect(res.status).toBe(400);
    const corpo = (await res.json()) as { issues: { path: string; message: string }[] };
    const issue = corpo.issues.find((i) => i.path === 'cliente');
    expect(issue?.message).toContain('implantacao');
    expect(issue?.message).toContain('dados do cliente');
    // Nada aconteceu: nem link, nem mensagem, nem bot.
    expect(app.chamadas).toHaveLength(0);
    expect(app.linkOpcoes).toHaveLength(0);
  });

  it('CNPJ com dígito verificador errado é recusado', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'cs',
      cliente: { ...cliente, cnpj: '11.222.333/0001-80' },
    });

    expect(res.status).toBe(400);
    const corpo = (await res.json()) as { issues: { message: string }[] };
    expect(corpo.issues.some((i) => i.message.includes('CNPJ'))).toBe(true);
  });

  it('apresentação não exige cliente', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'apresentacao',
    });

    expect(res.status).toBe(201);
  });

  it('reunião AGORA fica com quem marcou, sem consultar a distribuição', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'cs',
      atendenteEmail: 'quem@marcou.com',
      cliente,
    });

    expect(res.status).toBe(201);
    // "Agora" não verifica nada: o cliente está na linha COM o atendente.
    expect(app.chamadas.some((c) => c.url.includes('/distribuicao'))).toBe(false);
    // A mensagem sai na hora, como sempre foi.
    expect(app.chamadas.some((c) => c.url.includes('/messages/sendMessage'))).toBe(true);

    const reuniao = app.db.listMeetings()[0];
    expect(reuniao?.atendente_email).toBe('quem@marcou.com');
    expect(reuniao?.tipo).toBe('cs');
    expect(JSON.parse(reuniao?.cliente_json ?? '{}')).toMatchObject({
      nome: 'Padaria Real',
      instancia: 'chatpro-abc123',
    });
  });

  it('com painel ligado, é ELE quem cria a reunião, distribui e dá o link', async () => {
    const app = await montarApp({ comPainel: true });

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      quando: daquiA(2 * 24 * 60),
      tipo: 'migracao',
      atendenteEmail: 'quem@marcou.com',
      cliente,
    });

    expect(res.status).toBe(201);
    const corpo = (await res.json()) as { responsavel: string };
    expect(corpo.responsavel).toBe('distribuido@time.com');

    // Uma chamada só: o painel resolve disponibilidade, distribuição e link.
    const criacao = app.chamadas.find((c) => c.url.includes('/api/ext/agenda/meetings'));
    expect(criacao?.body).toMatchObject({
      type: 'migracao',
      actor_email: 'quem@marcou.com',
      // Data e hora separadas e locais — nunca um instante UTC.
      scheduled_date: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
      scheduled_time: expect.stringMatching(/^[0-9]{2}:[0-9]{2}$/),
    });

    const reuniao = app.db.listMeetings()[0];
    // A coluna de atribuição leva o RESPONSÁVEL, não quem clicou.
    expect(reuniao?.atendente_email).toBe('distribuido@time.com');
    // E o elo com o painel, sem o qual a transcrição não teria pra onde voltar.
    expect(reuniao?.painel_meeting_id).toBe('reuniao-no-painel-1');

    // chatpro_session_id: é ELE que faz o resumo da reunião voltar pro
    // atendimento certo quando a transcrição fica pronta. Sem ele o painel só
    // conhece essa ligação se alguém disparar um template pela tela.
    expect((criacao?.body as Record<string, unknown>).chatpro_session_id).toBe(SESSION);
  });

  it('mensagem falhando com a reunião JÁ criada no painel NÃO oferece repetir', async () => {
    // O pior caminho deste arquivo: o painel criou a reunião de verdade (link
    // gerado, agenda do responsável ocupada, Slack avisado) e o envio ao cliente
    // falhou. Devolver um erro seco faria o atendente clicar de novo — e o
    // segundo clique cria uma SEGUNDA reunião real, porque a API do painel não
    // tem chave de idempotência.
    const app = await montarApp({
      comPainel: true,
      respostaChatpro: new Response('token vencido', { status: 401 }),
    });

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'apresentacao',
      atendenteEmail: 'quem@marcou.com',
      cliente,
    });

    // 201, não 502: a reunião EXISTE. Chamar isso de erro é o que leva a repetir.
    expect(res.status).toBe(201);
    const corpo = (await res.json()) as {
      naoRepetir?: boolean;
      painelMeetingId?: string;
      avisoMensagem?: string;
      mensagemEnviada?: boolean;
      meetUrl?: string;
    };
    expect(corpo.naoRepetir).toBe(true);
    expect(corpo.painelMeetingId).toBe('reuniao-no-painel-1');
    expect(corpo.mensagemEnviada).toBe(false);
    expect(corpo.avisoMensagem).toContain('duplicada');
    // O link volta pro atendente colar na mão.
    expect(corpo.meetUrl).toBe(MEET_URL);

    // E o bot foi armado mesmo assim: se o atendente colar o link, o cliente
    // entra e a gravação acontece igual. Nada se perde.
    expect(app.chamadas.some((c) => c.url.endsWith('/bot'))).toBe(true);
    expect(app.db.listMeetings()).toHaveLength(1);
  });

  it('sem painel, mensagem falhando ainda PARA — nada foi criado fora daqui', async () => {
    // No plano B o link é nosso e nada existe fora do servidor: parar é seguro
    // e evita bot numa sala que o cliente nunca vai conhecer.
    const app = await montarApp({
      respostaChatpro: new Response('erro', { status: 500 }),
    });

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'apresentacao',
      atendenteEmail: 'quem@marcou.com',
      cliente,
    });

    expect(res.status).toBe(502);
    expect(app.chamadas.some((c) => c.url.endsWith('/bot'))).toBe(false);
  });

  it('timeout do painel vira "não sei", nunca "não marcou"', async () => {
    // Abortar do nosso lado NÃO cancela o processamento do lado de lá: o painel
    // pode ter criado tudo e só a resposta se perdeu. Dizer "não marcou" seria
    // uma afirmação que o cliente HTTP não tem como provar — e levaria a repetir.
    const app = await montarApp({ comPainel: true, painelTravaNoPost: true });

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'apresentacao',
      atendenteEmail: 'quem@marcou.com',
      cliente,
    });

    expect(res.status).toBe(504);
    const corpo = (await res.json()) as {
      incerto?: boolean;
      naoRepetir?: boolean;
      error?: string;
      detail?: string;
    };
    expect(corpo.incerto).toBe(true);
    expect(corpo.naoRepetir).toBe(true);
    expect(corpo.error).toContain('Não sei dizer');
    expect(corpo.detail).toContain('Confira no painel');

    // Nada foi gravado como se tivesse dado certo.
    expect(app.db.listMeetings()).toHaveLength(0);
  });

  it('painel com defeito (5xx) NÃO trava o atendimento — cai no plano B avisando', async () => {
    // O painel está devolvendo 500 em toda criação de reunião (bug conhecido,
    // documentado em docs/BUG-PAINEL-500.md). O atendente está com o cliente na
    // linha e o problema não é dele nem do pedido: a reunião acontece pelo
    // Google Calendar, o cliente recebe o link e o bot grava igual.
    //
    // O que NÃO pode é fingir que deu certo — a reunião não está no painel, e
    // alguém precisa lançá-la lá depois.
    const app = await montarApp({ comPainel: true, painelQuebradoNoPost: true });

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'cs',
      atendenteEmail: 'quem@marcou.com',
      cliente: { ...cliente, provedor: 'starter' },
    });

    expect(res.status).toBe(201);
    const corpo = (await res.json()) as {
      pendenteNoPainel?: boolean;
      avisoPainel?: string;
      meetUrl?: string;
      painelMeetingId?: string;
    };

    // A reunião ACONTECEU: link criado e mandado pro cliente.
    expect(corpo.meetUrl).toBe(MEET_URL);
    expect(app.chamadas.some((c) => c.url.includes('/messages/sendMessage'))).toBe(true);
    // E o bot foi armado.
    expect(app.chamadas.some((c) => c.url.endsWith('/bot'))).toBe(true);

    // Mas o aviso é explícito e não há id de painel — ela NÃO está registrada lá.
    expect(corpo.pendenteNoPainel).toBe(true);
    expect(corpo.avisoPainel).toContain('NÃO está registrada');
    expect(corpo.painelMeetingId).toBeUndefined();
    expect(app.db.listMeetings()[0]?.painel_meeting_id).toBeNull();
  });

  it('recusa de NEGÓCIO do painel (4xx) continua parando — a regra é deles', async () => {
    // Diferente do 5xx: aqui o painel entendeu o pedido e disse não (papel sem
    // direito, checklist faltando). Cair no plano B seria contornar a regra.
    const app = await montarApp({ comPainel: true, painelRecusa: 403 });

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'cs',
      atendenteEmail: 'quem@marcou.com',
      cliente: { ...cliente, provedor: 'starter' },
    });

    expect(res.status).toBe(502);
    expect(app.chamadas.some((c) => c.url.endsWith('/bot'))).toBe(false);
    expect(app.db.listMeetings()).toHaveLength(0);
  });

  it('painel interno fora do ar NÃO trava: o responsável cai em quem marcou', async () => {
    const app = await montarApp({ painelIndisponivel: true });

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      quando: daquiA(2 * 24 * 60),
      tipo: 'implantacao',
      atendenteEmail: 'quem@marcou.com',
      cliente,
    });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { responsavel: string }).responsavel).toBe('quem@marcou.com');
    expect(app.db.listMeetings()[0]?.atendente_email).toBe('quem@marcou.com');
  });

  it('AGENDADA de apresentação usa o vendedor escolhido, sem distribuição', async () => {
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      quando: daquiA(2 * 24 * 60),
      tipo: 'apresentacao',
      atendenteEmail: 'quem@marcou.com',
      vendedorEmail: 'vendedor@time.com',
    });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { responsavel: string }).responsavel).toBe('vendedor@time.com');
    expect(app.chamadas.some((c) => c.url.includes('/distribuicao'))).toBe(false);
    expect(app.db.listMeetings()[0]?.atendente_email).toBe('vendedor@time.com');
  });

  it('sem atendente identificado o fluxo segue — a reunião só fica sem atribuição', async () => {
    // O @chatpro:auth pode não ter e-mail nenhum; bloquear o botão por isso
    // pararia o atendimento por causa de um dado de relatório.
    const app = await montarApp();

    const res = await iniciar(app.baseUrl, { sessionId: SESSION, deviceId: DEVICE });

    expect(res.status).toBe(201);
    expect(app.db.listMeetings()[0]?.atendente_email).toBeNull();
  });

  it('sem painel configurado, o plano B assume e não há id de painel', async () => {
    // Ambiente de teste (ou painel não configurado): o link sai do Google
    // Calendar e a reunião existe só aqui. É o que mantém o botão útil.
    const app = await montarApp();

    await iniciar(app.baseUrl, {
      sessionId: SESSION,
      deviceId: DEVICE,
      tipo: 'cs',
      atendenteEmail: 'quem@marcou.com',
      cliente,
    });

    const reuniao = app.db.listMeetings()[0];
    expect(reuniao?.painel_meeting_id).toBeNull();
    expect(reuniao?.atendente_email).toBe('quem@marcou.com');
    expect(app.chamadas.some((c) => c.url.includes('painel.exemplo'))).toBe(false);
  });
});

describe('como a data aparece pro cliente', () => {
  const agora = new Date('2026-08-21T17:00:00.000Z'); // sexta, 14 h em São Paulo

  it('hoje e amanhã aparecem por nome', () => {
    expect(formatarQuando(new Date('2026-08-21T20:30:00.000Z'), agora)).toBe('hoje às 17h30');
    expect(formatarQuando(new Date('2026-08-22T12:00:00.000Z'), agora)).toBe('amanhã às 9h');
  });

  it('data distante leva dia da semana e dia/mês — "quinta" sozinho é qualquer quinta', () => {
    expect(formatarQuando(new Date('2026-08-27T17:00:00.000Z'), agora)).toBe(
      'quinta, 27/08, às 14h'
    );
    expect(formatarQuando(new Date('2026-09-05T13:15:00.000Z'), agora)).toBe(
      'sábado, 05/09, às 10h15'
    );
  });

  it('usa o fuso de São Paulo, não UTC', () => {
    // 02:30Z de sábado ainda é sexta, 23h30, pra quem está no Brasil.
    expect(formatarQuando(new Date('2026-08-22T02:30:00.000Z'), agora)).toBe('hoje às 23h30');
  });
});

describe('dedup com reunião marcada', () => {
  const deps = (db: Db, recall: RecallClient) => ({ db, recall, botName: 'chatPro (gravando)' });
  const pedido = (joinAt: Date | null, sessionId: string = SESSION) => ({
    meetingUrl: MEET_URL,
    sessionId,
    origem: 'api' as const,
    joinAt,
  });

  it('mesma sala, horários diferentes: são duas reuniões, cada uma com seu bot', async () => {
    const db = new Db(':memory:');
    const { recall, bots } = montarRecall();
    const cedo = new Date(Date.now() + 2 * 60 * MINUTO);
    const tarde = new Date(Date.now() + 4 * 60 * MINUTO);

    const primeira = await criarReuniao(deps(db, recall), pedido(cedo));
    const segunda = await criarReuniao(deps(db, recall), pedido(tarde));

    expect(primeira.ok && primeira.criada).toBe(true);
    expect(segunda.ok && segunda.criada).toBe(true);
    expect(bots).toHaveLength(2);
    expect(bots[0]?.join_at).toBe(cedo.toISOString());
    expect(bots[1]?.join_at).toBe(tarde.toISOString());

    // E a primeira segue de pé: ela tem hora marcada e ainda vai acontecer.
    const antiga = db.getMeeting((primeira as { meeting: { id: string } }).meeting.id);
    expect(antiga?.status).toBe('created');
  });

  it('duplo clique no MESMO horário continua criando um bot só', async () => {
    const db = new Db(':memory:');
    const { recall, bots } = montarRecall();
    const quando = new Date(Date.now() + 2 * 60 * MINUTO);

    await criarReuniao(deps(db, recall), pedido(quando));
    const repetido = await criarReuniao(deps(db, recall), pedido(new Date(quando.getTime() + 1000)));

    expect(repetido.ok && repetido.criada).toBe(false);
    expect(bots).toHaveLength(1);
  });

  it('o eco do link no webhook do chatPro não põe bot na sala antes da hora', async () => {
    // A rota manda o link pro cliente; o chatPro devolve esse envio como
    // `sent_message` e o webhook chega aqui como um pedido pra AGORA. Criar bot
    // nesse eco seria um robô numa sala vazia, cobrado por hora.
    const db = new Db(':memory:');
    const { recall, bots } = montarRecall();

    await criarReuniao(deps(db, recall), pedido(new Date(Date.now() + 3 * 60 * MINUTO)));
    const eco = await criarReuniao(deps(db, recall), {
      ...pedido(null),
      origem: 'chatpro-webhook' as const,
    });

    expect(eco.ok && eco.criada).toBe(false);
    expect(bots).toHaveLength(1);
  });

  it('outra conversa marcando outro horário não derruba o bot da primeira', async () => {
    const db = new Db(':memory:');
    const { recall, bots } = montarRecall();

    const primeira = await criarReuniao(
      deps(db, recall),
      pedido(new Date(Date.now() + 2 * 60 * MINUTO))
    );
    await criarReuniao(
      deps(db, recall),
      pedido(new Date(Date.now() + 5 * 60 * MINUTO), OUTRA_SESSION)
    );

    expect(bots).toHaveLength(2);
    // Sem leave_call: o bot da outra conversa tem hora própria e continua.
    const antiga = db.getMeeting((primeira as { meeting: { id: string } }).meeting.id);
    expect(antiga?.status).toBe('created');
  });

  it('mesma sala, MESMO horário, conversa diferente: o bot anterior sai', async () => {
    // Comportamento de sempre — dois bots na mesma call misturariam a
    // transcrição de dois clientes.
    const db = new Db(':memory:');
    const { recall, bots } = montarRecall();
    const quando = new Date(Date.now() + 2 * 60 * MINUTO);

    const primeira = await criarReuniao(deps(db, recall), pedido(quando));
    await criarReuniao(deps(db, recall), pedido(quando, OUTRA_SESSION));

    expect(bots).toHaveLength(2);
    const antiga = db.getMeeting((primeira as { meeting: { id: string } }).meeting.id);
    expect(antiga?.status).toBe('ended');
  });

  it('o horário marcado sobrevive ao timeout do Recall', async () => {
    // Se a nota se perdesse, o retry acharia que é outro horário e poria um
    // segundo bot na mesma sala.
    const db = new Db(':memory:');
    const quando = new Date(Date.now() + 2 * 60 * MINUTO);
    let tentativas = 0;
    const fetchImpl = ((_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      tentativas += 1;
      // Nunca responde: quem termina a chamada é o timeout do próprio cliente.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('abortado')));
      });
    }) as typeof fetch;
    const recall = new RecallClient({ apiKey: 'k', fetchImpl, timeoutMs: 5 });

    const primeira = await criarReuniao(deps(db, recall), pedido(quando));
    expect(primeira.ok).toBe(false);

    const retry = await criarReuniao(deps(db, recall), pedido(quando));
    expect(retry.ok && retry.criada).toBe(false);
    expect(tentativas).toBe(1);
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
