/**
 * captions.js — transcrição pela LEGENDA do Google Meet (caminho principal).
 *
 * POR QUE ESTE CAMINHO:
 *  - Usa o reconhecimento de voz do próprio Google: muito melhor em pt-BR que o
 *    Whisper local, e já entrega QUEM falou.
 *  - Funciona em conta pessoal @gmail (a API de transcript exige Workspace).
 *  - Não depende de capturar áudio (fim dos problemas de trilha muda/mute).
 *
 * ANTI-MANIPULAÇÃO:
 *  - Liga a legenda sozinho ao entrar na chamada e RELIGA se alguém desligar.
 *  - Esconde o painel de legenda (opacity 0), então não há o que desligar na
 *    tela. Usamos opacity — e não display:none — porque o Meet precisa seguir
 *    renderizando o texto pra podermos lê-lo.
 *  - Ligar legenda é configuração LOCAL: não aparece nem avisa o outro lado.
 *
 * TRANSPARÊNCIA: o banner de "reunião sendo gravada" (meet.js) continua visível.
 */
(() => {
  'use strict';

  const LOG = '[chatPro cc]';
  const CHECK_MS = 3000; // religa a legenda se cair
  const FINALIZE_MS = 2500; // silêncio que fecha uma fala
  const HEARTBEAT_MS = 15000;

  function debug(...a) {
    try { console.debug(LOG, ...a); } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------
  let backendUrl = 'http://localhost:3333';
  let captureId = null;
  let seq = 0;
  let iniciando = false;
  let heartbeatTimer = null;
  const pendentes = []; // falas aguardando envio (backend fora do ar)
  const blocos = new Map(); // elemento -> { speaker, text, timer }

  const MEET_CODE = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i;
  function meetingCode() {
    const m = MEET_CODE.exec(location.href);
    return m ? m[1].toLowerCase() : null;
  }
  function backend(p) {
    return backendUrl.replace(/\/+$/, '') + p;
  }

  async function carregarSettings() {
    try {
      const { settings } = await chrome.storage.local.get({ settings: {} });
      if (settings && settings.backendUrl) backendUrl = settings.backendUrl;
    } catch (_) {}
  }

  function pedirSessionId() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, (r) => {
          if (chrome.runtime.lastError || !r || !r.ok) return resolve(null);
          const s = r.state && r.state.lastSession;
          resolve(s && s.sessionId ? s.sessionId : null);
        });
      } catch (_) { resolve(null); }
    });
  }

  // ---------------------------------------------------------------------------
  // Detecção de "estou na chamada"
  // ---------------------------------------------------------------------------
  function naChamada() {
    if (!meetingCode()) return false;
    // Botão de sair da chamada só existe quando você já entrou na sala.
    const sinais = [
      '[aria-label*="Sair da chamada" i]',
      '[aria-label*="Encerrar chamada" i]',
      '[aria-label*="Leave call" i]',
      '[aria-label*="End call" i]',
      '[data-is-muted]',
    ];
    return sinais.some((s) => document.querySelector(s));
  }

  // ---------------------------------------------------------------------------
  // Ligar a legenda (e manter ligada)
  // ---------------------------------------------------------------------------
  function botaoLegenda() {
    const seletores = [
      '[aria-label*="legenda" i]',
      '[aria-label*="Ativar legendas" i]',
      '[aria-label*="Desativar legendas" i]',
      '[aria-label*="caption" i]',
      '[jsname="r8qRAd"]', // histórico do Meet
    ];
    for (const s of seletores) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function legendaLigada() {
    const btn = botaoLegenda();
    if (!btn) return false;
    // aria-pressed é o indicador mais confiável; o rótulo é o fallback.
    const pressed = btn.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    if (pressed === 'false') return false;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('desativar') || label.includes('turn off');
  }

  function ligarLegenda() {
    try {
      if (legendaLigada()) return;
      const btn = botaoLegenda();
      if (btn) {
        btn.click();
        debug('legenda ligada pelo botão');
        return;
      }
      // Sem botão visível: usa o atalho nativo do Meet (tecla "c").
      const ev = { key: 'c', code: 'KeyC', keyCode: 67, which: 67, bubbles: true };
      document.dispatchEvent(new KeyboardEvent('keydown', ev));
      document.dispatchEvent(new KeyboardEvent('keyup', ev));
      debug('legenda ligada pelo atalho "c"');
    } catch (err) {
      debug('falha ao ligar legenda:', err);
    }
  }

  /** Esconde o painel de legenda sem impedir o Meet de gerar o texto. */
  function esconderPainel() {
    if (document.getElementById('chatpro-cc-hide')) return;
    const style = document.createElement('style');
    style.id = 'chatpro-cc-hide';
    // opacity (e não display:none) mantém o DOM sendo atualizado.
    style.textContent = `
      [jsname="dsyhDe"], .a4cQT, .iOzk7, [class*="caption"][aria-live],
      [aria-live="polite"][class*="TBMuR"], .nMcdL {
        opacity: 0 !important;
        pointer-events: none !important;
        z-index: -1 !important;
      }`;
    (document.head || document.documentElement).appendChild(style);
    debug('painel de legenda escondido');
  }

  // ---------------------------------------------------------------------------
  // Leitura das legendas
  // ---------------------------------------------------------------------------
  /** Acha o container de legendas (seletores conhecidos + varredura genérica). */
  function containerLegendas() {
    const conhecidos = ['[jsname="dsyhDe"]', '.a4cQT', '.iOzk7', '.nMcdL'];
    for (const s of conhecidos) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    // Genérico: região aria-live com texto (o Meet muda classes com frequência).
    const vivos = document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]');
    for (const el of vivos) {
      if (el.textContent && el.textContent.trim().length > 0 && el.querySelector('*')) {
        return el;
      }
    }
    return null;
  }

  /**
   * Extrai (falante, texto) de um bloco de legenda.
   * O Meet monta cada fala como: avatar + nome + texto.
   */
  function lerBloco(bloco) {
    try {
      const txt = (bloco.innerText || '').trim();
      if (!txt) return null;
      const linhas = txt.split('\n').map((l) => l.trim()).filter(Boolean);
      if (linhas.length === 0) return null;
      // Heurística: 1ª linha curta e sem pontuação final = nome do falante.
      let speaker = 'Participante';
      let texto = linhas.join(' ');
      if (linhas.length >= 2 && linhas[0].length <= 40 && !/[.?!]$/.test(linhas[0])) {
        speaker = linhas[0];
        texto = linhas.slice(1).join(' ');
      }
      texto = texto.trim();
      return texto ? { speaker, texto } : null;
    } catch (_) {
      return null;
    }
  }

  function agendarFinalizacao(bloco) {
    const st = blocos.get(bloco);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => finalizar(bloco), FINALIZE_MS);
  }

  function finalizar(bloco) {
    const st = blocos.get(bloco);
    if (!st) return;
    blocos.delete(bloco);
    if (!st.texto) return;
    enviarFala(st.speaker, st.texto);
  }

  function processarMutacoes() {
    const cont = containerLegendas();
    if (!cont) return;
    // Cada filho direto costuma ser uma fala; se não houver, trata o próprio.
    const candidatos = cont.children.length ? Array.from(cont.children) : [cont];
    for (const bloco of candidatos) {
      const lido = lerBloco(bloco);
      if (!lido) continue;
      const atual = blocos.get(bloco);
      if (!atual) {
        blocos.set(bloco, { speaker: lido.speaker, texto: lido.texto, timer: null });
      } else {
        // O Meet reescreve a fala enquanto a pessoa fala: guardamos a versão mais longa.
        if (lido.texto.length >= atual.texto.length) atual.texto = lido.texto;
        atual.speaker = lido.speaker || atual.speaker;
      }
      agendarFinalizacao(bloco);
    }
  }

  // ---------------------------------------------------------------------------
  // Envio ao backend
  // ---------------------------------------------------------------------------
  async function garantirCaptura() {
    if (captureId || iniciando) return;
    iniciando = true;
    try {
      await carregarSettings();
      const sessionId = await pedirSessionId();
      const r = await fetch(backend('/api/capture/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingCode: meetingCode(),
          sessionId,
          startedAt: new Date().toISOString(),
          mode: 'captions',
          mimeType: 'text/vtt',
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      captureId = (await r.json()).captureId;
      debug('captura de legenda iniciada:', captureId);
      iniciarHeartbeat();
      escoar();
    } catch (err) {
      debug('não consegui abrir a captura (tenta de novo):', err && err.message);
    } finally {
      iniciando = false;
    }
  }

  function enviarFala(speaker, texto) {
    pendentes.push({ speaker, text: texto, at: new Date().toISOString(), seq: seq++ });
    escoar();
  }

  let escoando = false;
  async function escoar() {
    // Sem captureId os itens FICAM na fila (nunca enviamos captureId=null).
    if (escoando || !captureId || pendentes.length === 0) return;
    escoando = true;
    try {
      while (pendentes.length) {
        const item = pendentes[0];
        try {
          const r = await fetch(backend('/api/capture/caption'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ captureId, ...item }),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          pendentes.shift();
        } catch (err) {
          debug('envio de fala falhou, retenta depois:', err && err.message);
          break;
        }
      }
    } finally {
      escoando = false;
    }
  }

  function iniciarHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!captureId) return;
      fetch(backend('/api/capture/heartbeat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captureId,
          at: new Date().toISOString(),
          capturing: true,
          inCall: naChamada(),
          micActive: true,
          remoteTracks: 1,
          bytesSent: 0,
        }),
      }).catch(() => {});
      escoar();
    }, HEARTBEAT_MS);
  }

  async function encerrar(motivo) {
    if (!captureId) return;
    for (const bloco of Array.from(blocos.keys())) finalizar(bloco);
    await escoar();
    try {
      await fetch(backend('/api/capture/stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captureId,
          endedAt: new Date().toISOString(),
          reason: motivo || 'call-ended',
          totalChunks: { mic: 0, remote: 0 },
        }),
      });
      debug('captura de legenda encerrada');
    } catch (_) {}
    captureId = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Laço principal
  // ---------------------------------------------------------------------------
  let observer = null;
  let emChamadaAntes = false;

  function tick() {
    try {
      const agora = naChamada();
      if (agora && !emChamadaAntes) {
        debug('entrou na chamada — ligando legenda');
        esconderPainel();
        ligarLegenda();
        garantirCaptura();
      } else if (!agora && emChamadaAntes) {
        debug('saiu da chamada');
        encerrar('call-ended');
      }
      emChamadaAntes = agora;

      if (agora) {
        esconderPainel();
        ligarLegenda(); // religa se alguém desligou (anti-manipulação)
        if (!captureId) garantirCaptura();
      }
    } catch (err) {
      debug('erro no tick:', err);
    }
  }

  try {
    observer = new MutationObserver(() => {
      if (emChamadaAntes) processarMutacoes();
    });
    observer.observe(document.body || document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    setInterval(tick, CHECK_MS);
    window.addEventListener('pagehide', () => encerrar('tab-closed'));
    tick();
    debug('legenda: monitor ativo (v5)');
  } catch (err) {
    debug('falha no bootstrap:', err);
  }
})();
