/**
 * Service worker (MV3) da chatPro Meet Transcripts.
 *
 * REGRA DE OURO DO MV3: o service worker DORME a qualquer momento e perde
 * toda a memória. Por isso NENHUM estado vive em variável — a fonte de
 * verdade é sempre chrome.storage.local. Variáveis aqui são só cache
 * transitório dentro de um único acordar.
 *
 * Chaves no storage:
 *   lastSession { sessionId, url, capturedAt }
 *   lastMeet    { meetingCode, inCall, capturedAt }
 *   links       [ { sessionId, meetingCode, linkedAt, source, sentToBackend } ] (máx. 20)
 *   settings    { backendUrl, autoLink }
 */

'use strict';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  backendUrl: 'http://localhost:3333',
  autoLink: true,
};

const MAX_LINKS = 20;
// Sessão do chatPro vale como "ativa" por 4 horas após a captura.
const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const RETRY_ALARM = 'retry-links';

// Mesmas regexes dos content scripts — aqui elas rodam sobre a URL da aba,
// garantindo captura imediata na troca de aba sem depender do content script.
const SESSION_REGEX =
  /\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const MEET_CODE_REGEX = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i;
const MEET_CODE_FALLBACK_REGEX = /meet\.google\.com\/([a-z0-9-]{10,})/i;
const MEET_IGNORED_PATHS = new Set([
  'landing',
  'new',
  'lookup',
  'whoops',
  'unsupported',
  'settings',
  'calls',
]);

const CHATPRO_URL_PREFIX = 'https://app.chatpro.com.br/';
const MEET_URL_PREFIX = 'https://meet.google.com/';

function debug(...args) {
  try {
    console.debug('[chatPro ext]', ...args);
  } catch (_) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Fila de escrita: dentro de UM acordar do service worker, vários eventos
// podem tentar ler-modificar-gravar `links` ao mesmo tempo (mensagem + alarm).
// Serializar evita que um sobrescreva o outro. Entre acordares não há risco:
// cada evento recomeça lendo do storage.
// ---------------------------------------------------------------------------
let writeQueue = Promise.resolve();
function enqueue(taskFn) {
  writeQueue = writeQueue.then(taskFn).catch((err) => {
    debug('erro em tarefa da fila:', err);
  });
  return writeQueue;
}

// ---------------------------------------------------------------------------
// Acesso ao estado (sempre via storage — ver nota no topo)
// ---------------------------------------------------------------------------
async function getState() {
  const data = await chrome.storage.local.get({
    lastSession: null,
    lastMeet: null,
    links: [],
    settings: DEFAULT_SETTINGS,
  });
  // Garante defaults mesmo se settings foi salvo parcialmente.
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  return data;
}

function isSessionFresh(lastSession, now = Date.now()) {
  if (!lastSession || !lastSession.capturedAt) return false;
  const capturedAt = Date.parse(lastSession.capturedAt);
  if (Number.isNaN(capturedAt)) return false;
  return now - capturedAt <= SESSION_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Badge: "✓" verde quando há sessão ativa; vazio caso contrário.
// ---------------------------------------------------------------------------
async function updateBadge(lastSession) {
  try {
    const active = isSessionFresh(lastSession);
    await chrome.action.setBadgeBackgroundColor({ color: '#25D066' });
    await chrome.action.setBadgeText({ text: active ? '✓' : '' });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
    }
  } catch (err) {
    debug('falha ao atualizar badge:', err);
  }
}

// ---------------------------------------------------------------------------
// Extração de ids a partir de URLs (usada pelos listeners de tabs)
// ---------------------------------------------------------------------------
function extractSessionIdFromUrl(url) {
  if (!url) return null;
  const match = SESSION_REGEX.exec(url);
  return match ? match[1].toLowerCase() : null;
}

function extractMeetingCodeFromUrl(url) {
  if (!url) return null;

  const primary = MEET_CODE_REGEX.exec(url);
  if (primary) return primary[1].toLowerCase();

  const fallback = MEET_CODE_FALLBACK_REGEX.exec(url);
  if (fallback) {
    const code = fallback[1].toLowerCase();
    if (MEET_IGNORED_PATHS.has(code.split('/')[0])) return null;
    return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Backend: POST do vínculo em ${backendUrl}/api/links
// ---------------------------------------------------------------------------
async function postLinkToBackend(link, settings) {
  const url = `${settings.backendUrl.replace(/\/+$/, '')}/api/links`;
  // AbortController: fetch sem timeout pode segurar o service worker à toa.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: link.sessionId,
        meetingCode: link.meetingCode,
        linkedAt: link.linkedAt,
        source: link.source,
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch (err) {
    debug('backend indisponível:', err && err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Criação de vínculo (auto ou manual)
// ---------------------------------------------------------------------------
async function createLink(sessionId, meetingCode, source) {
  return enqueue(async () => {
    const state = await getState();

    // Dedup: nunca criar dois vínculos com o mesmo par sessionId+meetingCode.
    const exists = state.links.some(
      (l) => l.sessionId === sessionId && l.meetingCode === meetingCode
    );
    if (exists) {
      debug('vínculo já existe, ignorando:', sessionId, meetingCode);
      return null;
    }

    const link = {
      sessionId,
      meetingCode,
      linkedAt: new Date().toISOString(),
      source, // 'auto' | 'manual'
      sentToBackend: false,
    };

    link.sentToBackend = await postLinkToBackend(link, state.settings);

    // Mais recente primeiro; mantém só os últimos MAX_LINKS.
    const links = [link, ...state.links].slice(0, MAX_LINKS);
    await chrome.storage.local.set({ links });
    debug('vínculo criado:', link);
    return link;
  });
}

/** Reenvia vínculos pendentes (sentToBackend === false). */
async function retryPendingLinks() {
  return enqueue(async () => {
    const state = await getState();
    const pending = state.links.filter((l) => !l.sentToBackend);
    if (pending.length === 0) return;

    debug(`retry: ${pending.length} vínculo(s) pendente(s)`);
    let changed = false;
    for (const link of pending) {
      const ok = await postLinkToBackend(link, state.settings);
      if (ok) {
        link.sentToBackend = true;
        changed = true;
      }
    }
    if (changed) {
      await chrome.storage.local.set({ links: state.links });
    }
  });
}

// ---------------------------------------------------------------------------
// Handlers dos eventos de captura
// ---------------------------------------------------------------------------
async function handleChatproSession(sessionId, url, capturedAt) {
  const lastSession = {
    sessionId,
    url: url || null,
    capturedAt: capturedAt || new Date().toISOString(),
  };
  await chrome.storage.local.set({ lastSession });
  await updateBadge(lastSession);
  debug('sessão registrada:', sessionId);
}

/**
 * @param {string} meetingCode
 * @param {boolean|null} inCall - null quando veio da URL da aba (sem DOM);
 *   nesse caso preservamos o inCall anterior se for a mesma sala.
 */
async function handleMeetDetected(meetingCode, inCall, capturedAt) {
  const state = await getState();

  let effectiveInCall = inCall;
  if (effectiveInCall === null || effectiveInCall === undefined) {
    effectiveInCall =
      state.lastMeet && state.lastMeet.meetingCode === meetingCode
        ? Boolean(state.lastMeet.inCall)
        : false;
  }

  const lastMeet = {
    meetingCode,
    inCall: Boolean(effectiveInCall),
    capturedAt: capturedAt || new Date().toISOString(),
  };
  await chrome.storage.local.set({ lastMeet });
  debug('meet registrado:', meetingCode, 'inCall:', lastMeet.inCall);

  // Vínculo automático: só quando existe sessão capturada nas últimas 4h.
  if (state.settings.autoLink && isSessionFresh(state.lastSession)) {
    await createLink(state.lastSession.sessionId, meetingCode, 'auto');
  }
}

// ---------------------------------------------------------------------------
// Mensagens dos content scripts e do popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  switch (message.type) {
    case 'CHATPRO_SESSION': {
      handleChatproSession(message.sessionId, message.url, message.capturedAt)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // resposta assíncrona
    }

    case 'MEET_DETECTED': {
      handleMeetDetected(
        message.meetingCode,
        typeof message.inCall === 'boolean' ? message.inCall : null,
        message.capturedAt
      )
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case 'GET_STATE': {
      getState()
        .then((state) => {
          state.sessionActive = isSessionFresh(state.lastSession);
          sendResponse({ ok: true, state });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case 'MANUAL_LINK': {
      (async () => {
        const state = await getState();
        if (!state.lastSession || !state.lastMeet) {
          sendResponse({
            ok: false,
            error: 'Sessão do chatPro ou reunião do Meet ainda não detectadas.',
          });
          return;
        }
        const link = await createLink(
          state.lastSession.sessionId,
          state.lastMeet.meetingCode,
          'manual'
        );
        sendResponse({ ok: true, link, duplicated: link === null });
      })().catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // Os content scripts (legenda e áudio) pedem a MESMA captura por aqui.
    case 'GET_CAPTURE': {
      obterOuCriarCaptura(message.meetingCode, message.mode)
        .then((captureId) => sendResponse({ ok: Boolean(captureId), captureId }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case 'END_CAPTURE': {
      encerrarCaptura(message.reason)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // Popup pediu pra iniciar a gravação (tabCapture). O streamId JÁ veio do
    // popup, que o obteve no gesto do clique (o Chrome exige gesto pra capturar).
    case 'START_TAB_CAPTURE': {
      startTabCapture(message.streamId, message.tabId, message.meetingCode)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case 'STOP_TAB_CAPTURE': {
      stopTabCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // Vindas do offscreen:
    case 'CAPTURE_STATUS': {
      recordingTabId = message.capturing ? recordingTabId : null;
      chrome.storage.local.set({
        recording: {
          capturing: Boolean(message.capturing),
          captureId: message.captureId || null,
          bytesSent: message.bytesSent || 0,
          meetingCode: message.meetingCode || null,
        },
      });
      return false;
    }
    case 'CAPTURE_ERROR': {
      chrome.storage.local.set({ recording: { capturing: false, error: message.error || 'erro' } });
      closeOffscreen();
      return false;
    }
    case 'CAPTURE_ENDED': {
      recordingTabId = null;
      chrome.storage.local.set({ recording: { capturing: false } });
      closeOffscreen();
      return false;
    }

    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// DONO ÚNICO DA SESSÃO DE CAPTURA.
//
// Existem dois caminhos capturando a mesma reunião (legenda e áudio). Se cada um
// chamar /api/capture/start, a reunião aparece DUPLICADA no painel — foi o que
// aconteceu. Aqui o service worker cria a captura UMA vez por meetingCode e
// entrega o mesmo captureId para os dois.
// ---------------------------------------------------------------------------
let capturaAtual = null; // { meetingCode, captureId }
let criacaoEmAndamento = null; // Promise (evita corrida entre os dois scripts)

async function obterOuCriarCaptura(meetingCode, modo) {
  if (!meetingCode) return null;
  if (capturaAtual && capturaAtual.meetingCode === meetingCode) {
    return capturaAtual.captureId;
  }
  if (criacaoEmAndamento) return criacaoEmAndamento;

  criacaoEmAndamento = (async () => {
    const state = await getState();
    const sessionId =
      state.lastSession && isSessionFresh(state.lastSession)
        ? state.lastSession.sessionId
        : null;
    const url = `${state.settings.backendUrl.replace(/\/+$/, '')}/api/capture/start`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingCode,
          sessionId,
          startedAt: new Date().toISOString(),
          mode: modo || 'captions',
          mimeType: 'text/vtt',
        }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const { captureId } = await resp.json();
      capturaAtual = { meetingCode, captureId };
      debug('captura única criada:', captureId, 'para', meetingCode);
      return captureId;
    } catch (err) {
      debug('falha ao criar captura:', err && err.message);
      return null;
    } finally {
      criacaoEmAndamento = null;
    }
  })();
  return criacaoEmAndamento;
}

async function encerrarCaptura(motivo) {
  if (!capturaAtual) return;
  const { captureId } = capturaAtual;
  capturaAtual = null;
  const state = await getState();
  const url = `${state.settings.backendUrl.replace(/\/+$/, '')}/api/capture/stop`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        captureId,
        endedAt: new Date().toISOString(),
        reason: motivo || 'call-ended',
        totalChunks: { mic: 0, remote: 0 },
      }),
    });
    debug('captura encerrada:', captureId);
  } catch (err) {
    debug('falha ao encerrar captura:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// tabCapture + offscreen: gravação confiável do áudio da reunião.
// A aba (tabCapture) traz as vozes remotas (cliente); o microfone é capturado
// no próprio offscreen. Precisa de um clique do usuário no popup (regra do Chrome).
// ---------------------------------------------------------------------------
let recordingTabId = null;

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Gravar o áudio da reunião do Meet para transcrição.',
  });
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
  } catch (err) {
    debug('falha ao fechar offscreen:', err);
  }
}

async function startTabCapture(streamId, tabId, meetingCode) {
  if (!streamId) throw new Error('streamId ausente');
  await ensureOffscreen();
  const state = await getState();
  const sessionId =
    state.lastSession && isSessionFresh(state.lastSession) ? state.lastSession.sessionId : null;
  recordingTabId = tabId || null;
  const codigo = meetingCode || (state.lastMeet && state.lastMeet.meetingCode) || null;
  // Sessão compartilhada: o offscreen usa a MESMA captura da legenda/áudio.
  const captureId = await obterOuCriarCaptura(codigo, 'tab-capture');
  // Pequena espera pra garantir que o offscreen registrou o listener.
  await new Promise((r) => setTimeout(r, 150));
  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START',
    streamId,
    backendUrl: state.settings.backendUrl,
    meetingCode: codigo,
    sessionId,
    captureId,
  });
}

async function stopTabCapture() {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' });
}

// Se a aba que está sendo gravada fechar, encerra a captura.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (recordingTabId && tabId === recordingTabId) {
    stopTabCapture().catch(() => {});
    recordingTabId = null;
  }
});

/**
 * Rede de segurança: se não sobrar nenhuma aba na reunião que está sendo
 * capturada (fechou ou navegou pra fora), encerra a sessão. Sem isso, uma
 * captura poderia ficar "aberta" pra sempre e nunca transcrever.
 */
async function encerrarSeNaoHaAbaDaReuniao() {
  if (!capturaAtual) return;
  const codigo = capturaAtual.meetingCode;
  try {
    const abas = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    const aindaAberta = abas.some((t) => (t.url || '').includes(codigo));
    if (!aindaAberta) {
      debug('nenhuma aba da reunião', codigo, '— encerrando captura');
      await encerrarCaptura('tab-closed');
    }
  } catch (err) {
    debug('falha ao checar abas da reunião:', err);
  }
}

chrome.tabs.onRemoved.addListener(() => {
  setTimeout(() => encerrarSeNaoHaAbaDaReuniao(), 500);
});
chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
  if (changeInfo.url) setTimeout(() => encerrarSeNaoHaAbaDaReuniao(), 500);
});

// ---------------------------------------------------------------------------
// Captura direta pela URL da aba: garante detecção imediata na troca de aba,
// mesmo antes de o content script rodar (ou em páginas onde ele falhou).
// ---------------------------------------------------------------------------
async function inspectTabUrl(url) {
  try {
    if (!url) return;

    if (url.startsWith(CHATPRO_URL_PREFIX)) {
      const sessionId = extractSessionIdFromUrl(url);
      if (!sessionId) return;
      // Mesmo com o MESMO sessionId, regravamos para RENOVAR o capturedAt:
      // a conversa segue aberta/ativa, então a sessão continua "fresca".
      // Sem isso, após 4h com a mesma conversa o auto-link pararia.
      await handleChatproSession(sessionId, url, new Date().toISOString());
      return;
    }

    if (url.startsWith(MEET_URL_PREFIX)) {
      const meetingCode = extractMeetingCodeFromUrl(url);
      if (!meetingCode) return;
      const state = await getState();
      if (state.lastMeet && state.lastMeet.meetingCode === meetingCode) return;
      // inCall = null → handler preserva/assume false; o content script
      // corrige em seguida com a heurística de DOM.
      await handleMeetDetected(meetingCode, null, new Date().toISOString());
    }
  } catch (err) {
    debug('falha ao inspecionar URL da aba:', err);
  }
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url) inspectTabUrl(changeInfo.url);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url) await inspectTabUrl(tab.url);
  } catch (err) {
    debug('falha no onActivated:', err);
  }
});

// ---------------------------------------------------------------------------
// Alarm de retry: a cada 1 min tenta reenviar vínculos pendentes.
// chrome.alarms acorda o service worker mesmo dormindo — é o mecanismo
// correto no MV3 (setInterval morreria junto com o worker).
// ---------------------------------------------------------------------------
async function ensureRetryAlarm() {
  try {
    const existing = await chrome.alarms.get(RETRY_ALARM);
    if (!existing) {
      await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
      debug('alarm de retry criado');
    }
  } catch (err) {
    debug('falha ao criar alarm:', err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) retryPendingLinks();
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureRetryAlarm();
  const state = await getState();
  // Persiste settings com defaults na instalação (facilita edição no popup).
  await chrome.storage.local.set({ settings: state.settings });
  await updateBadge(state.lastSession);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureRetryAlarm();
  const state = await getState();
  await updateBadge(state.lastSession);
});

// Cada acordar do worker também garante o alarm (cinto de segurança).
ensureRetryAlarm();
