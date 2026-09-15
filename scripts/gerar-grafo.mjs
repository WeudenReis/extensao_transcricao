/**
 * Gera o CÉREBRO VISUAL do repositório com o Graphify: grafo/graph.html.
 *
 *   node scripts/gerar-grafo.mjs
 *
 * Pré-requisito, uma vez só: `uv tool install graphifyy` (com dois "y" — é o
 * nome oficial no PyPI, apontado pelo próprio repositório Graphify-Labs).
 *
 * Diferente do docs/MAPA.md (índice enxuto, pensado pra consulta rápida), isto
 * liga cada função, classe e import num grafo navegável. Não se atualiza
 * sozinho: rode de novo depois de mudar o código.
 *
 * Três decisões que moram aqui:
 *
 * 1. PASTA LIMPA. O Graphify não documenta modo só-código nem arquivo de
 *    ignore, e processa docs/PDF/imagem com um LLM quando os encontra. Em vez
 *    de confiar em comportamento não documentado, copiamos só .ts/.js/.mjs de
 *    código pra uma pasta temporária: sem .env, sem .md, sem banco. Nada
 *    sensível pode ser lido, e nada que dispare chamada a IA existe ali.
 *
 * 2. SEM LLM. `update --no-cluster` extrai com tree-sitter, localmente, e
 *    `cluster-only --no-label` agrupa sem pedir nomes a uma IA. As chaves de
 *    API ainda são retiradas do ambiente do processo, por garantia: nem nome
 *    de função sai da máquina.
 *
 * 3. NOMES A PARTIR DO CÓDIGO. Sem IA os grupos saem "Community 0, 1, 2...",
 *    e o grafo fica ilegível. Cada grupo recebe a ÁREA e o ARQUIVO que
 *    dominam seus nós, mais o nó mais conectado quando ele não é o próprio
 *    arquivo.
 *
 *    O que NÃO é estável é o AGRUPAMENTO: o algoritmo de comunidades do
 *    Graphify tem sorteio, e duas execuções seguidas sobre o mesmo código
 *    deram 42 e 50 grupos (medido em 15/09/2026). Os nós e as conexões não
 *    mudam; o que muda é onde as fronteiras entre grupos caem. Então não
 *    compare número de grupos entre execuções como se fosse métrica.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

const RAIZ = join(import.meta.dirname, '..');
const PASTAS = [
  'server/src',
  'extension/content',
  'extension/background',
  'extension/popup',
  'scripts',
];
// O nome da pasta de palco vira o prefixo dos caminhos dentro do grafo.
const NOME = 'extensao_transcricao';
const TMP = join(tmpdir(), 'grafo-extensao');
const PALCO = join(TMP, NOME);
const SAIDA = join(RAIZ, 'grafo');

// ── 1. Palco só com código ────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });
mkdirSync(PALCO, { recursive: true });

let copiados = 0;
function copiar(dir) {
  for (const item of readdirSync(dir)) {
    const p = join(dir, item);
    if (/node_modules|[\\/]dist$|[\\/]data$/.test(p)) continue;
    if (statSync(p).isDirectory()) {
      copiar(p);
    } else if (/\.(ts|js|mjs)$/.test(item) && !/\.test\.ts$/.test(item)) {
      const destino = join(PALCO, relative(RAIZ, p));
      mkdirSync(dirname(destino), { recursive: true });
      cpSync(p, destino);
      copiados += 1;
    }
  }
}
for (const pasta of PASTAS) copiar(join(RAIZ, pasta));

// ── Trava: confere o que está NO PALCO, não o que foi filtrado ────────────
// O filtro acima já deveria bastar. A checagem existe pelo mesmo motivo da
// trava do empacotador: filtro que falha em silêncio só é descoberto depois
// que o estrago aconteceu.
const proibidos = [];
(function varrer(dir) {
  for (const item of readdirSync(dir)) {
    const p = join(dir, item);
    if (statSync(p).isDirectory()) {
      varrer(p);
      continue;
    }
    if (!/\.(ts|js|mjs)$/.test(item)) proibidos.push(relative(PALCO, p));
    // Padrões de VALOR de segredo (não o nome da variável): whsec do Svix,
    // token de retaguarda do painel, client secret do Google.
    const texto = readFileSync(p, 'utf8');
    if (/whsec_[A-Za-z0-9+/=]{16,}|ctp_in_[0-9a-f]{20,}|GOCSPX-[A-Za-z0-9_-]{10,}/.test(texto)) {
      proibidos.push(`${relative(PALCO, p)} (parece conter o valor de um segredo)`);
    }
  }
})(PALCO);
if (proibidos.length > 0) {
  console.log('ABORTADO: o palco tem arquivo que não devia ir pro grafo:');
  for (const x of proibidos) console.log(`   - ${x}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

// ── 2. Graphify, sem LLM ──────────────────────────────────────────────────
const env = { ...process.env };
for (const chave of [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
]) {
  delete env[chave];
}
// O `uv tool install` põe o executável em ~/.local/bin, que nem sempre está
// no PATH de quem roda o script.
env.PATH = `${join(homedir(), '.local', 'bin')}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`;

// Chamado pelo CAMINHO do executável, sem `shell: true`: com shell o Node
// concatena os argumentos sem escapar (aviso DEP0190). Os nossos são
// constantes, mas não há motivo pra deixar essa porta aberta. Sem o arquivo
// no lugar padrão do uv, cai no nome puro e deixa o PATH resolver.
const EXECUTAVEL = join(
  homedir(),
  '.local',
  'bin',
  process.platform === 'win32' ? 'graphify.exe' : 'graphify'
);
function existe(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function graphify(args) {
  const alvo = existe(EXECUTAVEL) ? EXECUTAVEL : 'graphify';
  const r = spawnSync(alvo, args, { cwd: TMP, env, encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(`\ngraphify ${args.join(' ')} falhou (código ${r.status}).`);
    if (r.error) console.log(r.error.message);
    console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim());
    console.log('\nSe o comando não existe: uv tool install graphifyy');
    rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
}

console.log(`Palco: ${copiados} arquivos de código. Extraindo (tree-sitter, local)...`);
graphify(['update', NOME, '--no-cluster']);
console.log('Agrupando (sem nomeação por IA)...');
graphify(['cluster-only', NOME, '--no-label']);

// ── 3. Nomes dos grupos, a partir do código ───────────────────────────────
const OUT = join(PALCO, 'graphify-out');
const grafo = JSON.parse(readFileSync(join(OUT, 'graph.json'), 'utf8'));

const grau = new Map();
for (const l of grafo.links) {
  grau.set(l.source, (grau.get(l.source) ?? 0) + 1);
  grau.set(l.target, (grau.get(l.target) ?? 0) + 1);
}

const porGrupo = new Map();
for (const n of grafo.nodes) {
  if (!porGrupo.has(n.community)) porGrupo.set(n.community, []);
  porGrupo.get(n.community).push(n);
}

const AREAS = {
  painel: 'Painel',
  routes: 'Rotas',
  pipeline: 'Pipeline',
  google: 'Google',
  recall: 'Recall',
  chatpro: 'chatPro',
  resumo: 'Resumo',
  stt: 'STT',
  voreo: 'Voreo',
  palavras: 'Palavras',
};

function areaDe(arquivo) {
  // extensao_transcricao/server/src/painel/client.ts
  const partes = arquivo.split('/');
  if (partes[1] === 'extension') return 'Extensão';
  if (partes[1] === 'scripts') return 'Script';
  if (partes[1] === 'server') {
    if (partes.length === 4) return 'Servidor'; // server/src/db.ts
    return AREAS[partes[3]] ?? partes[3];
  }
  return 'Outro';
}

// Nome entra em JSON e em HTML: sem aspas, sinais de tag nem barra invertida.
const limpar = (t) => String(t).replace(/["'<>&\\]/g, '');

const nomes = new Map();
const usados = new Map();
for (const c of [...porGrupo.keys()].sort((a, b) => a - b)) {
  const membros = porGrupo.get(c);
  const contagem = new Map();
  for (const n of membros) {
    const f = String(n.source_file ?? '').replace(/\\/g, '/');
    contagem.set(f, (contagem.get(f) ?? 0) + 1);
  }
  const [arquivo] = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0];
  const hub = membros
    .slice()
    .sort((a, b) => (grau.get(b.id) ?? 0) - (grau.get(a.id) ?? 0))[0];
  // Hub que é o próprio arquivo ("reunioes.ts") repetiria o nome à toa.
  const hubEhArquivo = /\.(ts|js|mjs)$/.test(hub.label);
  let nome = `${areaDe(arquivo)} · ${basename(arquivo)}${hubEhArquivo ? '' : ` · ${hub.label}`}`;
  nome = limpar(nome);
  const vezes = (usados.get(nome) ?? 0) + 1;
  usados.set(nome, vezes);
  if (vezes > 1) nome += ` (${vezes})`;
  nomes.set(c, nome);
}

for (const n of grafo.nodes) n.community_name = nomes.get(n.community) ?? n.community_name;
writeFileSync(join(OUT, 'graph.json'), JSON.stringify(grafo));

// "Community 1" é prefixo de "Community 10": o (?!\d) impede a troca errada.
const trocarNomes = (texto) =>
  texto.replace(/Community (\d+)(?!\d)/g, (inteiro, id) => nomes.get(Number(id)) ?? inteiro);
for (const arq of ['graph.html', 'GRAPH_REPORT.md']) {
  const p = join(OUT, arq);
  writeFileSync(p, trocarNomes(readFileSync(p, 'utf8')));
}

// ── 4. Pro repositório (a pasta grafo/ é ignorada pelo git) ───────────────
rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(SAIDA, { recursive: true });
for (const arq of ['graph.html', 'graph.json', 'GRAPH_REPORT.md']) {
  cpSync(join(OUT, arq), join(SAIDA, arq));
}
// Nenhuma cópia do código fica esquecida na pasta temporária.
rmSync(TMP, { recursive: true, force: true });

console.log(
  `\nPronto: ${grafo.nodes.length} nós, ${grafo.links.length} conexões, ${nomes.size} grupos.`
);
console.log(`Abra: ${join(SAIDA, 'graph.html')}`);
