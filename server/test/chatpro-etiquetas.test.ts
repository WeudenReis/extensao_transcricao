import { describe, it, expect } from 'vitest';
import { Etiquetador, type SituacaoReuniao } from '../src/chatpro/etiquetas.js';

/**
 * Etiquetas pós-reunião no chatPro: descobre o lead em
 * /sessions/getSessionById e marca cada situação em /tags/assignLabel.
 *
 * A regra que estes testes protegem: etiqueta é EFEITO COLATERAL da entrega da
 * transcrição — nada aqui pode lançar, e uma falha não pode arrastar as outras.
 */

const BASE = 'https://sparks.exemplo.com.br';
const TOKEN = 'instance-token-secretissimo';
const INSTANCE = 'chatpro-1234567890';
const SESSION = '78562bd7-3d56-47ae-9d4f-25dd80e6b024';
const LEAD = 'lead-uuid-9f1c';

const IDS: Partial<Record<SituacaoReuniao, string>> = {
  realizada: 'tag-realizada-1',
  'sem-gravacao': 'tag-sem-gravacao-2',
  longa: 'tag-longa-3',
};

interface Chamada {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** fetch de mentira: devolve as respostas na ordem e grava o que foi pedido. */
function gravador(respostas: (Response | Error)[]): {
  fetchImpl: typeof fetch;
  chamadas: Chamada[];
} {
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
    if (r instanceof Error) return Promise.reject(r);
    return r ? Promise.resolve(r) : Promise.reject(new Error('resposta não preparada'));
  }) as typeof fetch;
  return { fetchImpl, chamadas };
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status });
}

function sessaoOk(): Response {
  return json({ id: SESSION, provider: 'whatsapp', lead_id: LEAD, open: true, instance_id: INSTANCE });
}

function etiquetador(
  fetchImpl: typeof fetch,
  over: Partial<{
    instanceToken: string | undefined;
    instanceId: string | undefined;
    ids: Partial<Record<SituacaoReuniao, string>>;
  }> = {}
): Etiquetador {
  return new Etiquetador({
    baseUrl: BASE,
    instanceToken: 'instanceToken' in over ? over.instanceToken : TOKEN,
    instanceId: 'instanceId' in over ? over.instanceId : INSTANCE,
    ids: over.ids ?? IDS,
    fetchImpl,
  });
}

describe('Etiquetador.estaConfigurado', () => {
  it('exige token, instância e ao menos um id de etiqueta', () => {
    const { fetchImpl } = gravador([]);
    expect(etiquetador(fetchImpl).estaConfigurado()).toBe(true);
    expect(etiquetador(fetchImpl, { instanceToken: undefined }).estaConfigurado()).toBe(false);
    expect(etiquetador(fetchImpl, { instanceId: undefined }).estaConfigurado()).toBe(false);
    expect(etiquetador(fetchImpl, { ids: {} }).estaConfigurado()).toBe(false);
  });

  it('id vazio no .env conta como não configurado', () => {
    const { fetchImpl } = gravador([]);
    expect(etiquetador(fetchImpl, { ids: { realizada: '' } }).estaConfigurado()).toBe(false);
  });
});

describe('Etiquetador.leadDaSessao', () => {
  it('lê lead_id de /sessions/getSessionById com o header instance-token', async () => {
    const { fetchImpl, chamadas } = gravador([sessaoOk()]);
    const lead = await etiquetador(fetchImpl).leadDaSessao(SESSION);

    expect(lead).toBe(LEAD);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.url).toBe(`${BASE}/sessions/getSessionById`);
    expect(chamadas[0]?.headers['instance-token']).toBe(TOKEN);
    expect(chamadas[0]?.body).toEqual({ instanceId: INSTANCE, sessionId: SESSION });
  });

  it('aceita a resposta aninhada em session e lead_id numérico', async () => {
    const { fetchImpl } = gravador([json({ session: { lead_id: 4210 } })]);
    expect(await etiquetador(fetchImpl).leadDaSessao(SESSION)).toBe('4210');
  });

  it('devolve null (sem lançar) quando o chatPro responde erro', async () => {
    const { fetchImpl } = gravador([new Response('boom', { status: 500 })]);
    await expect(etiquetador(fetchImpl).leadDaSessao(SESSION)).resolves.toBeNull();
  });

  it('devolve null (sem lançar) quando a rede cai', async () => {
    const { fetchImpl } = gravador([new Error('ECONNRESET')]);
    await expect(etiquetador(fetchImpl).leadDaSessao(SESSION)).resolves.toBeNull();
  });

  it('devolve null quando a sessão não traz lead_id', async () => {
    const { fetchImpl } = gravador([json({ id: SESSION, provider: 'whatsapp' })]);
    await expect(etiquetador(fetchImpl).leadDaSessao(SESSION)).resolves.toBeNull();
  });

  it('sem instância nenhuma, nem chega a chamar a API', async () => {
    const { fetchImpl, chamadas } = gravador([]);
    const alvo = etiquetador(fetchImpl, { instanceId: undefined });

    expect(await alvo.leadDaSessao(SESSION)).toBeNull();
    expect(chamadas).toHaveLength(0);
  });
});

describe('Etiquetador.aplicar', () => {
  it('marca cada situação no lead com o corpo em camelCase', async () => {
    const { fetchImpl, chamadas } = gravador([sessaoOk(), json({}), json({})]);
    const resultado = await etiquetador(fetchImpl).aplicar(SESSION, ['realizada', 'longa']);

    expect(resultado).toEqual({ aplicadas: ['realizada', 'longa'], erros: [] });
    expect(chamadas).toHaveLength(3);
    expect(chamadas[1]?.url).toBe(`${BASE}/tags/assignLabel`);
    expect(chamadas[1]?.headers['instance-token']).toBe(TOKEN);
    expect(chamadas[1]?.body).toEqual({
      instanceId: INSTANCE,
      leadId: LEAD,
      tagId: IDS.realizada,
    });
    expect(chamadas[2]?.body).toEqual({ instanceId: INSTANCE, leadId: LEAD, tagId: IDS.longa });
  });

  it('pula em silêncio a situação sem id configurado — não é erro', async () => {
    const { fetchImpl, chamadas } = gravador([sessaoOk(), json({})]);
    const alvo = etiquetador(fetchImpl, { ids: { realizada: 'tag-realizada-1' } });
    const resultado = await alvo.aplicar(SESSION, ['realizada', 'longa']);

    expect(resultado).toEqual({ aplicadas: ['realizada'], erros: [] });
    // Sessão + 1 etiqueta: a 'longa' não virou chamada.
    expect(chamadas).toHaveLength(2);
  });

  it('nenhuma das situações pedidas tem id: não toca a rede', async () => {
    const { fetchImpl, chamadas } = gravador([]);
    const alvo = etiquetador(fetchImpl, { ids: { realizada: 'tag-realizada-1' } });
    const resultado = await alvo.aplicar(SESSION, ['longa', 'sem-gravacao']);

    expect(resultado).toEqual({ aplicadas: [], erros: [] });
    expect(chamadas).toHaveLength(0);
  });

  it('falha em uma etiqueta não impede as outras', async () => {
    const { fetchImpl, chamadas } = gravador([
      sessaoOk(),
      new Response('{"message":"tag inválida"}', { status: 400 }),
      json({}),
    ]);
    const resultado = await etiquetador(fetchImpl).aplicar(SESSION, ['realizada', 'longa']);

    expect(resultado.aplicadas).toEqual(['longa']);
    expect(resultado.erros).toHaveLength(1);
    expect(resultado.erros[0]).toContain("etiqueta 'realizada'");
    expect(resultado.erros[0]).toContain('400');
    expect(chamadas).toHaveLength(3);
  });

  it('sem lead na sessão, relata o erro e não tenta etiquetar', async () => {
    const { fetchImpl, chamadas } = gravador([json({ id: SESSION })]);
    const resultado = await etiquetador(fetchImpl).aplicar(SESSION, ['realizada']);

    expect(resultado.aplicadas).toEqual([]);
    expect(resultado.erros).toEqual([`sessão ${SESSION} sem lead — nenhuma etiqueta aplicada`]);
    expect(chamadas).toHaveLength(1);
  });

  it('não configurado: devolve vazio sem tocar a rede e sem lançar', async () => {
    const { fetchImpl, chamadas } = gravador([]);
    const alvo = etiquetador(fetchImpl, { instanceToken: undefined });
    const resultado = await alvo.aplicar(SESSION, ['realizada']);

    expect(resultado).toEqual({ aplicadas: [], erros: [] });
    expect(chamadas).toHaveLength(0);
  });

  it('a mesma situação repetida vira uma etiqueta só', async () => {
    const { fetchImpl, chamadas } = gravador([sessaoOk(), json({})]);
    const resultado = await etiquetador(fetchImpl).aplicar(SESSION, [
      'realizada',
      'realizada',
      'realizada',
    ]);

    expect(resultado.aplicadas).toEqual(['realizada']);
    expect(chamadas).toHaveLength(2);
  });

  it('o instanceId do parâmetro vence o do construtor nas duas chamadas', async () => {
    const { fetchImpl, chamadas } = gravador([sessaoOk(), json({})]);
    const outra = 'chatpro-0987654321';
    await etiquetador(fetchImpl).aplicar(SESSION, ['realizada'], outra);

    expect(chamadas[0]?.body.instanceId).toBe(outra);
    expect(chamadas[1]?.body.instanceId).toBe(outra);
  });

  it('nunca vaza o instance-token na mensagem de erro', async () => {
    const { fetchImpl } = gravador([sessaoOk(), new Response('{"message":"unauthorized"}', { status: 401 })]);
    const resultado = await etiquetador(fetchImpl).aplicar(SESSION, ['realizada']);

    expect(resultado.erros).toHaveLength(1);
    expect(resultado.erros[0]).toContain('401');
    expect(resultado.erros[0]).not.toContain(TOKEN);
  });
});
