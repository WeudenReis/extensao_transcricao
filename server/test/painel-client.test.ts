import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
  PainelClient,
  PainelError,
  censurar,
  validarCnpj,
  normalizarCnpj,
  ehTipoReuniao,
} from '../src/painel/client.js';
import { createPainelInternoRouter } from '../src/routes/painelInterno.js';
import { jsonResponse } from './helpers.js';

/**
 * Cliente do painel de reuniões — a plataforma que manda no agendamento.
 *
 * O que estes testes guardam:
 * - LEITURA nunca derruba o atendimento (painel fora do ar → null/[], sem lançar)
 * - ESCRITA lança, porque "marquei" sem ter marcado é pior que um erro na tela
 * - os dois tokens não se misturam (trocar um pelo outro dá 401 em produção)
 * - data e hora vão separadas e locais, nunca um instante UTC
 */

const BASE = 'https://painel.exemplo';
const TOKEN = 'token-ext-agenda';
const RETAGUARDA = 'token-retaguarda';
const EMAIL = 'vendedor@empresa.com';

interface Chamada {
  url: string;
  metodo: string;
  auth: string | null;
  corpo: unknown;
}

function montar(
  responder: (url: string) => Response,
  options: { semRetaguarda?: boolean; semToken?: boolean } = {}
): { painel: PainelClient; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    chamadas.push({
      url: u,
      metodo: init?.method ?? 'GET',
      auth: headers.Authorization ?? null,
      corpo: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(responder(u));
  }) as typeof fetch;

  return {
    painel: new PainelClient({
      baseUrl: BASE,
      extAgendaToken: options.semToken ? undefined : TOKEN,
      ...(options.semRetaguarda ? {} : { retaguardaToken: RETAGUARDA }),
      fetchImpl,
      timeoutMs: 50,
    }),
    chamadas,
  };
}

/**
 * A resposta que quebrou a configuração de verdade: app.chatpro.com.br devolve
 * 200 com o HTML do SPA para QUALQUER caminho, inclusive /api/naoexiste-xyz.
 */
function htmlResponse(status = 200): Response {
  return new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Captura o console.error sem sujar a saída da suíte. */
function capturarErros(): { linhas: string[]; parar: () => void } {
  const linhas: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((linha?: unknown) => {
    linhas.push(String(linha));
  });
  return { linhas, parar: (): void => void spy.mockRestore() };
}

/** Mesma ideia pro console.warn — é por ele que sai corpo de erro do painel. */
function capturarAvisos(): { linhas: string[]; parar: () => void } {
  const linhas: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((linha?: unknown) => {
    linhas.push(String(linha));
  });
  return { linhas, parar: (): void => void spy.mockRestore() };
}

describe('validação de CNPJ', () => {
  it('aceita CNPJ real, com e sem máscara', () => {
    expect(validarCnpj('11.222.333/0001-81')).toBe(true);
    expect(validarCnpj('11222333000181')).toBe(true);
  });

  it('recusa dígito verificador errado', () => {
    // Um dígito trocado não devolve "não achei" no painel: devolve o
    // checklist de OUTRA empresa. Por isso a checagem é dos verificadores,
    // não do tamanho.
    expect(validarCnpj('11.222.333/0001-82')).toBe(false);
  });

  it('recusa tamanho errado e todos os dígitos iguais', () => {
    expect(validarCnpj('112223330001')).toBe(false);
    expect(validarCnpj('11111111111111')).toBe(false);
    expect(validarCnpj('')).toBe(false);
  });

  it('normaliza tirando a máscara', () => {
    expect(normalizarCnpj('11.222.333/0001-81')).toBe('11222333000181');
  });
});

describe('tipos de reunião', () => {
  it('reconhece os quatro do time comercial e recusa o resto', () => {
    for (const t of ['apresentacao', 'migracao', 'implantacao', 'cs']) {
      expect(ehTipoReuniao(t)).toBe(true);
    }
    expect(ehTipoReuniao('suporte')).toBe(false);
    expect(ehTipoReuniao(null)).toBe(false);
  });
});

describe('cliente desligado', () => {
  it('sem URL nem token, leitura devolve vazio e não chama ninguém', async () => {
    const painel = new PainelClient({ baseUrl: undefined, extAgendaToken: undefined });

    expect(painel.estaConfigurado()).toBe(false);
    expect(await painel.me(EMAIL)).toBeNull();
    expect(await painel.vendedores()).toEqual([]);
    expect(await painel.horarios({ tipo: 'apresentacao', data: '2026-08-20', actorEmail: EMAIL })).toBeNull();
  });

  it('criar reunião com o painel desligado LANÇA — não dá pra fingir que marcou', async () => {
    const painel = new PainelClient({ baseUrl: undefined, extAgendaToken: undefined });
    await expect(
      painel.criarReuniao({
        type: 'apresentacao',
        actorEmail: EMAIL,
        clientName: 'Cliente',
        companyName: 'Empresa',
        phone: '(11) 90000-0000',
        clientType: 'prospect',
        scheduledDate: '2026-08-20',
        scheduledTime: '14:00',
      })
    ).rejects.toBeInstanceOf(PainelError);
  });
});

describe('GET /me', () => {
  it('lê identidade e capacidades, e manda o token de agenda', async () => {
    const { painel, chamadas } = montar(() =>
      jsonResponse({
        identity_source: 'email',
        user: { email: EMAIL, name: 'Ana Vendedora', role: 'vendedor' },
        capabilities: [
          { type: 'apresentacao', allowed: true, assignment: 'self', can_choose_assignee: false },
          { type: 'implantacao', allowed: true, assignment: 'round_robin', can_choose_assignee: false },
          { type: 'cs', allowed: false, assignment: 'round_robin', can_choose_assignee: false },
        ],
      })
    );

    const eu = await painel.me(EMAIL);

    expect(eu).toMatchObject({ email: EMAIL, nome: 'Ana Vendedora', papel: 'vendedor' });
    expect(eu?.identitySource).toBe('email');
    expect(eu?.capacidades).toHaveLength(3);
    expect(eu?.capacidades[0]).toMatchObject({ type: 'apresentacao', allowed: true, assignment: 'self' });
    expect(chamadas[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(chamadas[0]?.url).toContain(`actor_email=${encodeURIComponent(EMAIL)}`);
  });

  it('422 (e-mail não é usuário ativo) vira null sem lançar', async () => {
    const { painel } = montar(() => jsonResponse({ error: 'usuário não encontrado' }, 422));
    expect(await painel.me('ninguem@exemplo.com')).toBeNull();
  });

  it('capacidade com tipo desconhecido é ignorada', async () => {
    const { painel } = montar(() =>
      jsonResponse({
        capabilities: [
          { type: 'suporte_n3', allowed: true, assignment: 'self' },
          { type: 'cs', allowed: true, assignment: 'self' },
        ],
      })
    );
    const eu = await painel.me(EMAIL);
    expect(eu?.capacidades.map((c) => c.type)).toEqual(['cs']);
  });
});

describe('GET available-slots', () => {
  it('lê a grade e o teto de data', async () => {
    const { painel } = montar(() =>
      jsonResponse({
        available_slots: ['09:00', '09:30', '14:00'],
        blocked_slots: ['10:00'],
        max_date: '2026-09-30',
      })
    );

    const grade = await painel.horarios({
      tipo: 'apresentacao',
      data: '2026-08-20',
      actorEmail: EMAIL,
    });

    expect(grade?.disponiveis).toEqual(['09:00', '09:30', '14:00']);
    expect(grade?.bloqueados).toEqual(['10:00']);
    expect(grade?.maxDate).toBe('2026-09-30');
  });

  it('migração manda client_type — sem ele a API devolve a grade da outra fila', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ available_slots: [] }));

    await painel.horarios({
      tipo: 'migracao',
      data: '2026-08-20',
      actorEmail: EMAIL,
      clientType: 'base',
    });

    expect(chamadas[0]?.url).toContain('client_type=base');
  });

  it('os outros tipos TAMBÉM mandam client_type quando a aba sabe qual é', async () => {
    // A grade consultada tem que ser a MESMA fila em que a reunião vai ser
    // criada. Base e prospect são pools distintos por contrato; hoje as duas
    // grades vêm iguais (medido em produção), mas consultar um pool e marcar no
    // outro faria a pessoa escolher um horário "livre" e levar 409 no fim.
    //
    // A API aceita o parâmetro nos quatro tipos — também medido.
    const { painel, chamadas } = montar(() => jsonResponse({ available_slots: [] }));
    await painel.horarios({
      tipo: 'implantacao',
      data: '2026-08-20',
      actorEmail: EMAIL,
      clientType: 'base',
    });
    expect(chamadas[0]?.url).toContain('client_type=base');
  });

  it('sem clientType, o parâmetro não vai — quem exige é só a migração', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ available_slots: [] }));
    await painel.horarios({ tipo: 'apresentacao', data: '2026-08-20', actorEmail: EMAIL });
    expect(chamadas[0]?.url).not.toContain('client_type');
  });

  it('lista vazia NÃO é erro — é feriado, fim de semana ou lotação', async () => {
    const { painel } = montar(() => jsonResponse({ available_slots: [], blocked_slots: [] }));
    const grade = await painel.horarios({ tipo: 'cs', data: '2026-08-20', actorEmail: EMAIL });
    expect(grade).not.toBeNull();
    expect(grade?.disponiveis).toEqual([]);
  });

  it('painel fora do ar devolve null — a tela mostra "sem horário", não quebra', async () => {
    const { painel } = montar(() => jsonResponse({ error: 'indisponível' }, 503));
    expect(await painel.horarios({ tipo: 'cs', data: '2026-08-20', actorEmail: EMAIL })).toBeNull();
  });
});

describe('POST /meetings', () => {
  const dados = {
    type: 'implantacao' as const,
    actorEmail: EMAIL,
    clientName: 'Maria Souza',
    companyName: 'Souza Ltda',
    phone: '(11) 98888-7777',
    clientType: 'prospect' as const,
    provedor: 'starter',
    cnpj: '11.222.333/0001-81',
    instanceCode: 'chatpro-teste01',
    scheduledDate: '2026-08-20',
    scheduledTime: '14:00',
  };

  it('devolve id, link do Meet e quem ficou responsável', async () => {
    const { painel, chamadas } = montar(() =>
      jsonResponse(
        {
          id: 'reuniao-do-painel-1',
          meet_link: 'https://meet.google.com/abc-defg-hij',
          assignment_mode: 'round_robin',
          responsavel: { email: 'implantador@empresa.com', name: 'Bruno Implantador' },
        },
        201
      )
    );

    const criada = await painel.criarReuniao(dados);

    expect(criada).toMatchObject({
      id: 'reuniao-do-painel-1',
      meetLink: 'https://meet.google.com/abc-defg-hij',
      responsavelEmail: 'implantador@empresa.com',
      responsavelNome: 'Bruno Implantador',
      assignmentMode: 'round_robin',
    });
    expect(chamadas[0]?.metodo).toBe('POST');
    expect(chamadas[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('data e hora vão SEPARADAS e locais — nunca um instante UTC', async () => {
    // Mandar scheduled_at de um navegador em outro fuso marcaria a reunião na
    // hora errada. O painel deriva o UTC a partir do horário local BR.
    const { painel, chamadas } = montar(() => jsonResponse({ id: 'x', meet_link: 'l' }, 201));
    await painel.criarReuniao(dados);

    const corpo = chamadas[0]?.corpo as Record<string, unknown>;
    expect(corpo.scheduled_date).toBe('2026-08-20');
    expect(corpo.scheduled_time).toBe('14:00');
    expect(corpo).not.toHaveProperty('scheduled_at');
  });

  it('campo opcional vazio não vai no corpo', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ id: 'x', meet_link: 'l' }, 201));
    await painel.criarReuniao({ ...dados, vendedorEmail: '', assigneeEmail: undefined });

    const corpo = chamadas[0]?.corpo as Record<string, unknown>;
    expect(corpo).not.toHaveProperty('vendedor_email');
    expect(corpo).not.toHaveProperty('assignee_email');
    expect(corpo.provedor).toBe('starter');
  });

  it('409 (horário ocupado) lança carregando o status — a tela recarrega a grade', async () => {
    const { painel } = montar(() => jsonResponse({ error: 'horário ocupado' }, 409));

    await expect(painel.criarReuniao(dados)).rejects.toMatchObject({
      name: 'PainelError',
      status: 409,
      message: 'horário ocupado',
    });
  });

  it('403 (papel sem direito) lança com a mensagem do painel', async () => {
    const { painel } = montar(() => jsonResponse({ error: 'implantador não vende' }, 403));
    await expect(painel.criarReuniao({ ...dados, type: 'apresentacao' })).rejects.toMatchObject({
      status: 403,
      message: 'implantador não vende',
    });
  });

  it('201 sem id LANÇA — a reunião foi criada e não dá pra mandar a transcrição', async () => {
    // Repetir o POST aqui criaria reunião duplicada; melhor gritar.
    const { painel } = montar(() => jsonResponse({ meet_link: 'https://meet.google.com/a-b-c' }, 201));
    await expect(painel.criarReuniao(dados)).rejects.toMatchObject({ name: 'PainelError' });
  });
});

/**
 * O POST /transcript não tem Idempotency-Key: repetir cria um SEGUNDO registro
 * da mesma transcrição no painel. Por isso o retorno não é um booleano — quem
 * chama precisa distinguir "o painel disse não" (reenviar é seguro) de "não sei
 * se chegou" (reenviar duplica dado sensível de cliente).
 */
describe('POST transcript', () => {
  it('sobe a transcrição pro painel e responde ENVIADO', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ ok: true }));

    const r = await painel.enviarTranscricao({
      meetingId: 'reuniao-1',
      actorEmail: EMAIL,
      texto: 'Vendedor: bom dia\n\nCliente: bom dia',
    });

    expect(r).toEqual({ estado: 'enviado' });
    expect(chamadas[0]?.url).toContain('/api/ext/agenda/meetings/reuniao-1/transcript');
    expect(chamadas[0]?.corpo).toMatchObject({ actor_email: EMAIL, language_code: 'pt-BR' });
  });

  it('4xx do painel é RECUSADO: ele respondeu dizendo não, então nada foi salvo', async () => {
    const { painel } = montar(() => jsonResponse({ error: 'actor_email inválido' }, 422));
    const r = await painel.enviarTranscricao({
      meetingId: 'reuniao-1',
      actorEmail: EMAIL,
      texto: 'algo',
    });
    expect(r.estado).toBe('recusado');
  });

  it('5xx é INCERTO — o painel pode ter salvo antes de a resposta se perder', async () => {
    const { linhas, parar } = capturarErros();
    const { painel } = montar(() => jsonResponse({ error: 'nope' }, 500));
    const r = await painel.enviarTranscricao({
      meetingId: 'reuniao-1',
      actorEmail: EMAIL,
      texto: 'algo',
    });
    parar();
    expect(r.estado).toBe('incerto');
    // O log tem que dizer o que fazer: quem lê isso decide se reenvia.
    expect(linhas.join(' ')).toContain('não reenvie sem conferir');
  });

  it('timeout é INCERTO, nunca lança — a fila do Recall não pode cair', async () => {
    const { linhas, parar } = capturarErros();
    // Nunca responde: quem encerra é o AbortController do próprio cliente, do
    // mesmo jeito que aconteceu em produção com os 15 s estourados.
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const painel = new PainelClient({
      baseUrl: BASE,
      extAgendaToken: TOKEN,
      fetchImpl,
      timeoutMs: 20,
    });

    const r = await painel.enviarTranscricao({
      meetingId: 'reuniao-1',
      actorEmail: EMAIL,
      texto: 'algo',
    });
    parar();

    expect(r.estado).toBe('incerto');
    expect(linhas.join(' ')).toContain('INCERTO');
  });

  it('sem painel configurado é RECUSADO: nada chegou a sair daqui', async () => {
    const painel = new PainelClient({ baseUrl: undefined, extAgendaToken: undefined });
    const r = await painel.enviarTranscricao({
      meetingId: 'reuniao-1',
      actorEmail: EMAIL,
      texto: 'algo',
    });
    expect(r).toMatchObject({ estado: 'recusado' });
  });
});

describe('retaguarda', () => {
  it('vendedores usam o token DE RETAGUARDA, não o de agenda', async () => {
    // Trocar um pelo outro dá 401 em produção — é o tipo de erro que só
    // aparece no ambiente real, então o teste segura aqui.
    const { painel, chamadas } = montar(() =>
      jsonResponse([{ email: 'v1@empresa.com', name: 'Vendedor Um' }])
    );

    const lista = await painel.vendedores();

    expect(lista).toEqual([{ email: 'v1@empresa.com', nome: 'Vendedor Um' }]);
    expect(chamadas[0]?.auth).toBe(`Bearer ${RETAGUARDA}`);
  });

  it('sem token de retaguarda a lista vem vazia e ninguém é chamado', async () => {
    const { painel, chamadas } = montar(() => jsonResponse([]), { semRetaguarda: true });
    expect(await painel.vendedores()).toEqual([]);
    expect(chamadas).toHaveLength(0);
  });

  it('status de migração exige CNPJ válido antes de consultar', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ status: 'ativo' }));

    expect(await painel.statusMigracao('11.222.333/0001-82')).toBeNull();
    expect(chamadas).toHaveLength(0);

    const r = await painel.statusMigracao('11.222.333/0001-81');
    expect(r).toMatchObject({ status: 'ativo' });
    expect(chamadas[0]?.url).toContain('cnpj=11222333000181');
  });
});

/**
 * "Painel fora do ar" e "PAINEL_API_URL aponta pro site" chegavam na tela com o
 * MESMO sintoma: tudo vazio. O caso real: https://app.chatpro.com.br devolve o
 * SPA (200, text/html) pra qualquer caminho, o .json() estourava e o log dizia
 * só "falha em me: ..." — escondendo a única coisa que a pessoa precisava
 * saber, que era o endereço.
 */
describe('URL apontando pra um site em vez da API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('200 com HTML vira erro de CONFIGURAÇÃO com o endereço na mensagem', async () => {
    const { painel } = montar(() => htmlResponse());
    const log = capturarErros();

    expect(await painel.me(EMAIL)).toBeNull();
    log.parar();

    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]).toContain('PAINEL_API_URL');
    expect(log.linhas[0]).toContain('text/html');
    expect(log.linhas[0]).toContain('/api/ext/agenda/me');
    // O caminho vai sem query: o e-mail do atendente não tem por que ir pro log.
    expect(log.linhas[0]).not.toContain('actor_email');
  });

  it('avisa UMA vez por operação, não a cada chamada', async () => {
    // Uma aba aberta repete /me e /available-slots o tempo todo; sem a trava o
    // log viraria a mesma linha dezenas de vezes por minuto.
    const { painel } = montar(() => htmlResponse());
    const log = capturarErros();

    await painel.me(EMAIL);
    await painel.me(EMAIL);
    await painel.me(EMAIL);
    await painel.horarios({ tipo: 'cs', data: '2026-08-20', actorEmail: EMAIL });
    await painel.horarios({ tipo: 'cs', data: '2026-08-21', actorEmail: EMAIL });
    log.parar();

    expect(log.linhas).toHaveLength(2);
    expect(log.linhas[0]).toContain('me');
    expect(log.linhas[1]).toContain('available-slots');
  });

  it('volta a avisar depois de um minuto — quem abre o log agora tem que ver', async () => {
    // Só o relógio é falso: o setTimeout do abort continua real, senão o
    // timeout do pedir() nunca dispararia.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { painel } = montar(() => htmlResponse());
      const log = capturarErros();

      await painel.me(EMAIL);
      vi.setSystemTime(new Date(Date.now() + 61_000));
      await painel.me(EMAIL);
      log.parar();

      expect(log.linhas).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('404 SEM corpo do painel é rota errada, NÃO página web', async () => {
    // Sem `error` no corpo é o 404 do framework: existe API no endereço, mas a
    // rota não é essa. Falar em "página web" mandaria consertar o que está bom.
    const { painel } = montar(() => jsonResponse({ mensagem: 'nada aqui' }, 404));
    const log = capturarErros();

    expect(await painel.me(EMAIL)).toBeNull();
    log.parar();

    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]).toContain('404');
    expect(log.linhas[0]).toContain('caminho/prefixo');
    expect(log.linhas[0]).not.toContain('página web');
  });

  it('404 COM erro do painel é resposta de negócio, não erro de configuração', async () => {
    // O contrato documenta 404 como resposta NORMAL em
    // GET /api/retaguarda/migracao/status: "não existe checklist para esse
    // CNPJ". Tratar isso como URL errada faria todo CNPJ sem checklist virar um
    // alarme pedindo pra mexer numa configuração que está certa.
    const { painel } = montar(() => jsonResponse({ error: 'checklist não encontrado' }, 404));
    const log = capturarErros();

    expect(await painel.statusMigracao('11.222.333/0001-81')).toBeNull();
    log.parar();

    expect(log.linhas).toHaveLength(0);
  });

  it('POST /meetings com HTML LANÇA falando da URL — a reunião não foi criada', async () => {
    // O pior cenário: 200 com HTML PARECE sucesso. Repetir o POST não resolve
    // enquanto o endereço estiver errado, então a mensagem é sobre o endereço.
    const { painel } = montar(() => htmlResponse());
    const log = capturarErros();

    await expect(
      painel.criarReuniao({
        type: 'apresentacao',
        actorEmail: EMAIL,
        clientName: 'Cliente',
        companyName: 'Empresa',
        phone: '(11) 90000-0000',
        clientType: 'prospect',
        scheduledDate: '2026-08-20',
        scheduledTime: '14:00',
      })
    ).rejects.toMatchObject({
      name: 'PainelError',
      message: expect.stringContaining('PAINEL_API_URL') as unknown as string,
    });
    log.parar();

    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]).toContain('/api/ext/agenda/meetings');
  });
});

describe('diagnosticar()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sem PAINEL_API_URL responde sem chamar ninguém', async () => {
    const painel = new PainelClient({ baseUrl: undefined, extAgendaToken: undefined });
    expect(await painel.diagnosticar(EMAIL)).toMatchObject({ ok: false, problema: 'sem-url' });
  });

  it('healthcheck devolvendo HTML acusa o endereço e nem tenta o /me', async () => {
    const { painel, chamadas } = montar(() => htmlResponse());

    const d = await painel.diagnosticar(EMAIL);

    expect(d).toMatchObject({ ok: false, problema: 'html-em-vez-de-json' });
    expect(d.detalhe).toContain('PAINEL_API_URL');
    // Parou no primeiro passo: sem API não faz sentido testar token nem e-mail.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.url).toContain('/api/healthcheck');
  });

  it('healthcheck 404 sem corpo do painel é rota inexistente, não site', async () => {
    const { painel } = montar(() => jsonResponse({ mensagem: 'nada' }, 404));
    const d = await painel.diagnosticar(EMAIL);
    expect(d).toMatchObject({ ok: false, problema: 'rota-inexistente' });
    expect(d.detalhe).toContain('/api/healthcheck');
  });

  it('401 no /me aponta o token de agenda — e lembra que o de retaguarda não vale', async () => {
    const { painel } = montar((url) =>
      url.includes('/healthcheck') ? jsonResponse({ ok: true }) : jsonResponse({ error: 'unauthorized' }, 401)
    );

    const d = await painel.diagnosticar(EMAIL);

    expect(d).toMatchObject({ ok: false, problema: 'token-invalido' });
    expect(d.detalhe).toContain('PAINEL_EXT_AGENDA_TOKEN');
    // Nunca, em hipótese alguma, o valor do token no diagnóstico.
    expect(d.detalhe).not.toContain(TOKEN);
  });

  it('422 no /me é usuário desconhecido — o painel está bom, o e-mail que não', async () => {
    const { painel } = montar((url) =>
      url.includes('/healthcheck')
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: 'usuário não encontrado' }, 422)
    );

    const d = await painel.diagnosticar('ninguem@exemplo.com');

    expect(d).toMatchObject({ ok: false, problema: 'usuario-desconhecido' });
    expect(d.detalhe).toContain('ninguem@exemplo.com');
    expect(d.detalhe).toContain('usuário não encontrado');
  });

  it('painel que não responde vira nao-alcancavel, não "URL errada"', async () => {
    // Timeout: a conexão é aceita e ninguém responde (firewall dropando,
    // serviço travado). Culpar a URL aqui mandaria pro conserto errado.
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolver, rejeitar) => {
        init?.signal?.addEventListener('abort', () => rejeitar(new Error('abortado')));
      })) as typeof fetch;
    const painel = new PainelClient({
      baseUrl: BASE,
      extAgendaToken: TOKEN,
      fetchImpl,
      timeoutMs: 30,
    });

    const d = await painel.diagnosticar(EMAIL);

    expect(d).toMatchObject({ ok: false, problema: 'nao-alcancavel' });
    expect(d.detalhe).toContain('/api/healthcheck');
  });

  it('healthcheck 503 é painel fora do ar', async () => {
    const { painel } = montar(() => jsonResponse({ error: 'manutenção' }, 503));
    expect(await painel.diagnosticar(EMAIL)).toMatchObject({
      ok: false,
      problema: 'nao-alcancavel',
    });
  });

  it('sem token de agenda para depois do healthcheck', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ ok: true }), { semToken: true });

    const d = await painel.diagnosticar(EMAIL);

    expect(d).toMatchObject({ ok: false, problema: 'sem-token' });
    expect(chamadas).toHaveLength(1);
    // Healthcheck é público: sem token, vai sem Authorization em vez de "Bearer undefined".
    expect(chamadas[0]?.auth).toBeNull();
  });

  it('sem actor_email válido para no healthcheck e DIZ que parou ali', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ ok: true }));

    const d = await painel.diagnosticar();

    expect(d.ok).toBe(true);
    expect(d.problema).toBeUndefined();
    expect(d.detalhe).toContain('healthcheck');
    expect(chamadas).toHaveLength(1);
  });

  it('tudo certo devolve ok e checa os dois passos', async () => {
    const { painel, chamadas } = montar((url) =>
      url.includes('/healthcheck')
        ? jsonResponse({ status: 'ok' })
        : jsonResponse({ user: { email: EMAIL, name: 'Ana' }, capabilities: [] })
    );

    const d = await painel.diagnosticar(EMAIL);

    expect(d).toMatchObject({ ok: true });
    expect(d.problema).toBeUndefined();
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]?.auth).toBe(`Bearer ${TOKEN}`);
  });
});

describe('GET /api/painel/diagnostico', () => {
  const servidores: Server[] = [];
  afterEach(() => {
    for (const s of servidores.splice(0)) s.close();
  });

  async function subir(painel: PainelClient): Promise<string> {
    const app = express();
    app.use(createPainelInternoRouter({ painel }));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    servidores.push(server);
    const addr = server.address();
    const porta = typeof addr === 'object' && addr ? addr.port : 0;
    return `http://127.0.0.1:${porta}`;
  }

  it('entrega a classificação do problema sem devolver token nenhum', async () => {
    const { painel } = montar(() => htmlResponse());
    const base = await subir(painel);

    const resposta = await fetch(`${base}/api/painel/diagnostico?email=${encodeURIComponent(EMAIL)}`);
    const corpo = (await resposta.json()) as Record<string, unknown>;

    // 200 mesmo com problema: o corpo É o diagnóstico.
    expect(resposta.status).toBe(200);
    expect(corpo).toMatchObject({ ok: false, problema: 'html-em-vez-de-json', configurado: true });
    expect(JSON.stringify(corpo)).not.toContain(TOKEN);
    expect(JSON.stringify(corpo)).not.toContain(RETAGUARDA);
  });

  it('sem ?email= ainda responde, checando só o healthcheck', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ ok: true }));
    const base = await subir(painel);

    const corpo = (await (await fetch(`${base}/api/painel/diagnostico`)).json()) as Record<
      string,
      unknown
    >;

    expect(corpo.ok).toBe(true);
    expect(chamadas).toHaveLength(1);
  });
});

/**
 * O painel de hoje responde 401 com "Token inválido." e nada mais — inofensivo.
 * O dia em que entrar um WAF, um API gateway ou um proxy de autenticação no
 * caminho, o corpo do erro passa a ser JSON com o REQUEST ecoado, headers
 * inclusive. Aí o `Authorization: Bearer <token compartilhado>` cai no arquivo
 * de log, que é lido, copiado e colado por muita gente.
 */
describe('censurar()', () => {
  // Formato realista: comprido e base64-ish, como token gerado de verdade.
  const LONGO = 'pnlx9fQ2xKmT4vZ7bR1sLwE8hJ3nY6uA0dCg';

  it('troca o valor exato dos dois tokens conhecidos', () => {
    const bruto = `agenda=${LONGO} retaguarda=${RETAGUARDA}`;
    const limpo = censurar(bruto, [LONGO, RETAGUARDA]);

    expect(limpo).not.toContain(LONGO);
    expect(limpo).not.toContain(RETAGUARDA);
    // A estrutura da linha sobrevive: dá pra saber QUAL token apareceu onde.
    expect(limpo).toBe('agenda=*** retaguarda=***');
  });

  it('mascara `Bearer <algo>` mesmo sem conhecer o token', () => {
    // O intermediário pode ecoar a credencial DELE, que não está no nosso .env.
    const limpo = censurar('gateway recusou: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc');
    expect(limpo).toContain('gateway recusou');
    expect(limpo).toContain('Bearer ***');
    expect(limpo).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('NÃO come a mensagem quando depois de "Bearer" vem palavra comum', () => {
    // Censura que apaga o motivo do erro troca um problema por outro.
    expect(censurar('Bearer token ausente')).toBe('Bearer token ausente');
    expect(censurar('Bearer authorization malformado')).toBe('Bearer authorization malformado');
  });

  it('mascara campo cujo nome diz que ali mora credencial, em qualquer caixa', () => {
    const bruto =
      '{"error":"unauthorized","request":{"headers":{"Authorization":"Bearer abc123def456"},' +
      '"body":{"access_token":"xyz-9","api_key":"k-1"}},"trace_id":"req-77"}';
    const limpo = censurar(bruto);

    expect(limpo).not.toContain('abc123def456');
    expect(limpo).not.toContain('xyz-9');
    expect(limpo).not.toContain('k-1');
    // O que serve pra diagnosticar continua lá.
    expect(limpo).toContain('unauthorized');
    expect(limpo).toContain('req-77');
  });

  it('pega eco truncado do token: sequência longa que casa com o configurado', () => {
    // Um gateway pode cortar o valor antes de ecoar — a igualdade exata falharia.
    const pedaco = LONGO.slice(0, 28);
    const limpo = censurar(`token recebido: ${pedaco}`, [LONGO]);
    expect(limpo).not.toContain(pedaco);
    expect(limpo).toContain('token recebido: ***');
  });

  it('NÃO mascara sequência longa que não tem nada a ver com os tokens', () => {
    // Id de reunião, hash e CNPJ também são longos e sem espaço: mascarar tudo
    // deixaria o log sem a única informação que identifica o caso.
    const bruto = 'reuniao 8f14e45fceea167a5a36dedd4bea2543 recusada no painel';
    expect(censurar(bruto, [LONGO])).toBe(bruto);
  });

  it('sem segredo configurado ainda censura o que tem forma de credencial', () => {
    const limpo = censurar('{"token":"seg-red-o-1234"}');
    expect(limpo).not.toContain('seg-red-o-1234');
  });

  it('mensagem normal do painel atravessa intacta', () => {
    for (const frase of [
      'horário ocupado',
      'implantador não vende',
      'usuário não encontrado',
      'Token inválido.',
    ]) {
      expect(censurar(frase, [LONGO, RETAGUARDA])).toBe(frase);
    }
  });
});

describe('painel hostil que ecoa o Authorization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** O corpo que um WAF/API gateway devolve: o request inteiro de volta. */
  function ecoDoRequest(mensagem: string): Response {
    return jsonResponse(
      {
        error: mensagem,
        request: {
          method: 'GET',
          headers: { authorization: `Bearer ${TOKEN}`, 'user-agent': 'node' },
        },
        trace_id: 'wafr-2026-0814',
      },
      403
    );
  }

  it('leitura: o corpo cru vai pro log sem o token, e com o motivo preservado', async () => {
    const { painel } = montar(() => ecoDoRequest('bloqueado pela política do gateway'));
    const log = capturarAvisos();

    expect(await painel.me(EMAIL)).toBeNull();
    log.parar();

    expect(log.linhas).toHaveLength(1);
    const linha = log.linhas[0] ?? '';
    expect(linha).not.toContain(TOKEN);
    // O log continua servindo pra alguma coisa: status, operação e motivo.
    expect(linha).toContain('403');
    expect(linha).toContain('me');
    expect(linha).toContain('bloqueado pela política do gateway');
    expect(linha).toContain('wafr-2026-0814');
  });

  it('transcrição recusada: nem o log nem o motivo carregam o token ecoado', async () => {
    const { painel } = montar(() => ecoDoRequest('transcript rejeitado'));
    const log = capturarAvisos();

    const r = await painel.enviarTranscricao({
      meetingId: 'reuniao-1',
      actorEmail: EMAIL,
      texto: 'Vendedor: bom dia',
    });
    log.parar();

    expect(r.estado).toBe('recusado');
    // O motivo sobe pra quem chamou e pode ser guardado ou mostrado: censurado
    // também, não só a linha de log.
    const motivo = 'motivo' in r ? r.motivo : '';
    expect(motivo).not.toContain(TOKEN);
    expect(motivo).toContain('transcript rejeitado');
    expect(log.linhas).toHaveLength(1);
    expect(log.linhas[0]).not.toContain(TOKEN);
    expect(log.linhas[0]).toContain('transcript rejeitado');
  });

  it('token no meio da mensagem de erro não vaza pra tela do atendente', async () => {
    // Aqui o eco vem no PRÓPRIO texto do erro, que a rota devolve pro navegador.
    const { painel } = montar(() =>
      jsonResponse({ error: `request negado (Authorization: Bearer ${TOKEN})` }, 401)
    );

    const erro = await painel
      .criarReuniao({
        type: 'apresentacao',
        actorEmail: EMAIL,
        clientName: 'Cliente',
        companyName: 'Empresa',
        phone: '(11) 90000-0000',
        clientType: 'prospect',
        scheduledDate: '2026-08-20',
        scheduledTime: '14:00',
      })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(PainelError);
    expect((erro as PainelError).message).not.toContain(TOKEN);
    expect((erro as PainelError).message).toContain('request negado');
  });

  it('o .detalhe do PainelError guarda o corpo já censurado', async () => {
    // Hoje ninguém lê esse campo, mas um JSON.stringify(err) numa resposta
    // futura empurraria ele inteiro pro navegador — inclusive o header ecoado.
    const { painel } = montar(() => ecoDoRequest('assignee inexistente'));

    const erro = (await painel
      .criarReuniao({
        type: 'implantacao',
        actorEmail: EMAIL,
        clientName: 'Cliente',
        companyName: 'Empresa',
        phone: '(11) 90000-0000',
        clientType: 'base',
        scheduledDate: '2026-08-20',
        scheduledTime: '14:00',
      })
      .catch((e: unknown) => e)) as PainelError;

    expect(erro.status).toBe(403);
    expect(erro.detalhe).not.toContain(TOKEN);
    expect(erro.detalhe).toContain('assignee inexistente');
    // O campo é enumerável: é exatamente isto que um JSON.stringify(err) leva.
    expect(JSON.stringify(erro)).not.toContain(TOKEN);
  });

  it('diagnóstico: o motivo do 422 chega ao navegador sem credencial', async () => {
    const { painel } = montar((url) =>
      url.includes('/healthcheck')
        ? jsonResponse({ ok: true })
        : jsonResponse(
            { error: `usuário não encontrado — enviado Authorization: Bearer ${TOKEN}` },
            422
          )
    );

    const d = await painel.diagnosticar('ninguem@exemplo.com');

    expect(d).toMatchObject({ ok: false, problema: 'usuario-desconhecido' });
    expect(d.detalhe).not.toContain(TOKEN);
    expect(d.detalhe).toContain('usuário não encontrado');
  });

  it('token cortado no limite do log não deixa metade pra trás', async () => {
    // Censurar depois de cortar deixaria um pedaço reconhecível do token no
    // arquivo. Por isso a ordem é censurar → cortar, e este teste segura isso:
    // o token começa depois dos 200 caracteres que iriam pro log.
    const enchimento = 'x'.repeat(260);
    const { painel } = montar(() =>
      jsonResponse({ error: `${enchimento} Bearer ${TOKEN} fim` }, 500)
    );
    const log = capturarAvisos();

    expect(await painel.vendedores()).toEqual([]);
    log.parar();

    expect(log.linhas).toHaveLength(1);
    const linha = log.linhas[0] ?? '';
    expect(linha).not.toContain(TOKEN);
    expect(linha).not.toContain(TOKEN.slice(0, 8));
  });
});
