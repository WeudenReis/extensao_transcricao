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
    if (!r.dados?.configurado) {
      definirEstado(
        estado,
        'O servidor está sem as credenciais do Google (GOOGLE_CLIENT_ID/SECRET).',
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

$('salvar').addEventListener('click', async () => {
  const backendUrl = $('backend').value.trim().replace(/\/+$/, '');
  const panelToken = $('token').value.trim();
  await chrome.storage.local.set({ backendUrl, panelToken });
  definirEstado($('salvo'), 'Salvo.', 'ok');
  setTimeout(() => $('salvo').classList.add('oculto'), 2500);
  await atualizarStatusGoogle();
});

void (async () => {
  await carregarConfig();
  await atualizarStatusGoogle();
})();
