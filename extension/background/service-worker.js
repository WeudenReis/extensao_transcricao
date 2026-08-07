/**
 * Service worker da extensão — a ponte entre o botão no chatPro e o backend.
 *
 * MV3 dorme depois de ~30 s e perde tudo que estava em memória, então **todo
 * estado vive em chrome.storage** e os listeners ficam no topo do arquivo (se
 * forem registrados dentro de um callback, o worker acorda sem eles).
 */

const PADRAO = {
  backendUrl: 'http://localhost:3333',
  panelToken: '',
  deviceId: '',
};

/**
 * O deviceId é o que amarra a conta Google conectada — perdê-lo obriga a pessoa
 * a reconectar, sem entender por quê.
 *
 * Por isso ele mora em `storage.sync`, não em `local`: **remover e carregar a
 * extensão de novo APAGA o storage local**, e a conexão com o Google iria junto.
 * O sync sobrevive à reinstalação (fica no perfil do Chrome) e ainda cobre a
 * mesma pessoa em dois computadores com um vínculo só.
 *
 * Sem login no Chrome o sync não sincroniza, mas continua persistindo local —
 * então não há caso em que isto seja pior que `local`.
 */
async function lerDeviceId() {
  const doSync = await chrome.storage.sync.get('deviceId').catch(() => ({}));
  if (doSync.deviceId) return doSync.deviceId;

  // Migração: quem já instalou antes tem o id no local. Promove pro sync em vez
  // de gerar outro, senão a conta Google já conectada seria abandonada.
  const doLocal = await chrome.storage.local.get('deviceId');
  const id = doLocal.deviceId || crypto.randomUUID();
  await chrome.storage.sync.set({ deviceId: id }).catch(() => {});
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

async function config() {
  const guardado = await chrome.storage.local.get(Object.keys(PADRAO));
  const cfg = { ...PADRAO, ...guardado };
  cfg.deviceId = await lerDeviceId();
  return cfg;
}

function comToken(cfg, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cfg.panelToken) h.Authorization = `Bearer ${cfg.panelToken}`;
  return h;
}

async function chamar(caminho, opcoes = {}) {
  const cfg = await config();
  const base = String(cfg.backendUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Endereço do servidor não configurado na extensão.');

  const resposta = await fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: comToken(cfg, opcoes.headers),
  });

  const texto = await resposta.text();
  let corpo = null;
  try {
    corpo = texto ? JSON.parse(texto) : null;
  } catch {
    corpo = { error: texto.slice(0, 200) };
  }
  return { status: resposta.status, ok: resposta.ok, corpo };
}

// ─── Mensagens vindas do content script e do popup ───────────────────────────

chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  (async () => {
    try {
      if (msg?.tipo === 'INICIAR_REUNIAO') {
        const cfg = await config();
        const r = await chamar('/api/reunioes/iniciar', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: msg.sessionId,
            deviceId: cfg.deviceId,
            contato: msg.contato ?? null,
          }),
        });
        if (r.ok) {
          responder({ ok: true, dados: r.corpo });
          return;
        }
        responder({
          ok: false,
          erro: r.corpo?.detail || r.corpo?.error || `Servidor respondeu ${r.status}.`,
          precisaConectar: Boolean(r.corpo?.precisaConectar),
        });
        return;
      }

      if (msg?.tipo === 'STATUS_GOOGLE') {
        const cfg = await config();
        const r = await chamar(`/api/google/status?device=${encodeURIComponent(cfg.deviceId)}`);
        responder({ ok: r.ok, dados: r.corpo, deviceId: cfg.deviceId });
        return;
      }

      if (msg?.tipo === 'CONECTAR_GOOGLE') {
        const cfg = await config();
        const base = String(cfg.backendUrl || '').replace(/\/+$/, '');
        const url =
          `${base}/oauth/google/conectar?device=${encodeURIComponent(cfg.deviceId)}` +
          (cfg.panelToken ? `&token=${encodeURIComponent(cfg.panelToken)}` : '');
        await chrome.tabs.create({ url });
        responder({ ok: true });
        return;
      }

      if (msg?.tipo === 'DESCONECTAR_GOOGLE') {
        const cfg = await config();
        const r = await chamar('/api/google/desconectar', {
          method: 'POST',
          body: JSON.stringify({ deviceId: cfg.deviceId }),
        });
        responder({ ok: r.ok });
        return;
      }

      responder({ ok: false, erro: 'Mensagem desconhecida.' });
    } catch (err) {
      responder({ ok: false, erro: String(err?.message || err) });
    }
  })();

  // true = a resposta vem depois (async).
  return true;
});
