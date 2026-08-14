import { describe, it, expect } from 'vitest';
import {
  PainelClient,
  PainelError,
  validarCnpj,
  normalizarCnpj,
  ehTipoReuniao,
} from '../src/painel/client.js';
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
  options: { semRetaguarda?: boolean } = {}
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
      extAgendaToken: TOKEN,
      ...(options.semRetaguarda ? {} : { retaguardaToken: RETAGUARDA }),
      fetchImpl,
      timeoutMs: 50,
    }),
    chamadas,
  };
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

  it('os outros tipos NÃO mandam client_type', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ available_slots: [] }));
    await painel.horarios({
      tipo: 'implantacao',
      data: '2026-08-20',
      actorEmail: EMAIL,
      clientType: 'base',
    });
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

describe('POST transcript', () => {
  it('sobe a transcrição pro painel e responde true', async () => {
    const { painel, chamadas } = montar(() => jsonResponse({ ok: true }));

    const ok = await painel.enviarTranscricao({
      meetingId: 'reuniao-1',
      actorEmail: EMAIL,
      texto: 'Vendedor: bom dia\n\nCliente: bom dia',
    });

    expect(ok).toBe(true);
    expect(chamadas[0]?.url).toContain('/api/ext/agenda/meetings/reuniao-1/transcript');
    expect(chamadas[0]?.corpo).toMatchObject({ actor_email: EMAIL, language_code: 'pt-BR' });
  });

  it('painel recusando devolve false, sem lançar — a fila do Recall não pode cair', async () => {
    const { painel } = montar(() => jsonResponse({ error: 'nope' }, 500));
    const ok = await painel.enviarTranscricao({
      meetingId: 'reuniao-1',
      actorEmail: EMAIL,
      texto: 'algo',
    });
    expect(ok).toBe(false);
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
