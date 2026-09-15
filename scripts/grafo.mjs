/**
 * Consulta o cérebro visual SEMPRE atualizado: regenera antes, se o código mudou.
 *
 *   node scripts/grafo.mjs explain "passoDados"
 *   node scripts/grafo.mjs affected "PainelClient"
 *   node scripts/grafo.mjs path "main" "PainelClient"
 *   node scripts/grafo.mjs god-nodes
 *
 * Por que existe: grafo desatualizado é pior que grafo nenhum. Ele responde
 * com a mesma confiança sobre um código que já mudou — "ninguém chama esta
 * função", dito sobre a versão de ontem. Aqui, se qualquer arquivo de código
 * for mais novo que o grafo, ele é regenerado ANTES da resposta (~6 s,
 * medido em 15/09/2026).
 *
 * `query` fica de fora de propósito. Medido neste repositório: a pergunta
 * "como o CNPJ preenche a razão social" trouxe .preencherSessionId() e
 * RecallQueueWorker — ele casa pedaço de palavra, não sentido.
 *
 * Quando usar o grafo e quando usar grep: .claude/skills/grafo/SKILL.md.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { RAIZ, arquivosDeCodigo } from './grafo-fontes.mjs';

const GRAFO = join(RAIZ, 'grafo', 'graph.json');
const PERMITIDOS = new Set(['explain', 'affected', 'path', 'god-nodes']);
const [comando, ...resto] = process.argv.slice(2);

if (!PERMITIDOS.has(comando)) {
  console.log('uso: node scripts/grafo.mjs <comando> ...');
  console.log('  explain "passoDados"               o que a função contém e chama');
  console.log('  affected "PainelClient"            o que depende disto (antes de mudar)');
  console.log('  path "main" "PainelClient"         como uma coisa chega na outra');
  console.log('  god-nodes                          os nós mais conectados');
  console.log('\n"query" fica de fora: medido aqui, casa pedaço de palavra, não sentido.');
  process.exit(comando ? 1 : 0);
}

function mtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// ── Grafo velho? Regenera antes de responder ──────────────────────────────
const doGrafo = mtime(GRAFO);
let maisNovo = 0;
let qual = null;
for (const p of arquivosDeCodigo()) {
  const t = mtime(p);
  if (t > maisNovo) {
    maisNovo = t;
    qual = p;
  }
}

if (doGrafo === 0 || maisNovo > doGrafo) {
  // Pro stderr: o stdout é a resposta, e quem lê a resposta não pode confundir
  // o aviso de regeneração com um nó do grafo.
  console.error(
    doGrafo === 0
      ? '[grafo] ainda não existe — gerando (~6 s)...'
      : `[grafo] desatualizado (${relative(RAIZ, qual)} mudou) — regenerando (~6 s)...`
  );
  const g = spawnSync(process.execPath, [join(RAIZ, 'scripts', 'gerar-grafo.mjs')], {
    encoding: 'utf8',
  });
  if (g.status !== 0) {
    console.error(`${g.stdout ?? ''}${g.stderr ?? ''}`.trim());
    process.exit(1);
  }
}

// ── A consulta ────────────────────────────────────────────────────────────
const exe = join(
  homedir(),
  '.local',
  'bin',
  process.platform === 'win32' ? 'graphify.exe' : 'graphify'
);
const r = spawnSync(mtime(exe) ? exe : 'graphify', [comando, ...resto, '--graph', GRAFO], {
  encoding: 'utf8',
});
process.stdout.write(r.stdout ?? '');
if (r.stderr) process.stderr.write(r.stderr);
if (r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
