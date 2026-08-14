import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * `scripts/testar.mjs` roda contra PRODUÇÃO — não existe sparks de teste nem
 * sala de Meet de mentira. Dois acidentes já moravam nele:
 *
 *   1. `--sessao=UUID` (um valor de DIAGNÓSTICO) postava '🧪 Teste da
 *      integração' na conversa de um cliente real, sem perguntar. Comentário no
 *      atendimento não dá pra desfazer pela API.
 *   2. `--recall` sem `--meet=` usava 'meet.google.com/abc-defg-hij' como
 *      padrão. Aquilo não é placeholder: é um código de sala VÁLIDO, que pode
 *      ser a reunião de outra empresa — e cada bot ainda queima crédito do
 *      Recall (US$ 0,65/h depois das 5 h iniciais).
 *
 * O que este arquivo garante é o NÃO-ACONTECIMENTO. Por isso o preload
 * (fixtures/fetch-falso-testar.mjs) imprime cada chamada: a asserção é sobre a
 * requisição que não saiu, não sobre a frase que apareceu na tela.
 *
 * O script é copiado pra uma pasta temporária com um .env de mentira porque ele
 * lê `server/.env` pelo caminho do próprio arquivo. Assim o teste é o mesmo em
 * qualquer máquina e nunca encosta nos tokens de verdade.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_REAL = path.join(RAIZ, 'scripts', 'testar.mjs');
const FONTE = readFileSync(SCRIPT_REAL, 'utf8');
const PRELOAD = pathToFileURL(
  path.join(RAIZ, 'server', 'test', 'fixtures', 'fetch-falso-testar.mjs')
).href;

const TOKEN_FALSO = 'token-de-instancia-so-do-teste-987654';
const SESSAO = '00a6e78d-020a-401f-98b3-544e05b830b3';
const SALA_MINHA = 'https://meet.google.com/zzz-zzzz-zzz';

/** Endpoints do sparks, como aparecem na URL — o teste casa por pedaço. */
const USUARIOS = '/users/getAllInstanceUsers';
const SESSAO_POR_ID = '/sessions/getSessionById';
const COMENTAR = '/messages/addComments';
const ENVIAR = '/messages/sendMessage';
const CRIAR_BOT = 'recall.ai/api/v1/bot';

let pasta: string;
let script: string;

beforeAll(() => {
  pasta = mkdtempSync(path.join(tmpdir(), 'testar-mjs-'));
  mkdirSync(path.join(pasta, 'scripts'));
  mkdirSync(path.join(pasta, 'server'));
  script = path.join(pasta, 'scripts', 'testar.mjs');
  copyFileSync(SCRIPT_REAL, script);
  writeFileSync(
    path.join(pasta, 'server', '.env'),
    [
      `CHATPRO_INSTANCE_TOKEN=${TOKEN_FALSO}`,
      'CHATPRO_INSTANCE_ID=instancia-de-mentira',
      'CHATPRO_USER_ID=usuario-de-mentira',
      'CHATPRO_BASE_URL=https://sparks.exemplo.invalido',
      'CHATPRO_PROVIDER=whatsapp',
      'RECALL_API_KEY=chave-recall-de-mentira-987654',
      'RECALL_REGION=us-west-2',
      '',
    ].join('\n'),
    'utf8'
  );
});

afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

/** Sem isto as cores viram lixo no meio das frases que o teste procura. */
// eslint-disable-next-line no-control-regex
const semCores = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

interface Execucao {
  saida: string;
  codigo: number | null;
  /** Só as chamadas HTTP que o script tentou fazer. */
  chamadas: string[];
}

const RESPOSTAS_PADRAO: Record<string, unknown> = {
  [USUARIOS]: { status: 200, json: [] },
  [SESSAO_POR_ID]: { status: 200, json: { session: { provider: 'cloud' } } },
  [COMENTAR]: { status: 200, json: { ok: true } },
  [ENVIAR]: { status: 200, json: { ok: true } },
  [CRIAR_BOT]: { status: 201, json: { id: 'bot-de-mentira' } },
};

function rodar(args: string[], respostas: Record<string, unknown> = {}): Execucao {
  const r = spawnSync(process.execPath, ['--import', PRELOAD, script, ...args], {
    cwd: pasta,
    encoding: 'utf8',
    env: {
      ...process.env,
      RESPOSTAS_TESTAR: JSON.stringify({ ...RESPOSTAS_PADRAO, ...respostas }),
    },
  });
  const saida = semCores(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return {
    saida,
    codigo: r.status,
    chamadas: saida.split('\n').filter((l) => l.startsWith('CHAMADA ')),
  };
}

const chamou = (e: Execucao, pedaco: string): boolean =>
  e.chamadas.some((l) => l.includes(pedaco));

describe('scripts/testar.mjs — só escreve quando mandam escrever', () => {
  it('--sessao sozinho NÃO posta comentário na conversa do cliente', () => {
    const e = rodar([`--sessao=${SESSAO}`]);

    // O que importa: a requisição não saiu.
    expect(chamou(e, COMENTAR)).toBe(false);
    expect(chamou(e, ENVIAR)).toBe(false);
    // E o script leu a sessão de verdade, em vez de só não fazer nada.
    expect(chamou(e, SESSAO_POR_ID)).toBe(true);
    expect(e.saida).toContain('sessão encontrada');
    expect(e.saida).toContain('Nada foi escrito na conversa');
    expect(e.codigo).toBe(0);
  });

  it('--sessao sozinho diz qual comentário ele postaria e como pedir isso', () => {
    // Diagnóstico que se recusa a agir só serve se contar o que faria.
    const e = rodar([`--sessao=${SESSAO}`]);

    expect(e.saida).toContain('🧪 Teste da integração de reuniões.');
    expect(e.saida).toContain(`node scripts/testar.mjs --sessao=${SESSAO} --comentar`);
    expect(e.saida).toContain('não dá pra apagar pela API');
    expect(chamou(e, COMENTAR)).toBe(false);
  });

  it('--comentar (a flag de ação) posta o comentário de verdade', () => {
    const e = rodar([`--sessao=${SESSAO}`, '--comentar']);

    expect(chamou(e, COMENTAR)).toBe(true);
    expect(e.saida).toContain('veja o comentário');
    expect(e.codigo).toBe(0);
  });

  it('--comentar sem --sessao não escreve em conversa nenhuma', () => {
    // Sem alvo, a flag de ação não pode virar um chute de sessão.
    const e = rodar(['--comentar']);

    expect(chamou(e, COMENTAR)).toBe(false);
    expect(e.saida).toContain('só valem com --sessao');
  });

  it('a leitura da sessão resolve o provider, e o envio usa ele — não o palpite do .env', () => {
    // O provider é POR CONVERSA. Mandar o 'whatsapp' fixo do .env numa sessão
    // 'cloud' devolve "Provider está errado!" (HTTP 400).
    const e = rodar([`--sessao=${SESSAO}`, '--mensagem']);

    expect(e.saida).toContain("canal 'cloud'");
    const envio = e.chamadas.find((l) => l.includes(ENVIAR)) ?? '';
    expect(envio).toContain('"provider":"cloud"');
    expect(envio).not.toContain('"provider":"whatsapp"');
  });

  it('sessão que não existe reprova sem tentar escrever nela', () => {
    const e = rodar([`--sessao=${SESSAO}`], {
      [SESSAO_POR_ID]: { status: 404, json: { error: 'session not found' } },
    });

    expect(chamou(e, COMENTAR)).toBe(false);
    expect(e.saida).toContain('CHATPRO_INSTANCE_ID');
    expect(e.codigo).toBe(1);
  });

  it('token do .env não vaza pro terminal nem quando volta no corpo do erro', () => {
    // O histórico do shell guarda a saída. Um corpo de erro que ecoe o token
    // transforma um diagnóstico em vazamento de credencial.
    const e = rodar([`--sessao=${SESSAO}`], {
      [SESSAO_POR_ID]: { status: 500, json: { error: `token invalido: ${TOKEN_FALSO}` } },
    });

    expect(e.saida).not.toContain(TOKEN_FALSO);
    expect(e.saida).toContain('«oculto»');
  });
});

describe('scripts/testar.mjs — nenhuma sala de reunião inventada', () => {
  it('--recall sem --meet RECUSA e não cria bot nenhum', () => {
    const e = rodar(['--recall']);

    expect(chamou(e, CRIAR_BOT)).toBe(false);
    expect(e.saida).toContain('--recall exige --meet=');
    expect(e.saida).toContain('Não existe sala padrão');
    expect(e.codigo).toBe(1);
  });

  it('a recusa explica o risco: sala de terceiros e crédito do Recall', () => {
    const e = rodar(['--recall']);

    expect(e.saida).toContain('reunião de outra empresa');
    expect(e.saida).toContain('US$ 0,65/h');
    expect(e.saida).toContain('meet.new');
  });

  it('--meet com código solto (sem link) é recusado em vez de virar URL torta', () => {
    const e = rodar(['--recall', '--meet=abc-defg-hij']);

    expect(chamou(e, CRIAR_BOT)).toBe(false);
    expect(e.saida).toContain('precisa ser o link inteiro da sala');
    expect(e.codigo).toBe(1);
  });

  it('--meet=<link> cria e remove o bot: a recusa é pela falta da flag, não bloco quebrado', () => {
    const e = rodar(['--recall', `--meet=${SALA_MINHA}`]);

    const criacao = e.chamadas.find((l) => l.includes(CRIAR_BOT)) ?? '';
    expect(criacao).toContain(`"meeting_url":"${SALA_MINHA}"`);
    expect(e.saida).toContain('bot criado');
    expect(e.saida).toContain('bot removido');
    expect(e.codigo).toBe(0);
  });

  it('meeting_url não tem valor padrão no fonte', () => {
    // Um `|| 'https://meet.google.com/...'` aqui é justamente o defeito: código
    // de Meet plausível é código de Meet válido.
    expect(FONTE).not.toMatch(/meeting_url:[^,\n]*\|\|/);
  });

  it('o cabeçalho não promete mais que "nada é destrutivo por padrão"', () => {
    // A frase antiga era falsa: --sessao escrevia. Cabeçalho que mente é pior
    // que cabeçalho nenhum, porque é lido como permissão.
    expect(FONTE).not.toContain('Nada aqui é destrutivo por padrão');
    expect(FONTE).toContain('--comentar');
  });
});
