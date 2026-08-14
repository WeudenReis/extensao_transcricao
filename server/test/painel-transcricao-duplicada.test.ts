import { describe, it, expect, afterAll, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Db } from '../src/db.js';
import { ChatproClient } from '../src/chatpro/client.js';
import { PainelClient } from '../src/painel/client.js';
import { createMeetingsRouter } from '../src/routes/meetings.js';
import { AVISO_PAINEL_INCERTO, entregarAoChatpro } from '../src/pipeline/recallQueue.js';
import { jsonResponse } from './helpers.js';

/**
 * TRANSCRIÇÃO POSTADA DUAS VEZES NO PAINEL.
 *
 * O defeito: o POST /transcript estourava os 15 s, o painel tinha SALVO o texto
 * e só a resposta se perdera — mas aqui isso virava `painel_status = 'falhou'`.
 * Como a única trava era `painel_status === 'enviado'`, qualquer reexecução
 * (reentrega do transcript.done pelo Recall, botão de reenvio da página de
 * revisão) postava a transcrição inteira de novo. O painel não tem
 * Idempotency-Key: o resultado é a transcrição do cliente gravada em dobro no
 * registro da reunião, dado sensível duplicado e sem como apagar daqui.
 *
 * A regra que estes testes guardam:
 *   timeout / rede / 5xx → 'incerto' → NUNCA reenvia sozinho
 *   4xx claro (o painel recusou) → 'falhou' → reenvia, porque nada foi salvo
 *   sucesso → 'enviado' → nunca mais
 *   reenvio de um 'incerto' só com confirmação explícita (forcarPainel/forcar=true)
 */

const EMAIL = 'atendente@empresa.com';
const SESSION = '78562bd7-3d56-47ae-9d4f-25dd80e6b024';

type Modo = 'ok' | 'recusa' | 'instavel' | 'timeout';

interface PainelDeTeste {
  painel: PainelClient;
  /** Uma entrada por POST /transcript que SAIU daqui. */
  chamadas: string[];
}

/**
 * Painel falso com roteiro: cada chamada consome um modo; o último se repete.
 * O 'timeout' não responde nunca — quem termina a chamada é o AbortController
 * do próprio cliente, exatamente como no incidente real.
 */
function painelDeTeste(modos: Modo[]): PainelDeTeste {
  const chamadas: string[] = [];
  let i = 0;
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    chamadas.push(String(url));
    const modo = modos[Math.min(i, modos.length - 1)] ?? 'ok';
    i += 1;
    if (modo === 'ok') return Promise.resolve(jsonResponse({ ok: true }, 201));
    // 422 é o painel FALANDO: actor_email não é usuário ativo. Nada foi salvo.
    if (modo === 'recusa') {
      return Promise.resolve(jsonResponse({ error: 'actor_email não é usuário ativo' }, 422));
    }
    // 502 pode ser o gateway desistindo DEPOIS de o painel gravar.
    if (modo === 'instavel') return Promise.resolve(jsonResponse({ error: 'bad gateway' }, 502));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  }) as typeof fetch;

  return {
    chamadas,
    painel: new PainelClient({
      baseUrl: 'https://painel.teste',
      extAgendaToken: 'token-de-teste',
      fetchImpl,
      // 20 ms no lugar dos 15 s: o teste não pode esperar o timeout real.
      timeoutMs: 20,
    }),
  };
}

/** chatPro de propósito não configurado: aqui o que importa é o painel. */
function chatproInerte(): ChatproClient {
  return new ChatproClient({
    baseUrl: undefined,
    instanceToken: undefined,
    instanceId: undefined,
    userId: undefined,
  });
}

function bancoComReuniao(): Db {
  const db = new Db(':memory:');
  db.createMeeting({
    id: 'reuniao-1',
    botId: 'bot-1',
    sessionId: SESSION,
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    meetingCode: 'abc-defg-hij',
    botName: 'chatPro (gravando)',
    atendenteEmail: EMAIL,
    // O elo com o painel: sem ele a transcrição não tem pra onde subir.
    painelMeetingId: 'reuniao-no-painel-1',
  });
  db.setMeetingTranscript({
    id: 'reuniao-1',
    transcriptJson: JSON.stringify({
      falas: [
        { speaker: 'Maria', text: 'o prazo é sexta', startMs: 1000, endMs: 3000, isHost: true },
        { speaker: 'João', text: 'combinado', startMs: 4000, endMs: 5000, isHost: false },
      ],
      participantes: [
        { nome: 'Maria', isHost: true, email: null },
        { nome: 'João', isHost: false, email: null },
      ],
    }),
    durationSeconds: 600,
  });
  return db;
}

/** Uma passada de entrega, sempre relendo a linha (é o que o worker faz). */
async function entregar(
  db: Db,
  painel: PainelClient,
  options: { forcarPainel?: boolean } = {}
): Promise<void> {
  await entregarAoChatpro(db, chatproInerte(), db.getMeeting('reuniao-1')!, {
    painel,
    ...(options.forcarPainel === undefined ? {} : { forcarPainel: options.forcarPainel }),
    // Sem IA no teste: a suíte nunca toca a rede.
    gerarResumoImpl: async () => null,
  });
}

beforeEach(() => {
  // O caminho incerto grita no log (console.error) de propósito — não é pra
  // sujar a saída da suíte.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('entrega da transcrição ao painel', () => {
  it('timeout marca INCERTO e a passada seguinte NÃO reenvia', async () => {
    const db = bancoComReuniao();
    const { painel, chamadas } = painelDeTeste(['timeout']);

    await entregar(db, painel);

    const depois = db.getMeeting('reuniao-1');
    expect(depois?.painel_status).toBe('incerto');
    expect(chamadas).toHaveLength(1);

    // A reentrega do transcript.done (ou o worker retomando após o boot) passa
    // por aqui de novo. É exatamente onde a transcrição duplicava.
    await entregar(db, painel);
    await entregar(db, painel);

    expect(chamadas).toHaveLength(1);
    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('incerto');
  });

  it('5xx também é INCERTO — o gateway pode ter desistido depois de o painel gravar', async () => {
    const db = bancoComReuniao();
    const { painel, chamadas } = painelDeTeste(['instavel']);

    await entregar(db, painel);
    await entregar(db, painel);

    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('incerto');
    expect(chamadas).toHaveLength(1);
  });

  it('4xx claro marca FALHOU e a passada seguinte reenvia — nada foi salvo lá', async () => {
    const db = bancoComReuniao();
    const { painel, chamadas } = painelDeTeste(['recusa']);

    await entregar(db, painel);

    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('falhou');
    expect(db.getMeeting('reuniao-1')?.painel_detalhe).toContain('422');
    expect(chamadas).toHaveLength(1);

    await entregar(db, painel);
    expect(chamadas).toHaveLength(2);
  });

  it('recusa que depois vira sucesso: entrega uma única vez e para', async () => {
    const db = bancoComReuniao();
    const { painel, chamadas } = painelDeTeste(['recusa', 'ok']);

    await entregar(db, painel); // 422 → falhou
    await entregar(db, painel); // 201 → enviado
    await entregar(db, painel); // não pode mais sair nada daqui

    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('enviado');
    expect(chamadas).toHaveLength(2);
  });

  it('sucesso marca ENVIADO e nunca mais sobe nada', async () => {
    const db = bancoComReuniao();
    const { painel, chamadas } = painelDeTeste(['ok']);

    await entregar(db, painel);
    await entregar(db, painel);
    await entregar(db, painel);

    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('enviado');
    expect(chamadas).toHaveLength(1);
  });

  it('forcarPainel reenvia o INCERTO — mas só com essa confirmação na mão', async () => {
    const db = bancoComReuniao();
    const { painel, chamadas } = painelDeTeste(['timeout', 'ok']);

    await entregar(db, painel);
    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('incerto');

    // Sem confirmação: nada sai, por mais vezes que o caminho automático passe.
    await entregar(db, painel, { forcarPainel: false });
    expect(chamadas).toHaveLength(1);

    // Com confirmação de gente: sai, e agora confirma.
    await entregar(db, painel, { forcarPainel: true });
    expect(chamadas).toHaveLength(2);
    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('enviado');
  });

  it('nem forçado reenvia o que o painel já confirmou', async () => {
    const db = bancoComReuniao();
    const { painel, chamadas } = painelDeTeste(['ok']);

    await entregar(db, painel);
    await entregar(db, painel, { forcarPainel: true });

    expect(chamadas).toHaveLength(1);
  });

  it('o aviso diz, com todas as letras, que a transcrição PODE já estar lá', () => {
    expect(AVISO_PAINEL_INCERTO).toContain('PODE já estar no painel');
    expect(AVISO_PAINEL_INCERTO).toContain('duas vezes');
  });
});

// ─── A rota de reenvio ───────────────────────────────────────────────────────

const servidores: Server[] = [];

async function montarApp(painel: PainelClient): Promise<{ baseUrl: string; db: Db }> {
  const db = bancoComReuniao();
  const app = express();
  app.use(express.json());
  app.use(
    createMeetingsRouter({
      db,
      recall: undefined,
      chatpro: chatproInerte(),
      botName: 'chatPro (gravando)',
      entrega: { painel, gerarResumoImpl: async () => null },
    })
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servidores.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, db };
}

afterAll(async () => {
  await Promise.all(
    servidores.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        })
    )
  );
});

describe('POST /api/meetings/:id/send-chatpro com entrega incerta', () => {
  it('sem forcar: não reenvia ao painel e devolve o aviso pra tela', async () => {
    const { painel, chamadas } = painelDeTeste(['timeout']);
    const { baseUrl, db } = await montarApp(painel);

    // Primeiro clique: a entrega ao painel fica incerta.
    await fetch(`${baseUrl}/api/meetings/reuniao-1/send-chatpro`, { method: 'POST' });
    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('incerto');

    // Segundo clique, sem confirmação: o painel não recebe nada de novo.
    const resposta = await fetch(`${baseUrl}/api/meetings/reuniao-1/send-chatpro`, {
      method: 'POST',
    });
    const corpo = (await resposta.json()) as Record<string, unknown>;

    expect(chamadas).toHaveLength(1);
    expect(corpo.painelStatus).toBe('incerto');
    expect(corpo.painelPrecisaConfirmacao).toBe(true);
    expect(String(corpo.aviso)).toContain('PODE já estar no painel');
  });

  it('com ?forcar=true reenvia — é o operador assumindo a decisão', async () => {
    const { painel, chamadas } = painelDeTeste(['timeout', 'ok']);
    const { baseUrl, db } = await montarApp(painel);

    await fetch(`${baseUrl}/api/meetings/reuniao-1/send-chatpro`, { method: 'POST' });
    const resposta = await fetch(
      `${baseUrl}/api/meetings/reuniao-1/send-chatpro?forcar=true`,
      { method: 'POST' }
    );
    const corpo = (await resposta.json()) as Record<string, unknown>;

    expect(chamadas).toHaveLength(2);
    expect(db.getMeeting('reuniao-1')?.painel_status).toBe('enviado');
    expect(corpo.painelStatus).toBe('enviado');
    expect(corpo.aviso).toBeUndefined();
  });
});
