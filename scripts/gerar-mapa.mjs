/**
 * Gera `docs/MAPA.md` — o índice do repositório.
 *
 * POR QUE EXISTE: achar código aqui custava vários `grep` seguidos, e cada um
 * traz linhas que entram no contexto e não saem mais. Um índice lido uma vez
 * responde "onde fica X" sem varredura.
 *
 * É gerado, não escrito à mão: mapa desatualizado é pior que mapa nenhum,
 * porque manda procurar no lugar errado com confiança.
 *
 *   node scripts/gerar-mapa.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const RAIZ = join(import.meta.dirname, '..');
const ALVOS = ['server/src', 'extension/content', 'extension/background', 'scripts'];
const IGNORAR = /node_modules|dist|\.git/;

/** A primeira frase do bloco de comentário do topo — é a descrição do arquivo. */
function proposito(texto) {
  // O comentário de cabeçalho vem DEPOIS dos imports na maioria dos arquivos,
  // então procura o primeiro bloco no começo do arquivo, não só na linha 1.
  // O limite de 3000 chars evita pegar o JSDoc de uma função lá embaixo.
  const bloco = /\/\*\*([\s\S]*?)\*\//.exec(texto.slice(0, 3000));
  if (!bloco) return null;
  const linhas = bloco[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l !== '');
  if (linhas.length === 0) return null;
  // Junta até o primeiro ponto final: o resto do bloco é o porquê, longo demais
  // pro índice.
  const texto1 = linhas.join(' ');
  const ponto = texto1.indexOf('. ');
  return (ponto > 0 ? texto1.slice(0, ponto + 1) : texto1).slice(0, 160);
}

/** O que o arquivo oferece pra quem for reusar. */
function exportados(texto) {
  const nomes = [];
  const re = /export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(texto)) !== null) nomes.push(m[1]);
  // `window.__cpmX` é como os content scripts se expõem entre si.
  const janela = /window\.(__cpm[A-Za-z0-9_]+)\s*=/g;
  while ((m = janela.exec(texto)) !== null) nomes.push(m[1]);
  return [...new Set(nomes)];
}

function arquivos(dir) {
  const saida = [];
  let itens;
  try {
    itens = readdirSync(dir);
  } catch {
    return saida;
  }
  for (const item of itens) {
    const caminho = join(dir, item);
    if (IGNORAR.test(caminho)) continue;
    const info = statSync(caminho);
    if (info.isDirectory()) saida.push(...arquivos(caminho));
    else if (/\.(ts|js|mjs)$/.test(item) && !/\.test\.ts$/.test(item)) saida.push(caminho);
  }
  return saida;
}

const linhas = [
  '# Mapa do repositório',
  '',
  '> Gerado por `node scripts/gerar-mapa.mjs`. **Não edite à mão** — rode de novo.',
  '>',
  '> Serve pra responder "onde fica X" sem varrer o repositório com grep. Cada',
  '> busca traz linhas que entram no contexto e não saem mais; este índice é',
  '> lido uma vez.',
  '',
];

let total = 0;
for (const alvo of ALVOS) {
  const dir = join(RAIZ, alvo);
  const lista = arquivos(dir).sort();
  if (lista.length === 0) continue;

  linhas.push(`## ${alvo}`, '');
  linhas.push('| Arquivo | O que resolve | Exporta |');
  linhas.push('|---|---|---|');

  for (const caminho of lista) {
    const texto = readFileSync(caminho, 'utf8');
    const rel = relative(RAIZ, caminho).split(sep).join('/');
    const nLinhas = texto.split('\n').length;
    const desc = proposito(texto) ?? '—';
    const exp = exportados(texto);
    // Só os primeiros: a lista inteira de um arquivo grande ocuparia o índice
    // com o que ninguém procura pelo nome.
    const mostra = exp.slice(0, 6).join(', ') + (exp.length > 6 ? ` +${exp.length - 6}` : '');
    linhas.push(`| \`${rel}\` (${nLinhas}) | ${desc.replace(/\|/g, '\\|')} | ${mostra || '—'} |`);
    total += 1;
  }
  linhas.push('');
}

linhas.push('---', '', `${total} arquivos indexados.`, '');
writeFileSync(join(RAIZ, 'docs/MAPA.md'), linhas.join('\n'));
console.log(`docs/MAPA.md — ${total} arquivos`);
