/**
 * Quais arquivos entram no cérebro visual — fonte ÚNICA.
 *
 * Existe pra `gerar-grafo.mjs` (que copia estes arquivos pro palco) e
 * `grafo.mjs` (que confere se algum deles é mais novo que o grafo) usarem a
 * MESMA lista. Se divergissem, seria em silêncio: um arquivo que entra no
 * grafo mas não é conferido deixaria o grafo desatualizado sem nenhum aviso.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RAIZ = join(import.meta.dirname, '..');

export const PASTAS = [
  'server/src',
  'extension/content',
  'extension/background',
  'extension/popup',
  'scripts',
];

/** Caminhos absolutos de todo .ts/.js/.mjs de código (sem teste). */
export function arquivosDeCodigo() {
  const achados = [];
  function andar(dir) {
    let itens;
    try {
      itens = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of itens) {
      const p = join(dir, item);
      if (/node_modules|[\\/]dist$|[\\/]data$/.test(p)) continue;
      if (statSync(p).isDirectory()) andar(p);
      else if (/\.(ts|js|mjs)$/.test(item) && !/\.test\.ts$/.test(item)) achados.push(p);
    }
  }
  for (const pasta of PASTAS) andar(join(RAIZ, pasta));
  return achados;
}
