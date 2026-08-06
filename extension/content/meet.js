/**
 * Content script do Google Meet (meet.google.com).
 *
 * Responsabilidade: extrair o meeting code da URL e estimar se o atendente
 * está DENTRO da chamada, avisando o service worker a cada mudança.
 * A heurística não precisa ser perfeita — o vínculo é feito pelo code.
 *
 * Tudo dentro de uma IIFE para não vazar nenhum global para a página.
 */
(() => {
  'use strict';

  const LOG_PREFIX = '[chatPro ext]';

  // Formato clássico do Meet: abc-defg-hij
  const MEET_CODE_REGEX = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i;
  // Fallback mais frouxo (links legados/curtos personalizados).
  const MEET_CODE_FALLBACK_REGEX = /meet\.google\.com\/([a-z0-9-]{10,})/i;
  // Paths que parecem código mas são páginas do produto — nunca são reunião.
  const IGNORED_PATHS = new Set([
    'landing',
    'new',
    'lookup',
    'whoops',
    'unsupported',
    'settings',
    'calls',
  ]);

  // Último estado enviado (evita spam quando nada mudou).
  let lastSent = { meetingCode: null, inCall: null };
  let debounceTimer = null;
  let safetyInterval = null;

  /** Log de debug que nunca quebra a página. */
  function debug(...args) {
    try {
      console.debug(LOG_PREFIX, ...args);
    } catch (_) {
      /* silencioso de propósito */
    }
  }

  /** Extrai o meeting code da URL atual, ou null. */
  function extractMeetingCode() {
    const href = window.location.href;

    const primary = MEET_CODE_REGEX.exec(href);
    if (primary) return primary[1].toLowerCase();

    const fallback = MEET_CODE_FALLBACK_REGEX.exec(href);
    if (fallback) {
      const code = fallback[1].toLowerCase();
      // Descarta paths conhecidos do produto (o primeiro segmento).
      const firstSegment = code.split('/')[0];
      if (IGNORED_PATHS.has(firstSegment)) return null;
      return code;
    }

    return null;
  }

  /**
   * Heurística de "estou dentro da chamada":
   * 1) botão de encerrar chamada ou de microfone presente no DOM
   *    (seletores com fallback — o Meet troca classes com frequência,
   *    então preferimos aria-label e atributos estáveis);
   * 2) se nada casar, considera in-call quando a URL tem meeting code e o
   *    document.title não é o "Google Meet" puro da tela de lobby.
   */
  function detectInCall(meetingCode) {
    try {
      const selectors = [
        // Botão de sair/encerrar (pt-BR e en).
        '[aria-label*="Sair da chamada" i]',
        '[aria-label*="Encerrar chamada" i]',
        '[aria-label*="Leave call" i]',
        '[aria-label*="End call" i]',
        // Botão de microfone dentro da chamada (atributo estável do Meet).
        '[data-is-muted]',
        '[aria-label*="microfone" i]',
        '[aria-label*="microphone" i]',
      ];
      for (const selector of selectors) {
        if (document.querySelector(selector)) return true;
      }
    } catch (err) {
      debug('falha na heurística de in-call:', err);
    }

    // Fallback: dentro da chamada o título vira o próprio code/nome da sala.
    const title = (document.title || '').trim();
    return Boolean(meetingCode) && title !== '' && title !== 'Google Meet';
  }

  /** Lê o estado atual e envia se algo mudou desde o último envio. */
  function checkAndReport() {
    try {
      const meetingCode = extractMeetingCode();
      if (!meetingCode) return; // fora de uma sala não há o que reportar

      const inCall = detectInCall(meetingCode);
      if (
        meetingCode === lastSent.meetingCode &&
        inCall === lastSent.inCall
      ) {
        return; // nada mudou
      }

      lastSent = { meetingCode, inCall };
      debug('meet detectado:', meetingCode, 'inCall:', inCall);

      chrome.runtime.sendMessage(
        {
          type: 'MEET_DETECTED',
          meetingCode,
          inCall,
          capturedAt: new Date().toISOString(),
        },
        () => {
          if (chrome.runtime.lastError) {
            debug('sendMessage falhou:', chrome.runtime.lastError.message);
          }
        }
      );
    } catch (err) {
      debug('erro ao reportar meet:', err);
    }
  }

  /** Debounce de 500ms — o Meet mexe no DOM o tempo todo durante a chamada. */
  function scheduleCheck() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      checkAndReport();
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  try {
    // MutationObserver percebe a transição lobby → chamada (o DOM muda muito).
    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body || document.documentElement, {
      subtree: true,
      childList: true,
    });

    // Cinto de segurança: interval leve de 5s cobre casos em que o observer
    // não dispara (ex.: só o title mudou). Limpo em pagehide para não vazar.
    safetyInterval = setInterval(checkAndReport, 5000);
    window.addEventListener('pagehide', () => {
      if (safetyInterval) clearInterval(safetyInterval);
      if (debounceTimer) clearTimeout(debounceTimer);
      try {
        observer.disconnect();
      } catch (_) {
        /* ignore */
      }
    });

    checkAndReport(); // primeira leitura imediata
  } catch (err) {
    debug('falha no bootstrap:', err);
  }
})();

/**
 * Ponte de captura de áudio (mundo isolado).
 *
 * Recebe do meet-tap.js (world MAIN) os eventos CAPTURE_START/CHUNK/CAPTURE_STOP/
 * STATS via window.postMessage e conversa com o backend. Os bytes dos chunks
 * vão por fetch direto (application/octet-stream) — nunca por sendMessage.
 *
 * TRANSPARÊNCIA: enquanto grava, injeta um banner visível na página e reporta o
 * status ao service worker (para o indicador do popup). O uso pressupõe aviso de
 * consentimento ao cliente — ver docs/CAPTURA-AUDIO.md.
 */
(() => {
  'use strict';

  const LOG_PREFIX = '[chatPro ext]';
  const TAG = 'chatpro-tap';
  const HEARTBEAT_MS = 15000;
  const MAX_QUEUE = 50; // chunks em espera antes de descartar os mais antigos
  const MAX_QUEUE_BYTES = 20 * 1024 * 1024;

  function debug(...args) {
    try {
      console.debug(LOG_PREFIX, ...args);
    } catch (_) {
      /* ignore */
    }
  }

  const MEET_CODE_REGEX = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i;
  function currentMeetingCode() {
    const m = MEET_CODE_REGEX.exec(window.location.href);
    return m ? m[1].toLowerCase() : null;
  }

  // --- Estado da ponte ------------------------------------------------------
  let backendUrl = 'http://localhost:3333';
  let captureId = null;
  let bytesSent = 0;
  let lastStats = { capturing: false, micActive: false, remoteTracks: 0 };
  let heartbeatTimer = null;
  const pendingChunks = []; // { track, seq, mimeType, buffer } aguardando envio
  let flushing = false;

  function backend(path) {
    return `${backendUrl.replace(/\/+$/, '')}${path}`;
  }

  async function loadSettings() {
    try {
      const { settings } = await chrome.storage.local.get({ settings: {} });
      if (settings && settings.backendUrl) backendUrl = settings.backendUrl;
    } catch (err) {
      debug('não consegui ler settings:', err);
    }
  }

  function getSessionId() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
          if (chrome.runtime.lastError || !response || !response.ok) {
            resolve(null);
            return;
          }
          const s = response.state && response.state.lastSession;
          resolve(s && s.sessionId ? s.sessionId : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function reportStatus() {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'CAPTURE_STATUS',
          capturing: lastStats.capturing,
          captureId,
          bytesSent,
          micActive: lastStats.micActive,
          remoteTracks: lastStats.remoteTracks,
        },
        () => void chrome.runtime.lastError
      );
    } catch (_) {
      /* ignore */
    }
  }

  // --- Banner visível de gravação (transparência) ---------------------------
  let banner = null;
  function showBanner() {
    if (banner) return;
    try {
      banner = document.createElement('div');
      banner.setAttribute('data-chatpro-recording', '1');
      banner.textContent = '● chatPro — esta reunião está sendo gravada para qualidade';
      Object.assign(banner.style, {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        background: '#1d2125',
        color: '#25D066',
        font: '600 13px/1.4 system-ui, sans-serif',
        padding: '8px 16px',
        borderRadius: '999px',
        border: '1px solid #25D066',
        boxShadow: '0 4px 16px rgba(0,0,0,.4)',
        pointerEvents: 'none',
        letterSpacing: '.2px',
      });
      (document.body || document.documentElement).appendChild(banner);
    } catch (err) {
      debug('falha ao exibir banner:', err);
    }
  }
  function hideBanner() {
    try {
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    } catch (_) {
      /* ignore */
    }
    banner = null;
  }

  // --- Envio de chunks com fila de retry ------------------------------------
  function queueBytes() {
    return pendingChunks.reduce((sum, c) => sum + (c.buffer.byteLength || 0), 0);
  }

  function enqueueChunk(chunk) {
    pendingChunks.push(chunk);
    // Descarta os mais antigos se a fila estourar (backend fora do ar por muito
    // tempo) — melhor perder o começo do que travar a aba.
    while (
      pendingChunks.length > MAX_QUEUE ||
      queueBytes() > MAX_QUEUE_BYTES
    ) {
      const dropped = pendingChunks.shift();
      debug('fila cheia — descartando chunk', dropped && dropped.seq);
    }
    flushQueue();
  }

  async function flushQueue() {
    if (flushing || !captureId) return;
    flushing = true;
    try {
      while (pendingChunks.length > 0) {
        const chunk = pendingChunks[0];
        const url =
          backend('/api/capture/chunk') +
          `?captureId=${encodeURIComponent(captureId)}` +
          `&seq=${chunk.seq}&track=${chunk.track}`;
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunk.buffer,
          });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          pendingChunks.shift();
          bytesSent += chunk.buffer.byteLength || 0;
        } catch (err) {
          debug('envio de chunk falhou, retenta depois:', err && err.message);
          break; // para o loop; heartbeat/próximo chunk tenta de novo
        }
      }
    } finally {
      flushing = false;
    }
  }

  // --- Heartbeat ------------------------------------------------------------
  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(async () => {
      if (!captureId) return;
      try {
        await fetch(backend('/api/capture/heartbeat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            captureId,
            at: new Date().toISOString(),
            capturing: lastStats.capturing,
            inCall: Boolean(currentMeetingCode()),
            micActive: lastStats.micActive,
            remoteTracks: lastStats.remoteTracks,
            bytesSent,
          }),
        });
      } catch (err) {
        debug('heartbeat falhou:', err && err.message);
      }
      flushQueue(); // aproveita para reenviar pendências
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // --- Handlers dos eventos do tap ------------------------------------------
  async function onCaptureStart(msg) {
    await loadSettings();
    const meetingCode = currentMeetingCode();
    try {
      // Pede a captura ao service worker (dono ÚNICO da sessão). NÃO chamamos
      // /api/capture/start direto: o script da legenda também captura esta mesma
      // reunião e cada um criando a sua fazia a reunião aparecer DUPLICADA
      // (uma sessão só com áudio, outra só com legenda).
      const id = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: 'GET_CAPTURE', meetingCode, mode: msg.mode || 'webrtc-tap' },
            (r) => {
              if (chrome.runtime.lastError || !r || !r.ok) return resolve(null);
              resolve(r.captureId);
            }
          );
        } catch (_) { resolve(null); }
      });
      if (!id) throw new Error('service worker não devolveu captureId');
      captureId = id;
      bytesSent = 0;
      debug('captura (compartilhada) ativa:', captureId);
      showBanner();
      startHeartbeat();
      reportStatus();
      flushQueue();
    } catch (err) {
      debug('não consegui iniciar captura no backend:', err && err.message);
      // Sem captureId os chunks se acumulam na fila e sobem quando o backend voltar.
    }
  }

  function onChunk(msg) {
    if (!msg.buffer) return;
    enqueueChunk({
      track: msg.track === 'mic' ? 'mic' : 'remote',
      seq: msg.seq,
      mimeType: msg.mimeType || '',
      buffer: msg.buffer,
    });
  }

  async function onCaptureStop(msg) {
    lastStats.capturing = false;
    await flushQueue(); // garante que os últimos pedaços subiram
    // NÃO encerramos a sessão aqui: ela é COMPARTILHADA com a legenda, que
    // costuma continuar depois que o áudio para. Quem encerra é o service
    // worker (ao sair da chamada ou fechar a aba) — assim nada é cortado.
    if (msg && msg.reason === 'tab-closed') {
      try {
        chrome.runtime.sendMessage(
          { type: 'END_CAPTURE', reason: 'tab-closed' },
          () => void chrome.runtime.lastError
        );
      } catch (_) {}
    }
    captureId = null;
    stopHeartbeat();
    hideBanner();
    reportStatus();
  }

  function onStats(msg) {
    lastStats = {
      capturing: Boolean(msg.capturing),
      micActive: Boolean(msg.micActive),
      remoteTracks: Number(msg.remoteTracks) || 0,
    };
    if (lastStats.capturing) showBanner();
    reportStatus();
  }

  // --- Escuta as mensagens do mundo MAIN ------------------------------------
  window.addEventListener('message', (event) => {
    // Só aceita mensagens da própria página (o tap roda no mesmo window).
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== TAG || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'CAPTURE_START':
        onCaptureStart(msg);
        break;
      case 'CHUNK':
        onChunk(msg);
        break;
      case 'CAPTURE_STOP':
        onCaptureStop(msg);
        break;
      case 'STATS':
        onStats(msg);
        break;
      default:
        break;
    }
  });

  window.addEventListener('pagehide', () => {
    // Encerra o que estiver aberto ao fechar/atualizar a aba.
    if (captureId) onCaptureStop({ reason: 'tab-closed' });
  });

  debug('ponte de captura pronta');
})();
