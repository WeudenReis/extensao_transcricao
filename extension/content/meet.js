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
