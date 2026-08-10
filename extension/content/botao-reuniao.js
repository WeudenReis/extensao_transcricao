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
 *
 * Dois caminhos no mesmo botão:
 *   clique         → abre a escolha: "Agora" ou "Agendar"
 *   Shift + clique → pula direto pra "Agora" (atalho pra quem repete muito)
 */

(() => {
  'use strict';

  const ID = 'cpm-botao-reuniao';
  const ID_AGENDADOR = 'cpm-agendador';
  const ROTULO = 'reunião';
  const VERDE = '#25D066';
  const VERDE_HOVER = '#1BAD53';
  /** Mesmo teto do servidor — o input já nem deixa escolher além disso. */
  const MAX_DIAS = 90;
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
    clone.setAttribute(
      'title',
      'Reunião com o cliente: agora ou agendada.\nCria o link, envia e grava a chamada.'
    );

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
    b.setAttribute(
      'title',
      'Reunião com o cliente: agora ou agendada.\nCria o link, envia e grava a chamada.'
    );
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

  // ─── Marcar pra depois ─────────────────────────────────────────────────────

  /**
   * O chatPro tem tema claro e escuro e não expõe nenhuma variável de CSS
   * própria. Ler a cor de fundo que está VALENDO e olhar o brilho é o jeito de
   * acertar nos dois sem chutar.
   */
  function temaEscuro() {
    for (const el of [document.body, document.documentElement]) {
      const cor = getComputedStyle(el).backgroundColor || '';
      const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/.exec(cor);
      if (!m) continue;
      if (m[4] !== undefined && Number.parseFloat(m[4]) === 0) continue; // transparente
      const brilho = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
      return brilho < 128;
    }
    return false;
  }

  /** `YYYY-MM-DDTHH:MM` no horário LOCAL, que é o que o input nativo entende. */
  function paraInput(data) {
    const p = (n) => String(n).padStart(2, '0');
    return (
      `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}` +
      `T${p(data.getHours())}:${p(data.getMinutes())}`
    );
  }

  /** Sugestão: daqui a uma hora, arredondado pros 15 min seguintes. */
  function horarioSugerido() {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15);
    return d;
  }

  function fecharAgendador() {
    const aberto = document.getElementById(ID_AGENDADOR);
    if (!aberto) return;
    // Avisa antes de remover: quem prendeu listener no documento (Esc, clique
    // fora) precisa soltar. Sem isso eles se acumulam a cada abertura.
    aberto.dispatchEvent(new CustomEvent('cpm-fechou'));
    aberto.remove();
  }

  /**
   * Cartão com o `<input type="datetime-local">` nativo. Nativo de propósito:
   * o seletor de data do próprio navegador já é acessível, já fala o idioma do
   * usuário e não pesa nada — um calendário próprio aqui seria manutenção sem
   * ganho, dentro de uma página que não é nossa.
   */
  /**
   * A tela que o clique abre: duas escolhas claras.
   *
   * "Agora" faz o que o botão fazia antes — cria o link, manda pro cliente e
   * põe o bot na sala. "Agendar" abre o cartão de data e hora.
   */
  function abrirEscolha(botao) {
    fecharAgendador();
    const escuro = temaEscuro();
    const fundo = escuro ? '#2c333a' : '#ffffff';
    const cortexto = escuro ? '#E6E5E8' : '#1d2125';
    const suave = escuro ? '#D1D1D5' : '#5b636b';
    const borda = escuro ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)';

    const caixa = document.createElement('div');
    caixa.id = ID_AGENDADOR;
    caixa.setAttribute('role', 'dialog');
    caixa.setAttribute('aria-label', 'Reunião com o cliente');
    const r = botao.getBoundingClientRect();
    caixa.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      `top:${Math.round(r.bottom + 8)}px`,
      `left:${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 296)))}px`,
      'width:280px',
      `background:${fundo}`,
      `color:${cortexto}`,
      `border:1px solid ${borda}`,
      'border-radius:12px',
      'padding:14px',
      'box-shadow:0 10px 30px rgba(0,0,0,.28)',
      'font:400 14px/1.45 system-ui,sans-serif',
      `color-scheme:${escuro ? 'dark' : 'light'}`,
    ].join(';');

    const titulo = document.createElement('div');
    titulo.textContent = 'Reunião com o cliente';
    titulo.style.cssText = 'font-weight:700;margin-bottom:10px';
    caixa.appendChild(titulo);

    const opcao = (rotulo, descricao, principal, aoEscolher) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText = [
        'display:block',
        'width:100%',
        'text-align:left',
        'padding:10px 12px',
        'margin-bottom:8px',
        'border-radius:9px',
        'cursor:pointer',
        'font:inherit',
        principal
          ? `background:${VERDE};color:#08240f;border:0;font-weight:700`
          : `background:transparent;color:${cortexto};border:1px solid ${borda}`,
      ].join(';');
      const t = document.createElement('div');
      t.textContent = rotulo;
      const d = document.createElement('div');
      d.textContent = descricao;
      d.style.cssText = `font-size:12px;opacity:.8;margin-top:2px;font-weight:400${
        principal ? '' : `;color:${suave}`
      }`;
      b.append(t, d);
      if (principal) {
        b.addEventListener('mouseenter', () => {
          b.style.background = VERDE_HOVER;
        });
        b.addEventListener('mouseleave', () => {
          b.style.background = VERDE;
        });
      }
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        aoEscolher();
      });
      return b;
    };

    caixa.appendChild(
      opcao('Agora', 'Cria a sala e manda o link na hora.', true, () => {
        fecharAgendador();
        void aoClicar(botao);
      })
    );
    caixa.appendChild(
      opcao('Agendar', 'Escolhe dia e hora. O link vai perto do horário.', false, () => {
        fecharAgendador();
        abrirAgendador(botao);
      })
    );

    document.body.appendChild(caixa);
    prenderFechamento(caixa);
    const primeiro = caixa.querySelector('button');
    if (primeiro) primeiro.focus();
  }

  /** Fecha com Esc ou clique fora — vale pros dois cartões. */
  function prenderFechamento(caixa) {
    const noEsc = (ev) => {
      if (ev.key === 'Escape') fecharAgendador();
    };
    const foraDaCaixa = (ev) => {
      if (!caixa.contains(ev.target) && ev.target.id !== ID) fecharAgendador();
    };
    document.addEventListener('keydown', noEsc, true);
    // No próximo tick: senão o próprio clique que abriu já fecharia.
    setTimeout(() => document.addEventListener('mousedown', foraDaCaixa, true), 0);
    caixa.addEventListener('cpm-fechou', () => {
      document.removeEventListener('keydown', noEsc, true);
      document.removeEventListener('mousedown', foraDaCaixa, true);
    });
  }

  function abrirAgendador(botao) {
    fecharAgendador();
    const escuro = temaEscuro();
    const fundo = escuro ? '#2c333a' : '#ffffff';
    const texto = escuro ? '#E6E5E8' : '#1d2125';
    const suave = escuro ? '#D1D1D5' : '#5b636b';
    const borda = escuro ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)';

    const caixa = document.createElement('div');
    caixa.id = ID_AGENDADOR;
    caixa.setAttribute('role', 'dialog');
    caixa.setAttribute('aria-label', 'Marcar reunião');
    const r = botao.getBoundingClientRect();
    caixa.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      `top:${Math.round(r.bottom + 8)}px`,
      // Ancorado no botão, mas sem escapar da janela nos dois lados.
      `left:${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 296)))}px`,
      'width:280px',
      `background:${fundo}`,
      `color:${texto}`,
      `border:1px solid ${borda}`,
      'border-radius:12px',
      'padding:14px',
      'box-shadow:0 10px 30px rgba(0,0,0,.28)',
      'font:400 14px/1.45 system-ui,sans-serif',
      `color-scheme:${escuro ? 'dark' : 'light'}`,
    ].join(';');

    const titulo = document.createElement('div');
    titulo.textContent = 'Marcar reunião';
    titulo.style.cssText = 'font-weight:700;margin-bottom:2px';

    const dica = document.createElement('div');
    dica.textContent = 'O cliente recebe o link com a data e o horário.';
    dica.style.cssText = `color:${suave};font-size:12px;margin-bottom:10px`;

    const campo = document.createElement('input');
    campo.type = 'datetime-local';
    campo.value = paraInput(horarioSugerido());
    campo.min = paraInput(new Date());
    campo.max = paraInput(new Date(Date.now() + MAX_DIAS * 24 * 60 * 60 * 1000));
    campo.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'padding:8px 10px',
      `border:1px solid ${borda}`,
      'border-radius:8px',
      'background:transparent',
      `color:${texto}`,
      'font:inherit',
    ].join(';');

    const erro = document.createElement('div');
    erro.style.cssText = 'color:#ff6b6b;font-size:12px;margin-top:6px;display:none';

    const linha = document.createElement('div');
    linha.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';

    const cancelar = document.createElement('button');
    cancelar.type = 'button';
    cancelar.textContent = 'Cancelar';
    cancelar.style.cssText = [
      'background:transparent',
      `color:${suave}`,
      'border:0',
      'padding:8px 12px',
      'border-radius:8px',
      'cursor:pointer',
      'font:inherit',
    ].join(';');

    const marcar = document.createElement('button');
    marcar.type = 'button';
    marcar.textContent = 'Marcar';
    marcar.style.cssText = [
      `background:${VERDE}`,
      // Texto escuro sobre o verde: é o que dá contraste de verdade nos dois temas.
      'color:#0b1b10',
      'border:0',
      'padding:8px 14px',
      'border-radius:8px',
      'cursor:pointer',
      'font:600 14px/1 system-ui,sans-serif',
    ].join(';');
    marcar.addEventListener('mouseenter', () => {
      marcar.style.background = VERDE_HOVER;
    });
    marcar.addEventListener('mouseleave', () => {
      marcar.style.background = VERDE;
    });

    linha.append(cancelar, marcar);
    caixa.append(titulo, dica, campo, erro, linha);
    document.body.appendChild(caixa);
    campo.focus();

    const confirmar = () => {
      const escolhido = new Date(campo.value);
      if (!campo.value || Number.isNaN(escolhido.getTime())) {
        erro.textContent = 'Escolha uma data e um horário.';
        erro.style.display = 'block';
        return;
      }
      if (escolhido.getTime() <= Date.now()) {
        erro.textContent = 'Esse horário já passou. Escolha um horário futuro.';
        erro.style.display = 'block';
        return;
      }
      fecharAgendador();
      // ISO com fuso: o servidor recusa data sem fuso justamente pra "14:00"
      // não virar 11 h da manhã pro cliente.
      void aoClicar(botao, escolhido.toISOString());
    };

    marcar.addEventListener('click', confirmar);
    cancelar.addEventListener('click', fecharAgendador);
    campo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') confirmar();
    });
    caixa.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') fecharAgendador();
    });
    // Clique fora fecha. O `capture` pega o evento antes do React do chatPro.
    setTimeout(() => {
      document.addEventListener(
        'mousedown',
        function fora(ev) {
          if (caixa.isConnected && !caixa.contains(ev.target)) {
            fecharAgendador();
            document.removeEventListener('mousedown', fora, true);
          }
          if (!caixa.isConnected) document.removeEventListener('mousedown', fora, true);
        },
        true
      );
    }, 0);
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

  /** `quandoIso` presente = reunião marcada; ausente = reunião agora. */
  async function aoClicar(botao, quandoIso) {
    const sessionId = sessaoAtual();
    if (!sessionId) {
      avisar('Abra uma conversa antes de iniciar a reunião.', 'erro');
      return;
    }

    ocupado(botao, true, quandoIso ? 'Marcando…' : 'Criando reunião…');
    try {
      const resposta = await chrome.runtime.sendMessage({
        tipo: 'INICIAR_REUNIAO',
        sessionId,
        contato: nomeDoContato(),
        quando: quandoIso || null,
      });

      if (!resposta || !resposta.ok) {
        const msg = (resposta && resposta.erro) || 'Não foi possível iniciar a reunião.';
        avisar(msg, 'erro');
        if (resposta && resposta.precisaConectar) {
          avisar('Abra a extensão e conecte sua conta Google.', 'erro');
        }
        return;
      }

      const { meetUrl, gravando, avisoGravacao, quandoTexto } = resposta.dados;

      if (quandoTexto) {
        // Reunião marcada NÃO abre a sala: a hora é outra, e uma aba do Meet
        // aberta agora só atrapalharia o atendimento em andamento.
        avisar(
          gravando
            ? `Reunião marcada para ${quandoTexto}. O cliente já recebeu o link.`
            : `Reunião marcada para ${quandoTexto}, mas ${avisoGravacao || 'a gravação não foi agendada.'}`,
          gravando ? 'ok' : 'erro'
        );
        return;
      }

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
      fecharAgendador();
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
      // O clique abre a escolha: "Agora" ou "Agendar".
      //
      // Antes, clicar criava a reunião na hora e agendar exigia segurar Shift.
      // Ninguém descobre um atalho invisível — e o clique disparava algo
      // irreversível (bot na sala, mensagem pro cliente) sem confirmação. Uma
      // tela intermediária custa um clique e resolve os dois problemas.
      //
      // Shift continua pulando direto pra "agora", pra quem já pegou o ritmo.
      if (ev.shiftKey) void aoClicar(botao);
      else abrirEscolha(botao);
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
      // Trocou de conversa: um agendador aberto marcaria pro cliente errado.
      fecharAgendador();
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
