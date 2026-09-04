/**
 * Trava contra o erro que já quebrou o arquivo DUAS vezes: crase dentro do
 * bloco de CSS.
 *
 * O CSS da aba mora num template literal (`st.textContent = \`...\``). Uma
 * crase escrita num comentário CSS — natural pra quem está citando um seletor
 * — TERMINA o template literal, e o arquivo vira erro de sintaxe. O `node
 * --check` pega, mas só depois de gravar; isto aqui explica O QUE fazer.
 *
 *   node scripts/checar-css.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(import.meta.dirname, '..');
const ARQUIVO = join(RAIZ, 'extension/content/aba-reuniao.js');
const fonte = readFileSync(ARQUIVO, 'utf8');

const ABRE = 'st.textContent = `';
const ini = fonte.indexOf(ABRE);
if (ini < 0) {
  console.log('✗ não achei o bloco de CSS (o arquivo mudou de forma?)');
  process.exit(1);
}
const css = fonte.slice(ini + ABRE.length, fonte.indexOf('`;', ini));

const problemas = [];

// 1. Crase — a que quebra o arquivo.
const crase = css.indexOf('`');
if (crase >= 0) {
  const linha = css.slice(0, crase).split('\n').length;
  problemas.push(
    `crase dentro do CSS (linha ~${linha} do bloco) — ela TERMINA o template ` +
      `literal. Cite seletor sem crase, ou escape com \\\``
  );
}

// 2. `${` não intencional: interpolaria e sumiria do CSS.
for (const m of css.matchAll(/\$\{(\w+)\}/g)) {
  if (!['ID', 'LARGURA'].includes(m[1])) {
    problemas.push(`interpolação inesperada \${${m[1]}} no CSS`);
  }
}

// 3. Cor literal — a regra dura do repositório (quebra o tema claro).
for (const m of css.matchAll(/(?:#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\))/g)) {
  // rgba() dentro de var(--x, fallback) é o degradê de emergência, previsto.
  const antes = css.slice(Math.max(0, m.index - 60), m.index);
  if (!antes.includes('var(--')) problemas.push(`cor literal no CSS: ${m[0]}`);
}

if (problemas.length === 0) {
  console.log(`✓ CSS da aba ok (${css.length} chars, sem crase, sem cor literal)`);
  process.exit(0);
}
console.log('✗ problemas no CSS da aba:');
for (const x of problemas) console.log(`   - ${x}`);
process.exit(1);
