import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * O popup deixou de tratar a conta Google como a estrela: quem cria o link da
 * reunião é o painel. Estes testes seguram as duas decisões que a tela toma a
 * partir do diagnóstico:
 *
 *   1. o que aparece no lugar de honra (painel conectado / não configurado /
 *      o problema, em vermelho);
 *   2. se a conta Google fica recolhida (reserva) ou em destaque (é o caminho).
 *
 * Errar o item 2 tem custo real: são 5 a 12 atendentes, e um bloco "CONTA
 * GOOGLE" em destaque faz cada um deles achar que precisa conectar a sua antes
 * de conseguir trabalhar.
 *
 * Os arquivos da extensão são JS puro sem build, então são carregados e
 * avaliados aqui mesmo, com DOM e `chrome` de mentira. Nada de rede: o `fetch`
 * do service worker também é injetado.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FONTE_POPUP = readFileSync(path.join(RAIZ, 'extension', 'popup', 'popup.js'), 'utf8');
const HTML_POPUP = readFileSync(path.join(RAIZ, 'extension', 'popup', 'popup.html'), 'utf8');
const FONTE_WORKER = readFileSync(
  path.join(RAIZ, 'extension', 'background', 'service-worker.js'),
  'utf8'
);

// ─── DOM de mentira ──────────────────────────────────────────────────────────

interface ElementoFalso {
  textContent: string;
  value: string;
  open: boolean;
  classes: Set<string>;
  classList: {
    add: (...nomes: string[]) => void;
    remove: (...nomes: string[]) => void;
    toggle: (nome: string, forca?: boolean) => boolean;
    contains: (nome: string) => boolean;
  };
  addEventListener: (evento: string, ouvinte: (e: unknown) => void) => void;
}

function criarElemento(): ElementoFalso {
  const classes = new Set<string>();
  return {
    textContent: '',
    value: '',
    open: false,
    classes,
    classList: {
      add: (...nomes: string[]): void => {
        for (const n of nomes) classes.add(n);
      },
      remove: (...nomes: string[]): void => {
        for (const n of nomes) classes.delete(n);
      },
      toggle: (nome: string, forca?: boolean): boolean => {
        const ligar = forca === undefined ? !classes.has(nome) : forca;
        if (ligar) classes.add(nome);
        else classes.delete(nome);
        return ligar;
      },
      contains: (nome: string): boolean => classes.has(nome),
    },
    addEventListener: (): void => {},
  };
}

/**
 * Só existem os ids que estão de fato no popup.html.
 *
 * Um id renomeado no HTML e esquecido no JS não dá erro de sintaxe — dá
 * `null.textContent` na hora que o atendente abre o popup. Aqui isso vira
 * teste vermelho.
 */
function idsDoHtml(): string[] {
  const ids: string[] = [];
  const padrao = /id="([^"]+)"/g;
  let achado = padrao.exec(HTML_POPUP);
  while (achado !== null) {
    if (achado[1] !== undefined) ids.push(achado[1]);
    achado = padrao.exec(HTML_POPUP);
  }
  return ids;
}

async function esperarBoot(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((ok) => setTimeout(ok, 0));
}

interface RespostasFalsas {
  PAINEL_STATUS?: unknown;
  STATUS_GOOGLE?: unknown;
  falharEnvio?: boolean;
}

interface PopupMontado {
  el: (id: string) => ElementoFalso;
}

async function montarPopup(respostas: RespostasFalsas): Promise<PopupMontado> {
  const elementos = new Map<string, ElementoFalso>();
  for (const id of idsDoHtml()) elementos.set(id, criarElemento());

  const documentoFalso = {
    getElementById: (id: string): ElementoFalso | null => elementos.get(id) ?? null,
  };

  const chromeFalso = {
    storage: {
      local: {
        get: async (): Promise<Record<string, string>> => ({}),
        set: async (): Promise<void> => {},
      },
    },
    runtime: {
      sendMessage: async (msg: { tipo: string }): Promise<unknown> => {
        if (respostas.falharEnvio) throw new Error('Receiving end does not exist.');
        if (msg.tipo === 'PAINEL_STATUS') return respostas.PAINEL_STATUS;
        if (msg.tipo === 'STATUS_GOOGLE') {
          return respostas.STATUS_GOOGLE ?? { ok: true, dados: { configurado: true, conectado: false } };
        }
        return { ok: true };
      },
    },
  };

  const fabrica = new Function(
    'document',
    'chrome',
    'window',
    'setTimeout',
    `${FONTE_POPUP}\nreturn {};`
  ) as (doc: unknown, api: unknown, janela: unknown, timer: unknown) => unknown;

  fabrica(documentoFalso, chromeFalso, { close: (): void => {} }, setTimeout);
  await esperarBoot();

  return {
    el: (id: string): ElementoFalso => {
      const achado = elementos.get(id);
      if (!achado) throw new Error(`popup.html não tem o id "${id}".`);
      return achado;
    },
  };
}

// ─── Popup ───────────────────────────────────────────────────────────────────

describe('popup: estado do painel no lugar de honra', () => {
  it('painel respondendo: mostra "conectado" em verde e recolhe a conta Google como reserva', async () => {
    const popup = await montarPopup({
      PAINEL_STATUS: { ok: true, status: 200, dados: { configurado: true, ok: true } },
    });

    expect(popup.el('painel-valor').textContent).toBe('conectado');
    expect(popup.el('painel-linha').classes.has('ok')).toBe(true);
    expect(popup.el('painel-linha').classes.has('erro')).toBe(false);

    const bloco = popup.el('google-bloco');
    expect(bloco.open).toBe(false);
    expect(bloco.classes.has('destaque')).toBe(false);
    expect(popup.el('google-tag').classes.has('oculto')).toBe(false);
    expect(popup.el('google-ajuda').textContent).toContain('não precisa conectar');
  });

  it('diagnóstico que só checou o healthcheck ainda é "conectado", não alarme', async () => {
    // É a resposta REAL do dia a dia: o popup não sabe o e-mail do atendente
    // (quem descobre isso é o content script), então o servidor para no passo 1
    // e devolve ok:true COM uma ressalva em `detalhe`. Ressalva não é defeito —
    // pintar isso de vermelho poria a conta Google de volta no caminho à toa.
    const popup = await montarPopup({
      PAINEL_STATUS: {
        ok: true,
        status: 200,
        dados: {
          configurado: true,
          ok: true,
          detalhe: 'só o /api/healthcheck foi verificado: sem um actor_email válido…',
        },
      },
    });

    expect(popup.el('painel-valor').textContent).toBe('conectado');
    expect(popup.el('painel-linha').classes.has('erro')).toBe(false);
    expect(popup.el('google-bloco').classes.has('destaque')).toBe(false);
  });

  it('painel sem endereço configurado: fica cinza e devolve o destaque pra conta Google', async () => {
    const popup = await montarPopup({
      PAINEL_STATUS: { ok: true, status: 200, dados: { configurado: false } },
    });

    expect(popup.el('painel-valor').textContent).toBe('não configurado');
    expect(popup.el('painel-detalhe').textContent).toContain('conta Google');
    expect(popup.el('google-bloco').classes.has('destaque')).toBe(true);
  });

  it('não configurado: repassa a frase do diagnóstico, que nomeia a variável que falta', async () => {
    // Contrato real de GET /api/painel/diagnostico: {configurado, ok, problema, detalhe}.
    const popup = await montarPopup({
      PAINEL_STATUS: {
        ok: true,
        status: 200,
        dados: {
          configurado: false,
          ok: false,
          problema: 'sem-url',
          detalhe: 'PAINEL_API_URL não está definida no .env do servidor.',
        },
      },
    });

    expect(popup.el('painel-valor').textContent).toBe('não configurado');
    expect(popup.el('painel-linha').classes.has('ok')).toBe(false);
    expect(popup.el('painel-linha').classes.has('erro')).toBe(false);
    expect(popup.el('painel-linha').classes.has('neutro')).toBe(true);
    // A frase do servidor (pra quem instala) e a saída (pra quem atende).
    expect(popup.el('painel-detalhe').textContent).toContain('PAINEL_API_URL');
    expect(popup.el('painel-detalhe').textContent).toContain('conta Google');

    const bloco = popup.el('google-bloco');
    expect(bloco.open).toBe(true);
    expect(bloco.classes.has('destaque')).toBe(true);
    expect(popup.el('google-tag').classes.has('oculto')).toBe(true);
    expect(popup.el('google-ajuda').textContent).toContain('link da reunião é criado');
  });

  it('painel configurado mas fora do ar: mostra a mensagem do problema em vermelho', async () => {
    const popup = await montarPopup({
      PAINEL_STATUS: {
        ok: true,
        status: 200,
        dados: {
          configurado: true,
          ok: false,
          problema: 'nao-alcancavel',
          detalhe: 'o endereço respondeu, mas /api/healthcheck deu HTTP 502.',
        },
      },
    });

    expect(popup.el('painel-valor').textContent).toBe(
      'o endereço respondeu, mas /api/healthcheck deu HTTP 502.'
    );
    expect(popup.el('painel-linha').classes.has('erro')).toBe(true);
    // Quebrado é igual a ausente pro atendente: sem painel, a conta Google é o caminho.
    expect(popup.el('google-bloco').classes.has('destaque')).toBe(true);
    expect(popup.el('painel-detalhe').textContent).toContain('conta Google');
  });

  it('servidor antigo (rota ainda não existe): não acusa problema, só admite que não sabe', async () => {
    const popup = await montarPopup({ PAINEL_STATUS: { ok: false, semRota: true } });

    expect(popup.el('painel-valor').textContent).toBe('não dá pra verificar');
    expect(popup.el('painel-linha').classes.has('erro')).toBe(false);
    expect(popup.el('painel-detalhe').textContent).toContain('Atualize o servidor');
    expect(popup.el('google-bloco').classes.has('destaque')).toBe(true);
  });

  it('servidor inalcançável: repassa o motivo e mantém a conta Google em destaque', async () => {
    const popup = await montarPopup({
      PAINEL_STATUS: { ok: false, erro: 'Não consegui alcançar o servidor em http://localhost:3333.' },
    });

    expect(popup.el('painel-valor').textContent).toBe('não dá pra verificar');
    expect(popup.el('painel-detalhe').textContent).toContain('localhost:3333');
    expect(popup.el('google-bloco').classes.has('destaque')).toBe(true);
  });

  it('resposta que não é a nossa rota (HTML de SPA): aponta o campo Endereço, não o painel', async () => {
    const popup = await montarPopup({
      PAINEL_STATUS: { ok: true, status: 200, dados: { error: '<!doctype html><html>…' } },
    });

    expect(popup.el('painel-valor').textContent).toBe('não dá pra verificar');
    expect(popup.el('painel-detalhe').textContent).toContain('Endereço');
    expect(popup.el('google-bloco').classes.has('destaque')).toBe(true);
  });

  it('401 do nosso servidor: manda conferir a Chave do painel, que está na mesma tela', async () => {
    const popup = await montarPopup({
      PAINEL_STATUS: { ok: false, status: 401, dados: { error: 'Não autorizado.' } },
    });

    expect(popup.el('painel-detalhe').textContent).toContain('Chave do painel');
    expect(popup.el('google-bloco').classes.has('destaque')).toBe(true);
  });

  it('service worker dormindo (sendMessage estoura): a tela não quebra e cai no caminho antigo', async () => {
    const popup = await montarPopup({ falharEnvio: true });

    expect(popup.el('painel-valor').textContent).toBe('não dá pra verificar');
    expect(popup.el('google-bloco').classes.has('destaque')).toBe(true);
  });
});

// ─── Service worker ──────────────────────────────────────────────────────────

interface RespostaHttpFalsa {
  status: number;
  corpo: string;
}

type Ouvinte = (
  msg: unknown,
  remetente: unknown,
  responder: (resposta: unknown) => void
) => boolean;

async function perguntarAoWorker(
  msg: unknown,
  http: RespostaHttpFalsa,
  urlsChamadas: string[]
): Promise<Record<string, unknown>> {
  let ouvinte: Ouvinte | null = null;

  const chromeFalso = {
    storage: {
      local: {
        get: async (): Promise<Record<string, string>> => ({
          backendUrl: 'http://localhost:3333',
          panelToken: 'chave-secreta',
        }),
        set: async (): Promise<void> => {},
      },
      sync: {
        get: async (): Promise<Record<string, string>> => ({ deviceId: 'dispositivo-1' }),
        set: async (): Promise<void> => {},
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn: Ouvinte): void => {
          ouvinte = fn;
        },
      },
    },
    tabs: { create: async (): Promise<void> => {} },
  };

  const fetchFalso = async (url: string): Promise<unknown> => {
    urlsChamadas.push(url);
    return {
      status: http.status,
      ok: http.status >= 200 && http.status < 300,
      text: async (): Promise<string> => http.corpo,
    };
  };

  const fabrica = new Function('chrome', 'fetch', 'crypto', `${FONTE_WORKER}\nreturn {};`) as (
    api: unknown,
    buscar: unknown,
    cripto: unknown
  ) => unknown;
  fabrica(chromeFalso, fetchFalso, { randomUUID: (): string => 'dispositivo-1' });

  const registrado = ouvinte as Ouvinte | null;
  if (!registrado) throw new Error('service worker não registrou o listener de mensagens.');

  return new Promise<Record<string, unknown>>((resolver) => {
    registrado(msg, {}, (resposta) => resolver(resposta as Record<string, unknown>));
  });
}

describe('service worker: PAINEL_STATUS', () => {
  it('repassa o diagnóstico do servidor', async () => {
    const urls: string[] = [];
    const r = await perguntarAoWorker(
      { tipo: 'PAINEL_STATUS' },
      { status: 200, corpo: JSON.stringify({ configurado: true, ok: true }) },
      urls
    );

    expect(urls).toEqual(['http://localhost:3333/api/painel/diagnostico']);
    expect(r.ok).toBe(true);
    expect(r.dados).toEqual({ configurado: true, ok: true });
  });

  it('404 vira "não sei" (semRota), nunca um erro do painel', async () => {
    // Servidor mais antigo que a rota. Tratar isso como painel quebrado mandaria
    // a pessoa caçar um defeito que não existe.
    const r = await perguntarAoWorker(
      { tipo: 'PAINEL_STATUS' },
      { status: 404, corpo: JSON.stringify({ error: 'Not Found' }) },
      []
    );

    expect(r.semRota).toBe(true);
    expect(r.dados).toBeUndefined();
  });

  it('resposta sem JSON não estoura: vira corpo com o texto recortado', async () => {
    const r = await perguntarAoWorker(
      { tipo: 'PAINEL_STATUS' },
      { status: 200, corpo: '<!doctype html><html>painel</html>' },
      []
    );

    expect(r.ok).toBe(true);
    expect((r.dados as { error?: string }).error).toContain('doctype');
  });

  it('nada do que o worker devolve carrega a chave do painel', async () => {
    const r = await perguntarAoWorker(
      { tipo: 'PAINEL_STATUS' },
      { status: 200, corpo: JSON.stringify({ configurado: true, ok: true }) },
      []
    );

    expect(JSON.stringify(r)).not.toContain('chave-secreta');
  });
});
