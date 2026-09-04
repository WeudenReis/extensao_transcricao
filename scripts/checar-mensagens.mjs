/**
 * Duas travas sobre a ponte entre a aba e o service worker.
 *
 * A aba fala com o servidor SÓ através do service worker, e esse repasse é
 * escrito à mão nos dois lados. Nenhum dos dois erros abaixo dá exceção: a
 * mensagem simplesmente chega errada, e o sintoma aparece na tela como se
 * fosse outra coisa.
 *
 *   node scripts/checar-mensagens.mjs
 *
 * 1. COLISÃO DE NOME
 *    `pedir(tipo, dados)` monta `Object.assign({ tipo }, dados)`. Um campo
 *    chamado `tipo` DENTRO de `dados` vence e sobrescreve o nome da mensagem:
 *    o handler não casa e a tela mostra o estado de falha. Aconteceu com
 *    PAINEL_SEMANA, que mandava o tipo de reunião — e todos os dias diziam
 *    "não consegui conferir a agenda do painel".
 *
 * 2. CAMPO QUE MORRE NO REPASSE
 *    O handler de INICIAR_REUNIAO monta o corpo do POST com uma LISTA FIXA de
 *    campos. Campo novo mandado pela aba e não incluído lá é descartado em
 *    silêncio. Aconteceu com `semMensagem`: a caixa "Não enviar mensagem ao
 *    cliente" ficava marcada, o campo morria no repasse, e o cliente recebia
 *    a mensagem assim mesmo. Os testes do servidor passavam, porque batem na
 *    rota HTTP com o campo já no corpo — o elo do meio não era exercitado.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(import.meta.dirname, '..');
const fluxo = readFileSync(join(RAIZ, 'extension/content/fluxo-reuniao.js'), 'utf8');
const worker = readFileSync(join(RAIZ, 'extension/background/service-worker.js'), 'utf8');

/** Cada `pedir('NOME', { ... })` do fluxo, com o bloco de dados. */
function chamadas() {
  const achadas = [];
  const multi = /pedir\(\s*'([A-Z_]+)'\s*,\s*\{([\s\S]*?)\n\s*\}\s*\)/g;
  const uma = /pedir\(\s*'([A-Z_]+)'\s*,\s*\{([^}\n]*)\}\s*\)/g;
  for (const re of [multi, uma]) {
    let m;
    while ((m = re.exec(fluxo)) !== null) achadas.push({ nome: m[1], dados: m[2] });
  }
  return achadas;
}

/** Os nomes de campo do primeiro nível de um bloco de dados. */
function campos(dados) {
  const nomes = new Set();
  // Só o primeiro nível: `{ a: 1, b: { c: 2 } }` devolve a e b, não c.
  let prof = 0;
  for (const linha of dados.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(linha);
    if (prof === 0 && m) nomes.add(m[1]);
    for (const ch of linha) {
      if (ch === '{' || ch === '[' || ch === '(') prof += 1;
      else if (ch === '}' || ch === ']' || ch === ')') prof -= 1;
    }
    if (prof < 0) prof = 0;
  }
  return [...nomes];
}

/** O corpo do handler de uma mensagem no service worker. */
function handler(nome) {
  const i = worker.indexOf(`msg?.tipo === '${nome}'`);
  if (i < 0) return null;
  // Até o próximo handler, ou o fim.
  const j = worker.indexOf("msg?.tipo === '", i + 20);
  return worker.slice(i, j > 0 ? j : worker.length);
}

const problemas = [];
const vistos = new Set();

for (const c of chamadas()) {
  const chave = `${c.nome}|${c.dados.slice(0, 40)}`;
  if (vistos.has(chave)) continue;
  vistos.add(chave);

  // ── 1. colisão ──
  if (/(^|[\s{,])tipo\s*:/.test(c.dados)) {
    problemas.push(
      `${c.nome}: tem um campo 'tipo' nos dados — ele sobrescreve o NOME da ` +
        `mensagem e ela não chega a handler nenhum. Renomeie (ex.: tipoReuniao).`
    );
  }

  // ── 2. campo que some no repasse ──
  const corpo = handler(c.nome);
  if (!corpo) {
    problemas.push(`${c.nome}: a aba manda esta mensagem e o service worker não a trata.`);
    continue;
  }
  for (const campo of campos(c.dados)) {
    if (!new RegExp(`\\bmsg\\.${campo}\\b`).test(corpo)) {
      problemas.push(
        `${c.nome}: a aba manda '${campo}' e o handler nunca lê msg.${campo} — ` +
          `o campo morre no repasse, sem erro nenhum.`
      );
    }
  }
}

if (problemas.length === 0) {
  console.log(`✓ ${vistos.size} chamada(s) de pedir(): sem colisão e sem campo perdido.`);
  process.exit(0);
}
console.log('✗ problemas na ponte aba → service worker:');
for (const x of problemas) console.log(`   - ${x}`);
process.exit(1);
