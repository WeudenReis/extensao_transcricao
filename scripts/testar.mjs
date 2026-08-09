#!/usr/bin/env node
/**
 * Diagnóstico e teste da integração, em camadas.
 *
 *   node scripts/testar.mjs                          → só diagnóstico (não toca nada)
 *   node scripts/testar.mjs --sessao=UUID            → + comentário de teste (interno)
 *   node scripts/testar.mjs --sessao=UUID --mensagem → + mensagem PRO CLIENTE (cuidado)
 *   node scripts/testar.mjs --recall                 → + cria e remove um bot de teste
 *
 * Nada aqui é destrutivo por padrão: sem flag, só lê.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.some((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const valor = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

const env = {};
try {
  for (const linha of readFileSync(join(raiz, 'server/.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(linha);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {
  console.error('Não achei server/.env — copie de server/.env.example primeiro.');
  process.exit(1);
}

const V = (k) => (env[k] ? env[k] : null);
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const nao = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const meio = (s) => `\x1b[33m•\x1b[0m ${s}`;

// ─── 1. Diagnóstico ──────────────────────────────────────────────────────────

console.log('\n\x1b[1mO QUE DÁ PRA TESTAR AGORA\x1b[0m\n');

const temChatpro = V('CHATPRO_INSTANCE_TOKEN') && V('CHATPRO_INSTANCE_ID') && V('CHATPRO_USER_ID');
const temRecall = Boolean(V('RECALL_API_KEY'));
const temGoogle = V('GOOGLE_CLIENT_ID') && V('GOOGLE_CLIENT_SECRET');
const temTunel = Boolean(V('PUBLIC_BASE_URL'));
const temHookRecall = Boolean(V('RECALL_WEBHOOK_SECRET'));
const temResumo = Boolean(V('ANTHROPIC_API_KEY'));
const temEtiquetas = Boolean(
  V('CHATPRO_TAG_REALIZADA') || V('CHATPRO_TAG_SEM_GRAVACAO') || V('CHATPRO_TAG_LONGA')
);

console.log('  ' + (temChatpro ? ok('chatPro') : nao('chatPro')) +
  ' — comentar a transcrição e mandar o link pro cliente');
console.log('  ' + (temGoogle ? ok('Google') : nao('Google  ')) +
  ' — o botão criar o link do Meet sozinho');
console.log('  ' + (temRecall ? ok('Recall') : nao('Recall  ')) +
  ' — o bot entrar na sala e gravar');
console.log('  ' + (temTunel && temHookRecall ? ok('Webhooks') : nao('Webhooks')) +
  ' — a transcrição voltar quando a reunião acabar');
console.log('  ' + (temResumo ? ok('Resumo IA') : meio('Resumo IA')) +
  ' — o comentário leva o resumo (sem ela vai só o cabeçalho)');
console.log('  ' + (temEtiquetas ? ok('Etiquetas') : meio('Etiquetas')) +
  ' — marcar a conversa depois da reunião (opcional)');

console.log('\n\x1b[1mORDEM SUGERIDA\x1b[0m\n');
const passos = [
  [temChatpro, 'chatPro', 'já configurei com o token que você mandou'],
  [temGoogle, 'Google', 'crie um OAuth Client "Web application" no Google Cloud e preencha GOOGLE_CLIENT_ID/SECRET'],
  [temRecall, 'Recall', 'pegue em https://us-west-2.recall.ai/dashboard/developers/api-keys e preencha RECALL_API_KEY'],
  [temHookRecall && temTunel, 'Webhooks', 'suba um túnel (cloudflared) e crie o signing secret no dashboard do Recall'],
];
for (const [pronto, nome, oQueFazer] of passos) {
  console.log(`  ${pronto ? ok(nome.padEnd(9)) : meio(nome.padEnd(9))} ${pronto ? '(pronto)' : oQueFazer}`);
}

// ─── 2. Testes ───────────────────────────────────────────────────────────────

const BASE_CP = V('CHATPRO_BASE_URL') || 'https://sparks.chatpro.com.br';

async function chatpro(caminho, corpo) {
  const r = await fetch(`${BASE_CP}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'instance-token': V('CHATPRO_INSTANCE_TOKEN') },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, texto: (await r.text()).slice(0, 300) };
}

let falhou = false;

if (temTunel) {
  console.log(`
[1mTESTE 0 — a URL pública ainda responde?[0m
`);
  const base = V('PUBLIC_BASE_URL');
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(15000) });
    console.log('  ' + (r.ok ? ok(`${base} → ${r.status}`) : nao(`${base} → ${r.status}`)));
    if (!r.ok) falhou = true;
  } catch {
    falhou = true;
    console.log('  ' + nao(`${base} não respondeu.`));
    console.log('    Túnel rápido morre quando o processo cai, e a URL muda ao subir de novo.');
    console.log('    Suba outro e EDITE o endpoint no painel do Recall (não crie um segundo).');
  }
}

if (temChatpro) {
  console.log('\n\x1b[1mTESTE 1 — o token do chatPro funciona?\x1b[0m (só leitura)\n');
  const r = await chatpro('/users/getAllInstanceUsers', { instanceId: V('CHATPRO_INSTANCE_ID') });
  if (r.status >= 200 && r.status < 300) {
    let n = '?';
    try {
      n = JSON.parse(r.texto.startsWith('[') ? '[]' : '[]').length;
    } catch { /* só o status importa */ }
    console.log('  ' + ok(`HTTP ${r.status} — token válido, instância existe`));
  } else {
    falhou = true;
    console.log('  ' + nao(`HTTP ${r.status} — ${r.texto}`));
  }
}

const sessao = valor('sessao');

if (sessao && temChatpro) {
  console.log('\n\x1b[1mTESTE 2 — comentário na conversa\x1b[0m (interno, o cliente NÃO vê)\n');
  const r = await chatpro('/messages/addComments', {
    instanceId: V('CHATPRO_INSTANCE_ID'),
    sessionId: sessao,
    userId: V('CHATPRO_USER_ID'),
    message:
      '🧪 Teste da integração de reuniões.\n' +
      'Se você está lendo isto no chatPro, a transcrição vai chegar por aqui.',
  });
  if (r.status >= 200 && r.status < 300) {
    console.log('  ' + ok(`HTTP ${r.status} — abra a conversa no chatPro e veja o comentário`));
  } else {
    falhou = true;
    console.log('  ' + nao(`HTTP ${r.status} — ${r.texto}`));
  }
}

if (sessao && flag('mensagem') && temChatpro) {
  console.log('\n\x1b[1mTESTE 3 — mensagem PRO CLIENTE\x1b[0m \x1b[31m(ele vai receber de verdade)\x1b[0m\n');
  const r = await chatpro('/messages/sendMessage', {
    instanceId: V('CHATPRO_INSTANCE_ID'),
    sessionId: sessao,
    provider: V('CHATPRO_PROVIDER') || 'whatsapp',
    userId: V('CHATPRO_USER_ID'),
    message: 'Teste de integração — pode ignorar esta mensagem.',
  });
  if (r.status >= 200 && r.status < 300) {
    console.log('  ' + ok(`HTTP ${r.status} — mensagem enviada`));
  } else {
    falhou = true;
    console.log('  ' + nao(`HTTP ${r.status} — ${r.texto}`));
    console.log('    (se reclamar de "provider", confira CHATPRO_PROVIDER no .env)');
  }
} else if (sessao && temChatpro) {
  console.log('\n  ' + meio('Teste 3 (mensagem pro cliente) pulado — use --mensagem pra rodar'));
}

if (flag('recall')) {
  console.log('\n\x1b[1mTESTE 4 — criar e remover um bot no Recall\x1b[0m\n');
  if (!temRecall) {
    console.log('  ' + nao('RECALL_API_KEY vazia'));
    console.log('    Pegue em: https://us-west-2.recall.ai/dashboard/developers/api-keys');
  } else {
    const regiao = V('RECALL_REGION') || 'us-west-2';
    const base = `https://${regiao}.recall.ai/api/v1`;
    const cria = await fetch(`${base}/bot`, {
      method: 'POST',
      headers: { Authorization: `Token ${V('RECALL_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meeting_url: valor('meet') || 'https://meet.google.com/abc-defg-hij',
        bot_name: V('RECALL_BOT_NAME') || 'chatPro (gravando)',
        metadata: { teste: '1' },
      }),
    });
    const corpo = await cria.json().catch(() => ({}));
    if (cria.status === 201 && corpo.id) {
      console.log('  ' + ok(`bot criado (${corpo.id})`));
      const sai = await fetch(`${base}/bot/${corpo.id}/leave_call/`, {
        method: 'POST',
        headers: { Authorization: `Token ${V('RECALL_API_KEY')}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      console.log('  ' + ok(`bot removido (HTTP ${sai.status}) — sem custo relevante`));
    } else {
      falhou = true;
      console.log('  ' + nao(`HTTP ${cria.status} — ${JSON.stringify(corpo).slice(0, 200)}`));
    }
  }
}

// ─── 3. Próximo passo ────────────────────────────────────────────────────────

console.log('\n\x1b[1mCOMO SEGUIR\x1b[0m\n');
if (!sessao) {
  console.log('  Pra testar de verdade, pegue o id da sessão na URL do chatPro:');
  console.log('    app.chatpro.com.br/chat/\x1b[1m00a6e78d-020a-401f-98b3-544e05b830b3\x1b[0m');
  console.log('                            └── é este pedaço\n');
  console.log('  E rode:  node scripts/testar.mjs --sessao=SEU_ID_AQUI');
} else if (!temGoogle) {
  console.log('  chatPro OK. O próximo bloqueio é o Google — sem ele o botão não');
  console.log('  consegue criar o link do Meet. Veja o item 6 do PENDENCIAS-RECALL.md.');
} else if (!temRecall) {
  console.log('  chatPro e Google OK. Falta a RECALL_API_KEY pro bot gravar.');
} else {
  console.log('  Tudo configurado. Suba o servidor (npm start em server/) e clique');
  console.log('  no botão "reunião" numa conversa do chatPro.');
}
console.log('');

// exitCode em vez de process.exit(): sair à força com sockets do fetch ainda
// abertos derruba o Node no Windows (assert do libuv).
process.exitCode = falhou ? 1 : 0;
