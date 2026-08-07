/**
 * Botão "Entrar na reunião" na barra do chatPro.
 *
 * O DOM do chatPro não tem classe nem data-attribute estável (as classes são
 * geradas). Então a estratégia é outra, e é a que garante o visual nos DOIS
 * temas sem eu chutar cor nenhuma:
 *
 *   acha os botões que já existem ("transferir", "etiquetas", "agendar",
 *   "finalizar") pelo TEXTO → pega um deles como molde → CLONA →
 *   troca o ícone e o rótulo → insere ao lado.
 *
 * Clonando, o botão herda exatamente as classes do chatPro: fonte, espaçamento,
 * hover, tema claro e tema escuro vêm de graça e continuam certos se eles
 * mudarem o CSS.
 *
 * Se o clone falhar (mudança grande no layout deles), há um fallback com estilo
 * próprio que lê a cor do texto vizinho pra se adaptar ao tema.
 */

(() => {
  'use strict';

  const ID = 'cpm-botao-reuniao';
  const ROTULO = 'Entrar na reunião';
  /** Texto dos botões vizinhos — usados como âncora e como molde. */
  const VIZINHOS = ['transferir', 'etiquetas', 'agendar', 'finalizar'];
  const INTERVALO_MS = 1500;

  let ultimaSessao = null;

  // ─── Utilidades ────────────────────────────────────────────────────────────

  const log = (...a) => console.debug('[chatPro reunião]', ...a);

  function sessaoAtual() {
    const m = /\/chat\/([0-9a-f-]{36})/i.exec(location.pathname);
    return m ? m[1] : null;
  }

  function visivel(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /**
   * Acha os botões da barra pelo texto. Só considera elementos pequenos e no
   * topo da tela — evita casar com um texto qualquer da conversa.
   */
  function acharVizinhos() {
    const achados = new Map();
    const candidatos = document.querySelectorAll('button, a, [role="button"], div, span');
    for (const el of candidatos) {
      if (el.id === ID || el.closest(`#${ID}`)) continue;
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!VIZINHOS.includes(txt)) continue;
      // Só o elemento mais interno que contém exatamente o texto.
      if (el.querySelector('button, a, [role="button"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 160 || r.top < 0) continue;
      if (!visivel(el)) continue;
      if (!achados.has(txt)) achados.set(txt, el);
    }
    return achados;
  }

  /** Sobe do rótulo até o elemento que é de fato o botão clicável. */
  function subirAteOBotao(el) {
    let atual = el;
    for (let i = 0; i < 4 && atual.parentElement; i += 1) {
      const tag = atual.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || atual.getAttribute('role') === 'button') return atual;
      atual = atual.parentElement;
    }
    // Sem tag semântica: usa o pai que ainda é pequeno (o próprio "chip").
    return el.parentElement && el.parentElement.getBoundingClientRect().width < 260
      ? el.parentElement
      : el;
  }

  const SVG_CAMERA =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/></svg>';

  /** Troca o conteúdo do clone: ícone do chatPro sai, câmera entra. */
  function ajustarClone(clone) {
    clone.id = ID;
    clone.setAttribute('data-cpm', '1');
    clone.setAttribute('title', 'Cria o link, envia pro cliente e grava a reunião');

    // Substitui o ícone mantendo o lugar dele no layout.
    const icone = clone.querySelector('svg, img, i');
    if (icone) {
      const molde = document.createElement('span');
      molde.innerHTML = SVG_CAMERA;
      const novo = molde.firstElementChild;
      // Herda tamanho e classes do ícone original pra não desalinhar.
      if (icone.getAttribute('class')) novo.setAttribute('class', icone.getAttribute('class'));
      icone.replaceWith(novo);
    }

    // Troca o texto no nó que realmente o contém.
    const alvo = [...clone.querySelectorAll('*')]
      .reverse()
      .find((n) => VIZINHOS.includes((n.textContent || '').trim().toLowerCase()));
    if (alvo) {
      alvo.textContent = ROTULO;
    } else {
      for (const n of clone.childNodes) {
        if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) {
          n.textContent = ROTULO;
          break;
        }
      }
    }

    if (!icone && !clone.querySelector('svg')) {
      const span = document.createElement('span');
      span.innerHTML = SVG_CAMERA;
      span.style.marginRight = '6px';
      span.style.display = 'inline-flex';
      clone.prepend(span);
    }

    // O clone pode trazer handlers do chatPro em atributos inline.
    clone.removeAttribute('onclick');
    return clone;
  }

  /** Fallback: botão próprio, herdando cor do vizinho pra respeitar o tema. */
  function botaoDoZero(referencia) {
    const b = document.createElement('button');
    b.id = ID;
    b.type = 'button';
    b.setAttribute('data-cpm', '1');
    b.innerHTML = `${SVG_CAMERA}<span style="margin-left:6px">${ROTULO}</span>`;
    const cor = referencia ? getComputedStyle(referencia).color : '';
    b.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:2px',
      'background:transparent',
      'border:0',
      'cursor:pointer',
      'padding:8px 10px',
      'border-radius:8px',
      'font:inherit',
      'font-size:14px',
      `color:${cor || 'inherit'}`,
    ].join(';');
    b.addEventListener('mouseenter', () => {
      b.style.background = 'rgba(37,208,102,.12)';
    });
    b.addEventListener('mouseleave', () => {
      b.style.background = 'transparent';
    });
    return b;
  }

  // ─── Estado visual do botão ────────────────────────────────────────────────

  function rotularBotao(botao, texto) {
    const alvo = [...botao.querySelectorAll('*')]
      .reverse()
      .find((n) => n.children.length === 0 && (n.textContent || '').trim());
    if (alvo) alvo.textContent = texto;
  }

  function ocupado(botao, sim, texto) {
    botao.style.opacity = sim ? '0.6' : '';
    botao.style.pointerEvents = sim ? 'none' : '';
    rotularBotao(botao, texto || ROTULO);
  }

  // ─── Aviso na tela (sem depender do toast do chatPro) ──────────────────────

  function avisar(mensagem, tipo) {
    document.querySelectorAll('.cpm-aviso').forEach((e) => e.remove());
    const d = document.createElement('div');
    d.className = 'cpm-aviso';
    d.setAttribute('role', 'status');
    d.textContent = mensagem;
    const fundo = tipo === 'erro' ? '#b91c1c' : '#1BAD53';
    d.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'top:16px',
      'left:50%',
      'transform:translateX(-50%)',
      `background:${fundo}`,
      'color:#fff',
      'padding:10px 16px',
      'border-radius:10px',
      'font:500 14px/1.4 system-ui,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.25)',
      'max-width:min(520px,90vw)',
      'text-align:center',
    ].join(';');
    document.body.appendChild(d);
    setTimeout(() => d.remove(), tipo === 'erro' ? 9000 : 5000);
  }

  // ─── Ação ──────────────────────────────────────────────────────────────────

  function nomeDoContato() {
    // O nome fica no topo, ao lado do avatar. Pega o primeiro texto curto.
    for (const el of document.querySelectorAll('h1,h2,h3,span,div,p')) {
      const r = el.getBoundingClientRect();
      if (r.top > 120 || r.top < 40 || r.left < 380) continue;
      if (el.children.length > 1) continue;
      const t = (el.textContent || '').trim();
      if (t.length >= 2 && t.length <= 60 && !VIZINHOS.includes(t.toLowerCase())) return t;
    }
    return null;
  }

  async function aoClicar(botao) {
    const sessionId = sessaoAtual();
    if (!sessionId) {
      avisar('Abra uma conversa antes de iniciar a reunião.', 'erro');
      return;
    }

    ocupado(botao, true, 'Criando reunião…');
    try {
      const resposta = await chrome.runtime.sendMessage({
        tipo: 'INICIAR_REUNIAO',
        sessionId,
        contato: nomeDoContato(),
      });

      if (!resposta || !resposta.ok) {
        const msg = (resposta && resposta.erro) || 'Não foi possível iniciar a reunião.';
        avisar(msg, 'erro');
        if (resposta && resposta.precisaConectar) {
          avisar('Abra a extensão e conecte sua conta Google.', 'erro');
        }
        return;
      }

      const { meetUrl, gravando, avisoGravacao } = resposta.dados;
      avisar(
        gravando
          ? 'Link enviado pro cliente. A reunião está sendo gravada.'
          : `Link enviado pro cliente. ${avisoGravacao || 'A gravação não iniciou.'}`,
        gravando ? 'ok' : 'erro'
      );
      window.open(meetUrl, '_blank', 'noopener');
    } catch (err) {
      log('erro', err);
      avisar('A extensão não conseguiu falar com o servidor.', 'erro');
    } finally {
      ocupado(botao, false);
    }
  }

  // ─── Injeção ───────────────────────────────────────────────────────────────

  function injetar() {
    const sessao = sessaoAtual();
    const existente = document.getElementById(ID);

    // Sem conversa aberta, o botão não faz sentido.
    if (!sessao) {
      if (existente) existente.remove();
      return;
    }

    if (existente && existente.isConnected) {
      ultimaSessao = sessao;
      return;
    }

    const vizinhos = acharVizinhos();
    if (vizinhos.size === 0) return;

    // Molde: prefere "transferir" (o primeiro da barra); senão, qualquer um.
    const rotuloMolde = VIZINHOS.find((v) => vizinhos.has(v));
    const moldeRotulo = vizinhos.get(rotuloMolde);
    const molde = subirAteOBotao(moldeRotulo);
    const barra = molde.parentElement;
    if (!barra) return;

    let botao;
    try {
      botao = ajustarClone(molde.cloneNode(true));
    } catch (err) {
      log('clone falhou, usando fallback', err);
      botao = botaoDoZero(moldeRotulo);
    }

    botao.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void aoClicar(botao);
    });

    // Entra ANTES do primeiro botão da barra: fica à esquerda de "transferir",
    // longe do "finalizar", que é destrutivo.
    barra.insertBefore(botao, molde);
    ultimaSessao = sessao;
    log('botão injetado');
  }

  // O chatPro é SPA: troca de conversa não recarrega a página, e o React pode
  // recriar a barra a qualquer momento. Observer + varredura periódica cobrem
  // os dois casos sem custo perceptível.
  const observer = new MutationObserver(() => {
    if (sessaoAtual() !== ultimaSessao) {
      const antigo = document.getElementById(ID);
      if (antigo) antigo.remove();
    }
    injetar();
  });

  function iniciar() {
    injetar();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(injetar, INTERVALO_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
