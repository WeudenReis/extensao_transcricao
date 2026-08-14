/**
 * Popup: mostra o estado do painel de reuniões e aponta o servidor.
 *
 * Quem cria o link da reunião é o PAINEL (POST /api/ext/agenda/meetings devolve
 * o meet_link). A conta Google virou plano B, pra quando o painel não está
 * configurado ou não responde. Por isso o painel fica no topo e a conta Google
 * só ganha destaque quando ela é, de fato, o caminho.
 */

const $ = (id) => document.getElementById(id);

function definirEstado(el, texto, tipo) {
  el.textContent = texto;
  el.classList.remove('ok', 'erro', 'oculto');
  if (tipo) el.classList.add(tipo);
}

async function carregarConfig() {
  const { backendUrl, panelToken } = await chrome.storage.local.get(['backendUrl', 'panelToken']);
  $('backend').value = backendUrl || 'http://localhost:3333';
  $('token').value = panelToken || '';
}

// ─── Painel de reuniões ──────────────────────────────────────────────────────

/**
 * Primeiro booleano de verdade na lista, ou `null` se nenhum campo existir.
 *
 * O diagnóstico pode chamar o "está respondendo" de `ok`, `alcancavel` ou
 * `saudavel` conforme quem escreveu a rota. Aceitar os três custa uma linha e
 * evita que o popup mostre "não dá pra verificar" só por causa do nome de um
 * campo.
 */
function primeiroBooleano(...valores) {
  for (const v of valores) if (typeof v === 'boolean') return v;
  return null;
}

function primeiroTexto(...valores) {
  for (const v of valores) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Traduz a resposta do diagnóstico em um dos quatro modos que a tela conhece:
 * `ok`, `nao-configurado`, `erro` e `desconhecido`.
 *
 * `desconhecido` é o modo importante: servidor antigo (sem a rota), endereço
 * apontando pro lugar errado ou servidor fora do ar. Nesses casos a extensão
 * NÃO tem como afirmar que o painel está quebrado — ela só não sabe — e o certo
 * é cair no comportamento antigo, com a conta Google em destaque.
 */
function interpretarDiagnostico(r) {
  if (!r) {
    return { modo: 'desconhecido', detalhe: 'A extensão não conseguiu falar com o serviço de fundo dela mesma. Recarregue a extensão em chrome://extensions.' };
  }
  if (r.semRota) {
    return {
      modo: 'desconhecido',
      detalhe: 'Este servidor ainda não sabe responder a checagem do painel. Atualize o servidor pra ver esse estado aqui.',
    };
  }
  if (r.erro) return { modo: 'desconhecido', detalhe: r.erro };
  if (r.status === 401 || r.status === 403) {
    // A tranca que recusou é a do NOSSO servidor, e a chave dela está logo
    // abaixo nesta mesma tela — dizer isso poupa a viagem até o .env.
    return {
      modo: 'desconhecido',
      detalhe: 'O servidor recusou a chave. Confira a Chave do painel abaixo.',
    };
  }

  // Uma resposta pode vir achatada ou dentro de `painel`/`diagnostico` — os dois
  // formatos são plausíveis e nenhum deles justifica a tela mentir.
  const corpo = r.dados ?? null;
  const d = (corpo && typeof corpo === 'object' && (corpo.painel ?? corpo.diagnostico)) || corpo;

  const configurado = primeiroBooleano(d?.configurado, d?.configured);
  if (configurado === null) {
    // Chegou alguma coisa que não é a nossa rota (o HTML de um SPA, um proxy…).
    // Mesmo diagnóstico do bloco do servidor: o endereço é o suspeito.
    return {
      modo: 'desconhecido',
      detalhe:
        'Resposta inesperada do servidor. O Endereço abaixo aponta pro lugar certo? ' +
        'Use só http://localhost:3333, sem caminho nem ?token=.',
    };
  }

  if (!configurado) {
    // O `detalhe` do diagnóstico nomeia a variável que falta (PAINEL_API_URL,
    // PAINEL_EXT_AGENDA_TOKEN). Quem instala o servidor lê isso daqui mesmo, e
    // quem só atende lê a segunda frase, que é a que muda o dia dele.
    const motivo = primeiroTexto(d?.detalhe, d?.detail, d?.erro, d?.mensagem, d?.error);
    return {
      modo: 'nao-configurado',
      detalhe: `${motivo || 'O servidor está sem o endereço do painel.'} Enquanto isso, o link da reunião vem da conta Google.`,
    };
  }

  const mensagem = primeiroTexto(d?.detalhe, d?.erro, d?.mensagem, d?.detail, d?.error, d?.motivo);
  const respondendo = primeiroBooleano(d?.ok, d?.alcancavel, d?.saudavel, d?.online, d?.conectado);

  // Sem campo de saúde, a mensagem de erro é o que sobra pra decidir: se veio
  // uma, é problema; se não veio nenhuma, o painel está configurado e calado —
  // e calado aqui é boa notícia.
  if (respondendo === false || (respondendo === null && mensagem)) {
    return { modo: 'erro', mensagem: mensagem || 'o painel não respondeu' };
  }
  return { modo: 'ok' };
}

const VALOR_PAINEL = {
  ok: 'conectado',
  'nao-configurado': 'não configurado',
  desconhecido: 'não dá pra verificar',
};

function pintarPainel(estado) {
  const linha = $('painel-linha');
  const valor = $('painel-valor');
  const detalhe = $('painel-detalhe');

  valor.textContent = estado.modo === 'erro' ? estado.mensagem : VALOR_PAINEL[estado.modo];

  linha.classList.remove('ok', 'erro', 'neutro');
  linha.classList.add(estado.modo === 'ok' ? 'ok' : estado.modo === 'erro' ? 'erro' : 'neutro');

  const texto =
    estado.modo === 'ok'
      ? 'Os links das reuniões são criados por ele.'
      : estado.modo === 'erro'
        ? 'Enquanto isso, o link da reunião vem da conta Google.'
        : estado.detalhe || '';
  detalhe.textContent = texto;
  detalhe.classList.toggle('oculto', !texto);
}

/**
 * Com o painel de pé, a conta Google recolhe pra uma linha discreta: são 5 a 12
 * atendentes, e um bloco em destaque chamado "CONTA GOOGLE" faz cada um deles
 * achar que precisa conectar a sua antes de trabalhar.
 */
function aplicarModoGoogle(modo) {
  const bloco = $('google-bloco');
  const reserva = modo === 'ok';

  bloco.classList.toggle('destaque', !reserva);
  bloco.open = !reserva;
  $('google-tag').classList.toggle('oculto', !reserva);
  $('google-ajuda').textContent = reserva
    ? 'O painel já cria os links das reuniões. Esta conta é só reserva, pra quando ele estiver fora do ar — não precisa conectar nada aqui.'
    : 'É com ela que o link da reunião é criado. Funciona com conta pessoal.';
}

async function atualizarStatusPainel() {
  try {
    const r = await chrome.runtime.sendMessage({ tipo: 'PAINEL_STATUS' });
    const estado = interpretarDiagnostico(r);
    pintarPainel(estado);
    aplicarModoGoogle(estado.modo);
  } catch (err) {
    const estado = { modo: 'desconhecido', detalhe: String(err?.message || err) };
    pintarPainel(estado);
    aplicarModoGoogle(estado.modo);
  }
}

// Em destaque o bloco não recolhe: esconder o único caminho pra criar o link
// seria deixar a pessoa sem saída, e o clique no título é fácil de dar sem querer.
$('google-titulo').addEventListener('click', (evento) => {
  if ($('google-bloco').classList.contains('destaque')) evento.preventDefault();
});

// ─── Conta Google ────────────────────────────────────────────────────────────

async function atualizarStatusGoogle() {
  const estado = $('google-estado');
  definirEstado(estado, 'Verificando…');
  try {
    const r = await chrome.runtime.sendMessage({ tipo: 'STATUS_GOOGLE' });
    if (!r?.ok) {
      definirEstado(estado, 'Não deu pra falar com o servidor. Confira o endereço abaixo.', 'erro');
      mostrarBotoes(false);
      return;
    }
    // `configurado` só é booleano quando a resposta veio MESMO da nossa rota.
    // Se o endereço apontar pro lugar errado, a resposta é outra coisa (o HTML
    // do painel, por exemplo) e `configurado` vem undefined — que não é a
    // mesma coisa que "o servidor está sem as credenciais". Antes os dois
    // casos davam a mesma mensagem, e ela mandava procurar no .env um problema
    // que estava no campo de endereço.
    if (typeof r.dados?.configurado !== 'boolean') {
      definirEstado(
        estado,
        'Resposta inesperada do servidor. O Endereço abaixo aponta pro lugar certo? ' +
          'Use só http://localhost:3333, sem caminho nem ?token=.',
        'erro'
      );
      mostrarBotoes(false);
      return;
    }
    if (!r.dados.configurado) {
      definirEstado(
        estado,
        'O servidor está sem as credenciais do Google (GOOGLE_CLIENT_ID/SECRET no .env).',
        'erro'
      );
      mostrarBotoes(false);
      return;
    }
    if (r.dados?.conectado) {
      definirEstado(estado, `Conectado: ${r.dados.email || 'conta Google'}`, 'ok');
      mostrarBotoes(true);
      return;
    }
    definirEstado(estado, 'Nenhuma conta conectada.');
    mostrarBotoes(false);
  } catch {
    definirEstado(estado, 'Não deu pra falar com o servidor.', 'erro');
    mostrarBotoes(false);
  }
}

function mostrarBotoes(conectado) {
  $('conectar').textContent = conectado ? 'Trocar de conta' : 'Conectar conta Google';
  $('desconectar').classList.toggle('oculto', !conectado);
}

$('conectar').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ tipo: 'CONECTAR_GOOGLE' });
  // A conexão termina na aba que abriu; ao voltar ao popup, o status atualiza.
  window.close();
});

$('desconectar').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ tipo: 'DESCONECTAR_GOOGLE' });
  await atualizarStatusGoogle();
});

// ─── Servidor ────────────────────────────────────────────────────────────────

/**
 * Fica só com a origem: protocolo + host + porta.
 *
 * É fácil colar aqui a URL do PAINEL (`http://localhost:3333/?token=…`) em vez
 * do endereço do servidor. Com o caminho e a query junto, toda chamada da
 * extensão vira `…/?token=…/api/google/status`, que o Express roteia pra `/` e
 * devolve o HTML do painel — a extensão então conclui "servidor sem
 * credenciais do Google", que é um diagnóstico errado e manda procurar longe.
 *
 * Também aceita quem digita só `localhost:3333`, sem protocolo.
 */
function normalizarEndereco(bruto) {
  const texto = bruto.trim();
  if (!texto) return '';
  const comProtocolo = /^https?:\/\//i.test(texto) ? texto : `http://${texto}`;
  try {
    return new URL(comProtocolo).origin;
  } catch {
    // Não é URL válida: devolve como veio e deixa a chamada falhar com a
    // mensagem de rede, que é mais honesta que inventar um endereço.
    return texto.replace(/\/+$/, '');
  }
}

$('salvar').addEventListener('click', async () => {
  const digitado = $('backend').value;
  const backendUrl = normalizarEndereco(digitado);
  const panelToken = $('token').value.trim();
  await chrome.storage.local.set({ backendUrl, panelToken });

  // Mostra o que foi realmente guardado: se limpamos um caminho colado junto,
  // a pessoa precisa ver isso acontecendo, não descobrir depois.
  $('backend').value = backendUrl;
  const mudou = digitado.trim() !== backendUrl;
  definirEstado($('salvo'), mudou ? `Salvo como ${backendUrl}` : 'Salvo.', 'ok');
  setTimeout(() => $('salvo').classList.add('oculto'), 4000);
  await Promise.all([atualizarStatusPainel(), atualizarStatusGoogle()]);
});

void (async () => {
  await carregarConfig();
  await Promise.all([atualizarStatusPainel(), atualizarStatusGoogle()]);
})();
