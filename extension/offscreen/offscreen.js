/**
 * Documento offscreen — grava o áudio da reunião.
 *
 * Por que existe: o service worker do MV3 não pode usar getUserMedia nem
 * MediaRecorder. Aqui capturamos DUAS trilhas independentes e confiáveis:
 *   - "remote" = áudio da ABA (tabCapture) = vozes dos participantes (o cliente).
 *   - "mic"    = microfone do atendente (getUserMedia próprio), independente do
 *                mute do Meet.
 * Cada trilha vira pedaços de 5s enviados ao backend. Nada de grampear o WebRTC
 * interno do Meet (aquilo gravava silêncio) — tabCapture é o método que funciona.
 */
(() => {
  'use strict';

  const LOG = '[chatPro offscreen]';
  const HEARTBEAT_MS = 15000;
  const TIMESLICE_MS = 5000;
  const MAX_QUEUE = 60;

  function debug(...a) {
    try { console.debug(LOG, ...a); } catch (_) {}
  }

  let state = null; // { backendUrl, captureId, tabStream, micStream, audioCtx, recorders, seq, bytesSent, heartbeat, meetingCode }

  function backend(path) {
    return state.backendUrl.replace(/\/+$/, '') + path;
  }

  function pickMime() {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const m of cands) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return '';
  }

  // ---- fila de envio de chunks com retry ------------------------------------
  const queue = [];
  let flushing = false;
  function enqueue(item) {
    queue.push(item);
    while (queue.length > MAX_QUEUE) {
      queue.shift();
      debug('fila cheia — descartando chunk antigo');
    }
    flush();
  }
  async function flush() {
    if (flushing || !state || !state.captureId) return;
    flushing = true;
    try {
      while (queue.length) {
        const c = queue[0];
        const url = backend('/api/capture/chunk') +
          `?captureId=${encodeURIComponent(state.captureId)}&seq=${c.seq}&track=${c.track}`;
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: c.buffer,
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          queue.shift();
          state.bytesSent += c.buffer.byteLength || 0;
        } catch (err) {
          debug('chunk falhou, retenta depois:', err && err.message);
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  function startRecorder(track, stream, mime) {
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      e.data.arrayBuffer().then((buf) => {
        enqueue({ track, seq: state.seq[track]++, buffer: buf });
      }).catch((err) => debug('erro lendo blob', err));
    };
    rec.onerror = (e) => debug('erro no recorder', track, e);
    rec.start(TIMESLICE_MS);
    return rec;
  }

  function reportStatus() {
    try {
      chrome.runtime.sendMessage({
        type: 'CAPTURE_STATUS',
        capturing: Boolean(state && state.captureId),
        captureId: state ? state.captureId : null,
        bytesSent: state ? state.bytesSent : 0,
        meetingCode: state ? state.meetingCode : null,
      }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  // ---- início / fim da captura ----------------------------------------------
  async function start(msg) {
    if (state) { debug('captura já em andamento'); return; }
    const mime = pickMime();
    const s = {
      backendUrl: msg.backendUrl || 'http://localhost:3333',
      captureId: null,
      tabStream: null,
      micStream: null,
      audioCtx: null,
      recorders: {},
      seq: { mic: 0, remote: 0 },
      bytesSent: 0,
      heartbeat: null,
      meetingCode: msg.meetingCode || null,
    };
    state = s;

    try {
      // Áudio da ABA (cliente). O streamId veio do service worker (gesto do usuário).
      s.tabStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
      });
      // tabCapture MUTA a aba pro usuário — reconectamos ao alto-falante pra ele
      // continuar ouvindo a reunião normalmente.
      s.audioCtx = new AudioContext();
      s.audioCtx.createMediaStreamSource(s.tabStream).connect(s.audioCtx.destination);
    } catch (err) {
      debug('falha no tabCapture:', err);
      chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: 'tabCapture: ' + (err && err.message) });
      state = null;
      return;
    }

    // Microfone do atendente (independente do mute do Meet). Se falhar, seguimos
    // só com a aba — melhor gravar o cliente do que nada.
    try {
      s.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      debug('microfone indisponível (segue só com a aba):', err && err.message);
      s.micStream = null;
    }

    // Abre a captura no backend.
    try {
      const r = await fetch(backend('/api/capture/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingCode: s.meetingCode,
          sessionId: msg.sessionId || null,
          startedAt: new Date().toISOString(),
          mode: 'tab-capture',
          mimeType: mime,
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      s.captureId = (await r.json()).captureId;
    } catch (err) {
      debug('falha ao abrir captura no backend:', err && err.message);
      chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: 'backend: ' + (err && err.message) });
      cleanup();
      return;
    }

    // Grava as trilhas.
    s.recorders.remote = startRecorder('remote', s.tabStream, mime);
    if (s.micStream) s.recorders.mic = startRecorder('mic', s.micStream, mime);

    // Se a aba fechar/navegar, a track termina → encerramos.
    s.tabStream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => stop('tab-closed')));

    s.heartbeat = setInterval(() => {
      if (!state || !state.captureId) return;
      fetch(backend('/api/capture/heartbeat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captureId: state.captureId,
          at: new Date().toISOString(),
          capturing: true,
          inCall: true,
          micActive: Boolean(state.micStream),
          remoteTracks: 1,
          bytesSent: state.bytesSent,
        }),
      }).catch(() => {});
      flush();
    }, HEARTBEAT_MS);

    debug('captura iniciada:', s.captureId);
    reportStatus();
    flush();
  }

  async function stop(reason) {
    if (!state) return;
    const s = state;
    try {
      for (const rec of Object.values(s.recorders)) {
        if (rec && rec.state !== 'inactive') rec.stop();
      }
    } catch (_) {}
    // Dá um instante pro último ondataavailable disparar e enfileirar.
    await new Promise((r) => setTimeout(r, 400));
    await flush();
    if (s.captureId) {
      try {
        await fetch(backend('/api/capture/stop'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            captureId: s.captureId,
            endedAt: new Date().toISOString(),
            reason: reason || 'call-ended',
            totalChunks: { mic: s.seq.mic, remote: s.seq.remote },
          }),
        });
      } catch (err) { debug('falha ao encerrar captura:', err && err.message); }
    }
    debug('captura encerrada:', reason);
    cleanup();
    reportStatus();
    // Avisa o service worker que pode fechar o offscreen.
    chrome.runtime.sendMessage({ type: 'CAPTURE_ENDED' }, () => void chrome.runtime.lastError);
  }

  function cleanup() {
    if (!state) return;
    const s = state;
    if (s.heartbeat) clearInterval(s.heartbeat);
    try { s.tabStream && s.tabStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { s.micStream && s.micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { s.audioCtx && s.audioCtx.close(); } catch (_) {}
    state = null;
  }

  // ---- mensagens do service worker ------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'offscreen') return;
    if (msg.type === 'START') start(msg);
    else if (msg.type === 'STOP') stop('call-ended');
  });

  debug('offscreen pronto');
})();
