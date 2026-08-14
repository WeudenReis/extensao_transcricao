import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
  PainelClient,
  validarCnpj,
  normalizarCnpj,
  type RegistroReuniaoPainel,
} from '../src/painel/client.js';
import { createPainelInternoRouter } from '../src/routes/painelInterno.js';
import { jsonResponse } from './helpers.js';

/**
 * Adapter do painel interno (contrato PROVISÓRIO) + as rotas que o repassam.
 * A regra que estes testes guardam: o painel interno caindo NUNCA derruba o
 * fluxo de reunião — todo método devolve fallback em vez de lançar.
 */

// CNPJs com dígitos verificadores REAIS (calculados, não inventados).
const CNPJ_VALIDO = '11222333000181';
const CNPJ_VALIDO_FORMATADO = '11.222.333/0001-81';
const CNPJ_DV_ERRADO = '11222333000180';

interface Chamada {
  url: string;
  metodo: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Client apontando pra um painel de mentira; toda chamada fica registrada. */
function montarClient(
  responder: (url: string) => Response | Promise<Response>,
  opcoes: { semUrl?: boolean; semToken?: boolean } = {}
): { painel: PainelClient; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    chamadas.push({
      url: String(url),
      metodo: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(responder(String(url)));
  }) as typeof fetch;
  const painel = new PainelClient({
    baseUrl: opcoes.semUrl ? undefined : 'https://painel.exemplo',
    apiToken: opcoes.semToken ? undefined : 'token-do-painel',
    fetchImpl,
    timeoutMs: 200,
  });
  return { painel, chamadas };
}

describe('validação de CNPJ', () => {
  it('aceita CNPJ com dígitos verificadores corretos, com e sem máscara', () => {
    expect(validarCnpj(CNPJ_VALIDO)).toBe(true);
    expect(validarCnpj(CNPJ_VALIDO_FORMATADO)).toBe(true);
    // Banco do Brasil — CNPJ real conhecido, outro par de verificadores.
    expect(validarCnpj('00.000.000/0001-91')).toBe(true);
  });

  it('recusa dígito verificador errado — é isso que pega o dígito trocado', () => {
    expect(validarCnpj(CNPJ_DV_ERRADO)).toBe(false);
  });

  it('recusa tamanho errado e sequência repetida', () => {
    expect(validarCnpj('1122233300018')).toBe(false); // 13 dígitos
    expect(validarCnpj('112223330001811')).toBe(false); // 15 dígitos
    expect(validarCnpj('')).toBe(false);
    // Passa na conta dos verificadores, mas não é CNPJ de ninguém.
    expect(validarCnpj('11111111111111')).toBe(false);
  });

  it('normaliza tirando tudo que não é dígito', () => {
    expect(normalizarCnpj(CNPJ_VALIDO_FORMATADO)).toBe(CNPJ_VALIDO);
  });
});

describe('PainelClient sem PAINEL_API_URL (integração desligada)', () => {
  it('não toca a rede e devolve os fallbacks', async () => {
    const { painel, chamadas } = montarClient(() => jsonResponse({}), { semUrl: true });

    expect(painel.estaConfigurado()).toBe(false);
    expect(await painel.vendedores()).toEqual([]);
    expect(await painel.disponibilidade(new Date(), new Date())).toBeNull();
    expect(await painel.distribuirResponsavel('cs')).toBeNull();
    expect(await painel.onboardingPorCnpj(CNPJ_VALIDO)).toBeNull();
    await expect(painel.registrarReuniao(registroDeExemplo())).resolves.toBeUndefined();
    expect(chamadas).toHaveLength(0);
  });
});

describe('PainelClient.disponibilidade', () => {
  it('devolve as janelas e pergunta pelo intervalo pedido', async () => {
    const { painel, chamadas } = montarClient(() =>
      jsonResponse([
        { inicio: '2026-08-20T14:00:00.000Z', fim: '2026-08-20T15:00:00.000Z' },
        // Entrada quebrada no meio da lista não derruba as boas.
        { inicio: '2026-08-20T16:00:00.000Z' },
      ])
    );
    const inicio = new Date('2026-08-20T00:00:00.000Z');
    const fim = new Date('2026-08-21T00:00:00.000Z');

    const janelas = await painel.disponibilidade(inicio, fim);

    expect(janelas).toEqual([
      { inicio: '2026-08-20T14:00:00.000Z', fim: '2026-08-20T15:00:00.000Z' },
    ]);
    expect(chamadas[0]?.url).toContain('/disponibilidade');
    expect(chamadas[0]?.url).toContain(encodeURIComponent(inicio.toISOString()));
    expect(chamadas[0]?.url).toContain(encodeURIComponent(fim.toISOString()));
  });

  it('painel fora do ar devolve null — quem agenda NÃO pode ser bloqueado', async () => {
    const { painel } = montarClient(() => new Response('fora', { status: 503 }));
    expect(await painel.disponibilidade(new Date(), new Date())).toBeNull();
  });

  it('resposta que não é lista também vira null', async () => {
    const { painel } = montarClient(() => jsonResponse({ estranho: true }));
    expect(await painel.disponibilidade(new Date(), new Date())).toBeNull();
  });
});

describe('PainelClient.distribuirResponsavel', () => {
  it('devolve o responsável e manda o tipo no corpo', async () => {
    const { painel, chamadas } = montarClient(() =>
      jsonResponse({ email: 'dona@time.com', nome: 'Dona' })
    );

    const pessoa = await painel.distribuirResponsavel('migracao');

    expect(pessoa).toEqual({ email: 'dona@time.com', nome: 'Dona' });
    expect(chamadas[0]?.metodo).toBe('POST');
    expect(chamadas[0]?.body).toEqual({ tipo: 'migracao' });
    // O token vai no header — e SÓ no header.
    expect(chamadas[0]?.headers.Authorization).toBe('Bearer token-do-painel');
  });

  it('resposta sem e-mail utilizável vira null (cai em quem marcou)', async () => {
    const { painel } = montarClient(() => jsonResponse({ nome: 'Sem Email' }));
    expect(await painel.distribuirResponsavel('implantacao')).toBeNull();
  });

  it('erro de rede vira null, nunca exceção', async () => {
    const fetchImpl = (() => Promise.reject(new Error('rede caiu'))) as typeof fetch;
    const painel = new PainelClient({
      baseUrl: 'https://painel.exemplo',
      apiToken: undefined,
      fetchImpl,
      timeoutMs: 200,
    });
    await expect(painel.distribuirResponsavel('cs')).resolves.toBeNull();
  });

  it('painel que não responde estoura o timeout e vira null', async () => {
    // O fetch só termina quando o AbortController do client desiste.
    const fetchImpl = ((_u: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('abortado')));
      })) as typeof fetch;
    const painel = new PainelClient({
      baseUrl: 'https://painel.exemplo',
      apiToken: undefined,
      fetchImpl,
      timeoutMs: 10,
    });
    await expect(painel.distribuirResponsavel('cs')).resolves.toBeNull();
  });
});

describe('PainelClient.vendedores', () => {
  it('devolve a lista, pulando entradas sem e-mail', async () => {
    const { painel } = montarClient(() =>
      jsonResponse([
        { email: 'a@time.com', nome: 'Ana' },
        { nome: 'Sem Email' },
        { email: 'b@time.com' }, // sem nome: o e-mail serve de nome
      ])
    );

    expect(await painel.vendedores()).toEqual([
      { email: 'a@time.com', nome: 'Ana' },
      { email: 'b@time.com', nome: 'b@time.com' },
    ]);
  });

  it('erro vira lista vazia', async () => {
    const { painel } = montarClient(() => new Response('erro', { status: 500 }));
    expect(await painel.vendedores()).toEqual([]);
  });
});

describe('PainelClient.onboardingPorCnpj', () => {
  it('devolve os dados e consulta pelo CNPJ NORMALIZADO', async () => {
    const { painel, chamadas } = montarClient(() =>
      jsonResponse({ nome: 'Padaria Real', instancia: 'chatpro-abc', telefone: '+551199999' })
    );

    const dados = await painel.onboardingPorCnpj(CNPJ_VALIDO_FORMATADO);

    expect(dados).toEqual({
      nome: 'Padaria Real',
      instancia: 'chatpro-abc',
      telefone: '+551199999',
    });
    expect(chamadas[0]?.url).toContain(`cnpj=${CNPJ_VALIDO}`);
    expect(chamadas[0]?.url).not.toContain('11.222');
  });

  it('não encontrado (404) e resposta vazia viram null', async () => {
    const { painel } = montarClient(() => new Response('não achei', { status: 404 }));
    expect(await painel.onboardingPorCnpj(CNPJ_VALIDO)).toBeNull();

    const { painel: painel2 } = montarClient(() => jsonResponse({}));
    expect(await painel2.onboardingPorCnpj(CNPJ_VALIDO)).toBeNull();
  });
});

describe('PainelClient.registrarReuniao (melhor esforço)', () => {
  it('posta o registro com o CNPJ normalizado', async () => {
    const { painel, chamadas } = montarClient(() => jsonResponse({ ok: true }, 201));

    await painel.registrarReuniao(registroDeExemplo());

    expect(chamadas[0]?.url).toContain('/reunioes');
    const corpo = chamadas[0]?.body as RegistroReuniaoPainel;
    expect(corpo.meetingId).toBe('reuniao-1');
    expect(corpo.cliente?.cnpj).toBe(CNPJ_VALIDO);
  });

  it('falha do painel não lança — a reunião já existe, o registro é bônus', async () => {
    const { painel } = montarClient(() => new Response('caiu', { status: 500 }));
    await expect(painel.registrarReuniao(registroDeExemplo())).resolves.toBeUndefined();
  });
});

// ─── As rotas /api/painel/* ──────────────────────────────────────────────────

const servidores: Server[] = [];
afterEach(() => {
  for (const s of servidores.splice(0)) s.close();
});

async function montarRota(painel: PainelClient): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createPainelInternoRouter({ painel }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servidores.push(server);
  const addr = server.address();
  const porta = typeof addr === 'object' && addr ? addr.port : 0;
  return `http://127.0.0.1:${porta}`;
}

describe('GET /api/painel/vendedores', () => {
  it('repassa a lista do painel interno', async () => {
    const { painel } = montarClient(() => jsonResponse([{ email: 'v@time.com', nome: 'Vera' }]));
    const base = await montarRota(painel);

    const res = await fetch(`${base}/api/painel/vendedores`);
    const corpo = (await res.json()) as { configurado: boolean; vendedores: unknown[] };

    expect(res.status).toBe(200);
    expect(corpo.configurado).toBe(true);
    expect(corpo.vendedores).toEqual([{ email: 'v@time.com', nome: 'Vera' }]);
  });

  it('sem painel configurado devolve vazio, não erro', async () => {
    const { painel } = montarClient(() => jsonResponse([]), { semUrl: true });
    const base = await montarRota(painel);

    const res = await fetch(`${base}/api/painel/vendedores`);
    const corpo = (await res.json()) as { configurado: boolean; vendedores: unknown[] };

    expect(res.status).toBe(200);
    expect(corpo.configurado).toBe(false);
    expect(corpo.vendedores).toEqual([]);
  });
});

describe('GET /api/painel/onboarding', () => {
  it('CNPJ inválido é 400 e NÃO consulta o painel', async () => {
    const { painel, chamadas } = montarClient(() => jsonResponse({ nome: 'x' }));
    const base = await montarRota(painel);

    const semCnpj = await fetch(`${base}/api/painel/onboarding`);
    const dvErrado = await fetch(`${base}/api/painel/onboarding?cnpj=${CNPJ_DV_ERRADO}`);

    expect(semCnpj.status).toBe(400);
    expect(dvErrado.status).toBe(400);
    expect(chamadas).toHaveLength(0);
  });

  it('CNPJ válido repassa e devolve os dados', async () => {
    const { painel } = montarClient(() =>
      jsonResponse({ nome: 'Padaria Real', instancia: 'chatpro-abc', telefone: '11999' })
    );
    const base = await montarRota(painel);

    const res = await fetch(
      `${base}/api/painel/onboarding?cnpj=${encodeURIComponent(CNPJ_VALIDO_FORMATADO)}`
    );
    const corpo = (await res.json()) as { encontrado: boolean; cliente: { nome: string } };

    expect(res.status).toBe(200);
    expect(corpo.encontrado).toBe(true);
    expect(corpo.cliente.nome).toBe('Padaria Real');
  });

  it('não encontrado responde 200 com encontrado=false — o atendente digita na mão', async () => {
    const { painel } = montarClient(() => new Response('nada', { status: 404 }));
    const base = await montarRota(painel);

    const res = await fetch(`${base}/api/painel/onboarding?cnpj=${CNPJ_VALIDO}`);
    const corpo = (await res.json()) as { encontrado: boolean; cliente: null };

    expect(res.status).toBe(200);
    expect(corpo.encontrado).toBe(false);
    expect(corpo.cliente).toBeNull();
  });
});

function registroDeExemplo(): RegistroReuniaoPainel {
  return {
    meetingId: 'reuniao-1',
    sessionId: '78562bd7-3d56-47ae-9d4f-25dd80e6b024',
    tipo: 'cs',
    atendenteEmail: 'quem@marcou.com',
    responsavelEmail: 'dona@time.com',
    meetUrl: 'https://meet.google.com/abc-defg-hij',
    quando: '2026-08-20T14:00:00.000Z',
    cliente: {
      nome: 'Padaria Real',
      cnpj: CNPJ_VALIDO_FORMATADO,
      instancia: 'chatpro-abc',
      telefone: '+5511999998888',
    },
  };
}
