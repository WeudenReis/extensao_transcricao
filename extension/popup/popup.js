/**
 * Popup da chatPro Meet Transcripts.
 *
 * Fala com o service worker via GET_STATE / MANUAL_LINK e assina
 * chrome.storage.onChanged para atualizar ao vivo enquanto aberto.
 * Nunca usa innerHTML com dado dinâmico — só textContent (CSP-safe).
 */
(() => {
  'use strict';

  // ---------- Referências de DOM ----------
  const el = {
    sessionEmpty: document.getElementById('session-empty'),
    sessionRow: document.getElementById('session-row'),
    sessionId: document.getElementById('session-id'),
    btnCopy: document.getElementById('btn-copy'),

    meetEmpty: document.getElementById('meet-empty'),
    meetRow: document.getElementById('meet-row'),
    meetCode: document.getElementById('meet-code'),
    meetStatus: document.getElementById('meet-status'),

    linkEmpty: document.getElementById('link-empty'),
    linkRow: document.getElementById('link-row'),
    linkSession: document.getElementById('link-session'),
    linkMeet: document.getElementById('link-meet'),
    linkStatus: document.getElementById('link-status'),
    linkWhen: document.getElementById('link-when'),

    btnLink: document.getElementById('btn-link'),
    feedback: document.getElementById('feedback'),

    btnSettings: document.getElementById('btn-settings'),
    settingsPanel: document.getElementById('settings-panel'),
    backendUrl: document.getElementById('backend-url'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
  };

  let fullSessionId = null; // guarda o uuid completo para o botão copiar
  let feedbackTimer = null;

  // ---------- Utilitários ----------
  function truncateUuid(uuid) {
    if (!uuid) return '';
    // Mostra começo e fim: "3f2a91b7…c4d2"
    return uuid.length > 18 ? `${uuid.slice(0, 8)}…${uuid.slice(-4)}` : uuid;
  }

  function formatWhen(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function showFeedback(text, isError) {
    el.feedback.textContent = text;
    el.feedback.classList.remove('hidden');
    el.feedback.classList.toggle('feedback--erro', Boolean(isError));
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      el.feedback.classList.add('hidden');
    }, 3000);
  }

  // ---------- Renderização ----------
  function render(state) {
    const { lastSession, lastMeet, links, settings, sessionActive } = state;

    // Mostra a sessão sempre que existir uma capturada — mesmo "antiga"
    // (>4h): o vínculo MANUAL continua permitido; só o automático expira.
    const hasSession = Boolean(lastSession && lastSession.sessionId);
    fullSessionId = hasSession ? lastSession.sessionId : null;
    el.sessionEmpty.classList.toggle('hidden', hasSession);
    el.sessionRow.classList.toggle('hidden', !hasSession);
    if (hasSession) {
      el.sessionId.textContent = truncateUuid(lastSession.sessionId);
      const capturada = formatWhen(lastSession.capturedAt);
      el.sessionId.title = sessionActive
        ? lastSession.sessionId
        : `${lastSession.sessionId}\nCapturada em ${capturada} — abra a conversa de novo para renovar.`;
    }

    // Meet
    const hasMeet = Boolean(lastMeet && lastMeet.meetingCode);
    el.meetEmpty.classList.toggle('hidden', hasMeet);
    el.meetRow.classList.toggle('hidden', !hasMeet);
    if (hasMeet) {
      el.meetCode.textContent = lastMeet.meetingCode;
      el.meetStatus.textContent = lastMeet.inCall ? 'Na chamada' : 'Fora';
      el.meetStatus.className = `pill ${lastMeet.inCall ? 'pill--on' : 'pill--off'}`;
    }

    // Último vínculo
    const lastLink = Array.isArray(links) && links.length > 0 ? links[0] : null;
    el.linkEmpty.classList.toggle('hidden', Boolean(lastLink));
    el.linkRow.classList.toggle('hidden', !lastLink);
    if (lastLink) {
      el.linkSession.textContent = truncateUuid(lastLink.sessionId);
      el.linkSession.title = lastLink.sessionId;
      el.linkMeet.textContent = lastLink.meetingCode;
      el.linkStatus.textContent = lastLink.sentToBackend ? 'Enviado ✓' : 'Pendente';
      el.linkStatus.className = `pill ${lastLink.sentToBackend ? 'pill--on' : 'pill--off'}`;
      el.linkWhen.textContent = formatWhen(lastLink.linkedAt);
    }

    // Botão "Vincular agora": precisa de sessão E meet detectados
    el.btnLink.disabled = !(hasSession && hasMeet);

    // Configurações
    if (settings && document.activeElement !== el.backendUrl) {
      el.backendUrl.value = settings.backendUrl || '';
    }
  }

  function refresh() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      if (chrome.runtime.lastError) {
        console.debug('[chatPro ext]', chrome.runtime.lastError.message);
        return;
      }
      if (response && response.ok && response.state) {
        render(response.state);
      }
    });
  }

  // ---------- Ações ----------
  el.btnCopy.addEventListener('click', async () => {
    if (!fullSessionId) return;
    try {
      await navigator.clipboard.writeText(fullSessionId);
      showFeedback('Session id copiado!');
    } catch (_) {
      showFeedback('Não foi possível copiar.', true);
    }
  });

  el.btnLink.addEventListener('click', () => {
    el.btnLink.disabled = true;
    chrome.runtime.sendMessage({ type: 'MANUAL_LINK' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        showFeedback('Falha ao vincular. Tente de novo.', true);
      } else if (!response.ok) {
        showFeedback(response.error || 'Falha ao vincular.', true);
      } else if (response.duplicated) {
        showFeedback('Esse vínculo já existe.');
      } else {
        showFeedback('Vínculo criado!');
      }
      refresh(); // reabilita o botão conforme o estado real
    });
  });

  el.btnSettings.addEventListener('click', () => {
    el.settingsPanel.classList.toggle('hidden');
    if (!el.settingsPanel.classList.contains('hidden')) {
      el.backendUrl.focus();
    }
  });

  el.btnSaveSettings.addEventListener('click', async () => {
    const raw = el.backendUrl.value.trim().replace(/\/+$/, '');
    if (!raw || !/^https?:\/\//i.test(raw)) {
      showFeedback('Use um endereço http(s) válido.', true);
      return;
    }
    try {
      // Lê settings atuais para não perder outras chaves (ex.: autoLink).
      const { settings } = await chrome.storage.local.get({ settings: {} });
      await chrome.storage.local.set({
        settings: Object.assign({}, settings, { backendUrl: raw }),
      });
      showFeedback('Backend salvo!');
    } catch (_) {
      showFeedback('Não foi possível salvar.', true);
    }
  });

  // ---------- Atualização ao vivo ----------
  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName === 'local') refresh();
  });

  refresh();
})();
