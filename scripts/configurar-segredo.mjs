#!/usr/bin/env node
/**
 * Grava o signing secret do Recall no server/.env, reinicia o servidor e
 * confere a assinatura de ponta a ponta — tudo num comando.
 *
 *   node scripts/configurar-segredo.mjs whsec_SEU_SEGREDO
 *   node scripts/configurar-segredo.mjs            (pergunta, se preferir)
 *
 * Passar como argumento é o caminho recomendado: o prompt interativo já rendeu
 * o engano de colar o COMANDO em vez do segredo. Fica no histórico do shell,
 * o que é aceitável na própria máquina — e o painel do Recall permite
 * rotacionar quando quiser.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(raiz, 'server/.env');

function lerEnv() {
  const env = {};
  for (const linha of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(linha);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function gravar(chave, valor) {
  let s = readFileSync(envPath, 'utf8');
  const re = new RegExp(`^${chave}=.*$`, 'm');
  s = re.test(s) ? s.replace(re, `${chave}=${valor}`) : `${s.trimEnd()}\n${chave}=${valor}\n`;
  writeFileSync(envPath, s);
}

async function pedirInterativo() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const perguntar = (q) => new Promise((r) => rl.question(q, r));

  console.log('No painel do Recall: Endpoints → seu endpoint → Signing Secret → ícone do olho.');
  console.log('Cole o valor abaixo — ele começa com "whsec_". (Enter vazio cancela.)\n');

  let achado = '';
  // Três chances: colar errado acontece, e desistir na primeira obriga a
  // reabrir o painel do zero.
  for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
    const resposta = (await perguntar('  segredo: ')).trim();
    if (!resposta) break;
    if (resposta.startsWith('whsec_')) {
      achado = resposta;
      break;
    }
    console.log('  ✗ Isso não começa com "whsec_".');
    if (resposta.startsWith('node ') || resposta.includes('.mjs')) {
      console.log('    (parece que você colou um COMANDO em vez do segredo)');
    }
    if (tentativa < 3) console.log('    Tente de novo.\n');
  }
  rl.close();
  return achado;
}

/** Derruba o node; o supervisor o traz de volta já com o .env novo. */
async function reiniciarServidor() {
  try {
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
        "Where-Object { $_.CommandLine -match 'dist.index.js' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
      { stdio: 'ignore' }
    );
  } catch {
    // Nada rodando: não há o que derrubar.
  }
  // O supervisor recompila antes de subir, então demora mais que um restart seco.
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await fetch('http://127.0.0.1:3333/api/health', { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      /* ainda subindo */
    }
  }
  return false;
}

/** Monta uma assinatura Svix de verdade e vê se o servidor aceita. */
async function testar(base, segredo) {
  const corpo = JSON.stringify({
    event: 'bot.joining_call',
    data: { data: {}, bot: { id: 'bot-de-teste-assinatura', metadata: {} } },
  });
  const id = 'msg_teste_assinatura';
  const ts = String(Math.floor(Date.now() / 1000));
  const chave = Buffer.from(segredo.replace(/^whsec_/, ''), 'base64');
  const assinatura =
    'v1,' + crypto.createHmac('sha256', chave).update(`${id}.${ts}.${corpo}`).digest('base64');

  const r = await fetch(`${base}/webhooks/recall`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': assinatura,
    },
    body: corpo,
  });

  console.log(`\n  Teste de assinatura em ${base} → HTTP ${r.status}`);
  if (r.status === 200) {
    console.log('  ✓ O servidor aceitou. O par .env ↔ painel do Recall está certo.');
    console.log('    Os eventos reais vão passar.\n');
    return true;
  }
  if (r.status === 403) {
    console.log('  ✗ 403 — o servidor não reconheceu a assinatura.');
    console.log('    O segredo colado é de outro endpoint, ou veio incompleto.\n');
    return false;
  }
  console.log(`  ? Resposta inesperada: ${(await r.text()).slice(0, 200)}\n`);
  return false;
}

// ─── Execução ────────────────────────────────────────────────────────────────

console.log('\nSigning secret do webhook do Recall');
console.log('───────────────────────────────────\n');

const doArgumento = process.argv.slice(2).find((a) => a.startsWith('whsec_'));
const segredo = doArgumento ?? (await pedirInterativo());

if (!segredo) {
  console.log('\n  Nada gravado. O jeito mais direto é passar junto:');
  console.log('    node scripts/configurar-segredo.mjs whsec_SEU_SEGREDO\n');
  process.exitCode = 1;
} else {
  gravar('RECALL_WEBHOOK_SECRET', segredo);
  console.log(`  ✓ Gravado no .env (${segredo.slice(0, 11)}…, ${segredo.length} caracteres).`);

  console.log('  Reiniciando o servidor pra carregar o segredo...');
  const voltou = await reiniciarServidor();
  if (!voltou) {
    console.log('  [!] O servidor não voltou em 60 s. Suba pelo autostart e rode de novo.\n');
    process.exitCode = 1;
  } else {
    console.log('  ✓ Servidor de volta.');
    const env = lerEnv();
    const base = env.PUBLIC_BASE_URL || `http://127.0.0.1:${env.PORT || 3333}`;
    const ok = await testar(base, segredo);
    process.exitCode = ok ? 0 : 1;
  }
}
