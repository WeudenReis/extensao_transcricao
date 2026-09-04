/**
 * Prova que nenhuma chamada de `pedir()` sobrescreve o nome da mensagem.
 *
 * `pedir(tipo, dados)` faz `Object.assign({ tipo }, dados)` — qualquer campo
 * chamado `tipo` DENTRO de `dados` vence, e a mensagem chega ao service worker
 * com o nome errado. Não dá erro: o handler simplesmente não casa, e a tela
 * mostra o estado de falha. Foi o que quebrou a semana.
 *
 * Este teste varre TODAS as chamadas do arquivo, não só a que quebrou.
 *
 *   node scripts/checar-mensagens.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fonte = readFileSync(
  join(import.meta.dirname, '..', 'extension/content/fluxo-reuniao.js'),
  'utf8'
);

// Cada `pedir('NOME', { ... })` do arquivo, com o bloco de dados.
const re = /pedir\(\s*'([A-Z_]+)'\s*,\s*\{([\s\S]*?)\n\s*\}\s*\)/g;
const chamadas = [];
let m;
while ((m = re.exec(fonte)) !== null) {
  chamadas.push({ nome: m[1], dados: m[2] });
}
// As de uma linha só.
const re2 = /pedir\(\s*'([A-Z_]+)'\s*,\s*\{([^}\n]*)\}\s*\)/g;
while ((m = re2.exec(fonte)) !== null) {
  chamadas.push({ nome: m[1], dados: m[2] });
}

if (chamadas.length === 0) {
  console.log('nenhuma chamada encontrada — o padrão do arquivo mudou?');
  process.exit(1);
}

let falhas = 0;
const vistos = new Set();
for (const c of chamadas) {
  const chave = `${c.nome}|${c.dados.slice(0, 40)}`;
  if (vistos.has(chave)) continue;
  vistos.add(chave);

  // Um campo `tipo:` no primeiro nível dos dados é a colisão.
  const colide = /(^|[\s{,])tipo\s*:/.test(c.dados);
  if (colide) {
    falhas += 1;
    console.log(`  COLIDE  ${c.nome} — tem um campo 'tipo' nos dados`);
  } else {
    console.log(`  ok      ${c.nome}`);
  }
}

console.log(
  falhas === 0
    ? `\n${vistos.size} chamada(s), nenhuma colisão.`
    : `\n${falhas} COLISÃO(ÕES) — a mensagem chegaria com o nome errado.`
);
process.exit(falhas === 0 ? 0 : 1);
