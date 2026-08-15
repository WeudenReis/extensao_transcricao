/**
 * A aba "Reunião" — o painel do Copiloto, feito do mesmo material.
 *
 * O QUE AS VERSÕES ANTERIORES ERRAVAM: desenhavam tudo com `style=""` inline e
 * cor fixa em `rgb()`. Ficava parecido no tema escuro e QUEBRAVA no claro — as
 * variáveis `--gray-*` do chatPro invertem entre os temas, e um painel com cor
 * literal não acompanha. Isso é bug de produto, não questão de gosto.
 *
 * Agora a aba não tem estilo próprio: ela É um `.copilot`.
 *
 *   section.copilot.copilot--reuniao.active
 *     header.copilot-header       ← 60px, --gray-10, radius 15px 15px 0 0
 *       div                       ← slot da esquerda (mantém o h1 centrado)
 *       h1                        ← 1rem/700
 *       button.button.button--empty.button--inv
 *     article.copilot-article     ← --gray-05, overflow-y auto
 *       section.copilot-list      ← padding var(--padding-sm)
 *
 * Abrir e fechar é `margin-right: -450px → 0` pela classe `.active`, com o
 * `transition: all .2s` que já vem de `.copilot`. Não animamos largura: o
 * Copiloto não anima, e era isso que fazia a nossa parecer outra coisa.
 *
 * Mobile (<820px) sai de graça: a media query deles zera o raio e ocupa 100%.
 *
 * O ÚNICO CSS NOSSO está em `estiloProprio()`, e existe por um motivo só: os
 * cartões da Reunião têm DUAS linhas (título + explicação) e
 * `.copilot-list > article a` corta em uma (`-webkit-line-clamp: 1`).
 */

(() => {
  'use strict';

  const ID = 'cpm-aba-reuniao';
  const ID_ESTILO = 'cpm-estilo-aba';
  /** Igual ao `.copilot`: é o valor do recuo de fechado. */
  const LARGURA = 450;

  // ─── Onde a aba entra ──────────────────────────────────────────────────────

  function acharCopiloto() {
    return document.querySelector('section.copilot:not(#' + ID + ')');
  }

  /** `main.chat` é o flex que divide conversa e painéis. */
  function acharChat() {
    const chat = document.querySelector('main.chat, .chat');
    if (chat) return chat;
    // Sem a classe (layout mudou): o flex-row mais externo com 2+ colunas.
    let melhor = null;
    for (const el of document.querySelectorAll('main, div, section')) {
      if (el.id === ID || el.closest(`#${ID}`)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.6 || r.height < window.innerHeight * 0.6) continue;
      const s = getComputedStyle(el);
      if (s.display !== 'flex' || s.flexDirection !== 'row') continue;
      if ([...el.children].filter((c) => c.getBoundingClientRect().width > 40).length < 2) continue;
      if (!melhor || r.width * r.height > melhor.area) melhor = { el, area: r.width * r.height };
    }
    return melhor ? melhor.el : document.body;
  }

  /** O design system está carregado? Sem ele, `.copilot` não pinta nada. */
  function temDesignSystem() {
    if (document.querySelector('.copilot, .button')) return true;
    // A variável é a prova definitiva — a classe pode não estar na tela agora.
    const v = getComputedStyle(document.documentElement).getPropertyValue('--gray-10');
    return v.trim() !== '';
  }

  // ─── O único CSS nosso ─────────────────────────────────────────────────────

  /**
   * Nada aqui repete o que `.copilot` já faz. São três coisas:
   *
   *  1. desfazer o `-webkit-line-clamp: 1` nos nossos cartões de duas linhas
   *  2. as poucas estruturas que o Copiloto não tem (grade de horários, erro
   *     de campo, nota)
   *  3. um degradê de emergência, em VARIÁVEL, pra quando o design system não
   *     estiver presente — nunca em rgb literal, senão volta o bug do tema
   */
  function estiloProprio() {
    if (document.getElementById(ID_ESTILO)) return;
    const st = document.createElement('style');
    st.id = ID_ESTILO;
    st.textContent = `
/* ── Cartões de ação: mesma linguagem da lista do Copiloto, com 2 linhas ── */
.copilot--reuniao .copilot-list > article > a{
  display:block;-webkit-line-clamp:none;line-clamp:none;
  padding:0 0 10px;border-bottom:1px solid hsl(var(--gray-10));
  color:inherit;cursor:pointer;transition:all .1s;text-decoration:none}
.copilot--reuniao .copilot-list > article > a:last-child{border-bottom:0}
.copilot--reuniao .copilot-list > article > a:hover{opacity:.75}
.copilot--reuniao .copilot-list > article > a > div{
  display:flex;flex-direction:row;justify-content:space-between}
.copilot--reuniao .copilot-list > article > a > div > span{
  font-size:1rem;font-weight:400;color:hsl(var(--gray-80))}
.copilot--reuniao .copilot-list > article > a > span{
  display:block;font-size:.6875rem;color:hsl(var(--gray-50))}
.copilot--reuniao .copilot-list > header h1{
  font-size:1rem;font-weight:700;color:hsl(var(--gray-80))}

/* ── O que o Copiloto não tem ── */
.copilot--reuniao .cpm-erro{
  display:none;font-size:.6875rem;color:hsl(var(--color-red,0 72% 51%))}
.copilot--reuniao .cpm-nota{
  padding:var(--padding-xs);border-radius:var(--radius-md);
  background:hsl(var(--gray-10));font-size:.8125rem;line-height:1.45}
.copilot--reuniao .cpm-caixa{display:flex;align-items:flex-start;gap:.5rem;
  margin:-4px 0 14px;cursor:pointer}
.copilot--reuniao .cpm-caixa input{width:auto;height:auto;margin:2px 0 0;flex:0 0 auto}
.copilot--reuniao .cpm-caixa-rotulo{display:block;font-size:.875rem;
  color:hsl(var(--gray-80))}
.copilot--reuniao .cpm-caixa-ajuda{display:block;font-size:.6875rem;
  color:hsl(var(--gray-50))}
/* Horários no desenho do painel: caixas altas, duas por linha, com o horário
   centralizado. O escolhido é PREENCHIDO de verde vivo (--lime-green-50, o
   mesmo da seleção de dia), não tingido — é o que deixa claro o que está
   valendo antes de confirmar. */
.copilot--reuniao .cpm-horarios{
  display:grid;grid-template-columns:repeat(2,1fr);gap:.625rem}
.copilot--reuniao .cpm-horario{
  min-height:52px;border-radius:var(--radius-md);
  border:1px solid hsl(var(--gray-10));
  background:hsl(var(--gray-00));color:hsl(var(--gray-80));cursor:pointer;
  font-family:inherit;font-size:1rem;font-weight:600;
  display:flex;align-items:center;justify-content:center;
  transition:all .1s}
.copilot--reuniao .cpm-horario:hover{
  border-color:hsl(var(--gray-20));background:hsl(var(--gray-05))}
.copilot--reuniao .cpm-horario--escolhido,
.copilot--reuniao .cpm-horario--escolhido:hover{
  background:hsl(var(--lime-green-50));border-color:hsl(var(--lime-green-50));
  color:hsl(var(--gray-00))}
.copilot--reuniao .cpm-centro{text-align:center;padding:1.5rem .5rem;
  color:hsl(var(--gray-50));font-size:.8125rem}

/* ── Gaveta: só quando não há main.chat pra entrar ── */
#${ID}.cpm-gaveta{position:fixed;top:0;right:0;height:100vh;
  width:min(${LARGURA}px,calc(100vw - 24px));z-index:2147483646;margin:0;
  box-shadow:var(--shadow-md,4px 4px 8px rgba(0,0,0,.1))}
#${ID}.cpm-gaveta:not(.active){transform:translateX(100%)}

/* ── Emergência: sem o design system, ainda em VARIÁVEL (nunca rgb fixo) ── */
#${ID}.cpm-sem-tema{flex:0 1 ${LARGURA}px;display:flex;flex-direction:column;
  overflow:hidden;padding:0 15px;transition:all .2s;margin-right:-${LARGURA}px;
  color:hsl(var(--gray-80,0 0% 85%))}
#${ID}.cpm-sem-tema.active{margin-right:0}
#${ID}.cpm-sem-tema .copilot-header{flex:0 0 60px;border-radius:15px 15px 0 0;
  background:hsl(var(--gray-10,201 37% 17%));display:flex;align-items:center;
  justify-content:space-between;padding:0 var(--padding-xs,.75rem)}
#${ID}.cpm-sem-tema .copilot-article{flex:1;overflow-y:auto;display:flex;
  flex-direction:column;background:hsl(var(--gray-05,201 37% 12%))}
#${ID}.cpm-sem-tema .copilot-footer{flex:0 0 60px;display:flex;
  flex-direction:column;justify-content:center;
  background:hsl(var(--gray-10,201 37% 17%))}
`;
    document.head.appendChild(st);
  }

  // ─── Peças, com as classes deles ───────────────────────────────────────────

  function el(tag, classe, texto) {
    const n = document.createElement(tag);
    if (classe) n.className = classe;
    if (texto !== undefined) n.textContent = texto;
    return n;
  }

  /** `.button` traz altura 42px, raio 6px, cor da marca e o hover — tudo deles. */
  function botao(rotulo, tipo) {
    const b = el('button', tipo === 'primario' ? 'button button--full' : 'button button--empty');
    b.type = 'button';
    b.textContent = rotulo;
    return b;
  }

  /**
   * `.input` é o wrapper (coluna + gap) e o `input` cru já vem estilizado pelo
   * seletor global deles — 42px, raio 6px, borda --gray-10, foco verde.
   */
  function campo(rotulo, opcoes) {
    const wrap = el('label', 'input');
    wrap.appendChild(el('span', '', rotulo));
    const entrada = el(opcoes && opcoes.select ? 'select' : 'input', '');
    if (opcoes && opcoes.placeholder) entrada.placeholder = opcoes.placeholder;
    if (opcoes && opcoes.tipo) entrada.type = opcoes.tipo;
    const erro = el('span', 'cpm-erro');
    wrap.append(entrada, erro);
    return { wrap, entrada, erro };
  }

  // ─── A aba ─────────────────────────────────────────────────────────────────

  let aberto = null;

  function fechar() {
    if (!aberto) return;
    const { raiz, aoTeclar, observer, copilotoQueEstavaAberto } = aberto;
    document.removeEventListener('keydown', aoTeclar, true);
    if (observer) observer.disconnect();
    aberto = null;

    // Devolve o Copiloto ao estado em que estava: fechá-lo pra abrir a nossa
    // aba é aceitável, deixá-lo fechado depois seria mexer no que não é nosso.
    if (copilotoQueEstavaAberto && copilotoQueEstavaAberto.isConnected) {
      copilotoQueEstavaAberto.classList.add('active');
    }

    // Sai recolhendo pelo margin, como o Copiloto. Remover na hora daria um
    // pulo de 450 px na conversa.
    raiz.classList.remove('active');
    const remover = () => {
      raiz.remove();
      document.dispatchEvent(new CustomEvent('cpm-aba-fechou'));
    };
    raiz.addEventListener('transitionend', remover, { once: true });
    // Sem transição (prefers-reduced-motion, aba de fundo) o transitionend
    // nunca vem e o nó ficaria pra sempre.
    setTimeout(remover, 400);
  }

  function estaAberta() {
    return aberto !== null;
  }

  function abrir(render) {
    fechar();
    estiloProprio();

    const chat = acharChat();
    const naGaveta = chat === document.body;
    const semTema = !temDesignSystem();

    // As duas colunas disputam os mesmos 450px do `main.chat`. Abrir as duas
    // espreme a conversa a quase nada — então a Reunião fecha o Copiloto e o
    // devolve ao sair.
    const copiloto = acharCopiloto();
    const copilotoEstavaAberto = Boolean(copiloto && copiloto.classList.contains('active'));
    if (copilotoEstavaAberto) copiloto.classList.remove('active');

    const raiz = el('section', 'copilot copilot--reuniao');
    raiz.id = ID;
    raiz.setAttribute('role', 'complementary');
    raiz.setAttribute('aria-label', 'Reunião');
    if (naGaveta) raiz.classList.add('cpm-gaveta');
    if (semTema) raiz.classList.add('cpm-sem-tema');

    // Cabeçalho: div vazia à esquerda mantém o h1 centrado pelo
    // space-between, sem visibility:hidden inline.
    const cabecalho = el('header', 'copilot-header');
    const esquerda = el('div', '');
    const voltar = el('button', 'button button--empty button--inv');
    voltar.type = 'button';
    voltar.textContent = '‹';
    voltar.setAttribute('aria-label', 'Voltar');
    voltar.hidden = true;
    esquerda.appendChild(voltar);

    const titulo = el('h1', '', 'Reunião');

    const fecharBtn = el('button', 'button button--empty button--inv');
    fecharBtn.type = 'button';
    fecharBtn.textContent = '✕';
    fecharBtn.setAttribute('aria-label', 'Fechar');
    fecharBtn.addEventListener('click', fechar);
    cabecalho.append(esquerda, titulo, fecharBtn);

    const artigo = el('article', 'copilot-article');
    const lista = el('section', 'copilot-list');
    artigo.appendChild(lista);

    const rodape = el('footer', 'copilot-footer');
    rodape.hidden = true;

    raiz.append(cabecalho, artigo, rodape);
    chat.appendChild(raiz);

    // `.active` é o que traz o margin-right a zero. No quadro seguinte, senão
    // o navegador pula a transição.
    const ativar = () => raiz.classList.add('active');
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.requestAnimationFrame(ativar));
    }
    // requestAnimationFrame não dispara em aba de fundo.
    window.setTimeout(ativar, 120);

    const aoTeclar = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        fechar();
      }
    };
    document.addEventListener('keydown', aoTeclar, true);

    // O `main.chat` é do React, que remove nós que não conhece ao re-renderizar.
    let observer = null;
    if (!naGaveta) {
      observer = new MutationObserver(() => {
        if (aberto && !raiz.isConnected) {
          chat.appendChild(raiz);
          raiz.classList.add('active');
        }
      });
      observer.observe(chat, { childList: true });
    }

    aberto = {
      raiz,
      corpo: lista,
      rodape,
      aoTeclar,
      observer,
      copilotoQueEstavaAberto: copilotoEstavaAberto ? copiloto : null,
    };
    console.log(
      `%c[chatPro reunião]%c aba aberta como .copilot` +
        (naGaveta ? ' (gaveta — não achei main.chat)' : '') +
        (semTema ? ' SEM o design system do chatPro' : ''),
      'color:#25D066;font-weight:700',
      ''
    );

    const api = {
      corpo: lista,
      rodape,
      fechar,
      modo: naGaveta ? 'sobrepoe' : 'empurra',
      /** Compatibilidade com o fluxo: tudo em token, nada literal. */
      p: {
        texto: 'hsl(var(--gray-80))',
        textoFraco: 'hsl(var(--gray-50))',
        perigo: 'hsl(var(--color-red,0 72% 51%))',
        fundoFraco: 'hsl(var(--gray-10))',
        verde: 'hsl(var(--cool-green-70))',
        blocoRaio: 'var(--radius-md)',
      },
      cabecalho(texto, aoVoltar) {
        titulo.textContent = texto;
        voltar.hidden = !aoVoltar;
        voltar.onclick = aoVoltar || null;
      },
      limpar() {
        lista.replaceChildren();
        rodape.replaceChildren();
        rodape.hidden = true;
      },
      acao(rotulo, aoClicar) {
        const b = botao(rotulo, 'primario');
        b.addEventListener('click', aoClicar);
        rodape.replaceChildren(b);
        rodape.hidden = false;
        return b;
      },
      campo,
      /**
       * Caixa de seleção com explicação embaixo — o "Não enviar email" da tela
       * do painel. Fica fora de `campo()` porque um checkbox não tem rótulo em
       * cima nem borda; espremê-lo naquele molde deixaria torto.
       */
      caixa(rotulo, ajuda) {
        const wrap = el('label', 'cpm-caixa');
        const entrada = document.createElement('input');
        entrada.type = 'checkbox';
        const textos = el('span', '');
        textos.appendChild(el('span', 'cpm-caixa-rotulo', rotulo));
        if (ajuda) textos.appendChild(el('span', 'cpm-caixa-ajuda', ajuda));
        wrap.append(entrada, textos);
        return { wrap, entrada };
      },
      botao,
      el(tag, estilo, texto) {
        const n = document.createElement(tag);
        // Compatibilidade com o fluxo, que ainda passa CSS em alguns pontos.
        // Cor nova aqui tem que vir de var(--…), nunca de rgb.
        if (estilo) n.style.cssText = estilo;
        if (texto !== undefined) n.textContent = texto;
        return n;
      },
      /**
       * Cabeçalho de seção, igual ao "Chats anteriores" do Copiloto.
       * Devolve o <article> onde os cartões entram.
       */
      secao(rotulo) {
        const cab = el('header', '');
        cab.appendChild(el('h1', '', rotulo));
        const art = el('article', '');
        lista.append(cab, art);
        return art;
      },
      /** Cartão de duas linhas — o único componente que o Copiloto não tem. */
      cartao(destino, titulo2, ajuda, aoClicar) {
        const a = el('a', '');
        a.href = '#';
        const linha = el('div', '');
        linha.appendChild(el('span', '', titulo2));
        a.appendChild(linha);
        if (ajuda) a.appendChild(el('span', '', ajuda));
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          aoClicar();
        });
        destino.appendChild(a);
        return a;
      },
      aviso(texto, tom) {
        const n = el('div', 'cpm-nota', texto);
        if (tom === 'erro') n.style.color = 'hsl(var(--color-red,0 72% 51%))';
        lista.prepend(n);
        return n;
      },
      carregando(texto) {
        api.limpar();
        lista.appendChild(el('div', 'cpm-centro', texto));
      },
    };

    render(api);
    return api;
  }

  window.__cpmAba = {
    abrir,
    fechar,
    estaAberta,
    // Mantidos pra não quebrar quem chama; a medição não existe mais — o
    // estilo vem das classes do chatPro, que é o certo.
    decidirDestino: () => ({ modo: acharChat() === document.body ? 'sobrepoe' : 'empurra' }),
    medirSePuder: () => false,
  };
})();
