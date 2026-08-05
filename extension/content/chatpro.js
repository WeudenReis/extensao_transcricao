/**
 * Content script do chatPro (app.chatpro.com.br).
 *
 * Responsabilidade única: descobrir qual é a conversa (session id) ativa e
 * avisar o service worker quando ela mudar. Nunca interfere na página.
 *
 * Tudo dentro de uma IIFE para não vazar nenhum global para a página.
 */
(() => {
  'use strict';

  const LOG_PREFIX = '[chatPro ext]';

  // Fonte primária: uuid na URL, ex: https://app.chatpro.com.br/chat/<uuid>
  const SESSION_REGEX =
    /\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // Último session id efetivamente enviado ao service worker.
  // Evita spam de mensagens quando o observer dispara sem mudança real.
  let lastSentSessionId = null;

  /** Log de debug que nunca quebra a página. */
  function debug(...args) {
    try {
      console.debug(LOG_PREFIX, ...args);
    } catch (_) {
      /* silencioso de propósito */
    }
  }

  /** Extrai o uuid de uma string qualquer (URL ou href), ou null. */
  function extractSessionId(str) {
    if (!str || typeof str !== 'string') return null;
    const match = SESSION_REGEX.exec(str);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Fallback via DOM: em algumas telas o chatPro mantém a URL "genérica" e
   * marca a conversa ativa na sidebar com .card--active. Procuramos o link
   * dessa conversa e extraímos o uuid do href com a mesma regex.
   */
  function extractSessionIdFromDom() {
    try {
      // Seletor "oficial" descrito no layout atual da sidebar.
      const selectors = [
        'section.session-cards .card--active a[href]',
        // Variações resilientes: o card ativo pode estar fora da section,
        // ser ele mesmo um <a>, ou ter o link em qualquer descendente.
        '.card--active a[href]',
        'a.card--active[href]',
        '[class*="card--active"] a[href]',
        'a[class*="card--active"][href]',
      ];

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const sessionId = extractSessionId(el.getAttribute('href') || el.href);
        if (sessionId) return sessionId;
      }

      // Último recurso: card ativo com href no próprio elemento (não-<a>).
      const activeCard = document.querySelector('.card--active[href]');
      if (activeCard) {
        const sessionId = extractSessionId(activeCard.getAttribute('href'));
        if (sessionId) return sessionId;
      }
    } catch (err) {
      debug('falha no fallback de DOM:', err);
    }
    return null;
  }

  /** Resolve o session id atual: URL primeiro, DOM como fallback. */
  function resolveCurrentSessionId() {
    return extractSessionId(window.location.href) || extractSessionIdFromDom();
  }

  /** Lê o estado atual e, se o session id for NOVO, envia ao service worker. */
  function checkAndReport() {
    try {
      const sessionId = resolveCurrentSessionId();
      if (!sessionId || sessionId === lastSentSessionId) return;

      lastSentSessionId = sessionId;
      debug('sessão detectada:', sessionId);

      chrome.runtime.sendMessage(
        {
          type: 'CHATPRO_SESSION',
          sessionId,
          url: location.href,
          capturedAt: new Date().toISOString(),
        },
        () => {
          // chrome.runtime.lastError precisa ser lido para não poluir o
          // console quando o service worker estiver dormindo/recarregando.
          if (chrome.runtime.lastError) {
            debug('sendMessage falhou:', chrome.runtime.lastError.message);
          }
        }
      );
    } catch (err) {
      // "Extension context invalidated" acontece quando a extensão é
      // recarregada com a aba aberta — nunca pode derrubar a página.
      debug('erro ao reportar sessão:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Debounce: SPAs disparam dezenas de mutações por segundo; agrupamos tudo
  // numa única checagem 300ms depois da última mutação.
  // ---------------------------------------------------------------------------
  let debounceTimer = null;
  function scheduleCheck() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      checkAndReport();
    }, 300);
  }

  // ---------------------------------------------------------------------------
  // MutationObserver: o chatPro é uma SPA — troca de conversa sem reload.
  // Observamos a sidebar (ou o body, se ela ainda não existir) para perceber
  // a troca do .card--active e mudanças de conteúdo.
  // ---------------------------------------------------------------------------
  function startObserver() {
    try {
      const target =
        document.querySelector('section.session-cards') || document.body;
      if (!target) return;

      const observer = new MutationObserver(scheduleCheck);
      observer.observe(target, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class'], // só nos importa o card ativo mudando
      });
      debug(
        'observer ativo em',
        target === document.body ? 'document.body' : 'section.session-cards'
      );
    } catch (err) {
      debug('falha ao iniciar observer:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Navegação SPA: pushState/replaceState não disparam evento nativo nenhum.
  // Monkeypatch leve: embrulhamos os métodos e emitimos um evento custom.
  //
  // Nota: content scripts rodam em "isolated world" — este patch só enxerga
  // chamadas feitas neste mundo. A navegação feita pelo código da própria
  // página é coberta pelo MutationObserver acima (toda troca de conversa
  // mexe no DOM) e pelos eventos popstate/hashchange abaixo. O patch fica
  // como cinto de segurança barato e inofensivo.
  // ---------------------------------------------------------------------------
  function patchHistory() {
    try {
      const EVENT_NAME = 'chatproext:navigate';

      for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function (...args) {
          const result = original.apply(this, args);
          try {
            window.dispatchEvent(new CustomEvent(EVENT_NAME));
          } catch (_) {
            /* nunca quebrar a navegação por causa do evento */
          }
          return result;
        };
      }

      window.addEventListener(EVENT_NAME, scheduleCheck);
      window.addEventListener('popstate', scheduleCheck);
      window.addEventListener('hashchange', scheduleCheck);
    } catch (err) {
      debug('falha ao aplicar patch de history:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat: com a MESMA conversa aberta por horas (SPA, sem reload), o
  // dedupe acima impediria qualquer reenvio e o capturedAt congelaria no
  // service worker — após 4h a sessão pareceria "velha" e o vínculo
  // automático pararia. Reenviamos a sessão atual de tempos em tempos e
  // quando a aba volta a ficar visível, renovando o capturedAt.
  // ---------------------------------------------------------------------------
  const HEARTBEAT_MS = 5 * 60 * 1000;

  function forceReport() {
    lastSentSessionId = null; // derruba o dedupe de propósito
    checkAndReport();
  }

  function startHeartbeat() {
    try {
      setInterval(() => {
        if (document.visibilityState === 'visible') forceReport();
      }, HEARTBEAT_MS);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') forceReport();
      });
    } catch (err) {
      debug('falha ao iniciar heartbeat:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  try {
    patchHistory();
    startObserver();
    startHeartbeat();
    checkAndReport(); // primeira leitura imediata (document_idle já tem DOM)
  } catch (err) {
    debug('falha no bootstrap:', err);
  }
})();
