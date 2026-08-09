import { describe, it, expect } from 'vitest';
import {
  gerarResumo,
  formatarResumo,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  MODELO_PADRAO,
  type ResumoReuniao,
} from '../src/resumo/index.js';
import { recortarTranscricao, montarPrompt } from '../src/resumo/prompt.js';
import { normalizarResumo } from '../src/resumo/schema.js';
import type { Fala } from '../src/recall/transcript.js';
import { jsonResponse } from './helpers.js';

/**
 * Resumo por IA — `fetch` sempre injetado, NUNCA rede real.
 * A chave usada aqui é fictícia.
 *
 * O foco é o caminho de erro: toda falha tem que virar `null`, nunca exceção,
 * porque o comentário no chatPro depende do fallback pra sair mesmo assim.
 */

const API_KEY = 'sk-ant-chave-de-teste-123';

interface Chamada {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fetchGravador(respostas: (Response | Error)[]): {
  fetchImpl: typeof fetch;
  chamadas: Chamada[];
} {
  const chamadas: Chamada[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    chamadas.push({
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    });
    const resposta = respostas[i];
    i += 1;
    if (!resposta) return Promise.reject(new Error('resposta não preparada no teste'));
    if (resposta instanceof Error) return Promise.reject(resposta);
    return Promise.resolve(resposta);
  };
  return { fetchImpl, chamadas };
}

/** Resposta da API da Anthropic com o texto que o modelo devolveu. */
function respostaModelo(texto: string, stopReason = 'end_turn'): Response {
  return jsonResponse({
    id: 'msg_teste',
    type: 'message',
    role: 'assistant',
    model: MODELO_PADRAO,
    stop_reason: stopReason,
    content: [{ type: 'text', text: texto }],
  });
}

function fala(startMs: number, speaker: string, text: string): Fala {
  return { speaker, text, startMs, endMs: startMs + 2000 };
}

const FALAS: Fala[] = [
  fala(0, 'Ana', 'Bom dia, obrigada pelo tempo.'),
  fala(5000, 'Cliente', 'Preciso entender o preço.'),
  fala(9000, 'Ana', 'Fechamos em mil reais por mês, começando dia 10.'),
];

const PARTICIPANTES = [
  { nome: 'Ana', isHost: true },
  { nome: 'Cliente', isHost: false },
];

const JSON_OK = JSON.stringify({
  combinado: ['Contrato de mil reais por mês', 'Início no dia 10'],
  atencao: ['Cliente achou o preço alto'],
  resumoLivre: 'Cliente aceitou a proposta com ressalva de preço.',
});

function opcoes(overrides: Partial<Parameters<typeof gerarResumo>[0]> = {}): Parameters<
  typeof gerarResumo
>[0] {
  return {
    falas: FALAS,
    participantes: PARTICIPANTES,
    duracaoSegundos: 600,
    apiKey: API_KEY,
    ...overrides,
  };
}

describe('gerarResumo — caminho feliz', () => {
  it('monta a requisição no contrato da Anthropic e devolve o resumo validado', async () => {
    const { fetchImpl, chamadas } = fetchGravador([respostaModelo(JSON_OK)]);

    const resumo = await gerarResumo(opcoes({ fetchImpl }));

    expect(chamadas).toHaveLength(1);
    const chamada = chamadas[0];
    expect(chamada?.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(chamada?.method).toBe('POST');
    expect(chamada?.headers['x-api-key']).toBe(API_KEY);
    expect(chamada?.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(chamada?.body.model).toBe(MODELO_PADRAO);

    expect(resumo).not.toBeNull();
    expect(resumo?.combinado).toEqual(['Contrato de mil reais por mês', 'Início no dia 10']);
    expect(resumo?.atencao).toEqual(['Cliente achou o preço alto']);
    expect(resumo?.resumoLivre).toContain('ressalva');
  });

  it('usa o modelo passado em vez do padrão', async () => {
    const { fetchImpl, chamadas } = fetchGravador([respostaModelo(JSON_OK)]);

    await gerarResumo(opcoes({ fetchImpl, modelo: 'claude-opus-5' }));

    expect(chamadas[0]?.body.model).toBe('claude-opus-5');
  });

  it('aceita JSON embrulhado em cerca de código', async () => {
    const { fetchImpl } = fetchGravador([respostaModelo('```json\n' + JSON_OK + '\n```')]);

    const resumo = await gerarResumo(opcoes({ fetchImpl }));

    expect(resumo?.combinado).toHaveLength(2);
  });

  it('aceita JSON precedido de frase e ignora blocos de raciocínio', async () => {
    const resposta = jsonResponse({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'analisando a conversa {não é json}' },
        { type: 'text', text: `Segue o resultado:\n${JSON_OK}` },
      ],
    });
    const { fetchImpl } = fetchGravador([resposta]);

    const resumo = await gerarResumo(opcoes({ fetchImpl }));

    expect(resumo?.atencao).toEqual(['Cliente achou o preço alto']);
  });

  it('manda a transcrição no corpo, com os participantes e a duração', async () => {
    const { fetchImpl, chamadas } = fetchGravador([respostaModelo(JSON_OK)]);

    await gerarResumo(opcoes({ fetchImpl }));

    const mensagens = chamadas[0]?.body.messages as { role: string; content: string }[];
    expect(mensagens[0]?.role).toBe('user');
    expect(mensagens[0]?.content).toContain('Fechamos em mil reais por mês');
    expect(mensagens[0]?.content).toContain('Ana (anfitrião)');
    expect(mensagens[0]?.content).toContain('10 min');
  });
});

describe('gerarResumo — caminhos de erro (sempre null, nunca throw)', () => {
  it('sem chave nenhuma, usa o extrativo e NÃO toca a rede', async () => {
    const { fetchImpl, chamadas } = fetchGravador([]);

    // Com provedor 'auto' e nenhuma chave, a escolha cai no extrativo — que
    // roda só com código local. É o piso do sistema: o comentário no chatPro
    // leva SÓ o resumo, então ficar sem nada deixaria o cliente sem conteúdo.
    const resumo = await gerarResumo(opcoes({ fetchImpl, apiKey: undefined }));

    expect(chamadas).toHaveLength(0);
    expect(resumo).not.toBeNull();
  });

  it('provedor anthropic sem chave devolve null (não inventa outro caminho)', async () => {
    const { fetchImpl, chamadas } = fetchGravador([]);

    const resumo = await gerarResumo(
      opcoes({ fetchImpl, apiKey: undefined, provedor: 'anthropic' })
    );

    expect(resumo).toBeNull();
    expect(chamadas).toHaveLength(0);
  });

  it('devolve null e não chama a rede quando não há falas', async () => {
    const { fetchImpl, chamadas } = fetchGravador([]);

    const resumo = await gerarResumo(opcoes({ fetchImpl, falas: [] }));

    expect(resumo).toBeNull();
    expect(chamadas).toHaveLength(0);
  });

  it('devolve null em HTTP 500', async () => {
    const { fetchImpl } = fetchGravador([jsonResponse({ error: 'boom' }, 500)]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null em HTTP 401 (chave inválida)', async () => {
    const { fetchImpl } = fetchGravador([jsonResponse({ error: 'invalid x-api-key' }, 401)]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null quando o fetch falha por rede', async () => {
    const { fetchImpl } = fetchGravador([new Error('getaddrinfo ENOTFOUND api.anthropic.com')]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null quando estoura o timeout', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted.'));
        });
      });

    await expect(gerarResumo(opcoes({ fetchImpl, timeoutMs: 5 }))).resolves.toBeNull();
  });

  it('devolve null quando o corpo não é JSON', async () => {
    const resposta = new Response('<html>502</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const { fetchImpl } = fetchGravador([resposta]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null quando o envelope da resposta vem fora do formato', async () => {
    const { fetchImpl } = fetchGravador([jsonResponse({ content: 'não é lista' })]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null quando o modelo responde texto solto em vez de JSON', async () => {
    const { fetchImpl } = fetchGravador([respostaModelo('Não consegui resumir a reunião.')]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null quando o JSON tem os campos com o tipo errado', async () => {
    const { fetchImpl } = fetchGravador([
      respostaModelo(JSON.stringify({ combinado: 'texto', atencao: [] })),
    ]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null quando falta um campo obrigatório', async () => {
    const { fetchImpl } = fetchGravador([respostaModelo(JSON.stringify({ combinado: [] }))]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null quando o modelo recusa (stop_reason refusal)', async () => {
    const { fetchImpl } = fetchGravador([respostaModelo(JSON_OK, 'refusal')]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });

  it('devolve null quando o content vem vazio', async () => {
    const { fetchImpl } = fetchGravador([jsonResponse({ stop_reason: 'end_turn', content: [] })]);

    await expect(gerarResumo(opcoes({ fetchImpl }))).resolves.toBeNull();
  });
});

describe('normalizarResumo — limpeza do que o modelo devolve', () => {
  it('remove itens vazios e o marcador que o modelo às vezes repete', () => {
    const resumo = normalizarResumo({
      combinado: ['- Enviar proposta', '   ', '• Agendar retorno'],
      atencao: [],
    });

    expect(resumo?.combinado).toEqual(['Enviar proposta', 'Agendar retorno']);
    expect(resumo?.atencao).toEqual([]);
  });

  it('limita a quantidade de itens para o comentário não virar paredão', () => {
    const resumo = normalizarResumo({
      combinado: Array.from({ length: 20 }, (_, i) => `item ${i}`),
      atencao: [],
    });

    expect(resumo?.combinado).toHaveLength(8);
  });

  it('trunca item gigante', () => {
    const resumo = normalizarResumo({ combinado: ['x'.repeat(900)], atencao: [] });

    expect(resumo?.combinado[0]?.length).toBe(300);
    expect(resumo?.combinado[0]?.endsWith('…')).toBe(true);
  });

  it('omite resumoLivre quando vem em branco', () => {
    const resumo = normalizarResumo({ combinado: [], atencao: [], resumoLivre: '   ' });

    expect(resumo).not.toBeNull();
    expect(resumo?.resumoLivre).toBeUndefined();
  });
});

describe('recortarTranscricao — orçamento de caracteres', () => {
  const muitas: Fala[] = Array.from({ length: 400 }, (_, i) =>
    fala(i * 1000, `Pessoa ${i % 2}`, `${'palavra '.repeat(30)}fala numero ${i}`)
  );

  it('manda tudo quando cabe no orçamento', () => {
    const recorte = recortarTranscricao(FALAS, 60_000);

    expect(recorte.falasOmitidas).toBe(0);
    expect(recorte.falasEnviadas).toBe(3);
    expect(recorte.texto).toContain('Fechamos em mil reais');
  });

  it('quando não cabe, preserva o começo E o fim (é lá que ficam os combinados)', () => {
    const recorte = recortarTranscricao(muitas, 5_000);

    expect(recorte.falasOmitidas).toBeGreaterThan(0);
    expect(recorte.texto).toContain('fala numero 0');
    expect(recorte.texto).toContain('fala numero 399');
    expect(recorte.texto).toContain('omitido');
    expect(recorte.texto).not.toContain('fala numero 200');
  });

  it('respeita o orçamento', () => {
    const recorte = recortarTranscricao(muitas, 5_000);

    // Só o marcador de corte pode passar do teto — ele é adicionado depois.
    expect(recorte.texto.length).toBeLessThanOrEqual(5_000 + 40);
  });

  it('não devolve só o marcador quando uma única fala estoura o orçamento', () => {
    const gigante = [fala(0, 'Ana', 'a'.repeat(5_000))];

    const recorte = recortarTranscricao(gigante, 500);

    expect(recorte.falasEnviadas).toBe(1);
    expect(recorte.texto.length).toBeGreaterThan(100);
  });

  it('avisa o modelo no prompt quando houve corte', () => {
    const prompt = montarPrompt({
      falas: muitas,
      participantes: PARTICIPANTES,
      duracaoSegundos: 3600,
      orcamento: 5_000,
    });

    expect(prompt.user).toContain('omitidas por tamanho');
    expect(prompt.recorte.falasOmitidas).toBeGreaterThan(0);
  });
});

describe('formatarResumo', () => {
  const META = {
    duracaoSegundos: 1920,
    participantes: [{ nome: 'Ana' }, { nome: 'Cliente' }],
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    painelUrl: 'https://painel.exemplo/reunioes/1',
  };

  const RESUMO: ResumoReuniao = {
    combinado: ['Contrato de mil reais por mês'],
    atencao: ['Cliente achou o preço alto'],
    resumoLivre: 'Cliente aceitou a proposta com ressalva.',
  };

  it('monta cabeçalho, combinados e atenção', () => {
    const texto = formatarResumo(RESUMO, META);

    expect(texto).toContain('*Resumo da reunião*');
    expect(texto).toContain('32 min');
    expect(texto).toContain('Ana · Cliente');
    expect(texto).toContain(META.meetingUrl);
    expect(texto).toContain('*Combinado*');
    expect(texto).toContain('• Contrato de mil reais por mês');
    expect(texto).toContain('*Atenção*');
    expect(texto).toContain('• Cliente achou o preço alto');
    expect(texto).toContain('Cliente aceitou a proposta com ressalva.');
    expect(texto).toContain(META.painelUrl);
  });

  it('com null, ainda entrega cabeçalho, link e o aviso do painel', () => {
    const texto = formatarResumo(null, META);

    expect(texto).toContain('*Resumo da reunião*');
    expect(texto).toContain('32 min');
    expect(texto).toContain('Ana · Cliente');
    expect(texto).toContain(META.meetingUrl);
    expect(texto).toContain('não saiu');
    expect(texto).toContain('painel');
    expect(texto).toContain(META.painelUrl);
  });

  it('não inventa linhas quando não há participantes nem links', () => {
    const texto = formatarResumo(null, { duracaoSegundos: 0, participantes: [] });

    expect(texto).toContain('*Resumo da reunião*');
    expect(texto).not.toContain('—');
    expect(texto).not.toContain('http');
  });

  it('avisa quando o modelo não achou nada de concreto', () => {
    const texto = formatarResumo({ combinado: [], atencao: [] }, META);

    expect(texto).toContain('Nada ficou definido');
    expect(texto).not.toContain('*Combinado*');
  });

  it('omite blocos vazios', () => {
    const texto = formatarResumo({ combinado: ['Enviar proposta'], atencao: [] }, META);

    expect(texto).toContain('*Combinado*');
    expect(texto).not.toContain('*Atenção*');
  });
});
