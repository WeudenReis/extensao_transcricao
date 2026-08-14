import { describe, it, expect, vi, afterEach } from 'vitest';
import { Db } from '../src/db.js';
import { ChatproClient } from '../src/chatpro/client.js';
import {
  EnviosAgendadosWorker,
  JANELA_PERDIDA_MS,
} from '../src/pipeline/enviosAgendados.js';
import { jsonResponse } from './helpers.js';

/**
 * O worker que dispara o convite da reunião AGENDADA ~5 min antes do horário.
 * Três regras guardadas aqui: sem retry (convite atrasado é pior que nenhum),
 * janela perdida marca 'falhou' sem tentar, e reunião morta cancela o convite.
 */

const SESSION = '78562bd7-3d56-47ae-9d4f-25dd80e6b024';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const AGORA = new Date('2026-08-13T12:00:00.000Z');
const MINUTO = 60_000;

/** ISO relativo ao relógio injetado do teste. */
function em(minutos: number): string {
  return new Date(AGORA.getTime() + minutos * MINUTO).toISOString();
}

/** A fila inteira que ainda está 'pendente' (consulta com data no futuro longe). */
function pendentes(db: Db) {
  return db.enviosVencidos(em(365 * 24 * 60), 100);
}

interface Cenario {
  db: Db;
  worker: EnviosAgendadosWorker;
  /** Só as chamadas de envio de mensagem — o que o cliente receberia. */
  envios: { body: Record<string, unknown> }[];
}

function montar(opcoes: { falhaEnvio?: boolean } = {}): Cenario {
  const db = new Db(':memory:');
  const envios: { body: Record<string, unknown> }[] = [];

  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes('/sessions/getSessionById')) {
      return Promise.resolve(jsonResponse({ session: { provider: 'whatsapp' } }));
    }
    if (u.includes('/messages/sendMessage')) {
      envios.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Promise.resolve(
        opcoes.falhaEnvio ? new Response('erro', { status: 500 }) : jsonResponse({ ok: true }, 201)
      );
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  }) as typeof fetch;

  const chatpro = new ChatproClient({
    baseUrl: 'https://sparks.exemplo',
    instanceToken: 'token',
    instanceId: 'chatpro-1',
    userId: 'user-1',
    fetchImpl,
  });

  const worker = new EnviosAgendadosWorker({ db, chatpro, now: () => AGORA });
  return { db, worker, envios };
}

/** Reunião de apoio + convite na fila, com o vencimento que o teste pedir. */
function agendar(db: Db, enviarEm: string, meetingId = 'reuniao-1'): number {
  if (!db.getMeeting(meetingId)) {
    db.createMeeting({
      id: meetingId,
      botId: null,
      sessionId: SESSION,
      meetingUrl: MEET_URL,
      meetingCode: 'abc-defg-hij',
      botName: 'chatPro (gravando)',
    });
  }
  return db.criarEnvioAgendado({
    meetingId,
    sessionId: SESSION,
    instanceId: 'chatpro-1',
    message: `Reunião marcada para hoje às 12h05: ${MEET_URL}`,
    enviarEm,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EnviosAgendadosWorker.processOnce', () => {
  it('envia o convite vencido pela conversa certa e marca como enviado', async () => {
    const { db, worker, envios } = montar();
    agendar(db, em(-1));

    const resumo = await worker.processOnce();

    expect(resumo).toEqual({ enviados: 1, falhados: 0, cancelados: 0, perdidos: 0 });
    expect(envios).toHaveLength(1);
    expect(envios[0]?.body).toMatchObject({
      sessionId: SESSION,
      instanceId: 'chatpro-1',
      provider: 'whatsapp',
    });
    expect(String(envios[0]?.body.message)).toContain(MEET_URL);
    // Saiu da fila: a próxima passada não manda o convite de novo.
    expect(pendentes(db)).toHaveLength(0);
    expect((await worker.processOnce()).enviados).toBe(0);
    expect(envios).toHaveLength(1);
  });

  it('convite ainda no futuro fica quieto na fila', async () => {
    const { db, worker, envios } = montar();
    agendar(db, em(10));

    const resumo = await worker.processOnce();

    expect(resumo).toEqual({ enviados: 0, falhados: 0, cancelados: 0, perdidos: 0 });
    expect(envios).toHaveLength(0);
    expect(pendentes(db)).toHaveLength(1);
  });

  it('falha do chatPro marca falhou e NÃO retenta — convite atrasado é pior que nenhum', async () => {
    const { db, worker, envios } = montar({ falhaEnvio: true });
    agendar(db, em(-1));

    const resumo = await worker.processOnce();

    expect(resumo.falhados).toBe(1);
    expect(envios).toHaveLength(1);
    // Fora da fila: nenhuma passada futura tenta de novo.
    expect(pendentes(db)).toHaveLength(0);
    await worker.processOnce();
    expect(envios).toHaveLength(1);
  });

  it('vencido há mais de 30 min é janela perdida: falhou SEM tentar', async () => {
    const { db, worker, envios } = montar();
    agendar(db, new Date(AGORA.getTime() - JANELA_PERDIDA_MS - MINUTO).toISOString());

    const resumo = await worker.processOnce();

    // A reunião já começou há ~25 min — "sua reunião é daqui a 5 min" agora
    // só confundiria o cliente.
    expect(resumo.perdidos).toBe(1);
    expect(envios).toHaveLength(0);
    expect(pendentes(db)).toHaveLength(0);
  });

  it('no limite da janela (30 min exatos) o convite ainda sai', async () => {
    const { worker, envios, db } = montar();
    agendar(db, new Date(AGORA.getTime() - JANELA_PERDIDA_MS).toISOString());

    const resumo = await worker.processOnce();

    expect(resumo.enviados).toBe(1);
    expect(envios).toHaveLength(1);
  });

  it('bot que falhou NÃO segura o convite — a reunião acontece do mesmo jeito', async () => {
    // 'failed' aqui quer dizer que o BOT falhou (Recall fora do ar, sem API
    // key), não que a reunião foi desmarcada: o link já está na agenda e o
    // atendente já foi avisado de que a reunião está marcada. Segurar o convite
    // deixaria atendente e cliente esperando um pelo outro.
    const { db, worker, envios } = montar();
    agendar(db, em(-1));
    db.updateMeetingStatus('reuniao-1', 'failed', 'bot não pôde ser agendado');

    const resumo = await worker.processOnce();

    expect(resumo.enviados).toBe(1);
    expect(resumo.cancelados).toBe(0);
    expect(envios).toHaveLength(1);
  });

  it('cancelamento de verdade é explícito e aí sim o convite não sai', async () => {
    const { db, worker, envios } = montar();
    agendar(db, em(-1));
    // É assim que a sala reaproveitada mata o convite da reunião anterior.
    expect(db.cancelarEnviosDaReuniao('reuniao-1')).toBe(1);

    const resumo = await worker.processOnce();

    expect(resumo.enviados).toBe(0);
    expect(envios).toHaveLength(0);
    expect(pendentes(db)).toHaveLength(0);
  });

  it('convite órfão (sem reunião no banco) ainda sai — o link importa mais que o bot', async () => {
    const { db, worker, envios } = montar();
    // Convite órfão: aponta pra uma reunião que nunca foi gravada no banco.
    db.criarEnvioAgendado({
      meetingId: 'fantasma',
      sessionId: SESSION,
      instanceId: null,
      message: `link: ${MEET_URL}`,
      enviarEm: em(-1),
    });

    // Sem RECALL_API_KEY a rota cria o envio com um id órfão de propósito.
    // Cancelar aqui faria o cliente nunca receber o link.
    const resumo = await worker.processOnce();

    expect(resumo.enviados).toBe(1);
    expect(resumo.cancelados).toBe(0);
    expect(envios).toHaveLength(1);
  });

  it('"amanhã" vira "hoje" quando o convite é entregue no dia da reunião', async () => {
    // A mensagem é montada quando o atendente marca e entregue ~5 min antes do
    // horário. Congelar "amanhã às 10h" na hora de marcar faria o cliente ler
    // isso no PRÓPRIO dia e entender o dia seguinte — perdendo a reunião que
    // começa em 5 minutos. Por isso o {quando} fica cru na fila.
    const { db, worker, envios } = montar();
    const reuniaoEm = new Date(AGORA.getTime() + 5 * 60_000);
    db.criarEnvioAgendado({
      meetingId: 'reuniao-1',
      sessionId: SESSION,
      instanceId: null,
      message: 'Reunião marcada para {quando}: ' + MEET_URL,
      enviarEm: em(-1),
      reuniaoEm: reuniaoEm.toISOString(),
    });

    const resumo = await worker.processOnce();

    expect(resumo.enviados).toBe(1);
    const corpo = JSON.stringify(envios[0]);
    expect(corpo).toContain('hoje às');
    expect(corpo).not.toContain('{quando}');
  });

  it('convite sem horário guardado não vaza o {quando} cru pro cliente', async () => {
    const { db, worker, envios } = montar();
    db.criarEnvioAgendado({
      meetingId: 'reuniao-1',
      sessionId: SESSION,
      instanceId: null,
      message: 'Reunião marcada para {quando}: ' + MEET_URL,
      enviarEm: em(-1),
    });

    await worker.processOnce();

    const corpo = JSON.stringify(envios[0]);
    expect(corpo).not.toContain('{quando}');
    expect(corpo).toContain('em instantes');
  });

  it('um convite não bloqueia o outro: cancelado e enviado na mesma passada', async () => {
    const { db, worker, envios } = montar();
    agendar(db, em(-2), 'reuniao-morta');
    db.cancelarEnviosDaReuniao('reuniao-morta');
    agendar(db, em(-1), 'reuniao-viva');

    const resumo = await worker.processOnce();

    expect(resumo.enviados).toBe(1);
    expect(envios).toHaveLength(1);
  });
});

describe('EnviosAgendadosWorker start/stop', () => {
  it('o intervalo dispara a passada; stopWorker para de vez', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
    // Relógio de verdade (fake) em vez do injetado: é o intervalo em teste.
    const db = new Db(':memory:');
    const envios: unknown[] = [];
    const fetchImpl = ((url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.includes('/messages/sendMessage')) {
        envios.push(u);
        return Promise.resolve(jsonResponse({ ok: true }, 201));
      }
      return Promise.resolve(jsonResponse({ session: { provider: 'whatsapp' } }));
    }) as typeof fetch;
    const chatpro = new ChatproClient({
      baseUrl: 'https://sparks.exemplo',
      instanceToken: 'token',
      instanceId: 'chatpro-1',
      userId: 'user-1',
      fetchImpl,
    });
    const worker = new EnviosAgendadosWorker({ db, chatpro });
    agendar(db, em(-1));

    worker.startWorker(1_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(envios).toHaveLength(1);

    worker.stopWorker();
    agendar(db, em(-1), 'reuniao-2');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(envios).toHaveLength(1);
  });
});
