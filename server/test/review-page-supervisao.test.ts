import { describe, it, expect } from 'vitest';
import { reviewPageHtml } from '../src/routes/reviewPage.js';

/**
 * Faixa de supervisão do painel (indicadores, gráfico por dia e busca).
 *
 * O painel é HTML+JS inline, então o teste monta um DOM mínimo de mentira e
 * executa de verdade o script da página. Assim um erro de sintaxe ou uma
 * chamada de DOM inexistente quebram a suíte — não a tela do supervisor.
 * O `fetch` é sempre injetado: a suíte NUNCA toca a rede.
 */

// ─── DOM de mentira ─────────────────────────────────────────────────────────

class Elemento {
  [prop: string]: any;

  constructor(tag: string) {
    this.tag = tag;
    this.className = '';
    this.filhos = [] as Elemento[];
    this.atributos = new Map<string, string>();
    this.ouvintes = new Map<string, Array<(ev: unknown) => void>>();
    this.style = {} as Record<string, string>;
    this.textoCru = '';
  }

  get textContent(): string {
    if (this.tag === '#texto') return String(this.textoCru);
    return (this.filhos as Elemento[]).map((f) => f.textContent).join('');
  }

  set textContent(valor: string) {
    if (this.tag === '#texto') {
      this.textoCru = String(valor);
      return;
    }
    this.filhos = [criarTexto(String(valor))];
  }

  get childNodes(): Elemento[] {
    return this.filhos as Elemento[];
  }

  get classList() {
    const partes = (): string[] => String(this.className).split(' ').filter((p) => p !== '');
    const gravar = (lista: string[]): void => { this.className = lista.join(' '); };
    return {
      contains: (c: string): boolean => partes().includes(c),
      add: (c: string): void => { if (!partes().includes(c)) gravar(partes().concat([c])); },
      remove: (c: string): void => { gravar(partes().filter((p) => p !== c)); },
      toggle: (c: string, ligado?: boolean): void => {
        const tem = partes().includes(c);
        const alvo = ligado === undefined ? !tem : ligado;
        if (alvo && !tem) gravar(partes().concat([c]));
        if (!alvo && tem) gravar(partes().filter((p) => p !== c));
      },
    };
  }

  appendChild(no: Elemento): Elemento {
    if (no.tag === '#fragmento') {
      for (const f of no.filhos as Elemento[]) (this.filhos as Elemento[]).push(f);
      return no;
    }
    (this.filhos as Elemento[]).push(no);
    return no;
  }

  replaceChildren(...nos: Elemento[]): void {
    this.filhos = [];
    for (const no of nos) this.appendChild(no);
  }

  setAttribute(nome: string, valor: string): void {
    (this.atributos as Map<string, string>).set(nome, valor);
    if (nome === 'class') this.className = valor;
  }

  getAttribute(nome: string): string | null {
    return (this.atributos as Map<string, string>).get(nome) ?? null;
  }

  addEventListener(tipo: string, fn: (ev: unknown) => void): void {
    const mapa = this.ouvintes as Map<string, Array<(ev: unknown) => void>>;
    const lista = mapa.get(tipo) ?? [];
    lista.push(fn);
    mapa.set(tipo, lista);
  }

  disparar(tipo: string, ev: unknown = { preventDefault(): void {} }): void {
    const mapa = this.ouvintes as Map<string, Array<(ev: unknown) => void>>;
    for (const fn of mapa.get(tipo) ?? []) fn(ev);
  }

  contains(no: unknown): boolean {
    if (no === this) return true;
    for (const f of this.filhos as Elemento[]) if (f.contains(no)) return true;
    return false;
  }

  focus(): void {}
  scrollIntoView(): void {}
}

function criarTexto(texto: string): Elemento {
  const no = new Elemento('#texto');
  no.textoCru = texto;
  return no;
}

/** Percorre a árvore e devolve os elementos que têm a classe pedida. */
function porClasse(raiz: Elemento, classe: string): Elemento[] {
  const achados: Elemento[] = [];
  const visitar = (no: Elemento): void => {
    if (no.classList.contains(classe)) achados.push(no);
    for (const f of no.filhos as Elemento[]) visitar(f);
  };
  visitar(raiz);
  return achados;
}

function porTag(raiz: Elemento, tag: string): Elemento[] {
  const achados: Elemento[] = [];
  const visitar = (no: Elemento): void => {
    if (no.tag === tag) achados.push(no);
    for (const f of no.filhos as Elemento[]) visitar(f);
  };
  visitar(raiz);
  return achados;
}

// ─── Montagem da página ─────────────────────────────────────────────────────

interface RespostaFalsa {
  ok?: boolean;
  status?: number;
  corpo?: unknown;
  /** Simula servidor fora do ar: o próprio fetch rejeita. */
  rejeitar?: boolean;
}

type Rotas = Record<string, RespostaFalsa>;

interface Ambiente {
  pegar(id: string): Elemento;
  chamadas: string[];
  escoar(): Promise<void>;
}

/** Registra todo elemento com `id` no HTML, preservando a classe inicial. */
function indexarPorId(html: string): Map<string, Elemento> {
  const porId = new Map<string, Elemento>();
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    const id = /\sid="([^"]+)"/.exec(tag);
    if (!id?.[1]) continue;
    const nome = /^<([a-zA-Z0-9]+)/.exec(tag);
    const e = new Elemento(nome?.[1] ?? 'div');
    const cls = /\sclass="([^"]+)"/.exec(tag);
    if (cls?.[1]) e.className = cls[1];
    e.value = '';
    porId.set(id[1], e);
  }
  return porId;
}

function montarPainel(rotas: Rotas): Ambiente {
  const html = reviewPageHtml();
  const porId = indexarPorId(html);
  const chamadas: string[] = [];

  const documento = {
    getElementById: (id: string): Elemento | null => porId.get(id) ?? null,
    createElement: (tag: string): Elemento => new Elemento(tag),
    createElementNS: (_ns: string, tag: string): Elemento => new Elemento(tag),
    createTextNode: (t: string): Elemento => criarTexto(t),
    createDocumentFragment: (): Elemento => new Elemento('#fragmento'),
    addEventListener: (): void => {},
  };

  // Prefixo mais longo primeiro: /api/meetings/busca não pode cair em /api/meetings.
  const prefixos = Object.keys(rotas).sort((a, b) => b.length - a.length);

  const fetchFalso = (url: string): Promise<unknown> => {
    chamadas.push(url);
    const chave = prefixos.find((prefixo) => url.startsWith(prefixo));
    if (chave === undefined) return Promise.reject(new Error('rota não preparada: ' + url));
    const r = rotas[chave] as RespostaFalsa;
    if (r.rejeitar) return Promise.reject(new Error('servidor fora do ar'));
    return Promise.resolve({
      ok: r.ok !== false,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.corpo ?? {}),
    });
  };

  const guardado = new Map<string, string>();
  const armazenamento = {
    getItem: (c: string): string | null => guardado.get(c) ?? null,
    setItem: (c: string, v: string): void => { guardado.set(c, v); },
  };

  const inicio = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(inicio, html.indexOf('</script>'));
  const executar = new Function(
    'window', 'document', 'location', 'localStorage', 'navigator',
    'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'console',
    script,
  );
  executar(
    { addEventListener: (): void => {} },
    documento,
    { hash: '' },
    armazenamento,
    { clipboard: { writeText: (): Promise<void> => Promise.resolve() } },
    fetchFalso,
    (): number => 0,
    // Sem espera: o debounce da busca dispara na hora dentro do teste.
    (fn: () => void): number => { fn(); return 0; },
    (): void => {},
    { log: (): void => {}, error: (): void => {} },
  );

  return {
    pegar: (id: string): Elemento => {
      const e = porId.get(id);
      if (!e) throw new Error('elemento inexistente no painel: ' + id);
      return e;
    },
    chamadas,
    escoar: async (): Promise<void> => {
      // A busca tem debounce de 350 ms com setTimeout REAL. Drenar só
      // microtask não faz o timer disparar: o teste passava sozinho (a
      // máquina ociosa entregava o callback antes das asserções) e falhava na
      // suíte completa, com os outros arquivos disputando CPU. Esperar o
      // tempo de verdade tira a corrida do meio.
      await new Promise((r) => setTimeout(r, 450));
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
  };
}

// ─── Dados de apoio ─────────────────────────────────────────────────────────

const SEM_REUNIOES = { corpo: { meetings: [] } };

const RESUMO = {
  corpo: {
    total: 12,
    gravadas: 9,
    semGravacao: 3,
    semTranscricao: 1,
    porDia: [
      { dia: '2026-08-02', total: 1, gravadas: 1 },
      { dia: '2026-08-03', total: 0, gravadas: 0 },
      { dia: '2026-08-04', total: 3, gravadas: 2 },
      { dia: '2026-08-05', total: 2, gravadas: 2 },
      { dia: '2026-08-06', total: 4, gravadas: 2 },
      { dia: '2026-08-07', total: 1, gravadas: 1 },
      { dia: '2026-08-08', total: 1, gravadas: 1 },
    ],
    porAtendente: [
      { nome: 'Bruno', total: 5 },
      { nome: 'Ana', total: 7 },
    ],
  },
};

// ─── Testes ─────────────────────────────────────────────────────────────────

describe('painel de supervisão — indicadores', () => {
  it('mostra reuniões, gravadas e sem gravação dos últimos 7 dias', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': RESUMO,
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    expect(painel.chamadas).toContain('/api/meetings/resumo-supervisao?dias=7');

    const cartoes = porClasse(painel.pegar('kpis'), 'kpi');
    expect(cartoes).toHaveLength(4);
    expect(cartoes.map((c) => porClasse(c, 'n')[0]?.textContent)).toEqual(['12', '9', '3', '1']);
    expect(cartoes[1]?.textContent).toContain('gravadas pelo bot');
    expect(cartoes[2]?.textContent).toContain('SEM gravação');
  });

  it('destaca em vermelho quando existe reunião sem gravação', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': RESUMO,
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    const cartoes = porClasse(painel.pegar('kpis'), 'kpi');
    expect(cartoes[2]?.classList.contains('destaque')).toBe(true);
  });

  it('não destaca nada quando toda reunião foi gravada', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': {
        corpo: { total: 4, gravadas: 4, semGravacao: 0, semTranscricao: 0, porDia: [], porAtendente: [] },
      },
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    const cartoes = porClasse(painel.pegar('kpis'), 'kpi');
    expect(cartoes[2]?.classList.contains('destaque')).toBe(false);
    expect(porClasse(painel.pegar('kpis'), 'destaque')).toHaveLength(0);
  });

  it('lista o total por atendente', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': RESUMO,
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    // Ordenado pelo maior volume, não pela ordem que o servidor mandou.
    expect(painel.pegar('por-atendente').textContent).toBe('Por atendente: Ana 7 · Bruno 5');
  });

  it('aceita o resumo em snake_case sem quebrar', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': {
        corpo: {
          total: 5, gravadas: 3, sem_gravacao: 2, sem_transcricao: 1,
          por_dia: [{ dia: '2026-08-08', total: 5, gravadas: 3 }],
          por_atendente: [{ nome: 'Ana', total: 5 }],
        },
      },
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    const cartoes = porClasse(painel.pegar('kpis'), 'kpi');
    expect(cartoes.map((c) => porClasse(c, 'n')[0]?.textContent)).toEqual(['5', '3', '2', '1']);
  });

  it('avisa discretamente quando a rota de resumo não existe (404)', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': { ok: false, status: 404 },
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    expect(painel.pegar('super-aviso').textContent).toBe('Indicadores indisponíveis no momento.');
    expect(painel.pegar('kpis').childNodes).toHaveLength(0);
    // A aba continua de pé: a lista de reuniões foi carregada mesmo assim.
    expect(painel.chamadas).toContain('/api/meetings');
  });

  it('avisa discretamente quando o servidor nem responde', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': { rejeitar: true },
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    expect(painel.pegar('super-aviso').textContent).toBe('Indicadores indisponíveis no momento.');
    expect(painel.pegar('grafico').childNodes).toHaveLength(0);
  });
});

describe('painel de supervisão — gráfico por dia', () => {
  it('desenha uma barra por dia, separando gravadas de sem gravação', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': RESUMO,
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    const grafico = painel.pegar('grafico');
    const svg = porTag(grafico, 'svg')[0];
    expect(svg).toBeDefined();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 420 132');

    // 6 dias têm gravação; 2 dias têm reunião não gravada (04 e 06).
    expect(porClasse(grafico, 'g-ok')).toHaveLength(6);
    expect(porClasse(grafico, 'g-falta')).toHaveLength(2);
    // O dia zerado vira um traço, não some do eixo.
    expect(porClasse(grafico, 'g-vazio')).toHaveLength(1);
    expect(porTag(grafico, 'text').map((t) => t.textContent)).toContain('04/08');
  });

  it('explica o gráfico pra leitor de tela', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': RESUMO,
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    const svg = porTag(painel.pegar('grafico'), 'svg')[0];
    expect(svg?.getAttribute('aria-label')).toBe(
      'Reuniões por dia nos últimos 7 dias: 12 no total, 3 sem gravação.',
    );
  });

  it('diz que não há dados em vez de desenhar um gráfico vazio', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': {
        corpo: { total: 0, gravadas: 0, semGravacao: 0, semTranscricao: 0, porDia: [], porAtendente: [] },
      },
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    expect(porTag(painel.pegar('grafico'), 'svg')).toHaveLength(0);
    expect(painel.pegar('grafico').textContent).toBe('Ainda não há reuniões nestes 7 dias.');
  });
});

describe('painel de supervisão — busca', () => {
  const BUSCA = {
    corpo: {
      resultados: [
        {
          meetingId: 'reu-1', sessionId: 'sess-1', meetingCode: 'abc-defg-hij',
          quando: '2026-08-07T14:00:00.000Z', trecho: 'fechamos o Contrato na semana que vem',
        },
        {
          meetingId: 'reu-2', sessionId: 'sess-2', meetingCode: 'klm-nopq-rst',
          quando: '2026-08-06T10:00:00.000Z', trecho: 'o contrato ainda está em análise',
        },
      ],
    },
  };

  async function painelComBusca(rotas: Rotas = {}): Promise<Ambiente> {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': RESUMO,
      '/api/meetings/busca': BUSCA,
      '/api/meetings': SEM_REUNIOES,
      ...rotas,
    });
    await painel.escoar();
    return painel;
  }

  it('consulta a rota de busca e lista os trechos', async () => {
    const painel = await painelComBusca();
    const campo = painel.pegar('busca-campo');
    campo.value = 'contrato';
    campo.disparar('input');
    await painel.escoar();

    expect(painel.chamadas).toContain('/api/meetings/busca?q=contrato');
    const itens = porClasse(painel.pegar('busca-resultados'), 'res');
    expect(itens).toHaveLength(2);
    expect(painel.pegar('busca-status').textContent).toBe('2 trechos encontrados');
    expect(itens[0]?.textContent).toContain('abc-defg-hij');
    expect(itens[0]?.textContent).toContain('fechamos o Contrato na semana que vem');
    expect(painel.pegar('busca-resultados').classList.contains('oculto')).toBe(false);
  });

  it('realça o termo sem perder o texto original', async () => {
    const painel = await painelComBusca();
    const campo = painel.pegar('busca-campo');
    campo.value = 'contrato';
    campo.disparar('input');
    await painel.escoar();

    const marcas = porTag(painel.pegar('busca-resultados'), 'mark');
    expect(marcas).toHaveLength(2);
    // Casa sem diferenciar maiúscula, mas mostra o texto como veio.
    expect(marcas[0]?.textContent).toBe('Contrato');
    expect(marcas[1]?.textContent).toBe('contrato');
  });

  it('leva pra reunião quando o trecho é clicado', async () => {
    const painel = await painelComBusca();
    const campo = painel.pegar('busca-campo');
    campo.value = 'contrato';
    campo.disparar('input');
    await painel.escoar();

    porClasse(painel.pegar('busca-resultados'), 'res')[0]?.disparar('click');
    await painel.escoar();

    expect(painel.chamadas).toContain('/api/meetings/reu-1');
    expect(painel.pegar('busca-resultados').classList.contains('oculto')).toBe(true);
  });

  it('não consulta o servidor com menos de dois caracteres', async () => {
    const painel = await painelComBusca();
    const campo = painel.pegar('busca-campo');
    campo.value = 'c';
    campo.disparar('input');
    await painel.escoar();

    expect(painel.chamadas.some((u) => u.startsWith('/api/meetings/busca'))).toBe(false);
    expect(painel.pegar('busca-status').textContent).toBe('Digite ao menos 2 caracteres.');
  });

  it('avisa quando a busca não encontra nada', async () => {
    const painel = await painelComBusca({ '/api/meetings/busca': { corpo: { resultados: [] } } });
    const campo = painel.pegar('busca-campo');
    campo.value = 'jabuticaba';
    campo.disparar('input');
    await painel.escoar();

    expect(painel.pegar('busca-status').textContent).toBe('Nada encontrado para "jabuticaba".');
    expect(painel.pegar('busca-resultados').classList.contains('oculto')).toBe(true);
  });

  it('avisa discretamente quando a rota de busca falha', async () => {
    const painel = await painelComBusca({ '/api/meetings/busca': { ok: false, status: 500 } });
    const campo = painel.pegar('busca-campo');
    campo.value = 'contrato';
    campo.disparar('input');
    await painel.escoar();

    expect(painel.pegar('busca-status').textContent).toBe('Busca indisponível no momento.');
    expect(painel.pegar('busca-resultados').classList.contains('oculto')).toBe(true);
  });

  it('fecha os resultados no Escape', async () => {
    const painel = await painelComBusca();
    const campo = painel.pegar('busca-campo');
    campo.value = 'contrato';
    campo.disparar('input');
    await painel.escoar();
    expect(painel.pegar('busca-resultados').classList.contains('oculto')).toBe(false);

    campo.disparar('keydown', { key: 'Escape', preventDefault(): void {} });
    expect(painel.pegar('busca-resultados').classList.contains('oculto')).toBe(true);
    expect(painel.pegar('busca-status').textContent).toBe('');
  });
});

describe('painel de supervisão — faixa recolhível', () => {
  it('esconde e mostra a faixa, guardando a preferência', async () => {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': RESUMO,
      '/api/meetings': SEM_REUNIOES,
    });
    await painel.escoar();

    const corpo = painel.pegar('super-corpo');
    const botao = painel.pegar('super-toggle');
    expect(corpo.classList.contains('oculto')).toBe(false);
    expect(botao.textContent).toBe('ocultar');

    botao.disparar('click');
    expect(corpo.classList.contains('oculto')).toBe(true);
    expect(botao.getAttribute('aria-expanded')).toBe('false');
    expect(botao.textContent).toBe('mostrar');

    botao.disparar('click');
    expect(corpo.classList.contains('oculto')).toBe(false);
    expect(botao.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('painel de reuniões — fluxo comercial', () => {
  const REUNIOES_COMERCIAIS = {
    corpo: {
      meetings: [
        {
          id: 'reu-1', meetingCode: 'abc-defg-hij', status: 'done', tipo: 'migracao',
          atendenteEmail: 'ana@timeviamais.com', createdAt: '2026-08-07T14:00:00.000Z',
        },
        {
          id: 'reu-2', meetingCode: 'klm-nopq-rst', status: 'recording', tipo: 'cs',
          atendente_email: 'bruno@timeviamais.com', created_at: '2026-08-08T10:00:00.000Z',
        },
        // Reunião antiga, de antes do fluxo comercial: sem tipo nem atendente.
        { id: 'reu-3', meetingCode: 'uvw-xyza-bcd', status: 'created' },
      ],
    },
  };

  async function painelComercial(rotas: Rotas = {}): Promise<Ambiente> {
    const painel = montarPainel({
      '/api/meetings/resumo-supervisao': RESUMO,
      '/api/meetings': REUNIOES_COMERCIAIS,
      ...rotas,
    });
    await painel.escoar();
    return painel;
  }

  it('mostra a badge do tipo e o prefixo do atendente na lista', async () => {
    const painel = await painelComercial();
    const lista = painel.pegar('lista-reunioes');
    const itens = porClasse(lista, 'item');
    expect(itens).toHaveLength(3);

    // camelCase e snake_case entram do mesmo jeito; só o prefixo do e-mail aparece.
    expect(itens[0]?.textContent).toContain('Migração');
    expect(itens[0]?.textContent).toContain('ana');
    expect(itens[0]?.textContent).not.toContain('@timeviamais.com');
    expect(porClasse(itens[0] as Elemento, 'tipo-migracao')).toHaveLength(1);
    expect(itens[1]?.textContent).toContain('CS');
    expect(itens[1]?.textContent).toContain('bruno');
    expect(porClasse(itens[1] as Elemento, 'tipo-cs')).toHaveLength(1);
  });

  it('reunião sem tipo continua na lista, só sem a badge de tipo', async () => {
    const painel = await painelComercial();
    const itens = porClasse(painel.pegar('lista-reunioes'), 'item');
    expect(itens[2]?.textContent).toContain('uvw-xyza-bcd');
    const badgesTipo = ['tipo-apresentacao', 'tipo-migracao', 'tipo-implantacao', 'tipo-cs']
      .flatMap((c) => porClasse(itens[2] as Elemento, c));
    expect(badgesTipo).toHaveLength(0);
  });

  it('filtra a lista por tipo localmente, sem voltar ao servidor', async () => {
    const painel = await painelComercial();
    const filtro = painel.pegar('filtro-tipo');
    const chamadasAntes = painel.chamadas.length;

    filtro.value = 'cs';
    filtro.disparar('change');
    const soCs = porClasse(painel.pegar('lista-reunioes'), 'item');
    expect(soCs).toHaveLength(1);
    expect(soCs[0]?.textContent).toContain('klm-nopq-rst');
    expect(painel.chamadas.length).toBe(chamadasAntes);

    // Tipo sem nenhuma reunião: mensagem própria, diferente da lista vazia.
    filtro.value = 'apresentacao';
    filtro.disparar('change');
    expect(porClasse(painel.pegar('lista-reunioes'), 'item')).toHaveLength(0);
    expect(painel.pegar('lista-reunioes').textContent)
      .toBe('Nenhuma reunião do tipo "Apresentação".');

    filtro.value = '';
    filtro.disparar('change');
    expect(porClasse(painel.pegar('lista-reunioes'), 'item')).toHaveLength(3);
  });

  it('mostra o responsável e os chips de palavras-chave no detalhe', async () => {
    const painel = await painelComercial({
      '/api/meetings/reu-1': {
        corpo: {
          meeting: {
            id: 'reu-1', meetingCode: 'abc-defg-hij', status: 'done', tipo: 'migracao',
            atendenteEmail: 'ana@timeviamais.com',
            palavras: ['IA', 'Oficial', 'Preço'],
            transcript: [],
          },
        },
      },
    });
    porClasse(painel.pegar('lista-reunioes'), 'item')[0]?.disparar('click');
    await painel.escoar();

    const detalhe = painel.pegar('detalhe-reuniao');
    // No detalhe o e-mail vai inteiro: é quem responde pela reunião.
    expect(detalhe.textContent).toContain('Marcada por / Responsável: ana@timeviamais.com');
    const chips = porClasse(detalhe, 'palavra');
    expect(chips.map((c) => c.textContent)).toEqual(['IA', 'Oficial', 'Preço']);
    // Chip é filtro visual, não botão: nada de clique pendurado nele.
    for (const chip of chips) {
      expect(chip.tag).not.toBe('button');
      expect((chip.ouvintes as Map<string, unknown[]>).get('click') ?? []).toHaveLength(0);
    }
    expect(porClasse(detalhe, 'tipo-migracao')).toHaveLength(1);
  });

  it('detalhe sem tipo, atendente ou palavras não quebra nem inventa linha', async () => {
    const painel = await painelComercial({
      '/api/meetings/reu-3': {
        corpo: {
          meeting: { id: 'reu-3', meetingCode: 'uvw-xyza-bcd', status: 'created', transcript: [] },
        },
      },
    });
    porClasse(painel.pegar('lista-reunioes'), 'item')[2]?.disparar('click');
    await painel.escoar();

    const detalhe = painel.pegar('detalhe-reuniao');
    expect(detalhe.textContent).toContain('uvw-xyza-bcd');
    expect(detalhe.textContent).not.toContain('Marcada por');
    expect(porClasse(detalhe, 'palavra')).toHaveLength(0);
  });

  it('palavras fora do contrato (não string[]) viram lista vazia', async () => {
    const painel = await painelComercial({
      '/api/meetings/reu-1': {
        corpo: {
          meeting: {
            id: 'reu-1', meetingCode: 'abc-defg-hij', status: 'done',
            palavras: 'IA, Oficial', transcript: [],
          },
        },
      },
    });
    porClasse(painel.pegar('lista-reunioes'), 'item')[0]?.disparar('click');
    await painel.escoar();

    expect(porClasse(painel.pegar('detalhe-reuniao'), 'palavra')).toHaveLength(0);
  });
});

describe('painel — armadilhas do template literal', () => {
  const html = reviewPageHtml();

  it('não deixa interpolação de template literal vazar pro HTML', () => {
    expect(html).not.toContain('${');
    expect(html).not.toContain('`');
  });

  it('não usa innerHTML em lugar nenhum', () => {
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('outerHTML');
    expect(html).not.toContain('insertAdjacentHTML');
  });

  it('mantém a identidade chatPro e os dois temas', () => {
    expect(html).toContain('#25D066');
    expect(html).toContain('prefers-color-scheme: light');
    expect(html).not.toContain('ChatPro');
    expect(html).not.toContain('Chat Pro');
  });
});
