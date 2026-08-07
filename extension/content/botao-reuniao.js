/**
 * Botão "reunião" na barra do chatPro.
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
  const ROTULO = 'reunião';
  /** Texto dos botões vizinhos — usados como âncora e como molde. */
  const VIZINHOS = ['transferir', 'etiquetas', 'agendar', 'finalizar'];
  const INTERVALO_MS = 1500;

  let ultimaSessao = null;
  let avisouSemBarra = false;

  // ─── Utilidades ────────────────────────────────────────────────────────────

  const log = (...a) => console.log('%c[chatPro reunião]', 'color:#25D066;font-weight:700', ...a);

  // Anúncio no carregamento: se esta linha não aparece no console, o Chrome
  // está com OUTRA cópia da extensão carregada — foi o que já aconteceu aqui.
  log(`v${chrome.runtime.getManifest().version} carregada`);

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

  /** Tamanho usado quando não dá pra medir o ícone vizinho. */
  const TAMANHO_PADRAO = 20;

  function svgCamera(tamanho) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${tamanho}" height="${tamanho}" ` +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/></svg>'
    );
  }

  /**
   * Mede o ícone vizinho pra câmera sair do mesmo tamanho. Chutar um valor fixo
   * deixava a câmera menor que os outros ícones da barra.
   */
  function medirIcone(icone) {
    const r = icone.getBoundingClientRect();
    if (r.width >= 10 && r.width <= 40) return Math.round(r.width);
    const attr = Number.parseFloat(icone.getAttribute('width') || '');
    if (Number.isFinite(attr) && attr >= 10 && attr <= 40) return Math.round(attr);
    const css = Number.parseFloat(getComputedStyle(icone).width);
    if (Number.isFinite(css) && css >= 10 && css <= 40) return Math.round(css);
    return TAMANHO_PADRAO;
  }

  /** Troca o conteúdo do clone: ícone do chatPro sai, câmera entra. */
  function ajustarClone(clone, moldeOriginal) {
    clone.id = ID;
    clone.setAttribute('data-cpm', '1');
    clone.setAttribute('title', 'Cria o link, envia pro cliente e grava a reunião');

    // Substitui o ícone mantendo lugar E tamanho. Mede no ORIGINAL, que está
    // na tela: o clone ainda não foi inserido, então não tem dimensão.
    const icone = clone.querySelector('svg, img, i');
    const iconeOriginal = moldeOriginal ? moldeOriginal.querySelector('svg, img, i') : null;
    if (icone) {
      const tamanho = medirIcone(iconeOriginal || icone);
      const molde = document.createElement('span');
      molde.innerHTML = svgCamera(tamanho);
      const novo = molde.firstElementChild;
      // Herda as classes do ícone original pra não desalinhar com o rótulo.
      if (icone.getAttribute('class')) novo.setAttribute('class', icone.getAttribute('class'));
      // Reforça no style: se a classe do chatPro dimensiona por CSS, o atributo
      // width do SVG sozinho seria ignorado.
      novo.style.width = `${tamanho}px`;
      novo.style.height = `${tamanho}px`;
      icone.replaceWith(novo);
      log(`ícone ajustado para ${tamanho}px (medido no vizinho)`);
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
      span.innerHTML = svgCamera(
        iconeOriginal ? medirIcone(iconeOriginal) : TAMANHO_PADRAO
      );
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
    const tam = referencia ? medirIcone(referencia) : TAMANHO_PADRAO;
    b.innerHTML = `${svgCamera(tam)}<span style="margin-left:6px">${ROTULO}</span>`;
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
      log('erro ao falar com o service worker:', err);
      const detalhe = String(err?.message || err || '');

      // Causa nº 1 na prática, e a mensagem genérica escondia ela: quando a
      // extensão é recarregada, as abas que já estavam abertas continuam com o
      // content script ANTIGO, cujo chrome.runtime não existe mais. Não é
      // problema de servidor — é só a aba estar velha.
      if (/context invalidated|Extension context/i.test(detalhe)) {
        avisar('A extensão foi atualizada. Recarregue esta página (F5) e clique de novo.', 'erro');
      } else if (/Receiving end does not exist|Could not establish connection/i.test(detalhe)) {
        avisar(
          'A extensão não respondeu. Abra chrome://extensions e recarregue "chatPro Reuniões".',
          'erro'
        );
      } else {
        avisar(`Não deu pra falar com o servidor: ${detalhe || 'erro desconhecido'}`, 'erro');
      }
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
    if (vizinhos.size === 0) {
      // Avisa UMA vez: se o chatPro mudar os rótulos da barra, é aqui que
      // some — e sem log isso viraria "o botão não aparece" sem pista nenhuma.
      if (!avisouSemBarra) {
        avisouSemBarra = true;
        log(
          'não achei a barra do atendimento (procurei por: ' +
            VIZINHOS.join(', ') +
            '). Abra uma conversa; se já estiver aberta, os rótulos podem ter mudado.'
        );
      }
      return;
    }
    avisouSemBarra = false;

    // Molde: prefere "transferir" (o primeiro da barra); senão, qualquer um.
    const rotuloMolde = VIZINHOS.find((v) => vizinhos.has(v));
    const moldeRotulo = vizinhos.get(rotuloMolde);
    const molde = subirAteOBotao(moldeRotulo);
    const barra = molde.parentElement;
    if (!barra) return;

    let botao;
    try {
      botao = ajustarClone(molde.cloneNode(true), molde);
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
    log('botão injetado na barra ✓');
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
