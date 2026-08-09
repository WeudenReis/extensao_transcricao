/** Popup: conectar a conta Google e apontar o servidor. */

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
  await atualizarStatusGoogle();
});

void (async () => {
  await carregarConfig();
  await atualizarStatusGoogle();
})();
