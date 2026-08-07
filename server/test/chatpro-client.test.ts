import { describe, it, expect } from 'vitest';
import {
  ChatproClient,
  montarPartes,
  montarCabecalho,
  marcarTempo,
  MAX_CARACTERES_COMENTARIO,
  type ChatproPayload,
} from '../src/chatpro/client.js';
import type { Fala } from '../src/recall/transcript.js';

/**
 * Entrega no chatPro Chat: POST {base}/messages/addComments com header
 * `instance-token` e corpo { instanceId, sessionId, message, userId }.
 */

const BASE = 'https://sparks.exemplo.com.br';
const TOKEN = 'instance-token-de-teste';
const INSTANCE = 'chatpro-1234567890';
const USER = 'user-uuid-abc';
const SESSION = '78562bd7-3d56-47ae-9d4f-25dd80e6b024';

function fala(speaker: string, text: string, startMs: number): Fala {
  return { speaker, text, startMs, endMs: startMs + 1500, isHost: speaker.includes('Atendente') };
}

function payload(over: Partial<ChatproPayload> = {}): ChatproPayload {
  return {
    sessionId: SESSION,
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    meetingCode: 'abc-defg-hij',
    startedAt: '2026-08-06T13:00:00.000Z',
    endedAt: '2026-08-06T13:34:00.000Z',
    durationSeconds: 2040,
    participants: [
      { nome: 'Maria Atendente', isHost: true, email: 'maria@exemplo.com' },
      { nome: 'João Cliente', isHost: false, email: null },
    ],
    transcript: [fala('Maria Atendente', 'bom dia, tudo bem?', 1000), fala('João Cliente', 'tudo', 4000)],
    source: 'recall-ai',
    ...over,
  };
}

interface Chamada {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function gravador(respostas: Response[]): { fetchImpl: typeof fetch; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  let i = 0;
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    chamadas.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const r = respostas[i];
    i += 1;
    return r ? Promise.resolve(r) : Promise.reject(new Error('resposta não preparada'));
  }) as typeof fetch;
  return { fetchImpl, chamadas };
}

function ok(): Response {
  return new Response(JSON.stringify({}), { status: 201 });
}

function cliente(fetchImpl: typeof fetch, over: Partial<Record<string, string>> = {}): ChatproClient {
  return new ChatproClient({
    baseUrl: BASE,
    instanceToken: 'instanceToken' in over ? over.instanceToken : TOKEN,
    instanceId: 'instanceId' in over ? over.instanceId : INSTANCE,
    userId: 'userId' in over ? over.userId : USER,
    fetchImpl,
  });
}

describe('marcação de tempo', () => {
  it('usa mm:ss e vira h:mm:ss depois de uma hora', () => {
    expect(marcarTempo(0)).toBe('00:00');
    expect(marcarTempo(1500)).toBe('00:01');
    expect(marcarTempo(65_000)).toBe('01:05');
    expect(marcarTempo(3_600_000)).toBe('1:00:00');
    expect(marcarTempo(3_725_000)).toBe('1:02:05');
    expect(marcarTempo(-5)).toBe('00:00');
  });
});

describe('formatação do comentário', () => {
  it('o cabeçalho traz duração, participantes e o link', () => {
    const c = montarCabecalho(payload());
    expect(c).toContain('34 min');
    expect(c).toContain('Maria Atendente · João Cliente');
    expect(c).toContain('https://meet.google.com/abc-defg-hij');
  });

  it('cada fala vira uma linha com horário e quem falou', () => {
    const [parte] = montarPartes(payload());
    expect(parte).toContain('[00:01] *Maria Atendente:* bom dia, tudo bem?');
    expect(parte).toContain('[00:04] *João Cliente:* tudo');
  });

  it('reunião sem fala nenhuma vira um comentário curto e explícito', () => {
    const partes = montarPartes(payload({ transcript: [], durationSeconds: 0 }));
    expect(partes).toHaveLength(1);
    expect(partes[0]).toContain('Ninguém falou');
  });

  it('transcrição longa é fatiada e cada parte respeita o limite', () => {
    const muitas = Array.from({ length: 400 }, (_, i) =>
      fala(i % 2 === 0 ? 'Maria Atendente' : 'João Cliente', `linha número ${i} da conversa`, i * 2000)
    );
    const partes = montarPartes(payload({ transcript: muitas }));

    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) {
      expect(p.length).toBeLessThanOrEqual(MAX_CARACTERES_COMENTARIO);
    }
    // Numeradas, pro atendente saber que há continuação.
    expect(partes[0]).toContain(`(parte 1/${partes.length})`);
    expect(partes.at(-1)).toContain(`(parte ${partes.length}/${partes.length})`);
  });

  it('não perde nenhuma fala ao fatiar', () => {
    const muitas = Array.from({ length: 300 }, (_, i) =>
      fala('Maria Atendente', `marcador-unico-${i}`, i * 2000)
    );
    const tudo = montarPartes(payload({ transcript: muitas })).join('\n');

    for (let i = 0; i < 300; i += 1) {
      expect(tudo, `fala ${i} sumiu`).toContain(`marcador-unico-${i}`);
    }
  });

  it('fala gigante sozinha é quebrada em vez de estourar o limite', () => {
    const enorme = fala('João Cliente', 'palavra '.repeat(2000).trim(), 1000);
    const partes = montarPartes(payload({ transcript: [enorme] }));

    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) {
      expect(p.length).toBeLessThanOrEqual(MAX_CARACTERES_COMENTARIO);
    }
  });

  it('fatiar é determinístico — a retomada depende disso', () => {
    const muitas = Array.from({ length: 250 }, (_, i) => fala('Maria Atendente', `linha ${i}`, i * 2000));
    const a = montarPartes(payload({ transcript: muitas }));
    const b = montarPartes(payload({ transcript: muitas }));
    expect(a).toEqual(b);
  });
});

describe('entrega', () => {
  it('posta no endpoint certo, com o header e o corpo que o chatPro espera', async () => {
    const { fetchImpl, chamadas } = gravador([ok()]);

    const r = await cliente(fetchImpl).enviar(payload());

    expect(r).toEqual({ ok: true, status: 'sent', partesEnviadas: 1 });
    expect(chamadas[0]?.url).toBe(`${BASE}/messages/addComments`);
    expect(chamadas[0]?.headers['instance-token']).toBe(TOKEN);
    expect(chamadas[0]?.body).toMatchObject({
      instanceId: INSTANCE,
      sessionId: SESSION,
      userId: USER,
    });
    expect(String(chamadas[0]?.body.message)).toContain('Transcrição da reunião');
  });

  it('sem as três variáveis configuradas, não toca a rede', async () => {
    const { fetchImpl, chamadas } = gravador([]);

    const r = await cliente(fetchImpl, { instanceToken: undefined }).enviar(payload());

    expect(r.status).toBe('skipped-no-url');
    expect(chamadas).toHaveLength(0);
  });

  it('sem sessionId não tenta postar — não existe conversa onde comentar', async () => {
    const { fetchImpl, chamadas } = gravador([]);

    const r = await cliente(fetchImpl).enviar(payload({ sessionId: null }));

    expect(r.status).toBe('failed');
    expect(r.ok).toBe(false);
    expect(chamadas).toHaveLength(0);
  });

  it('o instanceId da reunião tem prioridade sobre o do .env', async () => {
    const { fetchImpl, chamadas } = gravador([ok()]);

    await cliente(fetchImpl).enviar(payload({ instanceId: 'chatpro-da-conversa' }));

    expect(chamadas[0]?.body.instanceId).toBe('chatpro-da-conversa');
  });

  it('posta uma chamada por parte quando a transcrição é longa', async () => {
    const muitas = Array.from({ length: 400 }, (_, i) => fala('Maria Atendente', `linha ${i}`, i * 2000));
    const p = payload({ transcript: muitas });
    const total = montarPartes(p).length;
    const { fetchImpl, chamadas } = gravador(Array.from({ length: total }, ok));

    const r = await cliente(fetchImpl).enviar(p);

    expect(r).toEqual({ ok: true, status: 'sent', partesEnviadas: total });
    expect(chamadas).toHaveLength(total);
  });

  it('falha no meio devolve quantas partes entraram — e o reenvio NÃO repete', async () => {
    const muitas = Array.from({ length: 400 }, (_, i) => fala('Maria Atendente', `linha ${i}`, i * 2000));
    const p = payload({ transcript: muitas });
    const total = montarPartes(p).length;
    expect(total).toBeGreaterThan(2);

    // Primeira parte entra, segunda falha.
    const primeiro = gravador([ok(), new Response('erro', { status: 500 })]);
    const r1 = await cliente(primeiro.fetchImpl).enviar(p);

    expect(r1.ok).toBe(false);
    expect(r1.status).toBe('failed');
    expect(r1.partesEnviadas).toBe(1);

    // Reenvio informando o que já foi: começa da parte 2.
    const segundo = gravador(Array.from({ length: total - 1 }, ok));
    const r2 = await cliente(segundo.fetchImpl).enviar({ ...p, partesEnviadas: 1 });

    expect(r2.ok).toBe(true);
    expect(segundo.chamadas).toHaveLength(total - 1);
    // A parte 1 não foi postada de novo — é o que evita transcrição duplicada
    // na conversa do cliente.
    expect(String(segundo.chamadas[0]?.body.message)).toContain(`(parte 2/${total})`);
  });

  it('reenvio de algo já completo não posta nada', async () => {
    const { fetchImpl, chamadas } = gravador([]);
    const p = payload();
    const total = montarPartes(p).length;

    const r = await cliente(fetchImpl).enviar({ ...p, partesEnviadas: total });

    expect(r).toEqual({ ok: true, status: 'sent', partesEnviadas: total });
    expect(chamadas).toHaveLength(0);
  });

  it('erro HTTP vira failed com o motivo, sem vazar o instance-token', async () => {
    const { fetchImpl } = gravador([new Response('token inválido', { status: 401 })]);

    const r = await cliente(fetchImpl).enviar(payload());

    expect(r.status).toBe('failed');
    expect(r.motivo).toContain('401');
    expect(r.motivo).not.toContain(TOKEN);
  });
});
