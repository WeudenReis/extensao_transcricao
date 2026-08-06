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
  const CHECK_MS = 400; // vigia a legenda ~2,5x por segundo (religa quase na hora)
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
  /**
   * Botão de legenda da BARRA DE CONTROLES — estritamente.
   *
   * CUIDADO (bug real): um seletor solto como [aria-label*="legenda"] casa com o
   * item "Legendas" do menu de Configurações e ABRE a janela de configurações.
   * Como o laço re-clicava a cada 3s, o usuário não conseguia fechar a janela.
   * Por isso aqui exigimos: ser <button>, ter rótulo de LIGAR/DESLIGAR legendas,
   * e NÃO estar dentro de um diálogo/menu.
   */
  function botaoLegenda() {
    const rotuloOk = /^(ativar|desativar)\s+legendas|^(turn on|turn off)\s+captions|legendas?\s*\(c\)/i;
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      const label = btn.getAttribute('aria-label') || '';
      if (!rotuloOk.test(label.trim())) continue;
      if (btn.closest('[role="dialog"], [role="menu"], [role="listbox"]')) continue;
      return btn;
    }
    return null;
  }

  function legendaLigada() {
    // Sinal mais forte: o container de legendas existe na página.
    if (containerLegendas()) return true;
    const btn = botaoLegenda();
    if (!btn) return false;
    const pressed = btn.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    if (pressed === 'false') return false;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('desativar') || label.includes('turn off');
  }

  /** Fecha a janela de Configurações se ela tiver sido aberta por engano. */
  function fecharDialogoAberto() {
    try {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return false;
      const texto = (dlg.innerText || '').toLowerCase();
      if (!texto.includes('legenda') && !texto.includes('configuraç')) return false;
      const fechar = dlg.querySelector(
        'button[aria-label*="Fechar" i], button[aria-label*="Close" i]'
      );
      if (fechar) fechar.click();
      else {
        const ev = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
        document.dispatchEvent(new KeyboardEvent('keydown', ev));
      }
      debug('janela de configurações fechada');
      return true;
    } catch (_) {
      return false;
    }
  }

  // Religa quase instantaneamente: 700ms é só o tempo de o Meet aplicar o
  // atalho antes de tentarmos de novo (evita ficar batendo à toa).
  // O limite alto só existe pra não martelar a interface se o Meet mudar.
  const MAX_TENTATIVAS = 200;
  const ESPERA_TENTATIVA_MS = 700;
  let tentativas = 0;
  let ultimaTentativa = 0;

  function ligarLegenda() {
    try {
      if (legendaLigada()) {
        tentativas = 0;
        return;
      }
      const agora = Date.now();
      if (agora - ultimaTentativa < ESPERA_TENTATIVA_MS) return;
      if (tentativas >= MAX_TENTATIVAS) return; // desiste em silêncio
      ultimaTentativa = agora;
      tentativas++;

      // 1) Atalho nativo "c" — é o caminho SEGURO (não abre janela nenhuma).
      const alvo = document.activeElement;
      const digitando =
        alvo &&
        (alvo.tagName === 'INPUT' ||
          alvo.tagName === 'TEXTAREA' ||
          alvo.isContentEditable);
      if (!digitando) {
        for (const tipo of ['keydown', 'keyup']) {
          document.dispatchEvent(
            new KeyboardEvent(tipo, {
              key: 'c', code: 'KeyC', keyCode: 67, which: 67, bubbles: true,
            })
          );
        }
        debug(`tentativa ${tentativas}: atalho "c"`);
      }

      // 2) Só se o atalho não resolver, o botão estrito da barra.
      setTimeout(() => {
        if (legendaLigada()) return;
        const btn = botaoLegenda();
        if (btn) {
          btn.click();
          debug(`tentativa ${tentativas}: botão da barra`);
          setTimeout(fecharDialogoAberto, 500); // fecha se abriu algo por engano
        }
      }, 400);
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
  /**
   * Texto que é INTERFACE do Meet, não fala de gente.
   *
   * Bug real: a janela "Sua reunião está pronta / Adicionar outras pessoas" foi
   * gravada 18 vezes como se fosse legenda. Aqui barramos os nomes de ícone que
   * vazam como texto (person_add, content_copy…) e as frases fixas da interface.
   */
  const ICONES = /\b(person_add|content_copy|close|more_vert|mic_off|mic|videocam|call_end|present_to_all|pan_tool|emoji|arrow_back|arrow_forward|settings|info|lock|chat|group|link)\b/i;
  const FRASES_UI = [
    /reuni[ãa]o est[áa] pronta/i,
    /adicionar outras pessoas/i,
    /compartilhe este link/i,
    /copiar link/i,
    /participando como/i,
    /meet\.google\.com\//i,
    /precisar[ãa]o receber sua permiss[ãa]o/i,
    /^fechar$/i,
    /a c[âa]mera n[ãa]o foi encontrada/i,
    /sua c[âa]mera est[áa]/i,
  ];

  function ehLixoDeInterface(speaker, texto) {
    const alvo = `${speaker} ${texto}`;
    if (ICONES.test(alvo)) return true;
    if (FRASES_UI.some((re) => re.test(alvo))) return true;
    // Legenda real raramente é gigante num bloco só.
    if (texto.length > 1200) return true;
    return false;
  }

  /** Acha o container de legendas (seletores conhecidos + varredura cuidadosa). */
  function containerLegendas() {
    const conhecidos = ['[jsname="dsyhDe"]', '.a4cQT', '.iOzk7', '.nMcdL'];
    for (const s of conhecidos) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    // Genérico — mas NUNCA dentro de diálogo/menu (era de onde vinha o lixo).
    const vivos = document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]');
    for (const el of vivos) {
      if (el.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) continue;
      const txt = (el.innerText || '').trim();
      if (!txt) continue;
      if (ehLixoDeInterface('', txt)) continue;
      if (!el.querySelector('*')) continue;
      // Legenda fica na metade de baixo da tela.
      try {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top < window.innerHeight * 0.4) continue;
      } catch (_) {}
      return el;
    }
    return null;
  }

  /**
   * Extrai (falante, texto) de UM bloco de fala do painel.
   *
   * O Meet monta cada fala como: nome do participante + o que ele disse. A 1ª
   * linha curta e sem pontuação final é o nome; o resto é a fala.
   */
  function lerBloco(el) {
    const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!txt) return null;
    const linhas = (el.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    let speaker = 'Participante';
    let texto = linhas.join(' ');
    if (
      linhas.length >= 2 &&
      linhas[0].length <= 40 &&
      !/[.?!…]$/.test(linhas[0]) &&
      linhas[0].split(/\s+/).length <= 5
    ) {
      speaker = linhas[0];
      texto = linhas.slice(1).join(' ');
    }
    texto = texto.trim();
    if (!texto || ehLixoDeInterface(speaker, texto)) return null;
    return { speaker, texto };
  }

  /** Os "blocos" de fala dentro do painel (cada fala é um filho). */
  function blocosDeFala(cont) {
    const filhos = Array.from(cont.children).filter((c) => (c.innerText || '').trim());
    return filhos.length ? filhos : [cont];
  }

  /**
   * RASTREAMENTO POR ELEMENTO (a correção do texto repetido).
   *
   * Em vez de ler o painel inteiro (que acumula e se reescreve, gerando aquela
   * repetição gigante), acompanhamos CADA fala pelo seu próprio elemento no DOM.
   * O texto de um elemento só CRESCE enquanto a pessoa fala; quando ela para (o
   * texto fica estável por FINALIZE_MS) ou o Meet remove o elemento, fechamos a
   * fala e enviamos UMA vez, com o texto final. Sem repetição, sem histórico.
   */
  const rastreados = new Map(); // Element -> { speaker, texto, timer }

  function finalizarBloco(el) {
    const st = rastreados.get(el);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    rastreados.delete(el);
    if (st.texto) enviarFala(st.speaker, st.texto);
  }

  function agendarFinalizacao(el) {
    const st = rastreados.get(el);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => finalizarBloco(el), FINALIZE_MS);
  }

  function processarMutacoes() {
    const cont = containerLegendas();
    if (!cont) return;
    for (const el of blocosDeFala(cont)) {
      const lido = lerBloco(el);
      if (!lido) continue;
      const st = rastreados.get(el);
      if (!st) {
        rastreados.set(el, { speaker: lido.speaker, texto: lido.texto, timer: null });
        agendarFinalizacao(el);
      } else {
        // Continuação da mesma fala? (o texto novo estende o anterior)
        if (lido.texto.length >= st.texto.length && lido.texto.startsWith(st.texto.slice(0, 20))) {
          st.texto = lido.texto;
          st.speaker = lido.speaker || st.speaker;
        } else {
          // O Meet reciclou o elemento pra uma fala NOVA: fecha a anterior e recomeça.
          finalizarBloco(el);
          rastreados.set(el, { speaker: lido.speaker, texto: lido.texto, timer: null });
        }
        agendarFinalizacao(el);
      }
    }
  }

  /** Quando o Meet REMOVE um bloco do DOM, fechamos a fala (não perde nada). */
  function aoRemoverNos(mutacoes) {
    for (const m of mutacoes) {
      for (const no of m.removedNodes) {
        if (rastreados.has(no)) finalizarBloco(no);
        // Bloco pode ser removido junto com um ancestral.
        for (const el of rastreados.keys()) {
          if (no.contains && no.contains(el)) finalizarBloco(el);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Envio ao backend
  // ---------------------------------------------------------------------------
  /**
   * Pede a captura ao service worker (dono ÚNICO da sessão). Assim legenda e
   * áudio compartilham o mesmo captureId — antes cada um criava a sua e a
   * reunião aparecia duplicada no painel.
   */
  async function garantirCaptura() {
    if (captureId || iniciando) return;
    iniciando = true;
    try {
      await carregarSettings();
      const id = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: 'GET_CAPTURE', meetingCode: meetingCode(), mode: 'captions' },
            (r) => {
              if (chrome.runtime.lastError || !r || !r.ok) return resolve(null);
              resolve(r.captureId);
            }
          );
        } catch (_) { resolve(null); }
      });
      if (!id) throw new Error('service worker não devolveu captureId');
      captureId = id;
      debug('captura (compartilhada) ativa:', captureId);
      iniciarHeartbeat();
      escoar();
    } catch (err) {
      debug('não consegui obter a captura (tenta de novo):', err && err.message);
    } finally {
      iniciando = false;
    }
  }

  const jaEnviadas = new Set(); // evita a mesma fala repetida (o Meet reescreve)

  function enviarFala(speaker, texto) {
    if (ehLixoDeInterface(speaker, texto)) return;
    const chave = `${speaker}::${texto}`;
    if (jaEnviadas.has(chave)) return;
    jaEnviadas.add(chave);
    if (jaEnviadas.size > 500) jaEnviadas.clear(); // reunião longa: não vaza memória
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
    // Fecha todas as falas que ainda estavam em andamento antes de encerrar.
    for (const el of Array.from(rastreados.keys())) finalizarBloco(el);
    await escoar();
    // Quem encerra é o service worker (dono único da sessão).
    try {
      chrome.runtime.sendMessage(
        { type: 'END_CAPTURE', reason: motivo || 'call-ended' },
        () => void chrome.runtime.lastError
      );
      debug('captura encerrada (via service worker)');
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
    observer = new MutationObserver((mutacoes) => {
      if (!emChamadaAntes) return;
      processarMutacoes();
      aoRemoverNos(mutacoes); // fecha falas cujo bloco o Meet removeu do DOM
    });
    observer.observe(document.body || document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    setInterval(tick, CHECK_MS);
    window.addEventListener('pagehide', () => encerrar('tab-closed'));
    tick();
    debug('legenda: monitor ativo (v6 — rastreio por fala, sem repeticao)');
  } catch (err) {
    debug('falha no bootstrap:', err);
  }
})();
