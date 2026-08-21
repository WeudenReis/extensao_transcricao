import { Db } from '../src/db.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { PainelClient, BRASILAPI_URL, CNPJWS_URL } from '../src/painel/client.js';
import { createPainelInternoRouter } from '../src/routes/painelInterno.js';
import { jsonResponse } from './helpers.js';

/**
 * Preenchimento automático da razão social pelo CNPJ.
 *
 * O que estes testes guardam:
 * - o PAINEL manda: o nome que aparece no formulário é o do cadastro deles
 * - CNPJ que o painel não conhece cai na BrasilAPI — sem levar nosso token junto
 * - LIMITE de cota (403/429) NÃO é "não achei": retenta, e se a BrasilAPI não
 *   abrir, cai na reserva pública. Foi este o defeito relatado — "a razão social
 *   não está puxando do CNPJ" — quando o 403 por IP virava um null cacheado
 * - 404 é "não existe" de verdade: não retenta e não incomoda a reserva
 * - o cache guarda cada resposta pelo prazo que ela merece, e o do LIMITE é
 *   curto de propósito: senão um tropeço de segundos cala o campo pela sessão
 * - fonte fora do ar NUNCA derruba a tela: devolve null e o atendente digita
 * - CNPJ com dígito verificador errado não consulta ninguém (devolveria a
 *   empresa ERRADA no painel, e um pedido à toa por tecla digitada)
 * - o CNPJ inteiro não vai pro log — é dado de cliente
 */

const BASE = 'https://painel.exemplo';
const TOKEN = 'token-ext-agenda';
const RETAGUARDA = 'token-retaguarda';

/** CNPJ com dígitos verificadores válidos. */
const CNPJ = '11.222.333/0001-81';
const CNPJ_LIMPO = '11222333000181';

interface Chamada {
  url: string;
  auth: string | null;
}

/** Responde por URL; devolver `null` significa "esta fonte não deve ser chamada". */
type Responder = (url: string) => Response;

function montar(
  responder: Responder,
  options: { semRetaguarda?: boolean } = {}
): { painel: PainelClient; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    chamadas.push({ url: u, auth: headers.Authorization ?? null });
    // `then` pra que um `throw` do responder vire rejeição de rede de verdade.
    return Promise.resolve().then(() => responder(u));
  }) as typeof fetch;

  return {
    painel: new PainelClient({
      baseUrl: BASE,
      extAgendaToken: TOKEN,
      ...(options.semRetaguarda ? {} : { retaguardaToken: RETAGUARDA }),
      fetchImpl,
      timeoutMs: 50,
    }),
    chamadas,
  };
}

function ehPainel(url: string): boolean {
  return url.startsWith(BASE);
}

function ehBrasilApi(url: string): boolean {
  return url.startsWith(BRASILAPI_URL);
}

/** A reserva pública — só deve aparecer quando a BrasilAPI limitou. */
function ehCnpjWs(url: string): boolean {
  return url.startsWith(CNPJWS_URL);
}

/**
 * Cala e coleta TUDO que sai no log durante o teste. Serve pra duas coisas: não
 * sujar a saída da suíte e conferir que o CNPJ inteiro não vazou pra lá.
 */
function capturarLog(): { linhas: string[]; parar: () => void } {
  const linhas: string[] = [];
  const anotar = (linha?: unknown): void => void linhas.push(String(linha));
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(anotar),
    vi.spyOn(console, 'warn').mockImplementation(anotar),
    vi.spyOn(console, 'error').mockImplementation(anotar),
  ];
  return {
    linhas,
    parar: (): void => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe('dadosDoCnpj — o painel é a fonte que manda', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('com checklist no painel, usa o cadastro dele e nem chama a BrasilAPI', async () => {
    // O nome do cadastro é o que vai aparecer no registro da reunião: mostrar
    // outro no formulário faria o atendente "corrigir" pro nome errado.
    const { painel, chamadas } = montar((url) => {
      if (ehBrasilApi(url)) throw new Error('BrasilAPI não devia ser consultada');
      return jsonResponse({
        success: true,
        data: {
          found: true,
          razao_social: 'EMPRESA EXEMPLO LTDA',
          status: 'ativo',
          checklist: { instancia: true },
        },
      });
    });
    const log = capturarLog();

    const dados = await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(dados).toEqual({
      razaoSocial: 'EMPRESA EXEMPLO LTDA',
      fonte: 'painel',
      temChecklist: true,
    });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.auth).toBe(`Bearer ${RETAGUARDA}`);
  });

  it('sem checklist (404 found:false) cai na BrasilAPI — sem levar nosso token', async () => {
    // Prospect que ainda não virou checklist é o caso COMUM. E a BrasilAPI é
    // serviço de terceiro: mandar o Authorization do painel pra lá seria vazar
    // credencial compartilhada pra fora de casa.
    const { painel, chamadas } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      return jsonResponse({
        razao_social: 'PROSPECT EXEMPLO LTDA',
        nome_fantasia: 'Prospect',
        ddd_telefone_1: '(11) 3000-1000',
      });
    });
    const log = capturarLog();

    const dados = await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(dados).toEqual({
      razaoSocial: 'PROSPECT EXEMPLO LTDA',
      nomeFantasia: 'Prospect',
      // Telefone chega só com dígitos: o formulário aplica a máscara dele.
      telefone: '1130001000',
      fonte: 'brasilapi',
      // A Receita não sabe nada do nosso checklist — e sem checklist a migração
      // não pode ser marcada. A tela avisa ANTES do formulário inteiro.
      temChecklist: false,
    });
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]?.url).toBe(`${BRASILAPI_URL}/${CNPJ_LIMPO}`);
    expect(chamadas[1]?.auth).toBeNull();
  });

  it('404 com found:false não vira alarme de "confira PAINEL_API_URL"', async () => {
    // É a resposta NORMAL do /migracao/status pra CNPJ sem checklist, e ela vem
    // sem `error` no corpo. Tratar como rota inexistente mandaria a pessoa
    // mexer numa configuração que está certa — a cada prospect digitado.
    const { painel } = montar((url) =>
      ehPainel(url) ? jsonResponse({ found: false }, 404) : jsonResponse({ razao_social: 'X LTDA' })
    );
    const log = capturarLog();

    await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(log.linhas.filter((l) => l.includes('PAINEL_API_URL'))).toHaveLength(0);
    expect(log.linhas.filter((l) => l.includes('caminho/prefixo'))).toHaveLength(0);
  });

  it('as duas fontes fora do ar devolvem null, sem lançar', async () => {
    // Conveniência que quebra a tela é pior que campo vazio.
    const { painel, chamadas } = montar(() => {
      throw new Error('fetch failed');
    });
    const log = capturarLog();

    await expect(painel.dadosDoCnpj(CNPJ)).resolves.toBeNull();
    log.parar();

    expect(chamadas).toHaveLength(2);
  });

  it('CNPJ inválido devolve null sem consultar ninguém', async () => {
    // Dígito verificador errado no painel não devolve "não achei": devolve o
    // cadastro de OUTRA empresa.
    const { painel, chamadas } = montar(() => jsonResponse({ razao_social: 'ERRADA LTDA' }));

    expect(await painel.dadosDoCnpj('11.222.333/0001-82')).toBeNull();
    expect(await painel.dadosDoCnpj('112223330001')).toBeNull();
    expect(await painel.dadosDoCnpj('')).toBeNull();
    expect(chamadas).toHaveLength(0);
  });

  it('o cache evita a segunda consulta do mesmo CNPJ', async () => {
    // O campo dispara a cada digitação (máscara, colar, apagar e redigitar o
    // último dígito): sem cache, um preenchimento só viraria várias consultas.
    const { painel, chamadas } = montar(() =>
      jsonResponse({ data: { found: true, razao_social: 'EMPRESA EXEMPLO LTDA' } })
    );
    const log = capturarLog();

    const primeira = await painel.dadosDoCnpj(CNPJ);
    const segunda = await painel.dadosDoCnpj(CNPJ_LIMPO); // mesma empresa, sem máscara
    log.parar();

    expect(segunda).toEqual(primeira);
    expect(chamadas).toHaveLength(1);
  });

  it('sucesso dura um dia, mas não pra sempre: passado o dia, consulta de novo', async () => {
    // Razão social não muda entre a manhã e a tarde — guardar 24 h poupa uma
    // enxurrada de consultas. Mas ela MUDA (alteração contratual, checklist
    // criado depois), então o prazo tem fim.
    let razao = 'NOME ANTIGO LTDA';
    const { painel, chamadas } = montar(() =>
      jsonResponse({ data: { found: true, razao_social: razao } })
    );
    // Só o relógio é falso: o setTimeout do abort continua real, senão o
    // timeout da consulta nunca dispararia.
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = capturarLog();
    try {
      await painel.dadosDoCnpj(CNPJ);
      razao = 'NOME NOVO LTDA';
      // Dentro do dia continua o nome guardado, sem rede nenhuma.
      vi.setSystemTime(new Date(Date.now() + 23 * 60 * 60 * 1000));
      expect((await painel.dadosDoCnpj(CNPJ))?.razaoSocial).toBe('NOME ANTIGO LTDA');
      expect(chamadas).toHaveLength(1);

      vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
      const depois = await painel.dadosDoCnpj(CNPJ);

      expect(depois?.razaoSocial).toBe('NOME NOVO LTDA');
      expect(chamadas).toHaveLength(2);
    } finally {
      log.parar();
      vi.useRealTimers();
    }
  });

  it('falha não fica uma hora no cache: em um minuto já tenta de novo', async () => {
    // "Não achei" e "fonte fora do ar" chegam iguais aqui, e nenhum dos dois
    // merece uma hora de silêncio — o painel volta, o checklist é criado.
    let fora = true;
    const { painel, chamadas } = montar((url) => {
      if (fora) throw new Error('fetch failed');
      if (ehPainel(url)) return jsonResponse({ data: { found: true, razao_social: 'VOLTOU LTDA' } });
      throw new Error('BrasilAPI não devia ser consultada');
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = capturarLog();
    try {
      expect(await painel.dadosDoCnpj(CNPJ)).toBeNull();
      // Ainda dentro do minuto: nada de rede.
      expect(await painel.dadosDoCnpj(CNPJ)).toBeNull();
      expect(chamadas).toHaveLength(2); // painel + BrasilAPI da PRIMEIRA tentativa

      fora = false;
      vi.setSystemTime(new Date(Date.now() + 61_000));
      expect(await painel.dadosDoCnpj(CNPJ)).toMatchObject({ razaoSocial: 'VOLTOU LTDA' });
    } finally {
      log.parar();
      vi.useRealTimers();
    }
  });

  it('403 é LIMITE, não "não achei": a retentativa traz a razão social', async () => {
    // ESTE É O DEFEITO RELATADO. A BrasilAPI limita POR IP e responde 403 — o
    // escritório inteiro sai por um IP só. O código antigo lia qualquer resposta
    // não-ok como "não achei", guardava o null no cache e o campo nunca mais
    // preenchia. A tentativa seguinte, segundos depois, responde 200.
    let tentativas = 0;
    const { painel, chamadas } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      if (ehCnpjWs(url)) throw new Error('a reserva não devia entrar: a BrasilAPI voltou');
      tentativas += 1;
      if (tentativas === 1) return jsonResponse({ message: 'rate limit' }, 403);
      return jsonResponse({ razao_social: 'VOLTOU DEPOIS DO 403 LTDA' });
    });
    const log = capturarLog();

    const dados = await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(dados).toMatchObject({ razaoSocial: 'VOLTOU DEPOIS DO 403 LTDA', fonte: 'brasilapi' });
    expect(tentativas).toBe(2);
    // painel + as duas na BrasilAPI. A reserva nem foi acionada.
    expect(chamadas).toHaveLength(3);
  });

  it('429 também é limite e também ganha retentativa', async () => {
    let tentativas = 0;
    const { painel } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      if (ehCnpjWs(url)) throw new Error('a reserva não devia entrar: a BrasilAPI voltou');
      tentativas += 1;
      if (tentativas === 1) return jsonResponse({ message: 'too many requests' }, 429);
      return jsonResponse({ razao_social: 'VOLTOU DEPOIS DO 429 LTDA' });
    });
    const log = capturarLog();

    const dados = await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(dados).toMatchObject({ razaoSocial: 'VOLTOU DEPOIS DO 429 LTDA' });
    expect(tentativas).toBe(2);
  });

  it('404 é "não existe": não retenta e não incomoda a reserva', async () => {
    // Insistir num "não" que já veio só faz o atendente esperar à toa.
    let tentativas = 0;
    const { painel, chamadas } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      if (ehCnpjWs(url)) throw new Error('a reserva não devia entrar num 404');
      tentativas += 1;
      return jsonResponse({ message: 'CNPJ inválido ou não encontrado' }, 404);
    });
    const log = capturarLog();

    expect(await painel.dadosDoCnpj(CNPJ)).toBeNull();
    log.parar();

    expect(tentativas).toBe(1);
    expect(chamadas).toHaveLength(2);
  });

  it('BrasilAPI limitada até o fim: a reserva pública preenche, e sem nosso token', async () => {
    // As duas contam cota por IP em janelas diferentes — é essa a aposta da
    // reserva. E ela é OUTRO host: mandar o Authorization do painel pra lá seria
    // vazar credencial compartilhada pra fora de casa.
    let brasil = 0;
    const { painel, chamadas } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      if (ehCnpjWs(url)) {
        return jsonResponse({
          razao_social: 'RESERVA EXEMPLO LTDA',
          // A forma da cnpj.ws é outra: o resto mora em `estabelecimento` e o
          // telefone vem partido em DDD e número.
          estabelecimento: { nome_fantasia: 'Reserva', ddd1: '11', telefone1: '30001000' },
        });
      }
      brasil += 1;
      return jsonResponse({ message: 'rate limit' }, 403);
    });
    const log = capturarLog();

    const dados = await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(dados).toEqual({
      razaoSocial: 'RESERVA EXEMPLO LTDA',
      nomeFantasia: 'Reserva',
      telefone: '1130001000',
      fonte: 'brasilapi',
      temChecklist: false,
    });
    // A tentativa original mais as duas retentativas.
    expect(brasil).toBe(3);
    const reserva = chamadas.find((c) => ehCnpjWs(c.url));
    expect(reserva?.url).toBe(`${CNPJWS_URL}/${CNPJ_LIMPO}`);
    expect(reserva?.auth).toBeNull();
  });

  it('as duas fontes públicas fora devolvem null, sem lançar', async () => {
    // Conveniência que quebra a tela é pior que campo vazio: o atendente digita.
    let brasil = 0;
    let reserva = 0;
    const { painel } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      if (ehCnpjWs(url)) {
        reserva += 1;
        throw new Error('fetch failed');
      }
      brasil += 1;
      return jsonResponse({ message: 'rate limit' }, 403);
    });
    const log = capturarLog();

    await expect(painel.dadosDoCnpj(CNPJ)).resolves.toBeNull();
    log.parar();

    expect(brasil).toBe(3);
    expect(reserva).toBe(1);
  });

  it('o limite fica pouco no cache: em 30 s a digitação seguinte tenta de novo', async () => {
    // Guardar "estou limitado" por muito tempo é o que transforma um tropeço de
    // segundos numa falha que dura a sessão inteira — exatamente o sintoma
    // relatado. Trinta segundos seguram a enxurrada de teclas e liberam a
    // próxima tentativa.
    let limitado = true;
    const { painel, chamadas } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      if (limitado) return jsonResponse({ message: 'rate limit' }, 403);
      if (ehCnpjWs(url)) throw new Error('a reserva não devia entrar: a BrasilAPI voltou');
      return jsonResponse({ razao_social: 'DESTRAVOU LTDA' });
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = capturarLog();
    try {
      expect(await painel.dadosDoCnpj(CNPJ)).toBeNull();
      const gastas = chamadas.length;
      // Ainda dentro dos 30 s: nada de rede.
      expect(await painel.dadosDoCnpj(CNPJ)).toBeNull();
      expect(chamadas).toHaveLength(gastas);

      limitado = false;
      vi.setSystemTime(new Date(Date.now() + 31_000));
      expect(await painel.dadosDoCnpj(CNPJ)).toMatchObject({ razaoSocial: 'DESTRAVOU LTDA' });
    } finally {
      log.parar();
      vi.useRealTimers();
    }
  });

  it('"não existe" fica MAIS tempo guardado que o limite', async () => {
    // A distinção só vale a pena se os prazos forem mesmo diferentes: 404 é
    // resposta firme e não merece nova consulta a cada meio minuto.
    let consultas = 0;
    const { painel } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      consultas += 1;
      return jsonResponse({ message: 'não encontrado' }, 404);
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = capturarLog();
    try {
      expect(await painel.dadosDoCnpj(CNPJ)).toBeNull();
      expect(consultas).toBe(1);

      // Onde o limite já teria tentado de novo, o 404 continua calado.
      vi.setSystemTime(new Date(Date.now() + 31_000));
      expect(await painel.dadosDoCnpj(CNPJ)).toBeNull();
      expect(consultas).toBe(1);
    } finally {
      log.parar();
      vi.useRealTimers();
    }
  });

  it('a razão social não vai pro log — é dado de cliente igual ao CNPJ', async () => {
    const { painel } = montar(() =>
      jsonResponse({ data: { found: true, razao_social: 'EMPRESA SIGILOSA LTDA' } })
    );
    const log = capturarLog();

    await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(log.linhas.join('\n')).not.toContain('EMPRESA SIGILOSA');
  });

  it('sem token de retaguarda ainda preenche pela BrasilAPI, sem checklist', async () => {
    // Instalação que não recebeu o token de retaguarda continua com o campo
    // funcionando — só não sabe dizer nada sobre checklist.
    const { painel, chamadas } = montar(
      (url) => {
        if (ehPainel(url)) throw new Error('painel não devia ser consultado sem token');
        return jsonResponse({ razao_social: 'SEM RETAGUARDA LTDA' });
      },
      { semRetaguarda: true }
    );
    const log = capturarLog();

    const dados = await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(dados).toMatchObject({ fonte: 'brasilapi', temChecklist: false });
    expect(chamadas).toHaveLength(1);
  });

  it('o log leva só os 4 últimos dígitos — CNPJ inteiro é dado de cliente', async () => {
    // Erro de rede costuma trazer a URL que falhou — e a URL da BrasilAPI tem o
    // CNPJ inteiro dentro. É por esse caminho que ele vazaria pro arquivo de log.
    const { painel } = montar((url) => {
      if (ehPainel(url)) return jsonResponse({ found: false }, 404);
      throw new Error(`fetch failed: ${BRASILAPI_URL}/${CNPJ_LIMPO}`);
    });
    const log = capturarLog();

    await painel.dadosDoCnpj(CNPJ);
    log.parar();

    expect(log.linhas.length).toBeGreaterThan(0);
    const tudo = log.linhas.join('\n');
    expect(tudo).not.toContain(CNPJ_LIMPO);
    expect(tudo).not.toContain(CNPJ);
    expect(tudo).toContain('0181');
  });
});

describe('GET /api/painel/cnpj', () => {
  const servidores: Server[] = [];
  afterEach(() => {
    for (const s of servidores.splice(0)) s.close();
    vi.restoreAllMocks();
  });

  async function subir(painel: PainelClient): Promise<string> {
    const app = express();
    app.use(createPainelInternoRouter({ painel, db: new Db(":memory:") }));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    servidores.push(server);
    const addr = server.address();
    const porta = typeof addr === 'object' && addr ? addr.port : 0;
    return `http://127.0.0.1:${porta}`;
  }

  it('repassa a razão social encontrada', async () => {
    const { painel } = montar(() =>
      jsonResponse({ data: { found: true, razao_social: 'EMPRESA EXEMPLO LTDA' } })
    );
    const base = await subir(painel);
    const log = capturarLog();

    const resposta = await fetch(`${base}/api/painel/cnpj?cnpj=${encodeURIComponent(CNPJ)}`);
    const corpo = (await resposta.json()) as Record<string, unknown>;
    log.parar();

    expect(resposta.status).toBe(200);
    expect(corpo).toMatchObject({
      encontrado: true,
      cnpjValido: true,
      dados: { razaoSocial: 'EMPRESA EXEMPLO LTDA', fonte: 'painel', temChecklist: true },
    });
  });

  it('fonte fora do ar responde 200 com encontrado:false — nunca 404', async () => {
    // Pra tela, "não achei" e "painel fora do ar" terminam igual: a pessoa
    // digita o nome na mão. Um 404 viraria erro vermelho no meio da digitação.
    const { painel } = montar(() => {
      throw new Error('fetch failed');
    });
    const base = await subir(painel);
    const log = capturarLog();

    const resposta = await fetch(`${base}/api/painel/cnpj?cnpj=${CNPJ_LIMPO}`);
    const corpo = (await resposta.json()) as Record<string, unknown>;
    log.parar();

    expect(resposta.status).toBe(200);
    expect(corpo).toEqual({ encontrado: false, dados: null, cnpjValido: true });
  });

  it('CNPJ incompleto não é erro: 200 com cnpjValido:false e ninguém consultado', async () => {
    // A tela consulta enquanto a pessoa digita; responder 400 encheria o campo
    // de vermelho antes de ela terminar.
    const { painel, chamadas } = montar(() => jsonResponse({}));
    const base = await subir(painel);

    const resposta = await fetch(`${base}/api/painel/cnpj?cnpj=112223330`);
    const corpo = (await resposta.json()) as Record<string, unknown>;

    expect(resposta.status).toBe(200);
    expect(corpo).toEqual({ encontrado: false, dados: null, cnpjValido: false });
    expect(chamadas).toHaveLength(0);
  });
});
