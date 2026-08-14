import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * `scripts/testar-painel.mjs` existe pra impedir UM erro específico: alguém
 * preencher PAINEL_API_URL com um endereço que serve o site em vez da API. Se
 * ele mesmo se enganar, o estrago é maior do que não ter script nenhum — o
 * atendente só descobre na hora de marcar a reunião com o cliente esperando.
 *
 * O script é uma CLI, então não tem como injetar `fetchImpl` como nos clientes
 * do servidor. O `fetch` global é trocado antes da carga, via `node --import`
 * (server/test/fixtures/fetch-falso-painel.mjs): a suíte não abre socket nenhum,
 * nem pra loopback.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(RAIZ, 'scripts', 'testar-painel.mjs');
const FONTE = readFileSync(SCRIPT, 'utf8');
const PRELOAD = pathToFileURL(
  path.join(RAIZ, 'server', 'test', 'fixtures', 'fetch-falso-painel.mjs')
).href;

/** Sem isto as cores viram lixo no meio das frases que o teste procura. */
// eslint-disable-next-line no-control-regex
const semCores = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

interface Execucao {
  saida: string;
  codigo: number | null;
}

function rodarEm(url: string, roteiro: Record<string, unknown>, ...args: string[]): Execucao {
  const r = spawnSync(process.execPath, ['--import', PRELOAD, SCRIPT, url, ...args], {
    cwd: RAIZ,
    encoding: 'utf8',
    env: { ...process.env, RESPOSTAS_PAINEL: JSON.stringify(roteiro) },
  });
  return { saida: semCores(`${r.stdout ?? ''}${r.stderr ?? ''}`), codigo: r.status };
}

function rodar(roteiro: Record<string, unknown>, ...args: string[]): Execucao {
  return rodarEm('https://painel.exemplo.com.br', roteiro, ...args);
}

const VERDE_TOTAL = 'todas as camadas passaram';
const API_DE_VERDADE = { status: 200, json: { status: 'ok' } };

describe('scripts/testar-painel.mjs', () => {
  it('SPA respondendo tudo em HTML: acusa a página web e não manda preencher PAINEL_API_URL', () => {
    // É o caso REAL do app.chatpro.com.br: catch-all do Vercel devolve 200 +
    // HTML pra qualquer caminho, inclusive /api/naoexiste-xyz.
    const { saida, codigo } = rodar({ '/': { status: 200, html: true } });

    expect(saida).toContain('ESSE ENDEREÇO SERVE UMA PÁGINA WEB, NÃO A API.');
    expect(saida).toContain('também devolve HTTP 200 em HTML');
    expect(saida).toContain('NÃO preencha PAINEL_API_URL');
    expect(saida).not.toContain(VERDE_TOTAL);
    expect(codigo).toBe(1);
  });

  it('healthcheck em JSON mas retaguarda em HTML: reprova em vez de dar o verde', () => {
    // Deploy pela metade: só algumas rotas /api/* são funções de verdade e o
    // resto cai no SPA. Conferindo o status ANTES do content-type, o 200 + HTML
    // virava "✓ token aceito, 0 vendedor(es)" e o veredito saía verde.
    const { saida, codigo } = rodar(
      {
        '/api/healthcheck': API_DE_VERDADE,
        '/api/ext/agenda/me': {
          status: 200,
          json: { actor: { name: 'Fulano', role: 'vendedor' }, capabilities: [] },
        },
        '/api/retaguarda/vendedores': { status: 200, html: true },
        '/api/ext/agenda/available-slots': { status: 200, html: true },
        '/': { status: 200, json: { status: 'ok' } },
      },
      'fulano@empresa.com'
    );

    expect(saida).not.toContain(VERDE_TOTAL);
    expect(saida).not.toContain('vendedor(es) ativo(s)');
    expect(codigo).toBe(1);
  });

  it('grade de horários em HTML não vira "0 horário(s) livre(s)"', () => {
    // available_slots indefinido daria lista vazia, e lista vazia é tratada
    // como dia sem vaga — um defeito de endereço passaria por feriado.
    const { saida, codigo } = rodar(
      {
        '/api/healthcheck': API_DE_VERDADE,
        '/api/ext/agenda/me': {
          status: 200,
          json: { actor: { name: 'Fulano', role: 'vendedor' }, capabilities: [] },
        },
        '/api/retaguarda/vendedores': { status: 200, json: { data: [{ id: 1 }] } },
        '/api/ext/agenda/available-slots': { status: 200, html: true },
        '/': { status: 200, json: { status: 'ok' } },
      },
      'fulano@empresa.com'
    );

    expect(saida).toContain('a grade veio como página web, não JSON');
    expect(saida).not.toContain('0 horário(s) livre(s)');
    expect(saida).not.toContain(VERDE_TOTAL);
    expect(codigo).toBe(1);
  });

  it('host que recusa conexão: explica o que fazer e para na camada 1', () => {
    const { saida, codigo } = rodar({ '/': { recusar: true } });

    expect(saida).toContain('o host existe mas recusou a conexão');
    expect(saida).toContain('Pare aqui');
    expect(saida).not.toContain(VERDE_TOTAL);
    expect(codigo).toBe(1);
  });

  it('nenhum token do painel aparece na saída, nem em pedaço', () => {
    // O script lê server/.env de verdade. Se um dia ele ecoar um corpo de erro
    // com o token dentro, é aqui que aparece.
    const env = (((): string => {
      try {
        return readFileSync(path.join(RAIZ, 'server', '.env'), 'utf8');
      } catch {
        return '';
      }
    })());

    const tokens: string[] = [];
    for (const chave of ['PAINEL_EXT_AGENDA_TOKEN', 'PAINEL_RETAGUARDA_TOKEN']) {
      const achado = new RegExp(`^\\s*(?:export\\s+)?${chave}\\s*=\\s*(.*)$`, 'm').exec(env);
      let valor = achado?.[1]?.trim() ?? '';
      if (valor.length >= 2 && /^(".*"|'.*')$/.test(valor)) valor = valor.slice(1, -1);
      if (valor.length >= 8) tokens.push(valor);
    }

    // O painel devolve o token no corpo do erro — o pior caso plausível.
    const { saida } = rodar(
      {
        '/api/healthcheck': API_DE_VERDADE,
        '/api/ext/agenda/me': {
          status: 500,
          json: { error: tokens[0] ?? 'token-de-mentira-para-o-teste' },
        },
        '/': { status: 200, json: { status: 'ok' } },
      },
      'fulano@empresa.com'
    );

    for (const token of tokens) {
      expect(saida).not.toContain(token);
      expect(saida).not.toContain(token.slice(0, 8));
    }
    // Sem .env na máquina não há segredo pra vazar, mas a censura tem que ter
    // rodado do mesmo jeito: o corpo do erro não pode sair cru.
    if (tokens.length === 0) expect(saida).not.toContain('token-de-mentira-para-o-teste');
  });

  it('o script nunca dispara POST: criar reunião de verdade avisa cliente e ocupa agenda', () => {
    expect(FONTE).not.toMatch(/method:\s*['"]POST['"]/i);
  });
});

/**
 * As camadas 3, 4 e 5 mandam `Authorization: Bearer <token>`. Sem TLS os dois
 * tokens do painel atravessam a rede corporativa legíveis, e quem os pegar
 * marca reunião em nome da equipe — reunião de verdade, com e-mail pro cliente
 * e agenda ocupada. Um script de diagnóstico não pode ser a causa do vazamento.
 */
describe('scripts/testar-painel.mjs — token nunca viaja sem TLS', () => {
  const PAINEL_SAUDAVEL = {
    '/api/healthcheck': API_DE_VERDADE,
    '/api/ext/agenda/me': {
      status: 200,
      json: { actor: { name: 'Fulano', role: 'vendedor' }, capabilities: [] },
    },
    '/api/retaguarda/vendedores': { status: 200, json: { data: [{ id: 1 }] } },
    '/api/ext/agenda/available-slots': { status: 200, json: { available_slots: ['09:00'] } },
    '/': API_DE_VERDADE,
  };

  it('http:// em host remoto: recusa as camadas com token mesmo com o painel inteiro de pé', () => {
    // Pior caso: tudo responderia certinho. Sem a trava, o script mandaria os
    // dois tokens em claro e ainda terminaria em verde recomendando a URL.
    const { saida, codigo } = rodarEm(
      'http://painel.exemplo.com.br',
      PAINEL_SAUDAVEL,
      'fulano@empresa.com'
    );

    expect(saida).toContain('CAMADAS 3, 4 e 5 — RECUSADAS');
    expect(saida).toContain('não mando token do painel por http://');
    expect(saida).toContain('texto claro');
    // Nenhuma camada com token chegou a rodar.
    expect(saida).not.toContain('token aceito');
    expect(saida).not.toContain('vendedor(es) ativo(s)');
    expect(saida).not.toContain('horário(s) livre(s)');
    expect(saida).not.toContain(VERDE_TOTAL);
    // E acima de tudo: não pode sair daqui uma linha de .env com http://.
    expect(saida).not.toContain('PAINEL_API_URL=http://');
    expect(codigo).toBe(1);
  });

  it('http:// remoto ainda diagnostica as camadas 1 e 2, que não mandam credencial', () => {
    // A trava é sobre token, não sobre curiosidade: quem digitou http:// merece
    // saber se o host sequer existe.
    const { saida } = rodarEm('http://painel.exemplo.com.br', PAINEL_SAUDAVEL);

    expect(saida).toContain('CAMADA 1');
    expect(saida).toContain('CAMADA 2');
    expect(saida).toContain('é uma API de verdade');
  });

  it('certificado inválido em host remoto: culpa o certificado e não oferece http://', () => {
    // Era o conselho anterior — e obedecer a ele mandava os dois tokens em claro.
    const { saida, codigo } = rodarEm('https://painel.exemplo.com.br', {
      '/': { certificado: true },
    });

    expect(saida).toContain('o certificado HTTPS não confere');
    expect(saida).toContain('O problema é o CERTIFICADO, não o protocolo.');
    expect(saida).toContain('CA da empresa');
    expect(saida).toContain('rede/VPN onde o certificado vale');
    // Toda menção a http:// tem que ser proibição, nunca sugestão — é a linha
    // que a pessoa vai copiar. ('https://' não casa com 'http://'.)
    const linhasComHttp = saida.split('\n').filter((linha) => linha.includes('http://'));
    expect(linhasComHttp).toHaveLength(1);
    expect(linhasComHttp[0]).toContain('NÃO caia pra http://');
    expect(codigo).toBe(1);
  });

  it('certificado inválido em localhost: aí sim pode sugerir http://', () => {
    // Painel de desenvolvimento em HTTP puro é o caso normal, e o tráfego não
    // sai da máquina: negar http:// aqui só ensinaria a ignorar o aviso.
    const { saida } = rodarEm('https://localhost:3333', { '/': { certificado: true } });

    expect(saida).toContain('o certificado HTTPS não confere');
    expect(saida).toContain('escrevendo http:// na frente');
    expect(saida).toContain('não sai da máquina');
  });

  it('host local sem esquema continua indo pra http, e host remoto pra https', () => {
    expect(rodarEm('localhost:3000', { '/': { recusar: true } }).saida).toContain(
      'Alvo: http://localhost:3000'
    );
    expect(rodarEm('painel.exemplo.com.br', { '/': { recusar: true } }).saida).toContain(
      'Alvo: https://painel.exemplo.com.br'
    );
    // "parece local" não é local: subdomínio de terceiro tem que virar https.
    expect(rodarEm('localhost.exemplo.com.br', { '/': { recusar: true } }).saida).toContain(
      'Alvo: https://localhost.exemplo.com.br'
    );
  });
});
