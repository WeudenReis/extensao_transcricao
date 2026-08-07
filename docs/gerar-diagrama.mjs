#!/usr/bin/env node
/**
 * Gera `docs/arquitetura.excalidraw` — o desenho de como o projeto funciona.
 *
 *   node docs/gerar-diagrama.mjs
 *
 * Por que um script e não um .excalidraw escrito à mão: o formato é JSON
 * verboso (cada caixa tem ~20 campos), e mexer nele na mão é onde erro entra.
 * Aqui o layout é declarativo e dá pra regenerar quando a arquitetura mudar.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

// ─── Paleta (identidade chatPro + cores por origem) ──────────────────────────

const COR = {
  texto: '#1d2125',
  suave: '#5c6670',
  linha: '#868e96',

  nosso: '#25D066', // o que nós construímos
  nossoFundo: '#e7f9ee',
  google: '#1a73e8',
  googleFundo: '#e7f0fd',
  recall: '#e8590c',
  recallFundo: '#fff0e6',
  chatpro: '#0b7285',
  chatproFundo: '#e3f5f8',
  perigo: '#c92a2a',
  perigoFundo: '#ffecec',
  neutro: '#495057',
  neutroFundo: '#f1f3f5',
  amarelo: '#f08c00',
  amareloFundo: '#fff9db',
};

// ─── Fábrica de elementos ────────────────────────────────────────────────────

let contador = 0;
const id = (p = 'el') => `${p}-${(contador += 1)}`;
const elementos = [];

const BASE = {
  angle: 0,
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: [],
  updated: 1,
  link: null,
  locked: false,
};

/** Largura aproximada de um texto — o Excalidraw recalcula ao abrir. */
const larguraTexto = (txt, fonte) =>
  Math.max(...txt.split('\n').map((l) => l.length)) * fonte * 0.56;
const alturaTexto = (txt, fonte) => txt.split('\n').length * fonte * 1.25;

function texto(x, y, conteudo, opcoes = {}) {
  const fontSize = opcoes.fontSize ?? 16;
  const el = {
    ...BASE,
    id: id('txt'),
    type: 'text',
    x,
    y,
    width: opcoes.width ?? larguraTexto(conteudo, fontSize),
    height: alturaTexto(conteudo, fontSize),
    strokeColor: opcoes.cor ?? COR.texto,
    backgroundColor: 'transparent',
    roundness: null,
    text: conteudo,
    originalText: conteudo,
    fontSize,
    // 1 = manuscrita, 2 = normal, 3 = monoespaçada
    fontFamily: opcoes.fonte ?? 2,
    textAlign: opcoes.alinhar ?? 'left',
    verticalAlign: 'top',
    baseline: Math.round(fontSize * 0.9),
    containerId: null,
    lineHeight: 1.25,
  };
  elementos.push(el);
  return el;
}

function caixa(x, y, w, h, opcoes = {}) {
  const el = {
    ...BASE,
    id: id('box'),
    type: opcoes.tipo ?? 'rectangle',
    x,
    y,
    width: w,
    height: h,
    strokeColor: opcoes.cor ?? COR.neutro,
    backgroundColor: opcoes.fundo ?? 'transparent',
    fillStyle: opcoes.hachura ? 'hachure' : 'solid',
    strokeStyle: opcoes.tracejado ? 'dashed' : 'solid',
    strokeWidth: opcoes.grossura ?? 2,
    roundness: opcoes.reto ? null : { type: 3 },
  };
  elementos.push(el);
  return el;
}

/** Problemas de layout achados na geração (texto estourando a caixa). */
const avisos = [];

/** Caixa com título e corpo, tamanho fixo. */
function cartao(x, y, w, titulo, corpo, opcoes = {}) {
  const padX = 14;
  const precisa = 36 + alturaTexto(corpo ?? '', 13) + 14;
  const h = opcoes.altura ?? 30 + alturaTexto(corpo, 13) + 26;

  // Altura fixa menor que o conteúdo = texto vazando por baixo. Com 173
  // elementos isso passa despercebido até alguém abrir o arquivo.
  if (opcoes.altura && precisa > opcoes.altura) {
    avisos.push(`ALTURA: "${titulo}" precisa de ${Math.ceil(precisa)}px, tem ${opcoes.altura}px`);
  }
  const larguraNecessaria = Math.max(
    larguraTexto(titulo, 15),
    larguraTexto(corpo ?? '', 13)
  ) + padX * 2;
  if (larguraNecessaria > w) {
    avisos.push(`LARGURA: "${titulo}" precisa de ${Math.ceil(larguraNecessaria)}px, tem ${w}px`);
  }
  caixa(x, y, w, h, { cor: opcoes.cor, fundo: opcoes.fundo, tracejado: opcoes.tracejado });
  texto(x + padX, y + 12, titulo, { fontSize: 15, cor: opcoes.cor ?? COR.texto });
  if (corpo) texto(x + padX, y + 36, corpo, { fontSize: 13, cor: COR.suave });
  return { x, y, w, h, meioY: y + h / 2, baixo: y + h, direita: x + w };
}

function seta(x1, y1, x2, y2, opcoes = {}) {
  const pontos = opcoes.pontos ?? [
    [0, 0],
    [x2 - x1, y2 - y1],
  ];
  const el = {
    ...BASE,
    id: id('arw'),
    type: 'arrow',
    x: x1,
    y: y1,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    strokeColor: opcoes.cor ?? COR.linha,
    backgroundColor: 'transparent',
    strokeStyle: opcoes.tracejado ? 'dashed' : 'solid',
    strokeWidth: opcoes.grossura ?? 2,
    roundness: { type: 2 },
    points: pontos,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
  };
  elementos.push(el);
  if (opcoes.rotulo) {
    const meioX = (x1 + x2) / 2;
    const meioY = (y1 + y2) / 2;
    texto(meioX + (opcoes.rotuloDx ?? 8), meioY + (opcoes.rotuloDy ?? -22), opcoes.rotulo, {
      fontSize: 12,
      cor: opcoes.cor ?? COR.suave,
    });
  }
  return el;
}

function titulo(x, y, txt, sub) {
  texto(x, y, txt, { fontSize: 28, cor: COR.texto, fonte: 1 });
  if (sub) texto(x, y + 38, sub, { fontSize: 14, cor: COR.suave });
}

function secao(x, y, largura, numero, nome) {
  caixa(x - 20, y - 16, largura, 3, { fundo: COR.nosso, cor: COR.nosso, reto: true });
  texto(x - 20, y + 2, `${numero}  ${nome}`, { fontSize: 21, cor: COR.texto, fonte: 1 });
}

// ═════════════════════════════════════════════════════════════════════════════
//  CABEÇALHO
// ═════════════════════════════════════════════════════════════════════════════

titulo(
  0,
  0,
  'chatPro Reuniões — como funciona',
  'Um clique no chatPro cria a reunião, manda o link pro cliente, grava a chamada\n' +
    'e devolve a transcrição na mesma conversa. Branch: recall-ai'
);

// ═════════════════════════════════════════════════════════════════════════════
//  1. O FLUXO EM 6 PASSOS
// ═════════════════════════════════════════════════════════════════════════════

let Y = 130;
secao(0, Y, 1900, '1', 'O caminho feliz, do clique à transcrição');
Y += 60;

const passos = [
  ['1. Clique', 'O atendente aperta\n"reunião" na barra\ndo chatPro', COR.nosso, COR.nossoFundo],
  ['2. Link', 'Calendar API cria a\nsala na agenda DELE\n(conta @gmail serve)', COR.google, COR.googleFundo],
  ['3. Convite', 'sendMessage manda\no link pro cliente\nna conversa', COR.chatpro, COR.chatproFundo],
  ['4. Bot', 'Recall.ai entra na\nsala e grava\n(visível na chamada)', COR.recall, COR.recallFundo],
  ['5. Webhook', 'transcript.done chega\nassinado e vai pra\nfila durável', COR.recall, COR.recallFundo],
  ['6. Entrega', 'addComments põe a\ntranscrição na MESMA\nconversa', COR.chatpro, COR.chatproFundo],
];

let px = 0;
const larguraPasso = 280;
const espaco = 40;
passos.forEach(([t, c, cor, fundo], i) => {
  const cart = cartao(px, Y, larguraPasso, t, c, { cor, fundo, altura: 118 });
  if (i < passos.length - 1) {
    seta(px + larguraPasso + 6, Y + 59, px + larguraPasso + espaco - 6, Y + 59);
  }
  px += larguraPasso + espaco;
});

Y += 150;
texto(
  0,
  Y,
  'O que amarra tudo: ao criar o bot mandamos metadata = { session_id, meeting_id }. O Recall devolve esse metadata em TODO webhook,\n' +
    'então a transcrição sempre reencontra a conversa certa — sem adivinhar por horário, que era o problema da versão anterior.',
  { fontSize: 14, cor: COR.nosso }
);

// ═════════════════════════════════════════════════════════════════════════════
//  2. OS DOIS GATILHOS
// ═════════════════════════════════════════════════════════════════════════════

Y += 90;
secao(0, Y, 1900, '2', 'Duas formas de começar uma reunião');
Y += 60;

const g1 = cartao(
  0,
  Y,
  620,
  'A) Botão "reunião"  ·  principal',
  'A extensão injeta um botão na barra do atendimento.\n' +
    'Um clique faz os 6 passos acima.\n\n' +
    'POST /api/reunioes/iniciar { sessionId, deviceId }',
  { cor: COR.nosso, fundo: COR.nossoFundo }
);

const g2 = cartao(
  700,
  Y,
  620,
  'B) Link colado na conversa  ·  automático',
  'O chatPro avisa por webhook quando alguém manda\n' +
    'mensagem. Se tiver link do Meet, o bot vai sozinho.\n\n' +
    'POST /webhooks/chatpro/{segredo}',
  { cor: COR.chatpro, fundo: COR.chatproFundo }
);

cartao(
  1400,
  Y,
  500,
  'Os dois passam pelo MESMO código',
  'criarReuniao() concentra dedup, pré-gravação\n' +
    'e metadata. Se cada caminho tivesse a própria\n' +
    'lógica, uma correção valeria só num deles —\n' +
    'já aconteceu neste projeto.',
  { cor: COR.amarelo, fundo: COR.amareloFundo }
);

Y += Math.max(g1.h, g2.h) + 60;

// ═════════════════════════════════════════════════════════════════════════════
//  3. O CLIQUE EM DETALHE
// ═════════════════════════════════════════════════════════════════════════════

secao(0, Y, 1900, '3', 'O clique em detalhe — POST /api/reunioes/iniciar');
Y += 60;

const colX = [0, 470, 940, 1410];
const etapas = [
  [
    '1 · Conta Google do atendente',
    'contas.accessToken(deviceId)\n\n' +
      'Cada instalação conecta a SUA conta.\n' +
      'O refresh token fica cifrado (AES-256)\n' +
      'no servidor, nunca na extensão.',
    COR.google,
    COR.googleFundo,
  ],
  [
    '2 · Cria a sala',
    'Calendar API + conferenceData\n' +
      '?conferenceDataVersion=1\n\n' +
      'Um evento na agenda gera o link.\n' +
      'Funciona em conta pessoal — o Meet\n' +
      'REST API v2 exigiria Workspace.',
    COR.google,
    COR.googleFundo,
  ],
  [
    '3 · Manda pro cliente',
    'getSessionById → provider\n' +
      'sendMessage { …, provider }\n\n' +
      'O provider é POR CONVERSA (whatsapp,\n' +
      'cloud…). Valor fixo dava 400.\n' +
      'Falhou aqui? PARA — bot em sala que o\n' +
      'cliente não conhece não serve.',
    COR.chatpro,
    COR.chatproFundo,
  ],
  [
    '4 · Bot na sala',
    'POST /api/v1/bot\n' +
      'metadata: { meeting_id, session_id }\n\n' +
      'A reunião é gravada no banco ANTES\n' +
      'desta chamada: se o timeout estourar\n' +
      'com o bot já criado, o webhook\n' +
      'reencontra a linha pelo metadata.',
    COR.recall,
    COR.recallFundo,
  ],
];

let maiorH = 0;
etapas.forEach(([t, c, cor, fundo], i) => {
  const cart = cartao(colX[i], Y, 420, t, c, { cor, fundo, altura: 190 });
  maiorH = Math.max(maiorH, cart.h);
  if (i < etapas.length - 1) seta(colX[i] + 426, Y + 95, colX[i + 1] - 6, Y + 95);
});

Y += maiorH + 30;
texto(0, Y, 'A ORDEM IMPORTA:', { fontSize: 14, cor: COR.perigo });
texto(
  150,
  Y,
  'link → mensagem → bot. Se a mensagem falhar, paramos e devolvemos o link pro atendente colar na mão.\n' +
    'Se o BOT falhar, o atendimento continua e a reunião fica marcada como "failed" no painel — só a gravação se perde.',
  { fontSize: 14, cor: COR.suave }
);

Y += 80;

// ═════════════════════════════════════════════════════════════════════════════
//  4. A VOLTA DA TRANSCRIÇÃO
// ═════════════════════════════════════════════════════════════════════════════

secao(0, Y, 1900, '4', 'A volta da transcrição — webhooks e fila durável');
Y += 60;

const w1 = cartao(
  0,
  Y,
  400,
  'Recall entrega o evento',
  'POST /webhooks/recall\n\n' +
    'Assinatura Svix: HMAC-SHA256 sobre\n' +
    'os BYTES CRUS do corpo.\n' +
    'express.raw() ANTES do json() global —\n' +
    'trocar a ordem quebra em silêncio.',
  { cor: COR.recall, fundo: COR.recallFundo, altura: 165 }
);

const w2 = cartao(
  460,
  Y,
  400,
  'Enfileira e responde 200',
  'tabela recall_events\n\n' +
    'O Recall exige 2xx em 15 s e desativa\n' +
    'quem falha 5 dias. Baixar transcript não\n' +
    'cabe nesse tempo: grava e responde.\n' +
    'webhook_id UNIQUE deduplica reentrega.',
  { cor: COR.nosso, fundo: COR.nossoFundo, altura: 165 }
);

const w3 = cartao(
  920,
  Y,
  400,
  'Worker processa com retry',
  'backoff 30 s → 15 min, máx 8\n\n' +
    'bot.*            → muda o status\n' +
    'transcript.done  → baixa e normaliza\n' +
    'transcript vazio → RETENTA (o arquivo\n' +
    'às vezes ainda não está escrito)',
  { cor: COR.nosso, fundo: COR.nossoFundo, altura: 165 }
);

const w4 = cartao(
  1380,
  Y,
  520,
  'Entrega como comentário',
  'POST /messages/addComments\n\n' +
    'Fatiada em partes de 3.500 caracteres, numeradas.\n' +
    'Falhou no meio? Guarda quantas entraram e o reenvio\n' +
    'CONTINUA de onde parou — nunca republica o que já está lá.',
  { cor: COR.chatpro, fundo: COR.chatproFundo, altura: 165 }
);

seta(406, Y + 82, 454, Y + 82);
seta(866, Y + 82, 914, Y + 82);
seta(1326, Y + 82, 1374, Y + 82);

Y += 195;
texto(
  0,
  Y,
  'Eventos podem chegar FORA DE ORDEM (o Svix reentrega por 24 h). Um bot.call_ended atrasado não derruba uma reunião já concluída,\n' +
    'e um transcript.done repetido não rebaixa nem reentrega — senão a transcrição apareceria duplicada na conversa do cliente.',
  { fontSize: 14, cor: COR.amarelo }
);

Y += 90;

// ═════════════════════════════════════════════════════════════════════════════
//  5. COMPONENTES
// ═════════════════════════════════════════════════════════════════════════════

secao(0, Y, 1900, '5', 'As peças');
Y += 60;

const topoComponentes = Y;

// Extensão
caixa(0, Y, 560, 340, { cor: COR.nosso, fundo: COR.nossoFundo, tracejado: true });
texto(20, Y + 16, 'EXTENSÃO  ·  Chrome MV3, JS puro, sem build', { fontSize: 15, cor: COR.nosso });
cartao(
  20,
  Y + 48,
  520,
  'content/botao-reuniao.js',
  'Acha os botões vizinhos pelo TEXTO ("transferir",\n' +
    '"finalizar"), CLONA um deles, troca ícone e rótulo.\n' +
    'Clonando, herda o CSS do chatPro: tema claro e\n' +
    'escuro saem certos de graça.',
  { cor: COR.neutro, fundo: '#ffffff', altura: 118 }
);
cartao(
  20,
  Y + 178,
  250,
  'popup/',
  'Conecta a conta\nGoogle, guarda\nendereço e chave.',
  { cor: COR.neutro, fundo: '#ffffff', altura: 118 }
);
cartao(
  290,
  Y + 178,
  250,
  'background/',
  'Ponte content↔API.\ndeviceId em\nstorage.sync.',
  { cor: COR.neutro, fundo: '#ffffff', altura: 118 }
);

// Servidor
caixa(620, Y, 700, 340, { cor: COR.nosso, fundo: COR.nossoFundo, tracejado: true });
texto(640, Y + 16, 'SERVIDOR  ·  Node 20 + TypeScript estrito + Express + SQLite', {
  fontSize: 15,
  cor: COR.nosso,
});
cartao(
  640,
  Y + 48,
  325,
  'routes/',
  'reunioes    o botão\n' +
    'meetings    lista e detalhe\n' +
    'recallHook  webhook assinado\n' +
    'chatproHook gatilho por link\n' +
    'painelAuth  a tranca\n' +
    'reviewPage  o painel',
  { cor: COR.neutro, fundo: '#ffffff', altura: 150 }
);
cartao(
  985,
  Y + 48,
  315,
  'clientes/',
  'recall/client   API do bot\n' +
    'recall/verify   assinatura\n' +
    'recall/transcript normaliza\n' +
    'chatpro/client  sparks\n' +
    'google/contas   OAuth\n' +
    'google/meetLink Calendar',
  { cor: COR.neutro, fundo: '#ffffff', altura: 150 }
);
cartao(
  640,
  Y + 210,
  660,
  'pipeline/recallQueue.ts  ·  o coração',
  'Fila durável dos webhooks: backoff, idempotência, entrega ao chatPro.\n' +
    'É onde moram as garantias de não perder nem duplicar transcrição.',
  { cor: COR.neutro, fundo: '#ffffff', altura: 100 }
);

// Externos
caixa(1380, Y, 520, 340, { cor: COR.linha, fundo: COR.neutroFundo, tracejado: true });
texto(1400, Y + 16, 'SERVIÇOS EXTERNOS', { fontSize: 15, cor: COR.neutro });
cartao(
  1400,
  Y + 48,
  480,
  'Google Calendar API',
  'conferenceData → link do Meet.\nEscopo calendar.events.',
  { cor: COR.google, fundo: '#ffffff', altura: 92 }
);
cartao(
  1400,
  Y + 142,
  480,
  'chatPro Chat  ·  sparks.chatpro.com.br',
  'header instance-token\nsendMessage · addComments · getSessionById',
  { cor: COR.chatpro, fundo: '#ffffff', altura: 88 }
);
cartao(
  1400,
  Y + 242,
  480,
  'Recall.ai  ·  us-west-2',
  'Authorization: Token\nbot · leave_call · webhooks Svix',
  { cor: COR.recall, fundo: '#ffffff', altura: 92 }
);

Y = topoComponentes + 340 + 60;

// ═════════════════════════════════════════════════════════════════════════════
//  6. BANCO
// ═════════════════════════════════════════════════════════════════════════════

secao(0, Y, 1900, '6', 'O que fica guardado (SQLite)');
Y += 60;

cartao(
  0,
  Y,
  600,
  'meetings',
  'id · bot_id · session_id · meeting_url · meeting_code\n' +
    'status · started_at · ended_at · duration_seconds\n' +
    'transcript_json · chatpro_status · chatpro_parts_sent\n' +
    'chatpro_instance_id · error · created_at',
  { cor: COR.nosso, fundo: COR.nossoFundo, altura: 130 }
);
cartao(
  660,
  Y,
  600,
  'recall_events  ·  a fila',
  'id · webhook_id (UNIQUE, deduplica)\n' +
    'event · bot_id · payload_json (corpo CRU)\n' +
    'status · attempts · next_attempt_at · last_error',
  { cor: COR.nosso, fundo: COR.nossoFundo, altura: 130 }
);
cartao(
  1320,
  Y,
  580,
  'google_accounts',
  'device_id (PK) · email\n' +
    'refresh_token_encrypted  ← AES-256-GCM\n' +
    'access_token · expiry\n\n' +
    'Uma conta por instalação da extensão.',
  { cor: COR.google, fundo: COR.googleFundo, altura: 140 }
);

Y += 160;
texto(
  0,
  Y,
  'Status da reunião:  created → joining → waiting_room → recording → ended → done      (ou failed, com o motivo em error)',
  { fontSize: 14, cor: COR.suave, fonte: 3 }
);

Y += 70;

// ═════════════════════════════════════════════════════════════════════════════
//  7. SEGURANÇA
// ═════════════════════════════════════════════════════════════════════════════

secao(0, Y, 1900, '7', 'Segurança — cada porta tem a sua tranca');
Y += 60;

const seg = [
  [
    '/webhooks/recall',
    'Assinatura Svix (HMAC sobre o corpo cru)\n+ anti-replay de 5 min.\nSem segredo, recusa tudo com 403.',
    COR.recall,
    COR.recallFundo,
  ],
  [
    '/webhooks/chatpro/{segredo}',
    'O chatPro NÃO assina os webhooks dele.\nSegredo no caminho + teto de 10 bots\npor 10 min — bot custa por hora.',
    COR.chatpro,
    COR.chatproFundo,
  ],
  [
    'Painel e /api/*',
    'PANEL_TOKEN (Bearer, ?token= ou cookie).\nO túnel do Recall publica o app INTEIRO,\ne as transcrições estão nele.',
    COR.perigo,
    COR.perigoFundo,
  ],
  [
    'Dados sensíveis',
    'Refresh token cifrado em AES-256-GCM.\nTranscrição nunca vai pro log.\nSem CORS em /api/meetings.',
    COR.neutro,
    COR.neutroFundo,
  ],
];

seg.forEach(([t, c, cor, fundo], i) => {
  cartao(i * 480, Y, 440, t, c, { cor, fundo, altura: 128 });
});

Y += 160;
texto(
  0,
  Y,
  'O callback do Google (/oauth/google/callback) é a única rota livre além dos webhooks: quem navega até lá é o Google redirecionando\n' +
    'o navegador, e não há como levar o token. Ela se protege pelo `state` de uso único, com 10 min de validade.',
  { fontSize: 14, cor: COR.suave }
);

Y += 90;

// ═════════════════════════════════════════════════════════════════════════════
//  8. DECISÕES E ARMADILHAS
// ═════════════════════════════════════════════════════════════════════════════

secao(0, Y, 1900, '8', 'Decisões que custaram caro — e por que estão assim');
Y += 60;

const licoes = [
  [
    'Por que Recall.ai e não ler a legenda',
    'A extensão anterior lia a legenda do Meet: texto repetido,\n' +
      'fala atribuída a quem não falou, e dava pra desligar a\n' +
      'legenda no meio. O Recall entrega diarização pronta —\n' +
      'os três problemas somem por construção.',
  ],
  [
    'Por que Calendar e não Meet REST API v2',
    'O Meet API exige Google Workspace. Todo mundo aqui usa\n' +
      '@gmail pessoal — foi o que derrubou o caminho anterior.\n' +
      'O Calendar gera o link nas duas.',
  ],
  [
    'Por que gravar a reunião ANTES de criar o bot',
    'Se o createBot estoura os 20 s DEPOIS de o Recall criar\n' +
      'o bot, ele entra na sala e grava sem nada no banco pra\n' +
      'casar com os webhooks. A reunião inteira se perderia, e\n' +
      'um segundo clique poria um segundo robô na chamada.',
  ],
  [
    'Por que fila durável e não processar direto',
    'O webhook precisa de 2xx em 15 s. Baixar o transcript e\n' +
      'entregar ao chatPro não cabe nisso. Sem a fila, uma falha\n' +
      'transitória perderia a transcrição pra sempre.',
  ],
  [
    'Por que clonar o botão vizinho',
    'O DOM do chatPro não tem classe estável. Clonando um\n' +
      'botão que já existe, o nosso herda o CSS deles: tema\n' +
      'claro, escuro, hover e espaçamento saem certos, e\n' +
      'continuam certos se eles mudarem o visual.',
  ],
  [
    'Por que o provider vem da sessão',
    'É POR CONVERSA, não por conta: a mesma instância tem\n' +
      'sessões em whatsapp e em cloud. Valor fixo no .env dava\n' +
      '400 "Provider está errado!" nas que não batiam.',
  ],
  [
    'Por que deviceId em storage.sync',
    'Em storage.local, remover e recarregar a extensão apagava\n' +
      'o vínculo com a conta Google — e a pessoa reconectava\n' +
      'sem entender por quê. O sync sobrevive à reinstalação.',
  ],
  [
    'Por que o supervisor recompila sempre',
    'Com o build fora do loop, matar o node reiniciava o\n' +
      'binário ANTIGO. Rotas novas respondiam 404 sem pista\n' +
      'nenhuma do motivo. Custou tempo duas vezes.',
  ],
];

licoes.forEach(([t, c], i) => {
  const col = i % 2;
  const lin = Math.floor(i / 2);
  cartao(col * 960, Y + lin * 155, 900, t, c, { cor: COR.amarelo, fundo: COR.amareloFundo, altura: 135 });
});

Y += Math.ceil(licoes.length / 2) * 155 + 40;

// ═════════════════════════════════════════════════════════════════════════════
//  9. O QUE FALTA
// ═════════════════════════════════════════════════════════════════════════════

secao(0, Y, 1900, '9', 'Estado atual');
Y += 60;

cartao(
  0,
  Y,
  920,
  '✓ Funcionando ponta a ponta',
  'Botão na barra do chatPro (tema claro e escuro)\n' +
    'Conta Google por atendente, link criado na agenda dele\n' +
    'Mensagem com o link chegando ao cliente\n' +
    'Bot do Recall entrando e gravando\n' +
    '255 testes · TypeScript estrito · autostart no Windows',
  { cor: COR.nosso, fundo: COR.nossoFundo, altura: 155 }
);

cartao(
  960,
  Y,
  940,
  '⧗ Falta pra fechar o ciclo',
  'Túnel HTTPS público (cloudflared) → PUBLIC_BASE_URL\n' +
    'Segredo de webhook no painel do Recall → RECALL_WEBHOOK_SECRET\n' +
    'Assinar os eventos, sem esquecer transcript.done\n\n' +
    'Sem isso o bot grava, mas a transcrição não volta.',
  { cor: COR.amarelo, fundo: COR.amareloFundo, altura: 155 }
);

Y += 185;
texto(
  0,
  Y,
  'Bot autenticado (conta Google dedicada) tiraria a sala de espera: hoje alguém precisa admitir o bot, e isso é manipulável.',
  { fontSize: 14, cor: COR.suave }
);

// ═════════════════════════════════════════════════════════════════════════════

const arquivo = {
  type: 'excalidraw',
  version: 2,
  source: 'chatPro Reuniões — docs/gerar-diagrama.mjs',
  elements: elementos,
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {},
};

const destino = join(AQUI, 'arquitetura.excalidraw');
writeFileSync(destino, JSON.stringify(arquivo, null, 2));
console.log(`${elementos.length} elementos → ${destino}`);

if (avisos.length > 0) {
  console.log(`\n${avisos.length} problema(s) de layout:`);
  for (const a of avisos) console.log(`  - ${a}`);
  process.exitCode = 1;
} else {
  console.log('layout ok: nenhum texto estourando a caixa');
}
