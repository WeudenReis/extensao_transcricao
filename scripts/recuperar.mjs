#!/usr/bin/env node
/**
 * Pergunta ao Recall o que aconteceu com as reuniões que ficaram paradas, e
 * recupera as transcrições que o webhook não trouxe.
 *
 *   node scripts/recuperar.mjs             → só olha e recupera a transcrição
 *   node scripts/recuperar.mjs --entregar  → + publica o comentário no chatPro
 *
 * Por que existe: o webhook depende de uma URL pública alcançável. Túnel caído,
 * segredo faltando ou servidor fora do ar durante a reunião fazem o Recall
 * gravar direitinho e nós não sabermos de nada. Já aconteceu aqui — seis
 * reuniões paradas em `created` com os bots já em `recording_done`.
 *
 * Sem `--entregar`, NADA é postado na conversa do cliente: primeiro você vê o
 * que apareceu, depois decide.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(raiz, 'server');

const env = {};
for (const linha of readFileSync(join(server, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(linha);
  if (m) env[m[1]] = m[2].trim();
}
const V = (k) => (env[k] ? env[k] : undefined);

const { Db } = await import(new URL('server/dist/db.js', `file:///${raiz.replace(/\\/g, '/')}/`));
const { RecallClient } = await import(
  new URL('server/dist/recall/client.js', `file:///${raiz.replace(/\\/g, '/')}/`)
);
const { ChatproClient } = await import(
  new URL('server/dist/chatpro/client.js', `file:///${raiz.replace(/\\/g, '/')}/`)
);
const { reconciliar, resumirReconciliacao } = await import(
  new URL('server/dist/pipeline/reconciliar.js', `file:///${raiz.replace(/\\/g, '/')}/`)
);

const entregar = process.argv.includes('--entregar');

const db = new Db(join(server, V('DATABASE_PATH')?.replace(/^\.\//, '') ?? 'data/app.db'));
const recall = V('RECALL_API_KEY')
  ? new RecallClient({
      apiKey: V('RECALL_API_KEY'),
      region: V('RECALL_REGION') ?? 'us-west-2',
      baseUrl: V('RECALL_BASE_URL'),
    })
  : undefined;
const chatpro = new ChatproClient({
  baseUrl: V('CHATPRO_BASE_URL'),
  instanceToken: V('CHATPRO_INSTANCE_TOKEN'),
  instanceId: V('CHATPRO_INSTANCE_ID'),
  userId: V('CHATPRO_USER_ID'),
  provider: V('CHATPRO_PROVIDER'),
});

console.log('\nRecuperando o que o webhook não trouxe');
console.log('───────────────────────────────────────');
if (!entregar) {
  console.log('(modo leitura: recupera a transcrição, mas NÃO posta no chatPro)\n');
} else {
  console.log('\x1b[33m(--entregar: os comentários VÃO para as conversas)\x1b[0m\n');
}

const r = await reconciliar(
  {
    db,
    recall,
    chatpro,
    entregar,
    entrega: {
      anthropicApiKey: V('ANTHROPIC_API_KEY'),
      resumoModelo: V('RESUMO_MODELO'),
      painelUrl: V('PUBLIC_BASE_URL') ?? `http://localhost:${V('PORT') ?? 3333}`,
    },
  },
  25
);

console.log('\n' + resumirReconciliacao(r) + '\n');
for (const e of r.erros) console.log('  erro: ' + e);

console.log('Como ficou:\n');
for (const m of db.listMeetings(10)) {
  let falas = 0;
  try {
    falas = JSON.parse(m.transcript_json ?? '{}').falas?.length ?? 0;
  } catch {
    /* sem transcrição */
  }
  console.log(
    `  ${m.created_at.slice(0, 16).replace('T', ' ')} | ${String(m.status).padEnd(8)} | ` +
      `${String(m.meeting_code ?? '?').padEnd(13)} | ${falas} falas | chatpro=${m.chatpro_status ?? '-'}`
  );
}

if (!entregar && r.transcricoesRecuperadas > 0) {
  console.log('\nPara publicar os comentários nas conversas:');
  console.log('  node scripts/recuperar.mjs --entregar\n');
}
db.close();
